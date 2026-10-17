# Attempts — everything this project tried, and where it led

**Read this before you build a scoring change.** The point of this file is that a future contributor
(or a future agent) can search it for the *shape* of an idea and find out it was already tried,
what it measured, and why it is not in the shipped build — without re-deriving the answer from three
changelog sections and a 25-row table.

`README.md` says what is true now. `CHANGELOG.md` carries dated provenance, newest first.
`.md` files are prose; this one is a **register**. When a row here and a row anywhere else disagree,
the artifact in the "evidence" column wins, and this file is wrong — fix it.

Status vocabulary, and it is deliberately not two-valued:

| status | means |
|---|---|
| **ADOPTED** | a gate said so, and it is in the shipped build |
| **REJECTED** | measured, lost, ships OFF (or was never built) — do not rebuild without new evidence |
| **INERT HERE** | the row is flat because this harness cannot supply the feature's input, or never presents the situation the feature acts on. **Not** evidence about the feature |
| **UNRESOLVED** | measured flat and no cause is established. Also **not** neutral |
| **OPEN** | measured, decision not yet taken, or known and deliberately not fixed |

---

## 0. The two measurements, and why both exist

This repository keeps **policy agreement** and **playing strength** strictly apart, because they have
been observed to disagree in both directions:

* **Policy agreement** — `tools/benchmark_human_match.js`: how often the engine's top line is the line
  an elite human actually clicked, over a replay corpus. Cheap (one replay pass), and it answers "is
  the engine doing something a good player recognises?" **It can motivate a change. It can never
  adopt one.**
* **Playing strength** — `tools/run_ablation.js`: the win rate against the adversarial league on
  paired seeds, with a 95 % percentile interval from a 2000-resample paired bootstrap **on the win
  indicator**. This is the gate. `--battles 60` is what most rows here were measured at; `--battles 500`
  is the number to quote.

The proof that they are not substitutes is row **B1** below: a single change raised agreement by
**12.3 points** and cost **26.7 win points**. A metric that improves while the engine gets worse is
not a proxy for strength, it is a different question.

Two traps the tooling now refuses to let you fall into:

* **A flat row is not a neutral result.** `identical` (the variant reproduced the baseline in *every*
  battle) is the signature of a flag whose input this harness does not supply — see §D. Everything
  else flat is `no measurable effect at this sample size`, which is a statement about the sample.
* **The verdict is about the FEATURE, not the variant.** A tier measured by switching it OFF improves
  the variant exactly when the feature *hurts*. Every row declares which way its patch points.

---

## A. Adopted (in the shipped build because a gate said so)

| # | attempt | mechanism | evidence | status |
|---|---|---|---|---|
| A1 | **Turn urgency** (`laplace.urgency`) | bounded, ramping bonus for COMMITTING rows (a real attack or a setup move) over passive ones past `startTurn`, multiplied at `breakoutTurn`; re-ranks rows, cannot override a veto | 60 paired battles, all three personas, seed 1337: win **68.3 % → 96.7 %**, Δ **+28.3 [+18.3, +40.0]**, and the 100-turn cap ties — *every* tie the baseline played — **17/60 → 1/60**; p90 turns 101 → 89. **Re-anchored 2026-10-13** on the fixed instrument: Δ **0.0**, flagged `stall` — but the baseline is now **98.3 %** win, so the benefit urgency delivered *has become the baseline*. That is a ceiling, **not a refutation**: an instrument that already wins every game cannot price what made it win. Re-pricing urgency needs a stronger opponent, not a longer run. **Reproduced on the mirror (§J, 2026-10-14):** urgency OFF took cap ties **1/60 → 14/60** and mean turns **62.3 → 75.2** — the mechanism, on an instrument that never saw the adoption run. Win indicator flat (−1.7 [−18.3, +15.0]) because the OFF variant turned the baseline's losses into ties rather than wins; its SCORE delta is **+9.2** toward OFF | **ADOPTED** 2026-10-12 |
| A2 | **The fitted 128D vector at a measured scale** | `fitScale` 52.2 restores the evaluator's influence on the blend | held-out AUC **0.670 → 0.705** | **ADOPTED** |
| A3 | **Memoisation of the hot damage/name path** (`toID`, `getMoveData`, the id→raw index) | pure caching, no policy change | real boards: mean **96.3 ms → 30.7 ms**, p95 **132.7 ms → 47.5 ms**; bit-identical — same 432 `_payoff` cells, same vector, same rankings to 17 significant figures over 390 boards | **ADOPTED** |

A1 is the **only** policy tier this project has ever adopted on a measured win rate, and its shape is
the lesson in §G: it did not tell the engine to stop doing something, it **converted cap ties into
wins** (16 of the 17) by making progress outrank passivity late in a game.

---

## B. Rejected after measurement

| # | attempt | mechanism | measured | status |
|---|---|---|---|---|
| B1 | **The pivot tax** (`laplace.switchTax`, id `switch-tax`) | flat score drag on every SWITCH row, so a pivot must beat the best attack by `points` before it takes the top line; folded into the mix matrix *and* the row score | **agreement went UP**: top-1 **31.7 % → 44.0 %** (contested 25.5 % → 31.9 %), pivot rate 55.4 % → 29.2 %. **Strength went down**: 96.7 % → 70.0 %, Δ **−26.7 [−38.3, −15.0]**, and the 100-turn cap ties came back **1/60 → 18/60** (30 % stall, capped games only 4.1 of 12 bodies down — a standoff) | **REJECTED**; ships OFF, row kept in the table. **Re-anchored 2026-10-13** on the fixed instrument and the rejection is CONFIRMED, now in the arena as well as in agreement: `switch-tax` **HURTS, −31.7 [−43.3, −20.0]** (98.3 % → 66.7 %, 20 capped games, flagged `surprise` against its `expect: helps`) |
| B2 | **The residual head** (`config.evaluator.mlp.enabled`) | 128 → 16 → 1 ReLU correction on the frozen linear score, bounded to ±150 | rebuilt corpus 3,521 battles → 107,024 rows: **0.7145 → 0.7144**, median **−0.0001**, CI **[−0.0011, +0.0009]**, ahead in **40.8 %** of resamples. Five further configurations (80/300 epochs, `l2` 1e-2 / 1e-1, a 4-unit net) also failed; the best posted +0.0012 with a CI straddling zero | **REJECTED**. Note where its gate lives: this row has **no arena row** — it is gated by `tools/train_mlp_residual.js`'s own battle-level hold-out plus paired bootstrap, not by `run_ablation.js`. `lib/mlp-residual.js` ships as `null` so a stray config edit cannot switch it on |
| B3 | **Cross-product features** (`tools/select_cross_features.js`, `--crosses`) | products of the 128D vector's own dimensions | **0.7005** projected on the battle-level hold-out against the adopted vector's **0.7049**; median 0.0000, CI **[−0.0047, +0.0015]**, ahead in **41 %** of resamples | **REJECTED** (a documented negative result) |
| B4 | **Naive MLP early-stopping** | selected the gain on the *training-half* AUC | train **0.8616** vs held-out **0.6757** — a large apparent win that was a large loss. Rows are consecutive turns of ONE battle and share its label, so the effective n is the ~2,800 battles, not the ~85,000 rows. Fixed with a grouped split **inside** the training half; on that corpus the inner-validation minimum was at **epoch 0** | **REJECTED** (kept behind `--no-early-stop` as a diagnostic) |
| B5 | **Conditional VETO4** ("do not veto a doomed attack when they have setup/hazards, or when every switch-in eats >50 %") | proposed softening of the hard veto | **never built** — its premise was measured first and refuted: suppressing VETO4 leaves the pivot rate essentially unchanged (**53.1 % → 53.7 %**) and moves top-1 by a paired net of **−22** | **REJECTED (premise)**; see §F2 |
| B6 | **`MobileHUD.clear()` as the hook for audit defect B17** | reuse `clear()` on the init event | rejected on inspection: `clear()` also removes the drawer and its toggle and sets `_bound = false`, so it would need `bindDrawer()` immediately after and would blank the team-status readout | **REJECTED (design)** |
| B7 | **Memoising `_speedOf`** | cache the speed lookup | deliberately **not** memoised: its key is the slot plus the body id plus the species, which **collides** for a body whose item, ability or boost changed within the same slot — a stale speed would be a wrong speed race | **REJECTED (correctness)** |
| B8 | **The own-move leaf effects** (`laplace.priceMyMoveEffects`, id `pricemymoveeffects`) | `_payoff` writes OUR own non-damaging move's board change onto a SHALLOW copy of the leaf field — the 29 setup moves' stat stages and HP price, the hazard setters' layer, the removers' clear, plus our boosted Def/SpD inside that turn's reply — where before those three channels (dims 24..55) were identical across every candidate row, so the evaluator's own fitted dims were being handed a board that never changed | **fidelity UP, strength FLAT WITH A NEGATIVE SIGN.** Paired 200-battle replay, same corpus / battles / seeds: top-1 **34.6 % → 36.9 %**, median regret on MOVE clicks 0.008 → **0.001**, 30 %+ give-ups 35.3 % → 33.6 %, McNemar **240 fixed / 136 broken, chi2 28.2, p < 0.001** (§P6). The win-rate gate §P6 asked for, run at last, is a NULL on both instruments — 60 paired battles each, seed 1337: personas **83.3 % → 80.0 %**, Δwin **−3.3 [−11.7, +5.0]**, Δscore **−2.5 [−10.0, +4.2]**; mirror of itself **48.3 % → 46.7 %**, Δwin **−1.7 [−16.7, +11.7]**, Δscore **−4.2 [−18.3, +9.2]** (§P7) | **REJECTED for shipping — the gate is a NULL and both point estimates are negative**; read it as §0's "no measurable effect at this sample size", not as a defined loss. Ships `false`; its `expect: helps` was a pre-registration the run did not confirm. The row-LOCAL contract is pinned in `tests/tuning_check.js` §4d, and the two channels it deliberately left unwritten are C4. A re-proposal needs a stronger instrument or 500 battles, not another 60-battle run |
| B9 | **The threat matrix's speed gate, softened** (`evaluator.threatSpeedGate`) | replaces `faster = mySpeed >= oppSpeed ? 1 : 0` — which zeroes all 36 threat dims (76..111) the moment we are not strictly faster, at a tie as well as a hundred points behind — with a linear decay from 1 at parity to `floor` at a `span`-point deficit, anchored to the same `speedEdgeSpan` the macro dims use | **the refit it forces is a LOSS out of sample.** Fresh extraction of the same corpus with the gate off and on (the gate moves dims 76..111 and nothing else: 1,394 of 1,426 probe rows, max |Δ| 0.99), each arm fitted with the artifact's own settings (`--lambda 0.5`, battle-level grouped hold-out): scoring the exported vectors, hold-out AUC **0.7105 → 0.6971**, Δ **−0.0134 [−0.0262, −0.0012]** (2,000-resample battle-level paired bootstrap, **1.3 %** of resamples positive); sign accuracy at 0.5 **65.5 % → 64.7 %**. The gate WITHOUT the refit is a null on the decision instrument — 200 paired battles, top-1 **34.6 % → 35.0 %** (±0.9), move-vs-move 33.7 % → 34.1 %, move top-1 64.8 % → 64.9 %, McNemar **25/19, chi2 0.57, p ≥ 0.1**, move-half median gap 34.9 → 36.2 (wrong way) | **REJECTED**; ships `false`, the refit recorded rather than adopted (§P8). What it does buy: P5's collinear split shrinks (`macro[4]` hazard differential **−3.33 → −2.95** against the shipped **−9.29**) — readable weights are the precondition for reading a coefficient, not a reason to accept a worse model. **Its own finding:** the fresh OFF fit scores **0.7105** against the shipped artifact's **0.7011** and carries 2 clamped low-support dims instead of 8, and 106,956 of the 107,024 re-extracted rows differ from the shipped corpus — **the artifact is stale**, and replacing it is a separate gate |

---

## C. OPEN — measured, decision not taken

| # | attempt | measured | why it is still open |
|---|---|---|---|
| C1 | **`quiescence` (the setup punisher)** — prices the opponent's boosted reply and their Protect inside the cell | **SUPERSEDED — the sign has FLIPPED.** The old reading was `feature HURTS`: removing the whole tier won **+19.3 [+12.0, +26.7]** (66.7 % → 86.0 %, cap ties 46/150 → 15/150), with the harm attributed entirely to `extendSetup`. Re-measured 2026-10-13 at the standard sample on the fixed instrument (see §H), switching `extendSetup` off **LOSES 20.0 [−30.0, −10.0]** (98.3 % → 78.3 %, 13 capped) — so the knob **HELPS** — while switching the whole tier off is **−5.0 [−11.7, +1.7]**, not measurable at this sample. **Then the mirror disagreed (§J, 2026-10-14):** the same patch, 60 paired mirror battles at seed 1337, wins **+23.3 [+8.3, +38.3]** (41.7 % → 65.0 %, capped 2/60 → 4/60) — i.e. **feature HURTS**, flipped and `surprise`-flagged against its `expect: helps` | **CLOSED 2026-10-13 — and it closed against the old verdict.** The open question was whether the harm survived the urgency change; it does not survive the *instrument* fix. The old number was taken on a build whose arena fed the engine a one-Pokemon team (§H), so it measured a crippled engine and is **not quotable**. On the fixed instrument the tier ships ON with a measurement **supporting** it. **REOPENED 2026-10-14 by §J:** the mirror reads the opposite way (**HURTS, +23.3**), so the row is now **DISPUTED — one instrument each way**, both intervals excluding zero, and the knob stays where it ships until a higher-power row (500 battles, a second seed, or a declared stronger opponent) breaks the tie. The mirror is the instrument WITH headroom (41.7 % baseline vs §H's 98.3 % ceiling), but a self-play number also prices how exploitable a frozen twin is, which is not the same question as strength against a human — so neither reading is quotable as "the" answer yet. **AMENDED 2026-10-14 by §K:** a third run (20 paired battles per instrument) reproduced the mirror's sign (+10.0, flat at that power) AND produced the same sign on the personas — the tier off won **+25.0 [+5.0, +45.0]** with the exploiter's five 100-turn stalemates as the whole of the movement — so **both instruments now lean HURTS** and §H's HELPS +20.0 is the outlier. That is still not the power to move a shipped default (n = 20, one seat's five games), so the tier stays where it ships; §K3 names the run that can settle it and reports that the `followUpWeight` hypothesis came back DISARMED. **SETTLED FOR ONE LEAF 2026-10-15 by §K6:** the 60-battle version of that run moved `quiescence.blockProtect` to **off** (+15.0 win [+6.7, +23.3], +7.5 match score [+3.3, +11.7], cap games 11/60 -> 2/60, and the whole movement is the `exploiter` seat going 4-0-11 -> 13-0-2), while `extendSetup` stayed ON because its own arm's floor on the win indicator is −5.0 and its match-point floor is exactly 0.0 — **and §K6b then SETTLED that half too, in the tier's favour:** with the block already off, removing the setup ply costs −40.0 win [−55.0, −25.0] and −20.0 match score [−27.5, −12.5] on a second seed, so the personas' earlier "no effect" reading was the seat being saturated by the mispriced shield. Both halves are now decided, in opposite directions; **this row's status line above is history** |
| C2 | **VETO4 (`SPEED_SUICIDE`) firing on stale speed information** | 106 of the 177 elite clicks the guard refuses are this one code | unproven either way. The question is whether those refusals are boards where the human was right because the engine's speed estimate was blind to the field (an unrevealed Scarf, a weather ability, Tailwind). Answering it needs the **speed race itself instrumented**, which has not been done. Suppressing the rule is *not* an answer — see §F2. |
| C3 | Smaller open defects | see the "Known — open, from the same review sweep" list in `CHANGELOG.md` (`residualOrder.trust` shipping at 1, `shelter`'s unverified effect, G-Max Steelsurge's flat 12.5 %, two HUDs double-handling a bench tap, the Protosynthesis ceiling's sun/terrain case) and the deliberate-omission list in `BUGS_AUDIT_REPORT.md`. **TWO ARE NOW CLOSED** (2026-10-14): `mon.knockOffSurvived` was a read of nothing (the live field is `mon.itemKnockedOff`, now withheld for a Sticky Hold body), and the whole-`possibleAbilities` hard veto in VETO2 became a proof requirement. The Protosynthesis / Quark Drive SPEED misread is fixed for every speed layer, but the ceiling's sun/terrain-only case is not | four remain open, each with its narrow fix |
| C4 | **The other two leaf channels** (`laplace.priceMyMoveStatus`, `laplace.priceMyMoveProtect`) | our status-inflicting move writes the condition onto THEIR leaf body (refused wherever the board says it cannot land: already statused, type-nullified, `STATUS_TYPE_IMMUNITY`, a powder into a Grass body, a REVEALED immunity ability), and our own Protect is priced as the shield it is — their reply deals nothing, the leaf carries the Protect rhythm, a CONSECUTIVE Protect fails, and the Feint-style piercers are not blocked | fidelity on the same paired 200-battle instrument §P6 used: top-1 **34.6 % → 35.4 %**, move-vs-move 33.7 % → 34.9 %, and on the two families they write — Protect **35.9 % → 47.3 %**, status infliction **31.4 % → 41.8 %** — with McNemar **90 fixed / 22 broken, chi2 40.1, p < 0.001**. Neither family crosses its own uniform floor yet (Protect −5.5, status −14.3 pp), and status infliction's gap POPULATION rises 96 → 106 while its median falls (§P7) | **the win-rate gate was RUN and came back `[identical]` — the instrument cannot carry the flag**, which is not the same thing as a null: 60 paired mirror battles, seed 1337, reproduced the baseline in EVERY battle (same winner AND same turn count, Δwin +0.0 [+0.0, +0.0]), because `run_arena.js` hard-codes the ENGINE seat's team to `hazardStackBalance` and that team's 24 moves contain no Protect-family move and no status-inflicting move — and both tiers write only OUR OWN move's leaf transition, so the switch has nothing to price. A re-run of the same command reproduces the same silence; the engine-seat team (or a `run_arena` option for it) is what has to change first, and `--agent all` does not help because the personas are the WRONG SEAT (§P7). Both ship `false` |
| C6 | **Conditional-move failure** (`laplace.conditionalMoves`, ids `conditionalmoves`, `conditional-suckerpunch`, `conditional-firstturn`, `conditional-flinch`) | three game rules the 1-ply cell was pricing as unconditional damage: Sucker Punch connects only if the target selects an ATTACKING move (it fails into a switch, a setup move, a status click, a Protect — and into the switch-in body the switch column had resolved); Fake Out / First Impression fail unless the user has not yet acted since it entered; and a landed Fake Out FLINCHES, taking the target's whole click away. Applied to BOTH sides, because their Sucker Punch and their Fake Out are reply columns in the same matrix | **no reading yet — the three rules ship ON on the argument that they are game rules, NOT on a gate.** What is established without a battle is the mechanism: `tests/conditional_check.js` (65 checks) pins the classifiers, both readings of "first turn out" (the `|move|` stamp and the turn window — the second exists because a body flinched through its whole stint never emits a `|move|` line), the failing and passing cells in both directions, the flinch blockers (revealed Inner Focus / Shield Dust / Covert Cloak only), and the EXACT pre-tier number each of the three knobs restores when off. The switch-column check is an identity: the cell equals the leaf board where nothing was hit, at the switch-in's hazard-adjusted HP | **the win-rate gate is UNRUN for all four rows** — the flags shipped ON because crediting a move that fails is the defect class the repo's own black-box rule forbids, and because the alternative was to keep recommending Sucker Punch into a predicted switch. The four ablation rows exist so that judgement can be priced. **Two of them are INERT BY CONSTRUCTION**: none of the six sample teams carries Fake Out or First Impression, so the engine seat never holds one to fail — while the Sucker Punch half does have a corpus (Kingambit is on `hazardStackBalance` and `voltTurnOffense`). Adding a Fake Out team is the prerequisite for pricing the other two. NOT modelled: Upper Hand (requires a PRIORITY click, not merely an attack), move order (Sucker Punch's +1 bracket still does not decide who swings first — only the failure condition is priced), Substitute, and the 30 %-flinch riders |
| C5 | **The KO cliff on the exact 16 rolls** (`laplace.rollKoBranch`, id `rollkobranch`) | `_payoff` moved the target by `avgPercent`, the MEAN of the 16 rolls, and clamped at 0 — so a mean 1 % past the target was priced as a certain OHKO nothing answered from, while a mean 3 % short left it alive with its reply landing in full. On, the transition becomes the expectation over the two outcomes, `(1 - p) x survives`, with `p` the exact share of rolls that reach (`koChanceExact`, already computed by `calc_engine` and thrown away by `_payoff` before this), the surviving branch floored so 15-of-16 is not a KO | **no reading yet — the flag ships `false` on an UNRUN gate.** What IS established without a battle is the property the tier exists for: the discontinuity is gone, the transition is monotone in `p`, and both endpoints (`p` 0 and 1) reproduce the shipped scalar exactly, pinned as identities in `tests/quiescence_check.js` §8 (127 checks) rather than as constants. The damage result's SHAPE is unchanged while the tier is off, which is what keeps the shipped behaviour bit-identical | **UNRESOLVED, and its ceiling is bounded by construction**: the flag now carries BOTH halves. The HP half is `(1 - p) x survives`; the ordering half adds the `p x V_KO` branch, and it does not invent a speed assumption to get it — `_payoff` asks `_turnOrder` (priority, then Speed through Trick Room) and, only when the faster side's hit has a FRACTIONAL exact chance `p` of fainting the slower one before it moves, scales the slower side's damage by `(1 - p)`. An undecidable order (a tie) and the endpoints `p` 0 and 1 keep the symmetric pricing, so no cell claims a turn the board cannot establish, and every cell that was never ambiguous is bit-identical. A positive reading is therefore no longer a lower bound on the correction — but it is still UNRUN, so it is a prior. Not modelled either: accuracy (a MISS is not a roll) |
| C7 | **Choice-lock physics, both directions** (`laplace.choiceLock`, ids `choicephysics`, `choicephysics-opplock`, `choicephysics-risk`) | a Choice-locked opponent was priced as if their whole list were legal, so the matrix offered replies the game will refuse; and on our side clicking a move while holding Choice commits us to it against the switch that punishes it (a living bench body that is `0x` immune, by type or a confirmed ability), which was priced at zero | **no reading yet — ships ON as a game rule (the opponent half) and as a rule about our own commitment (the risk half).** Established without a battle: `tests/upgrades_check.js` §7 pins the lock to a world with a known Choice item AND a revealed stint move, pins that a fresh stint (no revealed move) is NOT locked, that `oppLock: false` restores the full column set, and that the risk charge fires only for a LIVING, non-active, `0x`-immune bench body while switching, a status move, a pivot, an already-locked body, a non-Choice item, `cannotBeChoice`, and `enabled: false` all charge 0 | **the win-rate gate is UNRUN for all three rows.** The opponent half cannot be tested on a board whose item is unknown — `isChoiceItem` reads the revealed item, so a hidden Scarf is out of scope by construction rather than half-priced. The risk half is deliberately a FLAT charge (`riskPenalty`), not a probability over what they bring in: the leaf has a bench but no distribution over which body they choose, and inventing one would put a guess into every row. Substitution moves (Trick, Switcheroo) and item-removal restoring the choice are not modelled |
| C8 | **Team-preview synergy prior** (`pruner.synergy`, id `pruner-synergy`) and **the win-con chip bounty** (`laplace.wincon.maxBounty`) | `|poke|` carried their six names and the pruner ignored them; and the win-con ledger credited only `faintedIds`, so chipping a roadblock from 90 % to 40 % — exactly how a wall stops answering our sweeper — was worth nothing | **the synergy prior ships ON as a PRIOR, not a proof**: it multiplies a candidate set's BASE weight (a Drizzle body lifts their Rain sets, Drought the Sun sets, `U.TR_SETTERS` plus slow breakers the Trick Room sets, otherwise 1.35 / 1.25 / 0.25 lever factors), and it is applied only to candidates that survived every hard deduction — pinned in `tests/scout_check.js` §7b, including that a factor can never resurrect a dropped set and that a second call rebases instead of compounding. The chip bounty pays in proportion to the share of the gap to the sweeper's OHKO break point a hit closes, pinned in `tests/wincon_check.js` | **UNMEASURED for the prior** (`pruner-synergy` is a `neutral`-expectation row with an explicit UNMEASURED caveat: a delta means the pool was already wide enough for the prior to re-rank, zero means the corpus never disagreed). The chip bounty has no row of its own — it is a magnitude inside the `wincon` tier, whose own gate is still unrun. Not modelled in the prior: their EV spreads, their Tera types, and the case where the synergy body is revealed *after* team preview |

