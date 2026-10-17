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
    id: 'conditionalmoves',
    label: 'conditional-move failure (off)',
    tier: 'laplace',
    direction: 'off',
    patch: { 'laplace.conditionalMoves.enabled': false },
    expect: 'hurts',
    note: 'Off restores the pre-tier pricing, and every cell it restores is a line the game answers ' +
      'with |-fail|: Sucker Punch credits its damage into a predicted switch (where it fails, because ' +
      'the target is not attacking) and into their setup/status click; Fake Out keeps its damage on ' +
      'every turn after its first, although it only works on the first turn out; and a landed Fake ' +
      'Out no longer flinches the reply away, which is the reason to click the move at all on its ' +
      'one legal turn.'
  },
  /* The three sub-knobs, because the tier is three rules rather than one: the attack requirement
   * is a property of THEIR click, the first-turn rule a property of OUR stint, and the flinch a
   * property of the exchange between them. The expectation is the same on each row — switching the
   * rule off should cost wins, because it re-admits a line the game fails. */
  {
    id: 'conditional-suckerpunch',
    label: 'Sucker Punch attack requirement (off)',
    tier: 'laplace',
    direction: 'off',
    parent: 'conditionalmoves',
    patch: { 'laplace.conditionalMoves.suckerPunchRequiresAttack': false },
    expect: 'hurts',
    note: 'Off prices Sucker Punch (and their Sucker Punch) as unconditional damage: its hit lands ' +
      'in the predicted-switch column, into their setup move, into a status click and through a ' +
      'Protect, although the move fails whenever the target does not select an attacking move.'
  },
  {
    id: 'conditional-firstturn',
    label: 'Fake Out first-turn rule (off)',
    tier: 'laplace',
    direction: 'off',
    parent: 'conditionalmoves',
    patch: { 'laplace.conditionalMoves.firstTurnOnly': false },
    expect: 'hurts',
    note: 'Off lets Fake Out / First Impression keep their damage after the body has already acted ' +
      'since it entered, so a move that fails outside its one legal turn out is priced as a normal ' +
      'attack on every turn of the stint.',
    caveat: 'INERT HERE BY CONSTRUCTION: none of the six sample teams carries Fake Out or First ' +
      'Impression, so the engine seat never holds one to fail and this row cannot move until a ' +
      'team that carries the move is added. The Sucker Punch sibling DOES have a corpus (Kingambit ' +
      'is on hazardStackBalance and voltTurnOffense).'
  },
  {
    id: 'conditional-flinch',
    label: 'Fake Out flinch (off)',
    tier: 'laplace',
    direction: 'off',
    parent: 'conditionalmoves',
    patch: { 'laplace.conditionalMoves.flinch': false },
    expect: 'hurts',
    note: 'Off charges the reply a landed Fake Out really takes away: the flinched body does not act ' +
      'at all, so its damage, its setup boost and its Turn-2 follow-up are all priced against us. ' +
      'The arrow points the other way from the two rows above — this rule RE-PRICES a line UP.',
    caveat: 'INERT HERE BY CONSTRUCTION, for the same reason as `conditional-firstturn`: it prices ' +
      'a move no sample team carries. The mechanism IS pinned off-battle in ' +
      'tests/conditional_check.js (§6).'
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
    id: 'pricemymoveeffects',
    label: 'own-move leaf effects: setup + hazards (on)',
    tier: 'laplace',
    direction: 'on',
    patch: { 'laplace.priceMyMoveEffects.enabled': true },
    expect: 'helps',
    note: 'SHIPS OFF. On, our own setup moves (the 29 SETUP_MOVES in src/util.js) stamp their stat ' +
      'stages and HP cost onto the leaf board and into that turn\'s defensive calculation, and our ' +
      'hazard-setting / hazard-clearing moves write their layer change onto a shallow copy of the ' +
      'leaf field. Off (the shipped default) leaves those channels unchanged on the leaf.',
    caveat: 'MEASURED NULL ON ITS WIN-RATE GATE, so it still ships OFF and the expectation above ' +
      'is a pre-registration the run did not confirm. The gate §P6 asked for was run at 60 paired ' +
      'battles per instrument, seed 1337: personas 83.3% baseline against 80.0% (delta win ' +
      '-3.3 [-11.7, +5.0], delta score -2.5 [-10.0, +4.2]) and the mirror of itself 48.3% against ' +
      '46.7% (delta win -1.7 [-16.7, +11.7], delta score -4.2 [-18.3, +9.2]). Both point ' +
      'estimates are NEGATIVE and both intervals straddle zero, so the honest label is the tool\'s ' +
      'own "no measurable effect at this sample size" and not a defined loss; a re-proposal needs ' +
      'a stronger instrument or 500 battles, not another 60-battle run. Its POLICY-FIDELITY ' +
      'reading is real and is where the tier bites: on a paired 200-battle replay of the same ' +
      'corpus, top-1 agreement 34.6%->36.9%, the median regret share on MOVE clicks 0.008->0.001, ' +
      '30%+ give-ups 35.3%->33.6%, and on the families it writes, setup 46.6%->66.7% ' +
      '(excess over its own uniform floor -17.1 -> +2.9) and hazard clear 41.2%->61.3% — all at ' +
      'McNemar 240 fixed / 136 broken, chi2 28.2, p < 0.001. That gain simply does not convert ' +
      'into wins at this sample (ATTEMPTS.md §P6 and §P7). One trap to name: the ' +
      'rated ROWS are not the leaf. With laplace.nash live, laplace_core.js:3059 publishes ' +
      'live[k].score = nash.rowValues[k], so this tier perturbs rows it never touched through the ' +
      'equilibrium (91.0% of unmodelled move rows and 87.4% of switch rows are unchanged; the rest ' +
      'move by a median of 0.00 and a p95 of 0.35/3.86). The row-LOCAL contract is checked on ' +
      '_payoff instead, in tests/tuning_check.js section 4d. What this row does NOT do: status moves ' +
      'and item removal still write nothing to the leaf, and status_inflict is the worst category in ' +
      'the 200-battle slice (-24.7 pp against its own uniform floor) — ATTEMPTS.md §P6.'
  },
  {
    /* THE TWO REMAINING OWN-MOVE LEAF FAMILIES, each its own switch and its own row.
     *
     * They are separate tiers rather than sub-knobs of `pricemymoveeffects` on purpose: that row
     * is a published measurement of one scope (setup boosts + hazard set/clear), and folding a new
     * channel into it would silently redefine the experiment every time the bigger one is re-run.
     * A row here is one boolean flip from the shipped config, which is what the table's own no-op
     * guard (tests/ablation_check.js section 3) requires. */
    id: 'pricemymovestatus',
    label: 'own-move leaf effects: OUR status moves (on)',
    tier: 'laplace',
    direction: 'on',
    patch: { 'laplace.priceMyMoveStatus.enabled': true },
    expect: 'helps',
    /* THE ROW DECLARES ITS CORPUS. The shipped engine seat plays `hazardStackBalance`, which has no
     * status-inflicting move, so this tier cannot fire there and its gate read `[identical]` in all
     * 60 battles (ATTEMPTS.md §P7). `stallCore` carries Toxic and Protect on the same bodies, which
     * is the position this row needs; the field is a property of the RUN, so resolveRunTeam forces
     * the baseline onto the same team rather than pairing two different games. */
    team: 'stallCore',
    note: 'SHIPS OFF. On, our own status-Inflicting move (the PRIMARY effect of the move, per ' +
      'U.STATUS_MOVES: Thunder Wave, Will-O-Wisp, Toxic, Spore, Glare, Stun Spore, Nuzzle, Zap ' +
      'Cannon, Inferno, ...) writes that condition onto THEIR leaf body, refused whenever the board ' +
      'says it cannot land (the body is already statused; the type chart or U.immunityReason ' +
      'nullifies the move — Thunder Wave into a Ground body, Will-O-Wisp into a Flash Fire one; ' +
      'U.STATUS_TYPE_IMMUNITY makes it impossible for the type — Electric bodies cannot be ' +
      'paralysed, Fire bodies cannot burn; the move is a powder and the body is Grass; or a ' +
      'REVEALED ability is on the immunity list). Off leaves the status dims (24..35, 117) ' +
      'identical across every candidate row.',
    caveat: 'SHIPS OFF, AND §C4\'S GATE CAME BACK [identical] — THIS ROW IS STRUCTURALLY ' +
      'UNMEASURABLE ON THE ARENA INSTRUMENT. 60 paired mirror battles on seed 1337 reproduced the ' +
      'baseline in EVERY battle (same winner AND same turn count; delta win +0.0 [+0.0, +0.0], the ' +
      'flag \'[identical]\'), and the cause is checkable rather than a question of sample size: ' +
      'run_arena hard-codes the ENGINE seat\'s team to `hazardStackBalance`, whose 24 moves carry ' +
      'no status-inflicting move, and this tier writes only OUR OWN move\'s leaf transition — so ' +
      'the switch has nothing to price and no decision can move. Re-running this command reproduces ' +
      'the same silence; what has to change first is the engine-seat team (the persona-side ' +
      '`stallCore` carries Toxic, but it is the wrong SEAT), or the sample size stays irrelevant. ' +
      'THE FIDELITY READING IS UNTOUCHED and is the only reading this tier has: paired 200 ' +
      'battles, STATUS INFLICTION\'s top-1 31.4%->41.8% and its median gap ' +
      '60.9->55.5, with the gap POPULATION rising 96->106 (rows move INTO the slice as the region ' +
      'the human was clicking in is lifted) and neither family crossing its own uniform floor yet ' +
      '(ATTEMPTS.md §P7). The measurement it was written against is a policy-fidelity one: in the ' +
      '200-battle move-half slice, STATUS INFLICTION is the worst family in the whole population — ' +
      'top-1 31.4 % against its own uniform floor of 56.1 % (excess -24.7 pp) on 366 decisions, ' +
      'median score gap 60.9 against a pure attack\'s 7.5, and 96 of the 1,550 gap decisions ' +
      '(ATTEMPTS.md §P6). That is the signature of a channel the leaf never carried rather than of ' +
      'a weight, which is what this tier writes. NOT MODELLED, so a positive reading is a lower ' +
      'bound and a flat one is not proof of worthlessness: ACCURACY (a 90 % Thunder Wave and a ' +
      '60 % Hypnosis both write a landed condition, because a board cannot carry a fraction of a ' +
      'status), secondary-effect riders (Body Slam\'s 30 % paralysis is not a status move), and ' +
      'Safety Goggles / Overcoat as powder shields, neither inferable from a revealed board.'
  },
  {
    id: 'pricemymoveprotect',
    label: 'own-move leaf effects: OUR Protect (on)',
    tier: 'laplace',
    direction: 'on',
    patch: { 'laplace.priceMyMoveProtect.enabled': true },
    expect: 'helps',
    /* Same corpus as its sibling row, for the same reason: a team with no shield cannot price one. */
    team: 'stallCore',
    note: 'SHIPS OFF. On, OUR own Protect is priced as the shield it is: their reply deals nothing ' +
      'in the cell, and the leaf carries the Protect rhythm (dims 126/127) the live state would ' +
      'carry next turn. Off prices a Protect as a turn on which we did nothing and took their best ' +
      'attack in full. The rule the ON arm encodes is two-sided: a CONSECUTIVE Protect FAILS (the ' +
      'same rule veto 9 encodes, exempted the same way when a Taunt/Encore means the last one never ' +
      'went off) and is priced as the wasted turn it is, and a reply that pierces a shield (Feint, ' +
      'Phantom Force, Shadow Force, Hyperspace Fury / Hole) is not blocked. A shield does NOT stop ' +
      'their SETUP: a Dragon Dance still buys its boost and its modelled Turn-2 extension, which ' +
      'lands after this cell.',
    caveat: 'SHIPS OFF, AND §C4\'S GATE CAME BACK [identical] — THIS ROW IS STRUCTURALLY ' +
      'UNMEASURABLE ON THE ARENA INSTRUMENT. 60 paired mirror battles on seed 1337 reproduced the ' +
      'baseline in EVERY battle (same winner AND same turn count; delta win +0.0 [+0.0, +0.0], the ' +
      'flag \'[identical]\'), and the cause is checkable rather than a question of sample size: ' +
      'run_arena hard-codes the ENGINE seat\'s team to `hazardStackBalance`, whose 24 moves carry ' +
      'NO Protect-FAMILY move at all, and this tier writes only OUR OWN move\'s leaf transition — ' +
      'so the switch has nothing to price and no decision can move. Re-running this command ' +
      'reproduces the same silence; what has to change first is the engine-seat team (the ' +
      'persona-side `stallCore` is Protect on everything, but it is the wrong SEAT), or the sample ' +
      'size stays irrelevant. THE FIDELITY READING IS UNTOUCHED and is the only reading this tier ' +
      'has: paired 200 battles, the Protect family\'s top-1 35.9%->47.3% and its median gap ' +
      '83.5->65.0 with McNemar 90 fixed / 22 broken over the move half (ATTEMPTS.md §P7). The ' +
      'measurement it was written against: Protect is the SINGLE LARGEST ' +
      'contributor to the 200-battle move-half score gap (20.4 % of the summed per-decision gap), ' +
      'with top-1 35.9 % against its own floor of 52.8 % (excess -16.9 pp) and a median gap of 83.5 ' +
      'against a pure attack\'s 7.5, and it did not move by one decimal when the setup/hazard half ' +
      'of the same idea was switched on (ATTEMPTS.md §P6). NOT MODELLED: the halving success rate ' +
      'of a repeat Protect is read as a failure rather than as a probability, and a one-ply cell ' +
      'has no decay — the shield says nothing about what their NEXT turn does with the turn it ' +
      'bought (§L1).'
  },
  {
    id: 'rollkobranch',
    label: 'KO branching on the exact 16 rolls (on)',
    tier: 'laplace',
    direction: 'on',
    patch: { 'laplace.rollKoBranch.enabled': true },
    expect: 'helps',
    note: 'SHIPS OFF. `_payoff` moved the target by `avgPercent` — the MEAN of the 16 damage rolls — ' +
      'and clamped at 0, so a move whose mean is 101 % was priced as a CERTAIN OHKO the target never ' +
      'answers from, while a mean of 97 % left it at 3 % with its reply landing in full. That step is ' +
      'an artefact of collapsing sixteen outcomes into one number: 10 of 16 rolls may reach in the ' +
      'first case and 6 of 16 in the second. On, `_koTransition` replaces it with the EXPECTATION ' +
      'over the two outcomes, `(1 - p) * survives`, with p read from `koChanceExact` (the exact share ' +
      'of rolls that reach the current HP) and the surviving branch floored so a 15-of-16 roll does ' +
      'not read as a KO. Where the roll set cannot answer exactly, or `p` is 0 or 1, the scalar path ' +
      'is kept — so the two arms are bit-identical on every cell that was never ambiguous.',
    caveat: 'SHIPS OFF ON A WIN-RATE GATE — UNRUN, so the expectation above is a PRIOR. ITS ' +
      'COUNTERFACTUAL IS ALSO PARTIAL BY CONSTRUCTION and that has to be read before any number is: ' +
      'the formula it implements is deliberately NOT `p * V_KO + (1 - p) * V_survive`. That form ' +
      'needs its KO branch to mean "the target never answers", which needs to know we move FIRST, and ' +
      '`_payoff` has to ask for. It does: the ordering half reads `_turnOrder` (priority, then Speed ' +
      'through Trick Room — the check the setup extension and the pivot tier already use) and, when ' +
      'the faster side\'s hit has a FRACTIONAL exact chance `p` of fainting the slower one before it ' +
      'moves, scales the slower side\'s damage by `(1 - p)`. A tie and the endpoints `p` 0 and 1 keep ' +
      'the symmetric pricing, so no cell claims a turn the board cannot establish and every cell that ' +
      'was never ambiguous is bit-identical to the shipped build. What the tier removes is ' +
      'measurable without a battle: the discontinuity and both endpoints, pinned in ' +
      '`tests/quiescence_check.js` §KO. Not modelled either: accuracy (a 90 % move and a 60 % one ' +
      'both use their own roll set, but a MISS is not a roll), and the secondary riders of the same ' +
      'move.'
  },
  {
    id: 'choicephysics',
    label: 'Choice lock physics, both directions (off)',
    tier: 'laplace',
    direction: 'off',
    patch: { 'laplace.choiceLock.enabled': false },
    expect: 'helps',
    note: 'SHIPS ON (a game rule, not a preference). Off prices a Choice-locked opponent as if they ' +
      'could click their whole list — the lock is real and the board proves it whenever the stint ' +
      'has already revealed a move — and stops charging US for locking ourselves into a move a ' +
      'living bench body is 0x immune to.'
  },
  {
    id: 'choicephysics-opplock',
    label: 'their Choice lock in the sampled worlds (off)',
    tier: 'laplace',
    direction: 'off',
    parent: 'choicephysics',
    patch: { 'laplace.choiceLock.oppLock': false },
    expect: 'helps',
    note: 'Off leaves their whole move list standing as a reply in worlds where their item and their ' +
      'revealed stint move prove the lock, so the matrix prices clicks the game will refuse.'
  },
  {
    id: 'choicephysics-risk',
    label: 'our Choice-lock risk (off)',
    tier: 'laplace',
    direction: 'off',
    parent: 'choicephysics',
    patch: { 'laplace.choiceLock.riskPenalty': 0 },
    expect: 'helps',
    note: 'Off makes locking ourselves in free: clicking a move while holding Choice commits us to it ' +
      'against whatever comes in, and the switch to a body that is 0x immune is the way that ' +
      'commitment is punished.'
  },
  {
    id: 'pruner-synergy',
    label: 'team-preview synergy prior (off)',
    tier: 'pruner',
    direction: 'off',
    patch: { 'pruner.synergy.enabled': false },
    expect: 'neutral',
    note: 'Off ignores their six names: a Drizzle/Drought body no longer lifts their weather sets, a ' +
      'Trick Room setter no longer lifts the slow breakers, and a revealed Stealth Rock no longer ' +
      'cuts the redundant Rock sets on the other five slots.',
    caveat: 'UNMEASURED. This is a PRIOR on the candidate pool, and its effect is bounded by the hard ' +
      'deductions it cannot override — a real delta would mean the pool was already wide enough for ' +
      'the prior to change a ranking, and zero means the corpus never disagreed with it. Pinned ' +
      'off-battle on both sides in `tests/scout_check.js` §7b instead of being claimed here.'
  },
  {
    id: 'threatspeedgate',
    label: 'threat matrix speed gate, softened (on)',
    tier: 'evaluator',
    direction: 'on',
    patch: { 'evaluator.threatSpeedGate.enabled': true },
    expect: 'helps',
    note: 'SHIPS OFF. On, dims 76..111 stop being exactly 0 for a body that is not strictly ' +
      'faster: the binary `mySpeed >= oppSpeed` term becomes a linear decay from 1 at parity to ' +
      '`floor` over `span` Speed points (the section\'s own `span: 400`, the same number as ' +
      '`evaluator.speedEdgeSpan`, which the macro dims use). Off (the shipped default) is the ' +
      'cliff — 0 at a tie as well as a hundred ' +
      'points behind. At `floor: 0` the soft form is a strict generalisation of the shipped one: ' +
      'bit-identical for every faster body.',
    caveat: 'REJECTED ON ITS OWN MEASUREMENT — ships OFF, and this row\'s ON arm is the WEAKER half ' +
      'of that reading, because a soft gate is a different column and the shipped weights were ' +
      'fitted on the GATED one. What the row alone measures (gate on, shipped weights): 200 paired ' +
      'battles, top-1 34.6%->35.0% (+-0.9), move-vs-move 33.7%->34.1%, move top-1 64.8%->64.9%, ' +
      'McNemar 25 fixed / 19 broken, chi2 0.57, p >= 0.1, and the move-half median gap moving the ' +
      'WRONG way (34.9->36.2) — a NULL. What rejects it is the REFIT the row implies: the corpus ' +
      'extracted twice (reproduce with `node tools/extract_training_data.js --input ' +
      'corpus/replays.json --set evaluator.threatSpeedGate.enabled=true`) and fitted twice gives a ' +
      'hold-out AUC of 0.7105 -> 0.6971, delta -0.0134 [-0.0262, -0.0012] over a battle-level ' +
      'paired bootstrap (1.3% of resamples positive). ATTEMPTS.md §P8, including the artifact ' +
      'staleness the same pass found: the fresh OFF fit scores 0.7105 with 2 clamped low-support ' +
      'dims against the shipped 0.7011 with 8.'
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
      '`solved` still means proven. THE 2026-10-15 HARDENING PASS IS IN THIS ROW TOO, so this enable ' +
      'is what prices it: a turn is now solved as a SIMULTANEOUS matrix (the opponent no longer ' +
      'reads our hidden turn-t action — the old `max_i min_j` was a Stackelberg floor), recovery ' +
      'moves and Protect are ACTIONS rather than free turns (a shield only while the chain is ' +
      'broken), replacements PAY entry hazards and Trick Room\'s timer ticks down mid-tree, ' +
      'transposed boards are memoised, and `solveAcrossWorlds` refuses to call a mate a mate when ' +
      'one surviving world refutes it. Five leaves, `laplace.endgame.*`, all pinned in ' +
      'tests/endgame_check.js §7 — and all shipping ON, which is why this row still flips exactly ' +
      'one leaf.',
    caveat: 'COMPARE AGAINST THE `endgame` ROW, which is the same tier at its pre-upgrade 2-body ' +
      'bound, without the chance node AND with the five hardening leaves at their pre-pass values ' +
      '(`tests/endgame_check.js` §7 switches each one); so the pair separates the WIDENING from the ' +
      'CORRECTIONS. Either row beating the baseline says the TIER is worth having; the pair says ' +
      'which half earned its nodes. The widened box is the one place here that can spend the node ' +
      'budget, which is what `maxBranchingMoves` and `nodeBudget` bound — an exhausted budget reports ' +
      '`{solved:false, reason:\'budget\'}` and never a partial line dressed as a solution. NOT YET ' +
      'MEASURED 2026-10-15 (ATTEMPTS.md §M1) AND THE ROW IS A NULL INSTRUMENT BY CONSTRUCTION: the ' +
      'tier publishes a readout (`lastReadout.endgame`) that nothing in the ranking path reads, so 60 ' +
      'paired battles came back `identical` — the only result this instrument can produce — at a +31 % ' +
      'wall-clock cost (707.4 s against the co-scheduled baseline\'s 540.9 s; after the ' +
      '`solveAcrossWorlds` wiring the same pair is 969.6 s against 625.0 s, +55 %, and still ' +
      '`identical`). It therefore cannot ' +
      'price the corrections — it is a NULL INSTRUMENT: the tier published a readout and NOTHING in ' +
      'the ranking path read it. That is fixed by `laplace.endgame.promoteMate` (ON for this row, new ' +
      'with the §N pass): a report carrying `solved && isMate` now takes the top line, so this row ' +
      'measures the TIER rather than only its expense, and the §7 pins remain the correctness ' +
      'evidence — ' +
      'which is a correctness argument and not a win-rate one, and a search that is more honest can ' +
      'easily rank lower. Read the row before quoting it.'
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
      'replies do. OUR side best-responds to that MIXTURE (fixed 2026-10-15): the mix we publish is ' +
      'the best response to a noisy opponent rather than the minimax-safe one for the true matrix, ' +
      'and `laplace.nash.exploitBlend` is the weight on the advantage that opens up.',
    caveat: 'THE CEILING THIS ROW WAS STUCK UNDER WAS REMOVED ON 2026-10-15 (ATTEMPTS.md §N1). It was ' +
      'NEAR-INERT BY CONSTRUCTION and a rated run could not rescue it: the soft column mix was ' +
      'accumulated into the PUBLISHED opponent strategy while the action each side best-responded to ' +
      'was still the hard argmax and OUR cumulative payoff read that index, so a temperature ' +
      'provably could not reach our own frequency counts on ANY matrix (§L2, then pinned in ' +
      'tests/tuning_check.js §7b). Our step now reads the mixture, so tau reaches our frequencies ' +
      'and this row can move a ranking. Two things still make it flat in practice and both are ' +
      'expected: the mirror declares no rating for the persona seat and `_qreTau` resolves an unknown ' +
      'opponent to the hard response (an unknown opponent is not evidence of a noisy one), and tau ' +
      'only bites on boards where our rows are close — against a strictly dominant row (a 4x move ' +
      'into the body in front of us) a pure equilibrium is immune to every opponent model. The ' +
      'personas declare bands inside the ramp (anchor 1700 / exploiter 1500 / chaos 1100), so they ' +
      'are the instrument to read it on. The question the tier exists to answer is still the one ' +
      'ATTEMPTS.md E5 left open (whether the ~8.3 % the hard solve gave up against the pure softmax ' +
      'is the equilibrium being wrong about PEOPLE), and this row now tests it from the side that ' +
      'can actually move.'
  },
  {
    /* PHASE 2 OF THE 2026-10-15 PASS. The simultaneous matrix is built over the opponent\'s FULL
     * reply list, which means the equilibrium already knows about our unrevealed coverage move and
     * leaves the punished column alone — telepathically, because on the ladder they have not seen
     * us click it. This row prices removing that knowledge. */
    id: 'surprise-mask',
    label: 'unrevealed coverage baiting (on)',
    tier: 'laplace',
    direction: 'on',
    patch: { 'laplace.surpriseMask.enabled': true },
    expect: 'helps',
    note: 'On, the OPPONENT\'s half of the solve reads a COPY of the payoff matrix in which a row ' +
      'for an unrevealed, non-STAB move of ours is blended toward our best revealed-or-STAB row at ' +
      '`unrevealedWeight` (0.35), and it is that copy the opponent best-responds to. OUR rows are ' +
      'still scored on the true matrix against the mix that produces, and our own frequencies still ' +
      'best-respond to the real game — so the tier can only change what we expect THEM to do. ' +
      'tests/tuning_check.js §8 pins the classification (unrevealed AND non-STAB — a STAB move is ' +
      'readable off the species, so pricing it is not telepathy), the cell-by-cell blend, and a ' +
      'fixture board where an unrevealed 4x Ice lure makes their pivot frequency RISE and the lure\'s ' +
      'true value with it.',
    caveat: 'MEASURED TWICE. 2026-10-15 (ATTEMPTS.md §M2), BEFORE the opponent-model loop was ' +
      'fixed: 60 paired battles, seed 1337, all four seats — 73.3 % (44-8-8) against the baseline\'s ' +
      '78.3 % (47-11-2), Δwin −5.0 [−15.0, +6.7], Δscore +0.0 [−6.7, +8.3], cap ties 3/60 → 9/60, ' +
      'flagged `stall`. Three wins and three losses became 100-turn standoffs, so it ships ' +
      '`enabled: false`. RE-MEASURED after the loop was fixed (§N1) on the same flags and seed. The ' +
      'old reading has to be read as suspect for a structural reason, not a statistical one: the ' +
      'loop fed OUR step the true columns while publishing the masked ones, so before the fix the ' +
      'masking could not reach a ranking at all — the `stall` cluster and the `identical`-class ' +
      'inertness of the neighbouring rows are the same defect read twice. Two things to watch when ' +
      'it is. (1) ' +
      'The tier\'s benefit is anti-correlated with how much of our set they have already seen: on a ' +
      'board where every move we hold is revealed it is inert by CONSTRUCTION (there is no surprise ' +
      'row to mask), which means a mirror reading understates it — the mirror\'s own lead sets are ' +
      'fully revealed from turn 1. (2) The blend is a MODEL of what they believe and not a ' +
      'measurement of it: 0.35 is a prior, and the honest instrument is a persona whose reply space ' +
      'is narrow enough that dodging is the whole decision (the Kingambit-in-front-of-Landorus-T ' +
      'fixture in §8 is built that way). A flat mirror row is therefore expected and is not evidence ' +
      'against the mechanism; a NON-flat one is the surprise.'
  },
  {
    /* PHASE 3 OF THE SAME PASS — AND THE ONE ROW THAT MOVED ITS OWN DEFAULT (2026-10-15, §N). E5
     * priced turning the hard solve OFF at +8.3 %, which read as the equilibrium over-defending
     * against bluffs nobody makes: fictitious play gives every one of their actions the same ZERO
     * credibility at round 0. The first reading was `identical`, because the loop fed OUR step the
     * opponent's hard argmax index while their published strategy accumulated the mixture — the
     * tier was one-way by construction (§L2). With that fixed, the tier WON on two seeds, so the
     * shipped default is now `enabled: true` and THIS row is the price of switching it back off. */
    id: 'nash-prior',
    label: 'prior-anchored regret matching (off)',
    tier: 'laplace',
    direction: 'off',
    patch: { 'laplace.nash.priorAnchored.enabled': false },
    expect: 'helps',
    note: 'OFF (the variant) runs the pre-adoption solve: their response inside the loop is the ' +
      'hard argmax of their cumulative payoff, their published mix is the empirical count of that ' +
      'response, and OUR step best-responds to a hard index. ON (the baseline this row is compared ' +
      'against, and the shipped build since 2026-10-15) anchors their response to a behavioral ' +
      'prior: their mix is `(1 - c) * regretMatch + c * P_prior` with c = `priorWeight` (0.25), the ' +
      'regret measured against the value of the mixture they are currently playing, and `P_prior` ' +
      'normalized from MEASUREMENTS only — each damaging move\'s average percentage into our active, ' +
      'a setup weight that depends on whether our active can 2HKO them, and a switch baseline that ' +
      'jumps to `switchEscape` when their active faces a guaranteed OHKO from a REVEALED/STAB move ' +
      'of ours and the incoming body resists it. `priorWeight: 0` and `prior` absent both resolve ' +
      'to the historical hard loop step for step, which tests/tuning_check.js §7b pins on three ' +
      'matrices and §9 pins on a fixture where the hard solve zeroes three of their replies and the ' +
      'anchored one weights all of them.',
    caveat: 'ADOPTED 2026-10-15 — and it is the FIRST two-seed replicate in this table (ATTEMPTS.md ' +
      '§N). Three readings, all mirror, 60 paired battles, 0 errors. BIT-INERT BEFORE THE FIX: ' +
      'seed 1337 was 78.3 % (47-11-2), Δ +0.0, `identical` — the tier ENGAGED (its mix is ' +
      'published on the readout at the pinned weight) and changed no decision, which was §L2\'s ' +
      'ceiling rather than a statement about the prior. AFTER the loop was fixed: seed 1337, ' +
      'baseline 41.7 % (25-34-1) against 63.3 % (38-17-5), Δwin +21.7 [+5.0, +36.7], Δscore +25.0 ' +
      '[+8.3, +40.0], turns +0.8; seed 20261016, baseline 43.3 % (26-28-6) against 68.3 % ' +
      '(41-15-4), Δwin +25.0 [+8.3, +41.7], Δscore +23.3 [+8.3, +38.3], turns −9.6 and cap ties ' +
      '7/60 -> 5/60. Both intervals exclude zero on BOTH scales, in the same direction, with no ' +
      'stall flag on either seed — which is the two-seed agreement §L3 says a mirror row needs ' +
      'before it can be quoted. NOT ESTABLISHED: the win is against a FROZEN COPY OF THIS ENGINE, ' +
      'so it prices a policy change in self-play and not a ladder improvement; the personas arena ' +
      'cannot check the direction because its baseline sits at 98.3 % with no headroom (§H), so ' +
      'the transfer question needs an instrument this repository does not have offline; and ' +
      '`priorWeight` 0.25 is still a guess — the quantity that would set it (a usage corpus of the ' +
      'opponent\'s own action frequencies) is exactly what is missing, so the adoption ships the ' +
      'MIDPOINT and not a fitted value. It also, for the record, CONTRADICTS nothing: E5\'s +8.3 % ' +
      'came from turning the hard solve off entirely, and this tier keeps 75 % of it.'
  },
  {
    /* THE ROW THAT PRICES THE PROMOTION. `endgame-3v3` is the widened tier; before
     * `laplace.endgame.promoteMate` existed, enabling it could not change a single decision — the
     * report went to `lastReadout` and nothing in the ranking path read it (ATTEMPTS.md §M1). This
     * row runs the SAME tier with the promotion off, so the pair prices the promotion itself. */
    id: 'endgame-promote',
    label: 'endgame promotion ONLY (off)',
    tier: 'laplace',
    direction: 'off',
    patch: { 'laplace.endgame.enabled': true, 'laplace.endgame.promoteMate': false },
    expect: 'helps',
    note: 'The variant is the tier as it stood before the §N fix: the solver runs (same bounds, same ' +
      'five corrections, same multi-world gate) and its report is published on `lastReadout` — and ' +
      'nothing ranks by it, so the line the engine plays is the equilibrium one. Off (the baseline ' +
      'this row is compared against) is the shipped build, where the tier does not run at all. Read ' +
      'the delta as the value of RANKING a proven mate; it is zero whenever no world proves one, ' +
      'which is the honest answer on most boards.',
    caveat: 'UNMEASURED — this row is new with the leaf, and it is the control the pair needs: a ' +
      'delta here is the promotion alone, and `Δ(endgame-3v3) - Δ(endgame-promote)` is what the search ' +
      'itself is worth. A mate is rare, so a 60-battle sweep may produce none, and then the row is ' +
      '`identical` for a HARNESS reason that says nothing about the promotion; the frequency of mate ' +
      'proofs is the number to read beside it. tests/endgame_check.js §7 prices it where the proofs ' +
      'are constructed.'
  },
  {
    /* THE LEVER THE ONE-WAY LOOP WAS HIDING. Until the opponent-model fix, exploiting a
     * NON-equilibrium opponent had nowhere to land: our published mix was the equilibrium frequency
     * either way. With the fix, an anchored / softened / surprised opponent moves our row values,
     * and this weight is how much of that advantage to take in the published mix. */
    id: 'nash-exploitblend',
    label: 'exploit blend x0.5 (on)',
    tier: 'laplace',
    direction: 'on',
    patch: { 'laplace.nash.exploitBlend': 0.5 },
    expect: 'helps',
    note: 'On (the variant), the published frequency of each of our rows is ' +
      '`(1 - b) * equilibriumFrequency + b * softmax(rowValues)` at b = 0.5, where `rowValues` is ' +
      'what that row is worth against the opponent mix the SAME solve published. Off (the baseline) ' +
      'is the shipped 0.0, which skips the blend entirely — no copy and no rescale — so ' +
      '`nashFrequency` and `confidence` are the same number and the ranking is the equilibrium one, ' +
      'bit for bit.',
    caveat: 'UNMEASURED — new with the leaf. Two readings to keep apart when it is. (1) Against the ' +
      'SHIPPED opponent model (hard response, no qre, no prior, no mask) there is nothing to exploit, ' +
      'and the only effect is that the published mix stops matching the minimax one — a COST — so the ' +
      'expected sign depends on whether the other rows are on and a flat row here is not evidence ' +
      'the blend is worthless. (2) `b` is a taste until a corpus says otherwise: 0.5 is the midpoint, ' +
      'and the quantity that would set it (how far a ladder opponent is from the equilibrium mix) is ' +
      'the same thing this engine cannot measure offline. tests/tuning_check.js §10 pins the identity ' +
      'at 0, the softmax at 1, and the exact convex combination in between.'
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
    '  --team <name>       Team for the ENGINE seat, for the baseline AND every variant (default:',
    '                      hazardStackBalance, or the one team the selected rows declare). A row that',
    '                      declares `team` needs a corpus the shipped seat cannot supply — the two',
    '                      own-move leaf channels read `[identical]` on a team with no shield and no',
    '                      status move — so the sweep refuses to mix teams rather than pair arms that',
    '                      are not the same experiment.',
    '  --baseline <file>   Reuse a finished arena report as the reference arm instead of',
    '                      re-running it, so a sweep that died mid-way can be resumed. The',
    '                      report must be the same experiment (--battles / --agent / --seed /',
    '                      --max-turns), must carry battle records, and must be a BASELINE',
    '                      (no --set applied); anything else is refused. Pairing is still',
    '                      checked per battle, so a mismatch reports `unpaired`, not a delta.',
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
    agent: 'all', parallel: 1, out: null, baseline: null, keepTmp: false, list: false, quiet: false,
    help: false, team: null
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
      case '--team': opts.team = String(need(a, argv[++i])); break;
      case '--out': opts.out = String(need(a, argv[++i])); break;
      case '--baseline': opts.baseline = String(need(a, argv[++i])); break;
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
        parent: f.parent || null, team: f.team || null
      };
    }));
}

