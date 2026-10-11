/* Showdown Tactician — tests/cross_check.js
 *
 * Run me with:  node tests/cross_check.js
 *
 * WHAT THIS IS
 *   The regression suite for the cross-feature STUDY: tools/select_cross_features.js (screen
 *   interaction terms on the training half) and the `--crosses` path of tools/fit_weights.js
 *   (refit with those terms appended). The study's verdict was NEGATIVE and nothing was adopted,
 *   so no cross block exists in src/config.js or src/evaluator_128d.js — section 7 pins that.
 *   A negative result is only worth recording if the machinery that produced it still works, so
 *   the screening, the rounding convention, the guard rails and the untouched 128-dim contract
 *   are all pinned here; a future corpus can re-run the study on reviewed code.
 *
 * WHAT IT MUST PROVE
 *   1. the candidate pool is products of the aggregate/active dims only (24..75 and 112..127,
 *      squares included) — the per-slot HP/faint dims and the pairwise threat matrix are
 *      excluded, because "party slot 1 x party slot 4" cannot transfer between battles;
 *   2. a cross term is built by exactly the rounding a Float32Array store performs, appended in
 *      pair order, so a fit and any future engine cross block cannot see different numbers;
 *   3. the screening gain is the training-half log-likelihood gain of a joint two-parameter
 *      Newton fit laid on top of the baseline's own score: it recovers a planted column's slope
 *      and sits near zero for a column that carries nothing;
 *   4. selectCrosses recovers a planted interaction from synthetic battles, is deterministic,
 *      honours k, and REFUSES a candidate the non-zero-share floor excludes — and includes it
 *      once the floor is lifted, so the guard is what did the excluding, not a silent ranking;
 *   5. the `--crosses` path reports features = 128 + N with the extra coefficients in
 *      weightsCross / spec.cross, keeps weights128 as the base block, and leaves the plain
 *      128-dim report unchanged — the shipped artifact format does not move;
 *   6. malformed pair lists, baselines and adversarial payloads are refused with a clear error;
 *   7. the study left no residue in the engine: DIM is still 128, config has no
 *      `evaluator.weights.cross`, and neither source file mentions a cross product.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about the corpus. The measured verdict — the selected 16 crosses scoring 0.7005
 *   projected on the battle-level hold-out against the adopted vector's 0.7049, and the best
 *   four-cross subset's +0.0012 not surviving a paired bootstrap over battles — needs the 3,712
 *   third-party replays, which are not in the repo. What is pinned here is the machinery and the
 *   refusal to adopt its output.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const H = require('./harness.js');
const fitter = require('../tools/fit_weights.js');
const selector = require('../tools/select_cross_features.js');

const ROOT = path.join(__dirname, '..');
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
function eq(name, got, want) {
  return check(name, JSON.stringify(got) === JSON.stringify(want),
    'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function close(name, got, want, tol) {
  const ok = typeof got === 'number' && isFinite(got) && Math.abs(got - want) <= tol;
  return check(name, ok, 'got ' + got + ', want ' + want + ' (+-' + tol + ')');
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
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

/* ---------------------------------------------------------------- the fixture
 * A synthetic corpus whose label depends on a base linear score plus ONE planted interaction:
 * dim 30 (0/1/2) times dim 122 (0/1). The base dims are stated explicitly so the baseline handed
 * to the screener is the true offset, which is the tool's documented contract. The second pair
 * fires on two TRAINING rows only (battle 1 holds out clean, so rows 200 and 201 are train). */
const BASE_DIMS = { 1: 2.0, 12: -1.5, 40: 1.2, 76: -1.0 };
const PLANTED_PAIR = [30, 122];
const PLANTED_SLOPE = 2.5;
const SPARSE_PAIR = [31, 123];
const SPARSE_ROWS = [200, 201];
const BATTLES = 20;
const ROWS_PER_BATTLE = 200;

function baseVector() {
  const v = new Array(128).fill(0);
  Object.keys(BASE_DIMS).forEach(function (k) { v[k | 0] = BASE_DIMS[k]; });
  return v;
}

