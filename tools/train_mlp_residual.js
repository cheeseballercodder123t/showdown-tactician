/* Showdown Tactician — tools/train_mlp_residual.js
 * Fits the OPTIONAL residual head (a 128 -> 16 -> 1 ReLU network) that src/mlp_residual.js runs on
 * top of the frozen 128D linear evaluator, and decides — on evidence, not on preference — whether
 * it may be enabled.
 *
 * Run me with:
 *   node tools/fetch_replays.js ...        # build a corpus (see that tool's header)
 *   node tools/extract_training_data.js --input replays.json --out training_data.json
 *   node tools/train_mlp_residual.js --input training_data.json
 *
 * WHAT IT FITS, AND WHY IT FITS ONLY THAT
 *   The linear evaluator is frozen. Its score on a row is
 *       raw   = sum_i x[i] * w[i]        (w = DenseStateEvaluator.defaultWeights(), i.e. the
 *                                         shipped config.evaluator.weights at evaluator.fitScale)
 *       score = scale * tanh(raw / tanhDenominator)
 *   and the head is trained on the RESIDUAL of that model, never on the label directly:
 *       z_i = a + b * raw_i              (a 1-D logistic calibration, TRAIN half only)
 *       r_i = y_i - sigmoid(z_i)         (the logistic-loss negative gradient — textbook boosting)
 *   Fitting the head on `y` instead would let it re-derive the whole ranking and overfit; fitting
 *   it on `r` means it can only learn what the linear half got WRONG. That is the entire point of
 *   the composition, and it is why the base score is never replaced.
 *
 * THE INPUT IS STANDARDISED, AND THE GATE IS MEASURED THROUGH THE REAL ENGINE
 *   IRLS/GD on raw dims is badly conditioned (HP fractions and +-1 macro dims in one Hessian), so
 *   the columns are centred and scaled by their train-half standard deviation and the head is
 *   fitted in that space; the standardiser ships in the artifact. After training, the coefficients
 *   are rounded to Float32, the ACTUAL ST.ResidualMLP class is instantiated with them, and every
 *   number in the gate is produced by calling the engine's own evaluateVector() on the held-out
 *   rows. The artifact therefore describes the code that ships, not an idealised rewrite of it.
 *
 * THE SPLIT IS LITERALLY THE LINEAR FIT'S SPLIT, AND THERE IS A SECOND ONE INSIDE IT
 *   `splitIndices` and `auc` are imported from tools/fit_weights.js and called with the same
 *   `groups` (the per-battle row counts the extractor writes), so every k-th BATTLE is held out
 *   exactly as it was for lib/trained-weights.json. Turns of one battle share almost all of their
 *   state and their label, so a row-level split leaks and reports an AUC no battle could see; the
 *   grouped split is the only honest one and it is not re-implemented here.
 *
 *   Inside the training half there is a SECOND grouped split, and it is not optional. The network
 *   is fitted on the inner-train battles, EARLY-STOPPED on the inner-validation battles' MSE, and
 *   its score gain is chosen on the inner-validation AUC. The first version of this tool selected
 *   the gain on the same rows it had fitted and picked gain 991 with a training-half AUC of 0.8616
 *   against a held-out 0.6757 — a selector reading its own training set cannot tell a correction
 *   that generalises from one that memorised the battle, and because rows are clustered within a
 *   battle the effective sample size is the battle count (~2,800), not the row count (~85,000).
 *   The outer test battles are never read by any selection step.
 *
 * THE GATE
 *   The hybrid must beat the frozen linear score on the held-out battles by more than noise. The
 *   significance test is a PAIRED bootstrap over battles: resample the held-out battles with
 *   replacement B times, recompute both AUCs on the pooled rows of each resample, and look at the
 *   distribution of (hybrid - base). Adoption requires the 95% percentile interval to exclude
 *   zero. This is the same discipline the cross-product screen was rejected under ("median
 *   0.0000, 95% CI [-0.0047, +0.0015], ahead in 41% of resamples" — no adoption), and the same one
 *   the adopted linear vector passed.
 *
 * WHAT IT WRITES, AND WHAT IT REFUSES TO WRITE
 *   Always: lib/mlp-residual.json — the reviewable artifact, carrying the fitted coefficients, the
 *   split, the AUCs and the bootstrap.
 *   Only when the gate PASSES: lib/mlp-residual.js — the generated data module the extension
 *   loads. On a failed gate that module is written as `null` instead, so a rejected head costs the
 *   content script nothing and cannot be switched on by a stray config edit; re-run the tool on a
 *   better corpus to regenerate it. `--force-module` overrides this for inspection only.
 *   Never: src/config.js. Adopting the head is a deliberate one-line edit to
 *   `evaluator.mlp.enabled`, printed at the end of a passing run — the same rule the linear
 *   fitter follows ("neither the artifact nor the fitter rewrites src/config.js on its own").
 *
 * DETERMINISM
 *   Same corpus, same seed, byte-identical artifact: the shuffle, the initialisation and the
 *   bootstrap all draw from one seeded xorshift32, and nothing is timestamped.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const fitter = require('./fit_weights.js');

const ROOT = path.resolve(__dirname, '..');
const DIM = 128;

/* ============================================================ tiny numerics */

/** xorshift32 — deterministic, seeded, and enough for a shuffle and a bootstrap. */
function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Percentile of an already-sorted array, linear interpolation between neighbours. */
function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function mean(values) {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return values.length ? s / values.length : 0;
}

/** Sample standard deviation (n-1), matching fit_weights.columnStats. */
function sdOf(values) {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  let s = 0;
  for (let i = 0; i < n; i++) { const d = values[i] - m; s += d * d; }
  return Math.sqrt(s / (n - 1));
}

