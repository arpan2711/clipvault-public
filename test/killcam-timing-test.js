// QA regression test for the kill cam's merging of close kills, with realistic timing.
// LeagueWatcher polls once a second and back-dates each event's wallMs to when it happened, so a
// kill reaches KillCam.onMoment up to ~1 s after its wallMs. League counts kills up to 10 s apart
// as a double kill; the cam should show them as one.
//   node test/killcam-timing-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KillCam, SETTLE_MS } = require('../src/killcam');
const { Recorder, SEGMENT_SECONDS } = require('../src/recorder');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(gapsMs, deliveryLagMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'killcam-timing-'));
  const saves = [];
  const cam = new KillCam({
    dir,
    save: async (fromMs, toMs, file) => { saves.push({ fromMs, toMs }); fs.writeFileSync(file, 'x'); },
    show: () => {},
    getOptions: () => ({ enabled: true, before: 8, kinds: ['kills'] }),
  });
  const t0 = Date.now();
  let at = 0;
  for (const gap of [0, ...gapsMs]) {
    at += gap;
    const wallMs = t0 + at;
    await sleep(Math.max(0, wallMs + deliveryLagMs - Date.now())); // the next poll sees it
    cam.onMoment({ type: 'kill', label: 'Kill', score: 30, wallMs });
  }
  await sleep(SETTLE_MS + 1500);
  await cam.saving;
  fs.rmSync(dir, { recursive: true, force: true });
  return saves.length;
}

// The shortest delay (1 s) against the buffer's 2 s segments: the cut must wait for the segment
// holding the death to close, so the cam reaches past the death. A real Recorder.saveRange with
// segments that close in real time (noticed LATENCY_MS late, as its CSV polling does); the death
// is reported 0.9 s late (the 1 s poll) and lands `phaseMs` into a segment.
const LATENCY_MS = 300; // a slow encoder's lag (the buffer's map puts footage this much later)
async function delayVsSegments(delay, phaseMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'killcam-timing-'));
  const rec = new Recorder();
  rec.state = 'running';
  rec.proc = { exitCode: null };
  const seg = (i) => ({ file: `seg${i}.ts`, dur: SEGMENT_SECONDS, start: i * SEGMENT_SECONDS, end: (i + 1) * SEGMENT_SECONDS, deleted: false });
  const startWall = Date.now() - 19000; // capture started 19 s ago
  rec.wallAnchor = startWall + LATENCY_MS;
  let next = 0;
  const close = () => { while (startWall + (next + 1) * SEGMENT_SECONDS * 1000 + LATENCY_MS <= Date.now()) rec.segments.push(seg(next++)); };
  close();
  const timer = setInterval(close, 25);
  let joined = null;
  let cutAt = 0;
  rec._join = async (segs) => { joined = segs; cutAt = Date.now(); };
  const shown = [];
  const cam = new KillCam({
    dir,
    save: (fromMs, toMs, file) => rec.saveRange(fromMs, toMs, file).then(() => fs.writeFileSync(file, 'x')),
    show: (c) => shown.push(c),
    getOptions: () => ({ enabled: true, before: 8, delay, kinds: ['deaths'] }),
  });
  const death = startWall + 10 * SEGMENT_SECONDS * 1000 + phaseMs; // in segment 10 (1 s from now, at most)
  await sleep(Math.max(0, death + 900 - Date.now()));
  cam.onMoment({ kind: 'deaths', type: 'death', label: 'Death', score: 5, wallMs: death });
  const t0 = Date.now();
  while (!shown.length && Date.now() - t0 < delay * 1000 + 6000) await sleep(25);
  clearInterval(timer);
  fs.rmSync(dir, { recursive: true, force: true });
  if (!joined) return { error: 'no cam' };
  const last = joined[joined.length - 1];
  // The footage really ends LATENCY_MS before its mapped end.
  return { pastDeathMs: rec._wallEnd(last) - LATENCY_MS - death, cutAfterDeathMs: cutAt - death };
}

(async () => {
  const failures = [];
  {
    const runs = await Promise.all([0, 400, 900, 1400, 1900].map(async (phase) => [phase, await delayVsSegments(1, phase)]));
    for (const [phase, r] of runs) {
      const name = `1 s delay, death ${phase} ms into a segment: the cam reaches past the death`;
      try {
        assert.ok(!r.error, r.error);
        assert.ok(r.pastDeathMs >= 250, `the cam ends ${r.pastDeathMs} ms after the death (you barely see it)`);
        assert.ok(r.cutAfterDeathMs < 4500, `cut ${r.cutAfterDeathMs} ms after the death`);
        console.log(`PASS  ${name} (ends ${r.pastDeathMs} ms after it, cut ${r.cutAfterDeathMs} ms after it)`);
      } catch (err) {
        failures.push(err.message);
        console.log(`FAIL  ${name}: ${err.message}`);
      }
    }
  }
  const cases = [
    ['double kill 2 s apart, seen 0.7 s late', [2000], 700],
    ['double kill 4 s apart, seen 0.5 s late', [4000], 500],
    ['triple kill, kills 3 s apart, seen 0.3 s late', [3000, 3000], 300],
  ];
  for (const [name, gaps, lag] of cases) {
    const cams = await run(gaps, lag);
    try {
      assert.strictEqual(cams, 1, `${name}: ${cams} cams`);
      console.log(`PASS  ${name}`);
    } catch (err) {
      failures.push(err.message);
      console.log(`FAIL  ${err.message}`);
    }
  }
  if (failures.length) { console.log(`${failures.length} failed`); process.exit(1); }
  console.log('kill cam timing tests passed');
})();
