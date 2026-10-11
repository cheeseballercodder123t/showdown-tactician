/* Showdown Tactician — tests/blackbox_guard.js
 * RULE 1, "THE BLACK BOX RULE": the engine writes no math. Damage, type effectiveness and
 * stat arithmetic all belong to the vendored @smogon/calc bundle. This suite proves that
 * two ways, and it is the permanent guard against someone re-introducing a hand-rolled
 * calculator later:
 *
 *   1. DYNAMICALLY — every species in the dex, every stat, three natures and two spreads are
 *      evaluated through src/util.js and diffed against the library's own two independent
 *      code paths: `calc.Stats.calcStat(...)` and `new calc.Pokemon(...).stats`. All 324
 *      type-pair cells of the type chart are diffed the same way.
 *   2. STATICALLY — every src/*.js file is scanned for the shapes a handwritten calculator
 *      leaves behind: a stat formula, the ADV HP formula, a damage formula, a hand-typed
 *      type table, a species -> base-stat table, the 1.1/0.9 nature multipliers outside the
 *      single function that reads the library's nature table, and any damage call outside
 *      src/calc_engine.js.
 *
 * Usage:  node tests/blackbox_guard.js     (exit 0 = every check passed)
 */
const fs = require('fs');
const path = require('path');
const { loadAll, ROOT } = require('./harness.js');

const s = loadAll(null, { through: 'src/util.js' });
const U = s.ST.util;
const CALC = s.calc;
const gen = CALC && CALC.Generations ? CALC.Generations.get(9) : null;

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log('PASS ' + name); return true; }
  const line = name + (detail !== undefined ? '  <- ' + detail : '');
  failures.push(line);
  console.log('FAIL ' + line);
  return false;
}
function section(title) { console.log('\n=== ' + title + ' ==='); }
function firstFew(list, n) { return list.slice(0, n === undefined ? 3 : n).join(' | '); }

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const TYPE_NAMES = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost',
  'Steel', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark', 'Fairy'];
const TEST_NATURES = ['Jolly', 'Bold', 'Serious'];
const IV31 = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
const ZERO_EV = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

/* ------------------------------------------------------------------ 1. the library is the calculator */

section('library is the only calculator');

check('window.calc is loaded', !!CALC);
check('calc.calculate is a function', !!(CALC && typeof CALC.calculate === 'function'));
check('calc.Stats.calcStat is a function', !!(CALC && CALC.Stats && typeof CALC.Stats.calcStat === 'function'));
check('calc.Pokemon / calc.Move are constructors',
  !!(CALC && typeof CALC.Pokemon === 'function' && typeof CALC.Move === 'function'));
check('calc.TYPE_CHART / SPECIES / NATURES are present',
  !!(CALC && CALC.TYPE_CHART && CALC.SPECIES && CALC.NATURES && CALC.TYPE_CHART[9] && CALC.SPECIES[9]));
check('util.libraryReady() reports the library is live', U.libraryReady() === true);
check('util exports calcStat / calcHP / statTable / libraryStat',
  typeof U.calcStat === 'function' && typeof U.calcHP === 'function' &&
  typeof U.statTable === 'function' && typeof U.libraryStat === 'function');

/* ------------------------------------------------------------------ 2. stat delegation is exact */

section('stat delegation is exact (the whole dex, every stat, three natures)');

const species = Object.keys(CALC.SPECIES[9]).filter(function (n) { return n.charAt(0) !== '['; });
let compared = 0;
let skipped = 0;
const mismatches = [];
const skippedNames = [];
const pkmMismatches = [];
let pkmCompared = 0;

species.forEach(function (name) {
  const dex = CALC.SPECIES[9][name];
  if (!dex || !dex.bs) { skipped++; skippedNames.push(name); return; }
  TEST_NATURES.forEach(function (nature) {
    STATS.forEach(function (stat) {
      const base = U.baseStats(name)[stat];
      const ev = stat === 'hp' ? 0 : 252;
      const evs = Object.assign({}, ZERO_EV);
      evs[stat] = ev;
      const iv = IV31[stat];

      const want = CALC.Stats.calcStat(gen, stat, base, iv, ev, 100, nature);
      const got = U.statTable(name, { ivs: IV31, evs: evs, level: 100, nature })[stat];
      const gotDirect = stat === 'hp'
        ? U.calcHP(base, iv, ev, 100)
        : U.calcStat(stat, { base: base, iv: iv, ev: ev, level: 100, nature: nature });

      if (!Number.isFinite(want)) { skipped++; return; }
      compared++;
      if (got !== want || gotDirect !== want) {
        mismatches.push(name + '/' + stat + '/' + nature + ' ours=' + got + '/' + gotDirect + ' lib=' + want);
      }
    });

    // Independent second opinion: the library's Pokemon class builds all six stats at once.
    try {
      const pkm = new CALC.Pokemon(gen, name, { level: 100, nature: nature });
      const table = U.statTable(name, { ivs: IV31, evs: ZERO_EV, level: 100, nature });
      STATS.forEach(function (stat) {
        pkmCompared++;
        if (table[stat] !== pkm.stats[stat]) {
          pkmMismatches.push(name + '/' + stat + '/' + nature + ' ours=' + table[stat] + ' lib=' + pkm.stats[stat]);
        }
      });
    } catch (e) {
      skippedNames.push(name + ' (Pokemon threw: ' + e.message + ')');
    }
  });
});

