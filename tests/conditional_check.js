/* Showdown Tactician — tests/conditional_check.js
 *
 * WHY THIS EXISTS
 *   `_payoff` used to price a move's damage as a property of the move. Two entire families of
 *   moves do not work that way, and the matrix recommended lines the game answers with |-fail|:
 *
 *     - Sucker Punch only connects when the target selected an ATTACKING move. Priced into a
 *       predicted switch it credited its hit to the incoming body — the exact line that deals
 *       nothing — and it did the same into a setup move, a status move or a Protect.
 *     - Fake Out (and First Impression) fail unless the user has not yet acted since it entered
 *       the field, so every turn after the first was over-priced; and a landed Fake Out FLINCHES,
 *       which takes the opponent's whole click away — a fact nothing in src/ modelled before
 *       (`flinch` appeared nowhere in the tree).
 *
 *   `laplace.conditionalMoves` prices all three, from GAME RULES only, and applies them to BOTH
 *   sides of the matrix (their Sucker Punch and their Fake Out are reply columns in the same cell).
 *   This suite pins: the classifiers, the two independent readings of "first turn out", the exact
 *   identity when the tier is off, each sub-knob on its own, the flinch blockers, and purity.
 *
 * Run me with:  node tests/conditional_check.js
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
function same(name, got, want, tol) {
  const limit = tol === undefined ? 1e-9 : tol;
  const ok = typeof got === 'number' && typeof want === 'number' && Math.abs(got - want) <= limit;
  return check(name, ok, 'got ' + got + ', want ' + want);
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }

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

function mkEngine(cm) {
  const damage = new ST.DamageEngine({ gen: 9 });
  const trickRoom = new ST.TrickRoomEngine(damage);
  return new ST.LaplaceEngine({
    sampler: new ST.WorldSampler({ K: 6 }), damage: damage,
    evaluator: new ST.DenseStateEvaluator(),
    tempo: new ST.TempoEngine({ damage: damage, trickRoom: trickRoom }),
    veto: new ST.BlunderVetoGuard({ damage: damage, trickRoom: trickRoom }), trickRoom: trickRoom,
    conditionalMoves: cm || null
  });
}
const SHIPPED = mkEngine();                                    // whatever config.js ships
const ON = mkEngine({ enabled: true });                        // every rule on
const OFF = mkEngine({ enabled: false });                      // the pre-tier pricing
const NO_FLINCH = mkEngine({ enabled: true, flinch: false });
const NO_FIRSTTURN = mkEngine({ enabled: true, firstTurnOnly: false });
const NO_SUCKER = mkEngine({ enabled: true, suckerPunchRequiresAttack: false });

const MY_MOVES = ['Fake Out', 'Sucker Punch', 'Double-Edge', 'Earthquake'];
const THEIR_MOVES = ['Dragon Dance', 'Extreme Speed', 'Protect', 'Roost'];

/**
 * Kangaskhan (Sucker Punch / Fake Out) against Dragapult (a Dark-weak body, so Sucker Punch has a
 * real number to credit), with a Gliscor on their bench — the user's own example — and entry rocks
 * up on their side so the switch-in body lands at a NON-100 HP and the "was it hit?" reading is not
 * vacuous.
 */
