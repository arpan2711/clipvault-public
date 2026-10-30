// Separate audio tracks through the whole engine. Records with every source on its own track,
// saves a replay and a recording, and checks them with ffprobe and by decoding each track:
//   * Mixed, Game, Microphone, Discord in that order, named, only Mixed marked default,
//   * every track equally long, and the same sounds start at the same time on each (< 20 ms),
//   * push-to-talk mic with the key up: exact silence,
//   * a game that isn't running: a silent Game track while the other tracks carry on,
//   * game = everything you hear plus Discord: Discord only on its own track, not doubled.
// Two copies of a quiet (~-66 dBFS) tone player stand in for the game and for Discord.
// Usage: node test/tracks-test.js [outDir]   (KEEP=1 keeps the files, VERBOSE=1 logs FFmpeg and
// the helper, CLIPVAULT_HELPER=<path> tests another cvhelper.exe)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Recorder } = require('../src/recorder');
const { paths, run, detectEncoders } = require('../src/ffmpeg');
const { RATE, buildTone, playTone, decodeAudio, burstStarts, toneLevel, peak, nonZero, rootPid } = require('./audio-util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PTT_KEY = 0x87; // F24: not on normal keyboards, so never held
const dB = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf');

let ok = true;
function check(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) ok = false;
}

async function probe(file) {
  const r = await run(paths.ffprobe, ['-v', 'error', '-show_entries',
    'stream=index,codec_type,codec_name,duration:stream_tags=handler_name,name:stream_disposition=default',
    '-of', 'json', file]);
  return JSON.parse(r.stdout).streams;
}

function newRecorder(log) {
  const rec = new Recorder();
  rec.on('log', (l) => {
    log.push(l);
    if (process.env.VERBOSE) console.log('  log:', l);
  });
  rec.on('warning', (w) => console.log('  warning:', w));
  rec.on('crashed', (m) => console.log('  CRASHED:', m));
  return rec;
}

function baseOptions(out, encoder) {
  return {
    bufferRoot: path.join(out, '.buffer'), replaySeconds: 10, fps: 30, quality: 'medium',
    resolution: 'native', encoder, monitor: 0, drawMouse: true, codec: 'h264',
  };
}

// Track layout, names, default flag and equal lengths. Returns the decoded tracks.
async function checkFile(file, titles) {
  const streams = await probe(file);
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const names = audio.map((s) => (s.tags && (s.tags.handler_name || s.tags.name)) || '');
  check(audio.length === titles.length && names.join() === titles.join(),
    `${path.basename(file)}: audio tracks ${names.map((n) => `"${n}"`).join(', ')}`);
  check(audio.map((s) => s.disposition.default).join() === titles.map((_, i) => (i === 0 ? 1 : 0)).join(),
    `${path.basename(file)}: only the first track is default`);
  const tracks = [];
  for (let i = 0; i < audio.length; i++) tracks.push(await decodeAudio(file, i));
  const frames = tracks.map((t) => t.length / 2);
  const spread = Math.max(...frames) - Math.min(...frames);
  const video = streams.find((s) => s.codec_type === 'video');
  check(spread <= 1024, `${path.basename(file)}: tracks equally long (${frames.map((f) => (f / RATE).toFixed(3)).join(' / ')} s, `
    + `video ${parseFloat(video.duration).toFixed(3)} s)`);
  return tracks;
}

// Every burst on `track` must start at the same moment on `mixed`.
function checkSync(label, track, mixed) {
  const own = burstStarts(track);
  const all = burstStarts(mixed);
  const offsets = own.map((t) => {
    const near = all.reduce((best, m) => (Math.abs(m - t) < Math.abs(best - t) ? m : best), Infinity);
    return Math.round((near - t) * 1000);
  });
  check(own.length >= 5 && offsets.every((d) => Math.abs(d) <= 20),
    `${label}: ${own.length} tone bursts (peak ${dB(peak(track))} dBFS), offset vs Mixed ${offsets.join(', ')} ms`);
}

