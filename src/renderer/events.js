// Colours and symbols for key moments: timeline pins, moment chips, library tags, the Matches view
// and the match page. Colours are references to the seven event families in css/tokens.css (kill,
// assist, death, highlight, objective, structure, bookmark) plus victory and defeat; they are only
// used inside style="" values, which accept var(). The symbols are forged metal tokens from
// event-icons.svg (one plate per kind of moment, its own shape and colour); glyphId() is the one
// mapping from a moment's type + label to a token. Loaded as a classic script by index.html and
// imported for its side effect by the view modules (js/views/*.js) and their Node tests, so it
// sets globalThis.EventStyles and has no exports.
(function () {
  // rank decides which symbol wins when moments overlap on the timeline.
  const KILL = 'var(--c-kill)';
  const HIGHLIGHT = 'var(--c-highlight)';
  const OBJECTIVE = 'var(--c-objective)';
  const STRUCTURE = 'var(--c-structure)';
  const TYPES = {
    multikill: { color: HIGHLIGHT, icon: 'swords', name: 'Multikill', rank: 100 },
    ace: { color: HIGHLIGHT, icon: 'crown', name: 'Ace', rank: 90 },
    teamfight: { color: HIGHLIGHT, icon: 'users', name: 'Teamfight', rank: 85 },
    bookmark: { color: 'var(--c-bookmark)', icon: 'bookmark', name: 'Bookmark', rank: 70 },
    baron: { color: OBJECTIVE, icon: 'gem', name: 'Baron Nashor', rank: 80 },
    elder: { color: OBJECTIVE, icon: 'flame-kindling', name: 'Elder Dragon', rank: 78 },
    atakhan: { color: OBJECTIVE, icon: 'flower-2', name: 'Atakhan', rank: 76 },
    victory: { color: 'var(--c-victory)', icon: 'trophy', name: 'Victory', rank: 75 },
    dragon: { color: OBJECTIVE, icon: 'flame', name: 'Dragon', rank: 60 },
    herald: { color: OBJECTIVE, icon: 'eye', name: 'Rift Herald', rank: 58 },
    grubs: { color: OBJECTIVE, icon: 'bug', name: 'Voidgrubs', rank: 55 },
    firstblood: { color: KILL, icon: 'droplet', name: 'First blood', rank: 50 },
    kill: { color: KILL, icon: 'sword', name: 'Kill', rank: 45 },
    inhib: { color: STRUCTURE, icon: 'castle', name: 'Inhibitor', rank: 35 },
    turret: { color: STRUCTURE, icon: 'castle', name: 'Turret', rank: 30 },
    death: { color: 'var(--c-death)', icon: 'skull', name: 'Death', rank: 25 },
    assist: { color: 'var(--c-assist)', icon: 'handshake', name: 'Assist', rank: 20 },
    defeat: { color: 'var(--c-defeat)', icon: 'flag', name: 'Defeat', rank: 15 },
    other: { color: STRUCTURE, icon: 'star', name: 'Moment', rank: 0 },
  };

  // Markers or titles without a type ("Double kill + Baron"): go by the first label.
  function typeFromLabel(label) {
    const l = String(label || '').toLowerCase().split(' + ')[0];
    const rules = [
      [/double|triple|quadra|penta|\dx kill/, 'multikill'], [/^ace/, 'ace'], [/^teamfight/, 'teamfight'], [/^bookmark/, 'bookmark'],
      [/^first blood/, 'firstblood'],
      [/^elder/, 'elder'], [/dragon/, 'dragon'], [/^baron/, 'baron'], [/^rift herald/, 'herald'], [/^voidgrub/, 'grubs'],
      [/^atakhan/, 'atakhan'], [/^turret/, 'turret'], [/^inhib/, 'inhib'], [/^victory/, 'victory'], [/^defeat/, 'defeat'],
      [/^death/, 'death'], [/^assist/, 'assist'], [/^(\d+ )?kills?/, 'kill'],
    ];
    const hit = rules.find(([re]) => re.test(l));
    return hit ? hit[1] : 'other';
  }

  function style(type, label) {
    const t = TYPES[type] ? type : typeFromLabel(label);
    return { type: t, ...TYPES[t] };
  }

  // The token for a moment: multikills by their size, dragons by their element (the game's names
  // and the older "Fire / Earth / Water / Air dragon" ones). small: the -sm twin, drawn for 20 px
  // and below.
  const DIRECT = new Set(['elder', 'baron', 'herald', 'grubs', 'atakhan', 'turret', 'inhib', 'kill', 'firstblood', 'ace',
    'teamfight', 'assist', 'death', 'bookmark', 'victory', 'defeat']);
  const MULTI = [[/penta/, 'penta'], [/quadra/, 'quadra'], [/triple/, 'triple'], [/double/, 'double']];
  const DRAKE = [[/infernal|fire/, 'infernal'], [/mountain|earth/, 'mountain'], [/ocean|water/, 'ocean'], [/cloud|air/, 'cloud'],
    [/hextech/, 'hextech'], [/chemtech/, 'chemtech']];
  function glyphId(type, label, small = false) {
    const t = TYPES[type] ? type : typeFromLabel(label);
    const l = String(label || '').toLowerCase().split(' + ')[0];
    const pick = (rules, d) => (rules.find(([re]) => re.test(l)) || [null, d])[1];
    let name = 'other';
    if (t === 'multikill') name = pick(MULTI, 'double');
    else if (t === 'dragon') name = /elder/.test(l) ? 'elder' : (pick(DRAKE, '') ? `drake-${pick(DRAKE, '')}` : 'drake');
    else if (DIRECT.has(t)) name = t;
    return `ev-${name}${small ? '-sm' : ''}`;
  }

  // <svg> of a moment's token. opts: label (tells multikills and dragons apart), small (20 px and
  // below), cls (the svg's class).
  function icon(type, { label = '', small = true, cls = 'ev' } = {}) {
    return `<svg class="${cls}" aria-hidden="true"><use href="event-icons.svg#${glyphId(type, label, small)}"></use></svg>`;
  }

  // Older clips and match records say "Earth dragon", "Elder dragon" and "Baron": show the game's
  // own names. Changes the label / title fields of the given objects in place (any depth).
  const LEGACY = [
    [/\b(?:Fire|Infernal) dragon\b/g, 'Infernal Drake'], [/\b(?:Earth|Mountain) dragon\b/g, 'Mountain Drake'],
    [/\b(?:Water|Ocean) dragon\b/g, 'Ocean Drake'], [/\b(?:Air|Cloud) dragon\b/g, 'Cloud Drake'],
    [/\b(Hextech|Chemtech) dragon\b/g, '$1 Drake'], [/\bElder dragon\b/g, 'Elder Dragon'], [/\bBaron\b(?! Nashor)/g, 'Baron Nashor'],
  ];
  const leagueName = (text) => LEGACY.reduce((t, [re, to]) => t.replace(re, to), text);
  function renameLegacy(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 6) return value;
    if (Array.isArray(value)) { for (const v of value) renameLegacy(v, depth + 1); return value; }
    for (const k of Object.keys(value)) {
      const v = value[k];
      if ((k === 'label' || k === 'title') && typeof v === 'string') value[k] = leagueName(v);
      else if (v && typeof v === 'object') renameLegacy(v, depth + 1);
    }
    return value;
  }

  globalThis.EventStyles = { style, icon, glyphId, typeFromLabel, TYPES, leagueName, renameLegacy };
})();
