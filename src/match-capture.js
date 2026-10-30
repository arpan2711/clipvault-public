// League match records while a match runs and right after it (A4 §5.4, P1 Phase 2, step A6).
//
//   start(matchStart)        the match was noticed: creates the record "local-<wallAt0>", then gives
//                            it its real key ("EUW1_<gameId>") from the League client's session,
//                            or from the game's own log when the client isn't there
//   addMedia(ctx, kind, e)   a video of the match was saved (clip, full recording, minimap)
//   end(ctx, matchEnd)       the match is over: the final scoreboard, the videos linked in game time,
//                            then the end-of-game stats, LP, match history and timeline from the
//                            League client (GET only, loopback: games/lcu.js)
//   sweep()                  what's still missing (match history, the timeline...) for older matches
//
// Never in the way of capture: every step is best-effort, failures are logged, and anything
// missing stays in the record's `pending` list for the next sweep. Nothing here touches a video.
const lm = require('./games/league-match');
const { retry, BACKOFF } = require('./games/lcu');
const { gameIdFromLogs } = require('./games/league-ids');

const FALLBACK_PLATFORM = 'EUW1';
const SESSION = '/lol-gameflow/v1/session';
const EOG = '/lol-end-of-game/v1/eog-stats-block';
const LP = '/lol-ranked/v1/current-lp-change-notification';
const RANKED = '/lol-ranked/v1/current-ranked-stats';
const HISTORY = (id) => `/lol-match-history/v1/games/${id}`;
const TIMELINE = (id) => `/lol-match-history/v1/game-timelines/${id}`;
const POST_GAME_ONLY = ['eog', 'lp']; // the client shows these on the end-of-game screen only
const DAY = 86400000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tenth = (x) => Math.round(x * 10) / 10;

class MatchCapture {
  // store: a MatchStore. client: an lcu.js client, or null (no League client: game log only).
  // installDir: the League folder (or a function returning it) for the game logs.
  // Timings are options so tests run fast; the defaults are A4's.
  constructor({
    store, client = null, installDir = null, log = () => {}, now = Date.now,
    historyDelays = BACKOFF, eogTries = 20, eogDelayMs = 1000, phaseTimeoutMs = 10 * 60 * 1000, phaseIntervalMs = 2000,
  } = {}) {
    this.store = store;
    this.client = client;
    this.installDir = installDir;
    this.log = log;
    this.now = now;
    this.historyDelays = historyDelays;
    this.eogTries = eogTries;
    this.eogDelayMs = eogDelayMs;
    this.phaseTimeoutMs = phaseTimeoutMs;
    this.phaseIntervalMs = phaseIntervalMs;
    this.current = null;
    this.sweeping = null;
  }

  // ------------------------------------------------------------ the running match

  // `e` is the watcher's match-start ({ wallAt0, detectedAt, gameMode, mapNumber, names, champion })
  // plus `live`, the allgamedata read at the start. Returns the match context at once: ctx.key is
  // the record's current key (it changes when the real key is known); ctx.ready settles when the
  // record exists and has its key, if it could get one.
  start(e = {}) {
    const detectedAt = Number.isFinite(e.detectedAt) ? e.detectedAt : this.now();
    const wallAt0 = Number.isFinite(e.wallAt0) ? e.wallAt0 : null;
    const t0 = Math.round(wallAt0 || detectedAt);
    const ctx = {
      key: `local-${t0}`, t0, wallAt0, detectedAt, names: [].concat(e.names || []), champion: e.champion || null, media: [], done: false,
    };
    this.current = ctx;
    ctx.ready = this._start(ctx, e).catch((err) => { ctx.failed = true; this.log(`match start: ${err.message}`); });
    return ctx;
  }

  // kind 'clip': { file, startWall, duration, title, type, moments }; 'full' | 'map': { file, startWall }.
  // startWall is the wall-clock ms of the video's first frame. Linked when the match ends.
  addMedia(ctx, kind, entry) {
    if (!ctx || !entry || !entry.file) return;
    ctx.media.push({ kind, ...entry });
  }

