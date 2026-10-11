/* Showdown Tactician — tests/weights_check.js
 *
 * Run me with:  node tests/weights_check.js
 *
 * WHAT THIS IS
 *   The regression suite for the empirical-weight pipeline: tools/extract_training_data.js
 *   (replays -> 128D dataset) and tools/fit_weights.js (dataset -> fitted logistic weights).
 *   Like tests/upgrades_check.js it is split so that "is the maths right" is answered against
 *   fixtures with a known answer, and only then against the real 128-dimension contract.
 *
 * WHAT IT MUST PROVE
 *   1. the AUC is the rank-sum statistic, ties included (hand-computed fixture);
 *   2. the IRLS fitter RECOVERS a planted model (a fitter that returned zeros would fail);
 *   3. the hold-out split is deterministic, disjoint and complete;
 *   4. mapToSpec maps the coefficient groups exactly, including the four sign-folding groups
 *      and the threat-matrix diagonal exclusion (a wrong mapping silently reshapes the whole
 *      evaluator, so the diagonal is pinned by two vectors that isolate it);
 *   5. the extractor produces one labelled 128-float row per turn header and is deterministic;
 *   6. degenerate corpora (single class, ragged, empty, non-finite) are REFUSED with a clear
 *      error instead of producing NaN;
 *   7. the downloader labels a replay through the LOG'S OWN seat table rather than by array
 *      order, and refuses a log it cannot label instead of inventing a winner;
 *   8. the fitted artifact that ships in the repo is well-formed and reproducible from its own
 *      coefficients;
 *   9. the balanced corpus builder measures a move the SAME way in both directions (a corpus of
 *      battles that used it, and a corpus of battles that did not), merges its halves without
 *      trusting a stored label, and never re-downloads a replay it already has;
 *  10. the reported AUC is a hold-out over whole BATTLES, not over turns of one: a row-level split
 *      leaves every held-out turn's neighbours in the training set and flatters the fit, so the
 *      grouped split's mechanics are pinned, along with a planted dataset that can only be scored
 *      by leaking a battle's identity across the split.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about win rate on the real ladder. AUC on a synthetic planted model says the fitter
 *   works. The artifact pin in section 8 checks the SHAPE and self-consistency of the committed
 *   fit and that its battle-level held-out AUC is meaningfully above chance, but the corpus it was fitted on
 *   is not in the repo (the replays are third-party content), so the number itself is not
 *   reproducible from a checkout — only re-fittable from a fresh download.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const H = require('./harness.js');
const extractor = require('../tools/extract_training_data.js');
const fitter = require('../tools/fit_weights.js');
const fetcher = require('../tools/fetch_replays.js');

const ST = H.loadAll().ST;

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
function close(name, got, want, tol) {
  const ok = typeof got === 'number' && isFinite(got) && Math.abs(got - want) <= tol;
  return check(name, ok, 'got ' + got + ', want ' + want + ' (+-' + tol + ')');
}
function eq(name, got, want) {
  return check(name, JSON.stringify(got) === JSON.stringify(want),
    'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function throwsWith(name, fn, pattern) {
  try {
    fn();
  } catch (err) {
    return check(name, pattern.test(String((err && err.message) || err)), String((err && err.message) || err));
  }
  return check(name, false, 'it did not throw');
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

/* Deterministic PRNG (mulberry32). Math.random is banned: a flaky suite is a lying suite. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function meanAbs(values, skip) {
  let s = 0, n = 0;
  for (let i = 0; i < values.length; i++) {
    if (skip && skip[i]) continue;
    s += Math.abs(values[i]); n++;
  }
  return n ? s / n : 0;
}
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

/* ================================================================== 1. the AUC */

section('1. AUC-ROC is the rank-sum statistic, ties included');

close('perfect separation scores 1', fitter.auc([1, 2, 3, 4], [0, 0, 1, 1]), 1, 0);
close('a perfectly inverted ranking scores 0', fitter.auc([1, 2, 3, 4], [1, 1, 0, 0]), 0, 0);
close('all-identical scores score exactly 0.5', fitter.auc([1, 1, 1, 1], [1, 1, 0, 0]), 0.5, 0);
/* Hand-computed: scores 0.1/0.2/0.2/0.3/0.4 with labels 0/1/0/1/1 give ranks 1, 2.5, 2.5, 4, 5;
 * the positives own 2.5 + 4 + 5 = 11.5, so AUC = (11.5 - 3*4/2) / (3*2) = 11/12. */
close('a hand-computed fixture with a tie equals 11/12',
  fitter.auc([0.1, 0.2, 0.2, 0.3, 0.4], [0, 1, 0, 1, 1]), 11 / 12, 1e-12);
check('the statistic is undefined (null) with one class', fitter.auc([1, 2], [1, 1]) === null);
close('a single pair is worth 1 or 0', fitter.auc([2, 1], [1, 0]), 1, 0);

/* ================================================= 2. recovery of a planted model */

section('2. the IRLS fitter recovers a model that was planted in the data');

/* 2a — the sharp check, on a width where nothing is hidden: 16 features, 6 of them real. */
(function () {
  const rng = mulberry32(20260101);
  const D = 16, N = 1200;
  const planted = new Array(D).fill(0);
  const picks = { 0: 2.2, 3: -1.9, 6: 1.7, 9: -1.4, 12: 1.2, 15: -1.0 };
  Object.keys(picks).forEach(function (k) { planted[k | 0] = picks[k]; });
  const X = [], y = [];
  for (let i = 0; i < N; i++) {
    const x = new Array(D);
    let z = 0;
    for (let j = 0; j < D; j++) { x[j] = (rng() - 0.5) * 1.5; z += planted[j] * x[j]; }
    X.push(x);
    y.push(rng() < sigmoid(z) ? 1 : 0);
  }
  const model = fitter.fitLogistic(X, y, { lambda: 0.5, maxIter: 40, tol: 1e-6 });
  const cos = cosine(model.coef, planted);
  check('16 dims: every planted coefficient keeps its sign',
    Object.keys(picks).every(function (k) {
      return Math.sign(model.coef[k | 0]) === Math.sign(planted[k | 0]);
    }), JSON.stringify(model.coef));
  check('16 dims: the recovered direction is the planted direction (cosine >= 0.95)',
    cos >= 0.95, 'cosine ' + cos.toFixed(4));
  const trainAuc = fitter.auc(X.map(function (x) { return fitter.scoreOf(model, x); }), y);
  /* The planted linear predictor has sd ~1.7 here, which puts the BAYES AUC near 0.89; the
   * threshold is set below that with room for sampling noise rather than at the estimate. */
  check('16 dims: the fitted model predicts its own training labels (AUC >= 0.82)',
    typeof trainAuc === 'number' && trainAuc >= 0.82, 'AUC ' + trainAuc);
  check('16 dims: the fit converged', model.converged === true, 'iterations ' + model.iterations);
})();

/* 2b — the real contract: 128 dims through run(), which also exercises the hold-out split,
 * mapToSpec and the report shape. Coefficients here are inherently loose because 122 of the
 * 128 dims are pure noise, each carrying a coefficient of order SE = 7.7/sqrt(n); that is why
 * the sharp direction check lives in 2a and this one leans on AUC, signs and scale. */
const PLANTED = { 0: 2.5, 12: -2.0, 40: 1.8, 76: -1.6, 100: 1.5, 120: -1.4 };
const planted128 = new Array(128).fill(0);
Object.keys(PLANTED).forEach(function (k) { planted128[k | 0] = PLANTED[k]; });
const plantedFlags = planted128.map(function (v) { return v !== 0; });
let report = null;
(function () {
  const rng = mulberry32(20260102);
  const N = 3000;
  const rows = [];
  for (let i = 0; i < N; i++) {
    const x = new Array(128);
    let z = 0;
    for (let j = 0; j < 128; j++) { x[j] = (rng() - 0.5) * 1.4; z += planted128[j] * x[j]; }
    rows.push({ x: x, y: rng() < sigmoid(z) ? 1 : 0 });
  }
  report = fitter.run({ rows: rows }, { lambda: 0.5, holdout: 5, maxIter: 30, tol: 1e-6 });
})();

