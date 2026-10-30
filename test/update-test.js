// Update check (src/update.js) and bug report text (src/bugreport.js).
//   node test/update-test.js
const assert = require('assert');
const { compareVersions, parseVersion, newerRelease, safeReleaseUrl, shortNotes, UpdateChecker, REPO } = require('../src/update');
const { redact, logTail, buildReport, issueBody, URL_MAX } = require('../src/bugreport');

(async () => {
  // ---------------------------------------------------------------- versions
  assert.deepStrictEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, pre: '' });
  assert.deepStrictEqual(parseVersion('1.2'), { major: 1, minor: 2, patch: 0, pre: '' });
  assert.deepStrictEqual(parseVersion('2.0.0-beta.1+build5'), { major: 2, minor: 0, patch: 0, pre: 'beta.1' });
  assert.strictEqual(parseVersion('latest'), null);
  assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('v1.0.1', '1.0.0'), 1);
  assert.strictEqual(compareVersions('1.0.0', '1.0.10'), -1);
  assert.strictEqual(compareVersions('1.10.0', '1.9.9'), 1); // numbers, not text
  assert.strictEqual(compareVersions('2.0.0', '10.0.0'), -1);
  assert.strictEqual(compareVersions('1.1', '1.1.0'), 0);
  assert.strictEqual(compareVersions('1.1.0-beta', '1.1.0'), -1);
  assert.strictEqual(compareVersions('1.1.0-beta.2', '1.1.0-beta.10'), -1);
  assert.strictEqual(compareVersions('1.1.0-alpha', '1.1.0-beta'), -1);
  assert.strictEqual(compareVersions('1.1.0-beta', '1.0.9'), 1);

  // ---------------------------------------------------------------- releases
  const rel = (tag, extra = {}) => ({ tag_name: tag, html_url: `https://github.com/${REPO}/releases/tag/${tag}`, body: '## New\n- **Faster** clips\n- [Docs](https://x.y)', ...extra });
  const r = newerRelease(rel('v1.1.0'), '1.0.0');
  assert.strictEqual(r.version, '1.1.0');
  assert.strictEqual(r.url, `https://github.com/${REPO}/releases/tag/v1.1.0`);
  assert.strictEqual(r.notes, 'New\n- Faster clips\n- Docs');
  assert.strictEqual(newerRelease(rel('v1.0.0'), '1.0.0'), null);
  assert.strictEqual(newerRelease(rel('v0.9.0'), '1.0.0'), null);
  assert.strictEqual(newerRelease(rel('v2.0.0-rc.1'), '1.0.0'), null, 'prereleases are ignored by default');
  assert.strictEqual(newerRelease(rel('v2.0.0', { prerelease: true }), '1.0.0'), null);
  assert.strictEqual(newerRelease(rel('v2.0.0-rc.1'), '1.0.0', { prereleases: true }).version, '2.0.0-rc.1');
  assert.strictEqual(newerRelease(rel('v2.0.0', { draft: true }), '1.0.0'), null);
  assert.strictEqual(newerRelease(rel('nightly'), '1.0.0'), null);
  // Only github.com pages are opened; anything else falls back to the releases page.
  assert.strictEqual(newerRelease(rel('v2.0.0', { html_url: 'https://evil.example/x' }), '1.0.0').url, `https://github.com/${REPO}/releases/latest`);
  assert.strictEqual(safeReleaseUrl('http://github.com/a'), null);
  assert.strictEqual(safeReleaseUrl('https://github.com.evil.io/a'), null);
  assert.strictEqual(safeReleaseUrl('javascript:alert(1)'), null);
  assert.ok(shortNotes('x'.repeat(2000)).length <= 600);

  // ---------------------------------------------------------------- the checker
  const checker = (fetchJson) => new UpdateChecker({ current: '1.0.0', fetchJson });
  const http = (status) => () => Promise.reject(Object.assign(new Error(`HTTP ${status}`), { status }));
  let c = checker(http(404)); // private repo / no releases yet: quietly "none"
  assert.strictEqual((await c.check()).status, 'none');
  c = checker(() => Promise.reject(new Error('getaddrinfo ENOTFOUND')));
  const failed = await c.check();
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.message, "Couldn't reach GitHub");
  c = checker(() => Promise.resolve(rel('v1.2.0')));
  const seen = [];
  c.on('available', (x) => seen.push(x.version));
  assert.strictEqual((await c.check()).status, 'available');
  await c.check();
  assert.deepStrictEqual(seen, ['1.2.0'], 'one notification per version');
  // Two checks at once share one request.
  let calls = 0;
  c = checker(() => { calls++; return new Promise((res) => setTimeout(() => res(rel('v1.0.0')), 20)); });
  await Promise.all([c.check(), c.check()]);
  assert.strictEqual(calls, 1);

  // ---------------------------------------------------------------- redaction
  const opts = { user: 'alex', names: ['samplename', 'SampleName#EUW'] };
  assert.strictEqual(redact('started C:\\Users\\arpan\\Desktop\\ClipVault --hidden', opts), 'started C:\\Users\\…\\Desktop\\ClipVault --hidden');
  assert.strictEqual(redact('{"file":"C:\\\\Users\\\\Some One\\\\Videos\\\\a.mp4"}'), '{"file":"C:\\\\Users\\\\…\\\\Videos\\\\a.mp4"}');
  assert.strictEqual(redact('d:/users/bob/x.txt'), 'd:/Users/…/x.txt');
  assert.strictEqual(redact('killed by SampleName with Ahri', opts), 'killed by [player] with Ahri');
  assert.strictEqual(redact('me: Someone Else#1234 joined', opts), 'me: Someone [Riot ID] joined');
  assert.strictEqual(redact('mail someone@example.com', opts), 'mail [email]');
  assert.strictEqual(redact('user alex logged in, alexandria stays', opts), 'user [user] logged in, alexandria stays');
  assert.strictEqual(redact('icons.svg#i-gear EUW1_7000000103', opts), 'icons.svg#i-gear EUW1_7000000103');

  assert.strictEqual(logTail('a\nb\nc\n', 2), 'b\nc');
  assert.strictEqual(logTail(Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\r\n')).split('\n').length, 200);

  // ---------------------------------------------------------------- the report
  const facts = { app: '1.0.0', windows: '10.0.26200', electron: '44.9.0', chrome: '140', node: '22', ffmpeg: '7.1', gpu: 'NVIDIA GeForce RTX 3060 Ti', encoder: 'nvenc', codec: 'h264', screens: '2', settings: { fps: 60, quality: 'high' } };
  const log = Array.from({ length: 200 }, (_, i) => `[2026-10-29] line ${i} C:\\Users\\arpan\\AppData`).join('\n');
  const rep = buildReport({ what: 'Clip saved without sound\nmore detail', steps: '1. Save a clip', facts, log }, opts);
  const u = new URL(rep.url);
  assert.strictEqual(u.origin + u.pathname, `https://github.com/${REPO}/issues/new`);
  assert.strictEqual(u.searchParams.get('title'), 'Clip saved without sound');
  assert.strictEqual(u.searchParams.get('labels'), 'bug');
  const body = u.searchParams.get('body');
  assert.ok(body.includes('Clip saved without sound') && body.includes('1. Save a clip') && body.includes('RTX 3060 Ti'));
  assert.ok(!body.includes('line 199'), 'the log stays out of the link');
  assert.ok(rep.text.includes('line 199') && rep.text.includes('fps=60'));
  assert.ok(!/arpan/i.test(rep.text) && !/arpan/i.test(body)); // (the repo owner in the link is arpan2711)
  // A huge description still makes a short enough link.
  const huge = buildReport({ what: 'x '.repeat(10000), steps: 'y '.repeat(10000), facts, log }, opts);
  assert.ok(huge.url.length <= URL_MAX, `link is ${huge.url.length} characters`);
  assert.ok(huge.text.length > 20000, 'the full text keeps everything');
  // Without diagnostics: no system info anywhere.
  const bare = buildReport({ what: 'Crash', facts, log, diagnostics: false }, opts);
  assert.ok(!bare.text.includes('RTX') && !bare.url.includes('RTX') && !bare.text.includes('line 1'));
  assert.ok(!issueBody({ what: 'Crash', facts, diagnostics: false }).includes('clipboard'));

  console.log('update + bug report tests: PASS');
})().catch((err) => {
  console.error('FAIL:', err.stack || err.message);
  process.exit(1);
});
