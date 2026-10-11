/* Rule-level acceptance checks for the Part 1 deduction engine, driven end to end through
 * real protocol lines (not hand-built state objects). */
'use strict';
const H = require('./harness.js');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail === undefined ? '' : '  ->  ' + detail));
}

const S = H.loadAll({
  setInterval: function () { return 0; },
  clearInterval: function () { },
  fetch: function () { return Promise.resolve({ ok: false, json: function () { return Promise.resolve({}); } }); }
});
const U = S.ST.util;

function boot(pruner) {
  const pruner_ = pruner ? new S.ST.ArchetypePruner() : null;
  const state = new S.ST.BattleStateManager({ pruner: pruner_ });
  const parser = new S.ST.ProtocolParser();
  state.attachParser(parser);
  state.setFormat('[Gen 9] National Dex OU');
  return { state: state, parser: parser, st: state.state, pruner: pruner_ };
}

const FEED = function (b, lines) { b.parser.feedAll(lines.join('\n')); };

/* ---------------------------------------------------------------- 1. Boots CONFIRM */
{
  const b = boot();
  FEED(b, [
    '|player|p1|Me|1|1500', '|player|p2|Foe|2|1500',
    '|switch|p1a: Ferrothorn|Ferrothorn, L50, M|100/100',
    '|switch|p2a: Landorus-Therian|Landorus-Therian, L50, M|100/100',
    '|turn|1',
    '|move|p1a: Ferrothorn|Stealth Rock|p2',
    '|-sidestart|p2: Foe|move: Stealth Rock',
    '|turn|2',
    // Slowking-Galar is not Flying/Levitate/Balloon and takes 12.5% from rocks: entering at
    // 100% while Stealth Rock is up is a Boots proof.
    '|switch|p2a: Slowking-Galar|Slowking-Galar, L50, M|100/100'
  ]);
  const sk = b.st.oppTeam.find(function (m) { return m && U.toID(m.species) === 'slowkinggalar'; });
  ok('boots: confirmed on a clean hazard-free entry', sk && sk.confirmedItem === 'Heavy-Duty Boots', sk && sk.confirmedItem);
  ok('boots: evidence recorded', sk && sk.itemEvidence.join(' ').indexOf('Boots confirmed') !== -1, sk && JSON.stringify(sk.itemEvidence));
}

/* ---------------------------------------------------------------- 2. Boots DISPROVE */
{
  const b = boot();
  FEED(b, [
    '|player|p1|Me|1|1500', '|player|p2|Foe|2|1500',
    '|switch|p1a: Ferrothorn|Ferrothorn, L50, M|100/100',
    '|switch|p2a: Landorus-Therian|Landorus-Therian, L50, M|100/100',
    '|turn|1',
    '|move|p1a: Ferrothorn|Stealth Rock|p2',
    '|-sidestart|p2: Foe|move: Stealth Rock',
    '|turn|2',
    '|switch|p2a: Slowking-Galar|Slowking-Galar, L50, M|100/100',
    '|-damage|p2a: Slowking-Galar|88/100|[from] Stealth Rock'
  ]);
  const sk = b.st.oppTeam.find(function (m) { return m && U.toID(m.species) === 'slowkinggalar'; });
  ok('boots: ruled out by hazard damage', sk && sk.confirmedItem === null && sk.itemRuledOut.indexOf('Heavy-Duty Boots') !== -1,
    sk && JSON.stringify({ item: sk.confirmedItem, ruledOut: sk.itemRuledOut }));
  // A flying/levitating mon must never be credited with Boots.
  const b2 = boot();
  FEED(b2, [
    '|switch|p1a: Ferrothorn|Ferrothorn, L50, M|100/100',
    '|switch|p2a: Charizard|Charizard, L50, M|100/100',
    '|turn|1', '|move|p1a: Ferrothorn|Stealth Rock|p2', '|-sidestart|p2: Foe|move: Stealth Rock',
    '|turn|2', '|switch|p2a: Moltres|Moltres, L50, M|100/100'
  ]);
  const moltres = b2.st.oppTeam.find(function (m) { return m && U.toID(m.species) === 'moltres'; });
  ok('boots: flying switch-in never confirms Boots', moltres && moltres.confirmedItem === null, moltres && moltres.confirmedItem);
}

