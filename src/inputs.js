// Keyboard and mouse tracking during matches, so clips can show what you pressed.
//
// cvhelper reads Windows Raw Input: it only listens (like Discord push-to-talk or OBS input
// overlays) and never blocks or sends input. Only presses made while the game window is in
// front are reported, and League chat is skipped so messages you type are never stored.
const EventEmitter = require('events');
const readline = require('readline');
const { spawn } = require('child_process');
const { paths } = require('./ffmpeg');

// Names match the key ids of the keyboard drawn in the player (renderer/keyboard.js).
const VK_NAMES = {
  0x08: 'Backspace', 0x09: 'Tab', 0x0D: 'Enter', 0x10: 'LShift', 0x11: 'LCtrl', 0x12: 'LAlt', 0x13: 'Pause', 0x14: 'Caps',
  0x1B: 'Esc', 0x20: 'Space', 0x21: 'PageUp', 0x22: 'PageDown', 0x23: 'End', 0x24: 'Home',
  0x25: 'Left', 0x26: 'Up', 0x27: 'Right', 0x28: 'Down', 0x2C: 'PrtSc', 0x2D: 'Insert', 0x2E: 'Delete',
  0x5B: 'LWin', 0x5C: 'RWin', 0x5D: 'Menu', 0x90: 'NumLock', 0x91: 'ScrollLock',
  0xA0: 'LShift', 0xA1: 'RShift', 0xA2: 'LCtrl', 0xA3: 'RCtrl', 0xA4: 'LAlt', 0xA5: 'RAlt',
  0xBA: ';', 0xBB: '=', 0xBC: ',', 0xBD: '-', 0xBE: '.', 0xBF: '/', 0xC0: '`', 0xDB: '[', 0xDC: '\\', 0xDD: ']', 0xDE: "'",
};

function keyName(vk) {
  if ((vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5A)) return String.fromCharCode(vk);
  if (vk >= 0x60 && vk <= 0x69) return `Num${vk - 0x60}`;
  if (vk >= 0x70 && vk <= 0x87) return `F${vk - 0x6F}`;
  return VK_NAMES[vk] || `Key${vk}`;
}

// The other way round, for the push-to-talk key: a key name (as keyName gives it) or a mouse
// button -> Windows virtual-key code, or 0 when unknown.
const MOUSE_VK = { mouse1: 0x01, mouse2: 0x02, mousemiddle: 0x04, mouse3: 0x04, mouse4: 0x05, mouse5: 0x06 };
const GENERIC_VK = { shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12, capslock: 0x14, esc: 0x1B, escape: 0x1B };
function vkFor(name) {
  const n = String(name || '').trim();
  if (!n) return 0;
  if (MOUSE_VK[n.toLowerCase()]) return MOUSE_VK[n.toLowerCase()];
  if (GENERIC_VK[n.toLowerCase()]) return GENERIC_VK[n.toLowerCase()]; // either side
  for (let vk = 1; vk < 0xFF; vk++) {
    // first match wins, so "LShift" maps to 0xA0 (left shift) rather than the generic 0x10
    if (vk === 0x10 || vk === 0x11 || vk === 0x12) continue;
    if (keyName(vk).toLowerCase() === n.toLowerCase()) return vk;
  }
  return 0;
}

// Hotkeys seen in cvhelper's key stream. League turns off other apps' registered hotkeys
// (globalShortcut) while it's in front, but Raw Input still sees the keys, so during a match
// ClipVault matches its own hotkeys here too. Accelerators are Electron's ("Ctrl+Shift+Alt+F").
const MOD_NAMES = {
  ctrl: 'ctrl', control: 'ctrl', commandorcontrol: 'ctrl', cmdorctrl: 'ctrl',
  shift: 'shift', alt: 'alt', option: 'alt', altgr: 'alt', super: 'win', meta: 'win', win: 'win',
};
const KEY_ALIASES = { return: 'Enter', escape: 'Esc', plus: '=', space: 'Space', capslock: 'Caps', printscreen: 'PrtSc', del: 'Delete', ins: 'Insert' };
const MOD_OF_VK = { 0x10: 'shift', 0xA0: 'shift', 0xA1: 'shift', 0x11: 'ctrl', 0xA2: 'ctrl', 0xA3: 'ctrl', 0x12: 'alt', 0xA4: 'alt', 0xA5: 'alt', 0x5B: 'win', 0x5C: 'win' };

