// First-run setup (views/onboarding.js): what each choice means in real settings (src/settings.js).
// Pure functions, so test/onboarding-test.js can check them without a window.

// Bump this to show the setup once more to everyone (settings.onboarded is the last version seen).
export const ONBOARDING_VERSION = 1;

export const needsOnboarding = (settings) => !settings || !(Number(settings.onboarded) >= ONBOARDING_VERSION);

// Video quality presets: each sets Settings → Recording → Resolution, Frame rate and Quality.
// The quality names are FFmpeg constant-quality levels (ffmpeg.js QUALITY); there is no bitrate.
export const QUALITY_PRESETS = [
  {
    id: 'small',
    label: 'Smaller files',
    values: { resolution: '1080', fps: 30, quality: 'medium' },
    spec: '1080p · 30 fps · Medium',
    note: 'Roughly half the size of Balanced, or less on a 1440p or 4K screen. Scaling the picture down uses a little CPU.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    recommended: true,
    values: { resolution: 'native', fps: 60, quality: 'high' },
    spec: 'Your screen\'s resolution · 60 fps · High',
    note: 'Sharp and smooth. The picture never leaves your graphics card, so games barely notice.',
  },
  {
    id: 'best',
    label: 'Best',
    values: { resolution: 'native', fps: 60, quality: 'ultra' },
    spec: 'Your screen\'s resolution · 60 fps · Ultra',
    note: 'For editing and uploads. Files are roughly twice the size of Balanced; the graphics card works a little harder.',
  },
];

// The preset the settings match, or 'custom' (then the setup leaves them as they are).
export function presetOf(s) {
  const p = QUALITY_PRESETS.find((x) => String(x.values.resolution) === String(s.resolution)
    && Number(x.values.fps) === Number(s.fps) && x.values.quality === s.quality);
  return p ? p.id : 'custom';
}

// Settings → Recording → Replay buffer, in plain words.
export const BUFFER_MODES = [
  { id: 'always', label: 'Always ready', recommended: true, note: 'Keeps the last {len} ready the whole time ClipVault runs, so any moment can be saved.' },
  { id: 'games', label: 'While I\'m playing', note: 'Turns on when a fullscreen game starts and off a couple of minutes after it closes.' },
  { id: 'manual', label: 'Only when I turn it on', note: 'Press {key} or use the tray icon. League matches still get their highlights and death cam.' },
];

export const REPLAY_LENGTHS = [15, 30, 60, 120];
export const STORAGE_LIMITS = [0, 50, 100, 200, 500];

export const CAM_SIZES = [['small', 'Small', 0.2], ['medium', 'Medium', 0.26], ['large', 'Large', 0.34], ['huge', 'Extra large', 0.42]];
export const CAM_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

// Where the death cam would actually play, for the preview: 'game' or 'other' screen, and its corner.
// Mirrors killcam.js: Automatic is another screen when there is one; the automatic corner is the top
// left over the game (League's HUD is empty there) and the bottom right on another screen.
export function camPlacement(c, screens) {
  const screen = c.killCamScreen === 'game' || (c.killCamScreen === 'auto' && screens < 2) ? 'game' : 'other';
  const corner = c.killCamCorner !== 'auto' ? c.killCamCorner : screen === 'game' ? 'top-left' : 'bottom-right';
  return { screen, corner, off: c.killCamScreen === 'other' && screens < 2 };
}

// The choices the setup starts from: the current settings (the defaults on a first run).
export function initialChoices(s) {
  const L = s.league || {};
  return {
    killCam: Boolean(L.killCam),
    killCamDeaths: Boolean(L.killCamDeaths),
    killCamKills: Boolean(L.killCamKills),
    killCamAssists: Boolean(L.killCamAssists),
    killCamObjectives: Boolean(L.killCamObjectives),
    killCamScreen: L.killCamScreen || 'auto',
    killCamCorner: L.killCamCorner || 'auto',
    killCamSize: L.killCamSize || 'medium',
    bufferMode: s.bufferMode || 'always',
    replaySeconds: Number(s.replaySeconds) || 30,
    leagueClips: L.enabled !== false,
    recordMatch: Boolean(L.recordMatch),
    mic: Boolean(s.mic),
    overlay: s.overlay !== false,
    notifyInGame: s.notifyInGame !== false,
    notifyMonitor: Number.isInteger(s.notifyMonitor) ? s.notifyMonitor : -1,
    clipSound: s.clipSound !== false,
    saveDir: s.saveDir || '',
    storageLimitGB: Number(s.storageLimitGB) || 0,
    quality: presetOf(s),
    startWithWindows: Boolean(s.startWithWindows),
  };
}

// The settings patch for Finish (settings:set). Everything the setup shows is written, so what you
// saw is what you get; unchanged values don't restart anything (Settings.update compares them).
export function choicesToPatch(c, s) {
  const L = s.league || {};
  const league = {
    killCam: Boolean(c.killCam),
    killCamDeaths: Boolean(c.killCamDeaths),
    killCamKills: Boolean(c.killCamKills),
    killCamAssists: Boolean(c.killCamAssists),
    killCamObjectives: Boolean(c.killCamObjectives),
    killCamScreen: c.killCamScreen,
    killCamCorner: c.killCamCorner,
    killCamSize: c.killCamSize,
    enabled: Boolean(c.leagueClips),
    recordMatch: Boolean(c.recordMatch),
  };
  // A spot the cam was dragged to wins over size and corner, so picking new ones clears it.
  if (L.killCamSpot && (c.killCamCorner !== L.killCamCorner || c.killCamSize !== L.killCamSize || c.killCamScreen !== L.killCamScreen)) {
    league.killCamSpot = null;
  }
  const patch = {
    league,
    bufferMode: c.bufferMode,
    replaySeconds: Number(c.replaySeconds),
    mic: Boolean(c.mic),
    overlay: Boolean(c.overlay),
    notifyInGame: Boolean(c.notifyInGame),
    notifyMonitor: Number(c.notifyMonitor),
    clipSound: Boolean(c.clipSound),
    storageLimitGB: Number(c.storageLimitGB),
    startWithWindows: Boolean(c.startWithWindows),
    onboarded: ONBOARDING_VERSION,
  };
  if (c.saveDir && c.saveDir !== s.saveDir) patch.saveDir = c.saveDir;
  const preset = QUALITY_PRESETS.find((p) => p.id === c.quality);
  if (preset) Object.assign(patch, preset.values);
  return patch;
}

// The death cam can only play when League moments are read: auto clips or a full match recording.
export const camNeedsClips = (c) => Boolean(c.killCam) && !c.leagueClips && !c.recordMatch;

export function fmtLength(sec) {
  return sec < 60 ? `${sec} s` : sec % 60 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${sec / 60} min`;
}
