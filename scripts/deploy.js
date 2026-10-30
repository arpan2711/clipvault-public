// Ships a tested branch into the live ClipVault folder (the repo's main worktree), which is what the
// user's running ClipVault loads from. Works from the live folder or any worktree:
//   node scripts/deploy.js --from=redesign/r1 [--dry-run]
//   node scripts/deploy.js --rollback=<commit or tag> [--dry-run]
// It refuses while a League match is running, runs the fast tests on the branch's working copy,
// stops ClipVault cleanly, fast-forwards (or rolls back) the live folder, runs setup.js, relaunches
// ClipVault hidden, and checks that it started. --dry-run only checks and prints the plan.
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// The live folder is the repo's main worktree: the first entry git lists.
const LIVE = (() => {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  const first = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('worktree '));
  if (r.status !== 0 || !first) { console.error('Deploy stopped: not inside the ClipVault git repo'); process.exit(1); }
  return path.resolve(first.slice(9));
})();
const args = process.argv.slice(2);
const opt = (name) => {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return null;
  const i = a.indexOf('=');
  return i < 0 ? true : a.slice(i + 1);
};
const DRY = Boolean(opt('dry-run'));
const FROM = opt('from');
const ROLLBACK = opt('rollback');

const step = (msg) => console.log(`\n> ${msg}`);
const fail = (msg) => { console.error(`\nDeploy stopped: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function git(...a) {
  const r = spawnSync('git', a, { cwd: LIVE, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
}

// A League match is live when the game client answers on its local API.
function matchIsLive() {
  return new Promise((resolve) => {
    const req = https.get('https://127.0.0.1:2999/liveclientdata/gamestats', { rejectUnauthorized: false, timeout: 3000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function processRunning(image) {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], { encoding: 'utf8' });
  return (r.stdout || '').toLowerCase().includes(image.toLowerCase());
}

// The user's ClipVault: Electron's main process started on the live folder, not a test profile.
function liveInstancePids() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  const live = LIVE.toLowerCase();
  return (r.stdout || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, ...rest] = line.split('\t');
    return { pid: Number(pid), cmd: rest.join('\t').toLowerCase() };
  }).filter((p) => p.cmd.includes(live) && !p.cmd.includes('--type=') && !p.cmd.includes('--data-dir') && !p.cmd.includes('scratchpad'))
    .map((p) => p.pid);
}

function worktreeFor(branch) {
  const out = git('worktree', 'list', '--porcelain');
  let dir = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) dir = line.slice(9);
    if (line === `branch refs/heads/${branch}`) return path.resolve(dir);
  }
  return null;
}

// The fast suite from package.json "test" ("node a.js && node b.js"), run with this Node.
function runFastTests(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const cmds = String((pkg.scripts && pkg.scripts.test) || '').split('&&').map((c) => c.trim()).filter(Boolean);
  if (!cmds.length) fail('package.json has no "test" script');
  for (const c of cmds) {
    const [bin, ...rest] = c.split(/\s+/);
    if (bin !== 'node') fail(`unexpected test command: ${c}`);
    console.log(`  ${c}`);
    const r = spawnSync(process.execPath, rest, { cwd: dir, encoding: 'utf8', timeout: 10 * 60 * 1000 });
    if (r.status !== 0) {
      console.error((r.stdout || '').split(/\r?\n/).slice(-15).join('\n'), r.stderr || '');
      fail(`tests failed: ${c}`);
    }
  }
}

function startedSince(sinceMs) {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  try {
    return fs.readFileSync(path.join(appData, 'ClipVault', 'clipvault.log'), 'utf8').split(/\r?\n/).some((line) => {
      const m = /^\[([^\]]+)\] started /.exec(line);
      return m && Date.parse(m[1]) >= sinceMs - 2000;
    });
  } catch {
    return false;
  }
}

(async () => {
  if (!FROM && !ROLLBACK) fail('say what to deploy: --from=<branch> or --rollback=<commit>');
  console.log(`Live folder: ${LIVE}`);

  step('Checking it is safe to restart ClipVault');
  if (await matchIsLive()) fail('a League match is live. Deploy after the game.');
  if (processRunning('League of Legends.exe')) fail('League of Legends (the game) is running. Deploy after the game.');
  if (git('status', '--porcelain')) fail('the live folder has uncommitted changes');
  console.log('  no match live, game not running, live folder clean');

  const prev = git('rev-parse', 'HEAD');
  let target;
  let source = null;
  if (FROM) {
    target = git('rev-parse', FROM);
    if (spawnSync('git', ['merge-base', '--is-ancestor', prev, target], { cwd: LIVE }).status !== 0) fail(`${FROM} is not a fast-forward of the live folder`);
    if (target === prev) fail(`the live folder is already at ${FROM}`);
    source = worktreeFor(FROM);
    console.log(`  shipping ${FROM} (${target.slice(0, 7)}) over ${prev.slice(0, 7)}:`);
    console.log(git('log', '--oneline', `${prev}..${target}`).split(/\r?\n/).map((l) => `    ${l}`).join('\n'));
  } else {
    target = git('rev-parse', ROLLBACK);
    if (spawnSync('git', ['merge-base', '--is-ancestor', target, prev], { cwd: LIVE }).status !== 0) fail('a rollback must go back to an earlier commit');
    console.log(`  rolling back ${prev.slice(0, 7)} to ${target.slice(0, 7)}`);
  }

  if (source) {
    step(`Running the fast tests on ${source}`);
    if (!DRY) runFastTests(source);
    else console.log('  (dry run: skipped)');
  }

  const pids = liveInstancePids();
  step(`Stopping ClipVault (${pids.length ? `pid ${pids.join(', ')}` : 'not running'})`);
  if (DRY) {
    console.log('\nDry run: nothing was changed. The real run would then:');
    console.log(`  ${FROM ? `git merge --ff-only ${FROM}` : `git reset --hard ${target.slice(0, 7)}`}`);
    console.log('  node setup.js');
    console.log('  start ClipVault hidden and check clipvault.log');
    console.log(`  (to undo: node scripts/deploy.js --rollback=${prev.slice(0, 7)})`);
    return;
  }
  if (pids.length) {
    spawnSync(process.execPath, [path.join(LIVE, 'launch.js'), '--quit'], { cwd: LIVE, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    for (let i = 0; i < 40 && liveInstancePids().length; i++) await sleep(500);
    if (liveInstancePids().length) fail('ClipVault did not exit within 20 s; nothing was changed');
  }

  step(FROM ? 'Fast-forwarding the live folder' : 'Rolling back the live folder');
  if (FROM) git('merge', '--ff-only', FROM);
  else git('reset', '--hard', target);

  step('Running setup.js');
  const s = spawnSync(process.execPath, [path.join(LIVE, 'setup.js')], { cwd: LIVE, stdio: 'inherit' });
  if (s.status !== 0) console.warn('  setup.js reported a problem; ClipVault is started anyway');

  step('Starting ClipVault hidden');
  const startAt = Date.now();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = require(path.join(LIVE, 'node_modules', 'electron'));
  spawn(electron, [LIVE, '--hidden'], { cwd: LIVE, detached: true, stdio: 'ignore', env }).unref();
  for (let i = 0; i < 30 && !startedSince(startAt); i++) await sleep(500);
  if (!startedSince(startAt)) fail('ClipVault did not log a start within 15 s; check %APPDATA%\\ClipVault\\clipvault.log');
  console.log(`\nDeployed ${target.slice(0, 7)}. To undo: node scripts/deploy.js --rollback=${prev.slice(0, 7)}`);
})().catch((err) => fail(err.message));
