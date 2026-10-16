# Showdown Tactician — Interface Contract (read before editing any module)

Everything in `src/` is a **classic script** (no ES modules, no `import`/`export`).
Each file is wrapped in an IIFE and publishes exactly one class onto the shared global
namespace `window.ST`. `window.ST.CONFIG` (from `src/config.js`), `window.ST.util` (from
`src/util.js`) and the vendored `window.calc` dex are already loaded before every other module,
because the manifest lists scripts in this order:

```
lib/calc-data.min.js   -> window.calc.{SPECIES,MOVES,ITEMS,ABILITIES,TYPE_CHART,NATURES,MEGA_STONES} (per-gen arrays)
lib/calc.min.js        -> window.calc.{Generations,Pokemon,Move,Field,Side,Result,calculate}
src/config.js          -> ST.CONFIG, ST.configGet/configSnapshot/configMerge (RULE 4: every heuristic)
src/util.js            -> ST.util
src/sets_usage.js      -> window.ST_USAGE      (GENERATED DATA, ships empty; read by sets_db at load)
src/sets_db.js         -> ST.SetDatabase       (reweightByUsage() applies the overlay above)
src/team_parser.js     -> ST.TeamParser
src/protocol_parser.js -> ST.ProtocolParser
src/state_manager.js   -> ST.BattleStateManager
src/set_pruner.js      -> ST.ArchetypePruner
src/calc_engine.js     -> ST.DamageEngine
src/trick_room.js      -> ST.TrickRoomEngine
src/evaluator_128d.js  -> ST.DenseStateEvaluator
src/tempo_vector.js    -> ST.TempoEngine
src/opponent_clock.js  -> ST.OpponentClock
src/veto_guard.js      -> ST.BlunderVetoGuard
src/world_sampler.js   -> ST.WorldSampler
src/laplace_core.js    -> ST.LaplaceEngine
src/llm_client.js      -> ST.LLMTactician
src/ui_overlay.js      -> ST.MobileHUD
src/content.js         -> boots the whole pipeline
```

Boilerplate every module MUST use:

```js
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const { toID, clamp } = ST.util;          // util.js and config.js are guaranteed to be loaded first
  class Foo { /* ... */ }
  ST.Foo = Foo;                              // exactly one export per file
})();
```

Rules:
* **No math of your own.** Damage, type effectiveness and stats are the vendored
  `@smogon/calc` bundle's job: `calc.calculate(...)` (only from `calc_engine.js`) and
  `calc.Stats.calcStat(...)` (only through `ST.util`). `tests/blackbox_guard.js` diffs tens of
  thousands of stat values against the library and statically fails if a stat formula, a
  hand-typed type chart, a base-stat table or a `bp / 50 + 2` damage formula appears in `src/`.
* **No heuristic literals.** Every weight, threshold, probability and model id lives in
  `src/config.js` and is read with `ST.configGet('section.key', <same value as the fallback>)`.
  A module that reads at load time captures once (that is by design); the fallback argument is
  only for a stripped build, never a place to keep a second opinion.
* Never touch `document`/`chrome` at load time — only inside methods (the Node test
  harness loads these files with no DOM).
* When setting classes on a real DOM node, pass ONE token at a time. `classList.add('a b')` throws
  `InvalidCharacterError`, and the harness stub (whose `classList` is a plain Set) will not catch
  it: `_el()` in ui_overlay.js adds each token separately for exactly this reason.
* Never use `chrome.*` outside of `try/catch` (the test harness has no `chrome`).
* No `console.log` spam on hot paths; use `ST.util.debug(...)` which is a no-op unless
  `ST.util.DEBUG` is true.
* Performance target: a full `evaluateTurn` cycle must stay under 10 ms of synchronous
  work on a Galaxy S24 FE. Cache damage results per turn. Never allocate inside loops
  that run per candidate action where a preallocated `Float32Array` will do.

## Native dex access (via `ST.util` for the dex and the stat arithmetic, `ST.DamageEngine` for damage)

`CALC.Generations.get(9)` is the NatDex dex (1406 species including Megas and Z-move
holders). `calc.SPECIES[9]`/`calc.MOVES[9]` are raw tables using **short keys**
(`bs.at`, `category` missing for status moves) — `ST.util` normalizes them. Use:

```js
ST.util.getSpecies(name)   // {name,id,baseStats{hp,atk,def,spa,spd,spe},types[],abilities[],gender,weightkg,baseSpecies,canMegaEvolve,megaSpecies,isParadox,isMega}
ST.util.getMoveData(name)  // {name,id,basePower,type,category,priority,isStatus,isProtect,isRecovery,isPivot,isHazard,isPhazing,isZMove,isMaxMove}
ST.util.typeEffectiveness(atkType, speciesName)   // number, 0 | .25 | .5 | 1 | 2 | 4 (calc.TYPE_CHART, applied by us)
ST.util.typeMultiplier(atkType, defTypes[])       // number
ST.util.libraryReady()                            // true when the vendored calc bundle is live
ST.util.libraryStat(stat, base, iv, ev, level, nature)   // calc.Stats.calcStat, raw
ST.util.calcStat(stat, {base, iv, ev, level, nature})    // the stat NAME and the nature NAME
ST.util.calcHP(base, iv, ev, level)                       // = calcStat('hp'), Shedinja-correct
ST.util.statTable(species, {ivs, evs, level, nature})     // all six stats, from the library
ST.util.computeSpeed(speciesName, opts)           // {raw, effective, rank}
ST.util.natureMultiplier(nature, stat)            // the ONLY ±10% step in the project
ST.util.megaStoneFor(speciesName) / ST.util.megaSpeciesFromStone(stone) / ST.util.canMegaEvolve(name)
ST.util.isChoiceItem(item) / ST.util.isZCrystal(item) / ST.util.isMegaStone(item) / ST.util.isBoosterEnergy(item)
ST.util.closestSpeciesName(input)  // fuzzy match for nicknames; null if nothing is close
ST.util.tokenizeDetails('Great Tusk, L50, M') // {species, level, gender, shiny}
ST.util.clamp/clampStat/toID/round2/formatPercent/deepClone/escapeHtml/mean/median
ST.util.moveLookupStats()  // {entries, idIndex, toIDEntries} — diagnostics only; nothing in src/ reads it
ST.util.CHOICE_ITEMS, ST.util.Z_CRYSTALS, ST.util.PROTECT_MOVES, ST.util.RECOVERY_MOVES,
ST.util.PIVOT_MOVES, ST.util.HAZARD_MOVES, ST.util.TR_SETTERS, ST.util.STATS, ST.util.TYPES
```

Three lookup rules a caller can rely on (each was a bug once, and each is pinned in
`tests/util_smoke.js`):

* **A miss is an answer.** `getMoveData` remembers "not a move" for a species, a typo, a Z-move the
  table lacks — it answers `null` in O(1) every time, rather than re-scanning the table. The same is
  true of `toID`, which is memoised behind the function (a caller cannot tell whether it hit).
* **Own keys only.** `RAW_MOVES['constructor']` answers from `Object.prototype` in the vendored
  bundle, so the raw lookup is guarded by `hasOwnProperty`: none of `constructor`, `toString`,
  `valueOf`, `hasOwnProperty`, `__proto__` is a move, and none may be turned into one.
* **A move name may arrive as a display name, an id, or neither.** Display name and id resolve to the
  same cached object; only a real move ever produces one.

## 1. Canonical shapes

### 1.1 `MonState` (one per Pokémon, both sides) — produced by `BattleStateManager`

```js
{
  id: 'greattusk',            // ST.util.toID(species)
  species: 'Great Tusk',      // canonical display name
  side: 'p1' | 'p2',
  slot: 'p1a' | 'p2b' | null, // last known field slot
  index: 0,                   // 0..5, order of first appearance / team preview
  revealed: true,             // false = still unknown (team preview unrevealed slot)
  level: 100, gender: '',     // '' | 'M' | 'F' | 'N'

  hp: 100,                    // CURRENT HP PERCENT 0..100 (Showdown protocol unit), null if unknown
  maxhp: 100,                 // always 100 (protocol reports percent)
  hpPercent: 100,             // alias of hp, always kept in sync
  fainted: false,
  status: '' | 'brn' | 'tox' | 'par' | 'slp' | 'frz',
  statusTurns: 0,             // turns spent in the current status (toxic counter / sleep counter)
  toxicCounter: 0,            // 0 when not badly poisoned
  boosts: { atk:0, def:0, spa:0, spd:0, spe:0, accuracy:0, evasion:0 },
  volatiles: { substitute:false, leechseed:false, encore:false, taunt:false, disable:false, confusion:false },
  terastallized: false,
  turnedThisTurn: false,      // set by |-prepare|/|move|, cleared on |turn|

  // reverse damage deduction (src/set_pruner.js) — written by BattleStateManager only
  damageDealt: [ {            // every hit THIS mon landed on our side, newest last (<= 8)
    turn: 4, moveName: 'Power Whip', moveId: 'powerwhip',
    damagePercent: 38, hpBefore: 100, hpAfter: 62,   // percent of the VICTIM's max HP
    crit: false,                                     // |-crit| latch, never used as evidence
    attackerIsP1: false, defenderId: 'hatterene',
    defenderBoosts: {}, defenderStatus: '', weather: '', terrain: '',
    sig: '4:powerwhip:38:'                      // dedupe key for a mirrored poll line
  } ],
  critTurn: null,             // the turn the last |-crit| on this mon landed

  // item knowledge — THE ONLY FIELDS THE PRUNER MAY WRITE
  originalArchetypeItem: null,  // what the candidate set assumed it holds
  confirmedItem: null,          // 100% known (HDB proof, Trick reveal, |-item|)
  currentBattleItem: null,      // what it holds RIGHT NOW (changes on Trick/Knock Off)
  itemConsumed: false,          // Focus Sash / Booster Energy / Air Balloon popped, Berry eaten
  itemKnockedOff: false,        // a Knock Off CONNECTED and the item did NOT leave (irremovable or nothing held)
  itemRemoved: false,           // an item was taken off this Pokémon (Knock Off that removed it, Trick)
  itemIsIrremovable: false,     // Mega Stone / Z-Crystal proven still held
  itemless: false,              // proven to have no item (Acrobatics / Unburden)
  cannotBeChoice: false,        // permanent hard blacklist of Choice items
  cannotBeBoosterEnergy: false, // permanent
  megaEvolved: false,
  usedZMove: false,
  boosterConsumed: false,       // item gone
  boosterActive: false,         // Protosynthesis/Quark Drive currently boosting (see boostedStat below)
  alliesFainted: 0,             // fainted teammates, restamped by _stampFallen() on every event:
                                // feeds Supreme Overlord / Last Respects through calc_engine

  // move knowledge
  revealedMoves: [],            // ['Headlong Rush', ...] unique, discovery order
  activeStintMoves: [],         // moves used since the last switch-in (drives choice pruning)
  activeStintCount: 0,          // number of distinct moves this stint
  movePP: {},                   // { recover: 5 } known remaining PP for 8-PP recovery moves
  lastMove: null,
  lastMoveTurn: 0,

  // ability knowledge
  revealedAbility: null,
  possibleAbilities: [],        // from ST.util.getSpecies().abilities

  // speed inference (written only by BattleStateManager + ArchetypePruner)
  speedFloor: 0,                // opponent's true Speed is >= this
  speedCeiling: 1012,           // ... and <= this
  speedEvidence: [],            // human-readable strings, newest last
  speedOverride: null,          // set by Trick Room engine when raw speed is known (choice scarf math)

  // candidate space (written by ArchetypePruner / WorldSampler)
  candidateSets: [],            // SetCandidate[] surviving every deduction
  prunedReasons: [],            // ['Choice lock: used 2 moves in one stint', ...]
  liveSet: null,                // SetCandidate currently believed (highest weight survivor)

  // derived helpers
  isActive: false
}
```

