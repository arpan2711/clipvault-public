// Library items shaped like library.js _item(), for the Matches view preview (matches.html,
// matches-states.html) and its unit test (test/matches-view-test.js).
// - The 17 October Evelynn match is real: names, labels, markers, minimap offsets, durations, sizes
//   and save times come from that day's library.json, and the stats are what it holds (Phase 1:
//   cs null, level 0, no vision). Paths are neutral; thumbnails are the real ones (assets/thumbs).
// - The other matches are made up the same way (their thumbnails reuse the real ones).
// Times are UTC; the names use the local clock of that day (BST, UTC+1).

const DIR = 'C:\\Videos\\ClipVault\\League of Legends';
const GAME = 'League of Legends';
const A = 'assets/';
export const NOW = Date.UTC(2026, 9, 18, 16, 30); // Sunday 18 October 2026, 17:30 BST

const fileUrl = (p) => `file:///${p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^C%3A/, 'C:')}`;
const stamp = (ms) => new Date(ms + 3600e3).toISOString().slice(11, 19).replace(/:/g, '-'); // HH-MM-SS, BST
const day = (ms) => new Date(ms + 3600e3).toISOString().slice(0, 10);
const ICON = { Evelynn: 'Evelynn', "Kha'Zix": 'Khazix', Lillia: 'Lillia', Lux: 'Lux', Ahri: 'Ahri', Nidalee: 'Nidalee' };
const thumbOf = (suffix) => (suffix ? `${A}thumbs/${suffix}.jpg` : null);

function item({ name, type, label = null, event = null, champion = null, stats = null, markers = [], map = null, created, size, duration, width = 2560, height = 1440, thumb = null, favorite = false, game = GAME }) {
  const path = `${game === GAME ? DIR : `C:\\Videos\\ClipVault\\${game}`}\\${name}.mp4`;
  const champ = champion || (stats && stats.champion);
  return {
    path, name, game, type, event, label, champion,
    championIcon: champ && ICON[champ] ? `${A}champion/${ICON[champ]}.png` : null,
    stats, favorite, markers, inputs: 0, audioTracks: type === 'map' ? [] : ['Audio'], fps: type === 'map' ? 10 : 60, codec: 'h264',
    map: map ? { path: map.path, url: fileUrl(map.path), offset: map.offset } : null,
    created, size, duration, width, height, url: fileUrl(path), thumb,
  };
}

// ------------------------------------------------------------------ the real match (2026-10-17)

