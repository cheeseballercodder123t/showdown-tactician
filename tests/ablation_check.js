/* Showdown Tactician — tests/ablation_check.js
 *
 * WHY THIS EXISTS
 *   tools/run_ablation.js is a measuring instrument, and an instrument that is subtly wrong is
 *   worse than no instrument at all: it produces a table of plausible numbers that a human then
 *   makes a decision with. Three ways it could lie, and each one is pinned here against observable
 *   behaviour rather than against the fact that a function returned something:
 *
 *     1. THE FLAG NEVER REACHED THE ENGINE. If `--set` patched the config object but the engine
 *        read its tunables from somewhere else, every variant would be a baseline-vs-baseline
 *        comparison reported as "this feature does nothing". So this suite does not stop at
 *        `configGet` — it builds a real LaplaceEngine and a real BlunderVetoGuard after the patch
 *        and asserts THEY changed, per flag.
 *     2. THE PATCH WAS A NO-OP. A feature table entry that sets a flag to the value it already
 *        holds measures nothing. Every declared patch is checked to actually flip its leaf, which
 *        is what makes a stale row (after config.js defaults change) fail loudly.
 *     3. THE COMPARISON WAS NOT PAIRED. The whole point of sharing a seed is that the two arms
 *        play the same battles; if the seeds drift, the interval is computed from the wrong test.
 *
 * Facets covered: applyConfigPatch (including the refusals), per-flag behaviour in a real engine,
 * the feature table's shape and integrity, summarizeRun/verifyPairing/bootstrap/compareToBaseline/
 * renderTable as pure functions, argument parsing, and one real end-to-end batch through the CLI.
 *
 * THE ONE THING TO KNOW ABOUT THIS SUITE
 *   The end-to-end section drives tools/run_arena.js, which needs @pkmn/sim (a devDependency). A
 *   clone that runs `npm test` without `npm install` must still verify everything else, so this
 *   suite SKIPS with a plain message and exit code 0 when the sim is missing — the same honest
 *   skip tests/arena_check.js makes.
 *
 * Run me with:  node tests/ablation_check.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

let simAvailable = true;
try {
  require.resolve('@pkmn/sim', { paths: [ROOT] });
} catch (e) {
  simAvailable = false;
}

const harness = require(path.join(ROOT, 'tests', 'harness.js'));
const arena = require(path.join(ROOT, 'tools', 'run_arena.js'));
const ablation = require(path.join(ROOT, 'tools', 'run_ablation.js'));

/* ------------------------------------------------------------------------------ check harness */

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log('PASS ' + name); return true; }
  const line = name + (detail === undefined ? '' : '  (' + detail + ')');
  failures.push(line);
  console.log('FAIL ' + line);
  return false;
}