/* ================================================================= the data */

function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.rows)) return payload.rows;
  throw new Error('train_mlp_residual: input must be {rows:[{x,y}]} (tools/extract_training_data.js)');
}

function matrixOf(payload, dim) {
  const rows = rowsOf(payload);
  if (!rows.length) throw new Error('train_mlp_residual: the dataset is empty');
  const X = new Float64Array(rows.length * dim);
  const y = new Uint8Array(rows.length);
  let positives = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.x || r.x.length !== dim) {
      throw new Error('train_mlp_residual: row ' + i + ' has ' +
        (r && r.x ? r.x.length : 'no') + ' features, expected ' + dim);
    }
    for (let j = 0; j < dim; j++) {
      const v = r.x[j];
      if (typeof v !== 'number' || !isFinite(v)) {
        throw new Error('train_mlp_residual: row ' + i + ' feature ' + j + ' is not a finite number');
      }
      X[i * dim + j] = v;
    }
    y[i] = r.y ? 1 : 0;
    if (y[i]) positives++;
  }
  return { X: X, y: y, n: rows.length, positives: positives };
}

/* ================================================================ the model */

/** Build the frozen linear model exactly as the engine does. */
function loadEngine() {
  const H = require('../tests/harness.js');
  const S = H.loadAll({ setInterval: function () { return 0; }, clearInterval: function () { } });
  const ST = S.ST;
  if (!ST.DenseStateEvaluator) throw new Error('train_mlp_residual: the harness did not load the evaluator');
  const evaluator = new ST.DenseStateEvaluator();
  return {
    sandbox: S, ST: ST, evaluator: evaluator,
    weights: evaluator.weights,
    scale: ST.configGet('evaluator.scale', 1000),
    tanhDenominator: ST.configGet('evaluator.tanhDenominator', 420),
    fitScale: ST.configGet('evaluator.fitScale', 1)
  };
}

/** raw_i = sum_j x_ij * w_j — the frozen dot product, no intercept (the engine has none). */
function rawScores(X, n, dim, w) {
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let z = 0;
    const base = i * dim;
    for (let j = 0; j < dim; j++) z += X[base + j] * w[j];
    raw[i] = z;
  }
  return raw;
}

/** Fit z = a + b*raw by 1-D logistic regression on the TRAIN rows only. */
function calibrate(raw, y, trainIdx) {
  const X = new Array(trainIdx.length);
  const Y = new Array(trainIdx.length);
  for (let k = 0; k < trainIdx.length; k++) {
    const i = trainIdx[k];
    X[k] = [raw[i]];
    Y[k] = y[i];
  }
  // lambda is a whisper: one well-scaled column needs no ridge, but a singular Newton step is a
  // hard error in fitLogistic and a tiny ridge is cheaper than catching one.
  const model = fitter.fitLogistic(X, Y, { lambda: 1e-6, maxIter: 60, tol: 1e-12 });
  return { a: model.intercept, b: model.coef[0], converged: model.converged, iterations: model.iterations };
}

