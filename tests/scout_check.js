/* Showdown Tactician — tests/scout_check.js
 *
 * Run me with:  node tests/scout_check.js
 *
 * WHAT THIS IS
 *   The regression suite for the offline replay-scouting tool (tools/scout_replays.js) and for
 *   the overlay it writes (src/scout_prior.js), which src/set_pruner.js uses to bend the WEIGHT
 *   of the candidate sets it already holds. It is the twin of tests/chaos_sync_check.js and
 *   tests/weights_check.js: the pure functions are exercised directly, with no network and no
 *   file writes, and only then is the result pushed through the real pruner.
 *
 * WHAT IT MUST PROVE
 *   1. a replay is mined for the dimensions a log can actually support (species, item, ability,
 *      clicked moves) and for NOTHING else — no EVs, IVs or natures anywhere in the output,
 *      which is the RULE 1 property this tool exists to protect;
 *   2. the share arithmetic, including its denominators (per-dimension appearances, deduped, so
 *      one long game cannot outvote four short ones), the min-share floor, and byte-identical
 *      determinism for a given corpus;
 *   3. an empty corpus yields an EMPTY overlay rather than an error, and the rendered file is a
 *      classic-script IIFE that assigns window.ST_SCOUT with the shipped file's exact shape;
 *   4. the pruner applies the prior to a COPY, within [1 - maxBend, 1 + maxBend], only for the
 *      dimensions the overlay actually observed, and leaves a species it never saw completely
 *      untouched — the overlay can re-weight a set, never add or remove one.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about mining a real replay corpus: this repository ships none, and `main()` — the only
 *   function that reads files, fetches `--url` or sets an exit code — is deliberately never
 *   called here, because a suite that writes src/scout_prior.js or sets process.exitCode would be
 *   sabotaging its own run. The CLI flags are covered by parseArgs() only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./harness.js');
const tool = require('../tools/scout_replays.js');

const S = H.loadAll();
const ST = S.ST;
const U = ST.util;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; console.log('  PASS ' + name); return true; }
  failed++;
  failures.push(name + (detail === undefined ? '' : '  ->  ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  ->  ' + detail));
  return false;
}
function eq(name, got, want) {
  return check(name, JSON.stringify(got) === JSON.stringify(want),
    'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

/** Call a tool entry point, recording a FAILED CHECK when it is missing or throws. */
function call(name, fn) {
  if (typeof fn !== 'function') { return check(name, false, 'not a function'); }
  try { return fn(); } catch (e) { check(name, false, String((e && e.message) || e)); return undefined; }
}
function has(name, key) { return check(name, typeof tool[key] === 'function', 'export missing: ' + key); }

/** Load a rendered overlay text the way a browser would, and read window.ST_SCOUT back. */
function loadOverlay(text) {
  const sandbox = H.createSandbox();
  vm.runInContext(String(text), sandbox, { filename: 'scout_prior.js' });
  return sandbox.ST_SCOUT;
}

const FIXED_DATE = '2026-01-01T00:00:00.000Z';

/* --------------------------------------------------------------- fixtures */

/** Every replay starts with the same preamble, so the fixture is readable. */
function replayOf(id, lines) {
  return {
    id: id,
    format: 'gen9nationaldexou',
    players: ['Ash', 'Gary'],
    log: [
      '|player|p1|Ash|1|',
      '|player|p2|Gary|2|',
      '|poke|p1|Great Tusk, L50, M|',
      '|poke|p2|Kingambit, L50, M|',
      '|poke|p2|Corviknight, L50, F|',
      '|teamsize|p1|3',
      '|teamsize|p2|3',
      '|start',
      '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
      '|switch|p2a: Kingambit|Kingambit, L50, M|100/100',
      '|turn|1'
    ].concat(lines || [])
  };
}

const GAME_ONE = replayOf('gen9nationaldexou-1', [
  '|move|p2a: Kingambit|Sucker Punch|p1a: Great Tusk',
  '|-item|p2a: Kingambit|Black Glasses',
  '|-ability|p2a: Kingambit|Supreme Overlord',
  '|move|p2a: Kingambit|Sucker Punch|p1a: Great Tusk',
  '|move|p1a: Great Tusk|Headlong Rush|p2a: Kingambit',
  '|-enditem|p1a: Great Tusk|Leftovers',
  '|move|p2b: Landorus|Earthquake|p1a: Great Tusk'
]);

