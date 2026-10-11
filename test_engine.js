/* Showdown Tactician — test_engine.js  (RULE 2: the ground-truth test suite)
 *
 * Run me with:  node test_engine.js
 *
 * WHAT THIS IS
 *   Five canonical, non-negotiable damage scenarios, each frozen to an exact number, run
 *   through the extension's own pipeline (`ST.DamageEngine`, the wrapper the solver actually
 *   calls) and then independently through a bare `calc.calculate(...)` written out by hand
 *   here. Both must agree with the frozen number.
 *
 * WHY IT EXISTS
 *   A successful build says nothing about whether the plumbing distorts the library. This
 *   file is the plumb-line: if a nature, EV, item, ability, weather or status ever stops
 *   reaching @smogon/calc — or reaches it wrongly — the wrapper's number drifts off the
 *   library's and this suite fails before any UI code runs.
 *
 * WHERE THE NUMBERS COME FROM
 *   The five scenarios are the real trades from the ExtramePatriot vs. LUIZ_LFN NatDex OU
 *   battle that ships as tests/test_log.txt: Kartana's Sacred Sword into Mega Abomasnow
 *   (turn 8), Mega Abomasnow's Blizzard into Hatterene (turns 5-6), Ursaluna's burned Guts
 *   Facade into Toxapex (turn 13), its Headlong Rush into Tapu Lele (turn 25) and Kingambit's
 *   Supreme Overlord Kowtow Cleave into Kartana (turn 30). The frozen damage rolls are the
 *   vendored @smogon/calc library's own output for those exact sets, and the last assertion
 *   of each scenario ties them back to the percentage the battle log actually printed.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about the browser: no DOM, no extension, no Showdown page. It is a numbers suite.
 */
'use strict';

const H = require('./tests/harness.js');

const IV31 = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
const ZERO = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

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
function section(title) { console.log('\n=== ' + title + ' ==='); }

/* ------------------------------------------------------------------ the bundle */

const S = H.loadAll();
const ST = S.ST;
const U = ST.util;
const CALC = S.window.calc;
const gen = CALC.Generations.get(9);

section('the vendored @smogon/calc bundle and the engine are both live');
check('window.calc exposes calculate()', typeof CALC.calculate === 'function');
check('window.calc exposes Generations.get()', !!(gen && typeof gen.species.get === 'function'));
check('ST.DamageEngine exists', typeof ST.DamageEngine === 'function');
check('ST.util.libraryReady() is true', U.libraryReady() === true);

const engine = new ST.DamageEngine({ gen: 9 });
check('the damage engine reports itself available', engine.available === true);
engine.beginTurn('ground-truth');

/* ------------------------------------------------------------------ helpers */

function libraryDamage(atk, def, moveName, fieldState) {
  const pkA = buildLibraryMon(atk);
  const pkD = buildLibraryMon(def);
  const field = buildLibraryField(fieldState);
  return CALC.calculate(gen, pkA, pkD, new CALC.Move(gen, moveName), field).range();
}
function buildLibraryMon(desc) {
  const opts = {
    level: desc.level, nature: desc.nature, evs: desc.evs, ivs: desc.ivs,
    ability: desc.ability || undefined, item: desc.item || undefined
  };
  if (desc.status) opts.status = desc.status;
  if (desc.alliesFainted) opts.alliesFainted = desc.alliesFainted;
  if (desc.boosterActive) opts.boostedStat = 'auto';
  return new CALC.Pokemon(gen, desc.species, opts);
}
function buildLibraryField(fieldState) {
  const fs = fieldState || {};
  const out = { gameType: 'Singles' };
  if (fs.weather) out.weather = fs.weather.charAt(0).toUpperCase() + fs.weather.slice(1);
  if (fs.terrain) out.terrain = fs.terrain.charAt(0).toUpperCase() + fs.terrain.slice(1);
  return new CALC.Field(out);
}

/**
 * One scenario: the engine's number, the library's number, the frozen ground truth, and the
 * percentage the real battle log printed (which must sit inside the roll).
 */
