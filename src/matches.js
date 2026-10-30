// The League match store (P1 §2.4): one record per match plus a small index that the match list
// reads, all in the profile:
//   matches\index.json                MatchRow[], newest first (rebuilt from the records when it's
//                                     missing or unreadable)
//   matches\<key>.json                the match record, schema v1 (league-match.js); the key is
//                                     "EUW1_<gameId>", or "local-<ms>" until the game ID is known
//   matches\raw\<key>\<name>.json.gz  the League client's own documents, gzipped, secrets stripped
// Writes are atomic (temp file + rename) and run one at a time through a single queue, so a match
// is never written by two operations at once. Former keys keep resolving after a rekey. Nothing
// here ever touches a video file; deleting videos only unlinks them from their match.
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { writeAtomic } = require('./fsutil');
const lm = require('./games/league-match');

const fsp = fs.promises;
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const KEY = /^(local-\d{1,16}|[A-Z][A-Z0-9]{1,9}_\d{1,20})$/; // keys end up in file names
const RAW_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MEDIA_KINDS = new Set(['full', 'map', 'clip']);
// Never kept from the client's documents: game-server addresses, the spectator key, game and chat
// passwords, chat tokens (A4 §3.2, §5.2). JWT-shaped strings go too, whatever their key.
const SECRET_KEY = /password|jwt|token|secret|authorization|spectatorkey|serverip|serverport|^multiuserchat/i;
const JWT = /^eyJ[\w-]*\.[\w-]*\.[\w-]*$/;

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const lower = (file) => path.resolve(file).toLowerCase(); // Windows paths ignore case
const exists = (file) => fsp.access(file).then(() => true, () => false);

// A copy of a client document without its secrets, at any depth.
function stripSecrets(value) {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' && JWT.test(v) ? null : stripSecrets(v)));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) || (typeof v === 'string' && JWT.test(v))) continue;
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

// The path a media entry answers to: its file, or for a virtual clip (file null, a range of the
// full recording) the path its file had, which the library still knows it by.
const pathOf = (x) => (x && typeof x.file === 'string' && x.file ? x.file : x && typeof x.was === 'string' && x.was ? x.was : null);

function mediaFiles(record) {
  const m = record.media || {};
  return [...(m.full || []), m.map, ...(m.maps || []), ...(m.clips || [])].map(pathOf).filter(Boolean);
}

// Windows can briefly refuse a rename while another program (a virus scan) has the file open.
async function retryBusy(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * i));
    }
  }
}

// fn over items, a few at a time (a rebuild may read thousands of records).
async function inBatches(items, fn, size = 8) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

const taken = (key) => Object.assign(new Error(`match ${key} already exists`), { code: 'EEXIST' });
// The next free clip id: c1, c2, ...
const nextClipId = (clips) => `c${1 + Math.max(0, ...clips.map((c) => Number((/^c(\d+)$/.exec(c.id || '') || [])[1]) || 0))}`;

class MatchStore extends EventEmitter {
  // log(message): notes about the files (an index rebuilt, an unreadable record kept aside).
  constructor(profileDir, { log = () => {}, now = Date.now } = {}) {
    super();
    this.dir = path.join(profileDir, 'matches');
    this.indexFile = path.join(this.dir, 'index.json');
    this.rawDir = path.join(this.dir, 'raw');
    this.log = log;
    this.now = now;
    this.rows = new Map(); // key -> MatchRow
    this.aliases = new Map(); // former key -> current key
    this.files = new Map(); // lower-case media path -> key
    this.filesOf = new Map(); // key -> Set of lower-case media paths
    this.ready = this._open().catch((err) => this.log(`match store: ${err.message}`));
    this.queue = this.ready;
  }

  // ------------------------------------------------------------ public API (all async, in order)

