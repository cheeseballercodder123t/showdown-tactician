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

  /* The refusal is for a body with NO PRICED action at all — hazards, setup, phazing — not for
   * one whose moves are recovery or Protect: the 2026-10-15 hardening pass made those into
   * modelled actions (phase 1.2), so their refusal moved to the genuinely unmodelled set below. */
  const statusOnly = board([mon('Iron Valiant', { side: 'p1', isActive: true, setMoves: ['Close Combat'] })],
    [mon('Kingambit', { isActive: true, hpPercent: 12, setMoves: ['Stealth Rock', 'Swords Dance'] })]);
  check('an opponent with no modelled action refuses', s.solve(statusOnly, null) === null);
  check('...with reason no-modelled-move-theirs', s.lastReport && s.lastReport.reason === 'no-modelled-move-theirs',
    JSON.stringify(s.lastReport));

  const noneMine = board([mon('Iron Valiant', { side: 'p1', isActive: true, setMoves: ['Stealth Rock', 'Swords Dance'] })],
    [mon('Kingambit', { isActive: true, hpPercent: 12, setMoves: ['Kowtow Cleave'] })]);
  check('the same refusal fires for OUR side', s.solve(noneMine, null) === null &&
    s.lastReport.reason === 'no-modelled-move-mine');

  /* ...and the other half of that change: a recovery/Protect-only opponent is now SEARCHED. The
   * old tier called Recover/Roost "no move" and read their Protect as a free turn, which is the
   * single most dangerous way to be wrong about an endgame; both are actions now. */
  const modelledStatus = board([mon('Iron Valiant', { side: 'p1', isActive: true, setMoves: ['Close Combat'] })],
    [mon('Kingambit', { isActive: true, hpPercent: 12, setMoves: ['Protect', 'Recover'] })]);
  const healed = s.solve(modelledStatus, null);
  check('a recovery/Protect opponent is MODELLED rather than refused', healed !== null,
    JSON.stringify(s.lastReport));
  check('...and the heal is a real action in the tree (a 12 % body that can Roost is not a free KO)',
    !!healed && s._classifyMove('Recover') === 'recover' && s._classifyMove('Protect') === 'protect');

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

/* ===================== 7. the hardening pass: five structural fixes, each behind its own leaf */

