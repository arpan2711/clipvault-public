// Death cam (named kill cam in the code): a few seconds of footage of each of your deaths, cut
// from the replay buffer and played in a small window on another screen, or over a quiet corner
// of the game, while you wait to respawn. Settings can add kills, assists and objectives.
//
// Moments close together (a double kill, a teamfight) wait for each other and become one cam:
// the footage is cut `delay` seconds (league.killCamDelay, 2 by default) after the last moment
// arrived. It can't be sooner than about 2 s: the buffer is written in 2 s segments, and the one
// holding the moment has to close first. A kill that still comes within League's
// multikill window of the last cam's kills replays the whole run again, the new kill included,
// in place of the cam playing. Files go to the profile's temp folder; the newest few are kept.
const fs = require('fs');
const path = require('path');
const { describeClip } = require('./games/league');

const SETTLE_MS = 5000; // wait this long after a moment arrives for another one (when getOptions has no delay)
const CHAIN_MS = 10000; // League's multikill window: a later kill joins the run before it
const AFTER_MS = 1500; // footage kept after the last moment (at most a quarter of the delay)
const MIN_AFTER_MS = 600; // ...but at least this much: your death itself, past the buffer's lag
const MAX_SPAN_MS = 20000; // kills further apart than this get their own cam
const KEEP_FILES = 3; // newest cam files kept in the temp folder (the one playing among them)

const KILL_TYPES = new Set(['kill', 'multikill', 'firstblood', 'ace']);
const CAM_KINDS = ['deaths', 'kills', 'assists', 'objectives']; // moment kinds a cam can play for
const DEFAULT_KINDS = ['deaths'];

function kindOf(m) {
  return m.kind || (KILL_TYPES.has(m.type) ? 'kills' : m.type === 'death' ? 'deaths' : null);
}

class KillCam {
  // save(fromMs, toMs, file) -> Promise ({ file }); show({ file, title, label });
  // getOptions() -> { enabled, before, kinds, delay } (kinds: CAM_KINDS to play for, deaths by
  // default; delay: seconds to wait after a moment, else settleMs)
  constructor({ dir, save, show, getOptions, log = () => {}, settleMs = SETTLE_MS }) {
    this.dir = dir;
    this.save = save;
    this.show = show;
    this.getOptions = getOptions;
    this.log = log;
    this.settleMs = settleMs;
    this.pending = null;
    this.count = 0;
    this.saving = Promise.resolve();
  }

  // A key moment of the running match (LeagueWatcher 'moment').
  onMoment(m) {
    const o = this.getOptions();
    const kind = kindOf(m);
    if (!o.enabled || !CAM_KINDS.includes(kind) || !(o.kinds || DEFAULT_KINDS).includes(kind)) return;
    let p = this.pending;
    if (p && m.wallMs - p.firstMs > MAX_SPAN_MS) { this.flush(); p = null; }
    if (!p) {
      // The run of kills the last cam showed carries on: start from its first kill.
      const run = this.last && m.wallMs - this.last.lastMs <= CHAIN_MS && m.wallMs - this.last.firstMs <= MAX_SPAN_MS ? this.last : null;
      p = this.pending = run ? { moments: [...run.moments], firstMs: run.firstMs, lastMs: run.lastMs } : { moments: [], firstMs: m.wallMs, lastMs: m.wallMs };
    }
    p.moments.push(m);
    p.lastMs = Math.max(p.lastMs, m.wallMs);
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.flush(), this.settle());
  }

  settle() {
    const d = this.getOptions().delay;
    return d > 0 ? d * 1000 : this.settleMs;
  }

  // A new match started: forget kills that weren't cut yet, and the last cam's run.
  reset() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.last = null;
  }

  flush() {
    const p = this.pending;
    if (!p) return null;
    clearTimeout(p.timer);
    this.pending = null;
    this.last = p;
    if (!this.getOptions().enabled) return null; // turned off (or the buffer stopped) meanwhile
    const before = (this.getOptions().before || 8) * 1000;
    const died = p.moments.some((m) => kindOf(m) === 'deaths');
    const label = died ? 'Death cam' : p.moments.some((m) => kindOf(m) === 'kills') ? 'Kill cam' : 'Replay';
    const title = died ? '' : describeClip(p.moments).title; // "Death cam" says it all
    // A short delay mustn't wait on the next segment: keep at most a quarter of it after the moment,
    // but at least MIN_AFTER_MS (with 1 s, a death at a segment's end left 250 ms, less than
    // the buffer's own lag: the cam could stop before you died).
    const after = this.getOptions().delay > 0 ? Math.min(AFTER_MS, Math.max(MIN_AFTER_MS, this.settle() / 4)) : AFTER_MS;
    return this.play(p.firstMs - before, p.lastMs + after, title, label).catch(() => {}); // logged in play()
  }

  // Cut [fromMs, toMs] of the buffer and show it. Cams are cut one at a time, in order.
  // Rejects when the cut fails (a later cam still runs).
  play(fromMs, toMs, title, label = 'Replay') {
    const file = path.join(this.dir, `killcam-${Date.now()}-${++this.count}.mp4`);
    const job = this.saving.then(async () => {
      fs.mkdirSync(this.dir, { recursive: true });
      await this.save(fromMs, toMs, file);
      this.lastShown = { file, title, label };
      this.show(this.lastShown);
      this.prune(file);
    });
    this.saving = job.catch((err) => this.log(`kill cam: ${err.message}`));
    return job;
  }

  // Keep the newest KEEP_FILES cams (never `current`); keep = 0 empties the folder.
  prune(current, keep = KEEP_FILES) {
    let names;
    try { names = fs.readdirSync(this.dir); } catch { return; }
    // killcam-<ms>-<n>.mp4, newest first
    const files = names.map((n) => /^killcam-(\d+)-(\d+)\.mp4$/.exec(n)).filter(Boolean)
      .sort((a, b) => b[1] - a[1] || b[2] - a[2])
      .map((m) => path.join(this.dir, m[0]));
    for (const f of files.slice(keep)) {
      if (f !== current) fs.rm(f, { force: true }, () => {});
    }
  }
}

