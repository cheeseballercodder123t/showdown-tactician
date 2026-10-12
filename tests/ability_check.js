/* Showdown Tactician — tests/ability_check.js
 *
 * The negative-space ABILITY deduction (src/set_pruner.js + the rule tables in src/util.js).
 *
 * WHY THIS EXISTS
 *   The pruner has always narrowed the opponent's candidate sets by ITEM and MOVE. Abilities were
 *   only ever used one way: a REVEALED ability disproved the sets that name a different one. That
 *   leaves the opposite direction unclaimed, and it is the stronger evidence — an ability that
 *   makes a status impossible cannot be held by a body that is carrying that status, and a body
 *   that took damage only a grounded body can take is not Levitating. These checks drive real
 *   protocol lines through the real parser and state manager and then prune a controlled pool, so
 *   they measure the rule, not the fixture.
 *
 *   The gated family is pinned too: absence-of-evidence (a switch-in ability that never fired) ships
 *   OFF, and a check asserts it stays off, because Neutralizing Gas can silence the announcement
 *   and the repo does not eliminate on a guess.
 *
 * Run me with:  node tests/ability_check.js
 */
'use strict';

const H = require('./harness.js');
// content.js auto-boots on the harness's stubbed hostname and starts a heartbeat; stub the timer so
// this process can exit (the same stub every sandboxed suite uses).
const S = H.loadAll({
  setInterval: function () { return 0; },
  clearInterval: function () { }
});
const ST = S.ST;
const U = ST.util;

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail === undefined ? '' : '  ->  ' + detail));
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got) + ' != ' + JSON.stringify(want));
}

/* A battle state with a parser but NO pruner: the pooling below is driven by hand so an assertion
 * measures the rule and nothing else. */
function boot() {
  const state = new ST.BattleStateManager();
  const parser = new ST.ProtocolParser();
  state.attachParser(parser);
  state.setFormat('[Gen 9] National Dex OU');
  return { state: state, parser: parser, st: state.state };
}
const HEADER = [
  '|init|[Gen 9] National Dex',
  '|player|p1|Me|1|1500',
  '|player|p2|Foe|2|1480',
  '|teamsize|p1|6',
  '|teamsize|p2|6',
  '|start'
];
function feed(b, lines) { b.parser.feedAll(HEADER.concat(lines).join('\n')); }

/** A candidate set with just the fields the pruner reads in these checks. */
function set(id, ability, item) {
  return { id: id, species: 'Probe', ability: ability, item: item || 'Leftovers', moves: ['Surf'], weight: 1 };
}

/* ---------------------------------------------------- 0. the rules and the switches */

console.log('\n=== 0. rule tables + config switches ===');

const cfgK = function (p) { return ST.configGet(p, undefined); };
eq('config: master switch ships ON', cfgK('pruner.abilityDeduction.enabled'), true);
eq('config: status rules ship ON', cfgK('pruner.abilityDeduction.statusRules'), true);
eq('config: ground rules ship ON', cfgK('pruner.abilityDeduction.groundRules'), true);
eq('config: absence rules ship OFF (the unmeasured inference)', cfgK('pruner.abilityDeduction.absenceRules'), false);

ok('burn is blocked by Water Veil', U.abilitiesBlockingStatus('brn').has('waterveil'));
ok('burn is blocked by Thermal Exchange', U.abilitiesBlockingStatus('brn').has('thermalexchange'));
ok('sleep is blocked by Insomnia', U.abilitiesBlockingStatus('slp').has('insomnia'));
ok('sleep is blocked by Sweet Veil', U.abilitiesBlockingStatus('slp').has('sweetveil'));
ok('paralysis is blocked by Limber', U.abilitiesBlockingStatus('par').has('limber'));
ok('an unconditional immunity is in every bucket',
  U.abilitiesBlockingStatus('brn').has('comatose') && U.abilitiesBlockingStatus('tox').has('comatose') &&
  U.abilitiesBlockingStatus('slp').has('comatose') && U.abilitiesBlockingStatus('par').has('purifyingsalt'));
eq('an unknown status blocks nothing', U.abilitiesBlockingStatus('').size, 0);
eq('an unrecognised status blocks nothing', U.abilitiesBlockingStatus('zzz').size, 0);
ok('Levitate is a Ground-immune ability', U.GROUND_IMMUNE_ABILITIES.has('levitate'));
ok('Earth Eater is a Ground-immune ability', U.GROUND_IMMUNE_ABILITIES.has('eartheater'));
ok('Intimidate is a switch-in trigger', U.SWITCH_IN_TRIGGER_ABILITIES.has('intimidate'));
ok('Drizzle is a switch-in trigger', U.SWITCH_IN_TRIGGER_ABILITIES.has('drizzle'));
ok('Electric Surge is a switch-in trigger', U.SWITCH_IN_TRIGGER_ABILITIES.has('electricsurge'));

