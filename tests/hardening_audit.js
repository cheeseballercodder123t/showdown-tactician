/* Showdown Tactician — tests/hardening_audit.js
 *
 * Run me with:  node tests/hardening_audit.js
 *
 * WHAT THIS IS
 *   The regression suite for the bug-hunting sweep (see BUGS_AUDIT_REPORT.md). Every numbered
 *   section below is a bug that was FOUND, reproduced here first, then fixed — so the test
 *   fails on the old code and stays green on the new one. Section 11 is a seeded randomized
 *   fuzz: it builds random-but-legal battles through the real pipeline and asserts the solver's
 *   invariants, so the next defect of this class is caught without a hand-written fixture.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about a browser (no DOM, no extension), and the fuzz is a bounded sample rather
 *   than a proof: 40 streams per run, seeded, so a failure is reproducible.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const S = H.loadAll();
const ST = S.ST;
const U = ST.util;
const ROOT = H.ROOT;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; console.log('  PASS ' + name); return true; }
  failed++;
  failures.push(name + (detail === undefined ? '' : '  ->  ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  ->  ' + detail));
  return false;
}
function eq(name, got, want) {
  return check(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function finite(v) { return typeof v === 'number' && isFinite(v); }
function section(title) { console.log('\n=== ' + title + ' ==='); }

/* ------------------------------------------------------------------ fixtures */

const PASTE = [
  'Ursaluna @ Flame Orb',
  'Ability: Guts',
  'EVs: 252 Atk / 4 SpD / 252 Spe',
  'Adamant Nature',
  '- Headlong Rush',
  '- Facade',
  '- Protect',
  '- Swords Dance',
  '',
  'Toxapex @ Choice Scarf',
  'Ability: Regenerator',
  'EVs: 252 HP / 4 Def / 252 Spe',
  'Jolly Nature',
  '- Baneful Bunker',
  '- Recover',
  '- Scald',
  '- Toxic Spikes',
  '',
  'Kingambit @ Choice Band',
  'Ability: Supreme Overlord',
  'EVs: 252 HP / 252 Atk / 4 SpD',
  'Adamant Nature',
  '- Kowtow Cleave',
  '- Sucker Punch',
  '- Swords Dance',
  '- Iron Head',
  '',
  'Crawdaunt @ Life Orb',
  'Ability: Adaptability',
  'EVs: 252 Atk / 4 SpD / 252 Spe',
  'Jolly Nature',
  '- Crabhammer',
  '- Knock Off',
  '- Aqua Jet',
  '- Swords Dance',
  '',
  'Hatterene @ Leftovers',
  'Ability: Magic Bounce',
  'EVs: 252 HP / 252 SpA / 4 SpD',
  'Quiet Nature',
  '- Trick Room',
  '- Psychic',
  '- Dazzling Gleam',
  '- Healing Wish',
  '',
  'Abomasnow @ Abomasite',
  'Ability: Snow Warning',
  'EVs: 4 HP / 252 SpA / 252 Spe',
  'Modest Nature',
  '- Blizzard',
  '- Giga Drain',
  '- Ice Shard',
  '- Earthquake',
  ''
].join('\n');

/**
 * A live pipeline: state manager + parser + my registered team, fed the lines you pass.
 * Mirrors the wiring in src/content.js and tests/run_tests.js.
 */
function pipeline(lines) {
  const state = new ST.BattleStateManager({ debug: false });
  const parser = new ST.ProtocolParser();
  state.attachParser(parser);
  state.setFormat('[Gen 9] National Dex OU');
  if (typeof state.registerMyTeam === 'function') {
    const parsed = ST.TeamParser.parsePokepaste(PASTE);
    state.registerMyTeam(parsed.pokemon);
  }
  (lines || []).forEach(function (l) { parser.feed(l); });
  return { state: state, parser: parser, battle: state.state || state };
}

function newEngine(opts) {
  const damage = new ST.DamageEngine({ gen: 9 });
  const trickRoom = new ST.TrickRoomEngine(damage);
  const evaluator = new ST.DenseStateEvaluator();
  const tempo = new ST.TempoEngine({ damage: damage, trickRoom: trickRoom });
  const veto = new ST.BlunderVetoGuard({ damage: damage, trickRoom: trickRoom });
  const sampler = new ST.WorldSampler({ K: 4, database: ST.SetDatabase || null });
  const engine = new ST.LaplaceEngine(Object.assign({
    sampler: sampler, damage: damage, evaluator: evaluator, tempo: tempo, veto: veto, trickRoom: trickRoom, K: 4
  }, opts || {}));
  return { engine: engine, damage: damage, veto: veto, sampler: sampler, evaluator: evaluator, trickRoom: trickRoom };
}

const MY_MEGA = [
  '|switch|p1a: Abomasnow|Abomasnow, L50, M|100/100',
  '|-mega|p1a: Abomasnow|Abomasnow-Mega|Abomasite',
  '|switch|p2a: Abomasnow|Abomasnow, L50, M|100/100',
  '|-mega|p2a: Abomasnow|Abomasnow-Mega|Abomasite',
  '|turn|1',
  '|move|p2a: Abomasnow|Blizzard|p1a: Abomasnow',
  '|-damage|p1a: Abomasnow|40/100'
];

/* ============================================================ 1. softmax NaN */

section('1. a tunable temperature must never produce NaN confidence');
const nanFixture = pipeline(MY_MEGA);
// Nash is the default scorer, so the temperature tunable is only live on the legacy softmax path
// (`laplace.nash.enabled = false`). It is tested THERE, because that is the code the knob drives;
// the default path is checked alongside it below so both are covered.
const nanEngine = newEngine({ nash: { enabled: false } });
const nanRanked = nanEngine.engine.evaluateTurn(nanFixture.battle, { temperature: 1 });
check('the solver returned lines at temperature 1', nanRanked.length > 0, String(nanRanked.length));
check('every confidence is a finite number in 0..100',
  nanRanked.every(function (r) { return finite(r.confidence) && r.confidence >= 0 && r.confidence <= 100; }),
  JSON.stringify(nanRanked.slice(0, 3).map(function (r) { return r.confidence; })));
const liveConf = nanRanked.filter(function (r) { return !r.isVetoed; });
check('the live lines still sum to about 100%',
  !liveConf.length || Math.abs(liveConf.reduce(function (a, r) { return a + r.confidence; }, 0) - 100) < 1.5,
  String(liveConf.reduce(function (a, r) { return a + r.confidence; }, 0)));
check('the top line is still the highest confidence one',
  !nanRanked.length || nanRanked.every(function (r, i) { return i === 0 || nanRanked[i - 1].confidence >= r.confidence || r.isVetoed; }));
// The default (mixed-strategy) scorer must hold the same guarantees at the same sharp setting.
const nashRanked = newEngine().engine.evaluateTurn(nanFixture.battle, { temperature: 1 });
const nashLive = nashRanked.filter(function (r) { return !r.isVetoed; });
check('the mixed-strategy path is also NaN-free at temperature 1',
  nashRanked.length > 0 && nashRanked.every(function (r) { return finite(r.confidence) && r.confidence >= 0 && r.confidence <= 100; }),
  JSON.stringify(nashRanked.slice(0, 3).map(function (r) { return r.confidence; })));
check('the mixed-strategy confidences sum to 100',
  !nashLive.length || Math.abs(nashLive.reduce(function (a, r) { return a + r.confidence; }, 0) - 100) < 1e-6,
  String(nashLive.reduce(function (a, r) { return a + r.confidence; }, 0)));

/* ==================================================== 2. sampling determinism */

section('2. the world sampler must be deterministic for a given state');
const detFixture = pipeline(MY_MEGA);
const detEngine = newEngine();
const runA = detEngine.engine.evaluateTurn(detFixture.battle);
const seedsA = detEngine.sampler.lastWorlds.map(function (w) { return w.seed; });
const runB = detEngine.engine.evaluateTurn(detFixture.battle);
const seedsB = detEngine.sampler.lastWorlds.map(function (w) { return w.seed; });
eq('the same state samples the same world seeds', seedsA, seedsB);
eq('the same state ranks the same lines',
  runA.map(function (r) { return [r.kind, r.moveId || r.targetId, r.confidence]; }),
  runB.map(function (r) { return [r.kind, r.moveId || r.targetId, r.confidence]; }));
check('the worlds are still distinct from each other', new Set(seedsA).size === seedsA.length, JSON.stringify(seedsA));
check('no world seed came from Math.random',
  seedsA.every(function (s) { return Number.isInteger(s) && s >= 1; }), JSON.stringify(seedsA));
const otherFixture = pipeline(MY_MEGA.slice(0, 4).concat(['|turn|1', '|move|p2a: Abomasnow|Ice Shard|p1a: Abomasnow', '|-damage|p1a: Abomasnow|77/100']));
const otherEngine = newEngine();
otherEngine.engine.evaluateTurn(otherFixture.battle);
check('two different states sample different seeds',
  JSON.stringify(otherEngine.sampler.lastWorlds.map(function (w) { return w.seed; })) !== JSON.stringify(seedsA));
const seededEngine = newEngine();
seededEngine.sampler.rng = ST.WorldSampler.mulberry32(1234);
seededEngine.engine.evaluateTurn(detFixture.battle);
const injectedA = seededEngine.sampler.lastWorlds.map(function (w) { return w.seed; });
seededEngine.sampler.rng = ST.WorldSampler.mulberry32(1234);
seededEngine.engine.evaluateTurn(detFixture.battle);
eq('an injected rng still drives the sampling', injectedA, seededEngine.sampler.lastWorlds.map(function (w) { return w.seed; }));

/* ============================================== 3. VETO4 speed context (item) */

