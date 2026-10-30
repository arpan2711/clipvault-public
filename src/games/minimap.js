// Records just the League minimap for a whole match: a small screen crop at 10 fps, cheap
// enough (tens of MB per game) to keep for every match. It's shown next to that match's
// highlights as a guide to where everyone was.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { paths, videoEncoderArgs } = require('../ffmpeg');
const { leagueInstallDir } = require('./lcu');

const FPS = 10;

// HUD settings from the League install's Config/game.cfg (minimap size and side).
function readLeagueHud() {
  const hud = { scale: 1, flip: false };
  try {
    const cfg = fs.readFileSync(path.join(leagueInstallDir(), 'Config', 'game.cfg'), 'utf8');
    const value = (key) => { const m = new RegExp(`^${key}=([\\d.]+)`, 'm').exec(cfg); return m ? Number(m[1]) : null; };
    if (value('MinimapScale') !== null) hud.scale = value('MinimapScale');
    hud.flip = value('FlipMiniMap') === 1;
  } catch { /* League not found: assume the defaults */ }
  return hud;
}

// The minimap is a square flush with the bottom-right corner (bottom-left when flipped).
// At MinimapScale 1.0 it measures 0.258 of the screen height (372 px at 1440p); other scales
// haven't been measured, so they get a generous crop that's sure to contain it.
function minimapRect(display, hud) {
  const scaled = Math.abs(hud.scale - 1) < 0.01 ? 0.262 : 0.36;
  const side = Math.min(display.width, display.height, Math.round((display.height * scaled) / 2) * 2); // even, for H.264
  return { x: hud.flip ? 0 : display.width - side, y: display.height - side, side };
}

class MinimapRecorder {
  constructor() {
    this.proc = null;
    this.file = null;
    this.startWall = null; // wall-clock time of the recording's first frame
  }

  get active() {
    return Boolean(this.proc);
  }

  start({ display, monitor, encoder, outFile }) {
    if (this.proc) return;
    const hud = readLeagueHud();
    const r = minimapRect(display, hud);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const source = `ddagrab=output_idx=${monitor}:framerate=${FPS}:draw_mouse=0:offset_x=${r.x}:offset_y=${r.y}:video_size=${r.side}x${r.side}`;
    const args = [
      '-hide_banner', '-loglevel', 'warning', '-y', '-progress', 'pipe:1', '-stats_period', '0.5',
      '-f', 'lavfi', '-i', encoder === 'nvenc' ? source : `${source},hwdownload,format=bgra`,
      ...videoEncoderArgs(encoder, 'medium', FPS * 2), '-an',
      // Fragmented MP4 stays playable even if the app or PC dies mid-match.
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', outFile,
    ];
    const proc = spawn(paths.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.file = outFile;
    this.startWall = null;
    this.stderr = '';
    proc.stdin.on('error', () => {});
    proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-2000); });
    // "out_time_us" = how much video exists; wall time minus that = when the first frame was taken.
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (!m) return;
      const start = Date.now() - Number(m[1]) / 1000;
      if (Number(m[1]) > 0 && (this.startWall === null || start < this.startWall)) this.startWall = start;
    });
    this.exited = new Promise((resolve) => {
      proc.on('error', () => resolve(-1));
      proc.on('close', (code) => {
        if (this.proc === proc) {
          this.proc = null;
          if (this.onDied) this.onDied(code, this.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | '));
        }
        resolve(code);
      });
    });
    return r;
  }

  // The file of the match, also when FFmpeg stopped by itself mid-match (Desktop Duplication lost:
  // ddagrab never recovers): the fragmented MP4 up to then is still the match reel. Before, that
  // returned null and the reel of the match was never added to the library.
  async stop() {
    const proc = this.proc;
    const file = this.file;
    this.file = null;
    if (!file) return null;
    if (proc) {
      try { proc.stdin.write('q'); } catch { /* ignore */ }
      const done = await Promise.race([this.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
      if (!done) {
        proc.kill();
        await this.exited;
      }
    }
    this.proc = null;
    return fs.existsSync(file) && fs.statSync(file).size > 0 ? { file, startWall: this.startWall } : null;
  }
}

// The minimap's start time is estimated from FFmpeg's progress reports, which lag the actual
// capture by about a second. After the match we measure the real alignment: crop the minimap
// out of a clip recorded by the main capture and find the offset where it best matches the
// minimap recording (image similarity, SSIM). Returns the correction in seconds, or null.
async function measureSyncError({ clipFile, clipHeight, clipDuration, offset, mapFile, display }) {
  const os = require('os');
  const { run } = require('../ffmpeg');
  const r = minimapRect(display, readLeagueHud());
  const k = clipHeight && display.height ? clipHeight / display.height : 1; // capture may be downscaled
  const crop = `crop=${Math.round(r.side * k)}:${Math.round(r.side * k)}:${Math.round(r.x * k)}:${Math.round(r.y * k)}`;
  // Sample a busy stretch: a few seconds into a highlight, or well into a full recording (its
  // start is the loading screen and a quiet early game).
  const at = clipDuration > 60 ? Math.min(600, clipDuration * 0.3) : Math.min(5, Math.max(0, clipDuration / 3));
  const len = Math.min(4, Math.max(1.5, clipDuration - at - 0.5));
  const tmp = path.join(os.tmpdir(), `clipvault-sync-${process.pid}-${Date.now()}.mkv`);
  try {
    // The clip's minimap, scaled to the minimap recording's size, extracted once.
    const ex = await run(paths.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', clipFile, '-t', String(len),
      '-vf', `${crop},scale=${r.side}:${r.side},fps=${FPS}`, '-an', '-c:v', 'ffv1', tmp], { timeout: 60000 });
    if (ex.code !== 0) return null;
    const score = async (delta) => {
      const start = offset + delta + at;
      if (start < 0) return -1;
      const res = await run(paths.ffmpeg, ['-hide_banner', '-i', tmp, '-ss', start.toFixed(2), '-i', mapFile,
        '-filter_complex', `[1:v]fps=${FPS}[b];[0:v][b]ssim`, '-t', String(len), '-f', 'null', '-'], { timeout: 30000 });
      const m = /All:([\d.]+)/.exec(res.stderr);
      return m ? Number(m[1]) : -1;
    };
    let best = { delta: 0, s: -1 };
    for (let d = -3; d <= 3.001; d += 0.25) { const s = await score(d); if (s > best.s) best = { delta: d, s }; }
    const coarse = best.delta;
    for (let d = coarse - 0.2; d <= coarse + 0.201; d += 0.05) { const s = await score(d); if (s > best.s) best = { delta: d, s }; }
    return best.s >= 0.85 ? { delta: Math.round(best.delta * 20) / 20, ssim: best.s } : null; // clear match only
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

module.exports = { MinimapRecorder, readLeagueHud, minimapRect, measureSyncError };