// "Ctrl+Shift+Alt+F" -> { mods: 'alt+ctrl+shift', vk: 0x46 }, or null when the key is unknown.
function parseAccelerator(accel) {
  const parts = String(accel || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mods = new Set();
  for (const p of parts.slice(0, -1)) {
    const m = MOD_NAMES[p.toLowerCase()];
    if (!m) return null;
    mods.add(m);
  }
  const last = parts[parts.length - 1];
  const vk = vkFor(KEY_ALIASES[last.toLowerCase()] || (/^num\d$/i.test(last) ? `Num${last.slice(3)}` : last));
  if (!vk || MOD_OF_VK[vk]) return null;
  return { mods: [...mods].sort().join('+'), vk };
}

class HotkeyMatcher {
  // hotkeys: { action: accelerator }; fire(action) is called on the key press that completes one.
  constructor(fire) {
    this.fire = fire;
    this.combos = [];
    this.down = new Set(); // vks held now (key repeats aren't presses)
  }

  setHotkeys(hotkeys) {
    this.combos = Object.entries(hotkeys || {}).map(([action, accel]) => ({ action, ...(parseAccelerator(accel) || {}) })).filter((c) => c.vk);
  }

  // Forget the keys held: cvhelper only reports keys while the game is in front, so the release of
  // a key let go elsewhere (Alt+Tab, the Windows key, Ctrl+Shift+Esc) never arrives and the key
  // would count as held from then on (a stuck Ctrl makes Alt+F10 read as Ctrl+Alt+F10).
  reset() {
    this.down.clear();
  }

  // A cvhelper key event: { k: vk, d: down }.
  onKey(e) {
    if (!e || e.m || !e.k) return;
    if (!e.d) { this.down.delete(e.k); return; }
    if (this.down.has(e.k)) return;
    this.down.add(e.k);
    if (MOD_OF_VK[e.k]) return;
    const mods = [...new Set([...this.down].map((vk) => MOD_OF_VK[vk]).filter(Boolean))].sort().join('+');
    for (const c of this.combos) if (c.vk === e.k && c.mods === mods) this.fire(c.action);
  }
}

// Whether a hotkey press should run its action. Windows repeats a registered hotkey (globalShortcut)
// while it's held: after the keyboard repeat delay (250 ms to 1 s, 500 ms by default), then every
// ~30 ms. The quiet time counts from the last press or repeat seen, and is longer than the longest
// repeat delay, so holding Alt+F9 starts the recording once instead of starting and stopping it
// every half second; a press that both globalShortcut and the key stream see runs once too.
function makeHotkeyGate(quietMs = 1100, now = Date.now) {
  const seenAt = {};
  return (action) => {
    const t = now();
    const quiet = seenAt[action] == null || t - seenAt[action] >= quietMs;
    seenAt[action] = t;
    return quiet;
  };
}

class InputTracker extends EventEmitter {
  // store: false only reports keys ('key' events) and keeps nothing (the hotkey listener).
  constructor({ store = true, restartDelayMs = 2000 } = {}) {
    super();
    this.store = store;
    this.restartDelayMs = restartDelayMs;
    this.wanted = false;
    this.restartTimer = null;
    this.restarts = 0;
    this.events = []; // [wallMs, name, down]
    this.proc = null;
    this.chatOpen = false;
  }

  get active() {
    return Boolean(this.proc);
  }

  // cvhelper exiting by itself (it crashed, or was killed) restarts it after restartDelayMs while
  // the tracker is still wanted; what was tracked so far is kept.
  start(gameExe) {
    if (this.proc) return;
    this.events = [];
    this.chatOpen = false;
    this.gameExe = gameExe;
    this.wanted = true;
    this.restarts = 0;
    this._spawn();
  }

  _spawn() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    let proc;
    try {
      proc = spawn(paths.helper, ['input', this.gameExe], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.emit('error', err);
      this._exited(null);
      return;
    }
    this.proc = proc;
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => this.emit('error', err));
    proc.stderr.on('data', (d) => this.emit('error', new Error(String(d).trim())));
    proc.on('close', (code) => { if (this.proc === proc) this._exited(code); });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      if (line === 'READY') return;
      let e;
      try { e = JSON.parse(line); } catch { return; }
      this._onEvent(e);
    });
  }

  _exited(code) {
    this.proc = null;
    this.chatOpen = false;
    this.emit('exit', code);
    if (!this.wanted || this.restartTimer) return;
    this.restarts++;
    // Quick at first; a helper that keeps dying is tried less often.
    const delay = this.restarts <= 3 ? this.restartDelayMs : this.restartDelayMs * 10;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted && !this.proc) { this.emit('restart', this.restarts); this._spawn(); }
    }, delay);
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    try { proc.stdin.end(); proc.kill(); } catch { /* ignore */ }
  }

  _onEvent(e) {
    this.emit('key', e);
    if (!this.store) return;
    if (e.m) {
      this.events.push([e.t, `Mouse${e.m}`, e.d]);
      return;
    }
    const name = keyName(e.k);
    // Enter opens and sends chat, Escape closes it; keys typed in between are not recorded.
    if (name === 'Enter') {
      if (e.d) this.chatOpen = !this.chatOpen;
      return;
    }
    if (name === 'Esc' && e.d) this.chatOpen = false;
    if (this.chatOpen) return;
    this.events.push([e.t, name, e.d]);
  }

  // Inputs between two wall-clock times, as [msFromStart, name, down].
  slice(fromMs, toMs) {
    const out = [];
    for (const [t, name, d] of this.events) {
      if (t >= fromMs && t <= toMs) out.push([Math.round(t - fromMs), name, d]);
    }
    return out;
  }
}

module.exports = { InputTracker, HotkeyMatcher, makeHotkeyGate, parseAccelerator, keyName, vkFor };
