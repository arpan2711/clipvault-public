// ClipVault UI: library, player/trimmer and settings. Talks to the main process via the
// `window.clipvault` bridge defined in preload.js.
const api = window.clipvault;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  status: null,
  items: [],
  matchRows: [], // match records' list rows (matches:list): League-client stats per match
  hidden: new Set(), // videos deleted a moment ago: hidden until they go to the Recycle Bin (Undo)
  settingsSection: pref('settingsSection', 'general'), // the Settings section on show
  view: 'library', // library | settings
  filter: { type: 'all', game: null, query: '', sort: 'newest' },
  player: null,
  selected: new Set(), // library multi-select (Ctrl / Shift + click): merge or delete together
  lastClicked: null,
  // Matches view: the open match, its moment filter, select mode, and the list filters.
  matchUi: { expandedKey: null, family: 'all', selecting: false, filter: { mode: '', result: '', champion: '', query: '', sort: 'newest' } },
};

// The newer parts of the UI are ES modules, loaded once at start (js/lib, js/views). If they can't
// load, the library falls back to the plain grid.
const mod = {};
async function loadModules() {
  try {
    const [group, titles, matches] = await Promise.all([
      import('./js/lib/group.js'), import('./js/lib/titles.js'), import('./js/views/matches.js'),
    ]);
    Object.assign(mod, { group, titles, matches });
    // The match page; without it, matches open in the player.
    mod.match = await import('./js/views/match.js').catch((err) => { console.error('could not load the match page:', err); return null; });
    // The first-run setup; without it, the app just opens as usual.
    mod.onboarding = await import('./js/views/onboarding.js').catch((err) => { console.error('could not load the setup:', err); return null; });
    mod.onboardingLib = mod.onboarding ? await import('./js/lib/onboarding.js') : null;
  } catch (err) {
    console.error('could not load the view modules:', err);
  }
}

// The library grouped into League matches and loose clips, recomputed when the item list or the
// match records change. A match's record (League client stats: CS, damage, gold, vision, KP) fills
// in its stats (group.js applyRecords).
let grouped = null;
let groupedFor = null;
let groupedRows = null;
function groups() {
  if (!mod.group) return { matches: [], loose: state.items };
  if (groupedFor !== state.items || groupedRows !== state.matchRows) {
    grouped = mod.group.groupLibrary(state.items);
    groupedFor = state.items;
    groupedRows = state.matchRows;
    mod.group.applyRecords(grouped.matches, state.matchRows);
  }
  return grouped;
}

// Item, summoner-spell and rune icons, looked up while a view is drawn: a known icon comes back at
// once; an unknown one is asked for (batched, from the main process's cache in <userData>\icons)
// and the views are redrawn when it arrives. One that isn't available is asked again after a while.
const gameIconCache = new Map(); // "item:3031" -> { url, name } | { url: null, at } | 'asking'
let gameIconQueue = null;
function gameIcon(kind, id) {
  const key = `${kind}:${id}`;
  const v = gameIconCache.get(key);
  if (v === 'asking') return null;
  if (v && (v.url || Date.now() - v.at < 5 * 60 * 1000)) return v.url ? v : null;
  if (!api.gameIcons) return null;
  gameIconCache.set(key, 'asking');
  if (!gameIconQueue) {
    gameIconQueue = new Set();
    setTimeout(flushGameIcons, 0);
  }
  gameIconQueue.add(key);
  return null;
}

async function flushGameIcons() {
  const keys = [...gameIconQueue];
  gameIconQueue = null;
  const got = {};
  for (let i = 0; i < keys.length; i += 150) { // the main process answers up to 200 at a time
    try { Object.assign(got, (await api.gameIcons(keys.slice(i, i + 150))) || {}); } catch { /* unavailable */ }
  }
  let fresh = false;
  for (const k of keys) {
    const v = got[k];
    if (v && typeof v.url === 'string' && v.url) {
      gameIconCache.set(k, { url: v.url, name: v.name || null });
      fresh = true;
    } else {
      gameIconCache.set(k, { url: null, at: Date.now() });
    }
  }
  if (fresh) refreshViews();
}

// Match records from the main process (matches:list); an empty list in builds without them.
async function listMatchRows() {
  try { return api.listMatches ? window.EventStyles.renameLegacy((await api.listMatches()) || []) : []; } catch { return []; }
}
// The library, with older moment names shown as the game names them (events.js).
const listItems = async () => window.EventStyles.renameLegacy(await api.listLibrary());
const findMatch = (key) => groups().matches.find((m) => m.key === key) || null;
const displayTitle = (i) => (mod.titles ? mod.titles.displayTitle(i) : i.name);

