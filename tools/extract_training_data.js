/* Showdown Tactician — tools/extract_training_data.js
 * Turns a corpus of battle replays into the (state vector, outcome) dataset that
 * tools/fit_weights.js fits. This is the data half of the empirical-weight pipeline; it never
 * touches src/ and never talks to the network.
 *
 * Run me with:
 *   node tools/extract_training_data.js --input replays.json --out training_data.json
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

/** Build the pipeline classes through the test harness (same load order as the extension). */
function loadApi() {
  const harness = require('../tests/harness.js');
  return { ST: harness.loadAll().ST, harness: harness };
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
    const evaluator = new ST.DenseStateEvaluator();

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
      if (!evt || evt.type !== 'turn') continue;
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
      lines: lines.length, turns: turns, skippedTurns: skipped, rows: local.length
    });
  }

  return { dimensions: DIM, samples: rows.length, replays: provenance, rows: rows };
}

/* ---------------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const out = { input: null, out: 'training_data.json', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
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
    return 0;
  }
  if (!opts.input) throw new Error('--input is required');
  const corpus = JSON.parse(fs.readFileSync(path.resolve(ROOT, opts.input), 'utf8'));
  const dataset = extractDataset(corpus);
  const target = path.resolve(ROOT, opts.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(dataset) + '\n');
  if (!opts.quiet) {
    const skipped = dataset.replays.reduce(function (s, p) { return s + p.skippedTurns; }, 0);
    console.log('replays: ' + dataset.replays.length + ' | rows: ' + dataset.samples +
      ' | skipped (missing/fainted active): ' + skipped + ' | dimensions: ' + dataset.dimensions);
    dataset.replays.forEach(function (p) {
      console.log('  replay ' + p.index + ': winner ' + p.winner + ', mySide ' + p.mySide +
        ', label ' + p.label + ', rows ' + p.rows);
    });
    console.log('wrote ' + path.relative(ROOT, target));
  }
  return 0;
}

module.exports = { DIM: DIM, extractDataset: extractDataset, linesOf: linesOf, replaysOf: replaysOf, parseArgs: parseArgs, main: main, loadApi: loadApi };

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error('extract_training_data: ' + ((err && err.message) || err));
    process.exit(1);
  }
}