  // Adds a match. `record` is a partial or full v1 record; its key defaults to keyOf(record).
  // Rejects with code EEXIST when the key (or a former key) is taken.
  create(record) {
    return this._run(async () => {
      const rec = lm.blankRecord(record);
      rec.key = rec.key || lm.keyOf(rec);
      if (!KEY.test(rec.key || '')) throw new Error(`not a match key: ${rec.key}`);
      if (this.rows.has(rec.key) || this.aliases.has(rec.key)) throw taken(rec.key);
      rec.aliases = [];
      rec.createdAt = rec.createdAt || this.now();
      rec.updatedAt = this.now();
      const saved = await this._write(rec);
      await this._saveIndex();
      this._changed([rec.key]);
      return clone(saved);
    });
  }

  // Changes a match: `patch` is an object (its fields replace the record's) or a synchronous
  // function that edits the record it's given (or returns a new one). Resolves the new record, or
  // null when there's no such match. The key changes only through rekey().
  update(key, patch) {
    return this._run(async () => {
      const k = this._resolve(key);
      const cur = this.rows.has(k) ? await this._readRecord(k) : null;
      if (!cur) return null;
      let next;
      if (typeof patch === 'function') {
        const draft = clone(cur);
        const out = patch(draft);
        if (out && typeof out.then === 'function') throw new TypeError('update() needs a synchronous function');
        next = lm.normalize(out || draft);
      } else {
        next = lm.normalize({ ...cur, ...clone(patch || {}) });
      }
      if (next.key !== k) throw new Error('a match key changes only through rekey()');
      Object.assign(next, { v: cur.v, aliases: cur.aliases, createdAt: cur.createdAt, updatedAt: this.now() });
      const saved = await this._write(next);
      await this._saveIndex();
      this._changed([k]);
      return clone(saved);
    });
  }

  // Renames a match, e.g. "local-<ms>" -> "EUW1_<gameId>" once the game ID is known. newKey
  // defaults to keyOf(record). The old key keeps resolving (get, update...) and is listed in the
  // record's `aliases`; 'rekeyed' { from, to } lets the library update its links.
  rekey(oldKey, newKey) {
    return this._run(async () => {
      const from = this._resolve(oldKey);
      const cur = this.rows.has(from) ? await this._readRecord(from) : null;
      if (!cur) return null;
      const to = newKey || lm.keyOf(cur);
      if (!KEY.test(to || '')) throw new Error(`not a match key: ${to}`);
      if (to === from) return clone(cur);
      if (this.rows.has(to) || this.aliases.has(to)) {
        // Taken by a record of the same game (the app restarted mid-match, or the minimap's
        // backfill got there first): one match, one record, so the two become one.
        const there = this._resolve(to);
        const other = there !== from && this.rows.has(there) ? await this._readRecord(there) : null;
        if (!other || !cur.gameId || Number(other.gameId) !== Number(cur.gameId)) throw taken(to);
        this.log(`${from} is the same game as ${there}: merged them`);
        return this._mergeKeys(from, there);
      }
      const next = lm.normalize({ ...cur, key: to, aliases: [...new Set([...cur.aliases, from])], updatedAt: this.now() });
      // The new record first: a crash from here on leaves an old copy that the next start removes.
      // Its videos are re-pointed first, so writing it doesn't count as taking them off another match.
      const moved = [...(this.filesOf.get(from) || [])];
      for (const f of moved) this.files.set(f, to);
      let saved;
      try {
        saved = await this._write(next);
      } catch (err) {
        for (const f of moved) this.files.set(f, from);
        throw err;
      }
      for (const a of next.aliases) this.aliases.set(a, to);
      this.rows.delete(from);
      this.filesOf.delete(from);
      await this._moveRaw(from, to);
      await retryBusy(() => fsp.rm(this._file(from), { force: true }));
      await this._saveIndex();
      this.emit('rekeyed', { from, to });
      this._changed([from, to]);
      return clone(saved);
    });
  }

  // Makes two records of one match one (league-match.js mergeRecords): `fromKey`'s goes into
  // `toKey`'s, which keeps its key; fromKey becomes one of its former keys and 'rekeyed'
  // { from, to } re-points the library's links. Resolves the merged record, or null when either
  // is gone. Rejects when their game IDs differ. The caller decides they are the same match.
  merge(fromKey, toKey) {
    return this._run(async () => this._mergeKeys(this._resolve(fromKey), this._resolve(toKey)));
  }

