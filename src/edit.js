// Editing engine: stitches highlights into one reel and makes size-capped copies for sharing
// (Discord and friends). Pure Node on top of the bundled FFmpeg, so it runs in the main
// process and from the command line alike.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { paths, run, videoEncoderArgs, detectEncoders } = require('./ffmpeg');

const fsp = fs.promises;

const MIN_PIECE = 0.5; // leftovers of an overlapping highlight shorter than this aren't worth a cut
const AUDIO_FORMAT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
const MAX_CMDLINE = 30000; // Windows refuses command lines longer than 32,767 characters
// One FFmpeg run opens every input at once (about 40 MB each at 1440p, on top of the encoder),
// so longer reels are built a few segments at a time and then joined without re-encoding.
const MAX_INPUTS = 8;

// Size-capped exports
const SHARE_MARGIN = 0.95; // aim 5 % under the limit: rate control and the MP4 index aren't exact
const MUX_KBPS = 10; // MP4 index (about 12 bytes per frame) and headers
const MIN_VIDEO_KBPS = 300; // below this the picture falls apart; better to ask for a trim
const MAX_VIDEO_KBPS = 20000; // 1080p60 looks great by here; more only wastes upload allowance
const BPP_60 = 0.055; // bits per pixel per frame below which 30 fps looks better than 60
// [minimum video kbps, output height]. 720p30 still looks clean for game footage at 2 Mbps,
// which keeps 30 s clips under Discord's 10 MB at 720p.
const LADDER = [[6000, 1080], [2000, 720], [0, 480]];

const round3 = (x) => Math.round(x * 1000) / 1000;
const even = (n) => Math.max(2, 2 * Math.round(n / 2)); // yuv420p needs even dimensions

// ------------------------------------------------------------------ highlight reel planning

// Highlights from one match are cut from the same continuous capture, so neighbours often share
// footage. clips: [{ file, start, end }] in match seconds (file-local time = match time - start).
// Returns [{ file, from, to }] in file-local seconds, in match order, showing every moment once.
function planHighlightReel(clips) {
  if (!Array.isArray(clips)) throw new TypeError('planHighlightReel expects an array of clips');
  const sorted = clips
    .filter(Boolean)
    .map((c) => ({ file: c.file, start: Number(c.start), end: Number(c.end) }))
    .filter((c) => c.file && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    // longest first among clips that start together, so the shorter ones are simply covered
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let covered = -Infinity; // match time up to which footage is already in the reel
  for (const c of sorted) {
    const from = Math.max(c.start, covered);
    // Fully covered, or only a sliver left. The cursor stays put so a later clip can still
    // show that sliver instead of skipping it.
    if (c.end - from < MIN_PIECE) continue;
    out.push({ file: c.file, from: round3(from - c.start), to: round3(c.end - c.start) });
    covered = c.end;
  }
  return out;
}

// ------------------------------------------------------------------ FFmpeg plumbing

let detected = null;
function resolveEncoder(encoder) {
  if (encoder && encoder !== 'auto') return Promise.resolve(encoder);
  if (!detected) detected = detectEncoders().then((list) => (list[0] ? list[0].id : 'x264'), () => 'x264');
  return detected;
}

function parseRate(text) {
  const [n, d] = String(text || '').split('/').map(Number);
  const v = d ? n / d : n;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// r_frame_rate is exact for constant-rate captures; avg_frame_rate copes with variable rate.
function frameRate(video) {
  for (const key of ['r_frame_rate', 'avg_frame_rate']) {
    const value = parseRate(video[key]);
    if (value >= 1 && value <= 240) return { value, text: video[key] };
  }
  return { value: 60, text: '60' };
}

async function probe(file) {
  const r = await run(paths.ffprobe, ['-v', 'error', '-show_entries',
    'format=duration:stream=index,codec_type,width,height,r_frame_rate,avg_frame_rate,duration:stream_disposition=attached_pic',
    '-of', 'json', file], { timeout: 30000 });
  let info = null;
  try { info = JSON.parse(r.stdout); } catch { /* reported below */ }
  if (r.code !== 0 || !info) {
    throw new Error(`Could not read ${path.basename(String(file))}: ${stderrTail(r.stderr) || 'ffprobe failed'}`);
  }
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const duration = parseFloat(info.format && info.format.duration) || 0;
  return {
    video,
    audio: streams.filter((s) => s.codec_type === 'audio'),
    duration,
    videoDuration: (video && parseFloat(video.duration)) || duration,
  };
}

// FFmpeg's last lines are usually generic ("Conversion failed!"); keep the ones that say why.
function stderrTail(text, n = 3) {
  const noise = /Conversion failed!|Terminating thread with return code|Task finished with error code|Nothing was written into output file|Error sending frames to consumers|Could not open encoder before EOF/;
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/ @ (0x)?[0-9a-f]+\]/i, ']').trim()).filter(Boolean);
  const useful = lines.filter((l) => !noise.test(l));
  return (useful.length ? useful.slice(-n) : lines.slice(-1)).join(' | ');
}

