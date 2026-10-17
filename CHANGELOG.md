# Changelog

Newest first. The README is declarative (what is true now); this file and the commit log carry the
provenance — why a number is what it is, and what was tried and rejected. Entries before
"Unreleased" are the project's own history, condensed from the commit log.

This file is the dated NARRATIVE. The cross-cutting register — every attempt, its verdict (adopted,
rejected, inert, unresolved) and the artifact behind it, indexed by the shape of the idea so a
re-proposal can be matched to a prior attempt — is `ATTEMPTS.md`. Add a row there when a row here
reaches a verdict.

## Unreleased

### Fixed — the extension loads in Chrome again, and Firefox gets its own manifest

One manifest carried BOTH `background.service_worker` and `background.scripts`, on the theory that
Chrome would use the worker and ignore the script list. An MV3 manifest is not required to be
"loadable" by both browsers at once: Chrome's own error for a manifest it will not accept is the
generic *"Manifest file is missing or unreadable"*, so a dual-key manifest and a wrong folder are
indistinguishable to the person clicking **Load unpacked**. The scheme also cost a Chromium floor
(`minimum_chrome_version: 121`) it did not need.

The manifests are split. `manifest.json` is now strictly the Chrome one — `background.service_worker`,
no Gecko keys, no version floor — and `manifest.firefox.json` is strictly the Firefox one
(`background.scripts` as an event page, `browser_specific_settings.gecko.id` for signing, an MV3
floor of 109). `tools/build_extension.js` (and `npm run build:ext`) assembles either into
`dist/chrome` and `dist/firefox`, and REFUSES to build if a manifest declares the wrong background
mode, names a file that does not exist, or the two manifests disagree on anything except the
per-browser keys — the drift that would otherwise make the Firefox build a different extension with
the same version number. `--check` validates without writing.

The install is now tested as an install. `tests/extension_check.js` pins both manifests and all of
those refusals (24 checks), and `tests/e2e/00-package.spec.js` builds `dist/chrome` into a temp
folder and BOOTS Chromium from it — the service worker registers and the options page opens — which
is the one claim a manifest's shape cannot make. The README's Firefox paragraph no longer says the
manifest carries both keys; it says which folder to point each browser at.

### Added — the pooled AUC is cut into opening / crucible / cleanup, and the fit can be weighted

The single hold-out number hid where it came from. `tools/fit_weights.js` now reports the hold-out in
three slices — **early** (6v6, total HP > 1050 %), **crucible** (both sides >= 3 bodies, |alive delta|
<= 1, not early) and **late** (a material edge of 2+, or a side down to 2) — as a PARTITION, because the
natural definitions overlap. `tools/report_auc_slices.js` scores any stored 128-vector on the same
grouped hold-out and prints the pooled number beside all three. On this corpus (2,913 battles / 107,024
rows; 22,047 held-out rows over 704 whole battles) the shipped artifact reads **72.6 pooled, 57.3 early,
69.8 crucible, 86.4 late**: the pooled figure is mostly the cleanup, and the crucible is where the
headroom is.

Two findings follow from the slicing, and neither was visible pooled. **The deployed config vector is
1.9 points worse at the crucible than the artifact it came from** (67.9 vs 69.8) — that is the adoption
step, not the fit: `mapToSpec` folds the 36 threat cells into two scalars, and the threat matrix is
what tells two LEVEL boards apart. Not adopted (it changes every ranking and the win-rate gate is
unrun). And **`--crucible-weight`** — an opt-in per-row schedule (early x0.15, lopsided cleanup x0.08,
late x0.15, crucible x1, putting 90.4 % of the weight in 56.5 % of the rows, and reporting that share
rather than asserting it) — buys **+0.4 crucible / +0.3 pooled** (67.7 -> 68.1, 71.2 -> 71.6) but does
not close the gap to the artifact. A weighted fit is a different model, so it never lands in an
artifact by accident; all-ones weights are bit-identical to the old fit, pinned.

### Added — contrastive WITHIN-TURN preference learning, and why it is an instrument, not a replacement

New: `tools/extract_preference_data.js` turns a replay corpus into pairs
`d = x(s, a_human) - x(s, a_rejected)` — two hard negatives (the lines the current vector likes most)
plus one uniformly random negative per decision — and `tools/fit_preference_weights.js` fits `w` by
Bradley-Terry on those differences, reporting pairwise accuracy on held-out BATTLES, the same number
for the shipped vector on the same pairs, the unbiased random-negative reading, and a per-slice split.
`x` is read off the engine's own payoff leaf via `_payoff`'s `trace.leaf` (one added assignment), so
the training target is the board the deployed ranking actually scores.

