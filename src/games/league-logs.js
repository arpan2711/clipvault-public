// One log file per League match in the profile's league-logs folder: who you were matched as, the
// raw game events and what was clipped. Handy when a moment wasn't picked up, and the record later
// versions use to fill in a match's details.
const fs = require('fs');
const path = require('path');

const KEEP = 20;
const fileName = (date) => `${date.toISOString().replace(/[:.]/g, '-')}.jsonl`; // sorts by time

// Keeps the newest `keep` logs.
function prune(dir, keep = KEEP) {
  const logs = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  for (const f of logs.slice(0, Math.max(0, logs.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
}

// Starts the log for a match that just began. Returns its path, or null if it can't be written.
function startMatchLog(dir, now = new Date()) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, fileName(now));
    fs.writeFileSync(file, '');
    prune(dir);
    return file;
  } catch {
    return null;
  }
}

// Older versions kept only league-last-match.log and emptied it at every match start. The first
// time this version runs, that log is copied into the folder under its match's start time.
function adoptLastLog(lastLog, dir) {
  try {
    if (fs.existsSync(dir)) return null;
    const text = fs.readFileSync(lastLog, 'utf8');
    const first = JSON.parse(text.split('\n', 1)[0]);
    const at = new Date(first && first.at);
    if (Number.isNaN(at.getTime())) return null;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, fileName(at));
    fs.writeFileSync(file, text);
    return file;
  } catch {
    return null;
  }
}

module.exports = { startMatchLog, adoptLastLog, prune, KEEP };
