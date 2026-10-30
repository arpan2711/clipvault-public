// Tests the editing engine (src/edit.js) and champion icons (src/champions.js) on synthetic videos
// made with FFmpeg's test sources. About a minute with NVENC; the champion cases need internet.
// Usage: node test/edit-test.js [outputDir]
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { paths, run, detectEncoders } = require('../src/ffmpeg');
const { planHighlightReel, buildVideo, exportForSharing, exportRange, videoPackets, locateClip } = require('../src/edit');
const { championIcon } = require('../src/champions');

const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'clipvault-edit-test'));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const tally = { pass: 0, fail: 0, skip: 0 };

class Skip extends Error {}

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    tally.pass++;
    console.log(`PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (err) {
    if (err instanceof Skip) {
      tally.skip++;
      console.log(`SKIP  ${name}: ${err.message}`);
      return;
    }
    tally.fail++;
    console.log(`FAIL  ${name}\n      ${String(err && err.message).split('\n').join('\n      ')}`);
  }
}

const out = (name) => path.join(OUT, name);
const near = (actual, expected, tolerance, what) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${what}: ${actual} is not within ${tolerance} of ${expected}`);

async function ffmpeg(args) {
  const r = await run(paths.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 5 * 60e3 });
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim()}`);
}

async function probe(file) {
  const r = await run(paths.ffprobe, ['-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,codec_name,codec_tag_string,width,height,r_frame_rate,sample_rate,channels,duration',
    '-of', 'json', file]);
  const info = JSON.parse(r.stdout);
  const streams = info.streams || [];
  return {
    duration: parseFloat(info.format.duration),
    video: streams.filter((s) => s.codec_type === 'video'),
    audio: streams.filter((s) => s.codec_type === 'audio'),
  };
}

// Peak level of the first audio track (optionally a time range of it), in dB.
async function peakDb(file, from, length) {
  const range = from == null ? [] : ['-ss', String(from), '-t', String(length)];
  const r = await run(paths.ffmpeg, ['-hide_banner', '-nostats', ...range, '-i', file, '-map', '0:a:0',
    '-af', 'volumedetect', '-f', 'null', '-']);
  const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr);
  if (!m) throw new Error(`volumedetect failed on ${path.basename(file)}`);
  return m[1] === '-inf' ? -Infinity : parseFloat(m[1]);
}

// Decodes every frame of every stream: what a player would hit.
async function decodesCleanly(file) {
  const r = await run(paths.ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-'], { timeout: 5 * 60e3 });
  return r.code === 0 && !r.stderr.trim();
}

function online() {
  return new Promise((resolve) => {
    const req = https.get('https://ddragon.leagueoflegends.com/api/versions.json', { timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
  });
}

// ------------------------------------------------------------------ planHighlightReel

async function planTests() {
  const P = planHighlightReel;
  const seg = (file, from, to) => ({ file, from, to });
  const cases = [
    ['plan: separate clips are kept whole',
      P([{ file: 'a', start: 10, end: 30 }, { file: 'b', start: 40, end: 65 }]),
      [seg('a', 0, 20), seg('b', 0, 25)]],
    ['plan: an overlapping clip starts where the previous one ended',
      P([{ file: 'a', start: 100, end: 125 }, { file: 'b', start: 118, end: 146 }]),
      [seg('a', 0, 25), seg('b', 7, 28)]],
    ['plan: a clip contained in another is dropped',
      P([{ file: 'a', start: 0, end: 30 }, { file: 'b', start: 5, end: 20 }, { file: 'c', start: 25, end: 50 }]),
      [seg('a', 0, 30), seg('c', 5, 25)]],
    ['plan: touching clips are left alone',
      P([{ file: 'a', start: 0, end: 20 }, { file: 'b', start: 20, end: 40 }]),
      [seg('a', 0, 20), seg('b', 0, 20)]],
    ['plan: unsorted input comes out in match order',
      P([{ file: 'c', start: 60, end: 80 }, { file: 'a', start: 0, end: 25 }, { file: 'b', start: 20, end: 45 }]),
      [seg('a', 0, 25), seg('b', 5, 25), seg('c', 0, 20)]],
    ['plan: leftovers under 0.5 s are dropped (0.5 s is kept)',
      [P([{ file: 'a', start: 0, end: 20 }, { file: 'b', start: 0.2, end: 20.4 }, { file: 'c', start: 19.6, end: 30 }]),
        P([{ file: 'a', start: 0, end: 20 }, { file: 'b', start: 10, end: 20.5 }])],
      [[seg('a', 0, 20), seg('c', 0.4, 10.4)], [seg('a', 0, 20), seg('b', 10, 10.5)]]],
    ['plan: of two clips starting together only the longer is used',
      P([{ file: 'a', start: 10, end: 20 }, { file: 'b', start: 10, end: 35 }]),
      [seg('b', 0, 25)]],
    ['plan: a dropped sliver does not swallow footage of the next clip',
      P([{ file: 'a', start: 0, end: 20 }, { file: 'b', start: 5, end: 20.3 }, { file: 'c', start: 20.1, end: 30 }]),
      [seg('a', 0, 20), seg('c', 0, 9.9)]],
    ['plan: fractional times are rounded to milliseconds',
      P([{ file: 'a', start: 10.1, end: 22.345 }, { file: 'b', start: 20.0001, end: 30 }]),
      [seg('a', 0, 12.245), seg('b', 2.345, 10)]],
    ['plan: invalid clips are ignored, empty input gives an empty plan',
      [P([]), P([null, { file: 'a', start: 5, end: 5 }, { file: 'b', start: NaN, end: 3 }, { start: 0, end: 9 }, { file: 'c', start: 0, end: 10 }])],
      [[], [seg('c', 0, 10)]]],
  ];
  for (const [name, actual, expected] of cases) await test(name, () => assert.deepStrictEqual(actual, expected));
  await test('plan: a non-array is rejected', () => assert.throws(() => P('clips'), TypeError));
}

// ------------------------------------------------------------------ champions

async function championTests() {
  const dir = out('champions');
  const emptyDir = out('champions-empty');
  for (const d of [dir, emptyDir]) fs.rmSync(d, { recursive: true, force: true }); // exercise the download

  await test('champions: Evelynn and Wukong resolve to cached PNG icons', async () => {
    const first = await championIcon('Evelynn', dir);
    if (!first && !(await online())) throw new Skip('offline');
    for (const [name, id] of [['Evelynn', 'Evelynn'], ['Wukong', 'MonkeyKing']]) {
      const file = await championIcon(name, dir);
      assert.ok(file, `${name} resolved`);
      assert.strictEqual(path.dirname(file), dir, 'stored in the cache folder');
      assert.ok(path.basename(file).startsWith(`${id}-`), `${name} -> ${path.basename(file)}`);
      assert.ok(fs.readFileSync(file).subarray(0, 8).equals(PNG_SIGNATURE), `${path.basename(file)} is a PNG`);
    }
    const map = JSON.parse(fs.readFileSync(path.join(dir, 'champions.json'), 'utf8'));
    assert.ok(Date.now() - map.fetched < 60e3 && /^\d+\.\d+/.test(map.version), 'name map cached with its version');
    console.log(`      Data Dragon ${map.version}: ${fs.readdirSync(dir).filter((n) => n.endsWith('.png')).join(', ')}`);
  });

  await test('champions: case and punctuation are ignored', async () => {
    if (!fs.existsSync(path.join(dir, 'champions.json'))) throw new Skip('no name map (offline)');
    for (const [name, id] of [['Nunu & Willump', 'Nunu'], ["bel'veth", 'Belveth'], ['DR. MUNDO', 'DrMundo'], ['MonkeyKing', 'MonkeyKing']]) {
      const file = await championIcon(name, dir);
      assert.ok(file && path.basename(file).startsWith(`${id}-`), `${name} -> ${file && path.basename(file)}`);
    }
  });

  await test('champions: an unknown name returns null', async () => {
    for (const name of ['Definitely Not A Champion', 'constructor', '', null, undefined, 42]) {
      assert.strictEqual(await championIcon(name, dir), null, `${name}`);
    }
    assert.strictEqual(await championIcon('Evelynn', ''), null, 'no cache folder');
  });

  await test('champions: offline it answers from the cache and never throws', async () => {
    const realGet = https.get;
    let requests = 0;
    https.get = () => { // a PC without internet: every request fails asynchronously
      requests++;
      const req = new EventEmitter();
      req.destroy = () => {};
      process.nextTick(() => req.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })));
      return req;
    };
    try {
      if (fs.existsSync(path.join(dir, 'champions.json'))) {
        const file = await championIcon('Evelynn', dir);
        assert.ok(file && fs.existsSync(file), 'cached icon returned');
        assert.strictEqual(requests, 0, 'cached icons need no network');
      }
      assert.strictEqual(await championIcon('Evelynn', emptyDir), null, 'nothing cached -> null');
      assert.ok(requests > 0, 'tried the network for the empty cache');
    } finally {
      https.get = realGet;
    }
  });
}

// ------------------------------------------------------------------ synthetic inputs

async function makeInputs(encoder) {
  const v = (cq) => (encoder === 'nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0']
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(cq), '-pix_fmt', 'yuv420p']);
  const picture = (spec, seconds) => ['-f', 'lavfi', '-i', `testsrc2=s=${spec}:d=${seconds}`];
  const tone = (hz, rate, seconds) => ['-f', 'lavfi', '-i', `sine=f=${hz}:r=${rate}:d=${seconds}`];
  const files = {
    a: out('in-a-1440p60.mp4'), // the reel's format comes from this one
    b: out('in-b-1080p30.mp4'), // other size, rate and audio format (44.1 kHz mono)
    c: out('in-c-4x3-silent.mp4'), // 4:3 and no audio track at all
    d: out('in-d-1440p60-hq.mp4'), // 20 s at -cq 18: ~50 Mbps, like a real recording
    e: out('in-e-two-tracks.mp4'), // track 0 = tone (full mix), track 1 = silence
  };
  await ffmpeg([...picture('2560x1440:r=60', 6), ...tone(440, 48000, 6), '-map', '0:v', '-map', '1:a', ...v(23), '-c:a', 'aac', '-ac', '2', files.a]);
  await ffmpeg([...picture('1920x1080:r=30', 6), ...tone(880, 44100, 6), '-map', '0:v', '-map', '1:a', ...v(23), '-c:a', 'aac', '-ac', '1', files.b]);
  await ffmpeg([...picture('1280x960:r=60', 4), ...v(23), files.c]);
  await ffmpeg([...picture('2560x1440:r=60', 20), ...tone(440, 48000, 20), '-map', '0:v', '-map', '1:a', ...v(18), '-c:a', 'aac', '-b:a', '160k', '-ac', '2', files.d]);
  await ffmpeg([...picture('1280x720:r=30', 4), ...tone(440, 48000, 4), '-f', 'lavfi', '-t', '4', '-i', 'anullsrc=r=48000:cl=stereo',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', ...v(23), '-c:a', 'aac', '-ac', '2', files.e]);
  const d = fs.statSync(files.d).size;
  console.log(`      inputs ready (20 s source: ${(d / 1e6).toFixed(0)} MB, ${Math.round((d * 8) / 20 / 1e6)} Mbps)`);
  return files;
}

// ------------------------------------------------------------------ buildVideo

async function buildTests(encoder, f) {
  await test('buildVideo: mixed sizes, frame rates and a silent input', async () => {
    const segments = [
      { file: f.a, from: 1, to: 4 }, // 3 s of 1440p60: sets the output format
      { file: f.b, from: 0.5, to: 3 }, // 2.5 s of 1080p30
      { file: f.c, from: 0, to: 2 }, // 2 s, 4:3, no audio
      { file: f.b }, // the whole 6 s file
    ];
    const expected = 3 + 2.5 + 2 + 6;
    const progress = [];
    const outFile = out('reel-mixed.mp4');
    const r = await buildVideo({ segments, outFile, encoder, onProgress: (p) => progress.push(p) });
    assert.strictEqual(r.file, outFile);
    near(r.duration, expected, 0.3, 'returned duration');
    const info = await probe(outFile);
    near(info.duration, expected, 0.3, 'file duration');
    assert.strictEqual(info.video.length, 1);
    const v = info.video[0];
    assert.strictEqual(`${v.width}x${v.height} ${v.r_frame_rate}`, '2560x1440 60/1', 'first segment size and rate');
    assert.strictEqual(info.audio.length, 1, 'has audio despite the silent input');
    assert.strictEqual(`${info.audio[0].sample_rate} ${info.audio[0].channels}`, '48000 2');
    near(parseFloat(info.audio[0].duration), expected, 0.3, 'audio covers the whole reel');
    // The silent clip sits at 5.5-7.5 s: silence there and the tone right after proves the
    // generated silence has the right length (otherwise the sound would drift).
    const silent = await peakDb(outFile, 5.65, 1.7);
    const loud = await peakDb(outFile, 7.65, 5.7);
    assert.ok(silent < -60 && loud > -30, `silent part peaks at ${silent} dB, the next clip at ${loud} dB`);
    assert.ok(!fs.existsSync(`${outFile}.part`), 'no .part file left');
    assert.ok(progress.length >= 2 && progress.every((p, i) => !i || p > progress[i - 1]), `progress rises: ${progress.map((p) => p.toFixed(2))}`);
    assert.strictEqual(progress[progress.length - 1], 1, 'progress ends at 1');
    assert.ok(await decodesCleanly(outFile), 'decodes without errors');
  });

  await test('buildVideo: a planned reel of overlapping highlights shows each moment once', async () => {
    // Two highlights from one capture: a covers match time 100-106 s, b covers 104-110 s.
    const segments = planHighlightReel([{ file: f.b, start: 104, end: 110 }, { file: f.a, start: 100, end: 106 }]);
    assert.deepStrictEqual(segments, [{ file: f.a, from: 0, to: 6 }, { file: f.b, from: 2, to: 6 }]);
    const r = await buildVideo({ segments, outFile: out('reel-planned.mp4'), encoder, quality: 'medium' });
    near(r.duration, 10, 0.3, 'duration');
  });

  await test('buildVideo: long reels are built in parts and joined seamlessly', async () => {
    // 11 pieces (more than one FFmpeg run takes), with a silent clip in the second part
    const segments = [];
    for (let i = 0; i < 11; i++) segments.push(i === 9 ? { file: f.c, from: 0, to: 1 } : { file: i % 2 ? f.b : f.a, from: 1, to: 2.5 });
    const expected = 10 * 1.5 + 1;
    const progress = [];
    const outFile = out('reel-parts.mp4');
    const r = await buildVideo({ segments, outFile, encoder, quality: 'medium', onProgress: (p) => progress.push(p) });
    near(r.duration, expected, 0.3, 'returned duration');
    const info = await probe(outFile);
    assert.strictEqual(`${info.video[0].width}x${info.video[0].height} ${info.video[0].r_frame_rate}`, '2560x1440 60/1');
    near(parseFloat(info.audio[0].duration), expected, 0.3, 'audio covers the whole reel');
    // the silent clip is piece 10: 13.5-14.5 s, then the tone again
    const silent = await peakDb(outFile, 13.6, 0.8);
    const loud = await peakDb(outFile, 14.65, 1.2);
    assert.ok(silent < -60 && loud > -30, `silent part peaks at ${silent} dB, the next clip at ${loud} dB`);
    assert.ok(fs.readdirSync(OUT).every((n) => !n.startsWith('reel-parts.mp4.')), 'no pieces left behind');
    assert.ok(progress.every((p, i) => !i || p > progress[i - 1]) && progress[progress.length - 1] === 1, 'progress rises to 1');
    assert.ok(await decodesCleanly(outFile), 'decodes without errors');
  });

  await test('buildVideo: codec hevc is passed on (tagged hvc1 when honoured)', async () => {
    const r = await buildVideo({ segments: [{ file: f.a, from: 0, to: 2 }], outFile: out('reel-hevc.mp4'), encoder, codec: 'hevc' });
    const v = (await probe(r.file)).video[0];
    if (v.codec_name === 'hevc') assert.strictEqual(v.codec_tag_string, 'hvc1');
    else assert.strictEqual(v.codec_name, 'h264', 'falls back to H.264 while ffmpeg.js ignores the codec option');
    console.log(`      got ${v.codec_name} (${v.codec_tag_string})`);
  });

  await test('buildVideo: bad input gives clear errors', async () => {
    const outFile = out('reel-bad.mp4');
    await assert.rejects(buildVideo({ segments: [], outFile }), /no segments/);
    await assert.rejects(buildVideo({ segments: [{ file: out('missing.mp4') }], outFile, encoder }), /Could not read missing\.mp4/);
    await assert.rejects(buildVideo({ segments: [{ file: f.a, from: 5, to: 5 }], outFile, encoder }), /Segment 1 .* is empty/);
    const bad = out('bad?name.mp4'); // FFmpeg can't create this file: its own error must come through
    await assert.rejects(buildVideo({ segments: [{ file: f.a, from: 0, to: 1 }], outFile: bad, encoder }), (err) => {
      assert.match(err.message, /^FFmpeg failed: .*bad\?name\.mp4\.part/);
      return true;
    });
    assert.ok(![outFile, `${outFile}.part`].some((p) => fs.existsSync(p)), 'nothing written');
  });
}

// ------------------------------------------------------------------ exportForSharing

async function exportTests(encoder, f) {
  const fits10 = async (enc) => {
    const progress = [];
    const r = await exportForSharing({ file: f.d, targetMB: 10, outFile: out(`share-10mb-${enc}.mp4`), encoder: enc, onProgress: (p) => progress.push(p) });
    assert.ok(r.bytes < 10e6, `${r.bytes} bytes is not under 10 MB`);
    assert.ok(r.bytes > 7.5e6, `${r.bytes} bytes wastes most of the allowance`);
    assert.strictEqual(fs.statSync(r.file).size, r.bytes);
    const info = await probe(r.file);
    const v = info.video[0];
    assert.strictEqual(v.codec_name, 'h264');
    assert.strictEqual(`${v.width}x${v.height}`, `${r.width}x${r.height}`);
    const [n, d] = v.r_frame_rate.split('/').map(Number);
    near(n / d, r.fps, 0.01, 'frame rate');
    assert.strictEqual(info.audio.length, 1);
    assert.strictEqual(info.audio[0].codec_name, 'aac');
    near(info.duration, 20, 0.3, 'duration');
    assert.ok(await decodesCleanly(r.file), 'plays (decodes without errors)');
    assert.strictEqual(progress[progress.length - 1], 1, 'progress ends at 1');
    console.log(`      ${(r.bytes / 1e6).toFixed(2)} MB, ${r.width}x${r.height} @ ${r.fps} fps`);
  };

  if (encoder === 'nvenc') await test('exportForSharing: 20 s 1440p60 clip under 10 MB (NVENC)', () => fits10('nvenc'));
  await test('exportForSharing: 20 s 1440p60 clip under 10 MB (x264 two-pass)', () => fits10('x264'));

  await test('exportForSharing: too long for the size says how much fits', async () => {
    const outFile = out('share-too-long.mp4');
    await assert.rejects(exportForSharing({ file: f.d, targetMB: 1, outFile, encoder }), (err) => {
      assert.match(err.message, /This clip is 0:20 long, but only 0:18 fits in 1 MB/);
      assert.strictEqual(err.code, 'TOO_LONG');
      assert.strictEqual(err.maxDuration, 18);
      console.log(`      "${err.message}"`);
      return true;
    });
    assert.ok(![outFile, `${outFile}.part`].some((p) => fs.existsSync(p)), 'nothing written');
  });

  await test('exportForSharing: maps only the chosen audio track', async () => {
    const tone = await exportForSharing({ file: f.e, targetMB: 10, outFile: out('share-track0.mp4'), audioTrack: 0, encoder });
    const quiet = await exportForSharing({ file: f.e, targetMB: 10, outFile: out('share-track1.mp4'), audioTrack: 1, encoder });
    for (const r of [tone, quiet]) assert.strictEqual((await probe(r.file)).audio.length, 1, 'exactly one audio track');
    assert.strictEqual(`${tone.width}x${tone.height}`, '1280x720', 'never upscaled');
    const [t, q] = [await peakDb(tone.file), await peakDb(quiet.file)];
    assert.ok(t > -30 && q < -60, `track 0 peaks at ${t} dB, track 1 at ${q} dB`);
    await assert.rejects(exportForSharing({ file: f.e, targetMB: 10, outFile: out('share-track2.mp4'), audioTrack: 2, encoder }),
      /Audio track 2 doesn't exist/);
  });
}

// ------------------------------------------------------------------ lossless ranges (virtual clips)

async function rangeTests() {
  const { capture, join } = require('./virtual-fixture');
  const dir = path.join(OUT, 'ranges');
  fs.rmSync(dir, { recursive: true, force: true });
  const segs = await capture(dir, 30);
  const full = await join(segs, path.join(dir, 'full.mp4'));
  const clip = await join(segs.slice(4, 9), path.join(dir, 'clip.mp4')); // seconds 8..18 of the capture
  const other = await join((await capture(dir, 10, { seed: 1 })).slice(1, 4), path.join(dir, 'other.mp4'));
  const hashes = async (f) => (await videoPackets(f, { count: 1e6 })).map((p) => p.hash);

  await test('locateClip: finds a highlight inside the full recording, byte for byte', async () => {
    const at = await locateClip({ full, clip, near: 8.6 }); // a hint 0.6 s off, like rounded game times
    assert.ok(at != null, 'not found');
    near(at, 8, 0.1, 'offset');
  });
  await test('locateClip: footage from another capture, or a hint too far off, is not found', async () => {
    assert.strictEqual(await locateClip({ full, clip: other, near: 2 }), null);
    assert.strictEqual(await locateClip({ full, clip, near: 20 }), null);
    assert.strictEqual(await locateClip({ full, clip, near: NaN }), null);
  });
  await test('exportRange: a highlight range comes out frame for frame, with every audio track', async () => {
    const at = await locateClip({ full, clip, near: 8 });
    const length = (await probe(clip)).duration;
    const outFile = path.join(dir, 'exported.mp4');
    const r = await exportRange({ file: full, from: at, to: at + length, outFile });
    assert.strictEqual(r.file, outFile);
    const want = await hashes(clip);
    const got = await hashes(outFile);
    assert.deepStrictEqual(got.slice(0, want.length), want, 'the clip\'s video packets, in order');
    assert.ok(got.length - want.length <= 2, `${got.length - want.length} extra frames`);
    const info = await probe(outFile);
    assert.strictEqual(info.audio.length, 2, 'both audio tracks');
    near(info.duration, length, 0.15, 'length');
    assert.ok(await decodesCleanly(outFile), 'decodes cleanly');
    assert.ok(!fs.existsSync(`${outFile}.part`), 'no leftovers');
  });
  await test('exportRange: a start inside a 2-second segment starts on the keyframe before it', async () => {
    const outFile = path.join(dir, 'mid.mp4');
    await exportRange({ file: full, from: 9.3, to: 12, outFile });
    const first = (await videoPackets(outFile, { count: 1 }))[0];
    const full8 = (await videoPackets(full, { from: 8.2, length: 0.5 }))[0];
    assert.strictEqual(first.hash, full8.hash, 'starts at the keyframe of second 8');
    assert.ok(first.key);
  });
  await test('exportRange: never overwrites its source or an existing file, and checks the range', async () => {
    await assert.rejects(exportRange({ file: full, from: 0, to: 4, outFile: full }), /own source/);
    await assert.rejects(exportRange({ file: full, from: 0, to: 4, outFile: clip }), /already exists/);
    await assert.rejects(exportRange({ file: full, from: 5, to: 5, outFile: path.join(dir, 'x.mp4') }), /Not a range/);
    const before = fs.statSync(clip).size;
    assert.strictEqual(fs.statSync(clip).size, before);
  });
  await test('exportRange: a source that is not a video fails cleanly, leaving nothing', async () => {
    const bad = path.join(dir, 'bad.mp4');
    fs.writeFileSync(bad, 'not a video');
    const outFile = path.join(dir, 'from-bad.mp4');
    await assert.rejects(exportRange({ file: bad, from: 0, to: 2, outFile }));
    assert.ok(!fs.existsSync(outFile) && !fs.existsSync(`${outFile}.part`));
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ main

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`output folder: ${OUT}`);
  await planTests();
  await championTests();
  await rangeTests();

  const encoders = (await detectEncoders()).map((e) => e.id);
  const encoder = encoders.includes('nvenc') ? 'nvenc' : 'x264';
  console.log(`encoders: ${encoders.join(', ') || 'none'}; using ${encoder}`);
  let files = null;
  await test('synthetic inputs generated', async () => { files = await makeInputs(encoder); });
  if (files) {
    await buildTests(encoder, files);
    await exportTests(encoder, files);
  }

  // The videos run to hundreds of MB; the champion cache is tiny and stays for inspection.
  for (const name of fs.readdirSync(OUT)) {
    if (/\.(mp4|part)$/i.test(name)) fs.rmSync(path.join(OUT, name), { force: true });
  }
  console.log(`\n${tally.pass} passed, ${tally.fail} failed, ${tally.skip} skipped`);
  process.exit(tally.fail ? 1 : 0);
})().catch((err) => {
  console.error('FAILED:', err.stack || err.message);
  process.exit(1);
});