/* ------------------------------------------------------- 1. status disproves an ability */

console.log('\n=== 1. a status condition disproves the abilities that block it ===');

{
  const b = boot();
  feed(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1',
    '|-status|p2a: Probe|brn'
  ]);
  const mon = b.st.oppTeam[0];
  eq('the burn landed on the opponent', mon.status, 'brn');
  eq('the turn it landed is stamped', mon.statusTurn, 1);

  mon.candidateSets = [set('wv', 'Water Veil'), set('guts', 'Guts')];
  const pruner = new ST.ArchetypePruner();
  const survivors = pruner.prune(mon, b.st);
  eq('the Water Veil set is eliminated', survivors.map(function (s) { return s.id; }), ['guts']);
  ok('and the trail says why',
    (mon.prunedReasons || []).join(' ').indexOf('Ability disproved (Water Veil)') !== -1,
    JSON.stringify(mon.prunedReasons));
}

{
  // The rules are read at LOAD time, so the control surface is configMerge — and configMerge is a
  // ONE-LEVEL section merge: switching a nested family means passing the whole sub-object, which is
  // worth pinning because it is exactly the mistake a power user makes.
  const off = H.loadAll({ setInterval: function () { return 0; }, clearInterval: function () { } });
  off.ST.configMerge({
    pruner: { abilityDeduction: { enabled: true, statusRules: false, groundRules: true, absenceRules: false } }
  });
  eq('a merge can switch the status family off', off.ST.configGet('pruner.abilityDeduction.statusRules'), false);
  eq('...leaving the master switch on', off.ST.configGet('pruner.abilityDeduction.enabled'), true);
  eq('...and the sibling families untouched', off.ST.configGet('pruner.abilityDeduction.groundRules'), true);
  ok('the loaded pruner still reads the pinned defaults from the shipped config',
    ST.configGet('pruner.abilityDeduction.absenceRules', null) === false);
}

{
  // Never leave an empty pool: if EVERY candidate is disproved the raw pool comes back with the
  // documented fallback reason, which is the pruner's contract (not a licence to admit the rule
  // was wrong).
  const b = boot();
  feed(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1',
    '|-status|p2a: Probe|brn'
  ]);
  const mon = b.st.oppTeam[0];
  mon.candidateSets = [set('wv1', 'Water Veil'), set('wv2', 'Thermal Exchange')];
  const pruner = new ST.ArchetypePruner();
  const survivors = pruner.prune(mon, b.st);
  eq('an all-disproved pool falls back to the raw pool', survivors.length, 2);
  ok('and says it fell back',
    (mon.prunedReasons || []).join(' ').indexOf('falling back') !== -1,
    JSON.stringify(mon.prunedReasons));
}

/* ---------------------------------------------- 2. grounded-only damage disproves Levitate */

console.log('\n=== 2. grounded-only damage disproves Levitate / Earth Eater ===');

{
  const b = boot();
  feed(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1',
    '|-sidestart|p2: Foe|Spikes',
    '|-damage|p2a: Probe|88/100|[from] Spikes'
  ]);
  const mon = b.st.oppTeam[0];
  eq('Spikes damage marks the body as grounded', mon.groundDisproved, true);

  mon.candidateSets = [set('lev', 'Levitate'), set('static', 'Static')];
  const pruner = new ST.ArchetypePruner();
  const survivors = pruner.prune(mon, b.st);
  eq('the Levitate set is eliminated', survivors.map(function (s) { return s.id; }), ['static']);
}

{
  // Gravity grounds everyone and negates Levitate, so the SAME observation proves nothing there.
  const b = boot();
  feed(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1',
    '|-sidestart|p2: Foe|Spikes',
    '|-damage|p2a: Probe|88/100|[from] Spikes'
  ]);
  b.st.field.gravity = true;
  const mon = b.st.oppTeam[0];
  mon.candidateSets = [set('lev', 'Levitate'), set('static', 'Static')];
  const pruner = new ST.ArchetypePruner();
  const survivors = pruner.prune(mon, b.st);
  eq('under Gravity the Levitate set survives', survivors.length, 2);
}

