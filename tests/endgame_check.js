/* Showdown Tactician — tests/endgame_check.js
 *
 * WHY THIS EXISTS
 *   `src/endgame_solver.js` is the only place in this repository that searches more than one turn,
 *   and a deep search is the easiest place in an engine to start inventing facts: a fabricated mate
 *   looks exactly like a found one. So the suite is mostly about the REFUSALS and the honesty
 *   rails, and only then about the answers:
 *     - every refusal the module documents (disabled, too many bodies, no engine, no modelled move,
 *       budget, undecidable Speed order, unpriceable move),
 *     - a board where a mate in 1 is forced BY CONSTRUCTION (their body stands at 12 % HP, so any
 *       hit finishes it) — and the returned line names the move that does it,
 *     - a board where NO mate is forced, which must never come back with a fabricated one,
 *     - a board whose outcome depends on Speed order we cannot pin, which must refuse rather than
 *       pick (the both-orders-agree case is checked separately, and must NOT refuse),
 *     - purity (the live board is never written through), determinism, and the node budget.
 *
 *   Fixtures deliberately stand bodies at LOW HP instead of betting on an exact damage number: an
 *   assertion about "mate in 1" that depends on a roll is a flaky test pretending to be a proof.
 *
 * Run me with:  node tests/endgame_check.js
 */
'use strict';

const H = require('./harness.js');
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
function snapshot(x) { return JSON.stringify(x); }

/* ------------------------------------------------------------------ fixtures */

const IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