  // Folds a record that isn't stored (e.g. a backfill of the same match) into a stored one, as
  // merge() does. Resolves the merged record, or null when there's no such match.
  absorb(key, record) {
    return this._run(async () => {
      const k = this._resolve(key);
      const cur = this.rows.has(k) ? await this._readRecord(k) : null;
      if (!cur) return null;
      const extra = lm.normalize(clone(record));
      extra.key = null; // not a key of this match
      const next = lm.mergeRecords(cur, extra);
      Object.assign(next, { key: k, v: cur.v, aliases: cur.aliases, createdAt: cur.createdAt, updatedAt: this.now() });
      const saved = await this._write(next);
      await this._saveIndex();
      this._changed([k]);
      return clone(saved);
    });
  }

  // The keys of the stored records that are the same match as `record` (league-match.js
  // sameGame(), by game ID or by champion, name and start time), records with a real key first,
  // then the oldest. `record` itself (its key) is left out.
  findSame(record, { windowMs } = {}) {
    return this._run(async () => {
      const probe = lm.normalize(clone(record));
      const start = lm.startOf(probe);
      const near = (row) => start !== null && Number.isFinite(row.startedAt) && Math.abs(row.startedAt - start) < 12 * 3600000;
      const found = [];
      for (const row of this._sortedRows()) {
        if (row.key === probe.key || probe.aliases.includes(row.key)) continue;
        if (probe.gameId && row.gameId ? Number(probe.gameId) !== Number(row.gameId) : !near(row)) continue;
        const rec = await this._readRecord(row.key);
        if (rec && lm.sameGame(probe, rec, { windowMs })) found.push(rec);
      }
      const local = (k) => (String(k).startsWith('local-') ? 1 : 0);
      found.sort((a, b) => local(a.key) - local(b.key) || (a.createdAt || 0) - (b.createdAt || 0));
      return found.map((r) => r.key);
    });
  }

  // The full record, or null.
  get(key) {
    return this._run(async () => {
      const k = this._resolve(key);
      return this.rows.has(k) ? this._readRecord(k) : null;
    });
  }

  // Every match's row, newest first.
  list() {
    return this._run(async () => this._sortedRows().map(clone));
  }

  // The key of the match a video file belongs to, or null.
  byFile(file) {
    return this._run(async () => this.files.get(lower(file)) || null);
  }

  // Links a video to a match. kind: 'full' (a full recording; several allowed), 'map' (the minimap
  // recording) or 'clip' (a highlight: { id?, file | null for a range inside the full recording,
  // from, to, title, type, score, moments, favorite }, times in game seconds). Linking a file
  // again updates its entry; a file linked to another match moves here. Resolves the record.
  linkMedia(key, kind, entry) {
    if (!MEDIA_KINDS.has(kind)) return Promise.reject(new Error(`unknown media kind: ${kind}`));
    const e = clone(entry || {});
    if (kind !== 'clip' || e.file != null) {
      if (typeof e.file !== 'string' || !e.file) return Promise.reject(new Error('a video link needs a file'));
      e.file = path.resolve(e.file);
    }
    return this._run(async () => {
      const k = this._resolve(key);
      const cur = this.rows.has(k) ? await this._readRecord(k) : null;
      if (!cur) return null;
      const next = clone(cur);
      const same = (x) => Boolean(pathOf(x) && e.file && lower(pathOf(x)) === lower(e.file));
      if (kind === 'full') {
        const i = next.media.full.findIndex(same);
        if (i >= 0) next.media.full[i] = { ...next.media.full[i], ...e };
        else next.media.full.push(e);
      } else if (kind === 'map') {
        // Another minimap of the same match (its recording was split by a restart or a capture
        // recovery): the new one leads, the one before stays as a part.
        const parts = (next.media.maps || []).filter((x) => !same(x));
        const old = next.media.map;
        if (old && pathOf(old) && !same(old)) parts.push(old);
        next.media.maps = parts;
        next.media.map = old && same(old) ? { ...old, ...e } : e;
      } else {
        const clips = next.media.clips;
        const i = clips.findIndex((x) => (e.id != null && x.id === e.id) || same(x));
        if (e.id == null) e.id = i >= 0 ? clips[i].id : nextClipId(clips);
        // Linking a virtual clip's old path again keeps it virtual: only setClipFile() changes that.
        if (i >= 0) clips[i] = clips[i].was && !clips[i].file ? { ...clips[i], ...e, file: null } : { ...clips[i], ...e };
        else clips.push(e);
        clips.sort((a, b) => (Number(a.from) || 0) - (Number(b.from) || 0)); // game-time order
      }
      next.updatedAt = this.now();
      const saved = await this._write(next);
      await this._saveIndex();
      this._changed([k]);
      return clone(saved);
    });
  }

