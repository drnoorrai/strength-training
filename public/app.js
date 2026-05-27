// ============ STATE ============
const STORAGE_KEY = 'tension.v1.state';
const GROUP_ORDER = ['push', 'pull', 'legs', 'core'];
const PHASES = ['bulk', 'maintain', 'cut', 'deload'];
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let state;
let ui = { view: 'dashboard', detailMuscle: null, sort: 'group', tooltip: null, expandedLessons: new Set() };
let cloud = { available: true, checking: true, user: null, syncing: false, pending: false, lastSync: null };
let toastTimer;
let cloudTimer;

function now() {
  return new Date().toISOString();
}

function uid() {
  return crypto.randomUUID();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function createState() {
  const stamp = now();
  return {
    id: uid(),
    created_at: stamp,
    updated_at: stamp,
    phase: 'maintain',
    sets: [],
    custom_exercises: [],
    targets: {},
    enabled_optional: Object.fromEntries(MUSCLES.filter((m) => m.optional).map((m) => [m.id, false])),
    user_term_exposure: {},
    lessons: { active: [], archive: [], last_shown: {} }
  };
}

// ============ STORAGE ============
function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!parsed || !Array.isArray(parsed.sets) || !parsed.lessons) return createState();
    return { ...createState(), ...parsed, lessons: { active: [], archive: [], last_shown: {}, ...parsed.lessons } };
  } catch (_error) {
    return createState();
  }
}

function persist(touch = true) {
  if (touch) state.updated_at = now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (cloud.user && touch) scheduleCloudSave();
}

function isValidImport(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.id !== 'string' || typeof value.created_at !== 'string') return false;
  if (!PHASES.includes(value.phase) || !Array.isArray(value.sets) || !Array.isArray(value.custom_exercises)) return false;
  return value.sets.every((set) => typeof set.id === 'string' && typeof set.created_at === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(set.date) && typeof set.exercise_id === 'string' &&
    Number.isInteger(set.rir) && set.rir >= 0 && set.rir <= 10);
}

// ============ VOLUME CALCULATIONS ============
function dateKey(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function mondayOf(value = new Date()) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  const weekday = date.getDay() || 7;
  date.setDate(date.getDate() - weekday + 1);
  return date;
}

function weekBounds(date = new Date()) {
  const start = mondayOf(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start: dateKey(start), end: dateKey(end) };
}

function weekLabel() {
  return mondayOf().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function allExercises() {
  return [...EXERCISES, ...state.custom_exercises];
}

function exerciseById(id) {
  return allExercises().find((exercise) => exercise.id === id);
}

function visibleMuscles() {
  return MUSCLES.filter((muscle) => !muscle.optional || state.enabled_optional[muscle.id]);
}

function baseTarget(muscle) {
  const personal = state.targets[muscle.id];
  return personal ? { mev: personal.mev, mav: [...personal.mav], mrv: personal.mrv } :
    { mev: muscle.mev, mav: [...muscle.mav], mrv: muscle.mrv };
}

function displayedTarget(muscle) {
  const target = baseTarget(muscle);
  if (state.phase === 'cut') return { ...target, mrv: target.mrv * 0.85 };
  if (state.phase === 'deload') {
    return { mev: target.mev * 0.5, mav: target.mav.map((number) => number * 0.5), mrv: target.mrv * 0.5 };
  }
  return target;
}

function targetsById() {
  return Object.fromEntries(MUSCLES.map((muscle) => [muscle.id, displayedTarget(muscle)]));
}

function setsInWeek(offset = 0) {
  const targetWeek = new Date();
  targetWeek.setDate(targetWeek.getDate() - offset * 7);
  const bounds = weekBounds(targetWeek);
  return state.sets.filter((set) => set.date >= bounds.start && set.date < bounds.end);
}

function volumeForSets(sets) {
  const totals = Object.fromEntries(MUSCLES.map((muscle) => [muscle.id, 0]));
  sets.filter((set) => set.rir <= 4).forEach((set) => {
    const exercise = exerciseById(set.exercise_id);
    if (!exercise) return;
    Object.entries(exercise.contributions).forEach(([muscle, contribution]) => {
      totals[muscle] = (totals[muscle] || 0) + Number(contribution);
    });
  });
  return totals;
}

function currentVolumes() {
  return volumeForSets(setsInWeek());
}

function sessionCountForMuscle(muscleId, sets = setsInWeek()) {
  return new Set(sets.filter((set) => set.rir <= 4 && (exerciseById(set.exercise_id)?.contributions[muscleId] || 0) > 0).map((set) => set.date)).size;
}

function formatSets(number) {
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0$/, '');
}

