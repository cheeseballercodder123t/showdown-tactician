/* Showdown Tactician — tools/fit_preference_weights.js
 *
 * WITHIN-TURN PREFERENCE FITTING. tools/fit_weights.js regresses a TURN's 128-dim vector onto who
 * won the battle. This fits the same 128 weights onto the human's turn-by-turn CHOICE instead:
 *
 *     pairs  d_i = x(s_t, a_human) - x(s_t, a_rejected)
 *     model  P(human clicks the first over the second) = sigmoid(w . d_i)
 *     loss   -sum log sigmoid(w . d_i) + (lambda/2) |w|^2
 *
 * No intercept: every pair is ordered, so the likelihood is a ranking (Bradley-Terry), and the
 * intercept would cancel inside the difference anyway. Newton-Raphson with a step-halving guard,
 * columns standardized over the training half and the result mapped back, so the penalty means the
 * same thing it means in fit_weights.js.
 *
 * THE NUMBER THAT DECIDES IT is PAIRWISE ACCURACY on held-out BATTLES: the share of unseen human
 * decisions where the fitted vector puts the human's click above the alternative it was paired with.
 * The shipped vector's own accuracy on the SAME held-out pairs is printed beside it — that is the
 * comparison the state-classification AUC in lib/trained-weights.json cannot make, because it scores
 * boards, not choices.
 *
 * USAGE
 *   node tools/fit_preference_weights.js --input prefs.json [options]
 *     --lambda <x>     L2 ridge (default 1.0; on differences the scale is different from a state fit)
 *     --holdout <k>    hold out every k-th BATTLE (default 5)
 *     --max-iter <n>   Newton iterations (default 40)
 *     --out <file>     write the report (weights128 + spec + the accuracies)
 *     --quiet
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const fitter = require('./fit_weights.js');

const DIM = 128;

function parseArgs(argv) {
  const out = { input: null, out: null, lambda: 1.0, holdout: 5, maxIter: 40, slice: 'all', negatives: 'hard', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--slice') out.slice = String(argv[++i] || 'all').toLowerCase();
    else if (a === '--negatives') out.negatives = String(argv[++i] || 'hard').toLowerCase();
    else if (a === '--lambda') out.lambda = parseFloat(argv[++i]);
    else if (a === '--holdout') out.holdout = parseInt(argv[++i], 10);
    else if (a === '--max-iter') out.maxIter = parseInt(argv[++i], 10);
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

/** pairsOf(payload) -> { D, battles, slices } ; refuses ragged/empty/non-finite. */
function pairsOf(payload) {
  const rows = Array.isArray(payload) ? payload : (payload && payload.pairs);
  if (!Array.isArray(rows) || !rows.length) throw new Error('fit_preference_weights: no pairs in the payload');
  const D = [], battles = [], slices = [], sources = [];
  let ties = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const d = r && r.d;
    if (!Array.isArray(d) || d.length !== DIM) {
      throw new Error('fit_preference_weights: pair ' + i + ' has ' + (d && d.length) + ' dims, expected ' + DIM);
    }
    let informative = false;
    for (let j = 0; j < DIM; j++) {
      if (typeof d[j] !== 'number' || !isFinite(d[j])) {
        throw new Error('fit_preference_weights: pair ' + i + ' dim ' + j + ' is not finite');
      }
      if (d[j] !== 0) informative = true;
    }
    /* A TIED PAIR is two clicks that leave the SAME 128-dim board (two 50 %-accurate switch-ins,
     * two status clicks the leaf does not distinguish). It labels one of them as preferred, so it
     * can only teach a coin flip; the extractor keeps it (it is a fact about the menu) and the fit
     * drops it, counted, rather than averaging noise into every accuracy in the report. */
    if (!informative) { ties++; continue; }
    D.push(d);
    battles.push(typeof r.battle === 'number' ? r.battle : 0);
    // The board slice is stamped by the extractor; a hand-built payload has none and reads as 'all'.
    slices.push(typeof r.slice === 'string' ? r.slice : 'all');
    sources.push(r.source === 'random' ? 'random' : 'hard');
  }
  if (!D.length) throw new Error('fit_preference_weights: every pair is a tie (no 128-dim difference)');
  return { D: D, battles: battles, slices: slices, sources: sources, ties: ties };
}

/**
 * keepIndices(slices, wanted) -> indices whose slice is `wanted` ('all' keeps everything).
 * The "only contested mid-game decisions" experiment is a FILTER and not a weight, because the
 * preference loss is already a within-turn comparison: a turn either has a contested board or it
 * does not, and a partially-weighted ranking pair has no clean likelihood interpretation.
 */