// Wraps the caller's callback: only forward progress, and never let a UI callback break an encode.
function progressReporter(onProgress) {
  let last = -1;
  return (f) => {
    if (typeof onProgress !== 'function' || !(f >= last + 0.001 || (f === 1 && last < 1))) return;
    last = f;
    try { onProgress(f); } catch { /* ignore */ }
  };
}

// Runs FFmpeg with machine-readable progress on stdout. `span` maps this run onto part of the
// caller's progress bar (each pass of a two-pass encode gets its own share).
function runFFmpeg(args, { duration, report, span = [0, 1] }) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(paths.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', ...args],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`Could not start FFmpeg: ${err.message}`));
      return;
    }
    let stderr = '';
    let pending = '';
    let timedOut = false;
    // Generous: even a CPU two-pass encode runs far faster than 1/30 of real time.
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, Math.max(30 * 60e3, duration * 30e3));
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        // 1 is reserved for "finished": the caller still renames the file after FFmpeg exits.
        if (m && duration > 0) report(Math.min(0.999, span[0] + (span[1] - span[0]) * Math.min(1, Number(m[1]) / 1e6 / duration)));
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-20000); });
    proc.on('error', (err) => { clearTimeout(timer); reject(new Error(`Could not start FFmpeg: ${err.message}`)); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else if (timedOut) reject(new Error('FFmpeg took too long and was stopped'));
      else reject(new Error(`FFmpeg failed: ${stderrTail(stderr) || `exit code ${code}`}`));
    });
  });
}

const cmdLength = (args) => args.reduce((n, a) => n + String(a).length + 3, 0);

// ------------------------------------------------------------------ building a reel

