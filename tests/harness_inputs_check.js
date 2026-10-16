/* Showdown Tactician — tests/harness_inputs_check.js
 *
 * The input-population assertion (tools/harness_inputs.js) is the check that stands between a
 * harness and a FALSE NULL: a `--set` whose channel is never populated returns its inert default on
 * every turn, so the variant and the baseline come back identical and the report says "this feature
 * does nothing". `appliedSets` cannot catch that — it proves the flag landed, not that anything was
 * ever handed to it.
 *
 * These checks pin the four things the assertion rests on: the path -> channel mapping (longest
 * prefix, and the two groups the table has to keep apart), the probes (a channel is seen only when
 * the board really carries it), the refusal itself (loud, named, and never fired for a run that
 * measured nothing, for a run with no flags, or for a path with no classification), and the
 * REGISTRY COVERAGE that keeps the ablation's feature table classified as a build-time requirement
 * rather than a runtime casualty.
 */
'use strict';

const path = require('path');
const HI = require(path.join(__dirname, '..', 'tools', 'harness_inputs.js'));
const AB = require(path.join(__dirname, '..', 'tools', 'run_ablation.js'));

let passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + label); }
  else { failed++; console.log('  FAIL ' + label + (detail === undefined ? '' : '  [' + detail + ']')); }
}
function eq(label, actual, expected) {
  check(label, actual === expected, JSON.stringify(actual) + ' !== ' + JSON.stringify(expected));
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* ------------------------------------------------------------------ fixtures */

const U = {
  getMoveData: function (name) {
    if (name === 'Dragon Dance') return { isSetup: true, isStatus: true, basePower: 0 };
    if (name === 'Protect') return { isProtect: true, isStatus: true, basePower: 0 };
    return { isStatus: false, basePower: 80 };
  }
};

/** The smallest thing `watch` will wrap: it only needs `evaluateTurn` and the two probe surfaces. */
function fakeEngine(opts) {
  opts = opts || {};
  const engine = {
    lastReadout: { worlds: opts.worlds || [] },
    getOppActions: function () { return opts.oppActions || []; },
    evaluateTurn: function () { return opts.rows || []; }
  };
  return engine;
}

/** A board carrying every channel the module knows about. */
function suppliedState() {
  return {
    clock: { enabled: true, samples: 3, switchFactor: 1.6, label: 'normal' },
    opponentRating: 1850,
    moveAccuracy: { headlongrush: 100 },
    active: { opp: { candidateSets: [{ weight: 1, moves: ['earthquake'] }] } }
  };
}

function reset() { HI._live.length = 0; }


/* ------------------------------------------------- 1. the path -> channel map */

section('1. a flag path resolves to the channel it actually reads');

eq('a three-level path resolves to its own row, not the family above it',
  HI.inputFor('clock.ratingBands.enabled').match, 'clock.ratingBands');
eq('...and that row needs BOTH the clock and a rating',
  HI.inputFor('clock.ratingBands.highFactor').needs.join('+'), 'clock+rating');
eq('a sibling under the same family resolves to the sibling row',
  HI.inputFor('clock.switchPrior.agonised').match, 'clock.switchPrior');
eq('a bare family path resolves to its own row',
  HI.inputFor('clock.enabled').match, 'clock.');
eq('the quiescence sub-knobs resolve to the tier that re-prices their setup reply',
  HI.inputFor('laplace.quiescence.extendSetup').match, 'laplace.quiescence');
eq('the volatility charge resolves to the accuracy table it reads',
  HI.inputFor('laplace.volatility.enabled').needs.join('+'), 'accuracy');
eq('the scouting bounty resolves to the candidate pool it measures the fog on',
  HI.inputFor('laplace.scouting.maxBounty').needs.join('+'), 'oppCandidatePool');
check('a path with NO classification is reported rather than assumed to be fine',
  HI.inputFor('laplace.temperature') === null, '');

/* The two classified groups, which is the distinction the table exists to make. A row with no
 * channel to police is either a documented control or a value the ENGINE computes itself; mapping
 * one to an unrelated channel (the clock was the first attempt) would have made the check pass for
 * a reason that has nothing to do with the flag. */
eq('an empty-overlay control is classified, not unclassified',
  HI.inputFor('pruner.scout.enabled').match, 'pruner.scout');
eq('...and it polices no channel, so it is never refused',
  HI.inputFor('pruner.scout.enabled').needs.length, 0);
eq('the ladder overlay is the second control, under its real path',
  HI.inputFor('usage.enabled').match, 'usage');
eq('...and the same for the ladder-usage overlay',
  HI.inputFor('usage.enabled').needs.length, 0);
eq('a tier that computes its own input carries no channel either (the wincon plan)',
  HI.inputFor('laplace.wincon.enabled').needs.length, 0);
eq('...and neither does the profiler, which the engine feeds itself',
  HI.inputFor('laplace.profile.enabled').needs.length, 0);
eq('...nor the beam, whose gate IS its own config flag',
  HI.inputFor('laplace.beam2Ply.enabled').needs.length, 0);
eq('a board/log-reading veto is classified too, so it cannot be refused for a clock reason',
  HI.inputFor('veto.wastedHazardClear').match, 'veto.');
check('every classified row says WHY it is classified or what it reads',
  HI.FLAG_INPUTS.every(function (r) { return typeof r.note === 'string' && r.note.length > 10; }), '');

/* -------------------------------------------------------- 2. the probes */

section('2. a channel is seen only when the board really carries it');

reset();
const engineA = fakeEngine({
  worlds: [{}],
  oppActions: [{ kind: 'move', name: 'Dragon Dance' }, { kind: 'switch', name: 'Gastrodon' }],
  rows: [{ kind: 'move', isVetoed: false }, { kind: 'switch', isVetoed: false }]
});
const obsA = HI.watch(engineA, U);
engineA.evaluateTurn(suppliedState());
const seenA = HI.observed();
eq('the clock snapshot is seen', typeof seenA.clock, 'number');
eq('a MEASURED pace is seen only when the clock has samples', typeof seenA.clockPace, 'number');
eq('the opponent rating is seen', typeof seenA.rating, 'number');
eq('the accuracy table is seen', typeof seenA.accuracy, 'number');
eq('an opponent reply is seen', typeof seenA.oppReply, 'number');
eq('their SETUP move is seen', typeof seenA.setupReply, 'number');
eq('more than one live row is seen', typeof seenA.multiRow, 'number');
eq('a switch row on our side is seen', typeof seenA.switchRow, 'number');
eq('the candidate-set pool is seen', typeof seenA.oppCandidatePool, 'number');
eq('the first turn a channel was seen on is recorded', seenA.clock, 1);
check('the watch counts the decisions it saw', HI.watchedTurns() === 1, String(HI.watchedTurns()));

reset();
const bare = fakeEngine({ worlds: [{}], oppActions: [{ kind: 'move', name: 'Earthquake' }], rows: [{ kind: 'move', isVetoed: false }] });
const obsB = HI.watch(bare, U);
bare.evaluateTurn({});
const seenB = HI.observed();
eq('no clock means the clock channel is NOT seen', seenB.clock, undefined);
eq('no rating means the rating channel is NOT seen', seenB.rating, undefined);
eq('an empty accuracy table is not a supplied accuracy table',
  (bare.evaluateTurn(Object.assign(suppliedState(), { moveAccuracy: {} })), HI.observed().accuracy), undefined);
eq('one live row is not a choice to solve', seenB.multiRow, undefined);
eq('their NON-setup reply does not supply the setup channel', seenB.setupReply, undefined);
check('the watch counts EVERY decision it saw, not just the first (two here)',
  HI.watchedTurns() === 2, String(HI.watchedTurns()));
eq('an EMPTY candidate pool is not a supplied pool', (function () {
  /* A FRESH collector, and last in this block: the turns above DID carry a pool, so an empty one has
   * to be judged on its own — which is also how a harness sees it, one board at a time. */
  reset();
  const e = fakeEngine({ rows: [] });
  HI.watch(e, U);
  e.evaluateTurn(Object.assign(suppliedState(), { active: { opp: { candidateSets: [] } } }));
  return HI.observed().oppCandidatePool;
})(), undefined);
check('the unwatched probe surface is untouched', !!obsA && !!obsB, '');

/* -------------------------------------------------- 3. the refusal itself */

section('3. the refusal: loud, named, and only when it should fire');

reset();
eq('no flags applied is always fine', HI.assertSupplied([], 'unit') === undefined, true);
check('a run that watched NOTHING does not fire the refusal (it measured nothing, which is a different defect)',
  HI.assertSupplied([{ path: 'laplace.volatility.enabled' }], 'unit') === undefined, String(HI.watchedTurns()));

reset();
const engineD = fakeEngine({ worlds: [{}], oppActions: [{ kind: 'move', name: 'Earthquake' }], rows: [{ kind: 'move', isVetoed: false }] });
HI.watch(engineD, U);
engineD.evaluateTurn({});
let threw = null;
try { HI.assertSupplied([{ path: 'laplace.volatility.enabled' }], 'unit-suite'); } catch (e) { threw = e; }
check('an applied flag whose channel was never supplied REFUSES the run', !!threw, String(threw && threw.message));
eq('...with a code a caller can branch on', threw && threw.code, 'UNSUPPLIED_INPUT');
check('...naming the path', /laplace\.volatility\.enabled/.test(threw.message), threw.message);
check('...naming the INPUT it needed, not just the flag',
  /stacc/.test(threw.message), threw.message);
check('...and saying why it matters rather than only that it failed',
  /false null/i.test(threw.message), threw.message);
check('...carrying the findings for a report', Array.isArray(threw.findings) && threw.findings[0].path === 'laplace.volatility.enabled', '');
eq('a flag whose channel IS supplied passes', (function () {
  reset();
  const e2 = fakeEngine({ worlds: [{}], oppActions: [], rows: [] });
  HI.watch(e2, U);
  e2.evaluateTurn(suppliedState());
  try { HI.assertSupplied([{ path: 'clock.ratingBands.enabled' }], 'unit-suite'); return 'passed'; }
  catch (e) { return 'refused: ' + e.message.split('\n')[0]; }
})(), 'passed');
check('a flag with NO classification does NOT refuse the run (it is not evidence of anything)',
  (function () {
    reset();
    const e3 = fakeEngine({ rows: [] });
    HI.watch(e3, U);
    e3.evaluateTurn(suppliedState());
    try { HI.assertSupplied([{ path: 'laplace.brandNewKnob' }], 'unit-suite'); return 'passed'; }
    catch (e) { return 'refused: ' + e.message.split('\n')[0]; }
  })(), 'passed');
eq('...but it IS reported, so the gap is visible without costing the measurement', (function () {
  reset();
  const e4 = fakeEngine({ rows: [] });
  HI.watch(e4, U);
  e4.evaluateTurn(suppliedState());
  return HI.unclassified([{ path: 'laplace.brandNewKnob' }, { path: 'clock.enabled' }]).join(',');
})(), 'laplace.brandNewKnob');
check('a classification with no channel is never refused, whatever the board carries',
  (function () {
    reset();
    const e5 = fakeEngine({ rows: [] });
    HI.watch(e5, U);
    e5.evaluateTurn({});
    try { HI.assertSupplied([{ path: 'usage.enabled' }, { path: 'laplace.profile.enabled' },
      { path: 'laplace.wincon.enabled' }], 'unit-suite'); return 'passed'; }
    catch (e) { return 'refused: ' + e.message.split('\n')[0]; }
  })(), 'passed');

/* ------------------------------------------------- 4. the reportable summary */

section('4. the summary a harness publishes is JSON-able and complete');

reset();
const engineE = fakeEngine({ worlds: [{}], oppActions: [], rows: [] });
HI.watch(engineE, U);
engineE.evaluateTurn({});
const rep = HI.supplyReport([{ path: 'laplace.volatility.enabled' }, { path: 'laplace.temperature' }]);
check('the report survives a JSON round trip (it is written into a harness payload)',
  JSON.stringify(JSON.parse(JSON.stringify(rep))) === JSON.stringify(rep), '');
eq('...counting the turns actually watched', rep.watchedTurns, 1);
eq('...listing the flags that had no input', rep.unsupplied.length, 1);
eq('...naming the channel each of them needed', rep.unsupplied[0].missing.join('+'), 'accuracy');
eq('...and reporting the unclassified path separately, so a row is never failed over it',
  rep.unclassified.join(','), 'laplace.temperature');
check('a fully supplied run reports an empty list', (function () {
  reset();
  const e6 = fakeEngine({ worlds: [{}], oppActions: [], rows: [] });
  HI.watch(e6, U);
  e6.evaluateTurn(suppliedState());
  return HI.supplyReport([{ path: 'clock.ratingBands.enabled' }]).unsupplied.length === 0;
})(), '');

/* -------------------------------------------- 5. registry coverage (build-time) */

section('5. every flag the ablation registry applies is classified');

/* THE RUNTIME LEAVES AN UNCLASSIFIED PATH ALONE, so this is where the stricter rule lives: the
 * feature table's own flags must all be decided on, or a false null could hide behind one of them.
 * The failure message says what to do, because "classify it" is the whole action. */
const registryPaths = [];
AB.buildVariants({}).forEach(function (v) {
  (v.setArgs || []).forEach(function (s) {
    const p = s.split('=')[0];
    if (registryPaths.indexOf(p) === -1) registryPaths.push(p);
  });
});
const unclassifiedRegistry = registryPaths.filter(function (p) { return !HI.inputFor(p); });
check('the registry was read at all (' + registryPaths.length + ' distinct flag paths)',
  registryPaths.length > 20, String(registryPaths.length));
check('every one of them has a row in FLAG_INPUTS — none left to guess at',
  unclassifiedRegistry.length === 0, unclassifiedRegistry.join(', '));
check('...and no registry flag is pinned to a channel the arena never supplies', (function () {
  /* A registry flag may only be fatal if its channel can plausibly be fed; the two empty-overlay
   * controls and the self-computed tiers must not be, or the whole table would print FAILED. */
  const controls = ['pruner.scout.enabled', 'usage.enabled', 'laplace.wincon.enabled',
    'laplace.profile.enabled', 'laplace.beam2Ply.enabled'];
  return controls.every(function (p) { return HI.inputFor(p).needs.length === 0; });
})(), '');

console.log('\n' + (failed ? 'FAILED' : 'ALL HARNESS-INPUT CHECKS PASSED') + ' (' + passed + ')');
process.exit(failed ? 1 : 0);