section('3. the speed comparison behind VETO4 must see items, abilities and weather');
const vEngine = newEngine();
const vState = pipeline(MY_MEGA);
// Deliberately picked to sit BETWEEN the relevant speeds, so each assertion tests the item /
// ability / weather term and nothing else (verified by the companion computeSpeed checks):
//   plain Toxapex 185 < Gholdengo 267 < Scarf Toxapex 277
//   plain Kabutops 259 < Gholdengo 267 < rain Kabutops 518
const fastOpp = {
  species: 'Gholdengo', nature: 'Adamant', level: 100, item: '', ability: 'Good as Gold',
  evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 }, ivs: U.DEFAULT_IVS, boosts: {}
};
const scarfMine = {
  species: 'Toxapex', nature: 'Jolly', level: 100, item: 'Choice Scarf', ability: 'Regenerator',
  evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 0, spe: 252 }, ivs: U.DEFAULT_IVS, boosts: {}
};
const slowMine = Object.assign({}, scarfMine, { item: '' });
check('a Choice Scarf actually changes the effective Speed',
  U.computeSpeed(scarfMine).effective > U.computeSpeed(slowMine).effective,
  U.computeSpeed(slowMine).effective + ' -> ' + U.computeSpeed(scarfMine).effective);
check('the Scarfed mon is faster than the opponent', U.computeSpeed(scarfMine).effective > U.computeSpeed(fastOpp).effective,
  U.computeSpeed(scarfMine).effective + ' vs ' + U.computeSpeed(fastOpp).effective);
check('VETO4 does NOT claim the opponent moves first when our Scarf wins the race',
  vEngine.veto._opponentMovesFirst(vState.battle, scarfMine, fastOpp) === false,
  'mySpeed=' + U.computeSpeed(scarfMine).effective + ' oppSpeed=' + U.computeSpeed(fastOpp).effective);
check('VETO4 still fires when we genuinely are slower',
  vEngine.veto._opponentMovesFirst(vState.battle, slowMine, fastOpp) === true);

const rainState = pipeline(MY_MEGA.slice(0, 5).concat(['|-weather|RainDance']));
const swiftMine = {
  species: 'Kabutops', nature: 'Adamant', level: 100, item: '', ability: 'Swift Swim',
  evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 }, ivs: U.DEFAULT_IVS, boosts: {}
};
check('Swift Swim in rain is visible to the speed comparison',
  vEngine.veto._opponentMovesFirst(rainState.battle, swiftMine, fastOpp) === false,
  'rain speed=' + U.computeSpeed(swiftMine, { ability: 'Swift Swim', weather: 'rain' }).effective +
  ' vs opp=' + U.computeSpeed(fastOpp).effective);
check('the same mon without rain is not boosted',
  vEngine.veto._opponentMovesFirst(vState.battle, swiftMine, fastOpp) === true);

/* ================================================= 4. Mega forme in the worlds */

section('4. a Mega-evolved opponent must be sampled as its Mega forme');
// Venusaur is the fixture because it is IN the bundled set database: its Mega set is stored
// under the BASE species with Venusaurite in `item` (sets_db.js), which is exactly the shape
// that used to make every candidate report a 'species mismatch', lose weight, and put a base
// Venusaur (82 Atk) on the field instead of Mega Venusaur (100 Atk).
const megaFixture = pipeline([
  '|switch|p2a: Venusaur|Venusaur, L50, M|100/100',
  '|-mega|p2a: Venusaur|Venusaur-Mega|Venusaurite',
  '|turn|1'
]);
const megaOpp = (megaFixture.battle.oppTeam || []).find(function (m) { return U.toID(m.species).indexOf('venusaur') === 0; });
eq('the state adopted the Mega forme', megaOpp && U.toID(megaOpp.species), 'venusaurmega');
const megaSampler = new ST.WorldSampler({ K: 6, database: ST.SetDatabase || null });
const megaWorlds = megaSampler.sampleWorlds(megaFixture.battle, ST.SetDatabase || null, 6);
const worldMega = megaWorlds[0] && megaWorlds[0].team.find(function (m) { return U.toID(m.species).indexOf('venusaur') === 0; });
eq('the world mon is the Mega forme too', worldMega && U.toID(worldMega.species), 'venusaurmega');
check('no world reports a species mismatch for the Mega',
  megaWorlds.every(function (w) { return !w.violations.some(function (v) { return v.indexOf('species mismatch') !== -1; }); }),
  JSON.stringify(megaWorlds[0] && megaWorlds[0].violations));
// sampleWorlds normalises the weights, so "full weight" is observable as "no violations at
// all" rather than as weight === 1.
check('no world violates anything the log already proved',
  megaWorlds.every(function (w) { return w.violations.length === 0; }),
  JSON.stringify(megaWorlds[0] && megaWorlds[0].violations));
check('the Mega keeps its Mega Stone in the sampled set',
  !!worldMega && U.isMegaStone(worldMega.item), worldMega && worldMega.item);
check('the Mega base stats are the ones in play', !!worldMega && U.baseStats(worldMega.species).atk === 100,
  worldMega && JSON.stringify(U.baseStats(worldMega.species)));

/* ============================================ 5. species lookup must not prefix-match */

section('5. a base-species lookup must not grab an unrelated forme');
// Reproduces the real path: team preview registers the forme, and the |switch| that actually
// sends out the BASE species resolves by species name (_onSwitch step 2), so a prefix match
// reused the Bloodmoon body and NEVER created the plain Ursaluna that entered slot p2a.
// (A protocol ident WITH a slot, e.g. `|-damage|p2a: X|...`, resolves by slot by design — that
// is why this fixture goes through the switch, not through a damage line.)
const prefixFixture = pipeline([
  '|poke|p2|Ursaluna-Bloodmoon, L50, M|',
  '|switch|p2a: Ursaluna|Ursaluna, L50, M|100/100',
  '|turn|1'
]);
const prefixTeam = prefixFixture.battle.oppTeam || [];
const bloodmoon = prefixTeam.find(function (m) { return m && U.toID(m.species) === 'ursalunabloodmoon'; });
const plainUrsaluna = prefixTeam.find(function (m) { return m && U.toID(m.species) === 'ursaluna'; });
check('the Bloodmoon preview entry was registered', !!bloodmoon);
check('"Ursaluna" does not resolve to Ursaluna-Bloodmoon',
  prefixFixture.state._findBySpecies('p2', 'Ursaluna') !== bloodmoon,
  JSON.stringify(prefixFixture.state._findBySpecies('p2', 'Ursaluna') && prefixFixture.state._findBySpecies('p2', 'Ursaluna').species));
check('the switch created the plain Ursaluna it actually sent out', !!plainUrsaluna,
  JSON.stringify(prefixTeam.map(function (m) { return m && m.species; })));
check('the Bloodmoon was not hijacked as the active body', !!bloodmoon && bloodmoon.isActive !== true);
// The other direction MUST survive: a base name resolving to its own Mega forme is exactly how
// the |-mega| handler finds the body it belongs to.
const megaLookup = pipeline([
  '|switch|p2a: Abomasnow|Abomasnow, L50, M|100/100',
  '|-mega|p2a: Abomasnow|Abomasnow-Mega|Abomasite',
  '|turn|1'
]);
const megaMon = (megaLookup.battle.oppTeam || []).find(function (m) { return m && U.toID(m.species) === 'abomasnowmega'; });
check('a base name still resolves to its own Mega forme',
  !!megaMon && megaLookup.state._findBySpecies('p2', 'Abomasnow') === megaMon,
  JSON.stringify(megaMon && megaMon.species));

/* ================================= 5b. battle formes keep ONE roster entry
 *
 * Aegislash-Shield becomes Aegislash-Blade on |detailschange|, Mimikyu becomes Mimikyu-Busted,
 * and the next |switch| line names the base body again. The lookup keyed on the CURRENT
 * species, so the body that came back could not be found and _onSwitch minted a SECOND
 * MonState for it: a seven-body team, a phantom bench card, a wrong alive count and a wrong
 * Supreme Overlord tally. Measured on a real @pkmn/sim battle before the fix.
 */
section('5b. a battle-forme change never mints a duplicate body');
{
  const fx = pipeline([
    '|poke|p2|Aegislash-Shield, L50, M|',
    '|poke|p2|Kartana, L50, M|',
    '|switch|p2a: Aegislash|Aegislash, L50, M|100/100',
    '|detailschange|p2a: Aegislash|Aegislash-Blade, L50, M',
    '|switch|p2a: Kartana|Kartana, L50, M|100/100',
    '|switch|p2a: Aegislash|Aegislash, L50, M|100/100'
  ]);
  const team = fx.battle.oppTeam || [];
  const blades = team.filter(function (m) { return m && U.toID(m.species).indexOf('aegislash') === 0; });
  check('the roster stays at its six-or-fewer shape', team.filter(Boolean).length <= 2,
    JSON.stringify(team.map(function (m) { return m && m.species; })));
  eq('one Aegislash entry, not two', blades.length, 1);
  check('...and the entry that left as Blade came back out', !!blades[0] && blades[0].isActive === true,
    blades[0] && String(blades[0].isActive));
  check('...with a roster alias that still matches either forme',
    !!blades[0] && fx.state._findBySpecies('p2', 'Aegislash-Blade') === blades[0],
    blades[0] && JSON.stringify(blades[0].formsSeen));

  const mimi = pipeline([
    '|poke|p2|Mimikyu, L50, M|',
    '|switch|p2a: Mimikyu|Mimikyu, L50, M|100/100',
    '|detailschange|p2a: Mimikyu|Mimikyu-Busted, L50, M'
  ]);
  const mimiMon = (mimi.battle.oppTeam || []).filter(function (m) { return m && U.toID(m.species) === 'mimikyubusted'; })[0];
  check('a Disguise break renames the body in place', !!mimiMon && mimiMon.isActive === true,
    JSON.stringify((mimi.battle.oppTeam || []).map(function (m) { return m && m.species; })));
}

/* ================================= 5c. the scout ledger records printed facts
 *
 * A Mega Stone rides on `|-activate|…|item: <Stone>` and a weather/terrain ability rides on
 * the `[from] ability:` clause. Neither reached the ledger: only Booster Energy and Air Balloon
 * were read out of |-activate|, and `[from] ability:` was never read at all, so the HUD's
 * "opponent scout" panel showed moves only — exactly the complaint that it does not log the
 * enemy's items or abilities.
 */