Fields marked "written only by X" are the ownership boundaries that keep the modules from
fighting each other. When in doubt, read; do not write another module's fields.

### 1.2 `SetCandidate` — produced by `ST.SetDatabase`, filtered by `ST.ArchetypePruner`

```js
{
  id: 'greattusk-scarf',        // unique, kebab-case
  species: 'Great Tusk',
  role: 'scarf' | 'band' | 'specs' | 'wallbreaker' | 'bulky' | 'setup' | 'hazard' |
        'hazardremoval' | 'wall' | 'pivot' | 'booster' | 'itemless' | 'z' | 'mega' | 'support',
  item: 'Choice Scarf' | null,  // null === itemless (Acrobatics / Unburden archetype)
  ability: 'Protosynthesis',
  nature: 'Jolly',
  evs: { hp:0, atk:252, def:0, spa:0, spd:4, spe:252 },
  ivs: { hp:31, atk:31, def:31, spa:31, spd:31, spe:31 },   // 0 Spe for TR sets
  moves: ['Headlong Rush','Close Combat','Ice Spinner','Rapid Spin'],   // 1..4 entries
  weight: 0.17,                 // 0..1 prior probability (Smogon usage-ish), normalized per species by the sampler
  tags: ['choice','scarf','physical'],
  isMega: false,                // item is a Mega Stone
  isZCrystal: false,
  itemlessArchetype: false,     // true only for role 'itemless'
  notes: ''                     // optional short string
}
```

`ST.SetDatabase` API:

```js
ST.SetDatabase.forSpecies('Great Tusk')  // SetCandidate[] (never null; [] when nothing known)
ST.SetDatabase.allSpecies()              // string[]
ST.SetDatabase.has('Great Tusk')         // boolean
ST.SetDatabase.DEFAULT                 // SetCandidate[] used for unknown species (generic filler sets)
```

### 1.3 `FieldState`

```js
{
  turn: 1,
  trickRoom: false,
  trickRoomTurnsLeft: 0,     // 5..0, only meaningful while trickRoom is true
  weather: '' | 'sun' | 'rain' | 'sandstorm' | 'snow' | 'harshsun' | 'heavyrain',
  weatherTurnsLeft: null,    // number | null when unknown/permanent
  terrain: '' | 'electric' | 'grassy' | 'psychic' | 'misty',
  terrainTurnsLeft: null,
  hazards: {
    p1: { rocks:false, spikes:0, toxicspikes:0, stickyweb:false, steelspikes:0 },
    p2: { rocks:false, spikes:0, toxicspikes:0, stickyweb:false, steelspikes:0 }
  },
  screens: {
    p1: { reflect:false, lightscreen:false, auroraveil:false },
    p2: { reflect:false, lightscreen:false, auroraveil:false }
  },
  tailwind: { p1:false, p2:false },
  gravity: false
}
```

### 1.4 `BattleState` — the single source of truth (`ST.BattleStateManager.state`)

```js
{
  format: '[Gen 9] National Dex OU',
  formatSupported: true,     // false -> UI shows an unsupported-format banner and the
                             // engine stays silent (LaplaceEngine returns [])
  terastallizationBanned: true,
  turn: 1,
  mySide: 'p1', oppSide: 'p2',
  myTeam: MonState[6],
  oppTeam: [MonState],       // 1..6, ids from team preview / first sighting
  field: FieldState,
  formatLocks: {
    oppHasMegaEvolved: false,
    oppHasUsedZMove: false,
    oppMegasRemaining: 0,        // count of opponent Pokémon still holding a Mega Stone (0 or 1 realistically)
    oppHasMegaStone: false,      // any surviving candidate set is a Mega Stone
    myMegaAvailable: false,
    myZMoveAvailable: false
  },
  active: { my: MonState|null, opp: MonState|null },
  bench:  { my: MonState[], opp: MonState[] },
  recoveryPP: { 'p2a:recover': 8 },   // key: '<slot>:<moveid>'
  clock: null,                        // OpponentClock.snapshot() — see src/opponent_clock.js.
                                      // Written by src/content.js on every protocol line and
                                      // read by laplace_core (_oppSwitchPrior) and the HUD.
                                      // null or enabled:false means "no opinion": every
                                      // opponent reply is kept.
  protect: {                          // stall-rhythm tracking (TempoEngine reads this)
    oppTurnsSinceLastProtect: 99, oppConsecutiveProtects: 0, oppLastProtectTurn: -99,
    myTurnsSinceLastProtect: 99,  myConsecutiveProtects: 0,  myLastProtectTurn: -99,
    oppProtectedLastTurn: false
  },
  request: null,             // last parsed |request| JSON
  legalActions: {
    moves: [ { id:'headlongrush', name:'Headlong Rush', pp:16, maxpp:16, target:'normal',
               disabled:false, disabledReason:'' } ],
    switches: [ { id:'ironvaliant', name:'Iron Valiant', slot:'p1b' } ],
    trapped: false,
    forceSwitch: false
  },
  history: { turns: [], events: [] },  // bounded ring buffers (MAX_LOG = 200 lines)
  log: [],                             // raw protocol lines, bounded to 200
  // Counted straight from the log, for the post-match receipt (src/content.js builds the card,
  // src/ui_overlay.js draws it). damage/kos are keyed by mon id and cover BOTH sides.
  battleStats: {
    damage: {},                        // monId -> percent of the opponent's HP it removed
    kos: {},                           // monId -> bodies it has taken off the board
    trActiveTurns: 0,                  // |turn| headers with Trick Room up
    trAttackTurns: 0,                  // ...of those, turns OUR side actually attacked in
    snowTurns: 0,
    magicBounce: 0,
    bestHit: null                      // our hardest single hit: { turn, monId, moveId, percent }
  }
}
```

### 1.5 `ParsedMon` — produced by `ST.TeamParser`

```js
{
  name: 'Great Tusk',      // species (or the player-set nickname-resolved species)
  species: 'Great Tusk',
  nickname: '',
  item: 'Choice Scarf' | '',
  ability: 'Protosynthesis' | '',
  nature: 'Jolly' | '',
  level: 100,
  gender: '' | 'M' | 'F',
  teraType: '' ,           // parsed but unused (Tera is banned in this format)
  evs: { hp:0, atk:252, def:0, spa:0, spd:4, spe:252 },   // missing -> 0
  ivs: { hp:31, atk:31, def:31, spa:31, spd:31, spe:31 }, // missing -> 31, 'IVs: 0 Spe' -> spe: 0
  moves: ['Headlong Rush','Close Combat','Ice Spinner','Rapid Spin'],  // 0..4 strings
  isTR: false,             // nature/EV/IV heuristic: spe drop present AND 0 Spe IV, or min-hp min-spe
  raw: 'Great Tusk @ Choice Scarf\n...'
}
```

## 2. The `protocol_parser.js` ⇄ `state_manager.js` seam

`ST.ProtocolParser` is a pure parser + event emitter. It owns no state beyond
`currentTurn` and per-side slot maps. Signature:

```js
const parser = new ST.ProtocolParser();     // constructor(initialFormat)
parser.feed(rawLine)          // one protocol line, with or without the leading '|'
parser.feedLines(lines[])     // batch; also accepts a full battle log string via feedAll(str)
parser.subscribe(handler)     // handler(event) for EVERY event; returns an unsubscribe fn
parser.on(type, handler)      // filtered subscribe; returns an unsubscribe fn
parser.parseLine(rawLine)     // -> event object without emitting (pure, used by tests)
parser.setMySide('p1')
```

Every event object **always** carries `type` and `raw` (the raw line). The complete,
frozen event table:

| `type` | extra fields |
| --- | --- |
| `init` | `{ format }` — emitted by a `>start` / `|format|` header |
| `player` | `{ side:'p1'\|'p2', name, avatar, rating }` |
| `teamsize` | `{ side, size }` |
| `poke` | `{ side, slot, species, details, item, hp, status, gender, level }` — team preview `\|poke\|` |
| `switch` | `{ side, slot, species, details, hp, status, from:'switch'\|'drag'\|'replace', level, gender }` |
| `move` | `{ side, slot, species, move, moveId, isZ, isMax, targetSide, targetSlot, revived }` |
| `cant` | `{ side, slot, species, reason, move }` |
| `boost` | `{ side, slot, species, stat, amount }` |
| `unboost` | `{ side, slot, species, stat, amount }` |
| `setboost` | `{ side, slot, species, stat, amount }` |
| `clearallboost` | `{}` |
| `clearnegativeboost` | `{ side, slot, species }` |
| `damage` | `{ side, slot, species, hp, status, from }` |
| `heal` | `{ side, slot, species, hp, status, from }` |
| `sethp` | `{ side, slot, species, hp, status }` |
| `status` | `{ side, slot, species, status, from }` |
| `curestatus` | `{ side, slot, species, status }` |
| `cureteam` | `{ side, slot, species }` |
| `faint` | `{ side, slot, species }` |
| `item` | `{ side, slot, species, item, from, ofSide, ofSlot, ofSpecies }` |
| `enditem` | `{ side, slot, species, item, reason }` |
| `activate` | `{ side, slot, species, effect, args[] }` |
| `start` | `{ side, slot, species, effect, args[] }` (volatiles/field-ish start effects) |
| `end` | `{ side, slot, species, effect }` |
| `sideStart` | `{ side, effect }` (`\|sidestart\|` — hazards & screens) |
| `sideEnd` | `{ side, effect }` |
| `fieldStart` | `{ effect, args[] }` |
| `fieldEnd` | `{ effect }` |
| `weather` | `{ weather, from }` (payload `''` clears) |
| `terrain` | `{ terrain }` |
| `turn` | `{ turn }` |
| `upkeep` | `{}` |
| `request` | `{ json }` — `json` is the parsed `\|request\|` payload |
| `formechange` | `{ side, slot, species, details, hp }` |
| `detailschange` | `{ side, slot, species, details }` |
| `replace` | `{ side, slot, species, details }` |
| `terastallize` | `{ side, slot, species, type }` |
| `zpower` | `{ side, slot, species, move }` |
| `speedfloor` | `{ side, value, species, oppMove, myMove, turn, reason }` — synthesized by the parser, see below |
| `residualorder` | `{ side, slot, species, otherSide, otherSlot, otherSpecies, before:true\|false, turn, reason }` — synthesized by the parser, see below |
| `pp` | `{ side, slot, species, moves:[{ id, pp, maxpp }] }` — a **`\|stpp\|` snapshot** forwarded from the page's own battle object, see §6 |
| `crit` | `{ side, slot, species }` — `\|-crit\|`, a critical hit landed |
| `fail` | `{ side, slot, species, effect, args[] }` — `\|-fail\|`, a move had no effect |
| `win` / `tie` | `{ side }` / `{}` |
| `unknown` | `{ cmd, args[] }` — anything unhandled (never throw) |

