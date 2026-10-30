// Fake League client (LCU) for testing the match data layer without the real client: a plain-HTTP
// server that answers GET only, checks Basic riot:<password>, and plays back the post-game sequence
// (InProgress, WaitingForStats, PreEndOfGame, EndOfGame). It also makes a temporary League install
// folder with a lockfile and a game log, like the real client writes.
//
// The fixtures are generated (no real players) and shaped like real captures: an end-of-game block
// with 88 stats keys per player and a match-history game with 118. The first four players match
// test/league-mock.js, so a run with both mocks sees one consistent match.
//
//   node test/lcu-mock.js [port]     then start ClipVault with the two flags it prints
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const GAME_ID = 7000000001;
const PLATFORM = 'EUW1';
const PASSWORD = 'testpass';
const PATCH_VERSION = '16.20.827.0198';
const FAKE_JWT = 'eyJhbGciOiJub25lIn0.eyJmYWtlIjp0cnVlfQ.ZmFrZQ'; // obviously fake, to test stripping
const DEFAULT_PHASES = [['InProgress', 1000], ['WaitingForStats', 2000], ['PreEndOfGame', 2000], ['EndOfGame', 0]];

// Ten generated players. `pid` is the match-history participantId (role order within each team,
// deliberately not the live order, so tests prove participants are matched by team + champion).
const ROSTER = [
  { name: 'Tester', championId: 222, alias: 'Jinx', champion: 'Jinx', team: 100, role: 'BOTTOM', pid: 4, k: 2, d: 1, a: 1 },
  { name: 'Ally One', championId: 412, alias: 'Thresh', champion: 'Thresh', team: 100, role: 'UTILITY', pid: 5, k: 0, d: 1, a: 1 },
  { name: 'Ally Two', championId: 86, alias: 'Garen', champion: 'Garen', team: 100, role: 'TOP', pid: 1, k: 1, d: 0, a: 0 },
  { name: 'Ally Three', championId: 64, alias: 'LeeSin', champion: 'Lee Sin', team: 100, role: 'JUNGLE', pid: 2, k: 0, d: 0, a: 0 },
  { name: 'Ally Four', championId: 99, alias: 'Lux', champion: 'Lux', team: 100, role: 'MIDDLE', pid: 3, k: 0, d: 0, a: 0 },
  { name: 'Enemy One', championId: 103, alias: 'Ahri', champion: 'Ahri', team: 200, role: 'MIDDLE', pid: 8, k: 1, d: 1, a: 1 },
  { name: 'Enemy Two', championId: 238, alias: 'Zed', champion: 'Zed', team: 200, role: 'JUNGLE', pid: 7, k: 1, d: 1, a: 0 },
  { name: 'Enemy Three', championId: 122, alias: 'Darius', champion: 'Darius', team: 200, role: 'TOP', pid: 6, k: 0, d: 0, a: 0 },
  { name: 'Enemy Four', championId: 51, alias: 'Caitlyn', champion: 'Caitlyn', team: 200, role: 'BOTTOM', pid: 9, k: 0, d: 1, a: 0 },
  { name: 'Enemy Five', championId: 25, alias: 'Morgana', champion: 'Morgana', team: 200, role: 'UTILITY', pid: 10, k: 0, d: 0, a: 0 },
];
const ME = ROSTER[0];
const SPELLS = { TOP: [4, 12], JUNGLE: [11, 4], MIDDLE: [4, 14], BOTTOM: [4, 7], UTILITY: [4, 14] };
const SPELL_KEYS = { 4: 'SummonerFlash', 7: 'SummonerHeal', 11: 'SummonerSmite', 12: 'SummonerTeleport', 14: 'SummonerDot' };

// Everything a player's stats are generated from. Tester's numbers are the ones tests check:
// exact CS 43 (40 lane + 3 jungle), so it differs from the live value floored to 40.
function line(p) {
  const i = ROSTER.indexOf(p);
  const me = p === ME;
  return {
    level: me ? 9 : 6 + (i % 4),
    minions: me ? 40 : 10 + i * 3,
    neutral: me ? 3 : p.role === 'JUNGLE' ? 20 + i : i % 2,
    gold: me ? 12000 : 7000 + i * 300,
    spent: me ? 11000 : 6500 + i * 300,
    damage: me ? 21000 : 9000 + i * 1500,
    physical: me ? 18000 : 4000 + i * 700,
    magic: me ? 2000 : 4000 + i * 600,
    trueDmg: me ? 1000 : 1000 + i * 200,
    taken: 15000 + i * 300,
    mitigated: 8000 + i * 200,
    heal: 2000 + i * 100,
    shielded: p.role === 'UTILITY' ? 3000 : 0,
    vision: me ? 18 : 10 + i,
    wardsPlaced: me ? 7 : 4 + i,
    wardsKilled: me ? 2 : i % 3,
    controlWards: me ? 3 : i % 2,
    cc: me ? 12 : 5 + i,
    objectives: me ? 4000 : 1000 + i * 300,
    turrets: me ? 1500 : 500 + i * 100,
    items: me ? [3031, 3006, 3094, 3036, 0, 0, 3363] : [3071, 3047, 6333 + (i % 3), 0, 0, 0, 3340],
    roleItem: me ? 3010 : 0,
    spells: SPELLS[p.role],
    perks: me ? [8008, 9111, 9104, 8014, 8139, 8135] : [8010, 9111, 9104, 8299, 8444, 8451],
    styles: me ? [8000, 8100] : [8000, 8400],
    multi: me ? 2 : p.k ? 1 : 0,
  };
}

