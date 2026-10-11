/* Showdown Tactician — tests/discrete_check.js
 *
 * Run me with:  node tests/discrete_check.js
 *
 * WHAT THIS IS
 *   The regression suite for the two DEDUCTION upgrades in ARCHITECTURE §6.1 / §6.2:
 *
 *     1. the 16-roll discrete damage solver — Pokemon damage is one of 16 integer rolls, not a
 *        continuous interval, so an observed hit can rule out a spread whose RANGE covers the
 *        number printed but whose ROLLS cannot produce it (src/calc_engine.js + src/set_pruner.js);
 *     2. residual-order speed evidence — end-of-turn residual damage/heal resolves in Speed
 *        order, so "my Leftovers ticked before yours" is a relative Speed fact
 *        (src/protocol_parser.js + src/state_manager.js + src/set_pruner.js).
 *
 *   It is split the way the other suites are: the derived half (the roll list, the exact KO count,
 *   one set against one observation) and the wiring half (the same facts through the real
 *   pipeline, where the board is never assembled by hand), plus the two LOAD-TIME config branches
 *   in a sandbox of their own.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about a real browser. The damage numbers are the vendored library's own, so this
 *   suite proves the ENGINE reasons correctly about them, not that the library is right. Two
 *   checks replace `pruner._discreteVerdict` for the duration of one prune() call: those isolate
 *   the PASS PLUMBING (which sets a refinement may drop, and what happens when it would drop every
 *   candidate) rather than the refinement's arithmetic, which §1-§2 cover unstubbed. The
 *   `pruner.residualOrder.trust` branch is read when set_pruner.js LOADS, so it is exercised in a
 *   second sandbox built by `loadWithConfig` — `ST.configMerge` cannot reach it.
 */
'use strict';

const H = require('./harness.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
function close(name, got, want, tol) {
  const ok = typeof got === 'number' && isFinite(got) && Math.abs(got - want) <= tol;
  return check(name, ok, 'got ' + got + ', want ' + want + ' (+-' + tol + ')');
}
function section(title) { console.log('\n=== ' + title + ' ==='); }
function noThrow(fn) {
  try { return { ok: true, value: fn(), error: null }; }
  catch (e) { return { ok: false, value: undefined, error: String((e && e.message) || e) }; }
}
/** Call an entry point, recording a FAILED CHECK when it throws, so the run always reports. */
function call(name, fn) {
  const r = noThrow(fn);
  check(name, r.ok, r.error);
  return r.value;
}

/**
 * A fresh sandbox whose config is patched BETWEEN config.js and the module that captures it at
 * load time. `loadAll` cannot do this: `pruner.residualOrder.trust` is read once, while
 * set_pruner.js executes, so a later `ST.configMerge` has no effect on it. Only the dependency
 * chain up to src/set_pruner.js is loaded, which is all these checks need.
 */
function loadWithConfig(patch) {
  // Through calc_engine.js, not just set_pruner.js: the pruner takes its damage engine by
  // injection, and the test has to be able to BUILD one, so the sandbox needs that file too.
  const core = H.MANIFEST_ORDER.slice(0, H.MANIFEST_ORDER.indexOf('src/calc_engine.js') + 1);
  const sandbox = H.createSandbox();
  core.forEach(function (rel) {
    vm.runInContext(fs.readFileSync(path.join(H.ROOT, rel), 'utf8'), sandbox, { filename: rel });
    if (rel === 'src/config.js') patch(sandbox.ST.CONFIG);
  });
  return sandbox;
}

/* --------------------------------------------------------------- fixtures */

const PASTE = [
  'Hatterene @ Leftovers',
  'Ability: Magic Bounce',
  'EVs: 252 HP / 252 SpA / 4 SpD',
  'IVs: 0 Spe',
  'Quiet Nature',
  '- Trick Room',
  '- Psychic',
  '- Dazzling Gleam',
  '- Healing Wish',
  '',
  'Great Tusk @ Choice Scarf',
  'Ability: Protosynthesis',
  'EVs: 252 Atk / 4 SpD / 252 Spe',
  'Jolly Nature',
  '- Headlong Rush',
  '- Close Combat',
  '- Ice Spinner',
  '- Rapid Spin',
  ''
].join('\n');

/** The real pipeline: state manager + parser + our registered team. */
function pipeline(lines) {
  const state = new ST.BattleStateManager({ debug: false });
  const parser = new ST.ProtocolParser();
  state.attachParser(parser);
  state.setFormat('[Gen 9] National Dex OU');
  const parsed = ST.TeamParser.parsePokepaste(PASTE);
  state.registerMyTeam(parsed.pokemon);
  (lines || []).forEach(function (l) { parser.feed(l); });
  return { state: state, parser: parser, battle: state.state || state };
}

const OPENING = [
  '|switch|p1a: Hatterene|Hatterene, L50, F|100/100',
  '|switch|p2a: Ferrothorn|Ferrothorn, L50, M|100/100',
  '|turn|1'
];

/** A Ferrothorn candidate spread: the attacker whose rolls we are testing. */
const atkSet = function (id, evs, nature) {
  return {
    id: id, species: 'Ferrothorn', role: id, item: 'Leftovers', ability: 'Iron Barbs',
    nature: nature, evs: evs, ivs: U.DEFAULT_IVS,
    moves: ['Power Whip', 'Gyro Ball', 'Stealth Rock', 'Leech Seed'],
    weight: 0.5, tags: ['phys'], isMega: false, isZCrystal: false, itemlessArchetype: false
  };
};
const STRONG = atkSet('phys-252', { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 }, 'Adamant');
const WEAK = atkSet('phys-0', { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 }, 'Bold');
/* The same spread under another id: identical stats, so any observation treats the two alike.
 * That is what makes the "which pass dropped this set" checks below deterministic. */
const STRONG_TWIN = atkSet('phys-252-twin', { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 }, 'Adamant');

/* Our ruler: the Hatterene the paste registers, so an observation's defender resolves. */
const bootFx = pipeline(OPENING);
const myHatterene = bootFx.battle.myTeam.find(function (m) { return m && U.toID(m.species) === 'hatterene'; });
check('fixture sanity: our registered Hatterene is on the board',
  !!myHatterene, JSON.stringify(bootFx.battle.myTeam.map(function (m) { return m && m.species; })));

/* ============================================================ 1. the 16 rolls */

section("1. the damage engine exposes the library's own 16 rolls");

const engine = call('DamageEngine is constructible', function () { return new ST.DamageEngine({ gen: 9 }); });
const IVS = U.DEFAULT_IVS;
const tusk = {
  species: 'Great Tusk', item: 'Choice Scarf', ability: 'Protosynthesis', nature: 'Jolly',
  evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 }, ivs: IVS,
  boosts: {}, hpPercent: 100, level: 100
};
const corv = {
  species: 'Corviknight', item: 'Leftovers', ability: 'Pressure', nature: 'Impish',
  evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 }, ivs: IVS,
  boosts: {}, hpPercent: 100, level: 100
};

