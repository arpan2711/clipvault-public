// Groups the library's flat file list into League matches: one entry per game holding its full
// recording, minimap, highlights and highlight videos, plus everything else as loose clips.
// Pure functions (no DOM, no IPC), so they're unit-tested in Node (test/group-test.js).

// Which symbol wins when a clip covers several moments (same order as events.js).
export const RANK = {
  multikill: 100, ace: 90, teamfight: 85, baron: 80, elder: 78, atakhan: 76, victory: 75, bookmark: 70,
  dragon: 60, herald: 58, grubs: 55, firstblood: 50, kill: 45, inhib: 35, turret: 30, death: 25, assist: 20, defeat: 15, other: 0,
};

// The 7 families the UI colours and filters by.
export const FAMILY = {
  kill: 'kill', firstblood: 'kill', assist: 'assist', death: 'death',
  multikill: 'multikill', ace: 'multikill', teamfight: 'multikill',
  baron: 'objective', elder: 'objective', atakhan: 'objective', dragon: 'objective', herald: 'objective', grubs: 'objective',
  turret: 'structure', inhib: 'structure', bookmark: 'bookmark', victory: 'result', defeat: 'result', other: 'other',
};

const LEAGUE = 'League of Legends';
const MATCH_TYPES = new Set(['highlight', 'recording', 'map', 'montage']);
const GAP_MS = 8 * 60 * 1000; // highlights further apart than this aren't the same game
const WINDOW_MS = 120 * 1000; // slack around a recording's time span

export const familyOf = (type) => FAMILY[type] || 'other';

// The moment a clip is about: its highest-ranked marker, else its event, else 'other'.
export function primaryMarker(item) {
  const markers = (item.markers || []).filter((m) => m && m.type);
  if (markers.length) return markers.reduce((best, m) => ((RANK[m.type] || 0) > (RANK[best.type] || 0) ? m : best));
  return item.event ? { t: 0, type: item.event, label: item.label || '' } : null;
}

// Key precedence: the match store key (later releases) -> the match's minimap file -> none.
export function matchKeyOf(item) {
  if (item.match) return item.match;
  if (item.type === 'map') return `map:${item.path}`;
  if (item.map && item.map.path) return `map:${item.map.path}`;
  if (item.source && item.source.map) return `map:${item.source.map}`;
  return null;
}

// Game clock of a minimap recording: game time = minimap video time + gameStart (seconds).
// The victory/defeat marker is the game's end, and stats.gameTime is the game time then.
// Approximate (up to a few seconds) for matches recorded before match records existed.
export function gameClock(mapItem) {
  if (!mapItem || !mapItem.stats || !(mapItem.stats.gameTime > 0)) return null;
  const end = (mapItem.markers || []).find((m) => m.type === 'victory' || m.type === 'defeat');
  if (!end) return null;
  return { gameStart: Math.round((mapItem.stats.gameTime - end.t) * 10) / 10, approx: true };
}

const startOf = (item) => (item.created || 0) - (item.duration || 0) * 1000;
const tenth = (x) => Math.round(x * 10) / 10;
const lowerPath = (p) => String(p || '').toLowerCase();

// A match's minimap can be in several files: ClipVault restarted, or capture recovered, in the
// middle of the match. The one with the game clock (its Victory/Defeat marker) leads, else the
// longest; each other part is placed on the game clock by when it started, so its videos' times
// count from the leading minimap (their copies' map.offset is rebased; the library is untouched).
//   -> { map, parts: [{ item, path, gameStart }] (oldest first), files: the files, rebased }
function mapParts(files) {
  const maps = files.filter((i) => i.type === 'map');
  if (maps.length < 2) return { map: maps[0] || null, parts: maps.map((item) => ({ item, path: item.path, gameStart: (gameClock(item) || {}).gameStart ?? null })), files };
  const map = maps.find((i) => gameClock(i)) || [...maps].sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
  const clock = gameClock(map);
  const parts = maps.map((item) => {
    const own = gameClock(item);
    const gameStart = own ? own.gameStart
      : clock && item.created && map.created ? tenth(clock.gameStart + (startOf(item) - startOf(map)) / 1000) : null;
    return { item, path: item.path, gameStart };
  }).sort((a, b) => (a.gameStart ?? 0) - (b.gameStart ?? 0) || startOf(a.item) - startOf(b.item));
  if (!clock) return { map, parts, files };
  const shift = new Map(parts.filter((p) => p.item !== map && p.gameStart !== null).map((p) => [lowerPath(p.path), p.gameStart - clock.gameStart]));
  const rebased = files.map((i) => {
    const d = i.map && typeof i.map.offset === 'number' ? shift.get(lowerPath(i.map.path)) : undefined;
    return d === undefined ? i : { ...i, map: { ...i.map, offset: tenth(i.map.offset + d), part: i.map.path } };
  });
  return { map, parts, files: rebased };
}