// Small preferences kept in this window's storage (never essential).
function pref(key, fallback) {
  try {
    const v = localStorage.getItem(`clipvault.${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function setPref(key, value) {
  try { localStorage.setItem(`clipvault.${key}`, JSON.stringify(value)); } catch { /* not important */ }
}

// ------------------------------------------------------------------ formatting

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function fmtPrecise(sec) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

function fmtSeconds(s) {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

function fmtSize(bytes) {
  if (!bytes) return '0 MB';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(bytes >= 104857600 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  // "Friday 16 October", as the Matches view writes its days (the year only when it isn't this year's).
  const year = d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.toLocaleDateString(undefined, { weekday: 'long' })} ${d.getDate()} ${d.toLocaleDateString(undefined, { month: 'long' })}${year}`;
}

// ------------------------------------------------------------------ icons

const svg = (body, extra = '') => `<svg class="i" viewBox="0 0 24 24" ${extra}>${body}</svg>`;
const I = {
  all: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  clip: svg('<path d="M13 2L4.5 13.5H12L11 22l8.5-11.5H12z"/>'),
  star: svg('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>'),
  map: svg('<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>'),
  reel: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5M16 4v5M10 13l5 2.5-5 2.5z"/>'),
  playSm: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>'),
  pause: svg('<path d="M8 5v14M16 5v14"/>', 'stroke-width="3"'),
  prev: svg('<path d="M18 6 9 12l9 6zM6 6v12"/>'),
  next: svg('<path d="M6 6l9 6-9 6zM18 6v12"/>'),
  rec: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>',
  film: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>'),
  external: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  scissors: svg('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>'),
  drag: svg('<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>'),
  audio: svg('<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'),
  keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  heart: svg('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>'),
  heartFill: svg('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z" fill="currentColor"/>'),
  share: svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>'),
  merge: svg('<path d="M6 3v6a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6v0M18 3v6a6 6 0 0 1-6 6"/><path d="M15 18l3 3 3-3"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7"/>', 'stroke-width="3"'),
  frameBack: svg('<path d="M11 6l-6 6 6 6M19 6v12"/>'),
  frameNext: svg('<path d="M13 6l6 6-6 6M5 6v12"/>'),
  skipPrev: svg('<path d="M19 6l-8 6 8 6zM5 6v12"/>'),
  skipNext: svg('<path d="M5 6l8 6-8 6zM19 6v12"/>'),
  montage: svg('<rect x="3" y="7" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v12"/><path d="M8.5 11v6l5-3z"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/>'),
  filter: svg('<path d="M3 5h18l-7 8v6l-4-2v-4z"/>'),
};

// ------------------------------------------------------------------ toasts + dialogs

// One line with an icon for its kind and an optional action (Undo). opts: true (sticky: replaced by
// the next toast, else gone after 10 s) or { sticky, ms, action: { label, run } }. Errors stay until
// they're closed; at most three toasts show at once.
const TOAST_ICONS = { ok: 'circle-check', warn: 'triangle-alert', error: 'circle-alert', info: 'info', rec: 'circle-dot' };
function toast(text, kind = 'info', opts = false) {
  const o = opts && typeof opts === 'object' ? opts : { sticky: Boolean(opts) };
  const box = $('#toasts');
  const last = box.lastElementChild;
  if (last && last.dataset.sticky) last.remove();
  while (box.children.length >= 3) box.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const glyph = kind === 'saving' ? '<span class="spinner"></span>' : `<span class="ticon">${spriteIcon(TOAST_ICONS[kind] || 'info')}</span>`;
  el.innerHTML = `${glyph}<span class="ttext">${esc(text)}</span>`
    + (o.action ? `<button type="button" class="toast-act">${esc(o.action.label)}</button>` : '')
    + (kind === 'error' ? `<button type="button" class="toast-x" title="Dismiss" aria-label="Dismiss">${spriteIcon('x')}</button>` : '');
  if (o.sticky) el.dataset.sticky = '1';
  const ms = o.ms || (kind === 'error' ? 0 : o.sticky ? 10000 : 3400);
  const timer = ms ? setTimeout(() => el.remove(), ms) : 0;
  const close = () => { clearTimeout(timer); el.remove(); };
  if (o.action) el.querySelector('.toast-act').addEventListener('click', () => { close(); o.action.run(); });
  const x = el.querySelector('.toast-x');
  if (x) x.addEventListener('click', close);
  box.appendChild(el);
  return el;
}

// Deleting: the videos disappear at once and go to the Recycle Bin a few seconds later, unless
// Undo is pressed first. Closing ClipVault in those seconds deletes nothing.
const UNDO_MS = 5000;
function trashLater(files, message) {
  const list = [...new Set(files.filter(Boolean))];
  if (!list.length) return;
  for (const f of list) { state.hidden.add(f); state.selected.delete(f); }
  if (state.player && list.includes(state.player.item.path)) closePlayer();
  const open = state.mp && findMatch(state.mp.key);
  if (open && open.files.some((f) => list.includes(f.path))) mpRelease(); // the match page lets go of them
  state.items = state.items.filter((i) => !state.hidden.has(i.path));
  refreshViews();
  let undone = false;
  const timer = setTimeout(async () => {
    if (undone) return;
    const n = await attempt(() => api.removeMany(list), "Couldn't delete");
    for (const f of list) state.hidden.delete(f);
    await refreshLibrary();
    if (n != null && n < list.length) toast(`${list.length - n} of ${list.length} videos couldn't go to the Recycle Bin (in use?)`, 'error');
  }, UNDO_MS);
  toast(message, 'ok', {
    ms: UNDO_MS,
    action: {
      label: 'Undo',
      run: () => {
        undone = true;
        clearTimeout(timer);
        for (const f of list) state.hidden.delete(f);
        refreshLibrary();
      },
    },
  });
}

// `list`: lines shown under the body, e.g. every file a delete would move to the Recycle Bin.
// Destructive dialogs start on Cancel, and Enter only presses the button that has focus, so a
// stray Enter never deletes anything.
// A dialog can't show over a full screen video: full screen ends first.
function leaveFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function confirmDialog({ title, body, confirm = 'OK', danger = false, list = null }) {
  leaveFullscreen();
  return new Promise((resolve) => {
    const back = $('#dialog');
    back.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3><p>${esc(body)}</p>
      ${list && list.length ? `<ul class="dialog-list">${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      <div class="buttons"><button class="btn ghost" data-r="0">Cancel</button>
      <button class="btn ${danger ? 'solid-danger' : 'primary'}" data-r="1">${esc(confirm)}</button></div></div>`;
    back.hidden = false;
    const done = (r) => {
      back.hidden = true;
      back.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      resolve(r);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter') {
        e.stopPropagation();
        e.preventDefault();
        const focused = document.activeElement && back.contains(document.activeElement) ? document.activeElement.closest('[data-r]') : null;
        if (focused) done(focused.dataset.r === '1');
        else if (!danger) done(true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    back.onclick = (e) => {
      const b = e.target.closest('[data-r]');
      if (b) done(b.dataset.r === '1');
      else if (e.target === back) done(false);
    };
    back.querySelector(danger ? '[data-r="0"]' : '[data-r="1"]').focus();
  });
}

// A dialog that only shows information (keyboard shortcuts).
function infoDialog(title, html) {
  leaveFullscreen();
  const back = $('#dialog');
  back.innerHTML = `<div class="dialog wide" role="dialog" aria-modal="true"><h3>${esc(title)}</h3>${html}
    <div class="buttons"><button class="btn primary" data-r="1">Close</button></div></div>`;
  back.hidden = false;
  const done = () => {
    back.hidden = true;
    back.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (['Escape', 'Enter', '?'].includes(e.key)) { e.stopPropagation(); e.preventDefault(); done(); }
  };
  document.addEventListener('keydown', onKey, true);
  back.onclick = (e) => { if (e.target === back || e.target.closest('[data-r]')) done(); };
}

// Report a bug (Settings → About, the sidebar, the tray menu). The main process builds the report,
// redacts it and opens the prefilled GitHub issue; the full text (with the log) goes to the
// clipboard and can be saved as a file to attach.
function bugReportDialog() {
  leaveFullscreen();
  const back = $('#dialog');
  if (!back.hidden && back.querySelector('.bug-form')) return; // already open
  back.innerHTML = `<div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="bugTitle">
    <h3 id="bugTitle">Report a bug</h3>
    <p>This opens a new issue on GitHub (you need a free account to send it) with what you write here filled in.</p>
    <div class="bug-form">
      <label>What happened<textarea id="bugWhat" rows="3" placeholder="e.g. The clip I saved has no sound" spellcheck="true"></textarea></label>
      <label>Steps to reproduce <span>Optional. What you did right before it happened.</span><textarea id="bugSteps" rows="2" spellcheck="true"></textarea></label>
      <label class="bug-check"><input type="checkbox" id="bugDiag" checked>Include diagnostics</label>
      <details class="bug-diag" id="bugDiagBox"><summary>What's included</summary>
        <pre id="bugDiagText">Loading…</pre></details>
    </div>
    <div class="buttons"><button class="btn ghost" data-act="bug-save">Save report file</button><span class="spacer"></span>
      <button class="btn ghost" data-act="bug-cancel">Cancel</button>
      <button class="btn primary" data-act="bug-send" disabled>Open on GitHub</button></div></div>`;
  back.hidden = false;
  const what = $('#bugWhat');
  const send = back.querySelector('[data-act="bug-send"]');
  const diag = $('#bugDiag');
  const report = () => ({ what: what.value, steps: $('#bugSteps').value, diagnostics: diag.checked });
  api.bugDiagnostics().then((d) => {
    const pre = $('#bugDiagText');
    if (pre) pre.textContent = `${d.system}\n\nThe last 200 lines of clipvault.log:\n${d.log || '(empty)'}`;
  }).catch(() => { const pre = $('#bugDiagText'); if (pre) pre.textContent = "Couldn't collect the diagnostics"; });
  what.addEventListener('input', () => { send.disabled = !what.value.trim(); });
  diag.addEventListener('change', () => { $('#bugDiagBox').hidden = !diag.checked; });
  const done = () => {
    back.hidden = true;
    back.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
  document.addEventListener('keydown', onKey, true);
  const save = async (btn) => {
    btn.disabled = true;
    const name = await attempt(() => api.saveBugReport(report()), "Couldn't save the report");
    btn.disabled = false;
    if (name) toast(`Saved ${name}`, 'ok');
  };
  back.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (b && b.dataset.act === 'bug-cancel') { done(); return; } // a stray click outside keeps what you typed
    if (!b || b.disabled) return;
    if (b.dataset.act === 'bug-save') { save(b); return; }
    if (b.dataset.act !== 'bug-send' || !what.value.trim()) return;
    b.disabled = true;
    const input = report();
    if (!(await attempt(() => api.submitBug(input), "Couldn't open GitHub"))) { b.disabled = false; return; }
    // Afterwards: say where the rest of the report is, and keep Save at hand.
    const box = back.querySelector('.dialog');
    box.innerHTML = `<h3>Finish the report on GitHub</h3>
      <p class="bug-done">GitHub opened in your browser with your description${input.diagnostics ? ' and system info' : ''} filled in.${input.diagnostics
        ? ' <b>The full report, with the last lines of the log, is on your clipboard:</b> paste it into the issue, or save it as a file and attach it.' : ''}</p>
      <div class="buttons"><button class="btn ghost" data-act="bug-save">Save report file</button><span class="spacer"></span>
        <button class="btn primary" data-act="bug-cancel">Done</button></div>`;
    back.onclick = (ev) => {
      const x = ev.target.closest('[data-act]');
      if (ev.target === back || (x && x.dataset.act === 'bug-cancel')) done();
      else if (x && x.dataset.act === 'bug-save' && !x.disabled) {
        x.disabled = true;
        attempt(() => api.saveBugReport(input), "Couldn't save the report").then((name) => { x.disabled = false; if (name) toast(`Saved ${name}`, 'ok'); });
      }
    };
  };
  what.focus();
}

// A small menu next to `anchor`. Resolves { id, values } (values: its <select data-name> fields) or null.
function popover(anchor, { title, items, footer = '' }) {
  return new Promise((resolve) => {
    const pop = $('#popover');
    pop.innerHTML = `${title ? `<div class="pop-title">${esc(title)}</div>` : ''}
      ${items.map((it) => `<button class="pop-item" data-id="${esc(it.id)}" ${it.disabled ? 'disabled' : ''}><b>${esc(it.label)}</b>${it.sub ? `<span>${esc(it.sub)}</span>` : ''}</button>`).join('')}
      ${footer}`;
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const left = Math.min(window.innerWidth - pop.offsetWidth - 8, Math.max(8, r.right - pop.offsetWidth));
    let top = r.top - pop.offsetHeight - 6;
    if (top < 8) top = Math.min(window.innerHeight - pop.offsetHeight - 8, r.bottom + 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    const done = (v) => {
      pop.hidden = true;
      pop.innerHTML = '';
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const outside = (e) => { if (!pop.contains(e.target)) done(null); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(null); } };
    pop.onclick = (e) => {
      const b = e.target.closest('.pop-item');
      if (!b || b.disabled) return;
      const values = {};
      pop.querySelectorAll('[data-name]').forEach((f) => { values[f.dataset.name] = f.value; });
      done({ id: b.dataset.id, values });
    };
    setTimeout(() => {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', onKey, true);
    });
  });
}

async function attempt(fn, failPrefix) {
  try {
    return await fn();
  } catch (err) {
    const msg = String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    toast(`${failPrefix}: ${msg}`, 'error');
    return undefined;
  }
}

// ------------------------------------------------------------------ top bar

function encoderLabel(id) {
  const e = (state.status.encoders || []).find((x) => x.id === id);
  return e ? e.label.replace(/ \((GPU|CPU)\)$/, '') : id;
}

function renderTopbar() {
  const s = state.status;
  if (!s) return;
  const hk = s.settings.hotkeys;
  const on = s.state === 'running';
  const starting = s.starting || s.state === 'starting';
  const stopping = s.state === 'stopping';

  const chip = $('#status');
  chip.className = `status ${on ? 'on' : starting ? 'starting' : ''}`;
  const label = on ? 'Replay buffer on' : starting ? 'Starting capture…' : stopping ? 'Stopping…' : 'Replay buffer off';
  let sub;
  if (on && s.league) {
    sub = `League of Legends${s.league.champion ? ` · ${s.league.champion}` : ''} · auto-clipping key moments · ${s.league.clips} saved`;
  } else if (on) {
    sub = `Keeping the last ${fmtSeconds(s.settings.replaySeconds)} · ${encoderLabel(s.info ? s.info.encoder : s.encoder)}`;
    if (s.game) sub += ` · ${s.game}`;
  } else if (starting) {
    sub = 'One moment';
  } else {
    sub = `Click or press ${hk.toggleBuffer} to turn on`;
  }
  chip.innerHTML = `<span class="dot"></span><span class="lines"><span class="label">${esc(label)}</span><span class="sub">${esc(sub)}</span></span>`;

  const rec = $('#recBtn');
  rec.classList.toggle('recording', Boolean(s.recording));
  rec.disabled = !s.ffmpegOk || stopping;
  if (s.recording) {
    rec.innerHTML = `<span class="dot"></span><span>Recording <span id="recTime">${fmtDuration((Date.now() - s.recording.startedAt) / 1000)}</span></span><kbd>${esc(hk.toggleRecording)}</kbd>`;
    rec.title = 'Stop recording';
  } else {
    rec.innerHTML = `<span class="dot"></span>Record<kbd>${esc(hk.toggleRecording)}</kbd>`;
    rec.title = 'Start a full recording';
  }

  const clip = $('#clipBtn');
  clip.disabled = !on;
  clip.innerHTML = `${s.saving ? '<span class="spinner"></span>' : I.clip}Save clip<kbd>${esc(hk.saveClip)}</kbd>`;
  clip.title = on ? `Save the last ${fmtSeconds(s.settings.replaySeconds)}` : 'Turn on the replay buffer first';

  const jp = $('#jobPill');
  jp.hidden = !s.job;
  if (s.job) {
    const pct = Math.round((s.job.progress || 0) * 100);
    jp.innerHTML = `<span class="spinner"></span><span class="jl">${esc(s.job.label)}</span><span class="bar"><i style="width:${pct}%"></i></span><b>${pct}%</b>`;
    jp.title = `${s.job.label}: ${pct}%`;
  }

  const banner = $('#banner');
  if (s.lastError) {
    banner.hidden = false;
    banner.innerHTML = `<span>${esc(s.lastError)}</span>${s.ffmpegOk ? '<button class="btn sm" data-act="retry">Try again</button>' : ''}`;
  } else {
    banner.hidden = true;
  }
}

setInterval(() => {
  const el = $('#recTime');
  if (el && state.status && state.status.recording) {
    el.textContent = fmtDuration((Date.now() - state.status.recording.startedAt) / 1000);
  }
}, 500);

$('#status').addEventListener('click', () => attempt(() => api.toggleBuffer(), 'Replay buffer'));
$('#recBtn').addEventListener('click', () => attempt(() => api.toggleRecording(), 'Recording'));
$('#clipBtn').addEventListener('click', () => attempt(() => api.saveClip(), 'Clip'));
$('#banner').addEventListener('click', (e) => {
  if (e.target.closest('[data-act="retry"]')) attempt(() => api.toggleBuffer(), 'Replay buffer');
});

// ------------------------------------------------------------------ sidebar

// Storage line under the sidebar; with a limit set, a bar for what counts toward it.
function storageHtml(items) {
  const total = items.reduce((a, i) => a + (i.size || 0), 0);
  const limitGB = state.status ? state.status.settings.storageLimitGB : 0;
  let quota = '';
  if (limitGB) {
    const counted = items.filter((i) => !i.favorite).reduce((a, i) => a + (i.size || 0), 0);
    const limit = limitGB * 1073741824;
    const pct = Math.min(100, (counted / limit) * 100);
    quota = `<div class="quota ${pct > 90 ? 'full' : ''}" title="When the limit is reached, the oldest videos go to the Recycle Bin. Favorites never do and don't count.">
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>${fmtSize(counted)} of ${limitGB} GB limit</div>`;
  }
  return `${quota}${fmtSize(total)} in ${items.length} video${items.length === 1 ? '' : 's'}`;
}

const LEAGUE_GAME = 'League of Legends';
const spriteIcon = (id) => `<svg class="i" aria-hidden="true"><use href="icons.svg#i-${id}"></use></svg>`;

function renderSidebar() {
  const items = state.items;
  const favorites = items.filter((i) => i.favorite).length;
  const f = state.filter;
  const lib = state.view === 'library' || state.view === 'match';
  const navItem = (key, icon, name, count) => {
    const active = lib && !f.game && f.type === key;
    return `<button class="nav-item ${active ? 'active' : ''}" data-type="${key}">${icon}<span class="name">${name}</span><span class="count">${count}</span></button>`;
  };
  // Games: League counts its matches (plus clips saved by hand), other games their videos.
  const games = new Map();
  let nav;
  if (mod.group) {
    const { matches, loose } = groups();
    for (const i of loose) games.set(i.game, (games.get(i.game) || 0) + 1);
    if (matches.length) games.set(LEAGUE_GAME, (games.get(LEAGUE_GAME) || 0) + matches.length);
    nav = `${navItem('matches', spriteIcon('swords'), 'Matches', matches.length)}
      ${navItem('clips', spriteIcon('film'), 'Clips', loose.length)}
      ${navItem('favorites', I.heart, 'Favorites', favorites)}`;
  } else {
    for (const i of items) games.set(i.game, (games.get(i.game) || 0) + 1);
    const count = (type) => items.filter((i) => i.type === type).length;
    nav = `${navItem('all', I.all, 'All videos', items.length)}
      ${navItem('favorites', I.heart, 'Favorites', favorites)}
      ${navItem('highlight', I.star, 'Highlights', count('highlight'))}
      ${navItem('clip', I.clip, 'Clips', count('clip'))}
      ${navItem('recording', I.rec, 'Recordings', count('recording'))}`;
  }
  const sortedGames = [...games.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  $('#sidebar').innerHTML = `
    <div class="nav-label">Library</div>
    ${nav}
    ${sortedGames.length ? '<div class="nav-label">Games</div>' : ''}
    ${sortedGames.map(([g, n]) => `
      <button class="nav-item ${lib && f.game === g ? 'active' : ''}" data-game="${esc(g)}">
        <span class="game-initial">${esc(g.slice(0, 1).toUpperCase())}</span>
        <span class="name" title="${esc(g)}">${esc(g)}</span><span class="count">${n}</span>
      </button>`).join('')}
    <div class="sidebar-foot">
      <button class="nav-item ${state.view === 'settings' ? 'active' : ''}" data-view="settings">${I.gear}<span class="name">Settings</span></button>
      <div class="storage">${storageHtml(items)}<br><button data-act="open-folder">Open clips folder</button><span class="sep">·</span><button data-act="report-bug" title="Something not working? Tell us on GitHub">Report a bug</button></div>
    </div>`;
}

$('#sidebar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act === 'open-folder') { api.openFolder(); return; }
  if (b.dataset.act === 'report-bug') { bugReportDialog(); return; }
  if (b.dataset.view === 'settings') { navigate('settings'); return; }
  if (b.dataset.type) { state.filter.type = b.dataset.type; state.filter.game = null; }
  if (b.dataset.game !== undefined) {
    if (mod.group && b.dataset.game === LEAGUE_GAME) { state.filter.type = 'matches'; state.filter.game = null; } // League lives in Matches
    else { state.filter.game = b.dataset.game; state.filter.type = mod.group ? 'clips' : 'all'; }
  }
  navigate('library');
});

function navigate(view) {
  if (state.mp) closeMatchPage({ back: false });
  state.view = view === 'settings' ? 'settings' : 'library';
  renderSidebar();
  if (state.view === 'settings') renderSettings();
  else renderLibrary(true);
  $('#content').scrollTop = 0;
}

// ------------------------------------------------------------------ library

function filteredItems() {
  const { type, game, query, sort } = state.filter;
  // In Matches, the player's previous/next walk the open match's highlights in game order.
  if (type === 'matches') {
    const open = state.matchUi.expandedKey && findMatch(state.matchUi.expandedKey);
    return open ? [...open.clips] : groups().matches.flatMap((m) => m.clips);
  }
  const q = query.trim().toLowerCase();
  const pool = type === 'clips' ? groups().loose : state.items;
  const list = pool.filter((i) => (type === 'all' || type === 'clips' || i.type === type || (type === 'favorites' && i.favorite))
    && (!game || i.game === game)
    && (!q || [i.name, i.game, i.champion, i.label, displayTitle(i)].some((w) => w && String(w).toLowerCase().includes(q))));
  const by = {
    newest: (a, b) => b.created - a.created,
    oldest: (a, b) => a.created - b.created,
    longest: (a, b) => b.duration - a.duration,
    largest: (a, b) => b.size - a.size,
  }[sort];
  return list.sort(by);
}

// The library has videos but this view shows none: say why, and what brings some here.
function emptyViewHtml(f, s) {
  const q = f.query.trim();
  const hk = s ? s.settings.hotkeys : {};
  const box = (title, text, button = '') => `<div class="empty"><h2>${title}</h2><p>${text}</p>${button}</div>`;
  if (q) {
    return box(`No videos match “${esc(q)}”`, 'Try another word: a game, a champion, a moment such as “Kill”, or part of a file name.',
      '<button class="btn" data-act="clear-search">Clear search</button>');
  }
  if (f.type === 'favorites') {
    return box('No favorites yet', 'Add a clip or a match to favorites (the heart) to keep it here. Favorites are never removed by the storage limit.');
  }
  if (f.game) return box(`No videos from ${esc(f.game)}`, 'Videos you save while it runs show up here.');
  if (f.type === 'clips') {
    return box('No clips yet', `Press <kbd>${esc(hk.saveClip || 'the Save clip hotkey')}</kbd> in any game to save the last moments. League highlights are in Matches.`);
  }
  return box('Nothing here', 'No videos of this kind yet.');
}

// Post-game line for League matches: "Victory · 7/3/12".
function statsLine(st, { long = false } = {}) {
  if (!st) return '';
  const parts = [st.result, `${st.kills}/${st.deaths}/${st.assists}`];
  if (long) {
    if (st.cs != null) parts.push(`${st.cs} CS`);
    if (st.level) parts.push(`level ${st.level}`);
    if (st.gameTime) parts.push(fmtDuration(st.gameTime));
  }
  return parts.filter(Boolean).join(' · ');
}

function cardHtml(i) {
  const selected = state.selected.has(i.path);
  const st = i.stats;
  return `<article class="card${selected ? ' selected' : ''}" data-path="${esc(i.path)}" draggable="true" title="${esc(i.name)}">
    <div class="thumb">
      ${i.thumb ? `<img src="${esc(i.thumb)}" alt="" loading="lazy" draggable="false">` : `<div class="thumb-ph">${I.film}</div>`}
      ${i.duration ? `<span class="dur">${fmtDuration(i.duration)}</span>` : ''}
      ${i.type === 'recording' ? `<span class="tag rec">${esc(i.label || 'Recording')}</span>` : ''}
      ${i.type === 'map' ? `<span class="tag">${I.reel}${esc(i.label || 'Match reel')}</span>` : ''}
      ${i.type === 'montage' ? `<span class="tag">${I.montage}${esc(i.label || 'Highlight video')}</span>` : ''}
      ${i.type === 'highlight' || i.event === 'bookmark' ? highlightTag(i.label, i.event) : ''}
      ${st ? `<span class="kda ${st.result === 'Victory' ? 'win' : st.result === 'Defeat' ? 'loss' : ''}">${i.championIcon ? `<img src="${esc(i.championIcon)}" alt="">` : ''}${esc(statsLine(st))}</span>` : ''}
      <div class="hover-play"><span>${I.play}</span></div>
      <button class="sel-box" data-act="select" title="Select (Ctrl+click) to merge or delete several videos">${I.check}</button>
      <div class="card-actions">
        <button data-act="fav" class="${i.favorite ? 'on' : ''}" title="${i.favorite ? 'Remove from favorites' : 'Add to favorites (never removed by the storage limit)'}">${i.favorite ? I.heartFill : I.heart}</button>
        <button data-act="copy" title="Copy file (paste into Discord or a chat)">${I.copy}</button>
        <button data-act="folder" title="Show in folder">${I.folder}</button>
        <button data-act="delete" class="del" title="Delete">${I.trash}</button>
      </div>
    </div>
    <div class="card-body">
      <div class="card-title">${i.favorite ? `<span class="fav-mark" title="Favorite">${I.heartFill}</span>` : ''}${esc(displayTitle(i))}</div>
      <div class="card-meta">${i.championIcon && !st ? `<img class="champ" src="${esc(i.championIcon)}" alt="">` : ''}${esc([state.filter.game ? null : i.game, i.champion, fmtTime(i.created), fmtSize(i.size)].filter(Boolean).join(' · '))}</div>
    </div>
  </article>`;
}

const renderedCards = new WeakMap(); // card element -> the HTML it was built from

// ---- Matches: one row per League match (js/views/matches.js), its highlights when expanded
function renderMatches(full) {
  const content = $('#content');
  const ui = state.matchUi;
  const { matches } = groups();
  if (full || !$('.mv-page', content)) {
    content.innerHTML = '<div class="mv-page"><div id="mvHead"></div><div class="selbar" id="selbar" hidden></div><div id="mvBody"></div></div>';
  }
  // Keep the search box as it is while someone types in it.
  const head = $('#mvHead');
  const typing = head.contains(document.activeElement) && document.activeElement.matches('input');
  if (!typing) head.innerHTML = mod.matches.renderMatchHeader({ matches, filter: ui.filter });
  $('#mvBody').innerHTML = mod.matches.renderMatchList({
    matches, expandedKey: ui.expandedKey, filter: ui.filter, family: ui.family, selecting: ui.selecting, selected: state.selected,
    icons: gameIcon,
  });
  renderSelbar();
}

function renderLibrary(full) {
  if (state.filter.type === 'matches' && mod.matches && state.items.length) { renderMatches(full); return; }
  const content = $('#content');
  const f = state.filter;
  const title = f.game || {
    all: 'All videos', favorites: 'Favorites', highlight: 'Highlights', clip: 'Clips', clips: 'Clips', recording: 'Recordings', map: 'Match reels', montage: 'Highlight videos',
  }[f.type];
  if (full || !$('.lib-head', content)) {
    content.innerHTML = `
      <div class="lib-head">
        <div><h1>${esc(title)}</h1></div>
        <div class="total" id="libTotal"></div>
        <div class="tools">
          <label class="search">${I.search}<input id="search" placeholder="Search videos" value="${esc(f.query)}" spellcheck="false"></label>
          <select id="sort" title="Sort">
            <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
            <option value="longest">Longest first</option><option value="largest">Largest first</option>
          </select>
        </div>
        <div class="selbar" id="selbar" hidden></div>
      </div>
      <div class="lib-body" id="libBody"></div>`;
    $('#sort').value = f.sort;
    $('#search').addEventListener('input', (e) => { f.query = e.target.value; renderLibrary(false); });
    $('#sort').addEventListener('change', (e) => { f.sort = e.target.value; renderLibrary(false); });
  }

  const items = filteredItems();
  $('#libTotal').textContent = items.length ? `${items.length} video${items.length === 1 ? '' : 's'}` : '';
  renderSelbar();
  const body = $('#libBody');
  const s = state.status;

  if (!state.items.length) {
    const hk = s ? s.settings.hotkeys : {};
    const secs = s ? fmtSeconds(s.settings.replaySeconds) : '30 s';
    body.innerHTML = `<div class="empty">
      <h2>No clips yet</h2>
      <p>Play something. When a great moment happens, press the hotkey and ClipVault saves what just happened.</p>
      <div class="keys">
        <div><span>Save the last ${esc(secs)}</span><kbd>${esc(hk.saveClip || '')}</kbd></div>
        <div><span>Start / stop a full recording</span><kbd>${esc(hk.toggleRecording || '')}</kbd></div>
        <div><span>Replay buffer on / off</span><kbd>${esc(hk.toggleBuffer || '')}</kbd></div>
        <div><span>Bookmark a moment</span><kbd>${esc(hk.bookmark || '')}</kbd></div>
      </div>
      <button class="btn" data-act="settings">${I.gear}Open settings</button>
    </div>`;
    return;
  }
  if (!items.length) {
    body.innerHTML = emptyViewHtml(f, s);
    return;
  }

  const groups = [];
  if (f.sort === 'newest' || f.sort === 'oldest') {
    for (const i of items) {
      const label = dayLabel(i.created);
      if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
      groups[groups.length - 1].items.push(i);
    }
  } else {
    groups.push({ label: null, items });
  }

  // Reuse unchanged cards so loaded thumbnails don't flicker on every library update.
  const existing = new Map([...body.querySelectorAll('.card')].map((el) => [el.dataset.path, el]));
  body.innerHTML = groups.map((g) => `${g.label ? `<div class="day">${esc(g.label)}</div>` : ''}<div class="grid"${g.label ? '' : ' style="margin-top:8px"'}></div>`).join('');
  const grids = body.querySelectorAll('.grid');
  const tpl = document.createElement('template');
  groups.forEach((g, gi) => {
    for (const i of g.items) {
      const html = cardHtml(i);
      let el = existing.get(i.path);
      if (!el || renderedCards.get(el) !== html) {
        tpl.innerHTML = html;
        el = tpl.content.firstElementChild;
        renderedCards.set(el, html);
      }
      grids[gi].appendChild(el);
    }
  });
}

// ---- multi-select: Ctrl+click toggles, Shift+click selects a range; then merge or delete them
function renderSelbar() {
  const bar = $('#selbar');
  if (!bar) return;
  // forget selected videos that no longer exist
  for (const p of state.selected) if (!state.items.some((i) => i.path === p)) state.selected.delete(p);
  const n = state.selected.size;
  bar.hidden = !n;
  const head = $('.lib-head');
  if (head) head.classList.toggle('selecting', n > 0);
  if (!n) return;
  const chosen = state.items.filter((i) => state.selected.has(i.path));
  const secs = chosen.reduce((a, i) => a + (i.duration || 0), 0);
  const allFav = chosen.every((i) => i.favorite);
  bar.innerHTML = `<b>${n} selected</b><span class="muted">${fmtDuration(secs)} · ${fmtSize(chosen.reduce((a, i) => a + (i.size || 0), 0))}</span>
    <span class="spacer"></span>
    <button class="btn sm" data-act="sel-merge" ${n < 2 ? 'disabled title="Select at least two videos"' : 'title="Join them into one video, oldest first"'}>${I.merge}Merge into one video</button>
    <button class="btn sm" data-act="sel-fav">${allFav ? I.heartFill : I.heart}${allFav ? 'Remove from favorites' : 'Add to favorites'}</button>
    <button class="btn sm danger" data-act="sel-delete">${I.trash}Delete</button>
    <button class="btn sm ghost" data-act="sel-clear" title="Clear the selection (Esc)">Clear</button>`;
}

function toggleSelect(file, { range = false } = {}) {
  if (range && state.lastClicked) {
    const list = filteredItems().map((i) => i.path);
    const a = list.indexOf(state.lastClicked);
    const b = list.indexOf(file);
    if (a >= 0 && b >= 0) {
      for (let k = Math.min(a, b); k <= Math.max(a, b); k++) state.selected.add(list[k]);
    }
  } else if (state.selected.has(file)) {
    state.selected.delete(file);
  } else {
    state.selected.add(file);
  }
  state.lastClicked = file;
  renderLibrary(false);
}

function clearSelection() {
  if (!state.selected.size) return;
  state.selected.clear();
  renderLibrary(false);
}

async function selectionAction(act) {
  const chosen = state.items.filter((i) => state.selected.has(i.path)).sort((a, b) => a.created - b.created);
  if (!chosen.length) return;
  if (act === 'sel-clear') clearSelection();
  if (act === 'sel-fav') {
    const on = !chosen.every((i) => i.favorite);
    for (const i of chosen) await attempt(() => api.setFavorite(i.path, on), "Couldn't change favorites");
    await refreshLibrary();
  }
  if (act === 'sel-delete') {
    const ok = await confirmDialog({ title: `Delete ${chosen.length} video${chosen.length === 1 ? '' : 's'}?`, body: 'They will be moved to the Recycle Bin.', confirm: 'Delete', danger: true });
    if (!ok) return;
    state.selected.clear();
    trashLater(chosen.map((i) => i.path), `${chosen.length} video${chosen.length === 1 ? '' : 's'} deleted`);
  }
  if (act === 'sel-merge' && chosen.length >= 2) {
    const secs = chosen.reduce((a, i) => a + (i.duration || 0), 0);
    const ok = await confirmDialog({
      title: `Merge ${chosen.length} videos?`,
      body: `They're joined oldest first into one new ${fmtDuration(secs)} video. The originals stay as they are.`,
      confirm: 'Merge',
    });
    if (!ok) return;
    state.selected.clear();
    renderLibrary(false);
    toast(`Merging ${chosen.length} videos…`, 'saving');
    const made = await attempt(() => api.mergeVideos(chosen.map((i) => i.path)), "Couldn't merge");
    if (made) toast(`Saved "${made.name}"`, 'ok');
  }
}

$('#content').addEventListener('click', async (e) => {
  if (e.target.closest('[data-act="settings"]')) { navigate('settings'); return; }
  if (e.target.closest('[data-act="clear-search"]')) {
    state.filter.query = '';
    renderLibrary(true);
    const box = $('#search');
    if (box) box.focus();
    return;
  }
  const sel = e.target.closest('#selbar [data-act]');
  if (sel) { selectionAction(sel.dataset.act); return; }
  const mp = e.target.closest('.mp-page [data-act]');
  if (mp && state.mp) {
    e.stopPropagation();
    matchPageAction(mp, e);
    return;
  }
  const mv = e.target.closest('.mv-page [data-act]');
  if (mv && mod.matches) {
    if (!mv.matches('select, input')) { e.stopPropagation(); matchAction(mv, e); } // those act on change / input
    return;
  }
  const card = e.target.closest('.card');
  if (!card) return;
  const file = card.dataset.path;
  const act = e.target.closest('[data-act]');
  if (!act) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || state.selected.size) {
      toggleSelect(file, { range: e.shiftKey });
      return;
    }
    const item = state.items.find((i) => i.path === file);
    if (!item || item.type !== 'map' || !openMatchOf(item, { highlightMode: false })) openPlayer(file);
    return;
  }
  e.stopPropagation();
  if (act.dataset.act === 'select') toggleSelect(file, { range: e.shiftKey });
  if (act.dataset.act === 'fav') toggleFavorite(file);
  if (act.dataset.act === 'copy') copyFile(file);
  if (act.dataset.act === 'folder') api.showInFolder(file);
  if (act.dataset.act === 'delete') deleteVideo(file);
});

// ------------------------------------------------------------------ match page

// One League match on its own page (js/views/match.js): the header, then Watch, Scoreboard and
// Highlights. Watch plays the match on the game clock: the full recording where there is one, else
// each highlight's own video inside its range and the minimap between them, with the minimap as a
// picture-in-picture over the other videos. Highlight mode plays only the highlights of the kinds
// that are on and skips the time between them. Times here are game seconds unless named otherwise.
const MOMENT_LEAD = 4; // a moment plays from a few seconds before it
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// The match page for a library item that belongs to a match (its minimap, a highlight, the full
// recording). mapAt: a time on the minimap. Returns false when the item has no match.
function openMatchOf(item, { mapAt = null, ...opts } = {}) {
  const m = item && mod.group ? findMatch(mod.group.matchKeyOf(item)) : null;
  if (!m) return false;
  const clock = mod.group.mapClockOf ? mod.group.mapClockOf(m, item) : m.gameStart; // the item's own minimap part
  const at = finite(opts.at) ? opts.at : finite(mapAt) && finite(clock) ? mapAt + clock : null;
  openMatchPage(m.key, { ...opts, at });
  return true;
}

// tab: watch | scoreboard | highlights; at: where to start (default: the first highlight in
// Highlight mode, else the start of the recording); play: start playing.
function openMatchPage(key, { tab = 'watch', at = null, highlightMode = true, play = true } = {}) {
  const m = findMatch(key);
  if (!m) return;
  if (!mod.match || !finite(m.gameStart)) {
    // No match page (or no game clock, which needs the minimap): the player.
    if (m.full) openPlayer(m.full.path);
    else if (m.map) openPlayer(m.map.path);
    else if (m.clips.length) openPlayer(m.clips[0].path);
    return;
  }
  if (state.player) closePlayer();
  const listScroll = state.mp ? state.mp.listScroll : $('#content').scrollTop;
  if (state.mp) closeMatchPage({ back: false });
  const saved = pref('matchPage', {});
  const main = document.createElement('video');
  main.playsInline = true;
  main.preload = 'auto';
  main.volume = pref('volume', 1);
  main.muted = pref('muted', false);
  main.addEventListener('volumechange', () => { setPref('volume', main.volume); setPref('muted', main.muted); mpLive(); });
  // A file can be shorter than the library says (a recording cut short): its real end is used.
  main.addEventListener('loadedmetadata', () => {
    if (state.mp && state.mp.main === main && state.mp.src && finite(main.duration)) state.mp.cut.set(state.mp.src.item.path, state.mp.src.offset + main.duration);
  });
  main.addEventListener('click', () => mpToggle());
  main.addEventListener('dblclick', () => mpFullscreen());
  const map = document.createElement('video');
  map.muted = true;
  map.playsInline = true;
  map.preload = 'auto';
  const p = {
    key, tab, at: null, highlightMode, families: new Set(Array.isArray(saved.families) ? saved.families : mod.match.DEFAULT_FAMILIES),
    minimap: saved.minimap !== false, feed: saved.feed === 'all' ? 'all' : 'mine', record: null, main, map, src: null, playing: false, raf: 0, width: 840, sig: '', data: null,
    cut: new Map(), // file -> the game time its video really ends at
    listScroll, // the Matches list's scroll, for the way back
  };
  state.mp = p;
  const d = mpData(p, m);
  const playable = mod.match.playableRanges(d.ranges, p.families);
  if (!playable.length) p.highlightMode = false;
  let start = finite(at) ? at : null;
  if (start === null) start = p.highlightMode ? playable[0].from : d.span ? d.span.t0 : 0;
  state.view = 'match';
  closeMatchMenu();
  renderSidebar();
  mpSeek(start, { play: false });
  mpRender();
  $('#content').scrollTop = 0;
  if (play && p.tab === 'watch') mpPlay();
  p.raf = requestAnimationFrame(mpTick);
  p.resize = new ResizeObserver(() => mpFit());
  p.resize.observe($('#content'));
  mpLoadRecord(p, m);
  // Still waiting for match history (champions, kills, gold): ask now. It comes from the League
  // client, so this only fills in while the client is open; the page updates when it does.
  if (m.record && (m.record.pending || []).some((x) => x === 'history' || x === 'timeline') && api.refreshMatches) {
    api.refreshMatches().catch(() => {});
  }
}

function closeMatchPage({ back = true, expand = null, selecting = false } = {}) {
  const p = state.mp;
  if (!p) return;
  cancelAnimationFrame(p.raf);
  if (p.resize) p.resize.disconnect();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  mpRelease();
  p.main.remove();
  p.map.remove();
  state.mp = null;
  if (!back) return;
  if (expand) Object.assign(state.matchUi, { expandedKey: expand, selecting, family: 'all' });
  state.view = 'library';
  renderSidebar();
  renderLibrary(true);
  $('#content').scrollTop = p.listScroll || 0;
}

// Lets go of the video files (so they can be deleted or renamed); playing again loads them back.
function mpRelease() {
  const p = state.mp;
  if (!p) return;
  for (const v of [p.main, p.map]) {
    v.pause();
    v.removeAttribute('src');
    delete v.dataset.src;
    v.load();
  }
  p.src = null;
  p.playing = false;
}

// The match's record (stats for all 10, events, gold per minute), then its champions' icons.
async function mpLoadRecord(p, m) {
  const key = m.record && m.record.key;
  if (!key || !api.getMatch) return;
  p.recordAt = m.record.updatedAt; // reloaded when the record changes (refreshViews)
  let rec = null;
  try { rec = window.EventStyles.renameLegacy(await api.getMatch(key)); } catch { return; }
  if (!rec || state.mp !== p) return;
  p.record = rec;
  p.data = null;
  mpRender();
  const names = (rec.participants || []).map((x) => x && x.champion).filter(Boolean);
  if (!names.length || !api.championIcons) return;
  let icons = {};
  try { icons = (await api.championIcons(names)) || {}; } catch { return; }
  if (state.mp !== p) return;
  p.record = { ...rec, participants: rec.participants.map((x) => (x ? { ...x, icon: x.icon || icons[x.champion] || null } : x)) };
  p.data = null;
  mpRender();
}

// Moments, highlight ranges and the timeline's span, worked out once per match entry and record.
function mpData(p, m) {
  if (!p.data || p.data.m !== m) {
    const moments = mod.match.matchMoments(m, p.record);
    const ranges = mod.match.highlightRanges(m);
    p.data = { m, moments, ranges, span: mod.match.timelineSpan(m, moments, ranges), kills: mod.match.killFeed(p.record).kills };
  }
  return p.data;
}

function mpOpts(p) {
  const ui = state.matchUi;
  return {
    tab: p.tab, record: p.record, at: p.at, highlightMode: p.highlightMode, families: [...p.families], width: p.width,
    playing: p.playing, minimap: p.minimap, muted: p.main.muted, feed: p.feed, fullscreen: Boolean(document.fullscreenElement),
    family: ui.family, selecting: false, selected: state.selected, target: null, icons: gameIcon,
  };
}

// The video that covers game time t: the full recording, else a highlight, else the minimap.
//   -> { kind: 'full' | 'clip' | 'map', item, offset (the game time of its 0:00) } or null
function mpSourceAt(m, d, t) {
  const cut = state.mp ? state.mp.cut : new Map();
  const ends = (item, end) => Math.min(end, cut.has(item.path) ? cut.get(item.path) : Infinity);
  const full = m.full;
  if (full && full.url && full.map && finite(full.map.offset) && full.duration > 0) {
    const from = full.map.offset + m.gameStart;
    if (t >= from - 0.05 && t < ends(full, from + full.duration) - 0.05) return { kind: 'full', item: full, offset: from };
  }
  const r = d.ranges.find((x) => x.clip.url && t >= x.from - 0.05 && t < ends(x.clip, x.to) - 0.05);
  if (r) return { kind: 'clip', item: r.clip, offset: r.from };
  // The minimap part that covers t (a restart mid-match splits the minimap into several files).
  const part = mod.group.mapPartAt ? mod.group.mapPartAt(m, t) : m.map && { item: m.map, gameStart: m.gameStart };
  return part && part.item.url ? { kind: 'map', item: part.item, offset: part.gameStart } : null;
}

function mpSeek(t, { play = null } = {}) {
  const p = state.mp;
  const m = p && findMatch(p.key);
  if (!m || !finite(t)) return;
  const d = mpData(p, m);
  if (d.span) t = Math.min(d.span.t1, Math.max(d.span.t0, t));
  const src = mpSourceAt(m, d, t);
  const v = p.main;
  p.at = t;
  if (src) {
    if (!p.src || p.src.item.path !== src.item.path) RangeVideo.load(v, src.item); // a virtual clip: its range
    p.src = src;
    const vt = Math.max(0, t - src.offset);
    if (Math.abs((v.currentTime || 0) - vt) > 0.04) v.currentTime = vt;
    if (!v.isConnected) mpMountVideos();
  }
  p.playing = Boolean(src) && (play === null ? p.playing : play);
  if (p.playing) v.play().catch(() => {});
  else if (!v.paused) v.pause();
  mpSyncMap(true);
  mpLive();
}

function mpPause() {
  const p = state.mp;
  if (!p) return;
  p.playing = false;
  p.main.pause();
  mpSyncMap();
  mpLive();
}

// Play from the playhead; in Highlight mode from the highlight it's in, else the next one; at the
// end, from the start.
function mpPlay() {
  const p = state.mp;
  const m = p && findMatch(p.key);
  if (!m) return;
  const d = mpData(p, m);
  let t = finite(p.at) && !(d.span && p.at >= d.span.t1 - 0.5) ? p.at : null;
  if (p.highlightMode) {
    const list = mod.match.playableRanges(d.ranges, p.families);
    if (list.length && (t === null || !list.some((r) => t >= r.from - 0.3 && t < r.to))) t = ((t !== null && list.find((r) => r.from > t)) || list[0]).from;
  }
  mpSeek(t === null ? (d.span ? d.span.t0 : 0) : t, { play: true });
}

const mpToggle = () => (state.mp && state.mp.playing ? mpPause() : mpPlay());

// Previous / next: the highlights in Highlight mode, else the moments, or every kill when the list
// shows All kills (from just before each).
function mpStep(dir) {
  const p = state.mp;
  const m = p && findMatch(p.key);
  if (!m) return;
  const d = mpData(p, m);
  const t0 = d.span ? d.span.t0 : 0;
  const points = (p.highlightMode
    ? mod.match.playableRanges(d.ranges, p.families).map((r) => r.from)
    : (p.feed === 'all' && d.kills.length ? d.kills : d.moments.filter((x) => x.family !== 'result' && x.type !== 'multikill' && x.type !== 'ace'))
      .map((x) => Math.max(t0, x.t - MOMENT_LEAD)))
    .sort((a, b) => a - b);
  const at = finite(p.at) ? p.at : t0;
  const target = dir > 0 ? points.find((t) => t > at + 0.5) : [...points].reverse().find((t) => t < at - 1.5);
  if (target !== undefined) mpSeek(target, { play: true });
}

// A moment or timeline marker: play it from just before. A moment that Highlight mode skips turns
// Highlight mode off, so it actually plays.
function mpSeekMoment(t) {
  const p = state.mp;
  const m = p && findMatch(p.key);
  if (!m || !finite(t)) return;
  const d = mpData(p, m);
  let from = t - MOMENT_LEAD;
  if (p.highlightMode) {
    const r = mod.match.playableRanges(d.ranges, p.families).find((x) => t >= x.from - 0.3 && t <= x.to);
    if (r) from = Math.max(r.from, from);
    else { p.highlightMode = false; mpRender(); }
  }
  mpSeek(from, { play: true });
}

function mpSetHighlightMode(on) {
  const p = state.mp;
  const m = p && findMatch(p.key);
  if (!m) return;
  p.highlightMode = on && mod.match.playableRanges(mpData(p, m).ranges, p.families).length > 0;
  mpRender();
  if (p.highlightMode && p.playing) mpPlay(); // into the highlight at (or after) the playhead
}

function mpSavePrefs() {
  const p = state.mp;
  if (p) setPref('matchPage', { families: [...p.families], minimap: p.minimap, feed: p.feed });
}

// Save a clip here: the player (trim, export, keyboard) on the video at the playhead.
function mpClip() {
  const p = state.mp;
  if (!p || !p.src) return;
  const at = Math.max(0, p.at - p.src.offset);
  const file = p.src.item.path;
  mpPause();
  openPlayer(file, at);
}

function mpFullscreen() {
  const done = () => { mpRefresh(); requestAnimationFrame(mpFit); };
  if (document.fullscreenElement) { document.exitFullscreen().then(done, () => {}); return; }
  // The video with its timeline and controls: in full screen they sit above the controls (match.css).
  const player = $('#content .mp-page .mp-player');
  if (player) player.requestFullscreen().then(done, () => {});
}

// Puts the page's videos into the freshly rendered stage and picture-in-picture slot.
function mpMountVideos() {
  const p = state.mp;
  const root = $('#content .mp-page');
  if (!p || !root) return;
  const stage = root.querySelector('.mp-stage[data-slot="video"]');
  if (stage && p.src) {
    const poster = stage.querySelector('.mp-poster');
    if (poster) poster.remove();
    stage.prepend(p.main);
  }
  const pip = root.querySelector('[data-slot="minimap"]');
  if (pip) {
    const img = pip.querySelector('img');
    if (img) img.remove();
    pip.append(p.map);
  }
  mpSyncMap(true);
}

// The minimap picture-in-picture follows the main video (hidden while the main video is the minimap).
function mpSyncMap(force = false) {
  const p = state.mp;
  const m = p && findMatch(p.key);
  if (!m) return;
  const pip = $('#content .mp-page [data-slot="minimap"]');
  const part = mod.group.mapPartAt ? mod.group.mapPartAt(m, p.at) : m.map && { item: m.map, gameStart: m.gameStart };
  const show = Boolean(pip && p.minimap && part && part.item.url && p.src && p.src.kind !== 'map');
  if (pip) pip.style.display = show ? '' : 'none';
  const v = p.map;
  if (!show) { if (!v.paused) v.pause(); return; }
  if (v.dataset.src !== part.item.url) { v.src = part.item.url; v.dataset.src = part.item.url; force = true; }
  const want = Math.max(0, p.at - part.gameStart);
  if (force || Math.abs(v.currentTime - want) > 0.5) v.currentTime = want;
  if (v.playbackRate !== p.main.playbackRate) v.playbackRate = p.main.playbackRate;
  if (p.playing && v.paused) v.play().catch(() => {});
  else if (!p.playing && !v.paused) v.pause();
}

function mpTick() {
  const p = state.mp;
  if (!p) return;
  p.raf = requestAnimationFrame(mpTick);
  if (p.tab !== 'watch' || !p.src || p.scrubbing) return;
  const v = p.main;
  if (v.seeking || v.readyState < 2) return;
  const m = findMatch(p.key);
  if (!m) return;
  const d = mpData(p, m);
  const t = p.src.offset + v.currentTime;
  if (p.playing) {
    const list = p.highlightMode ? mod.match.playableRanges(d.ranges, p.families) : null;
    // Highlight mode, outside the highlights: on to the next one (or stop after the last).
    const onward = (at) => {
      if (!list || list.some((r) => at >= r.from - 0.3 && at < r.to)) return false;
      const next = list.find((r) => r.from > at - 0.3);
      if (next) mpSeek(next.from, { play: true });
      else mpSeek(at, { play: false });
      return true;
    };
    if (onward(t)) return;
    const want = mpSourceAt(m, d, t);
    if (v.ended || !want || want.item.path !== p.src.item.path) {
      // This video is over, or another one covers this time: carry on from where this one ends
      // (mpSourceAt knows each loaded file's real end, so this never lands on the same video).
      const end = v.ended ? Math.max(t, p.src.offset + (v.duration || 0)) + 0.05 : t;
      // In Highlight mode a highlight's own video ending ends that highlight, unless another video
      // (the full recording, an overlapping highlight) carries on; never the minimap for the rest.
      const then = v.ended && list && p.src.kind === 'clip' ? mpSourceAt(m, d, end) : null;
      if (v.ended && list && p.src.kind === 'clip' && (!then || then.kind === 'map')) {
        const next = list.find((r) => r.from > p.src.offset + 0.3);
        if (next) mpSeek(next.from, { play: true });
        else mpSeek(end, { play: false });
        return;
      }
      if (onward(end)) return;
      const last = d.span ? d.span.t1 - 0.05 : Infinity;
      mpSeek(Math.min(end, last), { play: end < last });
      return;
    }
  }
  p.at = t;
  mpSyncMap();
  mpLive();
}

// Moves the playhead and the time (cheap, every frame); when the current moment or highlight, the
// play state or the sound changes, re-renders the parts that show them.
function mpLive() {
  const p = state.mp;
  const m = p && findMatch(p.key);
  const root = $('#content .mp-page');
  if (!m || !root || p.tab !== 'watch') return;
  const d = mpData(p, m);
  if (d.span && finite(p.at)) {
    const pos = `${(Math.max(0, Math.min(1, (p.at - d.span.t0) / (d.span.t1 - d.span.t0))) * 100).toFixed(3)}%`;
    const played = root.querySelector('.mp-played');
    if (played) played.style.width = pos;
    for (const el of root.querySelectorAll('.mp-playhead, .mp-knob')) el.style.left = pos;
    const time = root.querySelector('.mp-time');
    if (time && time.firstChild && time.firstChild.nodeType === Node.TEXT_NODE) time.firstChild.textContent = mod.match.fmtGame(p.at);
    const track = root.querySelector('.mp-tl-track');
    if (track) {
      track.setAttribute('aria-valuenow', String(Math.round(p.at * 10) / 10));
      track.setAttribute('aria-valuetext', mod.match.fmtGame(p.at));
    }
  }
  const sig = mpSig(p, m);
  if (sig !== p.sig) {
    p.sig = sig;
    mpRefresh();
  }
}

function mpSig(p, m) {
  const d = mpData(p, m);
  const at = p.at;
  const range = finite(at) ? d.ranges.findIndex((r) => at >= r.from && at <= r.to) : -1;
  const cur = p.feed === 'all' && d.kills.length ? mod.match.feedIndex(d.kills, at) : mod.match.currentIndex(d.moments, at);
  return `${cur}|${range}|${p.playing}|${p.main.muted}`;
}

// The focused control, as a selector that finds it again after a render.
function mpFocusSel() {
  const el = document.activeElement;
  if (!el || !$('#content').contains(el) || !el.dataset || !el.dataset.act) return null;
  let sel = `[data-act="${CSS.escape(el.dataset.act)}"]`;
  for (const k of ['tab', 'family', 'at', 'path']) if (el.dataset[k] != null) sel += `[data-${k}="${CSS.escape(el.dataset[k])}"]`;
  return sel;
}

function mpFocus(sel) {
  const el = sel && $('#content').querySelector(sel);
  if (el) el.focus({ preventScroll: true });
}

// The whole page. In full screen only the parts around the stage (a new stage would end it).
function mpRender() {
  const p = state.mp;
  const m = p && findMatch(p.key);
  if (!m) return;
  const content = $('#content');
  if (document.fullscreenElement && content.contains(document.fullscreenElement)) { mpRefresh(); return; }
  const list = content.querySelector('.mp-ml');
  const keep = { page: content.scrollTop, list: list ? list.scrollTop : null };
  const focused = mpFocusSel();
  content.innerHTML = mod.match.renderMatchPage(m, mpOpts(p));
  mpMountVideos();
  content.scrollTop = keep.page;
  const list2 = content.querySelector('.mp-ml');
  if (list2 && keep.list !== null) list2.scrollTop = keep.list;
  mpFocus(focused);
  p.sig = mpSig(p, m);
  mpLive();
  mpFit();
}

// Re-renders the Watch tab's moving parts in place (timeline, controls, Highlight mode, moments,
// the "now" chip), leaving the stage and its videos (and full screen) alone.
function mpRefresh() {
  const p = state.mp;
  const m = p && findMatch(p.key);
  const root = $('#content .mp-page');
  if (!m || !root || p.tab !== 'watch') return;
  const tpl = document.createElement('template');
  tpl.innerHTML = mod.match.renderWatch(m, mpOpts(p));
  const fresh = tpl.content;
  const focused = mpFocusSel();
  for (const sel of ['.mp-tl', '.mp-controls', '.mp-hm', '.mp-ml-head']) {
    const a = root.querySelector(sel);
    const b = fresh.querySelector(sel);
    if (a && b) a.replaceWith(b);
  }
  const list = root.querySelector('.mp-ml');
  const list2 = fresh.querySelector('.mp-ml');
  if (list && list2) {
    const top = list.scrollTop;
    list.replaceChildren(...list2.childNodes);
    list.scrollTop = top;
    const cur = p.playing && list.querySelector('.mp-cur');
    if (cur) {
      // Keep the current moment in view while playing (scrolling only the list).
      const lr = list.getBoundingClientRect();
      const cr = cur.getBoundingClientRect();
      if (cr.top < lr.top || cr.bottom > lr.bottom) list.scrollTop += cr.top - lr.top - (lr.height - cr.height) / 2;
    }
  }
  const stage = root.querySelector('.mp-stage');
  if (stage) {
    const old = stage.querySelector('.mp-now');
    if (old) old.remove();
    const chip = fresh.querySelector('.mp-now');
    if (chip) stage.append(chip);
  }
  mpFocus(focused);
}

// The timeline groups its markers by its width in px: measured, and re-rendered when it changes.
function mpFit() {
  const p = state.mp;
  const track = p && $('#content .mp-page .mp-tl-track');
  if (!track) return;
  const w = Math.round(track.getBoundingClientRect().width);
  if (w > 0 && Math.abs(w - p.width) > 8) {
    p.width = w;
    mpRefresh();
  }
}

async function matchPageAction(el, e) {
  const p = state.mp;
  const m = p && findMatch(p.key);
  if (!m) { closeMatchPage(); return; }
  const act = el.dataset.act;
  switch (act) {
    case 'match-back': closeMatchPage(); return;
    case 'match-tab':
      p.tab = ['watch', 'scoreboard', 'highlights'].includes(el.dataset.tab) ? el.dataset.tab : 'watch';
      if (p.tab !== 'watch') mpPause();
      mpRender();
      return;
    case 'match-seek': mpSeekMoment(Number(el.dataset.at)); return;
    case 'match-scrub': return; // pointer down on the track does it
    case 'match-play': mpToggle(); return;
    case 'match-prev': mpStep(-1); return;
    case 'match-next': mpStep(1); return;
    case 'match-highlight-mode': mpSetHighlightMode(el.dataset.on === 'true'); return;
    case 'match-family-toggle': {
      const f = el.dataset.family;
      if (!f) return;
      if (p.families.has(f)) p.families.delete(f); else p.families.add(f);
      mpSavePrefs();
      if (!mod.match.playableRanges(mpData(p, m).ranges, p.families).length) p.highlightMode = false;
      mpRender();
      return;
    }
    case 'match-clip': mpClip(); return;
    case 'match-minimap': p.minimap = el.dataset.on === 'true'; mpSavePrefs(); mpRender(); return;
    case 'match-feed': {
      const feed = el.dataset.feed === 'all' ? 'all' : 'mine';
      if (feed === p.feed) return;
      p.feed = feed;
      mpSavePrefs();
      mpRefresh();
      const list = $('#content .mp-page .mp-ml');
      if (list) list.scrollTop = 0;
      return;
    }
    case 'match-fullscreen': mpFullscreen(); return;
    case 'match-mute': p.main.muted = !p.main.muted; return;
    case 'match-make-video': makeMatchVideo(m); return;
    case 'match-menu': openMatchMenu(mod.matches.renderMatchMenu(m), el.getBoundingClientRect()); return;
    case 'match-select': closeMatchPage({ expand: m.key, selecting: true }); return; // selecting is the list's job
    case 'match-family': state.matchUi.family = el.dataset.family || 'all'; mpRender(); return;
    default: matchAction(el, e); // the Highlights tab's tiles mean what they mean in the list
  }
}

// Scrubbing the timeline: press and drag along the track.
$('#content').addEventListener('pointerdown', (e) => {
  const track = e.target.closest('.mp-page .mp-tl-track');
  const p = state.mp;
  if (!track || !p || e.button !== 0) return;
  e.preventDefault();
  track.focus({ preventScroll: true });
  const from = Number(track.dataset.from);
  const to = Number(track.dataset.to);
  const box = track.getBoundingClientRect(); // the track is re-rendered while dragging; its place isn't
  const at = (ev) => from + Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width)) * (to - from);
  const wasPlaying = p.playing;
  p.scrubbing = true;
  mpSeek(at(e), { play: false });
  const move = (ev) => { if (state.mp === p) mpSeek(at(ev), { play: false }); };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (state.mp !== p) return;
    p.scrubbing = false;
    mpSeek(at(ev), { play: wasPlaying });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// Keys on the match page: Space/K play, ←/→ 5 s, J/L 10 s, N/P next/previous, H Highlight mode,
// F full screen, M mute, ↑/↓ volume, Esc back to the list.
function matchPageKey(e, key) {
  const p = state.mp;
  if (key === 'escape') { if (!document.fullscreenElement) closeMatchPage(); return; }
  if (p.tab !== 'watch' || e.ctrlKey || e.metaKey || e.altKey) return;
  const v = p.main;
  if (key === ' ' || key === 'k') { e.preventDefault(); mpToggle(); }
  else if (key === 'arrowleft' || key === 'j') { e.preventDefault(); mpSeek(p.at - (key === 'j' ? 10 : 5)); }
  else if (key === 'arrowright' || key === 'l') { e.preventDefault(); mpSeek(p.at + (key === 'l' ? 10 : 5)); }
  else if (key === 'n') mpStep(1);
  else if (key === 'p') mpStep(-1);
  else if (key === 'h') mpSetHighlightMode(!p.highlightMode);
  else if (key === 'f') mpFullscreen();
  else if (key === 'm') v.muted = !v.muted;
  else if (key === 'arrowup' || key === 'arrowdown') {
    e.preventDefault();
    v.muted = false;
    v.volume = Math.max(0, Math.min(1, Math.round((v.volume + (key === 'arrowup' ? 0.05 : -0.05)) * 100) / 100));
  }
}

// ---- Matches view actions (data-act names from js/views/matches.js ACTIONS)
const defaultMatchFilter = () => ({ mode: '', result: '', champion: '', query: '', sort: 'newest' });
const findItem = (file) => state.items.find((i) => i.path === file) || null;
// A clip whose only moments are your deaths; highlight videos leave these out.
const deathOnly = (i) => (i.markers || []).length > 0 && i.markers.every((m) => m.type === 'death');

async function matchAction(el, e) {
  const act = el.dataset.act;
  const ui = state.matchUi;
  const m = el.dataset.key ? findMatch(el.dataset.key) : null;
  const file = el.dataset.path || null;
  const anchor = state.menu ? state.menu.anchor : el;
  closeMatchMenu();
  if (act.startsWith('match-') && !m) return;
  switch (act) {
    case 'match-toggle':
      ui.expandedKey = ui.expandedKey === m.key ? null : m.key;
      ui.family = 'all';
      ui.selecting = false;
      renderLibrary(false);
      return;
    case 'match-play': openMatchPage(m.key, { highlightMode: false }); return;
    case 'match-highlights': openMatchPage(m.key, { highlightMode: true }); return;
    case 'match-menu': openMatchMenu(mod.matches.renderMatchMenu(m), el.getBoundingClientRect()); return;
    case 'match-family': ui.family = el.dataset.family || 'all'; renderLibrary(false); return;
    case 'match-select':
      ui.selecting = !ui.selecting;
      if (!ui.selecting) state.selected.clear();
      renderLibrary(false);
      return;
    case 'match-make-video': makeMatchVideo(m); return;
    case 'match-folder': api.showInFolder((m.map || m.full || m.files[0]).path); return;
    case 'match-favorite': setMatchFavorite(m, el.dataset.on === 'true'); return;
    case 'match-delete-full': deleteFullRecording(m); return;
    case 'match-delete': deleteMatch(m); return;
    case 'clip-play':
      if (state.mp) mpPause();
      if (ui.selecting || e.ctrlKey || e.metaKey || e.shiftKey) toggleSelect(file, { range: e.shiftKey });
      else openPlayer(file);
      return;
    case 'clip-select': toggleSelect(file, { range: e.shiftKey }); return;
    case 'clip-play-in-match': {
      const item = findItem(file);
      if (item && item.map) openMatchOf(item, { mapAt: item.map.offset, highlightMode: false });
      return;
    }
    case 'clip-copy': copyFile(file); return;
    case 'clip-share': { const item = findItem(file); if (item) shareFlow(item, anchor); return; }
    case 'clip-favorite': toggleFavorite(file); return;
    case 'clip-folder': api.showInFolder(file); return;
    case 'clip-delete': deleteVideo(file); return;
    case 'filter-mode': ui.filter.mode = el.dataset.mode || ''; renderLibrary(false); return;
    case 'filter-clear': ui.filter = defaultMatchFilter(); renderLibrary(true); return;
    default:
  }
}

$('#content').addEventListener('change', (e) => {
  const el = e.target.closest('.mv-page select[data-act]');
  if (!el) return;
  const key = { 'filter-result': 'result', 'filter-champion': 'champion', 'filter-sort': 'sort' }[el.dataset.act];
  if (key) { state.matchUi.filter[key] = el.value; renderLibrary(false); }
});

$('#content').addEventListener('input', (e) => {
  const el = e.target.closest('.mv-page input[data-act="filter-query"]');
  if (el) { state.matchUi.filter.query = el.value; renderLibrary(false); }
});

// Right-click: a clip's menu on a highlight tile, the match's menu on its row.
// Right-click: a clip's menu on any clip (match tiles, the Clips and Favorites grids), the match's
// menu on a match row.
$('#content').addEventListener('contextmenu', (e) => {
  if (!mod.matches) return;
  const tile = e.target.closest('.mv-page [data-path], .mp-highlights [data-path], .card[data-path]');
  const row = e.target.closest('.mv-page [data-key]');
  if (!tile && !row) return;
  e.preventDefault();
  const at = { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, width: 0, height: 0 };
  const item = tile ? findItem(tile.dataset.path) : null;
  const m = row ? findMatch(row.dataset.key) : item && mod.group ? findMatch(mod.group.matchKeyOf(item)) : null;
  if (item) openMatchMenu(mod.matches.renderClipMenu(item, { match: m }), at, true);
  else if (m) openMatchMenu(mod.matches.renderMatchMenu(m), at, true);
});

// One menu at a time, in a fixed layer kept on screen by placeMenu (below/right, flipped near edges).
function openMatchMenu(html, rect, atPointer = false) {
  closeMatchMenu();
  const layer = document.createElement('div');
  layer.className = 'mv-menu-layer';
  layer.innerHTML = html;
  document.body.appendChild(layer);
  const menu = layer.firstElementChild;
  const { left, top } = mod.matches.placeMenu({
    x: atPointer ? rect.left : rect.right - menu.offsetWidth, y: atPointer ? rect.top : rect.bottom + 4,
    width: menu.offsetWidth, height: menu.offsetHeight, viewWidth: window.innerWidth, viewHeight: window.innerHeight,
  });
  layer.style.left = `${left}px`;
  layer.style.top = `${top}px`;
  const anchor = { getBoundingClientRect: () => rect };
  const outside = (ev) => { if (!layer.contains(ev.target)) closeMatchMenu(); };
  // Keys: ↑/↓/Home/End move, Enter picks, Esc closes, and the shortcut shown on an item ("Del",
  // "Ctrl C", "F") picks that item.
  const items = () => [...menu.querySelectorAll('[role="menuitem"]:not([disabled])')];
  const shortcut = (b) => {
    const parts = ((b.querySelector('.mv-sc') || {}).textContent || '').trim().split(/\s+/);
    const k = (parts.pop() || '').toLowerCase();
    return { key: { del: 'delete' }[k] || k, ctrl: parts.includes('Ctrl'), shift: parts.includes('Shift') };
  };
  const onKey = (ev) => {
    const stop = () => { ev.preventDefault(); ev.stopPropagation(); };
    if (ev.key === 'Escape') { stop(); closeMatchMenu(); return; }
    const list = items();
    const i = list.indexOf(document.activeElement);
    const go = { ArrowDown: i < 0 ? 0 : (i + 1) % list.length, ArrowUp: i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length, Home: 0, End: list.length - 1 }[ev.key];
    if (go !== undefined) { stop(); if (list[go]) list[go].focus(); return; }
    const k = ev.key.toLowerCase();
    if (k === 'enter' || k === ' ' || k === 'tab') return; // the focused item's own click; Tab leaves
    const hit = list.find((b) => { const s = shortcut(b); return s.key === k && s.ctrl === (ev.ctrlKey || ev.metaKey) && s.shift === ev.shiftKey; });
    if (hit) { stop(); hit.click(); }
  };
  layer.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (b && !b.disabled) matchAction(b, ev);
  });
  state.menu = { layer, anchor, outside, onKey };
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
  });
  const first = menu.querySelector('button:not([disabled])');
  if (first) first.focus();
}