function board(opts) {
  opts = opts || {};
  const me = mon('Kangaskhan', Object.assign({
    side: 'p1', evs: OFFENSE, ivs: IVS, nature: 'Adamant', ability: 'Scrappy',
    isActive: true, hpPercent: 100, setMoves: MY_MOVES.slice(),
    lastMoveTurn: 0, switchedInTurn: null
  }, opts.myExtra || {}));
  const them = mon('Dragapult', Object.assign({
    evs: OFFENSE, ivs: IVS, nature: 'Jolly', ability: 'Clear Body',
    isActive: true, hpPercent: 100, setMoves: THEIR_MOVES.slice(),
    lastMoveTurn: 0, switchedInTurn: null
  }, opts.oppExtra || {}));
  const gliscor = mon('Gliscor', {
    evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 }, ivs: IVS, nature: 'Impish',
    ability: 'Poison Heal', isActive: false, hpPercent: 100,
    setMoves: ['Earthquake', 'Toxic', 'Roost', 'Protect'], lastMoveTurn: 0, switchedInTurn: null
  });
  const benchMine = mon('Slowking-Galar', {
    side: 'p1', evs: { hp: 252, atk: 0, def: 0, spa: 4, spd: 252, spe: 0 }, ivs: IVS,
    nature: 'Sassy', ability: 'Regenerator', isActive: false, hpPercent: 100,
    setMoves: ['Future Sight', 'Scald', 'Sludge Bomb', 'Flamethrower'],
    lastMoveTurn: 0, switchedInTurn: null
  });
  return {
    turn: opts.turn === undefined ? 1 : opts.turn,
    mySide: 'p1', oppSide: 'p2', formatSupported: true,
    myTeam: [me, benchMine], oppTeam: [them, gliscor],
    active: { my: me, opp: them }, bench: { my: [], opp: [] },
    protect: {
      oppTurnsSinceLastProtect: 3, oppConsecutiveProtects: 0,
      myTurnsSinceLastProtect: 4, myConsecutiveProtects: 0,
      oppLastProtectTurn: -99, myLastProtectTurn: -99, oppProtectedLastTurn: false
    },
    recoveryPP: {},
    field: {
      turn: opts.turn === undefined ? 1 : opts.turn, trickRoom: false, weather: '', terrain: '',
      hazards: { p1: {}, p2: { rocks: true } }, screens: {}, tailwind: {}, gravity: false
    }
  };
}

const FAKE_OUT = { kind: 'move', name: 'Fake Out', moveId: 'fakeout' };
const SUCKER = { kind: 'move', name: 'Sucker Punch', moveId: 'suckerpunch' };
const DOUBLE_EDGE = { kind: 'move', name: 'Double-Edge', moveId: 'doubleedge' };
const DRAGON_DANCE = { kind: 'move', name: 'Dragon Dance', moveId: 'dragondance' };
const EXTREME_SPEED = { kind: 'move', name: 'Extreme Speed', moveId: 'extremespeed' };
const PROTECT = { kind: 'protect', name: 'Protect', moveId: 'protect' };
const SWITCH_GLISCOR = { kind: 'switch', name: 'Gliscor', targetId: 'gliscor' };
const SWITCH_SLOWKING = { kind: 'switch', name: 'Slowking-Galar', targetId: 'slowkinggalar' };

function cell(engine, myAction, oppAction, st) {
  const trace = {};
  const score = engine._payoff(myAction, oppAction, st, st.field, null, trace);
  return { score: score, trace: trace };
}

/* =========================================================== 1. the wiring */

section('1. the config section, and what the classifiers claim');

const ccfg = ST.CONFIG && ST.CONFIG.laplace && ST.CONFIG.laplace.conditionalMoves;
check('config.js carries the conditional-move switches',
  !!ccfg && typeof ccfg.enabled === 'boolean' &&
  typeof ccfg.suckerPunchRequiresAttack === 'boolean' &&
  typeof ccfg.firstTurnOnly === 'boolean' && typeof ccfg.flinch === 'boolean',
  JSON.stringify(ccfg));
check('the extension SHIPS all three rules ON (they are game rules, not policy tiers)',
  ccfg && ccfg.enabled === true && ccfg.suckerPunchRequiresAttack === true &&
  ccfg.firstTurnOnly === true && ccfg.flinch === true, JSON.stringify(ccfg));
check('an engine with no override mirrors the config',
  SHIPPED.conditionalMoves.enabled === ccfg.enabled &&
  SHIPPED.conditionalMoves.suckerPunchRequiresAttack === ccfg.suckerPunchRequiresAttack &&
  SHIPPED.conditionalMoves.firstTurnOnly === ccfg.firstTurnOnly &&
  SHIPPED.conditionalMoves.flinch === ccfg.flinch, JSON.stringify(SHIPPED.conditionalMoves));
check('the documented literal fallbacks match the shipped config',
  ON.conditionalMoves.enabled === true && ON.conditionalMoves.suckerPunchRequiresAttack === true &&
  ON.conditionalMoves.firstTurnOnly === true && ON.conditionalMoves.flinch === true,
  JSON.stringify(ON.conditionalMoves));
