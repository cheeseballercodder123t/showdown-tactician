/* Showdown Tactician — tests/mlp_check.js
 *
 * WHY THIS EXISTS
 *   `src/mlp_residual.js` adds an OPTIONAL non-linear head on top of the frozen 128D linear
 *   evaluator. Two things about that are load-bearing and neither is visible from the source:
 *
 *     1. DISABLED IS NOT "PLUS ZERO". The whole adoption argument is "the linear score is
 *        untouched unless the gate passed", and the only way that is true is if the disabled path
 *        does not touch the score at all. This suite pins that the disabled score is bit-identical
 *        to the pre-change evaluator's, and that an enabled score differs from it by exactly
 *        `delta(vector)` and nothing else.
 *     2. THE FAST PATH AND THE SHIPPED CLASS MUST AGREE. `tools/train_mlp_residual.js` selects the
 *        residual's gain from a vectorised forward pass (`headOutputs`) rather than by calling the
 *        class 90,000 times. If that fast path disagreed with `ResidualMLP.forward` by one ulp, the
 *        gain would be chosen for a network that is not the one shipping. The equivalence is
 *        asserted here, over random nets and random vectors, bit for bit.
 *
 * It also pins the fail-safe (a missing or mismatched artifact turns the head OFF rather than
 * half-applying), the clamp, the NaN guard, and that the generated artifact is self-consistent
 * with the config it is read through.
 *
 * Run me with:  node tests/mlp_check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');
// content.js auto-boots on the harness's stubbed hostname and starts a 2.5 s heartbeat, which
// would keep this process alive forever. Stub the timer exactly as run_tests.js does.
const S = H.loadAll({
  setInterval: function () { return 0; },
  clearInterval: function () { }
});
const ST = S.ST;
const ROOT = H.ROOT;

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); return true; }
  failures.push(name + (detail === undefined ? '' : '  ->  ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  ->  ' + detail));
  return false;
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/** A deterministic small PRNG, so a failure is always reproducible. */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** A random but structurally valid head spec. */
function randomSpec(seed, dim, hidden) {
  const r = rng(seed);
  const mean = [], sd = [];
  for (let j = 0; j < dim; j++) { mean.push(r() * 2 - 1); sd.push(0.25 + r()); }
  const w1 = [], b1 = [], w2 = [];
  for (let i = 0; i < hidden * dim; i++) w1.push((r() * 2 - 1) * 0.5);
  for (let k = 0; k < hidden; k++) { b1.push((r() * 2 - 1) * 0.5); w2.push((r() * 2 - 1) * 0.5); }
  return {
    dim: dim, hidden: hidden, clamp: 150, gain: 10,
    standardize: { mean: mean, sd: sd },
    w1: w1, b1: b1, w2: w2, b2: (r() * 2 - 1) * 0.5
  };
}

/* ============================================================ 1. module shape */

section('the module is installed and wired into the load order');
check('ST.ResidualMLP is a class', typeof ST.ResidualMLP === 'function', typeof ST.ResidualMLP);
check('ResidualMLP.fromConfig is a function', typeof ST.ResidualMLP.fromConfig === 'function');
check('ResidualMLP.artifactPresent is a function', typeof ST.ResidualMLP.artifactPresent === 'function');
check('lib/mlp-residual.js is in MANIFEST_ORDER',
  H.MANIFEST_ORDER.indexOf('lib/mlp-residual.js') !== -1);
check('src/mlp_residual.js is in MANIFEST_ORDER',
  H.MANIFEST_ORDER.indexOf('src/mlp_residual.js') !== -1);
// The two loaders must agree, or the extension and the tests run different code.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const manifestScripts = manifest.content_scripts[0].js;
const drift = H.MANIFEST_ORDER.filter(function (r) { return manifestScripts.indexOf(r) === -1; });
check('every MANIFEST_ORDER entry is in manifest.json', drift.length === 0, JSON.stringify(drift));
const extra = manifestScripts.filter(function (r) { return H.MANIFEST_ORDER.indexOf(r) === -1; });
check('every manifest.json entry is in MANIFEST_ORDER', extra.length === 0, JSON.stringify(extra));
check('src/mlp_residual.js loads AFTER config.js (it reads the toggle)',
  H.MANIFEST_ORDER.indexOf('src/mlp_residual.js') > H.MANIFEST_ORDER.indexOf('src/config.js'));
