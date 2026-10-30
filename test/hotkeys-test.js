// Tests reading hotkeys from cvhelper's key stream (League turns off registered hotkeys while it's
// in front): parsing accelerators, exact modifiers, key repeats.  Usage: node test/hotkeys-test.js
const assert = require('assert');
const { HotkeyMatcher, parseAccelerator } = require('../src/inputs');
const { DEFAULT_HOTKEYS } = require('../src/settings');

assert.deepStrictEqual(parseAccelerator('Ctrl+Shift+Alt+F'), { mods: 'alt+ctrl+shift', vk: 0x46 });
assert.deepStrictEqual(parseAccelerator('Alt+F10'), { mods: 'alt', vk: 0x79 });
assert.deepStrictEqual(parseAccelerator('CommandOrControl+Space'), { mods: 'ctrl', vk: 0x20 });
assert.strictEqual(parseAccelerator('Ctrl+Shift'), null); // no key
assert.strictEqual(parseAccelerator(''), null);
// Every default hotkey can be read from the key stream.
for (const accel of Object.values(DEFAULT_HOTKEYS)) assert.ok(parseAccelerator(accel), accel);

const fired = [];
const m = new HotkeyMatcher((a) => fired.push(a));
m.setHotkeys(DEFAULT_HOTKEYS);
const key = (k, d) => m.onKey({ t: 0, k, d });
const press = (...vks) => { for (const k of vks) key(k, true); for (const k of [...vks].reverse()) key(k, false); };

// Alt+F10 saves a clip; the generic (0x12) and left (0xA4) Alt both count.
press(0x12, 0x79);
press(0xA4, 0x79);
assert.deepStrictEqual(fired.splice(0), ['saveClip', 'saveClip']);
// Ctrl+Shift+Alt+R replays the death cam, in any modifier order, left or right keys.
press(0xA2, 0xA0, 0xA4, 0x52);
press(0xA5, 0xA3, 0xA1, 0x52);
assert.deepStrictEqual(fired.splice(0), ['camReplay', 'camReplay']);
// Exact modifiers: Ctrl+Alt+F10 isn't Alt+F10, R alone (an ability) is nothing.
press(0xA2, 0xA4, 0x79);
press(0x52);
assert.deepStrictEqual(fired.splice(0), []);
// Holding the keys (Windows repeats key-down) fires once.
key(0xA4, true); key(0x79, true); key(0x79, true); key(0x79, true); key(0x79, false); key(0xA4, false);
assert.deepStrictEqual(fired.splice(0), ['saveClip']);
// Mouse events are ignored.
m.onKey({ t: 0, m: 1, d: true });
assert.deepStrictEqual(fired, []);
// A key let go while another window was in front (Alt+Tab) never reaches the key stream: after a
// reset (the game lost the front), F10 alone is F10, not Alt+F10; Alt+F10 still works.
key(0xA4, true); key(0x09, true); // Alt+Tab away; the releases happen outside the game
m.reset();
press(0x79);
assert.deepStrictEqual(fired.splice(0), []);
press(0xA4, 0x79);
assert.deepStrictEqual(fired.splice(0), ['saveClip']);
// The same when cvhelper reports the releases itself as the game loses the front.
key(0xA2, true); key(0xA0, true); key(0x1B, true); key(0xA2, false); key(0xA0, false); key(0x1B, false); // Ctrl+Shift+Esc
press(0xA4, 0x79);
assert.deepStrictEqual(fired.splice(0), ['saveClip'], 'Ctrl is not stuck');
// Hotkeys changed in Settings mid-match apply to the key stream at once.
m.setHotkeys({ ...DEFAULT_HOTKEYS, saveClip: 'Ctrl+Shift+Alt+F11' });
press(0xA4, 0x79);
press(0xA2, 0xA0, 0xA4, 0x7A);
assert.deepStrictEqual(fired.splice(0), ['saveClip']);
m.setHotkeys(DEFAULT_HOTKEYS);

// The gate: a held registered hotkey (first repeat after the keyboard delay, then every 30 ms)
// runs once; the same press from both ways in runs once; a new press after a pause runs again.
const { makeHotkeyGate } = require('../src/inputs');
let clock = 0;
const gate = makeHotkeyGate(1100, () => clock);
const runs = [];
const at = (t, a = 'toggleRecording') => { clock = t; if (gate(a)) runs.push([a, t]); };
at(0); at(5); // globalShortcut and the key stream
at(1000); for (let t = 1030; t < 3000; t += 30) at(t); // held for 3 s with a 1 s repeat delay
at(4500); // pressed again
at(4600, 'saveClip'); // another hotkey isn't held back
assert.deepStrictEqual(runs, [['toggleRecording', 0], ['toggleRecording', 4500], ['saveClip', 4600]]);

// cvhelper exiting mid-match (a crash, or killed) is started again; stop() ends that.
const { InputTracker } = require('../src/inputs');
const { paths } = require('../src/ffmpeg');
paths.helper = process.execPath; // "node input <exe>": exits at once, like a crashing helper
(async () => {
  const t = new InputTracker({ store: false, restartDelayMs: 50 });
  let exits = 0;
  let restarts = 0;
  t.on('error', () => {});
  t.on('exit', () => { exits++; });
  t.on('restart', () => { restarts++; });
  t.start('League of Legends.exe');
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(restarts >= 2 && exits >= 2, `restarted after exiting (${restarts} restarts, ${exits} exits)`);
  t.stop();
  const before = restarts;
  await new Promise((r) => setTimeout(r, 800));
  assert.strictEqual(restarts, before, 'not after stop()');
  assert.strictEqual(t.active, false);
  console.log('hotkey tests: PASS');
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