Synthesized events the parser must produce:

* `|-fieldstart|move: Trick Room` → `fieldStart { effect:'move: Trick Room', args:[] }` (the
  state manager converts this to `field.trickRoom = true`, `trickRoomTurnsLeft = 5`).
* **Speed floor**: on a `move` event for `p2*` while (a) the opponent has no
  Tailwind/Choice-Scarf-proven boost, (b) Trick Room is inactive, (c) the move's priority
  bracket is 0, and (d) the player's matching `move` event for the same turn had bracket 0
  too and arrived **after** the opponent's — emit
  `speedfloor { side:'p2', value: <player active raw Speed>, reason:'moved first, priority 0, no TR' }`.
  The parser learns the player's raw speed from `state.speedHint`; `BattleStateManager`
  sets `parser.speedHint = { mySpeed }` before feeding each turn. This is a hint only —
  the engine never treats it as authoritative.
* **Residual order** (§6.2): end-of-turn residual damage/heal resolves in Speed order, so
  when one `damage`/`heal` line carrying a **non-`move:`** `[from]` clause for one side is
  immediately followed by another such line for the *other* side inside the same turn, emit
  `residualorder { side, slot, species, otherSide, otherSlot, otherSpecies, before:true,
  turn, reason:'residual resolved first' }` for the first body. Runs of three or more bodies
  emit a chain of such pairs against the first body only, and the parser never re-emits a pair
  it has already reported in the same turn.

`ST.BattleStateManager`:

```js
const state = new ST.BattleStateManager();     // constructor()
state.attachParser(parser)                     // subscribes to all events; returns state
state.applyEvent(event)                        // the single mutation entry point
state.reset()                                  // wipe everything, keep config
state.getMon(side, slot) / state.getActive(side) / state.getTeam(side)
state.registerMyTeam(parsedMons[])             // from TeamParser; fills myTeam with EV/IV truth
state.setFormat(formatName)                    // -> sets formatSupported (the NatDex OU allowlist)
state.isOpponentSpeedAtLeast(value)            // helper
state.snapshot()                               // deep-ish clone for the sampler/simulator
state.on('change', cb) / state.emit(...)       // tiny internal event bus (used by the HUD)
state.state                                    // the BattleState object above
```

Behavioural requirements for `state_manager.js` (all testable):
1. Hazards + a switch-in worth 0% ⇒ `confirmedItem = 'Heavy-Duty Boots'`, reason on
   `itemless`/`itemConsumed`/`itemRemoved` false, only when the incoming mon is not
   Flying/Levitate/Air Balloon, the hazard would have dealt damage, and the mon is an
   **opponent** (our own items come from the pasted team and are never inferred).
2. `|switch|`/`|drag|` resets `activeStintMoves`, `activeStintCount`, clears `boosts`.
3. First `move` of a stint sets `originalArchetypeItem` guess; two distinct moves in one
   stint clears it (`cannotBeChoice` is the pruner's decision, not the state manager's).
4. 8-PP recovery moves (`recover roost slackoff softboiled milkdrink shoreup synthesis
   moonlight morningsun healorder`) get a `recoveryPP` entry and decrement on every use
   (`|move|`), floor at 0.
5. `formatLocks.oppHasMegaEvolved` latches forever; same for `oppHasUsedZMove` on `|move|`
   with `isZ` or a `|-zpower|` line.
6. Protect rhythm: a `move` whose moveId is in `ST.util.PROTECT_MOVES` sets
   `protect.<side>ConsecutiveProtects++` and `TurnsSinceLastProtect = 0`; every new `turn`
   event increments `TurnsSinceLastProtect` for both sides; any non-protect move by that
   side resets `ConsecutiveProtects` to 0.
7. Trick Room: `fieldStart` sets true/5; each `turn` while active decrements
   `trickRoomTurnsLeft` (after the turn-a-1 header arrives, i.e. decrement when the *next*
   turn starts); `fieldEnd` clears it. Never below 0.
8. Format gate — an **allowlist**, not a reject-list. Only the supported format, under the names
   the ladder and the sim actually use, sets `formatSupported=true`: `[Gen 9] National Dex` (the
   literal `|init|`/`|tier|` text — there is no `... OU` on the wire), `[Gen 9] National Dex OU`,
   `gen9nationaldex`, `gen9nationaldexou`. Every other name is false, including the sibling tiers
   (`National Dex Ubers`, a NatDex OM — the reject-list this replaced let those through) and other
   generations. An empty/unknown header stays true, since the battle may not have started. False ⇒
   the UI shows an unsupported-format banner and `LaplaceEngine.evaluateTurn` returns `[]`.
9. Knock Off resolution: a `move` with `moveId === 'knockoff'` and a `targetSlot` marks that
   target as pending for the current turn. If the target took a `damage` event that turn and
   the turn ends (`_resolveKnockOffs` runs on every event, concluding once
   `knockOffTurn < state.turn`) with no `|-enditem|` for it, the item could not be removed:
   set `itemKnockedOff = true` and record the evidence. A KO or a Substitute hit teaches us
   nothing and is skipped. An `|-enditem|[from] move: Knock Off` instead sets
   `itemRemoved = true` and pushes the item onto `itemRuledOut`.
10. Slot identity: `p1a`/`p2a` belong to whoever is standing there. A preview `|poke|` never
    assigns a slot (preview order is not battle order), a `|switch|` releases the slot from
    the outgoing mon, and a faint leaves the fainted mon in `active.<side>` until a
    replacement switch line arrives (never `null`).
11. Mega form: `|-mega|` (and a switch-in whose details already name a Mega) adopts the
    post-Mega forme as the mon's `species`/`id`. A Mega has different base stats and often a
    different typing, and Showdown sends **no** separate `|detailschange|` line for it, so this
    is the only chance to follow the forme — otherwise every later stat, Speed and damage
    lookup silently keeps using the base Pokémon.
12. `alliesFainted`: after every event `_stampFallen()` restamps each living MonState with the
    number of fainted teammates (and each fainted one with that count minus itself). Supreme
    Overlord / Last Respects are the library's to model; the count is the state manager's to know.
13. `|win|<name>` carries the winner's **name**, not a side id: the parser resolves it through
    the `|player|` lines (`'ExtramePatriot' -> 'p2'`) so `state.result` is right for our own
    victories too, and leaves the raw name in place when it cannot resolve it.

## 3. Downstream module APIs (frozen)

