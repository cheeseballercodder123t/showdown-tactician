#!/usr/bin/env node
/* Showdown Tactician — tools/run_ablation.js
 *
 * WHY THIS EXISTS
 *   The arena answers "is the engine good?" with one win rate. It cannot answer the question that
 *   actually blocks a decision: "which of the eight things deciding this move is doing the work?"
 *   Every tier in src/config.js ships gated (`laplace.wincon.enabled: false`, five board vetoes
 *   that can each be switched off, a Nash solve that can fall back to the legacy single-line
 *   softmax) and until now the only way to price one was to hand-edit config.js, run the arena,
 *   edit it back, run it again, and subtract the two numbers in your head.
 *
 *   This runs that experiment. A baseline batch, then one batch per feature with that feature
 *   alone toggled, all on the SAME seeds, and a table of the differences.
 *
 * HOW IT MEASURES (the four choices that make the numbers mean something)
 *
 *   1. ONE SEED FOR EVERY VARIANT, PAIRED PER BATTLE. run_arena derives each battle's seed from
 *      (base seed, battle index), so variant and baseline play byte-identical games. Comparing
 *      two independent 500-battle samples would fold the variance of TWO draws into the delta;
 *      pairing subtracts it out. `verifyPairing` re-derives that claim from the records' own seed
 *      fields instead of trusting it, and says so when it does not hold.
 *
 *   2. A PAIRED BOOTSTRAP, NOT A BYTE COUNT. 500 battles puts the standard error of a win rate
 *      near 2 points, so a 3-point "improvement" is nothing until it clears noise. The delta is
 *      reported with a 95% percentile interval from a paired bootstrap over battles, the same
 *      test tools/train_mlp_residual.js uses to reject the residual head. A feature whose
 *      interval straddles zero is reported as "no measurable effect at this sample size" — not as
 *      neutral, and never as an improvement.
 *
 *   3. THE PATCH IS PROVEN TO HAVE LANDED. A child that silently ignored `--set` would produce a
 *      perfectly plausible baseline-vs-baseline comparison, i.e. a table of zeros reported as
 *      "these features do nothing". So every variant's report carries the arena's own
 *      `appliedSets` echo, and a variant with a patch whose echo is empty is a hard failure.
 *
 *   4. STALLS ARE SEPARATED FROM DRAWS. A 100-turn tie is not the same outcome as a genuine draw:
 *      it is the signature of a policy that will not commit. `stallTies` counts the ties that
 *      were aborted at the turn cap (or timed out), and a variant whose stall share or turn count
 *      moves is flagged even when its win rate is flat.
 *
 * WHAT IT DOES NOT DO
 *   It does not run `--mode crucible`: a spliced battle hands the engine a recorded human line,
 *   which is not comparable across variants. Every batch here plays full games from turn 1. It
 *   also does not mutate teams (--mutate), harvest puzzles (--harvest) or re-fit anything.
 *
 * Usage: node tools/run_ablation.js [options]        (see --help)
 *   node tools/run_ablation.js --list
 *   node tools/run_ablation.js --features nash,quiescence --battles 500 --parallel 4
 * Self-check: node tools/run_ablation.js --features nash --battles 2 --seed 7
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ARENA = path.join(__dirname, 'run_arena.js');
/* Wrapping is fine here: run_arena.js only touches the fs/path at module scope and loads the
 * engine sandbox lazily, so requiring it cannot pull @pkmn/sim into a process that lacks it. */
const arena = require(ARENA);
const harness = require(path.join(ROOT, 'tests', 'harness.js'));

const DEFAULT_BATTLES = 500;      // the sample this repo's brief asks for, per variant
const DEFAULT_SEED = 1337;        // same default as the arena, so the two tools share a corpus
const DEFAULT_MAX_TURNS = 100;
const BOOTSTRAP_B = 2000;
const BOOTSTRAP_SEED = 20261012;  // fixed: the interval must not move between two runs of the same data

/* When a variant's turns or its stall share move by this much, the change is called out. Both are
 * deliberately loose: the point is to catch a policy that stops committing, not to fingerprint
 * normal turn-count jitter. */
const STALL_TURN_DELTA = 8;
const STALL_TIMEOUT_SHARE = 0.10;

/* --------------------------------------------------------------------------- the feature table
 *
 * One row per thing a reader might want to price. `patch` is applied through the arena's own
 * `--set` (the dotted path must already exist in src/config.js, or the arena refuses to run — see
 * applyConfigPatch), so a typo here is a loud setup error rather than a silent measurement of
 * nothing.
 *
 * `expect` records what the engine author believed before the run. It is printed next to the
 * verdict precisely so a surprise is visible: an "expected help" that comes back hurting is the
 * most valuable row in the table, and a "no effect" is only interesting in light of what was
 * expected.
 */
