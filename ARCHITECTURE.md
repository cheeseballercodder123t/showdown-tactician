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
ST.util.CHOICE_ITEMS, ST.util.Z_CRYSTALS, ST.util.PROTECT_MOVES, ST.util.RECOVERY_MOVES,
ST.util.PIVOT_MOVES, ST.util.HAZARD_MOVES, ST.util.TR_SETTERS, ST.util.STATS, ST.util.TYPES
```

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
state.setFormat(formatName)                    // -> sets formatSupported (NatDex OU only)
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
8. Unsupported format (`|format|` not containing `National Dex`) ⇒ `formatSupported=false`
   and `LaplaceEngine.evaluateTurn` returns `[]`.
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
llm.getTacticalReadout(battleState, laplaceResults, tempoVector)  // -> Promise<{action,confidence,reason}|null>, hard 600ms abort
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
  (`battle.log[battle.log.length - 1]` cursor) for missed lines.

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
   `|terastallize|` lines raise a console warning only.
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