function relatedSets(muscleId) {
  return setsInWeek().filter((set) => exerciseById(set.exercise_id)?.contributions[muscleId]);
}

// ============ LESSON ENGINE ============
function glossary(id) {
  return GLOSSARY.find((entry) => entry.id === id);
}

function substitute(text, context) {
  return text.replace(/\{(\w+)\}/g, (_match, key) => context[key] ?? '');
}

function cooldownClear(lesson) {
  const last = state.lessons.last_shown[lesson.id];
  return !last || Date.now() - new Date(last).getTime() >= lesson.cooldown_days * 86400000;
}

function activateLesson(id, context = {}) {
  const lesson = LESSONS.find((item) => item.id === id);
  if (!lesson || !cooldownClear(lesson) || state.lessons.active.some((item) => item.lesson_id === id)) return;
  const stamp = now();
  state.lessons.active.push({
    id: uid(),
    created_at: stamp,
    updated_at: stamp,
    lesson_id: id,
    title: substitute(lesson.title, context),
    body: substitute(lesson.body, context),
    related_terms: lesson.related_terms
  });
  state.lessons.last_shown[id] = stamp;
}

function runLessons(loggedSet) {
  if (state.sets.length === 1) activateLesson('tension_principle');
  if (loggedSet.rir >= 5) activateLesson('rir_too_high');
  const exercise = exerciseById(loggedSet.exercise_id);
  const totals = currentVolumes();
  Object.keys(exercise?.contributions || {}).forEach((id) => {
    const muscle = MUSCLES.find((item) => item.id === id);
    const target = displayedTarget(muscle);
    const current = totals[id];
    if (target.mev > 0 && current > 0 && current < target.mev) {
      activateLesson('muscle_below_mev', { muscle: muscle.name.toLowerCase(), mev: formatSets(target.mev), current: formatSets(current), deficit: formatSets(target.mev - current) });
    }
    if (current > target.mrv) activateLesson('muscle_above_mrv', { muscle: muscle.name.toLowerCase() });
    if (current > 12 && sessionCountForMuscle(id) === 1) activateLesson('frequency_too_low', { muscle: muscle.name.toLowerCase() });
  });
  const sustained = visibleMuscles().some((muscle) => {
    const floor = displayedTarget(muscle).mav[0];
    return floor > 0 && [0, 1, 2, 3].every((week) => volumeForSets(setsInWeek(week))[muscle.id] >= floor);
  });
  if (sustained) activateLesson('deload_due');
}

function termMarkup(id, text) {
  const exposure = state.user_term_exposure[id];
  const mastered = exposure?.exposure_count >= 3 ? ' mastered' : '';
  return `<span class="term${mastered}" tabindex="0" role="button" data-term="${id}">${text || glossary(id)?.term || id}</span>`;
}

function exposeTerm(id) {
  const stamp = now();
  const record = state.user_term_exposure[id] || { first_seen: stamp, exposure_count: 0, mastered: false };
  record.exposure_count += 1;
  record.mastered = record.exposure_count >= 3;
  record.updated_at = stamp;
  state.user_term_exposure[id] = record;
  persist();
}

// ============ RENDERING ============
function render() {
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === ui.view));
  renderAccountButton();
  if (ui.view === 'settings') renderSettings();
  else if (ui.detailMuscle) renderDetail(ui.detailMuscle);
  else renderDashboard();
  renderTooltip();
}

function renderAccountButton() {
  const button = $('#account-button');
  if (!button) return;
  if (cloud.checking) button.textContent = 'checking';
  else if (cloud.user) button.textContent = 'account';
  else button.textContent = cloud.available ? 'sign in' : 'local only';
}

function phaseNote() {
  if (state.phase === 'cut') return `${termMarkup('mrv', 'MRV')} shown at 85% during a cut`;
  if (state.phase === 'deload') return `${termMarkup('deload', 'deload')} week: targets shown at 50%`;
  return '';
}

