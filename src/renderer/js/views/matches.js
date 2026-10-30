// Matches view: one row per League match (result, champion, K/D/A, highlights, files on disk),
// the expanded grid of its highlights, and the right-click menus for both.
// Pure functions that return HTML strings (no DOM, no IPC), so the view is unit-tested in Node
// (test/matches-view-test.js) and previewed without the app (test/ui/preview/matches.html).
// Input is groupLibrary(items).matches from js/lib/group.js.
// Every control carries data-act (one of ACTIONS) plus data-key (the match) and/or data-path (a
// file), so app.js wires the whole view with one delegated listener.
// Stats that weren't recorded are left out, never shown as 0: today's matches have champion, result,
// K/D/A and length; CS, level and vision come only from newer builds; damage, gold and items later.

import { icon } from '../core/icons.js';
import '../../events.js'; // globalThis.EventStyles: the event tokens
import { RANK, familyOf, primaryMarker } from '../lib/group.js';
import { describeName } from '../lib/titles.js';

// The data-act names used in this view. What each should do in app.js:
//   match-toggle        expand or collapse the match (row click, chevron, "+N"); data-key
//   match-play          Play match: openMatchPage(key, { highlightMode: false })
//   match-highlights    Watch highlights: openMatchPage(key, { highlightMode: true })
//   match-menu          open renderMatchMenu(match) at the button (also on right-click of the row)
//   match-family        show one family in the expanded grid; data-family = all|kill|death|assist|objective|multikill
//   match-select        toggle select mode in the expanded grid (tiles then use clip-select)
//   match-make-video    api.makeHighlightVideo(map.path), the existing "Create highlight video" flow
//   match-folder        api.showInFolder(map || full || first file)
//   match-favorite      star or unstar the match (data-on="true" means add)
//   match-delete-full   delete only the full recording, after a confirm; the highlights stay
//   match-delete        delete the whole match, after a confirm that lists counts and sizes
//                       (data-inferred="true": the group was guessed by time, so list every file)
//   clip-play           openPlayer(data-path); right-click on it opens renderClipMenu(item)
//   clip-select         in select mode: toggle data-path in the selection
//   clip-play-in-match  openMatchOf(item, { mapAt: item.map.offset, highlightMode: false })
//   clip-copy           copyFile(data-path)
//   clip-share          shareFlow(item, anchor)
//   clip-favorite       toggleFavorite(data-path)
//   clip-folder         api.showInFolder(data-path)
//   clip-delete         deleteVideo(data-path)
//   filter-mode         set filter.mode to data-mode ('' = all)            (renderMatchHeader)
//   filter-result       <select>: set filter.result ('' | Victory | Defeat)
//   filter-champion     <select>: set filter.champion ('' = all)
//   filter-query        <input>: set filter.query
//   filter-sort         <select>: set filter.sort (newest | oldest | longest | largest)
//   filter-clear        reset every filter (shown when filters hide every match)
export const ACTIONS = Object.freeze([
  'match-toggle', 'match-play', 'match-highlights', 'match-menu', 'match-family', 'match-select', 'match-make-video',
  'match-folder', 'match-favorite', 'match-delete-full', 'match-delete',
  'clip-play', 'clip-select', 'clip-play-in-match', 'clip-copy', 'clip-share', 'clip-favorite', 'clip-folder', 'clip-delete',
  'filter-mode', 'filter-result', 'filter-champion', 'filter-query', 'filter-sort', 'filter-clear',
]);

// The expanded grid's filter chips, in order (counts come from match.counts).
export const FAMILIES = Object.freeze([
  ['kill', 'Kills'], ['death', 'Deaths'], ['assist', 'Assists'], ['objective', 'Objectives'], ['multikill', 'Multikills'],
]);

// ------------------------------------------------------------------ formatting (same output as app.js)

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const pad2 = (n) => String(n).padStart(2, '0');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