  // `e` is the watcher's match-end. Resolves the final record, or null. Never rejects.
  async end(ctx, e = {}) {
    if (!ctx) return null;
    ctx.done = true;
    if (this.current === ctx) this.current = null;
    try {
      await ctx.ready;
      if (ctx.failed || !(await this.store.get(ctx.key))) return null;
      if (Number.isFinite(e.wallAt0)) {
        ctx.wallAt0 = e.wallAt0;
        await this.store.update(ctx.key, (r) => { r.clock.wallAt0 = e.wallAt0; });
      }
      if (Array.isArray(e.names) && e.names.length) ctx.names = e.names;
      ctx.champion = ctx.champion || e.champion || null;
      // The final scoreboard and the whole event feed.
      const feed = Array.isArray(e.events) ? e.events : null;
      let data = e.final && typeof e.final === 'object' ? { ...e.final } : null;
      if (!data && feed) data = { allPlayers: e.roster || [], events: { Events: feed }, gameData: { gameMode: e.gameMode, mapNumber: e.mapNumber } };
      if (data && feed && !(data.events && Array.isArray(data.events.Events) && data.events.Events.length >= feed.length)) {
        data.events = { Events: feed };
      }
      if (data) {
        await this._saveRaw(ctx, 'live-final', data);
        await this._merge(ctx, lm.fromLive(data, this._me(ctx), { final: true }));
      }
      for (const m of ctx.media) await this._link(ctx, m);
      if (this.client) await this._postGame(ctx);
      await this._rekey(ctx, { fallback: true });
      await this._dropPostGameOnly(ctx);
      const rec = await this.store.get(ctx.key);
      if (rec) this.log(`match ${rec.key}: saved (${rec.participants.length} players${rec.pending.length ? `; waiting for ${rec.pending.join(', ')}` : ''})`);
      return rec;
    } catch (err) {
      this.log(`match end: ${err.message}`);
      return null;
    }
  }

  // ------------------------------------------------------------ older matches

  // Fills in what's still missing (game ID, match history, timeline) for matches of the last
  // `maxAgeMs`. One attempt per match; it's run again later. Resolves how many matches it changed.
  sweep({ maxAgeMs = 30 * DAY } = {}) {
    if (!this.sweeping) {
      this.sweeping = this._sweep(maxAgeMs)
        .catch((err) => { this.log(`match sweep: ${err.message}`); return 0; })
        .finally(() => { this.sweeping = null; });
    }
    return this.sweeping;
  }

  async _sweep(maxAgeMs) {
    const rows = await this.store.pending({ maxAgeMs });
    let changed = 0;
    for (const row of rows) {
      if (this.current && (this.current.key === row.key || (row.aliases || []).includes(this.current.key))) continue;
      const ctx = { key: row.key, names: [], champion: row.champion, media: [], done: true };
      const before = JSON.stringify(row.pending);
      let rec = await this.store.get(row.key);
      if (!rec) continue;
      if (!rec.gameId) await this._gameIdFromLog(ctx, rec.clock.wallAt0 || rec.startedAt, 5 * 60 * 1000);
      rec = await this.store.get(ctx.key);
      if (rec && rec.gameId && this.client && (rec.pending.includes('history') || rec.pending.includes('timeline'))) {
        await this._history(ctx, rec.gameId, { delays: [], want: rec.pending });
        if (this.client.status() === 'no-client') { await this._rekey(ctx, { fallback: false }); break; } // no League client: later
      }
      // Match history names the platform; until it has answered, a game-log ID keeps its local key
      // unless the log named the platform too.
      rec = await this.store.get(ctx.key);
      await this._rekey(ctx, { fallback: Boolean(rec && rec.gameId && !rec.pending.includes('history')) });
      await this._dropPostGameOnly(ctx);
      const after = await this.store.get(ctx.key);
      if (after && JSON.stringify(after.pending) !== before) changed++;
    }
    return changed;
  }

  // ------------------------------------------------------------ steps

  async _start(ctx, e) {
    const me = this._me(ctx);
    let rec = lm.blankRecord({
      clock: { wallAt0: ctx.wallAt0 }, pending: ['gameId', 'eog', 'history', 'timeline'],
      gameMode: e.gameMode || null, mapId: Number.isFinite(e.mapNumber) ? e.mapNumber : null, startedAt: ctx.wallAt0 || ctx.detectedAt,
    });
    if (e.live && typeof e.live === 'object') {
      const res = lm.merge(rec, [lm.fromLive(e.live, me)], { now: this.now() });
      this._report(ctx.key, 'live', res);
      rec = res.record;
    }
    for (let i = 0; ; i++) {
      rec.key = `local-${ctx.t0 + i}`;
      try {
        await this.store.create(rec);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST' || i >= 5) throw err;
      }
    }
    ctx.key = rec.key;
    // The real key: the client's session (gameId, queue, platform), else the game's own log.
    const session = this.client ? await this._get(SESSION) : null;
    const partial = session ? lm.fromSession(session) : null;
    if (partial && partial.gameId) {
      await this._merge(ctx, partial);
      const queueType = lm.RANKED_QUEUES[partial.queueId];
      if (queueType) {
        const stats = await this._get(RANKED);
        if (stats) {
          await this._saveRaw(ctx, 'ranked-before', stats);
          await this._merge(ctx, lm.fromRanked(stats, { queueType, when: 'before' }));
        }
      }
    } else {
      await this._gameIdFromLog(ctx, ctx.detectedAt) || (ctx.wallAt0 && await this._gameIdFromLog(ctx, ctx.wallAt0, 5 * 60 * 1000));
    }
    await this._adopt(ctx);
    await this._rekey(ctx, { fallback: false });
  }

