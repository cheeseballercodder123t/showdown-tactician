/* Showdown Tactician — tools/headless_arena/teams.js
 *
 * WHY THIS EXISTS
 *   Every arena component needs a team that the real ladder would accept, expressed in the one
 *   format @pkmn/sim actually parses. That is not a triviality, and the repo's own packer cannot
 *   supply it:
 *
 *     `src/team_parser.js`'s `TeamParser.packTeam()` emits sets joined by NEWLINES, with display
 *     names (`Choice Scarf`, `Headlong Rush`) and every EV written out (`0,252,0,0,4,252`).
 *     @pkmn/sim's packed team is a different string: sets joined by `]`, item and move IDS
 *     (`ChoiceScarf`, `HeadlongRush`), zeros and 31 IVs omitted, and four trailing fields the
 *     repo's packer never writes. Feeding the repo's string to a BattleStream produced
 *     "Great Tusk has an invalid happiness value", "Great Tusk's Hidden Power type (Scald) is
 *     invalid" and the whole team collapsed into one malformed set — the multi-set string was
 *     read as ONE set's fields. So this module converts through the sim's own parser instead:
 *
 *        Teams.import(paste)   -- the sim's paste reader, which is the extension's native format
 *        Teams.pack(sets)      -- the sim's packer, giving `]`-joined ID-form sets
 *        new TeamValidator('gen9nationaldex').validateTeam(sets) -> null when legal
 *
 *   `toPaste()` goes the other way (sim sets -> Showdown paste) because the engine's
 *   `TeamParser.parsePokepaste()` speaks paste, not packed: that is the bridge the arena uses to
 *   let the engine play a team the sim built (a mutated one, for instance).
 *
 *   THE FORMAT. `gen9nationaldex` IS [Gen 9] National Dex OU: its banlist is the ND OU banlist
 *   (`ND Uber`, `ND AG`, Arena Trap, Moody, Power Construct, Shadow Tag, King's Rock, Quick Claw,
 *   Razor Fang, Assist, Baton Pass, Last Respects, Shed Tail) and every lower ND tier is defined
 *   as `ruleset: ['[Gen 9] National Dex']` plus bans. There is no `gen9nationaldexou` id in the
 *   sim, and Terastal Clause is part of the ruleset, so no sample team here carries a Tera type.
 *
 *   THE SAMPLES ARE VALIDATED, NOT TRUSTED. The authored pastes are checked against the format's
 *   own validator at load (`reportAll()`), and `pickTeam()` refuses to hand out a sample the
 *   ladder would reject rather than letting a broken team fail later as a confusing sim error.
 *
 * Requires @pkmn/sim, which is a devDependency (the extension itself ships none of it).
 * Run the self-check with:  node tools/headless_arena/teams.js
 */
'use strict';

const bridge = require('./engine_bridge.js');

const SIM_FORMAT_ID = bridge.SIM_FORMAT_ID;
/* The label the engine's state manager recognises (it matches the client's format string). */
const FORMAT_LABEL = bridge.ENGINE_FORMAT_NAME;

function sim() { return bridge.loadSim(); }

/* ------------------------------------------------------------------- the six sample teams */

/**
 * Hand-authored [Gen 9] National Dex OU teams. Every one is a real six, built from sets that the
 * repo's own validated database knows (`src/sets_db.js` checks species, abilities, natures and
 * moves against the vendored dex at load time), and every one is re-validated against
 * `gen9nationaldex` by `reportAll()` — an illegal sample is a loud failure, not a quiet one.
 */
