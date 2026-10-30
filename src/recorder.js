// Capture engine.
//
// One long-running FFmpeg process captures the screen (plus the audio tracks streamed by
// cvhelper) and writes 2-second MPEG-TS segments into a hidden buffer folder:
//   * Instant replay joins the newest segments into an MP4 - no re-encoding, so it's fast.
//   * A recording keeps every segment from the moment it started and joins them on stop.
// Segments that neither needs are deleted as new ones arrive, so the buffer stays small.
// If FFmpeg exits or stops producing segments, 'crashed' is emitted and the owner restarts it.
const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { paths, videoEncoderArgs, codecFor } = require('./ffmpeg');

const SEGMENT_SECONDS = 2;
const STALL_MS = 6000; // no new segment (one every 2 s) for this long = capture froze

// FFmpeg lines that mean the screen capture is gone for good. ddagrab never reinitialises Desktop
// Duplication: when Windows takes it away (DXGI_ERROR_ACCESS_LOST on a fullscreen / display mode
// switch, a UAC prompt, a GPU driver reset) AcquireNextFrame fails, the video input ends, and FFmpeg
// keeps running on the audio pipes alone with no new segments, until the STALL_MS watchdog. Seeing
// the line restarts capture right away instead.
const FATAL_CAPTURE = /AcquireNextFrame failed|Output parameters changed|DDA ReleaseFrame failed|DDA error|Failed duplicating output|Error during demuxing|Error while filtering/i;
// Capture falling behind (FFmpeg filling gaps in ddagrab's timestamps): logged, not acted on.
const DUPLICATED = /More than \d+ frames duplicated/i;
const RESOLUTION_HEIGHT = { 1440: 1440, 1080: 1080, 720: 720 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastLines(text, n = 3) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ');
}

// Virtual-key code of a push-to-talk setting, or 0 when it isn't a usable key.
function pttKey(ptt) {
  const vk = Math.round(Number(ptt && ptt.vk));
  return vk >= 1 && vk <= 255 ? vk : 0;
}

function pumpFile(file, dest) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file);
    const onDestError = (err) => { rs.destroy(); reject(err); };
    dest.once('error', onDestError);
    rs.on('error', (err) => { dest.off('error', onDestError); reject(err); });
    rs.on('end', () => { dest.off('error', onDestError); resolve(); });
    rs.pipe(dest, { end: false });
  });
}

class Recorder extends EventEmitter {
  constructor() {
    super();
    this.state = 'idle'; // idle | starting | running | stopping
    this.opts = null;
    this.info = null; // { method, encoder, codec, audio, audioTracks } of the running session
    this.proc = null;
    this.procExit = Promise.resolve();
    this.helper = null;
    this.audioInputs = []; // [{ title, pipe }] in track order
    this.dir = null;
    this.listPath = null;
    this.segments = [];
    this.prunedUpTo = 0;
    this.recording = null;
    this.locks = new Map(); // pending saves -> oldest segment index they need
    this.pending = new Set();
    this.replaySeconds = 30;
    this.minimumKeep = 0;
    this.wallAnchor = null;
    this.stopping = null;
    // The footage of the session before a capture restart (stop({ keepFootage })), so a clip or a
    // death cam of the moments before a freeze can still be saved once capture runs again:
    // { dir, segments, wallAnchor, info, busy }. Never joined with the new session's segments
    // (a new FFmpeg, maybe a different encoder or tracks); dropped once the new session holds
    // as much as the buffer keeps.
    this.previous = null;
  }

  status() {
    let buffered = 0;
    for (let i = this.segments.length - 1; i >= 0 && !this.segments[i].deleted; i--) buffered += this.segments[i].dur;
    return {
      state: this.state,
      info: this.info,
      recording: this.recording ? { startedAt: this.recording.startedAt, game: this.recording.game } : null,
      saving: this.pending.size,
      bufferedSeconds: Math.min(buffered, this.replaySeconds),
    };
  }

  setReplaySeconds(seconds) {
    this.replaySeconds = seconds;
    this._prune();
  }

  _setState(state) {
    this.state = state;
    this.emit('status');
  }

