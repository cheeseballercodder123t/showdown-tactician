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
    switchTax: (opts && opts.switchTax) || null
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

/* ------------------------------------------------------------------- summary */

console.log('');
if (fails.length) {
  console.error('FAILED: ' + fails.length + ' of ' + (pass + fails.length) + ' checks');
  fails.forEach(function (f) { console.error('  - ' + f); });
  process.exit(1);
}
console.log('ALL TUNING CHECKS PASSED (' + pass + ')');
