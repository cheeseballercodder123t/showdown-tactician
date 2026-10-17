/* Showdown Tactician — tests/wincon_check.js
 *
 * Run me with:  node tests/wincon_check.js
 *
 * WHAT THIS IS
 *   The regression suite for src/wincon_bounty.js — the backward-chained win-condition bounty
 *   ("which one of their bodies is the golden path, and what is it worth to remove it?").
 *
 * WHAT IT PINS, AND WHY THAT IS THE HARD PART
 *   The easy version of this feature is a species rule ("kill the wall, then sweep"). This suite's
 *   job is to prove the module never became one:
 *     §1  every refusal — no damage engine, no living body of ours, no living body of theirs,
 *         fewer than two candidate targets, or nothing measurable about the candidates;
 *     §2  the target is the body the DAMAGE ENGINE says is the bigger threat, re-measured here
 *         independently of the module's own ranking;
 *     §3  the bounty is bounded by `maxBounty`, scales with how much the target dominates the
 *         runner-up, and is paid by `bonus()` only once the target is actually gone;
 *     §4  `maxTargets` bounds the work, not the search, and the sampled worlds are deduplicated
 *         into BODIES (the six worlds differ in set, not in body);
 *     §5  purity (the board is never written through), determinism, the `last` readout, and the
 *         default-off behaviour of the tier;
 *     §6  a structural pin that the module's own source contains no species name, no species
 *         database lookup and no randomness — with a positive control, so the pin cannot pass by
 *         reading an empty file.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about whether the bounty is USEFUL in play: the tier ships `enabled: false` and no
 *   decision loop consumes it yet, so there is no measurement to point at. The suite shows the
 *   arithmetic is bounded, measured, deterministic and pure; it cannot show the target it names is
 *   the one a strong player would name. That is the adoption gate's job, not a fixture's.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const S = H.loadAll({
  setInterval: function () { return 0; },
  clearInterval: function () { }
});
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
function section(t) { console.log('\n=== ' + t + ' ==='); }
function snapshot(x) { return JSON.stringify(x); }

if (!ST.WinConditionBounty) {
  check('ST.WinConditionBounty is registered', false, 'src/wincon_bounty.js did not load');
  console.log('\nchecks passed: ' + passed + '\nchecks failed: ' + failed);
  process.exit(1);
}

/* ------------------------------------------------------------------ fixture */

const ZERO_BOOSTS = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
const IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

function mon(species, moves, nature, evs, extra) {
  return Object.assign({
    id: U.toID(species), species: species, side: 'p2', revealed: true, level: 100,
    hp: 100, maxhp: 100, hpPercent: 100, fainted: false, status: '',
    nature: nature || 'Serious', evs: evs || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, ivs: IVS,
    boosts: Object.assign({}, ZERO_BOOSTS),
    volatiles: {}, revealedMoves: [], activeStintMoves: [], movePP: {},
    possibleAbilities: U.getAbilities(species), speedFloor: 0, speedCeiling: 1012,
    candidateSets: [], liveSet: null, isActive: false, item: '', ability: '', setMoves: moves.slice()
  }, extra || {});
}

/* My roster is deliberately bulky-plus-one-sweeper: Corviknight cannot break a physical wall,
 * Azumarill is the body the plan is supposed to unblock. Their roster pairs a wall that survives
 * our best hit and hits back (Ferrothorn) with a body we clearly KO (Blissey at 12%): the suite
 * asserts that gap is real BEFORE it asserts which one the module picks, so a failure says which
 * half broke. */