```js
// set_pruner.js
new ST.ArchetypePruner()
pruner.prune(mon, state)                     // mutates mon.candidateSets/prunedReasons; returns surviving SetCandidate[]
   // When every set is eliminated it re-applies the hard facts (choice lock, Booster Energy,
   // itemless when the pool models one) and publishes that degraded pool with FALLBACK_REASON,
   // so the candidate space is never empty and never resurrects a disproved set.
pruner.applyChoiceLockRule(mon, state)       // -> { pruned: boolean, reason, distinct, dropped } (drops the Choice sets)
pruner.classifyItemless(mon, state)          // -> 'itemless-consumed'|'itemless-acrobatics'|'z-or-itemless'|'irremovable-mega'|'unknown'
   // consumed = itemConsumed|boosterConsumed|itemRemoved; survived-Knock-Off trigger =
   // itemless|itemKnockedOff|knockOffSurvived.
pruner.applyFormatLockCascade(state)         // removes Mega Stones from every opp bench pool
pruner.applySpeedFloor(mon, state)           // drops sets whose max Speed < mon.speedFloor and PUBLISHES
                                             // the survivors into mon.candidateSets/liveSet -> { pruned, dropped, floor, survivors:SetCandidate[] }
pruner.bestSet(mon)                          // -> SetCandidate | null (highest weight survivor)
pruner.handleSpeedFloorEvent(event, state)   // convenience wrapper used by state_manager
pruner._disprovedAbilities(mon, state)       // -> { ids: {abilityId: reason}, size } — the negative-space
                                             // ability rules (config.pruner.abilityDeduction.*); computed
                                             // once per body in prune() and tested per candidate set
pruner._abilitySuppressed(state)             // true while a revealed Neutralizing Gas is active (the
                                             // guard the gated absence rule runs); a status that landed
                                             // under it is stamped on the body as mon.statusSuppressed

// The damage engine is OPTIONAL (opts.damage). Without it the rule below is a no-op and every
// other deduction still runs; with it, mon.damageDealt is judged here.
new ST.ArchetypePruner({ damage: damageEngine })
pruner.damageVerdicts(mon, state, pristine)  // -> { <setId>: 'reason to drop' } for the observed hits
   // Memoised per observation signature (mon.damageVerdictCache). An observation is skipped when
   // it is flagged critical, sits below pruner.damageEvidence.minDamagePct, or names a move whose
   // damage is not a function of the set (fixed damage, weight/speed/HP ratio). If one observation
   // would eliminate EVERY tested candidate, the observation is discarded and a reason recorded
   // ('Damage evidence ignored: ...') instead of emptying the pool.

// sets_db.js — the optional ladder-usage overlay (src/sets_usage.js, ships empty)
ST.SetDatabase.reweightByUsage(sets, overlay)   // -> SetCandidate[] (NEW array; inputs untouched)
   // weight *= clamp(overlay.species[toID(species)].items[toID(set.item)] / 100, usage.floor, 1)
   // ONLY when that species AND item key exist; a missing measurement leaves the curated weight
   // exactly as it was. Applied once at load to every pool when ST_USAGE.speciesCount > 0, and
   // reported as ST.SetDatabase.report.usage.

// opponent_clock.js — opponent deliberation telemetry (read-only for the solver)
new ST.OpponentClock({ now?, enabled?, fastMs?, slowMs?, minSamples?, maxHistory? })
clock.note(rawLine, kind, ts?)   // kind: 'send' = our /choose, anything else = the battle stream.
                                 // Feed EVERY line, before the parser; never throws.
clock.label()                    // 'auto' | 'normal' | 'agonised' | 'unknown'
clock.switchFactor()             // cfg('clock.switchPrior.<label>') - the ONE number the engine reads
clock.snapshot()                 // plain copy for state.clock (turn, samples, floorMs, lastMs,
                                 // meanMs, label, switchFactor, myLastMs)
clock.describe()                 // one-line HUD string
clock.reset()                    // a new battle must not inherit the old noise floor

// laplace_core.js — HUD-facing readouts (they run the same calculator the solver does)
engine.preview(targetMon, state)     // -> { target:{species,id,hpPercent,isActive},
                                     //      lines:[ {moveId,name,isScreen?,minPercent,maxPercent,
                                     //               koChancePct,isOHKO,is2HKO,lethal,verdict,desc} ] }
                                     // one line per legal MOVE; null when there is nothing to say
engine.previewVsBench(species, state) // the same shape for an opponent BENCH body (null if not there)
engine.lethalBand(damageResult)      // 'guaranteed' | 'high' | 'mid' | 'none', from hud.lethal.*
engine.lethalVerdict(damageResult, moveData)
engine.overlordGauge(state)          // -> { species, fallen, ratio, percentBoost, effectiveAtk }
                                     // The multiplier is MEASURED by the library (probe move vs probe
                                     // defender, alliesFainted = fallen then 0) and the Attack figure is
                                     // the library's own stat scaled by it, so the ability's rule is never
                                     // written down here (RULE 1). null without the ability.

// content.js — the boot owns the answers, ui_overlay owns the DOM
boot._renderScreenExtras(state)      // pushes previews, bench targets, badges and the gauge to the HUD
boot._selectBenchTarget(id)          // tap handler: select, or tap again to return to the active pair
boot._deductionBadges(state)         // -> [ { id, label, detail, cls } ] cls: unmasked|choice-broken|lockout
boot._maybeAlertTR(state)            // once per battle, on TR's last turn: gold chip + the haptic pulse
boot._canVibrate()                   // whether this frame has been touched yet (Chromium's rule)
boot._vibrate(pattern)               // navigator.vibrate guarded; false when the platform refuses it
boot._buildReceipt(state) / _copyReceipt(text)

// calc_engine.js
new ST.DamageEngine({ gen: 9 })
engine.calculateDamage(attackerMon, defenderMon, moveName, fieldState, opts)
   // -> { minDmg, maxDmg, avgDmg, minPercent, maxPercent, avgPercent, isOHKO, is2HKO, koChancePct, desc }
   // attackerMon/defenderMon are either MonState (from state_manager) or loose
   // { species|name, evs, ivs, nature, item, ability, boosts, status, hp, level,
   //   alliesFainted, boosterActive } objects.
   // alliesFainted (RULE 1 plumbing) reaches the library so Supreme Overlord / Last Respects
   // count for real: Kingambit's Kowtow Cleave is 186 with five fallen allies, 126 with none.
   // boosterActive adds `boostedStat: 'auto'`, which lets the library pick the stat
   // Protosynthesis / Quark Drive lifts (Protosynthesis Great Tusk 104-123 -> 135-159; Quark
   // Drive Iron Valiant 410-486 -> 534-630). We never model that selection rule ourselves.
engine.getBestIncomingThreat(oppMon, myMon, fieldState)   // -> { move, minPercent, maxPercent, avgPercent, isOHKO } (null if no damaging move)
engine.getBestOutgoingMove(myMon, oppMon, fieldState)    // -> same shape, for the player side
engine.beginTurn(turnKey)                                  // clears the per-turn memo cache
engine.clearCache()                                        // alias of beginTurn(null)
engine.probeCombo(atk, def, moves[], fieldState)           // -> best result among moves
engine.fieldFromState(fieldState)                          // -> CALC.Field (cached per turn)

// trick_room.js
new ST.TrickRoomEngine(damageEngine)
tr.advise(state)                            // -> { shouldSet:boolean, reason, turnsLeft, invertedQueue, alert }
tr.getEffectiveSpeed(mon, isTRActive)       // -> number (raw L100 Speed, TR does NOT invert this)
tr.rankSpeed(mon, isTRActive)               // -> number; under TR returns 10000 - raw
tr.buildSpeedQueue(myMon, oppMon, isTRActive, state)  // -> [{ name, side, priority, effectiveSpeed, movesFirst, bracket }] sorted in resolution order
tr.moveBracket(moveName, mon)               // -> number (see spec: +2 ESpeed, +1 priority, 0, -6 Teleport/Chilly Reception, -7 Trick Room)
tr.getLifecycleAlert(turnsLeft)             // -> string | null
tr.tick(state)                              // called on every |turn| event

// evaluator_128d.js
new ST.DenseStateEvaluator()
ev.extractVector(state)                     // -> Float32Array(128), exact layout documented in-file
ev.evaluate(state)                          // -> number in [-1000, 1000]
ev.vectorToArray(vec)                       // -> number[] (tests/debug)

// tempo_vector.js
new ST.TempoEngine()
tempo.computeVector(state)                  // -> { v1..v10, dims:Float32Array(10), stallIndex }
tempo.applyPolicyMask(scoredActions, tempoVector, state)  // mutates copies of {name,score}; returns them
tempo.predictProtect(state, side)           // -> number 0..1

// veto_guard.js
new ST.BlunderVetoGuard()
veto.evaluateVetoes(action, state, tempoVector)  // action = { kind:'move'|'switch'|'protect', name, moveId?, targetId? }
   // -> { isVetoed: boolean, reason: string|null, code: 'VETO1'..'VETO12'|null }
   // Checks run in code order and the FIRST hit wins. VETO5-7 are the contact-suicide,
   // Sucker-Punch-setup and self-cancelling-Trick-Room guards (tests/upgrades_check.js);
   // VETO8-12 are the board-state guards (tests/run_tests.js):
   //   VETO8  WASTED_HAZARD_CLEAR   a U.HAZARD_CLEAR_MOVES move with zero layers on OUR side.
   //                                Court Change is exempt: it SWAPS the two sides, so it is live
   //                                even when our side is clean.
   //   VETO9  CONSECUTIVE_PROTECT  a protect move when our active used one on the previous turn
   //                                (the family cannot succeed twice in a row). Exempt when the
   //                                last use is stale (>= 2 turns ago) or we were taunted/encored,
   //                                because then the move never went off and the counter is clear.
   //   VETO10 MAGIC_BOUNCE_REDIRECT a hazard into a body whose Magic Bounce comes from a
   //                                revealed/confirmed ability, its believed set, or its possible
   //                                abilities — it lands on OUR side instead.
   //   VETO11 SATURATED_HAZARD      a hazard already at its cap on the OPPONENT's side (Spikes 3,
   //                                Toxic Spikes 2, Stealth Rock / Sticky Web 1; Ceaseless Edge and
   //                                Stone Axe map onto Spikes and Stealth Rock).
   //   VETO12 REDUNDANT_FIELD       re-setting the weather that is already up, while it has more
   //                                than veto.redundantFieldMinTurns (2) turns left — at 1 turn the
   //                                refresh is the correct line. Terrains are not judged.
   // Each of the five is switchable off through its own veto.* boolean, and none of them vetoes on
   // a signal it cannot read: an unreadable hazard record, an unknown weather duration or an
   // opponent with no ability grounds all fall through to the next check. The hazard caps and the
   // move → weather map are DATA in src/util.js (HAZARD_LAYERS, HAZARD_CLEAR_MOVES, WEATHER_BY_MOVE,
   // weatherFamily, hazardLayersOf), never literals in the guard.
veto.VETO_CODES                             // { VETO1:'PROTECT_RHYTHM', VETO2:'ABILITY_IMMUNITY', VETO3:'LONE_TR_SETTER', VETO4:'SPEED_SUICIDE',
                                            //   VETO5:'CONTACT_SUICIDE', VETO6:'SUCKER_PUNCH_SETUP', VETO7:'TR_SELF_CANCEL',
                                            //   VETO8:'WASTED_HAZARD_CLEAR', VETO9:'CONSECUTIVE_PROTECT', VETO10:'MAGIC_BOUNCE_REDIRECT',
                                            //   VETO11:'SATURATED_HAZARD', VETO12:'REDUNDANT_FIELD' }

// world_sampler.js
new ST.WorldSampler({ K: 6, rng })
sampler.sampleWorlds(oppState, candidateSetDatabase, K)   // oppState = MonState[] or BattleState
   // -> World[] where World = { id, seed, team:MonState[], sets:SetCandidate[], weight, violations:[] }
   //    violations: least-bad sets that had to be accepted; impossible: mons dropped because
   //    no candidate set could reach an observed Speed floor (a world never plans against one).
sampler.sampleWorld(state, db)     // single world
sampler.verifyWorld(world, state)  // -> string[] of violated observed facts ([] === legal)
sampler.seededRandom(seed)         // deterministic RNG (mulberry32) exposed for tests

// laplace_core.js
new ST.LaplaceEngine({ K:6, temperature:35, worldBlend:{avg:0.6, min:0.4}, sampler, damage, evaluator, tempo, veto, trickRoom,
                       nash:{ enabled:true, iterations:2000 } })
engine.evaluateTurn(battleState, opts)   // -> RankedAction[] sorted by confidence desc
   // RankedAction = { name, kind:'move'|'switch'|'protect', moveId, targetId, confidence (0..100),
   //                  score, isVetoed:boolean, vetoReason:string|null, isOptimal:boolean, damageHint,
   //                  nashFrequency? (mixed-strategy path only) }
   //
   // SCORING CONTRACT. With laplace.nash.enabled (the default) the world-weighted simultaneous
   // payoff matrix is solved with fictitious play, `confidence` is the equilibrium FREQUENCY of
   // the line and `score` its expected payoff against the opponent's equilibrium mix; vetoed
   // lines are excluded from the solve and get confidence 0. With nash.enabled = false the old
   // pure risk blend (0.6*avg + 0.4*min over worlds) plus a softmax at `laplace.temperature`
   // runs instead — that is the only path the temperature governs.
engine._softmaxConfidence(ranked, live, temperature)  // legacy softmax path, numerically stable
LaplaceEngine.solveNashFictitiousPlay(matrix, iterations)  // -> { myStrategy, oppStrategy, rowValues }
engine.lastReadout                          // { worlds, tempo, ranked, elapsedMs } for the HUD/LLM
engine.simulate(action, world, battleState)  // -> SimResult { state, myPercentDelta, oppPercentDelta, events[] }

// llm_client.js
new ST.LLMTactician()
llm.getTacticalReadout(battleState, laplaceResults, tempoVector)  // -> Promise<{action,confidence,reason}|null>, hard 20s abort
//   (the budget is config llm.timeoutMs, sent with the request and honoured by background.js —
//    one source of truth, asserted at the source level in tests/config_check.js)
llm.getConfig()  / llm.saveConfig(cfg)      // chrome.storage.local, no-ops safely without chrome

// ui_overlay.js
new ST.MobileHUD({ doc, state })
hud.render(ranked, battleState, readout)    // badges on button[data-move], banner, TR chip
hud.clear()                                 // remove every injected node/class
hud.bindDrawer()                            // wires the 48x48 bottom-left toggle
hud.setTeamStatus(teamSummary)              // '6/6 confirmed · 0 Spe IVs: Slowking-Galar'
hud.updateLLMReason(moveName, reason)       // late tooltip update when the LLM answers after the render
hud.confidenceClass(conf, isVetoed)         // pure helper: 'conf-high'|'conf-mid'|'conf-low'|'conf-veto'
```

## 4. Cross-world bridge (MAIN ⇄ ISOLATED)

`src/injected.js` runs in the **MAIN** world (documented in README: injected with
`<script src=chrome.runtime.getURL('src/injected.js')>`… actually via a
`document.documentElement.dataset`-free approach: `content.js` appends a
`<script>` tag whose `src` is the web-accessible `src/injected.js`, in
`run_at: document_start`). It intercepts:

* `window.WebSocket.prototype.send` (outgoing `/choose …`) — re-emits as
  `{ kind:'send', raw }`.
* inbound `message` events on every live WebSocket (wrap the socket's `onmessage`
  setter and `addEventListener`).