check('128 dims: the report carries 128 coefficients plus an intercept', report.weights128.length === 128 && isFinite(report.intercept));
check('128 dims: the split is 4/5 train, 1/5 test',
  report.trainSamples === 2400 && report.testSamples === 600, report.trainSamples + '/' + report.testSamples);
check('128 dims: TEST AUC is well above chance (>= 0.8)',
  typeof report.aucTest === 'number' && report.aucTest >= 0.8, 'test AUC ' + report.aucTest);
check('128 dims: train and test AUC agree within 0.08 (no overfit collapse)',
  Math.abs(report.aucTrain - report.aucTest) <= 0.08, report.aucTrain + ' vs ' + report.aucTest);
check('128 dims: every planted coefficient keeps its sign',
  Object.keys(PLANTED).every(function (k) {
    return Math.sign(report.weights128[k | 0]) === Math.sign(PLANTED[k]);
  }), JSON.stringify(PLANTED) + ' -> ' + JSON.stringify(report.weights128));
/* meanAbs(values, skip): the planted mean skips the noise dims and vice versa — the two must
 * partition the vector, or this check would compare a group against itself. */
const noiseFlags = plantedFlags.map(function (v) { return !v; });
const plantedMean = meanAbs(report.weights128, noiseFlags);
const noiseMean = meanAbs(report.weights128, plantedFlags);
check('128 dims: the two groups partition the coefficient vector',
  plantedMean > 0 && noiseMean >= 0 &&
  plantedFlags.filter(Boolean).length === 6 && noiseFlags.filter(Boolean).length === 122);
check('128 dims: planted dims dominate the noise dims by at least 4x',
  plantedMean >= 4 * noiseMean, 'planted ' + plantedMean.toFixed(4) + ' vs noise ' + noiseMean.toFixed(4));
check('128 dims: the recovered vector points at the planted one (cosine >= 0.6)',
  cosine(report.weights128, planted128) >= 0.6, 'cosine ' + cosine(report.weights128, planted128).toFixed(4));
check('128 dims: the spec carries every config group',
  !!report.spec && report.spec.status.length === 12 && report.spec.boosts.length === 12 &&
  report.spec.hazards.length === 8 && report.spec.trickRoom.length === 8 &&
  report.spec.items.length === 12 && report.spec.macro.length === 16 &&
  [report.spec.hp, report.spec.fainted, report.spec.threat, report.spec.threatActive].every(isFinite));
check('128 dims: weightsFull is the intercept followed by the 128 coefficients',
  report.weightsFull.length === 129 && report.weightsFull[0] === report.intercept &&
  report.weightsFull.slice(1).every(function (v, i) { return v === report.weights128[i]; }));
/* `converged` is the claim being made. A literal iteration ceiling would fail a future solver that
 * legitimately needs more steps to reach the same tolerance, which is the opposite of the guard's
 * intent, so only the flag is asserted (the iteration count is reported for the reader). */
check('128 dims: the fit converged rather than hitting the cap',
  report.converged === true, 'iterations ' + report.iterations + ', converged ' + report.converged);

/* =========================================================== 3. the hold-out split */

section('3. the hold-out split is deterministic, disjoint and complete');

const split = fitter.splitIndices(10, 5);
eq('n=10, k=5 holds out every 5th index', split.test, [0, 5]);
eq('...and keeps the rest, in order', split.train, [1, 2, 3, 4, 6, 7, 8, 9]);
eq('the split is stable across calls', fitter.splitIndices(10, 5).train, split.train);
(function () {
  const s = fitter.splitIndices(37, 5);
  const all = s.train.concat(s.test).slice().sort(function (a, b) { return a - b; });
  const complete = all.length === 37 && all.every(function (v, i) { return v === i; });
  const disjoint = s.train.every(function (v) { return s.test.indexOf(v) === -1; });
  check('n=37: the union is exactly 0..36 (complete)', complete, all.length + ' indices');
  check('n=37: train and test do not overlap (disjoint)', disjoint);
  check('n=37: exactly ceil(37/5) = 8 rows are held out', s.test.length === 8, String(s.test.length));
  check('a silly k (1) is clamped to 2 instead of holding out every row',
    fitter.splitIndices(10, 1).holdout === 2 && fitter.splitIndices(10, 1).test.length === 5,
    JSON.stringify(fitter.splitIndices(10, 1)));
})();

/* ============================================================= 4. mapToSpec */

section('4. mapToSpec maps the coefficient groups, diagonal exclusion included');

const ramp = [];
for (let i = 0; i < 128; i++) ramp.push(i);
const specRamp = fitter.mapToSpec(ramp);
close('ramp: hp = mean(0..5) - mean(6..11)', specRamp.hp, 2.5 - 8.5, 0);
close('ramp: fainted = mean(18..23) - mean(12..17)', specRamp.fainted, 20.5 - 14.5, 0);
eq('ramp: status is dims 24..35 verbatim', specRamp.status, [24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]);
eq('ramp: boosts is dims 36..47 verbatim', specRamp.boosts, [36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47]);
eq('ramp: hazards is dims 48..55 verbatim', specRamp.hazards, [48, 49, 50, 51, 52, 53, 54, 55]);
eq('ramp: trickRoom is dims 56..63 verbatim', specRamp.trickRoom, [56, 57, 58, 59, 60, 61, 62, 63]);
eq('ramp: items is dims 64..75 verbatim', specRamp.items, [64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75]);
eq('ramp: macro is dims 112..127 verbatim', specRamp.macro,
  [112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127]);
/* The ramp alone cannot prove the exclusion (its diagonal mean equals the all-inclusive mean),
 * so the diagonal and the off-diagonals are isolated by two further vectors. */
close('ramp: threat is 93.5 (a linear ramp cannot separate the two groups)', specRamp.threat, 3366 / 36, 1e-9);
close('ramp: threatActive is the mean of the six diagonal cells', specRamp.threatActive, 561 / 6, 1e-9);

const diagOnly = new Array(128).fill(0);
for (let i = 0; i < 6; i++) diagOnly[76 + i * 7] = 2;
const specDiag = fitter.mapToSpec(diagOnly);
close('diagonal-only: threatActive picks up the six active-vs-active cells', specDiag.threatActive, 2, 0);
close('diagonal-only: threat ignores them completely', specDiag.threat, 0, 0);

const offOnly = new Array(128).fill(0);
offOnly[77] = 6;
const specOff = fitter.mapToSpec(offOnly);
close('off-diagonal-only: threat is that cell over the 30 off-diagonals', specOff.threat, 6 / 30, 1e-12);
close('off-diagonal-only: threatActive stays zero', specOff.threatActive, 0, 0);

throwsWith('a 127-long coefficient vector is refused', function () { fitter.mapToSpec(new Array(127).fill(0)); }, /128/);

/* ============================================================ 5. the extractor */

section('5. the extractor turns a replay into labelled 128D rows, deterministically');

const LOG = [
  '>battle-gen9nationaldexou-test',
  '|init|[Gen 9] National Dex',
  '|player|p1|Ash|1|1000',
  '|player|p2|Gary|2|1000',
  '|teamsize|p1|1',
  '|teamsize|p2|1',
  '|gametype|singles',
  '|gen|9',
  '|tier|[Gen 9] National Dex',
  '|clearpoke',
  '|poke|p1|Pikachu, L50, M|',
  '|poke|p2|Charizard, L50, M|',
  '|teampreview',
  '|start',
  '|switch|p1a: Pikachu|Pikachu, L50, M|100/100',
  '|switch|p2a: Charizard|Charizard, L50, M|100/100',
  '|turn|1',
  '|move|p1a: Pikachu|Tackle|p2a: Charizard',
  '|-damage|p2a: Charizard|80/100',
  '|turn|2',
  '|move|p2a: Charizard|Ember|p1a: Pikachu',
  '|-damage|p1a: Pikachu|70/100',
  '|turn|3',
  '|move|p1a: Pikachu|Tackle|p2a: Charizard',
  '|-damage|p2a: Charizard|0 fnt',
  '|faint|p2a: Charizard',
  '|win|Ash'
];