function closeMatchMenu() {
  const s = state.menu;
  if (!s) return;
  state.menu = null;
  document.removeEventListener('pointerdown', s.outside, true);
  document.removeEventListener('keydown', s.onKey, true);
  s.layer.remove();
}

async function setMatchFavorite(m, on) {
  for (const f of m.files) await attempt(() => api.setFavorite(f.path, on), "Couldn't change favorites");
  await refreshLibrary();
  toast(on ? 'Match added to favorites. The storage limit never removes it' : 'Match removed from favorites', 'ok');
}

// Highlights that play from a full recording (virtual clips) go with it, except favorites and the
// best ones, which are saved as files first.
function virtualNote(m) {
  const n = m.clips.filter((c) => c.virtual).length;
  return n ? ` The minimap and the match stay, and so do highlights saved as files. ${n} highlight${n === 1 ? ' plays' : 's play'} from this recording: favorites and the best moments are saved as files first; the rest go with it.` : '';
}

async function deleteFullRecording(m) {
  if (!m.full) return;
  const ok = await confirmDialog({
    title: 'Delete the full recording?',
    body: `Moves the full recording (${fmtSize(m.full.size)}) to the Recycle Bin.${virtualNote(m) || ' The highlights, the minimap and the match stay.'}`,
    confirm: 'Delete recording',
    danger: true,
  });
  if (!ok) return;
  trashLater([m.full.path], `Full recording deleted (${fmtSize(m.full.size)})`);
}

