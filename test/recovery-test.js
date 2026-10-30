// Tests the capture engine's recovery pieces without FFmpeg: the footage before a capture restart
// stays clippable, and FFmpeg lines that mean the screen capture died restart it at once.
// Usage: node test/recovery-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Recorder, FATAL_CAPTURE, DUPLICATED } = require('../src/recorder');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-recovery-'));
const W0 = 1790000000000;

// A recorder "running" a session of `count` 2-second segments whose footage starts at `wall0`.
function fakeSession(r, name, wall0, count) {
  r.state = 'running';
  r.opts = { bufferRoot: root };
  r.dir = path.join(root, name);
  fs.mkdirSync(r.dir, { recursive: true });
  r.segments = [];
  for (let i = 0; i < count; i++) {
    const file = path.join(r.dir, `seg_${String(i).padStart(6, '0')}.ts`);
    fs.writeFileSync(file, `${name}-${i}`);
    r.segments.push({ file, dur: 2, start: i * 2, end: i * 2 + 2, deleted: false });
  }
  r.prunedUpTo = 0;
  r.wallAnchor = wall0;
  r.info = { codec: name === 'session-1' ? 'h264' : 'hevc', audioTracks: [name] };
  r.proc = null;
}

(async () => {
  const r = new Recorder();
  r.replaySeconds = 20;
  const joined = [];
  r._join = async (segs, out, info) => { joined.push({ files: segs.map((s) => path.basename(path.dirname(s.file)) + '/' + path.basename(s.file)), info }); };
  r._waitForWall = async () => {};
  r._teardownProcesses = async () => {};

  // Session 1: 0-40 s of footage, then capture froze and was restarted keeping the footage.
  fakeSession(r, 'session-1', W0, 20);
  await r.stop({ keepFootage: true });
  assert.strictEqual(r.state, 'idle');
  assert.ok(r.previous && fs.existsSync(path.join(root, 'session-1')), 'the footage is kept');
  // Starting again clears old sessions but not the kept one.
  fs.mkdirSync(path.join(root, 'session-9'));
  r._cleanupOldSessions();
  assert.ok(fs.existsSync(path.join(root, 'session-1')));
  assert.ok(!fs.existsSync(path.join(root, 'session-9')));

  // Session 2 starts at 45 s with 3 segments (45-51 s).
  fakeSession(r, 'session-2', W0 + 45000, 3);
  // A death cam of 30-40 s comes from the kept footage, with that session's codec and tracks.
  let res = await r.saveRange(W0 + 30000, W0 + 40000, path.join(root, 'a.mp4'));
  assert.deepStrictEqual(joined.pop().files, ['session-1/seg_000015.ts', 'session-1/seg_000016.ts', 'session-1/seg_000017.ts', 'session-1/seg_000018.ts', 'session-1/seg_000019.ts']);
  assert.strictEqual(res.startWall, W0 + 30000);
  assert.strictEqual(res.codec, 'h264');
  // "The last 20 s" at 51 s is mostly before the restart: still the kept footage (31-40 s)...
  res = await r.saveRange(W0 + 31000, W0 + 51000, path.join(root, 'b.mp4'));
  assert.ok(joined.pop().files.every((f) => f.startsWith('session-1/')));
  // ...and a moment after the restart comes from the new session, never a mix of the two.
  res = await r.saveRange(W0 + 46000, W0 + 51000, path.join(root, 'c.mp4'));
  assert.deepStrictEqual(joined.pop().files, ['session-2/seg_000001.ts', 'session-2/seg_000002.ts']);
  assert.strictEqual(res.codec, 'hevc');
  assert.ok(r.previous, 'kept while the new session is shorter than the buffer');

  // Once the new session holds as much as the buffer keeps, the kept footage goes.
  for (let i = 3; i < 13; i++) {
    const file = path.join(r.dir, `seg_${String(i).padStart(6, '0')}.ts`);
    fs.writeFileSync(file, 'x');
    r.segments.push({ file, dur: 2, start: i * 2, end: i * 2 + 2, deleted: false });
  }
  r._prune();
  assert.strictEqual(r.previous, null);
  assert.ok(!fs.existsSync(path.join(root, 'session-1')));

  // Not while a save is reading it.
  await r.stop({ keepFootage: true });
  fakeSession(r, 'session-3', W0 + 100000, 1);
  let release;
  r._join = () => new Promise((resolve) => { release = resolve; });
  const saving = r.saveRange(W0 + 60000, W0 + 70000, path.join(root, 'd.mp4'));
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 1; i < 20; i++) r.segments.push({ file: path.join(r.dir, `n${i}.ts`), dur: 2, start: i * 2, end: i * 2 + 2, deleted: false });
  r._prune();
  assert.ok(r.previous && fs.existsSync(path.join(root, 'session-2')), 'kept until the save is done');
  release();
  await saving;
  assert.strictEqual(r.previous, null, 'dropped after the save');

  // A plain stop (buffer turned off) keeps nothing.
  fakeSession(r, 'session-4', W0, 3);
  await r.stop({ keepFootage: true });
  assert.ok(r.previous);
  await r.stop();
  assert.strictEqual(r.previous, null);
  assert.ok(!fs.existsSync(path.join(root, 'session-4')));
  fakeSession(r, 'session-5', W0, 3);
  await r.stop();
  assert.strictEqual(r.previous, null);
  assert.ok(!fs.existsSync(path.join(root, 'session-5')));

  // FFmpeg lines: the ones that mean Desktop Duplication is gone restart capture at once.
  for (const line of [
    '[Parsed_ddagrab_0 @ 000001] AcquireNextFrame failed: 887a0026',
    '[in#0/lavfi @ 0000026ec7855000] Error during demuxing: Generic error in an external library',
    '[Parsed_ddagrab_0 @ 000001] Output parameters changed!',
  ]) assert.ok(FATAL_CAPTURE.test(line), line);
  for (const line of ['[vf#0:0 @ 000002819f2ebcc0] More than 1000 frames duplicated', '[aac @ 0000] Queue input is backward in time']) {
    assert.ok(!FATAL_CAPTURE.test(line), line);
  }
  assert.ok(DUPLICATED.test('[vf#0:0 @ 000002819f2ebcc0] More than 10000 frames duplicated'));
  const killed = [];
  const logs = [];
  const r2 = new Recorder();
  r2.state = 'running';
  r2.proc = { exitCode: null, kill() { killed.push(1); } };
  r2.stderrTail = '';
  r2.on('log', (m) => logs.push(m));
  r2._onStderr(r2.proc, '[vf#0:0 @ 0] More than 1000 frames duplicated\r\n');
  assert.deepStrictEqual(killed, []);
  assert.ok(logs.some((m) => m.startsWith('capture falling behind:')));
  r2._onStderr(r2.proc, '[Parsed_ddagrab_0 @ 1] AcquireNextFrame failed: 887a0026\r\n[in#0/lavfi @ 2] Error during demuxing: Generic error\r\n');
  assert.deepStrictEqual(killed, [1], 'restarted once');
  assert.ok(logs.some((m) => /^restarting capture: screen capture failed: .*AcquireNextFrame/.test(m)));
  // Not while starting or stopping (start-up failures and 'q' have their own handling).
  const r3 = new Recorder();
  r3.state = 'stopping';
  r3.proc = { exitCode: null, kill() { killed.push(3); } };
  r3._onStderr(r3.proc, 'Error during demuxing: x\n');
  assert.deepStrictEqual(killed, [1]);

  // The minimap recording's FFmpeg stopped by itself mid-match: its file is still the match reel.
  const { MinimapRecorder } = require('../src/games/minimap');
  const mm = new MinimapRecorder();
  mm.file = path.join(root, 'Map.mp4');
  fs.writeFileSync(mm.file, 'fragmented mp4');
  mm.startWall = W0;
  mm.proc = null;
  assert.deepStrictEqual(await mm.stop(), { file: path.join(root, 'Map.mp4'), startWall: W0 });
  assert.strictEqual(await mm.stop(), null, 'and only once: the next match starts afresh');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('recovery tests: PASS');
})().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