check('an explicit override beats the config on every leaf',
  OFF.conditionalMoves.enabled === false && NO_FLINCH.conditionalMoves.flinch === false &&
  NO_FIRSTTURN.conditionalMoves.firstTurnOnly === false &&
  NO_SUCKER.conditionalMoves.suckerPunchRequiresAttack === false, '');

check('Sucker Punch is the one move that requires an attacking click',
  U.requiresTargetAttack('Sucker Punch') === true && U.requiresTargetAttack('suckerpunch') === true &&
  U.requiresTargetAttack('Fake Out') === false && U.requiresTargetAttack('Double-Edge') === false,
  String(U.requiresTargetAttack('Sucker Punch')));
check('Fake Out and First Impression are the first-turn-out moves',
  U.firstTurnOnly('Fake Out') === true && U.firstTurnOnly('First Impression') === true &&
  U.firstTurnOnly('Sucker Punch') === false && U.firstTurnOnly('Double-Edge') === false,
  String(U.firstTurnOnly('First Impression')));
check('Fake Out is the guaranteed flinch (a 100 % secondary, not a roll)',
  U.guaranteedFlinch('Fake Out') === true && U.guaranteedFlinch('Iron Head') === false &&
  U.guaranteedFlinch('Sucker Punch') === false, String(U.guaranteedFlinch('Iron Head')));
check('the flinch blockers are read from a revealed ability/item only',
  U.flinchBlocked({ ability: 'Inner Focus' }) === true &&
  U.flinchBlocked({ ability: 'Shield Dust' }) === true &&
  U.flinchBlocked({ item: 'Covert Cloak' }) === true &&
  U.flinchBlocked({ ability: 'Clear Body', item: 'Leftovers' }) === false &&
  U.flinchBlocked({}) === false && U.flinchBlocked(null) === false, '');

/* ================================================== 2. "first turn out", both readings */

section('2. _firstTurnOut: the log reading and the clock reading');

const lead = board({ turn: 1 });
check('a lead on turn 1 is on its first turn',
  ON._firstTurnOut(lead.active.my, lead) === true, '');
const leadMoved = board({ turn: 2, myExtra: { switchedInTurn: 1, lastMoveTurn: 1 } });
check('...and is not, once it has moved on turn 1', ON._firstTurnOut(leadMoved.active.my, leadMoved) === false, '');
const freshIn = board({ turn: 6, myExtra: { switchedInTurn: 5, lastMoveTurn: 2 } });
check('a body that switched in on turn 5 is on its first turn on turn 6',
  ON._firstTurnOut(freshIn.active.my, freshIn) === true, '');
const acted = board({ turn: 7, myExtra: { switchedInTurn: 5, lastMoveTurn: 6 } });
check('...and is not on turn 7, having acted on turn 6', ON._firstTurnOut(acted.active.my, acted) === false, '');
const flinched = board({ turn: 9, myExtra: { switchedInTurn: 5, lastMoveTurn: 2 } });
check('a body flinched through its whole window is NOT still "first turn out" (the clock closes it)',
  ON._firstTurnOut(flinched.active.my, flinched) === false, '');
check('an unreadable body is never first turn out', ON._firstTurnOut(null, lead) === false, '');

/* ============================================ 3. Sucker Punch: the switch column */

section('3. Sucker Punch into a predicted switch: no hit, and the incoming body still lands');

{
  const st = board();
  const gliscor = st.oppTeam[1];
  const incomingHp = ON._oppSwitchInHp(gliscor, st, st.field);
  check('the fixture really does charge the switch-in entry hazards (a non-100 % body)',
    incomingHp < 100, incomingHp + '%');

  const on = cell(ON, SUCKER, SWITCH_GLISCOR, st);
  const off = cell(OFF, SUCKER, SWITCH_GLISCOR, st);

  check('the switch-in is the body the leaf board stands around',
    on.trace.oppSideMon === gliscor, on.trace.oppSideMon && on.trace.oppSideMon.species);
  same('ON: Sucker Punch deals NOTHING to the switch-in (it fails against a switch)',
    on.trace.oppHp, incomingHp);
  check('OFF: the legacy cell credited the hit to that body (the bug this closes)',
    off.trace.oppHp < incomingHp - 1e-9, off.trace.oppHp + ' vs ' + incomingHp);
  check('...so the failing line is now scored BELOW the line that really connected',
    on.score < off.score, on.score + ' vs ' + off.score);
  same('ON: we take no reply damage either (a switch is not an attack)',
    on.trace.myHp, 100);
  same('...and the cell IS the board where nothing was hit',
    on.score, ON.evaluator.evaluate(ON._leafState(st, st.active.my, gliscor, 100, incomingHp)));
  same('an engine that never had the tier reproduces the old number exactly',
    NO_SUCKER._payoff(SUCKER, SWITCH_GLISCOR, st, st.field), off.score);
}

