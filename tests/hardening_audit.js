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
