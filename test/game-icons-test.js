// Item, summoner-spell and rune icons: the main-process cache (src/game-icons.js) against a fake
// CommunityDragon (no network: every request goes to a stub), the bundled id -> path lists
// (src/games/icon-paths.json), and how the views draw them (views/matches.js, views/match.js),
// including the empty squares while an icon isn't cached. Temp folders only.
//   node test/game-icons-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { pathToFileURL } = require('url');

// Nothing here may reach the network.
https.get = () => { throw new Error('test guard: no network in game-icons-test'); };
https.request = https.get;

const { GameIcons, KINDS, CDRAGON, mapFromLists, iconRel, relPath } = require('../src/game-icons');
const bundled = require('../src/games/icon-paths.json');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-icons-'));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
const load = (...p) => import(pathToFileURL(path.join(__dirname, '..', ...p)).href);
const count = (html, re) => (html.match(re) || []).length;

const ITEMS = [
  { id: 3031, name: 'Infinity Edge', iconPath: '/lol-game-data/assets/ASSETS/Items/Icons2D/3031_Marksman_T3_InfinityEdge.png' },
  { id: 220001, name: 'Anvil', iconPath: '/lol-game-data/assets/ASSETS/Items/Icons2D/Strawberry/220001_Anvil.png' },
  { id: 9999, name: 'Odd', iconPath: '/lol-game-data/assets/Somewhere/Else/Odd.png' },
  { id: 6666, name: 'Climber', iconPath: '/lol-game-data/assets/ASSETS/../../etc/passwd.png' },
  { id: 7777, name: 'Remote', iconPath: 'https://example.com/x.png' },
  { id: 0, name: 'Zero', iconPath: '/lol-game-data/assets/ASSETS/Items/Icons2D/0.png' },
];
const SPELLS = [{ id: 4, name: 'Flash', iconPath: '/lol-game-data/assets/DATA/Spells/Icons2D/Summoner_flash.png' }];
const PERKS = [{ id: 8008, name: 'Lethal Tempo', iconPath: '/lol-game-data/assets/v1/perk-images/Styles/Precision/LethalTempo/LethalTempoTemp.png' }];
const STYLES = { schemaVersion: 2, styles: [{ id: 8100, name: 'Domination', iconPath: '/lol-game-data/assets/v1/perk-images/Styles/7200_Domination.png' }] };

// A fake CommunityDragon: the four lists and any icon path in them; everything else is a 404.
function fakeCdn({ offline = false, lists = true, notPng = new Set() } = {}) {
  const calls = [];
  const docs = { 'v1/items.json': ITEMS, 'v1/summoner-spells.json': SPELLS, 'v1/perks.json': PERKS, 'v1/perkstyles.json': STYLES };
  const icons = new Set([...ITEMS, ...SPELLS, ...PERKS, ...STYLES.styles].map((e) => relPath(e.iconPath)).filter((p) => p && !p.endsWith('odd.png'))); // odd.png: listed, but a 404
  const fetch = async (url) => {
    calls.push(url);
    assert.ok(url.startsWith(CDRAGON), `only CommunityDragon: ${url}`);
    await new Promise((r) => setTimeout(r, 5));
    if (offline) throw new Error('getaddrinfo ENOTFOUND');
    const rel = url.slice(CDRAGON.length);
    if (Object.hasOwn(docs, rel)) {
      if (!lists) throw Object.assign(new Error('HTTP 503'), { status: 503 });
      return Buffer.from(JSON.stringify(docs[rel]));
    }
    if (icons.has(rel)) return notPng.has(rel) ? Buffer.from('<html>captive portal</html>') : PNG;
    throw Object.assign(new Error('HTTP 404'), { status: 404 });
  };
  return { fetch, calls, icons: () => calls.filter((u) => u.endsWith('.png')), lists: () => calls.filter((u) => u.endsWith('.json')) };
}

