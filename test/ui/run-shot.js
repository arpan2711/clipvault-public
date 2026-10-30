// Takes one screenshot of an isolated ClipVault test instance, safely.
//   node test/ui/run-shot.js --profile=<temp test profile> --out=<file.png> [--view=settings|player|...]
//                            [--eval=<file with JS run in the page before the capture>] [--size=1440x900] [--dry-run]
// Refuses to start when a League match is live, when one of its own test processes is still
// running, when an electron.exe other than the user's own ClipVault uses the real profile, or when
// the profile isn't a temp test profile (see harness/guard.js). Afterwards it kills only the
// processes of this test instance and reports anything else without touching it.
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const guard = require('./harness/guard');

const REPO = path.resolve(__dirname, '..', '..');
const HARNESS_DIR = path.join(__dirname, 'harness');
const REAL_PROFILE_RE = /\\AppData\\Roaming\\ClipVault(?=["\\\s]|$)/i;
const opt = (name) => {
  const a = process.argv.slice(2).find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return null;
  const i = a.indexOf('=');
  return i < 0 ? true : a.slice(i + 1);
};
const PROFILE = opt('profile') ? path.resolve(opt('profile')) : null;
const OUT = opt('out') ? path.resolve(opt('out')) : null;
if (!PROFILE || !OUT) { console.error('usage: run-shot.js --profile=<dir> --out=<png> [--view=x] [--eval=file] [--size=WxH] [--dry-run]'); process.exit(2); }
const esc = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const MY_RE = new RegExp(`${esc(PROFILE)}|${esc(HARNESS_DIR)}|cv-shot-harness`, 'i');
const TOOL_NAMES = /^(electron|cvhelper|ffmpeg|ffprobe)\.exe$/i;
let childPid = null;
const seen = new Map(); // pid -> name + command line of processes that belonged to this run

function leagueLive() {
  return new Promise((resolve) => {
    const req = https.get('https://127.0.0.1:2999/liveclientdata/gamestats', { rejectUnauthorized: false, timeout: 3000 }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function processes() {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out).map((p) => ({ ...p, CommandLine: p.CommandLine || '' }));
}

function descendants(all, rootIds) {
  const ids = new Set(rootIds);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) if (!ids.has(p.ProcessId) && ids.has(p.ParentProcessId)) { ids.add(p.ProcessId); grew = true; }
  }
  return ids;
}

// Processes of this test instance only.
function ourTree(all = processes()) {
  const roots = all.filter((p) => p.ProcessId === childPid
    || (p.ProcessId !== process.pid && TOOL_NAMES.test(p.Name) && MY_RE.test(p.CommandLine)));
  const ids = descendants(all, roots.map((p) => p.ProcessId));
  for (const p of all) {
    const s = seen.get(p.ProcessId);
    if (s && s.Name === p.Name && s.CommandLine === p.CommandLine) ids.add(p.ProcessId);
  }
  const list = all.filter((p) => ids.has(p.ProcessId));
  for (const p of list) seen.set(p.ProcessId, { Name: p.Name, CommandLine: p.CommandLine });
  return list;
}

// The user's own ClipVault: electron.exe main (no --type, no --data-dir, not the harness) and its children.
function userTree(all) {
  const mains = all.filter((p) => /^electron\.exe$/i.test(p.Name) && !/--type=/.test(p.CommandLine)
    && !/--data-dir=/.test(p.CommandLine) && !/cv-shot-harness|\\test\\ui\\harness/i.test(p.CommandLine));
  return descendants(all, mains.map((p) => p.ProcessId));
}

function foreignOnRealProfile(all) {
  const users = userTree(all);
  return all.filter((p) => /^electron\.exe$/i.test(p.Name) && REAL_PROFILE_RE.test(p.CommandLine) && !users.has(p.ProcessId));
}

function checkHarness() {
  const pkg = JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, 'package.json'), 'utf8'));
  if (pkg.name !== 'cv-shot-harness' || pkg.productName !== 'cv-shot-harness') throw new Error('the harness package must be named cv-shot-harness');
  for (const f of ['main.js', 'guard.js']) {
    const r = spawnSync(process.execPath, ['--check', path.join(HARNESS_DIR, f)], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`harness ${f} has a syntax error: ${r.stderr}`);
  }
  if (guard.selfTest() !== true) throw new Error('guard self-test failed');
  if (!guard.safeProfileDir([`--data-dir=${PROFILE}`])) throw new Error(`profile refused by the guard: ${PROFILE}`);
  if (!fs.existsSync(path.join(REPO, 'src', 'main.js'))) throw new Error('ClipVault main.js not found');
  if (!fs.readFileSync(path.join(HARNESS_DIR, 'main.js'), 'utf8').includes("process.on('uncaughtException'")) throw new Error('the harness lost its error guard');
}