const REAL_STATS = { champion: 'Evelynn', kills: 11, deaths: 10, assists: 7, cs: null, level: 0, result: 'Defeat', gameMode: 'CLASSIC', gameTime: 1695, highlights: 28 };
// [save time HH-MM-SS, label, duration s, size B, created ms, minimap offset s, markers [t, label, type]]
const REAL_CLIPS = [
  ['22-37-34', 'Assist', 20.048, 58326701, 1792273054325, 52.3, [[14.7, 'Assist', 'assist']]],
  ['22-40-16', 'Death', 22.042667, 70254267, 1792273217203, 214.3, [[15.5, 'Death', 'death']]],
  ['22-43-15', 'Death', 20.032, 63779667, 1792273396264, 394.3, [[14.6, 'Death', 'death']]],
  ['22-44-01', 'Kill', 24.048, 94413053, 1792273441479, 436.3, [[15.8, 'Kill', 'kill'], [17.8, 'Assist', 'assist']]],
  ['22-44-14', 'Kill', 22.048, 75180700, 1792273454823, 452.3, [[15.2, 'Kill', 'kill']]],
  ['22-45-33', 'Kill', 20.048, 75574948, 1792273533671, 532.3, [[14, 'Kill', 'kill']]],
  ['22-47-01', 'Kill', 22.032, 69207844, 1792273621366, 618.3, [[15.7, 'Kill', 'kill']]],
  ['22-47-53', 'Death', 22.042667, 94115037, 1792273673672, 670.3, [[15.9, 'Death', 'death']]],
  ['22-49-09', 'Kill + Earth dragon', 28.048, 92793976, 1792273749669, 740.3, [[14.9, 'Earth dragon', 'dragon'], [22, 'Kill', 'kill']]],
  ['22-49-38', 'Assist', 22.037333, 96146270, 1792273778945, 776.3, [[15.3, 'Assist', 'assist']]],
  ['22-50-03', 'Kill', 20.032, 69776368, 1792273804056, 802.3, [[14.4, 'Kill', 'kill']]],
  ['22-51-39', 'Death', 20.032, 76043922, 1792273900301, 898.3, [[14.6, 'Death', 'death']]],
  ['22-52-52', 'Death', 20.032, 66021098, 1792273972288, 970.3, [[14.7, 'Death', 'death']]],
  ['22-53-05', 'Rift Herald', 20.037333, 47953754, 1792273985633, 984.3, [[14.1, 'Rift Herald', 'herald']]],
  ['22-55-13', 'Double kill', 30.042667, 146007027, 1792274113883, 1102.3, [[14.9, 'Kill', 'kill'], [24.1, 'Kill', 'kill'], [24.1, 'Double kill', 'multikill']]],
  ['22-55-38', 'Chemtech dragon', 22.037333, 87608083, 1792274138699, 1136.3, [[15, 'Chemtech dragon', 'dragon']]],
  ['22-56-00', 'Death', 22.042667, 77163014, 1792274160793, 1158.3, [[15.1, 'Death', 'death']]],
  ['22-57-10', 'Assist', 22.048, 86324900, 1792274231037, 1228.3, [[15.3, 'Assist', 'assist']]],
  ['22-57-28', 'Assist', 22.042667, 85855912, 1792274249164, 1246.3, [[15.5, 'Assist', 'assist']]],
  ['22-57-52', 'Assist', 22.042667, 106146806, 1792274272978, 1270.3, [[15.3, 'Assist', 'assist']]],
  ['22-58-20', 'Death', 22.032, 91859647, 1792274300733, 1298.3, [[15.1, 'Death', 'death']]],
  ['23-00-11', 'Death', 22.037333, 74503281, 1792274411344, 1408.3, [[15.7, 'Death', 'death']]],
  ['23-01-35', 'Kill', 20.042667, 100106170, 1792274496186, 1494.3, [[14.5, 'Kill', 'kill']]],
  ['23-01-50', 'Kill', 22.048, 107792113, 1792274511093, 1508.3, [[15.4, 'Kill', 'kill']]],
  ['23-03-09', 'Death', 20.048, 85281879, 1792274590201, 1588.3, [[14.5, 'Death', 'death']]],
  ['23-04-03', 'Kill', 22.037333, 86555894, 1792274643614, 1640.3, [[15.9, 'Kill', 'kill']]],
  ['23-04-25', 'Assist', 26.032, 133523023, 1792274666244, 1658.3, [[15.8, 'Assist', 'assist'], [20.4, 'Death', 'death']]],
  ['23-04-55', 'Defeat', 20.048, 82957105, 1792274695899, 1700.3, [[14.7, 'Defeat', 'defeat']]],
];
// The minimap's 33 moments (minimap time); the full recording has the same ones 0.3 s later.
const REAL_MOMENTS = [
  [68.4, 'Assist', 'assist'], [231.2, 'Death', 'death'], [410.3, 'Death', 'death'], [453.5, 'Kill', 'kill'], [455.5, 'Assist', 'assist'],
  [468.9, 'Kill', 'kill'], [547.7, 'Kill', 'kill'], [635.4, 'Kill', 'kill'], [687.6, 'Death', 'death'], [756.6, 'Earth dragon', 'dragon'],
  [763.7, 'Kill', 'kill'], [793, 'Assist', 'assist'], [818.1, 'Kill', 'kill'], [914.3, 'Death', 'death'], [986.4, 'Death', 'death'],
  [999.8, 'Rift Herald', 'herald'], [1118.6, 'Kill', 'kill'], [1127.8, 'Kill', 'kill'], [1127.8, 'Double kill', 'multikill'],
  [1152.7, 'Chemtech dragon', 'dragon'], [1174.8, 'Death', 'death'], [1245, 'Assist', 'assist'], [1263.2, 'Assist', 'assist'],
  [1287, 'Assist', 'assist'], [1314.8, 'Death', 'death'], [1425.4, 'Death', 'death'], [1510.2, 'Kill', 'kill'], [1525.1, 'Kill', 'kill'],
  [1604.2, 'Death', 'death'], [1657.6, 'Kill', 'kill'], [1675.5, 'Assist', 'assist'], [1680.1, 'Death', 'death'], [1716.4, 'Defeat', 'defeat'],
];
const marks = (list, shift = 0) => list.map(([t, label, type]) => ({ t: Math.round((t + shift) * 10) / 10, label, type }));