async function deleteMatch(m) {
  const files = m.files.filter((f) => !f.favorite);
  const kept = m.files.length - files.length;
  if (!files.length) { toast('Every file of this match is a favorite. Remove it from favorites first', 'info'); return; }
  const size = (list) => list.reduce((s, f) => s + (f.size || 0), 0);
  const highlights = files.filter((f) => f.type === 'highlight');
  const others = files.filter((f) => f.type !== 'highlight' && f !== m.full && f !== m.map);
  // A guessed group (no minimap link) lists every file; a linked match lists what's in it.
  const list = m.inferred
    ? files.map((f) => `${displayTitle(f)} · ${fmtSize(f.size)}`)
    : [
      files.includes(m.full) ? `Full match · ${fmtSize(m.full.size)}` : '',
      files.includes(m.map) ? `Minimap · ${fmtSize(m.map.size)}` : '',
      highlights.length ? `${highlights.length} highlight${highlights.length === 1 ? '' : 's'} · ${fmtSize(size(highlights))}` : '',
      others.length ? `${others.length} other video${others.length === 1 ? '' : 's'} · ${fmtSize(size(others))}` : '',
    ].filter(Boolean);
  const ok = await confirmDialog({
    title: `Delete this ${m.champion ? `${m.champion} ` : ''}match?`,
    body: `Moves ${files.length} file${files.length === 1 ? '' : 's'} (${fmtSize(size(files))}) to the Recycle Bin.${kept ? ` ${kept} favorite${kept === 1 ? ' is' : 's are'} kept.` : ''}`,
    confirm: 'Delete match',
    danger: true,
    list,
  });
  if (!ok) return;
  if (state.matchUi.expandedKey === m.key) state.matchUi.expandedKey = null;
  trashLater(files.map((f) => f.path), `${m.champion ? `${m.champion} match` : 'Match'} deleted · ${files.length} file${files.length === 1 ? '' : 's'}`);
}

// Highlight video of a match: its highlights joined in game order, overlapping footage once,
// clips that only show your deaths left out.
async function makeMatchVideo(m) {
  if (!m.map) return;
  const clips = m.clips.filter((c) => !deathOnly(c) && c.map);
  const skipped = m.clips.length - clips.length;
  if (!clips.length) { toast('This match has no highlights besides deaths', 'info'); return; }
  let total = 0;
  let end = -Infinity;
  for (const c of [...clips].sort((a, b) => a.map.offset - b.map.offset)) {
    const s = c.map.offset;
    const t = c.map.offset + (c.duration || 0);
    total += Math.max(0, t - Math.max(s, end));
    end = Math.max(end, t);
  }
  const ok = await confirmDialog({
    title: 'Make a highlight video?',
    body: `Joins ${clips.length} highlight${clips.length === 1 ? '' : 's'} into one ${fmtDuration(total)} video, with overlapping moments shown once${skipped ? ` (${skipped} death${skipped === 1 ? '' : 's'} left out)` : ''}. It takes a minute or two; you can keep using ClipVault meanwhile.`,
    confirm: 'Make video',
  });
  if (!ok) return;
  toast('Making the highlight video…', 'saving');
  const made = await attempt(() => api.makeHighlightVideo(m.map.path), "Couldn't make the highlight video");
  if (made) toast(`Saved "${displayTitle(made)}" (${fmtDuration(made.duration)}). It's in the match`, 'ok');
}

async function toggleFavorite(file) {
  const item = state.items.find((i) => i.path === file);
  if (!item) return;
  const on = !item.favorite;
  const done = await attempt(() => api.setFavorite(file, on).then(() => true), "Couldn't change favorites");
  if (!done) return;
  state.items = state.items.map((i) => (i.path === file ? { ...i, favorite: on } : i));
  if (state.player && state.player.item.path === file) {
    state.player.item = { ...state.player.item, favorite: on };
    updateFavButton();
  }
  refreshViews();
  toast(on ? 'Added to favorites' : 'Removed from favorites', 'ok');
}

$('#content').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  api.startDrag(card.dataset.path);
});

async function copyFile(file) {
  const r = await attempt(() => api.copyFile(file).then(() => true), "Couldn't copy");
  if (r) toast('Copied. Paste it into Discord, a chat or a folder', 'ok');
}

// One video: gone at once, with Undo (it reaches the Recycle Bin a few seconds later).
function deleteVideo(file) {
  const item = state.items.find((i) => i.path === file);
  if (!item) return;
  trashLater([file], `Deleted “${displayTitle(item)}”`);
}

async function refreshLibrary() {
  const [items, rows] = await Promise.all([listItems(), listMatchRows()]);
  state.items = state.hidden.size ? items.filter((i) => !state.hidden.has(i.path)) : items;
  state.matchRows = rows;
  refreshViews();
  if (state.player) {
    const fresh = state.items.find((i) => i.path === state.player.item.path);
    if (fresh) state.player.item = fresh;
  }
}

function refreshViews() {
  renderSidebar();
  if (state.view === 'library') renderLibrary(false);
  else if (state.view === 'match' && state.mp) {
    const m = findMatch(state.mp.key);
    if (!m) { closeMatchPage(); return; } // it was deleted
    mpRender();
    if (m.record && m.record.updatedAt !== state.mp.recordAt) mpLoadRecord(state.mp, m); // new stats arrived
  }
}

// ------------------------------------------------------------------ player

// startAt: seconds to start from (used when jumping from a clip to its match minimap).
function openPlayer(file, startAt = 0) {
  const item = state.items.find((i) => i.path === file);
  if (!item) return;
  if (state.player) closePlayer({ switching: true }); // the next / previous video: full screen stays
  state.player = { item, start: 0, end: item.duration || 0, duration: item.duration || 0 };
  const el = $('#player');
  const res = item.height ? `${item.height}p${item.fps > 50 ? Math.round(item.fps) : ''}` : '';
  const markers = item.markers || [];
  const codec = item.codec === 'hevc' ? 'H.265' : '';
  const [prevItem, nextItem] = [neighbourVideo(-1), neighbourVideo(1)];
  el.innerHTML = `
    <header class="player-head">
      <button class="icon-btn" data-act="close" title="Back to library (Esc)">${I.back}</button>
      <input class="title-input" id="titleInput" value="${esc(item.name)}" spellcheck="false" title="Click to rename">
      <button class="icon-btn fav-btn" data-act="fav" id="favBtn"></button>
      <span class="chip">${esc(item.game)}</span>
      <span class="meta">${esc([fmtDate(item.created), res, codec, item.virtual ? 'plays from the full recording' : fmtSize(item.size)].filter(Boolean).join(' · '))}</span>
      <span class="spacer"></span>
      ${item.inputs ? `<button class="btn sm kb-head-btn" data-act="kb-overlay" id="kbOverlayHeadBtn" title="Show the keyboard and mouse as a faded overlay on the video that you can drag and resize">${I.keyboard}<span class="lbl">Keyboard on video</span></button>` : ''}
      ${item.map ? `<button class="btn sm" data-act="open-map" title="The match at this moment: every highlight, the scoreboard">${I.reel}<span class="lbl">Open match</span></button>` : ''}
      <span class="drag-chip" id="dragChip" draggable="true" title="Drag this into Discord, a browser or a folder">${I.drag}<span class="lbl">Drag to share</span></span>
      <div class="nav-videos">
        <button class="icon-btn" data-act="prev-video" ${prevItem ? '' : 'disabled'} title="Previous video (P)${prevItem ? `: ${esc(prevItem.name)}` : ''}">${I.skipPrev}</button>
        <button class="icon-btn" data-act="next-video" ${nextItem ? '' : 'disabled'} title="Next video (N)${nextItem ? `: ${esc(nextItem.name)}` : ''}">${I.skipNext}</button>
        <button class="autoplay ${pref('autoplay', false) ? 'on' : ''}" data-act="autoplay" title="Play the next video when this one ends">Autoplay</button>
      </div>
      <button class="icon-btn" data-act="help" title="Keyboard shortcuts (?)">${I.help}</button>
      <button class="icon-btn" data-act="close" title="Close">${I.close}</button>
    </header>
    <div class="player-main">
      <div class="stage" id="stage"><video id="video" autoplay></video>${item.inputs ? overlayHtml({ rail: true }) : ''}
        <div class="vc" id="vc">
          <div class="vc-scrub" id="scrub" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0">
            <div class="vc-rail"><div class="vc-trim" id="scrubTrim"></div><div class="vc-hover" id="scrubHover"></div><div class="vc-fill" id="scrubFill"></div><div class="vc-ticks" id="scrubTicks"></div></div>
            <div class="vc-knob" id="scrubKnob"></div>
            <div class="vc-tip" id="scrubTip"></div>
          </div>
          <div class="vc-row">
            <button class="vc-btn" data-act="play" id="playBtn" title="Play (Space)">${spriteIcon('play')}</button>
            <button class="vc-btn" data-act="back5" title="Back 5 seconds (←)">${spriteIcon('rotate-ccw')}</button>
            <button class="vc-btn" data-act="fwd5" title="Forward 5 seconds (→)">${spriteIcon('rotate-cw')}</button>
            <div class="vc-vol">
              <button class="vc-btn" data-act="mute" id="muteBtn" title="Mute (M)">${spriteIcon('volume-2')}</button>
              <input type="range" class="vc-slider" id="volSlider" min="0" max="1" step="0.05" title="Volume (↑ ↓)" aria-label="Volume">
            </div>
            <span class="vc-time" id="timeReadout">0:00</span>
            <span class="spacer"></span>
            <button class="vc-btn" data-act="frame-back" title="Previous frame (,)">${spriteIcon('step-back')}</button>
            <button class="vc-btn" data-act="frame-next" title="Next frame (.)">${spriteIcon('step-forward')}</button>
            <select class="vc-select" id="trackSel" title="Which sound to hear" hidden></select>
            <select class="vc-select" id="speedSel" title="Playback speed (&lt; and &gt;)">${SPEEDS.map((s) => opt(s, s === 1 ? 'Normal' : `${s}×`, 1)).join('')}</select>
            <button class="vc-btn" data-act="fullscreen" id="fsBtn" title="Full screen (F)">${spriteIcon('maximize')}</button>
          </div>
        </div>
      </div>
      ${item.inputs || item.map ? `<aside class="player-rail" aria-label="Minimap and inputs">${reviewPanelHtml(item, { overlay: false })}</aside>` : ''}
    </div>
    <section class="editbar">
      <div id="momentsBox">${momentsHtml(markers)}</div>
      <div class="timeline${markers.length ? ' has-markers' : ''}" id="timeline">
        <div class="tl-track"></div>
        <div class="tl-ruler" id="tlRuler" aria-hidden="true"></div>
        <div class="tl-dim" id="dimL"></div><div class="tl-dim" id="dimR"></div>
        <div class="tl-sel" id="tlSel"></div>
        <div id="tlMarkers"></div>
        <div class="tl-handle" data-h="start" title="Drag to set the start"></div>
        <div class="tl-handle" data-h="end" title="Drag to set the end"></div>
        <div class="tl-playhead" id="playhead"></div>
      </div>
      <div class="edit-row">
        <div class="edit-group" role="group" aria-label="Trim">
          <div class="trim-info" id="trimInfo">${I.scissors}<span id="trimLabel"></span></div>
          <button class="btn ghost sm" data-act="set-start">Set start <kbd>I</kbd></button>
          <button class="btn ghost sm" data-act="set-end">Set end <kbd>O</kbd></button>
          <button class="btn ghost sm" data-act="reset-trim">Reset</button>
        </div>
        <button class="btn primary sm" data-act="trim" id="trimBtn">${I.scissors}Save trimmed copy</button>
        <span class="spacer"></span>
        <div class="edit-group" role="group" aria-label="Share">
          <button class="btn ghost sm" data-act="share" title="Share: a copy small enough for Discord, on the clipboard">${I.share}<span class="btn-text">Share</span></button>
          <button class="btn ghost sm" data-act="copy" title="Copy the file, then paste it into Discord or a chat">${I.copy}<span class="btn-text">Copy</span></button>
        </div>
        <div class="edit-group" role="group" aria-label="File">
          <button class="icon-btn" data-act="folder" title="Show in folder">${I.folder}</button>
          <button class="icon-btn" data-act="external" title="Open in your default video player">${I.external}</button>
          <button class="icon-btn danger" data-act="delete" title="Delete (Del)">${I.trash}</button>
        </div>
      </div>
    </section>`;
  el.classList.add('rail'); // the minimap and input stats beside the video; the keyboard on it
  el.hidden = false;
  updateFavButton();

  const video = $('#video');
  RangeVideo.load(video, item); // a virtual clip plays its range of the full recording
  video.volume = pref('volume', 1);
  video.muted = pref('muted', false);
  video.addEventListener('loadedmetadata', () => {
    const p = state.player;
    if (!p || !Number.isFinite(video.duration)) return;
    const wasFull = p.end === 0 || p.end >= p.duration - 0.01;
    p.duration = video.duration;
    if (wasFull) p.end = video.duration;
    if (startAt > 0 && !p.startedAt) { p.startedAt = true; video.currentTime = Math.min(startAt, video.duration); }
    setupAudioTracks(video, item, $('#trackSel'));
    updateTimeline();
    renderMarkers();
  });
  video.addEventListener('play', () => {
    const p = state.player;
    if (p && isTrimmed() && (video.currentTime < p.start - 0.05 || video.currentTime >= p.end - 0.05)) video.currentTime = p.start;
  });
  // The one control set: play, time, volume (the video has no built-in controls).
  const playBtn = $('#playBtn');
  const showPlaying = () => {
    playBtn.innerHTML = spriteIcon(video.paused ? 'play' : 'pause');
    playBtn.title = video.paused ? 'Play (Space)' : 'Pause (Space)';
    $('#stage').classList.toggle('paused', video.paused);
  };
  const showTime = () => {
    const p = state.player;
    const total = p && p.duration ? p.duration : video.duration;
    $('#timeReadout').textContent = `${fmtDuration(video.currentTime)}${Number.isFinite(total) && total > 0 ? ` / ${fmtDuration(total)}` : ''}`;
  };
  const vol = $('#volSlider');
  const showVolume = () => {
    vol.value = String(video.muted ? 0 : video.volume);
    $('#muteBtn').innerHTML = spriteIcon(video.muted || video.volume === 0 ? 'volume-x' : 'volume-2');
    $('#muteBtn').title = video.muted ? 'Unmute (M)' : 'Mute (M)';
  };
  for (const ev of ['play', 'pause', 'ended']) video.addEventListener(ev, showPlaying);
  for (const ev of ['timeupdate', 'seeked', 'loadedmetadata']) video.addEventListener(ev, showTime);
  vol.addEventListener('input', () => { video.muted = false; video.volume = Number(vol.value); });
  // Done with the slider or a menu: give the keys back to the player (Space, F, arrows).
  vol.addEventListener('change', () => vol.blur());
  vol.addEventListener('pointerup', () => vol.blur());
  video.addEventListener('click', () => { if (video.paused) video.play(); else video.pause(); });
  video.addEventListener('dblclick', () => toggleFullscreen());
  showPlaying();
  showVolume();
  video.addEventListener('volumechange', () => { setPref('volume', video.volume); setPref('muted', video.muted); showVolume(); });
  video.addEventListener('ended', () => {
    // Autoplay: on to the next video in the library (not while a trimmed selection loops).
    if (!pref('autoplay', false) || isTrimmed()) return;
    const next = neighbourVideo(1);
    if (next) openPlayer(next.path);
  });
  $('#speedSel').addEventListener('change', (e) => { setSpeed(Number(e.target.value)); e.target.blur(); });
  $('#trackSel').addEventListener('change', (e) => { chooseAudioTrack(video, Number(e.target.value), item); e.target.blur(); });
  setSpeed(state.speed || 1);

  const title = $('#titleInput');
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') title.blur();
    if (e.key === 'Escape') { title.value = state.player.item.name; title.blur(); }
    e.stopPropagation();
  });
  title.addEventListener('blur', () => renameCurrent(title.value));

  // A virtual clip gets a real file as the pointer reaches the chip: a drag needs one at once.
  $('#dragChip').addEventListener('pointerenter', () => { if (state.player.item.virtual && api.prepareFile) api.prepareFile(state.player.item.path).catch(() => {}); });
  $('#dragChip').addEventListener('dragstart', (e) => {
    e.preventDefault();
    api.startDrag(state.player.item.path);
  });

  bindTimeline();
  bindVideoControls();
  bindSplitter();
  el.classList.toggle('kb-heat', Boolean(item.inputs) && kbPrefs().mode === 'heat');
  bindOverlay();
  applyPanelSize(kbPrefs().size);
  applyOverlayMode();
  setupMapGuide(item);
  // Keep the floating keyboard inside the video area whenever that area changes size.
  state.player.resizeObserver = new ResizeObserver(() => placeOverlay());
  state.player.resizeObserver.observe($('.stage'));
  updateTimeline();
  renderMarkers();
  state.player.raf = requestAnimationFrame(tick);
  if (item.inputs) {
    const p = state.player;
    api.getInputs(item.path).then((events) => { if (state.player === p) setupInputs(events); });
  }
  // The trim lane shows stills of the whole video once they're made (a moment for a new clip).
  if (api.filmstrip) {
    const p = state.player;
    api.filmstrip(item.path).then((url) => {
      const tl = $('#timeline');
      if (!url || state.player !== p || !tl) return;
      const strip = document.createElement('div');
      strip.className = 'tl-strip';
      strip.id = 'tlStrip';
      strip.style.backgroundImage = `url("${url}")`;
      tl.prepend(strip);
    }).catch(() => {});
  }
}

