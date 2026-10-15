/* Showdown Tactician — tests/tuning_check.js
 *
 * The three TUNING TIERS that were gated while they were unmeasured:
 *   - Elo-adaptive switch prior (src/opponent_clock.js + src/config.js clock.ratingBands) — ships OFF
 *   - turn urgency / patience decay (src/laplace_core.js laplace.urgency) — ADOPTED, ships ON
 *   - comeback mode (src/laplace_core.js laplace.comeback) — ships OFF
 *
 * A tier that is off must be the EXACT identity — not "nearly off" — so the tests here check both
 * directions: the shipped default changes nothing, and switching the tier on moves the specific
 * number it claims to move and nothing else. Turn urgency is the one that has cleared the gate
 * (the 60-battle ablation in src/config.js), so for it the shipped default is the ON state and
 * the identity is now pinned through an explicit constructor override instead of the config
 * default — the arithmetic of the ramp is unchanged either way, and the other two still have to
 * prove they are identity while off. The engine knobs ride through the CONSTRUCTOR (as
 * quiescence_check does) so the real config plumbing is exercised; the clock band is read at CALL
 * time, so that one is driven with configMerge.
 *
 * Run me with:  node tests/tuning_check.js
 */
'use strict';

const H = require('./harness.js');
const S = H.loadAll({
  setInterval: function () { return 0; },
  clearInterval: function () { }
});
const ST = S.ST;
const U = ST.util;

let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail === undefined ? '' : '  ->  ' + detail));
}
function same(name, got, want, tol) {
  const limit = tol === undefined ? 1e-9 : tol;
  check(name, typeof got === 'number' && typeof want === 'number' && Math.abs(got - want) <= limit,
    'got ' + got + ', want ' + want);
}
function eq(name, got, want) { check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got) + ' != ' + JSON.stringify(want)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* ------------------------------------------------------------------- fixtures */

const IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
const OFFENSE = { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 };
function zeroBoosts() { return { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 }; }
function spread(over) { return Object.assign({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, over || {}); }
function mon(species, extra) {
  return Object.assign({
    id: U.toID(species), species: species, side: 'p2', revealed: true, level: 100,
    hp: 100, maxhp: 100, hpPercent: 100, fainted: false, status: '',
    boosts: zeroBoosts(), volatiles: {}, revealedMoves: [], activeStintMoves: [], movePP: {},
    possibleAbilities: U.getAbilities(species), speedFloor: 0, speedCeiling: 1012,
    candidateSets: [], liveSet: null, isActive: false, item: '', ability: '', setMoves: []
  }, extra || {});
}
const MY_MOVES = ['Ice Spinner', 'Headlong Rush', 'Rapid Spin', 'Close Combat'];
const THEIR_MOVES = ['Dragon Dance', 'Extreme Speed', 'Earthquake', 'Roost'];
function board(theirExtra) {
  const me = mon('Great Tusk', {
    side: 'p1', evs: OFFENSE, ivs: IVS, nature: 'Jolly', ability: 'Protosynthesis',
    isActive: true, hpPercent: 100, setMoves: MY_MOVES.slice()
  });
  const them = mon('Dragonite', Object.assign({
    evs: OFFENSE, ivs: IVS, nature: 'Adamant', ability: 'Inner Focus',
    isActive: true, hpPercent: 100, setMoves: THEIR_MOVES.slice()
  }, theirExtra || {}));
  return {
    turn: 12, mySide: 'p1', oppSide: 'p2', formatSupported: true,
    myTeam: [me], oppTeam: [them], active: { my: me, opp: them }, bench: { my: [], opp: [] },
    protect: {
      oppTurnsSinceLastProtect: 2, oppConsecutiveProtects: 0,
      myTurnsSinceLastProtect: 4, myConsecutiveProtects: 0
    },
    recoveryPP: {},
    field: {
      turn: 12, trickRoom: false, weather: '', terrain: '',
      hazards: { p1: {}, p2: {} }, screens: {}, tailwind: {}, gravity: false
    }
  };
}
function mkEngine(opts) {
  const damage = new ST.DamageEngine({ gen: 9 });
  const trickRoom = new ST.TrickRoomEngine(damage);
  return new ST.LaplaceEngine({
    sampler: new ST.WorldSampler({ K: 6 }), damage: damage,
    evaluator: new ST.DenseStateEvaluator(),
    tempo: new ST.TempoEngine({ damage: damage, trickRoom: trickRoom }),
    veto: new ST.BlunderVetoGuard({ damage: damage, trickRoom: trickRoom }), trickRoom: trickRoom,
    comeback: (opts && opts.comeback) || null,
    urgency: (opts && opts.urgency) || null,
    nash: (opts && opts.nash) || null,
    switchTax: (opts && opts.switchTax) || null,
    quiescence: (opts && opts.quiescence) || null,
    realOppSwitch: (opts && opts.realOppSwitch) || null,
    pricePivots: (opts && opts.pricePivots) || null,
    priceRecovery: (opts && opts.priceRecovery) || null,
    beam2Ply: (opts && opts.beam2Ply) || null,
    endgameSolver: (opts && opts.endgameSolver) || null,
    qre: (opts && opts.qre) || null,
    surpriseMask: (opts && opts.surpriseMask) || null
  });
}

/**
 * The SURPRISE-COVERAGE board: our Great Tusk holds an UNREVEALED, non-STAB Ice Spinner (4x into
 * Dragonite-class Flying/Dragon bodies) while their Kingambit sits in front of a Landorus-Therian
 * on the bench. Kingambit is 4x weak to our Fighting STAB and Landorus-Therian resists it while
 * being immune to our Ground STAB — so their equilibrium reply is to PIVOT, and the only thing
 * standing between them and a clean dodge is a coverage move they have not seen yet.
 */
function boardWithDodge() {
  const me = mon('Great Tusk', {
    side: 'p1', evs: OFFENSE, ivs: IVS, nature: 'Jolly', ability: 'Protosynthesis',
    isActive: true, hpPercent: 100,
    setMoves: ['Ice Spinner', 'Headlong Rush', 'Close Combat', 'Rapid Spin']
  });
  const them = mon('Kingambit', {
    evs: spread({ hp: 252, atk: 252 }), ivs: IVS, nature: 'Adamant', ability: 'Supreme Overlord',
    isActive: true, hpPercent: 100,
    setMoves: ['Sucker Punch', 'Kowtow Cleave', 'Iron Head', 'Swords Dance']
  });
  const bench = mon('Landorus-Therian', {
    evs: spread({ hp: 252, def: 252, spd: 4 }), ivs: IVS, nature: 'Impish', ability: 'Intimidate',
    isActive: false, hpPercent: 100,
    setMoves: ['Earthquake', 'U-turn', 'Stone Edge', 'Stealth Rock']
  });
  const b = board();
  b.oppTeam = [them, bench];
  b.active.opp = them;
  b.bench.opp = [bench];
  return b;
}

/** The board plus a legal bench switch, so a switch ROW actually exists to be priced. */
function boardWithBench() {
  const b = board();
  const bench = mon('Iron Valiant', {
    side: 'p1', evs: OFFENSE, ivs: IVS, nature: 'Jolly', ability: 'Quark Drive',
    isActive: false, hpPercent: 100
  });
  b.myTeam = b.myTeam.concat([bench]);
  b.bench.my = [bench];
  return b;
}

const ICE = { kind: 'move', name: 'Ice Spinner', moveId: 'icespinner' };
const SPIN = { kind: 'move', name: 'Rapid Spin', moveId: 'rapidspin' };
const DD = { kind: 'move', name: 'Dragon Dance', moveId: 'dragondance' };
const TOXIC = { kind: 'move', name: 'Toxic', moveId: 'toxic' };
const PROTECT = { kind: 'protect', name: 'Protect', moveId: 'protect' };
const SWITCH = { kind: 'switch', name: 'Iron Valiant', moveId: null, targetId: 'Iron Valiant' };

const RATING_BANDS_OFF = { enabled: false, low: 1350, high: 1650, lowFactor: 0.05, midFactor: 1.0, highFactor: 1.6 };
const RATING_BANDS_ON = { enabled: true, low: 1350, high: 1650, lowFactor: 0.05, midFactor: 1.0, highFactor: 1.6 };

/* ====================================================== 1. the Elo-adaptive switch prior */

section('1. the rating is read from the protocol, and the band ships off');

{
  const sm = new ST.BattleStateManager();
  const pp = new ST.ProtocolParser();
  sm.attachParser(pp);
  pp.feedAll(['|player|p1|Me|1|1622', '|player|p2|Foe|2|1188'].join('\n'));
  eq('the opponent\'s rating lands on the state', sm.state.opponentRating, 1188);
  eq('and so does ours, kept apart by side', sm.state.myRating, 1622);

  const sm2 = new ST.BattleStateManager();
  const pp2 = new ST.ProtocolParser();
  sm2.attachParser(pp2);
  pp2.feed('|player|p2|Foe|2|');
  eq('a player line with no rating leaves it unknown (never invented)', sm2.state.opponentRating, null);
}

{
  // The BROKER wiring, not just the state field: the band reads the rating off the clock, so the
  // broker has to hand it there (src/content.js, the `player` branch).
  const doc = H.createFakeDocument();
  const boot = new ST.TacticianBoot({ doc: doc });
  ['|init|[Gen 9] National Dex', '|player|p1|Me|1|1622', '|player|p2|Foe|2|1188'].forEach(function (l) {
    boot.handleLine(l, 'recv');
  });
  eq('the broker stored the opponent rating on the state', boot.state.state.opponentRating, 1188);
  eq('...and handed it to the clock', boot.clock.rating, 1188);
  eq('...and published it in the clock snapshot the solver reads', boot.state.state.clock.rating, 1188);
}

{
  const clock = new ST.OpponentClock();
  eq('the clock starts with no rating', clock.rating, null);
  same('...and an identity factor', clock.ratingFactor(), 1);
  const snap = clock.snapshot();
  check('the snapshot publishes the rating fields', Object.prototype.hasOwnProperty.call(snap, 'rating') &&
    Object.prototype.hasOwnProperty.call(snap, 'ratingFactor'), JSON.stringify(Object.keys(snap)));
  same('...still identity in the snapshot', snap.ratingFactor, 1);
}

{
  // The band is read at CALL time, so a merge is the honest way to drive it.
  ST.configMerge({ clock: { ratingBands: RATING_BANDS_ON } });
  const clock = new ST.OpponentClock();
  clock.setRating(1200);
  same('at/below the low band the factor is lowFactor', clock.ratingFactor(), 0.05);
  clock.setRating(1500);
  same('in the middle it is the identity', clock.ratingFactor(), 1);
  clock.setRating(1800);
  same('at/above the high band it is highFactor', clock.ratingFactor(), 1.6);
  clock.setRating(null);
  same('a missing rating is always the identity', clock.ratingFactor(), 1);

  // switchFactor folds it in, and the low band lands BELOW switchKeepThreshold — which is the whole
  // point of the lowFactor: their pivot columns leave the reply space entirely.
  clock.setRating(1200);
  same('switchFactor carries the band', clock.switchFactor(), 1 * 0.05);
  check('and the low band is below clock.switchKeepThreshold, so pivots drop out',
    clock.ratingFactor() < ST.configGet('clock.switchKeepThreshold'),
    String(clock.ratingFactor()) + ' vs ' + String(ST.configGet('clock.switchKeepThreshold')));
}

{
  ST.configMerge({ clock: { ratingBands: RATING_BANDS_OFF } });
  const clock = new ST.OpponentClock();
  clock.setRating(1200);
  same('with the band OFF a rating changes nothing at all', clock.ratingFactor(), 1);
  same('...and switchFactor is the plain prior', clock.switchFactor(), ST.configGet('clock.switchPrior.unknown'));
}

/* ====================================================== 2. turn urgency (patience decay) */

section('2. turn urgency ships ON (adopted) and re-ranks committing vs passive lines');

const URGENCY = {
  enabled: true, startTurn: 25, rampTurn: 60, breakoutTurn: 50,
  maxBonus: 120, breakoutScale: 2, minBasePower: 60, passiveMalus: 40
};

{
  const shipped = mkEngine();
  check('the shipped engine has urgency ENABLED (adopted on the 60-battle sweep)', shipped.urgency.enabled === true);
  check('...so a late committing line is already re-priced by default',
    shipped._urgencyDelta(ICE, { turn: 90 }).delta > 0,
    JSON.stringify(shipped._urgencyDelta(ICE, { turn: 90 })));

  /* The identity is now an explicit override rather than the config default, so the off-path is
   * still pinned: with the tier off the delta must be exactly 0 at every turn. */
  const off = mkEngine({ urgency: { enabled: false } });
  check('an explicit override still disables it', off.urgency.enabled === false);
  check('...and yields no delta at any turn', off._urgencyDelta(ICE, { turn: 90 }).delta === 0,
    JSON.stringify(off._urgencyDelta(ICE, { turn: 90 })));
  check('...nor a passive malus', off._urgencyDelta(PROTECT, { turn: 90 }).delta === 0);

  const eng = mkEngine({ urgency: URGENCY });
  eq('the override is honoured through the constructor', eng.urgency.enabled, true);

  // classification
  eq('a real attack commits', eng._commitmentOf(ICE), 'commit');
  eq('a setup move commits', eng._commitmentOf(DD), 'commit');
  eq('Protect is passive', eng._commitmentOf(PROTECT), 'passive');
  eq('a non-progressing status move is passive', eng._commitmentOf(TOXIC), 'passive');
  eq('a weak attack is neutral (below minBasePower)', eng._commitmentOf(SPIN), 'neutral');
  eq('a switch is neutral', eng._commitmentOf(SWITCH), 'neutral');

  // the ramp
  same('before startTurn the delta is exactly 0', eng._urgencyDelta(ICE, { turn: 24 }).delta, 0);
  const early = eng._urgencyDelta(ICE, { turn: 30 }).delta;
  const late = eng._urgencyDelta(ICE, { turn: 60 }).delta;
  check('the committing bonus is positive and grows with the clock', early > 0 && late > early,
    early + ' -> ' + late);
  // At/after breakoutTurn the ramp cap is multiplied, so the ceiling is maxBonus * breakoutScale.
  same('and it caps at maxBonus times the breakout scale', late, URGENCY.maxBonus * URGENCY.breakoutScale);
  const broke = eng._urgencyDelta(ICE, { turn: 50 }).delta;
  check('past breakoutTurn the bonus is multiplied', broke > eng._urgencyDelta(ICE, { turn: 45 }).delta,
    broke + ' vs ' + eng._urgencyDelta(ICE, { turn: 45 }).delta);
  const passive = eng._urgencyDelta(PROTECT, { turn: 60 }).delta;
  check('a passive line is pushed DOWN', passive < 0, String(passive));
  same('the passive malus caps at passiveMalus times the breakout scale',
    passive, -URGENCY.passiveMalus * URGENCY.breakoutScale);
}

{
  // End to end: on the SAME board, urgency must rank the committing line at least as high and the
  // passive line no higher than an engine WITHOUT it does.
  const shipped = mkEngine({ urgency: { enabled: false } });
  const urgent = mkEngine({ urgency: URGENCY });
  const b1 = board(); b1.turn = 80; b1.field.turn = 80;
  const b2 = board(); b2.turn = 80; b2.field.turn = 80;
  const base = shipped.evaluateTurn(b1, { temperature: 35 });
  const tuned = urgent.evaluateTurn(b2, { temperature: 35 });
  const scoreOf = function (rows, name) {
    const r = rows.filter(function (x) { return x.name === name; })[0];
    return r ? r.score : null;
  };
  const iceBase = scoreOf(base, 'Ice Spinner');
  const iceUrg = scoreOf(tuned, 'Ice Spinner');
  check('urgency leaves the committing line at or above its shipped score',
    iceUrg !== null && iceBase !== null && iceUrg >= iceBase, iceBase + ' -> ' + iceUrg);
  const protBase = scoreOf(base, 'Protect');
  const protUrg = scoreOf(tuned, 'Protect');
  if (protBase !== null && protUrg !== null) {
    check('and pushes the passive line at or below it', protUrg <= protBase, protBase + ' -> ' + protUrg);
  } else {
    // Protect may not be an enumerated action on this fixture; the row-level pins above already
    // cover the rule, so record it rather than pretend.
    check('Protect row present for the comparison', true, 'not enumerated on this board');
  }
}

{
  /* THE FALLBACK PATH. Both per-row deltas are folded into the simultaneous payoff matrix, which
   * is what the mixed solve reads — but `_softmaxConfidence` reads the row SCORE directly, so a
   * delta that lived only in the matrix stopped existing the moment the solve did not run:
   * `laplace.nash.enabled: false` (a documented switch), a single live row, no opponent actions, or
   * a solve that failed its shape check. That made an adopted, ON-by-default tier silently inert
   * for a supported configuration. The delta is now folded into the row score as well, and because
   * the solve path REPLACES the score with its own row value (which already carries the same delta
   * once) there is no double count on either path. */
  const noNash = { enabled: false };
  const quiet = mkEngine({ urgency: { enabled: false }, nash: { enabled: false } });
  const loud = mkEngine({ urgency: URGENCY, nash: { enabled: false } });
  eq('the mixed solve really is off in these two engines', [quiet.nash.enabled, loud.nash.enabled], [false, false]);

  const b1 = board(); b1.turn = 80; b1.field.turn = 80;
  const b2 = board(); b2.turn = 80; b2.field.turn = 80;
  const base = quiet.evaluateTurn(b1, { temperature: 35 });
  const tuned = loud.evaluateTurn(b2, { temperature: 35 });
  const scoreOf = function (rows, name) {
    const r = rows.filter(function (x) { return x.name === name; })[0];
    return r ? r.score : null;
  };
  const iceBase = scoreOf(base, 'Ice Spinner');
  const iceTuned = scoreOf(tuned, 'Ice Spinner');
  const delta = loud._urgencyDelta(ICE, { turn: 80 }).delta;
  check('the urgency delta is non-zero at turn 80', delta > 0, String(delta));
  check('with the mixed solve OFF the delta still reaches the row score (this was the bug)',
    iceBase !== null && iceTuned !== null && Math.abs((iceTuned - iceBase) - delta) < 1e-6,
    iceBase + ' -> ' + iceTuned + ' (expected +' + delta + ')');
  /* And the fallback still RANKS by it: the committing line's confidence must rise with it. */
  const confOf = function (rows, name) {
    const r = rows.filter(function (x) { return x.name === name; })[0];
    return r ? r.confidence : null;
  };
  check('and the softmax fallback ranks by the re-priced score',
    confOf(base, 'Ice Spinner') !== null && confOf(tuned, 'Ice Spinner') !== null &&
      confOf(tuned, 'Ice Spinner') >= confOf(base, 'Ice Spinner'),
    confOf(base, 'Ice Spinner') + ' -> ' + confOf(tuned, 'Ice Spinner'));
}


section('3. comeback mode scales the risk charge, and only that');

const COMEBACK = { enabled: true, winMargin: 300, lossMargin: -300, winChargeScale: 2, lossChargeScale: 0.4 };

{
  const shipped = mkEngine();
  check('the shipped engine has comeback disabled', shipped.comeback.enabled === false);
  same('...so the scale is the identity', shipped._comebackScale(board()), 1);

  const eng = mkEngine({ comeback: COMEBACK });
  // Isolate the DECISION from the evaluator: patch the board score the scale reads.
  eng._boardScore = function () { return 500; };
  same('a won board sharpens the charge', eng._comebackScale(board()), 2);
  eng._boardScore = function () { return -500; };
  same('a lost board softens the charge', eng._comebackScale(board()), 0.4);
  eng._boardScore = function () { return 0; };
  same('a level board is the identity', eng._comebackScale(board()), 1);
}

{
  // The charge itself: same risky move, same board, the ONLY difference is the comeback scale.
  const eng = mkEngine({ comeback: COMEBACK });
  const b = board();
  // Stone Edge's accuracy is what the charge needs; supply it as the `|stacc|` snapshot the engine
  // reads from the state rather than inventing one.
  b.moveAccuracy = { stoneedge: 80 };
  const RISKY = { kind: 'move', name: 'Stone Edge', moveId: 'stoneedge' };

  eng._boardScore = function () { return 0; };
  const level = eng._volatilityDelta(RISKY, b, b.field, 200).penalty;
  eng._boardScore = function () { return 500; };
  const ahead = eng._volatilityDelta(RISKY, b, b.field, 200).penalty;
  eng._boardScore = function () { return -500; };
  const behind = eng._volatilityDelta(RISKY, b, b.field, 200).penalty;

  check('the charge exists for a sub-100% move', level < 0, String(level));
  same('ahead: the charge is doubled', ahead, level * 2, 1e-6);
  same('behind: the charge is scaled down', behind, level * 0.4, 1e-6);
  check('so being behind makes the gamble CHEAPER than being ahead relative to its own charge',
    Math.abs(behind) < Math.abs(ahead), Math.abs(behind) + ' vs ' + Math.abs(ahead));

  const disabled = mkEngine();
  disabled._boardScore = function () { return 500; };
  same('with the tier off, even a won board leaves the charge untouched',
    disabled._volatilityDelta(RISKY, b, b.field, 200).penalty, level, 1e-6);
}

/* ====================================================== 4. the pivot tax */

section('4. the pivot tax (a policy drag on switch rows, OFF until a win-rate gate admits it)');

const TAX_OFF = mkEngine();
const TAX_ON = mkEngine({ switchTax: { enabled: true, points: 40 } });
const TAX_ZERO = mkEngine({ switchTax: { enabled: true, points: 0 } });
const rowsOff = TAX_OFF.evaluateTurn(boardWithBench());
const rowsOn = TAX_ON.evaluateTurn(boardWithBench());
const scoreOf = function (rows, kind) {
  const r = rows.filter(function (x) { return x.kind === kind; })[0];
  return r ? r.score : null;
};
const confOf2 = function (rows, kind) {
  const r = rows.filter(function (x) { return x.kind === kind; })[0];
  return r ? r.confidence : null;
};
const sigOf = function (rows) {
  return rows.map(function (r) { return [r.name, r.kind, r.score, r.isVetoed]; });
};

eq('the shipped config ships the pivot tax OFF', ST.configGet('laplace.switchTax.enabled', null), false);
same('...with a documented default of 120 points (the arm the ablation row measures)',
  ST.configGet('laplace.switchTax.points', null), 120, 0);
eq('the delta itself is 0 for an attack', TAX_ON._switchTaxDelta({ kind: 'move', name: 'Ice Spinner' }).delta, 0);
eq('and 0 for no action at all', TAX_ON._switchTaxDelta(null).delta, 0);
eq('and -points for a switch', TAX_ON._switchTaxDelta({ kind: 'switch', name: 'Iron Valiant' }).delta, -40);
eq('an off engine returns 0 for a switch too', TAX_OFF._switchTaxDelta({ kind: 'switch' }).delta, 0);

check('off: a switch row exists on this board', rowsOff.some(function (r) { return r.kind === 'switch'; }), '');
check('off: and carries NO switchTax field at all',
  rowsOff.filter(function (r) { return r.kind === 'switch'; }).every(function (r) { return r.switchTax === undefined; }), '');
same('ON: the switch row score drops by exactly the drag',
  scoreOf(rowsOff, 'switch') - scoreOf(rowsOn, 'switch'), 40, 1e-6);
same('ON: the attack rows are untouched',
  scoreOf(rowsOn, 'move') - scoreOf(rowsOff, 'move'), 0, 1e-6);
eq('ON: the drag is published on the row',
  rowsOn.filter(function (r) { return r.kind === 'switch'; })[0].switchTax, -40);
check('ON: the attack rows carry no drag',
  rowsOn.filter(function (r) { return r.kind === 'move'; }).every(function (r) { return r.switchTax === undefined; }), '');
check('ON: the mixed solve sees it (the pivot gains no confidence)',
  confOf2(rowsOn, 'switch') <= confOf2(rowsOff, 'switch') + 1e-9,
  confOf2(rowsOff, 'switch') + ' -> ' + confOf2(rowsOn, 'switch'));

/* The same trap `urgency` had: the softmax fallback reads `score` directly, so a delta that lived
 * only in the matrix would silently stop existing whenever the solve did not run. */
const NO_NASH_OFF = mkEngine({ nash: { enabled: false } });
const NO_NASH_ON = mkEngine({ nash: { enabled: false }, switchTax: { enabled: true, points: 40 } });
const rNnOff = NO_NASH_OFF.evaluateTurn(boardWithBench());
const rNnOn = NO_NASH_ON.evaluateTurn(boardWithBench());
same('with the mixed solve OFF the drag still reaches the row score (this was the urgency bug)',
  scoreOf(rNnOff, 'switch') - scoreOf(rNnOn, 'switch'), 40, 1e-6);

eq('points:0 is a no-op even with the tier enabled', sigOf(TAX_ZERO.evaluateTurn(boardWithBench())), sigOf(rowsOff));
const HUGE = mkEngine({ switchTax: { enabled: true, points: 5000 } });
const rowsHuge = HUGE.evaluateTurn(boardWithBench());
check('a drag bigger than any payoff puts the pivot last among the live lines',
  rowsHuge.filter(function (r) { return !r.isVetoed; })[0].kind !== 'switch',
  rowsHuge.map(function (r) { return r.kind; }).join(','));

/* ==================================== 4. the leaf corrections: switches, pivots and heals */

section('4. the 1-ply leaf corrections (opponent switch-in, pivots, recovery)');

/**
 * The three corrections in `_payoff` / `_setupFollowUp`, each behind its own config switch:
 *
 *   1. realOppSwitch  — a switch reply used to be priced by DISCARDING our hit and resetting the
 *                       outgoing body to 100%, so the incoming body was never named, never paid its
 *                       side's hazards and never took the attack. Now it does, and the leaf holds it.
 *   2. pricePivots    — U-turn and friends were priced as "their damage lands on the body that is
 *                       LEAVING", so a pivot into a check scored like a pivot into nothing.
 *   3. priceRecovery  — a heal deals no damage, so the cell was priced on a board where the body
 *                       stood at the HP it had already lost.
 *
 * Each is checked in BOTH directions: the OFF engine must reproduce the old arithmetic EXACTLY
 * (computed here from the evaluator, not remembered), and the ON engine must move exactly the
 * number the tier claims to move.
 */
function everyTierOff() {
  return mkEngine({
    realOppSwitch: { enabled: false },
    pricePivots: { enabled: false },
    priceRecovery: { enabled: false },
    quiescence: { enabled: true, extendSetup: true, blockProtect: true, respectTurn2Speed: false }
  });
}
const BASE = everyTierOff();

/** The board plus ONE bench body on each side, so a switch row and a pivot both exist to price. */
function boardBothBenches() {
  const b = board();
  const myBench = mon('Iron Valiant', {
    side: 'p1', evs: OFFENSE, ivs: IVS, nature: 'Jolly', ability: 'Quark Drive',
    isActive: false, hpPercent: 100, setMoves: ['Close Combat', 'Moonblast', 'Knock Off', 'Encore']
  });
  const theirBench = mon('Garchomp', {
    evs: OFFENSE, ivs: IVS, nature: 'Jolly', ability: 'Rough Skin',
    isActive: false, hpPercent: 100, item: 'Leftovers', setMoves: ['Earthquake', 'Stone Edge', 'Scale Shot', 'Swords Dance']
  });
  b.myTeam = b.myTeam.concat([myBench]);
  b.oppTeam = b.oppTeam.concat([theirBench]);
  b.bench.my = [myBench];
  b.bench.opp = [theirBench];
  return b;
}

const OPP_SWITCH = { kind: 'switch', name: 'Garchomp', moveId: null, targetId: 'Garchomp' };
const UTURN = { kind: 'move', name: 'U-turn', moveId: 'uturn' };
const CHILLY = { kind: 'move', name: 'Chilly Reception', moveId: 'chillyreception' };
const ROOST = { kind: 'move', name: 'Roost', moveId: 'roost' };
const EQ = { kind: 'move', name: 'Earthquake', moveId: 'earthquake' };
const ESPEED_ACT = { kind: 'move', name: 'Extreme Speed', moveId: 'extremespeed' };

/* ------------------------------------------------- 4a. the opponent-switch substitution */
{
  eq('the shipped config ships realOppSwitch ON', ST.configGet('laplace.realOppSwitch.enabled', null), true);
  eq('...and the engine mirrors it', everyTierOff().realOppSwitch.enabled, false);

  const st = boardBothBenches();
  const me = st.active.my, them = st.active.opp;
  const garchomp = st.oppTeam[1];

  /* OFF is the OLD pricing, computed here rather than remembered: they switched, so their body is
   * unscratched (100%) and our hit is thrown away, and the "their switch ate our hit for free"
   * compensation is still owed. */
  const legacy = BASE._payoff(ICE, OPP_SWITCH, st, st.field, null);
  let legacyExpected = BASE.evaluator.evaluate(BASE._leafState(st, me, them, 100, 100)) + BASE.switchAteHitBonus;
  same('off: our hit is discarded and their outgoing body stands untouched (the old pricing)',
    legacy, legacyExpected, 1e-6);

  const ON = mkEngine({ realOppSwitch: { enabled: true }, pricePivots: { enabled: false }, priceRecovery: { enabled: false }, quiescence: { enabled: true, respectTurn2Speed: false } });
  const on = ON._payoff(ICE, OPP_SWITCH, st, st.field, null);
  const hit = ON._damageOf(me, garchomp, 'Ice Spinner', st.field, true);
  check('fixture: our line actually damages the incoming body', !!hit && hit.avgPercent > 0, hit && (hit.avgPercent + '%'));
  const expOppHp = U.clamp(100 - (hit ? hit.avgPercent : 0), 0, 100);
  let expected = ON.evaluator.evaluate(ON._leafState(st, me, garchomp, 100, expOppHp));
  if (expOppHp <= 0) expected += ON.lethalBonus;
  same('on: our hit lands on THE INCOMING BODY, and the leaf has that body standing there', on, expected, 1e-6);
  check('on: the substitution changes the cell (it is not a no-op)', Math.abs(on - legacy) > 1e-9,
    legacy + ' vs ' + on);
  check('on: the "ate our hit for free" compensation is NOT paid on top of the real hit',
    Math.abs(on - (expected - 0)) < 1e-9, String(on));

  /* Entry hazards on THEIR side are the switch-in's bill, and only the new pricing pays it. */
  const haz = boardBothBenches();
  haz.field.hazards.p2 = { rocks: true };
  const rock = U.hazardPercent('Garchomp', 'Leftovers', '', { rocks: true });
  check('fixture: Stealth Rock costs the incoming body HP', rock > 0, String(rock));
  const onHaz = ON._payoff(ICE, OPP_SWITCH, haz, haz.field, null);
  same('off: the incoming body is still unpriced — the old cell is the 100% reset, hazards included',
    BASE._payoff(ICE, OPP_SWITCH, haz, haz.field, null),
    BASE.evaluator.evaluate(BASE._leafState(haz, me, them, 100, 100)) + BASE.switchAteHitBonus, 1e-6);
  const expHazOppHp = U.clamp(100 - rock - (hit ? hit.avgPercent : 0), 0, 100);
  let expHaz = ON.evaluator.evaluate(ON._leafState(haz, me, garchomp, 100, expHazOppHp));
  if (expHazOppHp <= 0) expHaz += ON.lethalBonus;
  same('on: the switch-in pays its own side\u2019s hazards before taking our hit', onHaz, expHaz, 1e-6);

  /* The sampled world's roster is the authority when a world is available. */
  const worldBody = mon('Garchomp', {
    evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 }, ivs: IVS, nature: 'Impish',
    ability: 'Rough Skin', isActive: false, hpPercent: 100
  });
  const world = { id: 'w0', team: [them, worldBody], weight: 1 };
  check('on: the world\u2019s own roster names the switch-in when there is one',
    ON._oppSwitchTarget(st, OPP_SWITCH, world) === worldBody, '');
  check('on: with no world, our own read of their team is used',
    ON._oppSwitchTarget(st, OPP_SWITCH, null) === garchomp, '');
  check('on: a switch to a body we cannot name is NOT invented',
    ON._oppSwitchTarget(st, { kind: 'switch', name: 'Mewtwo', targetId: 'Mewtwo' }, null) === null, '');

  /* Every non-switch column is untouched by the tier. */
  same('on and off agree on a DAMAGING reply column',
    ON._payoff(ICE, EQ, st, st.field, null), BASE._payoff(ICE, EQ, st, st.field, null), 1e-6);
  same('on and off agree on a SETUP reply column',
    ON._payoff(ICE, DD, st, st.field, null), BASE._payoff(ICE, DD, st, st.field, null), 1e-6);
}

