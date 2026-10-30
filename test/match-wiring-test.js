// The League match wiring (Release 2): what the game watcher hands over at the end of a match
// (A1), the match capture against test/league-mock.js + test/lcu-mock.js + the store (A6, A7),
// and the one-time backfill of library.json (C1). Temp folders only; the real profile, the real
// League client and the real game are out of reach (same guards as test/match-test.js).
//   node test/match-wiring-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { isInside } = require('../src/fsutil');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-wiring-'));
process.env.ProgramData = path.join(root, 'ProgramData');
const MOCK_PORTS = new Set();
const GUARD_TRIPS = [];
const readFileSync = fs.readFileSync;
fs.readFileSync = function guardedReadFileSync(file, ...rest) {
  if (typeof file === 'string' && /(^|[\\/])lockfile$/i.test(file) && !isInside(file, root)) {
    GUARD_TRIPS.push(`read ${file}`);
    throw new Error(`test guard: refused to read ${file}`);
  }
  return readFileSync.call(this, file, ...rest);
};
for (const mod of [http, https]) {
  const request = mod.request;
  const get = mod.get;
  const check = (target) => {
    const u = target instanceof URL ? target : typeof target === 'string' ? new URL(target) : null;
    const host = u ? u.hostname : target && target.hostname;
    const port = Number(u ? u.port : target && target.port);
    if (host !== '127.0.0.1' || !MOCK_PORTS.has(port)) {
      GUARD_TRIPS.push(`request ${host}:${port}`);
      throw new Error(`test guard: refused a request to ${host}:${port}`);
    }
  };
  mod.request = function guardedRequest(target, ...rest) { check(target); return request.call(this, target, ...rest); };
  mod.get = function guardedGet(target, ...rest) { check(target); return get.call(this, target, ...rest); };
}

const { LeagueWatcher } = require('../src/games/league');
const { startMockLeague } = require('./league-mock');
const lcuMock = require('./lcu-mock');
const lcu = require('../src/games/lcu');
const lm = require('../src/games/league-match');
const { MatchStore } = require('../src/matches');
const { MatchCapture } = require('../src/match-capture');
const { migrateLibrary } = require('../src/matches-migrate');
const { Library } = require('../src/library');

const { GAME_ID } = lcuMock;
const KEY = `EUW1_${GAME_ID}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol, what) => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
const settle = (ms = 700) => sleep(ms); // the library's change events are debounced
const WATCH_OPTIONS = {
  enabled: true, kills: true, deaths: true, assists: false, objectives: true, structures: false, gameEnd: true, bookmarks: true,
  before: 1, after: 1, mergeGap: 2,
};

// A League match played by league-mock from `startAt` (game seconds) to its GameEnd at 58 s.
// The same match lcu-mock reports on (its ten players and its live event script).
const SCRIPT = lcuMock.LIVE_SCRIPT.filter((e) => e.EventName !== 'GameStart'); // league-mock adds GameStart
async function playMatch({ startAt = 54, players = lcuMock.makeAllGameData().allPlayers } = {}) {
  const mock = startMockLeague({ port: 0, startAt, closeAt: 61, players, script: SCRIPT });
  await new Promise((r) => (mock.server.listening ? r() : mock.server.once('listening', r)));
  const port = mock.server.address().port;
  MOCK_PORTS.add(port);
  const watcher = new LeagueWatcher({ baseUrl: `http://127.0.0.1:${port}/liveclientdata`, getOptions: () => WATCH_OPTIONS });
  const seen = { start: null, end: null, highlights: [] };
  watcher.on('match-start', (e) => { seen.start = e; seen.startSnapshot = watcher.startSnapshot(); });
  watcher.on('highlight', (h) => seen.highlights.push(h));
  const ended = new Promise((resolve) => watcher.on('match-end', (e) => { seen.end = e; resolve(e); }));
  watcher.start();
  return { mock, watcher, seen, ended, port };
}

// ---------------------------------------------------------------- A1: what match-end carries

async function watcherTests() {
  const { mock, watcher, seen, ended } = await playMatch();
  const end = await Promise.race([ended, sleep(15000).then(() => null)]);
  watcher.stop();
  await mock.close();
  assert.ok(end, 'match-end arrived');
  assert.ok(seen.start, 'match-start arrived');
  assert.strictEqual(seen.start.gameMode, 'CLASSIC');
  assert.strictEqual(seen.start.mapNumber, 11);
  assert.ok(Number.isFinite(seen.start.detectedAt));
  assert.ok(seen.startSnapshot && seen.startSnapshot.allPlayers.length === 10, 'allgamedata read at the start');
  // The old fields are still there.
  assert.strictEqual(end.result, 'Win');
  assert.strictEqual(end.champion, 'Jinx');
  assert.ok(Array.isArray(end.moments) && end.moments.some((m) => m.type === 'victory'));
  // The new ones.
  assert.ok(end.final && Array.isArray(end.final.allPlayers) && end.final.allPlayers.length === 10, 'final allgamedata snapshot');
  assert.strictEqual(end.roster.length, 10);
  const names = end.events.map((e) => e.EventName);
  assert.strictEqual(names[0], 'GameStart', 'every raw event, from the first');
  assert.ok(names.includes('GameEnd') && names.includes('DragonKill') && names.filter((n) => n === 'ChampionKill').length === 5, names.join(','));
  assert.strictEqual(end.gameMode, 'CLASSIC');
  assert.strictEqual(end.mapNumber, 11);
  assert.strictEqual(end.gameEndTime, 58);
  assert.ok(Number.isFinite(end.wallAt0), 'wallAt0 estimated');
  assert.ok(Math.abs(end.wallAt0 - mock.t0) < 400, `wallAt0 within 0.4 s of the mock's game time 0 (${end.wallAt0 - mock.t0} ms)`);
  console.log('watcher match-end tests: PASS');
}

