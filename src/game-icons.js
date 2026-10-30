// Item, summoner-spell and rune icons for match rows, the match header and the scoreboard, from
// CommunityDragon (Riot's client assets). The page's CSP only allows local images, so every icon is
// downloaded once into the profile and served as a file: URL, like champions.js does for faces.
//   <root>\items\3031.png, <root>\spells\4.png, <root>\runes\8010.png   one file per id, kept for good
//   <root>\items.json, spells.json, runes.json                          id -> icon path lists, refreshed weekly
// Until a list has been downloaded, the copy bundled in games/icon-paths.json stands in, so icons
// work from the first match. Downloads are lazy (only ids something asked for), one per icon however
// many callers ask at once, and after a network failure nothing is tried for a while.
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./fsutil');
const { fetchBuffer, isPng } = require('./net');

const fsp = fs.promises;
const CDRAGON = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/';
const ASSET_PREFIX = '/lol-game-data/assets/';
const WEEK = 7 * 24 * 60 * 60 * 1000;
const BACKOFF = 10 * 60 * 1000; // after a network failure, stay off the network for a while
const MAX_ID = 1e7;
// Paths end up in URLs: CommunityDragon's lowercase names, nothing that could climb out of its tree.
const REL = /^[a-z0-9_\-./]{1,200}\.png$/;

// kind -> where its icons live, the lists that name them, and the folder most of them share (so
// the bundled copy stays small).
const KINDS = {
  item: { dir: 'items', lists: ['v1/items.json'], base: 'assets/items/icons2d/' },
  spell: { dir: 'spells', lists: ['v1/summoner-spells.json'], base: 'data/spells/icons2d/' },
  rune: { dir: 'runes', lists: ['v1/perks.json', 'v1/perkstyles.json'], base: 'v1/perk-images/styles/' }, // keystones, trees, shards
};

const validId = (id) => Number.isInteger(id) && id > 0 && id < MAX_ID;
const exists = (file) => fsp.access(file).then(() => true, () => false);

// "/lol-game-data/assets/ASSETS/Items/Icons2D/1001_Boots.png" -> "assets/items/icons2d/1001_boots.png"
function relPath(iconPath) {
  if (typeof iconPath !== 'string' || !iconPath.toLowerCase().startsWith(ASSET_PREFIX)) return null;
  const rel = iconPath.slice(ASSET_PREFIX.length).toLowerCase();
  return REL.test(rel) && !rel.split('/').includes('..') && !rel.startsWith('/') ? rel : null;
}

// One kind's { base, ids: { id: path relative to base, or "/" + full path }, names } from
// CommunityDragon's lists (items.json, perks.json + perkstyles.json, summoner-spells.json).
function mapFromLists(kind, docs, { names = true } = {}) {
  const { base } = KINDS[kind];
  const out = { base, ids: {} };
  if (names) out.names = {};
  for (const doc of docs) {
    const list = Array.isArray(doc) ? doc : doc && Array.isArray(doc.styles) ? doc.styles : [];
    for (const e of list) {
      const rel = e && validId(e.id) ? relPath(e.iconPath) : null;
      if (!rel) continue;
      out.ids[e.id] = rel.startsWith(base) ? rel.slice(base.length) : `/${rel}`;
      if (names && typeof e.name === 'string' && e.name) out.names[e.id] = e.name.slice(0, 80);
    }
  }
  return out;
}

// The icon's path under CommunityDragon's root, or null when the list doesn't know the id.
function iconRel(map, id) {
  const v = map && map.ids && Object.hasOwn(map.ids, id) ? map.ids[id] : null;
  if (typeof v !== 'string' || !v) return null;
  const rel = v.startsWith('/') ? v.slice(1) : `${map.base || ''}${v}`;
  return REL.test(rel) && !rel.split('/').includes('..') ? rel : null;
}

const goodMap = (m) => Boolean(m && typeof m === 'object' && m.ids && typeof m.ids === 'object' && Object.keys(m.ids).length);

let bundledCache;
function loadBundled() {
  if (bundledCache === undefined) {
    try { bundledCache = require('./games/icon-paths.json'); } catch { bundledCache = null; }
  }
  return bundledCache;
}