/* ------------------------------------------------------- 3. Knock Off ladder (real log) */
{
  const b = boot();
  FEED(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Iron Valiant|Iron Valiant, L50, F|100/100',
    '|turn|1',
    '|move|p1a: Great Tusk|Knock Off|p2a: Iron Valiant',
    '|-damage|p2a: Iron Valiant|72/100',
    '|turn|2'
  ]);
  const iv = b.st.oppTeam.find(function (m) { return m && U.toID(m.species) === 'ironvaliant'; });
  ok('knockoff: damage with no -enditem marks "survived"', iv && iv.itemKnockedOff === true && iv.itemRemoved === false,
    iv && JSON.stringify({ survived: iv.itemKnockedOff, removed: iv.itemRemoved }));
  ok('knockoff: evidence recorded', iv && iv.itemEvidence.join(' ').indexOf('no -enditem') !== -1, iv && JSON.stringify(iv.itemEvidence));

  // Removed case: the -enditem token must set the opposite flags.
  const b2 = boot();
  FEED(b2, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Landorus-Therian|Landorus-Therian, L50, M|100/100',
    '|turn|1',
    '|move|p1a: Great Tusk|Knock Off|p2a: Landorus-Therian',
    '|-damage|p2a: Landorus-Therian|74/100',
    '|-enditem|p2a: Landorus-Therian|Rocky Helmet|[from] move: Knock Off|[of] p1a: Great Tusk',
    '|turn|2'
  ]);
  const lando = b2.st.oppTeam.find(function (m) { return m && U.toID(m.species) === 'landorustherian'; });
  ok('knockoff: -enditem marks the item as removed', lando && lando.itemRemoved === true && lando.itemKnockedOff === false,
    lando && JSON.stringify({ survived: lando.itemKnockedOff, removed: lando.itemRemoved }));
  ok('knockoff: removed item is ruled out', lando && lando.itemRuledOut.indexOf('Rocky Helmet') !== -1, lando && JSON.stringify(lando.itemRuledOut));

  // Ladder verdict with both format locks spent => proven itemless (Acrobatics / Unburden).
  const pruner = new S.ST.ArchetypePruner();
  const state = { formatLocks: { oppHasMegaEvolved: true, oppHasUsedZMove: true }, oppTeam: [], myTeam: [] };
  ok('knockoff: ladder = itemless when mega and Z are spent',
    pruner.classifyItemless({ species: 'Iron Valiant', itemKnockedOff: true, itemConsumed: false, itemRemoved: false }, state) === 'itemless-acrobatics');
  const pruned = pruner.prune(iv, state);
  // The database has no itemless Iron Valiant set, so the pool degrades to "least bad" — but
  // it must never keep a Booster Energy set, and it must never be empty.
  ok('knockoff: proven itemless never keeps a Booster Energy set',
    pruned.length > 0 && pruned.every(function (s) { return !U.isBoosterEnergy(s.item); }),
    JSON.stringify(pruned.map(function (s) { return s.item; })));
  ok('knockoff: the degradation is recorded as a reason',
    (iv.prunedReasons || []).join(' ').indexOf('falling back') !== -1, JSON.stringify(iv.prunedReasons));
}

/* --------------------------------------------------------- 4. Choice-lock pruning */
{
  const b = boot(true);
  FEED(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Iron Valiant|Iron Valiant, L50, F|100/100',
    '|turn|1',
    '|move|p2a: Iron Valiant|Moonblast|p1a: Great Tusk',
    '|-damage|p1a: Great Tusk|40/100',
    '|turn|2',
    '|move|p2a: Iron Valiant|Thunderbolt|p1a: Great Tusk',
    '|-damage|p1a: Great Tusk|5/100'
  ]);
  const iv = b.st.oppTeam.find(function (m) { return m && U.toID(m.species) === 'ironvaliant'; });
  const verdict = b.pruner.prune(iv, b.st);
  ok('choice: two moves in one stint sets cannotBeChoice', iv.cannotBeChoice === true, String(iv.cannotBeChoice));
  ok('choice: no Choice set survives', verdict.length > 0 && verdict.every(function (s) { return !U.isChoiceItem(s.item); }),
    JSON.stringify(verdict.map(function (s) { return s.item; })));
  ok('choice: the live pool is published on the mon', iv.candidateSets.length === verdict.length,
    iv.candidateSets.length + ' vs ' + verdict.length);
  ok('choice: an Encored mon is exempt', (function () {
    const encored = { species: 'Iron Valiant', id: 'ironvaliant', isEncored: true, activeStintMoves: ['Moonblast', 'Thunderbolt'], cannotBeChoice: false, prunedReasons: [] };
    return b.pruner.applyChoiceLockRule(encored, b.st).pruned === false;
  })());
}