const SAMPLE_TEAMS = {
  /* Hazard-stack balance: the baseline "standard meta" anchor team. */
  hazardStackBalance: [
    'Great Tusk @ Heavy-Duty Boots', 'Ability: Protosynthesis', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- Headlong Rush', '- Rapid Spin', '- Knock Off', '- Stealth Rock', '',
    'Gholdengo @ Air Balloon', 'Ability: Good as Gold', 'EVs: 252 SpA / 4 SpD / 252 Spe', 'Timid Nature',
    '- Make It Rain', '- Shadow Ball', '- Nasty Plot', '- Recover', '',
    'Kingambit @ Leftovers', 'Ability: Supreme Overlord', 'EVs: 252 HP / 252 Atk / 4 SpD', 'Adamant Nature',
    '- Swords Dance', '- Kowtow Cleave', '- Sucker Punch', '- Iron Head', '',
    'Iron Moth @ Heavy-Duty Boots', 'Ability: Quark Drive', 'EVs: 252 SpA / 4 SpD / 252 Spe', 'Timid Nature',
    '- Fiery Dance', '- Sludge Wave', '- U-turn', '- Morning Sun', '',
    'Ting-Lu @ Leftovers', 'Ability: Vessel of Ruin', 'EVs: 252 HP / 4 Atk / 252 SpD', 'Careful Nature',
    '- Stealth Rock', '- Earthquake', '- Ruination', '- Whirlwind', '',
    'Corviknight @ Leftovers', 'Ability: Pressure', 'EVs: 252 HP / 252 Def / 4 SpD', 'Impish Nature',
    '- Iron Defense', '- Body Press', '- Roost', '- U-turn'
  ].join('\n'),

  /* VoltTurn offence: pivots that keep the turn, for the anchor's second flavour. */
  voltTurnOffense: [
    'Raging Bolt @ Leftovers', 'Ability: Protosynthesis', 'EVs: 252 SpA / 4 SpD / 252 Spe', 'Modest Nature',
    '- Thunderclap', '- Draco Meteor', '- Volt Switch', '- Calm Mind', '',
    'Landorus-Therian @ Choice Scarf', 'Ability: Intimidate', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- Earthquake', '- U-turn', '- Stone Edge', '- Explosion', '',
    'Meowscarada @ Heavy-Duty Boots', 'Ability: Protean', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- Flower Trick', '- Knock Off', '- U-turn', '- Spikes', '',
    'Iron Treads @ Booster Energy', 'Ability: Quark Drive', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- Stealth Rock', '- Rapid Spin', '- Earthquake', '- Iron Head', '',
    'Zapdos @ Heavy-Duty Boots', 'Ability: Static', 'EVs: 252 SpA / 4 SpD / 252 Spe', 'Timid Nature',
    '- Thunderbolt', '- Hurricane', '- Volt Switch', '- Roost', '',
    'Kingambit @ Leftovers', 'Ability: Supreme Overlord', 'EVs: 252 HP / 252 Atk / 4 SpD', 'Adamant Nature',
    '- Swords Dance', '- Kowtow Cleave', '- Sucker Punch', '- Iron Head'
  ].join('\n'),

  /* Trick Room: three setters, three slow bodies. This is what the anti-TR persona exists to
   * punish, and it doubles as the engine's hardest clock test. */
  trickRoomSweep: [
    'Porygon2 @ Eviolite', 'Ability: Trace', 'EVs: 252 HP / 252 SpA / 4 SpD', 'Sassy Nature', 'IVs: 0 Spe',
    '- Trick Room', '- Ice Beam', '- Recover', '- Thunderbolt', '',
    'Hatterene @ Leftovers', 'Ability: Magic Bounce', 'EVs: 252 HP / 252 SpA / 4 SpD', 'Quiet Nature', 'IVs: 0 Spe',
    '- Trick Room', '- Dazzling Gleam', '- Psychic', '- Draining Kiss', '',
    'Cresselia @ Leftovers', 'Ability: Levitate', 'EVs: 252 HP / 252 Def / 4 SpD', 'Sassy Nature', 'IVs: 0 Spe',
    '- Trick Room', '- Lunar Dance', '- Moonblast', '- Ice Beam', '',
    'Slowking-Galar @ Heavy-Duty Boots', 'Ability: Regenerator', 'EVs: 252 HP / 252 SpA / 4 SpD', 'Quiet Nature', 'IVs: 0 Spe',
    '- Trick Room', '- Sludge Bomb', '- Future Sight', '- Chilly Reception', '',
    'Mimikyu @ Life Orb', 'Ability: Disguise', 'EVs: 252 HP / 252 Atk / 4 SpD', 'Brave Nature', 'IVs: 0 Spe',
    '- Trick Room', '- Play Rough', '- Shadow Claw', '- Shadow Sneak', '',
    'Aegislash @ Leftovers', 'Ability: Stance Change', 'EVs: 252 HP / 252 Atk / 4 SpD', 'Brave Nature', 'IVs: 0 Spe',
    '- King\'s Shield', '- Sacred Sword', '- Shadow Ball', '- Shadow Sneak'
  ].join('\n'),

  /* The staller core: Protect on everything, and a Flying/Steel body to loop between. Every move
   * here is a Protect-family shield, a recovery move or a hazard, which is exactly the toolkit
   * the anti-Trick-Room persona needs to waste a five-turn clock. */
  stallCore: [
    'Corviknight @ Leftovers', 'Ability: Pressure', 'EVs: 252 HP / 252 Def / 4 SpD', 'Impish Nature',
    '- Protect', '- Roost', '- Body Press', '- U-turn', '',
    'Ferrothorn @ Leftovers', 'Ability: Iron Barbs', 'EVs: 252 HP / 252 Def / 4 SpD', 'Relaxed Nature', 'IVs: 0 Spe',
    '- Protect', '- Stealth Rock', '- Leech Seed', '- Power Whip', '',
    'Gliscor @ Toxic Orb', 'Ability: Poison Heal', 'EVs: 252 HP / 4 Atk / 252 Def', 'Impish Nature',
    '- Protect', '- Earthquake', '- Toxic', '- Spikes', '',
    'Garganacl @ Leftovers', 'Ability: Purifying Salt', 'EVs: 252 HP / 4 Atk / 252 Def', 'Careful Nature',
    '- Protect', '- Salt Cure', '- Recover', '- Iron Defense', '',
    'Skarmory @ Rocky Helmet', 'Ability: Sturdy', 'EVs: 252 HP / 252 Def / 4 SpD', 'Impish Nature',
    '- Protect', '- Spikes', '- Roost', '- Body Press', '',
    'Toxapex @ Black Sludge', 'Ability: Regenerator', 'EVs: 252 HP / 252 Def / 4 SpD', 'Bold Nature',
    '- Protect', '- Scald', '- Recover', '- Haze'
  ].join('\n'),

  /* Off-meta surprises, on purpose: a Choice Band on a grass blade, a special Ting-Lu, coverage
   * where the projected set expects a wall move, snow and a Z-move. Every set is legal, none of
   * them is what a switch-in heuristic projects, which is the point. */
  ladderGimmick: [
    'Kartana @ Choice Band', 'Ability: Beast Boost', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- Leaf Blade', '- Sacred Sword', '- Knock Off', '- Smart Strike', '',
    'Ting-Lu @ Choice Specs', 'Ability: Vessel of Ruin', 'EVs: 252 HP / 252 SpA / 4 SpD', 'Modest Nature',
    '- Earth Power', '- Ruination', '- Dark Pulse', '- Stealth Rock', '',
    'Clefable @ Leftovers', 'Ability: Magic Guard', 'EVs: 252 HP / 252 Def / 4 SpD', 'Bold Nature',
    '- Moonblast', '- Soft-Boiled', '- Calm Mind', '- Flamethrower', '',
    'Excadrill @ Life Orb', 'Ability: Sand Rush', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- Earthquake', '- Iron Head', '- Rock Slide', '- Rapid Spin', '',
    'Ninetales-Alola @ Light Clay', 'Ability: Snow Warning', 'EVs: 252 SpA / 4 SpD / 252 Spe', 'Timid Nature',
    '- Aurora Veil', '- Freeze-Dry', '- Moonblast', '- Encore', '',
    'Porygon-Z @ Normalium Z', 'Ability: Adaptability', 'EVs: 252 SpA / 4 SpD / 252 Spe', 'Timid Nature',
    '- Conversion', '- Tri Attack', '- Ice Beam', '- Thunderbolt'
  ].join('\n')
};

