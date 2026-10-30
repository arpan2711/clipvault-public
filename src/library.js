// Clip library: scans the save folder, keeps a small metadata index (type, game,
// duration, thumbnail) and performs the file operations the UI offers.
const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { paths, run, videoEncoderArgs } = require('./ffmpeg');
const { sanitizeName } = require('./foreground');
const { writeAtomic, readJsonWithBackup, isInside } = require('./fsutil');

const fsp = fs.promises;
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.webm']);
const STRIP_FRAMES = 14; // stills in a video's film strip (the player's trim lane)
const PROBE_VERSION = 2; // bump to re-read file details (audio tracks, frame rate, codec) for old videos

class Library extends EventEmitter {
  // iconFor(championName) -> local icon path or null (a cache kept by the caller)
  // log(message) -> notes about the index file (restored from backup, kept a corrupt copy)
  constructor(userDataDir, getSaveDir, trash, { iconFor, log } = {}) {
    super();
    this.indexFile = path.join(userDataDir, 'library.json');
    this.backupFile = `${this.indexFile}.bak`;
    this.thumbDir = path.join(userDataDir, 'thumbnails');
    this.inputDir = path.join(userDataDir, 'inputs');
    this.getSaveDir = getSaveDir;
    this.trash = trash;
    this.iconFor = iconFor || (() => null);
    // The index holds everything that isn't in the video files themselves (types, match links,
    // stats, favourites), so a bad file must never silently become an empty index.
    const { data, from } = readJsonWithBackup(this.indexFile, this.backupFile, { log: log || (() => {}) });
    this.index = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    // Once per session, keep the last index that loaded cleanly.
    if (from === 'file') { try { fs.copyFileSync(this.indexFile, this.backupFile); } catch { /* not critical */ } }
    this.saving = Promise.resolve();
    this.queue = [];
    this.queued = new Set();
    this.working = 0;
    this.goingVirtual = new Set(); // clips whose file is on its way to the Recycle Bin (virtualize)
    this.onRemoveFull = null; // (fullFile, dependents) before a full recording with virtual clips goes
    this.matches = null; // the League match store (matches.js), once useMatches() is called
    this.logMatches = () => {};
  }

  // Keeps the match records in step with the videos: a rename re-points the record, a deletion
  // (or a video gone from disk) takes it off its match, and a match's new key reaches every
  // entry that has the old one. The store never touches a video.
  useMatches(store, { log } = {}) {
    this.matches = store;
    this.logMatches = log || (() => {});
    store.on('rekeyed', ({ from, to }) => {
      let changed = false;
      for (const meta of Object.values(this.index)) {
        if (meta.match === from) { meta.match = to; changed = true; }
      }
      if (changed) this._changed();
    });
  }

  // Stamps the match key on these videos' entries (the ones that exist).
  setMatch(files, key) {
    let changed = false;
    for (const f of [].concat(files || [])) {
      const meta = this.index[path.resolve(f)];
      if (meta && key && meta.match !== key) { meta.match = key; changed = true; }
    }
    if (changed) this._changed();
  }

  _tellMatches(method, ...args) {
    if (!this.matches) return;
    try {
      Promise.resolve(this.matches[method](...args)).catch((err) => this.logMatches(`match store: ${err.message}`));
    } catch (err) {
      this.logMatches(`match store: ${err.message}`);
    }
  }

  assertInside(file) {
    const root = path.resolve(this.getSaveDir()).toLowerCase() + path.sep;
    if (typeof file !== 'string' || !path.resolve(file).toLowerCase().startsWith(root)) {
      throw new Error('That file is not in the ClipVault folder');
    }
    return path.resolve(file);
  }