---

## D. WAS INERT HERE — harness blindness, since supplied

These are the rows that a careless reader reports as "measured neutral". Four of them were not
neutral at all: the feature's input never arrived in the arena, so toggling the flag **could not**
change a decision and the flat row was a statement about the harness, not the feature.

**That hole has since been closed.** `tools/headless_arena/engine_bridge.js` now emits the three
client frames a raw sim stream omits — `|stacc|` from the sim's dex, our own outgoing `/choose`
tagged `send`, and (through `sim_runner`) the `|player|` rating — so D1–D4 are priced by this
runner now. Each row below keeps the cause it was filed with and carries the measurement that
replaced the verdict. D5 is the one that is still inert here for the original reason: its input
arrives and the situation simply never arises.

| # | feature | why it is flat here | how to price it for real |
|---|---|---|---|
| D1 | `laplace.volatility` (the tilt/accuracy charge) | **FIXED, ARRIVES, STILL NOT DECISIVE.** `_accuracyOf` reads `state.moveAccuracy`, which only `src/injected.js` populated from the client's own **stacc** snapshot; `@pkmn/sim` emits no such line, so the penalty was always 0. The bridge now forwards that frame from the sim's dex (the same data the client's dex carries), and `tests/ablation_check.js` §7 pins it. Toggling the flag still changed no battle at 24 a side — now because the charge is too small to flip a line against these movepools (a 10% penalty on Iron Head or Ruination), not because the input is missing | nothing further needed to measure it; a corpus whose teams actually lean on sub-100% moves |
| D2 | `clock` (opponent clock prior) | **ARRIVES — and reading it took a second fix.** `_close()` returns early unless `mySubmitTs` is set, and that is set only by an **outgoing `/choose`** line; the arena answered the sim runner directly and never sent one, so the history stayed empty. `run_arena` now sends it, which made the clock live — and immediately exposed a second defect: with both players on one event loop the measured lead is ~0 ms, so it labelled **every** turn `auto` (0.25), below `switchKeepThreshold`, DELETING their switch replies for the whole battle. The arena therefore **declares** the opponent's pace now (`normal` = identity by default; `--deliberation auto` prices a fast one). **The +28.3 first reported here is retracted** — it priced that artifact | a declared fast/slow opponent (`--deliberation`), or the live client |
| D3 | `clock.ratingBands` (Elo switch bands) | **FIXED, MEASURABLE.** Needs the opponent's ladder rating, carried only as a fifth field on the **player** line; the arena created both players with no `rating` option, so `state.opponentRating` stayed `null` and `ratingFactor()` returned 1 by design. Each persona now **declares** the band its name implies (anchor 1700 / exploiter 1500 / chaos 1100) and `sim_runner` passes it to the sim, so one sweep exercises all three. Measured at 24 a side: the flag changed at least one battle (no `identical` row), while the win-rate interval still included zero — read it against a 100% baseline, so harm is visible here long before gain | a stronger opponent, so the baseline is not at the ceiling |
| D4 | `laplace.comeback` | **FIXED, SAME STATE AS D1.** Scales **only** the volatility charge, which was 0 in the arena — any multiplier on 0 is 0. The charge is now non-zero, so the multiplier is live; but the charge changed no decision at 24 a side, so nothing changed here either. This row cannot be decisive until the row it multiplies is | same as D1 |
| D5 | `quiescence-blockprotect` | **WAS INERT HERE — AND THEN A CORPUS APPEARED.** `tests/quiescence_check.js` proves the shield blocks our move inside the cell and that `blockProtect: false` reproduces the legacy 1-ply number exactly, so the knob works and its input arrives; on the mirror it is still `identical` (their shield never lands on a cell where the block flips the choice). **The `exploiter` persona is the corpus this row was waiting for:** 60 paired battles at seed 1337 take it from 4-0-11 to 13-0-2 when the block is switched off, Δwin +15.0 [+6.7, +23.3] and Δscore +7.5 [+3.3, +11.7], which is why the shipped leaf is now `false` (§K6) | done: the knob is priced, and the row now measures the cost of turning it back ON |
| D6 | `pruner.scout`, `usage` (overlay) | **documented controls**: they ship with empty overlays, so flat is the *expected* result and a non-zero delta there would be the bug | populate the overlay (monthly cron / `scout_replays.js`) |

---

## E. UNRESOLVED — measured flat, cause NOT established

Do not read any of these as "neutral". The honest reading is "unresolved at this sample"; several
carry an explicit `UNRESOLVED` caveat in the feature table for exactly that reason.

**Build note:** E1–E6 are the **first sweep**'s numbers, taken on the pre-urgency build (baseline
68.3 %, 17/60 cap ties). They have not been re-measured since turn urgency was adopted, and a flat
row measured against a baseline that no longer stands is weaker evidence than it looks. Re-run the
row before reasoning from it.

| # | attempt | measured | what is not known |
|---|---|---|---|
| E1 | `pruner.damageEvidence` (reverse damage evidence) | reproduced the baseline exactly | no cause established. It narrows the opponent **model**, and a narrower model only moves a decision when it removes the set that *would have won* the ranking — which may simply not occur against three curated personas |
| E2 | `pruner.residualOrder` (residual speed order) | reproduced the baseline exactly | same class as E1; also see C3 (`residualOrder.trust` ships at 1, which is a separate concern about this same bracket) |
| E3 | The board-state vetoes — `veto.saturatedHazard`, `veto.wastedHazardClear`, `veto.consecutiveProtect`, `veto.magicBounceRedirect`, `veto.redundantField`, and the combined `veto-board-layer` row | the six rows changed nothing at this sample | unknown. Each is a plausible rule with a plausible worst case; the arena's three personas may never present that worst case |
| E4 | `pruner.abilityDeduction.absenceRules` | **fires and moves nothing**: counted directly, 624 pruner calls over 12 battles, 176 of them striking an ability for a silent switch-in (**1,584 ability bans**) | not "no target" — the input arrives and never changes a **ranking**, which is the second of the two distinct causes of a flat row |
| E5 | `nash` (mixed solve) OFF | **+8.3 [−1.7, +18.4]** — it removed the baseline's two losses outright, but the interval straddles zero | 60 battles is not enough. This row is the strongest "no measurable effect" candidate for promotion to a real result at 500 battles |
| E6 | `profile` (opponent profiler) ON | **−3.3 [−10.0, +3.3]**, straddling zero | same |
| E7 | The enabled-but-inert tiers — `laplace.wincon`, `laplace.scouting`, `laplace.endgame` | changed nothing at this sample | `endgame` **refuses outside its competence** (≤2 bodies a side), so a flat row is partly expected; the others are unestablished |

---

## F. Refuted on the policy benchmark (cheap to test, and each one was a plausible story)

Each of these was a *hypothesis about a behaviour* rather than a scoring change, so it was measured on
the replay corpus — 100 elite battles, 5,903 decisions, mean rating 1,830 — where the effect is
visible without an arena run. All figures re-derived from the run's own `--out` records.

| # | hypothesis | measured | status |
|---|---|---|---|
| F1 | **"`quiescence.extendSetup` explains the over-pivoting."** Pricing their boosted reply as a certainty should make staying-in look worse than it is, so the engine bails | `--set laplace.quiescence.extendSetup=false`: the pivot rate moves the **wrong** way (**53.1 % → 54.2 %**) and top-1 moves by **221 gained / 242 lost = net −21** | **REFUTED** |
| F2 | **"VETO4 (`SPEED_SUICIDE`) explains it."** Because the hard veto bans attacking, it *mechanically* forces a switch | `--veto-off VETO4`: the pivot rate is essentially unchanged (**53.1 % → 53.7 %**, contested 55.4 % → 55.4 %) and top-1 is **199 gained / 221 lost = net −22** | **REFUTED** |
| F3 | **"The over-pivoting is a harness artefact."** A replay rebuilds the attack menu from revealed moves only, so a starved menu could leave a switch as the only comparison | starvation is real but not the explanation: on turns the human clicked a MOVE the engine's top line was a pivot **48.1 %** of the time on a 0–1 attack menu, **49.2 %** on 2–3, and **39.0 %** even with a **full 4-attack menu** — against a human switch rate of **26.3 %** | **REFUTED as the explanation** (it inflates the figure, 48 → 39, and does not account for it) |
| F4 | **"Agreement is a proxy for strength."** | the pivot tax raised agreement by 12.3 points and cost 26.7 win points (B1) | **REFUTED** — and this is the finding that made the gate mandatory |

**What F1–F3 leave standing, and it is the useful part.** The over-pivoting is real, and the ranking is
not what is broken. On the 2,053 turns where the engine preferred a pivot while the human attacked,
its **own best non-pivot line was that human's click 55.8 %** of the time. A policy that never pivoted
while holding an attack would score top-1 **61.3 % on move clicks / 45.2 % overall** against the
shipped 35.0 % / 31.7 %. That ceiling is reported by the benchmark as the `pivot ceiling` line, so it
is trackable. **The right answer is already one row down.** Any future fix should be judged by whether
it surfaces that line, not by whether it reduces the switch count — the pivot tax reduced the switch
count and made the switch half *worse* (22.5 % → 16.5 %).

---

## G. Similarity index — "have we tried something like this?"

Find the shape of your idea here **before** you build it. This is the table that catches a re-run of a
dead idea under a new name.

| if your idea is… | we already tried | verdict | what that tells you |
|---|---|---|---|
| **a flat score drag/boost applied to a whole class of action** | the pivot tax (B1), turn urgency (A1), the volatility charge (D1) | 1 adopted, 1 rejected, 1 arrived-but-not-decisive | it *can* work — but only A1 did, and its mechanism was **relative re-ranking that converted lost positions into wins**, not the suppression of a behaviour. Ask which of those yours is |
| **suppressing a hard rule to see what it costs** | VETO4 suppression (F2), the veto-family rows (E3) | refuted as a cause / flat | measure the premise before building the softened rule (that is what killed B5) |
| **"our agreement with human logs goes up, so we got stronger"** | the pivot tax (B1), cross features (B3), the residual head (B2) | all rejected | not a valid inference in this repo. Run the gate |
| **adding a learned correction term to the evaluator** | the residual head (B2), cross products (B3) | both rejected, both on a battle-level hold-out with a paired bootstrap | two independent negatives. A new one needs a **grouped** split (B4), a hold-out over whole battles, and a CI that excludes zero — and it must not be selected on a training-half gain |
| **teaching the engine to price the opponent's non-attacking replies** | `quiescence` (C1) | measured **HURTS** on the mirror, **HELPS** on the personas arena — DISPUTED (§J) | the idea is not refuted; the run of the *implementation* is instrument-dependent. Resolve the tie before extending it |
| **pricing a 1-ply leaf cell more faithfully** (name the switch-in, price a pivot as a hit + a switch, credit a heal) | `realoppswitch`, `pricepivots`, `pricerecovery` (§J); the OWN-MOVE half of the same idea — setup boosts, hazard set/clear, our status moves, our own Protect (§P6/§P7) | all three flat at 60 mirror battles; `pricepivots` (+10.0) leans the same way as `extendsetup`. **The own-move half then went the full distance and still did not clear the gate:** it took its own families from below their uniform floor to above it (setup 46.6 % → 66.7 %, hazard clear 41.2 % → 61.3 %) and lifted the report's top-1 34.6 % → 36.9 % on a p < 0.001 McNemar — and its 60-battle arena gate came back a null with negative point estimates on BOTH instruments (B8) | correcting a leaf's arithmetic does not by itself buy win points at this resolution, and this is now the measured version of that sentence. Pin the arithmetic in a suite (`tests/tuning_check.js` §4 does), then price it on a larger or STRONGER sample — a fresh 60-battle run of the same idea is known to be uninformative |
| **turning a hard gate or threshold into a continuous function** (a cliff → a ramp, a binary speed term, a stepped band) | the threat matrix's speed gate (B9); the veto-softening attempts (B5, F2, E3) | the soft speed term LOST **−0.0134 AUC** out of sample with the refit in place and was a decision-level null without it; B5's premise was refuted before it was built | a gate at `0` is a different feature from a small number, so softening one is a **RE-FIT, not an edit** — the shipped coefficients were fitted on the gated column. Extract both arms, refit both, and compare on a battle-level hold-out with a paired interval; never transform the shipped vector and call it measured |
| **conditioning on who the opponent is** | `elo-band` (D3), `profile` (E6), `clock` (D2) | inert here / unresolved | none of these has actually been priced. Do not cite them as failures |
| **widening or narrowing the opponent model** | `damageEvidence`, `residualOrder` (E1–E2), `absenceRules` (E4) | unresolved / fires-but-moves-nothing | narrowing a model only matters when it removes the candidate that won the ranking. Prefer a corpus where that can happen, or measure in the live client |
| **ending the 100-turn standoff / making the engine commit** | turn urgency (A1) | **ADOPTED, and it worked** | the one proven lever in the repo: 17/60 cap ties → 1/60. If your idea is about tempo, this is the thing to extend |
| **making the engine faster** | the memoisation pass (A3) | adopted, bit-identically | verify bit-identity (same rankings to 17 significant figures) rather than assuming it |
| **deepening the search** | `endgame` (E7) | enabled but inert; **refuses outside competence** | a bounded solver that refuses is the house style; a flat row here is partly by design |
| **a new veto / a new hard rule** | the five board-state vetoes (E3) | flat at this sample | hard rules are cheap to add and appear free; two of them have already been shown to refuse lines elite humans deliberately click (§C2, F2) |

---

## H. How to add an attempt (the checklist)

1. **Register it** in `FEATURES` in `tools/run_ablation.js` with `id`, `tier`, `direction`, `expect`
   (record your *honest* pre-registration — a surprise is information), a `note` stating the
   mechanism, and a `caveat` if the row will be flat for a harness reason. `--list` prints the table.
2. **If it is a policy, measure the behaviour first** with the benchmark. If it does not do what you
   think it does, you have learned that for one replay pass instead of one arena sweep. It still
   cannot adopt the change.
3. **Run the gate** on one seed and all three personas:
   `node tools/run_ablation.js --features <id> --battles 60 --seed 1337` (the sweep's standard; `--battles 500`
   is the number to quote, ~5 h single-threaded, ~1.5 h at `--parallel 4`). On a two-core box
   `--parallel 2` is the working value and `--mirror` is the league where a variant has headroom at all;
   if a sweep dies half-way, `--baseline <a finished arena report>` reuses the reference arm instead of
   re-paying it, and it REFUSES any report that is not the same experiment (`--battles` / `--agent` /
   `--seed` / `--max-turns`) or that was itself run with `--set`, so a variant arm can never be
   mistaken for a baseline.
4. **Quote the interval, not the point estimate.** `helps`/`hurts` means the 95 % interval excludes
   zero; anything else is *no measurable effect at this sample size*.