function sigmoid(z) {
  if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Column means and sample standard deviations over the TRAIN rows only. */
function standardizer(X, n, dim, trainIdx) {
  const mu = new Float64Array(dim), sd = new Float64Array(dim);
  const count = trainIdx.length;
  for (let j = 0; j < dim; j++) {
    let s = 0;
    for (let k = 0; k < count; k++) s += X[trainIdx[k] * dim + j];
    mu[j] = s / count;
  }
  for (let j = 0; j < dim; j++) {
    let s = 0;
    for (let k = 0; k < count; k++) { const d = X[trainIdx[k] * dim + j] - mu[j]; s += d * d; }
    sd[j] = count > 1 ? Math.sqrt(s / (count - 1)) : 0;
  }
  return { mu: mu, sd: sd };
}

/** A deterministic He-uniform draw, so a rerun of the same seed reproduces the same head. */
function initNet(dim, hidden, rng) {
  const W1 = new Float64Array(hidden * dim);
  const b1 = new Float64Array(hidden);
  const W2 = new Float64Array(hidden);
  const l1 = Math.sqrt(6 / dim);
  const l2 = Math.sqrt(6 / (hidden + 1));
  for (let i = 0; i < W1.length; i++) W1[i] = (rng() * 2 - 1) * l1;
  for (let i = 0; i < hidden; i++) W2[i] = (rng() * 2 - 1) * l2;
  return { W1: W1, b1: b1, W2: W2, b2: 0 };
}

/**
 * trainHead(U, r, n, dim, hidden, opts) -> { W1, b1, W2, b2, lossCurve, valCurve, bestEpoch }
 * Full-gradient minibatch descent with momentum on 0.5*MSE + (l2/2)*||W||^2.
 * `U` is the ALREADY-STANDARDISED input matrix from standardizeMatrix — this function does no
 * scaling of its own, so the network is fitted in exactly the space the shipped class computes in.
 *
 * `opts.valU` / `opts.valR` (optional) turn on EARLY STOPPING: the inner-validation MSE is measured
 * after every epoch and the weights from the best epoch are the ones returned. Without it the run
 * simply returns the last epoch, which is what the smoke tests exercise.
 *
 * Every batch update is a plain vector pass, and the batch order comes from the seeded RNG, so the
 * whole thing is reproducible from (corpus, seed, hyper-parameters).
 */
function trainHead(U, r, n, dim, hidden, opts) {
  const rng = makeRng(opts.seed);
  const net = initNet(dim, hidden, rng);
  const { W1, b1, W2, b2 } = { W1: net.W1, b1: net.b1, W2: net.W2, b2: net.b2 };
  const vW1 = new Float64Array(W1.length), vb1 = new Float64Array(hidden);
  const vW2 = new Float64Array(hidden);
  let vb2 = 0;
  const gW1 = new Float64Array(W1.length), gb1 = new Float64Array(hidden);
  const gW2 = new Float64Array(hidden);
  const h = new Float64Array(hidden), u = new Float64Array(dim);
  const lossCurve = [], valCurve = [];
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  const lr = opts.lr, momentum = opts.momentum, l2 = opts.l2, batch = opts.batch;
  let b2cur = b2;
  const valU = opts.valU || null, valR = opts.valR || null;
  const useVal = !!(valU && valR && valU.length);
  let bestVal = Infinity, bestEpoch = -1;
  let bestW1 = null, bestB1 = null, bestW2 = null, bestB2 = 0;

  /** MSE of the current weights on a held-out matrix. */
  const mseOn = function (Xv, yv) {
    if (!Xv || !yv || !Xv.length) return NaN;
    let sum = 0;
    for (let i = 0; i < yv.length; i++) {
      const base = i * dim;
      for (let j = 0; j < dim; j++) u[j] = Xv[base + j];
      for (let k = 0; k < hidden; k++) {
        let z = b1[k];
        const kb = k * dim;
        for (let j = 0; j < dim; j++) z += W1[kb + j] * u[j];
        h[k] = z > 0 ? z : 0;
      }
      let g = b2cur;
      for (let k = 0; k < hidden; k++) g += W2[k] * h[k];
      const e = g - yv[i];
      sum += e * e;
    }
    return sum / yv.length;
  };

  for (let epoch = 0; epoch < opts.epochs; epoch++) {
    // Fisher-Yates with the seeded RNG: a fixed batch order, no Math.random anywhere.
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    let epochLoss = 0;
    for (let start = 0; start < n; start += batch) {
      const end = Math.min(start + batch, n);
      const m = end - start;
      gW1.fill(0); gb1.fill(0); gW2.fill(0); let gb2 = 0;
      for (let q = start; q < end; q++) {
        const i = order[q];
        const base = i * dim;
        for (let j = 0; j < dim; j++) u[j] = U[base + j];
        for (let k = 0; k < hidden; k++) {
          let z = b1[k];
          const kb = k * dim;
          for (let j = 0; j < dim; j++) z += W1[kb + j] * u[j];
          h[k] = z > 0 ? z : 0;
        }
        let g = b2cur;
        for (let k = 0; k < hidden; k++) g += W2[k] * h[k];
        const err = g - r[i];
        epochLoss += err * err;
        // backward
        for (let k = 0; k < hidden; k++) {
          gW2[k] += err * h[k];
          const dz = h[k] > 0 ? err * W2[k] : 0;      // ReLU derivative
          if (dz === 0) continue;
          gb1[k] += dz;
          const kb = k * dim;
          for (let j = 0; j < dim; j++) gW1[kb + j] += dz * u[j];
        }
        gb2 += err;
      }
      const inv = lr / m;
      for (let i2 = 0; i2 < W1.length; i2++) {
        vW1[i2] = momentum * vW1[i2] - inv * (gW1[i2] + l2 * W1[i2]);
        W1[i2] += vW1[i2];
      }
      for (let k = 0; k < hidden; k++) {
        vb1[k] = momentum * vb1[k] - inv * (gb1[k] + l2 * b1[k]);
        b1[k] += vb1[k];
        vW2[k] = momentum * vW2[k] - inv * (gW2[k] + l2 * W2[k]);
        W2[k] += vW2[k];
      }
      vb2 = momentum * vb2 - inv * gb2;
      b2cur += vb2;
    }
    lossCurve.push(epochLoss / n);
    if (useVal) {
      const vm = mseOn(valU, valR);
      valCurve.push(vm);
      if (vm < bestVal) {
        bestVal = vm; bestEpoch = epoch;
        bestW1 = Float64Array.from(W1); bestB1 = Float64Array.from(b1);
        bestW2 = Float64Array.from(W2); bestB2 = b2cur;
      }
    }
  }
  if (useVal && bestW1) {
    return { W1: bestW1, b1: bestB1, W2: bestW2, b2: bestB2, lossCurve: lossCurve, valCurve: valCurve, bestEpoch: bestEpoch, bestVal: bestVal };
  }
  return { W1: W1, b1: b1, W2: W2, b2: b2cur, lossCurve: lossCurve, valCurve: valCurve, bestEpoch: opts.epochs - 1, bestVal: NaN };
}

/**
 * standardizeMatrix(X, n, dim, mu, sd) -> the matrix the head ACTUALLY sees.
 *
 * Every store is Float32-rounded exactly where `ResidualMLP` rounds one: the input arrives as a
 * Float32Array from `extractVector`, the means and sds live in Float32Arrays, and `u[j]` is stored
 * into a Float32Array. `Math.fround` IS a Float32 store, so this reproduces the class's arithmetic
 * rather than approximating it.
 *
 * Training and gain selection both consume THIS matrix, so the network is fitted for the inputs the
 * shipped class will feed it. (Fitting on raw dims and inferring on standardised ones — or the
 * reverse — is a silent train/serve skew; the smoke test that first caught it is why this is a
 * single shared path instead of two.)
 */
function standardizeMatrix(X, n, dim, mu, sd) {
  const muF = new Float32Array(dim), invF = new Float32Array(dim);
  for (let j = 0; j < dim; j++) {
    muF[j] = mu[j];
    // Read sd back OUT of a Float32 store before inverting, so this is 1/fround(sd) as the class
    // computes it — not fround(1/sd), which differs in the last bit.
    const sdF = Math.fround(sd[j]);
    invF[j] = sdF > 1e-9 ? 1 / sdF : 0;
  }
  const out = new Float64Array(n * dim);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    for (let j = 0; j < dim; j++) {
      out[base + j] = Math.fround((Math.fround(X[base + j]) - muF[j]) * invF[j]);
    }
  }
  return out;
}

