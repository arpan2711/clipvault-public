// Push-to-talk gate in cvhelper, without pressing anything: compiles helper/cvhelper.cs together
// with a small harness that replaces the key lookup, feeds the gate 10 ms blocks of full-scale
// samples while a simulated key goes down at 100 ms and up at 300 ms, and checks the result:
// exact silence while shut, 10 ms fades, open for releaseMs after release, volume applied.
// Usage: node test/ptt-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { toFloats } = require('./audio-util');

const HARNESS = `
using System;
using System.Globalization;
using System.IO;

namespace ClipVault
{
    static class PttGateTest
    {
        // args: releaseMs downMs upMs totalMs gain -> per-frame gain (float32) on stdout
        static int Main(string[] a)
        {
            int releaseMs = int.Parse(a[0]), downMs = int.Parse(a[1]), upMs = int.Parse(a[2]), totalMs = int.Parse(a[3]);
            float gain = float.Parse(a[4], CultureInfo.InvariantCulture);
            const int TickMs = 10, Frames = 48 * TickMs;
            bool held = false;
            CaptureSource.KeyDown = vk => held;
            var s = new CaptureSource("mic", SourceKind.Mic, null, gain);
            s.PttKey = 0x05;
            s.PttReleaseMs = releaseMs;
            var stdout = Console.OpenStandardOutput();
            var bytes = new byte[Frames * 4];
            var outFrame = new float[Frames];
            for (long t = 0; t < totalMs; t += TickMs)
            {
                held = t >= downMs && t < upMs;
                var buf = new float[Frames * 2];
                for (int i = 0; i < buf.Length; i++) buf[i] = 1f;
                bool active = s.ApplyGain(buf, Frames, t);
                for (int i = 0; i < Frames; i++) outFrame[i] = active ? buf[2 * i] : 0f;
                Buffer.BlockCopy(outFrame, 0, bytes, 0, bytes.Length);
                stdout.Write(bytes, 0, bytes.Length);
            }
            stdout.Flush();
            return 0;
        }
    }
}
`;

function csc() {
  const windir = process.env.SystemRoot || 'C:\\Windows';
  return [path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find((p) => fs.existsSync(p));
}

let ok = true;
function check(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) ok = false;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-ptt-'));
try {
  const exe = path.join(work, 'pttgate.exe');
  fs.writeFileSync(path.join(work, 'harness.cs'), HARNESS);
  const c = spawnSync(csc(), ['/nologo', '/target:exe', '/r:System.Windows.Forms.dll', '/main:ClipVault.PttGateTest', `/out:${exe}`,
    path.join(__dirname, '..', 'helper', 'cvhelper.cs'), path.join(work, 'harness.cs')], { encoding: 'utf8', windowsHide: true });
  if (c.status !== 0) throw new Error(`harness failed to compile:\n${c.stdout}${c.stderr}`);
  const gate = (...args) => toFloats(spawnSync(exe, args.map(String), { windowsHide: true, maxBuffer: 1 << 26 }).stdout);
  const ms = (frame) => (frame / 48).toFixed(2);

  // Key down 100-300 ms, release 200 ms, volume 50 %.
  const g = gate(200, 100, 300, 800, 0.5);
  const first = g.findIndex((v) => v !== 0);
  const full = g.findIndex((v) => v === 0.5);
  let lastFull = -1;
  let last = -1;
  for (let i = 0; i < g.length; i++) {
    if (g[i] === 0.5) lastFull = i;
    if (g[i] !== 0) last = i;
  }
  const rampUp = Array.from(g.subarray(first, full + 1));
  const rampDown = Array.from(g.subarray(lastFull, last + 2));
  check(first === 4800, `shut (exact zeros) until the key goes down: first sound at ${ms(first)} ms`);
  check(full - first >= 478 && full - first <= 481 && rampUp.every((v, i) => i === 0 || v > rampUp[i - 1]),
    `fades in over ${ms(full - first)} ms`);
  check(g.subarray(full, lastFull + 1).every((v) => v === 0.5), 'steady at the source volume (50 %) while open');
  // The key is last seen down at the 290 ms poll and up from 300 ms; the gate starts fading at 500 ms.
  check(lastFull === 24000 - 1 || lastFull === 24000, `stays open ${ms(lastFull + 1 - 300 * 48)} ms after the key is released (releaseMs 200)`);
  check(last - lastFull >= 478 && last - lastFull <= 481 && rampDown.every((v, i) => i === 0 || v < rampDown[i - 1]),
    `fades out over ${ms(last - lastFull)} ms`);
  check(g.subarray(last + 1).every((v) => v === 0), 'exact silence again after the fade');

  const never = gate(200, -1, -1, 500, 1);
  check(never.every((v) => v === 0), 'key never pressed: exact silence throughout');
  const tap = gate(0, 100, 110, 400, 1);
  const open = tap.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0);
  check(open > 0 && open <= 3 * 480, `a 10 ms tap with releaseMs 0 opens briefly (${ms(open)} ms incl. fades)`);
} catch (err) {
  console.error('FAILED:', err.message);
  ok = false;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
