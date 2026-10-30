// Builds a synthetic ClipVault test profile in the temp folder: tiny test-pattern videos laid out
// like a real League match (minimap, full recording, highlights with markers and stats) plus two
// loose clips, and the matching library.json. No real clips or profile data are used.
//   node test/ui/make-profile.js [name] [--record]   -> prints the profile path (%TEMP%\clipvault-ui\<name>)
// --record also writes a match record for the match (all ten players with items, spells and runes,
// from test/lcu-mock.js, with you as Evelynn), so the match page's header and scoreboard have stats.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const FFMPEG = path.join(REPO, 'bin', 'ffmpeg.exe');
const name = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'library';
const withRecord = process.argv.includes('--record');
const profile = path.join(os.tmpdir(), 'clipvault-ui', name);
const videos = path.join(profile, 'Videos');
const league = path.join(videos, 'League of Legends');

function video(file, seconds, size = '320x180') {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=10:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${file}: ${r.stderr}`);
}

fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(league, { recursive: true });
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ saveDir: videos, bufferMode: 'off', startWithWindows: false }, null, 2));

const t0 = Date.UTC(2026, 9, 17, 21, 36, 14); // match start
const at = (s) => t0 + s * 1000;
const file = (label) => path.join(league, `League of Legends 2026-10-17 ${label}.mp4`);
const mapFile = file('22-36-14 Evelynn Map');
const fullFile = file('23-04-55 Evelynn Defeat Match');
const moments = [
  [68.4, 'Assist', 'assist'], [231.2, 'Death', 'death'], [453.5, 'Kill', 'kill'], [756.6, 'Earth dragon', 'dragon'],
  [999.8, 'Rift Herald', 'herald'], [1127.8, 'Double kill', 'multikill'], [1425.4, 'Death', 'death'], [1716.4, 'Defeat', 'defeat'],
];
const stats = { champion: 'Evelynn', kills: 11, deaths: 10, assists: 7, cs: null, level: 0, result: 'Defeat', gameMode: 'CLASSIC', gameTime: 1695, highlights: moments.length - 1 };
const index = {};
const add = (f, seconds, meta) => { video(f, seconds); index[f] = meta; };

add(mapFile, 3, { type: 'map', game: 'League of Legends', label: 'Defeat · match reel', champion: 'Evelynn', created: at(1746),
  markers: moments.map(([t, label, type]) => ({ t, label, type })), stats });
add(fullFile, 3, { type: 'recording', game: 'League of Legends', label: 'Full match', champion: 'Evelynn', created: at(1745),
  markers: moments.map(([t, label, type]) => ({ t: t + 1.6, label, type })), map: { file: mapFile, offset: -1.6 }, stats });
moments.forEach(([t, label, type], i) => {
  const stamp = new Date(at(t + 5)).toISOString().slice(11, 19).replace(/:/g, '-');
  add(file(`${stamp} ${label}`), 2, { type: 'highlight', game: 'League of Legends', label, champion: 'Evelynn', created: at(t + 5) + i,
    markers: [{ t: 1.5, label, type }], map: { file: mapFile, offset: t - 15 } });
});
// Loose clips: an instant replay in League outside the match, and one from another game.
add(path.join(league, 'League of Legends 2026-10-16 20-11-02.mp4'), 2, { type: 'clip', game: 'League of Legends', created: Date.UTC(2026, 9, 16, 19, 11, 2) });
fs.mkdirSync(path.join(videos, 'Sekiro'), { recursive: true });
add(path.join(videos, 'Sekiro', 'Sekiro 2026-10-15 22-40-10.mp4'), 2, { type: 'clip', game: 'Sekiro', created: Date.UTC(2026, 9, 15, 21, 40, 10) });

async function writeRecord() {
  const lm = require('../../src/games/league-match');
  const mock = require('../lcu-mock');
  const { MatchStore } = require('../../src/matches');
  const { record } = lm.merge(lm.blankRecord({ clock: { wallAt0: t0 } }), [
    lm.fromEog(mock.makeEogBlock({ duration: 1695, endedAt: at(1695) })),
    lm.fromHistory(mock.makeHistoryGame({ duration: 1695, createdAt: t0 }), { puuid: 'test-puuid-00' }),
  ], { now: at(1800) });
  const me = record.participants.find((p) => p.isMe);
  Object.assign(me, { championId: 28, champion: 'Evelynn', alias: 'Evelynn' });
  record.key = lm.keyOf(record);
  const store = new MatchStore(profile);
  await store.create(record);
  // Linked videos, so the app's one-time backfill sees the match as done.
  await store.linkMedia(record.key, 'map', { file: mapFile, gameStart: 0 });
  await store.linkMedia(record.key, 'full', { file: fullFile, gameStart: 1.6 });
  await store.flush();
  for (const meta of Object.values(index)) if (meta.game === 'League of Legends' && meta.type !== 'clip') meta.match = record.key;
}

(async () => {
  if (withRecord) await writeRecord();
  fs.writeFileSync(path.join(profile, 'library.json'), JSON.stringify(index));
  console.log(profile);
})().catch((err) => { console.error(err); process.exit(1); });
