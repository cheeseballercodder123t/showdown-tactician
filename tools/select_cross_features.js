/* Showdown Tactician — tools/select_cross_features.js
 * Candidate interaction ("cross") features for the 128D evaluator, screened on the TRAINING half
 * of a corpus and written to a JSON file for review. This tool deliberately does NOT edit
 * src/config.js and does NOT fit a model: it ranks products of the base dims by how much they add
 * to the baseline's training-half likelihood, and the only honest verdict on a candidate set comes
 * from refitting it (append the pairs, run tools/fit_weights.js) and comparing the battle-level
 * hold-out AUC against the adopted vector's.
 *
 * Run me with:
 *   node tools/select_cross_features.js --input training_data.json \
 *        [--baseline lib/trained-weights.json] [--k 16] [--holdout 5] \
 *        [--min-nonzero-share 0.01] [--dedupe 0.98] [--ranked 256] [--out cross-candidates.json]
 *
 * WHY A PRODUCT OF DIMS IS NOT "A RULE"
 *   RULE 1 forbids writing game rules (or species synergies) down by hand, and this tool never
 *   does: every candidate is a plain product of two numbers the evaluator already measures, and
 *   the corpus decides which of them carries signal. The pool is the aggregate and active-mon
 *   dims (24..75 and 112..127) on purpose. The per-slot HP/faint dims (0..23) and the pairwise
 *   threat matrix (76..111) are per-slot identities: "party slot 1 times party slot 4" has no
 *   meaning that transfers between battles, and a product that only fits one team order is
 *   exactly the overfit this screen exists to avoid. Squares are included, because a single dim
 *   can be non-monotonic (Trick Room turns, boost sums).
 *
 * WHAT IT MEASURES, AND WHY THE TRAIN HALF ONLY
 *   The baseline's own training-half scores are the offset. Each candidate product then gets a
 *   joint two-parameter Newton fit (intercept + slope) on top of that offset, and is ranked by
 *   the log-likelihood gain ON THE TRAINING HALF; the test battles are never read. That makes the
 *   ranking a selector, not a significance test — an in-sample gain of a few dozen log-likelihood
 *   units on ~90k rows is noise, and picking the top K of a few thousand noisy candidates can
 *   absolutely overfit the training half. The measured guard is the refit.
 *
 * WHAT THE FIRST RUN FOUND (2026-10-11, the 3,712-battle corpus)
 *   The screen picked 16 crosses (TR x hazardDifferential, oppParalysis x oppRecoverySpent,
 *   mySleep x myRecoverySpent, ...), and the refit did NOT transfer: the 16-cross model scored
 *   0.7005 projected on the battle-level hold-out against the adopted 128D vector's 0.7049 (its
 *   raw 144 coefficients scored 0.6922, the overfit the projection partly absorbs), and the best
 *   four-cross subset's +0.0012 point estimate did not survive a paired bootstrap over battles
 *   (median 0.0000, 95% CI [-0.0047, +0.0015], ahead in 41% of resamples). Products of this
 *   vector's own dims carried no transferable signal on that corpus, so no cross block was
 *   adopted. The tool stays so a future corpus can re-run the test with one command; see the
 *   weight-pipeline section of README.md for the numbers in context.
 *
 * DETERMINISM
 *   No timestamps, no Math.random, no object-key-order dependence: same input, byte-identical
 *   output. The dedupe keeps the higher-ranked of two near-identical candidates (|r| > threshold).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const fitter = require('./fit_weights.js');

const ROOT = path.resolve(__dirname, '..');
const DIM = 128;

/* The pool: aggregate + active-mon dims, as documented above. 24..75 then 112..127. */
function candidatePool(features) {
  const n = features === undefined ? DIM : features;
  if (n !== DIM) {
    throw new Error('select_cross_features: the candidate pool is defined for the frozen 128D base ' +
      'layout, got ' + n + ' features');
  }
  const dims = [];
  for (let d = 24; d <= 75; d++) dims.push(d);
  for (let d = 112; d <= 127; d++) dims.push(d);
  const pairs = [];
  for (let i = 0; i < dims.length; i++) {
    for (let j = i; j < dims.length; j++) pairs.push([dims[i], dims[j]]);
  }
  return pairs;
}

