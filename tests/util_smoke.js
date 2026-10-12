/* Showdown Tactician — tests/util_smoke.js
 * Focused unit checks (55) for src/util.js, the only module allowed to touch window.calc:
 * dex resolution + the two generated supplements, item/ability id normalisation, type math,
 * hazard percentages, Speed computation, the fuzzy species matcher, and the lookup caches that
 * keep the hottest path in the engine (move data by name/id) from re-scanning the dex per call.
 *
 * Usage:  node tests/util_smoke.js     (exit 0 = every check passed)
 */
const { loadAll } = require('./harness.js');
const s = loadAll(null, { through: 'src/util.js' });
const U = s.ST.util;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  got=' + JSON.stringify(got) + (ok ? '' : ' want=' + JSON.stringify(want)));
  return ok;
};
let fails = 0;
const t = (n,g,w) => { if (!eq(n,g,w)) fails++; };
t('toID', U.toID('Slowking-Galar'), 'slowkinggalar');
t('species name', U.getSpecies('great tusk').name, 'Great Tusk');
t('baseStats', U.baseStats('Great Tusk'), {hp:115,atk:131,def:131,spa:53,spd:53,spe:87});
t('mega canMega', U.canMegaEvolve('Charizard'), true);
t('mega stones', U.megaStonesFor('Charizard'), ['Charizardite X','Charizardite Y']);
t('megaSpeciesFromStone', U.megaSpeciesFromStone('Venusaurite'), {base:'Venusaur', mega:'Venusaur-Mega'});
t('isMega', U.getSpecies('Charizard-Mega-Y').isMega, true);
t('paradox', U.isParadox('Roaring Moon'), true);
t('types', U.getTypes('Slowking-Galar'), ['Poison','Psychic']);
t('abilities', U.getAbilities('Great Tusk'), ['Protosynthesis']);
t('typeMult steel->fairy', U.typeEffectiveness('Steel','Tapu Lele'), 2);
t('typeMult ground->flying', U.typeEffectiveness('Ground','Landorus-Therian'), 0);
t('immunityReason levitate', U.immunityReason('Ground', {species:'Hydreigon', ability:'Levitate'}), 'Levitate');
t('immunityReason flying', U.immunityReason('Ground', {species:'Landorus-Therian'}), 'Flying type');
t('move data', U.getMoveData('Headlong Rush'), {name:'Headlong Rush',id:'headlongrush',basePower:120,type:'Ground',category:'Physical',priority:0,isStatus:false,isPhysical:true,isSpecial:false,zp:190,maxPower:140,makesContact:true,isProtect:false,isRecovery:false,isPivot:false,isHazard:false,isHazardRemoval:false,isSetup:false,isZMove:false,isMaxMove:false,isMultihit:false,isSpread:false});
t('protect pri', U.movePriority('Protect'), 4);
t('ESpeed pri', U.movePriority('Extreme Speed'), 2);
t('is8PP', U.is8PPRecoveryMove('Roost'), true);
t('nature mod', U.natureMultiplier('Jolly','spe'), 1.1);
t('nature mod spa', U.natureMultiplier('Jolly','spa'), 0.9);
t('calcStat (library-delegated)', U.calcStat('spe', { base: 87, iv: 31, ev: 252, level: 100, nature: 'Jolly' }), 300);
t('calcHP (library-delegated)', U.calcHP(115,31,252,100), 434);
t('statTable atk/spa/spd', JSON.stringify(U.statTable('Great Tusk', { nature: 'Jolly', evs: { spe: 252 } })), JSON.stringify({ hp: 371, atk: 298, def: 298, spa: 127, spd: 142, spe: 300 }));
t('libraryReady', U.libraryReady(), true);
t('speed base', U.computeSpeed({species:'Great Tusk', nature:'Jolly', evs:{spe:252}, ivs:{spe:31}}).effective, 300);
t('speed scarf', U.computeSpeed({species:'Great Tusk', nature:'Jolly', evs:{spe:252}, ivs:{spe:31}}, {item:'Choice Scarf'}).effective, 450);
t('speed TR slow', U.computeSpeed({species:'Slowking-Galar', nature:'Sassy', evs:{spe:0}, ivs:{spe:0}}).effective, 58);
t('hazardPercent HDB', U.hazardPercent('Charizard','Heavy-Duty Boots','Blaze',{rocks:true,spikes:3}), 0);
t('hazardPercent rocks 4x', U.hazardPercent('Charizard',null,'Blaze',{rocks:true,spikes:0}), 50);
t('hazardPercent neutral SR', U.hazardPercent('Dragapult',null,'Clear Body',{rocks:true,spikes:0}), 12.5);
t('hazardPercent 0.25x SR', U.hazardPercent('Great Tusk',null,'Protosynthesis',{rocks:true,spikes:0}), 3.1);
t('hazardPercent spikes only', U.hazardPercent('Great Tusk',null,'Protosynthesis',{rocks:false,spikes:3}), 25);
t('hazardPercent flying, no spikes', U.hazardPercent('Landorus-Therian',null,'Intimidate',{rocks:true,spikes:3}), 12.5);
t('hazardPercent 4x rock', U.hazardPercent('Volcarona',null,'Flame Body',{rocks:true}), 50);
t('fuzzy', U.closestSpeciesName('greattok'), 'Great Tusk');
t('fuzzy exact', U.closestSpeciesName('roaringmoon'), 'Roaring Moon');
t('fuzzy null', U.closestSpeciesName('zzzzqqqqxxxx'), null);
t('tokenize', U.tokenizeDetails('Great Tusk, L50, M'), {species:'Great Tusk',level:50,gender:'M',shiny:false});
t('isChoice', U.isChoiceItem('Choice Scarf'), true);
t('isZ', U.isZCrystal('Ghostium Z'), true);
t('isMegaStone', U.isMegaStone('Venusaurite'), true);
t('booster', U.isBoosterEnergy('Booster Energy'), true);
t('speciesNames len>1000', Object.keys(s.calc.SPECIES[9]).length > 1000, true);