function keepIndices(slices, wanted) {
  const want = wanted && wanted !== 'all' ? String(wanted) : null;
  const out = [];
  for (let i = 0; i < slices.length; i++) if (!want || slices[i] === want) out.push(i);
  return out;
}

/** pairwiseAccuracyBySlice(w, D, slices) -> { all, early, crucible, late } each { n, accuracy }. */
function pairwiseAccuracyBySlice(w, D, slices) {
  const names = ['all', 'early', 'crucible', 'late'];
  const buckets = {};
  for (let k = 0; k < names.length; k++) buckets[names[k]] = [];
  for (let i = 0; i < D.length; i++) {
    buckets.all.push(i);
    if (buckets[slices[i]]) buckets[slices[i]].push(i);
  }
  const out = {};
  for (let k = 0; k < names.length; k++) {
    const idx = buckets[names[k]].map(function (i) { return D[i]; });
    out[names[k]] = { n: idx.length, accuracy: idx.length ? pairwiseAccuracy(w, idx) : null };
  }
  return out;
}

/** The mean pairwise log-likelihood at `w` (higher is better). */
function logLik(w, D, lambda) {
  let s = 0;
  for (let i = 0; i < D.length; i++) {
    let z = 0;
    const d = D[i];
    for (let j = 0; j < DIM; j++) z += w[j] * d[j];
    // log sigmoid(z), stable for both tails
    s += z >= 0 ? -Math.log(1 + Math.exp(-z)) : z - Math.log(1 + Math.exp(z));
  }
  let sq = 0;
  for (let j = 0; j < DIM; j++) sq += w[j] * w[j];
  return s / D.length - 0.5 * lambda * sq / D.length;
}

/** Pairwise accuracy: share of pairs the vector ranks the human's side above the rejected one. */
function pairwiseAccuracy(w, D) {
  if (!D.length) return null;
  let ok = 0;
  for (let i = 0; i < D.length; i++) {
    let z = 0;
    for (let j = 0; j < DIM; j++) z += w[j] * D[i][j];
    if (z > 0) ok += 1;
    else if (z === 0) ok += 0.5;
  }
  return ok / D.length;
}

/** Column sd of the differences, floored so a constant column cannot divide by zero. */
function columnSd(D) {
  const sd = new Float64Array(DIM);
  for (let j = 0; j < DIM; j++) {
    let s = 0, s2 = 0;
    for (let i = 0; i < D.length; i++) { s += D[i][j]; s2 += D[i][j] * D[i][j]; }
    const mean = s / D.length;
    sd[j] = Math.sqrt(Math.max(0, s2 / D.length - mean * mean));
    if (!(sd[j] > 1e-9)) sd[j] = 1;
  }
  return sd;
}

/**
 * fitPreference(D, opts) -> { w, iterations, converged, logLik }
 * Newton-Raphson on the L2-penalized Bradley-Terry likelihood. `w` is in the ORIGINAL feature units.
 */
function fitPreference(D, options) {
  const opts = options || {};
  const lambda = typeof opts.lambda === 'number' && opts.lambda >= 0 ? opts.lambda : 1;
  const maxIter = opts.maxIter || 40;
  if (!D.length) throw new Error('fit_preference_weights: no pairs');
  const sd = columnSd(D);
  // Standardize in place into Z (same shape), fit there, and divide the result by sd at the end:
  // w_std . (d / sd) = (w_std / sd) . d, so the unstandardized vector is exactly this.
  const Z = new Array(D.length);
  for (let i = 0; i < D.length; i++) {
    const z = new Float64Array(DIM);
    const d = D[i];
    for (let j = 0; j < DIM; j++) z[j] = d[j] / sd[j];
    Z[i] = z;
  }
  const w = new Float64Array(DIM);
  let current = logLik(w, Z, lambda);
  let iterations = 0;
  let converged = false;

  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1;
    const g = new Float64Array(DIM);
    // Hessian as a dense triangular accumulation. 128x128 is small enough to be worth the Newton
    // step: the alternative (gradient ascent) needs an order of magnitude more passes.
    const H = new Array(DIM);
    for (let j = 0; j < DIM; j++) {
      H[j] = new Float64Array(DIM);
      H[j][j] = lambda * D.length;
    }
    for (let i = 0; i < Z.length; i++) {
      const z = Z[i];
      let eta = 0;
      for (let j = 0; j < DIM; j++) eta += w[j] * z[j];
      const p = 1 / (1 + Math.exp(-eta));
      const s = Math.max(1e-12, p * (1 - p));
      const r = 1 - p;                       // dL/dw contribution for a label of 1
      for (let j = 0; j < DIM; j++) {
        g[j] += r * z[j];
        const zj = z[j] * s;
        for (let k = j; k < DIM; k++) H[j][k] += zj * z[k];
      }
    }
    for (let j = 0; j < DIM; j++) g[j] -= lambda * D.length * w[j];
    for (let j = 0; j < DIM; j++) for (let k = j + 1; k < DIM; k++) H[k][j] = H[j][k];

    const A = [];
    for (let j = 0; j < DIM; j++) A.push(Array.prototype.slice.call(H[j]));
    const step = fitter.solveLinearSystem(A, Array.prototype.slice.call(g));
    if (!step) break;
    let scale = 1;
    let accepted = false;
    for (let halve = 0; halve < 25; halve++) {
      const trial = new Float64Array(DIM);
      for (let j = 0; j < DIM; j++) trial[j] = w[j] + scale * step[j];
      const value = logLik(trial, Z, lambda);
      if (value >= current) {
        for (let j = 0; j < DIM; j++) w[j] = trial[j];
        const gain = value - current;
        current = value;
        accepted = true;
        if (gain < 1e-10) converged = true;
        break;
      }
      scale *= 0.5;
    }
    if (!accepted || converged) break;
  }

  const out = new Array(DIM);
  for (let j = 0; j < DIM; j++) out[j] = w[j] / sd[j];
  return { w: out, iterations: iterations, converged: converged, logLik: current };
}