/**
 * appendCrosses(x, pairs) -> a new row: the base features followed by the product of each pair,
 * f32-rounded the way a Float32Array store rounds (v[a] * v[b] assigned into one). This is the
 * same materialisation fit_weights.js applies when `--crosses` is given, and the convention a
 * future engine cross block would have to match bit for bit — no such block exists today, which
 * is the point of the study this tool serves.
 */
function appendCrosses(x, pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return x;
  const out = new Array(x.length + pairs.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i];
  for (let k = 0; k < pairs.length; k++) {
    out[x.length + k] = Math.fround(x[pairs[k][0]] * x[pairs[k][1]]);
  }
  return out;
}

function pearson(a, b) {
  const n = a.length;
  if (!n || b.length !== n) return null;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < n; i++) {
    const u = a[i], v = b[i];
    sa += u; sb += v; saa += u * u; sbb += v * v; sab += u * v;
  }
  const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
  return den > 0 ? (n * sab - sa * sb) / den : null;
}

/**
 * gainOf(z, y, offset) -> { gain, beta, alpha, iterations, converged }.
 * `z` is standardised IN PLACE (the caller owns it); `offset` is the baseline linear score per
 * row. Joint Newton on (intercept, slope) maximises the logistic likelihood of
 * offset + alpha + beta * z, and `gain` is how much that beats beta = 0. Deterministic.
 */
function gainOf(z, y, offset) {
  const n = z.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += z[i];
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = z[i] - mean; ss += d * d; }
  const sd = Math.sqrt(ss / n);
  for (let i = 0; i < n; i++) z[i] = (z[i] - mean) / sd;

  let alpha = 0, beta = 0, ll0 = null, ll = null, iterations = 0, converged = false;
  for (let it = 0; it < 8; it++) {
    iterations = it + 1;
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0, loglik = 0;
    for (let i = 0; i < n; i++) {
      const t = offset[i] + alpha + beta * z[i];
      const p = 1 / (1 + Math.exp(-t));
      const r = y[i] - p, wgt = p * (1 - p);
      ga += r; gb += r * z[i];
      haa += wgt; hab += wgt * z[i]; hbb += wgt * z[i] * z[i];
      loglik += y[i] ? -Math.log1p(Math.exp(-t)) : (-t - Math.log1p(Math.exp(-t)));
    }
    if (it === 0) ll0 = loglik;
    ll = loglik;
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (ga * hbb - gb * hab) / det;
    const db = (haa * gb - hab * ga) / det;
    alpha += da; beta += db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) { converged = true; break; }
  }
  return { gain: ll - ll0, beta: beta, alpha: alpha, iterations: iterations, converged: converged };
}

/** The split rule fit_weights.run uses: a provenance map groups only when its counts add up. */
function usableGroups(payload, rowCount) {
  if (!payload || !Array.isArray(payload.replays)) return null;
  const groups = payload.replays.map(function (p) { return (p && p.rows) || 0; });
  const total = groups.reduce(function (s, v) {
    return s + (typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0);
  }, 0);
  return (total > 0 && total === rowCount) ? groups : null;
}

/**
 * selectCrosses(payload, options) -> report object (no file I/O; the tests drive this directly).
 * options:
 *   baseline         { weights128: number[128], intercept: number } — REQUIRED. It supplies the
 *                    offset and must be fitted on the same split the corpus carries (the shipped
 *                    lib/trained-weights.json is).
 *   k                candidates to pick (default 16)
 *   holdout          battle hold-out k for the split the baseline was fitted with (default 5)
 *   minNonzeroShare  refuse a candidate seen in less than this share of TRAIN rows (default 0.01)
 *   dedupe           greedy |pearson| ceiling between picked candidates (default 0.98)
 *   rankedLimit      how many ranked candidates the report keeps (default 256)
 * Every `picked`/`ranked` entry carries a, b, gain, beta, non-zero count and share, plus the
 * Newton iteration count and convergence flag of its screening fit (an unconverged candidate's
 * gain is understated, so it has to be visible rather than trusted).
 */
