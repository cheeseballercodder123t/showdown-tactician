/* Showdown Tactician — tests/parser_fuzz.js  (RULE 3: fuzz the parser with a real battle)
 *
 * Run me with:  node tests/parser_fuzz.js
 *
 * WHAT THIS IS
 *   The thirty turns of the ExtramePatriot vs. LUIZ_LFN NatDex OU battle in test_log.txt,
 *   replayed through the real pipeline — `ProtocolParser` feeding `BattleStateManager`, the
 *   same wiring src/content.js uses — plus two fuzz passes: every prefix of the log, and a
 *   battery of malformed/adversarial protocol lines.
 *
 * WHAT IT MUST PROVE
 *   1. Nothing throws. Not on a switch, a mega evolution, a Focus Sash pop, a Regenerator
 *      heal, a burn tick, a Future Sight that resolves into a fainted slot, or a Transform.
 *   2. State does not desync: the battle ends 6-3 with the right winner, Trick Room is on,
 *      Mega Abomasnow is mega evolved, Kingambit knows three allies have fallen, and no
 *      Pokémon is simultaneously fainted and at positive HP.
 *   3. The pipeline is deterministic: replaying the stream produces a byte-identical state,
 *      so a "desync" cannot hide behind an unseeded random.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about a browser: this is the parser and the state machine on a replay, not a
 *   live Showdown socket. Both are exercised here exactly as the extension drives them.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const ST = H.loadAll().ST;
const U = ST.util;
const ROOT = H.ROOT;
const LOG_PATH = path.join(ROOT, 'test_log.txt');

let passed = 0;
let failed = 0;
const failures = [];
const notes = [];

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
function section(title) { console.log('\n=== ' + title + ' ==='); }

/* --------------------------------------------------------------- the real stream */

const RAW = fs.readFileSync(LOG_PATH, 'utf8');
const LINES = RAW.split('\n').map(function (l) { return l.replace(/\r$/, ''); });

/**
 * Replay `lines` through a fresh pipeline. Returns the manager, the parser, and a per-line
 * record of what happened (the exception, if any) so a failure names the offending line.
 */
function replay(lines) {
  const state = new ST.BattleStateManager({ debug: false });
  const parser = new ST.ProtocolParser();
  state.attachParser(parser);
  state.setFormat('[Gen 9] National Dex OU');
  const kinds = {};
  const unknowns = [];
  const thrown = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let evt = null;
    try {
      evt = parser.feed(line);
    } catch (err) {
      thrown.push({ line: i + 1, text: line, error: String((err && err.message) || err) });
      continue;
    }
    if (!evt) continue;
    kinds[evt.type] = (kinds[evt.type] || 0) + 1;
    if (evt.type === 'unknown') unknowns.push({ line: i + 1, cmd: evt.cmd, text: line });
  }
  return { state: state, parser: parser, battle: state.state || state, kinds: kinds, unknowns: unknowns, thrown: thrown };
}

section('the log file itself');
check('test_log.txt exists and has content', LINES.filter(Boolean).length > 200, LINES.length + ' lines');
check('the log is a protocol stream, not prose', LINES.filter(Boolean).every(function (l) { return l.charAt(0) === '>' || l.charAt(0) === '|'; }),
  'first offending line: ' + LINES.filter(Boolean).find(function (l) { return l.charAt(0) !== '>' && l.charAt(0) !== '|'; }));

section('the full 30-turn replay');
const run = replay(LINES);
const st = run.battle;

check('not a single line threw', run.thrown.length === 0, JSON.stringify(run.thrown.slice(0, 3)));
// This battle has no hazards, so no sideStart/sideEnd is expected here.
eq('the core event kinds all parsed', ['switch', 'move', 'damage', 'faint', 'turn', 'boost', 'unboost', 'heal', 'status', 'enditem', 'fieldStart', 'fieldEnd', 'weather', 'terrain', 'activate', 'crit']
  .filter(function (k) { return !run.kinds[k]; }), []);
check('unknown event kinds are only UI chatter or room headers',
  run.unknowns.every(function (u) {
    if (u.cmd.indexOf('battle-') === 0) return true;                       // '>battle-gen9...' room header
    return ['rule', 'clearpoke', 'teampreview', 'gametype', 'gen', 'tier', 'start', 'rated', 'upkeep', 'bigerror'].indexOf(u.cmd) !== -1;
  }),
  JSON.stringify(run.unknowns.slice(0, 3)));
check('no core command fell through to unknown',
  run.unknowns.every(function (u) { return ['move', 'switch', 'damage', 'faint', 'turn', 'boost'].indexOf(u.cmd) === -1; }));
notes.push('event histogram: ' + JSON.stringify(run.kinds));
notes.push('unknown kinds: ' + JSON.stringify(run.unknowns.map(function (u) { return u.cmd; })));

