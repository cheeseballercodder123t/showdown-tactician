/* Showdown Tactician — tools/extract_training_data.js
 * Turns a corpus of battle replays into the (state vector, outcome) dataset that
 * tools/fit_weights.js fits. This is the data half of the empirical-weight pipeline; it never
 * touches src/ and never talks to the network.
 *
 * Run me with:
 *   node tools/extract_training_data.js --input replays.json --out training_data.json
 *   node tools/extract_training_data.js --input replays.json --out gate_on.json \
 *        --set evaluator.threatSpeedGate.enabled=true      (repeatable)
 *
 * WHY `--set` EXISTS HERE. A refit for a config leaf needs the corpus extracted TWICE, once per
 * value of that leaf, and the difference between the two datasets has to be the leaf and nothing
 * else. A hand-edited copy of src/config.js cannot show that -- the copy IS the diff -- and a
 * dataset the fitter cannot reproduce is not evidence. So the arms are produced by this flag
 * instead: same input, same extractor, one config leaf apart. `lib/trained-weights.json`'s
 * `evaluator.weights` is fitted from whatever this tool writes, so "which corpus" is part of the
 * artifact's provenance (see ATTEMPTS.md §P8, where a stale corpus was found this way).
 *
 * INPUT   [{ "winner": "p1"|"p2", "log": "<protocol log, one line per element>" }, ...]
 *   `log` may be a string (split on '\n') or an array of lines. `winner` names the side that
 *   won the battle as the log spells it ('p1' / 'p2').
 * OUTPUT  { "dimensions": 128, "samples": N, "replays": [...provenance...], "rows": [ {x,y} ] }
 *
 * THE LABEL, STATED OUT LOUD
 *   The 128D evaluator is written from ONE side's point of view: `state.mySide` (p1 by default,
 *   which is what the real extension sees) is "us". So a row is labelled y = 1 exactly when the
 *   replay's winner is `state.mySide` AFTER the replay has run — the state manager can flip
 *   mySide from a `|request|` line, so it is read from the finished state rather than assumed.
 *   A corpus logged from p2's screen must therefore be relabelled, or its mySide changed, before
 *   the weights it produces mean anything.
 *
 * ONE ROW PER TURN HEADER
 *   A row is taken at each `|turn|N` line, where the board is the one the players were looking
 *   at when they chose: both actives present and neither fainted. Turns are skipped (and counted
 *   in the provenance) when an active is missing or fainted, and thrown lines never abort the
 *   replay — a battle log always contains something this project did not model.
 *
 * DETERMINISM
 *   Same corpus in, byte-identical JSON out: no timestamps, no Math.random, no object-key order
 *   dependence beyond insertion order.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIM = 128;

/**
 * Parse a `--set` value. Only the scalars config.js actually stores are inferred and anything else
 * stays a string, so `--set x=maybe` cannot silently become NaN or `0` (the same rule
 * tools/run_arena.js and tools/benchmark_human_match.js apply to their own `--set`).
 */
function parseConfigValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/**
 * buildConfigPatch(ST, sets) -> { patch, applied }
 *
 * WHY THE LEAF MUST ALREADY EXIST: a run that toggles a MISSPELT flag extracts the same corpus
 * twice and then reports the difference as "the feature moves nothing" -- the worst possible
 * failure for an arm that is supposed to be compared, because it is a lie about the FLAG rather
 * than a finding about the feature. An unknown path is therefore an error, not a new key, and so
 * is an unknown intermediate section. The patch carries the WHOLE top-level section (cloned), not
 * just the leaf, because `configMerge` assigns at each level rather than deep-merging: a patch of
 * `{ laplace: { pricePivots: { enabled: true } } }` would replace `laplace` outright and reset
 * every other knob in it to `cfg()`'s default.
 */
