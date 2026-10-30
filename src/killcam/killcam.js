// Kill cam window: plays one cam, holds the last frame a moment, fades out and tells the
// main process to hide the window. A newer cam replaces the one playing.
const cam = document.getElementById('cam');
const video = document.getElementById('video');
const fill = document.getElementById('fill');
const keysEl = document.getElementById('keys');
const HOLD_MS = 1200; // last frame stays this long before the fade
const BIG_HOLD_MS = 6000; // longer when blown up: you asked to look closely
const FADE_MS = 250;

let closeTimer;
let frame;
let shown = 0; // cams shown so far: a cam replaced while it loaded mustn't close the new one
let big = false;
let editing = false;

// [[accelerator, what it does]] -> "Ctrl Shift Alt + [F] Bigger [R] Replay [X] Close". The shared
// modifiers are shown once when every key has the same ones.
function showKeys(keys = []) {
  keysEl.textContent = '';
  if (!keys.length) return;
  const split = keys.map(([accel, what]) => { const p = accel.split('+'); return { mods: p.slice(0, -1).join('+'), key: p[p.length - 1], what }; });
  const shared = split.every((k) => k.mods === split[0].mods) && split[0].mods ? split[0].mods : '';
  const kbd = (t) => { const e = document.createElement('kbd'); e.textContent = t; return e; };
  if (shared) {
    const m = document.createElement('span');
    m.className = 'mods';
    m.textContent = `${shared.split('+').join(' ')} +`;
    keysEl.append(m);
  }
  for (const k of split) {
    const item = document.createElement('span');
    item.className = 'k';
    item.append(kbd(shared ? k.key : [k.mods, k.key].filter(Boolean).join('+')));
    const w = document.createElement('span');
    w.textContent = k.what;
    item.append(w);
    if (SHORT[k.what]) {
      w.className = 'what-long';
      const s = document.createElement('span');
      s.className = 'what-short';
      s.textContent = SHORT[k.what];
      item.append(s);
    }
    keysEl.append(item);
  }
  fitKeys();
}

// Words the strip shortens when the cam is narrow.
const SHORT = { 'Move + resize': 'Move' };
// The strip fits the cam's width: as it is, tighter, with shorter words, then with the modifiers
// on a row of their own, then in smaller type (and the keys wrapping, if even that's too wide).
const FITS = ['', 'tight', 'tight short', 'tight short stack', 'tight short stack tiny'];
function fitKeys() {
  for (const fit of FITS) {
    keysEl.className = `keys ${fit}`.trim();
    const k = keysEl.querySelectorAll('.k');
    const oneRow = !k.length || k[0].offsetTop === k[k.length - 1].offsetTop;
    if (keysEl.scrollWidth <= keysEl.clientWidth + 1 && oneRow) return;
  }
}

function layout() {
  document.body.classList.toggle('small', !big && window.innerWidth < 560);
  document.body.classList.toggle('big', big);
  fitKeys();
}
window.addEventListener('resize', layout);
document.fonts.addEventListener('loadingdone', fitKeys); // Manrope is wider than the stand-in

function close() {
  if (editing) return; // stays up while you move it
  clearTimeout(closeTimer);
  cancelAnimationFrame(frame);
  cam.classList.remove('show');
  closeTimer = setTimeout(() => {
    video.pause();
    video.removeAttribute('src');
    video.load();
    window.clipvault.killCamDone();
  }, FADE_MS);
}

function progress() {
  if (video.duration > 0) fill.style.width = `${Math.min(100, (video.currentTime / video.duration) * 100)}%`;
  frame = requestAnimationFrame(progress);
}

// Only the edit message closes anything when a move ends: a new cam sets this too, and mustn't
// close itself (the page can still be editing after the window was hidden mid-move).
function setEditing(on) {
  editing = on;
  document.body.classList.toggle('editing', on);
  video.loop = on;
}

// The main process hid the window (Close hotkey, or after killcam:done): stop for good, so a
// looping cam doesn't keep decoding in a hidden window.
function stop() {
  shown++; // a cam still starting mustn't close later
  clearTimeout(closeTimer);
  cancelAnimationFrame(frame);
  setEditing(false);
  big = false;
  cam.classList.remove('show');
  video.pause();
  if (video.getAttribute('src')) { video.removeAttribute('src'); video.load(); }
}