**The result is that the objective matters more than the label does.** 2,913 elite battles -> 164,963
decisions / 489,805 pairs, every vector from the payoff leaf (0 fallbacks): on the unbiased
random-negative instrument (31,599 held-out pairs, 50 % = chance) the preference fit ranks the human's
click **70.9 % against the shipped vector's 64.1 % (+6.8 pp)** — but as a 128-dim STATE scorer it
scores **54.6 at the crucible against the artifact's 69.8**, because the dimensions that are constant
within a turn (both sides' HP, status, hazards, boosts) carry no gradient in a difference fit, and
those are exactly the level terms that rank boards. It is a better policy ranker and a worse evaluator;
not a drop-in replacement for `weights128`, and not adopted.

Two traps found and pinned. Reading `x` off `simulate(...).state` returns the SAME vector for every
action — its HP lives in `_sim`, which `extractVector` never reads — so the first version emitted 200
pairs of exact zeros and fitted to zero at chance; `tests/weights_check.js` §12 now pins real pairs,
non-zero differences and the payoff-leaf path. And **hard negatives generalise worse than random ones**
(63.8 % vs 70.9 % on the unbiased instrument): the hard set is selected by the vector under correction,
so the fit learns that vector's boundary instead of the human's direction — which is why the extractor
emits both kinds and the report prints both.

### Added — Future Sight, Doom Desire and Wish resolve a turn later (and are priced that way)

The leaf priced a delayed move as an immediate one. It is not: the sim parks a slot condition
(`|-start|<CASTER>|move: Future Sight`) and lands it at the residual of the NEXT turn, against
whoever STANDS in the slot by then, from the caster's own stats — and `Wish` heals that body for
half the caster's maximum HP. So a Future Sight click is now worth `setupDiscount` (0.55) of the hit
it will deal, not the whole thing; a second click into a slot that already has one pending is priced
as the failed action the game makes it; the landing is charged at its own residual (and bypasses a
Protect, as the sim does); and the Wish heal is credited to the body actually standing there. The
state manager owns the clock (`field.delayedMoves` / `field.wish`, landing turn and countdown,
cleared by the sim's own `|-end|` and `|[from] move: Wish` frames). Ships ON: this is a rules
correction, the same class as Sucker Punch's, not a preference. Human-match agreement is flat (37.2 %
-> 37.1 % with the tier off, inside the CI), which is what a rare move reads like on that instrument;
the mirror gate is unrun and the ablation row exists for it.

### Fixed — the weight fitter drops an exact linear duplicate, and the refit is one command

`macro[4]` (dim 116, the hazard differential) is an exact linear combination of the eight hazard
dims, so IRLS had to split one hazard effect between nine columns with arbitrary signs — the synthesis's
-484.8 / +342.8 pair. `tools/fit_weights.js` now DETECTS such a column from the data (an affine fit on
its source block, over rows where the value is not saturated at +/-1) and drops it before the split;
dropping it costs 0.0004 AUC, i.e. nothing, which is what removing a duplicate should cost. Detection
is data-driven rather than a hardcoded index list, and that mattered: dim 118 is NOT a duplicate (the
boost sum includes accuracy and evasion, which the vector does not carry). `tools/refit_weights.js` is
the missing single command — probe the corpus, extract with any `--set` flags the experiment needs, fit,
report, and refuse (exit 2, with the paths it probed) rather than fit over nothing.

**The shipped artifact is NOT replaced.** The refit was run and measured: on this checkout's corpus
(2,913 battles / 91,315 rows), battle-grouped hold-out AUC **0.7260 for the shipped vector vs 0.7033
for the fresh fit**, so adopting it would have been a 2.3-point regression. The artifact is stale in
provenance, not in quality — recorded in ATTEMPTS.md §P9, with the refit one command away. The threat
matrix's speed gate was re-measured on the same corpus (three splits, mean -0.15 pp, sign flipping) and
stays off: it is not measurable at this size in either direction.

### Added — the two halves of Choice lock, a team-preview synergy prior, and chip credit toward the OHKO

Four boards the leaf was pricing as if the opponent were a bag of independent damages.

**Choice lock, both directions.** An opponent holding a Choice item has ONE click, and the arena and
HUD both let their whole move list stand as a reply. In any sampled world where the active opponent
holds a Choice item and the stint already reveals a move, `getOppActions` now restricts that world's
columns to the revealed move plus switches — a lock proven by the board rather than assumed from the
item. On our side the risk is the mirror image: clicking a move while holding Choice commits us to it
against whatever comes in, so `_payoff` charges `laplace.choiceLockRisk` when a living bench body is
`0x` immune to that move's type (by type or a confirmed ability) — the switch that punishes the lock.

**Team preview.** `|poke|` already carries their six, and the set pruner ignored it. `set_pruner`
now applies a synergy prior (`config.pruner.synergy`) — Rain sets where a Drizzle body is revealed,
Sun where Drought is, Trick Room where `U.TR_SETTERS` plus slow breakers are — and once one opponent
reveals Stealth Rock, the other five slots' Rock-set weights are cut. A prior on candidates, never a
proof: the set it boosts still has to survive every hard deduction.

**The win condition is a threshold, not a KO.** `wincon_bounty` credited only `faintedIds`. A
roadblock chipped from 90 % to 40 % is worth nothing in that ledger and is exactly how a wall stops
answering our sweeper. The bounty now pays in proportion to how much of the gap to the sweeper's
OHKO break point the hit closed.

### Added — the ordering half of the KO cliff, under the flag that already owns the HP half

`laplace.rollKoBranch` priced the HP a fractional exact KO leaves but charged the reply in full, so a
hit that faints the target on 10 of 16 rolls read as if the target always answered. That needs move
order, which is why the first half refused to claim it. `_payoff` now asks `_turnOrder` — priority,
then Speed through Trick Room, the same check the setup extension and the pivot tier use — and when
the faster side's hit has a **fractional** exact chance `p` of fainting the slower one, the slower
side's damage is scaled by `(1 - p)`. A tie and the endpoints `p` 0 and 1 keep the symmetric pricing,
so no cell claims a turn the board cannot establish and every unambiguous cell is bit-identical. The
flag still ships `false` on an unrun gate.

### Fixed — a move that can FAIL is no longer priced as if it cannot: Sucker Punch, Fake Out, and the flinch

`_payoff` treated a move's damage as a property of the move. Three families of clicks do not work
that way, and the matrix was recommending lines the game answers with `|-fail|`:

- **Sucker Punch into a predicted switch.** The switch column resolved the incoming body (that part
  was right — `laplace.realOppSwitch`) and then CREDITED OUR HIT TO IT, although the move fails the
  moment the target does not select an attacking move. Same for their setup move, their status
  click and their Protect. It was also credited a second time by the `quiescence` follow-up when
  their reply was a setup move, so the failing line looked like the best attack on the board.
- **Fake Out after its first turn.** Fake Out / First Impression only work on the first turn the
  user can act after entering; every turn after that they fail. The engine kept pricing their damage
  on every turn of the stint, so a 40 BP priority move whose whole value is the flinch read as a
  free chip forever.
- **The flinch did not exist at all.** `flinch` appeared nowhere in `src/`. A landed Fake Out takes
  the target's whole click away (damage, setup boost, Turn-2 follow-up), which is the reason to
  click the move on its one legal turn — and that upside was priced at zero.

`laplace.conditionalMoves` (`src/config.js`) prices all three **from game rules only**, and applies
them to BOTH sides of the matrix — their Sucker Punch and their Fake Out are reply columns in the
same cell, so a switch or a setup click in front of a Kingambit is now priced as the free turn it is
instead of as a hit we eat. A flinch is blocked by a REVEALED Inner Focus / Shield Dust / Covert
Cloak and by nothing else: an unrevealed body is assumed flinchable rather than exempted on a guess.

Three separate leaves (`suckerPunchRequiresAttack`, `firstTurnOnly`, `flinch`), each the exact
identity when off; `tests/conditional_check.js` (65 checks, README) pins the classifiers, the two
independent readings of "first turn out" (the `|move|` stamp AND the turn window, so a body flinched
through its whole stint does not read as first-turn-out forever), the failing and passing cells in
both directions, the flinch blockers, and the exact pre-tier number each knob restores. Ablation
rows `conditionalmoves` and its three sub-knobs are registered in `tools/run_ablation.js`.

**Ships ON, and that is a judgement rather than a measurement.** The other leaf transitions on this
branch shipped OFF until a win-rate gate adopted them; this one ships ON because it is not a policy
preference — the shipped build was crediting damage that cannot happen, which is the class of defect
`tests/blackbox_guard.js` exists to forbid. **Its win-rate gate has NOT been run**, and neither have
the three sub-knobs'; they are in the table for exactly that reason. Not modelled, stated rather than
discovered later: Upper Hand (it fails unless the target clicks a PRIORITY move, a narrower
condition than "an attack", so it is deliberately not in the Sucker Punch family), move ORDER
(Sucker Punch's +1 bracket still does not decide who swings first in the cell — only the failure
condition is priced), Substitute, and the 30 %-flinch riders (a roll is not a rule).

### Added — the KO cliff: the mean of sixteen rolls stops standing in for all sixteen (ships OFF)

`_payoff` moved the target by `avgPercent` — the MEAN of the 16 damage rolls — and clamped at 0, so a
move whose mean landed 1 % past the target was priced as a **certain OHKO the target never answered
from**, while a mean 3 % short left it alive with its reply landing in full. Those are one
distribution, not two: 10 of 16 rolls may reach the target in the first case and 6 of 16 in the
second, and the difference between the two cells was the shape of a mean rather than anything about
the game.

`laplace.rollKoBranch` (`src/config.js`, `enabled: false`) replaces the transition with the
expectation over the two outcomes, `(1 - p) x survives`, where `p` is the exact share of rolls that
reach the current HP (`koChanceExact`, which `calc_engine` already computed and `_payoff` threw
away). The surviving branch is floored so a 15-of-16 roll is not read as a KO, and a roll set that
cannot answer exactly keeps the scalar path — so the two arms are bit-identical on every cell that
was never ambiguous, which is what `tests/quiescence_check.js` §8 checks as identities rather than
as magic constants (monotonicity in `p`, both endpoints, the null-chance refusal, and the shipped
shape of the damage result).

**WHAT IT IS NOT, and this bounds any reading of it.** The formula it implements is deliberately
not the textbook `p x V_KO + (1 - p) x V_survive`. That form needs its KO branch to mean "the target
never answers", which needs to know we move FIRST — and `_payoff` does not model move order at all
(only `_pivotPayoff` does, and the in-code comment on the symmetric reply treatment says so).
Putting a zero-counterattack branch there would smuggle a speed assumption into the cell every row
flows through, so the reply stays symmetric and only the HP half of the cliff is removed. A positive
reading is therefore a LOWER bound on this correction, and the ordering half would need its own
tier.

Its gate is UNRUN, so the flag ships `false`. Registered in `ATTEMPTS.md` §C5, with the ablation row
`rollkobranch` and its input channel classified in `tools/harness_inputs.js`.

### Measured — the two leaf channels' gate reads `[identical]`, and the ARENA cannot carry the flag

`pricemymovestatus` and `pricemymoveprotect` shipped OFF with a fidelity reading and no win-rate
reading. That gate has now been run — 3 batches × 60 paired mirror battles, seed 1337, 3,956 s — and
both arms reproduced the baseline in **every** battle: same winner AND same turn count, Δwin
**+0.0 [+0.0, +0.0]**, Δscore **+0.0 [+0.0, +0.0]**, both stamped `[identical]`.

A flat row is not a null, and the run's own footnote says so (`FLAT, NOT NEUTRAL — CHECK THE INPUT`).
Here the input is checkable and the answer is not about the tiers: **the instrument cannot carry the
flag.** `run_arena.js` hard-codes the ENGINE seat's team to `hazardStackBalance` — the one slot with
no CLI option behind it — and that team's 24 moves contain **no Protect-family move and no
status-inflicting move**. Its status-class moves are hazards, setup, recovery and Rapid Spin, which
belong to `priceMyMoveEffects`, not to these two tiers. Both tiers write OUR OWN move's leaf
transition, so with neither family on the board the switch has nothing to price and no decision can
move; zero divergence across 60 battles is then the expected reading.

So both flags stay `false` and the reason is structural: **the gate is unrun in effect, not read as a
null.** Re-running the identical command reproduces the same silence, so no sample size on this
instrument can adopt these tiers — unlike `priceMyMoveEffects`, whose gate was a real reading on a
real matchup shape that merely failed to clear zero. `--agent all` does not rescue it either: the
personas occupy the OPPOSING seat, so the engine still plays `hazardStackBalance`, while the
persona-side `stallCore` — Protect on everything, with Toxic and Leech Seed — is the team that would
fire these tiers, in the wrong seat. The next run needs an engine-seat team carrying a shield and a
primary status move, or a `run_arena` option to choose the engine's team at all. `ATTEMPTS.md` §C4
and §P7 carry the row; the fidelity reading below is untouched and remains the only reading these two
tiers have.

### Measured — the set-up/hazard leaf tier's win-rate gate, run at last: a NULL on both instruments

The tier `laplace.priceMyMoveEffects` shipped OFF with a strong policy-fidelity reading and no
win-rate reading at all — its `expect: helps` was a pre-registration, not a result, and §P6 said so.
That gate has now been run, at 60 paired battles per instrument on seed 1337, and both instruments
say the same thing:

| instrument | baseline | gate ON | delta win | delta score | capped games |
|---|---|---|---|---|---|
| personas (5 seats) | 83.3 % (50-9-1) | 80.0 % (48-10-2) | **−3.3 [−11.7, +5.0]** | −2.5 [−10.0, +4.2] | 1/60 → 2/60 |
| mirror of itself | 48.3 % (29-26-5) | 46.7 % (28-30-2) | **−1.7 [−16.7, +11.7]** | −4.2 [−18.3, +9.2] | 5/60 → 2/60 |

Both point estimates are negative and both intervals straddle zero, so the tool's own verdict is
`no measurable effect at this sample size` — not a defined loss. The flag therefore stays `false`, now
on a measurement rather than on the absence of one. The difference between this row and the fidelity
reading it was written from is worth stating plainly: **the tier's own corpus reading is decisive**
(top-1 34.6 % → 36.9 %, median regret share on MOVE clicks 0.008 → 0.001, 30 %+ give-ups 35.3 % →
33.6 %, McNemar 240 fixed / 136 broken, chi2 28.2, p < 0.001) **and it does not convert into wins at
this sample.** That is the same agreement-vs-strength split the pivot tax showed from the other side
(+12.3 points of agreement for −26.7 win points), now seen on a change that is a correction rather
than a tax. `ATTEMPTS.md` §B8 carries the row and §G the shape; a re-proposal needs a stronger
instrument — or 500 battles — not another 60-battle run.

### Added — the other two leaf channels: our own status moves and our own Protect (both ship OFF)

§P6 wrote our own setup moves and hazards onto the leaf and named what was still unwritten, in order
of contribution to the summed move-half gap: Protect **20.4 %**, other status 15.5 %, recovery 14.4 %,
setup 13.7 % (written), status infliction 10.0 %. Two of those were fixable the same way, and
`laplace.priceMyMoveStatus` and `laplace.priceMyMoveProtect` (src/config.js, both `enabled: false`)
are those two. They are separate switches rather than sub-knobs of `priceMyMoveEffects` because that
row is a published measurement of one scope, and the ablation table's own no-op guard requires every
row to be a single real flip.

- **Status infliction** writes our status move's condition onto THEIR leaf body — the PRIMARY effect
  of the move (`U.STATUS_MOVES`: Thunder Wave, Will-O-Wisp, Toxic, Spore, Glare, Stun Spore, Nuzzle,
  Zap Cannon, Inferno, …) — and refuses wherever the board says it cannot land: the body is already
  statused, the move cannot connect (the type chart or `U.immunityReason`), the status is impossible
  for the TYPE (`U.STATUS_TYPE_IMMUNITY`: Electric bodies cannot be paralysed, Fire bodies cannot
  burn), the move is a powder into a Grass body, or a REVEALED ability is on the immunity list. A
  body that only MIGHT carry the immunity is not enough to suppress the row.
- **Our own Protect** is priced as the shield it is: their reply deals nothing inside the cell, and
  the leaf carries the Protect rhythm the live state would carry next turn. Two rules keep it from
  being a free pass — a CONSECUTIVE Protect FAILS (veto 9's rule, exempted the same way when a Taunt
  or an Encore means the last one never went off) and the Feint-style piercers are not blocked — and
  a shield does NOT stop their SETUP.

On the live path the rows move as claimed: Toxic against an Earthquake reply **−43.9 → −17.3**,
Protect against the same reply **−43.9 → +6.2** (the block is worth ~+81 there, against a
protect-rhythm charge of ~−31: dim 127 carries a weight of −26.4, so a shield that blocks nothing,
against their setup turn, is a net −30.8).

**The paired 200-battle reading, on §P6's instrument** (same corpus, band, battles, seeds; the OFF arm
reproduces §P6's baseline to the decimal): top-1 agreement over all 12,073 decisions **34.6 % →
35.4 %**, top-2 54.8 % → 55.6 %, move-vs-move 33.7 % → 34.9 %, contested 28.5 % → 29.3 %; on the
score-gap table the human's click is within 5 % of our pick on **49.9 % vs 49.1 %** (5,811 vs 5,716)
and 30 %+ give-ups fall **35.3 % → 34.2 %** (3,981 vs 4,114), with the median regret falling in every
turn bucket. Paired McNemar on the move-only top-1 over 8,436 decisions: **90 fixed / 22 broken,
chi2 40.08, p < 0.001.** The families are the claim: Protect **35.9 % → 47.3 %** (median gap 83.5 →
65.0, gap population 143 → 119) and status infliction **31.4 % → 41.8 %** (60.9 → 55.5), while every
family they do not write barely stirs — including the three §P6 models, which are OFF in both arms.

What the pass does NOT claim: neither family crosses its own uniform floor yet (Protect −5.5 pp,
status −14.3 pp, against §P6's setup, which went −17.1 → **+2.9**), status infliction's gap POPULATION
rises (96 → 106: rows move INTO the slice as the region the human was clicking in is lifted), and
**the win-rate gate came back `[identical]` — see the top of this file: the arena's engine seat
plays a team with no shield and no status move, so the gate could not be run in effect**. That is an
instrument gap rather than a null, and it is named instead of re-run. Both ship `false`;
registered at `ATTEMPTS.md` §C4, with §P7 for the measurement and §B8 for the sibling tier's
now-measured null. `tests/tuning_check.js` §4e pins the row-local contract: each refusal, the
consecutive-Protect failure, the Taunt exemption, Feint, and the two tiers' independence.

### Rejected — the threat matrix's speed gate: softened, refitted, measured, and left OFF

`_threatMatrix` builds dims 76..111 as `clamp(faster * (0.4 + 0.6 * threat))` with
`faster = mySpeed >= oppSpeed ? 1 : 0`, so all 36 cells are exactly 0 the moment we are not strictly
faster — at a tie as well as a hundred points behind. That is a gate, not a bias, and the fitted
coefficients were fitted on the gated column, which is why softening it is a **refit and not an
edit**. `evaluator.threatSpeedGate` (src/config.js, `enabled: false`) replaces the cliff with a linear
decay from 1 at parity to `floor` at a `span`-point deficit, anchored to `evaluator.speedEdgeSpan` — a
strict generalisation of the shipped gate at `floor: 0`, bit-identical for every faster body.

**The scope, measured before any fit:** re-extracting 40 replays (1,426 rows) with the gate off and on
moves 1,394 rows, and the dims that move are **76..111 only** — all 36, nothing else — with a max
|Δ| of 0.99 and a mean of 0.366 across the changed cells. (Measuring that turned up a real defect on
the way: `_speedOf`'s memo key did not carry the SIDE, so a board whose two bodies share the key read
the second body's speed from the first. The key now carries `mon.side`; no live battle was affected —
live slots are side-qualified — but a mirror or a hand-built fixture was silently inverting the speed
term.)

**The refit is a loss out of sample.** The same corpus extracted twice (3,521 replays / 107,024 rows)
and fitted twice with the artifact's own settings: the fitter's own AUCs are 0.7507 → 0.7496
(train) and **0.7105 → 0.7023** (battle-level hold-out), and scoring the **exported** (clamped)
vectors on the SHARED grouped hold-out (22,047 rows over 704 battles) with a 2,000-resample
battle-level paired bootstrap gives **0.7105 → 0.6971, Δ −0.0134 [−0.0262, −0.0012]**, with **1.3 %**
of resamples positive. Sign accuracy at 0.5 on those rows: 65.52 % → 64.69 %.

**The gate WITHOUT the refit is a null on the decision instrument** — 200 paired battles, top-1
**34.6 % → 35.0 %** (±0.9), top-2 54.8 % → 54.9 %, contested 28.5 % → 28.8 %, move-vs-move 33.7 % →
34.1 %, revealed moveset 29.1 % → 29.4 %, vetoed 3.6 % → 3.6 %; move-half top-1 64.8 % → 64.9 %,
McNemar **25 fixed / 19 broken, chi2 0.57, p ≥ 0.1**, and the move-half median gap moves the WRONG way
(34.9 → 36.2; unmodelled slice 57.5 → 58.3). So the term does not close the fidelity gap it was
proposed against either.

Two instruments, one verdict: a wash at the decision level, and a loss on the model a refit must
improve. It ships `false` and the refit is recorded rather than adopted. What it does buy is real but
is not enough: the collinear split §P5 measured shrinks (`macro[4]`, the net hazard differential,
**−3.33 → −2.95** against the shipped **−9.29**) — readable weights are the precondition for reading
a coefficient, not a reason to accept a worse model. **And the same pass found the shipped artifact
stale:** `lib/trained-weights.json` reports 111,820 samples over 3,712 battles while this checkout's
corpus yields 107,024 over 3,521, with 106,956 rows differing from the shipped
`corpus/training_data.json`; the fresh OFF fit scores **0.7105** with **2** clamped low-support dims
against the artifact's 0.7011 with 8. Replacing the vector on that evidence is a separate decision
with its own gate, deliberately not taken here. `ATTEMPTS.md` §B9; `tests/tuning_check.js` §11 pins
the flag's contract, including the parity-is-bit-identical case.

### Added — `--set` on the training extractor: two arms of one corpus, one config leaf apart

A refit for a config leaf needs the corpus extracted twice, and the difference between the two
datasets has to be the leaf and nothing else — a hand-edited copy of `src/config.js` cannot evidence
that, because the copy IS the diff. `tools/extract_training_data.js` therefore takes
`--set <path>=<value>` (repeatable), applies it inside the harness's load window so the modules that
read config while they load see it, and **reads every patch back**, so an arm that silently failed to
patch cannot be compared as if it had. An unknown path is an error rather than a new key; the patch
carries the whole top-level section, because `configMerge` assigns at each level rather than
deep-merging and a leaf-only patch would reset the rest of its section to the defaults; and only the
scalars config.js actually stores are inferred from text. `tests/weights_check.js` §5c pins all of
that plus the arm itself (the two extractions part company on dims 76..111 and on nothing else — the
suite is now at 277 checks, 0 failed). The §P8 arms above are reproducible from it:

```
node tools/extract_training_data.js --input corpus/replays.json \
  --set evaluator.threatSpeedGate.enabled=true --out gate_on.json
```

and a 200-replay subset re-extracted this way comes out row-for-row and provenance-for-provenance
identical to the 94 MB arm the refit above was fitted on.

### Added — the own-move leaf effects (`laplace.priceMyMoveEffects`, ships OFF), and the two readings behind it

`_payoff` prices our own pivots and recovery moves, and it left every OTHER non-damaging move of ours
without writing its board change to the leaf `sim`. The 128D evaluator has fitted weights for hazards
(dims 48..55), status (24..35) and boosts (36..47), and on a Stealth Rock, a Swords Dance, a Defog or a
Toxic row it was reading the PRE-move board — identical across every candidate move. The question was
not answered wrongly; it was never asked. `_myMoveLeafEffects` (src/laplace_core.js) now stamps our own
setup moves' stat stages and HP price (Belly Drum 50, Clangorous Soul 33, refused below cost), the
hazard setters' layer up to its cap, and the removers' clear (Rapid Spin / Mortal Spin / Tidy Up on our
side, Defog both sides, Court Change swapped) onto a SHALLOW COPY of the leaf field, and feeds our
boosted Defence / Special Defence into that turn's reply through `_setupFollowUp`. The live board is
never written through. `enabled: false` is bit-identical to the previous pricing.

**The slice that justified it, on records that already existed.** Of the 1,550 gap decisions in the
200-battle move half (a menu of >= 3 same-kind lines where the human's click is in our top-3 but not
first), 707 are families whose board change the leaf never carried, and their median gap is **7.7x a
pure attack's** (57.5 vs 7.5). The engine beats its own uniform floor on exactly two families — raw
damage (+18.9 pp) and Knock Off's damage (+11.3 pp) — and lands 16-25 points BELOW it on every family
the leaf cannot see. Protect (medGap 83.5), hazard clear (67.1) and status infliction (60.9) are the
extremes; status infliction is the worst family in the whole slice at **-24.7 pp against its own floor**.

**What the tier measured**, paired on the same corpus / battles / seeds (the OFF arm reproduces the
baseline to the decimal): all 12,073 decisions top-1 **34.6 % -> 36.9 %**, top-2 54.8 % -> 57.0 %,
move-vs-move 33.7 % -> 35.2 %, contested 28.5 % -> 29.5 %; on the score-gap table the human's click is
within 5 % of our pick on **51.4 %** vs 49.1 % (5,980 vs 5,716) and 30 %+ give-ups fall 35.3 % -> 33.6 %;
median regret share on MOVE clicks 0.008 -> **0.001** with the switch half unchanged (0.267 -> 0.272).
Paired McNemar on the move-only top-1 over 8,436 decisions: 240 fixed, 136 broken, chi2 28.2, p < 0.001.
Per family, top-1 rises 20.1 pp (setup 46.6 -> 66.7 %), 13.3 pp (hazard set 50.6 -> 63.9 %), 20.1 pp
(hazard clear 41.2 -> 61.3 %) and their excess over the uniform floor flips sign. The families it does
NOT model barely move: **status infliction is identical on every statistic** (31.4 % top-1, median gap
60.9, gap population 96, excess -24.7 pp on both arms), and **Protect is identical on median gap (83.5)
and population (143)** while its top-1 moves one decision in 370 (35.9 -> 35.7 %, excess -16.9 -> -17.1)
— an untouched row losing first place to a setup row that now outranks it. The modelled families move
13-20 pp; an untouched one moves 0.2 pp. That is the signature of a leaf-transition change rather than
an evaluator change.

The move-half median gap falls **35.2 -> 31.0 (-12 %)**, not toward zero, and the arithmetic says why:
the tier covers 317 of 1,550 gap decisions (20.5 %). Protect (20.4 % of the summed gap), other status
(15.5 %), recovery (14.4 %) and status infliction (10.0 %) are still unwritten, so a fix over a fifth
of the gap cannot move a median of the whole. It SHIPS OFF on a win-rate gate pending an arena reading;
`expect: 'helps'` on its `run_ablation` row is still a prior.

**One trap this run found, and one retraction.** (1) The rated ROWS are not the leaf: with
`laplace.nash` live, `laplace_core.js:3059` publishes `live[k].score = nash.rowValues[k]`, so the tier
perturbs rows it never touched through the equilibrium — 91.0 % of unmodelled move rows and 87.4 % of
switch rows came back exactly unchanged and the rest moved by a median of 0.00 (p95 0.35 / 3.86). The
row-local contract is pinned on `_payoff` in `tests/tuning_check.js` §4d (attack, status, Protect,
pivot and switch each bit-identical with the tier on). (2) The caveat this tier first shipped with —
"setting hazards has net negative weight under the current fit" — is **FALSE and is retracted**. The
shipped `evaluator.weights` pair base dims with `macro` dims that are EXACT linear combinations of them
(`v[116]` of 48..55 through `_hazardDifferential`; `v[118] = (1/3)·(v36+…+v41)` through `_boostSum/18`),
so ridge (`lambda` 0.5 on standardized columns) split one coefficient into two: `macro[4] = -9.287`
against base hazard dims of +3.36..+6.57, `macro[6] = +18.372` against base boost dims of -4.84..-5.62
(±484.8 and +959.0 at `fitScale` 52.2). Neither half can be read alone, so the NET weight of one fact was
measured instead: every SIGN is right (their hazards help us, ours hurt us, our boosts help us and
theirs hurt us — Stealth Rock on their side +13.6, our rocks -22.0, our +1 Atk +11.2 raw) and the
MAGNITUDES are not (single-layer hazards priced +13.6 / +7.0 / +4.5 / +62.4, a 14x spread between Toxic
Spikes and Sticky Web decided by how much of each base weight the residual cancels). `ATTEMPTS.md` §P5
and §P6.

### Changed — the human-match report leads with the score gap, and its consensus floors were wrong

A metric pass (2026-10-16) over `tools/benchmark_human_match.js`. **No engine file changed** — this is
the instrument that says how good the shipped policy is, and it now carries the score-gap machinery
(`regretShare` / `regretStats`, and the "WHAT THE HUMAN GAVE UP" table), the consensus pass, and a
test on the turn buckets; using it immediately found two defects in its own arithmetic. Every number
below is one run: 399 battles, gen9nationaldex at rating 1857–1992 (mean 1883), 25,284 scored
decisions (`humanmatch-elite399.txt` / `.json`; `ATTEMPTS.md` §O).

**The headline is now the gap, not the agreement.** Top-1 agreement counts the row the ranking put
first, so a tie the engine had to order counts as a miss. The report opens with the human's own click
scored by the engine's own evaluator — `(topScore - humanScore) / spread` — and prints agreement beside
it: on this corpus the human's line was **within 5 % of our pick on 48.2 %** of the 24,426 decisions
where a spread existed (11,764) and gave up **30 %+ of the menu spread on 36.5 %** (8,925), while
top-1 agreement over the same decisions is **34.7 %**. Both bands are given in both normalisations
(5 %-of-spread 48.2 % vs 5 %-of-pick 48.3 %; 30 %-of-spread 36.5 % vs 30 %-of-pick 36.9 %), because a
table that frames one band as a share of the spread and the other as a share of the pick cannot be
compared with itself. Nearly half of what agreement calls a miss cost nothing; the report now says so
before it says the other thing.

**The turn buckets carry a two-sample test instead of a shape.** A flat agreement rate across
opening / mid / endgame is equally consistent with uniformly decent and uniformly mediocre, so
`extremeSpread` compares the best and worst bucket at twice the standard error of the difference and
the report states the verdict with the levels beside it. On this corpus the buckets are **NOT flat**
(agreement z = 5.51, wash share z = 10.56): 38.2 % / 35.7 % / 33.3 % top-1 and 54.6 % / 51.7 % / 44.8 %
wash from opening to endgame, with the median regret rising 0.8 → 18.8 raw units. The engine is
decent early and weaker late, and the gap reading says it twice as loudly as agreement does.

**The consensus pass was re-pointed and its arithmetic corrected.** Buckets now key on the active
MATCHUP (`matchupKeyOf`; HP and field excluded), and the old fine key is reported as the diagnostic
that justifies the coarse one: 1,352 of 6,220 matchup buckets qualify at n ≥ 5 (61 % of decisions)
against **434 of 16,582** fine buckets (2.6 %). Two defects were found by using the numbers: **377** of
the qualifying buckets are DEGENERATE (elites clicked three distinct lines or fewer, so the human
top-3 is every line clicked and the test is true by construction), and the floor printed against the
rate modelled a random draw among the lines *elites clicked* rather than a random engine drawing from
its own menu. Over the 975 informative buckets (12,988 decisions) the engine's modal pick is in the
elite top-3 **62.7 %** (611/975) against a faithful baseline of **at most 51.3 %** (3/offered, a loose
upper bound) and 56.1 % for the human-set draw; the pooled figure that would have been quoted reads
63.7 % against 75.1 % and is not. Each bucket also carries the gap of the modal line: the line elites
clicked most was a wash **56.4 %** of the time on average, 45.3 % pooled over qualifying clicks.

**Two more readings moved up into the prose they belong in.** The SWITCH half is 18.4 % top-1 against
a **complete-menu** floor of 17.2 % — on the half where the menu is not starved, the ranking is barely
above chance — while the MOVE half is 40.9 % against 18.2 % and carries the starved-menu caveat; the
aggregate 34.7 % is the average of those two. And the pivot ceiling is unchanged and re-quoted: never
pivoting while holding an attack would score 45.1 % overall against the shipped 34.7 %.

Pinned by `tests/human_match_check.js` (140 → 209 checks): the gap statistics and both bands in both
framings, the
degenerate-bucket rule and both floors, the phase test at three powers (identical buckets, a 20-point
gap at n = 100, the same gap on two decisions), the summary/table agreement, and the render's own
headline. Docs: `ARCHITECTURE.md` §7.2, `README.md`'s tool list, `ATTEMPTS.md` §O.

### Changed — the opponent model stops being one-way, and the first one is adopted on two seeds

A follow-up pass (2026-10-15) on the three findings `ATTEMPTS.md` §M left open. **This one DOES move
the shipped ranking**: `laplace.nash.priorAnchored.enabled` is now `true`.

**The solve was one-way, and that was the ceiling §L2 named.** In `solveNashFictitiousPlay`, the
opponent's soft/anchored column mix was accumulated into their PUBLISHED strategy while the action
each side best-responded to stayed the hard argmax index, and our own cumulative payoff read that
index. So `qre`, `priorAnchored` and `surpriseMask` could re-price `rowValues` and could not touch our
own frequency counts on any MATRIX — which is why §M3 measured `nash-prior` as `identical` over 60
paired battles. Our step now accumulates the MIXTURE's expectation (`sum_j oppMix[j] * payoff[i][j]`)
whenever a mixture exists, and the historical line character for character when none does, so the
pre-adoption path is untouched: `tests/tuning_check.js` §7b pins that `tau 0`, no prior and blend 0
each reproduce the bare solve exactly on three matrices, and that each of the three tilted arguments
now moves our own strategy on all three.

**`laplace.nash.exploitBlend` (ships `0.0`)** is the exploitation half of the same insight: the
published mix was the *unexploitable* one, which leaves value on the table against an opponent the
same solve has just priced as not playing it. Confidence is now
`(1 - b) * equilibriumFrequency + b * softmax(rowValues)`; at `0` the blend is skipped entirely (no
copy, no rescale), at `1` it is the softmax at `laplace.temperature`, and in between it is the exact
convex combination. `nashFrequency` still publishes the EQUILIBRIUM frequency beside it. Not adopted:
its own mirror reading is flat (Δwin +0.0, Δturns −1.1), which is what a blend with nothing to
exploit should cost. Pinned in `tests/tuning_check.js` §10, priced by the row `nash-exploitblend`.

**`laplace.endgame.promoteMate` (ON) makes the endgame tier rankable.** §M1's finding was that the
solver's report went to `lastReadout.endgame` and NOTHING in the ranking path read it, so enabling the
tier could not change a decision at +31 % wall clock. A report that says `solved && isMate` — a proof,
which the search refuses through a Speed chance node and which `solveAcrossWorlds` requires from every
surviving world with the same root — now splices that root to the top of `ranked` at confidence 100
with every other line at 0, stamped `mateProven`/`mateIn`/`mateReason`. It is SKIPPED, never
approximated, when the report is not a mate or the root is not one of our non-vetoed lines. Inert in
the shipped build (the tier itself still ships off); pinned in `tests/endgame_check.js` §7 and paired
against the new `endgame-promote` control row, which runs the same tier with the promotion off.

**The sweep (mirror, 60 paired battles per row, seed 1337, 0 errors).** Baseline 41.7 % (25-34-1).
`nash-prior` on: **63.3 % (38-17-5), Δwin +21.7 [+5.0, +36.7], Δscore +25.0 [+8.3, +40.0]** →
**ADOPTED**. `surprise-mask` on: 38.3 % (23-37-0), Δwin −3.3 [−15.0, +8.3], ZERO cap ties (the §M2
`stall` cluster does not reproduce once the mask can reach a ranking). `nash-exploitblend`,
`endgame-3v3` and the new `endgame-promote` control: Δwin +0.0, with `endgame-promote` reproducing the
baseline in EVERY battle and `endgame-3v3` moving one battle by one turn — the null instrument
becoming a live one, measured. `nash-qre` is still `identical` because the mirror declares no rating
for the persona seat and an unknown opponent resolves to the hard response (pinned engaged on a rated
board in §7b). `ATTEMPTS.md` §N carries the tables and the "not established" list.

**The adoption, and its price.** Seed 1337 Δwin +21.7 [+5.0, +36.7]; seed 20261016, baseline 43.3 %
against 68.3 % (41-15-4), Δwin +25.0 [+8.3, +41.7], Δscore +23.3 [+8.3, +38.3], turns −9.6 and cap
ties 7/60 → 5/60. Both scales exclude zero on both seeds with no stall flag, which is the two-seed bar
§L3 set for a mirror row. Not established: the opponent in that instrument is a frozen copy of this
engine, so it is a SELF-PLAY result and not a measured ladder gain, and `priorWeight` 0.25 is the
untuned midpoint rather than a fitted value. Four suite pins moved with it — §9's flag pin, §9b's
"off == the shipped build" identity pin (now retired: the shipped build IS the anchored solve), the
lure fixture's 47.6 % → 46.4 %, and §5/§7's fixtures now pin `priorAnchored` off so those sections keep
measuring THEIR tier — and §5d gained an explicit pin for the interaction it used to attribute to the
beam.

**`tools/run_ablation.js --baseline <file>`** resumes a sweep that died half-way: it reuses a finished
arena report as the reference arm, refusing any report that is not the same experiment or that was
itself run with `--set`. Pinned in `tests/ablation_check.js` §4b.

### Added — the endgame hardening pass, two opponent-model tiers, and the dims that were not zero

A five-phase pass (2026-10-15). **Nothing here moves the shipped ranking**: every new tier ships
`enabled: false`, the two reclaimed evaluator dims carry shipped coefficients of `0`, and the
endgame solver's own tier stays off.

**Phase 1 — `src/endgame_solver.js`.** Five structural flaws, one `laplace.endgame.*` leaf each, and
all five defaulting ON because they are corrections rather than preferences. (1) `simultaneousPly`:
the turn was priced as `max_i min_j` — a valid floor, but the price of a Stackelberg game where the
opponent reads our hidden turn-t action and answers it. A turn of Pokemon is simultaneous, so unless
one side owns a strictly dominant pure action the turn is now solved as a small zero-sum matrix by
regret matching, and the value is the game value (never below the maximin floor). (2)
`includeRecoveryAndProtect`: `_movesOf` returned damaging moves only, so `Recover`/`Roost`/`Slack
Off`/`Soft-Boiled` read as "does nothing" — the most dangerous way to be wrong about an endgame — and
`Protect` read as a free turn. Both are actions now; a heal restores 50 % clamped at 100 and only
while its body still stands when its action resolves, and a shield blocks the incoming hit for the
turn and is only OFFERED while that side's protect chain is broken, because the second one in a row
fails in the real game. (3) `modelPhysics`: `_replaceFainted` did not charge entry hazards (a
replacement arrived at the HP it already had), `_afterTurn` never ticked `trickRoomTurnsLeft`, and
end-of-turn burn/poison chip and Leftovers recovery did not exist. All three do now — the hazard
charge is `U.hazardPercent`'s own number and nothing is re-derived. (4) `transposition`: a
per-`solve()` memo keyed on the board with HP bucketed into `ceil(hp / 5)` (0 preserved exactly) plus
active slots, boosts, protect streaks, the Trick Room timer and the (depth, ply) pair; only
FULL-window values are stored, because a fail-high is a bound and caching one under an exact key
corrupts a sibling branch. (5) `solveAcrossWorlds(state, worlds)`: a forced win is reported only when
every non-refusing world proves one with the same root action, and otherwise the report carries the
root with the best worst-case score across worlds; `LaplaceEngine` calls it in place of the
single-world entry point. **A real defect was found by writing the tests, not by reading the code**:
`_endOfTurn`'s chip helper was handed the side OBJECT and returned it as its `side` key, so
`next[c.side]` was `undefined` — every end-of-turn chip was silently a no-op until one actually fired
and the step threw. `tests/endgame_check.js` §7c caught it on the first run.

**Phase 2 — `laplace.surpriseMask`** (Phase 2 of the pass, `src/laplace_core.js`). The simultaneous
matrix is built over the opponent's FULL reply list, so the equilibrium already knows about our
unrevealed coverage move and avoids the column it punishes — telepathically, because on the ladder
they have not seen us click it. With the tier on, the OPPONENT's half of the solve reads a copy of
the matrix in which a row for an unrevealed non-STAB move of ours is blended toward our best
revealed-or-STAB row at `unrevealedWeight`, and only THEIR cumulative payoff is accumulated from that
copy; our own step still reads the true matrix, `rowValues` is still the true matrix against the mix
they produce, and our own frequencies still best-respond to the real game. Pinned in
`tests/tuning_check.js` §8, including a board where an unrevealed 4x Ice lure makes their pivot
frequency rise and the lure's true value rise with it.

**Phase 3 — `laplace.nash.priorAnchored`** (same pass). ATTEMPTS.md E5 priced turning the hard solve
OFF at +8.3 %, which read as the equilibrium over-defending against bluffs nobody makes: fictitious
play gives every one of their actions the same ZERO credibility at round 0. The tier blends the
opponent's response with a behavioral prior, `(1 - c) * regretMatch + c * P_prior`, `c =
priorWeight`. Two things the implementation had to get right and the brief's formula, written
naively, does not: regret has to be measured against the value of the mixture they are CURRENTLY
playing — against `max_j Q_j` no action can ever have positive regret, which collapses the formula to
the argmax and leaves the prior as the only thing doing any work (**the first draft had exactly that
bug and the probe caught it: `priorWeight` 0.25 and 1.0 produced bit-identical mixes**) — and every
prior weight has to be read through a numeric fallback, or one malformed leaf turns a reply into
`NaN`. Pinned in `tests/tuning_check.js` §9.

**Phase 4 — the six structurally-zero dims.** `tools/extract_training_data.js` never constructed
`ST.ArchetypePruner`, and `cannotBeChoice`, `itemless` and `liveSet` are written by that one module
and read by dims 64..75: dims 66/67/72/73 were constant 0 in every corpus row, so the zero
coefficients fitted for them were an artifact of the EXTRACTOR. The tool now builds the pruner the way
`src/content.js` does and calls it on the same events (a `move` under content.js's own two-move
guard, `switch` / `item` / `enditem` / `activate`, the format-lock cascade and `speedfloor`) through a
new `drivePruner`, and shares its damage engine with the evaluator. Dims 120/121 are the other half:
`_teraThreat` is a hard 0 because Terastal Clause bans Tera in `[Gen 9] National Dex OU`, so while
`state.terastallizationBanned` is set they carry the **cleaner advantage** (`_cleanerAdvantage`) —
the share of the opponent's LIVING bodies that our fastest living body both outspeeds and removes in
two hits, memoised on the full matchup (both species, the attacker's move list, the defender's
believed spread and the field). A board without the flag keeps `_teraThreat` byte for byte.
`tests/weights_check.js` §5b proves the wiring by A/B (the same corpus with the pruner absent from
the sandbox) and pins the new dims on constructed boards; `tests/run_tests.js` pins the same two facts
end to end.

**Phase 5 — the feature table.** `tools/run_ablation.js` gains rows for `surprise-mask` and
`nash-prior` and its `endgame-3v3` row now names the hardening pass, so one enable prices the whole
correction set. The focused sweep (`--features endgame-3v3,surprise-mask,nash-prior --battles 60
--seed 1337`, four seats, 240 battles, 0 errors) is the first win-rate reading any of the three rows
has had, and **nothing was adopted**: `endgame-3v3` and `nash-prior` came back `identical` and
`surprise-mask` bought 6 cap standoffs for 3 wins and 3 losses at Δscore exactly 0.0 (`stall`).
Two findings worth more than the deltas: the endgame row is a NULL INSTRUMENT — the tier publishes a
readout nothing in the ranking path reads, so the sweep cannot price the five corrections and §7 of
`tests/endgame_check.js` is their evidence — and the anchored opponent mix cannot reach our own
frequencies (`ATTEMPTS.md` §L2's ceiling), which is why its row is flat by construction. `LaplaceEngine`
now calls `solveAcrossWorlds` instead of the single-world entry point (pinned in `tests/run_tests.js`),
so the readout's mate has to hold across every sampled world. `ATTEMPTS.md` §M carries the table, the
mechanism notes and the decision.

### Verified — the protect cell prices no decay, and QRE cannot move our own frequencies

Two claims the block-ships-OFF decision rested on were re-checked against the code on 2026-10-15 and
pinned, because both had been asserted rather than measured (the tables are in `ATTEMPTS.md` §L).

- **The 1-ply Protect cell prices NO decay, which is why a staller looked invincible in it.** The
  `shielded` flag in `_payoff` reads the ACTION (`oppAction.kind === 'protect' || oppData.isProtect`)
  and never the opponent's protect chain, so a shield blocks our move however long the chain is —
  including the repeat that FAILS in the real game. On the `quiescence_check` fixture a fresh block
  cell scores **37.53** against the legacy cell's **614.43** (the shield is worth **576.89** of our
  hit); a board whose chain is already two long still blocks, **86.80** vs **656.90** (the shield eats
  **570.10**, 98.8 % of the fresh gap); and a five-deep chain prices EXACTLY like a two-deep one. The
  only thing in the cell that reads the chain is the evaluator's `protectRhythm` term (dim 126, +0.5
  once the consecutive count reaches 2), and it shifts the block-ON and the legacy cells by the same
  small amount without ever letting the hit through. This is the mechanism under §K6/K6b: pricing the
  shield turns a staller's whole column into free turns for them, so the engine's committing lines all
  score 0 and it disengages. `tests/quiescence_check.js` §3b pins the table.
- **`laplace.nash.qre` is near-inert for the ranking by construction, not merely unrated.** The flat
  mirror row was filed as "the league declares no rating for the persona seat" (§K4), and the ramp is
  exactly as documented (no rating → `0`; at or below `lowRating` **1100** → the full **30**; at or
  above `highRating` **1850** → `0`; linear between) — so the mirror is inert because it declares
  **no** rating, not because it "was set to 1800+", which would be a non-zero `tau` of **2.0**. But the
  load-bearing half is structural: in `solveNashFictitiousPlay` the soft column mix reaches only the
  PUBLISHED opponent strategy, while each side still best-responds to the hard argmax and OUR own
  cumulative payoff reads that hard index, so a temperature cannot reach our frequency counts on ANY
  matrix (12/12 random 9×9). `tests/tuning_check.js` §7b pins that on three fixed matrices and on a
  real board: with the tier genuinely engaged (a seat rated 1200) the engine's confidence / frequency
  column and the published top line are **bit-identical** with the tier on and off; only the opponent
  mix and the row VALUES move. The row's `caveat` now says so, and its `direction: 'on'` is kept, so
  the cost of turning it back on stays one sweep away. The question `ATTEMPTS.md` E5 left open —
  whether the hard equilibrium is wrong about **people** — is therefore NOT answered by this row as
  built.

### Measured — `beam-2ply` did not replicate across seeds, so the default stays OFF

Two runs of the same row on the mirror, 60 paired battles each, two seeds, 0 errors. Seed 1337:
baseline **41.7 % (25-34-1)**, beam-ON **61.7 % (37-21-2)**, Δwin **+20.0 [+3.3, +36.7]**, Δscore
**+20.8 [+4.1, +37.5]** — the interval excludes zero. Seed 20261016: baseline **43.3 % (26-28-6)**,
beam-ON **45.0 % (27-28-5)**, Δwin **+1.7 [−15.0, +20.0]**, Δscore **+0.8 [−16.7, +19.2]** — flat.
Seed 1337's interval floor (+3.3) sits above the second seed's point estimate, so the two seeds do not
overlap the way a replicated effect would, and the pooled reading is the one n = 20 already gave
(**+5.0 [−30.0, +35.0]**, "no measurable effect"), now at three times the power. The n = 20 "games 8.9
turns shorter" does not hold either: the beam is −5.5 turns on seed 20261016 and +0.6 on seed 1337.

**`laplace.beam2Ply.enabled` therefore stays `false`** — the seed disagreement first, and two standing
caveats second: the mirror is the instrument most confounded for a DEPTH increase (the variant
outsearches the frozen, SHALLOWER twin it is measured against, so a win there cannot separate "finds
better lines" from "outsearches the twin"), and enabling the beam runs its 3×3×K = 54 cells on Pass 1,
the synchronous ranking, in a project already ~3× its 10 ms per-turn target. The tier stays a live
promotion candidate (`direction: 'on'`); the decisive run is a non-self-play instrument (or
`tools/benchmark_human_match.js` on the tactical swap `tests/tuning_check.js` §5 pins) plus a bench
delta. `ATTEMPTS.md` §L3 carries both seeds' tables, and the observation that a single-seed mirror row
here is a 60-game deal from a distribution with a real seed-to-seed wobble — which is exactly why the
second seed was run.

### Added — a second ply for the cells that can still change the answer, and a match-point scale for the gate

Six changes in one pass, all of them behind a config leaf, all of them measured before adoption
(`--league mirror` and the three personas, 20 paired battles a variant, seed 1337). The rule the repo
runs on did not move: `enabled: false` is bit-identical to the build before this pass, and that
identity is pinned rather than asserted.

- **The gate now reports TWO scales, and the second one is the point.** `tools/run_ablation.js`
  computes a paired bootstrap on the **match score** (win 1 / tie 0.5 / loss 0) beside the existing
  binary win indicator, and prints `Δscore` and `scoreCi` next to `Δwin`/`ci`. The reason is a
  measurement this repo already lost once: a binary win indicator maps a 100-turn tie to **0**, so a
  variant that converts 13 losses into 13 stall ties moves it by **0.0** — which is how `urgency`
  first read flat while its OFF arm had given up **9.2 points** of match score (ATTEMPTS.md A1/J).
  The two intervals disagreeing is now a `score-split` flag rather than a rounding question, because
  which instrument is right is a question about the corpus, not about the arithmetic. Every existing
  JSON key is unchanged; `scoreDelta`/`scoreCi`/`scoreVerdict`/`featureScoreVerdict`/`scoreSplit` are
  additions.
- **A selective 2-ply beam** (`laplace.beam2Ply`, ships **OFF**): after the 1-ply matrix is built, the
  top 3 of our rows are re-priced against the top 3 of their replies by playing the TURN OUT — 3 × 3 ×
  K cells, 54 on the shipped numbers, against the 39,366 a full 9 × 9 × 6 tree would need (~2,000 ms,
  which does not fit a phone). Each beam cell builds the T+1 board: a knockout resolves a
  **replacement from the world's own roster** (our best surviving responder, or theirs, each paying
  its side's entry hazards), a side with nothing left scores the terminal loss/win immediately, the
  field timers tick (`trickRoomTurnsLeft`, `weatherTurnsLeft`, `terrainTurnsLeft`), and the Turn-2
  exchange is read off the resulting board before being blended into the 1-ply cell by `blendWeight`
  (0.35). The beam is a BEAM and not a tree on purpose; `_refineBeam2Ply` re-solves fictitious play
  on the refined matrix, so the published mix is still an equilibrium of the cells it edited.
- **The endgame box widened to 3 bodies** (`laplace.endgame.maxAlive` 2 → 3, plus
  `maxBranchingMoves: 12`) and an **ambiguous Speed order is a chance node** now
  (`laplace.endgame.chanceNodes`) instead of a refusal. When our exact Speed falls inside their
  `[speedFloor, speedCeiling]` band, the probability they act first is read off their own surviving
  candidate sets (weights included) and the pair is priced as the expectation over the two orders. **A
  mate is never claimed through one**: a blend that lands inside the mate band is clamped to the top of
  the non-mate region, so `solved` still means proven. `maxBodies` stays as a legacy alias at the same
  value, and an exhausted node budget still reports `{solved:false, reason:'budget'}` — never a partial
  line dressed as a solution.
- **Stratified active-set worlds** (`sampler.stratifyActive`, ships **OFF** — built ON, and its own
  first reading flipped it): K = 6 independent draws
  routinely pick the same opponent active set four or five times and never draw a 25 %-usage set, and
  the ACTIVE body is what every cell of the matrix is priced against. The first `min(K, distinct legal
  sets)` worlds now cover those sets one each, heaviest posterior first, carrying their own posterior
  weights; the bench and the worlds past the stratum come from the same seeded stream as before, so a
  pinned world differs from its i.i.d. twin in the active set and nothing else. A pinned set still has
  to pass every observation check, so this changes **which worlds exist, never which facts are legal**. **It measured the wrong way round:** on the mirror (20 paired battles, seed 1337) the i.i.d. draw
  it replaces won **+15.0** win points **[0.0, +30.1]** and **+15.0** match points **[+2.5, +30.0]**
  — the match-point interval excludes zero in the *i.i.d.* direction and the win interval’s floor
  *is* zero, so neither scale supports the tier and one is evidence against it. A better-calibrated
  opponent model that costs match points is still a cost, so the shipped leaf went back to the i.i.d.
  draw and the ablation row now patches the leaf UP (`direction: 'on'`) as the promotion candidate.
- **Quantal Response Equilibrium** (`laplace.nash.qre`, ships **OFF**): the opponent's column step
  inside fictitious play is a LOGIT softmax at temperature `tau` (30 at `lowRating` 1100 and below,
  decaying linearly to 0 at `highRating` 1850) instead of a hard argmax, so their mix spreads the way a
  noisy player's replies do — while OUR side keeps the hard best response, so the worst case we accept
  is still bounded by the same matrix. QRE changes what we expect THEM to do, never the bound we play
  against. A seat with no declared rating resolves to the identity, because an unknown opponent is not
  evidence of a noisy one.
- **The Cancel window's background ponder** (`laplace.deepPonder`, ships **ON**): the boot still
  renders the fast pass synchronously and then schedules a DEEPER one (`deepWorlds` 14, the 2-ply
  beam, the 3v3 endgame bound) in a timeout that never blocks a frame. A monotonic `_ponderId` bumps
  on every `|turn|`/`|init|`/new decision frame, so a stale pass publishes nothing; if the player has
  already clicked (`_lockedChoice`, read off our own outgoing `/choose` and cleared on `/undo` or a new
  turn) and the Cancel button is on screen, the deeper ranking is compared with what they locked in — a
  veto, or a better line by `cancelAlertScoreDelta` payoff or `cancelAlertConfDelta` confidence points
  — and `renderCancelAlert` flags Showdown's own `<button name="undoChoice">` with a
  `UNDO → <line>` badge and buzzes. Every teardown path (`clear()`, a new window, an emptied alert)
  releases the flag, and nothing here can throw into the frame loop.
- **`quiescence.followUpWeight`** (ships at **1.0**, the identity) and the damped candidate (**0.5**) as
  an ablation row. The knob scales the setup extension's second exchange, which the
  `quiescence-extendsetup` row priced **HURTS +23.3** on the mirror and **HELPS +20.0** on the
  re-anchored personas arena, both intervals excluding zero — so the tie is being investigated rather
  than resolved by picking the friendlier number. `1.0` is bit-identical to the shipped build.

**Guards, each able to fail.** `tests/tuning_check.js` §5 pins the beam: `enabled: false` reproduces the
1-ply matrix cell for cell (a spy counts the `_refineBeam2Ply` calls and proves the OFF build never
makes one), the T+1 value is pinned against a hand-computed board, the revenge killer is what makes a
knockout worse than it looks (pricing the Dragonite flips Encore above a 120 BP STAB attack), a side
that faints with nothing behind it is the LOSS and not the kill, a mutual wipe is a DRAW, and an
expiring Trick Room ticks OFF. §6 pins the stratification against the i.i.d. draw it replaces.
`tests/endgame_check.js` §6 pins the 3v3 mate (three bodies inside one hit each, found in 64 nodes),
the branch cap, and the Speed band against the same board with their order made certain — the
probability-weighted row must land **between** the two references, and a mate is never claimed through
the blend. `tests/hud_check.js` §14 pins the ponder's scheduling contract (never inline, one pass per
window, a new window invalidates the old, the wire's slot number resolved against the request) and
`tests/dom_check.js` §11 pins the alert's DOM lifecycle, including the
`.battle-controls button[value="undo"]` spelling and a flagged button released by `clear()`.
`tests/ablation_check.js` gained §5l (the five new rows, and the one de-flipped patch) while its no-op
guard still rejects a leaf that changes nothing.

**What the pass measured, and what it decided** (full tables in `ATTEMPTS.md` §K). Mirror,
`--battles 20 --seed 1337` (baseline 40.0 %, 8-10-2): `quiescence` off +10.0 [−20.0, +40.0] ·
`quiescence-extendsetup` off +10.0 [−20.0, +40.0] — **the same battles**, so the tier's mirror effect
is all setup ply · `quiescence-followup-damped` (0.5) **−5.0** [−40.0, +25.0] — the damped follow-up
is the **wrong way**, so the hypothesis it was built to test is disarmed · `quiescence-blockprotect`
and `quiescence-turn2speed` and `endgame` and `endgame-3v3` and `nash-qre` **`identical`** (inert in
this corpus, each with a named reason) · `beam-2ply` +5.0 [−30.0, +35.0] with games **8.9 turns
shorter** · `sampler-stratify` off **+15.0** win [0.0, +30.1] and **+15.0** match score [+2.5, +30.0].
Personas (`--agent all`, which is now **four** seats: anchor, exploiter, chaos and the mirror;
baseline 55.0 %, 11-4-5, and NOT comparable to the 98.3 % §H recorded before the mirror was folded
into `all`): `quiescence` off **+25.0 [+5.0, +45.0]**, `quiescence-extendsetup` off **+30.0
[+10.0, +50.0]**, `quiescence-blockprotect` off **+25.0 [+10.0, +45.0]** with the exploiter's five
100-turn stalemates turned into five wins, `followUpWeight` 0.5 flat, `turn2speed` `identical`.

**Decisions.** `sampler.stratifyActive` shipped back to the i.i.d. draw (§K2) — the first of the two defaults this
pass flipped, and it flipped because the match-point interval excludes zero against the tier while the
pre-pass build is the i.i.d. draw. `beam2Ply`, `nash.qre` and the endgame tier all stay OFF: none
cleared the gate. The `quiescence` tier stays ON with its contradiction **narrowed rather than
resolved** (§K3): both instruments now lean the same way at n = 20, which is not the power to move a
shipped default, and §K3 names the 60-battle run that can.


### Changed — the protect block ships OFF, because its own row priced it against a shield-spammer

`laplace.quiescence.blockProtect` now ships **`false`**, and this is a measurement rather than a
preference — the second default this branch has flipped (the first is `sampler.stratifyActive`, above).
The leaf encodes a real game rule: a shield that is up blocks our move. What the sweep priced is the
*consequence of pricing it inside a one-turn cell*, and it is worth about fifteen win points.

The run `ATTEMPTS.md` §K3 named: `--agent all --battles 60 --seed 1337` (four seats, so 15 battles
each), 6 variants, 360 battles, 0 errors. Switching the block off won **78.3 % (47-11-2) against the
baseline's 63.3 % (38-11-11)** — Δwin **+15.0 [+6.7, +23.3]**, Δscore **+7.5 [+3.3, +11.7]**, both
intervals excluding zero on the same arm — and cut the 100-turn cap games from **11/60 to 2/60**. The
whole movement is one opponent: the `exploiter` persona (a Protect-heavy staller) goes **4-0-11 →
13-0-2**, while the anchor seat is 15-0-0 and chaos 13-2-0 either way, and the **mirror is
`identical`** — their shield never lands on a cell where the block flips the choice, so a flat row
there is a statement about the opponent, not about the knob.

**Why not the other two available moves.** The whole tier's arm also excludes zero (+13.3 [+1.7,
+25.0] win, +11.7 [+4.2, +20.0] score), but the sub-arms localize the mass: `blockProtect` is the
exploiter's half and `extendSetup` is the mirror's half (6-9 → 9-3 there, **0.0 on the three
personas**). `extendSetup` therefore stays ON: its own arm's floor is −5.0 on the win indicator and
**exactly 0.0** on match score, the two instruments still disagree about it (§H vs §J), and §C1's rule
is that a shipped default does not move on a contested reading. The tier's master switch stays ON too,
because that half is the thing the tier was built for.

**What it costs, stated rather than hidden.** With the block off, the matrix reads their Protect as the
no-op the legacy 1-ply cell read — i.e. it credits us a hit a live shield would eat. That is not a
claim the block is wrong; `tests/quiescence_check.js` still proves the block works whenever it is on,
and that switching it off reproduces the legacy number exactly. It is a claim about its VALUE: pricing
the shield makes the engine pivot and grind instead of committing, and against a staller that is worth
fifteen win points. The ablation row `quiescence-blockprotect` now turns the block back **ON**
(`direction: 'on'`, the second row in the table whose own measurement moved its default), so the cost
of reverting is one sweep away, and `tests/ablation_check.js` pins that row's numbers in its caveat so
the reason travels with the table.

**Confirmed on a second seed, with the seat to itself.** `--features quiescence-blockprotect,quiescence
--agent exploiter --battles 60 --seed 20261015` (180 battles, 0 errors) asks the same question with all
sixty battles against the shield-spammer and with the baseline at the NEW shipped value, so each row
removes exactly one half. Turning the block back **ON** takes that seat from **86.7 % (52-0-8) to
16.7 % (10-0-50)** — Δwin **−70.0 [−83.3, −56.7]**, Δscore **−35.0 [−41.7, −28.3]**, **50 of 60 battles
capped**. Same sign, five times the magnitude. The same run settles the OTHER half in the opposite
direction: removing the SETUP ply costs **−40.0 win [−55.0, −25.0]** and **−20.0 match score
[−27.5, −12.5]** (cap games 8/60 → 32/60), so `extendSetup` stays ON — the personas' "no measurable
effect" for that half at seed 1337 was the seat being saturated by the mispriced shield, and with the
block off its value shows up immediately. **Both halves are therefore settled, in opposite
directions**, and the exploiter seat turns out to be bimodal in a way that is mostly the LEAF rather
than the seed: 17–27 % with the block priced, 78–87 % without it, on either seed.


### Fixed — a turn holds more than one decision window, and the engine answered the second with the first one's ranking

A turn is two windows. The move request opens it; a `forceSwitch` request closes it when a body
faints or a pivot move hands the turn's tail to a replacement — and both carry the SAME turn number.
`_onRequest` latched on `state.turn` alone, so the second window hit the latch, returned `[]` without
evaluating, and left the FIRST window's ranking standing as the answer to the second. That ranking
describes a board that no longer exists: it offers the bench as it was, so it can name the body that
has just switched in and fainted. The driver clicks the engine's top line, the sim answers
`|error|[Invalid choice] Can't switch: You can't switch to an active Pokémon`, the fallback ladder
retries, and the battle stops being the engine's.

Measured on the mirror gate — 20 battles, seed 1337, both seats, `ARENA_MIRROR_GAMES=20 node
tests/arena_check.js` against the previous commit: **103 `|error|[Invalid choice]` lines**, the
answered-frame ledger at **−103** (103 playable frames needed the retry ladder), and **20 frames where
the engine returned no ranking at all**. The same gate on this commit: **0, 0, and 2** — and neither
of the two is a frame that had a legal action on it.

Three defects wore that one symptom:

- **The window had no identity.** `src/content.js` gained `_decisionFrameKey(state)`: the server's own
  `rqid` when the frame carries one (a request payload is not guaranteed to — `@pkmn/sim` 0.10.11
  sends `{teamPreview, side}` and nothing else), else `preview`/`wait`, else a structural key of the
  turn plus the `forceSwitch` flags, the active body's move list with PP and disabled flags,
  `trapped` / `maybeTrapped`, and the whole roster's idents, actives and conditions. Two IDENTICAL
  re-deliveries — the same frame re-sent after an `|error|`, a duplicated poll — collapse to one key
  and still evaluate once, which is what the latch was for.
- **`parseIdent` invented a slot.** A roster entry is `p1: Great Tusk` — a side and a name, no slot —
  and the parser fell back to the bare side prefix, so it returned `slot: 'p1'`.
  `_mergeMyTeamFromRequest` matched a body by that invented slot and then STAMPED it onto the body, so
  every later roster entry landed on the same body (holes in HP and status), the fake slot displaced
  the real battle slot, and the merge's last-entry-wins `isActive` left the ACTIVE body flagged
  inactive — which put it back on the switch menu. A slot is now reported only when the text carries
  one, `isBattleSlot` is the single predicate the merge, the switch list and every protocol handler
  share, and the merge stamps a real slot only.
- **The switch menu was built from our own flags, not the server's roster.** `legalActions.switches`
  scanned `myTeam` for `!fainted && !isActive`, so a stale `isActive` could offer the body standing on
  the field, and `trapped` was ignored entirely. The list is now built from the `|request|`'s own
  `side.pokemon` — the authority on which body is standing there, which have fainted, and which slots
  the server will accept — dropping active and `0 fnt` entries, adding each body once, never inventing
  a body the roster does not name, and dropping the rows altogether when the server says `trapped` on a
  move window (`forceSwitch` frames are exempt: the body is already gone, and the sim's `chooseSwitch`
  only consults `trapped` in its move state). `maybeTrapped` is published and deliberately NOT used to
  delete switches: the sim rejects only on `trapped`, while `maybeTrapped` merely sets `cantUndo`, so
  deleting them would cost a real escape option to hide an uncertainty the engine may act on.
- **And the bridge kept a stale answer one layer up.** `engine_bridge.feed` left `ranked` in place when
  a decision frame arrived that the engine did not answer, so `topChoice()` returned a line computed
  for an EARLIER window and the driver wrote it. It now clears the ranking instead (the same fact that
  let an illegal `switch` reach the sim at all), except for a re-delivery of the same raw request line,
  which keeps the answer that is already that exact window's.

**Guards, each able to fail.** `tests/arena_check.js` §3c pins the engine level with no sim in the
loop: the slotless roster ident reports no slot while a real battle ident keeps its own, the window
key changes when the window does, the ACTIVE body is never on the switch list and every bench body is
once, the opening move window is ranked and a move window's ranking is NOT the answer to the
`forceSwitch` window on the SAME turn (which is ranked as switch lines only, with the fainted body
never offered as its own replacement), a byte-identical re-delivery does not re-rank and does not
discard the ranking that answers it, and a frame with no legal action ranks nothing AND does not leave
the previous window's ranking behind. `checkMirror` then plays real battles and asserts zero illegal
choices and zero unanswered playable frames on both seats, plus the opt-in 20-battle gate above —
`ARENA_MIRROR_GAMES=20` re-runs the exact measurement these fixes were verified against (~3.5 min of
sim, so it is not part of a default `npm test`).

### Added — the three 1-ply leaf illusions, each behind its own gate

The 1-ply leaf mis-priced three things a real turn does, and the mirror sweep (§J of `ATTEMPTS.md`)
now prices each of them separately. Every toggle is `enabled: false` = bit-identical to the previous
pricing, pinned by the suites below.

- **`laplace.realOppSwitch`** — their switch reply used to be priced by resetting the outgoing body to
  100 % and DISCARDING our turn-1 hit: the incoming body was never named, never paid entry hazards,
  and never took the attack aimed at it. `_oppSwitchTarget` now resolves the switch-in (from the
  sampled world's own roster when there is one), `_oppSwitchInHp` charges its side's hazards through
  `U.hazardPercent`, and OUR move lands on the body that is actually standing there.
- **`laplace.quiescence.respectTurn2Speed`** — turn 2 of the setup extension is now ordered by the
  Speed each body will actually have there (the boost applied, plus Trick Room and move priority,
  through `_turnOrder` / `_movePriority`). Off, both second actions landed unconditionally, so
  "boost, then kill the setup user" and "boost, die to the setup user" scored the same as
  "boost, trade"; on, a body that faints first does not act at all.
- **`laplace.pricePivots`** (+ `regenPct`) — `U-turn` / `Volt Switch` / `Flip Turn` / `Chilly
  Reception` / `Teleport` / `Parting Shot` are priced as what they are, through `U.isPivotMove` and
  `_pivotPayoff`: a hit, a switch, and the incoming body's own matchup, with the turn order deciding
  who eats the opponent's reply, `Regenerator` credited to the body leaving, `Chilly Reception`'s snow
  on the field, and the best bench body chosen for the job (`_bestBenchSwitch` for a fast pivot,
  `_bestBenchAttacker` for a slow one that has already taken the hit).
- **`laplace.priceRecovery`** (+ `defaultHealPct`) — a healing move deals no damage, and the 1-ply
  model scored it as a wasted turn: the body entered the leaf at the HP it had ALREADY lost. The heal
  is now credited up front, clamped to 100, and only for a body that survives to execute it.

Pinned by `tests/tuning_check.js` §4 (each correction against a hand-computed board, plus the
`enabled: false` reproduction) and §4b (turn-2 initiative by Speed, priority and Trick Room), and by
`tests/quiescence_check.js` for the setup ply. What they measured in the mirror sweep — all four flat
at 60 battles, with `pricepivots` leaning the same way as `quiescence-extendsetup` — is in §J.

### Measured — the first mirror sweep, and the one contradiction it produced

`node tools/run_ablation.js --league mirror --battles 60 --seed 1337 --parallel 2`: 8 variants, 480
battles, **0 errors**, 4,122 s. The mirror baseline is the shipped config and the engine seat is the
only one patched, so the Δ is a paired, same-seat comparison against a frozen twin (baseline 25-34-1,
41.7 % win, 62.3 turns, 2/60 capped).

| row (feature switched OFF) | Δwin | 95 % CI | verdict |
|---|---|---|---|
| `quiescence-extendsetup` | **+23.3** | [+8.3, +38.3] | **feature HURTS** (41.7 % → 65.0 %), `surprise` |
| `pricepivots` | +10.0 | [−6.7, +26.7] | no measurable effect |
| `pricerecovery` | +5.0 | [−13.3, +21.7] | no measurable effect |
| `quiescence-turn2speed` | +0.0 | [+0.0, +0.0] | no measurable effect |
| `clock` | +0.0 | [+0.0, +0.0] | `identical` — the arena declares the pace, so flat is correct (§D2) |
| `realoppswitch` | −1.7 | [−20.0, +15.0] | no measurable effect, `stall` |
| `urgency` | −1.7 | [−18.3, +15.0] | no measurable effect, `stall` |

**`quiescence-extendsetup` is now CONTRADICTED between instruments, and that is the finding.** It was
re-measured **HELPS +20.0 [+10.0, +30.0]** on the re-anchored personas arena; the mirror reads
**HURTS +23.3** — same patch, same seed, 60 paired battles each, both intervals excluding zero,
opposite signs. The knob therefore **stays as it ships** until a higher-power row (500 battles, a
second seed, or a declared stronger opponent) breaks the tie: the mirror is the instrument WITH
headroom (41.7 % baseline against the personas arena's 98.3 % ceiling), but a self-play win rate also
prices how exploitable a frozen twin is, which is not the same question as strength against a human.

**What the mirror did reproduce is `urgency`'s mechanism.** Switching turn urgency off took the
100-turn cap ties from **1/60 → 14/60** and the mean game from **62.3 → 75.2 turns** — the exact
behaviour it was adopted for, on an instrument that never saw the adoption run. Its win interval is
flat for an arithmetic reason worth naming: the OFF variant took the baseline's 34 losses down to 22
and turned the difference into ties, so the win indicator barely moves while the score (win = 1,
tie = ½) rises **+9.2**. For a row whose mechanism is converting decisive games into ties, the
win-indicator bootstrap is the conservative statistic — quote both. (`realoppswitch` has the same
shape, smaller: win −1.7, score +3.3, cap ties 1 → 7.)

Full table, the resolution check and the reading of the flat leaf rows: `ATTEMPTS.md` §J.

### Housekeeping — the counts the README states

The README's per-suite check counts are canonical (`tests/run_all.js` validates its suite LIST against
them, not the numbers) — four of those counts had drifted, and every number below is what the suite
prints on this commit: `arena_check` 125 → **157**, `ablation_check`
251 → **269**, `tuning_check` 68 → **112**, `quiescence_check` 71 → **92**, plus the suite total
28 → **32**. Every number is the count the suite itself prints on this commit.

### Measured — the arena re-anchor

With the engine finally getting a real team and the three client frames, the whole sweep was re-run at
the repo's standard sample (`--battles 60 --parallel 6 --seed 1337`: 26 variants, 1,560 battles,
15 min 45 s, **0 errors**) to find which verdicts the broken instrument had been hiding.

**The baseline moved 68.3 % → 98.3 %** — and that is the finding: the arena had been scoring a
materially weaker engine, so every row measured before this dates from a different experiment.

| row | before | after | reading |
|---|---|---|---|
| **C1** `quiescence-extendsetup` | HURTS, +19.3 [+12.0, +26.7] | **HELPS, +20.0 [+10.0, +30.0]** (98.3 % → 78.3 %, 13 capped) | **sign flipped**; the shipped-ON knob is now supported |
| **B1** `switch-tax` | REJECTED (agreement +12.3, strength −26.7) | **HURTS, −31.7 [−43.3, −20.0]** | rejection CONFIRMED, now on strength alone |
| **D2** `clock` | inert (`identical`) | ~~HELPS, +28.3~~ **RETRACTED** | the +28.3 priced an **artifact**: both arena players share one event loop, so every turn measured ~0 ms, took the label `auto` (0.25) and pruned their switch replies from the matrix for the whole battle. The run now declares the pace (identity by default) |
| **A1** `urgency` | HELPS, +28.3 [+18.3, +40.0] | 0.0, flagged `stall` | **ceiling, not a refutation** — see below |
| **D3** `elo-band` | inert (`identical`) | changes turns, Δ win 0.0 | cheap now; not decisive |
| `wincon` / `profile` | `identical` / non-inert | non-inert / `identical` | swapped sides |
| D1/D4 `volatility`, `comeback` | unpriceable | arrive, Δ win 0.0 | input present; the charge is too small to flip a line |

**The one caveat that governs the rest — the instrument is at its ceiling.** The baseline now wins
98.3 % with **zero losses in 60 games**, so the sweep can detect HARM and essentially nothing else:
fourteen of the twenty-five rows read 0.0 and most of those mean "nothing left to win", not "the
feature does nothing". A1's 0.0 is the clearest case — the +28.3 it was adopted on is now the
baseline, so it cannot be re-priced here at all. Raising `--battles` does not fix this; a precision
on a ceiling is precision on zero. The personas have to get stronger before the upper half of this
table can be re-measured. Full table and reasoning: `ATTEMPTS.md` §H.

### Added — the self-play mirror

The personas are beaten 98.3% with zero losses, so the arena can show HARM and almost nothing else
(ATTEMPTS.md section H). `EngineMirrorAgent` seats the engine against a FROZEN copy of itself on the
same team, putting the baseline near 50% where a gain is as visible as a loss. `--agent mirror`
(alias `--league mirror`) in run_arena.js, `--mirror` in run_ablation.js.

The mirror keeps the SHIPPED config even when the run carries a `--set` patch — otherwise a paired
ablation would test the variant against itself and every effect would cancel. `engine_bridge`'s
`loadHarness` grew a named `{baseline:true}` mode in its own cache slot, and refuses a baseline
requested together with a patch. Pinned in tests/arena_check.js section 3b, which plays a real mirror
game (both seats the same engine: 18 empty rankings each over six games) and checks the two-sandbox
split. Seed 7, 20 battles: 9-11, avg 34.6 turns.

### Fixed — the two open veto defects, and the six columns the corpus cannot move

- **VETO2 hard-vetoed on a SUSPICION.** `vetoAbilityImmunity` fed the species' whole
  `possibleAbilities` pool into `U.immunityReason`, so a Ground move into any body whose species *can*
  hold Levitate was masked at −9999 even when Levitate was one of three unconfirmed possibilities —
  and the world sampler already prices those worlds at 0 damage, so the hard veto both deleted the
  hedging lines and measured nothing (`BUGS_AUDIT_REPORT.md` lists it). An ability is now PROVEN only
  by a battle reveal, by being the species' only possibility, or by every surviving `candidateSets`
  entry carrying it. The Flying type and an Air Balloon are facts the board states outright, so they
  still veto on their own.
- **VETO4 read `boosterActive` as a flat 1.5x SPEED boost.** Protosynthesis / Quark Drive raise the
  holder's HIGHEST stat, and the protocol states which one: `|-start|p2a: X|protosynthesisatk`. The
  state manager now parses that suffix onto `mon.boostedStat` (cleared on `|-end|` and on switch-in)
  and `U.paradoxSpeedBoost` applies the multiplier only when the boosted stat is Speed — falling back
  to the set's real highest stat when the protocol has not said. Measured against the sim: an
  Attack-boosted Great Tusk (`protosynthesisatk`, highest stat Atk) was being scored as though it
  outran the field.
- **Six dims are structurally zero in the corpus, and the artifact now says so.** Dims 66/67/72/73
  (each active's choice-lock and itemless flags) are written only by `src/set_pruner.js`, which
  `tools/extract_training_data.js` never runs; dims 120/121 are the Tera-threat pair, a hard 0 because
  Terastal Clause bans Tera in `[Gen 9] National Dex OU`. They now join 41/47 in the export clamp, and
  `tests/weights_check.js` §5b proves each by construction (the four item dims move when the fields
  are set, and the Tera pair moves when the ban is lifted), so "constant zero" is distinguished from
  "dead code".

### Fixed

- **The arena was scoring a DIFFERENT engine, two ways, and neither one failed a test.**

  **(1) The engine was handed a team it could not parse.** `run_arena` gave the engine the
  sim-PACKED team string (`ctx.enginePacked`) while every suite and the browser give it a Pokepaste.
  `parseTeam` reads a paste, so the engine registered **one** body whose species was the entire
  packed line: it offered `switch <the whole packed team>` as a legal option, the sim rejected it
  ("Can't make choices: You sent choices for 54 Pokemon, but this is a singles game"), and
  `sim_runner` walked its fallback ladder over every rejection — so a large share of the battle was
  decided by the DRIVER, not the engine, and the report counted the rejected choices nowhere. The
  suite missed it because `tests/arena_check.js` builds its session from the paste (the path a
  browser takes) while the arena passed the packed one. Measured on seed 7 vs the anchor: packed in,
  `session.team.length === 1` and 48 rejected choices; paste in, 6 and **0**.

  **(2) Three frames a real client emits were never emitted.** `|stacc|<moveid>|<accuracy>` (the only
  input `laplace.volatility` acts on, and so the only thing `laplace.comeback` scales), our own
  outgoing `/choose` tagged `kind === 'send'` (the only line that can set the clock's `mySubmitTs`),
  and the `|player|pX|…|rating` field `clock.ratingBands` reads. Without them those tiers could not
  change a decision by construction, so their flat rows were statements about the harness. The
  bridge now emits all three — accuracy from the sim's dex, which is the same data the client's dex
  carries — and `run_arena` calls `session.noteOutgoing()` when it decides. Each persona also now
  DECLARES the band its name implies (anchor 1700 / exploiter 1500 / chaos 1100), so one sweep
  exercises all three ratings bands.

  **Guards, each verified load-bearing by reverting the fix and watching it fail:**
  `tests/ablation_check.js` §7 pins the three frames at the bridge (accuracy table populated, clock
  samples > 0 with `switchFactor !== 1`, rating on the state), and a new end-to-end check drives one
  real battle through the CLI and asserts the engine no longer submits a choice the sim rejects
  (reverting to the packed team fails it with `got=50 want=0`; removing the `|stacc|` emission fails
  two §7 checks). 264 checks, up from 251.

  **Measured after the fix** (seed 1337, paired, `--parallel 4`): disabling `clock` appeared to cost
  **37.5 win points** (100% → 62.5%, flagged `stall`) — **RETRACTED.** That swing priced an artifact
  of the harness, not deliberation: both arena players share one event loop, so the clock measured
  ~0 ms of lead on every turn, labelled them all `auto` (0.25), and 0.25 is below
  `clock.switchKeepThreshold`, which deleted the opponent's switch replies from the matrix for the
  whole battle. The run now **declares** the opponent's pace (`normal` = the identity by default;
  `--deliberation auto` prices a fast opponent), and section 7 of `tests/ablation_check.js` pins both
  the artifact and the declaration. The clock tier is therefore live and honest, but its input is a
  stated one — a flat row against a neutral opponent is the correct answer, not a measurement gap. `clock.ratingBands` changed at least one battle at 24 a side (the run no longer reports an
  `identical` row) while its win-rate interval still included zero. `volatility` and `comeback`
  ARRIVE now and still changed no battle at 24 a side — which is a fact about the charge, not about a
  missing input: the sample teams carry almost no sub-100% move worth evaluating, so a 10% penalty on
  Iron Head or Ruination is too small to flip a top line. Read every row of this table with the
  ceiling in mind: the baseline wins **100%** against these three personas, so this arena shows harm
  far more easily than gain.

- **Showdown's new client decorated 0 of 4 move buttons — a silent no-op.** `_moveIdOf` resolved the
  classic client's `data-move` and then fell back to `U.toID(button.textContent)`. The new client
  (`play.pokemonshowdown.com/newclient`, `src/panel-battle.tsx`) drops BOTH `data-move` and
  `name="chooseMove"`; the only handle left is the tooltip payload, and `textContent` concatenates
  name + type + PP into a string whose toID matches nothing ("Headlong Rush<br>Ground 16/16" becomes
  `headlongrushground1616`). So on the new client the HUD never marked a single button, never showed
  a lethal bar and never showed a badge — while the classic client stayed correct, which is exactly
  why the suite stayed green. It now reads `data-tooltip` first. Two traps worth recording, because
  both were hit in the attempt: the tooltip carries the move NAME, not its id (built from
  `moveData.name`), so a `[A-Za-z0-9]+` capture silently fails on every name with a space or a hyphen
  ("Headlong Rush", "Will-O-Wisp", "U-turn") and drops straight back into the broken fallback — the
  capture is `[^|]+` and is then run through `toID`; and `data-cmd="/move 1"` is an INDEX that cannot
  be mapped back to a move without the request the engine already holds, so it is deliberately NOT
  used (a stale index is worse than no opinion). `tests/hud_check.js` section 13 pins the contract
  with the REAL rendered label on each fake button, so the lossy `textContent` path can no longer
  rescue the fixture: reverting the regex fails 5 checks, including the end-to-end
  "decorates every button → got 0, want 4". Verified on the live site: 4/4 on both clients.
- **The banner painted over Showdown's topbar and room-tab bar.** `tactician-banner` was pinned to
  the viewport's `top: 0`, which on a phone is Showdown's own chrome: the classic client reserves
  0..56 px for the topbar + room-tab bar, and the new client 0..30, so the menu, the room tab and
  the volume control sat underneath the status strip. The banner now anchors to the measured top of
  `.battle` (`--st-battle-top`, measured before the first paint so there is no 0→56 jump), and the
  overlord pill and deduction badges re-anchor with it by keeping the SAME 18/46 px offsets they had
  to the banner's old position — so the gold pill still peeks out from behind the dark strip exactly
  as before. Measured live: the banner lands at 56 on classic and 30 on new, with the chrome fully
  clear, and what it covers is the top 25 px of the battlefield container (background + weather
  layer), not any control. The attribute is only set by the measurement, so lobbies and the test
  harness keep the viewport-top layout byte for byte.
- **The lethal bar hung out of its move button and covered the button below.** Showdown fixes
  `.movebutton { height: 40px }` and the lethal bar is `display: block` INSIDE it, so it was a third
  row of content in a 40 px box: measured 24 px of overspill on classic (`scrollHeight` 64 vs a
  40 px box) and 15 px on new, landing on the move button in the row under with a 141×19 px /
  145×12 px overlap — i.e. the PP half of a button the player was being asked to read.
  `button[data-st-lethal] { height: auto; min-height: 40px }` lets a decorated button grow to contain
  it; specificity (0,1,1) beats `.movebutton` (0,1,0) so no `!important`, and `min-height` keeps an
  undecorated button exactly Showdown's own size. After: overspill 0 / -2, bar bottom flush with the
  button bottom, sibling overlap `[]` on both clients.
- **The HUD's bottom band covered the new client's move bar, and swallowed the taps meant for it.**
  The bar's position is client-specific and the new one was not modelled: classic puts
  `.battle-controls` at `position: absolute; top: 370px` (297..402 live, with the bottom 400 px of
  the screen empty), while `client2.css` makes `.battle-log .battle-controls` `position: static`
  inside the SCROLLABLE log — so the bar rides wherever the scroll leaves it, 688..792 of an 891 px
  viewport at rest. The bench strip was pinned at 774..835, sitting on the bar's bottom 18 px.
  `_syncControlBar` now measures the bar and publishes `--st-band-lift`, which the three
  bottom-anchored offsets add, and the overlap probe deliberately reads the UN-LIFTED geometry so a
  lift cannot oscillate against its own result. The strip's gradient is also tap-transparent
  (`pointer-events: none` on the strip, `auto` on the pills), so an overlap that does occur can never
  eat a move-button tap. The lift is re-measured on scroll as well as on render — on a `document`
  capture listener, because scroll events do not bubble — and the trigger lives on
  `renderBenchTargets`, which runs every turn of a real battle. Verified live with a colliding bar
  seated deliberately at 747: 61 px of overlap before, 92 px lift, 4 px clear after, with the probe
  in the gradient hitting PS's own log content and the probe on a pill hitting the pill.
- Smaller, same sweep: the `.conf-veto` badge struck its OWN text on top of the strike the move
  button already draws, so "VETO" read as a typo (`styles/overlay.css`); the PP gauge and the
  format sentinel were capped at `40vh`/`34vh` with no viewport bound, so a gauge that starts low
  could hang its last line off the bottom of the screen (now `min(<cap>, calc(100vh - <offset>))`);
  and `bindDrawer`'s adopt-an-existing-drawer exit returned before installing the layout signals, so a
  second content-script injection got a HUD whose band never re-measured — no re-anchor on resize,
  and a bottom band that drifted back over the move bar on the first scroll. Both exits now bind,
  and `tests/dom_check.js` pins it with a doc whose `querySelectorAll` searches the mounted subtree
  (the old stub searched only the button registry, which made adoption unreachable and the section
  unable to fail); removing the fix fails 2 of the 6 new checks.
- **A multi-line WebSocket frame was delivered twice, and the second copy is not harmless.** The
  page APPENDS every line it receives to `battle.log` as well as delivering it on the socket, so a
  line the socket had already forwarded was still sitting in the log for the next 250 ms poll to
  hand over again. The dedupe could only ever remember ONE line, so after a three-line frame
  (`|turn|5` + `|move|...` + `|-boost|...`) it held the frame's LAST line, the poll found the
  earlier two "new", and all three were re-delivered. Most protocol lines are absolute and hide
  it; the relative ones do not — `|-boost|p1a|atk|1` twice is +2, a `|pp|` is decremented twice, and
  `|turn|n` twice double-ticks Trick Room, the weather and terrain timers and BOTH Protect-rhythm
  counters, because `_onTurn` is not idempotent. The socket path now remembers the run it delivered
  and the poll claims it POSITIONALLY at its cursor: only a run sitting exactly at the cursor is
  claimed (so a genuine repeat appended later is still delivered), and a batch that does not line up
  is dropped rather than retried, so it can never stall a later batch or grow without bound. Pinned
  in `tests/injected_bridge.js` (29, up from 23) with a multi-line frame AND a frame the client
  never mirrors into the log; both new checks were verified to FAIL with the claim removed (the
  a three-line frame was re-delivered 3 times over).
- **`SETUP_MOVES` was missing eight real setup moves** (`src/util.js`), so clicking one was priced
  as a NO-OP by the quiescence tier whose entire purpose is to price that click — the same blind
  spot as a missed Earthquake being read as a connection. Added to BOTH tables, with the effects
  the dex cannot answer (21 -> 29): Fillet Away (+2 Atk/SpA/Spe, 50% of max HP — the failure below
  that fraction is already modelled), Coil, Hone Claws, Cosmic Power, Autotomize, No Retreat,
  Meditate, Sharpen. Still excluded and now pinned by test: Curse (type-conditional), Double Team /
  Minimize (Evasion Clause), Acupressure (random), Geomancy (charges a turn). No Retreat's
  switch-lock is the one part NOT modelled — stated rather than invented. `shelter` was in
  `PROTECT_MOVES` AND in the pruner's conditional-power DAMAGING list, which cannot both be right;
  it is neither, so it is gone from both, and `PROTECT_MOVES ∩ UNPREDICTABLE_DAMAGE` is now asserted
  to be empty. `tests/quiescence_check.js` pinned the HP-costing setup list and is updated (Fillet
  Away really does pay half its HP; pricing it as free at any HP is the wrong rule).
- **The speed floor converted an observation its own ceiling cannot see** (`src/set_pruner.js` +
  `src/state_manager.js`). `maxSpeedForSet` is set-STATIC: it knows a set's item and ability but not
  the weather, the terrain, Tailwind or a Speed stage. So a Swift Swim body in rain moves first
  through a ceiling this rule computes as too low, and every one of that body's REAL sets was
  eliminated for being "too slow". The conversion now REFUSES rather than guesses
  (`set_pruner.speedFloorUnsound`, consulted by `applySpeedFloor`, `handleSpeedFloorEvent` and
  `_onSpeedFloor`), which matters because `mon.speedFloor` is read as a real bound by the world
  sampler, the endgame solver and the Trick Room queue. On a clean board — no weather, no terrain,
  no Tailwind, no Speed stage — nothing fires and the rule behaves exactly as before.
  Protosynthesis / Quark Drive stay a documented residual (see below).
- **Knock Off's "connected" latch was set by ANY damage to the target that turn**
  (`src/state_manager.js`). The move was stamped when merely AIMED, and the latch had no `[from]`
  test, so a Knock Off into a Protect plus the target's burn / weather / hazard tick in the same
  turn read as the move landing; `_resolveKnockOffs` then set the item fact, which drives HARD
  itemless / irremovable-Mega verdicts that prune the pool to itemless / Z / Mega sets for the rest
  of the battle. It now requires a DIRECT hit — the same gate the Ground rule already uses.
- **Two weathers could not double their ability's Speed** (`src/util.js`). `swiftswim` accepted only
  `rain` (missing Primordial Sea's `heavyrain`, legal in this NatDex format) and `slushrush` only
  `snow` (missing NatDex `hail`), while `chlorophyll` already handled both sun spellings. All three
  now compare the weather FAMILY, so no legal weather misses.
- **The receipt's clipboard fallback copied nothing and reported success** (`src/content.js`).
  `execCommand('copy')` acts on the document's CURRENT SELECTION, and the textarea was never
  attached and never selected — so the button put the user's previous selection (or nothing) on the
  clipboard while the HUD claimed success. It now attaches, focuses and selects the field and
  returns the payload only when the copy actually happened; an unavailable `execCommand` is a
  failure, not a silent no-op.
- **`clear()` orphaned the Turn-0 advisory card** (`src/ui_overlay.js`). The bulk selector omitted
  `.st-lead-advisory` and the handle was then reset underneath a node that was still mounted, so a
  new battle mounted a SECOND card and `dismissLeadAdvisory()` could never remove the first. The
  card is now dropped by handle as well as by selector. Same shape: an advisory with a non-empty
  `leads` array whose rows carry no species used to render the empty box its own contract promised
  never to render; it now dismisses.
- **The optional LLM readout could never succeed** (`src/config.js`, `src/background.js`,
  `src/llm_client.js`). A 600 ms budget for a generative round trip, written twice — the config's
  `llm.timeoutMs` and a separate literal in the service worker — with nothing keeping them in
  agreement, and with the caller's own identical deadline racing the worker's abort so the honest
  `'timeout'` always lost to a silent `null`. The budget is now 20 s, the worker reads it off the
  request (one source of truth, with the fallback still bounded for an untrusted message), and the
  caller's backstop carries a 2 s grace so a real answer can land. `tests/config_check.js` asserts
  the two budgets agree by reading both sources.
- **The API key could reach the PAGE'S OWN storage** (`src/llm_client.js`). A content script's
  `localStorage` IS the ladder site's origin storage, and `_storageSet`'s fallback wrote the whole
  config blob — `apiKey` included — there, where any script on play.pokemonshowdown.com can read it.
  The fallback now strips the secret; the `chrome.storage.local` path is unchanged.
- **`sampleWorld` restored `this.database` without `try/finally`** (`src/world_sampler.js`), so a
  throw from `_pick` / `_monFromSet` / `_violationsFor` left the sampler permanently bound to a
  caller's database and every later sample drew from the wrong pool.
- Smaller, same sweep: `immunityReason('Ground', {item: 'Air Balloon'})` reported "Air Balloon / Air
  Balloon" (a duplicated push — the id is already rewritten to the display name the list contains);
  the `|init|` branch reset every per-battle field EXCEPT `lastEvaluateTurn` / `pendingReadout`, so a
  new battle whose turn number collided with the previous battle's last evaluated turn reused the
  stale ranking instead of evaluating (`src/content.js`); and the options page loaded neither
  `lib/species-abilities.js` nor `lib/species-aliases.js`, so its team validation reported "Unknown
  species" for a paste the engine accepts.
- **Four unsound eliminations in the negative-space ability deduction, found by a review sweep.**
  Each one let the pruner drop a candidate set on evidence that does not disprove it, which is the
  single failure mode this tier was built to avoid. All four are pinned by new checks in
  `tests/ability_check.js` (56, up from 40), and each new check was verified to FAIL with its fix
  reverted:
  - **`magmaarmor` was listed as a burn immunity.** It prevents FREEZE only (and was already
    correctly listed under `frz`), so an ordinary burn eliminated every Magma Armor set. Removed
    from `brn`, and `waterbubble` — which genuinely does prevent burns — added.
  - **Any damage in the same turn a Ground move was aimed read as "the Ground move connected".** A
    missed Earthquake followed by a burn tick, sandstorm, Leech Seed, hazard or recoil in that same
    turn eliminated Levitate / Earth Eater. The conclusion now requires a DIRECT hit: the protocol
    marks residual damage with a `[from]` clause, and a direct hit carries none.
  - **The Gravity guard was applied at prune time only.** `groundDisproved` is a permanent latch, so
    a Ground move that connected while Gravity was up (which proves nothing, Gravity negatives
    Levitate) kept eliminating Levitate after Gravity lifted. Gated at the observation too.
  - **A Mold Breaker / Teravolt / Turboblaze attacker was not excluded.** Their Ground move
    connects straight through Levitate, and their Fire move burns a Water Veil holder, so neither
    observation is evidence about the defender. The attacker's ability is now consulted when it is
    KNOWN (documented residual: an unrevealed Mold Breaker attacker is indistinguishable).
  - Same class, same sweep: a status that landed while a **Neutralizing Gas** body was on the field
    no longer disproves Water Veil / Thermal Exchange / Comatose / Purifying Salt. The state manager
    stamps `mon.statusSuppressed` at the instant the status lands (the Gas may be gone by the time
    the pruner reads the state), and `pruner._abilitySuppressed` lost a branch that tested
    `state.field.abilitySuppressed` — a field nothing in `src/` ever wrote, so it could never fire.
- **Turn urgency and the volatility charge were inert whenever the mixed solve did not run**
  (`src/laplace_core.js`). Both per-row deltas were folded into the simultaneous payoff matrix,
  which only the Nash solve reads; `_softmaxConfidence` reads the row SCORE directly, so with
  `laplace.nash.enabled: false` — a documented, supported switch — an adopted, ON-by-default tier
  silently did nothing. Measured before the fix: the committing line's score did not move at all
  (434.4115 -> 434.4115 where +240 was expected). Both deltas now fold into the row score as well;
  there is no double count, because the solve path replaces the score with its own row value, which
  already carries the same delta exactly once. Pinned in `tests/tuning_check.js` (52, up from 48),
  verified to fail with the fix reverted.
- **The arena's `--set` echo is now asserted, not just printed** (`tools/run_arena.js`). The echo is
  produced by the mid-load patch hook, which is keyed on `src/config.js` still being the file its
  manifest entry names; if that ever stopped matching, the run would have reported the SHIPPED
  config wearing a variant's label and exited 0. A short echo is now a setup error (exit 2).
  `engine_bridge.loadHarness` also refuses two ways to reach the same false negative: `setArgs`
  without an `applyPatch`, and a fresh UNPATCHED load while a patch is live (which would un-patch
  every later session in the process). Pinned in `tests/ablation_check.js` (251).
- **The opponent clock kept the previous opponent's rating** (`src/content.js`). `reset()` clears
  the deliberation floor on a new battle but deliberately cannot clear the rating (the constructor
  seeds it from `opts.rating` after calling `reset()`), so the broker clears it alongside the floor.
  Harmless while `clock.ratingBands` ships off; wrong the moment it does not.

### Known — open, from the same review sweep

Findings the sweep confirmed but did NOT close, because closing them soundly needs a change bigger
than the bug. Stated here rather than hidden:

- **`residualOrder.trust` ships at 1** (`src/set_pruner.js`), converting a residual-order bracket
  into a speed fact. The parser requires only adjacency, opposite sides, same turn and "carries a
  clause, not `move:`" — while the pruner's own comment warns that a switch-in, a consumed berry or
  a weather heal can reorder the same block. The narrow fix is to require the bracket's two bodies
  to be the ones the move order already named.
- **Protosynthesis / Quark Drive Speed** was read as a flat 1.5x whenever `boosterActive` was set,
  but the abilities raise the holder's HIGHEST stat — and the protocol states which one
  (`|-start|p2a: X|protosynthesisatk`). That suffix is now parsed onto `mon.boostedStat` (cleared on
  `|-end|` and on switch-in) and `U.paradoxSpeedBoost` applies the multiplier only when the boosted
  stat is Speed, falling back to the set's real highest stat when the protocol has not said; the speed
  layers (VETO4, `trick_room.js`) and the per-set ceiling all use it. **STILL OPEN:** the ceiling does
  not model a sun / Electric-Terrain activation on a set carrying no Booster Energy.
- **`shelter`'s real effect is unverified.** It is out of both wrong lists but deliberately NOT
  added to `SETUP_MOVES`/`SETUP_BOOSTS`: the vendored dex carries no effect data for it, and this
  table's contract is single-correct-value game rules, so guessing a boost would be worse than the
  gap. One-line add once the effect is confirmed (`BOOST_KEYS` already supports `evasion`).
- **G-Max Steelsurge is modelled as a flat 12.5%** in `util.hazardPercent`, while `calc_engine`
  computes it from Steel effectiveness the way Stealth Rock uses Rock — so the two disagree for a
  Rock/Ice body (4x, really 50%) and a Steel/Fairy body (0.25x). This number feeds the Heavy-Duty
  Boots proof, and `state_manager` also gives `steelspikes` two layers when Steelsurge lays one.
- **Two HUDs sharing one document double-handle a bench tap.** `renderBenchTargets` ADOPTS an
  existing strip from the DOM while `_benchBound` is a per-instance flag, so a second HUD adopts the
  first's strip, adds a second delegated listener, and one tap fires both. `bindDrawer` is also the
  one render path that trusts a cached node without a liveness check.
- ~~**`mon.knockOffSurvived` is documented and read but never written** (`ARCHITECTURE.md`,
  `src/set_pruner.js`)~~ **CLOSED** — the dead alternative is dropped, the live field it duplicated is
  `mon.itemKnockedOff`, and that flag is now also withheld for a body that can hold Sticky Hold
  (`_canHoldStickyHold`). See the P5 entry in the Unreleased notes.

### Changed

- **Turn urgency is ADOPTED and on by default** (`laplace.urgency.enabled: true`). It was the only
  one of the four newest tiers to clear the config-flag ablation gate. The measurement, at the
  repo's standard sample: 60 battles per arm across all three league personas on one shared seed
  (`1337`), paired per battle, 2000-resample paired bootstrap on the win indicator (not the
  win/tie/loss score) —

  | arm | W | L | T | win% | Δwin (95% CI) | turns | cap ties |
  |---|---|---|---|---|---|---|---|
  | baseline | 41 | 2 | 17 | 68.3% | — | 54.4 | 17/60 |
  | turn urgency (ON) | 58 | 1 | 1 | 96.7% | **+28.3 [+18.3, +40.0]** | 49.9 | **1/60** |

  The 17 baseline cap ties were EVERY tie it played, and urgency converted 16 of them into wins;
  p90 game length fell 101 → 89. It is the tier the 100-turn standoff was waiting for. The other
  three measured flat and STAY OFF — see below for why each flat row means something different.
- **The ablation runner's `--set` now reaches LOAD-TIME readers, not only construction-time ones.**
  `src/set_pruner.js` reads its `pruner.*` tunables into module constants while it is EVALUATED, so
  a config patch applied after the harness was loaded updated the config object and left those
  constants stale. Any pruner row in the table (`damageEvidence`, `residualOrder`, `scout`,
  `abilityDeduction.*`) would have measured as a perfectly flat, confidently reported **false
  negative**. `loadHarness` now takes the patch and applies it the moment `src/config.js` has run
  (`tests/harness.js` grew an `afterEach` hook for it). Pinned by a new section in
  `tests/ablation_check.js` that drives the real pruner both ways — it asserts the load-time rule
  FIRES, and that the same patch applied only after the load does NOT, so the ordering is the thing
  under test rather than a default.
- **The four newest tiers are registered in the feature table** (`absence-rules`, `elo-band`,
  `urgency`, `comeback`), each carrying what its flat row means where that is known. Measured over
  the same 60-battle corpus with the merge above in place:
  - **`absence-rules` — FIRES, but moves no ranking here.** Counted directly: 624 pruner calls over
    12 battles with the flag on, 176 of them striking an ability for a silent switch-in (1,584
    ability bans). So its flat row is the second of the two cases, "the input arrives and never
    changes a ranking" — not "the input never arrived". Narrowing the opponent model only moves a
    decision when the discarded set would have won the ranking, which against three curated personas
    it never does. Unresolved for adoption, not disproved.
  - **`elo-band` — not measurable in this harness.** The band needs the ladder rating, which the
    protocol only carries on `|player|p2|Name|avatar|1480`. `tools/headless_arena/sim_runner.js`
    creates both players without a `rating` option, so @pkmn/sim emits
    `|player|p2|Adversary||` (verified against the sim), `state.opponentRating` stays null, and
    `OpponentClock.ratingFactor()` returns the identity by design.
  - **`comeback` — unpriceable in this harness, same cause as `volatility`** *(since fixed: the
    bridge supplies the accuracy frame and the charge is live, though it still flips no line against
    these movepools — see the Unreleased entry and ATTEMPTS.md D4)*. It scales only the
    volatility charge, and `_volatilityDelta` returns a zero penalty before it reaches that scale
    when `state.moveAccuracy` is empty — which it always is in the arena, because only
    `src/injected.js` populates it from the client's own `|stacc|` snapshot.
  - **`urgency` — the adoption above.**
- `tests/tuning_check.js` now pins turn urgency's ADOPTED default and drives the identity through
  an explicit constructor override (48 checks, up from 45); the README's suite list and counts were
  updated with it.

### Added

- **The pivot tax — a switch-row policy drag, built to act on the benchmark's own finding, and
  REJECTED by the win-rate gate** (`laplace.switchTax`, `LaplaceEngine._switchTaxDelta`). The
  benchmark says that on the CONTESTED turns the engine's top line is a switch **55.4%** of the time
  where the 1,830-rated humans it is compared with switched **33.8%**, and that on the 4,349 turns the
  human clicked a MOVE its top line was still a pivot **39.0%** of the time even with a full 4-attack
  menu. The *preference* is wrong; what was NOT established is why. Three things had to be settled
  before anything was written, and every number below was re-derived from the run's own `--out`
  records after an earlier draft of this entry quoted figures no artifact carried:
  - **The over-pivoting is not a harness artefact.** A replay forces the engine's attack menu to be
    rebuilt, so a starved menu could make a switch the only comparison left. Counted directly: on
    turns the human clicked a MOVE the engine's top line was a pivot **48.1%** of the time with 0-1
    attacks to compare with, **49.2%** on 2-3, and **39.0%** even with a FULL 4-attack menu — against
    a human switch rate of **26.3%**. Starvation visibly inflates the figure (48 -> 39); it does not
    explain it away. Real behaviour.
  - **The ranking already contains the right answer, which is what makes it a PREFERENCE bug.** On
    the 2,053 turns where the engine's top-1 was a pivot while the human clicked a move, its own best
    NON-pivot line WAS that human's click **55.8%** of the time. A policy that never pivoted while it
    held an attack would score top-1 **61.3% on move clicks** (and **45.2% overall**) instead of
    35.0%/31.7%. So the ceiling a pivot fix could reach is exactly the 45-50% band this investigation
    was chasing — and it is reachable by surfacing the line the engine already ranked, not by
    penalising every switch.
  - **It is not `quiescence.extendSetup`.** The plausible story was that pricing their boosted reply
    as a certainty makes "stay in and attack" look worse than it is. Measured with the benchmark's
    new `--set`: `extendSetup=false` moves the pivot rate the WRONG way, **53.1% -> 54.2%**, and moves
    top-1 by **221 gained / 242 lost — a paired net of -21**. Refuted.
  - **It is not VETO4 (`SPEED_SUICIDE`).** The benchmark showed 106 of 177 refusals of elite clicks
    were that one code, and because the veto hard-bans attacking it *mechanically* forces a switch.
    Measured with the benchmark's new `--veto-off`: suppressing it leaves the pivot rate essentially
    where it was, **53.1% -> 53.7%**, and moves top-1 by **199 gained / 221 lost — a paired net of
    -22**. Also refuted. Both rules are left exactly as they were.
  - **The trap that made the gate mandatory.** Agreement cannot be the adoption criterion, and this
    run is the proof rather than an argument: the tax raised agreement by **12.3 points** and cost
    **26.7 win points**. A benchmark measurement is a reason to open a row in the feature table,
    never a reason to change the shipped config.
  The tier itself is a flat score drag on every SWITCH row (a pivot must beat the best attack by
  `points` before it takes the top line), folded into the mix matrix *and* the row score, the same two
  places `urgency` and `volatility` fold into, and exactly `0` for every row while the flag is off —
  the shipped build is byte-identical. It does what it was built to do: at 120 points the pivot rate
  falls to **29.2%** (the humans: 33.8%, so it now UNDER-pivots) and top-1 agreement climbs **31.7% ->
  44.0%** (contested **25.5% -> 31.9%**). But the climb is a COMPOSITION effect and not better pivot
  judgement: the MOVE half rises **35.0% -> 53.8%** while the SWITCH half gets WORSE, **22.5% ->
  16.5%** — the tax stopped the engine pivoting without teaching it which pivot to make, so it
  measurably damaged the very half it was built to fix. Unlike the tax, the headroom above is
  reachable: 55.8% of those suppressed pivots were sitting on the human's click one row down. Then the gate ran: **60 paired battles, all
  three personas, one seed, `--mode full` -> win rate 96.7% -> 70.0%, delta -26.7 points, 95% CI
  [-38.3, -15.0]**, and the 100-turn cap ties come BACK **1/60 -> 18/60** (a 30% stall share, capped
  games losing only 4.1 of 12 bodies). It re-creates the exact pathology turn urgency was adopted to
  remove, so the tier ships OFF and its row stays in the feature table. The
  earlier positive sign it had rested on **30 CRUCIBLE battles** (66.7% -> 80.0%) — and crucible mode,
  the default of `tools/run_arena.js`, splices a recorded human line in at turn 8+, which the ablation
  runner itself refuses as "not comparable across variants". Re-run afterwards at that exact
  configuration to confirm the diagnosis rather than assert it (mode `crucible`, 30 battles, seed
  1337), the baseline reproduces **20/0/10 = 66.7%** exactly, with every one of those ties belonging
  to the anti-setup exploiter: 0 wins, 10 draws, p90 101 turns. The comparison was made entirely
  inside a mode whose baseline ties are the exploiter's Protect loop rather than the engine's own
  reluctance to commit, so the "improvement" measured was 5 of another agent's stalls. A
  small-sample sign in a non-comparable mode is not a result, and the gate is what caught it.
- **Two instruments on the benchmark, so a policy change can be priced before it is adopted**
  (`tools/benchmark_human_match.js`). `--set <dotted.path>=<value>` (repeatable) patches a
  `src/config.js` tunable for the whole run, and `--veto-off <CODE>` suppresses one veto rule, to
  measure what that rule costs; both make the run NOT the shipped build and the report says so. The
  `--set` path is built as a DEEP patch, because `configMerge` merges one level only and a nested
  patch would silently destroy the sibling keys it did not name. It refuses a path `config.js` does
  not define, and it READS THE VALUE BACK after merging, because the first version built the patch and
  never applied it — which the control caught rather than the feature: `nash.enabled=false` must move
  rankings and moved **0** records. A patch that cannot be shown to have landed must not be
  measurable, and `tests/human_match_check.js` pins the read-back.
- **`tools/benchmark_human_match.js` — the Human-Move-Match (policy fidelity) benchmark, and the
  honest version of it.** Every turn of a replay is a decision a real human made, with their rating
  attached, so `--input elite.json --battles 100` answers the one question win-prediction AUC cannot:
  how often is the engine's top line the line an elite human actually clicked? It reports top-1 and
  top-2 agreement overall, on the contested subset (the engine had two or more alternative lines of
  the same kind as the click), move-vs-move, and on the revealed-moveset subset; a turn-bucket
  breakdown (1-5 / 6-15 / 16+); every turn it could NOT score, by reason; a Wilson interval on every
  rate; the veto code behind every line the deterministic guard refused; and the uniform-over-menu
  floor the top-1 rate has to beat, because a rate in the twenties means nothing on its own.
  Measured on 100 battles of the 1,799-1,992 slice (mean 1,830): **top-1 31.7%, top-2 53.2%** over
  5,903 decisions; top-1 25.5% on the contested subset against a 16.6% uniform-pick floor (1.53x
  chance). Splitting it by action kind is what makes it readable, and it INVERTED the expectation
  that motivated the split: the engine matches elite humans on **attacks 35.0% of the time** (top-2
  59.0%, 1.94x the floor) and on **switches only 22.5%** (top-2 36.9%, 1.29x the floor) — and it is
  the SWITCH half that is measured fairly, because the bench menu is complete, while the attack half
  is a lower bound (36.1% of clicks were moves the log had not revealed yet). So the pivot half is
  the weak half, and the engine leans on it anyway: its top-1 is a switch 55.4% of the time against
  the humans' 33.8%. The tool refuses to call any of that a rating — the band table is printed as an
  UNCALIBRATED heuristic and the report explicitly warns against averaging the two halves into one
  number. The other number worth carrying: **3.0% of elite clicks were on a line the deterministic
  guard VETOES**, and 106 of those 177 refusals were `SPEED_SUICIDE`.
  Three things had to be got right before any of those numbers meant anything, and the first version
  of the tool got two of them wrong, visibly: a replay carries no `|request|`, so (a) its clicks are
  INFERRED from `|move|`/`|switch|` results — a `[from]`-tagged move the player never chose, a forced
  replacement after a `|faint|`, and a pivot move's own `[from] U-turn` switch must all be told apart
  (this alone was 12% of the corpus thrown away as "ambiguous", now 0.1%, with the forced switches
  counted separately); (b) the engine's attack menu is rebuilt per decision and the clicked move
  added to it — and it has to stay added DURING `evaluateTurn`, which the first version got wrong by
  restoring before the call, so every first-use move was scored against a menu that could not contain
  it; and (c) `state.mySide` is written only by a `|request|` line, so without setting it a "p2" pass
  silently built p1's team and scored p2's clicks against p1's bodies — which reads as a low score
  rather than as a bug, and made every p2 switch unscoreable. All three are pinned by
  `tests/human_match_check.js` (132 checks), including the purity probe the benchmark relies on
  (`evaluateTurn` twice on an unchanged board must give the same ranking, or the measurement is
  measuring its own nondeterminism).
- **The HUD works on a desktop viewport, and there is a button that switches.** The whole overlay was
  designed for one screen size — a 411×891 portrait phone — and on a desktop it was wrong in the way
  that matters: the bottom band is `position: fixed` and full-width, so at 1920 px it was a 1920 px
  strip laid over Showdown's battle log, which is not a control that can be lifted away. Measured on
  both live clients at 1920×1080, 1440×900 and 1280×800 (`Documents/ST-UI-review/probe-desktop.js`),
  Showdown's desktop layout is the same on both: the battle arena is a **fixed 640 px-wide column at
  x=0** and the scrollable log starts at x=640, so the only viewport the HUD can own is
  **x 0..640, and only below the move bar** (`.battle-controls` sits at `position: absolute;
  top: 370px`, i.e. y 426..531 of the arena column — its position is client-specific and had to be
  measured, not assumed, as the mobile lift already proved).

  `hud.layoutMode` (`'auto'` | `'mobile'` | `'desktop'`, default `'auto'`) resolves against
  `hud.layoutBreakpoint` (1024): `auto` picks by `innerWidth`, the explicit modes always win. The
  resolution is published as `data-st-layout` on `documentElement` and every desktop rule in
  `styles/overlay.css` is scoped to it, so a lobby, the options page and the test harness keep the
  viewport-top mobile layout byte for byte — the attribute is only ever set by the overlay itself.
  In desktop mode the five band elements (TR chip, bench strip, PP gauge, format sentinel, receipt)
  are re-parented into ONE scrollable `.st-console` flex column docked at `left: 8px; top: 58px+
  width: 624px`, which is measured live at 8..632 × 513..1072 — inside the arena column, under the
  move bar, and clear of the log by 8 px of margin. The banner, overlord pill, badge row and drawer
  re-anchor to the same column. On mobile the elements go back to `<body>` as `position: fixed`
  nodes and the console is removed. Re-parenting is idempotent and `_reparentOutOfConsole` snapshots
  the child list before moving, so a node that is never re-parented is simply skipped rather than
  throwing on a detached/live list.

  Two traps this hit, both recorded because both were caught by a test rather than by eye:
  - **The band elements did not exist yet when the layout was first applied.** The constructor runs
    before any render call, so `_reparentIntoConsole` found nothing to move and every band element
    then mounted full-width into `<body>`, back over the log. `_mountBand()` now routes band
    CREATION to the console when `resolvedLayout === 'desktop'`, and is used by every
    `_ensureChip` / `renderBenchTargets` / `renderPPGauge` / `renderFormatSentinel` /
    `renderReceipt` path — so a band created in turn 40 lands in the console too, not just one that
    happened to exist at construction. 6 of the 6 new checks fail with it removed.
  - **The mode toggle must not be mounted from the layout switch.** It was, and that broke
    `tests/dom_check.js` ...and leaves no textarea behind in the document, because merely CONSTRUCTING
    a HUD put a clickable button in the page. It is now mounted only from `bindDrawer()` — the "this
    HUD is live in this tab" signal — on both the fresh and the adopt-an-existing-drawer exits.

  The switch is an in-page `.st-mode-toggle` pill next to the TAC button (emoji + label, relabelled
  on every resolution) whose click calls `toggleLayoutMode()`; a capture-phase listener on the same
  button blurs it immediately after activation, so a HUD button can never end up holding keyboard
  focus — measured live, `activeElement` is `BODY` after the click. The choice is persisted in BOTH
  the page's `localStorage` (`stHudLayout`, read synchronously at construction so a page restored by
    the browser has the right layout before the first paint) and `chrome.storage.local` for the
  options page, with a `chrome.storage.onChanged` listener mirroring a change made in ANOTHER tab
  into this one. The options page has a matching radio (`hudLayout`, auto / mobile / desktop).

  Verified: `Documents/ST-UI-review/verify-desktop.js` on the live new client at 1920×1080 — auto
  resolves to desktop, all five band elements inside the 624 px console, **`psOverlaps: []`**,
  forced-mobile at 1920 still renders the phone layout (it may then cover PS, which is what asking
  for the phone layout on a desktop means), the toggle flips both directions, focus stays on `BODY`.
  Resize re-resolves `auto` both ways (412→mobile, 1280→desktop, 900→mobile, 1920→desktop) with the
  injected files and with the real extension. The mobile layout itself is UNCHANGED — `probe-mock-geom`
  still measures lift 300 px / 4 px clear / a tap-transparent strip on the new mock and lift 0 px /
  240 px clear on classic. e2e is 43/43, `tests/dom_check.js` is 77/77.

- **Negative-space ability deduction in the pruner** (`src/set_pruner.js`, rule tables in
  `src/util.js`). The pruner narrowed the opponent's candidate sets by ITEM and MOVE; abilities were
  only ever read the other way (a revealed ability disproved the sets naming a different one). Two
  rules now run in the opposite direction, both on POSITIVE evidence: a status a body is CARRYING
  disproves every candidate whose ability makes that status impossible
  (`U.STATUS_IMMUNITY_ABILITIES`), and damage only a GROUNDED body can take — a connecting Ground
  move, or Spikes / Sticky Web, but never Stealth Rock — disproves Levitate / Earth Eater, with the
  Gravity guard that observation actually needs (Gravity grounds everyone, so there it proves
  nothing). A third family, ABSENCE of evidence (a switch-in Intimidate or weather/terrain surge
  that never fired), is implemented but ships OFF (`pruner.abilityDeduction.absenceRules`), because
  Neutralizing Gas and friends can silence the announcement and this repo does not eliminate on a
  guess. Each family is switchable on its own; the suite drives real protocol lines and pins both
  the eliminations and the documented fallback when every candidate is disproved.
- **The opponent's ladder rating is carried on the state** (`|player|p2|Name|avatar|1480`), and the
  clock can band its single switch-reply factor by it (`clock.ratingBands`). The band ships OFF:
  the factors are priors, not measurements.
- **Comeback mode and turn urgency** (`laplace.comeback`, `laplace.urgency`), both shipping OFF.
  Comeback mode scales the EXISTING volatility charge by where the evaluator puts the board
  (sharpened when ahead, softened when behind). It deliberately does NOT touch
  `laplace.temperature`: with `nash.enabled` the default, temperature governs only the legacy
  softmax path, so lowering it would change nothing about the ranked line. Turn urgency adds a
  bounded, ramping preference for COMMITTING lines over PASSIVE ones past turn 25, multiplied at
  the breakout turn — it re-ranks rows and can never override a veto or a game rule (a Protect
  still blocks the attack; what changes is which row the engine prefers as the clock runs out).
- **The Turn-0 lead advisory** (`src/laplace_core.js` `leadAdvisory`, wired at `|teampreview|` in
  `src/content.js`, card in `src/ui_overlay.js`). `|teampreview|` stays inert to the parser
  (`parser_fuzz` pins that contract), so the broker hangs off the raw command instead. Each of our
  six bodies is scored against every opposing body through the SAME leaf evaluator the in-battle
  decisions use, and the card shows the best and the riskiest lead. It is a MEASUREMENT, not a
  heuristic, so it ships ON (`hud.leadAdvisory.enabled`).
- **Three new suites** — `tests/ability_check.js`, `tests/tuning_check.js` and
  `tests/preview_check.js` — registered in `tests/run_all.js` and documented in the README list. Each
  has grown since it was added and the entries above record why, so the README list (not this bullet)
  is the place to read their current check counts.
  The 36-matchup lead advisory measures at ~1.6 ms on the development machine (50 runs).

- **The config-flag ablation runner** (`tools/run_ablation.js`, `npm run ablation`), plus the
  `--set` config patch it is built on (`tools/run_arena.js`). The arena reports one win rate for the
  whole engine; it cannot say **which** of the things deciding a move is doing the work, and every
  tier in `src/config.js` ships gated — the mixed Nash solve can fall back to the legacy
  single-line softmax, five board-state vetoes can each be switched off, and the optional tiers
  ship inert. The runner spawns the arena once per variant (baseline + one batch per feature,
  500 battles each by default, `--parallel` to make that bearable), and prints W/L/T and win/loss/
  tie %, average turns with the stall-tie share, the delta against the baseline, and a verdict.
- **`--set <dotted.path>=<value>`** (repeatable) patches one `config.js` tunable for a whole arena
  run, and the run's report carries an `appliedSets` echo of `[path, from, to]`. Three properties
  are contractual and pinned in the new suite: the patch must name a path that ALREADY exists (an
  unknown leaf or section is a setup error, never a new key — a benchmark that measures a typo and
  reports it as "neutral" is the worst possible outcome, because the number is plausible and the
  conclusion drawn from it is wrong); the patch lands before the first `EngineSession` is built,
  because a session resolves its tunables at construction (`laplace_core`'s `nash`/`volatility`/
  `quiescence`, `opponent_clock`'s `enabled`), so one variant per process is the only honest
  arrangement; and applying the same patch twice reports the same `from`/`to`, which the ablation's
  echo check depends on.
- **`tests/ablation_check.js`** — 241 checks when written (264 after the client-frame work above).
  It does not stop at `configGet`: after each patch it
  builds a real `LaplaceEngine` and asserts the ENGINE changed, per flag, because a patch that only
  moved the config object would make every variant a baseline-vs-baseline comparison reported as
  "these features do nothing". It also pins every declared patch to a real FLIP of its leaf (a
  feature table row that sets a flag to the value it already holds measures nothing, so a stale row
  fails loudly), the four veto fixtures end to end, the aggregation and bootstrap maths, the
  verdict buckets, and one tiny live batch through the CLI. It skips only the live batch when
  `@pkmn/sim` is absent, so `npm test` stays install-free for every other suite.
- **A verdict is about significance, not sign.** At 500 battles the standard error of a win rate is
  ~2 points, so the runner reports the delta with a 95% **paired** bootstrap over battles — the
  same test the residual head was rejected with — and calls a feature `helps`/`hurts` only when the
  interval excludes zero. Everything else is reported as *no measurable effect at this sample
  size*, which is deliberately not a synonym for neutral. Pairing is re-derived from the records'
  own `seed` fields (`verifyPairing`) rather than trusted, and a drifted pairing falls back to an
  unpaired resample flagged `unpaired`, rather than reporting a paired interval it did not earn.
- **`identical`, the flag that stops a flat row being read as a finding.** When a variant
  reproduces the baseline in EVERY battle — same winner, same turn count, 60 battles a side — the
  row is flagged and the run prints a footnote saying to check the flag's INPUT before concluding
  anything about the feature. The first sweep produced exactly one such row, and it is a real
  defect in the harness rather than a verdict on the tier: **the volatility charge is
  unpriceable in the arena.** *(Since fixed: the bridge forwards `|stacc|` from the sim's dex. See
  the Unreleased entry.)* `_accuracyOf` reads `state.moveAccuracy`, which only
  `src/injected.js` populates from the client's own `|stacc|` snapshot, and `@pkmn/sim` emits no
  such line — so the penalty is always 0 and toggling `laplace.volatility.enabled` cannot change a
  single decision. Measured: the variant reproduced the baseline battle for battle (41/2/17 wins,
  54.4 turns per side, identical). All three steps (no telemetry → 0, telemetry present → -30 for a
  70% move at `accuracyWeight` 1, `enabled: false` → 0) are pinned in the suite, and the feature
  row carries the caveat. **The clock prior is inert in the arena for a second, verified reason:**
  `OpponentClock._close()` returns early unless `mySubmitTs` is set, and that is set only by an
  OUTGOING `/choose` line (kind `send`) — the arena's agent answers the sim runner directly, so the
  boot never sees one. The history stays empty, the label stays `unknown`, and
  `clock.switchPrior.unknown` of 1.0 is exactly what `clock.enabled = false` does. Measured the same
  way (battle-for-battle reproduction) and pinned with the clock's own probe, since a hypothesis
  that matched the observed flatness was written first and then falsified by reading the code.
- **Two more flat rows are reported as UNRESOLVED rather than explained away.** Reverse damage
  evidence and residual speed order also reproduced the baseline exactly, and no cause is
  established. Both narrow the opponent MODEL, and a narrower model only changes a decision when it
  removes a candidate that would otherwise have won the ranking — which may simply not happen
  against three curated personas. Their rows carry a caveat saying so, because the honest reading of
  a flat row is "unresolved at this sample", not "neutral".

- **The headless adversarial league arena** (`tools/run_arena.js`, `tools/headless_arena/`,
  `npm run arena`). A second execution path that runs the engine against the real `@pkmn/sim` battle
  engine instead of protocol lines this repository typed by hand — the one thing `tests/` can never
  do is surprise the deduction. Four mechanisms: **an adversarial league** of three personas (a meta
  anchor on curated samples, an anti-Trick-Room clock staller that banks the 5-turn timer on
  Protect/Bunker and immunity loops, and an ε-greedy low-ladder chaos agent, ε = 0.15); **crucible
  splicing**, which fast-forwards a real replay to its highest-leverage volatile turn (a faint, a
  hazard or screen going up, a >50% HP swing), hands both sides to the live agents there, and
  reports the fidelity of that handover rather than assuming it; **adversarial set mutation**
  (off-meta item swaps, Speed-EV creep, coverage injection — each mutation applied, validated
  through the sim's own `TeamValidator`, and rolled back when illegal); and the **blunder
  harvester**, which finds the turn whose evaluation suffered the largest negative drop and
  synthesizes a regression puzzle from it. `engine_bridge.js` is the only route from arena code into
  engine code, and it loads the shipped scripts through `tests/harness.js`, so the arena drives the
  program that ships rather than a copy. Zero custom math anywhere in `tools/`: the sim resolves the
  battle and owns legality, the engine only picks.
- **The format is `gen9nationaldex`, which IS [Gen 9] National Dex OU** — it carries the NatDex OU
  banlist, with the lower ND tiers deriving from it. `gen9nationaldexou` (what the brief asked for)
  does not exist in the sim: `Dex.formats.get` hands back a Condition for it, not a Format, so a
  driver asking for that id plays nothing while looking like it worked.
- **`tests/tactical_puzzles.js`** — the harvested-vaccine registry *and* its runner. A puzzle
  replays its raw protocol prefix through the real parser → state manager → engine pipeline and
  asserts the engine did not rank the losing line first while a viable alternative is available. It
  ships with zero puzzles, and a harvested vaccine is **red on purpose**: the engine is
  deterministic, so replaying the prefix reproduces the ranking that lost, and the puzzle turns green
  only when the underlying defect is actually fixed. Both call shapes from the brief work:
  `generatePuzzleCode(analysis)` for the scanned path, and the terse
  `generatePuzzleCode(blunderTurnNumber, matchReport)`, which derives the prefix, the line it played
  and the alternatives from the report's own log — a switch is pinned by species name, which is what
  the engine's ranking prints for one.
- **`tests/arena_check.js`** — 125 checks over the arena: the runner's report shape, a splice that
  hands over without desync, every persona choosing a legal action on every decision frame, mutation
  that never produces illegal stats, and generated puzzle code that is syntactically valid. It skips
  with a plain message when `@pkmn/sim` is absent, so `npm test` stays install-free for every other
  suite.
- **`npm run arena` and an `arena` CI job.** The job installs the devDependencies, runs the suite,
  and drives two seeded full games plus one crucible splice through the CLI, so the orchestrator, the
  personas, the replay fast-forward and the report renderer are exercised end to end. Both runs are
  seeded, and losses are data rather than failures: the CLI exits 0 for a win, a loss and a tie
  alike, so it is safe to gate a build on.
- **A real-browser end-to-end suite** (`tests/e2e/`, `playwright.config.js`, `npm run e2e`). 41
  Playwright tests that load the actual MV3 extension into Chromium and drive a page: boot and
  manifest integrity, HUD rendering and veto placement, session lifecycle, robustness against
  missing/garbage DOM, hardening (the phone viewport, a 2,001-line log, a late team, storage yanked
  mid-battle), a **real WebSocket** via `page.routeWebSocket`, and the options page. The page is a
  fixture served by **intercepting the real hostname**, because the hostname is what the content
  script matches on. The key constraint is documented in `tests/e2e/helpers.js`: a content script
  lives in an isolated world, so `page.evaluate` cannot see `window.ST` — every assertion is shared
  DOM, the MAIN-world bridge, or the console stream.
- **`tests/dom_check.js`** — the HUD's DOM lifecycle against a stub that can actually find its own
  buttons (the existing `hud_check.js` stub returns nothing from `querySelector*`, which is why every
  button-level check there stubs `_findMoveButtons` and why `_decorateButton` had never once run
  against a document). 35 checks.
- **`tests/hardening_audit.js` §12** — a second `|init|` must start a clean battle.
- **A new `e2e` CI job**, separate from `test` so the slow browser gate never blocks the fast one.
  The launch helper adds `--no-sandbox` only when `CI` is set.
- **`npm run e2e` / `npm run e2e:headed`**, and `test-results/`, `playwright-report/`, `blob-report/`
  in `.gitignore`.

### Measured (the first ablation sweep)

`node tools/run_ablation.js --battles 60 --parallel 6 --seed 1337` — **19 batches, 1,140 battles,
21 min 51 s**, one patch per batch on a shared seed so every variant played byte-identical games to
the baseline. The sweep is deterministic: two complete runs produced identical W/L/T and turn counts
for all nineteen rows, and a third run, interrupted deliberately after six batches, matched those six
as well. Five of the nineteen rows did not land on the baseline:

| variant | W | L | T | win% | Δwin (95% CI) | turns | Δturns | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 41 | 2 | 17 | 68.3% | — | 54.4 | — | reference |
| quiescence OFF | 50 | 2 | 8 | 83.3% | **+15.0 [+3.3, +25.0]** | 45.4 | −9.0 | **feature HURTS** |
| nash OFF | 46 | 0 | 14 | 76.7% | +8.3 [−1.7, +18.4] | 44.4 | −10.0 | no measurable effect |
| profile ON | 39 | 2 | 19 | 65.0% | −3.3 [−10.0, +3.3] | 54.1 | −0.3 | no measurable effect |
| the other 15 rows | 41 | 2 | 17 | 68.3% | 0.0 | 54.4 | 0.0 | flagged `identical` |

- **The one significant finding is that the quiescence tier is hurting the engine in the arena.**
  Removing it wins **+15.0 points** with the 95% interval entirely above zero, converts a quarter of
  the ties into wins (28.3% → 13.3%) and shortens games by nine turns. It was the author's
  expectation that the tier `helps`, so the row is flagged `surprise` — which is exactly what the
  `expect` field exists for. This is a measurement against three fixed personas, not a verdict on
  the tier's idea; the honest next step is the 500-battle sweep, not a config edit.
- **`nash` is not significant at this sample.** Removing the mixed solve is worth +8.3 points and
  it removed the baseline's two losses outright, but 60 battles puts the standard error near 6
  points, so the interval [−1.7, +18.4] straddles zero and the runner says so instead of calling it
  an improvement. `profile` is the mirror image: −3.3, interval straddling zero.
- **The baseline draws a quarter of its games at the turn cap — and that is true of every row.**
  **17 of the 60 baseline battles (28.3%) ended tied at the 100-turn cap, and every tie any row
  played was a cap tie**: not one row produced a genuine draw. No variant tripped the `stall` flag,
  because that flag is a DELTA and none of them made stalling *worse* — and the first reading of this
  sweep took "no stall flag" to mean "no stalling", which the numbers refute. So the runner now
  prints the absolute baseline level on its own line (and the suite pins that it does, including the
  wording that warns against exactly this misreading). This also sharpens the quiescence result:
  switching the tier off converted nine of those cap ties into **wins** (ties 28.3% → 13.3%, wins
  41 → 50) and cut games by nine turns, so the tier is not merely losing games, it is failing to
  close them out.
- **15 of the 19 rows reproduced the baseline in every single battle**, and that is a finding about
  the benchmark's power as much as about the features. Three causes, kept apart on purpose: two
  are **verified harness gaps** (`laplace.volatility` needs the `|stacc|` snapshot, `clock` needs an
  outgoing `/choose` — see the Added entry above; both are pinned in the suite); two are
  **documented controls** (`pruner.scout`, `usage` ship with empty overlays, so flat is the expected
  result and a delta there would be the bug); the rest are **unresolved** and carry a caveat saying
  so rather than a plausible-sounding story.
- **Two bugs in the instrument were found by reading its own output, and both are fixed and pinned.**
  The first sweep printed `quiescence OFF: Δwin +15.0, 95% CI [+1.7, +12.5]` — a point estimate
  outside its own interval, because the delta was a win-rate difference while the bootstrap resampled
  the win/tie/loss SCORE. The interval is now bootstrapped on the win indicator that the delta is
  computed from, and the suite pins the two scales apart with a case where they disagree (win scale
  −0.5, score scale 0). The second was framing: the verdict was the VARIANT's direction printed under
  the FEATURE's name, so `quiescence (off) → helps` read as "quiescence helps" when the measurement
  says the opposite. Every row now declares which way its patch points and reports what the FEATURE
  does (`feature HURTS (switching it off +15.0)`), with a `surprise` flag when the result contradicts
  the recorded expectation.
- **Scale note.** The brief asks for 500 battles per variant; that is now `--battles 500` on the
  same command and it is the number to quote. 60 is what fit here, and its ~6-point standard error
  is why only a +15.0 effect cleared its interval — the sweep's low power is itself reported, not
  hidden behind a table of zeros.

### Measured (isolating the quiescence result)

The first sweep left one significant finding and one epidemic, so the next run did nothing but split
them. `node tools/run_ablation.js --features quiescence,quiescence-extendsetup,quiescence-blockprotect
--battles 150 --parallel 4 --seed 1337` — 4 batches, 600 battles, **18 min 33 s**:

| variant | W | L | T | win% | Δwin (95% CI) | turns | capped | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 100 | 4 | 46 | 66.7% | — | 52.1 | 46/150 | reference |
| `quiescence.enabled = false` | 129 | 6 | 15 | 86.0% | **+19.3 [+12.0, +26.7]** | 41.7 | 15/150 | feature HURTS |
| `quiescence.extendSetup = false` | 129 | 6 | 15 | 86.0% | **+19.3 [+12.0, +26.7]** | 41.7 | 15/150 | feature HURTS |
| `quiescence.blockProtect = false` | 100 | 4 | 46 | 66.7% | 0.0 [0.0, 0.0] | 52.1 | 46/150 | FLAT (`identical`) |

- **The entire harm is the setup ply.** Switching `extendSetup` off reproduces switching the whole
  tier off *battle for battle* — same 129/6/15, same 41.7 average turns, same interval. The tier was
  split into two knobs precisely so this could be asked, and the answer is that the Protect half is
  not implicated at all.
- **`blockProtect` is inert in this corpus and is NOT dead code.** `tests/quiescence_check.js`
  proves the shield blocks our move inside the cell and that `blockProtect: false` reproduces the
  legacy 1-ply number exactly, so the knob works and their Protect does reach it. It changed no
  decision in 150 battles because their shield never landed on a cell where the block flipped the
  choice. That row is flagged `identical`, and the runner's footnote now offers both possible causes
  instead of diagnosing one — an earlier wording asserted "the input never arrived", which this row
  disproves. Naming the wrong cause is how a flat row becomes a false finding.
- **The epidemic is a standoff, and the setup ply is what causes it.** The baseline capped **46 of
  150 games (30.7%)**, and those capped games had lost only **5.4 of the 12 bodies** — two walls
  staring at each other, not a resolved game. Disabling the setup ply cuts the cap rate to **15 of
  150 (10.0%)**, turns 29 of those 46 draws into **wins**, and shortens the average game by 10.4
  turns. The reading that fits every number: pricing their boosted reply as a certainty pushes the
  engine onto non-committal lines that cannot close a game out. It does not merely lose games, it
  declines to win them.
- **The 150-battle run agrees with and sharpens the 60-battle one** (+15.0 → +19.3 on the same seed
  and corpus, with the interval moving further from zero), which is what a real effect does when the
  sample quadruples and what a fluke would not.
- **Nothing was changed on the strength of this.** The tier was adopted because it fixes specific
  mis-priced lines, and `tests/quiescence_check.js` still pins every one of them; this measurement
  says it costs more than it buys *against three fixed personas*, which is a different claim from
  "it is wrong". The decision needs the 500-battle sweep (and a look at whether it is the extension's
  GUARDS that should tighten rather than the tier that should go), so the finding ships as evidence
  with its exact numbers and interval, not as a config edit.
- New tooling the isolation needed, all pinned in `tests/ablation_check.js`: a row per sub-knob
  (`parent` marks the family, so a multi-decision tier can be split without inventing a new tool),
  and the **turn shape** — p50/p90/max turns, the count of games that reached the cap, and the
  faints a capped game actually had, shown as `-> STANDOFF` or `-> grind`. A mean of 52 turns hid a
  30% draw rate completely; the shape is what made the epidemic visible enough to be worth this run.

### Changed

- **The move-dex lookup was 52% of a turn; it is now a cache.** A CPU profile of one real turn put
  `getMoveData`, `toID` and `toID`'s own RegExp at **52% of the whole decision**, and the cause was a
  combination rather than one bug. `moveCache[id] = null` recorded a miss that the `if
  (moveCache[id])` hit test then read as "not cached", so any name the vendored table does not have
  re-ran the fallback — every key of `RAW_MOVES`, with a `toID` per key. Measured: **~240 us** for a
  missing name against **0.28 us** for a present one, and `_payoff` was handing it a species, because
  a switch action's `name` IS a species: 216 such calls in a single real turn. Three changes, all
  behaviour-preserving: `toID` is memoised (a `Map`, capped, cleared rather than growing), `getMoveData`
  remembers misses and answers from an id→raw index instead of scanning, and `_payoff` no longer
  asks the move dex about a switch. Verified bit-identical — every ranking, every score at 17
  significant digits, every veto flag — across 30 real turns plus 360 seeded perturbations of them
  (390 boards, 432 `_payoff` cells each, matrix untouched), and A/B'd alternately on one machine so
  thermal drift could not land on one side: real boards **96.3 → 30.7 ms mean, 132.7 → 47.5 ms p95**,
  worst case **112.6 → 41.9 ms mean**, and the projected Galaxy S24 FE figure **141.6 → 50.7 ms**.
  The profile, the call counts and the A/B are all reproducible with `node tests/perf_bench.js` and
  `node --cpu-prof`; nothing here was adopted on the strength of a claim.

### Fixed

- **A check suite was written and then never run.** `tests/quiescence_check.js` — 71 checks pinning
  the setup punisher's boost table, the per-call boost override, the Protect-blocked cell, the
  affordability guards and the purity/determinism of every re-priced leaf — was absent from
  `tests/run_all.js`'s `SUITES` and had no `package.json` script, so neither `npm test` nor CI had
  ever executed it. Nothing signalled this: the suite is green when run by hand, it is documented in
  the README's suite list, and this changelog cites it as evidence for the quiescence tier, so it
  read as covered while being the one suite the command skipped. Every regression it was written to
  catch would have landed silently. It is registered now, which puts it in the path of every push
  (`npm test`: **28 suites, 121 s, all green**; the suite itself runs in 1.3 s, so it costs the
  command nothing). Found by diffing the README's documented suite list against `SUITES` rather than
  trusting either — the same diff also caught two defects in that list: two suites were jammed onto
  one line (so it under-counted its own entries), and three suites carried no check count. A sweep
  of every file in `tests/` confirms this was the only orphan suite: `perf_bench.js` is deliberately
  outside `npm test` (it is a benchmark with its own `npm run bench*` scripts, informational unless
  `--assert` is passed).

- **A registry gate in `tests/run_all.js`, so this cannot recur silently.** Before it spawns
  anything, the runner now asserts that every `.js` file in `tests/` is either in `SUITES` or a
  declared exception WITH its reason (`harness.js` is the loader, `perf_bench.js` is the benchmark,
  `run_all.js` is the runner — an exception must be argued in the source, which is the opposite of
  the silent skip that caused the defect above), and that the README's "Run everything" list names
  **exactly** the registered set. Both directions fail: a suite nobody runs, and a documented suite
  that does not exist, are the same defect seen from either side. Failure prints the offending names
  and exits 1 without running a single suite, so `npm test` and CI cannot pass while the registry and
  the documentation disagree. Both branches were exercised, not assumed: with a probe suite file in
  `tests/` the gate named it and exited 1 before spawning; with one suite line un-documented in the
  README it named that suite and exited 1. `npm test` then runs green (28 suites, 116 s) — which is
  itself the assertion that the README and `SUITES` agree, since the gate would otherwise refuse.
- **Two stale claims in the docs around that list.** `tests/hardening_audit.js` was documented at 48
  checks where the suite reports 64 (its own header and the changelog both said 64; the README never
  followed the 46 → 64 bump), and the e2e job's comment in `ci.yml` still called the Node suites a
  ~30 s job. The wall clock is load-dependent, which is why a single number was wrong in both
  directions: the identical command measured **116 s, 121 s and 39 s** on this machine within the
  hour (the per-suite times move with it — `cross_check` 13.9 s to 39.5 s, `ablation_check` 5.4 s to
  22.8 s), dominated by `cross_check`, `ablation_check` and `arena_check`. The docs now say 39 s to
  2 min rather than a figure the next run would contradict. Every one of the 28 documented per-suite
  counts is diffed against what the suite actually reports, mechanically rather than by eye.

- **The format gate failed OPEN on every sibling tier it had not thought of.** `setFormat` decided
  support by enumerating the tiers to *reject* (`not uu/ru/nu/pu/doubles/monotype/...`), so any
  National Dex name that was not on that list was reported as supported: measured through the real
  pipeline, `[Gen 9] National Dex Ubers`, `gen9nationaldexubers` and
  `[Gen 9] National Dex Almost Any Ability` all set `formatSupported = true`. The engine would then
  answer in a tier its set database, usage overlay and calibration do not describe — confidently, and
  with the HUD reporting the format as fine. The rule is now an **allowlist that names the format we
  support** (`[Gen 9] National Dex` — the ladder's own string, verbatim in `test_log.txt`, which has
  no "... OU" on the wire — plus `[Gen 9] National Dex OU`, `gen9nationaldex`,
  `gen9nationaldexou`), which cannot forget a tier: anything else is gated off, including other
  generations. Empty/unknown headers still fail open, deliberately, since the battle may not have
  started. Pinned by 11 new checks in `run_tests.js`'s format-gate block (218 → 229 checks) covering
  the four accepted names, the fail-open case, and Ubers / a NatDex OM / a lower tier / doubles /
  another generation as refusals. **This was found chasing a report that the engine shuts itself OFF
  on the ladder's `[Gen 9] National Dex` naming — that report is wrong for this code, which never
  required "OU": the twelve-case probe over the real parser and state manager shows the live ladder
  header is accepted, and `tests/hardening_audit.js` already pinned it. The real defect in that area
  is the opposite direction, and it is the one fixed above.**

Seven defects the arena found while it was being built (not an audit sweep, but each is a real bug
with a suite pinning it now):

- **The blunder harvester could never harvest anything.** It read the engine's decisions out of
  `report.fullLog` — the omniscient public stream — and the sim never publishes `|request|` on that
  stream, so no decision frame was ever in it: every analysis returned "the log contains no decision
  frame for p1", `scoreTimeline` walked an empty timeline, and `run_arena --harvest` could not append
  a puzzle for any game it was ever given. The runner now reports `p1Log`/`p2Log` (each seat's own
  stream: the public lines plus that seat's private frames, in order), the harvester reads the side it
  is analyzing, and the suite pins the split against a REAL battle and a real timeline — the
  synthetic self-check fixture had requests inside `fullLog`, which is precisely why it never
  noticed.

- **The arena crashed on every normal win.** `writeEnd()` on a player stream reaches
  `Battle.destroy()` through a promise, so the throw arrives as an *unhandled rejection* no
  surrounding `try/catch` can see — and the sim destroys its own battle on `|win|`, so the abort
  path, which runs for every completed game, threw on the one path every game takes. `_abort()` now
  ends streams only for a game that has not already ended.
- **The repo's own `TeamParser.packTeam()` output is not a legal packed team for `@pkmn/sim`.** It
  joins sets with newlines where the sim splits on `]`, and writes display names where the sim reads
  ids, which surfaces as `invalid happiness`. Teams now reach the sim through `Teams.import(paste)` →
  `Teams.pack(sets)`, and the personas carry pastes for exactly that reason.
- **A choice written to `players.pX.write()` must be BARE** — `move 1`, not `>p1 move 1`. That stream
  prepends `>pX ` itself, so a prefixed choice is an invalid choice and the driver stalled at turn 0.
- **Two shipped sample teams were illegal, and the self-check exited 0 anyway.** Both carried a
  Dragapult the sim's dex tags **ND Uber**, which `gen9nationaldex` bans; `teams.js` printed the
  verdicts and still reported success. Replaced with validator-verified sets (Iron Moth and Raging
  Bolt), and the self-check now prints every diagnostic first and then **exits non-zero on an illegal
  shipped sample** — a sample that cannot be played is worse than no sample.
- **The mutator's coverage injection was dead.** It read `species.learnset`, which does not exist in
  `@pkmn/sim` 0.10.11 — the learnsets live at `Dex.data.Learnsets[id].learnset` (1,288 species), so
  every coverage mutation was rejected for a move that could not be proven. The class now draws from
  a ranked pool (uncovered damaging type first, then power, then status) built from that table.
- **`mutateTeam` rejected legal teams carrying a Gen-6 legendary.** Its parse materialized an empty
  `ivs: {}` for a set that never declared IVs, and the validator reads an empty table as **zero** IVs
  while an absent key means the default 31 — so Ting-Lu became "must have at least three perfect IVs
  because it's a legendary in Gen 6 or later", reported as an illegal *input*, and no mutation ran at
  all on two shipped samples. The table is now carried only when it actually says something.
- **Two fabricated-move bugs in the same lookup path**, both pinned now in `tests/util_smoke.js`. The
  move cache was a plain `{}` with a truthiness hit test, so `getMoveData('constructor')` returned the
  **Object constructor itself**, and `toString`, `valueOf`, `hasOwnProperty` and `__proto__` returned
  invented zero-power Status moves — `isStatus: true`, `basePower: 0` — which every status-aware rule
  downstream (the quiescence setup/protect pricing, the volatility screen) treats as a real, legal
  move. Making the cache a `Map` was not enough: the vendored `RAW_MOVES` table is a plain object
  too, so `RAW_MOVES[key]` kept answering from `Object.prototype` and kept fabricating the move. The
  raw lookup is own-key only now, and all five names answer `null` like any other non-move.

Seven defects found by the browser suite that no sandbox could have seen — full write-ups in
[`BUGS_AUDIT_REPORT.md`](BUGS_AUDIT_REPORT.md), sweep 2:

- **B17 — a second `|init|` never cleared the board.** `BattleStateManager.reset()` existed, was
  correct, and was **never called from `src/`**, and `|clearpoke|` was never handled at all. Showdown
  re-sends `|init|` followed by the entire log from turn 1 on a mid-battle reconnect (and a rematch
  re-uses the connection), so the replay stacked on the previous battle: three battles left the
  opponent roster as `Iron Valiant, Landorus-Therian, Kingambit, Dragapult`, Sp. Atk boosts read +2
  instead of +1, and Stealth Rock was on a side the replay had not put it on. `_onInit` now resets on
  a repeat `|init|` (keyed on the raw line, because `|format|` parses to the same event type but is a
  room header), `reset()` re-registers the pasted team from a new `_parsedTeam` copy — the paste is
  connection truth, not battle state — and `content.js` clears the pruner's per-battle pools too.
- **B15 — an inbound socket frame was forwarded once per listener.** `injected.js` captures frames
  through two independent wrappers (the `onmessage` accessor and a per-socket `addEventListener`), so
  a page using both got every frame twice. Absolute lines are idempotent, but `|-boost|p1a|atk|1` is
  not: +1 became +2. Both wrappers now share one `captureInbound(event)` guarded on the event object,
  which is the delivery's identity. The page's own handlers are still called unconditionally.
- **B14 — the poll's dedupe ate genuine repeats.** It skipped any line matching the poll's own last
  delivery, so three identical consecutive lines in `battle.log` reached the parser once. It now
  skips only when the **socket** was the last thing to deliver that text.
- **B12 — the inline-style rollback recorded the HUD's own values.** The guard read `data-st-badge`
  off the *button* while the attribute is set on the *badge*, so it was always true: the list grew by
  one entry per render (31 for 30) and held styled values, which `clear()` then replayed *after* its
  own correct reset — leaving `opacity: "0.5"` on a vetoed button after teardown.
- **B16 — `clear()` reset `textDecoration` without recording the original**, destroying an inline
  style it had not recorded. Same root-cause family as B12, fixed together.
- **B13 — the "strip a stale badge" branch was dead code**, testing the same always-null attribute,
  so a button the engine had no opinion about kept the previous turn's number.
- **B11 — the team drawer's toggle was covered by the drawer it opens.** `.team-drawer` spans
  `left:0; right:0; bottom:0` at `z-index: 2147483003`; `.team-drawer-toggle` sat at `left:10px;
  bottom:10px` at `2147483002` — inside the panel's rectangle and one step below it. Proven with
  `elementFromPoint`, which returned `DIV.drawer-candidates` at the toggle's centre. The toggle is now
  the top of the ladder and the panel reserves its corner.

### Changed (sweep 2)

- **`src/content.js`** — `_error()` now mirrors every caught failure onto
  `documentElement.dataset.stError` (plus a count). `stats.errors` lives in the isolated world, so
  nothing outside it — not the page, not a test, and not a player who opens DevTools on the page
  rather than on the extension — could read it, and `util.js`'s `DEBUG` flag is a module-level `let`
  that is false in every shipped build. The browser suite asserts `internalError === null` throughout.
- **`tests/injected_bridge.js`** 12 → 23 checks; **`tests/hardening_audit.js`** 46 → 64.

### Added (earlier in this release)

- **`src/mlp_residual.js` — an optional Wide & Deep residual head.** `score = linear + clamp(gain *
  MLP(x))` where the linear dot product stays the frozen base score and the head is a 128 → 16 → 1
  ReLU network held in `Float32Array`, bounded to ±150 (deliberately below `laplace.lethalBonus`,
  so a residual can never outvote a forced kill). Off unless `config.evaluator.mlp.enabled` is true;
  disabled is bit-identical to having no head at all, verified over all 30 turns of `test_log.txt`
  plus 400 randomised boards. `fromConfig()` fails safe to `null` for a disabled toggle, an absent
  artifact or a dimension mismatch, so it can never half-apply.
- **`tools/train_mlp_residual.js` — the offline fitter and its gate.** Fits the head on the frozen
  linear model's own **residuals** (`y − sigmoid(a + b·raw)`, the logistic loss's negative gradient),
  never on the label, so it can only learn what the linear half got wrong. It reuses `splitIndices`
  and `auc` from `tools/fit_weights.js` with the same per-battle row counts, so the battle-level
  hold-out is literally the linear fit's, and significance is a paired bootstrap over battles. Writes
  `lib/mlp-residual.json` (the artifact, carrying the verdict) and the generated
  `lib/mlp-residual.js`.
- **`tests/mlp_check.js`** — the head's contract: fail-safe off, the clamp, the NaN guard, that the
  evaluator adds exactly `delta(vector)` and nothing else, that the generated module carries weights
  *iff* the gate passed, and that the trainer's vectorised forward pass is **bit-identical** to the
  class that ships (it was not, at first — see below).
- **`tests/perf_bench.js --mlp`** (`npm run bench:mlp`) — measures what enabling the head would cost
  rather than guessing, alternating the worst-case board off/on so drift cancels: **+2.1 ms p50 /
  +3.6 ms p95** per turn (~7–10% of the worst case). An isolated `delta()` loop says 3.8 µs a call,
  a +1.6 ms floor over 432 `_payoff` calls, and is optimistic.

### Changed

- **`src/evaluator_128d.js` — `evaluate()`/`evaluateVector()` gained the optional residual.** The
  `enabled` read is not cached (a runtime `configMerge` is honoured immediately); only the
  constructed head is. `evaluateVector` now also records `lastScore`, which it did not before.
- **`manifest.json`, `tests/harness.js`, `bench/bench.html`** — the two new scripts are registered in
  all three load orders, and `tests/mlp_check.js` now asserts that `MANIFEST_ORDER` and
  `manifest.json` agree in both directions.
- **`.gitignore`** — the corpus (`replays*.json`, `training_data*.json`, `corpus/`) is explicitly
  ignored. It is thousands of third-party logs and is not reproducible from a checkout.

### Measured and REJECTED

- **The residual head does not clear its gate, so it is not enabled.** Rebuilt corpus: **3,521
  battles → 107,024 labelled turn rows** (the shipped corpus is not reproducible — the
  rating-sorted replay window moves). The frozen linear score holds **AUC 0.7145** on its
  battle-level hold-out, against the **0.7049** the shipped vector scored on the original corpus, so
  the two are comparable. Adding the head: **0.7144**, paired bootstrap median **−0.0001**, 95% CI
  **[−0.0011, +0.0009]**, ahead in **40.8%** of resamples. Five further configurations (80 and 300
  epochs, `l2` 1e-2 and 1e-1, a 4-unit net) also failed; the best posted +0.0012 with a CI straddling
  zero, and two of them had the selector choose **gain 0**. `config.evaluator.mlp.enabled` stays
  `false` and `lib/mlp-residual.js` ships as `null`.
- **The first run of the fitter was a false positive, and the bug is worth recording.** It selected
  the gain by maximising the *training-half* AUC and reported train AUC 0.8616 against a held-out
  0.6757 — a head that looked like a large win and was a large loss. Rows are consecutive turns of
  ONE battle and share its label, so the effective sample size is the battle count (~2,800), not the
  row count (~85,000). The fix is a second grouped split *inside* the training half, early-stopping
  on its MSE and choosing the gain on its AUC; on this corpus the inner-validation minimum is at
  **epoch 0**, so further training only ever overfits. The naive version is kept behind
  `--no-early-stop` as a diagnostic, and the sweep above uses it to show the negative result is
  about the features rather than about stopping too soon.
- **The trainer's fast path was not bit-identical to the shipped class.** `headOutputs` trained on
  raw dims while the class standardises, and it did not round its input to Float32 the way a
  `Float32Array` store does. `tests/mlp_check.js` caught it (22 of 30 rows differed in the 7th
  significant digit) and both paths now share one `standardizeMatrix`.

### Added (earlier in this pass)

- **`tests/perf_bench.js` — the turn-cost benchmark.** The audit left "10 ms on an S24 FE"
  unmeasured and `lastReadout.elapsedMs` unread. This replays the real 30-turn `test_log.txt`
  through the pipeline and times `evaluateTurn` on every turn, plus a synthetic worst case, and
  prints a distribution with a Geekbench-scaled device projection. It loads the engine into the
  **main realm**, not `tests/harness.js`, because the harness's `vm` context inflates the same
  board from ~40 ms to ~119 ms.
- **`bench/bench.html` — the on-device benchmark.** A standalone page that loads the engine in a
  real browser and reports the device's own numbers (p50/p95/max, calibration score, UA,
  `hardwareConcurrency`). This is the only ground truth for the mobile target.
- **`package.json` + `.github/workflows/ci.yml`.** There was no way to run the suites together and
  nothing ran them on a push, so a regression could be committed silently. `npm test`
  (`tests/run_all.js`) runs every suite; CI runs it on every push and PR. (There were 17 when this
  entry was written; `tests/invariants_check.js` and `tests/mlp_check.js` brought it to 19.)
- **`tests/invariants_check.js`.** Pins the two `Object.create` prototype-clone tricks the engine
  leans on: `evaluateTurn` must not mutate its input state, `_leafState`'s clones must not write
  through to their source, and `simulate()` / `_mutableSim` must leave the source alone. Also
  pins `_oppActive`'s documented resolution order.
- **README "Start here" + "Performance" sections**, and this changelog.

### Changed

- **`src/evaluator_128d.js` — memoised `_bestOffenseMultiplier`.** The 6x6 threat matrix is rebuilt
  on all 432 `_payoff` leaves of a turn, but it is invariant across them (they differ only in HP).
  The offence multiplier is a pure function of (attacker species, its resolved moves, defender
  species), so it is now cached on exactly those inputs. Verified **score-exact**: the vector and
  the score are bit-identical to the pre-change evaluator over all 30 turns plus 400 randomised
  boards (`_verify_exact` in the working notes).
- `_speedOf` was **deliberately not** memoised. Its key is `slot|id|species`, which collides for a
  same-species mirror (both Slowking-Galar share one entry, and which body wins depends on
  iteration order). Enriching that key changes scores, so it is left exactly as it was — see
  "Known limits".

### Known limits (carried forward)

- The turn still costs ~28–40 ms against a 10 ms target. The dominant cost is `extractVector`
  rebuilding all 128 dims per leaf; the fix is an incremental vector (compute the invariant dims
  once per world, patch HP per leaf), which is a larger change than this pass.
- The `_speedOf` mirror collision above is a latent correctness bug, not just a perf one: a
  mirror matchup can read the wrong body's Speed. Fixing it changes scores and needs a re-fit.
- Still nothing verified against a live Showdown socket in a browser; `bench/bench.html` closes
  the performance half of that gap, not the UI half.

## 1.0.0 — 2026-10-11

The initial engine, built and hardened in one day of commits:

- **The engine** (`b879ebe`): the Laplace loop (K=6 determinized world sampling, a simultaneous
  payoff matrix solved by fictitious play, a 128D leaf evaluator, a 10D tempo vector, twelve
  blunder vetoes, a Trick Room lifecycle manager), the mobile HUD, and the first four test suites.
- **Ten defects found and fixed** (`380c9f4`): a softmax `NaN`, non-deterministic world sampling,
  a speed-blind veto, Mega formes sampled as their base, a species prefix-match, an IV-blind
  damage memo, Struggle breaking Choice deduction, candidate pools shared across sides, an
  unsatisfiable Speed floor emptying a pool, and a heal on a fainted body. Each is pinned by an
  assertion in `tests/hardening_audit.js`.
- **Board-state vetoes, the empirical-weight pipeline, Firefox for Android** (`c37fbbe`).
- **Bench-tap sandbox, replay scouting, PP-stall / volatility / format-sentinel readouts**
  (`b7af96c`).
- **An honest weight corpus** (`5202c35`): rebuilt from the top of the ladder after a leakage bug
  (0.9360) was found and discarded in favour of an honest 0.7011 battle-level hold-out.
- **The fitted 128D vector adopted at a measured scale** (`54ea748`): `fitScale` 52.2 restores the
  evaluator's influence, AUC 0.670 -> 0.705 on the hold-out.
- **Cross-product features screened and rejected** (`d5e6c00`): a documented negative result —
  none cleared the hold-out gate.
