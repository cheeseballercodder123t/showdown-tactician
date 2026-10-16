/* Showdown Tactician — tests/run_all.js
 *
 * One command that runs every suite and fails if any of them does. There was no such command:
 * the seventeen suites existed but nothing ran them together, so a regression could be committed
 * silently. `npm test` (and CI) call this.
 *
 * Each suite is spawned as its own `node` process so a suite that calls process.exit() or leaves
 * a timer behind cannot take the runner down with it, and so the exit codes are the suites' own.
 * (Async spawn, not spawnSync — some sandboxes refuse the blocking variant.)
 *
 * Usage:  node tests/run_all.js [--fast]     (--fast skips the two slowest suites)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Ordered cheapest-first so a trivial break fails fast. `test_engine.js` lives at the repo root.
const SUITES = [
  'tests/harness_inputs_check.js',
  'tests/util_smoke.js',
  'tests/injected_bridge.js',
  'tests/rule_checks.js',
  'tests/config_check.js',
  'tests/chaos_sync_check.js',
  'tests/blackbox_guard.js',
  'tests/parser_fuzz.js',
  'tests/discrete_check.js',
  'tests/upgrades_check.js',
  'tests/pressure_check.js',
  'tests/quiescence_check.js',
  'tests/cross_check.js',
  'tests/scout_check.js',
  'tests/entropy_check.js',
  'tests/profile_check.js',
  'tests/wincon_check.js',
  'tests/endgame_check.js',
  'tests/invariants_check.js',
  'tests/ability_check.js',
  'tests/tuning_check.js',
  'tests/preview_check.js',
  'tests/mlp_check.js',
  'tests/weights_check.js',
  'tests/human_match_check.js',
  'tests/hud_check.js',
  'tests/dom_check.js',
  'test_engine.js',
  'tests/run_tests.js',
  'tests/hardening_audit.js',
  // The arena. `arena_check.js` drives the real @pkmn/sim engine, which is a devDependency the
  // other suites deliberately do not need: without `npm install` it prints a skip and exits 0
  // (the CI test job has no install step, so that is the path CI takes). `tactical_puzzles.js`
  // needs no sim — it replays harvested protocol prefixes through the repo's own pipeline — and
  // ships with zero puzzles, so it is green until a `--harvest` run writes a real defect into it.
  // `ablation_check.js` pins the ablation runner: its config-patch mechanism and refusals, each
  // flag's behaviour in a real engine, the feature table's integrity, the aggregation and
  // bootstrap maths, and one tiny live batch. It skips the live batch (not its own checks) when
  // the sim is missing, for the same reason arena_check skips entirely.
  'tests/tactical_puzzles.js',
  'tests/arena_check.js',
  'tests/ablation_check.js'
];

// The ONLY files in tests/ that are allowed not to be suites, each with its reason. This list is
// the whole point of assertRegistry() below: a suite that is never registered is invisible, and
// exactly that happened here — `tests/quiescence_check.js` (71 checks) was written, documented in
// the README, cited as evidence in the changelog, and executed by nothing, so a regression it was
// built to catch could land while this command reported success. A silent skip is the failure
// mode to design against, so an exception has to be written down and argued.
const NOT_A_SUITE = {
  'harness.js': 'the shared loader the sandboxed suites use, not a suite',
  'perf_bench.js': 'the benchmark (`npm run bench*`), informational unless --assert is passed',
  'run_all.js': 'this runner'
};

/**
 * The registry gate, run BEFORE anything is spawned.
 *
 * (a) every .js file in tests/ is either listed in SUITES or a declared exception above, and an
 *     exception is never also registered (that would mean one of the two lists lies); and
 * (b) the README's "Run everything" list names exactly the registered set, in both directions — a
 *     suite nobody runs, and a documented suite that does not exist, are the same defect.
 *
 * Either drift fails `npm test` with the offending names, instead of the drift being discovered by
 * hand a release later.
 */
function assertRegistry() {
  const problems = [];
  const registered = new Set(SUITES.map(function (s) { return s.replace(/^tests\//, ''); }));

  fs.readdirSync(path.join(ROOT, 'tests')).filter(function (f) { return /\.js$/.test(f); })
    .forEach(function (f) {
      if (registered.has(f) && NOT_A_SUITE[f]) {
        problems.push('tests/' + f + ' is BOTH registered in SUITES and declared an exception');
      } else if (!registered.has(f) && !NOT_A_SUITE[f]) {
        problems.push('tests/' + f + ' is not in SUITES and is not a declared exception, so nothing runs it');
      }
    });

  // The README entry point is the list of `node <path>` lines under "Run everything".
  const documented = new Set();
  fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').split(/\r?\n/).forEach(function (l) {
    const m = l.match(/^node\s+(tests\/[\w./-]+\.js|test_engine\.js)\s+#/);
    if (m) documented.add(m[1]);
  });
  if (!documented.size) {
    problems.push('the README\'s suite list was not found — expected `node tests/<name>.js # N checks` lines');
  }
  SUITES.forEach(function (s) {
    if (!documented.has(s)) problems.push('SUITES runs ' + s + ' but the README does not document it');
  });
  documented.forEach(function (d) {
    if (SUITES.indexOf(d) === -1) problems.push('the README documents ' + d + ' but SUITES does not run it');
  });

  if (problems.length) {
    console.error('\n  the suite registry is inconsistent (' + registered.size + ' registered, ' +
      documented.size + ' documented):\n');
    problems.forEach(function (p) { console.error('    - ' + p);
    });
    console.error('');
    return false;
  }
  return true;
}

// Skipped by --fast only: these are the two that dominate the wall clock.
const SLOW = ['tests/weights_check.js', 'tests/hud_check.js'];
const fast = process.argv.indexOf('--fast') !== -1;
const list = fast ? SUITES.filter(function (s) { return SLOW.indexOf(s) === -1; }) : SUITES;

function runOne(rel) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    const child = spawn(process.execPath, [rel], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', function (d) { out += d; });
    child.stderr.on('data', function (d) { out += d; });
    child.on('error', function (e) { resolve({ rel: rel, ok: false, ms: Date.now() - t0, last: 'spawn error: ' + e.message }); });
    child.on('close', function (code) {
      const lines = out.trim().split('\n').filter(Boolean);
      resolve({ rel: rel, ok: code === 0, ms: Date.now() - t0, last: lines.length ? lines[lines.length - 1].trim() : '(no output)' });
    });
  });
}

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

(async function () {
  if (!assertRegistry()) process.exit(1);
  let failed = 0;
  const started = Date.now();
  for (const rel of list) {
    const r = await runOne(rel);
    if (!r.ok) failed++;
    console.log((r.ok ? '  ok   ' : '  FAIL ') + pad(rel, 30) + pad((r.ms / 1000).toFixed(1) + 's', 8) + r.last.slice(0, 70));
  }
  const totalSec = ((Date.now() - started) / 1000).toFixed(1);
  console.log('');
  if (failed) {
    console.error('FAILED: ' + failed + ' of ' + list.length + ' suites (' + totalSec + 's)');
    process.exit(1);
  }
  console.log('ALL ' + list.length + ' SUITES PASSED (' + totalSec + 's)');
})();