// ---------------------------------------------------------------- end-of-game block (88 stats keys)

const PERK_KEYS = (fmt) => [0, 1, 2, 3, 4, 5].flatMap((i) => [fmt(i, ''), fmt(i, 1), fmt(i, 2), fmt(i, 3)]);
const EOG_STAT_KEYS = [
  'ASSISTS', 'BARRACKS_KILLED', 'CAUSED_GAME_END_FROM_IGNB_SURRENDER', 'CHAMPIONS_KILLED', 'GAME_ENDED_IN_EARLY_SURRENDER',
  'GAME_ENDED_IN_SURRENDER', 'GOLD_EARNED', 'LARGEST_CRITICAL_STRIKE', 'LARGEST_KILLING_SPREE', 'LARGEST_MULTI_KILL', 'LEVEL',
  'MAGIC_DAMAGE_DEALT_PLAYER', 'MAGIC_DAMAGE_DEALT_TO_CHAMPIONS', 'MAGIC_DAMAGE_TAKEN', 'MINIONS_KILLED', 'NEUTRAL_MINIONS_KILLED',
  'NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE', 'NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE', 'NUM_DEATHS',
  ...PERK_KEYS((i, v) => (v === '' ? `PERK${i}` : `PERK${i}_VAR${v}`)),
  'PERK_PRIMARY_STYLE', 'PERK_SUB_STYLE', 'PHYSICAL_DAMAGE_DEALT_PLAYER', 'PHYSICAL_DAMAGE_DEALT_TO_CHAMPIONS', 'PHYSICAL_DAMAGE_TAKEN',
  'PLAYER_AUGMENT_1', 'PLAYER_AUGMENT_2', 'PLAYER_AUGMENT_3', 'PLAYER_AUGMENT_4', 'PLAYER_AUGMENT_5', 'PLAYER_AUGMENT_6',
  'PLAYER_SUBTEAM', 'PLAYER_SUBTEAM_PLACEMENT', 'ROLE_BOUND_ITEM', 'SIGHT_WARDS_BOUGHT_IN_GAME', 'SPELL1_CAST', 'SPELL2_CAST',
  'TEAM_EARLY_SURRENDERED', 'TEAM_OBJECTIVE', 'TIME_CCING_OTHERS', 'TOTAL_DAMAGE_DEALT', 'TOTAL_DAMAGE_DEALT_TO_BUILDINGS',
  'TOTAL_DAMAGE_DEALT_TO_CHAMPIONS', 'TOTAL_DAMAGE_DEALT_TO_OBJECTIVES', 'TOTAL_DAMAGE_DEALT_TO_TURRETS', 'TOTAL_DAMAGE_SELF_MITIGATED',
  'TOTAL_DAMAGE_SHIELDED_ON_TEAMMATES', 'TOTAL_DAMAGE_TAKEN', 'TOTAL_HEAL', 'TOTAL_HEAL_ON_TEAMMATES', 'TOTAL_TIME_CROWD_CONTROL_DEALT',
  'TOTAL_TIME_SPENT_DEAD', 'TRUE_DAMAGE_DEALT_PLAYER', 'TRUE_DAMAGE_DEALT_TO_CHAMPIONS', 'TRUE_DAMAGE_TAKEN', 'TURRETS_KILLED',
  'VISION_SCORE', 'VISION_WARDS_BOUGHT_IN_GAME', 'WARD_KILLED', 'WARD_PLACED', 'WAS_AFK', 'WAS_PREMADE_WITH_IGNB_GAME_END_CAUSER',
  'WAS_PREMADE_WITH_SEVERE_TRANSGRESSOR', 'WAS_SEVERE_TRANSGRESSOR',
]; // + WIN (winners) or LOSE (losers) = 88

function eogStats(p, won) {
  const l = line(p);
  const s = Object.fromEntries(EOG_STAT_KEYS.map((k) => [k, 0]));
  Object.assign(s, {
    CHAMPIONS_KILLED: p.k, NUM_DEATHS: p.d, ASSISTS: p.a, LEVEL: l.level, MINIONS_KILLED: l.minions, NEUTRAL_MINIONS_KILLED: l.neutral,
    NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE: l.neutral, GOLD_EARNED: l.gold, TOTAL_DAMAGE_DEALT_TO_CHAMPIONS: l.damage,
    PHYSICAL_DAMAGE_DEALT_TO_CHAMPIONS: l.physical, MAGIC_DAMAGE_DEALT_TO_CHAMPIONS: l.magic, TRUE_DAMAGE_DEALT_TO_CHAMPIONS: l.trueDmg,
    TOTAL_DAMAGE_DEALT: l.damage * 5, TOTAL_DAMAGE_TAKEN: l.taken, TOTAL_DAMAGE_SELF_MITIGATED: l.mitigated, TOTAL_HEAL: l.heal,
    TOTAL_DAMAGE_SHIELDED_ON_TEAMMATES: l.shielded, VISION_SCORE: l.vision, WARD_PLACED: l.wardsPlaced, WARD_KILLED: l.wardsKilled,
    VISION_WARDS_BOUGHT_IN_GAME: l.controlWards, TIME_CCING_OTHERS: l.cc, TOTAL_DAMAGE_DEALT_TO_OBJECTIVES: l.objectives,
    TOTAL_DAMAGE_DEALT_TO_TURRETS: l.turrets, TOTAL_DAMAGE_DEALT_TO_BUILDINGS: l.turrets, LARGEST_MULTI_KILL: l.multi,
    ROLE_BOUND_ITEM: l.roleItem, PERK_PRIMARY_STYLE: l.styles[0], PERK_SUB_STYLE: l.styles[1],
  });
  l.perks.forEach((id, i) => { s[`PERK${i}`] = id; });
  s[won ? 'WIN' : 'LOSE'] = 1;
  return s;
}