const api = { ST: ST };
const p1Won = extractor.extractDataset([{ winner: 'p1', log: LOG }], api);
check('three turn headers with both actives alive yield three rows', p1Won.samples === 3, String(p1Won.samples));
check('the dataset declares its dimensionality', p1Won.dimensions === 128, String(p1Won.dimensions));
check('every row is a 128-float vector', p1Won.rows.every(function (r) {
  return r.x.length === 128 && r.x.every(function (v) { return typeof v === 'number' && isFinite(v); });
}));
check('p1 winning labels every row 1', p1Won.rows.every(function (r) { return r.y === 1; }),
  JSON.stringify(p1Won.rows.map(function (r) { return r.y; })));
check('the provenance names the perspective it labelled from', p1Won.replays[0].mySide === 'p1' &&
  p1Won.replays[0].label === 1 && p1Won.replays[0].turns === 3);
eq('the run is byte-identical on a second pass',
  JSON.stringify(extractor.extractDataset([{ winner: 'p1', log: LOG }], api)), JSON.stringify(p1Won));

const p2Won = extractor.extractDataset([{ winner: 'p2', log: LOG }], api);
check('the same log with p2 winning labels every row 0',
  p2Won.samples === 3 && p2Won.rows.every(function (r) { return r.y === 0; }),
  JSON.stringify(p2Won.rows.map(function (r) { return r.y; })));

throwsWith('a replay with an unusable winner is refused', function () {
  extractor.extractDataset([{ winner: 'draw', log: LOG }], api);
}, /winner/);
throwsWith('an unknown corpus shape is refused', function () {
  extractor.extractDataset({ notes: 'nope' }, api);
}, /array of replays/);

/* ======================================================= 6. degenerate inputs */

section('6. degenerate datasets are refused, never fitted to NaN');

const oneRow = function (y) {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ x: new Array(128).fill(i / 20), y: y });
  return rows;
};
throwsWith('a single-class dataset is refused', function () { fitter.run(oneRow(1), {}); }, /single class/i);
throwsWith('an empty dataset is refused', function () { fitter.run([], {}); }, /empty/i);
throwsWith('a ragged matrix is refused', function () {
  fitter.fitLogistic([[1, 2], [3]], [0, 1]);
}, /expected 2/);
throwsWith('a row with the wrong width is refused', function () {
  fitter.run({ rows: [{ x: new Array(128).fill(0.1), y: 1 }, { x: new Array(127).fill(0.2), y: 0 }] }, {});
}, /expected 128/);
throwsWith('a non-finite feature is refused', function () {
  const rows = oneRow(0);
  rows[3].x[7] = NaN;
  rows[3].y = 1;
  fitter.run(rows, {});
}, /finite/i);

(function () {
  const rng = mulberry32(31337);
  const X = [], y = [];
  for (let i = 0; i < 300; i++) {
    const t = i / 299;
    X.push([t]);
    y.push(rng() < sigmoid(4 * (t - 0.5)) ? 1 : 0);
  }
  const model = fitter.fitLogistic(X, y, { lambda: 0.1, maxIter: 50 });
  check('a one-feature fit still converges to a finite, positive slope',
    model.coef.length === 1 && isFinite(model.coef[0]) && model.coef[0] > 0 && isFinite(model.intercept),
    JSON.stringify(model.coef));
  check('a zero-signal single-feature dataset does not produce NaN',
    isFinite(fitter.fitLogistic([[1], [1], [1], [2], [2], [2]], [0, 0, 1, 1, 0, 1], {}).coef[0]));
})();

/* ====================================================== 7. the corpus downloader */

section('7. the downloader labels replays from the log, and refuses what it cannot label');

/* The seats are listed p2-first on purpose: an implementation that took the first `|player|` line
 * to be p1 would answer 'p1' here, and every replay whose players swapped seats would be
 * mislabelled in a way no downstream check could see. */
const SWAPPED_SEATS = [
  '|player|p2|Ash|1|1000',
  '|player|p1|Zoe|2|1000',
  '|start',
  '|win|Ash'
].join('\n');
eq('the winner is resolved through the log\'s own seat table, not by order',
  fetcher.winnerOf({ log: SWAPPED_SEATS }), 'p2');
eq('...and the same log handed over as an array of lines resolves identically',
  fetcher.winnerOf({ log: SWAPPED_SEATS.split('\n') }), 'p2');
eq('...while the first-listed seat can still be the winner',
  fetcher.winnerOf({ log: ['|player|p1|Zoe|', '|player|p2|Ash|', '|win|Zoe'].join('\n') }), 'p1');
eq('a log with no |win| line is left unlabelled',
  fetcher.winnerOf({ log: ['|player|p1|Ash|', '|start'].join('\n') }), null);
eq('a winner who is in neither seat is refused, never guessed',
  fetcher.winnerOf({ log: ['|player|p1|Ash|', '|player|p2|Gary|', '|win|Nobody'].join('\n') }), null);
eq('case and surrounding whitespace do not matter',
  fetcher.winnerOf({ log: ['|player|p1| Ash |1|1000', '|player|p2|Gary|2|1000', '|win|ash'].join('\n') }), 'p1');
eq('an empty replay is unlabelled rather than a crash', fetcher.winnerOf({}), null);

eq('a |win| with no player table at all is refused',
  fetcher.winnerOf({ log: '|win|Ash' }), null);

const SEARCH_HITS = [
  { id: 'a', rating: 1500 },
  { id: 'b', rating: 1200 },
  { id: '', rating: 1600 },        // no id: cannot be downloaded
  { rating: 1900 },                // no id: cannot be downloaded
  { id: 'c', rating: 1300 }
];
eq('the floor keeps the hits at or above it, in search order',
  fetcher.filterByRating(SEARCH_HITS, 1300).map(function (h) { return h.id; }), ['a', 'c']);
eq('...and the floor itself is inclusive',
  fetcher.filterByRating([{ id: 'x', rating: 1300 }], 1300).length, 1);
eq('a hit with no id is dropped (there is nothing to fetch)',
  fetcher.filterByRating(SEARCH_HITS, 0).length, 3);
eq('a missing or unusable floor means 0, not "drop everything"',
  fetcher.filterByRating([{ id: 'a', rating: 0 }, { id: 'b' }], undefined).map(function (h) { return h.id; }),
  ['a', 'b']);
eq('...and a NaN floor behaves the same way',
  fetcher.filterByRating([{ id: 'a' }], NaN).length, 1);
eq('a non-array candidate list is an empty list, not a crash', fetcher.filterByRating(null, 1000), []);

const LABELLED_LOG = ['|player|p1|Ash|', '|player|p2|Gary|', '|start', '|win|Gary'].join('\n');
eq('an unlabelled replay produces no corpus entry at all',
  fetcher.corpusOf('id-1', 1500, { log: ['|player|p1|Ash|', '|start'].join('\n') }), null);
const corpusEntry = fetcher.corpusOf('gen9nationaldex-1', 1520, {
  id: 'gen9nationaldex-1', rating: 1510, players: ['Ash', 'Gary', 'third'], log: LABELLED_LOG
});
eq('the entry carries exactly the corpus fields, and nothing else',
  Object.keys(corpusEntry).sort(), ['id', 'log', 'players', 'rating', 'winner'].sort());
eq('...the search hit\'s rating wins over the payload\'s', corpusEntry.rating, 1520);
eq('...the winner is the seat that actually won', corpusEntry.winner, 'p2');
eq('...the player list is capped at the two seats', corpusEntry.players, ['Ash', 'Gary']);
eq('...and the log is the newline-joined protocol text', corpusEntry.log, LABELLED_LOG);

const fromPayload = fetcher.corpusOf('', undefined, { id: 'gen9nationaldex-2', rating: 1401, log: LABELLED_LOG });
eq('without a hit rating the payload\'s rating is used', fromPayload.rating, 1401);
eq('...and the payload id fills in for a missing hit id', fromPayload.id, 'gen9nationaldex-2');
const crlfEntry = fetcher.corpusOf('c', 1, { log: ['|player|p1|A|', '|player|p2|B|', '|win|A\r'] });
eq('a CRLF line array normalises to the same joined text as a string',
  crlfEntry.log, ['|player|p1|A|', '|player|p2|B|', '|win|A'].join('\n'));

