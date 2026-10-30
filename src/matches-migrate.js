// One-time backfill of match records for the League matches already in library.json (A4 §5.5,
// step C1). Runs at every start and does nothing for matches it has done before. It only reads
// library.json's entries and the game's log folder names/IDs; it never opens, moves or changes a
// video.
//
//   1. Group: every minimap recording (type 'map') plus each video whose `map.file` points at it.
//   2. Anchor the clock: the Victory/Defeat marker on the minimap is the GameEnd moment and the
//      post-game `stats.gameTime` its game time, so map.gameStart = -(marker.t - stats.gameTime).
//      The minimap's start (wall clock) comes from its file name ("… 2026-10-17 22-36-14 … Map").
//   3. Create a legacy record per group: champion, result, K/D/A, mode, duration, the videos in
//      game time, the minimap's markers as events; pending: gameId, history, timeline.
//   4. The game ID: the GameLogs folder made 0–120 s before the minimap started. With the log's
//      platform the record gets its real key now; otherwise once match history has answered.
//   The library entries get `match: <key>`. History and timeline fill in at the next sweep with
//   the League client running (match-capture.js).
const path = require('path');
const lm = require('./games/league-match');
const { gameIdFromLogs } = require('./games/league-ids');
const CHAMPIONS = require('./games/champion-ids.json').champions;
const FALLBACK_PLATFORM = 'EUW1'; // the user's region (same fallback as match-capture.js)

const STAMP = /(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})/;
const plain = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const CHAMPION_BY_NAME = new Map();
for (const [id, [alias, name]] of Object.entries(CHAMPIONS)) {
  CHAMPION_BY_NAME.set(plain(name), Number(id));
  if (!CHAMPION_BY_NAME.has(plain(alias))) CHAMPION_BY_NAME.set(plain(alias), Number(id));
}
const tenth = (x) => Math.round(x * 10) / 10;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// Wall-clock ms of the local time stamped in a ClipVault file name, or null.
function stampTime(file) {
  const m = STAMP.exec(path.basename(String(file || '')));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const t = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isFinite(t) ? t : null;
}

// The groups: [{ mapFile, map, members: [{ file, meta }] }], oldest first.
function groupMatches(index) {
  const groups = [];
  for (const [file, meta] of Object.entries(index || {})) {
    if (!meta || meta.type !== 'map') continue;
    const members = Object.entries(index)
      .filter(([f, m]) => f !== file && m && m.map && m.map.file === file)
      .map(([f, m]) => ({ file: f, meta: m }));
    groups.push({ mapFile: file, map: meta, members });
  }
  return groups.sort((a, b) => (a.map.created || 0) - (b.map.created || 0));
}

// map.gameStart (s) from the minimap's Victory/Defeat marker and the post-game game time, or null.
function mapGameStart(map) {
  const stats = map.stats || {};
  const end = (map.markers || []).find((m) => m && (m.type === 'victory' || m.type === 'defeat'));
  if (!end || num(end.t) === null || num(stats.gameTime) === null) return null;
  return tenth(-(end.t - stats.gameTime));
}

function legacyRecord(group) {
  const { map, mapFile, members } = group;
  const stats = map.stats || {};
  const champion = map.champion || stats.champion || (members.find((x) => x.meta.champion) || {}).meta?.champion || null;
  const championId = champion ? CHAMPION_BY_NAME.get(plain(champion)) : undefined;
  const info = championId !== undefined ? lm.championInfo(championId) : null;
  const gameStart = mapGameStart(map);
  const mapStart = stampTime(mapFile) || (num(map.created) !== null && num(map.duration) !== null ? map.created - map.duration * 1000 : null);
  const wallAt0 = gameStart !== null && mapStart !== null ? Math.round(mapStart - gameStart * 1000) : null;
  const result = stats.result === 'Victory' || stats.result === 'Win' ? 'Win' : stats.result === 'Defeat' || stats.result === 'Lose' ? 'Lose' : null;
  const g = (mapTime) => (gameStart !== null && num(mapTime) !== null ? tenth(mapTime + gameStart) : null);

  const me = {
    participantId: 1, isMe: true, team: null,
    championId: info ? info.championId : null, alias: info ? info.alias : null, champion: info ? info.champion : champion,
    kills: num(stats.kills), deaths: num(stats.deaths), assists: num(stats.assists),
    level: num(stats.level) > 0 ? stats.level : null, // 0 means "not known" in old summaries
    cs: num(stats.cs), csApprox: num(stats.cs) !== null, // the in-game count, rounded down to 10
    wardScore: num(stats.wardScore),
  };
  const events = (map.markers || []).filter((m) => m && num(m.t) !== null).map((m) => ({
    t: g(m.t), name: 'Marker', type: m.type || null, label: m.label || null, mine: true,
  })).filter((e) => e.t !== null);
  const partial = {
    source: 'legacy',
    gameMode: stats.gameMode || null,
    duration: num(stats.gameTime),
    result,
    participants: [me],
    teams: [],
    events,
  };
  let rec = lm.blankRecord({
    clock: { wallAt0 }, pending: ['gameId', 'history', 'timeline'], startedAt: wallAt0 || mapStart || map.created || null,
  });
  rec = lm.merge(rec, [partial]).record;
  rec.sources.legacy = true;
  rec.media.map = { file: path.resolve(mapFile), gameStart };
  for (const { file, meta } of members) {
    const offset = meta.map ? num(meta.map.offset) : null;
    if (meta.type === 'recording') {
      rec.media.full.push({ file: path.resolve(file), gameStart: g(offset) });
    } else if (meta.type === 'highlight' || meta.type === 'clip') {
      const from = g(offset);
      const dur = num(meta.duration);
      rec.media.clips.push({
        file: path.resolve(file), from, to: from !== null && dur !== null ? tenth(from + dur) : null,
        title: meta.label || null, type: meta.event || null, score: null,
        moments: (meta.markers || []).map((m) => ({ t: from !== null && num(m.t) !== null ? tenth(from + m.t) : null, label: m.label || null, type: m.type || null })),
      });
    }
  }
  rec.media.clips.sort((a, b) => (a.from || 0) - (b.from || 0));
  rec.media.clips.forEach((c, i) => { c.id = i + 1; });
  return { rec, mapStart, members: [mapFile, ...members.map((x) => x.file)] };
}