function eogPlayer(p, { gameId = GAME_ID } = {}) {
  const i = ROSTER.indexOf(p);
  const l = line(p);
  return {
    botPlayer: false, championId: p.championId, championName: p.champion,
    championSquarePortraitPath: `/lol-game-data/assets/v1/champion-icons/${p.championId}.png`,
    detectedTeamPosition: p.role, gameId, isLocalPlayer: p === ME, items: l.items, leaver: false, leaves: 0,
    level: 150 + i, // the account level, not the champion's
    losses: 40, profileIconId: 29, puuid: `test-puuid-${String(i).padStart(2, '0')}`, riotIdGameName: p.name, riotIdTagLine: 'EUW',
    selectedPosition: p.role, severeTransgressor: false, skinEmblemPaths: [], skinSplashPath: '', skinTilePath: '',
    spell1Id: l.spells[0], spell2Id: l.spells[1], stats: eogStats(p, p.team === 100), summonerId: 1000 + i, summonerName: '',
    teamId: p.team, wins: 50,
  };
}

function makeEogBlock({ gameId = GAME_ID, duration = 58, endedAt = Date.now() } = {}) {
  const team = (teamId) => {
    const players = ROSTER.filter((p) => p.team === teamId).map((p) => eogPlayer(p, { gameId }));
    const stats = {};
    for (const pl of players) for (const [k, v] of Object.entries(pl.stats)) stats[k] = (stats[k] || 0) + v;
    return {
      fullId: '', isBottomTeam: teamId === 100, isPlayerTeam: teamId === ME.team, isWinningTeam: teamId === 100,
      memberStatusString: '', name: '', players, stats, tag: '', teamId,
    };
  };
  return {
    basePoints: 0, battleBoostIpEarned: 0, boostIpEarned: 0, boostXpEarned: 0, causedEarlySurrender: false, currentLevel: 150,
    difficulty: '', earlySurrenderAccomplice: false, endOfGameTimestamp: endedAt, experienceEarned: 0, experienceTotal: 0,
    firstWinBonus: 0, gameEndedInEarlySurrender: false, gameId, gameLength: duration, gameMode: 'CLASSIC', gameMutators: [],
    gameType: 'MATCHED_GAME', globalBoostXpEarned: 0, invalid: false, ipEarned: 0, ipTotal: 0, leveledUp: false,
    localPlayer: eogPlayer(ME, { gameId }), loyaltyBoostXpEarned: 0, missionsXpEarned: 0,
    mucJwtDto: { channelClaim: 'fake-claim', domain: 'chat.fake.example', jwt: FAKE_JWT, targetRegion: 'eu' },
    multiUserChatId: 'fake-chat-room', multiUserChatPassword: 'FAKE-CHAT-PASSWORD', myTeamStatus: '', newSpells: [],
    nextLevelXp: 0, preLevelUpExperienceTotal: 0, preLevelUpNextLevelXp: 0, previousLevel: 150, previousXpTotal: 0,
    queueType: 'RANKED_SOLO_5x5', ranked: true, reportGameId: gameId, rerollData: {}, rpEarned: 0, teamBoost: null,
    teamEarlySurrendered: false, teams: [team(100), team(200)], timeUntilNextFirstWinBonus: 0, xbgpBoostXpEarned: 0,
  };
}

// ---------------------------------------------------------------- match history game (118 stats keys)