  // ClipVault restarted in the middle of this match: its record from before the restart (and the
  // backfill of the minimap the restart cut short) is picked back up instead of starting a second
  // one. The same game is the same game ID (the client's session or the game's log), else the
  // same champion, name and start time. Everything found becomes one record, under a real key
  // if one has it, else the oldest.
  async _adopt(ctx) {
    try {
      const rec = await this.store.get(ctx.key);
      if (!rec) return;
      const same = [];
      const ids = new Set(rec.gameId ? [Number(rec.gameId)] : []);
      for (const k of await this.store.findSame(rec)) {
        const other = await this.store.get(k);
        if (!other) continue;
        // Without a game ID on both, only a record still open (no end) is this match.
        if (!(rec.gameId && other.gameId) && lm.endOf(other) !== null) continue;
        if (other.gameId) ids.add(Number(other.gameId));
        same.push(k);
      }
      if (!same.length) return;
      if (ids.size > 1) { this.log(`match ${rec.key}: earlier records ${same.join(', ')} have different game IDs; left alone`); return; }
      const into = same[0];
      for (const k of [...same.slice(1), rec.key]) await this.store.merge(k, into);
      this.log(`match ${rec.key}: the same game as ${same.join(', ')} (restarted mid-match); carrying on with ${into}`);
      ctx.key = into;
    } catch (err) {
      this.log(`match ${ctx.key}: couldn't pick up its earlier record: ${err.message}`);
    }
  }

  // The game ID (and platform, when the log names it) from the game log folder made 0–windowMs
  // before `at`. Resolves true when it found one.
  async _gameIdFromLog(ctx, at, windowMs) {
    const dir = typeof this.installDir === 'function' ? this.installDir() : this.installDir;
    if (!dir || !Number.isFinite(at)) return false;
    let ids = null;
    try {
      ids = await gameIdFromLogs(dir, at, windowMs ? { windowMs } : undefined);
    } catch (err) {
      this.log(`match ${ctx.key}: game log: ${err.message}`);
    }
    if (!ids || !ids.gameId) return false;
    await this.store.update(ctx.key, (r) => {
      if (!r.gameId) { r.gameId = Number(ids.gameId); r.prov.gameId = 'log'; }
      if (!r.platformId && ids.platformId) r.platformId = ids.platformId;
      r.pending = r.pending.filter((x) => x !== 'gameId');
    });
    this.log(`match ${ctx.key}: game ID from the game's log`);
    return true;
  }

  // Gives a "local-…" record its real key once the game ID is known. The platform comes from the
  // session, the end-of-game stats or match history; with `fallback`, EUW1 when none said.
  async _rekey(ctx, { fallback }) {
    try {
      const rec = await this.store.get(ctx.key);
      if (!rec || !rec.gameId || !String(rec.key).startsWith('local-')) {
        if (rec) ctx.key = rec.key;
        return;
      }
      if (!rec.platformId) {
        if (!fallback) return;
        await this.store.update(ctx.key, (r) => { r.platformId = FALLBACK_PLATFORM; r.prov.platformId = 'fallback'; });
        this.log(`match ${ctx.key}: no platform from the client or the log, using ${FALLBACK_PLATFORM}`);
      }
      const out = await this.store.rekey(ctx.key);
      if (out) {
        this.log(`match ${ctx.key} is ${out.key}`);
        ctx.key = out.key;
      }
    } catch (err) {
      this.log(`match ${ctx.key}: no new key: ${err.message}`);
    }
  }

  async _link(ctx, m) {
    try {
      const base = Number.isFinite(ctx.wallAt0) ? ctx.wallAt0 : ctx.detectedAt;
      const at = (wall) => (Number.isFinite(wall) && Number.isFinite(base) ? tenth((wall - base) / 1000) : null);
      if (m.kind === 'clip') {
        const from = at(m.startWall);
        const to = from != null && Number.isFinite(m.duration) ? tenth(from + m.duration) : null;
        const moments = (m.moments || []).map((x) => ({ t: at(x.wallMs), label: x.label || null, type: x.type || null, kind: x.kind || null }));
        const score = Math.max(0, ...(m.moments || []).map((x) => Number(x.score) || 0));
        await this.store.linkMedia(ctx.key, 'clip', { file: m.file, from, to, title: m.title || null, type: m.type || null, score, moments });
      } else {
        await this.store.linkMedia(ctx.key, m.kind, { file: m.file, gameStart: at(m.startWall) });
      }
    } catch (err) {
      this.log(`match ${ctx.key}: couldn't link a video: ${err.message}`);
    }
  }