  async list() {
    const root = path.resolve(this.getSaveDir());
    const unreadable = []; // folders that couldn't be listed (an unplugged drive, no permission)
    const files = await this._walk(root, 3, unreadable);
    const seen = new Set();
    const items = [];
    for (const file of files) {
      let st;
      try { st = await fsp.stat(file); } catch { continue; }
      seen.add(file);
      let meta = this.index[file];
      if (meta && meta.virtual && !this.goingVirtual.has(file)) {
        // A virtual clip's own file is back (restored from the Recycle Bin, or a materialize that
        // stopped before it could say so): it's a file again.
        delete meta.virtual;
        this._tellMatches('setClipFile', file, file);
      }
      if (!meta || meta.size !== st.size || meta.mtime !== st.mtimeMs) {
        meta = { ...(meta || {}), size: st.size, mtime: st.mtimeMs, created: (meta && meta.created) || st.birthtimeMs || st.mtimeMs, probed: false };
        this.index[file] = meta;
      }
      if (this._needsWork(file, meta)) this._enqueue(file);
      items.push(this._item(file, meta, root));
    }
    const seenLower = new Set([...seen].map((f) => f.toLowerCase()));
    for (const key of Object.keys(this.index)) {
      if (seen.has(key)) continue;
      const meta = this.index[key];
      const gone = (f) => !unreadable.some((dir) => isInside(f, dir));
      if (meta.virtual) {
        // A virtual clip lives as long as the full recording it's a range of.
        if (seenLower.has(path.resolve(meta.virtual.file).toLowerCase()) || !gone(meta.virtual.file)) {
          meta.size = 0;
          if (this._needsWork(key, meta)) this._enqueue(key);
          items.push(this._item(key, meta, root));
          continue;
        }
        this._forget(key);
        continue;
      }
      // Forget a video only when its folder was readable and it's really gone.
      if (gone(key)) this._forget(key);
    }
    this._saveIndexSoon();
    return items.sort((a, b) => b.created - a.created);
  }

  async add(file, extra) {
    file = path.resolve(file);
    const st = await fsp.stat(file);
    this.index[file] = { ...extra, size: st.size, mtime: st.mtimeMs, created: Date.now(), probed: false };
    await this._process(file);
    this._changed();
  }

  async rename(file, newName) {
    file = this.assertInside(file);
    const clean = sanitizeName(newName);
    if (!clean) throw new Error('Please enter a name');
    const target = path.join(path.dirname(file), clean + path.extname(file));
    if (target === file) return this._itemFor(file);
    if (fs.existsSync(target) || this.index[target]) throw new Error('A video with that name already exists');
    // A virtual clip has no file of its own: only its name changes.
    if (!(this.index[file] && this.index[file].virtual)) await fsp.rename(file, target);
    try { await fsp.rename(this._thumbPath(file), this._thumbPath(target)); } catch { /* regenerated later */ }
    try { await fsp.rename(this._inputsPath(file), this._inputsPath(target)); } catch { /* no inputs recorded */ }
    this.index[target] = this.index[file];
    delete this.index[file];
    for (const meta of Object.values(this.index)) {
      if (meta.map && meta.map.file === file) meta.map.file = target; // clips linked to a renamed minimap
      if (meta.virtual && meta.virtual.file === file) meta.virtual.file = target; // ranges of a renamed full recording
    }
    this._tellMatches('renameFile', file, target);
    this._changed();
    return this._itemFor(target);
  }

  // Moves a video to the Recycle Bin. A virtual clip has no file: it's only forgotten. Before a
  // full recording that virtual clips are ranges of goes, onRemoveFull(file, clips) turns the ones
  // worth keeping (favourites, the best moments) back into files; if that fails, nothing is
  // removed. The virtual clips still left go with the recording.
  async remove(file) {
    file = this.assertInside(file);
    const meta = this.index[file];
    if (meta && meta.virtual) {
      this._forget(file);
      this._changed();
      return;
    }
    if (this.onRemoveFull && this.dependents(file).length) await this.onRemoveFull(file, this.dependents(file));
    await this.trash(file);
    this._forget(file);
    for (const d of this.dependents(file)) this._forget(d.file);
    this._changed();
  }

  _forget(file) {
    fs.rm(this._thumbPath(file), { force: true }, () => {});
    fs.rm(this._inputsPath(file), { force: true }, () => {});
    const meta = this.index[file];
    delete this.index[file];
    if (meta && (meta.match || meta.virtual)) this._tellMatches('unlinkFile', file);
  }

  // ------------------------------------------------------------------ virtual clips
  // A virtual clip is a highlight whose own file went to the Recycle Bin because the match's full
  // recording holds the same footage. Its entry stays (markers, inputs, thumbnail, match) with
  // meta.virtual = { file: the full recording, from, to: seconds into it, bytes: its old size }.