const corpusPayload = fetcher.corpusPayload({ format: 'gen9nationaldex', minRating: 1300 }, [
  { id: 'a', rating: 1500, winner: 'p1', log: 'l' },
  { id: 'b', rating: 1201, winner: 'p2', log: 'l' },
  { id: 'c', rating: 0, winner: 'p1', log: 'l' }
]);
/* The exact key set, not just "the numbers are there": determinism is the reason a re-download is
 * diffable, and a timestamp is exactly the kind of field that would quietly break that. The set
 * also carries HOW the corpus was selected (`sort`, `requireMove`), because a corpus that does not
 * say what it selected for cannot be audited later — and neither field varies with time, so the
 * byte-identical guarantee is untouched. */
eq('the payload reports its exact key set',
  Object.keys(corpusPayload).sort(),
  ['count', 'format', 'minRating', 'ratingHighest', 'ratingLowest', 'ratingMean', 'replays',
    'requireMove', 'sort', 'source'].sort());
eq('...and says which order it walked and which move it required',
  [corpusPayload.sort, corpusPayload.requireMove], ['newest', null]);
eq('...echoing the required move it was given',
  fetcher.corpusPayload({ format: 'x', minRating: 1400, requireMove: 'Trick Room' }, []).requireMove,
  'trickroom');
check('...and carries no date- or time-shaped key of any kind',
  !Object.keys(corpusPayload).some(function (k) { return /time|date|stamp|fetched|^at$/i.test(k); }),
  Object.keys(corpusPayload).join(','));
eq('the count includes entries that carry no rating', corpusPayload.count, 3);
eq('the rating statistics skip the unrated entry',
  [corpusPayload.ratingLowest, corpusPayload.ratingHighest], [1201, 1500]);
eq('the mean is rounded to a whole rating', corpusPayload.ratingMean, 1351);
eq('the format and the floor are echoed, so a corpus describes itself',
  [corpusPayload.format, corpusPayload.minRating], ['gen9nationaldex', 1300]);
eq('the replays themselves are carried through untouched', corpusPayload.replays.length, 3);
const emptyPayload = fetcher.corpusPayload({ format: 'x', minRating: 1400 }, []);
eq('an empty corpus reports null statistics rather than Infinity',
  [emptyPayload.count, emptyPayload.ratingMean, emptyPayload.ratingLowest, emptyPayload.ratingHighest],
  [0, null, null, null]);

/* `search()` and `searchUser()` are deliberately NOT called: they only answer against the live
 * endpoint, and this suite must stay offline (that boundary is the reason the extractor exists
 * separately). `download()` IS exercised in section 9 — but only behind a stubbed global `fetch`
 * that records its calls, so a fully-cached pass can be proven to make none at all. */

/* ========================================================= 8. the fitted artifact */

section('8. the fitted artifact is well-formed, and reproducible from its own coefficients');

function readJson(rel) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8')) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/* A missing artifact must be a NAMED failure, not a crash at import time. */
const artifactAttempt = readJson('../lib/trained-weights.json');
check('the fitted artifact is on disk', artifactAttempt.ok, artifactAttempt.error);
if (artifactAttempt.ok) {
  const artifact = artifactAttempt.value;
  check('it carries 128 finite coefficients',
    Array.isArray(artifact.weights128) && artifact.weights128.length === 128 &&
    artifact.weights128.every(function (v) { return typeof v === 'number' && isFinite(v); }),
    String(artifact.weights128 && artifact.weights128.length));
  check('...and declares 128 features to match', artifact.features === 128, String(artifact.features));
  check('weightsFull is the intercept followed by exactly those 128 coefficients',
    Array.isArray(artifact.weightsFull) && artifact.weightsFull.length === 129 &&
    artifact.weightsFull[0] === artifact.intercept &&
    artifact.weightsFull.slice(1).every(function (v, i) { return v === artifact.weights128[i]; }));
  check('the sample counts add up',
    artifact.samples === artifact.trainSamples + artifact.testSamples, JSON.stringify({
      samples: artifact.samples, train: artifact.trainSamples, test: artifact.testSamples }));
  check('...and the positive count is inside the sample count',
    artifact.positives > 0 && artifact.positives < artifact.samples, String(artifact.positives));
  check('both AUCs are finite and inside (0, 1]',
    [artifact.aucTrain, artifact.aucTest].every(function (v) {
      return typeof v === 'number' && isFinite(v) && v > 0 && v <= 1;
    }), JSON.stringify([artifact.aucTrain, artifact.aucTest]));
  /* The stored test AUC is a BATTLE-level hold-out (section 10): whole battles are held out, which
   * is why it sits well below the training AUC and below the row-level figure this suite used to
   * carry (0.7975 on the earlier 607-battle corpus, where turns of one battle straddled the split;
   * that same corpus reports 0.6472 once the hold-out is grouped). The shipped artifact — 3,712
   * battles — stores 0.7513 train / 0.7011 held-out. The floor sits under the measured value: a
   * re-fit far below it means the corpus is too small or mislabelled, which is worth failing a
   * build over rather than shipping quietly. */
  check('the held-out AUC is meaningfully above chance (>= 0.6)',
    artifact.aucTest >= 0.6, 'test AUC ' + artifact.aucTest);
  check('...and it was taken over whole battles, not over turns of one',
    artifact.groupedHoldout === true, JSON.stringify({ groupedHoldout: artifact.groupedHoldout,
      holdoutBattles: artifact.holdoutBattles }));
  /* The grouped hold-out needs a usable provenance map; `provenanceIgnored` is how the fitter says
   * it silently fell back to the row-level split. An artifact that carries them can be trusted to
   * be the battle-level number it claims to be. */
  check('...with a provenance the fitter could actually group',
    artifact.provenanceIgnored === false,
    JSON.stringify({ provenanceIgnored: artifact.provenanceIgnored }));
  check('...so it is not expected to match the training AUC',
    artifact.aucTest <= artifact.aucTrain, artifact.aucTest + ' vs ' + artifact.aucTrain);
  check('a fit that reports itself unconverged also records how far it had to go',
    artifact.converged === true || (typeof artifact.lastStep === 'number' && isFinite(artifact.lastStep)),
    JSON.stringify({ converged: artifact.converged, lastStep: artifact.lastStep }));

  const configWeights = ST.configGet ? ST.configGet('evaluator.weights', null) : null;
  check('the artifact carries a spec shaped like evaluator.weights',
    !!artifact.spec && !!configWeights &&
    JSON.stringify(Object.keys(artifact.spec).sort()) === JSON.stringify(Object.keys(configWeights).sort()),
    JSON.stringify(artifact.spec && Object.keys(artifact.spec).sort()) + ' vs ' +
    JSON.stringify(configWeights && Object.keys(configWeights).sort()));
  check('...with the group widths the config check also pins',
    !!artifact.spec && artifact.spec.status.length === 12 && artifact.spec.boosts.length === 12 &&
    artifact.spec.hazards.length === 8 && artifact.spec.trickRoom.length === 8 &&
    artifact.spec.items.length === 12 && artifact.spec.macro.length === 16 &&
    [artifact.spec.hp, artifact.spec.fainted, artifact.spec.threat, artifact.spec.threatActive]
      .every(function (v) { return typeof v === 'number' && isFinite(v); }),
    JSON.stringify(artifact.spec));
  /* The spec is derived, so it must equal its own derivation: a hand-edited spec would drift from
   * the coefficients it claims to summarise. */
  const derived = fitter.mapToSpec(artifact.weights128);
  eq('the stored spec is exactly what mapToSpec computes from the stored coefficients',
    artifact.spec, derived);
  /* NOT asserted: that these equal the live evaluator.weights. Adopting a fitted vector is a
   * reviewed step (the fitter writes an artifact and never edits src/config.js), so a check that
   * forbade the adoption would fight the feature it exists to enable. */
} else {
  check('the artifact is required for the shape checks', false, 'lib/trained-weights.json is missing');
}

