/* Showdown Tactician — tests/entropy_check.js
 *
 * WHY THIS EXISTS
 *   src/information_gain.js turns "scouting is valuable" into two measurable things: the Shannon
 *   entropy of the opponent's surviving candidate pool, and the bits a turn would burn once their
 *   answer rules sets out. Both are arithmetic, so both are pinned EXACTLY here — a wrong
 *   normalisation or a log base that is not 2 would still be "monotone" and would still look
 *   plausible on the HUD, which is why the pins are hand-computed constants and not orderings.
 *
 *   The three refusal paths are pinned for the same reason: a tier that pays a bounty for scouting
 *   a body it has already fully read, or for scouting a body that is about to faint, is worse than
 *   no tier at all. Each has a named `reason`, and each is asserted by name.
 *
 * Run me with:  node tests/entropy_check.js
 */
'use strict';

const H = require('./harness.js');
// content.js auto-boots on the harness's stubbed hostname and starts a heartbeat; stub the timer
// exactly as the other suites do so this process can exit.
const S = H.loadAll({
  setInterval: function () { return 0; },
  clearInterval: function () { }
});
const ST = S.ST;

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); return true; }
  failures.push(name + (detail === undefined ? '' : '  ->  ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  ->  ' + detail));
  return false;
}
function close(name, got, want, eps) {
  const tol = eps === undefined ? 1e-12 : eps;
  const ok = typeof got === 'number' && isFinite(got) && Math.abs(got - want) <= tol;
  return check(name, ok, ok ? undefined : 'got ' + got + ', want ' + want + ' +/- ' + tol);
}
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  return check(name, ok, ok ? undefined : 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }

/* ------------------------------------------------------------------ fixtures */

const LOG2_3 = 1.584962500721156;      // log2(3)
const LOG2_6 = 2.584962500721156;      // log2(6)
const BINARY_3_1 = 0.8112781244591328; // H(3/4, 1/4)

const IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
const EVS = { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 };
const ME_MOVES = ['Make It Rain', 'Shadow Ball', 'Nasty Plot', 'Recover'];
const THEIR_MOVES = ['Headlong Rush', 'Stealth Rock', 'Rapid Spin', 'Ice Spinner'];

function body(species, extra) {
  return Object.assign({
    id: species.toLowerCase().replace(/[^a-z0-9]+/g, ''), species: species, side: 'p2',
    revealed: true, level: 100, hp: 100, maxhp: 100, hpPercent: 100, fainted: false, status: '',
    boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
    volatiles: {}, revealedMoves: [], activeStintMoves: [], movePP: {},
    possibleAbilities: [], speedFloor: 0, speedCeiling: 1012,
    candidateSets: [], liveSet: null, isActive: false, item: '', ability: '', setMoves: [],
    evs: EVS, ivs: IVS, nature: 'Timid'
  }, extra || {});
}
function setOf(id, moves, weight) {
  return {
    id: id, species: 'Great Tusk', item: '', weight: weight === undefined ? 1 : weight,
    moves: moves || [], evs: {}, ivs: {}, tags: []
  };
}

const POOL_PRUNE = [                       // two of four can produce the answer
  setOf('s1', ['Headlong Rush', 'Close Combat']),
  setOf('s2', ['Headlong Rush', 'Stealth Rock']),
  setOf('s3', ['Stealth Rock', 'Rapid Spin']),
  setOf('s4', ['Rapid Spin', 'Ice Spinner'])
];
const POOL_ONE = [                         // only one can
  setOf('s1', ['Headlong Rush']),
  setOf('s2', ['Stealth Rock']),
  setOf('s3', ['Rapid Spin']),
  setOf('s4', ['Ice Spinner'])
];
const POOL_THREE = [
  setOf('s1', ['Headlong Rush']),
  setOf('s2', ['Headlong Rush', 'Stealth Rock']),
  setOf('s3', ['Headlong Rush', 'Rapid Spin']),
  setOf('s4', ['Ice Spinner'])
];
const POOL_NOCUT = [                       // every candidate can produce it
  setOf('s1', ['Headlong Rush']),
  setOf('s2', ['Headlong Rush', 'Stealth Rock']),
  setOf('s3', ['Headlong Rush']),
  setOf('s4', ['Headlong Rush'])
];
const POOL_KNOWN = [                       // fully read: nothing an answer could separate
  setOf('s1', ['Headlong Rush', 'Stealth Rock']),
  setOf('s2', ['Headlong Rush', 'Stealth Rock']),
  setOf('s3', ['Headlong Rush', 'Stealth Rock']),
  setOf('s4', ['Headlong Rush', 'Stealth Rock'])
];
const POOL_UNKNOWN = [                     // an unknown set is never disproved
  setOf('s1', ['Headlong Rush']),
  setOf('s2', ['Stealth Rock']),
  setOf('s3', ['Rapid Spin']),
  setOf('s4', [])
];
const POOL_WEIGHTED = [                    // the heavier set is the one that survives
  setOf('s1', ['Stealth Rock'], 3),
  setOf('s2', ['Headlong Rush'], 1)
];