const FEATURES = [
  {
    id: 'nash',
    label: 'nash solve (off)',
    tier: 'laplace',
    direction: 'off',
    patch: { 'laplace.nash.enabled': false },
    expect: 'helps',
    note: 'Off restores the legacy single-line softmax: it prints one best line instead of an ' +
      'equilibrium frequency, which a patient opponent can exploit.'
  },
  {
    id: 'quiescence',
    label: 'quiescence (off)',
    tier: 'laplace',
    direction: 'off',
    parent: 'quiescence',
    patch: { 'laplace.quiescence.enabled': false },
    expect: 'helps',
    note: 'Off makes the matrix read their setup move and their Protect as no-ops — the exact ' +
      'blind spot the tier was added to price.'
  },
  /* THE SUB-KNOBS, because the tier is not one thing. `quiescence` re-prices two different replies
   * (a setup move and a Protect) and its first measurement came back HURTING the engine by 15 win
   * points, so the next question is which half. Isolating them is the whole reason the tier was
   * split into `extendSetup` and `blockProtect` rather than shipped as one switch. */
  {
    id: 'quiescence-extendsetup',
    label: 'quiescence: setup ply (off)',
    tier: 'laplace',
    direction: 'off',
    parent: 'quiescence',
    patch: { 'laplace.quiescence.extendSetup': false },
    expect: 'helps',
    note: 'Off leaves their SETUP reply priced as the no-op it used to be: they gain the boost and ' +
      'do not get to use it in the same cell.'
  },
  {
    id: 'quiescence-blockprotect',
    label: 'quiescence: protect block (off)',
    tier: 'laplace',
    direction: 'off',
    parent: 'quiescence',
    patch: { 'laplace.quiescence.blockProtect': false },
    expect: 'helps',
    note: 'Off stops their Protect from blocking our move inside the cell, so a lethal bonus goes ' +
      'through a shield again.',
    /* The distinction that matters for this row: it is NOT dead code and NOT unmeasurable. */
    caveat: 'INERT IN THIS CORPUS, NOT DEAD CODE: tests/quiescence_check.js proves the shield blocks ' +
      'our move inside the cell and that blockProtect:false reproduces the legacy 1-ply number ' +
      'exactly, so the knob works and its input (their Protect) does reach it. It still changed no ' +
      'decision in 150 arena battles, which means their shield never landed on a cell where the ' +
      'block flipped the choice. This row is NOT implicated in the tier\u2019s harm and is NOT ' +
      'evidence the block is useless.'
  },
  {
    id: 'volatility',
    label: 'volatility penalty (off)',
    tier: 'laplace',
    direction: 'off',
    patch: { 'laplace.volatility.enabled': false },
    expect: 'helps',
    note: 'Off stops charging a low-accuracy move for the downside of missing it, so a 70% ' +
      'nuke is priced as 70% of its raw damage.',
    /* NOT A NEUTRAL RESULT WHEN THIS ROW IS FLAT. The charge needs the move's accuracy, and
     * `LaplaceEngine._accuracyOf` reads `state.moveAccuracy`, which only `src/injected.js`
     * populates (the `|stacc|` snapshot read from the CLIENT's own dex). @pkmn/sim emits no such
     * line, so in the arena the table is empty, every penalty is 0, and toggling the flag cannot
     * change a single decision. Measured: this row reproduced the baseline battle for battle at 60
     * battles a side. Price volatility with a real client stream, not with this runner. */
    caveat: 'UNPRICEABLE IN THIS HARNESS: the charge needs the move accuracy from state.moveAccuracy, ' +
      'which only the injected |stacc| snapshot populates. The sim emits no |stacc|, so the penalty ' +
      'is always 0 and toggling the flag cannot change a decision. A flat row here means "not ' +
      'measurable here", NOT "the tier does nothing".'
  },
  {
    id: 'clock',
    label: 'opponent clock prior (off)',
    tier: 'clock',
    direction: 'off',
    patch: { 'clock.enabled': false },
    expect: 'neutral',
    note: 'Off keeps their switch replies in the matrix no matter how fast they answered.',
    /* THE MECHANISM IS VERIFIED, not inferred from a flat score. `OpponentClock._close()` returns
     * early unless `mySubmitTs` is set, and that is set only by an OUTGOING `/choose` line tagged
     * `kind === 'send'`. The arena's agent returns a choice string to the sim runner, which writes
     * it to the player stream — the boot never sees a `/choose` line. So the clock's history stays
     * empty, `label()` stays 'unknown', and `switchPrior.unknown` is 1.0, which is exactly what
     * `clock.enabled = false` does (no re-weight at all). Measured: this row reproduced the baseline
     * battle for battle at 60 battles a side. Pinned in tests/ablation_check.js. */
    caveat: 'INERT IN THIS HARNESS: the clock only records a sample when it sees OUR OWN outgoing ' +
      '/choose line, and the arena answers the sim runner directly instead of sending one. The ' +
      'history stays empty, the label stays `unknown`, and clock.switchPrior.unknown = 1.0 is ' +
      'exactly what clock.enabled = false does. A flat row here is "not measurable here".'
  },
  {
    id: 'damage-evidence',
    label: 'reverse damage evidence (off)',
    tier: 'pruner',
    direction: 'off',
    patch: { 'pruner.damageEvidence.enabled': false },
    expect: 'neutral',
    note: 'Off stops eliminating candidate sets whose damage range cannot cover an observed hit, ' +
      'so the opponent model stays wider.',
    /* Measured identical to the baseline battle for battle. The cause is NOT established here, and
     * inventing one would be worse than saying so: the set pool is a model of the opponent, and a
     * wider pool only changes a decision when a discarded set would have changed what the engine
     * VALUES. Against three fixed personas with curated sets that may simply never happen. */
    caveat: 'UNRESOLVED: toggling this changed no battle at this sample. That is not evidence that ' +
      'the tier is useless — the cause is NOT established. The set pool it widens only moves a ' +
      'decision when a discarded candidate would have changed the ranking, which may not occur ' +
      'against three curated personas. Treat this row as unresolved, not as neutral.'
  },
  {
    id: 'residual-order',
    label: 'residual speed order (off)',
    tier: 'pruner',
    direction: 'off',
    patch: { 'pruner.residualOrder.enabled': false },
    expect: 'neutral',
    note: 'Off ignores the speed order implied by end-of-turn residual blocks.',
    caveat: 'UNRESOLVED: toggling this changed no battle at this sample. Like reverse damage ' +
      'evidence, this narrows the opponent MODEL, and a narrower model only changes a decision when ' +
      'it removes the set that would have won the ranking. The cause is not established here.'
  },
  {
    id: 'scout-prior',
    label: 'scout prior (off)',
    tier: 'pruner',
    direction: 'off',
    patch: { 'pruner.scout.enabled': false },
    expect: 'neutral',
    note: 'The replay-derived set re-weighting. ships EMPTY, so with no overlay this is a ' +
      'control: it SHOULD measure as no effect, and a real delta would mean the overlay is live.'
  },
  {
    id: 'usage-overlay',
    label: 'ladder usage overlay (off)',
    tier: 'usage',
    direction: 'off',
    patch: { 'usage.enabled': false },
    expect: 'neutral',
    note: 'The second control. src/sets_usage.js also ships empty, so a non-zero delta here ' +
      'would point at a bug in the overlay rather than at a policy.'
  },
  {
    id: 'veto-wastedhazardclear',
    label: 'veto8 wasted hazard clear (off)',
    tier: 'veto',
    direction: 'off',
    patch: { 'veto.wastedHazardClear': false },
    expect: 'helps',
    note: 'Off permits a Rapid Spin/Defog with nothing on our side to clear.'
  },
  {
    id: 'veto-consecutiveprotect',
    label: 'veto9 consecutive protect (off)',
    tier: 'veto',
    direction: 'off',
    patch: { 'veto.consecutiveProtect': false },
    expect: 'helps',
    note: 'Off permits a Protect the game will fail because the counter is up.'
  },
  {
    id: 'veto-magicbounceredirect',
    label: 'veto10 magic bounce (off)',
    tier: 'veto',
    direction: 'off',
    patch: { 'veto.magicBounceRedirect': false },
    expect: 'helps',
    note: 'Off permits a hazard into a possible Magic Bounce, which lands it on OUR side.'
  },
  {
    id: 'veto-saturatedhazard',
    label: 'veto11 saturated hazard (off)',
    tier: 'veto',
    direction: 'off',
    patch: { 'veto.saturatedHazard': false },
    expect: 'helps',
    note: 'Off permits a hazard already at its layer cap, which sets nothing.'
  },
  {
    id: 'veto-redundantfield',
    label: 'veto12 redundant field (off)',
    tier: 'veto',
    direction: 'off',
    patch: { 'veto.redundantField': false },
    expect: 'helps',
    note: 'Off permits re-setting the weather that is already up.'
  },
  {
    id: 'veto-board-layer',
    label: 'veto 8-12 (all off)',
    tier: 'veto',
    direction: 'off',
    patch: {
      'veto.wastedHazardClear': false,
      'veto.consecutiveProtect': false,
      'veto.magicBounceRedirect': false,
      'veto.saturatedHazard': false,
      'veto.redundantField': false
    },
    expect: 'helps',
    note: 'The five board-state vetoes together. Compare with the five rows above: if the group ' +
      'moves and no member does, the effect is their joint coverage of rare boards.'
  },
  {
    id: 'wincon',
    label: 'wincon bounty (on)',
    tier: 'inert',
    direction: 'on',
    patch: { 'laplace.wincon.enabled': true, 'laplace.wincon.maxBounty': 80 },
    expect: 'neutral',
    note: 'Ships inert. Enabling it needs a non-zero maxBounty too, or there is nothing to ' +
      'measure — so this row turns on both and the bounty is capped at 80 (below lethalBonus 260).'
  },
  {
    id: 'scouting',
    label: 'scouting bounty (on)',
    tier: 'inert',
    direction: 'on',
    patch: { 'laplace.scouting.enabled': true, 'laplace.scouting.maxBounty': 60 },
    expect: 'neutral',
    note: 'Ships inert with maxBounty 0, so this row enables it with a 60-point cap.'
  },
  {
    id: 'endgame',
    label: 'endgame solver (on)',
    tier: 'inert',
    direction: 'on',
    patch: { 'laplace.endgame.enabled': true },
    expect: 'neutral',
    note: 'Ships inert. On, it runs a bounded alpha-beta search with <=2 bodies a side. It ' +
      'REFUSES outside its competence, so on most boards this is expected to be a no-op.'
  },
  {
    id: 'profile',
    label: 'opponent profile (on)',
    tier: 'inert',
    direction: 'on',
    patch: { 'laplace.profile.enabled': true },
    expect: 'neutral',
    note: 'Ships inert. On, it re-weights their switch column by how they have deviated from the ' +
      'matrix\'s own predicted frequencies, clamped to [1/2, 2].'
  },

  /* ============================ the four tiers the tuning sweep was written to price ======
   *
   * All four ship OFF. They are the newest policies in the tree and none has been measured, which
   * is the repo's rule for adopting one: a tier is enabled because an ablation says so, never
   * because its rationale is persuasive. Each row below is a single boolean flip from the shipped
   * config, so `direction: 'on'` and a significant result is read as "feature HELPS".
   */
  {
    id: 'absence-rules',
    label: 'ability deduction: absence (on)',
    tier: 'pruner',
    direction: 'on',
    patch: { 'pruner.abilityDeduction.absenceRules': true },
    expect: 'helps',
    note: 'On, a body that switched in this turn WITHOUT announcing a switch-in ability (Intimidate, ' +
      'Drizzle/Drought/Sand Stream/Snow Warning, the four terrain surges, ...) has those abilities ' +
      'struck from every candidate set, the way a revealed ability already strikes the others. This ' +
      'is the one ABSENCE-of-evidence rule in the pruner, which is why it needs the Neutralizing Gas ' +
      'suppression guard before it eliminates anything.',
    /* THE ONE THING THAT MAKES THIS ROW MEASURABLE: pruner.* is captured into module constants
     * while src/set_pruner.js is EVALUATED, so a patch applied after the harness is loaded updates
     * the config object and nothing else. The arena now applies --set from inside loadHarness, the
     * moment src/config.js has run, so this row reaches the live pruner. Before that fix it would
     * have read as a flat, "identical" row — a false negative for a tier that never got a chance
     * to fire. */
    caveat: 'FIRES, BUT MOVES NOTHING HERE — measured, not inferred. Counting the rule\'s own ' +
      'eliminations over 12 arena battles with the flag on: 624 pruner calls, 176 of them striking ' +
      'an ability for a silent switch-in (1,584 ability bans). So this is NOT a "no target" flat ' +
      'row — the second of the two cases the footnote names: the input arrives and never changes a ' +
      'RANKING. Narrowing the opponent model only moves a decision when the discarded set would ' +
      'have won the ranking, which against three curated personas it evidently never does.'
  },
  {
    id: 'elo-band',
    label: 'Elo switch bands (on)',
    tier: 'clock',
    direction: 'on',
    patch: { 'clock.ratingBands.enabled': true },
    expect: 'helps',
    note: 'On, the opponent\'s ladder rating scales their SWITCH columns through the same single ' +
      'switchFactor the solver already reads: a low-ladder opponent pivots rarely, so their pivots ' +
      'leave the reply space (lowFactor 0.05 < switchKeepThreshold 0.5), while a high-ladder one ' +
      'gets them boosted. The point is anti-mid-ladder throwing: over-predicting a double-switch ' +
      'against a player who just clicks their best attack is how a bot donates games.',
    caveat: 'INERT IN THIS HARNESS: the band needs the opponent\'s rating, which the protocol only ' +
      'carries on a `|player|p2|Name|avatar|1480` line. tools/headless_arena/sim_runner.js creates ' +
      'both players without a `rating` option, so @pkmn/sim emits `|player|p2|Adversary||` with an ' +
      'empty field; state.opponentRating stays null and OpponentClock.ratingFactor() returns 1 by ' +
      'design. A flat row here is "not measurable here", NOT evidence about the band.'
  },
  {
    /* ADOPTED 2026-10-12, so this row is measured the way every shipped-ON tier here is: by
     * switching it OFF. When it was written the patch turned the tier on (and the sweep that
     * adopted it read "switching it on +28.3"); the flag now ships true, so the same experiment
     * prices what turning it off costs and the sign of the note flips with it. Leaving the patch
     * pointed at the value it already holds would have made this a no-op row, which the feature
     * table's own integrity check refuses — and would have measured nothing. */
    id: 'urgency',
    label: 'turn urgency (off)',
    tier: 'laplace',
    direction: 'off',
    patch: { 'laplace.urgency.enabled': false },
    expect: 'helps',
    note: 'SHIPS ON (adopted on this sweep). Off, a COMMITTING line (a real attack or a setup move) ' +
      'loses the bounded, ramping bonus it earns past turn 25 and a PASSIVE line (Protect, or a ' +
      'non-progressing status move) stops taking its malus, both multiplied by breakoutScale from ' +
      'turn 50. The tier re-ranks ROWS only: it cannot override a veto, and it does not weaken ' +
      'quiescence.blockProtect — that a shield blocks our move is a game rule, not a preference. ' +
      'Measured when it was adopted: 68.3% -> 96.7% win rate and the 100-turn cap ties cut 17/60 ' +
      '-> 1/60.'
  },
  {
    id: 'comeback',
    label: 'comeback mode (on)',
    tier: 'laplace',
    direction: 'on',
    patch: { 'laplace.comeback.enabled': true },
    expect: 'helps',
    note: 'On, the volatility charge is scaled by where the 128D evaluator puts the board: sharpened ' +
      '(x2) when we are up by winMargin, softened (x0.4) when we are down by lossMargin. The design ' +
      'is prospect theory: protect a lead with minimum variance, take the swing when behind.',
    caveat: 'UNPRICEABLE IN THIS HARNESS: comeback scales ONLY the volatility charge, and ' +
      'LaplaceEngine._volatilityDelta returns a zero penalty before it ever reaches that scale when ' +
      'state.moveAccuracy is empty — which it always is in the arena, because only src/injected.js ' +
      'populates it from the client\'s own |stacc| snapshot and @pkmn/sim emits no |stacc|. Any ' +
      'multiplier on a charge of 0 is 0, so a flat row here means "not measurable here", NOT that ' +
      'comeback mode does nothing. Same cause as the volatility row above.'
  },
  {
    /* THE PIVOT TAX — the one tier here whose motivation is a HUMAN-MATCH measurement, and the one
     * row where that fact is a reason for caution rather than for optimism: agreement and strength
     * measurably disagree in this tree. Turning `quiescence` off RAISES human agreement (net +18
     * decisions over 100 elite battles) while this same table prices the tier at +19 win points, so
     * a policy that improves agreement is not thereby a policy that wins. This row is the only
     * evidence that may promote the tier; the benchmark cannot. */
    id: 'switch-tax',
    label: 'pivot tax (on)',
    tier: 'laplace',
    direction: 'on',
    patch: { 'laplace.switchTax.enabled': true },
    expect: 'helps',
    note: 'On, every SWITCH row carries a flat score drag, so a pivot has to beat the best attack ' +
      'by `points` before it takes the top line. It is a POLICY term, not a deduction about the ' +
      'opponent: the matrix already prices the incoming hit and the hazards on entry, and what it ' +
      'cannot price is the free turn a pivot hands over (their Stealth Rock, their Dance, or the ' +
      'coverage move that greets the arrival). Motivations, all measured in tools/benchmark_' +
      'human_match.js over 100 elite battles / 5,903 decisions (mean 1,830) and re-derived from that ' +
      'run\'s own --out records: the engine\'s top line is a switch on 55.4% of contested turns where ' +
      'those humans switched 33.8%; and on the 4,349 turns the human clicked a MOVE its top line was ' +
      'a pivot 48.1% of the time on a 0-1 attack menu, 49.2% on 2-3, and 39.0% even with a FULL ' +
      '4-attack menu — so a thin menu inflates the figure without explaining it away. Two competing ' +
      'explanations were tested and BOTH REFUTED on the same corpus with paired counts: ' +
      '`quiescence.extendSetup=false` is net -21 top-1 decisions AND raises the pivot rate ' +
      '(53.1% -> 54.2%); suppressing VETO4 is net -22 with the pivot rate flat (53.1% -> 53.7%).',
    caveat: 'MEASURED AND REJECTED BY THIS ROW, and the pre-registration that did NOT hold. The ONLY ' +
      'positive sign it ever had came from 30 CRUCIBLE battles (a single seed against the anti-setup ' +
      'exploiter, 66.7% -> 80.0% by converting 5 of its 10 cap ties into wins, at the cost of 1 chaos ' +
      'win) — and crucible mode splices a recorded human line in at turn 8+, which this runner never ' +
      'does because it is NOT comparable across variants. At the standard sample the tax is one of the ' +
      'clearest HURTS rows in the table: 96.7% -> 70.0%, delta -26.7 points, 95% CI [-38.3, -15.0], ' +
      'and it re-creates the exact pathology turn urgency was adopted to remove — the 100-turn cap ' +
      'ties come back 1/60 -> 18/60 (30% stall) with only 4.1 of 12 bodies down, a STANDOFF. So the ' +
      'tier ships OFF and this row is the evidence for that, kept so it is re-measured rather than ' +
      'rediscovered. It is also the cleanest demonstration of why this table exists: the same change ' +
      'raised human agreement by 12.3 points (31.7% -> 44.0% overall) and cost 26.7 win points, so ' +
      'agreeing with a 1,830-rated human is not the same thing as beating one. And the agreement it ' +
      'bought was not even the agreement the tier was built for: the MOVE half rises 35.0% -> 53.8% ' +
      'while the SWITCH half FALLS 22.5% -> 16.5%, so the pivot rate came down (55.4% -> 29.2%, now ' +
      'UNDER the humans\' 33.8%) without the engine learning which pivot to make.',
  }
];