/**
 * headOutputs(U, W1, b1, W2, b2, n, dim, hidden) -> the network's raw output on every row of an
 * ALREADY-STANDARDISED matrix (see standardizeMatrix), in the same Float32 arithmetic the shipped
 * class uses. `b2` is the one value the class keeps as a plain double, so it is not rounded here
 * either. tests/mlp_check.js pins this against `ResidualMLP.forward` bit for bit.
 */
function headOutputs(U, W1, b1, W2, b2, n, dim, hidden) {
  const w1 = new Float32Array(W1.length), bb1 = new Float32Array(hidden), w2 = new Float32Array(hidden);
  for (let i = 0; i < W1.length; i++) w1[i] = W1[i];
  for (let k = 0; k < hidden; k++) { bb1[k] = b1[k]; w2[k] = W2[k]; }
  const u = new Float32Array(dim), h = new Float32Array(hidden);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    for (let j = 0; j < dim; j++) u[j] = U[base + j];
    for (let k = 0; k < hidden; k++) {
      let z = bb1[k];
      const kb = k * dim;
      for (let j = 0; j < dim; j++) z += w1[kb + j] * u[j];
      h[k] = z > 0 ? z : 0;
    }
    let g = b2;
    for (let k = 0; k < hidden; k++) g += w2[k] * h[k];
    out[i] = g;
  }
  return out;
}

/**
 * gainLadder(clamp, max, points) -> the gains the selector probes, ascending, starting at 0.
 *
 * The ladder is LOG-spaced on purpose. The residual is fitted in probability units (|r| < 1) while
 * the score it corrects has a standard deviation in the hundreds, so the useful gain is not known
 * to within an order of magnitude before the run — a linear ladder capped at `clamp` would silently
 * saturate and pick the top rung, which is a selector artefact rather than a measurement. The
 * ladder therefore spans two decades around `clamp`, and `clamp` itself is always a rung so the
 * "exactly fill the clamp, never bind it" candidate is always in the running. `gainMax` defaults to
 * 10*clamp; beyond that the correction is a pure +-clamp step and only the sign of the head matters.
 */
function gainLadder(clamp, max, points) {
  const top = typeof max === 'number' && max > 0 ? max : clamp * 10;
  const n = typeof points === 'number' && points > 1 ? Math.floor(points) : 16;
  const lo = Math.log(clamp / 50);
  const hi = Math.log(top);
  const seen = {};
  const out = [0];
  seen[0] = true;
  for (let i = 0; i < n; i++) {
    const v = Math.exp(lo + (hi - lo) * i / (n - 1));
    const r = Number(v.toPrecision(4));
    if (!seen[r]) { seen[r] = true; out.push(r); }
  }
  if (!seen[clamp]) out.push(clamp);
  out.sort(function (a, b) { return a - b; });
  return out;
}

/**
 * splitTrainInner(split, groups, n, holdout) -> { innerTrain, innerVal }
 *
 * A SECOND grouped split, taken inside the training half only. It exists because the first version
 * of this tool selected the residual's gain by maximising the TRAINING-half AUC — and on the real
 * corpus that selector picked gain 991 and reported train AUC 0.8616 against a held-out 0.6757.
 * A selector that reads the same rows the network was fitted on cannot tell a correction that
 * generalises from one that memorised the battle, and rows are consecutive turns of ONE battle
 * whose label is shared, so the effective sample size is the battle count, not the row count.
 *
 * Every k-th BATTLE of the training half becomes inner validation. The outer test battles are never
 * touched, so the gate stays honest; the price is that the shipped network is fitted on 64% of the
 * rows instead of 80%, which is the honest cost of a validated selector.
 */
function splitTrainInner(split, groups, n, holdout) {
  const innerTrain = [], innerVal = [];
  let cursor = 0, battle = 0, trainBattle = 0;
  for (let b = 0; b < groups.length; b++) {
    const size = Math.max(0, Math.floor(groups[b]) || 0);
    if (!size) continue;
    const isOuterTest = battle % holdout === 0;
    battle++;
    const start = cursor;
    cursor += size;
    if (isOuterTest) continue;
    const isVal = trainBattle % holdout === 0;
    trainBattle++;
    for (let r = start; r < start + size && r < n; r++) (isVal ? innerVal : innerTrain).push(r);
  }
  return { innerTrain: innerTrain, innerVal: innerVal };
}

/* ================================================================= the gate */

/**
 * pairedBootstrap(baseScores, hybridScores, y, testIdx, battles, B, seed)
 *   -> { median, low, high, shareAhead, mean }
 * Resamples held-out BATTLES (not rows) with replacement, so the dependence between the ~30 turns
 * of one battle is respected: a row-level bootstrap would treat those turns as independent
 * evidence and report an interval far narrower than the data supports.
 */
function pairedBootstrap(baseScores, hybridScores, y, testIdx, battles, B, seed) {
  const rng = makeRng(seed);
  const diffs = new Float64Array(B);
  const nb = battles.length;
  for (let b = 0; b < B; b++) {
    const rows = [];
    for (let s = 0; s < nb; s++) {
      const battle = battles[Math.floor(rng() * nb)];
      for (let t = 0; t < battle.length; t++) rows.push(battle[t]);
    }
    const bs = new Array(rows.length), hs = new Array(rows.length), ys = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      bs[i] = baseScores[r]; hs[i] = hybridScores[r]; ys[i] = y[r];
    }
    const a = fitter.auc(bs, ys), h = fitter.auc(hs, ys);
    diffs[b] = (a === null || h === null) ? 0 : h - a;
  }
  const sorted = Array.prototype.slice.call(diffs).sort(function (x, y2) { return x - y2; });
  let ahead = 0;
  for (let b = 0; b < B; b++) if (diffs[b] > 0) ahead++;
  return {
    B: B,
    seed: seed,
    median: quantile(sorted, 0.5),
    low: quantile(sorted, 0.025),
    high: quantile(sorted, 0.975),
    shareAhead: ahead / B,
    mean: mean(diffs)
  };
}

