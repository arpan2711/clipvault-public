// League of Legends key-moment detection.
//
// While a match is running, the League game client serves Riot's official Live Client Data
// API at https://127.0.0.1:2999/liveclientdata. Overwolf-based recorders such as Insights
// Capture get their League events from the same in-game data. We poll its event feed, pick
// out the moments that involve you (kills, multikills, deaths, objectives, the final nexus),
// and group moments that happen close together into one highlight.
//
// Events emitted:
//   match-start  { champion, gameMode, joinedLate, names, mapNumber, detectedAt, wallAt0 }
//                (wallAt0: wall ms of game time 0, null while the loading screen holds the clock;
//                 startSnapshot() has the allgamedata read at the start, or null)
//   moment       { kind, type, label, wallMs, score }  every key moment (also used as markers)
//   highlight    { fromMs, toMs, title, type, moments, champion }   a clip worth saving
//   match-end    { result, moments, champion, summary,     result: 'Win' | 'Lose' | null
//                  events, final, roster, wallAt0, gameMode, mapNumber, gameEndTime, detectedAt }
//                events: every raw event of the feed; final: the allgamedata read at GameEnd (or
//                null); roster: its allPlayers (or the start snapshot's)
const EventEmitter = require('events');
const http = require('http');
const https = require('https');