function renderDashboard() {
  const volumes = currentVolumes();
  const muscles = visibleMuscles();
  const sorted = ui.sort === 'filled'
    ? [...muscles].sort((a, b) => (volumes[b.id] / (displayedTarget(b).mav[0] || 1)) - (volumes[a.id] / (displayedTarget(a).mav[0] || 1)))
    : muscles;
  $('#app').innerHTML = `
    <section class="dashboard-heading">
      <div>
        <h1><em>Hard</em> sets this week</h1>
        <p class="week-label">Week of ${weekLabel()}</p>
      </div>
      <label class="phase-control">
        <span class="eyebrow">phase</span>
        <select id="phase-select" aria-label="Training phase">
          ${PHASES.map((phase) => `<option value="${phase}" ${state.phase === phase ? 'selected' : ''}>${phase}</option>`).join('')}
        </select>
      </label>
    </section>
    ${phaseNote() ? `<p class="phase-message">${phaseNote()}</p>` : ''}
    <section class="lesson-stack" aria-label="Active lessons">${renderLessons()}</section>
    <section class="diagram-panel">
      <span class="eyebrow">hard-set heatmap</span>
      ${renderBodyDiagram(volumes, targetsById())}
    </section>
    <section>
      <div class="volume-header">
        <h2><em>Volume</em> by muscle</h2>
        <div class="sort-control" aria-label="Sort muscles">
          <button data-action="sort" data-sort="group" class="${ui.sort === 'group' ? 'active' : ''}">group</button>
          <button data-action="sort" data-sort="filled" class="${ui.sort === 'filled' ? 'active' : ''}">% filled</button>
        </div>
      </div>
      ${renderRows(sorted, volumes)}
    </section>`;
}

function renderLessons() {
  const cards = state.lessons.active.slice(0, 2);
  return cards.map((card) => {
    const open = ui.expandedLessons.has(card.id);
    const related = card.related_terms.map((term) => termMarkup(term)).join(' · ');
    return `<article class="lesson-card${open ? ' open' : ''}" data-lesson="${card.id}">
      <span class="eyebrow">context</span>
      <button class="lesson-dismiss" data-action="dismiss-lesson" data-id="${card.id}" aria-label="Dismiss lesson">&times;</button>
      <h3>${card.title}</h3>
      <p>${linkTerms(card.body)}</p>
      <button class="why-button" data-action="why" data-id="${card.id}">${open ? 'close' : 'why?'}</button>
      <div class="lesson-mechanism"><p>related reading: ${related}. open a term for the underlying mechanism.</p></div>
    </article>`;
  }).join('');
}

function linkTerms(text) {
  return text
    .replace(/\bMRV\b/g, termMarkup('mrv', 'MRV'))
    .replace(/\bMEV\b/g, termMarkup('mev', 'MEV'))
    .replace(/\bRIR\b/g, termMarkup('rir', 'RIR'))
    .replace(/mechanical tension/g, termMarkup('mechanical_tension', 'mechanical tension'))
    .replace(/hard sets/g, termMarkup('hard_set', 'hard sets'))
    .replace(/\bdeload\b/g, termMarkup('deload', 'deload'))
    .replace(/\bmesocycles\b/g, termMarkup('mesocycle', 'mesocycles'));
}

function renderRows(muscles, volumes) {
  let previousGroup = '';
  return muscles.map((muscle) => {
    const target = displayedTarget(muscle);
    const ratio = Math.min((volumes[muscle.id] / (target.mav[0] || target.mrv || 1)) * 100, 100);
    const group = ui.sort === 'group' && previousGroup !== muscle.group ? `<span class="eyebrow group-label">${muscle.group}</span>` : '';
    previousGroup = muscle.group;
    return `${group}<button class="volume-row" data-action="detail" data-muscle="${muscle.id}">
      <span class="muscle-name">${muscle.name}</span>
      <span class="sets-count">${formatSets(volumes[muscle.id])} / ${formatSets(target.mav[0])}–${formatSets(target.mav[1])} ${termMarkup('mav', 'MAV')}</span>
      <span class="progress-track"><span class="progress-bar ${volumes[muscle.id] > target.mrv ? 'warning' : ''}" style="transform:scaleX(${ratio / 100})"></span></span>
    </button>`;
  }).join('');
}

