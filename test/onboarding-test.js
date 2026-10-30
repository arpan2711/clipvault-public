// First-run setup: the choices → settings mapping (src/renderer/js/lib/onboarding.js), checked
// against the real settings validation (src/settings.js).
//   node test/onboarding-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { Settings } = require('../src/settings');

(async () => {
  const ob = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'lib', 'onboarding.js')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-onboarding-'));
  const fresh = () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'p-'));
    return new Settings(dir, path.join(dir, 'Videos'));
  };
  try {
    // A first run, and a settings file from before the setup existed, both show it; after it, not.
    const st = fresh();
    assert.strictEqual(st.get().onboarded, 0);
    assert.strictEqual(st.get().notifyInGame, true);
    assert.strictEqual(ob.needsOnboarding(st.get()), true);
    assert.strictEqual(ob.needsOnboarding({ saveDir: 'x' }), true);
    assert.strictEqual(ob.needsOnboarding({ onboarded: ob.ONBOARDING_VERSION }), false);

    // The defaults are the Balanced preset, and Finish without changes only marks the setup done.
    const d = st.get();
    assert.strictEqual(ob.presetOf(d), 'balanced');
    const c0 = ob.initialChoices(d);
    const { changed } = st.update(ob.choicesToPatch(c0, d));
    assert.deepStrictEqual(changed, ['onboarded']);
    assert.strictEqual(st.get().onboarded, ob.ONBOARDING_VERSION);
    assert.strictEqual(ob.needsOnboarding(st.get()), false);

    // Every preset survives the settings validation unchanged, and is recognised again.
    for (const p of ob.QUALITY_PRESETS) {
      const s = fresh();
      const before = s.get();
      s.update(ob.choicesToPatch({ ...ob.initialChoices(before), quality: p.id }, before));
      const v = s.get();
      assert.strictEqual(String(v.resolution), String(p.values.resolution), p.id);
      assert.strictEqual(v.fps, p.values.fps, p.id);
      assert.strictEqual(v.quality, p.values.quality, p.id);
      assert.strictEqual(ob.presetOf(v), p.id);
    }
    // Settings that match no preset stay as they are.
    const custom = { ...d, resolution: '1440', fps: 144, quality: 'ultra' };
    assert.strictEqual(ob.presetOf(custom), 'custom');
    const pc = ob.choicesToPatch(ob.initialChoices(custom), custom);
    assert.ok(!('resolution' in pc) && !('fps' in pc) && !('quality' in pc));

    // Every buffer mode, replay length, storage limit, cam size and corner is a valid setting.
    for (const m of ob.BUFFER_MODES) {
      for (const len of ob.REPLAY_LENGTHS) {
        const s = fresh();
        s.update(ob.choicesToPatch({ ...ob.initialChoices(s.get()), bufferMode: m.id, replaySeconds: len }, s.get()));
        assert.strictEqual(s.get().bufferMode, m.id);
        assert.strictEqual(s.get().replaySeconds, len);
      }
    }
    for (const g of ob.STORAGE_LIMITS) {
      const s = fresh();
      s.update(ob.choicesToPatch({ ...ob.initialChoices(s.get()), storageLimitGB: g }, s.get()));
      assert.strictEqual(s.get().storageLimitGB, g);
    }
    for (const [size] of ob.CAM_SIZES) {
      for (const corner of ['auto', ...ob.CAM_CORNERS]) {
        for (const screen of ['auto', 'other', 'game']) {
          const s = fresh();
          s.update(ob.choicesToPatch({ ...ob.initialChoices(s.get()), killCamSize: size, killCamCorner: corner, killCamScreen: screen }, s.get()));
          const L = s.get().league;
          assert.deepStrictEqual([L.killCamSize, L.killCamCorner, L.killCamScreen], [size, corner, screen]);
        }
      }
    }

    // A full set of changes lands where Settings shows it.
    const s2 = fresh();
    const c = {
      ...ob.initialChoices(s2.get()),
      killCam: false, killCamKills: true, bufferMode: 'games', replaySeconds: 60, leagueClips: false, recordMatch: true,
      mic: true, overlay: true, notifyInGame: false, notifyMonitor: 1, clipSound: false, saveDir: path.join(tmp, 'Clips'),
      storageLimitGB: 200, quality: 'small', startWithWindows: true,
    };
    s2.update(ob.choicesToPatch(c, s2.get()));
    const v = s2.get();
    assert.strictEqual(v.league.killCam, false);
    assert.strictEqual(v.league.killCamKills, true);
    assert.strictEqual(v.league.enabled, false);
    assert.strictEqual(v.league.recordMatch, true);
    assert.strictEqual(v.league.deaths, true, 'auto clip moments are left alone');
    assert.strictEqual(v.bufferMode, 'games');
    assert.strictEqual(v.replaySeconds, 60);
    assert.strictEqual(v.mic, true);
    assert.strictEqual(v.notifyInGame, false);
    assert.strictEqual(v.notifyMonitor, 1);
    assert.strictEqual(v.clipSound, false);
    assert.strictEqual(v.saveDir, path.join(tmp, 'Clips'));
    assert.strictEqual(v.storageLimitGB, 200);
    assert.strictEqual(v.startWithWindows, true);
    assert.deepStrictEqual([v.resolution, v.fps, v.quality], ['1080', 30, 'medium']);
    // The file on disk has it too.
    const disk = JSON.parse(fs.readFileSync(s2.file, 'utf8'));
    assert.strictEqual(disk.onboarded, ob.ONBOARDING_VERSION);
    assert.strictEqual(disk.notifyInGame, false);

    // A dragged spot wins over size and corner, so picking new ones clears it; keeping them keeps it.
    const spot = { display: 0, x: 0.1, y: 0.1, w: 0.3 };
    const withSpot = { ...d, league: { ...d.league, killCamSpot: spot } };
    assert.ok(!('killCamSpot' in ob.choicesToPatch(ob.initialChoices(withSpot), withSpot).league));
    assert.strictEqual(ob.choicesToPatch({ ...ob.initialChoices(withSpot), killCamCorner: 'top-right' }, withSpot).league.killCamSpot, null);

    // The preview's placement follows killcam.js.
    assert.deepStrictEqual(ob.camPlacement({ killCamScreen: 'auto', killCamCorner: 'auto' }, 2), { screen: 'other', corner: 'bottom-right', off: false });
    assert.deepStrictEqual(ob.camPlacement({ killCamScreen: 'auto', killCamCorner: 'auto' }, 1), { screen: 'game', corner: 'top-left', off: false });
    assert.deepStrictEqual(ob.camPlacement({ killCamScreen: 'game', killCamCorner: 'bottom-left' }, 2), { screen: 'game', corner: 'bottom-left', off: false });
    assert.strictEqual(ob.camPlacement({ killCamScreen: 'other', killCamCorner: 'auto' }, 1).off, true);

    // The death cam needs League moments: auto clips or a full match recording.
    assert.strictEqual(ob.camNeedsClips({ killCam: true, leagueClips: false, recordMatch: false }), true);
    assert.strictEqual(ob.camNeedsClips({ killCam: true, leagueClips: false, recordMatch: true }), false);
    assert.strictEqual(ob.fmtLength(30), '30 s');
    assert.strictEqual(ob.fmtLength(120), '2 min');
    assert.strictEqual(ob.fmtLength(90), '1 min 30 s');

    console.log('onboarding tests: PASS');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('FAIL:', err.stack || err.message);
  process.exit(1);
});