5. **If the row is flat, check the flag's INPUT before reading it as a result.** `identical` is the
   tell. Pick the right bucket from §D (harness gap), §E (unresolved), or a genuinely dead control.
6. **If it is rejected:** keep the flag shipped OFF, keep the row in the table, and **add a line here**
   with the numbers and the artifact. A rejected attempt that leaves no trace gets rebuilt.
7. **If it is adopted:** re-point the row's `patch` at the value it now ships (`direction: 'off'`) so
   the row keeps measuring what turning the feature off costs, and record the adoption numbers here.
   Then **expect pins to move, and move them deliberately**: every pin that encodes "ships OFF" or
   "the OFF path == the shipped build" is retired by construction (§N4 lists the four that moved for
   `nash-prior`, and what replaced each). Isolate the fixtures of OTHER tiers with an explicit option
   rather than letting them inherit the new default, so a pin about the beam stays a pin about the
   beam.

**Two calibration facts to keep you honest:** at 60 paired battles the standard error is near **6** win
points (so only a large effect clears its interval — 15 of 19 rows were flat in the first sweep); and
the three personas are heuristics, so a win rate here says how the engine handles *those shapes* and
nothing about a ladder rating.

---

## H. The re-anchor (2026-10-13) — which verdicts moved, and why

The instrument changed, so every number above it predates the change. Two defects, both in the
ARENA, neither of which could fail a test:

1. `run_arena` handed the engine the sim-**packed** team string while the browser and every suite
   hand it a Pokepaste, so `parseTeam` registered **one** body whose species was the whole packed
   line. The engine then offered `switch <the whole packed team>`, the sim rejected it ("You sent
   choices for 54 Pokemon"), and the driver silently substituted each rejection — a large share of
   the battle was no longer the engine's. For any earlier row, "the engine won" meant the engine
   *plus its fallbacks* won.
2. Three frames a real client emits were never emitted: `|stacc|` (the accuracy table
   `laplace.volatility` reads, and so the only thing `laplace.comeback` scales), our own outgoing
   `/choose` (the only line that can move the clock), and the `|player|` rating
   (`clock.ratingBands`). D1–D4 above were unpriceable because of this, not because of the features.

**The baseline moved 68.3 % → 98.3 %** win (60 battles a side, all three personas, seed 1337,
`--parallel 6`, 15 min 45 s). The instrument had been scoring a materially weaker engine.

| row | before (broken instrument) | after (re-anchored) | reading |
|---|---|---|---|
| baseline | 68.3 %, 17/60 capped | **98.3 %**, 2 capped | the floor moved 30 win points |
| **C1** `quiescence-extendsetup` | HURTS, +19.3 [+12.0, +26.7] | **HELPS, +20.0 [+10.0, +30.0]** | **sign flipped**; the shipped knob is now supported |
| **A1** `urgency` | HELPS, +28.3 [+18.3, +40.0] | 0.0 | **ceiling, not refutation** — no headroom left |
| **B1** `switch-tax` | REJECTED (agreement up, −26.7 strength) | **HURTS, −31.7 [−43.3, −20.0]** | rejection confirmed, now on strength alone |
| **D2** `clock` | inert (`identical`) | ~~HELPS, +28.3~~ **RETRACTED** | **the +28.3 prices an ARTIFACT, not deliberation.** The arena's two players share one event loop, so the lead is ~0 ms every turn and the clock labelled all of them `auto` (0.25) — below `switchKeepThreshold`, which DELETED their switch replies from the matrix for the whole battle. The run now DECLARES the opponent's pace (identity by default), so this row measures a stated opponent, not the lack of a network |
| **D3** `elo-band` | inert (`identical`) | moves turns, Δ win 0.0 | cheap now — but not decisive in this corpus |
| D1/D4 `volatility`, `comeback` | unpriceable | arrive, Δ win 0.0 | input present; the charge is too small to flip a line |
| `wincon` | `identical` | changes battles, Δ win 0.0 | newly non-inert |
| `profile` | non-inert (−3.3) | `identical` | newly inert |

**The ceiling, stated plainly — this is the headline caveat.** The baseline now wins 98.3 % with
**0 losses in 60 games**, and every row that reads 0.0 is at that ceiling. Fourteen of the 25 rows
cannot be measured at all until the opponent is stronger, and here "no measurable effect" mostly
means **nothing left to win**, not "the feature does nothing". The `--battles 500` advice in §0 does
not help: buying precision on a ceiling buys precision on zero. Strengthen the personas first.


---

## I. The self-play mirror (2026-10-14) — the instrument, un-ceiling'd

§H ends on the blocker: the baseline wins **98.3 %** with **0 losses in 60 games**, so fourteen of the
25 rows read 0.0 because there is nothing left to win, and `--battles 500` buys precision on zero.
Strengthening the heuristic personas is one answer; seating the engine against **itself** is the other,
and it needs no new opponent design.

`--agent mirror` (alias `--league mirror`) in `run_arena.js` and `--mirror` in `run_ablation.js`:
`EngineMirrorAgent` wraps a second `EngineSession` on the SAME team and answers p2's decision windows
out of the engine's own ranking. Measured on seed 7 over 20 battles: **9-11** (45 %), avg 34.6 turns,
against the personas' 20-0. That is a baseline with headroom in BOTH directions, which is the whole
requirement.

**The one design decision that matters.** The mirror runs the **shipped** config even when the run
carries a `--set` patch. Sharing the patch would make the variant play itself: both seats would move
together and every measured effect would cancel to zero — a table of zeros that reads as "these
features do nothing". So `engine_bridge.loadHarness` gained a named `{baseline:true}` mode in its own
cache slot (never patched, never the patched one), and a request for a baseline AND a patch is a
refused contradiction.

**What it does NOT fix.** The mirror is ONE opponent, and a self-play win rate says how the engine
handles the engine — not how it handles a human (that is `tools/benchmark_human_match.js`'s question)
or a ladder. Use it to price a variant's effect, not to claim strength.

---

## J. The first mirror sweep (2026-10-14) — seven rows, and one contradiction with §H

`node tools/run_ablation.js --league mirror --battles 60 --seed 1337 --parallel 2`, 8 variants, 480
battles, **0 errors**, 4,122 s. The baseline is the shipped config, the variant patches the ENGINE
seat only (the mirror seat stays frozen on the shipped config, see §I), and every Δ is paired on the
same seed per battle index.

**Baseline: 25-34-1 = 41.7 % win, 62.3 turns, 2/60 capped.** The two seats are both the engine, so
the number is NOT "the engine beats itself 41.7 % of the time": p1 is the arena's engine seat and p2
drives its own session, so the seats carry a code-path and first-move bias. The Δ is what is being
measured, and the seats cancel in it.

| row (feature switched OFF) | variant win% | Δwin | 95 % CI | turns | capped | verdict |
|---|---|---|---|---|---|---|
| `quiescence-extendsetup` | **65.0 %** (39-17-4) | **+23.3** | [+8.3, +38.3] | 64.6 | 4/60 | **feature HURTS** (`surprise`) |
| `pricepivots` | 51.7 % (31-24-5) | +10.0 | [−6.7, +26.7] | 65.4 | 6/60 | no measurable effect |
| `pricerecovery` | 46.7 % (28-31-1) | +5.0 | [−13.3, +21.7] | 59.8 | 1/60 | no measurable effect |
| `quiescence-turn2speed` | 41.7 % (25-34-1) | +0.0 | [+0.0, +0.0] | 62.4 | 2/60 | no measurable effect |
| `clock` | 41.7 % (25-34-1) | +0.0 | [+0.0, +0.0] | 62.3 | 2/60 | `identical` — see §D2 |
| `realoppswitch` | 40.0 % (24-29-7) | −1.7 | [−20.0, +15.0] | 67.8 | 7/60 | no measurable effect, `stall` |
| `urgency` | 40.0 % (24-22-14) | −1.7 | [−18.3, +15.0] | 75.2 | 14/60 | no measurable effect, `stall` |

**Resolution check.** Half-widths on the flat rows are 15–17 win points, so the paired SE at 60 mirror
battles is ≈ 7.5–8.5 — a touch coarser than the 6 the personas arena gives, because a mirror battle is
two engines and ~62 turns instead of ~35. Only a large effect can clear its interval here, exactly as
in §0. All seven rows are a single seed; none is quotable as a population statement.

**The contradiction, and it is the finding.** `quiescence.extendSetup` was measured **HELPS +20.0
[+10.0, +30.0]** on the re-anchored personas arena (§H) and now reads **HURTS +23.3 [+8.3, +38.3]** on
the mirror. Both intervals exclude zero, both samples are 60 paired battles at seed 1337, and they
point opposite ways. Neither instrument is obviously wrong: the personas baseline sits at 98.3 % with
zero losses (§H's ceiling — it can show HARM and little else), while the mirror baseline sits at
41.7 % with headroom both ways, which is the property §I built it for. What the mirror adds is that a
**self-play** win rate also prices exploitability of a frozen twin, which is not the same question as
strength against a human. So the honest status is **DISPUTED, one instrument each way**, and the knob
stays where it ships until a higher-power row (500 battles, or a second seed, or a declared stronger
opponent) resolves it. §C1 carries the same amendment.

**What the mirror DID reproduce: `urgency`'s mechanism, twice.** Switching turn urgency off took the
100-turn cap ties from **1/60 → 14/60** and the mean game from **62.3 → 75.2 turns**, which is A1's
stated mechanism (commit past turn 25 instead of standing off) showing up on an instrument that never
saw A1's adoption run. Its win interval is flat here for an arithmetic reason worth naming: the OFF
variant took the baseline's 34 losses down to 22 and turned the difference into ties (1 → 14), so the
*win indicator* barely moves while the score (win = 1, tie = ½) rises **+9.2**. For a row whose
mechanism is converting decisive games into ties, the win-indicator bootstrap is the conservative
statistic — quote both, and do not read `urgency`'s tie-flagged flat row as "urgency does nothing".
Same shape, smaller: `realoppswitch` OFF moves win −1.7 and score +3.3 with cap ties 1 → 7.
`pricerecovery` is the one row that moves turns the other way (59.8, capped 1/60).

**The three new leaf corrections are all flat here, and that is not adoption evidence either way.**
`realoppswitch`, `pricepivots` and `pricerecovery` ship ON because they are 1-ply *corrections* — the
old cell priced a switch-in that was never named, a pivot as a plain attack, and a heal as a wasted
turn — and `tests/tuning_check.js` §4 pins each one's arithmetic against a hand-computed board. On the
mirror they are indistinguishable from noise at 60 battles, so the row to remember is
`pricepivots`'s +10.0 leaning the *same* way as `extendsetup` (both suggest less caution is better in
self-play): if a second instrument ever agrees, that pair is the next thing to price properly.

---

## K. The multi-ply pass (2026-10-14) — a second ply, a wider endgame box, a match-point scale, and a first reading that flipped its own default

Six tiers in one pass: a selective 2-ply beam, an endgame box widened to 3 bodies with the ambiguous
Speed order priced as a chance node, stratified active-set worlds, a quantal-response opponent, the
Cancel-window background ponder, and `quiescence.followUpWeight` (added specifically to attack §J's
contradiction). The gate itself changed too: `run_ablation.js` now computes a paired bootstrap on
**match score** (win 1 / tie 0.5 / loss 0) beside the binary win indicator and prints both, because a
binary indicator cannot see a loss converted into a tie (§A1, §J).

**What was run, and the sample. Read this before any number below.**

* mirror — `node tools/run_ablation.js --league mirror --battles 20 --seed 1337 --parallel 2`, 11
  variants, 220 battles, **0 errors**, 2,376 s.
* personas — `node tools/run_ablation.js --agent all --battles 20 --seed 1337 --parallel 2` for the
  quiescence family, 6 variants, 120 battles, 0 errors, 498 s.
* both reports are kept locally under the git-ignored names `ablation-mirror-n20.json` and
  `ablation-personas-n20.json` (with their `.log`), so the tables below can be re-read without
  re-running them.
* **n = 20 per row, a third of §H/§J's 60.** The mirror baseline reproduces §J (40.0 % vs 41.7 %), so
  the instrument is intact — but every interval below is 2–3× wider than §J's, and two of these rows
  (stratification, and the quiescence family on the personas) are the ones a *higher-power* run has to
  settle. Nothing here is a population statement.

**The mirror sweep.** Baseline: 8-10-2 = **40.0 %**, 73.2 turns, 2/20 capped (§J at 60 battles:
41.7 %, 62.3 turns).

| row (leaf the variant patches) | variant win% | Δwin | 95 % CI | Δscore | 95 % CI (score) | turns | verdict |
|---|---|---|---|---|---|---|---|
| `quiescence` (off) | **50.0 %** (10-8-2) | +10.0 | [−20.0, +40.0] | +10.0 | [−17.5, +35.0] | 68.9 | no measurable effect |
| `quiescence-extendsetup` (off) | **50.0 %** (10-8-2) | +10.0 | [−20.0, +40.0] | +10.0 | [−17.5, +35.0] | 68.9 | no measurable effect — and **identical to the whole tier off**, see K3 |
| `quiescence-followup-damped` (on, 0.5) | **35.0 %** (7-11-2) | −5.0 | [−40.0, +25.0] | −5.0 | [−32.5, +22.5] | 66.4 | no measurable effect — **wrong way**, see K3 |
| `quiescence-blockprotect` (off) | 40.0 % (8-10-2) | 0.0 | `identical` | | | 73.2 | inert here (as §D5 says) |
| `quiescence-turn2speed` (off) | 40.0 % (8-10-2) | 0.0 | `identical` | | | 73.2 | inert here |
| `endgame` (on, 2-body bound) | 40.0 % (8-10-2) | 0.0 | `identical` | | | 73.2 | inert here — it refuses outside ≤2 bodies |
| `beam-2ply` (on) | **45.0 %** (9-9-2) | +5.0 | [−30.0, +35.0] | +5.0 | [−30.0, +37.5] | **64.3** | no measurable effect, and it shortens games |
| `endgame-3v3` (on) | 40.0 % (8-10-2) | 0.0 | `identical` | | | 73.2 | inert here: the 3v3 box never fired |
| `sampler-stratify` (off) | **55.0 %** (11-7-2) | **+15.0** | [0.0, +30.1] | **+15.0** | **[+2.5, +30.0]** | 68.7 | **the i.i.d. draw won — the default flipped, see K2** |
| `nash-qre` (on) | 40.0 % (8-10-2) | 0.0 | `identical` | | | 73.2 | inert here: the mirror declares no rating, so QRE is the identity by design |

**`identical` means it reproduced the baseline in EVERY battle** (same winner AND same turn count) —
the signature of a flag whose input this corpus never supplies. Five of eleven mirror rows are that,
and each has a named reason: two are the sub-knobs §J also found inert, `endgame` refuses a board it
is not competent on, `endgame-3v3`'s wider box never came up in a 20-battle endgame, and QRE resolves
to the hard response when the seat declares no rating (§K4).

**The personas sweep, and the composition of that instrument.** `--agent all` seats **four** agents:
anchor, exploiter, chaos **and the mirror** (added in §I/§J). So `20 battles` is 5 per seat, and the
55.0 % baseline below is NOT comparable to §H's 98.3 %: §H predates the mirror being part of `all`.
Baseline: 11-4-5 = **55.0 %**, 54.0 turns, 5/20 capped.

| row (leaf the variant patches) | variant win% | Δwin | 95 % CI | Δscore | 95 % CI (score) | capped | verdict |
|---|---|---|---|---|---|---|---|
| `quiescence` (off) | **80.0 %** (16-1-3) | **+25.0** | [+5.0, +45.0] | +20.0 | [+5.0, +37.5] | 3/20 | **feature HURTS** (`surprise`) |
| `quiescence-extendsetup` (off) | **85.0 %** (17-1-2) | **+30.0** | [+10.0, +50.0] | +22.5 | [+7.5, +37.6] | 2/20 | **feature HURTS** (`surprise`) |
| `quiescence-blockprotect` (off) | **80.0 %** (16-4-0) | **+25.0** | [+10.0, +45.0] | +12.5 | [+5.0, +22.5] | **0/20** | **feature HURTS** (`surprise`) |
| `quiescence-followup-damped` (on, 0.5) | 60.0 % (12-3-5) | +5.0 | [0.0, +15.0] | +5.0 | [0.0, +15.0] | 5/20 | no measurable effect |
| `quiescence-turn2speed` (off) | 55.0 % (11-4-5) | 0.0 | `identical` | | | 5/20 | inert here |

**The same six runs, split by seat** (from the kept per-variant arena reports; `t` = mean turns):

| run | anchor | exploiter | chaos | three personas | mirror seat |
|---|---|---|---|---|---|
| baseline (shipped) | 5-0-0 (32t) | **0-0-5 (101t)** | 5-0-0 (28t) | 10-0-5 = **67 %** | 1-4 (56t) |
| `quiescence` off | 5-0-0 | 2-0-3 | 5-0-0 | 12-0-3 = 80 % | 4-1 |
| `quiescence-extendsetup` off | 5-0-0 | 3-0-2 | 5-0-0 | 13-0-2 = 87 % | 4-1 |
| `quiescence-blockprotect` off | 5-0-0 | **5-0-0** | 5-0-0 | **15-0-0 = 100 %** | 1-4 |
| `quiescence-followup-damped` | 5-0-0 | 0-0-5 | 5-0-0 | 10-0-5 = 67 % | 2-3 |
| `quiescence-turn2speed` off | 5-0-0 | 0-0-5 | 5-0-0 | 10-0-5 = 67 % | 1-4 |

The baseline is **0-0-5 against the exploiter, every one of them a 100-turn standoff**, and every
row that touches the tier moves *that* column and nothing else: `blockProtect` off turns all five
into wins, `extendSetup` off turns three of them, the whole tier off turns two. The anchor and the
chaos seats are 5-0-0 on every row (20/20, no headroom to move), which is §H's ceiling argument
arriving row by row.

### K1. The match-point scale, and what it actually decided

`Δwin` and `Δscore` agreed on **10 of 11** mirror rows and on all 5 persona rows — the two scales only
separated on `sampler-stratify`, where `Δwin` stopped exactly at 0.0 (its interval's floor) and
`Δscore`'s interval excluded zero at [+2.5, +30.0]. That one row is the reason the scale exists; a
reader quoting only the win indicator would have called it flat and shipped the tier. No row was
flagged `score-split` (which needs both intervals to exclude zero in *opposite* directions).

### K2. `sampler.stratifyActive` flipped its own default

This tier shipped **ON**, on an argument about the DRAW rather than about battles: at K = 6 the i.i.d.
draw can pick the same active set four or five times and never draw a 25 %-usage set, and the active
body is what every cell of the matrix is priced against. `tests/tuning_check.js` §6 proves that
coverage gap, and it is still true. What it does not prove is that covering the pool is worth more
than the draw it replaces, and the first win-rate reading says it is not: switching it OFF won
**55.0 % against 40.0 %**, Δwin **+15.0 [0.0, +30.1]**, Δscore **+15.0 [+2.5, +30.0]**. The shipped
leaf is now `stratifyActive: false` (which is bit-identical to the pre-pass build) and the ablation
row patches it **up** (`direction: 'on'`) as the promotion candidate — the FIRST of two rows whose default moved because of
its own measurement (§K6 is the second). Status: **REJECTED at n = 20**, reopen with a 60-battle run
before rebuilding the argument.

### K3. The `quiescence` contradiction: `followUpWeight` is DISARMED, and both instruments now lean the same way

§J left the tier DISPUTED: personas said HELPS +20.0 [+10.0, +30.0], mirror said HURTS +23.3
[+8.3, +38.3]. This pass was asked to price the specific mechanism the asymmetry suggested — that the
setup extension prices a full-strength Turn-2 boosted hit against a rational opponent that rarely
clicks raw setup into an active threat — by halving it (`followUpWeight: 0.5`).

**The hypothesis is DISARMED, not confirmed.** On the mirror the damped variant scored **−5.0**
[−40.0, +25.0] against the shipped full-strength setting: halving the follow-up made the arm measured
*against* the tier slightly WORSE, not better. On the personas it read +5.0 [0.0, +15.0] — flat, and
its seat split is exactly the baseline's (the exploiter stalls all five again). So "over-pricing the
Turn-2 hit" is not the lever, and the rows that do move are elsewhere in the tier.

**What the sub-knobs say instead.** On the mirror, `quiescence` off and `quiescence-extendsetup` off
are **the same battles** (both 10-8-2 at 68.9 turns), so the whole tier's mirror effect IS the setup
ply. On the personas the picture is sharper and points at a different knob: `blockProtect` off —
their Protect blocking our move inside the cell — is the single biggest mover (**15-0-0 against the
10-0-5 baseline**, +25.0 [+10.0, +45.0], capped games 5 → 0), while `extendSetup` off is 13-0-2. And
the tier's own arm reads **+25.0 [+5.0, +45.0]** on the personas (HURTS, `surprise`) and +10.0
[−20.0, +40.0] on the mirror — the same sign §J got, so **both instruments now lean HURTS** and §H's
HELPS +20.0 is the outlier.

**The decision, and why it is deliberately NOT made here.** At n = 20 the shipped default did **not**
move. (**AMENDED BY §K6, which ran the 60-battle version of this experiment: ONE sub-knob moved —
`quiescence.blockProtect` now ships OFF on +15.0 win [+6.7, +23.3] and +7.5 score [+3.3, +11.7] for
switching it off. The master switch and `extendSetup` did not move.**) Two reasons, and both are
about power, not preference:

1. These runs are **n = 20**, a third of the §H/§J samples that disagreed. Replacing a 60-battle
   HELPS interval with a 20-battle HURTS interval is swapping one under-powered reading for another,
   and this file's own rule (§H, "the ceiling, stated plainly") is that a row is not quotable until it
   has the power to break a tie.
2. The strongest persona evidence rests on **5 exploiter battles**. Five stalemates turning into five
   wins is a striking, mechanistic signal, and it is also five games.

**What to run next, concretely.** `blockProtect` off is the only sub-knob with a measurable effect on
BOTH instruments' description of the problem and INERT on the mirror (§D5, §J, and the `identical` row
above) — so the mirror cannot price it and the personas arena can. That is a 60-battle run of
`--features quiescence,quiescence-blockprotect,quiescence-extendsetup --agent all --battles 60`, whose
exploiter column is where the answer will be. Until it exists, §C1 stays DISPUTED and the tier stays
where it ships.

**RAN — see §K6.** The 60-battle version of that experiment moved ONE leaf: `blockProtect` now ships
off. The exploiter column is where the answer was, exactly as this paragraph predicted, and the other
half of the tier (`extendSetup`) did not move because its own arm does not clear zero.

### K4. The four new tiers, in one line each

* **`beam-2ply` (ships OFF) — flat, and cheap.** +5.0 [−30.0, +35.0] on the mirror, with games 8.9
  turns shorter (64.3 vs 73.2). It changes decisions (not `identical`) and `tests/tuning_check.js` §5
  pins the tactical swap it produces (pricing a revenge killer puts Encore above a 120 BP STAB
  attack). It did **not** clear the gate, so it ships OFF — the 2-ply hypothesis is alive, not
  adopted; price it at 60 battles before turning it on.
* **`endgame-3v3` (ships OFF, the widened box) — `identical` here.** Neither the 3v3 mate nor the
  Speed chance node came up in this corpus's endgames. That is §E7's "refuses outside its competence"
  becoming "is competent and still never asked": inert, not refuted. `tests/endgame_check.js` §6 pins
  both behaviours on constructed boards, so the tier is proven, just unpriced.
* **`nash-qre` (ships OFF) — `identical`, by design.** The mirror declares no rating for the persona
  seat, and an unknown opponent resolves to the hard response, so this instrument cannot price it.
  Row kept; price it against the declared persona bands (§D3) if the question is ever reopened.
* **`deepPonder` (ships ON) — not priceable here at all.** It is a `src/content.js` affordance: the
  arena drives `laplace_core` directly through the bridge and never runs the boot. Its contract is
  pinned by `tests/hud_check.js` §14 (scheduling, one pass per window, a new window invalidates the
  old) and `tests/dom_check.js` §11 (the alert's DOM lifecycle), and it cannot cost win points because
  Pass 1 — the ranking the HUD shows and the two-pass boot renders first — is unchanged and
  synchronous. The quality of Pass 2's *advice* inherits `beam-2ply` and `endgame-3v3`, both of which
  are flat/unpriced here, so treat the Cancel alert as a UI hint rather than a gate-adopted opinion.

### K5. What this pass did NOT establish

* Nothing about strength above n = 20 for any of the six tiers, except that `sampler-stratify`'s
  default moved (§K2) — that one moved on a match-point interval that excludes zero, and it is the
  first of the two defaults this pass flipped.
* Nothing about the `exploiter` seat's five stalemates beyond the fact that they were already there in
  the baseline and that three sub-knob settings dissolve them. The mechanism (a shield inside the
  cell, versus the setup ply) is a hypothesis with two measurements behind it, not a diagnosis.
* Nothing about humans. The mirror prices a frozen twin (§I) and the personas are heuristics (§H);
  neither is `tools/benchmark_human_match.js`'s question.

### K6. The 60-battle re-run §K3 asked for — and the SECOND default this pass moved

`node tools/run_ablation.js --features quiescence,quiescence-extendsetup,quiescence-blockprotect,
quiescence-followup-damped,quiescence-turn2speed --agent all --battles 60 --seed 1337 --parallel 2`:
6 variants, **360 battles, 0 errors, 1,478 s**. This is the run §K3 named, at the power §H/§J used.
Sixty battles over four seats is **15 per seat**, so every column below is thinner than §H's 20-per-seat
— but it is three times §K's sample, and it is the first reading of this question with intervals narrow
enough to move a default.

**Baseline: 38-11-11 = 63.3 %, 56.0 turns, 11/60 capped.** (Not comparable to §H's 98.3 %: `all`
includes the mirror seat, and on this build the personas' own baseline has moved with it.)

| row (leaf the variant patches) | variant win% | Δwin | 95 % CI | Δscore | 95 % CI (score) | capped | verdict |
|---|---|---|---|---|---|---|---|
| `quiescence` (off) | **76.7 %** (46-5-9) | **+13.3** | [+1.7, +25.0] | **+11.7** | [+4.2, +20.0] | 9/60 | **feature HURTS** (`surprise`) |
| `quiescence-extendsetup` (off) | 68.3 % (41-5-14) | +5.0 | [−5.0, +16.7] | +7.5 | [0.0, +15.8] | 14/60 | no measurable effect |
| `quiescence-blockprotect` (off) | **78.3 %** (47-11-2) | **+15.0** | [+6.7, +23.3] | **+7.5** | [+3.3, +11.7] | **2/60** | **feature HURTS** (`surprise`) |
| `quiescence-followup-damped` (on, 0.5) | 61.7 % (37-12-11) | −1.7 | [−10.0, +6.7] | −1.7 | [−10.0, +6.7] | 11/60 | no measurable effect |
| `quiescence-turn2speed` (off) | 63.3 % (38-11-11) | 0.0 | `identical` | | | 11/60 | inert here |

**The same six runs, split by seat** (identical seeds, so these are paired against the same battles):

| run | anchor | exploiter | chaos | three personas | mirror seat |
|---|---|---|---|---|---|
| baseline (shipped) | 15-0-0 (31t) | **4-0-11 (99t)** | 13-2-0 (36t) | 32-2-11 = 71.1 % | 6-9 (58t) |
| `quiescence` off | 15-0-0 | **9-0-6** | 13-2-0 | 37-2-6 = 82.2 % | **9-3-3** |
| `quiescence-extendsetup` off | 15-0-0 | 4-0-11 | 13-2-0 | 32-2-11 = 71.1 % | **9-3-3** |
| `quiescence-blockprotect` off | 15-0-0 | **13-0-2** | 13-2-0 | **41-2-2 = 91.1 %** | 6-9 |
| `quiescence-followup-damped` | 15-0-0 | 4-0-11 | 13-2-0 | 32-2-11 = 71.1 % | 5-10 |
| `quiescence-turn2speed` off | 15-0-0 | 4-0-11 | 13-2-0 | 32-2-11 = 71.1 % | 6-9 |

**The decomposition is the finding: each half of the tier is harmful on a DIFFERENT instrument.**

* **`blockProtect` is the exploiter's** — and it is the whole of it. The shield-spamming persona goes
  **4-0-11 → 13-0-2** (nine stalemates become wins), the three-persona column goes 71.1 % → 91.1 %,
  and the **mirror seat does not move at all** (6-9 either way). The tier's own arm (+13.3 [+1.7,
  +25.0], +11.7 [+4.2, +20.0] on match score) and the protect arm (+15.0 [+6.7, +23.3], +7.5 [+3.3,
  +11.7]) are the same movement: both exclude zero on **both scales**, and the cap games fall
  11/60 → 2/60.
* **`extendSetup` is the mirror's**, and it is the whole of ITS movement: the personas do not move a
  single battle (32-2-11 → 32-2-11, and the exploiter column is 4-0-11 either way) while the mirror
  seat goes **6-9 → 9-3**. That reproduces §J's 60-battle mirror reading (HURTS +23.3 [+8.3, +38.3])
  at the seat level and once again fails to reproduce §H's personas reading (HELPS +20.0 [+10.0,
  +30.0]): on today's instrument the same patch is worth **+0.0 on the three personas**.