const HISTORY_BOOL_KEYS = [
  'causedEarlySurrender', 'causedGameEndFromIGNBSurrender', 'earlySurrenderAccomplice', 'firstBloodAssist', 'firstBloodKill',
  'firstInhibitorAssist', 'firstInhibitorKill', 'firstTowerAssist', 'firstTowerKill', 'gameEndedInEarlySurrender',
  'gameEndedInIGNBSurrender', 'gameEndedInSurrender', 'teamEarlySurrendered', 'wasSevereTransgressor', 'win',
];
const HISTORY_STAT_KEYS = [
  ...HISTORY_BOOL_KEYS,
  'assists', 'champLevel', 'combatPlayerScore', 'damageDealtToObjectives', 'damageDealtToTurrets', 'damageSelfMitigated', 'deaths',
  'doubleKills', 'goldEarned', 'goldSpent', 'inhibitorKills', 'item0', 'item1', 'item2', 'item3', 'item4', 'item5', 'item6',
  'killingSprees', 'kills', 'largestCriticalStrike', 'largestKillingSpree', 'largestMultiKill', 'longestTimeSpentLiving',
  'magicDamageDealt', 'magicDamageDealtToChampions', 'magicalDamageTaken', 'neutralMinionsKilled', 'neutralMinionsKilledEnemyJungle',
  'neutralMinionsKilledTeamJungle', 'objectivePlayerScore', 'participantId', 'pentaKills',
  ...PERK_KEYS((i, v) => (v === '' ? `perk${i}` : `perk${i}Var${v}`)),
  'perkPrimaryStyle', 'perkSubStyle', 'physicalDamageDealt', 'physicalDamageDealtToChampions', 'physicalDamageTaken',
  'playerAugment1', 'playerAugment2', 'playerAugment3', 'playerAugment4', 'playerAugment5', 'playerAugment6',
  'playerScore0', 'playerScore1', 'playerScore2', 'playerScore3', 'playerScore4', 'playerScore5', 'playerScore6', 'playerScore7',
  'playerScore8', 'playerScore9', 'playerSubteamId', 'quadraKills', 'roleBoundItem', 'sightWardsBoughtInGame', 'subteamPlacement',
  'timeCCingOthers', 'totalDamageDealt', 'totalDamageDealtToChampions', 'totalDamageTaken', 'totalHeal', 'totalMinionsKilled',
  'totalPlayerScore', 'totalScoreRank', 'totalTimeCrowdControlDealt', 'totalUnitsHealed', 'tripleKills', 'trueDamageDealt',
  'trueDamageDealtToChampions', 'trueDamageTaken', 'turretKills', 'unrealKills', 'visionScore', 'visionWardsBoughtInGame',
  'wardsKilled', 'wardsPlaced',
]; // 118

function historyStats(p) {
  const l = line(p);
  const s = {};
  for (const k of HISTORY_STAT_KEYS) s[k] = HISTORY_BOOL_KEYS.includes(k) ? false : 0;
  Object.assign(s, {
    participantId: p.pid, kills: p.k, deaths: p.d, assists: p.a, champLevel: l.level, totalMinionsKilled: l.minions,
    neutralMinionsKilled: l.neutral, neutralMinionsKilledTeamJungle: l.neutral, goldEarned: l.gold, goldSpent: l.spent,
    totalDamageDealtToChampions: l.damage, physicalDamageDealtToChampions: l.physical, magicDamageDealtToChampions: l.magic,
    trueDamageDealtToChampions: l.trueDmg, totalDamageDealt: l.damage * 5, totalDamageTaken: l.taken, damageSelfMitigated: l.mitigated,
    totalHeal: l.heal, visionScore: l.vision, wardsPlaced: l.wardsPlaced, wardsKilled: l.wardsKilled,
    visionWardsBoughtInGame: l.controlWards, timeCCingOthers: l.cc, damageDealtToObjectives: l.objectives,
    damageDealtToTurrets: l.turrets, largestMultiKill: l.multi, doubleKills: p === ME ? 1 : 0, roleBoundItem: l.roleItem,
    perkPrimaryStyle: l.styles[0], perkSubStyle: l.styles[1], win: p.team === 100, firstBloodKill: p === ME,
  });
  l.items.forEach((id, i) => { s[`item${i}`] = id; });
  l.perks.forEach((id, i) => { s[`perk${i}`] = id; });
  return s;
}

const LANES = { TOP: ['TOP', 'SOLO'], JUNGLE: ['JUNGLE', 'NONE'], MIDDLE: ['MIDDLE', 'SOLO'], BOTTOM: ['BOTTOM', 'CARRY'], UTILITY: ['BOTTOM', 'SUPPORT'] };

function historyParticipant(p) {
  const l = line(p);
  const [lane, role] = LANES[p.role];
  const empty = {};
  return {
    championId: p.championId, highestAchievedSeasonTier: '', participantId: p.pid, spell1Id: l.spells[0], spell2Id: l.spells[1],
    stats: historyStats(p), teamId: p.team,
    timeline: {
      creepsPerMinDeltas: empty, csDiffPerMinDeltas: empty, damageTakenDiffPerMinDeltas: empty, damageTakenPerMinDeltas: empty,
      goldPerMinDeltas: empty, lane, participantId: p.pid, role, xpDiffPerMinDeltas: empty, xpPerMinDeltas: empty,
    },
  };
}

function historyIdentity(p) {
  const i = ROSTER.indexOf(p);
  return {
    participantId: p.pid,
    player: {
      accountId: 2000 + i, currentAccountId: 2000 + i, currentPlatformId: PLATFORM, gameName: p.name, matchHistoryUri: '',
      platformId: PLATFORM, profileIcon: 29, puuid: `test-puuid-${String(i).padStart(2, '0')}`, summonerId: 1000 + i,
      summonerName: '', tagLine: 'EUW',
    },
  };
}

