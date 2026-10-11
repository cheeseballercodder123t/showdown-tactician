/* Showdown Tactician — tools/fit_weights.js
 * The fitting half of the empirical-weight pipeline: binary logistic regression over the 128D
 * state vectors produced by tools/extract_training_data.js, fitted by IRLS (Newton-Raphson)
 * with an L2 ridge penalty. Dependency-free: no numpy, no sklearn, no npm install.
 *
 * Run me with:
 *   node tools/fit_weights.js --input training_data.json [--lambda 0.5] [--holdout 5] \
 *        [--max-iter 25] [--out lib/trained-weights.json]
 *
 * WHY NOT JUST TRUST THE HAND-TUNED WEIGHTS
 *   src/config.js's evaluator.weights were picked by hand. They are not wrong, but nobody can
 *   say how close they are to the weights that actually predict winning, because that is an
 *   empirical question. This tool answers it: same feature layout, same dot product, weights fit
 *   against real battle logs. The output is a REVIEWABLE artifact (lib/trained-weights.json),
 *   never an automatic rewrite of src/config.js — a fitted vector is only as good as the corpus
 *   it came from, and this repository ships no corpus.
 *
 * WHAT IT REPORTS
 *   - train AUC and hold-out TEST AUC (rank-sum / Mann-Whitney, ties handled),
 *   - the fitted 128 coefficients and the intercept,
 *   - `spec`: the coefficients mapped back onto config.js's evaluator.weights groups, so the
 *     numbers can be pasted in directly (see mapToSpec for the mapping and its sign traps),
 *   - `lowSupport`: every dim observed in fewer than LOW_SUPPORT_ROWS rows, with those counts.
 *     A coefficient on such a column is a separation artifact, not a measurement — five lucky
 *     rows can pin a coefficient of any size — so an adoption has to decide what to do with
 *     these dims by name instead of inheriting them silently.
 *   It refuses a single-class dataset or a ragged/mismatched matrix instead of returning NaN.
 *
 * THE MAPPING (the part that silently reshapes the evaluator if it is wrong)
 *   evaluated score = sum over the 128 dims of (vector[i] * weight[i]), where the weights are
 *   BUILT from config.js's readable groups by DenseStateEvaluator.defaultWeights():
 *     dims   0..5   : w[i]      = +hp          (our HP)      -> hp group  = mean(0..5) - mean(6..11)
 *     dims   6..11  : w[6+i]    = -hp          (their HP)    (the sign is folded in above)
 *     dims  12..17  : w[12+i]   = -fainted     (our faints)  -> fainted   = mean(18..23) - mean(12..17)
 *     dims  18..23  : w[18+i]   = +fainted     (their faints)
 *     dims  24..35  : w[24+i]   = status[i]     (12 entries, copied verbatim)
 *     dims  36..47  : w[36+i]   = boosts[i]     (copied verbatim)
 *     dims  48..55  : w[48+i]   = hazards[i]    (copied verbatim)
 *     dims  56..63  : w[56+i]   = trickRoom[i]  (copied verbatim)
 *     dims  64..75  : w[64+i]   = items[i]      (copied verbatim)
 *     dims  76..111 : w[76+i*6+j] = threat, but mean(threat, threatActive) on the six
 *                     i == j cells (index 76 + i*7)  -> threat       = mean of the 30 off-diagonals
 *                                                     -> threatActive = mean of the 6 diagonals
 *     dims 112..127 : w[112+i]  = macro[i]      (copied verbatim)
 *   A fitted dot product is only equivalent to config's groups when the group substitution is
 *   exact, so the four non-copy groups are means/differences rather than single picks.
 *
 * FEATURES ARE STANDARDIZED INTERNALLY
 *   IRLS on raw dims is badly conditioned (HP fractions and +-1 macro dims share one Hessian).
 *   Columns are centered and scaled by their sample standard deviation, the fit happens there,
 *   and the coefficients are converted BACK to raw space before anything is reported, so the
 *   numbers in the output act on the real vector. A column with no variance in the corpus is
 *   reported as coefficient 0 — it is unidentifiable, not "unimportant".
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIM = 128;

/* Rows a dim must be non-zero in before its coefficient is treated as identified. A fitted
 * coefficient is only meaningful when the column moved; below this the fit is extrapolating from
 * a handful of cases, and IRLS happily returns a huge coefficient with an immeasurable standard
 * error (the corpus that produced the shipped artifact had accuracy-boost dims with 5 and 17
 * non-zero rows out of 111,820, and coefficients of +54.7 / -50.3). The report names those dims;
 * whether to prune them is the adoption's decision, not the fitter's. */