function selectCrosses(payload, options) {
  const opts = options || {};
  const k = opts.k > 0 ? Math.floor(opts.k) : 16;
  const minShare = typeof opts.minNonzeroShare === 'number' ? opts.minNonzeroShare : 0.01;
  const dedupe = typeof opts.dedupe === 'number' ? opts.dedupe : 0.98;
  const rankedLimit = opts.rankedLimit > 0 ? Math.floor(opts.rankedLimit) : 256;
  const baseline = opts.baseline;
  if (!baseline || !Array.isArray(baseline.weights128) || baseline.weights128.length !== DIM) {
    throw new Error('select_cross_features: options.baseline must carry weights128 (128 numbers); ' +
      'pass --baseline lib/trained-weights.json (or the artifact of the same split)');
  }
  if (typeof baseline.intercept !== 'number' || !isFinite(baseline.intercept)) {
    throw new Error('select_cross_features: options.baseline.intercept must be a finite number');
  }

  const data = fitter.matrixOf(payload, DIM);
  const groups = usableGroups(payload, data.X.length);
  const split = fitter.splitIndices(data.X.length, opts.holdout || 5, groups);
  const train = split.train;
  if (train.length < 30) throw new Error('select_cross_features: fewer than 30 training rows; refusing');
  const trainY = train.map(function (i) { return data.y[i]; });
  const offset = new Float64Array(train.length);
  for (let k2 = 0; k2 < train.length; k2++) {
    const x = data.X[train[k2]];
    let s = baseline.intercept;
    for (let j = 0; j < DIM; j++) s += x[j] * baseline.weights128[j];
    offset[k2] = s;
  }

  const pool = candidatePool(DIM);
  const minNonzero = Math.ceil(minShare * train.length);
  const ranked = [];
  for (let c = 0; c < pool.length; c++) {
    const a = pool[c][0], b = pool[c][1];
    const z = new Float64Array(train.length);
    let nonzero = 0;
    for (let i = 0; i < train.length; i++) {
      const v = data.X[train[i]][a] * data.X[train[i]][b];
      z[i] = v;
      if (v !== 0) nonzero++;
    }
    if (nonzero < minNonzero) continue;
    let sum = 0;
    for (let i = 0; i < train.length; i++) sum += z[i];
    const mean = sum / train.length;
    let ss = 0;
    for (let i = 0; i < train.length; i++) { const d = z[i] - mean; ss += d * d; }
    if (!(Math.sqrt(ss / train.length) > 1e-12)) continue;
    const g = gainOf(z, trainY, offset);
    ranked.push({ a: a, b: b, gain: g.gain, beta: g.beta, nonzero: nonzero,
      share: nonzero / train.length, iterations: g.iterations, converged: g.converged });
  }
  ranked.sort(function (p, q) { return q.gain - p.gain; });

  /* Dedupe over the strongest candidates only, so the columns never have to be kept for all of
   * them: rebuild and re-standardise the top window, then greedily reject near-duplicates. */
  const window = ranked.slice(0, Math.max(k * 8, 64));
  const picked = [];
  for (const cand of window) {
    const z = new Float64Array(train.length);
    const a = cand.a, b = cand.b;
    for (let i = 0; i < train.length; i++) z[i] = data.X[train[i]][a] * data.X[train[i]][b];
    gainOf(z, trainY, offset);                       // standardises z in place; gain already known
    let duplicateOf = null;
    for (const p of picked) {
      const r = pearson(z, p.z);
      if (r !== null && Math.abs(r) > dedupe) { duplicateOf = p; break; }
    }
    if (duplicateOf) continue;
    picked.push({ a: a, b: b, gain: cand.gain, beta: cand.beta, nonzero: cand.nonzero,
      share: cand.share, iterations: cand.iterations, converged: cand.converged, z: z });
    if (picked.length === k) break;
  }

  return {
    generator: 'tools/select_cross_features.js',
    features: DIM,
    candidates: pool.length,
    screened: ranked.length,
    split: {
      trainRows: train.length,
      testRows: split.test.length,
      groupedHoldout: split.grouped,
      holdoutBattles: split.grouped ? split.battles : 0,
      holdout: split.holdout
    },
    thresholds: { k: k, minNonzeroShare: minShare, dedupe: dedupe, holdout: split.holdout },
    pool: 'dims 24..75 and 112..127 (aggregate and active-mon state, squares included)',
    /* `iterations`/`converged` are the Newton cost of each candidate's screening fit: a candidate
     * that hit the loop's cap without converging has an understated gain, and the reader has to be
     * able to see that rather than trust the number. */
    picked: picked.map(function (p) {
      return { a: p.a, b: p.b, gain: p.gain, beta: p.beta, nonzero: p.nonzero, share: p.share,
        iterations: p.iterations, converged: p.converged };
    }),
    ranked: ranked.slice(0, rankedLimit)
  };
}

