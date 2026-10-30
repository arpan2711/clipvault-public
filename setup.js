// One-time setup: downloads FFmpeg into ./bin and compiles the small Windows helper
// (system audio + microphone capture, foreground game detection) with the C# compiler
// that ships with Windows. Run with: npm run setup
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, 'bin');
const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'clipvault-setup' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects > 5) return reject(new Error('Too many redirects'));
        return resolve(download(new URL(res.headers.location, url).href, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} while downloading ${url}`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      let lastPct = -1;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (!total) return;
        const pct = Math.floor((received * 100) / total);
        if (pct !== lastPct && pct % 5 === 0) {
          process.stdout.write(`\r  ${pct}% of ${(total / 1048576).toFixed(0)} MB`);
          lastPct = pct;
        }
      });
      res.pipe(out);
      out.on('finish', () => { process.stdout.write('\n'); out.close(resolve); });
      out.on('error', reject);
    }).on('error', reject);
  });
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === name) {
      return full;
    }
  }
  return null;
}

function extractZip(zip, dest) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (fs.existsSync(tar) && spawnSync(tar, ['-xf', zip, '-C', dest], { stdio: 'inherit' }).status === 0) return;
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`],
  { stdio: 'inherit' });
  if (ps.status !== 0) throw new Error('Could not extract the FFmpeg archive');
}

async function setupFfmpeg() {
  if (fs.existsSync(path.join(BIN, 'ffmpeg.exe')) && fs.existsSync(path.join(BIN, 'ffprobe.exe'))) {
    console.log('FFmpeg already present in bin/');
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-ffmpeg-'));
  try {
    const zip = path.join(work, 'ffmpeg.zip');
    console.log(`Downloading FFmpeg from ${FFMPEG_URL}`);
    await download(FFMPEG_URL, zip);
    const extracted = path.join(work, 'x');
    fs.mkdirSync(extracted);
    console.log('Extracting...');
    extractZip(zip, extracted);
    for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
      const found = findFile(extracted, exe);
      if (!found) throw new Error(`${exe} not found in the FFmpeg archive`);
      fs.copyFileSync(found, path.join(BIN, exe));
    }
    console.log('FFmpeg installed to bin/');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function setupHelper() {
  const src = path.join(__dirname, 'helper', 'cvhelper.cs');
  const out = path.join(BIN, 'cvhelper.exe');
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) {
    console.log('Helper already compiled');
    return;
  }
  const windir = process.env.SystemRoot || 'C:\\Windows';
  const csc = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find((p) => fs.existsSync(p));
  if (!csc) throw new Error('C# compiler (csc.exe from .NET Framework 4) not found');
  console.log('Compiling helper...');
  const r = spawnSync(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu',
    '/r:System.Windows.Forms.dll', `/out:${out}`, src], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Helper compilation failed');
  console.log('Helper compiled to bin/cvhelper.exe');
}

// Desktop + Start Menu shortcuts that launch Electron with this folder, like an installed app.
function setupShortcuts() {
  let electronExe;
  try { electronExe = require('electron'); } catch { /* not installed yet */ }
  if (typeof electronExe !== 'string' || !fs.existsSync(electronExe)) {
    console.log('Electron not installed yet; skipping shortcuts (run "npm install" first)');
    return;
  }
  const icoPath = path.join(__dirname, 'assets', 'icon.ico');
  fs.mkdirSync(path.dirname(icoPath), { recursive: true });
  fs.writeFileSync(icoPath, require('./src/icon').ico());
  const script = [
    '$shell = New-Object -ComObject WScript.Shell',
    "foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {",
    "  $s = $shell.CreateShortcut((Join-Path $dir 'ClipVault.lnk'))",
    '  $s.TargetPath = $env:CV_TARGET',
    '  $s.Arguments = \'"\' + $env:CV_APP + \'"\'',
    '  $s.WorkingDirectory = $env:CV_APP',
    '  $s.IconLocation = $env:CV_ICON',
    "  $s.Description = 'ClipVault - ad-free game recorder'",
    '  $s.Save()',
    '}',
  ].join('\n');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'inherit',
    env: { ...process.env, CV_TARGET: electronExe, CV_APP: __dirname, CV_ICON: icoPath },
  });
  console.log(r.status === 0 ? 'Created ClipVault shortcuts on the Desktop and in the Start Menu' : 'Could not create shortcuts');
}

(async () => {
  fs.mkdirSync(BIN, { recursive: true });
  setupHelper();
  await setupFfmpeg();
  setupShortcuts();
  console.log('\nSetup complete. Open ClipVault from the Desktop or Start Menu, or run: npm start');
})().catch((err) => {
  console.error(`\nSetup failed: ${err.message}`);
  process.exit(1);
});
