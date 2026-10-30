// Synthetic League footage made the way the recorder makes it (recorder.js): a test-pattern capture
// cut into 2-second MPEG-TS segments with a keyframe at the start of each, then joined with a
// stream copy into MP4s. The full recording is every segment; a highlight is a run of them. Two
// audio tracks with names, like a capture with separate tracks.
const fs = require('fs');
const path = require('path');
const { paths, run } = require('../src/ffmpeg');

const SEGMENT = 2;

async function ffmpeg(args) {
  const r = await run(paths.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 5 * 60e3 });
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim()}`);
}

// Segments of `seconds` of capture in dir\seg\ ; `seed` changes the picture so captures differ.
async function capture(dir, seconds, { seed = 0, size = '320x180' } = {}) {
  const segDir = path.join(dir, `seg${seed}`);
  fs.rmSync(segDir, { recursive: true, force: true });
  fs.mkdirSync(segDir, { recursive: true });
  const src = seed ? `testsrc=size=${size}:rate=30:duration=${seconds}` : `testsrc2=size=${size}:rate=30:duration=${seconds}`;
  await ffmpeg(['-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', `sine=frequency=${440 + seed * 100}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=${660 + seed * 100}:duration=${seconds}`,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-g', String(30 * SEGMENT), '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT})`, '-c:a', 'aac', '-b:a', '96k',
    '-f', 'segment', '-segment_time', String(SEGMENT), '-segment_format', 'mpegts',
    '-segment_format_options', 'mpegts_flags=+initial_discontinuity', path.join(segDir, 'seg_%04d.ts')]);
  return fs.readdirSync(segDir).filter((n) => n.endsWith('.ts')).sort().map((n) => path.join(segDir, n));
}

// Joins segments into an MP4 like recorder._join (bytes of the segments, remuxed).
async function join(segs, outFile) {
  const ts = `${outFile}.ts`;
  fs.writeFileSync(ts, Buffer.concat(segs.map((s) => fs.readFileSync(s))));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  try {
    await ffmpeg(['-probesize', '20M', '-analyzeduration', '10M', '-f', 'mpegts', '-i', ts, '-map', '0:v?', '-map', '0:a?', '-c', 'copy',
      '-metadata:s:a:0', 'title=Mixed', '-metadata:s:a:0', 'handler_name=Mixed', '-metadata:s:a:1', 'title=Game', '-metadata:s:a:1', 'handler_name=Game',
      '-movflags', '+faststart', '-f', 'mp4', outFile]);
  } finally {
    fs.rmSync(ts, { force: true });
  }
  return outFile;
}

module.exports = { capture, join, SEGMENT };
