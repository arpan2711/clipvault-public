// ClipVault main process: owns the capture engine, tray icon, global hotkeys, on-screen
// notifications and the clip library, and serves the UI over IPC.
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, dialog, screen, nativeImage, nativeTheme, powerMonitor, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { Settings, DEFAULT_HOTKEYS } = require('./settings');
const { Recorder } = require('./recorder');
const { Library } = require('./library');
const { ForegroundWatcher, sanitizeName, gameSoundExe } = require('./foreground');
const { paths, run, detectEncoders, ffmpegAvailable } = require('./ffmpeg');
const { LeagueWatcher, MAX_SPAN_MS } = require('./games/league');
const { startMatchLog, adoptLastLog } = require('./games/league-logs');
const { InputTracker, HotkeyMatcher, makeHotkeyGate, vkFor } = require('./inputs');
const { MinimapRecorder, measureSyncError } = require('./games/minimap');
const { createClient, leagueInstallDir } = require('./games/lcu');
const { MatchStore } = require('./matches');
const { MatchCapture } = require('./match-capture');
const { migrateLibrary } = require('./matches-migrate');
const { repairMatches } = require('./matches-repair');
const edit = require('./edit');
const { VirtualClips } = require('./virtual');
const { KillCam, killCamPlacement, killCamSpotFor, keysBand, CAM_KINDS } = require('./killcam');
const { championIcon } = require('./champions');
const { GameIcons } = require('./game-icons');
const icon = require('./icon');
const { fetchBuffer } = require('./net');
const { UpdateChecker, safeReleaseUrl } = require('./update');
const bugReport = require('./bugreport');

const LEAGUE = 'League of Legends';
const GB = 1024 ** 3; // the storage limit uses the same gigabytes as Explorer

function flag(name) {
  const arg = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!arg) return null;
  const i = arg.indexOf('=');
  return i < 0 ? true : arg.slice(i + 1);
}

// --data-dir=<dir> runs with an isolated profile (settings + videos), used for testing.
const dataDir = typeof flag('data-dir') === 'string' ? path.resolve(flag('data-dir')) : null;
if (dataDir) app.setPath('userData', dataDir);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// video.audioTracks, so the player can switch between the Game / Microphone / Discord tracks
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// clipvault.log in the profile folder: starts, quits (and why) and unexpected errors.
function logLine(...parts) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'clipvault.log'), `[${new Date().toISOString()}] ${parts.join(' ')}\n`);
  } catch { /* logging must never break the app */ }
}
process.on('uncaughtException', (err) => logLine('uncaught exception:', (err && err.stack) || err));
process.on('unhandledRejection', (err) => logLine('unhandled rejection:', (err && err.stack) || err));

let settings;
let recorder;
let library;
let fg;
let league;
const inputs = new InputTracker();
// League switches off registered hotkeys while it's in front, so during a match the hotkeys are
// also read from cvhelper's key stream (inputs.js HotkeyMatcher). Keeps no keys.
const hotkeyKeys = new InputTracker({ store: false });
const minimap = new MinimapRecorder();
minimap.onDied = (code, why) => logLine(`minimap recording stopped by itself (${code}): ${why || 'no message'}`);
let leagueMatch = null; // { champion, clips, saves, startedEngine, recording } while a match runs
let matchStore = null; // League match records (matches.js); null if it couldn't start
let matchCapture = null; // fills them in from the game and the League client (match-capture.js)
let matchRecord = null; // the running match's record (matchCapture.start()), or null
let virtualClips = null; // highlights played as ranges of the full recording (virtual.js)
// --show-in-capture: let screenshots (and your clips) see the kill cam and notifications, for promo shots.
const SHOW_IN_CAPTURE = process.argv.includes('--show-in-capture');
let killCam = null; // death cam: replays of your deaths (and optionally kills) on another screen or over the game (killcam.js)
let mainWindow = null;
let overlayWindow = null;
let tray = null;
let encoders = [];
let ffmpegOk = false;
let lastError = null;
let hotkeyErrors = {};
let hotkeysSuspended = false;
let startPromise = null;
let recordingStartedEngine = false;
let restartPending = false;
let autoStarted = false;
let suppressAutoPid = null;
let gameGoneTimer = null;
let restartTimer = null;
let recoverTimer = null; // retrying capture after it stopped by itself (recoverCapture)
let bufferTurnedOn = false; // you turned the buffer on (hotkey / tray): capture restarts if it stops by itself
let bufferTurnedOff = false; // you turned the buffer off (hotkey / tray): don't restart it behind your back
let crashTimes = [];
let quitting = false;
let cleanupDone = false;
let trayHintShown = false;
const reservedFiles = new Set();
let recordingBookmarks = []; // wall times of bookmark presses during a manual recording
let job = null; // the editing job (highlight video, merge, share) that is running
const championIcons = {}; // champion name -> cached icon file
let gameIcons = null; // item, spell and rune icons (game-icons.js), made on first use
let updater = null; // the GitHub Releases check (update.js)
const playerNames = new Set(); // the League names you played as this session, kept out of bug reports

// ---------------------------------------------------------------------- helpers