/* ==================================================== 9. the balanced corpus builder */

section('9. the corpus builder: two halves, a merge, and a preload cache');

/* A rare move cannot fill a corpus out of the recent ladder window on its own, so the builder runs
 * twice — once requiring the move and once excluding it — and merges the halves. Three properties
 * make that safe, and each is pinned here: both directions are the SAME measure (`keepByMoves`),
 * the merge re-labels every row from its own log instead of trusting the half it came from, and the
 * replays the harvest pass already downloaded are re-used rather than fetched a second time. */

const WIN_P1_LOG = ['|player|p1|Zoe|', '|player|p2|Ash|', '|win|Zoe'].join('\n');
const WIN_P2_LOG = ['|player|p1|Zoe|', '|player|p2|Ash|', '|win|Ash'].join('\n');
const TR_P1_LOG = ['|player|p1|Zoe|', '|player|p2|Ash|',
  '|move|p1a: Pikachu|Trick Room|p1a: Pikachu', '|win|Zoe'].join('\n');
const TR_P2_LOG = ['|player|p1|Zoe|', '|player|p2|Ash|',
  '|move|p2a: Grimmsnarl|Trick Room|p2a: Grimmsnarl', '|win|Ash'].join('\n');
const NO_TR_LOG = ['|player|p1|Zoe|', '|player|p2|Ash|',
  '|move|p1a: Pikachu|Tackle|p2a: Grimmsnarl', '|win|Ash'].join('\n');

/* --- the log's own seat table, which is what attributes a move to a player --- */

const SEATS_LOG = ['|player|p2|Ash|1|1000', '|player|p1|Zoe|2|1000', '|start'].join('\n');
const seats = fetcher.seatsOf({ log: SEATS_LOG });
eq('the seat table is the log\'s own |player| lines, whichever order they appear in',
  Object.keys(seats).sort().map(function (k) { return [k, seats[k]]; }), [['p1', 'Zoe'], ['p2', 'Ash']]);
eq('...and the same lines as an array resolve identically',
  Object.keys(fetcher.seatsOf({ log: SEATS_LOG.split('\n') })).sort(), ['p1', 'p2']);
eq('a side the log never declared has no seat', fetcher.seatsOf({ log: '|player|p1|Zoe|' }).p2, undefined);
eq('a player line with no name does not invent one', fetcher.seatsOf({ log: '|player|p1||' }), {});
eq('a seat id the log did declare is kept, whatever it is called',
  fetcher.seatsOf({ log: '|player|p3|Cara|' }).p3, 'Cara');
eq('an empty replay has no seats at all', fetcher.seatsOf({}), {});
eq('CRLF line endings trim to the same names',
  fetcher.seatsOf({ log: '|player|p1|Zoe|\r\n|player|p2|Ash|\r\n' }).p2, 'Ash');

/* --- which SIDE clicked the move (the harvest's whole lead) --- */

eq('the side that clicked the move is attributed',
  fetcher.sidesUsingMove({ log: TR_P1_LOG }, 'trickroom'), ['p1']);
eq('...and the opponent who merely ate it is not',
  fetcher.sidesUsingMove({ log: TR_P1_LOG }, 'trickroom').indexOf('p2'), -1);
eq('the move id is compared case- and space-insensitively',
  fetcher.sidesUsingMove({ log: '|move|p1a: X|Trick Room|p1a: X' }, 'trickroom'), ['p1']);
eq('the side that clicked SECOND still comes second',
  fetcher.sidesUsingMove({ log: ['|move|p2a: Y|Trick Room|p2a: Y',
    '|move|p1a: X|Trick Room|p1a: X'].join('\n') }, 'trickroom'), ['p2', 'p1']);
eq('a back-slot (p1b: / p2c:) mon attributes to its side',
  fetcher.sidesUsingMove({ log: '|move|p2c: Y|Trick Room|p2c: Y' }, 'trickroom'), ['p2']);
eq('|-singlemove| counts as clicking it too',
  fetcher.sidesUsingMove({ log: '|-singlemove|p1a: X|Trick Room|' }, 'trickroom'), ['p1']);
const FIELD_ONLY_LOG = '|-fieldstart|move: Trick Room|[of] p1a: X';
eq('a field effect alone has no side to attribute',
  fetcher.sidesUsingMove({ log: FIELD_ONLY_LOG }, 'trickroom'), []);
check('...even though that same log still counts as containing the move',
  fetcher.hasMoveInLog({ log: FIELD_ONLY_LOG }, 'trickroom') === true);
eq('a different move on the same line shape attributes nobody',
  fetcher.sidesUsingMove({ log: '|move|p1a: X|Tackle|p2a: Y' }, 'trickroom'), []);
eq('a log that never shows the move attributes nobody',
  fetcher.sidesUsingMove({ log: WIN_P2_LOG }, 'trickroom'), []);
eq('an empty move id attributes nobody', fetcher.sidesUsingMove({ log: TR_P1_LOG }, ''), []);

/* --- and which PLAYERS those sides are --- */

eq('the player is resolved through the seat that used the move',
  fetcher.playersUsingMove([{ log: TR_P2_LOG }], 'trickroom'), ['Ash']);
eq('half a corpus that filtered the move out names nobody',
  fetcher.playersUsingMove([{ log: WIN_P2_LOG }, { log: TR_P2_LOG }], 'trickroom'), ['Ash']);
eq('the same player in two replays is followed once, keeping the first spelling',
  fetcher.playersUsingMove([
    { log: ['|player|p1|Ash|', '|player|p2|Gary|', '|move|p1a: X|Trick Room|'].join('\n') },
    { log: ['|player|p1|ASH|', '|player|p2|Gary|', '|move|p1a: X|Trick Room|'].join('\n') }
  ], 'trickroom'), ['Ash']);
eq('...and both seats are named when both of them clicked it',
  fetcher.playersUsingMove([{ log: ['|player|p1|Zoe|', '|player|p2|Ash|',
    '|move|p1a: X|Trick Room|', '|move|p2a: Y|Trick Room|'].join('\n') }], 'trickroom'),
  ['Zoe', 'Ash']);
eq('a side with no declared seat is skipped, never invented',
  fetcher.playersUsingMove([{ log: '|move|p2a: Y|Trick Room|' }], 'trickroom'), []);
eq('the order is the order the replays named them in',
  fetcher.playersUsingMove([
    { log: ['|player|p1|First|', '|move|p1a: X|Trick Room|'].join('\n') },
    { log: ['|player|p1|Second|', '|move|p1a: X|Trick Room|'].join('\n') }
  ], 'trickroom'), ['First', 'Second']);
eq('a non-array replay list names nobody', fetcher.playersUsingMove(null, 'trickroom'), []);

/* --- the format label the harvest filters a player's other formats by --- */

eq('the label is taken from the first hit that carries one',
  fetcher.labelOf([{ id: 'a' }, { format: '[Gen 9] National Dex' }]), '[Gen 9] National Dex');
eq('...which is the first hit when it has one', fetcher.labelOf([{ format: 'A' }, { format: 'B' }]), 'A');
eq('...and an empty label does not win over a later real one',
  fetcher.labelOf([{ format: '' }, { format: 'B' }]), 'B');
eq('no hits means no label', fetcher.labelOf([]), '');
eq('a non-array means no label', fetcher.labelOf(null), '');

/* --- both halves are the same measure, in opposite directions --- */

check('with no move given, nothing is filtered at all', fetcher.keepByMoves(null, null) === null);
check('...and an empty id is the same as no move', fetcher.keepByMoves('', undefined) === null);
const keepTr = fetcher.keepByMoves('trickroom', null);
const dropTr = fetcher.keepByMoves(null, 'trickroom');
const keepTrDropTackle = fetcher.keepByMoves('trickroom', 'tackle');
check('requiring a move keeps a log that clicked it', keepTr({ log: TR_P2_LOG }) === true);
check('requiring a move drops a log that did not', keepTr({ log: NO_TR_LOG }) === false);
check('excluding a move keeps a log that did not click it', dropTr({ log: NO_TR_LOG }) === true);
check('excluding a move drops a log that did', dropTr({ log: TR_P2_LOG }) === false);
check('both at once: the required move must be there and the excluded one must not',
  keepTrDropTackle({ log: TR_P2_LOG }) === true &&
  keepTrDropTackle({ log: ['|move|p1a: X|Trick Room|', '|move|p2a: Y|Tackle|'].join('\n') }) === false);