function historyTeam(teamId) {
  const won = teamId === 100;
  return {
    bans: [{ championId: teamId === 100 ? 157 : 555, pickTurn: 1 }], baronKills: 0, dominionVictoryScore: 0,
    dragonKills: won ? 1 : 0, firstBaron: false, firstBlood: won, firstDargon: won, firstInhibitor: false, firstTower: false,
    hordeKills: 0, inhibitorKills: 0, riftHeraldKills: 0, teamId, towerKills: 0, vilemawKills: 0, win: won ? 'Win' : 'Fail',
  };
}

// `only` limits the game to some players, like the match list does (it has just your own line).
function makeHistoryGame({ gameId = GAME_ID, duration = 58, createdAt = Date.now() - 120000, only = null } = {}) {
  const players = [...ROSTER].filter((p) => !only || only.includes(p)).sort((a, b) => a.pid - b.pid);
  return {
    endOfGameResult: 'GameComplete', gameCreation: createdAt, gameCreationDate: new Date(createdAt).toISOString(),
    gameDuration: duration, gameId, gameMode: 'CLASSIC', gameModeMutators: [], gameType: 'MATCHED_GAME',
    gameVersion: PATCH_VERSION, mapId: 11, participantIdentities: players.map(historyIdentity),
    participants: players.map(historyParticipant), platformId: PLATFORM, queueId: 420, seasonId: 0,
    teams: [historyTeam(100), historyTeam(200)],
  };
}

function makeHistoryList(opts = {}) {
  const game = makeHistoryGame({ ...opts, only: [ME] });
  return {
    accountId: 2000, platformId: PLATFORM,
    games: { gameBeginDate: '', gameEndDate: '', gameCount: 1, gameIndexBegin: 0, gameIndexEnd: 1, games: [game] },
  };
}

// ---------------------------------------------------------------- timeline (2 frames for a 58 s game)

// Every LCU timeline event carries every field, zero-filled when unused.
const tlEvent = (fields) => ({
  assistingParticipantIds: [], buildingType: '', itemId: 0, killerId: 0, laneType: '', monsterSubType: '', monsterType: '',
  participantId: 0, position: { x: 0, y: 0 }, skillSlot: 0, teamId: 0, timestamp: 0, towerType: '', type: '', victimId: 0,
  ...fields,
});
const pidOf = (name) => ROSTER.find((p) => p.name === name).pid;

// The kills of test/league-mock.js (plus Ally Two's at 30 s), `lag` seconds later than the live feed.
function timelineEvents(lag) {
  const kill = (t, killer, victim, assists, x, y) => tlEvent({
    type: 'CHAMPION_KILL', timestamp: Math.round((t + lag) * 1000), killerId: pidOf(killer), victimId: pidOf(victim),
    assistingParticipantIds: assists.map(pidOf), position: { x, y },
  });
  return [
    kill(4, 'Tester', 'Enemy One', ['Ally One'], 11800, 2100),
    kill(6.5, 'Tester', 'Enemy Two', [], 12100, 2400),
    kill(10, 'Enemy One', 'Ally One', [], 11500, 1900),
    kill(26, 'Enemy Two', 'Tester', ['Enemy One'], 10900, 1500),
    kill(30, 'Ally Two', 'Enemy Four', ['Tester'], 2000, 12500),
    tlEvent({
      type: 'ELITE_MONSTER_KILL', timestamp: Math.round((40 + lag) * 1000), killerId: pidOf('Ally One'),
      assistingParticipantIds: [pidOf('Tester')], monsterType: 'DRAGON', monsterSubType: 'FIRE_DRAGON', position: { x: 9866, y: 4414 },
    }),
  ];
}

function makeTimeline({ duration = 58, lag = 0.2 } = {}) {
  const frame = (minute, timestamp, events) => {
    const participantFrames = {};
    for (const p of ROSTER) {
      const l = line(p);
      const end = minute > 0;
      const base = p.team === 100 ? { x: 400, y: 400 } : { x: 14400, y: 14400 };
      participantFrames[String(p.pid)] = {
        currentGold: end ? 300 + p.pid * 10 : 500, dominionScore: 0, jungleMinionsKilled: end ? l.neutral : 0,
        level: end ? 3 : 1, minionsKilled: end ? l.minions : 0, participantId: p.pid,
        position: end ? { x: base.x + 3000 + p.pid * 10, y: base.y + 500 } : base, teamScore: 0,
        totalGold: end ? 1200 + p.pid * 50 : 500, xp: end ? 900 + p.pid * 20 : 0,
      };
    }
    return { events, participantFrames, timestamp };
  };
  return { frames: [frame(0, 0, []), frame(1, duration * 1000, timelineEvents(lag))] };
}

// ---------------------------------------------------------------- ranked, session, summoner

const rankedQueue = (queueType, tier, division, lp) => ({
  currentSeasonWinsForRewards: 0, division, highestDivision: division, highestTier: tier, isProvisional: false, leaguePoints: lp,
  losses: 49, miniSeriesProgress: '', previousSeasonEndDivision: '', previousSeasonEndTier: '', provisionalGameThreshold: 5,
  provisionalGamesRemaining: 0, queueType, ratedRating: 0, ratedTier: 'NONE', tier, warnings: null, wins: 50,
});

