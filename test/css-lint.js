// Design-system lint for the UI (src/renderer and src/overlay): stops the "vibe-coded" tells from
// coming back once the redesign removed them.
//   node test/css-lint.js             check (npm run test:css)
//   node test/css-lint.js --update    lower the colour-literal baseline after removing literals
// The UI follows quickRS's design language (see css/tokens.css). Hard rules, any hit fails:
//   - text-transform: uppercase only for small-caps labels: a rule that also sets
//     font: var(--text-label) (11 px / 800, tracked), never on running text;
//   - font weights 500, 600, 700 and 800 only (the bundled Manrope weights);
//   - font sizes 11, 12, 13, 14, 16, 18, 22 and 28 px only; keycap labels in the keyboard picture
//     (.cap) and the count on a timeline pin (.tl-pin b) are the exceptions;
//   - gradients only in css/tokens.css (key faces, ivory thumbs, LEDs, the ruby lamp and the edge
//     fades are tokens there) or, where a gradient needs a value only the element knows (a range
//     input's filled part, --fill), in the rules on the allow-list GRADIENT_OK below.
// cursor: pointer is allowed: quickRS shows the hand on everything clickable.
// Ratchet: colour literals (hex, rgb(), hsl(), named colours) outside css/tokens.css may only go
// down. The allowed total is in test/css-lint-baseline.json; new colours belong in tokens.css.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN = ['src/renderer', 'src/overlay'];
const TOKENS = 'src/renderer/css/tokens.css';
const BASELINE_FILE = path.join(__dirname, 'css-lint-baseline.json');
const SIZES = new Set([11, 12, 13, 14, 16, 18, 22, 28]);
const WEIGHTS = new Set(['500', '600', '700', '800', 'inherit', 'var(--weight-regular)', 'var(--weight-semibold)', 'var(--weight-strong)', 'var(--weight-heavy)']); // the tokens are 500-800
const KEYCAP = /\.cap\b|\.tl-pin\s+b\b/;
// Component rules that may draw their own gradient: a range input's groove filled up to --fill
// (set per element by the renderer), which a :root token can't express.
const GRADIENT_OK = /::-webkit-slider-runnable-track/;
const LABEL_FONT = /^var\(--text-label\)$/;
const GRADIENT = /\b(?:repeating-)?(?:linear|radial|conic)-gradient\(/i;
const HEX = /(?<![&\w])#[0-9a-f]{3,8}\b/gi; // not &#160; entities, not ids such as #recTime
const ENCODED_HEX = /%23[0-9a-f]{3,8}\b/gi;  // data-URI colours (the <select> arrow)
const FUNC = /\b(?:rgba?|hsla?)\(/gi;
const NAMED = /\b(?:white|black|red|green|blue|yellow|orange|purple|pink|gr[ae]y|silver|navy|teal|maroon|lime|aqua|fuchsia|olive)\b/gi;

const count = (re, text) => (String(text).match(re) || []).length;
const blank = (s) => s.replace(/[^\n]/g, ' '); // keeps line numbers when cutting text out

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...files(rel));
    else if (/\.(css|html|js)$/.test(e.name)) out.push(rel);
  }
  return out.sort();
}

// Declarations of a stylesheet with their selector: [{ selector, prop, value, line }].
function declarations(css) {
  const out = [];
  const stack = [];
  const rules = []; // an id per open block, so the declarations of one rule can be grouped
  let next = 0;
  let buf = '';
  let start = 1;
  let line = 1;
  let quote = null;
  let paren = 0;
  const flush = () => {
    const text = buf.trim();
    buf = '';
    const inner = stack[stack.length - 1];
    const colon = text.indexOf(':');
    if (!text || inner === undefined || inner.startsWith('@') || colon < 1) return;
    out.push({ selector: inner, rule: rules[rules.length - 1], prop: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).trim(), line: start });
  };
  for (const ch of css) {
    if (!buf.trim()) start = line;
    if (ch === '\n') line++;
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') paren++;
    else if (ch === ')') paren--;
    if (paren === 0 && ch === '{') { stack.push(buf.trim()); rules.push(next++); buf = ''; continue; }
    if (paren === 0 && ch === '}') { flush(); stack.pop(); rules.pop(); continue; }
    if (paren === 0 && ch === ';') { flush(); continue; }
    buf += ch;
  }
  return out;
}