const LOW_SUPPORT_ROWS = 20;

/* ============================================================== numeric core */

function sigmoid(z) {
  if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
  const e = Math.exp(z);
  return e / (1 + e);
}

function meanOf(values) {
  if (!values.length) return 0;
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s / values.length;
}

/**
 * Solve A x = b by Gaussian elimination with partial pivoting.
 * Returns null when the matrix is singular (or numerically indistinguishable from it); callers
 * must then refuse rather than emit NaN.
 */
function solveLinearSystem(A, b) {
  const n = b.length;
  const M = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) row[j] = A[i][j];
    row[n] = b[i];
    M[i] = row;
  }
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) { best = v; pivot = r; }
    }
    if (!(best > 1e-12)) return null;
    if (pivot !== col) { const tmp = M[pivot]; M[pivot] = M[col]; M[col] = tmp; }
    const diag = M[col][col];
    for (let k = col; k <= n; k++) M[col][k] /= diag;
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s;
  }
  for (let i = 0; i < n; i++) if (!isFinite(x[i])) return null;
  return Array.prototype.slice.call(x);
}

function columnStats(X) {
  const n = X.length, d = X[0].length;
  const mean = new Float64Array(d), sd = new Float64Array(d);
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += X[i][j];
    mean[j] = s / n;
  }
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) { const dd = X[i][j] - mean[j]; s += dd * dd; }
    sd[j] = Math.sqrt(s / Math.max(1, n - 1));
  }
  return { mean: mean, sd: sd };
}

/**
 * fitLogistic(X, y, opts) -> { coef, intercept, iterations, converged, lambda, standardized }
 * IRLS for the L2-penalized log-likelihood. X is an array of equal-length numeric arrays.
 */
