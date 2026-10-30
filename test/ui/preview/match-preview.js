// Renders the match page into match*.html. Each page sets window.PV = { tab, record, at } first.
// The real modules and CSS; the library items are matches-data.js, the record match-data.js.
import { icon } from '../../../src/renderer/js/core/icons.js';
import { groupLibrary } from '../../../src/renderer/js/lib/group.js';
import { esc } from '../../../src/renderer/js/views/matches.js';
import { renderMatchPage } from '../../../src/renderer/js/views/match.js';
import { NOW, REAL_KEY, realMatchItems } from './matches-data.js';
import { sampleRecord, itemIcon } from './match-data.js';

// icons.js points at icons.svg next to index.html; from here the sprite is three folders up.
const sprite = (html) => html.replaceAll('href="icons.svg#', 'href="../../../src/renderer/icons.svg#');
const pv = window.PV || {};
const { matches } = groupLibrary(realMatchItems());
const match = matches.find((m) => m.key === REAL_KEY);
const record = pv.record ? sampleRecord() : null;

const navItem = (glyph, text, count, on) => `<div class="pv-nav-item${on ? ' pv-on' : ''}">${icon(glyph, { size: 'md' })}<span>${esc(text)}</span>${count != null ? `<span class="pv-count">${count}</span>` : ''}</div>`;
document.getElementById('nav').innerHTML = sprite(
  navItem('swords', 'Matches', 6, true) + navItem('film', 'Clips', 14) + navItem('star', 'Favorites', 3)
  + '<div class="pv-section">Games</div>' + navItem('gamepad-2', 'League of Legends', 168)
  + `<div class="pv-foot">${navItem('settings', 'Settings')}</div>`);
document.getElementById('tbSearch').insertAdjacentHTML('afterbegin', sprite(icon('search')));

const page = document.getElementById('page');
const draw = () => {
  // The timeline groups markers by its real width, so measure it and draw again (as app.js will).
  const tl = page.querySelector('.mp-tl-track');
  const width = tl ? tl.getBoundingClientRect().width : 840;
  page.innerHTML = sprite(renderMatchPage(match, { tab: pv.tab || 'watch', record, at: pv.at ?? null, now: NOW, itemIcon, width }));
};
draw();
draw();
// Keep the current moment in view, as the app will while the video plays.
const cur = page.querySelector('.mp-mo.mp-cur');
if (cur) cur.scrollIntoView({ block: 'center' });
