// Virtual clips (src/virtual.js with the real Library, MatchStore and edit.js) on synthetic League
// footage made like the recorder makes it (test/virtual-fixture.js). The Recycle Bin is a fake
// folder in the temp test directory; no real video or profile is touched.
//   node test/virtual-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library } = require('../src/library');
const { MatchStore } = require('../src/matches');
const { VirtualClips, KEEP_SCORE } = require('../src/virtual');
const { Settings } = require('../src/settings');
const edit = require('../src/edit');
const { capture, join } = require('./virtual-fixture');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-virtual-'));
const tally = { pass: 0, fail: 0 };
async function test(name, fn) {
  try {
    await fn();
    tally.pass++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    tally.fail++;
    console.log(`FAIL  ${name}\n      ${String(err && err.stack).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

let segments = null; // one 40 s capture, shared by every scenario
let otherSegs = null; // a different capture
const KEY = 'EUW1_7000000001';

// A League match in a fresh profile: minimap, full recording (seconds 0..40 of the capture, game
// time 0 = its start) and highlights at capture seconds [4,10), [12,20), [24,30) and a favourite at
// [30,36). Returns everything the tests need.
async function scenario(name, { keepFiles = false, gameRunning = () => false, span = null, foreignClip = false } = {}) {
  const dir = path.join(ROOT, name);
  const saveDir = path.join(dir, 'Videos');
  const league = path.join(saveDir, 'League of Legends');
  const bin = path.join(dir, 'RecycleBin');
  fs.mkdirSync(league, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const binned = [];
  const trash = async (f) => { binned.push(f); fs.renameSync(f, path.join(bin, `${binned.length}-${path.basename(f)}`)); };
  const library = new Library(path.join(dir, 'profile'), () => saveDir, trash);
  const store = new MatchStore(path.join(dir, 'profile'));
  library.useMatches(store);
  const file = (label) => path.join(league, `League of Legends 2026-10-20 ${label}.mp4`);

  const map = file('Map');
  fs.copyFileSync(path.join(ROOT, 'map.mp4'), map);
  await library.add(map, { type: 'map', game: 'League of Legends', match: KEY });
  const full = await join(segments, file('Match'));
  const fullDuration = (await edit.probe(full)).duration;
  await library.add(full, { type: 'recording', game: 'League of Legends', label: 'Full match', match: KEY,
    map: { file: map, offset: 0 }, span: span == null ? fullDuration : span });
  const ranges = [[2, 5, 'Kill', 45], [6, 10, 'Double kill', 70], [12, 15, 'Dragon', 30], [15, 18, 'Bookmark', 20]];
  const clips = [];
  for (const [a, b, label, score] of ranges) {
    const f = file(label);
    if (foreignClip && label === 'Dragon') await join(otherSegs.slice(0, 3), f);
    else await join(segments.slice(a, b), f);
    // Minimap offsets rounded to a tenth and a little off, as in real matches.
    await library.add(f, { type: 'highlight', game: 'League of Legends', label, match: KEY, map: { file: map, offset: a * 2 + 0.3 },
      markers: [{ t: 1, label, type: 'kill' }] });
    await library.saveInputs(f, [[100, 'Q', 1], [300, 'Q', 0]]);
    clips.push({ file: f, label, from: a * 2, to: b * 2, score });
  }
  const favorite = clips.find((c) => c.label === 'Bookmark');
  library.setFavorite(favorite.file, true);
  await store.create({ key: KEY, gameId: 7000000001, platformId: 'EUW1', clock: { wallAt0: Date.UTC(2026, 9, 20, 20) } });
  await store.linkMedia(KEY, 'full', { file: full, gameStart: 0 });
  await store.linkMedia(KEY, 'map', { file: map, gameStart: 0 });
  for (const c of clips) await store.linkMedia(KEY, 'clip', { file: c.file, from: c.from, to: c.to, title: c.label, score: c.score });
  let running = gameRunning;
  const vc = new VirtualClips({ library, store, edit, gameRunning: () => running(), keepFiles: () => keepFiles });
  await library.list();
  return { dir, saveDir, bin, binned, library, store, vc, full, map, clips, favorite, setRunning: (fn) => { running = fn; } };
}

const exists = (f) => fs.existsSync(f);
const hashes = async (f) => (await edit.videoPackets(f, { count: 1e6 })).map((p) => p.hash);

(async () => {
  console.log(`test folder: ${ROOT}`);
  segments = await capture(ROOT, 40);
  otherSegs = await capture(ROOT, 8, { seed: 1 });
  await join(segments.slice(0, 2), path.join(ROOT, 'map.mp4'));

  await test('player: a virtual clip\'s <video> runs in clip time inside its range (range-video.js)', async () => {
    const RangeVideo = require('../src/renderer/range-video');
    // A stand-in for HTMLVideoElement: native accessors on the prototype, like the real one.
    class FakeVideo extends EventTarget {
      constructor() { super(); this._t = 0; this._d = NaN; this.paused = true; this._ended = false; this.src = ''; }
      get currentTime() { return this._t; }
      set currentTime(t) { this._t = t; this.dispatchEvent(new Event('seeked')); }
      get duration() { return this._d; }
      get ended() { return this._ended; }
      pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
      play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
    }
    const v = new FakeVideo();
    const item = { url: 'file:///full.mp4#t=100,120', virtual: { path: 'full.mp4', from: 100, to: 120 } };
    RangeVideo.load(v, item);
    assert.strictEqual(v.src, item.url);
    assert.ok(Number.isNaN(v.duration), 'no length before the metadata');
    let pageSaw = null;
    v.addEventListener('loadedmetadata', () => { pageSaw = [v.duration, v.currentTime]; });
    v._d = 1800;
    v.dispatchEvent(new Event('loadedmetadata'));
    assert.deepStrictEqual(pageSaw, [20, 0], 'the page sees a 20 s clip at its start');
    assert.strictEqual(v._t, 100, 'the full recording is at the range start');
    v.currentTime = 5;
    assert.strictEqual(v._t, 105);
    v.currentTime = 50;
    assert.strictEqual(v.currentTime, 20, 'seeks stay inside the range');
    v.currentTime = -3;
    assert.strictEqual(v._t, 100);
    let ended = 0;
    v.addEventListener('ended', () => ended++);
    v.play();
    v._t = 119.995;
    v.dispatchEvent(new Event('timeupdate'));
    assert.ok(v.paused && ended === 1 && v.ended, 'stops and ends at the range end');
    v.play();
    assert.strictEqual(v.currentTime, 0, 'playing again starts over');
    assert.ok(!v.ended);
    // A normal file afterwards: the element is itself again.
    RangeVideo.load(v, { url: 'file:///clip.mp4', virtual: null });
    v._t = 7;
    assert.strictEqual(v.currentTime, 7);
    assert.strictEqual(v.duration, 1800);
    assert.ok(!Object.prototype.hasOwnProperty.call(v, 'currentTime'));
  });

  await test('setting: "Keep separate highlight files" is on by default, and only an explicit off turns it off', async () => {
    const dir = path.join(ROOT, 'settings');
    fs.mkdirSync(dir, { recursive: true });
    const s = new Settings(dir, dir);
    assert.strictEqual(s.values.keepHighlightFiles, true);
    s.update({ keepHighlightFiles: 'nonsense' });
    assert.strictEqual(s.values.keepHighlightFiles, true);
    s.update({ keepHighlightFiles: false });
    assert.strictEqual(new Settings(dir, dir).values.keepHighlightFiles, false);
  });

  await test('default (keep files): nothing is virtualized after a match', async () => {
    const s = await scenario('default', { keepFiles: true });
    assert.strictEqual(await s.vc.afterMatch(KEY), null);
    assert.deepStrictEqual(s.binned, []);
    for (const c of s.clips) assert.ok(exists(c.file) && !s.library.isVirtual(c.file));
  });

  let shared = null;
  await test('verify then virtualize: highlights become ranges, their files go to the Recycle Bin', async () => {
    const s = await scenario('virtualize');
    shared = s;
    const originals = {};
    for (const c of s.clips) originals[c.file] = await hashes(c.file);
    s.originals = originals;
    const res = await s.vc.afterMatch(KEY);
    assert.strictEqual(res.clips, 3, 'three non-favourite highlights');
    assert.ok(res.bytes > 0);
    assert.deepStrictEqual(s.binned.map((f) => path.basename(f)).sort(),
      s.clips.filter((c) => c !== s.favorite).map((c) => path.basename(c.file)).sort());
    const items = await s.library.list();
    for (const c of s.clips.filter((x) => x !== s.favorite)) {
      assert.ok(!exists(c.file), 'its file is gone');
      const item = items.find((i) => i.path === c.file);
      assert.ok(item, `${c.label} is still in the library`);
      assert.ok(item.virtual, 'marked virtual');
      assert.strictEqual(item.virtual.path, s.full);
      assert.ok(Math.abs(item.virtual.from - c.from) < 0.1, `${c.label} starts at ${item.virtual.from}, not ${c.from}`);
      assert.ok(Math.abs(item.virtual.to - c.to) < 0.15, `${c.label} ends at ${item.virtual.to}, not ${c.to}`);
      assert.strictEqual(item.size, 0, 'takes no space');
      assert.ok(item.url.includes('Match.mp4'), 'plays the full recording');
      assert.strictEqual((await s.library.loadInputs(c.file)).length, 2, 'its key presses stay');
    }
    const rec = await s.store.get(KEY);
    const virtual = rec.media.clips.filter((c) => c.file === null);
    assert.strictEqual(virtual.length, 3, 'the record knows they are ranges');
    assert.ok(virtual.every((c) => c.was && Number.isFinite(c.from) && Number.isFinite(c.to)));
    assert.strictEqual(await s.store.byFile(s.clips[0].file), KEY, 'still found by its old path');
  });

  await test('favourites are never virtualized', async () => {
    const s = shared;
    assert.ok(exists(s.favorite.file), 'the favourite keeps its file');
    assert.ok(!s.library.isVirtual(s.favorite.file));
    assert.ok(!s.binned.includes(s.favorite.file));
    await assert.rejects(s.library.virtualize(s.favorite.file, { full: s.full, from: 30, to: 36 }), /Favourites/);
    assert.ok(exists(s.favorite.file));
  });

  await test('materialize: a virtual clip becomes its own file again, frame for frame', async () => {
    const s = shared;
    const c = s.clips[1];
    const out = await s.vc.materialize(c.file);
    assert.strictEqual(out, c.file, 'back at its old path');
    assert.ok(exists(out) && !s.library.isVirtual(out));
    const got = await hashes(out);
    const want = s.originals[c.file];
    assert.deepStrictEqual(got.slice(0, want.length), want, 'same video packets as the original highlight');
    assert.ok(got.length - want.length <= 2);
    const rec = await s.store.get(KEY);
    const entry = rec.media.clips.find((x) => x.file && x.file.toLowerCase() === c.file.toLowerCase());
    assert.ok(entry && !entry.was, 'the record points at the file again');
    // Favouriting needs a file; library.setFavorite refuses a virtual clip.
    assert.throws(() => s.library.setFavorite(s.clips[0].file, true), /file before/);
    const [a, b] = await Promise.all([s.vc.materialize(s.clips[0].file), s.vc.materialize(s.clips[0].file)]);
    assert.strictEqual(a, b, 'two requests share one export');
    s.library.setFavorite(a, true);
    assert.ok(s.library.meta(a).favorite);
  });

  await test('a virtual clip restored from the Recycle Bin is a file again', async () => {
    const s = shared;
    const c = s.clips[2];
    assert.ok(s.library.isVirtual(c.file));
    const binnedCopy = fs.readdirSync(s.bin).find((n) => n.endsWith(path.basename(c.file)));
    fs.renameSync(path.join(s.bin, binnedCopy), c.file);
    await s.library.list();
    assert.ok(!s.library.isVirtual(c.file));
    await s.store.flush();
    const rec = await s.store.get(KEY);
    assert.ok(rec.media.clips.some((x) => x.file && x.file.toLowerCase() === c.file.toLowerCase()));
  });

  await test('deleting a virtual clip sends nothing to the Recycle Bin', async () => {
    const s = await scenario('delete-virtual');
    await s.vc.afterMatch(KEY);
    const c = s.clips[0];
    const before = s.binned.length;
    await s.library.remove(c.file);
    assert.strictEqual(s.binned.length, before);
    assert.strictEqual(s.library.meta(c.file), null);
    assert.ok(exists(s.full), 'the full recording stays');
  });

  await test('refused: the full recording is shorter than what was recorded', async () => {
    const s = await scenario('short', { span: 80 });
    const res = await s.vc.afterMatch(KEY);
    assert.strictEqual(res.clips, 0);
    assert.deepStrictEqual(s.binned, []);
    const plan = await s.vc.plan({ key: KEY });
    assert.match(plan[0].problem, /recorded/);
  });

  await test('refused: the full recording changed or can\'t be read', async () => {
    const s = await scenario('corrupt');
    fs.writeFileSync(s.full, 'damaged');
    await s.library.list(); // the library notices the new size
    s.library._enqueue = () => {};
    const res = await s.vc.afterMatch(KEY);
    assert.strictEqual(res.clips, 0);
    assert.deepStrictEqual(s.binned, []);
    for (const c of s.clips) assert.ok(exists(c.file));
  });

  await test('refused: a highlight whose footage isn\'t in the full recording keeps its file', async () => {
    const s = await scenario('foreign', { foreignClip: true });
    const res = await s.vc.afterMatch(KEY);
    assert.strictEqual(res.clips, 2);
    const dragon = s.clips.find((c) => c.label === 'Dragon');
    assert.ok(exists(dragon.file) && !s.library.isVirtual(dragon.file));
  });

  await test('refused: never while a League game runs, and it stops if one starts', async () => {
    const s = await scenario('live', { gameRunning: () => true });
    assert.strictEqual(await s.vc.afterMatch(KEY), null);
    const preview = await s.vc.preview();
    await assert.rejects(s.vc.freeUpSpace(preview.token), /game/);
    assert.deepStrictEqual(s.binned, []);
    s.setRunning(() => false);
    const plans = await s.vc.plan();
    s.setRunning(() => s.binned.length >= 1); // a game starts right after the first clip
    const res = await s.vc._apply(plans);
    assert.strictEqual(res.clips, 1);
    assert.strictEqual(res.stopped, 'a game started');
    assert.strictEqual(s.binned.length, 1);
  });

  await test('Free up space: the preview changes nothing; only a confirmed preview runs', async () => {
    const s = await scenario('free', { keepFiles: true });
    const preview = await s.vc.preview();
    assert.strictEqual(preview.clips, 3);
    assert.ok(preview.bytes > 0);
    assert.strictEqual(preview.matches[0].files.length, 3);
    assert.deepStrictEqual(s.binned, []);
    for (const c of s.clips) assert.ok(exists(c.file));
    await assert.rejects(s.vc.freeUpSpace('wrong'), /preview/);
    // A clip that became a favourite after the preview is left alone.
    s.library.setFavorite(s.clips[0].file, true);
    const res = await s.vc.freeUpSpace(preview.token);
    assert.strictEqual(res.clips, 2);
    assert.ok(exists(s.clips[0].file));
    await assert.rejects(s.vc.freeUpSpace(preview.token), /preview/, 'a preview runs once');
  });

  await test(`materialize before delete: favourites and clips scoring ${KEEP_SCORE}+ become files first; the record stays`, async () => {
    const s = await scenario('delete-full');
    await s.vc.afterMatch(KEY);
    const [kill, double, dragon] = s.clips; // scores 45, 70, 30
    // A virtual favourite (from an older version, say) must be kept too.
    s.library.meta(kill.file).favorite = true;
    await s.library.remove(s.full);
    assert.ok(!exists(s.full) && s.binned.includes(s.full), 'the full recording went to the Recycle Bin');
    assert.ok(exists(kill.file) && s.library.meta(kill.file).favorite, 'the favourite is a file');
    assert.ok(exists(double.file), 'the double kill (score 70) is a file');
    assert.ok(!exists(dragon.file) && !s.library.meta(dragon.file), 'the dragon (score 30) went with the recording');
    assert.ok(exists(s.map), 'the minimap stays');
    await s.store.flush();
    const rec = await s.store.get(KEY);
    assert.ok(rec, 'the match record stays');
    assert.strictEqual(rec.media.full.length, 0);
  });

  await test('materialize before delete: if a keeper can\'t be saved, the full recording stays', async () => {
    const s = await scenario('delete-fails');
    await s.vc.afterMatch(KEY);
    const double = s.clips[1];
    // Something sits at the clip's old path and its numbered names can't be written.
    const realExport = edit.exportRange;
    s.vc.edit = { ...edit, exportRange: async () => { throw new Error('disk full'); } };
    await assert.rejects(s.library.remove(s.full), /disk full/);
    s.vc.edit = { ...edit, exportRange: realExport };
    assert.ok(exists(s.full) && !s.binned.includes(s.full), 'nothing was deleted');
    assert.ok(s.library.isVirtual(double.file), 'the clip still plays from the full recording');
  });

  await test('storage limit: the full recording goes, its best clips are saved first', async () => {
    const s = await scenario('limit');
    await s.vc.afterMatch(KEY);
    // A newer match so this one isn't the latest.
    const other = path.join(s.saveDir, 'League of Legends', 'newer Map.mp4');
    fs.copyFileSync(path.join(ROOT, 'map.mp4'), other);
    await s.library.add(other, { type: 'map', game: 'League of Legends', match: 'EUW1_7000000002' });
    s.library.index[other].created = Date.now() + 1000;
    const used = s.library.usage().total;
    const fullSize = s.library.meta(s.full).size;
    await s.library.enforceLimit(used - fullSize / 2);
    assert.ok(!exists(s.full), 'the full recording went first');
    assert.ok(exists(s.clips[1].file), 'the double kill was saved first');
  });

  await test('a virtual clip is trimmed from its range of the full recording', async () => {
    const s = await scenario('trim');
    await s.vc.afterMatch(KEY);
    const c = s.clips[1]; // 12..20 s of the capture
    s.library._enqueue = () => {};
    const item = await s.library.trim(c.file, 2, 5, 'x264');
    assert.ok(exists(item.path));
    const d = (await edit.probe(item.path)).duration;
    assert.ok(Math.abs(d - 3) < 0.2, `trimmed to ${d} s`);
    assert.strictEqual((await s.library.loadInputs(item.path)).length, 0, 'presses outside 2..5 s are left out');
  });

  console.log(`\n${tally.pass} passed, ${tally.fail} failed`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(tally.fail ? 1 : 0);
})().catch((err) => {
  console.error('FAILED:', err.stack || err.message);
  process.exit(1);
});
