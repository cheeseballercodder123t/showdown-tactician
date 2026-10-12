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

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Ordered cheapest-first so a trivial break fails fast. `test_engine.js` lives at the repo root.
const SUITES = [
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
  'tests/cross_check.js',
  'tests/scout_check.js',
  'tests/invariants_check.js',
  'tests/mlp_check.js',
  'tests/weights_check.js',
  'tests/hud_check.js',
  'tests/dom_check.js',
  'test_engine.js',
  'tests/run_tests.js',
  'tests/hardening_audit.js'
];

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