export function fmtSize(bytes) {
  if (!bytes) return '0 MB';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(bytes >= 104857600 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const fmtSeconds = (sec) => (Math.round(sec || 0) < 60 ? `${Math.round(sec || 0)} s` : fmtDuration(sec));
const fmtClock = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const startOfDay = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

// "Saturday 17 October" (the year only when it isn't this year's).
function fmtDay(ms, now) {
  const d = new Date(ms);
  const year = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

const MODE_NAMES = { CLASSIC: "Summoner's Rift", ARAM: 'ARAM', CHERRY: 'Arena', SWIFTPLAY: 'Swiftplay', URF: 'URF', ARURF: 'ARURF', ONEFORALL: 'One for All', PRACTICETOOL: 'Practice Tool', TUTORIAL: 'Tutorial', NEXUSBLITZ: 'Nexus Blitz', ULTBOOK: 'Ultimate Spellbook', STRAWBERRY: 'Swarm' };
export function modeName(mode) {
  if (!mode) return '';
  return MODE_NAMES[String(mode).toUpperCase()] || String(mode).charAt(0) + String(mode).slice(1).toLowerCase();
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

// A DOM-safe id for a match key (keys are file paths).
function domId(key) {
  let h = 2166136261;
  for (const ch of String(key)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return `mv-p-${h.toString(36)}`;
}

// ------------------------------------------------------------------ moments

// The token per moment comes from events.js (EventStyles.glyphId), shared with the player.
const ES = globalThis.EventStyles;
const TONE = { kill: 'mv-kill', assist: 'mv-assist', death: 'mv-death', multikill: 'mv-hl', objective: 'mv-obj', structure: 'mv-struct', bookmark: 'mv-bookmark' };
const toneOf = (type) => (type === 'victory' ? 'mv-win' : type === 'defeat' ? 'mv-loss' : TONE[familyOf(type)] || 'mv-struct');

function evDisc(type, small, label = '') {
  return `<span class="mv-ev ${toneOf(type)}${small ? ' mv-sm' : ''}">${ES.icon(type, { label, small: true })}</span>`;
}

// The moments a clip shows, in time order, one per glyph; a multikill hides its single kills.
export function clipMoments(item) {
  let types = (item.markers || []).filter((m) => m && m.type).slice().sort((a, b) => (a.t || 0) - (b.t || 0)).map((m) => m.type);
  if (!types.length) {
    const p = primaryMarker(item);
    if (p && p.type) types = [p.type];
  }
  if (types.some((t) => familyOf(t) === 'multikill')) types = types.filter((t) => t !== 'kill');
  const seen = new Set();
  return types.filter((t) => {
    const g = ES.glyphId(t);
    if (seen.has(g)) return false;
    seen.add(g);
    return true;
  }).slice(0, 3);
}

// The label of a clip's first moment of a type (tells drakes and multikills apart).
const labelOf = (item, t) => ((item.markers || []).find((m) => m && m.type === t) || {}).label || '';
const glyphs = (item, small) => clipMoments(item).map((t) => evDisc(t, small, labelOf(item, t))).join('');

// The highlights shown in a row: the 5 biggest moments (deaths don't count), in game order.
export function stripClips(clips, n = 5) {
  const score = (c) => {
    const marks = (c.markers || []).filter((m) => m && m.type);
    const types = marks.length ? marks.map((m) => m.type) : [c.momentType];
    return types.reduce((s, t) => s + (t === 'death' ? 0 : RANK[t] || 0), 0);
  };
  return clips.map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, n)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.c);
}

// When a clip happened: in-game time when the match has a game clock, else the time it was saved.
function clipWhen(item) {
  if (num(item.gameAt)) return { text: fmtDuration(item.gameAt), title: `${fmtDuration(item.gameAt)} in game` };
  if (num(item.created)) return { text: fmtClock(item.created), title: `Saved at ${fmtClock(item.created)}` };
  return { text: '', title: '' };
}

// ------------------------------------------------------------------ filters

const isFiltered = (f) => Boolean(f.result || f.champion || f.mode || (f.query && f.query.trim()) || f.favorites);

function normFilter(filter) {
  const f = filter || {};
  const pick = (v) => (v && v !== 'all' ? v : '');
  return { result: pick(f.result), champion: pick(f.champion), mode: pick(f.mode), query: f.query || '', favorites: Boolean(f.favorites), sort: f.sort || 'newest' };
}

const lower = (s) => String(s || '').toLowerCase();

// Matches that pass the filter, in the filter's sort order.
//   filter: { result: 'Victory'|'Defeat', champion, mode: 'CLASSIC'|'ARAM'|'CHERRY'…, query, favorites, sort }
export function filterMatches(matches, filter) {
  const f = normFilter(filter);
  const q = lower(f.query.trim());
  const list = (matches || []).filter((m) => {
    const st = m.stats || {};
    if (f.result && m.result !== f.result) return false;
    if (f.champion && lower(m.champion) !== lower(f.champion)) return false;
    if (f.mode && lower(st.gameMode) !== lower(f.mode)) return false;
    if (f.favorites && !m.favorite) return false;
    if (!q) return true;
    const words = [m.champion, m.result, modeName(st.gameMode), st.queueName, ...m.files.map((i) => i.name), ...m.clips.map((c) => describeName(c).title), ...m.clips.map((c) => c.label)];
    return words.some((w) => lower(w).includes(q));
  });
  const by = {
    newest: (a, b) => b.start - a.start,
    oldest: (a, b) => a.start - b.start,
    longest: (a, b) => (b.gameTime || 0) - (a.gameTime || 0) || b.start - a.start,
    largest: (a, b) => (b.size || 0) - (a.size || 0) || b.start - a.start,
  }[f.sort] || ((a, b) => b.start - a.start);
  return list.sort(by);
}

// ------------------------------------------------------------------ the match row

const toneClass = (result) => (result === 'Victory' ? ' mv-win' : result === 'Defeat' ? ' mv-loss' : '');
const isPlayable = (m) => Boolean(m.map || m.full);
const hasKda = (st) => Boolean(st) && num(st.kills) && num(st.deaths) && num(st.assists);
const hasPanel = (m) => m.clips.length > 0 || m.extras.length > 0;

function champHtml(m) {
  const st = m.stats || {};
  const name = m.champion || '';
  const lvl = num(st.level) && st.level > 0 ? `<span class="mv-lvl" title="Level ${esc(st.level)}">${esc(st.level)}</span>` : '';
  const face = m.championIcon
    ? `<span class="mv-champ"><img src="${esc(m.championIcon)}" alt="${esc(name)}" draggable="false"></span>`
    : `<span class="mv-champ mv-champ-ph" aria-hidden="true">${name ? esc(name.charAt(0).toUpperCase()) : icon('gamepad-2')}</span>`;
  return `<span class="mv-champ-wrap"${attrs({ title: name || null })}>${face}${lvl}</span>`;
}

function kdaHtml(st) {
  const sep = '<span class="mv-sep"> / </span>';
  return `<span class="mv-kda"${attrs({ title: `${st.kills} kills, ${st.deaths} deaths, ${st.assists} assists` })}>${esc(st.kills)}${sep}<span class="mv-d">${esc(st.deaths)}</span>${sep}${esc(st.assists)}</span>`;
}

const kdaRatio = (st) => (st.deaths > 0 ? `${((st.kills + st.assists) / st.deaths).toFixed(2)} KDA` : 'Perfect KDA');
const kShort = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n)));
const cell = (area, value, label, extra = '') => `<div class="mv-st mv-c-${area}"${extra}><span class="mv-v">${value}</span><span class="mv-l">${esc(label)}</span></div>`;

