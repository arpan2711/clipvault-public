// Square champion portraits for League highlights, from Riot's Data Dragon CDN. Everything is
// cached on disk, so after the first download icons show instantly and offline.
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./fsutil');
const { fetchBuffer, isPng } = require('./net');

const fsp = fs.promises;
const CDN = 'https://ddragon.leagueoflegends.com';
const MAP_FILE = 'champions.json';
const DAY = 24 * 60 * 60 * 1000;
const BACKOFF = 10 * 60 * 1000; // after a network failure, stay off the network for a while
const VERSION = /^\d+(\.\d+)+$/;
const ID = /^[A-Za-z0-9]+$/; // ids end up in file names and URLs
const byVersion = new Intl.Collator('en', { numeric: true }).compare;

const states = new Map(); // cacheDir -> { map, refreshing, failedAt }
const inflight = new Map(); // one download per icon, however many cards ask at once

// "Nunu & Willump", "Bel'Veth", "Dr. Mundo" and Riot's own ids all reduce to plain letters.
const key = (name) => String(name).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');

async function readMap(dir) {
  try {
    const map = JSON.parse(await fsp.readFile(path.join(dir, MAP_FILE), 'utf8'));
    return map && VERSION.test(map.version) && map.ids && typeof map.ids === 'object' ? map : null;
  } catch {
    return null;
  }
}

async function downloadMap(dir) {
  const versions = JSON.parse((await fetchBuffer(`${CDN}/api/versions.json`)).toString('utf8'));
  const version = Array.isArray(versions) && versions.find((v) => VERSION.test(v)); // newest first
  if (!version) throw new Error('unexpected versions.json');
  const { data } = JSON.parse((await fetchBuffer(`${CDN}/cdn/${version}/data/en_US/champion.json`)).toString('utf8'));
  const ids = {};
  for (const c of Object.values(data || {})) {
    if (!c || !ID.test(c.id)) continue;
    ids[key(c.id)] = c.id; // "MonkeyKing" works as well as "Wukong"
    ids[key(c.name)] = c.id;
  }
  if (!Object.keys(ids).length) throw new Error('empty champion list');
  const map = { version, fetched: Date.now(), ids };
  await fsp.mkdir(dir, { recursive: true });
  await writeAtomic(path.join(dir, MAP_FILE), JSON.stringify(map)).catch(() => {}); // still fine in memory
  return map;
}

function stateFor(dir) {
  if (!states.has(dir)) states.set(dir, { map: undefined, refreshing: null, failedAt: 0 });
  return states.get(dir);
}

const mayUseNetwork = (s) => Date.now() - s.failedAt > BACKOFF;

function refresh(dir, s) {
  if (!s.refreshing) {
    s.refreshing = downloadMap(dir)
      .then((map) => { s.map = map; }, () => { s.failedAt = Date.now(); })
      .then(() => { s.refreshing = null; });
  }
  return s.refreshing;
}

function lookup(s, wanted) {
  const id = s.map && Object.hasOwn(s.map.ids, wanted) ? s.map.ids[wanted] : null;
  return typeof id === 'string' && ID.test(id) ? id : null;
}

async function iconsOf(dir, id) {
  const names = await fsp.readdir(dir).catch(() => []);
  return names.filter((n) => n.startsWith(`${id}-`) && n.endsWith('.png')).sort(byVersion);
}

// Icons are stored per patch (Evelynn-15.20.1.png) so a visual update replaces the old portrait.
async function iconFile(dir, s, id) {
  const { version } = s.map;
  const file = path.join(dir, `${id}-${version}.png`);
  if (await fsp.access(file).then(() => true, () => false)) return file;
  if (mayUseNetwork(s)) {
    if (!inflight.has(file)) {
      inflight.set(file, (async () => {
        const png = await fetchBuffer(`${CDN}/cdn/${version}/img/champion/${id}.png`);
        if (!isPng(png)) throw new Error('not a PNG'); // e.g. a captive portal page
        await fsp.mkdir(dir, { recursive: true });
        await writeAtomic(file, png);
        for (const old of await iconsOf(dir, id)) {
          if (old !== path.basename(file)) await fsp.rm(path.join(dir, old), { force: true }).catch(() => {});
        }
        return file;
      })().finally(() => inflight.delete(file)));
    }
    try {
      return await inflight.get(file);
    } catch (err) {
      if (!err.status) s.failedAt = Date.now(); // offline, rather than one missing icon
    }
  }
  const older = (await iconsOf(dir, id)).pop(); // offline: an earlier patch's portrait will do
  return older ? path.join(dir, older) : null;
}

// Local path of the champion's square icon, or null when it's unknown or can't be fetched.
// Never throws.
async function championIcon(championName, cacheDir) {
  try {
    const wanted = championName ? key(championName) : '';
    if (!wanted || !cacheDir) return null;
    const dir = path.resolve(cacheDir);
    const s = stateFor(dir);
    if (s.map === undefined) s.map = await readMap(dir);
    // A stale list is refreshed in the background (at most daily) and used meanwhile; only a
    // name it doesn't know (first run, brand-new champion) waits for the download.
    const age = s.map ? Date.now() - s.map.fetched : NaN;
    const stale = !(age >= 0 && age < DAY); // a future timestamp (clock change) counts as stale
    const refreshing = stale && mayUseNetwork(s) ? refresh(dir, s) : null;
    let id = lookup(s, wanted);
    if (!id && refreshing) {
      await refreshing;
      id = lookup(s, wanted);
    }
    return id ? await iconFile(dir, s, id) : null;
  } catch {
    return null;
  }
}

module.exports = { championIcon };
