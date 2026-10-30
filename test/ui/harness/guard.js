'use strict';
// Checks for the screenshot harness, in plain Node so they can be self-tested before any launch.
// A test profile must live in the temp folder, inside a "clipvault-ui" or "cv-test" folder, and
// must never be the real profile or the real videos folder.
const os = require('os');
const path = require('path');

const norm = (p) => `${path.resolve(p).replace(/\//g, '\\').toLowerCase()}\\`;

// The isolated profile from --data-dir=, or null when it is missing or not safe.
function safeProfileDir(argv, tmp = os.tmpdir()) {
  const arg = (argv || []).find((a) => typeof a === 'string' && a.startsWith('--data-dir='));
  if (!arg) return null;
  const value = arg.slice('--data-dir='.length);
  if (!value) return null;
  const dir = path.resolve(value);
  const n = norm(dir);
  if (n.includes('\\appdata\\roaming\\clipvault\\') || n.includes('\\videos\\clipvault\\')) return null;
  if (!n.startsWith(norm(tmp))) return null;
  if (!/\\(clipvault-ui|cv-test)\\/.test(n)) return null;
  return dir;
}

function selfTest() {
  const tmp = 'C:\\Users\\someone\\AppData\\Local\\Temp';
  const cases = [
    [[], false],
    [['--data-dir='], false],
    [['--data-dir=C:/Users/someone/AppData/Roaming/ClipVault'], false],
    [['--data-dir=C:\\Users\\someone\\AppData\\Roaming\\clipvault\\'], false],
    [['--data-dir=C:/Users/someone/Videos/ClipVault'], false],
    [[`--data-dir=${tmp}\\somewhere-else`], false],
    [[`--data-dir=${tmp}\\clipvault-ui\\..\\..\\Roaming\\ClipVault`], false],
    [['--data-dir=D:\\clipvault-ui\\profile'], false],
    [[`--data-dir=${tmp}\\clipvault-ui\\library`], true],
    [[`--data-dir=${tmp}/claude/x/scratchpad/cv-test/profile`], true],
  ];
  for (const [argv, ok] of cases) {
    if (Boolean(safeProfileDir(argv, tmp)) !== ok) throw new Error(`guard self-test failed for ${JSON.stringify(argv)}`);
  }
  return true;
}

module.exports = { safeProfileDir, selfTest };
