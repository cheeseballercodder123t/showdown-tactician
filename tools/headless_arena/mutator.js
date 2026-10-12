/* Showdown Tactician — tools/headless_arena/mutator.js
 *
 * WHY THIS EXISTS
 *   The engine's set deduction (archetype pruning + Speed-floor clamping) is only ever as good as
 *   the surprises it has been shown. A ladder opponent holding Air Balloon instead of Leftovers,
 *   creeping +24 Speed to jump a floor, or carrying one coverage move the archetype table does not
 *   predict, is exactly the opponent the deduction fallbacks exist for. This module manufactures
 *   those opponents on purpose so the arena can score the engine against them instead of against
 *   the same six sample teams it was tuned on.
 *
 * WHY IT DOES NOT USE TeamParser.toPackedSet()
 *   The original sketch for this module called for repacking mutated sets with the extension's own
 *   `TeamParser.toPackedSet()`. That is measurably wrong, and the measurement is worth writing
 *   down because the mistake is invisible until a battle refuses to start. The repo's packer
 *   separates Pokemon with a newline and writes display names, while @pkmn/sim's packed team
 *   format separates SETS with `]` and writes ID-form items and moves, omitting zero EVs and
 *   31 IVs. Feeding the repo's output to `TeamValidator` for `gen9nationaldex` returned, verbatim:
 *
 *     "Great Tusk has an invalid happiness value."
 *     "Great Tusk's Hidden Power type (Scald) is invalid."
 *     "Great Tusk cannot Gigantamax but is flagged as being able to."
 *
 *   So this module parses with the sim's `Teams.import`, repacks with `Teams.pack`, and validates
 *   through `TeamValidator`. Rule 1 applies to team data exactly as it applies to damage: the sim
 *   owns the format, and nothing here re-implements it. `src/team_parser.js` is read-only context.
 *
 * WHERE THE LEGAL MOVE POOL ACTUALLY LIVES
 *   The first version of this module asked `Dex.species.get(name).learnset` and found it empty, so
 *   every coverage injection was rolled back with "the sim has no learnset for this species". The
 *   property does not exist in @pkmn/sim 0.10.11 — not before `Dex.includeData()` and not after it.
 *   The data lives on the dex data table instead: `Dex.data.Learnsets[speciesId].learnset`, a map of
 *   move id -> the sources that grant it (measured: 1288 species keys, and `learnset['greattusk']`
 *   holds 58 entries). Species ids come from `Dex.species.get(...).id`.
 *
 * HOW A COVERAGE MOVE IS CHOSEN
 *   Two stages, both read from the dex and never from a table written here:
 *     1. the curated COVERAGE_MOVES pool, when the species' learnset actually contains the move —
 *        that is the on-meta surprise (Ice Fang on Ting-Lu, Thunderbolt on Clefable);
 *     2. otherwise the species' own learnset, filtered to real damaging moves.
 *   Candidates are ranked by tier (a damaging move whose TYPE the rest of the set does not already
 *   cover, then any damaging move, then a status move), then by base power, then by id, so the order
 *   is total and stable. The top `COVERAGE_TOP` of the winning tier are kept and one is drawn from
 *   them with the seeded PRNG: "high coverage" rather than "a random move", while a different seed
 *   still explores a different surprise.
 *
 * WHY EVERY RUN REPRODUCES
 *   A fuzz that cannot be replayed cannot be debugged, and a regression the arena cannot reproduce
 *   is not a regression. Every draw comes from an in-file mulberry32 PRNG seeded from
 *   `options.seed`, so a failing battle can be re-run by re-passing the seed the report printed.
 *
 * Run the self-check with:  node tools/headless_arena/mutator.js
 */
'use strict';

const bridge = require('./engine_bridge.js');

const FORMAT_ID = bridge.SIM_FORMAT_ID;
const EV_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const EV_BUDGET = 508;
const EV_CAP = 252;
const DEFAULT_SEED = 0x5eed1a7e;
const DEFAULT_RATE = 0.10;
/* How many of the best-tier coverage candidates the draw is narrowed to (see the header). */
const COVERAGE_TOP = 4;

/* Items a standard set is expected to hold. Only these are swapped away from, so the fuzz does not
 * "discover" that an already-unexpected item is unexpected. */
const STANDARD_ITEMS = [
  'Leftovers', 'Heavy-Duty Boots', 'Choice Scarf', 'Choice Specs', 'Choice Band',
  'Assault Vest', 'Focus Sash', 'Life Orb', 'Rocky Helmet'
];