  // Virtual clips that are ranges of this full recording: [{ file, meta }].
  dependents(fullFile) {
    const f = path.resolve(fullFile).toLowerCase();
    return Object.entries(this.index)
      .filter(([, meta]) => meta.virtual && path.resolve(meta.virtual.file).toLowerCase() === f)
      .map(([file, meta]) => ({ file, meta }));
  }

  isVirtual(file) {
    const meta = this.index[path.resolve(String(file))];
    return Boolean(meta && meta.virtual);
  }

  // Makes a highlight virtual: marks it (and saves the index) first, then sends its file to the
  // Recycle Bin, so a crash in between leaves a file that list() turns back into a normal clip.
  // If the Recycle Bin refuses, the clip stays a file. Never a favourite.
  async virtualize(file, { full, from, to }) {
    file = this.assertInside(file);
    full = this.assertInside(full);
    const meta = this.index[file];
    if (!meta) throw new Error('That video is not in the library');
    if (meta.virtual) return false;
    if (meta.favorite) throw new Error('Favourites always keep their own file');
    if (file.toLowerCase() === full.toLowerCase()) throw new Error('A recording cannot be a range of itself');
    if (!this.index[full] || this.index[full].virtual) throw new Error('The full recording is not in the library');
    if (!(Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from)) throw new Error('Not a range of the full recording');
    const virtual = { file: full, from: Math.round(from * 1000) / 1000, to: Math.round(to * 1000) / 1000, bytes: meta.size || 0 };
    meta.virtual = virtual;
    this.goingVirtual.add(file); // list() must not take the mark off while the file is still there
    try {
      await this._saveIndex();
      await this.trash(file);
    } catch (err) {
      delete meta.virtual;
      this._changed();
      throw err;
    } finally {
      this.goingVirtual.delete(file);
    }
    meta.virtual = virtual;
    meta.size = 0; // no file: it takes no space and the storage limit has nothing to free
    this._tellMatches('setClipFile', file, null);
    this._changed();
    await this._saveIndex();
    return true;
  }

  // Turns a virtual clip back into a file at its old path (or a free name next to it), cut from
  // the full recording without re-encoding by exportRange({ file, from, to, outFile }). Resolves
  // the real file's path (the same path when the clip already is a file). Calls for the same clip
  // share one export.
  materialize(file, exportRange) {
    file = path.resolve(String(file));
    const meta = this.index[file];
    if (!meta || !meta.virtual) return Promise.resolve(file);
    this.materializing = this.materializing || new Map();
    if (this.materializing.has(file)) return this.materializing.get(file);
    const job = (async () => {
      const v = meta.virtual;
      if (!fs.existsSync(v.file)) throw new Error('The full recording this clip is part of is gone');
      const ext = path.extname(file);
      const base = file.slice(0, file.length - ext.length);
      let out = file;
      for (let n = 2; fs.existsSync(out) || (out !== file && this.index[out]); n++) out = `${base} (${n})${ext}`;
      await exportRange({ file: v.file, from: v.from, to: v.to, outFile: out });
      const st = await fsp.stat(out);
      const thumbOk = meta.thumbFor === meta.mtime && !meta.thumbFailed;
      delete meta.virtual;
      Object.assign(meta, { size: st.size, mtime: st.mtimeMs, probed: false });
      if (thumbOk) meta.thumbFor = st.mtimeMs; // the same footage: the thumbnail still fits
      if (out !== file) {
        try { await fsp.rename(this._thumbPath(file), this._thumbPath(out)); } catch { /* made again */ }
        try { await fsp.rename(this._inputsPath(file), this._inputsPath(out)); } catch { /* none recorded */ }
        this.index[out] = meta;
        delete this.index[file];
      }
      this._tellMatches('setClipFile', file, out);
      await this._process(out).catch(() => {});
      this._changed();
      await this._saveIndex();
      return out;
    })().finally(() => this.materializing.delete(file));
    this.materializing.set(file, job);
    return job;
  }

