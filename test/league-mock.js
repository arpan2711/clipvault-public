// Fake League of Legends game client for testing auto clips without playing: serves the
// Live Client Data endpoints (plain HTTP) and plays back a scripted match in real time.
//
//   node test/league-mock.js [port]        then start ClipVault with
//   npm start -- --league-api=http://127.0.0.1:2998/liveclientdata
const http = require('http');

const PLAYERS = [
  { riotId: 'Tester#EUW', riotIdGameName: 'Tester', riotIdTagLine: 'EUW', summonerName: 'Tester#EUW', championName: 'Jinx', team: 'ORDER',
    level: 7, scores: { kills: 2, deaths: 1, assists: 1, creepScore: 42, wardScore: 3.6 } },
  { riotId: 'Ally One#EUW', riotIdGameName: 'Ally One', riotIdTagLine: 'EUW', summonerName: 'Ally One#EUW', championName: 'Thresh', team: 'ORDER' },
  { riotId: 'Enemy One#EUW', riotIdGameName: 'Enemy One', riotIdTagLine: 'EUW', summonerName: 'Enemy One#EUW', championName: 'Ahri', team: 'CHAOS' },
  { riotId: 'Enemy Two#EUW', riotIdGameName: 'Enemy Two', riotIdTagLine: 'EUW', summonerName: 'Enemy Two#EUW', championName: 'Zed', team: 'CHAOS' },
];

// Game-time seconds. Expected highlights for "Tester": Double kill, Death, Infernal dragon, Victory.
const DEFAULT_SCRIPT = [
  { EventTime: 4, EventName: 'ChampionKill', KillerName: 'Tester', VictimName: 'Enemy One', Assisters: ['Ally One'] },
  { EventTime: 4, EventName: 'FirstBlood', Recipient: 'Tester' },
  { EventTime: 6.5, EventName: 'ChampionKill', KillerName: 'Tester', VictimName: 'Enemy Two', Assisters: [] },
  { EventTime: 6.5, EventName: 'Multikill', KillerName: 'Tester', KillStreak: 2 },
  { EventTime: 10, EventName: 'ChampionKill', KillerName: 'Enemy One', VictimName: 'Ally One', Assisters: [] },
  { EventTime: 26, EventName: 'ChampionKill', KillerName: 'Enemy Two', VictimName: 'Tester', Assisters: ['Enemy One'] },
  { EventTime: 40, EventName: 'DragonKill', KillerName: 'Ally One', Assisters: ['Tester'], DragonType: 'Infernal', Stolen: 'False' },
  { EventTime: 58, EventName: 'GameEnd', Result: 'Win' },
];

// players: the scoreboard (default PLAYERS; the first one is you), e.g. lcu-mock's ten players.
// allgamedata answers too (all the above in one document), like the real API.
function startMockLeague({ port = 2998, script = DEFAULT_SCRIPT, startAt = 0, closeAt = 66, log = false, players = PLAYERS } = {}) {
  const t0 = Date.now() - startAt * 1000;
  const gameTime = () => (Date.now() - t0) / 1000;
  const me = players[0];
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const t = gameTime();
    const path = new URL(req.url, 'http://localhost').pathname.replace(/^\/liveclientdata\//, '');
    const events = [{ EventName: 'GameStart', EventTime: 0 }, ...script.filter((e) => e.EventTime <= t)]
      .map((e, i) => ({ EventID: i, ...e }));
    const routes = {
      gamestats: () => ({ gameMode: 'CLASSIC', gameTime: t, mapName: 'Map11', mapNumber: 11, mapTerrain: 'Default' }),
      activeplayer: () => ({ riotId: me.riotId, riotIdGameName: me.riotIdGameName, riotIdTagLine: me.riotIdTagLine, summonerName: me.summonerName, level: 1, currentGold: 500 }),
      activeplayername: () => me.riotId,
      playerlist: () => players,
      eventdata: () => ({ Events: events }),
      allgamedata: () => ({ activePlayer: routes.activeplayer(), allPlayers: players, events: { Events: events }, gameData: routes.gamestats() }),
    };
    const route = routes[path];
    res.writeHead(route ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(route ? route() : { errorCode: 'RESOURCE_NOT_FOUND' }));
    if (log && path === 'eventdata') process.stdout.write(`\r[mock] game time ${t.toFixed(0)} s, ${events.length} events   `);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.listen(port, '127.0.0.1');

  // Closing the game client takes the API down, like the real thing.
  const close = () => new Promise((resolve) => {
    clearTimeout(closeTimer);
    server.close(() => resolve());
    for (const s of sockets) s.destroy();
  });
  const closeTimer = closeAt ? setTimeout(close, Math.max(0, (closeAt - startAt) * 1000)) : null;
  return { server, close, gameTime, t0, closed: new Promise((r) => server.on('close', r)) };
}

module.exports = { startMockLeague, DEFAULT_SCRIPT, PLAYERS };

if (require.main === module) {
  // node test/league-mock.js [port] [delaySeconds]  (delay pushes every scripted event later)
  const port = Number(process.argv[2]) || 2998;
  const delay = Number(process.argv[3]) || 0;
  const script = DEFAULT_SCRIPT.map((e) => ({ ...e, EventTime: e.EventTime + delay }));
  const mock = startMockLeague({ port, script, closeAt: 66 + delay, log: true });
  console.log(`[mock] League Live Client Data API on http://127.0.0.1:${port}/liveclientdata`);
  mock.closed.then(() => { console.log('\n[mock] match over, API closed'); process.exit(0); });
}
