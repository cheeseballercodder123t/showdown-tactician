/* Showdown Tactician — tests/config_check.js
 * Rule 4: src/config.js is the single source of truth for every heuristic in the engine.
 * This suite is the promise its own header makes — "tests/config_check.js proves that mutation
 * flows through, and that the 128D weight layout this file generates is bit-identical to the
 * vector the evaluator shipped with".
 *
 * It proves four things:
 *   1. the module is installed and reachable through the dotted-path reader, with the fallback
 *      semantics documented in its header;
 *   2. every key the modules consume still EXISTS — this is the guard that stops a module from
 *      silently reverting to a hardcoded literal after somebody deletes a key (a module reading
 *      `configGet('tempo.rhythmHurt', 0.85)` would keep working, and only this inventory would
 *      notice that the config no longer has a say);
 *   3. the 128D weight vector is FROZEN — the expected vector is built from the literals below
 *      (the adopted spec and its calibration), not read back out of the config, so editing
 *      config.js's weights fails this test and forces a deliberate decision about the vector;
 *      the layout it is built with is the frozen one documented in ARCHITECTURE.md §3;
 *   4. mutation flows through to the modules that consume it (a freshly constructed engine and
 *      evaluator pick up the new numbers), and the sandbox is restored exactly as it was found.
 *
 * What this suite does NOT prove: that the numbers are GOOD (they are tuned elsewhere), that a
 * module which reads a config path at load time re-reads it after a later mutation (module-load
 * constants are captured once by design), or anything about the browser UI.
 *
 * Usage:  node tests/config_check.js
 * Exit code 0 = every check passed.
 */
'use strict';
const H = require('./harness.js');

