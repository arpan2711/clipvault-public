// The Matches view (src/renderer/js/views/matches.js), rendered from the real 17 October match as
// library.json has it (28 highlights + minimap + full recording, stats with cs: null and level: 0)
// and the preview's other fixtures (test/ui/preview/matches-data.js).
//   node test/matches-view-test.js
process.env.TZ = 'Europe/London'; // the fixtures' clock times are BST
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const load = (...p) => import(pathToFileURL(path.join(__dirname, '..', ...p)).href);
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const count = (html, re) => (html.match(re) || []).length;
const TILE = /<button type="button" class="mv-tile[ "]/g; // a tile, not the .mv-tiles grid
const actsIn = (html) => [...html.matchAll(/data-act="([^"]*)"/g)].map((m) => m[1]);

(async () => {
  const v = await load('src', 'renderer', 'js', 'views', 'matches.js');
  const { groupLibrary } = await load('src', 'renderer', 'js', 'lib', 'group.js');
  const data = await load('test', 'ui', 'preview', 'matches-data.js');

  // ---- the real match: one row
  const { matches, loose } = groupLibrary(data.realMatchItems());
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(loose.length, 1, 'the instant replay stays a loose clip');
  const m = matches[0];
  const collapsed = v.renderMatchList({ matches, now: data.NOW });
  assert.strictEqual(count(collapsed, /<article class="mv-row/g), 1, 'one row');
  assert.strictEqual(count(collapsed, TILE), 0, 'collapsed: no tiles');
  const t = text(collapsed);
  assert.ok(t.replace(/ /g, '').includes('11/10/7'), 'K/D/A 11/10/7');
  assert.ok(t.includes('1.80 KDA'));
  assert.ok(/<span class="mv-d">10<\/span>/.test(collapsed), 'deaths are marked for red');
  assert.ok(t.includes('Defeat') && t.includes("Summoner's Rift") && t.includes('22:36 · 28:15'), 'result, mode, start and length');
  assert.ok(t.includes('Yesterday') && t.includes('Saturday 17 October · 1 match · 1 loss'), `day group: ${t.slice(0, 160)}`);
  assert.ok(t.includes('Today Sunday 18 October · no matches yet'));
  assert.ok(t.includes('Full match 28:42') && t.includes('Minimap') && t.includes('30 files') && t.includes('7.6 GB'), 'files on disk');
  // Stats that weren't recorded are absent, not 0.
  assert.ok(!/mv-c-(cs|dmg|gold|vision)|mv-lvl|mv-items/.test(collapsed), 'no CS, damage, gold, vision, level or items cells');
  assert.ok(!/mv-has-/.test(collapsed), 'no stat columns reserved');
  // The strip: the 5 biggest moments in game order, then +23.
  const strip = collapsed.match(/<div class="mv-strip">.*?<\/div>/)[0];
  assert.strictEqual(count(strip, /class="mv-sthumb"/g), 5);
  assert.deepStrictEqual([...strip.matchAll(/title="([^"]*)"/g)].map((x) => x[1]).slice(0, 5),
    ['Kill · 7:11', 'Kill + Earth dragon · 12:14', 'Rift Herald · 16:17', 'Double kill · 18:25', 'Chemtech dragon · 18:50']);
  assert.ok(strip.includes('>+23</button>'));
  // Row actions and keys.
  for (const act of ['match-play', 'match-highlights', 'match-menu', 'match-toggle']) {
    assert.ok(collapsed.includes(`data-act="${act}" data-key="${v.esc(m.key)}"`), `${act} with data-key`);
  }

  // ---- expanded: 28 tiles, family chips, footer
  const open = v.renderMatchList({ matches, expandedKey: m.key, now: data.NOW });
  const panel = open.slice(open.indexOf('<section class="mv-panel"'));
  const main = panel.slice(0, panel.indexOf('Also from this match'));
  assert.strictEqual(count(main, TILE), 28, '28 highlight tiles');
  assert.strictEqual(count(panel, TILE), 29, 'plus the instant replay saved during the match');
  const chips = [...open.matchAll(/data-family="([a-z]+)"[^>]*>(?:<span class="mv-ev[^"]*"><svg[^>]*><use[^>]*><\/use><\/svg><\/span>)?([A-Za-z]+) <span class="mv-ct">(\d+)<\/span>/g)].map((x) => `${x[2]} ${x[3]}`);
  assert.deepStrictEqual(chips, ['All 28', 'Kills 8', 'Deaths 10', 'Assists 5', 'Objectives 3', 'Multikills 1'], `chips: ${chips}`);
  assert.deepStrictEqual(chips.slice(1).map((c) => Number(c.split(' ')[1])), [m.counts.kill, m.counts.death, m.counts.assist, m.counts.objective, m.counts.multikill]);
  const pt = text(panel);
  assert.ok(pt.includes('Double kill 18:25 30 s'), 'in-game time and length on the tile');
  assert.ok(pt.includes('Instant replay 22:50 30 s'), 'the replay shows its save time');
  assert.ok(pt.includes('This match is 30 files on disk: the full recording (5.3 GB), the minimap (46.1 MB) and 28 highlights (2.2 GB). 7.6 GB in total.'), pt.slice(-260));
  assert.ok(open.includes('aria-expanded="true"') && collapsed.includes('aria-expanded="false"'));
  // Each chip's count is the number of tiles it shows.
  for (const [fam, n] of [['kill', 8], ['death', 10], ['assist', 5], ['objective', 3], ['multikill', 1]]) {
    assert.strictEqual(count(v.renderMatchPanel(m, { family: fam }), TILE), n, fam);
  }
  assert.strictEqual(count(v.renderMatchPanel(m, { family: 'structure' }), TILE), 29, 'an unknown family falls back to all');
  const selecting = v.renderMatchPanel(m, { selecting: true, selected: [m.clips[0].path] });
  assert.ok(selecting.includes('data-act="clip-select"') && !selecting.includes('data-act="clip-play"'));
  assert.strictEqual(count(selecting, /mv-tile mv-selected/g), 1);

  // ---- menus
  const dk = m.clips.find((c) => c.momentType === 'multikill');
  const clipMenu = v.renderClipMenu(dk, { match: m });
  assert.deepStrictEqual(actsIn(clipMenu), ['clip-play', 'clip-play-in-match', 'clip-copy', 'clip-share', 'clip-favorite', 'clip-folder', 'clip-delete']);
  assert.ok(text(clipMenu).includes('Play in the full match') && text(clipMenu).includes('Delete highlight'));
  assert.ok(!v.renderClipMenu(loose[0]).includes('clip-play-in-match'), 'no "play in the match" without a minimap link');
  assert.ok(v.renderClipMenu(loose[0]).includes('Delete clip'));
  const matchMenu = v.renderMatchMenu(m);
  assert.deepStrictEqual(actsIn(matchMenu), ['match-play', 'match-highlights', 'match-make-video', 'match-favorite', 'match-folder', 'match-delete-full', 'match-delete']);
  assert.ok(text(matchMenu).includes('Delete full recording only frees 5.3 GB'));
  assert.deepStrictEqual(v.placeMenu({ x: 100, y: 100, width: 200, height: 300, viewWidth: 1440, viewHeight: 900 }), { left: 100, top: 100 });
  assert.deepStrictEqual(v.placeMenu({ x: 1400, y: 800, width: 200, height: 300, viewWidth: 1440, viewHeight: 900 }), { left: 1200, top: 500 }, 'flips left and up near the edges');
  assert.deepStrictEqual(v.placeMenu({ x: 10, y: 200, width: 200, height: 880, viewWidth: 1440, viewHeight: 900 }), { left: 10, top: 12 }, 'clamped when it fits neither way');

  // ---- the whole preview library: header, four matches, other states
  const all = groupLibrary(data.libraryItems()).matches;
  const extra = groupLibrary([...data.libraryItems(), ...data.stateItems()]).matches;
  const khazix = all.find((x) => x.champion === "Kha'Zix");
  const lillia = all.find((x) => x.champion === 'Lillia');
  const lux = all.find((x) => x.champion === 'Lux');
  const ahri = extra.find((x) => x.champion === 'Ahri');
  const nidalee = extra.find((x) => x.champion === 'Nidalee');
  const page = v.renderMatchHeader({ matches: all, filter: {} }) + v.renderMatchList({ matches: all, expandedKey: m.key, now: data.NOW });
  assert.strictEqual(count(page, /<article class="mv-row/g), 4);
  assert.ok(/<div class="mv-view mv-has-cs mv-has-vision">/.test(page), 'columns for the stats some rows have');
  assert.ok(text(page).includes('Friday 16 October 1 match · 1 loss') && text(page).includes('Thursday 15 October 1 match · 1 win'));
  const kRow = v.renderMatchRow(khazix, { now: data.NOW });
  assert.ok(/class="mv-lvl"[^>]*>15</.test(kRow) && text(kRow).includes('≈170 CS · in game') && text(kRow).includes('27 Vision'), 'newer build: level, CS, vision');
  const lRow = v.renderMatchRow(lillia, { now: data.NOW });
  assert.ok(lillia.inferred && lRow.includes('data-inferred="true"') && text(lRow).includes('Grouped by time') && text(lRow).includes('No minimap'), 'inferred, no minimap');
  assert.ok(v.renderMatchMenu(lillia).includes('data-act="match-delete" data-key="' + v.esc(lillia.key) + '" data-inferred="true"'));
  assert.ok(/\d\d:\d\d<\/span><span>20 s/.test(v.renderMatchPanel(lillia)), 'no game clock: tiles show the save time');
  assert.ok(v.renderMatchPanel(lillia).includes('data-act="match-make-video" data-key="' + v.esc(lillia.key) + '" disabled'), 'no highlight video without a minimap');
  assert.ok(text(v.renderMatchRow(lux, { now: data.NOW })).includes('Highlights only') && !v.renderMatchMenu(lux).includes('match-delete-full'), 'no full recording');
  const aRow = v.renderMatchRow(ahri, { now: data.NOW });
  assert.ok(text(aRow).includes('No result') && text(aRow).includes('No stats saved') && !aRow.includes('match-play'), 'stats missing, nothing to play but highlights');
  const nRow = v.renderMatchRow(nidalee, { now: data.NOW });
  assert.ok(text(nRow).includes('No highlights') && !nRow.includes('mv-strip') && !nRow.includes('aria-expanded'), 'no highlights: no strip, no expand button');

  // ---- filters
  const f = (filter) => v.filterMatches(all, filter).map((x) => x.champion);
  assert.deepStrictEqual(f({ champion: "kha'zix" }), ["Kha'Zix"]);
  assert.deepStrictEqual(f({ result: 'Defeat' }), ['Evelynn', 'Lillia']);
  assert.deepStrictEqual(f({ mode: 'ARAM' }), ['Lux']);
  assert.deepStrictEqual(f({ query: 'baron' }), ["Kha'Zix"]);
  assert.deepStrictEqual(f({ favorites: true }), ['Lux']);
  assert.deepStrictEqual(f({ sort: 'oldest' }), ['Lux', 'Lillia', "Kha'Zix", 'Evelynn']);
  assert.deepStrictEqual(f({ sort: 'largest' })[0], 'Evelynn');
  assert.ok(text(v.renderMatchHeader({ matches: all, filter: {} })).includes('4 matches · 20.4 GB'));
  assert.ok(text(v.renderMatchHeader({ matches: all, filter: { result: 'Defeat' } })).includes('2 of 4 matches · 13.6 GB'));
  const none = v.renderMatchList({ matches: all, filter: { champion: "Kha'Zix", mode: 'ARAM' }, now: data.NOW });
  assert.ok(text(none).includes("No matches with Kha'Zix in ARAM") && none.includes('data-act="filter-clear"'));
  assert.ok(text(v.renderMatchList({ matches: [], now: data.NOW })).includes('No matches yet'));
  assert.ok(!v.renderMatchList({ matches: all, filter: { result: 'Victory' }, now: data.NOW }).includes('no matches yet'), 'no "Today" note while filtering');

  // ---- everything rendered: no null/undefined/NaN, every control has data-act, classes are mv-
  const everything = [page, open, collapsed, selecting, clipMenu, matchMenu, none,
    ...extra.flatMap((x) => [v.renderMatchRow(x, { expanded: true, now: data.NOW }), v.renderMatchPanel(x), v.renderMatchMenu(x)]),
    ...extra.flatMap((x) => [...x.clips, ...x.extras]).map((c) => v.renderClipMenu(c, { match: m })),
    v.renderMatchHeader({ matches: all, filter: { result: 'Victory', champion: 'Lux', mode: 'ARAM', query: 'x', sort: 'oldest' } })].join('\n');
  for (const bad of ['null', 'undefined', 'NaN', '[object Object]']) assert.ok(!everything.includes(bad), `"${bad}" in the HTML`);
  const controls = everything.match(/<(button|select|input|a|textarea)\b[^>]*>|<[a-z]+\b[^>]*\btabindex=[^>]*>/g);
  assert.ok(controls.length > 200);
  for (const c of controls) assert.ok(/\bdata-act="[a-z-]+"/.test(c), `no data-act: ${c.slice(0, 120)}`);
  const used = new Set(actsIn(everything));
  for (const act of used) assert.ok(v.ACTIONS.includes(act), `${act} is missing from ACTIONS`);
  for (const act of v.ACTIONS) assert.ok(used.has(act), `${act} in ACTIONS is never rendered`);
  for (const [, cls] of everything.matchAll(/class="([^"]*)"/g)) {
    for (const c of cls.split(/\s+/).filter(Boolean)) assert.ok(/^mv-/.test(c) || ['i', 'i-md', 'i-lg', 'ev'].includes(c), `class ${c} is not mv- prefixed`); // i: line icons, ev: event tokens (shared)
  }

  // ---- every string from the library is escaped
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const HOSTILE = '"><script>alert(1)</script>'; // appended to every path, minimap links included
  const nasty = groupLibrary(data.realMatchItems().map((i) => ({
    ...i, path: `${i.path}${HOSTILE}`, map: i.map && { ...i.map, path: `${i.map.path}${HOSTILE}` }, name: `${evil} ${i.name}`, label: i.label && `${i.label} ${evil}`,
    champion: evil, championIcon: 'x" onerror="alert(1)', thumb: i.thumb && `${i.thumb}" onload="alert(1)`,
    stats: i.stats && { ...i.stats, champion: evil, gameMode: evil, result: 'Defeat' },
    markers: i.markers.map((mk) => ({ ...mk, label: evil })),
  }))).matches;
  assert.strictEqual(nasty.length, 1);
  const n = nasty[0];
  const nastyHtml = [v.renderMatchHeader({ matches: nasty, filter: { query: evil, champion: evil } }),
    v.renderMatchList({ matches: nasty, expandedKey: n.key, now: data.NOW, target: n.clips[0].path }),
    v.renderMatchList({ matches: nasty, filter: { champion: 'Nobody', query: evil }, now: data.NOW }),
    v.renderMatchPanel(n, { selecting: true, selected: [n.clips[1].path] }),
    v.renderMatchMenu(n), ...n.clips.slice(0, 3).map((c) => v.renderClipMenu(c, { match: n }))].join('\n');
  assert.ok(!/<img src=x|<script|onerror="alert|onload="alert/.test(nastyHtml), 'hostile strings are inert');
  assert.ok(nastyHtml.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'), 'and shown escaped');
  // Every tag splits cleanly into name="value" attributes (values can't break out), none an event handler.
  for (const tag of nastyHtml.match(/<[a-z]+\b[^>]*>/g)) {
    const names = [];
    const leftover = tag.replace(/^<[a-z0-9]+/, '').replace(/>$/, '').replace(/\s([a-z][a-z0-9-]*)(?:="[^"]*")?/g, (_, name) => { names.push(name); return ''; });
    assert.strictEqual(leftover.trim(), '', `malformed tag: ${tag.slice(0, 120)}`);
    assert.ok(!names.some((name) => name.startsWith('on')), `event handler attribute: ${tag.slice(0, 120)}`);
  }

  // ---- odd or incomplete items (seeded, so failures repeat): nothing throws, nothing reads null/undefined/NaN
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const maybe = (x, p = 0.5) => (rnd() < p ? x : undefined);
  const TYPES = ['kill', 'death', 'assist', 'multikill', 'dragon', 'baron', 'turret', 'bookmark', 'victory', 'defeat', 'teamfight', 'weird', undefined, null];
  let fuzzRows = 0;
  for (let run = 0; run < 200; run++) {
    const t0 = Date.UTC(2026, 9, 1 + Math.floor(rnd() * 20), Math.floor(rnd() * 24));
    const dir = 'C:\\V\\League of Legends';
    const mapPath = `${dir}\\m${run}.mp4`;
    const linked = rnd() < 0.6;
    const st = maybe({ champion: maybe(pick(['Ahri', '', null])), kills: maybe(7, 0.8), deaths: maybe(pick([0, 4]), 0.8), assists: maybe(3, 0.8), cs: pick([null, 0, 170, NaN]),
      level: pick([0, 15, null]), wardScore: pick([0, 12.4, undefined]), result: pick(['Victory', 'Defeat', null]), gameMode: pick(['CLASSIC', 'ARAM', 'ODD', null]),
      gameTime: pick([1695, 0, null, NaN]), damage: maybe(pick([28640, 0, NaN])), damageShare: maybe(pick([0.27, NaN])), gold: maybe(13420), items: maybe(pick([[], [null, 'i.png', { icon: 'j.png', name: 'Item' }], [1, 2]])) }, 0.7);
    const items = [];
    if (linked && rnd() < 0.8) items.push({ path: mapPath, name: 'League of Legends 2026-10-01 10-00-00 Map', game: 'League of Legends', type: 'map', stats: st, markers: [{ t: 100, type: 'defeat' }], created: maybe(t0 + 1800e3, 0.9), size: maybe(48e6, 0.9), duration: maybe(1800, 0.9) });
    if (rnd() < 0.6) items.push({ path: `${dir}\\f${run}.mp4`, name: maybe('League of Legends 2026-10-01 10-30-00 Match', 0.9), game: 'League of Legends', type: 'recording', stats: st, map: linked ? { path: mapPath, offset: -1.5 } : null, created: maybe(t0 + 1799e3, 0.9), size: maybe(5e9, 0.9), duration: maybe(1700, 0.9) });
    for (let i = Math.floor(rnd() * 10); i > 0; i--) {
      items.push({ path: `${dir}\\h${run}-${i}.mp4`, name: maybe(pick([`League of Legends 2026-10-01 10-0${i}-00 Kill`, 'renamed <b>clip</b>', '']), 0.95), game: 'League of Legends', type: 'highlight',
        label: maybe(pick(['Kill', null])), event: maybe(pick(TYPES)), champion: maybe('Ahri'), markers: maybe([{ t: maybe(12, 0.9), type: pick(TYPES), label: maybe('Kill') }], 0.9),
        map: linked ? { path: mapPath, offset: maybe(rnd() * 1500, 0.9) } : null, created: maybe(t0 + i * 60e3, 0.95), size: maybe(8e7, 0.9), duration: maybe(pick([20, 0, 75, NaN]), 0.9), thumb: maybe('t.jpg'), favorite: rnd() < 0.1 });
    }
    if (rnd() < 0.3) items.push({ path: `${dir}\\c${run}.mp4`, name: 'League of Legends 2026-10-01 10-05-00', game: 'League of Legends', type: pick(['clip', 'montage']), created: maybe(t0 + 300e3), size: 1e6, duration: 30, source: maybe({ map: mapPath }) });
    const ms = groupLibrary(items).matches;
    const html = v.renderMatchHeader({ matches: ms, filter: { query: pick(['', 'kill']) } })
      + v.renderMatchList({ matches: ms, expandedKey: ms[0] && ms[0].key, now: data.NOW, family: pick(['all', 'kill', 'nonsense']), selecting: rnd() < 0.3, filter: { sort: pick(['newest', 'oldest', 'largest']) } })
      + ms.map((x) => v.renderMatchMenu(x) + [...x.clips, ...x.extras].map((c) => v.renderClipMenu(c, { match: x })).join('')).join('');
    fuzzRows += count(html, /<article class="mv-row/g);
    for (const bad of ['undefined', 'null', 'NaN', '[object Object]']) assert.ok(!html.includes(bad), `run ${run}: "${bad}" near ${html.slice(Math.max(0, html.indexOf(bad) - 100), html.indexOf(bad) + 20)}`);
  }

  assert.ok(fuzzRows > 150, `the random runs rendered only ${fuzzRows} rows`);

  console.log('matches view tests: PASS');
})().catch((err) => {
  console.error('FAIL:', err.stack || err.message);
  process.exit(1);
});