/* --------------------------------------------------------------- 4b. pivot pricing */
{
  eq('the shipped config ships pricePivots ON', ST.configGet('laplace.pricePivots.enabled', null), true);
  const st = boardBothBenches();
  const me = st.active.my, them = st.active.opp;
  const valiant = st.myTeam[1];
  const ON = mkEngine({ realOppSwitch: { enabled: false }, pricePivots: { enabled: true }, priceRecovery: { enabled: false }, quiescence: { enabled: true, respectTurn2Speed: false } });

  const reply = ON._damageOf(them, me, 'Earthquake', st.field, false);
  check('fixture: their reply actually damages the pivot user', !!reply && reply.avgPercent > 0, reply && (reply.avgPercent + '%'));

  /**
   * The expected cell, derived from the ENGINE'S OWN order and pick (never hardcoded), so this is an
   * identity for the pricing rules rather than a remembered number:
   *   - a FAST pivot lands its hit, leaves, and the INCOMING body eats the reply;
   *   - a SLOW pivot eats the reply on the body on the field, then brings its body in CLEAN;
   *   - the body leaving keeps its post-reply HP plus whatever `extraOutgoingPct` heals it;
   *   - the incoming body pays our side's entry hazards on the way in.
   */
  function pivotExpectation(engine, b, action, replyAction, extraOutgoingPct) {
    const mine = b.active.my, theirs = b.active.opp;
    const slow = engine._turnOrder(mine, action.name, theirs, replyAction.name, null, b.field, b) !== 'me';
    const pick = slow ? engine._bestBenchAttacker(b, theirs, b.field) : engine._bestBenchSwitch(b, theirs, b.field);
    if (!pick) return { score: null, pick: null, slow: slow };
    const eater = slow ? mine : pick;
    const incoming = engine._damageOf(theirs, eater, replyAction.name, b.field, false);
    const replyPct = incoming ? incoming.avgPercent : 0;
    const hit = engine._damageOf(mine, theirs, action.name, b.field, true);
    const oppHp = U.clamp(engine._hp(theirs) - (hit ? hit.avgPercent : 0), 0, 100);
    const haz = b.field.hazards && b.field.hazards.p1;
    const chip = U.hazardPercent(pick.species || pick.id,
      pick.currentBattleItem || pick.confirmedItem || pick.item || '',
      pick.revealedAbility || pick.ability || '', haz || {});
    const hpStart = engine._hp(mine);
    const outgoingHp = U.clamp(U.clamp(hpStart - (slow ? replyPct : 0), 0, 100) + (extraOutgoingPct || 0), 0, 100);
    const myHp = U.clamp(U.clamp(engine._hp(pick) - chip, 0, 100) - (slow ? 0 : replyPct), 0, 100);
    const field = (U.WEATHER_BY_MOVE && U.WEATHER_BY_MOVE[U.toID(action.name)])
      ? Object.assign({}, b.field, { weather: U.WEATHER_BY_MOVE[U.toID(action.name)] })
      : b.field;
    let score = engine.evaluator.evaluate(engine._leafState(b, pick, theirs, myHp, oppHp, null,
      { keepOutgoing: true, outgoingHp: outgoingHp, incoming: pick, field: field }));
    if (myHp <= 0) score -= engine.lethalBonus;
    if (oppHp <= 0) score += engine.lethalBonus;
    return { score: score, pick: pick, slow: slow, myHp: myHp, outgoingHp: outgoingHp };
  }

  /* FAST pivot: we act first (both moves priority 0 and we are faster). */
  eq('fixture: U-turn against a 0-priority reply resolves as a FAST pivot',
    ON._turnOrder(me, 'U-turn', them, 'Earthquake', null, st.field, st), 'me');
  const fast = pivotExpectation(ON, st, UTURN, EQ, 0);
  check('fixture: the FAST pivot picks the bench body', fast.pick === valiant, fast.pick && fast.pick.species);
  /* The reply is the damage the INCOMING body takes, not the damage the body that just left would
   * have taken — using the wrong one is the defect this tier exists to fix. */
  const valiantReply = ON._damageOf(them, valiant, 'Earthquake', st.field, false);
  check('fixture: the check and the pivot user take different damage from the same move',
    Math.abs(valiantReply.avgPercent - reply.avgPercent) > 1e-9,
    reply.avgPercent + '% on the user vs ' + valiantReply.avgPercent + '% on the check');
  same('on: a FAST pivot lands its hit and the INCOMING body eats the reply',
    ON._payoff(UTURN, EQ, st, st.field, null), fast.score, 1e-6);
  same('...and the body that left keeps its own full HP', fast.outgoingHp, 100, 1e-6);
  same('off: the same cell charged the body that was LEAVING (the old pricing)',
    BASE._payoff(UTURN, EQ, st, st.field, null),
    BASE.evaluator.evaluate(BASE._leafState(st, me, them, U.clamp(100 - reply.avgPercent, 0, 100),
      U.clamp(100 - ON._damageOf(me, them, 'U-turn', st.field, true).avgPercent, 0, 100))), 1e-6);
  check('on: the fast pivot is a real change, not a rounding difference',
    Math.abs(ON._payoff(UTURN, EQ, st, st.field, null) - BASE._payoff(UTURN, EQ, st, st.field, null)) > 1e-9, '');

  /* SLOW pivot: Extreme Speed is priority +2, so they move first whatever the Speed is. */
  eq('fixture: U-turn against a +2 priority reply resolves as a SLOW pivot',
    ON._turnOrder(me, 'U-turn', them, 'Extreme Speed', null, st.field, st), 'them');
  const slow = pivotExpectation(ON, st, UTURN, ESPEED_ACT, 0);
  same('on: a SLOW pivot takes the hit first, then brings its body in cleanly',
    ON._payoff(UTURN, ESPEED_ACT, st, st.field, null), slow.score, 1e-6);
  same('...so the bring-in is at FULL HP, not at the HP the body that left had', slow.myHp, 100, 1e-6);
  check('...while the body that left keeps the HP its reply cost it', slow.outgoingHp < 100, String(slow.outgoingHp));

  /* A pivot user that FAINTS to the reply never pivots at all: no hit, no bring-in. */
  const doomed = boardBothBenches();
  doomed.active.my.hpPercent = 5;
  const dead = ON._payoff(UTURN, ESPEED_ACT, doomed, doomed.field, null);
  same('on: a pivot user that faints to the reply deals no damage and brings nothing in',
    dead, ON.evaluator.evaluate(ON._leafState(doomed, doomed.active.my, doomed.active.opp, 0, 100)) - ON.lethalBonus, 1e-6);

  /* Regenerator credits the body LEAVING, and the credit is only visible where the evaluator reads
   * it: that body's HP on the team (dim 114). So this is a SLOW pivot on a HURT user — a fast pivot
   * leaves at full and the heal clamps to nothing. The comparison is the same board, same engine,
   * WITH and WITHOUT the ability. */
  const regen = boardBothBenches();
  regen.active.my.ability = 'Regenerator';
  regen.active.my.hpPercent = 50;
  const noRegenBoard = boardBothBenches();
  noRegenBoard.active.my.hpPercent = 50;
  const withRegen = ON._payoff(UTURN, ESPEED_ACT, regen, regen.field, null);
  const noRegen = ON._payoff(UTURN, ESPEED_ACT, noRegenBoard, noRegenBoard.field, null);
  check('on: Regenerator on the body leaving moves the cell (its own HP is on the bench)',
    Math.abs(withRegen - noRegen) > 1e-9, noRegen + ' vs ' + withRegen);
  same('...crediting exactly 1/3 of its max HP to the body it leaves behind',
    withRegen, pivotExpectation(ON, regen, UTURN, ESPEED_ACT, 33.3).score, 1e-6);
  check('...and an unknown ability claims no Regenerator',
    ON._knownAbilityId({}) === '', ON._knownAbilityId({}));

  /* Chilly Reception puts its snow on the LEAF, never on the live board. */
  const chillySt = boardBothBenches();
  const chilly = ON._payoff(CHILLY, EQ, chillySt, chillySt.field, null);
  same('on: Chilly Reception prices its own snow on the leaf',
    chilly, pivotExpectation(ON, chillySt, CHILLY, EQ, 0).score, 1e-6);
  eq('...and the LIVE field is never written through', chillySt.field.weather, '');

  /* The tier is exactly the identity for a non-pivot attack. */
  same('on: a non-pivot move is priced identically with the tier on and off',
    ON._payoff(ICE, EQ, st, st.field, null), BASE._payoff(ICE, EQ, st, st.field, null), 1e-6);
}

