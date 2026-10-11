/* Showdown Tactician — tests/chaos_sync_check.js
 *
 * Run me with:  node tests/chaos_sync_check.js
 *
 * WHAT THIS IS
 *   The regression suite for the offline tooling that keeps the set database honest between
 *   metagame shifts: tools/sync_chaos_sets.js (the monthly chaos dump -> src/sets_usage.js
 *   overlay) and the ST.SetDatabase.reweightByUsage() hook that consumes it.
 *
 *   Nothing here touches the network, and nothing here writes a file: the tool exposes its pure
 *   pieces (normalizeUsage, filterChaos, buildOverlay, renderFile) so the dump parsing and the
 *   deterministic rendering can be pinned against fixtures, and the reweighting is pinned
 *   against an overlay built inline rather than against whatever was last committed.
 *
 * WHAT IT DOES NOT PROVE
 *   That the committed src/sets_usage.js matches today's ladder — that is a fact about
 *   play.pokemonshowdown.com, not about this code, and only a real run of the workflow can
 *   establish it. It also does not prove the GitHub Action runs: the workflow is asserted as
 *   text, because a YAML schema validator is not a dependency of this project.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const H = require('./harness.js');
const tool = require('../tools/sync_chaos_sets.js');

const S = H.loadAll();
const ST = S.ST;
const U = ST.util;
const cfg = ST.configGet;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; console.log('  PASS ' + name); return true; }
  failed++;
  failures.push(name + (detail === undefined ? '' : '  ->  ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  ->  ' + detail));
  return false;
}
function close(name, got, want, tol) {
  const ok = typeof got === 'number' && isFinite(got) && Math.abs(got - want) <= tol;
  return check(name, ok, 'got ' + got + ', want ' + want + ' (+-' + tol + ')');
}
function eq(name, got, want) {
  return check(name, JSON.stringify(got) === JSON.stringify(want),
    'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

/* A fixture shaped like the published dump: `usage` is a 0..1 fraction there, and one species
 * carries the percent form already so the two code paths are both exercised. */
const PAYLOAD = {
  info: { metagame: 'gen9nationaldexou', cutoff: 1760 },
  data: {
    'Great Tusk': {
      usage: 0.312,
      Items: { 'Heavy-Duty Boots': 0.62, 'Leftovers': 0.11, 'Booster Energy': 0.07, 'Rocky Helmet': 0 },
      Abilities: { Protosynthesis: 1 },
      Moves: { 'Earthquake': 0.9, 'Rapid Spin': 0.8, 'Close Combat': 0.7, 'Headlong Rush': 0.5 }
    },
    'Kingambit': {
      usage: 31.0,
      Items: { 'Leftovers': 0.4, 'Black Glasses': 0.3 },
      Abilities: { 'Supreme Overlord': 0.9 },
      Moves: { 'Sucker Punch': 0.95, 'Kowtow Cleave': 0.9 }
    },
    'Rare Mon': { usage: 0.008, Items: { 'Leftovers': 1 }, Abilities: {}, Moves: {} }
  }
};

const OPTS = { minUsage: 1.5, source: 'fixture', date: '2026-10-01T00:00:00.000Z' };

/* ====================================================== 1. the usage floor */

section('1. only species at or above the usage floor survive');

const kept = tool.filterChaos(PAYLOAD, { minUsage: 1.5 });
eq('the surviving species, most used first', kept.map(function (r) { return r.name; }), ['Great Tusk', 'Kingambit']);
close('a 0.312 fraction reads as 31.2 percent', kept[0].usage, 31.2, 1e-9);
close('a value already in percent is left alone', kept[1].usage, 31.0, 1e-9);
check('a species under the floor is dropped', kept.some(function (r) { return r.name === 'Rare Mon'; }) === false,
  kept.map(function (r) { return r.name; }).join(','));