function scenario(spec) {
  section(spec.title);
  const res = engine.calculateDamage(spec.atk, spec.def, spec.move, spec.field || {}, {});
  const lib = libraryDamage(spec.atk, spec.def, spec.move, spec.field || {});

  check('the engine did not fail', res.failed !== true, res.error);
  eq('damage roll matches the frozen ground truth', [res.minDmg, res.maxDmg],
    [spec.truth.min, spec.truth.max]);
  eq('the wrapper agrees with a bare calc.calculate() call', [res.minDmg, res.maxDmg], [lib[0], lib[1]]);
  eq('defender max HP matches the frozen value', res.defenderMaxHP, spec.truth.maxHP);
  check('percentages match the frozen ground truth',
    Math.abs(res.minPercent - spec.truth.minPct) < 0.05 && Math.abs(res.maxPercent - spec.truth.maxPct) < 0.05,
    res.minPercent.toFixed(3) + '-' + res.maxPercent.toFixed(3));
  eq('the library names the same conditions in its own description', /vs\..*/.test(res.desc), true);

  if (spec.logPercent !== undefined) {
    // The battle log shows the damage actually rolled, but it never prints more than 100%
    // (a 153% OHKO reads as "lost 100% of its health"), so compare against the roll clipped
    // at 100 — not against the raw upper bound.
    const lo = Math.min(100, res.minPercent);
    const hi = Math.min(100, res.maxPercent);
    check('the percentage printed in the real battle log is inside this roll',
      spec.logPercent >= lo - 0.2 && spec.logPercent <= hi + 0.2,
      'log ' + spec.logPercent + '% vs roll ' + res.minPercent.toFixed(1) + '-' + res.maxPercent.toFixed(1) +
      '% (clipped ' + lo.toFixed(1) + '-' + hi.toFixed(1) + '%)');
  }
  if (spec.ohko !== undefined) {
    eq('OHKO verdict matches the battle log', res.isOHKO, spec.ohko);
  }
}

/* ------------------------------------------------------------------ scenarios */

const ABOMASNOW_MEGA = {
  species: 'Abomasnow-Mega', ability: 'Snow Warning', item: 'Abomasite', nature: 'Sassy', level: 100,
  evs: { hp: 252, atk: 0, def: 4, spa: 252, spd: 0, spe: 0 }, ivs: IV31
};

scenario({
  title: 'S1  Kartana Choice Band Sacred Sword -> Mega Abomasnow, in Snow  (turn 8)',
  atk: { species: 'Kartana', ability: 'Beast Boost', item: 'Choice Band', nature: 'Jolly', level: 100, evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, ivs: IV31 },
  def: ABOMASNOW_MEGA,
  move: 'Sacred Sword',
  field: { weather: 'snow' },
  truth: { min: 242, max: 286, maxHP: 384, minPct: 63, maxPct: 74.479 },
  logPercent: 74
});

scenario({
  title: 'S2  Mega Abomasnow Blizzard -> Hatterene, in Snow  (turns 5-6)',
  atk: { species: 'Abomasnow-Mega', ability: 'Snow Warning', item: 'Abomasite', nature: 'Modest', level: 100, evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 }, ivs: IV31 },
  def: { species: 'Hatterene', ability: 'Magic Bounce', item: 'Leftovers', nature: 'Quiet', level: 100, evs: { hp: 252, atk: 0, def: 0, spa: 252, spd: 4, spe: 0 }, ivs: IV31 },
  move: 'Blizzard',
  field: { weather: 'snow' },
  truth: { min: 195, max: 229, maxHP: 318, minPct: 61.321, maxPct: 72.013 },
  logPercent: 72
});

scenario({
  title: 'S3  burned Guts Ursaluna Facade -> Toxapex  (turn 13)',
  atk: { species: 'Ursaluna', ability: 'Guts', item: 'Flame Orb', nature: 'Adamant', level: 100, evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, ivs: IV31, status: 'brn' },
  def: { species: 'Toxapex', ability: 'Regenerator', item: 'Black Sludge', nature: 'Bold', level: 100, evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 }, ivs: IV31 },
  move: 'Facade',
  field: {},
  truth: { min: 211, max: 250, maxHP: 304, minPct: 69.408, maxPct: 82.237 },
  logPercent: 74
});

scenario({
  title: 'S4  Ursaluna Headlong Rush -> Tapu Lele under Psychic Terrain  (turn 25)',
  atk: { species: 'Ursaluna', ability: 'Guts', item: 'Flame Orb', nature: 'Adamant', level: 100, evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, ivs: IV31, status: 'brn' },
  def: { species: 'Tapu Lele', ability: 'Psychic Surge', item: '', nature: 'Timid', level: 100, evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 }, ivs: IV31 },
  move: 'Headlong Rush',
  field: { terrain: 'psychic' },
  truth: { min: 433, max: 510, maxHP: 282, minPct: 153.546, maxPct: 180.851 },
  logPercent: 100,
  ohko: true
});

scenario({
  title: 'S5  Kingambit Supreme Overlord (5 fallen) Kowtow Cleave -> Kartana  (turn 30)',
  atk: { species: 'Kingambit', ability: 'Supreme Overlord', item: 'Leftovers', nature: 'Adamant', level: 100, evs: { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 }, ivs: IV31, alliesFainted: 5 },
  def: { species: 'Kartana', ability: 'Beast Boost', item: 'Choice Band', nature: 'Jolly', level: 100, evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, ivs: IV31 },
  move: 'Kowtow Cleave',
  field: {},
  truth: { min: 186, max: 219, maxHP: 260, minPct: 71.538, maxPct: 84.231 },
  logPercent: 82
});

/* --------------------------------------------------- ability plumbing on the path */

section('ability state actually reaches the library');