function mapperTests() {
  assert.strictEqual(relPath('/lol-game-data/assets/ASSETS/Items/Icons2D/1001_X.png'), 'assets/items/icons2d/1001_x.png', 'lowercased, prefix gone');
  assert.strictEqual(relPath('/lol-game-data/assets/ASSETS/../x.png'), null, 'no climbing out');
  assert.strictEqual(relPath('https://example.com/x.png'), null);
  assert.strictEqual(relPath('/lol-game-data/assets/a/b.jpg'), null, 'PNGs only');
  assert.strictEqual(relPath(null), null);

  const items = mapFromLists('item', [ITEMS]);
  assert.deepStrictEqual(Object.keys(items.ids).sort(), ['220001', '3031', '9999'], 'bad paths and ids are dropped');
  assert.strictEqual(items.ids[3031], '3031_marksman_t3_infinityedge.png', 'the shared folder is left out');
  assert.strictEqual(items.ids[9999], '/somewhere/else/odd.png', 'another folder keeps its full path');
  assert.strictEqual(iconRel(items, 3031), 'assets/items/icons2d/3031_marksman_t3_infinityedge.png');
  assert.strictEqual(iconRel(items, 220001), 'assets/items/icons2d/strawberry/220001_anvil.png');
  assert.strictEqual(iconRel(items, 9999), 'somewhere/else/odd.png');
  assert.strictEqual(iconRel(items, 1), null);
  assert.strictEqual(iconRel({ base: '', ids: { 5: '../../x.png' } }, 5), null, 'a tampered list can\'t climb out either');
  assert.strictEqual(items.names[3031], 'Infinity Edge');
  const runes = mapFromLists('rune', [PERKS, STYLES]);
  assert.deepStrictEqual([iconRel(runes, 8008), iconRel(runes, 8100)],
    ['v1/perk-images/styles/precision/lethaltempo/lethaltempotemp.png', 'v1/perk-images/styles/7200_domination.png'], 'perks and trees');
  assert.ok(!mapFromLists('rune', [PERKS], { names: false }).names);

  // The bundled lists know today's common ids, and are small.
  for (const [kind, id] of [['item', 3031], ['item', 3340], ['item', 3363], ['item', 1001], ['spell', 4], ['spell', 11], ['spell', 14],
    ['rune', 8008], ['rune', 8010], ['rune', 8112], ['rune', 8000], ['rune', 8100], ['rune', 8200], ['rune', 8300], ['rune', 8400]]) {
    assert.ok(iconRel(bundled[kind], id), `bundled ${kind} ${id}`);
  }
  assert.deepStrictEqual(Object.keys(bundled).sort(), Object.keys(KINDS).sort());
  assert.ok(fs.statSync(path.join(__dirname, '..', 'src', 'games', 'icon-paths.json')).size < 80 * 1024, 'the bundled lists stay small');
  console.log('icon list tests: PASS');
}