export const REAL_MAP = `${DIR}\\League of Legends 2026-10-17 22-36-14 Evelynn Map.mp4`;
export const REAL_KEY = `map:${REAL_MAP}`;

function realMatch() {
  const map = item({ name: 'League of Legends 2026-10-17 22-36-14 Evelynn Map', type: 'map', label: 'Defeat · match reel', champion: 'Evelynn', stats: REAL_STATS,
    markers: marks(REAL_MOMENTS), created: 1792274720612, size: 48310103, duration: 1745.9, width: 378, height: 378, thumb: thumbOf('2026-10-17_22-36-14_Evelynn_Map') });
  const full = item({ name: 'League of Legends 2026-10-17 23-04-55 Evelynn Defeat Match', type: 'recording', label: 'Full match', champion: 'Evelynn', stats: REAL_STATS,
    markers: marks(REAL_MOMENTS, 0.3), map: { path: REAL_MAP, offset: -1.6 }, created: 1792274719241, size: 5719582645, duration: 1722.042667,
    thumb: thumbOf('2026-10-17_23-04-55_Evelynn_Defeat_Match') });
  const clips = REAL_CLIPS.map(([at, label, duration, size, created, offset, ms]) => item({
    name: `League of Legends 2026-10-17 ${at} ${label}`, type: 'highlight', label, champion: 'Evelynn', markers: marks(ms),
    map: { path: REAL_MAP, offset }, created, size, duration, thumb: thumbOf(`2026-10-17_${at}_${label.replace(/ \+ /g, '_').replace(/ /g, '_')}`),
  }));
  return [map, full, ...clips];
}

// ------------------------------------------------------------------ made-up matches, same shape

// clips: [game time of the moment s, label, [[type, label, s after the first moment]], duration s, thumbnail]
function madeUpMatch({ start, champion, stats, gameStart = -21, mapLen, fullLen = null, withMap = true, clips, favorite = [] }) {
  const prefix = `League of Legends ${day(start)}`;
  const mapPath = `${DIR}\\${prefix} ${stamp(start)} ${champion} Map.mp4`;
  const out = [];
  const moments = [];
  clips.forEach(([g, label, ms, duration, thumb], i) => {
    const offset = Math.round((g - gameStart - 15) * 10) / 10; // the clip starts 15 s before its first moment
    const created = Math.round(start + (offset + duration + 1.5) * 1000) + i;
    const markers = ms.map(([type, l, dt = 0]) => ({ t: Math.round((15 + dt) * 10) / 10, label: l, type }));
    markers.forEach((m) => moments.push([offset + m.t, m.label, m.type]));
    out.push(item({ name: `${prefix} ${stamp(created)} ${label}`, type: 'highlight', label, champion, markers,
      map: withMap ? { path: mapPath, offset } : null, created, size: Math.round(duration * 3.62e6 + i * 911), duration: duration + 0.042, thumb: thumbOf(thumb),
      favorite: favorite.includes(i) }));
  });
  if (stats && stats.result) moments.push([stats.gameTime - gameStart, stats.result, stats.result === 'Victory' ? 'victory' : 'defeat']);
  moments.sort((a, b) => a[0] - b[0]);
  const mapCreated = Math.round(start + mapLen * 1000 + 700);
  if (withMap) {
    out.unshift(item({ name: `${prefix} ${stamp(start)} ${champion} Map`, type: 'map', label: `${stats && stats.result ? stats.result : 'Match'} · match reel`, champion, stats,
      markers: marks(moments), created: mapCreated, size: Math.round(mapLen * 27.7e3), duration: mapLen, width: 378, height: 378, thumb: thumbOf('2026-10-17_22-36-14_Evelynn_Map') }));
  }
  if (fullLen) {
    const created = mapCreated - 1400;
    out.unshift(item({ name: `${prefix} ${stamp(created)} ${champion}${stats && stats.result ? ` ${stats.result}` : ''} Match`, type: 'recording', label: 'Full match', champion, stats,
      markers: marks(moments, 1.5), map: withMap ? { path: mapPath, offset: -1.5 } : null, created, size: Math.round(fullLen * 3.32e6), duration: fullLen,
      thumb: thumbOf('2026-10-17_23-04-55_Evelynn_Defeat_Match') }));
  }
  return out;
}

