# Showdown Tactician — Laplace NatDex Engine

A standalone **Manifest V3** Chrome extension that recreates the 2231-Elo "Laplace" decision
engine for **[Gen 9] National Dex OU** and renders its verdict as a thumb-friendly portrait HUD.
Built for Chromium-on-Android (Lemur Browser, Samsung Galaxy S24 FE, 1080×2340).

* Format: `[Gen 9] National Dex OU` — Megas, Z-Moves and Gen 9 Paradox mons are live;
  **Terastallization is tracked but never simulated** (banned in this format).
* Architecture: determinized multi-world sampling (K=6), 2-ply simultaneous matrix solver
  solved for a mixed equilibrium (fictitious play), 128D dense-state leaf evaluator +
  10D momentum vector, seven deterministic blunder vetoes, Trick Room lifecycle manager,
  optional LLM narration.
* Everything runs **locally**. The LLM layer is opt-in and costs 0 ms when no API key is set.

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

## Using the HUD

| Element | What it shows |
| --- | --- |
| Badge on each move button | Confidence percentage. Green ≥ 50 %, gold 25–49 %, slate < 25 %. A red strike-through badge (`conf-veto`) means the line was vetoed by the deterministic guard. |
| `.tactician-banner` (top) | `TR n/5`, opponent set identity, confirmed/deduced item, inferred Speed floor, their hazards. |
| `.tactician-tr-chip` | Only appears when something urgent is true (TR expiring, predicted Bunker turn, optimal line vetoed). |
| `.team-drawer` (bottom-left TAC button, 48×48) | Team paste textarea, save button, team status, live opponent candidate-set breakdown. |

When an API key is configured, the model's one-line justification is appended under the
recommended move within ~600 ms. The local engine's answer is already on screen before that.

## Files

```
manifest.json              MV3 manifest; loads the module chain in dependency order
lib/calc-data.min.js       vendored @smogon/calc dex (1406 species incl. Megas, 942 moves)
lib/calc.min.js            vendored @smogon/calc mechanics (exposes window.calc)
lib/species-abilities.js   GENERATED: restores the hidden/secondary abilities the calc bundle drops
lib/species-aliases.js     GENERATED: species aliases (Aegislash) + cosmetic formes the calc lacks
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
src/tempo_vector.js        10D momentum vector + Protect/Bunker policy mask
src/opponent_clock.js      opponent deliberation telemetry: turn latency minus the learned noise floor
src/veto_guard.js          the seven hard blunder vetoes (immunity, rhythm, TR, speed, contact, Sucker Punch)
src/world_sampler.js       K=6 determinized worlds with observed-fact verification
src/laplace_core.js        the decision loop (payoff matrix, mixed-strategy solve, legacy softmax)
src/llm_client.js          optional Gemini/OpenRouter bridge, hard 600 ms abort
src/ui_overlay.js          mobile HUD DOM injection
src/injected.js            MAIN-world WebSocket interceptor
src/background.js          service worker: the only component that calls the LLM API
src/content.js             pipeline orchestrator
options/options.html|js    mobile settings page (provider, key, team, Elo scaler)
tests/run_tests.js         end-to-end verification suite (177 checks)
tests/rule_checks.js       deduction-rule checks driven through real protocol lines (23 checks)
tests/util_smoke.js        util.js in isolation: dex access, item naming, type math, Speed maths (43 checks)
tests/injected_bridge.js   the MAIN-world WebSocket bridge against a fake WebSocket/DOM (12 checks)
tests/config_check.js      RULE 4: the config inventory, the frozen 128D layout, live mutation (68 checks)
tests/blackbox_guard.js    RULE 1: 50,616 stat values diffed against @smogon/calc + a scan for handwritten math (28 checks)
tests/parser_fuzz.js       RULE 3: the real 30-turn log replayed, every prefix, and junk lines (44 checks)
tests/hardening_audit.js   the bug-hunt regression suite: 10 defects reproduced first, then fixed,
                           plus a 40-battle seeded invariant fuzz (48 checks)
tests/upgrades_check.js    the mixed-strategy solver against matrices with an analytic equilibrium,
                           the newer vetoes, the deliberation clock and the reverse damage rule (118 checks)
tests/chaos_sync_check.js  the monthly chaos-sync tool + the usage overlay it writes (70 checks)
tests/weights_check.js     the replay extractor + the IRLS weight fitter, against a planted model (59 checks)
tests/discrete_check.js    the 16 discrete damage rolls, the exact KO count, EV pinning and the
                           residual-order Speed evidence (110 checks)
tests/scout_check.js       the replay-scouting tool + the overlay it writes + the pruner's use of it (78 checks)
tests/pressure_check.js    the PP-stall gauge and its 3-way pivot, the volatility charge, the
                           Z-Move/Mega format sentinel (139 checks)
test_engine.js             RULE 2: five canonical ground-truth damage scenarios (57 checks)
test_log.txt               the 30-turn ExtramePatriot vs LUIZ_LFN battle as a raw protocol stream
tools/gen_abilities.js     regenerates lib/species-abilities.js from tools/pokedex.json
tools/gen_aliases.js       regenerates lib/species-aliases.js (needs the vendored calc bundle)
tools/pokedex.json         Showdown's dex snapshot the two generators read
tools/sync_chaos_sets.js   a Smogon chaos dump -> src/sets_usage.js (the monthly cron runs this)
tools/scout_replays.js     an opponent's recent replays -> src/scout_prior.js (what their own games reveal)
tools/extract_training_data.js  a replay corpus -> 128D rows labelled by the eventual winner
tools/fit_weights.js       IRLS logistic regression over those rows -> weights + train/test AUC
.github/workflows/chaos-sync.yml  monthly cron: download the dump, resync the overlay, commit it
ARCHITECTURE.md            frozen interface contract every module binds to
```