// The minimap part playing at game time t (seconds): the one whose span covers t, else the
// leading one. -> { item, gameStart } or null.
export function mapPartAt(match, t) {
  const parts = (match && match.maps) || [];
  const hit = parts.find((p) => p.gameStart !== null && p.item.url && t >= p.gameStart && t < p.gameStart + (p.item.duration || 0));
  if (hit) return { item: hit.item, gameStart: hit.gameStart };
  return match && match.map ? { item: match.map, gameStart: match.gameStart } : null;
}

// The game time (s) of 0:00 on the minimap an item's map.offset counts from (or of the minimap
// item itself), within its match: the leading minimap's unless the item is in another part.
export function mapClockOf(match, item) {
  if (!match) return null;
  const p = item && (item.type === 'map' ? item.path : item.map && item.map.path);
  const part = p ? (match.maps || []).find((x) => lowerPath(x.path) === lowerPath(p)) : null;
  return part && part.gameStart !== null ? part.gameStart : match.gameStart;
}

function summarize(key, all, inferred) {
  const { map, parts, files } = mapParts(all);
  const full = files.filter((i) => i.type === 'recording').sort((a, b) => (b.duration || 0) - (a.duration || 0))[0] || null;
  const withStats = [map, full, ...files].find((i) => i && i.stats) || null;
  const stats = withStats ? withStats.stats : null;
  const clock = gameClock(map);
  const clips = files.filter((i) => i.type === 'highlight').map((item) => {
    const m = primaryMarker(item);
    const type = m ? m.type : 'other';
    const offset = item.map && typeof item.map.offset === 'number' ? item.map.offset : null;
    const gameAt = clock && offset !== null ? Math.round((offset + (m ? m.t : 0) + clock.gameStart) * 10) / 10 : null;
    return { ...item, momentType: type, family: familyOf(type), gameAt };
  }).sort((a, b) => (a.gameAt ?? 0) - (b.gameAt ?? 0) || (a.created || 0) - (b.created || 0));
  const extras = files.filter((i) => i.type !== 'map' && i !== full && i.type !== 'highlight');
  const counts = { all: clips.length, kill: 0, assist: 0, death: 0, multikill: 0, objective: 0, structure: 0, bookmark: 0, result: 0, other: 0 };
  for (const c of clips) counts[c.family] += 1;
  const cover = clips.reduce((best, c) => (!best || (RANK[c.momentType] || 0) > (RANK[best.momentType] || 0) ? c : best), null);
  const anchor = map || full || clips[0] || files[0];
  const start = Math.min(...files.map(startOf));
  return {
    key,
    inferred,
    game: LEAGUE,
    map,
    maps: parts, // every minimap file of the match, on the game clock (more than one after a restart)
    full,
    clips,
    extras,
    files,
    champion: (stats && stats.champion) || anchor.champion || null,
    championIcon: files.map((i) => i.championIcon).find(Boolean) || null,
    stats,
    result: (stats && stats.result) || null,
    gameTime: (stats && stats.gameTime) || null,
    gameStart: clock ? clock.gameStart : null,
    start,
    end: Math.max(...files.map((i) => i.created || 0)),
    size: files.reduce((s, i) => s + (i.size || 0), 0),
    counts,
    cover,
    favorite: files.some((i) => i.favorite),
  };
}

