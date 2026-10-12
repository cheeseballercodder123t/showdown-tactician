# Changelog

Newest first. The README is declarative (what is true now); this file and the commit log carry the
provenance — why a number is what it is, and what was tried and rejected. Entries before
"Unreleased" are the project's own history, condensed from the commit log.

## Unreleased

### Fixed

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
  - **`comeback` — unpriceable in this harness, same cause as `volatility`.** It scales only the
    volatility charge, and `_volatilityDelta` returns a zero penalty before it reaches that scale
    when `state.moveAccuracy` is empty — which it always is in the arena, because only
    `src/injected.js` populates it from the client's own `|stacc|` snapshot.
  - **`urgency` — the adoption above.**
- `tests/tuning_check.js` now pins turn urgency's ADOPTED default and drives the identity through
  an explicit constructor override (48 checks, up from 45); the README's suite list and counts were
  updated with it.

### Added

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
- **`tests/ablation_check.js`** — 241 checks. It does not stop at `configGet`: after each patch it
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
  unpriceable in the arena.** `_accuracyOf` reads `state.moveAccuracy`, which only
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