function fmtSeconds(s) {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

function fmtDuration(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function appImage(size = 256, variant = 'active') {
  return nativeImage.createFromBuffer(icon.png(size, variant));
}

function trayImage(variant) {
  const img = nativeImage.createFromBuffer(icon.png(16, variant));
  for (const [scale, size] of [[1.25, 20], [1.5, 24], [2, 32]]) {
    img.addRepresentation({ scaleFactor: scale, dataURL: `data:image/png;base64,${icon.png(size, variant).toString('base64')}` });
  }
  return img;
}

function displays() {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays()
    .filter((d) => d.id !== primary.id)
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  return [primary, ...others].map((d, i) => {
    const phys = process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
    return {
      index: i,
      label: `Monitor ${i + 1}${i === 0 ? ' (primary)' : ''} · ${phys.width}×${phys.height}`,
      physical: phys,
      workArea: d.workArea,
      bounds: d.bounds,
    };
  });
}

function chosenEncoder() {
  const pref = settings.values.encoder;
  if (pref !== 'auto' && encoders.some((e) => e.id === pref)) return pref;
  return encoders.length ? encoders[0].id : 'x264';
}

// H.265 only when the chosen encoder can do it (the CPU fallback is H.264 only).
function chosenCodec() {
  if (settings.values.videoCodec !== 'hevc') return 'h264';
  const e = encoders.find((x) => x.id === chosenEncoder());
  return e && e.hevc ? 'hevc' : 'h264';
}

function fmtBytes(bytes) {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function outputPath(game, kind, label) {
  const folder = sanitizeName(game) || 'Desktop';
  const dir = path.join(settings.values.saveDir, folder);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const suffix = label ? ` ${sanitizeName(label)}` : kind === 'recording' ? ' Recording' : '';
  const base = `${folder} ${stamp}${suffix}`;
  let file = path.join(dir, `${base}.mp4`);
  for (let n = 2; fs.existsSync(file) || reservedFiles.has(file); n++) file = path.join(dir, `${base} (${n}).mp4`);
  reservedFiles.add(file);
  return file;
}

// ------------------------------------------------------------------ status / UI

function snapshot() {
  const st = recorder.status();
  return {
    ...st,
    starting: Boolean(startPromise) || st.state === 'starting',
    ffmpegOk,
    lastError,
    hotkeyErrors,
    encoders,
    encoder: chosenEncoder(),
    codec: chosenCodec(),
    job: job ? { id: job.id, label: job.label, progress: job.progress } : null,
    game: fg.current && !fg.current.isShell && !fg.current.isSelf ? fg.current.displayName : null,
    gameFullscreen: Boolean(fg.current && fg.current.isGame),
    league: leagueMatch ? { champion: leagueMatch.champion, clips: leagueMatch.clips, recording: leagueMatch.recording } : null,
    settings: settings.get(),
    displays: displays().map(({ index, label }) => ({ index, label })),
    version: app.getVersion(),
    update: updater ? updater.state() : null,
  };
}

let broadcastQueued = false;
function broadcast() {
  if (broadcastQueued) return;
  broadcastQueued = true;
  setImmediate(() => {
    broadcastQueued = false;
    updateTray();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status', snapshot());
  });
}

let overlayTimer = null;
// brief: a quick confirmation (each highlight during a match) that leaves sooner.
function toast(text, kind = 'info', { sound, sticky, brief } = {}) {
  const focused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused();
  if (focused) {
    mainWindow.webContents.send('toast', { text, kind, sticky });
  } else if (overlayWindow && !overlayWindow.isDestroyed() && (settings.values.overlay || kind === 'error')) {
    const all = displays();
    const s = settings.values;
    const other = s.notifyMonitor >= 0 && all[s.notifyMonitor] && s.notifyMonitor !== s.monitor;
    const d = (s.notifyMonitor >= 0 && all[s.notifyMonitor]) || all[s.monitor] || all[0];
    // setBounds (not setPosition) keeps the size right when screens use different scaling. On the
    // game's own screen it sits at the right edge a third of the way down, below League's top-right
    // HUD and above the minimap; on another screen, in its top-right corner.
    const w = 380;
    const h = 76;
    const y = other ? d.workArea.y + 16 : d.workArea.y + d.workArea.height * 0.3;
    overlayWindow.setBounds({ x: Math.round(d.workArea.x + d.workArea.width - w - 16), y: Math.round(y), width: w, height: h });
    overlayWindow.webContents.send('toast', { text, kind, sticky, brief });
    if (!overlayWindow.isVisible()) overlayWindow.showInactive();
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.hide(), sticky ? 10000 : brief ? 2000 : 3200);
  }
  if (sound && settings.values.clipSound && overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('sound', sound);
  }
}

let traySignature = '';
function updateTray() {
  if (!tray) return;
  const st = recorder.status();
  const s = settings.values;
  const on = st.state === 'running' || st.state === 'starting';
  const variant = st.recording ? 'recording' : on ? 'active' : 'off';
  const signature = JSON.stringify([variant, on, s.replaySeconds, s.hotkeys]);
  if (signature === traySignature) return;
  traySignature = signature;
  tray.setImage(trayImage(variant));
  tray.setToolTip(`ClipVault · ${st.recording ? 'Recording' : on ? `Replay buffer on (${fmtSeconds(s.replaySeconds)})` : 'Replay buffer off'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ClipVault', click: showWindow },
    { type: 'separator' },
    { label: `Save last ${fmtSeconds(s.replaySeconds)}`, accelerator: s.hotkeys.saveClip, registerAccelerator: false, enabled: on, click: () => saveClip() },
    { label: st.recording ? 'Stop recording' : 'Start recording', accelerator: s.hotkeys.toggleRecording, registerAccelerator: false, click: () => toggleRecording() },
    { label: 'Bookmark this moment', accelerator: s.hotkeys.bookmark, registerAccelerator: false, enabled: on, click: () => bookmark() },
    { label: 'Replay buffer', type: 'checkbox', checked: on, accelerator: s.hotkeys.toggleBuffer, registerAccelerator: false, click: () => toggleBuffer() },
    { type: 'separator' },
    { label: 'Open clips folder', click: openSaveDir },
    { label: 'Report a bug…', click: openBugReport },
    { label: 'Quit ClipVault', click: () => { logLine('quit from the tray menu'); app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(trayImage('off'));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTray();
}

function createOverlay() {
  overlayWindow = new BrowserWindow({
    width: 380,
    height: 76,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setContentProtection(!SHOW_IN_CAPTURE); // keep notifications out of your own clips
  overlayWindow.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
}

// Where the kill cam plays (killCamPlacement in killcam.js), or null when it can't.
function killCamPlace(opts) {
  return killCamPlacement(displays(), settings.values, opts);
}

let killCamWindow = null;
let killCamBig = false; // blown up by the camBig hotkey (until the cam closes)
let killCamEditing = false; // Move hotkey: the cam takes the mouse so you can drag and resize it
let killCamDrag = null; // { kind, bounds } while a drag runs
function killCamBand(big = killCamBig) { return keysBand(big); }
// The window for a place: the picture's bounds plus the band for the keys (keysBand in
// killcam.js), moved up to stay on screen.
function killCamWindowBounds(place, big = killCamBig) {
  const b = place.bounds;
  const area = place.onGameScreen ? place.display.bounds || place.display.workArea : place.display.workArea;
  const height = b.height + killCamBand(big);
  return { x: b.x, y: Math.max(area.y, Math.min(b.y, area.y + area.height - height)), width: b.width, height };
}
// Play a kill cam on another screen or over a quiet corner of the game. The window never takes
// focus, so the game keeps its keyboard and mouse. Over the game, clicks also pass through to it;
// on another screen a click closes the cam.
function showKillCam({ file, title, label }) {
  const place = killCamPlace({ big: killCamBig });
  if (!place) return false;
  if (!killCamWindow || killCamWindow.isDestroyed()) {
    killCamWindow = new BrowserWindow({
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
    });
    killCamWindow.setContentProtection(!SHOW_IN_CAPTURE); // keep it out of your own clips
    killCamWindow.loadFile(path.join(__dirname, 'killcam', 'killcam.html'));
  }
  // A cam that comes while you move the last one plays where you have it (mid-drag too).
  if (!(killCamEditing && killCamWindow.isVisible())) killCamWindow.setBounds(killCamWindowBounds(place));
  killCamWindow.setIgnoreMouseEvents(place.onGameScreen && !killCamEditing);
  const L = settings.values.league;
  const send = () => killCamWindow.webContents.send('killcam', {
    url: file ? pathToFileURL(file).href : '', title, label, zoom: L.killCamZoom, big: killCamBig, editing: killCamEditing, keys: killCamKeys(),
  });
  if (killCamWindow.webContents.isLoading()) killCamWindow.webContents.once('did-finish-load', send);
  else send();
  if (!killCamWindow.isVisible()) killCamWindow.showInactive();
  killCamWindow.setAlwaysOnTop(true, 'screen-saver');
  return true;
}

// The hotkeys shown under the cam: [[accelerator, what it does]].
function killCamKeys() {
  const k = settings.values.hotkeys;
  return [[k.camBig, killCamBig ? 'Smaller' : 'Bigger'], [k.camReplay, 'Replay'], [k.camMove, killCamEditing ? 'Done' : 'Move + resize'], [k.camClose, 'Close']].filter(([a]) => a);
}

function hideKillCam() {
  killCamBig = false;
  killCamEditing = false;
  killCamDrag = null;
  if (!killCamWindow || killCamWindow.isDestroyed()) return;
  killCamWindow.webContents.send('killcam:hide'); // the page stops (a cam looping in move mode too)
  killCamWindow.hide();
}

// Move hotkey (or Settings → "Move + resize"): the cam takes the mouse, over the game too, and
// stays up (the last cam loops; without one, an empty frame) until you press it again or Done.
function toggleKillCamEdit() {
  const showing = killCamWindow && !killCamWindow.isDestroyed() && killCamWindow.isVisible();
  if (killCamEditing) return endKillCamEdit();
  killCamEditing = true;
  killCamBig = false;
  if (showing) {
    const place = killCamPlace();
    if (place) killCamWindow.setBounds(killCamWindowBounds(place, false));
    killCamWindow.setIgnoreMouseEvents(false);
    killCamWindow.webContents.send('killcam:edit', { editing: true, big: false, keys: killCamKeys() }); // moving ends big
    return;
  }
  const last = killCam && killCam.lastShown;
  if (!showKillCam(last && fs.existsSync(last.file) ? last : { file: '', title: '', label: 'Death cam' })) killCamEditing = false;
}

function endKillCamEdit() {
  killCamEditing = false;
  killCamDrag = null;
  if (!killCamWindow || killCamWindow.isDestroyed()) return;
  const place = killCamPlace();
  killCamWindow.setIgnoreMouseEvents(Boolean(place && place.onGameScreen));
  killCamWindow.webContents.send('killcam:edit', { editing: false, big: killCamBig, keys: killCamKeys() });
}

// A drag from the cam page: phase start | move | end, kind move | resize, dx / dy in screen DIPs
// from where it started. Resizing keeps 16:9 and the top-left corner; the end saves the spot.
function onKillCamDrag({ phase, kind, dx = 0, dy = 0 }) {
  if (!killCamEditing || !killCamWindow || killCamWindow.isDestroyed()) return;
  if (phase === 'start') {
    // The size it was given, not the one Windows rounded it to (else each drag saves a pixel more).
    const bounds = killCamWindow.getBounds();
    const place = killCamPlace();
    const want = place && killCamWindowBounds(place);
    if (want && Math.abs(want.width - bounds.width) <= 2 && Math.abs(want.height - bounds.height) <= 2) Object.assign(bounds, { width: want.width, height: want.height });
    bounds.height -= killCamBand(); // the picture: the band follows it
    killCamDrag = { kind: kind === 'resize' ? 'resize' : 'move', bounds };
    return;
  }
  if (!killCamDrag) return;
  const b = killCamDrag.bounds;
  const place = killCamPlace();
  if (!place) return;
  const area = place.onGameScreen ? place.display.bounds || place.display.workArea : place.display.workArea;
  let next;
  if (killCamDrag.kind === 'move') {
    next = { x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: b.width, height: b.height };
  } else {
    const width = Math.round(Math.max(240, Math.min(area.width, (area.height * 16) / 9, b.width + Math.max(dx, (dy * 16) / 9))));
    next = { x: b.x, y: b.y, width, height: Math.round((width * 9) / 16) };
  }
  const band = killCamBand();
  next.x = Math.min(Math.max(area.x, next.x), area.x + area.width - next.width);
  next.y = Math.min(Math.max(area.y, next.y), area.y + area.height - next.height - band);
  // A move only moves: setBounds at 125% rounds the size up a pixel, so every drag grew the cam.
  if (killCamDrag.kind === 'move') killCamWindow.setPosition(next.x, next.y);
  else killCamWindow.setBounds({ ...next, height: next.height + band });
  if (phase === 'end') {
    killCamDrag = null;
    settings.update({ league: { killCamSpot: killCamSpotFor(place.display, next, place.onGameScreen) } });
    broadcast();
  }
}

// Hotkeys: blow the cam up to most of the screen (or back), play the last one again, close it.
function toggleKillCamBig() {
  if (!killCamWindow || killCamWindow.isDestroyed() || !killCamWindow.isVisible()) return;
  const place = killCamPlace({ big: !killCamBig });
  if (!place) return;
  killCamBig = !killCamBig;
  if (killCamBig && killCamEditing) endKillCamEdit();
  killCamWindow.setBounds(killCamWindowBounds(place));
  killCamWindow.webContents.send('killcam:big', { big: killCamBig, keys: killCamKeys() });
}

function replayKillCam() {
  const last = killCam && killCam.lastShown;
  if (!last || !fs.existsSync(last.file)) return toast('No death cam to replay yet', 'info', { brief: true });
  showKillCam(last);
}

// Settings → "Try it": the last few seconds of the replay buffer as a kill cam.
async function tryKillCam() {
  if (recorder.state !== 'running') throw new Error('Turn on the replay buffer first');
  if (!killCamPlace()) throw new Error('The death cam is set to your other screen, and you have one screen');
  const now = Date.now();
  await killCam.play(now - settings.values.league.killCamBefore * 1000, now, 'Try it', 'Death cam');
}

// The window's own colours per theme (the page's --bg-base and --text-2 / --text-disabled), so the
// first frame and the minimize / maximize / close buttons Windows draws match the app.
const WINDOW_COLOURS = {
  gray: { bg: '#181818', symbol: '#cccccc', dim: '#6b6b6b' },
  midnight: { bg: '#0f1c28', symbol: '#b2c0cf', dim: '#5a6b7d' },
  light: { bg: '#e0dbd6', symbol: '#5e5852', dim: '#a39b93' },
};
const windowColours = () => WINDOW_COLOURS[settings && settings.values.theme] || WINDOW_COLOURS.gray;
function applyWindowTheme() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const c = windowColours();
  try {
    mainWindow.setBackgroundColor(c.bg);
    mainWindow.setTitleBarOverlay({ color: c.bg, symbolColor: mainWindow.isFocused() ? c.symbol : c.dim });
  } catch { /* not supported */ }
}

function createMainWindow(show) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: 'ClipVault',
    backgroundColor: windowColours().bg, // --bg-base, so the first frame matches the app
    icon: appImage(256),
    autoHideMenuBar: true,
    // ClipVault's own header is the title bar. Windows still draws minimize / maximize / close over
    // its right end (so Snap Layouts keep working); never draw those buttons in HTML.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: windowColours().bg, symbolColor: windowColours().symbol, height: 48 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  // Dim the window buttons while another window is active, as Windows apps do.
  const overlaySymbols = (color) => { try { mainWindow.setTitleBarOverlay({ symbolColor: color }); } catch { /* not supported */ } };
  mainWindow.on('blur', () => overlaySymbols(windowColours().dim));
  mainWindow.on('focus', () => overlaySymbols(windowColours().symbol));
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (flag('verbose')) {
    mainWindow.webContents.on('console-message', (e, ...legacy) => console.log('[renderer]', e.message || legacy[1]));
  }
  mainWindow.once('ready-to-show', () => { if (show) mainWindow.show(); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  // Text fields get the usual Windows menu (dark, like the app); everything else has the app's own.
  mainWindow.webContents.on('context-menu', (_e, params) => {
    if (!params.isEditable) return;
    const can = params.editFlags || {};
    Menu.buildFromTemplate([
      { role: 'undo', enabled: Boolean(can.canUndo) }, { role: 'redo', enabled: Boolean(can.canRedo) }, { type: 'separator' },
      { role: 'cut', enabled: Boolean(can.canCut) }, { role: 'copy', enabled: Boolean(can.canCopy) },
      { role: 'paste', enabled: Boolean(can.canPaste) }, { type: 'separator' }, { role: 'selectAll' },
    ]).popup({ window: mainWindow });
  });
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      toast('ClipVault is still running in the tray', 'info');
    }
  });

  // --view=settings|player opens that view; with --screenshot=<file.png> [--quit-after-screenshot]
  // it also saves a picture of the window (used for testing).
  const shot = flag('screenshot');
  const startView = flag('view');
  if (typeof startView === 'string' && typeof shot !== 'string') {
    mainWindow.webContents.once('did-finish-load', async () => {
      await sleep(1200);
      mainWindow.webContents.send('navigate', startView);
    });
  }
  if (typeof shot === 'string') {
    // --window-size=1440x900 sets the content size for the picture.
    const size = String(flag('window-size') || '').split('x').map(Number);
    if (size[0] > 0 && size[1] > 0) mainWindow.setContentSize(size[0], size[1]);
    // The window is never shown, so keep its page painting; otherwise the capture is a stale frame.
    mainWindow.webContents.setBackgroundThrottling(false);
    mainWindow.webContents.once('did-finish-load', async () => {
      const view = flag('view');
      await sleep(1200);
      if (typeof view === 'string') mainWindow.webContents.send('navigate', view);
      await sleep(2500);
      if (flag('verbose') && typeof flag('eval') === 'string') {
        console.log('eval:', JSON.stringify(await mainWindow.webContents.executeJavaScript(flag('eval'), true).catch((err) => `error: ${err.message}`)));
      }
      if (flag('verbose')) {
        console.log('layout:', await mainWindow.webContents.executeJavaScript(
          `JSON.stringify({ innerHeight, app: document.querySelector(".app").offsetHeight, sidebar: document.querySelector(".sidebar").offsetHeight,
            trimDisabled: document.querySelector("#trimBtn") && document.querySelector("#trimBtn").disabled,
            stage: document.querySelector(".stage") && [document.querySelector(".stage").clientWidth, document.querySelector(".stage").clientHeight],
            overlay: document.querySelector("#kbOverlay") && [document.querySelector("#kbOverlay").offsetLeft, document.querySelector("#kbOverlay").offsetTop, document.querySelector("#kbOverlay").offsetWidth, document.querySelector("#kbOverlay").offsetHeight] })`));
      }
      // A hidden window stops drawing a few seconds after load. Resizing it (still hidden) by 2 px
      // makes Chromium draw a fresh frame of the current page; then it goes back to its size.
      const [w, h] = mainWindow.getSize();
      mainWindow.setSize(w, h + 2);
      await sleep(250);
      mainWindow.setSize(w, h);
      mainWindow.webContents.invalidate();
      await sleep(450);
      const img = await mainWindow.webContents.capturePage(undefined, { stayHidden: false });
      fs.writeFileSync(shot, img.toPNG());
      if (flag('quit-after-screenshot')) app.quit();
    });
  }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow(true);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// The bug report dialog lives in the main window (tray menu → Report a bug).
function openBugReport() {
  showWindow();
  const wc = mainWindow.webContents;
  const send = () => { if (mainWindow && !mainWindow.isDestroyed()) wc.send('bug-report'); };
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(send, 800));
  else send();
}

function openSaveDir() {
  fs.mkdirSync(settings.values.saveDir, { recursive: true });
  shell.openPath(settings.values.saveDir);
}

// --------------------------------------------------------------------- capture

function captureOptions() {
  const s = settings.values;
  const all = displays();
  const d = all[s.monitor] || all[0];
  return {
    bufferRoot: path.join(s.saveDir, '.clipvault-buffer'),
    replaySeconds: s.replaySeconds,
    fps: s.fps,
    quality: s.quality,
    resolution: s.resolution,
    encoder: chosenEncoder(),
    codec: chosenCodec(),
    monitor: d.index,
    display: d.physical,
    drawMouse: s.drawMouse,
    audio: audioOptions(s),
  };
}

// "The game you're playing": League's game until another fullscreen game comes to the front.
let soundExe = 'League of Legends.exe';

// Sound sources and tracks: track 1 is always everything mixed; with separate tracks on,
// the game, your microphone and Discord also get a track each.
function audioOptions(s) {
  const vk = vkFor(s.pttKey);
  return {
    // Only the game: its own process and the ones it started (silence while it isn't running).
    game: s.systemAudio
      ? (s.audioScope === 'game' ? { kind: 'process', exe: soundExe, volume: s.systemVolume } : { kind: 'loopback', volume: s.systemVolume })
      : null,
    // An unknown push-to-talk key keeps the mic off (the recorder warns) rather than always on.
    mic: s.mic ? { volume: s.micVolume, ptt: s.micMode === 'ptt' ? { vk, releaseMs: s.pttReleaseMs } : null } : null,
    discord: s.discordAudio ? { exe: 'Discord.exe', volume: s.discordVolume } : null,
    separateTracks: s.separateTracks,
  };
}

// quiet: no error toast (recoverCapture retries and says it once).
function startBuffer({ quiet = false } = {}) {
  if (recorder.state === 'running') return Promise.resolve();
  if (startPromise) return startPromise;
  if (!ffmpegOk) return Promise.reject(new Error(lastError || 'FFmpeg is missing'));
  startPromise = (async () => {
    if (recorder.state === 'stopping') await recorder.stop();
    try {
      await recorder.start(captureOptions());
      lastError = null;
    } catch (err) {
      lastError = `Couldn't start capture: ${err.message}`;
      logLine(lastError);
      if (!quiet) toast(lastError, 'error', { sound: 'error' });
      throw err;
    }
  })().finally(() => {
    startPromise = null;
    broadcast();
  });
  broadcast();
  return startPromise;
}

