// Locates the bundled binaries and holds the FFmpeg encoder presets shared by
// live capture and trimming.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// From source: <repo>/bin (filled by setup.js). Installed: <install dir>/resources/bin, where the
// release build puts ffmpeg.exe, ffprobe.exe and cvhelper.exe (package.json build.extraResources).
const BIN = isPackaged() ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', 'bin');

function isPackaged() {
  try {
    const { app } = require('electron'); // plain Node (the tests) gets a path string, so no app
    return Boolean(app && app.isPackaged);
  } catch {
    return false;
  }
}

function resolveBinary(name) {
  const local = path.join(BIN, `${name}.exe`);
  return fs.existsSync(local) ? local : name; // fall back to PATH
}

const paths = {
  ffmpeg: resolveBinary('ffmpeg'),
  ffprobe: resolveBinary('ffprobe'),
  // CLIPVAULT_HELPER points tests at a freshly built helper while the installed one is in use.
  helper: process.env.CLIPVAULT_HELPER || path.join(BIN, 'cvhelper.exe'),
};

function run(bin, args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout, stderr: err.message });
      return;
    }
    const timer = setTimeout(() => proc.kill(), timeout);
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: err.message }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// hevcCodec: the encoder's H.265 variant. The CPU encoder has none on purpose: x265 is far too
// slow for live capture, so it always records H.264 (see codecFor).
const ENCODERS = [
  { id: 'nvenc', codec: 'h264_nvenc', hevcCodec: 'hevc_nvenc', label: 'NVIDIA NVENC (GPU)' },
  { id: 'amf', codec: 'h264_amf', hevcCodec: 'hevc_amf', label: 'AMD AMF (GPU)' },
  { id: 'qsv', codec: 'h264_qsv', hevcCodec: 'hevc_qsv', label: 'Intel Quick Sync (GPU)' },
  { id: 'x264', codec: 'libx264', hevcCodec: null, label: 'CPU (x264)' },
];

// Encode a tiny test clip with every candidate; whatever succeeds is usable on this PC.
// Returns [{ id, codec, label, hevc }] where hevc says whether that encoder can do H.265 too.
async function detectEncoders() {
  const works = (codec) => run(paths.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2',
    '-c:v', codec, '-f', 'null', '-',
  ], { timeout: 15000 }).then((r) => r.code === 0);
  const results = await Promise.all(ENCODERS.map(async (e) => {
    if (!(await works(e.codec))) return null;
    // Only encoders that work at all are asked about H.265.
    const hevc = e.hevcCodec ? await works(e.hevcCodec) : false;
    return { id: e.id, codec: e.codec, label: e.label, hevc };
  }));
  return results.filter(Boolean);
}

// The codec a session really produces: H.265 only when asked for and on a GPU encoder.
function codecFor(encoder, codec) {
  const e = ENCODERS.find((x) => x.id === encoder);
  return codec === 'hevc' && e && e.hevcCodec ? 'hevc' : 'h264';
}

async function ffmpegAvailable() {
  const r = await run(paths.ffmpeg, ['-hide_banner', '-version'], { timeout: 10000 });
  return r.code === 0;
}

const QUALITY = {
  low: { cq: 30, crf: 28 },
  medium: { cq: 26, crf: 24 },
  high: { cq: 22, crf: 21 },
  ultra: { cq: 18, crf: 18 },
};

// gop: keyframe interval in frames for live capture (segments can only split on
// keyframes). Omit it for file exports. codec 'hevc' selects the GPU encoder's H.265 variant
// (same settings); the CPU encoder stays on libx264 / H.264 either way.
function videoEncoderArgs(encoder, quality, gop, { codec = 'h264' } = {}) {
  const q = QUALITY[quality] || QUALITY.high;
  const live = Boolean(gop);
  const keyframes = live ? ['-g', String(gop)] : [];
  const hevc = codec === 'hevc';
  switch (encoder) {
    case 'nvenc':
      return ['-c:v', hevc ? 'hevc_nvenc' : 'h264_nvenc', '-preset', live ? 'p4' : 'p5', '-tune', 'hq', '-rc', 'vbr',
        '-cq', String(q.cq), '-b:v', '0', '-spatial-aq', '1', ...keyframes, ...(live ? ['-forced-idr', '1'] : [])];
    case 'amf':
      return ['-c:v', hevc ? 'hevc_amf' : 'h264_amf', '-quality', live ? 'speed' : 'balanced', '-rc', 'cqp',
        '-qp_i', String(q.cq), '-qp_p', String(q.cq + 2), ...keyframes];
    case 'qsv':
      return ['-c:v', hevc ? 'hevc_qsv' : 'h264_qsv', '-preset', live ? 'veryfast' : 'medium', '-global_quality', String(q.cq), ...keyframes];
    default:
      // x265 can't keep up with live capture, so H.265 requests still get x264.
      return ['-c:v', 'libx264', '-preset', live ? 'superfast' : 'fast', '-crf', String(q.crf), '-pix_fmt', 'yuv420p', ...keyframes];
  }
}

module.exports = { paths, run, ENCODERS, detectEncoders, codecFor, ffmpegAvailable, videoEncoderArgs };
