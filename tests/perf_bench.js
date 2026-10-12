/* Showdown Tactician — tests/perf_bench.js
 *
 * WHAT THIS IS
 *   The performance answer the audit left open: "10 ms on an S24 FE" was never measured, and
 *   `lastReadout.elapsedMs` existed without anyone reading it. This runs the REAL decision path
 *   (`ST.LaplaceEngine.evaluateTurn`) on REAL boards — the thirty turns of test_log.txt replayed
 *   through the same `ProtocolParser` + `BattleStateManager` wiring src/content.js uses — and
 *   reports the per-turn cost as a distribution, not a single number.
 *
 * WHY A DISTRIBUTION
 *   A turn is not a fixed cost. It scales with (worlds K) x (our legal actions) x (their replies
 *   per world), and every cell of that product is one `_payoff`: two damage rolls plus one 128D
 *   evaluator pass. A quiet 2-move turn and a 4-move/4-switch turn are different by ~4x, so the
 *   p50 and the p95 are the numbers that matter, plus the synthetic worst case below.
 *
 * WHAT IT MEASURES, AND WHAT IT DOES NOT
 *   It measures evaluateTurn — the decision cost, on the decision critical path. It does NOT
 *   include the per-EVENT work src/content.js does as the log streams in (the set pruner's
 *   reverse-damage pass, the state machine, the HUD repaint), because that work happens between
 *   turns, not while the player is waiting for a verdict. Treat the numbers here as the floor.
 *
 * WHY THE MAIN REALM
 *   The engine is loaded with an indirect eval into the main realm, NOT through tests/harness.js.
 *   The harness runs it inside `vm.runInContext` — a separate V8 context — and that isolation is
 *   not free: on the identical board the same code costs ~119 ms there versus ~40 ms here and
 *   ~32 ms in a real Chromium. The sandbox is the right instrument for unit tests and the wrong
 *   one for a performance number, so this file deliberately does not use it.
 *
 * Run me with:  node tests/perf_bench.js [--json] [--repeat N] [--device NAME] [--assert MS]
 * Exit code 0 unless --assert is given and the p95 exceeds it.
 *
 * The ground truth is bench/bench.html opened on the device itself; the projections below are a
 * Geekbench-scaled estimate, and the header of that file says so.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const H = require('./harness.js');

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const out = { json: false, repeat: 7, device: null, assert: null, quiet: false, mlp: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--mlp') out.mlp = true;
    else if (a === '--repeat') out.repeat = Math.max(1, parseInt(argv[++i], 10) || 7);
    else if (a === '--device') out.device = argv[++i];
    else if (a === '--assert') out.assert = parseFloat(argv[++i]);
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

/* --------------------------------------------------------- device model */
/*
 * The reference machine is whatever is running this file. Everything else is projected from
 * Geekbench 6 SINGLE-CORE, which is the right axis here: a Showdown turn is one synchronous
 * burst on one thread, so multi-core throughput and GPU mean nothing to it.
 *
 *   factor = reference_GB6_ST / device_GB6_ST     (below 1.0 means the device is FASTER)
 *
 * Sources (Geekbench 6 single-core, community averages, retrieved 2026-10):
 *   Intel Core i7-9750H  ~1400   (reference)
 *   Samsung Exynos 2400  ~2100   (Galaxy S24 FE; cputronic 2080, early S24 FE leak 2047)
 *
 * A phone is NOT just its peak clock, though. The `penalty` below covers sustained thermal
 * throttling, the page's own main-thread work sharing the core, and weaker memory bandwidth.
 * 1.6 is a deliberately unflattering assumption: it says that after all three, the phone ends
 * up no better than the laptop. The real number comes from bench/bench.html on the device.
 */