// ---------------------------------------------------------------- end to end: game + client + store

const QUICK = { historyDelays: [150, 150, 150, 150, 150], eogTries: 30, eogDelayMs: 100, phaseTimeoutMs: 15000, phaseIntervalMs: 100 };

function fakeLibrary(dir) {
  const saveDir = path.join(dir, 'Videos');
  fs.mkdirSync(path.join(saveDir, 'League of Legends'), { recursive: true });
  const lib = new Library(path.join(dir, 'profile'), () => saveDir, async (file) => fs.rmSync(file, { force: true }));
  lib._enqueue = () => {};
  const video = (name, meta) => {
    const file = path.join(saveDir, 'League of Legends', name);
    fs.writeFileSync(file, 'not really a video');
    lib.index[file] = { size: 18, mtime: fs.statSync(file).mtimeMs, created: Date.now(), probed: true, ...meta };
    return file;
  };
  return { lib, saveDir, video };
}

let firstRun = null; // run 1's watcher payloads, replayed by the no-client run

async function endToEndTests() {
  const dir = path.join(root, 'e2e');
  fs.mkdirSync(dir, { recursive: true });
  const client = await lcuMock.startMockLcu({ root: dir, phases: [['InProgress', Infinity], ['WaitingForStats', 300], ['PreEndOfGame', 300], ['EndOfGame', 0]], historyMisses: 2 });
  MOCK_PORTS.add(client.port);
  const logs = [];
  const store = new MatchStore(path.join(dir, 'profile'), { log: (m) => logs.push(m) });
  const { lib, video } = fakeLibrary(dir);
  lib.useMatches(store);
  const capture = new MatchCapture({
    store, client: lcu.createClient({ installDir: client.installDir, baseUrl: client.url }), installDir: client.installDir, log: (m) => logs.push(m), ...QUICK,
  });

  const { mock, watcher, ended } = await playMatch();
  let ctx = null;
  let clipFile = null;
  let localKey = null;
  watcher.on('match-start', (e) => {
    ctx = capture.start({ ...e, live: watcher.startSnapshot() });
    localKey = ctx.key;
    // A highlight saved before the real key is known carries the local one.
    clipFile = video('League of Legends 2026-10-18 12-00-03 Double kill.mp4', { type: 'highlight', event: 'multikill', label: 'Double kill', match: ctx.key });
    firstRun = { start: e, live: watcher.startSnapshot() };
  });
  const end = await Promise.race([ended, sleep(15000).then(() => null)]);
  watcher.stop();
  await mock.close();
  assert.ok(end && ctx, 'the match started and ended');
  firstRun.end = end;
  await ctx.ready;
  assert.ok(/^local-\d+$/.test(localKey), localKey);
  assert.strictEqual(ctx.key, KEY, 'rekeyed from the League client session');
  assert.strictEqual((await store.get(localKey)).key, KEY, 'the local key still resolves');
  await settle();
  assert.strictEqual(lib.index[clipFile].match, KEY, 'library entry follows the rekey');

  const t0 = end.wallAt0;
  const fullFile = video('League of Legends 2026-10-18 12-00-00 Jinx Victory Match.mp4', { type: 'recording', match: ctx.key });
  const mapFile = video('League of Legends 2026-10-18 12-00-01 Jinx Map.mp4', { type: 'map', match: ctx.key });
  capture.addMedia(ctx, 'clip', {
    file: clipFile, startWall: t0 + 3000, duration: 8, title: 'Double kill', type: 'multikill',
    moments: [{ wallMs: t0 + 4000, label: 'Kill', type: 'kill', score: 30 }, { wallMs: t0 + 6500, label: 'Double kill', type: 'multikill', score: 70 }],
  });
  capture.addMedia(ctx, 'full', { file: fullFile, startWall: t0 - 5000 });
  capture.addMedia(ctx, 'map', { file: mapFile, startWall: t0 - 4000 });
  client.endGame(); // the client moves on to the post-game screens
  const rec = await capture.end(ctx, end);
  assert.ok(rec, `end resolved the record\n${logs.join('\n')}`);
  assert.strictEqual(rec.key, KEY);
  assert.deepStrictEqual(rec.pending, [], `nothing pending after the retries (${rec.pending})\n${logs.join('\n')}`);
  assert.ok(client.count(`/lol-match-history/v1/games/${GAME_ID}`) >= 3, 'match history was retried past its 404s');
  assert.strictEqual(rec.participants.length, 10, '10 participants');
  const eog = lm.fromEog(lcuMock.makeEogBlock());
  const eogMe = eog.participants.find((p) => p.championId === lcuMock.ME.championId);
  const liveMe = lm.fromLive(lcuMock.makeAllGameData(), 'Tester#EUW').participants.find((p) => p.isMe);
  assert.strictEqual(rec.me.championId, lcuMock.ME.championId);
  assert.strictEqual(rec.me.cs, eogMe.cs, 'exact CS from the end-of-game stats');
  assert.ok(!rec.me.csApprox, 'CS is exact');
  assert.notStrictEqual(liveMe.cs, eogMe.cs, '(the game alone only knows CS to the nearest 10)');
  assert.ok(rec.me.damage > 0 && rec.me.damage === eogMe.damage, `damage ${rec.me.damage}`);
  assert.ok(rec.me.gold > 0, 'gold');
  assert.ok(Array.isArray(rec.me.items) && rec.me.items.some(Boolean), 'items');
  assert.ok(rec.participants.every((p) => p.championId != null && p.damage != null && p.gold != null), 'everyone has damage and gold');
  assert.ok(rec.sources.eog && rec.sources.history && rec.sources.timeline && rec.sources.liveFinal && rec.sources.session, JSON.stringify(rec.sources));
  assert.strictEqual(rec.result, 'Win');
  assert.ok(rec.rank && rec.rank.lpDelta != null, 'LP from the ranked game');
  assert.ok(rec.events.length >= 10 && rec.events.some((e) => e.name === 'GameEnd'), 'the whole event feed');
  // Videos, in game time.
  assert.strictEqual(rec.media.clips.length, 1);
  near(rec.media.clips[0].from, 3, 0.05, 'clip from');
  near(rec.media.clips[0].to, 11, 0.05, 'clip to');
  near(rec.media.clips[0].moments[1].t, 6.5, 0.05, 'moment time');
  near(rec.media.full[0].gameStart, -5, 0.05, 'full recording gameStart');
  near(rec.media.map.gameStart, -4, 0.05, 'minimap gameStart');
  assert.ok(await store.readRaw(KEY, 'eog') && await store.readRaw(KEY, 'game') && await store.readRaw(KEY, 'timeline'), 'raw documents kept');
  const rows = await store.list();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].cs, eogMe.cs);
  assert.deepStrictEqual(client.rejected, [], 'GET only');
  assert.ok(!logs.some((m) => /refused/.test(m)), logs.join('\n'));

  // The library keeps the record in step: rename, then delete.
  await lib.rename(clipFile, 'Best double kill');
  const renamed = path.join(path.dirname(clipFile), 'Best double kill.mp4');
  await store.flush();
  assert.strictEqual((await store.get(KEY)).media.clips[0].file, renamed);
  await lib.remove(renamed);
  await store.flush();
  const after = await store.get(KEY);
  assert.strictEqual(after.media.clips.length, 0, 'deleted video taken off its match');
  assert.strictEqual(after.participants.length, 10, 'stats stay');
  await client.close();
  console.log('end-to-end tests: PASS');
}