/* Ladder-plausible surprises, each with a reason it stresses a specific deduction. */
const ITEM_POOL = [
  { item: 'Air Balloon', stress: 'ground-immunity that a type-based switch-in plan does not expect' },
  { item: 'Custap Berry', stress: 'a priority turn the Speed read says cannot happen' },
  { item: 'Chople Berry', stress: 'a resisted hit that fails to earn its KO' },
  { item: 'Weakness Policy', stress: 'punishing a coverage move the archetype table rated as safe' },
  { item: 'Covert Cloak', stress: 'secondary effects the engine counted on' },
  { item: 'Safety Goggles', stress: 'powder and weather immunity' },
  { item: 'Eject Pack', stress: 'a pivot the position read did not price' },
  { item: 'Red Card', stress: 'a forced switch on the turn we committed' }
];

/* Coverage injection candidates, in id form because learnsets are keyed by move id. */
const COVERAGE_MOVES = [
  { id: 'icefang', name: 'Ice Fang' },
  { id: 'thunderbolt', name: 'Thunderbolt' },
  { id: 'flamethrower', name: 'Flamethrower' },
  { id: 'icebeam', name: 'Ice Beam' },
  { id: 'earthquake', name: 'Earthquake' },
  { id: 'stoneedge', name: 'Stone Edge' },
  { id: 'knockoff', name: 'Knock Off' },
  { id: 'uturn', name: 'U-turn' },
  { id: 'focusblast', name: 'Focus Blast' },
  { id: 'sludgewave', name: 'Sludge Wave' },
  { id: 'ironhead', name: 'Iron Head' },
  { id: 'playrough', name: 'Play Rough' },
  { id: 'dazzlinggleam', name: 'Dazzling Gleam' },
  { id: 'suckerpunch', name: 'Sucker Punch' }
];

let cachedSim = null;
function loadSim() {
  if (cachedSim) return cachedSim;
  try {
    cachedSim = require('@pkmn/sim');
  } catch (e) {
    throw new Error('mutator: @pkmn/sim is not installed. The arena needs it as a devDependency ' +
      '(run `npm install`). Original error: ' + ((e && e.message) || e));
  }
  return cachedSim;
}

