# Showdown Tactician — Bug-Hunt & Hardening Report

**Scope.** A single fast-lane sweep of the whole engine: find real defects, prove each one with an
automated assertion *before* fixing it, apply the smallest surgical fix, and leave a permanent
regression suite behind. Ten defects were found and fixed, plus four of the audit's own assertions
turned out to be wrong (they are reported too — a test that asserts a defect is worse than no test).

**Ground rules observed.**

1. **Speed rule.** The eight existing suites were run once, at the end (plus `tests/rule_checks.js`
   alone when one of its expectations had to change), and the full sweep was repeated once more in
   the final pass. No suite was re-run "just in case".
2. **Per bug:** root cause first (no band-aids), then a reproducing assertion, then the minimal fix,
   then verify green with zero regressions.
3. Every fix is pinned by an assertion in the new suite, so the defect cannot come back silently.

## Artifacts

| File | What it is |
| --- | --- |
| [`tests/hardening_audit.js`](tests/hardening_audit.js) | **New.** 46 checks in 11 sections: one section per defect (each fails on the pre-fix code) plus a 40-battle seeded invariant fuzz. Run with `node tests/hardening_audit.js`. |
| `src/laplace_core.js`, `src/world_sampler.js`, `src/veto_guard.js`, `src/content.js`, `src/state_manager.js`, `src/calc_engine.js`, `src/set_pruner.js`, `src/config.js` | The eight modules touched by the fixes. |
| [`tests/rule_checks.js`](tests/rule_checks.js) | One expectation had to be corrected: it was passing *because* of defect **B9** (see "Test corrections"). |
| [`README.md`](README.md), [`ARCHITECTURE.md`](ARCHITECTURE.md) | Document the new suite (and "eight suites" → "nine"). |

## Summary

| # | Defect | Where | Class | Status |
| --- | --- | --- | --- | --- |
| B1 | Softmax returns **NaN** confidence for any `temperature ≤ ~1.7` | `src/laplace_core.js` | correctness / crash-grade | fixed |
| B2 | World sampling is **not deterministic** — worlds come from `Math.random()` | `src/world_sampler.js` | correctness (PIMC contract) | fixed |
| B3 | VETO4 speed race ignores **our own item/ability** and the **field** | `src/veto_guard.js`, `src/content.js` | wrong veto + wrong HUD hint | fixed |
| B4 | A revealed **Mega opponent is sampled as its base forme** and loses world weight | `src/world_sampler.js` | wrong damage/type maths | fixed |
| B5 | Species lookup **prefix-matches unrelated formes** (`Ursaluna` → `Ursaluna-Bloodmoon`) | `src/state_manager.js` | wrong MonState / missing mon | fixed |
| B6 | Damage memo key **omits four IVs** (and the ability/item options) | `src/calc_engine.js` | stale damage roll (~6 %) | fixed |
| B7 | **Struggle counts as a second distinct move** → permanent Choice lock-out | `src/state_manager.js` | deduction corruption | fixed |
| B8 | Candidate pools are keyed **per species**, shared across sides | `src/set_pruner.js` | deduction corruption | fixed |
| B9 | An **unsatisfiable Speed floor empties the pool** (sampler falls back to the raw DB) | `src/set_pruner.js`, `src/config.js` | deduction silently undone | fixed |
| B10 | A `\|-heal\|` on a **fainted** body leaves it fainted *and* at 52 % HP | `src/state_manager.js` | illegal state (Revival Blessing) | fixed |

Reproduction proof: on the pre-fix code the audit reported **18 failing assertions across all ten
sections** (plus the fuzz). After the fixes: **46/46 green**, and the eight pre-existing suites are
green with a single corrected expectation (B9, below).

---

## B1 — Softmax produces `NaN` confidence

**Symptom.** With the advertised tunable turned down
(`ST.configMerge({ laplace: { temperature: 1 } })`, or `evaluateTurn(state, { temperature: 1 })`)
**every** line came back with `confidence: NaN`. The HUD renders `NaN%`, the sort comparator
returns `NaN`, and the LLM prompt carries `NaN`.

**Root cause.** `src/laplace_core.js` computed `Math.exp(score / T)` with no shift. Live scores
legitimately reach ~1400 (`lethalBonus` 260 + the evaluator's ±1000 bound + `switchAteHitBonus` 25
+ the Bunker mask 80), so for any `T` below ~1.7 `exp(score / T)` overflows to `Infinity`, making
`denom = Infinity` and every confidence `100 * (Infinity / Infinity) = NaN`. The default
`T = 35` (`src/config.js`) hides it, which is exactly why it survived: the config is *advertised*
as retunable.