const atFloor = tool.filterChaos({ data: { 'Edge': { usage: 1.5 }, 'Under': { usage: 1.49 } } }, { minUsage: 1.5 });
eq('the floor is inclusive', atFloor.map(function (r) { return r.name; }), ['Edge']);
const bare = tool.filterChaos({ 'Great Tusk': { usage: 0.312 } }, { minUsage: 1.5 });
eq('a payload without the info/data envelope is still read', bare.map(function (r) { return r.name; }), ['Great Tusk']);
eq('garbage entries are skipped, not thrown on',
  tool.filterChaos({ data: { 'A': null, 'B': { usage: 40 }, 'C': 'nonsense' } }, { minUsage: 1.5 })
    .map(function (r) { return r.name; }), ['B']);

/* ================================================== 2. usage normalisation */

section('2. normalizeUsage accepts a fraction and a percent');

close('0.31 is a fraction => 31', tool.normalizeUsage(0.31), 31, 1e-9);
close('31.0 is already a percent', tool.normalizeUsage(31.0), 31, 1e-9);
close('exactly 1 means 100 percent', tool.normalizeUsage(1), 100, 1e-9);
close('1.5 is already a percent', tool.normalizeUsage(1.5), 1.5, 1e-9);
close('a numeric string is parsed', tool.normalizeUsage('0.25'), 25, 1e-9);
close('junk is 0 rather than NaN', tool.normalizeUsage('x'), 0, 1e-9);
close('a negative is 0', tool.normalizeUsage(-3), 0, 1e-9);
close('missing is 0', tool.normalizeUsage(undefined), 0, 1e-9);

/* ==================================================== 3. keys are engine ids */

section('3. every emitted key is a ST.util.toID id');

const ODD = { data: {} };
['Mr. Mime', "Farfetch'd", 'Wo-Chien', 'Type: Null', 'Flab\u00e9b\u00e9', 'Great Tusk'].forEach(function (name) {
  ODD.data[name] = { usage: 0.2, Items: { 'Leftovers': 0.5 }, Abilities: { Levitate: 1 }, Moves: { 'Tackle': 0.5 } };
});
const oddOverlay = tool.buildOverlay(ODD, OPTS);
['Mr. Mime', "Farfetch'd", 'Wo-Chien', 'Type: Null', 'Flab\u00e9b\u00e9', 'Great Tusk'].forEach(function (name) {
  check('the key for ' + name + ' is U.toID(name)', !!oddOverlay.species[U.toID(name)],
    Object.keys(oddOverlay.species).join(', '));
});
check('no key is a raw display name',
  Object.keys(oddOverlay.species).every(function (id) { return id === U.toID(id); }),
  Object.keys(oddOverlay.species).join(', '));
check('the Flab\u00e9b\u00e9 special case matches the engine', !!oddOverlay.species['flabebe']);

const overlay = tool.buildOverlay(PAYLOAD, OPTS);
eq('item keys are ids, most common first',
  Object.keys(overlay.species[U.toID('Great Tusk')].items),
  ['heavydutyboots', 'leftovers', 'boosterenergy']);
close('item shares are percents', overlay.species[U.toID('Great Tusk')].items.heavydutyboots, 62, 1e-9);
check('a zero share is dropped rather than stored',
  overlay.species[U.toID('Great Tusk')].items.rockyhelmet === undefined);
eq('the overlay counts only what it kept', overlay.speciesCount, 2);
eq('the overlay records the source dump it came from', overlay.source, 'fixture');
eq('the overlay records the date it was taken', overlay.generatedAt, OPTS.date);
const capped = tool.buildOverlay(PAYLOAD, { minUsage: 1.5, maxItems: 2 });
eq('the per-species marginal cap is honoured', Object.keys(capped.species[U.toID('Great Tusk')].items),
  ['heavydutyboots', 'leftovers']);

/* ============================================= 4. deterministic rendering */

section('4. the generated file is deterministic and loads as data');