class GameIcons {
  // root: the cache folder (<userData>\icons). fetch/bundled/now are for tests.
  constructor(root, { fetch = fetchBuffer, bundled = loadBundled(), now = Date.now } = {}) {
    this.root = path.resolve(root);
    this.fetch = fetch;
    this.bundled = bundled || {};
    this.now = now;
    this.failedAt = -Infinity; // the last network failure, for every kind
    this.kinds = new Map(); // kind -> { map, refreshing, missing: Set of ids without an icon }
    this.files = new Map(); // "kind:id" -> local file once known
    this.inflight = new Map(); // "kind:id" -> download promise
  }

  _mayUseNetwork() { return this.now() - this.failedAt > BACKOFF; }

  _offline(err) { if (!(err && err.status)) this.failedAt = this.now(); } // not one missing file

  async _state(kind) {
    if (!this.kinds.has(kind)) {
      const s = { map: null, refreshing: null, missing: new Set(), loading: null };
      this.kinds.set(kind, s);
      s.loading = (async () => {
        try {
          const m = JSON.parse(await fsp.readFile(path.join(this.root, `${KINDS[kind].dir}.json`), 'utf8'));
          if (goodMap(m)) s.map = m;
        } catch { /* first run */ }
        if (!s.map && goodMap(this.bundled[kind])) s.map = { ...this.bundled[kind], fetched: 0 };
      })();
    }
    const s = this.kinds.get(kind);
    await s.loading;
    return s;
  }

  _refresh(kind, s) {
    if (!s.refreshing) {
      s.refreshing = (async () => {
        try {
          const docs = [];
          for (const list of KINDS[kind].lists) docs.push(JSON.parse((await this.fetch(CDRAGON + list)).toString('utf8')));
          const map = mapFromLists(kind, docs);
          if (!goodMap(map)) throw Object.assign(new Error('empty icon list'), { status: 0 });
          map.fetched = this.now();
          s.map = map;
          await fsp.mkdir(this.root, { recursive: true });
          await writeAtomic(path.join(this.root, `${KINDS[kind].dir}.json`), JSON.stringify(map)).catch(() => {}); // fine in memory
        } catch (err) {
          this._offline(err);
          if (err && err.status !== undefined) s.retryAt = this.now() + BACKOFF; // a bad list: not again for a while
        } finally {
          s.refreshing = null;
        }
      })();
    }
    return s.refreshing;
  }

  // Local path of the icon, or null when the id is unknown, has no icon, or can't be fetched now.
  // Never throws.
  async icon(kind, id) {
    try {
      if (!Object.hasOwn(KINDS, kind) || !validId(id)) return null;
      const key = `${kind}:${id}`;
      if (this.files.has(key)) return this.files.get(key);
      const file = path.join(this.root, KINDS[kind].dir, `${id}.png`);
      if (await exists(file)) { this.files.set(key, file); return file; }
      const s = await this._state(kind);
      // A stale (or only bundled) list is refreshed in the background and used meanwhile; only an
      // id it doesn't know (a brand-new item) waits for the download.
      const age = s.map ? this.now() - (s.map.fetched || 0) : NaN;
      const stale = !(age >= 0 && age < WEEK);
      const net = this._mayUseNetwork() && !(s.retryAt > this.now());
      const refreshing = stale && net ? this._refresh(kind, s) : null;
      let rel = iconRel(s.map, id);
      if (!rel && refreshing) { await refreshing; rel = iconRel(s.map, id); }
      if (!rel || s.missing.has(id) || !this._mayUseNetwork()) return null;
      if (!this.inflight.has(key)) {
        this.inflight.set(key, (async () => {
          const png = await this.fetch(CDRAGON + rel);
          if (!isPng(png)) throw Object.assign(new Error('not a PNG'), { status: 0 }); // a captive portal page, say
          await fsp.mkdir(path.dirname(file), { recursive: true });
          await writeAtomic(file, png);
          this.files.set(key, file);
          return file;
        })().finally(() => this.inflight.delete(key)));
      }
      try {
        return await this.inflight.get(key);
      } catch (err) {
        if (err && err.status !== undefined) s.missing.add(id); // 404 or not an image: not again this session
        this._offline(err);
        return null;
      }
    } catch {
      return null;
    }
  }

  // The icon's display name ("Flash", "Conqueror") when the downloaded list has it, else null.
  async name(kind, id) {
    if (!Object.hasOwn(KINDS, kind) || !validId(id)) return null;
    const s = await this._state(kind);
    const n = s.map && s.map.names && Object.hasOwn(s.map.names, id) ? s.map.names[id] : null;
    return typeof n === 'string' ? n : null;
  }
}

module.exports = { GameIcons, KINDS, CDRAGON, mapFromLists, iconRel, relPath };
