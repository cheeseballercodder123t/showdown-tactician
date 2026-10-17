/* Showdown Tactician — tools/refit_weights.js
 *
 * ONE COMMAND FOR THE REFIT: replays (or an already-extracted dataset) in, a fresh
 * lib/trained-weights.json out, with the exactly-collinear macro columns projected away.
 *
 * WHY THIS EXISTS. The shipped artifact cannot be reproduced from a checkout: the replays are
 * third-party content and are not in the repo (see tests/weights_check.js §8). Every "refit the
 * weights" instruction in the docs therefore ended in a hand-written sequence of three commands,
 * two of which had to be remembered — extract with the pruner ON, fit, then clamp. This tool is
 * that sequence, and it REFUSES rather than guessing when there is nothing to fit: exit 2 with the
 * paths it probed, so an unattended run reports "no corpus" instead of writing a zero-row artifact
 * over the shipped one.
 *
 * USAGE
 *   node tools/refit_weights.js                     # probe the usual corpus locations
 *   node tools/refit_weights.js --corpus replays.json
 *   node tools/refit_weights.js --input training_data.json
 *   node tools/refit_weights.js --dry               # fit and report, write nothing
 *   node tools/refit_weights.js --keep-collinear-macro
 *
 * WHAT IT DOES NOT DO
 *   It does not download replays (tools/fetch_replays.js owns that), and it does not decide
 *   whether the new fit is BETTER: the hold-out AUC is printed so the number is reviewable, but a
 *   corpus change, a feature change and a fit change all move it. Adopting an artifact is a
 *   reviewed edit to lib/trained-weights.json + src/config.js, exactly as §8 of the weights suite
 *   describes.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const fitter = require('./fit_weights.js');

/** The same probe order tools/benchmark_human_match.js uses, so the two tools agree. */
function probeCorpus() {
  const candidates = [];
  if (process.env.ST_CORPUS) candidates.push(process.env.ST_CORPUS);
  candidates.push(path.join(os.tmpdir(), 'st-corpus', 'elite.json'));
  candidates.push(path.join(os.tmpdir(), 'st-corpus', 'replays.json'));
  candidates.push(path.join(ROOT, 'replays.json'));
  candidates.push(path.join(ROOT, 'corpus', 'elite.json'));
  candidates.push(path.join(ROOT, 'corpus', 'replays.json'));
  for (let i = 0; i < candidates.length; i++) {
    try { if (fs.statSync(candidates[i]).isFile()) return { path: candidates[i], probed: candidates }; } catch (e) { /* keep probing */ }
  }
  return { path: null, probed: candidates };
}

function parseArgs(argv) {
  const out = { corpus: null, input: null, out: 'lib/trained-weights.json', dry: false, quiet: false, dropCollinear: true, sets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus' || a === '-c') out.corpus = argv[++i];
    else if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--set') out.sets.push(String(argv[++i]));
    else if (a === '--dry') out.dry = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--drop-collinear-macro') out.dropCollinear = true;
    else if (a === '--keep-collinear-macro') out.dropCollinear = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

/**
 * Extract rows from a replays corpus. The extractor is run as its own process (not required in
 * here) because it boots the whole page harness; a child process keeps that global state out of
 * the fitter's process and gives its own exit status.
 */
function extract(opts) {
  const tmp = path.join(os.tmpdir(), 'st-refit-training-' + process.pid + '.json');
  const args = [path.join(ROOT, 'tools', 'extract_training_data.js'),
    '--input', path.resolve(ROOT, opts.corpus), '--out', tmp, '--quiet'];
  // The extractor's per-replay line is noise here: this tool prints the fit summary, and the
  // feature flags are echoed in the extraction report it returns.
  (opts.sets || []).forEach(function (s) { args.push('--set', s); });
  execFileSync(process.execPath, args, { stdio: 'inherit' });
  const payload = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  try { fs.unlinkSync(tmp); } catch (e) { /* best effort */ }
  return payload;
}

function main(argv, deps) {
  const opts = parseArgs(argv || process.argv.slice(2));
  // Injected in tests so the NO-CORPUS branch can be exercised on a checkout that HAS one.
  const probe = (deps && typeof deps.probe === 'function') ? deps.probe : probeCorpus;
  if (opts.help) {
    console.log('usage: node tools/refit_weights.js [--corpus replays.json | --input training_data.json]\n' +
      '       [--out lib/trained-weights.json] [--dry] [--quiet] [--set <config.path>=<value> ...]\n' +
      '       [--drop-collinear-macro | --keep-collinear-macro]');
    console.log('\nWith neither --corpus nor --input it probes $ST_CORPUS, then %TEMP%/st-corpus/' +
      '{elite,replays}.json,\nthen ./replays.json, then ./corpus/{elite,replays}.json. Nothing found ' +
      'is an\nexit 2, never a fit over an empty dataset.');
    return 0;
  }

  let payload = null;
  let source = null;
  if (opts.input) {
    source = path.resolve(ROOT, opts.input);
    payload = JSON.parse(fs.readFileSync(source, 'utf8'));
  } else {
    const found = opts.corpus
      ? { path: path.resolve(ROOT, opts.corpus), probed: [] }
      : probe();
    if (!found.path) {
      console.error('refit_weights: NO CORPUS — nothing was fitted, nothing was written.');
      console.error('  probed:');
      found.probed.forEach(function (p) { console.error('    ' + p + (fs.existsSync(p) ? '  (exists)' : '')); });
      console.error('  place a replays JSON at one of those paths (or pass --corpus / --input),\n' +
        '  or fetch one with tools/fetch_replays.js, then run this command again.');
      return 2;
    }
    source = found.path;
    if (!opts.quiet) console.log('extracting rows from ' + path.relative(ROOT, source) + ' ...');
    payload = extract(Object.assign({}, opts, { corpus: source }));
  }

  const report = fitter.run(payload, { dropCollinear: opts.dropCollinear !== false });
  if (!opts.quiet) {
    console.log('samples ' + report.samples + ' (' + report.trainSamples + ' train / ' +
      report.testSamples + ' test), positives ' + report.positives);
    console.log('  AUC train ' + (report.aucTrain === null ? 'n/a' : report.aucTrain.toFixed(4)) +
      ' | AUC test ' + (report.aucTest === null ? 'n/a' : report.aucTest.toFixed(4)));
    console.log('  collinear macro columns dropped: ' +
      (report.collinearDropped.length
        ? report.collinearDropped.map(function (e) {
          return e.dim + ' <- [' + e.sources.join(',') + '] (residual ' + e.residual + ')';
        }).join('; ')
        : 'none'));
    console.log('  low-support dims zeroed: ' +
      (report.clampedDims.length ? report.clampedDims.join(' ') : 'none'));
  }
  if (opts.dry) {
    if (!opts.quiet) console.log('--dry: no file written');
    return 0;
  }
  const target = path.resolve(ROOT, opts.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  if (!opts.quiet) {
    console.log('wrote ' + path.relative(ROOT, target));
    console.log('NOW ADOPT IT: copy the spec into src/config.js evaluator.weights (and fitScale), then\n' +
      'run node tests/weights_check.js — §8 pins the artifact and the live vector to each other.');
  }
  return 0;
}

module.exports = { probeCorpus: probeCorpus, parseArgs: parseArgs, main: main, extract: extract };

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error('refit_weights: ' + ((err && err.message) || err));
    process.exit(1);
  }
}
