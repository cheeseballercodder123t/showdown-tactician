/* Regenerates lib/species-abilities.js from tools/pokedex.json — the snapshot of
 * play.pokemonshowdown.com/data/pokedex.json, the authoritative NatDex dex that the target
 * site actually uses. Run from anywhere:  node tools/gen_abilities.js
 *
 * Why it is needed: neither @smogon/calc's species.ts nor its published production bundle
 * carries hidden abilities (Dragonite -> Inner Focus only, losing Multiscale).
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const dex = JSON.parse(fs.readFileSync(path.join(__dirname, 'pokedex.json'), 'utf8'));
const out = {};
const slotOrder = ['0', '1', 'S', 'H'];
Object.keys(dex).forEach(function (id) {
  const e = dex[id];
  if (!e || !e.abilities) return;
  const keys = Object.keys(e.abilities);
  if (keys.length < 2) return;
  const ordered = slotOrder.filter(function (k) { return e.abilities[k]; });
  keys.forEach(function (k) { if (ordered.indexOf(k) === -1) ordered.push(k); });
  const list = [];
  ordered.forEach(function (k) {
    const name = e.abilities[k];
    if (name && list.indexOf(name) === -1) list.push(name);
  });
  if (list.length > 1) out[id] = list;
});
const header =
'/* Showdown Tactician - lib/species-abilities.js\n' +
' * GENERATED FILE - do not edit by hand; regenerate with the script documented in README.md.\n' +
' * Source: play.pokemonshowdown.com/data/pokedex.json (MIT-licensed pokemon-showdown data),\n' +
' * snapshotted 2026-10-10.\n' +
' * Why it exists: the vendored @smogon/calc production bundle keeps only ability slot 0 per\n' +
' * species - Dragonite reads as Inner Focus alone, silently losing Multiscale - which broke\n' +
' * ability pruning, the ability-immunity veto and Quark Drive / Protosynthesis detection.\n' +
' * Shape: window.ST_ABILITY_SUPPLEMENT = { toID(species): [ability, ...] }; species with a\n' +
' * single ability are omitted because slot 0 is already correct. ST.util.getSpecies() merges\n' +
' * this over the bundle data, so the full natdex (including Megas and formes) is covered.\n' +
' */\n';
fs.writeFileSync(path.join(ROOT, 'lib', 'species-abilities.js'),
  header + '(function () {\n  "use strict";\n  window.ST_ABILITY_SUPPLEMENT = ' + JSON.stringify(out) + ';\n})();\n');
console.log('species in dex:', Object.keys(dex).length, '| entries with >1 ability:', Object.keys(out).length);
['dragonite', 'gliscor', 'kingambit', 'toxapex', 'greattusk', 'charizardmegay', 'clodsire', 'dragapult'].forEach(function (k) {
  console.log(' ', k, JSON.stringify(out[k] || 'omitted (single ability)'));
});