/* ================================================================ the run */

function run(payload, options) {
  const opts = options || {};
  const dim = opts.dim || DIM;
  const hidden = opts.hidden || 16;
  const holdout = opts.holdout || 5;
  const seed = opts.seed === undefined ? 12345 : opts.seed;
  const B = opts.bootstrap === undefined ? 2000 : opts.bootstrap;

  const data = matrixOf(payload, dim);
  const n = data.n;

  // The split the linear fit was adopted under: whole battles, every k-th held out.
  const groups = Array.isArray(payload && payload.replays)
    ? payload.replays.map(function (p) { return (p && p.rows) || 0; })
    : null;
  const groupRows = groups
    ? groups.reduce(function (s, v) { return s + (typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0); }, 0)
    : 0;
  const usableGroups = (groupRows > 0 && groupRows === n) ? groups : null;
  const split = fitter.splitIndices(n, holdout, usableGroups);
  if (!split.test.length) throw new Error('train_mlp_residual: the hold-out split left no test rows');
  if (split.test.length === n) throw new Error('train_mlp_residual: the hold-out split left no training rows');

  const engine = loadEngine();
  const raw = rawScores(data.X, n, dim, engine.weights);

  // 1. calibrate the frozen linear model (train half only)
  const calib = calibrate(raw, data.y, split.train);
  const z = new Float64Array(n);
  const resid = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    z[i] = calib.a + calib.b * raw[i];
    resid[i] = data.y[i] - sigmoid(z[i]);
  }

  // 2. standardise the inputs (train half only) into the exact matrix the head will see
  const std = standardizer(data.X, n, dim, split.train);
  const U = standardizeMatrix(data.X, n, dim, std.mu, std.sd);

  // 3. a second grouped split INSIDE the training half, so both the network and the gain are
  //    selected on battles the network did not fit. The outer test battles are still untouched.
  const inner = splitTrainInner(split, usableGroups, n, holdout);
  if (!inner.innerVal.length) throw new Error('train_mlp_residual: the inner split left no validation rows');

  const sub = function (idx) {
    const out = new Float64Array(idx.length * dim);
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      for (let j = 0; j < dim; j++) out[k * dim + j] = U[i * dim + j];
    }
    return out;
  };
  const subR = function (idx) {
    const out = new Float64Array(idx.length);
    for (let k = 0; k < idx.length; k++) out[k] = resid[idx[k]];
    return out;
  };
  const net = trainHead(sub(inner.innerTrain), subR(inner.innerTrain), inner.innerTrain.length, dim, hidden, {
    epochs: opts.epochs === undefined ? 60 : opts.epochs,
    batch: opts.batch === undefined ? 512 : opts.batch,
    lr: opts.lr === undefined ? 0.1 : opts.lr,
    momentum: opts.momentum === undefined ? 0.9 : opts.momentum,
    l2: opts.l2 === undefined ? 1e-5 : opts.l2,
    seed: seed,
    // `--no-early-stop` trains to the last epoch instead of the inner-validation minimum. It is a
    // DIAGNOSTIC, not a better default: it is how the negative result below is shown to be about
    // the features rather than about stopping too soon. The gain is still chosen on inner
    // validation either way, so the comparison is apples to apples.
    valU: opts.noEarlyStop ? null : sub(inner.innerVal),
    valR: opts.noEarlyStop ? null : subR(inner.innerVal)
  });

  // 4. the head's output on EVERY row (Float32 arithmetic, as shipped)
  const g = headOutputs(U, net.W1, net.b1, net.W2, net.b2, n, dim, hidden);

  // 5. the score gain, chosen on the INNER VALIDATION battles — never on the rows the network was
  //    fitted to, and never on the outer test battles.
  const clamp = opts.clamp === undefined ? 150 : opts.clamp;
  const baseScore = new Float64Array(n);
  for (let i = 0; i < n; i++) baseScore[i] = engine.scale * Math.tanh(raw[i] / engine.tanhDenominator);
  const valBase = [], valY = [];
  for (let k = 0; k < inner.innerVal.length; k++) {
    const i = inner.innerVal[k];
    valBase.push(baseScore[i]);
    valY.push(data.y[i]);
  }
  const probeAuc = function (idx, k) {
    const probe = new Array(idx.length);
    const ys = new Array(idx.length);
    for (let q = 0; q < idx.length; q++) {
      const i = idx[q];
      let d = k * g[i];
      if (d > clamp) d = clamp; else if (d < -clamp) d = -clamp;
      probe[q] = baseScore[i] + d;
      ys[q] = data.y[i];
    }
    return fitter.auc(probe, ys);
  };
  let bestGain = 0, bestValAuc = fitter.auc(valBase, valY);
  const gainGrid = [];
  const ladder = gainLadder(clamp, opts.gainMax, opts.gainPoints);
  for (let li = 0; li < ladder.length; li++) {
    const k = ladder[li];
    const a = probeAuc(inner.innerVal, k);
    const at = probeAuc(split.train, k);   // the same gain on the rows the network was fitted to
    gainGrid.push({ gain: k, valAuc: a, trainAuc: at });
    if (a !== null && a > bestValAuc) { bestValAuc = a; bestGain = k; }
  }
  // A selector that lands on the top rung has not found an optimum, it has found the edge of its
  // own search space — worth saying out loud rather than reporting as a measurement.
  const gainSaturated = bestGain >= ladder[ladder.length - 1] && ladder.length > 1;
  const trainAucAtChosen = probeAuc(split.train, bestGain);

  // 6. the gate, measured through the REAL class on the held-out battles
  const artifactData = {
    dim: dim, hidden: hidden, gain: bestGain,
    standardize: { mean: Array.from(std.mu), sd: Array.from(std.sd) },
    w1: Array.from(net.W1), b1: Array.from(net.b1), w2: Array.from(net.W2), b2: net.b2
  };
  engine.sandbox.ST.MLP_RESIDUAL = artifactData;
  engine.ST.configMerge({ evaluator: { mlp: { enabled: true, dim: dim, hidden: hidden, clamp: clamp } } });
  const head = engine.ST.ResidualMLP.fromConfig();
  if (!head) throw new Error('train_mlp_residual: the head refused to load from its own artifact');
  const hybridScore = new Float64Array(n);
  const rowVec = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < dim; j++) rowVec[j] = data.X[i * dim + j];
    hybridScore[i] = engine.evaluator.evaluateVector(rowVec);
  }

  const testY = [], testBase = [], testHybrid = [];
  for (let k = 0; k < split.test.length; k++) {
    const i = split.test[k];
    testY.push(data.y[i]); testBase.push(baseScore[i]); testHybrid.push(hybridScore[i]);
  }
  const aucBase = fitter.auc(testBase, testY);
  const aucHybrid = fitter.auc(testHybrid, testY);

  // The bootstrap needs the held-out battles as row-index groups, so it resamples battles.
  const battles = [];
  if (split.grouped) {
    let cursor = 0, battle = 0;
    for (let b = 0; b < usableGroups.length; b++) {
      const size = Math.max(0, Math.floor(usableGroups[b]) || 0);
      if (!size) continue;
      const isTest = battle % split.holdout === 0;
      battle++;
      if (!isTest) { cursor += size; continue; }
      const rows = [];
      for (let j = 0; j < size && cursor < n; j++) rows.push(cursor++);
      if (rows.length) battles.push(rows);
    }
  }
  const boot = battles.length
    ? pairedBootstrap(baseScore, hybridScore, data.y, split.test, battles, B, seed)
    : { B: 0, seed: seed, median: NaN, low: NaN, high: NaN, shareAhead: NaN, mean: NaN };

  const passed = !!battles.length && isFinite(boot.low) && boot.low > 0;

  // How hard the safety clamp is actually working. If this is near 1 the head is a step function
  // at the rails rather than a correction, which is worth seeing before adopting it.
  let clamped = 0, deltaAbsSum = 0;
  for (let k = 0; k < split.test.length; k++) {
    const i = split.test[k];
    const rawDelta = bestGain * g[i];
    if (rawDelta > clamp || rawDelta < -clamp) clamped++;
    deltaAbsSum += Math.abs(hybridScore[i] - baseScore[i]);
  }
  const clampBindRate = split.test.length ? clamped / split.test.length : 0;
  const meanAbsDelta = split.test.length ? deltaAbsSum / split.test.length : 0;

  const residualStats = Array.prototype.slice.call(resid).sort(function (a, b) { return a - b; });

  return {
    artifact: {
      version: 1,
      tool: 'tools/train_mlp_residual.js',
      architecture: { layers: [dim, hidden, 1], activation: 'relu', output: 'linear', params: hidden * dim + hidden + hidden + 1 },
      frozenBase: {
        source: 'src/config.js evaluator.weights at evaluator.fitScale — never replaced',
        scale: engine.scale,
        tanhDenominator: engine.tanhDenominator,
        fitScale: engine.fitScale,
        calibration: { a: calib.a, b: calib.b, converged: calib.converged, iterations: calib.iterations },
        rawSd: sdOf(Array.prototype.slice.call(raw)),
        scoreSd: sdOf(Array.prototype.slice.call(baseScore))
      },
      standardize: artifactData.standardize,
      weights: { w1: artifactData.w1, b1: artifactData.b1, w2: artifactData.w2, b2: artifactData.b2 },
      gain: bestGain,
      clamp: clamp,
      training: {
        samples: n,
        trainSamples: split.train.length,
        testSamples: split.test.length,
        innerTrainSamples: inner.innerTrain.length,
        innerValSamples: inner.innerVal.length,
        holdout: split.holdout,
        holdoutBattles: split.grouped ? split.battles : 0,
        groupedHoldout: split.grouped,
        provenanceIgnored: !!groups && !usableGroups,
        positives: data.positives,
        epochs: opts.epochs === undefined ? 60 : opts.epochs,
        epochsRun: net.lossCurve.length,
        bestEpoch: net.bestEpoch,
        earlyStopped: net.bestEpoch >= 0 && net.bestEpoch < net.lossCurve.length - 1,
        batch: opts.batch === undefined ? 512 : opts.batch,
        lr: opts.lr === undefined ? 0.1 : opts.lr,
        momentum: opts.momentum === undefined ? 0.9 : opts.momentum,
        l2: opts.l2 === undefined ? 1e-5 : opts.l2,
        seed: seed,
        init: 'he-uniform',
        lossCurve: net.lossCurve.map(function (v) { return Number(v.toFixed(8)); }),
        valCurve: net.valCurve.map(function (v) { return Number(v.toFixed(8)); }),
        finalTrainMse: net.bestEpoch >= 0 ? net.lossCurve[net.bestEpoch] : (net.lossCurve.length ? net.lossCurve[net.lossCurve.length - 1] : null),
        finalValMse: (net.bestEpoch >= 0 && net.valCurve.length) ? net.valCurve[net.bestEpoch] : null
      },
      residualStats: {
        mean: mean(residualStats),
        p01: quantile(residualStats, 0.01),
        median: quantile(residualStats, 0.5),
        p99: quantile(residualStats, 0.99)
      },
      gainSelection: {
        chosen: bestGain,
        valAucAtChosen: bestValAuc,
        trainAucAtChosen: trainAucAtChosen,
        saturated: gainSaturated,
        selectedOn: 'the inner-validation battles of the training half',
        grid: gainGrid
      },
      gate: {
        metric: 'AUC over the battle-level hold-out (pooled rows); split identical to tools/fit_weights.js',
        aucBaseTest: aucBase,
        aucHybridTest: aucHybrid,
        delta: (aucBase === null || aucHybrid === null) ? null : aucHybrid - aucBase,
        clampBindRate: clampBindRate,
        meanAbsDelta: meanAbsDelta,
        bootstrap: boot,
        passed: passed,
        verdict: passed
          ? 'ADOPT: the paired bootstrap over battles excludes zero'
          : 'REJECT: the paired bootstrap over battles does not exclude zero'
      }
    },
    passed: passed,
    head: head
  };
}