* a 250 ms polling fallback over `window.app.curRoom && window.app.curRoom.battle`
  (`battle.log` cursor) for missed lines. The cursor also advances over the runs the SOCKET path
  already delivered, because the page mirrors those same lines into the log: a multi-line frame
  would otherwise be handed over twice, and the relative lines make that a real error (`|-boost|`
  twice is +2, |turn| twice double-ticks the Trick Room and weather clocks). Only a run sitting
  exactly at the cursor is claimed.

It forwards each line by dispatching two DOM events (belt and braces — the detail of a
`CustomEvent` created in the MAIN world is readable from an ISOLATED-world listener in
Chromium, and the JSON string guarantees it):

```js
document.dispatchEvent(new CustomEvent('ShowdownTactician_ProtocolEvent', {
  detail: { rawLine, kind, json: JSON.stringify({ rawLine, kind }) }
}));
```

`content.js` normalizes `detail`: if `detail` is a string, `JSON.parse` it; if
`detail.rawLine` is missing but `detail.json` exists, parse that; if `detail` is null
(Firefox-style realm blocking), read the mirror attribute
`document.documentElement.dataset.stLine` (injected.js also sets it as a fallback).

## 5. Deliberate deviations from the original brief (keep these)

1. **`protocol_parser.js` lives in the ISOLATED world**, together with
   `state_manager.js`, not the MAIN world. The brief lists it under Module 4 (MAIN), but it
   is the only consumer of `|request|` JSON and the producer of engine state; keeping it
   isolated means the page never sees the engine, and one `CustomEvent` hop is cheaper than
   serialising whole battle states across realms. `injected.js` is the only MAIN-world file.
2. **`lib/calc-data.min.js` is a second vendored file.** `@smogon/calc` ships its dex
   separately from the mechanics bundle; `lib/calc.min.js` alone exposes an empty dex.
