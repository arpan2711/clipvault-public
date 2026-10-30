// Virtual clips (P1 Phase 5, A4 §6.3 stage 2): when a League match has a full recording, its
// highlights are the same footage stored twice. Once the full recording is verified, a highlight's
// own file can go to the Recycle Bin and the clip plays as a range of the full recording instead.
//
// Safety rules, all enforced here (risk R2):
//   - only after verifying: the full recording reads cleanly, its length matches what the recorder
//     wrote, it's the same file the library indexed, and every video packet of the highlight is
//     found byte for byte, in order, inside it (edit.locateClip), within its length
//   - favourites never; never while a League game runs; files go to the Recycle Bin only
//   - after a match only when the user turned "Keep separate highlight files" off; existing matches
//     only through "Free up space", after a preview and an explicit confirm
//   - before a full recording is deleted (by the user or the storage limit), favourites and the
//     best clips (score >= KEEP_SCORE) become files again first; if that fails nothing is deleted
//   - anything that needs a real file (copy, drag, share, show in folder, favourite) gets one back
//     on demand: materialize(), a lossless stream copy of the range (edit.exportRange)
const fs = require('fs');
const path = require('path');

const KEEP_SCORE = 60; // multikills, steals, aces, victory (A4 §6.3)
const DURATION_SLACK = 2; // seconds (or 1 %) between the recorder's length and the file's
const lower = (f) => path.resolve(f).toLowerCase();

class VirtualClips {
  // library: Library. store: MatchStore or null. edit: { exportRange, locateClip, probe }.
  // gameRunning(): true while a League game runs. keepFiles(): the setting (true = keep files).
  constructor({ library, store = null, edit, gameRunning = () => false, keepFiles = () => true, log = () => {} }) {
    this.library = library;
    this.store = store;
    this.edit = edit;
    this.gameRunning = gameRunning;
    this.keepFiles = keepFiles;
    this.log = log;
    this.busy = null;
    this.lastPreview = null;
    library.onRemoveFull = (file, dependents) => this.keepBeforeRemoving(file, dependents);
  }

  // ------------------------------------------------------------ planning (read-only)

  // League matches in the library: { key, fulls: [[file, meta]], clips: [[file, meta]] } with the
  // full recordings and the highlights that are still files.
  _units(onlyKey = null) {
    const units = new Map();
    for (const [file, meta] of Object.entries(this.library.index)) {
      const mapFile = meta.type === 'map' ? file : (meta.map && meta.map.file) || null;
      const key = meta.match || (mapFile ? `map:${mapFile}` : null);
      if (!key || (onlyKey && key !== onlyKey)) continue;
      if (!units.has(key)) units.set(key, { key, fulls: [], clips: [], map: null });
      const u = units.get(key);
      if (meta.type === 'map') u.map = file;
      if (meta.virtual) continue;
      if (meta.type === 'recording') u.fulls.push([file, meta]);
      else if (meta.type === 'highlight') u.clips.push([file, meta]);
    }
    return [...units.values()];
  }

  // The match key a library file belongs to (as _units() names it), or null.
  unitOf(file) {
    const meta = this.library.meta(file);
    if (!meta) return null;
    const mapFile = meta.type === 'map' ? path.resolve(file) : (meta.map && meta.map.file) || null;
    return meta.match || (mapFile ? `map:${mapFile}` : null);
  }

  // Checks a full recording before anything may depend on it. Resolves { ok, duration, reason }.
  async verifyFull(file, meta) {
    let st;
    try { st = fs.statSync(file); } catch { return { ok: false, reason: 'the full recording is missing' }; }
    if (meta.size && st.size !== meta.size) return { ok: false, reason: 'the full recording changed since it was saved' };
    let info;
    try { info = await this.edit.probe(file); } catch (err) { return { ok: false, reason: `the full recording can't be read (${err.message})` }; }
    const duration = Math.max(info.duration || 0, info.videoDuration || 0);
    if (!info.video || !(duration > 0)) return { ok: false, reason: 'the full recording has no readable video' };
    const near = (a, b) => Math.abs(a - b) <= Math.max(DURATION_SLACK, b * 0.01);
    if (Number.isFinite(meta.span) && meta.span > 0 && !near(duration, meta.span)) {
      return { ok: false, reason: `the full recording is ${Math.round(duration)} s long, but ${Math.round(meta.span)} s were recorded` };
    }
    if (meta.duration > 0 && Math.abs(duration - meta.duration) > 0.5) return { ok: false, reason: 'the full recording changed since it was indexed' };
    return { ok: true, duration };
  }