const text = tool.renderFile(overlay);
eq('the same overlay renders byte-identical text', tool.renderFile(tool.buildOverlay(PAYLOAD, OPTS)), text);
check('a different dump renders different text',
  tool.renderFile(tool.buildOverlay({ data: { 'Other': { usage: 31 } } }, OPTS)) !== text);
check('the header names the generated file and the tool that writes it',
  text.indexOf('src/sets_usage.js') !== -1 && text.indexOf('tools/sync_chaos_sets.js') !== -1 &&
  text.indexOf('GENERATED FILE') !== -1);
check('the rendered file is a strict-mode IIFE', /\(function \(\) \{\n  "use strict";/.test(text));

const env = H.loadAll(null, { through: 'src/sets_db.js' });
let ran = null;
try { vm.runInContext(text, env, { filename: 'src/sets_usage.js' }); ran = true; } catch (e) { ran = String(e.message); }
check('the rendered text is valid JavaScript', ran === true, ran === true ? '' : ran);
check('it assigns window.ST_USAGE', !!(env.window && env.window.ST_USAGE));
if (env.window && env.window.ST_USAGE) {
  eq('the loaded overlay keeps its species count', env.window.ST_USAGE.speciesCount, 2);
  eq('the loaded overlay keeps its item keys',
    Object.keys(env.window.ST_USAGE.species[U.toID('Great Tusk')].items),
    ['heavydutyboots', 'leftovers', 'boosterenergy']);
  close('the loaded overlay keeps its percents',
    env.window.ST_USAGE.species[U.toID('Great Tusk')].items.leftovers, 11, 1e-9);
}

/* ============================================== 5. the reweighting hook */

section('5. reweightByUsage folds usage into the curated weights');

const SETS = [
  { id: 'a', species: 'Great Tusk', item: 'Heavy-Duty Boots', weight: 0.4 },
  { id: 'b', species: 'Great Tusk', item: 'Leftovers', weight: 0.3 },
  { id: 'c', species: 'Great Tusk', item: 'Air Balloon', weight: 0.2 },
  { id: 'd', species: 'Unknown Mon', item: 'Heavy-Duty Boots', weight: 0.5 }
];
const FIXTURE = {
  generatedAt: OPTS.date,
  source: 'fixture',
  minUsage: 1.5,
  speciesCount: 1,
  species: {
    greattusk: { name: 'Great Tusk', usage: 31.2, items: { heavydutyboots: 62, leftovers: 0 }, abilities: {}, moves: {} }
  }
};

const reweight = ST.SetDatabase && ST.SetDatabase.reweightByUsage;
const hasHook = typeof reweight === 'function';
check('ST.SetDatabase.reweightByUsage is exported', hasHook, typeof reweight);

if (hasHook) {
  const before = JSON.stringify(SETS);
  const out = reweight(SETS, FIXTURE);
  check('the result is a new array of the same length', Array.isArray(out) && out !== SETS && out.length === SETS.length,
    Array.isArray(out) ? out.length : typeof out);
  close('a 62% item multiplies the curated weight by 0.62', out[0].weight, 0.4 * 0.62, 1e-9);
  close('a zero share is clamped to the configured floor', out[1].weight / 0.3, cfg('usage.floor', 0.05), 1e-9);
  close('an item the dump never saw leaves the weight alone', out[2].weight, 0.2, 1e-9);
  close('a species the dump never saw leaves the weight alone', out[3].weight, 0.5, 1e-9);
  eq('the input array and its sets are not mutated', JSON.stringify(SETS), before);

  const high = reweight([{ id: 'x', species: 'Great Tusk', item: 'Leftovers', weight: 0.3 }],
    { species: { greattusk: { usage: 31.2, items: { leftovers: 100 } } } });
  close('a 100% item is a factor of exactly 1', high[0].weight, 0.3, 1e-9);
  const over = reweight([{ id: 'x', species: 'Great Tusk', item: 'Leftovers', weight: 0.3 }],
    { species: { greattusk: { usage: 31.2, items: { leftovers: 140 } } } });
  close('a nonsensical share above 100% cannot inflate a weight', over[0].weight, 0.3, 1e-9);
  const none = reweight(SETS, null);
  check('an absent overlay returns an equivalent array',
    Array.isArray(none) && none.map(function (s) { return s.weight; }).join(',') === '0.4,0.3,0.2,0.5',
    JSON.stringify(none && none.map(function (s) { return s.weight; })));
  const empty = reweight(SETS, { species: {} });
  eq('an empty overlay changes nothing',
    empty.map(function (s) { return s.weight; }), [0.4, 0.3, 0.2, 0.5]);
  eq('every surviving set keeps its identity', out.map(function (s) { return s.id; }), ['a', 'b', 'c', 'd']);
}

/* ==================================================== 6. refusing a thin dump */

section('6. a dump with nothing usable is refused, never written');

let underFloor = null;
try { tool.buildOverlay({ data: { 'Rare Mon': { usage: 0.001 } } }, OPTS); } catch (e) { underFloor = e; }
check('a dump whose species are all under the floor is refused', !!underFloor,
  underFloor ? underFloor.message : 'no throw');
let emptyDump = null;
try { tool.buildOverlay({}, OPTS); } catch (e) { emptyDump = e; }
check('an empty dump is refused', !!emptyDump, emptyDump ? emptyDump.message : 'no throw');
let nullDump = null;
try { tool.buildOverlay(null, OPTS); } catch (e) { nullDump = e; }
check('a null dump is refused', !!nullDump, nullDump ? nullDump.message : 'no throw');
let thinDump = null;
try { tool.buildOverlay({ data: { 'No Stats': {} } }, OPTS); } catch (e) { thinDump = e; }
check('a dump with no usage numbers is refused', !!thinDump, thinDump ? thinDump.message : 'no throw');

const toolText = fs.readFileSync(path.join(H.ROOT, 'tools', 'sync_chaos_sets.js'), 'utf8');
check('the CLI turns a refusal into a non-zero exit',
  /process\.exitCode = 1/.test(toolText) && /nothing was written/.test(toolText));
check('the overlay is written only after a successful build',
  toolText.indexOf('writeFileSync') > toolText.indexOf('buildOverlay(payload'));

/* ======================================================== 7. the workflow */

section('7. the scheduled workflow regenerates and commits the overlay');

const wfPath = path.join(H.ROOT, '.github', 'workflows', 'chaos-sync.yml');
check('the workflow file exists', fs.existsSync(wfPath), wfPath);
const wf = fs.existsSync(wfPath) ? fs.readFileSync(wfPath, 'utf8') : '';
check('it runs on a monthly cron', /cron:\s*'0 6 3 \* \*'/.test(wf), 'no monthly cron found');
check('it can also be dispatched by hand', /workflow_dispatch:/.test(wf));
check('it can write to the repository', /contents:\s*write/.test(wf));
check('it checks the repository out', /actions\/checkout@/.test(wf));
check('it pins the Node version it runs on', /node-version:\s*'20'/.test(wf));
check('it runs the sync tool', /node tools\/sync_chaos_sets\.js/.test(wf));
check('it points at the monthly chaos dump', /stats\.pokemonshowdown\.com\/chaos\//.test(wf));
check('it filters the dump at the documented floor', /--min-usage 1\.5/.test(wf));
check('it writes the overlay the loader reads', /--out src\/sets_usage\.js/.test(wf));
check('it verifies the suites before committing',
  /node tests\/chaos_sync_check\.js/.test(wf) && /node tests\/config_check\.js/.test(wf));
check('it commits only when the overlay actually changed',
  /git diff --quiet -- src\/sets_usage\.js/.test(wf) && /git add src\/sets_usage\.js/.test(wf) && /git commit/.test(wf));
check('it pushes the commit', /git push/.test(wf));

/* ================================================================== summary */

console.log('\n=== summary ===');
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failed);
if (failed) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('ALL CHAOS SYNC CHECKS PASSED');
process.exit(0);