/* ================================== 4. Sucker Punch: non-attacking moves of theirs */

section('4. Sucker Punch into their setup / status click: the hit is gone, their turn is not');

{
  const st = board();
  const gain = U.setupBoosts('Dragon Dance');
  const on = cell(ON, SUCKER, DRAGON_DANCE, st);
  const off = cell(OFF, SUCKER, DRAGON_DANCE, st);

  const fu = ON._setupFollowUp({ kind: 'switch', name: '' }, st.active.my, st.active.opp,
    st.active.my, gain, 0, { oppHp: 100, myHp: 100 }, st.field, st);
  same('ON: their body starts the extension at full HP — our Sucker Punch never hit it',
    on.trace.oppHp, fu.oppHp);
  same('...and the extension is exactly their boosted reply (no repeat hit of ours)',
    on.trace.myHp, fu.myHp);
  check('OFF: the legacy cell landed the hit AND repeated it on turn 2',
    off.trace.oppHp < on.trace.oppHp - 1e-9, off.trace.oppHp + ' vs ' + on.trace.oppHp);

  const statusSt = board();
  const status = cell(ON, SUCKER, { kind: 'move', name: 'Thunder Wave', moveId: 'thunderwave' }, statusSt);
  same('a STATUS reply leaves their HP untouched as well (they are not attacked)',
    status.trace.oppHp, 100);
}

/* ======================================= 5. Sucker Punch against a real attack */

section('5. Sucker Punch against an attacking reply is untouched (the rule does not fire)');

{
  const st = board();
  same('an attacking column prices identically with the tier on and off',
    ON._payoff(SUCKER, EXTREME_SPEED, st, st.field),
    OFF._payoff(SUCKER, EXTREME_SPEED, st, st.field));
  const on = cell(ON, SUCKER, EXTREME_SPEED, st);
  check('...and the hit really did land (the control is not vacuous)',
    on.trace.oppHp < 100, on.trace.oppHp + '%');
  same('a Sucker Punch that lands is not treated as a first-turn-only move',
    NO_FIRSTTURN._payoff(SUCKER, EXTREME_SPEED, st, st.field),
    ON._payoff(SUCKER, EXTREME_SPEED, st, st.field));
}

/* ================================== 6. Fake Out: the first turn, and the flinch */

section('6. Fake Out on its one legal turn: damage lands and the reply is flinched away');

{
  const st = board({ turn: 1 });            // lead, never acted
  const hit = ON._damageOf(st.active.my, st.active.opp, 'Fake Out', st.field, true);
  check('the fixture Fake Out really does damage', !!hit && hit.avgPercent > 0,
    hit && hit.avgPercent);
  const on = cell(ON, FAKE_OUT, EXTREME_SPEED, st);
  const off = cell(OFF, FAKE_OUT, EXTREME_SPEED, st);
  same('ON: our Fake Out lands', on.trace.oppHp, U.clamp(100 - hit.avgPercent, 0, 100));
  same('ON: their Extreme Speed is flinched away — we take NOTHING', on.trace.myHp, 100);
  check('OFF: the legacy cell charged that reply in full', off.trace.myHp < 100, off.trace.myHp);
  same('...while agreeing about our own hit', off.trace.oppHp, on.trace.oppHp);
  check('so the flinch makes the legal Fake Out line worth more than it used to be',
    on.score > off.score, on.score + ' vs ' + off.score);
}

section('6b. Fake Out on any later turn: it fails, and the cell says so');