  // ------------------------------------------------------------------ start / stop

  async start(opts) {
    if (this.state !== 'idle') return;
    this.opts = opts;
    this.replaySeconds = opts.replaySeconds;
    this._setState('starting');
    this._cleanupOldSessions();

    // Desktop Duplication + the chosen encoder is the fast path; fall back to GDI capture,
    // H.264 on the same GPU (when H.265 was asked for) or the CPU encoder if the failure
    // points at one of them.
    let method = 'ddagrab';
    let encoder = opts.encoder;
    const wantedCodec = codecFor(encoder, opts.codec);
    let codec = wantedCodec;
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this._launch(method, encoder, codec);
        this.info = {
          method, encoder, codec,
          audio: this.audioInputs.length > 0,
          audioTracks: this.audioInputs.map((t) => t.title),
        };
        if (encoder !== opts.encoder) this.emit('warning', `Using the CPU encoder because ${opts.encoder} failed to start`);
        else if (codec !== wantedCodec) this.emit('warning', 'Recording in H.264 because H.265 failed to start');
        const mic = opts.audio && opts.audio.mic;
        if (mic && mic.ptt && !pttKey(mic.ptt)) this.emit('warning', "The push-to-talk key isn't recognised, so the microphone is off");
        this._setState('running');
        return;
      } catch (err) {
        lastError = err;
        this.emit('log', `capture start failed (${method}/${encoder}${codec === 'hevc' ? '/hevc' : ''}): ${err.message}`);
        if (method === 'ddagrab' && /ddagrab|dxgi|duplicat|output_idx|d3d11/i.test(err.message)) { method = 'gdigrab'; continue; }
        if (encoder !== 'x264' && /nvenc|amf|qsv|encoder|OpenEncodeSession|capable device|Cannot load|hwdownload/i.test(err.message)) {
          if (codec === 'hevc') codec = 'h264';
          else encoder = 'x264';
          continue;
        }
        break;
      }
    }
    await this._teardownProcesses();
    this._removeDir(this.dir);
    this.dir = null;
    this._setState('idle');
    throw lastError;
  }

  async _launch(method, encoder, codec) {
    await this._teardownProcesses();
    this._removeDir(this.dir);
    this.dir = path.join(this.opts.bufferRoot, `session-${Date.now()}`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.listPath = path.join(this.dir, 'segments.csv');
    this.listOffset = 0;
    this.listTail = '';
    this.segments = [];
    this.prunedUpTo = 0;
    this.wallAnchor = null;

    this.audioInputs = [];
    const plan = this._audioPlan();
    if (plan) {
      try {
        await this._startHelper(plan.args);
        this.audioInputs = plan.tracks;
      } catch (err) {
        this.emit('warning', `Audio capture unavailable: ${err.message}`);
      }
    }

    const args = this._buildArgs(method, encoder, codec);
    this.emit('log', `ffmpeg ${args.join(' ')}`);
    const proc = spawn(paths.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = proc;
    this.stderrTail = '';
    proc.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
      if (this.proc === proc) this._onStderr(proc, String(d));
    });
    proc.stdin.on('error', () => {});
    this.procExit = new Promise((resolve) => {
      proc.on('error', (err) => { this.stderrTail += `\n${err.message}`; resolve(-1); });
      proc.on('close', resolve);
    });

    // Healthy = the first segment exists and FFmpeg is still alive 1.5 s after launch
    // (capture and encoder errors both surface well within that window).
    const first = path.join(this.dir, 'seg_000000.ts');
    const t0 = Date.now();
    let healthy = false;
    while (Date.now() - t0 < 10000) {
      await sleep(250);
      if (proc.exitCode !== null || proc.killed) break;
      if (Date.now() - t0 >= 1500 && fs.existsSync(first)) { healthy = true; break; }
    }
    if (!healthy) {
      try { proc.kill(); } catch { /* already gone */ }
      await this.procExit;
      throw new Error(lastLines(this.stderrTail) || 'FFmpeg failed to start capturing');
    }

    proc.on('close', (code) => this._onExit(proc, code));
    this.lastSegmentAt = Date.now();
    this.pollTimer = setInterval(() => { this._pollList(); this._checkStall(); }, 250);
  }

  _buildArgs(method, encoder, codec) {
    const o = this.opts;
    const fps = o.fps;
    const targetHeight = RESOLUTION_HEIGHT[o.resolution];
    const scale = targetHeight && o.display && o.display.height > targetHeight
      ? `scale=-2:${targetHeight}:flags=bicubic` : null;
    const cpuFormat = encoder === 'amf' || encoder === 'qsv' ? 'format=nv12' : null;
    const mouse = o.drawMouse === false ? 0 : 1;
    const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-y'];

    if (method === 'ddagrab') {
      // NVENC can encode the captured GPU textures directly (zero copy). Everything else
      // needs the frames downloaded to system memory first.
      const graph = [`ddagrab=output_idx=${o.monitor || 0}:framerate=${fps}:draw_mouse=${mouse}`];
      if (encoder !== 'nvenc' || scale) graph.push('hwdownload', 'format=bgra');
      if (scale) graph.push(scale);
      if (cpuFormat) graph.push(cpuFormat);
      args.push('-f', 'lavfi', '-i', graph.join(','));
    } else {
      const d = o.display || {};
      args.push('-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', String(mouse));
      if (d.width && d.height) {
        args.push('-offset_x', String(d.x || 0), '-offset_y', String(d.y || 0), '-video_size', `${d.width}x${d.height}`);
      }
      args.push('-i', 'desktop');
    }

    for (const track of this.audioInputs) {
      args.push('-thread_queue_size', '4096', '-f', 'f32le', '-ar', '48000', '-ch_layout', 'stereo', '-i', track.pipe);
    }

    args.push('-map', '0:v');
    this.audioInputs.forEach((_, i) => args.push('-map', `${i + 1}:a`));
    if (method !== 'ddagrab') {
      const vf = [scale, cpuFormat].filter(Boolean);
      if (vf.length) args.push('-vf', vf.join(','));
    }
    args.push(...videoEncoderArgs(encoder, o.quality, fps * SEGMENT_SECONDS, { codec }),
      '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`);
    if (this.audioInputs.length) args.push('-c:a', 'aac', '-b:a', '160k');
    args.push(
      '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-segment_format', 'mpegts',
      // Lets segments be concatenated byte-for-byte without continuity errors.
      '-segment_format_options', 'mpegts_flags=+initial_discontinuity',
      '-segment_list', this.listPath, '-segment_list_type', 'csv',
      path.join(this.dir, 'seg_%06d.ts'),
    );
    return args;
  }

  // What cvhelper captures and which audio tracks FFmpeg receives. opts.audio:
  //   { game: { kind: 'loopback' | 'process', exe, volume } | null,
  //     mic: { volume, ptt: { vk, releaseMs } | null } | null,
  //     discord: { exe, volume } | null,
  //     separateTracks: bool }
  // Track 0 "Mixed" always carries every source, so players that only use the first track
  // still play everything; separateTracks adds "Game", "Microphone" and "Discord" tracks for
  // the enabled sources. Without opts.audio, the older flat options (systemAudio,
  // systemVolume, mic, micVolume, audioOnlyExe) give the single mixed track as before.
  _audioPlan() {
    const o = this.opts;
    const id = `clipvault-${process.pid}-${Date.now()}`;
    const pipe = (name) => `\\\\.\\pipe\\${name}`;
    const a = o.audio;
    if (!a) {
      if (!o.systemAudio && !o.mic) return null;
      return {
        args: ['audio', id, o.systemAudio ? String(o.systemVolume) : '-1', o.mic ? String(o.micVolume) : '-1',
          ...(o.audioOnlyExe ? [o.audioOnlyExe] : [])], // one program's sound instead of everything
        tracks: [{ title: 'Mixed', pipe: pipe(id) }],
      };
    }
    const volume = (v) => String(Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 100);
    const discordExe = a.discord ? a.discord.exe || 'Discord.exe' : null;
    // A push-to-talk mic without a usable key stays off instead of recording all the time.
    const mic = a.mic && (!a.mic.ptt || pttKey(a.mic.ptt)) ? a.mic : null;
    const sources = []; // [helper source name, kind, volume, track title]
    if (a.game) {
      let kind = 'loopback';
      if (a.game.kind === 'process' && a.game.exe) kind = `process:${a.game.exe}`;
      // Everything you hear includes Discord already; leave it out so it isn't doubled.
      else if (discordExe) kind = `except:${discordExe}`;
      sources.push(['game', kind, a.game.volume, 'Game']);
    }
    if (mic) sources.push(['mic', 'mic', mic.volume, 'Microphone']);
    if (discordExe) sources.push(['discord', `process:${discordExe}`, a.discord.volume, 'Discord']);
    if (!sources.length) return null;

    const outputs = [['mixed', sources.map((s) => s[0]), 'Mixed']];
    if (a.separateTracks) for (const [name, , , title] of sources) outputs.push([name, [name], title]);
    const args = ['audio2', id];
    for (const [name, kind, vol] of sources) args.push('--src', `${name}=${kind}:${volume(vol)}`);
    for (const [name, srcs] of outputs) args.push('--out', `${name}=${srcs.join(',')}`);
    if (mic && mic.ptt) args.push('--ptt', `mic:${pttKey(mic.ptt)}:${Math.max(0, Math.round(Number(mic.ptt.releaseMs) || 0))}`);
    return { args, tracks: outputs.map(([name, , title]) => ({ title, pipe: pipe(`${id}-${name}`) })) };
  }

  _startHelper(args) {
    return new Promise((resolve, reject) => {
      const helper = spawn(paths.helper, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.helper = helper;
      const timer = setTimeout(() => reject(new Error('audio helper did not respond')), 5000);
      helper.stdout.on('data', (d) => {
        if (String(d).includes('READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
      helper.stderr.on('data', (d) => this.emit('log', `[audio] ${String(d).trim()}`));
      helper.stdin.on('error', () => {});
      helper.on('error', (err) => { clearTimeout(timer); reject(err); });
      helper.on('close', (code) => { clearTimeout(timer); reject(new Error(`audio helper exited (${code})`)); });
    });
  }

  _onExit(proc, code) {
    if (proc !== this.proc) return;
    clearInterval(this.pollTimer);
    this._pollList();
    if (this.state === 'stopping') return;
    // Unexpected: display mode change, GPU driver reset, etc. The owner decides whether
    // to save what's there and restart.
    this.emit('crashed', lastLines(this.stderrTail) || `FFmpeg exited with code ${code}`);
  }

  _onStderr(proc, text) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (DUPLICATED.test(line)) this.emit('log', `capture falling behind: ${line}`);
      else if (FATAL_CAPTURE.test(line) && this.state === 'running') this.restartCapture(`screen capture failed: ${line}`);
    }
  }

  // FFmpeg can stay alive with its capture frozen: after sleep, Desktop Duplication stops
  // delivering frames without an error and only audio trickles into one endless segment.
  // No new segment for STALL_MS counts as a crash, so the owner restarts capture.
  _checkStall() {
    if (this.state !== 'running' || Date.now() - this.lastSegmentAt < STALL_MS) return;
    this.restartCapture(`capture froze (no new video for ${Math.round((Date.now() - this.lastSegmentAt) / 1000)} s)`);
  }

  // Kills FFmpeg so the 'crashed' path restarts capture, e.g. when the PC wakes from sleep.
  restartCapture(reason) {
    const proc = this.proc;
    if (this.state !== 'running' || !proc || proc.exitCode !== null || proc.restartReason) return;
    proc.restartReason = reason;
    this.emit('log', `restarting capture: ${reason}`);
    this.stderrTail += `\n${reason}`;
    try { proc.kill(); } catch { /* already gone */ }
  }

  // keepFootage: capture stopped by itself and is restarted; the segments stay usable as
  // `previous` until the new session has caught up (see saveRange).
  stop({ keepFootage = false } = {}) {
    if (this.state === 'idle') {
      if (!keepFootage) this._dropPrevious();
      return Promise.resolve();
    }
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this._setState('stopping');
      const proc = this.proc;
      if (proc && proc.exitCode === null) {
        try { proc.stdin.write('q'); } catch { /* ignore */ }
        const exited = await Promise.race([this.procExit.then(() => true), sleep(5000).then(() => false)]);
        if (!exited) {
          proc.kill();
          await this.procExit;
        }
      }
      clearInterval(this.pollTimer);
      this._pollList();
      await Promise.allSettled([...this.pending]);
      await this._teardownProcesses();
      const live = this.segments.filter((x) => !x.deleted);
      if (keepFootage && this.dir && live.length && this.wallAnchor !== null) {
        this._dropPrevious(true);
        this.previous = { dir: this.dir, segments: live, wallAnchor: this.wallAnchor, info: this.info, busy: 0 };
      } else {
        this._dropPrevious();
        this._removeDir(this.dir);
      }
      this.dir = null;
      this.segments = [];
      this.recording = null;
      this.locks.clear();
      this.info = null;
      this.stopping = null;
      this._setState('idle');
    })();
    return this.stopping;
  }

  async _teardownProcesses() {
    clearInterval(this.pollTimer);
    if (this.helper) {
      const h = this.helper;
      this.helper = null;
      try { h.stdin.end(); } catch { /* ignore */ }
      try { h.kill(); } catch { /* ignore */ }
    }
    if (this.proc && this.proc.exitCode === null) {
      try { this.proc.kill(); } catch { /* ignore */ }
      await this.procExit;
    }
  }

  _cleanupOldSessions() {
    const root = this.opts.bufferRoot;
    fs.mkdirSync(root, { recursive: true });
    spawn('attrib', ['+h', root], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    const keep = this.previous && path.resolve(this.previous.dir);
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (/^session-\d+$/.test(name) && path.resolve(dir) !== keep) this._removeDir(dir);
    }
  }

  // force: even while a save reads from it (only when it's replaced by a newer one).
  _dropPrevious(force = false) {
    const p = this.previous;
    if (!p || (p.busy && !force)) return;
    this.previous = null;
    this._removeDir(p.dir);
  }

  // The previous session isn't needed once the current one reaches back as far as the buffer keeps.
  _expirePrevious() {
    if (!this.previous) return;
    let held = 0;
    for (let i = this.segments.length - 1; i >= 0 && !this.segments[i].deleted; i--) held += this.segments[i].dur;
    if (held >= Math.max(this.replaySeconds, this.minimumKeep) + 2 * SEGMENT_SECONDS) this._dropPrevious();
  }

  _removeDir(dir) {
    if (!dir || !/[\\/]session-\d+$/.test(dir)) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* files may still be locked */ }
  }

  // -------------------------------------------------------------- segment tracking

  _pollList() {
    if (!this.listPath) return;
    let fd;
    try { fd = fs.openSync(this.listPath, 'r'); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= this.listOffset) return;
      const buf = Buffer.alloc(size - this.listOffset);
      fs.readSync(fd, buf, 0, buf.length, this.listOffset);
      this.listOffset = size;
      const lines = (this.listTail + buf.toString('utf8')).split('\n');
      this.listTail = lines.pop();
      let added = 0;
      for (const line of lines) {
        const [file, startStr, endStr] = line.trim().split(',');
        if (!file) continue;
        const prev = this.segments[this.segments.length - 1];
        let start = parseFloat(startStr);
        let dur = parseFloat(endStr) - start;
        if (!(dur > 0 && dur < 30)) dur = SEGMENT_SECONDS;
        if (!Number.isFinite(start)) start = prev ? prev.end : 0;
        const end = start + dur;
        const anchor = Date.now() - end * 1000;
        if (this.wallAnchor === null || anchor < this.wallAnchor) this.wallAnchor = anchor;
        this.segments.push({ file: path.join(this.dir, path.basename(file)), dur, start, end, deleted: false });
        added++;
      }
      if (added) {
        this.lastSegmentAt = Date.now();
        this._prune();
        this.emit('status');
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  _startIndexFor(seconds, end) {
    let start = end + 1;
    let acc = 0;
    for (let i = end; i >= 0 && !this.segments[i].deleted; i--) {
      start = i;
      acc += this.segments[i].dur;
      if (acc >= seconds) break;
    }
    return Math.max(0, start);
  }

  // Segment times in the CSV are on FFmpeg's capture clock. wallAnchor maps them to wall-clock
  // time; it uses the smallest observed (arrival - end) so polling latency doesn't skew it.
  _wallStart(seg) {
    return this.wallAnchor + seg.start * 1000;
  }

  _wallEnd(seg) {
    return this.wallAnchor + seg.end * 1000;
  }

  // Index of the first segment still holding footage from `ms` onwards.
  _indexAtWall(ms) {
    if (this.wallAnchor === null) return 0;
    for (let i = this.prunedUpTo; i < this.segments.length; i++) {
      if (this._wallEnd(this.segments[i]) > ms) return i;
    }
    return this.segments.length;
  }

  // Wait until a completed segment reaches wall-clock time `ms`.
  async _waitForWall(ms) {
    const deadline = Math.max(Date.now(), ms) + 8000;
    this._pollList();
    for (;;) {
      const last = this.segments[this.segments.length - 1];
      if (last && this._wallEnd(last) >= ms) return;
      if (!this.proc || this.proc.exitCode !== null) {
        await sleep(100);
        this._pollList();
        return;
      }
      if (Date.now() > deadline) return;
      await sleep(100);
      this._pollList();
    }
  }

  // Keep at least this much footage even if the replay length is shorter (auto clips need
  // to reach back further than "now minus replay length").
  setMinimumKeep(seconds) {
    this.minimumKeep = seconds;
    this._prune();
  }

  _prune() {
    const segs = this.segments;
    const keep = Math.max(this.replaySeconds, this.minimumKeep);
    let keepFrom = this._startIndexFor(keep + 2 * SEGMENT_SECONDS, segs.length - 1);
    if (this.recording) keepFrom = Math.min(keepFrom, this.recording.startPos);
    for (const pos of this.locks.values()) keepFrom = Math.min(keepFrom, pos);
    for (let i = this.prunedUpTo; i < keepFrom; i++) {
      if (segs[i].deleted) continue;
      segs[i].deleted = true;
      fs.unlink(segs[i].file, () => {});
    }
    this.prunedUpTo = Math.max(this.prunedUpTo, keepFrom);
    this._expirePrevious();
  }

  // Wait until the segment at `pos` (usually the one being written) is complete.
  async _waitForSegment(pos, timeout = 8000) {
    const t0 = Date.now();
    this._pollList();
    while (this.segments.length <= pos) {
      if (!this.proc || this.proc.exitCode !== null) {
        await sleep(100);
        this._pollList();
        break;
      }
      if (Date.now() - t0 > timeout) break;
      await sleep(100);
      this._pollList();
    }
  }

  _track(job) {
    this.pending.add(job);
    this.emit('status');
    const done = () => {
      this.pending.delete(job);
      this.emit('status');
    };
    job.then(done, done);
    return job;
  }

  // ---------------------------------------------------------------- saving output

  saveReplay(seconds, outFile) {
    const now = Date.now();
    return this.saveRange(now - seconds * 1000, now, outFile);
  }

  // Save the footage between two wall-clock times (ms since epoch). `toMs` may lie a little
  // in the future: the save finishes once that moment has been captured.
  saveRange(fromMs, toMs, outFile) {
    if (this.state !== 'running') return Promise.reject(new Error('The replay buffer is not running'));
    const info = this.info || {};
    const lock = {};
    this.locks.set(lock, this._indexAtWall(fromMs));
    let prev = null;
    return this._track((async () => {
      try {
        await this._waitForWall(toMs);
        // A segment is included when most of it falls after fromMs, so the clip starts on the
        // nearest segment boundary; the segment containing toMs is always included.
        const pick = (list, anchor) => list.filter((s) => !s.deleted
          && anchor + s.end * 1000 > fromMs + s.dur * 500 && anchor + s.start * 1000 < toMs);
        const total = (list) => list.reduce((a, s) => a + s.dur, 0);
        let segs = pick(this.segments, this.wallAnchor);
        let anchor = this.wallAnchor;
        let from = info;
        // The moment was (mostly) before capture restarted: save it from the footage kept then.
        prev = this.previous;
        const old = prev ? pick(prev.segments, prev.wallAnchor) : [];
        if (old.length && total(old) > total(segs)) {
          segs = old;
          anchor = prev.wallAnchor;
          from = prev.info || {};
          prev.busy++;
        } else {
          prev = null;
        }
        if (!segs.length) throw new Error('Nothing was captured at that moment');
        await this._join(segs, outFile, from);
        return {
          file: outFile, duration: total(segs), startWall: anchor + segs[0].start * 1000,
          codec: from.codec || 'h264', audioTracks: from.audioTracks || [],
        };
      } finally {
        this.locks.delete(lock);
        if (prev) { prev.busy--; this._expirePrevious(); }
      }
    })());
  }

  startRecording(meta = {}) {
    if (this.state !== 'running') throw new Error('Capture is not running');
    if (!this.recording) {
      this.recording = { ...meta, startPos: this.segments.length, startedAt: Date.now() };
      this.emit('status');
    }
    return this.recording;
  }

  stopRecording(outFile) {
    const rec = this.recording;
    if (!rec) return Promise.reject(new Error('Not recording'));
    this.recording = null;
    const info = this.info || {};
    const endPos = this.segments.length;
    const lock = {};
    this.locks.set(lock, rec.startPos);
    return this._track((async () => {
      try {
        await this._waitForSegment(endPos);
        const end = Math.min(endPos, this.segments.length - 1);
        const segs = this.segments.slice(rec.startPos, end + 1).filter((s) => !s.deleted);
        if (!segs.length) throw new Error('The recording is empty');
        await this._join(segs, outFile, info);
        return {
          file: outFile, duration: segs.reduce((a, s) => a + s.dur, 0), meta: rec, startWall: this._wallStart(segs[0]),
          codec: info.codec || 'h264', audioTracks: info.audioTracks || [],
        };
      } finally {
        this.locks.delete(lock);
      }
    })());
  }

  // Stream the segments into FFmpeg and remux them into a single MP4 (stream copy). `info` is
  // the session that wrote them: its codec and audio track names.
  async _join(segs, outFile, info = {}) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const tmp = `${outFile}.part`;
    // MPEG-TS can't carry track names, so they're added here; players start with the first
    // ("Mixed"), the only one marked default.
    const trackArgs = [];
    (info.audioTracks || []).forEach((title, i) => trackArgs.push(
      `-metadata:s:a:${i}`, `title=${title}`, `-metadata:s:a:${i}`, `handler_name=${title}`,
      `-disposition:a:${i}`, i === 0 ? 'default' : '0'));
    const proc = spawn(paths.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-probesize', '20M', '-analyzeduration', '10M',
      '-f', 'mpegts', '-i', 'pipe:0',
      '-map', '0:v?', '-map', '0:a?', '-c', 'copy',
      // hvc1 instead of FFmpeg's default hev1: the H.265 sample entry browsers reliably play.
      ...(info.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
      ...trackArgs,
      '-movflags', '+faststart', '-f', 'mp4', tmp,
    ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    proc.stdin.on('error', () => {});
    const exited = new Promise((resolve) => {
      proc.on('error', (err) => { stderr += err.message; resolve(-1); });
      proc.on('close', resolve);
    });

    let pumpError = null;
    for (const seg of segs) {
      try {
        await pumpFile(seg.file, proc.stdin);
      } catch (err) {
        pumpError = err;
        break;
      }
    }
    proc.stdin.end();
    const code = await exited;
    if (code !== 0) {
      fs.rm(tmp, { force: true }, () => {});
      throw new Error(lastLines(stderr) || (pumpError && pumpError.message) || `FFmpeg exited with code ${code}`);
    }
    fs.renameSync(tmp, outFile);
  }
}

module.exports = { Recorder, SEGMENT_SECONDS, FATAL_CAPTURE, DUPLICATED };