/** A stable order for the samples, so fallbacks and reports are deterministic. */
const SAMPLE_ORDER = ['hazardStackBalance', 'voltTurnOffense', 'trickRoomSweep', 'stallCore', 'ladderGimmick'];

/* ------------------------------------------------------------------------------- conversion */

function looksPacked(text) {
  const body = String(text === null || text === undefined ? '' : text);
  return body.indexOf('\n') === -1 && body.indexOf('|') !== -1;
}

/**
 * Parse a paste OR an already-packed sim team into @pkmn/sim set objects.
 * Throws with the sim's own complaint when neither reader can make sense of the text.
 */
function importSets(text) {
  const body = String(text === null || text === undefined ? '' : text).trim();
  if (!body) throw new Error('teams: empty team text');
  const { Teams } = sim();
  let sets = null;
  if (looksPacked(body)) sets = Teams.unpack(body);
  if (!sets || !sets.length) sets = Teams.import(body);
  if (!sets || !sets.length) {
    throw new Error('teams: neither the paste reader nor the packed reader accepted this team ' +
      '(it is ' + body.length + ' characters; first line: ' + JSON.stringify(body.split('\n')[0]) + ')');
  }
  return sets;
}

/** Legal verdict: `null` when the team is legal, otherwise the validator's messages. */
function validateTeam(textOrSets) {
  const { Teams, TeamValidator } = sim();
  let sets;
  if (Array.isArray(textOrSets)) sets = textOrSets;
  else {
    const body = String(textOrSets === null || textOrSets === undefined ? '' : textOrSets).trim();
    if (!body) return ['team text is empty'];
    sets = looksPacked(body) ? Teams.unpack(body) : null;
    if (!sets || !sets.length) {
      try { sets = Teams.import(body); } catch (e) { return ['the sim could not read the team: ' + e.message]; }
    }
  }
  if (!sets || !sets.length) return ['the sim could not read the team'];
  const validator = new TeamValidator(SIM_FORMAT_ID);
  return validator.validateTeam(sets);
}