function buildConfigPatch(ST, sets) {
  if (!ST || !ST.CONFIG || typeof ST.configGet !== 'function') {
    throw new Error('extract_training_data: config.js is not loaded yet, cannot apply --set');
  }
  const patch = {};
  const applied = [];
  (sets || []).forEach(function (raw) {
    const entry = String(raw);
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new Error('--set expects <path>=<value>, got "' + entry + '"');
    const dotted = entry.slice(0, eq).trim();
    const value = parseConfigValue(entry.slice(eq + 1).trim());
    const parts = dotted.split('.');
    if (parts.length < 2) throw new Error('--set needs a section path (e.g. evaluator.scale), got ' + dotted);
    const sentinel = {};
    const before = ST.configGet(dotted, sentinel);
    if (before === sentinel) throw new Error('--set ' + dotted + ': src/config.js defines no such tunable');
    const top = parts[0];
    const section = patch[top] || (patch[top] = JSON.parse(JSON.stringify(ST.CONFIG[top])));
    let node = section;
    for (let i = 1; i < parts.length - 1; i++) {
      if (node[parts[i]] === undefined || typeof node[parts[i]] !== 'object' || node[parts[i]] === null) {
        throw new Error('--set ' + dotted + ': "' + parts.slice(0, i + 1).join('.') + '" is not a config section');
      }
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
    applied.push({ path: dotted, from: before, to: value });
  });
  return { patch: patch, applied: applied };
}

/**
 * Build the pipeline classes through the test harness (same load order as the extension).
 *
 * `sets` (from `--set`) must reach the CONFIG before the modules that read it at LOAD time, which
 * is what the harness's `afterEach` window exists for: the patch lands the instant src/config.js
 * has been evaluated, so every later file sees it. A patch applied after `loadAll()` returns
 * cannot reach a module-level constant (src/set_pruner.js reads its own leaves while it loads),
 * which would silently extract the unpatched corpus under a patched filename.
 *
 * READ BACK. `applied` is the proof that each `--set` landed; without it an arm that failed to
 * patch would be a byte-copy of the other arm, and "this leaf changes nothing" would be a claim
 * about the flag instead of about the feature.
 */
function loadApi(sets) {
  const harness = require('../tests/harness.js');
  const out = { ST: null, harness: harness, applied: null };
  const hooks = (sets && sets.length) ? {
    afterEach: function (sandbox, rel) {
      if (rel !== 'src/config.js') return;
      const built = buildConfigPatch(sandbox.ST, sets);
      sandbox.ST.configMerge(built.patch);
      built.applied.forEach(function (p) {
        const sentinel = {};
        const now = sandbox.ST.configGet(p.path, sentinel);
        if (JSON.stringify(now) !== JSON.stringify(p.to)) {
          throw new Error('--set ' + p.path + ' did not take: config reads ' + JSON.stringify(now) +
            ', asked for ' + JSON.stringify(p.to));
        }
      });
      out.applied = built.applied;
    }
  } : undefined;
  const sandbox = harness.loadAll({}, hooks);
  out.ST = sandbox.ST;
  return out;
}

function linesOf(log) {
  if (Array.isArray(log)) return log.map(function (l) { return String(l).replace(/\r$/, ''); });
  return String(log === undefined || log === null ? '' : log).split('\n').map(function (l) {
    return l.replace(/\r$/, '');
  });
}

function replaysOf(corpus) {
  if (Array.isArray(corpus)) return corpus;
  if (corpus && Array.isArray(corpus.replays)) return corpus.replays;
  throw new Error('extract_training_data: input must be an array of replays or {replays:[...]}');
}

/**
 * THE PRUNER IS PART OF THE OBSERVATION, NOT A DECORATION.
 *
 * `cannotBeChoice`, `itemless`, `liveSet` and the speed bounds are written by ONE module,
 * src/set_pruner.js, and read by dims 64..75 of the frozen 128D layout. The browser builds that
 * pruner in src/content.js and calls it on events; this tool did not build one at all, so those
 * dims were constant 0 in every extracted row -- the fitter was handed columns that no corpus
 * could move, and the "structurally zero" weights it produced were an artifact of the extractor,
 * not a fact about the format.
 *
 * `drivePruner` reproduces src/content.js's own call sites -- the same event kinds, the same
 * guards, the same order -- instead of "prune every body every turn", because the point is to
 * extract the board the ENGINE actually sees. A deduction the browser makes on a `|move|` line
 * and this tool made somewhere else would put a different vector in the corpus.
 *
 * Returns how many times it pruned, so tests/weights_check.js can prove the wiring is live rather
 * than merely present.
 */
function monForEvent(manager, event, U) {
  if (!manager || !manager.state || !event) return null;
  const state = manager.state;
  const side = event.side || null;
  if (side && event.slot && typeof manager.getMon === 'function') {
    const mon = manager.getMon(side, event.slot);
    if (mon) return mon;
  }
  const team = side === state.mySide ? state.myTeam : state.oppTeam;
  if (!team) return null;
  const wanted = U.toID(event.species);
  for (let i = 0; i < team.length; i++) {
    if (team[i] && U.toID(team[i].species || team[i].id) === wanted) return team[i];
  }
  return null;
}

function drivePruner(manager, event, pruner, U) {
  if (!event || !pruner) return 0;
  const state = manager.state;
  let calls = 0;
  const prune = function (mon) {
    if (!mon || !state) return;
    pruner.prune(mon, state);
    calls++;
  };
  if (event.type === 'init') {
    // A fresh battle must not inherit the previous game's pool (content.js does the same).
    if (typeof pruner.reset === 'function') pruner.reset();
    return 0;
  }
  if (event.type === 'speedfloor') {
    if (typeof pruner.handleSpeedFloorEvent === 'function') pruner.handleSpeedFloorEvent(event, state);
    return 0;
  }
  if (event.type === 'move') {
    const mon = monForEvent(manager, event, U);
    if (mon) {
      const twoMoves = (mon.activeStintMoves || []).length >= 2 && !mon.isEncored;
      if (twoMoves || (mon.candidateSets || []).length > 1) prune(mon);
    }
    return calls;
  }
  if (event.type === 'item' || event.type === 'enditem' || event.type === 'activate' || event.type === 'switch') {
    prune(monForEvent(manager, event, U));
    if (state && state.formatLocks && state.formatLocks.oppHasMegaEvolved &&
      typeof pruner.applyFormatLockCascade === 'function') {
      pruner.applyFormatLockCascade(state);
    }
  }
  return calls;
}

/**
 * extractDataset(corpus, api) -> { dimensions, samples, replays, rows }
 * `api` is { ST } (the harness sandbox); omit it and the harness is loaded here.
 */
function extractDataset(corpus, api) {
  const ST = (api && api.ST) || loadApi().ST;
  const replays = replaysOf(corpus);
  const rows = [];
  const provenance = [];

  for (let r = 0; r < replays.length; r++) {
    const replay = replays[r] || {};
    const winner = String(replay.winner === undefined || replay.winner === null ? '' : replay.winner).toLowerCase();
    if (winner !== 'p1' && winner !== 'p2') {
      throw new Error('extract_training_data: replay ' + r + ' has winner ' +
        JSON.stringify(replay.winner) + '; expected "p1" or "p2"');
    }

    const parser = new ST.ProtocolParser();
    const manager = new ST.BattleStateManager({ debug: false });
    manager.attachParser(parser);
    // The damage engine is built first because the pruner's reverse-damage rule runs an observed
    // hit back through each candidate spread to disprove it, and the evaluator shares the same
    // instance so the cleaner dims (120/121) read ITS memo rather than rebuilding one per row.
    const damage = ST.DamageEngine ? new ST.DamageEngine({ gen: 9 }) : null;
    const pruner = (ST.ArchetypePruner && damage) ? new ST.ArchetypePruner({ damage: damage }) : null;
    const evaluator = new ST.DenseStateEvaluator({ damage: damage });
    let prunes = 0;

    const lines = linesOf(replay.log);
    const local = [];
    let turns = 0, skipped = 0;

    for (let i = 0; i < lines.length; i++) {
      let evt = null;
      try {
        evt = parser.feed(lines[i]);
      } catch (e) {
        continue;                                   // a malformed line is not a reason to abort
      }
      if (!evt) continue;
      if (pruner) prunes += drivePruner(manager, evt, pruner, ST.util);
      if (evt.type !== 'turn') continue;
      const state = manager.state;
      if (!state) continue;
      const mine = state.active && state.active.my;
      const theirs = state.active && state.active.opp;
      if (!mine || !theirs || mine.fainted || theirs.fainted) { skipped++; continue; }
      // extractVector reuses one buffer: copy it before the next turn overwrites it.
      local.push(Array.from(evaluator.extractVector(state)));
      turns++;
    }

    const state = manager.state || {};
    const mySide = state.mySide === 'p2' ? 'p2' : 'p1';
    const won = winner === mySide;
    for (let i = 0; i < local.length; i++) {
      rows.push({ x: local[i], y: won ? 1 : 0 });
    }
    provenance.push({
      index: r, winner: winner, mySide: mySide, label: won ? 1 : 0,
      lines: lines.length, turns: turns, skippedTurns: skipped, rows: local.length,
      // Published so a reader can tell a corpus that exercised the pruner from one that did not:
      // a run with `prunes: 0` carries the four item dims at constant zero for a reason that has
      // nothing to do with the format.
      prunes: prunes, pruner: !!pruner
    });
  }

  return { dimensions: DIM, samples: rows.length, replays: provenance, rows: rows };
}

/* ---------------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const out = { input: null, out: 'training_data.json', quiet: false, sets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--set') out.sets.push(String(argv[++i]));
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

function main(argv) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node tools/extract_training_data.js --input replays.json [--out training_data.json]');
    console.log('       [--set <path>=<value> ...]   patch a config.js tunable for this extraction');
    console.log('                                    (repeatable, e.g. --set evaluator.threatSpeedGate.enabled=true)');
    return 0;
  }
  if (!opts.input) throw new Error('--input is required');
  const corpus = JSON.parse(fs.readFileSync(path.resolve(ROOT, opts.input), 'utf8'));
  const api = loadApi(opts.sets);
  const dataset = extractDataset(corpus, api);
  const target = path.resolve(ROOT, opts.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(dataset) + '\n');
  if (!opts.quiet) {
    const skipped = dataset.replays.reduce(function (s, p) { return s + p.skippedTurns; }, 0);
    console.log('replays: ' + dataset.replays.length + ' | rows: ' + dataset.samples +
      ' | skipped (missing/fainted active): ' + skipped + ' | dimensions: ' + dataset.dimensions);
    (api.applied || []).forEach(function (p) {
      console.log('  --set ' + p.path + ' = ' + JSON.stringify(p.to) +
        ' (was ' + JSON.stringify(p.from) + '; read back from the sandbox)');
    });
    dataset.replays.forEach(function (p) {
      console.log('  replay ' + p.index + ': winner ' + p.winner + ', mySide ' + p.mySide +
        ', label ' + p.label + ', rows ' + p.rows);
    });
    console.log('wrote ' + path.relative(ROOT, target));
  }
  return 0;
}

module.exports = { DIM: DIM, extractDataset: extractDataset, linesOf: linesOf, replaysOf: replaysOf,
  parseArgs: parseArgs, main: main, loadApi: loadApi, drivePruner: drivePruner, monForEvent: monForEvent,
  parseConfigValue: parseConfigValue, buildConfigPatch: buildConfigPatch };

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error('extract_training_data: ' + ((err && err.message) || err));
    process.exit(1);
  }
}
