// Tests League key-moment detection against the mock game client (takes about 70 s,
// because the scripted match runs in real time).  Usage: node test/league-test.js
const assert = require('assert');
const { LeagueWatcher, classify, identify, titleFor, describeClip } = require('../src/games/league');
const { startMockLeague } = require('./league-mock');

const OPTIONS = { enabled: true, kills: true, deaths: true, assists: false, objectives: true, structures: false, gameEnd: true, bookmarks: true, before: 4, after: 2, mergeGap: 12 };

function unitTests() {
  // Older clients report legacy summoner names, newer ones Riot IDs; both must match.
  const me = identify({ riotId: 'Faker#KR1', riotIdGameName: 'Faker', summonerName: 'Faker#KR1' },
    [{ riotIdGameName: 'Faker', riotId: 'Faker#KR1', championName: 'Ahri', team: 'ORDER' }]);
  assert.strictEqual(me.champion, 'Ahri');
  assert.strictEqual(classify({ EventName: 'ChampionKill', KillerName: 'Faker', VictimName: 'X' }, me).label, 'Kill');
  assert.strictEqual(classify({ EventName: 'ChampionKill', KillerName: 'Faker#KR1', VictimName: 'X' }, me).label, 'Kill');
  assert.strictEqual(classify({ EventName: 'ChampionKill', KillerName: 'X', VictimName: 'faker' }, me).label, 'Death');
  assert.strictEqual(classify({ EventName: 'ChampionKill', KillerName: 'X', VictimName: 'Y' }, me), null);
  assert.strictEqual(classify({ EventName: 'Multikill', KillerName: 'Faker', KillStreak: 5 }, me).label, 'Penta kill');
  assert.strictEqual(classify({ EventName: 'BaronKill', KillerName: 'X', Assisters: ['Faker'], Stolen: 'True' }, me).label, 'Baron Nashor steal');
  assert.strictEqual(classify({ EventName: 'DragonKill', KillerName: 'Faker', DragonType: 'Elder', Stolen: 'False' }, me).label, 'Elder Dragon');
  assert.strictEqual(classify({ EventName: 'Ace', Acer: 'Faker', AcingTeam: 'ORDER' }, me).label, 'Ace');
  assert.strictEqual(classify({ EventName: 'ChampionKill', KillerName: 'Faker' }, null), null); // spectating
  // event types drive the colours and symbols in the UI
  const type = (e) => classify(e, me).type;
  assert.strictEqual(type({ EventName: 'ChampionKill', KillerName: 'X', VictimName: 'Y', Assisters: ['Faker'] }), 'assist');
  assert.strictEqual(type({ EventName: 'Multikill', KillerName: 'Faker', KillStreak: 3 }), 'multikill');
  assert.strictEqual(type({ EventName: 'DragonKill', KillerName: 'Faker', DragonType: 'Elder', Stolen: 'False' }), 'elder');
  assert.strictEqual(type({ EventName: 'HordeKill', KillerName: 'Faker', Stolen: 'False' }), 'grubs');
  assert.strictEqual(type({ EventName: 'InhibKilled', KillerName: 'Faker', Assisters: [] }), 'inhib');

  const m = (label, kind, score) => ({ label, kind, score });
  assert.strictEqual(titleFor([m('Kill', 'kills', 30), m('Kill', 'kills', 30), m('Triple kill', 'kills', 80), m('Ace', 'kills', 65)]), 'Triple kill');
  assert.strictEqual(titleFor([m('Kill', 'kills', 30), m('Kill', 'kills', 30)]), '2 kills');
  assert.strictEqual(titleFor([m('Double kill', 'kills', 70), m('Baron', 'objectives', 50)]), 'Double kill + Baron');
  assert.strictEqual(titleFor([m('Kill', 'kills', 30), m('First blood', 'kills', 40)]), 'First blood');

  // Teamfights: lots of champions died around the clip, but nobody got a multikill.
  assert.deepStrictEqual(describeClip([m('Kill', 'kills', 30), m('Assist', 'assists', 10)], { teamKills: 5 }), { title: 'Teamfight (5 kills)', type: 'teamfight' });
  assert.strictEqual(titleFor([m('Assist', 'assists', 10), m('Baron', 'objectives', 50)], { teamKills: 4 }), 'Teamfight (4 kills) + Baron');
  assert.strictEqual(titleFor([m('Double kill', 'kills', 70), m('Kill', 'kills', 30)], { teamKills: 6 }), 'Double kill'); // a multikill still wins
  assert.strictEqual(titleFor([m('Kill', 'kills', 30)], { teamKills: 3 }), 'Kill'); // 3 kills isn't a teamfight

  // Bookmarks become moments (and clips) of the running match.
  const highlights = [];
  const w = new LeagueWatcher({ getOptions: () => OPTIONS });
  assert.strictEqual(w.addBookmark(), false, 'no match, no bookmark');
  w.match = { me, moments: [], kills: [], ended: false };
  w.on('highlight', (h) => highlights.push(h));
  assert.strictEqual(w.addBookmark(Date.now()), true);
  w._flush();
  assert.strictEqual(highlights.length, 1);
  assert.strictEqual(highlights[0].title, 'Bookmark');
  assert.strictEqual(highlights[0].type, 'bookmark');
  assert.strictEqual(w.match.moments[0].type, 'bookmark');
  console.log('unit tests: PASS');
}