const FEATURE_IDS = FEATURES.map(function (f) { return f.id; });

/* ------------------------------------------------------------------------------ small helpers */

/** mulberry32 — tiny, seeded, and version-stable, so an interval does not move between runs. */
function mulberry32(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated percentile of an already-sorted array. */
function percentile(sorted, p) {
  if (!sorted || !sorted.length) return NaN;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mean(values) {
  if (!values || !values.length) return 0;
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  return total / values.length;
}

/**
 * pairAllIdentical(a, b) -> true when two arms produced the SAME outcome in EVERY battle.
 *
 * This is worth its own flag because it is the signature of a flag that cannot move a decision:
 * 60 battles is far too many for a real policy difference to leave every single result untouched.
 * It is a prompt to check whether the flag's INPUT is present in this harness — not a verdict on
 * its own, which is why the row still reports what it measured.
 */
function pairAllIdentical(a, b) {
  if (!a || !b || !a.length || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].winner !== b[i].winner || a[i].turns !== b[i].turns) return false;
  }
  return true;
}

function pad(s, n, right) {
  s = String(s === undefined || s === null ? '' : s);
  while (s.length < n) s = right ? ' ' + s : s + ' ';
  return s;
}

function clampText(s, n) {
  s = String(s === undefined || s === null ? '' : s);
  return s.length <= n ? s : s.slice(0, n - 1) + '\u2026';
}