const spinner = call('an ordinary move calculates', function () {
  return engine.calculateDamage(tusk, corv, 'Ice Spinner', null);
});
check('the result carries a roll list', !!spinner && Array.isArray(spinner.rolls), spinner && JSON.stringify(spinner.rolls));
check('rollCount agrees with the array', !!spinner && spinner.rollCount === spinner.rolls.length, spinner && String(spinner.rollCount));
check('every roll is an integer', !!spinner && spinner.rolls.every(function (v) {
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
}), spinner && JSON.stringify(spinner.rolls));
check('the rolls are sorted ascending', !!spinner && spinner.rolls.every(function (v, i, a) {
  return i === 0 || a[i - 1] <= v;
}), spinner && JSON.stringify(spinner.rolls));
check('the roll list brackets the reported range',
  !!spinner && spinner.rolls[0] === spinner.minDmg && spinner.rolls[spinner.rolls.length - 1] === spinner.maxDmg,
  spinner && JSON.stringify([spinner.rolls[0], spinner.minDmg, spinner.rolls[spinner.rolls.length - 1], spinner.maxDmg]));
close('rollPercent inverts a roll back to the printed percentage',
  spinner.rollPercent(spinner.rolls[0]), U.round1(spinner.rolls[0] / spinner.defenderMaxHP * 100), 1e-9);
eq('rollPercent of a non-number is null, not NaN', spinner.rollPercent('nope'), null);

/* A fixed-damage move has no roll list, and a multi-hit move has one PER HIT: neither may be
 * presented as a flat 16-roll list, because the discrete test would then be nonsense. */
const fixed = call('a fixed-damage move calculates', function () {
  return engine.calculateDamage(tusk, corv, 'Seismic Toss', null);
});
eq('a fixed-damage move exposes no roll list', fixed && fixed.rolls, null);
eq('...and no exact KO chance either', fixed && fixed.koChanceExact, null);
const multi = call('a multi-hit move calculates', function () {
  return engine.calculateDamage(tusk, corv, 'Double Iron Bash', null);
});
eq('a multi-hit move exposes no single roll list', multi && multi.rolls, null);
eq('...and no exact KO chance either', multi && multi.koChanceExact, null);