// The stats a match can show: only what was recorded (Phase 1: CS and vision from newer builds).
// Field names follow the planned MatchRow (P1 §2.3): cs + csApprox, damage + damageShare, gold, vision, items.
// Items are ids (the match record's; their icons come from opts.icons) or, from older callers, an
// icon URL or { icon, name }.
const itemIcon = (it) => (typeof it === 'string' ? it : it && it.icon) || null;
const hasItem = (it) => (typeof it === 'number' ? it > 0 : Boolean(itemIcon(it)));

// Item, summoner-spell and rune icons. icons: (kind 'item' | 'spell' | 'rune', id) -> { url, name },
// a URL, or null while it isn't cached; an icon that isn't there yet leaves an empty square.
function iconInfo(icons, kind, id) {
  if (typeof icons !== 'function' || !(num(id) && id > 0)) return null;
  let v = null;
  try { v = icons(kind, id); } catch { v = null; }
  if (typeof v === 'string') return v ? { url: v, name: null } : null;
  return v && typeof v.url === 'string' && v.url ? v : null;
}

// One square: cls is its class (mv-item, mp-item, ...); title names it once the icon list does.
export function iconSlot(cls, kind, id, icons, { title = null } = {}) {
  const info = iconInfo(icons, kind, id);
  const name = (info && info.name) || title;
  return `<span class="${cls}"${attrs({ title: name || null })}>${info ? `<img src="${esc(info.url)}" alt="" draggable="false">` : ''}</span>`;
}

// The seven item squares (six slots and the trinket); ids, URLs or { icon, name }.
export function itemsHtml(items, icons, cls, slotCls) {
  const slot = (it) => (typeof it === 'number' || it == null ? iconSlot(slotCls, 'item', it, icons)
    : `<span class="${slotCls}"${attrs({ title: typeof it === 'object' ? it.name : null })}>${itemIcon(it) ? `<img src="${esc(itemIcon(it))}" alt="" draggable="false">` : ''}</span>`);
  return `<div class="${cls}">${items.slice(0, 7).map(slot).join('')}</div>`;
}

// Summoner spells over the runes (keystone, secondary tree): a 2×2 block beside a champion face,
// as in the client. '' when none of them is known.
export function buildHtml({ spells = null, keystone = null, subStyle = null } = {}, icons, cls) {
  const sp = Array.isArray(spells) ? spells.slice(0, 2) : [];
  const ok = (v) => num(v) && v > 0;
  if (!sp.some(ok) && !ok(keystone) && !ok(subStyle)) return '';
  return `<span class="${cls}" aria-hidden="true">${iconSlot('gi gi-spell', 'spell', sp[0], icons)}${iconSlot('gi gi-spell', 'spell', sp[1], icons)}`
    + `${iconSlot('gi gi-key', 'rune', keystone, icons)}${iconSlot('gi gi-tree', 'rune', subStyle, icons)}</span>`;
}

function statValues(m) {
  const st = m.stats || {};
  const v = {};
  if (num(st.cs) && st.cs > 0) v.cs = st.cs;
  if (num(st.damage) && st.damage > 0) v.dmg = st.damage;
  if (num(st.gold) && st.gold > 0) v.gold = st.gold;
  const vision = num(st.vision) ? st.vision : num(st.wardScore) ? st.wardScore : 0;
  if (vision > 0) v.vision = vision;
  if (Array.isArray(st.items) && st.items.some(hasItem)) v.items = st.items;
  return v;
}

// Classes for a list of rows: one per stat column that any of them has, so the columns line up
// across rows while columns no row has take no room (Phase 1 has no damage or gold yet).
export function matchColumns(matches) {
  const has = new Set();
  for (const m of matches || []) for (const k of Object.keys(statValues(m))) has.add(k);
  for (const m of matches || []) if (buildOf(m)) has.add('build');
  return ['build', 'cs', 'dmg', 'gold', 'vision'].filter((k) => has.has(k)).map((k) => `mv-has-${k}`).join(' ');
}