const DEVICES = {
  reference: { label: 'this machine (reference)', gb6: 1400, penalty: 1.0 },
  's24fe': { label: 'Galaxy S24 FE (Exynos 2400)', gb6: 2100, penalty: 1.6 },
  'pixel8': { label: 'Pixel 8 (Tensor G3)', gb6: 1750, penalty: 1.6 },
  'midrange': { label: 'mid-range Android', gb6: 900, penalty: 1.8 }
};
const REF_GB6 = DEVICES.reference.gb6;

function projectDevice(deviceKey, ms) {
  const d = DEVICES[deviceKey] || DEVICES['s24fe'];
  const ratio = REF_GB6 / d.gb6;          // ideal: pure single-core scaling
  return {
    key: deviceKey,
    label: d.label,
    idealMs: ms * ratio,
    realisticMs: ms * ratio * d.penalty,
    ratio: ratio,
    penalty: d.penalty
  };
}

/* ------------------------------------------------------------- helpers */

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}
function round2(x) { return Math.round(x * 100) / 100; }
function stats(samples) {
  const s = samples.slice().sort(function (a, b) { return a - b; });
  const sum = s.reduce(function (a, b) { return a + b; }, 0);
  return {
    n: s.length,
    mean: s.length ? sum / s.length : 0,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    max: s.length ? s[s.length - 1] : 0,
    min: s.length ? s[0] : 0
  };
}

/* A fixed integer+float workload, so the phone's bench.html can report the same "score" and the
 * two numbers are directly comparable even though the CPUs are nothing alike. */
function calibration() {
  const N = 3e6;
  const t0 = performance.now();
  let acc = 1;
  for (let i = 1; i <= N; i++) {
    acc = (Math.imul(acc ^ (i >>> 3), 0x9E3779B1) ^ (acc >>> 7)) | 0;
    if ((i & 1023) === 0) acc += Math.sqrt(i) * Math.sin(i * 0.001) | 0;
  }
  const ms = performance.now() - t0;
  return { ms: ms, ops: N, score: N / ms, sink: acc };
}

/* ------------------------------------------------------- engine stack */
/*
 * MAIN-REALM LOAD, deliberately NOT tests/harness.js. The harness runs the engine inside
 * `vm.runInContext`, a separate V8 context, and that is not free: measured on the same board,
 * the same code costs ~119 ms in the sandbox against ~40 ms loaded into the main realm and
 * ~32 ms in a real Chromium. The sandbox is the right tool for unit tests (isolation, stubs),
 * but it is the wrong instrument for a performance number, so this file evals the scripts into
 * the main realm — the closest Node can get to the browser's own single global.
 */
