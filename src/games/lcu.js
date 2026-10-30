// Read-only client for the League Client API (the "LCU"), which the League client serves on the
// loopback interface while it runs. The game itself never exposes damage, gold, exact CS, the
// game ID or LP; the client has them around a match (A4 §3), so ClipVault asks it then.
//
// Riot's rules for LCU tools, enforced here rather than left to callers:
// - Only GET requests. `METHOD` is the only method this module can send, and it has no other
//   request function.
// - Only the paths in `ALLOWED` (game flow, end-of-game stats, match history, ranked, summoner).
// - Only loopback. The client's certificate is self-signed, so the certificate check is off for
//   loopback only, and any other host is refused.
// - The password in the client's lockfile is a full-privilege credential: it stays inside this
//   module and is never logged, stored or put in a URL.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const METHOD = 'GET';
const TIMEOUT_MS = 3000;
const MAX_BYTES = 32 * 1024 * 1024; // a timeline is a few hundred KB; anything near this is wrong
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
// A4 §5.4: match history is usually ready within a minute; retry with this backoff (ms).
const BACKOFF = [2000, 4000, 8000, 15000, 15000, 15000];
const PHASE = '/lol-gameflow/v1/gameflow-phase';

// Every path this client may request.
const ALLOWED = [
  /^\/lol-gameflow\/v1\/(gameflow-phase|session)$/,
  /^\/lol-end-of-game\/v1\/(eog-stats-block|gameclient-eog-stats-block)$/,
  /^\/lol-match-history\/v1\/(games|game-timelines)\/\d{1,20}$/,
  /^\/lol-match-history\/v1\/products\/lol\/current-summoner\/matches$/,
  /^\/lol-ranked\/v1\/(current-ranked-stats|current-lp-change-notification)$/,
  /^\/lol-summoner\/v1\/current-summoner$/,
];

const isAllowed = (p) => typeof p === 'string' && ALLOWED.some((re) => re.test(p));

// The League install folder, from the Riot Client's list of installed games (the key of
// `associated_client` that names League), or null when League isn't installed.
function leagueInstallDir({ programData = process.env.ProgramData || 'C:\\ProgramData' } = {}) {
  try {
    const installs = JSON.parse(fs.readFileSync(path.join(programData, 'Riot Games', 'RiotClientInstalls.json'), 'utf8'));
    const dir = Object.keys(installs.associated_client || {}).find((d) => /league of legends/i.test(d));
    return dir ? path.resolve(dir) : null;
  } catch {
    return null;
  }
}

// "<name>:<pid>:<port>:<password>:<protocol>", written by the client while it runs. The password
// is a non-enumerable property, so logging or serializing the result can't reveal it.
function parseLockfile(text) {
  const parts = String(text || '').trim().split(':');
  if (parts.length < 5) return null;
  const port = Number(parts[2]);
  const protocol = parts[parts.length - 1].toLowerCase();
  const password = parts.slice(3, -1).join(':');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !password || !/^https?$/.test(protocol)) return null;
  const info = { name: parts[0], pid: Number(parts[1]) || null, port, protocol };
  Object.defineProperty(info, 'password', { value: password, enumerable: false });
  return info;
}

function readLockfileAt(file) {
  try {
    return parseLockfile(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // no lockfile: the client isn't running
  }
}

// The lockfile in a League install folder, or null when the client isn't running.
function readLockfile(dir) {
  return dir ? readLockfileAt(path.join(dir, 'lockfile')) : null;
}

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal && signal.aborted) { resolve(); return; }
  const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  if (signal) signal.addEventListener('abort', done, { once: true });
});

// Calls fn until it returns an acceptable value, waiting delays[i] ms before attempt i + 2.
// A thrown error counts as a failed attempt. Returns the value, or null once every attempt failed.
async function retry(fn, { delays = BACKOFF, accept = (v) => v != null, signal } = {}) {
  for (let i = 0; ; i++) {
    if (signal && signal.aborted) return null;
    try {
      const value = await fn();
      if (accept(value)) return value;
    } catch { /* not there yet: try again */ }
    if (i >= delays.length) return null;
    await sleep(delays[i], signal);
  }
}

function loopbackOrigin(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('LCU address is not a URL'); }
  if (!/^https?:$/.test(url.protocol) || !LOOPBACK.has(url.hostname)) throw new Error('The League client API is only used on this PC (loopback)');
  return url.origin;
}