function renderDetail(muscleId) {
  const muscle = MUSCLES.find((item) => item.id === muscleId);
  const target = displayedTarget(muscle);
  const volume = currentVolumes()[muscleId];
  const maximum = Math.max(target.mrv * 1.15, volume, 1);
  const pct = (number) => Math.min(number / maximum * 100, 100);
  const sets = relatedSets(muscleId);
  $('#app').innerHTML = `
    <button class="back-button" data-action="back">&larr; current week</button>
    <header class="detail-header">
      <span class="eyebrow">${muscle.group}</span>
      <h1>${muscle.name}</h1>
      <p class="detail-subtitle">${muscle.recovery} recovery · usually ${muscle.freq[0]}–${muscle.freq[1]} sessions each week</p>
    </header>
    <section class="threshold-chart">
      <span class="eyebrow">current volume</span>
      <div class="chart-rail">
        <span class="chart-fill ${volume > target.mrv ? 'warning' : ''}" style="width:${pct(volume)}%"></span>
        <span class="chart-marker" style="left:${pct(target.mev)}%"><span>${termMarkup('mev', 'MEV')} ${formatSets(target.mev)}</span></span>
        <span class="chart-marker" style="left:${pct(target.mav[0])}%"><span>${termMarkup('mav', 'MAV')} ${formatSets(target.mav[0])}</span></span>
        <span class="chart-marker" style="left:${pct(target.mrv)}%"><span>${termMarkup('mrv', 'MRV')} ${formatSets(target.mrv)}</span></span>
      </div>
      <div class="detail-metrics">
        <div><span class="metric-number">${formatSets(volume)}</span><span class="metric-label">hard sets</span></div>
        <div><span class="metric-number">${sessionCountForMuscle(muscleId)}x</span><span class="metric-label">trained</span></div>
      </div>
    </section>
    <section class="trend-panel">
      <span class="eyebrow">last 8 weeks</span>
      ${renderTrend(muscleId, target.mav[0])}
    </section>
    <section class="sets-panel">
      <h2><em>Sets</em> this week</h2>
      ${sets.length ? sets.map((set) => renderSetRow(set, muscleId)).join('') : '<p class="empty">no sets logged this week</p>'}
    </section>`;
}

function renderTrend(muscleId, mavLow) {
  const points = Array.from({ length: 8 }, (_value, index) => volumeForSets(setsInWeek(7 - index))[muscleId]);
  const max = Math.max(mavLow, ...points, 1);
  const coords = points.map((number, index) => `${20 + index * 88},${84 - number / max * 61}`).join(' ');
  return `<svg class="trend-chart" viewBox="0 0 660 110" role="img" aria-label="Eight week volume trend">
    <path d="M20 84 H640" stroke="#26302b" fill="none"/>
    <path d="M20 ${84 - mavLow / max * 61} H640" stroke="#4a6b3f" stroke-dasharray="3 5" fill="none"/>
    <polyline points="${coords}" stroke="#7fb069" stroke-width="2" fill="none"/>
    ${points.map((number, index) => `<circle cx="${20 + index * 88}" cy="${84 - number / max * 61}" r="3" fill="#7fb069"/><text x="${20 + index * 88}" y="102" text-anchor="middle">w${index + 1}</text>`).join('')}
  </svg>`;
}

function renderSetRow(set, muscleId) {
  const exercise = exerciseById(set.exercise_id);
  const value = exercise.contributions[muscleId];
  const junk = set.rir >= 5;
  return `<div class="set-row">
    <p>${escapeHtml(exercise.name)}<small>${set.reps ? `${set.reps} reps${set.weight ? ` · ${set.weight} kg` : ''} · ` : ''}${termMarkup('rir', 'RIR')} ${set.rir}${junk ? ` · <span class="junk-tag">${termMarkup('junk_volume', 'junk volume')}</span>` : ''}</small></p>
    <span class="set-value">${junk ? '0' : formatSets(value)}</span>
  </div>`;
}

