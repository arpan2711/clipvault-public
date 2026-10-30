// Per-match League logs: the old single log is adopted once, and only the newest 20 are kept.
//   node test/league-logs-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMatchLog, adoptLastLog, KEEP } = require('../src/games/league-logs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-leaguelogs-'));
try {
  const lastLog = path.join(root, 'league-last-match.log');
  const dir = path.join(root, 'league-logs');

  // Nothing to adopt: no folder gets created.
  assert.strictEqual(adoptLastLog(lastLog, dir), null);
  assert.ok(!fs.existsSync(dir));

  // The log an older version left behind is copied under its match's start time.
  const old = `${JSON.stringify({ at: '2026-10-17T21:36:14.387Z', type: 'match-start', champion: 'Evelynn' })}\n`
    + `${JSON.stringify({ at: '2026-10-17T21:36:35.659Z', type: 'event', EventName: 'GameStart' })}\n`;
  fs.writeFileSync(lastLog, old);
  const adopted = adoptLastLog(lastLog, dir);
  assert.strictEqual(path.basename(adopted), '2026-10-17T21-36-14-387Z.jsonl');
  assert.strictEqual(fs.readFileSync(adopted, 'utf8'), old);
  assert.strictEqual(adoptLastLog(lastLog, dir), null, 'only adopted once');

  // A new log per match; the oldest beyond KEEP are removed (the adopted one included).
  let last = null;
  for (let i = 0; i < KEEP + 5; i++) last = startMatchLog(dir, new Date(Date.UTC(2026, 9, 18, 12, i)));
  const logs = fs.readdirSync(dir).sort();
  assert.strictEqual(logs.length, KEEP);
  assert.strictEqual(logs[logs.length - 1], path.basename(last));
  assert.ok(!logs.includes('2026-10-17T21-36-14-387Z.jsonl'));
  assert.strictEqual(logs[0], '2026-10-18T12-05-00-000Z.jsonl');

  console.log('league log tests: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