/* A defender that is neither guaranteed nor immune: some rolls kill, some do not. */
const partial = call('a partially-KOing hit calculates', function () {
  return engine.calculateDamage(tusk, Object.assign({}, corv, { hpPercent: 17 }), 'Ice Spinner', null);
});
let lethalCount = 0;
if (partial && Array.isArray(partial.rolls)) {
  for (let i = 0; i < partial.rolls.length; i++) if (partial.rolls[i] >= partial.defenderCurHP) lethalCount++;
}
check('the fixture is a genuine partial KO (some rolls kill, some do not)',
  !!partial && lethalCount > 0 && lethalCount < partial.rolls.length,
  partial && JSON.stringify({ lethal: lethalCount, rolls: partial.rolls.length, hp: partial.defenderCurHP }));
/* The share is exact and UNROUNDED on purpose: 7 of 16 rolls is 43.75%, and rounding it to 43.8
 * would break the discreteness the number is there to expose (see ARCHITECTURE §6.1). */
close('koChancePct is the exact share of rolls that reach the HP',
  partial.koChancePct, lethalCount / partial.rolls.length * 100, 1e-9);
eq('koChanceExact repeats the same number', partial.koChanceExact, partial.koChancePct);
check('the exact count is a DISCRETE fraction of the roll list, not a continuous span',
  !!partial && Math.abs(partial.koChanceExact / 100 * partial.rolls.length -
    Math.round(partial.koChanceExact / 100 * partial.rolls.length)) < 1e-9,
  partial && String(partial.koChanceExact));
check('and it is strictly inside (0, 100), which the span estimate only approximates',
  !!partial && partial.koChanceExact > 0 && partial.koChanceExact < 100, partial && String(partial.koChanceExact));
eq('a guaranteed KO reports 100', call('a guaranteed KO calculates', function () {
  return engine.calculateDamage(tusk, Object.assign({}, corv, { hpPercent: 5 }), 'Ice Spinner', null);
}).koChancePct, 100);
eq('an immunity reports 0', call('an immune hit calculates', function () {
  return engine.calculateDamage(tusk, corv, 'Headlong Rush', null);
}).koChancePct, 0);

/* ==================================================== 2. discrete elimination */

section('2. one set against one observed hit');

const pruner = new ST.ArchetypePruner({ damage: new ST.DamageEngine({ gen: 9 }) });
const dmgFixture = pipeline(OPENING.concat(['|move|p2a: Ferrothorn|Power Whip|p1a: Hatterene']));
const pwOpts = { attackerIsP1: false };
const strongRes = call('the invested spread calculates', function () {
  return engine.calculateDamage(STRONG, myHatterene, 'Power Whip', dmgFixture.battle.field, pwOpts);
});
const weakRes = call('the uninvested spread calculates', function () {
  return engine.calculateDamage(WEAK, myHatterene, 'Power Whip', dmgFixture.battle.field, pwOpts);
});
const topRoll = (strongRes && strongRes.rolls) ? strongRes.rolls[strongRes.rolls.length - 1] : 0;
const topPercent = strongRes ? strongRes.rollPercent(topRoll) : 0;
const weakTop = (weakRes && weakRes.rolls) ? weakRes.rolls[weakRes.rolls.length - 1] : 0;
/* A percentage both spreads' RANGES cover, so a range test cannot be what decides them: this is
 * the number the "which pass dropped it" checks below need. */
const midPercent = (strongRes && typeof strongRes.avgPercent === 'number') ? strongRes.avgPercent : 0;
check('fixture sanity: the invested spread really rolls higher than the uninvested one',
  !!(strongRes && weakRes) && !strongRes.failed && !weakRes.failed && topRoll > weakTop + 5,
  JSON.stringify({ strongTop: topRoll, weakTop: weakTop, percent: topPercent }));
check('fixture sanity: both spreads expose their own rolls, and a shared-range percentage exists',
  topRoll > 0 && weakTop > 0 && midPercent > 0 && midPercent < topPercent,
  JSON.stringify({ strong: strongRes && strongRes.rollCount, weak: weakRes && weakRes.rollCount, mid: midPercent }));

const obsFor = function (percent, sig, move) {
  return {
    turn: 1, moveName: move || 'Power Whip', moveId: U.toID(move || 'Power Whip'),
    damagePercent: percent, hpBefore: 100, hpAfter: 100 - percent, crit: false,
    attackerIsP1: false, defenderId: 'hatterene', defenderBoosts: {}, defenderStatus: '',
    weather: '', terrain: '', sig: sig
  };
};
const topObs = obsFor(topPercent, 'discrete-top');

const verdictStrong = call('the discrete test runs for the invested spread',
  function () { return pruner._discreteVerdict(STRONG, topObs, myHatterene, dmgFixture.battle); });
eq('the spread that can produce the number is not eliminated', verdictStrong, null);
const verdictWeak = call('the discrete test runs for the uninvested spread',
  function () { return pruner._discreteVerdict(WEAK, topObs, myHatterene, dmgFixture.battle); });