// A Victory from a newer build: level, CS (rounded down to 10 in game) and vision were recorded.
const khazix = () => madeUpMatch({
  start: Date.UTC(2026, 9, 17, 20, 48, 0), champion: "Kha'Zix", mapLen: 1639, fullLen: 1615,
  stats: { champion: "Kha'Zix", kills: 9, deaths: 2, assists: 8, cs: 170, level: 15, wardScore: 27, result: 'Victory', gameMode: 'CLASSIC', gameTime: 1588, highlights: 14 },
  clips: [
    [125, 'Kill', [['kill', 'Kill']], 20, '2026-10-17_22-44-14_Kill'],
    [220, 'Assist', [['assist', 'Assist']], 20, '2026-10-17_22-37-34_Assist'],
    [372, 'Kill', [['kill', 'Kill'], ['assist', 'Assist', 2.5]], 24, '2026-10-17_22-44-01_Kill'],
    [510, 'Death', [['death', 'Death']], 20, '2026-10-17_22-40-16_Death'],
    [545, 'Voidgrubs', [['grubs', 'Voidgrubs']], 20, '2026-10-17_22-53-05_Rift_Herald'],
    [680, 'Double kill', [['kill', 'Kill'], ['kill', 'Kill', 6.2], ['multikill', 'Double kill', 6.2]], 30, '2026-10-17_22-55-13_Double_kill'],
    [782, 'Kill', [['kill', 'Kill']], 22, '2026-10-17_22-45-33_Kill'],
    [880, 'Assist', [['assist', 'Assist']], 22, '2026-10-17_22-49-38_Assist'],
    [978, 'Infernal dragon + Kill', [['dragon', 'Infernal dragon'], ['kill', 'Kill', 6]], 28, '2026-10-17_22-49-09_Kill_Earth_dragon'],
    [1135, 'Death', [['death', 'Death']], 22, '2026-10-17_22-43-15_Death'],
    [1210, 'Kill', [['kill', 'Kill']], 22, '2026-10-17_22-47-01_Kill'],
    [1351, 'Baron + Kill', [['baron', 'Baron'], ['kill', 'Kill', 4]], 26, '2026-10-17_23-01-50_Kill'],
    [1442, 'Assist', [['assist', 'Assist']], 22, '2026-10-17_22-57-52_Assist'],
    [1588, 'Victory', [['victory', 'Victory']], 20, '2026-10-17_23-04-03_Kill'],
  ],
});

// Minimap recording off: a full recording with stats and highlights with no minimap link, so the
// grouping falls back to time (inferred) and there's no game clock (tiles show the save time).
const lillia = () => madeUpMatch({
  start: Date.UTC(2026, 9, 16, 22, 10, 0), champion: 'Lillia', mapLen: 1790, fullLen: 1788, withMap: false,
  stats: { champion: 'Lillia', kills: 3, deaths: 6, assists: 9, cs: 180, level: 14, wardScore: 24, result: 'Defeat', gameMode: 'CLASSIC', gameTime: 1755, highlights: 7 },
  clips: [
    [180, 'Assist', [['assist', 'Assist']], 20, '2026-10-17_22-57-10_Assist'],
    [455, 'Kill', [['kill', 'Kill']], 22, '2026-10-17_22-50-03_Kill'],
    [610, 'Death', [['death', 'Death']], 20, '2026-10-17_22-47-53_Death'],
    [905, 'Assist', [['assist', 'Assist']], 22, '2026-10-17_22-57-28_Assist'],
    [1188, 'Kill', [['kill', 'Kill'], ['assist', 'Assist', 3]], 24, '2026-10-17_23-01-35_Kill'],
    [1420, 'Death', [['death', 'Death']], 22, '2026-10-17_22-58-20_Death'],
    [1745, 'Defeat', [['defeat', 'Defeat']], 20, '2026-10-17_23-04-55_Defeat'],
  ],
});