// ---- recorded keyboard / mouse input, shown in sync with the video

// Your keyboard (Wooting 80HE) and mouse under the video. Every key lights up when it was
// pressed, useful or not, so slips onto the wrong key are easy to spot.
const KB_PREFS_KEY = 'clipvault.keyboard';

// overlay: the keyboard floating over the video; x / y / w are fractions of the video area.
// Default spot: lower left, above the HUD's stats corner and below the ally portraits. In a
// League frame that's open ground (chat, when open); the champion, ability bar, minimap,
// scoreboard and ally portraits stay clear.
const OVERLAY_DEFAULTS = { on: false, x: 0, y: 0.62, w: 0.36, opacity: 0.8 };
const OLD_OVERLAY_SPOT = { x: 0.02, y: 0.38 }; // the earlier default, saved along with other prefs

function kbPrefs() {
  const defaults = { mode: 'live', hidden: false, size: DEFAULT_PANEL, overlay: { ...OVERLAY_DEFAULTS } };
  try {
    const stored = JSON.parse(localStorage.getItem(KB_PREFS_KEY) || '{}');
    const ov = { ...(stored.overlay || {}) };
    // Never dragged there (a drag saves pixel fractions): it moves to the new default spot.
    if (ov.x === OLD_OVERLAY_SPOT.x && ov.y === OLD_OVERLAY_SPOT.y) { delete ov.x; delete ov.y; }
    return { ...defaults, ...stored, overlay: { ...OVERLAY_DEFAULTS, ...ov } };
  } catch {
    return defaults;
  }
}

function saveKbPrefs(prefs) {
  try { localStorage.setItem(KB_PREFS_KEY, JSON.stringify(prefs)); } catch { /* not important */ }
}

// Bottom panel under the video: [match minimap] [keyboard + mouse, centred] [stats + controls].
function reviewPanelHtml(item, { overlay = true } = {}) {
  const prefs = kbPrefs();
  const kb = Boolean(item.inputs);
  return `<div class="inputs ${prefs.hidden ? 'collapsed' : ''} ${kb ? '' : 'no-kb'}" id="inputsPanel">
    <div class="map-slot">${item.map ? `<button class="map-guide" data-act="open-map" title="Minimap of the whole match, in sync with this clip. Click to open the full match minimap here.">
      <video id="mapVideo" muted playsinline preload="auto"></video><span>${I.map}Match minimap</span></button>` : ''}</div>
    ${kb ? `<div class="kb-group" id="kbGroup"><div class="kb-case">${window.Keyboard.keyboardHtml()}</div>${window.Keyboard.mouseHtml()}</div>` : '<div></div>'}
    <div class="inputs-info">${kb ? `
      <div class="input-stats" id="inputStats">Loading inputs…</div>
      <div class="other-keys" id="otherKeys"></div>
      <div class="kb-controls">
        <div class="seg" role="group" aria-label="Keyboard view">
          <button data-act="kb-mode" data-mode="live" class="${prefs.mode === 'heat' ? '' : 'on'}" title="Keys light up as they were pressed">Live</button>
          <button data-act="kb-mode" data-mode="heat" class="${prefs.mode === 'heat' ? 'on' : ''}" title="Color keys by how often they were pressed">Heatmap</button>
        </div>
        ${overlay ? `<button class="btn ghost sm" data-act="kb-overlay" id="kbOverlayBtn">${prefs.overlay.on ? 'Back under video' : 'Show on video'}</button>` : ''}
        <button class="btn ghost sm" data-act="kb-toggle">${prefs.hidden ? 'Show keyboard' : 'Hide'}</button>
      </div>` : ''}
    </div>
  </div>`;
}

function overlayHtml({ rail = false } = {}) {
  const o = kbPrefs().overlay;
  return `<div class="kb-overlay" id="kbOverlay" hidden>
    <div class="ov-bar">
      <label class="ov-chip" title="How see-through the keyboard is">Fade <input type="range" min="20" max="100" step="5" value="${Math.round(o.opacity * 100)}" data-act="ov-opacity"></label>
      ${rail ? '<button class="ov-chip" data-act="kb-toggle" title="Hide the keyboard (Show keyboard brings it back)">Hide</button>'
        : '<button class="ov-chip" data-act="kb-overlay" title="Put the keyboard back under the video">Back under video</button>'}
    </div>
    <div class="ov-resize" title="Drag to resize"></div>
  </div>`;
}

// Move the keyboard + mouse between the panel and the floating overlay. The same elements
// move, so the live key highlighting keeps working.
function applyOverlayMode() {
  const group = $('#kbGroup');
  const ov = $('#kbOverlay');
  const panel = $('#inputsPanel');
  if (!group || !ov || !panel) return;
  const prefs = kbPrefs();
  const rail = $('#player').classList.contains('rail');
  const on = rail || prefs.overlay.on; // the rail layout always shows the keyboard on the video
  if (on && group.parentElement !== ov) ov.insertBefore(group, ov.querySelector('.ov-resize'));
  if (!on && group.parentElement !== panel) panel.insertBefore(group, panel.querySelector('.inputs-info'));
  panel.classList.toggle('overlaid', on);
  ov.hidden = !on || prefs.hidden;
  const btn = $('#kbOverlayBtn');
  if (btn) btn.textContent = on ? 'Back under video' : 'Show on video';
  const head = $('#kbOverlayHeadBtn');
  if (head) {
    head.classList.toggle('on', rail ? !prefs.hidden : on);
    const text = rail ? (prefs.hidden ? 'Show keyboard' : 'Hide keyboard') : on ? 'Keyboard under video' : 'Keyboard on video';
    head.innerHTML = `${I.keyboard}<span class="lbl">${text}</span>`;
  }
  placeOverlay();
  applyPanelSize(prefs.size);
}

// Position from the saved fractions, kept inside the video area.
function placeOverlay() {
  const ov = $('#kbOverlay');
  const stage = $('.stage');
  if (!ov || ov.hidden || !stage) return;
  const o = kbPrefs().overlay;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const w = Math.min(sw, Math.max(220, o.w * sw));
  ov.style.width = `${w}px`;
  ov.style.setProperty('--ov-opacity', o.opacity);
  const h = ov.offsetHeight;
  ov.style.left = `${Math.min(Math.max(0, o.x * sw), Math.max(0, sw - w))}px`;
  ov.style.top = `${Math.min(Math.max(0, o.y * sh), Math.max(0, sh - h))}px`;
}

function bindOverlay() {
  const ov = $('#kbOverlay');
  if (!ov) return;
  ov.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.ov-bar')) return; // its buttons and slider work normally
    e.preventDefault();
    const stage = $('.stage');
    const resizing = Boolean(e.target.closest('.ov-resize'));
    const startX = e.clientX;
    const startY = e.clientY;
    const left = ov.offsetLeft;
    const top = ov.offsetTop;
    const width = ov.offsetWidth;
    ov.setPointerCapture(e.pointerId);
    ov.classList.add('dragging');
    const move = (ev) => {
      const sw = stage.clientWidth;
      const sh = stage.clientHeight;
      if (resizing) {
        ov.style.width = `${Math.min(sw - left, Math.max(220, width + ev.clientX - startX))}px`;
      } else {
        ov.style.left = `${Math.min(Math.max(0, left + ev.clientX - startX), Math.max(0, sw - ov.offsetWidth))}px`;
        ov.style.top = `${Math.min(Math.max(0, top + ev.clientY - startY), Math.max(0, sh - ov.offsetHeight))}px`;
      }
    };
    const up = () => {
      ov.classList.remove('dragging');
      ov.removeEventListener('pointermove', move);
      ov.removeEventListener('pointerup', up);
      ov.removeEventListener('pointercancel', up);
      const prefs = kbPrefs();
      prefs.overlay = { ...prefs.overlay, x: ov.offsetLeft / stage.clientWidth, y: ov.offsetTop / stage.clientHeight, w: ov.offsetWidth / stage.clientWidth };
      saveKbPrefs(prefs);
    };
    ov.addEventListener('pointermove', move);
    ov.addEventListener('pointerup', up);
    ov.addEventListener('pointercancel', up);
  });
  ov.querySelector('[data-act="ov-opacity"]').addEventListener('input', (e) => {
    const prefs = kbPrefs();
    prefs.overlay.opacity = Number(e.target.value) / 100;
    saveKbPrefs(prefs);
    ov.style.setProperty('--ov-opacity', prefs.overlay.opacity);
  });
}

// target: the open player state; it gets .inputs and supplies .duration.
function setupInputs(events, target = state.player) {
  const p = target;
  const panel = $('#player');
  if (!p || !$('#kbGroup')) return;
  resetKeyboard();
  if (!events.length) { $('#inputStats').textContent = 'No inputs recorded'; return; }
  const byKey = new Map(); // key -> [[seconds, down], ...] in time order
  for (const [t, raw, d] of events) {
    const k = window.Keyboard.normalize(raw);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push([t / 1000, d]);
  }
  const presses = new Map([...byKey].map(([k, list]) => [k, list.filter((e) => e[1]).length]));

  // Keys this board doesn't have (numpad, media keys...) get their own little caps.
  const offBoard = [...byKey.keys()].filter((k) => !panel.querySelector(`[data-k="${CSS.escape(k)}"]`));
  $('#otherKeys').innerHTML = offBoard.length
    ? `<span class="muted">Also pressed:</span> ${offBoard.map((k) => `<span class="cap mini" data-k="${esc(k)}"><span>${esc(k)}</span><i></i></span>`).join('')}` : '';

  const keyMax = Math.max(1, ...[...presses].filter(([k]) => !k.startsWith('Mouse')).map(([, n]) => n));
  const mouseMax = Math.max(1, ...[...presses].filter(([k]) => k.startsWith('Mouse')).map(([, n]) => n));
  const els = [];
  for (const [k, list] of byKey) {
    const found = [...panel.querySelectorAll(`[data-k="${CSS.escape(k)}"]`)];
    const n = presses.get(k);
    for (const el of found) {
      el.style.setProperty('--heat', (n / (k.startsWith('Mouse') ? mouseMax : keyMax)).toFixed(3));
      el.classList.add('used');
      const badge = el.querySelector('i');
      if (badge) badge.textContent = n;
      if (!el.querySelector('title')) el.setAttribute('title', `${k}: ${n} press${n === 1 ? '' : 'es'}`);
    }
    if (found.length) els.push([k, found, list]);
  }

  const minutes = Math.max(p.duration || events[events.length - 1][0] / 1000, 1) / 60;
  const actions = [...presses.values()].reduce((a, n) => a + n, 0);
  const clicks = [...presses].filter(([k]) => k.startsWith('Mouse')).reduce((a, [, n]) => a + n, 0);
  $('#inputStats').innerHTML = `<b>${Math.round(actions / minutes)}</b> APM · <b>${Math.round(clicks / minutes)}</b> clicks/min · <b>${actions - clicks}</b> key presses · <b>${byKey.size}</b> different keys/buttons`;
  p.inputs = { els };
}

// Is the key held at time t, or was it tapped within the last 120 ms (so quick taps show up)?
function keyActiveAt(list, t) {
  let lo = 0;
  let hi = list.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] <= t) { i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (i < 0) return false;
  if (list[i][1]) return true;
  return i > 0 && list[i - 1][1] === 1 && t - list[i - 1][0] < 0.12;
}

function updateInputs(t, target = state.player) {
  const p = target;
  if (!p || !p.inputs) return;
  for (const [, found, list] of p.inputs.els) {
    const on = keyActiveAt(list, t);
    for (const el of found) el.classList.toggle('on', on);
  }
}

// Clear counts, heat and highlights.
function resetKeyboard() {
  for (const el of document.querySelectorAll('#player [data-k]')) {
    el.classList.remove('on', 'used');
    el.style.removeProperty('--heat');
    const badge = el.querySelector('i');
    if (badge) badge.textContent = '';
    if (el.hasAttribute('title') && el.classList.contains('cap')) el.removeAttribute('title');
  }
  const other = $('#otherKeys');
  if (other) other.innerHTML = '';
}

// Re-draw whichever timeline is open after a size change.
function rerenderTimelines() {
  renderMarkers();
}

// Key moments on the timeline: a coloured tick per moment on the track, and a symbol pin above
// it. Pins that would overlap are grouped under the most important one, with a count.
function renderMarkers() {
  const p = state.player;
  const box = $('#tlMarkers');
  const tl = $('#timeline');
  if (!p || !box || !tl || !p.duration) return;
  box.innerHTML = pinsHtml(p.item.markers || [], p.duration, tl);
  const ruler = $('#tlRuler');
  if (ruler) ruler.innerHTML = rulerHtml(p.duration, tl.clientWidth);
  const ticks = $('#scrubTicks');
  if (ticks) {
    const hidden = hiddenTypes();
    ticks.innerHTML = (p.item.markers || []).filter((m) => m.t <= p.duration).map((m) => ({ m, st: window.EventStyles.style(m.type, m.label) }))
      .filter(({ st }) => !hidden.has(st.type))
      .map(({ m, st }) => `<i style="left:${(m.t / p.duration) * 100}%;--c:${st.color}"></i>`).join('');
  }
}

// The time ruler etched above the trim lane: a labelled major tick at a round step that leaves
// room for its label, minor ticks between.
const RULER_STEPS = [[1, 5], [2, 4], [5, 5], [10, 5], [15, 3], [30, 6], [60, 6], [120, 4], [300, 5], [600, 5], [900, 3], [1800, 6], [3600, 6]];
function rulerHtml(duration, width) {
  if (!(duration > 0) || !(width > 0)) return '';
  const [step, parts] = RULER_STEPS.find(([st]) => (st / duration) * width >= 72) || RULER_STEPS[RULER_STEPS.length - 1];
  const minor = step / parts;
  let html = '';
  for (let i = 0; i * minor <= duration + 1e-6; i++) {
    const t = i * minor;
    const left = `${(t / duration) * 100}%`;
    const major = i % parts === 0;
    html += `<i class="${major ? 'mj' : ''}" style="left:${left}"></i>`;
    if (major && (duration - t) / duration * width > 34) html += `<span style="left:${left}">${fmtDuration(t)}</span>`;
  }
  return html;
}

// Ticks + symbol pins for moments on a timeline element `tl` spanning `duration` seconds.
function pinsHtml(list, duration, tl) {
  const ES = window.EventStyles;
  const hidden = hiddenTypes();
  const markers = list
    .filter((m) => m.t <= duration)
    .map((m) => ({ ...m, st: ES.style(m.type, m.label) }))
    .filter((m) => !hidden.has(m.st.type))
    .sort((a, b) => a.t - b.t);
  const pinPx = parseFloat(getComputedStyle(tl).getPropertyValue('--pin')) || 22;
  const minGap = ((pinPx + 3) / Math.max(1, tl.clientWidth)) * duration;
  const groups = [];
  for (const m of markers) {
    const g = groups[groups.length - 1];
    if (g && m.t - g.items[0].t < minGap) g.items.push(m);
    else groups.push({ items: [m] });
  }
  const pct = (t) => `${(t / duration) * 100}%`;
  const ticks = markers.map((m) => `<div class="tl-tick" style="left:${pct(m.t)};--c:${m.st.color}"></div>`).join('');
  const pins = groups.map((g) => {
    const top = g.items.reduce((a, b) => (b.st.rank > a.st.rank ? b : a));
    const where = g.items.reduce((a, m) => a + m.t, 0) / g.items.length;
    const title = g.items.map((m) => `${fmtDuration(m.t)}  ${m.label}`).join('\n');
    return `<button class="tl-pin" style="left:${pct(where)};--c:${top.st.color}" data-t="${g.items[0].t}" title="${esc(title)}">${ES.icon(top.st.type, { label: top.label, small: false })}${g.items.length > 1 ? `<b>${g.items.length}</b>` : ''}</button>`;
  }).join('');
  return ticks + pins;
}

let markerTimer;
window.addEventListener('resize', () => {
  clearTimeout(markerTimer);
  markerTimer = setTimeout(() => { rerenderTimelines(); placeOverlay(); }, 100);
});

function highlightTag(label, event) {
  const st = window.EventStyles.style(event, label);
  return `<span class="tag hl" style="--c:${st.color}">${window.EventStyles.icon(st.type, { label })}${esc(label || 'Highlight')}</span>`;
}

// ---- event filter: types hidden from timelines, the moment list and highlights-only playback

function hiddenTypes() {
  return new Set(pref('hiddenTypes', []));
}

function toggleHiddenType(type) {
  const hidden = hiddenTypes();
  if (hidden.has(type)) hidden.delete(type);
  else hidden.add(type);
  setPref('hiddenTypes', [...hidden]);
}

const typeOf = (m) => window.EventStyles.style(m.type, m.label).type;

// One chip per kind of moment, with a count; click to hide or show that kind.
function legendHtml(list) {
  const ES = window.EventStyles;
  const counts = new Map();
  for (const m of list) counts.set(m.kind, (counts.get(m.kind) || 0) + 1);
  if (counts.size < 2) return '';
  const hidden = hiddenTypes();
  return `<div class="legend">${I.filter}${[...counts]
    .sort((a, b) => ES.TYPES[b[0]].rank - ES.TYPES[a[0]].rank)
    .map(([t, n]) => `<button class="legend-chip ${hidden.has(t) ? 'off' : ''}" data-act="legend" data-type="${t}" style="--c:${ES.TYPES[t].color}" title="${hidden.has(t) ? 'Show' : 'Hide'} ${esc(ES.TYPES[t].name.toLowerCase())} moments">${ES.icon(t)}<span>${esc(ES.TYPES[t].name)}</span><b>${n}</b></button>`)
    .join('')}</div>`;
}

// Moment chips above the player's timeline (click to jump), with the filter for long videos.
function momentsHtml(markers) {
  if (!markers.length) return '';
  const ES = window.EventStyles;
  const hidden = hiddenTypes();
  const legend = markers.length > 4 ? legendHtml(markers.map((m) => ({ kind: typeOf(m) }))) : '';
  const chips = markers.filter((m) => !hidden.has(typeOf(m))).map((m) => {
    const st = ES.style(m.type, m.label);
    return `<button class="moment" style="--c:${st.color}" data-act="seek" data-t="${m.t}" title="${esc(st.name)} · jump to this moment">${ES.icon(st.type, { label: m.label })}<span>${esc(m.label)}</span><time>${fmtDuration(m.t)}</time></button>`;
  }).join('');
  return `${legend}${chips ? `<div class="moments">${chips}</div>` : ''}`;
}