{
  // A GROUND MOVE that CONNECTS is the other grounding proof — and a miss must prove nothing, which
  // is what the turn stamp on the aim is for.
  const hit = boot();
  feed(hit, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1',
    '|move|p1a: Great Tusk|Earthquake|p2a: Probe',
    '|-damage|p2a: Probe|70/100'
  ]);
  eq('a connecting Earthquake marks the target grounded', hit.st.oppTeam[0].groundDisproved, true);

  const miss = boot();
  feed(miss, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1',
    '|move|p1a: Great Tusk|Earthquake|p2a: Probe',
    '|-miss|p1a: Great Tusk|p2a: Probe',
    '|turn|2',
    // A LATER, unrelated hit must not be mistaken for the Ground move that missed.
    '|move|p2a: Probe|Surf|p1a: Great Tusk',
    '|-damage|p1a: Great Tusk|80/100'
  ]);
  eq('a missed Earthquake disproves nothing', miss.st.oppTeam[0].groundDisproved, false);

  const statusMove = boot();
  feed(statusMove, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1',
    // Spikes is a Ground-type STATUS move: it does not touch the target, so it proves nothing about
    // whether that target is airborne.
    '|move|p1a: Great Tusk|Spikes|p2: Foe',
    '|turn|2',
    '|move|p2a: Probe|Surf|p1a: Great Tusk',
    '|-damage|p1a: Great Tusk|80/100'
  ]);
  eq('a Ground STATUS move proves nothing', statusMove.st.oppTeam[0].groundDisproved, false);
}

{
  // End to end on a real curated pool: Bronzong is Levitate / Heatproof, so grounding it must leave
  // no Levitate set standing (or, if the database has none, change nothing — asserted as "no
  // Levitate survives", which holds either way).
  const b = boot();
  feed(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Bronzong|Bronzong, L50, M|100/100',
    '|turn|1',
    '|-sidestart|p2: Foe|Spikes',
    '|-damage|p2a: Bronzong|88/100|[from] Spikes'
  ]);
  const mon = b.st.oppTeam[0];
  const pruner = new ST.ArchetypePruner();
  const survivors = pruner.prune(mon, b.st);
  const trail = (mon.prunedReasons || []).join(' ');
  ok('Bronzong: the grounding rule fired on a real curated pool',
    trail.indexOf('Ability disproved (Levitate)') !== -1, trail);
  // If the curated database lists ONLY Levitate sets for the species, every candidate is disproved
  // and the pruner's contract kicks in: fall back to the raw pool and SAY SO. Either outcome is
  // correct; silently keeping a Levitate set alongside a drop reason would not be.
  ok('Bronzong: no Levitate set survives unless the pool had to fall back',
    trail.indexOf('falling back') !== -1 ||
      survivors.every(function (s) { return U.toID(s.ability) !== 'levitate'; }),
    JSON.stringify(survivors.map(function (s) { return s.ability; })));
}

/* ------------------------------------------------- 3. the gated absence rule stays gated */

console.log('\n=== 3. the absence rule ships off and switches on only on request ===');

{
  const b = boot();
  feed(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1'
  ]);
  const mon = b.st.oppTeam[0];
  eq('the switch-in turn is stamped for the window', mon.switchedInTurn, 1);
  eq('nothing announced an ability and none was revealed', mon.revealedAbility, null);

  mon.candidateSets = [set('inti', 'Intimidate'), set('other', 'Static')];
  const pruner = new ST.ArchetypePruner();
  const survivors = pruner.prune(mon, b.st);
  eq('a silent switch-in eliminates NOTHING while the rule is off (the default)',
    survivors.map(function (s) { return s.id; }), ['inti', 'other']);

  // The suppression guard the rule would use if it were enabled: a revealed Neutralizing Gas means
  // a missing announcement proves nothing.
  eq('no suppression is visible on a clean field', pruner._abilitySuppressed(b.st), false);
  mon.revealedAbility = 'Neutralizing Gas';
  eq('a revealed Neutralizing Gas reads as suppression', pruner._abilitySuppressed(b.st), true);
}

/* ------------------------------- 4. evidence that only LOOKS like proof (false eliminations) */

console.log('\n=== 4. unsound evidence: the rules that must NOT eliminate ===');

{
  // 4a. The burn table is a GAME RULE and has one correct value. Magma Armor prevents FREEZE only,
  // so listing it under `brn` made an ordinary burn eliminate every Magma Armor set.
  eq('Magma Armor is NOT a burn immunity', U.abilitiesBlockingStatus('brn').has('magmaarmor'), false);
  eq('...but it IS the freeze immunity', U.abilitiesBlockingStatus('frz').has('magmaarmor'), true);
  eq('Water Veil IS a burn immunity', U.abilitiesBlockingStatus('brn').has('waterveil'), true);
  eq('...and so is Water Bubble', U.abilitiesBlockingStatus('brn').has('waterbubble'), true);

  const b = boot();
  feed(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1',
    '|-status|p2a: Probe|brn'
  ]);
  const mon = b.st.oppTeam[0];
  mon.candidateSets = [set('magma', 'Magma Armor'), set('static', 'Static')];
  eq('a burn does not eliminate a Magma Armor set',
    new ST.ArchetypePruner().prune(mon, b.st).map(function (s) { return s.id; }), ['magma', 'static']);
}