// Spells and runes, from the match record's row (group.js withRecordStats), or null.
function buildOf(m) {
  const st = m.stats || {};
  const ok = (v) => num(v) && v > 0;
  return (Array.isArray(st.spells) && st.spells.some(ok)) || ok(st.keystone) || ok(st.subStyle)
    ? { spells: st.spells, keystone: st.keystone, subStyle: st.subStyle } : null;
}

// One cell per recorded stat, each in its own grid area, so a missing one leaves its column empty
// instead of shifting the others out of line with the rows around it.
function statCells(m, icons) {
  const st = m.stats;
  const out = [];
  const mins = num(m.gameTime) && m.gameTime > 0 ? m.gameTime / 60 : 0;
  if (hasKda(st)) {
    const kp = num(st.kp) && st.kp > 0 ? ` · ${Math.round(st.kp * 100)}% KP` : '';
    out.push(cell('kda', kdaHtml(st), `${kdaRatio(st)}${kp}`));
  } else {
    out.push(cell('kda', `<span class="mv-name">${esc(m.champion || 'League match')}</span>`, 'No stats saved', ' title="No post-game stats were saved with this match"'));
  }
  const v = statValues(m);
  if (v.cs) {
    // In game the count is rounded down to 10 (Live Client), so it's approximate until post-game data arrives.
    const approx = st.csApprox !== false;
    out.push(cell('cs', `${approx ? '≈' : ''}${esc(v.cs)}`, approx ? 'CS · in game' : `CS${mins ? ` · ${(v.cs / mins).toFixed(1)}/min` : ''}`,
      approx ? ' title="In-game count, rounded down to 10"' : ''));
  }
  if (v.dmg) {
    const share = num(st.damageShare) && st.damageShare > 0 ? Math.round(st.damageShare * 100) : null;
    const bar = share != null ? `<span class="mv-bar"><i style="width:${Math.min(100, share)}%"></i></span>` : '';
    out.push(cell('dmg', `${esc(kShort(v.dmg))}${bar}`, `Damage${share != null ? ` · ${share}%` : ''}`));
  }
  if (v.gold) out.push(cell('gold', esc(kShort(v.gold)), `Gold${mins ? ` · ${Math.round(v.gold / mins)}/min` : ''}`));
  if (v.vision) out.push(cell('vision', esc(Math.round(v.vision)), 'Vision'));
  if (v.items) out.push(itemsHtml(v.items, icons, 'mv-items', 'mv-item'));
  return out.join('');
}

function stripHtml(m) {
  if (!m.clips.length) return '';
  const shown = stripClips(m.clips);
  const more = m.clips.length - shown.length;
  const thumbs = shown.map((c) => {
    const title = describeName(c).title;
    const when = clipWhen(c);
    const label = when.text ? `${title} · ${when.text}` : title;
    return `<button type="button" class="mv-sthumb"${attrs({ 'data-act': 'clip-play', 'data-key': m.key, 'data-path': c.path, title: label, 'aria-label': `Play ${label}` })}>${c.thumb ? `<img src="${esc(c.thumb)}" alt="" loading="lazy" draggable="false">` : ''}<span class="mv-evs">${glyphs(c, true)}</span></button>`;
  }).join('');
  const moreBtn = more > 0 ? `<button type="button" class="mv-more"${attrs({ 'data-act': 'match-toggle', 'data-key': m.key, title: `Show all ${m.clips.length} highlights`, 'aria-label': `Show all ${m.clips.length} highlights` })}>+${more}</button>` : '';
  return `<div class="mv-strip">${thumbs}${moreBtn}</div>`;
}

// "Full match 28:42 · Minimap · 30 files · 7.6 GB". The length and the file count (mv-wide) drop
// out when the list is narrow; each part carries its own leading dot, so none is left dangling.
function filesHtml(m) {
  const parts = [];
  if (!m.clips.length) parts.push(['No highlights']);
  if (m.full) parts.push([`<b>Full match</b>${m.full.duration ? `<span class="mv-len"> ${esc(fmtDuration(m.full.duration))}</span>` : ''}`]);
  else if (m.clips.length) parts.push(['<b>Highlights only</b>']);
  parts.push([m.map ? '<b>Minimap</b>' : 'No minimap']);
  parts.push([esc(plural(m.files.length, 'file', 'files')), true]);
  parts.push([esc(fmtSize(m.size))]);
  return parts.map(([p, wide], i) => `<span class="mv-part${wide ? ' mv-wide' : ''}">${i ? '<span class="mv-dot" aria-hidden="true">·</span>' : ''}${p}</span>`).join('');
}

function rowActions(m) {
  const out = [];
  if (isPlayable(m)) {
    out.push(`<button type="button" class="mv-btn mv-subtle"${attrs({ 'data-act': 'match-play', 'data-key': m.key, title: m.full ? 'Play the full match' : 'Play the match: highlights, with the minimap in between', 'aria-label': 'Play match' })}>${icon('play')}<span class="mv-lbl">Play match</span></button>`);
  }
  if (m.clips.length) {
    out.push(`<button type="button" class="mv-btn mv-subtle"${attrs({ 'data-act': 'match-highlights', 'data-key': m.key, title: 'Play the highlights one after another', 'aria-label': 'Watch highlights' })}>${icon('fast-forward')}<span class="mv-lbl mv-lbl-l">Watch highlights</span><span class="mv-lbl mv-lbl-s">Highlights</span></button>`);
  }
  return out.join('');
}