// League items with no minimap link (minimap recording off, or its file deleted): grouped by time.
// A recording with stats defines its game's window; other highlights chain until a victory or
// defeat clip, a champion change, or a long gap. These groups are marked inferred.
function inferGroups(items) {
  const groups = [];
  const rest = [];
  const anchors = items.filter((i) => (i.type === 'recording' || i.type === 'map') && i.stats && i.stats.gameTime > 0);
  const taken = new Set();
  for (const a of anchors) {
    const from = (a.created || 0) - a.stats.gameTime * 1000 - WINDOW_MS;
    const to = (a.created || 0) + WINDOW_MS;
    const champ = a.stats.champion || a.champion;
    const members = items.filter((i) => !taken.has(i) && (i === a || ((i.created || 0) >= from && (i.created || 0) <= to
      && i.type !== 'map' && !(i.type === 'recording' && i !== a) && (!champ || !i.champion || i.champion === champ))));
    members.forEach((m) => taken.add(m));
    groups.push(members);
  }
  for (const i of items) if (!taken.has(i)) rest.push(i);
  rest.sort((a, b) => (a.created || 0) - (b.created || 0));
  let cur = [];
  for (const i of rest) {
    const prev = cur[cur.length - 1];
    const ended = prev && ['victory', 'defeat'].includes((primaryMarker(prev) || {}).type);
    if (prev && (ended || (i.created || 0) - (prev.created || 0) > GAP_MS || (prev.champion && i.champion && prev.champion !== i.champion))) {
      groups.push(cur);
      cur = [];
    }
    cur.push(i);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// -> { matches: MatchEntry[] (newest first), loose: Item[] (newest first) }
export function groupLibrary(items) {
  const byKey = new Map();
  const unlinked = [];
  const loose = [];
  for (const item of items) {
    const key = matchKeyOf(item);
    if (key) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(item);
    } else if (item.game === LEAGUE && MATCH_TYPES.has(item.type)) {
      unlinked.push(item);
    } else {
      loose.push(item);
    }
  }
  const matches = [...byKey].map(([key, files]) => summarize(key, files, false));
  for (const files of inferGroups(unlinked)) matches.push(summarize(`inferred:${Math.min(...files.map((f) => f.created || 0))}`, files, true));
  matches.sort((a, b) => b.start - a.start);
  // Instant replays and bookmarks saved during a game also show in that match (they stay in loose too).
  for (const clip of loose) {
    if (clip.game !== LEAGUE) continue;
    const m = matches.find((x) => (clip.created || 0) >= x.start && (clip.created || 0) <= x.end + 30 * 1000);
    if (m) m.extras.push({ ...clip, alsoLoose: true });
  }
  loose.sort((a, b) => (b.created || 0) - (a.created || 0));
  return { matches, loose };
}

// ------------------------------------------------------------------ match records

const RESULT_NAMES = { Win: 'Victory', Lose: 'Defeat', Remake: 'Remake' };
const ROW_STATS = { kills: 'k', deaths: 'd', assists: 'a', level: 'level', cs: 'cs', damage: 'damage', damageShare: 'damageShare', gold: 'gold', vision: 'vision', kp: 'kp' };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// A match's stats with its record's (League client: CS, damage, gold, vision, KP, items, spells,
// runes) filled in. A
// number the record doesn't have yet, or has as 0 where the library knows better, never replaces
// what the library knows.
export function withRecordStats(stats, row) {
  const out = { ...(stats || {}) };
  for (const [field, from] of Object.entries(ROW_STATS)) {
    const v = row[from];
    if (isNum(v) && (v > 0 || out[field] == null)) out[field] = v;
  }
  // The record's CS is exact once the client reported it; a backfilled one is the in-game count
  // (rounded down to 10) until match history answers.
  if (isNum(row.cs) && out.cs === row.cs) {
    out.csApprox = Boolean(row.csApprox) || Boolean(row.legacy && (row.pending || []).includes('history'));
  }
  if (!out.result && RESULT_NAMES[row.result]) out.result = RESULT_NAMES[row.result];
  if (row.queueName) out.queueName = row.queueName;
  // The build, as ids (their icons are looked up when the row is drawn).
  const ids = (list) => Array.isArray(list) && list.some((v) => isNum(v) && v > 0);
  if (ids(row.items)) out.items = row.items.map((v) => (isNum(v) && v > 0 ? v : 0));
  if (ids(row.spells)) out.spells = row.spells.slice(0, 2);
  if (isNum(row.keystone) && row.keystone > 0) out.keystone = row.keystone;
  if (isNum(row.subStyle) && row.subStyle > 0) out.subStyle = row.subStyle;
  return out;
}

// Joins the match records' list rows (matches:list) onto groupLibrary()'s matches, by key: each
// match with a record gets `record` (the row) and the record's stats. Changes the entries in place.
export function applyRecords(matches, rows) {
  const byKey = new Map((rows || []).filter((r) => r && r.key).map((r) => [r.key, r]));
  for (const m of matches || []) {
    const row = byKey.get(m.key);
    if (!row) continue;
    m.record = row;
    m.stats = withRecordStats(m.stats, row);
    if (!m.result && RESULT_NAMES[row.result]) m.result = RESULT_NAMES[row.result];
  }
  return matches;
}