// No League client: the game log's ID, everything else pending; the sweep fills it in later.
async function noClientTests() {
  assert.ok(firstRun && firstRun.end, 'needs the end-to-end run first');
  const dir = path.join(root, 'no-client');
  const installDir = path.join(dir, 'League of Legends');
  fs.mkdirSync(installDir, { recursive: true });
  lcuMock.writeGameLog(installDir, firstRun.start.detectedAt - 10000);
  const logs = [];
  const store = new MatchStore(path.join(dir, 'profile'), { log: (m) => logs.push(m) });
  const offline = lcu.createClient({ installDir }); // no lockfile: no League client
  const capture = new MatchCapture({ store, client: offline, installDir, log: (m) => logs.push(m), ...QUICK, phaseTimeoutMs: 300 });
  const ctx = capture.start({ ...firstRun.start, live: firstRun.live });
  await ctx.ready;
  assert.strictEqual(ctx.key, KEY, 'rekeyed from the game log');
  const rec = await capture.end(ctx, firstRun.end);
  assert.strictEqual(rec.key, KEY);
  assert.deepStrictEqual(rec.pending, ['history', 'timeline'], `pending: ${rec.pending}`);
  assert.strictEqual(rec.participants.length, 10, 'the roster from the game');
  assert.ok(rec.me.csApprox, 'CS from the game is approximate');
  assert.strictEqual(rec.sources.eog, null);

  // Later, with the League client running: the sweep fills in history and the timeline.
  const client = await lcuMock.startMockLcu({ root: path.join(dir, 'later'), phases: [['None', 0]], historyMisses: 0 });
  MOCK_PORTS.add(client.port);
  const online = new MatchCapture({ store, client: lcu.createClient({ installDir: client.installDir, baseUrl: client.url }), installDir, log: (m) => logs.push(m), ...QUICK });
  const changed = await online.sweep();
  assert.strictEqual(changed, 1, logs.join('\n'));
  const filled = await store.get(KEY);
  assert.deepStrictEqual(filled.pending, []);
  assert.ok(filled.sources.history && filled.sources.timeline);
  const histMe = lm.fromHistory(lcuMock.makeHistoryGame()).participants.find((p) => p.championId === lcuMock.ME.championId);
  assert.strictEqual(filled.me.cs, histMe.cs);
  assert.ok(!filled.me.csApprox);
  assert.strictEqual(await online.sweep(), 0, 'nothing left to do');
  await client.close();
  console.log('no-client tests: PASS');
}