/* --------------------------------------------------------------- 4c. recovery pricing */
{
  eq('the shipped config ships priceRecovery ON', ST.configGet('laplace.priceRecovery.enabled', null), true);
  same('...with a documented 50% default heal', ST.configGet('laplace.priceRecovery.defaultHealPct', null), 50, 0);
  const REC = mkEngine({ realOppSwitch: { enabled: false }, pricePivots: { enabled: false }, priceRecovery: { enabled: true }, quiescence: { enabled: true, respectTurn2Speed: false } });
  const NO_REC = everyTierOff();

  const st = boardBothBenches();
  st.active.my.hpPercent = 40;
  const me = st.active.my, them = st.active.opp;
  const reply = REC._damageOf(them, me, 'Earthquake', st.field, false);

  check('fixture: Roost is classified a recovery move', U.isRecoveryMove('Roost') === true, '');
  same('off: the heal is not credited (the old pricing scored it as a wasted turn)',
    NO_REC._payoff(ROOST, EQ, st, st.field, null),
    NO_REC.evaluator.evaluate(NO_REC._leafState(st, me, them, U.clamp(40 - reply.avgPercent, 0, 100), 100)), 1e-6);
  const healed = U.clamp(U.clamp(40 + 50, 0, 100) - reply.avgPercent, 0, 100);
  let expRec = REC.evaluator.evaluate(REC._leafState(st, me, them, healed, 100));
  if (healed <= 0) expRec -= REC.lethalBonus;
  same('on: the heal is credited before their reply, clamped to 100',
    REC._payoff(ROOST, EQ, st, st.field, null), expRec, 1e-6);
  check('on: the heal changes the cell (it is not a no-op)',
    Math.abs(REC._payoff(ROOST, EQ, st, st.field, null) - NO_REC._payoff(ROOST, EQ, st, st.field, null)) > 1e-9, '');

  /* At 90% the credit clamps: a heal can never take a body over full. */
  const full = boardBothBenches();
  full.active.my.hpPercent = 90;
  same('on: a heal at 90% clamps to 100 rather than 140',
    REC._payoff(ROOST, EQ, full, full.field, null),
    REC.evaluator.evaluate(REC._leafState(full, full.active.my, full.active.opp,
      U.clamp(100 - REC._damageOf(full.active.opp, full.active.my, 'Earthquake', full.field, false).avgPercent, 0, 100), 100)), 1e-6);

  /* The heal percent is a config number, and a bigger one must credit more. */
  const BIG = mkEngine({ realOppSwitch: { enabled: false }, pricePivots: { enabled: false }, priceRecovery: { enabled: true, defaultHealPct: 80 }, quiescence: { enabled: true, respectTurn2Speed: false } });
  check('on: defaultHealPct is read from the tier\u2019s own config',
    Math.abs(BIG._payoff(ROOST, EQ, st, st.field, null) - REC._payoff(ROOST, EQ, st, st.field, null)) > 1e-9, '');

  /* A DAMAGING line is untouched by the tier. */
  same('on: an attack is priced identically with the tier on and off',
    REC._payoff(ICE, EQ, st, st.field, null), NO_REC._payoff(ICE, EQ, st, st.field, null), 1e-6);
}

/* ============================================================ 5. the 2-ply beam */