* `followUpWeight` 0.5 and `turn2speed` off are flat here too (−1.7 and `identical`), so §K3's
  two verdicts stand at 3× the power.

**THE DECISION: `laplace.quiescence.blockProtect` now ships OFF.** It is the second default this
branch has ever flipped, and the case for it is the arm AND the mechanism: switching it off wins
+15.0 win points [+6.7, +23.3] and +7.5 match points [+3.3, +11.7] on the same arm, on a single seed,
with the movement localized to the opponent that actually clicks Protect into us (and the mirror
saying `identical`, i.e. this knob cannot be priced there at all).

**Why NOT the other two available moves.**

* **Not the whole tier.** Its arm also excludes zero (+13.3 / +11.7), but the pair of sub-arms says the
  mass is `blockProtect`'s, and `extendSetup` is the half that is (weakly) doing the job the tier was
  built for. Turning the tier off would also turn off the half whose harm lives on a different
  instrument and whose own arm does not clear zero.
* **Not `extendSetup`.** Its arm reads +5.0 [−5.0, +16.7] on the win indicator — a floor of −5.0, so
  it does not clear zero — and its match-point interval's **floor is exactly 0.0**. The mirror's
  evidence against it is real (§J's dedicated 60-battle run) and this run agrees in direction at the
  seat level, but the two instruments still disagree about the aggregate (personas: no effect), and
  §C1 is explicit that a shipped default does not move on a contested reading. It stays ON with §K3's
  contradiction narrowed to "the mirror says the setup ply is wrong; the personas cannot see it".

**What this decision costs, stated rather than hidden.** `blockProtect: false` is a deliberate return
to the 1-ply reading in which their shield is a no-op for the cell — i.e. the matrix credits us a hit
that a live Protect would eat. It is not a claim that the block is wrong (it is a game rule, and
`tests/quiescence_check.js` still proves the block works whenever it is on) but a claim about its
VALUE: with the shield priced, the engine pivots and grinds instead of committing, and against a
staller that is worth about fifteen win points. The row stays in the table, `direction: 'on'`, so the
cost of turning it back on is a single sweep away.

**Limits at seed 1337.** One seed for the decision; the personas arena is the only instrument that
can price this knob (the mirror is `identical`); and 15 battles per seat means the exploiter column is
15 games. The run that closes all three is the same question with the `exploiter` seat ALONE
(`--agent exploiter --battles 60`, so all sixty battles go to the shield-spammer) on a SECOND seed.

### K6b. The second seed, and the seat alone — both halves of the tier, settled

`node tools/run_ablation.js --features quiescence-blockprotect,quiescence --agent exploiter --battles
60 --seed 20261015 --parallel 2`: 3 variants, **180 battles, 0 errors, 849 s**. The baseline is the
SHIPPED config **as it now stands** (setup ply on, protect block off), which is what makes this run
decisive: each row now removes exactly one half, so the two arms answer two different questions
without interacting.

| row (leaf the variant patches) | variant win% | Δwin | 95 % CI | Δscore | 95 % CI (score) | capped | verdict |
|---|---|---|---|---|---|---|---|
| `quiescence-blockprotect` (**on**) | **16.7 %** (10-0-50) | **−70.0** | [−83.3, −56.7] | **−35.0** | [−41.7, −28.3] | **50/60** | **turning the block back on HURTS** (`surprise`, `stall`) |
| `quiescence` (off — removes the SETUP PLY) | **46.7 %** (28-0-32) | **−40.0** | [−55.0, −25.0] | **−20.0** | [−27.5, −12.5] | 32/60 | **removing the setup ply HURTS** (`stall`) |

**Both halves are now settled, and in opposite directions**, on the shipped configuration and on a
seed neither of them was chosen on:

* **The protect block is confirmed OFF.** Turning it back on takes the exploiter seat from **86.7 %
  (52-0-8) to 16.7 % (10-0-50)** — Δwin −70.0 [−83.3, −56.7], Δscore −35.0 [−41.7, −28.3], and
  **50 of 60 battles hit the 100-turn cap**. That is the same sign as seed 1337's arm (+15.0 for
  switching it off) at five times the magnitude, so the leaf is not marginal on the seat it is aimed
  at: with the shield priced, the engine stops committing against a body that keeps shielding.
* **The setup ply is confirmed ON**, which is the half §K3/§K6 could only call "contested". Removing
  it (with the block already off, so this arm isolates it) costs **−40.0 win [−55.0, −25.0]** and
  **−20.0 match score [−27.5, −12.5]**, with the cap games going 8/60 → 32/60. So the personas' "no
  measurable effect" reading for `extendSetup` (seed 1337, 4-0-11 either way on this seat) was the
  seat being **saturated**: with the block mispriced, the exploiter column was already a wall of
  stalemates and the setup ply's benefit had nowhere to show up. Price the block correctly and the
  setup ply's value appears at once. That interaction is why the two rows had to be measured with the
  other leaf already at its shipped value.

**Cross-seed variance worth naming.** The exploiter seat is bimodal: with the block priced it sits at
**17-27 %** across two seeds (seed 1337's baseline, seed 20261015's block-on arm), and with it
unpriced at **78-87 %** (seed 1337's block-off arm, seed 20261015's baseline). So most of the spread
between these runs is the LEAF, not the seed, and the single-seed caveat above is discharged for this
knob: the direction is the same on both seeds and both instruments' descriptions of the mechanism
(the shield is what produces the standoff) agree. What is still one seed each: the exact magnitude
(−70 vs −15 on this seat), and every number in §K6's four-seat table.


---

## L. The verification pass (2026-10-15) — the two claims under the block decision, checked

The block-ships-OFF decision (§K6/K6b) rested on two claims that had been *asserted* rather than
verified: that the 1-ply Protect cell prices no decay (so a staller reads as invincible in it), and
that the flat `nash-qre` row was the rating ramp declining to fire. Both are now checked against the
code and pinned. The first is confirmed; the second is confirmed **and then goes further than the
docs said**.

### L1. The 1-ply Protect cell prices NO decay — the "invincible staller" story is mechanism-real

`_payoff` decides `shielded` from the ACTION alone (`oppAction.kind === 'protect' || oppData.isProtect`)
and never consults the opponent's protect chain. So a shield in the cell blocks our move no matter
how long the chain is — **including the repeat that fails in the real game.** In the game, Protect
fails on consecutive use, so a staller cannot shield forever; the cell has no way to say so, and a
shield-spammer's entire column prices as a free turn for them.

Measured on the `quiescence_check` fixture (Great Tusk into Dragonite, Ice Spinner is the KO line):

| board | block-ON cell | legacy cell | what the shield eats |
|---|---|---|---|
| fresh (chain 0) | **37.53** | **614.43** | 576.89 |
| chain 2 (this Protect would FAIL) | **86.80** | **656.90** | 570.10 (**98.8 %** of the fresh gap) |
| chain 5 | **86.80** (== chain 2) | **656.90** | 570.10 |

The only thing in the cell that reacts to the chain at all is the evaluator's `protectRhythm` term
(dim 126, `+0.5` once their consecutive count reaches 2); it shifts the block-ON and the legacy cells
by the same small amount (+49.3 and +42.5 here — both far smaller than the ~570 the shield eats) and
never lets the hit through. So the block is **absolute**: the cell is a staller's free-turn generator,
which is exactly why pricing it is worth 15 win points on the four-seat sweep and **70** with the
exploiter seat to itself. `tests/quiescence_check.js` §3b pins the whole table above, including that
a five-deep chain prices *exactly* like a two-deep one.

### L2. `nash-qre` is near-inert for the RANKING by construction — not merely unrated

§K4 filed the flat mirror row as "the mirror league declares no rating for the persona seat, and an
unknown opponent resolves to the hard response". That is true, and the ramp is exactly as documented
(no rating → `0`; at or below `lowRating` **1100** → the full **30**; at or above `highRating` **1850**
→ `0`; linear between). It is worth naming the misreading it invites: the mirror is inert because it
declares **no** rating — not because it "was set to 1800+", which would be a non-zero `tau` of **2.0**.

But the ramp is the SMALLER half. In `solveNashFictitiousPlay` the opponent's soft column mix is
accumulated only into their PUBLISHED strategy (`oppCount[j] += oppMix[j]`), while the action each
side best-responds to is still the hard argmax (`oppAction = bestJ`), and **our** cumulative payoff
reads that hard index (`myCum[i] += payoffMatrix[i][oppAction]`). A temperature therefore **cannot
reach our own frequency counts on any matrix**: over 12 random 9×9 matrices the `myStrategy` output is
bit-identical with the tier on and off, while `oppStrategy` and `rowValues` move on every one.
`tests/tuning_check.js` §7b pins that on three fixed matrices and on a real board: with a seat rated
1200 (inside the ramp, so the tier really is engaged) the engine's **confidence / frequency column and
the published top line are unchanged**, and only the opponent mix and the row VALUES differ.

**The consequence, stated plainly.** `nash-qre` can change a decision only through the score
tie-break among equal frequencies (plus the opponent mix it hands the profiler next turn) — it cannot
rescore a line. So the row needs no "mid-ladder opponent" to be priceable; it is near-inert for the
ranking *by construction*, and the personas' declared bands (1700/1500/1100) cannot rescue it either.
The question E5 left open — whether the hard equilibrium is wrong about **people** — is **not**
answered by this row as built: answering it needs the soft response to enter our best-response step,
which is a different code path. The row's `caveat` in `tools/run_ablation.js` now says this, and its
`direction: 'on'` is kept, so the cost of turning it back on is still one sweep away.

**CLOSED, same day, in §N — and the diagnosis above is what made it findable.** The ceiling was a code
path, not a law: our step read the opponent's hard argmax *index* while their published strategy
accumulated the soft *mixture*. §N changes the one line to read the mixture (exactly zero effect when
no mixture exists), so a temperature now reaches our own frequency counts. What §L2 got right and §N
does not retract: the ramp, the no-rating resolution, and the fact that a **strictly dominant row** is
immune to every opponent model — which is why this row still reads flat on the mirror instrument.

### L3. The mirror n60 reading for `beam-2ply`: it did not REPLICATE across seeds, so the default stays OFF

Two runs, the same row on the same instrument, two seeds (120 battles each, 0 errors):

