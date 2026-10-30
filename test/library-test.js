// Library bookkeeping: favourites, storage use and the storage limit (oldest non-favourite
// videos go to the Recycle Bin first). Uses small fake files and a fake Recycle Bin.
//   node test/library-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library } = require('../src/library');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-lib-'));
  const saveDir = path.join(root, 'Videos');
  const gameDir = path.join(saveDir, 'Some Game');
  fs.mkdirSync(gameDir, { recursive: true });
  const binned = [];
  const lib = new Library(path.join(root, 'profile'), () => saveDir, async (f) => { binned.push(path.basename(f)); fs.rmSync(f); },
    { iconFor: (name) => (name === 'Jinx' ? __filename : null) });
  lib._enqueue = () => {}; // no ffprobe / thumbnails for fake files

  const MB = 1024 * 1024;
  const files = [];
  for (let i = 0; i < 5; i++) {
    const f = path.join(gameDir, `video ${i}.mp4`);
    fs.writeFileSync(f, Buffer.alloc(MB * (i + 1))); // 1..5 MB
    files.push(f);
  }
  let items = await lib.list();
  assert.strictEqual(items.length, 5);
  // make the creation order explicit: video 0 is the oldest
  files.forEach((f, i) => { lib.index[f].created = 1000 + i; });

  // favourites
  lib.setFavorite(files[0], true);
  lib.setFavorite(files[3], true);
  items = await lib.list();
  assert.deepStrictEqual(items.filter((i) => i.favorite).map((i) => i.name).sort(), ['video 0', 'video 3']);
  assert.throws(() => lib.setFavorite(path.join(root, 'elsewhere.mp4'), true), /not in the ClipVault folder/);

  const u = lib.usage();
  assert.strictEqual(u.total, 15 * MB);
  assert.strictEqual(u.favorites, 5 * MB); // 1 + 4
  assert.strictEqual(u.count, 5);

  // champion icons come from the caller's cache
  lib.index[files[1]].champion = 'Jinx';
  lib.index[files[2]].stats = { champion: 'Jinx', kills: 1, deaths: 2, assists: 3 };
  assert.ok(lib.itemFor(files[1]).championIcon.startsWith('file:'));
  assert.deepStrictEqual(lib.champions(), ['Jinx']);
  assert.strictEqual(lib.itemFor(files[4]).championIcon, null);

  // limit 8 MB of non-favourites (2 + 3 + 5 = 10 MB): the oldest non-favourite (video 1, 2 MB) goes
  let r = await lib.enforceLimit(8 * MB);
  assert.deepStrictEqual(binned, ['video 1.mp4']);
  assert.strictEqual(r.freed, 2 * MB);
  // a protected file is skipped even when it's the oldest
  r = await lib.enforceLimit(4 * MB, { keep: [files[2]] });
  assert.deepStrictEqual(binned, ['video 1.mp4', 'video 4.mp4']);
  // favourites are never removed, whatever the limit
  r = await lib.enforceLimit(0);
  assert.deepStrictEqual(binned, ['video 1.mp4', 'video 4.mp4', 'video 2.mp4']);
  assert.ok(fs.existsSync(files[0]) && fs.existsSync(files[3]));
  items = await lib.list();
  assert.deepStrictEqual(items.map((i) => i.name).sort(), ['video 0', 'video 3']);

  // Match-aware limit: two League matches (minimap 1 MB, full recording 10 MB, two 2 MB
  // highlights each) and an old loose clip (1 MB). Old full recordings go first, never the
  // latest match's; then the oldest units, highlights before the minimap.
  const lol = path.join(saveDir, 'League of Legends');
  fs.mkdirSync(lol, { recursive: true });
  const made = {};
  const mk = (name, mb, meta) => {
    const f = path.join(lol, `${name}.mp4`);
    fs.writeFileSync(f, Buffer.alloc(mb * MB));
    made[name] = f;
    return [f, meta];
  };
  const matchFiles = [];
  for (const [m, base] of [['A', 5000], ['B', 9000]]) {
    const [mapF] = mk(`${m} map`, 1, null);
    matchFiles.push([mapF, { type: 'map', created: base + 40 }]);
    matchFiles.push(mk(`${m} full`, 10, { type: 'recording', created: base + 39, map: { file: mapF, offset: -1.6 } }));
    matchFiles.push(mk(`${m} kill`, 2, { type: 'highlight', created: base + 10, map: { file: mapF, offset: 10 } }));
    matchFiles.push(mk(`${m} death`, 2, { type: 'highlight', created: base + 20, map: { file: mapF, offset: 20 } }));
  }
  matchFiles.push(mk('loose clip', 1, { type: 'clip', created: 4000 }));
  await lib.list();
  for (const [f, meta] of matchFiles) Object.assign(lib.index[f], meta);
  binned.length = 0;
  // 31 MB of non-favourites besides videos 0 and 3 (favourites): removing A's full recording is enough.
  r = await lib.enforceLimit(25 * MB);
  assert.deepStrictEqual(binned, ['A full.mp4']);
  // Tighter: B's full recording (the latest match) survives; the loose clip, then A's highlights,
  // then A's minimap, then B's highlights go.
  r = await lib.enforceLimit(12 * MB);
  assert.deepStrictEqual(binned, ['A full.mp4', 'loose clip.mp4', 'A kill.mp4', 'A death.mp4', 'A map.mp4', 'B kill.mp4', 'B death.mp4']);
  assert.ok(fs.existsSync(made['B full']) && fs.existsSync(made['B map']));
  for (const f of ['B full', 'B map']) await lib.remove(made[f]);
  items = await lib.list();
  assert.deepStrictEqual(items.map((i) => i.name).sort(), ['video 0', 'video 3']);
  // A highlight video made from a match exposes its source minimap.
  lib.index[files[0]].source = { map: 'C:\\somewhere\\map.mp4' };
  assert.deepStrictEqual(lib.itemFor(files[0]).source, { map: 'C:\\somewhere\\map.mp4' });
  delete lib.index[files[0]].source;

  // An unreachable save folder (an unplugged drive) must not wipe the index.
  clearTimeout(lib.saveTimer);
  const away = `${saveDir}-unplugged`;
  fs.renameSync(saveDir, away);
  items = await lib.list();
  assert.strictEqual(items.length, 0, 'nothing to show while the folder is gone');
  assert.ok(lib.index[files[0]] && lib.index[files[0]].favorite, 'the favourite is still indexed');
  fs.renameSync(away, saveDir);
  items = await lib.list();
  assert.deepStrictEqual(items.filter((i) => i.favorite).map((i) => i.name).sort(), ['video 0', 'video 3']);

  // Index saves are atomic, a clean load keeps a backup, and a corrupt index is never overwritten.
  clearTimeout(lib.saveTimer);
  await lib._saveIndex();
  const profile = path.join(root, 'profile');
  const indexFile = path.join(profile, 'library.json');
  assert.ok(JSON.parse(fs.readFileSync(indexFile, 'utf8'))[files[0]].favorite, 'the saved index is valid JSON');
  assert.deepStrictEqual(fs.readdirSync(profile).filter((f) => f.endsWith('.tmp')), [], 'no temporary files left behind');
  const notes = [];
  const lib2 = new Library(profile, () => saveDir, async () => {}, { log: (m) => notes.push(m) });
  assert.ok(fs.existsSync(`${indexFile}.bak`), 'a clean load keeps a backup');
  assert.strictEqual(Object.keys(lib2.index).length, 2);
  fs.writeFileSync(indexFile, '{"truncated mid-wri'); // what a crash during the old in-place write left
  const lib3 = new Library(profile, () => saveDir, async () => {}, { log: (m) => notes.push(m) });
  assert.ok(lib3.index[files[0]] && lib3.index[files[0]].favorite, 'restored from the backup');
  const corrupt = fs.readdirSync(profile).filter((f) => f.startsWith('library.json.corrupt-'));
  assert.strictEqual(corrupt.length, 1, 'the unreadable file is kept aside');
  assert.strictEqual(fs.readFileSync(path.join(profile, corrupt[0]), 'utf8'), '{"truncated mid-wri');
  assert.ok(notes.some((m) => /restored library\.json/.test(m)), 'the restore is logged');

  clearTimeout(lib.saveTimer); // the index is saved shortly after changes; don't recreate the folder
  clearTimeout(lib.changeTimer);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('library tests: PASS');
})().catch((err) => {
  console.error('FAIL:', err.stack || err.message);
  process.exit(1);
});