//   opts: { expanded, now, icons: (kind, id) -> { url, name } | null, for items, spells and runes }
export function renderMatchRow(match, { expanded = false, now = Date.now(), icons = null } = {}) {
  const m = match;
  const st = m.stats || null;
  const open = Boolean(expanded) && hasPanel(m);
  const day = fmtDay(m.start, now);
  const when = `${fmtClock(m.start)}${num(m.gameTime) && m.gameTime > 0 ? ` · ${fmtDuration(m.gameTime)}` : ''}`;
  const lines = [`<span class="mv-r">${esc(m.result || 'No result')}</span>`];
  // The queue ("Ranked Solo/Duo") once the match record knows it, else the map mode.
  if (st && (st.queueName || st.gameMode)) lines.push(`<span class="mv-q">${esc(st.queueName || modeName(st.gameMode))}</span>`);
  lines.push(`<span class="mv-m mv-num"${attrs({ title: `${day}, ${fmtClock(m.start)}${num(m.gameTime) && m.gameTime > 0 ? `, ${fmtDuration(m.gameTime)} long` : ''}` })}>${esc(when)}</span>`);
  if (m.inferred) {
    lines.push('<span class="mv-m mv-inferred" title="These files have no minimap link, so they were grouped by the time they were saved. Check them before deleting.">Grouped by time</span>');
  }
  const label = [m.result || 'Match', m.champion, hasKda(st) ? `${st.kills}/${st.deaths}/${st.assists}` : null, `${day} ${fmtClock(m.start)}`].filter(Boolean).join(', ');
  const panelId = domId(m.key);
  const end = [
    `<button type="button" class="mv-icon-btn"${attrs({ 'data-act': 'match-menu', 'data-key': m.key, title: 'More actions', 'aria-label': 'More actions', 'aria-haspopup': 'menu' })}>${icon('ellipsis')}</button>`,
    hasPanel(m) ? `<button type="button" class="mv-icon-btn"${attrs({ 'data-act': 'match-toggle', 'data-key': m.key, title: open ? 'Hide highlights' : 'Show highlights', 'aria-label': open ? 'Hide highlights' : 'Show highlights', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': panelId })}>${icon(open ? 'chevron-up' : 'chevron-down')}</button>` : '',
  ].join('');
  return `<article class="mv-row${open ? ' mv-open' : ''}"${attrs({ 'data-act': 'match-toggle', 'data-key': m.key, 'data-inferred': m.inferred ? 'true' : null, tabindex: '0', 'aria-label': label })}>`
    + `<div class="mv-res${toneClass(m.result)}">${lines.join('')}</div>`
    + `<div class="mv-perf"><div class="mv-cz">${champHtml(m)}${buildHtml(buildOf(m) || {}, icons, 'mv-build')}</div>${statCells(m, icons)}<div class="mv-end">${end}</div></div>`
    + `<div class="mv-media">${stripHtml(m)}<span class="mv-files">${filesHtml(m)}</span><span class="mv-acts">${rowActions(m)}</span></div>`
    + '</article>';
}

// ------------------------------------------------------------------ the expanded match

function tileHtml(item, m, { selecting, selected, target }) {
  const { title, trimmed } = describeName(item);
  const when = clipWhen(item);
  const isSel = selecting && selected.has(item.path);
  const cls = `mv-tile${isSel ? ' mv-selected' : ''}${target === item.path ? ' mv-target' : ''}`;
  const act = selecting ? 'clip-select' : 'clip-play';
  const label = [title, when.text, item.duration ? fmtSeconds(item.duration) : null].filter(Boolean).join(', ');
  return `<button type="button" class="${cls}"${attrs({ 'data-act': act, 'data-key': m.key, 'data-path': item.path, 'aria-label': selecting ? `Select ${label}` : `Play ${label}`, 'aria-pressed': selecting ? (isSel ? 'true' : 'false') : null, title: item.name })}>`
    + `<span class="mv-thumb">${item.thumb ? `<img src="${esc(item.thumb)}" alt="" loading="lazy" draggable="false">` : ''}<span class="mv-evs">${glyphs(item, true)}</span>`
    + `${trimmed ? '<span class="mv-tag">Trimmed</span>' : ''}${selecting ? `<span class="mv-check${isSel ? ' mv-on' : ''}">${isSel ? icon('check') : ''}</span>` : ''}</span>`
    + `<span class="mv-cap"><span class="mv-lb">${item.favorite ? icon('heart', { cls: 'mv-fav' }) : ''}${esc(title)}</span>`
    + `<span class="mv-tm"><span${attrs({ title: when.title || null })}>${esc(when.text)}</span><span>${item.duration ? esc(fmtSeconds(item.duration)) : ''}</span></span></span>`
    + '</button>';
}