/* --- merging the halves into the one file the extractor eats --- */

const halfOne = { replays: [
  { id: 'dup', rating: 1800, winner: 'p1', log: WIN_P1_LOG },
  { id: 'tie-a', rating: 1500, winner: 'p1', log: WIN_P1_LOG },
  { id: 'wrong', rating: 1600, winner: 'p1', log: WIN_P2_LOG },      // stored label contradicts the log
  { id: 'unlabelled', rating: 1999, winner: 'p1', log: '|player|p1|Zoe|' }
] };
const halfTwo = { replays: [
  { id: 'dup', rating: 1900, winner: 'p2', log: WIN_P2_LOG },        // same battle, higher rating
  { id: 'tie-b', rating: 1500, winner: 'p1', log: WIN_P1_LOG },
  { id: 'low', rating: 1200, winner: 'p1', log: WIN_P1_LOG }
] };
const merged = fetcher.mergeCorpora([halfOne, halfTwo], { minRating: 1400 });
eq('the merge is rating-descending, and a tie keeps the input order',
  merged.map(function (r) { return r.id; }), ['dup', 'wrong', 'tie-a', 'tie-b']);
eq('a duplicate id collapses to the FIRST half\'s row', merged[0].rating, 1800);
eq('...and that row keeps its own log\'s verdict', merged[0].winner, 'p1');
eq('a row whose stored winner contradicts its log is re-labelled from the log',
  merged.filter(function (r) { return r.id === 'wrong'; })[0].winner, 'p2');
check('a row below the floor is dropped', !merged.some(function (r) { return r.id === 'low'; }));
check('a row whose log cannot label it is dropped',
  !merged.some(function (r) { return r.id === 'unlabelled'; }));
eq('a single payload (not an array of them) is accepted',
  fetcher.mergeCorpora({ replays: halfOne.replays }, {}).length, 3);
eq('a payload with no replays array is not a crash',
  fetcher.mergeCorpora([null, {}, { replays: null }], {}), []);
/* The merged rows must be corpus entries, not raw input rows: the extractor labels from
 * `winner`, and a raw hit carries none. */
eq('the merged rows are corpus entries, not raw search hits',
  Object.keys(merged[0]).sort(), ['id', 'log', 'players', 'rating', 'winner']);

/* --- the preload cache: a replay already downloaded is never fetched twice --- */

/* This is the one place the suite calls `download`, and it stays offline: the global `fetch` is
 * replaced by a recorder that answers from a synthetic payload, and the FIRST pass keeps every
 * candidate in the cache, so the recorded call count must be exactly zero. The stub is restored
 * before anything else runs, whatever happens. */
function pinPreloadCache() {
  const savedFetch = global.fetch;
  const calls = [];
  const stub = function (url) {
    calls.push(String(url));
    return Promise.resolve({
      ok: true,
      json: function () {
        return Promise.resolve({ id: 'from-the-network', rating: 1750, players: ['Zoe', 'Ash'], log: TR_P2_LOG });
      }
    });
  };
  global.fetch = stub;
  if (global.fetch !== stub) {
    /* Refusing to run beats running against the live endpoint: this suite must never phone home. */
    global.fetch = savedFetch;
    check('the fetch stub could be installed for the cache pin', false,
      'global.fetch is not assignable here');
    return Promise.resolve();
  }

  const cached = {
    'cached-tr': fetcher.corpusOf('cached-tr', 1900, { log: TR_P1_LOG }),
    'cached-plain': fetcher.corpusOf('cached-plain', 1850, { log: NO_TR_LOG }),
    'cached-tr2': fetcher.corpusOf('cached-tr2', 1800, { log: TR_P2_LOG })
  };
  const candidates = [
    { id: 'cached-tr', rating: 1900 },
    { id: 'cached-plain', rating: 1850 },
    { id: 'cached-tr2', rating: 1800 }
  ];
  const keep = fetcher.keepByMoves('trickroom', null);

  return fetcher.download(candidates, { limit: 3, concurrency: 1, preloaded: cached, keep: keep })
    .then(function (all) {
      eq('a fully cached pass makes no request at all', calls, []);
      eq('...serves the cached rows that pass the filter, in candidate order',
        all.replays.map(function (r) { return r.id; }), ['cached-tr', 'cached-tr2']);
      eq('...counts every cached id it looked at', all.skipped.preloaded, 3);
      eq('...counts the cached row the filter rejects', all.skipped.filtered, 1);
      eq('...and attempts nothing over the network', all.attempted, 0);

      return fetcher.download([{ id: 'uncached', rating: 1750 }, { id: 'cached-tr2', rating: 1800 }],
        { limit: 2, concurrency: 1, preloaded: cached, keep: keep });
    })
    .then(function (mixed) {
      eq('in a mixed pass, only the id that was not cached is fetched', calls.length, 1);
      check('...and it is fetched from the replay endpoint by its id',
        calls[0] === 'https://replay.pokemonshowdown.com/uncached.json', calls[0]);
      eq('...while the cached id of the same pass is re-used', mixed.skipped.preloaded, 1);
      eq('...and both rows appear, in candidate order',
        mixed.replays.map(function (r) { return r.id; }), ['uncached', 'cached-tr2']);
      eq('the fetched row is labelled from its own payload', mixed.replays[0].winner, 'p2');
      eq('...and carries the candidate hit\'s rating', mixed.replays[0].rating, 1750);
    })
    .then(function () { global.fetch = savedFetch; }, function (err) {
      global.fetch = savedFetch;
      check('the preload-cache pin ran without throwing', false, String((err && err.message) || err));
    });
}

/* --- the format comes off the replay id, never off the display label --- */

/* A label is a display string, so a SUBSTRING test on it also accepts every sibling format:
 * "[Gen 9] National Dex UU" contains "[Gen 9] National Dex". The replay id carries the exact
 * format, so that is what the harvest now filters on — and the corpus records no format at all, so
 * a sibling that slipped in would be invisible downstream. */
eq('the format id is read off the replay ids',
  fetcher.formatIdOf([{ id: 'gen9nationaldex-2612345678' }, { id: 'gen9nationaldexuu-1' }]),
  'gen9nationaldex');
eq('...a hit whose id has no numeric suffix yields nothing rather than a guess',
  fetcher.formatIdOf([{ id: 'gen9nationaldex' }]), '');
eq('...neither does a non-numeric one', fetcher.formatIdOf([{ id: 'gen9nationaldex-12ab' }]), '');
check('...and a hit with no id is skipped in favour of one that has it',
  fetcher.formatIdOf([{ format: '[Gen 9] National Dex' }, { id: 'gen9nationaldex-9' }]) === 'gen9nationaldex');
eq('...while an empty or non-array hit list has no format at all',
  [fetcher.formatIdOf([]), fetcher.formatIdOf(null), fetcher.formatIdOf(undefined)], ['', '', '']);

/* --- the rating band, at both ends --- */

eq('the ceiling is inclusive',
  fetcher.filterByRating([{ id: 'a', rating: 1749 }, { id: 'b', rating: 1750 }], 0, 1749)
    .map(function (h) { return h.id; }), ['a']);
eq('...a ceiling of 0, or none at all, means no ceiling',
  [fetcher.filterByRating([{ id: 'a', rating: 2500 }], 0, 0).length,
    fetcher.filterByRating([{ id: 'a', rating: 2500 }], 0).length], [1, 1]);
eq('...and the floor still applies inside a band',
  fetcher.filterByRating([{ id: 'a', rating: 1299 }, { id: 'b', rating: 1300 }], 1300, 1700)
    .map(function (h) { return h.id; }), ['b']);
/* An unrated hit counts as 0 everywhere now, the same way `filterByRating` has always treated it, so
 * a rated corpus cannot absorb one (the harvest path used to test only `typeof rating === 'number'`
 * and let it straight through). */
