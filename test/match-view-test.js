// The match page (src/renderer/js/views/match.js), rendered from the real 17 October match
// (test/ui/preview/matches-data.js) with and without its match record (test/ui/preview/match-data.js).
//   node test/match-view-test.js
process.env.TZ = 'Europe/London'; // the fixtures' clock times are BST
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const load = (...p) => import(pathToFileURL(path.join(__dirname, '..', ...p)).href);
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const count = (html, re) => (html.match(re) || []).length;
const actsIn = (html) => [...html.matchAll(/data-act="([^"]*)"/g)].map((m) => m[1]);
// Controls: buttons, inputs, selects and anything with an interactive role.
const controls = (html) => [...html.matchAll(/<(button|input|select|textarea)\b[^>]*>|<[a-z]+\b[^>]*role="(?:slider|switch|tab|button)"[^>]*>/g)].map((m) => m[0]);

(async () => {
  const v = await load('src', 'renderer', 'js', 'views', 'match.js');
  const mv = await load('src', 'renderer', 'js', 'views', 'matches.js');
  const { groupLibrary } = await load('src', 'renderer', 'js', 'lib', 'group.js');
  const data = await load('test', 'ui', 'preview', 'matches-data.js');
  const rec = await load('test', 'ui', 'preview', 'match-data.js');

  const { matches } = groupLibrary(data.realMatchItems());
  const m = matches[0];
  const record = rec.sampleRecord();
  const known = new Set([...v.ACTIONS, ...mv.ACTIONS]);

  // ---- every page state: no "null", "undefined" or "NaN"; every control has a known data-act
  const states = [];
  for (const tab of ['watch', 'scoreboard', 'highlights']) {
    for (const r of [null, record]) {
      for (const highlightMode of [true, false]) {
        for (const at of [null, 1104, -10]) {
          for (const feed of ['mine', 'all']) states.push([`${tab} record=${Boolean(r)} hm=${highlightMode} at=${at} feed=${feed}`, v.renderMatchPage(m, { tab, record: r, highlightMode, at, feed, now: data.NOW, itemIcon: rec.itemIcon })]);
        }
      }
    }
  }
  for (const [name, html] of states) {
    assert.ok(!/\bnull\b|\bundefined\b|\bNaN\b/.test(html), `${name}: no null/undefined/NaN: ${(html.match(/.{60}\b(?:null|undefined|NaN)\b.{20}/) || [''])[0]}`);
    for (const c of controls(html)) assert.ok(/\sdata-act="[a-z-]+"/.test(c), `${name}: control without data-act: ${c.slice(0, 120)}`);
    for (const a of actsIn(html)) assert.ok(known.has(a), `${name}: unknown action ${a}`);
  }
  for (const a of v.ACTIONS) assert.ok(states.some(([, h]) => actsIn(h).includes(a)), `ACTIONS lists ${a}, which nothing renders`);
  assert.strictEqual(new Set(v.ACTIONS).size, v.ACTIONS.length, 'ACTIONS has no duplicates');

  // ---- header
  const head = v.renderMatchHeader(m, null, { now: data.NOW });
  const ht = text(head);
  assert.ok(ht.includes('Evelynn') && ht.includes('Defeat') && ht.includes("Summoner's Rift") && ht.includes('Saturday 17 October, 22:36') && ht.includes('28:15'), ht);
  assert.ok(ht.replace(/ /g, '').includes('11/10/7') && ht.includes('1.80 KDA'));
  assert.ok(!/KP|Damage|Gold|Vision|CS/.test(ht), 'no record: only the K/D/A, never zeros');
  const headR = text(v.renderMatchHeader(m, record, { now: data.NOW, itemIcon: rec.itemIcon }));
  for (const s of ['Jungle', 'Ranked Solo/Duo', '−19 LP', 'KP 58%', 'CS 168 5.9/min', 'Damage 28,640 27% of team', 'Gold 13,420 475/min', 'Vision 31']) assert.ok(headR.includes(s), `header with record: ${s} in ${headR}`);

  // ---- tabs
  const tabs = v.renderMatchTabs(m, 'scoreboard');
  assert.strictEqual(count(tabs, /data-act="match-tab"/g), 3);
  assert.ok(/data-tab="scoreboard" aria-selected="true"/.test(tabs) && text(tabs).includes('Highlights 28'));

  // ---- Watch: moments, multikill divider, current row, Highlight mode
  const moments = v.matchMoments(m);
  assert.strictEqual(moments.length, 33, 'the minimap has 33 moments');
  assert.strictEqual(v.fmtGame(moments[0].t), '0:47', 'game time = minimap time + gameStart');
  assert.deepStrictEqual(v.matchMoments(m, record).map((x) => x.type), moments.map((x) => x.type), 'the record has the same moments');
  const watch = v.renderWatch(m, { at: 1104 });
  const wt = text(watch);
  assert.ok(wt.includes('Moments 32'), 'the multikill is a divider, not a row');
  assert.ok(/Rift Herald Double kill 18:17 Kill 18:26 Kill 18:51 Chemtech dragon/.test(wt), `divider above its kills: ${wt.slice(wt.indexOf('16:18'), wt.indexOf('16:18') + 120)}`);
  assert.strictEqual(count(watch, /class="mp-mo-div"/g), 1);
  assert.strictEqual(count(watch, /class="mp-mo mp-cur/g), 1, 'one current row');
  assert.ok(/class="mp-mo mp-cur"[^>]*data-at="1106.4"/.test(watch), 'current: the 18:26 kill');
  assert.ok(wt.includes('Double kill Highlight 10 of 18'), 'stage chip: the current highlight among those Highlight mode plays');
  assert.ok(/data-family="death" aria-pressed="false"/.test(watch) && /data-family="kill" aria-pressed="true"/.test(watch), 'deaths are off by default');
  assert.ok(wt.includes('18 of 28 highlights'), wt.slice(wt.indexOf('Highlight mode'), wt.indexOf('Highlight mode') + 160));
  assert.ok(count(watch, /class="mp-mo mp-dim"/g) >= 10, 'deaths dim while they are skipped');
  assert.ok(/data-slot="video"/.test(watch) && /data-slot="minimap"/.test(watch), 'slots for the video and the minimap');
  const off = v.renderWatch(m, { at: 1104, highlightMode: false });
  assert.ok(text(off).includes('Off: the full recording plays') && !/class="mp-mo mp-dim/.test(off) && /aria-checked="false"/.test(off));
  const all = v.renderWatch(m, { families: ['kill', 'assist', 'death', 'objective'] });
  assert.ok(text(all).includes('28 of 28 highlights'));
  // ---- Watch: All kills (the kill feed from the record's events)
  const champKills = record.events.filter((e) => e.name === 'ChampionKill');
  const feed = v.killFeed(record);
  assert.strictEqual(feed.reason, '');
  assert.strictEqual(feed.kills.length, champKills.length, 'every champion kill, yours and everyone else\'s');
  assert.strictEqual(feed.kills.length, rec.OTHER_KILLS.length + record.events.filter((e) => ['kill', 'death', 'assist'].includes(e.type)).length);
  assert.ok(feed.kills.every((k, i) => !i || feed.kills[i - 1].t <= k.t), 'oldest first');
  const kAt = (t) => feed.kills.find((k) => k.t === t);
  assert.deepStrictEqual([kAt(95.3).side, kAt(95.3).mine, kAt(95.3).label], ['enemy', null, 'Enemy kill'], 'Lee Sin kills Darius');
  assert.deepStrictEqual([kAt(301).side, kAt(301).label], ['ally', 'Ally kill']);
  assert.deepStrictEqual([kAt(880.2).side, kAt(880.2).label, kAt(880.2).by], ['enemy', 'Executed', 'turret'], 'a turret executes Thresh: an enemy kill');
  assert.deepStrictEqual([kAt(432.3).mine, kAt(432.3).side, kAt(210).mine, kAt(210).side, kAt(47.2).mine], ['kill', 'ally', 'death', 'enemy', 'assist']);
  assert.deepStrictEqual([kAt(1180).streak, kAt(1185.5).streak, kAt(1191).streak, kAt(1191).chain], [1, 2, 3, feed.kills.indexOf(kAt(1180))], "Syndra's triple kill");
  assert.strictEqual(kAt(1106.6).streak, 2, 'your double kill');
  assert.strictEqual(kAt(515).streak, 1, 'a kill by someone else breaks nothing');
  const fw = v.renderWatch(m, { record, at: 1186, feed: 'all' });
  const ft = text(fw);
  assert.strictEqual(count(fw, /class="mp-mo mp-kf/g), feed.kills.length, 'one row per kill');
  assert.ok(ft.includes(`Moments ${feed.kills.length}`), 'the count is the kills');
  assert.strictEqual(count(fw, /class="mp-mo mp-kf mp-ally/g), feed.kills.filter((k) => k.side === 'ally').length);
  assert.strictEqual(count(fw, /class="mp-mo mp-kf mp-enemy/g), feed.kills.filter((k) => k.side === 'enemy').length);
  assert.ok(count(fw, /class="mp-mo mp-kf mp-ally/g) > 5 && count(fw, /class="mp-mo mp-kf mp-enemy/g) > 5, 'both colours');
  assert.strictEqual(count(fw, /mp-kf mp-(?:ally|enemy) mp-mine/g), feed.kills.filter((k) => k.mine).length, 'your kills, deaths and assists stand out');
  assert.ok(/mp-face-me/.test(fw), 'your face is ringed');
  assert.ok(/Syndra · Triple kill/.test(ft) && /Evelynn · Double kill/.test(ft), 'multikill dividers name the killer');
  assert.strictEqual(count(fw, /class="mp-mo-div"/g), 2);
  assert.ok(ft.indexOf('Syndra · Triple kill') < ft.indexOf('19:40'), 'the divider sits above the first kill of the chain');
  assert.ok(/title="Syndra killed Ahri, with Lee Sin"/.test(fw), 'faces: killer, victim and assisters (the hover title)');
  assert.ok(/title="A turret killed Thresh"/.test(fw) && /mp-face-exec/.test(fw), 'an execution');
  assert.ok(/class="mp-mo mp-kf mp-enemy mp-cur"[^>]*data-at="1185.5"/.test(fw), 'current: the kill at the playhead');
  assert.strictEqual(v.feedIndex(feed.kills, 1186), feed.kills.indexOf(kAt(1185.5)));
  assert.ok(/data-act="match-feed" data-feed="all" aria-pressed="true"/.test(fw) && /data-feed="mine" aria-pressed="false"/.test(fw), 'the toggle');
  assert.ok(/data-feed="mine" aria-pressed="true"/.test(v.renderWatch(m, { record })), 'my moments by default');
  assert.strictEqual(count(v.renderWatch(m, { record }), /mp-kf/g), 0);
  // No kill feed yet: your moments, and why.
  const pendingRec = { ...record, events: [], pending: ['history', 'timeline'] };
  assert.deepStrictEqual(v.killFeed(pendingRec).kills, []);
  for (const [r, why] of [[pendingRec, 'match timeline from the League client'], [null, 'this match has none yet'], [{ ...pendingRec, pending: [] }, 'No kill feed was saved']]) {
    const pw = v.renderWatch(m, { record: r, at: 1104, feed: 'all' });
    const pt = text(pw);
    assert.ok(pt.includes(why) && pt.includes('Showing your moments'), `no feed: ${why}: ${pt.slice(pt.indexOf('Moments'), pt.indexOf('Moments') + 200)}`);
    assert.ok(pt.includes('Moments 32') && count(pw, /class="mp-mo[ "]/g) === 32 && !/mp-kf/.test(pw), 'your moments instead');
    assert.ok(/data-feed="all" aria-pressed="true"/.test(pw), 'the choice stays');
  }
  // No participants (an old record): kills still list, without faces or colours.
  const bareFeed = v.killFeed({ events: champKills, participants: [] });
  assert.ok(bareFeed.kills.length === champKills.length && bareFeed.kills.every((k) => k.side === null && k.mine === null));
  assert.ok(!/\bnull\b|\bundefined\b|\bNaN\b/.test(v.renderWatch(m, { record: { events: champKills, participants: [] }, feed: 'all', at: 500 })));

  // No minimap: no game clock, so no timeline or PiP, and nothing breaks.
  const bare = { ...m, map: null, gameStart: null, clips: m.clips.map((c) => ({ ...c, map: null, gameAt: null })) };
  const bw = v.renderWatch(bare, { at: 100 });
  assert.ok(!/mp-tl-track|data-slot="minimap"/.test(bw) && text(bw).includes('No game clock'));
  assert.ok(!/\bnull\b|\bundefined\b|\bNaN\b/.test(v.renderMatchPage(bare, { record: null })));

  // ---- timeline grouping (28 px, chained)
  const L = (ps, w = 1000) => v.timelineLayout(ps.map(([pos, type]) => ({ pos, type })), w);
  assert.deepStrictEqual(L([[0, 'kill'], [0.02, 'kill'], [0.5, 'death']]).map((g) => g.count), [2, 1], '20 px apart: one marker');
  assert.deepStrictEqual(L([[0, 'kill'], [0.03, 'kill']]).map((g) => g.count), [1, 1], '30 px apart: two markers');
  assert.deepStrictEqual(L([[0, 'kill'], [0.02, 'kill'], [0.04, 'kill'], [0.06, 'kill']]).map((g) => g.count), [4], 'chained');
  assert.strictEqual(L([[0.1, 'kill'], [0.11, 'multikill'], [0.12, 'death']])[0].type, 'multikill', 'a group shows its biggest moment');
  assert.strictEqual(L([[0.1, 'kill'], [0.11, 'kill']], 200).length, 1, 'narrower track: more grouping');
  assert.strictEqual(Math.round(L([[0.2, 'kill'], [0.22, 'kill']])[0].x), 210, 'a group sits between its first and last marker');
  const groups = count(watch, /class="mp-mk[ "]/g);
  assert.ok(groups > 5 && groups < 32, `the real match's 32 markers draw as ${groups} groups at 840 px`);
  assert.ok(count(watch, /class="mp-mk-ct"/g) > 0);

  // ---- gold difference: series and path sign
  assert.deepStrictEqual(v.goldDiffSeries(record), rec.SAMPLE.goldDiffByMinute, 'your team minus the enemy team');
  const byPlayer = { me: { team: 200 }, participants: [{ participantId: 1, team: 100 }, { participantId: 2, team: 200 }, { participantId: 3, team: 200 }],
    frames: { totalGold: { 1: [500, 1000], 2: [300, 400], 3: [300, 400] } } };
  assert.deepStrictEqual(v.goldDiffSeries(byPlayer), [100, -200], 'participant keys are summed by team, from your side');
  assert.deepStrictEqual(v.goldDiffSeries(null), []);
  const g = v.goldPath([100, 200, -300, -100], 300, 100);
  const ys = (d) => [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((x) => Number(x[2]));
  assert.ok(g.pos && g.neg, 'both sides drawn');
  assert.ok(ys(g.pos).every((y) => y <= g.zeroY + 1e-9), `ahead stays above zero: ${g.pos} (zero ${g.zeroY})`);
  assert.ok(ys(g.neg).every((y) => y >= g.zeroY - 1e-9), `behind stays below zero: ${g.neg}`);
  assert.ok(ys(g.pos).some((y) => Math.abs(y - g.zeroY) < 0.1) && ys(g.neg).some((y) => Math.abs(y - g.zeroY) < 0.1), 'split where it crosses zero');
  assert.ok(g.yMax >= 200 && g.yMin <= -300);
  assert.strictEqual(v.goldPath([10, 20, 30], 100, 50).neg, '', 'always ahead: no behind line');
  assert.strictEqual(v.goldPath([-10, -20], 100, 50).pos, '', 'always behind: no ahead line');
  assert.strictEqual(v.goldPath([5], 100, 50).pos, '', 'one minute: nothing to draw');
  assert.ok(v.goldPath(record.frames, 300, 100).neg, 'takes a frames object too');

  // ---- scoreboard
  const none = v.renderScoreboard(m, null);
  assert.ok(text(none).includes('Stats arrive after your next game with the League client open') && !/<table|mp-gold/.test(none), 'no record: the note, no numbers');
  assert.ok(text(v.renderScoreboard(m, { participants: [] })).includes('Stats arrive after'));
  const sb = v.renderScoreboard(m, record, { itemIcon: rec.itemIcon });
  const st = text(sb);
  assert.strictEqual(count(sb, /<tr class="mp-sb-row/g), 10, 'ten players');
  assert.strictEqual(count(sb, /mp-sb-row mp-me/g), 1, 'your row is marked');
  assert.ok(/mp-me">.*?SampleName/.test(sb) && count(sb, /mp-you/g) === 1, 'only your name is shown');
  assert.ok(st.includes('Your team Defeat 30 kills 105,540 59,370') && st.includes('Enemy team Victory 35 kills 121,000 65,200'), st.slice(0, 300));
  assert.ok(st.indexOf('Darius') < st.indexOf('Evelynn') && st.indexOf('Evelynn') < st.indexOf('Ahri'), 'roles in order');
  assert.ok(/<i class="mp-enemy" style="width:100%">/.test(sb), 'damage bars scale to the match maximum (Syndra)');
  assert.ok(/<i class="mp-ally" style="width:83.7%">/.test(sb), 'Evelynn 28,640 of 34,200');
  assert.ok(st.includes('Damage share') && st.includes('Your team, 105,540 to champions') && /Evelynn 27% 28.6K/.test(st));
  assert.ok(st.includes('Gold difference') && st.includes('+650') && st.includes('−5,830'), 'labels: the peak and the end');
  assert.ok(/class="mp-g-pos" d="M/.test(sb) && /class="mp-g-neg" d="M/.test(sb));

  // ---- highlights: the Matches view's panel
  const hl = v.renderHighlights(m);
  assert.strictEqual(count(hl, /<button type="button" class="mv-tile[ "]/g), 29, '28 highlights and the instant replay');

  // ---- escaping
  const evil = '<img src=x onerror="alert(1)">&\'';
  const em = { ...m, key: `k${evil}`, champion: evil, clips: m.clips.map((c, i) => (i === 14 ? { ...c, label: evil } : c)),
    map: { ...m.map, markers: m.map.markers.map((x, i) => (i === 3 ? { ...x, label: evil } : x)) } };
  const er = { ...record, queueName: evil, me: { ...record.me, alias: evil }, participants: record.participants.map((p, i) => (i === 7 ? { ...p, champion: evil } : p)) };
  for (const tab of ['watch', 'scoreboard', 'highlights']) {
    const html = v.renderMatchPage(em, { tab, record: er, at: 1104, now: data.NOW, itemIcon: rec.itemIcon });
    assert.ok(!html.includes('<img src=x') && !html.includes('onerror="'), `${tab}: markup in names is escaped`);
    assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;'), `${tab}: escaped text is there`);
  }

  console.log(`match view: PASS (${states.length} page states)`);
})().catch((err) => { console.error(err); process.exit(1); });
