// Smoke test for the capture engine without the UI: buffers a few seconds of the screen,
// saves an instant replay and a short recording, then checks both files with ffprobe.
// Usage: node test/engine-test.js [outputDir]     (set VERBOSE=1 for FFmpeg command lines)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Recorder } = require('../src/recorder');
const { paths, run, detectEncoders } = require('../src/ffmpeg');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(file) {
  const r = await run(paths.ffprobe, ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,nb_frames:format=duration', '-of', 'json', file]);
  return JSON.parse(r.stdout);
}

(async () => {
  const out = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-test-')));
  fs.mkdirSync(out, { recursive: true });
  const encoders = await detectEncoders();
  console.log('encoders:', encoders.map((e) => e.id).join(', '));
  if (!encoders.length) throw new Error('no working encoder');

  const rec = new Recorder();
  rec.on('log', (l) => process.env.VERBOSE && console.log('  log:', l));
  rec.on('warning', (w) => console.log('  warning:', w));
  rec.on('crashed', (m) => console.log('  CRASHED:', m));

  const t0 = Date.now();
  await rec.start({
    bufferRoot: path.join(out, '.buffer'), replaySeconds: 6, fps: 60, quality: 'high',
    resolution: 'native', encoder: encoders[0].id, monitor: 0, drawMouse: true,
    systemAudio: true, systemVolume: 100, mic: false, micVolume: 100,
  });
  console.log(`started in ${Date.now() - t0} ms`, rec.status().info);

  await sleep(10000);
  const onDisk = fs.readdirSync(rec.dir).filter((f) => f.endsWith('.ts')).length;
  console.log(`segments listed: ${rec.segments.length}, still on disk: ${onDisk} (old ones pruned)`);

  rec.startRecording({ game: 'Test' });
  const t1 = Date.now();
  const replay = await rec.saveReplay(6, path.join(out, 'replay.mp4'));
  console.log(`replay saved in ${Date.now() - t1} ms, ~${replay.duration.toFixed(1)} s`);
  await sleep(3000);
  const recording = await rec.stopRecording(path.join(out, 'recording.mp4'));
  console.log(`recording saved, ~${recording.duration.toFixed(1)} s`);
  await rec.stop();

  let ok = true;
  for (const [file, minDur] of [['replay.mp4', 5.5], ['recording.mp4', 2.5]]) {
    const info = await probe(path.join(out, file));
    const v = info.streams.find((s) => s.codec_type === 'video');
    const a = info.streams.find((s) => s.codec_type === 'audio');
    const dur = parseFloat(info.format.duration);
    console.log(`${file}: ${dur.toFixed(2)} s, video ${v && `${v.codec_name} ${v.width}x${v.height} ${v.nb_frames} frames`}, audio ${a ? a.codec_name : 'none'}`);
    if (!v || !a || dur < minDur) ok = false;
  }
  const leftovers = fs.existsSync(path.join(out, '.buffer')) ? fs.readdirSync(path.join(out, '.buffer')) : [];
  console.log(`buffer cleaned up: ${leftovers.length === 0}`);
  console.log(ok && leftovers.length === 0 ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