async function stopBuffer() {
  if (startPromise) await startPromise.catch(() => {});
  if (recorder.recording) await finishRecording({ stopEngine: false });
  await recorder.stop();
  autoStarted = false;
}

function restartCaptureSoon() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    if (recorder.recording) { restartPending = true; return; }
    if (recorder.state !== 'running' && !startPromise) return;
    await stopBuffer();
    await startBuffer().catch(() => {});
  }, 700);
}

async function toggleBuffer() {
  if (recorder.state === 'running' || recorder.state === 'starting' || startPromise) {
    if (fg.current && fg.current.isGame) suppressAutoPid = fg.current.pid;
    bufferTurnedOff = true;
    bufferTurnedOn = false;
    clearTimeout(recoverTimer);
    await stopBuffer();
    toast('Replay buffer off', 'info');
  } else {
    suppressAutoPid = null;
    bufferTurnedOff = false;
    bufferTurnedOn = true;
    clearTimeout(recoverTimer);
    try {
      await startBuffer();
      // Turned on again during a match whose recording stopped (capture stopped by itself, or you
      // turned the buffer off): the match recording carries on in a new file, as recoverCapture does.
      if (leagueMatch && leagueMatch.recording && !recorder.recording && recorder.state === 'running') {
        recorder.startRecording({ game: LEAGUE, league: true });
      }
      toast(`Replay buffer on · keeping the last ${fmtSeconds(settings.values.replaySeconds)}`, 'ok');
    } catch { /* already reported */ }
  }
}

// Store the key / mouse presses that happened during a just-saved video.
async function attachInputs(file, saved) {
  if (!inputs.events.length || !saved || !saved.startWall) return;
  const events = inputs.slice(saved.startWall, saved.startWall + saved.duration * 1000);
  if (events.length) await library.saveInputs(file, events);
}

// Wall-clock times -> markers on a video that starts at startWall.
function markersFrom(list, startWall, duration = Infinity) {
  return list
    .map((m) => ({ t: Math.round((m.wallMs - startWall) / 100) / 10, label: m.label, type: m.type }))
    .filter((m) => m.t >= 0 && m.t <= duration + 0.5);
}

// Storage limit: after saving, move the oldest non-favourite videos to the Recycle Bin.
let limitRunning = false;
async function enforceStorageLimit() {
  const gb = settings.values.storageLimitGB;
  if (!gb || limitRunning) return;
  limitRunning = true;
  try {
    await library.list(); // pick up files added or removed outside ClipVault
    // Every file of the match being played stays (its minimap and the highlights saved so far).
    const keep = leagueMatch ? [leagueMatch.map && leagueMatch.map.file, ...(leagueMatch.files || [])].filter(Boolean) : [];
    const { removed, freed } = await library.enforceLimit(gb * GB, { keep });
    if (removed.length) {
      logLine(`storage limit: moved ${removed.length} old video(s) to the Recycle Bin (${fmtBytes(freed)})`);
      toast(`Storage limit: ${removed.length} old video${removed.length === 1 ? '' : 's'} moved to the Recycle Bin (${fmtBytes(freed)})`, 'info');
    }
  } catch (err) {
    logLine('storage limit failed:', err.message);
  } finally {
    limitRunning = false;
  }
}

let lastSaveAt = 0;
// bookmarkAt: the clip comes from the bookmark hotkey; that moment is marked on it.
async function saveClip({ bookmarkAt } = {}) {
  if (Date.now() - lastSaveAt < 1000) return;
  lastSaveAt = Date.now();
  if (startPromise) await startPromise.catch(() => {});
  if (recorder.state !== 'running') {
    toast(`Replay buffer is off. Press ${settings.values.hotkeys.toggleBuffer} to turn it on`, 'warn', { sound: 'error' });
    return;
  }
  const game = fg.gameName();
  const seconds = settings.values.replaySeconds;
  const file = outputPath(game, 'clip', bookmarkAt ? 'Bookmark' : null);
  toast(`Saving the last ${fmtSeconds(seconds)}…`, 'saving', { sticky: true });
  try {
    const r = await recorder.saveReplay(seconds, file);
    const markers = bookmarkAt ? markersFrom([{ wallMs: bookmarkAt, label: 'Bookmark', type: 'bookmark' }], r.startWall, r.duration) : undefined;
    await library.add(file, { type: 'clip', game, markers, ...(bookmarkAt ? { label: 'Bookmark', event: 'bookmark' } : {}) });
    await attachInputs(file, r);
    toast(`Clip saved · ${game} · ${Math.round(r.duration)} s`, 'ok', { sound: 'clip' });
    enforceStorageLimit();
  } catch (err) {
    toast(`Couldn't save clip: ${err.message}`, 'error', { sound: 'error' });
  } finally {
    reservedFiles.delete(file);
  }
}