// ---- player controls

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function setSpeed(rate, { osd = false } = {}) {
  state.speed = rate;
  for (const v of [$('#video'), $('#mapVideo')]) {
    if (!v) continue;
    v.defaultPlaybackRate = rate; // survives loading the next clip
    v.playbackRate = rate;
  }
  const sel = $('#speedSel');
  if (sel) sel.value = String(rate);
  if (osd) flashOsd(`${rate}×`);
}

function stepSpeed(dir) {
  const i = SPEEDS.indexOf(state.speed || 1);
  setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 3 : i) + dir))], { osd: true });
}

function frameStep(video, dir, fps) {
  if (!video || !Number.isFinite(video.duration)) return;
  video.pause();
  video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + dir / (fps || 60)));
}

// The whole player goes full screen (styles.css shows only the video and its controls then), so
// the next / previous video and autoplay stay in full screen.
function toggleFullscreen() {
  const player = $('#player');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (player && !player.hidden) player.requestFullscreen().catch(() => {});
}

// A short label in the middle of the video for keyboard actions (speed, volume...).
let osdTimer;
function flashOsd(text) {
  const stage = $('.stage');
  if (!stage) return;
  let osd = $('.osd', stage);
  if (!osd) {
    osd = document.createElement('div');
    osd.className = 'osd';
    stage.appendChild(osd);
  }
  osd.textContent = text;
  osd.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => osd.classList.remove('show'), 700);
}

function changeVolume(video, delta) {
  if (!video) return;
  video.muted = false;
  video.volume = Math.min(1, Math.max(0, Math.round((video.volume + delta) * 20) / 20));
  flashOsd(`Volume ${Math.round(video.volume * 100)}%`);
}

function toggleMute(video) {
  if (!video) return;
  video.muted = !video.muted;
  flashOsd(video.muted ? 'Muted' : `Volume ${Math.round(video.volume * 100)}%`);
}

// The video before / after the open one in the library's current order (match minimaps open
// in their own page, so they're skipped).
function neighbourVideo(dir) {
  const p = state.player;
  if (!p) return null;
  const list = filteredItems().filter((i) => i.type !== 'map');
  const idx = list.findIndex((i) => i.path === p.item.path);
  return idx < 0 ? null : list[idx + dir] || null;
}

function updateFavButton() {
  const b = $('#favBtn');
  const p = state.player;
  if (!b || !p) return;
  b.classList.toggle('on', Boolean(p.item.favorite));
  b.innerHTML = p.item.favorite ? I.heartFill : I.heart;
  b.title = p.item.favorite ? 'Remove from favorites' : 'Add to favorites (never removed by the storage limit)';
}

// Previous / next key moment (of the kinds shown), with the usual 3 s lead-in.
function momentTarget(markers, t, dir) {
  const hidden = hiddenTypes();
  const times = markers.filter((m) => !hidden.has(typeOf(m))).map((m) => Math.max(0, m.t - 3)).sort((a, b) => a - b);
  return dir > 0 ? times.find((x) => x > t + 0.5) : [...times].reverse().find((x) => x < t - 1.5);
}

// Videos with several sound tracks (Mixed / Game / Microphone / Discord): pick which to hear.
function setupAudioTracks(video, item, sel) {
  const tracks = video.audioTracks;
  if (!tracks || tracks.length < 2) {
    if (sel) sel.hidden = true;
    return;
  }
  const names = item.audioTracks || [];
  const label = (i) => names[i] || tracks[i].label || `Track ${i + 1}`;
  let idx = names.indexOf(pref('audioTrack', null));
  if (idx < 0 || idx >= tracks.length) idx = 0;
  if (sel) {
    sel.innerHTML = [...Array(tracks.length).keys()].map((i) => opt(i, `Sound: ${label(i)}`, idx)).join('');
    sel.hidden = false;
  }
  chooseAudioTrack(video, idx, item, false);
}

function chooseAudioTrack(video, idx, item, remember = true) {
  const tracks = video.audioTracks;
  if (!tracks) return;
  for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === idx;
  if (remember) setPref('audioTrack', (item.audioTracks || [])[idx] || null);
}

const SHARE_SIZES = [
  [10, 'Discord without Nitro'],
  [25, 'Email attachments'],
  [50, 'Discord Nitro Basic, boosted servers'],
  [100, 'Discord servers at boost level 3'],
  [500, 'Discord Nitro'],
];

// Share: a copy under the chosen size (re-encoded only when needed), put on the clipboard.
async function shareFlow(item, anchor) {
  const tracks = item.audioTracks || [];
  const current = Math.max(0, tracks.indexOf(pref('audioTrack', null)));
  const footer = tracks.length > 1
    ? `<label class="pop-field">Sound <select data-name="track">${tracks.map((t, i) => opt(i, t, current)).join('')}</select></label>` : '';
  const choice = await popover(anchor, {
    title: 'Copy to share, under…',
    items: SHARE_SIZES.map(([mb, sub]) => ({ id: String(mb), label: `${mb} MB`, sub: item.size && item.size <= mb * 1e6 * 0.97 ? `${sub} · already fits` : sub })),
    footer,
  });
  if (!choice) return;
  toast(`Preparing a copy under ${choice.id} MB…`, 'saving', true);
  const r = await attempt(() => api.shareVideo(item.path, Number(choice.id), Number(choice.values.track || 0)), "Couldn't make the copy");
  if (!r) return;
  toast(r.reencoded
    ? `Copied a ${fmtSize(r.bytes)} version (${r.height}p). Paste it into Discord`
    : `Copied (${fmtSize(r.bytes)}, already small enough). Paste it into Discord`, 'ok');
}