// segments: [{ file, from?, to? }] in file-local seconds (missing = whole file). Everything is
// re-encoded at the first segment's size and frame rate, so clips from different capture
// settings can be mixed. Returns { file, duration }.
async function buildVideo({ segments, outFile, encoder, quality = 'high', codec = 'h264', onProgress } = {}) {
  if (!Array.isArray(segments) || !segments.length) throw new Error('Nothing to build: no segments given');
  if (!outFile) throw new Error('No output file given');
  const report = progressReporter(onProgress);
  encoder = await resolveEncoder(encoder);

  const infos = new Map();
  for (const s of segments) {
    if (!s || !s.file) throw new Error('Every segment needs a file');
    if (!infos.has(s.file)) infos.set(s.file, await probe(s.file));
  }
  const parts = segments.map((s, i) => {
    const info = infos.get(s.file);
    const name = path.basename(s.file);
    if (!info.video) throw new Error(`${name} has no video`);
    const length = info.videoDuration;
    const from = Math.min(Math.max(Number(s.from) || 0, 0), length);
    const to = s.to == null ? length : Math.min(Number(s.to), length);
    if (!(to - from >= 0.05)) throw new Error(`Segment ${i + 1} (${name}) is empty: ${from.toFixed(2)}–${Number(to).toFixed(2)} s of a ${length.toFixed(2)} s video`);
    return { file: s.file, from, to, len: to - from, info };
  });

  const first = parts[0].info.video;
  if (!(first.width > 0 && first.height > 0)) throw new Error(`Could not read the picture size of ${path.basename(parts[0].file)}`);
  const look = { W: even(first.width), H: even(first.height), fps: frameRate(first).text };
  const total = parts.reduce((n, p) => n + p.len, 0);

  // The 4th argument is newer than some copies of ffmpeg.js; only tag HEVC if we really got it.
  const vargs = videoEncoderArgs(encoder, quality, undefined, { codec });
  const hevc = /hevc|265/i.test(vargs[vargs.indexOf('-c:v') + 1] || '');
  const tag = hevc ? ['-tag:v', 'hvc1'] : [];
  const finish = ['-movflags', '+faststart', '-f', 'mp4'];
  const tmp = `${outFile}.part`;
  await fsp.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  try {
    if (parts.length <= MAX_INPUTS) {
      await encodeParts(parts, look, ['-map', '[v]', '-map', '[a]', ...vargs, ...tag, '-c:a', 'aac', '-b:a', '192k', ...finish, tmp],
        { duration: total, report });
    } else {
      // Pieces keep PCM sound so the final join encodes the audio once, without gaps at the seams.
      const pieces = [];
      const list = path.join(os.tmpdir(), `clipvault-concat-${process.pid}-${Date.now()}.txt`);
      try {
        let done = 0;
        for (let i = 0; i < parts.length; i += MAX_INPUTS) {
          const group = parts.slice(i, i + MAX_INPUTS);
          const len = group.reduce((n, p) => n + p.len, 0);
          const piece = `${outFile}.piece${pieces.length}.part`; // not a video extension: stays out of the library
          pieces.push(piece);
          await encodeParts(group, look, ['-map', '[v]', '-map', '[a]', ...vargs, '-c:a', 'pcm_s16le', '-f', 'mov', piece],
            { duration: len, report, span: [(0.97 * done) / total, (0.97 * (done + len)) / total] });
          done += len;
        }
        const quote = (f) => `file '${path.resolve(f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
        await fsp.writeFile(list, pieces.map(quote).join('\n'));
        await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', ...tag,
          '-c:a', 'aac', '-b:a', '192k', ...finish, tmp], { duration: total, report, span: [0.97, 1] });
      } finally {
        await Promise.all([list, ...pieces].map((f) => fsp.rm(f, { force: true }).catch(() => {})));
      }
    }
    await fsp.rename(tmp, outFile);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  report(1);
  const done = await probe(outFile).catch(() => null);
  return { file: outFile, duration: done && done.duration ? done.duration : round3(total) };
}

// One FFmpeg run: cuts `parts` from their files, brings them to the same picture size, frame
// rate and sound format, and joins them with the concat filter into `output` (args + file).
async function encodeParts(parts, { W, H, fps }, output, { duration, report, span }) {
  const inputs = [];
  const graph = [];
  parts.forEach((p, i) => {
    // Input seeking: FFmpeg jumps to the keyframe before `from`, decodes up to it and trims
    // exactly, and only reads as far as `to`.
    inputs.push('-ss', p.from.toFixed(3), '-to', p.to.toFixed(3), '-i', p.file);
    const v = p.info.video;
    const fit = v.width === W && v.height === H ? ''
      : `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${W}:${H}:-1:-1,`;
    // start_time=0 pads with the first frame if video starts late; concat needs every piece at 0.
    graph.push(`[${i}:${v.index}]${fit}setsar=1,fps=${fps}:start_time=0,format=yuv420p[v${i}]`);
    const a = p.info.audio[0];
    graph.push(a
      // async fills capture gaps with silence so sound stays in sync; apad covers a short tail
      ? `[${i}:${a.index}]aresample=48000:async=1:first_pts=0,${AUDIO_FORMAT},apad=whole_dur=${p.len.toFixed(3)}[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${p.len.toFixed(3)},${AUDIO_FORMAT}[a${i}]`);
  });
  graph.push(`${parts.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${parts.length}:v=1:a=1[v][a]`);

  let filter = ['-filter_complex', graph.join(';')];
  let script = null;
  if (cmdLength([paths.ffmpeg, ...inputs, ...filter, ...output]) > MAX_CMDLINE) {
    // Very long file names: hand FFmpeg the graph as a file instead.
    script = path.join(os.tmpdir(), `clipvault-graph-${process.pid}-${Date.now()}.txt`);
    await fsp.writeFile(script, graph.join(';\n'));
    filter = ['-/filter_complex', script];
  }
  try {
    await runFFmpeg([...inputs, ...filter, ...output], { duration, report, span });
  } finally {
    if (script) fsp.rm(script, { force: true }).catch(() => {});
  }
}

// ------------------------------------------------------------------ size-capped exports

function clock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
}

// Splits a byte budget into audio and video bitrates and picks the output size and frame rate.
// Returns null when the video bitrate would fall below MIN_VIDEO_KBPS.
function sharePlan(duration, budget, video, hasAudio) {
  const totalKbps = (budget * 8) / duration / 1000 - MUX_KBPS;
  const audioKbps = !hasAudio ? 0 : totalKbps - 128 >= 2000 ? 128 : 96;
  const available = totalKbps - audioKbps;
  if (available < MIN_VIDEO_KBPS) return null;
  const videoKbps = Math.floor(Math.min(available, MAX_VIDEO_KBPS));
  const rung = LADDER.find(([min]) => videoKbps >= min)[1];
  const height = Math.min(rung, even(video.height)); // never upscale
  const width = even((video.width * height) / video.height);
  // 60 fps only when each frame still gets enough bits; never raise the source's rate.
  const src = frameRate(video);
  const high = src.value <= 60 ? src : { value: 60, text: '60' };
  let fps = src.value <= 30 ? src : { value: 30, text: '30' };
  if (src.value > 30 && (videoKbps * 1000) / (width * height * high.value) >= BPP_60) fps = high;
  return { videoKbps, audioKbps, width, height, fps };
}

function shareVideoArgs(encoder, kbps) {
  const rate = ['-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.1)}k`, '-bufsize', `${kbps * 2}k`];
  switch (encoder) {
    case 'nvenc':
      // Full-resolution multipass lands NVENC within a few percent of the target bitrate.
      return ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-multipass', 'fullres',
        ...rate, '-spatial-aq', '1', '-rc-lookahead', '20'];
    case 'amf':
      return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'vbr_peak', ...rate];
    case 'qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'slow', ...rate];
    default:
      return ['-c:v', 'libx264', '-preset', 'medium', ...rate]; // run as two passes
  }
}

async function encodeShare({ file, video, track, plan, encoder, tmp, duration, report }) {
  const input = ['-i', file, '-map', `0:${video.index}`];
  const vf = ['-vf', `fps=${plan.fps.text},scale=${plan.width}:${plan.height},setsar=1,format=yuv420p`];
  const audio = track === null ? ['-an']
    : ['-map', `0:a:${track}`, '-c:a', 'aac', '-b:a', `${plan.audioKbps}k`, '-ac', '2', '-ar', '48000'];
  const output = ['-movflags', '+faststart', '-f', 'mp4', tmp];
  const vargs = shareVideoArgs(encoder, plan.videoKbps);
  if (vargs[1] !== 'libx264') {
    await runFFmpeg([...input, ...vf, ...vargs, ...audio, ...output], { duration, report });
    return;
  }
  // x264 two-pass: the first pass measures the whole clip so the second spends bits exactly.
  const log = path.join(os.tmpdir(), `clipvault-2pass-${process.pid}-${Date.now()}`);
  try {
    await runFFmpeg([...input, ...vf, ...vargs, '-pass', '1', '-passlogfile', log, '-an', '-f', 'null', '-'],
      { duration, report, span: [0, 0.4] });
    await runFFmpeg([...input, ...vf, ...vargs, '-pass', '2', '-passlogfile', log, ...audio, ...output],
      { duration, report, span: [0.4, 1] });
  } finally {
    const base = path.basename(log);
    const leftovers = await fsp.readdir(os.tmpdir()).catch(() => []);
    await Promise.all(leftovers.filter((n) => n.startsWith(base))
      .map((n) => fsp.rm(path.join(os.tmpdir(), n), { force: true }).catch(() => {})));
  }
}

// Makes an H.264/AAC MP4 under targetMB megabytes (1 MB = 1,000,000 bytes) with only the chosen
// audio track. Returns { file, bytes, width, height, fps }.
async function exportForSharing({ file, targetMB, outFile, audioTrack = 0, encoder, onProgress } = {}) {
  const limit = Number(targetMB) * 1e6;
  if (!(limit > 0)) throw new Error('Pick a size limit for the export');
  if (!file || !outFile) throw new Error('exportForSharing needs a file and an outFile');
  const info = await probe(file);
  const name = path.basename(file);
  if (!info.video) throw new Error(`${name} has no video`);
  if (!(info.video.width > 0 && info.video.height > 0)) throw new Error(`Could not read the picture size of ${name}`);
  const duration = Math.max(info.duration, info.videoDuration);
  if (!(duration > 0)) throw new Error(`Could not read the length of ${name}`);
  let track = null;
  if (info.audio.length) {
    // Never fall back to another track: track 0 is the full mix, which may include the mic.
    track = Number(audioTrack);
    if (!(Number.isInteger(track) && track >= 0 && track < info.audio.length)) {
      throw new Error(`Audio track ${audioTrack} doesn't exist; ${name} has ${info.audio.length} (0–${info.audio.length - 1})`);
    }
  }
  encoder = await resolveEncoder(encoder);
  await fsp.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  const tmp = `${outFile}.part`;

  let budget = limit * SHARE_MARGIN;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const report = progressReporter(onProgress); // a retry starts the bar again
    const plan = sharePlan(duration, budget, info.video, track !== null);
    if (!plan && attempt === 1) {
      const maxDuration = (budget * 8) / 1000 / (MIN_VIDEO_KBPS + (track !== null ? 96 : 0) + MUX_KBPS);
      throw Object.assign(new Error(`This clip is ${clock(Math.round(duration))} long, but only ${clock(maxDuration)} fits in ${targetMB} MB. `
        + `Trim it to ${clock(maxDuration)} or less, or pick a larger size.`), { code: 'TOO_LONG', maxDuration: Math.floor(maxDuration) });
    }
    if (!plan) break;
    let bytes;
    try {
      await encodeShare({ file, video: info.video, track, plan, encoder, tmp, duration, report });
      bytes = (await fsp.stat(tmp)).size;
      if (bytes < limit) await fsp.rename(tmp, outFile);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    if (bytes < limit) {
      report(1);
      return { file: outFile, bytes, width: plan.width, height: plan.height, fps: round3(plan.fps.value) };
    }
    // Overshot (unusually complex footage): aim lower by the amount we missed, plus margin.
    budget *= (budget / bytes) * SHARE_MARGIN;
  }
  await fsp.rm(tmp, { force: true }).catch(() => {});
  throw new Error(`Could not get ${name} under ${targetMB} MB. Trim it or pick a larger size.`);
}

// ------------------------------------------------------------------ lossless ranges (virtual clips)

// Seek this far past `from`: a stream copy starts on the keyframe at or before the seek point, and
// a start a few milliseconds early (times rounded to a tenth, audio priming ahead of the video)
// would otherwise pull in the whole previous 2-second segment.
const KEYFRAME_SLACK = 0.05;

// Copies seconds from..to of `file` into outFile without re-encoding: every stream, every audio
// track with its name. A stream copy can only start on a keyframe, so it starts on the last one at
// or before from + KEYFRAME_SLACK. ClipVault's captures have a keyframe every 2 seconds, on the same
// grid as its highlights, so a highlight's range comes out frame for frame. Written to
// outFile.part and then renamed, so outFile is never half-written. Returns { file, duration }.
async function exportRange({ file, from, to, outFile, onProgress } = {}) {
  if (!file || !outFile) throw new Error('exportRange needs a file and an outFile');
  from = Math.max(0, Number(from));
  to = Number(to);
  if (!(Number.isFinite(from) && Number.isFinite(to) && to - from >= 0.1)) throw new Error(`Not a range: ${from}–${to} s`);
  if (path.resolve(file).toLowerCase() === path.resolve(outFile).toLowerCase()) throw new Error('exportRange would overwrite its own source');
  if (fs.existsSync(outFile)) throw new Error(`${path.basename(outFile)} already exists`);
  const report = progressReporter(onProgress);
  const seek = from + KEYFRAME_SLACK;
  await fsp.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  const tmp = `${outFile}.part`;
  try {
    await runFFmpeg(['-ss', seek.toFixed(3), '-i', file, '-t', Math.max(0.05, to - seek).toFixed(3),
      '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-f', 'mp4', tmp],
    { duration: to - from, report });
    await fsp.rename(tmp, outFile);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  report(1);
  const done = await probe(outFile).catch(() => null);
  return { file: outFile, duration: done && done.duration ? done.duration : round3(to - from) };
}

// The first video packets of `file` (or those from `from` for `length` seconds; the read starts
// on the keyframe before `from`): [{ t, key, hash }], t in seconds from the start of the file.
async function videoPackets(file, { from = null, length = null, count = null } = {}) {
  const interval = from == null ? `%+#${count || 1}` : `${Math.max(0, from).toFixed(3)}%+${(length || 1).toFixed(3)}`;
  const r = await run(paths.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', interval,
    '-show_entries', 'packet=pts_time,flags,data_hash:format=start_time', '-show_data_hash', 'MD5', '-of', 'json', file], { timeout: 60000 });
  let info = null;
  try { info = JSON.parse(r.stdout); } catch { /* below */ }
  if (r.code !== 0 || !info) throw new Error(`Could not read ${path.basename(String(file))}: ${stderrTail(r.stderr) || 'ffprobe failed'}`);
  const base = parseFloat(info.format && info.format.start_time) || 0;
  return (info.packets || [])
    .filter((p) => p.data_hash && Number.isFinite(parseFloat(p.pts_time)))
    .map((p) => ({ t: round3(parseFloat(p.pts_time) - base), key: /K/.test(p.flags || ''), hash: p.data_hash }));
}

// Where `clip`'s footage is inside `full`, proven byte for byte: every video packet of the clip
// must appear, in order, in `full`, starting within `window` seconds of `near` (seconds into
// `full`). Resolves the offset in seconds (clip time 0 = that many seconds into `full`), or null
// when the footage isn't all there. This is what has to hold before a highlight's own file may go.
async function locateClip({ full, clip, near, window = 4 } = {}) {
  if (!Number.isFinite(near)) return null;
  const mine = await videoPackets(clip, { count: 1e6 });
  if (!mine.length || !mine[0].key) return null;
  const span = mine[mine.length - 1].t - mine[0].t;
  const around = await videoPackets(full, { from: Math.max(0, near - window), length: span + 2 * window + 1 });
  for (let i = 0; i + mine.length <= around.length; i++) {
    if (around[i].hash !== mine[0].hash) continue;
    if (mine.every((p, j) => around[i + j].hash === p.hash)) return round3(around[i].t - mine[0].t);
  }
  return null;
}

module.exports = { planHighlightReel, buildVideo, exportForSharing, exportRange, videoPackets, locateClip, probe };
