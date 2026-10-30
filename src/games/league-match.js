// League match records (A4 §5.2): pure functions that turn what the game and the League client
// report into one record per match. Nothing here does I/O.
//
// Each source has a mapper that returns a *partial*: the record's shape, holding only what that
// source knows, tagged with `source`:
//   fromLive(allgamedata, me, {final})  'live' during the match, 'live-final' at GameEnd
//   fromEog(block)                      'eog'      end-of-game screen, seconds after the game
//   fromHistory(game, me)               'history'  match history, usually within a minute
//   fromTimeline(timeline, game)        'timeline' per-minute frames and kill positions
//   fromLp(notification)                'lp'       LP change, readable only on the end-of-game screen
//   fromRanked(stats, {queueType,when}) 'ranked'   rank before or after the match
//   fromSession(session)                'session'  gameId and queue, readable mid-game
// merge(record, partials) folds them in. For each value the best source wins (history > eog >
// live-final > live) while a weaker one can still fill a gap, so the order they arrive in doesn't
// matter. derive() works out the ratios and rowOf() the small row the match list shows.
//
// Identity never relies on localized names: champions by numeric id or rawChampionName (the Data
// Dragon alias), players by team + champion.
const { classify, dragonName } = require('./league');
const CHAMPIONS = require('./champion-ids.json').champions;

const RANK = { legacy: 0, live: 1, 'live-final': 2, session: 3, eog: 3, history: 4, timeline: 5, lp: 5, ranked: 5 };
// The order merge() applies sources in, whatever order they're passed in.
const APPLY_ORDER = ['legacy', 'live', 'live-final', 'session', 'eog', 'history', 'timeline', 'ranked', 'lp'];
const SOURCE_KEY = { live: 'live', 'live-final': 'liveFinal', session: 'session', eog: 'eog', history: 'history', timeline: 'timeline', lp: 'lp', ranked: 'ranked', legacy: 'legacy' };
const STAT_SOURCES = new Set(['legacy', 'live', 'live-final', 'eog', 'history']);
// Match history's lane is a guess, weaker than the assigned or detected role: it only fills a gap.
const FILL_ONLY = { history: new Set(['role']) };
// The client's start and end times are estimates; the end-of-game one is the closer of the two.
// (derive() replaces both with the live clock whenever the record has it.)
const FIELD_RANK = { startedAt: { eog: 2, history: 1 }, endedAt: { eog: 2, history: 1 } };
const IDENTITY_FIELDS = ['gameId', 'platformId', 'queueId', 'gameMode', 'mapId', 'patch']; // the first value stays
const GAME_FIELDS = ['duration', 'gameEndTime', 'result', 'surrender', 'startedAt', 'endedAt']; // the best source wins
const ROW_SKIP = new Set(['participantId', 'isMe', 'src']);
// Field order of the record's rows, so a record is the same whatever order its sources came in.
const PARTICIPANT_FIELDS = ['participantId', 'team', 'isMe', 'championId', 'champion', 'alias', 'name', 'tag', 'role', 'level',
  'kills', 'deaths', 'assists', 'cs', 'csApprox', 'gold', 'goldSpent', 'damage', 'damageTaken', 'mitigated', 'heal', 'shielded',
  'vision', 'wardsPlaced', 'wardsKilled', 'controlWards', 'ccTime', 'objectiveDamage', 'turretDamage', 'largestMultiKill',
  'multikills', 'items', 'roleItem', 'spells', 'keystone', 'primaryStyle', 'subStyle', 'perks', 'skinId', 'augments', 'placement', 'src'];
const TEAM_FIELDS = ['teamId', 'win', 'kills', 'gold', 'damage', 'dragons', 'barons', 'heralds', 'grubs', 'atakhans', 'towers', 'inhibs', 'bans', 'src'];
const RANK_FIELDS = ['queueType', 'before', 'after', 'lpDelta', 'source'];
// Whose event list the record keeps: the live feed (complete, and on the videos' clock) beats the
// timeline's, which only stands in when there was no live feed.
const EVENT_RANK = { legacy: 0, timeline: 1, live: 2, 'live-final': 3 };

const QUEUES = {
  0: 'Custom', 400: 'Draft Pick', 420: 'Ranked Solo/Duo', 430: 'Blind Pick', 440: 'Ranked Flex', 450: 'ARAM', 480: 'Swiftplay',
  490: 'Quickplay', 700: 'Clash', 720: 'Clash', 830: 'Co-op vs. AI: Intro', 840: 'Co-op vs. AI: Beginner', 850: 'Co-op vs. AI: Intermediate',
  870: 'Co-op vs. AI: Intro', 880: 'Co-op vs. AI: Beginner', 890: 'Co-op vs. AI: Intermediate', 900: 'ARURF', 1020: 'One For All',
  1300: 'Nexus Blitz', 1400: 'Ultimate Spellbook', 1700: 'Arena', 1710: 'Arena', 1900: 'URF', 2300: 'Brawl', 2400: 'ARAM: Mayhem',
};
const RANKED_QUEUES = { 420: 'RANKED_SOLO_5x5', 440: 'RANKED_FLEX_SR' };
// Data Dragon summoner.json keys (the Live Client names spells only by these) -> numeric ids.
const SPELLS = {
  SummonerBarrier: 21, SummonerBoost: 1, SummonerCherryFlash: 2202, SummonerCherryHold: 2201, SummonerDot: 14, SummonerExhaust: 3,
  SummonerFlash: 4, SummonerHaste: 6, SummonerHeal: 7, SummonerMana: 13, SummonerPoroRecall: 30, SummonerPoroThrow: 31,
  SummonerSmite: 11, SummonerSnowURFSnowball_Mark: 39, SummonerSnowball: 32, SummonerTeleport: 12,
  Summoner_UltBookPlaceholder: 54, Summoner_UltBookSmitePlaceholder: 55,
};
const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIVISIONS = ['IV', 'III', 'II', 'I'];
const APEX = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const ROLES = new Set(['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']);
const ROLE_ALIASES = { MID: 'MIDDLE', BOT: 'BOTTOM', ADC: 'BOTTOM', CARRY: 'BOTTOM', SUPPORT: 'UTILITY', SUP: 'UTILITY', JUNGLER: 'JUNGLE' };
const TEAM = { ORDER: 100, CHAOS: 200, 100: 100, 200: 200 };
const MONSTER_EVENTS = { DRAGON: 'DragonKill', BARON_NASHOR: 'BaronKill', RIFTHERALD: 'HeraldKill', HORDE: 'HordeKill', ATAKHAN: 'AtakhanKill' };
const BUILDING_EVENTS = { TOWER_BUILDING: 'TurretKilled', INHIBITOR_BUILDING: 'InhibKilled' };
const DRAGONS = { FIRE_DRAGON: 'Fire', WATER_DRAGON: 'Water', EARTH_DRAGON: 'Earth', AIR_DRAGON: 'Air', CHEMTECH_DRAGON: 'Chemtech', HEXTECH_DRAGON: 'Hextech', ELDER_DRAGON: 'Elder' };
// Kinds of moments the LCU timeline also has; legacy markers of other kinds (bookmarks, the
// result) are kept when the timeline replaces them.
const TIMELINE_KINDS = new Set(['kill', 'death', 'assist', 'multikill', 'firstblood', 'ace', 'teamfight', 'dragon', 'elder', 'baron', 'herald', 'grubs', 'atakhan', 'turret', 'inhib']);

