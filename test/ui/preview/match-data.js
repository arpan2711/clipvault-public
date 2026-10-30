// A match record (A4 §5.2, schema v1) for the 17 October Evelynn match, for the match page preview
// (match*.html) and its unit test (test/match-view-test.js). Built from mockups/assets/data/
// sample-matches.json matches[0]: its events (real, game seconds) and its illustrative scoreboard,
// objectives and per-minute gold difference (frames.totalGold is made so that your team minus the
// enemy team equals goldDiffByMinute). The kill feed's killer and victim are illustrative too.
// The library side of the match (files, clips, minimap) is matches-data.js realMatchItems().

export const SAMPLE = {"queue":"Ranked Solo/Duo","lpDelta":-19,"role":"JUNGLE","level":16,"kp":0.58,"cs":168,"csPerMin":5.9,"gold":13420,"goldPerMin":475,"damage":28640,"damageShare":0.27,"vision":31,"items":[3020,4645,3100,3089,1082,0,3364],"duration":1695,"ally":[{"champion":"Darius","icon":"Darius","role":"TOP","me":false,"k":4,"d":7,"a":5,"cs":201,"gold":11800,"damage":22100,"vision":14,"items":[3047,3071,3053,0,0,0,3340]},{"champion":"Evelynn","icon":"Evelynn","role":"JUNGLE","me":true,"k":11,"d":10,"a":7,"cs":168,"gold":13420,"damage":28640,"vision":31,"items":[3020,4645,3100,3089,1082,0,3364]},{"champion":"Ahri","icon":"Ahri","role":"MIDDLE","me":false,"k":6,"d":6,"a":8,"cs":232,"gold":12950,"damage":25300,"vision":19,"items":[3020,6655,4646,3157,0,0,3340]},{"champion":"Jinx","icon":"Jinx","role":"BOTTOM","me":false,"k":7,"d":8,"a":6,"cs":245,"gold":13100,"damage":21900,"vision":12,"items":[3006,3031,6672,3072,0,0,3363]},{"champion":"Thresh","icon":"Thresh","role":"UTILITY","me":false,"k":2,"d":9,"a":18,"cs":34,"gold":8100,"damage":7600,"vision":64,"items":[3111,3190,0,0,0,0,3364]}],"enemy":[{"champion":"Aatrox","icon":"Aatrox","role":"TOP","me":false,"k":9,"d":5,"a":7,"cs":214,"gold":14200,"damage":30500,"vision":16,"items":[3047,3053,3071,0,0,0,3340]},{"champion":"Lee Sin","icon":"LeeSin","role":"JUNGLE","me":false,"k":8,"d":6,"a":14,"cs":161,"gold":12600,"damage":19800,"vision":38,"items":[3111,3071,3053,0,0,0,3364]},{"champion":"Syndra","icon":"Syndra","role":"MIDDLE","me":false,"k":10,"d":5,"a":9,"cs":251,"gold":15100,"damage":34200,"vision":21,"items":[3020,6655,4645,3089,3157,0,3340]},{"champion":"Kai'Sa","icon":"Kaisa","role":"BOTTOM","me":false,"k":7,"d":7,"a":8,"cs":263,"gold":14400,"damage":27700,"vision":15,"items":[3006,6672,3031,3072,0,0,3363]},{"champion":"Nautilus","icon":"Nautilus","role":"UTILITY","me":false,"k":1,"d":7,"a":21,"cs":41,"gold":8900,"damage":8800,"vision":71,"items":[3047,3190,0,0,0,0,3364]}],"allyTotals":{"kills":30,"gold":59370,"dragons":2,"heralds":1,"barons":0,"towers":4},"enemyTotals":{"kills":35,"gold":65200,"dragons":3,"heralds":0,"barons":1,"towers":9},"goldDiffByMinute":[0,20,-60,-110,40,180,420,300,650,520,140,-380,-210,90,310,-150,-620,-900,-1150,-700,-1300,-2100,-1800,-2600,-3400,-3100,-4200,-5300,-5830],"events":[[47.2,"assist","Assist"],[210,"death","Death"],[389.1,"death","Death"],[432.3,"kill","Kill"],[434.3,"assist","Assist"],[447.7,"kill","Kill"],[526.5,"kill","Kill"],[614.2,"kill","Kill"],[666.4,"death","Death"],[735.4,"dragon","Earth dragon"],[742.5,"kill","Kill"],[771.8,"assist","Assist"],[796.9,"kill","Kill"],[893.1,"death","Death"],[965.2,"death","Death"],[978.6,"herald","Rift Herald"],[1097.4,"kill","Kill"],[1106.6,"kill","Kill"],[1106.6,"multikill","Double kill"],[1131.5,"dragon","Chemtech dragon"],[1153.6,"death","Death"],[1223.8,"assist","Assist"],[1242,"assist","Assist"],[1265.8,"assist","Assist"],[1293.6,"death","Death"],[1404.2,"death","Death"],[1489,"kill","Kill"],[1503.9,"kill","Kill"],[1583,"death","Death"],[1636.4,"kill","Kill"],[1654.3,"assist","Assist"],[1658.9,"death","Death"],[1695.2,"defeat","Defeat"]]};