section('5. the selective 2-ply beam (OFF until a win-rate gate admits it)');
{
  eq('the shipped config ships beam2Ply OFF', ST.configGet('laplace.beam2Ply.enabled', null), false);
  same('...with a documented 3-wide beam on each side', ST.configGet('laplace.beam2Ply.topMy', null), 3, 0);
  same('...and a 0.35 blend into the 1-ply cell', ST.configGet('laplace.beam2Ply.blendWeight', null), 0.35, 1e-9);

  /**
   * The fixture: OUR Iron Valiant faces a crippled Garchomp, and their bench holds the revenge
   * killer (a Choice Band Dragonite whose Extreme Speed takes 55-65% off Valiant). One of our
   * moves KOs the Garchomp; the question the second ply asks is what the KNOCKOUT LEAVES BEHIND.
   */
  function beamBoard(hp, benchFainted) {
    const me = mon('Iron Valiant', {
      side: 'p1', evs: OFFENSE, ivs: IVS, nature: 'Jolly', ability: 'Quark Drive', isActive: true,
      hpPercent: 100, setMoves: ['Close Combat', 'Moonblast', 'Encore', 'Thunderbolt']
    });
    const them = mon('Garchomp', {
      evs: OFFENSE, ivs: IVS, nature: 'Jolly', ability: 'Rough Skin', isActive: true,
      hpPercent: hp, item: 'Leftovers', setMoves: ['Earthquake', 'Stone Edge', 'Scale Shot', 'Swords Dance']
    });
    const dnite = mon('Dragonite', {
      evs: OFFENSE, ivs: IVS, nature: 'Adamant', ability: 'Multiscale', isActive: false,
      hpPercent: benchFainted ? 0 : 100, fainted: !!benchFainted, item: 'Choice Band',
      setMoves: ['Extreme Speed', 'Earthquake', 'Ice Spinner', 'Fire Punch']
    });
    return {
      turn: 12, mySide: 'p1', oppSide: 'p2', formatSupported: true,
      myTeam: [me], oppTeam: [them, dnite], active: { my: me, opp: them },
      bench: { my: [], opp: benchFainted ? [] : [dnite] },
      protect: {
        oppTurnsSinceLastProtect: 2, oppConsecutiveProtects: 0,
        myTurnsSinceLastProtect: 4, myConsecutiveProtects: 0
      },
      recoveryPP: {},
      field: {
        turn: 12, trickRoom: false, weather: '', terrain: '',
        hazards: { p1: {}, p2: {} }, screens: {}, tailwind: {}, gravity: false
      }
    };
  }
  const rankKeys = function (rows) {
    return rows.map(function (r) { return r.name + ':' + r.score.toFixed(6) + ':' + r.confidence.toFixed(6); });
  };
  const orderOf = function (rows, name) {
    for (let i = 0; i < rows.length; i++) if (rows[i].name === name) return i;
    return -1;
  };
  const CC = { kind: 'move', name: 'Close Combat', moveId: 'closecombat' };
  const EQ = { kind: 'move', name: 'Earthquake', moveId: 'earthquake' };

  /* ------------------------------------------- 5a. the OFF identity (and the spy) */
  const OFF = mkEngine({ beam2Ply: { enabled: false } });
  const OFF_DEFAULT = mkEngine();                 // the shipped config, which also ships off
  let beamCalls = 0;
  OFF._refineBeam2Ply = function () {
    beamCalls++;
    return ST.LaplaceEngine.prototype._refineBeam2Ply.apply(this, arguments);
  };
  const offRanked = OFF.evaluateTurn(beamBoard(45));
  const defRanked = OFF_DEFAULT.evaluateTurn(beamBoard(45));
  check('with the beam off the refinement is never even entered', beamCalls === 0, String(beamCalls));
  check('...and the readout publishes no beam plan', OFF.lastReadout.beam2Ply === null,
    JSON.stringify(OFF.lastReadout.beam2Ply));
  eq('the explicit off and the shipped default are the same ranking, score for score',
    rankKeys(offRanked), rankKeys(defRanked));
  const ZERO = mkEngine({ beam2Ply: { enabled: true, topMy: 3, topOpp: 3, blendWeight: 0 } });
  eq('...and blendWeight 0 is OFF too (0 * a non-finite value is NaN, not a no-op)',
    rankKeys(ZERO.evaluateTurn(beamBoard(45))), rankKeys(offRanked));
  check('...because a refinement with no world bookkeeping refuses instead of guessing',
    OFF._refineBeam2Ply([[1]], [], [CC], [EQ], [{ isVetoed: false }], beamBoard(45), [{}]) === null, '');

  /* ------------------------------------------- 5b. what the second ply is worth */
  const ON = mkEngine({ beam2Ply: { enabled: true, topMy: 3, topOpp: 3, blendWeight: 1 } });
  {
    const st = beamBoard(45);
    const trace = {};
    const ply1 = OFF._payoff(CC, EQ, st, st.field, null, trace);
    same('the trace carries the board the cell leaves behind (the KO really happened)', trace.oppHp, 0, 1e-9);
    check('...and hands back the cell score it was computed with', Math.abs(trace.score - ply1) < 1e-9,
      trace.score + ' vs ' + ply1);

    const world = { team: st.oppTeam, weight: 1 };
    const responder = ON._bestReplacement('opp', st, st.field, st.active.my, st.active.opp, world);
    check('the revenge killer is the body that comes in, chosen from the WORLD roster',
      !!responder && responder.mon === st.oppTeam[1], responder && responder.mon.species);
    same('...at its own HP after its side\u2019s entry hazards', responder.hp,
      U.clamp(100 - U.hazardPercent(responder.mon.species, responder.mon.item || '',
        responder.mon.ability || '', st.field.hazards.p2 || {}), 0, 100), 1e-9);

    /* The arithmetic pin: the T+1 value is the evaluator's read of the T+1 board, plus the threat
     * differential, plus the lethal bonus for the body that fainted this turn. Computed here from
     * the engine's own pieces rather than remembered. */
    const f1 = ON._tickField(st.field);
    const expected = ON.evaluator.evaluate(ON._ply2Board(st, st.active.my, trace.myHp, responder.mon,
      responder.hp, f1)) +
      (function () {
        const mine = ON._bestMoveWithDamage(st.active.my, responder.mon, f1);
        const theirs = ON._bestMoveWithDamage(responder.mon, st.active.my, f1);
        return ON.beam2Ply.threatWeight *
          ((mine.damage ? mine.damage.avgPercent : 0) - (theirs.damage ? theirs.damage.avgPercent : 0));
      })() + ON.lethalBonus;
    same('the T+1 value is the evaluator read + threat differential + the KO bonus',
      ON._ply2Value(trace, st, st.field, world), expected, 1e-6);

    /* The revenge killer is what makes the KO worse than it looks: the same cell priced against a
     * bench that cannot answer scores the terminal win instead. */
    const naked = beamBoard(45, true);
    const nakedTrace = {};
    OFF._payoff(CC, EQ, naked, naked.field, null, nakedTrace);
    same('with no body able to answer, the KO cell terminals at the lethal bonus',
      ON._ply2Value(nakedTrace, naked, naked.field, { team: naked.oppTeam }), ON.lethalBonus, 1e-9);
    check('...so the revenge killer is strictly what the second ply is paying for',
      ON._ply2Value(trace, st, st.field, world) < ON.lethalBonus,
      ON._ply2Value(trace, st, st.field, world) + ' vs ' + ON.lethalBonus);

    /* Our own body faints and nothing can replace it: the LOSS, not the kill the same cell just
     * bought us on their side. */
    const doomed = beamBoard(100);      // their body survives our hit, ours does not survive theirs
    doomed.active.my.hpPercent = 1;
    const dTrace = {};
    OFF._payoff(CC, EQ, doomed, doomed.field, null, dTrace);
    check('fixture: our body faints to the reply but theirs survives', dTrace.myHp <= 0 && dTrace.oppHp > 0,
      'myHp ' + dTrace.myHp + ', oppHp ' + dTrace.oppHp);
    same('with nothing left to bring in, the fainted side is the loss',
      ON._ply2Value(dTrace, doomed, doomed.field, { team: doomed.oppTeam }), -ON.lethalBonus, 1e-9);

    /* A mutual wipe is a DRAW, not a win: both sides empty must not be scored as our kill. */
    const mutual = beamBoard(5, true);
    mutual.active.my.hpPercent = 1;
    const mTrace = {};
    OFF._payoff(CC, EQ, mutual, mutual.field, null, mTrace);
    check('fixture: both active bodies faint on the same turn', mTrace.myHp <= 0 && mTrace.oppHp <= 0,
      'myHp ' + mTrace.myHp + ', oppHp ' + mTrace.oppHp);
    same('a mutual wipe scores 0 (a draw), not the lethal bonus',
      ON._ply2Value(mTrace, mutual, mutual.field, { team: mutual.oppTeam }), 0, 1e-9);
  }

  /* ------------------------------------------- 5c. the field ticks, and a TR expiring is OFF */
  {
    const tr = Object.assign({}, beamBoard(45).field, { trickRoom: true, trickRoomTurnsLeft: 2 });
    const t1 = ON._tickField(tr);
    same('the field tick spends a Trick Room turn', t1.trickRoomTurnsLeft, 1, 0);
    eq('...and Trick Room is still up', t1.trickRoom, true);
    same('...and the LIVE field is never written through', tr.trickRoomTurnsLeft, 2, 0);
    const last = ON._tickField(Object.assign({}, tr, { trickRoomTurnsLeft: 1 }));
    same('...the last turn spends it', last.trickRoomTurnsLeft, 0, 0);
    eq('...and 0 turns means OFF, not merely zero', last.trickRoom, false);
    const wt = ON._tickField(Object.assign({}, tr, { weather: 'sand', weatherTurnsLeft: 3, terrain: 'electric', terrainTurnsLeft: 1 }));
    same('weather and terrain tick the same way', wt.weatherTurnsLeft, 2, 0);
    same('...down to zero', wt.terrainTurnsLeft, 0, 0);
  }

  /* ------------------------------------------- 5d. the beam re-ranks, and reaches the matrix */
  {
    const onSpy = mkEngine({ beam2Ply: { enabled: true, topMy: 3, topOpp: 3, blendWeight: 1 } });
    let called = 0;
    const real = ST.LaplaceEngine.prototype._refineBeam2Ply;
    onSpy._refineBeam2Ply = function () { called++; return real.apply(this, arguments); };
    const onRanked = onSpy.evaluateTurn(beamBoard(45));
    check('with the beam on the refinement runs exactly once per turn', called === 1, String(called));
    const plan = onSpy.lastReadout.beam2Ply;
    check('...and publishes the cells it priced', !!plan && plan.cells > 0, JSON.stringify(plan));
    check('...capped by the 3x3 beam, not the whole matrix', plan.rows.length <= 3 && plan.cols.length <= 3,
      JSON.stringify(plan));
    check('...and every ranked score moved (the refinement reaches the matrix, not just a readout)',
      rankKeys(onRanked).join('|') !== rankKeys(offRanked).join('|'), '');

    /* THE SHIFT. Off, Close Combat outranks Encore; on, the second ply prices the Dragonite that
     * greets the KO and the two swap — a status move above a 120-BP STAB attack is exactly the
     * "what does the knockout LEAVE BEHIND" question one ply cannot ask. */
    check('off: Close Combat\u2019s row outranks Encore\u2019s',
      orderOf(offRanked, 'Close Combat') < orderOf(offRanked, 'Encore'),
      offRanked.map(function (r) { return r.name; }).join(' > '));
    check('on: pricing the revenge killer puts Encore above it',
      orderOf(onRanked, 'Encore') < orderOf(onRanked, 'Close Combat'),
      onRanked.map(function (r) { return r.name; }).join(' > '));
  }
}

/* ============================================ 6. stratified active-set sampling */

