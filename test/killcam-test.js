// Tests the death cam (kill cam in the code): which moments start one, how close kills share one cam, the range cut
// from the buffer, the temp-file cleanup, and where the cam plays.  Usage: node test/killcam-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KillCam, killCamPlacement, killCamSpotFor, CHAIN_MS, AFTER_MS, MIN_AFTER_MS, MAX_SPAN_MS } = require('../src/killcam');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCam(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'killcam-test-'));
  const saves = [];
  const shown = [];
  const cam = new KillCam({
    dir,
    save: async (fromMs, toMs, file) => {
      if (opts.fail) throw new Error('no footage');
      saves.push({ fromMs, toMs });
      fs.writeFileSync(file, 'x');
    },
    show: (c) => shown.push(c),
    getOptions: () => ({ enabled: opts.enabled !== false, before: 8, kinds: 'kinds' in opts ? opts.kinds : ['kills'] }),
    log: () => {},
    settleMs: opts.settleMs || 300,
  });
  return { cam, dir, saves, shown };
}

async function main() {
  // By default (no kinds given) only your deaths start a cam, titled "Death cam".
  {
    const { cam, shown } = makeCam({ kinds: null, settleMs: 50 });
    for (const type of ['kill', 'assist', 'dragon', 'bookmark', 'victory']) cam.onMoment({ type, label: type, score: 1, wallMs: Date.now() });
    assert.strictEqual(cam.pending, null);
    cam.onMoment({ kind: 'deaths', type: 'death', label: 'Death', score: 5, wallMs: Date.now() });
    assert.ok(cam.pending);
    await sleep(150);
    assert.deepStrictEqual([shown[0].label, shown[0].title], ['Death cam', '']);
  }
  // A kill just before your death joins the death cam; objectives play when picked.
  {
    const { cam, shown } = makeCam({ kinds: ['deaths', 'kills', 'objectives'], settleMs: 50 });
    cam.onMoment({ kind: 'kills', type: 'kill', label: 'Kill', score: 30, wallMs: Date.now() - 2000 });
    cam.onMoment({ kind: 'deaths', type: 'death', label: 'Death', score: 5, wallMs: Date.now() });
    await sleep(150);
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].label, 'Death cam');
    cam.reset();
    cam.onMoment({ kind: 'objectives', type: 'dragon', label: 'Dragon', score: 25, wallMs: Date.now() });
    cam.onMoment({ kind: 'assists', type: 'assist', label: 'Assist', score: 10, wallMs: Date.now() });
    await sleep(150);
    assert.deepStrictEqual([shown[1].label, shown[1].title], ['Replay', 'Dragon']);
  }
  // With kills picked: kills start a cam; assists, objectives and bookmarks don't.
  {
    const { cam } = makeCam();
    for (const type of ['death', 'assist', 'dragon', 'bookmark', 'victory']) cam.onMoment({ type, label: type, score: 1, wallMs: Date.now() });
    assert.strictEqual(cam.pending, null);
    cam.onMoment({ type: 'kill', label: 'Kill', score: 30, wallMs: Date.now() });
    assert.ok(cam.pending);
    cam.reset();
  }
  // Turned off (or no second screen / buffer): nothing happens.
  {
    const { cam } = makeCam({ enabled: false });
    cam.onMoment({ type: 'kill', label: 'Kill', score: 30, wallMs: Date.now() });
    assert.strictEqual(cam.pending, null);
  }
  // A double kill: the Kill + Kill + Multikill moments become one cam, titled by the best moment,
  // from 8 s before the first kill to AFTER_MS after the last, cut the settle time (300 ms here)
  // after the last kill arrived, however late the game reported it.
  {
    const { cam, saves, shown } = makeCam();
    const t0 = Date.now() - 900; // reported late
    cam.onMoment({ type: 'kill', label: 'Kill', score: 30, wallMs: t0 - 1000 });
    cam.onMoment({ type: 'kill', label: 'Kill', score: 30, wallMs: t0 });
    cam.onMoment({ type: 'multikill', label: 'Double kill', score: 70, wallMs: t0 });
    await sleep(100);
    assert.strictEqual(saves.length, 0, 'waits for more kills');
    await sleep(400);
    await cam.saving;
    assert.deepStrictEqual(saves, [{ fromMs: t0 - 1000 - 8000, toMs: t0 + AFTER_MS }]);
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].title, 'Double kill');
    assert.ok(fs.existsSync(shown[0].file));
  }
  // Kills further apart than MAX_SPAN_MS get their own cams.
  {
    const { cam, saves } = makeCam();
    const t = Date.now() - MAX_SPAN_MS - 5000;
    cam.onMoment({ type: 'kill', label: 'Kill', score: 30, wallMs: t });
    cam.onMoment({ type: 'firstblood', label: 'First blood', score: 40, wallMs: t + MAX_SPAN_MS + 1 });
    await sleep(50);
    await cam.saving;
    cam.flush();
    await cam.saving;
    assert.strictEqual(saves.length, 2);
  }
  // A kill within the multikill window of the last cam replays the whole run (one cam, both kills).
  {
    const { cam, saves, shown } = makeCam();
    const t = Date.now();
    cam.onMoment({ type: 'kill', label: 'Kill', score: 30, wallMs: t - 7000 });
    await sleep(400);
    await cam.saving;
    cam.onMoment({ type: 'kill', label: 'Kill', score: 30, wallMs: t - 7000 + CHAIN_MS - 500 });
    await sleep(400);
    await cam.saving;
    assert.strictEqual(saves.length, 2);
    assert.strictEqual(saves[1].fromMs, saves[0].fromMs, 'the replay starts at the first kill');
    assert.strictEqual(shown[1].title, '2 kills');
  }
  // Turned off before the cut: nothing is cut. reset() forgets the run.
  {
    let on = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'killcam-test-'));
    const saves = [];
    const cam = new KillCam({ dir, save: async () => saves.push(1), show: () => {}, getOptions: () => ({ enabled: on, before: 8, kinds: ['kills'] }), settleMs: 100 });
    cam.onMoment({ type: 'kill', label: 'Kill', score: 30, wallMs: Date.now() });
    on = false;
    await sleep(200);
    assert.strictEqual(saves.length, 0);
    cam.reset();
    assert.strictEqual(cam.last, null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // delay: the cam is cut that long after the moment, and keeps a quarter of it after (at least
  // MIN_AFTER_MS, at most AFTER_MS).
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'killcam-test-'));
    const saves = [];
    const cam = new KillCam({ dir, save: async (fromMs, toMs, file) => { saves.push({ at: Date.now(), fromMs, toMs }); fs.writeFileSync(file, 'x'); }, show: () => {}, getOptions: () => ({ enabled: true, before: 8, delay: 1 }), settleMs: 9000 });
    const t = Date.now();
    cam.onMoment({ kind: 'deaths', type: 'death', label: 'Death', score: 5, wallMs: t });
    await sleep(1300);
    assert.strictEqual(saves.length, 1);
    assert.ok(saves[0].at - t >= 950 && saves[0].at - t < 1250, `cut after ${saves[0].at - t} ms`);
    assert.strictEqual(saves[0].toMs - t, MIN_AFTER_MS);
    assert.strictEqual(cam.lastShown.file.startsWith(dir), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // A failed cut is reported to the caller and doesn't block the next cam.
  {
    const { cam } = makeCam({ fail: true });
    await assert.rejects(cam.play(0, 1, 'x'), /no footage/);
    const ok = makeCam();
    await ok.cam.play(0, 1, 'x');
    assert.strictEqual(ok.shown.length, 1);
  }
  // Only the newest few cam files stay; prune(null, 0) empties the folder.
  {
    const { cam, dir } = makeCam();
    for (let i = 0; i < 5; i++) await cam.play(0, 1, 'x');
    await sleep(100);
    assert.deepStrictEqual(fs.readdirSync(dir).map((n) => Number(n.split('-')[2].split('.')[0])).sort(), [3, 4, 5]);
    cam.prune(null, 0);
    await sleep(100);
    assert.strictEqual(fs.readdirSync(dir).length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Where the cam plays. The user's screens: a 2560x1440 primary and a 1080x1920 portrait
  // screen to its right, 613 px higher (taskbars 48 px).
  {
    const scr = (index, x, y, w, h) => ({ index, bounds: { x, y, width: w, height: h }, workArea: { x, y, width: w, height: h - 48 } });
    const one = [scr(0, 0, 0, 2560, 1440)];
    const two = [scr(0, 0, 0, 2560, 1440), scr(1, 2560, -613, 1080, 1920)];
    const place = (all, league = {}, more = {}) => killCamPlacement(all, { monitor: 0, notifyMonitor: -1, ...more, league: { killCamScreen: 'auto', killCamCorner: 'auto', ...league } });
    // One screen + auto: over the game, 26% wide, top left (in from the ally portraits), click-through.
    let p = place(one);
    assert.strictEqual(p.display.index, 0);
    assert.strictEqual(p.onGameScreen, true);
    assert.deepStrictEqual(p.bounds, { x: 128, y: 16, width: 666, height: 375 });
    // Two screens + auto: the portrait screen, bottom right of its work area, at most 40% wide.
    p = place(two);
    assert.strictEqual(p.display.index, 1);
    assert.strictEqual(p.onGameScreen, false);
    assert.deepStrictEqual(p.bounds, { x: 2560 + 1080 - 432 - 16, y: -613 + 1920 - 48 - 243 - 16, width: 432, height: 243 });
    // 'other' with one screen: no cam. 'game' with two: over the game.
    assert.strictEqual(place(one, { killCamScreen: 'other' }), null);
    assert.strictEqual(place(two, { killCamScreen: 'other' }).display.index, 1);
    assert.strictEqual(place(two, { killCamScreen: 'game' }).onGameScreen, true);
    // Capturing the second screen: the primary is the "other" screen.
    assert.strictEqual(place(two, {}, { monitor: 1 }).display.index, 0);
    // The notification screen wins when it isn't the game's; when it is, the first other screen.
    const three = [...two, scr(2, -1920, 0, 1920, 1080)];
    assert.strictEqual(place(three, {}, { notifyMonitor: 2 }).display.index, 2);
    assert.strictEqual(place(three, {}, { notifyMonitor: 0 }).display.index, 1);
    assert.strictEqual(place(three, {}, { notifyMonitor: 9 }).display.index, 1);
    // Corners, over the game (whole screen, taskbar included) and on the other screen.
    const at = (all, corner, more) => { const b = place(all, { killCamCorner: corner, ...more }).bounds; return [b.x, b.y]; };
    assert.deepStrictEqual(at(one, 'top-left'), [128, 16]);
    assert.deepStrictEqual(at(one, 'top-right'), [2560 - 666 - 16, 16]);
    assert.deepStrictEqual(at(one, 'bottom-left'), [128, 1440 - 375 - 16]);
    assert.deepStrictEqual(at(one, 'bottom-right'), [2560 - 666 - 16, 1440 - 375 - 16]);
    assert.deepStrictEqual(at(two, 'top-left'), [2560 + 16, -613 + 16]);
    assert.deepStrictEqual(at(two, 'bottom-left'), [2560 + 16, -613 + 1920 - 48 - 243 - 16]);
    // A 1080p game screen: 499 x 281.
    p = place([scr(0, 0, 0, 1920, 1080)]);
    assert.deepStrictEqual(p.bounds, { x: 96, y: 16, width: 499, height: 281 });
    // Sizes: a share of the game screen; on another screen they scale from medium's 640 px cap.
    assert.strictEqual(place(one, { killCamSize: 'small' }).bounds.width, 512);
    assert.strictEqual(place(one, { killCamSize: 'huge' }).bounds.width, 1075);
    assert.strictEqual(place(two, { killCamSize: 'large' }).bounds.width, Math.round(432 * (0.34 / 0.26)));
    // Dragged there: the spot (shares of that screen) round-trips, stays on screen, keeps 16:9.
    const moved = { x: 900, y: 500, width: 800, height: 450 };
    const spot = killCamSpotFor(one[0], moved, true);
    assert.deepStrictEqual(place(one, { killCamSpot: spot }).bounds, moved);
    assert.deepStrictEqual(place(one, { killCamSpot: { ...spot, x: 0.99 } }).bounds.x, 2560 - 800);
    // A spot on another screen than where the cam plays now is ignored.
    assert.strictEqual(place(two, { killCamSpot: spot }).display.index, 1);
    assert.strictEqual(place(two, { killCamSpot: spot }).bounds.width, 432);
    // A spot dragged to the full width of an ultrawide screen still fits its height (and on screen).
    const wide = [scr(0, 0, 0, 3440, 1440)];
    p = place(wide, { killCamSpot: { display: 0, x: 0, y: 0, w: 1 } });
    assert.deepStrictEqual(p.bounds, { x: 0, y: 0, width: 2560, height: 1440 });
    // Bigger (hotkey): 75% of the screen, centred, 16:9.
    const big = killCamPlacement(one, { monitor: 0, notifyMonitor: -1, league: { killCamScreen: 'game' } }, { big: true });
    assert.deepStrictEqual(big.bounds, { x: 320, y: 180, width: 1920, height: 1080 });
  }
  console.log('killcam tests passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