function kill(list, why) {
  for (const p of list) {
    console.error(`killing ${p.ProcessId} ${p.Name} (${why})`);
    try { process.kill(p.ProcessId); } catch { /* already gone */ }
  }
}

(async () => {
  try { checkHarness(); } catch (err) { console.error(`ABORT: ${err.message}`); process.exit(2); }
  if (await leagueLive()) { console.error('ABORT: a League match is live'); process.exit(3); }
  const all0 = processes();
  const before = ourTree(all0);
  if (before.length) { console.error('ABORT: a test process of ours is still running:', before.map((p) => `${p.ProcessId} ${p.Name}`).join(', ')); process.exit(4); }
  const foreign0 = foreignOnRealProfile(all0);
  if (foreign0.length) { console.error('ABORT: electron.exe on the real profile outside the user instance:', foreign0.map((p) => p.ProcessId).join(', ')); process.exit(5); }
  if (opt('dry-run')) {
    console.log(`preflight ok; the user's ClipVault processes (left alone): ${[...userTree(all0)].join(', ') || 'none'}`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.rmSync(OUT, { force: true });
  const flags = [`--data-dir=${PROFILE}`, '--no-capture', '--no-tray', `--screenshot=${OUT}`, '--quit-after-screenshot', '--verbose'];
  if (typeof opt('view') === 'string') flags.push(`--view=${opt('view')}`);
  if (typeof opt('size') === 'string') flags.push(`--window-size=${opt('size')}`);
  if (typeof opt('eval') === 'string') flags.push(`--eval=${fs.readFileSync(opt('eval'), 'utf8').replace(/\r?\n\s*/g, ' ')}`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electron, [HARNESS_DIR, ...flags], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  childPid = child.pid;
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(String(d).split('\n').filter((l) => !/Autofill|GetVSyncParameters|DevTools/.test(l)).join('\n')));

  // While it runs: remember our processes, and kill any of them that touches the real profile.
  const watch = setInterval(() => {
    try {
      const bad = ourTree().filter((p) => REAL_PROFILE_RE.test(p.CommandLine));
      if (bad.length) kill(bad, 'ours, on the REAL profile');
    } catch { /* next round */ }
  }, 2500);
  const timer = setTimeout(() => { console.error('TIMEOUT: stopping this test instance only'); kill(ourTree(), 'timeout'); }, 60000);
  child.on('close', async (code) => {
    clearTimeout(timer);
    clearInterval(watch);
    await new Promise((r) => setTimeout(r, 1500));
    const all = processes();
    const left = ourTree(all).filter((p) => p.ProcessId !== process.pid);
    if (left.length) kill(left, 'leftover');
    const foreign = foreignOnRealProfile(all); // reported only: never signal anything that isn't ours
    if (foreign.length) console.error('WARNING: electron.exe on the real profile outside the user instance (not touched):', foreign.map((p) => p.ProcessId).join(', '));
    console.log(`exit ${code}; screenshot ${fs.existsSync(OUT) ? 'saved' : 'MISSING'}: ${OUT}; leftovers stopped: ${left.length}`);
    process.exitCode = fs.existsSync(OUT) ? 0 : 1;
  });
})();