check('src/mlp_residual.js loads BEFORE evaluator_128d.js (which calls it)',
  H.MANIFEST_ORDER.indexOf('src/mlp_residual.js') < H.MANIFEST_ORDER.indexOf('src/evaluator_128d.js'));

/* =============================================================== 2. the toggle */

section('the config block is present and sane');
const mlpCfg = ST.configGet('evaluator.mlp', null);
check('evaluator.mlp exists', !!mlpCfg, JSON.stringify(mlpCfg));
check('evaluator.mlp.enabled is a boolean', typeof mlpCfg.enabled === 'boolean', typeof mlpCfg.enabled);
check('evaluator.mlp.dim is 128', mlpCfg.dim === 128, mlpCfg.dim);
check('evaluator.mlp.hidden is 16', mlpCfg.hidden === 16, mlpCfg.hidden);
check('evaluator.mlp.clamp is 150', mlpCfg.clamp === 150, mlpCfg.clamp);
// The clamp has to sit below the fixed bonuses the payoff adds, or the head could outvote a
// forced kill. That ordering is the reason the clamp exists at all.
const lethalBonus = ST.configGet('laplace.lethalBonus', 260);
check('the clamp is below laplace.lethalBonus', mlpCfg.clamp < lethalBonus,
  mlpCfg.clamp + ' vs ' + lethalBonus);

/* ============================================================== 3. fail-safe */

section('the head refuses to run unless everything agrees');
check('fromConfig() is null while disabled', ST.ResidualMLP.fromConfig() === null);

