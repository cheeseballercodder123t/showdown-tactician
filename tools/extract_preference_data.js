/* Showdown Tactician — tools/extract_preference_data.js
 *
 * THE OTHER LABEL. tools/extract_training_data.js labels a TURN with who won the battle forty turns
 * later. This tool labels a DECISION with the human's own click, which is available at the moment it
 * was made and does not have to be reconstructed from an outcome:
 *
 *     x(s_t, a_human) - x(s_t, a_rejected)
 *
 * where `x` is the same 128-dim evaluator vector, extracted from the board each action LEAVES
 * (engine.simulate -> engine._leafState -> evaluator.extractVector). A model fitted on those
 * differences is a
 * Bradley-Terry / Plackett-Luce ranking: `P(human clicks a over b) = sigmoid(w . (x_a - x_b))`.
 * It never sees a winner, so it cannot inherit the winner label's noise, and every turn contributes
 * instead of one row per turn being regressed onto a battle-level label.
 *
 * WHAT A PAIR IS, AND WHAT IT IS NOT
 *   - The CHOSEN vector is the human's own click, repaired into the menu exactly as
 *     tools/benchmark_human_match.js repairs it (a move the log had not revealed yet is added for
 *     this one decision and removed again, so later turns see only what was revealed by then).
 *   - The REJECTED vectors are HARD NEGATIVES: the non-chosen lines the CURRENT evaluator scores
 *     highest. That is the correction signal — a random negative would mostly teach the model that
 *     an attack beats a switch, which it already knows and which is not the failure worth fixing.
 *     `--all-negatives` emits every non-chosen line instead.
 *   - The transition is the engine's own 1-ply (`simulate`), not a re-simulation of the replay.
 *     A move that FAILS (Sucker Punch into a switch), a Protect that blocks, a crit — none of that
 *     is modelled here, exactly as it is not modelled in the leaf the evaluator sees.
 *   - The vector is read off the LEAF BOARD (`_leafState`), not off `simulate`'s `state`. Those are
 *     not the same object and this is not cosmetic: `simulate(...).state` is a prototype overlay
 *     whose HP lives in `_sim`, and `extractVector` never reads `_sim` — it reads the team bodies.
 *     So `extractVector(sim.state)` returns the SAME 128 numbers for every action on a turn (the
 *     first version of this tool did exactly that and produced 200 pairs of exact zeros, which
 *     fit to a zero vector and scored chance). `_leafState` is what `_payoff` scores, and it bakes
 *     the HP into cloned bodies. A switch is special on top of that: `simulate` charges the entry
 *     hazard to `myPercentDelta` but reports `myHpAfter` for the body LEAVING, so the incoming
 *     body's own HP has to be carried in from its own reading.
 *
 * WHAT IT DOES NOT PROVE
 *   That the fitted vector is a BETTER STATE EVALUATOR. It is fitted to rank human clicks, and the
 *   honest comparison is pairwise accuracy on held-out decisions (tools/fit_preference_weights.js
 *   prints the shipped vector's number beside it). The state-classification AUC in
 *   lib/trained-weights.json is a different statistic and is not comparable to it.
 *
 * USAGE
 *   node tools/extract_preference_data.js --input corpus/elite.json --out prefs.json [options]
 *     --battles <n>       battles to replay (default 150; 0 = all)
 *     --negatives <n>     hard negatives per decision (default 2)
 *     --all-negatives     emit every non-chosen line
 *     --side p1|p2|both   which seat to score (default both)
 *     --format <name>     override the corpus format
 *     --set <path>=<val>  patch a config tunable before the modules load (repeatable)
 *     --quiet             no per-battle progress
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HM = require('./benchmark_human_match.js');
// The slice definition lives in the fitter, so the preference artifact and the winner fit are sliced
// by exactly the same function — one implementation, two consumers.
const FIT = require('./fit_weights.js');

const DIM = 128;

/* HOW EACH VECTOR WAS BUILT, counted rather than assumed: `exact` is the engine's own payoff leaf,
 * `fallback` the coarse simulate path. A run whose fallback count is not zero is reported as such. */
