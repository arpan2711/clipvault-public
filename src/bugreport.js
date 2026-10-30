// Bug reports: the text of a report (what happened, steps, diagnostics) and the prefilled GitHub
// "new issue" link. Everything that leaves the PC goes through redact() first.
const { REPO } = require('./update');

const LOG_LINES = 200;
const URL_MAX = 7500; // GitHub and browsers handle about 8 KB of URL; keep some room

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Removes what could identify you: the user folder name in paths (C:\Users\<name> ->
// C:\Users\…, either slash, any drive), that name elsewhere, the League names you play as,
// anything shaped like a Riot ID (Name#TAG) and email addresses.
function redact(text, { user = '', names = [] } = {}) {
  let out = String(text ?? '');
  // A folder name with spaces counts only when a separator follows ("C:\Users\Some One\..."), so
  // the arguments after a bare "C:\Users\bob" in a command line stay.
  out = out.replace(/([A-Za-z]:)?([\\/]{1,2})Users\2(?:[^\\/\s"'<>|:*?]+(?: [^\\/\s"'<>|:*?]+)*(?=[\\/])|[^\\/\s"'<>|:*?]+)/gi,
    (_m, drive, sep) => `${drive || ''}${sep}Users${sep}…`);
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  // Riot IDs: a game name (no spaces at its ends) followed by #TAG of 2-5 letters / digits.
  out = out.replace(/[^\s#"'`,;:()[\]{}<>=]{3,16}#[A-Za-z0-9]{2,5}\b/g, '[Riot ID]');
  const words = [...new Set([user, ...names].map((n) => String(n || '').trim()).filter((n) => n.length >= 3))]
    .sort((a, b) => b.length - a.length);
  // Whole words only, so a short name doesn't eat parts of other words.
  for (const w of words) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(w)}(?![\\p{L}\\p{N}_])`, 'giu'), w === user ? '[user]' : '[player]');
  return out;
}

// The last n lines of a log.
function logTail(text, n = LOG_LINES) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  return lines.slice(-n).join('\n');
}

// facts: { app, windows, electron, chrome, node, ffmpeg, gpu, encoder, codec, encoders, capture, screens,
// settings: { key: value } } -> "Label: value" lines, in a fixed order.
function systemLines(facts = {}) {
  const f = facts;
  const lines = [
    ['ClipVault', f.app], ['Windows', f.windows], ['Electron', f.electron && `${f.electron} (Chrome ${f.chrome || '?'}, Node ${f.node || '?'})`],
    ['FFmpeg', f.ffmpeg], ['GPU', f.gpu], ['Encoder', f.encoder && `${f.encoder}${f.codec ? ` · ${f.codec.toUpperCase()}` : ''}${f.encoders ? ` (available: ${f.encoders})` : ''}`],
    ['Capture', f.capture], ['Screens', f.screens],
  ].filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${v}`);
  const s = f.settings || {};
  const keys = Object.keys(s);
  if (keys.length) lines.push(`Settings: ${keys.map((k) => `${k}=${s[k]}`).join(', ')}`);
  return lines;
}

const firstLine = (s) => String(s || '').trim().split('\n')[0].trim();

function issueTitle(what) {
  const t = firstLine(what) || 'Bug report';
  return t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t;
}

// The whole report as plain text (for the clipboard and the saved file).
function fullReport({ what, steps, facts, log, diagnostics = true }, opts) {
  const parts = [`ClipVault bug report (${new Date().toISOString().slice(0, 10)})`, '', 'What happened:', String(what || '').trim()];
  if (String(steps || '').trim()) parts.push('', 'Steps to reproduce:', String(steps).trim());
  if (diagnostics) {
    parts.push('', 'System:', ...systemLines(facts));
    if (log) parts.push('', `Log (last ${LOG_LINES} lines of clipvault.log):`, log);
  }
  return redact(parts.join('\n'), opts);
}

// The issue's body: the description and system info, short enough for a link. The log tail
// doesn't fit; the body asks the reporter to paste or attach the full report.
function issueBody({ what, steps, facts, diagnostics = true }, opts) {
  const section = (title, text) => `### ${title}\n\n${text}\n`;
  const extra = diagnostics
    ? `${section('System', systemLines(facts).map((l) => `- ${l}`).join('\n'))}\n`
      + section('Full diagnostics', 'ClipVault copied the full report (with the last lines of its log) to your clipboard. '
        + 'Paste it below, or attach the report file you saved:\n\n<!-- paste here -->')
    : '';
  const build = (w, st) => redact([
    section('What happened', w || '(not filled in)'),
    st ? section('Steps to reproduce', st) : '',
    extra,
  ].filter(Boolean).join('\n'), opts);
  // Long descriptions are cut so the link stays under the limit (the full text is on the clipboard).
  let w = String(what || '').trim();
  let st = String(steps || '').trim();
  let body = build(w, st);
  const link = (b) => issueUrl(issueTitle(what), b);
  while (link(body).length > URL_MAX && (w.length > 200 || st.length > 200)) {
    if (st.length > 200) st = `${st.slice(0, Math.floor(st.length * 0.7))}… (cut, full text in the report)`;
    else w = `${w.slice(0, Math.floor(w.length * 0.7))}… (cut, full text in the report)`;
    body = build(w, st);
  }
  return body;
}

function issueUrl(title, body, repo = REPO) {
  const q = new URLSearchParams({ title, body, labels: 'bug' });
  return `https://github.com/${repo}/issues/new?${q.toString().replace(/\+/g, '%20')}`;
}

// Everything a submit needs: the link to open and the full text to copy / save.
function buildReport(input, opts) {
  const title = redact(issueTitle(input.what), opts);
  return { url: issueUrl(title, issueBody(input, opts)), text: fullReport(input, opts) };
}

module.exports = { redact, logTail, systemLines, issueTitle, fullReport, issueBody, issueUrl, buildReport, LOG_LINES, URL_MAX };