// ---------------------------------------------------------------- old matches, later

// A backfilled match (its minimap markers say "Kill", never who) once the League client is open:
// the sweep's match history and timeline name the champions on both sides of every kill, and the
// match page shows them (the moments list and the timeline's hover cards).
async function legacyFillTests() {
  const { legacyRecord } = require('../src/matches-migrate');
  const { pathToFileURL } = require('url');
  const dir = path.join(root, 'legacy-fill');
  fs.mkdirSync(dir, { recursive: true });
  const ME = lcuMock.ME;
  const mapFile = path.join(dir, `League of Legends 2026-10-17 22-36-14 ${ME.champion} Map.mp4`);
  const stats = { champion: ME.champion, kills: ME.k, deaths: ME.d, assists: ME.a, level: 0, result: 'Victory', gameMode: 'CLASSIC', gameTime: 58 };
  const map = { type: 'map', champion: ME.champion, stats, duration: 80, created: Date.now(), markers: [{ t: 30, label: 'Kill', type: 'kill' }, { t: 60, label: 'Victory', type: 'victory' }] };
  const { rec } = legacyRecord({ mapFile, map, members: [] });
  Object.assign(rec, { key: KEY, gameId: GAME_ID, platformId: 'EUW1', pending: ['history', 'timeline'] });
  const store = new MatchStore(path.join(dir, 'profile'), {});
  await store.create(rec);
  assert.ok(!(await store.get(KEY)).events.some((e) => e.killer), 'a backfilled match knows no killers');

  const client = await lcuMock.startMockLcu({ root: path.join(dir, 'lcu'), phases: [['None', 0]], historyMisses: 0 });
  MOCK_PORTS.add(client.port);
  const logs = [];
  const capture = new MatchCapture({ store, client: lcu.createClient({ installDir: client.installDir, baseUrl: client.url }), installDir: client.installDir, log: (m) => logs.push(m), ...QUICK });
  assert.strictEqual(await capture.sweep(), 1, logs.join('\n'));
  const filled = await store.get(KEY);
  assert.deepStrictEqual(filled.pending, []);
  assert.strictEqual(filled.participants.length, 10);
  assert.ok(filled.participants.every((p) => p.champion), 'every player has a champion');
  const byId = new Map(filled.participants.map((p) => [p.participantId, p]));
  const mine = filled.events.filter((e) => ['kill', 'death', 'assist'].includes(e.type));
  assert.ok(mine.length >= ME.k + ME.d, `your kills and deaths: ${JSON.stringify(filled.events.map((e) => [e.t, e.name, e.type, e.killer, e.victim]))}`);
  for (const e of mine) assert.ok(byId.get(e.killer) && byId.get(e.victim), `killer and victim known at ${e.t}`);
  // You are the history's player (not the backfill's placeholder id 1, which is someone else there).
  assert.deepStrictEqual([filled.me.champion, filled.me.participantId], [ME.champion, ME.pid]);
  assert.strictEqual(filled.participants.filter((p) => p.isMe).length, 1);
  for (const e of mine) {
    if (e.type === 'kill') assert.strictEqual(e.killer, ME.pid, `your kill at ${e.t}`);
    if (e.type === 'death') assert.strictEqual(e.victim, ME.pid, `your death at ${e.t}`);
  }
  assert.deepStrictEqual([mine.filter((e) => e.type === 'kill').length, mine.filter((e) => e.type === 'death').length], [ME.k, ME.d]);

  const view = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'views', 'match.js')).href);
  const entry = { key: KEY, gameStart: 0, gameTime: 58, clips: [], extras: [], files: [], full: null, champion: ME.champion, stats, map: { path: mapFile, markers: map.markers, duration: 80 } };
  const moments = view.matchMoments(entry, filled);
  assert.ok(moments.filter((m) => m.killer && m.victim).length >= ME.k + ME.d, 'the moments name who');
  const html = view.renderWatch(entry, { record: filled, at: 5, width: 800 });
  const faces = (html.match(/class="mp-who"/g) || []).length;
  assert.ok(faces >= 2 * (ME.k + ME.d), `faces in the moments list and the hover cards (${faces})`);
  assert.ok(/class="mp-mk-card/.test(html) && !/class="mp-mk[^"]*"[^>]*title=/.test(html), 'markers show a hover card, not a plain tooltip');
  await client.close();
  await store.flush();
  console.log('legacy fill tests: PASS');
}

// ---------------------------------------------------------------- C1: the backfill