eq('an unrated hit cannot enter a rated band',
  fetcher.filterByRating([{ id: 'a', rating: 1500 }, { id: 'b' }], 1300, 1700)
    .map(function (h) { return h.id; }), ['a']);

/* --- a move may be given as a name as well as an id --- */

check('a move NAME is normalised before the comparison',
  fetcher.hasMoveInLog({ log: TR_P1_LOG }, 'Trick Room') === true);
check('...so the name form and the id form agree',
  fetcher.hasMoveInLog({ log: TR_P1_LOG }, 'trickroom') ===
  fetcher.hasMoveInLog({ log: TR_P1_LOG }, 'Trick Room'));
check('...and a move the log never shows is still false, never a quiet true',
  fetcher.hasMoveInLog({ log: TR_P1_LOG }, 'Toxic Spikes') === false);

/* --- the flags that drive all of the above --- */

const builderDefaults = fetcher.parseArgs([]);
check('the builder defaults to the recent window with no move filter and no harvest',
  builderDefaults.sort === 'newest' && builderDefaults.requireMove === null &&
  builderDefaults.excludeMove === null && builderDefaults.pool === 0 && builderDefaults.harvest === false,
  JSON.stringify({ sort: builderDefaults.sort, requireMove: builderDefaults.requireMove,
    excludeMove: builderDefaults.excludeMove, pool: builderDefaults.pool, harvest: builderDefaults.harvest }));
check('...and the harvest knobs have defaults of their own',
  builderDefaults.harvestPlayers === 60 && builderDefaults.harvestPages === 3 &&
  builderDefaults.harvestSeed === 0 && builderDefaults.searchConcurrency === 4,
  JSON.stringify({ players: builderDefaults.harvestPlayers, pages: builderDefaults.harvestPages,
    seed: builderDefaults.harvestSeed, concurrency: builderDefaults.searchConcurrency }));
const built = fetcher.parseArgs(['--sort', 'rating', '--min-rating', '1700', '--pool', '5100',
  '--require-move', 'trickroom', '--exclude-move', 'trickroom', '--harvest',
  '--harvest-players', '120', '--harvest-pages', '3', '--harvest-seed', '0', '--search-concurrency', '5']);
check('the two-half flags parse',
  built.sort === 'rating' && built.minRating === 1700 && built.pool === 5100 &&
  built.requireMove === 'trickroom' && built.excludeMove === 'trickroom' && built.harvest === true &&
  built.harvestPlayers === 120 && built.harvestPages === 3 && built.harvestSeed === 0 &&
  built.searchConcurrency === 5, JSON.stringify(built));
check('the band starts with no ceiling of its own', builderDefaults.maxRating === 0,
  String(builderDefaults.maxRating));
check('...and a ceiling parses',
  fetcher.parseArgs(['--max-rating', '1749']).maxRating === 1749,
  String(fetcher.parseArgs(['--max-rating', '1749']).maxRating));
throwsWith('...and an unknown flag is still refused', function () {
  fetcher.parseArgs(['--not-a-flag']);
}, /unknown argument/);
/* A duplicate key in a defaults object silently keeps only the last value, which is exactly how a
 * default drifts without any assertion noticing — one already did. The object itself cannot show
 * it, so the defaults block in the source is read and those keys counted. Every band and selection
 * option is covered, not just the one that drifted. */
const toolSource = fs.readFileSync(path.join(__dirname, '../tools/fetch_replays.js'), 'utf8');
const defaultsBlock = (toolSource.match(/const out = \{[\s\S]*?\n  \};/) || [''])[0];
['sort', 'pool', 'maxRating', 'excludeMove'].forEach(function (key) {
  const declarations = (defaultsBlock.match(new RegExp('\\b' + key + ':', 'g')) || []).length;
  check('the defaults object declares `' + key + '` exactly once',
    defaultsBlock.length > 0 && declarations === 1,
    declarations + ' declaration(s) of ' + key + ' in ' + defaultsBlock.length + ' chars of defaults');
});

/* The harvest's option plumbing is network-bound (it calls `searchUser`), so it cannot be driven
 * offline. This is a WIRING check, not a behavioural one: it reads the call site to prove the two
 * options the harvest once dropped — the rating ceiling and the window's format — are forwarded,
 * and that its discovery pass respects the request budget. Behaviour itself is pinned above, on the
 * functions it calls. */
const harvestBody = (toolSource.match(/function harvestAround[\s\S]*?\n}\n/) || [''])[0];
check('the harvest forwards its rating ceiling and the window\'s format to the player search',
  harvestBody.length > 0 && /maxRating: opts\.maxRating/.test(harvestBody) &&
  /formatId: formatId/.test(harvestBody),
  harvestBody.length + ' chars of harvestAround');
check('...and its discovery pass honours the request budget',
  harvestBody.length > 0 && /maxDownloads: opts\.maxDownloads/.test(harvestBody),
  harvestBody.length + ' chars of harvestAround');

/* ================================================== 10. the honest hold-out ================ */

section('10. the hold-out can be taken over whole battles, not over turns of one battle');

/* Rows are consecutive turns of ONE battle, and neighbouring turns carry nearly the same state and
 * the same label: a row-level split leaves each held-out row's neighbours in the training set. That
 * is not a cosmetic difference — on the 607-battle corpus it reported 0.7975 where a battle-level
 * hold-out reports 0.6472, and the shipped 3,712-battle artifact stores 0.7011 against 0.7513 on
 * its training half — so the mechanics are pinned here, and then a planted dataset shows the leak
 * directly. */

/* --- the mechanics, on a split small enough to check by hand --- */

const GROUP_SIZES = [3, 2, 4, 1, 5];                 // five battles, 15 rows in total
const grouped = fitter.splitIndices(15, 2, GROUP_SIZES);
eq('a grouped split holds out every 2nd battle',
  grouped.test, [0, 1, 2, 5, 6, 7, 8, 10, 11, 12, 13, 14]);
eq('...and trains on the rows of the battles in between', grouped.train, [3, 4, 9]);
eq('...reports how many battles it was given', grouped.battles, 5);
check('...and says it was grouped', grouped.grouped === true, JSON.stringify(grouped));
eq('...with the same k < 2 clamp applied to the battle stride',
  fitter.splitIndices(15, 1, GROUP_SIZES).holdout, 2);
(function () {
  const union = grouped.train.concat(grouped.test).slice().sort(function (a, b) { return a - b; });
  check('the grouped split is complete (each of 0..14 exactly once)',
    union.length === 15 && union.every(function (v, i) { return v === i; }), union.join(','));
  const battleOf = [];
  GROUP_SIZES.forEach(function (size, b) { for (let j = 0; j < size; j++) battleOf.push(b); });
  const trainBattles = grouped.train.map(function (i) { return battleOf[i]; });
  const testBattles = grouped.test.map(function (i) { return battleOf[i]; });
  eq('NO battle is split across train and test',
    trainBattles.filter(function (b) { return testBattles.indexOf(b) !== -1; }), []);
  const seen = {};
  trainBattles.concat(testBattles).forEach(function (b) { seen[b] = true; });
  eq('...and every battle went wholly to one side', Object.keys(seen).sort(), ['0', '1', '2', '3', '4']);
})();

/* --- a groups array that does not cover the rows still yields a usable split --- */

const shortGroups = fitter.splitIndices(10, 5, [3, 2]);
eq('a short groups array still holds out the whole of its first battle',
  shortGroups.test, [0, 1, 2]);
eq('...and the rows it does not account for are trained on rather than dropped',
  shortGroups.train, [3, 4, 5, 6, 7, 8, 9]);
check('...so a short groups array still yields a complete grouped split',
  shortGroups.grouped === true &&
  shortGroups.train.concat(shortGroups.test).slice().sort(function (a, b) { return a - b; })
    .every(function (v, i) { return v === i; }));

/* --- a battle that contributed no rows takes no stride slot --- */

/* The extractor emits a zero-row provenance entry for a battle whose every turn was skipped. If such
 * an entry advanced the stride, the held-out share would drop below 1/k and `battles` would count
 * battles that hold no data — so it is skipped in both respects. */