console.log('compared ' + compared + ' stat values against calc.Stats.calcStat(' +
  species.length + ' species x ' + STATS.length + ' stats x ' + TEST_NATURES.length + ' natures)');
console.log('compared ' + pkmCompared + ' stat values against new calc.Pokemon(...).stats');

check('the sweep covered a real dex (> 1500 stat values)', compared > 1500, 'compared=' + compared);
check('every stat matches calc.Stats.calcStat exactly', mismatches.length === 0,
  mismatches.length + ' mismatches: ' + firstFew(mismatches));
check('every stat matches calc.Pokemon(...).stats exactly', pkmMismatches.length === 0,
  pkmMismatches.length + ' mismatches: ' + firstFew(pkmMismatches));

// The engine's own Speed path must feed the library, not a formula of its own.
const rawMismatches = [];
let rawCompared = 0;
species.forEach(function (name) {
  if (!CALC.SPECIES[9][name] || !CALC.SPECIES[9][name].bs) return;
  const mine = U.computeSpeed({ species: name, nature: 'Jolly', evs: { spe: 252 } });
  const lib = CALC.Stats.calcStat(gen, 'spe', U.baseStats(name).spe, 31, 252, 100, 'Jolly');
  rawCompared++;
  if (mine.raw !== lib) rawMismatches.push(name + ' ours=' + mine.raw + ' lib=' + lib);
});
console.log('compared ' + rawCompared + ' raw Speed values from util.computeSpeed');
check('computeSpeed().raw is the library stat', rawMismatches.length === 0,
  rawMismatches.length + ' mismatches: ' + firstFew(rawMismatches));

// Shedinja: the library knows its HP is always 1. The formula we used to hand-write returned 112.
const shedinja = U.statTable('Shedinja', { evs: { hp: 252 }, ivs: { hp: 31 }, level: 100 });
check('Shedinja HP is the library\'s 1, not a formula\'s 112',
  shedinja && shedinja.hp === 1, 'ours=' + JSON.stringify(shedinja));
check('Great Tusk Jolly 252 Spe is the library\'s 300',
  U.computeSpeed({ species: 'Great Tusk', nature: 'Jolly', evs: { spe: 252 } }).effective === 300);

/* ------------------------------------------------------------------ 3. type chart is the library's */

section('type chart is the library\'s, cell for cell');

const chart = CALC.TYPE_CHART[9];
let cellsCompared = 0;
let cellMismatches = 0;
const cellExamples = [];
TYPE_NAMES.forEach(function (atk) {
  TYPE_NAMES.forEach(function (def) {
    const lib = chart[atk] && chart[atk][def];
    if (typeof lib !== 'number') return;
    cellsCompared++;
    const ours = U.typeMultiplier(atk, [def]);
    if (ours !== lib) {
      cellMismatches++;
      if (cellExamples.length < 3) cellExamples.push(atk + '->' + def + ' ours=' + ours + ' lib=' + lib);
    }
  });
});
console.log('compared ' + cellsCompared + ' type-pair cells against calc.TYPE_CHART[9]');
check('all 324 type cells come straight from the library', cellMismatches === 0 && cellsCompared === 324,
  cellMismatches + ' mismatches: ' + firstFew(cellExamples));
check('dual-type effectiveness is the product of the library cells (Steel vs Tapu Lele = 2)',
  U.typeEffectiveness('Steel', 'Tapu Lele') === 2);
check('immunity survives the library lookup (Ground vs Landorus-Therian = 0)',
  U.typeEffectiveness('Ground', 'Landorus-Therian') === 0);

/* ------------------------------------------------------------------ 4. static scan: no handwritten math */

section('static scan: no handwritten math anywhere in src/');

function srcFiles() {
  return fs.readdirSync(path.join(ROOT, 'src'))
    .filter(function (f) { return /\.js$/.test(f); })
    .sort();
}
function linesOf(file) {
  return fs.readFileSync(path.join(ROOT, 'src', file), 'utf8').split(/\r?\n/);
}
function isComment(line) {
  const t = line.trim();
  return t.indexOf('*') === 0 || t.indexOf('//') === 0 || t.indexOf('/*') === 0;
}
/** Scan every src file; `re` must be a non-global regex. `allow(rel, line, lineNo)` exempts. */
function scan(re, allow) {
  const hits = [];
  srcFiles().forEach(function (file) {
    linesOf(file).forEach(function (line, i) {
      if (isComment(line)) return;
      if (!re.test(line)) return;
      if (allow && allow('src/' + file, line, i + 1)) return;
      hits.push('src/' + file + ':' + (i + 1) + ' ' + line.trim().slice(0, 120));
    });
  });
  return hits;
}