| seed | baseline | `beam-2ply` (on) | Δwin | 95 % CI | Δscore | 95 % CI (score) | Δturns | capped |
|---|---|---|---|---|---|---|---|---|
| 1337 | 41.7 % (25-34-1) | **61.7 %** (37-21-2) | **+20.0** | [+3.3, +36.7] | +20.8 | [+4.1, +37.5] | +0.6 | 2/60 |
| 20261016 | 43.3 % (26-28-6) | 45.0 % (27-28-5) | +1.7 | [−15.0, +20.0] | +0.8 | [−16.7, +19.2] | −5.5 | 6/60 |

**Two results, one sign, and no agreement on magnitude: +20.0 on seed 1337 and +1.7 on seed 20261016.**
Seed 1337's interval floor (+3.3) sits above the second seed's point estimate, so the two seeds do not
overlap in the way a replicated effect would. Neither reading is quotable alone, and the honest pooled
statement is the one the n = 20 run already gave: **no measurable effect at this sample size**, now
checked at three times the power.

**Where the n = 20 story went.** That run also reported “games 8.9 turns shorter”. Across these two
seeds the beam is −5.5 turns on one and +0.6 on the other (mean ≈ −2.5), so the shortening is small and
seed-dependent rather than the mechanism behind seed 1337's +20.

**THE DECISION: `laplace.beam2Ply.enabled` stays `false`**, and the seed disagreement is now the whole
reason — which is exactly what §K6b ran a second seed to check for the quiescence leaf. The row stays a
promotion candidate (`direction: 'on'`). Two further caveats stand from the first seed: the mirror is
the instrument most confounded for a DEPTH increase (the variant outsearches the frozen, shallower twin
it is measured against, so a win here cannot separate “finds better lines” from “outsearches the twin”),
and enabling the beam puts its 3×3×K = 54 cells into Pass 1 (the synchronous ranking the HUD renders) of
a project already ~3× its 10 ms per-turn target. The decisive run is therefore still the same one: a
non-self-play instrument, or `tools/benchmark_human_match.js` pricing the tactical swap
`tests/tuning_check.js` §5 pins, plus a bench delta for Pass 1.

**What this pair of runs prices, beyond the flag.** The two seeds differ on more than the beam: seed
1337 plays 62-turn games with 2/60 capped and 1.7 % ties, seed 20261016 plays 69-turn games with 6/60
capped and 10 % ties. So a single-seed mirror row here is a 60-game deal from a distribution with a
visible wobble — which is precisely the case §K6b's “second seed” rule exists for. Any future mirror row
that clears its interval on one seed should be read as a candidate for a second seed, not as a result.

---

## M. The hardening pass and its two opponent-model tiers (2026-10-15) — one sweep, three rows, no adoption

The pass that hardened `src/endgame_solver.js` (five structural fixes), added `laplace.surpriseMask`
and `laplace.nash.priorAnchored`, and reclaimed the six dims of the 128D vector that no corpus row
could move. **Fifteen config leaves, five suites, and not one adoption**: the sweep below is the first
win-rate reading any of these three rows has had, and none of them cleared its interval.

**What was run, and the sample. Read this before any number below.**

* `node tools/run_ablation.js --features endgame-3v3,surprise-mask,nash-prior --battles 60 --seed 1337
  --parallel 2 --keep-tmp` — the sweep's standard: 4 variants × 60 battles over all four seats (anchor,
  exploiter, chaos **and** the mirror), **0 errors**, 1,201.6 s wall. The report is kept under the
  git-ignored name `ablation-phase5-n60.json` beside its `.log`, so the table re-reads without
  re-running it.
* The brief's command said `--parallel 6`. The tool's `--parallel` is a **variant** pool (up to that many
  arena processes at once), not an intra-batch thread count, and this machine has TWO cores: at six, all
  four batches ran concurrently and one of them died (`exit 1`, no report written). Two at a time is what
  §K6b used here and it ran clean — so the sweep was re-run at two, not quoted from the failed attempt.
  Each variant was also probed separately first (4 battles, the same `--set`, three probes, `exit 0`,
  `pipeline errors 0`), which is what rules out a crash inside the new code as the cause of that failure.
* n = 60 per row, so SE ≈ 6 win points: **only a large effect can clear its interval at this size**, and
  it is one seed. That is the standard §H sets, and it is enough for what these three rows had to say —
  none of them is a near miss.

Baseline: 47-11-2 = **78.3 %** win, 80.0 % match score, 54.3 turns, 3/60 capped.

| row (leaf the variant patches) | variant win% | Δwin | 95 % CI | Δscore | 95 % CI (score) | capped | verdict |
|---|---|---|---|---|---|---|---|
| `endgame-3v3` (on — the whole hardening pass at the widened bound) | 78.3 % (47-11-2) | +0.0 | `identical` | +0.0 | `identical` | 3/60 | **inert for the ranking by construction** — see M1 |
| `surprise-mask` (on) | 73.3 % (44-8-8) | −5.0 | [−15.0, +6.7] | +0.0 | [−6.7, +8.3] | **9/60** | no measurable effect, flagged `stall` — see M2 |
| `nash-prior` (on) | 78.3 % (47-11-2) | +0.0 | `identical` | +0.0 | `identical` | 3/60 | **inert here** — see M3 |

### M1. The endgame row cannot price the tier: it is a READOUT, and nothing that ranks reads it

`_tiers` writes the solver's report into `lastReadout.endgame`, and no module in `src/` reads that field
to rank anything — the readers of `lastReadout` outside `laplace_core.js` are `src/content.js`'s HUD and
LLM plumbing, which render `ranked` and the tempo vector. So enabling the tier cannot change which
action the engine plays: not “did not on this sample” but *cannot*, in the deployed build. The row's
`identical` result is the only result this instrument could have produced, and it must not be read as
evidence about the five fixes.

What the row DOES price is the cost, and the two batches that shared a wave make it a fair pair: the
same 60 battles took **707.4 s with the tier on against 540.9 s with it off (+166.5 s, +31 %)**, for a
report nothing ranks. (The other two rows of the sweep, which do not touch the solver, took 572.8 s and
494.1 s, so the +31 % is the search and not the slot.)

**The wiring was then changed and the row re-run** — `LaplaceEngine` had been calling
`solveAcrossWorlds`' single-world predecessor, so the measured artifact was not the committed one. The
re-run (`ablation-endgamewired-n60.json`, same flags, one feature) reproduced its own baseline
**exactly** (47-11-2, 78.3 %, 54.3 turns, 3/60 capped) and the row was `identical` again:

| run | variant | baseline (same wave) | cost of the tier | result |
|---|---|---|---|---|
| first (single-world call) | 707.4 s | 540.9 s | **+166.5 s (+31 %)** | `identical` |
| re-run (`solveAcrossWorlds`) | 969.6 s | 625.0 s | **+344.6 s (+55 %)** | `identical` |

So the multi-world contract roughly doubles the readout's cost — it prices every sampled world instead
of the first — and still cannot move a ranking, which is the same fact twice: this instrument measures
the tier's expense and nothing else. Both numbers are single-batch wall clocks on a 2-core box, where
the co-scheduled baseline moved 540.9 s → 625.0 s between the two runs, so read the RATIO within a run
and not the absolute seconds.

**What this sweep consequently does NOT establish:** whether the five corrections make the solver
*better*. It cannot — nothing measured here reads the solver's output. That question needs the readout
to enter a ranking (a proven mate as a re-rank, or the `mateIn` shown to a human who then decides), and
until then the evidence for the five fixes is §7 of `tests/endgame_check.js`: a correctness argument on
fixtures (the mate is found where it should be, a heal prices as a heal, a replacement pays the hazards,
a `ceil(hp / 5)` transposition cannot be reused across a window, and a mate one world refutes is not
published as a mate).

### M2. `surprise-mask` engages, and turns six decided games into 100-turn standoffs

Not `identical`: the mask changed decisions in this corpus. The shape is the story — **wins 47 → 44,
losses 11 → 8, ties 2 → 8, capped games 3/60 → 9/60, and match score exactly +0.0**
(`[−6.7, +8.3]`). Three wins and three losses became six capped standoffs. A tier that converts a
decided game into a standoff without moving the match score is the pathology §A1 adopted turn urgency to
remove, and the tool flags it `stall`, so it stays OFF — and unlike the `identical` rows, this one is a
real reading of the tier's effect.