function buildCorpus() {
  const rng = mulberry32(20261011);
  const base = baseVector();
  const rows = [];
  for (let i = 0; i < BATTLES * ROWS_PER_BATTLE; i++) {
    const x = new Array(128);
    for (let j = 0; j < 128; j++) x[j] = rng() - 0.5;
    x[30] = Math.floor(rng() * 3);                      /* the planted cross's left leg */
    x[122] = rng() < 0.5 ? 0 : 1;                       /* and its right leg */
    x[31] = SPARSE_ROWS.indexOf(i) >= 0 ? 1 : 0;        /* two lucky rows, both winners */
    x[123] = x[31];
    let offset = 0;
    Object.keys(BASE_DIMS).forEach(function (k) { offset += base[k | 0] * x[k | 0]; });
    const z = offset + PLANTED_SLOPE * (x[30] * x[122]);
    let y = rng() < sigmoid(z) ? 1 : 0;
    if (x[31]) y = 1;
    rows.push({ x: x, y: y });
  }
  return {
    rows: rows,
    replays: Array.from({ length: BATTLES }, function () { return { rows: ROWS_PER_BATTLE }; })
  };
}

const CORPUS = buildCorpus();
const ROWS = BATTLES * ROWS_PER_BATTLE;
const BASE = { weights128: baseVector(), intercept: 0 };

/* ============================================== 1. the candidate pool */

section('1. the pool is products of the aggregate dims, and nothing else');

const pool = selector.candidatePool(128);
eq('the pool is every unordered pair of the 68 pooled dims, squares included', pool.length, 2346);
check('both dims of every candidate sit in the pooled set (24..75 or 112..127), left <= right',
  pool.every(function (p) {
    const okDim = function (d) { return (d >= 24 && d <= 75) || (d >= 112 && d <= 127); };
    return Array.isArray(p) && p.length === 2 && p[0] <= p[1] && okDim(p[0]) && okDim(p[1]);
  }));
eq('the pool is 52x53/2 within one block, 16x17/2 in the other, plus the 52x16 mixes',
  [pool.filter(function (p) { return p[1] <= 75; }).length,
    pool.filter(function (p) { return p[0] >= 112; }).length,
    pool.filter(function (p) { return p[0] <= 75 && p[1] >= 112; }).length],
  [1378, 136, 832]);
check('no candidate touches a per-slot HP/faint dim (0..23) or the pairwise threat matrix (76..111)',
  pool.every(function (p) { return p[0] >= 24 && !(p[1] >= 76 && p[1] <= 111); }));
eq('the squares are the 52 aggregate plus the 16 active-mon dims',
  pool.filter(function (p) { return p[0] === p[1]; }).length, 68);
check('the pool spans both blocks: [24,24] and [127,127] in, [0,0] out',
  pool.some(function (p) { return p[0] === 24 && p[1] === 24; }) &&
  pool.some(function (p) { return p[0] === 127 && p[1] === 127; }) &&
  !pool.some(function (p) { return p[0] === 0; }));
eq('the pool is deterministic', selector.candidatePool(128), pool);
throwsWith('a non-128 base layout is refused', function () { selector.candidatePool(144); }, /128/);

/* ================================== 2. the rounding convention */

section('2. a cross term is the product, stored the way a Float32Array stores it');

const row = CORPUS.rows[3].x;
const appended = selector.appendCrosses(row, [PLANTED_PAIR, SPARSE_PAIR]);
eq('the base features are copied through', appended.slice(0, 128), row);
eq('the crosses land after the base, in pair order',
  appended.slice(128), [Math.fround(row[30] * row[122]), Math.fround(row[31] * row[123])]);
const f32 = new Float32Array(1);
f32[0] = row[30] * row[122];
eq('that rounding is exactly a Float32Array store', appended[128], f32[0]);
check('and the fixture is not vacuous: f32 and f64 products differ somewhere in it',
  CORPUS.rows.some(function (r) { return Math.fround(r[30] * r[122]) !== r[30] * r[122]; }));
check('no pairs means no copy at all (the plain 128-dim path pays nothing)',
  selector.appendCrosses(row, []) === row && fitter.appendCrosses(row, []) === row);
eq('the selector and the fitter build the same row',
  selector.appendCrosses(row, [PLANTED_PAIR]), fitter.appendCrosses(row, [PLANTED_PAIR]));