const kowtow = {
  species: 'Kingambit', ability: 'Supreme Overlord', item: 'Leftovers', nature: 'Adamant', level: 100,
  evs: { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 }, ivs: IV31
};
const kartana = {
  species: 'Kartana', ability: 'Beast Boost', item: 'Choice Band', nature: 'Jolly', level: 100,
  evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, ivs: IV31
};
const noFallen = engine.calculateDamage(Object.assign({}, kowtow, { alliesFainted: 0 }), kartana, 'Kowtow Cleave', {}, {});
const fiveFallen = engine.calculateDamage(Object.assign({}, kowtow, { alliesFainted: 5 }), kartana, 'Kowtow Cleave', {}, {});
eq('Supreme Overlord with no fallen allies is the unboosted roll', noFallen.minDmg, 126);
eq('Supreme Overlord with five fallen allies is the boosted roll', fiveFallen.minDmg, 186);
check('alliesFainted changes the damage (it is not silently dropped)', fiveFallen.minDmg > noFallen.minDmg,
  noFallen.minDmg + ' -> ' + fiveFallen.minDmg);

const paradoxTusk = {
  species: 'Great Tusk', ability: 'Protosynthesis', item: 'Booster Energy', nature: 'Adamant', level: 100,
  evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, ivs: IV31
};
const tuskOff = engine.calculateDamage(Object.assign({}, paradoxTusk, { boosterActive: false }), ABOMASNOW_MEGA, 'Headlong Rush', {}, {});
const tuskOn = engine.calculateDamage(Object.assign({}, paradoxTusk, { boosterActive: true }), ABOMASNOW_MEGA, 'Headlong Rush', {}, {});
eq('Protosynthesis inactive is the unboosted roll', [tuskOff.minDmg, tuskOff.maxDmg], [104, 123]);
eq('Protosynthesis active is the boosted roll', [tuskOn.minDmg, tuskOn.maxDmg], [135, 159]);
check('the library names the paradox ability once the boost is live', /Protosynthesis/.test(tuskOn.desc), tuskOn.desc);

const valiant = {
  species: 'Iron Valiant', ability: 'Quark Drive', item: 'Booster Energy', nature: 'Adamant', level: 100,
  evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, ivs: IV31
};
const valOn = engine.calculateDamage(Object.assign({}, valiant, { boosterActive: true }), ABOMASNOW_MEGA, 'Close Combat', {}, {});
eq('Quark Drive active is the boosted roll', [valOn.minDmg, valOn.maxDmg], [534, 630]);

/* ------------------------------------------------------- stats are the library's too */

section('the stat numbers under the damage are the library\'s');

eq('Great Tusk Jolly 252 Spe is 300', U.statTable('Great Tusk', { nature: 'Jolly', evs: { spe: 252 } }).spe, 300);
eq('Great Tusk Adamant 252 Atk is 397', U.statTable('Great Tusk', { nature: 'Adamant', evs: { atk: 252 } }).atk, 397);
eq('Mega Abomasnow max HP is 384', buildLibraryMon(ABOMASNOW_MEGA).stats.hp, 384);
eq('Shedinja HP is the Wonder Guard 1, not a formula', U.statTable('Shedinja', { evs: { hp: 252 }, ivs: Object.assign({}, IV31, { hp: 31 }) }).hp, 1);
eq('the engine and the library agree on the attacker stat line',
  U.statTable('Kingambit', { nature: 'Adamant', evs: { hp: 252, atk: 252, spd: 4 } }),
  new CALC.Pokemon(gen, 'Kingambit', { nature: 'Adamant', evs: { hp: 252, atk: 252, spd: 4 } }).stats);
check('a mon with no item or ability still computes', U.statTable('Kartana', { nature: 'Jolly', evs: ZERO }).atk > 0);

/* ------------------------------------------------------------------ the memo */

section('the memo cannot change a number');

engine.beginTurn('memo-check');
const first = engine.calculateDamage(kartana, ABOMASNOW_MEGA, 'Sacred Sword', { weather: 'snow' }, {});
const second = engine.calculateDamage(kartana, ABOMASNOW_MEGA, 'Sacred Sword', { weather: 'snow' }, {});
eq('a memo hit returns the identical roll', [second.minDmg, second.maxDmg], [first.minDmg, first.maxDmg]);
check('the memo hit was actually served from the cache', engine.cacheStats().hits > 0, JSON.stringify(engine.cacheStats()));
const fresh = engine.calculateDamage(Object.assign({}, kartana, { alliesFainted: 4 }), ABOMASNOW_MEGA, 'Sacred Sword', { weather: 'snow' }, {});
eq('a different mon state is NOT served from the old key', fresh.failed, false);

/* ------------------------------------------------------------------ summary */

console.log('\n=== summary ===');
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failed);
if (failed) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('ALL ENGINE GROUND-TRUTH CHECKS PASSED');
process.exit(0);
