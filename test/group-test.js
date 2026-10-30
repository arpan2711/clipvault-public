// Grouping the library into matches (src/renderer/js/lib/group.js), on fixtures shaped like the
// real 2026-10-17 game: 28 highlights + minimap + full recording, stats with cs: null.
//   node test/group-test.js
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const LEAGUE = 'League of Legends';
const MARKERS = [
  [68.4, 'Assist', 'assist'], [231.2, 'Death', 'death'], [410.3, 'Death', 'death'], [453.5, 'Kill', 'kill'], [455.5, 'Assist', 'assist'],
  [468.9, 'Kill', 'kill'], [547.7, 'Kill', 'kill'], [635.4, 'Kill', 'kill'], [687.6, 'Death', 'death'], [756.6, 'Earth dragon', 'dragon'],
  [763.7, 'Kill', 'kill'], [793, 'Assist', 'assist'], [818.1, 'Kill', 'kill'], [914.3, 'Death', 'death'], [986.4, 'Death', 'death'],
  [999.8, 'Rift Herald', 'herald'], [1118.6, 'Kill', 'kill'], [1127.8, 'Double kill', 'multikill'], [1152.7, 'Chemtech dragon', 'dragon'],
  [1174.8, 'Death', 'death'], [1245, 'Assist', 'assist'], [1263.2, 'Assist', 'assist'], [1287, 'Assist', 'assist'], [1314.8, 'Death', 'death'],
  [1425.4, 'Death', 'death'], [1510.2, 'Kill', 'kill'], [1525.1, 'Kill', 'kill'], [1604.2, 'Death', 'death'], [1716.4, 'Defeat', 'defeat'],
].map(([t, label, type]) => ({ t, label, type }));
const T0 = Date.UTC(2026, 9, 17, 21, 36, 14);
const dir = 'C:\\Videos\\ClipVault\\League of Legends';

function realMatch() {
  const MAP = `${dir}\\League of Legends 2026-10-17 22-36-14 Evelynn Map.mp4`;
  const stats = { champion: 'Evelynn', kills: 11, deaths: 10, assists: 7, cs: null, level: 0, result: 'Defeat', gameMode: 'CLASSIC', gameTime: 1695, highlights: 28 };
  const map = { path: MAP, type: 'map', game: LEAGUE, champion: 'Evelynn', stats, markers: MARKERS, duration: 1745.9, created: T0 + 1746 * 1000, size: 48e6 };
  const full = { path: `${dir}\\League of Legends 2026-10-17 23-04-55 Evelynn Defeat Match.mp4`, type: 'recording', game: LEAGUE, champion: 'Evelynn',
    stats, markers: [], map: { path: MAP, offset: -1.6 }, duration: 1722, created: T0 + 1745 * 1000, size: 5.72e9 };
  const clips = MARKERS.slice(0, 28).map((m, i) => ({
    path: `${dir}\\League of Legends 2026-10-17 clip ${i} ${m.label}.mp4`, type: 'highlight', game: LEAGUE, champion: 'Evelynn', label: m.label,
    markers: [{ t: 15, label: m.label, type: m.type }], map: { path: MAP, offset: m.t - 15 }, duration: 20, created: T0 + (m.t + 5) * 1000 + i, size: 85e6,
  }));
  return { MAP, map, full, clips };
}