function renderSettings() {
  const optional = MUSCLES.filter((muscle) => muscle.optional);
  $('#app').innerHTML = `
    <h1 class="settings-title"><em>Settings</em></h1>
    <p class="settings-intro">personal thresholds change the display, not the seeded reference values.</p>
    <p class="account-status">${renderSyncStatus()}</p>
    <section class="settings-section">
      <h2>Targets</h2>
      <div class="target-head"><span>muscle</span><span>${termMarkup('mev', 'MEV')}</span><span>${termMarkup('mav', 'MAV')} low</span><span>${termMarkup('mav', 'MAV')} high</span><span>${termMarkup('mrv', 'MRV')}</span></div>
      ${visibleMuscles().map(renderTargetEditor).join('')}
      <div class="settings-actions"><button class="secondary-button" data-action="reset-targets">reset defaults</button></div>
    </section>
    <section class="settings-section">
      <h2>Optional muscles</h2>
      <div class="toggle-list">${optional.map((muscle) => `<label class="toggle"><input type="checkbox" data-optional="${muscle.id}" ${state.enabled_optional[muscle.id] ? 'checked' : ''}>${muscle.name}</label>`).join('')}</div>
    </section>
    <section class="settings-section">
      <h2>Custom exercises</h2>
      ${state.custom_exercises.map((exercise) => `<div class="custom-exercise"><span>${escapeHtml(exercise.name)}</span><button class="text-button" data-action="delete-exercise" data-id="${exercise.id}">remove</button></div>`).join('') || '<p class="empty">no custom exercises</p>'}
      <button class="secondary-button" data-action="custom-exercise">add exercise</button>
    </section>
    <section class="settings-section">
      <h2>Data</h2>
      <div class="settings-actions">
        <button class="secondary-button" data-action="export">export JSON</button>
        <label class="secondary-button">import JSON<input id="import-state" type="file" accept="application/json" hidden></label>
        <button class="danger-button" data-action="reset">reset all data</button>
      </div>
    </section>
    <section class="settings-section">
      <h2>Lessons seen</h2>
      ${state.lessons.archive.map((item) => `<div class="archive-entry"><strong>${item.title}</strong>${new Date(item.created_at).toLocaleDateString('en-GB')}</div>`).join('') || '<p class="empty">dismissed lessons appear here</p>'}
    </section>`;
}

function renderSyncStatus() {
  if (cloud.checking) return 'checking cloud sync availability';
  if (!cloud.available) return 'stored on this browser only';
  if (!cloud.user) return 'stored on this browser only · sign in for cross-device sync';
  if (cloud.syncing) return `<span class="sync-label">syncing</span> · ${escapeHtml(cloud.user.email)}`;
  return `<span class="sync-label">cloud synced</span> · ${escapeHtml(cloud.user.email)}`;
}

function renderTargetEditor(muscle) {
  const target = baseTarget(muscle);
  return `<label class="target-row"><span>${muscle.name}</span>
    <input data-target="${muscle.id}" data-field="mev" type="number" min="0" step=".5" value="${target.mev}" aria-label="${muscle.name} MEV">
    <input data-target="${muscle.id}" data-field="mavLow" type="number" min="0" step=".5" value="${target.mav[0]}" aria-label="${muscle.name} MAV low">
    <input data-target="${muscle.id}" data-field="mavHigh" type="number" min="0" step=".5" value="${target.mav[1]}" aria-label="${muscle.name} MAV high">
    <input data-target="${muscle.id}" data-field="mrv" type="number" min="0" step=".5" value="${target.mrv}" aria-label="${muscle.name} MRV">
  </label>`;
}

function renderTooltip() {
  $('.tooltip')?.remove();
  if (!ui.tooltip) return;
  const entry = glossary(ui.tooltip);
  const node = document.createElement('aside');
  node.className = 'tooltip';
  node.innerHTML = `<strong>${entry.term} · ${entry.short}</strong><p>${entry.long}</p><button class="text-button" data-action="learn-more" data-term="${entry.id}">learn more &rarr;</button>`;
  document.body.append(node);
}

function openSheet(contents) {
  $('#overlay-root').innerHTML = `<div class="sheet-backdrop"><section class="bottom-sheet" role="dialog" aria-modal="true">${contents}</section></div>`;
  requestAnimationFrame(() => $('.sheet-backdrop').classList.add('visible'));
}

function closeSheet() {
  const overlay = $('.sheet-backdrop');
  if (!overlay) return;
  overlay.classList.remove('visible');
  setTimeout(() => { $('#overlay-root').innerHTML = ''; }, 180);
}

