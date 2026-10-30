// On-screen notification shown over games, plus the small UI sounds.
const ICONS = {
  ok: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  rec: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/></svg>',
  error: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  info: '<svg viewBox="0 0 24 24"><path d="M12 11v6M12 7.5h.01"/></svg>',
  // only work in progress spins: "Saving the last 30 s…", "Saving recording…"
  saving: '<svg viewBox="0 0 24 24" class="spin"><path d="M12 4a8 8 0 1 0 8 8"/></svg>',
};

const toastEl = document.getElementById('toast');
let hideTimer;

window.clipvault.onToast(({ text, kind, sticky, brief }) => {
  const k = ICONS[kind] ? kind : 'info';
  toastEl.className = `toast ${k}`;
  document.getElementById('badge').innerHTML = ICONS[k];
  document.getElementById('text').textContent = text;
  requestAnimationFrame(() => toastEl.classList.add('show'));
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => toastEl.classList.remove('show'), sticky ? 9800 : brief ? 1800 : 3000);
});

let ctx;
function tone(freq, at, dur, type = 'sine', peak = 0.08) {
  ctx = ctx || new AudioContext();
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

const SOUNDS = {
  clip: () => { tone(988, 0, 0.11); tone(1480, 0.08, 0.16); },
  start: () => { tone(740, 0, 0.14); },
  stop: () => { tone(740, 0, 0.1); tone(494, 0.09, 0.16); },
  error: () => { tone(196, 0, 0.22, 'triangle', 0.1); },
};

window.clipvault.onSound((name) => { if (SOUNDS[name]) SOUNDS[name](); });