function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }
function fmtSigned(x, digits) { return (x >= 0 ? '+' : '') + x.toFixed(digits === undefined ? 1 : digits); }

/* ----------------------------------------------------------------------------------- args */

function printUsage(out) {
  const lines = [
    'Showdown Tactician — config-flag ablation runner',
    '',
    'Runs the headless arena once per feature variant (plus a baseline) on the SAME seeds and',
    'reports each feature\'s isolated effect on win/loss/tie rate and on game length.',
    '',
    'Usage: node tools/run_ablation.js [options]',
    '',
    '  --battles <n>       Battles per variant (default: ' + DEFAULT_BATTLES + ')',
    '  --features <list>   Comma-separated feature ids, or "all" (default: all). See --list.',
    '  --seed <n>          Base seed, shared by every variant (default: ' + DEFAULT_SEED + ')',
    '  --max-turns <n>     Turn cap per battle (default: ' + DEFAULT_MAX_TURNS + ')',
    '  --agent <a>         all | anchor | exploiter | chaos (default: all)',
    '  --parallel <n>      Variants to run at once (default: 1)',
    '  --out <file>        Write the full JSON summary here',
    '  --keep-tmp          Keep the per-variant arena reports (for inspection)',
    '  --list              Print the feature table and exit',
    '  --quiet             Only print the comparison table',
    '  --help              This text',
    '',
    'Every variant runs --mode full: a spliced battle hands the engine a recorded human line,',
    'which is not comparable across variants.',
    '',
    'What every row has decided so far — adopted, rejected, inert here, or unresolved — is',
    'registered in ATTEMPTS.md, indexed by the shape of the idea. Check it before adding a row.',
    ''
  ];
  (out || console.log)(lines.join('\n'));
}

function parseArgs(argv) {
  const opts = {
    battles: DEFAULT_BATTLES, features: 'all', seed: DEFAULT_SEED, maxTurns: DEFAULT_MAX_TURNS,
    agent: 'all', parallel: 1, out: null, keepTmp: false, list: false, quiet: false, help: false
  };
  const need = function (flag, value) {
    if (value === undefined) throw new arena.SetupError(flag + ' needs a value');
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--battles': opts.battles = Number(need(a, argv[++i])); break;
      case '--features': opts.features = String(need(a, argv[++i])); break;
      case '--seed': opts.seed = Number(need(a, argv[++i])); break;
      case '--max-turns': opts.maxTurns = Number(need(a, argv[++i])); break;
      case '--agent': opts.agent = String(need(a, argv[++i])).toLowerCase(); break;
      case '--parallel': opts.parallel = Number(need(a, argv[++i])); break;
      case '--out': opts.out = String(need(a, argv[++i])); break;
      case '--keep-tmp': opts.keepTmp = true; break;
      case '--list': opts.list = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new arena.SetupError('unknown option ' + a + ' (try --help)');
    }
  }
  if (!Number.isFinite(opts.battles) || opts.battles < 1 || Math.floor(opts.battles) !== opts.battles) {
    throw new arena.SetupError('--battles must be a positive integer');
  }
  if (!Number.isFinite(opts.maxTurns) || opts.maxTurns < 1) throw new arena.SetupError('--max-turns must be >= 1');
  if (!Number.isFinite(opts.seed)) throw new arena.SetupError('--seed must be a number');
  if (!Number.isFinite(opts.parallel) || opts.parallel < 1 || Math.floor(opts.parallel) !== opts.parallel) {
    throw new arena.SetupError('--parallel must be a positive integer');
  }
  if (['all', 'anchor', 'exploiter', 'chaos'].indexOf(opts.agent) === -1) {
    throw new arena.SetupError('--agent must be all, anchor, exploiter or chaos');
  }
  return opts;
}

/** Resolve `--features` to a list of ids, rejecting an unknown one instead of quietly skipping it. */
function resolveFeatureIds(spec, all) {
  const ids = (all || FEATURE_IDS);
  if (!spec || spec === 'all') return ids.slice();
  const wanted = String(spec).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!wanted.length) throw new arena.SetupError('--features was empty');
  wanted.forEach(function (id) {
    if (ids.indexOf(id) === -1) {
      throw new arena.SetupError('unknown feature "' + id + '" (have: ' + ids.join(', ') + ')');
    }
  });
  return wanted;
}

/* -------------------------------------------------------------------------------- variants */

/** `{ 'a.b': false }` -> `['a.b=false']`, the exact string the arena's `--set` takes. */
function patchToSetArgs(patch) {
  return Object.keys(patch || {}).map(function (k) {
    return k + '=' + arena.formatConfigValue(patch[k]);
  });
}

/**
 * The batch list: the baseline first, then one variant per selected feature. A feature's patch is
 * exactly ONE flag unless its `note` says otherwise (the inert tiers need an accompanying bounty
 * to be measurable at all, and the group row is the five board vetoes together).
 */
function buildVariants(selectedIds) {
  const ids = selectedIds && selectedIds.length ? selectedIds : FEATURE_IDS;
  const baseline = {
    id: 'baseline', label: 'baseline (shipped config)', tier: 'reference', direction: 'off',
    patch: {}, setArgs: [], expect: null, caveat: null,
    note: 'config.js exactly as committed — the reference every delta is against'
  };
  return [baseline].concat(FEATURES.filter(function (f) { return ids.indexOf(f.id) !== -1; })
    .map(function (f) {
      return {
        id: f.id, label: f.label, tier: f.tier, direction: f.direction, patch: f.patch,
        setArgs: patchToSetArgs(f.patch), expect: f.expect, note: f.note, caveat: f.caveat,
        parent: f.parent || null
      };
    }));
}

/**
 * Validate every feature path against a real config.js before a single battle runs.
 * `applyConfigPatch` is the arena's own function and it REFUSES a path that is not in config.js,
 * which is what turns a typo in the feature table into a setup error instead of a silent,
 * plausible-looking measurement of nothing.
 */
function validateFeaturePaths(variants) {
  const report = [];
  variants.forEach(function (v) {
    if (!v.setArgs.length) return;
    /* A FRESH config per variant. Sharing one sandbox would make each variant's `from` reflect
     * whatever the previous variant left behind, so two features that toggle the same flag (the
     * group row after the five individual ones) would look like no-ops and the validation would
     * depend on table order. */
    const sandbox = harness.loadFiles(['src/config.js']);
    const applied = arena.applyConfigPatch(sandbox.ST, v.setArgs);
    // Applying twice must land on the same values for the echo check to be trustworthy: it is a
    // plain assignment to a live leaf, and this proves there is no accumulate-style merge in it.
    const again = arena.applyConfigPatch(sandbox.ST, v.setArgs);
    if (JSON.stringify(applied.map(function (a) { return a.path + '=' + a.to; })) !==
        JSON.stringify(again.map(function (a) { return a.path + '=' + a.to; }))) {
      throw new arena.SetupError('variant ' + v.id + ': applying its patch twice changed the result');
    }
    report.push({ id: v.id, applied: applied });
  });
  return report;
}

/* ------------------------------------------------------------------ one variant's batch */

function arenaArgs(variant, opts, jsonPath) {
  const args = [
    '--battles', String(opts.battles), '--agent', opts.agent, '--mode', 'full',
    '--seed', String(opts.seed), '--max-turns', String(opts.maxTurns),
    '--json', jsonPath, '--quiet'
  ];
  variant.setArgs.forEach(function (s) { args.push('--set', s); });
  return args;
}