section('5c. items and abilities the protocol printed reach the ledger');
{
  const fx = pipeline([
    '|switch|p2a: Peace|Lopunny, L50, M|100/100',
    '|-activate|p2a: Peace|item: Lopunnite',
    '|-mega|p2a: Peace|Lopunny-Mega|Lopunnite',
    '|switch|p2b: Serenity|Ninetales-Alola, L50, F|100/100',
    '|-weather|Snow|[from] ability: Snow Warning|[of] p2b: Serenity'
  ]);
  const lop = (fx.battle.oppTeam || []).filter(function (m) { return m && U.toID(m.species).indexOf('lopunny') === 0; })[0];
  const ninetales = (fx.battle.oppTeam || []).filter(function (m) { return m && U.toID(m.species).indexOf('ninetales') === 0; })[0];
  eq('the Mega Stone is a confirmed item', lop && lop.confirmedItem, 'Lopunnite');
  eq('...and the Mega forme was adopted', lop && U.toID(lop.species), 'lopunnymega');
  check('the stone is marked irremovable', !!lop && lop.itemIsIrremovable === true);
  eq('the weather ability is a revealed ability', ninetales && ninetales.revealedAbility, 'Snow Warning');
  // The Mega's OWN ability is a fixed fact (Mega Lopunny is always Scrappy) and Showdown never
  // prints an |-ability| line for it, so the state manager adopts it from the dex. What this
  // check really guards is the cross-body leak: the weather ability belongs to Ninetales and
  // must never be credited to the Lopunny.
  check('and it is not credited to the wrong body',
    !!lop && U.toID(lop.revealedAbility) !== 'snowwarning', String(lop && lop.revealedAbility));
  eq('the Mega forme\'s own ability is adopted', lop && lop.revealedAbility, 'Scrappy');
}

/* ================================= 5d. an uncurated species is still itself
 *
 * The pruner's fallback pool was the species-agnostic DEFAULT built from Great Tusk, so an
 * uncurated body was simulated with Great Tusk's ability (Protosynthesis) and a physical
 * 252 Atk spread. A Serperior therefore read `bulky @ Heavy-Duty Boots [ATK 252 / SPE 252]`
 * and its Fire Punch matchup was priced off a body that cannot exist.
 */
section('5d. the generic fallback describes the species, not Great Tusk');
{
  const fx = pipeline([
    '|poke|p2|Serperior, L50, M|',
    '|switch|p2a: Diligence|Serperior, L50, M|100/100'
  ]);
  const serp = (fx.battle.oppTeam || []).filter(function (m) { return m && U.toID(m.species) === 'serperior'; })[0];
  check('the Serperior entry exists', !!serp);
  const pruner = new ST.ArchetypePruner({ damage: new ST.DamageEngine({ gen: 9 }) });
  pruner.prune(serp, fx.battle);
  const pool = (serp && serp.candidateSets) || [];
  check('a fallback pool was published', pool.length > 0, String(pool.length));
  const abilities = pool.map(function (s) { return U.toID(s.ability); });
  check('no fallback set is a different species\'s Paradox ability',
    abilities.every(function (a) { return a !== 'protosynthesis' && a !== 'quarkdrive'; }), JSON.stringify(abilities));
  check('the ability is one Serperior can actually have (Overgrow / Contrary)',
    abilities.every(function (a) { return a === 'overgrow' || a === 'contrary'; }), JSON.stringify(abilities));
  const live = serp && serp.liveSet;
  check('the believed spread invests Special Attack, not Attack',
    !!live && (live.evs.spa || 0) > (live.evs.atk || 0), live && JSON.stringify(live.evs));
  /* THE DEX ORDER IS NOT THE COMPETITIVE ABILITY. abilities[0] gave every uncurated body its
   * placeholder (Serperior Overgrow instead of Contrary, Dragonite Inner Focus instead of
   * Multiscale, Scizor Swarm instead of Technician), and the pruner then dropped the whole pool
   * the moment the real ability printed. */
  const serpTop = pool.slice().sort(function (a, b) { return (b.weight || 0) - (a.weight || 0); })[0];
  eq('the generic pool prefers Contrary over the dex-order Overgrow', serpTop && serpTop.ability, 'Contrary');
  check('...while still representing the other legal ability, so a reveal cannot empty the pool',
    abilities.indexOf('overgrow') !== -1, JSON.stringify(abilities));
  const dnite = ST.SetDatabase.genericFor('Dragonite') || [];
  const dniteAbilities = dnite.map(function (s) { return s.ability; });
  const dniteTop = dnite.slice().sort(function (a, b) { return (b.weight || 0) - (a.weight || 0); })[0];
  eq('Dragonite is modelled with Multiscale, not Inner Focus', dniteTop && dniteTop.ability, 'Multiscale');
  check('...and Inner Focus is still a candidate', dniteAbilities.indexOf('Inner Focus') !== -1, JSON.stringify(dniteAbilities));
  /* And the moves are the body's OWN typing: the old pool gave every special attacker Psychic /
   * Shadow Ball / Volt Switch / Calm Mind, so a Grass type was modelled as a Psychic threat. */
  const genericMoves = [];
  for (let i = 0; i < dnite.length; i++) genericMoves.push.apply(genericMoves, dnite[i].moves || []);
  check('a generic Dragonite does not carry a Psychic/Fighting filler move',
    genericMoves.every(function (m) { return U.toID(m) !== 'psychic' && U.toID(m) !== 'shadowball' && U.toID(m) !== 'voltswitch'; }),
    JSON.stringify(genericMoves));
  check('...and its STAB is a Dragon move it could plausibly click',
    genericMoves.some(function (m) { return U.toID(m).indexOf('dragon') === 0; }), JSON.stringify(genericMoves));
  const serpPool = ST.SetDatabase.genericFor('Serperior') || [];
  const serpGrass = serpPool.every(function (s) {
    return (s.moves || []).some(function (m) { const d = U.getMoveData(m); return d && d.type === 'Grass'; });
  });
  check('every generic Serperior set leads with a Grass move', serpGrass, JSON.stringify(serpPool.map(function (s) { return s.moves; })));
  const scarves = serpPool.filter(function (s) { return s.item === 'Choice Scarf'; });
  check('the Scarf template follows the special split (Timid, 252 SpA)',
    scarves.length > 0 && scarves.every(function (s) { return s.nature === 'Timid' && (s.evs.spa || 0) === 252 && (s.evs.atk || 0) === 0; }),
    JSON.stringify(scarves.map(function (s) { return { nature: s.nature, evs: s.evs }; })));
}

/* ================================= 5e. immunity and forme clauses reach the ledger
 *
 * `|-immune|` changes no HP, so it was parsed as an unknown command; `|-formechange|` was
 * treated as a rename only. Both carry a `[from] ability:` clause, and both were dropped, so a
 * Cresselia's Levitate and an Aegislash's Stance Change never reached the scout ledger.
 */
section('5e. an immunity line and a forme line both reveal their ability');
{
  const fx = pipeline([
    '|switch|p2a: Cresselia|Cresselia, L50, F|100/100',
    '|-immune|p2a: Cresselia|[from] ability: Levitate',
    '|switch|p2b: Blade|Aegislash, L50, M|100/100',
    '|-formechange|p2b: Blade|Aegislash-Blade|[from] ability: Stance Change'
  ]);
  const cress = (fx.battle.oppTeam || []).filter(function (m) { return m && U.toID(m.species) === 'cresselia'; })[0];
  const aegis = (fx.battle.oppTeam || []).filter(function (m) { return m && U.toID(m.species).indexOf('aegislash') === 0; })[0];
  eq('Levitate is read off the immunity line', cress && cress.revealedAbility, 'Levitate');
  eq('Stance Change is read off the forme line', aegis && aegis.revealedAbility, 'Stance Change');
  check('...and the body keeps its roster identity',
    !!aegis && U.toID(aegis.rosterSpecies).indexOf('aegislash') === 0, aegis && aegis.rosterSpecies);

  /* Trace prints the COPIED ability first and the body's own ability third. The generic
   * `[from] ability:` reader credited the SOURCE body with Trace. */
  const traceFx = pipeline([
    '|switch|p2a: Porygon2|Porygon2, L100, M|100/100',
    '|switch|p2b: Landorus|Landorus, L100, M|100/100',
    '|-ability|p2a: Porygon2|Intimidate|Trace|[from] ability: Trace|[of] p2b: Landorus'
  ]);
  const pory = (traceFx.battle.oppTeam || []).filter(function (m) { return m && U.toID(m.species) === 'porygon2'; })[0];
  const lando = (traceFx.battle.oppTeam || []).filter(function (m) { return m && U.toID(m.species) === 'landorus'; })[0];
  eq('a copied ability is not credited to the body it came from', lando && lando.revealedAbility, null);
  eq('the copying body keeps its own ability', pory && pory.revealedAbility, 'Trace');
  eq('...and the copied effect is recorded separately', pory && pory.activeAbility, 'Intimidate');
}

/* ================================= 5f. the damage model the ladder actually showed
 *
 * Four pricing errors found against real @pkmn/sim damage (102 hits, 100 inside the envelope):
 * multi-hit moves were always priced at the library's midpoint of 3, a Choice Band that had been
 * knocked off kept multiplying every later hit by 1.5, a battle-only type change was ignored, and
 * Mimikyu's Disguise was priced as a normal hit.
 */