  async trim(file, start, end, encoder) {
    file = this.assertInside(file);
    start = Math.max(0, Number(start) || 0);
    end = Number(end);
    if (!(end > start + 0.2)) throw new Error('The selection is too short');
    const dir = path.dirname(file);
    const base = `${path.basename(file, path.extname(file))} (trim)`;
    let out = path.join(dir, `${base}.mp4`);
    for (let n = 2; fs.existsSync(out); n++) out = path.join(dir, `${base} ${n}.mp4`);
    const tmp = `${out}.part`;
    const meta0 = this.index[file] || {};
    const codec = meta0.codec === 'hevc' ? 'hevc' : 'h264'; // keep an H.265 source in H.265
    // A virtual clip is trimmed straight from its range of the full recording.
    const v = meta0.virtual;
    const src = v ? v.file : file;
    const shift = v ? v.from : 0;
    if (v) end = Math.min(end, v.to - v.from);
    const r = await run(paths.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', (start + shift).toFixed(3), '-to', (end + shift).toFixed(3), '-i', src,
      '-map', '0:v:0', '-map', '0:a?', // every audio track, with its name
      ...videoEncoderArgs(encoder, 'ultra', undefined, { codec }), ...(codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4', tmp,
    ], { timeout: 30 * 60 * 1000 });
    if (r.code !== 0) {
      fs.rm(tmp, { force: true }, () => {});
      throw new Error(r.stderr.trim().split(/\r?\n/).pop() || 'FFmpeg failed');
    }
    await fsp.rename(tmp, out);
    const meta = this.index[file] || {};
    const markers = (meta.markers || [])
      .map((m) => ({ ...m, t: m.t - start }))
      .filter((m) => m.t >= 0 && m.t <= end - start);
    await this.add(out, {
      type: meta.type || 'clip', event: meta.event, game: meta.game, label: meta.label, champion: meta.champion, markers,
      ...(meta.map ? { map: { file: meta.map.file, offset: Math.round(((meta.map.offset || 0) + start) * 10) / 10 } } : {}),
      ...(meta.stats ? { stats: meta.stats } : {}),
    });
    const inputs = await this.loadInputs(file);
    if (inputs.length) {
      const from = start * 1000;
      const to = end * 1000;
      await this.saveInputs(out, inputs.filter(([t]) => t >= from && t <= to).map(([t, k, d]) => [t - from, k, d]));
    }
    return this._itemFor(out);
  }

  // Key / mouse presses recorded during a video: [[msFromVideoStart, name, down], ...]
  async saveInputs(file, events) {
    file = path.resolve(file);
    await fsp.mkdir(this.inputDir, { recursive: true });
    await fsp.writeFile(this._inputsPath(file), JSON.stringify({ v: 1, events }));
    if (this.index[file]) this.index[file].inputs = events.length;
    this._changed();
  }

  // Shift a match's minimap sync by `delta` seconds: every clip's offset into the minimap
  // recording, and the moment markers on the minimap itself.
  shiftMapSync(mapFile, delta) {
    for (const [file, meta] of Object.entries(this.index)) {
      if (meta.map && meta.map.file === mapFile) meta.map.offset = Math.round((meta.map.offset + delta) * 10) / 10;
      if (file === mapFile && meta.markers) meta.markers = meta.markers.map((m) => ({ ...m, t: Math.round((m.t + delta) * 10) / 10 }));
    }
    this._changed();
  }

  // Videos linked to a minimap recording, longest first (a full recording, if any, comes first).
  linkedToMap(mapFile) {
    return Object.entries(this.index)
      .filter(([, meta]) => meta.map && meta.map.file === mapFile)
      .map(([file, meta]) => ({ file, meta }))
      .sort((a, b) => (b.meta.duration || 0) - (a.meta.duration || 0));
  }

  async loadInputs(file) {
    try {
      return JSON.parse(await fsp.readFile(this._inputsPath(path.resolve(file)), 'utf8')).events || [];
    } catch {
      return [];
    }
  }

  setFavorite(file, on) {
    file = this.assertInside(file);
    if (!this.index[file]) return;
    // Favourites always have their own file (materialize() first).
    if (on && this.index[file].virtual) throw new Error('Make this clip a file before marking it a favourite');
    if (on) this.index[file].favorite = true;
    else delete this.index[file].favorite;
    this._changed();
  }

  // Bytes used by the library; favourites are listed separately because the storage limit
  // never deletes them (and doesn't count them, like Insights Capture's quota).
  usage() {
    let total = 0;
    let favorites = 0;
    let count = 0;
    for (const meta of Object.values(this.index)) {
      total += meta.size || 0;
      count++;
      if (meta.favorite) favorites += meta.size || 0;
    }
    return { total, favorites, count };
  }

