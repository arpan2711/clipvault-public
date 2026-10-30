// Update check: asks GitHub Releases whether a newer ClipVault is out. Only tells you about it
// (a toast and a row in Settings → About with a Download button); nothing is installed.
//
// There's no installer yet, so a real auto-update isn't possible. When ClipVault is packaged
// (electron-builder + NSIS), electron-updater can take over the download / install part: give
// UpdateChecker an `install` step that calls autoUpdater.downloadUpdate() / quitAndInstall() and
// keep this check (or autoUpdater.checkForUpdates()) as the source of the "available" state.
const { EventEmitter } = require('events');

// The GitHub repository releases and bug reports go to.
const REPO = 'arpan2711/clipvault-public'; // the public repo: releases (updates) and issues (bug reports)
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const FIRST_CHECK_MS = 30 * 1000;
const EVERY_MS = 24 * 60 * 60 * 1000;
const NOTES_MAX = 600; // release notes shown in Settings are cut to this many characters

// "v1.2.3", "1.2", "1.2.3-beta.1" -> { major, minor, patch, pre: 'beta.1' | '' }, or null.
function parseVersion(s) {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(String(s || ''));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] || 0), patch: Number(m[3] || 0), pre: m[4] || '' };
}

// -1, 0 or 1, like a sort compare. A prerelease comes before its release (1.2.0-beta < 1.2.0);
// prerelease parts compare number by number, else as text. Unparseable versions count as 0.0.0.
function compareVersions(a, b) {
  const x = parseVersion(a) || { major: 0, minor: 0, patch: 0, pre: '' };
  const y = parseVersion(b) || { major: 0, minor: 0, patch: 0, pre: '' };
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const xs = x.pre.split('.');
  const ys = y.pre.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    const nx = /^\d+$/.test(xs[i]);
    const ny = /^\d+$/.test(ys[i]);
    if (nx && ny && Number(xs[i]) !== Number(ys[i])) return Number(xs[i]) < Number(ys[i]) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    if (xs[i] !== ys[i]) return xs[i] < ys[i] ? -1 : 1;
  }
  return 0;
}

// Only release pages on github.com are ever opened.
function safeReleaseUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.hostname === 'github.com' ? u.href : null;
  } catch {
    return null;
  }
}

// Release notes as short plain text (Markdown markers dropped; the UI escapes it).
function shortNotes(body, max = NOTES_MAX) {
  const text = String(body || '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links keep their text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`]{1,3}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// The newer release in a /releases/latest answer, or null when it isn't newer (or is a draft or a
// prerelease and prereleases are off).
function newerRelease(json, current, { prereleases = false } = {}) {
  if (!json || typeof json !== 'object' || json.draft) return null;
  const v = parseVersion(json.tag_name);
  if (!v || ((json.prerelease || v.pre) && !prereleases)) return null;
  if (compareVersions(json.tag_name, current) <= 0) return null;
  return {
    version: String(json.tag_name).trim().replace(/^v/i, ''),
    name: String(json.name || '').slice(0, 120),
    notes: shortNotes(json.body),
    url: safeReleaseUrl(json.html_url) || `https://github.com/${REPO}/releases/latest`,
    publishedAt: json.published_at || null,
  };
}

// state: { status: 'idle' | 'checking' | 'none' | 'available' | 'failed', checkedAt, release, message }
// Events: 'change' (state), 'available' (release) once per new version.
// fetchJson(url) resolves the parsed JSON or rejects (err.status set for an HTTP error).
class UpdateChecker extends EventEmitter {
  constructor({ current, fetchJson, enabled = () => true, prereleases = () => false, log = () => {} }) {
    super();
    this.current = current;
    this.fetchJson = fetchJson;
    this.enabled = enabled;
    this.prereleases = prereleases;
    this.log = log;
    this.value = { status: 'idle', checkedAt: null, release: null, message: '' };
    this.announced = null; // the version 'available' was last emitted for
    this.timers = [];
    this.running = null;
  }

  state() {
    return { ...this.value, release: this.value.release ? { ...this.value.release } : null };
  }

  // On start (after a short delay) and once a day; each run does nothing while the setting is off.
  start({ firstMs = FIRST_CHECK_MS, everyMs = EVERY_MS } = {}) {
    this.stop();
    const auto = () => { if (this.enabled()) this.check().catch(() => {}); };
    this.timers.push(setTimeout(auto, firstMs), setInterval(auto, everyMs));
    for (const t of this.timers) if (t.unref) t.unref();
  }

  stop() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
  }

  // Never rejects: a failure (offline, no releases yet, a private repo) becomes the state.
  check() {
    if (this.running) return this.running;
    this._set({ status: 'checking', message: '' });
    this.running = (async () => {
      try {
        const json = await this.fetchJson(RELEASES_API);
        const release = newerRelease(json, this.current, { prereleases: this.prereleases() });
        if (release) {
          this._set({ status: 'available', checkedAt: Date.now(), release, message: '' });
          if (this.announced !== release.version) {
            this.announced = release.version;
            this.emit('available', release);
          }
        } else {
          this._set({ status: 'none', checkedAt: Date.now(), release: null, message: '' });
        }
      } catch (err) {
        // 404: no release published yet (or the repo isn't public), so there's nothing newer.
        if (err && err.status === 404) {
          this._set({ status: 'none', checkedAt: Date.now(), release: null, message: 'No releases published yet' });
        } else {
          this.log(`update check failed: ${err && err.message ? err.message : err}`);
          this._set({ status: 'failed', checkedAt: Date.now(), message: "Couldn't reach GitHub" });
        }
      } finally {
        this.running = null;
      }
      return this.state();
    })();
    return this.running;
  }

  _set(patch) {
    this.value = { ...this.value, ...patch };
    this.emit('change', this.state());
  }
}

module.exports = { REPO, RELEASES_API, parseVersion, compareVersions, safeReleaseUrl, shortNotes, newerRelease, UpdateChecker };
