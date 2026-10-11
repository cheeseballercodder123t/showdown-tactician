/* Showdown Tactician — src/sets_usage.js
 * GENERATED DATA FILE - do not edit by hand.
 *
 * Regenerated monthly by .github/workflows/chaos-sync.yml through tools/sync_chaos_sets.js,
 * from a Smogon ladder chaos dump (default: gen9nationaldexou-1760.json). Nothing in this
 * project fetches it at runtime: the workflow runs the tool offline and commits the result, so
 * a battle never depends on stats.pokemonshowdown.com being reachable.
 *
 * Shape:
 *   window.ST_USAGE = {
 *     generatedAt: ISO string of the dump used, or null,
 *     source: '<dump file name>',
 *     minUsage: percent floor applied when the file was generated,
 *     speciesCount: how many species survived the floor,
 *     species: {
 *       greattusk: {
 *         name: 'Great Tusk',
 *         usage: 31.24,                        // percent of teams, from the dump's `usage` field
 *         items:     { heavydutyboots: 62.1, ... },   // percent of that species' sets per item
 *         abilities: { protosynthesis: 98.2, ... },
 *         moves:     { headlongrush: 71.4, ... }      // marginals only: see below
 *       }
 *     }
 *   }
 *
 * Why a WEIGHT OVERLAY and not a regenerated src/sets_db.js: a chaos dump publishes each
 * dimension as a MARGINAL (how often that item, that move, that spread were seen), never as
 * whole sets. Joining marginals back into "a legal set" invents combinations that no player
 * ever ran — a 0-Speed spread with a Choice Scarf, say — which would break RULE 1 (the engine
 * must never simulate an invented set). So the curated database stays the source of SETS, and
 * this file only says which of those sets the ladder is actually holding, which
 * ST.SetDatabase.reweightByUsage() applies to `weight`.
 *
 * Currently EMPTY on purpose: the shipped file carries no data, so every curated weight is
 * exactly what src/sets_db.js says until a maintainer (or the monthly Action) fills it in.
 * `forSpecies()` returns the same sets either way — an absent measurement must never be read
 * as a zero measurement.
 */
(function () {
  'use strict';
  window.ST_USAGE = {
    generatedAt: null,
    source: null,
    minUsage: 1.5,
    speciesCount: 0,
    species: {}
  };
})();