3. **`src/util.js`, `src/sets_db.js`, `src/config.js` and `src/background.js` exist** (not in
   the brief's file tree): `util.js` is the only module that reads the calc dex and asks it for
   a stat number (`calc_engine.js` is the only one that calls `calc.calculate`; no third file
   touches the bundle at all);
   `sets_db.js` is the shared Smogon candidate-set table that both the pruner and the sampler
   read; `config.js` is the one home for every heuristic (the brief asked for tunable weights,
   and scattering them across nine modules is how a decision engine rots);
   `background.js` is the only place that performs the LLM fetch, because MV3 content
   scripts are subject to page CORS and cannot use the extension's host permissions.
4. **Terastallization** is tracked but never simulated: `terastallizationBanned` is true and
   `|terastallize|` lines raise a console warning only. Because the flag is set on EVERY board,
   the two dims that exist to price Tera (`_teraThreat`, dims 120/121) would read a hard 0 in
   every row of the training corpus — a fitted weight for a fact this format cannot produce.
   While the ban is set they therefore carry the **cleaner advantage** instead
   (`_cleanerAdvantage`): the share of the opponent's LIVING bodies that our fastest living body
   both outspeeds and removes in two hits, read from the damage engine and memoised on the full
   matchup. A board whose state does not carry the flag keeps `_teraThreat` byte for byte, and
   both dims' shipped coefficients are 0, so the SCORE is unchanged until the vector is
   re-fitted on data that now moves them.
5. **The tests live beside the code they guard**, including two files at the repository root:
   `test_engine.js` (RULE 2, the frozen ground-truth damage rolls) and `test_log.txt` (RULE 3,
   a real 30-turn battle as a raw protocol stream). `tests/blackbox_guard.js` (RULE 1) and
   `tests/config_check.js` (RULE 4) are the two suites that exist purely to stop the rules
   above from eroding, and `tests/parser_fuzz.js` replays the log plus every prefix of it and
   a battery of malformed lines. `tests/hardening_audit.js` is the bug-hunt regression suite:
   ten defects (see `BUGS_AUDIT_REPORT.md`) each pinned by an assertion that fails on the code
   as it was, plus a seeded 40-battle fuzz over the real pipeline asserting the solver's
   invariants (finite scores, confidences summing to 100, determinism, legal actions).
   Nothing here is verified in a real browser.
6. **The monthly chaos sync writes a usage overlay, not a new `sets_db.js`.** A chaos dump
   publishes marginals (item / ability / move / spread frequencies) and never whole sets, so
   reconstructing sets from it would fabricate combinations no player ran — exactly what RULE 1
   forbids. `tools/sync_chaos_sets.js` therefore emits `src/sets_usage.js`, and
   `ST.SetDatabase.reweightByUsage(sets, overlay)` multiplies the curated `weight` of a set by
   how often that species was actually seen holding that item (clamped into
   `[usage.floor, 1]`). A species or item the dump never mentions keeps its weight untouched:
   a missing measurement is not a zero measurement. The file ships empty.
7. **The opponent clock may remove the opponent's switch replies, and nothing else.**
   `clock.switchPrior` is consulted in `laplace_core.getOppActions`, where a factor below
   `clock.switchKeepThreshold` drops the pivot columns from the simultaneous matrix. The
   agonised direction cannot add replies the engine already enumerates, so it stays telemetry.
   The thresholds are priors, not measurements (see README "Known limits").

## 6. The six "sweaty" upgrades (frozen interfaces)

Added on top of §3, and all six obey RULE 1 (no math of our own) and RULE 4 (no heuristic
literals outside `src/config.js`). Every number below is either measured through the library or
read off the protocol; nothing is assumed. Each feature is guarded by its own config switch and
each one degrades to *no output at all* rather than to a guess.

### 6.1 Exact damage: the 16 discrete rolls (`F3`, `src/calc_engine.js`, `src/set_pruner.js`)

Pokémon damage is not a continuous interval — it is one of 16 integer rolls. `DamageResult` gains:

```
rolls         : number[]|null   the library's own sorted roll list, or null when it gives none
rollCount     : number          rolls.length, or 0
koChanceExact : number|null     (# rolls >= defender HP) / rollCount * 100, or null without rolls
rollPercent(v): number|null     v / defenderMaxHP * 100, rounded to 1 dp — the printed percentage
                                of one integer roll (the inverse of an observation)
```

`minDmg`/`maxDmg`/`minPercent`/`maxPercent`/`avgDmg` are unchanged (`range()`), and
`koChancePct` becomes the **discrete** count when `rolls` is present (the old uniform-span
approximation is kept as the fallback when it is not). `_resultFrom` must never *invent* a roll
list: if the library returns a scalar `damage`, `rolls` stays `null`.

`ArchetypePruner`, inside the existing `_damageVerdict`, adds the discrete refinement after the
range check: with the observation's implied integer window
`[ (pct - slackPct) * defenderMaxHP / 100 , (pct + slackPct) * defenderMaxHP / 100 ]`, a set
survives iff at least one of its `rolls` falls inside that window (the mover's roll list, i.e.
`calculateDamage(set, defender, moveName, ...)`). `pruner.discreteRolls.enabled` gates it and it
must never empty a pool: when every candidate would be dropped, the pool is kept and a reason is
logged, exactly like the range check's own guard. Once ≥ `requireObservations` observations agree,
`prune()` publishes `mon.pinnedEvs` (the shared `evs` vector of the survivors) and sets
`mon.evPinned = true`; a pool with two different EV vectors is never pinned.

### 6.2 Residual-order speed evidence (`F2`)

`ProtocolParser` emits `residualorder` (§2). `ST.BattleStateManager` stores the pair on the
*faster* body as `mon.residualOrderBefore = [{ id, species, turn }]` (bounded by
`pruner.maxEvidence`) and, on the slower body, `mon.residualOrderAfter`, and it is the single
writer of both fields. It does **not** convert anything to a speed number itself: it routes the
event to `pruner.handleResidualOrderEvent(event, state)` where it already routes the synthesized
`speedfloor` event, and that handler calls:

```
pruner.applyResidualOrder(mon, state)
  // -> { pruned:bool, dropped:int, floor:int, ceiling:int, survivors:[] }
```

The conversion is relative, and uses the *other* body's believed speed (`liveSet` speed, or the
pruner's own `believedSpeedOf`): the faster body gets `speedFloor = max(speedFloor, t - 1)` and
the slower `speedCeiling = min(speedCeiling, t + 1)`, where `t` is the other body's believed
speed and `pruner.residualOrder.trust` scales how far the bound is allowed to bite. Like every
other deduction it fails soft: if no candidate survives, the pristine pool is republished and a
reason is logged. With `trust: 0` the order is recorded as telemetry and nothing is pruned.

### 6.3 Replay scouting prior (`F1`, `tools/scout_replays.js` → `src/scout_prior.js`)

The tool is offline, house-style (`require`-able pure functions + `parseArgs` + `main`, no
runtime fetch):

```
node tools/scout_replays.js --input replays.json [--out src/scout_prior.js] [--min-share 5]
node tools/scout_replays.js --url https://replay.pokemonshowdown.com/<id>.json [--out ...]
module.exports = { replaysOf, observationsOf, buildPrior, renderFile, parseArgs, main }
```

`src/scout_prior.js` is a GENERATED overlay like `src/sets_usage.js`, ships EMPTY, and defines:

```
window.ST_SCOUT = {
  generatedAt, source, replays: n, minShare,
  species: { kingambit: { name:'Kingambit', seen: 3,
                          items:{ blackglasses: 66.7 }, abilities:{ supremeoverlord: 100 },
                          moves:{ suckerpunch: 100, ... } } }   // shares in percent
}
```

Only what a replay can reveal is recorded: item (`|-item|`/`|-enditem|`/`|-activate| item:`),
ability (`|-ability|`), moves (`|move|`), and the revealed species. **EVs, natures and IVs are
never recorded** — a replay does not contain them, and inventing them is exactly what RULE 1
forbids. `ArchetypePruner` reads the overlay in `_seedPool` and re-weights each pristine set,
using ONLY dimensions the overlay actually observed for that species:

```
shares  = [ item share (only if any item was observed for the species),
            ability share (same),
            mean share of the set's own four moves (only if any move was observed) ]
score   = mean(shares) / 100                       // 0..1, or null when nothing was observed
factor  = score === null ? 1
        : clamp(1 + maxBend * (2 * score - 1), 1 - maxBend, 1 + maxBend)
multiply the set's weigth by factor -- on a COPY, never on the database object
```

So a fully-observed set gains at most `maxBend` and a set the scout never saw loses at most
`maxBend`; a species (or a dimension) the overlay never saw leaves the curated weight
**untouched** (a missing measurement is not a zero measurement). The overlay only ever re-weights
sets the curated database already holds and can never add one.

### 6.4 PP-stall counter and the 3x3 pivot (`F4`)

Max PP is game data, so it is READ, never assumed: `src/injected.js` (MAIN world) additionally
snapshots the page's own battle object — `battle[p1|p2].pokemon[].moveSlots[]` — and forwards one
synthetic line per body per move slot:

```
|stpp|p2a: Kingambit|suckerpunch|5|8
```

`ProtocolParser` maps `stpp` → the `pp` event (§2); `BattleStateManager` stores it as
`mon.ppSnapshot = { [moveId]: { pp, maxpp, turn } }` (kept separate from the derived 8-PP
`mon.movePP` counter) and counts observed uses in `mon.ppUsed[moveId]` from `|move|` lines.
`LaplaceEngine.ppStall(state)` returns

```
{ species, move: { id, label, pp, maxpp, remaining, observesOnly:bool },
  threat: { setupMoves:[names], theirHp, read:string },
  matrix: { rows:[{label,kind,action}], cols:[{label,kind,action}],
            payoff:number[][], solution:{myStrategy,oppStrategy,rowValues} }|null,
  advice: { moveId, frequency, reason }|null }        // or null when nothing to say
```

The counter is about OUR body — the play it exists to fix is clicking OUR Sucker Punch into a
stall, so the PP is read off `state.active.my`, in order of authority: `state.legalActions.moves`
(the server's own numbers from the `|request|`), then `my.ppSnapshot`, then the observed use
count. The threat is theirs. `observesOnly: true` is the honest fallback when neither the request
nor a `|stpp|` snapshot gave a number: the gauge then prints "used N times" and never a
denominator. The 3x3 is built from the
existing `_payoff` on labelled groups (our watched move / our best other attack / our setup or
Protect) × (their attack / their setup-or-Protect / their Substitute), solved with the existing
`LaplaceEngine.solveNashFictitiousPlay`. `MobileHUD.renderPPGauge(gauge)` /
`clearPPGauge()` render it as `.st-pp-gauge[data-st-pp]`.

### 6.5 Risk-adjusted volatility (`F5`, `src/laplace_core.js`)

A per-row delta on OUR rows, applied in the same pass as the tempo policy mask and before the
Nash solve (so the mixed equilibrium sees the risk-adjusted payoffs). Formula and knobs are in
`config.laplace.volatility`; `enabled:false` restores the raw payoff bit-for-bit. Sources:
the accuracy from `state.moveAccuracy[id]`, which the `|stacc|` snapshot fills from the CLIENT's
own dex — the vendored damage bundle ships no accuracy data at all, so this is measured at runtime
rather than hardcoded — and `incomingThreatPercent` from
`damage.getBestIncomingThreat(oppActive, myActive, field)`. An action whose accuracy is unknown is
charged nothing. Ranked rows gain `volatilityPenalty` (the number that was subtracted) and
`volatilityWhy`.

### 6.6 Format sentinel (`F6`, `src/laplace_core.js`, `src/ui_overlay.js`)

`LaplaceEngine.formatSentinel(state)` returns

```
{ mega: { burned:bool, species, turn, label }, z: { burned:bool, species, turn, label },
  tactics: [ { kind, label, detail } ],   // "TACTICAL FREEDOM": what their bench can no longer hold
                                          // kind: 'mega' | 'z' | 'freedom' | 'live'
  bench: { unrevealed:int, stonesPossible:int } }
```

`label` is the mechanic's STATE (`sentinel.burnedLabel` / `sentinel.liveLabel`), which is what the
row prints after the mechanic's name; `MobileHUD.renderFormatSentinel` supplies the name itself and
must never render `label` in the name slot.

`tactics[].kind` names WHICH tactic a row is; the glyph is the renderer's business, drawn from
`SENTINEL_TACTIC_ICONS` in `src/ui_overlay.js`, and an engine-supplied `icon` overrides it. The
engine must never emit a bullet or any other character it had to invent — the ASCII placeholders
tried first (`X`, `.`, `o`) shipped as visible text inside the bar.

read entirely off `state.formatLocks` + the reported bench size (never off a hardcoded rule).
`content.js` renders it from `_renderScreenExtras`; `MobileHUD.renderFormatSentinel(sentinel)` /
`clearFormatSentinel()` draw `.st-format-sentinel[data-st-sentinel]`, and `clear()` tears it down
with everything else.

### 6.7 Quiescence: the setup punisher (`src/laplace_core.js`, `src/util.js`)

An addition beyond the six the original brief listed, so it is numbered on its own rather than
renumbering §6.4 to §6.6. The simultaneous matrix prices one turn, and two opponent replies are not
damage. The 1-ply model read both as no-ops: their SETUP move (no damage, no state change, so the
cell credited us a free hit while ignoring the stat stages the move grants) and their PROTECT (which
on the real board blocks our move, so a line that KO'd them kept its lethal bonus through the
shield).

`config.laplace.quiescence = { enabled: true, extendSetup: true, blockProtect: false,
followUpWeight: 1, respectTurn2Speed: true }`. Every switch is `false`-able, and each one on its own
restores the raw 1-ply payoff bit-for-bit (the same `enabled:false` contract `nash`, `volatility` and
the veto switches keep). `followUpWeight: 1` is an exact identity on the second exchange, and
`blockProtect` **ships OFF**: the block is a game rule, but pricing it inside a one-turn cell measured
the wrong way round at 60 paired battles (its own row takes the Protect-heavy persona from 4-0-11 to
13-0-2 when the block is off, `ATTEMPTS.md` §K6), so the shipped leaf is the legacy reading and the
ablation row is what turns the block back on. `respectTurn2Speed` orders the extension's second
exchange by the Speed each body will have there.

`_payoff` classifies the reply from its own move data: `isProtect` (or an action `kind` of
`'protect'`) skips our move entirely, and `isSetup` asks `U.setupBoosts(name)` for the stages the
move grants its USER. That table lives beside `SETUP_MOVES` in `src/util.js` because the vendored
dex cannot answer the question: `calc.MOVES[9]` carries what a damage calculator needs, and to a
damage calculator a stat boost is an input, not an effect. The amounts are game rules with a single
correct value (Dragon Dance is +1 Atk / +1 Spe), which is why a literal is allowed THERE and not
anywhere a damage number would go: the stages reach the calculator as `options.attacker.boosts`, so
the stat table, the Choice lock, the weather and the ability all run through `ST.DamageEngine`.

`_setupFollowUp(myAction, myActive, oppActive, mySideMon, gain, hpCostPct, hp, field)` prices the ONE
extra exchange and returns `{ myHp, oppHp, move, avgPercent }`:

```
gain   = U.setupBoosts(theirMove)              // +1 Atk / +1 Spe for Dragon Dance, etc.
oppHp -= hpCostPct                             // Belly Drum 50, Clangorous Soul 33
myHp  -= their best attack WITH `gain`         // the calculator's own number, not a model
oppHp -= our row's move AGAIN, `gain` as the DEFENDER's stages
```

Our row's move is the move being priced, so it is the one repeated; theirs is their best attack from
the boosted state. A switch row has no second hit of ours (the body is still coming in), though it
still pays their follow-up.

`_leafState(state, my, opp, myHp, oppHp, extraBoosts)` takes the stages in `{ my, opp }` form and
merges them ADDITIVELY into an own `boosts` property on the `Object.create` clone. That own property
is load-bearing: the clones share nested objects by reference by design (pinned in
`tests/invariants_check.js`), so a stage written onto the shared table would land on the live board.

Guards, each pinned by `tests/quiescence_check.js`:

* `oppHp > 0`: a body that ends the turn fainted has no next turn, so neither the follow-up nor the
  stages reach the leaf. This is the "KO the setup user" line the feature exists to reward, and
  stamping stages on a dead body would let the evaluator's boost dims move a cell whose own board
  says the body is gone.
* `oppHp > hpCostPct`: a setup the opponent cannot pay for fails in game, so it prices as the wasted
  turn it is (Belly Drum at 50% or below, Clangorous Soul at a third or below).
* Recovery replies are NOT priced: heal amounts vary by move and by weather, so `isRecovery` stays a
  no-op rather than an invented number.

Stated approximations (they are repeated at the call site): the second exchange IS ordered by the
Speed each body will have there whenever `respectTurn2Speed` is on (the shipped default) — a tie, or a
Speed the board cannot read, falls back to "both actions land"; their Protect is not re-checked on the
second turn; their damaging replies keep the pre-existing symmetric treatment.

### 6.8 Ability deduction, the gated tuning tiers, and Turn-0

**Negative-space ability deduction** (`src/set_pruner.js`, tables in `src/util.js`).
`_disprovedAbilities(mon, state)` returns the candidate ABILITY ids an observation has ruled out, and
`prune()` drops any set carrying one. Three families, each individually switchable under
`pruner.abilityDeduction.*`: `statusRules` (a status the body is CARRYING disproves every ability that
makes it impossible — `U.STATUS_IMMUNITY_ABILITIES`, skipped entirely when the body's status was
stamped `statusSuppressed`), `groundRules` (damage only a grounded body can take disproves Levitate /
Earth Eater — a DIRECTLY connecting Ground move, or Spikes / Sticky Web, never Stealth Rock; the
whole family is skipped under Gravity, which grounds everyone), and `absenceRules` (a switch-in
trigger ability that never announced itself), which **ships OFF** because Neutralizing Gas and
friends silence the announcement — the one absence-of-evidence inference in the engine, and the
reason `_abilitySuppressed` exists. The state manager records the raw facts the rules read
(`switchedInTurn`, `groundAimedOnTurn` → `groundDisproved`, `statusTurn`, `statusSuppressed`), and
it refuses the observation rather than the conclusion where the refusal is cheap: the aim is not
stamped when the attacker's KNOWN ability ignores abilities (`U.ABILITY_IGNORING_ABILITIES`), and
`groundDisproved` is set only for damage carrying no `[from]` clause, so a burn tick or a hazard in
the same turn cannot be mistaken for the Ground move landing. A MISSED Ground move leaves a turn
stamp the next turn cannot match, so it can never disprove anything either.

**The gated tuning tiers.** `laplace.comeback` scales the existing volatility charge by the
evaluator's board score (`_comebackScale`, `_boardScore`): sharpened when ahead, softened when
behind. It deliberately does NOT touch `laplace.temperature`, which governs only the legacy softmax
path while `nash.enabled` is the default. `laplace.urgency` (`_urgencyDelta`, `_commitmentOf`) adds a
bounded, ramping preference for COMMITTING rows (a real attack or a setup move) over PASSIVE ones
past `startTurn`, multiplied at `breakoutTurn`; it re-ranks rows and can never override a veto or a
game rule. `clock.ratingBands` (`OpponentClock.ratingFactor`) bands the clock's single switch-reply
factor by the OPPONENT's ladder rating, which the parser reads off
`|player|p2|Name|avatar|1480` and the state carries as `state.opponentRating`. Each is folded into a
number the solver already consumes, so an off tier is the exact identity.

All three shipped `enabled: false` while unmeasured. **`laplace.urgency` is now ADOPTED (`true`)** —
the one tier to clear the config-flag ablation gate (60 battles/arm, all three personas, one seed,
paired bootstrap: win rate 68.3% → 96.7%, Δ +28.3 points, 95% CI [+18.3, +40.0], and the 100-turn
cap ties collapsed 17/60 → 1/60). `laplace.comeback` and `clock.ratingBands` remain off. Their rows
used to be flat for a HARNESS reason — comeback scales a volatility charge the arena could not price
(@pkmn/sim emits no `|stacc|`) and the band needs a ladder rating the arena never supplied
(`|player|p2|Name|avatar|` with an empty last field) — and that blindness is now CLOSED: the bridge
emits all three client frames, the band is exercised across the three declared persona bands, and
only the volatility charge itself (too small to flip a line against these movepools) is still not
decisive. See ATTEMPTS.md §D for the measurement on each row. The `--set` mechanism
behind those rows is itself pinned — a pruner-family flag is captured at LOAD time, so the arena
applies its patch from inside `loadHarness`, the moment `src/config.js` has run.

`laplace.switchTax` (`_switchTaxDelta`) is the newest of them and the only one REJECTED after being
measured. It is a flat score drag on every SWITCH row, folded into the same two places `urgency` and
`volatility` use — the mix matrix and the row score — and exactly `0` for every row while `enabled` is
false, so the shipped build is byte-identical. It was written to act on a human-match measurement (the
engine's top line is a switch on 55.4% of contested turns against 1,830-rated humans' 33.8%, and on
the turns the human clicked a move it still preferred a pivot 39.0% of the time with a full 4-attack
menu, so it is neither a starved-menu artefact nor explained by `quiescence.extendSetup` or VETO4 —
both measured first and both refuted, at paired nets of -21 and -22). It moved the number it was built
to move — switch rate 55.4% → 29.2%, top-1 agreement 31.7% → 44.0% — and the gate then priced it at
**-26.7 win points** (95% CI [-38.3, -15.0]) while re-creating the very standoff `urgency` had just
removed (1/60 → 18/60 cap ties). Worse, the agreement was a composition effect: the MOVE half rose
35.0% → 53.8% while the SWITCH half FELL 22.5% → 16.5%. It ships OFF with its row kept in the feature
table, which is the concrete reason this repo keeps policy agreement and playing strength as two
separate measurements: the same change bought 12.3 points of agreement and cost 26.7 points of win
rate. The ceiling any pivot fix could reach is measured too, not guessed: on the 2,053 turns it
preferred a pivot while the human attacked, its own best non-pivot line was that click 55.8% of the
time, and never pivoting while holding an attack would score top-1 45.2% overall against the shipped
31.7%. The ranking is not what is broken — the preference is.

**The endgame solver's 2026-10-15 hardening pass** (`src/endgame_solver.js`, the `laplace.endgame`
tier, five leaves). The tier itself still ships `enabled: false`, and its first 60-battle reading
(`ATTEMPTS.md` §M1) says a win rate cannot price it at all: the tier publishes a readout and NOTHING in
the ranking path reads it, so the row is `identical` by construction. The pass fixed five things that
would otherwise have made the readout a claim about the wrong tree. (1) `simultaneousPly` — a turn is a SIMULTANEOUS game. The old shape was `max_i min_j`, a valid
floor but the price of a Stackelberg game where the opponent reads our hidden action and answers it;
the turn is now solved as a small zero-sum matrix by regret matching unless one side holds a strictly
dominant pure action, and the game value can never sit below the maximin floor. (2)
`includeRecoveryAndProtect` — `Recover`/`Roost`/`Slack Off`/`Soft-Boiled` used to read as "does
nothing" (the single most dangerous way to be wrong about an endgame) and `Protect` as a free turn.
Both are actions now: a heal restores 50 % only while its body still stands when the action resolves,
and a shield blocks the incoming hit for the turn and is only OFFERED while that side's protect chain
is broken, because the second one in a row fails in the real game. (3) `modelPhysics` — a replacement
PAYS its side's entry hazards through `U.hazardPercent`, Trick Room's timer decrements and expires
mid-tree, and end-of-turn burn/poison chip and Leftovers recovery land on both actives. (4)
`transposition` — a per-`solve()` memo keyed on the board with HP bucketed into `ceil(hp / 5)` (0
preserved exactly) plus the active slots, boosts, protect streaks, the Trick Room timer and the
(depth, ply) pair. Only values computed with a FULL window are stored: a fail-high is a bound, not a
value, and caching one under an exact key corrupts a sibling branch. (5) `solveAcrossWorlds(state,
worlds)` — the multi-world entry point `LaplaceEngine` now calls: a forced win is reported only when
EVERY non-refusing world proves one with the SAME root action, and otherwise the report carries the
root offering the best worst-case score across worlds. Each leaf is independently switchable and each
is pinned in `tests/endgame_check.js` §7.

**Two opponent-model tiers** joined it in the same pass. `priorAnchored` is ON since the 2026-10-15
adoption (`ATTEMPTS.md` §N4); `surpriseMask` still ships `false`.
`laplace.surpriseMask` builds an OPPONENT-PERCEIVED copy of the payoff matrix in which a row for an
UNREVEALED, NON-STAB move of ours is blended toward our best revealed-or-STAB row at
`unrevealedWeight`, and solves only THEIR half against it: our rows are still scored on the true
matrix against the mix that produces, and our own frequencies still best-respond to the real game, so
the tier can change what we expect them to do and nothing else. A STAB move is excluded on purpose —
its typing is readable off the species, so pricing it is not telepathy, and neither is a move already
in `revealedMoves`. `laplace.nash.priorAnchored` replaces the opponent's hard response with regret
matching anchored to a behavioral prior, `(1 - c) * regretMatch + c * P_prior` with `c =
priorWeight`; the regret is measured against the value of the mixture they are CURRENTLY playing
(against `max_j Q_j` no action can have positive regret, which makes that version of the formula the
argmax and leaves the prior doing all the work), and `P_prior` is normalized from measurements only:
each damaging move's average percentage into our active, a setup weight gated on whether our active
can 2HKO them, and a switch baseline that jumps to `switchEscape` when their active faces a
guaranteed OHKO from a REVEALED/STAB move of ours and the incoming body resists it. `priorWeight: 0`
and an absent or ragged prior both resolve to the historical hard loop step for step. Pinned by
`tests/tuning_check.js` §8 and §9.
**The one-way loop those tiers were stuck behind was fixed on 2026-10-15** (`ATTEMPTS.md` §N1): our
step used to accumulate the opponent's hard argmax INDEX while their published strategy accumulated
the mixture, so a temperature, a prior or a mask could re-price `rowValues` and could not reach our
own frequency counts on any matrix. It now accumulates the mixture's expectation, so an opponent
model can move a ranking, and the no-mixture path is character-for-character the old line (§7b pins
both halves). The first sweep after the fix re-measured both tiers: `priorAnchored` WON on two seeds
(Δwin +21.7 [+5.0, +36.7] and +25.0 [+8.3, +41.7]) and is ADOPTED, while `surprise-mask` is −3.3
[−15.0, +8.3] with zero cap ties — the §M2 `stall` cluster does not reproduce now that the mask can
actually reach our ranking, which is itself evidence the loop fix landed. `tests/tuning_check.js` §5d
and §7 pin the other tiers' fixtures with `priorAnchored` explicitly off, so each section keeps
measuring its own tier rather than inheriting the new default.

**The training corpus now drives the pruner.** `tools/extract_training_data.js` builds the
`ST.ArchetypePruner` the way `src/content.js` does and calls it on the same events (a `move` under
content.js's own two-move guard, `switch` / `item` / `enditem` / `activate`, the format-lock cascade
and `speedfloor`), because `cannotBeChoice`, `itemless` and `liveSet` are written by that one module
and read by dims 64..75. Without it those dims were constant 0 in every corpus row — a property of
the extractor, not of the format. `drivePruner` reproduces the call sites rather than pruning
everything every turn, so the extracted board is the board the engine sees. `tests/weights_check.js`
§5b proves the wiring by A/B (the same corpus, the pruner absent from the sandbox) and pins dims
120/121 on constructed boards.

**The Turn-0 lead advisory** (`leadAdvisory` / `_matchupScore`). `|teampreview|` is inert to the
parser by design (pinned by `tests/parser_fuzz.js`), so `src/content.js` hangs the read off the raw
command. Each of our bodies is scored against every opposing body through the SAME leaf evaluator
the in-battle decisions use (a two-body board), `favorability` maps that score onto 0..100, and the
HUD renders the best and riskiest lead (`renderLeadAdvisory`). A measurement rather than a heuristic,
so it ships ON under `hud.leadAdvisory.enabled`.

Pinned by `tests/ability_check.js`, `tests/tuning_check.js` and `tests/preview_check.js`.

## 7. The headless arena (`tools/headless_arena/`, `tools/run_arena.js`)

A second execution path for the same engine, and the only one that runs a real battle engine. It
exists because §1–§6 are verified against protocol lines this repository typed by hand: nothing in
`tests/` can surprise the deduction. The arena is not a second implementation of anything — it is a
driver, and the engine underneath it is the shipped one.

**The boundary is one module.** `tools/headless_arena/engine_bridge.js` is the ONLY route from arena
code into engine code. It loads the extension's own scripts through `tests/harness.js` — the same
loader `tests/run_tests.js` uses, so the arena exercises the program that ships, not a copy — feeds
the session protocol lines, and reads back a ranking. `EngineSession.topChoice()` is the engine's
answer and `choiceForRanked(entry)` turns a ranked line into a bare `@pkmn/sim` choice string. No
arena module computes damage, stats or type effectiveness, and none of them owns a name table: the
sim resolves the battle, its `TeamValidator` rules on legality, and its `|request|` payloads are the
only source of what is legal this turn. RULE 1 holds inside `tools/` exactly as it does inside
`src/`.

**Self-play, and why the mirror is FROZEN.** At a 98.3 % baseline with zero losses the arena can show
harm and almost nothing else (ATTEMPTS.md §H), so `--agent mirror` seats the engine against
`EngineMirrorAgent`: a second `EngineSession` on the SAME team, answering p2 out of the engine's own
ranking. The mirror reads the **shipped** config even when the run carries a `--set` patch, which is
the only thing that makes a paired ablation meaningful — if both seats shared the patch the variant
would play itself and every effect would cancel. `loadHarness({ baseline: true })` is that frozen
sandbox, in its own cache slot so it can never be overwritten by (or overwrite) the patched one, and
asking for a baseline AND a patch is a refusal rather than a request.

Frozen surfaces — what the suites pin, and what the CLI calls:

| module | surface |
| --- | --- |
| `sim_runner.js` | `new HeadlessBattleRunner(format)`, `initBattle(p1Pack, p2Pack, seed)`, `await runGame(p1Agent, p2Agent, maxTurns)`, `report()`, `close()`, `playBattle({...})` |
| `replay_splicer.js` | `new ReplaySplicer(opts)`, `findCrucibleTurn(lines)`, `spliceAndResume(lines, turn, p1Agent, p2Agent, opts)`, `scan`, `extractTeams`, `extractTurnChoices`, `stateBeforeTurn`, `compareState`, `readReplayFile` |
| `league_agents.js` | `createLeague(ids)`, `byId(id)`, `ALL_AGENTS`, `LEAGUE_IDS`, `StandardMetaAnchor` / `AntiTrickRoomExploiter` / `LowLadderChaos` / `EngineMirrorAgent` |
| `mutator.js` | `mutateTeam(packed, rate, { seed }) -> { packed, sets, changes, rejected, seed, mutationRate, inputErrors }`, `new SetMutator(opts)` |
| `blunder_harvester.js` | `analyzeLoss(matchReport, sessionOrOptions)`, `generatePuzzleCode(analysis, options)`, `appendVaccineToFile(code, targetFile)`, `puzzleNameOf`, `SENTINEL` |
| `engine_bridge.js` | `SIM_FORMAT_ID`, `createSession(opts)` (`{baseline:true}` = the frozen shipped config), `EngineSession`, `choiceForRanked`, `teamPreviewOrder`, `loadHarness({setArgs, applyPatch, baseline})`, `loadSim` |
| `run_arena.js` | `parseArgs(argv)`, `main(argv)`, `createEngineAgent`, `renderSummary`, `applyConfigPatch(ST, sets)`, `parseConfigValue`, `formatConfigValue`, `SetupError` |
| `run_ablation.js` | `parseArgs(argv)`, `main(argv)`, `FEATURES`, `buildVariants(ids)`, `validateFeaturePaths(variants)`, `arenaArgs(variant, opts, jsonPath)`, `summarizeRun(payload)`, `verifyPairing(base, variant)`, `pairedBootstrap(a, b, B, seed)`, `compareToBaseline(baseSummary, variantSummary, descriptor, opts)`, `renderTable(rows)` |
| `benchmark_human_match.js` | `parseArgs(argv)`, `main(argv)`, `evaluateBattle(ST, U, replay, sides, opts)`, `scoreDecision(engine, state, cls, ctx)`, `classifySide(bucketLines, side)`, `extractChoices(replayLines)`, `summarize(records, meta)`, `render(summary, opts)`, `regretShare(regret, spread)`, `regretStats(list)`, `extremeSpread(entries)`, `stateKeyOf(state)`, `matchupKeyOf(state)`, `wilson(k, n)`, `eloBand(rate)`, `strideSample(list, n)`, `MIN_CONSENSUS_N` |

**An agent** is anything with `chooseAction(request, { side, turn, request, log, runner })` returning
a choice string. The runner normalizes it, falls back to the first legal option when an agent
returns nothing legal, and walks a bounded retry ladder on a `[Invalid choice]` re-request — every
substitution is recorded, so an agent that is secretly unplayable cannot look like an agent that
went 40-0.

**`MatchReport`** is `{ winner, turnCount, fullLog, p1Log, p2Log, p1Choices, p2Choices, swingTurn,
timedOut, aborted, reason, errors, substitutions, seed, format, maxTurns }`. `swingTurn` is the turn
with the largest HP swing and is `null` when nothing cleared the threshold.

The two kinds of log are not interchangeable, and the difference is load-bearing. `fullLog` is the
omniscient public stream — exactly what a spectator or a replay sees, which is why the splicer's
state comparisons and `computeSwingTurn` read it. `p1Log`/`p2Log` are each seat's own stream: the
public lines PLUS that seat's private frames (`|request|`, `|error|`), in the order a client saw
them, i.e. a strict superset. Any consumer that replays the engine's own DECISIONS must use the side
log, because the sim never publishes `|request|` on the omniscient stream: reading `fullLog` gives an
empty decision timeline, which is a silent failure, not an error. `spliceAndResume` returns that
report with one added key, `spliced`:
`{ turn, reason, seed, playedBack, handoverReached, fidelity: { score, matched, mismatched, fields },
diverged, divergenceReason, desyncs, teamsSource }` — the fidelity object is the handover's own
evidence, and a caller that ignores it is trusting a splice it never checked.

Five facts about the sim's stream protocol. Each was measured against 0.10.11 and each is pinned in
`tests/arena_check.js`, because getting any one of them wrong still looks like a battle:

* The format id is `gen9nationaldex` — **that IS [Gen 9] National Dex OU** (the NatDex OU banlist;
the lower ND tiers derive from it). `gen9nationaldexou` does not exist in the sim:
`Dex.formats.get()` returns a Condition for it, not a Format, and a driver that asks for it plays
nothing while reporting success-shaped silence.
* A team reaches the sim through `Teams.import(paste)` → `Teams.pack(sets)`. The repo's own
`TeamParser.packTeam()` output is NOT accepted: it joins sets with `\n` where the sim splits on `]`,
and writes display names where the sim reads ids (which surfaces as `invalid happiness`).
`league_agents.js` therefore carries PASTES (personas own paste strings, not sample names) and the
bridge does the conversion.
* A choice written to `players.pX.write(...)` must be BARE — `move 1`, `switch 3`, `team 123456`.
That stream prepends `>pX ` itself, and a prefixed choice is an invalid choice.
* `writeEnd()` on a player stream reaches `Battle.destroy()` through a promise, so a late throw
arrives as an unhandled rejection that no surrounding `try/catch` can see. `_abort()` therefore
ends streams only for a game that has NOT already ended: the sim destroys its own battle on `|win|`,
and re-ending it there crashed every normal win.
* **`|request|` is private.** The omniscient stream carries the battle and nothing else, so a log
built from it contains no decision frame; each player stream carries the public log plus that seat's
own frames. `headless_arena/blunder_harvester.js` reads `sourceLines(report, side)` for this reason,
and its self-check fixture (a synthetic log that keeps requests inside `fullLog`) cannot catch the
mistake — only the live check against a real battle can, and that is where it is pinned.

**The vaccine contract.** `tests/tactical_puzzles.js` is both the registry and the runner. A puzzle
is `{ logPrefix, forbiddenMove, validTopMoves }`; running it replays `logPrefix` through the real
pipeline and requires that the engine ranked something, that `forbiddenMove` is NOT the top live
line, and that at least one `validTopMoves` entry appears. Generated code is appended ABOVE the
runner marker near the bottom of that file, so hand-written puzzles go above it too. Because the
engine is deterministic, a freshly harvested vaccine fails: it is a written record of a known
defect and goes green only when the engine is fixed. Do not delete a red vaccine to fix the suite.

`--harvest` mutates a committed file, so it is a deliberate operation: run it, then commit the
vaccine together with the fix that turns it green (or with a note recording that it is still red).

### 7.1 The config patch, and the ablation runner built on it

`run_arena.js --set <dotted.path>=<value>` (repeatable) mutates one tunable in `src/config.js` for
the duration of a run, and the run's report carries an `appliedSets` echo of `[path, from, to]`.

Three properties are contractual, and `tests/ablation_check.js` pins them:

* **The path must already exist.** `applyConfigPatch` refuses an unknown leaf AND an unknown
  intermediate section, and it refuses to descend into a leaf that is a value rather than a
  section. It never creates a key. This is the difference between a benchmark and a benchmark that
  measures a typo and reports it as "neutral" — the worst possible outcome, because the number is
  plausible and the conclusion drawn from it is wrong.
* **The patch lands before the engine reads it.** A session reads its tunables at CONSTRUCTION
  (`laplace_core`'s constructor resolves `laplace.nash`, `laplace.volatility` and
  `laplace.quiescence` into instance fields; `opponent_clock` resolves `clock.enabled`), so the
  patch is applied to the sandbox before the first `EngineSession` exists. Patching mid-run would
  leave the battle already in flight on the old values. One sandbox per process, one variant per
  process — that is why `run_ablation.js` spawns the arena instead of looping in-process.
* **It is idempotent.** The same patch applied twice reports the same `from`/`to` the second time,
  because the write is a plain assignment to a live leaf. The ablation's echo check depends on it.

`run_ablation.js` is a thin orchestrator over that flag: the feature table (`FEATURES`) declares one
config patch per row plus what the author EXPECTED, `buildVariants` turns a selection into the
baseline plus one batch per feature, and each batch is a spawned arena run on the shared seed. It
owns no battle logic, no teams and no engine access of its own — the arena is the only thing that
touches the sim, and the engine inside it is still the shipped one.

What makes its table readable is not the delta but the interval. Two arms on the same seeds are a
PAIRED comparison, so the bootstrap resamples battle INDICES and reads both arms at the same index;
`verifyPairing` re-derives the pairing from the records' own `seed` fields and falls back to an
unpaired resample (flagged `unpaired` in the row) when they disagree, rather than reporting a
paired interval it did not earn. A verdict of `helps`/`hurts` means the 95% interval excludes zero;
everything else is reported as *no measurable effect at this sample size*, which is not a synonym
for neutral. `stall` is a separate flag raised only when the CHANGE against the baseline is longer
games or a higher stall-tie share — flagging an absolute share would mark every paired variant that
inherited a stalling tie from the shared battles.

Every attempt this project has made — every row that was adopted, rejected, left inert or left
unresolved — is registered in `ATTEMPTS.md`, indexed by the shape of the idea rather than its name so
a re-proposal is caught before it is built. That file is the reason a rejected tier keeps its row: an
untraced rejection gets rebuilt.

### 7.2 The human-match benchmark: four framings, and none of them is "agreement"

`tools/benchmark_human_match.js` answers a different question from the arena: not "does this engine
beat X", but "does this engine CHOOSE what a strong human chose". A replay is a hostile source for
that question — it records results, not clicks — so the extraction layers (what a log MEANS, the menu
repair, the side flip) have their own header and their own suite, `tests/human_match_check.js`. What
follows is the METRIC design, because the number this project quotes about its own policy is the one
most easily misread.

**Agreement is a proxy; the gap is the question.** Top-1 agreement counts the row the ranking put
FIRST, so a tie the engine had to order counts as a miss. The load-bearing measure is the human's own
line scored by the engine's own evaluator: the regret share is `(topScore - humanScore) / spread`,
where 0.05 is "a wash" and 0.30+ is the engine saying the human threw value away. The report prints
that pair in its HEADLINE, ahead of the agreement table, and both normalisations are carried — the
share of the MENU'S SPREAD (bounded, comparable across turns with different menus) and the literal
share of the top line's score, which is undefined when that score crosses zero and is therefore
counted over fewer decisions.

**A click is one draw; a bucket is a distribution.** One human's click can be a different plan, a
bluff or a blunder, so matching it is not the same as matching elite play. The consensus pass groups
the corpus by the ACTIVE MATCHUP (`matchupKeyOf` — HP and field deliberately excluded) and asks
whether the engine's top pick is among the lines elites click most in that position, printing the
`3 / distinctHuman` chance floor beside the rate. The finer key (`stateKeyOf`: pair + HP quintile +
field) is kept and REPORTED rather than deleted — how many of its buckets reach `MIN_CONSENSUS_N` —
because the reason to report on the coarse one is that the fine one is too thin to say anything at
realistic corpus sizes. Each bucket also carries the gap of the line elites clicked most, which is how
"the engine agrees with the population" and "the engine is right about the population" are told apart.

**The turn buckets come with a test, not a shape.** A flat top-1 rate across opening / mid / endgame
is equally consistent with an engine that is uniformly decent and one that is uniformly mediocre, and
the aggregate alone cannot separate them. `extremeSpread` runs the two-sample comparison on the best
and worst bucket (twice the standard error of the difference) and the report states the verdict while
printing the LEVELS beside it, so "flat" can be read as one or the other. FLAT always means the
evidence failed to separate the phases — never that the phases were shown equal — and the test runs on
the wash share as well as on agreement, because a flat agreement rate and a flat gap are two different
kinds of flat.

**Three limits are printed where the number is, not in a footnote.** The ATTACK menu is STARVED (a
replay reveals only the moves it saw), so the move half is a LOWER BOUND while the SWITCH menu is
complete; the two halves are printed separately and must not be averaged into one "rating". The
engine's top-1 is a switch far more often than a human's click is, so the pivot ceiling — how often
the engine's own best non-pivot line was the human's click — is measured and printed, which bounds any
switch-penalising change before one is written. And the band table that maps a rate to a ladder rating
is labelled UNCALIBRATED in the report itself.
