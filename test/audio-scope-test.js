// Which sound "the game you're playing" records, and the move of older settings to it.
//   node test/audio-scope-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { gameSoundExe } = require('../src/foreground');
const { Settings } = require('../src/settings');

const fg = (exe, isGame = true) => ({ exe, isGame });
assert.strictEqual(gameSoundExe(fg('League of Legends.exe')), 'League of Legends.exe');
assert.strictEqual(gameSoundExe(fg('VALORANT-Win64-Shipping.exe')), 'VALORANT-Win64-Shipping.exe');
assert.strictEqual(gameSoundExe(fg('League of Legends.exe', false)), null, 'a windowed app is not the game');
for (const exe of ['chrome.exe', 'MSEDGE.exe', 'vlc.exe', 'Discord.exe', 'Spotify.exe']) {
  assert.strictEqual(gameSoundExe(fg(exe)), null, `${exe} in full screen is not a game`);
}
assert.strictEqual(gameSoundExe(null), null);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-scope-'));
const scope = (stored) => {
  if (stored === undefined) fs.rmSync(path.join(dir, 'settings.json'), { force: true });
  else fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ audioScope: stored }));
  return new Settings(dir, dir).values.audioScope;
};
assert.strictEqual(scope(undefined), 'game', 'new installs record only the game');
assert.strictEqual(scope('all'), 'game', 'the old default moves to the game');
assert.strictEqual(scope('league'), 'game');
assert.strictEqual(scope('everything'), 'everything');
assert.strictEqual(scope('nonsense'), 'game');
fs.rmSync(dir, { recursive: true, force: true });
console.log('audio scope tests: PASS');
