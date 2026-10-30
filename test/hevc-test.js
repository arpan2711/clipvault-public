// H.265 capture: checks the encoder arguments (H.264 ones unchanged, the CPU encoder never
// switching to x265), then records a few seconds with codec 'hevc' and checks the saved clip is
// H.265 in an hvc1 sample entry. The recording part is skipped when no encoder here can do H.265.
// Usage: node test/hevc-test.js [outDir]   (KEEP=1 keeps the clip, VERBOSE=1 logs FFmpeg)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Recorder } = require('../src/recorder');
const { paths, run, detectEncoders, videoEncoderArgs, codecFor } = require('../src/ffmpeg');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function argumentTests() {
  const h264 = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '22', '-b:v', '0',
    '-spatial-aq', '1', '-g', '120', '-forced-idr', '1'];
  assert.deepStrictEqual(videoEncoderArgs('nvenc', 'high', 120), h264);
  assert.deepStrictEqual(videoEncoderArgs('nvenc', 'high', 120, { codec: 'h264' }), h264);
  assert.deepStrictEqual(videoEncoderArgs('nvenc', 'high', 120, { codec: 'hevc' }), ['-c:v', 'hevc_nvenc', ...h264.slice(2)]);
  assert.deepStrictEqual(videoEncoderArgs('amf', 'ultra', undefined, { codec: 'hevc' }).slice(0, 2), ['-c:v', 'hevc_amf']);
  assert.deepStrictEqual(videoEncoderArgs('qsv', 'low', 60, { codec: 'hevc' }).slice(0, 2), ['-c:v', 'hevc_qsv']);
  assert.deepStrictEqual(videoEncoderArgs('x264', 'high', 120, { codec: 'hevc' }), videoEncoderArgs('x264', 'high', 120));
  assert.deepStrictEqual(videoEncoderArgs('x264', 'medium'),
    ['-c:v', 'libx264', '-preset', 'fast', '-crf', '24', '-pix_fmt', 'yuv420p']);
  assert.strictEqual(codecFor('nvenc', 'hevc'), 'hevc');
  assert.strictEqual(codecFor('x264', 'hevc'), 'h264');
  assert.strictEqual(codecFor('nvenc', 'h264'), 'h264');
  assert.strictEqual(codecFor('nvenc', undefined), 'h264');
  console.log('ok   encoder arguments');
}

(async () => {
  argumentTests();
  const encoders = await detectEncoders();
  console.log(`encoders: ${encoders.map((e) => `${e.id} (${e.codec}, hevc: ${e.hevc})`).join(', ')}`);
  for (const e of encoders) assert.deepStrictEqual(Object.keys(e).sort(), ['codec', 'hevc', 'id', 'label']);
  const enc = encoders.find((e) => e.hevc);
  if (!enc) {
    console.log('SKIP recording: no encoder on this PC can do H.265');
    process.exit(0);
  }

  const out = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-hevc-')));
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'hevc-replay.mp4');
  const rec = new Recorder();
  rec.on('log', (l) => process.env.VERBOSE && console.log('  log:', l));
  rec.on('warning', (w) => console.log('  warning:', w));
  rec.on('crashed', (m) => console.log('  CRASHED:', m));
  let ok = true;
  try {
    await rec.start({
      bufferRoot: path.join(out, '.buffer'), replaySeconds: 6, fps: 60, quality: 'high',
      resolution: 'native', encoder: enc.id, codec: 'hevc', monitor: 0, drawMouse: true,
      audio: { game: { kind: 'loopback', volume: 100 }, mic: null, discord: null, separateTracks: false },
    });
    console.log('started', rec.status().info);
    await sleep(7000);
    const saved = await rec.saveReplay(4, file);
    await rec.stop();

    const r = await run(paths.ffprobe, ['-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,codec_tag_string,profile,pix_fmt,width,height,nb_frames:stream_tags=handler_name:format=duration',
      '-of', 'json', file]);
    const info = JSON.parse(r.stdout);
    const v = info.streams.find((s) => s.codec_type === 'video');
    const audio = info.streams.filter((s) => s.codec_type === 'audio');
    console.log(`${path.basename(file)}: ${parseFloat(info.format.duration).toFixed(2)} s, video ${v.codec_name}/${v.codec_tag_string} `
      + `${v.profile} ${v.pix_fmt} ${v.width}x${v.height} ${v.nb_frames} frames, audio ${audio.map((a) => `${a.codec_name} "${a.tags.handler_name}"`).join(', ')}`);
    const checks = [
      [saved.codec === 'hevc', 'save result reports hevc'],
      [v.codec_name === 'hevc' && v.codec_tag_string === 'hvc1', 'video is H.265 with the hvc1 tag'],
      [v.pix_fmt === 'yuv420p' && v.profile === 'Main', '8-bit 4:2:0 Main profile'],
      [parseFloat(info.format.duration) >= 3.5, 'clip covers the requested time'],
      [audio.length === 1 && audio[0].tags.handler_name === 'Mixed', 'one audio track named Mixed'],
    ];
    for (const [cond, msg] of checks) {
      console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
      if (!cond) ok = false;
    }
  } catch (err) {
    console.error('FAILED:', err.message);
    ok = false;
    await rec.stop().catch(() => {});
  } finally {
    const leftovers = fs.existsSync(path.join(out, '.buffer')) ? fs.readdirSync(path.join(out, '.buffer')) : [];
    if (leftovers.length) { console.log('FAIL buffer not cleaned up'); ok = false; }
    if (!process.env.KEEP) {
      fs.rmSync(file, { force: true });
      fs.rmSync(path.join(out, '.buffer'), { recursive: true, force: true });
      if (!process.argv[2]) fs.rmSync(out, { recursive: true, force: true });
    }
  }
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