const GAME_TWO = replayOf('gen9nationaldexou-2', [
  '|move|p2a: Kingambit|Kowtow Cleave|p1a: Great Tusk',
  '|-item|p2a: Kingambit|Leftovers'
]);

/* A third body, used only by the activation check: one body must not be able to "hold" both items
 * in the share arithmetic, or the fixture would prove something no battle can produce. */
const GAME_THREE = replayOf('gen9nationaldexou-3', [
  '|switch|p2b: Corviknight|Corviknight, L50, F|100/100',
  '|-activate|p2b: Corviknight|item: Air Balloon',
  '|move|p2b: Corviknight|Brave Bird|p1a: Great Tusk'
]);

/* ============================================= 1. one replay -> observations */

section('1. a replay is mined for what a log can support, and nothing else');

has('observationsOf is exported', 'observationsOf');
has('linesOf is exported', 'linesOf');

const obs = call('observationsOf mines the fixture replay', function () {
  return tool.observationsOf(GAME_ONE, {});
});

check('the replay is not reported as skipped', !!obs && obs.skipped === false, JSON.stringify(obs && obs.reason));
eq('exactly the two bodies that entered the field are recorded',
  obs && Object.keys(obs.species).sort(), ['greattusk', 'kingambit']);
check('the reveal order/ids are stable and sorted for determinism',
  !!obs && Object.keys(obs.species).join(',') === 'greattusk,kingambit',
  obs && Object.keys(obs.species).join(','));

const king = obs && obs.species.kingambit;
const tusk = obs && obs.species.greattusk;
eq('a body that entered keeps its display name', king && king.name, 'Kingambit');
eq('a repeated move counts ONCE for the appearance', king && king.moves, ['suckerpunch']);
eq('a revealed ability is recorded', king && king.abilities, ['supremeoverlord']);
eq('a revealed item is recorded', king && king.items, ['blackglasses']);
eq('an item taken off the OTHER body is recorded on that body', tusk && tusk.items, ['leftovers']);
eq('moves are attached to the body that clicked them', tusk && tusk.moves, ['headlongrush']);

check('a preview-only body is never an appearance (|poke| no longer farms shares)',
  !!obs && obs.species.corviknight === undefined, JSON.stringify(Object.keys(obs ? obs.species : {})));
check('a move from a body that never switched in attaches to nobody',
  !!obs && obs.species.landorus === undefined, JSON.stringify(Object.keys(obs ? obs.species : {})));

/* The RULE 1 property: a log cannot support EVs, IVs or a nature, so the tool must not record
 * them anywhere — not as keys, not as spellings inside a value. */
const serialized = JSON.stringify(obs);
check('no EV/IV/nature dimension appears anywhere in the observations',
  !/"(evs|ivs|nature|spread|stats)"/.test(serialized) &&
  !/\b(evs|ivs)\b/i.test(serialized),
  serialized.slice(0, 220));
check('the recorded keys are exactly the four a log supports',
  !!king && Object.keys(king).sort().join(',') === 'abilities,items,moves,name',
  king && Object.keys(king).sort().join(','));

section('1b. the side filter, and a log the tool cannot use');

const onlyP2 = call('observationsOf can scope the mining to one side', function () {
  return tool.observationsOf(GAME_TWO, { side: 'p2' });
});
eq('scoping to p2 keeps only the opponent bodies', onlyP2 && Object.keys(onlyP2.species), ['kingambit']);
const onlyP1 = call('...and to the other side', function () {
  return tool.observationsOf(GAME_TWO, { side: 'p1' });
});
/* The preamble does switch a p1 body in, so this replay is NOT skipped: the point of the filter is
 * that p1's body is kept while every p2 body is excluded — and that a body which entered but never
 * revealed anything is recorded with empty dimensions rather than dropped. */