## Verifying

```
node test_engine.js           #  57 checks: RULE 2 — five ground-truth damage rolls, frozen
node tests/run_tests.js       # 177 checks: the whole pipeline in a DOM-less sandbox
node tests/rule_checks.js     #  23 checks: the deductions, replayed from raw protocol lines
node tests/util_smoke.js      #  43 checks: dex access, item naming, type math, Speed maths
node tests/injected_bridge.js #  12 checks: the MAIN-world WebSocket bridge (fake WebSocket/DOM)
node tests/config_check.js    #  71 checks: RULE 4 — the config is the only home for a heuristic
node tests/blackbox_guard.js  #  28 checks: RULE 1 — no handwritten math, 50,616 stats diffed
node tests/parser_fuzz.js     #  44 checks: RULE 3 — the real log, all its prefixes, junk lines
node tests/hardening_audit.js #  48 checks: the bug-hunt regressions + a 40-battle invariant fuzz
node tests/upgrades_check.js  # 118 checks: the mixed-strategy solve, the vetoes, the clock, damage evidence
node tests/chaos_sync_check.js # 70 checks: the chaos sync + the usage overlay (fixtures only, no network)
node tests/weights_check.js   #  59 checks: the extractor + the fitter against a planted model
node tests/hud_check.js       # 137 checks: the six HUD extras (stub DOM) + their engine data
node tests/discrete_check.js  # 110 checks: the 16 discrete rolls, the exact KO count, EV pinning, residual order
node tests/scout_check.js     #  78 checks: the scouting tool, the overlay, the pruner's re-weighting
node tests/pressure_check.js  # 139 checks: the PP-stall pivot, the volatility charge, the format sentinel
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
re-weighting against fixtures, and `tests/weights_check.js` proves the fitter recovers a planted
weight vector from synthetic rows with test AUC ≥ 0.8.

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

The blunder layer grew from four hard vetoes to seven. Alongside protect-rhythm, ability
immunity, lone-TR-setter and speed-suicide, `src/veto_guard.js` now refuses:

1. **Contact suicide** — a contact move into a known Iron Barbs / Rough Skin / Rocky Helmet target
   when the recoil (1/8, 1/6, or 1/8 + 1/6 ≈ 29 % stacked) is enough to finish us, unless the hit
   KOs and the punishment never triggers.
2. **The Sucker Punch setup trap** — a *second consecutive* Sucker Punch into a healthy target
   that provably holds a setup/recovery/status move, because Sucker Punch only connects against an
   attacking move. The first one stays a legitimate read.
3. **Trick Room while Trick Room is up** — in Gen 5+ the move simply *fails* while the room is
   active (it neither cancels nor refreshes it), so re-clicking it can only waste a turn.

## The six HUD extras

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

The first real-browser pass over this HUD found a defect the stub DOM could not: `_el()` added a
compound class name through `classList.add`, which throws `InvalidCharacterError` in a real DOM,
so `renderTRChip` died on its first call and the TR chip never appeared at all. `_el` now adds one
token at a time. `tests/hud_check.js` covers the new entry points in the DOM-less sandbox; the
browser pass is what caught that one.

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

The same offline philosophy applies to the weights themselves: `tools/extract_training_data.js`
turns replay logs into 128D rows labelled by the eventual winner, and `tools/fit_weights.js` fits
them by IRLS with an L2 ridge, reports train/test AUC-ROC and prints a ready `evaluator.weights`
snippet. It writes its output as an artifact and never rewrites `src/config.js` on its own —
adopting fitted weights is a reviewed step, because the corpus needed to make them meaningful is
not the repo's to ship.

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
   without a real battle. `src/config.js` is additional as well — the brief wanted the
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

* `@smogon/calc` has no Toxic Spikes / Sticky Web damage model; those are handled by the
  evaluator's chip-damage terms instead.
* The LLM feature sends a compact board summary to the configured provider. Without a key
  nothing leaves the browser.
* The 128D weights and every tempo/veto/clock threshold are tuned defaults, not a learned model;
  they all live in `src/config.js`, and `tests/config_check.js` freezes the layout. The weight
  fitter exists precisely so that can change, but the fitted numbers are only as good as the
  corpus, which is not shipped.
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
* Nothing here has been verified in a real browser. The parser, state manager, engines and HUD
  are covered by the sixteen Node suites and stub DOMs; no suite can prove how Showdown's live
  control bar renders or how the extension behaves on an actual Android device.
* `tests/hardening_audit.js` is the bug-hunt regression suite: ten defects found by the audit
  (symptoms, root causes, fixes and the verification evidence are in `BUGS_AUDIT_REPORT.md`),
  each pinned by an assertion that fails on the code as it was, plus a 40-battle seeded fuzz
  that asserts the solver's invariants over random-but-legal protocol streams.
