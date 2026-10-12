/* Showdown Tactician — tests/tactical_puzzles.js
 *
 * WHY THIS EXISTS
 *   The arena can lose a hundred games and teach the engine nothing, because a harvested loss is
 *   only worth something once it is executable. This file is the registry and the runner for those
 *   artifacts: an automatic vaccine is a protocol prefix plus the line the engine should not have
 *   played, and running it replays the prefix through the REAL pipeline (parser -> state manager ->
 *   engine) instead of a hand-built board that could drift away from the engine it tests.
 *
 * HOW A PUZZLE IS EXECUTED
 *   `spec.logPrefix` is the raw Showdown protocol stream up to AND INCLUDING the decision frame at
 *   the turn in question. It is fed line by line into an `engine_bridge` session; the ranking the
 *   `|request|` line produces is the engine's answer. The puzzle then asserts:
 *     1. the engine ranked something at all (a prefix that does not end at a decision frame is a
 *        malformed puzzle, and it fails with the pipeline's own errors printed),
 *     2. the `forbiddenMove` is NOT the top live line, and
 *     3. at least one `validTopMoves` entry appears in the ranking.
 *
 * WHAT A FRESH VACCINE DOES — READ THIS BEFORE YOU PANIC AT A RED SUITE
 *   The engine is deterministic, so a vaccine harvested from a loss pins the blunder it just made:
 *   replaying that prefix reproduces the same ranking, `forbiddenMove` is the top line again, and
 *   the puzzle FAILS — correctly, and by design. A harvested vaccine is a written record of a known
 *   defect, and it turns green only when the engine is actually fixed. This file therefore ships
 *   with ZERO puzzles (green), and `tools/headless_arena/blunder_harvester.js` grows the list.
 *
 * HOW TO APPEND
 *   Generated code goes ABOVE the runner marker line near the bottom of this file (the one that
 *   reads "RUNNER, do not remove"), so it is registered before the runner executes.
 *   `appendVaccineToFile()` in the harvester does that safely (duplicate-checked, compile-checked,
 *   atomic). Do not hand-edit puzzles in some other place, and do not spell the marker out
 *   anywhere else in this file: the harvester inserts above the FIRST occurrence of that exact
 *   line, so a copy of it in a comment would place a vaccine above the registry's own declaration
 *   and break the suite with a temporal-dead-zone error.
 *
 * Run me with:  node tests/tactical_puzzles.js [--list]
 */
'use strict';

const path = require('path');

const bridge = require(path.join(__dirname, '..', 'tools', 'headless_arena', 'engine_bridge.js'));

/* The registry. Appended vaccines call `testPuzzle(...)` above the marker at the bottom. */
const PUZZLES = [];

function testPuzzle(name, spec) {
  if (!name || typeof name !== 'string') throw new Error('testPuzzle: a puzzle name is required');
  PUZZLES.push({ name: name, spec: spec || {} });
}

/* ------------------------------------------------------------------- machinery */

/* Two one-line helpers are duplicated from the harvester rather than shared: this file is a test
 * suite that generated code depends on, so it must not import a tool module to run a puzzle. */
