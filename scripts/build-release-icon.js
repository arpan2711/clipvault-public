// Writes build/icon.ico for the release build (npm run dist) from the same procedural icon the
// app draws for its tray and windows (src/icon.js), so the repo needs no binary image assets.
const fs = require('fs');
const path = require('path');
const { ico } = require('../src/icon');

const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, ico());
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