function spread(over) {
  return Object.assign({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, over || {});
}

function liveSet(species, moves, over) {
  return Object.assign({
    id: U.toID(species), species: species, item: '', ability: '',
    nature: 'Serious', evs: spread(), ivs: IVS, moves: moves.slice(), weight: 1
  }, over || {});
}

function mon(species, opts) {
  const o = opts || {};
  const hp = o.hpPercent === undefined ? 100 : o.hpPercent;
  return {
    id: U.toID(species), species: species, side: o.side || 'p2', revealed: true, level: 100,
    hp: hp, maxhp: 100, hpPercent: hp, fainted: hp <= 0, status: '',
    boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
    volatiles: {}, revealedMoves: [], activeStintMoves: [], movePP: {},
    possibleAbilities: U.getAbilities(species),
    speedFloor: o.speedFloor, speedCeiling: o.speedCeiling,
    candidateSets: o.candidateSets || [], liveSet: o.liveSet || null, isActive: !!o.isActive,
    item: (o.liveSet && o.liveSet.item) || '', ability: (o.liveSet && o.liveSet.ability) || '',
    setMoves: o.setMoves || (o.liveSet ? o.liveSet.moves.slice() : [])
  };
}

function board(myTeam, oppTeam) {
  const first = function (team) {
    for (let i = 0; i < team.length; i++) if (team[i].isActive) return team[i];
    return team[0] || null;
  };
  return {
    turn: 20, mySide: 'p1', oppSide: 'p2', formatSupported: true,
    myTeam: myTeam, oppTeam: oppTeam,
    active: { my: first(myTeam), opp: first(oppTeam) },
    bench: { my: myTeam.slice(1), opp: oppTeam.slice(1) },
    protect: { oppTurnsSinceLastProtect: 3, oppConsecutiveProtects: 0, myTurnsSinceLastProtect: 3, myConsecutiveProtects: 0 },
    recoveryPP: {},
    field: { turn: 20, trickRoom: false, weather: '', terrain: '', hazards: { p1: {}, p2: {} }, screens: {}, tailwind: {}, gravity: false }
  };
}

function mkSolver(opts) {
  return new ST.EndgameSolver(Object.assign({
    enabled: true,
    damage: new ST.DamageEngine({ gen: 9 }),
    evaluator: new ST.DenseStateEvaluator()
  }, opts || {}));
}

/* A: their body stands at 12 %, so "mate in 1" is forced by construction; their Sucker Punch is
 * a +1 priority Dark move into a Fairy/Fighting body, so it cannot finish us from full. */
function boardMateInOne() {
  const me = mon('Iron Valiant', {
    side: 'p1', isActive: true, hpPercent: 100,
    liveSet: liveSet('Iron Valiant', ['Close Combat', 'Moonblast'], {
      nature: 'Jolly', evs: spread({ atk: 252, spe: 252 })
    })
  });
  const them = mon('Kingambit', {
    isActive: true, hpPercent: 12,
    liveSet: liveSet('Kingambit', ['Sucker Punch', 'Kowtow Cleave'], {
      nature: 'Adamant', evs: spread({ hp: 252, atk: 252 })
    })
  });
  return board([me], [them]);
}

/* B: two bulky bodies with a resisted Steel move at full HP — nothing dies inside a few turns. */
function boardNoMate() {
  const me = mon('Corviknight', {
    side: 'p1', isActive: true, hpPercent: 100,
    liveSet: liveSet('Corviknight', ['Iron Head'], { nature: 'Jolly', evs: spread({ hp: 252, spe: 252 }) })
  });
  const them = mon('Corviknight', {
    isActive: true, hpPercent: 100,
    liveSet: liveSet('Corviknight', ['Iron Head'], { nature: 'Serious', evs: spread({ hp: 252 }) })
  });
  return board([me], [them]);
}

/* C: BOTH bodies stand at 12 % and neither set is pinned, so whoever acts first wins. The Speed
 * bounds overlap, the two orders disagree, and the solver must refuse rather than pick one. */
function boardOrderDecides() {
  const me = mon('Garchomp', { side: 'p1', isActive: true, hpPercent: 12, setMoves: ['Earthquake'] });
  const them = mon('Kingambit', { isActive: true, hpPercent: 12, setMoves: ['Kowtow Cleave'] });
  return board([me], [them]);
}

/* D: three of their bodies inside one hit each, none of them able to hit back (their sets are
 * status-only, so they pass) — a mate in 3 BY CONSTRUCTION that only a three-wide search can see. */
function boardWideMate() {
  const me = mon('Iron Valiant', {
    side: 'p1', isActive: true, hpPercent: 100,
    liveSet: liveSet('Iron Valiant', ['Close Combat'], { nature: 'Jolly', evs: spread({ atk: 252, spe: 252 }) })
  });
  const them = [
    mon('Kingambit', {
      isActive: true, hpPercent: 12,
      liveSet: liveSet('Kingambit', ['Kowtow Cleave'], { nature: 'Adamant', evs: spread({ hp: 252, atk: 252 }) })
    }),
    mon('Iron Treads', {
      hpPercent: 12,
      liveSet: liveSet('Iron Treads', ['Stealth Rock', 'Rapid Spin'], { nature: 'Jolly' })
    }),
    mon('Corviknight', {
      hpPercent: 12,
      liveSet: liveSet('Corviknight', ['Iron Defense', 'Roost'], { nature: 'Sassy' })
    })
  ];
  return board([me], them);
}

/* The four sets the Speed-band section pivots on. Iron Valiant at 252 Spe Jolly is 364 and the same
 * set with a Choice Scarf is 546; Kingambit's bulky spread is 136. */
function ourTwelve() {
  return mon('Iron Valiant', {
    side: 'p1', isActive: true, hpPercent: 12, liveSet: valiantSet()
  });
}
function valiantSet() {
  return liveSet('Iron Valiant', ['Close Combat'], { nature: 'Jolly', evs: spread({ atk: 252, spe: 252 }) });
}
function valiantScarfSet() {
  return liveSet('Iron Valiant', ['Close Combat'], {
    nature: 'Jolly', evs: spread({ atk: 252, spe: 252 }), item: 'Choice Scarf'
  });
}
function slowSet() {
  return liveSet('Kingambit', ['Kowtow Cleave'], { nature: 'Adamant', evs: spread({ hp: 252, atk: 252 }) });
}
/* Their body as a POOL: the fast set first, the slow one second, weights straight from the caller. */
function theirStraddle(fastWeight, slowWeight) {
  return mon('Kingambit', {
    isActive: true, hpPercent: 12, setMoves: ['Kowtow Cleave'], candidateSets: [
      Object.assign({}, valiantScarfSet(), { weight: fastWeight }),
      Object.assign({}, slowSet(), { weight: slowWeight })
    ]
  });
}
/* Ten damaging moves: more than a legal set can hold, so `maxBranchingMoves` is the thing that
 * bounds it (`_movesOf` used to hardcode four). */
function bodyWithTenAttacks() {
  return mon('Iron Valiant', {
    side: 'p1', isActive: true, setMoves: [
      'Close Combat', 'Moonblast', 'Psycho Cut', 'Spirit Break', 'Ice Punch',
      'Thunder Punch', 'Fire Punch', 'Zen Headbutt', 'Liquidation', 'Drain Punch'
    ]
  });
}

if (!ST.EndgameSolver) {
  check('ST.EndgameSolver is registered (src/endgame_solver.js must be in the manifest)', false);
  console.log('\n=== summary ===\nchecks passed: ' + passed + '\nchecks failed: ' + failures.length);
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}

/* ===================================================== 1. refusals and their reasons */

section('1. every refusal the module documents');
{
  const disabled = new ST.EndgameSolver({
    enabled: false,
    damage: new ST.DamageEngine({ gen: 9 }),
    evaluator: new ST.DenseStateEvaluator()
  });
  check('disabled by default in config (the coordinator wires it in)', new ST.EndgameSolver({}).enabled === false);
  check('a disabled solver refuses', disabled.solve(boardMateInOne(), null) === null);
  check('...and names the reason', disabled.lastReport && disabled.lastReport.reason === 'disabled',
    JSON.stringify(disabled.lastReport));

  const noEngine = mkSolver({ damage: null, evaluator: null });
  check('no damage engine refuses', noEngine.solve(boardMateInOne(), null) === null);
  check('...with reason no-engine', noEngine.lastReport && noEngine.lastReport.reason === 'no-engine');

  const noEval = mkSolver({ evaluator: null });
  check('no leaf evaluator refuses', noEval.solve(boardMateInOne(), null) === null);

  const s = mkSolver();
  check('no living body of ours refuses', s.solve(board([mon('Iron Valiant', { side: 'p1', hpPercent: 0, setMoves: ['Close Combat'] })],
    [mon('Kingambit', { hpPercent: 12, setMoves: ['Kowtow Cleave'] })]), null) === null);
  check('...with reason no-bodies', s.lastReport && s.lastReport.reason === 'no-bodies');

  const statusOnly = board([mon('Iron Valiant', { side: 'p1', isActive: true, setMoves: ['Close Combat'] })],
    [mon('Kingambit', { isActive: true, hpPercent: 12, setMoves: ['Protect', 'Recover'] })]);
  check('an opponent with no modelled (damaging) move refuses', s.solve(statusOnly, null) === null);
  check('...with reason no-modelled-move-theirs', s.lastReport && s.lastReport.reason === 'no-modelled-move-theirs',
    JSON.stringify(s.lastReport));

  const noneMine = board([mon('Iron Valiant', { side: 'p1', isActive: true, setMoves: ['Protect', 'Recover'] })],
    [mon('Kingambit', { isActive: true, hpPercent: 12, setMoves: ['Kowtow Cleave'] })]);
  check('the same refusal fires for OUR side', s.solve(noneMine, null) === null &&
    s.lastReport.reason === 'no-modelled-move-mine');

  const three = [mon('Kingambit', { isActive: true, hpPercent: 12, setMoves: ['Kowtow Cleave'] }),
    mon('Great Tusk', { hpPercent: 90, setMoves: ['Earthquake'] }),
    mon('Iron Valiant', { hpPercent: 90, setMoves: ['Close Combat'] })];
  const crowded = board([mon('Iron Valiant', { side: 'p1', isActive: true, setMoves: ['Close Combat'] })], three);
  /* The body bound moved from 2 to 3 — a 3v3 board is searchable when the tier is enabled — so the
   * refusal now has to be asked for rather than being the default. The default's own bound (four
   * bodies) is pinned in section 6. */
  const narrow = mkSolver({ maxBodies: 2 });
  check('three living bodies on their side refuses at maxBodies 2', narrow.solve(crowded, null) === null);
  check('...with reason too-many-bodies-theirs', narrow.lastReport && narrow.lastReport.reason === 'too-many-bodies-theirs',
    JSON.stringify(narrow.lastReport));

  const twoByTwo = board(
    [mon('Iron Valiant', { side: 'p1', isActive: true, setMoves: ['Close Combat'] }),
      mon('Great Tusk', { side: 'p1', hpPercent: 80, setMoves: ['Earthquake'] })],
    [mon('Kingambit', { isActive: true, hpPercent: 60, setMoves: ['Kowtow Cleave'] }),
      mon('Gholdengo', { hpPercent: 70, setMoves: ['Make It Rain'] })]
  );
  const strict = mkSolver({ maxBodies: 1 });
  check('a 2v2 board refuses at maxBodies 1', strict.solve(twoByTwo, null) === null);

  /* A move the engine cannot price must NOT be read as "does nothing": a hit that silently
   * became 0 damage would invent a mate out of a dex miss. */
  const blind = mkSolver({ damage: { calculateDamage: function () { return null; } } });
  check('an unpriceable hit refuses instead of counting as zero damage',
    blind.solve(boardMateInOne(), null) === null);
  check('...with reason unpriceable-move',
    blind.lastReport && blind.lastReport.reason === 'unpriceable-move', JSON.stringify(blind.lastReport));
}

/* ============================================================= 2. the refusals that matter */

section('2. the honest rails: undecidable order, and the budget');
{
  const s = mkSolver();
  const undecided = s.solve(boardOrderDecides(), null);
  check('a board whose winner depends on an unpinned Speed order REFUSES', undecided === null);
  check('...with reason speed-undecided', s.lastReport && s.lastReport.reason === 'speed-undecided',
    JSON.stringify(s.lastReport));

  /* A MIRROR is not the second half of this rail — it is the shape that proves the rail is doing
   * real work, and the first version of this suite had it backwards. With both bodies at full HP
   * and Speed unpinned, every deeper pair eventually has one body inside one hit of fainting, and
   * at that point who faints first IS the Speed order: the two ways disagree, so refusing is the
   * honest answer. (The states are identical — only the VALUE differs — which is why a `nodes`
   * count this low can still end in a refusal.) */
  const mirror = board(
    [mon('Corviknight', { side: 'p1', isActive: true, setMoves: ['Iron Head'] })],
    [mon('Corviknight', { isActive: true, setMoves: ['Iron Head'] })]
  );
  const mirrorSolver = mkSolver();
  check('a mirror with unpinned Speed REFUSES (the order really does decide it at depth)',
    mirrorSolver.solve(mirror, null) === null);
  check('...with reason speed-undecided',
    mirrorSolver.lastReport && mirrorSolver.lastReport.reason === 'speed-undecided',
    JSON.stringify(mirrorSolver.lastReport));

  /* The OTHER half of the same rule: when the two orders AGREE the pair IS decided and the solve
   * must go through, or the rail would refuse every endgame in which a body cannot be touched.
   * Here their only move is Normal into a Ghost body, so their action changes nothing in EITHER
   * order and the whole tree is order-free: the proven mate has to come back. */
  const orderFree = board(
    [mon('Gholdengo', { side: 'p1', isActive: true, setMoves: ['Iron Head'] })],
    [mon('Dragonite', { isActive: true, setMoves: ['Extreme Speed'] })]
  );
  const orderFreeSolver = mkSolver();
  const solved = orderFreeSolver.solve(orderFree, null);
  check('an order-independent pair does NOT refuse', solved !== null,
    JSON.stringify(orderFreeSolver.lastReport));
  check('...and the forced win it proves is counted in turns',
    !!solved && solved.solved === true && typeof solved.mateIn === 'number' && solved.mateIn > 0,
    JSON.stringify(solved));
  check('...with one line entry per turn, every one of them a real move',
    !!solved && solved.line.length === solved.mateIn &&
      solved.line.every(function (a) { return a.kind === 'move' && !!U.getMoveData(a.name); }),
    JSON.stringify(solved && solved.line));

  const tight = mkSolver({ nodeBudget: 1 });
  const budgeted = tight.solve(boardNoMate(), null);
  check('an exhausted budget is reported, not hidden', !!budgeted && budgeted.solved === false &&
    budgeted.reason === 'budget', JSON.stringify(budgeted));
  check('...with no partial line offered as a solution', !!budgeted && budgeted.line.length === 0);
  check('...and the nodes used are within the budget it was given', !!budgeted &&
    budgeted.nodes > 0 && budgeted.nodes <= tight.nodeBudget + 1, budgeted && String(budgeted.nodes));
}

/* ================================================================ 3. a forced mate in 1 */

section('3. the answer: a mate forced by construction');
{
  const s = mkSolver();
  const state = boardMateInOne();
  const mine = s.solve(state, null);
  check('a forced win is solved', !!mine && mine.solved === true, JSON.stringify(mine));
  check('...and counted in turns', !!mine && mine.mateIn === 1, mine && String(mine.mateIn));
  check('...with reason mate', !!mine && mine.reason === 'mate');
  check('the line starts with OUR action and it is the killing move',
    !!mine && mine.line.length >= 1 && mine.line[0].kind === 'move' && mine.line[0].name === 'Close Combat',
    JSON.stringify(mine && mine.line));
  check('every line entry is a real move the dex knows',
    !!mine && mine.line.every(function (act) { return !!U.getMoveData(act.name) && !!act.moveId; }),
    JSON.stringify(mine && mine.line));
  check('the line only names moves the active body actually has', !!mine &&
    mine.line.every(function (act) { return state.myTeam[0].setMoves.indexOf(act.name) !== -1; }));
  check('the score sits in the forced-win band', !!mine && mine.score >= ST.EndgameSolver.WIN - 1e4,
    mine && String(mine.score));
  check('the node count is real and inside the default budget',
    !!mine && mine.nodes > 0 && mine.nodes <= s.nodeBudget, mine && String(mine.nodes));
  check('lastReport mirrors the returned result', s.lastReport === mine);
  check('a depth-1 search still finds a mate in 1 (it is the depth the answer needs)',
    mkSolver({ maxDepth: 1 }).solve(state, null).mateIn === 1);
}

/* ============================================== 4. no forced win is not a fabricated win */

section('4. no mate is a reportable answer, never an invented one');
{
  const s = mkSolver({ maxDepth: 3 });
  const flat = s.solve(boardNoMate(), null);
  check('a stalled endgame is not solved', !!flat && flat.solved === false, JSON.stringify(flat));
  check('...and claims no mate', !!flat && flat.mateIn === null);
  check('...with reason no-forced-win', !!flat && flat.reason === 'no-forced-win');
  check('...and a finite score OUTSIDE the mate band',
    !!flat && typeof flat.score === 'number' && isFinite(flat.score) &&
    Math.abs(flat.score) < ST.EndgameSolver.WIN - ST.EndgameSolver.MATE_BAND,
    flat && String(flat.score));
}

/* ============================================================= 5. purity, determinism, 2v2 */

section('5. the live board is never written through, and the answer is repeatable');
{
  const s = mkSolver();
  const state = boardMateInOne();
  const before = snapshot(state);
  const mine = s.solve(state, null);
  check('the source board is byte-identical after a solve', snapshot(state) === before);
  check('the live bodies keep their own stat stages',
    state.myTeam[0].boosts.atk === 0 && state.oppTeam[0].boosts.atk === 0,
    JSON.stringify([state.myTeam[0].boosts, state.oppTeam[0].boosts]));

  const again = s.solve(boardMateInOne(), null);
  check('two identical solves give identical results',
    snapshot(Object.assign({}, mine)) === snapshot(Object.assign({}, again)),
    snapshot(mine) + ' vs ' + snapshot(again));

  /* Every body carries a complete set here on purpose: without one the Speed bound is an overlap,
   * the order rail refuses, and the test would be measuring the rail instead of the 2v2 path. */
  const twoByTwo = board(
    [mon('Iron Valiant', {
      side: 'p1', isActive: true,
      liveSet: liveSet('Iron Valiant', ['Close Combat'], { nature: 'Jolly', evs: spread({ atk: 252, spe: 252 }) })
    }),
      mon('Great Tusk', {
        side: 'p1', hpPercent: 80,
        liveSet: liveSet('Great Tusk', ['Earthquake'], { nature: 'Jolly', evs: spread({ atk: 252, spe: 252 }) })
      })],
    [mon('Kingambit', {
      isActive: true, hpPercent: 12,
      liveSet: liveSet('Kingambit', ['Kowtow Cleave'], { nature: 'Adamant', evs: spread({ hp: 252, atk: 252 }) })
    }),
      mon('Gholdengo', {
        hpPercent: 70,
        liveSet: liveSet('Gholdengo', ['Make It Rain'], { nature: 'Timid', evs: spread({ hp: 252, spe: 252 }) })
      })]
  );
  const multi = mkSolver({ maxBodies: 2, maxDepth: 4 }).solve(twoByTwo, null);
  check('a 2v2 board is answered (faints replace) rather than crashing', !!multi &&
    typeof multi.nodes === 'number' && multi.nodes > 0, JSON.stringify(multi));
  check('...and its line, if any, still names legal moves of OURS', !multi ||
    multi.line.every(function (act) { return twoByTwo.myTeam.some(function (m) { return m.setMoves.indexOf(act.name) !== -1; }); }),
    JSON.stringify(multi && multi.line));
}

/* ========================== 6. three-wide boards, and an unreadable Speed order priced honestly */

section('6. the wider board: 3v3 activation, and the Speed coin flip priced instead of refused');
{
  check('the tier allows three living bodies a side', ST.configGet('laplace.endgame.maxAlive', null) === 3);
  check('...and the historical alias agrees', ST.configGet('laplace.endgame.maxBodies', null) === 3);
  check('maxBranchingMoves is registered', ST.configGet('laplace.endgame.maxBranchingMoves', null) === 12);
  check('chance nodes are on in config', ST.configGet('laplace.endgame.chanceNodes', null) === true);

  const s = mkSolver();
  check('...and one solver instance reads all three of them',
    s.maxBodies === 3 && s.maxAlive === 3 && s.maxBranchingMoves === 12 && s.chanceNodes === true,
    JSON.stringify([s.maxBodies, s.maxAlive, s.maxBranchingMoves, s.chanceNodes]));

  /* --- the 3v3 mate. Three of their bodies at 12 %, every one of them hittable by our single move,
   * and none of them able to hit back (their sets hold STATUS moves only, so they pass and cannot
   * revenge). Finding this needs a search three bodies wide, which is the whole reason the bound
   * moved. */
  const wide = mkSolver().solve(boardWideMate(), null);
  check('a 3v3 board is searched and the forced win is found', !!wide && wide.solved === true,
    JSON.stringify(wide));
  check('...and counted in turns', !!wide && wide.mateIn === 3, wide && String(wide.mateIn));
  check('...with one line entry per turn, every one of them our own killing move',
    !!wide && wide.line.length === 3 && wide.line.every(function (a) {
      return a.kind === 'move' && a.name === 'Close Combat' && !!U.getMoveData(a.name);
    }), JSON.stringify(wide && wide.line));
  check('...inside the default node budget', !!wide && wide.nodes > 0 && wide.nodes <= 20000,
    wide && String(wide.nodes));
  check('a PROVEN mate never leans on a chance node', !!wide && wide.chancePairs === 0,
    wide && String(wide.chancePairs));

  const narrow = mkSolver({ maxBodies: 2 });
  check('the same board refuses at the old bound', narrow.solve(boardWideMate(), null) === null);
  check('...with reason too-many-bodies-theirs',
    narrow.lastReport && narrow.lastReport.reason === 'too-many-bodies-theirs', JSON.stringify(narrow.lastReport));

  const threeByTwoState = boardWideMate();
  threeByTwoState.oppTeam = threeByTwoState.oppTeam.slice(0, 2);
  threeByTwoState.bench.opp = threeByTwoState.oppTeam.slice(1);
  const threeOnTwo = mkSolver().solve(threeByTwoState, null);
  check('a 3v2 board is answered as well', !!threeOnTwo && threeOnTwo.solved === true && threeOnTwo.mateIn === 2,
    JSON.stringify(threeOnTwo));

  const fourState = boardWideMate();
  fourState.oppTeam = fourState.oppTeam.concat([mon('Great Tusk', { hpPercent: 90, setMoves: ['Earthquake'] })]);
  fourState.bench.opp = fourState.oppTeam.slice(1);
  const wideSolver = mkSolver();
  check('four living bodies is still refused: the bound is 3, not no bound',
    wideSolver.solve(fourState, null) === null);
  check('...with reason too-many-bodies-theirs',
    wideSolver.lastReport && wideSolver.lastReport.reason === 'too-many-bodies-theirs',
    JSON.stringify(wideSolver.lastReport));

  check('maxBranchingMoves bounds the branch list of an over-full body',
    mkSolver({ maxBranchingMoves: 3 })._movesOf(bodyWithTenAttacks()).length === 3);
  check('...while a legal set is never trimmed by the default',
    mkSolver()._movesOf(bodyWithTenAttacks()).length === 10,
    String(mkSolver()._movesOf(bodyWithTenAttacks()).length));

  /* --- the Speed band. Our exact Speed is known (we registered the set); theirs is a pool whose two
   * candidates straddle it, so the ORDER IS A FACT THE ENGINE DOES NOT HAVE. The old rail refused
   * the whole solve. */
  const pooled = theirStraddle(3000, 1);
  const bounds = mkSolver()._speedBounds(pooled);
  check('their band reaches the FASTEST candidate, not the slowest',
    bounds.max === U.maxSpeedForSet(valiantScarfSet()), JSON.stringify(bounds));
  check('...while a pool still proves no floor', bounds.min === 0, JSON.stringify(bounds));
  check('...and an observed ceiling still tightens the band it can',
    mkSolver()._speedBounds(Object.assign({}, pooled, { speedCeiling: 200 })).max === 200);

  const chanceSolver = mkSolver();
  const nodeOf = function (them, me) {
    return chanceSolver._nodeFrom(board([me || ourTwelve()], [them]), null);
  };
  const tiePool = mon('Kingambit', {
    isActive: true, hpPercent: 12, setMoves: ['Kowtow Cleave'], candidateSets: [
      Object.assign({}, valiantSet(), { weight: 2 }),
      Object.assign({}, valiantScarfSet(), { weight: 6 })
    ]
  });
  check('P(they act first) is the weighted share of their surviving sets, an exact tie counting 0.5',
    chanceSolver._oppFasterProbability(nodeOf(tiePool), 'Close Combat', 'Kowtow Cleave') === 0.875,
    String(chanceSolver._oppFasterProbability(nodeOf(tiePool), 'Close Combat', 'Kowtow Cleave')));
  const pool = function (set, weight) {
    return mon('Kingambit', {
      isActive: true, hpPercent: 12, setMoves: ['Kowtow Cleave'], candidateSets: [
        Object.assign({}, set, { weight: weight })
      ]
    });
  };
  check('...1 when every surviving set outspeeds us',
    chanceSolver._oppFasterProbability(nodeOf(pool(valiantScarfSet(), 4)), 'Close Combat', 'Kowtow Cleave') === 1);
  check('...0 when none of them does',
    chanceSolver._oppFasterProbability(nodeOf(pool(slowSet(), 4)), 'Close Combat', 'Kowtow Cleave') === 0);
  check('a priority gap decides with no coin flip at all',
    chanceSolver._oppFasterProbability(nodeOf(theirStraddle(50, 50)), 'Close Combat', 'Sucker Punch') === 1);
  check('an unknown Speed of OURS is not a probability to invent',
    chanceSolver._oppFasterProbability(nodeOf(theirStraddle(50, 50), mon('Great Tusk', { side: 'p1', isActive: true, setMoves: ['Earthquake'] })), 'Close Combat', 'Kowtow Cleave') === null);
  check('...and neither is a body with no candidate pool',
    chanceSolver._oppFasterProbability(nodeOf(mon('Kingambit', { isActive: true, hpPercent: 12, setMoves: ['Kowtow Cleave'] })), 'Close Combat', 'Kowtow Cleave') === null);
  const plain = chanceSolver._oppFasterProbability(nodeOf(theirStraddle(1, 2999)), 'Close Combat', 'Kowtow Cleave');
  const trBoard = board([ourTwelve()], [theirStraddle(1, 2999)]);
  trBoard.field.trickRoom = true;
  const underTR = chanceSolver._oppFasterProbability(chanceSolver._nodeFrom(trBoard, null), 'Close Combat', 'Kowtow Cleave');
  check('Trick Room INVERTS the probability rather than the answer',
    Math.abs((plain + underTR) - 1) < 1e-12, String(plain) + ' vs ' + String(underTR));

  /* --- and the arithmetic end to end. Both references are the SAME board with their order certain:
   * with the slow set they cannot act before our killing move (we have a mate in 1), with the Scarf
   * set they act first and the same board is a LOSS. A straddle in between must be the weighted
   * expectation of exactly those two numbers. */
  const vMyFirst = mkSolver().solve(board([ourTwelve()], [mon('Kingambit', {
    isActive: true, hpPercent: 12, liveSet: slowSet()
  })]), null);
  const vOppFirst = mkSolver().solve(board([ourTwelve()], [mon('Iron Valiant', {
    isActive: true, hpPercent: 12, liveSet: valiantScarfSet()
  })]), null);
  check('with their order certain the slow set is a mate in 1 for us',
    !!vMyFirst && vMyFirst.solved === true && vMyFirst.mateIn === 1, JSON.stringify(vMyFirst));
  check('...and the fast set is a certain loss (the same board, the other order)',
    !!vOppFirst && vOppFirst.solved === false && vOppFirst.score === -(ST.EndgameSolver.WIN - 1),
    JSON.stringify(vOppFirst));

  const halfSplit = mkSolver().solve(board([ourTwelve()], [theirStraddle(50, 50)]), null);
  check('an even split prices the pair at exactly the mean of the two orders',
    !!halfSplit && halfSplit.score === 0, halfSplit && String(halfSplit.score));
  check('...and that is an answer, not a refusal',
    !!halfSplit && halfSplit.solved === false && halfSplit.reason === 'no-forced-win',
    JSON.stringify(halfSplit));
  check('...with the number of chance-resolved pairs reported, so a caller can tell it apart from a proof',
    !!halfSplit && halfSplit.chancePairs === 3, halfSplit && String(halfSplit.chancePairs));

  const quarterSplit = mkSolver().solve(board([ourTwelve()], [theirStraddle(25, 75)]), null);
  check('a 25/75 split is the exact weighted expectation',
    !!quarterSplit && quarterSplit.score === 499999.5, quarterSplit && String(quarterSplit.score));

  const lopsided = mkSolver().solve(board([ourTwelve()], [theirStraddle(1, 2999)]), null);
  const p = 1 / 3000;
  const raw = p * vOppFirst.score + (1 - p) * vMyFirst.score;
  check('the raw expectation of a lopsided split lands INSIDE the mate band (the clamp is load-bearing)',
    raw >= ST.EndgameSolver.WIN - ST.EndgameSolver.MATE_BAND, String(raw));
  check('...so the value is clamped to the top of the non-mate region',
    !!lopsided && lopsided.score === ST.EndgameSolver.WIN - ST.EndgameSolver.MATE_BAND - 1,
    lopsided && String(lopsided.score));
  check('...and a coin flip can never be reported as a mate', !!lopsided && lopsided.solved === false,
    JSON.stringify(lopsided));

  const scrolling = mkSolver({ chanceNodes: false });
  check('chanceNodes:false restores the refusal that shipped before it',
    scrolling.solve(board([ourTwelve()], [theirStraddle(50, 50)]), null) === null);
  check('...with reason speed-undecided', scrolling.lastReport && scrolling.lastReport.reason === 'speed-undecided',
    JSON.stringify(scrolling.lastReport));
}

/* --------------------------------------------------------------------- summary */

console.log('\n=== summary ===');
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failures.length);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('ALL ENDGAME CHECKS PASSED (' + passed + ')');
process.exit(0);