/** Spawn the arena for one variant. Never rejects: a failed batch is data, not a crash. */
function runArenaBatch(variant, opts, jsonPath) {
  return new Promise(function (resolve) {
    const started = Date.now();
    const args = arenaArgs(variant, opts, jsonPath);
    const child = spawn(process.execPath, [ARENA].concat(args), { cwd: ROOT });
    let out = '';
    let err = '';
    child.stdout.on('data', function (d) { out += d; });
    child.stderr.on('data', function (d) { err += d; });
    child.on('error', function (e) {
      resolve({ variant: variant, args: args, exitCode: -1, stdout: out, stderr: err + '\nspawn error: ' + e.message, wallSec: (Date.now() - started) / 1000 });
    });
    child.on('close', function (code) {
      resolve({ variant: variant, args: args, exitCode: code === null ? -1 : code, stdout: out, stderr: err, wallSec: (Date.now() - started) / 1000 });
    });
  });
}

/** Split `scores` (win 1, tie 0.5, loss 0) and turn counters out of the arena's record list. */
function summarizeRun(payload) {
  const records = (payload && payload.records) || [];
  const options = (payload && payload.options) || {};
  const maxTurns = options.maxTurns || DEFAULT_MAX_TURNS;
  const perBattle = [];
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let errors = 0;
  let stallTies = 0;
  records.forEach(function (r) {
    if (r.error) errors++;
    if (r.winner === 'p1') wins++;
    else if (r.winner === 'p2') losses++;
    else ties++;
    const stalled = !!(r.aborted || r.timedOut) || (r.turnCount || 0) >= maxTurns;
    if (r.winner !== 'p1' && r.winner !== 'p2' && stalled) stallTies++;
    perBattle.push({
      index: r.index,
      persona: r.persona,
      seed: Array.isArray(r.seed) ? r.seed.join(',') : null,
      winner: r.winner || 'tie',
      score: r.winner === 'p1' ? 1 : (r.winner === 'p2' ? 0 : 0.5),
      /* Two scales, and they are NOT interchangeable. `win` is the indicator the headline delta and
       * its interval are computed on, so that the interval qualifies the number printed beside it.
       * `score` (win 1 / tie 0.5 / loss 0) is carried for the mean-score readout only — bootstrapping
       * on it while reporting a win-rate delta put the interval on a different scale from its own
       * point estimate, which is how a delta of +15.0 came back with a 95% interval of
       * [+1.7, +12.5]. */
      win: r.winner === 'p1' ? 1 : 0,
      turns: r.turnCount || 0,
      faints: r.faints || 0,
      capped: stalled,
      aborted: !!r.aborted,
      timedOut: !!r.timedOut,
      error: r.error || null
    });
  });
  const battles = records.length;
  const summary = {
    battles: battles,
    wins: wins, losses: losses, ties: ties, errors: errors,
    stallTies: stallTies,
    winRate: battles ? wins / battles : 0,
    lossRate: battles ? losses / battles : 0,
    tieRate: battles ? ties / battles : 0,
    stallTieShare: battles ? stallTies / battles : 0,
    totalTurns: perBattle.reduce(function (a, b) { return a + b.turns; }, 0),
    meanScore: mean(perBattle.map(function (b) { return b.score; })),
    perBattle: perBattle
  };
  summary.avgTurns = battles ? summary.totalTurns / battles : 0;
  summary.scores = perBattle.map(function (b) { return b.score; });
  summary.winScores = perBattle.map(function (b) { return b.win; });
  /* The turn SHAPE, not just its mean. A mean of 54 with a p90 of 100 hides the fact that a
   * quarter of the games ran out of clock, which no single average can express. */
  const sortedTurns = perBattle.map(function (b) { return b.turns; }).sort(function (x, y) { return x - y; });
  summary.turnP50 = percentile(sortedTurns, 50);
  summary.turnP90 = percentile(sortedTurns, 90);
  summary.turnMax = sortedTurns.length ? sortedTurns[sortedTurns.length - 1] : 0;
  const cappedGames = perBattle.filter(function (b) { return b.capped; });
  summary.cappedGames = cappedGames.length;
  summary.meanFaints = mean(perBattle.map(function (b) { return b.faints; }));
  /* The diagnostic that separates a standoff from a grind: 12 bodies start every game, so a capped
   * game that lost only 4 of them is two walls staring at each other. */
  summary.meanFaintsAtCap = mean(cappedGames.map(function (b) { return b.faints; }));
  return summary;
}

/** The per-battle `seed` field must line up for the paired comparison to mean anything. */
function verifyPairing(base, variant) {
  const a = base.perBattle || [];
  const b = variant.perBattle || [];
  if (!a.length || a.length !== b.length) return { paired: false, reason: 'different battle counts' };
  let mismatched = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i].seed !== null && b[i].seed !== null && a[i].seed !== b[i].seed) mismatched++;
  }
  if (mismatched) return { paired: false, reason: mismatched + ' of ' + a.length + ' battles drew a different seed' };
  return { paired: true, reason: 'same seed per battle index' };
}

/**
 * pairedBootstrap(baseScores, variantScores, B, seed)
 *   Resample BATTLE INDICES with replacement, take both scores from the same index, and look at
 *   the distribution of the mean difference. This is the paired test, and it is the one that
 *   matches the experiment: the two arms played the same games.
 */
function pairedBootstrap(baseScores, variantScores, B, seed) {
  const n = Math.min((baseScores || []).length, (variantScores || []).length);
  if (!n) return null;
  const boot = Math.max(1, B || BOOTSTRAP_B);
  const rnd = mulberry32((seed === undefined ? BOOTSTRAP_SEED : seed) >>> 0);
  const deltas = new Array(boot);
  for (let b = 0; b < boot; b++) {
    let sumV = 0;
    let sumB = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rnd() * n) % n;
      sumV += variantScores[j];
      sumB += baseScores[j];
    }
    deltas[b] = (sumV - sumB) / n;
  }
  deltas.sort(function (x, y) { return x - y; });
  let ahead = 0;
  for (let i = 0; i < deltas.length; i++) if (deltas[i] > 0) ahead++;
  return {
    low: percentile(deltas, 2.5),
    high: percentile(deltas, 97.5),
    median: percentile(deltas, 50),
    aheadShare: ahead / deltas.length,
    resamples: deltas.length
  };
}

/** Unpaired fallback: two independent resamples of each arm's own mean. */
function unpairedBootstrap(baseScores, variantScores, B, seed) {
  const na = (baseScores || []).length;
  const nb = (variantScores || []).length;
  if (!na || !nb) return null;
  const boot = Math.max(1, B || BOOTSTRAP_B);
  const rnd = mulberry32((seed === undefined ? BOOTSTRAP_SEED : seed) >>> 0);
  const deltas = new Array(boot);
  for (let b = 0; b < boot; b++) {
    let sumA = 0;
    let sumB = 0;
    for (let i = 0; i < na; i++) sumA += baseScores[Math.floor(rnd() * na) % na];
    for (let i = 0; i < nb; i++) sumB += variantScores[Math.floor(rnd() * nb) % nb];
    deltas[b] = sumB / nb - sumA / na;
  }
  deltas.sort(function (x, y) { return x - y; });
  let ahead = 0;
  for (let i = 0; i < deltas.length; i++) if (deltas[i] > 0) ahead++;
  return {
    low: percentile(deltas, 2.5), high: percentile(deltas, 97.5), median: percentile(deltas, 50),
    aheadShare: ahead / deltas.length, resamples: deltas.length
  };
}

/**
 * compareToBaseline(base, variant, opts) -> the row the table prints.
 *
 * The verdict is deliberately about SIGNIFICANCE, not about sign:
 *   helps                  the 95% interval on the win-rate delta is entirely above zero
 *   hurts                  entirely below zero
 *   no measurable effect   the interval straddles zero — which is NOT the same as "neutral", and
 *                          is why it is spelled out at this sample size
 * and separately flagged:
 *   stall                  the variant's turn count or stall-tie share moved past its threshold
 *   unpaired               the seeds did not line up, so the interval came from the weaker test
 */
