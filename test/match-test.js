// The League match data layer, without the real League client: the GET-only LCU client against
// test/lcu-mock.js. Everything runs on temporary folders; nothing touches the real profile.
//   node test/match-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const util = require('util');
const { isInside } = require('../src/fsutil');

// Safety first: this may run while the user is in a League match, with the real League client and
// game up. Nothing here may read the real lockfile or reach the real client or game:
// - ProgramData points at an empty temp folder, so leagueInstallDir() can't find the real install;
// - reading any file called "lockfile" outside this test's temp folder throws;
// - HTTP(S) requests may only go to the mock servers this test started.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-match-'));
process.env.ProgramData = path.join(root, 'ProgramData');
const MOCK_PORTS = new Set();
const GUARD_TRIPS = []; // anything the guards stopped (the client turns some of these into null)
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
  mod.request = function guardedRequest(target, ...rest) {
    const u = target instanceof URL ? target : typeof target === 'string' ? new URL(target) : null;
    const host = u ? u.hostname : target && target.hostname;
    const port = Number(u ? u.port : target && target.port);
    if (host !== '127.0.0.1' || !MOCK_PORTS.has(port)) {
      GUARD_TRIPS.push(`request ${host}:${port}`);
      throw new Error(`test guard: refused a request to ${host}:${port}`);
    }
    return request.call(this, target, ...rest);
  };
}

const lcu = require('../src/games/lcu');
const mock = require('./lcu-mock');

// The mock League client, with its port let through the guard.
async function startMock(options) {
  const m = await mock.startMockLcu(options);
  MOCK_PORTS.add(m.port);
  return m;
}

const { GAME_ID } = mock;
const HISTORY = `/lol-match-history/v1/games/${GAME_ID}`;
const SUMMONER = '/lol-summoner/v1/current-summoner';
const PHASE = '/lol-gameflow/v1/gameflow-phase';

// ---------------------------------------------------------------- the guards themselves

// Safe even if a guard were broken: the path doesn't exist and nothing listens on port 1.
async function guardTests() {
  assert.strictEqual(lcu.leagueInstallDir(), null, 'the real install is out of reach');
  const unset = lcu.createClient();
  assert.strictEqual(await unset.get(PHASE), null);
  assert.strictEqual(unset.status(), 'no-client');
  const outside = path.join(os.tmpdir(), 'clipvault-not-the-test-root', 'lockfile');
  assert.throws(() => fs.readFileSync(outside, 'utf8'), /test guard/);
  await assert.rejects(lcu.createClient({ baseUrl: 'http://127.0.0.1:1', password: 'x' }).get(PHASE), /test guard/);
  assert.deepStrictEqual(GUARD_TRIPS.splice(0), [`read ${outside}`, 'request 127.0.0.1:1']);
  console.log('test guards: PASS');
}

// ---------------------------------------------------------------- LCU client