function fitLogistic(X, y, options) {
  const opts = options || {};
  const lambda = typeof opts.lambda === 'number' && opts.lambda >= 0 ? opts.lambda : 0.5;
  const maxIter = typeof opts.maxIter === 'number' && opts.maxIter > 0 ? opts.maxIter : 25;
  const tol = typeof opts.tol === 'number' && opts.tol > 0 ? opts.tol : 1e-7;
  const standardize = opts.standardize !== false;

  const n = X.length;
  if (!n) throw new Error('fitLogistic: the dataset is empty');
  const d = X[0].length;
  if (!d) throw new Error('fitLogistic: the rows have no features');
  for (let i = 0; i < n; i++) {
    if (!X[i] || typeof X[i].length !== 'number' || X[i].length !== d) {
      throw new Error('fitLogistic: row ' + i + ' has ' + (X[i] ? X[i].length : 'no') +
        ' features, expected ' + d + ' (a ragged matrix is refused, not padded)');
    }
  }
  if (y.length !== n) throw new Error('fitLogistic: ' + n + ' rows but ' + y.length + ' labels');

  let pos = 0;
  for (let i = 0; i < n; i++) if (y[i]) pos++;
  if (pos === 0 || pos === n) {
    throw new Error('fitLogistic: the dataset has a single class (all ' + (pos ? 'positive' : 'negative') +
      ') — there is nothing to separate');
  }

  const stats = standardize ? columnStats(X) : { mean: new Float64Array(d), sd: null };
  const Z = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(d);
    for (let j = 0; j < d; j++) {
      const s = standardize ? stats.sd[j] : 1;
      row[j] = s > 1e-9 ? (X[i][j] - stats.mean[j]) / s : 0;
    }
    Z[i] = row;
  }

  const w = new Float64Array(d);
  let b = Math.log(pos / (n - pos));                 // the intercept starts at the base rate
  let iterations = 0, converged = false, lastStep = Infinity;

  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1;
    const H = new Array(d);
    for (let i = 0; i < d; i++) H[i] = new Float64Array(d);
    const g = new Float64Array(d);
    let gb = 0, sTotal = 0;

    for (let i = 0; i < n; i++) {
      const row = Z[i];
      let z = b;
      for (let j = 0; j < d; j++) z += row[j] * w[j];
      const p = sigmoid(z);
      const wgt = Math.max(p * (1 - p), 1e-9);       // the Fisher weight, floored for safety
      const resid = y[i] - p;
      gb += resid;
      sTotal += wgt;
      for (let a = 0; a < d; a++) {
        const ra = row[a];
        if (ra === 0) continue;
        g[a] += ra * resid;
        const wa = wgt * ra;
        const Ha = H[a];
        for (let c = a; c < d; c++) Ha[c] += wa * row[c];   // upper triangle only, then mirrored
      }
    }

    for (let a = 0; a < d; a++) {
      const Ha = H[a];
      for (let c = a; c < d; c++) {
        const v = Ha[c] + (a === c ? lambda : 0);
        Ha[c] = v;
        H[c][a] = v;
      }
    }
    const rhs = new Float64Array(d);
    for (let a = 0; a < d; a++) rhs[a] = g[a] - lambda * w[a];
    const step = solveLinearSystem(H, rhs);
    if (!step) {
      throw new Error('fitLogistic: the Newton system is singular at iteration ' + iterations +
        ' (collinear features); raise --lambda');
    }

    let maxStep = 0;
    for (let a = 0; a < d; a++) {
      w[a] += step[a];
      if (Math.abs(step[a]) > maxStep) maxStep = Math.abs(step[a]);
    }
    const bStep = sTotal > 1e-12 ? gb / sTotal : 0;   // the intercept has its own 1x1 solve
    b += bStep;
    lastStep = Math.max(maxStep, Math.abs(bStep));
    if (lastStep < tol) { converged = true; break; }
  }

  const coef = new Array(d);
  for (let j = 0; j < d; j++) {
    const s = standardize ? stats.sd[j] : 1;
    coef[j] = s > 1e-9 ? w[j] / s : 0;
  }
  let intercept = b;
  if (standardize) {
    for (let j = 0; j < d; j++) intercept -= coef[j] * stats.mean[j];
  }
  for (let j = 0; j < d; j++) {
    if (!isFinite(coef[j])) throw new Error('fitLogistic: coefficient ' + j + ' is not finite');
  }
  if (!isFinite(intercept)) throw new Error('fitLogistic: the intercept is not finite');

  return {
    coef: coef, intercept: intercept, iterations: iterations, converged: converged,
    lambda: lambda, standardize: standardize, lastStep: lastStep
  };
}

/** Predict the linear score (log-odds) for one vector with a fitted model. */
function scoreOf(model, x) {
  let z = model.intercept;
  for (let j = 0; j < x.length; j++) z += x[j] * model.coef[j];
  return z;
}

/**
 * AUC-ROC as the rank-sum (Mann-Whitney U) statistic, so tied scores split their rank evenly.
 * Returns null when only one class is present (the statistic is undefined there, not 0.5).
 */
