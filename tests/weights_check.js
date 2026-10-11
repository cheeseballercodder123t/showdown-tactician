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
 *      coefficients.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about win rate on the real ladder. AUC on a synthetic planted model says the fitter
 *   works. The artifact pin in section 8 checks the SHAPE and self-consistency of the committed
 *   fit and that its held-out AUC is meaningfully above chance, but the corpus it was fitted on
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
check('128 dims: the fit converged rather than hitting the cap',
  report.converged === true && report.iterations <= 30, 'iterations ' + report.iterations);

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
 * diffable, and a timestamp is exactly the kind of field that would quietly break that. */
eq('the payload reports its exact key set',
  Object.keys(corpusPayload).sort(),
  ['count', 'format', 'minRating', 'ratingHighest', 'ratingLowest', 'ratingMean', 'replays', 'source'].sort());
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

/* `search()` and `download()` are deliberately NOT called: both go through a module-level fetch,
 * and this suite must stay offline (that boundary is the reason the extractor exists separately).
 * The pure halves above are the parts a network stub could not test any better. */

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
  /* 0.936 held out on the committed corpus. A re-fit far below this means the corpus is too small
   * or mislabelled, which is worth failing a build over rather than shipping quietly. */
  check('the held-out AUC is meaningfully above chance (>= 0.7)',
    artifact.aucTest >= 0.7, 'test AUC ' + artifact.aucTest);
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

/* ================================================================== summary */

console.log('\n=== summary ===');
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failed);
console.log('128-dim planted fit: test AUC ' + (report && report.aucTest) +
  ', iterations ' + (report && report.iterations));
console.log('shipped artifact:  test AUC ' +
  (artifactAttempt.ok ? artifactAttempt.value.aucTest : 'missing (lib/trained-weights.json)'));
if (failed) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('ALL WEIGHT-PIPELINE CHECKS PASSED');
process.exit(0);