// "This match is 30 files on disk: the full recording (5.3 GB), the minimap (46 MB) and 28 highlights (2.2 GB). 7.6 GB in total."
function footHtml(m) {
  const sum = (list) => list.reduce((s, i) => s + (i.size || 0), 0);
  const inFiles = new Set(m.files);
  const parts = [];
  if (m.full) parts.push(`the full recording (${fmtSize(m.full.size)})`);
  if (m.map) parts.push(`the minimap (${fmtSize(m.map.size)})`);
  const real = m.clips.filter((c) => !c.virtual); // virtual clips are ranges of the full recording: no file
  const ranged = m.clips.length - real.length;
  if (real.length) parts.push(`${plural(real.length, 'highlight', 'highlights')} (${fmtSize(sum(real))})`);
  const videos = m.extras.filter((i) => inFiles.has(i) && i.type === 'montage');
  if (videos.length) parts.push(`${plural(videos.length, 'highlight video', 'highlight videos')} (${fmtSize(sum(videos))})`);
  const others = m.extras.filter((i) => inFiles.has(i) && i.type !== 'montage');
  if (others.length) parts.push(`${plural(others.length, 'other video', 'other videos')} (${fmtSize(sum(others))})`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] || '';
  const loose = m.extras.filter((i) => !inFiles.has(i));
  const also = loose.length === 1 ? ' The clip you saved during the match is also in Clips.' : loose.length ? ` The ${loose.length} clips you saved during the match are also in Clips.` : '';
  const guess = m.inferred ? ' Grouped by time: check the files before deleting.' : '';
  const inFull = ranged ? ` ${ranged === 1 ? '1 more highlight plays' : `${ranged} more highlights play`} from the full recording.` : '';
  return `<div class="mv-foot">${icon('hard-drive')}<span>This match is <b>${esc(plural(m.files.length - ranged, 'file', 'files'))}</b> on disk${list ? `: ${esc(list)}` : ''}. ${esc(fmtSize(m.size))} in total.${esc(inFull)}${esc(also)}${esc(guess)}</span>`
    + `<button type="button" class="mv-btn mv-subtle mv-xs"${attrs({ 'data-act': 'match-folder', 'data-key': m.key })}>${icon('folder-open')}Show in folder</button></div>`;
}

//   family: which chip is on; selecting: select mode; selected: Set or array of paths; target: the
//   path whose context menu is open (outlined).
export function renderMatchPanel(match, { family = 'all', selecting = false, selected = null, target = null } = {}) {
  const m = match;
  const counts = m.counts || {};
  const chips = FAMILIES.filter(([f]) => counts[f] > 0);
  const fam = family !== 'all' && chips.some(([f]) => f === family) ? family : 'all';
  const sel = selected instanceof Set ? selected : new Set(selected || []);
  const chip = (f, text, n, glyph) => `<button type="button" class="mv-chip${fam === f ? ' mv-on' : ''}"${attrs({ 'data-act': 'match-family', 'data-key': m.key, 'data-family': f, 'aria-pressed': fam === f ? 'true' : 'false' })}>${glyph}${esc(text)} <span class="mv-ct">${esc(n)}</span></button>`;
  const head = `<div class="mv-panel-head"><div class="mv-seg" role="group" aria-label="Show">`
    + chip('all', 'All', counts.all ?? m.clips.length, '')
    + chips.map(([f, text]) => chip(f, text, counts[f], evDisc({ objective: 'dragon', multikill: 'multikill' }[f] || f, true))).join('')
    + '</div><span class="mv-grow"></span>'
    + (m.clips.length ? `<button type="button" class="mv-btn mv-subtle"${attrs({ 'data-act': 'match-select', 'data-key': m.key, 'aria-pressed': selecting ? 'true' : 'false' })}>${icon('square-check')}${selecting ? esc(`${sel.size} selected`) : 'Select'}</button>` : '')
    + (m.clips.length ? `<button type="button" class="mv-btn"${attrs({ 'data-act': 'match-make-video', 'data-key': m.key, disabled: !m.map, title: m.map ? 'Join the highlights into one video' : 'Needs the match minimap to line the highlights up' })}>${icon('clapperboard')}Make highlight video</button>` : '')
    + '</div>';
  const opts = { selecting, selected: sel, target };
  const clips = fam === 'all' ? m.clips : m.clips.filter((c) => c.family === fam);
  const tiles = clips.length ? `<div class="mv-tiles">${clips.map((c) => tileHtml(c, m, opts)).join('')}</div>` : '';
  const extras = fam === 'all' && m.extras.length
    ? `<div class="mv-sub">Also from this match</div><div class="mv-tiles">${m.extras.map((c) => tileHtml(c, m, opts)).join('')}</div>` : '';
  return `<section class="mv-panel"${attrs({ id: domId(m.key), 'data-key': m.key, 'aria-label': 'Highlights' })}>${m.clips.length ? head : ''}${tiles}${extras}${footHtml(m)}</section>`;
}

// ------------------------------------------------------------------ menus

const menuItem = (act, glyph, text, { key, path, sc, danger, disabled, data } = {}) =>
  `<button type="button" class="mv-menu-item${danger ? ' mv-danger' : ''}" role="menuitem"${attrs({ 'data-act': act, 'data-key': key, 'data-path': path, disabled: Boolean(disabled), ...(data || {}) })}>${icon(glyph)}<span class="mv-mi-text">${esc(text)}</span>${sc ? `<span class="mv-sc">${esc(sc)}</span>` : ''}</button>`;