section('5f. multi-hit, lost items, type changes and Disguise are all priced');
{
  const dm = new ST.DamageEngine({ gen: 9 });
  const evsAtk = { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 };
  const evsWall = { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 };
  const tusk = { species: 'Great Tusk', level: 100, nature: 'Adamant', evs: evsAtk, ivs: U.DEFAULT_IVS };
  const wall = { species: 'Toxapex', level: 100, nature: 'Bold', evs: evsWall, ivs: U.DEFAULT_IVS };

  const skill = dm.calculateDamage(Object.assign({}, tusk, { ability: 'Skill Link' }), wall, 'Bullet Seed', {});
  const plain = dm.calculateDamage(Object.assign({}, tusk, { ability: 'Overgrow' }), wall, 'Bullet Seed', {});
  check('Skill Link prices Bullet Seed at five hits, not three',
    skill && plain && skill.minDmg > plain.maxDmg, JSON.stringify({ skill: skill && skill.minDmg, plain: plain && plain.maxDmg }));
  const dice = dm.calculateDamage(Object.assign({}, tusk, { ability: 'Overgrow', item: 'Loaded Dice' }), wall, 'Bullet Seed', {});
  check('Loaded Dice lifts the floor to four', dice && dice.minDmg > plain.minDmg, JSON.stringify({ dice: dice && dice.minDmg, plain: plain && plain.minDmg }));

  const banded = dm.calculateDamage(Object.assign({}, tusk, { item: 'Choice Band' }), wall, 'Headlong Rush', {});
  const knocked = dm.calculateDamage(Object.assign({}, tusk, { item: 'Choice Band', itemRemoved: true }), wall, 'Headlong Rush', {});
  const consumed = dm.calculateDamage(Object.assign({}, tusk, { item: 'Choice Band', itemConsumed: true }), wall, 'Headlong Rush', {});
  check('a knocked-off Choice Band stops multiplying damage',
    banded && knocked && knocked.maxDmg < banded.minDmg, JSON.stringify({ banded: banded && banded.minDmg, knocked: knocked && knocked.maxDmg }));
  check('...and so does one that was consumed',
    consumed && consumed.maxDmg === knocked.maxDmg, JSON.stringify({ consumed: consumed && consumed.maxDmg, knocked: knocked && knocked.maxDmg }));

  const feline = { species: 'Meowscarada', level: 100, nature: 'Jolly', evs: evsAtk, ivs: U.DEFAULT_IVS };
  const normalTyping = dm.calculateDamage(tusk, feline, 'Close Combat', {});
  const pureGrass = dm.calculateDamage(tusk, Object.assign({}, feline, { typeOverride: ['Grass'] }), 'Close Combat', {});
  check('a Grass/Dark body takes 2x from Fighting', !!normalTyping && normalTyping.maxPercent > 0);
  check('...but once Protean makes it pure Grass the same hit is neutral',
    !!pureGrass && pureGrass.maxDmg < normalTyping.minDmg * 0.7,
    JSON.stringify({ normal: normalTyping && normalTyping.minDmg, grass: pureGrass && pureGrass.maxDmg }));

  const disguiseState = new ST.BattleStateManager();
  const dp = new ST.ProtocolParser();
  disguiseState.attachParser(dp);
  disguiseState.setFormat('[Gen 9] National Dex');
  disguiseState.registerMyTeam(ST.TeamParser.parsePokepaste([
    'Great Tusk @ Leftovers', 'Ability: Protosynthesis', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- Close Combat', '- Headlong Rush', '- Ice Spinner', '- Rapid Spin'
  ].join('\n')).pokemon);
  dp.feedAll([
    '|switch|p1a: Great Tusk|Great Tusk, L100, M|100/100',
    '|switch|p2a: Mimikyu|Mimikyu, L100, M|100/100',
    '|turn|1'
  ]);
  const disguiseEngine = new ST.LaplaceEngine({ K: 2 });
  const attempt = function (fn) {
    try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, error: e && e.message }; }
  };
  const disguised = attempt(function () { return disguiseEngine.preview(disguiseState.state.active.opp, disguiseState.state); });
  // Ice Spinner, not Close Combat: Mimikyu is a Ghost, so Fighting is immune to it with or
  // without the costume and would prove nothing.
  const dress = disguised.value && disguised.value.lines.filter(function (l) { return l.moveId === 'icespinner'; })[0];
  check('an intact Disguise is priced at zero, never an OHKO', !!dress && dress.maxPercent === 0 && dress.isOHKO === false,
    JSON.stringify(dress && [dress.minPercent, dress.maxPercent, dress.isOHKO]));
  check('...and the bar says why', !!dress && /disguise/i.test(dress.verdict || ''), dress && dress.verdict);
  dp.feed('|-activate|p2a: Mimikyu|ability: Disguise');
  const brokenPreview = attempt(function () { return disguiseEngine.preview(disguiseState.state.active.opp, disguiseState.state); });
  const broken = brokenPreview.value && brokenPreview.value.lines.filter(function (l) { return l.moveId === 'icespinner'; })[0];
  check('once the costume breaks the hit is priced again', !!broken && broken.maxPercent > 0,
    JSON.stringify(broken && [broken.minPercent, broken.maxPercent]));
}

/* ================================= 5g. stat stages, fractional HP and frame noise
 *
 * Every stage the battle erases has to leave the state, or the evaluator prices the next hit off
 * a boost that no longer exists. The four transfer commands, the faint reset, fractional HP and
 * Showdown's timestamp frame were all dropped before this sweep.
 */
section('5g. stat stages follow the protocol, and frame noise stays out');
{
  const boots = [
    '|switch|p1a: Great Tusk|Great Tusk, L100, M|100/100',
    '|switch|p2a: Corviknight|Corviknight, L100, M|100/100'
  ];
  const stageLines = function (extra) { return pipeline(boots.concat(extra)); };
  const left = function (fx, side, stat) {
    const mon = side === 'p1' ? fx.battle.active.my : fx.battle.active.opp;
    return mon && mon.boosts ? mon.boosts[stat] : null;
  };

  const cleared = stageLines(['|-boost|p1a: Great Tusk|atk|2', '|-unboost|p1a: Great Tusk|def|1',
    '|-clearpositiveboost|p1a: Great Tusk|p2a: Corviknight|move: Defog']);
  eq('Defog clears the positive stages', left(cleared, 'p1', 'atk'), 0);
  eq('...and leaves the negative ones alone', left(cleared, 'p1', 'def'), -1);

  const inverted = stageLines(['|-boost|p1a: Great Tusk|atk|2', '|-unboost|p1a: Great Tusk|spe|1',
    '|-invertboost|p1a: Great Tusk']);
  eq('Topsy-Turvy flips Atk to -2', left(inverted, 'p1', 'atk'), -2);
  eq('...and Spe to +1', left(inverted, 'p1', 'spe'), 1);

  const swapped = stageLines(['|-boost|p1a: Great Tusk|atk|2', '|-unboost|p2a: Corviknight|atk|1',
    '|-swapboost|p1a: Great Tusk|p2a: Corviknight|atk,def']);
  eq('Heart Swap moves our +2 Atk to them', left(swapped, 'p2', 'atk'), 2);
  eq('...and their -1 Atk to us', left(swapped, 'p1', 'atk'), -1);

  const copied = stageLines(['|-boost|p1a: Great Tusk|spd|2',
    '|-copyboost|p2a: Corviknight|p1a: Great Tusk|spd']);
  eq('Psych Up copies the stage across', left(copied, 'p2', 'spd'), 2);

  const fainted = stageLines(['|-boost|p2a: Corviknight|atk|3', '|faint|p2a: Corviknight']);
  const corpse = (fainted.battle.oppTeam || []).filter(function (m) { return m && m.fainted; })[0];
  eq('a faint erases the stages it carried', corpse && corpse.boosts.atk, 0);

  const fractional = stageLines(['|-damage|p2a: Corviknight|72.06/100']);
  check('a fractional landing is stored, not discarded',
    !!fractional.battle.active.opp && Math.abs(fractional.battle.active.opp.hpPercent - 72.06) < 1e-6,
    String(fractional.battle.active.opp && fractional.battle.active.opp.hpPercent));

  const noise = new ST.ProtocolParser();
  eq('the timestamp frame is not an event', noise.parseLine('|t:|1792877078'), null);
  eq('the blank turn separator is not an event', noise.parseLine('|'), null);
}

/* ============================ 5h. KO credit and Illusion belong to the right body */

section('5h. a faint is credited to the slot\'s CURRENT occupant\'s attacker, and |replace| is not a switch');
{
  /* The KO tally is kept per SLOT. Without clearing it on switch-in, the body that came in and
   * died to Stealth Rock inherited the attacker from its predecessor and was credited with a KO
   * it never landed. */
  const koFx = pipeline([
    '|switch|p1a: Abomasnow|Abomasnow, L100, M|100/100',
    '|switch|p2a: Gholdengo|Gholdengo, L100, M|100/100',
    '|turn|1',
    '|-damage|p1a: Abomasnow|50/100|[from] move: Make It Rain|[of] p2a: Gholdengo',
    '|turn|2',
    '|switch|p1a: Hatterene|Hatterene, L100, F|100/100',
    '|-damage|p1a: Hatterene|0 fnt|[from] Stealth Rock',
    '|faint|p1a: Hatterene'
  ]);
  const kos = (koFx.battle.battleStats || {}).kos || {};
  check('a hazard faint is not credited to the previous occupant\'s attacker',
    !kos.gholdengo, JSON.stringify(kos));

  /* `|replace|` is Illusion breaking: the body never left. Its stages, stint and switch-in
   * window must survive; treating it as a fresh switch erased the boosts the board still shows. */
  const repFx = pipeline([
    '|switch|p2a: Zoroark|Zoroark, L100, M|100/100',
    '|turn|1',
    '|move|p2a: Zoroark|Night Slash|p1a: Abomasnow',
    '|-boost|p2a: Zoroark|atk|2',
    '|turn|2',
    '|replace|p2a: Zoroark|Zoroark, L100, M|100/100'
  ]);
  const zoro = (repFx.battle.oppTeam || []).filter(function (m) { return m && U.toID(m.species) === 'zoroark'; })[0];
  eq('a replace keeps the boosts on the board', zoro && zoro.boosts.atk, 2);
  eq('...and keeps the stint', zoro && zoro.activeStintMoves, ['Night Slash']);
  eq('...and does not re-open the switch-in ability window', zoro && zoro.switchedInTurn, 1);
}

/* ================================ 5i. the reported hit, end to end through preview()
 *
 * The original report: a burned Guts Ursaluna's Fire Punch into Serperior previewed 12% and did
 * 98%. This is the same board, through the same entry point the HUD bars use, with the pruner
 * pool in place and no bench selection. The 12% is now impossible: the envelope is the pool's,
 * and even its BULKIEST spread (252 HP / 252+ Def) takes more than half.
 */
