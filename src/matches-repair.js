// One match, one record: merges the duplicates already in the match store (matches.js). Before
// 2026-10-30, restarting ClipVault in the middle of a League match left up to three records of
// it: the one from before the restart (never ended), a backfill of the minimap the restart cut
// short, and the one after; the last rekey then failed with "match EUW1_… already exists".
//
// Runs at every start and changes nothing once the store is clean (idempotent). Conservative:
//   1. Records with the same game ID (and no platforms that disagree) become one, under the real
//      key ("EUW1_<gameId>"), else the oldest record. Two different real keys: left alone.
//   2. A "local-…" record without an end (no game ID, or the same one) that started while a
//      record with a game ID ran, with the same champion (and name, and mode, where known),
//      goes into that record. More than one such record: left alone.
// Merging keeps the richest stats and timeline, every video (full recordings, minimap parts,
// highlights), the earliest start and the latest end (league-match.js mergeRecords). Videos are
// never touched. With `dryRun`, it only reports what it would merge.
const lm = require('./games/league-match');

const isLocal = (key) => String(key).startsWith('local-');

// store: a MatchStore. Resolves { merges: [{ into, from: [keys], why }], skipped: [{ keys, why }] }.
async function repairMatches(store, { log = () => {}, dryRun = false, windowMs = 3 * 60 * 1000 } = {}) {
  const out = { merges: [], skipped: [] };
  const rows = await store.list();
  const byId = new Map();
  for (const row of rows) {
    if (!row.gameId) continue;
    const id = Number(row.gameId);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(row.key);
  }
  const locals = rows.filter((r) => isLocal(r.key));
  // Only records that might be duplicates are read: shared game IDs, the local ones, and the
  // records that ran near a local one.
  const wanted = new Set([...[...byId.values()].filter((keys) => keys.length > 1).flat(), ...locals.map((r) => r.key)]);
  for (const row of rows) {
    if (row.gameId && Number.isFinite(row.startedAt)
      && locals.some((l) => Number.isFinite(l.startedAt) && Math.abs(l.startedAt - row.startedAt) < 6 * 3600000)) wanted.add(row.key);
  }
  const recs = new Map();
  for (const key of wanted) {
    const rec = await store.get(key);
    if (rec) recs.set(key, rec);
  }
  const gone = new Set(); // merged away (in a dry run: would be)
  const plan = async (into, from, why) => {
    out.merges.push({ into, from, why });
    for (const k of from) gone.add(k);
    log(`${dryRun ? 'would merge' : 'merged'} ${from.join(', ')} into ${into} (${why})`);
    if (dryRun) return;
    for (const k of from) await store.merge(k, into);
  };

  // 1. The same game ID.
  for (const [id, keys] of byId) {
    const group = keys.map((k) => recs.get(k)).filter(Boolean);
    if (group.length < 2) continue;
    if (!group.every((r) => group.every((s) => r === s || lm.sameGame(r, s) === 'id'))) {
      out.skipped.push({ keys, why: `game ${id}: the platforms disagree` });
      log(`left ${keys.join(', ')} alone: game ${id}, but the platforms disagree`);
      continue;
    }
    const real = group.filter((r) => !isLocal(r.key));
    if (real.length > 1) {
      out.skipped.push({ keys, why: `game ${id}: more than one real key` });
      log(`left ${keys.join(', ')} alone: game ${id} under more than one real key`);
      continue;
    }
    const into = real[0] || [...group].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
    await plan(into.key, group.filter((r) => r !== into).map((r) => r.key), `same game ID ${id}`);
  }

  // 2. A local record left open by a restart, inside a match that has its game ID.
  for (const row of locals) {
    if (gone.has(row.key)) continue;
    const loc = recs.get(row.key);
    if (!loc || lm.endOf(loc) !== null) continue;
    const hosts = [...recs.values()].filter((r) => r !== loc && !gone.has(r.key) && r.gameId && lm.endOf(r) !== null
      && (!loc.gameId || Number(loc.gameId) === Number(r.gameId)) && lm.sameGame(loc, r, { windowMs }));
    if (!hosts.length) continue;
    if (hosts.length > 1) {
      out.skipped.push({ keys: [row.key, ...hosts.map((r) => r.key)], why: 'more than one match it could be' });
      log(`left ${row.key} alone: it could be ${hosts.map((r) => r.key).join(' or ')}`);
      continue;
    }
    await plan(hosts[0].key, [row.key], `open record inside ${hosts[0].key}: same champion and time`);
  }

  // A local record that now has its game ID and platform gets its real key.
  if (!dryRun) {
    for (const m of out.merges) {
      const rec = await store.get(m.into);
      if (rec && isLocal(rec.key) && rec.gameId && rec.platformId) {
        const done = await store.rekey(rec.key).catch((err) => { log(`${rec.key}: no new key: ${err.message}`); return null; });
        if (done && done.key !== rec.key) { log(`${rec.key} is ${done.key}`); m.into = done.key; }
      }
    }
  }
  return out;
}

module.exports = { repairMatches };