/* ================================== 3. the screening gain */

section('3. the gain is a joint Newton fit on top of the baseline score');

/* The offset must be WELL SPECIFIED or the gain is not the column's: a baseline that already
 * mis-reads the label's level hands the fit a large intercept correction it will claim, whichever
 * column is being screened. So the label is 2 + 3*dim 5 + 3*dim 6, and the offset carries exactly
 * the 2 + 3*dim 5 part. Dim 6 then owns the whole residual slope and dim 7 owns nothing. */
const GAIN_N = 600;
const gainRows = [];
(function () {
  const rng = mulberry32(4242);
  for (let i = 0; i < GAIN_N; i++) {
    const x = new Array(128);
    for (let j = 0; j < 128; j++) x[j] = rng() - 0.5;
    x[5] = 2 * (rng() - 0.5);
    x[6] = 2 * (rng() - 0.5);
    x[7] = rng() - 0.5;
    gainRows.push({ x: x, y: rng() < sigmoid(2 + 3 * x[5] + 3 * x[6]) ? 1 : 0 });
  }
})();
const gainOffset = gainRows.map(function (r) { return 2 + 3 * r.x[5]; });
const gainY = gainRows.map(function (r) { return r.y; });
const signal = gainRows.map(function (r) { return r.x[6]; });
const noise = gainRows.map(function (r) { return r.x[7]; });
const gSignal = selector.gainOf(signal.slice(), gainY, gainOffset);
const gNoise = selector.gainOf(noise.slice(), gainY, gainOffset);
check('a column that carries signal gets a positive slope and a large gain',
  gSignal.beta > 0.1 && gSignal.gain > 20, 'beta ' + gSignal.beta + ', gain ' + gSignal.gain);
check('a column that carries nothing gets a near-zero gain',
  gNoise.gain < 5 && Math.abs(gNoise.beta) < 0.5, 'beta ' + gNoise.beta + ', gain ' + gNoise.gain);
check('the signal column outranks the noise column by more than 20 log-likelihood units',
  gSignal.gain - gNoise.gain > 20, (gSignal.gain - gNoise.gain).toFixed(1));
eq('the gain is deterministic', selector.gainOf(signal.slice(), gainY, gainOffset).gain, gSignal.gain);
check('the fit converged rather than hitting the iteration cap', gSignal.converged === true,
  'iterations ' + gSignal.iterations);
/* The joint Newton is checked against an INDEPENDENT optimiser (coordinate ascent on the same
 * log-likelihood with numeric derivatives), because "deterministic" and "correct" are different
 * claims and a wrong Hessian would still be deterministic. */
function referenceGain(z, y, offset) {
  const n = z.length;
  const mean = z.reduce(function (s, v) { return s + v; }, 0) / n;
  const sd = Math.sqrt(z.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / n);
  const zz = z.map(function (v) { return (v - mean) / sd; });
  const ll = function (a, b) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const t = offset[i] + a + b * zz[i];
      s += y[i] ? -Math.log1p(Math.exp(-t)) : (-t - Math.log1p(Math.exp(-t)));
    }
    return s;
  };
  const climb = function (fn, x0) {
    let x = x0;
    for (let k = 0; k < 80; k++) {
      const h = 1e-6, f0 = fn(x), fp = fn(x + h), fm = fn(x - h);
      const d2 = (fp - 2 * f0 + fm) / (h * h);
      if (!(Math.abs(d2) > 1e-12)) break;
      const step = ((fp - fm) / (2 * h)) / d2;
      x -= step;
      if (Math.abs(step) < 1e-13) break;
    }
    return x;
  };
  const base = ll(0, 0);
  let a = 0, b = 0;
  for (let sweep = 0; sweep < 8; sweep++) {
    a = climb(function (v) { return ll(v, b); }, a);
    b = climb(function (v) { return ll(a, v); }, b);
  }
  return { gain: ll(a, b) - base, beta: b };
}
const refSignal = referenceGain(signal, gainY, gainOffset);
const refNoise = referenceGain(noise, gainY, gainOffset);
close('the joint Newton agrees with a coordinate-ascent reference on the signal column',
  gSignal.gain, refSignal.gain, 1e-6);