  // Move videos to the Recycle Bin until the rest fits in limitBytes, match by match:
  // 1. the full recordings of old League matches (they're most of the space), never the latest
  //    match, so the game you just played can always be reviewed;
  // 2. then the oldest videos and matches: a match's highlights and highlight videos first, its
  //    minimap last.
  // Favourites are never removed and don't count; `keep` (the running match) is never touched.
  async enforceLimit(limitBytes, { keep = [] } = {}) {
    const protectedFiles = new Set(keep.map((f) => path.resolve(f)));
    const removable = ([file, meta]) => !meta.favorite && !protectedFiles.has(file);
    let used = Object.entries(this.index).filter(removable).reduce((sum, [, meta]) => sum + (meta.size || 0), 0);
    // A match is everything linked to the same minimap recording; any other video stands alone.
    const units = new Map();
    for (const entry of Object.entries(this.index)) {
      const [file, meta] = entry;
      const mapFile = meta.type === 'map' ? file : (meta.map && meta.map.file) || (meta.source && meta.source.map) || null;
      const key = meta.match || mapFile || file;
      if (!units.has(key)) units.set(key, { files: [], created: Infinity, isMatch: Boolean(meta.match || mapFile) });
      const unit = units.get(key);
      unit.files.push(entry);
      unit.created = Math.min(unit.created, meta.created || 0);
    }
    const oldestFirst = [...units.values()].sort((a, b) => a.created - b.created);
    const matches = oldestFirst.filter((u) => u.isMatch);
    const latest = matches[matches.length - 1];
    const removed = [];
    const drop = async ([file, meta]) => {
      if (used <= limitBytes || !removable([file, meta]) || !this.index[file]) return;
      try {
        await this.remove(file);
        used -= meta.size || 0;
        removed.push({ file, size: meta.size || 0 });
      } catch { /* in use or already gone; try the next one */ }
    };
    for (const unit of matches) {
      if (unit === latest) continue;
      for (const entry of unit.files) if (entry[1].type === 'recording') await drop(entry);
    }
    for (const unit of oldestFirst) {
      const order = [...unit.files].sort((a, b) => (a[1].type === 'map') - (b[1].type === 'map') || (a[1].created || 0) - (b[1].created || 0));
      for (const entry of order) await drop(entry);
      if (used <= limitBytes) break;
    }
    return { removed, freed: removed.reduce((s, r) => s + r.size, 0) };
  }