export const itemIcon = (id) => `assets/item/${id}.png`;
const champIcon = (name) => `assets/champion/${name}.png`;

export const OTHER_KILLS = [
  [95.3, 7, 1, [8]], [301, 3, 8, [4]], [512.4, 9, 4, [10]], [515, 4, 9, [5]], [702.8, 6, 1, []], [880.2, 0, 5, [], 'turret'],
  [1012.6, 1, 6, [3]], [1180, 8, 3, [7]], [1185.5, 8, 5, [7]], [1191, 8, 4, [10]], [1350.7, 3, 7, [4, 5]], [1452.1, 9, 1, []],
  [1560.3, 6, 4, [9, 10]],
];

export function sampleRecord() {
  const s = SAMPLE;
  const row = (p, i, team) => ({
    participantId: i + 1, team, isMe: Boolean(p.me), champion: p.champion, icon: champIcon(p.icon), name: p.me ? 'SampleName' : '', tag: p.me ? 'EUW' : '',
    role: p.role, level: p.me ? s.level : 0, kills: p.k, deaths: p.d, assists: p.a, cs: p.cs, gold: p.gold, damage: p.damage, vision: p.vision, items: p.items,
  });
  const participants = [...s.ally.map((p, i) => row(p, i, 100)), ...s.enemy.map((p, i) => row(p, i + 5, 200))];
  const me = participants.find((p) => p.isMe);
  const allies = participants.filter((p) => p.team === 100 && !p.isMe).map((p) => p.participantId);
  const enemies = participants.filter((p) => p.team === 200).map((p) => p.participantId);
  let n = 0;
  const events = s.events.map(([t, type, label]) => {
    n += 1;
    const e = { t, name: 'ChampionKill', type, label, mine: true };
    if (type === 'kill') Object.assign(e, { killer: me.participantId, victim: enemies[n % 5] });
    else if (type === 'death') Object.assign(e, { killer: enemies[n % 5], victim: me.participantId });
    else if (type === 'assist') Object.assign(e, { killer: allies[n % 4], victim: enemies[(n + 2) % 5], assisters: [me.participantId] });
    else if (type === 'dragon' || type === 'herald') Object.assign(e, { name: 'Objective', team: 100 });
    else Object.assign(e, { name: type === 'multikill' ? 'Multikill' : 'GameEnd' });
    return e;
  });
  // The rest of the kill feed (kills you weren't in), illustrative: [t, killer, victim, assisters, by].
  // Ids 1-5 are your team (Darius, Evelynn, Ahri, Jinx, Thresh), 6-10 the enemy (Aatrox, Lee Sin,
  // Syndra, Kai'Sa, Nautilus). It has an execution by a turret and Syndra's triple kill.
  for (const [t, killer, victim, assisters, by] of OTHER_KILLS) {
    const e = { t, name: 'ChampionKill', killer, victim, assisters };
    if (by) e.by = by;
    events.push(e);
  }
  events.sort((a, b) => a.t - b.t);
  const base = s.goldDiffByMinute.map((_, i) => 2500 + i * 2050);
  const team = (id, win, tot, list) => ({ teamId: id, win, kills: tot.kills, gold: tot.gold, damage: list.reduce((a, p) => a + p.damage, 0),
    dragons: tot.dragons, barons: tot.barons, heralds: tot.heralds, grubs: 0, towers: tot.towers, inhibs: 0, bans: [] });
  return {
    v: 1, key: 'EUW1_real-2026-10-17', queueId: 420, queueName: s.queue, gameMode: 'CLASSIC', mapId: 11, patch: '16.20',
    duration: s.duration, result: 'Lose', surrender: false,
    me: { participantId: me.participantId, team: 100, champion: 'Evelynn', alias: 'Evelynn', role: s.role, level: s.level, kills: me.kills, deaths: me.deaths, assists: me.assists,
      kda: 1.8, kp: s.kp, cs: s.cs, csPerMin: s.csPerMin, gold: s.gold, goldPerMin: s.goldPerMin, damage: s.damage, damageShare: s.damageShare, vision: s.vision, items: s.items },
    rank: { queueType: 'RANKED_SOLO_5x5', lpDelta: s.lpDelta, source: 'lp-notification' },
    teams: [team(100, false, s.allyTotals, s.ally), team(200, true, s.enemyTotals, s.enemy)],
    participants,
    events,
    frames: { interval: 60, totalGold: { 100: base.map((b, i) => b + s.goldDiffByMinute[i]), 200: base } },
    pending: [],
  };
}