section('5i. burned Guts Ursaluna Fire Punch into Serperior is priced at the board');
{
  const mine = [
    'Ursaluna @ Flame Orb', 'Ability: Guts', 'EVs: 252 HP / 252 Atk / 4 SpD', 'Brave Nature',
    'IVs: 0 Spe', '- Fire Punch', '- Headlong Rush', '- Facade', '- Protect'
  ].join('\n');
  const st = new ST.BattleStateManager({ debug: false });
  const prsr = new ST.ProtocolParser();
  st.attachParser(prsr);
  st.setFormat('[Gen 9] National Dex OU');
  st.registerMyTeam(ST.TeamParser.parsePokepaste(mine).pokemon);
  [
    '|switch|p1a: 3rd Degree Burn|Ursaluna, L100, M|100/100',
    '|switch|p2a: Diligence|Serperior, L100, M|100/100',
    '|turn|1',
    '|-status|p1a: Ursaluna|brn|[from] item: Flame Orb'
  ].forEach(function (l) { prsr.feed(l); });
  const b = st.state;
  const dmg = new ST.DamageEngine({ gen: 9 });
  const eng = new ST.LaplaceEngine({ damage: dmg, K: 2 });
  new ST.ArchetypePruner({ damage: dmg }).prune(b.active.opp, b);
  const pv = eng.preview(b.active.opp, b);
  const fp = pv && (pv.lines || []).filter(function (l) { return U.toID(l.name) === 'firepunch'; })[0];
  check('the Fire Punch line exists', !!fp);
  check('the attacker is burned and Guts is its known ability',
    b.active.my.status === 'brn' && U.toID(b.active.my.ability) === 'guts',
    JSON.stringify({ status: b.active.my.status, ability: b.active.my.ability }));
  check('the range covers more than one believed spread', !!fp && fp.spreadCount >= 2,
    fp && String(fp.spreadCount));
  check('even the bulkiest believed Serperior takes more than half', !!fp && fp.minPercent >= 55,
    fp && String(fp.minPercent));
  check('the top of the range is a knockout, not 12%', !!fp && fp.maxPercent >= 95,
    fp && String(fp.maxPercent));
  check('the verdict is never the old "leaves them at ~0%"',
    !!fp && /2HKO|lethal/.test(fp.verdict || ''), fp && fp.verdict);
}

/* ================================================== 6. the damage memo key */

section('6. two different IV spreads must not share a memo entry');
const memoEngine = new ST.DamageEngine({ gen: 9 });
memoEngine.beginTurn('memo');
const ivs31 = Object.assign({}, U.DEFAULT_IVS);
const ivsWeak = Object.assign({}, U.DEFAULT_IVS, { atk: 0 });
const strong = memoEngine.calculateDamage(
  { species: 'Great Tusk', nature: 'Adamant', level: 100, evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, ivs: ivs31 },
  { species: 'Toxapex', nature: 'Bold', level: 100, evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 }, ivs: ivs31 },
  'Headlong Rush', {});
const weakIvs = memoEngine.calculateDamage(
  { species: 'Great Tusk', nature: 'Adamant', level: 100, evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, ivs: ivsWeak },
  { species: 'Toxapex', nature: 'Bold', level: 100, evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 }, ivs: ivs31 },
  'Headlong Rush', {});
check('a 0-Atk IV is measurably weaker than a 31-Atk IV', weakIvs.minDmg < strong.minDmg,
  '31 IV=' + strong.minDmg + ' 0 IV=' + weakIvs.minDmg);
check('the memo did NOT serve the 31-IV roll for the 0-IV mon', weakIvs.minDmg !== strong.minDmg,
  JSON.stringify({ strong: strong.minDmg, weak: weakIvs.minDmg, cache: memoEngine.cacheSize() }));

/* ============================================= 7. Struggle and the Choice rule */

section('7. Struggle must not disprove a Choice item');
const struggleFixture = pipeline([
  '|switch|p2a: Kingambit|Kingambit, L50, M|100/100',
  '|turn|1',
  '|move|p2a: Kingambit|Kowtow Cleave|p1a: Abomasnow',
  '|turn|2',
  '|move|p2a: Kingambit|Struggle|p1a: Abomasnow',
  '|turn|3'
]);
const struggleMon = (struggleFixture.battle.oppTeam || []).find(function (m) { return m && U.toID(m.species) === 'kingambit'; });
check('Kingambit is in the state', !!struggleMon);
eq('distinct moves excludes Struggle', ST.ArchetypePruner && new ST.ArchetypePruner().distinctStintMoves(struggleMon), ['kowtowcleave']);
const pruner = new ST.ArchetypePruner();
const choiceVerdict = pruner.applyChoiceLockRule(struggleMon, struggleFixture.battle);
check('Struggle does not trip the Choice-lock rule', choiceVerdict.pruned === false,
  JSON.stringify(choiceVerdict));
check('the Choice item is still possible on that mon', struggleMon.cannotBeChoice !== true);
// ...while two REAL moves still disprove it.
const realFixture = pipeline([
  '|switch|p2a: Kingambit|Kingambit, L50, M|100/100',
  '|turn|1',
  '|move|p2a: Kingambit|Kowtow Cleave|p1a: Abomasnow',
  '|turn|2',
  '|move|p2a: Kingambit|Iron Head|p1a: Abomasnow',
  '|turn|3'
]);
const realMon = (realFixture.battle.oppTeam || []).find(function (m) { return m && U.toID(m.species) === 'kingambit'; });
const realVerdict = pruner.applyChoiceLockRule(realMon, realFixture.battle);
check('two real moves DO disprove a Choice item', realVerdict.pruned === true, JSON.stringify(realVerdict));

/* A move the battle CALLED is not a click. Showdown prints a second `|move|` line for Sleep Talk,
 * Metronome, Dancer and Instruct with `[from] <cause>`; counting it gave the body 2+ distinct
 * moves in one stint, which the pruner reads as proof that no Choice item is held (the recurring
 * "CHOICE LOCK BROKEN" ticket on bodies that never broke one) and credited it with a move it
 * does not own (a Metronome Moonblast in the scout ledger). */
const calledFixture = pipeline([
  '|switch|p2a: Clefable|Clefable, L50, M|100/100',
  '|turn|1',
  '|move|p2a: Clefable|Sleep Talk|p2a: Clefable',
  '|move|p2a: Clefable|Moonblast|p1a: Abomasnow|[from]Sleep Talk',
  '|turn|2'
]);
const calledMon = (calledFixture.battle.oppTeam || []).find(function (m) { return m && U.toID(m.species) === 'clefable'; });
check('the Sleep Talk user is in the state', !!calledMon);
eq('a called move does not join the stint', calledMon && calledMon.activeStintMoves, ['Sleep Talk']);
eq('...and is not credited to the body as a known move', calledMon && calledMon.revealedMoves, ['Sleep Talk']);
eq('the click that counts is the caller', calledMon && calledMon.lastMove, 'Sleep Talk');
const calledVerdict = pruner.applyChoiceLockRule(calledMon, calledFixture.battle);
check('a called move does not trip the Choice-lock rule', calledVerdict.pruned === false, JSON.stringify(calledVerdict));
/* ...but the board effect of a called move is REAL and must still be applied. */
const calledTR = pipeline([
  '|switch|p2a: Clefable|Clefable, L50, M|100/100',
  '|switch|p1a: Abomasnow|Abomasnow, L50, M|100/100',
  '|turn|1',
  '|move|p2a: Clefable|Sleep Talk|p2a: Clefable',
  '|move|p2a: Clefable|Trick Room|p2a: Clefable|[from]Sleep Talk'
]);
check('a called Trick Room still twists the dimensions', calledTR.battle.field.trickRoom === true);

/* ===================================== 8. candidate pools are per-Pokémon, not per-species */

section('8. a deduction about THEIR mon must not rewrite OUR mon of the same species');
const mirrorFixture = pipeline([
  '|switch|p1a: Kingambit|Kingambit, L50, M|100/100',
  '|switch|p2a: Kingambit|Kingambit, L50, M|100/100',
  '|turn|1',
  '|move|p2a: Kingambit|Kowtow Cleave|p1a: Abomasnow',
  '|turn|2',
  '|move|p2a: Kingambit|Iron Head|p1a: Abomasnow',
  '|turn|3'
]);
const myKing = (mirrorFixture.battle.myTeam || []).find(function (m) { return m && U.toID(m.species) === 'kingambit'; });
const theirKing = (mirrorFixture.battle.oppTeam || []).find(function (m) { return m && U.toID(m.species) === 'kingambit'; });
check('both sides have a Kingambit', !!myKing && !!theirKing);
const mirrorPruner = new ST.ArchetypePruner();
// Seed OUR pool first: with a single shared per-species pool their prune below rewrote it, so
// our next re-prune inherited a deduction that was never about our monster.
const mineBefore = mirrorPruner.prune(myKing, mirrorFixture.battle);
check('our own pool starts with a Choice Band option',
  mineBefore.some(function (s) { return U.isChoiceItem(s.item); }),
  JSON.stringify(mineBefore.map(function (s) { return s.item; })));
mirrorPruner.prune(theirKing, mirrorFixture.battle);
check('their Choice sets were disproved', theirKing.cannotBeChoice === true);
const myRePruned = mirrorPruner.prune(myKing, mirrorFixture.battle);
check('re-pruning our mon does not inherit their deduction',
  (myKing.candidateSets || []).some(function (s) { return U.isChoiceItem(s.item); }),
  JSON.stringify({ verdict: myRePruned && myRePruned.pruned, sets: (myKing.candidateSets || []).map(function (s) { return s.item; }) }));

/* ================================================= 9. an impossible speed floor */

section('9. an unsatisfiable speed floor must not empty the pool');
const floorFixture = pipeline([
  '|switch|p2a: Slowking|Slowking-Galar, L50, M|100/100',
  '|turn|1'
]);
const slowking = (floorFixture.battle.oppTeam || []).find(function (m) { return m && U.toID(m.species) === 'slowkinggalar'; });
check('Slowking-Galar is in the state', !!slowking);
const floorPruner = new ST.ArchetypePruner();
slowking.speedFloor = 900;
const floorResult = floorPruner.applySpeedFloor(slowking, floorFixture.battle);
check('the pool is not emptied by an impossible floor', (slowking.candidateSets || []).length > 0,
  JSON.stringify({ dropped: floorResult.dropped, survivors: (slowking.candidateSets || []).length }));
check('a live set is still published', !!slowking.liveSet, JSON.stringify(slowking.liveSet && slowking.liveSet.id));
check('the closest sets are the ones kept',
  (slowking.candidateSets || []).every(function (s) { return typeof s.maxSpeed === 'number'; }) &&
  (slowking.candidateSets || []).length <= 4,
  JSON.stringify((slowking.candidateSets || []).map(function (s) { return s.maxSpeed; })));