/**
 * resolveRunTeam(variants, opts) -> team name or null
 *
 * THE ENGINE SEAT'S TEAM IS A PROPERTY OF THE EXPERIMENT, NOT OF A VARIANT. A row that declares
 * `team` is asking for a CORPUS, not for a variant: a leaf tier which writes OUR OWN move's
 * transition needs a team that can actually play the move family it prices, and the shipped engine
 * seat cannot supply a shield or a status move (ATTEMPTS.md §P7). The baseline arm is compared
 * against every variant on paired seeds, so it has to sit in the SAME game — a baseline on one team
 * and an arm on another is two experiments subtracted from each other, and the pairing check
 * downstream only verifies seeds, not teams.
 *
 * Hence the three rules below: one team per run; an explicit `--team` wins but must not contradict
 * what the table declares; and a sweep that MIXES declaring and non-declaring rows is refused
 * rather than quietly reinterpreted, because `--features all` would otherwise silently move forty
 * unrelated rows onto the corpus two of them asked for.
 */
function resolveRunTeam(variants, opts) {
  const features = variants.filter(function (v) { return v.id !== 'baseline'; });
  const declared = {};
  features.forEach(function (v) { if (v.team) declared[v.team] = true; });
  const names = Object.keys(declared);
  if (names.length > 1) {
    throw new arena.SetupError('this sweep declares more than one engine team (' + names.join(', ') +
      '); the engine seat\'s team is a property of the RUN, not of a row, or the baseline is not the ' +
      'same experiment as the arms');
  }
  if (opts.team) {
    if (names.length && names[0] !== opts.team) {
      throw new arena.SetupError('--team ' + opts.team + ' contradicts the feature table, which asks this ' +
        'row for the ' + names[0] + ' corpus');
    }
    return opts.team;
  }
  if (!names.length) return null;
  const undeclared = features.filter(function (v) { return !v.team; });
  if (undeclared.length) {
    throw new arena.SetupError('the selected sweep mixes engine teams: ' + names[0] + ' is declared by ' +
      declNames(features, names[0]) + ' but ' + undeclared.length + ' other row(s) declare none ' +
      '(' + undeclared.slice(0, 4).map(function (v) { return v.id; }).join(', ') +
      (undeclared.length > 4 ? ', ...' : '') + '). Pass an explicit --team to make the whole run one ' +
      'experiment, or run only the rows that share a corpus');
  }
  return names[0];
}