const SEP = '<div class="mv-menu-sep" role="separator"></div>';

const kindOf = (item) => ({ highlight: 'highlight', montage: 'highlight video', recording: 'recording', map: 'minimap' }[item.type] || 'clip');

// Right-click menu for a clip tile. match: the MatchEntry it's in (for "Play in the full match").
export function renderClipMenu(item, { match = null } = {}) {
  const key = match ? match.key : null;
  const path = item.path;
  const out = [menuItem('clip-play', 'play', 'Play', { key, path, sc: 'Enter' })];
  if (item.map && item.map.path) {
    out.push(menuItem('clip-play-in-match', 'tv-minimal', match && match.full ? 'Play in the full match' : 'Play in the match', { key, path }));
  }
  out.push(SEP,
    menuItem('clip-copy', 'copy', 'Copy file', { key, path, sc: 'Ctrl C' }),
    menuItem('clip-share', 'share-2', 'Share…', { key, path }),
    menuItem('clip-favorite', 'heart', item.favorite ? 'Remove from favorites' : 'Add to favorites', { key, path, sc: 'F', data: { 'data-on': item.favorite ? 'false' : 'true' } }),
    menuItem('clip-folder', 'folder-open', 'Show in folder', { key, path }),
    SEP,
    menuItem('clip-delete', 'trash-2', `Delete ${kindOf(item)}`, { key, path, sc: 'Del', danger: true }));
  return `<div class="mv-menu" role="menu"${attrs({ 'data-key': key, 'data-path': path, 'aria-label': describeName(item).title })}>${out.join('')}</div>`;
}

// The row's ⋯ menu (and right-click on a row).
export function renderMatchMenu(match) {
  const m = match;
  const key = m.key;
  const out = [];
  if (isPlayable(m)) out.push(menuItem('match-play', 'play', 'Play match', { key, sc: 'Enter' }));
  if (m.clips.length) out.push(menuItem('match-highlights', 'fast-forward', 'Watch highlights', { key, sc: 'H' }));
  if (m.clips.length && m.map) out.push(menuItem('match-make-video', 'clapperboard', 'Make highlight video…', { key }));
  if (out.length) out.push(SEP);
  out.push(menuItem('match-favorite', 'heart', m.favorite ? 'Remove match from favorites' : 'Add match to favorites', { key, sc: 'F', data: { 'data-on': m.favorite ? 'false' : 'true' } }),
    menuItem('match-folder', 'folder-open', 'Show files in folder', { key }),
    SEP);
  if (m.full) out.push(menuItem('match-delete-full', 'trash-2', 'Delete full recording only', { key, sc: `frees ${fmtSize(m.full.size)}` }));
  out.push(menuItem('match-delete', 'trash-2', 'Delete match…', { key, sc: 'Del', danger: true, data: { 'data-inferred': m.inferred ? 'true' : null } }));
  return `<div class="mv-menu" role="menu"${attrs({ 'data-key': key, 'aria-label': 'Match' })}>${out.join('')}</div>`;
}

// Where to put a menu opened at (x, y) so it stays on screen: below and right of the point, flipped
// left or up near the edges (as Windows does), clamped to the margin.
export function placeMenu({ x, y, width, height, viewWidth, viewHeight, margin = 8 }) {
  let left = x;
  let top = y;
  if (left + width > viewWidth - margin) left = x - width;
  if (top + height > viewHeight - margin) top = y - height >= margin ? y - height : viewHeight - margin - height;
  return { left: Math.max(margin, Math.round(left)), top: Math.max(margin, Math.round(top)) };
}

// ------------------------------------------------------------------ the list

function dayGroups(list, now) {
  const today = startOfDay(now);
  const groups = [];
  for (const m of list) {
    const day = startOfDay(m.start);
    if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, matches: [] });
    groups[groups.length - 1].matches.push(m);
  }
  for (const g of groups) {
    const diff = Math.round((today - g.day) / 86400000);
    const date = fmtDay(g.day, now);
    g.title = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : date;
    g.date = diff === 0 || diff === 1 ? date : '';
  }
  return groups;
}

function groupMeta(g) {
  const wins = g.matches.filter((m) => m.result === 'Victory').length;
  const losses = g.matches.filter((m) => m.result === 'Defeat').length;
  const record = [wins ? plural(wins, 'win', 'wins') : '', losses ? plural(losses, 'loss', 'losses') : ''].filter(Boolean).join(', ');
  return [g.date, plural(g.matches.length, 'match', 'matches'), record].filter(Boolean).join(' · ');
}

const dayHead = (title, meta) => `<div class="mv-day"><h2 class="mv-day-title">${esc(title)}</h2>${meta ? `<span class="mv-day-meta">${esc(meta)}</span>` : ''}</div>`;

