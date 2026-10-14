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
| A1 | **Turn urgency** (`laplace.urgency`) | bounded, ramping bonus for COMMITTING rows (a real attack or a setup move) over passive ones past `startTurn`, multiplied at `breakoutTurn`; re-ranks rows, cannot override a veto | 60 paired battles, all three personas, seed 1337: win **68.3 % → 96.7 %**, Δ **+28.3 [+18.3, +40.0]**, and the 100-turn cap ties — *every* tie the baseline played — **17/60 → 1/60**; p90 turns 101 → 89. **Re-anchored 2026-10-13** on the fixed instrument: Δ **0.0**, flagged `stall` — but the baseline is now **98.3 %** win, so the benefit urgency delivered *has become the baseline*. That is a ceiling, **not a refutation**: an instrument that already wins every game cannot price what made it win. Re-pricing urgency needs a stronger opponent, not a longer run | **ADOPTED** 2026-10-12 |
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
| C1 | **`quiescence` (the setup punisher)** — prices the opponent's boosted reply and their Protect inside the cell | **SUPERSEDED — the sign has FLIPPED.** The old reading was `feature HURTS`: removing the whole tier won **+19.3 [+12.0, +26.7]** (66.7 % → 86.0 %, cap ties 46/150 → 15/150), with the harm attributed entirely to `extendSetup`. Re-measured 2026-10-13 at the standard sample on the fixed instrument (see §H), switching `extendSetup` off **LOSES 20.0 [−30.0, −10.0]** (98.3 % → 78.3 %, 13 capped) — so the knob **HELPS** — while switching the whole tier off is **−5.0 [−11.7, +1.7]**, not measurable at this sample | **CLOSED 2026-10-13 — and it closed against the old verdict.** The open question was whether the harm survived the urgency change; it does not survive the *instrument* fix. The old number was taken on a build whose arena fed the engine a one-Pokemon team (§H), so it measured a crippled engine and is **not quotable**. On the fixed instrument the tier ships ON with a measurement **supporting** it. |
| C2 | **VETO4 (`SPEED_SUICIDE`) firing on stale speed information** | 106 of the 177 elite clicks the guard refuses are this one code | unproven either way. The question is whether those refusals are boards where the human was right because the engine's speed estimate was blind to the field (an unrevealed Scarf, a weather ability, Tailwind). Answering it needs the **speed race itself instrumented**, which has not been done. Suppressing the rule is *not* an answer — see §F2. |
| C3 | Smaller open defects | see the "Known — open, from the same review sweep" list in `CHANGELOG.md` (`residualOrder.trust` shipping at 1, Protosynthesis/Quark Drive Speed, `shelter`'s unverified effect, G-Max Steelsurge's flat 12.5 %, two HUDs double-handling a bench tap, `mon.knockOffSurvived` read but never written) and the deliberate-omission list in `BUGS_AUDIT_REPORT.md` | each is stated with its narrow fix; none is fixed |

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
| D5 | `quiescence-blockprotect` | **INERT IN THIS CORPUS, NOT DEAD CODE.** `tests/quiescence_check.js` proves the shield blocks our move inside the cell and that `blockProtect: false` reproduces the legacy 1-ply number exactly — so the knob works and its input does arrive. Their Protect simply never landed on a cell where the block flipped the choice | a corpus where a shield lands on a flipped decision |
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
| **teaching the engine to price the opponent's non-attacking replies** | `quiescence` (C1) | measured **HURTS**, still open | the idea is not refuted; the *implementation* measurably lost. Re-measure before extending it |
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