(async () => {
  const out = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-tracks-')));
  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-tone-'));
  const made = [];
  const players = [];
  let rec;
  try {
    const encoders = await detectEncoders();
    if (!encoders.length) throw new Error('no working encoder');
    console.log(`helper: ${paths.helper}\nencoder: ${encoders[0].id}`);
    const [gameExe, voiceExe] = buildTone(work, ['cvgame.exe', 'cvvoice.exe']);

    // 1. Game, push-to-talk mic and "Discord" on separate tracks. The game's bursts start on
    //    whole seconds, the voice's on half seconds, so Mixed holds both, interleaved.
    console.log('\n-- separate tracks, 4 sources');
    players.push(playTone(gameExe, { delayMs: 4000, bursts: 6, onMs: 200, offMs: 800 }));
    players.push(playTone(voiceExe, { delayMs: 4500, bursts: 6, onMs: 200, offMs: 800 }));
    let log = [];
    rec = newRecorder(log);
    await rec.start({
      ...baseOptions(out, encoders[0].id),
      audio: {
        game: { kind: 'process', exe: 'cvgame.exe', volume: 100 },
        mic: { volume: 100, ptt: { vk: PTT_KEY, releaseMs: 300 } },
        discord: { exe: 'cvvoice.exe', volume: 100 },
        separateTracks: true,
      },
    });
    const titles = ['Mixed', 'Game', 'Microphone', 'Discord'];
    check(JSON.stringify(rec.info.audioTracks) === JSON.stringify(titles), `info.audioTracks ${JSON.stringify(rec.info.audioTracks)}, codec ${rec.info.codec}`);
    rec.startRecording({ game: 'Test' });
    await Promise.all(players.map((p) => p.done));
    await sleep(1500);
    const replay = await rec.saveReplay(8, path.join(out, 'tracks-replay.mp4'));
    made.push(replay.file);
    const recording = await rec.stopRecording(path.join(out, 'tracks-recording.mp4'));
    made.push(recording.file);
    check(JSON.stringify(recording.audioTracks) === JSON.stringify(titles) && recording.codec === 'h264', 'save results report codec and tracks');
    await rec.stop();
    if (process.env.VERBOSE) console.log(log.filter((l) => l.startsWith('[audio]')).join('\n'));

    for (const file of [recording.file, replay.file]) {
      const [mixed, game, mic, discord] = await checkFile(file, titles);
      checkSync(`${path.basename(file)} Game`, game, mixed);
      checkSync(`${path.basename(file)} Discord`, discord, mixed);
      check(nonZero(mic) === 0, `${path.basename(file)}: push-to-talk mic with the key up is exact silence`);
    }

    // 2. A game that isn't running, plus the real Discord (whatever it's playing, if running).
    console.log("\n-- game not running, real Discord");
    log = [];
    rec = newRecorder(log);
    await rec.start({
      ...baseOptions(out, encoders[0].id),
      audio: {
        game: { kind: 'process', exe: 'ClipVaultNoSuchGame.exe', volume: 100 },
        mic: null,
        discord: { exe: 'Discord.exe', volume: 100 },
        separateTracks: true,
      },
    });
    await sleep(6000);
    const idle = await rec.saveReplay(4, path.join(out, 'tracks-idle.mp4'));
    made.push(idle.file);
    await rec.stop();
    const [mixed, game, discord] = await checkFile(idle.file, ['Mixed', 'Game', 'Discord']);
    check(nonZero(game) === 0, 'Game track of a game that isn\'t running is exact silence');
    let same = mixed.length === discord.length;
    for (let i = 0; same && i < mixed.length; i++) same = mixed[i] === discord[i];
    check(same, `Mixed carries Discord unchanged (Discord peak ${dB(peak(discord))} dBFS)`);
    const roots = await rootPid('Discord.exe');
    const line = log.find((l) => /discord capturing Discord\.exe \(pid \d+\)/i.test(l));
    if (roots) check(Boolean(line) && roots.includes(Number(/pid (\d+)/.exec(line)[1])), `Discord captured through its root process (${line ? line.replace('[audio] ', '') : 'no capture logged'})`);
    else check(log.some((l) => /Discord\.exe isn't running/.test(l)), "Discord isn't running: silence");

    // 3. The usual setup: everything you hear as the game, plus "Discord". The Game track must
    //    leave Discord out (so Mixed doesn't get it twice) yet keep the game's sound.
    console.log('\n-- game = everything you hear, plus Discord');
    players.push(playTone(gameExe, { delayMs: 4000, bursts: 6, onMs: 200, offMs: 800 }));
    players.push(playTone(voiceExe, { delayMs: 4500, bursts: 6, onMs: 200, offMs: 800 }));
    log = [];
    rec = newRecorder(log);
    await rec.start({
      ...baseOptions(out, encoders[0].id),
      audio: {
        game: { kind: 'loopback', volume: 100 },
        mic: { volume: 100, ptt: { vk: PTT_KEY, releaseMs: 300 } },
        discord: { exe: 'cvvoice.exe', volume: 100 },
        separateTracks: true,
      },
    });
    rec.startRecording({ game: 'Test' });
    await Promise.all(players.slice(2).map((p) => p.done));
    await sleep(1500);
    const usual = await rec.stopRecording(path.join(out, 'tracks-usual.mp4'));
    made.push(usual.file);
    await rec.stop();
    check(log.some((l) => /game capturing everything except cvvoice\.exe/.test(l)), 'Game track captures everything except Discord');
    {
      const [mixed, game, mic, discord] = await checkFile(usual.file, titles);
      checkSync('Discord', discord, mixed);
      check(nonZero(mic) === 0, 'push-to-talk mic with the key up is exact silence');
      // The tone in Game while Discord's bursts play, against the quiet just after them.
      const voice = burstStarts(discord);
      const during = voice.reduce((a, t) => a + toneLevel(game, t + 0.03, t + 0.17), 0) / voice.length;
      const after = voice.reduce((a, t) => a + toneLevel(game, t + 0.25, t + 0.45), 0) / voice.length;
      const own = burstStarts(game);
      if (after < 1 / 32768) {
        check(during < 3 * after + 1e-6, `Discord left out of the Game track (440 Hz during its bursts ${dB(during)} dBFS, after ${dB(after)} dBFS)`);
        check(own.length === 6, `Game track keeps the game's own sound (${own.length} bursts)`);
        checkSync('Game', game, mixed);
      } else {
        console.log('  (Game track checks inconclusive: other sound is playing on this PC right now)');
      }
    }
  } catch (err) {
    console.error('FAILED:', err.stack || err.message);
    ok = false;
    if (rec) await rec.stop().catch(() => {});
  } finally {
    for (const p of players) if (p.exitCode === null) p.kill();
    await sleep(300);
    fs.rmSync(work, { recursive: true, force: true });
    if (!process.env.KEEP) for (const f of made) fs.rmSync(f, { force: true });
    const leftovers = fs.existsSync(path.join(out, '.buffer')) ? fs.readdirSync(path.join(out, '.buffer')) : [];
    check(leftovers.length === 0, 'buffer cleaned up');
    if (!process.env.KEEP) fs.rmSync(path.join(out, '.buffer'), { recursive: true, force: true });
    if (!process.env.KEEP && !process.argv[2]) fs.rmSync(out, { recursive: true, force: true });
  }
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