function shortcutsHtml() {
  const rows = [
    ['Space / K', 'Play or pause'], ['← → / J L', 'Back / forward 5 seconds'], [', .', 'Previous / next frame'],
    ['< >', 'Slower / faster'], ['[ ]', 'Previous / next key moment'], ['↑ ↓', 'Volume'], ['M', 'Mute'], ['F', 'Full screen'],
    ['0 – 9', 'Jump to 0 % … 90 %'],
    ['N P', 'Next / previous video'], ['I O', 'Set trim start / end'], ['Del', 'Delete the video'],
    ['Esc', 'Back to the library'], ['?', 'This list'],
  ];
  return `<div class="shortcuts">${rows.map(([k, d]) => `<div><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('')}</div>`;
}

// ---- resizable bottom panel: one continuous size drives the keyboard and the timeline

const DEFAULT_PANEL = 210;

function applyPanelSize(size) {
  const el = $('#player');
  if (!el) return;
  if (el.classList.contains('rail')) { // nothing under the video but the timeline: it stays compact
    el.style.setProperty('--tl-h', '46px');
    placeOverlay();
    return;
  }
  const panel = $('#inputsPanel');
  const keyboard = Boolean(panel && $('#kbGroup') && !panel.classList.contains('collapsed') && !panel.classList.contains('overlaid'));
  // With the keyboard shown the size is mostly its height; without it, the timeline grows.
  const tl = keyboard ? 40 + size * 0.12 : 40 + (size - 80) * 0.35;
  el.style.setProperty('--kb-h', `${Math.round(size)}px`);
  el.style.setProperty('--tl-h', `${Math.round(Math.min(130, Math.max(40, tl)))}px`);
  placeOverlay(); // the video area changed size
}

function bindSplitter() {
  const split = $('#playerSplit');
  if (!split) return; // the clip player has none (its panel is the rail)
  split.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    split.classList.add('dragging');
    const startY = e.clientY;
    const start = kbPrefs().size;
    let size = start;
    const stage = $('.stage');
    const move = (ev) => {
      const want = Math.min(window.innerHeight * 0.6, Math.max(80, start + (startY - ev.clientY)));
      applyPanelSize(want);
      // Never squeeze the video below 180 px: growing stops there.
      if (want > size && stage.clientHeight < 180) applyPanelSize(size);
      else size = want;
      rerenderTimelines();
    };
    const up = () => {
      split.classList.remove('dragging');
      split.removeEventListener('pointermove', move);
      split.removeEventListener('pointerup', up);
      split.removeEventListener('pointercancel', up);
      saveKbPrefs({ ...kbPrefs(), size: Math.round(size) });
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up);
    split.addEventListener('pointercancel', up);
  });
  split.addEventListener('dblclick', () => {
    saveKbPrefs({ ...kbPrefs(), size: DEFAULT_PANEL });
    applyPanelSize(DEFAULT_PANEL);
    rerenderTimelines();
  });
}

function closePlayer({ switching = false } = {}) {
  const p = state.player;
  if (!p) return;
  if (!switching && document.fullscreenElement === $('#player')) leaveFullscreen();
  cancelAnimationFrame(p.raf);
  if (p.resizeObserver) p.resizeObserver.disconnect();
  for (const v of [$('#video'), $('#mapVideo')]) {
    if (!v) continue;
    v.pause();
    v.removeAttribute('src');
    v.load(); // releases the file so it can be renamed or deleted
  }
  const el = $('#player');
  if (!switching) el.hidden = true;
  el.innerHTML = '';
  el.classList.remove('kb-heat', 'rail');
  state.player = null;
}

// ---- the match minimap beside the keyboard, kept in sync with the clip

function setupMapGuide(item) {
  const mv = $('#mapVideo');
  if (!mv || !item.map) return;
  mv.src = item.map.url;
  state.player.map = { offset: item.map.offset };
}

function syncMapGuide(video) {
  const p = state.player;
  const mv = $('#mapVideo');
  if (!p || !p.map || !mv || mv.readyState < 1) return;
  const target = p.map.offset + video.currentTime; // seconds into the minimap recording
  if (target < 0 || (mv.duration && target > mv.duration)) {
    if (!mv.paused) mv.pause();
    return;
  }
  if (Math.abs(mv.currentTime - target) > 0.35) mv.currentTime = target;
  if (video.paused && !mv.paused) mv.pause();
  else if (!video.paused && mv.paused) mv.play().catch(() => {});
  if (mv.playbackRate !== video.playbackRate) mv.playbackRate = video.playbackRate;
}

function isTrimmed() {
  const p = state.player;
  return p && p.duration > 0 && (p.start > 0.05 || p.end < p.duration - 0.05);
}

function tick() {
  const p = state.player;
  if (!p) return;
  const video = $('#video');
  if (video && p.duration) {
    if (isTrimmed() && !video.paused && video.currentTime >= p.end) video.currentTime = p.start; // loop the selection
    $('#playhead').style.left = `${(video.currentTime / p.duration) * 100}%`;
    updateScrub(video.currentTime);
    updateInputs(video.currentTime);
    syncMapGuide(video);
  }
  p.raf = requestAnimationFrame(tick);
}

function updateTimeline() {
  const p = state.player;
  if (!p) return;
  const d = p.duration || 1;
  const a = (p.start / d) * 100;
  const b = (p.end / d) * 100;
  $('#tlSel').style.left = `${a}%`;
  $('#tlSel').style.width = `${b - a}%`;
  $('#dimL').style.left = '0';
  $('#dimL').style.width = `${a}%`;
  $('#dimR').style.left = `${b}%`;
  $('#dimR').style.width = `${100 - b}%`;
  $('[data-h="start"]').style.left = `${a}%`;
  $('[data-h="end"]').style.left = `${b}%`;
  const trimmed = isTrimmed();
  $('#trimInfo').classList.toggle('active', trimmed);
  $('#trimLabel').textContent = trimmed
    ? `${fmtPrecise(p.start)} – ${fmtPrecise(p.end)} (${(p.end - p.start).toFixed(1)} s)`
    : `Full video · ${fmtDuration(p.duration)}`;
  $('#trimBtn').disabled = !trimmed || p.trimming;
  const band = $('#scrubTrim');
  if (band) {
    band.hidden = !trimmed;
    band.style.left = `${a}%`;
    band.style.width = `${b - a}%`;
  }
}

// ---- the controls on the video: seek bar, buttons, auto-hide

function updateScrub(t) {
  const p = state.player;
  const d = p && p.duration;
  if (!d) return;
  const pct = `${Math.min(100, Math.max(0, (t / d) * 100))}%`;
  $('#scrubFill').style.width = pct;
  $('#scrubKnob').style.left = pct;
  const scrub = $('#scrub');
  scrub.setAttribute('aria-valuemax', String(Math.round(d)));
  scrub.setAttribute('aria-valuenow', String(Math.round(t)));
  scrub.setAttribute('aria-valuetext', fmtDuration(t));
}

function bindVideoControls() {
  const stage = $('#stage');
  const scrub = $('#scrub');
  const video = $('#video');
  const tip = $('#scrubTip');
  const timeAt = (clientX) => {
    const r = scrub.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * (state.player.duration || 0);
  };
  const showTip = (clientX) => {
    const p = state.player;
    if (!p || !p.duration) return;
    const r = scrub.getBoundingClientRect();
    const t = timeAt(clientX);
    const x = Math.min(r.width - 28, Math.max(28, clientX - r.left));
    // the nearest moment within a few pixels names itself in the tip
    const near = (p.item.markers || []).find((m) => Math.abs(m.t - t) / p.duration * r.width < 6);
    tip.textContent = near ? `${fmtDuration(t)} · ${near.label}` : fmtDuration(t);
    tip.style.left = `${x}px`;
    $('#scrubHover').style.width = `${(t / p.duration) * 100}%`;
    scrub.classList.add('hovering');
  };
  scrub.addEventListener('pointermove', (e) => showTip(e.clientX));
  scrub.addEventListener('pointerleave', () => { if (!scrub.classList.contains('dragging')) scrub.classList.remove('hovering'); });
  scrub.addEventListener('pointerdown', (e) => {
    const p = state.player;
    if (!p || !p.duration || e.button !== 0) return;
    e.preventDefault();
    scrub.setPointerCapture(e.pointerId);
    scrub.classList.add('dragging');
    const resume = !video.paused;
    video.pause();
    const move = (ev) => {
      const t = timeAt(ev.clientX);
      video.currentTime = t;
      updateScrub(t);
      showTip(ev.clientX);
    };
    move(e);
    const up = (ev) => {
      scrub.classList.remove('dragging');
      if (ev.type === 'pointerup' && !scrub.matches(':hover')) scrub.classList.remove('hovering');
      scrub.removeEventListener('pointermove', move);
      scrub.removeEventListener('pointerup', up);
      scrub.removeEventListener('pointercancel', up);
      scrub.removeEventListener('lostpointercapture', up);
      if (resume) video.play();
    };
    scrub.addEventListener('pointermove', move);
    scrub.addEventListener('pointerup', up);
    scrub.addEventListener('pointercancel', up);
    scrub.addEventListener('lostpointercapture', up);
  });
  scrub.addEventListener('keydown', (e) => {
    // the seek bar has focus: arrows step 5 s, Home / End jump to the ends
    const d = state.player && state.player.duration;
    if (!d) return;
    const to = { ArrowLeft: video.currentTime - 5, ArrowRight: video.currentTime + 5, Home: 0, End: d }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    video.currentTime = Math.min(d, Math.max(0, to));
  });

  // While playing, the controls and the pointer hide after 2.5 s without a mouse move; they stay
  // while paused, while the pointer is on them, and while something in them has focus.
  let idleTimer;
  const wake = () => {
    stage.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!video.paused && !$('#vc').matches(':hover') && !$('#vc').querySelector(':focus-visible')) stage.classList.add('idle');
    }, 2500);
  };
  stage.addEventListener('pointermove', wake);
  stage.addEventListener('pointerdown', wake);
  stage.addEventListener('pointerleave', () => { if (!video.paused && !document.fullscreenElement) stage.classList.add('idle'); });
  video.addEventListener('pause', () => { clearTimeout(idleTimer); stage.classList.remove('idle'); });
  video.addEventListener('play', wake);
  state.player.wake = wake;
}

// The full screen button shows what it will do.
document.addEventListener('fullscreenchange', () => {
  const btn = $('#fsBtn');
  if (!btn || !state.player) return;
  const full = Boolean(document.fullscreenElement);
  btn.innerHTML = spriteIcon(full ? 'minimize' : 'maximize');
  btn.title = full ? 'Exit full screen (F or Esc)' : 'Full screen (F)';
  if (state.player && state.player.wake) state.player.wake();
  rerenderTimelines();
});
// The match page: its full screen button and the timeline's width follow full screen too.
document.addEventListener('fullscreenchange', () => {
  if (state.player || state.view !== 'match' || !state.mp) return;
  mpRefresh();
  requestAnimationFrame(mpFit);
});

function bindTimeline() {
  const tl = $('#timeline');
  const timeAt = (clientX) => {
    const r = tl.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * (state.player.duration || 0);
  };
  tl.addEventListener('pointerdown', (e) => {
    const p = state.player;
    if (!p || !p.duration) return;
    const video = $('#video');
    const pin = e.target.closest('.tl-pin');
    if (pin) {
      video.currentTime = Math.max(0, Number(pin.dataset.t) - 3); // a little lead-in
      video.play();
      return;
    }
    const handle = e.target.closest('.tl-handle');
    tl.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const t = timeAt(ev.clientX);
      if (handle && handle.dataset.h === 'start') p.start = Math.min(t, p.end - 0.5);
      else if (handle) p.end = Math.max(t, p.start + 0.5);
      p.start = Math.max(0, p.start);
      p.end = Math.min(p.duration, p.end);
      video.currentTime = handle ? (handle.dataset.h === 'start' ? p.start : p.end) : t;
      updateTimeline();
    };
    move(e);
    const up = () => {
      tl.removeEventListener('pointermove', move);
      tl.removeEventListener('pointerup', up);
      tl.removeEventListener('pointercancel', up);
    };
    tl.addEventListener('pointermove', move);
    tl.addEventListener('pointerup', up);
    tl.addEventListener('pointercancel', up);
  });
}

function setTrimPoint(which) {
  const p = state.player;
  const video = $('#video');
  if (!p || !video || !p.duration) return;
  const t = video.currentTime;
  if (which === 'start') {
    p.start = Math.min(t, p.duration - 0.5);
    if (p.end < p.start + 0.5) p.end = Math.min(p.duration, p.start + 0.5);
  } else {
    p.end = Math.max(t, 0.5);
    if (p.start > p.end - 0.5) p.start = Math.max(0, p.end - 0.5);
  }
  updateTimeline();
}

async function renameCurrent(value) {
  const p = state.player;
  if (!p) return;
  const name = value.trim();
  if (!name || name === p.item.name) { $('#titleInput').value = p.item.name; return; }
  const video = $('#video');
  const t = video.currentTime;
  const playing = !video.paused;
  video.pause();
  video.removeAttribute('src');
  video.load();
  const updated = await attempt(() => api.rename(p.item.path, name), "Couldn't rename");
  if (!state.player) return;
  if (updated) {
    state.items = state.items.map((i) => (i.path === p.item.path ? { ...i, ...updated } : i));
    p.item = { ...p.item, ...updated };
    refreshViews();
    toast('Renamed', 'ok');
  }
  $('#titleInput').value = p.item.name;
  RangeVideo.load(video, p.item);
  video.addEventListener('loadedmetadata', () => {
    video.currentTime = t;
    if (playing) video.play();
  }, { once: true });
}

$('#player').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]');
  const p = state.player;
  if (!act || !p) return;
  const file = p.item.path;
  switch (act.dataset.act) {
    case 'close': closePlayer(); break;
    case 'play': { const v = $('#video'); if (v.paused) v.play(); else v.pause(); break; }
    case 'mute': toggleMute($('#video')); break;
    case 'back5': case 'fwd5': {
      const v = $('#video');
      v.currentTime = Math.min(p.duration || v.duration || 0, Math.max(0, v.currentTime + (act.dataset.act === 'fwd5' ? 5 : -5)));
      break;
    }
    case 'fullscreen': toggleFullscreen(); break;
    case 'fav': toggleFavorite(file); break;
    case 'prev-video': case 'next-video': {
      const n = neighbourVideo(act.dataset.act === 'next-video' ? 1 : -1);
      if (n) openPlayer(n.path);
      break;
    }
    case 'autoplay': {
      const on = !pref('autoplay', false);
      setPref('autoplay', on);
      act.classList.toggle('on', on);
      toast(on ? 'Autoplay on: the next video plays when this one ends' : 'Autoplay off', 'info');
      break;
    }
    case 'help': infoDialog('Keyboard shortcuts', shortcutsHtml()); break;
    case 'share': shareFlow(p.item, act); break;
    case 'frame-back': frameStep($('#video'), -1, p.item.fps); break;
    case 'frame-next': frameStep($('#video'), 1, p.item.fps); break;
    case 'legend':
      toggleHiddenType(act.dataset.type);
      $('#momentsBox').innerHTML = momentsHtml(p.item.markers || []);
      renderMarkers();
      break;
    case 'kb-mode':
    case 'kb-toggle':
    case 'kb-overlay': {
      const prefs = kbPrefs();
      if (act.dataset.act === 'kb-mode') prefs.mode = act.dataset.mode;
      else if (act.dataset.act === 'kb-toggle' || $('#player').classList.contains('rail')) prefs.hidden = !prefs.hidden;
      else prefs.overlay = { ...prefs.overlay, on: !prefs.overlay.on };
      saveKbPrefs(prefs);
      const panel = $('#inputsPanel');
      $('#player').classList.toggle('kb-heat', prefs.mode === 'heat');
      panel.classList.toggle('collapsed', prefs.hidden);
      panel.querySelectorAll('[data-act="kb-mode"]').forEach((b) => b.classList.toggle('on', b.dataset.mode === prefs.mode));
      panel.querySelector('[data-act="kb-toggle"]').textContent = prefs.hidden ? 'Show keyboard' : 'Hide';
      applyOverlayMode(); // also re-applies the panel size
      renderMarkers();
      break;
    }
    case 'seek': {
      const video = $('#video');
      video.currentTime = Math.max(0, Number(act.dataset.t) - 3); // a little lead-in
      video.play();
      break;
    }
    case 'open-map': {
      // Jump from this clip to its match, at the same moment.
      const map = p.item.map;
      const at = map.offset + ($('#video').currentTime || 0);
      if (!state.items.some((i) => i.path === map.path)) await refreshLibrary();
      const mapItem = findItem(map.path);
      if (!mapItem) toast('The match appears when it ends', 'info');
      else if (!openMatchOf(mapItem, { mapAt: at, highlightMode: false })) openPlayer(map.path);
      break;
    }
    case 'set-start': setTrimPoint('start'); break;
    case 'set-end': setTrimPoint('end'); break;
    case 'reset-trim': p.start = 0; p.end = p.duration; updateTimeline(); break;
    case 'copy': copyFile(file); break;
    case 'folder': api.showInFolder(file); break;
    case 'external': $('#video').pause(); api.openExternally(file); break;
    case 'delete': deleteVideo(file); break;
    case 'trim': {
      p.trimming = true;
      updateTimeline();
      toast('Saving trimmed copy…', 'saving', true);
      const made = await attempt(() => api.trim(file, p.start, p.end), "Couldn't trim");
      if (state.player === p) { p.trimming = false; updateTimeline(); }
      if (made) toast(`Saved "${made.name}"`, 'ok');
      break;
    }
    default:
  }
});

// Player keys: speed, frames, volume, full screen, help.
function commonPlayerKey(e, video, { fps }) {
  const k = e.key;
  if (k === '<' || k === '>') stepSpeed(k === '>' ? 1 : -1);
  else if (k === ',' || k === '.') frameStep(video, k === '.' ? 1 : -1, fps);
  else if (k === 'ArrowUp' || k === 'ArrowDown') changeVolume(video, k === 'ArrowUp' ? 0.05 : -0.05);
  else if (k.toLowerCase() === 'm') toggleMute(video);
  else if (k.toLowerCase() === 'f') toggleFullscreen();
  else if (k === '?') infoDialog('Keyboard shortcuts', shortcutsHtml());
  else return false;
  e.preventDefault();
  return true;
}

document.addEventListener('keydown', (e) => {
  if (!$('#dialog').hidden || !$('#popover').hidden) return;
  if (e.target.matches('input, select, textarea')) return;
  const key = e.key.toLowerCase();
  if (!state.player && state.view === 'match' && state.mp) { matchPageKey(e, key); return; }
  const p = state.player;
  if (!p) {
    // library: Esc clears the selection, Ctrl+A selects everything shown
    if (state.view !== 'library') return;
    if (key === 'escape') clearSelection();
    else if (key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      filteredItems().forEach((i) => state.selected.add(i.path));
      renderLibrary(false);
    }
    return;
  }
  const video = $('#video');
  if (key === 'escape') closePlayer();
  else if (key === ' ' || key === 'k') { e.preventDefault(); if (video.paused) video.play(); else video.pause(); }
  else if (key === 'arrowleft' || key === 'j') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); }
  else if (key === 'arrowright' || key === 'l') { e.preventDefault(); video.currentTime = Math.min(p.duration, video.currentTime + 5); }
  else if (key === 'i') setTrimPoint('start');
  else if (key === 'o') setTrimPoint('end');
  else if (key === 'delete') deleteVideo(p.item.path);
  else if (key === 'n' || key === 'p') {
    const n = neighbourVideo(key === 'n' ? 1 : -1);
    if (n) openPlayer(n.path);
  } else if (key === '[' || key === ']') {
    const t = momentTarget(p.item.markers || [], video.currentTime, key === ']' ? 1 : -1);
    if (t != null) { video.currentTime = t; video.play(); }
  } else if (/^[0-9]$/.test(key) && !e.ctrlKey && !e.altKey) {
    video.currentTime = (Number(key) / 10) * (p.duration || 0);
  } else {
    commonPlayerKey(e, video, { fps: p.item.fps });
  }
});

// ------------------------------------------------------------------ first-run setup

// The setup wizard (js/views/onboarding.js): on the first start (settings.onboarded missing) and
// from Settings → Redo setup. It saves everything on Finish; Skip only marks it as seen.
let setup = null;
function openSetup({ step = 0, redo = false } = {}) {
  if (!mod.onboarding || !state.status || setup) return setup;
  leaveFullscreen();
  if (!$('#dialog').hidden) { $('#dialog').hidden = true; $('#dialog').innerHTML = ''; }
  const before = state.status.settings;
  setup = mod.onboarding.openOnboarding({
    api,
    status: state.status,
    step,
    redo,
    toast,
    onDone: (next, { finished }) => {
      setup = null;
      if (!next) return;
      state.status.settings = next;
      renderTopbar();
      renderSidebar();
      if (state.view === 'settings') renderSettingsKeepScroll();
      if (finished && next.saveDir !== before.saveDir) refreshLibrary();
      if (finished) toast('Setup saved. Change anything in Settings', 'ok');
    },
  });
  return setup;
}

// ------------------------------------------------------------------ settings

function opt(value, label, current) {
  return `<option value="${esc(value)}" ${String(value) === String(current) ? 'selected' : ''}>${esc(label)}</option>`;
}

function row(label, desc, control, id = '') {
  return `<div class="row" ${id ? `id="${id}"` : ''}><div class="lbl"><b>${label}</b>${desc ? `<span>${desc}</span>` : ''}</div><div class="ctl">${control}</div></div>`;
}

function toggle(key, checked) {
  return `<input type="checkbox" class="switch" data-setting="${key}" data-kind="bool" ${checked ? 'checked' : ''}>`;
}

function range(key, min, max, step, value, fmt) {
  return `<div class="range"><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-setting="${key}" data-kind="num" data-fmt="${fmt}"><output>${formatRange(fmt, value)}</output></div>`;
}

function formatRange(fmt, v) {
  v = Number(v);
  if (fmt === 'seconds') return fmtSeconds(v);
  if (fmt === 'percent') return `${v}%`;
  if (fmt === 'ms') return v ? `${v} ms` : 'None';
  return String(v);
}

const HOTKEY_LABELS = {
  saveClip: ['Save clip', 'Saves the replay buffer as a clip'],
  toggleRecording: ['Start / stop recording', 'Records everything until you press it again'],
  toggleBuffer: ['Replay buffer on / off', 'Pauses or resumes background capture'],
  bookmark: ['Bookmark', 'Marks a moment: in League it becomes a highlight, in a recording a marker, otherwise it saves a clip'],
  camBig: ['Death cam: bigger', 'Blows the death cam up to most of the screen, or back to its size. All four death cam keys show along its bottom while it plays'],
  camReplay: ['Death cam: replay', 'Plays the last death cam again'],
  camClose: ['Death cam: close', 'Closes the death cam'],
  camMove: ['Death cam: move + resize', 'The death cam takes the mouse so you can drag it and its corner. Press again to give the mouse back to the game'],
};

// Settings → Death cam → "Where it plays": what the choice means with the screens you have.
function killCamScreenText(s) {
  const where = s.settings.league.killCamScreen;
  const many = s.displays.length > 1;
  const overGame = 'Over the game it\'s small and clicks go through to League. It only shows over League in Borderless or Windowed mode, not Fullscreen.';
  if (where === 'other') return many ? 'Your notification screen, or the first screen that isn\'t the game\'s' : 'You have one screen, so the death cam stays off';
  if (where === 'game') return overGame;
  return many ? 'You have more than one screen, so it plays on your notification screen, or the first screen that isn\'t the game\'s' : `You have one screen, so it plays over the game. ${overGame}`;
}

// Settings whose change shows or hides other rows.
const RERENDER_SETTINGS = ['mic', 'micMode', 'systemAudio', 'audioScope', 'discordAudio', 'videoCodec', 'encoder', 'league.killCamScreen'];

// Settings: the sections on the left, the chosen one on the right (like Windows Settings).
const SETTINGS_SECTIONS = [
  ['general', 'General', 'settings'], ['recording', 'Recording', 'video'], ['audio', 'Audio', 'volume-2'],
  ['hotkeys', 'Hotkeys', 'keyboard'], ['league', 'League of Legends', 'swords'], ['storage', 'Storage', 'hard-drive'],
  ['notifications', 'Notifications', 'monitor'], ['about', 'About', 'info'],
];

// A row of checkboxes for one setting each: [key, label, checked, tooltip].
function checklist(items) {
  return `<div class="checklist">${items.map(([key, label, on, tip]) => `<label class="chk"${tip ? ` title="${esc(tip)}"` : ''}>`
    + `<input type="checkbox" data-setting="${key}" data-kind="bool" ${on ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>`;
}

const group = (title, rows) => `<section class="card-s">${title ? `<h3>${title}</h3>` : ''}${rows}</section>`;

function settingsSection(id, s) {
  const v = s.settings;
  const L = v.league;
  const autoLabel = s.encoders.length ? `Automatic (${encoderLabel(s.encoders[0].id)})` : 'Automatic';
  const method = s.info ? (s.info.method === 'ddagrab' ? 'Desktop Duplication (GPU)' : 'GDI (compatibility)') : 'Not running';
  switch (id) {
    case 'recording':
      return group('Capture', `
      ${row('Monitor', 'Which screen to capture', `<select data-setting="monitor" data-kind="num">${s.displays.map((d) => opt(d.index, d.label, v.monitor)).join('')}</select>`)}
      ${row('Frame rate', 'Higher looks smoother and makes bigger files', `<select data-setting="fps" data-kind="num">${[30, 60, 120, 144].map((f) => opt(f, `${f} fps`, v.fps)).join('')}</select>`)}
      ${row('Resolution', 'Native stays on the GPU and costs no performance. Downscaling uses some CPU.', `<select data-setting="resolution">${[['native', 'Native (same as monitor)'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p']].map(([a, b]) => opt(a, b, v.resolution)).join('')}</select>`)}
      ${row('Quality', 'High suits most people. Ultra roughly doubles file size.', `<select data-setting="quality">${[['low', 'Low (small files)'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']].map(([a, b]) => opt(a, b, v.quality)).join('')}</select>`)}
      ${row('Encoder', 'Your graphics card encodes video almost for free', `<select data-setting="encoder">${opt('auto', autoLabel, v.encoder)}${s.encoders.map((e) => opt(e.id, e.label, v.encoder)).join('')}</select>`)}
      ${row('Video format', codecNote(s), `<select data-setting="videoCodec">${opt('h264', 'H.264 (plays everywhere)', v.videoCodec)}${opt('hevc', 'H.265 / HEVC (smaller files)', v.videoCodec)}</select>`)}
      ${row('Show mouse cursor', '', toggle('drawMouse', v.drawMouse))}`)
        + group('Instant replay', `
      ${row('Replay length', 'How much the Save clip hotkey keeps', range('replaySeconds', 10, 300, 5, v.replaySeconds, 'seconds'))}
      ${row('Replay buffer', 'When ClipVault captures in the background', `<select data-setting="bufferMode">${[['always', 'Always on'], ['games', 'Only while a fullscreen game runs'], ['manual', 'Manual (hotkey or tray)']].map(([a, b]) => opt(a, b, v.bufferMode)).join('')}</select>`)}`);
    case 'audio':
      return group('', `
      ${row('Game sound', 'Record the game\'s sound', toggle('systemAudio', v.systemAudio))}
      ${v.systemAudio ? `
      ${row('Record sound from', v.audioScope === 'game'
        ? 'Only the game: League, or the fullscreen game you\'re playing. Discord, music, your browser and Windows sounds stay out. Add your microphone or Discord below.'
        : 'Everything that comes out of your speakers or headset, Discord and music included.', `<select data-setting="audioScope">${opt('game', 'The game you\'re playing', v.audioScope)}${opt('everything', 'Everything you hear', v.audioScope)}</select>`)}
      ${row('Game volume', '', range('systemVolume', 0, 200, 5, v.systemVolume, 'percent'))}` : ''}
      ${row('Microphone', 'Your default microphone', toggle('mic', v.mic))}
      ${v.mic ? `
      ${row('Microphone mode', 'Push-to-talk records your voice only while you hold a key, like in Discord', `<select data-setting="micMode">${opt('always', 'Always on', v.micMode)}${opt('ptt', 'Push-to-talk', v.micMode)}</select>`)}
      ${v.micMode === 'ptt' ? `
      ${row('Push-to-talk key', '<span id="pttDesc">A keyboard key or a mouse side button. It still works normally in your game.</span>', `<button class="hotkey" data-pttkey="1">${esc(v.pttKey)}</button>`)}
      ${row('Release delay', 'Keeps the mic open a moment after you let go, so the end of a word isn\'t cut off', range('pttReleaseMs', 0, 1000, 50, v.pttReleaseMs, 'ms'))}` : ''}
      ${row('Microphone volume', '', range('micVolume', 0, 200, 5, v.micVolume, 'percent'))}` : ''}
      ${row('Discord voice', v.audioScope === 'everything' && v.systemAudio
        ? 'Discord is already in "Everything you hear". Turn this on to also give it its own track, so it can be left out later.'
        : 'Records the Discord app (your friends\' voices) alongside the game', toggle('discordAudio', v.discordAudio))}
      ${v.discordAudio ? row('Discord volume', '', range('discordVolume', 0, 200, 5, v.discordVolume, 'percent')) : ''}
      ${row('Separate audio tracks', 'Besides the track with everything mixed (what plays by default and in Discord), saves Game, Microphone and Discord as their own tracks. Choose which to hear in the player.', toggle('separateTracks', v.separateTracks))}`);
    case 'hotkeys':
      return group('', Object.keys(HOTKEY_LABELS).map((k) => row(HOTKEY_LABELS[k][0],
        `<span class="${s.hotkeyErrors[k] ? 'err' : ''}" id="hkdesc-${k}">${esc(s.hotkeyErrors[k] || HOTKEY_LABELS[k][1])}</span>`,
        `<button class="hotkey" data-hotkey="${k}">${esc(v.hotkeys[k] || 'Not set')}</button>`)).join(''));
    case 'league':
      return group('Automatic highlights', `
      ${row('Clip key moments automatically', "Reads kills, deaths and objectives from Riot's official Live Client Data API while you play. Works in every mode, including Practice Tool and bot games.", toggle('league.enabled', L.enabled))}
      <div class="row stack"><div class="lbl"><b>Moments to clip</b><span>Kills include multikills, first blood and aces. Objectives are the dragons, Barons, Heralds, Voidgrubs and Atakhans you took part in, steals included.</span></div>
        <div class="ctl">${checklist([
          ['league.kills', 'Kills', L.kills], ['league.deaths', 'Deaths', L.deaths, 'Useful for reviewing what went wrong'], ['league.assists', 'Assists', L.assists],
          ['league.objectives', 'Objectives', L.objectives], ['league.structures', 'Turrets and inhibitors', L.structures],
          ['league.gameEnd', 'Victory / defeat', L.gameEnd, 'The final seconds of the match'],
          ['league.bookmarks', 'Bookmarks', L.bookmarks, `Press ${v.hotkeys.bookmark || 'the Bookmark hotkey'} in a match to save that moment too`],
        ])}</div></div>
      ${row('Time before a moment', '', range('league.before', 5, 45, 1, L.before, 'seconds'))}
      ${row('Time after a moment', '', range('league.after', 2, 20, 1, L.after, 'seconds'))}
      ${row('Keep moments together within', 'Moments closer than this share one clip, so a whole teamfight stays in one video. Clips with four or more kills around them are called teamfights.', range('league.mergeGap', 5, 60, 1, L.mergeGap, 'seconds'))}
      <div class="about" id="leagueStatus">${leagueStatusText(s)}</div>`)
        + group('Each match', `
      ${row('Open the match when the game closes', 'Shows the match page: your stats, the scoreboard and every highlight', toggle('league.openReel', L.openReel))}
      ${row('Also record full matches', 'Saves every game as a recording with all key moments marked on the timeline', toggle('league.recordMatch', L.recordMatch))}
      ${row('Record the minimap for every match', 'Keeps a small recording of just the minimap (about 40 MB a game). It plays next to your clips as a guide to where everyone was.', toggle('league.recordMap', L.recordMap))}
      ${row('Track keyboard and mouse', 'Records which keys and mouse buttons you press while League is in front (never chat) and shows them on your clips with APM stats. Stays on this PC.', toggle('league.trackInputs', L.trackInputs))}`)
        + group('Death cam', `
      ${row('Replay how you died', 'A few seconds after you die, it plays in a small window so you can see what went wrong while you wait to respawn. It never takes focus from the game and isn\'t saved in your clips. Needs Clip key moments automatically or Also record full matches on.', toggle('league.killCam', L.killCam))}
      <div class="row stack"><div class="lbl"><b>Play it for</b><span>Deaths by default. Add kills to watch your plays back too. Moments close together play as one.</span></div>
        <div class="ctl">${checklist([
          ['league.killCamDeaths', 'Deaths', L.killCamDeaths], ['league.killCamKills', 'Kills', L.killCamKills, 'Includes multikills, first blood and aces'],
          ['league.killCamAssists', 'Assists', L.killCamAssists], ['league.killCamObjectives', 'Objectives', L.killCamObjectives, 'Dragons, Barons, Heralds, Voidgrubs and Atakhans you took part in'],
        ])}</div></div>
      ${row('Where it plays', killCamScreenText(s), `<select data-setting="league.killCamScreen">${[['auto', 'Automatic'],['other', 'Only your other screen'], ['game', 'On the game\'s screen']].map(([a, b]) => opt(a, b, L.killCamScreen)).join('')}</select>`)}
      ${row('Corner', 'Automatic is the top left over the game, where League\'s HUD is empty, and the bottom right on another screen', `<select data-setting="league.killCamCorner">${[['auto', 'Automatic'], ['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']].map(([a, b]) => opt(a, b, L.killCamCorner)).join('')}</select>`)}
      ${row('Size', `Medium is a good fit over the game. ${esc(v.hotkeys.camBig || 'The Bigger hotkey')} blows it up to most of the screen while it plays.`, `<select data-setting="league.killCamSize">${[['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['huge', 'Extra large']].map(([a, b]) => opt(a, b, L.killCamSize)).join('')}</select>`)}
      ${row('Zoom in', 'Most players play zoomed all the way out. This zooms into the middle of the picture, where your champion is when the camera is locked.', `<select data-setting="league.killCamZoom" data-kind="num">${[[1, 'Off'], [1.25, '1.25×'], [1.5, '1.5×'], [2, '2×']].map(([a, b]) => opt(a, b, L.killCamZoom)).join('')}</select>`)}
      ${row('Show it after', 'How long after you die it pops up. About 2 seconds is the soonest the footage is ready. Moments in that time play together.', range('league.killCamDelay', 1, 10, 1, L.killCamDelay, 'seconds'))}
      ${row('Time before the moment', 'How much of the lead-up it shows', range('league.killCamBefore', 3, 20, 1, L.killCamBefore, 'seconds'))}
      ${row('Move + resize', L.killCamSpot ? 'It plays where you put it. Size and Corner apply again after a reset.' : `Drag it where you like and drag its corner to resize it. In game: ${esc(v.hotkeys.camMove || 'the Move + resize hotkey')}.`, `<button class="btn sm" data-act="move-killcam">Move + resize</button>${L.killCamSpot ? '<button class="btn sm ghost" data-act="reset-killcam-spot">Reset</button>' : ''}`)}
      ${row('Try it', 'Plays the last few seconds of the replay buffer as a death cam', '<button class="btn sm" data-act="try-killcam">Play</button>')}`);
    case 'storage':
      return group('', `
      ${row('Save folder', 'Each game gets its own folder of MP4 files', `<span class="path" title="${esc(v.saveDir)}">${esc(v.saveDir)}</span><button class="btn sm" data-act="pick-folder">Change…</button><button class="btn sm ghost" data-act="open-folder">Open</button>`)}
      ${row('Storage limit', `When your videos pass this size, the oldest go to the Recycle Bin. Favorites are never removed and don't count. ${esc(usageText())}`,
        `<select data-setting="storageLimitGB" data-kind="num">${[[0, 'No limit'], [25, '25 GB'], [50, '50 GB'], [100, '100 GB'], [200, '200 GB'], [500, '500 GB'], [1000, '1 TB'], [2000, '2 TB']]
          .concat([0, 25, 50, 100, 200, 500, 1000, 2000].includes(v.storageLimitGB) ? [] : [[v.storageLimitGB, `${v.storageLimitGB} GB`]])
          .map(([a, b]) => opt(a, b, v.storageLimitGB)).join('')}</select>`)}`)
        + group('Full match recordings', `
      ${row('Keep separate highlight files when the full match is recorded', `Each highlight is the same footage as part of the full recording. Turn this off to save about a third of each match: once the full recording is checked, highlights play from it and their own files go to the Recycle Bin. Favorites always keep their file.${L.recordMatch ? '' : ' Only matters with <b>Also record full matches</b> on (League of Legends).'}`, toggle('keepHighlightFiles', v.keepHighlightFiles))}
      ${row('Free up space', 'Does the same for the matches you already have. Shows what would go before anything happens.', '<button class="btn sm" data-act="free-space" id="freeSpaceBtn">Preview…</button>')}`);
    case 'notifications':
      return group('', `
      ${row('On-screen notifications', 'Shows a small notification when a clip is saved, a match ends or capture stops. Errors show even when this is off.', toggle('overlay', v.overlay))}
      ${row('During games', 'Off keeps your game clear: nothing pops up while a game runs, only errors', toggle('notifyInGame', v.notifyInGame))}
      ${row('Notification screen', 'Put notifications on a second screen to keep them off your game', `<select data-setting="notifyMonitor" data-kind="num">${opt(-1, 'Same screen as the game', v.notifyMonitor)}${s.displays.map((d) => opt(d.index, d.label, v.notifyMonitor)).join('')}</select>`)}
      ${row('Sounds', 'Plays a short sound when a clip or recording is saved', toggle('clipSound', v.clipSound))}`);
    case 'about':
      return group('', `<div class="about"><b>ClipVault ${esc(s.version)}</b>: a free game recorder with no ads, no account, no uploads, no tracking and no watermark. Everything stays on this PC. Powered by FFmpeg.</div>`)
        + group('Updates', `
      ${updateRow(s)}
      ${row('Check for updates automatically', 'Asks GitHub once a day whether a new version is out. Nothing is downloaded or installed by itself.', toggle('checkUpdates', v.checkUpdates))}
      ${row('Check for updates', `<span id="updateResult">${esc(updateResultText(s.update))}</span>`, '<button class="btn sm" data-act="check-updates" id="checkUpdatesBtn">Check now</button>')}`)
        + group('Help', `
      ${row('Report a bug', 'Opens a new issue on GitHub with your description and, if you like, system info filled in', '<button class="btn sm" data-act="report-bug">Report a bug…</button>')}`)
        + group('Diagnostics', `
      ${row('Encoder', '', `<span class="val">${esc(encoderLabel(s.info ? s.info.encoder : s.encoder))}</span>`)}
      ${row('Capture method', '', `<span class="val">${esc(method)}</span>`)}
      ${row('Log file', 'What ClipVault did recently, for when something goes wrong', '<button class="btn sm ghost" data-act="open-log">Show in folder</button>')}`);
    default:
      return group('', `
      ${row('Theme', 'How ClipVault looks', `<select data-setting="theme">${[['gray', 'Gray'], ['midnight', 'Midnight blue'], ['light', 'Light']].map(([k, label]) => opt(k, label, v.theme || 'gray')).join('')}</select>`)}
      ${row('Start with Windows', 'Opens quietly in the tray when you sign in', toggle('startWithWindows', v.startWithWindows))}
      ${row('Start minimized', 'Open in the tray instead of showing this window', toggle('startMinimized', v.startMinimized))}`);
  }
}

function renderSettings() {
  const s = state.status;
  if (!s) return;
  const cur = SETTINGS_SECTIONS.some(([id]) => id === state.settingsSection) ? state.settingsSection : 'general';
  const [, title] = SETTINGS_SECTIONS.find(([id]) => id === cur);
  const nav = SETTINGS_SECTIONS.map(([id, name, ic]) => `<button type="button" class="set-nav-item${id === cur ? ' active' : ''}" data-act="settings-section" data-section="${id}"${id === cur ? ' aria-current="page"' : ''}>${spriteIcon(ic)}<span>${esc(name)}</span></button>`).join('');
  const extra = cur === 'hotkeys' ? '<button type="button" class="link-btn" data-act="reset-hotkeys">Reset to defaults</button>' : '';
  $('#content').innerHTML = `<div class="settings">
    <nav class="set-nav" aria-label="Settings sections"><h1>Settings</h1>${nav}</nav>
    <div class="set-body">
      ${mod.onboarding ? `<section class="redo-setup"><div class="lbl"><b>Setup</b><span>Go through the death cam, recording, notifications, save folder and quality again</span></div>
        <button type="button" class="btn sm" data-act="redo-setup">Redo setup</button></section>` : ''}
      <header class="set-head"><h2>${esc(title)}</h2><span class="saved-pill" id="savedPill">Saved</span><span class="spacer"></span>${extra}</header>
      ${cur === 'general' ? '<p class="lead">Changes save automatically. Capture restarts by itself when a change needs it.</p>' : ''}
      ${settingsSection(cur, s)}
    </div>
  </div>`;
}

function codecNote(s) {
  const canHevc = (s.encoders || []).some((e) => e.hevc);
  if (s.settings.videoCodec === 'hevc' && s.codec !== 'hevc') {
    return `<span class="err">The selected encoder can't make H.265, so H.264 is used.</span>`;
  }
  return canHevc
    ? 'H.265 makes files about half the size at the same quality. Some older devices and editors can\'t play it; shared copies are always H.264.'
    : 'H.265 needs an NVIDIA, AMD or Intel graphics encoder.';
}

// Free up space (virtual clips): a read-only preview of which highlight files would go, then a
// confirm. Only matches whose full recording checks out are touched; favorites never are.
async function freeUpSpace(btn) {
  if (!api.previewFreeSpace) return;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  let preview;
  try {
    preview = await attempt(() => api.previewFreeSpace(), "Couldn't check the full recordings");
  } finally {
    btn.disabled = false;
    btn.textContent = 'Preview…';
  }
  if (!preview) return;
  const ready = preview.matches.filter((m) => m.clips > 0);
  const kept = preview.matches.filter((m) => !m.clips && (m.problem || m.refused));
  if (!ready.length) {
    toast(kept.length
      ? `Nothing to free up: ${kept.length === 1 ? 'one match\'s full recording' : `${kept.length} matches' full recordings`} couldn't be checked, so their highlights stay`
      : 'Nothing to free up: no match has both a full recording and separate highlight files', 'info');
    return;
  }
  const label = (pm) => {
    const m = findMatch(pm.key);
    const who = (m && m.champion) || 'Match';
    const when = m && m.start ? fmtDate(m.start) : '';
    return [who, when, `${pm.clips} highlight${pm.clips === 1 ? '' : 's'}`, fmtSize(pm.bytes)].filter(Boolean).join(' · ');
  };
  const list = ready.map(label);
  if (kept.length) list.push(`Kept as they are: ${kept.length} match${kept.length === 1 ? '' : 'es'} whose full recording couldn't be checked`);
  const ok = await confirmDialog({
    title: `Free up ${fmtSize(preview.bytes)}?`,
    body: `${preview.clips} highlight file${preview.clips === 1 ? '' : 's'} from ${ready.length} match${ready.length === 1 ? '' : 'es'} go to the Recycle Bin. `
      + 'They keep playing from each match\'s full recording, and favorites keep their file. If a full recording is deleted later, its favorites and best highlights are saved as files first.',
    confirm: 'Free up space',
    danger: true,
    list,
  });
  if (!ok) return;
  const files = ready.flatMap((m) => m.files);
  const res = await attempt(() => api.freeUpSpace(preview.token), "Couldn't free up space");
  if (!res) return;
  await refreshLibrary();
  if (!res.clips) { toast(res.stopped ? 'Stopped: a game started' : 'Nothing changed: the files changed since the preview', 'info'); return; }
  toast(`Freed ${fmtSize(res.bytes)}: ${res.clips} highlight${res.clips === 1 ? '' : 's'} now play from the full recording${res.stopped ? ' (stopped early: a game started)' : ''}`, 'ok', {
    ms: 8000,
    action: {
      label: 'Undo',
      // Every highlight gets its own file back, cut losslessly from the full recording.
      run: async () => {
        let n = 0;
        for (const f of files) if (await attempt(() => api.prepareFile(f).then(() => true), "Couldn't restore a highlight")) n++;
        await refreshLibrary();
        toast(`${n} highlight file${n === 1 ? '' : 's'} restored`, 'ok');
      },
    },
  });
}

function usageText() {
  const total = state.items.reduce((a, i) => a + (i.size || 0), 0);
  const fav = state.items.filter((i) => i.favorite).reduce((a, i) => a + (i.size || 0), 0);
  return `Now using ${fmtSize(total)}${fav ? ` (${fmtSize(fav)} in favorites)` : ''}.`;
}

// Push-to-talk key: a single key (left / right modifiers count as different keys) or a mouse
// button other than left / right. Names match the keyboard drawn in the player.
const PTT_CODES = {
  ShiftLeft: 'LShift', ShiftRight: 'RShift', ControlLeft: 'LCtrl', ControlRight: 'RCtrl', AltLeft: 'LAlt', AltRight: 'RAlt',
  MetaLeft: 'LWin', MetaRight: 'RWin', CapsLock: 'Caps', Tab: 'Tab', Space: 'Space', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Backspace: 'Backspace', Enter: 'Enter',
  Pause: 'Pause', ScrollLock: 'ScrollLock', PrintScreen: 'PrtSc', NumLock: 'NumLock', ContextMenu: 'Menu',
};

function pttNameFromKey(e) {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(c)) return c;
  if (/^Numpad\d$/.test(c)) return `Num${c.slice(6)}`;
  return PTT_CODES[c] || null;
}

function capturePttKey(btn) {
  const desc = $('#pttDesc');
  const original = btn.textContent;
  btn.classList.add('capturing');
  btn.textContent = 'Press a key or mouse button… (Esc to cancel)';
  api.suspendHotkeys(true);
  const finish = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onMouse, true);
    btn.removeEventListener('blur', cancel);
    btn.classList.remove('capturing');
    api.suspendHotkeys(false);
  };
  const cancel = () => { finish(); btn.textContent = original; };
  const save = async (name) => {
    finish();
    btn.textContent = name;
    if (await saveSetting({ pttKey: name }) && desc) desc.textContent = `Hold ${name} to talk. It still works normally in your game.`;
  };
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { cancel(); return; }
    const name = pttNameFromKey(e);
    if (name) save(name);
    else if (desc) desc.textContent = "That key can't be used. Try another one.";
  };
  const onMouse = (e) => {
    const name = { 1: 'MouseMiddle', 3: 'Mouse4', 4: 'Mouse5' }[e.button];
    if (!name) return; // left / right click keep working (and cancel via blur)
    e.preventDefault();
    e.stopPropagation();
    save(name);
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onMouse, true);
  btn.addEventListener('blur', cancel);
}

function leagueStatusText(s) {
  if (s.league) {
    return `<b>In a match${s.league.champion ? ` as ${esc(s.league.champion)}` : ''}</b> · ${s.league.clips} highlight${s.league.clips === 1 ? '' : 's'} saved so far`;
  }
  return 'Waiting for a League match. Just play: ClipVault notices the game, turns on capture and saves the highlights to <b>Matches</b>.';
}

// Settings → About → Updates. u: the main process's update state (update.js), or null.
function updateResultText(u) {
  if (!u || u.status === 'idle') return 'Not checked yet';
  if (u.status === 'checking') return 'Checking…';
  const when = u.checkedAt ? ` · checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  if (u.status === 'available') return `A new version is out${when}`;
  if (u.status === 'failed') return `${u.message || "Couldn't check"}. Try again later${when}`;
  // 'none' with a message is GitHub's 404 (no release published yet): nothing newer, said quietly.
  return `You have the latest version${when}`;
}

// The new version, its notes (plain text, escaped) and Download, which opens its GitHub page.
function updateRow(s) {
  const r = s.update && s.update.release;
  if (!r) return '';
  return `<div class="row update-row" id="updateRow"><div class="lbl"><b>ClipVault ${esc(r.version)} is available</b>
    <span>You have ${esc(s.version)}. Download the new version from GitHub and run it to update.</span>
    ${r.notes ? `<span class="notes">${esc(r.notes)}</span>` : ''}</div>
    <div class="ctl"><button class="btn sm primary" data-act="download-update">${spriteIcon('download')}Download</button></div></div>`;
}

let savedTimer;
function flashSaved() {
  const pill = $('#savedPill');
  if (!pill) return;
  pill.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => pill.classList.remove('show'), 1400);
}

async function saveSetting(patch) {
  const next = await attempt(() => api.setSettings(patch), "Couldn't save setting");
  if (next) {
    state.status.settings = next;
    renderTopbar();
    flashSaved();
  }
  return next;
}

$('#content').addEventListener('input', (e) => {
  const el = e.target;
  if (el.type === 'range' && el.dataset.setting) el.nextElementSibling.textContent = formatRange(el.dataset.fmt, el.value);
});

$('#content').addEventListener('change', (e) => {
  const el = e.target;
  const key = el.dataset.setting;
  if (!key) return;
  let value = el.value;
  if (el.dataset.kind === 'bool') value = el.checked;
  else if (el.dataset.kind === 'num') value = Number(el.value);
  if (key === 'theme') applyTheme(value);
  const [group, sub] = key.split('.');
  saveSetting(sub ? { [group]: { [sub]: value } } : { [key]: value }).then((next) => {
    if (!next) return;
    if (key === 'storageLimitGB') renderSidebar();
    if (!RERENDER_SETTINGS.includes(key) || state.view !== 'settings') return;
    const scroll = $('#content').scrollTop;
    renderSettings();
    $('#content').scrollTop = scroll;
  });
});

$('#content').addEventListener('click', async (e) => {
  if (state.view !== 'settings') return;
  const act = e.target.closest('[data-act]');
  if (act && act.dataset.act === 'settings-section') {
    state.settingsSection = act.dataset.section;
    setPref('settingsSection', state.settingsSection);
    renderSettings();
    $('#content').scrollTop = 0;
    const btn = $(`.set-nav-item[data-section="${CSS.escape(state.settingsSection)}"]`);
    if (btn) btn.focus({ preventScroll: true });
    return;
  }
  if (act && act.dataset.act === 'redo-setup') { openSetup({ redo: true }); return; }
  if (act && act.dataset.act === 'free-space') { freeUpSpace(act); return; }
  if (act && act.dataset.act === 'move-killcam') { attempt(() => api.moveKillCam(), "Couldn't show the death cam"); return; }
  if (act && act.dataset.act === 'reset-killcam-spot') { attempt(() => api.resetKillCamSpot(), "Couldn't reset the death cam"); return; }
  if (act && act.dataset.act === 'try-killcam') {
    if (act.disabled) return;
    act.disabled = true; // one cam at a time
    attempt(() => api.tryKillCam(), "Couldn't play the death cam").finally(() => { act.disabled = false; });
    return;
  }
  if (act && act.dataset.act === 'check-updates') {
    if (act.disabled) return;
    act.disabled = true;
    const res = $('#updateResult');
    if (res) res.textContent = 'Checking…';
    const u = await attempt(() => api.checkForUpdates(), "Couldn't check for updates");
    act.disabled = false;
    if (u) { state.status.update = u; renderSettingsKeepScroll(); }
    return;
  }
  if (act && act.dataset.act === 'download-update') { api.openUpdate(); return; }
  if (act && act.dataset.act === 'report-bug') { bugReportDialog(); return; }
  if (act && act.dataset.act === 'open-log' && api.showLog) api.showLog();
  if (act && act.dataset.act === 'open-folder') api.openFolder();
  if (act && act.dataset.act === 'pick-folder') {
    const dir = await api.pickFolder();
    if (dir && (await saveSetting({ saveDir: dir }))) { renderSettings(); refreshLibrary(); }
  }
  if (act && act.dataset.act === 'reset-hotkeys') {
    const next = await attempt(() => api.resetHotkeys(), "Couldn't reset hotkeys");
    if (next) { state.status.settings = next; renderTopbar(); renderSettings(); flashSaved(); }
  }
  const hk = e.target.closest('[data-hotkey]');
  if (hk) captureHotkey(hk);
  const ptt = e.target.closest('[data-pttkey]');
  if (ptt) capturePttKey(ptt);
});

// Turns a keydown into an Electron accelerator string like "Ctrl+Shift+F9".
function acceleratorFrom(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const c = e.code;
  let key = null;
  if (/^F([1-9]|1\d|2[0-4])$/.test(c)) key = c;
  else if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^Numpad\d$/.test(c)) key = `num${c.slice(6)}`;
  else {
    key = {
      Space: 'Space', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backquote: '`', Minus: '-', Equal: '=',
      BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
      NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
      PrintScreen: 'PrintScreen', Pause: 'MediaPlayPause', ScrollLock: 'Scrolllock',
    }[c] || null;
  }
  if (!key) return null;
  const standalone = /^F\d+$/.test(key) || key.startsWith('num') || ['PrintScreen', 'Scrolllock', 'Insert'].includes(key);
  if (!mods.length && !standalone) return { error: 'Add Ctrl, Alt or Shift to that key' };
  return { accel: [...mods, key].join('+') };
}

function captureHotkey(btn) {
  const action = btn.dataset.hotkey;
  const desc = $(`#hkdesc-${action}`);
  const original = btn.textContent;
  btn.classList.add('capturing');
  btn.textContent = 'Press keys… (Esc to cancel)';
  api.suspendHotkeys(true);

  const finish = () => {
    document.removeEventListener('keydown', onKey, true);
    btn.removeEventListener('blur', cancel);
    btn.classList.remove('capturing');
    api.suspendHotkeys(false);
  };
  const cancel = () => { finish(); btn.textContent = original; };
  const onKey = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { cancel(); return; }
    const r = acceleratorFrom(e);
    if (!r) return; // only modifiers so far
    if (r.error) { desc.textContent = r.error; desc.className = 'err'; return; }
    const hotkeys = state.status.settings.hotkeys;
    const clash = Object.keys(hotkeys).find((k) => k !== action && hotkeys[k] === r.accel);
    if (clash) { desc.textContent = `${r.accel} is already used for "${HOTKEY_LABELS[clash][0]}"`; desc.className = 'err'; return; }
    finish();
    btn.textContent = r.accel;
    const next = await saveSetting({ hotkeys: { [action]: r.accel } });
    if (next) { desc.textContent = HOTKEY_LABELS[action][1]; desc.className = ''; }
  };
  document.addEventListener('keydown', onKey, true);
  btn.addEventListener('blur', cancel);
}

