// Persistent user settings (JSON in the app's userData folder).
const fs = require('fs');
const path = require('path');

const DEFAULT_HOTKEYS = {
  saveClip: 'Alt+F10',
  toggleRecording: 'Alt+F9',
  toggleBuffer: 'Alt+F8',
  bookmark: 'Alt+F7',
  // The death cam's: three-modifier keys League never uses (shown under the cam).
  camBig: 'Ctrl+Shift+Alt+F',
  camReplay: 'Ctrl+Shift+Alt+R',
  camClose: 'Ctrl+Shift+Alt+X',
  camMove: 'Ctrl+Shift+Alt+M',
};

function defaults(videosDir) {
  return {
    saveDir: path.join(videosDir, 'ClipVault'),
    replaySeconds: 30,
    bufferMode: 'always', // always | games | manual
    fps: 60,
    resolution: 'native', // native | 1440 | 1080 | 720
    quality: 'high', // low | medium | high | ultra
    encoder: 'auto', // auto | nvenc | amf | qsv | x264
    videoCodec: 'h264', // h264 | hevc (about half the size; needs a GPU encoder)
    monitor: 0,
    drawMouse: true,
    systemAudio: true,
    audioScope: 'game', // game = only the game you're playing | everything = all you hear
    systemVolume: 100,
    mic: false,
    micVolume: 100,
    micMode: 'always', // always | ptt (push-to-talk)
    pttKey: 'V', // key name like the hotkey fields use, or Mouse4 / Mouse5 / MouseMiddle
    pttReleaseMs: 300, // keep the mic open this long after the key is released
    discordAudio: false, // record Discord voice (its own track when tracks are separate)
    discordVolume: 100,
    separateTracks: false, // extra Game / Microphone / Discord tracks next to the mixed one
    storageLimitGB: 0, // 0 = no limit; otherwise the oldest non-favourite videos go to the Recycle Bin
    // With a full match recording, also keep each highlight as its own file (off: once the full
    // recording is verified, highlights play as ranges of it and their files go to the Recycle Bin)
    keepHighlightFiles: true,
    hotkeys: { ...DEFAULT_HOTKEYS },
    startWithWindows: false,
    theme: 'gray', // the app's colours: 'gray' | 'midnight' (navy) | 'light'
    startMinimized: false,
    clipSound: true,
    overlay: true,
    notifyMonitor: -1, // screen for on-screen notifications; -1 = the captured screen
    checkUpdates: true, // ask GitHub Releases for a newer version on start and once a day (update.js)
    updateNotified: '', // the newest version a notification was shown for (one toast per version)
    // League of Legends auto clips (key moments read from Riot's Live Client Data API)
    league: { ...LEAGUE_DEFAULTS },
  };
}

const LEAGUE_DEFAULTS = {
  enabled: true,
  kills: true, // kills, multikills, first blood, aces
  deaths: true,
  assists: true,
  objectives: true, // dragon, baron, herald, voidgrubs, atakhan you took part in
  structures: false, // turrets and inhibitors
  gameEnd: true, // victory / defeat
  bookmarks: true, // bookmark hotkey presses become clips
  before: 15, // seconds kept before a moment
  after: 5, // seconds kept after it
  mergeGap: 20, // moments closer than this many seconds share one clip (teamfights stay together)
  openReel: true, // show the match reel when a match ends
  recordMatch: false, // also record the whole match, with key moments marked
  recordMap: true, // when the whole match isn't recorded, record just the minimap (a guide next to clips)
  trackInputs: false, // record key / mouse presses during matches (never chat)
  killCam: true, // death cam: replay your deaths in a small window (killcam.js)
  killCamDeaths: true, // which moments it plays for: deaths by default...
  killCamKills: false, // ...and optionally kills (multikills, first blood, aces),
  killCamAssists: false, // assists
  killCamObjectives: false, // and objectives
  killCamBefore: 8, // seconds of the cam before the moment
  killCamDelay: 2, // seconds after the moment before it plays (moments in that time join it)
  killCamZoom: 1, // 1 = off; 1.25 / 1.5 / 2 zoom into the middle of the picture, where your champion is
  killCamSize: 'medium', // 'small' | 'medium' | 'large' | 'huge' (CAM_SIZES in killcam.js)
  killCamSpot: null, // where you dragged it: { display, x, y, w } as shares of that screen; null = size + corner
  killCamScreen: 'auto', // 'auto' (another screen if there is one, else the game's) | 'other' | 'game'
  killCamCorner: 'auto', // 'auto' (top-left over the game, bottom-right elsewhere) | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
};

// Settings that change the FFmpeg command line; changing them restarts capture.
const CAPTURE_KEYS = ['saveDir', 'fps', 'resolution', 'quality', 'encoder', 'videoCodec', 'monitor', 'drawMouse',
  'systemAudio', 'audioScope', 'systemVolume', 'mic', 'micVolume', 'micMode', 'pttKey', 'pttReleaseMs',
  'discordAudio', 'discordVolume', 'separateTracks'];

class Settings {
  constructor(userDataDir, videosDir) {
    this.file = path.join(userDataDir, 'settings.json');
    this.defaults = defaults(videosDir);
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.values = this._sanitize({
      ...this.defaults,
      ...stored,
      hotkeys: { ...DEFAULT_HOTKEYS, ...(stored.hotkeys || {}) },
      league: { ...LEAGUE_DEFAULTS, ...(stored.league || {}) },
    });
  }