function logSheet() {
  const today = dateKey();
  openSheet(`
    <header class="sheet-header"><div><span class="eyebrow">quick log</span><h2>Record a <em>set</em></h2></div><button class="close-button" data-action="close" aria-label="Close">&times;</button></header>
    <form id="log-form">
      <div class="form-grid">
      <label class="field full"><span>Exercise</span><input name="exercise" list="exercise-list" required autocomplete="off" placeholder="choose an exercise"><datalist id="exercise-list">${allExercises().map((exercise) => `<option value="${escapeHtml(exercise.name)}"></option>`).join('')}</datalist></label>
        <label class="field"><span>Date</span><input name="date" type="date" value="${today}" required></label>
        <label class="field"><span>Weight, kg</span><input name="weight" type="number" min="0" step=".25" inputmode="decimal"></label>
        <label class="field"><span>Reps</span><input name="reps" type="number" min="1" inputmode="numeric"></label>
        <label class="field"><span>${termMarkup('rir', 'RIR')}</span><span class="rir-display"><input name="rir" type="range" min="0" max="10" value="2"><output>2</output></span></label>
        <label class="field full"><span>Notes</span><textarea name="notes"></textarea></label>
      </div>
      <p class="hint">${termMarkup('hard_set', 'hard sets')} count at ${termMarkup('rir', 'RIR')} 0–4. sets above this remain in the log.</p>
      <button class="submit-button" type="submit">save set</button>
    </form>`);
}

function accountSheet() {
  if (cloud.user) {
    openSheet(`
      <header class="sheet-header"><div><span class="eyebrow">account</span><h2>Cloud <em>sync</em></h2></div><button class="close-button" data-action="close" aria-label="Close">&times;</button></header>
      <p>signed in as <strong>${escapeHtml(cloud.user.email)}</strong>. sets, settings and teaching progress are private to this account and available on another browser after sign-in.</p>
      <p class="account-status">${cloud.syncing ? 'saving changes' : 'all local changes synced'}</p>
      <div class="settings-actions"><button class="secondary-button" data-action="sync-now">sync now</button><button class="secondary-button" data-action="sign-out">sign out</button></div>`);
    return;
  }
  openSheet(`
    <header class="sheet-header"><div><span class="eyebrow">cloud sync</span><h2>Private <em>account</em></h2></div><button class="close-button" data-action="close" aria-label="Close">&times;</button></header>
    ${cloud.available ? `
      <p>sign in to keep training data across browsers and devices. existing data on this browser is uploaded when a new account is created.</p>
      <form id="auth-form">
        <div class="form-grid">
          <label class="field full"><span>Email</span><input name="email" type="text" inputmode="email" autocomplete="email" required></label>
          <label class="field full"><span>Password</span><input name="password" type="password" autocomplete="current-password" minlength="10" required></label>
        </div>
        <p class="hint">minimum 10 characters. password reset by email is not available yet.</p>
        <div class="settings-actions"><button class="submit-button" type="submit" data-auth-mode="sign-in">sign in</button><button class="secondary-button" type="submit" data-auth-mode="register">create account</button></div>
      </form>` : '<p>cloud sync is unavailable at this address. data remains stored in this browser.</p>'}`);
}

function customExerciseSheet() {
  openSheet(`
    <header class="sheet-header"><div><span class="eyebrow">custom exercise</span><h2>Add an <em>exercise</em></h2></div><button class="close-button" data-action="close" aria-label="Close">&times;</button></header>
    <form id="custom-form">
      <label class="field full"><span>Name</span><input name="name" required></label>
      <p class="hint">select the contribution made by one logged set.</p>
      <div class="custom-grid">${MUSCLES.map((muscle) => `<label>${muscle.name}<select name="${muscle.id}"><option value="0">none</option><option value=".25">0.25</option><option value=".5">0.5</option><option value="1">1.0</option></select></label>`).join('')}</div>
      <button class="submit-button" type="submit">save exercise</button>
    </form>`);
}

function learningSheet(termId) {
  const entry = glossary(termId);
  openSheet(`
    <header class="sheet-header"><div><span class="eyebrow">glossary</span><h2>${entry.term}</h2></div><button class="close-button" data-action="close" aria-label="Close">&times;</button></header>
    <p>${entry.long}</p>
    <section class="settings-section"><span class="eyebrow">mechanism</span><p>${entry.mechanism}</p></section>`);
}