function stateOf(pool, oppExtra) {
  const me = body('Gholdengo', { side: 'p1', nature: 'Timid', isActive: true, setMoves: ME_MOVES });
  const them = body('Great Tusk', Object.assign({ isActive: true, setMoves: THEIR_MOVES, candidateSets: pool }, oppExtra || {}));
  return {
    turn: 12, mySide: 'p1', oppSide: 'p2', formatSupported: true,
    myTeam: [me], oppTeam: [them], active: { my: me, opp: them }, bench: { my: [], opp: [] },
    field: { turn: 12, trickRoom: false, weather: '', terrain: '', hazards: { p1: {}, p2: {} }, screens: {}, tailwind: {}, gravity: false }
  };
}
const ACTION = { kind: 'protect', name: 'Protect', moveId: 'protect' };

function engineWith(opts) {
  const options = Object.assign({ damage: new ST.DamageEngine({ gen: 9 }) }, opts || {});
  return new ST.InformationGain(options);
}

/* =============================================================== 1. the arithmetic */

section('1. Shannon entropy, normalised and in BITS');
{
  const ig = engineWith();
  const uniform4 = [1, 1, 1, 1];
  check('a uniform 4-set pool is exactly 2 bits', ig.entropy(uniform4) === 2, String(ig.entropy(uniform4)));
  check('a single set is 0 bits', ig.entropy([1]) === 0 && ig.entropy([0.4]) === 0, String(ig.entropy([1])));
  close('a uniform 6-set pool is log2(6)', ig.entropy([1, 1, 1, 1, 1, 1]), LOG2_6);
  close('the weights need not sum to 1 (they are normalised)', ig.entropy([2, 2, 2, 2]), 2, 0);
  close('a 3:1 split is the binary entropy', ig.entropy([3, 1]), BINARY_3_1);
  check('a zero total is 0 bits and never NaN', ig.entropy([0, 0]) === 0 && Number.isFinite(ig.entropy([0, 0])), String(ig.entropy([0, 0])));
  check('negative and non-numeric entries are ignored, not fatal',
    ig.entropy([1, -5, NaN, undefined]) === 0, String(ig.entropy([1, -5, NaN, undefined])));
  check('an empty vector is 0 bits', ig.entropy([]) === 0, String(ig.entropy([])));
  check('a non-array is 0 bits', ig.entropy(null) === 0 && ig.entropy(3) === 0 && ig.entropy('abc') === 0);
}

/* ============================================================ 2. the pool on a body */

section('2. candidateEntropy reads the surviving pool');
{
  const ig = engineWith();
  const st = stateOf(POOL_PRUNE);
  const e = ig.candidateEntropy(st.active.opp);
  close('a 4-set pool is 2 bits', e.bits, 2, 0);
  eq('it reports how many sets it saw and their weights', [e.sets, e.weights], [4, [1, 1, 1, 1]]);
  eq('no pool at all reports an empty readout', ig.candidateEntropy({}), { bits: 0, sets: 0, weights: [] });
  eq('a missing/negative weight is reported as 0, not carried through',
    ig.candidateEntropy({ candidateSets: [setOf('a', [], 2), setOf('b', [], -1), setOf('c', [], 'x')] }).weights,
    [2, 0, 0]);
}

/* ========================================================= 3. the assumed answer */