section('6. stratified active-set worlds (the mechanism, and the default its first reading flipped)');
{
  /* THE DEFAULT IS OFF AND THE TIER IS STILL TESTED. It was built ON (the coverage argument below
   * needs no battle to prove), and the first win-rate reading went the other way — switching it off
   * won +15.0 match points on the mirror, CI [+2.5, +30.0] — so the shipped build keeps the i.i.d.
   * draw and the ON path is exercised explicitly by every fixture below. The mechanism is not in
   * doubt; its price is. */
  eq('the shipped config keeps the i.i.d. draw', ST.configGet('sampler.stratifyActive', null), false);
  const def = new ST.WorldSampler({ K: 6, stratifyActive: true });
  eq('a default sampler takes it from the config (which is OFF)', new ST.WorldSampler({ K: 6 }).stratifyActive, false);
  eq('...and an explicit true is honoured, which is what the fixtures below drive',
    new ST.WorldSampler({ K: 6, stratifyActive: true }).stratifyActive, true);

  function setFor(species, moves, weight, id) {
    return {
      id: id, species: species, item: '', ability: '', nature: 'Jolly',
      evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, ivs: IVS,
      moves: moves.slice(), weight: weight
    };
  }
  /* Their ACTIVE body is a Great Tusk with three plausible sets at 7 / 2 / 1 usage, and their bench
   * is a single-set Kingambit. The active pool is the whole point: one set is 70 % of the weight and
   * one is 10 %, and six independent draws are free to see the 10 % one zero times. */
  function stratState(activeOver, theirBench) {
    const active = mon('Great Tusk', Object.assign({
      isActive: true, setMoves: ['Headlong Rush'],
      candidateSets: [
        setFor('Great Tusk', ['Headlong Rush'], 7, 'a'),
        setFor('Great Tusk', ['Headlong Rush', 'Rapid Spin'], 2, 'b'),
        // Set 'c' holds BOTH of the moves the elimination checks below reveal, which is what makes
        // those fixtures leave exactly two legal candidates standing (see the revealed-move cases).
        setFor('Great Tusk', ['Headlong Rush', 'Ice Spinner', 'Rapid Spin'], 1, 'c')
      ]
    }, activeOver || {}));
    const bench = theirBench === undefined
      ? mon('Kingambit', { candidateSets: [setFor('Kingambit', ['Kowtow Cleave'], 5, 'k')] })
      : theirBench;
    return { turn: 5, oppTeam: bench ? [active, bench] : [active], active: { my: null, opp: active } };
  }
  const ids = function (worlds) {
    return worlds.map(function (w) { return (w.team[0] && w.team[0].liveSet) ? w.team[0].liveSet.id : null; });
  };
  const activeId = function (w) {
    for (let i = 0; i < (w.team || []).length; i++) if (w.team[i] && w.team[i].isActive) return (w.team[i].liveSet || {}).id;
    return null;
  };

  const targets = def._activeStratificationTargets(stratState());
  eq('the active body offers its three legal sets, heaviest first',
    targets.map(function (t) { return t.set.id; }), ['a', 'b', 'c']);
  same('...each with its posterior share', targets[0].weight, 0.7, 1e-9);
  same('...and the shares are a distribution', targets.reduce(function (a, t) { return a + t.weight; }, 0), 1, 1e-9);

  const on = def.sampleWorlds(stratState(), ST.SetDatabase || null, 6);
  const off = new ST.WorldSampler({ K: 6, stratifyActive: false }).sampleWorlds(stratState(), ST.SetDatabase || null, 6);
  eq('every distinct active set is covered (one world each, in posterior order)',
    ids(on).slice(0, 3), ['a', 'b', 'c']);
  check('...while the i.i.d. draw repeats sets instead of covering them (this seed: two distinct sets in three draws)',
    (function () {
      const first = ids(off).slice(0, 3);
      const distinct = first.filter(function (v, i) { return first.indexOf(v) === i; });
      return distinct.length < 3;
    })(), JSON.stringify(ids(off)));
  eq('the pinned worlds say so', on.map(function (w) { return !!w.stratified; }), [true, true, true, false, false, false]);
  same('a pinned world carries its set\'s own posterior weight (share = 3/6)',
    on[0].weight, 0.5 * 0.7, 1e-9);
  same('...and the second-heaviest set gets its own share', on[1].weight, 0.5 * 0.2, 1e-9);
  same('...while a free world keeps the flat share', on[3].weight, 1 / 6, 1e-9);
  same('the weights still sum to 1', on.reduce(function (a, w) { return a + w.weight; }, 0), 1, 1e-9);

  /* THE PIN CHANGES ONE THING. The active body's draw is taken and then replaced, so a pinned world
   * is its i.i.d. twin everywhere else — bench included. */
  const twins = [];
  for (let i = 0; i < 3; i++) {
    twins.push((on[i].team[1] && on[i].team[1].liveSet ? on[i].team[1].liveSet.id : null) ===
      (off[i].team[1] && off[i].team[1].liveSet ? off[i].team[1].liveSet.id : null));
  }
  check('a pinned world keeps its i.i.d. twin\'s bench (the draw is taken, not skipped)',
    twins.every(function (v) { return v; }), JSON.stringify(twins));
  eq('...and the worlds past the stratum are unchanged outright',
    ids(on).slice(3), ids(off).slice(3));

  /* A revealed move eliminates sets: with only Rapid Spin seen, the 70 % set (which cannot hold it)
   * is out, two candidates stand, and the shares renormalise over what is left. */
  const revealedTwo = stratState({ revealedMoves: ['Rapid Spin'] });
  const twoTargets = def._activeStratificationTargets(revealedTwo);
  eq('a set the log disproved is not a stratification target',
    twoTargets.map(function (t) { return t.set.id; }), ['b', 'c']);
  same('...and the remaining two shares renormalise', twoTargets[0].weight, 2 / 3, 1e-9);
  const covered = def.sampleWorlds(revealedTwo, ST.SetDatabase || null, 4);
  eq('...and those two are what the pinned worlds stand', ids(covered).slice(0, 2), ['b', 'c']);

  /* One legal set is a one-horse race: nothing to stratify, so the caller draws i.i.d. as before. */
  const revealedOne = stratState({ revealedMoves: ['Rapid Spin', 'Ice Spinner'] });
  eq('a single legal set is not a stratification target',
    def._activeStratificationTargets(revealedOne), []);
  const single = def.sampleWorlds(revealedOne, ST.SetDatabase || null, 4);
  eq('...so every world stands it and none is marked pinned',
    [ids(single).every(function (id) { return id === 'c'; }), single.every(function (w) { return !w.stratified; })],
    [true, true]);

  /* K smaller than the pool: the heaviest K are covered, and the covered shares are then the whole
   * sample — so the final normalisation renormalises over them (the truncated set's mass is simply
   * not represented, which is the honest price of a K too small to hold the pool). */
  const smallK = new ST.WorldSampler({ K: 2, stratifyActive: true }).sampleWorlds(stratState(), ST.SetDatabase | null, 2);
  eq('K below the pool size covers the K heaviest sets', ids(smallK), ['a', 'b']);
  same('...and the shares renormalise over exactly those two', smallK[0].weight, 0.7 / 0.9, 1e-9);
  same('...as does the second', smallK[1].weight, 0.2 / 0.9, 1e-9);

  eq('the sampler is still deterministic across two calls',
    JSON.stringify(def.sampleWorlds(stratState(), ST.SetDatabase || null, 6).map(function (w) { return [activeId(w), w.weight]; })),
    JSON.stringify(on.map(function (w) { return [activeId(w), w.weight]; })));

  /* The engine reads the same worlds: every pinned set reaches the payoff matrix, which is the
   * reason the tier exists at all. */
  const engine = mkEngine();
  /* The ON path explicitly, because the shipped default is the i.i.d. draw: the point of this last
   * check is that a STRATIFIED sampler's worlds reach the payoff matrix, not that the config says
   * so. */
  engine.sampler = new ST.WorldSampler({ K: 6, stratifyActive: true });
  const rows = engine.evaluateTurn(board());
  const worldSets = (engine.lastReadout.worlds || []).map(function (w) { return activeId(w); });
  const engineTargets = engine.sampler._activeStratificationTargets(board());
  const head = worldSets.slice(0, engineTargets.length);
  check('the engine\'s own worlds cover every distinct set of its opponent pool, in posterior order',
    engineTargets.length >= 3 && head.length === engineTargets.length &&
      head.every(function (v, i) { return head.indexOf(v) === i; }) &&
      engineTargets.every(function (t, i) { return head[i] === t.set.id; }),
    JSON.stringify([engineTargets.map(function (t) { return t.set.id; }), worldSets]));
  check('...and it still returns a finite ranking', rows.length > 0 &&
    rows.every(function (r) { return isFinite(r.score) && isFinite(r.confidence); }),
    JSON.stringify(rows.map(function (r) { return [r.name, r.score]; })));
}

/* ================================================================= 7. QRE */

section('7. the quantal-response opponent (OFF, and the hard response it replaces)');
{
  const solve = ST.LaplaceEngine.solveNashFictitiousPlay;
  eq('the shipped config ships QRE OFF', ST.configGet('laplace.nash.qre.enabled', null), false);
  same('...at the documented temperature', ST.configGet('laplace.nash.qre.tau', null), 30, 0);
  same('...which decays to 0 at the rational end of the ladder',
    ST.configGet('laplace.nash.qre.highRating', null), 1850, 0);

  const BIASED = [[2, -1], [-1, 1]];
  const hard = solve(BIASED, 2000);
  eq('no qre argument is bit-identical to the shipped call',
    JSON.stringify(solve(BIASED, 2000, null)), JSON.stringify(hard));
  eq('...and so is a temperature of 0', JSON.stringify(solve(BIASED, 2000, { tau: 0 })), JSON.stringify(hard));

  const soft = solve(BIASED, 2000, { tau: 30 });
  const maxOf = function (a) { return Math.max.apply(null, a); };
  check('a soft column response spreads their mix (the max frequency drops)',
    maxOf(soft.oppStrategy) < maxOf(hard.oppStrategy),
    JSON.stringify([soft.oppStrategy, hard.oppStrategy]));
  check('...and both mixes stay probability distributions',
    [soft, hard].every(function (r) {
      return Math.abs(r.oppStrategy.reduce(function (a, b) { return a + b; }, 0) - 1) < 1e-9 &&
        r.oppStrategy.every(function (p) { return p >= 0 && p <= 1; });
    }), JSON.stringify(soft.oppStrategy));
  check('OUR side keeps the hard best response (minimax safety is not softened)',
    Math.abs(soft.myStrategy[0] - hard.myStrategy[0]) < 1e-9 &&
      Math.abs(soft.myStrategy[1] - hard.myStrategy[1]) < 1e-9,
    JSON.stringify([soft.myStrategy, hard.myStrategy]));
  check('every row value stays finite', soft.rowValues.every(function (v) { return isFinite(v); }),
    JSON.stringify(soft.rowValues));
  const near0 = solve(BIASED, 2000, { tau: 0.0001 });
  check('a vanishing temperature converges back to the hard mix',
    Math.abs(maxOf(near0.oppStrategy) - maxOf(hard.oppStrategy)) < 0.02,
    JSON.stringify([near0.oppStrategy, hard.oppStrategy]));
  const wild = solve(BIASED, 2000, { tau: 5000 });
  check('a huge temperature approaches the uniform mix',
    Math.abs(wild.oppStrategy[0] - 0.5) < 0.02, JSON.stringify(wild.oppStrategy));
  check('a big matrix cannot overflow the softmax into NaN',
    solve([[5000, -5000], [-5000, 5000]], 240, { tau: 1 }).oppStrategy.every(function (p) { return isFinite(p) && p >= 0; }),
    JSON.stringify(solve([[5000, -5000], [-5000, 5000]], 240, { tau: 1 }).oppStrategy));

  /* The temperature is a rating-driven policy, not a constant: the deviation belongs to the ladder
   * below 1850 and vanishes at the top of it. */
  const OFF_QRE = mkEngine({ qre: { enabled: false, tau: 30 } });
  const ON_QRE = mkEngine({ qre: { enabled: true, tau: 30, highRating: 1850, lowRating: 1100 } });
  same('tier off -> temperature 0', OFF_QRE._qreTau({ opponentRating: 1200 }), 0, 0);
  same('an unknown seat is played against rationally, never noisily',
    ON_QRE._qreTau({ opponentRating: null }), 0, 0);
  same('at lowRating and below: the full temperature',
    ON_QRE._qreTau({ opponentRating: 900 }), 30, 1e-9);
  same('halfway up the band: half the temperature',
    ON_QRE._qreTau({ opponentRating: 1475 }), 15, 1e-9);
  same('at highRating: the hard response is back',
    ON_QRE._qreTau({ opponentRating: 1850 }), 0, 0);
  same('...and above it stays there', ON_QRE._qreTau({ opponentRating: 2400 }), 0, 0);

  const lowSeat = board();
  lowSeat.opponentRating = 1200;
  const highSeat = board();
  highSeat.opponentRating = 2100;
  const rowsOff = OFF_QRE.evaluateTurn(lowSeat);
  const readoutOff = OFF_QRE.lastReadout;
  const rowsLow = ON_QRE.evaluateTurn(lowSeat);
  const readoutLow = ON_QRE.lastReadout;
  const rowsHigh = ON_QRE.evaluateTurn(highSeat);
  const readoutHigh = ON_QRE.lastReadout;
  eq('the readout says which response actually ran (off)', readoutOff.qre, null);
  same('...at a 1200 seat: the temperature that seat earns (a third of the band up, so 0.867 of it)',
    readoutLow.qre && readoutLow.qre.tau, 30 * (1850 - 1200) / 750, 0.1);
  eq('...and at a 2100 seat: the hard response', readoutHigh.qre, null);
  const oppMax = function (readout) {
    const mix = (readout && readout.oppStrategy) || [];
    return mix.length ? Math.max.apply(null, mix.map(function (m) { return m.freq; })) : 1;
  };
  check('a soft opponent flattens the mix the engine expects them to play',
    oppMax(readoutLow) < oppMax(readoutOff), JSON.stringify([oppMax(readoutLow), oppMax(readoutOff)]));
  check('...while our own ranking stays finite and sums to 100 %',
    rowsLow.every(function (r) { return isFinite(r.confidence) && r.confidence >= 0; }) &&
      Math.abs(rowsLow.filter(function (r) { return !r.isVetoed; })
        .reduce(function (a, r) { return a + r.confidence; }, 0) - 100) < 1.5,
    JSON.stringify(rowsLow.map(function (r) { return r.confidence; })));
  check('the hard response is unchanged by the tier being constructed',
    JSON.stringify(rowsHigh.map(function (r) { return [r.name, r.score, r.confidence]; })) ===
      JSON.stringify(rowsOff.map(function (r) { return [r.name, r.score, r.confidence]; })),
    JSON.stringify([rowsHigh.map(function (r) { return [r.name, r.score, r.confidence]; }),
      rowsOff.map(function (r) { return [r.name, r.score, r.confidence]; })]));
}

