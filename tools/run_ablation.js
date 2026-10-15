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
      'do not get to use it in the same cell.',
    /* THE ROW THAT CONTRADICTS ITSELF ACROSS INSTRUMENTS. At the standard sample this tier is the ' +
     * ONE clear HURTS row on the 60-battle MIRROR (switching it off +23.3 win points, 95% CI ' +
     * [+8.3, +38.3]) while the re-anchored PERSONAS arena priced the same tier at HELPS +20.0 ' +
     * [+10.0, +30.0]. Both intervals exclude zero, so the two instruments genuinely disagree and '
     * the tie is left standing rather than resolved by picking the friendlier number. Two things '
     * the reader should do with it: check \u0394score beside \u0394win (a binary win indicator ' +
     * maps a cap tie to 0, so a variant that merely converts losses into 100-turn standoffs can read ' +
     * flat or positive on it while giving up match points), and price the `quiescence-followup-damped` ' +
     * row beside it, which tests the specific mechanism the asymmetry suggests (over-pricing a ' +
     * full-strength Turn-2 boosted hit against a rational opponent). */
    caveat: 'UNDECIDED BETWEEN INSTRUMENTS, NOT RESOLVED: mirror says HURTS +23.3 [+8.3, +38.3], ' +
      'personas say HELPS +20.0 [+10.0, +30.0]. Read the \u0394score column and the ' +
      '`score-split` flag alongside \u0394win here: the score scale (win 1 / tie 0.5 / loss 0) is ' +
      'the one that can see a loss-for-tie trade, which is exactly how `urgency` first read flat on ' +
      'the win indicator while its OFF arm had given up 9.2 points of match score.'
  },
  {
    /* THE DAMPED FOLLOW-UP — the candidate this sweep is asked to accept or reject. The shipped
     * config prices the setup extension's second exchange at FULL strength (`followUpWeight` 1.0);
     * this row applies the damped candidate (0.5) as the VARIANT, so `direction: 'on'` and a HELPS
     * verdict means the damped follow-up beat the shipped full-strength one. It exists because the
     * `quiescence-extendsetup` row measures oppositely on the mirror (-23.3) and on the personas
     * (+20.0), and one mechanism that would explain that asymmetry is over-pricing a full-strength
     * boosted Turn-2 hit against a rational opponent that rarely clicks raw setup into an active
     * threat. */
    id: 'quiescence-followup-damped',
    label: 'quiescence: follow-up x0.5 (on)',
    tier: 'laplace',
    direction: 'on',
    parent: 'quiescence',
    patch: { 'laplace.quiescence.followUpWeight': 0.5 },
    expect: 'helps',
    note: 'On (the variant), the setup extension prices only HALF of its second exchange, so a ' +
      'full-strength Turn-2 boosted hit no longer dominates the cell. Off (the baseline) is the ' +
      'shipped 1.0. The knob scales DAMAGE only: their boost still reaches the leaf, the Speed ' +
      'order is still resolved, and a Belly Drum HP cost is still paid in full.',
    caveat: 'DISARMED, NOT PROVEN: if this row comes back flat the honest reading is that the ' +
      'follow-up weight is not the lever behind the mirror/personas split, NOT that the split is ' +
      'explained. A flat row here means the mirror harm has some other cause and the ' +
      '`quiescence-extendsetup` contradiction is still open.'
  },
  {
    /* THE SECOND ROW WHOSE MEASUREMENT MOVED ITS OWN DEFAULT (the first is `sampler-stratify`).
     * The leaf now ships OFF, so this row turns the block back ON (`direction: 'on'`) and its win
     * rate is the price of pricing their shield correctly. */
    id: 'quiescence-blockprotect',
    label: 'quiescence: protect block (on)',
    tier: 'laplace',
    direction: 'on',
    parent: 'quiescence',
    patch: { 'laplace.quiescence.blockProtect': true },
    expect: 'helps',
    note: 'SHIPS OFF. On (the variant), their Protect blocks our move inside the cell, so the cell is ' +
      'scored as the wasted turn it really is and a lethal bonus does NOT go through a shield. Off ' +
      '(the baseline) is the legacy 1-ply reading, where the matrix credits us the hit the shield ' +
      'would have eaten. The rule the ON arm encodes is real; what measured badly is its price.',
    caveat: 'MEASURED AND THE DEFAULT FLIPPED, on ONE instrument and ONE seed. Personas arena, 60 ' +
      'paired battles, seed 1337: the block-ON arm won 63.3 % (38-11-11) and the block-OFF arm won ' +
      '78.3 % (47-11-2) — \u0394win +15.0 [+6.7, +23.3] and \u0394score +7.5 [+3.3, +11.7], both ' +
      'intervals excluding zero on the same arm, cap games 11/60 -> 2/60. The movement is one SEAT: ' +
      'the `exploiter` persona goes 4-0-11 -> 13-0-2, while anchor is 15-0-0 and chaos 13-2-0 either ' +
      'way. On the mirror the row is `identical` (their shield never lands on a cell where the block ' +
      'flips the choice), so a flat reading THERE is a statement about the opponent, not about the ' +
      'knob — which is why this one is priced on an opponent that actually clicks Protect into us. ' +
      'tests/quiescence_check.js proves the block works whenever it is on, and that switching it off ' +
      'reproduces the legacy 1-ply number exactly.'
  },
  {
    id: 'quiescence-turn2speed',
    label: 'quiescence: turn-2 speed order (off)',
    tier: 'laplace',
    direction: 'off',
    parent: 'quiescence',
    patch: { 'laplace.quiescence.respectTurn2Speed': false },
    expect: 'helps',
    note: 'Off makes both second actions land unconditionally, so "boost, then kill the setup user" ' +
      'and "boost, die to the setup user" are priced the same as "boost, trade". On, turn 2 is ' +
      'ordered by the Speed each body will actually have there (the boost applied, Trick Room and ' +
      'move priority included) and a body that faints first does not act at all.'
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
    /* PRICEABLE NOW, and it was not before. The charge needs the move's accuracy and
     * `LaplaceEngine._accuracyOf` reads `state.moveAccuracy`, which only src/injected.js populates
     * from the client's own `|stacc|` snapshot. The sim emits no such line, so this row used to
     * reproduce the baseline battle for battle at 60 battles a side for a HARNESS reason. The
     * bridge now forwards that frame itself, from the sim's dex — the same data the client's dex
     * carries — so the table is populated and the charge is live. */
    caveat: 'ARRIVED AND NOT DECISIVE HERE: engine_bridge now forwards |stacc| from the sim dex, so ' +
      'the accuracy table is populated and the charge is live — tests/ablation_check.js section 7 ' +
      'pins that end to end. Toggling the flag still changed no battle at 24 a side, but that is now ' +
      'a fact about the CHARGE rather than about a missing input: the sample teams carry almost no ' +
      'sub-100% move worth evaluating, and a 10% penalty on Iron Head or Ruination is too small to ' +
      'flip a top line. Before the frame existed the row was flat for a harness reason — ATTEMPTS.md D1.'
  },
  {
    id: 'clock',
    label: 'opponent clock prior (off)',
    tier: 'clock',
    direction: 'off',
    patch: { 'clock.enabled': false },
    expect: 'neutral',
    note: 'Off keeps their switch replies in the matrix no matter how fast they answered.',
    /* THE MECHANISM, WHICH USED TO MAKE THIS ROW FLAT AND NOW MAKES IT LIVE. `_close()` returns
     * early unless `mySubmitTs` is set, and that is set only by an OUTGOING `/choose` line tagged
     * `kind === 'send'`. The arena's agent answers the sim runner directly, so the boot never saw
     * such a line: the history stayed empty, `label()` stayed 'unknown', and `switchPrior.unknown`
     * of 1.0 is exactly what `clock.enabled = false` does. run_arena now calls noteOutgoing() at
     * the moment it decides, which is when a client sends it. `expect` is left as the prior it was
     * written with (it was a prior about an unmeasurable row) rather than re-fitted to a result. */
    caveat: 'LIVE, BUT ITS INPUT IS NOW DECLARED: the arena sends our own /choose frame, so the ' +
      'clock accumulates real samples. That immediately exposed an artifact — both arena players ' +
      'share one event loop, so the measured lead was ~0 ms, every turn labelled `auto` (0.25), and ' +
      '0.25 is below switchKeepThreshold, which DELETED their switch replies from the matrix for the ' +
      'whole battle. A +28.3 win-point swing first measured here priced that artifact and is ' +
      'retracted. run_arena now DECLARES the opponent pace (`normal` = the identity by default, ' +
      '`--deliberation auto` for a fast one), so a flat row against a neutral opponent is CORRECT — ' +
      'price this tier by declaring a fast or slow opponent, not by expecting the arena to invent ' +
      'one.'
  },
  {
    id: 'realoppswitch',
    label: 'opponent-switch substitution (off)',
    tier: 'laplace',
    direction: 'off',
    patch: { 'laplace.realOppSwitch.enabled': false },
    expect: 'helps',
    note: 'Off restores the 1-ply switch cell: their switch-in is never named, the body that left is ' +
      'reset to 100%, entry hazards are never paid, and our attack lands on the body that left the ' +
      'field. On, the incoming body is resolved and is the body the leaf board is built around.'
  },
  {
    id: 'pricepivots',
    label: 'pivot pricing (off)',
    tier: 'laplace',
    direction: 'off',
    patch: { 'laplace.pricePivots.enabled': false },
    expect: 'helps',
    note: 'Off prices U-turn / Volt Switch / Flip Turn / Chilly Reception / Teleport / Parting Shot ' +
      'as a plain attack: no switch, no Regenerator credit on the body leaving, no snow from Chilly ' +
      'Reception, and no matchup for the body that comes in.'
  },
  {
    id: 'pricerecovery',
    label: 'recovery pricing (off)',
    tier: 'laplace',
    direction: 'off',
    patch: { 'laplace.priceRecovery.enabled': false },
    expect: 'helps',
    note: 'Off scores a healing move as a wasted turn — the body enters the leaf at the HP it had ' +
      'already lost — which is the reading that made Recover look like a free turn for them.'
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
    /* THE PRE-UPGRADE ENDGAME TIER, pinned to the bound it was written against. The tier shipped
     * with `maxAlive` 2 and no chance node; the multi-ply pass widened it to 3 and taught it to
     * price an ambiguous Speed order, and `endgame-3v3` below is that widened tier. Keeping BOTH
     * rows means the pair answers the widening question against one baseline — this row is the old
     * behaviour, that row is the new one — instead of the widening being invisible inside a single
     * enabled-or-not flip. (Its note said "<=2 bodies a side" while the shipped bound had already
     * moved to 3, so the patch now says what the note always claimed.) */
    id: 'endgame',
    label: 'endgame solver, 2-body bound (on)',
    tier: 'inert',
    direction: 'on',
    patch: { 'laplace.endgame.enabled': true, 'laplace.endgame.maxAlive': 2,
      'laplace.endgame.chanceNodes': false },
    expect: 'neutral',
    note: 'Ships inert. On, it runs a bounded alpha-beta search with <=2 bodies a side and an ' +
      'ambiguous Speed order REFUSES the solve. It refuses outside its competence, so on most ' +
      'boards this is expected to be a no-op.'
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
    caveat: 'MEASURABLE NOW, WITH A DECLARED RATING: the band needs the opponent\'s rating, which ' +
      'the protocol carries on `|player|p2|Name|avatar|1480`. Each persona now declares the band its ' +
      'name implies (anchor 1700 / exploiter 1500 / chaos 1100) and sim_runner passes it to the sim, ' +
      'so all three bands are exercised in one sweep. Re-anchored at the standard sample (60 battles ' +
      'a side, seed 1337): it changes how long battles run but not who wins (delta win 0.0), so the ' +
      'band is cheap now and not decisive in this corpus — which, with the baseline at 98.3%, may be ' +
      'the ceiling talking rather than the band. A seat with no rating still leaves the row inert, ' +
      'which is the pre-existing behaviour.'
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
    caveat: 'SAME ARRIVED-NOT-DECISIVE STATE AS VOLATILITY: comeback scales ONLY the volatility ' +
      'charge, so it was 0 x anything while the arena had no accuracy table. engine_bridge now ' +
      'forwards |stacc| and the charge is non-zero, so the multiplier is live — but the charge ' +
      'itself changed no decision at 24 battles a side, so nothing changed here either. This row ' +
      'cannot be decisive until the row it multiplies is.'
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
  },

  /* ========================= the multi-ply horizon upgrades =================================
   *
   * Four tiers added in one pass: a second ply for the payoff matrix, a three-body endgame box, a
   * graded Speed band inside it, stratified worlds, and a quantal-response opponent. Two of them
   * (`beam-2ply`, `nash-qre`) ship OFF and are promoted only by their own row here. One
   * (`endgame-3v3`) ships as a tier that is itself OFF, so its row is the enable. One
   * (`sampler-stratify`) ships ON — its own tests prove what it covers (tests/tuning_check.js §6:
   * six i.i.d. draws from a 7/2/1 pool repeat a set instead of covering the pool) — and is measured
   * the way every shipped-ON tier is, by switching it off.
   */
  {
    id: 'beam-2ply',
    label: 'selective 2-ply beam (on)',
    tier: 'laplace',
    direction: 'on',
    patch: { 'laplace.beam2Ply.enabled': true },
    expect: 'helps',
    note: 'On, the top 3 of our rows are re-priced against the top 3 of their replies by playing the ' +
      'TURN OUT: the knockout resolves a replacement from the world\'s own roster, both sides pay ' +
      'entry hazards, the field timers tick down, and the Turn-2 exchange is read off the resulting ' +
      'board. The tier is a BEAM (3 x 3 x K cells, 54 on the shipped numbers) rather than a tree ' +
      'because 9 x 9 x 6 is ~2,000 ms, and it blends at 0.35 so a cell the second ply cannot speak ' +
      'to is left where the 1-ply matrix put it.',
    caveat: 'MEASURED 2026-10-15 ON TWO SEEDS \u2014 AND IT DID NOT REPLICATE, SO THE DEFAULT ' +
      'DOES NOT MOVE. Seed 1337: beam-ON 61.7 % (37-21-2) against the shipped 41.7 % ' +
      '(25-34-1), \u0394win +20.0 [+3.3, +36.7], \u0394score +20.8 [+4.1, +37.5] \u2014 the gate cleared. ' +
      'Seed 20261016: 45.0 % (27-28-5) against 43.3 % (26-28-6), \u0394win +1.7 [\u221215.0, +20.0], ' +
      '\u0394score +0.8 [\u221216.7, +19.2] \u2014 flat. Seed 1337\'s interval floor (+3.3) is above the ' +
      'second seed\'s point estimate, so the two do not overlap the way a replicated effect ' +
      'would, and the pooled reading is the n = 20 one (+5.0 [\u221230.0, +35.0], “no measurable ' +
      'effect”) at three times the power. The n = 20 “games 8.9 turns shorter” does not hold ' +
      'either (\u22125.5 on one seed, +0.6 on the other). Two standing caveats remain. (1) ' +
      'INSTRUMENT \u2014 the mirror is the instrument most confounded for a DEPTH increase: the ' +
      'variant searches a ply deeper than the FROZEN, SHALLOWER twin it is measured against, ' +
      'so a win here cannot separate “finds better lines” from “outsearches the twin”, and ' +
      '\u00a7J\'s own rule is that a self-play reading is not quotable as strength. (2) COST \u2014 once ' +
      'enabled the beam runs on Pass 1 (the synchronous ranking), 54 cells into a project ' +
      'already ~3x its 10 ms per-turn target, and that trade is unbudgeted. So it stays a ' +
      'live promotion candidate; the decisive runs are a non-self-play instrument (or ' +
      'tools/benchmark_human_match.js on the tactical swap tests/tuning_check.js \u00a75 pins) ' +
      'plus a bench delta. Rerunning --features beam-2ply --mirror --battles 60 on a THIRD ' +
      'seed should precede any flip: one seed is enough to clear this gate and a second is ' +
      'enough to disagree with it.'
  },
  {
    id: 'endgame-3v3',
    label: 'endgame 3v3 + Speed chance node (on)',
    tier: 'inert',
    direction: 'on',
    /* ONE LEAF, because the widened bounds ARE the shipped ones. `maxAlive` 3, 12 branching moves
     * and `chanceNodes` true are what src/config.js carries, so restating them here would be three
     * no-op leaves inside a patch that already flips `enabled` — the table's own no-op guard
     * (tests/ablation_check.js §3) rejects exactly that, and rightly: a leaf printed as a flip that
     * is not one is a lie about what the row did. The pre-upgrade bound is the `endgame` row above,
     * which MOVES those leaves down to 2 / chance-node-off against this same baseline. */
    patch: { 'laplace.endgame.enabled': true },
    expect: 'helps',
    note: 'On, the solver may search a 3v3 / 3v2 / 2v3 board (the shipped bound is maxAlive 3, 12 ' +
      'branching moves and chance nodes on; a mate in 3 on that widened box is ' +
      'pinned in tests/endgame_check.js §6, found in 64 nodes), and an ambiguous Speed order — our ' +
      'exact Speed inside their [floor, ceiling] band — is priced as the weighted expectation over ' +
      'the two orders instead of refusing the whole solve. A MATE IS NEVER CLAIMED THROUGH ONE: a ' +
      'blend that lands inside the mate band is clamped to the top of the non-mate region, so ' +
      '`solved` still means proven.',
    caveat: 'COMPARE AGAINST THE `endgame` ROW, which is the same tier at its pre-upgrade 2-body ' +
      'bound and without the chance node. Either row beating the baseline says the TIER is worth ' +
      'having; the PAIR says whether the widening earned its extra nodes. The widened box is the one ' +
      'place here that can spend the node budget, which is what `maxBranchingMoves` and ' +
      '`nodeBudget` bound — an exhausted budget reports `{solved:false, reason:\'budget\'}` and ' +
      'never a partial line dressed as a solution.'
  },
  {
    /* THE ROW THAT MOVED ITS OWN DEFAULT. This tier was built ON — the coverage argument in its
     * note is a property of the DRAW and provable without a battle — and its first win-rate reading
     * went the other way, so the shipped build now ships the i.i.d. draw and THIS row is the
     * promotion candidate (`direction: 'on'`, patching the leaf UP). That is why the direction is
     * 'on' while every other row in this table that measures a shipped tier is 'off'. */
    id: 'sampler-stratify',
    label: 'stratified active-set worlds (on)',
    tier: 'sampler',
    direction: 'on',
    patch: { 'sampler.stratifyActive': true },
    expect: 'helps',
    note: 'SHIPS OFF. On (the variant), the first min(K, distinct legal sets) worlds cover the ' +
      'opponent\'s distinct legal ACTIVE sets one each, heaviest posterior first, carrying their own ' +
      'posterior weights; the bench and every world past the stratum are drawn from the same seeded ' +
      'stream as before, so a pinned world differs from its i.i.d. twin in the active set and ' +
      'nothing else. Off (the baseline) is K independent draws, which at K = 6 is free to pick the ' +
      'same active set four or five times and miss a 25 %-usage set entirely — and the ACTIVE body ' +
      'is the one every cell of the matrix is priced against. A pinned set must still pass every ' +
      'observation check, so this changes which worlds exist, never which facts are legal.',
    caveat: 'MEASURED, AND THE PROMOTION LOST — which is why the default flipped. Mirror, 20 paired ' +
      'battles, seed 1337, measured with the leaf the other way round (the stratified build was the ' +
      'baseline then): the stratified arm won 40.0 % (8-10-2), the i.i.d. arm won 55.0 % (11-7-2). ' +
      'That is +15.0 win points and +15.0 match points IN FAVOUR OF THE I.I.D. DRAW, CI [0.0, +30.1] ' +
      'on the win indicator and [+2.5, +30.0] on match score — the score interval excludes zero and ' +
      'the win interval\'s floor IS zero, so neither scale supports the tier and one is evidence ' +
      'against it. A re-run of this row now starts from the flipped baseline, so its \u0394win is ' +
      'expected to come back near -15. Two ways to read `identical` here, both needed: on a board ' +
      'whose opponent pool has one legal set per body the row is inert BY CONSTRUCTION (there is ' +
      'nothing to stratify), so a flat reading is not the mechanism being priced, while on a WIDE ' +
      'pool (tests/tuning_check.js §6) the draw provably changes, so flat there is a result. Cost is ' +
      'bounded either way — the same K worlds, the same draws, one replacement per pinned world.'
  },
  {
    id: 'nash-qre',
    label: 'quantal-response opponent (on)',
    tier: 'laplace',
    direction: 'on',
    patch: { 'laplace.nash.qre.enabled': true },
    expect: 'helps',
    note: 'On, the opponent\'s column response inside fictitious play is a LOGIT softmax at ' +
      'temperature `tau` (30 at `lowRating` 1100 and below, decaying linearly to 0 at ' +
      '`highRating` 1850) instead of a hard argmax, so their mix spreads the way a noisy player\'s ' +
      'replies do. OUR side keeps the hard best response, so the worst case we are willing to ' +
      'accept is unchanged: QRE changes what we expect THEM to do, never the bound we play against.',
    caveat: 'NEAR-INERT BY CONSTRUCTION, NOT MERELY UNRATED — verified 2026-10-15, and a rated run ' +
      'cannot rescue it. On the mirror the row is `identical` because that league declares no ' +
      'rating for the persona seat and `_qreTau` resolves an unknown opponent to the hard response ' +
      '(an unknown opponent is not evidence of a noisy one). That is only the smaller half: in the ' +
      'fictitious-play loop the soft column mix is accumulated into the PUBLISHED opponent strategy, ' +
      'while the action each side best-responds to is still the hard argmax — so a temperature ' +
      'provably cannot reach OUR frequency counts on ANY matrix (tests/tuning_check.js §7b). What ' +
      'it moves is the mix the profiler reads next turn and the per-row VALUES; our confidence ' +
      'column, and so the ranking, can move only through the score tie-break among equal ' +
      'frequencies. The personas declare bands inside the ramp (anchor 1700 / exploiter 1500 / ' +
      'chaos 1100), so they are the instrument to read it on — but expect flat, and treat a ' +
      'non-flat persona row as the surprise rather than the confirmation. The question the tier ' +
      'exists to answer is still the one ATTEMPTS.md E5 left open (whether the ~8.3 % the hard ' +
      'solve gave up against the pure softmax is the equilibrium being wrong about PEOPLE); this ' +
      'row as written does not answer it, which is itself the finding.'
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
    '  --agent <a>         all | anchor | exploiter | chaos | mirror (default: all)',
    '  --mirror            Shorthand for --agent mirror: seat the engine against a FROZEN copy of',
    '                      itself. The personas put the baseline at 98.3% with no losses, so the',
    '                      instrument has no headroom; a mirror sits near 50%, where a variant that',
    '                      HELPS is measurable as well as one that hurts (ATTEMPTS.md section H).',
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
      case '--league': opts.agent = String(need(a, argv[++i])).toLowerCase(); break;
      case '--mirror': opts.agent = 'mirror'; break;
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
  if (['all', 'anchor', 'exploiter', 'chaos', 'mirror'].indexOf(opts.agent) === -1) {
    throw new arena.SetupError('--agent must be all, anchor, exploiter, chaos or mirror');
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
       * `score` (win 1 / tie 0.5 / loss 0) is the MATCH-POINT scale, carried for the second,
       * independent interval `scoreCi` in compareToBaseline — never as a substitute for the win
       * interval, because an interval must sit on the same scale as the point estimate it
       * qualifies. (Bootstrapping on score while printing a win-rate delta is how a +15.0 point
       * estimate once came back with a 95% interval of [+1.7, +12.5].)
       *
       * WHY THE SECOND SCALE EXISTS AT ALL: a binary win indicator maps a 100-turn tie to 0, so a
       * change that converts 13 LOSSES into 13 STALL TIES moves it by exactly 0.0 — which is how
       * `urgency` first measured as flat on the win indicator while its OFF variant had given up
       * 9.2 points of match score. The score scale prices that conversion at 13 x 0.5 = +6.5. */
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
    /* The match-point total (win 1 / tie 0.5 / loss 0), so a reader can see the raw ledger the mean
     * is taken over. `matchPoints` is the SUM, `meanScore` the per-battle average. */
    matchPoints: perBattle.reduce(function (a, b) { return a + b.score; }, 0),
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
  /* THE MATCH-POINT INTERVAL, computed beside the win-rate one and reported on its OWN scale.
   * A binary win indicator cannot see a loss converted into a stall tie (both read 0), so a policy
   * that trades losses for ties looks flat on it. The score scale (win 1 / tie 0.5 / loss 0) does
   * see it, and the two intervals disagreeing is itself a finding worth a flag — which is exactly
   * how the `quiescence-extendsetup` contradiction (HELPS on the personas arena, HURTS on the
   * mirror) is meant to be read. Neither scale is dropped: the headline `ci`/`deltaWin` stay on the
   * win indicator, and `scoreCi`/`scoreDelta` are the second opinion beside them. */
  const scoreCi = pairing.paired
    ? pairedBootstrap(baseSummary.scores, variantSummary.scores, boot, seed)
    : unpairedBootstrap(baseSummary.scores, variantSummary.scores, boot, seed);
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
  /* The same significance test on the match-point scale. `scoreVerdict` is the variant's direction
   * there ('helps' | 'hurts' | 'no measurable effect'), and it is reported even when it agrees. */
  let scoreVerdict = 'no measurable effect';
  if (scoreCi && scoreCi.low > 0) scoreVerdict = 'helps';
  else if (scoreCi && scoreCi.high < 0) scoreVerdict = 'hurts';

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

  /* Direction-adjusted match-point verdict, read exactly the way `featureVerdict` is: a feature
   * measured by switching it OFF improves the variant precisely when it HURTS the engine. */
  let featureScoreVerdict = 'no measurable effect';
  if (scoreVerdict === 'helps') featureScoreVerdict = direction === 'off' ? 'hurts' : 'helps';
  else if (scoreVerdict === 'hurts') featureScoreVerdict = direction === 'off' ? 'helps' : 'hurts';
  /* The scales SPLITTING is the signal, not an inconsistency to smooth over: one interval says the
   * feature helps and the other says it hurts. It is flagged rather than resolved, because which
   * instrument is right is a question about the corpus, not about the arithmetic. */
  const scoreSplit = featureVerdict !== 'no measurable effect' && featureScoreVerdict !== 'no measurable effect' &&
    featureVerdict !== featureScoreVerdict;

  /* A surprise is the most valuable row in the table, so it gets its own flag: the author expected
   * this feature to help and a significant interval says it does the opposite (or vice versa). */
  const surprise = !!d.expect && d.expect !== 'neutral' && featureVerdict !== 'no measurable effect' &&
    d.expect !== featureVerdict;

  const flags = [];
  if (surprise) flags.push('surprise');
  if (stallFlag) flags.push('stall');
  if (scoreSplit) flags.push('score-split');
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
    /* The match-point second opinion. `scoreDelta` and `deltaScore` are the same number under two
     * names — `deltaScore` is the pre-existing key and `scoreDelta` is the one the table and the
     * docs use, kept in lockstep so neither drifts. */
    scoreVerdict: scoreVerdict,
    featureScoreVerdict: featureScoreVerdict,
    scoreSplit: scoreSplit,
    scoreDelta: deltaScore,
    scoreCi: scoreCi,
    scoreRate: variantSummary.meanScore,
    baseScoreRate: baseSummary.meanScore,
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
  const out = { helps: [], hurts: [], stall: [], surprise: [], scoreSplit: [], noEffect: [], notMeasured: [] };
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
    if (r.flags.indexOf('score-split') !== -1) out.scoreSplit.push(r.id);
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
  if (groups.scoreSplit && groups.scoreSplit.length) {
    /* The two scales disagreeing about the SAME feature. Printed above the surprise line because
     * it is the more interesting finding: a feature is not flat, it is measuring differently. */
    lines.push('  MATCH-POINT vs WIN-RATE SPLIT:    ' + groups.scoreSplit.join(', ') +
      '  (one interval says HELPS, the other HURTS -- see the \u0394score columns)');
  }
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
  /*  id/label 30 | W 5 L 5 T 5 | win% 7 | dwin 7 | CI 17 | score% 8 | dscore 8 | scoreCI 23 |
   *  turns 7 | dturns 7 | stall 7 | verdict */
  lines.push('  ' + pad('variant', 30) + pad('W', 5, true) + pad('L', 5, true) + pad('T', 5, true) +
    pad('win%', 8, true) + pad('loss%', 8, true) + pad('tie%', 8, true) +
    pad('\u0394win', 8, true) + pad('95% CI (\u0394win)', 22, true) +
    pad('score%', 8, true) + pad('\u0394score', 8, true) + pad('95% CI (\u0394score)', 23, true) +
    pad('turns', 8, true) + pad('\u0394turns', 8, true) + pad('stall%', 8, true) + '  verdict');
  rows.forEach(function (r) {
    const ciText = r.ci
      ? '[' + fmtSigned(r.ci.low * 100) + ', ' + fmtSigned(r.ci.high * 100) + ']'
      : '—';
    const scoreCiText = r.scoreCi
      ? '[' + fmtSigned(r.scoreCi.low * 100) + ', ' + fmtSigned(r.scoreCi.high * 100) + ']'
      : '—';
    const deltaText = r.id === 'baseline' ? '—' : fmtSigned(r.deltaWin * 100);
    const scoreDeltaText = (r.id === 'baseline' || typeof r.scoreDelta !== 'number')
      ? '—' : fmtSigned(r.scoreDelta * 100);
    const scoreRateText = typeof r.scoreRate === 'number' ? fmtPct(r.scoreRate) : '—';
    const turnText = r.id === 'baseline' ? '—' : fmtSigned(r.deltaTurns);
    const verdict = r.id === 'baseline' ? '(reference)' : (r.verdict + (r.flags.length ? ' [' + r.flags.join(', ') + ']' : ''));
    lines.push('  ' + pad(clampText(r.label, 29), 30) + pad(r.wins, 5, true) + pad(r.losses, 5, true) +
      pad(r.ties, 5, true) + pad(fmtPct(r.winRate), 8, true) + pad(fmtPct(r.lossRate), 8, true) +
      pad(fmtPct(r.tieRate), 8, true) + pad(deltaText, 8, true) + pad(ciText, 22, true) +
      pad(scoreRateText, 8, true) + pad(scoreDeltaText, 8, true) + pad(scoreCiText, 23, true) +
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

  /* Validate the request BEFORE asking whether the sim is present. A misspelt feature id is a
   * setup error in every checkout, and the sim guard is a SKIP that exits 0 — so validating after
   * it would let `--features nope` report success on a clone with no `npm install` and fail only
   * where the sim happens to be present. Order matters: the check that can REFUSE must run before
   * the one that can EXCUSE. */
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
    row.scoreCi = null;
    row.scoreVerdict = 'reference';
    row.featureScoreVerdict = 'reference';
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
        deltaWin: 0, deltaScore: 0, scoreDelta: 0, deltaTurns: 0, deltaStall: 0, ci: null, scoreCi: null,
        scoreRate: 0, scoreVerdict: 'not measured', featureScoreVerdict: 'not measured', scoreSplit: false,
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
        deltaWin: 0, deltaScore: 0, scoreDelta: 0, deltaTurns: 0, deltaStall: 0, ci: null, scoreCi: null,
        scoreRate: s.meanScore, scoreVerdict: 'not measured', featureScoreVerdict: 'not measured', scoreSplit: false,
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
  console.log('  delta is variant minus baseline on the SAME battles; each CI is a ' + BOOTSTRAP_B +
    '-resample paired bootstrap over battles (95% percentile interval)');
  console.log('  \u0394win scores a tie 0 (binary indicator) and \u0394score scores it 0.5 (match points, win 1 / tie .5 / loss 0);');
  console.log('  the two are reported side by side because a tie-for-loss trade is invisible to \u0394win alone.');
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