// Bookmark hotkey: in a League match it becomes a key moment (and a clip); during a
// recording it's a marker on the timeline; otherwise it saves a clip with the moment marked.
let lastBookmarkAt = 0;
function bookmark() {
  const now = Date.now();
  if (now - lastBookmarkAt < 1500) return; // a held or double-pressed key
  lastBookmarkAt = now;
  if (leagueMatch && league.addBookmark(now)) {
    toast('Bookmarked', 'ok', { sound: 'clip' });
    return;
  }
  if (recorder.recording) {
    recordingBookmarks.push({ wallMs: now, label: 'Bookmark', type: 'bookmark' });
    toast(`Bookmark added to the recording (${recordingBookmarks.length})`, 'ok', { sound: 'clip' });
    return;
  }
  saveClip({ bookmarkAt: now });
}

async function toggleRecording() {
  if (recorder.recording) {
    await finishRecording({ stopEngine: true });
    return;
  }
  try {
    recordingStartedEngine = recorder.state !== 'running';
    await startBuffer();
    recorder.startRecording({ game: fg.gameName() });
    recordingBookmarks = [];
    toast('Recording started', 'rec', { sound: 'start' });
  } catch (err) {
    toast(`Couldn't start recording: ${err.message}`, 'error', { sound: 'error' });
  }
}

async function saveRecording() {
  const rec = recorder.recording;
  if (!rec) return;
  const file = outputPath(rec.game, 'recording');
  const bookmarks = recordingBookmarks;
  recordingBookmarks = [];
  toast('Saving recording…', 'saving', { sticky: true });
  try {
    const r = await recorder.stopRecording(file);
    await library.add(file, { type: 'recording', game: rec.game, markers: markersFrom(bookmarks, r.startWall, r.duration) });
    await attachInputs(file, r);
    toast(`Recording saved · ${rec.game} · ${fmtDuration(r.duration)}`, 'ok', { sound: 'stop' });
    enforceStorageLimit();
  } catch (err) {
    toast(`Couldn't save recording: ${err.message}`, 'error', { sound: 'error' });
  } finally {
    reservedFiles.delete(file);
  }
}

async function finishRecording({ stopEngine }) {
  await saveRecording();
  const engineWasForRecording = recordingStartedEngine;
  recordingStartedEngine = false;
  if (stopEngine && engineWasForRecording) {
    // The buffer was off before this recording; put it back the way it was.
    await recorder.stop();
  } else if (restartPending) {
    restartPending = false;
    restartCaptureSoon();
  }
}

async function onCaptureCrashed(message) {
  console.warn('capture stopped unexpectedly:', message);
  const rec = recorder.recording;
  if (rec) await saveRecording();
  // What was captured before stays clippable (and death-cammable) once capture runs again.
  await recorder.stop({ keepFootage: true });
  crashTimes = crashTimes.filter((t) => Date.now() - t < 60000).concat(Date.now());
  const looping = crashTimes.length > 3;
  if (looping) {
    lastError = `Capture keeps stopping: ${message}`;
    toast(`${lastError}. Trying again in a minute`, 'error', { sound: 'error' });
    broadcast();
  }
  const meta = rec ? (({ startPos, startedAt, ...m }) => m)(rec) : null;
  recoverCapture({ meta, attempt: 0, firstDelay: looping ? 60000 : 1500 });
}

// After capture stopped by itself, start it again, and keep trying: right after a freeze Windows
// can still be handing out no frames (the 2026-10-29 match: one restart failed, then nothing
// tried again for the rest of the game). Stops when you turn the buffer off or it isn't wanted.
const RECOVER_DELAYS_MS = [1500, 5000, 10000, 20000, 30000]; // then every 30 s
function recoverCapture({ meta, attempt, firstDelay }) {
  clearTimeout(recoverTimer);
  const delay = firstDelay != null ? firstDelay : RECOVER_DELAYS_MS[Math.min(attempt, RECOVER_DELAYS_MS.length - 1)];
  recoverTimer = setTimeout(async () => {
    const wanted = () => !quitting && !bufferTurnedOff
      && (settings.values.bufferMode === 'always' || leagueMatch || autoStarted || bufferTurnedOn || meta);
    if (!wanted()) { logLine('capture not restarted: the buffer is no longer wanted'); return; }
    if (recorder.state === 'running' || startPromise) return;
    try {
      await startBuffer({ quiet: true });
    } catch (err) {
      logLine(`capture restart ${attempt + 1} failed: ${err.message}`);
      if (!wanted()) return;
      if (attempt === 0) toast('Capture stopped · ClipVault keeps trying to restart it', 'warn', { sound: 'error' });
      recoverCapture({ meta, attempt: attempt + 1 });
      return;
    }
    logLine(`capture restarted${attempt ? ` after ${attempt + 1} tries` : ''}`);
    // Turned off (or quitting) while it was starting: stopBuffer is already putting it away.
    if (!wanted() || recorder.state !== 'running') return;
    // The match recording carries on in a new file (League matches: whenever one is running).
    const recMeta = meta || (leagueMatch && leagueMatch.recording ? { game: LEAGUE, league: true } : null);
    if (recMeta && !recorder.recording) {
      recorder.startRecording(recMeta);
      toast('Capture restarted · recording continues in a new file', 'warn');
    } else if (attempt) {
      toast('Capture restarted', 'ok');
    }
  }, delay);
}

// Buffer mode "games": start when a fullscreen app is in front, stop two minutes after
// it's gone (unless you're recording).
function evaluateAutoBuffer() {
  if (settings.values.bufferMode !== 'games' || !ffmpegOk) return;
  const info = fg.current;
  if (info && info.isGame) {
    clearTimeout(gameGoneTimer);
    gameGoneTimer = null;
    if (recorder.state === 'idle' && !startPromise && suppressAutoPid !== info.pid) {
      autoStarted = true;
      startBuffer().then(() => toast(`Replay buffer on · ${info.displayName}`, 'ok')).catch(() => {});
    }
  } else if (autoStarted && recorder.state === 'running' && !gameGoneTimer) {
    gameGoneTimer = setTimeout(() => {
      gameGoneTimer = null;
      if (autoStarted && !recorder.recording && !(fg.current && fg.current.isGame)) stopBuffer();
    }, 120000);
  }
}

// ------------------------------------------------------------ League auto clips

// A League game is running: a match is being recorded, the live game API answers, or the game
// itself is open. Nothing that deletes files on its own runs then.
function leagueGameRunning() {
  if (leagueMatch) return true;
  if (league && league.status()) return true;
  return Boolean(fg && fg.current && /^league of legends\.exe$/i.test(fg.current.exe || ''));
}

// How far back the buffer must reach so a highlight can still be cut when it's saved
// (moments are merged for a while before the clip is written).
function leagueKeepSeconds() {
  const o = settings.values.league;
  return o.before + o.after + MAX_SPAN_MS / 1000 + o.mergeGap + 10;
}

// Champion icons (Riot Data Dragon, cached on disk) for match cards and the reel.
function fetchChampionIcons(names) {
  const dir = path.join(app.getPath('userData'), 'champions');
  for (const name of names) {
    if (!name || championIcons[name]) continue;
    championIcons[name] = null; // asked for; don't ask again this session
    championIcon(name, dir).then((file) => {
      if (!file) return;
      championIcons[name] = file;
      library.emit('changed');
    }).catch(() => {});
  }
}

async function onLeagueMatchStart({ champion }) {
  fetchChampionIcons([champion]);
  // League blocks registered hotkeys in every match, whatever the auto clip settings are, and
  // even when the buffer can't start (the hotkeys still toggle it or report why).
  hotkeyMatcher.reset();
  hotkeyKeys.start('League of Legends.exe');
  const o = settings.values.league;
  // Even with a full recording, the small minimap file is what sits beside each highlight.
  const recordMap = o.recordMap;
  if (!o.enabled && !o.recordMatch && !recordMap) return;
  leagueMatch = { champion, clips: 0, saves: [], startedEngine: false, recording: false, map: null };
  if (recordMap) {
    const all = displays();
    const d = all[settings.values.monitor] || all[0];
    const file = outputPath(LEAGUE, 'map', [champion, 'Map'].filter(Boolean).join(' '));
    try {
      minimap.start({ display: d.physical, monitor: d.index, encoder: chosenEncoder(), outFile: file });
      leagueMatch.map = { file };
    } catch (err) {
      console.warn('minimap recording failed to start:', err.message);
    } finally {
      reservedFiles.delete(file);
    }
  }
  if (!o.enabled && !o.recordMatch) { broadcast(); return; }
  recorder.setMinimumKeep(leagueKeepSeconds());
  try {
    if (recorder.state !== 'running') {
      leagueMatch.startedEngine = true;
      await startBuffer();
    }
    if (o.recordMatch && !recorder.recording) {
      recorder.startRecording({ game: LEAGUE, league: true });
      leagueMatch.recording = true;
    }
    if (o.trackInputs) inputs.start('League of Legends.exe');
    toast(`${LEAGUE}${champion ? ` · ${champion}` : ''} · auto clips on`, 'ok');
  } catch { /* startBuffer already reported it */ }
  broadcast();
}

// Stop the minimap recording and add it to the library with the match's moments marked.
// Returns the minimap file (the match reel), or null.
async function finishMinimap(lm, { moments = [], champion, outcome, stats, rec } = {}) {
  if (!lm || !lm.map) return null;
  const saved = await minimap.stop();
  if (!saved) return null;
  const markers = markersFrom(moments, saved.startWall || Date.now());
  await library.add(saved.file, {
    type: 'map', game: LEAGUE, label: outcome ? `${outcome} · match reel` : 'Match reel', champion, markers,
    ...(stats ? { stats } : {}), ...matchStamp(rec),
  });
  addMatchMedia(rec, 'map', { file: saved.file, startWall: saved.startWall });
  syncMinimap(saved.file).catch((err) => logLine('minimap sync failed:', err.message));
  return saved.file;
}

// The match reel opens when the match ends, once the game itself has closed (never over the
// game's victory screen).
function openReelWhenGameCloses(mapFile) {
  const deadline = Date.now() + 10 * 60 * 1000;
  const check = () => {
    const inGame = fg.current && /^league of legends\.exe$/i.test(fg.current.exe || '');
    if (inGame && Date.now() < deadline) { setTimeout(check, 1500); return; }
    if (inGame || leagueMatch) return; // still playing, or the next match already started
    logLine('showing the match reel');
    showWindow();
    const send = () => mainWindow.webContents.send('open-reel', mapFile);
    if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', () => setTimeout(send, 800));
    else send();
  };
  check();
}

