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

---

## C. OPEN — measured, decision not taken

| # | attempt | measured | why it is still open |
|---|---|---|---|
| C1 | **`quiescence` (the setup punisher)** — prices the opponent's boosted reply and their Protect inside the cell | **SUPERSEDED — the sign has FLIPPED.** The old reading was `feature HURTS`: removing the whole tier won **+19.3 [+12.0, +26.7]** (66.7 % → 86.0 %, cap ties 46/150 → 15/150), with the harm attributed entirely to `extendSetup`. Re-measured 2026-10-13 at the standard sample on the fixed instrument (see §H), switching `extendSetup` off **LOSES 20.0 [−30.0, −10.0]** (98.3 % → 78.3 %, 13 capped) — so the knob **HELPS** — while switching the whole tier off is **−5.0 [−11.7, +1.7]**, not measurable at this sample. **Then the mirror disagreed (§J, 2026-10-14):** the same patch, 60 paired mirror battles at seed 1337, wins **+23.3 [+8.3, +38.3]** (41.7 % → 65.0 %, capped 2/60 → 4/60) — i.e. **feature HURTS**, flipped and `surprise`-flagged against its `expect: helps` | **CLOSED 2026-10-13 — and it closed against the old verdict.** The open question was whether the harm survived the urgency change; it does not survive the *instrument* fix. The old number was taken on a build whose arena fed the engine a one-Pokemon team (§H), so it measured a crippled engine and is **not quotable**. On the fixed instrument the tier ships ON with a measurement **supporting** it. **REOPENED 2026-10-14 by §J:** the mirror reads the opposite way (**HURTS, +23.3**), so the row is now **DISPUTED — one instrument each way**, both intervals excluding zero, and the knob stays where it ships until a higher-power row (500 battles, a second seed, or a declared stronger opponent) breaks the tie. The mirror is the instrument WITH headroom (41.7 % baseline vs §H's 98.3 % ceiling), but a self-play number also prices how exploitable a frozen twin is, which is not the same question as strength against a human — so neither reading is quotable as "the" answer yet. **AMENDED 2026-10-14 by §K:** a third run (20 paired battles per instrument) reproduced the mirror's sign (+10.0, flat at that power) AND produced the same sign on the personas — the tier off won **+25.0 [+5.0, +45.0]** with the exploiter's five 100-turn stalemates as the whole of the movement — so **both instruments now lean HURTS** and §H's HELPS +20.0 is the outlier. That is still not the power to move a shipped default (n = 20, one seat's five games), so the tier stays where it ships; §K3 names the run that can settle it and reports that the `followUpWeight` hypothesis came back DISARMED. **SETTLED FOR ONE LEAF 2026-10-15 by §K6:** the 60-battle version of that run moved `quiescence.blockProtect` to **off** (+15.0 win [+6.7, +23.3], +7.5 match score [+3.3, +11.7], cap games 11/60 -> 2/60, and the whole movement is the `exploiter` seat going 4-0-11 -> 13-0-2), while `extendSetup` stayed ON because its own arm's floor on the win indicator is −5.0 and its match-point floor is exactly 0.0 — **and §K6b then SETTLED that half too, in the tier's favour:** with the block already off, removing the setup ply costs −40.0 win [−55.0, −25.0] and −20.0 match score [−27.5, −12.5] on a second seed, so the personas' earlier "no effect" reading was the seat being saturated by the mispriced shield. Both halves are now decided, in opposite directions; **this row's status line above is history** |
| C2 | **VETO4 (`SPEED_SUICIDE`) firing on stale speed information** | 106 of the 177 elite clicks the guard refuses are this one code | unproven either way. The question is whether those refusals are boards where the human was right because the engine's speed estimate was blind to the field (an unrevealed Scarf, a weather ability, Tailwind). Answering it needs the **speed race itself instrumented**, which has not been done. Suppressing the rule is *not* an answer — see §F2. |
| C3 | Smaller open defects | see the "Known — open, from the same review sweep" list in `CHANGELOG.md` (`residualOrder.trust` shipping at 1, `shelter`'s unverified effect, G-Max Steelsurge's flat 12.5 %, two HUDs double-handling a bench tap, the Protosynthesis ceiling's sun/terrain case) and the deliberate-omission list in `BUGS_AUDIT_REPORT.md`. **TWO ARE NOW CLOSED** (2026-10-14): `mon.knockOffSurvived` was a read of nothing (the live field is `mon.itemKnockedOff`, now withheld for a Sticky Hold body), and the whole-`possibleAbilities` hard veto in VETO2 became a proof requirement. The Protosynthesis / Quark Drive SPEED misread is fixed for every speed layer, but the ceiling's sun/terrain-only case is not | four remain open, each with its narrow fix |

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
| **pricing a 1-ply leaf cell more faithfully** (name the switch-in, price a pivot as a hit + a switch, credit a heal) | `realoppswitch`, `pricepivots`, `pricerecovery` (§J) | all three flat at 60 mirror battles; `pricepivots` (+10.0) leans the same way as `extendsetup` | correcting a leaf's arithmetic does not by itself buy win points at this resolution. Pin the arithmetic in a suite (`tests/tuning_check.js` §4 does), then price it on a larger or stronger sample |
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
   is the number to quote, ~5 h single-threaded, ~1.5 h at `--parallel 4`).
4. **Quote the interval, not the point estimate.** `helps`/`hurts` means the 95 % interval excludes
   zero; anything else is *no measurable effect at this sample size*.
5. **If the row is flat, check the flag's INPUT before reading it as a result.** `identical` is the
   tell. Pick the right bucket from §D (harness gap), §E (unresolved), or a genuinely dead control.
6. **If it is rejected:** keep the flag shipped OFF, keep the row in the table, and **add a line here**
   with the numbers and the artifact. A rejected attempt that leaves no trace gets rebuilt.
7. **If it is adopted:** re-point the row's `patch` at the value it now ships (`direction: 'off'`) so
   the row keeps measuring what turning the feature off costs, and record the adoption numbers here.

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