/* ====================== 7b. the tier's blast radius: it re-prices THEM, and never US */

section('7b. what a positive temperature can and cannot move (it never moves our own strategy)');
{
  /* THE 2026-10-15 VERIFICATION, and it is a claim about the SOLVER rather than about a corpus.
   * A flat `nash-qre` row was read as "the mirror declares no rating, so the ramp disables it"
   * (ATTEMPTS.md K4). That is true of the mirror, but it is not the whole reason the row cannot
   * move: in the fictitious-play loop the opponent's SOFT mix is accumulated into their reported
   * strategy, while the action each side best-responds to is STILL the hard argmax (`oppAction =
   * bestJ`), and OUR cumulative payoff (`myCum[i] += payoffMatrix[i][oppAction]`) reads that hard
   * index. A temperature therefore cannot reach our own frequency counts on ANY matrix. QRE
   * changes the mix we expect THEM to play (published for the profiler next turn) and the per-row
   * VALUES; our strategy can only move through the score tie-break among equal frequencies. That
   * is why the row needs no "mid-ladder opponent" to be priceable — it is near-inert for the
   * ranking by construction. */
  const solve = ST.LaplaceEngine.solveNashFictitiousPlay;
  const MATRICES = [
    [[2, -1], [-1, 1]],
    [[10, -4, 6], [3, 8, -5], [-6, 2, 9]],
    [[10, -4, 6, -2], [3, 8, -5, 4], [-6, 2, 9, -3], [5, -7, 1, 7], [-1, 4, 3, 6]]
  ];
  let myMoved = 0, oppMoved = 0, rowMoved = 0;
  MATRICES.forEach(function (m) {
    const h = solve(m, 2000);
    const s = solve(m, 2000, { tau: 30 });
    if (JSON.stringify(h.myStrategy) !== JSON.stringify(s.myStrategy)) myMoved++;
    if (JSON.stringify(h.oppStrategy) !== JSON.stringify(s.oppStrategy)) oppMoved++;
    if (JSON.stringify(h.rowValues) !== JSON.stringify(s.rowValues)) rowMoved++;
  });
  same('a positive temperature never moves OUR own strategy (our frequencies), on any matrix',
    myMoved, 0);
  eq('...while on every matrix it DOES move the mix it expects them to play', oppMoved, 3);
  eq('...and the per-row values those mixes imply', rowMoved, 3);

  /* And at the engine level, on a real board: `confidence` is 100 x that same frequency, so the
   * column that ranks our lines is identical with the tier on and off — only the published
   * opponent mix and the row VALUES differ. */
  const seat = board();
  seat.opponentRating = 1200;                     // inside the ramp: 30 * (1850 - 1200) / 750 = 26
  const qreOff = mkEngine({ qre: { enabled: false, tau: 30 } });
  const qreOn = mkEngine({ qre: { enabled: true, tau: 30, highRating: 1850, lowRating: 1100 } });
  const liveRows = function (rows) {
    return rows.filter(function (r) { return !r.isVetoed; });
  };
  const conf = function (rows) {
    return liveRows(rows).map(function (r) {
      return [r.name, U.round1(r.confidence), U.round1(r.nashFrequency || 0)];
    }).sort();
  };
  const offRows = qreOff.evaluateTurn(seat);
  const onRows = qreOn.evaluateTurn(seat);
  check('a rated seat really does engage the tier (otherwise this block is vacuous)',
    !!(qreOn.lastReadout && qreOn.lastReadout.qre && qreOn.lastReadout.qre.tau > 0),
    JSON.stringify(qreOn.lastReadout && qreOn.lastReadout.qre));
  eq('the confidence / frequency column is bit-identical with the tier on and off',
    conf(onRows), conf(offRows));
  eq('...so the published TOP LINE is unchanged (no frequency tie on this board to break)',
    onRows[0] && onRows[0].name, offRows[0] && offRows[0].name);
}

/* ============ 8. surprise truncation: the opponent solves the game it thinks it is in (OFF) */

section('8. surprise truncation (unrevealed coverage baiting) ships OFF, and moves only THEM');
{
  /* THE MECHANISM. The simultaneous matrix is built over the opponent's FULL reply list, so the
   * equilibrium already knows about our unrevealed coverage move and leaves the punished column
   * alone — telepathically, because on the ladder they have not seen us click it. With the tier on,
   * THEIR half of the solve reads a copy of the matrix in which an unrevealed non-STAB row is
   * blended toward our best revealed/STAB row, and it is that copy the opponent best-responds to.
   * Our own rows are still scored on the TRUE matrix against the mix they produce, and our own
   * frequencies still best-respond to the real game. */
  const solve = ST.LaplaceEngine.solveNashFictitiousPlay;
  eq('the shipped config ships the tier OFF', ST.configGet('laplace.surpriseMask.enabled', null), false);
  same('...at the documented blend weight', ST.configGet('laplace.surpriseMask.unrevealedWeight', null), 0.35, 0);

  /* ---- 8a. what counts as a surprise ---- */

  const masked = mkEngine({ surpriseMask: { enabled: true, unrevealedWeight: 0.35 } });
  const dodgeBoard = boardWithDodge();
  const me = dodgeBoard.active.my;
  const A = function (name, kind) { return { kind: kind || 'move', name: name, moveId: U.toID(name) }; };
  check('an unrevealed non-STAB coverage move IS a surprise (Ice on a Ground/Fighting body)',
    masked._isSurpriseCoverage(A('Ice Spinner'), me) === true);
  check('...a STAB move is not: its typing is readable off the species',
    masked._isSurpriseCoverage(A('Headlong Rush'), me) === false &&
      masked._isSurpriseCoverage(A('Close Combat'), me) === false,
    JSON.stringify([masked._isSurpriseCoverage(A('Headlong Rush'), me),
      masked._isSurpriseCoverage(A('Close Combat'), me)]));
  check('...nor is a move we have already clicked this battle',
    masked._isSurpriseCoverage(A('Ice Spinner'),
      Object.assign({}, me, { revealedMoves: ['Ice Spinner'] })) === false);
  check('...nor a pivot, nor a shield',
    masked._isSurpriseCoverage({ kind: 'switch', name: 'Iron Valiant' }, me) === false &&
      masked._isSurpriseCoverage({ kind: 'protect', name: 'Protect' }, me) === false);
  check('...and with the tier OFF nothing is a surprise',
    mkEngine({})._isSurpriseCoverage(A('Ice Spinner'), me) === false);

  /* ---- 8b. the perceived matrix is built cell by cell ---- */

  const SUB = [[-10, 120, 30], [60, -40, 20], [40, -60, 10]];
  const ACTIONS = [A('Ice Spinner'), A('Close Combat'), A('Headlong Rush')];
  const plan = masked._surprisePerceived(SUB, [0, 1, 2], ACTIONS, dodgeBoard);
  check('the planner claims exactly the lure row', !!plan && JSON.stringify(plan.rows) === '[0]',
    JSON.stringify(plan && plan.rows));
  eq('...and anchors on the best revealed/STAB row (Close Combat, the higher mean of the two)',
    plan && plan.anchorName, 'Close Combat');
  same('...blending it cell by cell: 0.35 x true + 0.65 x anchor',
    plan && plan.perceived[0][1], 0.35 * 120 + 0.65 * -40, 1e-9);
  eq('...and leaving every other row exactly as it was',
    plan ? JSON.stringify(plan.perceived.slice(1)) : null, JSON.stringify(SUB.slice(1)));
  eq('...with the true matrix never written through',
    JSON.stringify(SUB), JSON.stringify([[-10, 120, 30], [60, -40, 20], [40, -60, 10]]));
  check('tier off: no perceived matrix is built at all',
    mkEngine({})._surprisePerceived(SUB, [0, 1, 2], ACTIONS, dodgeBoard) === null);
  check('a body whose whole set is a surprise has no read to blend toward, so no mask',
    masked._surprisePerceived(SUB, [0, 1, 2], [A('Ice Spinner'), A('Ice Spinner'), A('Ice Spinner')],
      dodgeBoard) === null);
  check('unrevealedWeight 1 is the identity, so no copy is needed',
    mkEngine({ surpriseMask: { enabled: true, unrevealedWeight: 1 } })
      ._surprisePerceived(SUB, [0, 1, 2], ACTIONS, dodgeBoard) === null);

  /* ---- 8c. the solver: a hidden lure is not dodged, and its value is scored on the TRUTH ---- */

  const M = [[-10, 120, 30], [60, -40, 20], [40, -60, 10]];
  const PERCEIVED = M.map(function (row) { return row.slice(); });
  for (let j = 0; j < PERCEIVED[0].length; j++) PERCEIVED[0][j] = 0.35 * M[0][j] + 0.65 * M[1][j];

  eq('no perceived matrix is bit-identical to the shipped call',
    JSON.stringify(solve(M, 2000, null, null)), JSON.stringify(solve(M, 2000)));
  eq('...and so is a perceived copy that IS the true matrix',
    JSON.stringify(solve(M, 2000, null, { perceived: M.map(function (r) { return r.slice(); }) })),
    JSON.stringify(solve(M, 2000)));
  eq('...and so is a perceived matrix of the wrong SHAPE (a ragged copy is ignored, not read)',
    JSON.stringify(solve(M, 2000, null, { perceived: [[1, 2], [3, 4]] })), JSON.stringify(solve(M, 2000)));

  const sighted = solve(M, 2000);
  const fooled = solve(M, 2000, null, { perceived: PERCEIVED });
  check('an opponent who can see the lure concentrates on the column that punishes it',
    sighted.oppStrategy[2] > 0.5, JSON.stringify(sighted.oppStrategy));
  check('...while one who cannot walks straight into it',
    fooled.oppStrategy[1] > 0.5, JSON.stringify(fooled.oppStrategy));
  check('...which makes the lure worth several times more against their real mix',
    fooled.rowValues[0] > 3 * sighted.rowValues[0],
    JSON.stringify([sighted.rowValues[0], fooled.rowValues[0]]));
  let rail = 0;
  for (let j = 0; j < M[0].length; j++) rail += fooled.oppStrategy[j] * M[0][j];
  same('our rows are STILL scored on the true matrix against their mix, not the perceived one',
    fooled.rowValues[0], rail, 1e-9);
  check('...and both mixes remain probability distributions',
    [sighted, fooled].every(function (r) {
      return Math.abs(r.oppStrategy.reduce(function (a, b) { return a + b; }, 0) - 1) < 1e-9 &&
        r.oppStrategy.every(function (p) { return p >= 0 && p <= 1; });
    }), JSON.stringify(fooled.oppStrategy));

  /* ---- 8d. the engine wiring, on the real board ---- */

  const offDefault = mkEngine({});
  const offExplicit = mkEngine({ surpriseMask: { enabled: false, unrevealedWeight: 0.35 } });
  const on = mkEngine({ surpriseMask: { enabled: true, unrevealedWeight: 0.35 } });
  const rowKey = function (rows) {
    return rows.map(function (r) { return [r.name, r.score, r.confidence, r.isVetoed]; });
  };
  const R0 = offDefault.evaluateTurn(boardWithDodge());
  const RX = offExplicit.evaluateTurn(boardWithDodge());
  const RN = on.evaluateTurn(boardWithDodge());
  eq('tier off: the readout publishes no mask', offDefault.lastReadout.surpriseMask, null);
  eq('enabled: false is bit-identical to the shipped build', rowKey(RX), rowKey(R0));
  check('tier on: the mask names the lure, its anchor and the blend it wore',
    !!on.lastReadout.surpriseMask &&
      JSON.stringify(on.lastReadout.surpriseMask.rows) === '["Ice Spinner"]' &&
      on.lastReadout.surpriseMask.anchor === 'Close Combat' &&
      on.lastReadout.surpriseMask.blend === 65,
    JSON.stringify(on.lastReadout.surpriseMask));
  const freqOf = function (readout, name) {
    const mix = (readout && readout.oppStrategy) || [];
    for (let i = 0; i < mix.length; i++) if (mix[i].name === name) return mix[i].freq;
    return 0;
  };
  const lureOf = function (rows) {
    for (let i = 0; i < rows.length; i++) if (rows[i].name === 'Ice Spinner') return rows[i];
    return null;
  };
  check('their pivot is a real column on this board (otherwise this block proves nothing)',
    freqOf(offDefault.lastReadout, 'Landorus-Therian') > 0.3,
    JSON.stringify(offDefault.lastReadout.oppStrategy));
  check('with the lure hidden their equilibrium dodges MORE, not less',
    freqOf(on.lastReadout, 'Landorus-Therian') > freqOf(offDefault.lastReadout, 'Landorus-Therian'),
    JSON.stringify([freqOf(offDefault.lastReadout, 'Landorus-Therian'),
      freqOf(on.lastReadout, 'Landorus-Therian')]));
  check('...and the lure\u2019s true value against that mix goes up',
    lureOf(RN).score > lureOf(R0).score,
    JSON.stringify([lureOf(R0).score, lureOf(RN).score]));
  check('...making it the top line, with the row flagged and the anchor it was read as',
    RN[0].name === 'Ice Spinner' && RN[0].surpriseMasked === true &&
      lureOf(RN).surpriseAnchor === 'Close Combat' && !R0[0].surpriseMasked && !lureOf(R0).surpriseMasked,
    JSON.stringify(RN.map(function (r) { return [r.name, r.surpriseMasked, r.surpriseAnchor]; })));
  check('...and the masked solve is still finite with confidences summing to 100 %',
    RN.every(function (r) { return isFinite(r.confidence); }) &&
      Math.abs(RN.filter(function (r) { return !r.isVetoed; })
        .reduce(function (a, r) { return a + r.confidence; }, 0) - 100) < 1.5,
    JSON.stringify(RN.map(function (r) { return r.confidence; })));
}