check('the spread that cannot produce the number is eliminated',
  typeof verdictWeak === 'string' && verdictWeak.length > 0, JSON.stringify(verdictWeak));
check('...and the reason names the move and the exact-roll elimination',
  typeof verdictWeak === 'string' && /Power Whip/.test(verdictWeak) && /exact-roll elimination/i.test(verdictWeak),
  JSON.stringify(verdictWeak));
check('...and quotes the roll range it tried',
  typeof verdictWeak === 'string' && /\d/.test(verdictWeak.replace(/Power Whip/g, '')), JSON.stringify(verdictWeak));

/* A move with no roll list must make the discrete test silent, never "eliminating". */
eq('a fixed-damage move is skipped by the discrete test',
  call('the discrete test tolerates a fixed-damage move', function () {
    return pruner._discreteVerdict(STRONG, obsFor(topPercent, 'discrete-fixed', 'Seismic Toss'), myHatterene, dmgFixture.battle);
  }), null);

/* A pool built by hand, so the given sets are the whole candidate space. */
function attackerWith(observation, sets) {
  const fx = pipeline(OPENING.concat(['|move|p2a: Ferrothorn|Power Whip|p1a: Hatterene']));
  const mon = fx.battle.oppTeam.find(function (m) { return m && U.toID(m.species) === 'ferrothorn'; });
  mon.candidateSets = (sets || [U.deepClone(STRONG), U.deepClone(WEAK)]).map(function (s) { return U.deepClone(s); });
  mon.damageDealt = observation ? [Object.assign({}, observation)] : [];
  mon.prunedReasons = [];
  mon.damageVerdictCache = null;
  mon.evPinned = false;
  mon.pinnedEvs = null;
  return mon;
}

/* The range test alone settles this observation; nothing may undo it. */
pruner.reset();
const rangeMon = attackerWith(topObs);
const rangePool = call('prune() runs on the observed hit', function () { return pruner.prune(rangeMon, dmgFixture.battle); });
eq('the pooled result keeps exactly the spread that can produce the hit',
  (rangePool || []).map(function (s) { return s.id; }), ['phys-252']);

/* Pass 2 in isolation: an observation BOTH spreads' ranges cover, with the refinement replaced
 * so exactly one twin is refused. This proves the pass runs over the range survivors and that its
 * verdict reaches the published pool — independently of the arithmetic §1-2 already covered. */
const realDiscrete = pruner._discreteVerdict;
pruner._discreteVerdict = function (set) {
  return set && set.id === 'phys-252-twin' ? 'Took ' + midPercent + '% from Power Whip: exact-roll elimination (test)' : null;
};
pruner.reset();
const pass2Mon = attackerWith(obsFor(midPercent, 'pass2'), [STRONG, STRONG_TWIN]);
const pass2Pool = call('pass 2 runs over the range survivors', function () { return pruner.prune(pass2Mon, dmgFixture.battle); });
eq('only the set the refinement refused is dropped', (pass2Mon.candidateSets || []).map(function (s) { return s.id; }), ['phys-252']);
eq('...and the returned pool agrees', (pass2Pool || []).map(function (s) { return s.id; }), ['phys-252']);
check('...and the reason is recorded on the mon',
  pruner._reasons(pass2Mon).some(function (r) { return /exact-roll elimination \(test\)/.test(r); }),
  JSON.stringify(pruner._reasons(pass2Mon).slice(-3)));

/* When the refinement would empty the pool, the PASS is abandoned: the range verdict stands and
 * the pool is never emptied. This is the property that keeps the feature safe. */
pruner._discreteVerdict = function () { return 'exact-roll elimination (would empty the pool)'; };
pruner.reset();
const guardMon = attackerWith(topObs);
const guardPool = call('prune() survives a refinement that drops everything',
  function () { return pruner.prune(guardMon, dmgFixture.battle); });
check('the range verdict still stands (the range-dropped spread stays gone)',
  (guardPool || []).map(function (s) { return s.id; }).indexOf('phys-0') === -1,
  JSON.stringify((guardPool || []).map(function (s) { return s.id; })));
check('...the pool is NOT emptied', (guardPool || []).length > 0,
  JSON.stringify((guardPool || []).map(function (s) { return s.id; })));
check('...and the mon says the exact-roll evidence was ignored',
  pruner._reasons(guardMon).some(function (r) { return /exact-roll evidence ignored/i.test(r); }),
  JSON.stringify(pruner._reasons(guardMon).slice(-3)));
pruner._discreteVerdict = realDiscrete;
check('the refinement is restored', pruner._discreteVerdict === realDiscrete, 'patched');
pruner.reset();

/* The same guard for the RANGE half, driven for real with an impossible number. */
const impossibleMon = attackerWith(obsFor(999, 'range-impossible'));
const impossiblePool = call('prune() survives an impossible observation',
  function () { return pruner.prune(impossibleMon, dmgFixture.battle); });
