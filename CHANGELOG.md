# Changelog

Newest first. The README is declarative (what is true now); this file and the commit log carry the
provenance — why a number is what it is, and what was tried and rejected. Entries before
"Unreleased" are the project's own history, condensed from the commit log.

## Unreleased

### Added

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
  (`tests/run_all.js`) runs all 17 suites; CI runs it on every push and PR.
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