function makeRankedStats(lp) {
  const solo = rankedQueue('RANKED_SOLO_5x5', 'GOLD', 'II', lp);
  const flex = rankedQueue('RANKED_FLEX_SR', 'SILVER', 'I', 10);
  return { highestRankedEntry: solo, queueMap: { RANKED_FLEX_SR: flex, RANKED_SOLO_5x5: solo }, queues: [solo, flex], seasons: {} };
}

function makeLpNotification({ gameId = GAME_ID } = {}) {
  return {
    afkLpPenaltyAmount: 0, afkLpPenaltyLevel: 0, canDemoteFromTier: true, changeReason: 'GAME', division: 'II', gameId,
    leaguePointDeltaBreakdown: {}, leaguePoints: 66, leaguePointsDelta: 21, losses: 49, provisionalGamesRemaining: 0,
    queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', wasAfkOrLeaver: false, winStreak: 1, wins: 51,
  };
}

// The game-flow session, with the session secrets the real one carries (to test they're never kept).
function makeSession(phase, { gameId = GAME_ID } = {}) {
  const side = (team) => ROSTER.filter((p) => p.team === team).map((p) => ({
    championId: p.championId, puuid: `test-puuid-${String(ROSTER.indexOf(p)).padStart(2, '0')}`, selectedPosition: p.role,
  }));
  return {
    phase,
    gameClient: { observerServerIp: '192.0.2.11', observerServerPort: 8088, running: true, serverIp: '192.0.2.10', serverPort: 7133, visible: true },
    gameData: {
      gameId, gameName: '', isCustomGame: false, password: 'FAKE-GAME-PASSWORD', playerChampionSelections: [],
      queue: { id: 420, type: 'RANKED_SOLO_5x5', description: 'Ranked Solo/Duo', gameMode: 'CLASSIC', mapId: 11, isRanked: true },
      spectatorKey: 'FAKE-SPECTATOR-KEY', spectatorsAllowed: false, teamOne: side(100), teamTwo: side(200),
    },
    map: { gameMode: 'CLASSIC', id: 11, mapStringId: 'SR', name: "Summoner's Rift", platformId: PLATFORM },
  };
}

const SUMMONER = { accountId: 2000, gameName: 'Tester', profileIconId: 29, puuid: 'test-puuid-00', summonerId: 1000, summonerLevel: 150, tagLine: 'EUW' };

// ---------------------------------------------------------------- Live Client allgamedata (same match)

const LIVE_SCRIPT = [
  { EventTime: 0, EventName: 'GameStart' },
  { EventTime: 4, EventName: 'ChampionKill', KillerName: 'Tester', VictimName: 'Enemy One', Assisters: ['Ally One'] },
  { EventTime: 4, EventName: 'FirstBlood', Recipient: 'Tester' },
  { EventTime: 6.5, EventName: 'ChampionKill', KillerName: 'Tester', VictimName: 'Enemy Two', Assisters: [] },
  { EventTime: 6.5, EventName: 'Multikill', KillerName: 'Tester', KillStreak: 2 },
  { EventTime: 10, EventName: 'ChampionKill', KillerName: 'Enemy One', VictimName: 'Ally One', Assisters: [] },
  { EventTime: 26, EventName: 'ChampionKill', KillerName: 'Enemy Two', VictimName: 'Tester', Assisters: ['Enemy One'] },
  { EventTime: 30, EventName: 'ChampionKill', KillerName: 'Ally Two', VictimName: 'Enemy Four', Assisters: ['Tester'] },
  { EventTime: 40, EventName: 'DragonKill', KillerName: 'Ally One', Assisters: ['Tester'], DragonType: 'Fire', Stolen: 'False' },
  { EventTime: 58, EventName: 'GameEnd', Result: 'Win' },
];

