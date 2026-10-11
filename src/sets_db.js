/* Showdown Tactician — src/sets_db.js
 * The shared candidate-set database for [Gen 9] National Dex OU.
 *
 * Every species, item and move referenced here is validated against the vendored dex at
 * load time. Anything that does not resolve is dropped and recorded in
 * ST.SetDatabase.report.invalid, so the engine can never simulate an invented set.
 *
 * Shape of one entry (see ARCHITECTURE.md 1.2):
 *   { id, species, role, item, ability, nature, evs, ivs, moves, weight, tags,
 *     isMega, isZCrystal, itemlessArchetype, notes }
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;

  if (!U) {
    // Degraded mode: never break the pipeline just because the dex failed to load.
    ST.SetDatabase = {
      DB: {},
      DEFAULT: [],
      report: { invalid: ['ST.util missing — sets database disabled'], species: 0, sets: 0 },
      forSpecies: function () { return []; },
      allSpecies: function () { return []; },
      has: function () { return false; },
      genericFor: function () { return []; }
    };
    return;
  }

  const NATURES = ['Adamant', 'Bashful', 'Bold', 'Brave', 'Calm', 'Careful', 'Docile', 'Gentle',
    'Hardy', 'Hasty', 'Impish', 'Jolly', 'Lax', 'Lonely', 'Mild', 'Modest', 'Naive', 'Naughty',
    'Quiet', 'Quirky', 'Rash', 'Relaxed', 'Sassy', 'Serious', 'Timid'];
  const NATURE_SET = new Set(NATURES);
  const IV_MAX = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  const IV_TR = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 0 };

  const DB = Object.create(null);       // speciesId -> SetCandidate[]
  const invalid = [];                   // dropped data (name not resolvable at all)
  const unverified = [];                // names the dex does not list but that are kept
  let setCount = 0;

  function ev(hp, atk, def, spa, spd, spe) {
    return { hp: hp | 0, atk: atk | 0, def: def | 0, spa: spa | 0, spd: spd | 0, spe: spe | 0 };
  }

  function flagItem(item) {
    if (item === null || item === undefined) return { item: null, isMega: false, isZCrystal: false };
    if (U.isMegaStone(item)) return { item: item, isMega: true, isZCrystal: false };
    if (U.isZCrystal(item)) return { item: item, isMega: false, isZCrystal: true };
    return { item: item, isMega: false, isZCrystal: false };
  }

  /**
   * P('Great Tusk', [ { r, i, a, n, e, m, w, t, ivs, notes } ... ])
   * r=role, i=item, a=ability, n=nature, e=ev array [hp,atk,def,spa,spd,spe],
   * m=moves, w=weight, t=space-separated tags, ivs='tr' for 0 Speed IVs.
   */
  function P(speciesName, rows) {
    const species = U.getSpecies(speciesName);
    if (!species) { invalid.push('species: ' + speciesName); return; }
    const abilities = U.getAbilities(species.name) || [];
    const list = [];
    rows.forEach(function (row) {
      const moves = (row.m || []).filter(function (mv) { return !!U.getMoveData(mv); });
      (row.m || []).forEach(function (mv) {
        if (!U.getMoveData(mv)) unverified.push('move: ' + mv + ' (' + species.name + ')');
      });
      if (!moves.length) { invalid.push('set with no valid moves: ' + species.name + '/' + row.r); return; }

      const item = row.i === undefined ? null : row.i;
      // An item name the dex does not list is kept (the engine only classifies Choice /
      // Mega / Z / Booster by name) but surfaced so it can be audited.
      if (item !== null && !U.isItemKnown(item)) unverified.push('item: ' + item + ' (' + species.name + ')');
      const flags = flagItem(item);

      let ability = row.a || abilities[0] || '';
      if (ability && abilities.length && abilities.indexOf(ability) === -1) {
        invalid.push('ability: ' + ability + ' (' + species.name + ')');
        ability = abilities[0] || '';
      }
      let nature = row.n && NATURE_SET.has(row.n) ? row.n : 'Serious';
      if (row.n && !NATURE_SET.has(row.n)) invalid.push('nature: ' + row.n);

      const role = row.r || 'bulky';
      let id = U.toID(species.name) + '-' + role;
      if (DB[U.toID(species.name)]) {
        const used = DB[U.toID(species.name)].some(function (s) { return s.id === id; });
        if (used) id = id + '-' + (DB[U.toID(species.name)].length + 1);
      }

      list.push({
        id: id,
        species: species.name,
        role: role,
        item: flags.item,
        ability: ability,
        nature: nature,
        evs: ev.apply(null, row.e || [0, 0, 0, 0, 0, 0]),
        ivs: row.ivs === 'tr' ? Object.assign({}, IV_TR) : Object.assign({}, IV_MAX),
        moves: moves.slice(0, 4),
        weight: typeof row.w === 'number' ? U.clamp(row.w, 0.01, 1) : 0.1,
        tags: (row.t || '').split(/\s+/).filter(Boolean),
        isMega: flags.isMega,
        isZCrystal: flags.isZCrystal,
        itemlessArchetype: flags.item === null && role === 'itemless',
        notes: row.notes || ''
      });
      setCount++;
    });
    if (!list.length) return;
    // Several P() calls may target the same species (Mega sets, Trick Room sets, ...):
    // merge rather than replace so nothing is lost.
    const key = U.toID(species.name);
    DB[key] = (DB[key] || []).concat(list);
  }

  /* ==========================================================================================
   *  THE METAGAME
   * ========================================================================================*/

  // ---------------------------------------------------------------- S-tier staples

  P('Great Tusk', [
    { r: 'hazard', i: 'Heavy-Duty Boots', a: 'Protosynthesis', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Headlong Rush', 'Rapid Spin', 'Knock Off', 'Stealth Rock'], w: 0.30, t: 'physical hazard hazardremoval boots' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Protosynthesis', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Headlong Rush', 'Close Combat', 'Ice Spinner', 'Rapid Spin'], w: 0.14, t: 'choice scarf physical revenge' },
    { r: 'bulky', i: 'Leftovers', a: 'Protosynthesis', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Earthquake', 'Body Press', 'Stealth Rock', 'Rapid Spin'], w: 0.12, t: 'physical wall hazard' },
    { r: 'band', i: 'Choice Band', a: 'Protosynthesis', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Headlong Rush', 'Close Combat', 'Ice Spinner', 'Knock Off'], w: 0.10, t: 'choice band wallbreaker physical' },
    { r: 'booster', i: 'Booster Energy', a: 'Protosynthesis', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Headlong Rush', 'Close Combat', 'Ice Spinner', 'Knock Off'], w: 0.09, t: 'booster physical sweep' }
  ]);

  P('Iron Valiant', [
    { r: 'booster', i: 'Booster Energy', a: 'Quark Drive', n: 'Naive', e: [4, 252, 0, 0, 0, 252], m: ['Close Combat', 'Moonblast', 'Knock Off', 'Encore'], w: 0.30, t: 'booster mixed setup' },
    { r: 'setup', i: 'Booster Energy', a: 'Quark Drive', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Swords Dance', 'Close Combat', 'Spirit Break', 'Encore'], w: 0.18, t: 'physical setup booster' },
    { r: 'special', i: 'Life Orb', a: 'Quark Drive', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Moonblast', 'Thunderbolt', 'Psyshock', 'Calm Mind'], w: 0.14, t: 'special setup lifeorb' },
    { r: 'choice', i: 'Choice Specs', a: 'Quark Drive', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Moonblast', 'Focus Blast', 'Thunderbolt', 'Psyshock'], w: 0.12, t: 'choice specs special' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Quark Drive', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Close Combat', 'Moonblast', 'Knock Off', 'Trick'], w: 0.08, t: 'choice scarf revenge' }
  ]);

  P('Roaring Moon', [
    { r: 'booster', i: 'Booster Energy', a: 'Protosynthesis', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Dragon Dance', 'Knock Off', 'Acrobatics', 'Earthquake'], w: 0.32, t: 'booster setup physical' },
    { r: 'band', i: 'Choice Band', a: 'Protosynthesis', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Dragon Claw', 'Knock Off', 'Crunch', 'U-turn'], w: 0.14, t: 'choice band wallbreaker' },
    { r: 'itemless', i: null, a: 'Protosynthesis', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Dragon Dance', 'Acrobatics', 'Knock Off', 'Earthquake'], w: 0.10, t: 'itemless acrobatics setup' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Protosynthesis', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Knock Off', 'Dragon Claw', 'Earthquake', 'U-turn'], w: 0.06, t: 'choice scarf revenge' }
  ]);

  P('Raging Bolt', [
    { r: 'setup', i: 'Leftovers', a: 'Protosynthesis', n: 'Modest', e: [196, 0, 4, 252, 0, 56], m: ['Calm Mind', 'Thunderclap', 'Draco Meteor', 'Thunderbolt'], w: 0.34, t: 'special setup sun' },
    { r: 'booster', i: 'Booster Energy', a: 'Protosynthesis', n: 'Modest', e: [4, 0, 0, 252, 0, 252], m: ['Thunderclap', 'Draco Meteor', 'Thunderbolt', 'Dragon Pulse'], w: 0.22, t: 'booster special' },
    { r: 'bulky', i: 'Assault Vest', a: 'Protosynthesis', n: 'Modest', e: [252, 0, 0, 252, 0, 4], m: ['Thunderclap', 'Draco Meteor', 'Thunderbolt', 'Dragon Pulse'], w: 0.12, t: 'assault vest special' }
  ]);

  P('Gouging Fire', [
    { r: 'setup', i: 'Heavy-Duty Boots', a: 'Protosynthesis', n: 'Adamant', e: [252, 252, 0, 0, 4, 0], m: ['Dragon Dance', 'Flare Blitz', 'Burning Bulwark', 'Earthquake'], w: 0.30, t: 'physical setup sun boots' },
    { r: 'booster', i: 'Booster Energy', a: 'Protosynthesis', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Dragon Dance', 'Flare Blitz', 'Burning Bulwark', 'Morning Sun'], w: 0.18, t: 'booster setup sun' },
    { r: 'band', i: 'Choice Band', a: 'Protosynthesis', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Flare Blitz', 'Raging Fury', 'Earthquake', 'Dragon Claw'], w: 0.10, t: 'choice band wallbreaker' }
  ]);

  P('Walking Wake', [
    { r: 'special', i: 'Life Orb', a: 'Protosynthesis', n: 'Modest', e: [0, 0, 0, 252, 4, 252], m: ['Hydro Steam', 'Draco Meteor', 'Flamethrower', 'Dragon Pulse'], w: 0.28, t: 'special lifeorb sun' },
    { r: 'booster', i: 'Booster Energy', a: 'Protosynthesis', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Hydro Steam', 'Draco Meteor', 'Flamethrower', 'Flip Turn'], w: 0.16, t: 'booster special' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Protosynthesis', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Hydro Steam', 'Draco Meteor', 'Flamethrower', 'Flip Turn'], w: 0.08, t: 'choice scarf revenge' }
  ]);

  P('Kingambit', [
    { r: 'setup', i: 'Leftovers', a: 'Supreme Overlord', n: 'Adamant', e: [252, 252, 0, 0, 4, 0], m: ['Swords Dance', 'Kowtow Cleave', 'Sucker Punch', 'Iron Head'], w: 0.36, t: 'physical setup priority' },
    { r: 'band', i: 'Choice Band', a: 'Supreme Overlord', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Kowtow Cleave', 'Sucker Punch', 'Iron Head', 'Low Kick'], w: 0.12, t: 'choice band wallbreaker priority' },
    { r: 'bulky', i: 'Assault Vest', a: 'Supreme Overlord', n: 'Adamant', e: [252, 252, 0, 0, 4, 0], m: ['Kowtow Cleave', 'Sucker Punch', 'Iron Head', 'Low Kick'], w: 0.08, t: 'assault vest physical' },
    { r: 'airballoon', i: 'Air Balloon', a: 'Supreme Overlord', n: 'Adamant', e: [252, 252, 0, 0, 4, 0], m: ['Swords Dance', 'Kowtow Cleave', 'Sucker Punch', 'Iron Head'], w: 0.06, t: 'setup airballoon physical' }
  ]);

  P('Gholdengo', [
    { r: 'special', i: 'Air Balloon', a: 'Good as Gold', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Make It Rain', 'Shadow Ball', 'Nasty Plot', 'Recover'], w: 0.28, t: 'special setup airballoon' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Good as Gold', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Make It Rain', 'Shadow Ball', 'Trick', 'Focus Blast'], w: 0.22, t: 'choice scarf revenge special' },
    { r: 'specs', i: 'Choice Specs', a: 'Good as Gold', n: 'Modest', e: [0, 0, 0, 252, 4, 252], m: ['Make It Rain', 'Shadow Ball', 'Focus Blast', 'Thunderbolt'], w: 0.16, t: 'choice specs wallbreaker special' },
    { r: 'bulky', i: 'Leftovers', a: 'Good as Gold', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Make It Rain', 'Shadow Ball', 'Recover', 'Thunder Wave'], w: 0.08, t: 'wall special' }
  ]);

  P('Dragapult', [
    { r: 'specs', i: 'Choice Specs', a: 'Infiltrator', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Shadow Ball', 'Draco Meteor', 'Fire Blast', 'U-turn'], w: 0.24, t: 'choice specs special pivot' },
    { r: 'band', i: 'Choice Band', a: 'Clear Body', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Dragon Darts', 'U-turn', 'Phantom Force', 'Sucker Punch'], w: 0.18, t: 'choice band physical pivot' },
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Infiltrator', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Shadow Ball', 'Draco Meteor', 'Will-O-Wisp', 'U-turn'], w: 0.14, t: 'pivot boots special' },
    { r: 'setup', i: 'Leftovers', a: 'Clear Body', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Dragon Dance', 'Phantom Force', 'Dragon Darts', 'Sucker Punch'], w: 0.08, t: 'physical setup' }
  ]);

  P('Dragonite', [
    { r: 'setup', i: 'Heavy-Duty Boots', a: 'Multiscale', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Dragon Dance', 'Extreme Speed', 'Earthquake', 'Ice Spinner'], w: 0.28, t: 'physical setup priority boots' },
    { r: 'band', i: 'Choice Band', a: 'Multiscale', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Extreme Speed', 'Outrage', 'Earthquake', 'Fire Punch'], w: 0.14, t: 'choice band priority' },
    { r: 'special', i: 'Heavy-Duty Boots', a: 'Multiscale', n: 'Modest', e: [0, 0, 0, 252, 4, 252], m: ['Draco Meteor', 'Hurricane', 'Thunder', 'Roost'], w: 0.08, t: 'special boots rain' },
    { r: 'lure', i: 'Weakness Policy', a: 'Multiscale', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Dragon Dance', 'Extreme Speed', 'Earthquake', 'Fire Punch'], w: 0.05, t: 'physical setup' }
  ]);

  P('Garchomp', [
    { r: 'hazard', i: 'Rocky Helmet', a: 'Rough Skin', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Earthquake', 'Stealth Rock', 'Dragon Tail', 'Stone Edge'], w: 0.20, t: 'physical hazard' },
    { r: 'setup', i: 'Life Orb', a: 'Rough Skin', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Swords Dance', 'Earthquake', 'Scale Shot', 'Fire Fang'], w: 0.18, t: 'physical setup lifeorb' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Rough Skin', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Earthquake', 'Outrage', 'Stone Edge', 'Dragon Claw'], w: 0.12, t: 'choice scarf revenge' },
    { r: 'z', i: 'Dragonium Z', a: 'Rough Skin', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Swords Dance', 'Outrage', 'Earthquake', 'Stone Edge'], w: 0.07, t: 'z zcrystal physical setup' }
  ]);

  P('Landorus-Therian', [
    { r: 'bulky', i: 'Leftovers', a: 'Intimidate', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Earthquake', 'Stealth Rock', 'U-turn', 'Stone Edge'], w: 0.28, t: 'physical wall pivot hazard' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Intimidate', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Earthquake', 'U-turn', 'Stone Edge', 'Explosion'], w: 0.20, t: 'choice scarf revenge pivot' },
    { r: 'z', i: 'Flyinium Z', a: 'Intimidate', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Earthquake', 'Fly', 'Swords Dance', 'Stone Edge'], w: 0.10, t: 'z zcrystal physical setup' },
    { r: 'band', i: 'Choice Band', a: 'Intimidate', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Earthquake', 'Stone Edge', 'U-turn', 'Explosion'], w: 0.07, t: 'choice band wallbreaker' }
  ]);

  P('Ting-Lu', [
    { r: 'hazard', i: 'Leftovers', a: 'Vessel of Ruin', n: 'Careful', e: [252, 4, 252, 0, 0, 0], m: ['Stealth Rock', 'Earthquake', 'Ruination', 'Whirlwind'], w: 0.36, t: 'wall hazard physical' },
    { r: 'assault', i: 'Assault Vest', a: 'Vessel of Ruin', n: 'Careful', e: [252, 4, 252, 0, 0, 0], m: ['Earthquake', 'Ruination', 'Heavy Slam', 'Stone Edge'], w: 0.16, t: 'assault vest wall' },
    { r: 'specs', i: 'Choice Specs', a: 'Vessel of Ruin', n: 'Modest', e: [252, 0, 4, 252, 0, 0], m: ['Earth Power', 'Ruination', 'Dark Pulse', 'Stealth Rock'], w: 0.06, t: 'choice specs special' }
  ]);

  P('Ogerpon-Wellspring', [
    { r: 'setup', i: 'Wellspring Mask', a: 'Water Absorb', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Ivy Cudgel', 'Swords Dance', 'Horn Leech', 'Trailblaze'], w: 0.34, t: 'physical setup' },
    { r: 'band', i: 'Choice Band', a: 'Water Absorb', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Ivy Cudgel', 'Horn Leech', 'Knock Off', 'U-turn'], w: 0.12, t: 'choice band wallbreaker' },
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Water Absorb', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Ivy Cudgel', 'Knock Off', 'Horn Leech', 'Swords Dance'], w: 0.08, t: 'physical boots setup' }
  ]);

  P('Zamazenta', [
    { r: 'setup', i: 'Leftovers', a: 'Dauntless Shield', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Iron Defense', 'Body Press', 'Crunch', 'Heavy Slam'], w: 0.30, t: 'physical setup wall' },
    { r: 'band', i: 'Choice Band', a: 'Dauntless Shield', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Close Combat', 'Crunch', 'Heavy Slam', 'Stone Edge'], w: 0.16, t: 'choice band wallbreaker' },
    { r: 'howl', i: 'Leftovers', a: 'Dauntless Shield', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Howl', 'Close Combat', 'Crunch', 'Ice Fang'], w: 0.10, t: 'physical setup' }
  ]);

  P('Melmetal', [
    { r: 'band', i: 'Choice Band', a: 'Iron Fist', n: 'Adamant', e: [252, 252, 0, 0, 4, 0], m: ['Double Iron Bash', 'Thunder Punch', 'Ice Punch', 'Superpower'], w: 0.34, t: 'choice band wallbreaker physical' },
    { r: 'assault', i: 'Assault Vest', a: 'Iron Fist', n: 'Adamant', e: [252, 252, 0, 0, 4, 0], m: ['Double Iron Bash', 'Thunder Punch', 'Ice Punch', 'Earthquake'], w: 0.18, t: 'assault vest wall' }
  ]);

  P('Corviknight', [
    { r: 'wall', i: 'Leftovers', a: 'Pressure', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Iron Defense', 'Body Press', 'Roost', 'U-turn'], w: 0.30, t: 'wall physical defog' },
    { r: 'defog', i: 'Heavy-Duty Boots', a: 'Pressure', n: 'Impish', e: [252, 4, 252, 0, 0, 0], m: ['Brave Bird', 'Defog', 'Roost', 'U-turn'], w: 0.18, t: 'wall hazardremoval pivot' },
    { r: 'bulkup', i: 'Leftovers', a: 'Mirror Armor', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Bulk Up', 'Brave Bird', 'Body Press', 'Roost'], w: 0.10, t: 'physical setup wall' }
  ]);

  P('Gliscor', [
    { r: 'wall', i: 'Toxic Orb', a: 'Poison Heal', n: 'Impish', e: [252, 4, 252, 0, 0, 0], m: ['Earthquake', 'Protect', 'Toxic', 'Spikes'], w: 0.34, t: 'wall hazard status' },
    { r: 'swords', i: 'Toxic Orb', a: 'Poison Heal', n: 'Jolly', e: [252, 4, 0, 0, 0, 252], m: ['Swords Dance', 'Earthquake', 'Facade', 'Protect'], w: 0.14, t: 'physical setup wall' },
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Poison Heal', n: 'Impish', e: [252, 4, 252, 0, 0, 0], m: ['Earthquake', 'Roost', 'Knock Off', 'Spikes'], w: 0.08, t: 'wall hazard' }
  ]);

  P('Glimmora', [
    { r: 'hazard', i: 'Focus Sash', a: 'Toxic Debris', n: 'Timid', e: [4, 0, 0, 252, 0, 252], m: ['Stealth Rock', 'Mortal Spin', 'Earth Power', 'Power Gem'], w: 0.30, t: 'hazard special suicide' },
    { r: 'lead', i: 'Focus Sash', a: 'Toxic Debris', n: 'Timid', e: [4, 0, 0, 252, 0, 252], m: ['Spikes', 'Stealth Rock', 'Mortal Spin', 'Sludge Wave'], w: 0.16, t: 'hazard lead special' },
    { r: 'specs', i: 'Choice Specs', a: 'Corrosion', n: 'Timid', e: [4, 0, 0, 252, 0, 252], m: ['Power Gem', 'Sludge Wave', 'Earth Power', 'Energy Ball'], w: 0.08, t: 'choice specs special' }
  ]);

  P('Garganacl', [
    { r: 'wall', i: 'Leftovers', a: 'Purifying Salt', n: 'Careful', e: [252, 4, 252, 0, 0, 0], m: ['Salt Cure', 'Recover', 'Stealth Rock', 'Iron Defense'], w: 0.34, t: 'wall physical status' },
    { r: 'ironpress', i: 'Leftovers', a: 'Purifying Salt', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Iron Defense', 'Body Press', 'Salt Cure', 'Recover'], w: 0.18, t: 'physical setup wall' }
  ]);

  P('Clodsire', [
    { r: 'wall', i: 'Leftovers', a: 'Unaware', n: 'Careful', e: [252, 4, 252, 0, 0, 0], m: ['Earthquake', 'Recover', 'Toxic Spikes', 'Poison Jab'], w: 0.30, t: 'wall hazard status' },
    { r: 'spdef', i: 'Black Sludge', a: 'Water Absorb', n: 'Careful', e: [252, 4, 252, 0, 0, 0], m: ['Earthquake', 'Recover', 'Toxic', 'Stealth Rock'], w: 0.14, t: 'wall special status' }
  ]);

  P('Toxapex', [
    { r: 'wall', i: 'Black Sludge', a: 'Regenerator', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Scald', 'Recover', 'Toxic Spikes', 'Haze'], w: 0.30, t: 'wall hazard status' },
    { r: 'spikes', i: 'Rocky Helmet', a: 'Regenerator', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Scald', 'Recover', 'Spikes', 'Haze'], w: 0.12, t: 'wall hazard' }
  ]);

  P('Alomomola', [
    { r: 'wall', i: 'Heavy-Duty Boots', a: 'Regenerator', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Wish', 'Protect', 'Scald', 'Flip Turn'], w: 0.34, t: 'wall wish pivot' },
    { r: 'bulky', i: 'Rocky Helmet', a: 'Regenerator', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Wish', 'Protect', 'Scald', 'Toxic'], w: 0.12, t: 'wall wish' }
  ]);

  P('Slowking-Galar', [
    { r: 'wall', i: 'Heavy-Duty Boots', a: 'Regenerator', n: 'Sassy', e: [252, 0, 4, 0, 252, 0], m: ['Sludge Bomb', 'Future Sight', 'Chilly Reception', 'Thunder Wave'], w: 0.32, t: 'wall special pivot' , ivs: 'tr' },
    { r: 'assault', i: 'Assault Vest', a: 'Regenerator', n: 'Calm', e: [252, 0, 4, 0, 252, 0], m: ['Sludge Bomb', 'Future Sight', 'Flamethrower', 'Foul Play'], w: 0.18, t: 'assault vest wall' },
    { r: 'tr', i: 'Heavy-Duty Boots', a: 'Regenerator', n: 'Quiet', e: [252, 0, 0, 252, 4, 0], m: ['Trick Room', 'Sludge Bomb', 'Future Sight', 'Chilly Reception'], w: 0.08, t: 'trickroom special pivot', ivs: 'tr' }
  ]);

  P('Slowbro-Galar', [
    { r: 'setup', i: 'Assault Vest', a: 'Regenerator', n: 'Sassy', e: [252, 0, 4, 0, 252, 0], m: ['Future Sight', 'Shell Side Arm', 'Flamethrower', 'Thunder Wave'], w: 0.20, t: 'assault vest special' , ivs: 'tr' },
    { r: 'espresso', i: 'Sitrus Berry', a: 'Quick Draw', n: 'Quiet', e: [252, 0, 0, 252, 4, 0], m: ['Shell Side Arm', 'Psyshock', 'Trick Room', 'Slack Off'], w: 0.10, t: 'trickroom special setup', ivs: 'tr' }
  ]);

  P('Heatran', [
    { r: 'bulky', i: 'Leftovers', a: 'Flash Fire', n: 'Modest', e: [252, 0, 4, 252, 0, 0], m: ['Magma Storm', 'Earth Power', 'Stealth Rock', 'Taunt'], w: 0.30, t: 'special wall hazard' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Flash Fire', n: 'Timid', e: [4, 0, 0, 252, 0, 252], m: ['Magma Storm', 'Earth Power', 'Flash Cannon', 'Eruption'], w: 0.12, t: 'choice scarf revenge special' },
    { r: 'balloon', i: 'Air Balloon', a: 'Flash Fire', n: 'Modest', e: [0, 0, 4, 252, 0, 252], m: ['Magma Storm', 'Earth Power', 'Taunt', 'Stealth Rock'], w: 0.08, t: 'special airballoon' }
  ]);

  P('Volcarona', [
    { r: 'setup', i: 'Heavy-Duty Boots', a: 'Flame Body', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Quiver Dance', 'Fiery Dance', 'Bug Buzz', 'Giga Drain'], w: 0.30, t: 'special setup boots' },
    { r: 'bulky', i: 'Heavy-Duty Boots', a: 'Flame Body', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Quiver Dance', 'Fiery Dance', 'Roost', 'Giga Drain'], w: 0.14, t: 'special setup wall' },
    { r: 'z', i: 'Buginium Z', a: 'Flame Body', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Quiver Dance', 'Savage Spin-Out', 'Fire Blast', 'Giga Drain'], w: 0.06, t: 'z zcrystal special setup' },
    { r: 'sash', i: 'Focus Sash', a: 'Swarm', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Quiver Dance', 'Fiery Dance', 'Bug Buzz', 'Endure'], w: 0.05, t: 'special setup suicide' }
  ]);

  P('Clefable', [
    { r: 'wall', i: 'Leftovers', a: 'Magic Guard', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Moonblast', 'Soft-Boiled', 'Calm Mind', 'Flamethrower'], w: 0.28, t: 'special setup wall' },
    { r: 'unaware', i: 'Leftovers', a: 'Unaware', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Moonblast', 'Soft-Boiled', 'Thunder Wave', 'Stealth Rock'], w: 0.18, t: 'wall status hazard' }
  ]);

  P('Ferrothorn', [
    { r: 'hazard', i: 'Leftovers', a: 'Iron Barbs', n: 'Relaxed', e: [252, 0, 252, 0, 0, 4], m: ['Stealth Rock', 'Spikes', 'Leech Seed', 'Power Whip'], w: 0.30, t: 'wall hazard' , ivs: 'tr' },
    { r: 'ironpress', i: 'Rocky Helmet', a: 'Iron Barbs', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Iron Defense', 'Body Press', 'Spikes', 'Leech Seed'], w: 0.14, t: 'physical setup wall hazard' }
  ]);

  P('Skarmory', [
    { r: 'hazard', i: 'Rocky Helmet', a: 'Sturdy', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Spikes', 'Roost', 'Body Press', 'Whirlwind'], w: 0.28, t: 'wall hazard physical' },
    { r: 'defog', i: 'Leftovers', a: 'Sturdy', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Defog', 'Roost', 'Iron Defense', 'Body Press'], w: 0.12, t: 'wall hazardremoval' }
  ]);

  P('Amoonguss', [
    { r: 'wall', i: 'Black Sludge', a: 'Regenerator', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Spore', 'Sludge Bomb', 'Giga Drain', 'Foul Play'], w: 0.28, t: 'wall status' },
    { r: 'spdef', i: 'Assault Vest', a: 'Regenerator', n: 'Calm', e: [252, 0, 4, 0, 252, 0], m: ['Sludge Bomb', 'Giga Drain', 'Foul Play', 'Clear Smog'], w: 0.12, t: 'assault vest wall' }
  ]);

  P('Rillaboom', [
    { r: 'band', i: 'Choice Band', a: 'Grassy Surge', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Grassy Glide', 'Wood Hammer', 'U-turn', 'Knock Off'], w: 0.30, t: 'choice band priority physical' },
    { r: 'lo', i: 'Life Orb', a: 'Grassy Surge', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Grassy Glide', 'Wood Hammer', 'Knock Off', 'Swords Dance'], w: 0.10, t: 'physical setup priority' }
  ]);

  P('Meowscarada', [
    { r: 'band', i: 'Choice Band', a: 'Protean', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Flower Trick', 'Knock Off', 'U-turn', 'Triple Axel'], w: 0.26, t: 'choice band wallbreaker pivot' },
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Protean', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Flower Trick', 'Knock Off', 'U-turn', 'Spikes'], w: 0.14, t: 'physical pivot hazard' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Protean', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Flower Trick', 'Knock Off', 'U-turn', 'Trick'], w: 0.08, t: 'choice scarf revenge' }
  ]);

  P('Cinderace', [
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Libero', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Pyro Ball', 'U-turn', 'Sucker Punch', 'Court Change'], w: 0.24, t: 'physical pivot priority' },
    { r: 'band', i: 'Choice Band', a: 'Libero', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Pyro Ball', 'U-turn', 'Sucker Punch', 'High Jump Kick'], w: 0.12, t: 'choice band wallbreaker' }
  ]);

  P('Weavile', [
    { r: 'band', i: 'Choice Band', a: 'Pressure', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Knock Off', 'Triple Axel', 'Ice Shard', 'Low Kick'], w: 0.22, t: 'choice band priority physical' },
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Pressure', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Swords Dance', 'Knock Off', 'Triple Axel', 'Ice Shard'], w: 0.12, t: 'physical setup priority' },
    { r: 'itemless', i: null, a: 'Pressure', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Swords Dance', 'Acrobatics', 'Knock Off', 'Triple Axel'], w: 0.04, t: 'itemless acrobatics setup' }
  ]);

  P('Urshifu-Rapid-Strike', [
    { r: 'band', i: 'Choice Band', a: 'Unseen Fist', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Surging Strikes', 'Close Combat', 'Aqua Jet', 'U-turn'], w: 0.28, t: 'choice band priority physical' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Unseen Fist', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Surging Strikes', 'Close Combat', 'U-turn', 'Aqua Jet'], w: 0.16, t: 'choice scarf revenge' },
    { r: 'pads', i: 'Punching Glove', a: 'Unseen Fist', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Surging Strikes', 'Close Combat', 'Aqua Jet', 'Swords Dance'], w: 0.08, t: 'physical setup priority' }
  ]);

  P('Baxcalibur', [
    { r: 'setup', i: 'Loaded Dice', a: 'Thermal Exchange', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Dragon Dance', 'Icicle Spear', 'Glaive Rush', 'Earthquake'], w: 0.24, t: 'physical setup' },
    { r: 'band', i: 'Choice Band', a: 'Thermal Exchange', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Glaive Rush', 'Icicle Crash', 'Earthquake', 'Ice Shard'], w: 0.12, t: 'choice band wallbreaker' }
  ]);

  P('Sneasler', [
    { r: 'setup', i: 'Air Balloon', a: 'Unburden', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Swords Dance', 'Close Combat', 'Dire Claw', 'Acrobatics'], w: 0.24, t: 'physical setup unburden' },
    { r: 'band', i: 'Choice Band', a: 'Poison Touch', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Close Combat', 'Dire Claw', 'Throat Chop', 'U-turn'], w: 0.10, t: 'choice band wallbreaker' }
  ]);

  P('Iron Moth', [
    { r: 'booster', i: 'Booster Energy', a: 'Quark Drive', n: 'Timid', e: [4, 0, 0, 252, 0, 252], m: ['Fiery Dance', 'Sludge Wave', 'Energy Ball', 'Psychic'], w: 0.28, t: 'booster special' },
    { r: 'specs', i: 'Choice Specs', a: 'Quark Drive', n: 'Timid', e: [4, 0, 0, 252, 0, 252], m: ['Fiery Dance', 'Sludge Wave', 'Energy Ball', 'U-turn'], w: 0.10, t: 'choice specs special' }
  ]);

  P('Iron Treads', [
    { r: 'hazard', i: 'Booster Energy', a: 'Quark Drive', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Stealth Rock', 'Rapid Spin', 'Earthquake', 'Iron Head'], w: 0.26, t: 'hazard hazardremoval physical' },
    { r: 'band', i: 'Choice Band', a: 'Quark Drive', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Earthquake', 'Iron Head', 'Knock Off', 'Rapid Spin'], w: 0.08, t: 'choice band physical' }
  ]);

  P('Iron Hands', [
    { r: 'setup', i: 'Booster Energy', a: 'Quark Drive', n: 'Adamant', e: [252, 252, 0, 0, 4, 0], m: ['Drain Punch', 'Wild Charge', 'Swords Dance', 'Ice Punch'], w: 0.26, t: 'booster physical setup' },
    { r: 'assault', i: 'Assault Vest', a: 'Quark Drive', n: 'Adamant', e: [252, 252, 0, 0, 4, 0], m: ['Drain Punch', 'Wild Charge', 'Ice Punch', 'Volt Switch'], w: 0.12, t: 'assault vest wall' }
  ]);

  P('Iron Jugulis', [
    { r: 'booster', i: 'Booster Energy', a: 'Quark Drive', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Hurricane', 'Dark Pulse', 'Fire Blast', 'Earth Power'], w: 0.18, t: 'booster special' },
    { r: 'specs', i: 'Choice Specs', a: 'Quark Drive', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Hurricane', 'Dark Pulse', 'Fire Blast', 'U-turn'], w: 0.08, t: 'choice specs special' }
  ]);

  P('Iron Boulder', [
    { r: 'booster', i: 'Booster Energy', a: 'Quark Drive', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Mighty Cleave', 'Close Combat', 'Swords Dance', 'Zen Headbutt'], w: 0.24, t: 'booster physical setup' },
    { r: 'band', i: 'Choice Band', a: 'Quark Drive', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Mighty Cleave', 'Close Combat', 'Zen Headbutt', 'Earthquake'], w: 0.08, t: 'choice band physical' }
  ]);

  P('Iron Crown', [
    { r: 'booster', i: 'Booster Energy', a: 'Quark Drive', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Tachyon Cutter', 'Volt Switch', 'Focus Blast', 'Calm Mind'], w: 0.24, t: 'booster special setup' },
    { r: 'specs', i: 'Choice Specs', a: 'Quark Drive', n: 'Modest', e: [0, 0, 0, 252, 4, 252], m: ['Tachyon Cutter', 'Psychic Noise', 'Focus Blast', 'Volt Switch'], w: 0.09, t: 'choice specs special' }
  ]);

  P('Flutter Mane', [
    { r: 'booster', i: 'Booster Energy', a: 'Protosynthesis', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Moonblast', 'Shadow Ball', 'Thunderbolt', 'Calm Mind'], w: 0.26, t: 'booster special' },
    { r: 'specs', i: 'Choice Specs', a: 'Protosynthesis', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Moonblast', 'Shadow Ball', 'Power Gem', 'Mystical Fire'], w: 0.10, t: 'choice specs special' }
  ]);

  P('Scream Tail', [
    { r: 'booster', i: 'Booster Energy', a: 'Protosynthesis', n: 'Timid', e: [0, 0, 252, 0, 4, 252], m: ['Wish', 'Protect', 'Dazzling Gleam', 'Encore'], w: 0.14, t: 'wall wish booster' }
  ]);

  P('Sandy Shocks', [
    { r: 'booster', i: 'Booster Energy', a: 'Protosynthesis', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Earth Power', 'Thunderbolt', 'Volt Switch', 'Stealth Rock'], w: 0.14, t: 'booster special hazard' }
  ]);

  P('Slither Wing', [
    { r: 'booster', i: 'Booster Energy', a: 'Protosynthesis', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Close Combat', 'First Impression', 'U-turn', 'Flare Blitz'], w: 0.14, t: 'booster physical priority' }
  ]);

  P('Brute Bonnet', [
    { r: 'booster', i: 'Booster Energy', a: 'Protosynthesis', n: 'Adamant', e: [252, 252, 0, 0, 4, 0], m: ['Sucker Punch', 'Close Combat', 'Spore', 'Crunch'], w: 0.14, t: 'booster physical priority status' }
  ]);

  P('Kyurem-Black', [
    { r: 'setup', i: 'Loaded Dice', a: 'Teravolt', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Dragon Dance', 'Icicle Spear', 'Fusion Bolt', 'Scale Shot'], w: 0.24, t: 'physical setup' },
    { r: 'band', i: 'Choice Band', a: 'Teravolt', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Fusion Bolt', 'Icicle Crash', 'Dragon Claw', 'Stone Edge'], w: 0.10, t: 'choice band wallbreaker' }
  ]);

  P('Kyurem', [
    { r: 'specs', i: 'Choice Specs', a: 'Pressure', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Freeze-Dry', 'Draco Meteor', 'Earth Power', 'Ice Beam'], w: 0.24, t: 'choice specs special' },
    { r: 'setup', i: 'Heavy-Duty Boots', a: 'Pressure', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Substitute', 'Freeze-Dry', 'Earth Power', 'Roost'], w: 0.12, t: 'special setup' }
  ]);

  P('Blacephalon', [
    { r: 'specs', i: 'Choice Specs', a: 'Beast Boost', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Shadow Ball', 'Fire Blast', 'Psyshock', 'Trick'], w: 0.26, t: 'choice specs special' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Beast Boost', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Shadow Ball', 'Fire Blast', 'Psyshock', 'Trick'], w: 0.12, t: 'choice scarf revenge' },
    { r: 'z', i: 'Ghostium Z', a: 'Beast Boost', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Never-Ending Nightmare', 'Fire Blast', 'Psyshock', 'Calm Mind'], w: 0.06, t: 'z zcrystal special setup' }
  ]);

  P('Victini', [
    { r: 'setup', i: 'Leftovers', a: 'Victory Star', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['V-create', 'Bolt Strike', 'Glaciate', 'Encore'], w: 0.16, t: 'physical setup' },
    { r: 'z', i: 'Firium Z', a: 'Victory Star', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Inferno Overdrive', 'V-create', 'Bolt Strike', 'U-turn'], w: 0.12, t: 'z zcrystal wallbreaker' },
    { r: 'band', i: 'Choice Band', a: 'Victory Star', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['V-create', 'Bolt Strike', 'U-turn', 'Glaciate'], w: 0.08, t: 'choice band wallbreaker' }
  ]);

  P('Volcanion', [
    { r: 'specs', i: 'Choice Specs', a: 'Water Absorb', n: 'Modest', e: [0, 0, 0, 252, 4, 252], m: ['Steam Eruption', 'Flamethrower', 'Earth Power', 'Sludge Bomb'], w: 0.20, t: 'choice specs special' },
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Water Absorb', n: 'Modest', e: [0, 0, 0, 252, 4, 252], m: ['Steam Eruption', 'Flamethrower', 'Earth Power', 'Sludge Bomb'], w: 0.10, t: 'special boots' }
  ]);

  P('Magearna', [
    { r: 'setup', i: 'Leftovers', a: 'Soul-Heart', n: 'Modest', e: [252, 0, 0, 252, 4, 0], m: ['Calm Mind', 'Fleur Cannon', 'Flash Cannon', 'Shift Gear'], w: 0.28, t: 'special setup' },
    { r: 'assault', i: 'Assault Vest', a: 'Soul-Heart', n: 'Modest', e: [252, 0, 0, 252, 4, 0], m: ['Fleur Cannon', 'Flash Cannon', 'Volt Switch', 'Ice Beam'], w: 0.14, t: 'assault vest special' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Soul-Heart', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Fleur Cannon', 'Flash Cannon', 'Volt Switch', 'Trick'], w: 0.08, t: 'choice scarf revenge' }
  ]);

  P('Porygon-Z', [
    { r: 'z', i: 'Normalium Z', a: 'Adaptability', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Conversion', 'Tri Attack', 'Ice Beam', 'Thunderbolt'], w: 0.22, t: 'z zcrystal special setup' },
    { r: 'specs', i: 'Choice Specs', a: 'Adaptability', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Tri Attack', 'Ice Beam', 'Thunderbolt', 'Dark Pulse'], w: 0.10, t: 'choice specs special' }
  ]);

  P('Hydrapple', [
    { r: 'setup', i: 'Leftovers', a: 'Regenerator', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Nasty Plot', 'Fickle Beam', 'Giga Drain', 'Earth Power'], w: 0.20, t: 'special setup wall' },
    { r: 'specs', i: 'Choice Specs', a: 'Regenerator', n: 'Modest', e: [252, 0, 0, 252, 4, 0], m: ['Fickle Beam', 'Giga Drain', 'Earth Power', 'Sludge Bomb'], w: 0.08, t: 'choice specs special' }
  ]);

  P('Hoopa-Unbound', [
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Magician', n: 'Mild', e: [0, 128, 0, 128, 0, 252], m: ['Hyperspace Fury', 'Psychic', 'Focus Blast', 'Nasty Plot'], w: 0.20, t: 'mixed setup boots' },
    { r: 'z', i: 'Darkinium Z', a: 'Magician', n: 'Mild', e: [0, 136, 0, 120, 0, 252], m: ['Black Hole Eclipse', 'Hyperspace Fury', 'Focus Blast', 'Psychic'], w: 0.08, t: 'z zcrystal wallbreaker' }
  ]);

  P('Zapdos', [
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Static', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Thunderbolt', 'Hurricane', 'Volt Switch', 'Roost'], w: 0.24, t: 'special pivot boots' },
    { r: 'defensive', i: 'Heavy-Duty Boots', a: 'Static', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Discharge', 'Hurricane', 'Roost', 'U-turn'], w: 0.12, t: 'wall special' }
  ]);

  P('Moltres', [
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Flame Body', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Flamethrower', 'Hurricane', 'Roost', 'U-turn'], w: 0.20, t: 'special pivot boots' },
    { r: 'defensive', i: 'Heavy-Duty Boots', a: 'Flame Body', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Flamethrower', 'Will-O-Wisp', 'Roost', 'Defog'], w: 0.10, t: 'wall hazardremoval status' }
  ]);

  P('Zapdos-Galar', [
    { r: 'band', i: 'Choice Band', a: 'Defiant', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Close Combat', 'Brave Bird', 'Thunderous Kick', 'U-turn'], w: 0.22, t: 'choice band wallbreaker' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Defiant', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Close Combat', 'Brave Bird', 'Thunderous Kick', 'U-turn'], w: 0.10, t: 'choice scarf revenge' }
  ]);

  P('Thundurus-Therian', [
    { r: 'itemless', i: null, a: 'Volt Absorb', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Nasty Plot', 'Thunderbolt', 'Grass Knot', 'Psychic'], w: 0.16, t: 'itemless setup special' },
    { r: 'booster', i: 'Heavy-Duty Boots', a: 'Volt Absorb', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Thunderbolt', 'Volt Switch', 'Grass Knot', 'Thunder Wave'], w: 0.10, t: 'special pivot' }
  ]);

  P('Tornadus-Therian', [
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Regenerator', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Bleakwind Storm', 'U-turn', 'Knock Off', 'Taunt'], w: 0.28, t: 'special pivot boots' },
    { r: 'nasty', i: 'Life Orb', a: 'Regenerator', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Nasty Plot', 'Bleakwind Storm', 'Focus Blast', 'U-turn'], w: 0.10, t: 'special setup' }
  ]);

  P('Keldeo', [
    { r: 'specs', i: 'Choice Specs', a: 'Justified', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Secret Sword', 'Hydro Pump', 'Icy Wind', 'Vacuum Wave'], w: 0.18, t: 'choice specs special priority' },
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Justified', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Secret Sword', 'Hydro Pump', 'Calm Mind', 'Substitute'], w: 0.08, t: 'special setup' }
  ]);

  P('Tapu Koko', [
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Electric Surge', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Thunderbolt', 'Dazzling Gleam', 'Roost', 'U-turn'], w: 0.22, t: 'special pivot terrain' },
    { r: 'specs', i: 'Choice Specs', a: 'Electric Surge', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Thunderbolt', 'Dazzling Gleam', 'Volt Switch', 'Roost'], w: 0.10, t: 'choice specs special' }
  ]);

  P('Tapu Lele', [
    { r: 'specs', i: 'Choice Specs', a: 'Psychic Surge', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Psychic', 'Moonblast', 'Psyshock', 'Focus Blast'], w: 0.26, t: 'choice specs special terrain' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Psychic Surge', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Psychic', 'Moonblast', 'Psyshock', 'Nature\'s Madness'], w: 0.12, t: 'choice scarf revenge' },
    { r: 'setup', i: 'Twisted Spoon', a: 'Psychic Surge', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Calm Mind', 'Psychic', 'Moonblast', 'Focus Blast'], w: 0.06, t: 'special setup' }
  ]);

  P('Tapu Fini', [
    { r: 'setup', i: 'Leftovers', a: 'Misty Surge', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Calm Mind', 'Moonblast', 'Surf', 'Draining Kiss'], w: 0.16, t: 'special setup wall terrain' }
  ]);

  P('Tapu Bulu', [
    { r: 'band', i: 'Choice Band', a: 'Grassy Surge', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Wood Hammer', 'Horn Leech', 'Close Combat', 'Stone Edge'], w: 0.14, t: 'choice band wallbreaker' }
  ]);

  P('Kartana', [
    { r: 'band', i: 'Choice Band', a: 'Beast Boost', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Leaf Blade', 'Sacred Sword', 'Knock Off', 'Smart Strike'], w: 0.28, t: 'choice band wallbreaker' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Beast Boost', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Leaf Blade', 'Sacred Sword', 'Knock Off', 'Smart Strike'], w: 0.12, t: 'choice scarf revenge' },
    { r: 'z', i: 'Grassium Z', a: 'Beast Boost', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Bloom Doom', 'Sacred Sword', 'Knock Off', 'Swords Dance'], w: 0.06, t: 'z zcrystal physical setup' }
  ]);

  P('Excadrill', [
    { r: 'sand', i: 'Life Orb', a: 'Sand Rush', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Earthquake', 'Iron Head', 'Rock Slide', 'Rapid Spin'], w: 0.18, t: 'physical speedbooster sand' },
    { r: 'lead', i: 'Focus Sash', a: 'Mold Breaker', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Stealth Rock', 'Earthquake', 'Rapid Spin', 'Rock Slide'], w: 0.10, t: 'hazard lead hazardremoval' }
  ]);

  P('Torkoal', [
    { r: 'sun', i: 'Heat Rock', a: 'Drought', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Stealth Rock', 'Lava Plume', 'Body Press', 'Rapid Spin'], w: 0.20, t: 'sun wall hazard' }
  ]);

  P('Pelipper', [
    { r: 'rain', i: 'Damp Rock', a: 'Drizzle', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Scald', 'Hurricane', 'Roost', 'U-turn'], w: 0.18, t: 'rain wall pivot' }
  ]);

  P('Ninetales-Alola', [
    { r: 'snow', i: 'Light Clay', a: 'Snow Warning', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Aurora Veil', 'Freeze-Dry', 'Moonblast', 'Encore'], w: 0.20, t: 'snow special screens' }
  ]);

  P('Pincurchin', [
    { r: 'terrain', i: 'Terrain Extender', a: 'Electric Surge', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Spikes', 'Discharge', 'Recover', 'Memento'], w: 0.10, t: 'terrain hazard support' }
  ]);

  P('Porygon2', [
    { r: 'tr', i: 'Eviolite', a: 'Trace', n: 'Sassy', e: [252, 0, 0, 252, 4, 0], m: ['Trick Room', 'Ice Beam', 'Recover', 'Thunderbolt'], w: 0.24, t: 'trickroom special wall', ivs: 'tr' },
    { r: 'wall', i: 'Eviolite', a: 'Trace', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Ice Beam', 'Thunderbolt', 'Recover', 'Toxic'], w: 0.12, t: 'wall special' }
  ]);

  P('Cresselia', [
    { r: 'tr', i: 'Leftovers', a: 'Levitate', n: 'Sassy', e: [252, 0, 252, 0, 4, 0], m: ['Trick Room', 'Lunar Dance', 'Moonblast', 'Ice Beam'], w: 0.20, t: 'trickroom wall support', ivs: 'tr' },
    { r: 'wall', i: 'Leftovers', a: 'Levitate', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Moonblast', 'Psyshock', 'Moonlight', 'Thunder Wave'], w: 0.10, t: 'wall special status' }
  ]);

  P('Hatterene', [
    { r: 'tr', i: 'Leftovers', a: 'Magic Bounce', n: 'Quiet', e: [252, 0, 0, 252, 4, 0], m: ['Trick Room', 'Dazzling Gleam', 'Psychic', 'Draining Kiss'], w: 0.22, t: 'trickroom special setup', ivs: 'tr' },
    { r: 'setup', i: 'Leftovers', a: 'Magic Bounce', n: 'Modest', e: [252, 0, 0, 252, 4, 0], m: ['Calm Mind', 'Dazzling Gleam', 'Psychic', 'Draining Kiss'], w: 0.10, t: 'special setup wall', ivs: 'tr' }
  ]);

  P('Reuniclus', [
    { r: 'tr', i: 'Life Orb', a: 'Magic Guard', n: 'Quiet', e: [252, 0, 0, 252, 4, 0], m: ['Trick Room', 'Psychic', 'Focus Blast', 'Recover'], w: 0.18, t: 'trickroom special', ivs: 'tr' },
    { r: 'calm', i: 'Leftovers', a: 'Magic Guard', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Calm Mind', 'Psyshock', 'Recover', 'Focus Blast'], w: 0.12, t: 'special setup wall' }
  ]);

  P('Armarouge', [
    { r: 'tr', i: 'Life Orb', a: 'Weak Armor', n: 'Quiet', e: [252, 0, 0, 252, 4, 0], m: ['Trick Room', 'Armor Cannon', 'Expanding Force', 'Focus Blast'], w: 0.18, t: 'trickroom special', ivs: 'tr' },
    { r: 'specs', i: 'Choice Specs', a: 'Flash Fire', n: 'Modest', e: [252, 0, 0, 252, 4, 0], m: ['Armor Cannon', 'Expanding Force', 'Focus Blast', 'Shadow Ball'], w: 0.08, t: 'choice specs special' }
  ]);

  P('Mimikyu', [
    { r: 'tr', i: 'Life Orb', a: 'Disguise', n: 'Brave', e: [252, 252, 0, 0, 4, 0], m: ['Trick Room', 'Play Rough', 'Shadow Claw', 'Shadow Sneak'], w: 0.14, t: 'trickroom physical priority', ivs: 'tr' },
    { r: 'setup', i: 'Life Orb', a: 'Disguise', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Swords Dance', 'Play Rough', 'Shadow Claw', 'Shadow Sneak'], w: 0.10, t: 'physical setup priority' }
  ]);

  P('Aegislash', [
    { r: 'specs', i: 'Choice Specs', a: 'Stance Change', n: 'Modest', e: [252, 0, 0, 252, 4, 0], m: ['Shadow Ball', 'Flash Cannon', 'Steel Beam', 'King\'s Shield'], w: 0.20, t: 'choice specs special' },
    { r: 'mixed', i: 'Leftovers', a: 'Stance Change', n: 'Brave', e: [252, 252, 0, 0, 4, 0], m: ['King\'s Shield', 'Sacred Sword', 'Shadow Ball', 'Shadow Sneak'], w: 0.10, t: 'mixed setup', ivs: 'tr' }
  ]);

  P('Skeledirge', [
    { r: 'torch', i: 'Heavy-Duty Boots', a: 'Unaware', n: 'Modest', e: [252, 0, 0, 252, 4, 0], m: ['Torch Song', 'Shadow Ball', 'Slack Off', 'Will-O-Wisp'], w: 0.20, t: 'special wall setup' }
  ]);

  P('Grimmsnarl', [
    { r: 'screens', i: 'Light Clay', a: 'Prankster', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Reflect', 'Light Screen', 'Spirit Break', 'Thunder Wave'], w: 0.18, t: 'screens priority support' }
  ]);

  P('Regidrago', [
    { r: 'specs', i: 'Choice Specs', a: 'Dragon\'s Maw', n: 'Modest', e: [4, 0, 0, 252, 0, 252], m: ['Dragon Energy', 'Draco Meteor', 'Dragon Pulse', 'Earth Power'], w: 0.14, t: 'choice specs wallbreaker' }
  ]);

  P('Enamorus', [
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Contrary', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Moonblast', 'Earth Power', 'Superpower', 'Taunt'], w: 0.16, t: 'special pivot' },
    { r: 'specs', i: 'Choice Specs', a: 'Contrary', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Moonblast', 'Earth Power', 'Mystical Fire', 'Psychic'], w: 0.08, t: 'choice specs special' }
  ]);

  P('Annihilape', [
    { r: 'bulkup', i: 'Leftovers', a: 'Defiant', n: 'Adamant', e: [252, 252, 0, 0, 4, 0], m: ['Bulk Up', 'Drain Punch', 'Rage Fist', 'Taunt'], w: 0.20, t: 'physical setup' }
  ]);

  P('Dondozo', [
    { r: 'wall', i: 'Leftovers', a: 'Unaware', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Wave Crash', 'Rest', 'Sleep Talk', 'Curse'], w: 0.18, t: 'wall physical setup' }
  ]);

  P('Chi-Yu', [
    { r: 'specs', i: 'Choice Specs', a: 'Beads of Ruin', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Overheat', 'Dark Pulse', 'Psychic', 'Flame Charge'], w: 0.24, t: 'choice specs wallbreaker' },
    { r: 'scarf', i: 'Choice Scarf', a: 'Beads of Ruin', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Overheat', 'Dark Pulse', 'Psychic', 'Trick'], w: 0.10, t: 'choice scarf revenge' }
  ]);

  P('Chien-Pao', [
    { r: 'band', i: 'Choice Band', a: 'Sword of Ruin', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Icicle Crash', 'Crunch', 'Ice Shard', 'Sacred Sword'], w: 0.26, t: 'choice band priority wallbreaker' },
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Sword of Ruin', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Icicle Crash', 'Crunch', 'Ice Shard', 'Swords Dance'], w: 0.10, t: 'physical setup priority' }
  ]);

  P('Wo-Chien', [
    { r: 'wall', i: 'Leftovers', a: 'Tablets of Ruin', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Foul Play', 'Leech Seed', 'Ruination', 'Protect'], w: 0.14, t: 'wall status' }
  ]);

  P('Ursaluna-Bloodmoon', [
    { r: 'bloodmoon', i: 'Leftovers', a: 'Mind\'s Eye', n: 'Modest', e: [252, 0, 0, 252, 4, 0], m: ['Blood Moon', 'Earth Power', 'Vacuum Wave', 'Calm Mind'], w: 0.18, t: 'special wallbreaker' }
  ]);

  P('Sneasler', [
    { r: 'scarf', i: 'Choice Scarf', a: 'Poison Touch', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Close Combat', 'Dire Claw', 'Switcheroo', 'Throat Chop'], w: 0.06, t: 'choice scarf revenge' }
  ]);

  P('Ninetales-Alola', [
    { r: 'nasty', i: 'Icy Rock', a: 'Snow Warning', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Nasty Plot', 'Freeze-Dry', 'Moonblast', 'Blizzard'], w: 0.06, t: 'snow special setup' }
  ]);

  P('Hoopa-Unbound', [
    { r: 'scarf', i: 'Choice Scarf', a: 'Magician', n: 'Naive', e: [0, 136, 0, 120, 0, 252], m: ['Hyperspace Fury', 'Psychic', 'Focus Blast', 'Trick'], w: 0.06, t: 'choice scarf revenge' }
  ]);

  /* ---------------------------------------------------------------- Trick Room staples */

  P('Dusclops', [
    { r: 'tr', i: 'Eviolite', a: 'Frisk', n: 'Relaxed', e: [252, 0, 252, 0, 4, 0], m: ['Trick Room', 'Pain Split', 'Night Shade', 'Will-O-Wisp'], w: 0.22, t: 'trickroom wall support', ivs: 'tr' },
    { r: 'tr-support', i: 'Eviolite', a: 'Pressure', n: 'Sassy', e: [252, 0, 252, 0, 4, 0], m: ['Trick Room', 'Memento', 'Night Shade', 'Helping Hand'], w: 0.08, t: 'trickroom support', ivs: 'tr' }
  ]);

  P('Bronzong', [
    { r: 'tr', i: 'Leftovers', a: 'Levitate', n: 'Sassy', e: [252, 0, 252, 0, 4, 0], m: ['Trick Room', 'Gyro Ball', 'Earthquake', 'Stealth Rock'], w: 0.18, t: 'trickroom wall hazard', ivs: 'tr' }
  ]);

  P('Farigiraf', [
    { r: 'tr', i: 'Assault Vest', a: 'Armor Tail', n: 'Quiet', e: [252, 0, 0, 252, 4, 0], m: ['Trick Room', 'Hyper Voice', 'Psychic', 'Foul Play'], w: 0.12, t: 'trickroom special', ivs: 'tr' }
  ]);

  P('Oranguru', [
    { r: 'tr', i: 'Mental Herb', a: 'Inner Focus', n: 'Relaxed', e: [252, 0, 252, 0, 4, 0], m: ['Trick Room', 'Instruct', 'Foul Play', 'Psychic'], w: 0.10, t: 'trickroom support', ivs: 'tr' }
  ]);

  P('Slowbro', [
    { r: 'tr', i: 'Heavy-Duty Boots', a: 'Regenerator', n: 'Relaxed', e: [252, 0, 252, 0, 4, 0], m: ['Trick Room', 'Scald', 'Future Sight', 'Slack Off'], w: 0.14, t: 'trickroom wall pivot', ivs: 'tr' },
    { r: 'wall', i: 'Rocky Helmet', a: 'Regenerator', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Scald', 'Future Sight', 'Slack Off', 'Thunder Wave'], w: 0.10, t: 'wall special' }
  ]);

  P('Cofagrigus', [
    { r: 'tr', i: 'Leftovers', a: 'Mummy', n: 'Quiet', e: [252, 0, 0, 252, 4, 0], m: ['Trick Room', 'Shadow Ball', 'Body Press', 'Nasty Plot'], w: 0.10, t: 'trickroom special', ivs: 'tr' }
  ]);

  P('Marowak-Alola', [
    { r: 'tr', i: 'Thick Club', a: 'Rock Head', n: 'Brave', e: [252, 252, 0, 0, 4, 0], m: ['Flare Blitz', 'Bonemerang', 'Shadow Bone', 'Swords Dance'], w: 0.10, t: 'trickroom physical wallbreaker', ivs: 'tr' }
  ]);

  P('Crawdaunt', [
    { r: 'tr', i: 'Life Orb', a: 'Adaptability', n: 'Brave', e: [252, 252, 0, 0, 4, 0], m: ['Crabhammer', 'Knock Off', 'Aqua Jet', 'Swords Dance'], w: 0.10, t: 'trickroom physical priority', ivs: 'tr' }
  ]);

  P('Glastrier', [
    { r: 'tr', i: 'Leftovers', a: 'Chilling Neigh', n: 'Brave', e: [252, 252, 0, 0, 4, 0], m: ['Icicle Crash', 'High Horsepower', 'Swords Dance', 'Crunch'], w: 0.10, t: 'trickroom physical setup', ivs: 'tr' }
  ]);

  /* ---------------------------------------------------------------- Megas */

  P('Venusaur', [
    { r: 'mega', i: 'Venusaurite', a: 'Chlorophyll', n: 'Modest', e: [252, 0, 0, 252, 4, 0], m: ['Giga Drain', 'Sludge Bomb', 'Earth Power', 'Growth'], w: 0.16, t: 'mega special setup sun' },
    { r: 'sun', i: 'Life Orb', a: 'Chlorophyll', n: 'Modest', e: [0, 0, 0, 252, 4, 252], m: ['Giga Drain', 'Sludge Bomb', 'Weather Ball', 'Growth'], w: 0.06, t: 'special sun' }
  ]);

  P('Charizard', [
    { r: 'mega-x', i: 'Charizardite X', a: 'Blaze', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Dragon Dance', 'Flare Blitz', 'Dragon Claw', 'Earthquake'], w: 0.14, t: 'mega physical setup' },
    { r: 'mega-y', i: 'Charizardite Y', a: 'Blaze', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Flamethrower', 'Solar Beam', 'Roost', 'Dragon Pulse'], w: 0.12, t: 'mega special sun' },
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Blaze', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Flamethrower', 'Hurricane', 'Roost', 'Will-O-Wisp'], w: 0.05, t: 'special boots' }
  ]);

  P('Scizor', [
    { r: 'mega', i: 'Scizorite', a: 'Technician', n: 'Adamant', e: [248, 252, 0, 0, 8, 0], m: ['Bullet Punch', 'Bug Bite', 'Swords Dance', 'Roost'], w: 0.18, t: 'mega physical setup priority' },
    { r: 'band', i: 'Choice Band', a: 'Technician', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Bullet Punch', 'U-turn', 'Knock Off', 'Close Combat'], w: 0.10, t: 'choice band priority' }
  ]);

  P('Metagross', [
    { r: 'mega', i: 'Metagrossite', a: 'Clear Body', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Meteor Mash', 'Zen Headbutt', 'Earthquake', 'Bullet Punch'], w: 0.16, t: 'mega physical wallbreaker' }
  ]);

  P('Lopunny', [
    { r: 'mega', i: 'Lopunnite', a: 'Limber', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Fake Out', 'Close Combat', 'Return', 'Ice Punch'], w: 0.18, t: 'mega physical priority' }
  ]);

  P('Diancie', [
    { r: 'mega', i: 'Diancite', a: 'Clear Body', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Moonblast', 'Diamond Storm', 'Earth Power', 'Protect'], w: 0.16, t: 'mega special' }
  ]);

  P('Latias', [
    { r: 'mega', i: 'Latiasite', a: 'Levitate', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Calm Mind', 'Stored Power', 'Aura Sphere', 'Roost'], w: 0.12, t: 'mega special setup' },
    { r: 'specs', i: 'Choice Specs', a: 'Levitate', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Draco Meteor', 'Psychic', 'Mystical Fire', 'Healing Wish'], w: 0.06, t: 'choice specs special' }
  ]);

  P('Tyranitar', [
    { r: 'mega', i: 'Tyranitarite', a: 'Sand Stream', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Stone Edge', 'Crunch', 'Dragon Dance', 'Ice Punch'], w: 0.14, t: 'mega physical setup sand' },
    { r: 'band', i: 'Choice Band', a: 'Sand Stream', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Stone Edge', 'Crunch', 'Pursuit', 'Ice Punch'], w: 0.08, t: 'choice band wallbreaker sand' }
  ]);

  P('Gyarados', [
    { r: 'mega', i: 'Gyaradosite', a: 'Intimidate', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Dragon Dance', 'Waterfall', 'Crunch', 'Earthquake'], w: 0.14, t: 'mega physical setup' },
    { r: 'setup', i: 'Heavy-Duty Boots', a: 'Intimidate', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Dragon Dance', 'Waterfall', 'Bounce', 'Taunt'], w: 0.08, t: 'physical setup' }
  ]);

  P('Mawile', [
    { r: 'mega', i: 'Mawilite', a: 'Intimidate', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Play Rough', 'Sucker Punch', 'Knock Off', 'Swords Dance'], w: 0.16, t: 'mega physical setup priority' }
  ]);

  P('Swampert', [
    { r: 'mega', i: 'Swampertite', a: 'Damp', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Waterfall', 'Earthquake', 'Ice Punch', 'Stealth Rock'], w: 0.16, t: 'mega physical rain' }
  ]);

  P('Alakazam', [
    { r: 'mega', i: 'Alakazite', a: 'Magic Guard', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Psychic', 'Focus Blast', 'Shadow Ball', 'Recover'], w: 0.14, t: 'mega special' },
    { r: 'sash', i: 'Focus Sash', a: 'Magic Guard', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Psychic', 'Focus Blast', 'Shadow Ball', 'Counter'], w: 0.06, t: 'special suicide' }
  ]);

  P('Medicham', [
    { r: 'mega', i: 'Medichamite', a: 'Pure Power', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Close Combat', 'Zen Headbutt', 'Ice Punch', 'Fake Out'], w: 0.14, t: 'mega physical wallbreaker' }
  ]);

  P('Aerodactyl', [
    { r: 'mega', i: 'Aerodactylite', a: 'Rock Head', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Stone Edge', 'Dual Wingbeat', 'Earthquake', 'Roost'], w: 0.12, t: 'mega physical' }
  ]);

  P('Sableye', [
    { r: 'mega', i: 'Sablenite', a: 'Keen Eye', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Will-O-Wisp', 'Recover', 'Knock Off', 'Foul Play'], w: 0.12, t: 'mega wall status' }
  ]);

  P('Slowbro', [
    { r: 'mega', i: 'Slowbronite', a: 'Oblivious', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Scald', 'Slack Off', 'Future Sight', 'Iron Defense'], w: 0.10, t: 'mega wall special' }
  ]);

  P('Garchomp', [
    { r: 'mega', i: 'Garchompite', a: 'Sand Veil', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Earthquake', 'Dragon Claw', 'Stone Edge', 'Swords Dance'], w: 0.06, t: 'mega physical setup' , notes: 'Mega Garchomp trades Speed for bulk and attack' }
  ]);

  P('Blaziken', [
    { r: 'mega', i: 'Blazikenite', a: 'Speed Boost', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Flare Blitz', 'Close Combat', 'Knock Off', 'Swords Dance'], w: 0.14, t: 'mega physical setup speedbooster' },
    { r: 'boots', i: 'Heavy-Duty Boots', a: 'Speed Boost', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Flare Blitz', 'Close Combat', 'Knock Off', 'Swords Dance'], w: 0.06, t: 'physical setup speedbooster' }
  ]);

  P('Lucario', [
    { r: 'mega', i: 'Lucarionite', a: 'Inner Focus', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Close Combat', 'Extreme Speed', 'Meteor Mash', 'Swords Dance'], w: 0.12, t: 'mega physical setup priority' }
  ]);

  P('Heracross', [
    { r: 'mega', i: 'Heracronite', a: 'Moxie', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Close Combat', 'Pin Missile', 'Rock Blast', 'Swords Dance'], w: 0.10, t: 'mega physical wallbreaker' }
  ]);

  P('Pinsir', [
    { r: 'mega', i: 'Pinsirite', a: 'Hyper Cutter', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Swords Dance', 'Return', 'Close Combat', 'Quick Attack'], w: 0.10, t: 'mega physical setup priority' }
  ]);

  P('Kangaskhan', [
    { r: 'mega', i: 'Kangaskhanite', a: 'Scrappy', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Fake Out', 'Sucker Punch', 'Double-Edge', 'Earthquake'], w: 0.10, t: 'mega physical priority' }
  ]);

  P('Manectric', [
    { r: 'mega', i: 'Manectite', a: 'Lightning Rod', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Thunderbolt', 'Volt Switch', 'Flamethrower', 'Hidden Power Ice'], w: 0.10, t: 'mega special pivot' }
  ]);

  P('Gardevoir', [
    { r: 'mega', i: 'Gardevoirite', a: 'Trace', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Hyper Voice', 'Psyshock', 'Focus Blast', 'Will-O-Wisp'], w: 0.10, t: 'mega special' }
  ]);

  P('Gallade', [
    { r: 'mega', i: 'Galladite', a: 'Justified', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Close Combat', 'Zen Headbutt', 'Knock Off', 'Swords Dance'], w: 0.08, t: 'mega physical setup' }
  ]);

  P('Absol', [
    { r: 'mega', i: 'Absolite', a: 'Super Luck', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Knock Off', 'Sucker Punch', 'Play Rough', 'Swords Dance'], w: 0.08, t: 'mega physical setup priority' }
  ]);

  P('Beedrill', [
    { r: 'mega', i: 'Beedrillite', a: 'Swarm', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['U-turn', 'Poison Jab', 'Drill Run', 'Knock Off'], w: 0.08, t: 'mega physical pivot' }
  ]);

  P('Pidgeot', [
    { r: 'mega', i: 'Pidgeotite', a: 'Keen Eye', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Hurricane', 'Heat Wave', 'U-turn', 'Roost'], w: 0.08, t: 'mega special pivot' }
  ]);

  P('Ampharos', [
    { r: 'mega', i: 'Ampharosite', a: 'Static', n: 'Modest', e: [252, 0, 0, 252, 4, 0], m: ['Thunderbolt', 'Dragon Pulse', 'Volt Switch', 'Focus Blast'], w: 0.08, t: 'mega special pivot' }
  ]);

  P('Aerodactyl', [
    { r: 'suicide', i: 'Focus Sash', a: 'Rock Head', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Stealth Rock', 'Stone Edge', 'Taunt', 'Dual Wingbeat'], w: 0.06, t: 'hazard lead suicide' }
  ]);

  /* ---------------------------------------------------------------- weather & support */

  P('Politoed', [
    { r: 'rain', i: 'Damp Rock', a: 'Drizzle', n: 'Calm', e: [252, 0, 4, 0, 252, 0], m: ['Scald', 'Hypnosis', 'Encore', 'Rest'], w: 0.08, t: 'rain wall support' }
  ]);

  P('Torkoal', [
    { r: 'support', i: 'Leftovers', a: 'Drought', n: 'Relaxed', e: [252, 0, 252, 0, 4, 0], m: ['Yawn', 'Lava Plume', 'Stealth Rock', 'Rapid Spin'], w: 0.06, t: 'sun wall hazard', ivs: 'tr' }
  ]);

  P('Hippowdon', [
    { r: 'wall', i: 'Leftovers', a: 'Sand Stream', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Earthquake', 'Slack Off', 'Stealth Rock', 'Whirlwind'], w: 0.12, t: 'wall hazard sand' }
  ]);

  P('Moltres-Galar', [
    { r: 'setup', i: 'Weakness Policy', a: 'Berserk', n: 'Modest', e: [252, 0, 0, 252, 4, 0], m: ['Nasty Plot', 'Fiery Wrath', 'Hurricane', 'Agility'], w: 0.08, t: 'special setup' }
  ]);

  P('Rotom-Wash', [
    { r: 'pivot', i: 'Leftovers', a: 'Levitate', n: 'Bold', e: [248, 0, 252, 0, 8, 0], m: ['Volt Switch', 'Hydro Pump', 'Will-O-Wisp', 'Pain Split'], w: 0.14, t: 'wall pivot status' }
  ]);

  P('Weezing-Galar', [
    { r: 'wall', i: 'Black Sludge', a: 'Levitate', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Strange Steam', 'Will-O-Wisp', 'Pain Split', 'Defog'], w: 0.10, t: 'wall hazardremoval status' }
  ]);

  P('Slowbro-Galar', [
    { r: 'trickroom', i: 'Assault Vest', a: 'Regenerator', n: 'Sassy', e: [252, 0, 4, 0, 252, 0], m: ['Future Sight', 'Shell Side Arm', 'Slack Off', 'Thunder Wave'], w: 0.04, t: 'assault vest special', ivs: 'tr' }
  ]);

  P('Quagsire', [
    { r: 'unaware', i: 'Leftovers', a: 'Unaware', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Earthquake', 'Recover', 'Toxic', 'Stealth Rock'], w: 0.10, t: 'wall status hazard' }
  ]);

  P('Clodsire', [
    { r: 'tr', i: 'Leftovers', a: 'Unaware', n: 'Sassy', e: [252, 0, 252, 0, 4, 0], m: ['Earthquake', 'Recover', 'Toxic Spikes', 'Trick Room'], w: 0.04, t: 'trickroom wall hazard', ivs: 'tr' }
  ]);

  P('Kingambit', [
    { r: 'tr', i: 'Black Glasses', a: 'Supreme Overlord', n: 'Brave', e: [252, 252, 0, 0, 4, 0], m: ['Swords Dance', 'Kowtow Cleave', 'Sucker Punch', 'Iron Head'], w: 0.04, t: 'trickroom physical setup priority', ivs: 'tr' }
  ]);

  P('Ursaluna', [
    { r: 'tr', i: 'Flame Orb', a: 'Guts', n: 'Brave', e: [252, 252, 0, 0, 4, 0], m: ['Facade', 'Headlong Rush', 'Crunch', 'Swords Dance'], w: 0.12, t: 'trickroom physical wallbreaker status', ivs: 'tr' },
    { r: 'band', i: 'Choice Band', a: 'Guts', n: 'Adamant', e: [252, 252, 0, 0, 4, 0], m: ['Facade', 'Headlong Rush', 'Crunch', 'Fire Punch'], w: 0.06, t: 'choice band wallbreaker', ivs: 'tr' }
  ]);

  P('Basculegion', [
    { r: 'tr', i: 'Life Orb', a: 'Adaptability', n: 'Brave', e: [252, 252, 0, 0, 4, 0], m: ['Wave Crash', 'Last Respects', 'Aqua Jet', 'Flip Turn'], w: 0.08, t: 'trickroom physical priority', ivs: 'tr' }
  ]);

  P('Hoopa', [
    { r: 'tr', i: 'Life Orb', a: 'Magician', n: 'Quiet', e: [252, 0, 0, 252, 4, 0], m: ['Trick Room', 'Psychic', 'Focus Blast', 'Shadow Ball'], w: 0.06, t: 'trickroom special', ivs: 'tr' }
  ]);

  P('Vikavolt', [
    { r: 'tr', i: 'Life Orb', a: 'Levitate', n: 'Quiet', e: [252, 0, 0, 252, 4, 0], m: ['Thunderbolt', 'Bug Buzz', 'Energy Ball', 'Volt Switch'], w: 0.06, t: 'trickroom special', ivs: 'tr' }
  ]);

  P('Gliscor', [
    { r: 'tr', i: 'Toxic Orb', a: 'Poison Heal', n: 'Relaxed', e: [252, 4, 252, 0, 0, 0], m: ['Earthquake', 'Trick Room', 'Facade', 'Protect'], w: 0.04, t: 'trickroom wall physical', ivs: 'tr' }
  ]);

  P('Ting-Lu', [
    { r: 'tr', i: 'Leftovers', a: 'Vessel of Ruin', n: 'Sassy', e: [252, 4, 252, 0, 0, 0], m: ['Trick Room', 'Earthquake', 'Ruination', 'Stealth Rock'], w: 0.04, t: 'trickroom wall hazard', ivs: 'tr' }
  ]);

  P('Hatterene', [
    { r: 'screens', i: 'Light Clay', a: 'Magic Bounce', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Reflect', 'Light Screen', 'Dazzling Gleam', 'Healing Wish'], w: 0.04, t: 'screens special support' }
  ]);

  P('Grimmsnarl', [
    { r: 'bulkup', i: 'Leftovers', a: 'Prankster', n: 'Adamant', e: [252, 252, 0, 0, 4, 0], m: ['Bulk Up', 'Spirit Break', 'Sucker Punch', 'Thunder Wave'], w: 0.06, t: 'physical setup priority' }
  ]);

  P('Amoonguss', [
    { r: 'tr', i: 'Black Sludge', a: 'Regenerator', n: 'Sassy', e: [252, 0, 252, 0, 4, 0], m: ['Spore', 'Sludge Bomb', 'Trick Room', 'Giga Drain'], w: 0.04, t: 'trickroom wall status', ivs: 'tr' }
  ]);

  P('Bisharp', [
    { r: 'setup', i: 'Eviolite', a: 'Defiant', n: 'Adamant', e: [252, 252, 0, 0, 4, 0], m: ['Swords Dance', 'Iron Head', 'Sucker Punch', 'Low Kick'], w: 0.06, t: 'physical setup priority' }
  ]);

  P('Zoroark-Hisui', [
    { r: 'specs', i: 'Choice Specs', a: 'Illusion', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Hyper Voice', 'Shadow Ball', 'Focus Blast', 'U-turn'], w: 0.08, t: 'choice specs special' }
  ]);

  P('Samurott-Hisui', [
    { r: 'setup', i: 'Focus Sash', a: 'Sharpness', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Ceaseless Edge', 'Razor Shell', 'Sacred Sword', 'Sucker Punch'], w: 0.16, t: 'hazard physical priority' },
    { r: 'band', i: 'Choice Band', a: 'Sharpness', n: 'Adamant', e: [0, 252, 0, 0, 4, 252], m: ['Ceaseless Edge', 'Razor Shell', 'Sacred Sword', 'Aqua Jet'], w: 0.08, t: 'choice band wallbreaker' }
  ]);

  P('Kleavor', [
    { r: 'lead', i: 'Focus Sash', a: 'Sharpness', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Stone Axe', 'Close Combat', 'U-turn', 'Swords Dance'], w: 0.12, t: 'hazard physical' }
  ]);

  P('Scizor', [
    { r: 'bulky', i: 'Leftovers', a: 'Technician', n: 'Adamant', e: [248, 252, 0, 0, 8, 0], m: ['Bullet Punch', 'U-turn', 'Roost', 'Swords Dance'], w: 0.06, t: 'physical setup priority pivot' }
  ]);

  P('Celesteela', [
    { r: 'wall', i: 'Leftovers', a: 'Beast Boost', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Heavy Slam', 'Leech Seed', 'Protect', 'Flamethrower'], w: 0.10, t: 'wall special status' }
  ]);

  P('Skarmory', [
    { r: 'specially', i: 'Leftovers', a: 'Sturdy', n: 'Careful', e: [252, 4, 252, 0, 0, 0], m: ['Spikes', 'Roost', 'Body Press', 'Whirlwind'], w: 0.04, t: 'wall hazard' }
  ]);

  P('Mandibuzz', [
    { r: 'wall', i: 'Heavy-Duty Boots', a: 'Overcoat', n: 'Impish', e: [252, 0, 252, 0, 4, 0], m: ['Foul Play', 'Roost', 'Defog', 'U-turn'], w: 0.10, t: 'wall hazardremoval pivot' }
  ]);

  P('Tornadus-Therian', [
    { r: 'tr', i: 'Heavy-Duty Boots', a: 'Regenerator', n: 'Sassy', e: [252, 0, 4, 0, 252, 0], m: ['Bleakwind Storm', 'U-turn', 'Trick Room', 'Knock Off'], w: 0.04, t: 'trickroom special pivot', ivs: 'tr' }
  ]);

  P('Iron Leaves', [
    { r: 'booster', i: 'Booster Energy', a: 'Quark Drive', n: 'Jolly', e: [0, 252, 0, 0, 4, 252], m: ['Leaf Blade', 'Psyblade', 'Swords Dance', 'Close Combat'], w: 0.06, t: 'booster physical setup' }
  ]);

  P('Terapagos', [
    { r: 'setup', i: 'Leftovers', a: 'Tera Shift', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Calm Mind', 'Tera Starstorm', 'Rapid Spin', 'Rest'], w: 0.06, t: 'special setup' }
  ]);

  P('Pecharunt', [
    { r: 'wall', i: 'Heavy-Duty Boots', a: 'Poison Puppeteer', n: 'Bold', e: [252, 0, 252, 0, 4, 0], m: ['Malignant Chain', 'Shadow Ball', 'Recover', 'Parting Shot'], w: 0.06, t: 'wall status pivot' }
  ]);

  P('Okidogi', [
    { r: 'setup', i: 'Leftovers', a: 'Toxic Chain', n: 'Adamant', e: [252, 252, 0, 0, 4, 0], m: ['Bulk Up', 'Drain Punch', 'Poison Jab', 'Knock Off'], w: 0.06, t: 'physical setup' }
  ]);

  P('Munkidori', [
    { r: 'specs', i: 'Choice Specs', a: 'Toxic Chain', n: 'Timid', e: [0, 0, 0, 252, 4, 252], m: ['Psychic Noise', 'Sludge Wave', 'Focus Blast', 'U-turn'], w: 0.06, t: 'choice specs special' }
  ]);

  P('Fezandipiti', [
    { r: 'support', i: 'Heavy-Duty Boots', a: 'Toxic Chain', n: 'Careful', e: [252, 4, 252, 0, 0, 0], m: ['Play Rough', 'Roost', 'U-turn', 'Beat Up'], w: 0.04, t: 'wall pivot support' }
  ]);

  /* ==========================================================================================
   *  GENERIC FALLBACKS (used when a species is not in the database at all)
   * ========================================================================================*/

  function genericFor(speciesName) {
    const sp = U.getSpecies(speciesName);
    if (!sp) return [];
    const ability = (U.getAbilities(sp.name) || [])[0] || '';
    const phys = U.baseStats(sp.name).atk >= U.baseStats(sp.name).spa;
    const core = phys ? ['Earthquake', 'Knock Off', 'U-turn', 'Swords Dance']
      : ['Psychic', 'Shadow Ball', 'Volt Switch', 'Calm Mind'];
    const withSpecies = function (s) {
      const copy = Object.assign({}, s);
      copy.species = sp.name;
      copy.id = U.toID(sp.name) + '-' + s.role;
      copy.moves = s.moves.filter(function (m) { return !!U.getMoveData(m); });
      return copy;
    };
    return [
      withSpecies({ id: 'generic-boots', species: sp.name, role: 'bulky', item: 'Heavy-Duty Boots', ability: ability, nature: phys ? 'Adamant' : 'Modest', evs: ev(0, phys ? 252 : 0, 0, phys ? 0 : 252, 4, 252), ivs: Object.assign({}, IV_MAX), moves: core, weight: 0.34, tags: ['generic', 'boots'], isMega: false, isZCrystal: false, itemlessArchetype: false, notes: 'Generic filler set' }),
      withSpecies({ id: 'generic-leftovers', species: sp.name, role: 'wall', item: 'Leftovers', ability: ability, nature: 'Bold', evs: ev(252, 0, 252, 0, 4, 0), ivs: Object.assign({}, IV_MAX), moves: ['Recover', 'Protect', 'Toxic', 'Earthquake'], weight: 0.26, tags: ['generic', 'wall'], isMega: false, isZCrystal: false, itemlessArchetype: false, notes: 'Generic filler set' }),
      withSpecies({ id: 'generic-scarf', species: sp.name, role: 'scarf', item: 'Choice Scarf', ability: ability, nature: 'Jolly', evs: ev(0, 252, 0, 0, 4, 252), ivs: Object.assign({}, IV_MAX), moves: core, weight: 0.22, tags: ['generic', 'choice', 'scarf'], isMega: false, isZCrystal: false, itemlessArchetype: false, notes: 'Generic filler set' }),
      withSpecies({ id: 'generic-specs', species: sp.name, role: 'specs', item: 'Choice Specs', ability: ability, nature: 'Modest', evs: ev(0, 0, 0, 252, 4, 252), ivs: Object.assign({}, IV_MAX), moves: ['Psychic', 'Shadow Ball', 'Focus Blast', 'Trick'], weight: 0.18, tags: ['generic', 'choice', 'specs'], isMega: false, isZCrystal: false, itemlessArchetype: false, notes: 'Generic filler set' })
    ];
  }

  // Species-agnostic templates; world_sampler.js stamps the real species onto them.
  const DEFAULT = genericFor('Great Tusk').map(function (s) {
    const copy = Object.assign({}, s);
    copy.species = '';
    copy.id = 'generic-' + (s.role || 'filler');
    return copy;
  });

  /* ==========================================================================================
   *  PUBLIC API
   * ========================================================================================*/

  const ALL_SPECIES = Object.keys(DB).map(function (id) { return DB[id][0].species; });

  ST.SetDatabase = {
    DB: DB,
    DEFAULT: DEFAULT,
    report: { invalid: invalid, unverified: unverified, species: ALL_SPECIES.length, sets: setCount },
    forSpecies: function (name) {
      const id = U.toID(name);
      if (!id) return [];
      if (DB[id]) return DB[id].slice();
      // A Mega forme resolves to the base species' Mega sets.
      if (/mega|primal/.test(id)) {
        const isY = /mega[xy]?y$/.test(id) || /iteY$/.test(id);
        const isX = /mega[xy]?x$/.test(id);
        const baseId = id.replace(/mega[xyz]?$/, '').replace(/primal$/, '');
        const baseSets = DB[baseId];
        if (baseSets) {
          const megaSets = baseSets.filter(function (s) {
            if (!s.isMega) return false;
            if (isX) return /\sX$/.test(s.item || '');
            if (isY) return /\sY$/.test(s.item || '');
            return true;
          });
          if (megaSets.length) return megaSets;
        }
      }
      return [];
    },
    genericFor: genericFor,
    allSpecies: function () { return ALL_SPECIES.slice(); },
    has: function (name) { return !!DB[U.toID(name)]; },
    size: function () { return ALL_SPECIES.length; }
  };
})();
