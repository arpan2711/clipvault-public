// Small HTTPS download helper shared by the icon caches (champions.js, game-icons.js).
const https = require('https');

const TIMEOUT = 10000;
const MAX_BYTES = 8 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isPng = (buf) => Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(PNG);

// The body of an https GET as a Buffer. Follows a few https redirects; rejects on any other status
// (err.status set), on a stall, or on a body over maxBytes. headers: extra request headers.
function fetchBuffer(url, { redirects = 3, maxBytes = MAX_BYTES, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let deadline = null;
    const settle = (fn, value) => { clearTimeout(deadline); fn(value); };
    const req = https.get(url, { headers: { 'User-Agent': 'ClipVault', ...headers }, timeout: TIMEOUT }, (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        let next = null;
        try { next = new URL(res.headers.location, url); } catch { /* rejected below */ }
        if (!next || next.protocol !== 'https:' || redirects <= 0) return settle(reject, new Error('bad redirect'));
        clearTimeout(deadline);
        return fetchBuffer(next.href, { redirects: redirects - 1, maxBytes, headers }).then(resolve, reject);
      }
      if (code !== 200) {
        res.resume();
        return settle(reject, Object.assign(new Error(`HTTP ${code}`), { status: code }));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) req.destroy(new Error('response too large'));
        else chunks.push(c);
      });
      res.on('end', () => (res.complete ? settle(resolve, Buffer.concat(chunks)) : settle(reject, new Error('connection closed early'))));
      res.on('error', (err) => settle(reject, err));
    });
    // The socket timeout catches stalls; the deadline catches a server that trickles bytes.
    deadline = setTimeout(() => req.destroy(new Error('timed out')), TIMEOUT * 3);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => settle(reject, err));
  });
}

module.exports = { fetchBuffer, isPng };