function auc(scores, labels) {
  const n = scores.length;
  if (labels.length !== n) throw new Error('auc: ' + n + ' scores but ' + labels.length + ' labels');
  if (!n) return null;
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort(function (a, b2) { return scores[a] - scores[b2]; });
  const ranks = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;                       // 1-based average rank across the tie group
    for (let k = i; k <= j; k++) ranks[idx[k]] = avg;
    i = j + 1;
  }
  let n1 = 0, n0 = 0, sumPos = 0;
  for (let k = 0; k < n; k++) {
    if (labels[k]) { n1++; sumPos += ranks[k]; } else n0++;
  }
  if (!n1 || !n0) return null;
  return (sumPos - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

/**
 * Deterministic hold-out. Disjoint and complete by construction; k < 2 is clamped to 2 (k = 1 would
 * hold out everything and leave nothing to train on).
 *
 * `groups` is optional and is the honest mode. Rows are consecutive turns of ONE battle and
 * neighbouring turns carry nearly the same state and the same label, so holding out every k-th ROW
 * leaves each held-out row's neighbours in the training set and reports an AUC no battle could ever
 * see (measured on the shipped corpus: 0.7975 that way, 0.6472 when whole battles are held out).
 * Pass the per-battle row counts and every k-th BATTLE is held out instead, which is the number
 * worth quoting. Without `groups` the row-level split still runs, because it is what the tests pin.
 */
function splitIndices(n, k, groups) {
  let holdout = (typeof k === 'number' && isFinite(k) && k > 0) ? Math.floor(k) : 5;
  if (holdout < 2) holdout = 2;
  const train = [], test = [];
  if (Array.isArray(groups) && groups.length) {
    let battle = 0, cursor = 0;
    for (let b = 0; b < groups.length; b++) {
      const size = Math.max(0, Math.floor(groups[b]) || 0);
      // A battle that contributed no rows takes no hold-out slot either: counting it would push the
      // held-out share below 1/k (the extractor does emit a zero-row entry for a battle whose every
      // turn was skipped) and would report battles that hold no data.
      if (!size) continue;
      const isTest = battle % holdout === 0;
      battle++;
      for (let j = 0; j < size && cursor < n; j++) (isTest ? test : train).push(cursor++);
    }
    // rows a short `groups` did not account for go to training, so the split stays complete
    while (cursor < n) train.push(cursor++);
    return { train: train, test: test, holdout: holdout, battles: battle, grouped: true };
  }
  for (let i = 0; i < n; i++) (i % holdout === 0 ? test : train).push(i);
  return { train: train, test: test, holdout: holdout, battles: 0, grouped: false };
}

/**
 * The four group substitution described in the file header. Direct slices are copies; the four
 * asymmetric groups (hp, fainted, threat, threatActive) are the means/differences that the sign
 * folding in DenseStateEvaluator.defaultWeights() implies. Do not "simplify" this.
 */
function mapToSpec(coef) {
  if (!coef || coef.length !== DIM) {
    throw new Error('mapToSpec expects ' + DIM + ' coefficients, got ' + (coef ? coef.length : 'none'));
  }
  const slice = function (lo, hi) { return coef.slice(lo, hi); };
  let threatSum = 0, threatN = 0, diagSum = 0;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      const v = coef[76 + i * 6 + j];
      if (i === j) diagSum += v; else { threatSum += v; threatN++; }
    }
  }
  return {
    hp: meanOf(slice(0, 6)) - meanOf(slice(6, 12)),
    fainted: meanOf(slice(18, 24)) - meanOf(slice(12, 18)),
    status: slice(24, 36),
    boosts: slice(36, 48),
    hazards: slice(48, 56),
    trickRoom: slice(56, 64),
    items: slice(64, 76),
    threat: threatN ? threatSum / threatN : 0,
    threatActive: diagSum / 6,
    macro: slice(112, 128)
  };
}

function round(numbers, dp) {
  const f = Math.pow(10, dp === undefined ? 4 : dp);
  return numbers.map(function (v) { return Math.round(v * f) / f; });
}