  get() {
    return JSON.parse(JSON.stringify(this.values));
  }

  update(patch) {
    const before = this.values;
    const next = this._sanitize({
      ...before,
      ...patch,
      hotkeys: { ...before.hotkeys, ...(patch.hotkeys || {}) },
      league: { ...before.league, ...(patch.league || {}) },
    });
    this.values = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    return { changed, captureChanged: changed.some((k) => CAPTURE_KEYS.includes(k)) };
  }

  _sanitize(v) {
    const clamp = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : d);
    const oneOf = (x, list, d) => (list.includes(x) ? x : d);
    const d = this.defaults;
    const L = { ...LEAGUE_DEFAULTS, ...(v.league || {}) };
    const league = {};
    for (const [k, def] of Object.entries(LEAGUE_DEFAULTS)) league[k] = typeof def === 'boolean' ? Boolean(L[k]) : L[k];
    league.before = clamp(L.before, 3, 60, LEAGUE_DEFAULTS.before);
    league.after = clamp(L.after, 1, 30, LEAGUE_DEFAULTS.after);
    league.mergeGap = clamp(L.mergeGap, 5, 60, LEAGUE_DEFAULTS.mergeGap);
    league.killCamBefore = clamp(L.killCamBefore, 3, 20, LEAGUE_DEFAULTS.killCamBefore);
    league.killCamDelay = clamp(L.killCamDelay, 1, 10, LEAGUE_DEFAULTS.killCamDelay);
    league.killCamZoom = [1, 1.25, 1.5, 2].includes(Number(L.killCamZoom)) ? Number(L.killCamZoom) : LEAGUE_DEFAULTS.killCamZoom;
    league.killCamSize = oneOf(L.killCamSize, ['small', 'medium', 'large', 'huge'], LEAGUE_DEFAULTS.killCamSize);
    const spot = L.killCamSpot;
    const share = (n) => Number.isFinite(n) && n >= 0 && n <= 1;
    league.killCamSpot = spot && Number.isInteger(spot.display) && share(spot.x) && share(spot.y) && share(spot.w) && spot.w > 0.05
      ? { display: spot.display, x: spot.x, y: spot.y, w: spot.w } : null;
    league.killCamScreen = oneOf(L.killCamScreen, ['auto', 'other', 'game'], LEAGUE_DEFAULTS.killCamScreen);
    league.killCamCorner = oneOf(L.killCamCorner, ['auto', 'top-left', 'top-right', 'bottom-left', 'bottom-right'], LEAGUE_DEFAULTS.killCamCorner);
    return {
      ...v,
      saveDir: typeof v.saveDir === 'string' && v.saveDir.trim() ? v.saveDir : d.saveDir,
      replaySeconds: clamp(v.replaySeconds, 5, 600, d.replaySeconds),
      bufferMode: oneOf(v.bufferMode, ['always', 'games', 'manual'], d.bufferMode),
      fps: oneOf(Number(v.fps), [30, 60, 120, 144], d.fps),
      resolution: oneOf(String(v.resolution), ['native', '1440', '1080', '720'], d.resolution),
      quality: oneOf(v.quality, ['low', 'medium', 'high', 'ultra'], d.quality),
      encoder: oneOf(v.encoder, ['auto', 'nvenc', 'amf', 'qsv', 'x264'], d.encoder),
      videoCodec: oneOf(v.videoCodec, ['h264', 'hevc'], d.videoCodec),
      // 'all' (the old default, everything) and 'league' became 'game' when only the game's sound became the default
      audioScope: oneOf({ all: 'game', league: 'game' }[v.audioScope] || v.audioScope, ['game', 'everything'], d.audioScope),
      micMode: oneOf(v.micMode, ['always', 'ptt'], d.micMode),
      pttKey: typeof v.pttKey === 'string' && v.pttKey.trim() ? v.pttKey.trim() : d.pttKey,
      pttReleaseMs: clamp(v.pttReleaseMs, 0, 2000, d.pttReleaseMs),
      discordVolume: clamp(v.discordVolume, 0, 200, 100),
      storageLimitGB: clamp(v.storageLimitGB, 0, 100000, 0),
      keepHighlightFiles: v.keepHighlightFiles !== false, // only an explicit "off" virtualizes
      discordAudio: Boolean(v.discordAudio),
      separateTracks: Boolean(v.separateTracks),
      monitor: clamp(v.monitor, 0, 15, 0),
      notifyMonitor: clamp(v.notifyMonitor, -1, 15, -1),
      systemVolume: clamp(v.systemVolume, 0, 200, 100),
      micVolume: clamp(v.micVolume, 0, 200, 100),
      drawMouse: Boolean(v.drawMouse),
      systemAudio: Boolean(v.systemAudio),
      mic: Boolean(v.mic),
      startWithWindows: Boolean(v.startWithWindows),
      theme: oneOf(v.theme, ['gray', 'midnight', 'light'], 'gray'),
      startMinimized: Boolean(v.startMinimized),
      clipSound: Boolean(v.clipSound),
      overlay: Boolean(v.overlay),
      checkUpdates: v.checkUpdates !== false,
      updateNotified: typeof v.updateNotified === 'string' ? v.updateNotified.slice(0, 40) : '',
      league,
    };
  }
}

module.exports = { Settings, DEFAULT_HOTKEYS };