  // Roughly where a highlight starts inside a full recording (seconds), from the minimap offsets
  // both carry, else from the match record's game times; null when nothing says.
  async _hint(clipFile, clipMeta, fullFile, fullMeta) {
    const a = clipMeta.map;
    const b = fullMeta.map;
    if (a && b && a.file && b.file && lower(a.file) === lower(b.file) && Number.isFinite(a.offset) && Number.isFinite(b.offset)) {
      return a.offset - b.offset;
    }
    if (!this.store || !clipMeta.match) return null;
    try {
      const rec = await this.store.get(clipMeta.match);
      const clip = rec && rec.media.clips.find((c) => (c.file || c.was) && lower(c.file || c.was) === lower(clipFile));
      const full = rec && rec.media.full.find((f) => f.file && lower(f.file) === lower(fullFile));
      if (clip && full && Number.isFinite(clip.from) && Number.isFinite(full.gameStart)) return clip.from - full.gameStart;
    } catch { /* no hint */ }
    return null;
  }

  // What virtualizing would do, without changing anything: per match, the highlights that can go
  // (each with its verified range) and the ones that can't, with why. Never favourites.
  async plan({ key = null } = {}) {
    const out = [];
    for (const u of this._units(key)) {
      const candidates = u.clips.filter(([, meta]) => !meta.favorite);
      if (!candidates.length || !u.fulls.length) continue;
      const fulls = [];
      const problems = [];
      for (const [file, meta] of u.fulls) {
        const v = await this.verifyFull(file, meta);
        if (v.ok) fulls.push({ file, meta, duration: v.duration });
        else problems.push(v.reason);
      }
      const entry = { key: u.key, map: u.map, full: fulls.map((f) => f.file), clips: [], refused: [], problem: fulls.length ? null : problems[0] || 'no full recording' };
      if (fulls.length) {
        for (const [file, meta] of candidates) {
          if (!fs.existsSync(file)) { entry.refused.push({ file, reason: 'missing' }); continue; }
          let found = null;
          for (const f of fulls) {
            const near = await this._hint(file, meta, f.file, f.meta);
            if (near == null) continue;
            let at = null;
            try { at = await this.edit.locateClip({ full: f.file, clip: file, near }); } catch { at = null; }
            if (at == null) continue;
            let length = meta.duration;
            if (!(length > 0)) {
              try { length = (await this.edit.probe(file)).duration; } catch { length = 0; }
            }
            if (at >= -0.05 && length > 0 && at + length <= f.duration + 0.1) {
              found = { file, full: f.file, from: Math.max(0, at), to: Math.min(f.duration, at + length), bytes: meta.size || 0 };
              break;
            }
          }
          if (found) entry.clips.push(found);
          else entry.refused.push({ file, reason: 'not found in the full recording' });
        }
      }
      out.push(entry);
    }
    return out;
  }

  // ------------------------------------------------------------ changing things

  // Virtualizes the planned clips (plan() output, or a subset). Stops at once if a game starts.
  // Resolves { clips, bytes, stopped }.
  async _apply(plans, { only = null } = {}) {
    const allowed = only ? new Set(only.map(lower)) : null;
    let clips = 0;
    let bytes = 0;
    for (const p of plans) {
      for (const c of p.clips) {
        if (allowed && !allowed.has(lower(c.file))) continue;
        if (this.gameRunning()) return { clips, bytes, stopped: 'a game started' };
        const meta = this.library.meta(c.file);
        if (!meta || meta.favorite || meta.virtual || meta.size !== c.bytes) continue; // changed since it was checked
        try {
          if (await this.library.virtualize(c.file, { full: c.full, from: c.from, to: c.to })) {
            clips++;
            bytes += c.bytes;
          }
        } catch (err) {
          this.log(`virtual clips: kept ${path.basename(c.file)}: ${err.message}`);
        }
      }
    }
    return { clips, bytes, stopped: null };
  }