**Reproducing assertion** (`tests/hardening_audit.js` §1): evaluate the Mega fixture at
`temperature: 1` and require every confidence to be finite in 0..100, the live lines to sum to
100 ± 1.5, and the top line to stay the highest.

**Fix.** Subtract the best live score before exponentiating (mathematically identical, only the
numerator's range changes), and fall back to the configured temperature if a caller passes a
non-positive one.

**Verification.** Before: `[null, 0, 0]` and `NaN`. After: 4/4 checks pass; `run_tests.js`'s
"softmax confidences sum to 100" (tolerance 1.5) is unaffected, so no consumer had baked in a
particular float.

---

## B2 — World sampling is not deterministic

**Symptom.** Two `evaluateTurn` calls on the *same* unchanged battle state returned different
confidence vectors (e.g. `gigadrain 0.0055152…` vs `0.0055155…`), and two fuzz seeds failed the
"deterministic across two runs" invariant.

**Root cause.** `src/world_sampler.js` derived each world's seed from `this._rand()`, which returns
`Math.random()` whenever no rng was injected, then `mulberry32(seed)`. The module's whole premise —
"determinized perfect-information Monte Carlo" — was therefore false by default: the K worlds, and
thus every score, changed on every call.

**Reproducing assertion** (§2): the same state must sample the same world seeds and rank the same
lines; the worlds must stay distinct; no seed may come from `Math.random`; a *different* state must
sample different seeds; and an **explicitly injected** rng must still drive the sampling.

**Fix.** New `_observationSignature(state)` (turn, field, and each opponent body's revealed
facts) hashed with FNV-1a into a 32-bit `_seedFromState`. `sampleWorlds` now derives the K seeds as
`base + i * 0x9E3779B9`, or — when `options.rng` is present — one draw per world from that rng, so
the injected-rng contract is preserved. `sampleWorld` accepts an explicit seed and never falls back
to `Math.random()`.

**Verification.** §2 6/6 pass, including the injected-rng case; the fuzz's "not deterministic
across two runs" failures disappear (see §11).

---

## B3 — VETO4's speed race cannot see our item, our ability, or the field

**Symptom.** Two wrong verdicts, both reachable every game:

* our **Choice Scarf Toxapex** was treated as unscarfed, so VETO4 fired "slower and facing a
  guaranteed KO" on a turn we actually outspeed and KO first;
* a **Swift Swim / Chlorophyll / Sand Rush / Slush Rush / Surge Surfer** mon in its weather, or any
  body behind **Tailwind**, was scored at its naked Speed on both sides.

**Root cause.** `src/veto_guard.js` `_opponentMovesFirst` passed
`item: my.currentBattleItem || my.confirmedItem` and `ability: my.revealedAbility`. For our own
team those fields are **never** populated — `registerMyTeam` writes `mon.item` / `mon.ability`
(`src/state_manager.js`) — and `U.computeSpeed` treats a *defined* option as authoritative
(`opts.item !== undefined ? opts.item : mon.item`), so `toID(null)` → `''` erased a Choice Scarf.
`weather` / `terrain` / `tailwind` were not passed at all although `state.field` carries them, and
`paradoxSpeedBoost: !!mon.boosterActive` never covers a *fresh* Booster Energy holder outside a
sampled world (`trick_room.js` adds the ability+item fallback). It also carried a dead
`const moveId = U.toID(null);`.

**Reproducing assertion** (§3), with fixtures chosen to sit between the relevant speeds
(plain Toxapex 185 < Gholdengo 267 < Scarf Toxapex 277; plain Kabutops 259 < 267 < rain Kabutops
518): the Scarf must flip `_opponentMovesFirst` to `false`, an unscarfed/rainless body must stay
`true`, and Swift Swim in rain must flip it.

**Fix.** Local `_itemOf` / `_abilityOf` helpers mirroring `trick_room.js`'s (observed →
confirmed → not-removed `mon.item` → `liveSet`), plus `weather` / `terrain` / `tailwind` (per side
from `state.mySide`) / `boostStage` / `unburden`, and the dead binding removed. `src/content.js`'s
`speedHint` had the identical omission and now uses the same resolution order plus the field.

**Verification.** §3 6/6 pass. Note §3's original second assertion was itself wrong (it used an
opponent slower than unboosted Kabutops) — see "Test corrections".

---

## B4 — A revealed Mega is sampled as its base forme