// streamer: League's streamer mode, where events name champions instead of players.
// locale: champion display names in another language (identity must come from rawChampionName).
function makeAllGameData({ gameTime = 58.4, until = Infinity, streamer = false, locale = false } = {}) {
  const shown = (p) => (locale && p === ME ? 'ジンクス' : p.champion);
  const who = (name) => (streamer ? shown(ROSTER.find((p) => p.name === name)) : name);
  const events = LIVE_SCRIPT.filter((e) => e.EventTime <= until).map((e, i) => {
    const out = { EventID: i, ...e };
    for (const k of ['KillerName', 'VictimName', 'Recipient']) if (out[k]) out[k] = who(out[k]);
    if (out.Assisters) out.Assisters = out.Assisters.map(who);
    return out;
  });
  const rune = (id) => ({ displayName: '', id, rawDescription: `perk_tooltip_${id}`, rawDisplayName: `perk_displayname_${id}` });
  const spell = (id) => ({
    displayName: '', rawDescription: `GeneratedTip_SummonerSpell_${SPELL_KEYS[id]}_Description`,
    rawDisplayName: `GeneratedTip_SummonerSpell_${SPELL_KEYS[id]}_DisplayName`,
  });
  const me = line(ME);
  return {
    activePlayer: {
      abilities: {}, championStats: {}, currentGold: 450, level: 7,
      fullRunes: {
        generalRunes: me.perks.map(rune), keystone: rune(me.perks[0]), primaryRuneTree: rune(me.styles[0]),
        secondaryRuneTree: rune(me.styles[1]),
        statRunes: [{ id: 5005, rawDescription: 'perk_tooltip_StatModAttackSpeed' }, { id: 5008, rawDescription: 'perk_tooltip_StatModAdaptive' }, { id: 5011, rawDescription: 'perk_tooltip_StatModHealthScaling' }],
      },
      riotId: 'Tester#EUW', riotIdGameName: 'Tester', riotIdTagLine: 'EUW', summonerName: 'Tester#EUW', teamRelativeColors: true,
    },
    allPlayers: ROSTER.map((p) => {
      const l = line(p);
      return {
        championName: shown(p), isBot: false, isDead: false,
        items: l.items.map((itemID, slot) => ({ canUse: false, consumable: false, count: 1, displayName: '', itemID, price: 0, rawDescription: '', rawDisplayName: `Item_${itemID}_Name`, slot }))
          .filter((it) => it.itemID),
        level: p === ME ? 7 : l.level, position: p.role, rawChampionName: `game_character_displayname_${p.alias}`,
        rawSkinName: '', respawnTimer: 0, riotId: `${p.name}#EUW`, riotIdGameName: p.name, riotIdTagLine: 'EUW',
        runes: { keystone: rune(l.perks[0]), primaryRuneTree: rune(l.styles[0]), secondaryRuneTree: rune(l.styles[1]) },
        scores: { assists: p.a, creepScore: Math.floor((l.minions + l.neutral) / 10) * 10, deaths: p.d, kills: p.k, wardScore: l.vision - 0.4 },
        skinID: p === ME ? 4 : 0, skinName: '', summonerName: `${p.name}#EUW`,
        summonerSpells: { summonerSpellOne: spell(l.spells[0]), summonerSpellTwo: spell(l.spells[1]) },
        team: p.team === 100 ? 'ORDER' : 'CHAOS',
      };
    }),
    events: { Events: events },
    gameData: { gameMode: 'CLASSIC', gameTime, mapName: 'Map11', mapNumber: 11, mapTerrain: 'Default' },
  };
}

// ---------------------------------------------------------------- install folder: lockfile and game log

const pad = (n) => String(n).padStart(2, '0');
// The game names its log folders by local time: 2026-10-17T22-36-08.
function localStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// A game log like the real one: the two lines ClipVault reads, plus a command line carrying a
// (fake) session key that must never be read or copied.
// withId: false = a launch that never got as far as the game ID; platformLine: false = the
// platform appears only on the command line (which must not be used).
function writeGameLog(installDir, wallMs, { gameId = GAME_ID, platformId = PLATFORM, withId = true, platformLine = true } = {}) {
  const stamp = localStamp(wallMs);
  const dir = path.join(installDir, 'Logs', 'GameLogs', stamp);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    `000000.010|      0.0000kb|      0.0000kb added| ALWAYS| Logging started at ${stamp}`,
    `000000.011|      0.0000kb|      0.0000kb added| ALWAYS| Command line: "League of Legends.exe" "192.0.2.10 7133 FAKE-SESSION-KEY== 1000" "-Product=LoL" "-PlayerID=2000" "-GameID=${gameId}" "-PlatformID=${platformId}"`,
    '000000.950|      0.0000kb|      0.0000kb added| ALWAYS| Build Version: fake',
    ...(withId ? [`000001.200|      0.0000kb|      0.0000kb added| ALWAYS| GameStartData::GameID=${gameId}`] : []),
    ...(withId && platformLine ? [`000001.201|      0.0000kb|      0.0000kb added| ALWAYS| PlatformID=${platformId}`] : []),
    '000002.000|      0.0000kb|      0.0000kb added| ALWAYS| Loading screen',
  ];
  const file = path.join(dir, `${stamp}_r3dlog.txt`);
  fs.writeFileSync(file, `${lines.join('\r\n')}\r\n`);
  return file;
}

// ---------------------------------------------------------------- the server