/* ------------------------------------------------------------ the move-lookup cache */
/* WHY THESE EXIST: getMoveData is the hottest lookup in the engine, and it used to re-scan the whole
 * dex (with a toID per key) on EVERY call for a name it does not have — which is exactly what a
 * switch action's species is when it reaches the move dex through LaplaceEngine._payoff. Measured on
 * a real board: ~240 us for such a call against 0.28 us for a present one, 216 such calls in one
 * real turn, and 52% of that turn's whole CPU profile between getMoveData, toID and its RegExp.
 *
 * Three behaviours keep it fixed, and all three are pinned here: a miss is REMEMBERED, a lookup by
 * display name and by id agree, and no inherited Object.prototype member is ever mistaken for a
 * move (the old cache was a plain `{}` with a truthiness hit test, so `getMoveData('constructor')`
 * returned the Object constructor itself). */
t('lookup: a present move, by display name', U.getMoveData('Headlong Rush').id, 'headlongrush');
t('lookup: by id returns the same object', U.getMoveData('headlongrush'), U.getMoveData('Headlong Rush'));
t('lookup: a name the dex does not have answers null', U.getMoveData('Totally Not A Move'), null);
t('lookup: a repeated miss adds no cache entry (it was remembered)',
  (function () { const a = (U.getMoveData('Totally Not A Move'), U.moveLookupStats().entries); U.getMoveData('Totally Not A Move'); return U.moveLookupStats().entries === a; })(), true);
t('lookup: 500 repeats of one new miss add exactly one entry',
  (function () { const a = U.moveLookupStats().entries; for (let i = 0; i < 500; i++) U.getMoveData('Another Non Move'); return U.moveLookupStats().entries - a; })(), 1);
t('lookup: a species handed to the move dex is null', U.getMoveData('Hatterene'), null);
t('lookup: a repeated species miss adds no cache entry',
  (function () { const a = U.moveLookupStats().entries; U.getMoveData('Hatterene'); return U.moveLookupStats().entries === a; })(), true);
t('lookup: Object.prototype is not a move dex (constructor)', U.getMoveData('constructor'), null);
t('lookup: toString is not a move', U.getMoveData('toString'), null);
t('lookup: __proto__ is not a move', U.getMoveData('__proto__'), null);
t('lookup: the id index answers for a name RAW_MOVES keys differently', U.getMoveData('rapidspin').isHazardRemoval, true);
t('lookup: a Z-move still resolves with its flags', U.getMoveData('Inferno Overdrive').isZMove, true);
console.log('\n' + (fails? fails+' FAILURES' : 'ALL UTIL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