/* ================================================== 10. heal-after-faint = revival */

section('10. a heal on a fainted body must clear the faint latch (Revival Blessing)');
const reviveFixture = pipeline([
  '|switch|p2a: Kingambit|Kingambit, L50, M|100/100',
  '|turn|1',
  '|-damage|p2a: Kingambit|0 fnt',
  '|faint|p2a: Kingambit'
]);
const deadMon = (reviveFixture.battle.oppTeam || []).find(function (m) { return m && U.toID(m.species) === 'kingambit'; });
check('the fainted mon is recorded as fainted at 0%',
  !!deadMon && deadMon.fainted === true && deadMon.hpPercent === 0,
  JSON.stringify(deadMon && { fainted: deadMon.fainted, hp: deadMon.hpPercent }));
reviveFixture.parser.feed('|-heal|p2a: Kingambit|50/100');
check('the healed mon is alive again, not fainted at 50%',
  !!deadMon && deadMon.fainted === false && deadMon.hpPercent === 50,
  JSON.stringify(deadMon && { fainted: deadMon.fainted, hp: deadMon.hpPercent }));

/* ================================= 12. a second |init| starts a clean battle */

section('12. a second |init| must start a clean battle (reconnect / rematch)');

/* Showdown re-sends `|init|` followed by the ENTIRE log from turn 1 whenever the socket
 * reconnects mid-battle, and a rematch in the same room re-uses the connection. Replaying a log
 * on top of the previous battle is not idempotent, so the board has to be cleared first. */
const HEADER = [
  '|init|[Gen 9] National Dex',
  '|player|p1|Me|1|1550',
  '|player|p2|Foe|2|1480',
  '|teamsize|p1|6',
  '|teamsize|p2|6',
  '|gametype|singles',
  '|gen|9',
  '|tier|[Gen 9] National Dex OU',
  '|clearpoke'
];

const reconnectState = new ST.BattleStateManager({ debug: false });
const reconnectParser = new ST.ProtocolParser();
reconnectState.attachParser(reconnectParser);
reconnectState.setFormat('[Gen 9] National Dex OU');
reconnectState.registerMyTeam(ST.TeamParser.parsePokepaste(PASTE).pokemon);

function feedReconnect(lines) { lines.forEach(function (l) { reconnectParser.feed(l); }); }

feedReconnect(HEADER.concat([
  '|poke|p1|Ursaluna, L50, M|item',
  '|poke|p2|Iron Valiant, L50, F|item',
  '|poke|p2|Landorus-Therian, L50, M|item',
  '|start',
  '|switch|p1a: Ursaluna|Ursaluna, L50, M|100/100',
  '|switch|p2a: Iron Valiant|Iron Valiant, L50, F|100/100',
  '|turn|1',
  '|-boost|p2a: Iron Valiant|spa|2',
  '|-sidestart|p2: Foe|move: Stealth Rock',
  '|move|p2a: Iron Valiant|Moonblast|p1a: Ursaluna',
  '|-damage|p1a: Ursaluna|40/100'
]));

const before = reconnectState.state;
check('battle 1 left an opponent roster to leak', (before.oppTeam || []).length === 2,
  'oppTeam=' + (before.oppTeam || []).length);
check('battle 1 left our lead damaged', before.myTeam[0].hpPercent === 40,
  'hp=' + before.myTeam[0].hpPercent);

/* --- the reconnect: same connection, `|init|` again, a DIFFERENT opponent --- */
feedReconnect(HEADER.concat([
  '|poke|p1|Ursaluna, L50, M|item',
  '|poke|p2|Kingambit, L50, M|item',
  '|start',
  '|switch|p1a: Ursaluna|Ursaluna, L50, M|100/100',
  '|switch|p2a: Kingambit|Kingambit, L50, M|100/100',
  '|turn|1'
]));

const after = reconnectState.state;
eq('the phantom opponent roster is gone', (after.oppTeam || []).map(function (m) { return m.species; }), ['Kingambit']);
eq('and the new opponent is the active one', after.active.opp && after.active.opp.species, 'Kingambit');
eq('our pasted team survives the reset (it is connection truth, not battle state)',
  (after.myTeam || []).length, 6);
eq('including its item', after.myTeam[0].item, 'Flame Orb');
eq('and its EV/IV truth', after.myTeam[0].fromPaste === true && !!after.myTeam[0].stats, true);
eq('the previous battle\'s damage is gone', after.myTeam[0].hpPercent, 100);
eq('the previous battle\'s boosts are gone',
  after.oppTeam[0] && after.oppTeam[0].boosts ? after.oppTeam[0].boosts.spa : 'missing', 0);
eq('and so are its hazards',
  after.field && after.field.hazards && after.field.hazards.p2 ? after.field.hazards.p2.rocks : 'missing', false);
eq('the format is still recognised', after.formatSupported, true);
check('and it is still National Dex', /national\s*dex/i.test(after.format || ''), 'format=' + after.format);

/* `|format|` parses to the same event type as `|init|` but is a room header, not a battle
 * start: it must NOT wipe a battle in progress. Checked on its own pipeline so the assertion
 * measures the |format| path and nothing else. */
const fmtState = new ST.BattleStateManager({ debug: false });
const fmtParser = new ST.ProtocolParser();
fmtState.attachParser(fmtParser);
HEADER.concat([
  '|poke|p1|Ursaluna, L50, M|item',
  '|poke|p2|Kingambit, L50, M|item',
  '|start',
  '|switch|p1a: Ursaluna|Ursaluna, L50, M|100/100',
  '|switch|p2a: Kingambit|Kingambit, L50, M|100/100',
  '|turn|1',
  '|-boost|p2a: Kingambit|atk|1'
]).forEach(function (l) { fmtParser.feed(l); });
fmtParser.feed('|format|[Gen 9] National Dex OU');
eq('a bare |format| does not clear the board', (fmtState.state.oppTeam || []).length, 1);
eq('and does not clear the boosts either', fmtState.state.oppTeam[0].boosts.atk, 1);
eq('but it still applies the format', /national\s*dex/i.test(fmtState.state.format || ''), true);

/* And a THIRD init must behave like the second. */
feedReconnect(HEADER.concat([
  '|poke|p1|Ursaluna, L50, M|item',
  '|poke|p2|Dragapult, L50, M|item',
  '|start',
  '|switch|p1a: Ursaluna|Ursaluna, L50, M|100/100',
  '|switch|p2a: Dragapult|Dragapult, L50, M|100/100',
  '|turn|1'
]));
eq('a third battle is clean too',
  (reconnectState.state.oppTeam || []).map(function (m) { return m.species; }), ['Dragapult']);

/* =========================================== 11. randomized invariant fuzz */

section('11. randomized streams must not break any solver invariant');

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const OPP_SPECIES = ['Kingambit', 'Ursaluna', 'Crawdaunt', 'Hatterene', 'Abomasnow', 'Slowking-Galar',
  'Great Tusk', 'Iron Valiant', 'Gholdengo', 'Dragapult'];
const MY_SPECIES = ['Abomasnow', 'Hatterene', 'Crawdaunt', 'Ursaluna', 'Kingambit', 'Toxapex', 'Tapu Lele'];
const MOVES = ['Kowtow Cleave', 'Iron Head', 'Sucker Punch', 'Headlong Rush', 'Facade', 'Blizzard',
  'Ice Shard', 'Earthquake', 'Crabhammer', 'Knock Off', 'Dazzling Gleam', 'Psychic', 'Moonblast',
  'Sacred Sword', 'Trick Room', 'Protect', 'Stealth Rock', 'Sludge Bomb'];
const WEATHERS = ['', '', 'rain', 'sun', 'snow', 'sandstorm'];
const TERRAINS = ['', '', '', 'electric', 'psychic', 'grassy'];

/** A random but protocol-legal battle: switches, moves, damage, status, faints, TR, hazards. */
function randomStream(rand) {
  const pick = function (arr) { return arr[Math.floor(rand() * arr.length) % arr.length]; };
  const lines = [];
  const oppTeam = [];
  const myTeam = [];
  const n = 2 + Math.floor(rand() * 4);
  while (oppTeam.length < n) {
    const sp = pick(OPP_SPECIES);
    if (oppTeam.indexOf(sp) === -1) oppTeam.push(sp);
  }
  const mySlots = MY_SPECIES.slice(0, 3 + Math.floor(rand() * 4));
  myTeam.push.apply(myTeam, mySlots);
  myTeam.forEach(function (sp, i) {
    lines.push('|switch|p1' + 'abcd'[i] + ': ' + sp + '|' + sp + ', L50, M|100/100');
  });
  oppTeam.forEach(function (sp, i) {
    lines.push('|switch|p2' + 'abcd'[i] + ': ' + sp + '|' + sp + ', L50, M|100/100');
  });
  const weather = pick(WEATHERS);
  const terrain = pick(TERRAINS);
  const turns = 2 + Math.floor(rand() * 6);
  for (let t = 1; t <= turns; t++) {
    lines.push('|turn|' + t);
    if (rand() < 0.25) lines.push('|move|p1a: ' + myTeam[0] + '|Trick Room|p1a: ' + myTeam[0]);
    if (rand() < 0.2) lines.push('|-fieldstart|move: Trick Room|[of] p1a: ' + myTeam[0]);
    if (rand() < 0.2) lines.push('|-fieldend|move: Trick Room');
    if (rand() < 0.2) lines.push('|-sidestart|p2: ' + oppTeam[0] + '|move: Stealth Rock');
    if (weather) lines.push('|-weather|' + weather.charAt(0).toUpperCase() + weather.slice(1));
    if (terrain) lines.push('|-terrain|' + terrain.charAt(0).toUpperCase() + terrain.slice(1) + ' Terrain');
    const mine = myTeam[Math.floor(rand() * myTeam.length) % myTeam.length];
    const theirs = oppTeam[Math.floor(rand() * oppTeam.length) % oppTeam.length];
    const myMove = pick(MOVES);
    const theirMove = pick(MOVES);
    lines.push('|move|p1a: ' + mine + '|' + myMove + '|p2a: ' + theirs);
    if (rand() < 0.7) lines.push('|-damage|p2a: ' + theirs + '|' + (5 + Math.floor(rand() * 90)) + '/100');
    if (rand() < 0.3) lines.push('|-status|p2a: ' + theirs + '|' + pick(['brn', 'tox', 'par', 'slp']));
    if (rand() < 0.3) lines.push('|-boost|p1a: ' + mine + '|' + pick(['atk', 'spa', 'spe', 'def']) + '|' + (1 + Math.floor(rand() * 2)));
    if (rand() < 0.3) lines.push('|-enditem|p2a: ' + theirs + '|' + pick(['Leftovers', 'Choice Band', 'Flame Orb']));
    lines.push('|move|p2a: ' + theirs + '|' + theirMove + '|p1a: ' + mine);
    if (rand() < 0.7) lines.push('|-damage|p1a: ' + mine + '|' + (5 + Math.floor(rand() * 90)) + '/100');
    if (rand() < 0.25) lines.push('|-damage|p1a: ' + mine + '|0 fnt');
    if (rand() < 0.25) lines.push('|faint|p1a: ' + mine);
    if (rand() < 0.2) lines.push('|-heal|p1a: ' + mine + '|' + (50 + Math.floor(rand() * 40)) + '/100');
  }
  return lines;
}