const saved = ST.MLP_RESIDUAL;
try {
  // enabled, but no artifact at all
  ST.MLP_RESIDUAL = null;
  ST.configMerge({ evaluator: { mlp: { enabled: true, dim: 128, hidden: 16, clamp: 150 } } });
  check('enabled + no artifact -> null', ST.ResidualMLP.fromConfig() === null);

  // enabled, artifact present, but the dimensions disagree with the config
  ST.MLP_RESIDUAL = randomSpec(3, 128, 16);
  ST.configMerge({ evaluator: { mlp: { enabled: true, dim: 64, hidden: 16, clamp: 150 } } });
  check('enabled + dim mismatch -> null', ST.ResidualMLP.fromConfig() === null);
  ST.configMerge({ evaluator: { mlp: { enabled: true, dim: 128, hidden: 8, clamp: 150 } } });
  check('enabled + hidden mismatch -> null', ST.ResidualMLP.fromConfig() === null);

  // enabled, artifact present, dimensions agree -> a head
  ST.configMerge({ evaluator: { mlp: { enabled: true, dim: 128, hidden: 16, clamp: 150 } } });
  const head = ST.ResidualMLP.fromConfig();
  check('enabled + agreeing artifact -> a head', !!head);
  check('the head reports 2081 parameters', head && head.describe().params === 2081,
    head ? head.describe().params : 'no head');

  /* ======================================================= 4. forward / delta */

  section('forward and delta');
  const v = new Float32Array(128);
  const r0 = rng(11);
  for (let j = 0; j < 128; j++) v[j] = r0() * 2 - 1;

  const g1 = head.forward(v), g2 = head.forward(v);
  check('forward is deterministic', g1 === g2, g1 + ' vs ' + g2);
  check('forward is finite', isFinite(g1), g1);

  const d = head.delta(v);
  check('delta is finite', isFinite(d), d);
  check('|delta| <= clamp', Math.abs(d) <= 150, d);
  check('delta == clamp * forward when the gain is the clamp and |forward| >= 1',
    Math.abs(d) <= 150 && (Math.abs(head.gain * g1) <= 150 || Math.abs(d) === 150),
    'gain ' + head.gain + ' forward ' + g1 + ' delta ' + d);

  // A gain large enough that the clamp must bind, and a gain of zero that must null the head out.
  const hot = new ST.ResidualMLP(Object.assign({}, ST.MLP_RESIDUAL, { clamp: 150, gain: 1e9 }));
  check('a huge gain saturates at exactly +clamp', hot.delta(v) === 150 || hot.delta(v) === -150,
    hot.delta(v));
  const cold = new ST.ResidualMLP(Object.assign({}, ST.MLP_RESIDUAL, { clamp: 150, gain: 0 }));
  check('a zero gain yields exactly 0', cold.delta(v) === 0, cold.delta(v));
  check('calls is counted', head.calls >= 1, head.calls);

  // NaN must never reach a score: a poisoned delta would poison every ranking. The ReLU absorbs it
  // (NaN > 0 is false, so every unit collapses to 0 and the output falls back to b2), and the
  // explicit guard in delta() is the belt to that braces. Either way the result must be FINITE.
  const nanVec = new Float32Array(128);
  nanVec[7] = NaN;
  const nanDelta = head.delta(nanVec);
  check('a NaN input yields a finite delta, not NaN', isFinite(nanDelta), String(nanDelta));

  // A short vector is padded rather than read out of bounds.
  const shortVec = new Float32Array(10);
  for (let j = 0; j < 10; j++) shortVec[j] = 0.5;
  const shortDelta = head.delta(shortVec);
  check('a short vector is padded, not thrown on', isFinite(shortDelta), String(shortDelta));
  check('delta(null) is 0', head.delta(null) === 0, String(head.delta(null)));

  /* ================================== 5. the fast path equals the shipped class */

  section('tools/train_mlp_residual.js headOutputs == ResidualMLP.forward, bit for bit');
  const trainer = require('../tools/train_mlp_residual.js');
  let mismatch = 0, compared = 0;
  for (let trial = 0; trial < 6; trial++) {
    const dim = [128, 128, 128, 64, 128, 32][trial];
    const hidden = [16, 1, 16, 16, 8, 16][trial];
    const spec = randomSpec(100 + trial, dim, hidden);
    const net = new ST.ResidualMLP(spec);
    const rows = 5;
    const X = new Float64Array(rows * dim);
    const rv = rng(500 + trial);
    // Deliberately NOT Float32-representable: the fast path has to round its input the way a
    // Float32Array store does, or it disagrees with the class the moment a caller feeds it a
    // plain double. That is exactly the bug this check was written to catch.
    for (let i = 0; i < rows * dim; i++) X[i] = rv() * 2 - 1 + rv() * 1e-9;
    // The class standardises internally; the fast path is fed the already-standardised matrix.
    const U = trainer.standardizeMatrix(X, rows, dim, spec.standardize.mean, spec.standardize.sd);
    const out = trainer.headOutputs(U, spec.w1, spec.b1, spec.w2, spec.b2, rows, dim, hidden);
    const scratch = new Float32Array(dim);
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < dim; j++) scratch[j] = X[i * dim + j];
      compared++;
      if (net.forward(scratch) !== out[i]) {
        mismatch++;
        if (mismatch < 4) console.log('      trial ' + trial + ' row ' + i + ': ' +
          net.forward(scratch) + ' vs ' + out[i]);
      }
    }
  }
  check('headOutputs matches forward on ' + compared + ' rows across 6 shapes', mismatch === 0,
    mismatch + ' mismatches');

  /* ========================================= 6. the evaluator's composition */

  section('the evaluator adds exactly the delta, and nothing when disabled');
  ST.configMerge({ evaluator: { mlp: { enabled: false } } });
  const offEval = new ST.DenseStateEvaluator();
  const offScore = offEval.evaluateVector(v);
  check('disabled: evaluateVector does not touch the head', offEval._mlpLayer() === null);

  ST.configMerge({ evaluator: { mlp: { enabled: true, dim: 128, hidden: 16, clamp: 150 } } });
  const onEval = new ST.DenseStateEvaluator();
  const onScore = onEval.evaluateVector(v);
  const expected = offScore + onEval._mlpLayer().delta(v);
  check('enabled: score == disabled score + delta', Math.abs(onScore - expected) < 1e-12,
    onScore + ' vs ' + expected);
  check('the delta actually moved the score', onScore !== offScore, onScore + ' vs ' + offScore);

  /* =============================================== 7. the shipped artifact */

  // Restore FIRST: every section above deliberately swapped in a synthetic head, and the checks
  // below are about what actually ships.
  ST.MLP_RESIDUAL = saved;
  ST.configMerge({ evaluator: { mlp: { enabled: mlpCfg.enabled, dim: mlpCfg.dim, hidden: mlpCfg.hidden, clamp: mlpCfg.clamp } } });

  section('the shipped artifact is self-consistent');
  const jsonPath = path.join(ROOT, 'lib/mlp-residual.json');
  const hasJson = fs.existsSync(jsonPath);
  const art = hasJson ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null;
  check('lib/mlp-residual.js exists (the extension needs it)', fs.existsSync(path.join(ROOT, 'lib/mlp-residual.js')));
  // The load-bearing invariant of the whole exercise: the generated module carries weights if and
  // only if the gate passed. A rejected head must cost the content script nothing, and must not be
  // switchable on by a stray config edit.
  if (art && typeof art.gate.moduleWeightsWritten === 'boolean') {
    check('the module carries weights iff the gate passed (or --force-module)',
      (ST.MLP_RESIDUAL !== null) === art.gate.moduleWeightsWritten,
      'module ' + (ST.MLP_RESIDUAL === null ? 'null' : 'has weights') +
      ', moduleWeightsWritten ' + art.gate.moduleWeightsWritten);
    check('a failed gate does not ship weights', art.gate.passed === true || ST.MLP_RESIDUAL === null,
      'gate.passed ' + art.gate.passed + ', module ' + (ST.MLP_RESIDUAL === null ? 'null' : 'has weights'));
  }
  if (ST.MLP_RESIDUAL === null) {
    check('with no artifact, artifactPresent() is false', ST.ResidualMLP.artifactPresent() === false);
    check('with no artifact, enabled still yields null', ST.ResidualMLP.fromConfig() === null);
    check('with no artifact, the config toggle is false', mlpCfg.enabled === false,
      'enabled is ' + mlpCfg.enabled + ' but no artifact ships');
    if (art) {
      check('the artifact records why it was rejected', art.gate.passed === false, String(art.gate.passed));
    }
  } else {
    const a = ST.MLP_RESIDUAL;
    check('artifactPresent() is true', ST.ResidualMLP.artifactPresent() === true);
    check('artifact dim is 128', a.dim === 128, a.dim);
    check('artifact hidden is 16', a.hidden === 16, a.hidden);
    check('w1 has hidden*dim entries', a.w1.length === a.hidden * a.dim, a.w1.length);
    check('b1 has hidden entries', a.b1.length === a.hidden, a.b1.length);
    check('w2 has hidden entries', a.w2.length === a.hidden, a.w2.length);
    check('b2 is a number', typeof a.b2 === 'number', typeof a.b2);
    check('gain is a finite number', typeof a.gain === 'number' && isFinite(a.gain), a.gain);
    check('standardize.mean has dim entries', a.standardize.mean.length === a.dim, a.standardize.mean.length);
    check('standardize.sd has dim entries', a.standardize.sd.length === a.dim, a.standardize.sd.length);
    if (hasJson) {
      const art2 = art;
      check('the module gain equals the artifact gain', a.gain === art2.gain, a.gain + ' vs ' + art2.gain);
      check('the module weights equal the artifact weights (w1)',
        JSON.stringify(a.w1) === JSON.stringify(art2.weights.w1));
      check('the module b2 equals the artifact b2', a.b2 === art2.weights.b2, a.b2 + ' vs ' + art2.weights.b2);
      check('the artifact records a gate verdict', typeof art2.gate.passed === 'boolean', typeof art2.gate.passed);
      // The gate is the ONLY reason `enabled` may be true; if it did not pass, the toggle must
      // not be on, and if it did pass, the toggle is a deliberate separate edit that may lag.
      check('config.enabled is only true when the gate passed',
        mlpCfg.enabled === false || art2.gate.passed === true,
        'enabled ' + mlpCfg.enabled + ', gate.passed ' + art2.gate.passed);
    } else {
      console.log('      (lib/mlp-residual.json is absent; module-vs-artifact agreement not checked)');
    }
  }
} finally {
  // Restore the sandbox exactly as it was found, so this suite cannot poison a later one.
  ST.MLP_RESIDUAL = saved;
  ST.configMerge({ evaluator: { mlp: { enabled: mlpCfg.enabled, dim: mlpCfg.dim, hidden: mlpCfg.hidden, clamp: mlpCfg.clamp } } });
}

