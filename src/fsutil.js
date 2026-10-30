// Small file helpers shared by the clip index and the champion icon cache.
const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

// Writes a file so a crash can never leave it half-written: the data goes to a temporary file
// next to it, which then replaces the target in one rename.
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fsp.writeFile(tmp, data);
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Reads a JSON file, falling back to its backup copy. An unreadable file is renamed to
// "<name>.corrupt-<time>" so nothing ever overwrites it, and the backup is used instead.
// Returns { data, from: 'file' | 'backup' | null }.
function readJsonWithBackup(file, backup, { log = () => {} } = {}) {
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* missing: first run, or lost */ }
  if (text !== null) {
    try {
      return { data: JSON.parse(text), from: 'file' };
    } catch {
      const kept = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, kept);
        log(`${path.basename(file)} could not be read; kept it as ${path.basename(kept)}`);
      } catch { /* leave it where it is */ }
    }
  }
  try {
    const data = JSON.parse(fs.readFileSync(backup, 'utf8'));
    if (text !== null || fs.existsSync(backup)) log(`restored ${path.basename(file)} from ${path.basename(backup)}`);
    return { data, from: 'backup' };
  } catch {
    return { data: null, from: null };
  }
}

// True when `file` is inside `dir` (case-insensitive, as Windows paths are).
function isInside(file, dir) {
  return path.resolve(file).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep);
}

module.exports = { writeAtomic, readJsonWithBackup, isInside };