// One request. Resolves { status, body } or rejects with a network error; the password is only
// ever in the Authorization header, which no error message includes.
function send(origin, auth, p, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(p, origin);
    const mod = url.protocol === 'https:' ? https : http;
    let deadline = null;
    const fail = (err) => { clearTimeout(deadline); reject(err); };
    const req = mod.request(url, {
      method: METHOD,
      headers: { Authorization: auth, Accept: 'application/json' },
      rejectUnauthorized: !LOOPBACK.has(url.hostname),
      agent: false, // a fresh connection each time: the client changes port when it restarts
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) req.destroy(new Error('LCU response too large'));
        else chunks.push(c);
      });
      res.on('end', () => {
        clearTimeout(deadline);
        if (!res.complete) { reject(new Error('LCU connection closed early')); return; }
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', fail);
    });
    const timedOut = () => req.destroy(Object.assign(new Error('LCU request timed out'), { code: 'ETIMEDOUT' }));
    // The socket timeout catches a silent client; the deadline catches one that trickles bytes.
    deadline = setTimeout(timedOut, timeoutMs);
    req.on('timeout', timedOut);
    req.on('error', fail);
    req.end();
  });
}

// A client for the running League client. Options (all optional):
//   installDir  League install folder (default: leagueInstallDir(), looked up on each connect)
//   lockfile    path of the lockfile, instead of <installDir>\lockfile
//   baseUrl     fixed loopback address, e.g. "http://127.0.0.1:2995" (testing: --lcu-api=)
//   password    fixed password (testing); otherwise it comes from the lockfile
//   timeoutMs   per request (default 3 s)
// get(path) resolves the parsed JSON, or null when the client isn't running (no lockfile,
// connection refused), the thing isn't there (404, or 204) or the password is refused even after
// re-reading the lockfile. It throws for a path outside ALLOWED, a timeout, other HTTP errors and
// unreadable JSON.
function createClient({ installDir, lockfile, baseUrl, password, timeoutMs = TIMEOUT_MS } = {}) {
  const fixedOrigin = baseUrl ? loopbackOrigin(baseUrl) : null;
  const lockPath = () => {
    if (lockfile) return lockfile;
    const dir = installDir || leagueInstallDir();
    return dir ? path.join(dir, 'lockfile') : null;
  };
  let creds = null; // { origin, auth }; auth is the ready-made header value
  let last = 'idle';

  const load = () => {
    const file = password == null || !fixedOrigin ? lockPath() : null;
    const lock = file ? readLockfileAt(file) : null;
    const origin = fixedOrigin || (lock ? loopbackOrigin(`${lock.protocol}://127.0.0.1:${lock.port}`) : null);
    const pass = password != null ? String(password) : lock ? lock.password : null;
    return origin && pass ? { origin, auth: `Basic ${Buffer.from(`riot:${pass}`).toString('base64')}` } : null;
  };
  const same = (a, b) => Boolean(a && b && a.origin === b.origin && a.auth === b.auth);

  async function get(p) {
    if (!isAllowed(p)) throw new Error(`LCU path not allowed: ${String(p).slice(0, 120)}`);
    if (!creds) creds = load();
    for (let attempt = 0; ; attempt++) {
      if (!creds) { last = 'no-client'; return null; }
      // Re-reads the lockfile (once per call); true when that gave new details worth a retry.
      const reload = () => {
        if (attempt > 0) return false;
        const before = creds;
        creds = load();
        return Boolean(creds && !same(before, creds));
      };
      let res;
      try {
        res = await send(creds.origin, creds.auth, p, timeoutMs);
      } catch (err) {
        if (err.code !== 'ECONNREFUSED') { last = 'error'; throw err; }
        // The client closed, or restarted on another port.
        if (reload()) continue;
        creds = null;
        last = 'no-client';
        return null;
      }
      if (res.status === 401) {
        // The password rotated (the client restarted).
        if (reload()) continue;
        last = 'unauthorized';
        return null;
      }
      if (res.status === 404 || res.status === 204) { last = 'not-found'; return null; }
      if (res.status < 200 || res.status >= 300) {
        last = 'error';
        throw Object.assign(new Error(`LCU ${p}: HTTP ${res.status}`), { status: res.status });
      }
      last = 'ok';
      if (!res.body.trim()) return null;
      try {
        return JSON.parse(res.body);
      } catch {
        last = 'error';
        throw new Error(`LCU ${p}: unreadable response`);
      }
    }
  }

  // Polls the game-flow phase until it is one of `phases`. Resolves the phase, or null after
  // timeoutMs or once `signal` aborts. A busy or closed client just means "ask again later".
  async function waitForPhase(phases, { timeoutMs: wait = 10 * 60 * 1000, intervalMs = 2000, signal } = {}) {
    const wanted = new Set([].concat(phases));
    const end = Date.now() + wait;
    for (;;) {
      if (signal && signal.aborted) return null;
      let phase = null;
      try { phase = await get(PHASE); } catch { /* try again */ }
      if (typeof phase === 'string' && wanted.has(phase)) return phase;
      const left = end - Date.now();
      if (left <= 0) return null;
      await sleep(Math.min(intervalMs, left), signal);
    }
  }

  return Object.freeze({
    get,
    waitForPhase,
    // How the last request went: 'ok' | 'not-found' | 'no-client' | 'unauthorized' | 'error' | 'idle'
    status: () => last,
  });
}

module.exports = { createClient, leagueInstallDir, readLockfile, parseLockfile, retry, isAllowed, ALLOWED, BACKOFF, METHOD };