/* ---------------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const out = {
    input: null, out: 'lib/mlp-residual.json', module: 'lib/mlp-residual.js',
    dim: DIM, hidden: 16, holdout: 5, clamp: 150, seed: 12345, bootstrap: 2000,
    epochs: 60, batch: 512, lr: 0.1, momentum: 0.9, l2: 1e-5, gainMax: 0, gainPoints: 16,
    forceModule: false, noEarlyStop: false, quiet: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--module') out.module = argv[++i];
    else if (a === '--dim') out.dim = parseInt(argv[++i], 10);
    else if (a === '--hidden') out.hidden = parseInt(argv[++i], 10);
    else if (a === '--holdout') out.holdout = parseInt(argv[++i], 10);
    else if (a === '--clamp') out.clamp = parseFloat(argv[++i]);
    else if (a === '--seed') out.seed = parseInt(argv[++i], 10);
    else if (a === '--bootstrap') out.bootstrap = parseInt(argv[++i], 10);
    else if (a === '--epochs') out.epochs = parseInt(argv[++i], 10);
    else if (a === '--batch') out.batch = parseInt(argv[++i], 10);
    else if (a === '--lr') out.lr = parseFloat(argv[++i]);
    else if (a === '--momentum') out.momentum = parseFloat(argv[++i]);
    else if (a === '--l2') out.l2 = parseFloat(argv[++i]);
    else if (a === '--gain-max') out.gainMax = parseFloat(argv[++i]);
    else if (a === '--gain-points') out.gainPoints = parseInt(argv[++i], 10);
    else if (a === '--force-module') out.forceModule = true;
    else if (a === '--no-early-stop') out.noEarlyStop = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

/** The generated data module. Written with real weights only when the gate passed. */
function moduleSource(artifact, includeWeights) {
  const header = '/* Showdown Tactician - lib/mlp-residual.js\n' +
    ' * GENERATED FILE - do not edit by hand; regenerate with\n' +
    ' *   node tools/train_mlp_residual.js --input training_data.json\n' +
    ' * The trained residual head for the frozen 128D linear evaluator. This module is the DATA\n' +
    ' * half only; the network and the clamp live in src/mlp_residual.js and the reviewable\n' +
    ' * artifact (with the hold-out AUCs and the paired bootstrap) is lib/mlp-residual.json.\n';
  if (!includeWeights) {
    return header +
      ' *\n * The gate did NOT pass on the corpus this was last run against, so the payload below is null:\n' +
      ' * a rejected head costs the content script nothing and cannot be switched on by a stray\n' +
      ' * config edit. Re-run the tool on a better corpus to regenerate it.\n' +
      ' * Gate: AUC ' + fmt(artifact.gate.aucBaseTest) + ' base -> ' + fmt(artifact.gate.aucHybridTest) +
      ' hybrid on the battle-level hold-out, paired bootstrap 95% CI [' +
      fmt(artifact.gate.bootstrap.low) + ', ' + fmt(artifact.gate.bootstrap.high) + '].\n' +
      ' */\n(function () {\n  "use strict";\n  window.ST = window.ST || {};\n' +
      '  window.ST.MLP_RESIDUAL = null;\n})();\n';
  }
  const payload = {
    dim: artifact.architecture.layers[0],
    hidden: artifact.architecture.layers[1],
    gain: artifact.gain,
    standardize: artifact.standardize,
    w1: artifact.weights.w1,
    b1: artifact.weights.b1,
    w2: artifact.weights.w2,
    b2: artifact.weights.b2
  };
  return header +
    ' * Gate: AUC ' + fmt(artifact.gate.aucBaseTest) + ' base -> ' + fmt(artifact.gate.aucHybridTest) +
    ' hybrid on the battle-level hold-out, paired bootstrap 95% CI [' +
    fmt(artifact.gate.bootstrap.low) + ', ' + fmt(artifact.gate.bootstrap.high) + '], ' +
    'ahead in ' + fmt(artifact.gate.bootstrap.shareAhead * 100) + '% of resamples. ' +
    (artifact.gate.passed ? 'ADOPTED' : 'NOT ADOPTED (written for inspection only)') + '.\n' +
    ' * Shape: { dim, hidden, gain, standardize:{mean,sd}, w1:[hidden*dim] row-major, b1, w2, b2 }.\n' +
    ' */\n(function () {\n  "use strict";\n  window.ST = window.ST || {};\n' +
    '  window.ST.MLP_RESIDUAL = ' + JSON.stringify(payload) + ';\n})();\n';
}

