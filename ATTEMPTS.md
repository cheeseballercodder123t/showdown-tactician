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
| A1 | **Turn urgency** (`laplace.urgency`) | bounded, ramping bonus for COMMITTING rows (a real attack or a setup move) over passive ones past `startTurn`, multiplied at `breakoutTurn`; re-ranks rows, cannot override a veto | 60 paired battles, all three personas, seed 1337: win **68.3 % → 96.7 %**, Δ **+28.3 [+18.3, +40.0]**, and the 100-turn cap ties — *every* tie the baseline played — **17/60 → 1/60**; p90 turns 101 → 89 | **ADOPTED** 2026-10-12 |
| A2 | **The fitted 128D vector at a measured scale** | `fitScale` 52.2 restores the evaluator's influence on the blend | held-out AUC **0.670 → 0.705** | **ADOPTED** |
| A3 | **Memoisation of the hot damage/name path** (`toID`, `getMoveData`, the id→raw index) | pure caching, no policy change | real boards: mean **96.3 ms → 30.7 ms**, p95 **132.7 ms → 47.5 ms**; bit-identical — same 432 `_payoff` cells, same vector, same rankings to 17 significant figures over 390 boards | **ADOPTED** |

A1 is the **only** policy tier this project has ever adopted on a measured win rate, and its shape is
the lesson in §G: it did not tell the engine to stop doing something, it **converted cap ties into
wins** (16 of the 17) by making progress outrank passivity late in a game.

---

## B. Rejected after measurement

| # | attempt | mechanism | measured | status |
|---|---|---|---|---|
| B1 | **The pivot tax** (`laplace.switchTax`, id `switch-tax`) | flat score drag on every SWITCH row, so a pivot must beat the best attack by `points` before it takes the top line; folded into the mix matrix *and* the row score | **agreement went UP**: top-1 **31.7 % → 44.0 %** (contested 25.5 % → 31.9 %), pivot rate 55.4 % → 29.2 %. **Strength went down**: 96.7 % → 70.0 %, Δ **−26.7 [−38.3, −15.0]**, and the 100-turn cap ties came back **1/60 → 18/60** (30 % stall, capped games only 4.1 of 12 bodies down — a standoff) | **REJECTED**; ships OFF, row kept in the table |
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
| C1 | **`quiescence` (the setup punisher)** — prices the opponent's boosted reply and their Protect inside the cell | **feature HURTS**: removing the whole tier wins **+19.3 [+12.0, +26.7]** (66.7 % → 86.0 %) and cuts cap ties **46/150 → 15/150**. The harm is **entirely** `extendSetup` (switching it off reproduces the master switch *battle for battle*); `blockProtect` changed nothing | **The tier still ships ON, and this is the single most valuable open measurement in the repo.** It was measured on the **pre-urgency** build (baseline 66.7 %, 46/150 capped). Turn urgency has since removed exactly the standoff pathology `quiescence` was blamed for (baseline now 96.7 %, 1/60 capped), so the number **has not been re-measured on the current build** and must not be quoted as if it had. Re-run it: `node tools/run_ablation.js --features quiescence,quiescence-extendsetup --battles 60 --seed 1337`. |
| C2 | **VETO4 (`SPEED_SUICIDE`) firing on stale speed information** | 106 of the 177 elite clicks the guard refuses are this one code | unproven either way. The question is whether those refusals are boards where the human was right because the engine's speed estimate was blind to the field (an unrevealed Scarf, a weather ability, Tailwind). Answering it needs the **speed race itself instrumented**, which has not been done. Suppressing the rule is *not* an answer — see §F2. |
| C3 | Smaller open defects | see the "Known — open, from the same review sweep" list in `CHANGELOG.md` (`residualOrder.trust` shipping at 1, Protosynthesis/Quark Drive Speed, `shelter`'s unverified effect, G-Max Steelsurge's flat 12.5 %, two HUDs double-handling a bench tap, `mon.knockOffSurvived` read but never written) and the deliberate-omission list in `BUGS_AUDIT_REPORT.md` | each is stated with its narrow fix; none is fixed |

---

## D. INERT HERE — flat for a harness reason, not because of the feature

These are the rows that a careless reader reports as "measured neutral". They are not: the feature's
input never arrives in the arena, or the situation it acts on never arises there, or the knob is a
shipped-empty control. In every case toggling it **cannot** change a decision, so the flat row is a
statement about this harness.

| # | feature | why it is flat here | how to price it for real |
|---|---|---|---|
| D1 | `laplace.volatility` (the tilt/accuracy charge) | `_accuracyOf` reads `state.moveAccuracy`, which only `src/injected.js` populates, from the client's own **stacc** accuracy snapshot; `@pkmn/sim` emits no such line, so the penalty is always 0 | a real client stream — `bench/bench.html`, not this runner |
| D2 | `clock` (opponent clock prior) | `OpponentClock._close()` returns early unless `mySubmitTs` is set, and that is set only by an **outgoing `/choose`** line; the arena's agent answers the sim runner directly and never sends one, so the history stays empty and `switchPrior.unknown` stays 1.0 — which is exactly what `enabled: false` does | drive the engine through a real browser session |
| D3 | `clock.ratingBands` (Elo switch bands) | needs the opponent's ladder rating, which the protocol carries only as a fifth field on the **player** line; the arena creates both players with no `rating` option, so `state.opponentRating` stays `null` and `ratingFactor()` returns 1 by design | a run that injects ratings; or the live client |
| D4 | `laplace.comeback` | scales **only** the volatility charge, and that charge is 0 in the arena (D1) — any multiplier on 0 is 0 | same as D1 |
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
| **a flat score drag/boost applied to a whole class of action** | the pivot tax (B1), turn urgency (A1), the volatility charge (D1) | 1 adopted, 1 rejected, 1 unpriceable | it *can* work — but only A1 did, and its mechanism was **relative re-ranking that converted lost positions into wins**, not the suppression of a behaviour. Ask which of those yours is |
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