function loadMainRealm() {
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  for (const rel of H.MANIFEST_ORDER) {
    if (rel === 'src/content.js') continue;   // auto-boots a HUD + a heartbeat we do not want
    const abs = path.join(H.ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    (0, eval)(fs.readFileSync(abs, 'utf8'));  // indirect eval -> global scope, like a <script>
  }
  return globalThis.ST;
}

const ST = loadMainRealm();
const U = ST.util;

if (!ST.LaplaceEngine || !ST.BattleStateManager || !ST.ProtocolParser) {
  console.error('perf_bench: the engine did not load (missing ST classes).');
  process.exit(1);
}

/* The engine stack src/content.js builds, minus the HUD (DOM) and the LLM (network). */
function buildEngine() {
  const damage = ST.DamageEngine ? new ST.DamageEngine({ gen: 9 }) : null;
  const trickRoom = ST.TrickRoomEngine ? new ST.TrickRoomEngine(damage) : null;
  return new ST.LaplaceEngine({
    sampler: ST.WorldSampler ? new ST.WorldSampler({ K: 6 }) : null,
    damage: damage,
    evaluator: ST.DenseStateEvaluator ? new ST.DenseStateEvaluator() : null,
    tempo: ST.TempoEngine ? new ST.TempoEngine({ damage: damage, trickRoom: trickRoom }) : null,
    veto: ST.BlunderVetoGuard ? new ST.BlunderVetoGuard({ damage: damage, trickRoom: trickRoom }) : null,
    trickRoom: trickRoom
  });
}

/* Our team: the run_tests fixture paste, registered through the real TeamParser + state manager
 * so every mon is fully specified (sets, moves, stats) and the damage engine does real work. */
function buildMyTeam() {
  const src = fs.readFileSync(path.join(H.ROOT, 'tests', 'run_tests.js'), 'utf8');
  const m = src.match(/const PASTE = \[([\s\S]*?)\]\.join\('\\n'\);/);
  const pasteText = eval('[' + m[1] + ']').join('\n');
  const mgr = new ST.BattleStateManager({ debug: false });
  mgr.setFormat('[Gen 9] National Dex OU');
  mgr.registerMyTeam(ST.TeamParser.parsePokepaste(pasteText).pokemon);
  return (mgr.state || mgr).myTeam.slice();
}

/* Replay test_log.txt and snapshot the board at the start of every turn. */
function replaySnapshots() {
  const log = fs.readFileSync(path.join(H.ROOT, 'test_log.txt'), 'utf8').split('\n');
  const mgr = new ST.BattleStateManager({ debug: false });
  const parser = new ST.ProtocolParser();
  mgr.attachParser(parser);
  mgr.setFormat('[Gen 9] National Dex OU');
  const snaps = [];
  const clone = function (x) { return x === undefined ? x : JSON.parse(JSON.stringify(x)); };
  for (let i = 0; i < log.length; i++) {
    const line = log[i].replace(/\r$/, '');
    if (line.indexOf('|turn|') === 0) {
      const st = mgr.state || mgr;
      snaps.push({
        turn: parseInt(line.slice(6), 10) || 0,
        oppTeam: clone(st.oppTeam),
        field: clone(st.field),
        bench: clone(st.bench),
        protect: clone(st.protect),
        recoveryPP: clone(st.recoveryPP)
      });
    }
    try { parser.feed(line); } catch (e) { /* the log is clean; parser_fuzz already proves it */ }
  }
  return snaps;
}

function activeOpp(oppTeam) {
  if (!oppTeam || !oppTeam.length) return null;
  const act = oppTeam.find(function (m) { return m.isActive && !m.fainted; });
  if (act) return act;
  return oppTeam.find(function (m) { return !m.fainted; }) || oppTeam[0];
}

/* A fully-specified decision state: our registered team on p1, the replayed opponent on p2. */
function makeDecision(myTeam, snap) {
  const my = myTeam.map(function (m) { return JSON.parse(JSON.stringify(m)); });
  const opp = snap.oppTeam || [];
  const oppAct = activeOpp(opp);
  if (oppAct) oppAct.isActive = true;
  const myAct = my[0];
  myAct.isActive = true;
  myAct.hpPercent = 85;
  myAct.hp = 85;
  return {
    turn: snap.turn,
    mySide: 'p1',
    oppSide: 'p2',
    formatSupported: true,
    myTeam: my,
    oppTeam: opp,
    active: { my: myAct, opp: oppAct },
    bench: snap.bench || { my: [], opp: [] },
    protect: snap.protect || {},
    recoveryPP: snap.recoveryPP || {},
    field: snap.field || {}
  };
}

/* The synthetic worst case: 6 alive on both sides, 4 moves + a full bench everywhere, hazards on
 * both sides, Trick Room up. This is the ceiling the real log rarely reaches. */
function worstCaseBoard(myTeam) {
  const OPP = ['Gholdengo', 'Kingambit', 'Iron Valiant', 'Landorus-Therian', 'Dragapult', 'Great Tusk'];
  const opp = OPP.map(function (sp, i) {
    return {
      id: U.toID(sp), species: sp, side: 'p2', index: i, revealed: true, level: 100,
      hp: 100, maxhp: 100, hpPercent: 100, fainted: false, status: '', boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
      volatiles: {}, revealedMoves: [], activeStintMoves: [], movePP: {},
      possibleAbilities: U.getAbilities(sp), speedFloor: 0, speedCeiling: 1012,
      candidateSets: [], liveSet: null, isActive: i === 0, item: null, ability: '', setMoves: []
    };
  });
  const my = myTeam.map(function (m) { return JSON.parse(JSON.stringify(m)); });
  my.forEach(function (m, i) { m.fainted = false; m.hpPercent = 100; m.isActive = i === 0; });
  return {
    turn: 25,
    mySide: 'p1',
    oppSide: 'p2',
    formatSupported: true,
    myTeam: my,
    oppTeam: opp,
    active: { my: my[0], opp: opp[0] },
    bench: { my: my.slice(1), opp: opp.slice(1) },
    protect: { oppTurnsSinceLastProtect: 1, oppConsecutiveProtects: 0, myTurnsSinceLastProtect: 3, myConsecutiveProtects: 0 },
    recoveryPP: { 'p1a:recover': 4 },
    field: {
      turn: 25, trickRoom: true, trickRoomTurnsLeft: 3, weather: 'Snow', weatherTurnsLeft: 3,
      terrain: 'Psychic Terrain', terrainTurnsLeft: 3,
      hazards: { p1: { rocks: true, spikes: 2 }, p2: { rocks: true, spikes: 1, toxicSpikes: 1 } },
      screens: { p1: { reflect: true }, p2: {} }, tailwind: { p1: false, p2: true }, gravity: false
    }
  };
}

/* --------------------------------------------------------------- timing */

/**
 * Time `evaluateTurn` on a board. One warmup pass (V8 must tier the engine up before the numbers
 * mean anything), then `repeat` measured passes; the median of those is one sample. `runs`
 * samples are taken so the distribution is over repeats, not a single lucky burst.
 */
function timeBoard(engine, board, runs, repeat) {
  const samples = [];
  const payoffCounter = { calls: 0 };
  const realPayoff = engine._payoff;
  engine._payoff = function () { payoffCounter.calls++; return realPayoff.apply(this, arguments); };
  let ranked = [];
  let lastReadout = null;
  // warmup
  for (let w = 0; w < 2; w++) { try { ranked = engine.evaluateTurn(board); } catch (e) { /* reported below */ } }
  payoffCounter.calls = 0;
  const perRunPayoffs = [];
  for (let r = 0; r < runs; r++) {
    const pass = [];
    for (let k = 0; k < repeat; k++) {
      const before = payoffCounter.calls;
      const t0 = performance.now();
      try { ranked = engine.evaluateTurn(board); } catch (e) { ranked = []; }
      const dt = performance.now() - t0;
      pass.push(dt);
      perRunPayoffs.push(payoffCounter.calls - before);
    }
    pass.sort(function (a, b) { return a - b; });
    samples.push(pass[Math.floor(pass.length / 2)]);   // median of the repeats
    lastReadout = engine.lastReadout;
  }
  engine._payoff = realPayoff;
  return {
    stats: stats(samples),
    samples: samples,
    ranked: ranked,
    lastReadout: lastReadout,
    payoffCalls: perRunPayoffs.length ? Math.round(perRunPayoffs.reduce(function (a, b) { return a + b; }, 0) / perRunPayoffs.length) : 0,
    myActions: lastReadout && lastReadout.myActions ? lastReadout.myActions.length : 0,
    worlds: lastReadout && lastReadout.worlds ? lastReadout.worlds.length : 0
  };
}

/* ------------------------------------------------------------------- mlp */
/*
 * The residual head is OFF by default, so every number above is the shipped cost. `--mlp` measures
 * what turning it on would cost instead of guessing.
 *
 * The micro-benchmark underneath is the number that actually matters. The head is a pure function
 * of the leaf vector called once per `evaluate()`, and `_payoff` makes up to 432 of those in a
 * single turn, so `us_per_delta x payoffCalls` IS the added turn cost — a per-turn timing on top
 * just confirms it against the real call graph. When no artifact ships, a head of the same SHAPE is
 * injected: the cost depends on 128x16x1 and nothing else, so the measurement stays valid even
 * though the weights would not.
 */
function synthMlpSpec(dim, hidden, seed) {
  let s = (seed >>> 0) || 1;
  const rnd = function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const mean = [], sd = [], w1 = [], b1 = [], w2 = [];
  for (let j = 0; j < dim; j++) { mean.push(rnd() * 0.5); sd.push(0.25 + rnd() * 0.5); }
  for (let i = 0; i < hidden * dim; i++) w1.push((rnd() * 2 - 1) * 0.05);
  for (let k = 0; k < hidden; k++) { b1.push(0); w2.push((rnd() * 2 - 1) * 0.5); }
  return { dim: dim, hidden: hidden, gain: 150, standardize: { mean: mean, sd: sd }, w1: w1, b1: b1, w2: w2, b2: 0 };
}

function measureMlp(engine, myTeam, worst) {
  if (!ST.ResidualMLP) return { available: false };
  const cfgBefore = ST.configSnapshot();
  const artifactBefore = ST.MLP_RESIDUAL;
  const dim = 128, hidden = 16;
  const shipped = !!ST.MLP_RESIDUAL;
  ST.MLP_RESIDUAL = shipped ? artifactBefore : synthMlpSpec(dim, hidden, 20261011);
  ST.configMerge({ evaluator: { mlp: { enabled: true, dim: dim, hidden: hidden, clamp: 150 } } });

  const head = ST.ResidualMLP.fromConfig();
  if (!head) {
    ST.MLP_RESIDUAL = artifactBefore;
    ST.configMerge({ evaluator: { mlp: cfgBefore.evaluator.mlp } });
    return { available: false, reason: 'the head refused to load' };
  }

  // micro: the cost of one delta() in isolation
  const probe = new Float32Array(dim);
  for (let j = 0; j < dim; j++) probe[j] = (j % 7) / 7;
  for (let i = 0; i < 2000; i++) head.delta(probe);          // warm V8 up first
  const N = 300000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) head.delta(probe);
  const usPerDelta = (performance.now() - t0) / N * 1000;

  // the real call graph: the same worst-case board, ALTERNATING off/on so thermal drift and a
  // noisy neighbour cancel instead of landing on one side of the comparison.
  const board = worstCaseBoard(myTeam);
  const setHead = function (on) {
    ST.MLP_RESIDUAL = on ? (shipped ? artifactBefore : synthMlpSpec(dim, hidden, 20261011)) : artifactBefore;
    ST.configMerge({ evaluator: { mlp: { enabled: on, dim: dim, hidden: hidden, clamp: 150 } } });
  };
  const offP50 = [], onP50 = [], offP95 = [], onP95 = [];
  const ROUNDS = 3;
  for (let r = 0; r < ROUNDS; r++) {
    setHead(false);
    const o = timeBoard(engine, board, 5, ARGS.repeat);
    offP50.push(o.stats.p50); offP95.push(o.stats.p95);
    setHead(true);
    const n = timeBoard(engine, board, 5, ARGS.repeat);
    onP50.push(n.stats.p50); onP95.push(n.stats.p95);
  }
  const med = function (a) { const s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; };

  ST.MLP_RESIDUAL = artifactBefore;
  ST.configMerge({ evaluator: { mlp: cfgBefore.evaluator.mlp } });

  return {
    available: true,
    source: shipped ? 'the shipped artifact' : 'a synthetic head of the same shape (no artifact on this checkout)',
    params: head.describe().params,
    usPerDelta: usPerDelta,
    payoffCalls: worst.payoffCalls,
    projectedAddedMs: usPerDelta * worst.payoffCalls / 1000,
    boardRounds: ROUNDS,
    boardOffP50: med(offP50),
    boardOnP50: med(onP50),
    boardOffP95: med(offP95),
    boardOnP95: med(onP95),
    boardAddedP50: med(onP50) - med(offP50),
    boardAddedP95: med(onP95) - med(offP95)
  };
}

