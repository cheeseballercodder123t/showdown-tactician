# Changelog

Newest first. The README is declarative (what is true now); this file and the commit log carry the
provenance — why a number is what it is, and what was tried and rejected. Entries before
"Unreleased" are the project's own history, condensed from the commit log.

## Unreleased

### Added

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