{
  // 4b. A Ground move that was AIMED and then MISSED, with UNRELATED damage landing in the same
  // turn. The turn stamp matches, so without the `[from]` test the burn tick reads as the move
  // connecting and Levitate is eliminated on damage that never came from a Ground move.
  const b = boot();
  feed(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1',
    '|move|p1a: Great Tusk|Earthquake|p2a: Probe',
    '|-miss|p1a: Great Tusk|p2a: Probe',
    '|-damage|p2a: Probe|94/100|[from] brn'
  ]);
  const mon = b.st.oppTeam[0];
  eq('a residual tick in the same turn is not the Ground move connecting', mon.groundDisproved, false);
  mon.candidateSets = [set('lev', 'Levitate'), set('static', 'Static')];
  eq('...so Levitate survives it',
    new ST.ArchetypePruner().prune(mon, b.st).map(function (s) { return s.id; }), ['lev', 'static']);
}

{
  // 4c. Gravity at the INSTANT of the observation, not only at prune time. `groundDisproved` is a
  // permanent latch, so a conclusion drawn while Gravity was up would outlive it.
  const b = boot();
  feed(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1',
    '|-fieldstart|move: Gravity',
    '|move|p1a: Great Tusk|Earthquake|p2a: Probe'
  ]);
  b.st.field.gravity = true;   // belt and braces: the line above is only a protocol hint
  b.parser.feedAll('|-damage|p2a: Probe|70/100');
  const mon = b.st.oppTeam[0];
  eq('a connecting Ground move under Gravity proves nothing', mon.groundDisproved, false);
  b.st.field.gravity = false;
  mon.candidateSets = [set('lev', 'Levitate'), set('static', 'Static')];
  eq('...and still proves nothing once Gravity has lifted',
    new ST.ArchetypePruner().prune(mon, b.st).map(function (s) { return s.id; }), ['lev', 'static']);
}

{
  // 4d. Mold Breaker. Its Ground move connects THROUGH Levitate, so the connection is not evidence
  // against the defender's ability. The attacker's ability is read only when it is KNOWN.
  const b = boot();
  feed(b, [
    '|switch|p1a: Excadrill|Excadrill, L50, M|100/100',
    '|-ability|p1a: Excadrill|Mold Breaker',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1',
    '|move|p1a: Excadrill|Earthquake|p2a: Probe',
    '|-damage|p2a: Probe|70/100'
  ]);
  eq('the attacker ability is known from the protocol',
    U.toID(b.st.myTeam[0].revealedAbility), 'moldbreaker');
  eq('a Mold Breaker Ground hit is not evidence about THEIR ability',
    b.st.oppTeam[0].groundDisproved, false);
  const plain = boot();
  feed(plain, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1',
    '|move|p1a: Great Tusk|Earthquake|p2a: Probe',
    '|-damage|p2a: Probe|70/100'
  ]);
  eq('...while an ordinary attacker still sets it (the guard is narrow)',
    plain.st.oppTeam[0].groundDisproved, true);
}

{
  // 4e. A status that landed while an ability-suppressing body was on the field. Neutralizing Gas
  // makes Water Veil / Thermal Exchange / Comatose / Purifying Salt inert, so the burn it allowed
  // disproves nothing — and by the time the pruner reads the state the Gas may be gone, which is why
  // the fact is stamped when the status lands.
  const b = boot();
  feed(b, [
    '|switch|p1a: Weezing-Galar|Weezing-Galar, L50, M|100/100',
    '|-ability|p1a: Weezing-Galar|Neutralizing Gas',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1',
    '|-status|p2a: Probe|brn'
  ]);
  const mon = b.st.oppTeam[0];
  eq('the status is stamped as landing under suppression', mon.statusSuppressed, true);
  mon.candidateSets = [set('wv', 'Water Veil'), set('guts', 'Guts')];
  eq('...so it does not eliminate Water Veil',
    new ST.ArchetypePruner().prune(mon, b.st).map(function (s) { return s.id; }), ['wv', 'guts']);
}

{
  // 4f. The status rule still fires with nothing suppressing (the guard is narrow).
  const b = boot();
  feed(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Probe|Probe, L50, M|100/100',
    '|turn|1',
    '|-status|p2a: Probe|brn'
  ]);
  const mon = b.st.oppTeam[0];
  eq('nothing is suppressing on a clean field', mon.statusSuppressed, false);
  mon.candidateSets = [set('wv', 'Water Veil'), set('guts', 'Guts')];
  eq('and the burn DOES eliminate Water Veil',
    new ST.ArchetypePruner().prune(mon, b.st).map(function (s) { return s.id; }), ['guts']);
}

/* ------------------------------------------------------------------- summary */

console.log('');
if (fails.length) {
  console.error('FAILED: ' + fails.length + ' of ' + (pass + fails.length) + ' checks');
  fails.forEach(function (f) { console.error('  - ' + f); });
  process.exit(1);
}
console.log('ALL ABILITY CHECKS PASSED (' + pass + ')');