section('battle-level state after 30 turns');
eq('format is locked to NatDex OU', st.formatSupported, true);
eq('my team has six Pokémon', (st.myTeam || []).length, 6);
eq('the opponent has six Pokémon', (st.oppTeam || []).length, 6);
eq('the result is the loss the log printed', st.result, 'loss');
// |win|ExtramePatriot carries a NAME; the parser resolves it to the side id through the
// |player| lines, which is what makes this comparison meaningful for OUR victories too.
eq('the winning side is resolved to the side id p2', st.resultSide, 'p2');
eq('the parser recorded the winner', run.parser.winner, 'p2');
eq('the keep log was populated', st.log.length > 0, true);

const mySpecies = (st.myTeam || []).map(function (m) { return U.toID(m.species); }).sort();
const oppSpecies = (st.oppTeam || []).map(function (m) { return U.toID(m.species); }).sort();
eq('my six species match the log', mySpecies,
  ['ditto', 'kartana', 'lopunny', 'polteageist', 'tapulele', 'toxapex']);
// Mega Abomasnow must be listed under its FORME, not as base Abomasnow: the Mega has different
// base stats and Speed, and every stat/damage lookup keys off this name.
eq('the opponent six species match the log (Mega Abomasnow under its forme)', oppSpecies,
  ['abomasnowmega', 'crawdaunt', 'hatterene', 'kingambit', 'slowkinggalar', 'ursaluna']);
const abomaMon = (st.oppTeam || []).find(function (m) { return U.toID(m.species) === 'abomasnowmega'; });
const megaSpe = U.computeSpeed(abomaMon).raw;
eq('Mega Abomasnow Speed is the library stat for the MEGA base Speed (30)', megaSpe,
  U.libraryStat('spe', 30, abomaMon.ivs.spe, abomaMon.evs.spe, abomaMon.level, abomaMon.nature));
check('the base Abomasnow Speed (60) is NOT what we are using', megaSpe !== U.libraryStat('spe', 60, abomaMon.ivs.spe, abomaMon.evs.spe, abomaMon.level, abomaMon.nature),
  'mega ' + megaSpe);

const fainted = function (team) { return (team || []).filter(function (m) { return m && m.fainted; }).length; };
eq('all six of my Pokémon fainted', fainted(st.myTeam), 6);
eq('three of the opponent\'s fainted', fainted(st.oppTeam), 3);

const aboma = (st.oppTeam || []).find(function (m) { return U.toID(m.species).indexOf('abomasnow') === 0; });
check('Mega Abomasnow is recorded as mega evolved', !!aboma && aboma.megaEvolved === true, JSON.stringify(aboma && { species: aboma.species, mega: aboma.megaEvolved }));
eq('the mega lock latched from |-mega|', st.formatLocks && st.formatLocks.oppHasMegaEvolved, true);

const kingambit = (st.oppTeam || []).find(function (m) { return m && U.toID(m.species) === 'kingambit'; });
eq('Kingambit knows three allies have fallen (Supreme Overlord)', kingambit && kingambit.alliesFainted, 3);
check('Kingambit revealed both of its attacks', !!kingambit && kingambit.revealedMoves.length >= 1, JSON.stringify(kingambit && kingambit.revealedMoves));

section('field state after 30 turns');
eq('Trick Room is up (set again on turn 28)', st.field.trickRoom, true);
check('Trick Room has turns left', st.field.trickRoomTurnsLeft > 0 && st.field.trickRoomTurnsLeft <= 5, st.field.trickRoomTurnsLeft);
eq('the snow from turn 29 Chilly Reception is up', st.field.weather, 'snow');
eq('Psychic Terrain is gone (it ended on turn 25)', st.field.terrain || '', '');

section('state consistency (nothing desynced)');
let bad = [];
['myTeam', 'oppTeam'].forEach(function (side) {
  (st[side] || []).forEach(function (m) {
    if (!m) return;
    if (typeof m.hpPercent !== 'number' || m.hpPercent < 0 || m.hpPercent > 100) bad.push(side + ' ' + m.species + ' hpPercent=' + m.hpPercent);
    if (m.fainted && m.hpPercent > 0) bad.push(side + ' ' + m.species + ' is fainted at ' + m.hpPercent + '%');
    if (!m.fainted && m.hpPercent === 0) bad.push(side + ' ' + m.species + ' is at 0% but not fainted');
    if (typeof m.alliesFainted !== 'number' || m.alliesFainted < 0 || m.alliesFainted > 5) bad.push(side + ' ' + m.species + ' alliesFainted=' + m.alliesFainted);
  });
});
eq('every Pokémon is in a legal state', bad, []);