function toId(value) {
  return String(value === null || value === undefined ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function asLines(log) {
  if (Array.isArray(log)) return log.map(function (l) { return String(l); });
  return String(log === null || log === undefined ? '' : log).split('\n');
}

/* A legal, six-body National Dex paste. Used only when a puzzle carries no team of its own and the
 * arena's sample teams are not on disk — the engine needs a team to rank anything, and a puzzle
 * must not fail merely because a sibling tool module is absent. */
const FALLBACK_PASTE = [
  'Great Tusk @ Choice Scarf', 'Ability: Protosynthesis', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
  '- Headlong Rush', '- Close Combat', '- Ice Spinner', '- Rapid Spin', '',
  'Slowking-Galar @ Assault Vest', 'Ability: Regenerator', 'EVs: 252 HP / 4 SpA / 252 SpD', 'Sassy Nature', 'IVs: 0 Spe',
  '- Future Sight', '- Scald', '- Sludge Bomb', '- Flamethrower', '',
  'Ferrothorn @ Leftovers', 'Ability: Iron Barbs', 'EVs: 252 HP / 88 Def / 168 SpD', 'Relaxed Nature', 'IVs: 0 Spe',
  '- Stealth Rock', '- Leech Seed', '- Power Whip', '- Protect', '',
  'Dragapult @ Heavy-Duty Boots', 'Ability: Infiltrator', 'EVs: 252 SpA / 4 SpD / 252 Spe', 'Timid Nature',
  '- Shadow Ball', '- Draco Meteor', '- U-turn', '- Thunderbolt', '',
  'Corviknight @ Leftovers', 'Ability: Pressure', 'EVs: 252 HP / 168 Def / 88 SpD', 'Impish Nature',
  '- Brave Bird', '- Body Press', '- U-turn', '- Roost', '',
  'Iron Valiant @ Booster Energy', 'Ability: Quark Drive', 'EVs: 4 Atk / 252 SpA / 252 Spe', 'Naive Nature',
  '- Moonblast', '- Close Combat', '- Thunderbolt', '- Knock Off'
].join('\n');

function loadTeams() {
  try {
    return require(path.join(__dirname, '..', 'tools', 'headless_arena', 'teams.js'));
  } catch (e) {
    return null;
  }
}

/** Every paste worth trying for a puzzle, best first: the puzzle's own, then the arena samples. */
function pasteCandidates(spec) {
  const out = [];
  if (spec && typeof spec.paste === 'string' && spec.paste.trim()) out.push(spec.paste);
  const teams = loadTeams();
  const samples = (teams && teams.SAMPLE_TEAMS) || {};
  ['hazardStackBalance', 'anchorBalance', 'voltTurnOffense', 'trickRoomSweep'].forEach(function (key) {
    if (typeof samples[key] === 'string' && samples[key]) out.push(samples[key]);
  });
  out.push(FALLBACK_PASTE);
  return out;
}

function buildSession(spec, label) {
  const failures = [];
  const candidates = pasteCandidates(spec);
  for (let i = 0; i < candidates.length; i++) {
    try {
      return { session: bridge.createSession({ paste: candidates[i], name: label }), pasteIndex: i };
    } catch (e) {
      failures.push((e && e.message) || String(e));
    }
  }
  throw new Error('no usable team paste for this puzzle (' + failures.join(' | ') + ')');
}

/**
 * Run one puzzle. Returns { name, ok, checks: [{name, ok, detail}], notes: [] } — never throws, so
 * a broken puzzle is a reported failure rather than a suite crash that hides the other puzzles.
 */
function runPuzzle(puzzle, options) {
  options = options || {};
  const name = (puzzle && puzzle.name) || '(unnamed)';
  const spec = (puzzle && puzzle.spec) || {};
  const checks = [];
  const notes = [];
  function fail(why) { notes.push(why); return { name: name, ok: false, checks: checks, notes: notes }; }

  if (!spec.logPrefix || (Array.isArray(spec.logPrefix) && !spec.logPrefix.length)) {
    return fail('the puzzle carries no logPrefix to replay');
  }
  const lines = asLines(spec.logPrefix);
  const lastLine = lines[lines.length - 1] || '';
  if (lastLine.indexOf('|request|') !== 0) {
    notes.push('the prefix does not end at a decision frame (last line: ' + JSON.stringify(lastLine) + ')');
  }

  let built;
  try {
    built = buildSession(spec, name);
  } catch (e) {
    return fail(e.message);
  }
  const session = built.session;

  let ranked = null;
  try {
    ranked = session.feedAll(lines);
  } catch (e) {
    return fail('the engine threw while replaying the prefix: ' + ((e && e.message) || e));
  }
  const live = (ranked || []).filter(function (e) { return e && !e.isVetoed; });
  if (!live.length) {
    notes.push('the engine ranked nothing at the decision frame (the prefix must end at a |request| line)');
    const errors = session.pipelineErrors();
    if (errors.length) notes.push('pipeline errors: ' + JSON.stringify(errors.slice(0, 4)));
    return { name: name, ok: false, checks: checks, notes: notes };
  }

  const top = live[0];
  const rankedIds = live.map(function (e) { return toId(e.name); });

  const forbidden = toId(spec.forbiddenMove);
  checks.push({
    name: 'the forbidden line' + (spec.forbiddenMove ? ' "' + spec.forbiddenMove + '"' : '') + ' is not the top line',
    ok: !forbidden || toId(top.name) !== forbidden,
    detail: 'the engine chose "' + top.name + '" (score ' + (typeof top.score === 'number' ? top.score.toFixed(1) : '?') + ')'
  });

  const valid = (spec.validTopMoves || []).map(toId).filter(Boolean);
  if (valid.length) {
    const present = valid.filter(function (id) { return rankedIds.indexOf(id) !== -1; });
    checks.push({
      name: 'a viable alternative is ranked',
      ok: present.length > 0,
      detail: 'wanted one of ' + JSON.stringify(spec.validTopMoves) + ', ranked ' +
        JSON.stringify(live.slice(0, 4).map(function (e) { return e.name; }))
    });
  } else {
    checks.push({ name: 'no alternatives recorded, so none are demanded', ok: true });
  }

  const ok = checks.every(function (c) { return c.ok; });
  if (options.verbose) notes.push('top 3: ' + JSON.stringify(live.slice(0, 3).map(function (e) { return e.name; })));
  return { name: name, ok: ok, checks: checks, notes: notes, top: top.name };
}

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

/**
 * Run a list of puzzles (the registry by default) and print a suite-style report.
 * `options.puzzles` injects a list instead of the registry — the arena suite uses that to prove a
 * violated puzzle really does fail.
 */
function runAll(options) {
  options = options || {};
  const list = options.puzzles || PUZZLES;
  console.log('\n=== tactical puzzles ===');
  if (!list.length) {
    console.log('  no puzzles registered (the harvester grows this list: ' +
      'node tools/run_arena.js --harvest)');
    return { passed: 0, failed: 0, results: [], checks: 0, checkFailures: 0 };
  }
  const results = [];
  let checks = 0;
  let checkFailures = 0;
  for (let i = 0; i < list.length; i++) {
    const running = list[i];
    const result = runPuzzle(running, options);
    results.push(result);
    console.log('\n  [' + (result.ok ? 'PASS' : 'FAIL') + '] ' + result.name);
    for (let c = 0; c < result.checks.length; c++) {
      const check = result.checks[c];
      checks++;
      if (!check.ok) checkFailures++;
      console.log('    ' + (check.ok ? 'PASS ' : 'FAIL ') + check.name +
        (check.detail ? '  ->  ' + check.detail : ''));
    }
    for (let n = 0; n < result.notes.length; n++) console.log('    note: ' + result.notes[n]);
  }
  const passed = results.filter(function (r) { return r.ok; }).length;
  const failed = results.length - passed;
  console.log('\n  ' + pad(passed + ' puzzle(s) passed,', 24) + failed + ' failed');
  console.log('  checks passed: ' + (checks - checkFailures) + '   checks failed: ' + checkFailures);
  if (failed) {
    console.log('\n  A fresh auto-vaccine fails on purpose: it pins a defect the engine still has.');
    console.log('  Fix the engine and the pinned puzzle turns green.');
  }
  return { passed: passed, failed: failed, results: results, checks: checks, checkFailures: checkFailures };
}

// ==== RUNNER (do not remove) ====

if (require.main === module) {
  if (process.argv.indexOf('--list') !== -1) {
    console.log(PUZZLES.length + ' puzzle(s) registered:');
    PUZZLES.forEach(function (p) { console.log('  ' + p.name); });
    process.exit(0);
  }
  const summary = runAll({ verbose: process.argv.indexOf('--verbose') !== -1 });
  if (summary.failed) {
    console.error('\nFAILED: ' + summary.failed + ' of ' + (summary.passed + summary.failed) + ' puzzles');
    process.exit(1);
  }
  console.log('\nALL ' + summary.passed + ' PUZZLES PASSED');
  process.exit(0);
}

module.exports = {
  testPuzzle: testPuzzle,
  PUZZLES: PUZZLES,
  runPuzzle: runPuzzle,
  runAll: runAll,
  FALLBACK_PASTE: FALLBACK_PASTE
};