(async () => {
  const g = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'lib', 'group.js')).href);

  // The real game: 30 files become one match.
  const { MAP, map, full, clips } = realMatch();
  const sekiro = { path: 'C:\\Videos\\ClipVault\\Sekiro\\Sekiro 1.mp4', type: 'clip', game: 'Sekiro', created: T0 - 86400000 };
  const replay = { path: `${dir}\\League of Legends 2026-10-17 22-50-00.mp4`, type: 'clip', game: LEAGUE, created: T0 + 840 * 1000 };
  let r = g.groupLibrary([...clips, map, full, sekiro, replay]);
  assert.strictEqual(r.matches.length, 1);
  const m = r.matches[0];
  assert.strictEqual(m.key, `map:${MAP}`);
  assert.strictEqual(m.inferred, false);
  assert.strictEqual(m.files.length, 30);
  assert.strictEqual(m.clips.length, 28);
  assert.strictEqual(m.full, full);
  assert.strictEqual(m.map, map);
  assert.strictEqual(m.champion, 'Evelynn');
  assert.strictEqual(m.result, 'Defeat');
  assert.ok(m.gameStart > -22 && m.gameStart < -21, `game clock ${m.gameStart}`);
  const dk = m.clips.find((c) => c.momentType === 'multikill');
  assert.ok(Math.abs(dk.gameAt - 1106.4) < 0.2, `double kill at ${dk.gameAt}`); // 18:26 in game
  assert.strictEqual(m.cover, dk, 'the double kill is the cover');
  assert.deepStrictEqual(m.clips.map((c) => c.gameAt), [...m.clips.map((c) => c.gameAt)].sort((a, b) => a - b), 'clips in game order');
  assert.strictEqual(Object.entries(m.counts).filter(([k]) => k !== 'all').reduce((s, [, n]) => s + n, 0), 28);
  assert.strictEqual(m.counts.kill, 9); // the first 28 fixture markers: 9 kills, 9 deaths, 6 assists, 3 objectives, 1 multikill
  assert.strictEqual(m.counts.death, 9);
  assert.strictEqual(m.counts.objective, 3);
  assert.strictEqual(m.start, Math.round(map.created - 1745.9 * 1000));
  // Loose clips stay loose; a League instant replay during the game also shows in the match.
  assert.deepStrictEqual(r.loose.map((i) => i.game), [LEAGUE, 'Sekiro']);
  assert.ok(m.extras.some((e) => e.path === replay.path && e.alsoLoose));

  // A highlight video made from the match, a renamed clip and a trimmed copy stay with the match.
  const montage = { path: `${dir}\\Highlight video.mp4`, type: 'montage', game: LEAGUE, source: { map: MAP }, created: T0 + 2000 * 1000 };
  const trimmed = { ...clips[17], path: `${dir}\\Double kill (trim).mp4`, map: { path: MAP, offset: clips[17].map.offset + 4 } };
  r = g.groupLibrary([...clips, map, full, montage, trimmed]);
  assert.strictEqual(r.matches.length, 1);
  assert.strictEqual(r.matches[0].files.length, 32);
  assert.ok(r.matches[0].extras.includes(montage));
  assert.strictEqual(r.loose.length, 0);

  // No minimap: a recording with stats and the highlights in its time window, marked inferred.
  const rec = { path: `${dir}\\rec.mp4`, type: 'recording', game: LEAGUE, champion: 'Viego', stats: { champion: 'Viego', gameTime: 1500, result: 'Victory' }, duration: 1520, created: T0 + 1600 * 1000 };
  const hs = [100, 600, 1400].map((s, i) => ({ path: `${dir}\\h${i}.mp4`, type: 'highlight', game: LEAGUE, champion: 'Viego', markers: [{ t: 15, type: 'kill', label: 'Kill' }], created: T0 + s * 1000, duration: 20 }));
  r = g.groupLibrary([rec, ...hs]);
  assert.strictEqual(r.matches.length, 1);
  assert.strictEqual(r.matches[0].inferred, true);
  assert.strictEqual(r.matches[0].files.length, 4);
  assert.strictEqual(r.matches[0].result, 'Victory');

  // Back-to-back games with the same champion: two groups.
  const later = 45 * 60 * 1000;
  const rec2 = { ...rec, path: `${dir}\\rec2.mp4`, created: rec.created + later };
  const hs2 = hs.map((h, i) => ({ ...h, path: `${dir}\\h2-${i}.mp4`, created: h.created + later }));
  r = g.groupLibrary([rec, ...hs, rec2, ...hs2]);
  assert.strictEqual(r.matches.length, 2);
  assert.ok(r.matches.every((x) => x.files.length === 4));
  assert.ok(r.matches[0].start > r.matches[1].start, 'newest first');

  // Highlights with no recording: chained until a long gap, a champion change or a defeat clip.
  const chain = [
    { t: 0, c: 'Lux' }, { t: 120, c: 'Lux' }, { t: 300, c: 'Lux', type: 'defeat' }, // game 1 ends
    { t: 420, c: 'Lux' }, { t: 540, c: 'Lux' },                                     // game 2
    { t: 600, c: 'Zed' },                                                           // champion change
    { t: 2000, c: 'Zed' },                                                          // long gap
  ].map((x, i) => ({ path: `${dir}\\c${i}.mp4`, type: 'highlight', game: LEAGUE, champion: x.c, markers: [{ t: 10, type: x.type || 'kill' }], created: T0 + x.t * 1000, duration: 20 }));
  r = g.groupLibrary(chain);
  assert.deepStrictEqual(r.matches.map((x) => x.files.length).reverse(), [3, 2, 1, 1]);
  assert.ok(r.matches.every((x) => x.inferred));

  // Keys and families.
  assert.strictEqual(g.matchKeyOf({ match: 'EUW1_7000000001', map: { path: 'x' } }), 'EUW1_7000000001');
  assert.strictEqual(g.matchKeyOf({ type: 'clip', game: 'Sekiro' }), null);
  assert.strictEqual(g.familyOf('elder'), 'objective');
  assert.strictEqual(g.familyOf('ace'), 'multikill');
  assert.strictEqual(g.primaryMarker({ markers: [{ t: 1, type: 'kill' }, { t: 2, type: 'multikill' }] }).type, 'multikill');

  // Match records: the League client's stats fill in a match's row, keyed by the record key.
  {
    const KEY = 'EUW1_7000000101';
    const { map, full, clips } = realMatch();
    const items = [map, full, ...clips].map((i) => ({ ...i, match: KEY }));
    const fresh = () => g.groupLibrary(items).matches;

    // A backfilled record still waiting for match history: nothing new, nothing lost.
    const legacy = { key: KEY, k: 11, d: 10, a: 7, cs: null, csApprox: false, level: null, damage: null, gold: null, result: 'Lose', legacy: true, pending: ['history', 'timeline'] };
    let [m] = g.applyRecords(fresh(), [legacy]);
    assert.strictEqual(m.record, legacy);
    assert.deepStrictEqual([m.stats.kills, m.stats.deaths, m.stats.assists, m.stats.cs, m.stats.level, m.stats.csApprox], [11, 10, 7, null, 0, undefined]);
    assert.strictEqual(m.result, 'Defeat');

    // History answered: exact CS, damage and share, gold, vision, KP, level and the queue.
    const filled = { ...legacy, cs: 187, csApprox: false, damage: 24310, damageShare: 0.27, gold: 12850, vision: 31, kp: 0.62, level: 16, queueName: 'Ranked Solo/Duo', pending: ['timeline'] };
    [m] = g.applyRecords(fresh(), [filled]);
    assert.deepStrictEqual([m.stats.cs, m.stats.csApprox, m.stats.damage, m.stats.damageShare, m.stats.gold, m.stats.vision, m.stats.kp, m.stats.level, m.stats.queueName],
      [187, false, 24310, 0.27, 12850, 31, 0.62, 16, 'Ranked Solo/Duo']);
    assert.strictEqual(m.stats.gameMode, 'CLASSIC', 'the library keeps its own fields');

    // A backfilled record's CS is the in-game count until history answers; a live one says so itself.
    [m] = g.applyRecords(fresh(), [{ ...legacy, cs: 180 }]);
    assert.deepStrictEqual([m.stats.cs, m.stats.csApprox], [180, true]);
    [m] = g.applyRecords(fresh(), [{ ...legacy, legacy: false, cs: 180, csApprox: true, pending: ['history'] }]);
    assert.strictEqual(m.stats.csApprox, true);
    [m] = g.applyRecords(fresh(), [{ ...legacy, legacy: false, cs: 183, csApprox: false, pending: ['history'] }]);
    assert.strictEqual(m.stats.csApprox, false, 'end-of-game CS is exact before history');

    // 0 only fills a gap; it never replaces a number the library has.
    [m] = g.applyRecords(fresh(), [{ ...legacy, k: 0 }]);
    assert.strictEqual(m.stats.kills, 11);
    const noDeaths = g.groupLibrary(items.map((i) => ({ ...i, stats: i.stats && { ...i.stats, deaths: null } }))).matches;
    [m] = g.applyRecords(noDeaths, [{ ...legacy, d: 0 }]);
    assert.strictEqual(m.stats.deaths, 0);

    // The result comes from the record when the library has none; other keys and junk rows are ignored.
    const noResult = g.groupLibrary(items.map((i) => ({ ...i, stats: i.stats && { ...i.stats, result: null } }))).matches;
    [m] = g.applyRecords(noResult, [{ ...legacy, result: 'Win' }]);
    assert.deepStrictEqual([m.result, m.stats.result], ['Victory', 'Victory']);
    [m] = g.applyRecords(fresh(), [{ key: 'EUW1_1', k: 1 }, null, {}]);
    assert.strictEqual(m.record, undefined);
    assert.strictEqual(m.stats.kills, 11);
    assert.deepStrictEqual(g.applyRecords(fresh(), undefined).length, 1);
  }

  // A minimap split by a restart mid-match (2026-10-29): the part before has no stats or markers,
  // the part after has the game clock. One match; every highlight on the one game clock.
  {
    const KEY = 'EUW1_7000000102';
    const L = `${dir}\\League of Legends`;
    const end = T0 + 1873 * 1000; // game time 0 at T0
    const before = { path: `${L} 2026-10-29 19-52-23 Evelynn Map.mp4`, url: 'file:///before', type: 'map', game: LEAGUE, match: KEY, markers: [], duration: 1417.6, created: T0 + 1419 * 1000 };
    const after = {
      path: `${L} 2026-10-29 20-16-05 Evelynn Map.mp4`, url: 'file:///after', type: 'map', game: LEAGUE, match: KEY, champion: 'Evelynn', duration: 457.6, created: end + 5600,
      stats: { champion: 'Evelynn', kills: 13, deaths: 13, assists: 10, result: 'Defeat', gameTime: 1873 }, markers: [{ t: 452.4, type: 'defeat', label: 'Defeat' }],
    };
    const clip = (name, mapItem, offset, at) => ({ path: `${L} ${name}.mp4`, url: `file:///${name}`, type: 'highlight', game: LEAGUE, match: KEY, champion: 'Evelynn', duration: 20, created: at, map: { path: mapItem.path, offset }, markers: [{ t: 14, type: 'kill' }] });
    const early = clip('2026-10-29 19-56-21 Kill', before, 198.5, T0 + 220000);
    const late = clip('2026-10-29 20-16-57 Kill', after, 14.1, T0 + 1450000);
    const split = g.groupLibrary([late, after, early, before]).matches;
    assert.strictEqual(split.length, 1, 'one match');
    const s = split[0];
    assert.strictEqual(s.map.path, after.path, 'the minimap with the game clock leads');
    assert.ok(Math.abs(s.gameStart - 1420.6) < 0.05, `game clock ${s.gameStart}`);
    assert.deepStrictEqual(s.maps.map((p) => p.path), [before.path, after.path], 'both parts, oldest first');
    assert.ok(Math.abs(s.maps[0].gameStart - 1.0) < 0.05, `the first part starts at game time ${s.maps[0].gameStart}`);
    const [c1, c2] = s.clips;
    assert.strictEqual(c1.path, early.path);
    assert.ok(Math.abs(c1.gameAt - (198.5 + 14 + 1.0)) < 0.05, `early kill at ${c1.gameAt}`);
    assert.ok(Math.abs(c2.gameAt - (14.1 + 14 + 1420.6)) < 0.05, `late kill at ${c2.gameAt}`);
    // Copies are rebased onto the leading minimap; the library's items are untouched.
    assert.ok(Math.abs(c1.map.offset + s.gameStart - (198.5 + s.maps[0].gameStart)) < 0.05);
    assert.strictEqual(early.map.offset, 198.5);
    assert.strictEqual(s.files.length, 4);
    assert.deepStrictEqual(s.extras, [], 'the other minimap part is not an extra');
    // Which part plays when, and where a library item's minimap time lands.
    assert.strictEqual(g.mapPartAt(s, 300).item, before);
    assert.strictEqual(g.mapPartAt(s, 1500).item, after);
    assert.strictEqual(g.mapClockOf(s, early), s.maps[0].gameStart);
    assert.strictEqual(g.mapClockOf(s, late), s.gameStart);
    assert.strictEqual(g.mapClockOf(s, before), s.maps[0].gameStart);
    // One minimap: unchanged.
    const single = g.groupLibrary([late, after]).matches[0];
    assert.deepStrictEqual([single.map, single.maps.length, single.clips[0].map.offset], [after, 1, 14.1]);
  }

  console.log('group tests: PASS');
})().catch((err) => {
  console.error('FAIL:', err.stack || err.message);
  process.exit(1);
});
