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
src/sets_db.js         -> ST.SetDatabase
src/team_parser.js     -> ST.TeamParser
src/protocol_parser.js -> ST.ProtocolParser
src/state_manager.js   -> ST.BattleStateManager
src/set_pruner.js      -> ST.ArchetypePruner
src/calc_engine.js     -> ST.DamageEngine
src/trick_room.js      -> ST.TrickRoomEngine
src/evaluator_128d.js  -> ST.DenseStateEvaluator
src/tempo_vector.js    -> ST.TempoEngine
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
  log: []                              // raw protocol lines, bounded to 200
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
  sets `parser.speedHint = { mySpeed }` before feeding each turn. This is a hint only — the
  engine never treats it as authoritative.

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
   // -> { isVetoed: boolean, reason: string|null, code: 'VETO1'..'VETO4'|null }
veto.VETO_CODES                             // { VETO1:'PROTECT_RHYTHM', VETO2:'ABILITY_IMMUNITY', VETO3:'LONE_TR_SETTER', VETO4:'SPEED_SUICIDE' }

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
new ST.LaplaceEngine({ K:6, temperature:35, worldBlend:{avg:0.6, min:0.4}, sampler, damage, evaluator, tempo, veto, trickRoom })
engine.evaluateTurn(battleState, opts)   // -> RankedAction[] sorted by confidence desc
   // RankedAction = { name, kind:'move'|'switch'|'protect', moveId, targetId, confidence (0..100),
   //                  score, isVetoed:boolean, vetoReason:string|null, isOptimal:boolean, damageHint }
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