eq('scoping to p1 keeps only the player bodies', onlyP1 && Object.keys(onlyP1.species), ['greattusk']);
eq('...and the replay is still mined', onlyP1 && onlyP1.skipped, false);
eq('...with the p2 identities excluded', onlyP1 && onlyP1.species.kingambit, undefined);
eq('a body that entered but revealed nothing has empty dimensions',
  onlyP1 && onlyP1.species.greattusk && [onlyP1.species.greattusk.items, onlyP1.species.greattusk.moves], [[], []]);

const junk = call('a replay of garbage is skipped, not thrown on', function () {
  return tool.observationsOf({ log: '|garbage|not|a|line\nnot a line at all\n|turn|1' }, {});
});
check('the junk replay is marked skipped with a reason', !!junk && junk.skipped === true && !!junk.reason,
  JSON.stringify(junk && [junk.skipped, junk.reason]));
const empty = call('an empty log is skipped too', function () {
  return tool.observationsOf({ log: '' }, {});
});
check('an empty log yields no species and no throw', !!empty && empty.skipped === true &&
  Object.keys(empty.species).length === 0, JSON.stringify(empty && empty.species));
const noLog = call('a replay with no log at all is refused by skipping', function () {
  return tool.observationsOf({}, {});
});
check('a missing log is skipped rather than throwing on undefined',
  !!noLog && noLog.skipped === true && Object.keys(noLog.species).length === 0,
  JSON.stringify(noLog && [noLog.skipped, noLog.lines]));

section('1c. the activation clause is an item reveal, not a move');

const activated = call('|-activate| item: is mined as an item', function () {
  return tool.observationsOf(GAME_THREE, {});
});
const activBody = activated && activated.species.corviknight;
check('an activated item lands in items', !!activBody && activBody.items.indexOf('airballoon') !== -1,
  JSON.stringify(activBody && activBody.items));
check('an activated ITEM is never mistaken for a move',
  !!activBody && activBody.moves.indexOf('airballoon') === -1 &&
  activBody.moves.indexOf('itemairballoon') === -1,
  JSON.stringify(activBody && activBody.moves));
eq('...and the move it clicked is still recorded as a move', activBody && activBody.moves, ['bravebird']);

/* ===================================================== 2. the share arithmetic */

section('2. shares, the per-dimension denominators and determinism');

const corpus = [GAME_ONE, GAME_TWO];
const prior = call('buildPrior folds the corpus', function () {
  return tool.buildPrior(corpus, { date: FIXED_DATE, minShare: 5 });
});

eq('the corpus size is reported as mined replays', prior && prior.replays, 2);
eq('the pinned date is used verbatim', prior && prior.generatedAt, FIXED_DATE);
eq('the app/seen counts are per species', prior && prior.species.kingambit && prior.species.kingambit.seen, 2);
eq('one item on each of two appearances is a 50/50 split',
  prior && prior.species.kingambit && prior.species.kingambit.items,
  { blackglasses: 50, leftovers: 50 });
eq('the collections are sorted by share desc then id asc (so a re-run is byte-identical)',
  prior && Object.keys(prior.species.kingambit.items), ['blackglasses', 'leftovers']);
eq('a move clicked in one of two appearances is a 50% share',
  prior && prior.species.kingambit && prior.species.kingambit.moves,
  { kowtowcleave: 50, suckerpunch: 50 });

const deterministic = call('a second build is identical', function () {
  return tool.buildPrior([GAME_ONE, GAME_TWO], { date: FIXED_DATE, minShare: 5 });
});
check('buildPrior is deterministic for a given corpus',
  JSON.stringify(deterministic) === JSON.stringify(prior),
  'the two serializations differ');

const floored = call('--min-share drops a share below the floor', function () {
  return tool.buildPrior(corpus, { date: FIXED_DATE, minShare: 60 });
});
eq('a 50% share is dropped by a 60% floor',
  floored && floored.species.kingambit && floored.species.kingambit.items, {});
eq('a 100% share survives a 60% floor', floored && floored.species.kingambit.abilities,
  { supremeoverlord: 100 });

const seenOnce = call('a species that switched in twice in ONE replay is one appearance', function () {
  return tool.buildPrior([replayOf('gen9nationaldexou-3', [
    '|switch|p2a: Kingambit|Kingambit, L50, M|100/100',
    '|move|p2a: Kingambit|Sucker Punch|p1a: Great Tusk',
    '|-item|p2a: Kingambit|Black Glasses'
  ])], { date: FIXED_DATE, minShare: 5 });
});
eq('one long game cannot outvote four short ones', seenOnce && seenOnce.species.kingambit.seen, 1);
eq('...and its single item is a full share', seenOnce && seenOnce.species.kingambit.items,
  { blackglasses: 100 });

