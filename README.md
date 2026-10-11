# Showdown Tactician — Laplace NatDex Engine

A standalone **Manifest V3** Chrome extension that recreates the 2231-Elo "Laplace" decision
engine for **[Gen 9] National Dex OU** and renders its verdict as a thumb-friendly portrait HUD.
Built for Chromium-on-Android (Lemur Browser, Samsung Galaxy S24 FE, 1080×2340).

* Format: `[Gen 9] National Dex OU` — Megas, Z-Moves and Gen 9 Paradox mons are live;
  **Terastallization is tracked but never simulated** (banned in this format).
* Architecture: determinized multi-world sampling (K=6), 2-ply simultaneous matrix solver,
  128D dense-state leaf evaluator + 10D momentum vector, deterministic blunder vetoes,
  Trick Room lifecycle manager, optional LLM narration.
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
src/sets_db.js             usage-weighted Smogon candidate sets per species
src/team_parser.js         Pokepaste + packed-team parser, localStorage extractor, active-team matcher
src/protocol_parser.js     battle stream -> semantic events (frozen event table in ARCHITECTURE.md)
src/state_manager.js       single source of truth for HP, stints, hazards, TR timer, format locks
src/set_pruner.js          deterministic negative deductions against candidate sets
src/calc_engine.js         damage wrapper with a per-turn memo cache
src/trick_room.js          TR lifecycle + inverted speed priority queue
src/evaluator_128d.js      128D dense state vector + dot-product score
src/tempo_vector.js        10D momentum vector + Protect/Bunker policy mask
src/veto_guard.js          the four hard blunder vetoes
src/world_sampler.js       K=6 determinized worlds with observed-fact verification
src/laplace_core.js        the decision loop (matrix solver, blending, softmax)
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
tests/config_check.js      RULE 4: the config inventory, the frozen 128D layout, live mutation (63 checks)
tests/blackbox_guard.js    RULE 1: 50,616 stat values diffed against @smogon/calc + a scan for handwritten math (28 checks)
tests/parser_fuzz.js       RULE 3: the real 30-turn log replayed, every prefix, and junk lines (44 checks)
tests/hardening_audit.js   the bug-hunt regression suite: 10 defects reproduced first, then fixed,
                           plus a 40-battle seeded invariant fuzz (46 checks)
test_engine.js             RULE 2: five canonical ground-truth damage scenarios (57 checks)
test_log.txt               the 30-turn ExtramePatriot vs LUIZ_LFN battle as a raw protocol stream
tools/gen_abilities.js     regenerates lib/species-abilities.js from tools/pokedex.json
tools/gen_aliases.js       regenerates lib/species-aliases.js (needs the vendored calc bundle)
tools/pokedex.json         Showdown's dex snapshot the two generators read
ARCHITECTURE.md            frozen interface contract every module binds to
```

## Verifying

```
node test_engine.js           #  57 checks: RULE 2 — five ground-truth damage rolls, frozen
node tests/run_tests.js       # 177 checks: the whole pipeline in a DOM-less sandbox
node tests/rule_checks.js     #  23 checks: the deductions, replayed from raw protocol lines
node tests/util_smoke.js      #  43 checks: dex access, item naming, type math, Speed maths
node tests/injected_bridge.js #  12 checks: the MAIN-world WebSocket bridge (fake WebSocket/DOM)
node tests/config_check.js    #  63 checks: RULE 4 — the config is the only home for a heuristic
node tests/blackbox_guard.js  #  28 checks: RULE 1 — no handwritten math, 50,616 stats diffed
node tests/parser_fuzz.js     #  44 checks: RULE 3 — the real log, all its prefixes, junk lines
node tests/hardening_audit.js #  46 checks: the bug-hunt regressions + a 40-battle invariant fuzz
```

The first suite loads every script in manifest order inside a DOM-less sandbox (so a load-order
mistake or a stray `document` access at import time fails loudly), then exercises: dex access,
Pokepaste parsing, the protocol → state pipeline (Heavy-Duty Boots proof, stint tracking,
recovery PP, Trick Room lifecycle, mega/Z locks), set pruning, damage math, both vectors, all
four vetoes, the sampled worlds, the full `evaluateTurn` loop, the LLM bridge and the HUD
against a stub DOM.

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
from eroding: the first holds a 104-path inventory of every value the modules read and the
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
   holds a 104-path inventory so no module can silently fall back to a literal, and proves a
   runtime `ST.configMerge()` reaches newly constructed engines. Game rules with a single
   correct value (Trick Room lasts 5 turns, Choice Scarf is ×1.5, the type chart, base stats)
   deliberately do **not** live there.

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
4. **Two extra host permissions** (`generativelanguage.googleapis.com`, `openrouter.ai`) are
   declared for that background request. Remove them and the LLM layer to run fully offline.
5. **`action.default_popup` plus `options_ui`** are both declared so the settings page is
   reachable on desktop (toolbar icon) and on Android (extension options).

## Known limits

* `@smogon/calc` has no Toxic Spikes / Sticky Web damage model; those are handled by the
  evaluator's chip-damage terms instead.
* The LLM feature sends a compact board summary to the configured provider. Without a key
  nothing leaves the browser.
* The 128D weights and every tempo/veto threshold are tuned defaults, not a learned model; they
  all live in `src/config.js`, and `tests/config_check.js` freezes the layout.
* The library-only policy has no fallback: if `lib/calc.min.js` is missing, `U.libraryReady()`
  is false and stat lookups return 0 rather than a fabricated number — the engine reports
  nothing instead of guessing.
* Nothing here has been verified in a real browser. The parser, state manager, engines and HUD
  are covered by the nine Node suites and stub DOMs; no suite can prove how Showdown's live
  control bar renders or how the extension behaves on an actual Android device.
* `tests/hardening_audit.js` is the bug-hunt regression suite: ten defects found by the audit
  (symptoms, root causes, fixes and the verification evidence are in `BUGS_AUDIT_REPORT.md`),
  each pinned by an assertion that fails on the code as it was, plus a 40-battle seeded fuzz
  that asserts the solver's invariants over random-but-legal protocol streams.
