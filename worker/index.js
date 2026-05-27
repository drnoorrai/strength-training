const COOKIE_NAME = 'tension_session';
const SESSION_DAYS = 30;
const AUTH_LIMIT = 12;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const PBKDF2_ITERATIONS = 100000;
const PRIVATE_PATHS = ['/worker/', '/wrangler.jsonc', '/.git'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await routeApi(request, env, ctx, url.pathname);
      if (PRIVATE_PATHS.some((path) => url.pathname.startsWith(path))) return new Response('not found', { status: 404 });
      return await env.ASSETS.fetch(request);
    } catch (error) {
      if (error.status) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ event: 'request_failed', path: url.pathname, message: error.message }));
      return json({ error: 'request failed' }, 500);
    }
  }
};

async function routeApi(request, env, ctx, path) {
  if (request.method === 'GET' && path === '/api/auth/session') {
    const user = await currentUser(request, env);
    return json({ user });
  }

  if (request.method === 'POST' && path === '/api/auth/register') {
    assertWriteOrigin(request);
    await assertAuthLimit(request, env, ctx);
    const { email, password } = await readCredentials(request);
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) return json({ error: 'an account already exists for this email' }, 409);
    const salt = randomToken(16);
    const stamp = new Date().toISOString();
    const user = { id: crypto.randomUUID(), email };
    const passwordHash = await passwordDigest(password, salt);
    await env.DB.prepare('INSERT INTO users (id, email, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(user.id, email, salt, passwordHash, stamp, stamp).run();
    return withSession(json({ user }, 201), await createSession(user.id, env));
  }

  if (request.method === 'POST' && path === '/api/auth/sign-in') {
    assertWriteOrigin(request);
    await assertAuthLimit(request, env, ctx);
    const { email, password } = await readCredentials(request);
    const record = await env.DB.prepare('SELECT id, email, password_salt, password_hash FROM users WHERE email = ?').bind(email).first();
    if (!record || !(await safeEqual(await passwordDigest(password, record.password_salt), record.password_hash))) {
      return json({ error: 'email or password not recognised' }, 401);
    }
    return withSession(json({ user: { id: record.id, email: record.email } }), await createSession(record.id, env));
  }

  if (request.method === 'POST' && path === '/api/auth/sign-out') {
    assertWriteOrigin(request);
    const token = readCookie(request, COOKIE_NAME);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sessionDigest(token, env)).run();
    return withExpiredSession(json({ ok: true }));
  }

  if (request.method === 'GET' && path === '/api/state') {
    const user = await requireUser(request, env);
    const record = await env.DB.prepare('SELECT state_json, updated_at FROM user_states WHERE user_id = ?').bind(user.id).first();
    return json({ state: record ? JSON.parse(record.state_json) : null, updated_at: record?.updated_at || null });
  }

  if (request.method === 'PUT' && path === '/api/state') {
    assertWriteOrigin(request);
    const user = await requireUser(request, env);
    const state = await readState(request);
    const stamp = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO user_states (user_id, state_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
      .bind(user.id, JSON.stringify(state), stamp, stamp).run();
    return json({ ok: true, updated_at: stamp });
  }

  return json({ error: 'not found' }, 404);
}

async function readCredentials(request) {
  const body = await readJson(request, 4096);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw httpError('enter a valid email address', 400);
  if (password.length < 10 || password.length > 200) throw httpError('password must be 10 to 200 characters', 400);
  return { email, password };
}

async function readState(request) {
  const value = await readJson(request, 1024 * 1024);
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.created_at !== 'string' ||
      typeof value.updated_at !== 'string' || !Array.isArray(value.sets) || !Array.isArray(value.custom_exercises)) {
    throw httpError('invalid state object', 400);
  }
  return value;
}

async function readJson(request, maximumBytes) {
  const statedLength = Number(request.headers.get('content-length') || 0);
  if (statedLength > maximumBytes) throw httpError('request too large', 413);
  const text = await request.text();
  if (text.length > maximumBytes) throw httpError('request too large', 413);
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw httpError('invalid JSON', 400);
  }
}

async function currentUser(request, env) {
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return null;
  const record = await env.DB.prepare(`SELECT users.id, users.email
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
    .bind(await sessionDigest(token, env), new Date().toISOString()).first();
  return record ? { id: record.id, email: record.email } : null;
}

async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw httpError('sign in required', 401);
  return user;
}

async function createSession(userId, env) {
  const token = randomToken(32);
  const stamp = new Date();
  const expiry = new Date(stamp.getTime() + SESSION_DAYS * 86400000);
  await env.DB.prepare('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), userId, await sessionDigest(token, env), stamp.toISOString(), expiry.toISOString()).run();
  return { token, expiry };
}

async function assertAuthLimit(request, env, ctx) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = Math.floor(Date.now() / AUTH_WINDOW_MS);
  const key = await sessionDigest(`${ip}:${bucket}`, env);
  const expiry = (bucket + 1) * AUTH_WINDOW_MS;
  const result = await env.DB.prepare(`INSERT INTO auth_limits (key, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1, expires_at = excluded.expires_at
    RETURNING attempts`).bind(key, expiry).first();
  ctx.waitUntil(env.DB.prepare('DELETE FROM auth_limits WHERE expires_at < ?').bind(Date.now()).run());
  if (result.attempts > AUTH_LIMIT) throw httpError('too many sign-in attempts; try again later', 429);
}

function assertWriteOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) throw httpError('origin not permitted', 403);
}

async function passwordDigest(password, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const digest = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: decodeBase64Url(salt),
    iterations: PBKDF2_ITERATIONS,
    hash: 'SHA-256'
  }, material, 256);
  return encodeBase64Url(new Uint8Array(digest));
}

async function sessionDigest(token, env) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token));
  return encodeBase64Url(new Uint8Array(digest));
}

async function safeEqual(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function randomToken(bytes) {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function encodeBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function readCookie(request, name) {
  const match = request.headers.get('Cookie')?.split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}

function withSession(response, session) {
  response.headers.append('Set-Cookie', `${COOKIE_NAME}=${session.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Expires=${session.expiry.toUTCString()}`);
  return response;
}

function withExpiredSession(response) {
  response.headers.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  return response;
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