function compareToBaseline(baseSummary, variantSummary, descriptor, opts) {
  const settings = opts || {};
  const d = descriptor || {};
  const boot = settings.bootstrap === undefined ? BOOTSTRAP_B : settings.bootstrap;
  const seed = settings.bootstrapSeed === undefined ? BOOTSTRAP_SEED : settings.bootstrapSeed;
  const pairing = verifyPairing(baseSummary, variantSummary);
  /* Bootstrapped on the WIN indicator, matching `deltaWin` below. The interval must qualify the
   * number it is printed beside; a score-scale interval next to a win-rate delta is two different
   * quantities in one row. */
  const ci = pairing.paired
    ? pairedBootstrap(baseSummary.winScores, variantSummary.winScores, boot, seed)
    : unpairedBootstrap(baseSummary.winScores, variantSummary.winScores, boot, seed);
  const deltaWin = variantSummary.winRate - baseSummary.winRate;
  const deltaScore = variantSummary.meanScore - baseSummary.meanScore;
  const deltaTurns = variantSummary.avgTurns - baseSummary.avgTurns;
  const deltaStall = variantSummary.stallTieShare - baseSummary.stallTieShare;
  /* Stall is about the CHANGE, not the absolute share: a baseline whose own ties stalled would
   * otherwise flag every paired variant as stalling, since they share the same battles. Longer
   * games are the signature being caught — a shorter game with a flat win rate is a different
   * finding (it is reported in the Δturns column, not as a stall). */
  const stallFlag = deltaTurns >= STALL_TURN_DELTA || deltaStall >= STALL_TIMEOUT_SHARE;
  let variantVerdict = 'no effect';
  if (ci && ci.low > 0) variantVerdict = 'helps';
  else if (ci && ci.high < 0) variantVerdict = 'hurts';

  /* THE VERDICT IS ABOUT THE FEATURE, NOT ABOUT THE VARIANT.
   *
   * A feature that is measured by switching it OFF (every laplace/veto/pruner row) improves the
   * variant precisely when it HURTS the engine, so reporting the variant's direction under the
   * feature's name is a sign flip a reader will make the wrong way. `direction` says which way the
   * patch points, and the verdict below is always read as "what does this feature do for us". */
  const direction = d.direction === 'on' ? 'on' : 'off';
  let featureVerdict = 'no measurable effect';
  if (variantVerdict === 'helps') featureVerdict = direction === 'off' ? 'hurts' : 'helps';
  else if (variantVerdict === 'hurts') featureVerdict = direction === 'off' ? 'helps' : 'hurts';
  let verdict = featureVerdict === 'no measurable effect'
    ? 'no measurable effect at this sample size'
    : (featureVerdict === 'helps' ? 'feature HELPS' : 'feature HURTS') +
      ' (' + (direction === 'off' ? 'switching it off' : 'switching it on') + ' ' +
      fmtSigned(deltaWin * 100) + ')';

  /* A surprise is the most valuable row in the table, so it gets its own flag: the author expected
   * this feature to help and a significant interval says it does the opposite (or vice versa). */
  const surprise = !!d.expect && d.expect !== 'neutral' && featureVerdict !== 'no measurable effect' &&
    d.expect !== featureVerdict;

  const flags = [];
  if (surprise) flags.push('surprise');
  if (stallFlag) flags.push('stall');
  if (!pairing.paired) flags.push('unpaired');
  if (variantSummary.errors) flags.push('errors:' + variantSummary.errors);
  /* Only meaningful for a variant that patched something: the baseline is trivially identical to
   * itself, and a variant with no patch is the baseline. */
  if ((d.setArgs || []).length && pairAllIdentical(baseSummary.perBattle, variantSummary.perBattle)) {
    flags.push('identical');
  }
  return {
    id: d.id,
    label: d.label,
    tier: d.tier,
    patch: d.setArgs || [],
    expect: d.expect || null,
    note: d.note || null,
    caveat: d.caveat || null,
    direction: direction,
    variantVerdict: variantVerdict,
    featureVerdict: featureVerdict,
    surprise: surprise,
    battles: variantSummary.battles,
    wins: variantSummary.wins, losses: variantSummary.losses, ties: variantSummary.ties,
    winRate: variantSummary.winRate, lossRate: variantSummary.lossRate, tieRate: variantSummary.tieRate,
    avgTurns: variantSummary.avgTurns, stallTies: variantSummary.stallTies,
    stallTieShare: variantSummary.stallTieShare, errors: variantSummary.errors,
    turnP50: variantSummary.turnP50, turnP90: variantSummary.turnP90,
    turnMax: variantSummary.turnMax, cappedGames: variantSummary.cappedGames,
    meanFaints: variantSummary.meanFaints, meanFaintsAtCap: variantSummary.meanFaintsAtCap,
    baseMeanFaintsAtCap: baseSummary.meanFaintsAtCap,
    deltaWin: deltaWin, deltaScore: deltaScore, deltaTurns: deltaTurns, deltaStall: deltaStall,
    ci: ci, pairing: pairing, verdict: verdict, flags: flags
  };
}

/**
 * summarizeVerdicts(rows) -> the four buckets the brief actually asks for.
 *
 * The per-row verdict already says which is which; this is the answer gathered in one place, so a
 * reader does not have to scan a table for the word "helps". The buckets are not exclusive:
 * a feature can both help and stall, and a stalled feature is worth seeing in both lists.
 */
function summarizeVerdicts(rows) {
  const out = { helps: [], hurts: [], stall: [], surprise: [], noEffect: [], notMeasured: [] };
  (rows || []).forEach(function (r) {
    if (r.id === 'baseline') return;
    if (r.flags.indexOf('failed') !== -1 || r.flags.indexOf('no-baseline') !== -1) {
      out.notMeasured.push(r.id);
      return;
    }
    if (r.featureVerdict === 'helps') out.helps.push(r.id);
    else if (r.featureVerdict === 'hurts') out.hurts.push(r.id);
    else out.noEffect.push(r.id);
    if (r.flags.indexOf('stall') !== -1) out.stall.push(r.id);
    if (r.flags.indexOf('surprise') !== -1) out.surprise.push(r.id);
  });
  return out;
}

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  words.forEach(function (w) {
    if (line && (line + ' ' + w).length > width) { lines.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  });
  if (line) lines.push(line);
  return lines;
}

/**
 * The footnotes the table cannot hold: what a flat row does NOT mean, and which rows changed
 * nothing at all. Both are printed because a table of outcomes is read as a table of effects
 * unless the reader is told which inputs this harness cannot supply.
 */
function renderFootnotes(rows, out) {
  const write = out || console.log;
  const lines = [];
  (rows || []).forEach(function (r) {
    if (!r.caveat) return;
    wrap(r.id + ': ' + r.caveat, 96).forEach(function (l, i) {
      lines.push('  ' + (i === 0 ? '' : '   ') + l);
    });
  });
  const identical = (rows || []).filter(function (r) { return r.flags && r.flags.indexOf('identical') !== -1; });
  if (identical.length) {
    /* Deliberately an OBSERVATION plus the two possibilities, not a diagnosis. An earlier version of
     * this line asserted the cause ("a flag whose input this harness does not supply") and that is
     * only one of the two ways a flag can be flat: `quiescence.blockProtect` is fully wired and
     * proven by tests/quiescence_check.js to block our move and to reproduce the legacy cell when
     * off, and it still changed no decision in 150 arena battles — the input arrives, it just never
     * flips a ranking. Naming the wrong cause is how a flat row becomes a false finding. */
    wrap('FLAT, NOT NEUTRAL — CHECK THE INPUT BEFORE READING THIS AS A RESULT: ' +
      identical.map(function (r) { return r.id; }).join(', ') +
      ' reproduced the baseline in EVERY battle (same winner AND same turn count), so toggling the ' +
      'flag changed no decision at all. That happens two ways: the input the flag reads never ' +
      'arrived in these battles, or it arrived and never changed a ranking. The per-feature notes ' +
      'say which case is KNOWN for the ones where it is known; for the rest, treat a flat row as ' +
      'unresolved rather than as evidence the feature is worthless.', 96).forEach(function (l, i) {
      lines.push('  ' + (i === 0 ? '' : '   ') + l);
    });
  }
  if (!lines.length) return [];
  write('  notes:');
  write(lines.join('\n'));
  return lines;
}

/**
 * renderStallNote(rows) -> the line the DELTA flags cannot print.
 *
 * A stall flag is relative to the baseline, so a corpus where the baseline itself draws a quarter of
 * its games at the turn cap reports "no stalls" on every row. That reading is wrong, and the first
 * sweep was read that way before the numbers were checked: 17 of 60 baseline battles (28.3%) ended
 * tied at the cap, and EVERY tie in every row was a cap tie. An absolute level this high is a
 * property of the engine (and of these three fixed personas), not of any one flag, so it gets its
 * own line rather than being left to a reader's eye on a percentage column.
 */