{
  const st = board({ turn: 6, myExtra: { switchedInTurn: 4, lastMoveTurn: 5 } });
  const on = cell(ON, FAKE_OUT, EXTREME_SPEED, st);
  const off = cell(OFF, FAKE_OUT, EXTREME_SPEED, st);
  same('ON: Fake Out deals nothing outside its window', on.trace.oppHp, 100);
  check('OFF: the legacy cell kept crediting it', off.trace.oppHp < 100, off.trace.oppHp);
  check('...and their reply lands in both arms', on.trace.myHp < 100 && off.trace.myHp < 100,
    on.trace.myHp + ' / ' + off.trace.myHp);
  check('the illegal line is strictly worse than the legacy one it replaced',
    on.score < off.score, on.score + ' vs ' + off.score);
  same('a failed Fake Out has no second exchange either (vs their setup reply)',
    cell(ON, FAKE_OUT, DRAGON_DANCE, st).trace.oppHp, 100);
}

section('6c. the flinch is a game rule with named exemptions');

{
  const st = turnOne('Inner Focus');
  const on = cell(ON, FAKE_OUT, EXTREME_SPEED, st);
  check('a revealed Inner Focus stops the flinch: their reply lands', on.trace.myHp < 100,
    on.trace.myHp);
  check('...while our Fake Out still hits', on.trace.oppHp < 100, on.trace.oppHp);

  const cloak = turnOne('Clear Body', 'Covert Cloak');
  check('a Covert Cloak does the same', cell(ON, FAKE_OUT, EXTREME_SPEED, cloak).trace.myHp < 100, '');

  const plain = board({ turn: 1 });
  same('an unrevealed body is assumed flinchable (no immunity is invented)',
    cell(ON, FAKE_OUT, EXTREME_SPEED, plain).trace.myHp, 100);
}
function turnOne(ability, item) {
  return board({ turn: 1, oppExtra: { ability: ability, item: item || '' } });
}

/* ================================================ 7. their Sucker Punch, their Fake Out */

section('7. the same rules on THEIR side of the matrix');

{
  const st = board();
  const vsStatus = cell(ON, DRAGON_DANCE, SUCKER, st);
  const vsStatusOff = cell(OFF, DRAGON_DANCE, SUCKER, st);
  same('we click a setup move: their Sucker Punch FAILS, so we take nothing',
    vsStatus.trace.myHp, 100);
  check('OFF: the legacy cell charged it', vsStatusOff.trace.myHp < 100, vsStatusOff.trace.myHp);

  const vsAttack = cell(ON, DOUBLE_EDGE, SUCKER, st);
  check('we click an attack: their Sucker Punch connects', vsAttack.trace.myHp < 100,
    vsAttack.trace.myHp);

  const switchSt = board();
  switchSt.field.hazards.p1 = { rocks: true };      // so the incoming body lands below 100 %
  const incoming = ON._switchInHp(switchSt.myTeam[1], switchSt, switchSt.field);
  check('the fixture really does charge OUR incoming body entry hazards', incoming < 100,
    incoming + '%');
  same('we switch: their Sucker Punch fails, so the incoming body keeps its hazard-adjusted HP',
    cell(ON, SWITCH_SLOWKING, SUCKER, switchSt).trace.myHp, incoming);
  check('OFF: the legacy cell charged their Sucker Punch into the incoming body',
    cell(OFF, SWITCH_SLOWKING, SUCKER, switchSt).trace.myHp < incoming,
    cell(OFF, SWITCH_SLOWKING, SUCKER, switchSt).trace.myHp + ' vs ' + incoming);
}

section('7b. their Fake Out flinches us');

{
  const st = board({ turn: 1 });            // their lead, first turn out
  const ours = cell(ON, DOUBLE_EDGE, FAKE_OUT, st);
  same('our Double-Edge never happens: the flinch takes our whole click', ours.trace.oppHp, 100);
  check('...while their Fake Out still hits us', ours.trace.myHp < 100, ours.trace.myHp);

  const off = cell(OFF, DOUBLE_EDGE, FAKE_OUT, st);
  check('OFF: the legacy cell let our click through', off.trace.oppHp < 100, off.trace.oppHp);

  const prio = cell(ON, FAKE_OUT, FAKE_OUT, st);
  check('a Fake Out of our own is a Speed tie, not a flinch: our hit is left standing',
    prio.trace.oppHp < 100, prio.trace.oppHp + '%');

  const later = board({ turn: 8, oppExtra: { switchedInTurn: 1, lastMoveTurn: 7 } });
  check('their Fake Out after its window is a wasted click, not a flinch',
    cell(ON, DOUBLE_EDGE, FAKE_OUT, later).trace.oppHp < 100, '');
}

