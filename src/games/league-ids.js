// The game ID of a League match from the game's own log, for when the League client wasn't there
// to ask (it was closed, or for matches recorded before ClipVault asked it).
//
// Every game writes <install>\Logs\GameLogs\<local start time>\<same>_r3dlog.txt, e.g. folder
// "2026-10-17T22-36-08". The log has a line with "GameStartData::GameID=<digits>" and one with
// "PlatformID=<id>". Only those two values are taken. The same log also holds the game's command
// line, which carries a session key, so command-line lines are skipped without being parsed and
// nothing else from the log is ever kept or copied.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const fsp = fs.promises;
const WINDOW_MS = 120000; // the game's log folder appears up to ~2 min before the match starts
const MAX_BYTES = 8 * 1024 * 1024; // the IDs come in the first seconds of the log
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/;
const GAME_ID = /GameStartData::GameID=(\d{1,15})(?!\d)/;
const PLATFORM_ID = /(?:^|[^\w-])PlatformID=([A-Z][A-Z0-9]{1,5})(?![\w])/;
const COMMAND_LINE = /command\s*line|\.exe\b|"-\w+=/i;
const HOUR = 3600000;

// The instants a folder name (local time) can stand for. Near a daylight-saving change the same
// name can mean two instants, or none, so the hour either side is tried too.
function folderTimes(name) {
  const m = STAMP.exec(name);
  if (!m) return [];
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return [];
  const t = new Date(y, mo - 1, d, h, mi, s).getTime();
  if (!Number.isFinite(t)) return [];
  const offset = (ms) => new Date(ms).getTimezoneOffset();
  return offset(t - 2 * HOUR) !== offset(t + 2 * HOUR) ? [t, t - HOUR, t + HOUR] : [t];
}

// Reads one log until both IDs are found. Resolves { gameId, platformId } or null.
function readIds(file) {
  return new Promise((resolve) => {
    let gameId = null;
    let platformId = null;
    let done = false;
    const stream = fs.createReadStream(file, { encoding: 'utf8', start: 0, end: MAX_BYTES - 1 });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const finish = () => {
      if (done) return;
      done = true;
      rl.close();
      stream.destroy();
      resolve(gameId ? { gameId, platformId } : null);
    };
    rl.on('line', (text) => {
      if (done || COMMAND_LINE.test(text)) return; // never look into the command line
      const g = !gameId && GAME_ID.exec(text);
      if (g && Number.isSafeInteger(Number(g[1])) && Number(g[1]) > 0) gameId = Number(g[1]);
      const p = !platformId && PLATFORM_ID.exec(text);
      if (p) platformId = p[1];
      if (gameId && platformId) finish();
    });
    rl.on('close', finish);
    stream.on('error', finish);
  });
}

// { gameId, platformId } of the game whose log folder was created 0–120 s before `aroundWallMs`
// (the match start, wall-clock ms), or null. platformId is null when the log names none.
// When several folders fit, the closest one that has a game ID wins.
async function gameIdFromLogs(installDir, aroundWallMs, { windowMs = WINDOW_MS } = {}) {
  if (!installDir || !Number.isFinite(aroundWallMs)) return null;
  const logs = path.join(installDir, 'Logs', 'GameLogs');
  let names;
  try { names = await fsp.readdir(logs); } catch { return null; }
  const fits = [];
  for (const name of names) {
    const leads = folderTimes(name).map((t) => aroundWallMs - t).filter((lead) => lead >= 0 && lead <= windowMs);
    if (leads.length) fits.push({ name, lead: Math.min(...leads) });
  }
  fits.sort((a, b) => a.lead - b.lead);
  for (const { name } of fits) {
    let files = [];
    try { files = (await fsp.readdir(path.join(logs, name))).filter((f) => /_r3dlog\.txt$/i.test(f)).sort(); } catch { /* gone */ }
    for (const f of files) {
      const ids = await readIds(path.join(logs, name, f)).catch(() => null);
      if (ids) return ids;
    }
  }
  return null;
}

module.exports = { gameIdFromLogs, folderTimes, WINDOW_MS };