/** Paste or packed in, a `]`-joined ID-form packed team out. Throws when illegal. */
function toSimTeam(text) {
  const { Teams } = sim();
  const sets = importSets(text);
  const verdict = validateTeam(sets);
  if (verdict && verdict.length) {
    throw new Error('teams: illegal team for ' + SIM_FORMAT_ID + ': ' + verdict.join('; '));
  }
  return Teams.pack(sets);
}

/** Paste or packed in, a Showdown paste out — the format the engine's TeamParser reads. */
function toPaste(text) {
  const { Teams } = sim();
  const sets = importSets(text);
  return Teams.export(sets);
}

/** Showdown paste in, a packed team out WITHOUT the legality gate (used to report verdicts). */
function packedUnchecked(text) {
  return sim().Teams.pack(importSets(text));
}

/* ---------------------------------------------------------------------------- sample access */

/**
 * Validate every sample once per process. Returns
 * `{ order, verdicts: {name: null|string[]}, legal: [names], illegal: [names] }`.
 */
let sampleReport = null;
function reportAll() {
  if (sampleReport) return sampleReport;
  const verdicts = {};
  const legal = [];
  const illegal = [];
  SAMPLE_ORDER.forEach(function (name) {
    const paste = SAMPLE_TEAMS[name];
    let verdict;
    try {
      verdict = validateTeam(paste);
    } catch (e) {
      verdict = ['the sim threw while validating: ' + e.message];
    }
    verdicts[name] = verdict && verdict.length ? verdict : null;
    (verdict && verdict.length ? illegal : legal).push(name);
  });
  sampleReport = { order: SAMPLE_ORDER.slice(), verdicts: verdicts, legal: legal, illegal: illegal };
  return sampleReport;
}

