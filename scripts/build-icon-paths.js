// Builds src/games/icon-paths.json, the bundled id -> icon path lists for items, summoner spells and
// runes (game-icons.js uses them until it has downloaded fresh ones). Run after a big patch:
//   node scripts/build-icon-paths.js [folder with items.json, summoner-spells.json, perks.json, perkstyles.json]
// Without a folder the lists are downloaded from CommunityDragon. Names are left out to keep it small.
const fs = require('fs');
const path = require('path');
const { KINDS, CDRAGON, mapFromLists } = require('../src/game-icons');
const { fetchBuffer } = require('../src/net');

const OUT = path.join(__dirname, '..', 'src', 'games', 'icon-paths.json');
const from = process.argv[2];

async function list(rel) {
  if (from) return JSON.parse(fs.readFileSync(path.join(from, path.basename(rel)), 'utf8'));
  return JSON.parse((await fetchBuffer(CDRAGON + rel)).toString('utf8'));
}

(async () => {
  const out = {};
  for (const [kind, k] of Object.entries(KINDS)) {
    out[kind] = mapFromLists(kind, await Promise.all(k.lists.map(list)), { names: false });
    console.log(`${kind}: ${Object.keys(out[kind].ids).length} icons`);
  }
  fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
  console.log(`wrote ${OUT} (${fs.statSync(OUT).size} bytes)`);
})().catch((err) => { console.error(err.message); process.exit(1); });