// The key of the one stored record of the same match as a backfilled record, or null: the same
// game ID, else (no ID on one side) your champion and a start in the same few minutes, or a
// record still open (no end) that started while this one ran. Several candidates are fine when
// they share one game ID (the first, a real key if there is one); otherwise null (unsure).
async function coveringRecord(store, rec) {
  const keys = await store.findSame(rec);
  if (keys.length <= 1) return keys[0] || null;
  const ids = new Set();
  for (const k of keys) {
    const other = await store.get(k);
    ids.add(other && other.gameId ? Number(other.gameId) : null);
  }
  return ids.size === 1 && !ids.has(null) ? keys[0] : null;
}

// library: a Library (only its index, setMatch() and _changed() are used); store: a MatchStore.
// installDir: the League folder or a function returning it (for the game logs).
// Resolves { created: [keys], linked: [keys of records that took a group in], skipped }.
async function migrateLibrary({ library, store, installDir = null, log = () => {} }) {
  const out = { created: [], linked: [], skipped: 0 };
  const dir = typeof installDir === 'function' ? installDir() : installDir;
  for (const group of groupMatches(library.index)) {
    try {
      // Done before: the minimap already belongs to a match record.
      const known = await store.byFile(group.mapFile);
      if (known) {
        library.setMatch([group.mapFile, ...group.members.map((x) => x.file)].filter((f) => !library.index[f].match), known);
        out.skipped++;
        continue;
      }
      const { rec, mapStart, members } = legacyRecord(group);
      let ids = null;
      if (dir && mapStart !== null) ids = await gameIdFromLogs(dir, mapStart).catch(() => null);
      if (ids && ids.gameId) {
        rec.gameId = Number(ids.gameId);
        rec.prov.gameId = 'log';
        // A game log names the platform only on its command line, which is never read (it holds a
        // session key), so old matches take the user's platform, as live matches do (match-capture.js).
        rec.platformId = ids.platformId || FALLBACK_PLATFORM;
        if (!ids.platformId) rec.prov.platformId = 'fallback';
        rec.pending = rec.pending.filter((x) => x !== 'gameId');
      }
      // A match a record already covers (its minimap was cut short by a restart of the app, so it
      // was never linked): its videos join that record instead of making a second one.
      const covering = await coveringRecord(store, rec);
      if (covering) {
        const into = await store.absorb(covering, rec);
        if (into) {
          library.setMatch(members, into.key);
          out.linked.push(into.key);
          log(`linked ${path.basename(group.mapFile)} (${members.length} videos) to ${into.key}, which already covers that match`);
          continue;
        }
      }
      const base = rec.clock.wallAt0 || rec.startedAt || Date.now();
      let created = null;
      for (let i = 0; i < 5 && !created; i++) {
        rec.key = rec.gameId && rec.platformId ? `${String(rec.platformId).toUpperCase()}_${rec.gameId}` : `local-${Math.round(base) + i}`;
        try {
          created = await store.create(rec);
        } catch (err) {
          if (err.code !== 'EEXIST' || rec.key.includes('_')) throw err; // a real key that's taken: the same game
        }
      }
      if (!created) continue;
      library.setMatch(members, created.key);
      out.created.push(created.key);
      log(`backfilled ${created.key} from ${path.basename(group.mapFile)} (${members.length} videos${rec.gameId ? '' : ', no game ID yet'})`);
    } catch (err) {
      log(`backfill of ${path.basename(group.mapFile)}: ${err.message}`);
    }
  }
  return out;
}

module.exports = { migrateLibrary, groupMatches, legacyRecord, mapGameStart, stampTime };