const DEFAULT_URL = 'https://127.0.0.1:2999/liveclientdata';
const DEFAULT_MERGE_GAP = 20; // seconds; moments closer than this end up in the same clip (setting)
const MAX_SPAN_MS = 90000; // longest stretch of moments merged into one clip
const TEAMFIGHT_KILLS = 4; // champion kills (by anyone) around a clip that make it a teamfight
const MAX_CLOCK_SAMPLES = 120; // wallAt0 estimates kept (the median of these is used)
const FINAL_WAIT_MS = 3000; // longest wait for the final allgamedata snapshot at the end

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function getJson(baseUrl, endpoint, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const url = `${baseUrl}/${endpoint}`;
    const mod = url.startsWith('https:') ? https : http;
    // The game client uses a self-signed certificate on the loopback interface only.
    const req = mod.get(url, { rejectUnauthorized: false, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const norm = (s) => String(s || '').trim().toLowerCase();

// Event names use the in-game display name; depending on patch and mode that's the Riot ID
// game name, the full Riot ID or the legacy summoner name, so we match all of them.
function nameKeys(p) {
  const keys = [p.riotId, p.riotIdGameName, p.summonerName].filter(Boolean).map(norm);
  for (const k of [...keys]) if (k.includes('#')) keys.push(k.split('#')[0]);
  return keys;
}

function identify(active, players) {
  if (!active) return null;
  const names = new Set(nameKeys(active));
  if (!names.size) return null;
  const me = findMe({ names }, players);
  const team = me ? me.team : null;
  const teamNames = new Set();
  for (const p of players || []) if (team && p.team === team) nameKeys(p).forEach((k) => teamNames.add(k));
  return { names, team, teamNames, champion: me ? me.championName : null };
}

function findMe(me, players) {
  return (players || []).find((p) => nameKeys(p).some((k) => me.names.has(k))) || null;
}

// Your line on the scoreboard, for the post-game summary.
function summarize(p) {
  if (!p || !p.scores) return null;
  return {
    champion: p.championName || null,
    level: p.level || 0,
    kills: p.scores.kills || 0,
    deaths: p.scores.deaths || 0,
    assists: p.scores.assists || 0,
    cs: p.scores.creepScore || 0,
    wardScore: Math.round(p.scores.wardScore || 0),
  };
}

function isName(set, name) {
  if (!name || !set) return false;
  const n = norm(name);
  return set.has(n) || (n.includes('#') && set.has(n.split('#')[0]));
}

const MULTIKILL = { 2: ['Double kill', 70], 3: ['Triple kill', 80], 4: ['Quadra kill', 90], 5: ['Penta kill', 100] };
const OBJECTIVES = {
  // event: [label, score, type]
  DragonKill: ['Dragon', 25, 'dragon'],
  HeraldKill: ['Rift Herald', 25, 'herald'],
  HordeKill: ['Voidgrubs', 20, 'grubs'],
  BaronKill: ['Baron Nashor', 50, 'baron'],
  AtakhanKill: ['Atakhan', 48, 'atakhan'],
};

// The game's own names for the drakes. The API reports the element (Fire, Earth...); some
// clients and the mock use the in-game word (Infernal, Mountain...).
const DRAKES = {
  fire: 'Infernal Drake', infernal: 'Infernal Drake', earth: 'Mountain Drake', mountain: 'Mountain Drake',
  water: 'Ocean Drake', ocean: 'Ocean Drake', air: 'Cloud Drake', cloud: 'Cloud Drake',
  hextech: 'Hextech Drake', chemtech: 'Chemtech Drake', elder: 'Elder Dragon',
};
const dragonName = (type) => (type ? DRAKES[norm(type)] || `${type} Drake` : 'Dragon');

// Turn a raw API event into a key moment for the local player, or null.
//   kind  - which setting turns clipping of it on (kills, deaths, assists, objectives, structures)
//   type  - what it was, for the colour and symbol in the UI (kill, death, dragon, baron, ...)
function classify(e, me) {
  if (!me) return null;
  const mine = (n) => isName(me.names, n);
  const assisted = (e.Assisters || []).some(mine);
  switch (e.EventName) {
    case 'ChampionKill':
      if (mine(e.KillerName)) return { kind: 'kills', type: 'kill', label: 'Kill', score: 30 };
      if (mine(e.VictimName)) return { kind: 'deaths', type: 'death', label: 'Death', score: 5 };
      if (assisted) return { kind: 'assists', type: 'assist', label: 'Assist', score: 10 };
      return null;
    case 'Multikill': {
      if (!mine(e.KillerName)) return null;
      const [label, score] = MULTIKILL[e.KillStreak] || [`${e.KillStreak}x kill`, 100];
      return { kind: 'kills', type: 'multikill', label, score };
    }
    case 'FirstBlood':
      return mine(e.Recipient) ? { kind: 'kills', type: 'firstblood', label: 'First blood', score: 40 } : null;
    case 'Ace':
      return mine(e.Acer) ? { kind: 'kills', type: 'ace', label: 'Ace', score: 65 } : null;
    case 'TurretKilled':
    case 'InhibKilled': {
      const turret = e.EventName === 'TurretKilled';
      return mine(e.KillerName) || assisted
        ? { kind: 'structures', type: turret ? 'turret' : 'inhib', label: turret ? 'Turret' : 'Inhibitor', score: 15 } : null;
    }
    default:
      break;
  }
  if (OBJECTIVES[e.EventName]) {
    const stolen = String(e.Stolen).toLowerCase() === 'true';
    if (!(mine(e.KillerName) || assisted)) return null;
    let [label, score, type] = OBJECTIVES[e.EventName];
    if (e.EventName === 'DragonKill' && e.DragonType) {
      label = dragonName(e.DragonType);
      if (e.DragonType === 'Elder') { score = 55; type = 'elder'; }
    }
    if (stolen) { label = `${label} steal`; score = 60; }
    return { kind: 'objectives', type, label, score, stolen };
  }
  return null;
}

const MULTIKILL_LABELS = new Set(Object.values(MULTIKILL).map(([l]) => l).concat(['Ace']));

// A clip's headline and type: "Triple kill", "Double kill + Baron", "3 kills", and
// "Teamfight (5 kills)" when lots of champions died around it but nobody got a multikill.
function describeClip(moments, { teamKills = 0 } = {}) {
  const sorted = [...moments].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  const kills = moments.filter((m) => m.label === 'Kill' || m.label === 'First blood').length;
  const hasMulti = moments.some((m) => MULTIKILL_LABELS.has(m.label));
  const teamfight = teamKills >= TEAMFIGHT_KILLS && top.score < 65;
  let title = top.label;
  let type = top.type;
  if (teamfight) {
    title = `Teamfight (${teamKills} kills)`;
    type = 'teamfight';
    const objective = sorted.find((m) => m.kind === 'objectives');
    if (objective) title += ` + ${objective.label}`;
    return { title, type };
  }
  if (top.label === 'Kill' && kills > 1) title = `${kills} kills`;
  const second = sorted.find((m) => m.label !== top.label && m.score >= 20 && m.kind !== top.kind);
  if (second && !(hasMulti && second.kind === 'kills')) title += ` + ${second.label}`;
  return { title, type };
}

function titleFor(moments, context) {
  return describeClip(moments, context).title;
}

class LeagueWatcher extends EventEmitter {
  constructor({ baseUrl = DEFAULT_URL, getOptions }) {
    super();
    this.baseUrl = baseUrl;
    this.getOptions = getOptions;
    this.match = null;
    this.pending = null;
    this.failures = 0;
    this.timer = null;
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    this._schedule(0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  // Called when the League game process shows up, to notice the match without waiting.
  poke() {
    if (!this.match && !this.stopped) this._schedule(0);
  }

  // The allgamedata snapshot read when the running match was noticed (roster, runes), or null.
  startSnapshot() {
    return this.match ? this.match.live || null : null;
  }

  // Wall-clock ms of game time 0 for the running match: the median of the poll estimates
  // (samples with gameTime > 1 only; the loading screen holds the clock at 0), or null.
  wallAt0() {
    const m = this.match;
    return m ? (m.clock.length ? Math.round(median(m.clock)) : null) : null;
  }

  _clockSample(gameTime, wallMs) {
    const m = this.match;
    if (!m || !(Number(gameTime) > 1)) return;
    m.clock.push(wallMs - gameTime * 1000);
    if (m.clock.length > MAX_CLOCK_SAMPLES) m.clock.shift();
  }

  status() {
    const m = this.match;
    if (!m || m.ended) return null;
    return { champion: m.me ? m.me.champion : null, gameMode: m.gameMode, spectating: !m.me, summary: m.summary };
  }

  // Bookmark hotkey: mark "now" as a key moment of the running match. Returns false when no
  // match is running.
  addBookmark(wallMs = Date.now()) {
    const m = this.match;
    if (!m || m.ended) return false;
    const moment = { kind: 'bookmarks', type: 'bookmark', label: 'Bookmark', score: 35, wallMs };
    m.moments.push(moment);
    this.emit('moment', moment);
    const opts = this.getOptions();
    if (opts.enabled && opts.bookmarks) this._add(moment, false);
    return true;
  }

  async _refreshSummary() {
    const m = this.match;
    if (!m || !m.me) return;
    const players = await getJson(this.baseUrl, 'playerlist').catch(() => null);
    const line = summarize(findMe(m.me, players));
    if (line && this.match === m) m.summary = line;
  }

  _schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._tick(), ms);
  }

  async _tick() {
    if (this.stopped) return;
    try {
      if (!this.match) await this._begin();
      if (this.match) await this._poll();
      this.failures = 0;
    } catch {
      // No game running (connection refused), or the client is closing.
      if (this.match && ++this.failures >= 4) this._finish(this.match.result || null, { clear: true });
    }
    if (!this.stopped) this._schedule(this.match ? 1000 : 3000);
  }

  async _begin() {
    const stats = await getJson(this.baseUrl, 'gamestats');
    if (stats.gameMode === 'TFT') return; // no combat events to clip in Teamfight Tactics
    const detectedAt = Date.now();
    const [active, players, events, live] = await Promise.all([
      getJson(this.baseUrl, 'activeplayer').catch(() => null),
      getJson(this.baseUrl, 'playerlist').catch(() => []),
      getJson(this.baseUrl, 'eventdata').then((d) => d.Events || []),
      getJson(this.baseUrl, 'allgamedata', 3000).catch(() => null), // roster and runes for the match record
    ]);
    // Started ClipVault in the middle of a match: don't clip what already happened.
    const joinedLate = stats.gameTime > 20;
    const me = identify(active, players);
    this.match = {
      me,
      gameMode: stats.gameMode,
      lastGameTime: stats.gameTime,
      processed: joinedLate ? events.length : 0,
      moments: [],
      kills: [], // wall times of every champion kill (anyone), to recognise teamfights
      summary: me ? summarize(findMe(me, players)) : null,
      polls: 0,
      ended: false,
      // For the match record: every raw event, the clock, the snapshots.
      rawEvents: events,
      mapNumber: stats.mapNumber != null ? stats.mapNumber : null,
      detectedAt,
      clock: [],
      live: live && typeof live === 'object' && !live.errorCode ? live : null,
      final: undefined, // the GameEnd snapshot: undefined until read, then the data or null
      finalRead: null,
      gameEndTime: null,
    };
    this._clockSample(stats.gameTime, Date.now());
    this.emit('match-start', {
      champion: this.match.me ? this.match.me.champion : null,
      gameMode: stats.gameMode,
      joinedLate,
      names: this.match.me ? [...this.match.me.names] : [],
      mapNumber: this.match.mapNumber,
      detectedAt,
      wallAt0: this.wallAt0(),
    });
  }

  async _poll() {
    const m = this.match;
    const [data, stats] = await Promise.all([getJson(this.baseUrl, 'eventdata'), getJson(this.baseUrl, 'gamestats')]);
    const events = data.Events || [];
    const now = Date.now();
    if (events.length < m.processed || stats.gameTime + 5 < m.lastGameTime) {
      // A different match is running now.
      this._finish(m.result || null, { clear: true });
      return;
    }
    m.lastGameTime = stats.gameTime;
    if (events.length >= m.rawEvents.length) m.rawEvents = events;
    if (m.ended) return; // post-game screen; wait for the client to close
    this._clockSample(stats.gameTime, now);
    if (!m.me) {
      const [active, players] = await Promise.all([
        getJson(this.baseUrl, 'activeplayer').catch(() => null),
        getJson(this.baseUrl, 'playerlist').catch(() => []),
      ]);
      m.me = identify(active, players);
    }
    for (; m.processed < events.length; m.processed++) {
      const e = events[m.processed];
      const wallMs = now - Math.max(0, stats.gameTime - (Number(e.EventTime) || 0)) * 1000;
      this._onEvent(e, wallMs);
    }
    if (++m.polls % 5 === 0) this._refreshSummary(); // K/D/A, CS and level every ~5 s
  }

  _onEvent(e, wallMs) {
    const m = this.match;
    const opts = this.getOptions();
    this.emit('raw', e);
    if (e.EventName === 'ChampionKill') m.kills.push(wallMs);
    if (e.EventName === 'GameEnd') {
      m.ended = true;
      m.result = e.Result || null;
      m.gameEndTime = Number(e.EventTime) || null;
      // The final scoreboard (all 10 players, items, the whole feed), awaited before match-end.
      m.finalRead = getJson(this.baseUrl, 'allgamedata', FINAL_WAIT_MS)
        .then((d) => (d && typeof d === 'object' && !d.errorCode ? d : null), () => null)
        .then((d) => { m.final = d; return d; });
      this._refreshSummary(); // final scoreboard line, ready before the match closes
      const win = e.Result === 'Win';
      const moment = { kind: 'gameEnd', type: win ? 'victory' : 'defeat', label: win ? 'Victory' : 'Defeat', score: win ? 58 : 12, wallMs };
      m.moments.push(moment);
      this.emit('moment', moment);
      if (opts.enabled && opts.gameEnd) this._add(moment, true);
      // Let the last clip finish, then close the match.
      setTimeout(() => {
        if (this.match === m) this._finish(m.result, { clear: false });
      }, Math.max(0, wallMs + opts.after * 1000 - Date.now()) + 300);
      return;
    }
    const moment = classify(e, m.me);
    if (!moment) return;
    moment.wallMs = wallMs;
    m.moments.push(moment);
    this.emit('moment', moment);
    if (opts.enabled && opts[moment.kind]) this._add(moment, false);
  }

  _add(moment, flushSoon) {
    const opts = this.getOptions();
    let p = this.pending;
    if (p && moment.wallMs - p.firstMs > MAX_SPAN_MS) {
      this._flush();
      p = null;
    }
    if (!p) p = this.pending = { moments: [], firstMs: moment.wallMs, lastMs: moment.wallMs, champion: this.match.me && this.match.me.champion };
    p.moments.push(moment);
    p.lastMs = Math.max(p.lastMs, moment.wallMs);
    clearTimeout(p.timer);
    const gapMs = (opts.mergeGap || DEFAULT_MERGE_GAP) * 1000;
    const flushAt = p.lastMs + (flushSoon ? opts.after * 1000 : Math.max(gapMs, opts.after * 1000));
    p.timer = setTimeout(() => this._flush(), Math.max(0, flushAt - Date.now()));
  }

  _flush() {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    const opts = this.getOptions();
    const kills = this.match ? this.match.kills : [];
    const teamKills = kills.filter((t) => t >= p.firstMs - 5000 && t <= p.lastMs + 5000).length;
    const { title, type } = describeClip(p.moments, { teamKills });
    this.emit('highlight', {
      fromMs: p.firstMs - opts.before * 1000,
      toMs: p.lastMs + opts.after * 1000,
      title,
      type,
      moments: p.moments,
      champion: p.champion,
    });
  }

  // clear: forget the match. After GameEnd the API stays up on the post-game screen, so the
  // ended match is kept until the API disappears; otherwise it would be detected as new.
  _finish(result, { clear }) {
    const m = this.match;
    if (!m) return;
    this._flush();
    if (!m.announcedEnd) {
      m.announcedEnd = true;
      const summary = m.summary ? { ...m.summary, result, gameMode: m.gameMode, gameTime: Math.round(m.lastGameTime) } : null;
      const wallAt0 = m.clock.length ? Math.round(median(m.clock)) : null;
      const announce = () => {
        const final = m.final || null;
        const roster = (final && final.allPlayers) || (m.live && m.live.allPlayers) || null;
        const events = final && final.events && Array.isArray(final.events.Events) && final.events.Events.length >= m.rawEvents.length
          ? final.events.Events : m.rawEvents;
        this.emit('match-end', {
          result, moments: m.moments, champion: m.me ? m.me.champion : null, summary,
          events, final, roster, wallAt0, gameMode: m.gameMode, mapNumber: m.mapNumber, gameEndTime: m.gameEndTime,
          detectedAt: m.detectedAt, names: m.me ? [...m.me.names] : [],
        });
      };
      // The final snapshot is normally in by now (it's read at GameEnd, the match closes seconds
      // later); if not, wait for it a little, never long.
      if (m.final !== undefined || !m.finalRead) announce();
      else {
        const timeout = new Promise((r) => setTimeout(r, FINAL_WAIT_MS + 500));
        Promise.race([m.finalRead, timeout]).then(announce, announce);
      }
    }
    if (clear) this.match = null;
  }
}

module.exports = { LeagueWatcher, classify, identify, titleFor, describeClip, dragonName, DEFAULT_MERGE_GAP, MAX_SPAN_MS };
