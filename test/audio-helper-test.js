// Tests cvhelper's multi-track mode (audio2) on its own, reading its pipes the way FFmpeg does:
// one after another, with pauses in between. Checks that
//   * every track starts at the same sample: Mixed (the tone plus two silent sources) must equal
//     the Tone track sample for sample,
//   * a program that isn't running, and a push-to-talk mic whose key isn't held, give exact silence,
//   * Discord, when it's running, is captured through its root process,
//   * except:<exe> hears everything but that program, switching over when it starts and stops.
// Plays a ~-66 dBFS tone from a small test program.
// Usage: node test/audio-helper-test.js     (CLIPVAULT_HELPER=<path> tests another cvhelper.exe)
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { paths } = require('../src/ffmpeg');
const { RATE, buildTone, playTone, toFloats, burstStarts, toneLevel, peak, nonZero, rootPid } = require('./audio-util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PTT_KEY = 0x87; // F24: not on normal keyboards, so never held
const dB = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf');

let ok = true;
function check(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) ok = false;
}

function startHelper(args, log) {
  return new Promise((resolve, reject) => {
    const proc = spawn(paths.helper, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.exited = new Promise((r) => proc.on('close', r));
    proc.stdin.on('error', () => {});
    proc.stderr.on('data', (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
    proc.stdout.on('data', (d) => { if (String(d).includes('READY')) resolve(proc); });
    proc.on('error', reject);
    proc.on('close', (code) => reject(new Error(`helper exited (${code}): ${log.join(' | ')}`)));
  });
}

function readPipe(name) {
  const chunks = [];
  const sock = net.connect(`\\\\.\\pipe\\${name}`);
  sock.on('data', (d) => chunks.push(d));
  sock.on('error', () => {});
  return { data: () => toFloats(Buffer.concat(chunks)), close: () => sock.destroy() };
}

// Starts the helper, connects to its pipes `gapMs` apart (as FFmpeg does), runs `during`, then
// closes the helper's stdin and returns every track's samples.
async function session(prefix, specs, outs, gapMs, during) {
  const log = [];
  const helper = await startHelper(['audio2', prefix, ...specs], log);
  try {
    const pipes = {};
    for (const name of outs) {
      pipes[name] = readPipe(`${prefix}-${name}`);
      await sleep(gapMs);
    }
    await during(log);
    helper.stdin.end(); // the helper exits when stdin closes
    const exited = await Promise.race([helper.exited.then(() => true), sleep(4000).then(() => false)]);
    check(exited, 'helper exits when stdin closes');
    await sleep(200);
    const data = {};
    for (const name of outs) {
      pipes[name].close();
      data[name] = pipes[name].data();
    }
    console.log(`  seconds per track: ${outs.map((n) => `${n} ${(data[n].length / 2 / RATE).toFixed(3)}`).join(', ')}`);
    console.log(`  helper log:\n    ${log.join('\n    ')}`);
    return { data, log };
  } finally {
    if (helper.exitCode === null) helper.kill();
  }
}

async function tracksAndSilence(toneExe) {
  console.log('-- tracks, silence, Discord');
  // 6 bursts of 250 ms every 700 ms, starting 1.5 s from now.
  const tone = playTone(toneExe, { delayMs: 1500, bursts: 6, onMs: 250, offMs: 450 });
  const outs = ['mixed', 'tone', 'ghost', 'mic', 'discord', 'all'];
  const { data, log } = await session(`clipvault-test-${process.pid}-a`, [
    '--src', 'tone=process:cvtone.exe:100',
    '--src', 'ghost=process:ClipVaultNoSuchProgram.exe:100',
    '--src', 'mic=mic:100',
    '--src', 'discord=process:Discord.exe:100',
    '--src', 'all=loopback:50',
    '--out', 'mixed=tone,ghost,mic',
    '--out', 'tone=tone', '--out', 'ghost=ghost', '--out', 'mic=mic', '--out', 'discord=discord', '--out', 'all=all',
    '--ptt', `mic:0x${PTT_KEY.toString(16)}:200`,
  ], outs, 300, async () => { await tone.done; await sleep(800); });

  // Pipes connected 1.5 s apart still hold the same span: all start at sample 0 of the shared
  // clock, and late ones are sent the backlog first.
  const secs = outs.map((n) => data[n].length / 2 / RATE);
  const spread = Math.max(...secs) - Math.min(...secs);
  check(Math.min(...secs) > 5 && spread < 0.1, `every track covers the whole session (spread ${(spread * 1000).toFixed(0)} ms)`);
  const n = Math.min(data.mixed.length, data.tone.length);
  let mismatch = -1;
  for (let i = 0; i < n; i++) if (data.mixed[i] !== data.tone[i]) { mismatch = i; break; }
  check(mismatch < 0, mismatch < 0 ? `Mixed equals Tone sample for sample over ${(n / 2 / RATE).toFixed(2)} s`
    : `Mixed differs from Tone at ${(mismatch / 2 / RATE).toFixed(4)} s`);
  const bursts = burstStarts(data.tone);
  const gaps = bursts.slice(1).map((t, i) => Math.round((t - bursts[i]) * 1000));
  check(bursts.length === 6 && peak(data.tone) > 12 / 32768,
    `tone captured from the program alone: ${bursts.length} bursts, peak ${dB(peak(data.tone))} dBFS`);
  // A source's buffer re-primes (30 ms) after a momentary underrun, so a burst may shift by that much.
  check(gaps.length === 5 && gaps.every((g) => Math.abs(g - 700) <= 35), `bursts evenly spaced (no gaps or drops): ${gaps.join(', ')} ms`);
  check(nonZero(data.ghost) === 0, "a program that isn't running gives exact silence");
  check(nonZero(data.mic) === 0, `push-to-talk mic with the key up gives exact silence (mic ${log.some((l) => /^mic capturing/.test(l)) ? 'present' : 'not found'})`);
  check(log.some((l) => /^all capturing/.test(l)), 'loopback source ran alongside');

  const roots = await rootPid('Discord.exe');
  const line = log.find((l) => /^discord capturing Discord\.exe \(pid \d+\)/i.test(l));
  if (roots) {
    const pid = line && Number(/pid (\d+)/.exec(line)[1]);
    check(Boolean(line) && roots.includes(pid), `Discord captured through its root process (picked ${pid}, roots ${roots.join(', ')}; Discord track peak ${dB(peak(data.discord))} dBFS)`);
  } else {
    check(nonZero(data.discord) === 0, "Discord isn't running: its track is silent");
  }
}

async function exceptMode(voiceExe) {
  console.log('-- except:<exe>');
  let voice;
  const { data, log } = await session(`clipvault-test-${process.pid}-b`, [
    '--src', 'plain=loopback:100', '--src', 'except=except:cvvoice.exe:100', '--src', 'voice=process:cvvoice.exe:100',
    '--out', 'plain=plain', '--out', 'except=except', '--out', 'voice=voice',
  ], ['plain', 'except', 'voice'], 100, async () => {
    await sleep(500);
    // Starts after the helper: except must switch from plain loopback to leaving it out.
    voice = playTone(voiceExe, { delayMs: 2500, bursts: 5, onMs: 250, offMs: 450 });
    await voice.done;
    await sleep(2000); // and back to plain loopback once it's gone
  });
  const order = ['except: cvvoice.exe isn\'t running, capturing everything', 'except capturing everything except cvvoice.exe',
    'except: cvvoice.exe (pid', 'except: cvvoice.exe isn\'t running, capturing everything'];
  let at = -1;
  const seen = order.every((s) => (at = log.findIndex((l, i) => i > at && l.startsWith(s))) >= 0);
  check(seen, 'except: plain loopback, then everything but the program while it runs, then plain again');

  // The tone's 440 Hz level inside each burst (from the voice track) against the gaps between.
  const bursts = burstStarts(data.voice);
  const level = (track, off) => bursts.reduce((a, t) => a + toneLevel(track, t + off + 0.03, t + off + 0.22), 0) / bursts.length;
  const ratio = (track) => level(track, 0) / Math.max(1e-9, level(track, 0.35));
  const plainRatio = ratio(data.plain);
  const exceptRatio = ratio(data.except);
  console.log(`  440 Hz in bursts vs gaps: voice ${ratio(data.voice).toFixed(1)}x, plain loopback ${plainRatio.toFixed(1)}x, except ${exceptRatio.toFixed(1)}x`);
  check(bursts.length === 5, `program captured on its own track (${bursts.length} bursts)`);
  if (plainRatio > 3) check(exceptRatio < 1.5, 'except leaves the program out while plain loopback hears it');
  else console.log('  (inconclusive: the tone is drowned out in plain loopback by other sound playing right now)');
}

(async () => {
  console.log(`helper: ${paths.helper}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-audio-'));
  try {
    const [toneExe, voiceExe] = buildTone(work, ['cvtone.exe', 'cvvoice.exe']);
    await tracksAndSilence(toneExe);
    await exceptMode(voiceExe);
  } catch (err) {
    console.error('FAILED:', err.stack || err.message);
    ok = false;
  } finally {
    await sleep(300);
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