/** The copy-pasteable config.js fragment for a fitted spec. */
function specSnippet(spec) {
  if (!spec) return '(no spec: the fitted vector is not 128-dimensional)';
  return 'evaluator: {\n  weights: {\n    hp: ' + JSON.stringify(round([spec.hp])[0]) +
    ', fainted: ' + JSON.stringify(round([spec.fainted])[0]) + ',\n' +
    '    status: ' + JSON.stringify(round(spec.status)) + ',\n' +
    '    boosts: ' + JSON.stringify(round(spec.boosts)) + ',\n' +
    '    hazards: ' + JSON.stringify(round(spec.hazards)) + ',\n' +
    '    trickRoom: ' + JSON.stringify(round(spec.trickRoom)) + ',\n' +
    '    items: ' + JSON.stringify(round(spec.items)) + ',\n' +
    '    threat: ' + JSON.stringify(round([spec.threat])[0]) +
    ', threatActive: ' + JSON.stringify(round([spec.threatActive])[0]) + ',\n' +
    '    macro: ' + JSON.stringify(round(spec.macro)) + '\n  }\n}';
}

function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.rows)) return payload.rows;
  if (payload && Array.isArray(payload.data)) return payload.data;
  throw new Error('fit_weights: input must be an array of {x,y} rows, or {rows:[...]} / {data:[...]}');
}

/** Turn a dataset payload into a validated { X, y } pair; refuses anything ragged or non-finite. */
function matrixOf(payload, dim) {
  const expected = dim || DIM;
  const rows = rowsOf(payload);
  if (!rows.length) throw new Error('fit_weights: the dataset is empty');
  const X = [], y = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.x || typeof r.x.length !== 'number') throw new Error('fit_weights: row ' + i + ' has no `x` array');
    if (r.x.length !== expected) {
      throw new Error('fit_weights: row ' + i + ' has ' + r.x.length + ' features, expected ' + expected);
    }
    const row = new Array(expected);
    for (let j = 0; j < expected; j++) {
      const v = r.x[j];
      if (typeof v !== 'number' || !isFinite(v)) {
        throw new Error('fit_weights: row ' + i + ' feature ' + j + ' is not a finite number');
      }
      row[j] = v;
    }
    X.push(row);
    y.push(r.y ? 1 : 0);
  }
  return { X: X, y: y };
}

/**
 * run(payload, opts) -> report object (no file I/O: the test drives this directly).
 * Throws on an empty, ragged, non-finite, or single-class dataset.
 */
function run(payload, options) {
  const opts = options || {};
  const dim = opts.dim || DIM;
  const lambda = typeof opts.lambda === 'number' && opts.lambda >= 0 ? opts.lambda : 0.5;
  const data = matrixOf(payload, dim);
  // The payload's provenance carries one entry per battle with its row count, in row order, so the
  // hold-out can be taken over whole battles rather than over turns of the same battle.
  const groups = Array.isArray(payload && payload.replays)
    ? payload.replays.map(function (p) { return (p && p.rows) || 0; })
    : null;
  // The map is only usable when the counts add up to the rows being fitted. A hand-built dataset, an
  // older file, or rows spliced in without their provenance would otherwise group one battle's turns
  // under another battle's index, or leave the hold-out empty and throw. A mismatch falls back to
  // the row-level split and says so in the report, rather than being silently absorbed.
  const groupRows = groups
    ? groups.reduce(function (s, v) { return s + (typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0); }, 0)
    : 0;
  const usableGroups = (groupRows > 0 && groupRows === data.X.length) ? groups : null;
  const split = splitIndices(data.X.length, opts.holdout, usableGroups);

  const trainX = split.train.map(function (i) { return data.X[i]; });
  const trainY = split.train.map(function (i) { return data.y[i]; });
  const testX = split.test.map(function (i) { return data.X[i]; });
  const testY = split.test.map(function (i) { return data.y[i]; });
  if (!testX.length) throw new Error('fit_weights: the hold-out split left no test rows (need at least 2 samples)');

  let model;
  try {
    model = fitLogistic(trainX, trainY, { lambda: lambda, maxIter: opts.maxIter, tol: opts.tol });
  } catch (err) {
    throw new Error('fit_weights: the training half could not be fitted — ' + ((err && err.message) || err));
  }

  const score = function (X) { return X.map(function (x) { return scoreOf(model, x); }); };
  const aucTrain = auc(score(trainX), trainY);
  const aucTest = auc(score(testX), testY);
  const spec = dim === DIM ? mapToSpec(model.coef) : null;

  // Per-dim support: how many rows carried a non-zero value, and how many of those were
  // positives. The counts are what makes a huge coefficient reviewable — a dim with five
  // non-zero rows cannot identify anything, however small its p-value looks.
  const lowSupport = [];
  for (let j = 0; j < data.X[0].length; j++) {
    let nonzero = 0, positives = 0;
    for (let i = 0; i < data.X.length; i++) {
      if (data.X[i][j] !== 0) { nonzero++; if (data.y[i]) positives++; }
    }
    if (nonzero < LOW_SUPPORT_ROWS) lowSupport.push({ dim: j, nonzero: nonzero, positives: positives });
  }

  return {
    lambda: lambda,
    iterations: model.iterations,
    converged: model.converged,
    lastStep: model.lastStep,
    standardized: model.standardize,
    samples: data.X.length,
    trainSamples: trainX.length,
    testSamples: testX.length,
    holdout: split.holdout,
    holdoutBattles: split.grouped ? split.battles : 0,
    groupedHoldout: split.grouped,
    provenanceIgnored: !!groups && !usableGroups,
    lowSupportThreshold: LOW_SUPPORT_ROWS,
    lowSupport: lowSupport,
    positives: data.y.reduce(function (s, v) { return s + v; }, 0),
    features: dim,
    aucTrain: aucTrain,
    aucTest: aucTest,
    intercept: model.intercept,
    weights128: model.coef,
    weightsFull: [model.intercept].concat(model.coef),
    spec: spec
  };
}