// Fine-tune the minimap's alignment against real footage from the match (see measureSyncError).
async function syncMinimap(mapFile) {
  const ref = library.linkedToMap(mapFile).find(({ meta }) => (meta.duration || 0) >= 8 && !meta.virtual);
  if (!ref) return;
  const all = displays();
  const d = all[settings.values.monitor] || all[0];
  const res = await measureSyncError({
    clipFile: ref.file, clipHeight: ref.meta.height, clipDuration: ref.meta.duration,
    offset: ref.meta.map.offset, mapFile, display: d.physical,
  });
  logLine('minimap sync:', res ? `corrected by ${res.delta} s (match ${res.ssim.toFixed(3)})` : 'no clear match, left as is');
  if (res && res.delta !== 0) {
    library.shiftMapSync(mapFile, res.delta);
    // Same correction on the match record: the minimap's game time moves the other way.
    if (matchStore) {
      const same = (x) => x && x.file && path.resolve(x.file).toLowerCase() === path.resolve(mapFile).toLowerCase();
      matchStore.byFile(mapFile).then((key) => key && matchStore.update(key, (r) => {
        for (const m of [r.media.map, ...(r.media.maps || [])]) {
          if (same(m) && Number.isFinite(m.gameStart)) m.gameStart = Math.round((m.gameStart - res.delta) * 10) / 10;
        }
      })).catch((err) => logLine('match record: minimap sync:', err.message));
    }
  }
}

// ---------------------------------------------------------------- League match records
// One record per match with the stats (matches.js), filled in by match-capture.js. None of this
// is ever awaited by capture: it starts once recording runs, finishes after the match-over toast,
// and every failure only ends up in clipvault.log.

function matchStamp(rec) {
  return rec && rec.key ? { match: rec.key } : {};
}

function addMatchMedia(rec, kind, entry) {
  if (!rec || !matchCapture) return;
  try { matchCapture.addMedia(rec, kind, entry); } catch (err) { logLine('match record:', err.message); }
}

function startMatchRecord(e) {
  if (!matchCapture || !league.status()) return; // off, or the match is already over
  try {
    matchRecord = matchCapture.start({ ...e, live: league.startSnapshot() });
  } catch (err) {
    logLine('match record:', err.message);
  }
}

function endMatchRecord(rec, e) {
  if (!rec || !matchCapture) return Promise.resolve();
  return matchCapture.end(rec, e)
    .then((record) => { if (record) library.setMatch(rec.media.map((m) => m.file), record.key); })
    .catch((err) => logLine('match record:', err.message));
}

// Fills in what older matches still miss (match history, timelines) while the League client runs.
function sweepMatches() {
  if (!matchCapture || league.status()) return; // never during a match
  matchCapture.sweep().catch((err) => logLine('match sweep:', err.message));
}

async function saveHighlight({ fromMs, toMs, title, type, moments, champion }) {
  const lm = leagueMatch;
  const rec = matchRecord;
  if (recorder.state !== 'running') return;
  const file = outputPath(LEAGUE, 'highlight', title);
  try {
    const r = await recorder.saveRange(fromMs, toMs, file);
    const markers = moments.map((m) => ({ t: Math.max(0, Math.round((m.wallMs - r.startWall) / 100) / 10), label: m.label, type: m.type }));
    // Where this clip starts inside the match's minimap recording, so the player can show it in sync.
    const map = lm && lm.map && minimap.startWall ? { file: lm.map.file, offset: Math.round((r.startWall - minimap.startWall) / 100) / 10 } : undefined;
    await library.add(file, { type: 'highlight', event: type, game: LEAGUE, label: title, champion, markers, map, ...matchStamp(rec) });
    addMatchMedia(rec, 'clip', { file, startWall: r.startWall, duration: Number.isFinite(r.duration) ? r.duration : (toMs - fromMs) / 1000, title, type, moments });
    await attachInputs(file, r);
    if (lm) {
      lm.clips++;
      (lm.files || (lm.files = [])).push(file); // the storage limit never touches the running match
    }
    toast(`${title} saved`, 'ok', { sound: 'clip', brief: true });
  } catch (err) {
    toast(`Couldn't save highlight: ${err.message}`, 'error', { sound: 'error' });
  } finally {
    reservedFiles.delete(file);
    broadcast();
  }
}

async function onLeagueMatchEnd(e) {
  const { result, moments, champion, summary } = e;
  const lm = leagueMatch;
  const rec = matchRecord;
  leagueMatch = null;
  matchRecord = null;
  hotkeyKeys.stop(); // started at every match start, also when auto clips are off
  if (!lm) { endMatchRecord(rec, e); return; }
  const outcome = result === 'Win' ? 'Victory' : result === 'Lose' ? 'Defeat' : null;
  // Post-game summary kept with the match reel and the full recording: K/D/A, CS, level, result.
  const stats = summary ? { ...summary, result: outcome, highlights: lm.clips } : null;
  let fullFile = null;
  if (lm.recording && recorder.recording && recorder.recording.league) {
    const file = outputPath(LEAGUE, 'recording', [champion, outcome, 'Match'].filter(Boolean).join(' '));
    try {
      const r = await recorder.stopRecording(file);
      // Linked to the minimap recording so the match reel can play it in the gaps.
      const map = lm.map && minimap.startWall ? { file: lm.map.file, offset: Math.round((r.startWall - minimap.startWall) / 100) / 10 } : undefined;
      await library.add(file, {
        type: 'recording', game: LEAGUE, label: 'Full match', champion, markers: markersFrom(moments, r.startWall), map,
        span: r.duration, // what the recorder wrote: virtual clips check the file against it
        ...(stats ? { stats } : {}), ...matchStamp(rec),
      });
      addMatchMedia(rec, 'full', { file, startWall: r.startWall });
      fullFile = file;
      await attachInputs(file, r);
    } catch (err) {
      toast(`Couldn't save the match recording: ${err.message}`, 'error', { sound: 'error' });
    } finally {
      reservedFiles.delete(file);
    }
  }
  await Promise.allSettled(lm.saves);
  inputs.stop();
  if (stats) stats.highlights = lm.clips;
  const mapFile = await finishMinimap(lm, { moments, champion, outcome, stats, rec });
  recorder.setMinimumKeep(0);
  if (lm.startedEngine && settings.values.bufferMode !== 'always' && !recorder.recording) await stopBuffer();
  const kda = stats ? ` · ${stats.kills}/${stats.deaths}/${stats.assists}` : '';
  // "Match saved · Defeat · Evelynn 11/10/7" over "28 highlights · opens after the game" (two short lines)
  const who = [outcome, [champion, stats ? `${stats.kills}/${stats.deaths}/${stats.assists}` : ''].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  const opens = mapFile && settings.values.league.openReel ? ' · opens after the game' : '';
  toast(`Match saved${who ? ` · ${who}` : ''}\n${lm.clips} highlight${lm.clips === 1 ? '' : 's'}${opens}`, 'ok', { sticky: true });
  logLine(`match over: ${outcome || 'no result'}${kda}, ${lm.clips} highlights`);
  const recordDone = endMatchRecord(rec, e);
  broadcast();
  enforceStorageLimit();
  if (fullFile && !settings.values.keepHighlightFiles) virtualizeWhenGameCloses(fullFile, recordDone);
  if (mapFile && settings.values.league.openReel && !flag('no-capture')) openReelWhenGameCloses(mapFile);
}

// "Keep separate highlight files" off: once the match record has its videos and the game has
// closed, the match's highlights become ranges of its full recording (virtual.js verifies first).
function virtualizeWhenGameCloses(fullFile, recordDone) {
  if (!virtualClips) return;
  const deadline = Date.now() + 30 * 60 * 1000;
  const check = () => {
    if (leagueGameRunning()) {
      // Still in the game (or the next match started: Free up space can catch this one later).
      if (Date.now() < deadline && !leagueMatch) setTimeout(check, 5000);
      return;
    }
    virtualClips.afterMatch(virtualClips.unitOf(fullFile))
      .then((res) => {
        if (!res || !res.clips) return;
        logLine(`virtual clips: ${res.clips} highlight file(s) of ${path.basename(fullFile)} to the Recycle Bin (${fmtBytes(res.bytes)})`);
        toast(`Freed ${fmtBytes(res.bytes)}: ${res.clips} highlight${res.clips === 1 ? '' : 's'} now play from the full recording`, 'ok');
      })
      .catch((err) => logLine('virtual clips:', err.message));
  };
  Promise.resolve(recordDone).catch(() => {}).then(() => setTimeout(check, 3000));
}

// A real file for a library entry: a virtual clip is exported back to one first (about a second).
async function realFile(file) {
  const safe = library.assertInside(file);
  if (!library.isVirtual(safe) || !virtualClips) return safe;
  return virtualClips.materialize(safe);
}

// ---------------------------------------------------------------- editing jobs
// Highlight videos, merges and small copies for sharing re-encode video, so they run one at
// a time with their progress shown in the UI.

async function runJob(label, fn) {
  if (job) throw new Error(`Wait for "${job.label}" to finish first`);
  job = { id: Date.now(), label, progress: 0 };
  broadcast();
  let sentAt = 0;
  const onProgress = (fraction) => {
    if (!job) return;
    job.progress = Math.max(0, Math.min(1, Number(fraction) || 0));
    if (Date.now() - sentAt > 300) { sentAt = Date.now(); broadcast(); }
  };
  try {
    return await fn(onProgress);
  } finally {
    job = null;
    broadcast();
  }
}

// Markers and key presses of the source videos, moved to where each piece lands in the new video.
async function carryOver(segments) {
  const markers = [];
  const presses = [];
  let at = 0;
  for (const s of segments) {
    const meta = library.meta(s.file) || {};
    const from = s.from || 0;
    const to = s.to != null ? s.to : meta.duration || 0;
    for (const m of meta.markers || []) {
      if (m.t >= from - 0.05 && m.t <= to + 0.05) markers.push({ ...m, t: Math.round((at + Math.max(0, m.t - from)) * 10) / 10 });
    }
    if (meta.inputs) {
      for (const [t, k, d] of await library.loadInputs(s.file)) {
        if (t >= from * 1000 && t <= to * 1000) presses.push([Math.round(t - from * 1000 + at * 1000), k, d]);
      }
    }
    at += Math.max(0, to - from);
  }
  return { markers, presses };
}

// A virtual clip's piece is the same stretch of its full recording.
function physical(segments) {
  return segments.map((s) => {
    const v = library.meta(s.file) && library.meta(s.file).virtual;
    if (!v) return s;
    return { file: v.file, from: v.from + (s.from || 0), to: s.to != null ? Math.min(v.to, v.from + s.to) : v.to };
  });
}

async function buildInto(file, segments, extra, label) {
  try {
    const carried = await carryOver(segments);
    const r = await runJob(label, (onProgress) => edit.buildVideo({
      segments: physical(segments), outFile: file, encoder: chosenEncoder(), quality: 'high', codec: chosenCodec(), onProgress,
    }));
    await library.add(file, { ...extra, markers: carried.markers });
    if (carried.presses.length) await library.saveInputs(file, carried.presses);
    enforceStorageLimit();
    return { ...library.itemFor(file), duration: r.duration };
  } finally {
    reservedFiles.delete(file);
  }
}

// One video of a match's highlights in order, without repeating footage where clips overlap.
// A clip whose only moments are your deaths: useful for review, left out of highlight videos by default.
const onlyDeaths = (meta) => (meta.markers || []).length > 0 && meta.markers.every((m) => m.type === 'death');

async function makeHighlightVideo(mapFile, { includeDeaths = false } = {}) {
  mapFile = library.assertInside(mapFile);
  const mapMeta = library.meta(mapFile) || {};
  const clips = library.linkedToMap(mapFile)
    .filter(({ meta }) => meta.type === 'highlight' && meta.duration > 0 && (includeDeaths || !onlyDeaths(meta)))
    .map(({ file, meta }) => ({ file, start: meta.map.offset, end: meta.map.offset + meta.duration }));
  if (!clips.length) throw new Error('This match has no highlights');
  const segments = edit.planHighlightReel(clips);
  const stats = mapMeta.stats || null;
  const outcome = stats && stats.result ? stats.result : null;
  const champion = mapMeta.champion || (stats && stats.champion) || null;
  const file = outputPath(mapMeta.game || LEAGUE, 'montage', [champion, outcome, 'Highlights'].filter(Boolean).join(' '));
  return buildInto(file, segments, {
    type: 'montage', game: mapMeta.game || LEAGUE, label: 'Highlight video', champion, ...(stats ? { stats } : {}),
    source: { map: mapFile }, // groups the video with its match in the library
  }, `Highlight video (${clips.length} clip${clips.length === 1 ? '' : 's'})`);
}

// Several videos joined one after another, in the order given.
async function mergeVideos(files) {
  files = (files || []).map((f) => library.assertInside(f));
  if (files.length < 2) throw new Error('Pick at least two videos');
  const metas = files.map((f) => library.meta(f) || {});
  const game = metas.every((m) => m.game === metas[0].game) && metas[0].game ? metas[0].game : 'Desktop';
  const champion = metas.every((m) => m.champion === metas[0].champion) ? metas[0].champion : null;
  const file = outputPath(game, 'merge', 'Merged');
  return buildInto(file, files.map((f) => ({ file: f })), { type: 'clip', game, label: 'Merged', champion }, `Merging ${files.length} videos`);
}

// A copy small enough for Discord's upload limit, put on the clipboard ready to paste.
async function shareVideo(file, targetMB, audioTrack = 0) {
  file = await realFile(file);
  const meta = library.meta(file) || {};
  const limit = Number(targetMB) * 1e6;
  let out = file;
  let made = null;
  if (!(meta.size && meta.size <= limit * 0.97 && !audioTrack && meta.codec !== 'hevc')) {
    const dir = path.join(settings.values.saveDir, '.shared'); // dot folders stay out of the library
    fs.mkdirSync(dir, { recursive: true });
    cleanShared(dir);
    out = path.join(dir, `${path.basename(file, path.extname(file))} (${targetMB} MB).mp4`);
    made = await runJob(`Making a ${targetMB} MB copy`, (onProgress) => edit.exportForSharing({
      file, targetMB: Number(targetMB), outFile: out, audioTrack: Number(audioTrack) || 0, encoder: chosenEncoder(), onProgress,
    }));
  }
  await library.copyToClipboard(out);
  const bytes = made ? made.bytes : meta.size;
  return { file: out, bytes, reencoded: Boolean(made), width: made ? made.width : meta.width, height: made ? made.height : meta.height };
}

// Shared copies are only needed until they're pasted; clear out ones older than two days.
function cleanShared(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
      const st = fs.statSync(f);
      if (st.isFile() && Date.now() - st.mtimeMs > 2 * 86400000) fs.rmSync(f, { force: true });
    }
  } catch { /* ignore */ }
}