close('and its slope agrees too', gSignal.beta, refSignal.beta, 1e-6);
close('the same optimiser agrees on the noise column', gNoise.gain, refNoise.gain, 1e-6);

const standardised = signal.slice();
selector.gainOf(standardised, gainY, gainOffset);
const sMean = standardised.reduce(function (s, v) { return s + v; }, 0) / GAIN_N;
const sSd = Math.sqrt(standardised.reduce(function (s, v) { return s + (v - sMean) * (v - sMean); }, 0) / GAIN_N);
check('the column is standardised in place, which is what makes beta comparable across candidates',
  Math.abs(sMean) < 1e-12 && Math.abs(sSd - 1) < 1e-12, 'mean ' + sMean + ', sd ' + sSd);
close('pearson: a column with itself is 1', selector.pearson(signal, signal), 1, 1e-12);
close('pearson: a negated column is -1',
  selector.pearson(signal, signal.map(function (v) { return -v; })), -1, 1e-12);
eq('the provenance map is used only when its counts add up to the rows being fitted',
  [selector.usableGroups(CORPUS, ROWS) !== null,
    selector.usableGroups({ rows: CORPUS.rows }, CORPUS.rows.length),
    selector.usableGroups({ rows: CORPUS.rows, replays: [{ rows: 5 }] }, ROWS)],
  [true, null, null]);

/* ================================== 4. selection end to end */

section('4. selectCrosses recovers the planted interaction, deterministically');

const sel = selector.selectCrosses(CORPUS, { baseline: BASE, k: 16, holdout: 5, rankedLimit: 32 });
eq('the split is grouped over the corpus provenance (battles 0, 5, 10, 15 held out)',
  [sel.split.trainRows, sel.split.testRows, sel.split.groupedHoldout, sel.split.holdoutBattles],
  [3200, 800, true, 20]);
eq('the report names its generator and the base feature count',
  [sel.generator, sel.features], ['tools/select_cross_features.js', 128]);
eq('the report echoes the thresholds it was given',
  [sel.thresholds.k, sel.thresholds.dedupe, sel.thresholds.holdout], [16, 0.98, 5]);
eq('the planted pair is the top-ranked candidate', [sel.picked[0].a, sel.picked[0].b], PLANTED_PAIR);
check('its gain is large and its slope has the planted sign',
  sel.picked[0].gain > 20 && sel.picked[0].beta > 0,
  'gain ' + sel.picked[0].gain + ', beta ' + sel.picked[0].beta);
check('it is the maximum gain in the whole ranked window',
  sel.ranked.every(function (c) { return c.gain <= sel.picked[0].gain + 1e-12; }));
check('the ranking is sorted descending by gain',
  sel.ranked.every(function (c, i) { return i === 0 || sel.ranked[i - 1].gain >= c.gain; }));
check('every picked candidate reports its own support share and Newton cost',
  sel.picked.every(function (c) {
    return c.share >= 0.01 - 1e-12 && c.share <= 1 && c.iterations >= 1 && isFinite(c.beta);
  }));
eq('sixteen candidates survive the |r| > 0.98 duplicate ceiling', sel.picked.length, 16);
close('the planted pair fires on about a third of the training rows',
  sel.picked[0].share, 1 / 3, 0.03);
eq('the same corpus selects the same list, field for field',
  JSON.stringify(selector.selectCrosses(CORPUS, { baseline: BASE, k: 16, holdout: 5, rankedLimit: 32 })),
  JSON.stringify(sel));
const sel3 = selector.selectCrosses(CORPUS, { baseline: BASE, k: 3, holdout: 5 });
eq('k bounds the list', sel3.picked.length, 3);
check('a shorter k keeps the same top of the list',
  sel3.picked.every(function (c, i) { return c.a === sel.picked[i].a && c.b === sel.picked[i].b; }),
  JSON.stringify(sel3.picked));

/* The share floor, proved by lifting it. */
check('the sparse pair is absent from the ranked list under the default floor',
  !sel.ranked.some(function (c) { return c.a === SPARSE_PAIR[0] && c.b === SPARSE_PAIR[1]; }));