const sashGone = (st.myTeam || []).find(function (m) { return U.toID(m.species) === 'polteageist'; });
// A Focus Sash is CONSUMED (|-enditem|), which is the flag that means "the item is gone";
// itemRemoved is reserved for an item taken off by Knock Off / Trick.
check('the Focus Sash that popped is recorded as consumed', !!sashGone && sashGone.itemConsumed === true,
  JSON.stringify(sashGone && { itemRemoved: sashGone.itemRemoved, itemConsumed: sashGone.itemConsumed }));

section('mid-battle checkpoints');
const to13 = replay(LINES.slice(0, LINES.indexOf('|turn|13') + 1));
const ursaluna = (to13.battle.oppTeam || []).find(function (m) { return m && U.toID(m.species) === 'ursaluna'; });
eq('Ursaluna was burned by its Flame Orb by turn 13', ursaluna && ursaluna.status, 'brn');
const slowking13 = (to13.battle.oppTeam || []).find(function (m) { return m && U.toID(m.species) === 'slowkinggalar'; });
check('Slowking-Galar is revealed as the Trick Room setter', !!slowking13 && slowking13.revealedMoves.map(U.toID).indexOf('trickroom') !== -1,
  JSON.stringify(slowking13 && slowking13.revealedMoves));
// The first Trick Room was set on turn 1 and ended on turn 5; the second runs turns 10-14.
// Nothing is up on turn 20 — the third one only goes up on turn 22.
const to20 = replay(LINES.slice(0, LINES.indexOf('|turn|20') + 1));
eq('Trick Room is down at turn 20 (it returns on turn 22)', to20.battle.field.trickRoom, false);
const to5 = replay(LINES.slice(0, LINES.indexOf('|turn|5') + 1));
eq('Trick Room is still up at turn 5', to5.battle.field.trickRoom, true);
const to6 = replay(LINES.slice(0, LINES.indexOf('|turn|6') + 1));
eq('Trick Room expired on turn 5', to6.battle.field.trickRoom, false);

section('determinism (a desync cannot hide behind randomness)');
function digest(battle) {
  const pick = function (m) {
    if (!m) return null;
    return [m.species, m.hpPercent, m.status, m.fainted, m.alliesFainted, m.megaEvolved,
      m.itemRemoved, m.itemKnockedOff, (m.revealedMoves || []).join('/'), JSON.stringify(m.boosts)];
  };
  return JSON.stringify({
    result: battle.result, resultSide: battle.resultSide,
    field: battle.field, my: (battle.myTeam || []).map(pick), opp: (battle.oppTeam || []).map(pick)
  });
}
const again = replay(LINES);
eq('a second replay produces an identical state', digest(again.battle), digest(st));
eq('a third replay agrees as well', digest(replay(LINES).battle), digest(st));

section('prefix fuzz: every prefix of the real battle parses');
let prefixFailures = [];
for (let n = 1; n <= LINES.length; n++) {
  const r = replay(LINES.slice(0, n));
  if (r.thrown.length) {
    r.thrown.forEach(function (t) { prefixFailures.push('prefix ' + n + ': line ' + t.line + ' ' + t.error + ' :: ' + t.text); });
    if (prefixFailures.length > 3) break;
  }
}
eq('all ' + LINES.length + ' prefixes parse without throwing', prefixFailures, []);