// A library like the real one of 2026-10-17: a minimap, the full recording and 28 highlights of
// one Evelynn match, summary stats without CS or level.
async function backfillTests() {
  const dir = path.join(root, 'backfill');
  fs.mkdirSync(dir, { recursive: true });
  const { lib, video } = fakeLibrary(dir);
  const installDir = path.join(dir, 'League of Legends');
  const LOG_ID = 7612345678;
  lcuMock.writeGameLog(installDir, new Date(2026, 9, 17, 22, 36, 8).getTime(), { gameId: LOG_ID });
  // An older game a few minutes earlier (outside the 2-minute window).
  lcuMock.writeGameLog(installDir, new Date(2026, 9, 17, 22, 31, 0).getTime(), { gameId: LOG_ID - 99 });
  const stats = { champion: 'Evelynn', level: 0, kills: 6, deaths: 8, assists: 7, cs: null, wardScore: 21, result: 'Defeat', gameMode: 'CLASSIC', gameTime: 1695, highlights: 28 };
  const mapFile = video('League of Legends 2026-10-17 22-36-14 Evelynn Map.mp4', {
    type: 'map', game: 'League of Legends', label: 'Defeat · match reel', champion: 'Evelynn', duration: 1722, stats,
    markers: [...Array.from({ length: 28 }, (_, i) => ({ t: 120 + i * 55, label: 'Kill', type: 'kill' })), { t: 1716.2, label: 'Defeat', type: 'defeat' }],
  });
  const fullFile = video('League of Legends 2026-10-17 22-36-12 Evelynn Defeat Match.mp4', {
    type: 'recording', game: 'League of Legends', label: 'Full match', champion: 'Evelynn', duration: 1724, stats, map: { file: mapFile, offset: -1.6 },
  });
  const clips = Array.from({ length: 28 }, (_, i) => video(`League of Legends 2026-10-17 22-${String(38 + Math.floor(i / 2)).padStart(2, '0')}-${String(10 + i).padStart(2, '0')} Kill.mp4`, {
    type: 'highlight', event: 'kill', game: 'League of Legends', label: 'Kill', champion: 'Evelynn', duration: 12,
    map: { file: mapFile, offset: 116 + i * 55 }, markers: [{ t: 4, label: 'Kill', type: 'kill' }],
  }));
  const other = video('Some Game 2026-10-17 20-00-00.mp4', { type: 'clip', game: 'Some Game' });
  const before = Object.fromEntries([mapFile, fullFile, ...clips].map((f) => [f, fs.statSync(f).mtimeMs]));
  const store = new MatchStore(path.join(dir, 'profile'), {});
  const logs = [];
  const res = await migrateLibrary({ library: lib, store, installDir, log: (m) => logs.push(m) });
  const key = `EUW1_${LOG_ID}`;
  assert.deepStrictEqual(res.created, [key], logs.join('\n'));
  const rec = await store.get(key);
  assert.strictEqual(rec.sources.legacy, true);
  assert.deepStrictEqual(rec.pending, ['history', 'timeline']);
  assert.strictEqual(rec.gameId, LOG_ID);
  assert.strictEqual(rec.me.champion, 'Evelynn');
  assert.strictEqual(rec.me.championId, 28);
  assert.deepStrictEqual([rec.me.kills, rec.me.deaths, rec.me.assists], [6, 8, 7]);
  assert.strictEqual(rec.me.cs, null, 'no CS in the old summary');
  assert.strictEqual(rec.me.level, null, 'level 0 means unknown');
  assert.strictEqual(rec.result, 'Lose');
  assert.strictEqual(rec.duration, 1695);
  assert.strictEqual(rec.media.map.gameStart, -21.2, 'anchored on the Defeat marker');
  assert.strictEqual(rec.media.full[0].gameStart, -22.8);
  assert.strictEqual(rec.media.clips.length, 28);
  assert.strictEqual(rec.media.clips[0].from, 94.8);
  assert.strictEqual(rec.media.clips[0].to, 106.8);
  const mapStart = new Date(2026, 9, 17, 22, 36, 14).getTime();
  assert.strictEqual(rec.clock.wallAt0, mapStart + 21200);
  assert.strictEqual(rec.events.length, 29);
  near(rec.events[28].t, 1695, 0.01, 'GameEnd in game time');
  await settle();
  for (const f of [mapFile, fullFile, ...clips]) assert.strictEqual(lib.index[f].match, key, path.basename(f));
  assert.strictEqual(lib.index[other].match, undefined, 'other games untouched');
  for (const [f, mtime] of Object.entries(before)) assert.strictEqual(fs.statSync(f).mtimeMs, mtime, 'videos untouched');
  // Idempotent.
  const again = await migrateLibrary({ library: lib, store, installDir, log: (m) => logs.push(m) });
  assert.deepStrictEqual(again.created, []);
  assert.strictEqual(again.skipped, 1);
  assert.strictEqual((await store.list()).length, 1);
  // Without the game log: a local key, and the game ID pending too.
  const lib2 = fakeLibrary(path.join(dir, 'nolog'));
  lib2.lib.index = JSON.parse(JSON.stringify(lib.index));
  for (const meta of Object.values(lib2.lib.index)) delete meta.match;
  const store2 = new MatchStore(path.join(dir, 'nolog', 'profile'), {});
  const res2 = await migrateLibrary({ library: lib2.lib, store: store2, installDir: path.join(dir, 'nowhere') });
  assert.strictEqual(res2.created.length, 1);
  assert.ok(/^local-\d+$/.test(res2.created[0]), res2.created[0]);
  assert.deepStrictEqual((await store2.get(res2.created[0])).pending, ['gameId', 'history', 'timeline']);
  await store.flush();
  await store2.flush();
  await settle();
  console.log('backfill tests: PASS');
}

