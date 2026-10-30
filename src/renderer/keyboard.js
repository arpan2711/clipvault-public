// A Wooting 80HE (ANSI) keyboard and a mouse, drawn with DOM elements, for showing recorded
// key presses in the player. Geometry ported from rock_mod_arp/docs/keymap-wooting-80he.py.
(function () {
  // Rows of [cap label, width in key units, gap before it, tracker key name if not the label].
  // 84 keys; the nav cluster is the 80HE's 2x3 block (no PgUp / PgDn, they're on the Fn layer).
  const ROWS = [
    [['Esc', 1, 0], ['F1', 1, 1], ['F2', 1, 0], ['F3', 1, 0], ['F4', 1, 0], ['F5', 1, 0.5], ['F6', 1, 0], ['F7', 1, 0], ['F8', 1, 0],
      ['F9', 1, 0.5], ['F10', 1, 0], ['F11', 1, 0], ['F12', 1, 0], ['PrtSc', 1, 0.25], ['Pause', 1, 0]],
    [['`', 1, 0], ['1', 1, 0], ['2', 1, 0], ['3', 1, 0], ['4', 1, 0], ['5', 1, 0], ['6', 1, 0], ['7', 1, 0], ['8', 1, 0], ['9', 1, 0], ['0', 1, 0],
      ['-', 1, 0], ['=', 1, 0], ['Backspace', 2, 0], ['Insert', 1, 0.25], ['Home', 1, 0]],
    [['Tab', 1.5, 0], ['Q', 1, 0], ['W', 1, 0], ['E', 1, 0], ['R', 1, 0], ['T', 1, 0], ['Y', 1, 0], ['U', 1, 0], ['I', 1, 0], ['O', 1, 0], ['P', 1, 0],
      ['[', 1, 0], [']', 1, 0], ['\\', 1.5, 0], ['Delete', 1, 0.25], ['End', 1, 0]],
    [['Caps', 1.75, 0], ['A', 1, 0], ['S', 1, 0], ['D', 1, 0], ['F', 1, 0], ['G', 1, 0], ['H', 1, 0], ['J', 1, 0], ['K', 1, 0], ['L', 1, 0], [';', 1, 0],
      ["'", 1, 0], ['Enter', 2.25, 0]],
    [['Shift', 2.25, 0, 'LShift'], ['Z', 1, 0], ['X', 1, 0], ['C', 1, 0], ['V', 1, 0], ['B', 1, 0], ['N', 1, 0], ['M', 1, 0], [',', 1, 0], ['.', 1, 0], ['/', 1, 0],
      ['Shift', 1.75, 0, 'RShift'], ['↑', 1, 1.25, 'Up']],
    [['Ctrl', 1.25, 0, 'LCtrl'], ['Win', 1.25, 0, 'LWin'], ['Alt', 1.25, 0, 'LAlt'], ['', 6.25, 0, 'Space'], ['Alt', 1.25, 0, 'RAlt'], ['Fn', 1.25, 0],
      ['Ctrl', 1.25, 0, 'RCtrl'], ['←', 1, 0.5, 'Left'], ['↓', 1, 0, 'Down'], ['→', 1, 0, 'Right']],
  ];
  const FROW_GAP = 0.35; // extra space under the F-row
  const BOARD_W = 17.25;
  const BOARD_H = 6 + FROW_GAP;

  // Generic names (older recordings, or Windows not saying which side) mapped onto board keys.
  const ALIASES = { Escape: 'Esc', CapsLock: 'Caps', Shift: 'LShift', Ctrl: 'LCtrl', Alt: 'LAlt', PrintScreen: 'PrtSc', Win: 'LWin' };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (n) => `${(n * 100).toFixed(3)}%`;

  function keyboardHtml() {
    let html = '<div class="kb-board">';
    ROWS.forEach((row, r) => {
      const y = r === 0 ? 0 : r + FROW_GAP;
      let x = 0;
      for (const [label, w, gap, id] of row) {
        x += gap;
        html += `<div class="kb-key" style="left:${pct(x / BOARD_W)};top:${pct(y / BOARD_H)};width:${pct(w / BOARD_W)};height:${pct(1 / BOARD_H)}">`
          + `<div class="cap${label.length > 2 ? ' small' : ''}" data-k="${esc(id || label)}"><span>${esc(label)}</span><i></i></div></div>`;
        x += w;
      }
    });
    return `${html}</div>`;
  }

  function mouseHtml() {
    return `<svg class="mouse" viewBox="0 0 64 100" aria-label="Mouse">
      <path class="body" d="M32 2C15 2 5 15 5 32v34c0 18 12 32 27 32s27-14 27-32V32C59 15 49 2 32 2z"/>
      <path class="btn" data-k="MouseL" d="M30.5 3.5C16.5 4.3 6.5 15.5 6.5 32v9h24z"><title>Left button</title></path>
      <path class="btn" data-k="MouseR" d="M33.5 3.5c14 .8 24 12 24 28.5v9h-24z"><title>Right button</title></path>
      <rect class="btn" data-k="MouseM" x="28" y="12" width="8" height="18" rx="4"><title>Wheel click</title></rect>
      <rect class="btn" data-k="MouseX2" x="1" y="45" width="6" height="12" rx="2.5"><title>Side button (forward)</title></rect>
      <rect class="btn" data-k="MouseX1" x="1" y="60" width="6" height="12" rx="2.5"><title>Side button (back)</title></rect>
    </svg>`;
  }

  window.Keyboard = { keyboardHtml, mouseHtml, normalize: (k) => ALIASES[k] || k };
})();
