/* Showdown Tactician — tests/invariants_check.js
 *
 * WHY THIS EXISTS
 *   `laplace_core` leans on two clever-but-subtle tricks that nothing pinned:
 *     1. `_leafState` builds its 432-per-turn leaves with `Object.create(mon)` — a PROTOTYPE
 *        clone, not a deep copy — so the engine must never write through it.
 *     2. `_mutableSim` does the same with `Object.create(state)`.
 *   A prototype clone is only safe while every consumer treats it as read-only. That is an
 *   invariant, not a comment, so it gets a test. The audit's own "reachable but unvalidated
 *   leads" list named `simulate()` / `_mutableSim` as unowned dead code; this pins their contract
 *   instead of deleting them, because `run_tests.js` still calls `simulate()`.
 *
 * Run me with:  node tests/invariants_check.js
 */
'use strict';

const H = require('./harness.js');
// content.js auto-boots on the harness's stubbed hostname and starts a 2.5 s heartbeat, which
// would keep this process alive forever. Stub the timer exactly as run_tests.js does.
const S = H.loadAll({
  setInterval: function () { return 0; },
  clearInterval: function () { }
});
const ST = S.ST;
const U = ST.util;

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); return true; }
  failures.push(name + (detail === undefined ? '' : '  ->  ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  ->  ' + detail));
  return false;
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }

/* ------------------------------------------------------------------ fixture */

function buildBoard() {
  const mgr = new ST.BattleStateManager({ debug: false });
  mgr.setFormat('[Gen 9] National Dex OU');
  const paste = [
    'Great Tusk @ Choice Scarf', 'Ability: Protosynthesis', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- Headlong Rush', '- Close Combat', '- Ice Spinner', '- Rapid Spin', '',
    'Slowking-Galar @ Assault Vest', 'Ability: Regenerator', 'EVs: 252 HP / 4 SpA / 252 SpD', 'Sassy Nature', 'IVs: 0 Spe',
    '- Future Sight', '- Scald', '- Sludge Bomb', '- Flamethrower', '',
    'Ferrothorn @ Leftovers', 'Ability: Iron Barbs', 'EVs: 252 HP / 88 Def / 168 SpD', 'Relaxed Nature', 'IVs: 0 Spe',
    '- Stealth Rock', '- Leech Seed', '- Power Whip', '- Protect'
  ].join('\n');
  mgr.registerMyTeam(ST.TeamParser.parsePokepaste(paste).pokemon);
  const my = (mgr.state || mgr).myTeam.slice(0, 3);
  const opp = ['Gholdengo', 'Kingambit', 'Iron Valiant'].map(function (sp, i) {
    return {
      id: U.toID(sp), species: sp, side: 'p2', index: i, revealed: true, level: 100,
      hp: 100, maxhp: 100, hpPercent: 100, fainted: false, status: '',
      boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
      volatiles: {}, revealedMoves: [], activeStintMoves: [], movePP: {},
      possibleAbilities: U.getAbilities(sp), speedFloor: 0, speedCeiling: 1012,
      candidateSets: [], liveSet: null, isActive: i === 0, item: null, ability: '', setMoves: []
    };
  });
  my.forEach(function (m, i) { m.isActive = i === 0; m.hpPercent = 80; });
  return {
    turn: 12, mySide: 'p1', oppSide: 'p2', formatSupported: true,
    myTeam: my, oppTeam: opp, active: { my: my[0], opp: opp[0] },
    bench: { my: my.slice(1), opp: opp.slice(1) },
    protect: { oppTurnsSinceLastProtect: 2, oppConsecutiveProtects: 0, myTurnsSinceLastProtect: 4, myConsecutiveProtects: 0 },
    recoveryPP: { 'p1a:recover': 5 },
    field: { turn: 12, trickRoom: false, weather: '', terrain: '', hazards: { p1: { rocks: true }, p2: { spikes: 1 } }, screens: {}, tailwind: {}, gravity: false }
  };
}

function buildEngine() {
  const damage = new ST.DamageEngine({ gen: 9 });
  const trickRoom = new ST.TrickRoomEngine(damage);
  return new ST.LaplaceEngine({
    sampler: new ST.WorldSampler({ K: 6 }), damage,
    evaluator: new ST.DenseStateEvaluator(),
    tempo: new ST.TempoEngine({ damage: damage, trickRoom: trickRoom }),
    veto: new ST.BlunderVetoGuard({ damage: damage, trickRoom: trickRoom }), trickRoom: trickRoom
  });
}

/* --------------------------------------------- 1. evaluateTurn does not mutate its input */

section('evaluateTurn is pure with respect to the battle state');
{
  const engine = buildEngine();
  const board = buildBoard();
  const before = clone(board);
  engine.evaluateTurn(board);
  const after = clone(board);
  check('the input state is byte-identical after a full turn', JSON.stringify(before) === JSON.stringify(after),
    firstDiff(before, after));
  check('the ranked output was produced', engine.lastReadout && engine.lastReadout.ranked.length > 0,
    JSON.stringify(engine.lastReadout && engine.lastReadout.ranked.length));
}

/* --------------------------------------- 2. _leafState clones do not write through to the source */