const lifted = selector.selectCrosses(CORPUS, {
  baseline: BASE, k: 16, holdout: 5, minNonzeroShare: 0, rankedLimit: 3000
});
const sparseLifted = lifted.ranked.filter(function (c) { return c.a === SPARSE_PAIR[0] && c.b === SPARSE_PAIR[1]; });
check('lifting the floor admits it with its two non-zero rows, so the floor is what excluded it',
  sparseLifted.length === 1 && sparseLifted[0].nonzero === 2 && isFinite(sparseLifted[0].gain),
  JSON.stringify(sparseLifted));

/* ================================== 5. the --crosses refit path */

section('5. the crosses path reports 128 + N, and the plain report is unchanged');

const opts = { lambda: 0.5, holdout: 5, maxIter: 200, tol: 1e-7 };
const plain = fitter.run(CORPUS, opts);
const crossed = fitter.run(CORPUS, Object.assign({}, opts, { crosses: [PLANTED_PAIR] }));
eq('no crosses: features is 128 and no cross field appears',
  [plain.features, 'crossPairs' in plain, 'weightsCross' in plain, 'cross' in plain.spec],
  [128, false, false, false]);
eq('one cross: features is 129 and the pair is reported',
  [crossed.features, crossed.crossPairs], [129, [PLANTED_PAIR]]);
eq('weights128 stays the base block while weightsCross carries the extra coefficient',
  [crossed.weights128.length, crossed.weightsCross.length], [128, 1]);
eq('weights128 and the cross block together are the fitted vector',
  crossed.weights128.concat(crossed.weightsCross).length, crossed.features);
eq('weightsFull is the intercept followed by all 129 coefficients',
  crossed.weightsFull.length, 130);
eq('spec.cross is the fitted coefficient copied verbatim',
  crossed.spec.cross, crossed.weightsCross);
eq('the base groups are mapped exactly as they are without crosses',
  Object.keys(crossed.spec).sort(), Object.keys(plain.spec).concat('cross').sort());
check('the planted cross recovers an upward slope',
  crossed.weightsCross[0] > 0, 'coef ' + crossed.weightsCross[0]);
const plantedBase = Object.keys(BASE_DIMS).map(Number);
const noiseDims = [];
for (let j = 0; j < 128; j++) if (plantedBase.indexOf(j) < 0) noiseDims.push(j);
const meanAbs = function (dims) {
  return dims.reduce(function (s, j) { return s + Math.abs(crossed.weights128[j]); }, 0) / dims.length;
};
check('the planted cross outranks the noise dims it competes with',
  Math.abs(crossed.weightsCross[0]) > 4 * meanAbs(noiseDims),
  'cross ' + crossed.weightsCross[0].toFixed(3) + ' vs mean |noise| ' + meanAbs(noiseDims).toFixed(3));
check('the crossed fit beats the base-only fit on the same hold-out',
  crossed.aucTest > plain.aucTest,
  'AUC ' + crossed.aucTest + ' vs ' + plain.aucTest);
check('both fits converge', crossed.converged === true && plain.converged === true,
  'crossed ' + crossed.iterations + ' iters, plain ' + plain.iterations);
eq('a crossed fit keeps the battle-level split when the provenance adds up',
  [crossed.groupedHoldout, crossed.holdoutBattles, crossed.provenanceIgnored], [true, 20, false]);
eq('crosses: [] is the plain path', fitter.run(CORPUS, Object.assign({}, opts, { crosses: [] })).features, 128);
eq('pairsOf reads a bare pair list, a {pairs} payload and a selector report',
  [fitter.pairsOf([[1, 2]]), fitter.pairsOf({ pairs: [[3, 4]] }),
    fitter.pairsOf({ picked: [{ a: 5, b: 6, gain: 9, beta: 0.1 }] })],
  [[[1, 2]], [[3, 4]], [[5, 6]]]);
eq('a valid pair list is returned unchanged', fitter.validatePairs([[24, 127]], 128), [[24, 127]]);
eq('--crosses is a parseable flag', fitter.parseArgs(['--crosses', 'c.json']).crosses, 'c.json');
eq('the selector reads its own knobs', [selector.parseArgs(['-i', 'a.json']).input,
  selector.parseArgs(['--k', '4']).k, selector.parseArgs(['--dedupe', '0.5']).dedupe],
  ['a.json', 4, 0.5]);

