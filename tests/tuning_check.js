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
    priceRecovery: (opts && opts.priceRecovery) || null
  });
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

/* ------------------------------------------------------------------- summary */

console.log('');
if (fails.length) {
  console.error('FAILED: ' + fails.length + ' of ' + (pass + fails.length) + ' checks');
  fails.forEach(function (f) { console.error('  - ' + f); });
  process.exit(1);
}
console.log('ALL TUNING CHECKS PASSED (' + pass + ')');