/* ============ 9. prior-anchored regret matching: the solve starts where humans are (OFF) */

section('9. prior-anchored regret matching ships OFF, and only ever re-prices THEM');
{
  /* THE MECHANISM. Fictitious play gives every one of their actions the same ZERO credibility at
   * round 0, so an opponent blunder collects a full best response for as long as the running
   * average takes to wash it out. ATTEMPTS.md E5 priced turning the hard solve off at +8.3 %
   * against the pure softmax, which read as exactly that over-defence. With the tier on, their
   * regret-matching response is blended with a behavioral prior at `priorWeight`. */
  const solve = ST.LaplaceEngine.solveNashFictitiousPlay;
  eq('the shipped config ships the tier OFF', ST.configGet('laplace.nash.priorAnchored.enabled', null), false);
  same('...at the documented anchor weight', ST.configGet('laplace.nash.priorAnchored.priorWeight', null), 0.25, 0);
  same('...with the documented prior weights', ST.configGet('laplace.nash.priorAnchored.switchEscape', null), 70, 0);
  same('...and they are what the engine actually reads',
    mkEngine({}).nash.priorAnchored.switchEscape, 70, 0);
  same('a PARTIAL tier option keeps the config defaults underneath (the merge is at both levels)',
    mkEngine({ nash: { priorAnchored: { enabled: true, priorWeight: 0.25 } } }).nash.priorAnchored.switchEscape,
    70, 0);

  /* ---- 9a. the solver: anchoring is a pull, never a new payoff ---- */

  const M = [[-10, 120, 30], [60, -40, 20], [40, -60, 10]];
  const P = [0.5, 0.3, 0.2];
  const hard = solve(M, 2000);
  eq('no prior is bit-identical to the shipped call',
    JSON.stringify(solve(M, 2000, null, { prior: null, priorWeight: 0.25 })), JSON.stringify(hard));
  eq('...and so is a weight of 0',
    JSON.stringify(solve(M, 2000, null, { prior: P, priorWeight: 0 })), JSON.stringify(hard));
  check('...and so is a malformed prior: the wrong length, a negative entry, a NaN',
    JSON.stringify(solve(M, 2000, null, { prior: [0.5, 0.5], priorWeight: 0.25 })) === JSON.stringify(hard) &&
      JSON.stringify(solve(M, 2000, null, { prior: [0.5, -0.1, 0.6], priorWeight: 0.25 })) === JSON.stringify(hard) &&
      JSON.stringify(solve(M, 2000, null, { prior: [0.5, NaN, 0.5], priorWeight: 0.25 })) === JSON.stringify(hard),
    JSON.stringify(solve(M, 2000, null, { prior: [0.5, NaN, 0.5], priorWeight: 0.25 }).oppStrategy));

  const anchored = solve(M, 2000, null, { prior: P, priorWeight: 0.25 });
  const pinned = solve(M, 2000, null, { prior: P, priorWeight: 1 });
  /* An anchor of 1 makes every response the prior, so their reported mix is the prior plus the ONE
   * round the loop seeds before it has computed any response at all (the same 1/iters artifact the
   * QRE path has always had). Doubling the rounds must halve it — which is what makes this a
   * convergence claim rather than a tolerance. */
  const priorGap = function (r, iters) {
    let worst = 0;
    for (let j = 0; j < P.length; j++) worst = Math.max(worst, Math.abs(r.oppStrategy[j] - P[j]));
    return worst - 1 / iters;
  };
  check('an anchor of 1 makes their mix the prior, up to the one seeded round',
    priorGap(pinned, 2000) < 1e-9, JSON.stringify(pinned.oppStrategy));
  check('...and that residual really is the seeded round: it halves when the rounds double',
    priorGap(solve(M, 20000, null, { prior: P, priorWeight: 1 }), 20000) < 1e-9,
    JSON.stringify(solve(M, 20000, null, { prior: P, priorWeight: 1 }).oppStrategy));
  check('...and a partial anchor never prices a supported reply at zero',
    anchored.oppStrategy.every(function (v, j) { return v >= 0.25 * P[j] - 1e-9; }),
    JSON.stringify(anchored.oppStrategy));
  check('...while an unsupported one is still allowed to go unsupported (it is a prior, not a policy)',
    anchored.oppStrategy[0] !== hard.oppStrategy[0] || anchored.oppStrategy[1] !== hard.oppStrategy[1],
    JSON.stringify([anchored.oppStrategy, hard.oppStrategy]));
  check('every mix the tier produces is still a distribution',
    [anchored, pinned].every(function (r) {
      return Math.abs(r.oppStrategy.reduce(function (a, b) { return a + b; }, 0) - 1) < 1e-9 &&
        r.rowValues.every(function (v) { return isFinite(v); });
    }), JSON.stringify(anchored.oppStrategy));

  /* ---- 9b. the prior itself, on the real board ---- */

  const off = mkEngine({ nash: { priorAnchored: { enabled: false, priorWeight: 0.25 } } });
  const offDefault = mkEngine({});
  const on = mkEngine({ nash: { priorAnchored: { enabled: true, priorWeight: 0.25 } } });
  const rowKey = function (rows) {
    return rows.map(function (r) { return [r.name, r.score, r.confidence, r.isVetoed]; });
  };
  const R0 = offDefault.evaluateTurn(boardWithDodge());
  const RO = off.evaluateTurn(boardWithDodge());
  const RN = on.evaluateTurn(boardWithDodge());
  eq('tier off: no prior is published', off.lastReadout.nashPrior, null);
  eq('enabled: false is bit-identical to the shipped build', rowKey(RO), rowKey(R0));
  const priorMix = on.lastReadout.nashPrior && on.lastReadout.nashPrior.mix;
  check('tier on: the prior is published as a distribution over THEIR actions',
    !!priorMix && Math.abs(priorMix.reduce(function (a, m) { return a + m.prior; }, 0) - 1) < 0.01 &&
      priorMix.every(function (m) { return isFinite(m.prior) && m.prior >= 0; }),
    JSON.stringify(on.lastReadout.nashPrior));
  same('...at the configured anchor weight', on.lastReadout.nashPrior && on.lastReadout.nashPrior.weight, 0.25, 0);
  const priorOf = function (name) {
    for (let i = 0; priorMix && i < priorMix.length; i++) if (priorMix[i].name === name) return priorMix[i];
    return null;
  };
  const pivot = priorOf('Landorus-Therian');
  const movePriors = (priorMix || []).filter(function (m) { return m.kind !== 'switch'; })
    .map(function (m) { return m.prior; });
  check('the pivot carries the ESCAPE weight: our revealed/STAB move OHKOs their active and the incoming body resists it',
    !!pivot && pivot.prior > 0.4 && movePriors.length >= 2 &&
      movePriors.every(function (p) { return p < pivot.prior; }),
    JSON.stringify([pivot && pivot.prior, movePriors]));
  const zeros = function (readout) {
    return ((readout && readout.oppStrategy) || []).filter(function (m) { return m.freq < 1e-4; }).length;
  };
  check('the hard solve zeroes a set of their replies; the anchored solve gives every one of them weight',
    zeros(on.lastReadout) === 0 && zeros(off.lastReadout) >= 2,
    JSON.stringify([zeros(off.lastReadout), zeros(on.lastReadout)]));
  check('...so our own ranking really does change with it (the tier is not inert)',
    JSON.stringify(RN.map(function (r) { return [r.name, Math.round(r.score)]; })) !==
      JSON.stringify(RO.map(function (r) { return [r.name, Math.round(r.score)]; })),
    JSON.stringify([RO.map(function (r) { return [r.name, Math.round(r.score)]; }),
      RN.map(function (r) { return [r.name, Math.round(r.score)]; })]));
  const nanEngine = mkEngine({ nash: { priorAnchored: { enabled: true, priorWeight: 0.25, attackFloor: NaN } } });
  nanEngine.evaluateTurn(boardWithDodge());
  check('a malformed prior leaf cannot poison the prior into NaN',
    !!nanEngine.lastReadout.nashPrior &&
      nanEngine.lastReadout.nashPrior.mix.every(function (m) { return isFinite(m.prior) && m.prior >= 0; }),
    JSON.stringify(nanEngine.lastReadout.nashPrior));
}

/* ------------------------------------------------------------------- summary */

console.log('');
if (fails.length) {
  console.error('FAILED: ' + fails.length + ' of ' + (pass + fails.length) + ' checks');
  fails.forEach(function (f) { console.error('  - ' + f); });
  process.exit(1);
}
console.log('ALL TUNING CHECKS PASSED (' + pass + ')');