  copyToClipboard(file) {
    file = this.assertInside(file);
    // Puts the file itself on the clipboard so it can be pasted into Discord, chats or Explorer.
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Set-Clipboard -LiteralPath '${file.replace(/'/g, "''")}'`], { timeout: 15000 })
      .then((r) => { if (r.code !== 0) throw new Error(r.stderr.trim() || 'Could not copy'); });
  }

  thumbnailFor(file) {
    const t = this._thumbPath(file);
    return fs.existsSync(t) ? t : null;
  }

  // A row of stills across the whole video for the player's trim lane: STRIP_FRAMES frames side
  // by side in one JPEG, made once and kept with the thumbnails (remade when the video is newer).
  // A virtual clip's frames come from its range of the full recording. Null when it can't be made.
  filmstrip(file) {
    file = path.resolve(file);
    const meta = this.index[file];
    if (!meta) return Promise.resolve(null);
    const v = meta.virtual;
    const src = v ? v.file : file;
    const from = v ? v.from : 0;
    const dur = v ? v.to - v.from : meta.duration;
    if (!(dur > 0)) return Promise.resolve(null);
    const out = path.join(this.thumbDir, `${this._hash(file)}-strip.jpg`);
    try {
      if (fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return Promise.resolve(out);
    } catch { /* not made yet, or the video is gone (then ffmpeg fails below) */ }
    this.strips = this.strips || new Map();
    if (this.strips.has(out)) return this.strips.get(out);
    const n = STRIP_FRAMES;
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    // A still asked for past the last frame never arrives (and nothing is written), so the last
    // ones stay a little before the end.
    for (let i = 0; i < n; i++) args.push('-ss', (from + Math.min((dur * (i + 0.5)) / n, dur - Math.min(0.5, dur / 4))).toFixed(3), '-i', src);
    const scale = Array.from({ length: n }, (_, i) => `[${i}:v]scale=160:90:force_original_aspect_ratio=increase,crop=160:90,setsar=1[f${i}]`);
    args.push('-filter_complex', `${scale.join(';')};${Array.from({ length: n }, (_, i) => `[f${i}]`).join('')}hstack=inputs=${n},format=yuvj420p`,
      '-frames:v', '1', '-q:v', '5', out);
    const job = (async () => {
      fs.mkdirSync(this.thumbDir, { recursive: true });
      const r = await run(paths.ffmpeg, args, { timeout: 30000 });
      return r.code === 0 && fs.existsSync(out) ? out : null;
    })().finally(() => this.strips.delete(out));
    this.strips.set(out, job);
    return job;
  }

  // ------------------------------------------------------------------ internals

  async _walk(dir, depth, unreadable = []) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { unreadable.push(dir); return []; }
    const out = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 1) out.push(...await this._walk(full, depth - 1, unreadable));
      } else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
        out.push(full);
      }
    }
    return out;
  }

  _hash(file) {
    return crypto.createHash('sha1').update(file.toLowerCase()).digest('hex');
  }

  _thumbPath(file) {
    return path.join(this.thumbDir, `${this._hash(file)}.jpg`);
  }

  _inputsPath(file) {
    return path.join(this.inputDir, `${this._hash(file)}.json`);
  }

  _needsWork(file, meta) {
    if (!meta.probed || meta.probeVersion !== PROBE_VERSION) return true;
    if (meta.thumbFor === meta.mtime) return !meta.thumbFailed && !fs.existsSync(this._thumbPath(file));
    return true;
  }

  _item(file, meta, root) {
    const thumb = this._thumbPath(file);
    const hasThumb = meta.thumbFor === meta.mtime && !meta.thumbFailed && fs.existsSync(thumb);
    const parent = path.dirname(file);
    return {
      path: file,
      name: path.basename(file, path.extname(file)),
      game: meta.game || (parent !== root ? path.basename(parent) : 'Other'),
      type: meta.type || 'clip',
      event: meta.event || null, // what a highlight is about: teamfight, bookmark, multikill...
      label: meta.label || null,
      champion: meta.champion || null,
      championIcon: this._iconUrl(meta.champion || (meta.stats && meta.stats.champion)),
      stats: meta.stats || null, // post-game summary of League matches
      favorite: Boolean(meta.favorite),
      markers: meta.markers || [],
      inputs: meta.inputs || 0,
      audioTracks: meta.audioTracks || [],
      fps: meta.fps || 0,
      codec: meta.codec || null,
      // the match's minimap recording, and where this video starts inside it
      map: meta.map && meta.map.file && fs.existsSync(meta.map.file)
        ? { path: meta.map.file, url: pathToFileURL(meta.map.file).href, offset: meta.map.offset || 0 } : null,
      // highlight videos made from a match point at its minimap (not `map`, which would make the
      // match reel play them as one of its clips)
      source: meta.source && meta.source.map ? { map: meta.source.map } : null,
      match: meta.match || null, // the match record's key, once matches are recorded
      created: meta.created,
      size: meta.size,
      duration: meta.duration || 0,
      width: meta.width || 0,
      height: meta.height || 0,
      // (a virtual clip names its range too, so two clips of one recording never look like one source)
      url: meta.virtual ? `${pathToFileURL(meta.virtual.file).href}#t=${meta.virtual.from},${meta.virtual.to}` : pathToFileURL(file).href,
      // a virtual clip: seconds from..to of this full recording, which `url` plays
      virtual: meta.virtual ? { path: meta.virtual.file, from: meta.virtual.from, to: meta.virtual.to, bytes: meta.virtual.bytes || 0 } : null,
      thumb: hasThumb ? `${pathToFileURL(thumb).href}?v=${Math.round(meta.mtime)}` : null,
    };
  }

  _itemFor(file) {
    return this._item(file, this.index[file] || {}, path.resolve(this.getSaveDir()));
  }

  meta(file) {
    return this.index[path.resolve(file)] || null;
  }

  itemFor(file) {
    return this._itemFor(path.resolve(file));
  }

  _iconUrl(champion) {
    if (!champion) return null;
    const icon = this.iconFor(champion);
    return icon && fs.existsSync(icon) ? pathToFileURL(icon).href : null;
  }

  // Distinct champions in the library (so their icons can be fetched once).
  champions() {
    const names = new Set();
    for (const meta of Object.values(this.index)) {
      const c = meta.champion || (meta.stats && meta.stats.champion);
      if (c) names.add(c);
    }
    return [...names];
  }

  _enqueue(file) {
    if (this.queued.has(file)) return;
    this.queued.add(file);
    this.queue.push(file);
    this._drain();
  }

  _drain() {
    while (this.working < 2 && this.queue.length) {
      const file = this.queue.shift();
      this.working++;
      this._process(file)
        .catch(() => {})
        .finally(() => {
          this.working--;
          this.queued.delete(file);
          this._changed();
          this._drain();
        });
    }
  }

  async _process(file) {
    const meta = this.index[file];
    if (!meta) return;
    const v = meta.virtual;
    if (v && (!meta.probed || meta.probeVersion !== PROBE_VERSION)) {
      // Nothing to probe: the clip's details were read while it was a file.
      meta.duration = meta.duration || v.to - v.from;
      meta.probed = true;
      meta.probeVersion = PROBE_VERSION;
    }
    if (!meta.probed || meta.probeVersion !== PROBE_VERSION) {
      const r = await run(paths.ffprobe, ['-v', 'error', '-show_entries',
        'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate:stream_tags=title,handler_name',
        '-of', 'json', file], { timeout: 30000 });
      try {
        const info = JSON.parse(r.stdout);
        meta.duration = parseFloat(info.format.duration) || 0;
        const streams = info.streams || [];
        const v = streams.find((s) => s.codec_type === 'video');
        if (v) {
          meta.width = v.width;
          meta.height = v.height;
          meta.codec = v.codec_name;
          const [num, den] = String(v.avg_frame_rate || '0/1').split('/').map(Number);
          meta.fps = den ? Math.round((num / den) * 100) / 100 : 0;
        }
        // Audio track names (for the player's track switcher); generic names for untitled tracks.
        const audio = streams.filter((s) => s.codec_type === 'audio');
        const generic = /^(SoundHandler|ISO Media file produced.*|)$/i;
        meta.audioTracks = audio.map((s, i) => {
          const tags = s.tags || {};
          const name = [tags.title, tags.handler_name].find((n) => n && !generic.test(n));
          return name || (audio.length > 1 ? `Track ${i + 1}` : 'Audio');
        });
      } catch { /* unreadable file - keep defaults */ }
      meta.probed = true;
      meta.probeVersion = PROBE_VERSION;
    }
    const thumb = this._thumbPath(file);
    if (meta.thumbFor !== meta.mtime || (!meta.thumbFailed && !fs.existsSync(thumb))) {
      fs.mkdirSync(this.thumbDir, { recursive: true });
      // Highlights: show the key moment itself. Otherwise the middle (or 30 s into long videos).
      const marker = (meta.markers || [])[0];
      const at = marker ? Math.min(marker.t + 0.5, meta.duration || marker.t) : meta.duration > 60 ? 30 : (meta.duration || 0) / 2;
      // A virtual clip's picture comes from its moment in the full recording.
      const r = await run(paths.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (at + (v ? v.from : 0)).toFixed(2), '-i', v ? v.file : file,
        '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', thumb], { timeout: 30000 });
      meta.thumbFor = meta.mtime;
      meta.thumbFailed = r.code !== 0;
    }
    this._saveIndexSoon();
  }

  _changed() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.emit('changed'), 150);
    this._saveIndexSoon();
  }

  _saveIndexSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this._saveIndex(), 500);
  }

  // One write at a time, each one atomic, so a crash mid-save keeps the previous index intact.
  _saveIndex() {
    const data = JSON.stringify(this.index);
    this.saving = this.saving
      .then(async () => {
        await fsp.mkdir(path.dirname(this.indexFile), { recursive: true });
        await writeAtomic(this.indexFile, data);
      })
      .catch(() => { /* the next change saves again */ });
    return this.saving;
  }
}

module.exports = { Library };