function eq(name, got, want) {
  return check(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

function section(title) {
  console.log('\n--- ' + title);
}

/** Apply an object of dotted patches to a config, returning the inverse patch that undoes it. */
function patchAndRevert(ST, patch) {
  const applied = arena.applyConfigPatch(ST, Object.keys(patch).map(function (k) {
    return k + '=' + arena.formatConfigValue(patch[k]);
  }));
  const inverse = {};
  applied.forEach(function (a) { inverse[a.path] = a.from; });
  return inverse;
}

function revert(ST, inverse) {
  arena.applyConfigPatch(ST, Object.keys(inverse).map(function (k) {
    return k + '=' + arena.formatConfigValue(inverse[k]);
  }));
}

function throwing(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

/* ============================================== 1. the --set mechanism and its refusals */

function checkConfigPatchMechanism() {
  section('1. --set parses the four scalars, and refuses everything that is not a real tunable');

  eq('boolean false', arena.parseConfigValue('false'), false);
  eq('boolean true', arena.parseConfigValue('true'), true);
  eq('null', arena.parseConfigValue('null'), null);
  eq('integer', arena.parseConfigValue('80'), 80);
  eq('negative decimal', arena.parseConfigValue('-1.5'), -1.5);
  eq('a bare word stays a string', arena.parseConfigValue('rain'), 'rain');
  eq('a word that looks numeric-ish stays a string', arena.parseConfigValue('8x'), '8x');
  eq('format boolean', arena.formatConfigValue(false), 'false');
  eq('format number', arena.formatConfigValue(80), '80');
  eq('format string is quoted (so the round trip is unambiguous)', arena.formatConfigValue('rain'), '"rain"');

  const sandbox = harness.loadFiles(['src/config.js']);
  const ST = sandbox.ST;

  const applied = arena.applyConfigPatch(ST, ['laplace.nash.enabled=false', 'laplace.wincon.maxBounty=80']);
  eq('applyConfigPatch reports one entry per flag', applied.length, 2);
  eq('the first entry names the path, the old and the new value',
    applied[0], { path: 'laplace.nash.enabled', from: true, to: false });
  eq('the numeric flag keeps its numeric type', applied[1].to, 80);
  eq('the live config object is updated (no copy)', ST.CONFIG.laplace.nash.enabled, false);
  eq('configGet sees it through the shared path',
    ST.configGet('laplace.nash.enabled', 'MISSING'), false);

  /* The refusals are the point: a benchmark that silently accepts a misspelt flag measures nothing
   * and then reports it as "neutral". */
  const badLeaf = throwing(function () { arena.applyConfigPatch(ST, ['laplace.nash.enabledd=false']); });
  check('a misspelt leaf is refused', !!badLeaf && badLeaf.isSetup, badLeaf && badLeaf.message);
  eq('...and no key was invented for it', ST.configGet('laplace.nash.enabledd', 'MISSING'), 'MISSING');
  const badSection = throwing(function () { arena.applyConfigPatch(ST, ['laplace.nashh.enabled=false']); });
  check('a misspelt section is refused', !!badSection && badSection.isSetup, badSection && badSection.message);
  const intoValue = throwing(function () { arena.applyConfigPatch(ST, ['laplace.temperature.x=1']); });
  check('descending into a value rather than a section is refused',
    !!intoValue && intoValue.isSetup, intoValue && intoValue.message);
  const noEquals = throwing(function () { arena.applyConfigPatch(ST, ['laplace.nash.enabled']); });
  check('a --set with no = is refused', !!noEquals && noEquals.isSetup, noEquals && noEquals.message);
  const emptyPath = throwing(function () { arena.applyConfigPatch(ST, ['=false']); });
  check('an empty path is refused', !!emptyPath && emptyPath.isSetup, emptyPath && emptyPath.message);
  const missingConfig = throwing(function () { arena.applyConfigPatch({}, ['a.b=false']); });
  check('a sandbox with no config.js is refused, not assumed',
    !!missingConfig && missingConfig.isSetup, missingConfig && missingConfig.message);

  /* Applying the same patch twice must land on the same value; the ablation table's echo check
   * depends on that. */
  const first = arena.applyConfigPatch(ST, ['veto.redundantField=false']);
  const second = arena.applyConfigPatch(ST, ['veto.redundantField=false']);
  eq('a repeated patch reports the same from/to both times',
    [first[0].from, first[0].to, second[0].from, second[0].to], [true, false, false, false]);
}

/* ============================== 2. the patch reaches the ENGINE, not just the config object */

function checkConfigReachesEngine() {
  section('2. a patched flag changes what the real engine reads (this is the whole premise)');

  const s = harness.loadAll({ setInterval: function () { return 0; }, clearInterval: function () { } });
  const ST = s.ST;
  check('the harness exposes the engine and the veto guard',
    typeof ST.LaplaceEngine === 'function' && typeof ST.BlunderVetoGuard === 'function',
    'LaplaceEngine=' + typeof ST.LaplaceEngine + ' BlunderVetoGuard=' + typeof ST.BlunderVetoGuard);

  const before = new ST.LaplaceEngine({});
  eq('baseline engine: the nash solve is on', before.nash.enabled, true);
  eq('baseline engine: volatility is on', before.volatility.enabled, true);
  eq('baseline engine: quiescence is on', before.quiescence.enabled, true);

  const inverse = patchAndRevert(ST, {
    'laplace.nash.enabled': false,
    'laplace.volatility.enabled': false,
    'laplace.quiescence.enabled': false
  });

  /* A NEW engine, because a session reads its tunables at construction — that is exactly how the
   * ablation runner gets a different engine per variant out of one shared sandbox. */
  const off = new ST.LaplaceEngine({});
  eq('patched engine: the nash solve is off', off.nash.enabled, false);
  eq('patched engine: volatility is off', off.volatility.enabled, false);
  eq('patched engine: quiescence is off', off.quiescence.enabled, false);
  eq('the original engine object is unaffected (the patch is not retroactive)',
    [before.nash.enabled, before.volatility.enabled, before.quiescence.enabled], [true, true, true]);

  revert(ST, inverse);
  const restored = new ST.LaplaceEngine({});
  eq('reverting the patch restores the next engine',
    [restored.nash.enabled, restored.volatility.enabled, restored.quiescence.enabled], [true, true, true]);

  /* THE VOLATILITY ROW, PINNED AT ITS CAUSE.
   *
   * The first real ablation sweep came back with the volatility variant reproducing the baseline
   * battle for battle. That was NOT "the tier does nothing": the charge needs the move's accuracy,
   * and `_accuracyOf` reads `state.moveAccuracy`, which only src/injected.js populates from the
   * client's own `|stacc|` snapshot. @pkmn/sim emits no `|stacc|`, so every penalty in the arena
   * was 0 and the flag could not change a decision.
   *
   * The arena no longer has that hole — engine_bridge now forwards the frame from the sim's dex,
   * which is what section 7 asserts — so these three steps are pinned as the MECHANISM of the tier
   * rather than as the explanation of a flat row: an empty table still charges nothing, a populated
   * one charges exactly the lost upside, and the flag still gates it. */
  const fb = ST.util.getMoveData('Focus Blast');
  check('precondition: Focus Blast is a damaging 70% move in the dex',
    !!fb && fb.basePower > 0 && fb.isStatus === false, fb && (fb.basePower + 'bp'));
  const volEngine = new ST.LaplaceEngine({});
  const volAction = { kind: 'move', name: 'Focus Blast', moveId: 'focusblast' };
  eq('an EMPTY accuracy table (what the arena used to have): penalty zero even with the tier ON',
    volEngine._volatilityDelta(volAction, { moveAccuracy: {} }, null, 100).penalty, 0);
  eq('...and therefore toggling the flag cannot change anything', (function () {
    const inverse2 = patchAndRevert(ST, { 'laplace.volatility.enabled': false });
    const offEngine = new ST.LaplaceEngine({});
    const p = offEngine._volatilityDelta(volAction, { moveAccuracy: {} }, null, 100).penalty;
    revert(ST, inverse2);
    return p;
  })(), 0);
  const withAcc = volEngine._volatilityDelta(volAction, { moveAccuracy: { focusblast: 70 } }, null, 100);
  check('with the accuracy present the tier DOES charge a miss', withAcc.penalty < 0, String(withAcc.penalty));
  check('...and the charge is the lost upside at accuracyWeight 1 (0.3 x 100)',
    Math.abs(withAcc.penalty + 30) < 1e-9, String(withAcc.penalty));
  check('...and it explains itself for the HUD', /lands 70% of the time/.test(withAcc.why || ''), withAcc.why);
  const volOffEngine = new ST.LaplaceEngine({ volatility: { enabled: false } });
  eq('and disabled at construction it charges nothing even with the accuracy present',
    volOffEngine._volatilityDelta(volAction, { moveAccuracy: { focusblast: 70 } }, null, 100).penalty, 0);
  eq('a 100%-accuracy move is never charged',
    volEngine._volatilityDelta({ kind: 'move', name: 'Close Combat', moveId: 'closecombat' },
      { moveAccuracy: { closecombat: 100 } }, null, 100).penalty, 0);

  /* THE CLOCK ROW, PINNED AT ITS CAUSE TOO.
   *
   * The sweep came back with `clock.enabled = false` reproducing the baseline battle for battle,
   * against the author's expectation that dropping their switch replies would change something. The
   * reason is that the clock never accumulated a single sample in the arena: `_close()` returns
   * early unless `mySubmitTs` is set, and that is set only by an OUTGOING `/choose` line (kind
   * 'send'). The arena's agent returned a choice string to the sim runner, which wrote it to the
   * player stream — the boot never saw a `/choose` — so `history` stayed empty, `label()` stayed
   * 'unknown', and `switchPrior.unknown` of 1.0 is exactly what `enabled: false` does.
   *
   * run_arena now calls `session.noteOutgoing()` at the moment it decides, so the live path is the
   * second half of this block and section 7 asserts it through the bridge. The dead path is kept
   * because it is the counterfactual that proves the line is what moves the clock. */
  let clockNow = 100;
  const quietClock = new ST.OpponentClock({ now: function () { return clockNow; } });
  quietClock.note('|request|' + JSON.stringify({ rqid: 1 }), 'recv');
  clockNow += 4000;
  quietClock.note('|turn|2', 'recv');
  const quietSnap = quietClock.snapshot();
  eq('a window with no outgoing /choose records no sample (what the arena does)', quietSnap.samples, 0);
  eq('...so the label stays unknown', quietSnap.label, 'unknown');
  eq('...so the switch column is not re-weighted at all', quietSnap.switchFactor, 1);

  clockNow = 100;
  const liveClock = new ST.OpponentClock({ now: function () { return clockNow; } });
  for (let i = 0; i < 3; i++) {
    liveClock.note('|request|' + JSON.stringify({ rqid: i + 1 }), 'recv');
    clockNow += 500;
    liveClock.note('/choose move 1', 'send');
    clockNow += 3000;
    liveClock.note('|turn|' + (i + 2), 'recv');
  }
  const liveSnap = liveClock.snapshot();
  check('with our own /choose lines the clock DOES accumulate samples', liveSnap.samples >= 2, String(liveSnap.samples));
  check('...and it leaves unknown', liveSnap.label !== 'unknown', liveSnap.label);
  check('...and clock.enabled = false is what makes the arena row flat',
    new ST.OpponentClock({ enabled: false }).snapshot().switchFactor === 1, '');
  check('the clock feature carries its caveat in the table',
    /LIVE, BUT ITS INPUT IS NOW DECLARED/.test((ablation.FEATURES.filter(function (f) { return f.id === 'clock'; })[0] || {}).caveat || ''), '');

  /* The five board-state vetoes, driven through their own fixtures. Each is a real decision the
   * guard makes differently, which is what the ablation is actually measuring. */
  function boardState() {
    return {
      turn: 5,
      mySide: 'p1',
      myTeam: [],
      oppTeam: [],
      bench: { my: [], opp: [] },
      field: {
        trickRoom: false, weather: '', weatherTurnsLeft: null,
        tailwind: { p1: false, p2: false },
        screens: { p1: {}, p2: {} },
        hazards: {
          p1: { rocks: false, spikes: 0, toxicspikes: 0, stickyweb: false, steelspikes: 0 },
          p2: { rocks: false, spikes: 0, toxicspikes: 0, stickyweb: false, steelspikes: 0 }
        }
      },
      active: {
        my: { species: 'Blissey', id: 'blissey', fainted: false, boosts: {}, hp: 100, hpPercent: 100, lastMove: '', lastMoveTurn: -1 },
        opp: { species: 'Corviknight', id: 'corviknight', fainted: false, boosts: {}, hp: 100, hpPercent: 100 }
      }
    };
  }
  const guard = new ST.BlunderVetoGuard({});
  const verdict = function (action, state) { return guard.evaluateVetoes(action, state, { v4: 0.1 }); };

  /* Each case: the state that makes the rule fire, and the action that trips it. */
  const cases = [
    { flag: 'veto.wastedHazardClear', code: 'WASTED_HAZARD_CLEAR', action: { kind: 'move', name: 'Rapid Spin', moveId: 'rapidspin' }, state: boardState },
    {
      flag: 'veto.consecutiveProtect', code: 'CONSECUTIVE_PROTECT',
      action: { kind: 'move', name: 'Protect', moveId: 'protect' },
      state: function () { const s2 = boardState(); s2.active.my.lastMove = 'Protect'; s2.active.my.lastMoveTurn = 4; return s2; }
    },
    {
      flag: 'veto.magicBounceRedirect', code: 'MAGIC_BOUNCE_REDIRECT',
      action: { kind: 'move', name: 'Spikes', moveId: 'spikes' },
      state: function () { const s2 = boardState(); s2.active.opp.possibleAbilities = ['Mirror Armor', 'Magic Bounce']; return s2; }
    },
    {
      flag: 'veto.saturatedHazard', code: 'SATURATED_HAZARD',
      action: { kind: 'move', name: 'Spikes', moveId: 'spikes' },
      state: function () { const s2 = boardState(); s2.field.hazards.p2.spikes = 3; return s2; }
    },
    {
      flag: 'veto.redundantField', code: 'REDUNDANT_FIELD',
      action: { kind: 'move', name: 'Rain Dance', moveId: 'raindance' },
      state: function () { const s2 = boardState(); s2.field.weather = 'rain'; s2.field.weatherTurnsLeft = 4; return s2; }
    }
  ];

  cases.forEach(function (c) {
    const on = verdict(c.action, c.state());
    check(c.flag + ': the rule fires with the flag on', on.isVetoed && on.code === c.code,
      'isVetoed=' + on.isVetoed + ' code=' + on.code);
    const inv = patchAndRevert(ST, { });
    arena.applyConfigPatch(ST, [c.flag + '=false']);
    const off2 = verdict(c.action, c.state());
    check(c.flag + '=false: the same action is allowed', off2.isVetoed === false, JSON.stringify(off2));
    arena.applyConfigPatch(ST, [c.flag + '=true']);
    const back = verdict(c.action, c.state());
    check(c.flag + '=true again: the rule fires', back.isVetoed && back.code === c.code,
      'isVetoed=' + back.isVetoed + ' code=' + back.code);
  });
}

/* ================== 2b. a LOAD-TIME flag reaches the engine too (the pruner family) */

function checkLoadTimePatchReachesEngine() {
  section('2b. --set reaches the LOAD-TIME readers, not only the construction-time ones');

  const bridge = require(path.join(ROOT, 'tools', 'headless_arena', 'engine_bridge.js'));

  /* A body that switched in on the current turn with nothing revealed is exactly the window the
   * absence rule reads. Built through the real parser and state manager, so the fixture is the
   * protocol's, not ours. */
  function absenceSurvivors(ST) {
    const state = new ST.BattleStateManager();
    const parser = new ST.ProtocolParser();
    state.attachParser(parser);
    state.setFormat('[Gen 9] National Dex OU');
    parser.feedAll([
      '|init|[Gen 9] National Dex', '|player|p1|Me|1|1500', '|player|p2|Foe|2|1480',
      '|teamsize|p1|6', '|teamsize|p2|6', '|start',
      '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
      '|switch|p2a: Probe|Probe, L50, M|100/100',
      '|turn|1'
    ].join('\n'));
    const st = state.state;
    const mon = st.oppTeam[0];
    mon.candidateSets = [
      { id: 'inti', species: 'Probe', ability: 'Intimidate', item: 'Leftovers', moves: ['Surf'], weight: 1 },
      { id: 'other', species: 'Probe', ability: 'Static', item: 'Leftovers', moves: ['Surf'], weight: 1 }
    ];
    const pruner = new ST.ArchetypePruner();
    return pruner.prune(mon, st).map(function (s) { return s.id; });
  }

  const cold = bridge.loadHarness({ fresh: true });
  eq('unpatched, the absence rule eliminates nothing (it ships off)',
    absenceSurvivors(cold.ST), ['inti', 'other']);

  const loaded = bridge.loadHarness({
    fresh: true,
    setArgs: ['pruner.abilityDeduction.absenceRules=true'],
    applyPatch: arena.applyConfigPatch
  });
  eq('the load-time patch is echoed so a caller can prove it landed',
    loaded.appliedSets && loaded.appliedSets.map(function (a) { return a.path; }),
    ['pruner.abilityDeduction.absenceRules']);
  eq('configGet sees the patched leaf', loaded.ST.configGet('pruner.abilityDeduction.absenceRules', null), true);
  /* THE POINT OF THIS SECTION. src/set_pruner.js captures `pruner.*` into module constants WHILE
   * IT IS EVALUATED. The same patch applied only after loadAll() returns updates the config OBJECT
   * and leaves the rule asleep, so the ablation row would read flat and be reported as "no
   * measurable effect" — a false negative for a tier that never got to fire. loadHarness applies
   * --set from inside the load, the moment src/config.js has run, so the rule must actually fire. */
  eq('...and the pruner obeys it live (a silent switch-in strikes Intimidate)',
    absenceSurvivors(loaded.ST), ['other']);

  /* The BRIDGE's cache, which is the other route to the same false negative. A caller that NAMES a
   * patch must never be served a sandbox built with a different one (its batch would silently be
   * the wrong config); a fresh UNPATCHED build while a patch is live would replace the cache and
   * un-patch every later session, so it is refused loudly instead. */
  const repatched = bridge.loadHarness({
    setArgs: ['laplace.urgency.enabled=false'],
    applyPatch: arena.applyConfigPatch
  });
  eq('naming a different patch rebuilds instead of serving the stale cache',
    repatched.ST.configGet('laplace.urgency.enabled', null), false);
  eq('...and that build echoes its own patch', repatched.appliedSets.length, 1);
  const stale = throwing(function () { bridge.loadHarness({ fresh: true }); });
  check('a fresh UNPATCHED load while a patch is live is refused, not silently un-patching',
    !!stale && /refusing a fresh load/.test(stale.message), stale && stale.message);
  const noApply = throwing(function () {
    bridge.loadHarness({ fresh: true, setArgs: ['laplace.urgency.enabled=true'] });
  });
  check('setArgs without an applyPatch is refused rather than measured as the shipped config',
    !!noApply && /without an applyPatch/.test(noApply.message), noApply && noApply.message);

  /* And the counter-case, because proving the two ORDERINGS differ is what makes this a test of
   * the mechanism rather than of a default. */
  const late = harness.loadAll({ setInterval: function () { return 0; }, clearInterval: function () { } });
  arena.applyConfigPatch(late.ST, ['pruner.abilityDeduction.absenceRules=true']);
  eq('a patch applied AFTER loadAll updates the config object',
    late.ST.configGet('pruner.abilityDeduction.absenceRules', null), true);
  eq('...but cannot reach the load-time rule — which is why the arena patches mid-load',
    absenceSurvivors(late.ST), ['inti', 'other']);
}

/* ============================================================ 3. the feature table itself */

function checkFeatureTable() {
  section('3. the feature table: every path real, every patch a real flip, no duplicates');

  const variants = ablation.buildVariants(ablation.FEATURE_IDS);
  eq('one baseline plus one variant per feature', variants.length, ablation.FEATURES.length + 1);
  eq('the baseline is first', variants[0].id, 'baseline');
  eq('the baseline patches nothing', variants[0].setArgs, []);
  eq('the ids are unique', new Set(ablation.FEATURE_IDS).size, ablation.FEATURE_IDS.length);
  check('the baseline is not also a feature id', ablation.FEATURE_IDS.indexOf('baseline') === -1, '');
  check('every feature carries a note explaining what is toggled',
    ablation.FEATURES.every(function (f) { return typeof f.note === 'string' && f.note.length > 20; }),
    ablation.FEATURES.filter(function (f) { return !f.note; }).map(function (f) { return f.id; }).join(','));
  check('every feature declares an expectation to be surprised by',
    ablation.FEATURES.every(function (f) { return ['helps', 'neutral', 'hurts'].indexOf(f.expect) !== -1; }),
    '');

  eq('a selection builds only those variants and keeps the baseline',
    ablation.buildVariants(['nash', 'quiescence']).map(function (v) { return v.id; }),
    ['baseline', 'nash', 'quiescence']);

  /* Every declared path must exist in config.js (validateFeaturePaths throws otherwise) AND must
   * actually change the value it names. */
  const report = ablation.validateFeaturePaths(variants);
  eq('every patched variant was validated', report.length, ablation.FEATURES.length);
  const noops = [];
  report.forEach(function (r) {
    r.applied.forEach(function (a) {
      if (a.from === a.to) noops.push(r.id + ':' + a.path + '=' + arena.formatConfigValue(a.to));
    });
  });
  eq('no feature patch is a no-op (a patch that changes nothing would measure nothing)', noops, []);

  const nonBoolean = [];
  report.forEach(function (r) {
    r.applied.forEach(function (a) { if (typeof a.to !== 'boolean') nonBoolean.push(r.id + ':' + a.path); });
  });
  /* The only non-boolean leaves in the table are the two bounty caps, which are numbers because a
   * tier that ships with a 0 bounty has nothing to measure. Anything else appearing here would mean
   * a "flag" is really a numeric parameter set, and that should be a deliberate change. */
  eq('the only non-boolean leaves are the two documented bounty caps', nonBoolean.sort(), [
    'scouting:laplace.scouting.maxBounty',
    'wincon:laplace.wincon.maxBounty'
  ]);
  /* The inert tiers must ship inert, or the table's premise ("it is off until measured") is false. */
  const sandbox = harness.loadFiles(['src/config.js']);
  eq('wincon really does ship inert', sandbox.ST.configGet('laplace.wincon.enabled', null), false);
  eq('scouting really does ship inert', sandbox.ST.configGet('laplace.scouting.enabled', null), false);
  eq('endgame really does ship inert', sandbox.ST.configGet('laplace.endgame.enabled', null), false);
  eq('profile really does ship inert', sandbox.ST.configGet('laplace.profile.enabled', null), false);
  eq('and the wincon bounty floor really is 0', sandbox.ST.configGet('laplace.wincon.maxBounty', null), 0);

  eq('patchToSetArgs formats the way the arena parses',
    ablation.patchToSetArgs({ 'a.b': false, 'c.d': 80 }), ['a.b=false', 'c.d=80']);
  const args = ablation.arenaArgs(variants[1], { battles: 500, agent: 'all', seed: 1337, maxTurns: 100 }, '/tmp/x.json');
  check('the batch is a full battle, never a spliced one',
    args.join(' ') === ['--battles', '500', '--agent', 'all', '--mode', 'full', '--seed', '1337',
      '--max-turns', '100', '--json', '/tmp/x.json', '--quiet',
      '--set', 'laplace.nash.enabled=false'].join(' '), args.join(' '));
}

/* ================================================== 4. argument parsing and selection */

function checkArgs() {
  section('4. arguments: the defaults the brief asks for, and a refusal for everything else');

  const opts = ablation.parseArgs([]);
  eq('500 battles per variant by default', opts.battles, ablation.DEFAULT_BATTLES);
  eq('...which is 500', ablation.DEFAULT_BATTLES, 500);
  eq('all features by default', opts.features, 'all');
  eq('the arena seed by default', opts.seed, 1337);
  eq('single-threaded by default', opts.parallel, 1);

  const custom = ablation.parseArgs(['--battles', '12', '--features', 'nash,clock', '--parallel', '3',
    '--seed', '5', '--max-turns', '40', '--agent', 'chaos', '--out', 'r.json', '--quiet']);
  eq('a full flag set parses', [custom.battles, custom.features, custom.parallel, custom.seed,
    custom.maxTurns, custom.agent, custom.out, custom.quiet], [12, 'nash,clock', 3, 5, 40, 'chaos', 'r.json', true]);

  ['--battles 0', '--battles 2.5', '--battles x', '--parallel 0', '--max-turns 0', '--seed x',
    '--agent nobody', '--nope', '--battles'].forEach(function (spec) {
    const parts = spec.split(' ');
    const err = throwing(function () { ablation.parseArgs(parts); });
    check('refused: ' + spec, !!err && err.isSetup, err && err.message);
  });

  eq('--features all resolves to the whole table',
    ablation.resolveFeatureIds('all'), ablation.FEATURE_IDS);
  eq('a comma list resolves in the order given (not table order)',
    ablation.resolveFeatureIds('clock,nash'), ['clock', 'nash']);
  const unknown = throwing(function () { ablation.resolveFeatureIds('nash,nope'); });
  check('an unknown feature id is refused rather than skipped',
    !!unknown && unknown.isSetup && /nope/.test(unknown.message), unknown && unknown.message);
  const empty = throwing(function () { ablation.resolveFeatureIds(' , '); });
  check('an empty --features is refused', !!empty && empty.isSetup, empty && empty.message);
}

/* ================================================================ 5. the aggregation maths */

/** Build a run summary straight from a list of (winner|tie, turns) pairs. */
function mkSummary(pairs, maxTurns) {
  const records = pairs.map(function (p, i) {
    return {
      index: i, persona: ['anchor', 'exploiter', 'chaos'][i % 3], seed: [7, i + 1, 3, 9],
      winner: p[0], turnCount: p[1], aborted: !!p[2], timedOut: false, error: null
    };
  });
  return ablation.summarizeRun({ records: records, options: { maxTurns: maxTurns || 100 } });
}

function checkAggregation() {
  section('5. aggregation: win/loss/tie, stalls kept apart from draws, and the paired test');

  const s = mkSummary([['p1', 10], ['p2', 20], ['tie', 100, true], ['tie', 30]]);
  eq('every battle is counted', s.battles, 4);
  eq('wins', s.wins, 1);
  eq('losses', s.losses, 1);
  eq('ties', s.ties, 2);
  eq('win rate', s.winRate, 0.25);
  eq('loss rate', s.lossRate, 0.25);
  eq('tie rate', s.tieRate, 0.5);
  eq('average turns', s.avgTurns, 40);
  eq('the score scale is win 1 / tie 0.5 / loss 0', s.meanScore, 0.5);
  eq('a tie that hit the turn cap is a STALL tie', s.stallTies, 1);
  eq('...and an ordinary draw is not', s.stallTieShare, 0.25);
  eq('the per-battle series is kept for the paired test', s.scores, [1, 0, 0.5, 0.5]);

  const byAbort = mkSummary([['tie', 30, true]]);
  eq('a tie flagged aborted is a stall even well below the turn cap', byAbort.stallTies, 1);
  const byCap = mkSummary([['tie', 100]], 100);
  eq('a tie that reached the cap is a stall even without the flag', byCap.stallTies, 1);

  eq('a malformed/empty report summarizes to zeroes rather than throwing',
    ablation.summarizeRun({}).battles, 0);

  section('5b. pairing: the seeds have to line up for the interval to mean anything');
  const a = mkSummary([['p1', 10], ['p2', 20]]);
  const b = mkSummary([['p1', 11], ['p1', 21]]);
  eq('same seeds are paired', ablation.verifyPairing(a, b).paired, true);
  const drifted = JSON.parse(JSON.stringify(b));
  drifted.perBattle[1].seed = 'different';
  const drift = ablation.verifyPairing(a, drifted);
  eq('a drifted seed is detected', drift.paired, false);
  check('...and the reason names the drift', /different seed/.test(drift.reason), drift.reason);
  eq('a different battle count is not pairable', ablation.verifyPairing(a, mkSummary([['p1', 1]])).paired, false);

  section('5c. the paired bootstrap, and the boundary cases that decide a verdict');
  eq('percentile interpolates', [ablation.percentile([1, 2, 3, 4], 50), ablation.percentile([1, 2, 3, 4], 0)],
    [2.5, 1]);

  const flatBase = mkSummary([['p2', 10], ['p2', 10], ['tie', 10], ['p1', 10]]);
  const flatSame = mkSummary([['p2', 10], ['p2', 10], ['tie', 10], ['p1', 10]]);
  const flatCi = ablation.pairedBootstrap(flatBase.scores, flatSame.scores, 200, 1);
  eq('an identical arm has an interval of exactly zero', [flatCi.low, flatCi.high], [0, 0]);

  const allLoss = mkSummary([['p2', 10], ['p2', 10], ['p2', 10], ['p2', 10]]);
  const allWin = mkSummary([['p1', 10], ['p1', 10], ['p1', 10], ['p1', 10]]);
  const upCi = ablation.pairedBootstrap(allLoss.scores, allWin.scores, 200, 1);
  eq('a unanimous swing puts the interval entirely above zero', [upCi.low, upCi.high], [1, 1]);
  eq('...and every resample is ahead', upCi.aheadShare, 1);
  const downCi = ablation.pairedBootstrap(allWin.scores, allLoss.scores, 200, 1);
  eq('...and mirrored, entirely below zero', [downCi.low, downCi.high], [-1, -1]);
  eq('the bootstrap is deterministic under its own seed',
    ablation.pairedBootstrap(allLoss.scores, allWin.scores, 200, 1).median,
    ablation.pairedBootstrap(allLoss.scores, allWin.scores, 200, 1).median);
  check('the unpaired fallback also reports an interval',
    typeof ablation.unpairedBootstrap(allLoss.scores, allWin.scores, 100, 1).low === 'number', '');

  section('5d. compareToBaseline: significance, not sign');
  /* THE VERDICT IS ABOUT THE FEATURE, AND THE SIGN DEPENDS ON WHICH WAY THE PATCH POINTS.
   * 'off' means the variant switched the feature OFF, so a variant that wins more means the
   * FEATURE hurts. Getting this backwards is a sign flip, which is the single most damaging
   * mistake a table like this can make. */
  const offHelpsVariant = ablation.compareToBaseline(allLoss, allWin,
    { id: 'off-x', label: 'off-x', tier: 't', direction: 'off', setArgs: ['a.b=false'] }, { bootstrap: 200 });
  eq('switching it OFF and winning more means the FEATURE hurts', offHelpsVariant.featureVerdict, 'hurts');
  check('...and the verdict text says which way the patch pointed',
    /feature HURTS/.test(offHelpsVariant.verdict) && /switching it off/.test(offHelpsVariant.verdict),
    offHelpsVariant.verdict);
  eq('...and the raw delta is still variant-minus-baseline', offHelpsVariant.deltaWin, 1);
  eq('...and the patch is reproduced for the report', offHelpsVariant.patch, ['a.b=false']);

  const offHurtsVariant = ablation.compareToBaseline(allWin, allLoss,
    { id: 'off-y', label: 'off-y', tier: 't', direction: 'off', setArgs: ['a.b=false'] }, { bootstrap: 200 });
  eq('switching it OFF and losing more means the FEATURE helps', offHurtsVariant.featureVerdict, 'helps');
  check('...and the text is not the variant-direction one', /feature HELPS/.test(offHurtsVariant.verdict),
    offHurtsVariant.verdict);

  const onHelpsVariant = ablation.compareToBaseline(allLoss, allWin,
    { id: 'on-x', label: 'on-x', tier: 't', direction: 'on', setArgs: ['a.b=true'] }, { bootstrap: 200 });
  eq('switching an inert tier ON and winning more means the FEATURE helps', onHelpsVariant.featureVerdict, 'helps');
  check('...and the text names the right direction', /switching it on/.test(onHelpsVariant.verdict),
    onHelpsVariant.verdict);

  eq('a surprise is flagged when the measurement contradicts the expectation',
    ablation.compareToBaseline(allLoss, allWin,
      { id: 's', label: 's', tier: 't', direction: 'on', expect: 'hurts', setArgs: ['a.b=true'] },
      { bootstrap: 200 }).flags, ['surprise']);
  eq('...and a confirmed expectation is not',
    ablation.compareToBaseline(allLoss, allWin,
      { id: 's2', label: 's2', tier: 't', direction: 'on', expect: 'helps', setArgs: ['a.b=true'] },
      { bootstrap: 200 }).flags, []);
  const winRow = offHelpsVariant;
  const lossRow = offHurtsVariant;

  const sameRow = ablation.compareToBaseline(flatBase, flatSame,
    { id: 'z', label: 'z', tier: 't', direction: 'off', setArgs: [] }, { bootstrap: 200 });
  eq('a zero delta is NOT reported as an improvement or a regression', sameRow.verdict,
    'no measurable effect at this sample size');
  check('...and the wording names the sample size rather than claiming neutrality',
    /no measurable effect at this sample size/.test(sameRow.verdict) &&
    !/\bhelps\b|\bhurts\b|neutral/.test(sameRow.verdict), sameRow.verdict);
  eq('a flat row has no feature verdict either', sameRow.featureVerdict, 'no measurable effect');

  section('5e-2. the interval and the delta are the SAME quantity (the scale bug)');
  /* The first real sweep printed a +15.0 delta with a 95% interval of [+1.7, +12.5]: the point
   * estimate was outside its own interval, because the delta was a WIN-RATE difference while the
   * bootstrap resampled the win/tie/loss SCORE. Two arms make the two scales differ by design. */
  const scaleBase = mkSummary([['p1', 10], ['p2', 10]]);            // win 1/2
  const scaleVar = mkSummary([['tie', 10], ['tie', 10]]);           // 0 wins, 2 ties
  eq('the base win indicator', scaleBase.winScores, [1, 0]);
  eq('the base score keeps the half point', scaleBase.scores, [1, 0]);
  eq('the variant win indicator', scaleVar.winScores, [0, 0]);
  eq('the variant score keeps the half point', scaleVar.scores, [0.5, 0.5]);
  eq('on the WIN scale, losing a win to a tie is -50 points',
    ablation.pairedBootstrap(scaleBase.winScores, scaleVar.winScores, 50, 1).median, -0.5);
  eq('...while on the SCORE scale it is a wash — which is the bug this pins',
    ablation.pairedBootstrap(scaleBase.scores, scaleVar.scores, 50, 1).median, 0);
  const scaleRow = ablation.compareToBaseline(scaleBase, scaleVar,
    { id: 'scale', label: 'scale', tier: 't', direction: 'off', setArgs: ['a.b=false'] }, { bootstrap: 50 });
  eq('the reported delta uses the win scale too', scaleRow.deltaWin, -0.5);
  /* The two scales must give DIFFERENT intervals for the same two arms. Win scale: every resample
   * is a loss of wins, so the interval sits at or below zero. Score scale: a tie is half a win, and
   * losing a win to a tie is exactly a wash, so its interval collapses onto zero. */
  check('...and its interval is on the win scale, at or below zero',
    scaleRow.ci.low < 0 && scaleRow.ci.high <= 0,
    'ci=[' + scaleRow.ci.low + ', ' + scaleRow.ci.high + ']');
  const scoreCi = ablation.pairedBootstrap(scaleBase.scores, scaleVar.scores, 50, 1);
  check('...where the SAME arms on the score scale straddle zero instead',
    scoreCi.low < 0 && scoreCi.high > 0, 'ci=[' + scoreCi.low + ', ' + scoreCi.high + ']');
  eq('...and the mean-score delta is carried separately', scaleRow.deltaScore, 0);
  eq('...so the two scales disagree about whether anything happened (only one may be printed)',
    [scoreCi.median, scaleRow.ci.median], [0, -0.5]);
  const inside = ablation.compareToBaseline(mkSummary([['p1', 10], ['p1', 10], ['p2', 10], ['p2', 10]]),
    mkSummary([['p1', 10], ['p1', 10], ['p1', 10], ['p2', 10]]),
    { id: 'in', label: 'in', tier: 't', direction: 'off', setArgs: [] }, { bootstrap: 500 });
  check('the point estimate sits inside its own interval',
    inside.ci.low <= inside.deltaWin + 1e-12 && inside.deltaWin <= inside.ci.high + 1e-12,
    'delta=' + inside.deltaWin + ' ci=[' + inside.ci.low + ', ' + inside.ci.high + ']');

  const longer = mkSummary([['p2', 20], ['p2', 20], ['tie', 20], ['p1', 20]]);
  const longerRow = ablation.compareToBaseline(flatBase, longer, { id: 'l', label: 'l', tier: 't', setArgs: [] }, { bootstrap: 100 });
  check('a longer game trips the stall flag even with a flat win rate',
    longerRow.flags.indexOf('stall') !== -1, JSON.stringify(longerRow.flags));
  const shorter = mkSummary([['p2', 2], ['p2', 2], ['tie', 2], ['p1', 2]]);
  const shorterRow = ablation.compareToBaseline(flatBase, shorter, { id: 's', label: 's', tier: 't', setArgs: [] }, { bootstrap: 100 });
  eq('a shorter game is not a stall (it is a different finding, shown in the turn delta)',
    shorterRow.flags, []);
  eq('...and the turn delta is negative', shorterRow.deltaTurns, -8);
  eq('the stall threshold is the documented one', ablation.STALL_TURN_DELTA, 8);

  section('5g. the identical flag: a flat row is not evidence about the feature');
  const pairA = mkSummary([['p1', 10], ['p2', 20], ['tie', 30], ['p1', 40]]);
  const pairB = mkSummary([['p1', 10], ['p2', 20], ['tie', 30], ['p1', 40]]);
  const pairC = mkSummary([['p1', 10], ['p2', 20], ['tie', 30], ['p1', 41]]);
  eq('the same outcome in every battle is identical', ablation.pairAllIdentical(pairA.perBattle, pairB.perBattle), true);
  eq('one turn different is not', ablation.pairAllIdentical(pairA.perBattle, pairC.perBattle), false);
  eq('a different winner in one battle is not',
    ablation.pairAllIdentical(pairA.perBattle, mkSummary([['p1', 10], ['p2', 20], ['tie', 30], ['p2', 40]]).perBattle), false);
  eq('a length mismatch is never identical', ablation.pairAllIdentical(pairA.perBattle, []), false);
  const identRow = ablation.compareToBaseline(pairA, pairB, { id: 'iv', label: 'iv', tier: 't', setArgs: ['a.b=false'] }, { bootstrap: 100 });
  check('a variant that reproduces the baseline everywhere is flagged',
    identRow.flags.indexOf('identical') !== -1, JSON.stringify(identRow.flags));
  const notIdentRow = ablation.compareToBaseline(pairA, pairC, { id: 'nv', label: 'nv', tier: 't', setArgs: ['a.b=false'] }, { bootstrap: 100 });
  eq('...and one that differs anywhere is not', notIdentRow.flags.indexOf('identical'), -1);
  const noPatchRow = ablation.compareToBaseline(pairA, pairB, { id: 'np', label: 'np', tier: 't', setArgs: [] }, { bootstrap: 100 });
  eq('a variant with no patch is never flagged (it IS the baseline)',
    noPatchRow.flags.indexOf('identical'), -1);

  section('5h. footnotes: a caveat is printed, and an all-identical row is called out');
  let fnotes = '';
  ablation.renderFootnotes([
    Object.assign({}, identRow, { caveat: 'UNPRICEABLE IN THIS HARNESS: no |stacc| from the sim.' }),
    Object.assign({}, winRow, { caveat: null })
  ], function (text) { fnotes += text + '\n'; });
  /* The footnote block is word-WRAPPED, so a phrase assertion has to run against a single-line copy
   * of it: matching the raw text fails whenever the wrap happens to land inside the phrase. */
  const flat = fnotes.replace(/\s+/g, ' ');
  check('the caveat is printed', /UNPRICEABLE IN THIS HARNESS/.test(flat), flat);
  check('the identical row is called out by name',
    /CHECK THE INPUT BEFORE READING THIS AS A RESULT: iv/.test(flat), flat);
  /* The footnote must NOT assert a cause. One of the flat rows in the real sweep has a knob that is
   * proven to work, so "the input never arrived" is only one of two possibilities. */
  check('...and it offers BOTH possibilities rather than diagnosing one',
    /never arrived in these battles/.test(flat) && /arrived and never changed a ranking/.test(flat), flat);
  check('...and it explicitly refuses to call a flat row worthless',
    /unresolved rather than as evidence the feature is worthless/.test(flat), flat);
  const blockFeature = ablation.FEATURES.filter(function (f) { return f.id === 'quiescence-blockprotect'; })[0] || {};
  check('the protect-block row says it is inert-here, not dead code',
    /INERT IN THIS CORPUS, NOT DEAD CODE/.test(blockFeature.caveat || ''), blockFeature.caveat);
  let noNotes = '';
  const returned = ablation.renderFootnotes([Object.assign({}, winRow, { caveat: null })],
    function (text) { noNotes += text + '\n'; });
  eq('a run with nothing to say prints nothing', [noNotes, returned], ['', []]);
  check('the volatility feature carries its caveat in the table itself',
    /ARRIVED AND NOT DECISIVE HERE/.test((ablation.FEATURES.filter(function (f) { return f.id === 'volatility'; })[0] || {}).caveat || ''), '');

  const errRow = ablation.compareToBaseline(flatBase, mkSummary([['p1', 10]]),
    { id: 'e', label: 'e', tier: 't', setArgs: [] }, { bootstrap: 50 });
  check('an unpaired comparison is flagged as such', errRow.flags.indexOf('unpaired') !== -1, JSON.stringify(errRow.flags));

  section('5e. renderTable prints the required columns, and survives a failed row');
  let out = '';
  ablation.renderTable([
    Object.assign({}, winRow, { id: 'baseline', label: 'baseline', verdict: 'reference', flags: [], ci: null, deltaWin: 0, deltaTurns: 0 }),
    winRow,
    { id: 'f', label: 'failed one', tier: 't', patch: [], wins: 0, losses: 0, ties: 0, winRate: 0, lossRate: 0, tieRate: 0, avgTurns: 0, stallTies: 0, stallTieShare: 0, errors: 0, deltaWin: 0, deltaTurns: 0, ci: null, pairing: { paired: false, reason: 'batch failed' }, verdict: 'not measured', flags: ['failed'], failure: 'boom' }
  ], function (text) { out += text + '\n'; });
  ['variant', 'win%', 'loss%', 'tie%', '\u0394win', '95% CI', 'turns', '\u0394turns', 'stall%', 'verdict']
    .forEach(function (col) {
      check('the table has a ' + col + ' column', out.indexOf(col) !== -1, out.split('\n')[0]);
    });
  check('the baseline row is labelled as the reference', out.indexOf('(reference)') !== -1, '');
  check('a failed batch is printed as not measured, not as a zero-delta win',
    /failed one[\s\S]*not measured/.test(out), out);
  let list = '';
  ablation.renderFeatureList(function (text) { list += text + '\n'; });
  check('--list prints every feature id',
    ablation.FEATURE_IDS.every(function (id) { return list.indexOf(id) !== -1; }), '');

  section('5f. the verdict buckets, which are how "which features help" is actually answered');
  /* Buckets are keyed on the FEATURE's verdict, not the variant's: a row tested by switching a
   * feature off lands in `hurts` when the off-variant won, which is what winRow is. */
  const groups = ablation.summarizeVerdicts([
    Object.assign({}, winRow, { id: 'baseline', verdict: 'reference', flags: [] }),
    Object.assign({}, winRow, { id: 'bad' }),
    Object.assign({}, lossRow, { id: 'good' }),
    Object.assign({}, sameRow, { id: 'flat' }),
    Object.assign({}, sameRow, { id: 'slow', flags: ['stall'] }),
    Object.assign({}, sameRow, { id: 'broke', flags: ['failed'] }),
    Object.assign({}, lossRow, { id: 'shock', flags: ['surprise'] })
  ]);
  eq('the feature-helps bucket', groups.helps, ['good', 'shock']);
  eq('the feature-hurts bucket (the off-variant won, so the feature is the problem)', groups.hurts, ['bad']);
  eq('the no-effect bucket', groups.noEffect, ['flat', 'slow']);
  eq('the stall bucket is separate, and a stalled feature is in BOTH lists', groups.stall, ['slow']);
  eq('the surprise bucket is its own list as well', groups.surprise, ['shock']);
  eq('a failed batch is bucketed as not measured rather than as a no-effect result',
    groups.notMeasured, ['broke']);
  eq('the baseline is never in a bucket', groups.helps.indexOf('baseline'), -1);
  let vout = '';
  ablation.renderVerdicts(groups, function (text) { vout += text + '\n'; });
  check('the verdict block names each bucket',
    ['feature HELPS', 'feature HURTS', 'no measurable effect', 'stalls'].every(function (k) {
      return vout.indexOf(k) !== -1;
    }), vout);
  check('...and says that a verdict is about the feature, not the variant',
    /verdict is about the FEATURE/.test(vout), vout);
  check('...and calls out a surprise', /SURPRISED THE AUTHOR/.test(vout), vout);
  let clean = '';
  ablation.renderVerdicts(ablation.summarizeVerdicts([{ id: 'baseline', verdict: 'reference', flags: [] }]),
    function (text) { clean += text + '\n'; });
  check('an empty bucket prints (none) rather than a blank', (clean.match(/\(none\)/g) || []).length >= 3, clean);

  section('5i. the absolute stall level, which the delta flags cannot report');
  /* A stall flag is relative to the baseline, so a corpus where the BASELINE draws at the turn cap
   * reports "no stalls" on every row. The first sweep read that way — 17 of 60 baseline battles
   * ended tied at the cap and every tie it played was a cap tie — so the level gets its own line. */
  const stalling = mkSummary([['p1', 20], ['tie', 100, true], ['tie', 100, true], ['p2', 20]], 100);
  const quiet2 = mkSummary([['p1', 20], ['tie', 30], ['tie', 30], ['p2', 20]], 100);
  let note = '';
  const lines = ablation.renderStallNote([
    { id: 'baseline', battles: stalling.battles, ties: stalling.ties, stallTies: stalling.stallTies, stallTieShare: stalling.stallTieShare },
    Object.assign({}, winRow)
  ], function (text) { note += text + '\n'; });
  check('a stalling baseline is called out (the delta flags cannot say this)',
    note.indexOf('BASELINE ALREADY DRAWS AT THE CAP') !== -1, note);
  check('...with the count and share', /2 of 4 baseline battles \(50\.0%\)/.test(note), note);
  check('...and naming that every tie was a cap tie', /EVERY tie/.test(note), note);
  check('...and warning against reading a missing flag as "no stalling"',
    /reading "no stall flag" as "no stalling" is wrong/.test(note), note);
  eq('...and returning the lines so the JSON can carry them', Array.isArray(lines) && lines.length >= 3, true);
  let none = '';
  const quietLines = ablation.renderStallNote([
    { id: 'baseline', battles: quiet2.battles, ties: quiet2.ties, stallTies: quiet2.stallTies, stallTieShare: quiet2.stallTieShare }
  ], function (text) { none += text + '\n'; });
  eq('a baseline that does not stall prints nothing', [none, quietLines], ['', []]);
  eq('...and a run with no baseline row is silent rather than throwing',
    ablation.renderStallNote([], function () { }), []);
  /* The flag stays relative: a variant that stalls exactly as much as the baseline is NOT flagged,
   * because the flag answers "did this make it worse", and the level line answers "is it bad". */
  const noWorse = ablation.compareToBaseline(quiet2, quiet2,
    { id: 'noworse', label: 'noworse', tier: 't', direction: 'off', setArgs: ['a.b=false'] }, { bootstrap: 100 });
  eq('a variant stalling exactly as much as the baseline is not stall-flagged',
    noWorse.flags.indexOf('stall'), -1);

  section('5j. the turn SHAPE and the attrition of a capped game');
  /* The mean alone hid the problem: a 54-turn average with a quarter of the games capped looks
   * healthy and is not. The shape plus the faints figure is what separates a standoff from a grind. */
  const shaped = mkSummary([['p1', 10], ['p2', 20], ['tie', 100, true], ['p1', 100]]);
  eq('the turn percentiles are computed', [shaped.turnP50, shaped.turnMax], [60, 100]);
  eq('...and p90 reports the tail the mean hides', shaped.turnP90, 100);
  eq('...and the capped count is kept', shaped.cappedGames, 2);
  eq('...and a battle that reached the cap is capped even if it was WON', shaped.perBattle[3].capped, true);

  const withFaints = ablation.summarizeRun({
    options: { maxTurns: 100 },
    records: [
      { index: 0, persona: 'anchor', seed: [1, 1], winner: 'tie', turnCount: 100, aborted: true, faints: 2 },
      { index: 1, persona: 'anchor', seed: [2, 2], winner: 'tie', turnCount: 100, aborted: true, faints: 8 },
      { index: 2, persona: 'anchor', seed: [3, 3], winner: 'p1', turnCount: 20, faints: 6 }
    ]
  });
  eq('faints are read from the arena record', withFaints.perBattle.map(function (b) { return b.faints; }), [2, 8, 6]);
  eq('...and averaged over ALL games', withFaints.meanFaints, 16 / 3);
  eq('...and averaged over the capped ones separately', withFaints.meanFaintsAtCap, 5);

  let shape = '';
  const shapeLines = ablation.renderTurnShape([
    Object.assign({}, shaped, { id: 'baseline', label: 'baseline', flags: [], cappedGames: 2, meanFaintsAtCap: 3,
      turnP50: 60, turnP90: 100, turnMax: 100 }),
    Object.assign({}, shaped, { id: 'grindy', label: 'grindy', flags: [], cappedGames: 2, meanFaintsAtCap: 9,
      turnP50: 60, turnP90: 100, turnMax: 100 }),
    Object.assign({}, shaped, { id: 'flat', label: 'flat', flags: ['identical'], cappedGames: 2, meanFaintsAtCap: 3,
      turnP50: 60, turnP90: 100, turnMax: 100 })
  ], function (text) { shape += text + '\n'; });
  check('the shape block names what it prints', /p50 \/ p90 \/ max/.test(shape), shape);
  check('...and reports the capped count against the battles actually played', /capped 2\/4/.test(shape), shape);
  check('...and calls a low-attrition cap a STANDOFF', /STANDOFF/.test(shape), shape);
  check('...and a high-attrition cap a grind', /grind/.test(shape), shape);
  check('...and still prints the baseline for comparison', /baseline/.test(shape), shape);
  eq('...and returns its lines for the JSON', shapeLines.length >= 2, true);
  eq('a row with no turn data is skipped rather than crashing the block',
    ablation.renderTurnShape([{ id: 'broken', battles: 0 }], function () { }), []);

  section('5k. the quiescence sub-knobs exist, because the tier is not one thing');
  const subIds = ablation.FEATURE_IDS.filter(function (id) { return /^quiescence-/.test(id); });
  eq('all three sub-knobs are in the table', subIds.length, 3);
  const sub = ablation.FEATURES.filter(function (f) { return /^quiescence-/.test(f.id); });
  eq('...and each patches exactly one leaf of the tier',
    sub.map(function (f) { return Object.keys(f.patch)[0]; }).sort(),
    ['laplace.quiescence.blockProtect', 'laplace.quiescence.extendSetup', 'laplace.quiescence.respectTurn2Speed']);
  eq('...and each declares its parent for grouping', sub.every(function (f) { return f.parent === 'quiescence'; }), true);
  eq('...and they are separate from the master switch',
    ablation.FEATURES.filter(function (f) { return f.parent === 'quiescence'; }).map(function (f) { return f.id; }),
    ['quiescence', 'quiescence-extendsetup', 'quiescence-blockprotect', 'quiescence-turn2speed']);
  const subReport = ablation.validateFeaturePaths(ablation.buildVariants(subIds));
  eq('...and their paths are real config leaves', subReport.length, 3);
  eq('...and neither is a no-op against the shipped config',
    subReport.every(function (r) { return r.applied.every(function (a) { return a.from !== a.to; }); }), true);
}

/* ============================================ 7. the client frames the arena now supplies */

/**
 * THE CLIENT FRAMES. Three inputs the SHIPPED engine reads and a raw sim player stream does not
 * carry, each of which a real client emits and the arena used to omit — and omitting any of them
 * does not fail a battle, it makes rows of the table silently measure nothing. That is the failure
 * mode this whole suite exists to catch, so each is asserted where the fix lives, at the bridge:
 *
 *   |stacc|   the move's accuracy, the ONLY input laplace.volatility acts on (and so the only
 *             thing laplace.comeback scales).
 *   /choose   our own outgoing click, tagged 'send' — the only line that can move the clock.
 *   |player|  the opponent's rating, which clock.ratingBands reads.
 */
function checkClientFrames() {
  section('7. the client frames the arena supplies (accuracy, /choose, rating)');
  const bridge = require(path.join(ROOT, 'tools', 'headless_arena', 'engine_bridge.js'));
  const paste = require(path.join(ROOT, 'tools', 'headless_arena', 'teams.js')).SAMPLE_TEAMS.hazardStackBalance;

  /* 1. The accuracy table. The dex is the sim's, so this is the one part that needs the sim. */
  if (simAvailable) {
    const session = bridge.createSession({ paste: paste });
    eq('the engine parses the PASTE the arena hands it (not the packed team the sim gets)',
      session.team.length, 6);
    session.feed('|request|' + JSON.stringify({
      active: [{ moves: [{ move: 'Focus Blast', id: 'focusblast' }, { move: 'Close Combat', id: 'closecombat' }] }],
      side: { id: 'p1', pokemon: [{ moves: ['focusblast', 'closecombat'] }] }
    }));
    const board = session.boot.state && session.boot.state.state;
    eq('...and the bridge forwards |stacc| for the menu', board && board.moveAccuracy && board.moveAccuracy.focusblast, 70);
    check('...so the volatility charge is live in the arena',
      new session.ST.LaplaceEngine({})._volatilityDelta(
        { kind: 'move', name: 'Focus Blast', moveId: 'focusblast' }, board, null, 100).penalty < 0, 'charge was 0');
  } else {
    console.log('  SKIPPING the |stacc| frame: the dex it reads is the sim\'s, and @pkmn/sim is not installed.');
  }

  /* 2. Our own outgoing /choose — the one line that can set mySubmitTs. No sim needed. */
  const live = bridge.createSession({ paste: paste });
  live.noteOutgoing('move headlongrush');
  live.feed('|turn|2');
  live.noteOutgoing('move headlongrush');
  live.feed('|turn|3');
  const clock = live.boot.clock && live.boot.clock.snapshot();
  check('noteOutgoing() gives the clock a sample', !!clock && clock.samples >= 2, clock && String(clock.samples));
  check('...so the label leaves unknown', !!clock && clock.label !== 'unknown', clock && clock.label);
  check('...so the switch column is actually re-weighted', !!clock && clock.switchFactor !== 1, clock && String(clock.switchFactor));

  /* THE ARTIFACT, and then the declaration that removes it.
   *
   * Both of the arena's players share one event loop, so the lead the clock measures is ~0 ms on
   * every turn. That is below fastMs, so the estimator labels EVERY turn 'auto' (0.25) — and 0.25 is
   * below switchKeepThreshold (0.5), which DELETES the opponent's switch replies from the matrix for
   * the entire battle. A baseline run built on that is not measuring deliberation, it is measuring
   * the absence of a network. run_arena therefore DECLARES the opponent's pace instead (default
   * 'normal', whose prior is the identity); these checks pin the artifact and the declaration. */
  check('with no declaration the arena reads as auto — the artifact',
    !!clock && clock.label === 'auto' && clock.switchFactor === 0.25, clock && (clock.label + ' / ' + clock.switchFactor));
  eq('declaring normal is the identity for the switch column',
    (live.declareOpponentDeliberation('normal'), live.boot.clock.snapshot().switchFactor), 1);
  eq('...and the snapshot marks the label as DECLARED, not measured',
    live.boot.clock.snapshot().declared, 'normal');
  eq('declaring a slow opponent raises it instead',
    (live.declareOpponentDeliberation('agonised'), live.boot.clock.snapshot().switchFactor), 1.6);
  eq('an unrecognised label is ignored rather than guessed at',
    (live.declareOpponentDeliberation('sideways'), live.boot.clock.snapshot().declared), null);

  /* 3. The rating clock.ratingBands reads. No sim needed: it is a protocol line. */
  live.feed('|player|p2|Adversary||1700');
  const rated = live.boot.state && live.boot.state.state;
  eq('a |player| rating reaches the state', rated && rated.opponentRating, 1700);
  eq('...and the clock', live.boot.clock && live.boot.clock.snapshot().rating, 1700);
}

/* ======================================================================= 6. the real CLI */

async function checkEndToEnd() {
  section('6. end to end: one real batch through the CLI, plus the refusals it must not skip');

  const listRun = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'run_ablation.js'), '--list'],
    { cwd: ROOT, encoding: 'utf8' });
  eq('--list exits 0', listRun.status, 0);
  check('--list names a feature', /nash/.test(listRun.stdout), listRun.stdout.slice(0, 80));

  const badRun = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'run_ablation.js'), '--features', 'nope'],
    { cwd: ROOT, encoding: 'utf8' });
  eq('an unknown feature exits 2 (setup failure, not a silent skip)', badRun.status, 2);

  /* The arena's own refusal, through the CLI: a misspelt config path must be a hard failure, because
   * a run that ignores its --set produces a plausible table of zeros. */
  const badSet = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'run_arena.js'),
    '--battles', '1', '--agent', 'anchor', '--mode', 'full', '--quiet', '--set', 'laplace.nash.enabledd=false'],
    { cwd: ROOT, encoding: 'utf8' });
  eq('a misspelt --set makes the arena exit 2', badSet.status, 2);
  check('...with a message that names the path',
    /laplace\.nash\.enabledd/.test(badSet.stderr + badSet.stdout), (badSet.stderr || '').trim().slice(0, 120));

  if (!simAvailable) {
    console.log('\nSKIPPING the live batch: @pkmn/sim is not installed.');
    console.log('  `npm install` adds it (@pkmn/sim is a devDependency); the live batch was not run.');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ablation-test-'));
  const outPath = path.join(tmpDir, 'summary.json');
  const run = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'run_ablation.js'),
    '--features', 'nash', '--battles', '1', '--seed', '3', '--agent', 'anchor',
    '--out', outPath, '--quiet'],
    { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
  eq('a real two-batch run exits 0', run.status, 0);
  check('...and reports the batches it ran', /baseline/.test(run.stdout) && /nash/.test(run.stdout),
    (run.stdout || '').slice(-200));

  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (e) { payload = null; }
  check('the JSON summary is written', !!payload, outPath);
  if (payload) {
    eq('the summary has a baseline row plus one per feature', payload.rows.length, 2);
    eq('the baseline is the first row', payload.rows[0].id, 'baseline');
    eq('the feature row carries the config flag it patched', payload.rows[1].patch, ['laplace.nash.enabled=false']);
    eq('the feature is identified', payload.rows[1].id, 'nash');
    check('the rows carry the required outcome columns',
      payload.rows.every(function (r) {
        return ['winRate', 'lossRate', 'tieRate', 'avgTurns', 'deltaWin', 'deltaTurns', 'verdict']
          .every(function (k) { return r[k] !== undefined; });
      }), JSON.stringify(Object.keys(payload.rows[0]).slice(0, 12)));
    eq('the summary carries the verdict buckets', Array.isArray(payload.verdicts.helps), true);
    eq('the run is recorded as paired on a shared seed', payload.bootstrap.paired, true);
    eq('...with the seed every variant shared', payload.sharedSeed, 3);
    eq('every variant ran full battles (never a spliced line)', payload.mode, 'full');
    eq('one battle per variant, as asked', payload.rows[1].battles, 1);
    check('the baseline row is the reference, not a delta',
      payload.rows[0].verdict === 'reference' && payload.rows[0].deltaWin === 0, payload.rows[0].verdict);
    check('a one-battle-per-arm run cannot claim a significant effect',
      payload.rows[1].verdict === 'no measurable effect at this sample size' ||
      payload.rows[1].flags.indexOf('unpaired') !== -1, payload.rows[1].verdict);
  }

  /* THE ENGINE'S OWN TEAM, pinned through the CLI because that is where the bug was. run_arena
   * handed the engine the sim-PACKED team string while every suite — and a browser — hands it a
   * Pokepaste. `parseTeam` reads a paste, so the engine played with ONE body whose species was the
   * whole packed line: it then offered `switch <packed team>` as a legal option, the sim rejected it
   * ("Can't make choices: You sent choices for 54 Pokemon"), and the driver SILENTLY substituted
   * the rejection, so the battle was partly no longer the engine's. Caught here at one fixed seed:
   * with the packed input this record carried 10 rejected choices, with the paste it carries 0. */
  const arenaOut = path.join(tmpDir, 'arena.json');
  const arenaRun = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'run_arena.js'),
    '--battles', '1', '--agent', 'anchor', '--mode', 'full', '--seed', '7', '--json', arenaOut, '--quiet'],
    { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
  eq('one real full battle exits 0', arenaRun.status, 0);
  let arenaPayload = null;
  try { arenaPayload = JSON.parse(fs.readFileSync(arenaOut, 'utf8')); } catch (e) { arenaPayload = null; }
  const rec = arenaPayload && arenaPayload.records && arenaPayload.records[0];
  check('the arena wrote a battle record', !!rec, arenaOut);
  if (rec) {
    eq('the engine submitted no choice the sim rejected', rec.battleErrors, 0);
    eq('...and never had to fall back on an empty ranking', rec.engineEmptyRankings, 0);
    eq('...and logged no pipeline error', rec.enginePipelineErrors, 0);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

(async function main() {
  console.log('ablation_check: validating tools/run_ablation.js');
  checkConfigPatchMechanism();
  checkConfigReachesEngine();
  checkLoadTimePatchReachesEngine();
  checkFeatureTable();
  checkArgs();
  checkAggregation();
  checkClientFrames();
  await checkEndToEnd();

  console.log('\n=== summary ===');
  console.log('checks passed: ' + passed);
  console.log('checks failed: ' + failures.length);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(function (f) { console.log('  x ' + f); });
    process.exit(1);
  }
  console.log('ALL ABLATION CHECKS PASSED');
  process.exit(0);
})().catch(function (err) {
  console.error('\nFATAL: the ablation suite threw before it could report:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