section('2b. the degenerate corpora');

const emptyPrior = call('an empty corpus yields an empty overlay rather than throwing', function () {
  return tool.buildPrior([], { date: FIXED_DATE, minShare: 5 });
});
eq('an empty corpus reports zero replays', emptyPrior && emptyPrior.replays, 0);
eq('an empty corpus carries no species at all', emptyPrior && emptyPrior.species, {});
const emptyWrapper = call('{replays: []} is accepted as an empty corpus', function () {
  return tool.buildPrior({ replays: [] }, { date: FIXED_DATE, minShare: 5 });
});
eq('the wrapper form behaves identically', emptyWrapper && emptyWrapper.species, {});
const unreadable = call('a corpus of unreadable replays is not an error', function () {
  return tool.buildPrior([{ log: '' }, { log: 'nonsense' }, null], { date: FIXED_DATE, minShare: 5 });
});
eq('nothing mined means nothing in the overlay', unreadable && unreadable.species, {});
eq('...and the mined count stays honest at zero', unreadable && unreadable.replays, 0);

let refused = false;
try { tool.replaysOf({ nope: 1 }); } catch (e) { refused = /array of replays/.test(String(e && e.message)); }
check('a corpus that is neither an array nor {replays:[...]} is refused, not guessed at', refused);

/* =========================================================== 3. renderFile */

section('3. the rendered overlay is a classic-script IIFE with the shipped shape');

has('renderFile is exported', 'renderFile');
const text = call('renderFile renders the empty prior', function () {
  return tool.renderFile(emptyPrior);
});
const shippedPath = path.join(H.ROOT, 'src', 'scout_prior.js');
const shippedText = fs.readFileSync(shippedPath, 'utf8');
const shipped = loadOverlay(shippedText);
const rendered = loadOverlay(text);

check('the generated header is preserved',
  typeof text === 'string' && text.indexOf('GENERATED DATA FILE - do not edit by hand') !== -1,
  String(text).slice(0, 120));