// ---------------------------------------------------------------- small helpers

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (num(v) === null ? null : Math.round(v));
const round = (v, digits = 0) => (num(v) === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const norm = (s) => String(s || '').trim().toLowerCase();
const plain = (s) => String(s || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
const sum = (...values) => (values.every((v) => num(v) !== null) ? values.reduce((a, b) => a + b, 0) : null);
const otherTeam = (team) => (team === 100 ? 200 : team === 200 ? 100 : null);
const median = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const nonZero = (values) => (values.some((v) => v) ? values : null);
// The object with `fields` first, in that order (missing ones as null), then anything else.
function ordered(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj[f] === undefined ? null : obj[f];
  for (const [k, v] of Object.entries(obj)) if (!Object.hasOwn(out, k)) out[k] = v;
  return out;
}

const BY_ALIAS = new Map();
const BY_NAME = new Map();
for (const [id, [alias, name]] of Object.entries(CHAMPIONS)) {
  BY_ALIAS.set(alias.toLowerCase(), Number(id));
  BY_NAME.set(plain(name), Number(id));
  if (!BY_NAME.has(plain(alias))) BY_NAME.set(plain(alias), Number(id));
}

// { championId, alias, champion (English name) } for a numeric champion id, or null.
function championInfo(id) {
  const c = Object.hasOwn(CHAMPIONS, String(id)) ? CHAMPIONS[String(id)] : null;
  return c ? { championId: Number(id), alias: c[0], champion: c[1] } : null;
}

// A Live Client player's champion, from rawChampionName ("game_character_displayname_MonkeyKing").
// Older clients without it fall back to the English display name; a localized one is display only.
function liveChampion(p) {
  const m = /^game_character_displayname_(\w+)$/.exec(p.rawChampionName || '');
  const alias = m ? m[1] : null;
  let id = alias ? BY_ALIAS.get(alias.toLowerCase()) : undefined;
  if (id === undefined && !alias && p.championName) id = BY_NAME.get(plain(p.championName));
  return (id !== undefined && championInfo(id)) || { championId: null, alias, champion: alias || p.championName || null };
}

const clientChampion = (id, name) => championInfo(id) || { championId: num(id), alias: null, champion: name || null };

function role(value) {
  const r = String(value || '').toUpperCase();
  return ROLES.has(r) ? r : ROLE_ALIASES[r] || null;
}

// Match history's lane/role pair (BOTTOM + SUPPORT is the support).
function historyRole(t) {
  if (!t) return null;
  const lane = role(t.lane);
  return lane === 'BOTTOM' && /SUPPORT/i.test(String(t.role || '')) ? 'UTILITY' : lane;
}

function spellId(s) {
  const m = /^GeneratedTip_SummonerSpell_(\w+?)_DisplayName$/.exec((s && s.rawDisplayName) || '');
  return m && Object.hasOwn(SPELLS, m[1]) ? SPELLS[m[1]] : null;
}

const pair = (a, b) => (num(a) === null && num(b) === null ? null : [num(a), num(b)]);
const sevenItems = (list) => (Array.isArray(list) ? Array.from({ length: 7 }, (_, i) => num(list[i]) || 0) : null);

function nameKeys(p) {
  const keys = [p.riotId, p.riotIdGameName, p.summonerName].filter(Boolean).map(norm);
  for (const k of [...keys]) if (k.includes('#')) keys.push(k.split('#')[0]);
  return keys;
}

function riotIdParts(id) {
  const s = String(id || '');
  const i = s.lastIndexOf('#');
  return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s || null, null];
}

// ---------------------------------------------------------------- record shape

// Fills in every field a v1 record has, keeping what's there.
function normalize(record = {}) {
  const r = record || {};
  return {
    v: 1, key: null, gameId: null, platformId: null, queueId: null, queueName: null, gameMode: null, mapId: null, patch: null,
    startedAt: null, endedAt: null, duration: null, gameEndTime: null, result: null, surrender: null, statsFrom: null,
    me: null, rank: null, frames: null, favorite: false, createdAt: null, updatedAt: null,
    ...r,
    clock: { wallAt0: null, lcuOffset: null, ...(r.clock || {}) },
    teams: Array.isArray(r.teams) ? r.teams : [],
    participants: Array.isArray(r.participants) ? r.participants : [],
    events: Array.isArray(r.events) ? r.events : [],
    // map: the minimap recording; maps: more parts of it when it was split (an app restart or a
    // capture recovery in the middle of the match), oldest first.
    media: { full: [], map: null, maps: [], clips: [], ...(r.media || {}) },
    sources: { live: null, liveFinal: null, session: null, eog: null, history: null, timeline: null, lp: null, ranked: null, legacy: false, ...(r.sources || {}) },
    pending: Array.isArray(r.pending) ? r.pending : [],
    aliases: Array.isArray(r.aliases) ? r.aliases : [],
    prov: { ...(r.prov || {}) },
  };
}

// A new, empty v1 record. `fields` may set anything, e.g. { clock: { wallAt0 } }.
const blankRecord = (fields = {}) => normalize(clone(fields));

// The store key: "<platform>_<gameId>" once the game ID is known, else "local-<wall ms of game time 0>".
function keyOf(record) {
  const r = record || {};
  if (r.gameId && r.platformId) return `${String(r.platformId).toUpperCase()}_${r.gameId}`;
  const t = (r.clock && r.clock.wallAt0) || r.startedAt || r.createdAt;
  return Number.isFinite(t) ? `local-${Math.round(t)}` : null;
}

// ---------------------------------------------------------------- Live Client (in the game)

function meKeys(me, active) {
  const names = new Set();
  const add = (s) => {
    if (!s) return;
    const n = norm(s);
    names.add(n);
    if (n.includes('#')) names.add(n.split('#')[0]);
  };
  if (typeof me === 'string') add(me);
  else if (me && me.names) for (const n of me.names) add(n);
  else if (active) [active.riotId, active.riotIdGameName, active.summonerName].forEach(add);
  return names;
}

function liveParticipant(p, i) {
  const s = p.scores || {};
  const r = p.runes || {};
  const items = [0, 0, 0, 0, 0, 0, 0];
  for (const it of Array.isArray(p.items) ? p.items : []) {
    if (Number.isInteger(it.slot) && it.slot >= 0 && it.slot <= 6) items[it.slot] = num(it.itemID) || 0;
  }
  const [idName, idTag] = riotIdParts(p.riotId);
  const ss = p.summonerSpells || {};
  return {
    participantId: i + 1, // provisional (live order); match history's ids replace it on merge
    team: TEAM[p.team] || null,
    isMe: false,
    ...liveChampion(p),
    name: p.riotIdGameName || idName || p.summonerName || null,
    tag: p.riotIdTagLine || idTag || null,
    role: role(p.position),
    level: int(p.level),
    kills: int(s.kills),
    deaths: int(s.deaths),
    assists: int(s.assists),
    cs: int(s.creepScore),
    csApprox: true, // the Live Client floors CS to the nearest 10
    vision: int(s.wardScore),
    items,
    spells: pair(spellId(ss.summonerSpellOne), spellId(ss.summonerSpellTwo)),
    keystone: num(r.keystone && r.keystone.id),
    primaryStyle: num(r.primaryRuneTree && r.primaryRuneTree.id),
    subStyle: num(r.secondaryRuneTree && r.secondaryRuneTree.id),
    skinId: int(p.skinID),
  };
}

const killerKind = (name) => {
  const n = String(name || '');
  if (/^turret_/i.test(n)) return 'turret';
  if (/minion/i.test(n)) return 'minion';
  if (/^sru|baron|dragon|herald|horde|atakhan|monster/i.test(n)) return 'monster';
  return n ? 'other' : null;
};
// "Turret_TOrder_L2_P3_2253454213" -> "Turret_TOrder_L2_P3"; its owner (the team that lost it) -> 100.
const structureId = (s) => (s ? String(s).replace(/_\d{4,}$/, '') : null);
const structureTeam = (s) => (/_T(Order|1)_/i.test(s || '') ? 100 : /_T(Chaos|2)_/i.test(s || '') ? 200 : null);

// One Live Client event in record form: players become participant ids, nothing else about them
// is kept (no names in events).
function liveEvent(e, pid) {
  const ev = { t: round(num(Number(e.EventTime)) || 0, 3), name: String(e.EventName || '') };
  if (Number.isInteger(e.EventID)) ev.id = e.EventID;
  const assisters = () => (Array.isArray(e.Assisters) ? e.Assisters.map(pid).filter(Boolean) : []);
  switch (e.EventName) {
    case 'ChampionKill':
      ev.killer = pid(e.KillerName);
      ev.victim = pid(e.VictimName);
      ev.assisters = assisters();
      if (!ev.killer) ev.by = killerKind(e.KillerName);
      break;
    case 'Multikill':
      ev.killer = pid(e.KillerName);
      ev.streak = int(Number(e.KillStreak));
      break;
    case 'FirstBlood':
      ev.killer = pid(e.Recipient);
      break;
    case 'Ace':
      ev.killer = pid(e.Acer);
      ev.team = TEAM[e.AcingTeam] || null;
      break;
    case 'FirstBrick':
      ev.killer = pid(e.KillerName);
      break;
    case 'TurretKilled':
    case 'InhibKilled': {
      const s = e.TurretKilled || e.InhibKilled;
      ev.killer = pid(e.KillerName);
      ev.assisters = assisters();
      if (!ev.killer) ev.by = killerKind(e.KillerName);
      ev.structure = structureId(s);
      ev.team = structureTeam(s); // the team that lost it, as in the LCU timeline
      break;
    }
    case 'InhibRespawningSoon':
    case 'InhibRespawned':
      ev.structure = structureId(e.InhibRespawningSoon || e.InhibRespawned);
      break;
    case 'DragonKill':
    case 'HeraldKill':
    case 'BaronKill':
    case 'HordeKill':
    case 'AtakhanKill':
      ev.killer = pid(e.KillerName);
      ev.assisters = assisters();
      if (!ev.killer) ev.by = killerKind(e.KillerName);
      ev.stolen = String(e.Stolen).toLowerCase() === 'true';
      if (e.DragonType) ev.dragon = String(e.DragonType);
      break;
    case 'GameEnd':
      ev.result = e.Result === 'Win' ? 'Win' : e.Result === 'Lose' ? 'Lose' : null;
      break;
    default:
      break; // GameStart, MinionsSpawning and anything new: the name and time are enough
  }
  return ev;
}

// Team totals the game itself shows: kills, and objectives counted from the event feed.
function liveTeams(participants, events, myTeam, result) {
  const teamOf = new Map(participants.map((p) => [p.participantId, p.team]));
  const teams = [100, 200].map((teamId) => ({
    teamId,
    win: myTeam && (result === 'Win' || result === 'Lose') ? (teamId === myTeam) === (result === 'Win') : null,
    kills: sum(...participants.filter((p) => p.team === teamId).map((p) => p.kills)),
    dragons: 0, barons: 0, heralds: 0, grubs: 0, atakhans: 0, towers: 0, inhibs: 0,
  }));
  const counter = { DragonKill: 'dragons', BaronKill: 'barons', HeraldKill: 'heralds', HordeKill: 'grubs', AtakhanKill: 'atakhans', TurretKilled: 'towers', InhibKilled: 'inhibs' };
  for (const e of events) {
    const field = counter[e.name];
    if (!field) continue;
    const taker = e.name === 'TurretKilled' || e.name === 'InhibKilled' ? otherTeam(e.team) : teamOf.get(e.killer);
    const t = teams.find((x) => x.teamId === taker);
    if (t) t[field]++;
  }
  return teams;
}

// A Live Client allgamedata snapshot. `me` is optional: the watcher's identify() result
// ({ names, champion }), a Riot ID, or nothing (then activePlayer says who you are).
function fromLive(data, me, { final = false } = {}) {
  const d = data || {};
  const players = Array.isArray(d.allPlayers) ? d.allPlayers : [];
  const active = d.activePlayer && typeof d.activePlayer === 'object' && !d.activePlayer.errorCode ? d.activePlayer : null;
  const myNames = meKeys(me, active);
  const participants = players.map(liveParticipant);
  let mine = players.findIndex((p) => nameKeys(p).some((k) => myNames.has(k)));
  // Streamer mode can hide names; the champion still says who you are.
  if (mine < 0 && me && me.champion) {
    const hits = players.map((p, i) => (norm(p.championName) === norm(me.champion) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) [mine] = hits;
  }
  if (mine >= 0) participants[mine].isMe = true;

  // Event names are players' display names, or champions' in streamer mode.
  const byName = new Map();
  const byChampion = new Map();
  players.forEach((p, i) => {
    for (const k of nameKeys(p)) if (!byName.has(k)) byName.set(k, i + 1);
    for (const k of [norm(p.championName), norm(participants[i].alias), norm(participants[i].champion)]) {
      if (k && !byChampion.has(k)) byChampion.set(k, i + 1);
    }
  });
  let viaName = 0;
  let viaChampion = 0;
  const pid = (name) => {
    if (!name) return 0;
    const n = norm(name);
    const base = n.includes('#') ? n.split('#')[0] : n;
    if (byName.has(n) || byName.has(base)) { viaName++; return byName.get(n) || byName.get(base); }
    if (byChampion.has(n)) { viaChampion++; return byChampion.get(n); }
    return 0;
  };
  const raw = d.events && Array.isArray(d.events.Events) ? d.events.Events : [];
  const events = raw.map((e) => liveEvent(e, pid));
  const streamerMode = viaChampion > viaName;

  // Your moments, labelled exactly like the clips (league.js).
  const meRow = mine >= 0 ? participants[mine] : null;
  if (meRow) {
    const names = new Set(myNames);
    if (streamerMode) for (const k of [norm(players[mine].championName), norm(meRow.champion)]) if (k) names.add(k);
    raw.forEach((e, i) => {
      const ev = events[i];
      if (e.EventName === 'GameEnd') {
        if (!ev.result) return;
        const win = ev.result === 'Win';
        Object.assign(ev, { mine: true, type: win ? 'victory' : 'defeat', label: win ? 'Victory' : 'Defeat' });
        return;
      }
      const moment = classify(e, { names });
      if (moment) Object.assign(ev, { mine: true, type: moment.type, label: moment.label });
    });
  }
  // The biggest multikill of each player, from the feed (the end-of-game stats have it too).
  for (const e of events) {
    if (e.name !== 'Multikill' || !e.killer) continue;
    const p = participants[e.killer - 1];
    if (p) p.largestMultiKill = Math.max(p.largestMultiKill || 1, e.streak || 0);
  }
  for (const p of participants) if (p.largestMultiKill == null && num(p.kills) !== null) p.largestMultiKill = p.kills > 0 ? 1 : 0;

  const end = events.find((e) => e.name === 'GameEnd');
  const result = meRow && end ? end.result : null;
  const runes = active && active.fullRunes ? active.fullRunes : null;
  if (meRow && runes && Array.isArray(runes.generalRunes)) {
    const perks = runes.generalRunes.map((x) => num(x && x.id));
    if (perks.length && perks.every((x) => x !== null)) meRow.perks = perks;
  }
  const game = d.gameData || {};
  return {
    source: final ? 'live-final' : 'live',
    gameMode: game.gameMode || null,
    mapId: num(game.mapNumber),
    duration: end ? round(end.t) : round(num(game.gameTime)),
    gameEndTime: end ? end.t : null,
    result,
    streamerMode,
    participants,
    teams: liveTeams(participants, events, meRow && meRow.team, result),
    // You only: stat shards (the client's post-game data has none) and your skin.
    me: meRow ? {
      skinId: meRow.skinId,
      runes: runes ? { shards: Array.isArray(runes.statRunes) ? runes.statRunes.map((x) => num(x && x.id)) : null } : null,
    } : null,
    events,
  };
}

// ---------------------------------------------------------------- League client, after the game

function eogParticipant(p, i, teamId, isMe) {
  const s = p.stats || {};
  return {
    participantId: i + 1, // provisional (block order)
    team: teamId,
    isMe,
    ...clientChampion(p.championId, p.championName),
    name: p.riotIdGameName || null,
    tag: p.riotIdTagLine || null,
    role: role(p.selectedPosition) || role(p.detectedTeamPosition),
    level: int(s.LEVEL), // the player's root `level` is their account level
    kills: int(s.CHAMPIONS_KILLED),
    deaths: int(s.NUM_DEATHS),
    assists: int(s.ASSISTS),
    cs: sum(s.MINIONS_KILLED, s.NEUTRAL_MINIONS_KILLED),
    csApprox: false,
    gold: int(s.GOLD_EARNED),
    damage: int(s.TOTAL_DAMAGE_DEALT_TO_CHAMPIONS),
    damageTaken: int(s.TOTAL_DAMAGE_TAKEN),
    mitigated: int(s.TOTAL_DAMAGE_SELF_MITIGATED),
    heal: int(s.TOTAL_HEAL),
    shielded: int(s.TOTAL_DAMAGE_SHIELDED_ON_TEAMMATES),
    vision: int(s.VISION_SCORE),
    wardsPlaced: int(s.WARD_PLACED),
    wardsKilled: int(s.WARD_KILLED),
    controlWards: int(s.VISION_WARDS_BOUGHT_IN_GAME),
    ccTime: int(s.TIME_CCING_OTHERS),
    objectiveDamage: int(s.TOTAL_DAMAGE_DEALT_TO_OBJECTIVES),
    turretDamage: int(s.TOTAL_DAMAGE_DEALT_TO_TURRETS),
    largestMultiKill: int(s.LARGEST_MULTI_KILL),
    items: sevenItems(p.items),
    roleItem: int(s.ROLE_BOUND_ITEM),
    spells: pair(p.spell1Id, p.spell2Id),
    keystone: int(s.PERK0),
    primaryStyle: int(s.PERK_PRIMARY_STYLE),
    subStyle: int(s.PERK_SUB_STYLE),
    perks: [0, 1, 2, 3, 4, 5].every((n) => num(s[`PERK${n}`]) !== null) ? [0, 1, 2, 3, 4, 5].map((n) => s[`PERK${n}`]) : null,
    augments: nonZero([1, 2, 3, 4, 5, 6].map((n) => int(s[`PLAYER_AUGMENT_${n}`]) || 0)),
    placement: int(s.PLAYER_SUBTEAM_PLACEMENT) || null,
  };
}

// The end-of-game block (or the "gameclient-" variant, { gameId, queueId, ..., statsBlock }).
function fromEog(block) {
  let b = block || {};
  let queueId = null;
  if (b.statsBlock && typeof b.statsBlock === 'object') {
    queueId = num(b.queueId);
    if (!Array.isArray(b.statsBlock.teams)) {
      return { source: 'eog', gameId: num(b.gameId), queueId, gameMode: b.gameMode || null, participants: [], teams: [] };
    }
    b = { ...b.statsBlock, gameId: b.statsBlock.gameId || b.gameId, gameMode: b.statsBlock.gameMode || b.gameMode };
  }
  const teams = Array.isArray(b.teams) ? b.teams : [];
  const local = b.localPlayer || null;
  const rows = [];
  for (const t of teams) {
    for (const p of Array.isArray(t.players) ? t.players : []) {
      const isMe = p.isLocalPlayer === true || Boolean(local && local.puuid && p.puuid === local.puuid);
      rows.push({ p, row: eogParticipant(p, rows.length, num(t.teamId) || num(p.teamId), isMe) });
    }
  }
  const participants = rows.map((x) => x.row);
  if (!participants.some((x) => x.isMe) && local) {
    const hit = participants.find((x) => x.championId === num(local.championId) && x.team === num(local.teamId));
    if (hit) hit.isMe = true;
  }
  const stat = (key) => rows.some(({ p }) => p.stats && p.stats[key] === 1);
  const remake = b.gameEndedInEarlySurrender === true || stat('GAME_ENDED_IN_EARLY_SURRENDER');
  const meRow = participants.find((x) => x.isMe);
  const myTeam = meRow ? teams.find((t) => num(t.teamId) === meRow.team) : null;
  const ended = num(b.endOfGameTimestamp);
  const length = num(b.gameLength);
  return {
    source: 'eog',
    gameId: num(b.gameId),
    queueId,
    gameMode: b.gameMode || null,
    queueType: b.queueType || null,
    duration: round(length),
    endedAt: ended,
    startedAt: ended !== null && length !== null ? ended - length * 1000 : null,
    result: remake ? 'Remake' : myTeam ? (myTeam.isWinningTeam ? 'Win' : 'Lose') : null,
    remake,
    surrender: remake || stat('GAME_ENDED_IN_SURRENDER'),
    participants,
    // Only true team totals: the block's per-team turret counts are sums of player credits, so
    // towers come from the live feed or match history instead.
    teams: teams.map((t) => {
      const s = t.stats || {};
      return {
        teamId: num(t.teamId), win: remake ? null : Boolean(t.isWinningTeam),
        kills: int(s.CHAMPIONS_KILLED), gold: int(s.GOLD_EARNED), damage: int(s.TOTAL_DAMAGE_DEALT_TO_CHAMPIONS),
      };
    }),
  };
}

function historyParticipant(p, player) {
  const s = p.stats || {};
  return {
    participantId: num(p.participantId),
    team: num(p.teamId),
    isMe: false,
    ...clientChampion(p.championId, null),
    name: player.gameName || null,
    tag: player.tagLine || null,
    role: historyRole(p.timeline),
    level: int(s.champLevel),
    kills: int(s.kills),
    deaths: int(s.deaths),
    assists: int(s.assists),
    cs: sum(s.totalMinionsKilled, s.neutralMinionsKilled),
    csApprox: false,
    gold: int(s.goldEarned),
    goldSpent: int(s.goldSpent),
    damage: int(s.totalDamageDealtToChampions),
    damageTaken: int(s.totalDamageTaken),
    mitigated: int(s.damageSelfMitigated),
    heal: int(s.totalHeal),
    vision: int(s.visionScore),
    wardsPlaced: int(s.wardsPlaced),
    wardsKilled: int(s.wardsKilled),
    controlWards: int(s.visionWardsBoughtInGame),
    ccTime: int(s.timeCCingOthers),
    objectiveDamage: int(s.damageDealtToObjectives),
    turretDamage: int(s.damageDealtToTurrets),
    largestMultiKill: int(s.largestMultiKill),
    multikills: [s.doubleKills, s.tripleKills, s.quadraKills, s.pentaKills].every((v) => num(v) !== null)
      ? [s.doubleKills, s.tripleKills, s.quadraKills, s.pentaKills] : null,
    items: [0, 1, 2, 3, 4, 5, 6].every((n) => num(s[`item${n}`]) !== null) ? [0, 1, 2, 3, 4, 5, 6].map((n) => s[`item${n}`]) : null,
    roleItem: int(s.roleBoundItem),
    spells: pair(p.spell1Id, p.spell2Id),
    keystone: int(s.perk0),
    primaryStyle: int(s.perkPrimaryStyle),
    subStyle: int(s.perkSubStyle),
    perks: [0, 1, 2, 3, 4, 5].every((n) => num(s[`perk${n}`]) !== null) ? [0, 1, 2, 3, 4, 5].map((n) => s[`perk${n}`]) : null,
    augments: nonZero([1, 2, 3, 4, 5, 6].map((n) => int(s[`playerAugment${n}`]) || 0)),
    placement: int(s.subteamPlacement) || null,
  };
}

// Match history can answer before a game's stats are filled in (A4 §3.4): a usable game has
// levels for everyone and gold for someone.
function historyReady(game) {
  const ps = game && Array.isArray(game.participants) ? game.participants : [];
  return ps.length > 0 && ps.every((p) => p.stats && p.stats.champLevel > 0) && ps.some((p) => p.stats.goldEarned > 0);
}

// A match-history game: /games/{id} (all players) or one from the match list (only yours).
// `me` picks your line in a full game: { puuid } or { participantId }; without it, merge()
// finds you by team + champion.
function fromHistory(game, me) {
  const g = game || {};
  const identities = new Map((g.participantIdentities || []).map((x) => [x.participantId, (x && x.player) || {}]));
  const raw = Array.isArray(g.participants) ? g.participants : [];
  const participants = raw.map((p) => historyParticipant(p, identities.get(p.participantId) || {}));
  let mine = null;
  if (me && me.puuid) {
    const hit = (g.participantIdentities || []).find((x) => x && x.player && x.player.puuid === me.puuid);
    mine = hit ? hit.participantId : null;
  } else if (me && me.participantId) {
    mine = me.participantId;
  } else if (participants.length === 1) {
    mine = participants[0].participantId;
  }
  for (const p of participants) p.isMe = mine !== null && p.participantId === mine;
  const myStats = (raw.find((p) => p.participantId === mine) || {}).stats || null;
  const remake = raw.some((p) => p.stats && p.stats.gameEndedInEarlySurrender === true);
  let duration = num(g.gameDuration);
  if (duration !== null && duration > 36000) duration = Math.round(duration / 1000); // a value in ms
  const created = num(g.gameCreation);
  const version = /^(\d+)\.(\d+)/.exec(g.gameVersion || '');
  const full = participants.length > 1;
  const teams = (Array.isArray(g.teams) ? g.teams : []).map((t) => {
    const mates = participants.filter((p) => p.team === num(t.teamId));
    return {
      teamId: num(t.teamId),
      win: remake ? null : t.win === 'Win' ? true : t.win === 'Fail' ? false : null,
      kills: full ? sum(...mates.map((p) => p.kills)) : null,
      gold: full ? sum(...mates.map((p) => p.gold)) : null,
      damage: full ? sum(...mates.map((p) => p.damage)) : null,
      dragons: int(t.dragonKills), barons: int(t.baronKills), heralds: int(t.riftHeraldKills), grubs: int(t.hordeKills),
      towers: int(t.towerKills), inhibs: int(t.inhibitorKills),
      bans: Array.isArray(t.bans) ? t.bans.map((b) => num(b && b.championId)).filter((id) => id > 0) : null,
    };
  });
  return {
    source: 'history',
    empty: !historyReady(g),
    gameId: num(g.gameId),
    platformId: g.platformId || null,
    queueId: num(g.queueId),
    gameMode: g.gameMode || null,
    mapId: num(g.mapId),
    patch: version ? `${version[1]}.${version[2]}` : null,
    duration,
    startedAt: created,
    endedAt: created !== null && duration !== null ? created + duration * 1000 : null,
    result: remake ? 'Remake' : myStats ? (myStats.win ? 'Win' : 'Lose') : null,
    remake,
    surrender: remake || raw.some((p) => p.stats && p.stats.gameEndedInSurrender === true),
    participants,
    teams,
  };
}

// The per-minute timeline. `game` (the /games/{id} answer) tells whose participant ids these are.
function fromTimeline(timeline, game) {
  const frames = timeline && Array.isArray(timeline.frames) ? timeline.frames : [];
  const series = { totalGold: {}, xp: {}, level: {}, cs: {}, pos: {} };
  frames.forEach((f, i) => {
    for (const [key, pf] of Object.entries((f && f.participantFrames) || {})) {
      const id = String(num(pf && pf.participantId) || key);
      const put = (name, value) => { (series[name][id] = series[name][id] || [])[i] = value; };
      put('totalGold', int(pf.totalGold));
      put('xp', int(pf.xp));
      put('level', int(pf.level));
      put('cs', sum(pf.minionsKilled, pf.jungleMinionsKilled));
      put('pos', pf.position ? [int(pf.position.x), int(pf.position.y)] : null);
    }
  });
  const gaps = frames.slice(1).map((f, i) => num(f.timestamp) - num(frames[i].timestamp)).filter((g) => g > 0);
  // The last frame is a partial minute, so the typical gap is the interval (60 s).
  const interval = gaps.length > 1 ? Math.round(median(gaps.slice(0, -1)) / 1000) : gaps.length ? 60 : null;
  const events = [];
  for (const f of frames) {
    for (const e of Array.isArray(f && f.events) ? f.events : []) {
      if (!['CHAMPION_KILL', 'ELITE_MONSTER_KILL', 'BUILDING_KILL'].includes(e.type)) continue;
      events.push({
        t: round(num(e.timestamp) / 1000, 3),
        type: e.type,
        killer: int(e.killerId) || 0,
        victim: int(e.victimId) || 0,
        assisters: Array.isArray(e.assistingParticipantIds) ? e.assistingParticipantIds.map(int).filter(Boolean) : [],
        pos: e.position ? [int(e.position.x), int(e.position.y)] : null,
        monster: e.monsterType || null,
        sub: e.monsterSubType || null,
        building: e.buildingType || null,
        tower: e.towerType || null,
        lane: e.laneType || null,
        team: int(e.teamId) || null, // BUILDING_KILL: the team that lost it
      });
    }
  }
  const participants = game && Array.isArray(game.participants)
    ? game.participants.map((p) => ({ participantId: num(p.participantId), team: num(p.teamId), ...clientChampion(p.championId, null) }))
    : null;
  return {
    source: 'timeline',
    participants,
    frames: frames.length ? { interval, ...series } : null,
    timelineEvents: events,
  };
}

function rankEntry(tier, division, lp) {
  const t = String(tier || '').toUpperCase();
  if (!TIERS.includes(t)) return null; // unranked or in placements
  return { tier: t, division: APEX.has(t) ? null : DIVISIONS.includes(division) ? division : null, lp: int(lp) };
}

// LP as one number, so changes across divisions and tiers add up (100 LP per division).
function lpValue(e) {
  if (!e || e.lp === null) return null;
  const tier = TIERS.indexOf(e.tier);
  if (APEX.has(e.tier)) return TIERS.indexOf('MASTER') * 400 + e.lp;
  const div = DIVISIONS.indexOf(e.division);
  return tier < 0 || div < 0 ? null : tier * 400 + div * 100 + e.lp;
}

// /lol-ranked/v1/current-lp-change-notification (only readable on the end-of-game screen).
function fromLp(n) {
  const x = n || {};
  const after = rankEntry(x.tier, x.division, x.leaguePoints);
  return {
    source: 'lp',
    gameId: num(x.gameId),
    rank: { queueType: x.queueType || null, after, lpDelta: after ? int(x.leaguePointsDelta) : null, source: 'lp-notification' },
  };
}

// /lol-ranked/v1/current-ranked-stats, as the rank before or after the match.
function fromRanked(stats, { queueType = 'RANKED_SOLO_5x5', when = 'before' } = {}) {
  const s = stats || {};
  const q = (s.queueMap && s.queueMap[queueType]) || (Array.isArray(s.queues) ? s.queues.find((x) => x && x.queueType === queueType) : null);
  const entry = q && !q.isProvisional ? rankEntry(q.tier, q.division, q.leaguePoints) : null;
  return { source: 'ranked', rank: { queueType, [when === 'after' ? 'after' : 'before']: entry } };
}

// /lol-gameflow/v1/session: the gameId and queue, mid-game. Nothing else (it carries secrets).
function fromSession(session) {
  const s = session || {};
  const gd = s.gameData || {};
  const q = gd.queue || {};
  return {
    source: 'session',
    gameId: num(gd.gameId) || null,
    queueId: num(q.id),
    gameMode: q.gameMode || (s.map && s.map.gameMode) || null,
    mapId: num(q.mapId) || num(s.map && s.map.id),
    platformId: (s.map && s.map.platformId) || null,
  };
}

// ---------------------------------------------------------------- merge

const rankOf = (src, field) => {
  const table = field && FIELD_RANK[field];
  if (table && Object.hasOwn(table, src)) return table[src];
  return Object.hasOwn(RANK, src) ? RANK[src] : -1;
};

// Pairs incoming participant rows with the record's: by participant id (when both are match
// history's), then team + champion (champion alone for a row with no team), then team + alias,
// then order within the team.
// Returns, for each incoming row, the index of its record row or -1.
function align(targets, incoming, byId) {
  const out = incoming.map(() => -1);
  const used = new Set();
  const pass = (same) => incoming.forEach((x, i) => {
    if (out[i] >= 0) return;
    const hits = targets.map((t, j) => j).filter((j) => !used.has(j) && same(targets[j], x));
    if (hits.length === 1) { out[i] = hits[0]; used.add(hits[0]); }
  });
  if (byId) pass((t, x) => x.participantId != null && t.participantId === x.participantId);
  pass((t, x) => x.championId != null && t.championId === x.championId && t.team === x.team);
  // A backfilled match knows your champion but not your team: the champion alone (unique in a
  // normal game; a repeated one, as in One for All, stays unpaired here).
  pass((t, x) => t.team == null && x.championId != null && t.championId === x.championId);
  pass((t, x) => Boolean(x.alias && t.alias) && t.alias.toLowerCase() === x.alias.toLowerCase() && t.team === x.team);
  for (const team of new Set(incoming.map((x) => x.team))) {
    const xs = incoming.map((x, i) => i).filter((i) => out[i] < 0 && incoming[i].team === team);
    const ts = targets.map((t, j) => j).filter((j) => !used.has(j) && targets[j].team === team);
    xs.forEach((i, k) => { if (k < ts.length) { out[i] = ts[k]; used.add(ts[k]); } });
  }
  return out;
}

const mapPid = (map) => (pid) => (map.has(pid) ? map.get(pid) : pid);

function remapEvents(events, f) {
  for (const e of events) {
    if (e.killer) e.killer = f(e.killer);
    if (e.victim) e.victim = f(e.victim);
    if (Array.isArray(e.assisters)) e.assisters = e.assisters.map(f);
  }
}

function remapFrames(frames, f) {
  if (!frames) return frames;
  const out = { ...frames };
  for (const name of ['totalGold', 'xp', 'level', 'cs', 'pos']) {
    if (!frames[name]) continue;
    out[name] = {};
    for (const [k, v] of Object.entries(frames[name])) out[name][String(f(Number(k)))] = v;
  }
  return out;
}

// Copies values from a source row: a gap is always filled, a value is replaced only by a source
// at least as good as the row's best so far.
function assign(row, incoming, src) {
  const upgrade = row.src == null || rankOf(src) >= rankOf(row.src);
  const fillOnly = FILL_ONLY[src];
  for (const [k, v] of Object.entries(incoming)) {
    if (v == null || ROW_SKIP.has(k)) continue;
    if (row[k] == null || (upgrade && !(fillOnly && fillOnly.has(k)))) row[k] = clone(v);
  }
  if (upgrade) row.src = src;
}

const meOf = (r) => r.participants.find((p) => p.isMe) || null;

// Checks a partial against the record before it's used. Returns { ok, reason, partial, mismatches };
// `partial` is a copy with your line marked (found by team + champion when the source can't say).
function check(r, input) {
  const p = clone(input);
  const mismatches = [];
  if (p.empty) return { ok: false, reason: 'empty' };
  if (r.gameId && p.gameId && r.gameId !== p.gameId) return { ok: false, reason: 'gameId' };
  // Records without a scoreboard (legacy ones) still know your champion and K/D/A.
  const mine = meOf(r) || (r.me && (r.me.championId != null || r.me.alias) ? {
    team: r.me.team, championId: r.me.championId, alias: r.me.alias, kills: r.me.kills, deaths: r.me.deaths, assists: r.me.assists,
  } : null);
  const rows = Array.isArray(p.participants) ? p.participants : [];
  // Champions compare by id, or by alias when an id is missing (a champion newer than our table).
  const comparable = (a, b) => (a.championId != null && b.championId != null) || Boolean(a.alias && b.alias);
  const sameChampion = (a, b) => (a.championId != null && b.championId != null
    ? a.championId === b.championId
    : Boolean(a.alias && b.alias) && a.alias.toLowerCase() === b.alias.toLowerCase());
  const sameTeam = (a, b) => a.team == null || b.team == null || a.team === b.team;
  // The record has a scoreboard but doesn't know you yet: your champion must be on it.
  const claimed = rows.find((x) => x.isMe);
  if (!mine && claimed && r.participants.length > 1 && !r.participants.some((x) => sameChampion(x, claimed) && sameTeam(x, claimed))) {
    return { ok: false, reason: 'champion' };
  }
  if (mine && rows.length) {
    let theirs = claimed;
    if (theirs) {
      if (comparable(mine, theirs) && !sameChampion(mine, theirs)) return { ok: false, reason: 'champion' };
    } else if (mine.championId != null || mine.alias) {
      const hits = rows.filter((x) => sameChampion(mine, x) && sameTeam(mine, x));
      if (hits.length === 1) [theirs] = hits;
      else if (rows.length > 1 && !hits.length) return { ok: false, reason: 'champion' }; // not your game
      if (theirs) theirs.isMe = true;
    }
    if (theirs && theirs.isMe) {
      if (p.result == null && !p.remake && Array.isArray(p.teams)) {
        const team = p.teams.find((t) => t.teamId === theirs.team);
        if (team && typeof team.win === 'boolean') p.result = team.win ? 'Win' : 'Lose';
      }
      const kda = (x) => [x.kills, x.deaths, x.assists];
      // A scoreboard read during the match (src 'live': at the start, or when ClipVault restarted
      // mid-match) is the score so far, not a different one, so the final score isn't a mismatch.
      if (p.source !== 'live' && mine.src !== 'live' && kda(mine).every((v) => v != null) && kda(theirs).every((v) => v != null)
        && kda(mine).some((v, i) => v !== kda(theirs)[i])) {
        mismatches.push({ source: p.source, field: 'kda', ours: kda(mine), theirs: kda(theirs) });
      }
    }
  }
  const finalDuration = r.prov.duration && r.prov.duration !== 'live';
  if (finalDuration && p.source !== 'live' && num(r.duration) !== null && num(p.duration) !== null && Math.abs(r.duration - p.duration) > 30) {
    mismatches.push({ source: p.source, field: 'duration', ours: r.duration, theirs: p.duration });
  }
  return { ok: true, partial: p, mismatches };
}

// Your moments in events built from the timeline (no live feed), labelled like the clips.
function timelineMoment(e, me) {
  if (!me) return null;
  const involved = e.killer === me || (e.assisters || []).includes(me);
  switch (e.name) {
    case 'ChampionKill':
      if (e.killer === me) return ['kill', 'Kill'];
      if (e.victim === me) return ['death', 'Death'];
      return involved ? ['assist', 'Assist'] : null;
    case 'DragonKill':
      if (!involved) return null;
      return [e.dragon === 'Elder' ? 'elder' : 'dragon', dragonName(e.dragon)];
    case 'BaronKill': return involved ? ['baron', 'Baron Nashor'] : null;
    case 'HeraldKill': return involved ? ['herald', 'Rift Herald'] : null;
    case 'HordeKill': return involved ? ['grubs', 'Voidgrubs'] : null;
    case 'AtakhanKill': return involved ? ['atakhan', 'Atakhan'] : null;
    case 'TurretKilled': return involved ? ['turret', 'Turret'] : null;
    case 'InhibKilled': return involved ? ['inhib', 'Inhibitor'] : null;
    default: return null;
  }
}

// Back from a record event built from the timeline to the timeline's form (to pair it again).
function eventToTimeline(e) {
  const monster = Object.keys(MONSTER_EVENTS).find((k) => MONSTER_EVENTS[k] === e.name);
  const building = Object.keys(BUILDING_EVENTS).find((k) => BUILDING_EVENTS[k] === e.name);
  const sub = Object.keys(DRAGONS).find((k) => DRAGONS[k] === e.dragon) || null;
  if (e.name === 'ChampionKill') return { type: 'CHAMPION_KILL', t: e.t, killer: e.killer, victim: e.victim, assisters: e.assisters || [], pos: e.pos };
  if (monster) return { type: 'ELITE_MONSTER_KILL', t: e.t, killer: e.killer, assisters: e.assisters || [], monster, sub, pos: e.pos };
  if (building) return { type: 'BUILDING_KILL', t: e.t, killer: e.killer, assisters: e.assisters || [], building, team: e.team, pos: e.pos };
  return null;
}

function timelineToEvent(e) {
  const ev = { t: e.t, name: '', killer: e.killer, assisters: e.assisters, pos: e.pos, src: 'timeline' };
  if (e.type === 'CHAMPION_KILL') Object.assign(ev, { name: 'ChampionKill', victim: e.victim });
  else if (e.type === 'ELITE_MONSTER_KILL') {
    ev.name = MONSTER_EVENTS[e.monster] || 'MonsterKill';
    if (DRAGONS[e.sub]) ev.dragon = DRAGONS[e.sub];
  } else Object.assign(ev, { name: BUILDING_EVENTS[e.building] || 'BuildingKill', team: e.team });
  return ev;
}

// Positions (and the LCU-vs-live clock residual) from the timeline onto the live events, or the
// timeline's own events when there was no live feed.
function applyTimeline(r, tlEvents, src) {
  const kills = tlEvents.filter((e) => e.type === 'CHAMPION_KILL');
  const liveKills = r.events.filter((e) => e.name === 'ChampionKill' && e.src !== 'timeline');
  if (r.prov.events !== 'live' && r.prov.events !== 'live-final') {
    const fromTl = tlEvents.map(timelineToEvent); // derive() labels your moments among them
    const kept = r.events.filter((e) => e.src !== 'timeline' && !TIMELINE_KINDS.has(e.type));
    r.events = [...kept, ...fromTl].sort((a, b) => a.t - b.t);
    r.prov.events = src;
    return;
  }
  // Clock residual: pair each LCU kill with the live kill of the same killer and victim within ±2 s.
  const residuals = [];
  const taken = new Set();
  for (const k of kills) {
    let best = null;
    for (const e of liveKills) {
      if (taken.has(e) || e.killer !== k.killer || e.victim !== k.victim) continue;
      const gap = Math.abs(e.t - k.t);
      if (gap <= 2 && (!best || gap < Math.abs(best.t - k.t))) best = e;
    }
    if (!best) continue;
    taken.add(best);
    residuals.push(k.t - best.t);
    if (k.pos) best.pos = k.pos;
  }
  if (residuals.length) r.clock.lcuOffset = round(median(residuals), 3);
  const offset = r.clock.lcuOffset || 0;
  for (const k of tlEvents) {
    if (k.type === 'CHAMPION_KILL' || !k.pos) continue;
    const name = k.type === 'ELITE_MONSTER_KILL' ? MONSTER_EVENTS[k.monster] : BUILDING_EVENTS[k.building];
    const hit = r.events.find((e) => e.name === name && !e.pos && Math.abs(e.t - (k.t - offset)) <= 2
      && (k.type !== 'BUILDING_KILL' || e.team == null || k.team == null || e.team === k.team));
    if (hit) hit.pos = k.pos;
  }
}

// Takes over match history's participant ids when the source covers every row of the record:
// the record's rows, events and frames are renumbered together.
function adoptIds(r, incoming, idx) {
  const covered = new Set(idx.filter((j) => j >= 0));
  const complete = covered.size === r.participants.length
    && new Set(incoming.map((x) => x.participantId)).size === incoming.length && incoming.every((x) => x.participantId > 0);
  if (!complete) return false;
  const map = new Map();
  idx.forEach((j, i) => { if (j >= 0) map.set(r.participants[j].participantId, incoming[i].participantId); });
  const f = mapPid(map);
  for (const row of r.participants) row.participantId = f(row.participantId);
  remapEvents(r.events, f);
  r.frames = remapFrames(r.frames, f);
  if (r.me && r.me.participantId) r.me.participantId = f(r.me.participantId);
  r.prov.ids = 'history';
  return true;
}

function applyPartial(r, p, now) {
  const src = p.source;
  for (const field of IDENTITY_FIELDS) if (r[field] == null && p[field] != null) r[field] = p[field];
  for (const field of GAME_FIELDS) {
    if (p[field] == null) continue;
    if (r[field] == null || rankOf(src, field) >= rankOf(r.prov[field], field)) {
      r[field] = p[field];
      r.prov[field] = src;
    }
  }
  if (STAT_SOURCES.has(src) && (r.statsFrom == null || rankOf(src) >= rankOf(r.statsFrom))) r.statsFrom = src;

  // Participants, and how this source's participant ids map onto the record's.
  let translate = (pid) => pid;
  const incoming = Array.isArray(p.participants) ? p.participants : [];
  const realIds = src === 'history' || src === 'timeline';
  if (incoming.length) {
    if (!r.participants.length && src !== 'timeline') {
      r.participants = incoming.map((x) => ({ ...clone(x), src }));
      if (realIds) r.prov.ids = 'history';
    } else if (r.participants.length) {
      const idx = align(r.participants, incoming, realIds && r.prov.ids === 'history');
      if (realIds && r.prov.ids !== 'history') adoptIds(r, incoming, idx);
      const map = new Map();
      incoming.forEach((x, i) => {
        if (idx[i] >= 0) {
          const row = r.participants[idx[i]];
          map.set(x.participantId, row.participantId);
          if (src !== 'timeline') {
            assign(row, x, src);
            if (x.isMe) for (const other of r.participants) other.isMe = other === row;
          }
        } else if (src !== 'timeline') {
          const free = Math.max(0, ...r.participants.map((o) => o.participantId || 0)) + 1;
          const row = { ...clone(x), participantId: realIds ? x.participantId : free, src };
          if (r.participants.some((o) => o.participantId === row.participantId)) row.participantId = free;
          r.participants.push(row);
          map.set(x.participantId, row.participantId);
        }
      });
      translate = mapPid(map);
    }
  }

  // Teams, by team id.
  for (const t of Array.isArray(p.teams) ? p.teams : []) {
    if (t.teamId == null) continue;
    let row = r.teams.find((x) => x.teamId === t.teamId);
    if (!row) { row = { teamId: t.teamId }; r.teams.push(row); }
    assign(row, t, src);
  }
  r.teams.sort((a, b) => a.teamId - b.teamId);

  // You-only extras from the game (stat shards, skin).
  if (p.me) {
    r.me = r.me || {};
    if (p.me.skinId != null && r.me.skinId == null) r.me.skinId = p.me.skinId;
    if (p.me.runes && Array.isArray(p.me.runes.shards) && p.me.runes.shards.every((x) => x !== null)) {
      r.me.runes = { ...(r.me.runes || {}), shards: p.me.runes.shards };
    }
  }

  // The live event feed: the newest, most complete copy wins; timeline positions are kept, and
  // events that came from the timeline (it arrived first) are paired onto the feed again.
  if (Array.isArray(p.events) && p.events.length && Object.hasOwn(EVENT_RANK, src)) {
    const current = Object.hasOwn(EVENT_RANK, r.prov.events) ? EVENT_RANK[r.prov.events] : -1;
    const feed = r.prov.events === 'timeline' ? [] : r.events.filter((e) => e.src !== 'timeline');
    if (EVENT_RANK[src] >= current && p.events.length >= feed.length) {
      const fromTimeline = r.events.filter((e) => e.src === 'timeline').map(eventToTimeline).filter(Boolean);
      const pos = new Map(r.events.filter((e) => e.pos && e.src !== 'timeline').map((e) => [`${e.name}@${e.t}`, e.pos]));
      const events = clone(p.events);
      remapEvents(events, translate);
      for (const e of events) if (!e.pos && pos.has(`${e.name}@${e.t}`)) e.pos = pos.get(`${e.name}@${e.t}`);
      r.events = events;
      r.prov.events = src;
      if (fromTimeline.length && src !== 'legacy') applyTimeline(r, fromTimeline, 'timeline');
    }
  }

  if (src === 'timeline') {
    if (p.frames) {
      const frames = clone(p.frames);
      r.frames = remapFrames(frames, translate);
    }
    const tl = clone(p.timelineEvents || []);
    remapEvents(tl, translate);
    applyTimeline(r, tl, src);
  }

  if (src === 'lp' && p.rank) {
    const before = r.rank && r.rank.before ? r.rank.before : null;
    r.rank = { ...(r.rank || {}), ...clone(p.rank), before };
  }
  if (src === 'ranked' && p.rank) {
    const next = { ...(r.rank || {}) };
    if (!next.queueType) next.queueType = p.rank.queueType;
    if (next.queueType === p.rank.queueType) {
      if (Object.hasOwn(p.rank, 'before')) next.before = p.rank.before;
      if (Object.hasOwn(p.rank, 'after') && (!next.after || next.source !== 'lp-notification')) next.after = p.rank.after;
      // Without the end-of-game notification, the change is after minus before, when both are known.
      if (next.source !== 'lp-notification' && next.before && next.after) {
        const a = lpValue(next.after);
        const b = lpValue(next.before);
        if (a !== null && b !== null) { next.lpDelta = a - b; next.source = 'ranked-stats'; }
      }
      if (next.lpDelta === undefined) next.lpDelta = null;
      r.rank = next;
    }
  }

  const key = SOURCE_KEY[src];
  if (key) r.sources[key] = key === 'legacy' ? true : new Date(now).toISOString();
  const done = { eog: 'eog', history: 'history', timeline: 'timeline', lp: 'lp' }[src];
  r.pending = r.pending.filter((x) => x !== done && !(x === 'gameId' && r.gameId));
}

// Folds partials into a record. A partial is refused (and listed) when it is for another game:
// a different gameId, or your champion doesn't match. K/D/A and duration disagreements are
// listed in `mismatches` for the log; the better source still wins.
// Returns { record, applied: [source], refused: [{ source, reason }], mismatches: [...] }.
function merge(record, partials, { now = Date.now() } = {}) {
  let r = normalize(clone(record) || {});
  const out = { record: null, applied: [], refused: [], mismatches: [] };
  const list = [].concat(partials || []).filter((p) => p && typeof p === 'object' && Object.hasOwn(RANK, p.source));
  // Weakest first: what the video recorded (the live feed) anchors who you are.
  list.sort((a, b) => APPLY_ORDER.indexOf(a.source) - APPLY_ORDER.indexOf(b.source));
  for (const input of list) {
    const res = check(r, input);
    if (!res.ok) { out.refused.push({ source: input.source, reason: res.reason }); continue; }
    out.mismatches.push(...res.mismatches);
    applyPartial(r, res.partial, now);
    out.applied.push(input.source);
  }
  r = derive(r);
  out.record = r;
  return out;
}

// ---------------------------------------------------------------- derived values

// KDA, kill participation, CS/min, gold/min, damage/min, damage share and team totals; the start
// and end time from the live clock when there is one. Returns a new record.
function derive(record) {
  const r = normalize(clone(record) || {});
  r.participants = r.participants.map((p) => ({ ...ordered(p, PARTICIPANT_FIELDS), isMe: Boolean(p.isMe) }))
    .sort((a, b) => (a.participantId || 0) - (b.participantId || 0));
  for (const team of [...new Set(r.participants.map((p) => p.team).filter((t) => t != null))]) {
    if (!r.teams.some((t) => t.teamId === team)) r.teams.push({ teamId: team });
  }
  r.teams = r.teams.map((t) => ordered(t, TEAM_FIELDS)).sort((a, b) => a.teamId - b.teamId);
  if (r.rank) r.rank = ordered(r.rank, RANK_FIELDS);
  for (const t of r.teams) {
    const mates = r.participants.filter((p) => p.team === t.teamId);
    if (mates.length > 1) {
      if (t.kills == null) t.kills = sum(...mates.map((p) => p.kills));
      if (t.damage == null) t.damage = sum(...mates.map((p) => p.damage));
      if (t.gold == null) t.gold = sum(...mates.map((p) => p.gold));
    }
  }
  if (r.clock.wallAt0) {
    r.startedAt = r.clock.wallAt0;
    const end = num(r.gameEndTime) !== null ? r.gameEndTime : r.duration;
    if (num(end) !== null) r.endedAt = Math.round(r.clock.wallAt0 + end * 1000);
  }
  if (r.queueId != null && Object.hasOwn(QUEUES, r.queueId)) r.queueName = QUEUES[r.queueId];

  const row = meOf(r);
  // Events built from the timeline are labelled once it's known who you are.
  for (const e of r.events) {
    if (e.src !== 'timeline') continue;
    const m = timelineMoment(e, row && row.participantId);
    if (m) {
      Object.assign(e, { mine: true, type: m[0], label: m[1] });
    } else {
      delete e.mine;
      delete e.type;
      delete e.label;
    }
  }
  // A source that gave team results before it was known which team is yours (match history
  // without a hint) still decides the result, by its rank.
  const myTeam = row ? r.teams.find((t) => t.teamId === row.team) : null;
  if (myTeam && typeof myTeam.win === 'boolean' && r.result !== 'Remake' && myTeam.src
    && (r.result == null || rankOf(myTeam.src, 'result') >= rankOf(r.prov.result, 'result'))) {
    r.result = myTeam.win ? 'Win' : 'Lose';
    r.prov.result = myTeam.src;
  }
  const base = row || r.me;
  if (base) {
    const prev = r.me || {};
    const team = r.teams.find((t) => t.teamId === base.team) || {};
    const minutes = num(r.duration) > 0 ? r.duration / 60 : null;
    const pick = (k) => (row && row[k] != null ? row[k] : prev[k] != null ? prev[k] : null);
    const k = pick('kills');
    const d = pick('deaths');
    const a = pick('assists');
    const cs = pick('cs');
    const gold = pick('gold');
    const damage = pick('damage');
    const perks = pick('perks') || (pick('keystone') != null ? [pick('keystone')] : null);
    r.me = {
      participantId: pick('participantId'), team: pick('team'), championId: pick('championId'), champion: pick('champion'),
      alias: pick('alias'), skinId: prev.skinId != null ? prev.skinId : pick('skinId'), role: pick('role'), level: pick('level'),
      kills: k, deaths: d, assists: a,
      kda: k !== null && d !== null && a !== null ? round((k + a) / Math.max(1, d), 2) : null,
      kp: k !== null && a !== null && team.kills > 0 ? round(Math.min(1, (k + a) / team.kills), 2) : null,
      cs, csApprox: Boolean(pick('csApprox')), csPerMin: cs !== null && minutes ? round(cs / minutes, 1) : null,
      gold, goldPerMin: gold !== null && minutes ? Math.round(gold / minutes) : null,
      damage, damagePerMin: damage !== null && minutes ? Math.round(damage / minutes) : null,
      damageShare: damage !== null && team.damage > 0 ? round(damage / team.damage, 2) : null,
      damageTaken: pick('damageTaken'), mitigated: pick('mitigated'), heal: pick('heal'), shielded: pick('shielded'),
      vision: pick('vision'), wardsPlaced: pick('wardsPlaced'), wardsKilled: pick('wardsKilled'), controlWards: pick('controlWards'),
      ccTime: pick('ccTime'), objectiveDamage: pick('objectiveDamage'), turretDamage: pick('turretDamage'),
      largestMultiKill: pick('largestMultiKill'), multikills: pick('multikills'),
      items: pick('items'), roleItem: pick('roleItem'), spells: pick('spells'),
      runes: {
        primary: pick('primaryStyle') != null ? pick('primaryStyle') : (prev.runes && prev.runes.primary) || null,
        sub: pick('subStyle') != null ? pick('subStyle') : (prev.runes && prev.runes.sub) || null,
        perks: perks || (prev.runes && prev.runes.perks) || null,
        shards: (prev.runes && prev.runes.shards) || null,
      },
    };
  }
  return r;
}

// The match list's row (P1 §2.3).
function rowOf(record) {
  const r = normalize(record);
  const me = r.me || {};
  const runes = me.runes || {};
  const v = (x) => (x === undefined ? null : x);
  const row = {
    v: r.v, key: r.key, gameId: r.gameId, platformId: r.platformId, startedAt: r.startedAt, duration: r.duration,
    queueId: r.queueId, queueName: r.queueName, gameMode: r.gameMode, mapId: r.mapId,
    championId: v(me.championId), champion: v(me.champion), role: v(me.role), level: v(me.level), result: r.result,
    k: v(me.kills), d: v(me.deaths), a: v(me.assists), kda: v(me.kda), cs: v(me.cs), csApprox: Boolean(me.csApprox),
    csPerMin: v(me.csPerMin), damage: v(me.damage), damageShare: v(me.damageShare), gold: v(me.gold), goldPerMin: v(me.goldPerMin),
    vision: v(me.vision), kp: v(me.kp), lpDelta: r.rank && r.rank.lpDelta != null ? r.rank.lpDelta : null,
    items: Array.isArray(me.items) ? me.items : [], spells: Array.isArray(me.spells) ? me.spells : [],
    keystone: runes.perks && runes.perks[0] != null ? runes.perks[0] : null, subStyle: v(runes.sub),
    clips: r.media.clips.length, hasFull: r.media.full.length > 0, hasMap: Boolean(r.media.map), favorite: Boolean(r.favorite),
    pending: [...r.pending], legacy: Boolean(r.sources.legacy), updatedAt: r.updatedAt,
  };
  if (r.aliases.length) row.aliases = [...r.aliases]; // former keys, so old links still resolve
  return row;
}

// ---------------------------------------------------------------- one match, one record

// Two records can describe one match: the app restarted in the middle of it (the record from
// before the restart, the one after, and the backfill of the minimap the restart left behind), or
// a record was keyed by its game ID while another still had its local key.

// When the game started (wall ms of game time 0, else the record's start) and ended, or null.
const startOf = (r) => (num(r.clock && r.clock.wallAt0) !== null ? r.clock.wallAt0 : num(r.startedAt));
function endOf(r) {
  if (num(r.endedAt) !== null) return r.endedAt;
  const s = startOf(r);
  return s !== null && num(r.duration) !== null && r.duration > 0 ? s + r.duration * 1000 : null;
}
function myRow(r) {
  return (r.participants || []).find((p) => p && p.isMe) || null;
}
function myChampion(r) {
  const me = r.me || myRow(r) || {};
  const id = me.championId != null && Number.isFinite(Number(me.championId)) ? Number(me.championId) : null;
  const info = id !== null ? championInfo(id) : null;
  const name = plain(me.champion || (info && info.champion) || '') || null;
  return id !== null || name ? { id, name } : null;
}
const sameChampion = (a, b) => Boolean(a && b && (a.id !== null && b.id !== null ? a.id === b.id : a.name && b.name && a.name === b.name));
const myName = (r) => { const p = myRow(r); return p && p.name ? norm(p.name) : null; };
// The platform a record really knows (not the EUW1 guessed when nothing said).
const knownPlatform = (r) => (r.platformId && r.prov.platformId !== 'fallback' ? String(r.platformId).toUpperCase() : null);

// Whether two records are the same match: 'id' (the same game ID), 'time' (no game ID on one of
// them: your champion, your name and the mode agree, and they started within `windowMs` of each
// other, or one without an end started while the other ran), or null. Records with different
// game IDs, champions, names or platforms are never the same match.
function sameGame(a, b, { windowMs = 3 * 60 * 1000 } = {}) {
  const A = normalize(a);
  const B = normalize(b);
  if (A.gameId && B.gameId) {
    if (Number(A.gameId) !== Number(B.gameId)) return null;
    const pa = knownPlatform(A);
    const pb = knownPlatform(B);
    return pa && pb && pa !== pb ? null : 'id';
  }
  if (!sameChampion(myChampion(A), myChampion(B))) return null;
  const na = myName(A);
  const nb = myName(B);
  if (na && nb && na !== nb) return null;
  if (A.gameMode && B.gameMode && norm(A.gameMode) !== norm(B.gameMode)) return null;
  const sa = startOf(A);
  const sb = startOf(B);
  if (sa === null || sb === null) return null;
  if (Math.abs(sa - sb) <= windowMs) return 'time';
  const ea = endOf(A);
  const eb = endOf(B);
  if (ea === null && eb !== null && sa >= sb - windowMs && sa <= eb) return 'time';
  if (eb === null && ea !== null && sb >= sa - windowMs && sb <= ea) return 'time';
  return null;
}

// How much a record knows: the client's documents count most, then the roster and the events.
const SOURCE_WEIGHT = { timeline: 8, history: 8, eog: 6, liveFinal: 5, lp: 2, ranked: 2, session: 2, live: 1 };
function richness(r) {
  let s = 0;
  for (const [k, w] of Object.entries(SOURCE_WEIGHT)) if (r.sources[k]) s += w;
  return s + r.participants.length * 0.5 + Math.min(r.events.length, 500) / 100 + (r.frames ? 1 : 0);
}

const mediaPath = (x) => (x && typeof x.file === 'string' && x.file ? x.file : x && typeof x.was === 'string' && x.was ? x.was : null);
const samePath = (x, y) => Boolean(mediaPath(x) && mediaPath(y) && mediaPath(x).toLowerCase() === mediaPath(y).toLowerCase());
// An entry with the gaps of `first` filled from `second` (e.g. a clip's game times).
function fillEntry(first, second) {
  const out = { ...second, ...first };
  for (const [k, v] of Object.entries(second)) if (out[k] == null && v != null) out[k] = v;
  return out;
}
function unionMedia(lists) {
  const out = [];
  for (const x of lists.flat()) {
    if (!mediaPath(x)) continue;
    const i = out.findIndex((y) => samePath(x, y));
    if (i >= 0) out[i] = fillEntry(out[i], x);
    else out.push(clone(x));
  }
  return out;
}
const clipNumber = (id) => Number((/^c(\d+)$/.exec(String(id == null ? '' : id)) || [])[1]) || 0;

// One record from two of the same match (sameGame()), keyed as `target`: the stats, events and
// timeline of the one that knows more (what it lacks filled in from the other), every video of
// both (the full recordings, the minimap parts and the highlights), the earliest start and the
// latest end, and the other's key among the former keys. Throws when the game IDs differ.
function mergeRecords(target, other) {
  const A = normalize(clone(target));
  const B = normalize(clone(other));
  if (A.gameId && B.gameId && Number(A.gameId) !== Number(B.gameId)) throw new Error(`${A.key} and ${B.key} are different games`);
  const [hi, lo] = richness(B) > richness(A) ? [B, A] : [A, B];
  const r = clone(hi);
  r.key = A.key;
  r.v = A.v;
  r.prov = { ...lo.prov, ...hi.prov };
  for (const k of [...IDENTITY_FIELDS, 'queueName', ...GAME_FIELDS, 'statsFrom', 'me', 'rank', 'frames']) {
    if (r[k] == null && lo[k] != null) {
      r[k] = clone(lo[k]);
      if (lo.prov[k]) r.prov[k] = lo.prov[k];
      else if (hi.prov[k]) delete r.prov[k];
    }
  }
  // A platform guessed (the EUW1 fallback) gives way to one the client or the log named.
  if (hi.prov.platformId === 'fallback' && knownPlatform(lo)) {
    r.platformId = lo.platformId;
    if (lo.prov.platformId) r.prov.platformId = lo.prov.platformId;
    else delete r.prov.platformId;
  }
  for (const k of ['participants', 'teams', 'events']) if (!r[k].length && lo[k].length) r[k] = clone(lo[k]);
  r.clock = { ...r.clock };
  for (const k of Object.keys(lo.clock)) if (r.clock[k] == null && lo.clock[k] != null) r.clock[k] = lo.clock[k];
  const starts = [A.startedAt, B.startedAt].filter((x) => num(x) !== null);
  const ends = [A.endedAt, B.endedAt].filter((x) => num(x) !== null);
  r.startedAt = starts.length ? Math.min(...starts) : null;
  r.endedAt = ends.length ? Math.max(...ends) : null;
  for (const [k, v] of Object.entries(lo.sources)) if (k !== 'legacy' && !r.sources[k] && v) r.sources[k] = v;
  r.sources.legacy = Boolean(hi.sources.legacy);
  const satisfied = (x) => (x === 'gameId' ? Boolean(r.gameId) : Boolean(r.sources[SOURCE_KEY[x] || x]));
  r.pending = [...new Set([...hi.pending, ...lo.pending])].filter((x) => !satisfied(x));
  r.favorite = Boolean(A.favorite || B.favorite);
  const created = [A.createdAt, B.createdAt].filter((x) => num(x) !== null);
  r.createdAt = created.length ? Math.min(...created) : null;
  r.aliases = [...new Set([...A.aliases, ...B.aliases, B.key])].filter((k) => k && k !== A.key);

  // Videos: everything of both, the target's entries first.
  const full = unionMedia([A.media.full, B.media.full]);
  const maps = unionMedia([[A.media.map], A.media.maps, [B.media.map], B.media.maps]);
  // The main minimap is one on the game clock (the richer record's first), else the target's.
  const clocked = (x) => x && num(x.gameStart) !== null;
  const lead = [hi.media.map, lo.media.map, ...maps].find((x) => clocked(x) && maps.some((y) => samePath(x, y)))
    || maps[0] || null;
  const main = lead ? maps.find((y) => samePath(lead, y)) : null;
  const rest = maps.filter((y) => y !== main);
  const clips = unionMedia([A.media.clips, B.media.clips]);
  const used = new Set();
  let next = Math.max(0, ...clips.map((c) => clipNumber(c.id)));
  for (const c of clips) {
    if (c.id == null || used.has(c.id)) c.id = `c${++next}`;
    used.add(c.id);
  }
  // Game-time order; highlights the game clock doesn't place come first, in their order.
  const order = clips.map((c, i) => [c, i]);
  order.sort(([a, i], [b, j]) => {
    const fa = num(a.from);
    const fb = num(b.from);
    if (fa === null || fb === null) return (fa === null ? 0 : 1) - (fb === null ? 0 : 1) || i - j;
    return fa - fb || i - j;
  });
  r.media = { ...A.media, full, map: main, maps: rest, clips: order.map(([c]) => c) };
  return r;
}

module.exports = {
  fromLive, fromEog, fromHistory, fromTimeline, fromLp, fromRanked, fromSession, merge, derive, rowOf,
  blankRecord, normalize, keyOf, historyReady, championInfo, lpValue, QUEUES, RANKED_QUEUES, RANK,
  sameGame, mergeRecords, startOf, endOf,
};