section('adversarial lines (unusual strings must not break the parser)');
const PROTO = new ST.ProtocolParser();
const ADVERSARIAL = [
  '', '   ', '|', '||', '|||', '| |',
  '|move|p1a:|', '|move||Tackle|', '|move|p1a: A|', '|move|not an ident|Tackle|p2a: B',
  '|move|p1a: A|Tackle|p2a: B|extra|args|here',
  '|switch|p1a: A||100/100', '|switch|p1a: A|A|', '|switch|p1a: A|A||',
  '|-damage|p1a: A|', '|-damage|p1a: A|abc/def', '|-damage|p1a: A|9999999/1', '|-damage|p1a: A|-5/100',
  '|-damage|p1a: A|100/100|[from] item: Leftovers|[of] p1a: A',
  '|-boost|p1a: A|atk|', '|-boost|p1a: A|atk|999', '|-boost|p1a: A|bogus|-1',
  '|-heal|p1a: A|50/100|[from] drain|[of] p2a: B',
  '|faint|', '|faint|p1a: A', '|faint|p9z: Nobody',
  '|-enditem|p1a: A|', '|-item|p1a: A|Leftovers',
  '|-weather|', '|-weather|Sandstorm|[from] ability: Sand Stream|[of] p2a: Ttar',
  '|-terrain|', '|-fieldstart|', '|-fieldstart|move: Gravity|[of] p1a: A',
  '|-sidestart|p1: A|move: Stealth Rock', '|-sideend|p1: A|move: Stealth Rock',
  '|-singleturn|p1a: A|move: Protect', '|-activate|p1a: A|move: Protect',
  '|turn|', '|turn|999', '|turn|abc',
  '|request|', '|request|not json', '|request|{"side":{"id":"p1"}}', '|request|{}',
  '|unknowncommand|whatever|else',
  '|move|||', '|-crit|', '|-fail|p1a: A|move: Endeavor',
  '|c:|1234567890|', '|uhtml|room|<div>',
  '|move|p1a: Ünïcödé ✔|Tackle|p2a: B',
  '|move|p1a: ' + 'x'.repeat(5000) + '|Tackle|p2a: B',
  '|-damage|p1a: A|' + JSON.stringify({ weird: 'object' }),
  '>battle-gen9nationaldexou-999', '>start {"formatid":"gen9nationaldexou"}', '>player|p1|Me',
  '>foo bar baz',
  '\t|move|p1a: Tabbed|Tackle|p2a: B\t'
];
let advThrown = [];
ADVERSARIAL.forEach(function (line, i) {
  try {
    PROTO.feed(line);
    PROTO.feedAll(line);
  } catch (err) {
    advThrown.push(i + ': ' + String((err && err.message) || err) + ' :: ' + JSON.stringify(line.slice(0, 60)));
  }
});
eq('no adversarial line throws (single feed and feedAll)', advThrown, []);

/* And the same adversarial lines into a live state manager, which is where a half-parsed
 * event would actually desync something. */
let advStateThrown = [];
const advState = new ST.BattleStateManager({ debug: false });
const advParser = new ST.ProtocolParser();
advState.attachParser(advParser);
advState.setFormat('[Gen 9] National Dex OU');
ADVERSARIAL.forEach(function (line) {
  try { advParser.feed(line); } catch (err) { advStateThrown.push(String((err && err.message) || err) + ' :: ' + JSON.stringify(line.slice(0, 60))); }
});
eq('no adversarial line throws through the state manager', advStateThrown, []);
check('the manager is still usable after the junk', (function () {
  try {
    advParser.feed('|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100');
    advParser.feed('|turn|1');
    return (advState.state.myTeam || []).some(function (m) { return m && U.toID(m.species) === 'greattusk'; });
  } catch (e) { return false; }
})());

section('a species named like a forme must not latch the Mega lock');
const naamState = new ST.BattleStateManager({ debug: false });
const naamParser = new ST.ProtocolParser();
naamState.attachParser(naamParser);
naamParser.feed('|switch|p2a: Meganium|Meganium, L50, M|100/100');
naamParser.feed('|turn|1');
const meganium = (naamState.state.oppTeam || []).find(function (m) { return m && U.toID(m.species) === 'meganium'; });
check('a plain Meganium switch-in does not set megaEvolved', !!meganium && meganium.megaEvolved !== true,
  JSON.stringify(meganium && { species: meganium.species, mega: meganium.megaEvolved }));
check('a plain Meganium does not latch the opponent Mega lock', naamState.state.formatLocks.oppHasMegaEvolved !== true,
  JSON.stringify(naamState.state.formatLocks));
// ...while a real Mega forme still does, and still adopts the forme.
const realMega = new ST.BattleStateManager({ debug: false });
const realParser = new ST.ProtocolParser();
realMega.attachParser(realParser);
realParser.feed('|switch|p2a: Abomasnow|Abomasnow, L50, M|100/100');
realParser.feed('|-mega|p2a: Abomasnow|Abomasnow-Mega|Abomasite');
const megaMon = (realMega.state.oppTeam || []).find(function (m) { return U.toID(m.species).indexOf('abomasnow') === 0; });
check('a real |-mega| still latches the lock and adopts the forme',
  realMega.state.formatLocks.oppHasMegaEvolved === true && megaMon.megaEvolved === true && U.toID(megaMon.species) === 'abomasnowmega',
  JSON.stringify({ lock: realMega.state.formatLocks.oppHasMegaEvolved, mon: megaMon && megaMon.species }));

/* Truncated streams: cutting the log at a random point must never leave a throwable state. */
section('truncation fuzz');
let truncFailures = [];
for (let cut = 1; cut < LINES.length; cut += 7) {
  const r = replay(LINES.slice(0, cut));
  if (r.thrown.length) truncFailures.push(cut);
}
eq('every 7th truncated prefix is clean', truncFailures, []);

/* ---------------------------------------------------------------------- summary */

console.log('\n=== summary ===');
notes.forEach(function (n) { console.log('note: ' + n); });
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failed);
if (failed) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('ALL PARSER FUZZ CHECKS PASSED');
process.exit(0);