eq('an impossible number discards the observation, not the database', (impossiblePool || []).length, 2);
check('...and the range guard says so',
  pruner._reasons(impossibleMon).some(function (r) { return /evidence ignored/i.test(r); }),
  JSON.stringify(pruner._reasons(impossibleMon).slice(-3)));
pruner.reset();

/* ============================================================= 3. EV pinning */

section('3. a collapsed pool pins the exact EV spread');

const twinMon = attackerWith(null, [STRONG, STRONG_TWIN]);
twinMon.damageDealt = [obsFor(midPercent, 'pin-a'), obsFor(midPercent, 'pin-b')];
const twinPool = call('prune() runs on an identical-EV pool', function () { return pruner.prune(twinMon, dmgFixture.battle); });
eq('an identical-EV pool is not narrowed (the two spreads are indistinguishable)',
  (twinPool || []).map(function (s) { return s.id; }).sort(), ['phys-252', 'phys-252-twin']);
eq('two agreeing observations PIN the spread', twinMon.evPinned, true);
eq("...and the pinned vector is the survivors' own EV vector", twinMon.pinnedEvs, STRONG.evs);
check('...and the reason names it',
  pruner._reasons(twinMon).some(function (r) { return /spread pinned/i.test(r) && /252 HP/.test(r); }),
  JSON.stringify(pruner._reasons(twinMon).slice(-3)));

/* One observation is never enough: a single hit can fit several spreads by coincidence. */
const oneMon = attackerWith(null, [STRONG, STRONG_TWIN]);
oneMon.damageDealt = [obsFor(midPercent, 'pin-single')];
call('prune() runs on a single-observation pool', function () { return pruner.prune(oneMon, dmgFixture.battle); });
eq('a single observation does NOT pin', oneMon.evPinned, false);
eq('...and leaves no pinned vector behind', oneMon.pinnedEvs, null);
eq('the requirement is two observations (config)', ST.configGet('pruner.discreteRolls.requireObservations', 2), 2);

/* Two different EV vectors can never share a pin. */
const mixedMon = attackerWith(null);
mixedMon.damageDealt = [obsFor(midPercent, 'pin-mixed-a'), obsFor(midPercent, 'pin-mixed-b')];
const mixedPin = call('_publishEvPin runs on a mixed pool', function () {
  return pruner._publishEvPin(mixedMon, [U.deepClone(STRONG), U.deepClone(WEAK)]);
});
eq('a pool with two EV vectors is never pinned', mixedPin, null);
eq('...and the flag stays false', mixedMon.evPinned, false);

/* A pool that collapses to ONE set is still not "pinned" on a single observation. */
pruner.reset();
const collapseMon = attackerWith(topObs);
const collapsePool = call('prune() runs on a collapsing pool', function () { return pruner.prune(collapseMon, dmgFixture.battle); });
eq('the collapsing observation leaves one set', (collapsePool || []).map(function (s) { return s.id; }), ['phys-252']);
eq('one surviving set with one observation is still not "pinned"', collapseMon.evPinned, false);

/* ==================================================== 4. residual-order evidence */

section('4. residual order is read off the real protocol stream');

const residualFx = pipeline(OPENING);
const seenEvents = [];
const unsub = residualFx.parser.subscribe(function (evt) {
  if (evt && evt.type === 'residualorder') seenEvents.push(evt);
});
/* The synthesized event only reaches SUBSCRIBERS: feed() returns the primary event, so the pair
 * has to be fed with the subscription already in place. */
residualFx.parser.feed('|-heal|p1a: Hatterene|100/100|[from] item: Leftovers');
residualFx.parser.feed('|-heal|p2a: Ferrothorn|100/100|[from] item: Leftovers');
if (typeof unsub === 'function') unsub();

check('a residual pair for opposite sides emits exactly one residualorder event', seenEvents.length === 1,
  JSON.stringify(seenEvents.map(function (e) { return [e.side, e.otherSide, e.turn]; })));
const relEvent = seenEvents[0];
check('...naming the body that resolved first and the one it beat',
  !!relEvent && relEvent.side === 'p1' && U.toID(relEvent.species) === 'hatterene' &&
  relEvent.otherSide === 'p2' && U.toID(relEvent.otherSpecies) === 'ferrothorn',
  JSON.stringify(relEvent));
eq('...and flagging the order direction', relEvent && relEvent.before, true);
check('...with a human reason', !!relEvent && /residual resolved first/i.test(String(relEvent.reason)),
  JSON.stringify(relEvent && relEvent.reason));

