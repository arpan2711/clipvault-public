// Watches the foreground window (via cvhelper) to name clips after the game being played
// and to auto-start the replay buffer when a fullscreen game appears.
const EventEmitter = require('events');
const readline = require('readline');
const { spawn } = require('child_process');
const { paths } = require('./ffmpeg');

// Windows shell surfaces that should never count as "the game".
const SHELL_EXES = new Set([
  'explorer.exe', 'searchhost.exe', 'searchapp.exe', 'startmenuexperiencehost.exe',
  'shellexperiencehost.exe', 'lockapp.exe', 'textinputhost.exe', 'applicationframehost.exe',
  'taskmgr.exe', 'systemsettings.exe', 'shellhost.exe',
]);

// Fullscreen apps that aren't games: their sound is never taken as "the game's".
const NOT_GAMES = new Set([
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'opera_gx.exe', 'vivaldi.exe',
  'vlc.exe', 'mpc-hc64.exe', 'mpc-be64.exe', 'potplayermini64.exe', 'wmplayer.exe', 'video.ui.exe',
  'microsoft.media.player.exe', 'discord.exe', 'spotify.exe', 'obs64.exe', 'steamwebhelper.exe',
  'electron.exe', 'code.exe', 'powerpnt.exe',
]);

// The program whose sound "the game you're playing" records, for a foreground window: the
// fullscreen game in front, or null when that isn't a game.
function gameSoundExe(info) {
  if (!info || !info.isGame || !info.exe) return null;
  return NOT_GAMES.has(info.exe.toLowerCase()) ? null : info.exe;
}

function sanitizeName(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60);
}

// Games whose executable description isn't a nice folder name.
const ALIASES = {
  'league of legends.exe': 'League of Legends',
  'valorant-win64-shipping.exe': 'VALORANT',
  'cs2.exe': 'Counter-Strike 2',
};

function friendlyName(info) {
  const alias = ALIASES[(info.exe || '').toLowerCase()];
  if (alias) return alias;
  let name = (info.name || '').replace(/\s*(\(TM\)|™|®|\(R\))\s*/gi, ' ').trim();
  if (!name || /^(game|client|launcher|ue4|ue5|unreal engine)$/i.test(name)) name = (info.title || '').trim();
  if (!name) name = (info.exe || '').replace(/\.exe$/i, '').replace(/-Win64-Shipping$/i, '');
  return sanitizeName(name) || 'Desktop';
}

class ForegroundWatcher extends EventEmitter {
  constructor(ownPid) {
    super();
    this.ownPid = ownPid;
    this.current = null;
    this.lastApp = null; // most recent foreground app that wasn't the shell or ClipVault
    this.proc = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    let proc;
    try {
      proc = spawn(paths.helper, ['fg'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return;
    }
    this.proc = proc;
    proc.stdin.on('error', () => {});
    proc.on('error', () => {});
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let info;
      try { info = JSON.parse(line); } catch { return; }
      if (!info.exe) return;
      info.isShell = SHELL_EXES.has(info.exe.toLowerCase());
      info.isSelf = info.pid === this.ownPid;
      info.displayName = friendlyName(info);
      info.isGame = info.fullscreen && !info.isShell && !info.isSelf;
      this.current = info;
      if (!info.isShell && !info.isSelf) this.lastApp = { ...info, seenAt: Date.now() };
      this.emit('change', info);
    });
    proc.on('close', () => {
      if (this.proc === proc) this.proc = null;
      if (!this.stopped) setTimeout(() => this.start(), 3000);
    });
  }

  stop() {
    this.stopped = true;
    if (this.proc) {
      try { this.proc.stdin.end(); this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
  }

  // Name to file a clip under: the app in front, or (if the user is in ClipVault or on
  // the desktop) whatever they were in during the last ten minutes.
  gameName() {
    const c = this.current;
    if (c && !c.isShell && !c.isSelf) return c.displayName;
    if (this.lastApp && Date.now() - this.lastApp.seenAt < 10 * 60 * 1000) return this.lastApp.displayName;
    return 'Desktop';
  }
}

module.exports = { ForegroundWatcher, sanitizeName, gameSoundExe };