function notify(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

// ============ EVENT HANDLERS ============
document.addEventListener('click', (event) => {
  const term = event.target.closest('[data-term].term');
  if (term) {
    event.preventDefault();
    exposeTerm(term.dataset.term);
    ui.tooltip = term.dataset.term;
    render();
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  const target = event.target.closest('[data-action]');
  if (event.target.classList.contains('sheet-backdrop')) closeSheet();
  if (!action) return;
  if (action === 'open-log') logSheet();
  if (action === 'account') accountSheet();
  if (action === 'close') closeSheet();
  if (action === 'detail') { ui.detailMuscle = target.dataset.muscle; render(); }
  if (action === 'back') { ui.detailMuscle = null; render(); }
  if (action === 'sort') { ui.sort = target.dataset.sort; render(); }
  if (action === 'why') { ui.expandedLessons.has(target.dataset.id) ? ui.expandedLessons.delete(target.dataset.id) : ui.expandedLessons.add(target.dataset.id); render(); }
  if (action === 'dismiss-lesson') dismissLesson(target.dataset.id);
  if (action === 'learn-more') { ui.tooltip = null; learningSheet(target.dataset.term); renderTooltip(); }
  if (action === 'custom-exercise') customExerciseSheet();
  if (action === 'delete-exercise') {
    state.custom_exercises = state.custom_exercises.filter((exercise) => exercise.id !== target.dataset.id);
    persist(); render(); notify('exercise removed');
  }
  if (action === 'reset-targets') { state.targets = {}; persist(); render(); notify('reference targets restored'); }
  if (action === 'export') exportState();
  if (action === 'reset') resetState();
  if (action === 'sync-now') { syncCloudNow(); closeSheet(); }
  if (action === 'sign-out') signOut();
});

document.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('term')) event.target.click();
  if (event.key === 'Escape') { ui.tooltip = null; renderTooltip(); closeSheet(); }
});

document.addEventListener('change', async (event) => {
  if (event.target.id === 'phase-select') {
    state.phase = event.target.value;
    persist();
    render();
  }
  if (event.target.dataset.optional) {
    state.enabled_optional[event.target.dataset.optional] = event.target.checked;
    persist(); render();
  }
  if (event.target.dataset.target) updateTarget(event.target.dataset.target);
  if (event.target.id === 'import-state') await importState(event.target.files[0]);
});

document.addEventListener('input', (event) => {
  if (event.target.name === 'rir') event.target.nextElementSibling.value = event.target.value;
});

document.addEventListener('submit', (event) => {
  if (event.target.id === 'log-form') {
    event.preventDefault();
    saveSet(new FormData(event.target));
  }
  if (event.target.id === 'custom-form') {
    event.preventDefault();
    saveCustomExercise(new FormData(event.target));
  }
  if (event.target.id === 'auth-form') {
    event.preventDefault();
    authenticate(new FormData(event.target), event.submitter?.dataset.authMode || 'sign-in');
  }
});

$$('.nav-button[data-view]').forEach((button) => button.addEventListener('click', () => {
  ui.view = button.dataset.view;
  ui.detailMuscle = null;
  ui.tooltip = null;
  render();
}));

function saveSet(form) {
  const exercise = allExercises().find((item) => item.name.toLowerCase() === String(form.get('exercise')).trim().toLowerCase());
  if (!exercise) { notify('select a listed exercise'); return; }
  const stamp = now();
  const set = {
    id: uid(),
    created_at: stamp,
    updated_at: stamp,
    date: form.get('date'),
    exercise_id: exercise.id,
    weight: form.get('weight') ? Number(form.get('weight')) : null,
    reps: form.get('reps') ? Number(form.get('reps')) : null,
    rir: Number(form.get('rir')),
    notes: String(form.get('notes') || '')
  };
  state.sets.push(set);
  runLessons(set);
  persist();
  closeSheet();
  ui.view = 'dashboard';
  ui.detailMuscle = null;
  render();
  notify(set.rir <= 4 ? 'hard set recorded' : 'set recorded · below stimulus threshold');
}

function dismissLesson(id) {
  const entry = state.lessons.active.find((lesson) => lesson.id === id);
  if (!entry) return;
  entry.updated_at = now();
  state.lessons.active = state.lessons.active.filter((lesson) => lesson.id !== id);
  state.lessons.archive.unshift(entry);
  persist(); render();
}