const residualState = residualFx.battle;
const fasterBody = residualState.myTeam.find(function (m) { return m && U.toID(m.species) === 'hatterene'; });
const slowerBody = residualState.oppTeam.find(function (m) { return m && U.toID(m.species) === 'ferrothorn'; });
check('the state manager recorded the relation on the faster body',
  !!fasterBody && Array.isArray(fasterBody.residualOrderBefore) && fasterBody.residualOrderBefore.length === 1 &&
  U.toID(fasterBody.residualOrderBefore[0].species) === 'ferrothorn',
  JSON.stringify(fasterBody && fasterBody.residualOrderBefore));
check('...and on the slower body, in the other direction',
  !!slowerBody && Array.isArray(slowerBody.residualOrderAfter) && slowerBody.residualOrderAfter.length === 1 &&
  U.toID(slowerBody.residualOrderAfter[0].species) === 'hatterene',
  JSON.stringify(slowerBody && slowerBody.residualOrderAfter));

/* Negative cases, on a parser of their own so nothing above is disturbed. */
const bareParser = new ST.ProtocolParser();
const bareEvents = [];
bareParser.subscribe(function (evt) { if (evt && evt.type === 'residualorder') bareEvents.push(evt); });
bareParser.feed('|switch|p1a: Hatterene|Hatterene, L50, F|100/100');
bareParser.feed('|switch|p2a: Ferrothorn|Ferrothorn, L50, M|100/100');
bareParser.feed('|turn|1');
bareParser.feed('|-damage|p1a: Hatterene|88/100|[from] item: Leftovers');
bareParser.feed('|-damage|p1a: Hatterene|80/100|[from] brn');
eq('two residual lines for the SAME side are not an order', bareEvents.length, 0);
bareParser.feed('|move|p2a: Ferrothorn|Power Whip|p1a: Hatterene');
bareParser.feed('|-damage|p2a: Ferrothorn|90/100|[from] brn');
eq('a move between residual lines breaks the pairing', bareEvents.length, 0);
/* A new turn starts a new residual block, and each direction is reported at most once in it. */
bareParser.feed('|turn|3');
bareParser.feed('|-heal|p1a: Hatterene|100/100|[from] item: Leftovers');
bareParser.feed('|-heal|p2a: Ferrothorn|100/100|[from] item: Leftovers');
bareParser.feed('|-heal|p2a: Ferrothorn|100/100|[from] item: Leftovers');
eq('each direction is reported at most once per turn', bareEvents.length, 1);
/* A move's own damage carries a `move:` clause and is never residual evidence. */
const moveDmgParser = new ST.ProtocolParser();
const moveDmgEvents = [];
moveDmgParser.subscribe(function (evt) { if (evt && evt.type === 'residualorder') moveDmgEvents.push(evt); });
moveDmgParser.feed('|turn|1');
moveDmgParser.feed('|-damage|p1a: X|90/100|[from] move: Power Whip [of] p2a: Y');
moveDmgParser.feed('|-damage|p2a: Y|90/100|[from] move: Psychic [of] p1a: X');
eq("a move's own damage is not residual evidence", moveDmgEvents.length, 0);
/* A line with no `[from]` clause at all is not attributable, so it is not evidence either. */
const noClauseParser = new ST.ProtocolParser();
const noClauseEvents = [];
noClauseParser.subscribe(function (evt) { if (evt && evt.type === 'residualorder') noClauseEvents.push(evt); });
noClauseParser.feed('|turn|1');
noClauseParser.feed('|-damage|p1a: X|90/100');
noClauseParser.feed('|-damage|p2a: Y|90/100');
eq('a residual line with no clause is not attributable', noClauseEvents.length, 0);

/* ---- the conversion, driven directly so the bracket is deterministic ---- */

const slowSet = function () {
  return {
    id: 'slow', species: 'Ferrothorn', role: 'slow', item: 'Leftovers', ability: 'Iron Barbs',
    nature: 'Sassy', evs: { hp: 252, atk: 4, def: 0, spa: 0, spd: 252, spe: 0 }, ivs: U.DEFAULT_IVS,
    moves: ['Power Whip', 'Gyro Ball', 'Stealth Rock', 'Leech Seed'], weight: 0.5,
    tags: [], isMega: false, isZCrystal: false, itemlessArchetype: false
  };
};
const fastSet = function () {
  const s = slowSet();
  s.id = 'fast';
  s.role = 'fast';
  s.nature = 'Jolly';
  s.evs = { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 };
  return s;
};
const slowSpeed = U.maxSpeedForSet(slowSet());
const fastSpeed = U.maxSpeedForSet(fastSet());
check('fixture sanity: the two Ferrothorn spreads really differ in Speed',
  slowSpeed > 0 && fastSpeed > slowSpeed + 20, JSON.stringify({ slow: slowSpeed, fast: fastSpeed }));