/* ---------------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const out = {
    input: null, baseline: 'lib/trained-weights.json', out: null, k: 16, holdout: 5,
    minNonzeroShare: 0.01, dedupe: 0.98, ranked: 256, top: 30, quiet: false, help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--baseline') out.baseline = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--k') out.k = parseInt(argv[++i], 10);
    else if (a === '--holdout') out.holdout = parseInt(argv[++i], 10);
    else if (a === '--min-nonzero-share') out.minNonzeroShare = parseFloat(argv[++i]);
    else if (a === '--dedupe') out.dedupe = parseFloat(argv[++i]);
    else if (a === '--ranked') out.ranked = parseInt(argv[++i], 10);
    else if (a === '--top') out.top = parseInt(argv[++i], 10);
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

function main(argv) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node tools/select_cross_features.js --input training_data.json ' +
      '[--baseline lib/trained-weights.json] [--k 16] [--holdout 5] [--min-nonzero-share 0.01] ' +
      '[--dedupe 0.98] [--ranked 256] [--out cross-candidates.json]');
    return 0;
  }
  if (!opts.input) throw new Error('--input is required');
  const payload = JSON.parse(fs.readFileSync(path.resolve(ROOT, opts.input), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(path.resolve(ROOT, opts.baseline), 'utf8'));
  const report = selectCrosses(payload, {
    baseline: baseline, k: opts.k, holdout: opts.holdout, minNonzeroShare: opts.minNonzeroShare,
    dedupe: opts.dedupe, rankedLimit: opts.ranked
  });
  report.input = opts.input;
  report.baseline = opts.baseline;
  if (opts.out) {
    const target = path.resolve(ROOT, opts.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
    if (!opts.quiet) console.log('wrote ' + path.relative(ROOT, target));
  }
  if (!opts.quiet) {
    console.log('candidates ' + report.candidates + ' screened ' + report.screened +
      ' (' + report.split.trainRows + ' train rows, ' +
      (report.split.groupedHoldout ? report.split.holdoutBattles + ' battles' : 'row split') + ')');
    console.log('\nselected ' + report.picked.length + ':');
    report.picked.forEach(function (p, i) {
      console.log(String(i + 1).padStart(3) + '. [' + p.a + ',' + p.b + '] gain ' + p.gain.toFixed(1) +
        '  beta ' + p.beta.toFixed(4) + '  nz ' + (100 * p.share).toFixed(2) + '%');
    });
    console.log('\nThe ranking is an in-sample selector, not a verdict: append the pairs with ' +
      'appendCrosses/pairs JSON, refit with tools/fit_weights.js, and compare the battle-level ' +
      'hold-out before adopting anything.');
  }
  return 0;
}

module.exports = {
  DIM: DIM, candidatePool: candidatePool, appendCrosses: appendCrosses, pearson: pearson,
  gainOf: gainOf, usableGroups: usableGroups, selectCrosses: selectCrosses,
  parseArgs: parseArgs, main: main
};

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error('select_cross_features: ' + ((err && err.message) || err));
    process.exit(1);
  }
}
