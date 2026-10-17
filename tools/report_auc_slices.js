/* Showdown Tactician — tools/report_auc_slices.js
 *
 * THE NUMBER THE POOLED AUC HIDES. tools/fit_weights.js prints one aucTest over the whole hold-out,
 * and that number is dominated by boards the evaluator cannot avoid getting right: a 5v1 is a body
 * count, and the opening 6v6 at full HP is close to a coin flip. Neither says anything about whether
 * the evaluator understands a LEVEL board, which is where the game is actually decided.
 *
 * This tool scores a vector on the SAME battle-grouped hold-out the fitter uses and cuts it three
 * ways (the slice definitions live in tools/fit_weights.js, so there is one implementation):
 *
 *   early    — 6v6, total HP over 1050 %  (the opening: a noise check, ~0.5 means "no leak")
 *   crucible — both sides >= 3 alive and |alive delta| <= 1, not early (a LEVEL mid-game: the only
 *              slice that measures positional understanding — hazards, status, boosts, threat)
 *   late     — everything else: a material edge of 2+ bodies, or a side down to 2 or fewer
 *
 * USAGE
 *   node tools/report_auc_slices.js --input corpus/training_data.json [options]
 *     --weights <file>   a report carrying weights128 (fit report or preference report). Repeatable.
 *     --holdout <k>      every k-th BATTLE is held out (default 5, the fitter's default)
 *     --no-shipped       omit the shipped-vector row
 *
 * The hold-out is derived from the payload's `replays` provenance with the fitter's own splitIndices,
 * so a model compared here is scored on exactly the rows its own fit never saw.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIT = require('./fit_weights.js');

function parseArgs(argv) {
  const out = { input: null, weights: [], holdout: 5, shipped: true, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--weights' || a === '-w') out.weights.push(argv[++i]);
    else if (a === '--holdout') out.holdout = parseInt(argv[++i], 10);
    else if (a === '--no-shipped') out.shipped = false;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

/** The vector the shipped build actually scores with, or null when the harness is unavailable. */
function shippedVector() {
  try {
    const HM = require('./benchmark_human_match.js');
    const api = HM.loadApi([]);
    const w = api.ST.DenseStateEvaluator.defaultWeights();
    return Array.prototype.slice.call(w);
  } catch (e) { return null; }
}

/** AUC of a raw 128-vector on a row set (no intercept, no tanh: AUC only needs the ordering). */
function aucOf(w, rows, labels) {
  const scores = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    let z = 0;
    // rowsOf() hands back the `{x,y}` row objects, but a caller may hand in bare x arrays.
    const x = rows[i].x || rows[i];
    for (let j = 0; j < 128 && j < x.length; j++) z += x[j] * w[j];
    scores[i] = z;
  }
  return FIT.slicedAuc(scores, labels, rows);
}

function pct(v) {
  return (typeof v === 'number' && isFinite(v)) ? (v * 100).toFixed(1) : '—';
}

function main(argv) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node tools/report_auc_slices.js --input training_data.json ' +
      '[--weights report.json ...] [--holdout 5] [--no-shipped]');
    return 0;
  }
  if (!opts.input) throw new Error('--input is required');
  const payload = JSON.parse(fs.readFileSync(path.resolve(ROOT, opts.input), 'utf8'));
  const rows = FIT.rowsOf(payload);
  if (!rows.length) throw new Error('report_auc_slices: the dataset has no rows');
  const groups = Array.isArray(payload.replays)
    ? payload.replays.map(function (p) { return (p && p.rows) || 0; })
    : null;
  const groupRows = groups
    ? groups.reduce(function (s, v) { return s + (typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0); }, 0)
    : 0;
  const usable = (groupRows > 0 && groupRows === rows.length) ? groups : null;
  const split = FIT.splitIndices(rows.length, opts.holdout, usable);
  const testRows = split.test.map(function (i) { return rows[i]; });
  const testY = split.test.map(function (i) { return rows[i].y ? 1 : 0; });
  if (!testRows.length) throw new Error('report_auc_slices: the hold-out is empty');

  const models = [];
  if (opts.shipped) {
    const w = shippedVector();
    if (w) models.push({ name: 'shipped (config)', w: w, slices: aucOf(w, testRows, testY) });
  }
  for (let i = 0; i < opts.weights.length; i++) {
    const file = path.resolve(ROOT, opts.weights[i]);
    const rep = JSON.parse(fs.readFileSync(file, 'utf8'));
    const w = Array.isArray(rep.weights128) ? rep.weights128 : null;
    if (!w || w.length !== 128) throw new Error(opts.weights[i] + ': no 128-dim `weights128`');
    models.push({
      name: (rep.kind || 'report') + ' ' + path.basename(file),
      w: w, slices: aucOf(w, testRows, testY)
    });
  }
  if (!models.length) throw new Error('report_auc_slices: nothing to score');

  if (!opts.quiet) {
    const all = models[0].slices.all;
    console.log('hold-out: ' + testRows.length + ' rows from ' + split.test.length +
      ' turns over ' + (usable ? split.battles + ' battles (' + Math.ceil(split.battles / Math.max(2, opts.holdout)) + ' held out)'
        : 'a row-level split') + ', positives ' + testY.reduce(function (s, v) { return s + v; }, 0));
    console.log('slices: early n=' + all.n + ' (whole hold-out; per-slice counts below)');
    console.log('  early    n=' + models[0].slices.early.n + '  pos=' + models[0].slices.early.pos +
      '   (6v6, total HP > 1050%: a noise check)');
    console.log('  crucible n=' + models[0].slices.crucible.n + '  pos=' + models[0].slices.crucible.pos +
      '   (both >= 3 alive, |alive delta| <= 1)');
    console.log('  late     n=' + models[0].slices.late.n + '  pos=' + models[0].slices.late.pos +
      '   (material edge >= 2, or a side <= 2 alive)');
    console.log('');
    const pad = function (s, n) { s = String(s); while (s.length < n) s += ' '; return s; };
    console.log(pad('model', 46) + pad('all', 8) + pad('early', 8) + pad('crucible', 10) + pad('late', 8));
    for (let i = 0; i < models.length; i++) {
      const s = models[i].slices;
      console.log(pad(models[i].name, 46) + pad(pct(s.all.auc), 8) + pad(pct(s.early.auc), 8) +
        pad(pct(s.crucible.auc), 10) + pad(pct(s.late.auc), 8));
    }
  }
  return 0;
}

module.exports = { parseArgs: parseArgs, aucOf: aucOf, shippedVector: shippedVector, main: main };

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error('report_auc_slices: ' + ((err && err.message) || err));
    process.exit(1);
  }
}