async function cacheTests() {
  // First run: lists downloaded once per kind, each icon once however many ask at once.
  const dir = path.join(root, 'a');
  const cdn = fakeCdn();
  const gi = new GameIcons(dir, { fetch: cdn.fetch, bundled: {} });
  const many = await Promise.all([...Array(6)].map(() => gi.icon('item', 3031)));
  assert.ok(many.every((f) => f === path.join(dir, 'items', '3031.png')), 'one path for all');
  assert.ok(fs.readFileSync(many[0]).equals(PNG));
  assert.strictEqual(cdn.icons().length, 1, 'one download');
  assert.strictEqual(cdn.lists().length, 1, 'one list download');
  assert.ok(fs.existsSync(path.join(dir, 'items.json')), 'the list is kept');
  assert.strictEqual(await gi.name('item', 3031), 'Infinity Edge');
  const [spell, key, tree] = await Promise.all([gi.icon('spell', 4), gi.icon('rune', 8008), gi.icon('rune', 8100)]);
  assert.deepStrictEqual([spell, key, tree], [path.join(dir, 'spells', '4.png'), path.join(dir, 'runes', '8008.png'), path.join(dir, 'runes', '8100.png')]);
  assert.strictEqual(cdn.lists().length, 4, 'perks and trees are one kind, two lists');

  // Unknown, invalid and missing ids: null, never a throw, and a 404 isn't asked again.
  const before = cdn.calls.length;
  for (const [kind, id] of [['item', 0], ['item', -3], ['item', 1.5], ['item', '3031'], ['item', NaN], ['champion', 1], ['__proto__', 1], ['item', 1e9]]) {
    assert.strictEqual(await gi.icon(kind, id), null, `${kind} ${id}`);
  }
  assert.strictEqual(cdn.calls.length, before, 'nothing fetched for invalid input');
  assert.strictEqual(await gi.icon('item', 9999), null, 'listed but 404');
  assert.strictEqual(await gi.icon('item', 9999), null);
  assert.strictEqual(cdn.calls.filter((u) => u.endsWith('odd.png')).length, 1, 'a 404 is remembered');
  assert.strictEqual(await gi.icon('item', 123456), null, 'not in a fresh list: no icon, no refetch');
  assert.strictEqual(cdn.lists().length, 4);

  // A new instance (next start) finds the icons on disk and asks nothing.
  const cdn2 = fakeCdn({ offline: true });
  const gi2 = new GameIcons(dir, { fetch: cdn2.fetch, bundled: {} });
  assert.strictEqual(await gi2.icon('item', 3031), path.join(dir, 'items', '3031.png'));
  assert.strictEqual(cdn2.calls.length, 0, 'served from disk');
  assert.strictEqual(await gi2.name('spell', 4), 'Flash', 'names from the kept list');

  // Not a PNG (a captive portal): nothing written.
  const dirB = path.join(root, 'b');
  const cdnB = fakeCdn({ notPng: new Set([relPath(SPELLS[0].iconPath)]) });
  const giB = new GameIcons(dirB, { fetch: cdnB.fetch, bundled: {} });
  assert.strictEqual(await giB.icon('spell', 4), null);
  assert.ok(!fs.existsSync(path.join(dirB, 'spells', '4.png')));

  // Offline: the bundled list stands in, the failure backs off, and nothing is fetched meanwhile.
  let now = 1_800_000_000_000;
  const dirC = path.join(root, 'c');
  const cdnC = fakeCdn({ offline: true });
  const giC = new GameIcons(dirC, { fetch: cdnC.fetch, now: () => now });
  assert.strictEqual(await giC.icon('item', 3031), null);
  const tried = cdnC.calls.length;
  assert.ok(tried >= 1 && tried <= 2, 'one try (list refresh and icon)');
  assert.strictEqual(await giC.icon('rune', 8008), null);
  assert.strictEqual(await giC.icon('spell', 4), null);
  assert.strictEqual(cdnC.calls.length, tried, 'backing off: no more requests');
  now += 11 * 60 * 1000; // back online after the back-off
  const online = fakeCdn();
  giC.fetch = online.fetch;
  assert.strictEqual(await giC.icon('item', 3031), path.join(dirC, 'items', '3031.png'));

  // The list server fails but icons don't: the bundled list still finds the icon.
  const dirD = path.join(root, 'd');
  const cdnD = fakeCdn({ lists: false });
  const giD = new GameIcons(dirD, { fetch: cdnD.fetch });
  assert.strictEqual(await giD.icon('spell', 4), path.join(dirD, 'spells', '4.png'), 'bundled path, downloaded icon');
  assert.ok(cdnD.calls.some((u) => u.endsWith('summoner_flash.png')));
  assert.strictEqual(await giD.name('spell', 4), null, 'the bundled lists carry no names');

  // A broken cache file is ignored, never fatal.
  const dirE = path.join(root, 'e');
  fs.mkdirSync(dirE, { recursive: true });
  fs.writeFileSync(path.join(dirE, 'items.json'), '{nope');
  const giE = new GameIcons(dirE, { fetch: fakeCdn().fetch, bundled: {} });
  assert.ok(await giE.icon('item', 3031));
  console.log('icon cache tests: PASS');
}