const statFormula = scan(/\b2\s*\*\s*(base\b|baseStat|bs\b|bs\.)/);
check('no stat formula in src/ (no "2 * base ...")', statFormula.length === 0, firstFew(statFormula));

const advHp = scan(/\+\s*level\s*\+\s*10|level\s*\+\s*10\b/);
check('no handwritten ADV HP formula', advHp.length === 0, firstFew(advHp));

const dmgFormula = scan(/(bp|basePower)[^\n]{0,40}\/\s*50\b|\/\s*50\s*\)\s*\+\s*2\b/);
check('no handwritten damage formula (bp / 50 + 2)', dmgFormula.length === 0, firstFew(dmgFormula));

const chartDecl = scan(/^\s*(const|let|var)\s+TYPE_CHART\s*=/,
  function (rel, line) { return /CALC|calc\./.test(line); });
check('TYPE_CHART is only ever read from the library', chartDecl.length === 0, firstFew(chartDecl));

const handCharts = [];
srcFiles().forEach(function (file) {
  linesOf(file).forEach(function (line, i) {
    if (isComment(line)) return;
    const named = TYPE_NAMES.filter(function (t) { return new RegExp('\\b' + t + '\\s*:').test(line); });
    if (named.length >= 3) handCharts.push('src/' + file + ':' + (i + 1) + ' ' + line.trim().slice(0, 120));
  });
});
check('no hand-typed type chart (3+ type keys on one line)', handCharts.length === 0, firstFew(handCharts));

const statTables = scan(/^\s*(['"][A-Z][^'"]{2,}['"]|[A-Z][a-z]+(?:[' -][A-Za-z.]+)*)\s*:\s*\{[^}]*\bhp\s*:\s*\d/);
const statTablesBoth = statTables.filter(function (h) { return /\batk\s*:\s*\d|\bat\s*:\s*\d/.test(h); });
check('no species -> base-stat table in src/', statTablesBoth.length === 0, firstFew(statTablesBoth));

// 1.1 / 0.9 may appear only inside util.js's natureMultiplier (which reads the library's nature table).
const utilLines = linesOf('util.js');
let nmStart = -1, nmEnd = -1;
utilLines.forEach(function (line, i) {
  if (nmStart === -1 && /function\s+natureMultiplier\s*\(/.test(line)) nmStart = i + 1;
  else if (nmStart !== -1 && nmEnd === -1 && /^\s{2}\}/.test(line)) nmEnd = i + 1;
});
const natureHits = scan(/\b1\.1\b|\b0\.9\b/, function (rel, line, lineNo) {
  return rel === 'src/util.js' && nmStart !== -1 && lineNo >= nmStart && lineNo <= nmEnd;
});
check('natureMultiplier is the only ±10% site (1.1 / 0.9 nowhere else)',
  natureHits.length === 0 && nmStart !== -1, 'body=' + nmStart + '..' + nmEnd + ' ' + firstFew(natureHits));

// \bcalculate( also catches a dotted `.calculate(` call, so a second damage path cannot hide.
const dmgCalls = scan(/\bcalculate\s*\(/, function (rel) { return rel === 'src/calc_engine.js'; });
check('every damage call lives in src/calc_engine.js', dmgCalls.length === 0, firstFew(dmgCalls));

// Positive controls: delegation must actually be wired, not merely permitted.
const utilSrc = fs.readFileSync(path.join(ROOT, 'src', 'util.js'), 'utf8');
const engineSrc = fs.readFileSync(path.join(ROOT, 'src', 'calc_engine.js'), 'utf8');
check('util.js really calls calc.Stats.calcStat', /CALC\.Stats\.calcStat\(/.test(utilSrc));
check('calc_engine.js really calls the library calculate()', /\.calculate\(/.test(engineSrc));
// The bundle may be reached through any local alias (`new C.Pokemon(...)`, `new this.CALC.Move(...)`, ...),
// so the control accepts any `new <alias>.Pokemon(` shape rather than one exact spelling.
check('calc_engine.js builds library Pokemon/Move objects',
  /new\s+[A-Za-z_$][\w$]*\.Pokemon\(/.test(engineSrc) && /new\s+[A-Za-z_$][\w$]*\.Move\(/.test(engineSrc));
check('the config module is loaded before util.js', typeof s.ST.configGet === 'function');

/* ------------------------------------------------------------------ summary */

console.log('\n' + (failures.length
  ? failures.length + ' FAILURES\n' + failures.map(function (f) { return '  - ' + f; }).join('\n')
  : 'ALL BLACKBOX CHECKS PASSED'));
console.log('checks passed: ' + passed + '  failed: ' + failures.length +
  '  stat values diffed against the library: ' + (compared + pkmCompared) +
  '  type cells: ' + cellsCompared);
if (skipped) console.log('note: skipped ' + skipped + ' non-numeric dex entries' +
  (skippedNames.length ? ' (' + firstFew(skippedNames) + ')' : ''));
process.exit(failures.length ? 1 : 0);
