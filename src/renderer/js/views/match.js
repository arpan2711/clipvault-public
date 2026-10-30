// Match page: one League match. A header (champion, result, K/D/A, the record's stats), then the
// Watch, Scoreboard and Highlights tabs. Same contract as views/matches.js: pure functions that
// return escaped HTML strings (no DOM, no IPC), unit-tested in Node (test/match-view-test.js) and
// previewed without the app (test/ui/preview/match.html).
// Inputs: a MatchEntry from groupLibrary() (js/lib/group.js), whose clips carry gameAt, momentType
// and family and whose gameStart is the game clock (game time = minimap time + gameStart), plus an
// optional match record (A4 §5.2: me, participants, teams, events, frames.totalGold). Only what
// exists is shown: with no record the Scoreboard says when its stats will arrive.
// Every control carries data-act (one of ACTIONS), so app.js wires the page with one delegated
// listener. Times in data-at are game seconds; the app maps them to the video it plays.

import { icon } from '../core/icons.js';
import '../../events.js'; // globalThis.EventStyles: the event tokens
import { RANK, familyOf } from '../lib/group.js';
import { esc, fmtDuration, modeName, renderMatchPanel, itemsHtml, buildHtml } from './matches.js';

// The data-act names used on this page. What each should do in app.js:
//   match-back           go back to the Matches list
//   match-tab            show the tab in data-tab (watch | scoreboard | highlights)
//   match-make-video     api.makeHighlightVideo(map.path), as in the Matches view; data-key
//   match-menu           open renderMatchMenu(match) from views/matches.js at the button; data-key
//   match-seek           seek the player to data-at (game seconds): moments, timeline markers
//   match-scrub          the timeline track: on pointer down/move seek to data-from + x/width × (data-to − data-from)
//   match-play           play or pause the video in the stage
//   match-prev           jump to the previous moment (the previous highlight in Highlight mode)
//   match-next           jump to the next moment (the next highlight in Highlight mode)
//   match-highlight-mode turn Highlight mode on or off (data-on="true" means turn it on); it plays each
//                        highlight inside the full recording and skips the time between them
//   match-family-toggle  add or remove data-family (kill | assist | death | objective | structure |
//                        bookmark) from Highlight mode's families, then re-render
//   match-clip           save a clip at the playhead (the player's existing Clip flow)
//   match-minimap        show or hide the minimap picture-in-picture (data-on="true" means show)
//   match-fullscreen     toggle full screen for the stage
//   match-mute           mute or unmute the video
//   match-feed           show data-feed in the Moments list: 'mine' (your moments) or 'all' (every
//                        kill in the match); the app remembers the choice
//   clip-play, clip-select, match-family, match-select, match-folder: the Highlights tab is the
//                        Matches view's panel (renderMatchPanel), so these keep their matches.js meaning
export const ACTIONS = Object.freeze([
  'match-back', 'match-tab', 'match-make-video', 'match-menu',
  'match-seek', 'match-scrub', 'match-play', 'match-prev', 'match-next',
  'match-highlight-mode', 'match-family-toggle', 'match-clip', 'match-minimap', 'match-fullscreen', 'match-mute', 'match-feed',
]);

export const TABS = Object.freeze([['watch', 'Watch'], ['scoreboard', 'Scoreboard'], ['highlights', 'Highlights']]);

// Highlight mode's family toggles (a multikill counts as a kill). Deaths are off by default.
export const TOGGLES = Object.freeze([
  ['kill', 'Kills'], ['assist', 'Assists'], ['death', 'Deaths'], ['objective', 'Objectives'], ['structure', 'Structures'], ['bookmark', 'Bookmarks'],
]);
export const DEFAULT_FAMILIES = Object.freeze(['kill', 'assist', 'objective', 'structure', 'bookmark']);

// What the Moments list shows: your moments, or every kill in the match (the IC-style kill feed).
export const FEEDS = Object.freeze([['mine', 'My moments'], ['all', 'All kills']]);

// Timeline markers closer than this are drawn as one marker with a count (IC rule, A1 §4.2).
export const GROUP_PX = 28;

// ------------------------------------------------------------------ formatting

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const pos0 = (v) => num(v) && v > 0;
const pad2 = (n) => String(n).padStart(2, '0');
const round1 = (v) => Math.round(v * 10) / 10;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const pct = (v) => `${round1(clamp01(v) * 100)}%`;
const MINUS = '−';

// 28640 -> "28,640"; -5830 -> "−5,830"
export function fmtInt(n) {
  const s = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return Math.round(n) < 0 ? `${MINUS}${s}` : s;
}
const fmtSigned = (n) => (Math.round(n) > 0 ? `+${fmtInt(n)}` : fmtInt(n));
const kShort = (n) => (Math.abs(n) >= 1000 ? `${round1(n / 1000).toFixed(1)}K` : String(Math.round(n)));
// Game time, which starts before 0:00 for the part of the recording before the game clock runs.
// Shown as the game clock does: whole seconds, rounded down.
export const fmtGame = (t) => { const s = Math.floor(Math.abs(t)); return `${t < 0 && s ? MINUS : ''}${fmtDuration(s)}`; };
const fmtClock = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function fmtDay(ms, now) {
  const d = new Date(ms);
  const year = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

// Attribute string from an object: null/undefined/false are left out, true is a bare attribute.
function attrs(obj) {
  let out = '';
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === false) continue;
    out += v === true ? ` ${k}` : ` ${k}="${esc(v)}"`;
  }
  return out;
}

const ROLE = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', MID: 'Mid', BOTTOM: 'Bot', ADC: 'Bot', UTILITY: 'Support', SUPPORT: 'Support' };
const ROLE_ORDER = ['TOP', 'JUNGLE', 'MIDDLE', 'MID', 'BOTTOM', 'ADC', 'UTILITY', 'SUPPORT'];
const roleName = (r) => (r ? ROLE[String(r).toUpperCase()] || '' : '');
const RESULT = { Win: 'Victory', Lose: 'Defeat', Remake: 'Remake', Victory: 'Victory', Defeat: 'Defeat' };
const toneOfResult = (r) => (r === 'Victory' ? ' mp-win' : r === 'Defeat' ? ' mp-loss' : '');

// ------------------------------------------------------------------ glyphs (same set as matches.js)

// The token per moment comes from events.js (EventStyles.glyphId), shared with the player.
const ES = globalThis.EventStyles;
const TONE = { kill: 'mp-kill', assist: 'mp-assist', death: 'mp-death', multikill: 'mp-hl', objective: 'mp-obj', structure: 'mp-struct', bookmark: 'mp-bookmark' };
const toneOf = (type) => (type === 'victory' ? 'mp-win' : type === 'defeat' ? 'mp-loss' : TONE[familyOf(type)] || 'mp-struct');
const LABEL = {
  kill: 'Kill', firstblood: 'First blood', assist: 'Assist', death: 'Death', multikill: 'Multikill', ace: 'Ace', teamfight: 'Teamfight',
  baron: 'Baron Nashor', herald: 'Rift Herald', grubs: 'Voidgrubs', dragon: 'Dragon', elder: 'Elder Dragon', atakhan: 'Atakhan',
  turret: 'Turret', inhib: 'Inhibitor', bookmark: 'Bookmark', victory: 'Victory', defeat: 'Defeat', other: 'Moment',
};
// A moment's token; label tells multikills and dragons apart. The -sm twin below 22 px.
const evDisc = (type, cls = '', label = '') => `<span class="mp-ev ${toneOf(type)}${cls ? ` ${cls}` : ''}">${ES.icon(type, { label, small: Boolean(cls) })}</span>`;