section('3. the answer we assume we would observe');
{
  const ig = engineWith();
  const st = stateOf(POOL_PRUNE);
  const g = ig.gainFor(ACTION, st);
  eq('the answer is the damage-maximising known move', g.response, 'headlongrush');
  const rock = st.active.opp.setMoves[1];
  const rockRes = ig.damage.calculateDamage(st.active.opp, st.active.my, rock, st.field);
  const hrRes = ig.damage.calculateDamage(st.active.opp, st.active.my, 'Headlong Rush', st.field);
  check('a non-damaging move is never chosen as the answer',
    !(rockRes && !rockRes.failed && rockRes.avgPercent > 0) && (hrRes.avgPercent > 0),
    JSON.stringify([rockRes && rockRes.avgPercent, hrRes && hrRes.avgPercent]));

  const noEngine = new ST.InformationGain();
  const g2 = noEngine.gainFor(ACTION, st);
  eq('with no damage engine the answer is refused, not guessed',
    [g2.bits, g2.response, g2.reason], [0, null, 'no-response-model']);
  const g3 = ig.gainFor(ACTION, { active: { my: st.active.my } });
  eq('with no opponent active it refuses', [g3.bits, g3.reason], [0, 'no-opponent-active']);
}

/* ======================================================== 4. the pruning arithmetic */

section('4. bits = the fog the assumed answer would burn');
{
  const ig = engineWith();
  const prune = ig.gainFor(ACTION, stateOf(POOL_PRUNE));
  close('two of four survivors: 2 bits in, 1 bit out', prune.bits, 1, 0);
  eq('...and the survivor count is reported', prune.kept, 2);
  const three = ig.gainFor(ACTION, stateOf(POOL_THREE));
  close('three of four survivors: log2(4) - log2(3)', three.bits, 2 - LOG2_3);
  const one = ig.gainFor(ACTION, stateOf(POOL_ONE));
  close('one of four survivors: the whole 2 bits', one.bits, 2, 0);
  eq('...with exactly one set left standing', one.kept, 1);
  const unknown = ig.gainFor(ACTION, stateOf(POOL_UNKNOWN));
  close('a set whose moves we do not know is never eliminated', unknown.bits, 1, 0);
  eq('...so it survives alongside the one that can produce the answer', unknown.kept, 2);
  const noCut = ig.gainFor(ACTION, stateOf(POOL_NOCUT));
  close('a pool the answer cannot cut is 0 bits', noCut.bits, 0, 0);
  const weighted = ig.gainFor(ACTION, stateOf(POOL_WEIGHTED));
  close('weights are respected: killing the 3-weight set leaves the 1-weight one',
    weighted.bits, BINARY_3_1, 1e-12);
  const pools = [POOL_PRUNE, POOL_ONE, POOL_THREE, POOL_NOCUT, POOL_KNOWN, POOL_UNKNOWN, POOL_WEIGHTED, [], null];
  check('bits is never negative on any pool',
    pools.every(function (p) { return ig.gainFor(ACTION, stateOf(p)).bits >= 0; }));
}

/* ======================================================== 5. reveals and the bounty */