  // Right after the game: the end-of-game screen's stats and LP, then match history + timeline.
  async _postGame(ctx) {
    let phase = null;
    try {
      phase = await this.client.waitForPhase(['PreEndOfGame', 'EndOfGame'], { timeoutMs: this.phaseTimeoutMs, intervalMs: this.phaseIntervalMs });
    } catch { /* treated as no end-of-game screen */ }
    let rec = await this.store.get(ctx.key);
    if (!phase) {
      this.log(`match ${ctx.key}: no end-of-game screen from the League client`);
    } else {
      // The block can still be the previous game's for a moment: wait until it's this one.
      let eog = null;
      for (let i = 0; i < this.eogTries && !eog; i++) {
        if (i) await sleep(this.eogDelayMs);
        const block = await this._get(EOG);
        const id = block ? lm.fromEog(block).gameId : null;
        if (block && (!rec.gameId || id === rec.gameId)) eog = block;
      }
      if (eog) {
        await this._saveRaw(ctx, 'eog', eog);
        await this._merge(ctx, lm.fromEog(eog));
      } else {
        this.log(`match ${ctx.key}: no end-of-game stats for this game`);
      }
      rec = await this.store.get(ctx.key);
      const queueType = rec && lm.RANKED_QUEUES[rec.queueId];
      if (queueType) {
        const n = await this._get(LP);
        if (n) {
          await this._saveRaw(ctx, 'lp', n);
          await this._merge(ctx, lm.fromLp(n));
        }
        const stats = await this._get(RANKED);
        if (stats) {
          await this._saveRaw(ctx, 'ranked-after', stats);
          await this._merge(ctx, lm.fromRanked(stats, { queueType, when: 'after' }));
        }
      }
      await this._rekey(ctx, { fallback: false });
      rec = await this.store.get(ctx.key);
    }
    if (rec && rec.gameId) await this._history(ctx, rec.gameId, { delays: this.historyDelays, want: rec.pending });
  }

  // Match history (retried until its stats are filled in) and the timeline.
  async _history(ctx, gameId, { delays, want = ['history', 'timeline'] }) {
    let game = null;
    if (want.includes('history')) {
      game = await retry(() => this._get(HISTORY(gameId)), { delays, accept: lm.historyReady });
      if (game) {
        await this._saveRaw(ctx, 'game', game);
        await this._merge(ctx, lm.fromHistory(game));
      } else {
        this.log(`match ${ctx.key}: match history not ready yet`);
      }
    }
    if (want.includes('timeline')) {
      const timeline = await retry(() => this._get(TIMELINE(gameId)), { delays });
      if (timeline) {
        if (!game) game = await this.store.readRaw(ctx.key, 'game').catch(() => null);
        await this._saveRaw(ctx, 'timeline', timeline);
        await this._merge(ctx, lm.fromTimeline(timeline, game));
      } else {
        this.log(`match ${ctx.key}: timeline not ready yet`);
      }
    }
  }

  // The end-of-game stats and LP can't be read once the end-of-game screen is gone.
  async _dropPostGameOnly(ctx) {
    try {
      const rec = await this.store.get(ctx.key);
      if (rec && rec.pending.some((x) => POST_GAME_ONLY.includes(x))) {
        await this.store.update(ctx.key, (r) => { r.pending = r.pending.filter((x) => !POST_GAME_ONLY.includes(x)); });
      }
    } catch (err) {
      this.log(`match ${ctx.key}: ${err.message}`);
    }
  }

  // ------------------------------------------------------------ helpers

  _me(ctx) {
    return ctx.names && ctx.names.length ? { names: ctx.names, champion: ctx.champion } : undefined;
  }

  async _get(p) {
    try {
      return await this.client.get(p);
    } catch (err) {
      this.log(`League client: ${err.message}`);
      return null;
    }
  }

  async _merge(ctx, partial) {
    let report = null;
    try {
      const out = await this.store.update(ctx.key, (r) => {
        report = lm.merge(r, [partial], { now: this.now() });
        return report.record;
      });
      if (report) this._report(ctx.key, partial.source, report);
      return out;
    } catch (err) {
      this.log(`match ${ctx.key}: ${partial && partial.source} not merged: ${err.message}`);
      return null;
    }
  }

  _report(key, source, res) {
    for (const r of res.refused || []) this.log(`match ${key}: ${r.source || source} refused (${r.reason})`);
    for (const m of res.mismatches || []) this.log(`match ${key}: ${m.source} disagrees on ${m.field}: ${JSON.stringify(m.ours)} vs ${JSON.stringify(m.theirs)}`);
  }

  async _saveRaw(ctx, name, doc) {
    try {
      await this.store.saveRaw(ctx.key, name, doc);
    } catch (err) {
      this.log(`match ${ctx.key}: couldn't keep ${name}: ${err.message}`);
    }
  }
}

module.exports = { MatchCapture, FALLBACK_PLATFORM };