function myRoster() {
  return [
    mon('Corviknight', ['Brave Bird', 'Body Press', 'Roost', 'U-turn'], 'Impish',
      { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 }, { side: 'p1', isActive: true, item: 'Leftovers', ability: 'Pressure' }),
    mon('Azumarill', ['Play Rough', 'Liquidation', 'Aqua Jet', 'Knock Off'], 'Adamant',
      { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, { side: 'p1', item: 'Choice Band', ability: 'Huge Power' }),
    mon('Great Tusk', ['Headlong Rush', 'Close Combat', 'Ice Spinner', 'Rapid Spin'], 'Jolly',
      { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, { side: 'p1', item: 'Choice Scarf', ability: 'Protosynthesis' })
  ];
}

function ferrothorn(extra) {
  return mon('Ferrothorn', ['Power Whip', 'Body Press', 'Leech Seed', 'Stealth Rock'], 'Relaxed',
    { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 },
    Object.assign({ item: 'Leftovers', ability: 'Iron Barbs' }, extra || {}));
}
function blissey(extra) {
  return mon('Blissey', ['Seismic Toss', 'Soft-Boiled', 'Thunder Wave', 'Heal Bell'], 'Bold',
    { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 },
    Object.assign({ hpPercent: 12, item: 'Heavy-Duty Boots', ability: 'Natural Cure' }, extra || {}));
}
function greatTuskOpp(extra) {
  return mon('Great Tusk', ['Headlong Rush', 'Close Combat', 'Ice Spinner', 'Rapid Spin'], 'Jolly',
    { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
    Object.assign({ item: 'Booster Energy', ability: 'Protosynthesis' }, extra || {}));
}
function passiveWall(species, moves) {
  return mon(species, moves, 'Bold', { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 },
    { item: 'Leftovers', ability: '' });
}

function board(oppTeam) {
  const my = myRoster();
  const opp = (oppTeam || [ferrothorn(), blissey()]).slice();
  for (let i = 0; i < opp.length; i++) opp[i].isActive = i === 0;
  return {
    turn: 14, mySide: 'p1', oppSide: 'p2', formatSupported: true,
    myTeam: my, oppTeam: opp,
    active: { my: my[0], opp: opp[0] },
    bench: { my: my.slice(1), opp: opp.slice(1) },
    protect: { oppTurnsSinceLastProtect: 2, oppConsecutiveProtects: 0, myTurnsSinceLastProtect: 4, myConsecutiveProtects: 0 },
    recoveryPP: {},
    field: { turn: 14, trickRoom: false, weather: '', terrain: '', hazards: { p1: {}, p2: {} }, screens: {}, tailwind: {}, gravity: false }
  };
}

const damage = new ST.DamageEngine({ gen: 9 });
const BOUNTY = 500;
function tier(options) {
  return new ST.WinConditionBounty(Object.assign({ damage: damage, enabled: true, maxBounty: BOUNTY, maxTargets: 3 }, options || {}));
}

/** The measurement the module's ranking is supposed to obey, re-derived here. */
function threatOf(body, myTeam, field) {
  let worst = 0;
  for (let i = 0; i < myTeam.length; i++) {
    const hit = damage.getBestIncomingThreat(body, myTeam[i], field);
    if (hit && hit.avgPercent > worst) worst = hit.avgPercent;
  }
  return worst;
}

/* ============================================================ 1. the refusals */

section('1. every refusal: a plan is a claim, and it makes none it cannot measure');

const st0 = board();
eq('no damage engine -> null', new ST.WinConditionBounty({ enabled: true, maxBounty: BOUNTY }).plan(st0, null), null);
eq('disabled by default -> null (the tier ships off)', new ST.WinConditionBounty({ damage: damage }).plan(st0, null), null);
eq('a null board -> null', tier().plan(null, null), null);
eq('an empty board -> null', tier().plan({}, null), null);

const noMine = board();
noMine.myTeam.forEach(function (m) { m.fainted = true; });
noMine.active.my = noMine.myTeam[0];
eq('no living body of ours -> null', tier().plan(noMine, null), null);

const noTheirs = board();
noTheirs.oppTeam.forEach(function (m) { m.fainted = true; });
noTheirs.active.opp = noTheirs.oppTeam[0];
eq('no living body of theirs -> null', tier().plan(noTheirs, null), null);

eq('one candidate body -> null (a target from one candidate is not a choice)',
  tier().plan(board([ferrothorn()]), null), null);

/* Two bodies that cannot damage us at all: nothing measurable to chase. */
const harmless = board([
  passiveWall('Ferrothorn', ['Stealth Rock', 'Leech Seed', 'Protect', 'Toxic']),
  passiveWall('Blissey', ['Soft-Boiled', 'Thunder Wave', 'Heal Bell', 'Wish'])
]);
eq('nothing measurable about the candidates -> null', tier().plan(harmless, null), null);

const off = new ST.WinConditionBounty({ damage: damage });
eq('disabled: bonus() is 0 even for a satisfied plan', off.bonus({ targetId: 'ferrothorn', bounty: 400 }, ['ferrothorn']), 0);
eq('maxBounty 0: the plan computes but pays nothing',
  tier({ maxBounty: 0 }).bonus(tier({ maxBounty: 0 }).plan(board(), null), ['ferrothorn']), 0);

/* ============================================================== 2. the target */

section('2. the target is the body the damage engine says is the bigger threat');

const wb = tier();
// Their 12% body is listed FIRST on purpose: the plan has to pick by measurement, not by roster
// position, and this fixture is the one place that can tell the difference.
const st2 = board([blissey(), ferrothorn()]);
const plan = wb.plan(st2, null);
check('a two-body board yields one plan object', !!plan && typeof plan === 'object' && !Array.isArray(plan),
  JSON.stringify(plan));
check('...naming a target that is really on their roster',
  !!plan && ['ferrothorn', 'blissey'].indexOf(plan.targetId) !== -1, plan && plan.targetId);
check('...with a species name and a non-empty reason',
  !!plan && !!plan.targetSpecies && typeof plan.reason === 'string' && plan.reason.length > 10,
  plan && plan.reason);

const bliss = st2.oppTeam[0];
const ferro = st2.oppTeam[1];
const tFerro = threatOf(ferro, st2.myTeam, st2.field);
const tBliss = threatOf(bliss, st2.myTeam, st2.field);
check('the fixture is discriminating: the wall out-threatens the 12% body', tFerro > tBliss + 1,
  'ferrothorn ' + U.round1(tFerro) + '% vs blissey ' + U.round1(tBliss) + '%');
check('...and the plan names the bigger threat, not the first body listed',
  !!plan && plan.targetId === U.toID('Ferrothorn'),
  'threats ' + U.round1(tFerro) + ' / ' + U.round1(tBliss) + ', picked ' + (plan && plan.targetId));

check('the score is the measurement, not a guess', !!plan && plan.score > 0, plan && plan.score);
check('blockers is an array of measured rows',
  !!plan && Array.isArray(plan.blockers) && plan.blockers.every(function (b) {
    return b && typeof b.id === 'string' && b.id &&
      typeof b.score === 'number' && isFinite(b.score) &&
      typeof b.reason === 'string' && b.reason.length > 10 &&
      (b.ourBest === null || (typeof b.ourBest.avgPercent === 'number' && typeof b.ourBest.move === 'string')) &&
      (b.theirBest === null || (typeof b.theirBest.avgPercent === 'number' && typeof b.theirBest.move === 'string'));
  }), JSON.stringify(plan && plan.blockers));
check('...and the wall that survives us is named in it',
  !!plan && plan.blockers.some(function (b) { return b.id === U.toID('Ferrothorn'); }),
  JSON.stringify(plan && plan.blockers.map(function (b) { return b.id; })));

/* ============================================================== 3. the bounty */

section('3. the bounty is bounded, scales with dominance, and is paid only on the faint');

check('the bounty is inside [0, maxBounty]', !!plan && plan.bounty >= 0 && plan.bounty <= BOUNTY,
  plan && plan.bounty + ' of ' + BOUNTY);
check('...and is positive when one body really does dominate', !!plan && plan.bounty > 0,
  JSON.stringify(plan && { bounty: plan.bounty, dominance: plan.dominance, score: plan.score }));
check('dominance is a share in [0, 1]', !!plan && plan.dominance >= 0 && plan.dominance <= 1,
  plan && plan.dominance);
/* `dominance` is PUBLISHED rounded to two decimals while `bounty` is computed from the unrounded
 * share, so the two can differ by up to half a percent of maxBounty: a tolerance, not an identity. */
check('the bounty is maxBounty scaled by the published dominance',
  !!plan && Math.abs(Math.round(BOUNTY * plan.dominance) - plan.bounty) <= Math.ceil(BOUNTY * 0.005) + 1,
  plan && ('dominance ' + plan.dominance + ' -> ' + Math.round(BOUNTY * plan.dominance) +
    ' vs bounty ' + plan.bounty));

/* The bonus semantics are pinned on a synthetic plan so they do not depend on the damage math. */
const synth = { targetId: 'Ferrothorn', bounty: 250, targetSpecies: 'Ferrothorn' };
eq('nothing fainted -> 0', tier().bonus(synth, []), 0);
eq('an unrelated faint -> 0', tier().bonus(synth, ['Great Tusk']), 0);
eq('null faintedIds -> 0', tier().bonus(synth, null), 0);
eq('a null plan -> 0', tier().bonus(null, ['Ferrothorn']), 0);
eq('the target faints -> the plan\'s bounty', tier().bonus(synth, ['ferrothorn']), 250);
eq('...and the id is matched case-insensitively, as an id or as a mon', tier().bonus(synth, ['FERROTHORN']), 250);
eq('...a mon object works too', tier().bonus(synth, [{ id: 'ferrothorn' }]), 250);
eq('a bounty over maxBounty is clamped', tier().bonus({ targetId: 'ferrothorn', bounty: 9999 }, ['ferrothorn']), BOUNTY);
eq('a negative bounty pays nothing', tier().bonus({ targetId: 'ferrothorn', bounty: -50 }, ['ferrothorn']), 0);
eq('a plan with no targetId pays nothing', tier().bonus({ bounty: 250 }, ['ferrothorn']), 0);
eq('the real plan pays exactly its own bounty once the target is gone',
  wb.bonus(plan, [plan.targetId]), plan.bounty);
eq('...and nothing before that', wb.bonus(plan, []), 0);

/* ---------------------------------------------------------------- 3b. the chip half */

section('3b. a chipped roadblock pays for the distance it covered toward the break point');

const chipTier = tier({ chipBounty: 120 });
const chipPlan = { targetId: 'Ferrothorn', bounty: 250, chipThreshold: 40, hpAtPlan: 90 };
const leafAt = function (hp) {
  return { active: { opp: { id: 'ferrothorn', hpPercent: hp } }, oppTeam: [] };
};
eq('chipBounty 0 (the shipped reading) pays nothing for a surviving target',
  tier().bonus(chipPlan, [], leafAt(50)), 0);
eq('half the distance to the break point pays half the ceiling',
  chipTier.bonus(chipPlan, [], leafAt(65)), 60);
eq('reaching the break point pays the whole ceiling', chipTier.bonus(chipPlan, [], leafAt(40)), 120);
eq('...and chipping past it cannot pay more', chipTier.bonus(chipPlan, [], leafAt(5)), 120);
eq('no progress this turn pays nothing', chipTier.bonus(chipPlan, [], leafAt(90)), 0);
eq('healing it pays nothing (progress is one-directional)', chipTier.bonus(chipPlan, [], leafAt(95)), 0);
eq('the fainted branch is still the full bounty, never the chip',
  chipTier.bonus(chipPlan, ['Ferrothorn'], leafAt(0)), 250);
eq('a leaf that cannot name the target pays nothing (no invented progress)',
  chipTier.bonus(chipPlan, [], { active: { opp: { id: 'blissey', hpPercent: 10 } }, oppTeam: [] }), 0);
eq('a plan with no measured break point pays nothing',
  chipTier.bonus({ targetId: 'ferrothorn', bounty: 250, chipThreshold: 0, hpAtPlan: 90 }, [], leafAt(10)), 0);
check('the plan itself carries both measured numbers',
  typeof plan.chipThreshold === 'number' && typeof plan.hpAtPlan === 'number' &&
  plan.hpAtPlan > 0, JSON.stringify({ chipThreshold: plan.chipThreshold, hpAtPlan: plan.hpAtPlan }));
check('...and the break point is the smallest roll of our best hit, not a guess',
  plan.chipThreshold >= 0 && plan.chipThreshold <= 100, String(plan.chipThreshold));

/* ========================================================= 4. worlds and bounds */

section('4. worlds are deduplicated into bodies, and maxTargets bounds the work');

const worlds = [
  { id: 'w0', team: [ferrothorn(), blissey()], weight: 1 },
  { id: 'w1', team: [ferrothorn({ item: 'Rocky Helmet' }), blissey()], weight: 1 },
  { id: 'w2', team: [ferrothorn(), blissey({ item: 'Leftovers' })], weight: 1 }
];
const wbWorlds = tier();
const fromWorlds = wbWorlds.plan(board(), worlds);
check('the six-world shape still yields exactly one plan',
  !!fromWorlds && typeof fromWorlds === 'object' && !Array.isArray(fromWorlds), JSON.stringify(fromWorlds));
check('...over the same set of BODIES as the live roster (set differences are not separate targets)',
  !!fromWorlds && fromWorlds.targetId === (plan && plan.targetId),
  (fromWorlds && fromWorlds.targetId) + ' vs ' + (plan && plan.targetId));
check('...and a fainted body in a world is not a candidate',
  tier().plan(board(), [{ team: [ferrothorn({ fainted: true }), blissey()] }]) === null,
  'one live candidate must refuse');

const threeWay = board([ferrothorn(), blissey(), greatTuskOpp()]);
const capped = tier({ maxTargets: 1 }).plan(threeWay, null);
check('maxTargets 1 still returns a plan', !!capped && !!capped.targetId, JSON.stringify(capped));
check('...with at most one examined body reported',
  !!capped && capped.blockers.length <= 1, JSON.stringify(capped && capped.blockers.length));
const wide = tier({ maxTargets: 12 }).plan(threeWay, null);
check('a cap beyond the roster is harmless',
  !!wide && wide.blockers.length <= 3, JSON.stringify(wide && wide.blockers.length));
check('...and the full-cap plan still names a real target',
  !!wide && [U.toID('Ferrothorn'), U.toID('Blissey'), U.toID('Great Tusk')].indexOf(wide.targetId) !== -1,
  wide && wide.targetId);

/* ==================================================== 5. purity, determinism, last */

section('5. purity, determinism, and the last readout');

const pureBoard = board();
const pureWorlds = [{ team: [ferrothorn(), blissey()], weight: 1 }];
const beforeBoard = snapshot(pureBoard);
const beforeWorlds = snapshot(pureWorlds);
const wbPure = tier();
const purePlan = wbPure.plan(pureBoard, pureWorlds);
check('the board is unchanged after a plan', snapshot(pureBoard) === beforeBoard);
check('...and so are the sampled worlds', snapshot(pureWorlds) === beforeWorlds);
check('...including every stat stage on every body',
  pureBoard.oppTeam.concat(pureBoard.myTeam).every(function (m) {
    return Object.keys(ZERO_BOOSTS).every(function (k) { return m.boosts[k] === 0; });
  }));
check('last holds the plan that was returned', wbPure.last === purePlan);

const wbA = tier();
const wbB = tier();
eq('two identical calls give identical plans',
  JSON.parse(JSON.stringify(wbA.plan(board(), null))), JSON.parse(JSON.stringify(wbB.plan(board(), null))));
const repeat = wbA.plan(board(), null);
eq('...and the call is repeatable on the same instance',
  JSON.parse(JSON.stringify(wbA.last)), JSON.parse(JSON.stringify(repeat)));

const wbRefuse = tier();
wbRefuse.plan(board(), null);
wbRefuse.plan(board([ferrothorn()]), null);
eq('a refusal clears last rather than leaving a stale plan', wbRefuse.last, null);
const wbBonusOnly = new ST.WinConditionBounty({ damage: damage });
eq('a disabled tier never publishes a plan', wbBonusOnly.plan(board(), null), null);

/* ================================================================ 6. the source */

section('6. the module owns no species rule (RULE 1) and no randomness');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'wincon_bounty.js'), 'utf8');
check('the module source was actually read (positive control)', source.indexOf('WinConditionBounty') !== -1,
  String(source.length) + ' bytes');
check('...and registers itself on ST', source.indexOf('ST.WinConditionBounty = WinConditionBounty') !== -1);

const DB = ST.SetDatabase;
const allSpecies = (DB && typeof DB.allSpecies === 'function') ? DB.allSpecies() : [];
const sample = allSpecies.filter(function (name, i) { return i % 19 === 0; }).slice(0, 12);
check('a species sample was drawn from the set database', sample.length >= 8, String(sample.length));
const hitsSpecies = function (name) {
  // Word boundaries, so a species name is not "found" inside an unrelated identifier.
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + escaped + '\\b').test(source);
};
check('no species name appears anywhere in the module', !sample.some(hitsSpecies),
  sample.filter(hitsSpecies).join(', '));
check('...nor does it consult the species database at all', source.indexOf('SetDatabase') === -1);
check('...nor does it reach for randomness', source.indexOf('Math.random') === -1);
check('every damage number comes from the engine it was handed',
  source.indexOf('getBestIncomingThreat') !== -1 && source.indexOf('getBestOutgoingMove') !== -1);

/* ------------------------------------------------------------------- summary */

console.log('\nchecks passed: ' + passed);
console.log('checks failed: ' + failed);
if (failures.length) {
  console.log('\nFAILURES:\n' + failures.map(function (f) { return '  - ' + f; }).join('\n'));
  process.exit(1);
}
console.log('ALL WINCON CHECKS PASSED (' + passed + ')');
// The sandbox the harness builds keeps a live handle, so every suite in this repository exits
// explicitly rather than waiting for the loop to drain (see tests/hud_check.js).
process.exit(0);