/** The vector the shipped build actually scores with, as a plain array (for the baseline line). */
function shippedVector(ST) {
  try {
    return Array.prototype.slice.call(ST.DenseStateEvaluator.defaultWeights());
  } catch (e) {
    return null;
  }
}

function main(argv) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node tools/fit_preference_weights.js --input prefs.json [--out report.json]\n' +
      '       [--lambda 1.0] [--holdout 5] [--max-iter 40] [--slice all|crucible|early|late]\n' +
      '       [--negatives hard|random|all] [--quiet]');
    return 0;
  }
  if (!opts.input) throw new Error('--input is required');
  const payload = JSON.parse(fs.readFileSync(path.resolve(ROOT, opts.input), 'utf8'));
  const data = pairsOf(payload);
  /* THE SLICE FILTER (`--slice crucible`): fit and score only the contested mid-game decisions.
   * Every downstream count is taken AFTER the filter, so the battle-grouped hold-out still adds up. */
  const keep = keepIndices(data.slices, opts.slice);
  if (!keep.length) throw new Error('fit_preference_weights: no pairs in slice "' + opts.slice + '"');
  const wantRandom = opts.negatives === 'random';
  const keepTraining = keep.filter(function (i) {
    if (opts.negatives === 'all') return true;
    return (data.sources[i] === 'random') === wantRandom;
  });
  if (!keepTraining.length) {
    throw new Error('fit_preference_weights: no pairs with negatives="' + opts.negatives +
      '" (extract with --random-negative for the unbiased subset)');
  }
  const kept = { D: keepTraining.map(function (i) { return data.D[i]; }),
    battles: keepTraining.map(function (i) { return data.battles[i]; }),
    slices: keepTraining.map(function (i) { return data.slices[i]; }) };
  /* THE UNBIASED SUBSET. Random negatives were never selected on any score, so 50 % is chance
   * there and the accuracy on them is a ranker reading rather than a "beat your own favourite"
   * one. It is scored on the SAME held-out battles as the fit, never on ones it trained on. */
  const randomKeep = keep.filter(function (i) { return data.sources[i] === 'random'; });
  // Group the hold-out by BATTLE: decisions inside one battle share a board and a plan, so a
  // row-level split would leave a held-out pair's neighbours in training and flatter the fit.
  const counts = {};
  kept.battles.forEach(function (b) { counts[b] = (counts[b] || 0) + 1; });
  const order = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });
  const groups = order.map(function (b) { return counts[b]; });
  const indexOf = {};
  order.forEach(function (b, i) { indexOf[b] = i; });
  // `splitIndices` holds out every k-th BATTLE when it is given the per-battle row counts — the
  // same grouped split the winner fit uses, so the two models are evaluated on comparable folds.
  const split = fitter.splitIndices(kept.D.length, opts.holdout, groups);
  const trainD = split.train.map(function (i) { return kept.D[i]; });
  const testD = split.test.map(function (i) { return kept.D[i]; });
  const testSlices = split.test.map(function (i) { return kept.slices[i]; });
  if (!testD.length) throw new Error('fit_preference_weights: the hold-out left no test pairs');
  const heldBattles = { size: split.battles || 0 };

  const fit = fitPreference(trainD, { lambda: opts.lambda, maxIter: opts.maxIter });
  const accTrain = pairwiseAccuracy(fit.w, trainD);
  const accTest = pairwiseAccuracy(fit.w, testD);
  // Where the accuracy comes from: the same three cuts the winner AUC is reported on, so the two
  // models can be read side by side instead of against one pooled number each.
  const bySlice = pairwiseAccuracyBySlice(fit.w, testD, testSlices);

  // The honest baseline: the vector that ships today, on the SAME held-out pairs.
  let baseline = null;
  let accBaseline = null;
  try {
    const HM = require('./benchmark_human_match.js');
    const api = HM.loadApi([]);
    baseline = shippedVector(api.ST);
    if (baseline) accBaseline = pairwiseAccuracy(baseline, testD);
  } catch (e) { /* no harness: the report says so */ }
  const bySliceShipped = baseline ? pairwiseAccuracyBySlice(baseline, testD, testSlices) : null;
  // Held-out battles only, so a random-negative reading cannot be flattered by a battle the fit saw.
  const testBattles = {};
  for (let i = 0; i < split.test.length; i++) testBattles[kept.battles[split.test[i]]] = true;
  const randomTest = randomKeep.filter(function (i) { return testBattles[data.battles[i]]; })
    .map(function (i) { return data.D[i]; });
  const accRandom = randomTest.length ? pairwiseAccuracy(fit.w, randomTest) : null;
  const accRandomShipped = (baseline && randomTest.length) ? pairwiseAccuracy(baseline, randomTest) : null;

  const report = {
    kind: 'preference-weights',
    dim: DIM,
    lambda: opts.lambda,
    iterations: fit.iterations,
    converged: fit.converged,
    meanLogLik: fit.logLik,
    slice: opts.slice,
    battles: order.length,
    heldOutBattles: heldBattles.size,
    samples: kept.D.length,
    tiedPairsDropped: data.ties || 0,
    testShippedBaseline: !!baseline,
    trainSamples: trainD.length,
    testSamples: testD.length,
    pairwiseTrain: accTrain,
    pairwiseTest: accTest,
    pairwiseTestShipped: accBaseline,
    pairwiseTestSlices: bySlice,
    pairwiseTestSlicesShipped: bySliceShipped,
    negatives: opts.negatives,
    pairwiseTestRandom: accRandom,
    pairwiseTestRandomShipped: accRandomShipped,
    pairwiseTestRandomSamples: randomTest.length,
    weights128: fit.w,
    spec: fitter.mapToSpec(fit.w)
  };

  if (!opts.quiet) {
    console.log('pairs ' + kept.D.length + ' from ' + order.length + ' battles' +
      (opts.slice !== 'all' ? ' (slice: ' + opts.slice + ')' : '') + ' (' +
      trainD.length + ' train / ' + testD.length + ' test, ' + heldBattles.size + ' held out)');
    console.log('  newton iterations ' + fit.iterations + (fit.converged ? ' (converged)' : ' (hit the cap)'));
    console.log('  pairwise accuracy  train ' + fmt(accTrain) + ' | test ' + fmt(accTest));
    console.log('  the SHIPPED vector on the same held-out pairs: ' + fmt(accBaseline));
    const names = ['early', 'crucible', 'late'];
    const cells = [];
    for (let i = 0; i < names.length; i++) {
      const a = bySlice[names[i]], b = bySliceShipped ? bySliceShipped[names[i]] : null;
      if (!a || !a.n) continue;
      cells.push(names[i] + ' n=' + a.n + ' fit ' + fmt(a.accuracy) +
        (b ? ' | shipped ' + fmt(b.accuracy) : ''));
    }
    if (cells.length) console.log('  by slice (hold-out): ' + cells.join(' | '));
    if (accTest !== null && accBaseline !== null) {
      console.log('  delta (preference fit - shipped): ' + fmt(accTest - accBaseline));
    }
    if (accRandom !== null) {
      console.log('  unbiased random-negative pairs (same held-out battles): fit ' + fmt(accRandom) +
        ' | shipped ' + fmt(accRandomShipped) + '  (n=' + randomTest.length + ', 50% is chance)');
    }
  }
  if (opts.out) {
    const target = path.resolve(ROOT, opts.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
    if (!opts.quiet) console.log('wrote ' + path.relative(ROOT, target));
  }
  return 0;
}

function fmt(v) {
  return typeof v === 'number' && isFinite(v) ? (v * 100).toFixed(2) + '%' : String(v);
}

module.exports = {
  DIM: DIM, parseArgs: parseArgs, pairsOf: pairsOf, pairwiseAccuracy: pairwiseAccuracy,
  keepIndices: keepIndices, pairwiseAccuracyBySlice: pairwiseAccuracyBySlice,
  columnSd: columnSd, fitPreference: fitPreference, shippedVector: shippedVector, main: main
};

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error('fit_preference_weights: ' + ((err && err.message) || err));
    process.exit(1);
  }
}