section('5. three reasons a turn reveals nothing, and the bounty on the rest');
{
  const ig = engineWith({ enabled: true, maxBounty: 100 });
  const known = ig.gainFor(ACTION, stateOf(POOL_KNOWN));
  eq('a fully read body reveals nothing', [known.reveals, known.reason], [false, 'move-set-already-known']);
  check('...and pays no bounty', ig.bounty(ACTION, stateOf(POOL_KNOWN)) === 0);
  const single = ig.gainFor(ACTION, stateOf([setOf('only', ['Headlong Rush'])]));
  check('a one-set pool reveals nothing (nothing to separate)', single.reveals === false, JSON.stringify(single));

  const low = stateOf(POOL_PRUNE, { hpPercent: 4 });
  const doomed = ig.gainFor(ACTION, low);
  eq('a body that faints this turn cannot answer', [doomed.reveals, doomed.reason], [false, 'body-faints-this-turn']);
  check('...and pays no bounty', ig.bounty(ACTION, low) === 0);
  const probe = new ST.DamageEngine({ gen: 9 });
  let mineBest = null;
  ME_MOVES.forEach(function (name) {
    const res = probe.calculateDamage(low.active.my, low.active.opp, name, low.field);
    if (res && !res.failed && res.avgPercent > 0 && (!mineBest || res.avgPercent > mineBest.avgPercent)) mineBest = res;
  });
  check('...which is the damage engine\'s own isOHKO, not a threshold of ours',
    ig._doomed(low.active.opp, low.active.my, low) === !!(mineBest && mineBest.isOHKO === true),
    JSON.stringify(mineBest && mineBest.isOHKO));
  check('...and the same body at full HP is not "doomed"',
    ig._doomed(stateOf(POOL_PRUNE).active.opp, stateOf(POOL_PRUNE).active.my, stateOf(POOL_PRUNE)) === false);

  const off = engineWith({ maxBounty: 100 });
  check('disabled pays nothing even when the turn does reveal', off.enabled === false && off.gainFor(ACTION, stateOf(POOL_ONE)).reveals === true && off.bounty(ACTION, stateOf(POOL_ONE)) === 0);
  check('the shipped default is inert (enabled false, ceiling 0)',
    new ST.InformationGain().enabled === false && new ST.InformationGain().maxBounty === 0 &&
    new ST.InformationGain().bounty(ACTION, stateOf(POOL_ONE)) === 0);
  check('a ceiling of 0 pays nothing even when enabled',
    engineWith({ enabled: true, maxBounty: 0 }).bounty(ACTION, stateOf(POOL_ONE)) === 0);
  const noEngine = new ST.InformationGain({ enabled: true, maxBounty: 100 });
  check('no damage engine pays nothing', noEngine.bounty(ACTION, stateOf(POOL_ONE)) === 0);
  check('a pool below minEntropy pays nothing',
    engineWith({ enabled: true, maxBounty: 100, minEntropy: 3 }).bounty(ACTION, stateOf(POOL_ONE)) === 0);

  close('an answer that collapses the pool pays the whole ceiling',
    ig.bounty(ACTION, stateOf(POOL_ONE)), 100, 1e-9);
  close('an answer that halves the fog pays half of it',
    ig.bounty(ACTION, stateOf(POOL_PRUNE)), 50, 1e-9);
  const three = ig.bounty(ACTION, stateOf(POOL_THREE));
  close('an answer that leaves three quarters of the sets pays its share',
    three, 100 * ((2 - LOG2_3) / 2), 1e-9);
  check('...which is positive and below half the ceiling', three > 0 && three < 50, String(three));
  check('no pool pays more than the ceiling',
    poolsOf().every(function (p) {
      const b = ig.bounty(ACTION, stateOf(p));
      return b >= 0 && b <= 100;
    }), 'ceiling 100');
  check('a no-cut pool pays nothing', ig.bounty(ACTION, stateOf(POOL_NOCUT)) === 0);
}
function poolsOf() {
  return [POOL_PRUNE, POOL_ONE, POOL_THREE, POOL_NOCUT, POOL_KNOWN, POOL_UNKNOWN, POOL_WEIGHTED, []];
}

/* ======================================================= 6. purity and determinism */

section('6. pure, deterministic, and never a writer');
{
  const ig = engineWith({ enabled: true, maxBounty: 100 });
  const st = stateOf(POOL_PRUNE);
  const before = clone(st);
  ig.gainFor(ACTION, st);
  ig.bounty(ACTION, st);
  ig.candidateEntropy(st.active.opp);
  check('the battle state is byte-identical after every readout',
    JSON.stringify(before) === JSON.stringify(clone(st)));
  eq('the candidate pool itself is untouched',
    clone(st.active.opp.candidateSets), before.active.opp.candidateSets);
  const a = JSON.stringify(ig.gainFor(ACTION, stateOf(POOL_PRUNE)));
  const b = JSON.stringify(ig.gainFor(ACTION, stateOf(POOL_PRUNE)));
  check('two identical calls return identical readouts (deterministic, no Math.random)', a === b, a);
}

/* ================================================================== summary */

console.log('\n=== summary ===');
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failures.length);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('ALL ENTROPY CHECKS PASSED (' + passed + ')');
process.exit(0);