/* ================================== 6. refusals */

section('6. malformed pairs, baselines and payloads are refused');

throwsWith('a pair index outside the base layout is refused',
  function () { fitter.validatePairs([[0, 128]], 128); }, /cross pair 0/);
throwsWith('a negative index is refused',
  function () { fitter.validatePairs([[-1, 5]], 128); }, /cross pair 0/);
throwsWith('a fractional index is refused',
  function () { fitter.validatePairs([[1.5, 5]], 128); }, /cross pair 0/);
throwsWith('a pair that is not two numbers is refused',
  function () { fitter.validatePairs([[1]], 128); }, /cross pair 0/);
throwsWith('a second bad pair is named by its index',
  function () { fitter.validatePairs([[1, 2], [3, 128]], 128); }, /cross pair 1/);
throwsWith('a --crosses payload with none of the three shapes is refused',
  function () { fitter.pairsOf({ nope: true }); }, /--crosses/);
throwsWith('a selector report entry missing its right leg is refused',
  function () { fitter.pairsOf({ picked: [{ a: 1 }] }); }, /cross pair 0/);
throwsWith('mapToSpec refuses a 128-long vector when crosses were fitted',
  function () { fitter.mapToSpec(new Array(128).fill(0), [PLANTED_PAIR]); }, /129/);
throwsWith('mapToSpec still refuses a 129-long vector when none were',
  function () { fitter.mapToSpec(new Array(129).fill(0)); }, /128/);
throwsWith('run() refuses a cross beyond the base layout',
  function () { fitter.run(CORPUS, { crosses: [[130, 5]] }); }, /cross pair 0/);
throwsWith('a baseline without weights128 is refused',
  function () { selector.selectCrosses(CORPUS, { baseline: {} }); }, /weights128/);
throwsWith('a baseline with the wrong vector length is refused',
  function () { selector.selectCrosses(CORPUS, { baseline: { weights128: [1, 2], intercept: 0 } }); }, /weights128/);
throwsWith('a baseline with a non-finite intercept is refused',
  function () { selector.selectCrosses(CORPUS, { baseline: { weights128: baseVector(), intercept: NaN } }); }, /intercept/);
throwsWith('a corpus too small to screen is refused',
  function () { selector.selectCrosses({ rows: CORPUS.rows.slice(0, 20) }, { baseline: BASE }); },
  /30 training rows/);
throwsWith('an unknown fitter argument is refused', function () { fitter.parseArgs(['--nope']); }, /unknown argument/);
throwsWith('an unknown selector argument is refused', function () { selector.parseArgs(['--nope']); }, /unknown argument/);
check('both tools document --crosses / their own flags in their help text',
  /--crosses/.test(fs.readFileSync(path.join(ROOT, 'tools', 'fit_weights.js'), 'utf8')) &&
  /select_cross_features\.js --input/.test(fs.readFileSync(path.join(ROOT, 'tools', 'select_cross_features.js'), 'utf8')));

/* ================================== 7. no residue in the engine */

section('7. the study changed no engine code');

const cfgText = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');
const evText = fs.readFileSync(path.join(ROOT, 'src', 'evaluator_128d.js'), 'utf8');
eq('the live DIM is still 128', ST.DenseStateEvaluator.DIM, 128);
eq('defaultWeights() is still a 128-long vector', ST.DenseStateEvaluator.defaultWeights().length, 128);
eq('config carries no cross block', ST.configGet('evaluator.weights.cross', null), null);
check('neither source file mentions a cross product', !/\bcross/i.test(cfgText) && !/\bcross/i.test(evText));

/* ================================================================== summary */

console.log('\n=== summary ===');
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failed);
console.log('planted pair: ranked #1 with gain ' + sel.picked[0].gain.toFixed(1) +
  ' [dim ' + PLANTED_PAIR[0] + ' x dim ' + PLANTED_PAIR[1] + ']');
console.log('crossed refit: features ' + crossed.features + ', hold-out AUC ' +
  crossed.aucTest.toFixed(4) + ' vs ' + plain.aucTest.toFixed(4) + ' without the cross');
if (failed) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('ALL CROSS-FEATURE CHECKS PASSED');
process.exit(0);