/* ------------------------------------------------------------- 5. Speed-floor pruning */
{
  const b = boot(true);
  FEED(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Landorus-Therian|Landorus-Therian, L50, M|100/100',
    '|turn|1'
  ]);
  const lando = b.st.oppTeam.find(function (m) { return m && U.toID(m.species) === 'landorustherian'; });
  const res = b.pruner.handleSpeedFloorEvent({ side: 'p2', species: 'Landorus-Therian', value: 300, reason: 'moved first' }, b.st);
  ok('speed: floor recorded on the right mon', lando.speedFloor === 300, String(lando.speedFloor));
  ok('speed: evidence recorded', lando.speedEvidence.length > 0, JSON.stringify(lando.speedEvidence));
  ok('speed: pool published and every survivor can reach the floor',
    res.pruned === true && lando.candidateSets.length > 0 && lando.candidateSets.every(function (s) { return U.maxSpeedForSet(s) >= 300; }),
    JSON.stringify(lando.candidateSets.map(function (s) { return [s.id, U.maxSpeedForSet(s)]; })));
  ok('speed: no Choice Scarf can survive a 700 floor for Landorus', (function () {
    const res2 = b.pruner.handleSpeedFloorEvent({ side: 'p2', species: 'Landorus-Therian', value: 700, reason: 'test' }, b.st);
    return lando.speedFloor === 700 && lando.candidateSets.every(function (s) { return U.maxSpeedForSet(s) >= 700; });
  })());
}

/* ------------------------------------------------------- 6. Mega / Z format locks */
{
  const b = boot(true);
  FEED(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|poke|p2|Charizard',
    '|switch|p2a: Charizard|Charizard, L50, M|100/100',
    '|-mega|p2a: Charizard|Charizard, L50, M|Charizardite Y'
  ]);
  ok('locks: mega latch set', b.st.formatLocks.oppHasMegaEvolved === true);
  ok('locks: no mega stones remain on the remaining five', b.st.formatLocks.oppHasMegaStone === false, JSON.stringify(b.st.formatLocks));
  b.parser.feed('|move|p2a: Charizard|Inferno Overdrive|p1a: Great Tusk');
  ok('locks: Z latch set', b.st.formatLocks.oppHasUsedZMove === true);
}

/* ------------------------------------------- 7. World sampler honours a hard floor */
{
  const b = boot(true);
  FEED(b, [
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Landorus-Therian|Landorus-Therian, L50, M|100/100',
    '|turn|1'
  ]);
  const lando = b.st.oppTeam.find(function (m) { return m && U.toID(m.species) === 'landorustherian'; });
  lando.speedFloor = 300;
  const sampler = new S.ST.WorldSampler({ K: 4, rng: S.ST.WorldSampler.mulberry32(99) });
  const worlds = sampler.sampleWorlds(b.st, S.ST.SetDatabase, 4);
  let bad = 0;
  worlds.forEach(function (w) {
    const m = w.team.find(function (x) { return U.toID(x.species) === 'landorustherian'; });
    if (m && U.maxSpeedForSet(m.liveSet) < 300) bad++;
  });
  ok('sampler: no world contradicts a reachable 300 floor', bad === 0, String(bad));
}

console.log('passed: ' + pass + '  failed: ' + fails.length);
fails.forEach(function (f) { console.log('  x ' + f); });
process.exit(fails.length ? 1 : 0);