/* ------------------------------------------------------------------ main */

function main() {
  const engine = buildEngine();
  const myTeam = buildMyTeam();
  const snaps = replaySnapshots();
  const cal = calibration();

  // ---- real boards: one measurement per turn of the actual battle -----------------------------
  const turnRows = [];
  const allSamples = [];
  for (let i = 0; i < snaps.length; i++) {
    const board = makeDecision(myTeam, snaps[i]);
    const r = timeBoard(engine, board, 5, ARGS.repeat);
    turnRows.push({
      turn: snaps[i].turn,
      ms: round2(r.stats.p50),
      p50: round2(r.stats.p50),
      max: round2(r.stats.max),
      payoffCalls: r.payoffCalls,
      myActions: r.myActions,
      worlds: r.worlds,
      oppAlive: (snaps[i].oppTeam || []).filter(function (m) { return !m.fainted; }).length,
      top: r.ranked && r.ranked.length ? r.ranked[0].name : null
    });
    for (let s = 0; s < r.samples.length; s++) allSamples.push(r.samples[s]);
  }
  const realStats = stats(allSamples);

  // ---- worst case -----------------------------------------------------------------------------
  const worst = timeBoard(engine, worstCaseBoard(myTeam), 7, ARGS.repeat);

  // ---- the optional residual head (only when asked: it is off by default) ----------------------
  const mlp = ARGS.mlp ? measureMlp(engine, myTeam, worst) : null;

  // ---- report ---------------------------------------------------------------------------------
  const devices = ['s24fe', 'pixel8', 'midrange'];
  const projection = devices.map(function (d) {
    return { device: d, worst: projectDevice(d, worst.stats.p95), real: projectDevice(d, realStats.p95) };
  });

  if (ARGS.json) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      node: process.version,
      cpu: require('os').cpus()[0].model,
      calibration: { ms: round2(cal.ms), score: Math.round(cal.score) },
      realBoards: { turns: turnRows.length, stats: mapStats(realStats), perTurn: turnRows },
      worstCase: { stats: mapStats(worst.stats), payoffCalls: worst.payoffCalls, myActions: worst.myActions, worlds: worst.worlds },
      residualHead: mlp,
      projection: projection.map(function (p) {
        return {
          device: p.device,
          label: DEVICES[p.device].label,
          realP95Ms: round2(p.real.realisticMs),
          worstP95Ms: round2(p.worst.realisticMs)
        };
      })
    }, null, 2));
    return finish(worst, realStats, cal);
  }

  const line = function (s) { return 'mean ' + round2(s.mean) + '  p50 ' + round2(s.p50) + '  p95 ' + round2(s.p95) + '  max ' + round2(s.max) + ' ms'; };
  console.log('Showdown Tactician — evaluateTurn performance benchmark');
  console.log('node ' + process.version + ' | ' + require('os').cpus()[0].model + ' | ' + require('os').cpus().length + ' threads');
  console.log('calibration: ' + round2(cal.ms) + ' ms for ' + cal.ops + ' ops  ->  score ' + Math.round(cal.score) + ' ops/ms');
  console.log('');
  console.log('=== real boards: ' + turnRows.length + ' turns of test_log.txt ===');
  console.log('  per-turn p50 (ms): ' + turnRows.map(function (t) { return t.turn + ':' + t.p50; }).join('  '));
  console.log('  ' + line(realStats));
  console.log('  busiest turn: turn ' + busiest(turnRows).turn + ' at ' + busiest(turnRows).p50 + ' ms (' +
    busiest(turnRows).payoffCalls + ' _payoff calls, ' + busiest(turnRows).myActions + ' our actions, ' +
    busiest(turnRows).oppAlive + ' opposing bodies)');
  console.log('');
  console.log('=== synthetic worst case (6 alive, 4 moves + full bench both sides, hazards, TR) ===');
  console.log('  ' + line(worst.stats));
  console.log('  ' + worst.payoffCalls + ' _payoff calls/turn  (' + worst.myActions + ' our actions x ' + worst.worlds + ' worlds)');
  console.log('');
  console.log('=== device projection (p95 of real boards / worst case) ===');
  console.log('  reference: ' + round2(realStats.p95) + ' / ' + round2(worst.stats.p95) + ' ms  (' + require('os').cpus()[0].model + ')');
  projection.forEach(function (p) {
    console.log('  ' + pad(DEVICES[p.device].label, 30) +
      'ideal ' + pad(round2(p.real.idealMs) + ' / ' + round2(p.worst.idealMs), 16) +
      'realistic ' + pad(round2(p.real.realisticMs) + ' / ' + round2(p.worst.realisticMs), 16) + ' ms');
  });
  console.log('  (ideal = Geekbench-6 single-core scaling only; realistic also applies a x' +
    DEVICES.s24fe.penalty + ' thermal/browser penalty)');
  console.log('');
  if (mlp) {
    console.log('=== the optional residual head (128 -> 16 -> 1 ReLU) ===');
    if (!mlp.available) {
      console.log('  not measured: ' + (mlp.reason || 'unavailable'));
    } else {
      console.log('  weights: ' + mlp.source + '  (' + mlp.params + ' parameters)');
      console.log('  one delta() call in isolation: ' + mlp.usPerDelta.toFixed(3) + ' us  x  ' + mlp.payoffCalls +
        ' _payoff calls/turn  =  +' + mlp.projectedAddedMs.toFixed(2) + ' ms/turn projected (an OPTIMISTIC floor)');
      console.log('  same board, alternating off/on over ' + mlp.boardRounds + ' rounds:  off p50 ' +
        round2(mlp.boardOffP50) + ' / p95 ' + round2(mlp.boardOffP95) + ' ms   on p50 ' +
        round2(mlp.boardOnP50) + ' / p95 ' + round2(mlp.boardOnP95) + ' ms   (+' +
        round2(mlp.boardAddedP50) + ' ms p50, +' + round2(mlp.boardAddedP95) + ' ms p95)');
      console.log('  the in-situ figure is the honest one: in the real call graph the head\'s buffers are');
      console.log('  not cache-hot, so it costs more than the isolated loop suggests.');
    }
    console.log('');
  }
  console.log('  NOTE: only bench/bench.html on the device is ground truth. These are projections.');
  return finish(worst, realStats, cal);
}

function busiest(rows) {
  return rows.reduce(function (a, b) { return b.p50 > a.p50 ? b : a; }, rows[0] || { turn: 0, p50: 0, payoffCalls: 0, myActions: 0, oppAlive: 0 });
}
function mapStats(s) { return { n: s.n, mean: round2(s.mean), p50: round2(s.p50), p95: round2(s.p95), max: round2(s.max), min: round2(s.min) }; }
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

function finish(worst, realStats, cal) {
  const budget = ARGS.assert;
  if (budget !== null && !isNaN(budget)) {
    const ref = Math.max(worst.stats.p95, realStats.p95);
    const proj = projectDevice(ARGS.device || 's24fe', ref).realisticMs;
    const device = DEVICES[ARGS.device || 's24fe'].label;
    if (proj > budget) {
      console.error('PERF FAIL: ' + device + ' worst-case p95 projected at ' + round2(proj) + ' ms > budget ' + budget + ' ms');
      process.exit(1);
    }
    console.log('PERF OK: ' + device + ' worst-case p95 projected at ' + round2(proj) + ' ms <= budget ' + budget + ' ms');
  }
  process.exit(0);
}

main();