const withEmptyBattle = fitter.splitIndices(15, 2, [3, 0, 2, 4, 1, 5]);
eq('a zero-row battle does not consume a stride slot (the held-out rows are unchanged)',
  withEmptyBattle.test, grouped.test);
eq('...nor does it disturb the training rows', withEmptyBattle.train, grouped.train);
eq('...and it is not reported as a battle that was held out', withEmptyBattle.battles, 5);

/* --- the row-level contract is preserved, not replaced --- */

const rowSplit = fitter.splitIndices(10, 5);
eq('without groups, every 5th ROW is still held out', rowSplit.test, [0, 5]);
eq('...and the remainder is still trained on', rowSplit.train, [1, 2, 3, 4, 6, 7, 8, 9]);
check('...and that split reports itself as row-level, over no battles',
  rowSplit.grouped === false && rowSplit.battles === 0, JSON.stringify(rowSplit));

/* --- a provenance map that does not add up is refused, not absorbed --- */

/* `run()` groups only when the per-battle counts sum to the rows it is about to fit. A dataset that
 * carries a `replays` array with no per-entry `rows` (a hand-built or older file) used to produce an
 * EMPTY hold-out and throw; a provenance in the wrong order would have quietly grouped one battle's
 * turns under another battle's index. Both now fall back to the row-level split and say so in the
 * report rather than failing loudly in one case and lying in the other. */
(function () {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const x = new Array(128).fill(0);
    x[0] = i % 2 ? 1 : -1;
    rows.push({ x: x, y: i % 2 });
  }
  const opts = { lambda: 0.5, maxIter: 40 };
  const noProvenance = fitter.run({ rows: rows }, opts);
  check('a payload with no provenance at all is an ordinary row split',
    noProvenance.groupedHoldout === false && noProvenance.provenanceIgnored === false,
    JSON.stringify({ grouped: noProvenance.groupedHoldout, ignored: noProvenance.provenanceIgnored }));
  const unusable = fitter.run({ rows: rows, replays: [{}, {}, {}] }, opts);
  check('a provenance with no row counts falls back to the row split instead of throwing',
    unusable.groupedHoldout === false && unusable.provenanceIgnored === true,
    JSON.stringify({ grouped: unusable.groupedHoldout, ignored: unusable.provenanceIgnored }));
  const short = fitter.run({ rows: rows, replays: [{ rows: 4 }, { rows: 4 }] }, opts);
  check('...and so does one whose counts do not add up to the rows being fitted',
    short.groupedHoldout === false && short.provenanceIgnored === true,
    JSON.stringify({ grouped: short.groupedHoldout, ignored: short.provenanceIgnored }));
  const usable = fitter.run({ rows: rows, replays: [{ rows: 6 }, { rows: 0 }, { rows: 6 }] }, opts);
  check('...while a usable provenance really groups, counting only the battles that hold rows',
    usable.groupedHoldout === true && usable.provenanceIgnored === false && usable.holdoutBattles === 2,
    JSON.stringify({ grouped: usable.groupedHoldout, ignored: usable.provenanceIgnored,
      battles: usable.holdoutBattles }));
  check('...with every row on exactly one side of the split in all four cases',
    [noProvenance, unusable, short, usable].every(function (r) {
      return r.trainSamples + r.testSamples === rows.length;
    }),
    JSON.stringify([noProvenance, unusable, short, usable].map(function (r) {
      return [r.trainSamples, r.testSamples];
    })));
})();

/* --- the leak itself, on a planted dataset that can ONLY be scored by cheating --- */

(function () {
  const BATTLES = 60, ROWS_PER_BATTLE = 4, K = 5;
  const rows = [], provenance = [];
  for (let b = 0; b < BATTLES; b++) {
    const label = b % 2;                             // constant within a battle, as an outcome is
    for (let r = 0; r < ROWS_PER_BATTLE; r++) {
      const x = new Array(128).fill(0);
      x[b] = 1;                                      // the battle's own identity: the only signal
      rows.push({ x: x, y: label });
    }
    provenance.push({ rows: ROWS_PER_BATTLE });
  }
  /* Nothing in these rows predicts a label except WHICH battle it came from, so any score above
   * chance on a battle the training set never saw has to come from somewhere it should not. */
  const leaky = fitter.run({ rows: rows }, { lambda: 0.5, holdout: K, maxIter: 40, tol: 1e-6 });
  const honest = fitter.run({ rows: rows, replays: provenance },
    { lambda: 0.5, holdout: K, maxIter: 40, tol: 1e-6 });
  check('a payload whose provenance carries per-battle row counts takes the grouped hold-out',
    honest.groupedHoldout === true && honest.holdoutBattles === BATTLES,
    JSON.stringify({ grouped: honest.groupedHoldout, battles: honest.holdoutBattles }));
  check('...and the same payload with no provenance falls back to the row split',
    leaky.groupedHoldout === false && leaky.holdoutBattles === 0,
    JSON.stringify({ grouped: leaky.groupedHoldout, battles: leaky.holdoutBattles }));
  check('both splits keep every row exactly once',
    leaky.trainSamples + leaky.testSamples === rows.length &&
    honest.trainSamples + honest.testSamples === rows.length,
    JSON.stringify({ leaky: [leaky.trainSamples, leaky.testSamples],
      honest: [honest.trainSamples, honest.testSamples] }));
  eq('the grouped split holds out whole battles (60/5 = 12 battles, 48 rows)', honest.testSamples, 48);
  /* `auc` returns NULL when the held-out rows carry one class only, and `null <= 0.6` is true: a
   * degenerate split would PASS these without the typeof guard, which is the exact failure they
   * exist to catch, so every AUC compared here is required to be a number first. */
  check('the row split scores held-out turns of battles it has already seen (AUC >= 0.9)',
    typeof leaky.aucTest === 'number' && leaky.aucTest >= 0.9, 'row-level test AUC ' + leaky.aucTest);
  check('...while the grouped split cannot recognise a held-out battle (AUC <= 0.6)',
    typeof honest.aucTest === 'number' && honest.aucTest <= 0.6, 'grouped test AUC ' + honest.aucTest);
  check('...so the honest number is the lower one (the leak section 10 closes)',
    typeof honest.aucTest === 'number' && typeof leaky.aucTest === 'number' &&
    honest.aucTest < leaky.aucTest - 0.3,
    'grouped ' + honest.aucTest + ' vs row-level ' + leaky.aucTest);
})();

/* NOT pinned here, because each needs a live walk and this suite never calls `search`:
 *   - the candidate-pool clamp (`opts.pool > 0 ? opts.pool : opts.limit`);
 *   - the walk's termination rule — it must end on a page the ENDPOINT left empty, not on a page
 *     that contributed no candidate after filtering, since a rating band or a move filter routinely
 *     empties a page while thousands of battles remain behind it (that rule is what took the
 *     1600-1749 band from 20 replays to 299 and the 1300-1599 band from 307 to 507);
 *   - a non-array body throwing instead of reading as "the window ended".
 * A check that had to phone home would be worse than the gap it closes. */

/* ================================================================== summary */

function summarize() {
  console.log('\n=== summary ===');
  console.log('checks passed: ' + passed);
  console.log('checks failed: ' + failed);
  console.log('128-dim planted fit: test AUC ' + (report && report.aucTest) +
    ', iterations ' + (report && report.iterations));
  console.log('shipped artifact:  battle-level test AUC ' +
    (artifactAttempt.ok ? artifactAttempt.value.aucTest : 'missing (lib/trained-weights.json)'));
  if (failed) {
    console.log('\nFAILURES:');
    failures.forEach(function (f) { console.log('  x ' + f); });
    process.exit(1);
  }
  console.log('ALL WEIGHT-PIPELINE CHECKS PASSED');
  process.exit(0);
}

/* Section 9's cache pin is the suite's only asynchronous check, so the summary waits for it — and a
 * rejected pin is reported as a named failure instead of exiting with no summary at all. */
pinPreloadCache().then(summarize, function (err) {
  check('the preload-cache pin completed', false, String((err && err.message) || err));
  summarize();
});