/** The first sample the ladder accepts, in `SAMPLE_ORDER`. Returns `{name, paste}` or throws. */
function firstLegalSample() {
  const report = reportAll();
  for (let i = 0; i < report.order.length; i++) {
    const name = report.order[i];
    if (!report.verdicts[name]) return { name: name, paste: SAMPLE_TEAMS[name] };
  }
  throw new Error('teams: not one sample team is legal for ' + SIM_FORMAT_ID + ' — ' +
    JSON.stringify(report.verdicts));
}

/** A named sample, validated. Throws a message that names the sample and the validator's reason. */
function pickTeam(name) {
  const key = name || SAMPLE_ORDER[0];
  const paste = SAMPLE_TEAMS[key];
  if (!paste) {
    throw new Error('teams: unknown sample "' + key + '" (have: ' + SAMPLE_ORDER.join(', ') + ')');
  }
  const verdict = validateTeam(paste);
  if (verdict && verdict.length) {
    throw new Error('teams: sample "' + key + '" is not legal for ' + SIM_FORMAT_ID + ': ' + verdict.join('; '));
  }
  return { name: key, paste: paste, packed: toSimTeam(paste) };
}

/* ------------------------------------------------------------------- species -> legal team */

/** One candidate set from the repo's database, converted to a sim set object. */
function candidateToSet(candidate) {
  return {
    species: candidate.species,
    item: candidate.item || '',
    ability: candidate.ability || '',
    nature: candidate.nature || 'Serious',
    evs: Object.assign({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, candidate.evs || {}),
    ivs: Object.assign({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, candidate.ivs || {}),
    moves: (candidate.moves || []).slice(0, 4),
    level: 100
  };
}

/** Strip the protocol's decorations ("Great Tusk, L50, M" / "Slowking-Galar, F") to a species. */
function speciesNameOf(raw) {
  return String(raw || '').split(',')[0].trim();
}

/**
 * Build the best legal six we can for a list of species (a replay's team preview, typically).
 * Prefers the repo's own candidate database — the same pools the engine's pruner and sampler use
 * — over inventing sets, because a team the extension would not simulate is not a fair arena.
 * Falls back, loudly, to a validated sample when the database cannot produce a legal six.
 *
 * Returns `{packed, paste, source, sets, missing, dropped, reasons}`.
 *   source: 'sets-db' when every body came from the database, else 'sample:<name>'
 */
function teamFromSpecies(speciesList) {
  const { ST } = bridge.loadHarness();
  const db = ST && ST.SetDatabase;
  const names = [];
  const missing = [];
  (speciesList || []).forEach(function (raw) {
    const name = speciesNameOf(raw);
    if (!name) return;
    if (names.indexOf(name) !== -1) return;             // Species Clause: first one wins
    names.push(name);
  });
  const dropped = [];
  const sets = [];
  if (db && typeof db.forSpecies === 'function') {
    names.forEach(function (name) {
      const candidates = db.forSpecies(name) || [];
      if (!candidates.length) { missing.push(name); return; }
      const ranked = candidates.slice().sort(function (a, b) { return (b.weight || 0) - (a.weight || 0); });
      sets.push(candidateToSet(ranked[0]));
    });
  } else {
    names.forEach(function (name) { missing.push(name); });
  }

  if (sets.length >= 4) {
    let verdict;
    try {
      verdict = validateTeam(sets);
    } catch (e) {
      verdict = ['the sim threw while validating: ' + e.message];
    }
    if (!verdict || !verdict.length) {
      const { Teams } = sim();
      return {
        packed: Teams.pack(sets),
        paste: Teams.export(sets),
        sets: sets,
        source: 'sets-db',
        missing: missing,
        dropped: dropped,
        reasons: null
      };
    }
    dropped.push({ reason: 'database team rejected: ' + verdict.join('; '), species: names.slice() });
  } else {
    dropped.push({ reason: 'the database resolved only ' + sets.length + ' of ' + names.length + ' species', species: missing.slice() });
  }

  /* Fallback. The sample is validated, so the caller always gets a team it can actually play. */
  const fallback = firstLegalSample();
  const fallbackSets = importSets(fallback.paste);
  const { Teams } = sim();
  return {
    packed: Teams.pack(fallbackSets),
    paste: fallback.paste,
    sets: fallbackSets,
    source: 'sample:' + fallback.name,
    missing: missing,
    dropped: dropped,
    reasons: dropped.map(function (d) { return d.reason; })
  };
}

module.exports = {
  SIM_FORMAT_ID: SIM_FORMAT_ID,
  FORMAT_LABEL: FORMAT_LABEL,
  SAMPLE_TEAMS: SAMPLE_TEAMS,
  SAMPLE_ORDER: SAMPLE_ORDER,
  importSets: importSets,
  validateTeam: validateTeam,
  toSimTeam: toSimTeam,
  toPaste: toPaste,
  packedUnchecked: packedUnchecked,
  reportAll: reportAll,
  firstLegalSample: firstLegalSample,
  pickTeam: pickTeam,
  teamFromSpecies: teamFromSpecies,
  candidateToSet: candidateToSet,
  speciesNameOf: speciesNameOf
};

/* --------------------------------------------------------------------------------- self-check */

if (require.main === module) {
  console.log('format:', SIM_FORMAT_ID, '| engine label:', FORMAT_LABEL);
  const report = reportAll();
  SAMPLE_ORDER.forEach(function (name) {
    const verdict = report.verdicts[name];
    let size = 0;
    let lead = '';
    let packed = '';
    try {
      const sets = importSets(SAMPLE_TEAMS[name]);
      size = sets.length;
      lead = sets[0] && sets[0].species;
      packed = packedUnchecked(SAMPLE_TEAMS[name]);
    } catch (e) { verdict = verdict || ['unreadable: ' + e.message]; }
    console.log('  ' + (verdict ? 'ILLEGAL' : 'legal  ') + ' ' + name +
      ' | mons: ' + size + ' | lead: ' + lead +
      (verdict ? ' | ' + verdict.join('; ') : ''));
    if (packed) console.log('      packed: ' + packed.slice(0, 96) + (packed.length > 96 ? '…' : ''));
  });
  console.log('legal samples:', report.legal.join(', ') || '(none)');
  console.log('illegal samples:', report.illegal.join(', ') || '(none)');

  /* Round-trip proof: paste -> sim sets -> paste must still be the same six. */
  const paste = toPaste(SAMPLE_TEAMS.hazardStackBalance);
  const back = importSets(paste);
  console.log('paste round-trip size:', back.length, '| first species preserved:',
    back[0].species === 'Great Tusk');

  /* Species-derived team: the path the replay splicer uses. */
  const derived = teamFromSpecies(['Great Tusk, L50, M', 'Gholdengo', 'Kingambit', 'Iron Moth',
    'Ting-Lu', 'Corviknight', 'Great Tusk']);
  console.log('teamFromSpecies -> source:', derived.source, '| mons:', derived.sets.length,
    '| missing:', JSON.stringify(derived.missing));
  console.log('  verdict:', JSON.stringify(validateTeam(derived.sets)));

  /* A sample the ladder rejects is a bug in THIS file, not a warning: the arena plays these
   * teams, so exiting 0 while shipping an illegal one is exactly the failure mode that would
   * hide a broken benchmark. Loud, and placed last so every diagnostic above still prints.
   * (Dragapult was the offender: the sim's dex tags it ND Uber, which gen9nationaldex bans.) */
  if (report.illegal.length) {
    console.error('\nFAIL: illegal sample team(s): ' + report.illegal.join(', ') +
      ' — fix the set; the arena cannot play an illegal team.');
    process.exit(1);
  }
  console.log('\nall ' + SAMPLE_ORDER.length + ' sample teams validate for ' + SIM_FORMAT_ID);
  process.exit(0);
}
