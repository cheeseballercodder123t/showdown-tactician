# Showdown Tactician — Laplace NatDex Engine

A standalone **Manifest V3** Chrome extension that recreates the 2231-Elo "Laplace" decision
engine for **[Gen 9] National Dex OU** and renders its verdict as a thumb-friendly portrait HUD.
Built for Chromium-on-Android (Lemur Browser, Samsung Galaxy S24 FE, 1080×2340).

* Format: `[Gen 9] National Dex OU` — Megas, Z-Moves and Gen 9 Paradox mons are live;
  **Terastallization is tracked but never simulated** (banned in this format) — and the two 128D dims
  that used to price it, 120/121, carry the cleaner advantage instead while the ban is set.
* Architecture: determinized multi-world sampling (K=6), 2-ply simultaneous matrix solver
  solved for a mixed equilibrium (fictitious play), 128D dense-state leaf evaluator +
  10D momentum vector, twelve deterministic blunder vetoes, Trick Room lifecycle manager,
  optional LLM narration.
* Everything runs **locally**. The LLM layer is opt-in and costs 0 ms when no API key is set.

## Start here

Five minutes to a working mental model:

1. **It is an extension, not a library.** `manifest.json` loads `lib/` (a vendored `@smogon/calc`)
   then every file in `src/` as a *classic script* in dependency order; each publishes exactly one
   class onto `window.ST`. `src/content.js` boots the pipeline. The full interface contract is
   [`ARCHITECTURE.md`](ARCHITECTURE.md) — read that before editing any module.
2. **Three rules hold the whole thing together**, and each has a test that enforces it rather than
   a comment that asks nicely:
   * **Rule 1 — no in-house math.** Damage, stats and type charts come from the vendored library;
     `tests/blackbox_guard.js` diffs 50,616 stat values and greps `src/` for handwritten formulas.
   * **Rule 2 — frozen ground truth.** `test_engine.js` pins five canonical damage rolls.
   * **Rule 4 — one config.** Every tunable lives in [`src/config.js`](src/config.js);
     `tests/config_check.js` inventories all of them and proves live mutation flows through.