function declNames(features, team) {
  return features.filter(function (v) { return v.team === team; })
    .map(function (v) { return v.id; }).join(', ');
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
  if (opts.team) args.push('--team', opts.team);
  variant.setArgs.forEach(function (s) { args.push('--set', s); });
  return args;
}

/**
 * validateBaselineReport(payload, opts) -> null | reason
 *
 * `--baseline <file>` reuses a finished arena report as the reference arm, so a sweep that died
 * half-way through can be resumed without re-paying the baseline. The reuse is only sound when the
 * report is the SAME experiment, so this compares the arena's own recorded options against the
 * flags about to be run, requires battle records, and requires the report to be a BASELINE — a
 * variant's report carries `--set` and is a different arm. Returns a sentence on refusal, because a
 * silently mismatched baseline is a paired test against the wrong twin: pairing is still verified
 * per battle downstream, but that check can only catch a seed/game mismatch, not a wrong flag.
 */
function validateBaselineReport(payload, opts) {
  if (!payload || !Array.isArray(payload.records) || !payload.records.length) {
    return 'it carries no battle records';
  }
  const o = payload.options || {};
  const want = [['battles', opts.battles], ['mode', 'full'], ['agent', opts.agent],
    ['seed', opts.seed], ['maxTurns', opts.maxTurns]];
  for (let i = 0; i < want.length; i++) {
    const k = want[i][0];
    if (o[k] !== want[i][1]) {
      return 'its options.' + k + ' is ' + JSON.stringify(o[k]) + ' and this run wants ' + JSON.stringify(want[i][1]);
    }
  }
  /* The engine seat's team is part of the setup, so a reused baseline from a different team is a
   * different game, not a reference arm. Normalised to null on both sides so reports written before
   * --team existed (which carry no `team` field) stay reusable. */
  const wantTeam = opts.team || null;
  const gotTeam = o.team || null;
  if (gotTeam !== wantTeam) {
    return 'its options.team is ' + JSON.stringify(gotTeam) + ' and this run wants ' +
      JSON.stringify(wantTeam);
  }
  if ((o.sets || []).length || (payload.appliedSets || []).length) {
    return 'it was run with --set, so it is a variant arm and not a baseline';
  }
  return null;
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
    opts.team = resolveRunTeam(variants, opts);
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

  /* THE REUSED BASELINE, resolved before anything runs. `variants[0]` stays in the list so every
   * index in the table keeps its meaning; the worker pool simply skips it, and `results[0]` is
   * pre-filled from the file. */
  let reuse = null;
  if (opts.baseline) {
    const basePath = path.resolve(process.cwd(), opts.baseline);
    let payload = null;
    try {
      payload = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    } catch (e) {
      console.error('ablation setup failed: could not read --baseline ' + opts.baseline + ': ' + (e && e.message));
      return 2;
    }
    const why = validateBaselineReport(payload, opts);
    if (why) {
      console.error('ablation setup failed: --baseline ' + opts.baseline + ' is not usable for this run: ' + why);
      return 2;
    }
    variants[0].label = 'baseline (REUSED report)';
    reuse = { variant: variants[0], summary: summarizeRun(payload), payload: payload, appliedSets: [], run: { wallSec: 0 } };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ablation-'));
  const started = Date.now();
  const results = [];

  const report = function (line) { if (!opts.quiet) console.log(line); };
  report('ablation: ' + variants.length + ' batch(es) \u00d7 ' + opts.battles + ' battle(s), seed ' + opts.seed +
    ', agent ' + opts.agent + ', parallel ' + opts.parallel);
  report('  ' + (variants.length - 1) + ' feature(s): ' + ids.join(', '));
  report('  arena reports: ' + tmpDir);
  if (reuse) {
    report('  baseline: REUSED from ' + opts.baseline + ' (' + reuse.summary.battles + ' battles, generated ' +
      ((reuse.payload && reuse.payload.generatedAt) || 'unknown') + ') — NOT re-run');
  }

  /* A bounded worker pool. Each variant is an independent process with its own seeds, so running
   * them concurrently cannot change any variant's result — it only makes the wall clock bearable
   * at 500 battles a batch. */
  if (reuse) results[0] = reuse;
  let cursor = 0;
  async function worker(slot) {
    while (true) {
      const mine = cursor++;
      if (mine >= variants.length) return;
      if (mine === 0 && reuse) continue;          // the reference arm came from --baseline
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
      /* THE INPUT CHECK, read off the CHILD's own report (tools/harness_inputs.js). The echo above
       * proves each flag reached the child's config; this proves the child ever supplied the
       * channel the flag reads. A flag reading a channel that never carries anything returns its
       * inert default on every turn, so the row would be a baseline-vs-baseline comparison printed
       * as "this feature does nothing" — a false null, which is the one verdict this runner must
       * never hand over. (The child refuses it first; this is the cross-process half of the same
       * check, so a variant cannot be reported on if it ran against an older or patched arena.) */
      if (!failure && variant.setArgs.length) {
        const supply = payload.inputSupply || null;
        if (!supply) {
          failure = 'the arena report carried no inputSupply block, so nothing shows the flags had ' +
            'an input to act on — this row would not measure what it claims';
        } else if ((supply.unsupplied || []).length) {
          /* `unsupplied` carries only CLASSIFIED paths whose channel the batch never fed; an
           * unclassified path is not evidence of anything and never fails a row (see
           * tools/harness_inputs.js, and the registry-coverage check in the input suite). */
          failure = 'never supplied during the batch: ' + supply.unsupplied.map(function (u) {
            return u.path + ' <- ' + (u.missing || []).join(' + ');
          }).join('; ') + ' — a flat row here would be a FALSE NULL, not a finding';
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
  resolveRunTeam: resolveRunTeam,
  validateBaselineReport: validateBaselineReport,
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
