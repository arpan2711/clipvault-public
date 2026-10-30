// The death cam's page (src/killcam/killcam.html + killcam.js), driven in a real (hidden) Electron
// window with the real preload.js: a cam shows, plays and stays up until it ends, then holds,
// fades and sends killcam:done; a newer cam replaces it; big mode holds longer; move mode loops
// and never closes on its own; the key strip fits every cam size; a click or a broken video
// closes it. The main process's side is played by this test (it answers like main.js does).
//   node test/killcam-page-test.js [--shots=<folder>]   (screenshots of every size, for a look)
//   [--page-dir=<folder with killcam.html>]             (runs against another copy of the page)
const path = require('path');

const REPO = path.join(__dirname, '..');

if (!process.versions.electron) {
  // Plain Node: start this file in Electron (ELECTRON_RUN_AS_NODE would make it Node again).
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
} else {
  runInElectron();
}

function runInElectron() {
  const assert = require('assert');
  const fs = require('fs');
  const os = require('os');
  const { spawnSync } = require('child_process');
  const { pathToFileURL } = require('url');
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { killCamPlacement, keysBand } = require(path.join(REPO, 'src', 'killcam'));
  const { paths } = require(path.join(REPO, 'src', 'ffmpeg'));

  const opt = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
  const SHOTS = opt('shots');
  const PAGE = path.join(opt('page-dir') || path.join(REPO, 'src', 'killcam'), 'killcam.html');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'killcam-page-'));
  app.setPath('userData', path.join(tmp, 'profile'));
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const MODS = 'Ctrl+Shift+Alt';
  // main.js killCamKeys(): [[accelerator, what it does]]
  const keys = ({ big = false, editing = false, move = true } = {}) => [[`${MODS}+F`, big ? 'Smaller' : 'Bigger'], [`${MODS}+R`, 'Replay'],
    ...(move ? [[`${MODS}+M`, editing ? 'Done' : 'Move + resize']] : []), [`${MODS}+X`, 'Close']];

  let win;
  const events = []; // { type, at, data } the page sent
  const count = (type) => events.filter((e) => e.type === type).length;
  ipcMain.on('killcam:done', () => events.push({ type: 'done', at: Date.now() }));
  ipcMain.on('killcam:drag', (_e, data) => events.push({ type: 'drag', at: Date.now(), data }));
  ipcMain.on('killcam:edit-done', () => events.push({ type: 'edit-done', at: Date.now() }));

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const state = () => js(`(() => {
    const cs = getComputedStyle(cam);
    const screenCs = getComputedStyle(document.querySelector('.screen'));
    const shownEl = (sel) => { const e = document.querySelector(sel); return Boolean(e && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden'); };
    return {
      show: cam.classList.contains('show'), body: document.body.className, editing, big,
      src: video.getAttribute('src') || '', paused: video.paused, ended: video.ended, loop: video.loop, t: video.currentTime,
      title: document.getElementById('title').textContent, transform: video.style.transform,
      outline: screenCs.outlineStyle, opacity: Number(cs.opacity), hint: shownEl('.hint'), done: shownEl('#done'), grip: shownEl('#grip'),
      videoVisible: getComputedStyle(video).visibility !== 'hidden',
      keys: keysEl.textContent, kbds: [...keysEl.querySelectorAll('kbd')].map((k) => k.textContent),
      mods: (keysEl.querySelector('.mods') || {}).textContent || '',
    };
  })()`);
  async function waitFor(what, test, timeout = 4000) {
    const t0 = Date.now();
    for (;;) {
      const s = await state();
      if (test(s)) return s;
      if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s)}`);
      await sleep(40);
    }
  }
  // Like main.js showKillCam(): one 'killcam' message.
  const send = (msg) => win.webContents.send('killcam', { title: '', label: 'Death cam', zoom: 1, big: false, editing: false, keys: keys(), ...msg });
  const edit = (on, extra = {}) => win.webContents.send('killcam:edit', { editing: on, keys: keys({ editing: on, ...extra }) });
  const bigMsg = (on) => win.webContents.send('killcam:big', { big: on, keys: keys({ big: on }) });
  // main.js hideKillCam() after killcam:done (or the Close hotkey)
  const hide = () => win.webContents.send('killcam:hide');
  // Real mouse input at a point of the page (CSS px); the screen position is the same point.
  const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), globalX: Math.round(x), globalY: Math.round(y), button: 'left', clickCount: 1 });
  async function click(x, y) {
    for (const type of ['mouseDown', 'mouseUp']) {
      mouse(type, x, y);
      await sleep(30);
    }
  }
  const centre = (sel) => js(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  // Wait until the page is idle again (after a test that left a cam closing).
  async function settle() {
    hide();
    await sleep(350);
    events.length = 0;
  }
  async function resize(w, h) {
    win.setBounds({ width: w, height: h }); // frameless: as main.js sizes the cam
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      // Within a pixel: the content size is in device pixels (125% here), rounded.
      if (await js(`Math.abs(innerWidth - ${w}) <= 1 && Math.abs(innerHeight - ${h}) <= 1`)) return;
      await sleep(30);
    }
    throw new Error(`the window didn't become ${w}x${h}: ${await js('[innerWidth, innerHeight]')}`);
  }

  // Fixtures: a 2 s clip with sound, and a file that isn't a video.
  function fixtures() {
    const clip = path.join(tmp, 'cam.mp4');
    const r = spawnSync(paths.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', clip], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not make the test clip: ${r.stderr || r.error}`);
    const broken = path.join(tmp, 'broken.mp4');
    fs.writeFileSync(broken, Buffer.alloc(4096, 7));
    return { url: pathToFileURL(clip).href, broken: pathToFileURL(broken).href, missing: pathToFileURL(path.join(tmp, 'missing.mp4')).href };
  }

  const results = [];
  async function test(name, fn) {
    try {
      await fn();
      results.push([true, name]);
      console.log(`PASS  ${name}`);
    } catch (err) {
      results.push([false, name]);
      const at = err.stack.split('\n').find((l) => l.includes(path.basename(__filename))) || '';
      console.log(`FAIL  ${name}\n      ${err.message.replace(/\s*\n\s*/g, ' ')}\n      ${at.trim()}`);
    }
    await settle();
  }

  async function main() {
    const f = fixtures();
    win = new BrowserWindow({
      width: 332, height: 187, useContentSize: true, show: false, frame: false, transparent: true, resizable: false, // as main.js makes it
      webPreferences: { preload: path.join(REPO, 'src', 'preload.js'), contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
    });
    win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) console.log('page:', e.message); });
    await win.loadFile(PAGE);

    await test('the first cam on a fresh page fits its strip once the font has loaded', async () => {
      send({ url: f.url }); // the smallest cam (small, on a portrait screen)
      await waitFor('the cam', (x) => x.show && !x.paused);
      await sleep(300);
      const m = await js(`({ over: keysEl.scrollWidth - keysEl.clientWidth, fit: keysEl.className, font: [...document.fonts].some((x) => x.family.includes('Manrope') && x.status === 'loaded'),
        rows: new Set([...keysEl.querySelectorAll('.k')].map((k) => Math.round(k.getBoundingClientRect().top))).size })`);
      assert.ok(m.font, 'Manrope loaded');
      assert.ok(m.over <= 1 && m.rows === 1, JSON.stringify(m));
    });
    await resize(640, 360);

    await test('a cam shows, plays and stays up until it ends, then holds, fades and sends done', async () => {
      const sent = Date.now();
      send({ url: f.url });
      let s = await waitFor('the cam to show and play', (x) => x.show && !x.paused && x.t > 0.1, 3000);
      assert.strictEqual(s.title, 'Death cam');
      assert.ok(s.videoVisible && !s.body.includes('blank'));
      // Every look until it ends: still showing, no done (the 92417e0 bug hid it 250 ms in).
      for (;;) {
        s = await state();
        assert.strictEqual(count('done'), 0, `done before the video ended (${Date.now() - sent} ms in)`);
        if (s.ended) break;
        assert.ok(s.show, `the cam hid itself ${Date.now() - sent} ms in, at ${s.t.toFixed(2)} s`);
        assert.ok(Date.now() - sent < 6000, 'the 2 s clip never ended');
        await sleep(100);
      }
      const ended = Date.now();
      await sleep(900);
      s = await state();
      assert.ok(s.show && count('done') === 0, 'holds the last frame');
      s = await waitFor('the fade', (x) => !x.show, 1500);
      assert.strictEqual(count('done'), 0, 'done only after the fade');
      const t0 = Date.now();
      while (!count('done') && Date.now() - t0 < 1500) await sleep(20);
      const held = events[0].at - ended;
      assert.ok(held > 1200 && held < 2400, `hold + fade took ${held} ms`);
      assert.strictEqual((await state()).src, '', 'the video is let go');
      await sleep(600);
      assert.strictEqual(count('done'), 1, 'one killcam:done');
    });

    await test('a second cam replaces a playing one (and one that is holding its last frame)', async () => {
      send({ url: f.url, title: 'First' });
      await waitFor('the first cam', (x) => x.show && x.t > 0.8);
      send({ url: `${f.url}?second`, label: 'Kill cam', title: 'Double kill' });
      let s = await waitFor('the second cam', (x) => x.src.endsWith('?second') && !x.paused && x.t < 0.8);
      assert.strictEqual(s.title, 'Kill cam · Double kill');
      await waitFor('it to end', (x) => x.ended, 5000);
      send({ url: `${f.url}?third` }); // during the hold
      await sleep(1700); // past where the second one's hold + fade would have ended
      s = await state();
      assert.ok(s.show && s.src.endsWith('?third') && !s.ended, `the third cam plays: ${JSON.stringify(s)}`);
      assert.strictEqual(count('done'), 0);
      // Two cams in a row, the second before the first could start: the first's interrupted
      // play() mustn't close the second.
      send({ url: `${f.url}?a` });
      send({ url: `${f.url}?b` });
      s = await waitFor('the last cam to play', (x) => x.show && x.src.endsWith('?b') && x.t > 0.3);
      await sleep(400);
      assert.ok((await state()).show && count('done') === 0, 'still up');
    });

    await test('big mode: toggles and holds longer; back to normal closes after the usual hold', async () => {
      send({ url: f.url });
      await waitFor('the cam', (x) => x.show && !x.paused);
      bigMsg(true);
      let s = await waitFor('big', (x) => x.big && x.body.includes('big'));
      assert.ok(s.keys.includes('Smaller'), s.keys);
      await waitFor('the end', (x) => x.ended, 5000);
      await sleep(3000);
      s = await state();
      assert.ok(s.show && count('done') === 0, 'big holds well past the normal 1.2 s');
      bigMsg(false);
      s = await waitFor('normal', (x) => !x.big && !x.body.includes('big') && x.keys.includes('Bigger'));
      const t0 = Date.now();
      while (!count('done') && Date.now() - t0 < 3000) await sleep(20);
      const took = Date.now() - t0;
      assert.strictEqual(count('done'), 1);
      assert.ok(took > 1100 && took < 2200, `closed ${took} ms after going back to normal`);
      // A cam sent big starts big.
      send({ url: f.url, big: true, keys: keys({ big: true }) });
      s = await waitFor('a big cam', (x) => x.show && x.big && x.body.includes('big') && x.keys.includes('Smaller'));
    });

    await test('big after the fade started: the cam shows again for the long hold', async () => {
      send({ url: f.url });
      await waitFor('the fade', (x) => x.ended && !x.show, 6000);
      bigMsg(true); // pressed during the 250 ms fade (the window is still up)
      await sleep(600);
      const s = await state();
      assert.ok(s.show && s.big && count('done') === 0, `big cam is visible: ${JSON.stringify(s)}`);
    });

    await test('move mode: loops, outline, hint, Done and grip, never closes; Done and drags reach main', async () => {
      send({ url: f.url, editing: true, keys: keys({ editing: true }) });
      let s = await waitFor('the cam in move mode', (x) => x.show && !x.paused);
      assert.ok(s.editing && s.loop && s.body.includes('editing'));
      assert.strictEqual(s.outline, 'dashed');
      assert.ok(s.hint && s.done && s.grip, `hint ${s.hint} done ${s.done} grip ${s.grip}`);
      assert.ok(s.keys.includes('Done'), s.keys);
      await sleep(3000); // past the clip's end
      s = await state();
      assert.ok(s.show && !s.paused && !s.ended && count('done') === 0, `still up and looping: ${JSON.stringify(s)}`);
      // A click (in move mode the start of a drag) doesn't close it.
      await click(320, 120);
      await sleep(300);
      s = await state();
      assert.ok(s.show && count('done') === 0, 'a click in move mode keeps it');
      const moves = events.filter((e) => e.type === 'drag').map((e) => [e.data.phase, e.data.kind]);
      assert.deepStrictEqual([moves[0], moves[moves.length - 1]], [['start', 'move'], ['end', 'move']], JSON.stringify(moves));
      // The corner grip resizes.
      events.length = 0;
      const [gx, gy] = await centre('#grip');
      mouse('mouseDown', gx, gy);
      await sleep(30);
      mouse('mouseMove', gx + 40, gy + 10);
      await sleep(30);
      mouse('mouseUp', gx + 40, gy + 10);
      await sleep(200);
      const drags = events.filter((e) => e.type === 'drag').map((e) => e.data);
      assert.deepStrictEqual([drags[0].phase, drags[0].kind], ['start', 'resize']);
      const end = drags[drags.length - 1];
      assert.deepStrictEqual([end.phase, end.kind, end.dx, end.dy], ['end', 'resize', 40, 10]);
      // Done: tells main, and starts no drag.
      events.length = 0;
      const [dx, dy] = await centre('#done');
      await click(dx, dy);
      await sleep(200);
      assert.strictEqual(count('edit-done'), 1, 'Done reaches main');
      assert.strictEqual(count('drag'), 0, 'Done is no drag');
      // Main ends move mode: the loop stops, the cam plays to its end, holds and closes.
      edit(false);
      s = await waitFor('move mode off', (x) => !x.editing && !x.loop && !x.body.includes('editing'));
      assert.ok(s.show && !s.paused, 'it plays on');
      await waitFor('the end', (x) => x.ended, 5000);
      const t0 = Date.now();
      while (!count('done') && Date.now() - t0 < 3000) await sleep(20);
      assert.strictEqual(count('done'), 1, 'closes after its hold');
    });

    await test('move mode pressed while big: the page leaves big mode with the window', async () => {
      send({ url: f.url });
      await waitFor('the cam', (x) => x.show && !x.paused);
      bigMsg(true);
      await waitFor('big', (x) => x.big);
      win.webContents.send('killcam:edit', { editing: true, big: false, keys: keys({ editing: true }) }); // main.js toggleKillCamEdit()
      const s = await waitFor('move mode, not big', (x) => x.editing && !x.big && !x.body.includes('big'));
      assert.ok(s.keys.includes('Bigger'), s.keys);
    });

    await test('move mode entered while the cam holds or fades: it stays and plays again', async () => {
      send({ url: f.url });
      await waitFor('the fade', (x) => x.ended && !x.show, 6000);
      edit(true); // main sends this when the window is still up
      await sleep(800);
      const s = await state();
      assert.ok(s.show && s.editing && !s.paused && count('done') === 0, `stays: ${JSON.stringify(s)}`);
    });

    await test('finishing move mode after the video ended closes it after the hold', async () => {
      send({ url: f.url, editing: true, keys: keys({ editing: true }) });
      await waitFor('move mode', (x) => x.show && x.editing && !x.paused);
      await js('video.loop = false'); // the clip stops at its end while still in move mode
      await waitFor('the end', (x) => x.ended, 5000);
      await sleep(1600);
      assert.ok((await state()).show && count('done') === 0, 'no close while moving');
      edit(false);
      const t0 = Date.now();
      while (!count('done') && Date.now() - t0 < 3000) await sleep(20);
      const took = Date.now() - t0;
      assert.strictEqual(count('done'), 1);
      assert.ok(took > 1100 && took < 2200, `closed ${took} ms after Done`);
    });

    await test('blank move frame (no cam yet): shows without video, stays, and goes on Done', async () => {
      send({ url: '', editing: true, keys: keys({ editing: true }) });
      let s = await waitFor('the empty frame', (x) => x.show && x.editing);
      assert.ok(s.body.includes('blank') && !s.videoVisible && s.src === '', JSON.stringify(s));
      assert.strictEqual(s.title, 'Death cam');
      await sleep(1500);
      assert.ok((await state()).show && count('done') === 0, 'stays');
      edit(false);
      const t0 = Date.now();
      while (!count('done') && Date.now() - t0 < 1000) await sleep(20);
      assert.strictEqual(count('done'), 1, 'the empty frame goes right away');
    });

    await test('a new cam on a page still in move mode (window hidden mid-move) stays up', async () => {
      // The empty move frame, closed with the Close hotkey before the page heard of it; then a
      // death cam (main sends editing: false). It used to close itself 250 ms in.
      send({ url: '', editing: true, keys: keys({ editing: true }) });
      await waitFor('the empty frame', (x) => x.show && x.editing);
      send({ url: f.url });
      await waitFor('the new cam', (x) => x.show && !x.paused && !x.editing);
      await sleep(800);
      const s = await state();
      assert.ok(s.show && !s.paused && count('done') === 0, `the new cam closed itself: ${JSON.stringify(s)}`);
    });

    await test('Close (killcam:hide) during move mode: the page stops playing, and the next cam stays up', async () => {
      send({ url: f.url, editing: true, keys: keys({ editing: true }) });
      await waitFor('looping', (x) => x.show && x.loop && !x.paused);
      hide();
      await waitFor('stopped', (x) => x.paused && x.src === '' && !x.loop && !x.editing && !x.show);
      await sleep(400);
      assert.ok((await state()).paused, 'nothing plays in the hidden window');
      assert.strictEqual(count('done'), 0, 'hiding sends no done');
      send({ url: '', editing: true, keys: keys({ editing: true }) });
      await waitFor('the empty frame', (x) => x.show && x.editing);
      hide();
      await waitFor('stopped', (x) => !x.editing && !x.show);
      send({ url: f.url });
      await waitFor('the new cam', (x) => x.show && !x.paused);
      await sleep(800);
      const s = await state();
      assert.ok(s.show && !s.paused && count('done') === 0, `the new cam closed itself: ${JSON.stringify(s)}`);
    });

    await test('zoom applies (and goes back to none)', async () => {
      send({ url: f.url, zoom: 1.5 });
      let s = await waitFor('zoom', (x) => x.show);
      assert.strictEqual(s.transform, 'scale(1.5)');
      send({ url: f.url, zoom: 2 });
      s = await waitFor('zoom 2', (x) => x.transform === 'scale(2)');
      send({ url: f.url, zoom: 1 });
      s = await waitFor('no zoom', (x) => x.transform === '');
    });

    await test('the key strip: shared modifiers once for 4 and 3 keys, full keys when they differ, none hidden', async () => {
      send({ url: f.url });
      let s = await waitFor('4 keys', (x) => x.kbds.length === 4);
      assert.deepStrictEqual(s.kbds, ['F', 'R', 'M', 'X']);
      assert.strictEqual(s.mods, 'Ctrl Shift Alt +');
      assert.ok(s.keys.includes('Bigger') && s.keys.includes('Replay') && s.keys.includes('Close'));
      send({ url: f.url, keys: keys({ move: false }) });
      s = await waitFor('3 keys', (x) => x.kbds.length === 3);
      assert.deepStrictEqual(s.kbds, ['F', 'R', 'X']);
      assert.strictEqual(s.mods, 'Ctrl Shift Alt +');
      send({ url: f.url, keys: [['Ctrl+Shift+Alt+F', 'Bigger'], ['Alt+R', 'Replay'], ['F9', 'Close']] });
      s = await waitFor('mixed keys', (x) => x.kbds[1] === 'Alt+R');
      assert.deepStrictEqual(s.kbds, ['Ctrl+Shift+Alt+F', 'Alt+R', 'F9']);
      assert.strictEqual(s.mods, '');
      send({ url: f.url, keys: [] });
      await waitFor('no keys', (x) => x.kbds.length === 0);
      assert.strictEqual(await js('getComputedStyle(keysEl).display'), 'none');
    });

    await test('a click closes it (not in move mode)', async () => {
      send({ url: f.url });
      await waitFor('the cam', (x) => x.show && !x.paused && x.t > 0.3);
      await click(320, 150);
      await waitFor('closing', (x) => !x.show, 1000);
      const t0 = Date.now();
      while (!count('done') && Date.now() - t0 < 1000) await sleep(20);
      assert.strictEqual(count('done'), 1);
    });

    await test('a broken or missing video closes it', async () => {
      for (const url of [f.broken, f.missing]) {
        events.length = 0;
        send({ url });
        const t0 = Date.now();
        while (!count('done') && Date.now() - t0 < 3000) await sleep(20);
        assert.strictEqual(count('done'), 1, `no done for ${path.basename(url)}`);
        await settle();
      }
    });

    // Every size on a 2048x1152 game screen and a 1080x1920 portrait screen (killCamPlacement),
    // normal, big and in move mode: the strip, label and Done fit inside the cam.
    const screens = [
      { index: 0, bounds: { x: 0, y: 0, width: 2048, height: 1152 }, workArea: { x: 0, y: 0, width: 2048, height: 1104 } },
      { index: 1, bounds: { x: 2048, y: 0, width: 1080, height: 1920 }, workArea: { x: 2048, y: 0, width: 1080, height: 1872 } },
    ];
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    await test('the key strip fits at every size, on both screens, normal, big and moving', async () => {
      const problems = [];
      for (const where of ['game', 'other']) {
        for (const size of ['small', 'medium', 'large', 'huge', 'big']) {
          const s = { monitor: 0, notifyMonitor: -1, league: { killCamScreen: where, killCamSize: size === 'big' ? 'medium' : size } };
          const { bounds } = killCamPlacement(screens, s, { big: size === 'big' });
          await resize(bounds.width, bounds.height + keysBand(size === 'big'));
          for (const mode of size === 'big' ? ['normal'] : ['normal', 'editing']) {
            const editing = mode === 'editing';
            // The empty frame lays out the same and is quicker (the video only for screenshots).
            send({ url: SHOTS ? f.url : '', big: size === 'big', editing, keys: keys({ big: size === 'big', editing }) });
            await waitFor('the cam', (x) => x.show && (!SHOTS || !x.paused));
            await sleep(SHOTS ? 350 : 60);
            const m = await js(`(() => {
              const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
              const rows = new Set([...keysEl.querySelectorAll('.k')].map((k) => Math.round(k.getBoundingClientRect().top))).size;
              return { cam: r('#cam'), screen: r('.screen'), keys: r('#keys'), label: r('.label'), done: r('#done'), hint: r('.hint'), fit: keysEl.className, over: keysEl.scrollWidth - keysEl.clientWidth, rows };
            })()`);
            const name = `${where}-${size}${editing ? '-move' : ''} ${bounds.width}x${bounds.height}`;
            if (m.over > 1) problems.push(`${name}: the strip overflows by ${m.over} px (${m.fit})`);
            if (m.keys.l < m.cam.l + 4 || m.keys.r > m.cam.r - 4) problems.push(`${name}: the strip is cut off (${Math.round(m.keys.l)}..${Math.round(m.keys.r)} of ${Math.round(m.cam.r)})`);
            if (m.keys.t < m.screen.b) problems.push(`${name}: the strip covers the picture (${Math.round(m.keys.t)} < ${Math.round(m.screen.b)})`);
            if (m.keys.b > m.cam.b) problems.push(`${name}: the strip runs out of the window (${Math.round(m.keys.b)} > ${Math.round(m.cam.b)})`);
            if (Math.abs((m.screen.r - m.screen.l) * 9 / 16 - (m.screen.b - m.screen.t)) > 1.5) problems.push(`${name}: the picture isn't 16:9`);
            if (m.rows > 1) problems.push(`${name}: the keys wrap onto ${m.rows} rows (${m.fit})`);
            if (editing && m.done.l < m.label.r + 4) problems.push(`${name}: Done overlaps the label`);
            if (editing && (m.hint.b > m.screen.b || m.hint.t < m.label.b)) problems.push(`${name}: the move hint overlaps the label or leaves the picture`);
            if (editing && m.hint.b - m.hint.t > 70) problems.push(`${name}: the move hint wraps`);
            if (SHOTS) {
              win.webContents.invalidate();
              await sleep(150);
              const img = await win.webContents.capturePage();
              fs.writeFileSync(path.join(SHOTS, `${where}-${size}${editing ? '-move' : ''}.png`), img.toPNG());
            }
            console.log(`      ${name}: ${m.fit || 'as is'}`);
          }
        }
      }
      assert.deepStrictEqual(problems, []);
    });

    win.destroy();
    await sleep(200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Electron may still hold the profile */ }
    const failed = results.filter(([ok]) => !ok);
    const summary = failed.length ? `${failed.length} of ${results.length} failed` : `kill cam page tests passed (${results.length})`;
    process.stdout.write(`${summary}
`, () => app.exit(failed.length ? 1 : 0)); // app.exit doesn't wait for a piped stdout
  }

  app.on('window-all-closed', () => {}); // main() exits, with the result
  app.whenReady().then(main).catch((err) => { console.error(err); app.exit(1); });
}