  // A video was deleted (or is no longer ClipVault's): takes it off its match. The record stays,
  // with its stats. Resolves { key, removed } or null when the file belonged to no match.
  unlinkFile(file) {
    return this._run(async () => {
      const k = this.files.get(lower(file));
      if (!k) return null;
      const removed = await this._unlinkFrom(k, file);
      await this._saveIndex();
      this._changed([k]);
      return { key: k, removed };
    });
  }

  // A highlight became virtual (newFile null: its file went to the Recycle Bin and it plays as a
  // range of the full recording; its from/to stay) or a file again (newFile: the file it was
  // exported to). Resolves the key of its match, or null.
  setClipFile(file, newFile) {
    return this._run(async () => {
      const k = this.files.get(lower(file));
      const cur = k ? await this._readRecord(k) : null;
      if (!cur) return null;
      const next = clone(cur);
      const clip = next.media.clips.find((x) => pathOf(x) && lower(pathOf(x)) === lower(file));
      if (!clip) return null;
      if (newFile == null) {
        clip.was = pathOf(clip);
        clip.file = null;
      } else {
        clip.file = path.resolve(newFile);
        delete clip.was;
      }
      next.updatedAt = this.now();
      await this._write(next);
      await this._saveIndex();
      this._changed([k]);
      return k;
    });
  }

  // A video was renamed or moved. Resolves the key of its match, or null.
  renameFile(oldFile, newFile) {
    return this._run(async () => {
      const k = this.files.get(lower(oldFile));
      const cur = k ? await this._readRecord(k) : null;
      if (!cur) return null;
      const next = clone(cur);
      const to = path.resolve(newFile);
      const fix = (x) => {
        if (x && x.file && lower(x.file) === lower(oldFile)) x.file = to;
        else if (x && x.was && lower(x.was) === lower(oldFile)) x.was = to;
      };
      next.media.full.forEach(fix);
      fix(next.media.map);
      (next.media.maps || []).forEach(fix);
      next.media.clips.forEach(fix);
      next.updatedAt = this.now();
      await this._write(next);
      await this._saveIndex();
      this._changed([k]);
      return k;
    });
  }

  // Rows of matches still waiting for something (match history, the timeline, a game ID...),
  // newest first; with maxAgeMs, only matches that started within that time.
  pending({ maxAgeMs } = {}) {
    return this._run(async () => {
      const cutoff = maxAgeMs ? this.now() - maxAgeMs : -Infinity;
      return this._sortedRows().filter((r) => r.pending.length && (r.startedAt == null || r.startedAt >= cutoff)).map(clone);
    });
  }