/* ---------------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const out = { input: null, out: 'lib/trained-weights.json', lambda: 0.5, holdout: 5, maxIter: 25, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--lambda') out.lambda = parseFloat(argv[++i]);
    else if (a === '--holdout') out.holdout = parseInt(argv[++i], 10);
    else if (a === '--max-iter') out.maxIter = parseInt(argv[++i], 10);
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

function main(argv) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node tools/fit_weights.js --input training_data.json [--lambda 0.5] ' +
      '[--holdout 5] [--max-iter 25] [--out lib/trained-weights.json]');
    return 0;
  }
  if (!opts.input) throw new Error('--input is required');
  const payload = JSON.parse(fs.readFileSync(path.resolve(ROOT, opts.input), 'utf8'));
  const report = run(payload, { lambda: opts.lambda, holdout: opts.holdout, maxIter: opts.maxIter });
  const target = path.resolve(ROOT, opts.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  if (!opts.quiet) {
    console.log('samples ' + report.samples + ' (' + report.trainSamples + ' train / ' +
      report.testSamples + ' test), positives ' + report.positives + ', lambda ' + report.lambda +
      ', iterations ' + report.iterations + (report.converged ? ' (converged)' : ' (hit the cap)'));
    console.log('  AUC train ' + fmt(report.aucTrain) + ' | AUC test ' + fmt(report.aucTest));
    console.log('  low-support dims (<' + LOW_SUPPORT_ROWS + ' non-zero rows): ' +
      (report.lowSupport.length
        ? report.lowSupport.map(function (e) { return e.dim + '(' + e.nonzero + ')'; }).join(' ')
        : 'none'));
    console.log('wrote ' + path.relative(ROOT, target));
    console.log('\n' + specSnippet(report.spec));
  }
  return 0;
}

function fmt(v) {
  return typeof v === 'number' && isFinite(v) ? v.toFixed(4) : String(v);
}

module.exports = {
  DIM: DIM, sigmoid: sigmoid, meanOf: meanOf, solveLinearSystem: solveLinearSystem,
  columnStats: columnStats, fitLogistic: fitLogistic, scoreOf: scoreOf, auc: auc,
  splitIndices: splitIndices, mapToSpec: mapToSpec, specSnippet: specSnippet, round: round,
  rowsOf: rowsOf, matrixOf: matrixOf, run: run, parseArgs: parseArgs, main: main
};

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error('fit_weights: ' + ((err && err.message) || err));
    process.exit(1);
  }
}
