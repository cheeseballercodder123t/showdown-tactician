# Bug fixes: the National Dex ladder report

Date: 2026-10-24
Scope: the defects reported after playing a real `[Gen 9] National Dex` ladder game, plus the
ones found while auditing the same code paths against `@pkmn/sim` and the vendored
`@smogon/calc` build.

The reported symptoms were reproduced from the user's own log and from the fixture; the deep-sweep
rows were reproduced against `@pkmn/sim` battles and the DOM-less harness. Sections 1-4 are the
report itself, section 5 is the first deep sweep, and sections 5h-5i plus 6-10 come from the
second sweep. Every fix in the second sweep was deliberately reverted one at a time to watch its
test fail (the mutation log is at the end); the remaining rows are pinned by the unit suites named
in the table.

---

## 1. `ENGINE OFFLINE / battle` on a ranked National Dex game

**Symptom.** The HUD refused to price the turn, printing `ENGINE OFFLINE / battle · National Dex
OU only`, on a normal ranked battle.

**Root cause.** Showdown opens a battle room with `|init|battle`. That token names the ROOM
KIND, not a format. The parser passed it to `setFormat()`, the NatDex allowlist rejected the
literal `"battle"`, and `formatSupported` became `false`. The real format arrives on
`|tier|[Gen 9] National Dex` (there is no `... OU` on the wire), which the parser was also not
consuming as a format line.

**Fix.**
- `src/protocol_parser.js`: `|init|` ignores room kinds (`battle`, `battle-gen9...`, `chat`,
  `room`, ...); `|tier|` is its own `format` event; a bare `|format|` no longer resets the board.
- `src/state_manager.js`: `setFormat()` also refuses room kinds, so a stray frame can never gate
  the engine off. `formatSupported` stays fail-open only for an *unknown header*, not for a
  room kind.

**Reproduction.** `tests/e2e/08-bugfix-regressions.spec.js` test 1 opens the fixture with
`|init|battle` and no `|tier|` at all. The pre-fix build produced no badges (it took the full
20 s `waitForBadges` timeout) and the banner read `ENGINE OFFLINE / battle`.