  // Keeps one of the client's documents for a match (live-final, eog, game, timeline, lp,
  // ranked-before...), so new stats can be mapped later without fetching again. Secrets are
  // stripped first. Resolves the file written, or null when there's no such match.
  async saveRaw(key, name, doc) {
    if (!RAW_NAME.test(String(name))) throw new Error(`not a raw document name: ${name}`);
    const data = await gzip(Buffer.from(JSON.stringify(stripSecrets(doc)), 'utf8'));
    return this._run(async () => {
      const k = this._resolve(key);
      if (!this.rows.has(k)) return null;
      const dir = path.join(this.rawDir, k);
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${name}.json.gz`);
      await retryBusy(() => writeAtomic(file, data));
      return file;
    });
  }

  // A document kept by saveRaw(), or null.
  readRaw(key, name) {
    if (!RAW_NAME.test(String(name))) return Promise.reject(new Error(`not a raw document name: ${name}`));
    return this._run(async () => {
      const file = path.join(this.rawDir, this._resolve(key), `${name}.json.gz`);
      try {
        return JSON.parse((await gunzip(await fsp.readFile(file))).toString('utf8'));
      } catch {
        return null;
      }
    });
  }

  // Resolves once everything asked so far is written.
  flush() {
    return this._run(async () => {});
  }

  // ------------------------------------------------------------ internals

  _run(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  _resolve(key) {
    return this.aliases.get(key) || key;
  }

  _file(key) {
    return path.join(this.dir, `${key}.json`);
  }

  _changed(keys) {
    this.emit('changed', { keys });
  }

  _sortedRows() {
    return [...this.rows.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  }

  // The record of a key, or null. A file that can't be read is moved aside (never overwritten) and
  // its match leaves the index, so the list never shows a match that can't be opened.
  async _readRecord(key) {
    let text = null;
    try { text = await fsp.readFile(this._file(key), 'utf8'); } catch { /* gone */ }
    if (text !== null) {
      try {
        const rec = JSON.parse(text);
        if (rec && typeof rec === 'object' && rec.key === key) return lm.normalize(rec);
      } catch { /* kept aside below */ }
      const kept = `${this._file(key)}.corrupt-${this.now()}`;
      await fsp.rename(this._file(key), kept).catch(() => {});
      this.log(`${key}.json could not be read; kept it as ${path.basename(kept)}`);
    }
    if (this.rows.has(key)) {
      this.rows.delete(key);
      for (const f of this.filesOf.get(key) || []) if (this.files.get(f) === key) this.files.delete(f);
      this.filesOf.delete(key);
      await this._saveIndex();
      this._changed([key]);
    }
    return null;
  }

  // Writes a record (with its derived fields worked out again) and resolves what was written.
  async _write(record) {
    const rec = lm.derive(record);
    // A file belongs to one match: linking it here takes it off any other.
    for (const f of mediaFiles(rec)) {
      const owner = this.files.get(lower(f));
      if (owner && owner !== rec.key) {
        await this._unlinkFrom(owner, f);
        this._changed([owner]);
      }
    }
    await fsp.mkdir(this.dir, { recursive: true });
    await retryBusy(() => writeAtomic(this._file(rec.key), JSON.stringify(rec)));
    this.rows.set(rec.key, lm.rowOf(rec));
    this._indexFiles(rec);
    return rec;
  }

  // merge() inside the queue: `from` into `to` (both current keys).
  async _mergeKeys(from, to) {
    if (from === to) return this.rows.has(to) ? this._readRecord(to) : null;
    const into = this.rows.has(to) ? await this._readRecord(to) : null;
    const cur = this.rows.has(from) ? await this._readRecord(from) : null;
    if (!into || !cur) return into ? clone(into) : null;
    const next = lm.mergeRecords(into, cur);
    Object.assign(next, { key: to, v: into.v, updatedAt: this.now() });
    // As in rekey(): the merged record first (a crash leaves an old copy the next start removes),
    // with from's videos re-pointed so writing it doesn't count as taking them off another match.
    const moved = [...(this.filesOf.get(from) || [])];
    for (const f of moved) this.files.set(f, to);
    let saved;
    try {
      saved = await this._write(next);
    } catch (err) {
      for (const f of moved) this.files.set(f, from);
      throw err;
    }
    for (const a of next.aliases) this.aliases.set(a, to);
    this.rows.delete(from);
    this.filesOf.delete(from);
    await this._moveRaw(from, to);
    await retryBusy(() => fsp.rm(this._file(from), { force: true }));
    await this._saveIndex();
    this.emit('rekeyed', { from, to });
    this._changed([from, to]);
    return clone(saved);
  }

  async _unlinkFrom(key, file) {
    const cur = await this._readRecord(key);
    if (!cur) return 0;
    const f = lower(file);
    const same = (x) => Boolean(pathOf(x) && lower(pathOf(x)) === f);
    const next = clone(cur);
    const before = mediaFiles(next).length;
    next.media.full = next.media.full.filter((x) => !same(x));
    next.media.maps = (next.media.maps || []).filter((x) => !same(x));
    if (same(next.media.map)) next.media.map = next.media.maps.shift() || null;
    next.media.clips = next.media.clips.filter((x) => !same(x));
    const removed = before - mediaFiles(next).length;
    next.updatedAt = this.now();
    await this._write(next);
    return removed;
  }

  _indexFiles(rec) {
    for (const f of this.filesOf.get(rec.key) || []) if (this.files.get(f) === rec.key) this.files.delete(f);
    const own = new Set(mediaFiles(rec).map(lower));
    for (const f of own) this.files.set(f, rec.key);
    this.filesOf.set(rec.key, own);
  }

  async _saveIndex() {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await retryBusy(() => writeAtomic(this.indexFile, JSON.stringify(this._sortedRows())));
    } catch (err) {
      this.log(`match index not saved: ${err.message}`); // the records are what counts; the next start fixes it
    }
  }

  async _moveRaw(from, to) {
    const src = path.join(this.rawDir, from);
    let names;
    try { names = await fsp.readdir(src); } catch { return; }
    const dst = path.join(this.rawDir, to);
    await fsp.mkdir(dst, { recursive: true });
    for (const n of names) {
      if (await exists(path.join(dst, n))) await fsp.rm(path.join(src, n), { force: true });
      else await retryBusy(() => fsp.rename(path.join(src, n), path.join(dst, n)));
    }
    await fsp.rmdir(src).catch(() => {});
  }

  // Loads the index, or rebuilds it from the records when it's missing or unreadable, and
  // reconciles it with the record files (a crash between writing a record and the index).
  async _open() {
    let names;
    try { names = await fsp.readdir(this.dir); } catch { return; } // no matches yet
    const onDisk = new Set(names.filter((n) => n.endsWith('.json') && KEY.test(n.slice(0, -5))).map((n) => n.slice(0, -5)));
    let rows = null;
    try {
      const data = JSON.parse(await fsp.readFile(this.indexFile, 'utf8'));
      if (Array.isArray(data) && data.every((r) => r && typeof r.key === 'string' && KEY.test(r.key))) rows = data;
    } catch { /* rebuilt below */ }
    const records = new Map(); // read here anyway: reused for the media index
    const load = async (key) => {
      const rec = await this._readRecord(key);
      if (rec) records.set(key, rec);
      return rec ? lm.rowOf(rec) : null;
    };
    let dirty = false;
    if (!rows) {
      if (onDisk.size || names.includes('index.json')) this.log('match index missing or unreadable; rebuilt it from the match files');
      rows = (await inBatches([...onDisk], load)).filter(Boolean);
      dirty = true;
    } else {
      const indexed = new Set(rows.map((r) => r.key));
      const kept = rows.filter((r) => onDisk.has(r.key));
      const found = (await inBatches([...onDisk].filter((k) => !indexed.has(k)), load)).filter(Boolean);
      dirty = kept.length !== rows.length || found.length > 0;
      rows = [...kept, ...found];
    }
    for (const row of rows) this.rows.set(row.key, row);
    for (const row of rows) for (const a of row.aliases || []) this.aliases.set(a, row.key);
    // A rekey that stopped after writing the new record: the old file is a superseded copy.
    for (const old of [...this.rows.keys()].filter((k) => this.aliases.has(k))) {
      this.rows.delete(old);
      records.delete(old);
      await fsp.rm(this._file(old), { force: true }).catch(() => {});
      this.log(`removed ${old}.json, already renamed to ${this.aliases.get(old)}`);
      dirty = true;
    }
    for (const row of this.rows.values()) {
      if (!(row.hasFull || row.hasMap || row.clips)) continue;
      const rec = records.get(row.key) || await this._readRecord(row.key);
      if (rec) this._indexFiles(rec);
    }
    if (dirty) await this._saveIndex();
  }
}

module.exports = { MatchStore, stripSecrets, KEY };
