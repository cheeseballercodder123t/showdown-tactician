/* Showdown Tactician — src/config.js
 * RULE 4: the ONE place any tunable number in the decision engine lives.
 *
 * Every heuristic weight, threshold, probability, timeout and model id in the engine is a
 * property of `ST.CONFIG`. No scoring number is scattered through the modules: a reader who
 * wants to know "why does it value a freeze more than a burn?" or "how cautious is it about
 * Protect?" reads this file and nowhere else.
 *
 * Contract for consumers:
 *   const value = ST.configGet('tempo.rhythmHurt', 0.85);
 * `configGet` walks the dotted path and returns the supplied fallback ONLY when config.js
 * itself was never loaded (a defensive path for stripped builds and unit harnesses). When
 * config.js is present — as it always is in the manifest, which loads it first — the value in
 * this file wins, so editing here is sufficient to change behaviour. tests/config_check.js
 * proves that mutation flows through, and that the 128D weight layout this file generates is
 * bit-identical to the vector the evaluator shipped with.
 *
 * Categories that do NOT belong here:
 *   - anything the battle library owns (damage, type charts, base stats, move data),
 *   - game rules with a single correct value (Trick Room lasts 5 turns, EQ has 100 BP),
 *   - layout constants that are part of the 128D/10D interface itself (dim indices).
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  if (ST.CONFIG) return;

  const CONFIG = {
    version: '1.0.0',

    /* ---------------------------------------------------------------- laplace */
    // The master solver: how many worlds to sample, how the simultaneous matrix is solved
    // (mixed Nash by fictitious play), and how the per-world payoffs are pooled before voting.
    laplace: {
      K: 6,                                   // sampled worlds per decision
      temperature: 35,                        // softmax temperature (higher = flatter)
      worldBlend: { avg: 0.6, min: 0.4 },     // payoff pooling across worlds
      maxOppActions: 9,                       // opponent replies enumerated per world
      vetoScore: -9999,                       // score forced onto a vetoed line
      lethalBonus: 260,                       // payoff for taking the last opposing body
      maxSwitchFallback: 5,                   // bench switches synthesised without a |request|
      struggleChipPercent: 5,                 // stand-in damage when the opponent can only Struggle
      switchAteHitBonus: 25,                  // payoff when their switch ate our move for free
      // The PIVOT TAX (see laplace_core._switchTaxDelta). A flat score drag on every switch row, so
      // a pivot has to be better by `points` before it outranks an attack.
      //
      // Measured before it was written, over 100 elite battles / 5,903 decisions (tools/benchmark_
      // human_match.js, mean rating 1,830), and every number here re-derived from that run's own
      // --out records rather than from a summary: on the CONTESTED turns the engine's top line is a
      // switch 55.4% of the time where those humans switched 33.8% — and on the 4,349 turns the human
      // clicked a MOVE, its top line was still a pivot 48.1% of the time when it had 0-1 attacks to
      // compare with, 49.2% on 2-3, and 39.0% even with a FULL 4-attack menu. So the starved attack
      // menu inflates the figure (a real harness effect, 48 -> 39) without explaining it away: the
      // engine still disagrees about whether to pivot at all on ~4 of every 10 turns the human
      // attacked. And the headroom is exact, not rhetorical: on the 2,053 pivot-over-attack turns
      // the engine's OWN best non-pivot line was the human's click 55.8% of the time, and a policy
      // that never pivoted while it had an attack available would score top-1 61.3% on move clicks
      // (45.2% overall) instead of 35.0% (31.7%). The right answer is already inside the ranking on
      // 2 of every 5 of those turns; the tier's job was to surface it. A FLAT drag surfaced none of
      // them — it took the switch rate down while the switch half got worse.
      // Two candidate causes were tested and REFUTED on the same corpus with a paired
      // per-decision count (gained/lost top-1): dropping `quiescence.extendSetup` moves top-1 by
      // 221/242 (net -21) and moves the pivot rate UP, 53.1% -> 54.2%; suppressing VETO4 moves it by
      // 199/221 (net -22) and leaves the pivot rate where it was, 53.1% -> 53.7%.
      //
      // Ships OFF, and the win-rate gate is why — the tier did what it was built to do and LOST
      // anyway. At 120 points on that corpus top-1 agreement climbs 31.7% -> 44.0% (contested 25.5%
      // -> 31.9%) and the pivot rate falls 55.4% -> 29.2% (the humans: 33.8%, so it now
      // UNDER-pivots). But the climb is a COMPOSITION effect, not better pivot judgement: the move
      // half rises 35.0% -> 53.8% while the SWITCH half gets WORSE, 22.5% -> 16.5% — the tax stops
      // the engine pivoting without teaching it which pivot to make. At the STANDARD sample it is
      // worse still: 60 paired battles, all three personas, one seed -> win rate 96.7% -> 70.0%,
      // delta -26.7 points, 95% CI [-38.3, -15.0], and the 100-turn cap ties come BACK (1/60 ->
      // 18/60, a 30% stall share, capped games losing only 4.1 of 12 bodies). The earlier positive
      // sign rested on 30 CRUCIBLE battles, which splice a recorded human line in at turn 8+ and are
      // explicitly NOT comparable across variants; the ablation only ever runs `--mode full`. This is
      // the tree's whole reason for keeping agreement and strength apart: agreement is a hypothesis,
      // the gate is the verdict, and a rejected tier stays in the table (tools/run_ablation.js, id
      // `switch-tax`) as the record that it was tested rather than quietly dropped.
      switchTax: {
        enabled: false,
        points: 120                     // score drag per switch row; 120 is the arm that was measured
      },
      // Risk-adjusted volatility (the "tilt penalty"). A 70%-accuracy move is NOT worth 0.7 of
      // its damage when missing it hands the opponent the game: the downside of a miss is
      // asymmetric with the upside of a hit. So each of OUR rows is re-priced as
      //     upside  = score * (accuracyWeight * acc + (1 - accuracyWeight))
      //     charge  = (1 - acc) * incomingThreatPercent * fragilityScale * (lethal ? lethalMultiplier : 1)
      //     final   = upside - charge
      // where `acc` is the library's own accuracy for the move (1 for a move that cannot miss)
      // and `incomingThreatPercent` is the library's best-move damage into our active mon, both
      // MEASURED, never assumed. `enabled: false` restores the raw payoff exactly, the same way
      // nash.enabled does.
      volatility: {
        enabled: true,
        // Fraction of the payoff that is scaled by the move's accuracy. 1 = fully risk-adjusted
        // (a 70% move keeps 70% of its upside); 0 = accuracy ignored (the old behaviour).
        accuracyWeight: 1.0,
        // The fragility charge: (1 - accuracy) * incomingThreatPercent * fragilityScale, added
        // as a NEGATIVE row delta. It is measured from the library, never assumed.
        fragilityScale: 2.4,
        // Extra multiple on that charge when the incoming threat is LETHAL to the active mon
        // (a miss there does not cost a turn, it ends the mon).
        lethalMultiplier: 3.0,
        // Moves at or above this accuracy are treated as risk-free (no charge at all).
        accuracyFloor: 100,
        // Only moves at or below this accuracy can be charged the lethal multiplier, so a stray
        // 95% "never miss in practice" move cannot be branded a game-ender.
        lethalChargeMaxAccuracy: 90
      },
      // Quiescence (the "setup punisher"). The simultaneous matrix prices ONE turn, and the two
      // opponent replies that punish that blind spot were both priced as no-ops: a setup move
      // deals no damage and (before this) changed no state, so "they click Dragon Dance" scored as
      // a free hit for us; a Protect did not block our move either, so a line that KOs their body
      // scored the lethal bonus through the shield. Both are re-priced here, from GAME RULES only
      // — the boost they gain comes from the table in src/util.js and is applied by the damage
      // engine's own calculator, never by a heuristic. `enabled: false` restores the raw 1-ply
      // payoff bit-for-bit, the same way `nash.enabled` and `volatility.enabled` do.
      quiescence: {
        enabled: true,
        // Their SETUP reply is extended one ply: they keep the boost their move grants, their best
        // attack lands again from that boosted state, and the cell is scored on the resulting
        // board instead of on a turn in which nothing happened. ONE extra exchange, not a tree.
        extendSetup: true,
        // Their PROTECT reply blocks OUR move this turn (a game rule). Without it the matrix
        // credited us the hit anyway, lethal bonus included.
        //
        // SHIPS OFF, AND IT MOVED ON A MEASUREMENT — the second default this branch has ever flipped
        // (the first is `sampler.stratifyActive`, ATTEMPTS.md K2). The rule it encodes is real: a
        // shield that is up DOES block the move. What the sweep priced is the PRICING of that rule
        // inside a one-turn cell, and it costs games: 60 paired battles on the personas arena (seed
        // 1337), switching it off won **78.3 % against 63.3 %**, delta win **+15.0 [+6.7, +23.3]**
        // and delta match score **+7.5 [+3.3, +11.7]** — both intervals exclude zero on the SAME arm
        // — with the 100-turn cap games cut **11/60 -> 2/60**. The whole movement is ONE seat: against
        // the `exploiter` persona (a Protect-heavy staller) the baseline goes 4-0-11 and switching
        // this off goes 13-0-2, while the anchor and chaos seats are 15-0-0 and 13-2-0 either way.
        // On the self-play mirror it is INERT (`identical` at n=20 and in the 60-battle sweep), so
        // the harm is specific to an opponent that actually clicks Protect into us.
        //
        // WHY OFF AND NOT "FIX THE PRICING": the block IS the pricing. Inside the cell their shield
        // makes our move a wasted turn, so the engine prefers a pivot or a different move and grinds
        // out a standoff against a body that keeps shielding. Off restores the legacy 1-ply reading
        // (their Protect is a no-op for the cell) — exactly what this tier was built to correct — so
        // this is a deliberate, measured step back from the correction, taken because the correction
        // is worth -15 to -70 win points against a shield-spammer, depending on the seed and whether
        // the whole seat or one column of four is being read. The ablation row
        // `quiescence-blockprotect` keeps the cost of turning it back ON measurable, and
        // tests/quiescence_check.js still proves the block works whenever it is on. CONFIRMED
        // ON A SECOND SEED, exploit-only: with the block back ON the seat drops to 16.7 %
        // (10-0-50, 50/60 capped) against the shipped 86.7 % (52-0-8) — delta win -70.0 [-83.3,
        // -56.7]. The same run settles the OTHER half in the opposite direction: removing the setup
        // ply costs -40.0 win [-55.0, -25.0], so `extendSetup` stays on. ATTEMPTS.md K6/K6b.
        blockProtect: false,
        // Turn 2 of the setup extension is ordered by the SPEED each body will actually have there
        // (the boost applied, plus Trick Room and move priority). Without it both second actions
        // landed unconditionally, so "boost, then kill the setup user" and "boost, die to the setup
        // user" scored the same as "boost, trade". A body that faints first does not act at all.
        respectTurn2Speed: true,
        // HOW MUCH OF TURN 2 TO PRICE, as a fraction of the extension's own damage. 1.0 is the
        // full, un-damped second exchange (the behaviour the tier shipped with, and `x * 1` is
        // bit-identical to it); 0.5 prices half of it; 0 prices the boost but no second hit, which
        // is the old 1-ply "setup is a no-op" cell with the stat stages still applied.
        //
        // WHY THE KNOB EXISTS: the mirror sweep priced `extendSetup` at HURTS +23.3 win points
        // [+8.3, +38.3] while the re-anchored personas arena priced the same tier at HELPS +20.0
        // [+10.0, +30.0]. Both intervals exclude zero, so the two instruments genuinely disagree
        // and neither is being quoted as the answer. One reading of the asymmetry is that a
        // full-strength Turn-2 boosted hit makes the engine over-value "kill the setup user BEFORE
        // it acts" against a rational mirror opponent that rarely clicks raw setup into an active
        // threat — i.e. the extension is pricing a follow-up that a good opponent mostly does not
        // buy. Damping the follow-up is therefore the hypothesis this knob exists to test, and the
        // ablation row `quiescence-followup-damped` (tools/run_ablation.js) is what decides it.
        followUpWeight: 1.0
      },
      // Opponent-switch substitution (see laplace_core._oppSwitchTarget). A switch reply used to be
      // priced by resetting the outgoing body to 100% and DISCARDING our turn-1 hit — the incoming
      // body was never named, never paid entry hazards, and never took the attack aimed at it. With
      // this on, the incoming body is resolved (from the sampled world's own roster when one is
      // available), pays its side's entry hazards, and is the body our move lands on, so the leaf
      // board has the right body standing there. `enabled: false` restores the old pricing exactly.
      realOppSwitch: {
        enabled: true
      },
      // CONDITIONAL MOVES (see laplace_core._payoff). A move whose damage only exists when the
      // opponent's CLICK is the right shape used to be priced as unconditional damage, so the
      // matrix recommended lines the game resolves with |-fail|:
      //   - Sucker Punch into a predicted SWITCH credited its damage to the incoming body, although
      //     the move fails the moment the target is not attacking. With this on, Sucker Punch prices
      //     its damage only against a Physical/Special reply; a switch, a setup move, a status move
      //     or a Protect leaves the cell worth the wasted turn it is (their switch still resolves —
      //     the leaf board is the body that came in, unhit);
      //   - Fake Out / First Impression kept their damage on every turn. On, they fail once our
      //     active body has already acted since it entered, because the game only allows the first
      //     turn out; and the reply is priced against the flinch a landed Fake Out really applies
      //     (their click does not happen at all — no damage, no setup boost, no Turn-2 follow-up),
      //     blocked by Inner Focus / Shield Dust / a Covert Cloak when the board reveals one. The
      //     same rules are applied to THEIR Sucker Punch and THEIR Fake Out, because those are
      //     reply columns in the same matrix.
      //
      // Ships ON: unlike the policy tiers below, these three are GAME RULES — the shipped build was
      // crediting damage that cannot happen. Each half has its own switch so the ablation rows
      // (`conditionalmoves`, `conditional-suckerpunch`, `conditional-firstturn`, `conditional-flinch`)
      // can price them separately; NONE of them has had a win-rate gate yet.
      conditionalMoves: {
        enabled: true,
        suckerPunchRequiresAttack: true,   // Sucker Punch only lands on an attacking click
        firstTurnOnly: true,               // Fake Out / First Impression fail after the first turn out
        flinch: true                       // a landed Fake Out takes their click away
      },
      // CHOICE PHYSICS, both directions (see laplace_core._oppChoiceLock and _choiceLockRisk).
      // A Choice item locks its holder into the first move it clicks, and the shipped engine ignored
      // that in BOTH halves of the matrix:
      //   - THEIR half enumerated all four of the locked body's moves as if it were free to pick
      //     any of them, so a Scarfed / Banded / Specs'd body was priced as a toolbox;
      //   - OUR half had no cost for LOCKING ourselves into a move their bench is immune to — a
      //     Choice-locked Earthquake into three Levitate bodies is a lost game, not a lost turn.
      // `riskPenalty` is in evaluator score units (the evaluator's own scale is 1000) and is charged
      // to an unlocked click whose type some living, revealed-immune bench body takes 0 from.
      // Ships ON as a game rule (a locked body really does have one move); the PENALTY is a policy
      // number and has NOT been measured. Both halves are the exact identity with `enabled: false`.
      choiceLock: {
        enabled: true,
        oppLock: true,                       // their reply space collapses to the locked move
        riskPenalty: 60                      // our own lock risk, per cell
      },
      // Pivot pricing (see laplace_core._pivotPayoff). U-turn / Volt Switch / Flip Turn / Chilly
      // Reception / Teleport / Parting Shot are priced as what they are: a hit, a switch, and the
      // incoming body's own matchup — with the TURN ORDER deciding who eats the opponent's reply,
      // Regenerator credited to the body leaving, and Chilly Reception's snow on the field.
      pricePivots: {
        enabled: true,
        regenPct: 33.3                     // Regenerator credit for the body leaving (1/3 of max HP)
      },
      // Recovery pricing (see laplace_core._payoff). A healing move deals no damage, so the 1-ply
      // model scored it as a wasted turn: the body entered the leaf at the HP it had ALREADY lost.
      // With this on, the user's heal is credited before the opponent's reply, clamped to 100.
      priceRecovery: {
        enabled: true,
        defaultHealPct: 50                 // percent of max HP credited for a healing move
      },
      // Own-move leaf effects (see laplace_core._myMoveLeafEffects). `_payoff` prices our own
      // pivot and recovery moves above, and left every other non-damaging move of ours — Stealth
      // Rock / Spikes / Toxic Spikes / Sticky Web, Rapid Spin / Defog / Mortal Spin / Tidy Up /
      // Court Change, and our own 29 setup moves — without writing its board change to the leaf
      // `sim`, so the 128D evaluator read the pre-move hazards and boosts on every candidate row.
      // With this on, the leaf carries the hazard layer / clear and our own setup stages (and in
      // that turn's reply, our boosted Defence / Special Defence and any HP cost like Belly Drum).
      // Ships OFF on a win-rate gate, not on a weight reading: the 128D fitted weights pair base dims
      // (`hazards` 48..55, `boosts` 36..41) with `macro` dims that are EXACT linear combinations of
      // them (`v[116]` of 48..55, `v[118] = (1/3)·(v36+…+v41)`), so ridge split one coefficient into
      // two (`macro[4] = -9.29` against base hazard dims of +3.36..+6.57, `macro[6] = +18.37` against
      // base boost dims of -4.84..-5.62). Neither half means anything alone; the NET weight of one
      // fact is measured, layer by layer, in ATTEMPTS.md §P5 — where every sign is right and the
      // magnitudes are not.
      priceMyMoveEffects: {
        enabled: false
      },
      // Own-move leaf effects, part 2 — OUR STATUS MOVES (see laplace_core._myMoveStatusEffect).
      // The 128D evaluator fits dims 24..31 (how many bodies on each side carry a condition),
      // 28..31 / 117 (the status differential) and 32..35 (our own active body's condition), and
      // until this tier existed `_payoff` handed it leaf boards on which the condition a move
      // exists to give was ABSENT from every candidate row — so Thunder Wave, Will-O-Wisp, Toxic,
      // Spore and the rest were priced as turns that changed nothing. On, our status-inflicting
      // move (U.STATUS_MOVES: the move's PRIMARY effect) writes that condition onto THEIR leaf
      // body, refused when the board says it cannot land: the body is already statused, the type
      // chart or the defender's revealed ability nullifies the move (Thunder Wave into a Ground
      // body, Will-O-Wisp into a Water Veil), the status is impossible for the type
      // (U.STATUS_TYPE_IMMUNITY — Electric bodies cannot be paralysed, Fire bodies cannot burn),
      // or the move is a powder and the body is Grass. Ships OFF until a win-rate gate adopts it.
      // NOT MODELLED, stated here rather than discovered later: ACCURACY (Thunder Wave 90 %, Hypo-
      // nosis 60 %) — the leaf writes a landed condition, because a board cannot carry a fraction
      // of a status; secondary-effect riders (Body Slam's 30 % paralysis) and conditional
      // inflictions, which U.STATUS_MOVES deliberately omits; and Safety Goggles / Overcoat as
      // powder shields, neither of which is inferable from a revealed board.
      priceMyMoveStatus: {
        enabled: false
      },
      // Own-move leaf effects, part 3 — OUR OWN PROTECT (see laplace_core._myMoveProtectShield).
      // `laplace.quiescence.blockProtect` prices THEIR shield blocking OUR move; nothing priced
      // OURS blocking THEIR reply, so a Protect was scored as a turn on which we did nothing and
      // took their best hit in full — the largest single unwritten family in the move-half gap
      // (20.4 % of the summed gap, median score gap 83.5; ATTEMPTS.md §P6). On, the cell is priced
      // on the board a shield actually produces: their reply deals nothing this turn, and the leaf
      // carries the Protect rhythm (dims 126/127) that the live state would carry next turn.
      // A PROTECT THAT FAILS IS NOT A SHIELD: a consecutive use (the same rule veto 9 encodes —
      // a Protect on the board's turn minus one, exempted when a Taunt/Encore means it never went
      // off) is priced as the wasted turn it is, and a reply that pierces a shield (Feint, Phantom
      // Force, Shadow Force, Hyperspace Fury / Hole) is not blocked. Ships OFF until a win-rate
      // gate adopts it. NOT MODELLED: the 1-in-3-and-halving success rate of a repeat Protect is
      // read as a failure, not as a probability, and a shield takes no account of what their NEXT
      // turn does with the turn it bought.
      priceMyMoveProtect: {
        enabled: false
      },
      // KO BRANCHING ON THE EXACT 16 ROLLS (`laplace_core._koTransition`). `_payoff` moves the
      // target's HP by `avgPercent` — the MEAN of the 16 damage rolls — and clamps at 0, so a move
      // whose mean is 101 % is priced as a CERTAIN OHKO on which the target never answers, while a
      // mean of 97 % leaves it at 3 % and its reply lands in full. That step is an artefact of
      // collapsing sixteen discrete outcomes into one number, not a property of the game: 10 of 16
      // rolls may reach the target in the first case and 6 of 16 in the second. On, the transition
      // becomes the EXPECTED HP over the two outcomes, `(1 - p) * survives`, with p read from the
      // exact share of rolls that reach the current HP (`koChanceExact`, null when the roll set
      // cannot answer exactly — then the scalar path is kept).
      //
      // The same flag carries the ORDERING half, and the order is ASKED FOR rather than assumed:
      // `_payoff` reads `_turnOrder` (priority, then Speed through Trick Room — the check the setup
      // extension and the pivot tier already use) and, when one side moves first with a FRACTIONAL
      // exact chance `p` of fainting the other, scales the slower side's damage by `(1 - p)`. That
      // is the `p * V_KO` branch the HP-only form could not claim, without inventing a speed
      // assumption: an undecidable order (a tie) and the endpoints `p` 0 and 1 keep the symmetric
      // pricing, so no cell ever claims a turn it cannot establish. Still NOT modelled: accuracy (a
      // MISS is not a roll) and move order decided by anything the board does not show. Ships OFF.
      rollKoBranch: {
        enabled: false
      },
      // DELAYED MOVES (see laplace_core._payoff, "WHEN A PENDING SLOT CONDITION LANDS"). Future
      // Sight and Doom Desire deal NO damage on the turn they are clicked: the sim parks a slot
      // condition and lands it at the residual of the NEXT turn, against whoever stands in the slot
      // by then, using the CASTER's stats. Pricing the click as an immediate 120 BP hit was a plain
      // rules error (the same class as Sucker Punch's), so this ships ON; `setupDiscount` is the
      // share of that hit the engine credits to the click itself, because the target gets a whole
      // turn to switch, Protect or heal before it arrives. Wish is tracked by the same section
      // (`wishHealPct`): it heals the body standing in its slot for half the CASTER's max HP.
      delayedMoves: {
        enabled: true,
        setupDiscount: 0.55,               // credit for clicking Future Sight / Doom Desire now
        wishHealPct: 50                    // Wish's heal, as a share of the caster's max HP
      },
      // Comeback mode (prospect theory on the risk dial — see laplace_core._comebackScale). Scales
      // the volatility charge by where the 128D evaluator puts the board: sharpened when we are
      // ahead (minimum variance), softened when we are behind (we need the swing). Ships OFF; the
      // margins are in the evaluator's own units (evaluator.scale is 1000, so +/-300 is a clear
      // lead either way).
      comeback: {
        enabled: false,
        winMargin: 300,                 // board score at or above this reads as winning
        lossMargin: -300,               // ...at or below this reads as losing
        winChargeScale: 2,              // sharpen the miss charge while ahead
        lossChargeScale: 0.4            // soften it while behind
      },
      // Turn urgency (patience decay — see laplace_core._urgencyDelta). Past `startTurn` a
      // COMMITTING line gains a bounded bonus and a PASSIVE line takes a bounded malus, ramping to
      // the cap at `rampTurn` and multiplied by `breakoutScale` at `breakoutTurn`.
      //
      // ADOPTED 2026-10-12 on the config-flag ablation, the only one of the four newest tiers to
      // clear the gate: 60 battles per arm across the three league personas on a shared seed,
      // paired bootstrap (2000 resamples) on the win indicator — win rate 68.3% -> 96.7%, delta
      // +28.3 points, 95% CI [+18.3, +40.0], and the 100-turn cap ties collapsed from 17/60 to
      // 1/60 (p90 game length 101 -> 89). `tools/run_ablation.js --features urgency` reproduces it.
      // The three sibling tiers (clock.ratingBands, laplace.comeback, pruner.abilityDeduction.
      // absenceRules) all measured flat and stay OFF.
      urgency: {
        enabled: true,
        startTurn: 25,                  // no effect at all before this turn
        rampTurn: 60,                   // the ramp reaches its cap here
        breakoutTurn: 50,               // from here the delta is multiplied by breakoutScale
        maxBonus: 120,                  // cap on the committing-line bonus
        breakoutScale: 2,               // breakout multiplier past breakoutTurn
        minBasePower: 60,               // a damaging move at or above this base power "commits"
        passiveMalus: 40                // cap on the passive-line penalty
      },
      // Mixed-strategy solver: fictitious play over the simultaneous payoff matrix. With it on,
      // `confidence` is the equilibrium FREQUENCY of the line (how often to click it), which
      // cannot be exploited by a patient opponent the way a single always-printed line can.
      // `laplace.temperature` then only governs the legacy softmax path below.
      nash: {
        enabled: true,
        // Best-response rounds. Fictitious play's AVERAGE converges at O(1/sqrt(T)) with a
        // real oscillation, so this is not a place to be stingy: measured against analytic
        // 2x2 equilibria the worst frequency error is 0.06 at 50 rounds, 0.025 at 240 and
        // 0.006 at 2000, while a realistic 5x9 solve still costs ~0.22 ms at 2000 rounds
        // (vs ~0.035 ms at 240) — noise next to the damage engine. See tests/upgrades_check.js.
        iterations: 2000,
        // Quantal Response Equilibrium: a LOGIT opponent instead of a perfectly rational one.
        // Fictitious play gives the opponent a hard best response, which is the minimax-safe
        // assumption but not a model of a ladder human — the `nash` ablation (ATTEMPTS.md E5)
        // priced the hard solve at a cost of about 8.3% against the pure softmax, and the open
        // question is whether that gap is the equilibrium being wrong about PEOPLE. With QRE on,
        // the opponent's column step is a softmax at temperature `tau` instead of an argmax, so
        // their replies are spread the way a noisy player's are — while OUR side keeps the hard
        // best response, so the worst case we play against is still bounded by the same matrix.
        // Ships OFF: this is a measure-before-adopt tier, not a preference.
        // `tau` is scaled toward 0 as the opponent's rating approaches `highRating`, because a
        // 1850+ opponent IS close to the rational model and the deviation belongs to the lower
        // ladder; at `lowRating` and below the full temperature applies. A seat with no rating
        // gets the identity — QRE off, whatever this says.
        qre: {
          enabled: false,
          tau: 30,                       // logit temperature on the opponent's column responses
          highRating: 1850,              // at or above this: tau -> 0 (the hard best response)
          lowRating: 1100                // at or below this: the full temperature
        },
        // PRIOR-ANCHORED REGRET MATCHING. Fictitious play starts every action with ZERO
        // credibility, so an opponent blunder (a 2 % move, a switch into a bad matchup) collects
        // the full weight of a best response for the whole solve before the average can wash it
        // out; ATTEMPTS.md E5 priced turning the hard solve off at +8.3 % against the pure
        // softmax, which read as "the equilibrium over-defends against bluffs nobody makes". This
        // tier anchors the solve to a BEHAVIORAL prior instead of a uniform one: the regret term
        // is blended with a normalized prior over the opponent's own actions (`priorWeight`), so
        // a line has to earn credibility before it can move the mix. `enabled: false` runs the
        // pre-adoption fictitious play step for step.
        //
        // SHIPS ON SINCE 2026-10-15 (ATTEMPTS.md §N), and it is the first tier in this project to
        // be adopted on a TWO-SEED replicate. The first reading was `identical`; that was not the
        // tier being worthless but the solve being ONE-WAY — our own step best-responded to the
        // opponent's hard argmax index while their published strategy accumulated the mixture, so
        // no opponent model could reach our frequency counts (§L2). With that fixed, mirror, 60
        // paired battles each: seed 1337 Δwin +21.7 [+5.0, +36.7] / Δscore +25.0 [+8.3, +40.0];
        // seed 20261016 Δwin +25.0 [+8.3, +41.7] / Δscore +23.3 [+8.3, +38.3], cap ties 7/60 ->
        // 5/60 on the second seed and no stall flag on either. Both scales exclude zero on both
        // seeds, which is what §L3 asks a mirror row for before it can be quoted.
        //
        // WHAT THIS IS NOT: the opponent in that instrument is a FROZEN COPY OF THIS ENGINE, so
        // the win is a self-play result and not a measured ladder improvement; the personas arena
        // cannot check the direction (its baseline sits at 98.3 % with no headroom, §H); and
        // `priorWeight` is the untuned midpoint of [0, 1] — the quantity that would set it (a
        // usage corpus of the opponent's own action frequencies) is exactly what this repository
        // does not have offline. Turning it back off is the `nash-prior` ablation row.
        priorAnchored: {
          enabled: true,
          priorWeight: 0.25,             // prior share of the opponent's first response
          // The prior's own shape. All three groups are in PERCENT-OF-MAX-HP units, because that
          // is what the damage engine reports and the prior is only ever compared with itself.
          attackFloor: 5,                // a damaging move weighs at least this much
          setupSafe: 45,                 // a setup move when our active CANNOT 2HKO them
          setupUnsafe: 10,               // ...and when it can (taking the turn is a real risk)
          switchBase: 8,                 // a pivot that is not obviously correct
          switchEscape: 70               // ...and one that is (their active faces a revealed OHKO
                                         // from us and the incoming body resists it)
        },
        // EXPLOIT BLEND. The solve above publishes the UNSETTABLE mix: every supported line gets
        // the same EV, so against a NON-equilibrium opponent (a softened one from `qre`, an
        // anchored one from `priorAnchored`, or one that cannot see a lure thanks to
        // `surpriseMask`) the unexploitable mix leaves value on the table when one of our rows
        // strictly dominates against the mix we now EXPECT. This weight is the classic
        // exploration/exploitation blend that gives it back:
        //     myConfidence = (1 - b) * equilibriumFrequency + b * softmax(rowValues)
        // `rowValues` is what each of our rows is worth against the opponent mix the solve
        // published, so the second term is a best-response-shaped read of the SAME solve. It is
        // normalized separately (the two terms are each a distribution) and vetoed rows are still
        // forced to 0 afterwards.
        // Ships at 0.0, which is the exact identity: the blend is skipped entirely rather than
        // multiplied, so `nashFrequency` and `confidence` stay in lockstep and the shipped ranking
        // is bit-identical. A nonzero value is a MEASURE-BEFORE-ADOPT candidate — the ablation row
        // `nash-exploitblend` is what prices it.
        exploitBlend: 0.0
      },
      // SURPRISE TRUNCATION. The matrix is solved over the opponent's FULL action list, which
      // means the equilibrium already knows about our unrevealed coverage lure and switches out of
      // it — telepathically, because on the ladder they have not seen that move yet. This tier
      // builds an OPPONENT-PERCEIVED copy of the matrix in which a row for an UNREVEALED NON-STAB
      // move is blended toward the best REVEALED/STAB row by `unrevealedWeight` (1.0 = the true
      // matrix, 0 = they read the lure as our plain STAB), solves THE OPPONENT's mix on that copy,
      // and then scores OUR rows on the TRUE matrix against that mix. It changes what we expect
      // THEM to do; our own frequencies are still bounded by the real matrix. Ships OFF.
      surpriseMask: {
        enabled: false,
        unrevealedWeight: 0.35
      },
      // Scouting (information gain). The matrix scores HP, but early in a game INFORMATION is
      // worth more than HP, and the engine already holds the measurement it needs: the opponent's
      // surviving candidate sets and their weights (src/set_pruner.js + src/world_sampler.js).
      // src/information_gain.js turns that pool into a Shannon entropy and prices what a move
      // teaches us about it. `maxBounty` caps the payoff a single move may earn for information
      // alone, and it is 0 while the tier is inert — a scouting bounty that has not been measured
      // would change the ranking, and this repo adopts a policy only after a measurement.
      scouting: {
        enabled: false,
        maxBounty: 0,
        // Below this many bits of entropy there is nothing left to learn, so no bounty is paid.
        minEntropy: 0.05
      },
      // Opponent profiling. Fictitious play solves for the equilibrium of a perfectly rational
      // opponent; a ladder human is not one. src/opponent_profile.js watches how the opponent's
      // observed replies deviate from the frequencies the engine's OWN matrix predicted and
      // exposes ONE bounded factor, the way src/opponent_clock.js exposes its switch factor — a
      // column re-weight on their switch replies, never a new payoff. Inert until adopted.
      profile: {
        enabled: false,
        // Deviations are not scored until there are this many observations: a personality read
        // off two turns is noise, and it would move the matrix.
        minSamples: 6,
        // Share of the observations that must be a pivot (or an attack) before the label flips.
        flightThreshold: 0.25,
        aggressionThreshold: 0.25,
        // The factor is clamped to [1/maxFactor, maxFactor] so one bad read cannot dominate.
        maxFactor: 2,
        maxHistory: 24
      },
      // Win-condition bounty (backward chaining). The leaf evaluator scores a board holistically;
      // src/wincon_bounty.js instead asks which enemy body is standing between us and the sweep —
      // from MEASUREMENTS only (their best move into our team, our best move into them, never a
      // species rule) — and pays a bounded bonus once that body is gone. Inert while
      // `maxBounty` is 0, and `maxTargets` bounds how many bodies may be considered.
      wincon: {
        enabled: false,
        maxBounty: 0,
        maxTargets: 3,
        // THE CHIP HALF. `maxBounty` is paid only when the named roadblock is GONE; a wall that
        // has been chipped to the point where our own best hit breaks it is most of the way to the
        // same outcome, and before this the leaf was blind to it. `chipBounty` is the ceiling paid
        // for reaching that break point (the smallest roll of our best hit), scaled by the share
        // of the distance the turn actually covered from the body's HP when the plan was made.
        // Ceiling, not a per-hit rate: the plan is rebuilt every turn, so this cannot compound into
        // a reason to chip forever. 0 disables the half, which is the shipped reading.
        chipBounty: 0
      },
      // The endgame solver. With few bodies left per side the branching factor collapses and a
      // bounded alpha-beta search (src/endgame_solver.js) can be run instead of one turn of the
      // matrix. It REFUSES outside its competence rather than guessing, and it is inert until it
      // has been measured on positions whose answer is known.
      endgame: {
        enabled: false,
        // Bodies alive per SIDE at or below which the solver is allowed to run. Widened from 2 to
        // 3 so a 3v3 / 3v2 / 2v3 board can be searched when the tier is enabled; the node budget
        // below is what keeps the wider box from running away, and an exhausted budget reports
        // `{solved:false, reason:'budget'}` rather than a partial line presented as a solution.
        maxAlive: 3,
        // LEGACY ALIAS, kept at the same value so the historical path and the config key the
        // regression suite pins both stay meaningful. `maxAlive` wins whenever it is present.
        maxBodies: 3,
        maxDepth: 10,
        // Hard ceiling on explored nodes: the search stops and reports "budget", it never runs
        // away on a phone.
        nodeBudget: 20000,
        // A cap on how many moves one side may branch on at a node. Inert for a legal set (four
        // moves), and a guard against a driver-built body carrying more known moves than a set can
        // hold, which is where a search this wide would otherwise stop being bounded.
        maxBranchingMoves: 12,
        // Ambiguous Speed as a CHANCE NODE. When our exact Speed falls inside the opponent's
        // [speedFloor, speedCeiling] band the move order is a fact we do not have, and the tier's
        // old rail refused the whole solve. With this on, the probability the opponent acts first is
        // read off their own surviving candidate sets (weights included) and the pair is priced as
        // the expected value over the two orders — but a mate is NEVER claimed through one of these
        // nodes (a proof cannot rest on a coin flip), so `solved` stays false.
        chanceNodes: true,
        /* ---- the 2026-10-15 hardening pass. Each leaf fixes ONE named structural flaw; the
         * header of src/endgame_solver.js says what each is for and tests/endgame_check.js §7 pins
         * each one. They default ON because they are corrections, not preferences — but the tier
         * they sharpen still ships `enabled: false`, so the shipped RANKING is unchanged either
         * way; the only caller that runs the solver by default is the boot's background ponder,
         * and only for a Cancel-window hint. */
        // 1. a turn is SIMULTANEOUS: the opponent may not read our secret turn-t action. With this
        // off the turn falls back to the historical Stackelberg worst case (`max_i min_j`).
        simultaneousPly: true,
        // 2. recovery moves and Protect are ACTIONS, not no-ops (Protect only while the side's
        // chain is broken).
        includeRecoveryAndProtect: true,
        // 3. entry hazards on a replacement, Trick Room's timer, and end-of-turn burn/poison and
        // Leftovers chip.
        modelPhysics: true,
        // 4. a per-solve transposition cache (only exact, full-window values are stored).
        transposition: true,
        // 5. solveAcrossWorlds: a forced win must hold across every sampled world, not just one.
        multiWorld: true,
        // Regret-matching rounds for a turn matrix with no strictly dominant pure action. The
        // matrix is at most maxBranchingMoves^2 and this runs at every ply, so it is deliberately
        // small; the running average settles well inside the mate band at this count.
        regretIters: 200,
        /* 6. A PROVEN MATE OUTRANKS A FREQUENCY. Until this leaf existed the tier was a pure
         * readout: `_tiers` published `lastReadout.endgame` and NOTHING in the ranking path read
         * it, so enabling the solver could not change the line the engine plays (ATTEMPTS.md M1
         * measured exactly that: 60 paired battles, `identical`, at +31 % wall clock). With this
         * on, a report that says `solved && isMate` — which requires the transposition-checked
         * search to prove the win AND (under `multiWorld`) every surviving sampled world to prove
         * ONE with the same root action — promotes that root to the top of `ranked` with
         * confidence 100 and the other lines to 0, because a line that wins by force is not a
         * 62 %-of-the-time suggestion. The override is deliberately NOT silent: the promoted row
         * carries `mateProven`/`mateIn` and the readout carries `matePromotion`.
         * ON like the five corrections above (it is the same kind of fix: without it the tier's
         * work is thrown away), and equally inert in the shipped build, because the tier it
         * belongs to still ships `enabled: false`. */
        promoteMate: true
      },
      // Selective 2-ply beam (the multi-ply horizon upgrade, see laplace_core._refineBeam2Ply).
      // A full second ply is `|myActions| x |theirReplies| x K` evaluations and does not fit a
      // phone; this prices the SECOND turn only for the cells that can still change the answer — the
      // top `topMy` non-vetoed rows by 1-ply expected value against the top `topOpp` columns — and
      // blends the result into those cells by `blendWeight`.
      // Ships OFF. `enabled: false` (and `blendWeight: 0`) leave the 1-ply matrix bit-identical, and
      // the ablation row `beam-2ply` is what promotes it.
      beam2Ply: {
        enabled: false,
        topMy: 3,
        topOpp: 3,
        blendWeight: 0.35,
        // Weight on the Turn-2 threat differential (our best hit minus theirs, in % HP) that is
        // added to the evaluator's read of the T+1 board. 1.0 keeps the differential in the same
        // units as a percentage point of HP, which is small next to the evaluator's +/-1000 and
        // deliberately so: the differential is a tie-break beside the board read, not a payoff.
        threatWeight: 1
      },
      // The Cancel window's background ponder (src/content.js). After the fast, synchronous render
      // the boot schedules a second, DEEPER pass in a timeout: more worlds, the 2-ply beam, and the
      // endgame solver at its 3v3 bound. If the player has already clicked a move and the Cancel
      // button is on screen, the deeper ranking is compared against what they locked in and the
      // Cancel button is flagged when the deeper pass disagrees by enough to matter.
      // `cancelAlertScoreDelta` is in payoff units (compare laplace.lethalBonus 260);
      // `cancelAlertConfDelta` is in confidence points.
      deepPonder: {
        enabled: true,
        deepWorlds: 14,
        useBeam2Ply: true,
        // Run the endgame solver in the deep pass even while it ships disabled, so the deeper
        // readout can use the 3v3 bound. Phrased as a switch of its own because it is the one place
        // the ponder would lean on a tier the win-rate gate has not yet adopted.
        useEndgame3v3: true,
        cancelAlertScoreDelta: 45,
        cancelAlertConfDelta: 15
      }
    },

    /* ---------------------------------------------------------------- sampler */
    sampler: {
      K: 6,
      maxTeam: 6,
      maxResample: 24,                        // bounded retry when a set violates an observation
      minSetWeight: 0.01,                     // floor so a zero-weight set can still be drawn
      // STRATIFIED ACTIVE-SET SAMPLING. The K worlds are normally independent draws, and at K = 6
      // that routinely picks the same active candidate set four or five times while a 25 %-usage set
      // never comes up at all — and the ACTIVE body is the one every cell of the payoff matrix is
      // priced against. With this on, the first min(K, distinct legal sets) worlds cover those sets
      // one each, heaviest posterior first, carrying their own posterior weights; the remaining
      // worlds (and every bench body) are still drawn from the seeded PRNG. It changes which worlds
      // exist, never which facts are legal (a pinned set must still pass every observation check).
      //
      // SHIPS OFF, AND IT WAS MEASURED BEFORE THE DEFAULT MOVED. It was built ON — the coverage
      // argument above is a property of the DRAW, provable without a battle (tests/tuning_check.js
      // §6 does prove it) — and the first win-rate reading went the other way: switching it OFF won
      // 55.0 % against the baseline's 40.0 % on the mirror (20 paired battles, seed 1337), Δwin
      // +15.0 [0.0, +30.1] and Δscore +15.0 [+2.5, +30.0]. The match-point interval excludes zero
      // and the win interval's floor IS zero, so neither scale is evidence FOR the tier and one is
      // evidence against it. A better-calibrated opponent model that costs match points is still a
      // cost. The i.i.d. draw is the shipped build again, and `stratifyActive: true` is what the
      // ablation row now turns ON (see ATTEMPTS.md K2).
      stratifyActive: false
    },

    /* ------------------------------------------------------------------ usage */
    // The optional ladder-usage overlay (src/sets_usage.js, regenerated by tools/sync_chaos_sets.js
    // from a monthly Smogon chaos dump). It never invents a set: it only re-weights the sets the
    // curated database already holds, by how often that species actually holds that item. The
    // file ships EMPTY, so with no overlay every weight below is exactly what it was.
    usage: {
      enabled: true,
      floor: 0.05                     // least-popular supported item still draws at 5% of its weight
    },

    /* -------------------------------------------------------------- evaluator */
    // The 128D leaf evaluator. `weights` is the human-readable spec; the exact index layout is
    // documented in evaluator_128d.js and built by DenseStateEvaluator.defaultWeights().
    //
    // The weights below are the ADOPTED FIT from lib/trained-weights.json (`spec`): a logistic
    // regression over 111,820 labelled turn rows from 3,712 real ladder battles. On the fit's own
    // battle-level hold-out (21,838 rows / 3,703 battles) the projected vector scores AUC 0.7049
    // against 0.6703 for the hand vector it replaces, and a paired bootstrap over battles puts
    // that gap at +0.028 [+0.017, +0.047]. The artifact holds the fit; adopting it is this
    // deliberate edit. tests/weights_check.js pins that this block still equals the artifact's
    // `spec` modulo the two zeroed accuracy dims and the 4-decimal rounding below.
    evaluator: {
      dim: 128,
      team: 6,
      // Squashing and normalisers: the linear score is tanh-squashed into [-scale, scale].
      scale: 1000,
      tanhDenominator: 420,
      unknownHpDefault: 0.6,          // assumed HP fraction for a mon we have never seen
      threatEffSpan: 3,               // type effectiveness span mapped onto [0, 1]
      offenseBasePowerCap: 120,       // best-move normaliser (a strong STAB hit == 1.0)
      boostSumScale: 18,              // +/-3 in every stat == 1.0
      statusDifferentialDivisor: 4,
      speedEdgeSpan: 400,             // Speed points mapped onto [-1, 1]
      // The threat matrix's SPEED TERM (dims 76..111). As shipped, `faster` is binary — a body
      // that is slower by one point scores every one of its 36 threat cells at EXACTLY 0, and so
      // does a body that is slower by two hundred. That is a gate, not a bias: the fitted
      // coefficients cannot express "a slower body still threatens whatever lives through the
      // turn", because a hard 0 and a small number are different functions of the same feature.
      // The 36 cells are collapsed to two fitted means (`evaluator.weights.threat` -0.0248 and
      // `.threatActive` +0.1811, lib/trained-weights.json), and those two were fitted ON THE GATED
      // COLUMN — which is why turning this on is a REFIT, not an edit, and why it ships OFF until
      // that refit has been measured (ATTEMPTS.md §P5, §P6, §P8). On, the term is the continuous
      // decay a speed deficit implies, anchored to `evaluator.speedEdgeSpan`: 1 for a body that is
      // at least as fast, falling linearly to `floor` at a `span`-point deficit. At floor 0 it is
      // a STRICT generalisation of the shipped gate — identical for every faster body — with the
      // cliff replaced by a ramp; the tie stops being a discontinuity.
      threatSpeedGate: {
        enabled: false,
        span: 400,                    // Speed points from parity to `floor`
        floor: 0                      // the term a body a full `span` slower keeps
      },
      recoveryPPBudget: 8,            // Recover/Soft-Boiled/Roost PP from full
      hazardChip: {                   // mirror of tempo.chip, used only for the differential
        rocks: 12.5,
        spikesPerLayer: 8.3,
        toxicSpikes: 12.5,
        stickyWeb: 8,
        divisor: 37.5
      },
      protectRhythm: {                // macro dims 126/127
        protectedLastTurn: 0.5,
        consecutiveProtects: 0.5
      },
      weights: {
        // 0..23 — HP and fainting dominate every evaluation. The per-slot spread the fit saw is
        // folded into the single +/- value config.js can express (see mapToSpec, tools/fit_weights.js).
        hp: 0.9195,
        fainted: 0.5496,
        // 24..35 — my team's burn/toxic/paralysis/sleep counts (/6), the opponent's four counts,
        // then my ACTIVE mon's four status flags. Copied verbatim from the fit.
        status: [1.7295, 0.903, -1.9572, 6.1933, 0.3425, -0.3128, -1.6153, -1.8806, -0.3911, -0.1914, -0.232, -0.6362],
        // 36..47 — boosts on the active mons (ours, then theirs): atk/def/spa/spd/spe/accuracy.
        // boosts[5] and boosts[11] (the accuracy dims) are ZERO here, not fitted: the fit saw them
        // in 5 and 17 rows out of 111,820 and produced +54.7/-50.3 from those alone. The artifact
        // names both under `lowSupport`, and zeroing them is this adoption's decision.
        boosts: [-4.8376, -5.6088, -5.4306, -5.6211, -4.8935, 0, -0.8748, -0.4079, -0.2069, 0.3381, 0.1238, 0],
        // 48..55 — our hazards hurt them, theirs hurt us.
        hazards: [-3.5172, -6.8244, -6.5996, -2.6565, 3.3565, 6.567, 6.3636, 3.1761],
        // 56..63 — Trick Room is only good when we are the slower team.
        trickRoom: [0.014, 0.0265, 0.0645, -0.0685, -0.0425, 0.0384, 0.1264, -0.0795],
        // 64..75 — item knowledge is informational, not terminal.
        items: [-0.482, 0.0676, 0, 0, -0.001, 0.0029, -0.1507, 0.1644, 0, 0, -0.0881, -0.0832],
        // 76..111 — threat matrix against each defender, stronger for the active pair. The 36
        // fitted cells collapse to two means: `threat` averages the 30 off-diagonal cells,
        // `threatActive` the six i==j cells the builder overrides.
        threat: -0.0248,
        threatActive: 0.1811,
        // 112..127 — macro aggregates.
        macro: [0.6917, -1.0183, 1.3815, -1.1125, -9.2872, 1.0659, 18.372, -0.8555, 0, 0, -0.1029, 0.1519, 0.0738, -0.0738, 0.7961, -0.5051]
      },
      // The fitted coefficients are a logistic regression, whose overall scale is arbitrary: any
      // positive multiple ranks states identically (AUC is scale-invariant). But the engine does
      // not consume the vector in isolation — laplace_core._payoff adds evaluate() to FIXED
      // bonuses (laplace.lethalBonus 260, switchAteHitBonus 25, the volatility charge, the bunker
      // mask) — so the vector's MAGNITUDE is a policy choice. At its native scale the fit would
      // shrink the evaluator's influence roughly 52x and let those fixed terms decide alone.
      // 52.2 restores the spread of the hand vector this replaced, measured over the fit corpus's
      // 111,820 rows: raw-score sd 93.3 (hand) versus 1.788 (fitted spec) = 52.2, which puts the
      // delivered evaluate() on the same scale it had (sd ~219 either way). With it, the adoption
      // changes WHICH states rank higher (hold-out AUC 0.670 -> 0.705) without changing how much
      // the evaluator matters. Set to 1 to inspect the raw fit; re-measure this factor if the
      // laplace bonuses above are ever re-tuned.
      fitScale: 52.2,

      /* --------------------------------------------------- residual head (Wide & Deep) */
      // The optional non-linear half of the hybrid: `score = linear + clamp(gain * MLP(x))`.
      // The linear dot product above stays the base score and is NEVER replaced; this head is a
      // bounded correction trained on the linear model's own residuals (see src/mlp_residual.js).
      //
      // These four are TUNABLES and live here (Rule 4). The 2,081 trained coefficients do NOT:
      // they are data, generated by tools/train_mlp_residual.js into lib/mlp-residual.js exactly
      // the way tools/gen_abilities.js generates lib/species-abilities.js, with the reviewable
      // artifact and the gate verdict in lib/mlp-residual.json. Editing the numbers here would do
      // nothing, and editing them THERE without re-running the gate is the overfit this pipeline
      // exists to prevent.
      //
      // `enabled` is the gate's verdict, not a preference: the trainer sets it to true only when
      // the hybrid beats the frozen linear score on a battle-level hold-out with a paired
      // bootstrap over battles whose 95% CI excludes zero. THE VERDICT ON THE 3,521-BATTLE CORPUS
      // (107,024 rows) WAS REJECT. The frozen linear score holds AUC 0.7145 on the held-out
      // battles and the hybrid 0.7144: paired bootstrap median -0.0001, 95% CI [-0.0011, +0.0009],
      // ahead in 40.8% of resamples. Five further configurations (80 and 300 epochs, l2 1e-2 and
      // 1e-1, a 4-unit net) also failed; two of them chose gain 0, i.e. the head contributed
      // nothing at all. So it stays false, lib/mlp-residual.js ships as `null`, and the numbers
      // are in lib/mlp-residual.json. Re-run tools/train_mlp_residual.js on a better corpus and
      // flip this only if it clears the gate.
      mlp: {
        enabled: false,
        dim: 128,
        hidden: 16,
        // The residual may never move the score by more than this. Deliberately below
        // laplace.lethalBonus (260): the head can sharpen a decision but can never outvote a
        // forced kill or the veto layer on an out-of-distribution board.
        clamp: 150
      }
    },

    /* ------------------------------------------------------------------- tempo */
    // Tier 2: the Protect/Bunker stall rhythm and the policy mask built on it.
    tempo: {
      protectFresh: 0.0,              // consecutive-Protect decay when the chain is broken
      protectAfterOne: 0.67,
      protectAfterTwo: 0.89,
      rhythmNone: 0.08,               // protected last turn: a repeat is rare
      rhythmHurt: 0.85,               // one turn after a Protect below hurtHpBelow
      rhythmDefault: 0.35,
      hurtHpBelow: 70,                // "% HP or less" for the Bunker read
      healthyHpAbove: 85,             // above this, a stale Protect is less likely
      healthyPenalty: 0.12,
      trickRoomBonus: 0.08,           // stalling out TR turns is attractive
      observedProtectBonus: 0.05,
      cannotProtectPenalty: 0.25,     // the move may not even be on the set
      maxProtectProbability: 0.95,
      bulkThreshold: 280,             // hp+def+spd above which an unrevealed mon can Protect
      initiativeScale: 200,           // v2 normalisation
      threatScale: 100,               // v5 normalisation
      safeHpDefault: 60,              // assumed HP when the mon is unknown
      bunkerThreshold: 0.7,           // v4 above which the policy mask engages
      bunkerMaskBonus: 80,            // score added to Protect/setup/slow-pivot lines
      resistThreshold: 0.5,           // v6: a bench mon at or below this resists our best move
      chip: {
        rocks: 12.5,
        spikesPerLayer: 8.3,
        toxicSpikes: 12.5,
        stickyWeb: 8,
        toxBase: 12.5,
        toxicTurnsDivisor: 6,
        burn: 6.25,
        scale: 50                     // divisor normalising net chip into [-1, 1]
      }
    },

    /* ------------------------------------------------------------------- clock */
    // Opponent deliberation telemetry. The server only reveals a turn once BOTH players have
    // submitted, so `turnResolution - mySubmit` is an upper bound on how much longer the
    // opponent took than us; the smallest value seen in the battle is the network/animation
    // noise floor, and everything above it is deliberation. `switchPrior` is the ONLY thing the
    // clock changes about play: `switchPrior` decides whether the opponent's SWITCH replies
    // belong in the simultaneous matrix at all (a body that answers instantly is very unlikely
    // to be pivoting).
    // These factors are PRIORS, not measurements — they are unvalidated heuristics in the same
    // sense as tempo.rhythmHurt, and they are deliberately config-shaped so a replay corpus can
    // fit them later. Mechanically only the LOW end changes the solver today: a factor under
    // switchKeepThreshold removes their switch replies from the reply space entirely, which is
    // the "they are attacking" read. The agonised factor cannot add replies the engine already
    // enumerates, so above the threshold it is telemetry (HUD + clock.meanMs) with no solver
    // effect — stated here rather than pretended otherwise.
    clock: {
      enabled: true,
      fastMs: 1200,                   // <= this much deliberation above the noise floor reads as auto-pilot
      slowMs: 20000,                  // >= this much reads as a genuine 50/50 debate
      minSamples: 2,                  // samples before a label is anything other than 'unknown'
      maxHistory: 20,                 // per-battle decision-time ring buffer
      switchKeepThreshold: 0.5,       // below this prior, their switch replies leave the reply space
      switchPrior: {
        auto: 0.25,                   // they clicked near-instantly: assume the attack, not the pivot
        normal: 1.0,
        agonised: 1.6,                // they burned the timer: a safe pivot gets more likely
        unknown: 1.0
      },
      // Elo-adaptive switch prior. The opponent's rating is READ from the protocol, never guessed,
      // and folded into the SAME single number the solver consumes (switchFactor), so a build with
      // this family off is bit-for-bit unchanged. A mid-ladder player rarely double-switches, so
      // their pivot columns deserve less weight; a high-ladder one pivots constantly. These bands
      // are PRIORS like the deliberation factors above — unvalidated heuristics — so the whole
      // family ships OFF until a replay corpus can measure it.
      ratingBands: {
        enabled: false,
        low: 1350,                    // at or below this rating: `lowFactor`
        high: 1650,                   // at or above this rating: `highFactor`
        lowFactor: 0.05,              // below switchKeepThreshold, so their pivots leave the matrix
        midFactor: 1.0,               // identity: the band changes nothing in the middle
        highFactor: 1.6
      }
    },

    /* -------------------------------------------------------------- pp stall */
    // The Sucker Punch PP-stall counter. The counter itself needs no threshold: the remaining
    // PP is READ from the page's own battle object (src/injected.js forwards a `|stpp|`
    // snapshot), never assumed, because the max PP of a move is game data the engine may not
    // invent (RULE 1). These knobs only decide when the 3x3 payoff is worth solving and when the
    // setup threat is loud enough to say out loud.
    ppStall: {
      enabled: true,
      // Moves whose PP is worth tracking. The first entry is the one the gauge headlines.
      watch: ['suckerpunch', 'protect', 'substitute'],
      headline: 'suckerpunch',
      // Solve the 3x3 only while the watched move still has at least this share of its PP left;
      // below it the pivot has already won and the matrix is noise.
      minPpFraction: 0.2,
      // Their % HP at or below which a setup-click read is worth printing.
      setupThreatHp: 80,
      // How many turns of patience the advised line assumes (the solver's horizon is 1 ply; the
      // advice string says so explicitly rather than pretending otherwise).
      adviceLabel: 'PP-stall pivot'
    },

    /* ------------------------------------------------------- format sentinel */
    // The Z-Move / Mega Trap sentinel. Every number here is read off state.formatLocks, which the
    // state manager fills from the protocol; this section only names the labels and decides how
    // loud the "both mechanics burned" line is.
    sentinel: {
      enabled: true,
      // "Their remaining bench cannot hold a Mega Stone / Z-Crystal" is only printed when at
      // least this many opposing bodies are still unrevealed-or-unmegaed AND the pool agrees.
      minBodiesForFreedom: 1,
      freedomLabel: 'TACTICAL FREEDOM',
      burnedLabel: 'BURNED',
      liveLabel: 'LIVE'
    },

    /* -------------------------------------------------------------------- veto */
    // The deterministic blunder layer. A veto is not a preference: it zeroes the line.
    veto: {
      codes: {
        VETO1: 'PROTECT_RHYTHM',
        VETO2: 'ABILITY_IMMUNITY',
        VETO3: 'LONE_TR_SETTER',
        VETO4: 'SPEED_SUICIDE',
        VETO5: 'CONTACT_SUICIDE',
        VETO6: 'SUCKER_PUNCH_SETUP',
        VETO7: 'TR_SELF_CANCEL',
        VETO8: 'WASTED_HAZARD_CLEAR',
        VETO9: 'CONSECUTIVE_PROTECT',
        VETO10: 'MAGIC_BOUNCE_REDIRECT',
        VETO11: 'SATURATED_HAZARD',
        VETO12: 'REDUNDANT_FIELD'
      },
      protectRhythmThreshold: 0.75,   // v4 above which attacking into the bunker is a blunder
      loneTRSetterThreat: 70,         // incoming % above which sacking the last setter is a blunder
      contactPunishHp: 29,            // hard ceiling: never refuse contact above this % HP
      suckerPunchSetupHp: 80,         // their % HP above which a setup/recovery click is likely
      maxLog: 40,                     // veto history kept for the HUD
      // The five board-state vetoes. Each one is off-able on its own, because they are policy
      // (what this trainer refuses to click) rather than deductions about the opponent.
      wastedHazardClear: true,        // Defog/Rapid Spin with nothing on our side to clear
      consecutiveProtect: true,       // the Protect counter cannot succeed twice in a row
      magicBounceRedirect: true,      // a hazard into Magic Bounce lands on our side instead
      saturatedHazard: true,          // a hazard past its layer cap sets nothing
      redundantField: true,           // re-setting the weather that is already up
      // Only a re-set with MORE than this many turns left is redundant: at 1 turn the refresh is
      // the correct line, which is the whole reason the threshold exists.
      redundantFieldMinTurns: 2
    },

    /* --------------------------------------------------------------- trickRoom */
    trickRoom: {
      turns: 5,
      speedRankBase: 10000,           // rank = base - speed under TR, so the slowest wins
      alertFinal: '⚠️ TR EXPIRING NEXT TURN: Attack or sack setter; DO NOT hard-switch healthy breakers!',
      alertTwoLeft: 'TR: 2 turns left — land your chip now; the last turn is for the sack.',
      maxHistory: 40
    },

    /* --------------------------------------------------------------------- hud */
    hud: {
      high: 50,                       // confidence % at or above which the badge is green
      mid: 25,                        // ... gold at or above this, slate below
      low: 0,
      confidenceLabels: { high: 'HIGH', mid: 'MID', low: 'LOW', veto: 'VETO' },
      bannerSep: '  ·  ',
      // Layout mode. 'auto' picks by viewport width (mobile below 1024 px, desktop at and
      // above), 'mobile' forces the phone layout, 'desktop' forces the docked console
      // built for a 640 px-wide arena column. The HUD exposes a one-tap toggle that flips
      // between 'mobile' and 'desktop'; 'auto' is the reset state and is also the
      // options-page default.
      layoutMode: 'auto',
      layoutBreakpoint: 1024,         // 'auto' switches to 'desktop' at this viewport width
      // Lethal-roll gauge bands (KO probability %, from the library's own koChance): at or
      // above `guaranteed` the bar is green, at or above `high` gold, at or above `mid` slate.
      lethal: { guaranteed: 100, high: 67, mid: 34 },
      // Haptics on Android. The pattern is the brief's own ([40, 60, 40] ms on/off/on) and is
      // fired once per battle, on the turn Trick Room drops to its last turn.
      vibrate: { enabled: true, pattern: [40, 60, 40], trLastTurn: true },
      benchStripMax: 6,               // pills rendered in the bench-tap strip
      // The PP-stall gauge and the format sentinel bar (the two "sweaty" HUD readouts).
      ppGauge: { label: 'PP' },
      sentinelBar: { maxTactics: 3 },
      // Supreme Overlord readout: the multiplier is MEASURED from the library (the same move
      // against the same probe defender, with `alliesFainted` = fallen vs 0), never modelled,
      // because RULE 1 forbids writing the ability's own rule down here.
      overlord: { probeMove: 'Kowtow Cleave', probeDefender: 'Great Tusk' },
      receipt: { maxDamageRows: 5, copyLabel: 'Copy Summary' },
      // The Turn-0 lead advisory card (src/laplace_core.js leadAdvisory + src/content.js at
      // `|teampreview|`). Unlike the risk-tuning tiers this is a MEASUREMENT — the evaluator scores
      // each pair of bodies — so it ships ON; `enabled: false` suppresses it entirely.
      leadAdvisory: { enabled: true }
    },

    /* --------------------------------------------------------------------- llm */
    llm: {
      // Hard AbortController budget for ONE provider round trip, in ms. It has to be a budget a
      // hosted model can actually meet: at the previous 600 ms the caller's own timer and the
      // service worker's abort both fired before any provider could answer, so the optional
      // readout was dead while looking wired. 20 s is generous for a <80-token completion and
      // still bounded, so a hung socket cannot hold the HUD. src/background.js carries the same
      // number as its fallback and does NOT hardcode a second budget: the client sends this value
      // with the request, and tests/config_check.js asserts the two literals agree.
      timeoutMs: 20000,               // hard AbortController budget
      geminiModel: 'gemini-3.5-flash-lite',
      openrouterModel: 'google/gemini-2.0-flash-lite-001',
      geminiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/',
      openrouterEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
      maxPromptWords: 150,
      maxReasonWords: 15,
      systemPrompt: 'You are an elite Pokemon Showdown grandmaster. Never calculate math. ' +
        'Rely strictly on the provided damage ranges. Output strictly valid JSON: ' +
        '{"action": "Move", "confidence": 85, "reason": "Max 15 words."}'
    },

    /* ------------------------------------------------------------------ pruner */
    pruner: {
      maxReasons: 24,                 // human-readable deduction trail kept per mon
      maxEvidence: 12,
      speedMaxCeiling: 1012,          // Regieleki @ Choice Scarf, L100, +Spe, 252 EV
      speedFloorFallbackKeep: 4,      // fastest candidates kept when NO set can reach the floor
      // Reverse damage deduction: an observed hit on OUR mon is run back through every
      // candidate spread of the mon that threw it, and a set whose damage range cannot cover
      // the observed percentage is dropped. The tolerances are the whole safety story — a
      // critical hit, an unknown stat boost, a screen we failed to model or Showdown's own
      // integer HP rounding all land inside `slackPct` / `slackRel` instead of eliminating a
      // set that is really correct.
      damageEvidence: {
        enabled: true,
        slackPct: 3,                  // absolute percentage points of slack on each bound
        slackRel: 0.15,               // plus this fraction of the computed bound
        minDamagePct: 5,              // ignore chip below this: rounding noise, not evidence
        maxObservations: 8,           // bounded per-mon evidence log
        maxSetsTested: 64             // cap on sets probed per observation (keeps a turn cheap)
      },
      // The DISCRETE half of reverse damage. Pokemon damage is not a continuous interval: it is
      // one of 16 integer rolls. When the protocol prints an exact percentage, only the sets
      // whose own 16 rolls can round to that integer percentage are still possible — which is
      // how an exact EV spread gets pinned instead of guessed. The check is a REFINEMENT only:
      // it can never empty a pool (the fallback keeps the pool and logs a reason), and
      // `slackPct` widens the accepted integer window on each side.
      discreteRolls: {
        enabled: true,
        slackPct: 0.05,               // +/- this many percentage points around the observed value
        // Observations needed before a pool collapse is allowed to report an EV pin. A single
        // hit can match several spreads by coincidence; two independent ones rarely do.
        requireObservations: 2
        // No separate probe cap: the discrete test runs on the SAME cached calculation as the
        // range check above it, so it is bounded by pruner.damageEvidence.maxSetsTested.
      },
      // Residual-order speed telemetry. End-of-turn residual damage/heal resolves in Speed
      // order, so the FIRST of two bodies printed in one residual block is the faster. That is
      // a relative order, not a number, so it is applied against the other body's believed speed
      // and every application is allowed to fail soft (see pruner.applyResidualOrder).
      residualOrder: {
        enabled: true,
        // How much of the observed order to trust when it needs a believed speed to become a
        // floor. 1 = use the other body's speed exactly; 0 = record the order and do nothing.
        trust: 1.0
      },
      // The optional scouting prior (src/scout_prior.js, regenerated by tools/scout_replays.js
      // from the opponent's own recent replays). Like the ladder overlay it only ever re-weights
      // sets the curated database already holds; it can never add one. `maxBend` is how far a
      // fully-observed item/move can move a candidate's weight, as a fraction (0.5 = +50%).
      scout: {
        enabled: true,
        maxBend: 0.5
      },
      // TEAM-PREVIEW SYNERGY (src/set_pruner.js, `_applyTeamSynergyPrior`). The |poke| frame names
      // their whole six before a single set is revealed, and that composition is evidence about
      // EACH body's set: a Pelipper on their team makes a Swift Swim / Hurricane set far more
      // likely than the curated average, a Trick Room setter makes a 0-Spe set likely, and a
      // SECOND Stealth Rock carrier is unlikely once one body has already shown the move (a team
      // rarely carries two copies of a hazard it only needs once). Every factor is a BOUNDED
      // re-weighting of the pool the pruner already holds — it can never add a set, and a set a
      // deduction removed is not resurrected — and it is recomputed from each set's BASE weight,
      // so the call is idempotent. Ships ON as a prior; NOT measured.
      synergy: {
        enabled: true,
        weatherFactor: 1.35,      // a weather-benefiting set when the setter is on their team
        trFactor: 1.25,           // a Trick Room set when a TR setter is on their team
        srDuplicateFactor: 0.25   // THIS body's Stealth Rock when another body has revealed it
      },
      // Ability deduction via negative space (src/set_pruner.js, tables in src/util.js). Each rule
      // turns something the log PRINTED into an elimination, in the same spirit as the item rules
      // above: the status a body carries, and damage only a grounded body can take, are both
      // positive evidence against the candidate abilities that would have prevented them.
      // `absenceRules` is the one that reasons from a MISSING announcement (Intimidate or a
      // weather/terrain surge that never fired on switch-in). It ships OFF because Neutralizing
      // Gas and similar suppression can silence that announcement, so it needs suppression
      // tracking and a measurement before it is allowed to eliminate anything. `enabled` is the
      // master switch; the three sub-knobs let one family be turned off on its own.
      abilityDeduction: {
        enabled: true,
        statusRules: true,          // an observed status disproves the abilities that block it
        groundRules: true,          // grounded-only damage disproves Levitate / Earth Eater
        absenceRules: false         // a switch-in ability that never fired disproves its sets
      }
    },

    /* ------------------------------------------------------------------- state */
    state: {
      maxActiveStints: 8,             // moves remembered per stint for the choice-lock rule
      maxLog: 200
    }
  };

  /** Walk a dotted path. Returns `fallback` only when the path (or the config) is missing. */
  function configGet(path, fallback) {
    if (!path) return fallback;
    const parts = String(path).split('.');
    let node = CONFIG;
    for (let i = 0; i < parts.length; i++) {
      if (node === null || node === undefined || typeof node !== 'object') return fallback;
      node = node[parts[i]];
    }
    return node === undefined ? fallback : node;
  }

  /** Deep clone of the config — used by tests and by a debug HUD. */
  function configSnapshot() { return JSON.parse(JSON.stringify(CONFIG)); }

  /** Replace tunables at runtime (tests, power users). Shallow-merged section by section. */
  function configMerge(patch) {
    if (!patch || typeof patch !== 'object') return CONFIG;
    Object.keys(patch).forEach(function (section) {
      const incoming = patch[section];
      if (incoming && typeof incoming === 'object' && !Array.isArray(incoming) &&
          CONFIG[section] && typeof CONFIG[section] === 'object' && !Array.isArray(CONFIG[section])) {
        Object.keys(incoming).forEach(function (k) { CONFIG[section][k] = incoming[k]; });
      } else {
        CONFIG[section] = incoming;
      }
    });
    return CONFIG;
  }

  ST.CONFIG = CONFIG;
  ST.configGet = configGet;
  ST.configSnapshot = configSnapshot;
  ST.configMerge = configMerge;
})();