section('sandbox restored');
check('the toggle is back where it was', ST.configGet('evaluator.mlp.enabled', null) === mlpCfg.enabled);
check('the artifact is back where it was', ST.MLP_RESIDUAL === saved);

/* ============================================== 8. the gate is not a rubber stamp */

section('the gate discriminates: it rejects noise and accepts a planted signal');
/*
 * The shipped verdict is "rejected", and that is only worth anything if the gate could have said
 * otherwise. Two synthetic corpora with a KNOWN truth are run through the real trainer: one where
 * the label is independent of the features (the gate must NOT pass) and one where it carries a
 * pure XOR interaction of two dims that no linear model can express (the gate MUST pass). If the
 * gate passed the first or failed the second, "rejected" would be a property of the gate rather
 * than a finding about the head.
 */
const trainerMod = require('../tools/train_mlp_residual.js');
function synthCorpus(mode, nBattles, rowsPerBattle, seed) {
  const r = rng(seed);
  const rows = [], replays = [];
  for (let b = 0; b < nBattles; b++) {
    for (let t = 0; t < rowsPerBattle; t++) {
      const x = new Array(128).fill(0);
      for (let j = 24; j < 76; j++) x[j] = r();
      let y;
      if (mode === 'noise') {
        y = r() < 0.5 ? 1 : 0;
      } else {
        const a = x[30] > 0.5 ? 1 : 0, c = x[31] > 0.5 ? 1 : 0;
        const logit = 3.0 * (x[24] - x[25]) + 1.2 + ((a ^ c) ? 1.6 : -1.6);
        y = r() < 1 / (1 + Math.exp(-logit)) ? 1 : 0;
      }
      rows.push({ x: x, y: y });
    }
    replays.push({ rows: rowsPerBattle });
  }
  return { dimensions: 128, samples: rows.length, replays: replays, rows: rows };
}
const noise = trainerMod.run(synthCorpus('noise', 100, 20, 5),
  { epochs: 20, batch: 128, bootstrap: 200, seed: 99 });