// ---------------------------------------------------------------- one match, one record

// File-name time stamp, as ClipVault names its videos ("2026-10-29 19-52-23").
const nameStamp = (ms) => lcuMock.localStamp(ms).replace('T', ' ');

// A League client that answers from fixed documents (no session platform, as on 2026-10-29).
function fakeClient(docs) {
  return {
    get: async (p) => (Object.hasOwn(docs, p) ? JSON.parse(JSON.stringify(docs[p])) : null),
    status: () => 'ok',
    waitForPhase: async () => 'EndOfGame',
  };
}

// The night of 2026-10-29: ClipVault restarted in the middle of a match. Before the fix this left
// three records (the one from before the restart, never ended; the backfill of the minimap the
// restart cut short; the one after) and the last rekey failed with "match EUW1_… already exists".
async function restartTests() {
  const dir = path.join(root, 'restart');
  fs.mkdirSync(dir, { recursive: true });
  const installDir = path.join(dir, 'League of Legends');
  const T0 = Math.floor((Date.now() - 40 * 60000) / 1000) * 1000; // game time 0, 40 minutes ago
  const RESTART = T0 + 24 * 60000;
  lcuMock.writeGameLog(installDir, T0 - 10000, { platformLine: false }); // the game ID, no platform
  const session = lcuMock.makeSession('InProgress');
  delete session.map.platformId;
  const preDocs = { '/lol-gameflow/v1/session': session };
  const postDocs = {
    ...preDocs,
    '/lol-end-of-game/v1/eog-stats-block': lcuMock.makeEogBlock(),
    [`/lol-match-history/v1/games/${GAME_ID}`]: lcuMock.makeHistoryGame({ createdAt: T0 - 16000 }),
    [`/lol-match-history/v1/game-timelines/${GAME_ID}`]: lcuMock.makeTimeline(),
  };
  const me = { gameMode: 'CLASSIC', mapNumber: 11, names: ['Tester'], champion: 'Jinx' };
  const logs = [];
  const log = (m) => logs.push(m);
  const profile = path.join(dir, 'profile');
  const { lib, video } = fakeLibrary(dir);

  // Before the restart: the match starts; its record has the game ID but no platform yet.
  const store1 = new MatchStore(profile, { log });
  lib.useMatches(store1);
  const capture1 = new MatchCapture({ store: store1, client: fakeClient(preDocs), installDir, log, ...QUICK });
  const ctx1 = capture1.start({ ...me, detectedAt: T0, wallAt0: null, live: lcuMock.makeAllGameData({ gameTime: 1 }) });
  await ctx1.ready;
  const firstKey = ctx1.key;
  assert.ok(/^local-/.test(firstKey), firstKey);
  // Highlights and the minimap so far (the restart ends the minimap before it's summed up: no
  // stats, no markers, never linked to the record).
  const map1 = video(`League of Legends ${nameStamp(T0)} Jinx Map.mp4`, { type: 'map', game: 'League of Legends', label: 'Match reel', markers: [], duration: 1417, created: RESTART });
  const early = [200, 450].map((at) => video(`League of Legends ${nameStamp(T0 + at * 1000)} Kill.mp4`, {
    type: 'highlight', event: 'kill', game: 'League of Legends', label: 'Kill', champion: 'Jinx', duration: 20,
    map: { file: map1, offset: at - 14 }, markers: [{ t: 14, label: 'Kill', type: 'kill' }], match: firstKey,
  }));
  await store1.flush();

  // The restart: a new store on the same profile; the start-up repair and backfill, then the
  // watcher finds the match still running.
  const store = new MatchStore(profile, { log });
  lib.useMatches(store);
  const { repairMatches } = require('../src/matches-repair');
  const repaired = await repairMatches(store, { log });
  assert.deepStrictEqual(repaired.merges, [], 'nothing to repair yet');
  const back = await migrateLibrary({ library: lib, store, installDir, log });
  assert.deepStrictEqual(back.created, [], `the backfill makes no second record\n${logs.join('\n')}`);
  assert.deepStrictEqual(back.linked, [firstKey], 'the minimap and its highlights join the open record');
  assert.strictEqual(await store.byFile(map1), firstKey);
  const capture = new MatchCapture({ store, client: fakeClient(postDocs), installDir, log, ...QUICK });
  const ctx2 = capture.start({ ...me, detectedAt: RESTART + 2000, wallAt0: T0 + 365, live: lcuMock.makeAllGameData({ gameTime: 1442 }) });
  await ctx2.ready;
  // (It may have its real key already: the backfill brought the platform guessed for old matches.)
  assert.strictEqual((await store.get(firstKey)).key, ctx2.key, `the record from before the restart is picked back up\n${logs.join('\n')}`);
  assert.strictEqual((await store.list()).length, 1);
  const map2 = video(`League of Legends ${nameStamp(RESTART + 1000)} Jinx Map.mp4`, { type: 'map', game: 'League of Legends', champion: 'Jinx', duration: 460, match: ctx2.key });
  const late = [1500, 1800].map((at) => video(`League of Legends ${nameStamp(T0 + at * 1000)} Kill.mp4`, {
    type: 'highlight', event: 'kill', game: 'League of Legends', label: 'Kill', champion: 'Jinx', duration: 20,
    map: { file: map2, offset: at - 1441 - 14 }, match: ctx2.key,
  }));
  capture.addMedia(ctx2, 'map', { file: map2, startWall: RESTART + 1000 });
  for (const [i, f] of late.entries()) capture.addMedia(ctx2, 'clip', { file: f, startWall: T0 + [1500, 1800][i] * 1000 - 14000, duration: 20, title: 'Kill', type: 'kill', moments: [] });

  // The match ends, then the sweep (as at 20:23:46 that night).
  const rec = await capture.end(ctx2, { ...me, wallAt0: T0 + 365, final: lcuMock.makeAllGameData() });
  await capture.sweep();
  await store.flush();
  await settle();
  assert.ok(rec, logs.join('\n'));
  assert.ok(!logs.some((m) => /already exists/.test(m)), logs.join('\n'));
  const rows = await store.list();
  assert.deepStrictEqual(rows.map((r) => r.key), [KEY], `one match, one record\n${logs.join('\n')}`);
  const one = await store.get(KEY);
  assert.ok(one.aliases.includes(firstKey) && one.aliases.includes(ctx1.key), one.aliases.join(','));
  assert.strictEqual(path.basename(one.media.map.file), path.basename(map2), 'the minimap on the game clock leads');
  assert.deepStrictEqual(one.media.maps.map((m) => path.basename(m.file)), [path.basename(map1)], 'the minimap from before the restart stays');
  assert.deepStrictEqual(one.media.clips.map((c) => path.basename(c.file)).sort(), [...early, ...late].map((f) => path.basename(f)).sort(), 'every highlight');
  assert.strictEqual(new Set(one.media.clips.map((c) => c.id)).size, 4, 'clip ids stay unique');
  assert.ok(one.sources.eog && one.sources.history && one.sources.timeline && one.sources.liveFinal, JSON.stringify(one.sources));
  assert.strictEqual(one.participants.length, 10);
  for (const f of [map1, map2, ...early, ...late]) assert.strictEqual(lib.index[f].match, KEY, `${path.basename(f)} follows the record`);
  assert.deepStrictEqual((await repairMatches(store, { log })).merges, [], 'nothing left to repair');
  console.log('restart mid-match tests: PASS');
}