/** A body on the other side whose believed Speed we control, and which sits BETWEEN the two. */
const midBody = function () {
  return {
    id: 'slowking', species: 'Slowking', side: 'p2', slot: 'p2a',
    candidateSets: [{
      id: 'theirs', species: 'Slowking', role: 'theirs', item: 'Leftovers', ability: 'Regenerator',
      nature: 'Serious', evs: { hp: 252, atk: 0, def: 0, spa: 0, spd: 0, spe: 60 }, ivs: U.DEFAULT_IVS,
      moves: ['Scald', 'Slack Off', 'Thunder Wave', 'Future Sight'], weight: 0.5,
      tags: [], isMega: false, isZCrystal: false, itemlessArchetype: false
    }],
    prunedReasons: [], liveSet: null, speedFloor: 0, speedCeiling: 1012,
    residualOrderBefore: [], residualOrderAfter: []
  };
};
/** A body faster than every Ferrothorn spread, so any bracket it sets is unsatisfiable. */
const fastBody = function () {
  const b = midBody();
  b.id = 'corviknight';
  b.species = 'Corviknight';
  b.liveSet = {
    id: 'theirs-fast', species: 'Corviknight', role: 'theirs', item: 'Choice Scarf', ability: 'Pressure',
    nature: 'Jolly', evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 }, ivs: U.DEFAULT_IVS,
    moves: ['Brave Bird'], weight: 1, tags: [], isMega: false, isZCrystal: false, itemlessArchetype: false
  };
  return b;
};
const residualBody = function (sets) {
  return {
    id: 'ferrothorn', species: 'Ferrothorn', side: 'p1', slot: 'p1a',
    candidateSets: sets, prunedReasons: [], speedEvidence: [],
    liveSet: null, speedFloor: 0, speedCeiling: 1012,
    residualOrderBefore: [], residualOrderAfter: []
  };
};
const bracketState = function (opp) { return { myTeam: [], oppTeam: [opp], field: {}, formatLocks: {}, mySide: 'p1' }; };

const theirs = midBody();
const believed = U.maxSpeedForSet(theirs.candidateSets[0]);
check('fixture sanity: the counterpart\'s believed Speed sits between the two spreads',
  believed > slowSpeed && believed < fastSpeed,
  JSON.stringify({ believed: believed, slow: slowSpeed, fast: fastSpeed }));

const beatMon = residualBody([slowSet(), fastSet()]);
beatMon.residualOrderBefore = [{ id: 'slowking', species: 'Slowking', turn: 3 }];
const beatRes = call('applyResidualOrder runs', function () {
  return pruner.applyResidualOrder(beatMon, bracketState(theirs));
});
close('beating a body sets the floor to its believed Speed + 1', beatRes.floor, believed + 1, 1e-9);
check('...which eliminates the candidate that cannot reach it',
  beatRes.pruned === true && beatRes.dropped === 1, JSON.stringify({ dropped: beatRes.dropped, pool: beatRes.survivors.length }));
check('...and the published pool only holds sets that can',
  beatRes.survivors.every(function (s) { return U.maxSpeedForSet(s) >= beatRes.floor; }),
  JSON.stringify(beatRes.survivors.map(function (s) { return [s.id, U.maxSpeedForSet(s)]; })));
eq('...with the pool published on the mon', (beatMon.candidateSets || []).map(function (s) { return s.id; }), ['fast']);
check('...and an evidence line naming the bracket',
  (beatMon.speedEvidence || []).some(function (e) { return /Residual order/.test(e); }),
  JSON.stringify(beatMon.speedEvidence));

/* The other direction: losing to a body caps the Speed instead. The pruner deliberately captures
 * each pool ONCE per body key and publishes every later narrowing back into it, so each bracket
 * case below starts from its own pristine pool rather than the one the case above left behind. */
pruner.reset();
const lostMon = residualBody([slowSet(), fastSet()]);
lostMon.residualOrderAfter = [{ id: 'slowking', species: 'Slowking', turn: 3 }];
const lostRes = call('applyResidualOrder runs in the other direction', function () {
  return pruner.applyResidualOrder(lostMon, bracketState(theirs));
});
close('losing to a body sets the ceiling to its believed Speed - 1', lostRes.ceiling, believed - 1, 1e-9);
eq('...and eliminates the candidate above it', (lostRes.survivors || []).map(function (s) { return s.id; }), ['slow']);
check('...leaving only sets inside the bracket',
  (lostRes.survivors || []).every(function (s) { return U.maxSpeedForSet(s) <= lostRes.ceiling; }),
  JSON.stringify((lostRes.survivors || []).map(function (s) { return [s.id, U.maxSpeedForSet(s)]; })));

/* An unsatisfiable bracket leaves the pool exactly as it was, and says so. */
pruner.reset();
const huge = fastBody();
check('fixture sanity: the impossible counterpart really is faster than every spread',
  U.maxSpeedForSet(huge.liveSet) > fastSpeed, String(U.maxSpeedForSet(huge.liveSet)));
