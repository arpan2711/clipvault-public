// First-run setup: a full-window, step-by-step wizard shown the first time the main window opens
// (settings.onboarded missing) and from Settings → Redo setup. Each step shows a close-up of the
// real Settings row and where to change it later. Choices start from the current settings and are
// saved together on Finish; Skip (or Esc) keeps everything as it is.
import {
  ONBOARDING_VERSION, QUALITY_PRESETS, BUFFER_MODES, REPLAY_LENGTHS, STORAGE_LIMITS, CAM_SIZES, CAM_CORNERS,
  camPlacement, initialChoices, choicesToPatch, camNeedsClips, fmtLength,
} from '../lib/onboarding.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IMG = 'onboarding/';

const STEPS = [
  { id: 'welcome', name: 'Welcome' },
  { id: 'deathcam', name: 'Death cam' },
  { id: 'recording', name: 'Recording' },
  { id: 'notifications', name: 'Notifications' },
  { id: 'folder', name: 'Save folder' },
  { id: 'quality', name: 'Quality' },
  { id: 'done', name: 'Done' },
];

const CORNER_NAMES = { auto: 'Automatic', 'top-left': 'Top left', 'top-right': 'Top right', 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right' };
const SCREEN_NAMES = { auto: 'Automatic', other: 'Your other screen', game: 'Over the game' };

const crumb = (...parts) => `<span class="ob-crumb-path">${parts.map((p) => `<b>${esc(p)}</b>`).join('<span aria-hidden="true">›</span>')}</span>`;

function shot(file, alt, w, h, path, what = '') {
  return `<figure class="ob-shot"><img src="${IMG}${file}" alt="${esc(alt)}" width="${w}" height="${h}" draggable="false">
    <figcaption>${what ? `<span class="ob-crumb-what">${esc(what)}</span>` : '<span class="ob-crumb-what">Change it later</span>'}${crumb(...path)}</figcaption></figure>`;
}

// A choice card: a real radio input (arrow keys move between them; Enter goes to the next step).
function radioCard(name, value, checked, title, note, { badge = '', disabled = false, extra = '' } = {}) {
  return `<label class="ob-card${disabled ? ' disabled' : ''}"><input type="radio" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
    <span class="ob-card-body">${extra}<b><span>${esc(title)}</span>${badge ? `<em class="ob-badge">${esc(badge)}</em>` : ''}</b>${note ? `<span>${note}</span>` : ''}</span></label>`;
}

function switchRow(key, checked, title, note, { disabled = false } = {}) {
  return `<label class="ob-switch-row${disabled ? ' disabled' : ''}"><span class="ob-switch-text"><b>${esc(title)}</b>${note ? `<span>${note}</span>` : ''}</span>
    <input type="checkbox" class="switch" data-c="${key}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}></label>`;
}

function chk(key, checked, label, disabled = false) {
  return `<label class="chk"><input type="checkbox" data-c="${key}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span>${esc(label)}</span></label>`;
}

export function openOnboarding({ api, status, step = 0, redo = false, onDone, toast = () => {} }) {
  const s0 = status.settings;
  const c = initialChoices(s0);
  const screens = (status.displays || []).length || 1;
  const hk = s0.hotkeys || {};
  const encoder = (status.encoders || [])[0];
  let at = Math.max(0, Math.min(STEPS.length - 1, Number(step) || 0));
  let seen = at;
  let busy = false;

  const root = document.createElement('div');
  root.className = 'ob';
  root.id = 'onboarding';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'obTitle');
  document.body.appendChild(root);
  const app = document.querySelector('.app');
  if (app) app.inert = true;
  document.body.classList.add('ob-open');

  // ---------------------------------------------------------------- steps

  function welcome() {
    return {
      wide: true,
      main: `<h1 id="obTitle" class="ob-hero-title">Welcome to ClipVault</h1>
        <p class="ob-lead">ClipVault records your games so you never miss a moment. It's free, has no ads and no account, and nothing leaves your PC.</p>
        <ul class="ob-points">
          <li><b>Death cam</b><span>A few seconds after you die in League, a small replay shows how it happened, while you wait to respawn.</span></li>
          <li><b>Instant replay</b><span>Press <kbd>${esc(hk.saveClip || 'Alt+F10')}</kbd> to save the last ${esc(fmtLength(c.replaySeconds))} of any game.</span></li>
          <li><b>League highlights</b><span>Kills, deaths and objectives are clipped by themselves, with a page for every match.</span></li>
        </ul>
        <p class="ob-small">Five quick questions, about a minute. You can change everything later in Settings.</p>`,
      side: `<figure class="ob-hero"><img src="${IMG}hero-deathcam.webp" alt="The death cam replaying a teamfight death in the corner of the screen" width="662" height="328" draggable="false">
        <figcaption>The death cam, replaying a teamfight a couple of seconds after the death</figcaption></figure>`,
    };
  }

  function camPreview() {
    const p = camPlacement(c, screens);
    const size = (CAM_SIZES.find(([id]) => id === c.killCamSize) || CAM_SIZES[1])[2];
    const corners = CAM_CORNERS.map((k) => `<button type="button" class="ob-corner ob-corner-${k}${c.killCamCorner === k ? ' on' : ''}" data-corner="${k}" aria-pressed="${c.killCamCorner === k}" title="${esc(CORNER_NAMES[k])}" aria-label="${esc(CORNER_NAMES[k])} corner"></button>`).join('');
    return `<div class="ob-screen ${p.screen === 'game' ? 'game' : 'other'}${c.killCam ? '' : ' off'}" style="--cam-w:${size * 100}%">
        <span class="ob-screen-name">${p.off ? 'No other screen' : p.screen === 'game' ? 'Your game' : 'Your other screen'}</span>
        ${p.off ? '' : `<span class="ob-cam ob-cam-${p.corner}${p.screen === 'game' ? ' inset' : ''}"></span>`}
        ${corners}
      </div>`;
  }

  function deathcam() {
    const dis = !c.killCam;
    const kinds = [['killCamDeaths', 'Deaths'], ['killCamKills', 'Kills'], ['killCamAssists', 'Assists'], ['killCamObjectives', 'Objectives']];
    const one = screens < 2;
    return {
      main: `<h1 id="obTitle">Watch how you died, while you wait to respawn</h1>
        <p class="ob-lead">About 2 seconds after you die in League, the death cam replays the last few seconds in a small window. It never takes focus from the game.</p>
        ${switchRow('killCam', c.killCam, 'Use the death cam', 'Works in every League mode, including Practice Tool')}
        <fieldset class="ob-field"${dis ? ' disabled' : ''}><legend>Play it for</legend>
          <div class="checklist">${kinds.map(([k, l]) => chk(k, c[k], l)).join('')}</div></fieldset>
        <fieldset class="ob-field"${dis ? ' disabled' : ''}><legend>Which screen</legend>
          <div class="ob-cards three">
            ${radioCard('killCamScreen', 'auto', c.killCamScreen === 'auto', 'Automatic', one ? 'One screen, so over the game' : 'Your other screen, so the game stays clear')}
            ${radioCard('killCamScreen', 'other', c.killCamScreen === 'other', 'My other screen', one ? 'Needs a second screen' : 'Never over the game', { disabled: one && c.killCamScreen !== 'other' })}
            ${radioCard('killCamScreen', 'game', c.killCamScreen === 'game', 'Over the game', 'Small, in a corner of League')}
          </div>
          ${camPlacement(c, screens).screen === 'game' ? '<p class="ob-small">Over the game it needs League in Borderless or Windowed mode, not Fullscreen. Clicks go through to the game.</p>' : ''}</fieldset>
        <fieldset class="ob-field ob-place"${dis ? ' disabled' : ''}><legend>Corner and size</legend>
          <div class="ob-place-row">
            ${camPreview()}
            <div class="ob-place-ctl">
              <div class="seg" role="group" aria-label="Corner"><button type="button" data-corner="auto" class="${c.killCamCorner === 'auto' ? 'on' : ''}" aria-pressed="${c.killCamCorner === 'auto'}">Automatic corner</button></div>
              <p class="ob-small" id="obCornerNote">${c.killCamCorner === 'auto' ? 'Top left over the game, where League\'s HUD is empty; bottom right on another screen. Or click a corner of the picture.' : `${esc(CORNER_NAMES[c.killCamCorner])}. Click another corner, or go back to automatic.`}</p>
              <div class="seg ob-sizes" role="radiogroup" aria-label="Size">${CAM_SIZES.map(([id, label]) => `<button type="button" role="radio" data-size="${id}" class="${c.killCamSize === id ? 'on' : ''}" aria-checked="${c.killCamSize === id}">${esc(label)}</button>`).join('')}</div>
              <p class="ob-small">In game, <kbd>${esc(hk.camMove || 'Ctrl+Shift+Alt+M')}</kbd> lets you drag it anywhere and resize it.</p>
            </div>
          </div></fieldset>`,
      side: shot('settings-deathcam.webp', 'Settings, League of Legends, Death cam: Replay how you died, Play it for, Where it plays, Corner and Size', 840, 499,
        ['Settings', 'League of Legends', 'Death cam']),
    };
  }

  function recording() {
    const len = fmtLength(c.replaySeconds);
    const lengths = REPLAY_LENGTHS.includes(c.replaySeconds) ? REPLAY_LENGTHS : [...REPLAY_LENGTHS, c.replaySeconds].sort((a, b) => a - b);
    return {
      main: `<h1 id="obTitle">When should ClipVault be ready to clip?</h1>
        <p class="ob-lead">ClipVault keeps the last moments of your game in a replay buffer. Press <kbd>${esc(hk.saveClip || 'Alt+F10')}</kbd> and they're saved as a clip.</p>
        <div class="ob-cards">${BUFFER_MODES.map((m) => radioCard('bufferMode', m.id, c.bufferMode === m.id, m.label,
          esc(m.note.replace('{len}', len).replace('{key}', hk.toggleBuffer || 'Alt+F8')), { badge: m.recommended ? 'Recommended' : '' })).join('')}</div>
        <div class="ob-inline"><span class="ob-inline-label">A clip keeps the last</span>
          <div class="seg" role="radiogroup" aria-label="Replay length">${lengths.map((n) => `<button type="button" role="radio" data-len="${n}" class="${c.replaySeconds === n ? 'on' : ''}" aria-checked="${c.replaySeconds === n}">${esc(fmtLength(n))}</button>`).join('')}</div></div>
        <fieldset class="ob-field"><legend>League of Legends</legend>
          ${switchRow('leagueClips', c.leagueClips, 'Clip key moments automatically', 'Kills, deaths and objectives become clips by themselves')}
          ${switchRow('recordMatch', c.recordMatch, 'Also record full matches', 'Every game as one video with its moments marked. Takes more space')}
          ${camNeedsClips(c) ? '<p class="ob-warn" role="alert">The death cam needs one of these on.</p>' : ''}
        </fieldset>
        ${switchRow('mic', c.mic, 'Record my microphone', 'Your default microphone, mixed with the game\'s sound')}`,
      side: shot('settings-buffer.webp', 'Settings, Recording, Instant replay: Replay length and Replay buffer', 840, 195, ['Settings', 'Recording', 'Replay buffer'])
        + shot('settings-autoclips.webp', 'Settings, League of Legends: Clip key moments automatically', 840, 134, ['Settings', 'League of Legends', 'Automatic highlights'])
        + shot('settings-full-match.webp', 'Settings, League of Legends, Each match: Also record full matches', 840, 65, ['Settings', 'League of Legends', 'Each match'])
        + `<p class="ob-crumb-text">Microphone: ${crumb('Settings', 'Audio', 'Microphone')}</p>`,
    };
  }

  function notifications() {
    const dis = !c.overlay;
    const others = (status.displays || []);
    return {
      main: `<h1 id="obTitle">Notifications</h1>
        <p class="ob-lead">A small notification tells you a clip or highlight was saved, a match was noticed, or capture stopped.</p>
        ${switchRow('overlay', c.overlay, 'Show notifications', 'Errors always show, even with this off')}
        <fieldset class="ob-field"${dis ? ' disabled' : ''}><legend>During games</legend>
          <div class="ob-cards two">
            ${radioCard('notifyInGame', 'on', c.notifyInGame, 'Show them while I play', 'Brief, at the right edge under League\'s kill feed', { badge: 'Default' })}
            ${radioCard('notifyInGame', 'off', !c.notifyInGame, 'Keep my game clear', 'Nothing pops up while a game runs, only errors')}
          </div></fieldset>
        ${others.length > 1 ? `<fieldset class="ob-field"${dis ? ' disabled' : ''}><legend>Screen</legend>
          <select data-c="notifyMonitor" aria-label="Notification screen"><option value="-1" ${c.notifyMonitor === -1 ? 'selected' : ''}>Same screen as the game</option>
          ${others.map((d) => `<option value="${d.index}" ${c.notifyMonitor === d.index ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</select></fieldset>` : ''}
        ${switchRow('clipSound', c.clipSound, 'Play a sound', 'A short sound when a clip or recording is saved')}`,
      side: `<figure class="ob-shot"><img src="${IMG}notification-in-game.webp" alt="A Cloud Drake saved notification over League of Legends" width="660" height="300" draggable="false">
          <figcaption><span class="ob-crumb-what">How one looks in a game</span></figcaption></figure>`
        + shot('settings-notifications.webp', 'Settings, Notifications: On-screen notifications, During games, Notification screen and Sounds', 840, 284, ['Settings', 'Notifications']),
    };
  }

  function folder() {
    const isDefault = c.saveDir === status.defaultSaveDir;
    const limits = STORAGE_LIMITS.includes(c.storageLimitGB) ? STORAGE_LIMITS : [...STORAGE_LIMITS, c.storageLimitGB].sort((a, b) => a - b);
    return {
      main: `<h1 id="obTitle">Where your videos go</h1>
        <p class="ob-lead">${isDefault ? 'This is the default folder where ClipVault saves your videos.' : 'ClipVault will save your videos here.'} Each game gets its own folder of ordinary MP4 files.</p>
        <div class="ob-folder"><span class="path" id="obPath" title="${esc(c.saveDir)}">${esc(c.saveDir)}</span>
          <button type="button" class="btn sm" data-act="ob-pick">Change…</button>
          ${isDefault || !status.defaultSaveDir ? '' : '<button type="button" class="btn sm ghost" data-act="ob-default">Use the default</button>'}</div>
        <p class="ob-small">Pick a drive with room to spare: a League match with its highlights is often a few hundred MB.</p>
        <fieldset class="ob-field"><legend>Storage limit</legend>
          <select data-c="storageLimitGB" aria-label="Storage limit">${limits.map((g) => `<option value="${g}" ${c.storageLimitGB === g ? 'selected' : ''}>${g ? (g >= 1000 ? `${g / 1000} TB` : `${g} GB`) : 'No limit'}</option>`).join('')}</select>
          <p class="ob-small">When your videos pass it, the oldest go to the Recycle Bin. Favorites are never removed.</p></fieldset>`,
      side: shot('settings-folder.webp', 'Settings, Storage: the Save folder with Change and Open buttons', 840, 68, ['Settings', 'Storage', 'Save folder']),
    };
  }

  function quality() {
    const cards = QUALITY_PRESETS.map((p) => radioCard('quality', p.id, c.quality === p.id, p.label, `<i>${esc(p.spec)}</i>${esc(p.note)}`, { badge: p.recommended ? 'Recommended' : '' }));
    if (c.quality === 'custom' || !QUALITY_PRESETS.some((p) => p.id === c.quality)) {
      const res = { native: 'Your screen\'s resolution', 1440: '1440p', 1080: '1080p', 720: '720p' }[s0.resolution] || s0.resolution;
      cards.push(radioCard('quality', 'custom', true, 'Keep my settings', `<i>${esc(res)} · ${esc(s0.fps)} fps · ${esc(s0.quality[0].toUpperCase() + s0.quality.slice(1))}</i>What you chose in Settings`));
    }
    const enc = encoder ? `Your ${esc(encoder.label)} encodes the video, so the game keeps its frames.` : 'No graphics card encoder was found, so your processor encodes the video: Smaller files is kindest to it.';
    return {
      main: `<h1 id="obTitle">Video quality</h1>
        <p class="ob-lead">Better quality makes bigger files. Balanced suits most people.</p>
        <div class="ob-cards">${cards.join('')}</div>
        <p class="ob-small">${enc} Frame rate, resolution and the H.265 format (half the size) are in Settings.</p>`,
      side: shot('settings-quality.webp', 'Settings, Recording, Capture: Frame rate, Resolution and Quality', 840, 199, ['Settings', 'Recording', 'Capture']),
    };
  }

  function summary() {
    const p = camPlacement(c, screens);
    const kinds = [['killCamDeaths', 'deaths'], ['killCamKills', 'kills'], ['killCamAssists', 'assists'], ['killCamObjectives', 'objectives']].filter(([k]) => c[k]).map(([, l]) => l);
    const preset = QUALITY_PRESETS.find((x) => x.id === c.quality);
    const mode = BUFFER_MODES.find((m) => m.id === c.bufferMode);
    const rows = [
      ['Death cam', c.killCam ? `On for ${kinds.join(', ') || 'nothing yet'} · ${p.off ? 'no other screen, so it stays off' : `${p.screen === 'game' ? 'over the game' : 'other screen'}, ${CORNER_NAMES[p.corner].toLowerCase()}`} · ${(CAM_SIZES.find(([id]) => id === c.killCamSize) || CAM_SIZES[1])[1].toLowerCase()}` : 'Off', 'League of Legends › Death cam'],
      ['Replay buffer', `${mode ? mode.label : c.bufferMode} · last ${fmtLength(c.replaySeconds)}`, 'Recording'],
      ['League', [c.leagueClips ? 'Auto clips on' : 'Auto clips off', c.recordMatch ? 'full matches recorded' : 'no full match recording'].join(' · '), 'League of Legends'],
      ['Microphone', c.mic ? 'Recorded' : 'Not recorded', 'Audio'],
      ['Notifications', c.overlay ? (c.notifyInGame ? 'On, also during games' : 'On, but not during games') : 'Off (errors still show)', 'Notifications'],
      ['Save folder', c.saveDir, 'Storage'],
      ['Quality', preset ? `${preset.label} · ${preset.spec}` : 'Your own settings', 'Recording'],
    ];
    const keys = [['saveClip', 'Save clip'], ['toggleRecording', 'Record'], ['bookmark', 'Bookmark'], ['camBig', 'Death cam bigger']].filter(([k]) => hk[k]);
    return {
      main: `<h1 id="obTitle">You're all set</h1>
        <p class="ob-lead">Just play. ClipVault notices League by itself, and the death cam shows up after your first death.</p>
        <dl class="ob-summary">${rows.map(([k, v, where]) => `<div><dt>${esc(k)}</dt><dd><span class="${k === 'Save folder' ? 'ob-mono' : ''}">${esc(v)}</span><small>Settings › ${esc(where)}</small></dd></div>`).join('')}</dl>
        ${switchRow('startWithWindows', c.startWithWindows, 'Start ClipVault with Windows', 'It opens quietly in the tray, so it\'s ready when you play')}`,
      side: `<div class="ob-keys"><h2 class="label">Your keys</h2>${keys.map(([k, l]) => `<div><span>${esc(l)}</span><kbd>${esc(hk[k])}</kbd></div>`).join('')}
          <p class="ob-crumb-text">They work in game too. Change them in ${crumb('Settings', 'Hotkeys')}</p></div>`
        + `<div class="ob-keys"><h2 class="label">Changing your mind</h2><p class="ob-crumb-text">Everything here is in Settings, in the section shown next to it. To go through these steps again: ${crumb('Settings', 'Redo setup')} at the top.</p></div>`,
    };
  }

  const BUILD = { welcome, deathcam, recording, notifications, folder, quality, done: summary };

  // ---------------------------------------------------------------- render

  function render({ focus = true } = {}) {
    const st = STEPS[at];
    const v = BUILD[st.id]();
    const last = at === STEPS.length - 1;
    const scroll = root.querySelector('.ob-main') ? root.querySelector('.ob-main').scrollTop : 0;
    root.innerHTML = `
      <header class="ob-top">
        <div class="brand"><svg viewBox="0 0 16 16" aria-hidden="true"><rect class="mark-bg" x="0.5" y="0.5" width="15" height="15" rx="3"/><path class="mark-fg" d="M6 4.8v6.4L11.2 8z"/></svg><span>ClipVault setup</span></div>
        <ol class="ob-progress" aria-label="Setup steps">${STEPS.map((x, i) => `<li><button type="button" data-go="${i}" class="${i === at ? 'now' : i < at ? 'past' : ''}" ${i > seen ? 'disabled' : ''} ${i === at ? 'aria-current="step"' : ''} title="${esc(x.name)}"><span class="ob-dot"></span><span class="ob-step-name">${esc(x.name)}</span></button></li>`).join('')}</ol>
      </header>
      <div class="ob-body${v.wide ? ' welcome' : ''}" data-step="${st.id}">
        <section class="ob-main">${at && !last ? `<p class="label ob-count">Step ${at} of ${STEPS.length - 2}</p>` : ''}${v.main}</section>
        <aside class="ob-side" aria-label="${v.wide ? 'The death cam' : 'Where this is in Settings'}">${v.side}</aside>
      </div>
      <footer class="ob-foot">
        ${last ? '<span></span>' : `<button type="button" class="btn ghost" data-act="ob-skip">${redo ? 'Close without changes' : 'Skip setup'}</button>`}
        <span class="spacer"></span>
        ${at ? '<button type="button" class="btn ghost" data-act="ob-back">Back</button>' : ''}
        <button type="button" class="btn primary" data-act="ob-next">${last ? 'Finish' : at ? 'Next' : 'Get started'}<kbd>Enter</kbd></button>
      </footer>`;
    const main = root.querySelector('.ob-main');
    if (!focus) main.scrollTop = scroll;
    if (focus) {
      // Screen readers start at the step's title; Enter still goes on from there.
      const title = root.querySelector('#obTitle');
      title.tabIndex = -1;
      (at ? title : root.querySelector('[data-act="ob-next"]')).focus({ preventScroll: true });
    }
  }

  function go(i) {
    at = Math.max(0, Math.min(STEPS.length - 1, i));
    seen = Math.max(seen, at);
    render();
  }

  function close() {
    window.removeEventListener('keydown', onKey, true);
    root.remove();
    if (app) app.inert = false;
    document.body.classList.remove('ob-open');
  }

  async function finish() {
    if (busy) return;
    busy = true;
    const patch = choicesToPatch(c, s0);
    let next = null;
    try {
      next = await api.setSettings(patch);
    } catch (err) {
      toast(`Couldn't save the setup: ${String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
    }
    busy = false;
    if (!next) return;
    close();
    onDone && onDone(next, { finished: true });
  }

  async function skip() {
    if (busy) return;
    busy = true;
    let next = null;
    // Skipping keeps every setting; it only remembers that the setup was seen.
    try { next = (Number(s0.onboarded) >= ONBOARDING_VERSION) ? s0 : await api.setSettings({ onboarded: ONBOARDING_VERSION }); } catch { next = s0; }
    busy = false;
    close();
    onDone && onDone(next, { finished: false });
  }

  async function pickFolder() {
    let dir = null;
    try { dir = await api.pickFolder(); } catch { dir = null; }
    if (dir) { c.saveDir = dir; render({ focus: false }); root.querySelector('[data-act="ob-pick"]').focus(); }
  }

  // ---------------------------------------------------------------- input

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'ob-next') { if (at === STEPS.length - 1) finish(); else go(at + 1); return; }
    if (act === 'ob-back') { go(at - 1); return; }
    if (act === 'ob-skip') { skip(); return; }
    if (act === 'ob-pick') { pickFolder(); return; }
    if (act === 'ob-default') { c.saveDir = status.defaultSaveDir; render({ focus: false }); root.querySelector('[data-act="ob-pick"]').focus(); return; }
    if (b.dataset.go) { go(Number(b.dataset.go)); return; }
    const again = (sel) => { render({ focus: false }); const x = root.querySelector(sel); if (x) x.focus(); };
    if (b.dataset.corner) { c.killCamCorner = b.dataset.corner; again(`[data-corner="${b.dataset.corner}"]`); return; }
    if (b.dataset.size) { c.killCamSize = b.dataset.size; again(`[data-size="${b.dataset.size}"]`); return; }
    if (b.dataset.len) { c.replaySeconds = Number(b.dataset.len); again(`[data-len="${b.dataset.len}"]`); }
  });

  root.addEventListener('change', (e) => {
    const el = e.target;
    let sel = null;
    if (el.type === 'radio') {
      const v = el.value;
      if (el.name === 'notifyInGame') c.notifyInGame = v === 'on';
      else c[el.name] = v;
      sel = `input[name="${el.name}"][value="${CSS.escape(v)}"]`;
    } else if (el.dataset.c) {
      const k = el.dataset.c;
      c[k] = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? Number(el.value) : el.value;
      sel = `[data-c="${k}"]`;
    }
    if (!sel) return;
    render({ focus: false });
    const x = root.querySelector(sel);
    if (x) x.focus();
  });

  // Enter: next step (buttons, selects and links keep their own Enter); Esc: skip. Keys never reach
  // the library underneath.
  function onKey(e) {
    if (!root.isConnected) return;
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); skip(); return; }
    if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = document.activeElement;
    if (t && t !== document.body && t.matches('button:not([data-act="ob-next"]), select, a')) return;
    e.preventDefault();
    if (at === STEPS.length - 1) finish(); else go(at + 1);
  }
  window.addEventListener('keydown', onKey, true);

  render();
  return { close, go, choices: c, get step() { return STEPS[at].id; }, finish, skip };
}

export const ONBOARDING_STEPS = STEPS.map((s) => s.id);