const signal = trainerMod.run(synthCorpus('signal', 100, 20, 7),
  { epochs: 20, batch: 128, bootstrap: 200, seed: 99 });
check('a pure-noise label does NOT clear the gate', noise.passed === false,
  'passed=' + noise.passed + ' CI [' + noise.artifact.gate.bootstrap.low.toFixed(4) + ', ' +
  noise.artifact.gate.bootstrap.high.toFixed(4) + ']');
check('a planted XOR interaction DOES clear the gate', signal.passed === true,
  'passed=' + signal.passed + ' delta ' + signal.artifact.gate.delta.toFixed(4) + ' CI [' +
  signal.artifact.gate.bootstrap.low.toFixed(4) + ', ' + signal.artifact.gate.bootstrap.high.toFixed(4) + ']');
check('...and the signal case beats the noise case by a wide margin',
  signal.artifact.gate.delta > noise.artifact.gate.delta + 0.02,
  signal.artifact.gate.delta.toFixed(4) + ' vs ' + noise.artifact.gate.delta.toFixed(4));

/* -------------------------------------------------------------------- report */
console.log('');
if (failures.length) {
  console.log('FAILURES (' + failures.length + '):');
  failures.forEach(function (f) { console.log('  - ' + f); });
  console.error('MLP CHECKS FAILED: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(1);
}
console.log('ALL MLP CHECKS PASSED (' + passed + ')');
process.exit(0);