const doomedMon = residualBody([slowSet(), fastSet()]);
doomedMon.residualOrderBefore = [{ id: 'corviknight', species: 'Corviknight', turn: 3 }];
const doomedRes = call('applyResidualOrder survives an unsatisfiable bracket', function () {
  return pruner.applyResidualOrder(doomedMon, bracketState(huge));
});
check('the pool is not emptied by an impossible bracket',
  doomedRes.pruned === false && doomedRes.dropped === 0 && doomedRes.survivors.length === 2,
  JSON.stringify({ dropped: doomedRes.dropped, survivors: doomedRes.survivors.length, floor: doomedRes.floor }));
check('...and it says the bracket was ignored',
  pruner._reasons(doomedMon).some(function (r) { return /would leave no candidate; ignored/i.test(r); }),
  JSON.stringify(pruner._reasons(doomedMon).slice(-2)));

/* No relations at all is a no-op, not a crash. */
const quietMon = residualBody([slowSet()]);
const quietRes = call('applyResidualOrder with nothing recorded is a no-op', function () {
  return pruner.applyResidualOrder(quietMon, bracketState(theirs));
});
eq('...pruning nothing', quietRes.pruned, false);
eq('...and dropping nothing', quietRes.dropped, 0);

/* `handleResidualOrderEvent` resolves both bodies and converts each of them. */
const handlerMon = residualBody([slowSet(), fastSet()]);
handlerMon.residualOrderBefore = [{ id: 'slowking', species: 'Slowking', turn: 3 }];
const handlerState = { myTeam: [handlerMon], oppTeam: [theirs], field: {}, formatLocks: {}, mySide: 'p1' };
const handlerRes = call('handleResidualOrderEvent runs', function () {
  return pruner.handleResidualOrderEvent({
    type: 'residualorder', side: 'p1', slot: 'p1a', species: 'Ferrothorn',
    otherSide: 'p2', otherSlot: 'p2a', otherSpecies: 'Slowking', turn: 3, before: true,
    reason: 'residual resolved first'
  }, handlerState);
});
close("the handler reports the faster body's floor", handlerRes.floor, believed + 1, 1e-9);
eq('...and the drop it made', handlerRes.dropped, 1);
const unresolvedRes = call('an unresolvable event is a no-op', function () {
  return pruner.handleResidualOrderEvent({ type: 'residualorder', side: 'p1', slot: 'p1z', species: 'Nobody' }, handlerState);
});
eq('...pruning nothing', unresolvedRes.pruned, false);

/* ---- the load-time trust switch, in a sandbox of its own ---- */

const lowTrust = loadWithConfig(function (CONFIG) { CONFIG.pruner.residualOrder.trust = 0; });
const lowPruner = new lowTrust.ST.ArchetypePruner({ damage: new lowTrust.ST.DamageEngine({ gen: 9 }) });
const lowMon = residualBody([slowSet(), fastSet()]);
lowMon.residualOrderBefore = [{ id: 'slowking', species: 'Slowking', turn: 3 }];
const lowRes = call('a trust below half still runs', function () {
  return lowPruner.applyResidualOrder(lowMon, bracketState(theirs));
});
eq('trust: 0 records the order but prunes nothing', lowRes.pruned, false);
eq('...and drops nothing', lowRes.dropped, 0);
eq('...leaving the pool untouched', lowRes.survivors.length, 2);
check('...and says the order was too weak to convert',
  (lowMon.speedEvidence || []).some(function (e) { return /trust too low to convert/i.test(e); }),
  JSON.stringify(lowMon.speedEvidence));

/* The same fixture in the default sandbox does prune — so the difference IS the trust switch. */
const onPruner = new ST.ArchetypePruner({ damage: new ST.DamageEngine({ gen: 9 }) });
const onMon = residualBody([slowSet(), fastSet()]);
onMon.residualOrderBefore = [{ id: 'slowking', species: 'Slowking', turn: 3 }];
const onRes = call('the default sandbox converts the same order', function () {
  return onPruner.applyResidualOrder(onMon, bracketState(theirs));
});
eq('the two sandboxes disagree only because of trust', onRes.pruned, true);
check('the default config still trusts the order (so the checks above were meaningful)',
  ST.configGet('pruner.residualOrder.trust', 1) >= 0.5, String(ST.configGet('pruner.residualOrder.trust', 1)));

/* ================================================================== summary */

console.log('\n=== summary ===');
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failed);
if (failed) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('ALL DISCRETE-ROLL CHECKS PASSED');
// The sandbox the harness builds keeps a live handle, so every suite in this repository exits
// explicitly rather than waiting for the loop to drain (see tests/hud_check.js).
process.exit(0);