3. **Run everything:** `npm test` — 32 suites, 39 s to 2 min depending on machine load (the two
   figures are the same command on this machine), no runtime dependencies (the arena and
   ablation suites skip with a plain message without `@pkmn/sim`; CI runs them in a separate job
   with the install). Individual
   suites are plain `node tests/<name>.js`. CI runs the same command on every push. The runner also
   **refuses to start on an inconsistent registry**: every `.js` file in `tests/` must be listed in
   its `SUITES` or be a declared, explained exception (`harness.js` is the loader, `perf_bench.js` is
   the benchmark), and the list below must name exactly the registered set. A suite that exists but
   never runs is a defect rather than an omission — one shipped that way (`tests/quiescence_check.js`,
   71 checks, green by hand and executed by nothing), and a documented suite that does not run is the
   same defect from the other side. Two of the
   suites belong to the headless arena: `tests/tactical_puzzles.js` needs no install at all, and
   `tests/arena_check.js` prints an honest skip when `@pkmn/sim` is absent (`npm install` adds it —
   it is a devDependency, never shipped). The arena's own CLI is `npm run arena`;
   see [The headless adversarial arena](#the-headless-adversarial-arena).
4. **Then the real browser:** `npm run e2e` (41 Playwright tests, ~46 s) loads the actual MV3
   extension into Chromium and drives a page. It is deliberately **separate** from `npm test`: the
   Node suites are zero-dependency and finish in a minute or two, the browser suite needs a
   Chromium download.
   See [`tests/e2e/helpers.js`](tests/e2e/helpers.js) for the observability contract — a content
   script's isolated world is invisible to `page.evaluate`, so everything asserted is shared DOM,
   the MAIN-world bridge, or the console stream.
5. **Measure it:** `npm run bench` replays the real 30-turn log and reports the per-turn decision
   cost; `npm run bench:serve` then open the printed URL on the phone for ground-truth numbers
   (see [Performance](#performance)).
6. **History lives in [`CHANGELOG.md`](CHANGELOG.md).** This README is declarative — what is true
   now; the changelog and the commit log carry how it got that way.

## Performance

The decision path is one synchronous burst per turn. `tests/perf_bench.js` replays
`test_log.txt` through the real pipeline and times `evaluateTurn` on every turn, plus a synthetic
worst case (6 bodies alive both sides, 4 moves + a full bench, hazards, Trick Room).

The cost is `K worlds x our actions x their replies`, and every cell of that product is one
`_payoff` (two damage rolls + one 128D evaluator pass) — up to **432 `_payoff` calls in a turn**.

Measured on an Intel i7-9750H (2019 laptop), main realm, 2026-10-12 (calibration score ~403k ops/ms;
the engine's own baselines on this machine span ~370–430k, so compare the score before comparing two
runs):

| board | p50 | p95 |
| --- | --- | --- |
| real turns of `test_log.txt` | ~28 ms | ~47 ms |
| synthetic worst case | ~42 ms | ~47 ms |

`bench/bench.html` in a real Chromium under a Galaxy S24 device profile reports **~32 ms** for the
worst case (`bench/bench-result.png` is that run). The projected S24 FE figure (Geekbench-6
single-core scaling plus a thermal/browser penalty) is **~51 ms p95**.

**Getting here was a profile, not a guess.** The same instrument reported a mean of **96.3 ms and a
p95 of 132.7 ms** on the real boards before the move-lookup change, and a CPU profile of one turn put
**52% of the entire decision** in the move dex: `getMoveData` re-scanned every key of the vendored
table (with a `toID` per key) whenever it was asked for a name the table does not have — and
`_payoff` was asking it about a switch action's SPECIES, 216 times in a single turn, at ~240 us a
call against 0.28 us for a present name. Caching the misses, indexing the table by id and memoising
`toID` took the mean to **30.7 ms** and the p95 to **47.5 ms**, bit-identically: the same 432
`_payoff` cells, the same vector, the same rankings to 17 significant digits over 390 boards.
See `CHANGELOG.md` for the A/B and the verification.

**This is still ~5x the 10 ms target, and the benchmark is the instrument that says so.** The
largest remaining cost is the 128D evaluator, now roughly a third of a turn and spread across
`_bestOffenseMultiplier`'s 6x6 threat matrix, `computeSpeed` and `extractVector` — most of which
rebuilds all 128 dims, including the threat matrix, on every one of the 432 leaves although the
leaves differ only in HP. That is the next measured target; see the "known limits" section for what
is not yet fixed.

> Methodology note: do **not** benchmark through `tests/harness.js`. Its `vm` sandbox is a separate
> V8 context and inflates the same board from ~40 ms to ~119 ms. `tests/perf_bench.js` loads into
> the main realm for exactly this reason.

The optional residual head is **off**, so it costs nothing in the numbers above. `npm run bench:mlp`
measures what turning it on *would* cost instead of guessing, by alternating the worst-case board
off/on so thermal drift lands on neither side: **+2.1 ms p50 / +3.6 ms p95** per turn (about 7–10%
of the worst case). An isolated `delta()` loop reports 3.8 µs a call, i.e. a +1.6 ms floor over the
432 `_payoff` calls — the in-situ figure is the honest one, because there the head's buffers are not
cache-hot. It is not enabled because it did not clear its accuracy gate — see the weight-pipeline
section.

## Install (desktop Chromium, for development)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open a battle on `play.pokemonshowdown.com`.
3. Click the extension icon (or **Details → Extension options**) and paste your team as a
   Pokepaste export. Save.

## Install (Lemur Browser / Kiwi on Android)

Chromium for Android has no `chrome://extensions` UI, so use the browser's extension manager:

1. Pack the folder as a `.zip` (the folder itself must contain `manifest.json` at its root).
2. Lemur Browser → **Extensions** → **Load unpacked / Install from file** → pick the zip.
3. Set up the team paste through the extension options page or straight from the in-page
   **TAC** drawer button.

## Install (Firefox for Android)

The same folder is a Manifest V3 add-on for Firefox: `about:debugging` → **This Firefox/Android**
→ **Load Temporary Add-on** → pick `manifest.json` (unsigned, for development); a signed build
needs the `browser_specific_settings.gecko.id` the manifest already carries, because Mozilla
requires an id to sign an MV3 add-on.

Firefox runs background *scripts* (an event page) where Chrome runs a service worker, so the
manifest declares both `background.scripts` and `background.service_worker`, plus
`browser_specific_settings` with a Gecko floor and an Android one (`gecko_android`):

* Chrome 121 and later **ignores** the `background.scripts` entry and keeps using the service
  worker. Chrome *before* 121 refuses to load an MV3 manifest that contains it at all, which is
  why `minimum_chrome_version` is 121 rather than 102 — a manifest claiming 102 while carrying
  that key would not load on the versions it claims.
* Firefox before 121 does not start the background page when `service_worker` is present, so
  `gecko.strict_min_version` is 121.0. (Mozilla's own MV3 floor is 109.0, and Firefox for
  Android opened up to extensions during the 120 cycle.)

There is no Chromium build older than 121 in the supported set as a result, and the extension has
only been exercised in Chromium here — see the limitations below.

## Using the HUD

| Element | What it shows |
| --- | --- |
| Badge on each move button | Confidence percentage. Green ≥ 50 %, gold 25–49 %, slate < 25 %. A red strike-through badge (`conf-veto`) means the line was vetoed by the deterministic guard. |
| `.tactician-banner` (top) | `TR n/5`, opponent set identity, confirmed/deduced item, inferred Speed floor, their hazards. |
| `.tactician-tr-chip` | Only appears when something urgent is true (TR expiring, predicted Bunker turn, optimal line vetoed). |
| `.team-drawer` (bottom-left TAC button, 48×48) | Team paste textarea, save button, team status, live opponent candidate-set breakdown. |

When an API key is configured, the model's one-line justification is appended under the
recommended move once it arrives — the budget is `llm.timeoutMs` (20 s, sent with the request and
honoured by the service worker), so it never replaces the answer, it only annotates it. The local
engine's answer is already on screen without it.

## Files

```
manifest.json              MV3 manifest; loads the module chain in dependency order
lib/calc-data.min.js       vendored @smogon/calc dex (1406 species incl. Megas, 942 moves)
lib/calc.min.js            vendored @smogon/calc mechanics (exposes window.calc)
lib/species-abilities.js   GENERATED: restores the hidden/secondary abilities the calc bundle drops
lib/species-aliases.js     GENERATED: species aliases (Aegislash) + cosmetic formes the calc lacks
lib/mlp-residual.js        GENERATED: the trained residual head's tensors. Ships as `null` because the
                           gate rejected the head — see "the residual head" in the weight-pipeline section
styles/overlay.css         portrait HUD styling (dark translucent, 48px touch targets)
src/config.js              RULE 4: every heuristic weight, threshold and model id in one object
src/util.js                the DEX boundary: reads calc's species/move/item tables + Stats.calcStat; never computes damage
src/sets_usage.js          GENERATED DATA: the optional ladder-usage overlay (ships empty) that re-weights sets_db
src/scout_prior.js         GENERATED DATA: the optional replay-scouting overlay (ships empty) that re-weights candidate sets
src/sets_db.js             usage-weighted Smogon candidate sets per species
src/team_parser.js         Pokepaste + packed-team parser, localStorage extractor, active-team matcher
src/protocol_parser.js     battle stream -> semantic events (frozen event table in ARCHITECTURE.md)
src/state_manager.js       single source of truth for HP, stints, hazards, TR timer, format locks
src/set_pruner.js          deterministic negative deductions against candidate sets
src/calc_engine.js         damage wrapper with a per-turn memo cache
src/trick_room.js          TR lifecycle + inverted speed priority queue
src/evaluator_128d.js      128D dense state vector + dot-product score
src/mlp_residual.js        the optional 128->16->1 ReLU residual head (bounded +-150) added on top of
                           that dot product; off unless config.evaluator.mlp.enabled is true
src/tempo_vector.js        10D momentum vector + Protect/Bunker policy mask
src/opponent_clock.js      opponent deliberation telemetry: turn latency minus the learned noise floor
src/veto_guard.js          the twelve hard blunder vetoes (immunity, rhythm, TR, speed, contact, Sucker Punch,
                           hazard clearing, consecutive Protect, Magic Bounce, hazard caps, redundant weather)
src/world_sampler.js       K=6 determinized worlds with observed-fact verification
src/laplace_core.js        the decision loop (payoff matrix, mixed-strategy solve, legacy softmax)
src/llm_client.js          optional Gemini/OpenRouter bridge, hard 20 s abort (config llm.timeoutMs)
src/ui_overlay.js          mobile HUD DOM injection
src/injected.js            MAIN-world WebSocket interceptor
src/background.js          service worker: the only component that calls the LLM API
src/content.js             pipeline orchestrator
options/options.html|js    mobile settings page (provider, key, team, Elo scaler)
tests/run_tests.js         end-to-end verification suite (247 checks)
tests/rule_checks.js       deduction-rule checks driven through real protocol lines (23 checks)
tests/util_smoke.js        util.js in isolation: dex access, item naming, type math, Speed maths,
                           the move-lookup cache (55 checks)
tests/injected_bridge.js   the MAIN-world WebSocket bridge against a fake WebSocket/DOM, including
                           the poll dedupe and one-frame-one-forward capture (23 checks)
tests/config_check.js      RULE 4: the config inventory, the frozen 128D layout, live mutation (85 checks)
tests/blackbox_guard.js    RULE 1: 50,616 stat values diffed against @smogon/calc + a scan for handwritten math (28 checks)
tests/parser_fuzz.js       RULE 3: the real 30-turn log replayed, every prefix, and junk lines (44 checks)
tests/hardening_audit.js   the bug-hunt regression suite: 11 defects reproduced first, then fixed,
                           plus a 40-battle seeded invariant fuzz (64 checks)
tests/dom_check.js         the HUD's DOM lifecycle against a faithful stub: the inline-style rollback
                           is recorded once, clear() restores the ORIGINALS, badges are reused not
                           stacked, the veto contract holds, detached buttons are compacted, and the Cancel-window alert
                           flags Showdown's own button and releases it on every teardown path (99 checks)
tests/e2e/                 the real-browser suite (Playwright): helpers.js, a mock Showdown fixture
                           served by intercepting the real hostname, and seven specs covering boot,
                           the HUD, the session, robustness, hardening, the socket bridge and the
                           options page (41 tests)
playwright.config.js       the browser suite's config — workers: 1, because each worker launches its
                           own persistent Chromium with the extension side-loaded
tests/upgrades_check.js    the mixed-strategy solver against matrices with an analytic equilibrium,
                           the newer vetoes, the deliberation clock and the reverse damage rule (118 checks)
tests/chaos_sync_check.js  the monthly chaos-sync tool + the usage overlay it writes (70 checks)
tests/weights_check.js     the corpus downloader + the extractor + the IRLS fitter + the adopted config
                           vector, against a planted model (264 checks)
tests/discrete_check.js    the 16 discrete damage rolls, the exact KO count, EV pinning and the
                           residual-order Speed evidence (110 checks)
tests/scout_check.js       the replay-scouting tool + the overlay it writes + the pruner's use of it (78 checks)
tests/pressure_check.js    the PP-stall gauge and its 3-way pivot, the volatility charge, the
                           Z-Move/Mega format sentinel (151 checks)
tests/invariants_check.js  the Object.create leaf clones (no write-through), evaluateTurn purity,
                           and the simulate()/_mutableSim contract (17 checks)
tests/ability_check.js     negative-space ability deduction: an observed status, or grounded-only
                           damage, disproves the candidate abilities it rules out — and the
                           unsound-evidence section pins what must NOT eliminate (56 checks)
tests/tuning_check.js      the four tuning tiers — the Elo switch band, turn urgency (adopted),
                           comeback mode and the rejected pivot tax — each pinned both ways: its
                           shipped default and the exact number it moves when toggled — plus the
                           selective 2-ply beam, the stratified worlds that flipped their own default,
                           and the quantal-response opponent, whose temperature cannot reach our own
                           frequencies — plus the unrevealed-coverage mask the opponent's half of the
                           solve reads and the prior-anchored response (252 checks)
tests/preview_check.js     the Turn-0 lead advisory: the parser contract, the 6x6 evaluator scoring,
                           the broker wiring and the HUD card (31 checks)
tests/quiescence_check.js  the setup punisher: the boost table, the one extra exchange, the three
                           guards, and the shield's own no-decay cell (108 checks)
tests/profile_check.js     the opponent profiler: the deviation estimator, label/factor agreement,
                           every refusal (80 checks)
tests/entropy_check.js     the scouting entropy: Shannon arithmetic against hand-computed constants,
                           the assumed response model, the bounty bounds (48 checks)
tests/wincon_check.js      the win-condition bounty: the refusals, the body the measurements name,
                           the payout (56 checks)
tests/endgame_check.js     the endgame solver: every refusal, a proven mate, the Speed rail from
                           both sides, the widened 3v3 box, an ambiguous Speed order priced as a
                           chance node rather than refused, and the node budget (83 checks)
tests/perf_bench.js        the per-turn decision-cost benchmark: real log replay + worst case,
                           calibration and a Geekbench-scaled device projection
tests/run_all.js           runs every suite in sequence; `npm test` calls this
test_engine.js             RULE 2: five canonical ground-truth damage scenarios (57 checks)
test_log.txt               the 30-turn ExtramePatriot vs LUIZ_LFN battle as a raw protocol stream
bench/bench.html           standalone on-device benchmark page (loads the engine, times a turn,
                           prints the device's own numbers) — the ground truth for Performance
package.json               npm scripts: `test`, `test:fast`, `e2e`, `e2e:headed`, `bench`,
                           `bench:json`, `bench:serve`
.github/workflows/ci.yml   runs `npm test` + the benchmark on every push and PR, plus a separate
                           `e2e` job that installs Chromium and runs the browser suite
.github/workflows/chaos-sync.yml  the monthly usage-overlay cron
CHANGELOG.md               how the engine got here, newest first
ATTEMPTS.md                every improvement that was tried and where it led, plus a similarity
                           index — read it before building a scoring change
tools/gen_abilities.js     regenerates lib/species-abilities.js from tools/pokedex.json
tools/gen_aliases.js       regenerates lib/species-aliases.js (needs the vendored calc bundle)
tools/pokedex.json         Showdown's dex snapshot the two generators read
tools/sync_chaos_sets.js   a Smogon chaos dump -> src/sets_usage.js (the monthly cron runs this)
tools/scout_replays.js     an opponent's recent replays -> src/scout_prior.js (what their own games reveal)
tools/fetch_replays.js    a ladder search -> the replay corpus (the only step of the weight pipeline that
                          downloads): `--sort rating` asks the endpoint for the best battles it has,
                          `--require-move` / `--exclude-move` keep or drop battles that clicked a move,
                          `--harvest` follows the players who use it, `--max-rating` draws a band
                          rather than only a floor, and `--input a.json,b.json` merges corpora into
                          one file, best-rated first
tools/extract_training_data.js  a replay corpus -> 128D rows labelled by the eventual winner
tools/benchmark_human_match.js  a replay corpus -> POLICY fidelity (not win prediction): how often the
                           engine's top line is the line an elite human actually clicked, by turn
                           bucket, with the action-space gaps a replay forces MEASURED and reported.
                           `--set` ablates a config tunable (deep-merged, refused if the path does not
                           exist in config.js, and read back after merging) and `--veto-off` suppresses
                           one veto rule, so a policy change can be priced against human agreement
                           before it is priced against a win rate
tools/fit_weights.js       IRLS logistic regression over those rows -> weights + a hold-out AUC
                           taken over whole battles, not over turns of one battle; `--crosses`
                           appends interaction terms to the fitted matrix (measured, not adopted)
tools/select_cross_features.js  screens products of the aggregate dims on the TRAINING half and
                           writes the candidate list `--crosses` reads — a selector, not a verdict
tools/train_mlp_residual.js     fits the optional residual head on the frozen linear model's own
                           residuals and then applies the identical battle-level hold-out plus a
                           paired bootstrap over battles; writes lib/mlp-residual.json (the
                           reviewable artifact, with the verdict) and lib/mlp-residual.js (the data
                           module the extension loads). `--no-early-stop` is a diagnostic only
.github/workflows/chaos-sync.yml  monthly cron: download the dump, resync the overlay, commit it
tools/run_arena.js         the adversarial league CLI: N battles against the three personas (full games
                           or crucible splices), optional set-mutation fuzzing, and `--harvest`,
                           which turns every loss into a regression puzzle
tools/headless_arena/sim_runner.js        the @pkmn/sim BattleStream wrapper; the sim resolves the
                           battle, the engine only picks
tools/headless_arena/replay_splicer.js   fast-forwards a real replay to its highest-leverage
                           volatile turn and hands both sides to the live agents there, reporting
                           the fidelity of the handover instead of assuming it
tools/headless_arena/league_agents.js     the three adversarial personas (meta anchor, anti-Trick-Room
                           clock staller, low-ladder chaos)
tools/headless_arena/mutator.js           adversarial item / EV / coverage mutation, every mutation
                           applied, validated and rolled back if illegal
tools/headless_arena/blunder_harvester.js the loss -> puzzle synthesizer and its safe appender
tools/headless_arena/teams.js             the five curated sample teams, validated against the sim's own
                           TeamValidator; its self-check now exits non-zero on an illegal sample
tools/headless_arena/engine_bridge.js     a DOM-free session that runs the REAL parser -> state manager
                           -> engine pipeline over protocol lines, and translates a frame into a
                           legal sim choice
tools/run_ablation.js      the config-flag ablation runner: one arena batch per feature variant on
                           a shared seed, a table of win/loss/tie deltas against the baseline, and
                           a paired bootstrap that says when a delta is only noise
tests/arena_check.js       the arena's own suite (157 checks; skips without @pkmn/sim)
tests/ablation_check.js    the ablation runner's suite (294 checks; the live batch skips without
                           @pkmn/sim)
tests/tactical_puzzles.js  the harvested-vaccine registry and runner; ships with zero puzzles
ARCHITECTURE.md            frozen interface contract every module binds to
```

## Verifying

```
node test_engine.js           #  57 checks: RULE 2 — five ground-truth damage rolls, frozen
node tests/run_tests.js       # 247 checks: the whole pipeline in a DOM-less sandbox
node tests/rule_checks.js     #  23 checks: the deductions, replayed from raw protocol lines
node tests/util_smoke.js      #  55 checks: dex access, item naming, type math, Speed maths, the lookup caches
node tests/injected_bridge.js #  23 checks: the MAIN-world WebSocket bridge (fake WebSocket/DOM)
node tests/config_check.js    #  85 checks: RULE 4 — the config is the only home for a heuristic
node tests/blackbox_guard.js  #  28 checks: RULE 1 — no handwritten math, 50,616 stats diffed
node tests/parser_fuzz.js     #  44 checks: RULE 3 — the real log, all its prefixes, junk lines
node tests/hardening_audit.js #  64 checks: the bug-hunt regressions + a 40-battle invariant fuzz
node tests/upgrades_check.js  # 118 checks: the mixed-strategy solve, the vetoes, the clock, damage evidence
node tests/chaos_sync_check.js # 70 checks: the chaos sync + the usage overlay (fixtures only, no network)
node tests/weights_check.js   # 264 checks: the downloader + the extractor + the fitter + the config adoption
node tests/cross_check.js     #  79 checks: the cross screening, the --crosses refit, and the refusal to adopt
node tests/hud_check.js       # 238 checks: the seven HUD extras (stub DOM), the bench-tap sandbox end to end,
                              #   their engine data, and the Cancel-window ponder's scheduling contract
node tests/discrete_check.js  # 110 checks: the 16 discrete rolls, the exact KO count, EV pinning, residual order
node tests/scout_check.js     #  78 checks: the scouting tool, the overlay, the pruner's re-weighting
node tests/pressure_check.js  # 151 checks: the PP-stall pivot, the volatility charge, the format sentinel
node tests/quiescence_check.js # 108 checks: the setup punisher, the boost table, the follow-up
                              #   weight (1.0 is an exact identity), the guards
node tests/profile_check.js   #  80 checks: the opponent profiler (deviation, labels, clamping)
node tests/entropy_check.js   #  48 checks: the scouting entropy and its assumed-response model
node tests/wincon_check.js    #  56 checks: the win-condition bounty (refusals, payout)
node tests/endgame_check.js   # 118 checks: the 2-body mate, the 3v3 box, the Speed chance node, the five
                              #   hardening leaves (simultaneous ply, recovery/Protect, physics, the
                              #   transposition cache, multi-world mates) and the rails
node tests/arena_check.js     # 157 checks: the arena — runner, splicer, agent legality, mutator, harvester
node tests/invariants_check.js #  17 checks: the solver's invariants over perturbed boards
node tests/ability_check.js   #  56 checks: the negative-space ability deduction (status, grounding, the gated absence rule,
                              #   and every observation that only LOOKS like proof)
node tests/tuning_check.js    # 252 checks: the tuning tiers — the Elo band, turn urgency (adopted), comeback mode,
                              #   the pivot tax (rejected), the 2-ply beam, the stratified active-set
                              #   worlds (which flipped their own default), the QRE opponent, the
                              #   surprise mask and the prior-anchored opponent response
node tests/preview_check.js   #  31 checks: the Turn-0 lead advisory (parser contract, 6x6 scoring, HUD card)
node tests/mlp_check.js       #  48 checks: the residual head's gate, fail-safe and clamp (it ships off)
node tests/dom_check.js       #  99 checks: the HUD's DOM lifecycle, driven through a stub parser
node tests/ablation_check.js  # 294 checks: the ablation runner — --set and its refusals, each flag in a real
                              #   engine, the feature table, the aggregation/bootstrap maths, one live batch
node tests/tactical_puzzles.js #   0 puzzles: the vaccine registry, green until a --harvest run writes a defect
node tests/human_match_check.js # 140 checks: the human-move-match benchmark — what a replay DOES and does NOT say,
                              #   including the pivot ceiling that bounds any switch-penalising change
```

The first suite loads every script in manifest order inside a DOM-less sandbox (so a load-order
mistake or a stray `document` access at import time fails loudly), then exercises: dex access,
Pokepaste parsing, the protocol → state pipeline (Heavy-Duty Boots proof, stint tracking,
recovery PP, Trick Room lifecycle, mega/Z locks), set pruning, damage math, both vectors, the
veto layer, the sampled worlds, the full `evaluateTurn` loop, the LLM bridge and the HUD
against a stub DOM. `tests/upgrades_check.js` covers the newer engine behaviour: the
mixed-strategy solver against matrices whose equilibrium is known analytically, its integration
into `evaluateTurn`, the three newer vetoes, the deliberation clock (driven with injected
timestamps, so it is deterministic), and the reverse-damage deduction. The last two suites cover
the offline tooling: `tests/chaos_sync_check.js` runs the chaos-sync generator and the usage
re-weighting against fixtures, `tests/weights_check.js` proves the corpus downloader labels a
replay only from the log's own `|win|` line and that the fitter recovers a planted weight vector
from synthetic rows with test AUC ≥ 0.8, and `tests/cross_check.js` proves the cross-feature
screen recovers a planted interaction from synthetic battles, refuses the sparse candidates its
share floor exists for, and left no residue in the engine.

The second one bypasses the fixtures and drives the deduction engine itself with battle lines:
Boots confirmed disproved and never credited to a Flying switch-in, the Choice lock from two
moves in one stint, Speed-floor pruning publishing its survivors, Knock Off connecting with and
without an `|-enditem|`, the format-lock cascade, and the sampler refusing to build a world that
contradicts a speed floor. The next two cover the modules the DOM-less sandbox cannot reach
(`util.js` in isolation, and `injected.js`, which only ever runs in the page's MAIN world).

`test_engine.js` is the ground-truth suite: five canonical damage rolls from a real ladder game,
each frozen to an exact number and required to match both the extension's `DamageEngine` and a
bare `calc.calculate()` call. `tests/parser_fuzz.js` replays `test_log.txt` — a real 30-turn
NatDex OU battle, raw protocol — through `ProtocolParser` + `BattleStateManager`, then replays
every prefix of it and ~40 malformed lines, and asserts the state neither throws nor desyncs.
`tests/config_check.js` and `tests/blackbox_guard.js` are the guards that keep Rules 4 and 1
from eroding: the first holds a 129-path inventory of every value the modules read and the
frozen 128D weight layout, the second diffs tens of thousands of stats against the library and
statically refuses to let a handwritten formula back into `src/`.

## The headless adversarial arena

`npm test` verifies the engine against protocol lines this repository typed by hand. That cannot
produce a surprise: the same person chose the lines and wrote the deduction. The arena is the
second, independent execution path. It drives the real `@pkmn/sim` battle engine, lets the engine
answer live decision frames, and reports what happened.

```
npm run arena -- --battles 20                     # full games against all three personas
npm run arena -- --battles 20 --mode crucible     # splice real replays from the crucible turn on
npm run arena -- --battles 20 --mutate --harvest   # fuzz the sets and write a puzzle per loss
node tools/headless_arena/teams.js                # self-check: are the five sample teams legal?
```

The format is pinned to **`gen9nationaldex`, which IS [Gen 9] National Dex OU** — it carries the
NatDex OU banlist (the lower ND tiers derive from it). `gen9nationaldexou` does not exist in the
sim: `Dex.formats.get('gen9nationaldexou')` hands back a Condition, not a Format, so a driver that
asks for it silently plays nothing. The arena runs the one format the extension plays on.

Four mechanisms, each with its own reason to exist:

* **The league** (`league_agents.js`) replaces self-play with three adversaries the engine cannot
  have been tuned for: a standard meta anchor on curated sample teams, an anti-Trick-Room clock
  staller that spends a 5-turn Trick Room timer on Protect/Bunker and immunity loops, and a
  low-ladder chaos agent on ε-greedy (ε = 0.15) play. Self-play echoes the engine's blind spots
  back at it; these three are blind in different places.
* **Crucible splicing** (`replay_splicer.js`) skips the opening. It scans a real replay for the
  highest-leverage volatile turn ≥ 8 — a faint, a hazard or screen going up, a >50% HP swing —
  replays the recorded actions through the sim up to that turn, and at that turn hands both sides to
  the live agents, so the game branches into a new timeline from a state a human actually reached.
  The handover is not assumed: the splicer builds the state it expected, compares it against the
  state it produced, and reports a fidelity score plus any recorded action the sim rejected.
* **Set mutation** (`mutator.js`) is fog-of-war stress. At a per-Pokémon rate it swaps the item the
  pruner expects for an off-meta one, creeps the Speed EVs, or injects an unexpected coverage move —
  each mutation applied, then validated through the sim's own `TeamValidator`, and rolled back when
  the result is illegal. Nothing here invents a set the validator would reject.
* **The blunder harvester** (`blunder_harvester.js`) turns a loss into a permanent regression test.
  It finds the Critical Blunder Turn — the turn whose evaluation score suffered the largest negative
  drop — and synthesizes a puzzle for `tests/tactical_puzzles.js`: the raw protocol prefix up to that
  decision frame, the line the engine should not have played, and the alternatives it should have
  considered. `appendVaccineToFile` duplicate-checks, compile-checks and appends it atomically. It
  also answers the terse call the brief names — `generatePuzzleCode(turnNumber, matchReport)` — which
  derives the same fields from the report's log for a caller that already knows the turn.
* **The report carries two different logs, and the difference is load-bearing.** `fullLog` is the
  omniscient public stream (what a spectator or a replay sees), and the sim never publishes
  `|request|` on it, so it holds no decision frame at all. `p1Log`/`p2Log` are each seat's own
  stream: the public lines PLUS that side's private frames, in the order a client saw them. Anything
  that replays the engine's own decisions — the harvester, and the `logPrefix` it emits, which has to
  end ON a decision frame — reads the side log. Reading the public log alone yields a harvester that
  returns a well-formed verdict while harvesting nothing, which is exactly what it did until the
  suite pinned the split against a real battle.

**A harvested vaccine is deliberately RED.** The engine is deterministic, so replaying the prefix
reproduces the ranking that lost the game: the puzzle fails until the engine is actually fixed, and
`npm test` fails with it. That is the point — a vaccine is a written record of a known defect, not a
passing test. Zero puzzles ship, which is why `tests/tactical_puzzles.js` is green today; after a
`--harvest` run, expect it to be red until the named defect is fixed.

## The ablation runner: which flag is doing the work

The arena answers "is the engine good?" with one win rate. It cannot answer the question that
blocks every tuning decision: **which** of the things deciding a move is doing the work. Every tier
in `src/config.js` ships gated — the mixed Nash solve can fall back to the legacy single-line
softmax, the five board-state vetoes can each be switched off, and the four optional tiers ship
inert — and the only way to price one used to be: edit config.js, run the arena, edit it back, run
it again, subtract the two numbers by hand.

`tools/run_ablation.js` runs that experiment. It spawns `tools/run_arena.js` once per variant, so
each batch is a separate process with one config patch applied before its first session is built,
and prints a comparison table:

```
npm run ablation -- --list                                  # the feature table and its patches
npm run ablation -- --battles 500 --parallel 4              # baseline + every variant in the table
npm run ablation -- --features nash,quiescence --battles 500
npm run ablation -- --battles 500 --out ablation-report.json
```

Each row carries **W / L / T and win %, loss %, tie %**, the **average turns per battle** with the
stall-tie share (a 100-turn tie is not a draw, it is a policy that will not commit), the delta
against the baseline, and a **95% paired-bootstrap interval** on that delta. Because a stall flag is
relative, the baseline's own stall level is printed **absolutely** as well: a corpus where the
baseline draws a quarter of its games at the cap reports "no stalls" on every row, so the runner
says the level out loud instead of leaving it to a reader's eye on a percentage column. Every feature also
records what its author *expected* (`helps` / `neutral`), printed beside the verdict, so a surprise
is visible instead of being averaged away.

Four choices make the numbers mean something, and `tests/ablation_check.js` pins each of them:

1. **One seed for every variant.** `run_arena` derives each battle's seed from (base seed, battle
   index), so a variant and the baseline play byte-identical games — pairing subtracts the variance
   of two independent draws out of the delta. The runner re-derives that from the records' own seed
   fields rather than trusting it, and falls back to an unpaired test (flagged `unpaired`) if the
   seeds ever drift.
2. **The patch is proven to have landed.** A child that silently ignored its flags would produce a
   perfect baseline-vs-baseline comparison, printed as "these features do nothing". Every variant's
   report carries the arena's own `appliedSets` echo, and a variant whose echo is short is a hard
   failure rather than a row.
3. **A misspelt flag fails loudly.** `--set` accepts only a path that already exists in
   `config.js`; an unknown leaf or section is a setup error. A benchmark that measures a typo
   reports the typo as neutral, which is the worst possible outcome.
4. **Significance, not sign, and the interval is the same quantity as the delta.** A verdict of
   `feature HELPS`/`feature HURTS` means the 95% interval excludes zero; anything else is reported
   as *no measurable effect at this sample size* — 500 battles puts the standard error of a win
   rate near 2 points, so a 3-point "improvement" is not a result yet. The interval is bootstrapped
   on the **win indicator**, so it qualifies the `Δwin` printed beside it. (Bootstrapping the
   win/tie/loss *score* instead once produced a +15.0 delta with a 95% interval of [+1.7, +12.5],
   i.e. a point estimate outside its own interval. The suite pins the two scales apart.)
5. **The verdict is about the FEATURE, not about the variant.** Every `laplace`/`veto`/`pruner` row
   is measured by switching its feature OFF, and the OFF variant beating the baseline means the
   FEATURE is the problem — so a verdict printed under a feature's name has to flip the sign, and
   the row says which way the patch pointed (`switching it off` / `switching it on`). A feature
   whose result contradicts its author's recorded expectation is flagged `surprise`.
6. **A row that reproduces the baseline in *every* battle is flagged `identical`**, because at any
   real sample size that is the signature of a flag whose input this harness does not supply rather
   than a verdict on the tier. The identical rows fall into three groups, and the distinction is
   the point: **verified harness gaps** — `laplace.volatility` needs the `|stacc|` accuracy snapshot
   that only the injected MAIN-world bridge emits, and `clock` only records a sample when it sees
   our own outgoing `/choose` line, which the arena never sends because its agent answers the sim
   runner directly; **documented controls** — `pruner.scout` and `usage` ship with empty overlays
   and are flat by construction, so a non-zero delta there would be the finding; and **unresolved**
   — the two reverse-damage pruners, the six veto rows and the three enabled tiers changed nothing
   at this sample and no cause is established for any of them. The two pruners carry an explicit
   UNRESOLVED caveat saying so; the rest are covered by the `identical` footnote. None of them is a
   "neutral" result, and the runner never prints one as such.
7. **A tier that is more than one decision gets a row per sub-knob.** `quiescence` re-prices two
   different replies — their setup move and their Protect — and it is split into `extendSetup` and
   `blockProtect` for exactly this reason, so `quiescence-extendsetup` and `quiescence-blockprotect`
   are rows of their own (`parent` marks the family). A 15-point result on the master switch says the
   tier is wrong; only the sub-rows say which half.
8. **The turn SHAPE is reported, not just its mean.** A baseline averaging 54 turns looked healthy
   while a quarter of its games were 100-turn draws, so each row also gets p50/p90/max turns, the
   count of games that reached the cap, and **how many of the 12 bodies a capped game actually
   lost** — a low count is a standoff between two walls, a high one is a grind that never resolved,
   and those need different fixes.

Every batch runs `--mode full`. A spliced battle hands the engine a recorded human line, which is
not comparable across variants, so the ablation never splices.

**What it has found so far** (numbers, intervals and the two instrument bugs the output exposed are
in [CHANGELOG.md](CHANGELOG.md)). **Read the quiescence paragraph below as HISTORY, not as the current
verdict.** Two early runs on the same seed found exactly one flag separating from noise at 60–150
paired battles — `laplace.quiescence` reading about **19 win points** against it, entirely in its
`extendSetup` half — and the mechanism the numbers supported was that pricing the opponent's boosted
reply as a certainty pushed the engine onto non-committal lines: the baseline drew **30.7 %** of its
games at the 100-turn cap, and those capped games had lost only **5.4 of 12 bodies**. **Both numbers
are superseded.** The instrument those runs used was handing the engine a one-Pokemon team
(`ATTEMPTS.md` §H), and on the fixed instrument the same tier measured **HELPS +20.0 [+10.0, +30.0]**
— while the self-play mirror then read the same patch **HURTS +23.3 [+8.3, +38.3]** (`ATTEMPTS.md`
§J). The current status is **DISPUTED, one instrument each way**, and §K's third pass (20 paired
battles per instrument, the new match-point scale) leans HURTS on both, on too little power to move a
shipped default. The tier ships ON; `ATTEMPTS.md` §C1/§J/§K are the register, and the run that can
settle it is named in §K3.

The second sweep priced the four newest tiers, and **exactly one cleared the gate: turn urgency**
(`laplace.urgency`), now adopted and on by default. 60 paired battles per arm, all three personas,
one seed: win rate **68.3 % → 96.7 %** (Δ **+28.3**, 95 % CI **[+18.3, +40.0]**), and the baseline's
**17 100-turn cap ties — every tie it played — fell to 1**. The other three rows came back flat for
three *different* reasons, which is the whole point of reading a flat row carefully: **`absence-rules`
provably fires** (176 of 624 pruner calls struck an ability for a silent switch-in over 12 battles)
and still changed no ranking, so it is unresolved rather than disproved; **`elo-band`** needs a
ladder rating @pkmn/sim never emits; and **`comeback`** scales a volatility charge the arena cannot
price. The sweep also exposed an instrument bug worth more than the result — `src/set_pruner.js`
reads its `pruner.*` tunables at LOAD time, so any `--set` on the pruner family was measuring
nothing; the arena now applies its patch from inside `loadHarness`, and
tests/ablation_check.js pins the ordering both ways.

A third run drove the ablation from the benchmark rather than the other way round, and it is the
sharpest argument for the gate's existence. The pivot tax (`laplace.switchTax`) raised top-1
agreement with 1,830-rated humans from **31.7 % to 44.0 %** and cut the engine's switch rate from
**55.4 % to 29.2 %** of contested turns (the humans: 33.8 %, so it ends up *under*-pivoting) — and then
cost **26.7 win points** (96.7 % → 70.0 %, 95 % CI **[-38.3, -15.0]**), restoring the 100-turn
standoff the repo had just spent a sweep removing (1/60 → 18/60 cap ties). It also damaged the half it
was built for: the MOVE half rises 35.0 % → 53.8 % while the SWITCH half falls **22.5 % → 16.5 %**, so
the aggregate climb is a composition effect rather than better pivot judgement. The tier ships OFF,
its row left in the table as the record that it was tested. The prologue matters as much as the
verdict: two competing explanations for the over-pivoting were measured and both refuted
(`quiescence.extendSetup` off moves top-1 by a paired net of **-21** and the pivot rate *up* to
54.2 %; suppressing VETO4 is a net of **-22** with the pivot rate flat at 53.7 %) — and on the turns
the human clicked a move the engine still preferred a pivot **39.0 %** of the time with a full
4-attack menu. So the behaviour is real, the mechanism is not the obvious one, and the obvious fix was
worse than the problem. The headroom is measured rather than guessed: on those pivot-over-attack turns
the engine's own best NON-pivot line was the human's click 55.8 % of the time, so a policy that never
pivoted while holding an attack would reach **45.2 %** top-1 overall against the shipped 31.7 % — the
ceiling this work was chasing, reachable by surfacing a line the engine already ranked rather than by
taxing every switch.

## The four rules this engine is built on

1. **No in-house math (the black-box rule).** Damage, type effectiveness and stats are never
   computed here. `src/util.js` delegates every stat to the library's own
   `calc.Stats.calcStat(gen, stat, base, iv, ev, level, nature)`, and `src/calc_engine.js` is
   the only caller of `calc.calculate(...)`. `ST.util.calcStat(stat, { base, iv, ev, level,
   nature })`, `calcHP(base, iv, ev, level)` and `statTable(species, { ivs, evs, level, nature })`
   are thin wrappers; `U.libraryReady()` reports whether the bundle is live. Delegating also
   fixed Shedinja, whose HP the handwritten formula reported as 112 instead of 1.
   `tests/blackbox_guard.js` diffs **50,616** stat values (1406 species × 6 stats × 3 natures,
   against two independent library paths) and all 324 type-chart cells, then statically scans
   `src/` and fails if a stat formula, a hand-typed type chart, a base-stat table, a
   `bp / 50 + 2` damage formula or a ±10 % nature step reappears outside `natureMultiplier`.
2. **A ground-truth test suite.** `test_engine.js` freezes five canonical damage rolls from the
   real battle and requires both the extension's wrapper *and* a bare `calc.calculate()` call to
   reproduce them exactly — so a nature, EV, item, ability, weather or status that stops
   reaching the library fails before any UI code runs.
3. **The real battle log is the parser fuzz corpus.** `test_log.txt` is that same 30-turn match
   as raw protocol (Switches, `|-mega|`, a Focus Sash `|-enditem|`, Regenerator heals, burn
   ticks, Imposter Transforms, a Future Sight that resolves into a fainted slot, Trick Room
   going up and down three times, and the `|win|`).
4. **One config file.** Every heuristic — weights, thresholds, probabilities, the LLM model ids
   and prompt, the HUD badge cutoffs, the pruner caps, the sampler's K — lives in
   `src/config.js` and is read through `ST.configGet(path, fallback)`. `tests/config_check.js`
   holds a 129-path inventory so no module can silently fall back to a literal, and proves a
   runtime `ST.configMerge()` reaches newly constructed engines. Game rules with a single
   correct value (Trick Room lasts 5 turns, Choice Scarf is ×1.5, the type chart, base stats)
   deliberately do **not** live there.

## Why the advice is a frequency, not a single line

A solver that always prints one line is readable: play it 100 times and a patient opponent knows
what is coming. The payoff matrix here is tiny (up to ~5 of our actions by ~9 of theirs), so the
engine solves it for a **mixed equilibrium** with fictitious play and prints the equilibrium
*frequency* of each line — "click this 70 % of the time, the punish 30 %" — which cannot be
exploited by a fixed counter-strategy.

* `laplace.nash.enabled` (default `true`) picks the solver. `confidence` becomes the equilibrium
  frequency, `score` the expected payoff against the opponent's equilibrium mix, and a vetoed
  line is excluded from the solve entirely (so it can never absorb frequency).
* Only the **live** submatrix is solved, and the tempo policy mask enters as a per-row delta so
  the Bunker/Protect nudge is folded into the matrix rather than overwritten by it.
* `laplace.nash.enabled: false` restores the original behaviour exactly: the pure risk blend
  (0.6·avg + 0.4·min over worlds) plus a numerically stable softmax at `laplace.temperature`.
* **On the iteration budget.** Fictitious play's *average* converges slowly (O(1/√T)) with a real
  oscillation, so the budget is set from measurement, not taste: against analytic 2×2 equilibria
  the worst frequency error is 0.06 at 50 rounds, 0.025 at 240 and 0.006 at the 2000 that ships,
  and a realistic 5×9 solve costs ~0.22 ms at 2000 rounds (~0.035 ms at 240) — noise beside the
  damage engine. `tests/upgrades_check.js` pins the tolerance at the measured 0.02.
* **Known approximation.** The matrix is treated as zero-sum (our payoff is their loss), but the
  payoffs come from a heuristic evaluator, so the mixture is the equilibrium of the *model*, not
  of the real game. That is the honest limit of any engine without a learned value head.
* `laplace.surpriseMask` (default `false`) prices what they cannot see. The matrix is built over their
  FULL reply list, so the equilibrium already knows about our unrevealed coverage move; with the tier
  on, the OPPONENT's half of the solve reads a copy in which a row for an **unrevealed non-STAB** move
  of ours is blended toward our best revealed-or-STAB row at `unrevealedWeight` (0.35), while our own
  rows are still scored on the true matrix against the mix that produces. A STAB move is never masked:
  it is readable off the species, so faking ignorance of it would be the telepathy backwards.
  `tests/tuning_check.js` §8 pins the classification, the cell-by-cell blend, and a fixture board where
  the unrevealed lure lifts their pivot frequency and the lure's true value with it.
* `laplace.nash.priorAnchored` (default `false`) anchors their response to a behavioral prior,
  `(1 - c) * regretMatch + c * P_prior` at `c = priorWeight` (0.25), with `P_prior` normalized from
  measurements only: each damaging move's average percentage into our active, a setup weight that
  depends on whether our active can 2HKO them, and a switch baseline that jumps to `switchEscape` when
  their active faces a guaranteed OHKO from a **revealed or STAB** move of ours and the incoming body
  resists it. It softens the opponent and leaves our own frequencies alone — `priorWeight: 0` and an
  absent prior both resolve to the shipped loop step for step — which is the direction `ATTEMPTS.md`
  E5 asked about, at one point rather than instead of the hard solve. `tests/tuning_check.js` §9 pins
  the identity and a fixture where the hard solve zeroes three of their replies and the anchored one
  weights all of them.
  Both of these ship `false`, and the first paired sweep left them there (`ATTEMPTS.md` §M): the mask
  bought 6 extra 100-turn standoffs for 3 wins and 3 losses and a match score that did not move at all,
  and the anchored mix engaged and changed no decision, which is the ceiling §L2 names — our own
  frequencies best-respond to their hard argmax index, so a softer opponent can only reach the score
  tie-break.

The blunder layer grew from four hard vetoes to twelve. Alongside protect-rhythm, ability
immunity, lone-TR-setter and speed-suicide, `src/veto_guard.js` now refuses:

1. **Contact suicide** — a contact move into a known Iron Barbs / Rough Skin / Rocky Helmet target
   when the recoil (1/8, 1/6, or 1/8 + 1/6 ≈ 29 % stacked) is enough to finish us, unless the hit
   KOs and the punishment never triggers.
2. **The Sucker Punch setup trap** — a *second consecutive* Sucker Punch into a healthy target
   that provably holds a setup/recovery/status move, because Sucker Punch only connects against an
   attacking move. The first one stays a legitimate read.
3. **Trick Room while Trick Room is up** — in Gen 5+ the move simply *fails* while the room is
   active (it neither cancels nor refreshes it), so re-clicking it can only waste a turn.

Five more followed, each reading one board fact rather than guessing, and each switchable off
through its own `veto.*` boolean (`veto.wastedHazardClear`, `veto.consecutiveProtect`,
`veto.magicBounceRedirect`, `veto.saturatedHazard`, `veto.redundantField`):

4. **A clear with nothing to clear** — Rapid Spin, Mortal Spin, Defog or Tidy Up with zero
   hazards on OUR side of the field. Court Change is exempt on purpose: it *swaps* the two sides,
   so it is live even when our side is spotless.
5. **Consecutive Protect** — a Protect-family move when our active used one on the previous turn,
   because the family cannot succeed twice in a row. A stale last use (two or more turns ago) and
   a use that never went off (we were taunted or encored) are both exempt: the counter is clear.
6. **A hazard into Magic Bounce** — the hazard does not fail, it lands on our side for free, which
   is strictly worse than not clicking it. Only grounds we can point at count: a revealed or
   battle-confirmed ability, the believed set (`liveSet`), or the species' possible abilities.
7. **A hazard already at its cap** — Spikes stop at three, Toxic Spikes at two, and Stealth Rock,
   Sticky Web and the two axe-edge setters at one; past the cap the move sets nothing. The caps
   and the state keys are `U.HAZARD_LAYERS`, so the guard holds no literal of its own.
8. **Re-setting the weather that is already up** — a weather move while its own weather has more
   than `veto.redundantFieldMinTurns` (2) turns left; at one turn left the refresh is the correct
   line, which is exactly where the threshold sits. Terrains are deliberately not judged, because
   their remaining turns are not tracked as reliably.

None of the five vetoes a signal it cannot read: an unreadable hazard record, a missing weather
countdown and an opponent with no ability grounds all fall through to the next check.

## Quiescence: the two replies the matrix used to price as no-ops

The simultaneous matrix prices **one turn**, and two of the opponent's replies are not damage. Both
used to be read as no-ops, in the two directions ladder games are actually decided by:

* **Their setup move.** Dragon Dance deals no damage and changed no state, so "they click Dragon
  Dance" scored as a free hit for us: the cell had no idea that the +1 Atk / +1 Spe it grants
  arrives on the *next* turn. The engine walked into the sweep it had just paid itself to ignore.
* **Their Protect.** A shield being up did not block our move either, so a line that KO'd their
  body kept its lethal bonus straight through it: the matrix believed a Protect could not save
  them.

`laplace.quiescence` re-prices both, from **game rules only**. The stages a setup move grants live
beside `SETUP_MOVES` in `src/util.js`, because the vendored dex cannot answer the question (it is a
damage calculator, and to a damage calculator a stat boost is an *input*, not an effect), and they
are applied by `ST.DamageEngine` as a per-call override. No file under `src/` computes a damage
number by hand.

* Their **setup** reply is extended exactly one exchange: they keep the stages their move grants,
  their best attack lands again from that boosted state, and our row's own move is repeated. One
  ply, not a tree.
* Their **Protect** reply can block our move for the turn — and **this half ships OFF**, on its own
  row's reading at 60 paired battles (`ATTEMPTS.md` §K6).
  Blocking the hit is the rule. What the cell cannot represent is that a **repeat** Protect fails in
  game, so `shielded` reads the action and never the chain: a shield-spammer's column prices as a
  free turn for them *every* turn rather than one turn in two, and the 1-ply model then reads every
  committing line as worth 0 (`tests/quiescence_check.js` §3b pins the no-decay cell). Pricing that
  block inside a one-turn cell makes the engine pivot and
  grind instead of committing, which against the Protect-heavy `exploiter` persona is worth about
  fifteen win points (its seat goes **4-0-11 → 13-0-2** when the block is off, Δwin **+15.0
  [+6.7, +23.3]**, Δscore **+7.5 [+3.3, +11.7]**, cap games **11/60 → 2/60**). The mirror cannot price
  it at all (`identical`), so the ablation row turns it back **ON**. A second seed with the seat to
  itself is worse still: block **ON** drops that seat to **16.7 % (10-0-50, 50/60 capped)** against the
  shipped **86.7 % (52-0-8)**, Δwin **−70.0 [−83.3, −56.7]** — and the same run confirms the `extendSetup`
  half stays ON (removing it costs **−40.0 win [−55.0, −25.0]**). The block itself is still fully covered
  by `tests/quiescence_check.js` whenever it is on.
* `laplace.quiescence.enabled` (default `true`) is the master switch, and `extendSetup` (default
  `true`) and `blockProtect` (default **`false`**, see above) are each switchable on their own. Any
  of the three set to `false` restores the raw 1-ply payoff **bit-for-bit**, the same contract
  `nash.enabled` and `volatility.enabled` keep.
* **Guards, because a one-turn model has no business implying certainty.** If our move already
  finished them this turn, the extension does not apply at all: a fainted body keeps no boost and
  attacks no more, which is exactly the "KO the setup user" line the feature exists to reward. A
  setup they cannot pay for fails in game (Belly Drum needs more than half HP, Clangorous Soul more
  than a third), so it prices as the wasted turn it is. And their **recovery** replies are
  deliberately *not* priced: Recover-class healing varies by move and by weather, so it stays the
  legacy no-op rather than an invented number.
* **The turn-2 order, and how much of it to price.** `respectTurn2Speed` (default `true`) orders the
  extension's second exchange by the Speed each body will actually have there — the boost applied,
  Trick Room and move priority included — so a body that faints first does not act, and "boost, then
  kill the setup user" is no longer priced the same as "boost, trade". `followUpWeight` (default
  **1.0**, the identity) scales how much of that second exchange is charged: 0.5 prices half of it,
  0 values the boost with no second hit. It exists because the mirror and the personas disagree about
  the tier (`ATTEMPTS.md` §J) and one candidate explanation was that a full-strength Turn-2 boosted
  hit over-prices caution against a rational opponent. It was measured and came back **DISARMED**
  (§K3): the damped arm did not recover the mirror's harm, so the hypothesis is not the lever.
* **Stated approximations.** Their Protect is not re-checked on the second turn; their *damaging*
  replies keep the pre-existing symmetric treatment. The published score is the same zero-sum
  quantity it always was.

* **What it costs.** The extension buys damage calls, not `_payoff` calls: a cell whose reply is a
  damaging move is untouched, a Protect cell makes one *fewer* call (our hit is skipped), and a setup
  cell makes `theirModelledMoves + 1` more. Measured on a two-body board (5 rows x K=6) where their
  reply space holds a setup move, the turn goes from **13.5 to 18.4 ms (+4.9 ms, +36%)**; the shipped
  per-turn benchmark, run with the feature on by default, still reports p50 66.6 ms / p95 94.2 ms with
  the same 432 `_payoff` calls per busy turn, and the suite pins the per-cell counts. It is a config
  flag (`laplace.quiescence.enabled`) rather than a constant because that trade is a taste, not a fact.

`tests/quiescence_check.js` (108 checks) pins the table's completeness, the override contract it
rides on, the arithmetic of the extra exchange as identities against the damage engine's own
numbers, the three guards, purity and the cost.

## The four gated tiers

Four more tiers exist, one file each, and **every one of them ships `enabled: false`**. That is not
modesty: this repository's rule is that a change to what the engine *plays* earns its place by being
measured, and none of these four has a measurement yet. What each one is, and what turning it on
would mean:

* **`src/opponent_profile.js`** (`laplace.profile`). Fictitious play solves for the equilibrium of a
  perfectly rational opponent; a ladder human is not one. The profiler scores each observed reply
  against the frequency the engine's **own** matrix published for that reply, and exposes one bounded
  `switchFactor` that re-weights the opponent's pivot columns — exactly 1 until `minSamples` scored
  observations exist, so it is inert on a fresh battle. The observation feed is deliberately narrow:
  `_observeOpponent` records a pivot only when the body the engine priced is still on their team and
  alive (a faint swaps the body too, and a replacement is not a choice) or a move when exactly one
  new move was revealed, and stays silent otherwise. A profiler fed guesses is worse than one fed
  nothing.
* **`src/information_gain.js`** (`laplace.scouting`). Shannon entropy over the opponent's surviving
  candidate sets, and the reduction a single observed answer would buy. Its one assumption is named
  in the file: the answer is their best damaging move, and the sets eliminated are the ones whose
  known moves exclude it. Wiring it exposed a fact worth stating: the entropy is a property of the
  *pool*, identical for every one of our rows, so it is published as a readout and cannot move the
  ranking until a row-dependent reveal model exists.
* **`src/wincon_bounty.js`** (`laplace.wincon`). Names the body the **measurements** say stands
  between us and our best line — our hit does not KO it, its answer hurts most — and pays a capped
  bounty once that body is fainted on the simulated board. This is the one tier that can outrank raw
  damage, which is exactly why it is capped in config and off.
* **`src/endgame_solver.js`** (`laplace.endgame`). With few bodies left the branching factor collapses
  and a bounded alpha-beta search runs instead of one turn of the matrix. Its value as specified is a
  **readout** (`lastReadout.endgame`: the line and its `mateIn`), not a policy change: a proof of a
  forced win is published for the HUD and the LLM to show. It refuses outside its competence —
  `maxAlive` **3** (so a 3v3, 3v2 or 2v3 board is searchable), `maxBranchingMoves` 12 and a hard
  `nodeBudget`; an exhausted budget reports `{solved:false, reason:'budget'}`, never a partial line
  dressed as a solution. The rail that matters is Speed: when both orders agree the pair is decided,
  and when our exact Speed lands inside their `[speedFloor, speedCeiling]` band the order is a fact we
  do not have. `chanceNodes` (default `true`) prices that pair as the expectation over the two orders,
  weighted by their own surviving candidate sets, instead of refusing the solve — but **a mate is never
  claimed through one**, because a proof cannot rest on a coin flip.
  Five further leaves, all defaulting ON because they are corrections rather than preferences, are the
  2026-10-15 hardening pass: `simultaneousPly` solves the turn as the small zero-sum matrix a turn of
  Pokemon actually is (the body it replaced was `max_i min_j` — the price of an opponent who reads our
  hidden turn-t action), `includeRecoveryAndProtect` makes `Recover`/`Roost`/`Slack Off`/`Soft-Boiled`
  and `Protect` ACTIONS instead of a free turn (a heal only while its body still stands when the action
  resolves, a shield only while that side's chain is broken), `modelPhysics` charges entry hazards on a
  replacement and ticks Trick Room's timer and the end-of-turn burn/poison and Leftovers chip,
  `transposition` memoises a board (HP bucketed into `ceil(hp / 5)`, exact `0` preserved, full-window
  values only, so a fail-high bound cannot be cached under an exact key) so move orders that meet in
  the same position stop paying twice, and `solveAcrossWorlds` reports a mate only when **every**
  surviving world proves one with the same root action, carrying the best worst case otherwise.
  `tests/endgame_check.js` §6 pins the 3v3 mate (found in 64 nodes) and lands the blended row
  between two certain-order references; §7 switches each of the five leaves and pins what it changes —
  including the chip helper that was handed the side OBJECT rather than its name, so every end-of-turn
  chip had been a silent no-op until §7c ran it. `LaplaceEngine` calls `solveAcrossWorlds` (pinned in
  `tests/run_tests.js`), so a published mate has to hold across every sampled world.

All four publish on `lastReadout` (`profile`, `scouting`, `wincon`, `endgame`), which is what the HUD
and the LLM bridge already read; `src/ui_overlay.js` does not render them yet.

## The seven HUD extras

All of these are rendered by `src/ui_overlay.js` from data the engines already produce — the HUD
computes no game logic of its own, and every threshold it colours against is in `config.js`.

1. **The bench-tap sandbox.** Tapping an opponent bench pill swaps the move buttons' previews to
   that body: `LaplaceEngine.preview(mon, state)` runs each legal move through the damage engine
   and `previewVsBench` resolves the tapped species. Tapping the same pill again returns to the
   active pair, and the selection is dropped the moment that body leaves the bench.
2. **The lethal-roll gauges.** The same preview drives a colour-coded bar per button — green for a
   guaranteed KO, gold/slate for a KO chance at or above `hud.lethal.high`/`mid`, grey for no
   chance — with the verdict spelled out (`54–64% (2HKO)`, `0% (Immune)`, `68% KO chance`). The
   KO probability is the calculator's own `koChance`, not an estimate.
3. **Detective-Unmasked badges.** Every deduction the engines proved is surfaced as a badge:
   Heavy-Duty Boots confirmed by a hazard-free entry, the Choice lock broken by two moves in one
   stint, and the format lockout once their Mega or Z-Move is spent (with the number of bench
   bodies that can therefore hold neither).
4. **The Trick Room haptic.** On the turn Trick Room drops to its last one, the chip repaints gold
   (`tr-gold`) and `navigator.vibrate(hud.vibrate.pattern)` pulses once for the battle. Silent on
   platforms without the Vibration API, and never thrown. The gold chip always appears; the pulse
   additionally waits for the page to have been touched at all, because Chromium refuses the call
   (with a console error) in a frame the player has never tapped — a battle has been tapped, a
   spectator tab has not.
5. **The Supreme Overlord gauge.** `LaplaceEngine.overlordGauge` reads the ability's multiplier
   *out of the library* — the same probe move against the same probe defender, with
   `alliesFainted` set to the real count and then to zero — and scales the library's own Attack
   stat by the measured ratio, so no rule of the ability is written down here (RULE 1).
6. **The match receipt.** `state.battleStats` counts damage, KOs, Trick Room turns (and the turns
   actually attacked under it), snow turns and Magic Bounce activations straight from the log;
   on `|win|` the boot assembles them into a card with a `Copy Summary` button. Nothing on it is
   estimated — a stat with no data reads as zero.
7. **The Cancel-window alert.** After the fast pass paints the HUD, the boot schedules a DEEPER one in
   a timeout (more worlds, the 2-ply beam, the endgame solver at its 3v3 bound) and never blocks a
   frame doing it. If the player has already clicked and Showdown's own `undoChoice` button is on
   screen, the deeper ranking is compared with the line they locked in — the deeper pass vetoes it, or
   beats it by `laplace.deepPonder.cancelAlertScoreDelta` payoff or `cancelAlertConfDelta` confidence
   points — and the button is flagged with an `UNDO → <line>` badge plus a buzz. A monotonic ponder
   id bumps on every new turn, init or decision frame, so a stale pass publishes nothing, and every
   teardown path releases the flag. `tests/hud_check.js` §14 pins the scheduling contract and
   `tests/dom_check.js` §11 the DOM lifecycle. Read it as a UI hint, not as a gate-adopted opinion:
   its deeper ranking inherits `beam-2ply` (which cleared the mirror gate on ONE seed at n = 60 and
   did NOT replicate on a second, so it ships OFF — `ATTEMPTS.md` §L3) and the endgame tier
   (still flat/unpriced at this sample — §K4).

The first real-browser pass over this HUD found a defect the stub DOM could not: `_el()` added a
compound class name through `classList.add`, which throws `InvalidCharacterError` in a real DOM,
so `renderTRChip` died on its first call and the TR chip never appeared at all. `_el` now adds one
token at a time. `tests/hud_check.js` covers the new entry points in the DOM-less sandbox; the
browser pass is what caught that one.

## Desktop viewports

The HUD is laid out for both a phone and a desktop browser, and picks on its own: `hud.layoutMode`
(`auto` | `mobile` | `desktop`, default `auto`) resolves against `hud.layoutBreakpoint` (1024 px,
viewport width), and an explicit mode always wins. The resolution is published as `data-st-layout`
on `documentElement`, and the desktop rules in `styles/overlay.css` are scoped to it — so lobbies,
the options page and the test harness keep the phone layout untouched.

Showdown's desktop layout puts the battle arena in a **fixed 640 px column at x=0** on both clients,
with the scrollable battle log entirely to the right of x=640, so the desktop HUD docks a single
`.st-console` column under the move bar at x 0..640 and never touches a PS control, the log or the
topbar. On a phone the same five elements are `position: fixed` nodes in `<body>`, as before.

A small **📱/🖥️ pill next to the TAC button** switches between the two at any time; it blurs itself
after the click so it can never hold keyboard focus (Showdown's own chat and shortcuts stay
reachable). The choice persists to `chrome.storage.local` (and to the page's `localStorage`, so a
restored tab paints correctly on its first frame), is mirrored into other open tabs, and has a
matching radio on the options page.

## The six "sweaty" upgrades

Six further upgrades, all of them built on the same discipline: a number that exists in the game
is **read** (from the protocol, from the page's own battle object, or from the vendored library),
and never written down here. Each has its own config switch and each degrades to *no output at
all* rather than to a guess.

1. **The exact 16 rolls.** Damage is not a continuous interval — it is one of 16 integer rolls, and
the library hands them over. `DamageResult.rolls` exposes them verbatim, `koChancePct` becomes the
exact share of rolls that reach the defender's current HP (7 of 16 is 43.75 %, not a span
estimate), and `rollPercent(v)` is the inverse an observation needs. The old uniform-span
estimate remains the fallback for the one case the library gives no roll list: a fixed-damage or
multi-hit move.
2. **EV pinning.** The same observation, asked exactly: the printed percentage must be reproducible
by one of the candidate's own 16 rolls. This runs as its own pass over what the range test
accepted, and when it would eliminate *everything* it is abandoned (with a reason) instead of
emptying the pool or discarding the range verdict. Collapse a pool to one EV vector across two
independent observations and the mon is marked `evPinned` with its exact spread named — one hit
never pins, because one hit can fit several spreads by coincidence.
3. **Residual-order Speed evidence.** End-of-turn residual damage and healing resolve in Speed
order, so two residual lines for opposite sides back to back prove the first body is faster. The
parser asserts only the ORDER (and only when nothing but residuals sits between the two lines);
`pruner.applyResidualOrder` turns it into a floor/ceiling against the other body's believed Speed,
and refuses to bite when that would leave no candidate standing.
4. **Replay scouting.** `tools/scout_replays.js` mines the opponent's own recent replays — offline,
never at runtime — into `src/scout_prior.js`, which re-weights their candidate sets. It records
only what a log can support (species, revealed item, ability and clicked moves) and can never add
or remove a set: EVs, natures and IVs are not in a replay, so they are not in the overlay either.
It ships empty, and an unseen species keeps every curated weight untouched.
5. **The PP-stall counter and the 3-way pivot.** Max PP is game data, so it is read: `injected.js`
snapshots the page's own battle object and forwards `|stpp|` lines, and the `|request|` payload
gives our side's numbers outright. The gauge answers "how many of MY Sucker Punches are left" —
with no number it prints how many uses we have *seen* and never a denominator — while the threat
side lists their setup/recovery moves that stall the move out. The pivot matrix is built from the
engine's own payoffs and solved with the same fictitious play the main decision uses.
6. **Risk-adjusted volatility plus the format sentinel.** A 70 %-accuracy move keeps its damage
minus `accuracyWeight·(1−acc)·payoff`, and pays a fragility charge when a miss would eat a lethal
counter-hit — so a Trick Room turn stops being a coin flip on Focus Blast. Accuracy is measured
too: the vendored bundle ships none, so `|stacc|` reads it from the client's own dex, and a move
whose accuracy is unknown is charged nothing. The sentinel prints what their spent mechanics prove
— Mega burned, Z burned, and therefore what the unrevealed bench can no longer hold.

## Telemetry, inference and the optional data sync

Three upgrades work outside the solver, and each one is explicit about what it does and does not
know.

**The opponent clock (`src/opponent_clock.js`).** The server only reveals a turn once both
players have submitted, so `turnResolution − ourSubmit` is an upper bound on how much longer the
opponent took than we did — and the smallest value a battle ever produces is that connection's
own noise floor (round-trip plus resolution). The clock learns that floor from the battle itself
and labels each completed turn `auto`, `normal` or `agonised` from what is left after subtracting
it. It needs `clock.minSamples` samples before it says anything but `unknown`, and a disabled
clock is inert. It changes exactly one thing: when the reading is fast enough
(`clock.switchKeepThreshold`), the opponent's **switch replies leave the relay space** in
`laplace_core.js`, because a body that answers the instant we do is not studying the switch
screen. The agonised direction cannot add replies the engine already enumerates, so it is HUD
telemetry only — stated rather than pretended. The thresholds and the priors are heuristics with
the same standing as `tempo.rhythmHurt`.

**Reverse damage deduction (`src/set_pruner.js`).** We know our own body exactly, so a hit we
take is a measurement of *their* offence: `|-damage|...|[from] move: X [of] p2a: Y` is stored on
the attacker and run back through every candidate spread. A set whose maximum roll is below what
we took (or whose minimum exceeds it) is dropped, with the reason recorded on the mon. It is the
most speculative rule in the file, so it is fenced: a generous tolerance band
(`slackPct` + `slackRel`) absorbs integer HP rounding and rolls we did not see the extremes of, a
critical hit is flagged at the source and never used, fixed-damage and weight/speed-ratio moves
are skipped outright, and if one observation would eliminate *every* candidate the observation is
discarded rather than the database (an unmodelled Z-move is likelier than the sets being wrong).

**Data automation.** `tools/sync_chaos_sets.js` turns a Smogon chaos dump into
`src/sets_usage.js`, and `.github/workflows/chaos-sync.yml` runs it on the 3rd of every month and
commits the result. The overlay only **re-weights sets that already exist**
(`ST.SetDatabase.reweightByUsage`), by how often that species actually holds that item; an item
or species the dump never mentions leaves the curated weight untouched, because a missing
measurement is not a zero measurement. It ships empty, so nothing changes until a maintainer or
the cron fills it in. See the deviations section for why it is an overlay and not a regenerated
`src/sets_db.js`.

The same offline philosophy applies to the weights themselves, in three steps that are split so
that only one of them touches the network: `tools/fetch_replays.js` searches a ladder, downloads
the replays and writes the corpus (labelling each one from the log's own `|win|` line, through
the side table the log declares, and skipping rather than guessing when it cannot resolve one);
`tools/extract_training_data.js` turns that corpus into 128D rows labelled by the eventual
winner; and `tools/fit_weights.js` fits them by IRLS with an L2 ridge, reports a train AUC-ROC and
a hold-out AUC-ROC taken over whole battles, prints a ready `evaluator.weights` snippet, and lists
every dim the corpus barely observed (`lowSupport`) so an adoption has to decide about each by name.

The last question asked of that pipeline was whether it pays to add interaction terms. A single
dot product cannot say "Kingambit is only worth this once its allies have fainted and no
Fighting-type is left", and a product of two dims the evaluator already measures can — so
`tools/select_cross_features.js` screens every pair of the aggregate and active-mon dims (squares
included; the per-slot HP/faint dims and the pairwise threat matrix are excluded, because "slot 1
x slot 4" cannot transfer between battles) on the **training half only**, and `--crosses` refits
with the winners appended. **On this corpus the answer was no.** The screen's 16 picks (Trick
Room turns x hazard differential, the opponent's paralysis count x their spent recovery, my sleep
x my spent recovery, ...) scored **0.7005** projected on the battle-level hold-out against the
adopted vector's **0.7049**, and the raw 144-coefficient fit scored **0.6922** — worse, which is
what selecting the top of a few thousand noisy candidates on the training half looks like. The
best four-cross subset did post **0.7061**, but its +0.0012 did not survive a paired bootstrap over
battles (median **0.0000**, 95 % CI **[-0.0047, +0.0015]**, ahead in **41 %** of resamples). So no
cross block was adopted: `--crosses` and the selector stay so the next corpus can be tested with
one command, and the cross path is otherwise inert — a 128-dim fit and the shipped artifact are
unchanged, which `tests/cross_check.js` pins.

One property of the replay search is worth knowing before pointing the fetcher at it: the rating
sort on the replay browser is a **server-side** query, not a re-sort of what came back.
`search.json?format=gen9nationaldex&sort=rating` asks the endpoint for the best battles it has
ever recorded for that format — 51 to a page, and the window ends at page 100 — whereas the
default walk only ever sees the recent window. `--sort rating` now sends that sort upstream, which
is what made a high-rated corpus possible at all; before it existed the corpus was simply whatever
was recent, which is why the first one was 128 battles at rating >= 1300.

The training has been re-run in two passes since. The first built a balanced corpus on the best
battles the ladder has: the **5,001 highest-rated `[Gen 9] National Dex` battles the endpoint
holds** (ratings 1778-1992) were downloaded — a log has to be read to know whether a battle clicked
a move, because the endpoint cannot search by move — and **303 of them used Trick Room**. The 98
players who clicked it were then followed with `?user=`, which added 1,677 further candidates (a
followed player's discovery pass is not re-downloaded: `download()` re-uses the logs it already
holds), and the 300 best-rated Trick Room battles were kept. A second pass over the same window with
`--exclude-move trickroom` kept the battles with no Trick Room at all — 300 and 307 of them, the
607-battle corpus the paragraphs below call the small one.

The second pass went after volume, because volume is what moved the number. **2,606 further elite
battles** came from the same rating-sorted window (roughly 1,800 of it is still undownloaded), and
two lower bands were drawn from the newest-first window — the only one that reaches below the sorted
window's floor: **299 battles at 1600-1749** and **507 at 1300-1599**, drawn with `--min-rating`
plus `--max-rating` — the ceiling is what makes a band rather than only a floor selectable at all.
The bands are not contiguous and one of them is empty: the corpus's own histogram is 507 battles at
1300-1599, 299 at 1600-1749, **none** at 1750-1777 and 2,906 at 1778+. That gap is real and stated
rather than smoothed over — a deliberate 1700-1777 fetch found 28 battles, only three of them above
1750, which is why nothing lands in that band. Merged through `--input`, the corpus is
**3,712 battles, ratings 1300-1992, mean 1760**, and it replaces — and deletes — the old
128-replay, 1300-rated corpus.

The extractor turns those battles into **111,820 labelled turn rows** (61,711 positive, about 30
rows a battle) over the same 128 dimensions, and the fitter **converges**, in 35 IRLS iterations at
λ = 0.5 with `--max-iter 200`, instead of dying at the old 25-iteration cap. λ is flat here — 0.1,
0.5, 2 and 5 all land within 0.0001 of each other — so 0.5 is kept as the default rather than
chosen. The artifact is written to `lib/trained-weights.json` and reports **AUC 0.7513 train /
0.7011 hold-out** over **89,982 train / 21,838 test rows**, the hold-out now taken over whole
battles rather than over turns: `holdoutBattles` is **3,703** because nine of the 3,712 battles
contributed no rows at all and a battle with no rows no longer consumes a hold-out slot.

Getting that hold-out honest was the first fix, and the caveat matters more than the digits.
`splitIndices` used to hold out every k-th **row**, and rows are consecutive turns of one battle, so
every held-out row's neighbours sat in the training set — within-battle leakage. It now accepts the
per-battle row counts the extractor writes, holds out every k-th **battle**, and reports
`holdoutBattles` / `groupedHoldout` next to the AUC; the old row-level split still runs when no
provenance is present (or when a provenance map does not add up — then `provenanceIgnored` says so),
because the tests pin that path. The row-level figure on this pipeline was 0.7975, the battle-level
figure for the shipped artifact is **0.7011**, and the first corpus's 0.9360 was measured the same
leaked way — none of the three are comparable to each other.

What actually improved the model was elite **volume**; the diversity bands were nearly a rounding
error at this size. With the battle-level hold-out: the 607-battle elite-only corpus scored
**0.6472**; growing that same elite band to **2,906 battles scored 0.6979**; adding the mid and low
bands on top gives **0.7011** in the shipped artifact. In that same comparison run the banded fit
scored 0.7002 on held-out elite battles against 0.7063 on held-out mid/low ones (that run printed
0.7018 overall before the zero-row fix described above moved the shipped figure to 0.7011). So
+0.050 came from elite data and **+0.002** from the bands. A 10% hold-out (every 10th battle)
reports 0.7244, which puts split variance at roughly ±0.02 — the band effect is inside that, so it
is reported as small rather than as established.

The first version of this section claimed the opposite, and that claim was measured on the small
corpus, so both results stand and both are kept. With only 607 elite battles, an equal-row-count
experiment favoured diversity: 14,336 elite rows scored 0.6472 while 14,072 rows in which every
third elite battle was replaced by low-rated ones scored **0.6670**, and a control trained on the
low band alone (230 battles, 1300-1709) scored 0.6210 on elite battles against the elite model's
0.6472. Diversity beats size when the elite sample is small; at 2,906 elite battles, volume beats
diversity. The bands are still in the shipped corpus because +0.002 costs nothing.

Diagnostics on the shipped fit, over held-out rows: Trick Room battles score **0.7185** against
**0.7005** for battles without it, and inside the elite band 0.6873 against 0.7014, so Trick Room
lines are ranked at least as well as the rest. The probabilities are a ranking aid rather than
odds: Brier **0.2178**, where a constant 0.5 would score 0.25.

The audit that produced these numbers also found five defects in this pipeline, and each is fixed
and pinned. A followed player's battles are matched to the window's format through the **replay id's
own prefix** (`gen9nationaldex-…`), never as a substring of the human label: the label test admitted
`[Gen 9] National Dex UU`, `… AG` and `… Doubles` into a National Dex corpus, and the id is the only
exact format test the endpoint offers. A hit carrying no rating is treated as 0, so it can no longer
enter a rated corpus through the harvest or the merge when the window path rejected it. `--harvest`'s
discovery pass now obeys `--max-downloads` and the rating ceiling (it used to overrun both), and
`attempted` in the corpus file counts the run's requests across both passes instead of only the
last one. A page that comes back as a non-array — an error page rather than an exhausted window — is
an error instead of being read as "no more battles", and a page that merely contributed no candidate
no longer ends the walk: that single rule is why the 1600-1749 band reported 20 replays before the
fix and 299 after it, and the 1300-1599 band 307 before and 507 after. In the fitter, a provenance
map whose row counts do not add up to the rows being fitted is refused rather than absorbed — the
split falls back to rows and reports `provenanceIgnored` — and a battle that contributed no rows no
longer consumes a hold-out slot.

Neither the artifact nor the fitter rewrites `src/config.js` on its own; adopting `spec` into the
live `evaluator.weights` is a separate, verified step, and it has now been taken. The artifact
stores the **fit**, not the search behind it: `lambda`, `samples`, the split, `aucTrain`/`aucTest`,
`weights128`/`weightsFull`, the `spec`, and `lowSupport` — every dim the corpus observed in fewer
than 20 rows, with those counts. The corpus itself is not in the repo — it is 3,712 third-party
logs — so the format, sort, rating floor and band a corpus was drawn from live in the corpus
payload (which is not shipped), never in the artifact. Regenerating therefore means re-running the
pipeline: fetch the elite window, fetch the two lower bands, merge the corpora through
`--input a.json,b.json`, extract, then fit. The exact invocations are the examples in the header
comment of `tools/fetch_replays.js`.

The adoption itself needed three measurements, because `spec` is not the raw fit and the engine
does not consume the vector in isolation.

* **The projection is free.** `spec` is what a fitted vector becomes once it has to be expressed
  in config's readable groups: the 36 threat cells collapse to two means, and the twelve-dim HP
  and fainted blocks each to the single +/- value the builder can produce. On the artifact's own
  battle-level hold-out the projected vector scores AUC **0.7049** against **0.7011** for the raw
  128 coefficients, and both beat the hand vector's **0.6703** on the same rows; a paired
  bootstrap over battles puts the projected-versus-hand gap at **+0.028 [+0.017, +0.047]**.
* **The scale is a policy choice.** A logistic regression's overall scale is arbitrary — AUC is
  scale-invariant — but `_payoff` adds `evaluate()` to *fixed* bonuses (`laplace.lethalBonus` 260,
  `switchAteHitBonus` 25, the volatility charge), so a fitted vector pasted at its native scale
  would shrink the evaluator's influence about 52x and let those fixed terms decide alone.
  `evaluator.fitScale: 52.2` restores the spread the hand vector had — raw-score sd 93.3 versus
  1.788 over the corpus's 111,820 rows — so the adoption changes *which* states rank higher
  without changing *how much* the evaluator matters.
* **Two dims are not measurements.** The fit put +54.7/-50.3 on the two accuracy-boost dims from
  **5 and 17 non-zero rows** out of 111,820; five lucky rows can pin a coefficient of any size.
  The fitter reports such dims under `lowSupport`, the artifact records their counts, and the
  adopted config zeroes exactly those two. They fire in 0 and 2 of the hold-out's 21,838 rows, so
  the zeroing does not move the AUC above. `tests/weights_check.js` pins the chain end to end: the
  live weights are the artifact spec at four decimals with those dims zeroed, and `fitScale` is
  applied by the evaluator.

### The residual head (Wide & Deep): fitted, gated, and NOT adopted

`src/mlp_residual.js` adds an optional non-linear correction on top of the frozen linear score —
`score = linear + clamp(gain * MLP(x))`, a 128 → 16 → 1 ReLU network held in `Float32Array`, bounded
to ±150. The linear dot product is never replaced; the head can only nudge it, and the bound sits
below `laplace.lethalBonus` (260) so a residual can never outvote a forced kill. It is **off**:
`config.evaluator.mlp.enabled` is `false` because it did not clear the gate.

**What was measured.** `tools/train_mlp_residual.js` fits the head on the *residuals* of the frozen
linear model — `r_i = y_i - sigmoid(a + b·raw_i)`, the logistic loss's own negative gradient, with
the calibration fitted on the training half only — never on the label directly, so the head can only
learn what the linear half got wrong. It then applies the identical discipline the linear vector was
adopted under: `splitIndices` and `auc` are imported from `tools/fit_weights.js` and called with the
same per-battle row counts, so every 5th **battle** is held out exactly as before, and significance
is a paired bootstrap over battles.

The corpus is a **fresh** one, because the shipped corpus is not reproducible — it is 3,712
third-party logs and the rating-sorted window moves as new battles are played. Rebuilt with the
recipe in `tools/fetch_replays.js`'s header it is **3,521 battles → 107,024 labelled turn rows**
(2,913 from the elite window, 94 from the 1600–1749 band, 514 from 1300–1599), and the frozen linear
score lands at **AUC 0.7145** on its battle-level hold-out — against the **0.7049** the shipped
vector scored on the original corpus, so the two are directly comparable.

| on the held-out battles | AUC |
| --- | --- |
| frozen linear score (the shipped evaluator) | **0.7145** |
| + residual head | 0.7144 |

Paired bootstrap over the held-out battles: median **−0.0001**, 95% CI **[−0.0011, +0.0009]**, ahead
in **40.8%** of resamples. Five further configurations were tried — fully trained to 80 and to 300
epochs, `l2` at 1e-2 and 1e-1, and a 4-unit net — and **none** cleared the gate. The best of them
posted **+0.0012** with a CI straddling zero, and two of them had the selector itself choose **gain
0**, i.e. the head contributed nothing at all. This is the same shape of result as the cross-product
screen above and for the same reason: the 128D vector's own dims carry no transferable non-linear
signal that a small head can find on this corpus.

**Why the first run looked like a win, and why that was wrong.** The first version of the tool chose
the gain by maximising the **training-half** AUC and reported train AUC 0.8616 against a held-out
0.6757 — a head that looked like a large gain and was in fact a large loss. Rows are consecutive
turns of ONE battle and share its label, so the effective sample size is the **battle count**
(~2,800), not the row count (~85,000): a selector reading the rows the network was fitted to cannot
tell a correction that generalises from one that memorised the battle. The tool now takes a second
grouped split *inside* the training half, early-stops on its MSE, and chooses the gain on its AUC.
Under that honest protocol the head is worth nothing measurable — and on this corpus the inner
validation's minimum is at **epoch 0**, so further training only ever overfits.

**What it would cost.** `npm run bench:mlp` measures the head rather than guessing, alternating the
worst-case board off/on so drift cancels: **+2.1 ms p50 / +3.6 ms p95** per turn, roughly 7–10% of
the worst case. An isolated `delta()` loop reports 3.8 µs per call — a +1.6 ms floor over the 432
`_payoff` calls, and an optimistic one, since in the real call graph the head's buffers are not
cache-hot.

**What ships.** The artifact (`lib/mlp-residual.json`) is written either way, because it *is* the
evidence: the fitted coefficients, the split, the AUCs and the bootstrap. The generated data module
(`lib/mlp-residual.js`) carries the tensors **only when the gate passes**; on a rejection it is
written as `null`, so a rejected head costs the content script nothing and cannot be switched on by
a stray config edit. `tests/mlp_check.js` pins that invariant, along with the fail-safe (a missing
or mismatched artifact turns the head *off* rather than half-applying), the clamp, and the fact that
`tools/train_mlp_residual.js`'s vectorised forward pass is **bit-identical** to the class that ships.
Adopting a passing head is a deliberate one-line edit to `evaluator.mlp.enabled` — the trainer never
rewrites `src/config.js`, the same rule `tools/fit_weights.js` follows.

## The two dex gaps the generated files fix

The vendored `@smogon/calc` bundle is necessary but not sufficient:

1. **Hidden abilities are missing.** The production bundle keeps only ability slot 0, so
   Dragonite read as `Inner Focus` alone — no Multiscale — which silently invalidated 108
   candidate sets in `sets_db.js`, the ability-immunity veto and every Protosynthesis / Quark
   Drive check. `lib/species-abilities.js` restores all of them (1061 species).
2. **Some species do not resolve.** Bare `Aegislash` is unknown to calc (it has `Aegislash-Shield`
   / `-Blade`, plus a `-Both` amalgam with summed stats that must never be used), and 111
   cosmetic formes (G-Max, totems, PokeStar) exist in Showdown but not in calc at all.
   `lib/species-aliases.js` maps the former and synthesizes the latter; a synthesized species
   is tracked by the state manager but **cannot** be damage-calculated — `DamageEngine` reports
   those calls as `failed` instead of guessing.

Both files are generated, never hand-edited. To regenerate after a dex update:

```
node tools/gen_abilities.js && node tools/gen_aliases.js
node tests/run_tests.js && node tests/rule_checks.js
```

`tools/pokedex.json` is a snapshot of `play.pokemonshowdown.com/data/pokedex.json` (the dex the
site itself uses); refresh it with `curl -o tools/pokedex.json
https://play.pokemonshowdown.com/data/pokedex.json` before regenerating.

## Deliberate deviations from the original brief

1. **`protocol_parser.js` runs in the ISOLATED world**, next to `state_manager.js`, not in the
   MAIN world. It is the only consumer of `|request|` and the producer of engine state, so
   keeping it isolated means the page never sees the engine and only raw lines cross realms.
   `injected.js` is the only MAIN-world file.
2. **`lib/calc-data.min.js` is a second vendored file.** `@smogon/calc` ships its dex
   separately; `lib/calc.min.js` alone exposes an empty dex.
3. **`src/util.js`, `src/sets_db.js` and `src/background.js` are additional files** beyond the
   brief's tree. `util.js` centralises dex access; `sets_db.js` is shared by the pruner and the
   sampler; `background.js` performs the LLM request because MV3 content scripts are subject to
   the page's CORS rules and cannot use the extension's host permissions.
   `lib/species-abilities.js`, `lib/species-aliases.js`, `tests/` and `tools/` are additional
   too: the generated dex patches are what make the candidate sets valid, and the test
   suites (plus `test_engine.js` and `test_log.txt`) are the only way to verify any of this
   without a real battle. `tools/headless_arena/` is additional on the same terms: it is the one
   path here that verifies the engine against a real battle engine instead of hand-typed lines.
   `src/config.js` is additional as well — the brief wanted the
   heuristics tunable, and one config object is the only way to keep them from scattering.
   `src/opponent_clock.js`, `src/sets_usage.js` and `.github/workflows/chaos-sync.yml` are the
   same story for the telemetry and data-sync work.
6. **The monthly sync emits a usage OVERLAY, not a regenerated `src/sets_db.js`.** A chaos dump
   publishes each dimension as a *marginal* (how often that item, that move, that spread were
   seen), never as whole sets, so joining the marginals back into sets invents combinations no
   player ran — a 0-Speed spread holding a Choice Scarf, say. That would break Rule 1 (never
   simulate an invented set), so the curated database stays the source of sets and the generated
   file only moves their weights.
4. **Two extra host permissions** (`generativelanguage.googleapis.com`, `openrouter.ai`) are
   declared for that background request. Remove them and the LLM layer to run fully offline.
5. **`action.default_popup` plus `options_ui`** are both declared so the settings page is
   reachable on desktop (toolbar icon) and on Android (extension options).
7. **Max PP and move accuracy are captured from the page, not vendored.** The damage bundle carries
   neither, and hardcoding them here would be exactly the hand-written game data RULE 1 forbids, so
   `src/injected.js` reads them off the client's own battle object and dex and forwards them as the
   synthetic `|stpp|` / `|stacc|` lines. The cost is honest and bounded: a client that exposes
   neither gets a PP gauge that counts observed uses and no volatility charge, not a made-up
   number.
8. **The replay scout writes a weight OVERLAY, for the same reason the chaos sync does.** A replay
   reveals an item, an ability and the moves that were clicked — never EVs, IVs or a nature — so
   reconstructing sets from it would fabricate the unobserved half. `tools/scout_replays.js`
   therefore emits `src/scout_prior.js`, which only re-weights sets the curated database already
   holds.

## Known limits

* **The turn misses its performance target by ~3–4x.** `tests/perf_bench.js` measures ~28–40 ms per
  turn against a 10 ms goal; the dominant cost is `extractVector` rebuilding all 128 dims (and a
  6x6 threat matrix) on each of the 432 `_payoff` leaves, when those leaves differ only in HP. The
  fix is an incremental vector — compute the invariant dims once per world, patch HP per leaf — and
  it is not done yet. One leaf of the matrix (the offence multiplier) is already memoised, which is
  score-exact but only worth ~15%.
* `_speedOf`'s cache key is `slot|id|species`, which **collides for a same-species mirror** (two
  Slowking-Galar share one entry, and which body wins depends on iteration order). That is a latent
  correctness bug as well as a perf ceiling: enriching the key fixes it but changes scores, so it
  needs a re-fit before it can land.
* `@smogon/calc` has no Toxic Spikes / Sticky Web damage model; those are handled by the
  evaluator's chip-damage terms instead.
* The LLM feature sends a compact board summary to the configured provider. Without a key
  nothing leaves the browser.
* **The residual head is fitted and rejected, not missing.** `tools/train_mlp_residual.js` can fit a
  128 → 16 → 1 ReLU correction and gate it, and on the corpus it was run against the head was worth
  nothing measurable (delta −0.0001, 95% CI [−0.0011, +0.0009], ahead in 40.8% of resamples) and
  five further configurations also failed — see "the residual head" in the weight-pipeline section.
  So `config.evaluator.mlp.enabled` is `false` and `lib/mlp-residual.js` ships as `null`. This is a
  negative result about the 128D feature set on this corpus, not a proof that no non-linear
  correction exists: a different feature set, or a corpus large enough for the ~2,800-battle
  effective sample size to support 2,081 parameters, could change it.
* The 128D weights are an adopted fit from real battle logs (see the weight-pipeline section),
  while every tempo/veto/clock threshold is still a hand-tuned default; they all live in
  `src/config.js`, and `tests/config_check.js` freezes the vector while `tests/weights_check.js`
  pins it to the artifact it came from. The fit is only as good as the corpus, which is not
  shipped.
* The clock's thresholds and switch priors are priors about human behaviour, and
  `tests/upgrades_check.js` proves only the arithmetic and the wiring — never that a human
  agonising over a timer plays the safe line. A player who has already clicked and is watching an
  animation is indistinguishable from a fast one, and one lag spike inflates every later reading
  until a smaller sample replaces the floor.
* Reverse damage deduction is the weakest inference in the engine and is deliberately
  conservative: it is skipped for critical hits, for moves whose damage is not a function of the
  set, below `minDamagePct`, and it is discarded entirely when it would empty the pool. A wrong
  prune is still possible whenever an unmodelled factor (a mid-turn switch-in ability, a boost we
  never saw applied, a Z-move) moves the number inside the tolerance band.
* The usage overlay ships empty, so out of the box every set keeps its hand-curated weight; only
  a maintainer or the monthly Action changes that. The scouting overlay ships empty for the same
  reason: it needs a corpus of the opponent's own replays, which nothing ships and nothing fetches
  at runtime.
* Max PP and move accuracy come from the PAGE, not from the vendored bundle — `|stpp|` and `|stacc|`
  are synthesized by `src/injected.js` from the client's own battle object and dex. On a client
  build that exposes neither, the PP gauge falls back to counting observed uses and the volatility
  charge switches itself off entirely. It never falls back to an assumed PP total or a guessed
  accuracy, and neither path has been exercised against a live Showdown build here.
* The discrete-roll refinement is the strictest deduction in the pruner and is fenced accordingly:
  it runs only over what the range test accepted, it is abandoned (with a logged reason) whenever
  it would eliminate every remaining candidate, and it needs two independent observations before
  anything is labelled an exact spread.
* Residual order is read from the adjacency of two residual lines in one turn. A residual that was
  reordered by something other than Speed (a switch-in, a consumed berry, a weather change) reads
  as a Speed comparison, which is why `pruner.residualOrder.trust` exists and why the bracket is
  allowed to fail soft.
* The PP-stall pivot is a 1-ply model: it prices each of our lines against each of their replies in
the current turn, so it says which line to click now, not how the stall resolves over five turns.
* The haptic pulse needs the Vibration API (Android Chromium: Lemur, Kiwi, Chrome). Desktop and
  iOS get the gold chip and no buzz; `hud.vibrate.enabled: false` silences it everywhere. The
  browser also only honours a pulse after a real user gesture, so the alert attempts one only once
  the page has been touched — a battle passes that point long before trick room's last turn.
* Bench previews are only as good as the unrevealed set. A benched body is shown against the
  candidate set the sampler is currently weighting (see `liveSet`), so the numbers are an
  educated model of it — the same model the solver acts on — not a scouting report.
* `tests/hud_check.js` renders into the harness's stub document. That stub is deliberately
  permissive (its `classList` is a plain Set), which is exactly why the `_el` compound-class bug
  survived it: only a real browser run caught that.
* The library-only policy has no fallback: if `lib/calc.min.js` is missing, `U.libraryReady()`
  is false and stat lookups return 0 rather than a fabricated number — the engine reports
  nothing instead of guessing.
* Firefox for Android is declared but unverified. The manifest carries both background keys and a
  gecko id, and nothing in this repository has been loaded in a Gecko browser; the Chrome floor
  moved from 102 to 121 in the same change, so the supported Chromium range is narrower than it
  was. Chrome ≥ 121 ignores `background.scripts` (it uses the service worker); Chrome < 121 refuses
  to load an MV3 manifest that has it. A separate Firefox-only manifest would keep the old Chrome
  floor, at the cost of two manifests to maintain.
* The empirical-weight numbers are not reproducible from a checkout: the corpus is 3,712
  third-party logs that are not shipped, and the pipeline's own network step is what produced it.
  The artifact records only the fit — the format, rating band and search that produced the corpus
  are re-created by the fetcher's documented flags, not stored in the file.
* The shipped vector's test AUC (0.7049; the raw fit scores 0.7011) is a battle-level hold-out,
  which is the honest number and a modest one: it ranks the eventual winner correctly in roughly
  70 of 100 held-out pairs of battle states, and the fit's probabilities are not calibrated odds
  (Brier 0.2178 — and the leaf evaluator returns scores, not probabilities, anyway). Treat the
  vector as a ranking aid for comparing candidate lines, not as a win-probability model.
* The old 128-replay, 1300-rated corpus was deleted, so the 0.9360 figure cannot be recomputed;
  like the 0.7975 that briefly replaced it, it came from the row-level split and is not comparable
  to the battle-level 0.7011 the artifact now reports. The rating-diversity bands are in the
  shipped corpus, but at this size they are worth about +0.002, so they are a cheap hedge rather
  than a measured necessity.
* The cross-feature experiment is a **negative** result, and a corpus-bound one: products of the
  128D vector's own dims scored 0.7005 projected against the adopted vector's 0.7049 on the same
  battle-level hold-out, so nothing was adopted. It leaves hypotheses untested rather than refuted
  — three-way products, per-dim thresholds, and a small non-linear model such as a 16-neuron MLP
  over the same 128 inputs are all different bets, and any of them would have to clear the same
  hold-out and bootstrap gate before it could touch the engine.
* Nothing here has been verified in a real browser. The parser, state manager, engines and HUD
  are covered by the twenty-eight Node suites and stub DOMs; no suite can prove how Showdown's live
  control bar renders or how the extension behaves on an actual Android device.
* The arena produces evidence about three shapes, not a ladder rating. It runs `@pkmn/sim` 0.10.11
  with a seeded RNG, not the live Showdown server, and its three personas are heuristics — a one-ply
  greedy scorer, a Protect-loop clock stall and ε-greedy noise — so a win rate against them says how
  the engine handles those shapes and nothing about how it would place on the ladder. Crucible mode
  replays a recording's own actions through the current sim, so a replay recorded against a
  different sim revision desyncs visibly: the splicer reports the fidelity score and substitutes the
  first legal choice rather than hiding the divergence.
* The arena needs `@pkmn/sim`, a devDependency, and its suite takes the skip path without an
  `npm install` — so CI's fast gate verifies everything EXCEPT the arena, which is what the separate
  `arena` job in CI is for. The skip says exactly what it did not verify.
* **The ablation runner's power is bounded by its corpus, not by its statistics.** Sixty paired
  battles per variant puts the standard error near 6 win-rate points, which is why the first sweep
  separated exactly one feature from noise; the interval, the pairing and the `identical` flag are
  all honest at that size, but a "no measurable effect" row at 60 battles is a statement about the
  sample, not about the flag. The 500-battle command is the number to quote, and the whole table at
  500 is roughly five hours single-threaded (`--parallel 4` brings it near an hour and a half).
  Against three fixed personas with curated teams the corpus is also narrow: a flag that only
  matters on boards those three never reach measures as a no-op here, which is why most rows come
  back identical and why those rows are reported as unresolved rather than as neutral. The one
  adoption so far — turn urgency — rests on that same 60-battle sample; its interval is far from
  zero and the mechanism (converting cap ties into wins) is visible in the turn shape, but the
  headline number is a 60-battle one. The one REJECTION reached the same way is the pivot tax, and
  it is the more instructive of the two at that sample size: `-26.7 [-38.3, -15.0]` on 60 battles is
  a wide interval, which is exactly why its first reading was taken from 30 crucible battles and was
  wrong. Read a rejection with the same caution as an adoption — the tier is off, which costs
  nothing, and its row is still in the table for the 500-battle run that would settle it.
* A harvested vaccine is a failing suite entry until the defect behind it is fixed, and the
  harvester writes into a committed file. `--harvest` is therefore a mutating operation on the
  repository: run it deliberately, and commit the vaccine together with the fix that turns it green.
* `tests/hardening_audit.js` is the bug-hunt regression suite: eleven engine-side defects found by the audit
  (symptoms, root causes, fixes and the verification evidence are in `BUGS_AUDIT_REPORT.md`),
  each pinned by an assertion that fails on the code as it was, plus a 40-battle seeded fuzz
  that asserts the solver's invariants over random-but-legal protocol streams.
