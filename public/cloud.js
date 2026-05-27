const TensionCloud = {
  async request(path, options = {}) {
    const response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    const payload = await response.json().catch(() => ({ error: 'cloud sync unavailable' }));
    if (!response.ok) throw new Error(payload.error || 'cloud request failed');
    return payload;
  },

  session() {
    return this.request('/auth/session');
  },

  register(email, password) {
    return this.request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
  },

  signIn(email, password) {
    return this.request('/auth/sign-in', { method: 'POST', body: JSON.stringify({ email, password }) });
  },

  signOut() {
    return this.request('/auth/sign-out', { method: 'POST' });
  },

  readState() {
    return this.request('/state');
  },

  saveState(value) {
    return this.request('/state', { method: 'PUT', body: JSON.stringify(value) });
  }
};