function renderStallNote(rows, out) {
  const write = out || console.log;
  const base = (rows || []).filter(function (r) { return r.id === 'baseline'; })[0];
  if (!base || !base.battles || !(base.stallTieShare >= STALL_TIMEOUT_SHARE)) return [];
  const allTiesStall = base.ties > 0 && base.stallTies === base.ties;
  const lines = [
    '  BASELINE ALREADY DRAWS AT THE CAP: ' + base.stallTies + ' of ' + base.battles + ' baseline battles (' +
      fmtPct(base.stallTieShare) + ') ended tied at the turn cap' +
      (allTiesStall ? ', which is EVERY tie it played' : '') + '.',
    '  The stall flags below are DELTAS against that, so a row with no flag can still be stalling —',
    '  reading "no stall flag" as "no stalling" is wrong. A variant that converts these ties into',
    '  wins is closing games out; one that does not is drawing them.'
  ];
  write(lines.join('\n'));
  return lines;
}

/**
 * renderTurnShape(rows) -> the turn distribution and how much attrition a capped game had.
 *
 * WHY THIS IS WORTH ITS OWN BLOCK: the first sweep's baseline averaged 54.4 turns, which sounds
 * healthy, while a quarter of its games were actually 100-turn draws. A mean cannot show that. The
 * faints figure then splits the capped games into the two cases that need different fixes — a
 * standoff between two walls (few bodies lost) versus a slow grind that never resolved (many).
 * Only the rows that differ from the baseline are printed, plus the baseline itself.
 */
function renderTurnShape(rows, out) {
  const write = out || console.log;
  const body = (rows || []).filter(function (r) {
    return r.battles && (r.id === 'baseline' || r.turnMax !== undefined);
  });
  if (!body.length) return [];
  const base = body.filter(function (r) { return r.id === 'baseline'; })[0];
  const shown = body.filter(function (r) {
    if (r.id === 'baseline') return true;
    if (!base) return true;
    return r.cappedGames !== base.cappedGames || Math.abs(r.turnP90 - base.turnP90) > 0.5 ||
      r.flags.indexOf('identical') === -1;
  });
  if (!shown.length) return [];
  const lines = ['  turn shape (p50 / p90 / max, and the faints in a capped game out of 12 bodies):'];
  shown.forEach(function (r) {
    lines.push('    ' + pad(clampText(r.label || r.id, 30), 31) +
      pad(r.turnP50.toFixed(0), 5, true) + pad(r.turnP90.toFixed(0), 5, true) +
      pad(r.turnMax.toFixed(0), 5, true) +
      pad('  capped ' + r.cappedGames + '/' + r.battles, 16, true) +
      (r.cappedGames
        ? pad('  faints at cap ' + r.meanFaintsAtCap.toFixed(1) + '/12', 24, true) +
          (r.meanFaintsAtCap <= 6 ? '  -> STANDOFF' : '  -> grind')
        : ''));
  });
  write(lines.join('\n'));
  return lines;
}

function renderVerdicts(groups, out) {
  const write = out || console.log;
  const list = function (a) { return a.length ? a.join(', ') : '(none)'; };
  const lines = [
    '  feature HELPS  (CI excludes 0):  ' + list(groups.helps),
    '  feature HURTS  (CI excludes 0):  ' + list(groups.hurts),
    '  no measurable effect:            ' + list(groups.noEffect),
    '  stalls / longer games:           ' + list(groups.stall)
  ];
  if (groups.surprise && groups.surprise.length) {
    lines.push('  SURPRISED THE AUTHOR (see expect): ' + groups.surprise.join(', '));
  }
  if (groups.notMeasured.length) lines.push('  NOT MEASURED (batch failed):       ' + groups.notMeasured.join(', '));
  lines.push('');
  lines.push('  A verdict is about the FEATURE: "feature HELPS" on a row tested by switching it off means');
  lines.push('  the OFF variant beat the baseline. The \u0394win column is always the raw variant-minus-baseline.');
  write(lines.join('\n'));
}

/* ---------------------------------------------------------------------------------- report */

function renderFeatureList(out) {
  const lines = ['  feature                      tier       patch                                   expect', ''];
  FEATURES.forEach(function (f) {
    lines.push('  ' + pad(clampText(f.id, 28), 29) + pad(f.tier, 11) +
      pad(clampText(patchToSetArgs(f.patch).join(' '), 39), 40) + pad(f.expect, 9));
  });
  (out || console.log)(lines.join('\n'));
}

function renderTable(rows, out) {
  const write = out || console.log;
  const lines = [];
  /*  id/label 30 | W 5 L 5 T 5 | win% 7 | dwin 7 | CI 17 | turns 7 | dturns 7 | stall 7 | verdict */
  lines.push('  ' + pad('variant', 30) + pad('W', 5, true) + pad('L', 5, true) + pad('T', 5, true) +
    pad('win%', 8, true) + pad('loss%', 8, true) + pad('tie%', 8, true) +
    pad('\u0394win', 8, true) + pad('95% CI (\u0394win)', 22, true) +
    pad('turns', 8, true) + pad('\u0394turns', 8, true) + pad('stall%', 8, true) + '  verdict');
  rows.forEach(function (r) {
    const ciText = r.ci
      ? '[' + fmtSigned(r.ci.low * 100) + ', ' + fmtSigned(r.ci.high * 100) + ']'
      : '—';
    const deltaText = r.id === 'baseline' ? '—' : fmtSigned(r.deltaWin * 100);
    const turnText = r.id === 'baseline' ? '—' : fmtSigned(r.deltaTurns);
    const verdict = r.id === 'baseline' ? '(reference)' : (r.verdict + (r.flags.length ? ' [' + r.flags.join(', ') + ']' : ''));
    lines.push('  ' + pad(clampText(r.label, 29), 30) + pad(r.wins, 5, true) + pad(r.losses, 5, true) +
      pad(r.ties, 5, true) + pad(fmtPct(r.winRate), 8, true) + pad(fmtPct(r.lossRate), 8, true) +
      pad(fmtPct(r.tieRate), 8, true) + pad(deltaText, 8, true) + pad(ciText, 22, true) +
      pad(r.avgTurns.toFixed(1), 8, true) + pad(turnText, 8, true) +
      pad(fmtPct(r.stallTieShare), 8, true) + '  ' + verdict);
  });
  write(lines.join('\n'));
}