// Full-match recording off: the minimap and the highlights are the match.
const lux = () => madeUpMatch({
  start: Date.UTC(2026, 9, 15, 18, 40, 0), champion: 'Lux', mapLen: 1192,
  stats: { champion: 'Lux', kills: 12, deaths: 7, assists: 31, cs: 40, level: 18, wardScore: 0, result: 'Victory', gameMode: 'ARAM', gameTime: 1140, highlights: 9 },
  clips: [
    [95, 'Kill', [['kill', 'Kill']], 20, '2026-10-17_23-01-35_Kill'],
    [230, 'Assist', [['assist', 'Assist']], 20, '2026-10-17_22-57-52_Assist'],
    [388, 'Assist', [['assist', 'Assist']], 20, '2026-10-17_22-57-10_Assist'],
    [512, 'Triple kill', [['kill', 'Kill'], ['kill', 'Kill', 3], ['kill', 'Kill', 5.5], ['multikill', 'Triple kill', 5.5]], 30, '2026-10-17_22-55-13_Double_kill'],
    [640, 'Death', [['death', 'Death']], 20, '2026-10-17_22-51-39_Death'],
    [701, 'Kill', [['kill', 'Kill'], ['assist', 'Assist', 2]], 22, '2026-10-17_23-01-50_Kill'],
    [866, 'Assist', [['assist', 'Assist']], 22, '2026-10-17_23-04-25_Assist'],
    [990, 'Ace', [['kill', 'Kill'], ['ace', 'Ace', 4]], 24, '2026-10-17_23-04-03_Kill'],
    [1140, 'Victory', [['victory', 'Victory']], 20, '2026-10-17_22-44-14_Kill'],
  ],
  favorite: [3],
});

// An instant replay saved during the real match: a loose clip that also shows in the match.
const replay = () => item({ name: 'League of Legends 2026-10-17 22-50-00', type: 'clip', created: Date.UTC(2026, 9, 17, 21, 50, 0), size: 61204480, duration: 30.0,
  thumb: thumbOf('2026-10-17_22-50-03_Kill') });

// The library the preview shows.
export function libraryItems() {
  return [...realMatch(), ...khazix(), ...lillia(), ...lux(), replay()];
}

// Just the 30 files of the 17 October match, plus the instant replay saved during it.
export function realMatchItems() {
  return [...realMatch(), replay()];
}

// Extra matches for the states sheet (matches-states.html).
export function stateItems() {
  return [
    // Minimap and full recording both off: highlights only, grouped by time, no stats saved.
    ...madeUpMatch({ start: Date.UTC(2026, 9, 14, 20, 5, 0), champion: 'Ahri', stats: null, mapLen: 1500, withMap: false, clips: [
      [120, 'Kill', [['kill', 'Kill']], 20, '2026-10-17_22-45-33_Kill'],
      [300, 'Assist', [['assist', 'Assist']], 22, '2026-10-17_22-49-38_Assist'],
      [520, 'Death', [['death', 'Death']], 20, '2026-10-17_22-56-00_Death'],
      [760, 'Kill', [['kill', 'Kill'], ['assist', 'Assist', 2]], 24, '2026-10-17_22-44-01_Kill'],
    ] }),
    // A short game with no highlights.
    ...madeUpMatch({ start: Date.UTC(2026, 9, 14, 17, 12, 0), champion: 'Nidalee', mapLen: 236, fullLen: 230,
      stats: { champion: 'Nidalee', kills: 0, deaths: 1, assists: 0, cs: 10, level: 3, wardScore: 2, result: 'Defeat', gameMode: 'CLASSIC', gameTime: 205, highlights: 0 },
      clips: [] }),
  ];
}