section('_leafState prototype clones are read-only to their source');
{
  const engine = buildEngine();
  const board = buildBoard();
  const srcMon = board.active.my;
  const srcHp = srcMon.hpPercent;
  const srcFainted = srcMon.fainted;
  const leaf = engine._leafState(board, srcMon, board.active.opp, 3, 100);
  check('the leaf active body carries the leaf HP', leaf.active.my.hpPercent === 3, String(leaf.active.my.hpPercent));
  check('the leaf active body carries the leaf faint flag', leaf.active.my.fainted === false, String(leaf.active.my.fainted));
  check('the SOURCE body HP is untouched', srcMon.hpPercent === srcHp, String(srcMon.hpPercent));
  check('the SOURCE faint flag is untouched', srcMon.fainted === srcFainted, String(srcMon.fainted));

  // Writing a scalar onto the leaf must not reach the source (Object.create makes it an own prop).
  leaf.active.my.hpPercent = 1;
  leaf.active.my.status = 'brn';
  check('writing a scalar on the leaf does not reach the source', srcMon.hpPercent === srcHp && srcMon.status !== 'brn',
    srcMon.hpPercent + '/' + srcMon.status);

  // DOCUMENTED HAZARD: nested objects are shared BY REFERENCE through the prototype chain. The
  // evaluator only reads them, so this is safe today — but a future writer must know.
  const sharesBoosts = leaf.active.my.boosts === srcMon.boosts;
  check('nested objects (boosts) are shared by reference — a read-only contract', sharesBoosts === true,
    'boosts identity: ' + sharesBoosts);
}

/* --------------------------------------- 3. simulate()/_mutableSim do not mutate the source state */

section('simulate() / _mutableSim leave the source state alone');
{
  const engine = buildEngine();
  const board = buildBoard();
  const before = clone(board);
  const world = engine.lastWorlds && engine.lastWorlds[0];
  const result = engine.simulate({ kind: 'move', name: 'Headlong Rush', moveId: 'headlongrush' },
    { team: [board.oppTeam[0]] }, board);
  check('simulate returns a transition with numeric deltas',
    !!result && typeof result.oppPercentDelta === 'number' && typeof result.myPercentDelta === 'number',
    JSON.stringify(result && { o: result.oppPercentDelta, m: result.myPercentDelta }));
  check('simulate reports before/after HP', typeof result.myHpAfter === 'number' && typeof result.oppHpAfter === 'number',
    JSON.stringify({ my: result.myHpAfter, opp: result.oppHpAfter }));
  const after = clone(board);
  check('the source state is unchanged by simulate()', JSON.stringify(before) === JSON.stringify(after),
    firstDiff(before, after));

  // _mutableSim returns a PROTOTYPE clone; its own `active`/`_sim` must not land on the source.
  const sim = engine._mutableSim(board, board.active.my, board.active.opp, 42, 7, { myFaints: false, oppFaints: false });
  check('the sim clone exposes the simulated HP through _sim', sim._sim && sim._sim.myHp === 42 && sim._sim.oppHp === 7,
    JSON.stringify(sim._sim));
  check('the sim clone does not write active onto the source', board.active.my.hpPercent === before.active.my.hpPercent &&
    board.active.my === board.active.my && before.active.my.hpPercent === board.active.my.hpPercent,
    String(board.active.my.hpPercent));
  check('the sim clone has no _sim of its own on the source', board._sim === undefined, String(board._sim));
}

/* --------------------------------------- 4. the documented _oppActive resolution order */

section('_oppActive resolution order (documented, not silently changed)');
{
  const engine = buildEngine();
  const board = buildBoard();
  const a = { species: 'Alpha', isActive: false };
  const b = { species: 'Beta', isActive: true };
  const c = { species: 'Gamma', isActive: false };
  const picked = engine._oppActive({ team: [a, b, c] }, board);
  check('an isActive body in the world wins over team[0]', picked === b, picked && picked.species);
  const first = engine._oppActive({ team: [a, c] }, board);
  check('with no isActive body, world.team[0] is used', first === a, first && first.species);
  const fallback = engine._oppActive(null, board);
  check('with no world, the state active body is used', fallback === board.active.opp,
    fallback && fallback.species);
}

/* ------------------------------------------------------------------ report */

console.log('');
if (failures.length) {
  console.error('FAILED: ' + failures.length + ' of ' + (passed + failures.length) + ' checks');
  failures.forEach(function (f) { console.error('  - ' + f); });
  process.exit(1);
}
console.log('ALL INVARIANT CHECKS PASSED (' + passed + ')');
process.exit(0);

/** Report the first path that differs between two plain objects, for a readable failure. */
function firstDiff(a, b) {
  const seen = [];
  function walk(x, y, p) {
    if (typeof x !== typeof y) { seen.push(p + ': ' + typeof x + ' vs ' + typeof y); return; }
    if (x === null || y === null || typeof x !== 'object') { if (x !== y) seen.push(p + ': ' + x + ' vs ' + y); return; }
    if (Array.isArray(x) !== Array.isArray(y)) { seen.push(p + ': array mismatch'); return; }
    const keys = Object.keys(x);
    for (let i = 0; i < keys.length && seen.length < 3; i++) walk(x[keys[i]], y[keys[i]], p + '.' + keys[i]);
  }
  walk(a, b, '$');
  return seen.join('; ') || 'equal';
}