function runMatch({ port, mockOptions }) {
  const mock = startMockLeague({ port, ...mockOptions });
  const watcher = new LeagueWatcher({ baseUrl: `http://127.0.0.1:${port}/liveclientdata`, getOptions: () => OPTIONS });
  const log = { starts: [], highlights: [], ends: [], t0: Date.now() - (mockOptions.startAt || 0) * 1000 };
  watcher.on('match-start', (e) => log.starts.push(e));
  watcher.on('highlight', (h) => {
    log.highlights.push(h);
    console.log(`  [${port}] highlight "${h.title}" covering game time ${((h.fromMs - log.t0) / 1000).toFixed(1)}–${((h.toMs - log.t0) / 1000).toFixed(1)} s`);
  });
  watcher.on('match-end', (e) => log.ends.push(e));
  watcher.start();
  return mock.closed.then(() => new Promise((r) => setTimeout(r, 6000))).then(() => { watcher.stop(); return log; });
}

(async () => {
  unitTests();
  console.log('playing two scripted matches (about 70 s)...');
  const [full, late] = await Promise.all([
    runMatch({ port: 2997, mockOptions: {} }),
    // ClipVault started 100 s into a match: the earlier kill must not be clipped.
    runMatch({
      port: 2996,
      mockOptions: {
        startAt: 100,
        closeAt: 112,
        script: [
          { EventTime: 50, EventName: 'ChampionKill', KillerName: 'Tester', VictimName: 'Enemy One' },
          { EventTime: 103, EventName: 'ChampionKill', KillerName: 'Tester', VictimName: 'Enemy Two' },
          { EventTime: 104, EventName: 'GameEnd', Result: 'Lose' },
        ],
      },
    }),
  ]);

  assert.strictEqual(full.starts.length, 1, 'one match start');
  assert.strictEqual(full.starts[0].champion, 'Jinx');
  assert.deepStrictEqual(full.highlights.map((h) => h.title), ['Double kill', 'Death', 'Infernal Drake', 'Victory']);
  const first = full.highlights[0];
  const near = (ms, gameSec) => Math.abs((ms - full.t0) / 1000 - gameSec) < 1.5;
  assert.ok(near(first.fromMs, 4 - OPTIONS.before) && near(first.toMs, 6.5 + OPTIONS.after), 'clip window covers the double kill');
  assert.strictEqual(full.ends.length, 1, 'match end announced once');
  assert.strictEqual(full.ends[0].result, 'Win');
  assert.ok(full.ends[0].moments.length >= 6, 'all moments kept for match markers');
  const s = full.ends[0].summary;
  assert.ok(s, 'post-game summary present');
  assert.deepStrictEqual([s.champion, s.kills, s.deaths, s.assists, s.cs, s.level, s.result], ['Jinx', 2, 1, 1, 42, 7, 'Win']);

  assert.strictEqual(late.starts.length, 1);
  assert.ok(late.starts[0].joinedLate);
  assert.strictEqual(late.highlights.length, 1);
  assert.deepStrictEqual(late.highlights[0].moments.map((m) => m.label), ['Kill', 'Defeat']);
  assert.strictEqual(late.highlights[0].title, 'Kill');
  assert.strictEqual(late.ends[0].result, 'Lose');

  console.log('league tests: PASS');
  process.exit(0);
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