function checkSize(token, selector, report) {
  const m = /^(\d*\.?\d+)(px|em|rem|%|cqw|cqh|vw|vh|pt)$/.exec(token);
  if (!m) {
    if (!/^(inherit|initial|unset)$/.test(token)) report('font-size', `size "${token}" is not on the type ramp`);
    return;
  }
  if (KEYCAP.test(selector)) return;
  if (m[2] !== 'px' || !SIZES.has(Number(m[1]))) report('font-size', `${token} is not one of 11/12/13/14/16/18/22/28 px (use the --text-* tokens)`);
}

// labelRule: the declaration's rule also sets font: var(--text-label); tokens: it is in tokens.css.
function lintDeclaration(d, report, labelRule, tokens) {
  const value = d.value.replace(/\s*!important\s*$/i, '');
  if (d.prop === 'text-transform' && /uppercase/i.test(value) && !labelRule) report('uppercase', 'text-transform: uppercase outside a small-caps label (font: var(--text-label))');
  if (d.prop === 'font-weight' && !WEIGHTS.has(value.toLowerCase())) report('font-weight', `font-weight ${value} (500, 600, 700 or 800 only)`);
  if (d.prop === 'font-size') checkSize(value, d.selector, report);
  if (d.prop === 'font' && !/^(inherit|initial|unset|var\(--[\w-]+\))$/.test(value)) {
    for (const token of value.replace(/var\([^)]*\)/g, 'var').split(/\s+/)) {
      if (/^\d*\.?\d+[a-z%]+(\/\S+)?$/i.test(token)) { checkSize(token.split('/')[0], d.selector, report); break; }
      if (/^\d{3}$/.test(token) && !WEIGHTS.has(token)) report('font-weight', `font weight ${token} (500, 600, 700 or 800 only)`);
      if (/^(bold|bolder|lighter|normal)$/i.test(token)) report('font-weight', `font weight ${token} (use 500, 600, 700 or 800)`);
    }
  }
  if (GRADIENT.test(value) && !tokens && !GRADIENT_OK.test(d.selector)) report('gradient', 'gradient outside tokens.css (make it a token: --face-accent, --ivory, --led, ...)');
}

// The same rules for CSS written inside JS strings or HTML attributes.
function lintInline(text, report) {
  text.split('\n').forEach((l, i) => {
    const at = (rule, msg) => report(rule, msg, i + 1);
    if (/text-transform\s*:\s*uppercase/i.test(l)) at('uppercase', 'text-transform: uppercase in inline CSS (use a small-caps label class)');
    for (const m of l.matchAll(/font-size\s*:\s*(\d*\.?\d+)px/gi)) if (!SIZES.has(Number(m[1]))) at('font-size', `font-size ${m[1]}px in inline CSS`);
    for (const m of l.matchAll(/font-weight\s*:\s*(\d+|bold\w*)/gi)) if (!WEIGHTS.has(m[1].toLowerCase())) at('font-weight', `font-weight ${m[1]} in inline CSS`);
    if (GRADIENT.test(l)) at('gradient', 'gradient in inline CSS');
  });
}