async function viewTests() {
  const mv = await load('src', 'renderer', 'js', 'views', 'matches.js');
  const v = await load('src', 'renderer', 'js', 'views', 'match.js');
  const { withRecordStats } = await load('src', 'renderer', 'js', 'lib', 'group.js');
  const URL_OF = (kind, id) => `file:///C:/icons/${kind}/${id}.png`;
  const all = (kind, id) => ({ url: URL_OF(kind, id), name: kind === 'spell' && id === 4 ? 'Flash' : null });
  const none = () => null;
  const imgs = (html) => [...html.matchAll(/<img src="([^"]*)"/g)].map((x) => x[1]);
  const noBroken = (html, what) => {
    assert.ok(!/<img src=""/.test(html), `${what}: no empty src`);
    assert.ok(!/null|undefined|NaN/.test(html.replace(/data-[a-z-]+="[^"]*"/g, '')), `${what}: no null/undefined/NaN`);
  };

  // The record's row carries the build into the match's stats.
  const row = { k: 2, d: 1, a: 1, items: [3031, 3006, 0, null, 0, 0, 3363], spells: [4, 7], keystone: 8008, subStyle: 8100 };
  const st = withRecordStats({ champion: 'Jinx' }, row);
  assert.deepStrictEqual([st.items, st.spells, st.keystone, st.subStyle], [[3031, 3006, 0, 0, 0, 0, 3363], [4, 7], 8008, 8100]);
  const bare = withRecordStats({}, { k: 1, items: [0, 0, 0, 0, 0, 0, 0], spells: [], keystone: null });
  assert.ok(!('items' in bare) && !('spells' in bare) && !('keystone' in bare), 'nothing known, nothing added');

  const match = {
    key: 'EUW1_1', champion: 'Jinx', start: Date.UTC(2026, 9, 17, 21, 0), gameTime: 1695, result: 'Defeat', clips: [], extras: [], files: [], size: 0,
    map: null, full: null, stats: { ...st, kills: 2, deaths: 1, assists: 1 },
  };
  const rowAll = mv.renderMatchRow(match, { icons: all });
  noBroken(rowAll, 'row');
  assert.strictEqual(count(rowAll, /class="mv-item"/g), 7, 'seven item squares');
  assert.strictEqual(count(rowAll, /class="gi gi-/g), 4, 'two spells, keystone, tree');
  assert.deepStrictEqual(imgs(rowAll).filter((u) => u.includes('/item/')), [URL_OF('item', 3031), URL_OF('item', 3006), URL_OF('item', 3363)]);
  assert.ok(imgs(rowAll).includes(URL_OF('rune', 8008)) && imgs(rowAll).includes(URL_OF('rune', 8100)) && imgs(rowAll).includes(URL_OF('spell', 7)));
  assert.ok(rowAll.includes('title="Flash"'), 'named once the list names it');
  const rowNone = mv.renderMatchRow(match, { icons: none });
  noBroken(rowNone, 'row without icons');
  assert.strictEqual(imgs(rowNone).filter((u) => !u.startsWith('file:///C:/champ')).length, 0, 'no icons yet: no images');
  assert.strictEqual(count(rowNone, /class="mv-item"/g), 7, 'but the squares are there');
  assert.strictEqual(count(rowNone, /class="gi gi-/g), 4);
  assert.strictEqual(mv.renderMatchRow(match), mv.renderMatchRow(match, { icons: null }), 'no resolver is the same as none');
  const throwing = mv.renderMatchRow(match, { icons: () => { throw new Error('x'); } });
  assert.strictEqual(imgs(throwing).length, 0, 'a failing resolver draws empty squares');
  // Asked once per icon per draw, ids only.
  const asked = [];
  mv.renderMatchRow(match, { icons: (k, id) => { asked.push(`${k}:${id}`); return null; } });
  assert.deepStrictEqual(asked.sort(), ['item:3006', 'item:3031', 'item:3363', 'rune:8008', 'rune:8100', 'spell:4', 'spell:7']);
  const plain = { ...match, stats: { kills: 2, deaths: 1, assists: 1 } };
  assert.ok(!/mv-build|mv-items/.test(mv.renderMatchRow(plain, { icons: all })), 'no build known: no squares');
  assert.ok(mv.matchColumns([match]).includes('mv-has-build') && !mv.matchColumns([plain]).includes('mv-has-build'));
  // Older callers' items (URLs, { icon, name }) still draw.
  const legacy = mv.renderMatchRow({ ...plain, stats: { ...plain.stats, items: ['a.png', { icon: 'b.png', name: 'B' }, null] } });
  assert.deepStrictEqual(imgs(legacy), ['a.png', 'b.png']);

  // Match page: header build and items, scoreboard rows; the old itemIcon option still works.
  const rec = await load('test', 'ui', 'preview', 'match-data.js');
  const record = rec.sampleRecord();
  record.me.spells = [11, 4];
  record.me.runes = { primary: 8100, sub: 8000, perks: [8112, 8139, 8138, 8135, 8233, 8237] };
  record.participants.forEach((p, i) => Object.assign(p, { spells: [4, i % 2 ? 12 : 14], keystone: 8010, subStyle: 8400 }));
  const pm = { key: 'EUW1_1', champion: 'Evelynn', clips: [], extras: [], files: [], stats: {}, start: Date.UTC(2026, 9, 17, 21, 0) };
  const head = v.renderMatchHeader(pm, record, { icons: all });
  noBroken(head, 'header');
  assert.ok(/class="mp-build"/.test(head) && imgs(head).includes(URL_OF('rune', 8112)) && imgs(head).includes(URL_OF('rune', 8000)) && imgs(head).includes(URL_OF('spell', 11)));
  assert.strictEqual(count(head, /class="mp-item"/g), 7);
  const headNone = v.renderMatchHeader(pm, record, {});
  noBroken(headNone, 'header without icons');
  assert.strictEqual(count(headNone, /class="mp-item"/g), 7, 'items show as squares before their icons');
  assert.strictEqual(imgs(headNone).filter((u) => !u.includes('champion')).length, 0);
  const headOld = v.renderMatchHeader(pm, record, { itemIcon: rec.itemIcon });
  assert.ok(imgs(headOld).includes(rec.itemIcon(3020)) && !/gi-spell"><img/.test(headOld), 'itemIcon: items only');

  const sb = v.renderScoreboard(pm, record, { icons: all });
  noBroken(sb, 'scoreboard');
  assert.strictEqual(count(sb, /class="mp-build mp-build-sm"/g), 10, 'a build per player');
  assert.strictEqual(count(sb, /class="mp-item"/g), 70, 'seven squares per player');
  assert.ok(imgs(sb).includes(URL_OF('rune', 8010)) && imgs(sb).includes(URL_OF('spell', 12)) && imgs(sb).includes(URL_OF('item', 3047)));
  const sbNone = v.renderScoreboard(pm, record);
  noBroken(sbNone, 'scoreboard without icons');
  assert.ok(/<th>Items<\/th>/.test(sbNone), 'the items column shows before its icons do');
  assert.strictEqual(imgs(sbNone).filter((u) => !u.includes('champion')).length, 0);
  const page = v.renderMatchPage(pm, { tab: 'scoreboard', record, icons: all });
  assert.ok(page.includes(URL_OF('rune', 8010)) && page.includes(URL_OF('rune', 8112)), 'the page passes icons to header and scoreboard');
  console.log('icon view tests: PASS');
}

(async () => {
  try {
    mapperTests();
    await cacheTests();
    await viewTests();
    console.log('game icons: PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
