/* Regenerates lib/species-aliases.js: finds every species in tools/pokedex.json (the
 * snapshot of Showdown's authoritative dex) that the vendored @smogon/calc bundle cannot
 * resolve, and writes an alias to an existing calc species (Aegislash -> Aegislash-Shield)
 * or a synthesized record when calc has no forme of it at all.
 * Run from anywhere:  node tools/gen_aliases.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const sandbox = { console };
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
['lib/calc-data.min.js', 'lib/calc.min.js'].forEach(function (rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
});

const gen = sandbox.calc.Generations.get(9);
const dex = JSON.parse(fs.readFileSync(path.join(__dirname, 'pokedex.json'), 'utf8'));
const calcNames = Object.keys(sandbox.calc.SPECIES[9]);
const calcIds = {};
calcNames.forEach(function (n) { calcIds[n.toLowerCase().replace(/[^a-z0-9]+/g, '')] = n; });

const aliases = {};
const fallback = {};
let missing = 0;
Object.keys(dex).forEach(function (id) {
  const entry = dex[id];
  if (!entry || entry.isNonstandard === 'CAP') return;
  if (calcIds[id]) return;
  if (gen.species.get(id)) return;
  missing++;
  // 1. an existing calc species whose id starts with this id (Aegislash -> Aegislash-Shield).
  //    '-Both' entries are calc's amalgamated formes with summed stats (Aegislash-Both reads
  //    140 in every offensive stat) so they must never be used as a base-species alias.
  const prefixed = Object.keys(calcIds).filter(function (k) {
    return k.indexOf(id) === 0 && k !== id && k.indexOf('both') === -1;
  });
  if (prefixed.length) {
    function rank(k) {
      if (/shield$/.test(k)) return 0;
      if (/mega$/.test(k)) return 1;
      if (/^(.+)base$/.test(k)) return 2;
      return 3;
    }
    prefixed.sort(function (a, b) { return (rank(a) - rank(b)) || (a.length - b.length) || (a < b ? -1 : 1); });
    aliases[id] = calcIds[prefixed[0]];
    return;
  }
  // 2. no calc forme at all: synthesize from Showdown so state tracking still resolves it
  const bs = entry.baseStats || {};
  fallback[id] = {
    name: entry.name,
    types: entry.types || ['Normal'],
    baseStats: { hp: bs.hp | 0, atk: bs.atk | 0, def: bs.def | 0, spa: bs.spa | 0, spd: bs.spd | 0, spe: bs.spe | 0 },
    abilities: Object.keys(entry.abilities || {}).map(function (k) { return entry.abilities[k]; })
  };
});

const header =
'/* Showdown Tactician - lib/species-aliases.js\n' +
' * GENERATED FILE - do not edit by hand; regenerate with the script documented in README.md.\n' +
' * Sources: play.pokemonshowdown.com/data/pokedex.json and the vendored @smogon/calc bundle.\n' +
' * Why it exists: the calc bundle keys some base species only by forme (bare "Aegislash" does\n' +
' * not resolve, "Aegislash-Shield" does), and may lack a species entirely.\n' +
' *   window.ST_SPECIES_ALIASES  = { toID(species): calcSpeciesName }\n' +
' *   window.ST_SPECIES_FALLBACK = { toID(species): { name, types, baseStats, abilities } }\n' +
' * ST.util.getSpecies() consults the alias first, then the fallback, then gives up.\n' +
' * Note: a species served from ST_SPECIES_FALLBACK cannot be damage-calculated by the\n' +
' * vendored calc; ST.DamageEngine reports those calls as failed instead of guessing.\n' +
' */\n';
fs.writeFileSync(path.join(ROOT, 'lib/species-aliases.js'),
  header + '(function () {\n  "use strict";\n  window.ST_SPECIES_ALIASES = ' + JSON.stringify(aliases) +
  ';\n  window.ST_SPECIES_FALLBACK = ' + JSON.stringify(fallback) + ';\n})();\n');

console.log('showdown species:', Object.keys(dex).length, '| missing from calc:', missing,
  '| aliased:', Object.keys(aliases).length, '| synthesized:', Object.keys(fallback).length);
console.log('aliases:', JSON.stringify(aliases));
console.log('synthesized ids:', Object.keys(fallback).join(', ') || '(none)');