function emptyHtml(f, all) {
  if (!all.length) {
    return '<div class="mv-empty"><h2 class="mv-empty-title">No matches yet</h2><p class="mv-empty-text">League of Legends matches show up here after you play one, with their highlights, the minimap and the full recording.</p></div>';
  }
  const noun = f.result === 'Victory' ? 'victories' : f.result === 'Defeat' ? 'defeats' : f.favorites ? 'favorite matches' : 'matches';
  const what = [f.champion ? `with ${f.champion}` : '', f.mode ? `in ${modeName(f.mode)}` : '', f.query.trim() ? `for “${f.query.trim()}”` : ''].filter(Boolean).join(' ');
  return `<div class="mv-empty"><h2 class="mv-empty-title">${esc(`No ${noun}${what ? ` ${what}` : ''}`)}</h2>`
    + `<p class="mv-empty-text">${esc(`${plural(all.length, 'match is', 'matches are')} hidden by the filters.`)}</p>`
    + `<button type="button" class="mv-btn"${attrs({ 'data-act': 'filter-clear' })}>${icon('filter-x')}Clear filters</button></div>`;
}

//   matches: groupLibrary(items).matches; expandedKey: the open match (or null); filter: see
//   filterMatches; now: for Today/Yesterday; panel options (family, selecting, selected, target)
//   apply to the expanded match.
export function renderMatchList({ matches = [], expandedKey = null, filter = null, now = Date.now(), family = 'all', selecting = false, selected = null, target = null, icons = null } = {}) {
  const f = normFilter(filter);
  const list = filterMatches(matches, f);
  if (!list.length) return `<div class="mv-view">${emptyHtml(f, matches || [])}</div>`;
  const root = `<div class="${['mv-view', matchColumns(list)].filter(Boolean).join(' ')}">`;
  const rows = (ms) => ms.map((m) => {
    const open = m.key === expandedKey && hasPanel(m);
    return renderMatchRow(m, { expanded: open, now, icons }) + (open ? renderMatchPanel(m, { family, selecting, selected, target }) : '');
  }).join('');
  if (f.sort !== 'newest' && f.sort !== 'oldest') return `${root}<div class="mv-list">${rows(list)}</div></div>`;
  const groups = dayGroups(list, now);
  let html = '';
  if (f.sort === 'newest' && !isFiltered(f) && groups[0].day !== startOfDay(now)) html += dayHead('Today', `${fmtDay(now, now)} · no matches yet`);
  for (const g of groups) html += `${dayHead(g.title, groupMeta(g))}<div class="mv-list">${rows(g.matches)}</div>`;
  return `${root}${html}</div>`;
}

// ------------------------------------------------------------------ the header (title, filters)

// Page title, totals and the Phase 1 filters: mode (from gameMode), result, champion, search, sort.
export function renderMatchHeader({ matches = [], filter = null } = {}) {
  const f = normFilter(filter);
  const all = matches || [];
  const shown = isFiltered(f) ? filterMatches(all, f) : all;
  const size = shown.reduce((s, m) => s + (m.size || 0), 0);
  const total = shown === all ? plural(all.length, 'match', 'matches') : `${shown.length} of ${plural(all.length, 'match', 'matches')}`;
  const modes = [...new Set(all.map((m) => m.stats && m.stats.gameMode).filter(Boolean).map((g) => String(g).toUpperCase()))];
  const champs = [...new Set(all.map((m) => m.champion).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const opt = (value, text, on) => `<option${attrs({ value, selected: on })}>${esc(text)}</option>`;
  const select = (act, label, options, lead = null) => `<span class="mv-select${lead ? ' mv-with-icon' : ''}">${lead ? icon(lead, { cls: 'mv-lead' }) : ''}<select${attrs({ 'data-act': act, 'aria-label': label })}>${options}</select>${icon('chevron-down', { cls: 'mv-chev' })}</span>`;
  const seg = modes.length > 1
    ? `<div class="mv-seg" role="group" aria-label="Mode">${[['', 'All'], ...modes.map((g) => [g, modeName(g)])].map(([v, t]) => `<button type="button" class="mv-chip${lower(f.mode) === lower(v) ? ' mv-on' : ''}"${attrs({ 'data-act': 'filter-mode', 'data-mode': v, 'aria-pressed': lower(f.mode) === lower(v) ? 'true' : 'false' })}>${esc(t)}</button>`).join('')}</div>` : '';
  return '<div class="mv-head">'
    + `<div class="mv-title-row"><h1 class="mv-title">Matches</h1><span class="mv-total mv-num">${esc(`${total} · ${fmtSize(size)}`)}</span></div>`
    + `<div class="mv-toolbar">${seg}`
    + select('filter-result', 'Result', opt('', 'All results', !f.result) + opt('Victory', 'Victories', f.result === 'Victory') + opt('Defeat', 'Defeats', f.result === 'Defeat'))
    + select('filter-champion', 'Champion', opt('', 'All champions', !f.champion) + champs.map((c) => opt(c, c, lower(f.champion) === lower(c))).join(''))
    + '<span class="mv-grow"></span>'
    + `<label class="mv-search">${icon('search')}<input${attrs({ type: 'search', 'data-act': 'filter-query', placeholder: 'Search matches', value: f.query, spellcheck: 'false', 'aria-label': 'Search matches' })}></label>`
    + select('filter-sort', 'Sort', [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['longest', 'Longest first'], ['largest', 'Largest first']].map(([v, t]) => opt(v, t, f.sort === v)).join(''), 'arrow-down-wide-narrow')
    + '</div></div>';
}