window.clipvault.onKillCam(({ url, title, label, zoom = 1, keys, big: isBig, editing: isEditing }) => {
  clearTimeout(closeTimer);
  cancelAnimationFrame(frame);
  big = Boolean(isBig);
  setEditing(Boolean(isEditing));
  document.body.classList.toggle('blank', !url);
  document.getElementById('title').textContent = [label || 'Replay', title].filter(Boolean).join(' · ');
  // Zoom into the middle, where your champion is with the camera locked (most play zoomed out).
  video.style.transform = zoom > 1 ? `scale(${zoom})` : '';
  showKeys(keys);
  layout();
  fill.style.width = '0';
  const n = ++shown;
  if (!url) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    requestAnimationFrame(() => cam.classList.add('show'));
    return;
  }
  video.src = url;
  video.play().then(() => {
    requestAnimationFrame(() => cam.classList.add('show'));
    progress();
  }, () => { if (n === shown) close(); }); // not when a newer cam interrupted this one's load
});

window.clipvault.onKillCamEdit(({ editing: on, big: isBig, keys }) => {
  const was = editing;
  if (typeof isBig === 'boolean') big = isBig; // Move pressed while big: the window went back to its size
  showKeys(keys);
  setEditing(on);
  layout();
  if (on) {
    // Pressed while the cam held its last frame or faded out: it stays and plays again.
    // (video.ended is false once loop is on, so look at paused.)
    clearTimeout(closeTimer);
    cam.classList.add('show');
    if (video.paused && video.getAttribute('src')) video.play().catch(() => {});
    return;
  }
  if (!was) return;
  if (!video.getAttribute('src')) close(); // the empty frame goes when you're done
  else if (video.ended) closeTimer = setTimeout(close, HOLD_MS);
});

window.clipvault.onKillCamHide(stop);

// Dragging: the main process moves the window; this page only reports how far the mouse went.
let drag = null;
function startDrag(e, kind) {
  if (!editing || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  drag = { kind, x: e.screenX, y: e.screenY, id: e.pointerId };
  e.target.setPointerCapture(e.pointerId);
  window.clipvault.killCamDrag({ phase: 'start', kind });
}
function dragTo(e, phase) {
  if (!drag || e.pointerId !== drag.id) return;
  window.clipvault.killCamDrag({ phase, kind: drag.kind, dx: e.screenX - drag.x, dy: e.screenY - drag.y });
  if (phase === 'end') drag = null;
}
cam.addEventListener('pointerdown', (e) => startDrag(e, 'move'));
document.getElementById('grip').addEventListener('pointerdown', (e) => startDrag(e, 'resize'));
document.addEventListener('pointermove', (e) => dragTo(e, 'move'));
document.addEventListener('pointerup', (e) => dragTo(e, 'end'));
document.addEventListener('pointercancel', (e) => dragTo(e, 'end'));
document.getElementById('done').addEventListener('pointerdown', (e) => e.stopPropagation());
document.getElementById('done').addEventListener('click', (e) => { e.stopPropagation(); window.clipvault.killCamEditDone(); });

window.clipvault.onKillCamBig(({ big: isBig, keys }) => {
  big = isBig;
  showKeys(keys);
  layout();
  if (video.ended) {
    // Holding the last frame (or fading out): it stays up for the new hold.
    clearTimeout(closeTimer);
    cam.classList.add('show');
    closeTimer = setTimeout(close, big ? BIG_HOLD_MS : HOLD_MS);
  }
});

video.addEventListener('ended', () => {
  cancelAnimationFrame(frame);
  fill.style.width = '100%';
  closeTimer = setTimeout(close, big ? BIG_HOLD_MS : HOLD_MS);
});
// A cam that can't play closes (not the error letting go of the video can raise).
video.addEventListener('error', () => { if (video.getAttribute('src')) close(); });
document.addEventListener('click', () => { if (!editing) close(); });