// --------------------------------------------------------------------- hotkeys

const HOTKEY_ACTIONS = {
  saveClip: () => saveClip(),
  toggleRecording: () => toggleRecording(),
  toggleBuffer: () => toggleBuffer(),
  bookmark: () => bookmark(),
  camBig: () => toggleKillCamBig(),
  camReplay: () => replayKillCam(),
  camClose: () => hideKillCam(),
  camMove: () => toggleKillCamEdit(),
};

// Both ways in (globalShortcut and the key stream) land here; when both see a press it runs once.
// via: 'shortcut' (globalShortcut) or 'keys' (the key stream); logged, so a test in a match shows
// which way each press came in.
// A held hotkey fires once, and a press seen both ways fires once (inputs.js hotkeyGate).
const hotkeyGate = makeHotkeyGate();
function fireHotkey(action, via = 'shortcut') {
  if (hotkeysSuspended || !HOTKEY_ACTIONS[action]) return;
  if (!hotkeyGate(action)) return;
  logLine(`hotkey ${action} (${via === 'keys' ? 'key stream' : 'registered hotkey'})`);
  HOTKEY_ACTIONS[action]();
}
const hotkeyMatcher = new HotkeyMatcher((action) => fireHotkey(action, 'keys'));
hotkeyKeys.on('key', (e) => hotkeyMatcher.onKey(e));
hotkeyKeys.on('error', (err) => logLine(`hotkey listener: ${err.message}`));
hotkeyKeys.on('exit', (code) => { hotkeyMatcher.reset(); if (hotkeyKeys.wanted) logLine(`hotkey listener exited (${code}); restarting it`); });
inputs.on('exit', (code) => { if (inputs.wanted) logLine(`input tracking exited (${code}); restarting it`); });

function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyErrors = {};
  hotkeyMatcher.setHotkeys(settings.values.hotkeys);
  if (!hotkeysSuspended) {
    for (const [action, accel] of Object.entries(settings.values.hotkeys)) {
      if (!accel || !HOTKEY_ACTIONS[action]) continue;
      let ok = false;
      try { ok = globalShortcut.register(accel, () => fireHotkey(action)); } catch { ok = false; }
      if (!ok) hotkeyErrors[action] = `${accel} couldn't be registered (another app may be using it)`;
    }
    if (flag('verbose')) console.log('hotkey problems:', JSON.stringify(hotkeyErrors));
  }
  broadcast();
}

function applyLoginItem() {
  if (dataDir) return;
  const args = app.isPackaged ? ['--hidden'] : [path.resolve(__dirname, '..'), '--hidden'];
  app.setLoginItemSettings({ openAtLogin: settings.values.startWithWindows, path: process.execPath, args });
}

// ---------------------------------------------------------- updates, bug reports

async function fetchJson(url) {
  const buf = await fetchBuffer(url, { maxBytes: 1024 * 1024, headers: { Accept: 'application/vnd.github+json' } });
  return JSON.parse(buf.toString('utf8'));
}

// One toast per new version, never while you play: in a League match or with a fullscreen game in
// front it waits and tries again every few minutes.
function announceUpdate(release) {
  if (!release || settings.values.updateNotified === release.version) return;
  if (leagueGameRunning() || (fg.current && fg.current.isGame)) {
    setTimeout(() => announceUpdate(updater.state().release), 5 * 60 * 1000);
    return;
  }
  settings.update({ updateNotified: release.version });
  toast(`ClipVault ${release.version} is available · Settings → About`, 'info');
}