/** Deterministic PRNG (mulberry32): same seed, same mutations, every run. */
function mulberry32(seed) {
  let a = (seed >>> 0) || DEFAULT_SEED;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toID(text) {
  return String(text === null || text === undefined ? '' : text).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function cloneSet(mon) {
  const out = {};
  Object.keys(mon || {}).forEach(function (k) { out[k] = mon[k]; });
  out.moves = (mon && mon.moves ? mon.moves : []).slice();
  out.evs = Object.assign({}, mon && mon.evs ? mon.evs : {});
  /* An EMPTY `ivs` table is not the same thing as "no IVs", and getting that wrong made the
   * mutator refuse legal teams. The validator treats an ABSENT key as the sim's default (31) but
   * an empty table as zero, so constructing `ivs: {}` for a set that never declared IVs turned a
   * legal Ting-Lu into "must have at least three perfect IVs because it's a legendary in Gen 6 or
   * later" — which the input check then reported as an illegal input, so NO mutation ran at all
   * on any team holding a Gen-6 legendary (Ting-Lu appears in two shipped samples; measured on
   * ladderGimmick and hazardStackBalance, where `Teams.import` hands back all-31 IVs). So the
   * table is carried only when it actually says something. */
  const ivs = Object.assign({}, mon && mon.ivs ? mon.ivs : {});
  if (Object.keys(ivs).length) out.ivs = ivs; else delete out.ivs;
  return out;
}

function evTotal(evs) {
  let sum = 0;
  for (let i = 0; i < EV_KEYS.length; i++) sum += Number(evs[EV_KEYS[i]]) || 0;
  return sum;
}

/** null when legal, else the validator's messages. */
function validateTeam(sets) {
  const sim = loadSim();
  try {
    return new sim.TeamValidator(FORMAT_ID).validateTeam(sets);
  } catch (e) {
    return ['team validator threw: ' + ((e && e.message) || e)];
  }
}

/** Accepts either a Showdown paste or a packed team; throws when neither parses. */
function parseTeam(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('mutator: team text must be a non-empty paste or packed team string');
  }
  const sim = loadSim();
  let sets = null;
  try { sets = sim.Teams.import(text); } catch (e) { sets = null; }
  if (!sets || !sets.length) {
    try { sets = sim.Teams.unpack(text); } catch (e) { sets = null; }
  }
  if (!sets || !sets.length) {
    throw new Error('mutator: could not parse the team — pass a Showdown paste or a packed team');
  }
  return sets.map(cloneSet);
}

class SetMutator {
  constructor(options) {
    options = options || {};
    this.defaultRate = typeof options.mutationRate === 'number' ? options.mutationRate : DEFAULT_RATE;
    this.seed = (options.seed >>> 0) || DEFAULT_SEED;
    this.itemPool = options.itemPool || ITEM_POOL;
    this.coveragePool = options.coveragePool || COVERAGE_MOVES;
  }

  /**
   * Fuzz a team. Returns the mutated team PACKED FOR THE SIM, the change log, and every mutation
   * that was rolled back because it produced an illegal team — so a caller can tell "the fuzz did
   * nothing" apart from "every fuzz was illegal", which are very different findings.
   */
  mutateTeam(teamText, mutationRate, options) {
    options = options || {};
    const sim = loadSim();
    const rate = typeof mutationRate === 'number' && mutationRate >= 0 ? mutationRate : this.defaultRate;
    const seed = (options.seed !== undefined ? options.seed : this.seed) >>> 0;
    const rng = mulberry32(seed);
    const sets = parseTeam(teamText);
    const inputErrors = validateTeam(sets);
    const changes = [];
    const rejected = [];

    /* An already-illegal input cannot be fuzzed meaningfully: every mutation would fail validation
     * for a reason that has nothing to do with the mutation, and the report would blame the fuzz. */
    if (inputErrors) {
      rejected.push({
        slot: null, species: null, field: 'input', attempted: null,
        reason: 'the input team is not legal for ' + FORMAT_ID + ' (' + inputErrors.join('; ') + ')'
      });
      return {
        packed: sim.Teams.pack(sets), sets: sets, changes: changes, rejected: rejected,
        seed: seed, mutationRate: rate, inputErrors: inputErrors
      };
    }

    for (let i = 0; i < sets.length; i++) {
      if (rng() < rate) this._mutateItem(sets, i, rng, changes, rejected);
      if (rng() < rate) this._mutateEvs(sets, i, rng, changes, rejected);
      if (rng() < rate) this._mutateCoverage(sets, i, rng, options, changes, rejected);
    }

    return {
      packed: sim.Teams.pack(sets), sets: sets, changes: changes, rejected: rejected,
      seed: seed, mutationRate: rate, inputErrors: null
    };
  }

  /* ------------------------------------------------------------------ mutations */

  _mutateItem(sets, slot, rng, changes, rejected) {
    const mon = sets[slot];
    const current = mon.item || '';
    const from = current;
    const candidates = this.itemPool.filter(function (entry) { return entry.item !== current; });
    if (!candidates.length) return;
    const picked = candidates[Math.floor(rng() * candidates.length)];
    this._attempt(sets, slot, mon, 'item', from, picked.item, function apply() {
      mon.item = picked.item;
    }, function undo() {
      mon.item = from;
    }, changes, rejected, picked.stress);
  }

  _mutateEvs(sets, slot, rng, changes, rejected) {
    const mon = sets[slot];
    const spe = Number(mon.evs.spe) || 0;
    const wanted = rng() < 0.5 ? 12 : 24;
    const headroom = EV_CAP - spe;
    if (headroom <= 0) {
      rejected.push({ slot: slot, species: mon.species, field: 'evs', attempted: 'spe +' + wanted, reason: 'Speed is already at the ' + EV_CAP + ' cap' });
      return;
    }
    /* The budget is a hard rule: keep the total at or under 508 by trimming the shift to whatever
     * fits, and only give up when not even one point fits. */
    const otherTotal = evTotal(mon.evs) - spe;
    const budgetRoom = EV_BUDGET - otherTotal - spe;
    const delta = Math.min(wanted, headroom, Math.max(0, budgetRoom));
    if (delta <= 0) {
      rejected.push({ slot: slot, species: mon.species, field: 'evs', attempted: 'spe +' + wanted, reason: 'no room under the ' + EV_BUDGET + ' EV budget' });
      return;
    }
    const from = spe;
    const to = spe + delta;
    this._attempt(sets, slot, mon, 'evs', 'spe ' + from, 'spe ' + to, function apply() {
      mon.evs.spe = to;
    }, function undo() {
      mon.evs.spe = from;
    }, changes, rejected, delta === wanted ? 'speed-floor creep' : 'speed-floor creep, trimmed to fit the EV budget');
  }

  _mutateCoverage(sets, slot, rng, options, changes, rejected) {
    const mon = sets[slot];
    if (!mon.moves || !mon.moves.length) return;
    /* "Least used" is the last move in the set unless the caller can supply real usage order —
     * the usage dump is a client-side asset and the sim does not carry it, so pretending otherwise
     * would be a lie in the report. */
    const supplied = options && Array.isArray(options.leastUsed) ? options.leastUsed[slot] : null;
    let targetIndex = mon.moves.length - 1;
    if (supplied) {
      let at = -1;
      for (let i = 0; i < mon.moves.length; i++) if (mon.moves[i] === supplied) { at = i; break; }
      if (at !== -1) targetIndex = at;
    }
    const ranked = this._coverageCandidates(mon, targetIndex);
    if (!ranked) {
      rejected.push({ slot: slot, species: mon.species, field: 'moves', attempted: 'coverage injection', reason: 'the sim has no learnset for this species, so no move can be proven legal' });
      return;
    }
    if (!ranked.pool.length) {
      rejected.push({ slot: slot, species: mon.species, field: 'moves', attempted: 'coverage injection', reason: 'this learnset offers no move the set does not already hold' });
      return;
    }
    const top = ranked.pool.slice(0, COVERAGE_TOP);
    const picked = top[Math.floor(rng() * top.length)];
    const from = mon.moves[targetIndex];
    this._attempt(sets, slot, mon, 'moves', from, picked.name, function apply() {
      mon.moves[targetIndex] = picked.name;
    }, function undo() {
      mon.moves[targetIndex] = from;
    }, changes, rejected, 'coverage injection (' + picked.type + ' ' + picked.basePower +
      ' BP, ' + ranked.stage + ' pool) over the least-used slot');
  }

  /**
   * The ranked coverage candidates for one set, or null when the species has no learnset. See the
   * header for the two-stage rule and the tiering; `stage` names the pool that won.
   */
  _coverageCandidates(mon, targetIndex) {
    const sim = loadSim();
    const learnset = this._learnset(mon);
    if (!learnset) return null;
    const held = {};
    for (let i = 0; i < mon.moves.length; i++) {
      if (i === targetIndex) continue;
      const id = toID(mon.moves[i]);
      if (id) held[id] = true;
    }
    /* The types the rest of the set already covers, from the dex — a "coverage" move that repeats a
     * type the set already has is not coverage. */
    const coveredTypes = {};
    Object.keys(held).forEach(function (id) {
      const move = sim.Dex.moves.get(id);
      if (move && move.exists) coveredTypes[move.type] = true;
    });
    const rank = function (ids) {
      return ids.map(function (id) {
        const move = sim.Dex.moves.get(id);
        if (!move || !move.exists) return null;
        const damaging = (move.basePower || 0) > 0;
        const novel = damaging && !coveredTypes[move.type];
        return {
          id: id, name: move.name, type: move.type, basePower: move.basePower || 0,
          tier: novel ? 3 : (damaging ? 2 : 1)
        };
      }).filter(function (c) { return !!c; })
        .sort(function (a, b) {
          if (b.tier !== a.tier) return b.tier - a.tier;
          if (b.basePower !== a.basePower) return b.basePower - a.basePower;
          return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
        });
    };
    const usable = function (entry) {
      return !!entry && !!entry.id && !held[entry.id] && !!learnset[entry.id];
    };
    const curated = rank((this.coveragePool || []).filter(usable).map(function (e) { return e.id; }));
    /* The curated pool is the on-meta surprise, so it wins whenever it can offer a DAMAGING move; a
     * pool that could only offer status moves is a worse surprise than the species' own coverage. */
    if (curated.length && curated[0].tier >= 2) return { pool: curated, stage: 'curated' };
    const fromLearnset = rank(Object.keys(learnset).filter(function (id) {
      if (held[id]) return false;
      const move = sim.Dex.moves.get(id);
      return !!(move && move.exists && (move.basePower || 0) > 0);
    }));
    if (fromLearnset.length) return { pool: fromLearnset, stage: 'learnset' };
    return { pool: curated, stage: 'curated' };
  }

  /* -------------------------------------------------------------------- helpers */

  /**
   * The sim's own learnset for a species, or null when it has none (never a handwritten list).
   * The species object carries no `learnset` in @pkmn/sim 0.10.11 — measured, with and without
   * `Dex.includeData()` — so the lookup goes through the dex data table, keyed by species id.
   */
  _learnset(mon) {
    const sim = loadSim();
    const species = sim.Dex.species.get(mon.species || mon.name || '');
    const id = species && species.id;
    const table = (sim.Dex.data && sim.Dex.data.Learnsets) || null;
    const entry = id && table ? table[id] : null;
    const learnset = entry && entry.learnset;
    if (!learnset || !Object.keys(learnset).length) return null;
    return learnset;
  }

  /**
   * Apply a mutation, keep it only if the whole team still validates, and roll it back otherwise.
   * `stress` is recorded on success so the change log says what the surprise was for.
   */
  _attempt(sets, slot, mon, field, from, to, apply, undo, changes, rejected, stress) {
    apply();
    const errors = validateTeam(sets);
    if (!errors) {
      changes.push({
        slot: slot, species: mon.species || mon.name, field: field,
        from: from, to: to, stress: stress || null
      });
      return true;
    }
    undo();
    rejected.push({
      slot: slot, species: mon.species || mon.name, field: field,
      attempted: to, reason: (errors || []).join('; ')
    });
    return false;
  }
}

function mutateTeam(teamText, mutationRate, options) {
  return new SetMutator(options).mutateTeam(teamText, mutationRate, options);
}

module.exports = {
  SetMutator: SetMutator,
  mutateTeam: mutateTeam,
  parseTeam: parseTeam,
  validateTeam: validateTeam,
  evTotal: evTotal,
  mulberry32: mulberry32,
  loadSim: loadSim,
  FORMAT_ID: FORMAT_ID,
  STANDARD_ITEMS: STANDARD_ITEMS,
  ITEM_POOL: ITEM_POOL,
  COVERAGE_MOVES: COVERAGE_MOVES,
  COVERAGE_TOP: COVERAGE_TOP,
  toID: toID,
  DEFAULT_SEED: DEFAULT_SEED
};

/* ------------------------------------------------------------------- self-check */

if (require.main === module) {
  /* A three-Pokemon team that the validator accepts as-is, so a rollback means the MUTATION was
   * illegal rather than the fixture. */
  const PASTE = [
    'Great Tusk @ Choice Scarf', 'Ability: Protosynthesis', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- Headlong Rush', '- Close Combat', '- Ice Spinner', '- Rapid Spin', '',
    'Slowking-Galar @ Assault Vest', 'Ability: Regenerator', 'EVs: 252 HP / 4 SpA / 252 SpD', 'Sassy Nature', 'IVs: 0 Spe',
    '- Future Sight', '- Scald', '- Sludge Bomb', '- Flamethrower', '',
    /* 488 EVs rather than 508: the EV-creep class needs headroom, or a full budget would reject
     * every creep for a reason that has nothing to do with the fuzz. */
    'Ferrothorn @ Leftovers', 'Ability: Iron Barbs', 'EVs: 252 HP / 88 Def / 148 SpD', 'Relaxed Nature', 'IVs: 0 Spe',
    '- Stealth Rock', '- Leech Seed', '- Power Whip', '- Protect'
  ].join('\n');

  const base = validateTeam(parseTeam(PASTE));
  console.log('fixture legal for ' + FORMAT_ID + ':', base === null ? 'YES' : 'NO -> ' + base.join('; '));

  const mutator = new SetMutator();
  const out = mutator.mutateTeam(PASTE, 1.0, { seed: 20261012 });
  console.log('seed:', out.seed, '| rate:', out.mutationRate, '| inputErrors:', out.inputErrors);
  console.log('changes kept:', out.changes.length);
  out.changes.forEach(function (c) {
    console.log('  slot ' + c.slot + ' ' + c.species + ' ' + c.field + ': ' + c.from + ' -> ' + c.to + '  (' + c.stress + ')');
  });
  console.log('mutations rejected by the validator:', out.rejected.length);
  out.rejected.forEach(function (r) {
    console.log('  slot ' + r.slot + ' ' + (r.species || '-') + ' ' + r.field + ' ' + (r.attempted === null ? '' : r.attempted) + ' -> ' + r.reason);
  });
  console.log('packed mutated team:');
  console.log(out.packed);

  const fired = {};
  out.changes.forEach(function (c) { fired[c.field] = (fired[c.field] || 0) + 1; });
  const allThree = (fired.item || 0) > 0 && (fired.evs || 0) > 0 && (fired.moves || 0) > 0;
  console.log('classes that fired at rate 1.0: item ' + (fired.item || 0) + ', evs ' + (fired.evs || 0) +
    ', moves ' + (fired.moves || 0) + '  (all three: ' + (allThree ? 'YES' : 'NO') + ')');

  const after = validateTeam(parseTeam(out.packed));
  console.log('mutated team still legal:', after === null ? 'YES' : 'NO -> ' + after.join('; '));

  /* Determinism is the point of the seed: the same call must produce the same team. */
  const again = new SetMutator().mutateTeam(PASTE, 1.0, { seed: 20261012 });
  console.log('same seed reproduces the same team:', again.packed === out.packed ? 'YES' : 'NO');
  process.exit(after === null && again.packed === out.packed && allThree ? 0 : 1);
}
