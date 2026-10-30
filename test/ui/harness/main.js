'use strict';
// cv-shot-harness: runs the repo's own ClipVault main process for screenshots, safely.
// Before anything else, the test profile from --data-dir= becomes userData and sessionData; a
// missing flag, the real profile, the real videos folder or a folder outside the temp test areas
// exits at once. Every error is logged and exits, so no error dialog can appear on screen, and any
// window that tries to show itself is hidden again. Run it through test/ui/run-shot.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const LOG = path.join(os.tmpdir(), 'clipvault-ui', 'harness-log.txt');
const CLIPVAULT_MAIN = path.join(__dirname, '..', '..', '..', 'src', 'main.js');
let dead = false;

function log(...parts) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] pid ${process.pid} ${parts.join(' ')}\n`);
  } catch { /* never throw */ }
}

function fail(msg) {
  if (!dead) log('FATAL:', msg);
  dead = true;
  try { app.exit(1); } catch { /* fall through */ }
  process.exit(1);
}

process.on('uncaughtException', (err) => fail(`uncaughtException: ${(err && err.stack) || err}`));
process.on('unhandledRejection', (err) => log('unhandledRejection (ignored):', (err && err.stack) || err));

let dir = null;
try {
  dir = require('./guard.js').safeProfileDir(process.argv);
} catch (err) {
  fail(`guard failed: ${(err && err.stack) || err}`);
}

if (!dir) {
  fail(`refusing to start: --data-dir missing or not a temp test profile (${process.argv.slice(1).join(' ')})`);
} else if (!fs.existsSync(CLIPVAULT_MAIN)) {
  fail(`ClipVault main not found at ${CLIPVAULT_MAIN}`);
} else {
  app.setPath('userData', dir);
  app.setPath('sessionData', dir);
  const same = (p) => path.resolve(app.getPath(p)).toLowerCase() === dir.toLowerCase();
  if (!same('userData') || !same('sessionData')) {
    fail(`profile paths not applied: userData=${app.getPath('userData')} sessionData=${app.getPath('sessionData')}`);
  } else {
    log('start, profile', dir);
    app.on('browser-window-created', (_e, win) => {
      win.on('show', () => { log('a window tried to show; hiding it'); win.hide(); });
    });
    app.on('will-quit', () => log('quit'));
    try {
      require(CLIPVAULT_MAIN);
    } catch (err) {
      fail(`could not load ClipVault main: ${(err && err.stack) || err}`);
    }
  }
}