/* --------------------------------------------------------------- tiny assert */

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; return true; }
  failures.push(name + (detail !== undefined ? '  ->  ' + detail : ''));
  return false;
}
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  return check(name, ok, ok ? undefined : 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function section(title) {
  console.log('\n=== ' + title + ' ===');
}

/** Construct something that might throw, so one broken constructor cannot abort the suite. */
function attempt(fn) {
  try { return { value: fn(), error: null }; }
  catch (e) { return { value: null, error: String((e && e.message) || e) }; }
}

/** Float32Array -> plain array, so eq() can compare it and print a readable diff. */
function nums(typed) {
  const out = [];
  for (let i = 0; i < typed.length; i++) out.push(typed[i]);
  return out;
}

const S = H.loadAll({
  setInterval: function () { return 0; },
  clearInterval: function () { },
  fetch: function () { return Promise.resolve({ ok: false, json: function () { return Promise.resolve({}); } }); }
});
const ST = S.ST;

/* Every read goes through these two so that a missing config module produces a readable
 * failure report instead of an uncaught TypeError halfway through the file. Section 1 still
 * asserts the REAL functions exist and behave; these wrappers only keep the other sections
 * from crashing while it does. */
function cfg(path, fallback) {
  const read = ST.configGet;
  return typeof read === 'function' ? read(path, fallback) : fallback;
}
function snap() {
  const clone = ST.configSnapshot;
  return typeof clone === 'function' ? clone() : {};
}

/* The tree as this suite found it. The last section asserts we leave it exactly like this. */
const PRISTINE = typeof ST.configSnapshot === 'function' ? snap() : null;

/* ================================================================== 1. shape */

section('config module is installed');
check('config.js is loaded (implicitly: it is in MANIFEST_ORDER)', !!ST.CONFIG, typeof ST.CONFIG);
check('configGet is a function', typeof ST.configGet === 'function', typeof ST.configGet);
check('configSnapshot is a function', typeof ST.configSnapshot === 'function', typeof ST.configSnapshot);
check('configMerge is a function', typeof ST.configMerge === 'function', typeof ST.configMerge);

check('version is a string', typeof ST.CONFIG.version === 'string', ST.CONFIG.version);
check('laplace.K is a number', typeof cfg('laplace.K') === 'number', typeof cfg('laplace.K'));
check('dotted path reaches a nested leaf', cfg('tempo.chip.rocks') === 12.5, cfg('tempo.chip.rocks'));
check('dotted path reaches a nested object', !!cfg('evaluator.weights', null), typeof cfg('evaluator.weights', null));
check('a missing path returns the fallback', cfg('nope.nope', 'default') === 'default', cfg('nope.nope', 'default'));
check('a missing path returns undefined without a fallback', cfg('laplace.notAKey') === undefined, cfg('laplace.notAKey'));
check('no path returns the fallback', cfg(null, 'x') === 'x', cfg(null, 'x'));
check('walking through a scalar returns the fallback', cfg('laplace.K.deeper', 'x') === 'x', cfg('laplace.K.deeper', 'x'));

/* =========================================================== 2. key inventory */

section('every key the modules consume still exists');

/* Hand-written on purpose: this list IS the contract between config.js and its consumers.
 * Keys marked (inventory) are the ones this test was asked to cover; the rest are the other
 * tunables the modules read, included so a deletion anywhere fails loudly. */
const INVENTORY = [
  // laplace
  'laplace.K', 'laplace.temperature', 'laplace.worldBlend.avg', 'laplace.worldBlend.min',
  'laplace.maxOppActions', 'laplace.vetoScore', 'laplace.lethalBonus', 'laplace.maxSwitchFallback',
  'laplace.struggleChipPercent', 'laplace.switchAteHitBonus',
  'laplace.nash.enabled', 'laplace.nash.iterations',
  // quiescence (the setup punisher: the two replies the 1-ply matrix priced as no-ops)
  'laplace.quiescence.enabled', 'laplace.quiescence.extendSetup', 'laplace.quiescence.blockProtect',
  // the four gated policy tiers (each `enabled: false` until it has been measured, so a deleted
  // key here is a module that silently stops being registered)
  'laplace.scouting.enabled', 'laplace.scouting.maxBounty', 'laplace.scouting.minEntropy',
  'laplace.profile.enabled', 'laplace.profile.minSamples', 'laplace.profile.flightThreshold',
  'laplace.profile.aggressionThreshold', 'laplace.profile.maxFactor', 'laplace.profile.maxHistory',
  'laplace.wincon.enabled', 'laplace.wincon.maxBounty', 'laplace.wincon.maxTargets',
  'laplace.endgame.enabled', 'laplace.endgame.maxBodies', 'laplace.endgame.maxDepth',
  'laplace.endgame.nodeBudget',
  // sampler
  'sampler.K', 'sampler.maxTeam', 'sampler.maxResample', 'sampler.minSetWeight',
  // usage overlay (the monthly chaos sync writes the DATA; these two are the knobs)
  'usage.enabled', 'usage.floor',
  // clock (opponent deliberation telemetry)
  'clock.enabled', 'clock.fastMs', 'clock.slowMs', 'clock.minSamples', 'clock.maxHistory',
  'clock.switchKeepThreshold', 'clock.switchPrior.auto', 'clock.switchPrior.normal',
  'clock.switchPrior.agonised', 'clock.switchPrior.unknown',
  // evaluator
  'evaluator.dim', 'evaluator.team', 'evaluator.scale', 'evaluator.tanhDenominator',
  'evaluator.unknownHpDefault', 'evaluator.threatEffSpan', 'evaluator.offenseBasePowerCap',
  'evaluator.boostSumScale', 'evaluator.statusDifferentialDivisor', 'evaluator.speedEdgeSpan',
  'evaluator.recoveryPPBudget', 'evaluator.hazardChip.rocks', 'evaluator.hazardChip.spikesPerLayer',
  'evaluator.hazardChip.toxicSpikes', 'evaluator.hazardChip.stickyWeb', 'evaluator.hazardChip.divisor',
  'evaluator.protectRhythm.protectedLastTurn', 'evaluator.protectRhythm.consecutiveProtects',
  'evaluator.weights.hp', 'evaluator.weights.fainted', 'evaluator.weights.status',
  'evaluator.weights.boosts', 'evaluator.weights.hazards', 'evaluator.weights.trickRoom',
  'evaluator.weights.items', 'evaluator.weights.threat', 'evaluator.weights.threatActive',
  'evaluator.weights.macro', 'evaluator.fitScale',
  // tempo
  'tempo.protectFresh', 'tempo.protectAfterOne', 'tempo.protectAfterTwo', 'tempo.rhythmNone',
  'tempo.rhythmHurt', 'tempo.rhythmDefault', 'tempo.hurtHpBelow', 'tempo.healthyHpAbove',
  'tempo.healthyPenalty', 'tempo.trickRoomBonus', 'tempo.observedProtectBonus',
  'tempo.cannotProtectPenalty', 'tempo.maxProtectProbability', 'tempo.bulkThreshold',
  'tempo.initiativeScale', 'tempo.threatScale', 'tempo.safeHpDefault', 'tempo.bunkerThreshold',
  'tempo.bunkerMaskBonus', 'tempo.resistThreshold',
  'tempo.chip.rocks', 'tempo.chip.spikesPerLayer', 'tempo.chip.toxicSpikes', 'tempo.chip.stickyWeb',
  'tempo.chip.toxBase', 'tempo.chip.toxicTurnsDivisor', 'tempo.chip.burn', 'tempo.chip.scale',
  // veto
  'veto.protectRhythmThreshold', 'veto.loneTRSetterThreat', 'veto.maxLog',
  'veto.contactPunishHp', 'veto.suckerPunchSetupHp',
  'veto.codes.VETO1', 'veto.codes.VETO2', 'veto.codes.VETO3', 'veto.codes.VETO4',
  'veto.codes.VETO5', 'veto.codes.VETO6', 'veto.codes.VETO7',
  'veto.codes.VETO8', 'veto.codes.VETO9', 'veto.codes.VETO10', 'veto.codes.VETO11',
  'veto.codes.VETO12',
  // the five board-state vetoes are policy, so each one is also a switch
  'veto.wastedHazardClear', 'veto.consecutiveProtect', 'veto.magicBounceRedirect',
  'veto.saturatedHazard', 'veto.redundantField', 'veto.redundantFieldMinTurns',
  // trickRoom
  'trickRoom.turns', 'trickRoom.speedRankBase', 'trickRoom.alertFinal', 'trickRoom.alertTwoLeft',
  'trickRoom.maxHistory',
  // hud
  'hud.high', 'hud.mid', 'hud.low', 'hud.bannerSep',
  'hud.confidenceLabels.high', 'hud.confidenceLabels.mid', 'hud.confidenceLabels.low', 'hud.confidenceLabels.veto',
  'hud.lethal.guaranteed', 'hud.lethal.high', 'hud.lethal.mid',
  'hud.vibrate.enabled', 'hud.vibrate.pattern', 'hud.vibrate.trLastTurn',
  'hud.benchStripMax', 'hud.overlord.probeMove', 'hud.overlord.probeDefender',
  'hud.receipt.maxDamageRows', 'hud.receipt.copyLabel',
  // llm
  'llm.timeoutMs', 'llm.geminiModel', 'llm.openrouterModel', 'llm.geminiEndpoint',
  'llm.openrouterEndpoint', 'llm.maxPromptWords', 'llm.maxReasonWords', 'llm.systemPrompt',
  // pruner
  'pruner.maxReasons', 'pruner.maxEvidence', 'pruner.speedMaxCeiling',
  'pruner.speedFloorFallbackKeep',
  'pruner.damageEvidence.enabled', 'pruner.damageEvidence.slackPct',
  'pruner.damageEvidence.slackRel', 'pruner.damageEvidence.minDamagePct',
  'pruner.damageEvidence.maxObservations', 'pruner.damageEvidence.maxSetsTested',
  // state
  'state.maxActiveStints', 'state.maxLog'
];

const missing = [];
INVENTORY.forEach(function (path) {
  if (typeof cfg(path) === 'undefined') missing.push(path);
});
check('all ' + INVENTORY.length + ' inventory keys resolve', missing.length === 0, missing.join(', '));

/* The sections themselves, so a renamed section cannot slip past the path checks above. */
const SECTIONS = ['laplace', 'sampler', 'usage', 'evaluator', 'tempo', 'clock', 'veto', 'trickRoom', 'hud', 'llm', 'pruner', 'state'];
const missingSections = SECTIONS.filter(function (s) { return !ST.CONFIG[s] || typeof ST.CONFIG[s] !== 'object'; });
check('all ' + SECTIONS.length + ' top-level sections exist', missingSections.length === 0, missingSections.join(', '));

/* A few types, because "exists" is not "is usable". */
check('laplace.K is a positive integer', cfg('laplace.K') > 0 && cfg('laplace.K') % 1 === 0, cfg('laplace.K'));
check('evaluator.weights.status is a 12-entry array', Array.isArray(cfg('evaluator.weights.status')) && cfg('evaluator.weights.status').length === 12, JSON.stringify(cfg('evaluator.weights.status')));
check('evaluator.weights.macro is a 16-entry array', Array.isArray(cfg('evaluator.weights.macro')) && cfg('evaluator.weights.macro').length === 16, JSON.stringify(cfg('evaluator.weights.macro')));
check('veto codes are non-empty strings', ['VETO1', 'VETO2', 'VETO3', 'VETO4', 'VETO5', 'VETO6', 'VETO7', 'VETO8', 'VETO9', 'VETO10', 'VETO11', 'VETO12'].every(function (k) { return typeof cfg('veto.codes.' + k) === 'string' && cfg('veto.codes.' + k).length > 0; }));
check('the clock reads fast BEFORE it reads slow (a swap would invert every label)',
  cfg('clock.fastMs') > 0 && cfg('clock.fastMs') < cfg('clock.slowMs'), cfg('clock.fastMs') + ' < ' + cfg('clock.slowMs'));
check('clock.switchKeepThreshold sits inside the range of its own priors',
  cfg('clock.switchKeepThreshold') > cfg('clock.switchPrior.auto') &&
  cfg('clock.switchKeepThreshold') <= cfg('clock.switchPrior.normal'),
  cfg('clock.switchPrior.auto') + ' < ' + cfg('clock.switchKeepThreshold') + ' <= ' + cfg('clock.switchPrior.normal'));
check('the lethal bands descend (guaranteed >= high >= mid)',
  cfg('hud.lethal.guaranteed') >= cfg('hud.lethal.high') && cfg('hud.lethal.high') >= cfg('hud.lethal.mid'),
  cfg('hud.lethal.guaranteed') + ' / ' + cfg('hud.lethal.high') + ' / ' + cfg('hud.lethal.mid'));
check('the haptic pattern is a non-empty array of positive pulse widths',
  Array.isArray(cfg('hud.vibrate.pattern')) && cfg('hud.vibrate.pattern').length > 0 &&
  cfg('hud.vibrate.pattern').every(function (v) { return typeof v === 'number' && v > 0; }),
  JSON.stringify(cfg('hud.vibrate.pattern')));
check('the Overlord probe names a move and a defender (the measurement needs both)',
  typeof cfg('hud.overlord.probeMove') === 'string' && cfg('hud.overlord.probeMove').length > 2 &&
  typeof cfg('hud.overlord.probeDefender') === 'string' && cfg('hud.overlord.probeDefender').length > 2,
  cfg('hud.overlord.probeMove') + ' vs ' + cfg('hud.overlord.probeDefender'));
check('usage.floor is a fraction (a weight multiplier, not a percent)',
  typeof cfg('usage.floor') === 'number' && cfg('usage.floor') > 0 && cfg('usage.floor') <= 1, cfg('usage.floor'));
check('the damage-evidence tolerances are positive numbers',
  [cfg('pruner.damageEvidence.slackPct'), cfg('pruner.damageEvidence.slackRel')]
    .every(function (v) { return typeof v === 'number' && v > 0; }),
  cfg('pruner.damageEvidence.slackPct') + ' / ' + cfg('pruner.damageEvidence.slackRel'));
check('the damage-evidence caps are positive integers',
  [cfg('pruner.damageEvidence.maxObservations'), cfg('pruner.damageEvidence.maxSetsTested')]
    .every(function (v) { return typeof v === 'number' && v > 0 && v % 1 === 0; }),
  cfg('pruner.damageEvidence.maxObservations') + ' / ' + cfg('pruner.damageEvidence.maxSetsTested'));
check('llm.systemPrompt is a non-empty string', typeof cfg('llm.systemPrompt') === 'string' && cfg('llm.systemPrompt').length > 20);

/* ====================================================== 3. the 128D layout is frozen */

section('the 128D weight layout is frozen');

/* Written out as literals, NOT read from the config: this is the independent copy that makes the
 * test a guard instead of a tautology. Layout is documented in ARCHITECTURE.md §3.
 *
 * The numbers are the ADOPTED FIT (src/config.js, from lib/trained-weights.json `spec`), with the
 * two unidentifiable accuracy dims zeroed (the artifact's `lowSupport` dims 41/47), times the
 * evaluator.fitScale calibration. The fit's per-slot spread is folded into the single +/- values
 * config.js can express, which is why hp is one number rather than six. */
const FROZEN_SPEC = {
  hp: 0.9195,
  fainted: 0.5496,
  status: [1.7295, 0.903, -1.9572, 6.1933, 0.3425, -0.3128, -1.6153, -1.8806, -0.3911, -0.1914, -0.232, -0.6362],
  boosts: [-4.8376, -5.6088, -5.4306, -5.6211, -4.8935, 0, -0.8748, -0.4079, -0.2069, 0.3381, 0.1238, 0],
  hazards: [-3.5172, -6.8244, -6.5996, -2.6565, 3.3565, 6.567, 6.3636, 3.1761],
  trickRoom: [0.014, 0.0265, 0.0645, -0.0685, -0.0425, 0.0384, 0.1264, -0.0795],
  items: [-0.482, 0.0676, 0, 0, -0.001, 0.0029, -0.1507, 0.1644, 0, 0, -0.0881, -0.0832],
  threat: -0.0248,
  threatActive: 0.1811,
  macro: [0.6917, -1.0183, 1.3815, -1.1125, -9.2872, 1.0659, 18.372, -0.8555, 0, 0, -0.1029, 0.1519, 0.0738, -0.0738, 0.7961, -0.5051]
};
const FROZEN_FIT_SCALE = 52.2;
/* f32(v) mirrors defaultWeights() step for step: the spec value lands in the Float32Array, the
 * calibration multiplies it, and each assignment rounds to f32. */
const f32 = function (v) { return Math.fround(Math.fround(v) * FROZEN_FIT_SCALE); };
const EXPECTED = (function () {
  const w = new Array(128);
  for (let i = 0; i < 6; i++) { w[i] = f32(FROZEN_SPEC.hp); w[6 + i] = f32(-FROZEN_SPEC.hp); }        // HP
  for (let i = 0; i < 6; i++) { w[12 + i] = f32(-FROZEN_SPEC.fainted); w[18 + i] = f32(FROZEN_SPEC.fainted); }
  FROZEN_SPEC.status.forEach(function (v, i) { w[24 + i] = f32(v); });
  FROZEN_SPEC.boosts.forEach(function (v, i) { w[36 + i] = f32(v); });
  FROZEN_SPEC.hazards.forEach(function (v, i) { w[48 + i] = f32(v); });
  FROZEN_SPEC.trickRoom.forEach(function (v, i) { w[56 + i] = f32(v); });
  FROZEN_SPEC.items.forEach(function (v, i) { w[64 + i] = f32(v); });
  for (let i = 0; i < 36; i++) w[76 + i] = f32(FROZEN_SPEC.threat);            // threat matrix
  for (let i = 0; i < 6; i++) w[76 + i * 7] = f32(FROZEN_SPEC.threatActive);    // active vs active
  FROZEN_SPEC.macro.forEach(function (v, i) { w[112 + i] = f32(v); });
  return w;
})();

if (!ST.DenseStateEvaluator) {
  check('DenseStateEvaluator is present', false);
} else {
  const ev = new ST.DenseStateEvaluator();
  const vec = nums(ev.weights);

  eq('weight vector length is 128', vec.length, 128);
  eq('the whole 128D vector matches the frozen layout', vec, EXPECTED);

  /* Named dims, so a failure says which block moved rather than dumping 128 numbers. */
  eq('dims 0/5 are +hp, 6/11 are -hp', [vec[0], vec[5], vec[6], vec[11]],
    [f32(FROZEN_SPEC.hp), f32(FROZEN_SPEC.hp), f32(-FROZEN_SPEC.hp), f32(-FROZEN_SPEC.hp)]);
  eq('dims 12/17 are -fainted, 18/23 are +fainted', [vec[12], vec[17], vec[18], vec[23]],
    [f32(-FROZEN_SPEC.fainted), f32(-FROZEN_SPEC.fainted), f32(FROZEN_SPEC.fainted), f32(FROZEN_SPEC.fainted)]);
  eq('status block 24..35', vec.slice(24, 36), FROZEN_SPEC.status.map(f32));
  eq('boost block 36..47', vec.slice(36, 48), FROZEN_SPEC.boosts.map(f32));
  eq('hazard block 48..55', vec.slice(48, 56), FROZEN_SPEC.hazards.map(f32));
  eq('trick room block 56..63', vec.slice(56, 64), FROZEN_SPEC.trickRoom.map(f32));
  eq('item block 64..75', vec.slice(64, 76), FROZEN_SPEC.items.map(f32));
  eq('threat matrix 76..111 is flat except the active diagonal',
    [vec[76], vec[77], vec[82], vec[83], vec[90], vec[97], vec[104], vec[111]],
    [f32(FROZEN_SPEC.threatActive), f32(FROZEN_SPEC.threat), f32(FROZEN_SPEC.threat), f32(FROZEN_SPEC.threatActive),
      f32(FROZEN_SPEC.threatActive), f32(FROZEN_SPEC.threatActive), f32(FROZEN_SPEC.threatActive), f32(FROZEN_SPEC.threatActive)]);
  eq('macro block 112..127', vec.slice(112, 128), FROZEN_SPEC.macro.map(f32));

  /* Determinism: the vector is generated, not accumulated state. */
  const ev2 = new ST.DenseStateEvaluator();
  eq('two fresh evaluators build byte-identical vectors', nums(ev2.weights), vec);
  eq('defaultWeights() equals the constructor default', nums(ST.DenseStateEvaluator.defaultWeights()), vec);
  eq('DenseStateEvaluator.DIM is 128', ST.DenseStateEvaluator.DIM, 128);
  check('dims agree with the config', cfg('evaluator.dim') === 128 && cfg('evaluator.team') === 6,
    cfg('evaluator.dim') + '/' + cfg('evaluator.team'));
}

/* ==================================================== 4. mutation flows through */

section('mutation flows through to the consumers');

const originalK = cfg('laplace.K');
const originalRhythmHurt = cfg('tempo.rhythmHurt');
/* `before` is a deep CLONE, taken before anything is written: it is the only trustworthy
 * reference for asserting that a mutation did not happen. */
const before = snap();

if (!ST.LaplaceEngine) {
  check('LaplaceEngine is present', false);
} else {
  const baseline = attempt(function () { return new ST.LaplaceEngine({ evaluator: null }); });
  check('a LaplaceEngine can be constructed', !!baseline.value, baseline.error);
  if (baseline.value) {
    eq('engine K starts at the config value', baseline.value.K, originalK);
    eq('engine temperature starts at the config value', baseline.value.temperature, cfg('laplace.temperature'));
    eq('engine worldBlend starts at the config value', baseline.value.worldBlend, before.laplace.worldBlend);
    eq('engine lethalBonus starts at the config value', baseline.value.lethalBonus, cfg('laplace.lethalBonus'));
    eq('engine maxOppActions starts at the config value', baseline.value.maxOppActions, cfg('laplace.maxOppActions'));
  }

  ST.configMerge({ laplace: { K: 99 }, tempo: { rhythmHurt: 0.11 } });

  eq('configGet sees the merged K', cfg('laplace.K'), 99);
  eq('configGet sees the merged rhythm', cfg('tempo.rhythmHurt'), 0.11);

  const mutated = attempt(function () { return new ST.LaplaceEngine({ evaluator: null }); });
  check('a NEW engine can be constructed after the merge', !!mutated.value, mutated.error);
  if (mutated.value) eq('a NEW engine takes K from the mutated config', mutated.value.K, 99);
  const explicit = attempt(function () { return new ST.LaplaceEngine({ K: 3, evaluator: null }); });
  if (explicit.value) eq('an explicitly passed option still beats the config', explicit.value.K, 3);

  /* The engine owns a COPY of worldBlend, so a caller mutating it cannot write into config.js. */
  if (baseline.value && baseline.value.worldBlend !== cfg('laplace.worldBlend')) {
    baseline.value.worldBlend.avg = 0.123;
    /* Compared against the pristine CLONE, never against the live object: the live object is
     * exactly what a leak would have written into. */
    eq('mutating engine.worldBlend cannot leak into the config', cfg('laplace.worldBlend.avg'), before.laplace.worldBlend.avg);
  }

  /* Deep-clone isolation: a snapshot taken before the write must not move. */
  eq('the pre-mutation snapshot is untouched', before.laplace.K, originalK);
  eq('a fresh snapshot reflects the mutation', snap().laplace.K, 99);
  check('snapshot() returns a clone, not the live object', snap() !== ST.CONFIG && snap().laplace !== ST.CONFIG.laplace);

  /* A nested section merge is shallow, so sibling keys must survive it. */
  check('a section merge leaves sibling keys alone', cfg('laplace.temperature') === before.laplace.temperature,
    cfg('laplace.temperature') + ' vs ' + before.laplace.temperature);

  ST.configMerge({ laplace: { K: originalK }, tempo: { rhythmHurt: originalRhythmHurt } });
  eq('the original K is restored', cfg('laplace.K'), originalK);
  eq('the original rhythm is restored', cfg('tempo.rhythmHurt'), originalRhythmHurt);
  const restored = attempt(function () { return new ST.LaplaceEngine({ evaluator: null }); });
  if (restored.value) eq('a NEW engine is back on the original K', restored.value.K, originalK);
}

/* =============================================== 5. the evaluator consumes the config */

section('the evaluator consumes the config');

if (!ST.DenseStateEvaluator) {
  check('DenseStateEvaluator is present', false);
} else {
  /* NOTE: configMerge merges a SECTION shallowly, so `{ evaluator: { weights: {...} } }`
   * replaces the whole weights object. The patch therefore has to carry every key, which is
   * itself worth knowing before anyone tries to retune one weight at runtime. */
  const weightsPatch = snap().evaluator.weights;
  weightsPatch.hp = 1;
  ST.configMerge({ evaluator: { weights: weightsPatch } });

  const patched = new ST.DenseStateEvaluator();
  /* Every dim is calibrated by evaluator.fitScale, so the mutation is visible times that factor. */
  const scaled = function (v) { return Math.fround(Math.fround(v) * cfg('evaluator.fitScale')); };
  eq('index 0 follows evaluator.weights.hp (through fitScale)', patched.weights[0], scaled(1));
  eq('index 5 follows evaluator.weights.hp', patched.weights[5], scaled(1));
  eq('index 6 is the negated opponent weight', patched.weights[6], -scaled(1));
  eq('index 11 is the negated opponent weight', patched.weights[11], -scaled(1));
  // dim 76 is the active-vs-active corner of the threat matrix, so it carries `threatActive`
  // (0.1811), not the plain `threat` (-0.0248) every other matrix cell gets.
  eq('untouched dims keep their values (calibrated)', [patched.weights[24], patched.weights[76], patched.weights[112]],
    [scaled(cfg('evaluator.weights.status')[0]), scaled(cfg('evaluator.weights.threatActive')), scaled(cfg('evaluator.weights.macro')[0])]);
  check('the patched vector differs from the frozen one', nums(patched.weights).join(',') !== EXPECTED.join(','));

  /* Restore, and prove the whole tree is byte-identical to how we found it. */
  ST.configMerge({ evaluator: { weights: PRISTINE.evaluator.weights } });
  eq('the evaluator blocks are restored', nums(new ST.DenseStateEvaluator().weights), EXPECTED);

  /* `scale` is the output bound, and it is read live: raising it must widen the score. The
   * all-ones vector is a probe with a deliberately non-zero raw sum, so the squash is visible. */
  const scaleOrig = cfg('evaluator.scale');
  const probe = new Array(128);
  for (let i = 0; i < probe.length; i++) probe[i] = 1;
  const e = new ST.DenseStateEvaluator();
  const baseScore = e.evaluateVector(probe);
  check('the output of evaluate() respects the scale bound', Math.abs(baseScore) <= scaleOrig + 1e-6, baseScore + ' vs ' + scaleOrig);
  ST.configMerge({ evaluator: { scale: scaleOrig * 2 } });
  const wideScore = new ST.DenseStateEvaluator().evaluateVector(probe);
  ST.configMerge({ evaluator: { scale: scaleOrig } });
  check('mutating evaluator.scale changes the output', Math.abs(wideScore) > Math.abs(baseScore) + 1e-6,
    baseScore + ' -> ' + wideScore);
}

/* ================================================================ 6. left as found */

section('the sandbox is left exactly as it was found');
if (PRISTINE) {
  eq('the config tree is byte-identical to the pristine snapshot', snap(), PRISTINE);
} else {
  check('the config tree is byte-identical to the pristine snapshot', false,
    'config.js never loaded, so there was no tree to compare against');
}

/* ================================================================== summary */

console.log('\n=== summary ===');
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failures.length);
console.log('inventory keys checked: ' + INVENTORY.length + ', frozen dims: ' + EXPECTED.length);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('ALL CONFIG CHECKS PASSED');
process.exit(0);