// The store as that night left it (three records of one match): the start-up repair merges them,
// once, and leaves other matches alone.
async function repairTests() {
  const { repairMatches } = require('../src/matches-repair');
  const dir = path.join(root, 'repair');
  const profile = path.join(dir, 'profile');
  const videos = path.join(dir, 'Videos');
  const f = (name) => path.join(videos, name);
  const T0 = new Date(2026, 9, 29, 19, 52, 24).getTime();
  const store = new MatchStore(profile, {});
  // A record with match history's stats (the game created 16 s before game time 0).
  const full = (r, at0 = T0) => lm.merge(lm.blankRecord(r), [lm.fromLive(lcuMock.makeAllGameData(), 'Tester'), lm.fromHistory(lcuMock.makeHistoryGame({ gameId: r.gameId, createdAt: at0 - 16000 }))]).record;
  // Before the restart: never ended, then filled in by the sweep (no videos).
  await store.create(full({ key: `local-${T0}`, gameId: GAME_ID, platformId: 'EUW1', createdAt: T0, pending: [] }));
  // The backfill of the minimap the restart cut short: 2 highlights without game times.
  const backfill = full({ key: KEY, gameId: GAME_ID, platformId: 'EUW1', prov: { platformId: 'fallback' }, createdAt: T0 + 1420000, pending: [] });
  backfill.media = { full: [], map: { file: f('19-52-23 Jinx Map.mp4'), gameStart: null }, clips: [1, 2].map((id) => ({ id, file: f(`clip-${id}.mp4`), from: null, to: null })) };
  backfill.sources.legacy = true;
  await store.create(backfill);
  // After the restart: everything, and the minimap on the game clock.
  const after = lm.merge(full({ key: `local-${T0 + 365}`, gameId: GAME_ID, platformId: 'EUW1', clock: { wallAt0: T0 + 365 }, createdAt: T0 + 1422000, pending: [] }),
    [lm.fromEog(lcuMock.makeEogBlock())]).record;
  after.media = { full: [], map: { file: f('20-16-05 Jinx Map.mp4'), gameStart: 1421.1 }, clips: [1, 2, 3].map((i) => ({ id: `c${i}`, file: f(`late-${i}.mp4`), from: 1400 + i * 100, to: 1420 + i * 100 })) };
  await store.create(after);
  // Other matches: a finished one an hour earlier, and an open local one of another champion.
  await store.create(full({ key: 'EUW1_7000000000', gameId: 7000000000, platformId: 'EUW1', createdAt: T0 - 3600000, pending: [] }, T0 - 3600000));
  await store.create({ key: `local-${T0 + 600000}`, startedAt: T0 + 600000, me: { championId: 103, champion: 'Ahri' }, pending: ['gameId'] });
  // An open record (no game ID) inside the first match, same champion: the same game.
  await store.create({ key: `local-${T0 + 30000}`, startedAt: T0 + 30000, gameMode: 'CLASSIC', me: { championId: 222, champion: 'Jinx' }, pending: ['gameId'] });

  const logs = [];
  const dry = await repairMatches(store, { dryRun: true, log: (m) => logs.push(m) });
  assert.deepStrictEqual(dry.merges.map((m) => [m.into, m.from.sort()]), [
    [KEY, [`local-${T0 + 365}`, `local-${T0}`].sort()],
    [KEY, [`local-${T0 + 30000}`]],
  ], logs.join('\n'));
  assert.strictEqual((await store.list()).length, 6, 'a dry run changes nothing');
  const res = await repairMatches(store, { log: (m) => logs.push(m) });
  assert.deepStrictEqual(res.merges.map((m) => m.into), [KEY, KEY]);
  const rows = await store.list();
  assert.deepStrictEqual(rows.map((r) => r.key).sort(), [KEY, 'EUW1_7000000000', `local-${T0 + 600000}`].sort(), 'other matches stay');
  const one = await store.get(KEY);
  assert.strictEqual(path.basename(one.media.map.file), '20-16-05 Jinx Map.mp4');
  assert.deepStrictEqual(one.media.maps.map((m) => path.basename(m.file)), ['19-52-23 Jinx Map.mp4']);
  assert.strictEqual(one.media.clips.length, 5);
  assert.strictEqual(new Set(one.media.clips.map((c) => c.id)).size, 5);
  assert.ok(one.sources.eog && one.sources.history, 'the richest stats');
  assert.strictEqual(one.prov.platformId, undefined, 'the platform the client named, not the guess');
  assert.strictEqual(one.clock.wallAt0, T0 + 365);
  assert.strictEqual(one.createdAt, T0, 'the earliest');
  for (const k of [`local-${T0}`, `local-${T0 + 365}`, `local-${T0 + 30000}`]) assert.strictEqual((await store.get(k)).key, KEY, `${k} still resolves`);
  assert.strictEqual(await store.byFile(f('clip-1.mp4')), KEY);
  assert.strictEqual(await store.byFile(f('19-52-23 Jinx Map.mp4')), KEY);
  assert.ok(logs.some((m) => /^merged .* into EUW1_/.test(m)), logs.join('\n'));
  // Idempotent, also after a restart.
  assert.deepStrictEqual((await repairMatches(store)).merges, []);
  await store.flush();
  const reopened = new MatchStore(profile, {});
  assert.deepStrictEqual((await repairMatches(reopened)).merges, []);
  assert.strictEqual((await reopened.list()).length, 3);
  // Unsure: an open record that could be either of two matches stays.
  await reopened.create(full({ key: 'EUW1_7000000005', gameId: 7000000005, platformId: 'EUW1', createdAt: T0, pending: [] }));
  await reopened.create({ key: `local-${T0 + 40000}`, startedAt: T0 + 40000, me: { championId: 222 }, pending: ['gameId'] });
  const unsure = await repairMatches(reopened);
  assert.deepStrictEqual([unsure.merges, unsure.skipped.length], [[], 1]);
  // A rekey onto a key taken by the same game merges; another game's key stays refused.
  await reopened.create({ key: 'local-5', gameId: 7000000000, platformId: 'EUW1', startedAt: 5, media: { clips: [{ file: f('x.mp4'), from: 1, to: 2 }] } });
  const merged = await reopened.rekey('local-5');
  assert.strictEqual(merged.key, 'EUW1_7000000000');
  assert.strictEqual(merged.media.clips.length, 1);
  await reopened.create({ key: 'local-6', gameId: 7000000009, platformId: 'EUW1', startedAt: 6 });
  await assert.rejects(reopened.rekey('local-6', 'EUW1_7000000000'), (err) => err.code === 'EEXIST');
  await reopened.flush();
  console.log('repair tests: PASS');
}

// ---------------------------------------------------------------- run

(async () => {
  try {
    await watcherTests();
    await endToEndTests();
    await noClientTests();
    await backfillTests();
    await legacyFillTests();
    await restartTests();
    await repairTests();
    assert.deepStrictEqual(GUARD_TRIPS, [], 'no unexpected guard trips');
    console.log('match wiring tests: PASS');
  } catch (err) {
    console.error(err);
    console.log('match wiring tests: FAIL');
    process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