/* ================================================= 8. each switch on its own / purity */

section('8. each sub-knob is exact on its own, and the tier off is the old engine');

{
  const st = board();
  const a = ON._payoff(SUCKER, EXTREME_SPEED, st, st.field);
  same('turning one knob off cannot move a cell it does not govern',
    NO_FLINCH._payoff(SUCKER, EXTREME_SPEED, st, st.field), a);

  const firstTurn = board({ turn: 1 });
  same('flinch:false reproduces the legacy Fake Out cell exactly',
    NO_FLINCH._payoff(FAKE_OUT, EXTREME_SPEED, firstTurn, firstTurn.field),
    OFF._payoff(FAKE_OUT, EXTREME_SPEED, firstTurn, firstTurn.field));

  const later = board({ turn: 6, myExtra: { switchedInTurn: 4, lastMoveTurn: 5 } });
  const noFirst = cell(NO_FIRSTTURN, FAKE_OUT, EXTREME_SPEED, later);
  const legacyLater = cell(OFF, FAKE_OUT, EXTREME_SPEED, later);
  same('firstTurnOnly:false lets the damage land again',
    noFirst.trace.oppHp, legacyLater.trace.oppHp);
  check('...and the flinch is a SEPARATE switch: the reply is still taken away',
    noFirst.trace.myHp === 100 && legacyLater.trace.myHp < 100,
    noFirst.trace.myHp + ' / ' + legacyLater.trace.myHp);

  const plainSwitch = board();
  same('suckerPunchRequiresAttack:false reproduces the legacy switch column',
    NO_SUCKER._payoff(SUCKER, SWITCH_GLISCOR, plainSwitch, plainSwitch.field),
    OFF._payoff(SUCKER, SWITCH_GLISCOR, plainSwitch, plainSwitch.field));

  const quiet = board({ turn: 4, myExtra: { switchedInTurn: 1, lastMoveTurn: 3 },
    oppExtra: { switchedInTurn: 1, lastMoveTurn: 3 } });
  same('a board where no rule fires is priced byte-for-byte as before',
    ON._payoff(DOUBLE_EDGE, EXTREME_SPEED, quiet, quiet.field),
    OFF._payoff(DOUBLE_EDGE, EXTREME_SPEED, quiet, quiet.field));

  const pure = board();
  const before = clone(pure);
  ON._payoff(SUCKER, SWITCH_GLISCOR, pure, pure.field);
  ON._payoff(FAKE_OUT, EXTREME_SPEED, pure, pure.field);
  ON._payoff(DOUBLE_EDGE, FAKE_OUT, pure, pure.field);
  check('the live board is never written through',
    JSON.stringify(before) === JSON.stringify(pure), firstDiff(before, pure));
  same('a repeated cell is deterministic',
    ON._payoff(SUCKER, SWITCH_GLISCOR, pure, pure.field),
    ON._payoff(SUCKER, SWITCH_GLISCOR, pure, pure.field));
  same('a second engine prices the same cell identically',
    mkEngine()._payoff(SUCKER, SWITCH_GLISCOR, pure, pure.field),
    ON._payoff(SUCKER, SWITCH_GLISCOR, pure, pure.field));
}

function firstDiff(a, b) {
  const seen = [];
  (function walk(x, y, p) {
    if (seen.length >= 3) return;
    if (typeof x !== typeof y) { seen.push(p + ': ' + typeof x + ' vs ' + typeof y); return; }
    if (x === null || y === null || typeof x !== 'object') { if (x !== y) seen.push(p + ': ' + x + ' vs ' + y); return; }
    Object.keys(x).forEach(function (k) { walk(x[k], y[k], p + '.' + k); });
  }(a, b, '$'));
  return seen.join('; ') || 'equal';
}

/* ================================================================== summary */

console.log('\n=== summary ===');
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failures.length);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('ALL CONDITIONAL-MOVE CHECKS PASSED');
process.exit(0);