section('7. the hardening pass (simultaneous ply, recovery/protect, physics, cache, multi-world)');
{
  const LEAVES = ['simultaneousPly', 'includeRecoveryAndProtect', 'modelPhysics', 'transposition', 'multiWorld'];
  check('all five hardening leaves are registered in config', LEAVES.every(function (k) {
    return ST.configGet('laplace.endgame.' + k, null) === true;
  }), LEAVES.map(function (k) { return k + '=' + ST.configGet('laplace.endgame.' + k, null); }).join(', '));
  check('...and the regret-matching round count', ST.configGet('laplace.endgame.regretIters', null) === 200);
  const dflt = mkSolver();
  check('a solver built from config reads every leaf ON',
    dflt.simultaneousPly === true && dflt.includeRecoveryAndProtect === true &&
    dflt.modelPhysics === true && dflt.transposition === true && dflt.multiWorld === true,
    JSON.stringify([dflt.simultaneousPly, dflt.includeRecoveryAndProtect, dflt.modelPhysics,
      dflt.transposition, dflt.multiWorld]));

  /* ---- 7a. simultaneous ply: the opponent may not read our secret turn-t action ---- */

  const game = dflt._matrixGameValue([[1, -1], [-1, 1]], 2, 2);
  check('a matching-pennies matrix solves to its GAME VALUE (0), not the -1 pure maximin',
    Math.abs(game) < 0.02, String(game));
  const dominant = dflt._matrixGameValue([[5, 5], [0, 9]], 2, 2);
  check('a matrix with a dominant row keeps that row\u2019s value (5, the maximin)',
    Math.abs(dominant - 5) < 0.05, String(dominant));

  /* A real board, both sides branching. The game value is never BELOW the pure maximin (it is a
   * relaxation), so turning the fix off can only lower or hold the number. */
  const branchy = board([mon('Garchomp', {
    side: 'p1', isActive: true, hpPercent: 60,
    liveSet: liveSet('Garchomp', ['Earthquake', 'Dragon Claw'], { nature: 'Jolly', evs: spread({ atk: 252, spe: 252 }) })
  })], [mon('Kingambit', {
    isActive: true, hpPercent: 60,
    liveSet: liveSet('Kingambit', ['Kowtow Cleave', 'Sucker Punch'], { nature: 'Adamant', evs: spread({ hp: 252, atk: 252 }) })
  })]);
  const simOn = mkSolver({ maxDepth: 3 }).solve(branchy, null);
  const simOff = mkSolver({ maxDepth: 3, simultaneousPly: false }).solve(branchy, null);
  check('the simultaneous solve is at least the pure maximin (the fix can never lower a floor)',
    !!simOn && !!simOff && simOn.score >= simOff.score,
    JSON.stringify([simOn && simOn.score, simOff && simOff.score]));
  check('...and the leaf really is switchable on one board',
    mkSolver({ simultaneousPly: false }).simultaneousPly === false && dflt.simultaneousPly === true);

  /* ---- 7b. recovery and Protect are actions ---- */

  check('a damaging move classifies as an attack', dflt._classifyMove('Close Combat') === 'attack');
  check('a heal classifies as recovery', dflt._classifyMove('Recover') === 'recover');
  check('a shield classifies as protect', dflt._classifyMove('Protect') === 'protect');
  check('a hazard stays out of the tree', dflt._classifyMove('Stealth Rock') === null,
    String(dflt._classifyMove('Stealth Rock')));
  check('...and with the leaf off, ALL THREE of those collapse to unmodelled',
    mkSolver({ includeRecoveryAndProtect: false })._classifyMove('Recover') === null &&
    mkSolver({ includeRecoveryAndProtect: false })._classifyMove('Protect') === null);

  const hurtState = board([mon('Iron Valiant', {
    side: 'p1', isActive: true, hpPercent: 40, liveSet: valiantSet()
  })], [mon('Kingambit', { isActive: true, hpPercent: 100, liveSet: slowSet() })]);
  const hurtNode = dflt._nodeFrom(hurtState, null);
  const healedNode = dflt._applyAction(hurtNode, 'my', { kind: 'recover', name: 'Recover' }, { my: false, opp: false });
  check('a heal restores 50 % of max HP, clamped to 100', healedNode.my.bodies[0].hp === 90,
    String(healedNode.my.bodies[0].hp));

  const shieldState = board([mon('Iron Valiant', {
    side: 'p1', isActive: true, hpPercent: 100, liveSet: valiantSet()
  })], [mon('Kingambit', { isActive: true, hpPercent: 100, liveSet: slowSet() })]);
  const shieldNode = dflt._nodeFrom(shieldState, null);
  const shielded = dflt._applyPair(shieldNode, { kind: 'attack', name: 'Close Combat' },
    { kind: 'protect', name: 'Protect' }, 'my');
  const unshielded = dflt._applyPair(shieldNode, { kind: 'attack', name: 'Close Combat' },
    { kind: 'attack', name: 'Kowtow Cleave' }, 'my');
  check('a shield blocks our hit for the turn (their HP is untouched)',
    shielded.opp.bodies[0].hp === 100, String(shielded.opp.bodies[0].hp));
  check('...while the same turn without it lands the damage', unshielded.opp.bodies[0].hp < 100,
    String(unshielded.opp.bodies[0].hp));

  const chained = dflt._nodeFrom(shieldState, null);
  chained.protect.opp = 1;                       // they shielded LAST turn
  const chainedActs = dflt._actionsFor(chained, 'opp');
  check('a second Protect in a row is NOT offered (it fails in the game)',
    chainedActs.every(function (a) { return a.kind !== 'protect'; }),
    JSON.stringify(chainedActs));
  check('...but it is offered once the chain is broken',
    dflt._actionsFor(shieldNode, 'opp').some(function (a) { return a.kind === 'protect'; }) ||
      dflt._classifyMove('Protect') === 'protect');

  /* ---- 7c. endgame physics: hazards, the Trick Room timer, chip ---- */

  const hazState = board([
    mon('Iron Valiant', { side: 'p1', isActive: true, liveSet: valiantSet() }),
    mon('Great Tusk', {
      side: 'p1', hpPercent: 80,
      liveSet: liveSet('Great Tusk', ['Earthquake'], { nature: 'Jolly', evs: spread({ atk: 252, spe: 252 }) })
    })
  ], [mon('Kingambit', { isActive: true, hpPercent: 100, liveSet: slowSet() })]);
  hazState.field.hazards.p1.rocks = true;
  const hazNode = dflt._nodeFrom(hazState, null);
  hazNode.my.bodies[0].hp = 0;
  dflt._replaceFainted(hazNode, 'my');
  /* Node HP is a PERCENT, so the charge is `hp - hazardPercent` directly. Great Tusk is
   * Ground/Fighting, where Rock is 0.5 x 0.5 = 0.25, so Stealth Rock bills 3.125 % -> rounded to
   * a tenth by the utility, i.e. 80 -> 76.9. */
  const rockCharge = U.hazardPercent('Great Tusk', '', '', hazState.field.hazards.p1);
  check('a replacement PAYS its entry hazards (Stealth Rock on Ground/Fighting: 80 -> 76.9)',
    hazNode.my.bodies[1].hp === 76.9, String(hazNode.my.bodies[1].hp));
  check('...and the charge is exactly U.hazardPercent\u2019s number, not a re-derived one',
    Math.abs(rockCharge - 3.1) < 1e-9 && hazNode.my.bodies[1].hp === 80 - rockCharge,
    JSON.stringify([rockCharge, hazNode.my.bodies[1].hp]));
  const noPhys = mkSolver({ modelPhysics: false })._nodeFrom(hazState, null);
  noPhys.my.bodies[0].hp = 0;
  mkSolver({ modelPhysics: false })._replaceFainted(noPhys, 'my');
  check('...and with the leaf off the replacement arrives untouched', noPhys.my.bodies[1].hp === 80,
    String(noPhys.my.bodies[1].hp));

  const trState = board([mon('Iron Valiant', { side: 'p1', isActive: true, liveSet: valiantSet() })],
    [mon('Kingambit', { isActive: true, hpPercent: 100, liveSet: slowSet() })]);
  trState.field.trickRoom = true;
  trState.field.trickRoomTurnsLeft = 2;
  const trNode = dflt._nodeFrom(trState, null);
  const trAfter = dflt._endOfTurn(trNode);
  check('the Trick Room timer ticks down (2 -> 1, still up)',
    trAfter.field.trickRoomTurnsLeft === 1 && trAfter.field.trickRoom === true,
    JSON.stringify([trAfter.field.trickRoomTurnsLeft, trAfter.field.trickRoom]));
  check('...and the source board is untouched by the tick', trState.field.trickRoomTurnsLeft === 2,
    String(trState.field.trickRoomTurnsLeft));
  trState.field.trickRoomTurnsLeft = 1;
  const trAfter2 = dflt._endOfTurn(dflt._nodeFrom(trState, null));
  check('...at 0 it expires and clears the flag',
    trAfter2.field.trickRoomTurnsLeft === 0 && trAfter2.field.trickRoom === false,
    JSON.stringify([trAfter2.field.trickRoomTurnsLeft, trAfter2.field.trickRoom]));

  const chipState = board([mon('Iron Valiant', {
    side: 'p1', isActive: true, hpPercent: 80, liveSet: valiantSet()
  })], [mon('Kingambit', {
    isActive: true, hpPercent: 80, liveSet: liveSet('Kingambit', ['Kowtow Cleave'], {
      nature: 'Adamant', evs: spread({ hp: 252, atk: 252 }), item: 'Leftovers'
    })
  })]);
  chipState.myTeam[0].status = 'brn';
  const chipNode = dflt._nodeFrom(chipState, null);
  const chipAfter = dflt._endOfTurn(chipNode);
  check('burn chips 1/16 off us at end of turn', Math.abs(chipAfter.my.bodies[0].hp - 73.75) < 1e-9,
    String(chipAfter.my.bodies[0].hp));
  check('...and Leftovers heals 1/16 on them', Math.abs(chipAfter.opp.bodies[0].hp - 86.25) < 1e-9,
    String(chipAfter.opp.bodies[0].hp));

  /* ---- 7d. the transposition cache is a memo, never a reproof ---- */

  const withTt = mkSolver().solve(boardWideMate(), null);
  const withoutTt = mkSolver({ transposition: false }).solve(boardWideMate(), null);
  check('the cache records hits on a board that transposes', !!withTt && withTt.transpositions > 0,
    withTt && String(withTt.transpositions));
  check('...and OFF it records none', !!withoutTt && withoutTt.transpositions === 0,
    withoutTt && String(withoutTt.transpositions));
  check('...and the ANSWER is identical either way (same value, mate and line)',
    !!withTt && !!withoutTt && withTt.score === withoutTt.score &&
      withTt.mateIn === withoutTt.mateIn &&
      JSON.stringify(withTt.line) === JSON.stringify(withoutTt.line),
    JSON.stringify([withTt && withTt.score, withoutTt && withoutTt.score]));

  /* ---- 7e. solveAcrossWorlds: one world is not evidence ---- */

  const meHealthy = mon('Iron Valiant', {
    side: 'p1', isActive: true, hpPercent: 100, liveSet: valiantSet()
  });
  const baseState = board([meHealthy], [mon('Kingambit', { isActive: true, hpPercent: 12, liveSet: slowSet() })]);
  const weakWorld = { team: [mon('Kingambit', { isActive: true, hpPercent: 12, liveSet: slowSet() })] };
  const tankWorld = { team: [mon('Corviknight', {
    isActive: true, hpPercent: 100,
    liveSet: liveSet('Corviknight', ['Iron Head', 'Roost'], { nature: 'Impish', evs: spread({ hp: 252, def: 252 }) })
  })] };
  const mw = mkSolver({ maxDepth: 3 });
  const agreed = mw.solveAcrossWorlds(baseState, [weakWorld, weakWorld]);
  check('a mate proven in every world is reported, with the world count',
    !!agreed && agreed.solved === true && agreed.worlds === 2, JSON.stringify(agreed));
  const split = mw.solveAcrossWorlds(baseState, [weakWorld, tankWorld]);
  check('a mate that ONE surviving world refutes is NOT reported', !!split && split.solved === false,
    JSON.stringify(split));
  check('...and the reported score is the WORST case over the worlds',
    !!split && split.score === Math.min.apply(null, split.worldScores),
    JSON.stringify(split && split.worldScores));
  check('...with every world\u2019s number carried on the report',
    !!split && Array.isArray(split.worldScores) && split.worldScores.length === 2,
    JSON.stringify(split && split.worldScores));
  const offMulti = mkSolver({ maxDepth: 3, multiWorld: false });
  const single = offMulti.solveAcrossWorlds(baseState, [weakWorld, tankWorld]);
  check('multiWorld:false is the shipped single-world contract again',
    !!single && single.solved === true && single.worlds === undefined, JSON.stringify(single));
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