let fuzzFailures = [];
let fuzzStates = 0;
let fuzzActions = 0;
const SEEDS = 40;
for (let s = 1; s <= SEEDS; s++) {
  const rand = mulberry32(1000 + s);
  const lines = randomStream(rand);
  let built;
  try {
    built = pipeline(lines);
  } catch (err) {
    fuzzFailures.push('seed ' + s + ': pipeline threw ' + err.message);
    continue;
  }
  const battle = built.battle;
  fuzzStates++;
  const eng = newEngine();
  let ranked, rankedAgain;
  try {
    ranked = eng.engine.evaluateTurn(battle, { K: 3 });
    rankedAgain = eng.engine.evaluateTurn(battle, { K: 3 });
  } catch (err) {
    fuzzFailures.push('seed ' + s + ': evaluateTurn threw ' + err.message);
    continue;
  }
  if (!ranked || !ranked.length) { fuzzFailures.push('seed ' + s + ': no lines returned'); continue; }
  fuzzActions += ranked.length;
  const live = ranked.filter(function (r) { return !r.isVetoed; });
  if (!ranked.every(function (r) { return finite(r.score) && finite(r.confidence) && r.confidence >= 0 && r.confidence <= 100; })) {
    fuzzFailures.push('seed ' + s + ': non-finite score/confidence ' + JSON.stringify(ranked.slice(0, 2)));
  }
  if (live.length && Math.abs(live.reduce(function (a, r) { return a + r.confidence; }, 0) - 100) > 2) {
    fuzzFailures.push('seed ' + s + ': live confidences do not sum to 100');
  }
  const sig = function (list) { return JSON.stringify(list.map(function (r) { return [r.kind, r.moveId || r.targetId, r.confidence]; })); };
  if (sig(ranked) !== sig(rankedAgain)) fuzzFailures.push('seed ' + s + ': not deterministic across two runs');
  const myActive = battle.active && battle.active.my;
  const knownMoves = myActive ? (myActive.setMoves || myActive.revealedMoves || myActive.liveSet && myActive.liveSet.moves || []).map(U.toID) : [];
  ranked.forEach(function (r) {
    if (r.kind === 'move' || r.kind === 'protect') {
      if (knownMoves.length && r.moveId && knownMoves.indexOf(r.moveId) === -1) {
        fuzzFailures.push('seed ' + s + ': illegal move ' + r.moveId + ' for ' + (myActive && myActive.species));
      }
    } else if (r.kind === 'switch') {
      const target = (battle.myTeam || []).find(function (m) { return m && U.toID(m.species) === U.toID(r.targetId); });
      if (!target || target.fainted) fuzzFailures.push('seed ' + s + ': switch to a dead/absent mon ' + r.targetId);
    } else {
      fuzzFailures.push('seed ' + s + ': unknown action kind ' + r.kind);
    }
  });
  const readout = eng.engine.lastReadout;
  if (!readout || !finite(readout.elapsedMs) || readout.elapsedMs < 0) {
    fuzzFailures.push('seed ' + s + ': bad readout ' + JSON.stringify(readout && readout.elapsedMs));
  }
  // The state itself must stay legal after an arbitrary stream.
  const bad = [];
  ['myTeam', 'oppTeam'].forEach(function (side) {
    (battle[side] || []).forEach(function (m) {
      if (!m) return;
      if (!(m.hpPercent >= 0 && m.hpPercent <= 100)) bad.push(side + ' ' + m.species + ' hp=' + m.hpPercent);
      if (m.fainted && m.hpPercent > 0) bad.push(side + ' ' + m.species + ' fainted at ' + m.hpPercent);
      if (!(m.alliesFainted >= 0 && m.alliesFainted <= 5)) bad.push(side + ' ' + m.species + ' alliesFainted=' + m.alliesFainted);
    });
  });
  if (bad.length) fuzzFailures.push('seed ' + s + ': illegal state ' + bad.join('; '));
}
eq('all ' + SEEDS + ' random battles kept every solver invariant', fuzzFailures.slice(0, 5), []);
check('the fuzz actually exercised the solver', fuzzStates >= SEEDS && fuzzActions > 100,
  'states=' + fuzzStates + ' actions=' + fuzzActions);

