// Readable titles (src/renderer/js/lib/titles.js).
//   node test/titles-test.js
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const { describeName, displayTitle } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'lib', 'titles.js')).href);
  const t = (name, extra = {}) => displayTitle({ name, ...extra });

  assert.strictEqual(t('League of Legends 2026-10-17 22-55-13 Double kill', { type: 'highlight', label: 'Double kill' }), 'Double kill');
  assert.strictEqual(t('League of Legends 2026-10-17 22-49-09 Kill + Earth dragon', { type: 'highlight' }), 'Kill + Earth dragon');
  assert.strictEqual(t('League of Legends 2026-10-17 23-04-55 Evelynn Defeat Match', { type: 'recording', stats: {} }), 'Full match');
  assert.strictEqual(t('Sekiro 2026-10-15 22-40-10', { type: 'recording' }), 'Recording');
  assert.strictEqual(t('League of Legends 2026-10-17 22-36-14 Evelynn Map', { type: 'map' }), 'Match minimap');
  assert.strictEqual(t('League of Legends 2026-10-17 23-10-00 Highlight video', { type: 'montage' }), 'Highlight video');
  assert.strictEqual(t('League of Legends 2026-10-16 20-11-02', { type: 'clip' }), 'Instant replay');
  assert.strictEqual(t('League of Legends 2026-10-16 20-11-02 (2)', { type: 'clip' }), 'Instant replay');
  assert.strictEqual(t('Sekiro 2026-10-15 22-40-10', { type: 'clip', label: 'Bookmark' }), 'Bookmark');
  // Renamed by the user: keep the name.
  assert.strictEqual(t('Insane baron steal', { type: 'highlight', label: 'Baron' }), 'Insane baron steal');
  // Trimmed copies: same title, flagged.
  const d = describeName({ name: 'League of Legends 2026-10-17 22-55-13 Double kill (trim 2)', type: 'highlight', label: 'Double kill' });
  assert.deepStrictEqual(d, { title: 'Double kill', trimmed: true, renamed: false });

  console.log('title tests: PASS');
})().catch((err) => {
  console.error('FAIL:', err.stack || err.message);
  process.exit(1);
});