function fmt(v) {
  return typeof v === 'number' && isFinite(v) ? v.toFixed(4) : String(v);
}

function main(argv) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node tools/train_mlp_residual.js --input training_data.json ' +
      '[--hidden 16] [--clamp 150] [--holdout 5] [--epochs 60] [--batch 512] [--lr 0.1] ' +
      '[--l2 1e-5] [--bootstrap 2000] [--seed 12345] [--gain-max N] [--gain-points N] ' +
      '[--no-early-stop] [--force-module] ' +
      '[--out lib/mlp-residual.json] [--module lib/mlp-residual.js]');
    return 0;
  }
  if (!opts.input) throw new Error('--input is required');
  const payload = JSON.parse(fs.readFileSync(path.resolve(ROOT, opts.input), 'utf8'));

  const result = run(payload, opts);
  const artifact = result.artifact;
  const includeWeights = result.passed || opts.forceModule;
  // Recorded INSIDE the artifact so the invariant is checkable from the shipped files alone:
  // the generated module carries weights if and only if this is true (tests/mlp_check.js pins it).
  artifact.gate.moduleWeightsWritten = includeWeights;

  const outPath = path.resolve(ROOT, opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

  const modPath = path.resolve(ROOT, opts.module);
  fs.mkdirSync(path.dirname(modPath), { recursive: true });
  fs.writeFileSync(modPath, moduleSource(artifact, includeWeights));

  if (!opts.quiet) {
    const t = artifact.training;
    console.log('samples ' + t.samples + ' (' + t.trainSamples + ' train / ' + t.testSamples +
      ' test), positives ' + t.positives);
    console.log('  inner split of the training half: ' + t.innerTrainSamples + ' fit / ' +
      t.innerValSamples + ' validate  (grouped by battle, outer test never read)');
    const num = function (v) { return typeof v === 'number' && isFinite(v) ? v.toExponential(4) : 'n/a'; };
    console.log('  ' + t.epochsRun + ' epochs x batch ' + t.batch + ', ' +
      (t.earlyStopped ? 'early-stopped at epoch ' + t.bestEpoch + ' (the minimum of the inner-validation MSE)'
        : 'ran all ' + t.epochsRun + ' epochs' + (opts.noEarlyStop ? ' (--no-early-stop)' : '')) +
      '; MSE ' + num(t.finalTrainMse) + ' fit / ' + num(t.finalValMse) + ' validate');
    console.log('  battle-level hold-out: ' + (t.groupedHoldout ? t.holdoutBattles + ' battles' : 'NOT GROUPED') +
      ' (every ' + t.holdout + 'th battle), split shared with tools/fit_weights.js');
    console.log('  calibration z = ' + artifact.frozenBase.calibration.a.toFixed(6) + ' + ' +
      artifact.frozenBase.calibration.b.toExponential(4) + ' * raw');
    console.log('  residual: ' + fmt(artifact.residualStats.mean) + ' mean, median ' +
      fmt(artifact.residualStats.median) + ', p01 ' + fmt(artifact.residualStats.p01) +
      ', p99 ' + fmt(artifact.residualStats.p99));
    console.log('  gain ' + artifact.gain + ' chosen on the inner-validation battles (val AUC ' +
      fmt(artifact.gainSelection.valAucAtChosen) + '; on the rows it was fitted to, ' +
      fmt(artifact.gainSelection.trainAucAtChosen) + ')' +
      (artifact.gainSelection.saturated ? '  [SATURATED at the top of the ladder — the optimum is outside it]' : ''));
    console.log('  AUC base ' + fmt(artifact.gate.aucBaseTest) + ' -> hybrid ' + fmt(artifact.gate.aucHybridTest) +
      '  (delta ' + (artifact.gate.delta >= 0 ? '+' : '') + fmt(artifact.gate.delta) + ')');
    console.log('  mean |delta| ' + fmt(artifact.gate.meanAbsDelta) + ' of a clamp of ' + artifact.clamp +
      '; clamp binds on ' + fmt(artifact.gate.clampBindRate * 100) + '% of held-out rows');
    console.log('  paired bootstrap over ' + artifact.gate.bootstrap.B + ' resamples: median ' +
      fmt(artifact.gate.bootstrap.median) + ', 95% CI [' + fmt(artifact.gate.bootstrap.low) + ', ' +
      fmt(artifact.gate.bootstrap.high) + '], ahead in ' + fmt(artifact.gate.bootstrap.shareAhead * 100) + '%');
    console.log('  ' + artifact.gate.verdict);
    console.log('wrote ' + path.relative(ROOT, outPath) + ' and ' + path.relative(ROOT, modPath) +
      (includeWeights ? '' : ' (module written as null — gate not passed)'));
    console.log('');
    if (result.passed) {
      console.log('ADOPT: set config.evaluator.mlp.enabled = true in src/config.js, then run `npm test`.');
    } else {
      console.log('KEEP config.evaluator.mlp.enabled = false. The head did not clear the gate.');
    }
  }
  return result.passed ? 0 : 2;
}

module.exports = {
  DIM: DIM, makeRng: makeRng, quantile: quantile, mean: mean, sdOf: sdOf,
  matrixOf: matrixOf, loadEngine: loadEngine, rawScores: rawScores, calibrate: calibrate,
  sigmoid: sigmoid, standardizer: standardizer, standardizeMatrix: standardizeMatrix,
  initNet: initNet, trainHead: trainHead, headOutputs: headOutputs, gainLadder: gainLadder,
  splitTrainInner: splitTrainInner, pairedBootstrap: pairedBootstrap, moduleSource: moduleSource,
  run: run, parseArgs: parseArgs, main: main
};

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error('train_mlp_residual: ' + ((err && err.stack) || err));
    process.exit(1);
  }
}