The direction is legible from the mechanism: with the mask on, the opponent is estimated against a
matrix in which our unrevealed non-STAB row is blended toward our best revealed-or-STAB row, so we
expect them to be less afraid of the lure. Expecting less fear lowers the lure's modelled urgency
relative to the passive rows beside it in the same solve, which is a commitment tax — the same direction
the `stall` flag reports. §8 of `tests/tuning_check.js` pins the intended half on the board built for it
(the lure's TRUE value rises and their pivot frequency rises with it); this sweep says that off that
board the same mechanism buys standoffs rather than wins.

### M3. `nash-prior` engages and changes no decision — §L2 already said why it cannot

The anchored mix is published on the readout whenever the tier is on and the turn has a live submatrix
(`weight: 0.25`, pinned at the ENGINE level by §9), so the tier was engaged in these battles. It changed
no decision in 60 of them. §L2 named the ceiling: our own frequencies best-respond to the opponent's
**hard argmax index**, and only the score tie-break among equal frequencies can ever see a softer
opponent, so a tier whose whole effect is the opponent's mix can move a ranking only when two of our
rows are already tied in frequency. This row is the same shape as `nash-qre` and needs the same
instrument (the soft response threaded into our own best-response step) to be priceable at all.

Two consequences. (1) The row's `expect: 'helps'` is a pre-registration this reading does not confirm;
it is kept rather than deleted, because the next attempt on this tier is the same code path with the mix
threaded into our step. (2) `priorWeight: 0.25` stays a guess: the quantity that would set it (a usage
corpus of the opponent's own action frequencies) is exactly what this repository does not have offline,
and a flat row cannot validate a magnitude.

**Superseded the same day by §N, and the prediction in the last sentence of M3 was right.** §N threads
the mix into our own best-response step — the "same code path" named above — and the row is re-measured
there. `priorWeight` remains a guess.

### M4. The decision, and the six dims that DID move

**No adoption.** All three rows keep `enabled: false`, and no row's `patch` is re-pointed: none of them
ships, so each still measures what turning it ON costs, which is what §H.6 asks for. Every one of the
five hardening leaves stays ON in config, because they are corrections and the tier they sharpen is a
readout the shipped build does not rank either way — §M1's cost is only paid when the tier is enabled.

The fourth phase of the pass is untouched by any of the above, and it is the one part with a measurement
of a different kind. Dims 66/67/72/73 were constant 0 in every corpus row because the **extractor** never
built `ST.ArchetypePruner`, and dims 120/121 were a hard 0 because Terastal Clause bans Tera in
`[Gen 9] National Dex OU`. Both causes are fixed and pinned by construction —
`tests/weights_check.js` §5b proves the pruner wiring by A/B on the same corpus (the pruner absent from
the sandbox reproduces the six zeros), and `tests/run_tests.js` pins dims 120/121 on constructed boards.
Their shipped coefficients are 0, so the SCORE is unchanged; the point is that the next fit is no longer
fitting a column that cannot move.

### M5. What this pass did NOT establish

* **Nothing about the five endgame fixes as policy.** See M1: the instrument cannot see them.
* **Nothing about `priorAnchored` as a magnitude.** See M3.
* **Nothing on a second seed, and nothing at `--battles 500`.** Every row here is n = 60 on seed 1337.
  That is deliberate: §L3's lesson is that a single-seed reading is a candidate for a second seed, not a
  result — and no row here produced a reading worth one (two `identical`, one `stall`). A future change
  that makes either of them rank-affecting should be measured on two seeds before it is quoted.

---

## N. The one-way solve, and the first adopted opponent model (2026-10-15)

Two findings from §M were structural rather than statistical, and this pass closes both: §L2/§M3's
*"a softer opponent cannot reach our own frequencies"* was a code path, not a law, and §M1's *"the
endgame row is a structural null instrument"* was a missing line in the ranking path. Fixing them
un-silenced the rows, and one of them then WON — on two seeds — so this is also the first adoption in
the project that rests on a replicated mirror reading.

### N1. The ceiling was a code path: our own step now reads the MIXTURE

`solveNashFictitiousPlay` accumulated the opponent's soft/anchored column mix into their PUBLISHED
strategy (`oppCount[j] += oppMix[j]`) while the action **each side** best-responded to was still the
hard argmax index (`oppAction = bestJ`), and our own cumulative payoff read that index
(`myCum[i] += payoffMatrix[i][oppAction]`). Every opponent-model tier was therefore **one-way**: a
temperature, a prior or a masked matrix could re-price `rowValues` and could not touch our own
frequency counts on ANY matrix. That is the ceiling §L2 pinned, and it is why `nash-prior` came back
`identical` over 60 paired battles in §M3.

**The fix is the accumulation rule, not a new heuristic.** Our expected payoff against a mixture the
opponent is playing *is that mixture's expectation*, so with a mixture present our step accumulates
`sum_j oppMix[j] * payoff[i][j]`; with no mixture (no temperature, no prior — i.e. every pre-adoption
build) the historical line runs character for character, which is what keeps the shipped path
bit-identical. The identity is pinned in `tests/tuning_check.js` §7b on three fixed matrices: `tau 0`,
no prior and blend 0 each reproduce the bare solve exactly, while each of the three tilted arguments
now moves our strategy on all three.

**`laplace.nash.exploitBlend` (ships `0.0`) is the second half.** Our published frequencies were the
*unexploitable* mix, which by construction leaves value on the table against an opponent the same
solve has just priced as NOT playing it: with `b` = `exploitBlend`,
`confidence = (1 - b) * equilibriumFrequency + b * softmax(rowValues)`. At `0` the blend is skipped
entirely — no copy, no rescale — so `nashFrequency` and `confidence` stay the same number and the
ranking is the equilibrium one, bit for bit; at `1` it is the softmax over the solve's own row values
at `laplace.temperature`; in between it is the exact convex combination. §10 pins the identity, the
softmax, the combination and the distribution property, and `nash-exploitblend` is the row that
prices it. **It is not adopted** (see N3), and its caveat says why a flat row here is expected.

### N2. The endgame tier can now rank a proof: `laplace.endgame.promoteMate` (ON)

§M1's finding was that `_tiers` wrote the endgame solver's report into `lastReadout.endgame` and
**nothing in the ranking path read it**, so enabling the solver could not change a single decision at
+31 % wall clock (and +55 % once `solveAcrossWorlds` priced every world). The tier was a measurement
whose only measured property was its cost.

`laplace.endgame.promoteMate` makes a PROOF rank: when the report says `solved && isMate` (the search
refuses mates through a Speed chance node, and with `multiWorld` on, `solveAcrossWorlds` requires
every surviving sampled world to prove the same root), the root action is spliced to the top of
`ranked` with confidence 100 while every other line drops to 0, stamped `mateProven` / `mateIn` /
`mateReason` so the override is visible rather than silent. It returns null — the promotion is
SKIPPED, never approximated — when the report is not a mate, when the root is not one of our
non-vetoed rows, or when the leaf is off. Like the five hardening corrections it ships ON, and like
them it is inert in the shipped build because the tier it belongs to still ships `enabled: false`.

`tests/endgame_check.js` §7 pins the promotion on constructed proofs (and a non-mate report, a vetoed
root, and the leaf off). The new row **`endgame-promote`** is the control the pair needs: it runs the
SAME tier with the promotion switched off, so `Δ(endgame-3v3) - Δ(endgame-promote)` is what the search
itself is worth rather than what the tier costs.

### N3. The sweep: five rows, one winner, and one row that stayed `identical`

`node tools/run_ablation.js --features surprise-mask,endgame-promote,nash-prior,nash-exploitblend
--mirror --battles 60 --seed 1337 --parallel 2 --keep-tmp --baseline <reused report>` — mirror, 60
paired battles per row, **0 errors**, 3,187.7 s wall on a 2-core box. `nash-qre` and `endgame-3v3`
were measured in the same sweep's first half against the same baseline (kept reports), so all six rows
sit on ONE reference arm: **25-34-1 = 41.7 %** win, 42.5 % match score, 62.3 turns, 2/60 capped.

| row (the leaf the variant patches) | variant win % | Δwin | 95 % CI | Δscore | 95 % CI (score) | Δturns | verdict |
|---|---|---|---|---|---|---|---|
| `nash-prior` (on) | **63.3 %** (38-17-5) | **+21.7** | **[+5.0, +36.7]** | **+25.0** | **[+8.3, +40.0]** | +0.8 | **feature HELPS → ADOPTED** |
| `surprise-mask` (on) | 38.3 % (23-37-0) | −3.3 | [−15.0, +8.3] | −4.2 | [−15.0, +6.7] | +0.9 | no measurable effect |
| `nash-exploitblend` (on) | 41.7 % (25-34-1) | +0.0 | [−6.7, +6.7] | +0.0 | [−6.7, +6.7] | **−1.1** | no measurable effect (moved games, not outcomes) |
| `endgame-3v3` (on) | 41.7 % (25-34-1) | +0.0 | [+0.0, +0.0] | +0.0 | [+0.0, +0.0] | **−0.03** | no measurable effect; NOT `identical` any more |
| `endgame-promote` (off) | 41.7 % (25-34-1) | +0.0 | `identical` | +0.0 | `identical` | +0.0 | `identical` — expected, and it is the control |
| `nash-qre` (on) | 41.7 % (25-34-1) | +0.0 | `identical` | +0.0 | `identical` | +0.0 | `identical` — the mirror declares no rating (see below) |

**Three readings worth more than their deltas.**

1. **The endgame pair finally separates search from promotion.** `endgame-promote` reproduced the
   baseline in EVERY battle (same winner and same turn count): with the promotion off, the tier —
   running, at the same bounds, with `solveAcrossWorlds` pricing every world — changed no decision at
   all. `endgame-3v3`, the same tier with the promotion ON, moved one battle by one turn. That is a
   null instrument becoming a live one, measured rather than asserted, and it is the honest size of
   the effect at this sample: a proven mate is rare in a 60-battle mirror, so the row is now
   *priceable* without being *priced* — the win-rate value of ranking a proof needs a corpus that
   reaches endgames.
2. **`nash-qre` is still `identical`, for the documented reason and not the old one.** The mirror
   league declares no rating for the persona seat and `_qreTau` resolves an unknown opponent to the
   hard response (an unknown opponent is not evidence of a noisy one), so the tier resolves to
   `tau = 0` and the whole argument is absent. §7b pins the tier engaged on a rated board (1200 →
   tau 22.9) where the temperature now DOES move our frequencies, so the row's flatness is a property
   of this instrument. It is not resolvable here: the personas arena is the only other instrument and
   its baseline sits at 98.3 % with no headroom (§H).
3. **`surprise-mask` did not reproduce §M2's `stall`, and that is the fix showing.** The old reading
   (four seats, 73.3 % against 78.3 %, three wins and three losses converted into 100-turn standoffs)
   was taken with the loop still one-way; the mask now reaches a ranking, and on the mirror it is
   −3.3 with **zero** cap ties against the baseline's one. Still not adopted (there is nothing to
   adopt), and the assumption to keep in view is its own: the mirror's lead sets are fully revealed
   from turn 1, which is the one board where the tier is inert by construction.

### N4. The adoption: `laplace.nash.priorAnchored.enabled` is now `true`, on TWO seeds

| seed | baseline | `nash-prior` (on) | Δwin | 95 % CI | Δscore | 95 % CI (score) | Δturns | cap ties |
|---|---|---|---|---|---|---|---|---|
| 1337 | 41.7 % (25-34-1) | **63.3 %** (38-17-5) | **+21.7** | [+5.0, +36.7] | +25.0 | [+8.3, +40.0] | +0.8 | 2/60 → 5/60 |
| 20261016 | 43.3 % (26-28-6) | **68.3 %** (41-15-4) | **+25.0** | [+8.3, +41.7] | +23.3 | [+8.3, +38.3] | **−9.6** | 7/60 → 5/60 |

Each seed's point estimate sits inside the other's interval, both intervals exclude zero on BOTH
scales, neither seed flags a stall, and the second seed's games are 9.6 turns SHORTER with fewer cap
ties — a behavioural reading agreeing with the win-rate one. §L3 established that a single-seed mirror
row is a candidate for a second seed and not a result; this is the first row in the table to clear
that bar, and it is why the default flipped. Per §H.7 the row was re-pointed (`direction: 'off'`,
patching the leaf DOWN), so it now measures the price of switching the tier back off.

**What moved, and why — the pins the adoption retired.** Four of the suite's pins encoded "ships OFF"
or "off == the shipped build", so each was updated in the direction the decision requires, and none of
them was weakened:

* `tests/tuning_check.js` §9's flag pin now asserts `true`, with the adoption named.
* §9b's `enabled: false is bit-identical to the shipped build` is RETIRED AS SUCH — the shipped build
  IS the anchored solve now, so "off" cannot equal "the shipped default" any more. It is replaced by
  the two facts that still matter: the default publishes the anchored mix at the measured weight, and
  the OFF engine is a genuinely different policy. The solver-level identity (no argument at all = the
  historical loop) is pinned separately in §7b and is untouched.
* §10's lure fixture reads the shipped config, so its sighted split moved 47.6 % → 46.4 %; the claim
  (the mask carries the lure to the top of the ranking, at 99.9 %) is unchanged.
* §5's beam fixtures and §7's temperature fixtures now pin `priorAnchored` OFF, because they measure a
  DIFFERENT tier: the beam's own illustration (Encore above Close Combat) no longer holds on the
  anchored base, and §5d now pins that interaction explicitly instead of quietly attributing the
  anchored ordering to the beam.

### N5. What this pass did NOT establish

* **Nothing about the ladder.** The `nash-prior` win is against a **frozen copy of this engine**. It
  is a replicated, two-scale, two-seed *self-play* result; whether exploiting a softer opponent model
  transfers to human opposition is the question E5 asked and this instrument cannot answer. The
  personas arena is the only available check and it has no headroom left (§H).
* **Nothing about `priorWeight`.** 0.25 is the midpoint of `[0, 1]`, adopted because it is the value
  the two seeds measured. The quantity that would set it — a usage corpus of the opponent's own action
  frequencies — is exactly what this repository does not have offline.
* **Nothing about the endgame tier's win-rate value.** See N3.1: the pair proves the promotion is live
  and that the search without it is inert; it does not price a mate.
* **Nothing about `surprise-mask` on the board it was built for.** The mirror's lead sets are fully
  revealed from turn 1, so a flat row here is the documented construction and not a refutation.
* **Nothing on a second instrument for anything but `nash-prior`.** Every other row here is one seed,
  n = 60, SE ≈ 6 win points — the §H standard, and still a 60-game deal.

---

## O. The fidelity instrument itself (2026-10-16) — agreement is a proxy, and two of its floors were wrong

This pass changes **no engine behaviour**. It changes the instrument that says how good the policy is,
because the number this repo quotes about its own policy — top-1 agreement — was being read as if it
answered a question it does not.

Corpus for every number below: `tools/fetch_replays.js --format gen9nationaldex --min-rating 1700
--sort rating` → **399 battles**, rating band 1857–1992 (mean 1883), **25,284 scored decisions**
(27,662 records), 1,136.5 s on a two-core box. Artifacts: `humanmatch-elite399.txt` (the rendered
report) and `humanmatch-elite399.json` (its summary). The `--out` per-decision file (23 MB) is not
committed; those two artifacts are a pure re-fold of it, and the re-fold reproduces **every field this
pass does not touch exactly** — `all`, `contested`, `byKind`, `buckets`, `regret.all`,
`regret.byBucket`, `chanceFloor`, `pivotCeiling` and `flatness` are all `===` to the run's own output.
That equality is the check on the whole pass: the instrument changed, the measurement did not move.

### O1. The headline is the gap, and agreement is printed beside it as the proxy

The report now opens with the score gap — the human's own click priced by our own evaluator, as
`(topScore - humanScore) / spread` — instead of with agreement:

| reading | decisions | value |
|---|---|---|
| a spread existed at all | 24,426 of 25,284 | — |
| the human's click was **within 5 % of our pick** (a wash) | 11,764 | **48.2 %** |
| the human's click gave up **30 %+ of the menu's spread** | 8,925 | **36.5 %** |
| median / mean regret share | 24,426 | 0.071 / 0.306 |
| median / mean regret in the evaluator's own units | 24,426 | 7.8 / 60.4 |
| top-1 AGREEMENT, on the same decisions | 25,284 | **34.7 %** |
| ...the literal 5 %-of-the-pick framing instead of 5 %-of-the-spread | 11,791 of 24,426 | 48.3 % |
| ...and the 30 % band at the SAME literal-pick framing | 9,002 of 24,426 | 36.9 % |

The two readings are much further apart than the aggregate makes visible: agreement says we match an
1883-rated human about a **third** of the time, and the gap says that on nearly **half** of those
disagreements the human's line was worth what ours was worth. Both are true, and only the second is a
statement about how much the disagreement cost. The two
"within 5 %" framings agree to a tenth of a point **on this corpus** and are still printed separately,
because the literal one is undefined when the top score crosses zero; that they coincide here is a
fact about these 24,426 menus, not a property of the metric. Both bands are now reported in BOTH
framings — 48.2 % / 48.3 % at the 5 % threshold and 36.5 % / 36.9 % at the 30 % one — because a table
that gives the wash band as a share of the spread and the blunder band as a share of the pick cannot
be compared with itself, which is a defect the first version of this table had.

### O2. The turn buckets come with a test now — and they are NOT flat

The earlier flat turn read (30.8 / 32.4 / 31.6 on the older, pre-adoption corpus) came with no test
attached, so "flat" was a shape rather than a finding. `extremeSpread` now runs the two-sample comparison on
the best and worst bucket (twice the standard error of the difference) on both readings:

| bucket | decisions | top-1 | wash ≤ 5 % | median share | median units |
|---|---|---|---|---|---|
| opening (1–5) | 3,696 | 38.2 % | **54.6 %** | 0.015 | 0.8 |
| mid (6–15) | 6,937 | 35.7 % | **51.7 %** | 0.035 | 3.9 |
| endgame (16+) | 14,651 | 33.3 % | **44.8 %** | 0.116 | 18.8 |

`opening -> endgame` agreement **z = 5.51**, wash share **z = 10.56** — **NOT flat on either**, and
both fall monotonically while the median regret in raw units rises by a factor of 25 (0.8 → 18.8).
So the answer to "is the aggregate hiding a phase?" is yes, and the gap says it twice as loudly as
agreement does (−9.8 points of wash against −4.9 points of top-1). This is the practical value of the
test: the engine is not uniformly mediocre, it is **decent early and weaker late**, and the endgame is
both the weakest phase and, at 14,651 decisions, the slice a fix can be measured on most cheaply.
The report still refuses to overclaim in the other direction — a FLAT verdict is printed as "not
distinguishable at this n", never as "equal", and the levels are always printed beside it.

### O3. Consensus sets: re-pointed to the matchup, and TWO floors were wrong

The pass re-points the consensus grouping from `stateKeyOf` (active pair + HP quintile + field) to
`matchupKeyOf` (**the active pair alone**, HP and field deliberately excluded), and keeps the fine
partition as a reported diagnostic rather than deleting it:

* **Coarse:** 6,220 buckets; **1,352 qualify** at `MIN_CONSENSUS_N` = 5, covering 15,436 of 25,284
  decisions (61 %).
* **Fine:** 16,582 buckets; **434 qualify (2.6 %)**. This is the measurement of the "you need more
  state-clustering machinery" question: at 399 battles the pair+HP+field partition is not merely thin,
  it is unusable, and no amount of arithmetic over it would fix that. The report says so in place.

**The defect, found by using the new numbers rather than by reviewing the code.** Of the 1,352
qualifying buckets, **377 are degenerate for the top-3 test**: elites clicked three distinct lines or
fewer there, so the human top-3 is *every* line clicked and "our pick was in it" is true by
construction. Pooling those with the honest ones gives **63.7 %**, which is a number made of
guarantees. Separately, the floor printed against it (mean `3 / distinctHuman` = **75.1 %**) models a
random draw among the lines **elites clicked** — not a random engine, which draws from its **own
menu**. Both were misleading in the same direction, and together they made a working metric read as
"worse than random", which is false:

| reading, over the **975 informative buckets** (12,988 decisions, 5.99 distinct lines on average) | value |
|---|---|
| our top pick was among the three most-clicked lines | **62.7 %** (611/975) |
| ...against a random line from **our own menu** — the faithful baseline, and an upper bound | **51.3 %** |
| ...against a random draw among the lines **elites clicked** (3 of their distinct count) | 56.1 % |
| the line elites clicked MOST was within 5 % of our pick (macro over buckets) | **56.4 %** |
| ...pooled over every click in the qualifying buckets | 45.3 % |
| the single most-clicked line's share of its bucket | 43.9 % |

So the corrected answer is that the engine's modal pick **does** beat a random engine on matchup
buckets, by ~11 points of a loose upper bound — a real but modest signal, and a very different
statement from the 63.7 %/75.1 % pair the first version of the section would have quoted. The four
thickest buckets (n = 208 / 112 / 111 / 107) all have our modal pick inside the elite top-3, and they
also show the shape of the disagreement: in a **Gliscor mirror** elites' modal click is
`switch:toxapex` (63 of 208) while ours is Defog/Knock Off, and in `toxapex vs gliscor` the modal
click is `switch:gliscor` (68 of 111) against our `move:scald`.

### O4. What this changes about how the aggregate is quoted

Two slices were already in the report and are now the honest way to read the headline:

* **The halves are not the same instrument.** SWITCH top-1 is **18.4 %** (1,281/6,971) against a
  **complete-menu** floor of **17.2 %** — i.e. on the one half where the menu is not starved, the
  ranking is barely one point above chance. MOVE top-1 is 40.9 % (7,489/18,313) against an 18.2 %
  floor, and that half carries the starved-menu caveat (8,732 of 25,284 clicks were moves the log had
  not revealed). The aggregate 34.7 % is the average of a near-chance half and a better-than-random
  half. Contested subset: 28.4 % against 16.7 %, **1.70× chance**.
* **The pivot ceiling.** 6,936 of 18,313 move-clicks (37.9 %) had a SWITCH on top while the human
  attacked, and on those our own best non-pivot line WAS the human's click 56.3 % of the time. Never
  pivoting while holding an attack would score 62.2 % on move-clicks and **45.1 % overall** against
  the shipped 34.7 % — so the ceiling is ~10 points of top-1 and, per §H/§L, the one measured attempt
  to reach it cost 26.7 win points. The reporting is not what is broken; the preference still is.
* Context that belongs beside the rate: 858 of 25,284 clicks (3.4 %) were on a line the veto layer
  refuses (SPEED_SUICIDE 461, ABILITY_IMMUNITY 170, WASTED_HAZARD_CLEAR 94); elites switched on
  34.7 % of contested turns while our top-1 was a switch 45.2 % of the time; 6.14 lines were offered
  on average.

### O5. What this pass did NOT establish

* **Nothing about playing strength.** No engine file changed. Every number here is a reading of one
  frozen build against replays.
* **Nothing beyond one corpus.** One format (gen9nationaldex), one rating slice (1857–1992), 399
  battles, one fetch. A second rating band was fetched and **not run** (1,998 replays at 1600+,
  `--pages 40`); the band comparison is unexplored.
* **No comparison against the older readings.** The 31.7 % / 44.0 % agreement figures quoted elsewhere
  in this repo are a different corpus AND a pre-adoption engine, so no delta is computed here.
* **No fitted threshold.** 0.05 of the menu's spread is a convention that makes "a wash" printable and
  comparable; it is not calibrated to anything, and the endgame's 44.8 % at that cut would move with
  it.
* **Still a coarse key.** The whole consensus pass now rests on the matchup bucket; the fine partition
  qualifies on 2.6 % of its buckets, and nothing in the report prices the disagreement the coarse key
  hides (two boards with the same pair and 90 % versus 20 % HP are one bucket).
* **Nothing about the winner of a battle.** This has always been a policy-fidelity instrument; the
  gap makes it a better one, not a ladder rating.

## P. The input-population assertion (2026-10-16) — one check in three harnesses, and two new harness gaps

WHAT WAS WRONG. Every harness proved a `--set` LANDED (its own `appliedSets` echo) and nothing proved
the INPUT that flag reads was ever SUPPLIED. The two are indistinguishable from the output: a flag
whose channel is empty returns its inert default every turn, so the variant and the baseline come
back byte-identical and the report prints "this feature does nothing". §D is the register of that
failure class — D1, D2, D4 were each diagnosed by hand, one at a time, by whoever happened to notice.

THE CHECK. `tools/harness_inputs.js` wraps `evaluateTurn` — the one choke point all three harnesses
reach — records the first turn each channel is actually populated, and REFUSES the run when an
applied `--set` maps to a channel that was never seen. It is wired into `run_arena` (the session
engine), `run_ablation` (cross-process, off the child report's own `inputSupply` block) and
`benchmark_human_match` (via `engine_bridge`). A refusal is a SETUP error, exactly like a short echo.

WHAT IT FOUND IMMEDIATELY, and this is the part worth keeping:

| harness | flag | channel | verdict |
|---|---|---|---|
| `benchmark_human_match` | `laplace.volatility` / `laplace.comeback` | `state.moveAccuracy` (`\|stacc\|`) | **REFUSED — unpriceable there.** The ARENA supplies it (the D1 fix forwards the frame from the sim dex); this harness builds the engine directly and forwards nothing, so both tiers are inert in a harness nobody had noticed was blind |
| `benchmark_human_match` | `laplace.scouting` / `laplace.surpriseMask` | `state.active.opp.candidateSets` | **REFUSED — unpriceable there.** The candidate pool is populated by the arena's pipeline from turn 2 and NEVER in this harness, so the scouting bounty and the surprise mask cannot be measured here at all |
| `run_arena` | all 40 flags of the ablation registry | — | supplied, once the table was corrected (see below) |

WHICH CHANNELS ARE POLICE-ABLE, THE LINE DRAWN. Only inputs something OUTSIDE `evaluateTurn` has to
supply: a driver-published snapshot (`state.clock`), a client frame (`|stacc|`), the `|player|`
rating, and the pipeline stages the boot must wire (their replies, our switch rows, the pruner's
candidate pool). A value the ENGINE computes itself — the win-condition plan, the profiler's column
factor, the beam gate — is NOT policed: when those read inert it is because the tier looked and found
nothing, which is its answer, and refusing on it would punish a legitimate result.
`laplace.wincon`, `laplace.profile` and `laplace.beam2Ply` are classified that way, with the reason
written next to them. The two EMPTY-OVERLAY controls (`pruner.scout`, `usage`) are the same: an inert
row is their EXPECTED result, so mapping them to some other channel — the clock was the first attempt
— would have made the check pass or fail for a reason that has nothing to do with the flag.

WHAT IT DELIBERATELY DOES NOT DO. It does not refuse a path it has no classification for. The first
cut did, and against the real registry that was 29 of 39 rows refused for flags that were perfectly
well supplied — a false refusal is a worse failure than the one the check exists to prevent. An
unclassified path is REPORTED instead (`supplyReport().unclassified`, plus a note in the arena's
output), and the strict rule moved to where the decision is actually made: the new suite fails the
build if any flag in the ablation registry is unclassified. 40/40 are classified.

STATUS OF THE SWITCH MISWEIGHT (§O's open question). The score-gap probe is done: the top-3-but-not-
first cases are a **systematic misweight, not a tie-break** (median gap ~19, 48 % at 20+; only 14 %
exact ties) and it is one-directional — the engine reaches for the fast breaker (62 % of its picks
are faster, +41.7 base BST) where the elite humans reach for the Regenerator / Poison Heal pivot that
absorbs the hit and gives the position back. **No `laplace_core` change was shipped.** The shape the
probe implies is a per-body absorb-and-reposition credit, NOT a flat drag on switching (the flat tax
is B1, measured at −26.7 win points). Turning that into a score term needs a magnitude, and the
records the probe left behind carry `switchScores` as `{ key, score }` only — no post-hit HP, no
sustain, no per-body component breakdown — so the offline "would this term flip the 393 failures?"
step cannot be run yet. The next instrument is the prerequisite, not the engine edit: record, per
switch decision and per candidate body, the incoming body's HP after their predicted best hit and its
sustain, then calibrate. Under §H that is a config section, a `tests/config_check.js` inventory
entry, a FEATURES row with a pre-registered expectation, and the arena gate.

NOT ESTABLISHED HERE. The per-channel "seen" turns are evidence the channel was populated by THIS
harness on THIS run (3 battles, anchor, seed 7 for the arena probe; 2 battles for the benchmark) —
not that it is populated in every mode, and not that a supplied channel changed a ranking. The
second half of that sentence is the whole difference between a real result and a false null, which is
why the refusal message says which half it is talking about.

### P1. The base rate the "62.3 % faster" number needed (2026-10-16)

The switch finding in §O and §P was quoted as "62 % of its picks are faster than the human's", which is
a bias only if the turn's typical alternative is not already faster. The records hold the engine's own
score for the top five bodies it offered, so each case has a within-turn pseudo-null. FAILURE band
(n = 393): its #1 is faster than the human's body **62.3 %**, a typical OTHER recorded body is
**37.7 %** (median base-Speed delta 0.0, i.e. the alternatives are mostly not faster), and the human's
body is faster than every other recorded body 16.8 %. CONTROL band (its #1 IS the human's body, n = 298):
the same comparison reads 52.5 % — near a coin flip — and the human's body is the fastest of the set more
often (23.5 %). So the bias is real and not the bench's base rate, within base stats and the engine's own
top five; a menu-wide null still needs the recorded menu, which does not exist yet.

### P2. The move half has the SAME gap, and a bigger one — the earlier "clean half" reading was a menu artifact

§O4 read the move half as the *better* half (MOVE top-1 40.9 % vs SWITCH 18.4 %) and the switch half as
the near-chance one, and the top-3-vs-top-1 diagnostic was run on switches only. The record writer now
carries a move-only sub-ranking (`moveRank`/`moveTop3`/`moveFloor`/`moveScores`, mirroring the switch
block), the summary reports it, and 16 checks pin it. At 40 battles / 1,922 scored decisions:

* same-kind top-1 against the SAME-KIND uniform floor: moves 67.1 % vs a 64.4 % floor (**+2.7 pts**,
  median menu 2 lines, 92.1 % of menus <= 3 lines, 39.9 % exactly one), switches 29.8 % vs 26.7 %
  (+3.1 pts, median menu 4). Both halves are ~3 points above their own chance level; the move half only
  LOOKS better (or worse) because its menu is degenerate.
* the move top-3 (98.8 %) is NOT evidence of good ordering: with 92.1 % of move menus <= 3 lines it is
  mostly "the human's move was in the menu", which a scorable decision already guarantees.
* the score gap with menu width held fixed (>= 3 same-kind lines, human's line in the top-3 but not
  first): SWITCH bodies n = 194, median **16.8**, 45.4 % at 20+; **MOVES n = 218, median 35.2, 60.1 % at
  20+**. The 80-battle switch reading (18.8) reproduces, which is what makes the comparison usable.

So the misweight is not a switch-specific pathology to be fixed in the body preference alone: the same
shape appears where the engine chooses among MOVES, larger. This does not change the decision not to
ship a scoring change — the calibration problem is unchanged (the records still carry no post-hit HP or
sustain) — but it does mean the eventual term cannot be justified as a body-choice correction only.
### P3. The move-half gap, with intervals — and where the sustain actually is not (2026-10-16)

The 40-battle reading in P2 was a direction, not a magnitude. Rebuilt at 200 battles (12,073 scored
decisions) with a CLUSTER bootstrap over battles (B = 2,000) — the unit has to be the battle, because
every decision inside one shares a board, a team and a plan. Doing that required a new field: `replay`
in a record is the SIDE PASS index (two values in a 200-battle run), so nothing in a record file grouped
by battle. `scoreDecision` now stamps `battle`, three checks pin it, and the derivation used for the
older file reproduced all 200 clusters.

| population | n | top-1 vs same-kind floor | excess [95 % CI] | menu <= 3 lines | gap median [CI] | 20+ [CI] |
|---|---|---|---|---|---|---|
| MOVES | 8,436 | 64.8 % vs 61.3 % | **+3.6 pts [2.6, 4.6]** | **88.4 %** (median 2 lines) | **35.2 [27.9, 42.6]** | **60.6 % [56.1, 64.9]** |
| MOVES, log-revealed | 4,292 | 57.2 % vs 51.0 % | +6.2 pts [4.6, 7.9] | 81.5 % | 43.0 [33.7, 57.1] | 64.8 % [59.1, 69.6] |
| SWITCH bodies | 3,206 | 28.8 % vs 25.7 % | +3.1 pts [1.4, 4.9] | 19.0 % (median 5) | 16.6 [13.2, 19.4] | 45.5 % [41.6, 49.2] |

1. The menu-width asterisk on the MOVE half SURVIVES: 88.4 % of move decisions offer <= 3 same-kind
   lines, so its top-3 (97.9 %) is mostly inclusion and top-1 is the only quotable rate there.
2. The excess over the same-kind floor is small in BOTH halves (+3.6 / +3.1) and its interval excludes
   zero in both. Read against its own menu, the engine is ranking, but only just.
3. The width-controlled gap replicates and the intervals do not overlap: MOVES 35.2 [27.9, 42.6] against
   SWITCH BODIES 16.6 [13.2, 19.4]. So the move-half misweight is larger, not a 40-battle artifact. The
   revealed-only subset is worse still (43.0) — the opposite of "the starved menu explains it".
4. Still NOT established: the magnitude a fix would need. These are one corpus and one rating band.

### P4. Where sustain is missing, exactly (2026-10-16) — the label hypothesis has a feature-sized hole

The natural reading of P3 is "the fit learned offence because the label is blind to sustain". The code
says the hole is one step earlier. The 128D evaluator's dims are HP (0-23), status (24-35), boosts
(36-47), hazards (48-55), field/TR (56-63), items (64-75), a 36-dim THREAT matrix (76-111) and 16 macro
aggregates (112-127: alive counts, team-HP fractions, hazard/status differentials, boost sums, cleaner
and Tera threat, recovery-PP pressure, Speed edge, Protect rhythm). There is **no dim for ability-driven
sustain**: healing enters only as `_recoveryPressure`, i.e. the fraction of the 8-PP healing-MOVE budget
SPENT — a cost, not a yield — and the `items` dims are item KNOWLEDGE by construction. So a linear model
cannot represent "this body's HP is recoverable" at any weight, whatever the label says.

The engine does carry one Regenerator credit (`laplace.pricePivots`, ships ON, `regenPct` 33.3), and it
cannot move this finding: it credits the body LEAVING, and on a given turn the outgoing body is the SAME
whichever body we switch to, so it is a constant across the candidate rows. The misweight is in the
RANKING OF THE INCOMING BODY, where the only evidence in play is an offence-heavy threat matrix with no
sustain counterweight.

So the ordering is: feature (a recoverability/sustain dimension, or an equivalent engine-side credit on
the incoming row), then possibly label shaping, then the gated tier. A "reposition credit" without the
feature is a patch over a hole the model cannot see through. Nothing was changed in laplace_core.

### P5. The fitted weights split their own sums — the effective weight per fact, measured (2026-10-16)

The shipped `evaluator.weights` (src/config.js, mirrored in lib/trained-weights.json `spec`) contains
two blocks that are EXACT linear combinations of other blocks. This is arithmetic on the extractor,
not a suspicion:

- Dims 48..55 ARE the four hazard kinds on each side. `v[116] = _hazardDifferential` is
  `(cost(theirs) - cost(mine)) / 37.5` with `cost` = 12.5·rocks + 8.3·spikes + 12.5·tspikes + 8·web
  (src/evaluator_128d.js:376). Substituting the base dims gives
  `v[116] = 0.3333·v52 + 0.6640·v53 + 0.6667·v54 + 0.2133·v55 - 0.3333·v48 - ...` — a FIXED linear
  combination of dims 48..55.
- Dims 36..41 are the six stat stages of our active body as `stage / 6` (`_boostBlock`), and
  `v[118] = _boostSum(myActive) / 18` (line 399) is the plain sum of those same six.
  So **`v[118] = (1/3)·(v36 + ... + v41)`** exactly; `v[119]` against dims 42..47 the same way.

A fit on a design matrix with two exactly collinear directions is identified only up to the split, and
`tools/fit_weights.js` resolves the indeterminacy with ridge (`lambda`, on standardized columns —
lib/trained-weights.json records `lambda: 0.5, standardized: true, converged: true, iterations: 35`).
Ridge distributes the coefficient between the two copies, which is how the artifact came to carry
`macro[4] = -9.287` against base hazard dims of +3.36..+6.57, and `macro[6] = +18.372` against base
boost dims of -4.84..-5.62. At `evaluator.fitScale` 52.2 those become -484.8 and +959.0 — the numbers
this file's earlier sections quoted — so **no individual coefficient in that artifact can be read as
"what the model learned."**

What CAN be read is the net effect of one fact, so that is what was measured: score a board, apply
exactly ONE fact, score again, and attribute the change dim by dim (`.freebuff/weights_marginal.js`).
`evaluate` is `1000·tanh(raw / 420)`, so the additive quantity attributed is `raw`; every weight below
is already multiplied by `fitScale` 52.2.

| one fact                      | base dim            | macro dim            | effective (net) |
|-------------------------------|---------------------|----------------------|-----------------|
| Stealth Rock on THEIR side    | dim 52, +175.2      | dim 116, -161.6      | **+13.6**       |
| Spikes x1 on their side       | dim 53, +114.3      | dim 116, -107.3      | **+7.0**        |
| Spikes x3 on their side       | dim 53, +342.8      | dim 116, -321.9      | **+20.9**       |
| Toxic Spikes x1 on their side | dim 54, +166.1      | dim 116, -161.6      | **+4.5**        |
| Sticky Web on their side      | dim 55, +165.8      | dim 116, -103.4      | **+62.4**       |
| Stealth Rock on OUR side      | dim 48, -183.6      | dim 116, +161.6      | **-22.0**       |
| our active +1 Atk             | dim 36, -42.1       | dim 118, +53.3       | **+11.2**       |
| our active +2 Atk             | dim 36, -84.2       | dim 118, +106.6      | **+22.4**       |
| our active +1 Def             | dim 37, -48.8       | dim 118, +53.3       | **+4.5**        |
| their active +2 Atk           | dim 42, -15.2       | dim 119, -5.0        | **-20.2**       |

Three things follow, and they are why this section exists:

1. **The SIGNS are right.** Their hazards help us, ours hurt us, our boosts help us and theirs hurt us.
   The artifact is not inverted, so the caveat wording that shipped with the own-move-effects tier —
   "setting hazards has net negative weight under the current fit" — is FALSE for every layer and is
   retracted here. The tier itself is unaffected: it ships OFF on a win-rate gate, not on that number.
2. **The MAGNITUDES are not.** Three single-layer hazards the differential prices at 12.5, 12.5 and 8
   chip points come out at +13.6, +4.5 and +62.4 — a 14x spread between Toxic Spikes and Sticky Web,
   decided by how much of each base weight the residual cancels and not by the layer's value. The
   third Spikes layer is worth MORE than the first two together (+13.9). So the engine's ordering
   among HAZARD MOVES is driven by the collinear split — exactly the quantity this project keeps
   trying to calibrate — and it is not currently a measurement of anything.
3. **The fit is weak, so there is no "learned weight" to read even in principle.**
   lib/trained-weights.json reports AUC 0.751 train / **0.701 test** over 111,820 samples with a
   grouped holdout, and eight dims (41, 47, 66, 67, 72, 73, 120, 121) were fitted to
   `nonzero: 0`-or-near-zero and then CLAMPED. Dims 120/121 are the Tera-threat pair this format
   cannot activate; 66/67 and 72/73 are item dims the corpus never populated — M4's point, now visible
   in the artifact's own metadata rather than only in a test fixture.

So a refit with the macro sums projected out (or dropped outright) is the prerequisite for any
calibration that expects to read a coefficient: it makes the base block the answer instead of one half
of a split. **Not established here:** projecting the sums cannot change a single prediction — the net
effects are what they are either way — so a refit buys a readable artifact, not a better model. Whether
better-readable weights change any decision is untested, and the 0.70 test AUC is the reason to expect
little.

### P6. The move-half gap is a LEAF-TRANSITION hole — sliced by move category, then measured with the fix ON (2026-10-16)

§P4 said the hole is a missing sustain FEATURE. That is true about the sustain misweight and it is not
what the move half is failing on. The move half is failing on a leaf-transition omission, and the
falsification test is one pass over records that already existed: **slice the gap population by the kind
of move the human clicked.** If the gap lives in the families whose board change `_payoff` never wrote
to the leaf, the hole is the leaf; if it is spread evenly, it is the model.

It is not spread evenly. Over the 8,436 ranked move decisions of the 200-battle corpus, with the gap
population defined exactly as §O/§P2 define it (a menu of >= 3 same-kind lines where the human's click
sits in the engine's top-3 but not first; n = 1550, overall median gap 35.2):

| family the human clicked | n | top-1 | excess over its own uniform floor | medGap | in the gap pop |
|--------------------------|---|-------|------------------------------------|--------|----------------|
| damaging                 | 4124 | 80.6% | **+18.9**                      | 7.5    | 480 (31.0%)    |
| Knock Off                |  276 | 80.8% | **+11.3**                      | 0.3    |  30 (1.9%)     |
| pivot                    |  801 | 64.2% | -2.0                           | 36.2   | 127 (8.2%)     |
| recovery                 |  646 | 44.1% | -4.7                           | 41.4   | 204 (13.2%)    |
| setup                    |  633 | 46.6% | -17.1                          | 45.5   | 176 (11.4%)    |
| other status             |  501 | 47.1% | -15.7                          | 60.0   | 151 (9.7%)     |
| hazard set               |  498 | 50.6% | -16.6                          | 36.3   |  83 (5.4%)     |
| Protect                  |  370 | 35.9% | -16.9                          | 83.5   | 143 (9.2%)     |
| status infliction        |  366 | 31.4% | **-24.7**                      | 60.9   |  96 (6.2%)     |
| hazard clear             |  204 | 41.2% | -17.7                          | 67.1   |  58 (3.7%)     |

The engine beats its own uniform floor on exactly two families and they are the two whose board change
it already prices: raw DAMAGE (+18.9 pp) and Knock Off's damage (+11.3 pp — the item rider is still
unwritten and, at medGap 0.3, it is not what is costing anything). On every family whose effect the
leaf does not carry it lands 16-25 points BELOW the floor, and the median gap there is **7.7x the
median gap of a pure attack** (57.5 vs 7.5 over all seven unwritten families, 707 of the 1550 gap
decisions). The extreme cases are the ones that move nothing a damage calculator can see: Protect
(medGap 83.5), hazard clear (67.1), status infliction (60.9).

So much for "the evaluator is mis-weighting moves". The 128D evaluator has fitted weights for hazards
(dims 48..55), status (24..35) and boosts (36..47), and `_payoff` was handing it leaf boards on which
those three channels are IDENTICAL across every candidate move. The question was not answered wrongly;
it was never asked.

#### The fix, and what it measured

`laplace.priceMyMoveEffects` (src/config.js, ships OFF) is `_payoff` writing our own move's board change
onto a shallow copy of the leaf: the 29 setup moves' stat stages and HP price, the hazard setters' layer
and the removers' clear, plus our boosted Defence/Special Defence inside that turn's reply. It is a
leaf-transition change, not an evaluator change, and the paired 200-battle replay says so in the two
places it must: **every family it models moves a lot, and the families it does not model barely stir.**
Same corpus, same battles, same seeds; the OFF arm reproduces §O's published baseline to the decimal
(34.6 % top-1, 12,073 decisions, band 1799-1992 mean 1829).

| family | top-1 OFF -> ON | excess vs floor OFF -> ON | medGap OFF -> ON | gap pop OFF -> ON |
|--------|-----------------|---------------------------|------------------|-------------------|
| setup                | 46.6% -> **66.7%** | -17.1 -> **+2.9** | 45.5 -> 34.6  | 176 -> 131 |
| hazard set           | 50.6% -> **63.9%** | -16.6 -> **-3.4** | 36.3 -> 33.3  |  83 ->  72 |
| hazard clear         | 41.2% -> **61.3%** | -17.7 -> **+2.3** | 67.1 -> 145.6 |  58 ->  42 |
| damaging             | 80.6% -> 78.1%     | +18.9 -> +16.4    |  7.5 ->  9.3  | 480 -> 510 |
| Knock Off            | 80.8% -> 77.2%     | +11.3 -> +7.7     |  0.3 ->  8.1  |  30 ->  33 |
| pivot                | 64.2% -> 63.0%     | -2.0 -> -3.1      | 36.2 -> 36.5  | 127 -> 133 |
| recovery             | 44.1% -> 43.2%     | -4.7 -> -5.6      | 41.4 -> 39.9  | 204 -> 208 |
| other status         | 47.1% -> 46.7%     | -15.7 -> -16.1    | 60.0 -> 61.7  | 151 -> 149 |
| **Protect**          | 35.9% -> **35.7%** | -16.9 -> -17.1    | **83.5 -> 83.5** | **143 -> 143** |
| **status infliction**| 31.4% -> **31.4%** | **-24.7 -> -24.7**| **60.9 -> 60.9** | **96 -> 96** |

The two largest unwritten families barely stir, and the one motion they DO have is the equilibrium leak
named in the caveats below rather than the tier:

- **status infliction is identical on every statistic reported here** — top-1 31.4 % -> 31.4 %, median
  gap 60.9 -> 60.9, gap population 96 -> 96, excess over floor -24.7 -> -24.7 pp.
- **Protect is identical on median gap (83.5 -> 83.5) and gap population (143 -> 143)** and its own
  `_payoff` is bit-identical (pinned in tests/tuning_check.js §4d), yet its top-1 moves one decision in
  370 (35.9 % -> 35.7 %, excess -16.9 -> -17.1): a Protect row losing first place to a setup row that now
  outranks it. That is exactly the coupling described below, and it is the measurement that shows how
  small it is — the tier's own families move 13-20 pp while an untouched family moves 0.2 pp.

That is the signature of a change that only rewrote the rows it claims, and it is the reason the mutation
is trustworthy where it did move.

**On the report's own headline, not just the derived slice.** Top-1 agreement over all 12,073 decisions
**34.6 % -> 36.9 %**, top-2 **54.8 % -> 57.0 %**, move-vs-move **33.7 % -> 35.2 %**, contested 28.5 % ->
29.5 % (1.67x -> 1.73x chance). And on the score-gap table — a second, independent instrument — the
human's click is within 5 % of our pick on **51.4 %** of the 11,642 decisions with a spread (5,980 vs
5,716) and 30 %+ give-ups fall **35.3 % -> 33.6 %** (3,910 vs 4,113), with the median regret share on MOVE
clicks falling 0.008 -> **0.001** while the SWITCH half is flat-to-slightly-worse (0.267 -> 0.272, 32.7 % ->
32.4 % within 5 %) — i.e. nothing slipped where the tier claims nothing. Paired McNemar on the move-only
top-1 over 8,436 decisions: **240 fixed, 136 broken, chi2 = 28.2, p < 0.001.**

#### Does 35.2 go toward zero? No — and the reason is arithmetic

The overall move-half median gap falls **35.2 -> 31.0 (-4.2, -12 %)**. The unmodelled slice's gap
population shrinks **707 -> 633 (-10.5 %)** and its median 57.5 -> 55.9. But the tier covers only
**317 of the 1,550 gap decisions (20.5 %)**, or 25.5 % of the summed per-decision gaps, because
`_myMoveLeafEffects` writes setup boosts and hazards and nothing else. The families it leaves unwritten
are not a tail: Protect is the single LARGEST contributor to the summed gap (20.4 %), then other status
(15.5 %), recovery (14.4 %), setup (13.7 %), status infliction (10.0 %). A fix over a fifth of the gap
cannot move a median of the whole.

So the ordering §P4 proposed is now the measured one, in two steps: **(1) the leaf-transition hole was
real and is now priced where it was written, and it took the families it covers from below their own
uniform floor to above it; (2) the sustain FEATURE is still the thing standing between this engine and
the rest of the move half**, because Protect (a 1-ply cell with no decay — §L1), status infliction and
other status are all still unwritten, and status infliction remains the worst family in the whole
slice at -24.7 pp.

#### What this pass did NOT establish

- **No arena reading.** The tier ships OFF and this is a policy-fidelity measurement. `expect: 'helps'`
  on its ablation row is still a prior; no win-rate gate has been run for it.
- **One corpus, one band** (elite, 1799-1992), and a single 200-battle pairing. Every number above is
  one run each side; the McNemar is over decisions and the arms share battles, which is the strongest
  form available here, but it is not a second corpus.
- **The hazard-clear blemish is unexplained.** Its top-1 rises 20 pp and its gap population shrinks
  from 58 to 42, yet the median gap on the survivors jumps 67.1 -> 145.6. The tier lifts a clear to #1
  far more often and what is left is a smaller, more extreme set — the same "a closed gap can re-open
  as a bigger one on the remainder" pattern §P3 saw between halves. n = 42, no claim beyond that.
- **`knockoff` got slightly worse** (top-1 -3.6 pp, medGap 0.3 -> 8.1) even though nothing about Knock
  Off changed — its rows lose first place to the setup/hazard rows that now outrank them. The trade is
  net favourable (the McNemar above) but the mechanism is competition, not better Knock Off pricing.
- **The two arms differ by MORE than the patch under test.** Every published row score is
  `nash.rowValues[k]` (`laplace_core.js:3059`), so a row the tier never touched still moves whenever
  the equilibrium mixture does: 91.0 % of unmodelled move rows and 87.4 % of switch rows came back
  exactly unchanged, and the rest moved by a median of 0.00 (p95 0.35 for moves, 3.86 for switches).
  The leaf is local; the RANKING is not. The row-local contract is pinned on `_payoff` in
  tests/tuning_check.js section 4d.

### P8. The threat matrix's speed gate: softened, refitted, and rejected on its own instrument (2026-10-16)

§P5 and §P6 left one claim unactioned, and it was a claim about the FEATURE rather than about a
weight. `_threatMatrix` (src/evaluator_128d.js) builds dims 76..111 as
`clamp(faster * (0.4 + 0.6 * threat))` with `const faster = mySpeed >= oppSpeed ? 1 : 0`, so all 36
cells are **exactly 0** the moment our body is slower — at a tie as well as a hundred points behind.
That is a gate, not a bias: a hard 0 and a small number are different functions of the same feature,
which is why the 36 cells' two collapsed coefficients (`threat` -0.0248, `threatActive` +0.1811) were
fitted on the gated column and why un-gating it is a **refit**, not an edit.

#### What was built

`evaluator.threatSpeedGate` (src/config.js, ships OFF) replaces the binary term with the continuous
decay a speed deficit implies: **1 at parity or faster, falling linearly to `floor` over `span`
Speed points** — the section's own `span: 400`, which is the same number as
`evaluator.speedEdgeSpan`, the span the `_speedEdge` macro dims already use. At `floor: 0` it is a
strict generalisation of the shipped gate — bit-identical for every faster body, i.e. for half the
corpus — with the cliff replaced by a ramp and the tie no longer a discontinuity.

`tests/tuning_check.js` §11 (the suite is at 347 checks) pins the whole contract: the gate-off cell is
exactly 0 for a slower body; the same body keeps a nonzero threat once the gate is on; a body at
PARITY is bit-identical (1 + 0/span is 1); the floor is exactly 0.25 x the parity cell at span 1; and
the entire 76..111 row of a genuinely faster body — our Jolly Great Tusk against their Adamant
Dragonite, checked to be a real speed advantage rather than assumed — is bit-identical to the shipped
gate.

**The scope, measured before any fit.** Re-extracting 40 replays (1,426 rows) with the gate off and on
moves 1,394 rows, and the dims that move are **76..111 only** — all 36, nothing else — with a max
|delta| of 0.99 and a mean of 0.366 across the changed cells. The change is exactly the block it
claims to be, which is the same statement §P6's row-local contract makes about the leaf tier, made
here about a feature block.

**A memo key that had to be fixed to measure it.** `_speedOf` keys its cache on
`mon.slot || mon.id || mon.species` — without the SIDE. Live boards carry side-qualified slots
('p1a' / 'p2a'), so no live battle was affected, but a board whose two bodies share a key (a hand-built
fixture, or `_matchupScore`'s pair, or a mirror) had the second lookup read the FIRST body's speed and
silently invert the speed term. The key now carries `mon.side`, and the fixture that found it is the
same-species pair the §11 test uses.

#### The refit, and the verdict

Same extractor, same corpus (`corpus/replays.json`, 3,521 replays / 107,024 rows), two arms extracted
with the gate off and on, then each fitted with the artifact's own settings (`--lambda 0.5`, a
battle-level grouped hold-out of 5):

| arm | AUC train | AUC test | iterations | low-support dims | clamped |
|---|---|---|---|---|---|
| gate OFF (the fresh control) | 0.7507 | **0.7105** | 11 (converged) | 41(0), 47(17) | 41, 47 |
| gate ON (the candidate) | 0.7496 | **0.7023** | 12 (converged) | 41(0), 47(17) | 41, 47 |

The paired reading, on the SHARED grouped hold-out (22,047 rows over 704 battles — one corpus, one
split, so the two arms are paired by row and the resample unit is the battle that carries the label):
scoring the **exported** (clamped) vectors gives AUC **0.7105 -> 0.6971**, delta **-0.0134**, with a
95 % percentile interval of **[-0.0262, -0.0012]** from a seeded battle-level paired bootstrap
(B = 2,000) in which only **1.3 %** of resamples were positive. Sign accuracy at 0.5 on the same rows:
65.52 % -> 64.69 %. (The fitter's own printed AUCs, 0.7105 / 0.7023, score with the pre-clamp
coefficients; both instruments agree on the sign.)

So the softened speed term is a measured **LOSS**, and it ships OFF — its default — with the refit
recorded rather than adopted. What it does buy is real but is not enough: P5's collinear split
shrinks. `macro[4]` (the net hazard differential) goes **-3.3286 -> -2.9544** against the shipped
artifact's -9.2872, and the base hazard block's magnitude falls with it
(-1.44 / -3.22 / -2.96 / -1.47 -> -1.31 / -2.94 / -2.68 / -1.38), so the artifact is a little less
split between two copies of the same fact. Readable weights are the precondition for reading a
coefficient; they are not a reason to accept a worse model.

#### The control, and a stale artifact

The shipped `lib/trained-weights.json` reports **111,820 samples over 3,712 battles**, while the corpus
on disk yields **107,024 over 3,521** — and 106,956 of those 107,024 rows differ from the shipped
`corpus/training_data.json` (455,766 cells, max |delta| 1, labels identical). The shipped corpus is
therefore not reproducible from the corpus in this checkout, and a comparison against the artifact's
own 0.7011 test AUC would not be apples-to-apples. Both arms above share one corpus and one split;
the honest comparison is table-internal.

One thing that comparison DOES say, and it is worth naming: the FRESH off-arm fit scores **0.7105**
against the shipped artifact's **0.7011** on the same instrument, and it carries **2** clamped
low-support dims instead of **8** (dims 66/67/72/73 — item dims the old corpus never populated — and
120/121 are populated in the new extraction, where the artifact had fitted them at `nonzero: 0`).
The artifact is stale. Adopting a new vector on this evidence is a separate decision with its own
gate, and it is deliberately not taken here.

#### The gate WITHOUT the refit, on the decision instrument

The interval above excludes zero with the REFIT in place, which is the reading that decides the
row — but a weight vector and a decision are different instruments, and the gate alone (no refit:
shipped weights, one config leaf) deserves its own reading on the same 200-battle human-match pairing
§P6/§P7 use. The control is the shipped config on the same battles and seeds (34.6 % top-1 all,
64.8 % move top-1, protect 35.9 %, status infliction 31.4 % — the arm §P6 published and §P7's OFF
half reproduces). It is a null, and by a margin too small to call:

| metric | gate OFF (shipped) | gate ON, shipped weights | delta |
|---|---|---|---|
| top-1 agreement (all 12,073) | 34.6 % | 35.0 % | +0.4 pp (±0.9) |
| top-2 agreement | 54.8 % | 54.9 % | +0.1 |
| top-1 contested (9,301) | 28.5 % | 28.8 % | +0.3 |
| top-1 move-vs-move (6,132) | 33.7 % | 34.1 % | +0.4 |
| top-1 revealed moveset (7,775) | 29.1 % | 29.4 % | +0.3 |
| chosen line was VETOED | 3.6 % | 3.6 % | 0.0 |

Paired on the 8,436 ranked move decisions: move top-1 **64.8 % -> 64.9 %**, McNemar **25 fixed / 19
broken, chi2 = 0.57, p >= 0.1**. The move-half median gap moves the WRONG way — 34.9 -> 36.2 overall,
and on the unmodelled slice 57.5 -> 58.3 (n 709 -> 708) — so the soft term does not close the
fidelity gap it was proposed against either. Every point estimate is inside its own interval.

Two instruments, one verdict: the gate alone is a wash at the decision level (+0.4 pp, one pairing,
interval ±0.9), and the refit it forces is a measured loss out of sample (-0.0134 AUC, interval
excluding zero). `evaluator.threatSpeedGate` therefore stays at its shipped `false`, and the row is
recorded rather than adopted. It is also the third time in this pass that the agreement side and the
strength side point different ways — §P7's two tiers lift agreement with no win-rate reading yet, and
this row lifts the point estimate slightly while losing on the model. Agreement is a proxy; the two
instruments that can contradict it, and both did here, are the hold-out and the arena.

#### What this pass did NOT establish

- **No decision-level reading of the refit.** The AUC instrument is the right one for a change to a
  WEIGHT VECTOR, and its interval excludes zero; a paired human-match run is the tie-breaker to reach
  for when the interval straddles zero, which this one does not. (The gate WITHOUT the refit IS on the
  decision instrument, immediately above: also a null.)
- **One corpus, one rating band, one lambda.** `lambda 0.5` on standardized columns is the artifact's
  own setting, kept so the two arms differ by the feature and nothing else.
- **One shape of softening.** Linear decay to a floor of 0 over `speedEdgeSpan` is a defensible choice,
  not the only one; this reading is evidence against THIS form, not against every continuous speed
  term.
- **The gate is local to the threat matrix.** Nothing else in the extractor reads `faster`, so the
  76..111 result above is the whole affected footprint.

### P7. The other two leaf channels: our status moves and our own Protect, measured on the same instrument (2026-10-16)

§P6 ended by naming what was still unwritten, in order of contribution to the summed move-half gap:
**Protect (20.4 %)**, other status (15.5 %), recovery (14.4 %), setup (13.7 %, since written),
status infliction (10.0 %). Two of those five were fixable the same way the first three were — a
channel the leaf does not carry — and they are the two this pass writes.

#### What was built, and why as two separate tiers

`laplace.priceMyMoveStatus` and `laplace.priceMyMoveProtect` (src/config.js, both shipping OFF) each
own one channel:

- **Status infliction.** Our status move writes its condition onto THEIR leaf body. The move set is
  `U.STATUS_MOVES` — the move's PRIMARY effect (Thunder Wave, Will-O-Wisp, Toxic, Spore, Glare,
  Stun Spore, Nuzzle, Zap Cannon, Inferno, Poison Powder/Gas, Sleep Powder, Hypnosis, Sing, Lovely
  Kiss, Dark Void, Grass Whistle) — and the write is refused whenever the board says it cannot land:
  the body is already statused; the move cannot connect (the type chart nullifies it, or
  `U.immunityReason` names Levitate / Air Balloon / Volt Absorb / Sap Sipper); the status is
  impossible for the TYPE (`U.STATUS_TYPE_IMMUNITY` — Electric bodies cannot be paralysed, Fire
  bodies cannot burn, Poison/Steel cannot be poisoned); the move is a powder and the body is Grass;
  or the target's REVEALED ability is on `U.STATUS_IMMUNITY_ABILITIES` for it. A body that MIGHT
  carry the immunity ability is not enough — refusing on a possibility would delete rows on a guess.
- **Our own Protect.** `laplace.quiescence.blockProtect` prices THEIR shield blocking OUR move;
  nothing priced ours blocking THEIR reply, so a Protect was scored as a turn on which we did
  nothing and ate their best attack in full. On, the cell is priced on the board a shield actually
  produces (their reply deals nothing) and the leaf carries the Protect rhythm the live state would
  carry next turn. Two rules keep it from being a free pass: a CONSECUTIVE Protect fails — the rule
  veto 9 encodes, exempted the same way when a Taunt/Encore means the last one never went off — and
  a reply that pierces a shield (Feint, Phantom Force, Shadow Force, Hyperspace Fury / Hole) is not
  blocked. A shield does NOT stop their SETUP: a Dragon Dance still buys its boost and its modelled
  Turn-2 extension, which lands after this cell, when the shield is gone.

They are separate switches rather than sub-knobs of `priceMyMoveEffects` because that row is a
PUBLISHED measurement of one scope; folding a new channel into it would silently redefine the
experiment every time the bigger one is re-run, and the ablation table's own no-op guard
(tests/ablation_check.js §3) requires each row to be a real single flip.

**The row-local contract, pinned.** `tests/tuning_check.js` §4e (the suite is at 347 checks) proves
both tiers are the identity when off, that an attack / a Taunt / a switch row is bit-identical with
either on, that the two tiers are independent of each other, and — the part that matters for
trusting the measurement — that each refusal above is a refusal, checked on
`_myMoveStatusEffect` directly (Ground body against Thunder Wave, Fire body against Will-O-Wisp,
Grass against a powder, a revealed Limber against Thunder Wave, a body that only MIGHT have it still
writes, an already-statused body keeps its condition, Ice Beam writes nothing), plus the Protect
side: the shield cell equals the hand-built leaf, a consecutive Protect is priced as a failed shield,
the Taunt exemption is live, Feint is not blocked, and the shield does not swallow their setup. The
live path is exercised separately (`.freebuff/leaf_status_probe.js`): with both tiers on,
`evaluateTurn` still ranks, and the two rows move as claimed — Toxic against an Earthquake reply
**-43.9 -> -17.3**, Protect against an Earthquake reply **-43.9 -> +6.2** (the block is worth ~+81
there, against a protect-rhythm charge of ~-31: dim 127's weight is -26.4, one of the largest in the
vector, so a shield that blocks nothing — against their setup — is a net **-30.8**). The tiers write
the board the move produces; the weights then price it.

#### The paired 200-battle reading, on the instrument §P6 used

Same corpus (`corpus/elite.json`, band 1799-1992), same 200 battles, same sides, same 12,073 scored
decisions, two arms that differ ONLY in these two flags. The OFF arm reproduces §P6's published
baseline to the decimal (34.6 % top-1 all, 64.8 % move top-1, protect 35.9 %, status infliction
31.4 %), which is what makes the comparison usable.

**On the report's own headline:** top-1 agreement over all 12,073 decisions **34.6 % -> 35.4 %**,
top-2 **54.8 % -> 55.6 %**, move-vs-move **33.7 % -> 34.9 %**, contested 28.5 % -> 29.3 %. On the
score-gap table the human's click is within 5 % of our pick on **49.9 %** vs 49.1 % (5,811 vs 5,716),
30 %+ give-ups fall **35.3 % -> 34.2 %** (3,981 vs 4,114), and the per-bucket median regret falls in
every bucket (opening 0.01 -> 0.01, mid 0.04 -> 0.03, endgame 0.09 -> 0.08). Paired McNemar on the
move-only top-1 over 8,436 decisions: **90 fixed, 22 broken, chi2 = 40.08, p < 0.001.**

**The families, which is where the claim lives.** The two families the tiers write move a lot; every
family they do not write barely stirs — including the three §P6 already models, which are OFF in
BOTH arms here:

| family (human's click) | n | top-1 OFF -> ON | excess vs own floor | medGap OFF -> ON | gapPop OFF -> ON |
|---|---|---|---|---|---|
| **Protect** | 370 | 35.9 % -> **47.3 %** | **-16.9 -> -5.5** | **83.5 -> 65.0** | 143 -> 119 |
| **status infliction** | 366 | 31.4 % -> **41.8 %** | **-24.7 -> -14.3** | **60.9 -> 55.5** | 96 -> 106 |
| setup (tier OFF both arms) | 633 | 46.6 % -> 46.4 % | -17.1 -> -17.3 | 45.5 -> 44.3 | 176 -> 176 |
| hazard set (tier OFF) | 498 | 50.6 % -> 51.0 % | -16.6 -> -16.2 | 36.3 -> 38.5 | 83 -> 80 |
| hazard clear (tier OFF) | 204 | 41.2 % -> 41.2 % | -17.7 -> -17.7 | 67.1 -> 67.1 | 58 -> 56 |
| damaging | 4,124 | 80.6 % -> 80.5 % | +18.9 -> +18.8 | 7.5 -> 7.3 | 480 -> 482 |

The move half overall: top-1 **64.8 % -> 65.6 %**, gap population 1,551 -> 1,526, and the median gap
on the UNMODELLED slice **57.5 -> 53.1** (n 709 -> 684) while the modelled slice is flat
(16.1 -> 15.9). That is the §P6 signature again: a change that rewrites the rows it claims moves those
rows and leaves the rest where they were. Note what it does NOT do: neither family crosses its own
uniform floor (Protect -5.5, status -14.3 — against §P6's setup, which went -17.1 -> **+2.9**), which
is the honest reading of "the channel is now priced" being weaker than "the family is now ranked
correctly". Status infliction's gap POPULATION even rises (96 -> 106) while its median falls: rows
that were outside the gap population move INTO it, because the tier lifted the region the human was
clicking in rather than only rescoring the rows already in the slice.

#### What this pass did NOT establish

- **The measurement above is POLICY FIDELITY, not strength.** Agreement and win rate measurably
  disagree in this tree (§switch-tax: +12.3 points of agreement for -26.7 win points). Both tiers
  ship OFF and the win-rate gate is the next section.
- **Accuracy is not modelled, on purpose, and it cuts both ways.** A 90 % Thunder Wave and a 60 %
  Hypnosis both write a landed condition, because a board cannot carry a fraction of a status; a
  30 % paralysis rider (Body Slam) writes nothing, because a coin flip is not a condition. So a
  positive reading is a LOWER bound on what the channel is worth where the move is reliable and an
  upper bound where it is not, and neither tier can be read as calibrated.
- **Safety Goggles and Overcoat are not modelled** as powder shields (neither is inferable from a
  revealed board), and neither is the halving success rate of a repeat Protect (read as a failure,
  not as a probability).
- **One corpus, one band, one pairing.** Same corpus and battles as §P6, so the two passes are
  comparable — and comparably narrow.
- **The rated ROWS are still not the leaf.** With `laplace.nash` live, `laplace_core.js:3059`
  publishes `live[k].score = nash.rowValues[k]`, so the equilibrium perturbs rows neither tier
  touched; the control rows above (setup / hazard set / hazard clear) are the size of that coupling
  on this corpus, and they move by 0.0-0.4 points of top-1 and under 2 points of median gap.
- **Item A's gate, read at last, is a NULL on both instruments.** The tier §P6 shipped OFF without a
  win-rate reading now has one: personas 60 paired battles, seed 1337 — 83.3 % baseline against
  80.0 %, delta win **-3.3 [-11.7, +5.0]**, delta score **-2.5 [-10.0, +4.2]** (capped games 1/60 ->
  2/60); mirror 60 paired battles, same seed — 48.3 % against 46.7 %, delta win **-1.7 [-16.7,
  +11.7]**, delta score **-4.2 [-18.3, +9.2]** (capped 5/60 -> 2/60, mean turns 66.0 -> 62.4). Both
  point estimates are negative and both intervals straddle zero, so `pricemymoveeffects` stays OFF
  — now on a measurement rather than on the absence of one, and its `expect: 'helps'` is a
  pre-registration the run did not confirm. The fidelity gain it was written for is real and is
  quoted in §P6; it simply does not convert into wins at this sample, which is the same
  agreement-vs-strength split the switch tax showed from the other side.

#### C4's own gate: run at last, and it reads `[identical]` — because the instrument cannot carry the flag

3 batches × 60 paired mirror battles, seed 1337, 3,956 s. Both arms reproduced the baseline in
**every** battle — same winner AND same turn count — with Δwin **+0.0 [+0.0, +0.0]**, Δscore
**+0.0 [+0.0, +0.0]**, and the harness stamped both rows `[identical]`. The run's own footnote says
what to do with that and it is the right instruction: *"FLAT, NOT NEUTRAL — CHECK THE INPUT BEFORE
READING THIS AS A RESULT … the input the flag reads never arrived in these battles, or it arrived and
never changed a ranking."*

**Here it is the first case, and it is checkable rather than inferred.** `run_arena.js` hard-codes the
ENGINE seat's team (`resolveTeam(teamsMod, 'hazardStackBalance', null)`, the only slot with no CLI
option behind it), and `hazardStackBalance`'s 24 moves are Headlong Rush, Rapid Spin, Knock Off,
Stealth Rock ×2, Make It Rain, Shadow Ball, Nasty Plot, Recover, Swords Dance, Kowtow Cleave, Sucker
Punch, Iron Head, Fiery Dance, Sludge Wave, U-turn ×2, Earthquake, Ruination, Whirlwind, Iron
Defense, Body Press, Roost, Morning Sun. **No Protect-family move. No status-inflicting move.** Both
C4 tiers write OUR OWN move's leaf transition — our status condition onto THEIR body, our shield
across their reply — so with neither family on the board the switch has nothing to price and no
decision can move. Zero divergence in 60 battles is then the expected reading, not a finding.

Two consequences, and the second is the one that matters for a re-proposal:

- **This is not B8's null.** B8 had a real arena reading on a real matchup shape and it came back a
  null with negative point estimates. This one is a silence: re-running the identical command
  reproduces it, so *no sample size on this instrument can adopt these tiers*.
- **`--agent all` does not rescue it either.** The three personas are the OPPOSING seat; the engine
  still plays `hazardStackBalance`. The persona-side `stallCore` team is Protect on everything with
  Toxic and Leech Seed — the exact move families these tiers write — but it sits in the wrong seat.
  So the next run needs an engine-seat team that carries a shield and a primary status move, or a
  `run_arena` option that lets the ENGINE seat's team be chosen at all.

Until then the two flags stay `false`, on their fidelity reading alone (§P7 above) — and the honest
summary of this pass is that it bought an instrument diagnosis, not a verdict on the tiers.