const MARGIN = 16; // gap between the cam and the screen edge
// league.killCamSize: the cam's width over the game, as a share of the screen (medium = 26%).
// On another screen medium is up to 640 px, and the others scale from that.
const CAM_SIZES = { small: 0.2, medium: 0.26, large: 0.34, huge: 0.42 };
// The window is the picture plus this band under it for the hotkey strip (killcam.html), so the
// keys never cover the video. Half as big again when blown up: the strip is drawn bigger.
const KEYS_BAND = 52; // fits the strip on two rows (the smallest cams)
const keysBand = (big) => (big ? Math.round(KEYS_BAND * 1.5) : KEYS_BAND);
const BIG_SHARE = 0.75; // the "bigger" hotkey: the cam takes this share of the screen, centred

// Where a cam plays. all: displays() (index, workArea, bounds); s: settings values.
// Returns { display, bounds, onGameScreen }, or null when there's no screen to play it on
// ('other' with one screen).
//
// league.killCamScreen: 'auto' = another screen when there is one (the notification screen
// first), else the game's; 'other' = only another screen; 'game' = always over the game.
// league.killCamCorner: 'auto' or a corner. On another screen 'auto' is bottom-right. Over the
// game it's top-left, the emptiest part of League's HUD: the scoreboard and kill feed are top
// right, the minimap bottom right, the abilities bottom centre and chat bottom left. The left
// edge holds the ally portraits, so the left corners sit a little in from the edge.
function killCamPlacement(all, s, { big = false } = {}) {
  const L = s.league || {};
  const where = L.killCamScreen || 'auto';
  const game = all[s.monitor] || all[0];
  if (!game) return null;
  let other = null;
  if (s.notifyMonitor >= 0 && s.notifyMonitor !== game.index && all[s.notifyMonitor]) other = all[s.notifyMonitor];
  else other = all.find((d) => d.index !== game.index) || null;
  const display = where === 'game' ? game : where === 'other' ? other : other || game;
  if (!display) return null;
  const onGameScreen = display === game;
  // Over the game: League covers the whole screen (taskbar included), and the cam stays small
  // (26% of the width). On another screen: the work area, and up to 640 px wide.
  const area = onGameScreen ? display.bounds || display.workArea : display.workArea;
  if (big) {
    const w = Math.round(Math.min(area.width * BIG_SHARE, ((area.height * BIG_SHARE) * 16) / 9));
    const h = Math.round((w * 9) / 16);
    return { display, bounds: { x: Math.round(area.x + (area.width - w) / 2), y: Math.round(area.y + (area.height - h) / 2), width: w, height: h }, onGameScreen, big };
  }
  // Dragged there (Move hotkey): shares of that screen, kept on it.
  const spot = L.killCamSpot;
  if (spot && spot.display === display.index) {
    const w = Math.round(Math.max(240, Math.min(area.width, (area.height * 16) / 9, spot.w * area.width))); // fits a wide screen's height too
    const h = Math.round((w * 9) / 16);
    const x = Math.round(Math.min(Math.max(area.x, area.x + spot.x * area.width), area.x + area.width - w));
    const y = Math.round(Math.min(Math.max(area.y, area.y + spot.y * area.height), area.y + area.height - h));
    return { display, bounds: { x, y, width: w, height: h }, onGameScreen };
  }
  const share = CAM_SIZES[L.killCamSize] || CAM_SIZES.medium;
  const k = share / CAM_SIZES.medium;
  const width = Math.round(onGameScreen ? area.width * share : Math.min(640 * k, area.width * 0.4 * k, area.width - 2 * MARGIN));
  const height = Math.round((width * 9) / 16);
  const corner = L.killCamCorner && L.killCamCorner !== 'auto' ? L.killCamCorner : onGameScreen ? 'top-left' : 'bottom-right';
  const inset = onGameScreen ? Math.round(area.width * 0.05) : MARGIN; // clear of the ally portraits
  const x = corner.endsWith('left') ? area.x + inset : area.x + area.width - width - MARGIN;
  const y = corner.startsWith('top') ? area.y + MARGIN : area.y + area.height - height - MARGIN;
  return { display, bounds: { x: Math.round(x), y: Math.round(y), width, height }, onGameScreen };
}

// Bounds on a screen -> league.killCamSpot (shares of the area killCamPlacement uses there).
function killCamSpotFor(display, bounds, onGameScreen) {
  const area = onGameScreen ? display.bounds || display.workArea : display.workArea;
  const r = (n) => Math.round(n * 10000) / 10000;
  return { display: display.index, x: r((bounds.x - area.x) / area.width), y: r((bounds.y - area.y) / area.height), w: r(bounds.width / area.width) };
}

module.exports = { KillCam, killCamPlacement, killCamSpotFor, keysBand, CAM_KINDS, CAM_SIZES, SETTLE_MS, CHAIN_MS, AFTER_MS, MIN_AFTER_MS, MAX_SPAN_MS };