check('the rendered file is an IIFE assigning window.ST_SCOUT',
  typeof text === 'string' && text.indexOf('window.ST_SCOUT = ') !== -1 &&
  /\(function \(\) \{/.test(text) && /'use strict';/.test(text),
  String(text).slice(-200));
eq('the top-level shape is exactly the documented five keys',
  Object.keys(rendered).sort(), ['generatedAt', 'minShare', 'replays', 'source', 'species']);
eq('the shipped file has the identical shape',
  Object.keys(shipped).sort(), Object.keys(rendered).sort());
eq('an empty prior renders an empty species map, like the shipped file',
  rendered.species, {});
eq('the shipped file ships empty as documented', shipped.species, {});

/* The payload must not carry a dimension a replay cannot support. The header legitimately
 * explains EVs and natures in prose — and it documents the shape with the very string
 * `window.ST_SCOUT = ` — so the slice starts at the LAST occurrence, which is the assignment. */
const payload = String(text).slice(String(text).lastIndexOf('window.ST_SCOUT = '));
check('the rendered payload carries no EV/IV/nature dimension',
  !/(evs|ivs|nature|spread)/i.test(payload), payload.slice(0, 200));

const speciesShaped = call('renderFile renders a populated prior too', function () {
  return tool.renderFile(prior);
});
const populated = loadOverlay(speciesShaped);
eq('a populated overlay round-trips through the generated file',
  populated.species.kingambit.items, { blackglasses: 50, leftovers: 50 });

/* ================================================================= 4. CLI */

section('4. parseArgs');

has('parseArgs is exported', 'parseArgs');
const args = call('parseArgs reads the documented flags', function () {
  return tool.parseArgs(['--input', 'replays.json', '--out', 'src/scout_prior.js', '--min-share', '5', '--side', 'p2']);
});
eq('--input and --out parse as strings',
  [args && args.input, args && args.out], ['replays.json', 'src/scout_prior.js']);
eq('--min-share parses as a string for main() to number()', args && args['min-share'], '5');
eq('--side parses as a string', args && args.side, 'p2');
const eqForm = call('parseArgs accepts --key=value', function () {
  return tool.parseArgs(['--input=replays.json', '--min-share=7']);
});
eq('the = spelling is equivalent', [eqForm && eqForm.input, eqForm && eqForm['min-share']], ['replays.json', '7']);
const bare = call('parseArgs tolerates a bare flag', function () {
  return tool.parseArgs(['--input', 'a.json', '--verbose']);
});
eq('a flag with no value becomes true rather than eating the next flag',
  [bare && bare.input, bare && bare.verbose], ['a.json', true]);
eq('no arguments parses to no arguments (main() applies the defaults)', tool.parseArgs([]), {});
const urlForm = call('parseArgs accepts a --url', function () {
  return tool.parseArgs(['--url', 'https://replay.pokemonshowdown.com/gen9nationaldexou-1.json']);
});
check('--url parses into a usable string',
  typeof (urlForm && urlForm.url) === 'string' && urlForm.url.indexOf('https://') === 0,
  JSON.stringify(urlForm));

/* ============================================== 5. the pruner consumes it */

section('5. the pruner re-weights a COPY, only where the overlay saw something');

const SPECIES = 'Great Tusk';
const dbPool = ST.SetDatabase.forSpecies(SPECIES);
check('fixture sanity: the database holds several sets for the probe species',
  Array.isArray(dbPool) && dbPool.length >= 2, JSON.stringify(dbPool && dbPool.length));
const dbWeights = dbPool.map(function (s) { return [s.id, s.weight]; });
const items = dbPool.map(function (s) { return s.item ? U.toID(s.item) : ''; });
const distinct = items.filter(function (v, i) { return v && items.indexOf(v) === i; });
check('fixture sanity: at least two of those sets hold different items',
  distinct.length >= 2, JSON.stringify(items));

const MAX_BEND = ST.configGet('pruner.scout.maxBend', 0.5);
check('the bend is the documented fraction',
  typeof MAX_BEND === 'number' && MAX_BEND > 0 && MAX_BEND < 1, String(MAX_BEND));

function probeMon(slot) {
  // A fresh slot per probe: the pristine pool is cached per (side|slot|species) key.
  return { species: SPECIES, id: U.toID(SPECIES), side: 'p2', slot: slot, revealedMoves: [] };
}
const pruner = new ST.ArchetypePruner({ damage: new ST.DamageEngine({ gen: 9 }) });

const untouched = call('_seedPool runs with no overlay entry for the species', function () {
  return pruner._seedPool(probeMon('p2a'));
});
eq('an unseen species keeps the database pool size', untouched.length, dbPool.length);
check('...and every curated weight is EXACTLY what the database says',
  untouched.every(function (s) {
    const ref = dbWeights.filter(function (w) { return w[0] === s.id; })[0];
    return ref && ref[1] === s.weight;
  }), JSON.stringify(untouched.map(function (s) { return [s.id, s.weight]; })));
check('...and no scout factor is stamped on them',
  untouched.every(function (s) { return s.scoutFactor === undefined; }),
  JSON.stringify(untouched.map(function (s) { return s.scoutFactor; })));

const WANTED = distinct[0];
const UNWANTED = distinct[1];
check('fixture sanity: the two probe items differ', WANTED !== UNWANTED, WANTED + ' vs ' + UNWANTED);

const overlay = S.window.ST_SCOUT;
overlay.species[U.toID(SPECIES)] = {
  name: SPECIES,
  seen: 4,
  items: (function () { const o = {}; o[WANTED] = 100; o[UNWANTED] = 0; return o; })(),
  abilities: {},
  moves: {}
};

const scoutedMon = probeMon('p2b');
const scouted = call('_seedPool applies the prior on a fresh mon', function () {
  return pruner._seedPool(scoutedMon);
});
eq('the overlay can never add or drop a set', scouted.length, dbPool.length);
check('every factor stays inside [1 - maxBend, 1 + maxBend]',
  scouted.every(function (s) {
    return typeof s.scoutFactor === 'number' &&
      s.scoutFactor >= 1 - MAX_BEND - 1e-9 && s.scoutFactor <= 1 + MAX_BEND + 1e-9;
  }), JSON.stringify(scouted.map(function (s) { return [s.id, s.scoutFactor]; })));

const wantedSets = scouted.filter(function (s) { return s.item && U.toID(s.item) === WANTED; });
const unwantedSets = scouted.filter(function (s) { return s.item && U.toID(s.item) === UNWANTED; });
check('fixture sanity: both probed items survive in the pool',
  wantedSets.length > 0 && unwantedSets.length > 0,
  JSON.stringify(scouted.map(function (s) { return s.item; })));
check('the item the opponent actually ran draws a heavier weight than one they never did',
  Math.min.apply(null, wantedSets.map(function (s) { return s.weight; })) >
  Math.max.apply(null, unwantedSets.map(function (s) { return s.weight; })),
  JSON.stringify(wantedSets.concat(unwantedSets).map(function (s) { return [s.item, s.weight]; })));
check('a fully-observed item gets the full positive bend',
  wantedSets.every(function (s) { return Math.abs(s.scoutFactor - (1 + MAX_BEND)) < 1e-9; }),
  JSON.stringify(wantedSets.map(function (s) { return s.scoutFactor; })));
check('an item the overlay never saw gets the full negative bend',
  unwantedSets.every(function (s) { return Math.abs(s.scoutFactor - (1 - MAX_BEND)) < 1e-9; }),
  JSON.stringify(unwantedSets.map(function (s) { return s.scoutFactor; })));
check('the deduction is recorded on the mon for the HUD',
  pruner._reasons(scoutedMon).some(function (r) { return /scouting prior/i.test(r); }),
  JSON.stringify(pruner._reasons(scoutedMon).slice(-2)));
check('the pristine pool itself carries the scout factor',
  (pruner._pristine['p2|p2b|' + U.toID(SPECIES)] || []).some(function (s) { return s.scoutFactor !== undefined; }),
  'the pristine pool carries no scout factor');

/* A dimension the overlay never observed must not vote: with moves/abilities empty, a set's
 * weight must move by the ITEM dimension alone, so two sets with the same item keep the same
 * factor whatever their moves are. */
const sameItem = scouted.filter(function (s) { return s.item && U.toID(s.item) === WANTED; });
check('unobserved dimensions cannot differentiate two sets',
  sameItem.length < 2 || sameItem.every(function (s) { return s.scoutFactor === sameItem[0].scoutFactor; }),
  JSON.stringify(sameItem.map(function (s) { return [s.id, s.scoutFactor]; })));

check('the database itself was never written to',
  ST.SetDatabase.forSpecies(SPECIES).every(function (s) {
    const ref = dbWeights.filter(function (w) { return w[0] === s.id; })[0];
    return ref && ref[1] === s.weight;
  }), JSON.stringify(ST.SetDatabase.forSpecies(SPECIES).map(function (s) { return [s.id, s.weight]; })));

/* Restore the overlay and the config so a later suite in the same process sees a clean tree. */
delete overlay.species[U.toID(SPECIES)];
ST.configMerge({ pruner: { scout: { enabled: true, maxBend: MAX_BEND } } });
eq('the overlay entry is removed again', overlay.species[U.toID(SPECIES)], undefined);

/* ============================ 7b. team-preview synergy (a second prior on the same pool) */

section('7b. team-preview synergy: their six names re-weight each body, boundedly');

const synergyPruner = new ST.ArchetypePruner();
const W_WEATHER = ST.configGet('pruner.synergy.weatherFactor', 1.35);
const W_TR = ST.configGet('pruner.synergy.trFactor', 1.25);
const W_SR = ST.configGet('pruner.synergy.srDuplicateFactor', 0.25);
const cand = function (id, extra) {
  return Object.assign({
    id: id, species: 'Barraskewda', ability: 'Oblivious', weight: 1,
    moves: ['Aqua Jet'], ivs: { spe: 31 }
  }, extra || {});
};
const mate = function (species, extra) {
  return Object.assign({ species: species, side: 'p2', id: 'p2-' + U.toID(species) }, extra || {});
};

{
  const team = [mate('Pelipper'), mate('Barraskewda')];
  const mon = mate('Barraskewda');
  const pool = [cand('swift', { ability: 'Swift Swim', moves: ['Aqua Jet', 'Hurricane'] }), cand('plain')];
  const moved = synergyPruner._applyTeamSynergyPrior(mon, pool, { oppSide: 'p2', oppTeam: team });
  eq('a Pelipper re-weights the Swift Swim set and nothing else',
    [moved, pool[0].weight, pool[1].weight], [1, W_WEATHER, 1]);
  const settled = pool[0].weight;
  synergyPruner._applyTeamSynergyPrior(mon, pool, { oppSide: 'p2', oppTeam: team });
  eq('...and a repeated call recomputes instead of compounding', pool[0].weight, settled);
  eq('...and an exact identity check on the factor', W_WEATHER, 1.35);
}

{
  const team = [mate('Ferrothorn', { revealedMoves: ['Stealth Rock'] }), mate('Toxapex')];
  const pool = [cand('sr', { species: 'Toxapex', moves: ['Stealth Rock', 'Scald'] }),
    cand('nosr', { species: 'Toxapex', moves: ['Scald'] })];
  synergyPruner._applyTeamSynergyPrior(mate('Toxapex'), pool, { oppSide: 'p2', oppTeam: team });
  eq('a second Stealth Rock carrier is pushed off the move', [pool[0].weight, pool[1].weight], [W_SR, 1]);
  eq('...and the 0.25x is the documented factor', W_SR, 0.25);

  const own = [cand('sr2', { species: 'Ferrothorn', moves: ['Stealth Rock'] })];
  eq('the body that REVEALED it is not penalised by its own move',
    synergyPruner._applyTeamSynergyPrior(team[0], own, { oppSide: 'p2', oppTeam: team }), 0);
  eq('...its weight is untouched', own[0].weight, 1);
}

{
  const team = [mate('Hatterene'), mate('Ursaluna')];
  const pool = [cand('tr', { species: 'Ursaluna', ivs: { spe: 0 } }), cand('fast', { species: 'Ursaluna' })];
  synergyPruner._applyTeamSynergyPrior(mate('Ursaluna'), pool, { oppSide: 'p2', oppTeam: team });
  eq('a Trick Room setter boosts the 0-Spe set', [pool[0].weight, pool[1].weight], [W_TR, 1]);
}

{
  const pool = [cand('swift', { ability: 'Swift Swim' })];
  eq('our own bodies are never re-weighted by THEIR preview',
    synergyPruner._applyTeamSynergyPrior({ species: 'Barraskewda', side: 'p1' }, pool,
      { oppSide: 'p2', oppTeam: [mate('Pelipper')] }), 0);
  eq('...nor is anything when there is no state',
    synergyPruner._applyTeamSynergyPrior(mate('Barraskewda'), pool, null), 0);
}

{
  /* The wiring: prune() applies the prior to the pool it publishes. */
  const m = {
    species: 'Barraskewda', side: 'p2', id: 'p2-barraskewda', level: 100,
    revealedMoves: [], activeStintMoves: [], itemRuledOut: [], boosts: { spe: 0 },
    candidateSets: [cand('swift', { ability: 'Swift Swim', moves: ['Aqua Jet', 'Hurricane'] }), cand('plain')]
  };
  const out = synergyPruner.prune(m, { oppSide: 'p2', oppTeam: [mate('Pelipper'), mate('Barraskewda')],
    formatLocks: {}, field: {} });
  const swift = out.filter(function (s) { return s.id === 'swift'; })[0];
  eq('prune() itself publishes the re-weighted pool', swift && swift.weight, W_WEATHER);
  check('...without dropping a set the preview cannot disprove', out.length === 2, String(out.length));
  check('...and the re-weighting is on the survivor the engine publishes', m.liveSet === swift,
    m.liveSet && m.liveSet.id);
}

/* ================================================================== summary */

console.log('\n=== summary ===');
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failed);
if (failed) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('ALL SCOUT CHECKS PASSED');
// The sandbox the harness builds keeps a live handle, so every suite in this repository exits
// explicitly rather than waiting for the loop to drain (see tests/hud_check.js).
process.exit(0);