let ffmpegVersion = null;
let gpuName = null;
// What a bug report's diagnostics say about this PC. Nothing here names a file or a person.
async function bugFacts() {
  if (ffmpegVersion == null) {
    const r = await run(paths.ffmpeg, ['-hide_banner', '-version'], { timeout: 10000 });
    const m = /ffmpeg version (\S+)/.exec(r.stdout || '');
    ffmpegVersion = m ? m[1] : r.code === 0 ? 'unknown' : 'not found';
  }
  if (gpuName == null) {
    try {
      const info = await Promise.race([app.getGPUInfo('complete'), sleep(3000).then(() => null)]);
      const devices = (info && info.gpuDevice) || [];
      const dev = devices.find((d) => d.active) || devices[0];
      // ANGLE's renderer string names the card: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti (0x...) Direct3D11 ...)"
      const gl = info && info.auxAttributes && info.auxAttributes.glRenderer;
      const m = gl && /^ANGLE \([^,]+, (.+?)(?: \(0x[0-9a-f]+\))? Direct3D/i.exec(gl);
      gpuName = (dev && dev.deviceString) || (m && m[1]) || 'unknown';
    } catch { gpuName = 'unknown'; }
  }
  const build = Number(os.release().split('.')[2]) || 0;
  const windows = `${build >= 22000 ? os.version().replace('Windows 10', 'Windows 11') : os.version()} (${os.release()})`;
  const s = settings.values;
  const L = s.league;
  const info = recorder.status().info;
  const all = displays();
  return {
    app: `${app.getVersion()}${app.isPackaged ? '' : ' (from source)'}`,
    windows,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    ffmpeg: ffmpegVersion,
    gpu: gpuName,
    encoder: `${chosenEncoder()}${s.encoder === 'auto' ? ' (automatic)' : ''}`,
    encoders: encoders.map((e) => e.id).join(', '),
    codec: chosenCodec(),
    capture: info ? `${info.method || '?'} · ${recorder.state}` : recorder.state,
    screens: `${all.length}: ${all.map((d) => `${d.physical.width}×${d.physical.height}`).join(', ')}`,
    settings: {
      fps: s.fps, resolution: s.resolution, quality: s.quality, bufferMode: s.bufferMode, replaySeconds: s.replaySeconds,
      monitor: s.monitor, audio: s.systemAudio ? s.audioScope : 'off', mic: s.mic ? s.micMode : 'off', discord: s.discordAudio,
      separateTracks: s.separateTracks, storageLimitGB: s.storageLimitGB, keepHighlightFiles: s.keepHighlightFiles,
      league: L.enabled, recordMatch: L.recordMatch, recordMap: L.recordMap, killCam: L.killCam, trackInputs: L.trackInputs,
      overlay: s.overlay, notifyMonitor: s.notifyMonitor,
    },
  };
}

// Redaction options: your Windows user name, and the League names from this session and the
// last few match records (you and the players you met).
async function redactOptions() {
  const names = new Set(playerNames);
  try {
    const rows = matchStore ? (await matchStore.list()).slice(0, 5) : [];
    for (const row of rows) {
      const rec = await matchStore.get(row.key);
      for (const p of (rec && rec.participants) || []) {
        if (p.name) names.add(p.name);
        if (p.name && p.tag) names.add(`${p.name}#${p.tag}`);
      }
    }
  } catch { /* the report goes without them; Riot IDs are still caught by their shape */ }
  let user = '';
  try { user = os.userInfo().username; } catch { /* ignore */ }
  return { user, names: [...names] };
}

async function bugLogTail() {
  try {
    return bugReport.logTail(await fs.promises.readFile(path.join(app.getPath('userData'), 'clipvault.log'), 'utf8'));
  } catch { return ''; }
}

// The report as the user typed it plus diagnostics, all redacted: { url, text }.
async function makeBugReport(input) {
  const i = input && typeof input === 'object' ? input : {};
  const diagnostics = i.diagnostics !== false;
  const what = String(i.what || '').slice(0, 20000);
  const steps = String(i.steps || '').slice(0, 20000);
  const [facts, log, opts] = await Promise.all([diagnostics ? bugFacts() : null, diagnostics ? bugLogTail() : '', redactOptions()]);
  return bugReport.buildReport({ what, steps, facts, log, diagnostics }, opts);
}

// ------------------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('app:state', () => snapshot());

  ipcMain.handle('settings:set', (_e, patch) => {
    const { changed, captureChanged } = settings.update(patch || {});
    if (changed.includes('hotkeys')) registerHotkeys();
    if (changed.includes('startWithWindows')) applyLoginItem();
    if (changed.includes('theme')) applyWindowTheme();
    if (changed.includes('checkUpdates') && settings.values.checkUpdates) updater.check();
    if (changed.includes('replaySeconds')) recorder.setReplaySeconds(settings.values.replaySeconds);
    if (changed.includes('league') && leagueMatch) {
      recorder.setMinimumKeep(leagueKeepSeconds());
      if (settings.values.league.trackInputs) inputs.start('League of Legends.exe');
      else inputs.stop();
    }
    if (changed.includes('saveDir')) library.emit('changed');
    if (changed.includes('storageLimitGB')) enforceStorageLimit();
    if (captureChanged) restartCaptureSoon();
    if (changed.includes('bufferMode')) {
      if (settings.values.bufferMode === 'always' && recorder.state === 'idle') startBuffer().catch(() => {});
      evaluateAutoBuffer();
    }
    broadcast();
    return settings.get();
  });

  ipcMain.handle('settings:resetHotkeys', () => {
    settings.update({ hotkeys: { ...DEFAULT_HOTKEYS } });
    registerHotkeys();
    return settings.get();
  });

  ipcMain.handle('hotkeys:suspend', (_e, on) => {
    hotkeysSuspended = Boolean(on);
    registerHotkeys();
  });

  ipcMain.handle('buffer:toggle', () => toggleBuffer());
  ipcMain.handle('clip:save', () => saveClip());
  ipcMain.handle('killcam:try', () => tryKillCam());
  ipcMain.on('killcam:done', () => hideKillCam());
  ipcMain.on('killcam:drag', (_e, d) => onKillCamDrag(d || {}));
  ipcMain.on('killcam:edit-done', () => endKillCamEdit());
  ipcMain.handle('killcam:move', () => {
    if (!killCamPlace()) throw new Error('The death cam is set to your other screen, and you have one screen');
    if (!killCamEditing) toggleKillCamEdit();
  });
  ipcMain.handle('killcam:reset-spot', () => {
    settings.update({ league: { killCamSpot: null } });
    if (killCamWindow && !killCamWindow.isDestroyed() && killCamWindow.isVisible()) {
      const place = killCamPlace({ big: killCamBig });
      if (place) killCamWindow.setBounds(killCamWindowBounds(place));
    }
    broadcast();
  });
  ipcMain.handle('recording:toggle', () => toggleRecording());

  ipcMain.handle('library:list', () => library.list());
  ipcMain.handle('matches:list', () => (matchStore ? matchStore.list() : []));
  ipcMain.handle('matches:get', (_e, key) => (matchStore && typeof key === 'string' ? matchStore.get(key) : null));
  // A match page asks for its match's history now instead of at the next 15-minute sweep (it comes
  // from the League client, so nothing happens while that's closed). At most once a minute, never
  // during a match.
  let lastMatchRefresh = 0;
  ipcMain.handle('matches:refresh', () => {
    if (Date.now() - lastMatchRefresh < 60000) return false;
    lastMatchRefresh = Date.now();
    sweepMatches();
    return true;
  });
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:open', () => {
    const r = updater.state().release;
    const url = r && safeReleaseUrl(r.url);
    if (url) shell.openExternal(url);
  });
  // Exactly what "Include diagnostics" adds, as the dialog shows it.
  ipcMain.handle('bug:diagnostics', async () => {
    const [facts, log, opts] = await Promise.all([bugFacts(), bugLogTail(), redactOptions()]);
    return { system: bugReport.redact(bugReport.systemLines(facts).join('\n'), opts), log: bugReport.redact(log, opts) };
  });
  // Opens the prefilled GitHub issue; the full report (with the log) goes to the clipboard.
  ipcMain.handle('bug:submit', async (_e, input) => {
    const { url, text } = await makeBugReport(input);
    clipboard.writeText(text);
    if (url.startsWith('https://github.com/')) await shell.openExternal(url);
    logLine('bug report opened on GitHub');
    return true;
  });
  ipcMain.handle('bug:save', async (_e, input) => {
    const { text } = await makeBugReport(input);
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Save bug report',
      defaultPath: path.join(app.getPath('desktop'), `ClipVault bug report ${stamp}.txt`),
      filters: [{ name: 'Text file', extensions: ['txt'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, text.replace(/\n/g, '\r\n'), 'utf8');
    return path.basename(r.filePath);
  });
  ipcMain.handle('app:showLog', () => shell.showItemInFolder(path.join(app.getPath('userData'), 'clipvault.log')));
  // Icons for a match's champions (its scoreboard): { name: file URL or null }, from the same disk
  // cache as the match cards' icons, fetched once when a champion isn't cached yet.
  ipcMain.handle('champions:icons', async (_e, names) => {
    const dir = path.join(app.getPath('userData'), 'champions');
    const wanted = [...new Set((Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n && n.length < 40))].slice(0, 20);
    const out = {};
    await Promise.all(wanted.map(async (name) => {
      const file = championIcons[name] || (await championIcon(name, dir));
      if (file) championIcons[name] = file;
      out[name] = file && fs.existsSync(file) ? pathToFileURL(file).href : null;
    }));
    return out;
  });
  // Item, summoner-spell and rune icons: ["item:3031", "spell:4", "rune:8010", ...] ->
  // { "item:3031": { url, name } or null }. Each icon is downloaded once into <userData>\icons.
  ipcMain.handle('icons:game', async (_e, keys) => {
    if (!gameIcons) gameIcons = new GameIcons(path.join(app.getPath('userData'), 'icons'));
    const wanted = [...new Set((Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && /^(item|spell|rune):\d{1,7}$/.test(k)))].slice(0, 200);
    const out = {};
    await Promise.all(wanted.map(async (k) => {
      const [kind, id] = k.split(':');
      const [file, name] = await Promise.all([gameIcons.icon(kind, Number(id)), gameIcons.name(kind, Number(id))]);
      out[k] = file ? { url: pathToFileURL(file).href, name } : null;
    }));
    return out;
  });
  ipcMain.handle('library:rename', (_e, file, name) => library.rename(file, name));
  ipcMain.handle('library:delete', (_e, file) => library.remove(file));
  ipcMain.handle('library:trim', (_e, file, start, end) => library.trim(file, start, end, chosenEncoder()));
  ipcMain.handle('library:copy', async (_e, file) => library.copyToClipboard(await realFile(file)));
  ipcMain.handle('library:inputs', (_e, file) => library.loadInputs(library.assertInside(file)));
  ipcMain.handle('library:filmstrip', async (_e, file) => {
    const strip = await library.filmstrip(library.assertInside(file));
    return strip ? pathToFileURL(strip).href : null;
  });
  ipcMain.handle('library:show', async (_e, file) => shell.showItemInFolder(await realFile(file)));
  ipcMain.handle('library:open', async (_e, file) => shell.openPath(await realFile(file)));
  // A favourite always has its own file. Resolves the path it ended up at.
  ipcMain.handle('library:favorite', async (_e, file, on) => {
    const target = on ? await realFile(file) : library.assertInside(file);
    library.setFavorite(target, on);
    return target;
  });
  // Makes a virtual clip a file now (e.g. before it's dragged out); resolves its path.
  ipcMain.handle('library:prepare', (_e, file) => realFile(file));
  ipcMain.handle('library:deleteMany', async (_e, files) => {
    let done = 0;
    // Clips before recordings: a full recording first saves its best virtual clips as files, which
    // would be wasted on clips deleted in the same go.
    const isRec = (f) => ((library.meta(f) || {}).type === 'recording' ? 1 : 0);
    const order = [...(files || [])].sort((a, b) => isRec(a) - isRec(b));
    for (const f of order) {
      try { await library.remove(f); done++; } catch { /* in use: skip it */ }
    }
    return done;
  });
  ipcMain.handle('edit:highlights', (_e, mapFile, opts) => makeHighlightVideo(mapFile, { includeDeaths: Boolean(opts && opts.includeDeaths) }));
  ipcMain.handle('edit:merge', (_e, files) => mergeVideos(files));
  ipcMain.handle('edit:share', (_e, file, targetMB, audioTrack) => shareVideo(file, targetMB, audioTrack));
  // Free up space: what virtualizing existing matches would remove (read-only), then doing it.
  ipcMain.handle('virtual:preview', () => {
    if (!virtualClips) throw new Error('Match records are off');
    if (leagueGameRunning()) throw new Error('Not while a game is running');
    return virtualClips.preview();
  });
  ipcMain.handle('virtual:free', async (_e, token) => {
    if (!virtualClips) throw new Error('Match records are off');
    const res = await virtualClips.freeUpSpace(token);
    logLine(`free up space: ${res.clips} highlight file(s) to the Recycle Bin (${fmtBytes(res.bytes)})${res.stopped ? `, stopped: ${res.stopped}` : ''}`);
    return res;
  });
  ipcMain.on('library:drag', (e, file) => {
    try {
      const safe = library.assertInside(file);
      if (library.isVirtual(safe)) {
        // A drag needs a real file at once: make it now, and the next drag works.
        realFile(safe).then(() => toast('Ready. Drag the clip again', 'info'))
          .catch((err) => toast(`Couldn't get the clip ready: ${err.message}`, 'error'));
        return;
      }
      const thumb = library.thumbnailFor(safe);
      const img = thumb ? nativeImage.createFromPath(thumb).resize({ width: 160 }) : appImage(64);
      e.sender.startDrag({ file: safe, icon: img });
    } catch { /* ignore */ }
  });

  ipcMain.handle('folder:open', () => openSaveDir());
  ipcMain.handle('folder:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose where ClipVault saves videos',
      defaultPath: settings.values.saveDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
}

// ------------------------------------------------------------------- lifecycle

async function init() {
  logLine('started', process.argv.slice(1).join(' '));
  app.on('will-quit', () => logLine('exiting'));
  app.on('render-process-gone', (_e, _wc, details) => logLine('a window process stopped:', details.reason));
  app.on('child-process-gone', (_e, details) => logLine('a helper process stopped:', details.type, details.reason));
  app.setAppUserModelId('com.clipvault.app');
  Menu.setApplicationMenu(null);
  // ClipVault is dark-only: the tray menu, native <select> popups, tooltips and scrollbars follow.
  nativeTheme.themeSource = 'dark';

  const videosDir = dataDir ? path.join(dataDir, 'Videos') : app.getPath('videos');
  settings = new Settings(app.getPath('userData'), videosDir);
  library = new Library(app.getPath('userData'), () => settings.values.saveDir, (p) => shell.trashItem(p), {
    iconFor: (name) => championIcons[name] || null,
    log: (msg) => logLine('library:', msg),
  });
  // League match records. --league-dir=<folder> (a fake League install: lockfile, Logs\GameLogs)
  // and --lcu-api=<url> point them at test/lcu-mock.js for testing.
  try {
    matchStore = new MatchStore(app.getPath('userData'), { log: (msg) => logLine('matches:', msg) });
    const dirFlag = flag('league-dir');
    const lcuFlag = flag('lcu-api');
    const leagueDir = typeof dirFlag === 'string' ? path.resolve(dirFlag) : null;
    const client = createClient({ installDir: leagueDir || undefined, baseUrl: typeof lcuFlag === 'string' ? lcuFlag : undefined });
    const installDir = () => {
      if (leagueDir) return leagueDir;
      try { return leagueInstallDir(); } catch { return null; }
    };
    matchCapture = new MatchCapture({ store: matchStore, client, installDir, log: (msg) => logLine('matches:', msg) });
    library.useMatches(matchStore, { log: (msg) => logLine('library:', msg) });
    matchStore.on('changed', (change) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('matches:changed', change));
    // One record per match: merges the duplicates a mid-match restart used to leave (does nothing
    // once there are none), then records for the matches recorded before there were any.
    const store = matchStore;
    repairMatches(store, { log: (msg) => logLine('matches: repair:', msg) })
      .catch((err) => logLine('match repair:', err.message))
      .then(() => migrateLibrary({ library, store, installDir, log: (msg) => logLine('matches:', msg) }))
      .catch((err) => logLine('match backfill:', err.message));
  } catch (err) {
    logLine('match records are off:', err.message);
    matchStore = null;
    matchCapture = null;
  }
  virtualClips = new VirtualClips({
    library, store: matchStore, edit, gameRunning: leagueGameRunning,
    keepFiles: () => settings.values.keepHighlightFiles, log: (msg) => logLine(msg),
  });
  recorder = new Recorder();
  fg = new ForegroundWatcher(process.pid);

  recorder.on('status', broadcast);
  recorder.on('warning', (msg) => toast(msg, 'warn'));
  recorder.on('log', (msg) => {
    if (flag('verbose')) console.log(msg);
    if (/^(capture start failed|restarting capture|capture falling behind)/.test(msg)) logLine(msg); // why capture stopped or didn't start
  });
  recorder.on('crashed', (msg) => { logLine('capture stopped unexpectedly:', msg); onCaptureCrashed(msg); });
  // Sleep leaves Desktop Duplication frozen; start capture afresh instead of waiting for the watchdog.
  powerMonitor.on('resume', () => recorder.restartCapture('the PC woke from sleep'));
  library.on('changed', () => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('library:changed'));
  fg.on('change', (info) => {
    // Keys let go while another window was in front never reach the key stream.
    if (!/^league of legends\.exe$/i.test(info.exe || '')) hotkeyMatcher.reset();
    if (/^league of legends\.exe$/i.test(info.exe)) league.poke(); // notice the match right away
    const exe = gameSoundExe(info);
    if (exe && exe.toLowerCase() !== soundExe.toLowerCase()) {
      soundExe = exe;
      logLine('game sound now from', exe);
      const s = settings.values;
      if (s.systemAudio && s.audioScope === 'game') restartCaptureSoon(); // record this game's sound from now on
    }
    evaluateAutoBuffer();
    broadcast();
  });
  const leagueApi = flag('league-api'); // testing: point at test/league-mock.js
  league = new LeagueWatcher({ baseUrl: typeof leagueApi === 'string' ? leagueApi : undefined, getOptions: () => settings.values.league });
  // Who we matched you as, the raw game events and what was clipped: one file per match in
  // league-logs\ (the newest 20 are kept), and league-last-match.log as a copy of the latest.
  const leagueLog = path.join(app.getPath('userData'), 'league-last-match.log');
  const leagueLogDir = path.join(app.getPath('userData'), 'league-logs');
  const adopted = adoptLastLog(leagueLog, leagueLogDir);
  if (adopted) logLine('kept the previous match log as', path.basename(adopted));
  let matchLog = null;
  const logLeague = (type, data) => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`;
    try { fs.appendFileSync(leagueLog, line); } catch { /* ignore */ }
    if (matchLog) { try { fs.appendFileSync(matchLog, line); } catch { /* ignore */ } }
  };
  league.on('match-start', (e) => {
    for (const n of e.names || []) playerNames.add(n);
    try { fs.writeFileSync(leagueLog, ''); } catch { /* ignore */ }
    matchLog = startMatchLog(leagueLogDir);
    logLeague('match-start', e);
  });
  league.on('raw', (e) => logLeague('event', e));
  league.on('moment', (m) => logLeague('moment', { label: m.label, kind: m.kind }));
  league.on('highlight', (h) => logLeague('highlight', { title: h.title, seconds: Math.round((h.toMs - h.fromMs) / 1000) }));
  league.on('match-end', (e) => logLeague('match-end', { result: e.result }));
  league.on('match-start', (e) => { onLeagueMatchStart(e).finally(() => startMatchRecord(e)); });
  league.on('highlight', (h) => {
    const job = saveHighlight(h);
    if (leagueMatch) leagueMatch.saves.push(job);
  });
  league.on('match-end', (e) => { onLeagueMatchEnd(e); });
  killCam = new KillCam({
    dir: path.join(app.getPath('userData'), 'killcam'), // this profile's own (a test instance never touches yours)
    save: (fromMs, toMs, file) => recorder.saveRange(fromMs, toMs, file),
    show: showKillCam,
    getOptions: () => ({
      enabled: settings.values.league.killCam && recorder.state === 'running' && Boolean(killCamPlace()),
      before: settings.values.league.killCamBefore,
      delay: settings.values.league.killCamDelay,
      kinds: CAM_KINDS.filter((k) => settings.values.league[`killCam${k[0].toUpperCase()}${k.slice(1)}`]),
    }),
    log: logLine,
  });
  killCam.prune(null, 0); // last session's cams
  league.on('moment', (m) => killCam.onMoment(m));
  league.on('match-start', () => killCam.reset()); // a run of kills doesn't carry into a new match
  screen.on('display-added', broadcast);
  screen.on('display-removed', broadcast);

  updater = new UpdateChecker({
    current: app.getVersion(),
    fetchJson,
    enabled: () => settings.values.checkUpdates,
    log: logLine,
  });
  updater.on('change', broadcast);
  updater.on('available', (r) => { logLine('update available:', r.version); announceUpdate(r); });
  // Test runs (--data-dir) only check when asked (Settings → About → Check now).
  if (!dataDir) updater.start();
  registerIpc();
  // Older matches: once soon after start, then every 15 minutes (cheap when nothing is missing).
  setTimeout(sweepMatches, 30 * 1000);
  setInterval(sweepMatches, 15 * 60 * 1000);
  if (!flag('no-tray')) createTray(); // test runs (--no-tray) don't add a second tray icon
  createOverlay();
  const hidden = flag('hidden') || (settings.values.startMinimized && !flag('screenshot'));
  createMainWindow(!hidden && !flag('screenshot'));

  ffmpegOk = await ffmpegAvailable();
  if (!ffmpegOk) {
    lastError = app.isPackaged
      ? 'FFmpeg is missing from the ClipVault install. Reinstall ClipVault (your clips and settings are kept)'
      : 'FFmpeg was not found. Open a terminal in the ClipVault folder and run: npm run setup';
    broadcast();
    return;
  }
  encoders = await detectEncoders();
  registerHotkeys();
  fetchChampionIcons(library.champions());
  if (fs.existsSync(paths.helper)) fg.start();
  // Demo / test windows (--no-capture) must never react to a real match.
  if (!flag('no-capture')) league.start();
  if (settings.values.startWithWindows) applyLoginItem();
  if (settings.values.bufferMode === 'always' && !flag('no-capture')) startBuffer().catch(() => {});
  broadcast();
}

const CONTROL_FLAGS = ['--save-clip', '--toggle-recording', '--toggle-buffer', '--bookmark', '--quit'];

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else if (process.argv.some((a) => CONTROL_FLAGS.includes(a))) {
  // A control command with no ClipVault running: nothing to control, so don't start one.
  console.log('ClipVault is not running.');
  app.exit(0);
} else {
  // Launching ClipVault again with --save-clip / --toggle-recording / --toggle-buffer
  // controls the running instance (handy for Stream Deck or macro keys).
  app.on('second-instance', (_e, argv) => {
    if (!settings) return;
    if (argv.includes('--save-clip')) saveClip();
    else if (argv.includes('--toggle-recording')) toggleRecording();
    else if (argv.includes('--toggle-buffer')) toggleBuffer();
    else if (argv.includes('--bookmark')) bookmark();
    else if (argv.includes('--quit')) { logLine('quit requested from the command line'); app.quit(); }
    else showWindow();
  });
  app.whenReady().then(init);

  // Keep running in the tray when windows close.
  app.on('window-all-closed', () => {});

  // Finish any recording and stop FFmpeg cleanly before exiting.
  let shuttingDown = false;
  app.on('before-quit', (e) => {
    quitting = true;
    if (cleanupDone || !recorder) return;
    e.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    (async () => {
      clearTimeout(recoverTimer); // a pending capture restart must not start FFmpeg while quitting
      globalShortcut.unregisterAll();
      league.stop();
      inputs.stop();
      hotkeyKeys.stop();
      try { await finishMinimap(leagueMatch); } catch { /* ignore */ }
      try { await stopBuffer(); } catch { /* ignore */ }
      fg.stop();
      cleanupDone = true;
      app.quit();
    })();
  });
}
