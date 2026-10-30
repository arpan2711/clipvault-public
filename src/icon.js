// Procedural app icon, so the app needs no binary image assets: renders RGBA pixels
// and encodes them as PNG (for Electron) or ICO (for Windows shortcuts).
const zlib = require('zlib');

// Flat fills from the design tokens: --accent, --rec and --gray-400 (off is dimmer than on).
const COLORS = {
  active: [59, 106, 197],
  recording: [237, 65, 59],
  off: [91, 94, 97],
};

function renderRGBA(size, variant = 'active') {
  const [r, g, b] = COLORS[variant] || COLORS.active;
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const R = size / 2 - Math.max(0.5, size * 0.03);
  const ringOuter = R * 0.6;
  const ringInner = R * 0.44;
  const dot = R * 0.24;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const cover = (radius) => Math.max(0, Math.min(1, radius - d + 0.5));
      const disc = cover(R);
      if (disc <= 0) continue;
      const white = Math.max(cover(ringOuter) - cover(ringInner), cover(dot));
      const i = (y * size + x) * 4;
      const base = [r, g, b];
      px[i] = Math.round(base[0] + (255 - base[0]) * white);
      px[i + 1] = Math.round(base[1] + (255 - base[1]) * white);
      px[i + 2] = Math.round(base[2] + (255 - base[2]) * white);
      px[i + 3] = Math.round(255 * disc);
    }
  }
  return px;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, variant) {
  const rgba = renderRGBA(size, variant);
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO with embedded PNG images (supported since Windows Vista).
function ico(sizes = [16, 24, 32, 48, 64, 128, 256], variant = 'active') {
  const images = sizes.map((s) => png(s, variant));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  images.forEach((data, i) => {
    const e = Buffer.alloc(16);
    e[0] = sizes[i] >= 256 ? 0 : sizes[i];
    e[1] = sizes[i] >= 256 ? 0 : sizes[i];
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  });
  return Buffer.concat([header, ...entries, ...images]);
}

module.exports = { png, ico };