function updateTarget(muscleId) {
  const row = $(`input[data-target="${muscleId}"]`).closest('.target-row');
  const value = (field) => Math.max(0, Number($(`input[data-field="${field}"]`, row).value) || 0);
  const mev = value('mev');
  const low = Math.max(mev, value('mavLow'));
  const high = Math.max(low, value('mavHigh'));
  const mrv = Math.max(high, value('mrv'));
  state.targets[muscleId] = { mev, mav: [low, high], mrv };
  persist(); render();
}

function saveCustomExercise(form) {
  const contributions = {};
  MUSCLES.forEach((muscle) => {
    const value = Number(form.get(muscle.id));
    if (value) contributions[muscle.id] = value;
  });
  if (!Object.keys(contributions).length) { notify('choose at least one muscle'); return; }
  const stamp = now();
  state.custom_exercises.push({
    id: uid(),
    created_at: stamp,
    updated_at: stamp,
    name: String(form.get('name')).trim(),
    contributions
  });
  persist(); closeSheet(); render(); notify('exercise added');
}

function scheduleCloudSave() {
  cloud.pending = true;
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(syncCloudNow, 250);
}

async function syncCloudNow() {
  if (!cloud.user || cloud.syncing) return;
  const revision = state.updated_at;
  let reschedule = false;
  cloud.syncing = true;
  render();
  try {
    await TensionCloud.saveState(state);
    cloud.lastSync = now();
    cloud.pending = state.updated_at !== revision;
    reschedule = cloud.pending;
  } catch (_error) {
    cloud.pending = true;
    notify('cloud sync paused · changes remain on this browser');
  } finally {
    cloud.syncing = false;
    render();
    if (reschedule) scheduleCloudSave();
  }
}

async function authenticate(form, mode) {
  const email = String(form.get('email') || '').trim();
  const password = String(form.get('password') || '');
  try {
    const response = mode === 'register' ? await TensionCloud.register(email, password) : await TensionCloud.signIn(email, password);
    cloud.user = response.user;
    if (mode === 'register') {
      cloud.pending = true;
      await syncCloudNow();
    } else {
      const remote = await TensionCloud.readState();
      if (remote.state) {
        state = remote.state;
        persist(false);
      } else {
        cloud.pending = true;
        await syncCloudNow();
      }
    }
    closeSheet();
    render();
    notify(mode === 'register' ? 'account created · data synced' : 'signed in · data restored');
  } catch (error) {
    notify(error.message);
  }
}

async function signOut() {
  try {
    await syncCloudNow();
    await TensionCloud.signOut();
  } catch (_error) {
    notify('sign out could not be completed');
    return;
  }
  cloud.user = null;
  state = createState();
  persist(false);
  closeSheet();
  ui.view = 'dashboard';
  ui.detailMuscle = null;
  render();
  notify('signed out · this browser is ready for another user');
}

async function initCloud() {
  try {
    const session = await TensionCloud.session();
    cloud.user = session.user || null;
    if (cloud.user) {
      const remote = await TensionCloud.readState();
      if (remote.state) {
        state = remote.state;
        persist(false);
      } else {
        cloud.pending = true;
        await syncCloudNow();
      }
    }
  } catch (_error) {
    cloud.available = false;
  } finally {
    cloud.checking = false;
    render();
  }
}

function exportState() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `tension-export-${dateKey()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  notify('data exported');
}

async function importState(file) {
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!isValidImport(imported)) throw new Error('invalid schema');
    state = imported;
    persist(false);
    ui.view = 'dashboard';
    render();
    notify('data restored');
  } catch (_error) {
    notify('import could not be read');
  }
}

function resetState() {
  if (!window.confirm('Reset all Tension data on this device?')) return;
  localStorage.removeItem(STORAGE_KEY);
  state = createState();
  persist(false);
  ui.view = 'dashboard';
  ui.detailMuscle = null;
  render();
  notify('local data cleared');
}

// ============ INIT ============
state = loadState();
persist(false);
render();
initCloud();

window.TensionTest = {
  state: () => state,
  volume: () => currentVolumes(),
  target: (id) => displayedTarget(MUSCLES.find((muscle) => muscle.id === id)),
  storageKey: STORAGE_KEY,
  reset: () => { state = createState(); persist(false); render(); }
};