// Options: port (0 = any free port), password, phases ([name, ms] steps; the last one stays; a step
// of Infinity waits for endGame()), historyMisses (404s before /games/{id} answers), root (temp folder).
async function startMockLcu({ port = 0, password = PASSWORD, phases = DEFAULT_PHASES, historyMisses = 2, timelineMisses = 0, gameId = GAME_ID, root, logWallMs = Date.now() - 30000, log = false } = {}) {
  const base = root || fs.mkdtempSync(path.join(os.tmpdir(), 'clipvault-lcu-'));
  const installDir = path.join(base, 'League of Legends');
  fs.mkdirSync(installDir, { recursive: true });
  const lockfile = path.join(installDir, 'lockfile');
  const state = { password, calls: [], rejected: [], counts: {}, hang: new Set(), anchor: Date.now(), step: 0 };
  const startedAt = Date.now();

  const phase = () => {
    let t = Date.now() - state.anchor;
    for (let i = state.step; i < phases.length; i++) {
      const [name, ms] = phases[i];
      if (i === phases.length - 1 || t < ms) return name;
      t -= ms;
    }
    return phases[phases.length - 1][0];
  };
  const setPhase = (name) => {
    const i = phases.findIndex(([n]) => n === name);
    if (i < 0) throw new Error(`no phase ${name} in the script`);
    state.step = i;
    state.anchor = Date.now();
  };
  const ended = () => phase() === 'EndOfGame';
  const notFound = (message = 'Resource not found') => [404, { errorCode: 'RPC_ERROR', httpStatus: 404, message }];
  const nth = (p) => { state.counts[p] = (state.counts[p] || 0) + 1; return state.counts[p]; };

  const route = (p) => {
    switch (p) {
      case '/lol-gameflow/v1/gameflow-phase': return [200, phase()];
      case '/lol-gameflow/v1/session': return [200, makeSession(phase(), { gameId })];
      case '/lol-end-of-game/v1/eog-stats-block':
        return ended() ? [200, makeEogBlock({ gameId, endedAt: startedAt + 60000 })] : notFound('No end of game stats available.');
      case '/lol-end-of-game/v1/gameclient-eog-stats-block':
        return ended() ? [200, { gameId, gameMode: 'CLASSIC', isRanked: true, queueId: 420, queueType: 'RANKED_SOLO_5x5', statsBlock: {} }] : notFound();
      case '/lol-ranked/v1/current-lp-change-notification': return ended() ? [200, makeLpNotification({ gameId })] : notFound();
      case '/lol-ranked/v1/current-ranked-stats': return [200, makeRankedStats(ended() ? 66 : 45)];
      case '/lol-match-history/v1/products/lol/current-summoner/matches': return [200, makeHistoryList({ gameId, createdAt: startedAt - 60000 })];
      case '/lol-summoner/v1/current-summoner': return [200, SUMMONER];
      default: break;
    }
    const m = /^\/lol-match-history\/v1\/(games|game-timelines)\/(\d+)$/.exec(p);
    if (m && Number(m[2]) === gameId) {
      const misses = m[1] === 'games' ? historyMisses : timelineMisses;
      if (nth(p) <= misses) return notFound('match file not found');
      return [200, m[1] === 'games' ? makeHistoryGame({ gameId, createdAt: startedAt - 60000 }) : makeTimeline()];
    }
    return m ? notFound('match file not found') : notFound();
  };

  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://127.0.0.1').pathname;
    const reply = (status, body) => {
      state.calls.push({ method: req.method, path: p, status });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    req.resume();
    if (req.method !== 'GET') {
      state.rejected.push({ method: req.method, path: p });
      return reply(405, { errorCode: 'METHOD_NOT_ALLOWED', httpStatus: 405, message: 'this mock only answers GET' });
    }
    if (req.headers.authorization !== `Basic ${Buffer.from(`riot:${state.password}`).toString('base64')}`) {
      return reply(401, { errorCode: 'CREDENTIALS_INVALID', httpStatus: 401, message: 'Invalid credentials' });
    }
    if (state.hang.has(p)) { state.calls.push({ method: req.method, path: p, status: 0 }); return undefined; } // never answers
    const [status, body] = route(p);
    if (log) console.log(`[lcu-mock] GET ${p} -> ${status}`);
    return reply(status, body);
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actualPort = server.address().port;
  const writeLockfile = () => fs.writeFileSync(lockfile, `LeagueClient:1:${actualPort}:${state.password}:http`);
  writeLockfile();
  const gameLog = writeGameLog(installDir, logWallMs, { gameId });

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    root: base,
    installDir,
    lockfile,
    gameLog,
    calls: state.calls,
    rejected: state.rejected,
    count: (p) => state.calls.filter((c) => c.path === p).length,
    phase,
    setPhase,
    endGame: () => setPhase('WaitingForStats'),
    hang: (p) => state.hang.add(p),
    // The client restarted: new password in a new lockfile.
    rotatePassword(next) { state.password = next; writeLockfile(); },
    // The password changed but the lockfile still has the old one (a refused client).
    setPasswordOnly(next) { state.password = next; },
    removeLockfile: () => fs.rmSync(lockfile, { force: true }),
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      for (const s of sockets) s.destroy();
    }),
    cleanup() { if (!root) fs.rmSync(base, { recursive: true, force: true }); },
  };
}

module.exports = {
  startMockLcu, writeGameLog, localStamp, makeEogBlock, makeHistoryGame, makeHistoryList, makeTimeline, makeLpNotification,
  makeRankedStats, makeSession, makeAllGameData, ROSTER, ME, SUMMONER, LIVE_SCRIPT, EOG_STAT_KEYS, HISTORY_STAT_KEYS,
  GAME_ID, PLATFORM, PASSWORD, FAKE_JWT, DEFAULT_PHASES,
};

if (require.main === module) {
  // node test/lcu-mock.js [port]   InProgress for 60 s (like test/league-mock.js), then the post-game screens.
  const port = Number(process.argv[2]) || 2995;
  startMockLcu({ port, phases: [['InProgress', 60000], ['WaitingForStats', 2000], ['PreEndOfGame', 2000], ['EndOfGame', 0]], log: true })
    .then((mock) => {
      console.log(`[lcu-mock] League client API on ${mock.url} (GET only, Basic riot:${PASSWORD})`);
      console.log(`[lcu-mock] start ClipVault with --league-dir="${mock.installDir}" --lcu-api=${mock.url}`);
    });
}