section('12. calculator and inference audit regressions');
{
  const damage = new ST.DamageEngine();
  const mew = { species: 'Mew', ability: 'Synchronize', hp: 100, hpPercent: 100 };
  const ice = { species: 'Glaceon', ability: 'Ice Body', hp: 100 };
  const clear = damage.calculateDamage(mew, ice, 'Body Slam', {});
  const snow = damage.calculateDamage(mew, ice, 'Body Slam', { weather: 'snow' });
  eq('snow applies Ice Defense at the calculator boundary', [clear.minDmg, clear.maxDmg, snow.minDmg, snow.maxDmg], [56, 67, 38, 45]);
  eq('snow leaves ordinary special damage alone', damage.calculateDamage(mew, ice, 'Psychic', {}).minDmg,
    damage.calculateDamage(mew, ice, 'Psychic', { weather: 'snow' }).minDmg);
  check('snow also modifies Psyshock Defense', damage.calculateDamage(mew, ice, 'Psyshock', { weather: 'snow' }).maxDmg < damage.calculateDamage(mew, ice, 'Psyshock', {}).minDmg);
  for (const mySide of ['p1', 'p2']) {
    const oppSide = mySide === 'p1' ? 'p2' : 'p1';
    const screens = { screens: { [mySide]: { reflect: true, lightscreen: true } } };
    for (const move of ['Earthquake', 'Psychic']) {
      const theirs = Object.assign({}, mew, { side: oppSide, setMoves: [move] });
      const ours = Object.assign({}, mew, { side: mySide });
      const reference = damage.calculateDamage(theirs, ours, move, screens, { attackerIsP1: oppSide === 'p1' });
      eq('incoming ' + move + ' respects screens for ' + mySide, damage.getBestIncomingThreat(theirs, ours, screens).maxDmg, reference.maxDmg);
    }
  }
  const tusk = { species: 'Great Tusk', ability: 'Protosynthesis', boosterActive: true, boostedStat: 'atk', itemConsumed: true, evs: { atk: 252 }, nature: 'Adamant' };
  eq('consumed Booster Energy preserves the proven Attack boost', damage.calculateDamage(tusk, mew, 'Headlong Rush', {}).maxDmg, 333);
  eq('unknown boosted stat is resolved from the actual spread', damage.calculateDamage(Object.assign({}, tusk, { boostedStat: null }), mew, 'Headlong Rush', {}).maxDmg, 333);
  check('ending the paradox boost invalidates the cached damage', damage.calculateDamage(Object.assign({}, tusk, { boosterActive: false }), mew, 'Headlong Rush', {}).maxDmg < 333);
  const heatran = { species: 'Heatran', ability: 'Flash Fire', abilityOn: true };
  eq('activated Flash Fire is forwarded', damage.calculateDamage(heatran, mew, 'Flamethrower', {}).maxDmg, 216);
  check('inactive Flash Fire has a different cache entry', damage.calculateDamage(Object.assign({}, heatran, { abilityOn: false }), mew, 'Flamethrower', {}).maxDmg < 216);
  const lycanroc = { species: 'Lycanroc', ability: 'Sand Rush', item: 'Lycanium Z' };
  const normal = damage.calculateDamage(lycanroc, mew, 'Stone Edge', {});
  const zCrystal = damage.calculateDamage(lycanroc, mew, 'Stone Edge', {}, { zCrystal: 'Lycanium Z' });
  eq('signature Z crystal changes the move after a normal cache entry', zCrystal.maxDmg, 271);
  check('signature Z damage exceeds the base move', zCrystal.minDmg > normal.maxDmg);
  eq('useZ also inherits the actual held crystal', damage.calculateDamage(lycanroc, mew, 'Stone Edge', {}, { useZ: true }).maxDmg, zCrystal.maxDmg);
  eq('fixed damage remains available to incoming threat checks', damage.getBestIncomingThreat({ species: 'Blissey', setMoves: ['Seismic Toss'] }, mew, {}).maxDmg, 100);
  const unreliable = damage.calculateDamage(Object.assign({}, mew, { boosts: { spa: 2 } }), Object.assign({}, mew, { item: 'Leftovers' }), 'Fire Blast', {});
  check('a low-probability two-hit KO is not labelled guaranteed', !unreliable.is2HKO && unreliable.twoHitChancePct > 0 && unreliable.twoHitChancePct < 10, JSON.stringify(unreliable));
  const engine = new ST.LaplaceEngine({ damage: damage });
  eq('endgame search classifies fixed damage as an attack', engine.endgame._classifyMove('Seismic Toss'), 'attack');
  const target = { species: 'Mimikyu', ability: 'Disguise', disguiseIntact: true, hp: 100, hpPercent: 100 };
  const drill = { species: 'Excadrill', ability: 'Mold Breaker', evs: { atk: 252 }, hp: 100 };
  const previewState = { active: { my: drill, opp: target }, field: {}, legalActions: { moves: [{ name: 'Iron Head' }] } };
  check('Mold Breaker preview bypasses Disguise', engine.preview(target, previewState).lines[0].minPercent > 100);
  eq('intact Disguise blocks an ordinary single hit centrally', damage.calculateDamage(mew, target, 'Psychic', {}).maxDmg, 0);
  const multi = damage.calculateDamage({ species: 'Cinccino', ability: 'Skill Link' }, target, 'Bullet Seed', {});
  const multiOpen = damage.calculateDamage({ species: 'Cinccino', ability: 'Skill Link' }, Object.assign({}, target, { disguiseIntact: false }), 'Bullet Seed', {});
  check('later multihit strikes get through Disguise', multi.minDmg > 0 && multi.maxDmg < multiOpen.maxDmg);
  const tr = new ST.TrickRoomEngine();
  for (const [move, priority] of [['Fake Out', 3], ['Feint', 2], ['First Impression', 2], ['Payback', 0], ['Metal Burst', 0]]) {
    eq(move + ' has its real priority', tr.moveBracket(move), priority);
  }
}
{
  const damage = new ST.DamageEngine();
  const sampler = new ST.WorldSampler();
  const base = { species: 'Kingambit', id: 'kingambit', side: 'p2', isActive: true, hp: 100, hpPercent: 80, alliesFainted: 5, typeOverride: ['Water'], boostedStat: 'atk', abilityOn: true, disguiseIntact: true };
  const set = { species: 'Kingambit', ability: 'Supreme Overlord', item: 'Choice Band', nature: 'Adamant', evs: { atk: 252 }, moves: ['Kowtow Cleave'] };
  const sampled = sampler._monFromSet(base, set, 0);
  eq('sampled worlds retain the recorded battle state', [sampled.hpPercent, sampled.alliesFainted, sampled.typeOverride, sampled.boostedStat, sampled.abilityOn, sampled.disguiseIntact], [80, 5, ['Water'], 'atk', true, true]);
  check('sampled typing is copied independently', sampled.typeOverride !== base.typeOverride);
  const my = { species: 'Mew', side: 'p1', hp: 100, hpPercent: 100, ability: 'Synchronize' };
  const live = { species: 'Garchomp', id: 'garchomp', side: 'p2', hp: 100, isActive: true, item: '', evs: { atk: 0 }, ability: 'Rough Skin' };
  const state = { active: { my: my, opp: live }, myTeam: [my], oppTeam: [live], field: {}, mySide: 'p1', oppSide: 'p2' };
  const calls = [];
  const engine = new ST.LaplaceEngine({ evaluator: { evaluate: function () { return 0; } }, damage: { calculateDamage: function (a, d, m, f, o) { calls.push([a.item, a.evs && a.evs.atk, d.item]); return damage.calculateDamage(a, d, m, f, o); } } });
  for (const item of ['Choice Band', 'Choice Scarf']) {
    calls.length = 0;
    const mon = sampler._monFromSet(live, { species: 'Garchomp', ability: 'Rough Skin', item: item, evs: { atk: 252 }, moves: ['Earthquake'] }, 0);
    engine._payoff({ kind: 'move', name: 'Psychic' }, { kind: 'move', name: 'Earthquake' }, state, state.field, { team: [mon] });
    check('main payoff reads the ' + item + ' world', calls.some(function (c) { return c[0] === item && c[1] === 252; }), JSON.stringify(calls));
  }
  eq('world evaluation leaves the live item alone', live.item, '');
  const eg = new ST.EndgameSolver({ damage: damage, evaluator: { evaluate: function () { return 0; } } });
  const weak = { species: 'Pikachu', hp: 1, hpPercent: 1, isActive: true };
  const node = eg._nodeFrom({ active: { my: my, opp: weak }, myTeam: [my], oppTeam: [weak, { species: 'Blissey', hp: 100 }], field: {} }, null);
  const after = eg._applyPair(node, { kind: 'attack', name: 'Psychic' }, { kind: 'attack', name: 'Thunderbolt' }, 'my');
  eq('replacement cannot execute the fainted actor move', after.my.bodies[0].hp, 100);
  eq('the fainted actor is still fainted', after.opp.bodies[0].hp, 0);
  eq('pair resolution leaves the original node intact', node.opp.bodies[0].hp, 1);
}
{
  const manager = new ST.BattleStateManager();
  const parser = new ST.ProtocolParser();
  manager.attachParser(parser);
  const feed = function (lines) { lines.forEach(function (line) { parser.feed(line); }); };
  feed(['|switch|p1a: Mew|Mew|100/100', '|switch|p2a: Garchomp|Garchomp|100/100', '|turn|1', '|move|p2a: Garchomp|Earthquake|p1a: Mew', '|-damage|p1a: Mew|65/100']);
  const my = manager.state.active.my, foe = manager.state.active.opp;
  eq('ordinary native damage produces an observation', foe.damageDealt.length, 1);
  eq('native damage is attributed to the preceding attack', foe.damageDealt[0].moveName, 'Earthquake');
  eq('native damage keeps the pre-hit defender HP', foe.damageDealt[0].defenderSnapshot.hpPercent, 100);
  parser.feed('|-damage|p1a: Mew|65/100');
  eq('identical split/poll HP frames do not duplicate evidence', foe.damageDealt.length, 1);
  parser.feed('|-damage|p1a: Mew|59/100|[from] brn');
  eq('residual damage does not become attack evidence', foe.damageDealt.length, 1);
  const obs = foe.damageDealt[0];
  manager.state.field.screens.p1.reflect = true;
  my.item = 'Assault Vest'; my.boosts.def = 6;
  eq('historical field is independent of the current screen', !!obs.fieldSnapshot.screens.p1.reflect, false);
  eq('historical defender retains its original boosts', obs.defenderSnapshot.boosts.def, 0);
  feed(['|turn|2', '|move|p2a: Garchomp|Earthquake|p1a: Mew', '|-crit|p1a: Mew', '|-damage|p1a: Mew|40/100']);
  check('critical hits remain flagged', foe.damageDealt[1].crit);
  feed(['|move|p2a: Garchomp|Earthquake|p1a: Mew', '|-damage|p1a: Mew|20/100']);
  check('another hit in the same turn does not inherit the critical flag', !foe.damageDealt[2].crit);
  feed(['|turn|3', '|move|p2a: Garchomp|Earthquake|p1a: Mew', '|-damage|p1a: Mew|0 fnt']);
  check('KO damage records its censored measurement', foe.damageDealt[3].censored);
  const damage = new ST.DamageEngine(), pruner = new ST.ArchetypePruner({ damage: damage });
  const set = { species: 'Mew', ability: 'Synchronize', evs: { spa: 252 }, nature: 'Modest' };
  const defender = { species: 'Mew', ability: 'Synchronize' };
  const range = damage.calculateDamage(set, defender, 'Flamethrower', {});
  const observation = { moveName: 'Flamethrower', damagePercent: range.maxPercent, hpBefore: 100, defenderBoosts: {}, defenderStatus: '', weather: '', terrain: '', attackerIsP1: true, fieldSnapshot: {}, defenderSnapshot: defender };
  eq('historical clear weather overrides present rain', pruner._damageVerdict(set, observation, defender, { field: { weather: 'rain' } }), null);
  eq('legacy clear-weather observation also clears present rain', pruner._damageVerdict(set, Object.assign({}, observation, { fieldSnapshot: null }), defender, { field: { weather: 'rain' } }), null);
  const boostedSet = Object.assign({}, set, { boosts: { spa: 2 } });
  const boostedRange = damage.calculateDamage(boostedSet, defender, 'Flamethrower', {});
  const boostedObservation = Object.assign({}, observation, { damagePercent: boostedRange.maxPercent, attackerSnapshot: { boosts: { spa: 2 } } });
  eq('damage pruning uses the attacker boosts recorded at impact', pruner._damageVerdict(set, boostedObservation, defender, { field: {} }), null);
  feed(['|switch|p2a: Heatran|Heatran|100/100', '|-activate|p2a: Heatran|ability: Flash Fire']);
  check('the real activation frame enables Flash Fire', manager.state.active.opp.abilityOn);
  feed(['|switch|p2a: Garchomp|Garchomp|100/100', '|switch|p2a: Heatran|Heatran|100/100']);
  check('switching resets Flash Fire', !manager.state.active.opp.abilityOn);
  feed(['|-start|p2a: Heatran|protosynthesisatk', '|-end|p2a: Heatran|Protosynthesis']);
  check('an ended paradox effect clears its active flag', !manager.state.active.opp.boosterActive);
}
{
  const manager = new ST.BattleStateManager(), parser = new ST.ProtocolParser(); manager.attachParser(parser);
  parser.feed('|switch|p1a: Abomasnow|Abomasnow|100/100');
  manager.state.active.my.item = 'Icy Rock';
  parser.feed('|turn|1');
  parser.feed('|-weather|Snowscape|[from] ability: Snow Warning|[of] p1a: Abomasnow');
  eq('known Icy Rock gives eight snow turns', manager.state.field.weatherTurnsLeft, 8);
  parser.feed('|-weather|Snowscape|[upkeep]'); parser.feed('|turn|2');
  eq('weather upkeep does not restart its timer', manager.state.field.weatherTurnsLeft, 7);
  parser.feed('|-weather|Snowscape|[upkeep]'); parser.feed('|turn|3');
  eq('weather continues counting down', manager.state.field.weatherTurnsLeft, 6);
  parser.feed('|-weather|Rain');
  eq('an unknown setter does not imply a known duration', manager.state.field.weatherTurnsLeft, null);
  parser.feed('|turn|10');
  eq('weather waits for the observed end frame', manager.state.field.weather, 'rain');
  parser.feed('|-weather|none');
  eq('the observed weather end clears it', manager.state.field.weather, '');
}

/* ------------------------------------------------------------------ summary */

console.log('\n=== summary ===');
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failed);
console.log('fuzz: ' + fuzzStates + ' random battles, ' + fuzzActions + ' ranked actions');
if (failed) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('ALL HARDENING CHECKS PASSED');
process.exit(0);