// Lints one file's text; returns { errors: [{ file, line, rule, msg }], colours }.
function lintText(file, text) {
  const errors = [];
  let colours = 0;
  const isTokens = file === TOKENS;
  const sheet = (css) => {
    const all = declarations(css);
    const labelRules = new Set(all.filter((d) => d.prop === 'font' && LABEL_FONT.test(d.value)).map((d) => d.rule));
    for (const d of all) {
      lintDeclaration(d, (rule, msg) => errors.push({ file, line: d.line, rule, msg }), labelRules.has(d.rule), isTokens);
      if (!isTokens) {
        const words = d.value.replace(/url\([^)]*\)|var\([^)]*\)/g, ''); // not var(--red) or a URL
        colours += count(HEX, d.value) + count(ENCODED_HEX, d.value) + count(FUNC, d.value) + count(NAMED, words);
      }
    }
  };
  const inline = (code) => {
    lintInline(code, (rule, msg, line) => errors.push({ file, line, rule, msg }));
    if (!isTokens) colours += count(HEX, code) + count(FUNC, code);
  };
  if (file.endsWith('.css')) {
    sheet(text.replace(/\/\*[\s\S]*?\*\//g, blank));
  } else if (file.endsWith('.html')) {
    const html = text.replace(/<!--[\s\S]*?-->/g, blank);
    sheet(html.replace(/<style[^>]*>([\s\S]*?)<\/style>|[\s\S]/g, (m, css) => (css === undefined ? blank(m) : blank(m.slice(0, m.indexOf('>') + 1)) + css.replace(/\/\*[\s\S]*?\*\//g, blank) + blank('</style>'))));
    inline(html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, blank));
  } else {
    inline(text);
  }
  return { errors, colours };
}

// The rules must keep firing: a quick probe before linting the real files.
function selfTest() {
  const probe = lintText('probe.css', `.a { cursor: pointer; text-transform: uppercase; font-weight: 400; font-size: 15px; }
.b { font: bold 10px/1 "Segoe UI", sans-serif; background: linear-gradient(#000, #fff); color: rgba(0, 0, 0, 0.5); }
.cap { font: 600 1.9cqw/1.15 var(--font-ui); } .tl-pin b { font: 600 10px/15px var(--font-numeric); }
.ok { font: var(--text-body); font-weight: 800; font-size: 13px; cursor: pointer; color: var(--text-1); }
.label { font: var(--text-label); letter-spacing: var(--label-track); text-transform: uppercase; }
input::-webkit-slider-runnable-track { background: linear-gradient(90deg, var(--accent) var(--fill), transparent 0); }
#recTime { color: var(--text-1); } /* #fff in a comment is not a colour */`);
  assert.deepStrictEqual(probe.errors.map((e) => e.rule).sort(),
    ['font-size', 'font-size', 'font-weight', 'font-weight', 'gradient', 'uppercase']);
  assert.strictEqual(probe.colours, 3);
  assert.deepStrictEqual(lintText(TOKENS, ':root { --face: linear-gradient(#fff, #000); }').errors, []);
  const js = lintText('probe.js', "el.style.cssText = 'cursor: pointer; font-size: 10px; text-transform: uppercase'; const c = '#7c5cff'; esc('&#160;');");
  assert.deepStrictEqual(js.errors.map((e) => e.rule).sort(), ['font-size', 'uppercase']);
  assert.strictEqual(js.colours, 1);
}

selfTest();
const results = files(SCAN[0]).concat(files(SCAN[1])).map((f) => ({ file: f, ...lintText(f, fs.readFileSync(path.join(ROOT, f), 'utf8')) }));
const errors = results.flatMap((r) => r.errors);
const total = results.reduce((a, r) => a + r.colours, 0);
const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
const byFile = results.filter((r) => r.colours).map((r) => `${r.file}: ${r.colours}`).join(', ');

for (const e of errors) console.error(`${e.file}:${e.line}  [${e.rule}] ${e.msg}`);
if (process.argv.includes('--update')) {
  if (total > baseline.colourLiterals) {
    console.error(`refusing to raise the baseline from ${baseline.colourLiterals} to ${total}: move the new colours into ${TOKENS}`);
    process.exit(1);
  }
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify({ ...baseline, colourLiterals: total }, null, 2)}\n`);
  console.log(`baseline: ${baseline.colourLiterals} -> ${total} colour literals`);
  baseline.colourLiterals = total;
}
if (total > baseline.colourLiterals) {
  console.error(`colour literals outside ${TOKENS}: ${total}, more than the baseline ${baseline.colourLiterals} (${byFile}). Use a token.`);
}
if (errors.length || total > baseline.colourLiterals) {
  console.error(`css lint: FAIL (${errors.length} rule violation${errors.length === 1 ? '' : 's'})`);
  process.exit(1);
}
if (total < baseline.colourLiterals) console.log(`colour literals down to ${total} (baseline ${baseline.colourLiterals}): run "node test/css-lint.js --update" to lock it in`);
console.log(`css lint: PASS (${results.length} files, ${total} colour literals outside tokens.css: ${byFile || 'none'})`);