function renderSettingsKeepScroll() {
  const scroll = $('#content').scrollTop;
  renderSettings();
  $('#content').scrollTop = scroll;
}

let updateSig = '';
function updateSettingsStatus(s) {
  // About: a check finished (from the timer or Check now), so show what it found.
  const sig = JSON.stringify(s.update || null);
  if (sig !== updateSig) {
    updateSig = sig;
    if (state.settingsSection === 'about' && $('#updateResult')) { renderSettingsKeepScroll(); return; }
  }
  // Death cam → Move or resize: dragging the cam (or Reset) changes what the row says and whether
  // it has a Reset button.
  if ($('[data-act="move-killcam"]') && s.settings && Boolean(s.settings.league.killCamSpot) !== Boolean($('[data-act="reset-killcam-spot"]'))) {
    renderSettingsKeepScroll();
    return;
  }
  const ls = $('#leagueStatus');
  if (ls) ls.innerHTML = leagueStatusText(s);
  for (const k of Object.keys(HOTKEY_LABELS)) {
    const d = $(`#hkdesc-${k}`);
    if (d && !d.closest('.row').querySelector('.capturing')) {
      d.textContent = s.hotkeyErrors[k] || HOTKEY_LABELS[k][1];
      d.className = s.hotkeyErrors[k] ? 'err' : '';
    }
  }
}

// ------------------------------------------------------------------ boot

let libTimer;
const refreshSoon = () => {
  clearTimeout(libTimer);
  libTimer = setTimeout(refreshLibrary, 200);
};
api.onLibraryChanged(refreshSoon);
if (api.onMatchesChanged) api.onMatchesChanged(refreshSoon); // a match record got its stats

api.onStatus((s) => {
  const hadEncoders = state.status && state.status.encoders.length;
  state.status = s;
  applyTheme(s.settings && s.settings.theme);
  renderTopbar();
  if (state.view === 'settings') {
    if (!hadEncoders && s.encoders.length) renderSettings();
    else updateSettingsStatus(s);
  }
});

api.onToast(({ text, kind, sticky }) => toast(text, kind, sticky));
api.onBugReport(() => bugReportDialog()); // tray menu → Report a bug

// The theme (Settings > General): tokens.css redefines its colours under :root[data-theme].
function applyTheme(theme) {
  const t = ['gray', 'midnight', 'light'].includes(theme) ? theme : 'gray';
  if (document.documentElement.dataset.theme !== t) document.documentElement.dataset.theme = t;
}

// Range inputs draw their groove filled up to the value; CSS reads --fill (styles.css).
function paintRange(r) {
  const min = Number(r.min) || 0;
  const max = r.max === '' ? 100 : Number(r.max);
  const f = max > min ? ((Number(r.value) - min) / (max - min)) * 100 : 0;
  r.style.setProperty('--fill', `${Math.max(0, Math.min(100, f))}%`);
}
document.addEventListener('input', (e) => { if (e.target.matches && e.target.matches('input[type="range"]')) paintRange(e.target); }, true);
new MutationObserver(() => { for (const r of document.querySelectorAll('input[type="range"]')) paintRange(r); })
  .observe(document.body, { childList: true, subtree: true });
// A match just ended: show its match page (post-game summary, highlights, minimap).
api.onOpenReel(async (mapFile) => {
  await refreshLibrary();
  if (!state.items.some((i) => i.path === mapFile)) return;
  if (!state.player && !state.mp && state.view !== 'library') navigate('library');
  if (state.player) closePlayer();
  if (!openMatchOf(findItem(mapFile), { highlightMode: true })) openPlayer(mapFile);
});
// --view=player[-heat][-overlay][@<panel size px>]  (opens the newest video; used for demos/tests)
api.onNavigate((view) => {
  // --view=onboarding[@<step>]: the first-run setup at that step (screenshot tests)
  const ob = /^onboarding(?:@(\d+))?$/.exec(view);
  if (ob) { openSetup({ step: Number(ob[1] || 0) }); return; }
  // --view=matches | matches-expanded | match-menu | clips (screenshot tests)
  const mv = /^(matches|matches-expanded|match-menu|clips)$/.exec(view);
  if (mv) {
    state.filter.type = view === 'clips' ? 'clips' : 'matches';
    state.filter.game = null;
    const first = groups().matches[0];
    if (view !== 'clips' && view !== 'matches' && first) state.matchUi.expandedKey = first.key;
    navigate('library');
    const btn = first && document.querySelector(`.mv-page [data-act="match-menu"][data-key="${CSS.escape(first.key)}"]`);
    if (view === 'match-menu' && btn) openMatchMenu(mod.matches.renderMatchMenu(first), btn.getBoundingClientRect());
    return;
  }
  // --view=match[-scoreboard|-highlights][@<game second>]: the newest match's page, paused.
  // A negative second is the pre-roll before the game clock starts (loading screen); the page
  // keeps it within the recording, so far below its start opens at the very beginning.
  const mp = /^match(?:-(scoreboard|highlights))?(?:@(-?\d+(?:\.\d+)?))?$/.exec(view);
  if (mp) {
    const first = groups().matches[0];
    navigate('library');
    if (first) openMatchPage(first.key, { tab: mp[1] || 'watch', at: mp[2] ? Number(mp[2]) : null, play: false });
    return;
  }
  navigate(view);
  const m = /^player(-heat)?(-overlay)?(?:@(\d+))?$/.exec(view);
  if (!m) return;
  const prefs = kbPrefs();
  saveKbPrefs({
    ...prefs,
    ...(m[1] ? { mode: 'heat' } : {}),
    ...(m[3] ? { size: Number(m[3]) } : {}),
    overlay: { ...prefs.overlay, on: Boolean(m[2]) },
  });
  if (state.items.length) openPlayer(state.items[0].path);
});

(async () => {
  await loadModules();
  state.status = await api.getState();
  applyTheme(state.status.settings && state.status.settings.theme);
  [state.items, state.matchRows] = await Promise.all([listItems(), listMatchRows()]);
  // Open on Matches when there are League matches; otherwise on the clips.
  if (mod.group) state.filter.type = groups().matches.length ? 'matches' : 'clips';
  renderTopbar();
  renderSidebar();
  renderLibrary(true);
  // First start (or settings from before the setup existed): the setup, once. In a window that
  // starts hidden (--hidden, Start with Windows) it waits there until the window is opened.
  if (mod.onboardingLib && !state.status.automated && mod.onboardingLib.needsOnboarding(state.status.settings)) openSetup();
})();