**Pinned by.** `tests/e2e/08-bugfix-regressions.spec.js` ("a live room opening with
`|init|battle` stays online..."), `tests/run_tests.js` (room-kind init, sibling tiers),
`tests/hardening_audit.js` (a bare `|format|` does not clear the board).

---

## 2. Fire Punch predicted 12%, did 98%

This was four separate errors with the same visible shape. Each is fixed and pinned.

### 2a. A stray bench tap survived the opponent's switch

**Symptom.** Every move bar kept advertising a range for a *benched* body after the opponent's
active changed. A Fire Punch into the newly-active Serperior showed the number for a 252+ Def
Garchomp (about 10-12%) instead of the ~100% it does.

**Root cause.** `_preview()` honoured `selectedBenchId` until the player tapped the card again.
Nothing cleared it when the opponent's active body changed, so the bench-target sandbox outlived
the board it described. The bar also did not say which body it had priced.

**Fix.** `src/content.js` clears the selection when their active changes; `src/ui_overlay.js`
labels every bench-targeted bar `… vs <species>` and the strip carries a `DAMAGE PREVIEW vs
<SPECIES>` caption, so a bench number can never pass as a live prediction.

**Reproduction.** `tests/e2e/08-bugfix-regressions.spec.js` test 4 taps Iron Valiant, then
switches Cresselia in while Iron Valiant stays benched. With the reset removed, all four bars
still read `vs Iron Valiant` and the test fails.

### 2b. The printed `L50` detail was believed in a level-100 battle

**Symptom.** Damage numbers roughly doubled in the wrong direction: a 252 HP Serperior was
priced as a 150 HP body, and the same Fire Punch read 388-457% instead of ~100%.

**Root cause.** Showdown prints a normalised `L50` in `|poke|` and `|switch|` details even in a
level-100 format. `_onSwitch` adopted it, halving the opponent's HP and defenses.

**Fix.** `src/state_manager.js` prices every body at the battle level (`_battleLevel()`, taken
from our own pasted team, 100 by default) and keeps the protocol string in `reportedLevel` for
display only.

**Reproduction.** The fixture's own `BATTLE_SETUP` carries `L50` details on both sides. Test 2
asserts Ice Spinner into Landorus-Therian stays below 250%; with the old assignment restored the
bar reads **542%** and the test fails.

### 2c. One candidate spread was printed as if it were the board

**Symptom.** `Guaranteed OHKO` on a hit that left the real Serperior at 2%, while a bulkier
candidate set in the same pool said 61%.

**Root cause.** `preview()` priced only `liveSet`, the pruner's favourite. Every other spread the
log had not ruled out was ignored.

**Fix.** `src/laplace_core.js` takes the envelope of up to eight surviving spreads: the lowest
min roll, the highest max roll, the worst KO chance, and an `isOHKO` that requires *every*
candidate to die. `is2HKO` now treats a guaranteed OHKO as satisfying the 2-hit question, so a
mixed range reads `2HKO` instead of the nonsensical `leaves them at ~0% HP`.

**Pinned by.** `tests/hud_check.js` §6 (the line covers the favourite spread's range and reports
`spreadCount`), `tests/e2e/08-bugfix-regressions.spec.js` test 2 (the verdict is `2HKO` or
`Guaranteed lethal`, never `leaves them at ~0%`).

### 2d. The generic fallback was Great Tusk in a costume

**Symptom.** An uncurated Serperior was described as `bulky @ Heavy-Duty Boots [ATK 252 / SPE
252]`, with Protosynthesis (Great Tusk's ability) and a physical Adamant spread, so its matchup
was priced against a body that cannot exist.

**Root cause.** `SetDatabase.DEFAULT` is built from Great Tusk and was used as the fallback for
every species with no curated sets. The generic builder also used `atk >= spa`, which calls
Serperior's 75/75 a physical attacker.

**Fix.** `src/sets_db.js` adds `genericFor(species)`, which derives the ability and the
physical/special split from the species itself; `src/set_pruner.js` and `src/world_sampler.js`
prefer it before `DEFAULT`; ties go special.

**Pinned by.** `tests/hardening_audit.js` §5d (no Protosynthesis/Quark Drive on a Serperior, SpA
investment, legal ability).

**Reproduced end to end.** `tests/hardening_audit.js` §5i rebuilds the reported board — a burned
Guts Ursaluna with Fire Punch in its pasted set, against a Serperior with the pruner pool in place
— and prices it through the same `preview()` entry point the bars use. The Fire Punch line is now
**60.5-120.3% across 5 surviving spreads** (the bulkiest, 252 HP / 252+ Def, is the 60.5% floor;
no spread dies in one hit, so the verdict is `2HKO`, not a guarantee). The old 12% is not
reachable: 12% belongs to a benched 252+ Def Garchomp, and the bench selection that produced it is
gone (2a).

---

## 3. "Confirmed reads" were useless

**Symptom.** The ticket row repeated `CHOICE LOCK BROKEN / BAND · SPECS · SCARF RULED OUT` once
per body and never showed the opponent's moves, items or abilities.

**Root cause.** That row was the only deduction surface, and its one recurring line is a
negative. The item/ability ledgers existed but only `|-item|` and a couple of hardcoded
`|-activate|` names ever reached them.

**Fix.**
- The ticket row is gone. `src/ui_overlay.js` renders an **OPPONENT SCOUT** ledger listing, per
  revealed opponent, the moves it has used, the item it has shown and the ability it has
  revealed (`src/content.js _scoutEntries`).
- Item reveals now also come from residual effects: `|-heal|…|[from] item: Leftovers`, Life Orb
  recoil, a Sitrus Berry, Rocky Helmet via its `[of]` holder, and every
  `|-activate|…|item: <Item>` (Mega Stones, Z-Crystals, Focus Sash).
- Ability reveals now come from any `[from] ability:` clause: weather (Snow Warning), terrain,
  stat boosts (Speed Boost, Download), damage recoil (Rough Skin), status/cure lines (Static,
  Immunity), `|-immune|` (Levitate, Flash Fire, Sap Sipper), and `|-formechange|` (Stance
  Change).

**Reproduction.** `tests/e2e/08-bugfix-regressions.spec.js` test 5 walks all three shapes: a
Moonblast, a Leftovers heal with no `|-item|`, and Levitate on an immunity line. Removing the
immunity-clause read makes the ledger print Cresselia without Levitate and the test fails.

**Pinned by.** The test above, `tests/hardening_audit.js` §5c/§5e, `tests/hud_check.js` §9b.

---

## 4. WIDE was unusable and the text was unreadable

**Symptom.** WIDE was a full-height rail over the chat column, with 9px uppercase type and
pale-blue-on-tan labels.

**Fix.** `styles/overlay.css` docks the console bottom-right, content-sized, capped at 72 vh
with its own scroll; the type scale moved to 12.5-14.5px body text and 10-11px labels with
tracking reduced; `--st-muted`/`--st-quiet` were raised to clear 4.5:1 on the panel surface; the
panel opens expanded and collapses on the title bar. The scout card was added to both layout
migrations (it had been omitted, so it vanished on a desktop/mobile switch).

**Reproduction.** `tests/e2e/08-bugfix-regressions.spec.js` test 6 checks the panel is inside
1440×900, ≤ 440px wide, ≤ 650px tall, does not intersect a move button, has no horizontal
overflow, no shadow, square corners, and ≥ 13.5px type. `02-hud.spec.js` repeats the geometry
contract at the real 1440×900 and checks every painted text colour clears 4.5:1.

---

## 5. State integrity found by the deep sweep

These did not have a visible screenshot but corrupted the numbers the HUD quoted.

| # | Defect | Effect | Fix | Test |
|---|--------|--------|-----|------|
| 1 | Fractional HP rejected (`^\d+$`) | First non-round hit was discarded; the body read 100% for the rest of the battle | `parseHPString` accepts numbers and decimals; `parseHPStatus` uses `parseFloat` so `72.06/100` keeps its fraction | e2e test 3, hardening §5g |
| 2 | Battle-forme changes minted duplicates | Aegislash-Blade / Mimikyu-Busted came back as a second MonState: seven-body team, phantom bench card, wrong alive count | `rosterSpecies` + `formsSeen` + `_findBattleForme` | hardening §5b |
| 3 | `is2HKO` is exclusive of OHKO in the calculator | A mixed envelope read `leaves them at ~0% HP` | an OHKO spread also satisfies the merged 2HKO | e2e test 2 |
| 4 | Multi-hit moves priced at 3 hits | Skill Link Bullet Seed understated by two fifths | `hits: 5` (Skill Link) / `hits: 4` (Loaded Dice) | hardening §5f |
| 5 | Loaded Dice checked as an *ability* | The item branch was dead code: a Loaded Dice Bullet Seed still used 3 hits | check the attacker's item | hardening §5f |
| 6 | A knocked-off Choice Band kept multiplying damage | Every later hit was 1.5x too high; a consumed Assault Vest kept its SpD | `itemRemoved`/`itemConsumed` clears the item | hardening §5f |
| 7 | Battle-only type changes ignored | Protean/Soak bodies were priced with their species typing | `typeOverride` through the calc and its memo key | hardening §5f |
| 8 | Mimikyu's Disguise priced as a normal hit | "Guaranteed OHKO" on a full-health Mimikyu that takes zero | clear on `|-activate|…|Disguise`, price the first hit at 0 | hardening §5f |
| 9 | `-clearpositiveboost`, `-invertboost`, `-swapboost`, `-copyboost` dropped | Defog/Topsy-Turvy/Heart Swap/Psych Up left stat stages the battle had erased | parse + apply all four | hardening §5g |
| 10 | `-typechange` dropped | Soak / Burn Up / Protean typing never reached the engine | parse + apply, including `typeadd` | hardening §5f |
| 11 | Faint kept stat boosts | A fainted body still advertised stages to the evaluator | faint resets every stage | hardening §5g |
| 12 | Synthetic speed-floor/residual events duplicated their raw line | The battle transcript repeated a move line | `synthetic: true` suppresses the second log push | `tests/parser_fuzz.js` |
| 13 | `|t:|` timestamps counted as unknown commands | Noise in the unknown stream | `t:` and the blank `|` frame are noise | hardening §5g |
| 14 | Em dashes and labels in UI strings | Banned typography and hard-to-scan copy | all UI strings use `/`, `.`, or `:` | e2e test 6 asserts the rendered HUD copy contains no em dash and no emoji |

---

## 6. A called move was counted as a click

**Symptom.** The scout ledger credited the opponent with moves it does not own, and a body that
clicked one move could still be stamped `CHOICE ITEMS RULED OUT` (the old ticket text) even when
it had never used a second move of its own.

**Root cause.** Showdown prints a SECOND `|move|` line for a move the battle called, with the cause
in a `[from]` clause: `|move|p2a: Clefable|Sleep Talk|...` then
`|move|p2a: Clefable|Moonblast|p1a: X|[from]Sleep Talk`. The parser dropped the clause and the state
manager treated both lines as clicks, so the stint grew to two distinct moves. The pruner reads a
second distinct move in one stint as proof that no Choice item is held, and the scout ledger read
the same list, so a Metronome Moonblast appeared as a known move.

**Fix.** `_parseMove` exposes `from`. `_onMove` no longer puts a called move into the stint, the
`ppUsed` counter, `revealedMoves` or `lastMove`; the caller's own line remains the click. The
board effects below that point still run, so a called Trick Room, Wish, hazard or Knock Off is
applied exactly as before.

**Reproduction.** `tests/hardening_audit.js` §7: a Clefable that uses only Sleep Talk and takes a
called Moonblast must keep the stint at `['Sleep Talk']`, must not be credited with Moonblast, and
must not trip the Choice rule; a called Trick Room must still set the field.

---

## 7. Mega Evolution kept the base ability

**Symptom.** The scout ledger named Limber on Mega Lopunny, Intimidate on Mega Gyarados and Swarm
on Mega Scizor, and Normal/Fighting moves into a Ghost were priced as an immunity even though
Scrappy was on the field.

**Root cause.** Mega Evolution changes the ability, but Showdown sends no `|-ability|` line for it.
`_markMega` adopted the new forme and the stone and never touched `revealedAbility`, so every
ability-dependent number (damage, immunity, threat model) used the base forme for the rest of the
battle.

**Fix.** `src/state_manager.js _markMega` adopts the forme's ability when the dex lists exactly
one (true for every Mega), writing `revealedAbility`, `ability` and `activeAbility`.

**Reproduction.** `tests/hardening_audit.js` §5c asserts the Lopunny's revealed ability is
`Scrappy` while the Ninetales' Snow Warning is still not credited to it.

---

## 8. Uncurated species were a stranger with the dex's first ability

**Symptom.** A generic Serperior was modelled with Overgrow and Psychic/Shadow Ball; a generic
Dragonite with Inner Focus (so Multiscale never halved anything); a generic Scizor with Swarm (so
Technician was unpriced). A revealed ability could also empty the pool, after which the
"never empty" fallback re-published sets carrying the ability the log had just disproved.

**Root cause.** `sets_db.genericFor` used `U.getAbilities(...)[0]` (dex order, not competitive
order) and a fixed move pool shared by every species in the physical or special bucket.

**Fix.** A `GENERIC_ABILITY_PRIORITY` preference among the abilities the species legally has; one
cheaper boots variant per remaining legal ability, so a reveal is always representable; STAB moves
derived from the body's own typing; the Scarf template given the same physical/special split as
its moves; de-duplicated move lists.

**Reproduction.** `tests/hardening_audit.js` §5d: the generic Serperior leads Contrary and still
lists Overgrow, Dragonite leads Multiscale and still lists Inner Focus, no generic pool carries
Psychic/Shadow Ball/Volt Switch as filler, every Serperior set leads with a Grass move, and its
Scarf set is Timid with 252 SpA.

---

## 9. The type floor was not actually applied

**Symptom.** The reported "text is practically unreadable" survived the first design pass: the
panel's inherited size was 13.5px but most of its labels painted at 8-10.5px, and the final
"field folio" block re-declared them through `font:` SHORTHANDS, which the earlier longhand-only
pass never touched.

**Fix.** Every `font-size` and `font:` shorthand in `styles/overlay.css` below 11px is raised to
11px; the two density-constrained mobile sheet badges (the match count and the 60px identity
chip) and the decorative PICK tag stop at 10px. No layout rule was relaxed; the geometric
contract test still passes.

**Reproduction.** `tests/e2e/08-bugfix-regressions.spec.js` test 6 walks every element in the WIDE
console that paints a text node and asserts the smallest computed size is at least 10px (11px in
the stylesheet; the assertion leaves a pixel for rounding).

---

## 10. A faint credited the wrong body, and Illusion reset the board

**Symptom.** The match receipt credited a KO to a body that had not landed the final hit; a
Zoroark whose Illusion broke lost stat stages the board still showed.

**Root cause.** The KO tally is keyed by SLOT and was never cleared on switch-in, so a replacement
inherited its predecessor's last attacker (hazard and status faints carry no attacker). And
`|replace|` was routed through `_onSwitch`, which resets boosts, the stint, volatiles and
`switchedInTurn` even though the body never left the field.

**Fix.** `_onSwitch` clears `_lastDamager[slot]` before installing the new occupant, and treats
`event.from === 'replace'` as a re-identification: HP and identity update, nothing else resets.

**Reproduction.** `tests/hardening_audit.js` §5h: a Stealth Rock faint after a switch is not
credited to the earlier attacker, and a `|replace|` keeps `+2 Atk`, the stint and the original
`switchedInTurn`.

---

## Verification

### Suites

- `node tests/run_all.js` - **35/35 suites passed** (68.4 s), including `hud_check` 266 checks,
  `dom_check` 161, `run_tests` 254, `hardening_audit` 130.
- `npx playwright test` - **56/56 passed** (57.3 s), including the six regression tests in
  `tests/e2e/08-bugfix-regressions.spec.js`.
- `node tests/arena_check.js` - damage/state checks against 40 real `@pkmn/sim` battles.
- `node tests/hardening_audit.js` - 130 checks plus the seeded 40-battle fuzz.

### Damage model vs the real simulator

A scratch harness (not committed) replayed 40 seeded `gen9nationaldex` battles and compared
every damaging line the engine could price against the sim's own HP deltas: **102 hits, 100
inside the predicted envelope**. The only two exceptions were Mimikyu hits absorbed by Disguise,
which the preview now models explicitly (and which the unit suite pins at 0%). No hit landed
outside its range.

### Mutation log (deliberate break, then restore)

Each row is a real run of the named test with the fix removed.

| Reverted fix | Test | Observed failure |
|---|---|---|
| Room-kind guard in parser **and** `setFormat` | e2e 1 | `waitForBadges` timed out after 20 s; no bars rendered (engine offline) |
| `mon.level = this._battleLevel()` | e2e 2 | `expect(range.max).toBeLessThan(250)` received **542** |
| `parseHPString` number/decimal branches | e2e 3 | card never reached `72%` (stuck at 100%); 5 s timeout |
| `_revealAbilityFromClause` on `|-immune|` | e2e 5 | `expect(scout).toContain('Levitate')` failed |
| Bench-selection reset in `_preview` | e2e 4 | bars kept ` vs Iron Valiant` while Cresselia was active; 5 s timeout |
| Banner copy joined with a literal em dash | e2e 6 | `expect(copy).not.toContain('\u2014')` failed |
| `const called = !!event.from` (second sweep) | hardening §7 | stint became `['Sleep Talk','Moonblast']`, `lastMove` became Moonblast, and the Choice rule returned `{pruned:true, distinct:2}` |
| Mega ability adoption in `_markMega` | hardening §5c | `got null, want "Scrappy"` |
| `genericAbility` preference list | hardening §5d | `got "Overgrow", want "Contrary"` and `got "Inner Focus", want "Multiscale"` |
| `delete _lastDamager[slot]` on switch-in | hardening §5h | `{"gholdengo":1}` — the hazard faint was credited to the earlier attacker |
| `replacing` guard in `_onSwitch` | hardening §5h | boosts `got 0, want 2`; stint `got [], want ["Night Slash"]`; `switchedInTurn got 2, want 1` |
| Type floor in the field-folio `font:` shorthands | e2e 6 | `rail.minFontSize` **9**, expected >= 10 |

The format mutation only fails when BOTH guards are removed (the parser's room-kind check and
`setFormat`'s), because either one alone preserves the behaviour; the first attempt with just the
parser reverted passed, which is why the table records the double revert. One mutation attempt was
inconclusive and is recorded rather than hidden: setting `.st-console-count` to 9px in its FIRST
declaration passed the font check, because a later field-folio rule (and after that, a `font:`
shorthand) wins the cascade. The mutation that failed was made in the rule that actually paints.

All mutations were reverted and the affected suites re-run green after each restore.

---

## Known limitations

- The end-to-end suite runs against a deterministic fixture served at the real Showdown origin,
  not the live ladder. The format fix is proven at the protocol level; the remaining live-only
  variable (whether a specific transport sends `|tier|`) now fails safe, because a room-kind
  `|init|` never changes `formatSupported`, and an actual `|tier|` still sets it.
- The "12%" figure was traced to the bench-target mechanism (2a), which is reproduced
  deterministically by the new test; the original build's exact click sequence is not available,
  so the report does not claim a byte-for-byte replay of that render.
- `genericFor` covers every NatDex species by construction and now derives STAB from the body's
  own typing, but it still cannot prove LEGALITY (no learnset is vendored): a generic move can be
  a plausible move that a particular species does not learn. The pruner's curated entries still
  win whenever they exist, and the pool is only ever a prior.
- The readable-type floor is verified at 1440x900 in the WIDE console. The mobile sheet has its own
  `@media (max-width: 420px)` overrides; those were raised by the same pass but are not measured by
  an automated geometry test.