const leafStats = { exact: 0, fallback: 0, none: 0 };

function resetLeafStats() { leafStats.exact = 0; leafStats.fallback = 0; leafStats.none = 0; }

function parseArgs(argv) {
  const out = {
    input: null, out: 'preference_pairs.json', battles: 150, negatives: 2,
    allNegatives: false, randomNegative: false, side: 'both', format: null, sets: [], quiet: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--battles' || a === '-n') out.battles = parseInt(argv[++i], 10);
    else if (a === '--negatives') out.negatives = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === '--all-negatives') out.allNegatives = true;
    else if (a === '--random-negative') out.randomNegative = true;
    else if (a === '--side') out.side = String(argv[++i] || 'both').toLowerCase();
    else if (a === '--format') out.format = argv[++i];
    else if (a === '--set') out.sets.push(String(argv[++i]));
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

/**
 * leafVector(engine, state, action) -> a 128-float copy | null
 *
 * The board the human's click leaves, as THE ENGINE ITSELF SCORES IT. It calls `_payoff` — the one
 * function the live ranking calls — and reads the board back out of `trace.leaf`, so the vector is
 * the deployed leaf exactly: our setup's boost, our Protect's shield, our status move's condition,
 * a pivot's outgoing body, the delayed-hit residual. Nothing here re-derives any of that, which is
 * the point: a prediction target built from a SECOND transition model would train the weights to
 * win a different game than the one they are deployed in.
 *
 * Their reply is held FIXED (their strongest move, the line `simulate` used to use) so that two of
 * OUR actions differ only by our own action. A max over their whole action set per candidate is
 * what `evaluateTurn` does for the real ranking; it is also an order of magnitude slower, and the
 * induced bias is a reweighting of the reply, not a property of our click.
 *
 * FALLBACK. An engine without `trace.leaf` (or a state `_payoff` refuses) falls back to the coarse
 * `simulate` + `_leafState` path, which models our damage and their reply but NOT our own Protect
 * or setup. It is a documented approximation and is only reached if the engine stops filling the
 * trace; the caller reports how many decisions took it.
 */
function leafVector(engine, state, action) {
  const myActive = state.active && state.active.my;
  const oppActive = state.active && state.active.opp;
  if (!action || !myActive || !oppActive) return null;
  const evaluator = engine.evaluator;
  if (!evaluator || typeof evaluator.extractVector !== 'function') return null;
  const field = state.field || {};

  let oppAction = null;
  try {
    const best = engine._bestMove(oppActive, myActive, field);
    oppAction = { kind: 'move', name: best || 'Splash' };
  } catch (e) { oppAction = null; }
  if (oppAction && typeof engine._payoff === 'function') {
    const trace = {};
    try { engine._payoff(action, oppAction, state, field, null, trace); } catch (e) { trace.leaf = null; }
    if (trace.leaf) {
      leafStats.exact++;
      // extractVector reuses ONE buffer ("clone it if you keep it") — each pair must own its copy.
      return Array.prototype.slice.call(evaluator.extractVector(trace.leaf));
    }
  }

  leafStats.fallback++;
  let sim = null;
  try { sim = engine.simulate(action, null, state); } catch (e) { leafStats.none++; return null; }
  if (!sim) { leafStats.none++; return null; }
  let leaf = null;
  if (action.kind === 'switch') {
    const incoming = typeof engine._switchTarget === 'function' ? engine._switchTarget(state, action) : null;
    if (!incoming) { leafStats.none++; return null; }
    const hpIn = clamp(engine._hp(incoming) + (sim.myPercentDelta || 0), 0, 100);
    leaf = engine._leafState(state, incoming, oppActive, hpIn, sim.oppHpAfter, null, {
      keepOutgoing: true, incoming: incoming, outgoingHp: engine._hp(myActive)
    });
  } else {
    leaf = engine._leafState(state, myActive, oppActive, sim.myHpAfter, sim.oppHpAfter, null, null);
  }
  if (!leaf) { leafStats.none++; return null; }
  return Array.prototype.slice.call(evaluator.extractVector(leaf));
}

function clamp(v, lo, hi) {
  if (!isFinite(v)) return lo;
  return v < lo ? lo : (v > hi ? hi : v);
}

/** Deterministic 32-bit hash, so a "random" negative is reproducible from the decision's own key. */
function hashOf(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function differenceOf(chosen, rejected) {
  const d = new Array(chosen.vec.length);
  for (let j = 0; j < chosen.vec.length; j++) d[j] = chosen.vec[j] - rejected.vec[j];
  return d.map(function (v) { return Math.round(v * 1e4) / 1e4; });
}

/**
 * One decision's menu -> the pair differences the fitter consumes. Exported for the unit test.
 *
 * Two kinds of negative are emitted, and the distinction is what makes the report readable:
 *   hard   — the lines the CURRENT evaluator scores highest among the ones the human did not take.
 *            This is the correction signal. It is also SELECTED ON THE SHIPPED SCORE, so a
 *            pairwise accuracy against hard negatives is NOT a ranker's chance line: the shipped
 *            vector is being asked to beat the lines it already liked.
 *   random — one uniformly chosen non-chosen line (`opts.randomNegative`). Nothing selected on it,
 *            so 50 % is chance and the accuracy on this subset IS an unbiased ranker reading.
 */
function pairDifferences(chosen, others, opts) {
  const o = opts || {};
  const all = !!o.allNegatives;
  const want = Math.max(1, o.negatives || 2);
  if (!chosen || !chosen.vec) return [];
  const pool = (others || []).filter(function (c) {
    return c && c.vec && c.key !== chosen.key && c.vec.length === chosen.vec.length;
  });
  if (!pool.length) return [];
  // HARD negatives: the lines the CURRENT evaluator likes most among the ones the human did not take.
  pool.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  const picked = all ? pool : pool.slice(0, want);
  const out = [];
  for (let i = 0; i < picked.length; i++) {
    out.push({
      d: differenceOf(chosen, picked[i]),
      chosenKey: chosen.key,
      rejectedKey: picked[i].key,
      kind: (chosen.kind || '?') + '>' + (picked[i].kind || '?'),
      source: 'hard'
    });
  }
  if (o.randomNegative) {
    // Indexed off the decision's own identity so a re-run of the extractor emits the same pairs.
    const pick = pool[hashOf(String(o.seed || '') + '|' + chosen.key) % pool.length];
    if (pick) {
      out.push({
        d: differenceOf(chosen, pick), chosenKey: chosen.key, rejectedKey: pick.key,
        kind: (chosen.kind || '?') + '>' + (pick.kind || '?'), source: 'random'
      });
    }
  }
  return out;
}

/** The menu, with the human's click repaired in for this decision only (see the header). */
function menuWith(engine, state, U, choice) {
  const before = engine.getMyActions(state) || [];
  const legal = state.legalActions;
  const synthesize = !before.some(function (a) { return HM.actionKeyOf(a) === HM.actionKey(choice); }) &&
    choice.kind === 'move' && !!legal;
  let saved = null;
  if (synthesize) {
    saved = legal.moves;
    const menu = before.filter(function (a) { return a.kind !== 'switch'; }).map(function (a) {
      return { id: a.moveId, name: a.name };
    });
    if (!menu.some(function (m) { return U.toID(m.id) === U.toID(choice.moveId); })) {
      menu.push({ id: choice.moveId, name: choice.moveName });
    }
    legal.moves = menu;
  }
  let offered = [];
  try { offered = engine.getMyActions(state) || []; } catch (e) { offered = []; }
  return {
    offered: offered,
    restore: function () { if (synthesize) legal.moves = saved; }
  };
}

/**
 * pairsForBattle(ST, U, replay, sides, opts) -> { pairs, decisions, skipped }
 * The replay loop is the benchmark's: one parser+state manager per scored side, a decision at every
 * `|turn|` header, the choice read from that turn's own bucket.
 */
function pairsForBattle(ST, U, replay, sides, opts) {
  const lines = String(replay.log || '').split('\n').map(function (l) { return l.replace(/\r$/, ''); });
  const parsed = HM.extractChoices(lines);
  const byTurn = {};
  for (let i = 0; i < parsed.turns.length; i++) byTurn[parsed.turns[i].turn] = parsed.turns[i].lines;

  const pairs = [];
  let decisions = 0;
  let skipped = 0;

  for (let s = 0; s < sides.length; s++) {
    const side = sides[s];
    const parser = new ST.ProtocolParser();
    parser.setMySide(side);
    const mgr = new ST.BattleStateManager({ debug: false });
    mgr.attachParser(parser);
    mgr.state.mySide = side;
    mgr.state.oppSide = side === 'p1' ? 'p2' : 'p1';
    if (opts.format) mgr.setFormat(opts.format);
    const engine = HM.buildEngine(ST, opts);
    const evaluator = engine.evaluator;

    for (let i = 0; i < lines.length; i++) {
      const m = /^\|turn\|(\d+)/.exec(lines[i]);
      if (!m) {
        try { parser.feed(lines[i]); } catch (e) { /* unmodelled line */ }
        continue;
      }
      const turn = parseInt(m[1], 10) || 0;
      try { parser.feed(lines[i]); } catch (e) { continue; }
      const state = mgr.state;
      if (!state || state.formatSupported === false) break;
      HM.syncClock(engine, state);
      const cls = HM.classifySide(byTurn[turn] || [], side);
      if (cls.status !== 'scorable') { skipped++; continue; }
      const choice = cls.action;
      // Z / Max moves are logged under a name the menu never carries (the click was the base move).
      if (choice.kind === 'move') {
        const data = U.getMoveData(choice.moveName);
        if ((data && (data.isZMove || data.isMaxMove)) || /^max\s/i.test(choice.moveName)) { skipped++; continue; }
      }
      const menu = menuWith(engine, state, U, choice);
      let chosen = null;
      const others = [];
      try {
        for (let a = 0; a < menu.offered.length; a++) {
          const action = menu.offered[a];
          const vec = leafVector(engine, state, action);
          if (!vec) continue;
          const entry = {
            key: HM.actionKeyOf(action), kind: action.kind, vec: vec,
            score: engine.evaluator.evaluateVector(vec)
          };
          if (entry.key === HM.actionKey(choice)) chosen = entry;
          else others.push(entry);
        }
      } finally {
        menu.restore();
      }
      if (!chosen) { skipped++; continue; }
      const got = pairDifferences(chosen, others, {
        negatives: opts.negatives, allNegatives: opts.allNegatives,
        randomNegative: opts.randomNegative, seed: opts.battleIndex + ':' + turn
      });
      /* THE BOARD THE DECISION WAS MADE ON, so the report can ask the question separately for the
       * opening, the contested mid-game and the cleanup. `d` is a DIFFERENCE and carries no absolute
       * HP, so this cannot be reconstructed from the pairs afterwards — it has to be stamped here. */
      let board = null;
      try { board = FIT.boardOf(evaluator.extractVector(state)); } catch (e) { board = null; }
      const slice = FIT.sliceOf(evaluator.extractVector(state));
      decisions++;
      for (let g = 0; g < got.length; g++) {
        pairs.push(Object.assign(got[g], {
          battle: opts.battleIndex, turn: turn, side: side, slice: slice,
          aliveMy: board ? board.aliveMy : null, aliveOpp: board ? board.aliveOpp : null
        }));
      }
    }
  }
  return { pairs: pairs, decisions: decisions, skipped: skipped };
}

function main(argv) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node tools/extract_preference_data.js --input replays.json [--out prefs.json]\n' +
      '       [--battles 150] [--negatives 2] [--all-negatives] [--random-negative]\n' +
      '       [--side both]\n' +
      '       [--format "<format>"] [--set <path>=<value> ...] [--quiet]');
    return 0;
  }
  if (!opts.input) throw new Error('--input is required');
  const api = HM.loadApi(opts.sets);
  const ST = api.ST;
  const U = ST.util;
  const corpus = HM.loadCorpus(path.resolve(ROOT, opts.input));
  // `--battles 0` means EVERY battle (strideSample cannot express that: with n = 0 its step is
  // Infinity and it returns an empty list, which would silently write a zero-pair dataset).
  const battles = opts.battles > 0 ? HM.strideSample(corpus.replays, opts.battles) : corpus.replays.slice();
  const sides = opts.side === 'both' ? ['p1', 'p2'] : [opts.side];
  const built = { buildEngine: HM.buildEngine, format: opts.format || corpus.format || null };

  resetLeafStats();
  /* STREAMED, NOT ACCUMULATED. A full-corpus run is ~500k pairs, each a 128-float array; holding
   * them all and then JSON.stringify-ing the lot needs several times the file size in live memory and
   * died on the real corpus ("Ineffective mark-compacts near heap limit" at battle 2,719 of 2,913,
   * with nothing written). So the object is written as it is produced: the header first, one pair at
   * a time, and a trailing `summary` carrying the counters that only exist at the end. Key order is
   * irrelevant to JSON, and the reader only looks at `pairs`. */
  const target = path.resolve(ROOT, opts.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, 'w');
  const header = {
    kind: 'preference-pairs', dim: DIM, negatives: opts.negatives, allNegatives: opts.allNegatives,
    randomNegative: opts.randomNegative, slices: true, sides: sides, format: built.format
  };
  const headerJson = JSON.stringify(header);
  fs.writeSync(fd, headerJson.slice(0, -1) + ',"pairs":[');
  let decisions = 0, skipped = 0, written = 0;
  try {
    for (let b = 0; b < battles.length; b++) {
      const got = pairsForBattle(ST, U, battles[b], sides, {
        buildEngine: built.buildEngine, format: built.format,
        negatives: opts.negatives, allNegatives: opts.allNegatives,
        randomNegative: opts.randomNegative, battleIndex: b, vetoOff: []
      });
      decisions += got.decisions;
      skipped += got.skipped;
      let chunk = '';
      for (let i = 0; i < got.pairs.length; i++) {
        chunk += (written ? ',' : '') + JSON.stringify(got.pairs[i]);
        written++;
      }
      if (chunk) fs.writeSync(fd, chunk);
      if (!opts.quiet) {
        process.stdout.write('  battle ' + (b + 1) + '/' + battles.length +
          '  decisions ' + got.decisions + '  pairs ' + got.pairs.length + '\r');
      }
    }
    const summary = {
      battles: battles.length, decisions: decisions, skipped: skipped, samples: written,
      leafPaths: { exact: leafStats.exact, fallback: leafStats.fallback, none: leafStats.none }
    };
    fs.writeSync(fd, '],"summary":' + JSON.stringify(summary) + '}\n');
  } finally {
    fs.closeSync(fd);
  }
  if (!opts.quiet) process.stdout.write('\n');
  if (!opts.quiet) {
    (api.applied || []).forEach(function (p) {
      console.log('  --set ' + p.path + ' = ' + JSON.stringify(p.to));
    });
    console.log('replays ' + battles.length + ' | decisions ' + decisions + ' | pairs ' + written +
      ' | skipped ' + skipped + ' | dim ' + DIM);
    console.log('leaf vectors: ' + leafStats.exact + ' from the engine\u2019s payoff leaf, ' +
      leafStats.fallback + ' from the coarse simulate fallback, ' + leafStats.none + ' unavailable');
    console.log('wrote ' + path.relative(ROOT, target));
  }
  return 0;
}

module.exports = {
  DIM: DIM, parseArgs: parseArgs, leafVector: leafVector, pairDifferences: pairDifferences,
  pairsForBattle: pairsForBattle, leafStats: leafStats, resetLeafStats: resetLeafStats, main: main
};

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error('extract_preference_data: ' + ((err && err.message) || err));
    process.exit(1);
  }
}