/* ------------------------------------------------------------------------------------ main */

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error('ablation setup failed: ' + e.message);
    return 2;
  }
  if (opts.help) { printUsage(); return 0; }
  if (opts.list) { renderFeatureList(); return 0; }

  /* The arena needs @pkmn/sim, which the other suites deliberately do not. A clone that runs
   * `npm test` without `npm install` must still verify everything else, so a missing sim is a
   * SKIP with exit 0 that says exactly what was not measured. */
  try {
    require.resolve('@pkmn/sim', { paths: [ROOT] });
  } catch (e) {
    console.log('run_ablation: SKIPPED — @pkmn/sim is not installed.');
    console.log('  The ablation runner drives tools/run_arena.js, which needs the sim.');
    console.log('  `npm install` adds it (@pkmn/sim is a devDependency). Nothing was measured.');
    return 0;
  }

  let ids;
  let variants;
  try {
    ids = resolveFeatureIds(opts.features);
    variants = buildVariants(ids);
    validateFeaturePaths(variants);
  } catch (e) {
    console.error('ablation setup failed: ' + e.message);
    return 2;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ablation-'));
  const started = Date.now();
  const results = [];

  const report = function (line) { if (!opts.quiet) console.log(line); };
  report('ablation: ' + variants.length + ' batch(es) \u00d7 ' + opts.battles + ' battle(s), seed ' + opts.seed +
    ', agent ' + opts.agent + ', parallel ' + opts.parallel);
  report('  ' + (variants.length - 1) + ' feature(s): ' + ids.join(', '));
  report('  arena reports: ' + tmpDir);

  /* A bounded worker pool. Each variant is an independent process with its own seeds, so running
   * them concurrently cannot change any variant's result — it only makes the wall clock bearable
   * at 500 battles a batch. */
  let cursor = 0;
  async function worker(slot) {
    while (true) {
      const mine = cursor++;
      if (mine >= variants.length) return;
      const variant = variants[mine];
      const jsonPath = path.join(tmpDir, variant.id + '.json');
      const run = await runArenaBatch(variant, opts, jsonPath);
      let payload = null;
      let summary = null;
      let failure = null;
      if (run.exitCode !== 0) {
        failure = 'arena exited ' + run.exitCode + ': ' +
          (run.stderr.trim().split('\n').slice(-2).join(' | ') || '(no stderr)');
      } else {
        try {
          payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch (e) {
          failure = 'could not read the arena report: ' + (e && e.message);
        }
      }
      if (!failure && (!payload || !payload.records || !payload.records.length)) {
        failure = 'the arena report carried no battle records';
      }
      /* The integrity check that matters: a patch that did not reach the engine would make this
       * row a baseline-vs-baseline comparison dressed up as a finding. */
      if (!failure && variant.setArgs.length) {
        const echoed = (payload.appliedSets || []).length;
        if (echoed !== variant.setArgs.length) {
          failure = 'the arena applied ' + echoed + ' of ' + variant.setArgs.length +
            ' config flags — this batch would not measure what it claims';
        }
      }
      if (!failure) summary = summarizeRun(payload);
      results[mine] = {
        variant: variant, summary: summary, failure: failure, run: run,
        payload: payload, appliedSets: payload ? payload.appliedSets : null
      };
      const tag = failure ? 'FAILED' : ('W ' + summary.wins + '/L ' + summary.losses + '/T ' + summary.ties);
      report('  [' + (mine + 1) + '/' + variants.length + '] ' + pad(clampText(variant.label, 30), 31) +
        pad(tag, 18) + pad(run.wallSec.toFixed(1) + 's', 9) +
        (summary ? pad('win ' + fmtPct(summary.winRate), 11) + 'turns ' + summary.avgTurns.toFixed(1) : ''));
    }
  }
  const slots = Math.min(opts.parallel, variants.length);
  await Promise.all(Array.from({ length: slots }, function (_, i) { return worker(i); }));

  const baseline = results[0];
  const rows = [];
  if (baseline && baseline.summary) {
    const row = compareToBaseline(baseline.summary, baseline.summary, baseline.variant, opts);
    row.verdict = 'reference';
    row.featureVerdict = 'reference';
    row.variantVerdict = 'reference';
    row.surprise = false;
    row.flags = [];
    row.ci = null;
    row.pairing = { paired: true, reason: 'reference' };
    rows.push(row);
  }
  results.slice(1).forEach(function (entry) {
    if (!entry || entry.failure || !entry.summary) {
      rows.push({
        id: entry ? entry.variant.id : '?', label: entry ? entry.variant.label : '?',
        tier: entry ? entry.variant.tier : '?', patch: entry ? entry.variant.setArgs : [],
        expect: entry && entry.variant.expect, note: entry && entry.variant.note, failure: entry ? entry.failure : 'the batch produced no result',
        battles: 0, wins: 0, losses: 0, ties: 0, winRate: 0, lossRate: 0, tieRate: 0,
        avgTurns: 0, stallTies: 0, stallTieShare: 0, errors: 0,
        deltaWin: 0, deltaTurns: 0, deltaStall: 0, ci: null,
        direction: entry && entry.variant ? entry.variant.direction : 'off',
        variantVerdict: 'not measured', featureVerdict: 'not measured', surprise: false,
        pairing: { paired: false, reason: 'batch failed' },
        verdict: 'not measured', flags: ['failed']
      });
      return;
    }
    if (!baseline || !baseline.summary) {
      // The baseline itself failed, so there is nothing to subtract. The variant's own numbers are
      // still reported — an absolute win rate is not a delta, and pretending otherwise would be.
      const s = entry.summary;
      rows.push({
        id: entry.variant.id, label: entry.variant.label, tier: entry.variant.tier,
        patch: entry.variant.setArgs, expect: entry.variant.expect, note: entry.variant.note,
        battles: s.battles, wins: s.wins, losses: s.losses, ties: s.ties,
        winRate: s.winRate, lossRate: s.lossRate, tieRate: s.tieRate, avgTurns: s.avgTurns,
        stallTies: s.stallTies, stallTieShare: s.stallTieShare, errors: s.errors,
        deltaWin: 0, deltaTurns: 0, deltaStall: 0, ci: null,
        direction: entry.variant.direction,
        variantVerdict: 'not measured', featureVerdict: 'not measured', surprise: false,
        pairing: { paired: false, reason: 'baseline missing' },
        verdict: 'not measured', flags: ['no-baseline']
      });
      return;
    }
    rows.push(compareToBaseline(baseline.summary, entry.summary, entry.variant, opts));
  });

  const elapsedSec = (Date.now() - started) / 1000;
  console.log('');
  console.log('  === ablation: isolated effect of each config flag ===');
  renderTable(rows);
  console.log('');
  renderVerdicts(summarizeVerdicts(rows));
  renderStallNote(rows);
  renderTurnShape(rows);
  renderFootnotes(rows);
  console.log('');
  console.log('  battles per variant: ' + opts.battles + ' | seed: ' + opts.seed + ' | agent: ' + opts.agent +
    ' | max turns: ' + opts.maxTurns + ' | stall = +' + STALL_TURN_DELTA + ' turns or +' +
    Math.round(STALL_TIMEOUT_SHARE * 100) + 'pt stall share vs baseline');
  console.log('  delta is variant minus baseline on the SAME battles; the CI is a ' + BOOTSTRAP_B +
    '-resample paired bootstrap over battles (95% percentile interval)');
  console.log('  "no measurable effect" means the interval straddles zero at this sample size, not that the flag is inert.');
  console.log('  wall clock: ' + elapsedSec.toFixed(1) + 's');

  const failed = rows.filter(function (r) { return r.flags.indexOf('failed') !== -1; });
  if (failed.length) {
    failed.forEach(function (r) { console.error('  FAILED ' + r.id + ': ' + r.failure); });
  }

  if (opts.out) {
    const outPath = path.resolve(process.cwd(), opts.out);
    const payload = {
      generatedBy: 'tools/run_ablation.js',
      generatedAt: new Date().toISOString(),
      options: opts,
      featureIds: ids,
      features: FEATURES.filter(function (f) { return ids.indexOf(f.id) !== -1; }),
      rows: rows,
      verdicts: summarizeVerdicts(rows),
      stallNote: renderStallNote(rows, function () { }),
      turnShape: renderTurnShape(rows, function () { }),
      sharedSeed: opts.seed,
      mode: 'full',
      bootstrap: { resamples: BOOTSTRAP_B, seed: BOOTSTRAP_SEED, paired: true },
      thresholds: { stallTurnDelta: STALL_TURN_DELTA, stallTimeoutShare: STALL_TIMEOUT_SHARE },
      elapsedSeconds: elapsedSec
    };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log('  wrote ' + path.relative(process.cwd(), outPath));
  }

  if (!opts.keepTmp) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* a leftover tmp dir is not a failure */ }
  } else {
    console.log('  kept the per-variant reports in ' + tmpDir);
  }

  if (rows.every(function (r) { return r.flags.indexOf('failed') !== -1; })) {
    console.error('every batch failed — nothing was measured');
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(function (code) {
    process.exitCode = code;
  }).catch(function (err) {
    console.error('ablation crashed:');
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 2;
  });
}

module.exports = {
  main: main,
  parseArgs: parseArgs,
  resolveFeatureIds: resolveFeatureIds,
  buildVariants: buildVariants,
  validateFeaturePaths: validateFeaturePaths,
  patchToSetArgs: patchToSetArgs,
  arenaArgs: arenaArgs,
  summarizeRun: summarizeRun,
  verifyPairing: verifyPairing,
  pairedBootstrap: pairedBootstrap,
  unpairedBootstrap: unpairedBootstrap,
  compareToBaseline: compareToBaseline,
  summarizeVerdicts: summarizeVerdicts,
  renderVerdicts: renderVerdicts,
  renderStallNote: renderStallNote,
  renderTurnShape: renderTurnShape,
  renderFootnotes: renderFootnotes,
  pairAllIdentical: pairAllIdentical,
  renderTable: renderTable,
  renderFeatureList: renderFeatureList,
  mulberry32: mulberry32,
  percentile: percentile,
  FEATURES: FEATURES,
  FEATURE_IDS: FEATURE_IDS,
  DEFAULT_BATTLES: DEFAULT_BATTLES,
  STALL_TURN_DELTA: STALL_TURN_DELTA,
  STALL_TIMEOUT_SHARE: STALL_TIMEOUT_SHARE
};
