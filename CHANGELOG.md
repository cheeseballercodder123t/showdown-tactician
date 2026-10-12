# Changelog

Newest first. The README is declarative (what is true now); this file and the commit log carry the
provenance — why a number is what it is, and what was tried and rejected. Entries before
"Unreleased" are the project's own history, condensed from the commit log.

## Unreleased

### Added

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
