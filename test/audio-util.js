// Shared pieces for the audio tests: a tiny tone player compiled on the fly, track decoding and
// burst detection. The tone is about -66 dBFS (amplitude 16 of 32768), inaudible in practice;
// everything is measured numerically.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { paths, run } = require('../src/ffmpeg');

const RATE = 48000;

// tone <delayMs> <bursts> <onMs> <offMs> [amplitude]: after delayMs, plays bursts of a 440 Hz
// tone through the default output device (System.Media.SoundPlayer, so the program renders
// its own audio and process loopback can pick it out).
const TONE_SOURCE = `
using System;
using System.IO;
using System.Media;
using System.Threading;

static class Tone
{
    static int Main(string[] a)
    {
        int delay = int.Parse(a[0]), bursts = int.Parse(a[1]), on = int.Parse(a[2]), off = int.Parse(a[3]);
        int amp = a.Length > 4 ? int.Parse(a[4]) : 16;
        const int Rate = 48000;
        int period = (on + off) * Rate / 1000, onFrames = on * Rate / 1000, frames = bursts * period;
        var ms = new MemoryStream();
        var w = new BinaryWriter(ms);
        w.Write(new[] { 'R', 'I', 'F', 'F' }); w.Write(36 + frames * 4);
        w.Write(new[] { 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ' }); w.Write(16);
        w.Write((short)1); w.Write((short)2); w.Write(Rate); w.Write(Rate * 4); w.Write((short)4); w.Write((short)16);
        w.Write(new[] { 'd', 'a', 't', 'a' }); w.Write(frames * 4);
        for (int i = 0; i < frames; i++)
        {
            int k = i % period;
            short v = k < onFrames ? (short)Math.Round(amp * Math.Sin(2 * Math.PI * 440 * k / Rate)) : (short)0;
            w.Write(v); w.Write(v);
        }
        w.Flush();
        ms.Position = 0;
        Thread.Sleep(delay);
        using (var player = new SoundPlayer(ms)) player.PlaySync();
        return 0;
    }
}
`;

function csc() {
  const windir = process.env.SystemRoot || 'C:\\Windows';
  const found = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find((p) => fs.existsSync(p));
  if (!found) throw new Error('csc.exe (.NET Framework 4) not found');
  return found;
}

// Process loopback finds programs by exe name, so tests that need independent sounds get
// separately named copies of the player.
function buildTone(dir, names) {
  const src = path.join(dir, 'tone.cs');
  fs.writeFileSync(src, TONE_SOURCE);
  const first = path.join(dir, names[0]);
  const r = spawnSync(csc(), ['/nologo', '/optimize+', '/target:exe', `/out:${first}`, src], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`tone player failed to compile: ${r.stdout}${r.stderr}`);
  for (const n of names.slice(1)) fs.copyFileSync(first, path.join(dir, n));
  return names.map((n) => path.join(dir, n));
}

function playTone(exe, { delayMs, bursts, onMs, offMs, amplitude = 16 }) {
  const proc = spawn(exe, [delayMs, bursts, onMs, offMs, amplitude].map(String), { windowsHide: true, stdio: 'ignore' });
  proc.done = new Promise((resolve) => { proc.on('close', resolve); proc.on('error', () => resolve(-1)); });
  return proc;
}

function toFloats(buf) {
  const bytes = new Uint8Array(buf.length - (buf.length % 4)); // own, aligned ArrayBuffer
  bytes.set(buf.subarray(0, bytes.length));
  return new Float32Array(bytes.buffer);
}

// Audio stream `index` of a file as interleaved stereo float samples at 48 kHz.
function decodeAudio(file, index) {
  return new Promise((resolve, reject) => {
    const proc = spawn(paths.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:a:${index}`,
      '-ac', '2', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      else resolve(toFloats(Buffer.concat(chunks)));
    });
  });
}

// Start times (s) of tone bursts in interleaved stereo samples: the first frame louder than
// `threshold` after at least gapMs of quiet.
function burstStarts(samples, { threshold = 8 / 32768, gapMs = 100 } = {}) {
  const gap = Math.round((gapMs * RATE) / 1000);
  const starts = [];
  let quiet = gap;
  for (let i = 0; i < samples.length / 2; i++) {
    if (Math.abs(samples[2 * i]) > threshold) {
      if (quiet >= gap) starts.push(i / RATE);
      quiet = 0;
    } else {
      quiet++;
    }
  }
  return starts;
}

// Amplitude of the `freq` component of the left channel between two times (Goertzel); finds the
// quiet tone even under other sound.
function toneLevel(samples, fromS, toS, freq = 440) {
  const a = Math.max(0, Math.round(fromS * RATE));
  const b = Math.min(samples.length / 2, Math.round(toS * RATE));
  if (b <= a) return 0;
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / RATE);
  let s1 = 0;
  let s2 = 0;
  for (let i = a; i < b; i++) {
    const s0 = samples[2 * i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2))) / (b - a);
}

function peak(samples) {
  let m = 0;
  for (let i = 0; i < samples.length; i++) m = Math.max(m, Math.abs(samples[i]));
  return m;
}

function nonZero(samples) {
  let n = 0;
  for (let i = 0; i < samples.length; i++) if (samples[i] !== 0) n++;
  return n;
}

// The root process of a program (the one whose parent isn't the same exe), found independently
// of cvhelper, to check which process it picked. null when not running.
async function rootPid(exe) {
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='${exe.replace(/'/g, "''")}'" | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`]);
  const procs = r.stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((p) => p.length === 2 && p[0]);
  const pids = new Set(procs.map((p) => p[0]));
  const roots = procs.filter(([pid, parent]) => parent === pid || !pids.has(parent)).map((p) => p[0]);
  return roots.length ? roots : null;
}

module.exports = { RATE, buildTone, playTone, toFloats, decodeAudio, burstStarts, toneLevel, peak, nonZero, rootPid };