  _exclusive(fn) {
    if (this.busy) return Promise.reject(new Error('Already freeing up space'));
    this.busy = Promise.resolve().then(fn).finally(() => { this.busy = null; });
    return this.busy;
  }

  // After a match: virtualizes its highlights when the user chose not to keep separate files.
  // Resolves { clips, bytes } or null when it did nothing (setting on, a game running, nothing
  // verified).
  afterMatch(key) {
    if (!key || this.keepFiles()) return Promise.resolve(null);
    if (this.gameRunning()) return Promise.resolve(null);
    return this._exclusive(async () => {
      const plans = await this.plan({ key });
      for (const p of plans) {
        if (p.problem) this.log(`virtual clips: ${p.key}: kept every highlight: ${p.problem}`);
        for (const r of p.refused) this.log(`virtual clips: kept ${path.basename(r.file)}: ${r.reason}`);
      }
      if (this.gameRunning()) return null;
      const res = await this._apply(plans);
      if (res.clips) this.log(`virtual clips: ${key}: ${res.clips} highlight file(s) to the Recycle Bin, ${res.bytes} bytes`);
      return res;
    });
  }

  // "Free up space": what virtualizing every match would remove. Read-only. Resolves
  // { matches: [{ key, map, clips, bytes, refused, problem }], clips, bytes, token }.
  async preview() {
    const plans = await this.plan();
    const matches = plans.map((p) => ({
      key: p.key, map: p.map, full: p.full, clips: p.clips.length, bytes: p.clips.reduce((n, c) => n + c.bytes, 0),
      files: p.clips.map((c) => c.file), refused: p.refused.length, problem: p.problem,
    }));
    const token = `p${Date.now()}`;
    this.lastPreview = { token, files: plans.flatMap((p) => p.clips.map((c) => c.file)) };
    return {
      token, matches,
      clips: matches.reduce((n, m) => n + m.clips, 0), bytes: matches.reduce((n, m) => n + m.bytes, 0),
    };
  }

  // Runs what preview() showed (token): checks everything again and virtualizes only clips that
  // were in that preview and still verify. Never during a game.
  freeUpSpace(token) {
    if (!this.lastPreview || this.lastPreview.token !== token) return Promise.reject(new Error('Look at the preview again first'));
    if (this.gameRunning()) return Promise.reject(new Error('Not while a game is running'));
    const files = this.lastPreview.files;
    this.lastPreview = null;
    return this._exclusive(async () => this._apply(await this.plan(), { only: files }));
  }

  // A real file for this library entry: itself, or a virtual clip exported back to a file.
  materialize(file) {
    return this.library.materialize(file, this.edit.exportRange);
  }

  // The match record's score for a clip (0 when unknown).
  async _score(file, meta) {
    if (!this.store || !meta.match) return 0;
    try {
      const rec = await this.store.get(meta.match);
      const clip = rec && rec.media.clips.find((c) => (c.file || c.was) && lower(c.file || c.was) === lower(file));
      return clip && Number(clip.score) > 0 ? Number(clip.score) : 0;
    } catch {
      return 0;
    }
  }

  // Before a full recording goes: favourites and the best clips become files again. Throws (and
  // so stops the deletion) if one can't be.
  async keepBeforeRemoving(fullFile, dependents) {
    for (const { file, meta } of dependents) {
      if (meta.favorite || (await this._score(file, meta)) >= KEEP_SCORE) {
        try {
          await this.materialize(file);
        } catch (err) {
          throw new Error(`Couldn't keep "${path.basename(file)}" before deleting the full recording: ${err.message}`);
        }
      }
    }
  }
}

module.exports = { VirtualClips, KEEP_SCORE };