function lcuStaticTests() {
  // GET only, enforced in code: the module can't even name another method, and has one request site.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'games', 'lcu.js'), 'utf8');
  assert.ok(!/\b(POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/.test(src), 'lcu.js names no method but GET');
  assert.strictEqual((src.match(/method:/g) || []).length, 1, 'a single request site');
  assert.ok(/const METHOD = 'GET';/.test(src) && /method: METHOD,/.test(src));
  assert.strictEqual(lcu.METHOD, 'GET');

  // Only the paths ClipVault uses.
  for (const p of [PHASE, '/lol-gameflow/v1/session', '/lol-end-of-game/v1/eog-stats-block', '/lol-end-of-game/v1/gameclient-eog-stats-block',
    HISTORY, `/lol-match-history/v1/game-timelines/${GAME_ID}`, '/lol-match-history/v1/products/lol/current-summoner/matches',
    '/lol-ranked/v1/current-ranked-stats', '/lol-ranked/v1/current-lp-change-notification', SUMMONER]) {
    assert.ok(lcu.isAllowed(p), p);
  }
  for (const p of ['/lol-login/v1/session', '/lol-chat/v1/me', '/lol-lobby/v2/lobby', '/riotclient/auth-token', '/lol-store/v1/catalog',
    '/lol-match-history/v1/games/123/../../../lol-login/v1/session', '/lol-match-history/v1/games/abc', `${PHASE}?x=1`, `${PHASE}/`,
    '/lol-gameflow/v1/session/dodge', 'https://127.0.0.1:1/lol-gameflow/v1/session', '//evil.example/lol-gameflow/v1/session', '', null]) {
    assert.ok(!lcu.isAllowed(p), String(p));
  }

  // The lockfile, and a password that can't leak through logging.
  const info = lcu.parseLockfile('LeagueClient:1234:50123:s3cr:et-pass:https');
  assert.deepStrictEqual({ ...info }, { name: 'LeagueClient', pid: 1234, port: 50123, protocol: 'https' });
  assert.strictEqual(info.password, 's3cr:et-pass');
  assert.ok(!JSON.stringify(info).includes('s3cr') && !util.inspect(info).includes('s3cr'), 'the password is not enumerable');
  for (const bad of ['', 'LeagueClient:1:2:https', 'LeagueClient:1:99999:pw:https', 'LeagueClient:1:2999::https', 'LeagueClient:1:2999:pw:ftp']) {
    assert.strictEqual(lcu.parseLockfile(bad), null, bad);
  }
  assert.strictEqual(lcu.readLockfile(path.join(root, 'no-league-here')), null);
  assert.strictEqual(lcu.readLockfile(null), null);

  // The install folder comes from the Riot Client's list of installs.
  const programData = path.join(root, 'ProgramData');
  assert.strictEqual(lcu.leagueInstallDir({ programData }), null, 'no Riot Client');
  fs.mkdirSync(path.join(programData, 'Riot Games'), { recursive: true });
  fs.writeFileSync(path.join(programData, 'Riot Games', 'RiotClientInstalls.json'), JSON.stringify({
    associated_client: { 'Z:/Games/VALORANT/live/': 'x', 'Z:/Games/League of Legends/': 'y' }, rc_default: 'z',
  }));
  assert.strictEqual(lcu.leagueInstallDir({ programData }), path.resolve('Z:/Games/League of Legends'));

  // Loopback only.
  for (const baseUrl of ['http://192.0.2.1:2999', 'https://example.com', 'ftp://127.0.0.1:21', 'not a url']) {
    assert.throws(() => lcu.createClient({ baseUrl, password: 'x' }), /loopback|not a URL/, baseUrl);
  }
  assert.doesNotThrow(() => lcu.createClient({ baseUrl: 'https://127.0.0.1:1', password: 'x' }));
  console.log('lcu static tests: PASS');
}

function rawRequest(url, method) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { Authorization: `Basic ${Buffer.from(`riot:${mock.PASSWORD}`).toString('base64')}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

async function lcuMockTests() {
  const phases = [['InProgress', 300], ['WaitingForStats', 300], ['PreEndOfGame', 300], ['EndOfGame', 0]];
  const m = await startMock({ phases, root: path.join(root, 'lcu') });
  try {
    const client = lcu.createClient({ installDir: m.installDir });
    assert.strictEqual(client.status(), 'idle');
    assert.strictEqual(await client.get(PHASE), 'InProgress');
    const session = await client.get('/lol-gameflow/v1/session');
    assert.strictEqual(session.gameData.gameId, GAME_ID);
    assert.strictEqual(session.map.platformId, 'EUW1');

    // 404 is a state ("not there yet"), not an error.
    assert.strictEqual(await client.get('/lol-end-of-game/v1/eog-stats-block'), null);
    assert.strictEqual(client.status(), 'not-found');
    assert.strictEqual(await client.get(`/lol-match-history/v1/games/${GAME_ID + 1}`), null);

    // A path outside the allowlist never reaches the network.
    const before = m.calls.length;
    await assert.rejects(client.get('/lol-login/v1/session'), /not allowed/);
    await assert.rejects(client.get('/lol-gameflow/v1/session/dodge'), /not allowed/);
    assert.strictEqual(m.calls.length, before);

    // The post-game sequence.
    assert.strictEqual(await client.waitForPhase(['Lobby'], { intervalMs: 20, timeoutMs: 120 }), null, 'gives up after the timeout');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    assert.strictEqual(await client.waitForPhase(['Lobby'], { intervalMs: 20, timeoutMs: 5000, signal: ac.signal }), null, 'stops on abort');
    assert.strictEqual(await client.waitForPhase(['PreEndOfGame', 'EndOfGame'], { intervalMs: 50, timeoutMs: 5000 }), 'PreEndOfGame');
    assert.strictEqual(await client.waitForPhase('EndOfGame', { intervalMs: 50, timeoutMs: 5000 }), 'EndOfGame');
    const eog = await client.get('/lol-end-of-game/v1/eog-stats-block');
    assert.strictEqual(eog.gameId, GAME_ID);
    assert.strictEqual((await client.get('/lol-ranked/v1/current-lp-change-notification')).leaguePointsDelta, 21);

    // Match history isn't ready at first (404 twice): backoff until it is.
    const t0 = Date.now();
    const game = await lcu.retry(() => client.get(HISTORY), { delays: [30, 60, 120] });
    assert.strictEqual(game.gameId, GAME_ID);
    assert.strictEqual(m.count(HISTORY), 3, 'two misses, then the game');
    assert.ok(Date.now() - t0 >= 90, 'waited between attempts');
    assert.strictEqual(await lcu.retry(() => null, { delays: [5, 5] }), null, 'gives up after the last delay');
    let tries = 0;
    assert.strictEqual(await lcu.retry(() => { tries++; throw new Error('busy'); }, { delays: [5] }), null);
    assert.strictEqual(tries, 2, 'an error counts as a failed attempt');
    assert.deepStrictEqual(lcu.BACKOFF, [2000, 4000, 8000, 15000, 15000, 15000]);
    const sel = await lcu.retry(() => client.get(SUMMONER), { delays: [5], accept: (s) => s && s.puuid });
    assert.strictEqual(sel.gameName, 'Tester');

    // 401: the password rotated, so the lockfile is read again (once) and the request retried.
    m.rotatePassword('rotated-pass');
    let calls = m.calls.length;
    assert.strictEqual((await client.get(SUMMONER)).puuid, 'test-puuid-00');
    assert.deepStrictEqual(m.calls.slice(calls).map((c) => c.status), [401, 200]);
    // Still refused after re-reading (the lockfile has nothing new): null, and no request loop.
    m.setPasswordOnly('elsewhere');
    calls = m.calls.length;
    assert.strictEqual(await client.get(SUMMONER), null);
    assert.strictEqual(client.status(), 'unauthorized');
    assert.deepStrictEqual(m.calls.slice(calls).map((c) => c.status), [401]);
    m.rotatePassword(mock.PASSWORD);

    // A fixed address and password (the --lcu-api= test flag).
    const fixed = lcu.createClient({ baseUrl: m.url, password: mock.PASSWORD });
    assert.strictEqual(await fixed.get(PHASE), 'EndOfGame');

    // Timeouts throw, and no error ever shows the password.
    m.hang(SUMMONER);
    const quick = lcu.createClient({ installDir: m.installDir, timeoutMs: 150 });
    const err = await quick.get(SUMMONER).then(() => null, (e) => e);
    assert.ok(err && /timed out/.test(err.message), 'timed out');
    assert.ok(!util.inspect(err).includes(mock.PASSWORD) && !util.inspect(quick).includes(mock.PASSWORD));
    assert.ok(!JSON.stringify(lcu.readLockfile(m.installDir)).includes(mock.PASSWORD));

    // The mock itself refuses anything but GET, and the client only ever sent GET.
    assert.strictEqual(await rawRequest(`${m.url}${PHASE}`, 'POST'), 405);
    assert.strictEqual(await rawRequest(`${m.url}/lol-gameflow/v1/session`, 'DELETE'), 405);
    assert.deepStrictEqual(m.rejected.map((r) => r.method), ['POST', 'DELETE']);
    const fromClient = m.calls.filter((c) => !['POST', 'DELETE'].includes(c.method));
    assert.ok(fromClient.length > 10 && fromClient.every((c) => c.method === 'GET'));

    // The client restarted on another port: connection refused, so the lockfile is read again.
    await m.close();
    const m2 = await startMock({ phases: [['Lobby', 0]], root: path.join(root, 'lcu') });
    try {
      assert.notStrictEqual(m2.port, m.port);
      assert.strictEqual(await client.get(PHASE), 'Lobby');
    } finally {
      await m2.close();
    }
    // Closed for good: connection refused is "no client", not an error.
    assert.strictEqual(await client.get(PHASE), null);
    assert.strictEqual(client.status(), 'no-client');
    m.removeLockfile();
    assert.strictEqual(await lcu.createClient({ installDir: m.installDir }).get(PHASE), null, 'no lockfile, no request');
    assert.strictEqual(await lcu.createClient({ installDir: path.join(root, 'nowhere') }).get(PHASE), null);
  } finally {
    await m.close();
  }
  console.log('lcu client tests: PASS');
}

// ---------------------------------------------------------------- game ID from the game's log

async function gameIdTests() {
  const { gameIdFromLogs, folderTimes } = require('../src/games/league-ids');
  const ids = (gameId) => ({ gameId, platformId: 'EUW1' });
  const start = Math.floor((Date.now() - 3600000) / 1000) * 1000; // the match start, whole seconds

  // The closest folder before the start is a launch that never got a game ID; the next one has it.
  const install = path.join(root, 'ids', 'League of Legends');
  mock.writeGameLog(install, start - 20000, { withId: false });
  mock.writeGameLog(install, start - 60000, { gameId: 7000000001 });
  mock.writeGameLog(install, start - 10 * 60000, { gameId: 7000000000 }); // the game before
  mock.writeGameLog(install, start + 5 * 60000, { gameId: 7000000002 }); // the game after
  fs.mkdirSync(path.join(install, 'Logs', 'GameLogs', 'not-a-stamp'));
  fs.mkdirSync(path.join(install, 'Logs', 'GameLogs', '2026-13-45T99-99-99'));
  const found = await gameIdFromLogs(install, start);
  assert.deepStrictEqual(found, ids(7000000001));
  assert.deepStrictEqual(Object.keys(found), ['gameId', 'platformId'], 'only the two values');
  assert.ok(!JSON.stringify(found).includes('FAKE-SESSION-KEY'));
  assert.deepStrictEqual(await gameIdFromLogs(install, start + 5 * 60000 + 30000), ids(7000000002));
  assert.strictEqual(await gameIdFromLogs(install, start - 5 * 60000), null, 'no folder in the 2 minutes before');

  // The window is 0–120 s before the start, inclusive.
  const edge = path.join(root, 'ids-edge');
  mock.writeGameLog(edge, start);
  assert.deepStrictEqual(await gameIdFromLogs(edge, start + 120000), ids(mock.GAME_ID));
  assert.strictEqual(await gameIdFromLogs(edge, start + 121000), null);
  assert.strictEqual(await gameIdFromLogs(edge, start - 1000), null, 'a folder after the start is another game');
  assert.deepStrictEqual(await gameIdFromLogs(edge, start + 1000, { windowMs: 2000 }), ids(mock.GAME_ID));

  // The platform is never taken from the command line.
  const cmd = path.join(root, 'ids-cmdline');
  mock.writeGameLog(cmd, start, { platformLine: false });
  assert.deepStrictEqual(await gameIdFromLogs(cmd, start + 10000), { gameId: mock.GAME_ID, platformId: null });

  assert.strictEqual(await gameIdFromLogs(null, start), null);
  assert.strictEqual(await gameIdFromLogs(path.join(root, 'nowhere'), start), null);
  assert.strictEqual(await gameIdFromLogs(install, NaN), null);

  // Folder names are local time.
  assert.strictEqual(folderTimes('2026-10-17T22-36-08')[0], new Date(2026, 9, 17, 22, 36, 8).getTime());
  assert.deepStrictEqual(folderTimes('2026-10-17 22-36-08'), []);
  // Around a daylight-saving change a name can mean another instant: the hour either side is tried.
  const year = new Date(start).getFullYear();
  const changes = [];
  for (let t = new Date(year, 0, 1).getTime(); t < new Date(year + 1, 0, 1).getTime(); t += 3600000) {
    if (new Date(t).getTimezoneOffset() !== new Date(t + 3600000).getTimezoneOffset()) changes.push(t + 3600000);
  }
  for (const change of changes) {
    const at = change + 30 * 60000; // half an hour after the clocks changed
    const dir = path.join(root, `ids-dst-${at}`);
    mock.writeGameLog(dir, at);
    assert.deepStrictEqual(await gameIdFromLogs(dir, at + 30000), ids(mock.GAME_ID), `DST change at ${new Date(change).toISOString()}`);
  }
  console.log(`game ID tests: PASS${changes.length ? '' : ' (no daylight-saving changes in this time zone)'}`);
}

// ---------------------------------------------------------------- mappers and merge

const lm = require('../src/games/league-match');

const ROW_KEYS = ['v', 'key', 'gameId', 'platformId', 'startedAt', 'duration', 'queueId', 'queueName', 'gameMode', 'mapId',
  'championId', 'champion', 'role', 'level', 'result', 'k', 'd', 'a', 'kda', 'cs', 'csApprox', 'csPerMin', 'damage',
  'damageShare', 'gold', 'goldPerMin', 'vision', 'kp', 'lpDelta', 'items', 'spells', 'keystone', 'subStyle', 'clips', 'hasFull',
  'hasMap', 'favorite', 'pending', 'legacy', 'updatedAt'];
const PLAYER_NAMES = mock.ROSTER.map((p) => p.name);
const meRow = (partial) => partial.participants.find((p) => p.isMe);
const WALL0 = 1792272995600;

// All sources of the mock match, as the post-game collection would gather them.
const allPartials = () => [
  lm.fromLive(mock.makeAllGameData({ gameTime: 30, until: 30 })),
  lm.fromLive(mock.makeAllGameData(), null, { final: true }),
  lm.fromSession(mock.makeSession('InProgress')),
  lm.fromRanked(mock.makeRankedStats(45), { when: 'before' }),
  lm.fromEog(mock.makeEogBlock()),
  lm.fromLp(mock.makeLpNotification()),
  lm.fromHistory(mock.makeHistoryGame()),
  lm.fromTimeline(mock.makeTimeline(), mock.makeHistoryGame()),
];

function fixtureShapeTests() {
  const eog = mock.makeEogBlock();
  for (const t of eog.teams) for (const p of t.players) assert.strictEqual(Object.keys(p.stats).length, 88, 'EOG stats keys');
  assert.ok('WIN' in eog.teams[0].players[0].stats && 'LOSE' in eog.teams[1].players[0].stats);
  const game = mock.makeHistoryGame();
  for (const p of game.participants) assert.strictEqual(Object.keys(p.stats).length, 118, 'history stats keys');
  assert.strictEqual(game.participants.length, 10);
  assert.strictEqual(mock.makeTimeline().frames.length, 2, 'floor(58 / 60) + 2 frames');

  // The champion table (Data Dragon 16.20.1): numeric id -> [alias, name].
  const table = require('../src/games/champion-ids.json');
  assert.strictEqual(table.version, '16.20.1');
  assert.strictEqual(Object.keys(table.champions).length, 173);
  assert.deepStrictEqual(table.champions['62'], ['MonkeyKing', 'Wukong']);
  assert.deepStrictEqual(lm.championInfo(28), { championId: 28, alias: 'Evelynn', champion: 'Evelynn' });
  assert.strictEqual(lm.championInfo(99999), null);
  for (const p of mock.ROSTER) assert.deepStrictEqual(table.champions[p.championId], [p.alias, p.champion], p.alias);
  console.log('fixture shape tests: PASS');
}

function liveTests() {
  const live = lm.fromLive(mock.makeAllGameData(), null, { final: true });
  assert.strictEqual(live.source, 'live-final');
  assert.strictEqual(live.participants.length, 10);
  const me = meRow(live);
  assert.strictEqual(live.participants.filter((p) => p.isMe).length, 1);
  assert.deepStrictEqual([me.name, me.championId, me.alias, me.champion, me.team, me.role], ['Tester', 222, 'Jinx', 'Jinx', 100, 'BOTTOM']);
  assert.deepStrictEqual([me.kills, me.deaths, me.assists, me.cs, me.csApprox, me.vision, me.level], [2, 1, 1, 40, true, 18, 7]);
  assert.deepStrictEqual(me.items, [3031, 3006, 3094, 3036, 0, 0, 3363]);
  assert.deepStrictEqual(me.spells, [4, 7]);
  assert.deepStrictEqual([me.keystone, me.primaryStyle, me.subStyle], [8008, 8000, 8100]);
  assert.deepStrictEqual(me.perks, [8008, 9111, 9104, 8014, 8139, 8135], 'your full runes');
  assert.strictEqual(live.participants[1].perks, undefined, 'only keystone and trees for others');
  assert.deepStrictEqual(live.me.runes.shards, [5005, 5008, 5011]);
  assert.strictEqual(live.me.skinId, 4);
  assert.strictEqual(me.largestMultiKill, 2);
  assert.deepStrictEqual([live.duration, live.gameEndTime, live.result, live.gameMode, live.mapId], [58, 58, 'Win', 'CLASSIC', 11]);
  assert.deepStrictEqual(live.teams.map((t) => [t.teamId, t.win, t.kills, t.dragons]), [[100, true, 3, 1], [200, false, 2, 0]]);

  // Events keep every raw event, refer to players by participant id and never by name.
  assert.strictEqual(live.events.length, mock.LIVE_SCRIPT.length);
  const text = JSON.stringify(live.events);
  for (const name of PLAYER_NAMES) assert.ok(!text.includes(name), `no "${name}" in events`);
  const first = live.events.find((e) => e.name === 'ChampionKill');
  assert.deepStrictEqual([first.t, first.killer, first.victim, first.assisters], [4, 1, 6, [2]]);
  assert.deepStrictEqual(live.events.filter((e) => e.mine).map((e) => e.label),
    ['Kill', 'First blood', 'Kill', 'Double kill', 'Death', 'Assist', 'Infernal Drake', 'Victory']);
  const dragon = live.events.find((e) => e.name === 'DragonKill');
  assert.deepStrictEqual([dragon.dragon, dragon.stolen, dragon.killer, dragon.assisters], ['Fire', false, 2, [1]]);

  // Identity comes from rawChampionName, not the (localized) display name.
  const jp = meRow(lm.fromLive(mock.makeAllGameData({ locale: true })));
  assert.deepStrictEqual([jp.championId, jp.champion, jp.alias], [222, 'Jinx', 'Jinx']);
  const noRaw = mock.makeAllGameData();
  for (const p of noRaw.allPlayers) delete p.rawChampionName;
  assert.strictEqual(meRow(lm.fromLive(noRaw)).championId, 222, 'older clients: the English name still works');
  const jpNoRaw = mock.makeAllGameData({ locale: true });
  for (const p of jpNoRaw.allPlayers) delete p.rawChampionName;
  assert.strictEqual(meRow(lm.fromLive(jpNoRaw)).championId, null, 'a localized name is never guessed at');

  // Streamer mode: events name champions, yet players and your moments are still found.
  const streamer = lm.fromLive(mock.makeAllGameData({ streamer: true }));
  assert.strictEqual(streamer.streamerMode, true);
  assert.deepStrictEqual(streamer.events.find((e) => e.name === 'ChampionKill').killer, 1);
  assert.deepStrictEqual(streamer.events.filter((e) => e.mine).map((e) => e.label), live.events.filter((e) => e.mine).map((e) => e.label));

  // Who "me" is: the watcher's names, a Riot ID, or the active player.
  assert.strictEqual(meRow(lm.fromLive(mock.makeAllGameData(), { names: new Set(['ally one']) })).name, 'Ally One');
  assert.strictEqual(meRow(lm.fromLive(mock.makeAllGameData(), 'Enemy Two#EUW')).name, 'Enemy Two');
  const hidden = mock.makeAllGameData();
  for (const p of hidden.allPlayers) { p.riotId = `${p.championName}#0`; p.riotIdGameName = p.championName; p.summonerName = p.championName; }
  assert.strictEqual(meRow(lm.fromLive(hidden, { names: new Set(['tester']), champion: 'Jinx' })).alias, 'Jinx', 'names hidden: found by champion');

  // Spectating (no active player): no "me", no result.
  const spec = mock.makeAllGameData();
  delete spec.activePlayer;
  const watched = lm.fromLive(spec);
  assert.ok(!watched.participants.some((p) => p.isMe) && watched.result === null && !watched.events.some((e) => e.mine));

  // Mid-game snapshot.
  const mid = lm.fromLive(mock.makeAllGameData({ gameTime: 20.4, until: 20 }));
  assert.deepStrictEqual([mid.source, mid.duration, mid.gameEndTime, mid.result], ['live', 20, null, null]);
  console.log('live mapper tests: PASS');
}

function clientMapperTests() {
  // End-of-game block.
  const eog = lm.fromEog(mock.makeEogBlock({ endedAt: WALL0 + 70000 }));
  const me = meRow(eog);
  assert.deepStrictEqual([me.championId, me.team, me.role, me.level], [222, 100, 'BOTTOM', 9], 'champion level, not the account level');
  assert.deepStrictEqual([me.cs, me.csApprox, me.gold, me.damage, me.vision, me.wardsPlaced, me.controlWards], [43, false, 12000, 21000, 18, 7, 3]);
  assert.deepStrictEqual([me.roleItem, me.spells, me.perks], [3010, [4, 7], [8008, 9111, 9104, 8014, 8139, 8135]]);
  assert.deepStrictEqual([eog.gameId, eog.duration, eog.result, eog.surrender, eog.queueType], [GAME_ID, 58, 'Win', false, 'RANKED_SOLO_5x5']);
  assert.deepStrictEqual([eog.endedAt, eog.startedAt], [WALL0 + 70000, WALL0 + 12000]);
  assert.deepStrictEqual(eog.teams.map((t) => [t.teamId, t.win, t.kills]), [[100, true, 3], [200, false, 2]]);
  assert.ok(eog.teams.every((t) => t.towers === undefined), 'no per-team turret guesses');
  assert.strictEqual(eog.participants.find((p) => p.alias === 'Thresh').shielded, 3000);
  const flagless = mock.makeEogBlock();
  for (const t of flagless.teams) for (const p of t.players) p.isLocalPlayer = false;
  assert.strictEqual(meRow(lm.fromEog(flagless)).alias, 'Jinx', 'found by the local player\'s puuid');
  const remake = mock.makeEogBlock();
  remake.gameEndedInEarlySurrender = true;
  const rm = lm.fromEog(remake);
  assert.deepStrictEqual([rm.result, rm.surrender, rm.teams[0].win], ['Remake', true, null]);
  const variant = lm.fromEog({ gameId: GAME_ID, gameMode: 'CLASSIC', queueId: 420, queueType: 'RANKED_SOLO_5x5', isRanked: true, statsBlock: {} });
  assert.deepStrictEqual([variant.gameId, variant.queueId, variant.participants.length], [GAME_ID, 420, 0]);

  // Match history.
  const hist = lm.fromHistory(mock.makeHistoryGame(), { puuid: 'test-puuid-00' });
  const h = meRow(hist);
  assert.deepStrictEqual([h.participantId, h.championId, h.name, h.cs, h.level, h.gold, h.goldSpent], [4, 222, 'Tester', 43, 9, 12000, 11000]);
  assert.deepStrictEqual([h.multikills, h.items, h.roleItem], [[1, 0, 0, 0], [3031, 3006, 3094, 3036, 0, 0, 3363], 3010]);
  assert.deepStrictEqual([hist.gameId, hist.platformId, hist.queueId, hist.mapId, hist.patch, hist.duration], [GAME_ID, 'EUW1', 420, 11, '16.20', 58]);
  assert.deepStrictEqual([hist.result, hist.surrender, hist.empty], ['Win', false, false]);
  assert.strictEqual(hist.participants.find((p) => p.alias === 'Thresh').role, 'UTILITY', 'BOTTOM + SUPPORT is the support');
  assert.deepStrictEqual(hist.teams.map((t) => [t.teamId, t.win, t.kills, t.dragons, t.bans]), [[100, true, 3, 1, [157]], [200, false, 2, 0, [555]]]);
  assert.strictEqual(meRow(lm.fromHistory(mock.makeHistoryGame(), { participantId: 4 })).alias, 'Jinx');
  const unknownMe = lm.fromHistory(mock.makeHistoryGame());
  assert.ok(!unknownMe.participants.some((p) => p.isMe) && unknownMe.result === null, 'a full game without a hint: merge finds you');
  const list = mock.makeHistoryList().games.games[0];
  assert.strictEqual(meRow(lm.fromHistory(list)).alias, 'Jinx', 'the match list has only your line');
  const notReady = mock.makeHistoryGame();
  for (const p of notReady.participants) { p.stats.champLevel = 0; p.stats.goldEarned = 0; }
  assert.ok(!lm.historyReady(notReady) && lm.fromHistory(notReady).empty && lm.historyReady(mock.makeHistoryGame()));
  assert.strictEqual(lm.fromHistory({ ...mock.makeHistoryGame(), gameDuration: 1695000 }).duration, 1695, 'a duration in ms');

  // Timeline.
  const tl = lm.fromTimeline(mock.makeTimeline(), mock.makeHistoryGame());
  assert.strictEqual(tl.frames.interval, 60);
  assert.deepStrictEqual([tl.frames.cs['4'], tl.frames.totalGold['4'], tl.frames.level['4']], [[0, 43], [500, 1400], [1, 3]]);
  assert.deepStrictEqual(tl.frames.pos['4'][0], [400, 400]);
  assert.strictEqual(tl.timelineEvents.length, 6);
  const kill = tl.timelineEvents[0];
  assert.deepStrictEqual([kill.type, kill.t, kill.killer, kill.victim, kill.assisters, kill.pos], ['CHAMPION_KILL', 4.2, 4, 8, [5], [11800, 2100]]);
  assert.deepStrictEqual(tl.timelineEvents[5].sub, 'FIRE_DRAGON');
  assert.strictEqual(tl.participants.length, 10);

  // LP, rank and the session.
  const lp = lm.fromLp(mock.makeLpNotification());
  assert.deepStrictEqual(lp.rank, { queueType: 'RANKED_SOLO_5x5', after: { tier: 'GOLD', division: 'II', lp: 66 }, lpDelta: 21, source: 'lp-notification' });
  assert.strictEqual(lp.gameId, GAME_ID);
  assert.strictEqual(lm.fromLp({ ...mock.makeLpNotification(), tier: '', leaguePointsDelta: 0 }).rank.lpDelta, null, 'placements: no LP');
  assert.deepStrictEqual(lm.fromRanked(mock.makeRankedStats(45), { when: 'before' }).rank.before, { tier: 'GOLD', division: 'II', lp: 45 });
  assert.deepStrictEqual(lm.fromRanked(mock.makeRankedStats(45), { queueType: 'RANKED_FLEX_SR', when: 'after' }).rank.after, { tier: 'SILVER', division: 'I', lp: 10 });
  const value = (tier, division, lpts) => lm.lpValue({ tier, division, lp: lpts });
  assert.strictEqual(value('GOLD', 'I', 10) - value('GOLD', 'II', 45), 65, 'promoted');
  assert.strictEqual(value('MASTER', null, 10) - value('DIAMOND', 'I', 90), 20, 'into Master');
  assert.strictEqual(value('SILVER', 'I', 80) - value('GOLD', 'IV', 0), -20, 'demoted');
  const session = lm.fromSession(mock.makeSession('InProgress'));
  assert.deepStrictEqual(session, { source: 'session', gameId: GAME_ID, queueId: 420, gameMode: 'CLASSIC', mapId: 11, platformId: 'EUW1' });
  assert.strictEqual(lm.fromSession(mock.makeSession('InProgress', { gameId: 0 })).gameId, null);
  console.log('client mapper tests: PASS');
}

function mergeTests() {
  // Everything at once, as the post-game collection gathers it.
  const base = lm.blankRecord({ clock: { wallAt0: WALL0 }, pending: ['gameId', 'eog', 'history', 'timeline', 'lp'] });
  const res = lm.merge(base, allPartials(), { now: WALL0 + 120000 });
  const r = res.record;
  assert.deepStrictEqual(res.refused, []);
  assert.deepStrictEqual(res.mismatches, []);
  assert.deepStrictEqual(res.applied, ['live', 'live-final', 'session', 'eog', 'history', 'timeline', 'ranked', 'lp']);
  assert.deepStrictEqual([lm.keyOf(r), r.gameId, r.platformId, r.queueId, r.queueName, r.patch], ['EUW1_7000000001', GAME_ID, 'EUW1', 420, 'Ranked Solo/Duo', '16.20']);
  assert.deepStrictEqual([r.duration, r.gameEndTime, r.result, r.surrender, r.statsFrom], [58, 58, 'Win', false, 'history']);
  assert.deepStrictEqual([r.startedAt, r.endedAt], [WALL0, WALL0 + 58000], 'the live clock wins');
  assert.deepStrictEqual(r.pending, [], 'everything arrived');
  assert.ok(r.sources.liveFinal && r.sources.eog && r.sources.history && r.sources.timeline && r.sources.lp);
  const me = r.me;
  assert.deepStrictEqual([me.participantId, me.championId, me.champion, me.role, me.level], [4, 222, 'Jinx', 'BOTTOM', 9]);
  assert.deepStrictEqual([me.cs, me.csApprox, me.gold, me.damage, me.vision, me.shielded], [43, false, 12000, 21000, 18, 0], 'exact CS 43, not the floored 40');
  assert.deepStrictEqual(me.runes, { primary: 8000, sub: 8100, perks: [8008, 9111, 9104, 8014, 8139, 8135], shards: [5005, 5008, 5011] });
  assert.deepStrictEqual([me.items, me.spells, me.roleItem, me.skinId, me.multikills], [[3031, 3006, 3094, 3036, 0, 0, 3363], [4, 7], 3010, 4, [1, 0, 0, 0]]);
  assert.strictEqual(r.participants.length, 10);
  assert.ok(r.participants.every((p) => p.src === 'history'));
  assert.deepStrictEqual(r.participants.map((p) => p.participantId).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(r.participants.every((p) => p.participantId === mock.ROSTER.find((x) => x.alias === p.alias).pid), 'match history\'s ids');
  assert.strictEqual(r.participants.find((p) => p.alias === 'Thresh').shielded, 3000, 'a gap in match history is filled from the end-of-game block');
  // Events: renumbered to match history's ids, with the timeline's positions and clock residual.
  const kills = r.events.filter((e) => e.name === 'ChampionKill');
  assert.deepStrictEqual(kills.map((e) => [e.t, e.killer, e.victim]), [[4, 4, 8], [6.5, 4, 7], [10, 8, 5], [26, 7, 4], [30, 1, 9]]);
  assert.deepStrictEqual(kills[0].assisters, [5]);
  assert.ok(kills.every((e) => Array.isArray(e.pos)), 'every kill got its position');
  assert.deepStrictEqual(r.events.find((e) => e.name === 'DragonKill').pos, [9866, 4414]);
  assert.strictEqual(r.clock.lcuOffset, 0.2);
  assert.strictEqual(r.events.length, mock.LIVE_SCRIPT.length, 'the live feed stays the event list');
  assert.deepStrictEqual(Object.keys(r.frames.cs).sort((a, b) => a - b), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  assert.deepStrictEqual(r.frames.cs['4'], [0, 43]);
  assert.deepStrictEqual(r.rank, { queueType: 'RANKED_SOLO_5x5', before: { tier: 'GOLD', division: 'II', lp: 45 }, after: { tier: 'GOLD', division: 'II', lp: 66 }, lpDelta: 21, source: 'lp-notification' });
  assert.deepStrictEqual(r.teams.map((t) => [t.teamId, t.win, t.kills, t.gold, t.damage, t.dragons, t.towers]), [[100, true, 3, 43000, 72000, 1, 0], [200, false, 2, 45500, 97500, 0, 0]]);
  assert.deepStrictEqual([me.kda, me.kp, me.damageShare], [3, 1, 0.29]);

  // The order things arrive in doesn't matter: one at a time, in any order, gives the same stats.
  const stats = (rec) => JSON.stringify([rec.me, rec.participants.map((p) => ({ ...p, src: undefined })).sort((a, b) => a.participantId - b.participantId),
    rec.teams.map((t) => ({ ...t, src: undefined })), rec.rank, rec.clock, rec.result, rec.duration, rec.gameId, rec.frames,
    rec.events.map((e) => [e.t, e.name, e.killer, e.victim, e.pos, e.label])]);
  for (const order of [[0, 1, 2, 3, 4, 5, 6, 7], [7, 6, 5, 4, 3, 2, 1, 0], [6, 4, 1, 7, 3, 5, 0, 2]]) {
    let rec = lm.blankRecord({ clock: { wallAt0: WALL0 } });
    const parts = allPartials();
    for (const i of order) rec = lm.merge(rec, [parts[i]], { now: WALL0 }).record;
    assert.strictEqual(stats(rec), stats(r), `order ${order}`);
  }
  assert.strictEqual(stats(lm.merge(base, allPartials().reverse(), { now: 0 }).record), stats(r), 'one call, reversed list');

  // Priority: history > eog > live-final > live, per value.
  const withCs = (partial, cs) => { const p = JSON.parse(JSON.stringify(partial)); meRow(p).cs = cs; return p; };
  const live = lm.fromLive(mock.makeAllGameData({ gameTime: 30, until: 30 }));
  const final = lm.fromLive(mock.makeAllGameData(), null, { final: true });
  const eog = lm.fromEog(mock.makeEogBlock());
  const hist = lm.fromHistory(mock.makeHistoryGame(), { participantId: 4 });
  const csAfter = (parts) => lm.merge(lm.blankRecord(), parts).record.me.cs;
  assert.strictEqual(csAfter([withCs(live, 10), withCs(final, 20), withCs(eog, 43), withCs(hist, 44)]), 44);
  assert.strictEqual(csAfter([withCs(hist, 44), withCs(eog, 43), withCs(final, 20), withCs(live, 10)]), 44);
  assert.strictEqual(csAfter([withCs(live, 10), withCs(final, 20), withCs(eog, 43)]), 43);
  assert.strictEqual(csAfter([withCs(final, 20), withCs(live, 10)]), 20, 'the final snapshot beats the last one');
  assert.strictEqual(lm.merge(lm.blankRecord(), [live]).record.me.csApprox, true);
  // Match history's lane guess never replaces the end-of-game role.
  const lane = mock.makeHistoryGame();
  lane.participants.find((p) => p.championId === 86).timeline.lane = 'MIDDLE';
  const roles = lm.merge(lm.blankRecord(), [eog, lm.fromHistory(lane, { participantId: 4 })]).record;
  assert.strictEqual(roles.participants.find((p) => p.alias === 'Garen').role, 'TOP');

  // Refusals: another game's ID, or your champion isn't in it.
  const known = lm.merge(lm.blankRecord(), [final, eog]).record;
  const otherId = lm.fromEog(mock.makeEogBlock({ gameId: GAME_ID + 98 }));
  const refusedId = lm.merge(known, [otherId]);
  assert.deepStrictEqual(refusedId.refused, [{ source: 'eog', reason: 'gameId' }]);
  assert.strictEqual(refusedId.record.me.cs, 43);
  const swapped = mock.makeHistoryGame();
  swapped.participants.find((p) => p.participantId === 4).championId = 117;
  assert.deepStrictEqual(lm.merge(known, [lm.fromHistory(swapped, { participantId: 4 })]).refused, [{ source: 'history', reason: 'champion' }]);
  assert.deepStrictEqual(lm.merge(known, [lm.fromHistory(swapped)]).refused, [{ source: 'history', reason: 'champion' }], 'Jinx is not in that game');
  assert.deepStrictEqual(lm.merge(known, [lm.fromHistory(notReadyGame())]).refused, [{ source: 'history', reason: 'empty' }]);
  // K/D/A disagreements are reported; the better source still wins.
  const kdaOff = mock.makeEogBlock();
  kdaOff.teams[0].players[0].stats.CHAMPIONS_KILLED = 3;
  const reported = lm.merge(lm.merge(lm.blankRecord(), [final]).record, [lm.fromEog(kdaOff)]);
  assert.deepStrictEqual(reported.mismatches, [{ source: 'eog', field: 'kda', ours: [2, 1, 1], theirs: [3, 1, 1] }]);
  assert.strictEqual(reported.record.me.kills, 3);
  // The score read at the start of the match (0/0/0), or when ClipVault restarted mid-match, is
  // the score so far: the final one isn't reported as a disagreement (clipvault.log 2026-10-29).
  const atStart = JSON.parse(JSON.stringify(live));
  Object.assign(meRow(atStart), { kills: 0, deaths: 0, assists: 0 });
  const fromStart = lm.merge(lm.merge(lm.blankRecord(), [atStart]).record, [final]);
  assert.deepStrictEqual(fromStart.mismatches, []);
  assert.deepStrictEqual([fromStart.record.me.kills, fromStart.record.me.deaths, fromStart.record.me.assists], [2, 1, 1]);
  assert.deepStrictEqual(lm.merge(lm.merge(lm.blankRecord(), [atStart]).record, [eog]).mismatches, []);
  const longer = JSON.parse(JSON.stringify(hist));
  longer.duration = 140;
  assert.deepStrictEqual(lm.merge(known, [longer]).mismatches, [{ source: 'history', field: 'duration', ours: 58, theirs: 140 }]);

  // A record from before the match store (only your line): match history repairs it, and the
  // timeline replaces the old kill markers while bookmarks and the result stay.
  const legacy = lm.blankRecord({
    result: 'Win', duration: 58, gameMode: 'CLASSIC', statsFrom: 'legacy', pending: ['history', 'timeline'],
    sources: { legacy: true }, prov: { events: 'legacy' },
    me: { championId: 222, alias: 'Jinx', champion: 'Jinx', kills: 2, deaths: 1, assists: 1, cs: null, level: null },
    events: [{ t: 4.5, name: 'Kill', type: 'kill', label: 'Kill' }, { t: 20, name: 'Bookmark', type: 'bookmark', label: 'Bookmark' },
      { t: 58, name: 'GameEnd', type: 'victory', label: 'Victory' }],
  });
  const fixed = lm.merge(legacy, [lm.fromHistory(mock.makeHistoryGame()), lm.fromTimeline(mock.makeTimeline(), mock.makeHistoryGame())]);
  assert.deepStrictEqual(fixed.refused, []);
  assert.deepStrictEqual(fixed.mismatches, []);
  const lr = fixed.record;
  assert.deepStrictEqual([lr.me.cs, lr.me.level, lr.me.participantId, lr.me.damage, lr.statsFrom], [43, 9, 4, 21000, 'history']);
  assert.deepStrictEqual(lr.pending, []);
  assert.deepStrictEqual(lr.events.map((e) => e.label || e.name),
    ['Kill', 'Kill', 'ChampionKill', 'Bookmark', 'Death', 'Assist', 'Infernal Drake', 'Victory']);
  assert.ok(lr.events.filter((e) => e.src === 'timeline').every((e) => Array.isArray(e.pos)));
  // The same when the timeline comes first: your moments are labelled once you're known.
  const tlFirst = lm.merge(legacy, [lm.fromTimeline(mock.makeTimeline(), mock.makeHistoryGame())]).record;
  const then = lm.merge(tlFirst, [lm.fromHistory(mock.makeHistoryGame())]).record;
  assert.deepStrictEqual(then.events.map((e) => [e.t, e.name, e.label, e.pos]), lr.events.map((e) => [e.t, e.name, e.label, e.pos]));
  const legacyKda = lm.merge(lm.blankRecord({ me: { championId: 222, alias: 'Jinx', kills: 11, deaths: 10, assists: 7 } }), [lm.fromHistory(mock.makeHistoryGame())]);
  assert.deepStrictEqual(legacyKda.mismatches, [{ source: 'history', field: 'kda', ours: [11, 10, 7], theirs: [2, 1, 1] }]);

  // The timeline can come before match history: ids are renumbered once, consistently.
  const early = lm.merge(lm.blankRecord(), [final, lm.fromTimeline(mock.makeTimeline(), mock.makeHistoryGame())]).record;
  assert.strictEqual(early.me.participantId, 4);
  assert.deepStrictEqual(early.events.find((e) => e.name === 'ChampionKill').killer, 4);
  assert.deepStrictEqual(early.frames.cs['4'], [0, 43]);
  assert.strictEqual(early.prov.ids, 'history');
  // LP without the end-of-game notification: the difference of the two rank snapshots.
  const ranked = lm.merge(lm.blankRecord(), [lm.fromRanked(mock.makeRankedStats(45), { when: 'before' }), lm.fromRanked(mock.makeRankedStats(66), { when: 'after' })]).record;
  assert.deepStrictEqual([ranked.rank.lpDelta, ranked.rank.source], [21, 'ranked-stats']);
  const noted = lm.merge(lm.blankRecord(), [lm.fromLp(mock.makeLpNotification()), lm.fromRanked(mock.makeRankedStats(60), { when: 'after' })]).record;
  assert.deepStrictEqual([noted.rank.lpDelta, noted.rank.after.lp, noted.rank.source], [21, 66, 'lp-notification'], 'the notification wins');
  assert.strictEqual(lm.merge(lm.blankRecord(), [lm.fromRanked(mock.makeRankedStats(45), { when: 'before' })]).record.rank.lpDelta, null, 'never invented');
  // The session gives the gameId mid-game, so the key can change.
  const keyed = lm.merge(lm.blankRecord({ clock: { wallAt0: WALL0 }, pending: ['gameId'] }), [live]).record;
  assert.strictEqual(lm.keyOf(keyed), `local-${WALL0}`);
  const rekeyed = lm.merge(keyed, [lm.fromSession(mock.makeSession('InProgress'))]).record;
  assert.deepStrictEqual([lm.keyOf(rekeyed), rekeyed.pending], ['EUW1_7000000001', []]);
  console.log('merge tests: PASS');
}

function notReadyGame() {
  const g = mock.makeHistoryGame();
  for (const p of g.participants) { p.stats.champLevel = 0; p.stats.goldEarned = 0; }
  return g;
}

function deriveTests() {
  const mates = [
    { participantId: 1, team: 100, isMe: true, championId: 28, kills: 5, deaths: 2, assists: 7, cs: 210, gold: 12000, damage: 24000 },
    { participantId: 2, team: 100, championId: 1, kills: 15, deaths: 3, assists: 4, cs: 30, gold: 9000, damage: 56000 },
    { participantId: 6, team: 200, championId: 2, kills: 5, deaths: 20, assists: 1, cs: 100, gold: 8000, damage: 30000 },
  ];
  const r = lm.derive(lm.blankRecord({ duration: 1800, participants: mates, queueId: 440 }));
  assert.deepStrictEqual([r.me.kda, r.me.kp, r.me.csPerMin, r.me.goldPerMin, r.me.damagePerMin, r.me.damageShare], [6, 0.6, 7, 400, 800, 0.3]);
  // Team totals are summed only from more than one player (the match list has just yours).
  assert.deepStrictEqual(r.teams.map((t) => [t.teamId, t.kills, t.damage, t.gold]), [[100, 20, 80000, 21000], [200, null, null, null]]);
  assert.strictEqual(r.queueName, 'Ranked Flex');
  const deathless = lm.derive(lm.blankRecord({ duration: 600, participants: [{ ...mates[0], deaths: 0 }] }));
  assert.strictEqual(deathless.me.kda, 12, 'no deaths: kills + assists');
  assert.strictEqual(deathless.me.kp, null, 'no team total, no kill participation');
  const unknown = lm.derive(lm.blankRecord({ participants: [{ participantId: 1, team: 100, isMe: true, kills: 1 }] }));
  assert.deepStrictEqual([unknown.me.kda, unknown.me.csPerMin, unknown.me.goldPerMin], [null, null, null], 'nothing is invented');

  // The match list row (P1 §2.3).
  const full = lm.merge(lm.blankRecord({ clock: { wallAt0: WALL0 } }), allPartials()).record;
  full.key = lm.keyOf(full);
  full.media.clips.push({ id: 'c1', from: 1, to: 9, file: null });
  full.media.map = { file: 'C:\\clips\\map.mp4', gameStart: -21.2 };
  const row = lm.rowOf(full);
  assert.deepStrictEqual(Object.keys(row), ROW_KEYS);
  assert.deepStrictEqual([row.key, row.k, row.d, row.a, row.cs, row.csApprox, row.damage, row.gold, row.kp, row.lpDelta, row.keystone, row.subStyle],
    ['EUW1_7000000001', 2, 1, 1, 43, false, 21000, 12000, 1, 21, 8008, 8100]);
  assert.deepStrictEqual([row.clips, row.hasFull, row.hasMap, row.legacy], [1, false, true, false]);
  assert.ok(JSON.stringify(row).length < 800, 'a row stays small');
  assert.deepStrictEqual(Object.keys(lm.rowOf(lm.blankRecord())), ROW_KEYS, 'an empty record still has every field');
  assert.deepStrictEqual(lm.rowOf({ ...full, aliases: ['local-1'] }).aliases, ['local-1']);
  assert.strictEqual(lm.keyOf(lm.blankRecord({ clock: { wallAt0: WALL0 } })), `local-${WALL0}`);
  assert.strictEqual(lm.keyOf(lm.blankRecord()), null);
  console.log('derive and row tests: PASS');
}

// ---------------------------------------------------------------- the match store

async function storeTests() {
  const { MatchStore, stripSecrets } = require('../src/matches');
  const profile = path.join(root, 'profile');
  const dir = path.join(profile, 'matches');
  const notes = [];
  const now = () => WALL0 + 6 * 3600000;
  const store = new MatchStore(profile, { log: (m) => notes.push(m), now });
  const changed = [];
  const rekeyed = [];
  store.on('changed', (e) => changed.push(...e.keys));
  store.on('rekeyed', (e) => rekeyed.push(e));
  assert.deepStrictEqual(await store.list(), []);
  assert.ok(!fs.existsSync(dir), 'nothing is written before the first match');

  // A match starts: keyed by its clock until the game ID is known.
  const draft = lm.merge(lm.blankRecord({ clock: { wallAt0: WALL0 }, pending: ['gameId', 'eog', 'history', 'timeline'] }),
    [lm.fromLive(mock.makeAllGameData({ gameTime: 30, until: 30 }))]).record;
  const local = `local-${WALL0}`;
  let rec = await store.create(draft);
  assert.deepStrictEqual([rec.key, rec.v, rec.createdAt, rec.aliases], [local, 1, now(), []]);
  assert.ok(fs.existsSync(path.join(dir, `${local}.json`)));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).map((r) => r.key), [local]);
  await assert.rejects(store.create(draft), (err) => err.code === 'EEXIST');
  await assert.rejects(store.create({ key: '..\\..\\evil' }), /not a match key/);
  await assert.rejects(store.create({}), /not a match key/, 'no key and no clock');

  // Videos are linked as they're saved; clips in game time.
  const videos = path.join(root, 'Videos', 'League of Legends');
  const [full, map, clipA, clipB] = ['Jinx Victory Match', 'Jinx Map', 'Double kill', 'Death'].map((n) => path.join(videos, `${n}.mp4`));
  await store.linkMedia(local, 'map', { file: map, gameStart: -21.2 });
  await store.linkMedia(local, 'clip', { file: clipB, from: 22, to: 30, title: 'Death', type: 'death' });
  rec = await store.linkMedia(local, 'clip', { file: clipA, from: 0, to: 8.5, title: 'Double kill', type: 'multikill' });
  assert.deepStrictEqual(rec.media.clips.map((c) => [c.id, c.title]), [['c2', 'Double kill'], ['c1', 'Death']], 'game-time order, stable ids');
  rec = await store.linkMedia(local, 'clip', { file: clipA, favorite: true });
  assert.deepStrictEqual([rec.media.clips.length, rec.media.clips[0].favorite, rec.media.clips[0].from], [2, true, 0], 'linking again updates');
  rec = await store.linkMedia(local, 'clip', { id: 'v1', file: null, from: 40, to: 48, title: 'Fire dragon' });
  assert.deepStrictEqual(rec.media.clips.map((c) => c.id), ['c2', 'c1', 'v1'], 'a range inside the full recording has no file');
  await assert.rejects(store.linkMedia(local, 'full', { gameStart: 1 }), /needs a file/);
  await assert.rejects(store.linkMedia(local, 'poster', { file: full }), /unknown media kind/);
  assert.strictEqual(await store.linkMedia('local-1', 'map', { file: map }), null, 'no such match');
  assert.strictEqual(await store.byFile(clipA.toUpperCase()), local, 'paths ignore case');
  assert.strictEqual(await store.byFile(path.join(videos, 'other.mp4')), null);

  // One write at a time: 25 updates sent together all land.
  await Promise.all(Array.from({ length: 25 }, () => store.update(local, (r) => { r.note = (r.note || 0) + 1; })));
  assert.strictEqual((await store.get(local)).note, 25);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'atomic writes leave no temp files');
  await assert.rejects(store.update(local, async (r) => r), /synchronous/);
  await assert.rejects(store.update(local, (r) => { r.key = 'EUW1_1'; }), /rekey/);
  assert.strictEqual(await store.update('local-1', { favorite: true }), null);
  rec = await store.update(local, { favorite: true, aliases: ['local-99'], createdAt: 1 });
  assert.deepStrictEqual([rec.favorite, rec.aliases, rec.createdAt], [true, [], now()], 'the store keeps its own fields');

  // Raw documents: everything except the secrets, gzipped.
  const session = mock.makeSession('InProgress');
  await store.saveRaw(local, 'session', session);
  await store.saveRaw(local, 'eog', mock.makeEogBlock());
  assert.deepStrictEqual([...fs.readFileSync(path.join(dir, 'raw', local, 'eog.json.gz')).subarray(0, 2)], [0x1f, 0x8b]);
  const kept = JSON.stringify([await store.readRaw(local, 'session'), await store.readRaw(local, 'eog')]);
  for (const secret of ['FAKE-SPECTATOR-KEY', 'FAKE-GAME-PASSWORD', 'FAKE-CHAT-PASSWORD', '192.0.2.10', '192.0.2.11', mock.FAKE_JWT,
    'fake-chat-room', 'serverPort', 'mucJwtDto', 'multiUserChat', mock.PASSWORD]) {
    assert.ok(!kept.includes(secret), `no ${secret}`);
  }
  assert.strictEqual((await store.readRaw(local, 'session')).gameData.gameId, GAME_ID, 'the rest is kept');
  assert.strictEqual((await store.readRaw(local, 'eog')).teams[0].players[0].stats.MINIONS_KILLED, 40);
  assert.deepStrictEqual(stripSecrets({ a: [{ password: 'x', ok: 1 }, 'eyJa.eyJb.c', 2], b: { authToken: 't', c: { serverIp: '1', d: 'eyJx.eyJy.z' } } }),
    { a: [{ ok: 1 }, null, 2], b: { c: {} } });
  await assert.rejects(store.saveRaw(local, '../x', {}), /raw document name/);
  assert.strictEqual(await store.saveRaw('local-1', 'eog', {}), null);
  assert.strictEqual(await store.readRaw(local, 'timeline'), null);

  // The game ID arrives: local-<ms> becomes EUW1_<gameId>, and the old key keeps working.
  await store.update(local, (r) => lm.merge(r, [lm.fromSession(session)]).record);
  const key = 'EUW1_7000000001';
  rec = await store.rekey(local);
  assert.deepStrictEqual([rec.key, rec.aliases, rec.gameId], [key, [local], GAME_ID]);
  assert.deepStrictEqual(rekeyed, [{ from: local, to: key }]);
  assert.ok(!fs.existsSync(path.join(dir, `${local}.json`)) && fs.existsSync(path.join(dir, `${key}.json`)));
  assert.ok(fs.existsSync(path.join(dir, 'raw', key, 'eog.json.gz')) && !fs.existsSync(path.join(dir, 'raw', local)), 'raw documents moved');
  assert.strictEqual((await store.get(local)).key, key);
  assert.strictEqual(await store.byFile(clipA), key);
  assert.deepStrictEqual((await store.list()).map((r) => [r.key, r.aliases]), [[key, [local]]]);
  assert.strictEqual((await store.update(local, { note: 26 })).key, key, 'an update through the old key lands on the new one');
  await assert.rejects(store.create({ key: local }), (err) => err.code === 'EEXIST', 'a former key stays taken');
  assert.strictEqual((await store.rekey(key)).key, key, 'already right: nothing to do');
  assert.strictEqual(await store.rekey('local-1'), null);
  await assert.rejects(store.rekey(key, 'bad key'), /not a match key/);

  // After the game: the client's stats merged in, nothing pending.
  await store.update(key, (r) => lm.merge(r, allPartials()).record);
  const row = (await store.list())[0];
  assert.deepStrictEqual([row.cs, row.csApprox, row.damage, row.lpDelta, row.clips, row.hasMap, row.hasFull, row.favorite, row.pending],
    [43, false, 21000, 21, 3, true, false, true, []]);
  assert.deepStrictEqual(await store.pending(), []);

  // A later match, still waiting for match history.
  const second = 'EUW1_7000000002';
  await store.create({ key: second, gameId: 7000000002, platformId: 'EUW1', clock: { wallAt0: WALL0 + 3600000 }, pending: ['history'] });
  await assert.rejects(store.rekey(second, key), (err) => err.code === 'EEXIST');
  assert.deepStrictEqual((await store.list()).map((r) => r.key), [second, key], 'newest first');
  assert.deepStrictEqual((await store.pending()).map((r) => r.key), [second]);
  assert.deepStrictEqual(await store.pending({ maxAgeMs: 3600000 }), [], 'older than the cut-off');
  assert.deepStrictEqual((await store.pending({ maxAgeMs: 6 * 3600000 })).map((r) => r.key), [second]);

  // A video belongs to one match: linking it to another moves it.
  await store.linkMedia(second, 'clip', { file: clipB, from: 1, to: 5 });
  assert.strictEqual(await store.byFile(clipB), second);
  assert.deepStrictEqual((await store.get(key)).media.clips.map((c) => c.title), ['Double kill', 'Fire dragon']);

  // Renamed and deleted videos.
  const renamed = path.join(videos, 'Best double kill.mp4');
  assert.strictEqual(await store.renameFile(clipA, renamed), key);
  assert.deepStrictEqual([await store.byFile(clipA), await store.byFile(renamed)], [null, key]);
  assert.strictEqual((await store.get(key)).media.clips[0].file, path.resolve(renamed));
  assert.strictEqual(await store.renameFile(clipA, renamed), null, 'not linked any more');
  await store.linkMedia(key, 'full', { file: full, gameStart: -22.8 });
  assert.strictEqual((await store.list()).find((r) => r.key === key).hasFull, true);
  assert.deepStrictEqual(await store.unlinkFile(full), { key, removed: 1 });
  assert.deepStrictEqual(await store.unlinkFile(map), { key, removed: 1 });
  assert.strictEqual(await store.unlinkFile(map), null, 'already unlinked');
  rec = await store.get(key);
  assert.deepStrictEqual([rec.media.full, rec.media.map, rec.media.clips.length, rec.me.cs], [[], null, 2, 43], 'the record and its stats stay');
  assert.ok(changed.includes(key) && changed.includes(second) && changed.includes(local));
  await store.flush();

  // A restart reads the index and finds every video and former key again.
  const again = new MatchStore(profile, { now });
  assert.deepStrictEqual((await again.list()).map((r) => r.key), [second, key]);
  assert.deepStrictEqual([await again.byFile(renamed), await again.byFile(clipB), (await again.get(local)).key], [key, second, key]);

  // A missing or unreadable index is rebuilt from the match files.
  const indexFile = path.join(dir, 'index.json');
  fs.rmSync(indexFile);
  const rebuilt = new MatchStore(profile, { now, log: (m) => notes.push(m) });
  assert.deepStrictEqual((await rebuilt.list()).map((r) => r.key), [second, key]);
  assert.ok(fs.existsSync(indexFile));
  fs.writeFileSync(indexFile, '[{"key": "EUW1_70000');
  const fromCorrupt = new MatchStore(profile, { now, log: (m) => notes.push(m) });
  assert.deepStrictEqual((await fromCorrupt.list()).map((r) => r.key), [second, key]);
  assert.deepStrictEqual([await fromCorrupt.byFile(renamed), (await fromCorrupt.get(local)).key], [key, key], 'videos and former keys too');
  assert.ok(notes.filter((m) => /rebuilt it from the match files/.test(m)).length === 2);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(indexFile, 'utf8')).map((r) => r.key), [second, key]);
  // An index that missed a match (a crash between the two writes) or lists a gone one is fixed.
  const stale = JSON.parse(fs.readFileSync(indexFile, 'utf8')).filter((r) => r.key !== second);
  stale.push({ ...stale[0], key: 'EUW1_7000000099' });
  fs.writeFileSync(indexFile, JSON.stringify(stale));
  const reconciled = new MatchStore(profile, { now });
  assert.deepStrictEqual((await reconciled.list()).map((r) => r.key), [second, key]);
  await reconciled.flush();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(indexFile, 'utf8')).map((r) => r.key), [second, key]);

  // A rekey stopped after the new record was written: the old copy goes at the next start.
  fs.writeFileSync(path.join(dir, `${local}.json`), JSON.stringify({ ...(await reconciled.get(key)), key: local, aliases: [] }));
  const recovered = new MatchStore(profile, { now, log: (m) => notes.push(m) });
  assert.deepStrictEqual((await recovered.list()).map((r) => r.key), [second, key]);
  assert.ok(!fs.existsSync(path.join(dir, `${local}.json`)) && notes.some((m) => /already renamed/.test(m)));

  // An unreadable record is kept aside (never overwritten) and leaves the list.
  fs.writeFileSync(path.join(dir, `${second}.json`), '{"broken');
  const careful = new MatchStore(profile, { now, log: (m) => notes.push(m) });
  assert.strictEqual(await careful.get(second), null);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.startsWith(`${second}.json.corrupt-`)).length, 1);
  assert.deepStrictEqual((await careful.list()).map((r) => r.key), [key]);
  assert.strictEqual(await careful.byFile(clipB), null);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  console.log('match store tests: PASS');
}

(async () => {
  try {
    await guardTests();
    lcuStaticTests();
    await lcuMockTests();
    await gameIdTests();
    fixtureShapeTests();
    liveTests();
    clientMapperTests();
    mergeTests();
    deriveTests();
    await storeTests();
    assert.deepStrictEqual(GUARD_TRIPS, [], 'nothing tried to reach the real League client or its lockfile');
    console.log('match tests: PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('FAIL:', err.stack || err.message);
  process.exit(1);
});