**Symptom.** Against a revealed Mega Venusaur every sampled world reported
`species mismatch`, lost weight (`1/(1+k)` → each world's normalised share), and stood a **base
Venusaur (82 Atk)** on the field while the veto/tempo layers used the real Mega (100 Atk).

**Root cause.** `src/world_sampler.js` `_monFromSet` took the species from `set.species`, and a
Mega set is stored in `sets_db.js` under the **base** species with the stone in `item`
(`P('Venusaur', [{ r: 'mega', i: 'Venusaurite', … }])`, `isMega` derived from the item), so the
sampled world mon inherited the base name while `_violationsFor` compared it against the observed
`Venusaur-Mega` and rejected **every** candidate — the very set that was correct.

**Reproducing assertion** (§4): for a revealed `Venusaur-Mega`, the state and the world mon must
both be `venusaurmega`, no world may report a species mismatch or any other violation, the Mega
Stone must survive in the sampled set, and `U.baseStats(species).atk` must be 100 (not 82).

**Fix.** New `_setSpecies(set)` resolves a Mega/Primal set to its field forme via
`U.megaSpeciesFromStone(set.item)`; used both by `_monFromSet` (what the world actually fields) and
by `_violationsFor` (what the set is compared against).

**Verification.** §4 6/6 pass. The original fixture used Abomasnow, which is **not in the bundled
set database**, so it exercised the generic-filler path instead of the defect — corrected (see
"Test corrections").

---

## B5 — Species lookup prefix-matches unrelated formes

**Symptom.** With both `Ursaluna-Bloodmoon` (from team preview) and a plain `Ursaluna` (switched
in) in play, the game state held **one** monster: the Bloodmoon, marked active. The real Ursaluna
was never created, so its HP, item deductions, Speed floor and typings all landed on the wrong body.

**Root cause.** `src/state_manager.js` `_findBySpecies` had
`if (!best && toID(m.species).indexOf(id.replace(/mega[xy]?$/, '')) === 0 && id) best = m;` — a raw
prefix test, so `Ursaluna` matched `Ursaluna-Bloodmoon`, `Zapdos` matched `Zapdos-Galar`,
`Porygon` matched `Porygon2`, `Raichu` matched `Raichu-Alola`, `Kyurem` matched `Kyurem-Black`, and
`_onSwitch` (which resolves by species, not by slot) skipped creating the real mon.

**Reproducing assertion** (§5): `poke`-preview the Bloodmoon, switch a plain `Ursaluna` into
`p2a`, and require the plain Ursaluna to exist, the Bloodmoon not to be active, and
`_findBySpecies('p2','Ursaluna')` not to return the Bloodmoon. Plus the **reverse** direction:
`_findBySpecies('p2','Abomasnow')` must still find `Abomasnow-Mega` (this is how the `|-mega|`
handler locates its body).

**Fix.** Strip a recognised forme suffix (`mega`, `mega-x/-y`, `primal`) from **both** sides before
comparing, and otherwise require an exact id match.

**Verification.** §5 5/5 pass; `run_tests.js` (protocol/state sections) and `parser_fuzz.js` stay
green, so no legitimate base→forme resolution regressed.

---

## B6 — The damage memo key omits four IVs

**Symptom.** Two mirror Great Tusk rolls with 31 Atk and 0 Atk IVs returned the identical number
(`234` / `234`, `cache: 1`) — a stale roll reused across different spreads (~6 % error).

**Root cause.** `src/calc_engine.js` `_key`'s `monSig` included only `d.ivs.hp` and `d.ivs.spe`
although `normIVs` preserves all six, so a mon differing in Atk/Def/SpA/SpD IVs hashed to the same
key. `opts.ability` / `opts.item`, which change a Max Move's typing in `_buildMove`, were missing
from the `extra` segment for the same reason.

**Reproducing assertion** (§6): a 0-Atk-IV attacker must deal measurably less than a 31-IV one, and
the memo must not serve the first roll for the second mon.

**Fix.** Add all six IVs to `monSig` and `opts.ability` / `opts.item` to `extra`.

**Verification.** §6 2/2 pass; `test_engine.js` (the frozen ground-truth rolls) and
`blackbox_guard.js` (50,616 stat values) stay green — the cache is still a pure function of its key.

---

## B7 — Struggle disproves a Choice item

**Symptom.** After one real move plus a Struggle, the opponent's candidate pool lost **every**
Choice set permanently (`cannotBeChoice = true`, `_dropChoiceSets` splices both the live pool and
the pristine pool) and the deduction trail read "2+ distinct moves in one stint ⇒ no Choice item".

**Root cause.** `distinctStintMoves()` *does* filter Struggle, but the rule used
`stintCount = Math.max(distinct, mon.activeStintCount | 0)` and `src/state_manager.js` `_onMove`
pushed the raw move name and set `mon.activeStintCount = mon.activeStintMoves.length`, so a forced
pseudo-move inflated the counter. The same counter also cleared `originalArchetypeItem`
unconditionally at `>= 2`.

**Reproducing assertion** (§7): a stint of `Kowtow Cleave` + `Struggle` must not trip the rule and
must leave the Choice item possible, while `Kowtow Cleave` + `Iron Head` still must.

**Fix.** A module-level `FORCED_MOVE_IDS` set; `_onMove` no longer records Struggle in the stint
(so the counter, the archetype-item clearing and the pruner all agree).

**Verification.** §7 5/5 pass. `run_tests.js`'s choice-lock test sets `activeStintCount` directly
and is unaffected.

---

## B8 — Candidate pools are shared across sides

**Symptom.** A deduction proven about the **opponent's** Kingambit rewrote **our** Kingambit's
candidate space: after their Choice lock, re-pruning ours returned
`[Leftovers, Assault Vest, Air Balloon, Black Glasses]` with no Choice Band option left — breaking
`set_pruner.js`'s own idempotency claim.

**Root cause.** `_seedPool`, `_poolFor`, `_dropChoiceSets` and `applySpeedFloor` all keyed the
pristine pool by `mon.id || U.toID(mon.species)`, and `_newMon` sets `id: toID(canonical)`, so two
Kingambits shared one pool object and one `_dropChoiceSets` call mutated both.

**Reproducing assertion** (§8): seed our pool (it must contain a Choice Band set), prune *their*
mon until their Choice sets are disproved, then re-prune ours and require the Choice Band option to
survive.

**Fix.** New `_poolKey(mon)` = `side|index|speciesId` (falling back to the bare species id for the
side/index-less fixture objects the unit tests build, where a species appears only once). Every
`_pristine[...]` access now goes through it.

**Verification.** §8 4/4 pass; `rule_checks.js` (speed floor, format-lock cascade) and
`run_tests.js` (pruner sections) stay green.

---

## B9 — An unsatisfiable Speed floor empties the pool

**Symptom.** With a floor no set can reach (e.g. `speedFloor = 900` on Slowking-Galar, reachable
because `_maybeSpeedFloor` only inspects the *opponent's* Tailwind), `candidateSets` became `[]` with
no guard: `liveSet` went `null` and the sampler's `_poolFor` then fell back to the **unfiltered
database**, silently undoing every other deduction. `sampler.sampleWorld` had a
`_speedFloorSatisfiable` guard; the pruner did not.

**Root cause.** `src/set_pruner.js` `applySpeedFloor` published `survivors` unconditionally, unlike
`prune()`, which documents a bounded fallback.

**Reproducing assertion** (§9): an impossible floor must leave a non-empty pool with a published
`liveSet`, keep at most the documented number of sets, and prefer the closest ones.

**Fix.** When no set reaches the floor, keep the `pruner.speedFloorFallbackKeep` (default 4) fastest
candidates, record a reason, and never write an empty pool (also through the new per-instance key).

**Verification.** §9 4/4 pass. **One pre-existing expectation had to be corrected**: see below.

### Test correction — `tests/rule_checks.js`

The old assertion was

```js
ok('speed: no Choice Scarf can survive a 700 floor for Landorus', … &&
   lando.candidateSets.every(function (s) { return U.maxSpeedForSet(s) >= 700; }));
```

`[].every(...)` is **vacuously true**, so it passed precisely while the floor was wiping the pool
out — the test asserted the defect. It now asserts the fixed contract: a non-empty pool (≤ 4 sets)
holding the closest candidates, all below the unreachable floor, with a published `liveSet`.

---

## B10 — A heal on a fainted body leaves it fainted

**Symptom.** The fuzz caught `illegal state … fainted at 52`: a monster flagged `fainted` while
holding 52 % HP. That poisons the alive counts, the bench, `_stampFallen` bounds and every
"can I still switch" decision.

**Root cause.** `src/state_manager.js` `_setHP` set the faint latch when HP hit 0 but never
cleared it when HP came back, so `|-heal|` after `|faint|` — i.e. **Revival Blessing**, which is
legal in this format — produced a zombie. The fuzz generated exactly that sequence and the
invariant caught it.

**Reproducing assertion** (§10): `|-damage|…|0 fnt` + `|faint|` must mark the mon fainted at 0 %,
and a following `|-heal|…|50/100` must clear the latch.

**Fix.** In `_setHP`, when HP parses above 0 and the mon was fainted, clear `fainted`.

**Verification.** §10 2/2 pass, and the fuzz's illegal-state failures disappear.

---

## Test corrections (assertions that were wrong, not the code)

Four of the audit's own first-draft assertions failed for the wrong reason. They were rewritten
rather than "made to pass", and each rewrite is what the section above now pins:

1. **§3's "Swift Swim without rain"** compared rainless Kabutops (259 Speed) against an opponent
   slower than it, so no weather term could ever be observed. The opponent is now Gholdengo
   (267) — between rainless and rain-boosted Kabutops, and between plain and Scarf Toxapex.
2. **§4's fixture was Abomasnow**, absent from the bundled set database, so the section tested the
   generic-filler path; it also required `world.weight === 1`, which `sampleWorlds` can never
   return because it normalises the weights. Now Venusaur (a real Mega set in the DB) and
   "no violations" instead of "weight === 1".
3. **§5's original line** (`|-damage|p2a: Ursaluna|…`) resolves by **slot** by design, so it could
   not exercise the species lookup at all; the Bloodmoon check therefore failed on *correct*
   behaviour. Rewritten to the real path (preview + `|switch|`) plus a direct
   `_findBySpecies` assertion in both directions.
4. **§8's original form** read `myKing.candidateSets` before it had ever been seeded (always `[]`),
   so it could not detect the shared pool; and checking the live array *after* their prune passes
   even with the bug, because `_dropChoiceSets` only splices their array and the shared pristine
   pool. Rewritten to seed our pool first and re-prune ours afterwards — which is the path the bug
   actually corrupts.

---

## Verification evidence

Reproduced **before** any fix (`node tests/hardening_audit.js`, pre-fix code):

```
checks passed: 24
checks failed: 18
fuzz: 40 random battles, 280 ranked actions
FAILURES: … NaN confidence ×3, sampler determinism ×2, Swift Swim ×1, Mega sampling ×2,
          species mismatch ×1, memo key ×2, Struggle/Choice ×2, shared pool ×2,
          empty speed floor ×2, fuzz illegal state + non-determinism ×2 …
```

After the fixes (`node tests/hardening_audit.js`):

```
=== summary ===
checks passed: 46
checks failed: 0
fuzz: 40 random battles, 282 ranked actions
ALL HARDENING CHECKS PASSED
```

Full sweep on the final tree — every command run as a plain command with its exit status read:

```
node test_engine.js            -> exit 0   ALL ENGINE GROUND-TRUTH CHECKS PASSED
node tests/run_tests.js        -> exit 0   ALL CHECKS PASSED
node tests/rule_checks.js      -> exit 0   passed: 23  failed: 0
node tests/util_smoke.js       -> exit 0   ALL UTIL CHECKS PASSED
node tests/injected_bridge.js  -> exit 0   checks passed: 12  failed: 0
node tests/config_check.js     -> exit 0   ALL CONFIG CHECKS PASSED
node tests/blackbox_guard.js   -> exit 0   checks passed: 28  50,616 stat values, 324 type cells
node tests/parser_fuzz.js      -> exit 0   ALL PARSER FUZZ CHECKS PASSED
node tests/hardening_audit.js  -> exit 0   46/46, 40-battle fuzz clean
```

**Zero regressions:** only one pre-existing expectation moved, and it is the `rule_checks.js`
assertion that encoded B9 (documented above).

## What this sweep did **not** prove

* **Nothing in a real browser.** There is still no Playwright/device run: every check uses the
  DOM-less sandbox, stub DOMs or replays. The UI/HUD rendering path remains unverified live.
* **Reachable but unvalidated leads** were deliberately left alone rather than "fixed blind":
  `laplace_core._oppActive` prefers `world.team[0]` before the state's own active body during a
  faint→replacement window; `simulate()` / `_mutableSim` are unreachable dead code; the
  `oppAction.kind === 'switch' → oppHp = 100` leaf shortcut does not substitute an incoming body;
  feeding the whole `possibleAbilities` list into `U.immunityReason` can hard-veto every action;
  `tempo_vector.dims` aliases the reused `this._vec`; and `protocol_parser._parseEffect` leaks the
  effect into `from` for `-activate`-style lines. Each needs a failing assertion before a fix, so
  they are logged, not patched.
* **The fuzz is a bounded sample, not a proof.** 40 seeded streams per run; a failure is
  reproducible, but the absence of one is not a theorem.