const toggleOf = (family) => (family === 'multikill' ? 'kill' : family);
const TOGGLE_KEYS = new Set(TOGGLES.map(([f]) => f));
const famSet = (families) => new Set(families == null ? DEFAULT_FAMILIES : families instanceof Set ? [...families] : families);
// A family with no toggle (the result clip, "other") always plays.
const familyOn = (family, fams) => !TOGGLE_KEYS.has(toggleOf(family)) || fams.has(toggleOf(family));

// ------------------------------------------------------------------ the match in game time

// Every moment of the match, in game seconds, oldest first: the record's events, else the minimap's
// markers (the whole game), else the highlights' own markers. [] when the match has no game clock.
//   -> [{ t, type, family, label, killer, victim, team }]
export function matchMoments(match, record = null) {
  const out = [];
  const evs = record && Array.isArray(record.events) ? record.events.filter((e) => e && e.type && num(e.t)) : [];
  const clock = num(match.gameStart) ? match.gameStart : null;
  if (evs.length) {
    for (const e of evs) out.push({ t: round1(e.t), type: e.type, label: e.label, killer: e.killer, victim: e.victim, assisters: e.assisters, team: e.team });
  } else if (clock !== null && match.map && Array.isArray(match.map.markers) && match.map.markers.some((m) => m && m.type)) {
    for (const m of match.map.markers) if (m && m.type && num(m.t)) out.push({ t: round1(m.t + clock), type: m.type, label: m.label });
  } else if (clock !== null) {
    const seen = new Set();
    for (const c of match.clips || []) {
      if (!c.map || !num(c.map.offset)) continue;
      for (const m of c.markers || []) {
        if (!m || !m.type || !num(m.t)) continue;
        const t = round1(c.map.offset + m.t + clock);
        const k = `${m.type}@${Math.round(t)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ t, type: m.type, label: m.label });
      }
    }
  }
  return out
    .map((m) => ({ ...m, family: familyOf(m.type), label: m.label || LABEL[m.type] || LABEL.other }))
    .sort((a, b) => a.t - b.t || (RANK[a.type] || 0) - (RANK[b.type] || 0));
}

// Each highlight as a range of game time (from the clip's minimap offset and length).
//   -> [{ clip, index, from, to, family, type }]
export function highlightRanges(match) {
  if (!num(match.gameStart)) return [];
  return (match.clips || []).map((clip, index) => {
    if (!clip.map || !num(clip.map.offset) || !pos0(clip.duration)) return null;
    const from = round1(clip.map.offset + match.gameStart);
    return { clip, index, from, to: round1(from + clip.duration), family: clip.family || familyOf(clip.momentType), type: clip.momentType || 'other' };
  }).filter(Boolean);
}

// The highlights Highlight mode plays: those of the families that are on (a multikill counts as a kill).
export function playableRanges(ranges, families = null) {
  const fams = famSet(families);
  return (ranges || []).filter((r) => familyOn(r.family, fams));
}

// The span the timeline covers: from the start of the recording (it starts before 0:00) to the end of
// the game. null without a game clock.
export function timelineSpan(match, moments = [], ranges = []) {
  if (!num(match.gameStart)) return null;
  const starts = [0, match.gameStart];
  const full = match.full;
  if (full && full.map && num(full.map.offset)) starts.push(full.map.offset + match.gameStart);
  const ends = [...moments.map((m) => m.t), ...ranges.map((r) => r.to)];
  if (pos0(match.gameTime)) ends.push(match.gameTime);
  else {
    if (full && full.map && num(full.map.offset) && pos0(full.duration)) ends.push(full.map.offset + match.gameStart + full.duration);
    if (match.map && pos0(match.map.duration)) ends.push(match.gameStart + match.map.duration);
  }
  const t0 = Math.min(...starts);
  const t1 = Math.max(t0 + 60, ...ends);
  return { t0: round1(t0), t1: round1(t1) };
}

// Groups timeline markers that sit closer than `gap` px to the previous one (chained), so dense
// fights read as one marker with a count. markers: [{ pos: 0..1 along the track, type, ... }];
// width: the track's width in px. -> [{ x, pos, count, type (the top-ranked), family, items }]
export function timelineLayout(markers, width, gap = GROUP_PX) {
  const w = pos0(width) ? width : 0;
  const list = (markers || []).filter((m) => m && num(m.pos)).map((m) => ({ ...m, x: clamp01(m.pos) * w })).sort((a, b) => a.x - b.x);
  const groups = [];
  for (const m of list) {
    const g = groups[groups.length - 1];
    if (g && m.x - g.items[g.items.length - 1].x < gap) g.items.push(m);
    else groups.push({ items: [m] });
  }
  return groups.map(({ items }) => {
    const top = items.reduce((b, m) => ((RANK[m.type] || 0) > (RANK[b.type] || 0) ? m : b));
    const x = (items[0].x + items[items.length - 1].x) / 2;
    return { x, pos: w ? x / w : clamp01(items[0].pos), count: items.length, type: top.type, family: familyOf(top.type), items };
  });
}

// Total length of a set of ranges, overlaps counted once.
function unionLength(ranges) {
  const list = ranges.map((r) => [r.from, r.to]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of list) {
    if (!cur || a > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b);
  }
  return cur ? total + cur[1] - cur[0] : total;
}

// ------------------------------------------------------------------ header and tabs

const statCell = (label, value, extra = '') => `<div class="mp-hs"><span class="mp-hl">${esc(label)}</span><span class="mp-hv">${value}${extra ? `<span class="mp-hx">${esc(extra)}</span>` : ''}</span></div>`;
const kdaRatio = (k, d, a) => (d > 0 ? ((k + a) / d).toFixed(2) : 'Perfect');

function champFace(name, src, cls = '') {
  return src
    ? `<span class="mp-face${cls}"><img src="${esc(src)}" alt="" draggable="false"></span>`
    : `<span class="mp-face mp-face-ph${cls}" aria-hidden="true">${esc(String(name || '?').charAt(0).toUpperCase())}</span>`;
}

// The player's line: the record's `me` when there is one, else the stats the library saved.
function myLine(match, record) {
  const me = record && record.me ? record.me : null;
  const st = match.stats || {};
  const pick = (a, b) => (num(a) ? a : num(b) ? b : null);
  return {
    me,
    kills: pick(me && me.kills, st.kills), deaths: pick(me && me.deaths, st.deaths), assists: pick(me && me.assists, st.assists),
    level: pick(me && me.level, st.level),
  };
}

// opts.icons: (kind 'item' | 'spell' | 'rune', id) -> { url, name } or a URL, or null while it isn't
// cached; the older opts.itemIcon: (itemId) -> url still works for items.
function iconsOf({ icons = null, itemIcon = null } = {}) {
  if (typeof icons === 'function') return icons;
  return typeof itemIcon === 'function' ? (kind, id) => (kind === 'item' ? itemIcon(id) : null) : null;
}
const anyItem = (items) => Array.isArray(items) && items.some((id) => num(id) && id > 0);
// A player's spells and runes: a scoreboard row (keystone, subStyle) or the record's me (runes).
const buildOfPlayer = (p) => ({
  spells: p.spells,
  keystone: num(p.keystone) ? p.keystone : p.runes && Array.isArray(p.runes.perks) ? p.runes.perks[0] : Array.isArray(p.perks) ? p.perks[0] : null,
  subStyle: num(p.subStyle) ? p.subStyle : p.runes ? p.runes.sub : null,
});

//   opts: { now (for the year), icons (see iconsOf) for the record's items, spells and runes }
export function renderMatchHeader(match, record = null, opts = {}) {
  const { now = Date.now() } = opts;
  const icons = iconsOf(opts);
  const m = match;
  const line = myLine(m, record);
  const me = line.me;
  const result = (record && RESULT[record.result]) || m.result || '';
  const length = record && pos0(record.duration) ? record.duration : pos0(m.gameTime) ? m.gameTime : null;
  const lp = record && record.rank && num(record.rank.lpDelta) ? record.rank.lpDelta : null;
  const queue = (record && record.queueName) || modeName((record && record.gameMode) || (m.stats && m.stats.gameMode));
  const sub = [
    me ? esc(roleName(me.role)) : '',
    esc(queue),
    lp !== null ? `<span class="mp-num">${esc(lp > 0 ? `+${lp}` : `${lp < 0 ? MINUS : ''}${Math.abs(lp)}`)} LP</span>` : '',
    num(m.start) ? esc(`${fmtDay(m.start, now)}, ${fmtClock(m.start)}`) : '',
    length ? `<span class="mp-num">${esc(fmtDuration(length))}</span>` : '',
  ].filter(Boolean).map((s, i) => `${i ? '<span class="mp-dot" aria-hidden="true">·</span>' : ''}${s}`).join('');
  const name = (me && (me.alias || me.champion)) || m.champion || 'League match';
  const lvl = pos0(line.level) ? `<span class="mp-lvl" title="Level ${esc(line.level)}">${esc(line.level)}</span>` : '';
  const face = `<span class="mp-champ-wrap">${champFace(name, m.championIcon || (me && (me.icon || me.championIcon)), ' mp-face-lg')}${lvl}</span>`
    + (me ? buildHtml(buildOfPlayer(me), icons, 'mp-build') : '');

  const stats = [];
  if (num(line.kills) && num(line.deaths) && num(line.assists)) {
    const sep = '<span class="mp-sep"> / </span>';
    stats.push(statCell('K/D/A', `<span class="mp-kda">${esc(line.kills)}${sep}<span class="mp-d">${esc(line.deaths)}</span>${sep}${esc(line.assists)}</span>`,
      `${kdaRatio(line.kills, line.deaths, line.assists)} KDA`));
  }
  if (me) {
    if (pos0(me.kp)) stats.push(statCell('KP', esc(`${Math.round(me.kp * 100)}%`)));
    if (pos0(me.cs)) stats.push(statCell('CS', esc(me.cs), pos0(me.csPerMin) ? `${me.csPerMin.toFixed(1)}/min` : ''));
    if (pos0(me.damage)) stats.push(statCell('Damage', esc(fmtInt(me.damage)), pos0(me.damageShare) ? `${Math.round(me.damageShare * 100)}% of team` : ''));
    if (pos0(me.gold)) stats.push(statCell('Gold', esc(fmtInt(me.gold)), pos0(me.goldPerMin) ? `${Math.round(me.goldPerMin)}/min` : ''));
    if (num(me.vision) && (me.vision > 0 || (record && record.gameMode !== 'ARAM'))) stats.push(statCell('Vision', esc(Math.round(me.vision))));
  }
  const items = me && anyItem(me.items) ? itemsHtml(me.items, icons, 'mp-items', 'mp-item') : '';

  return '<header class="mp-head">'
    + '<div class="mp-top">'
    + `<button type="button" class="mp-icon-btn"${attrs({ 'data-act': 'match-back', title: 'Back to matches', 'aria-label': 'Back to matches' })}>${icon('arrow-left', { size: 'md' })}</button>`
    + face
    + `<div class="mp-title"><div class="mp-name"><h1 class="mp-h1">${esc(name)}</h1>${result ? `<span class="mp-res${toneOfResult(result)}">${esc(result)}</span>` : ''}</div>`
    + `<div class="mp-sub">${sub}</div></div>`
    + '<span class="mp-grow"></span>'
    + (m.clips && m.clips.length ? `<button type="button" class="mp-btn"${attrs({ 'data-act': 'match-make-video', 'data-key': m.key, disabled: !m.map, title: m.map ? 'Join the highlights into one video' : 'Needs the match minimap to line the highlights up' })}>${icon('clapperboard')}Make highlight video</button>` : '')
    + `<button type="button" class="mp-icon-btn"${attrs({ 'data-act': 'match-menu', 'data-key': m.key, title: 'More actions', 'aria-label': 'More actions', 'aria-haspopup': 'menu' })}>${icon('ellipsis')}</button>`
    + '</div>'
    + (stats.length || items ? `<div class="mp-stats">${stats.join('')}<span class="mp-grow"></span>${items}</div>` : '')
    + '</header>';
}

export function renderMatchTabs(match, tab = 'watch') {
  const n = (match.clips || []).length;
  return `<nav class="mp-tabs" role="tablist" aria-label="Match">${TABS.map(([id, text]) => {
    const on = id === tab;
    const ct = id === 'highlights' && n ? `<span class="mp-ct">${esc(n)}</span>` : '';
    return `<button type="button" class="mp-tab${on ? ' mp-on' : ''}" role="tab"${attrs({ 'data-act': 'match-tab', 'data-tab': id, 'aria-selected': on ? 'true' : 'false' })}>${esc(text)}${ct}</button>`;
  }).join('')}</nav>`;
}

// ------------------------------------------------------------------ Watch

// The moment to mark in the list: the last one at or just ahead of the playhead.
const LEAD = 3;
export function currentIndex(moments, at) {
  if (!num(at)) return -1;
  let cur = -1;
  moments.forEach((m, i) => { if (m.family !== 'result' && m.type !== 'multikill' && m.t <= at + LEAD) cur = i; });
  return cur;
}

// A multikill becomes a gold divider above the kills it's made of (each within 10 s of the next).
function momentRows(moments) {
  const rows = moments.map((m, i) => ({ m, i, div: null }));
  const out = [];
  for (const r of rows) {
    if (r.m.type !== 'multikill' && r.m.type !== 'ace') { out.push(r); continue; }
    let k = out.length;
    let last = r.m.t;
    for (let j = out.length - 1, n = 0; j >= 0 && n < 5; j -= 1) {
      const p = out[j].m;
      if (last - p.t > 10) break;
      if (p.type === 'kill' || p.type === 'firstblood') { k = j; last = p.t; n += 1; }
    }
    out.splice(k, 0, { m: r.m, i: r.i, div: true });
  }
  return out;
}

// Who killed whom (assisters, killer -> victim) as champion faces. mark: ring your own face (the
// kill feed). A kill by a turret, minion or monster shows that in the killer's place.
const EXECUTED = { turret: ['castle', 'A turret'], minion: ['users', 'Minions'], monster: ['flame', 'A monster'], other: ['skull', 'Executed:'] };
function whoHtml(m, record, { mark = false } = {}) {
  if (!record || !Array.isArray(record.participants)) return '';
  const byId = new Map(record.participants.filter(Boolean).map((p) => [p.participantId, p]));
  const myTeam = record.me ? record.me.team : null;
  if (m.family === 'objective' || m.family === 'structure') {
    if (m.team == null || myTeam == null) return '';
    return `<span class="mp-who"><span class="mp-team-of">${m.team === myTeam ? 'Your team' : 'Enemy team'}</span></span>`;
  }
  const a = byId.get(m.killer);
  const b = byId.get(m.victim);
  const exec = !a && b && m.by ? EXECUTED[m.by] || EXECUTED.other : null;
  if ((!a && !exec) || !b) return '';
  const meId = mark ? myId(record) : null;
  const f = (p, cls = ' mp-face-xs') => champFace(p.champion, p.icon || p.championIcon, `${cls}${meId != null && p.participantId === meId ? ' mp-face-me' : ''}`);
  const helpers = (Array.isArray(m.assisters) ? m.assisters : []).map((id) => byId.get(id)).filter(Boolean).slice(0, 4);
  const assist = helpers.length ? `<span class="mp-helpers">${helpers.map((p) => f(p, ' mp-face-2xs')).join('')}</span>` : '';
  const withWho = helpers.length ? `, with ${helpers.map((p) => p.champion).join(', ')}` : '';
  const killer = a ? f(a) : `<span class="mp-face mp-face-ph mp-face-xs mp-face-exec">${icon(exec[0])}</span>`;
  const title = a ? `${a.champion} killed ${b.champion}${withWho}` : exec === EXECUTED.other ? `${b.champion} was executed${withWho}` : `${exec[1]} killed ${b.champion}${withWho}`;
  return `<span class="mp-who"${attrs({ title })}>${assist}${killer}${icon('arrow-right', { cls: 'mp-to' })}${f(b)}</span>`;
}

// ------------------------------------------------------------------ the kill feed (All kills)

const myId = (record) => {
  if (record && record.me && num(record.me.participantId)) return record.me.participantId;
  const row = record && Array.isArray(record.participants) ? record.participants.find((p) => p && p.isMe) : null;
  return row ? row.participantId : null;
};
const MULTI = ['', '', 'Double kill', 'Triple kill', 'Quadra kill', 'Penta kill'];

// Every champion kill in the match, from the record's events (the game's live feed, or the League
// client's timeline when there was none), oldest first. When there are none, `reason` says why, so
// the page can keep showing your moments with a short note.
//   -> { kills: [{ t, killer, victim, assisters, by, side: 'ally' | 'enemy' | null,
//                  mine: 'kill' | 'death' | 'assist' | null, label, type, streak, chain }], reason }
// side: whose kill it is from your team's point of view (an execution goes to the victim's
// enemies). streak and chain: multikills as the game counts them (10 s between kills, 30 s before a
// penta); chain is the index of the chain's first kill.
export function killFeed(record) {
  if (!record) return { kills: [], reason: 'All kills come from the match record, and this match has none yet.' };
  const evs = (Array.isArray(record.events) ? record.events : [])
    .filter((e) => e && e.name === 'ChampionKill' && num(e.t) && e.victim)
    .sort((a, b) => a.t - b.t);
  if (!evs.length) {
    const waiting = (record.pending || []).some((x) => x === 'timeline' || x === 'history');
    return {
      kills: [],
      reason: waiting ? 'All kills arrive with the match timeline from the League client (it fills in while the client is open).'
        : 'No kill feed was saved for this match.',
    };
  }
  const teamOf = new Map((Array.isArray(record.participants) ? record.participants : []).filter(Boolean).map((p) => [p.participantId, p.team]));
  const me = myId(record);
  const myTeam = record.me && record.me.team != null ? record.me.team : me != null ? teamOf.get(me) : null;
  const last = new Map(); // killer -> { streak, t, chain }
  const kills = evs.map((e, i) => {
    const assisters = Array.isArray(e.assisters) ? e.assisters.filter(Boolean) : [];
    const killer = e.killer || 0;
    const killerTeam = killer ? teamOf.get(killer) : null;
    const victimTeam = teamOf.get(e.victim);
    let side = null;
    if (myTeam != null) {
      if (killerTeam != null) side = killerTeam === myTeam ? 'ally' : 'enemy';
      else if (victimTeam != null) side = victimTeam === myTeam ? 'enemy' : 'ally';
    }
    const mine = me == null ? null : killer === me ? 'kill' : e.victim === me ? 'death' : assisters.includes(me) ? 'assist' : null;
    let streak = 1;
    let chain = i;
    const prev = killer ? last.get(killer) : null;
    if (prev && prev.streak < 5 && e.t - prev.t <= (prev.streak === 4 ? 30 : 10)) { streak = prev.streak + 1; chain = prev.chain; }
    if (killer) last.set(killer, { streak, t: e.t, chain });
    const label = mine ? LABEL[mine] : !killer ? 'Executed' : side === 'ally' ? 'Ally kill' : side === 'enemy' ? 'Enemy kill' : 'Kill';
    const type = mine || (side === 'enemy' ? 'death' : 'kill');
    return { t: round1(e.t), killer, victim: e.victim, assisters, by: killer ? null : e.by || 'other', side, mine, label, type, family: 'kill', streak, chain };
  });
  return { kills, reason: '' };
}

// The kill to mark in the feed: the last one at or just ahead of the playhead.
export function feedIndex(kills, at) {
  if (!num(at)) return -1;
  let cur = -1;
  (kills || []).forEach((k, i) => { if (k.t <= at + LEAD) cur = i; });
  return cur;
}

// The feed's rows: a gold divider (with the killer) above the first kill of each multikill.
function feedListHtml(kills, at, record) {
  const cur = feedIndex(kills, at);
  const best = new Map(); // chain start -> the chain's last kill (its biggest streak)
  for (const k of kills) if (k.streak > 1 && (!best.has(k.chain) || k.streak > best.get(k.chain).streak)) best.set(k.chain, k);
  const byId = new Map((record.participants || []).filter(Boolean).map((p) => [p.participantId, p]));
  return kills.map((k, i) => {
    let div = '';
    const multi = best.get(i);
    if (multi) {
      const p = byId.get(multi.killer);
      const who = p ? `${champFace(p.champion, p.icon || p.championIcon, ' mp-face-2xs')}<span>${esc(p.champion)}</span><span class="mp-dot" aria-hidden="true">·</span>` : '';
      div = `<div class="mp-mo-div" role="separator"><span class="mp-ln"></span><span class="mp-mo-tag">${icon('swords')}${who}${esc(MULTI[Math.min(5, multi.streak)])}</span><span class="mp-ln"></span></div>`;
    }
    const cls = `mp-mo mp-kf${k.side ? ` mp-${k.side}` : ''}${k.mine ? ' mp-mine' : ''}${i === cur ? ' mp-cur' : ''}`;
    return `${div}<button type="button" class="${cls}"${attrs({ 'data-act': 'match-seek', 'data-at': k.t, 'aria-current': i === cur ? 'true' : null, 'aria-label': `${k.label} at ${fmtGame(k.t)}` })}>`
      + `<span class="mp-tm">${esc(fmtGame(k.t))}</span>${evDisc(k.type, 'mp-sm', k.label)}<span class="mp-lb">${esc(k.label)}</span>${whoHtml(k, record, { mark: true })}</button>`;
  }).join('');
}

// IC-style hover list for a timeline marker: each moment in it with its time and, when the record
// knows them, the champions (assisters, killer -> victim).
function markerCard(g, record) {
  const rows = g.items.slice(0, 6).map((m) => `<span class="mp-card-row">${evDisc(m.type, 'mp-xs', m.label)}`
    + `<span class="mp-card-l">${esc(m.label)}</span><span class="mp-card-t">${esc(fmtGame(m.t))}</span>${whoHtml(m, record)}</span>`).join('');
  const more = g.items.length > 6 ? `<span class="mp-card-more">${esc(`${g.items.length - 6} more`)}</span>` : '';
  const side = g.pos < 0.2 ? ' mp-at-start' : g.pos > 0.8 ? ' mp-at-end' : '';
  return `<span class="mp-mk-card${side}" aria-hidden="true">${rows}${more}</span>`;
}

function momentsListHtml(moments, at, fams, highlightMode, record) {
  const cur = currentIndex(moments, at);
  return momentRows(moments).map(({ m, i, div }) => {
    if (div) return `<div class="mp-mo-div" role="separator"><span class="mp-ln"></span><span class="mp-mo-tag">${ES.icon(m.type, { label: m.label })}${esc(m.label)}</span><span class="mp-ln"></span></div>`;
    const dim = highlightMode && !familyOn(m.family, fams);
    const cls = `mp-mo${i === cur ? ' mp-cur' : ''}${dim ? ' mp-dim' : ''}${m.family === 'result' ? ' mp-end' : ''}${m.type === 'defeat' ? ' mp-end-loss' : ''}`;
    return `<button type="button" class="${cls}"${attrs({ 'data-act': 'match-seek', 'data-at': m.t, 'aria-current': i === cur ? 'true' : null, 'aria-label': `${m.label} at ${fmtGame(m.t)}` })}>`
      + `<span class="mp-tm">${esc(fmtGame(m.t))}</span>${evDisc(m.type, 'mp-sm', m.label)}<span class="mp-lb">${esc(m.label)}</span>${whoHtml(m, record)}</button>`;
  }).join('');
}

function timelineHtml(span, moments, ranges, { at, fams, highlightMode, width, current, record = null }) {
  const p = (t) => (t - span.t0) / (span.t1 - span.t0);
  const markers = moments.filter((m) => m.family !== 'result').map((m) => ({ ...m, pos: p(m.t) }));
  const groups = timelineLayout(markers, width);
  const mk = groups.map((g) => {
    const dim = highlightMode && g.items.every((m) => !familyOn(m.family, fams));
    const list = g.items.map((m) => `${fmtGame(m.t)} ${m.label}`).join(', ');
    return `<button type="button" class="mp-mk${dim ? ' mp-dim' : ''}"${attrs({ style: `left:${pct(g.pos)}`, 'data-act': 'match-seek', 'data-at': g.items[0].t, 'aria-label': list })}>`
      + `${evDisc(g.type, 'mp-mk-ev', (g.items.find((m) => m.type === g.type) || g.items[0]).label)}${g.count > 1 ? `<span class="mp-mk-ct">${esc(g.count)}</span>` : ''}${markerCard(g, record)}</button>`;
  }).join('');
  const segs = ranges.map((r) => {
    const dim = (highlightMode && !familyOn(r.family, fams)) || (!highlightMode && r.family === 'death');
    const cls = `mp-seg${current && current.index === r.index ? ' mp-cur' : dim ? ' mp-dim' : ''}`;
    return `<span class="${cls}"${attrs({ style: `left:${pct(p(r.from))};width:${pct(p(r.to) - p(r.from))}` })}></span>`;
  }).join('');
  const pre = span.t0 < 0 ? `<span class="mp-pre"${attrs({ style: `width:${pct(p(0))}`, title: 'Before the game clock starts' })}></span>` : '';
  const head = num(at) ? `<span class="mp-played"${attrs({ style: `width:${pct(p(at))}` })}></span>` : '';
  const knob = num(at) ? `<span class="mp-playhead"${attrs({ style: `left:${pct(p(at))}` })}></span><span class="mp-knob"${attrs({ style: `left:${pct(p(at))}` })}></span>` : '';
  const ticks = [];
  for (let t = 0; t <= span.t1; t += 300) ticks.push(`<span${attrs({ style: `left:${pct(p(t))}` })}>${esc(fmtGame(t))}</span>`);
  const now = num(at) ? at : span.t0;
  return '<div class="mp-tl">'
    + `<div class="mp-tl-marks">${mk}</div>`
    + `<div class="mp-tl-track" role="slider" tabindex="0"${attrs({ 'data-act': 'match-scrub', 'data-from': span.t0, 'data-to': span.t1, 'aria-label': 'Game time', 'aria-valuemin': span.t0, 'aria-valuemax': span.t1, 'aria-valuenow': round1(now), 'aria-valuetext': fmtGame(now) })}>${head}${pre}${segs}</div>`
    + knob
    + `<div class="mp-tl-axis" aria-hidden="true">${ticks.join('')}</div>`
    + '</div>';
}

//   opts: { at: playhead in game seconds; highlightMode (default true); families: the toggles that
//   are on (default DEFAULT_FAMILIES, deaths off); width: the timeline's width in px, for grouping
//   (default 840); record; playing; minimap (PiP shown, default true); muted; fullscreen; feed: what the Moments
//   list shows, 'mine' (default) or 'all' (every kill, when the record has them) }
export function renderWatch(match, { at = null, highlightMode = true, families = null, width = 840, record = null, playing = false, minimap = true, muted = false, feed = 'mine', fullscreen = false } = {}) {
  const m = match;
  const fams = famSet(families);
  const moments = matchMoments(m, record);
  const ranges = highlightRanges(m);
  const span = timelineSpan(m, moments, ranges);
  const playable = ranges.filter((r) => !highlightMode || familyOn(r.family, fams));
  const current = num(at) ? ranges.find((r) => at >= r.from && at <= r.to) || null : null;

  // Stage: the app puts its <video> in [data-slot="video"] and the minimap in [data-slot="minimap"].
  const poster = (current && current.clip.thumb) || (m.full && m.full.thumb) || (m.cover && m.cover.thumb) || '';
  const curIdx = current ? playable.indexOf(current) : -1;
  const chip = current
    ? `<div class="mp-now">${evDisc(current.type, 'mp-sm', current.clip.label)}<b>${esc(current.clip.label || LABEL[current.type] || 'Highlight')}</b>`
      + `${curIdx >= 0 ? `<span class="mp-faint">${esc(`Highlight ${curIdx + 1} of ${playable.length}`)}</span>` : ''}</div>` : '';
  const pip = m.map && minimap ? `<div class="mp-pip" data-slot="minimap">${m.map.thumb ? `<img src="${esc(m.map.thumb)}" alt="" draggable="false">` : ''}</div>` : '';
  const stage = `<div class="mp-stage" data-slot="video">${poster ? `<img class="mp-poster" src="${esc(poster)}" alt="" draggable="false">` : ''}${pip}${chip}</div>`;

  const tl = span ? timelineHtml(span, moments, ranges, { at, fams, highlightMode, width, current, record })
    : '<p class="mp-note">No game clock for this match (it needs the minimap recording), so the timeline is off.</p>';

  const total = pos0(m.gameTime) ? fmtDuration(m.gameTime) : span ? fmtGame(span.t1) : '';
  const btn = (act, glyph, label, extra = {}) => `<button type="button" class="mp-icon-btn"${attrs({ 'data-act': act, title: label, 'aria-label': label, ...extra })}>${icon(glyph)}</button>`;
  const controls = '<div class="mp-controls">'
    + btn('match-play', playing ? 'pause' : 'play', playing ? 'Pause' : 'Play')
    + btn('match-prev', 'skip-back', highlightMode ? 'Previous highlight' : 'Previous moment')
    + btn('match-next', 'skip-forward', highlightMode ? 'Next highlight' : 'Next moment')
    + (span ? `<span class="mp-time">${esc(fmtGame(num(at) ? at : span.t0))}<span class="mp-faint"> / ${esc(total)}</span></span>` : '')
    + '<span class="mp-grow"></span>'
    + btn('match-mute', muted ? 'volume-x' : 'volume-2', muted ? 'Unmute (M)' : 'Mute (M)', { 'aria-pressed': muted ? 'true' : 'false' })
    + `<button type="button" class="mp-btn mp-subtle"${attrs({ 'data-act': 'match-clip', title: 'Save a clip here' })}>${icon('scissors')}<span class="mp-clip-l">Clip</span></button>`
    + (m.map ? btn('match-minimap', 'map', minimap ? 'Hide the minimap' : 'Show the minimap', { 'data-on': minimap ? 'false' : 'true', 'aria-pressed': minimap ? 'true' : 'false' }) : '')
    + btn('match-fullscreen', fullscreen ? 'minimize' : 'maximize', fullscreen ? 'Exit full screen (F or Esc)' : 'Full screen (F)')
    + '</div>';

  // Highlight mode: switch, family toggles, what it will play.
  const present = new Set(ranges.map((r) => toggleOf(r.family)));
  const toggles = TOGGLES.filter(([f]) => present.has(f)).map(([f, text]) => {
    const on = fams.has(f);
    return `<button type="button" class="mp-tgl${on ? ' mp-on' : ''}"${attrs({ 'data-act': 'match-family-toggle', 'data-family': f, 'aria-pressed': on ? 'true' : 'false', disabled: !highlightMode })}>${evDisc(f === 'objective' ? 'dragon' : f === 'structure' ? 'turret' : f, 'mp-sm')}<span class="mp-tgl-l">${esc(text)}</span></button>`;
  }).join('');
  const sum = !ranges.length ? 'No highlights in this match'
    : highlightMode ? `<b>${esc(playable.length)}</b> of ${esc(ranges.length)} highlights · <b>${esc(fmtDuration(unionLength(playable)))}</b> to watch`
      : 'Off: the full recording plays from start to end';
  const hm = '<section class="mp-hm" aria-label="Highlight mode">'
    + `<div class="mp-hm-row"><h2 class="mp-h2">Highlight mode</h2><span class="mp-grow"></span>`
    + `<button type="button" class="mp-switch${highlightMode ? ' mp-on' : ''}" role="switch"${attrs({ 'data-act': 'match-highlight-mode', 'data-on': highlightMode ? 'false' : 'true', 'aria-checked': highlightMode ? 'true' : 'false', 'aria-label': 'Highlight mode', disabled: !ranges.length })}><span class="mp-thumb"></span></button></div>`
    + '<p class="mp-hm-desc">Plays each highlight in the full recording and skips the time between them.</p>'
    + (toggles ? `<div class="mp-hm-types">${toggles}</div>` : '')
    + `<div class="mp-hm-sum">${sum}</div>`
    + '</section>';

  const shown = moments.filter((x) => x.type !== 'multikill' && x.type !== 'ace');
  const kf = feed === 'all' ? killFeed(record) : null;
  const mineList = moments.length ? momentsListHtml(moments, at, fams, highlightMode, record)
    : '<p class="mp-note">No moments with a game time for this match.</p>';
  // All kills without a kill feed yet (no record, or match history still pending): your moments,
  // with the reason.
  const list = kf && kf.kills.length ? feedListHtml(kf.kills, at, record)
    : `${kf ? `<p class="mp-note mp-feed-note">${icon('info')}<span>${esc(kf.reason)} Showing your moments.</span></p>` : ''}${mineList}`;
  const n = kf && kf.kills.length ? kf.kills.length : shown.length;
  const seg = `<div class="mp-feed" role="group" aria-label="Moments to show">${FEEDS.map(([id, text]) => {
    const on = id === (kf ? 'all' : 'mine');
    return `<button type="button" class="mp-feed-b${on ? ' mp-on' : ''}"${attrs({ 'data-act': 'match-feed', 'data-feed': id, 'aria-pressed': on ? 'true' : 'false' })}>${esc(text)}</button>`;
  }).join('')}</div>`;
  const side = `<aside class="mp-side">${hm}<div class="mp-ml-head"><h2 class="mp-h2">Moments</h2>${n ? `<span class="mp-ct">${esc(n)}</span>` : ''}<span class="mp-grow"></span>${seg}</div><div class="mp-ml">${list}</div></aside>`;

  return `<div class="mp-watch"><div class="mp-player">${stage}${tl}${controls}</div>${side}</div>`;
}

// ------------------------------------------------------------------ Scoreboard

const NO_RECORD = 'Stats arrive after your next game with the League client open';

// Your team's total gold minus the enemy's, per minute, from frames.totalGold. Its keys are team ids
// (100, 200) or participant ids (summed by their team). [] when the record has no frames.
export function goldDiffSeries(record) {
  const tg = record && record.frames && record.frames.totalGold;
  if (!tg || typeof tg !== 'object') return [];
  const myTeam = record.me && num(record.me.team) ? record.me.team : 100;
  const teamOf = new Map((record.participants || []).map((p) => [String(p.participantId), p.team]));
  const sums = { mine: [], theirs: [] };
  for (const [k, arr] of Object.entries(tg)) {
    if (!Array.isArray(arr)) continue;
    const team = k === '100' || k === '200' ? Number(k) : teamOf.get(k);
    if (team == null) continue;
    const side = team === myTeam ? sums.mine : sums.theirs;
    arr.forEach((v, i) => { if (num(v)) side[i] = (side[i] || 0) + v; });
  }
  const n = Math.min(sums.mine.length, sums.theirs.length);
  const out = [];
  for (let i = 0; i < n; i += 1) if (num(sums.mine[i]) && num(sums.theirs[i])) out.push(sums.mine[i] - sums.theirs[i]); else break;
  return out;
}

const STEPS = [500, 1000, 2000, 2500, 5000, 10000, 20000];
const f1 = (v) => String(round1(v));

// The gold-difference graph in a w × h box: x is the minute, y the difference (0 at zeroY).
// frames: the per-minute differences (goldDiffSeries), or a record's frames object keyed by team id.
// The line is split where it crosses zero: pos (ahead, drawn in the ally colour) stays at or above
// zeroY, neg (behind, the enemy colour) at or below; posArea/negArea fill between it and zero.
//   -> { pos, neg, posArea, negArea, zeroY, yMin, yMax, step, points: [{ x, y, v, minute }] }
export function goldPath(frames, w, h, { myTeam = 100 } = {}) {
  const series = Array.isArray(frames) ? frames.filter(num) : goldDiffSeries({ frames: frames || {}, me: { team: myTeam } });
  const empty = { pos: '', neg: '', posArea: '', negArea: '', zeroY: h / 2, yMin: 0, yMax: 0, step: 0, points: [] };
  if (series.length < 2) return empty;
  const hi = Math.max(0, ...series);
  const lo = Math.min(0, ...series);
  const step = STEPS.find((s) => (Math.ceil(hi / s) - Math.floor(lo / s)) <= 4) || STEPS[STEPS.length - 1];
  const yMax = Math.max(Math.ceil(hi / step) * step, hi > 0 ? step : 0);
  const yMin = Math.min(Math.floor(lo / step) * step, lo < 0 ? -step : 0);
  const range = yMax - yMin || step;
  const y = (v) => ((yMax - v) / range) * h;
  const zeroY = y(0);
  const points = series.map((v, i) => ({ x: (i / (series.length - 1)) * w, y: y(v), v, minute: i }));
  const segs = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if ((a.v > 0 && b.v < 0) || (a.v < 0 && b.v > 0)) {
      const c = { x: a.x + (b.x - a.x) * (a.v / (a.v - b.v)), y: zeroY, v: 0 };
      segs.push([a, c, a.v > 0], [c, b, b.v > 0]);
    } else segs.push([a, b, a.v + b.v >= 0]);
  }
  const runs = { up: [], down: [] };
  let cur = null;
  for (const [a, b, up] of segs) {
    if (cur && cur.up === up && cur.pts[cur.pts.length - 1] === a) cur.pts.push(b);
    else { cur = { up, pts: [a, b] }; runs[up ? 'up' : 'down'].push(cur); }
  }
  const line = (list) => list.map((r) => r.pts.map((pt, i) => `${i ? 'L' : 'M'}${f1(pt.x)} ${f1(pt.y)}`).join(' ')).join(' ');
  const area = (list) => list.map((r) => `M${f1(r.pts[0].x)} ${f1(zeroY)} ${r.pts.map((pt) => `L${f1(pt.x)} ${f1(pt.y)}`).join(' ')} L${f1(r.pts[r.pts.length - 1].x)} ${f1(zeroY)} Z`).join(' ');
  return { pos: line(runs.up), neg: line(runs.down), posArea: area(runs.up), negArea: area(runs.down), zeroY, yMin, yMax, step, points };
}

function goldHtml(record) {
  const series = goldDiffSeries(record);
  const head = '<div class="mp-sec-head"><h2 class="mp-h2">Gold difference</h2><span class="mp-sec-sub">Your team minus the enemy team, each minute</span>';
  if (series.length < 2) return `<section class="mp-gold">${head}</div><p class="mp-note">The graph arrives with the match timeline from the League client.</p></section>`;
  const W = 720; const H = 120; const L = 44; const R = 56; const T = 18; const B = 22;
  const w = W - L - R; const h = H - T - B;
  const g = goldPath(series, w, h);
  const grid = [];
  for (let v = g.yMin; v <= g.yMax; v += g.step) {
    const yy = f1(T + ((g.yMax - v) / (g.yMax - g.yMin)) * h);
    grid.push(`<line class="${v === 0 ? 'mp-g-zero' : 'mp-g-grid'}" x1="${L}" x2="${L + w}" y1="${yy}" y2="${yy}"></line>`
      + `<text x="${L - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${esc(v === 0 ? '0' : `${v > 0 ? '+' : MINUS}${Math.abs(v) / 1000}K`)}</text>`);
  }
  const xs = [];
  for (let mi = 0; mi < series.length; mi += 5) xs.push(`<text x="${f1(L + (mi / (series.length - 1)) * w)}" y="${H - 4}" text-anchor="middle">${esc(`${mi}:00`)}</text>`);
  const peak = g.points.reduce((b, p) => (p.v > b.v ? p : b), g.points[0]);
  const end = g.points[g.points.length - 1];
  const dot = (p, cls) => `<circle class="${cls}" cx="${f1(L + p.x)}" cy="${f1(T + p.y)}" r="3"></circle>`;
  const labels = [];
  if (peak.v > 0 && peak !== end) labels.push(`${dot(peak, 'mp-g-dot-pos')}<text class="mp-g-lbl" x="${f1(L + peak.x)}" y="${f1(T + peak.y - 8)}" text-anchor="middle">${esc(fmtSigned(peak.v))}</text>`);
  labels.push(`${dot(end, end.v >= 0 ? 'mp-g-dot-pos' : 'mp-g-dot-neg')}<text class="mp-g-lbl" x="${f1(L + end.x + 8)}" y="${f1(T + end.y)}" dominant-baseline="middle">${esc(fmtSigned(end.v))}</text>`);
  const svg = `<svg class="mp-gold-svg" viewBox="0 0 ${W} ${H}" role="img"${attrs({ 'aria-label': `Gold difference by minute, ending at ${fmtSigned(end.v)}` })}>`
    + grid.join('') + xs.join('')
    + `<g transform="translate(${L} ${T})"><path class="mp-g-area-pos" d="${g.posArea}"></path><path class="mp-g-area-neg" d="${g.negArea}"></path>`
    + `<path class="mp-g-pos" d="${g.pos}"></path><path class="mp-g-neg" d="${g.neg}"></path></g>`
    + labels.join('') + '</svg>';
  const legend = '<span class="mp-legend"><span class="mp-key"><span class="mp-sw mp-sw-pos"></span>Ahead</span><span class="mp-key"><span class="mp-sw mp-sw-neg"></span>Behind</span></span>';
  return `<section class="mp-gold">${head}${legend}</div>${svg}</section>`;
}

const byRole = (a, b) => {
  const ia = ROLE_ORDER.indexOf(String(a.role || '').toUpperCase());
  const ib = ROLE_ORDER.indexOf(String(b.role || '').toUpperCase());
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a.participantId || 0) - (b.participantId || 0);
};
const sumOf = (list, k) => list.reduce((s, p) => s + (num(p[k]) ? p[k] : 0), 0);
const cellNum = (v, cls = '') => `<td class="mp-r mp-v${cls}">${num(v) ? esc(fmtInt(v)) : ''}</td>`;

//   opts: { icons (see iconsOf) }
export function renderScoreboard(match, record = null, opts = {}) {
  const icons = iconsOf(opts);
  const ps = record && Array.isArray(record.participants) ? record.participants.filter((p) => p && p.champion) : [];
  if (!ps.length) {
    return `<div class="mp-sb-page"><div class="mp-sb-empty">${icon('info')}<p>${esc(NO_RECORD)}</p></div></div>`;
  }
  const myTeam = record.me && num(record.me.team) ? record.me.team : (ps.find((p) => p.isMe) || ps[0]).team;
  const mine = ps.filter((p) => p.team === myTeam).sort(byRole);
  const theirs = ps.filter((p) => p.team !== myTeam).sort(byRole);
  const maxDmg = Math.max(1, ...ps.map((p) => (num(p.damage) ? p.damage : 0)));
  const teams = Array.isArray(record.teams) ? record.teams : [];
  const teamRec = (id) => teams.find((t) => t && t.teamId === id) || null;
  const myResult = RESULT[record.result] || match.result || null;
  const hasItems = ps.some((p) => anyItem(p.items));
  const hasVision = ps.some((p) => pos0(p.vision));
  const cols = 6 + (hasVision ? 1 : 0) + (hasItems ? 1 : 0);

  const objHtml = (t) => {
    if (!t) return '';
    const o = [['dragons', 'dragon', 'Dragons'], ['heralds', 'herald', 'Rift Heralds'], ['barons', 'baron', 'Barons'], ['towers', 'turret', 'Towers']]
      .filter(([k]) => num(t[k]));
    return `<span class="mp-objs">${o.map(([k, type, label]) => `<span class="mp-objstat${t[k] ? '' : ' mp-zero'}"${attrs({ title: `${label}: ${t[k]}` })}>${evDisc(type, 'mp-xs')}${esc(t[k])}</span>`).join('')}</span>`;
  };
  const teamRow = (list, isMine) => {
    const t = teamRec(isMine ? myTeam : (theirs[0] || {}).team);
    const res = t && typeof t.win === 'boolean' ? (t.win ? 'Victory' : 'Defeat') : isMine ? myResult : myResult === 'Victory' ? 'Defeat' : myResult === 'Defeat' ? 'Victory' : null;
    const kills = t && num(t.kills) ? t.kills : sumOf(list, 'kills');
    const dmg = t && num(t.damage) ? t.damage : sumOf(list, 'damage');
    const gold = t && num(t.gold) ? t.gold : sumOf(list, 'gold');
    return `<tr class="mp-sb-team"><td colspan="2"><span class="mp-team"><span class="mp-tdot ${isMine ? 'mp-ally' : 'mp-enemy'}"></span>${isMine ? 'Your team' : 'Enemy team'}`
      + `${res ? `<span class="mp-res${toneOfResult(res)}">${esc(res)}</span>` : ''}</span></td>`
      + `<td><span class="mp-tot"><b>${esc(kills)}</b>kills</span></td><td><span class="mp-tot"><b>${esc(fmtInt(dmg))}</b></span></td>`
      + `<td class="mp-r"><span class="mp-tot"><b>${esc(fmtInt(gold))}</b></span></td>`
      + `<td colspan="${cols - 5}" class="mp-r">${objHtml(t)}</td></tr>`;
  };
  const playerRow = (p, isMine) => {
    const me = p.isMe || (record.me && p.participantId === record.me.participantId);
    const k = num(p.kills) ? p.kills : 0; const d = num(p.deaths) ? p.deaths : 0; const a = num(p.assists) ? p.assists : 0;
    const sep = '<span class="mp-sep"> / </span>';
    const dmg = num(p.damage) ? p.damage : null;
    const items = hasItems ? `<td>${itemsHtml(Array.isArray(p.items) ? p.items : [], icons, 'mp-items mp-items-sm', 'mp-item')}</td>` : '';
    return `<tr class="mp-sb-row${me ? ' mp-me' : ''}"><td class="mp-role">${esc(roleName(p.role))}</td>`
      + `<td><span class="mp-pl">${champFace(p.champion, p.icon || p.championIcon, ' mp-face-sm')}${buildHtml(buildOfPlayer(p), icons, 'mp-build mp-build-sm')}<span class="mp-nm">${esc(p.champion)}</span>${me && p.name ? `<span class="mp-you">${esc(p.name)}</span>` : ''}</span></td>`
      + `<td class="mp-v"><span class="mp-kda">${esc(k)}${sep}<span class="mp-d">${esc(d)}</span>${sep}${esc(a)}</span><span class="mp-ratio">${esc(kdaRatio(k, d, a))}</span></td>`
      + `<td><span class="mp-dmg"><span class="mp-v">${dmg !== null ? esc(fmtInt(dmg)) : ''}</span>${dmg !== null ? `<span class="mp-bar"><i class="${isMine ? 'mp-ally' : 'mp-enemy'}"${attrs({ style: `width:${pct(dmg / maxDmg)}` })}></i></span>` : ''}</span></td>`
      + cellNum(p.gold) + cellNum(p.cs) + (hasVision ? cellNum(p.vision) : '') + items + '</tr>';
  };
  const colgroup = `<colgroup><col class="mp-c-role"><col class="mp-c-champ"><col class="mp-c-kda"><col class="mp-c-dmg"><col class="mp-c-gold"><col class="mp-c-cs">${hasVision ? '<col class="mp-c-vis">' : ''}${hasItems ? '<col class="mp-c-items">' : ''}</colgroup>`;
  const th = `<thead><tr><th>Role</th><th>Champion</th><th>K/D/A</th><th>Damage to champions</th><th class="mp-r">Gold</th><th class="mp-r">CS</th>${hasVision ? '<th class="mp-r">Vision</th>' : ''}${hasItems ? '<th>Items</th>' : ''}</tr></thead>`;
  const table = `<table class="mp-sb">${colgroup}${th}<tbody>${teamRow(mine, true)}${mine.map((p) => playerRow(p, true)).join('')}`
    + `<tr class="mp-gap"><td${attrs({ colspan: cols })}></td></tr>${teamRow(theirs, false)}${theirs.map((p) => playerRow(p, false)).join('')}</tbody></table>`;

  // Damage share: your team, biggest first, bars scaled to the top share.
  const teamDmg = sumOf(mine, 'damage');
  const share = teamDmg > 0 ? (() => {
    const list = mine.filter((p) => num(p.damage)).sort((a, b) => b.damage - a.damage);
    const top = list.length ? list[0].damage : 1;
    return '<section class="mp-share"><div class="mp-sec-head"><h2 class="mp-h2">Damage share</h2>'
      + `<span class="mp-sec-sub">${esc(`Your team, ${fmtInt(teamDmg)} to champions`)}</span></div><div class="mp-share-list">`
      + list.map((p) => `<div class="mp-share-row">${champFace(p.champion, p.icon || p.championIcon, ' mp-face-sm')}<span class="mp-nm">${esc(p.champion)}</span>`
        + `<span class="mp-bar mp-bar-lg"><i class="mp-ally"${attrs({ style: `width:${pct(p.damage / top)}` })}></i></span>`
        + `<span class="mp-pc">${esc(`${Math.round((p.damage / teamDmg) * 100)}%`)}</span><span class="mp-k">${esc(kShort(p.damage))}</span></div>`).join('')
      + '</div></section>';
  })() : '';

  return `<div class="mp-sb-page">${table}<div class="mp-charts">${goldHtml(record)}${share}</div></div>`;
}

// ------------------------------------------------------------------ Highlights, page

// The tiles grid: the Matches view's expanded panel (views/matches.js, needs css/views/matches.css),
// so its actions (clip-play, match-family, match-select, ...) mean the same here.
export function renderHighlights(match, opts = {}) {
  return `<div class="mv-view mp-highlights">${renderMatchPanel(match, opts)}</div>`;
}

//   opts: { tab: 'watch' | 'scoreboard' | 'highlights', record, now, icons, and renderWatch's
//   options (at, highlightMode, families, width, playing, minimap), and renderHighlights' (family,
//   selecting, selected, target) }
export function renderMatchPage(match, opts = {}) {
  const { tab = 'watch', record = null, now = Date.now() } = opts;
  const icons = iconsOf(opts);
  const t = TABS.some(([id]) => id === tab) ? tab : 'watch';
  const body = t === 'scoreboard' ? renderScoreboard(match, record, { icons })
    : t === 'highlights' ? renderHighlights(match, { family: opts.family, selecting: opts.selecting, selected: opts.selected, target: opts.target })
      : renderWatch(match, { ...opts, record });
  return `<div class="mp-page"${attrs({ 'data-key': match.key, 'data-tab': t })}>${renderMatchHeader(match, record, { now, icons })}${renderMatchTabs(match, t)}<div class="mp-body">${body}</div></div>`;
}
