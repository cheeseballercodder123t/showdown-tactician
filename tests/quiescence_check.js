/* Showdown Tactician — tests/quiescence_check.js
 *
 * WHY THIS EXISTS
 *   The simultaneous payoff matrix prices ONE turn, and two of the opponent's replies are not
 *   damage. The 1-ply model read both as no-ops:
 *
 *     - their SETUP move dealt no damage and changed no state, so "they click Dragon Dance" scored
 *       as a free hit for us: the cell had no idea the +1 Atk / +1 Spe it grants arrives next turn;
 *     - their PROTECT did not block our move, so a line that KO'd their body kept its lethal bonus
 *       straight through the shield.
 *
 *   `config.laplace.quiescence` re-prices both, from GAME RULES only. The stages a setup move
 *   grants come from the table beside SETUP_MOVES in src/util.js, and they are APPLIED BY THE
 *   DAMAGE ENGINE as a per-call override — no file under src/ computes a damage number by hand,
 *   which is the rule tests/blackbox_guard.js exists to enforce.
 *
 *   This suite pins the mechanism rather than a hope: the table's completeness, the override
 *   contract the extension rides on (which was BROKEN — `m.boosts || override` silently ignored
 *   every override, because every MonState carries a boosts table), the arithmetic of the extra
 *   exchange, the three guards, purity (the live board is never written through) and the cost.
 *   Direction checks are IDENTITIES computed from the damage engine's own numbers instead of magic
 *   constants, so a fixture drifting by a percent cannot make this suite lie.
 *
 * Run me with:  node tests/quiescence_check.js
 */
'use strict';

const H = require('./harness.js');
// content.js auto-boots on the harness's stubbed hostname and starts a heartbeat that would keep
// this process alive forever, so the timers are stubbed exactly as the other suites do.
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
/** Compare two numbers exactly by default; `tol` exists only for float identities. */
function same(name, got, want, tol) {
  const limit = tol === undefined ? 1e-9 : tol;
  const ok = typeof got === 'number' && typeof want === 'number' && Math.abs(got - want) <= limit;
  return check(name, ok, 'got ' + got + ', want ' + want);
}
/** JSON equality with sorted keys, so property ORDER in a literal cannot cause a false failure. */
function sortedJSON(x) {
  if (Array.isArray(x)) return JSON.stringify(x);
  if (!x || typeof x !== 'object') return JSON.stringify(x);
  const o = {};
  Object.keys(x).sort().forEach(function (k) { o[k] = x[k]; });
  return JSON.stringify(o);
}
function eqc(name, got, want) {
  const a = sortedJSON(got), b = sortedJSON(want);
  return check(name, a === b, 'got ' + a + ', want ' + b);
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
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

/* Great Tusk into Dragonite. Ice Spinner is 4x (Ice vs Dragon/Flying), so the same board becomes a
 * KO or a NON-KO by HP alone — the two cases the guards have to tell apart. Dragonite's moves give
 * its reply space one setup, one priority attack, one coverage attack and one recovery, i.e. every
 * category the extension does (or deliberately does not) price. */
const MY_MOVES = ['Ice Spinner', 'Headlong Rush', 'Rapid Spin', 'Close Combat'];
const THEIR_MOVES = ['Dragon Dance', 'Extreme Speed', 'Earthquake', 'Roost'];

function board(theirExtra, protectExtra) {
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
    protect: Object.assign({
      oppTurnsSinceLastProtect: 2, oppConsecutiveProtects: 0,
      myTurnsSinceLastProtect: 4, myConsecutiveProtects: 0
    }, protectExtra || {}),
    recoveryPP: {},
    field: {
      turn: 12, trickRoom: false, weather: '', terrain: '',
      hazards: { p1: {}, p2: {} }, screens: {}, tailwind: {}, gravity: false
    }
  };
}

/* Every engine is built from the same option object the other suites use; the quiescence override
 * travels through the constructor so this suite exercises the real config plumbing. */
function mkEngine(quiescence, rollKo) {
  const damage = new ST.DamageEngine({ gen: 9 });
  const trickRoom = new ST.TrickRoomEngine(damage);
  return new ST.LaplaceEngine({
    sampler: new ST.WorldSampler({ K: 6 }), damage: damage,
    evaluator: new ST.DenseStateEvaluator(),
    tempo: new ST.TempoEngine({ damage: damage, trickRoom: trickRoom }),
    veto: new ST.BlunderVetoGuard({ damage: damage, trickRoom: trickRoom }), trickRoom: trickRoom,
    quiescence: quiescence || null,
    rollKoBranch: rollKo || null
  });
}
const SHIPPED = mkEngine();                                              // whatever config.js ships
const ON = mkEngine({ enabled: true, extendSetup: true, blockProtect: true });
const OFF = mkEngine({ enabled: false });                                // the 1-ply model replaced
const NO_EXTEND = mkEngine({ enabled: true, extendSetup: false });
const KO_ON = mkEngine(null, { enabled: true });                               // the exact-roll expectation
const KO_OFF = mkEngine(null, { enabled: false });                             // the scalar cliff
const NO_BLOCK = mkEngine({ enabled: true, blockProtect: false });

const ICE = { kind: 'move', name: 'Ice Spinner', moveId: 'icespinner' };
const SPIN = { kind: 'move', name: 'Rapid Spin', moveId: 'rapidspin' };
const DD = { kind: 'move', name: 'Dragon Dance', moveId: 'dragondance' };
const ESPEED = { kind: 'move', name: 'Extreme Speed', moveId: 'extremespeed' };
const PROTECT = { kind: 'protect', name: 'Protect', moveId: 'protect' };
const BELLY = { kind: 'move', name: 'Belly Drum', moveId: 'bellydrum' };
const C_SOUL = { kind: 'move', name: 'Clangorous Soul', moveId: 'clangoroussoul' };

/* =========================================== 1. the wiring and the setup table */

section('1. the switches, and the boost table they read');

const qcfg = ST.CONFIG && ST.CONFIG.laplace && ST.CONFIG.laplace.quiescence;
check('config.js carries the three quiescence switches', !!qcfg &&
  typeof qcfg.enabled === 'boolean' && typeof qcfg.extendSetup === 'boolean' && typeof qcfg.blockProtect === 'boolean',
  JSON.stringify(qcfg));
/* WHAT IT SHIPS, AND WHY ONE LEAF IS OFF. The tier was built to price two replies the 1-ply matrix
 * read as no-ops, and the setup half is still on. The PROTECT half measured badly on the personas
 * arena (+15.0 win [+6.7, +23.3] and +7.5 match score [+3.3, +11.7] for switching it OFF, cap games
 * 11/60 -> 2/60, all of it one seat), so it ships off and the ablation row patches it back ON —
 * ATTEMPTS.md K6 has the tables. Everything below drives the ON path through an explicit engine, so
 * the mechanism is still fully covered while the shipped default is the measured one. */
check('the extension SHIPS enabled with the setup ply on, and the protect block OFF (the measured default)',
  qcfg && qcfg.enabled === true && qcfg.extendSetup === true && qcfg.blockProtect === false, JSON.stringify(qcfg));
check('an engine with no override mirrors the config',
  SHIPPED.quiescence.enabled === qcfg.enabled && SHIPPED.quiescence.extendSetup === qcfg.extendSetup &&
  SHIPPED.quiescence.blockProtect === qcfg.blockProtect, JSON.stringify(SHIPPED.quiescence));
check('the documented literal fallbacks match the shipped config (a standalone load cannot drift)',
  ON.quiescence.enabled === true && ON.quiescence.extendSetup === true && ON.quiescence.blockProtect === true,
  JSON.stringify(ON.quiescence));

const TABLE = U.SETUP_BOOSTS || {};
const setupIds = [];
U.SETUP_MOVES.forEach(function (id) { setupIds.push(id); });
const unboosted = setupIds.filter(function (id) { return !TABLE[id]; });
check('every SETUP_MOVE has a boost entry, so no move is classified setup and then priced as a no-op',
  unboosted.length === 0, unboosted.join(', '));
check('the table invents no move the classifier does not know',
  Object.keys(TABLE).every(function (id) { return U.SETUP_MOVES.has(id); }),
  Object.keys(TABLE).filter(function (id) { return !U.SETUP_MOVES.has(id); }).join(', '));

const STAT_KEYS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
const badStage = [];
const emptyStage = [];
Object.keys(TABLE).forEach(function (id) {
  let staging = 0;
  Object.keys(TABLE[id]).forEach(function (k) {
    if (k === 'hpCostPct') return;
    staging++;
    if (STAT_KEYS.indexOf(k) === -1 || TABLE[id][k] % 1 !== 0 || TABLE[id][k] < -6 || TABLE[id][k] > 6 || TABLE[id][k] === 0) {
      badStage.push(id + '.' + k + '=' + TABLE[id][k]);
    }
  });
  if (!staging) emptyStage.push(id);
});
check('every stage is a non-zero integer in [-6, 6] on a real stat', badStage.length === 0, badStage.join(', '));
check('every entry actually boosts something', emptyStage.length === 0, emptyStage.join(', '));

const costed = Object.keys(TABLE).filter(function (id) { return typeof TABLE[id].hpCostPct === 'number'; }).sort();
// The list GREW deliberately: Fillet Away really does pay half the user's maximum HP, and pricing
// it as free at any HP would be the wrong game rule. Any future entry here must be a move that
// truly pays HP (Belly Drum 50, Clangorous Soul 33, Fillet Away 50).
eqc('only the HP-costing setup moves name a cost', costed, ['bellydrum', 'clangoroussoul', 'filletaway']);
check('the HP costs are the game rules (Belly Drum 50, Clangorous Soul 33, Fillet Away 50)',
  TABLE.bellydrum.hpCostPct === 50 && TABLE.clangoroussoul.hpCostPct === 33 && TABLE.filletaway.hpCostPct === 50,
  TABLE.bellydrum.hpCostPct + '/' + TABLE.clangoroussoul.hpCostPct + '/' + TABLE.filletaway.hpCostPct);

eqc('Dragon Dance grants +1 Atk / +1 Spe', U.setupBoosts('Dragon Dance'), { atk: 1, spe: 1 });
eqc('Belly Drum maximises Attack and carries the 50% cost', U.setupBoosts('Belly Drum'), { atk: 6, hpCostPct: 50 });
eqc('Shell Smash keeps its drops negative', U.setupBoosts('Shell Smash'), { atk: 2, def: -1, spa: 2, spd: -1, spe: 2 });

const handed = U.setupBoosts('Swords Dance');
handed.atk = 99;
check('setupBoosts hands back a COPY: mutating it cannot edit the table',
  TABLE.swordsdance.atk === 2 && U.setupBoosts('Swords Dance').atk === 2, TABLE.swordsdance.atk + '/' + U.setupBoosts('Swords Dance').atk);
check('a non-setup move has no boost spec at all',
  U.setupBoosts('Protect') === null && U.setupBoosts('Headlong Rush') === null && U.setupBoosts('') === null,
  JSON.stringify([U.setupBoosts('Protect'), U.setupBoosts('Headlong Rush'), U.setupBoosts('')]));
check('isSetupMove agrees with the table',
  U.isSetupMove('Dragon Dance') === true && U.isSetupMove('Protect') === false && U.isSetupMove('Recover') === false,
  JSON.stringify([U.isSetupMove('Dragon Dance'), U.isSetupMove('Protect'), U.isSetupMove('Recover')]));
check('a recovery move is NOT a setup move (the extension deliberately prices no heal)',
  U.isSetupMove('Recover') === false && U.getMoveData('Recover').isRecovery === true &&
  U.getMoveData('Recover').isSetup === false, JSON.stringify(U.getMoveData('Recover')));

/* ================================= 2. the override contract the extension rides on */

section('2. the per-call boost override (this was quietly broken before)');

const dmg = new ST.DamageEngine({ gen: 9 });
const probeField = board().field;
const atkMon = mon('Great Tusk', { side: 'p1', evs: OFFENSE, ivs: IVS, nature: 'Jolly', ability: 'Protosynthesis' });
const defMon = mon('Dragonite', { evs: OFFENSE, ivs: IVS, nature: 'Adamant', ability: 'Inner Focus' });
const base = dmg.calculateDamage(atkMon, defMon, 'Rapid Spin', probeField);
const atkUp = dmg.calculateDamage(atkMon, defMon, 'Rapid Spin', probeField, { attacker: { boosts: { atk: 4 } } });
const defUp = dmg.calculateDamage(atkMon, defMon, 'Rapid Spin', probeField, { defender: { boosts: { def: 4 } } });
const atkZero = dmg.calculateDamage(atkMon, defMon, 'Rapid Spin', probeField, { attacker: { boosts: { atk: 0 } } });
const atkSix = dmg.calculateDamage(atkMon, defMon, 'Rapid Spin', probeField, { attacker: { boosts: { atk: 6 } } });
const atkWild = dmg.calculateDamage(atkMon, defMon, 'Rapid Spin', probeField, { attacker: { boosts: { atk: 99 } } });

check('the fixture really resolves (a failed calculation would make everything below vacuous)',
  !base.failed && base.avgPercent > 0, base.error || (base.avgPercent + '%'));
check('an ATTACK override beats the mon\u2019s own zeroed boosts table', atkUp.avgPercent > base.avgPercent,
  base.avgPercent + '% -> ' + atkUp.avgPercent + '%');
check('a DEFENCE override cuts the damage', defUp.avgPercent < base.avgPercent,
  base.avgPercent + '% -> ' + defUp.avgPercent + '%');
same('a zero override is exactly the base number', atkZero.avgPercent, base.avgPercent);
same('stages are clamped to +6 (an out-of-range override cannot invent damage)',
  atkWild.avgPercent, atkSix.avgPercent);
check('the override does not mutate the mon it was handed',
  atkMon.boosts.atk === 0 && defMon.boosts.def === 0, JSON.stringify([atkMon.boosts.atk, defMon.boosts.def]));
same('the override does not leak into the next call (the memo key carries it)',
  dmg.calculateDamage(atkMon, defMon, 'Rapid Spin', probeField).avgPercent, base.avgPercent);

/* ================================================= 3. their shield is a real shield */

section('3. their Protect blocks our move, and the phantom KO with it');
{
  const st = board();
  const me = st.active.my, them = st.active.opp;
  const ko = ON._damageOf(me, them, 'Ice Spinner', st.field, true);
  check('the fixture knockout line really is a knockout at full HP', !!ko && ko.isOHKO === true,
    ko && (ko.avgPercent + '%'));

  const legacy = OFF._payoff(ICE, PROTECT, st, st.field);
  const live = ON._payoff(ICE, PROTECT, st, st.field);
  const unchanged = ON.evaluator.evaluate(ON._leafState(st, me, them, 100, 100));
  same('the protect cell IS the unchanged board: nothing happened to either side', live, unchanged);
  check('the legacy 1-ply cell scored our hit straight through the shield', legacy > live, legacy + ' vs ' + live);
  check('...by at least the lethal bonus it never earned', legacy - live >= ON.lethalBonus - 1e-9,
    (legacy - live) + ' vs lethalBonus ' + ON.lethalBonus);
  same('blockProtect:false reproduces the legacy number exactly',
    NO_BLOCK._payoff(ICE, PROTECT, st, st.field), legacy);
  same('quiescence.enabled:false reproduces it too (two ways off, one number)',
    OFF._payoff(ICE, PROTECT, st, st.field), legacy);
  same('a Protect reported as a plain move is shielded as well',
    ON._payoff(ICE, { kind: 'move', name: 'Protect', moveId: 'protect' }, st, st.field), live);
}

/* ==================================== 3b. the cell prices NO Protect decay, and that is the point */

section('3b. the shield is absolute: the cell has no decay rule, so a staller looks invincible in it');
{
  /* WHY THIS IS PINNED, AND WHAT IT VERIFIES. In the game Protect FAILS if it is clicked twice in a
   * row, so a staller cannot shield forever. The 1-ply cell cannot say that: `shielded` reads the
   * ACTION only (`oppAction.kind === 'protect' || oppData.isProtect`), never the opponent's protect
   * chain, so a shield in the cell blocks our move however long the chain is. The only thing in the
   * engine that reacts to the chain is the 128D evaluator's `protectRhythm` term (dim 126, +0.5 once
   * the consecutive count reaches 2), and it is a NUDGE applied to both arms, not a rule that lets
   * our hit through. That asymmetry is why shipping `blockProtect: false` bought 15 win points
   * against the staller (ATTEMPTS.md K6) and 70 with the seat to itself (K6b): with the shield
   * priced, every cell in their column reads as a free turn for them, so the engine's committing
   * lines all score 0 and it disengages; with the block off the cell credits the hit a live shield
   * would eat, and it stands its ground. This block establishes the MECHANISM behind those numbers
   * rather than restating them. */
  const fresh = board();
  const freshOn = ON._payoff(ICE, PROTECT, fresh, fresh.field);
  const freshLegacy = OFF._payoff(ICE, PROTECT, fresh, fresh.field);
  /* Their chain is already two long, so THIS Protect would fail in-game. */
  const chained = board({}, { oppConsecutiveProtects: 2, oppTurnsSinceLastProtect: 1 });
  const chainedOn = ON._payoff(ICE, PROTECT, chained, chained.field);
  const chainedLegacy = OFF._payoff(ICE, PROTECT, chained, chained.field);
  const freshGap = freshLegacy - freshOn;                 // what the shield costs us at a fresh board
  check('a REPEAT Protect still eats essentially the whole hit — the cell prices no decay',
    chainedLegacy - chainedOn > 0.85 * freshGap,
    (chainedLegacy - chainedOn).toFixed(2) + ' vs fresh ' + freshGap.toFixed(2));
  const deep = board({}, { oppConsecutiveProtects: 5, oppTurnsSinceLastProtect: 1 });
  same('...and the block does not react to chain depth at all: five deep prices like two deep',
    ON._payoff(ICE, PROTECT, deep, deep.field), chainedOn);
  const chainShift = chainedOn - freshOn;
  check('the only term that reads the chain is the evaluator nudge, and it cannot unblock a hit',
    chainShift > 0 && chainShift < 0.15 * freshGap,
    chainShift.toFixed(2) + ' vs ' + freshGap.toFixed(2));
  check('...and the SAME nudge shifts the legacy cell, so it is the evaluator, not the block',
    chainedLegacy > freshLegacy &&
      Math.abs((chainedLegacy - freshLegacy) - chainShift) < 0.25 * freshGap,
    (chainedLegacy - freshLegacy).toFixed(2) + ' vs ' + chainShift.toFixed(2));
}

/* ========================================= 4. their setup buys exactly one exchange */

section('4. their setup reply buys one extra exchange, priced by the damage engine');
{
  const st = board();
  const me = st.active.my, them = st.active.opp;
  const hit = ON._damageOf(me, them, SPIN.name, st.field, true);
  check('the fixture non-knockout line really is a non-knockout at full HP',
    !!hit && hit.isOHKO === false && hit.avgPercent > 0, hit && (hit.avgPercent + '%'));

  const firstOppHp = U.clamp(100 - hit.avgPercent, 0, 100);
  const gain = U.setupBoosts('Dragon Dance');
  const fu = ON._setupFollowUp(SPIN, me, them, me, gain, 0, { oppHp: firstOppHp, myHp: 100 }, st.field);

  // Their follow-up must be their own best move from the boosted state — recomputed here, so this
  // is an identity and not a remembered name.
  let bestName = null, bestPct = -1;
  THEIR_MOVES.forEach(function (n) {
    const r = ON._damageOf(them, me, n, st.field, false, { attacker: { boosts: gain } });
    if (r && r.avgPercent > bestPct) { bestPct = r.avgPercent; bestName = n; }
  });
  check('their follow-up is their best boosted attack', fu.move === bestName, fu.move + ' vs ' + bestName);

  const boosted = ON._damageOf(them, me, fu.move, st.field, false, { attacker: { boosts: gain } });
  const plain = ON._damageOf(them, me, fu.move, st.field, false);
  same('the follow-up hit IS the damage engine\u2019s own boosted number', fu.avgPercent, boosted.avgPercent);
  check('the boost raises their follow-up hit', boosted.avgPercent > plain.avgPercent,
    plain.avgPercent + '% -> ' + boosted.avgPercent + '%');
  same('their boosted hit is charged to us', fu.myHp, U.clamp(100 - boosted.avgPercent, 0, 100));

  const repeat = ON._damageOf(me, them, SPIN.name, st.field, true, { defender: { boosts: gain } });
  same('our row\u2019s own move is repeated against their boosted defence',
    fu.oppHp, U.clamp(firstOppHp - repeat.avgPercent, 0, 100));

  const leaf = ON._leafState(st, me, them, fu.myHp, fu.oppHp, { opp: gain });
  let expected = ON.evaluator.evaluate(leaf);
  if (fu.oppHp <= 0) expected += ON.lethalBonus;
  if (fu.myHp <= 0) expected -= ON.lethalBonus;
  same('the setup cell IS that follow-up leaf plus the usual knockout bonuses',
    ON._payoff(SPIN, DD, st, st.field), expected);

  const legacy = OFF._payoff(SPIN, DD, st, st.field);
  const live = ON._payoff(SPIN, DD, st, st.field);
  check('the legacy cell paid us the hit and charged nothing for the boost', legacy > live,
    legacy + ' vs ' + live);
  same('a DAMAGING reply is untouched by any of this (their Extreme Speed control)',
    ON._payoff(SPIN, ESPEED, st, st.field), OFF._payoff(SPIN, ESPEED, st, st.field));

  /* ------------------------------------------------------------------ the follow-up WEIGHT
   * `laplace.quiescence.followUpWeight` scales how much of that second exchange is charged. The
   * contract is that 1.0 is an EXACT identity (the cell pinned above is the shipped build), that a
   * missing or unusable value resolves to 1 rather than to 0 — the failure that would silently
   * delete the extension — and that anything in between scales the DAMAGE of the exchange and
   * nothing else (their boost still reaches the leaf, the Speed order is still resolved). */
  same('the shipped weight is the identity', ON._followUpWeight(), 1);
  eqc('...and a missing or unusable value resolves to the identity, never to 0',
    [mkEngine({ enabled: true })._followUpWeight(),
      mkEngine({ enabled: true, followUpWeight: Infinity })._followUpWeight(),
      mkEngine({ enabled: true, followUpWeight: NaN })._followUpWeight(),
      mkEngine({ enabled: true, followUpWeight: 'half' })._followUpWeight()], [1, 1, 1, 1]);
  eqc('...and an out-of-range one is clamped into [0, 1]',
    [mkEngine({ enabled: true, followUpWeight: -2 })._followUpWeight(),
      mkEngine({ enabled: true, followUpWeight: 5 })._followUpWeight()], [0, 1]);

  const HALF = mkEngine({ enabled: true, extendSetup: true, followUpWeight: 0.5 });
  const fuHalf = HALF._setupFollowUp(SPIN, me, them, me, gain, 0, { oppHp: firstOppHp, myHp: 100 }, st.field);
  same('half the weight charges exactly half of their follow-up hit',
    fuHalf.avgPercent, boosted.avgPercent * 0.5);
  same('...to our body', fuHalf.myHp, U.clamp(100 - boosted.avgPercent * 0.5, 0, 100));
  same('...and halves our repeated hit against their boosted defence too',
    fuHalf.oppHp, U.clamp(firstOppHp - repeat.avgPercent * 0.5, 0, 100));
  check('...while the boost still reaches the leaf, so the follow-up is still their boosted best move',
    fuHalf.move === fu.move, fuHalf.move + ' vs ' + fu.move);
  const halfCell = HALF._payoff(SPIN, DD, st, st.field);
  /* The direction is deliberately NOT asserted: the weight shrinks their boosted hit on us (better
   * for us) AND our repeated hit on them (worse), so which way the cell moves is a property of the
   * board, not of the knob. What the knob promises is that it MOVES. */
  check('...and the CELL moves, which is the point of the knob', halfCell !== live,
    live + ' -> ' + halfCell);

  const ZERO = mkEngine({ enabled: true, extendSetup: true, followUpWeight: 0 });
  const fuZero = ZERO._setupFollowUp(SPIN, me, them, me, gain, 0, { oppHp: firstOppHp, myHp: 100 }, st.field);
  same('a weight of 0 charges no second exchange on either side (their number)',
    fuZero.avgPercent, 0);
  same('...to our body', fuZero.myHp, 100);
  same('...and our repeat lands nothing either', fuZero.oppHp, firstOppHp);
  check('...and it is still NOT the legacy cell: zero the DAMAGE, not the boost',
    ZERO._payoff(SPIN, DD, st, st.field) !== legacy, '');

  // A DEFENCE-boosting setup must shrink our repeated hit: the second hit is priced with `gain` as
  // the DEFENDER\u2019s stages, not the attacker\u2019s.
  const idGain = U.setupBoosts('Iron Defense');
  const fuId = ON._setupFollowUp(SPIN, me, them, me, idGain, 0, { oppHp: firstOppHp, myHp: 100 }, st.field);
  const repeatId = ON._damageOf(me, them, SPIN.name, st.field, true, { defender: { boosts: idGain } });
  check('a DEFENCE-boosting setup makes our repeated hit smaller', repeatId.avgPercent < hit.avgPercent,
    hit.avgPercent + '% -> ' + repeatId.avgPercent + '%');
  same('...and the cell is priced on that smaller repeat',
    fuId.oppHp, U.clamp(firstOppHp - repeatId.avgPercent, 0, 100));
}

/* ======================= 4b. turn 2 is ORDERED, so a body that faints first does not act */

section('4b. the second exchange is ordered by turn-2 initiative (Speed, priority, Trick Room)');
{
  /* The two engines differ in ONE switch, so every difference below is that switch. */
  const NO_ORDER = mkEngine({ enabled: true, extendSetup: true, blockProtect: true, respectTurn2Speed: false });
  const ORDER = mkEngine({ enabled: true, extendSetup: true, blockProtect: true, respectTurn2Speed: true });
  eqc('the switch is read from the tier\u2019s own config section',
    ST.configGet('laplace.quiescence.respectTurn2Speed', null), true);
  eqc('...and an engine with no override mirrors it', SHIPPED.quiescence.respectTurn2Speed, true);

  const st = board();
  const me = st.active.my, them = st.active.opp;
  const ddGain = U.setupBoosts('Dragon Dance');       // +Attack, +Speed
  const idGain = U.setupBoosts('Iron Defense');       // +Defence only
  const bestThem = ORDER._bestMoveWithDamage(them, me, st.field, { attacker: { boosts: ddGain } });

  /* --- the ORDER itself, from the library's own Speed numbers --- */
  eqc('fixture: their boosted best reply is a 0-priority attack', ORDER._movePriority(bestThem.move), 0);
  eqc('fixture: we act first when their setup does not touch Speed',
    ORDER._turnOrder(me, 'Ice Spinner', them, bestThem.move, idGain, st.field, st), 'me');
  eqc('...and their SPEED boost is enough to take the turn-2 lead away from us',
    ORDER._turnOrder(me, 'Ice Spinner', them, bestThem.move, ddGain, st.field, st), 'them');
  /* Priority beats Speed, so a +2 attack takes the turn whatever the Speed says. */
  eqc('a priority reply takes the turn regardless of Speed',
    ORDER._turnOrder(me, 'Ice Spinner', them, 'Extreme Speed', idGain, st.field, st), 'them');
  /* Trick Room inverts it. */
  const trSt = board();
  trSt.field.trickRoom = true;
  eqc('Trick Room inverts the Speed comparison',
    ORDER._turnOrder(trSt.active.my, 'Ice Spinner', trSt.active.opp, bestThem.move, idGain, trSt.field, trSt), 'them');
  eqc('...and inverts the boosted one back the other way',
    ORDER._turnOrder(trSt.active.my, 'Ice Spinner', trSt.active.opp, bestThem.move, ddGain, trSt.field, trSt), 'me');
  /* A tie is a coin flip, and a coin flip is not a claim. */
  const tieSt = board();
  tieSt.active.opp.species = 'Great Tusk';
  tieSt.active.opp.id = 'greattusk';
  tieSt.active.opp.evs = OFFENSE; tieSt.active.opp.ivs = IVS; tieSt.active.opp.nature = 'Jolly';
  eqc('an exact Speed tie is reported as undecided, never guessed',
    ORDER._turnOrder(tieSt.active.my, 'Ice Spinner', tieSt.active.opp, bestThem.move, null, tieSt.field, tieSt), null);

  /* --- our repeat hit kills: their boosted reply never lands --- */
  const hit = ORDER._damageOf(me, them, 'Ice Spinner', st.field, true);
  const fuOurKo = ORDER._setupFollowUp(ICE, me, them, me, idGain, 0,
    { oppHp: U.round1(hit.avgPercent) / 2, myHp: 100 }, st.field, st);
  same('our second hit finishes them', fuOurKo.oppHp, 0, 1e-9);
  same('...so their BOOSTED reply deals nothing at all (a dead body does not attack)',
    fuOurKo.myHp, 100, 1e-9);
  const legacyOurKo = NO_ORDER._setupFollowUp(ICE, me, them, me, idGain, 0,
    { oppHp: U.round1(hit.avgPercent) / 2, myHp: 100 }, st.field, st);
  check('the un-ordered pricing charged us anyway (that is the defect)',
    legacyOurKo.myHp < 100, String(legacyOurKo.myHp));
  same('...by exactly their boosted hit', legacyOurKo.myHp,
    U.clamp(100 - fuOurKo.avgPercent, 0, 100), 1e-9);

  /* --- their boosted hit kills us first: our repeat never lands --- */
  const boostedHit = ORDER._damageOf(them, me, bestThem.move, st.field, false, { attacker: { boosts: ddGain } });
  const fuTheirKo = ORDER._setupFollowUp(ICE, me, them, me, ddGain, 0,
    { oppHp: 90, myHp: U.round1(boostedHit.avgPercent) / 2 }, st.field, st);
  same('their boosted hit finishes us on turn 2', fuTheirKo.myHp, 0, 1e-9);
  same('...and our second hit never happens (a dead body does not attack)', fuTheirKo.oppHp, 90, 1e-9);
  const legacyTheirKo = NO_ORDER._setupFollowUp(ICE, me, them, me, ddGain, 0,
    { oppHp: 90, myHp: U.round1(boostedHit.avgPercent) / 2 }, st.field, st);
  check('the un-ordered pricing landed our repeat anyway',
    legacyTheirKo.oppHp < 90, String(legacyTheirKo.oppHp));

  /* --- when nothing dies, the ORDER changes nothing: both actions still land --- */
  const fuOrdered = ORDER._setupFollowUp(ICE, me, them, me, idGain, 0, { oppHp: 90, myHp: 100 }, st.field, st);
  const fuLegacy = NO_ORDER._setupFollowUp(ICE, me, them, me, idGain, 0, { oppHp: 90, myHp: 100 }, st.field, st);
  same('with both bodies surviving, the ordered pricing IS the old one on our HP',
    fuOrdered.myHp, fuLegacy.myHp, 1e-9);
  same('...and on theirs', fuOrdered.oppHp, fuLegacy.oppHp, 1e-9);

  /* --- and the tie / unreadable case falls back to the old both-actions pricing --- */
  const fuTie = ORDER._setupFollowUp(ICE, tieSt.active.my, tieSt.active.opp, tieSt.active.my, idGain, 0,
    { oppHp: 90, myHp: 100 }, tieSt.field, tieSt);
  const fuTieLegacy = NO_ORDER._setupFollowUp(ICE, tieSt.active.my, tieSt.active.opp, tieSt.active.my, idGain, 0,
    { oppHp: 90, myHp: 100 }, tieSt.field, tieSt);
  same('an undecidable order falls back to the un-ordered pricing', fuTie.myHp, fuTieLegacy.myHp, 1e-9);
  same('...on their side too', fuTie.oppHp, fuTieLegacy.oppHp, 1e-9);

  /* --- the whole cell: a knockout priced through `_payoff` still ends the turn --- */
  const ko = board();
  same('a knockout line vs their setup reply keeps its EXACT legacy number (the guard runs first)',
    ORDER._payoff(ICE, DD, ko, ko.field), NO_ORDER._payoff(ICE, DD, ko, ko.field), 1e-9);
}

/* ==================================================== 5. the guards and the switches */

section('5. the guards: a knockout ends it, an unaffordable setup fails, each switch is exact');
{
  // --- a body that faints this turn has no next turn
  const ko = board();
  same('our knockout line vs their setup reply is EXACTLY the legacy number',
    ON._payoff(ICE, DD, ko, ko.field), OFF._payoff(ICE, DD, ko, ko.field));
  const leafDead = ON.evaluator.evaluate(ON._leafState(ko, ko.active.my, ko.active.opp, 100, 0));
  const leafStamped = ON.evaluator.evaluate(ON._leafState(ko, ko.active.my, ko.active.opp, 100, 0,
    { opp: U.setupBoosts('Dragon Dance') }));
  check('...and that equality is not vacuous: stamping the stages WOULD move the leaf',
    Math.abs(leafStamped - leafDead) > 1e-9, leafDead + ' vs ' + leafStamped);

  // --- a setup they cannot pay for
  const poor = board({ hpPercent: 40, setMoves: ['Belly Drum', 'Extreme Speed', 'Earthquake', 'Roost'] });
  same('Belly Drum at 40% HP FAILS, so it prices as the wasted turn it is',
    ON._payoff(SPIN, BELLY, poor, poor.field), OFF._payoff(SPIN, BELLY, poor, poor.field));
  const rich = board({ hpPercent: 90, setMoves: ['Belly Drum', 'Extreme Speed', 'Earthquake', 'Roost'] });
  const hitRich = ON._damageOf(rich.active.my, rich.active.opp, SPIN.name, rich.field, true);
  const firstRich = U.clamp(90 - hitRich.avgPercent, 0, 100);
  const bellyGain = { atk: 6 };
  const fuBelly = ON._setupFollowUp(SPIN, rich.active.my, rich.active.opp, rich.active.my, bellyGain, 50,
    { oppHp: firstRich, myHp: 100 }, rich.field);
  const repeatBelly = ON._damageOf(rich.active.my, rich.active.opp, SPIN.name, rich.field, true,
    { defender: { boosts: bellyGain } });
  same('...but at 90% HP the 50% cost is charged before the follow-up',
    fuBelly.oppHp, U.clamp(U.clamp(firstRich - 50, 0, 100) - repeatBelly.avgPercent, 0, 100));
  check('...so that cell is no longer the legacy number',
    ON._payoff(SPIN, BELLY, rich, rich.field) !== OFF._payoff(SPIN, BELLY, rich, rich.field),
    'both ' + ON._payoff(SPIN, BELLY, rich, rich.field));

  const soulMoves = ['Clangorous Soul', 'Extreme Speed', 'Earthquake', 'Roost'];
  const brokeSoul = board({ hpPercent: 33, setMoves: soulMoves });
  same('Clangorous Soul at exactly its 33% cost FAILS (the affordability test is strict)',
    ON._payoff(SPIN, C_SOUL, brokeSoul, brokeSoul.field), OFF._payoff(SPIN, C_SOUL, brokeSoul, brokeSoul.field));
  const richSoul = board({ hpPercent: 34, setMoves: soulMoves });
  check('...and at 34% it applies',
    ON._payoff(SPIN, C_SOUL, richSoul, richSoul.field) !== OFF._payoff(SPIN, C_SOUL, richSoul, richSoul.field),
    'both ' + ON._payoff(SPIN, C_SOUL, richSoul, richSoul.field));
  const soulBig = board({ hpPercent: 90, setMoves: soulMoves });
  const hitSoul = ON._damageOf(soulBig.active.my, soulBig.active.opp, SPIN.name, soulBig.field, true);
  const firstSoul = U.clamp(90 - hitSoul.avgPercent, 0, 100);
  const soulGain = { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
  const fuSoul = ON._setupFollowUp(SPIN, soulBig.active.my, soulBig.active.opp, soulBig.active.my, soulGain, 33,
    { oppHp: firstSoul, myHp: 100 }, soulBig.field);
  const repeatSoul = ON._damageOf(soulBig.active.my, soulBig.active.opp, SPIN.name, soulBig.field, true,
    { defender: { boosts: soulGain } });
  same('Clangorous Soul\u2019s third of max HP is charged the same way as Belly Drum\u2019s half',
    fuSoul.oppHp, U.clamp(U.clamp(firstSoul - 33, 0, 100) - repeatSoul.avgPercent, 0, 100));

  // --- a switch row: the boost is still paid for, but WE get no second hit out of it
  const st = board();
  const sw = { kind: 'switch', name: 'Slowking-Galar', targetId: 'slowkinggalar' };
  const fuSwitch = ON._setupFollowUp(sw, st.active.my, st.active.opp, st.active.my,
    U.setupBoosts('Dragon Dance'), 0, { oppHp: 80, myHp: 100 }, st.field);
  same('a switch row adds no second hit of ours: their HP is never debited by us', fuSwitch.oppHp, 80);
  check('...unlike a move row, which does debit them again',
    ON._setupFollowUp(SPIN, st.active.my, st.active.opp, st.active.my, U.setupBoosts('Dragon Dance'), 0,
      { oppHp: 80, myHp: 100 }, st.field).oppHp < 80, 'a move row did not repeat the hit');
  check('a pivot still pays their boosted follow-up (the boost is not skipped for a switch)',
    ON._payoff(sw, DD, st, st.field) < OFF._payoff(sw, DD, st, st.field),
    ON._payoff(sw, DD, st, st.field) + ' vs ' + OFF._payoff(sw, DD, st, st.field));

  // --- our OWN setup is not the thing being priced
  const mySetup = { kind: 'move', name: 'Swords Dance', moveId: 'swordsdance' };
  same('our own setup move is untouched: only THEIR reply is priced',
    ON._payoff(mySetup, ESPEED, st, st.field), OFF._payoff(mySetup, ESPEED, st, st.field));

  // --- each switch on its own reproduces the legacy number
  same('extendSetup:false reproduces the legacy setup cell exactly',
    NO_EXTEND._payoff(SPIN, DD, st, st.field), OFF._payoff(SPIN, DD, st, st.field));

  // --- a reply space with nothing to re-price is untouched, reply by reply
  const quiet = board({ setMoves: ['Extreme Speed', 'Earthquake', 'Roost', 'Dragon Claw'] });
  const untouched = quiet.active.opp.setMoves.every(function (n) {
    const act = { kind: 'move', name: n, moveId: U.toID(n) };
    return ON._payoff(SPIN, act, quiet, quiet.field) === OFF._payoff(SPIN, act, quiet, quiet.field);
  });
  check('a reply space with no setup and no Protect is priced byte-for-byte as before', untouched);
}

/* ==================================================== 6. purity and determinism */

section('6. purity and determinism (the live board is never written through)');
{
  const st = board();
  const before = clone(st);
  const a1 = ON._payoff(SPIN, DD, st, st.field);
  const b1 = ON._payoff(ICE, PROTECT, st, st.field);
  const a2 = ON._payoff(SPIN, DD, st, st.field);
  const b2 = ON._payoff(ICE, PROTECT, st, st.field);
  check('the live board is byte-identical after pricing a setup cell and a protect cell',
    JSON.stringify(before) === JSON.stringify(st), firstDiff(before, st));
  eqc('...including the boosts table (no stage was written through)',
    st.active.opp.boosts, before.active.opp.boosts);
  same('a repeated setup cell is identical (deterministic)', a2, a1);
  same('a repeated protect cell is identical', b2, b1);
  same('a second engine prices the same cell identically',
    mkEngine({ enabled: true })._payoff(SPIN, DD, st, st.field), a1);

  const stacked = board();
  stacked.active.opp.boosts.atk = 2;
  const snap = clone(stacked);
  const stackedCell = ON._payoff(SPIN, DD, stacked, stacked.field);
  eqc('a body that already had +2 Atk is still +2 afterwards (no write-through)',
    stacked.active.opp.boosts, snap.active.opp.boosts);
  check('...and that cell really did price the boosted body',
    typeof stackedCell === 'number' && isFinite(stackedCell), String(stackedCell));

  const leaf = ON._leafState(stacked, stacked.active.my, stacked.active.opp, 100, 50, { opp: { atk: 1 } });
  eqc('the leaf merges the stage additively into its OWN property (+2 and +1 is +3)',
    leaf.active.opp.boosts, { atk: 3, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 });
  eqc('...while the source body is untouched by the merge', stacked.active.opp.boosts, snap.active.opp.boosts);
  check('...and the leaf is still a prototype clone, as everything downstream assumes',
    Object.getPrototypeOf(leaf.active.opp) === stacked.active.opp, 'not a prototype clone');
}

/* ============================================================= 7. what it costs */

section('7. cost: it pays only for the replies it re-prices');

/** Count the engine-level damage calls one payoff makes (memo hits included: this is work asked for). */
function damageCalls(engine, fn) {
  let n = 0;
  const real = engine._damageOf;
  engine._damageOf = function () { n++; return real.apply(engine, arguments); };
  try { fn(); } finally { delete engine._damageOf; }
  return n;
}
{
  const st = board();
  const theirMoves = st.active.opp.setMoves.length;

  const onAttack = damageCalls(ON, function () { ON._payoff(SPIN, ESPEED, st, st.field); });
  const offAttack = damageCalls(OFF, function () { OFF._payoff(SPIN, ESPEED, st, st.field); });
  same('a damaging reply costs both engines the same number of damage calls', onAttack, offAttack);

  const offSetup = damageCalls(OFF, function () { OFF._payoff(SPIN, DD, st, st.field); });
  const onSetup = damageCalls(ON, function () { ON._payoff(SPIN, DD, st, st.field); });
  same('the legacy path spends two calls (our hit + their reply)', offSetup, 2);
  same('the extended path spends our hit + their modelled moves + our repeat, and not one more',
    onSetup, theirMoves + 2);
  check('...which is a bounded number: the search is per move, not a tree',
    onSetup - offSetup <= theirMoves + 1, (onSetup - offSetup) + ' extra calls');

  const offBlock = damageCalls(OFF, function () { OFF._payoff(ICE, PROTECT, st, st.field); });
  const onBlock = damageCalls(ON, function () { ON._payoff(ICE, PROTECT, st, st.field); });
  same('their shield costs ONE call fewer: our hit is skipped entirely', onBlock, offBlock - 1);
}

/* ============================================ 8. the KO cliff on the exact 16 rolls */

section('8. the 100 % cliff: one mean used as a certainty, replaced by the exact-roll share');

/* THE CLIFF. `_payoff` moved the target by `avgPercent` — the MEAN over the sixteen damage rolls —
 * and clamped at 0, so a mean of 101 % was priced as a certain OHKO that nothing answered from,
 * while a mean of 97 % left the target alive and its reply landing in full. Those are one
 * distribution, not two, and the difference between them was the shape of the mean rather than the
 * game. Checked through the method the cell actually calls, so a rename cannot leave this passing. */
same('OFF is the historical line: a mean past the target clamps to zero',
  KO_OFF._koTransition(100, { avgPercent: 101 }), 0);
same('OFF ignores the roll set entirely',
  KO_OFF._koTransition(100, { avgPercent: 97, koChanceExact: 62.5 }), 3);

/* ON: expected HP = (1 - p) x surviving HP, with the surviving branch floored so a 15-of-16 roll
 * is not read as a KO. Direction checks are identities against the numbers above rather than magic
 * constants, so a fixture drifting by a percent cannot make this suite lie. */
const at = function (hp, avg, exact) {
  return KO_ON._koTransition(hp, { avgPercent: avg, koChanceExact: exact });
};
const mid = at(100, 101, 62.5);
same('ON prices the SAME cell as an expectation instead of a certainty', mid, 0.375);
check('...which is strictly between the two certainties the mean could have been read as',
  mid > 0 && mid < 3, String(mid));
/* The endpoints are not special-cased — they fall out of the formula — which is why the two arms
 * agree exactly wherever the outcome was never ambiguous. */
same('a hit that never KOs is the scalar path exactly', at(100, 40, 0), 60);
same('a hit that always KOs is still exactly zero', at(100, 101, 100), 0);
same('...and so is a mean that already passed the target with every roll', at(30, 90, 100), 0);
/* Monotone in the share of the roll set that reaches: more of it must never leave a healthier body. */
const ladder = [0, 25, 50, 75, 100].map(function (p) { return at(80, 70, p); });
check('expected HP is monotone in the share of rolls that reach',
  ladder.every(function (v, i) { return i === 0 || v <= ladder[i - 1]; }), ladder.join(' '));
check('...and strictly falls across the ambiguous middle', ladder[1] > ladder[3], ladder.join(' '));
check('...while the off arm reads every one of those as the same number',
  [0, 25, 50, 75].every(function (p) { return KO_OFF._koTransition(80, { avgPercent: 70, koChanceExact: p }) === 10; }));
/* An EXACT answer is required: a roll set that cannot answer keeps the scalar path rather than
 * guessing, which is the same refusal `calc_engine` makes when it returns a null `koChanceExact`. */
same('a roll set that cannot answer exactly keeps the scalar path', at(100, 101, null), 0);

/* THE SHIPPED STATE, read from the config this suite loaded rather than from a literal here.
 * `same()` compares NUMBERS only, so a boolean identity goes through `check()`. */
const shippedKo = ST.configGet('laplace.rollKoBranch.enabled', 'missing');
check('the tier ships OFF', shippedKo === false, String(shippedKo));
same('...so the shipped engine takes the scalar path', SHIPPED._koTransition(100, { avgPercent: 101 }), 0);

/* The damage result's SHAPE is a contract the other suites read, so the exact-roll fields may only
 * appear while the tier is on — off, this has to be the byte-identical object it always was.
 * Proven on a STUBBED damage engine rather than on a live call: what is under test here is the
 * PASSTHROUGH, and a real board would only be re-testing calc_engine. */
const stubbed = function (engine, payload) {
  const real = engine.damage.calculateDamage;
  engine.damage.calculateDamage = function () { return payload; };
  try { return engine._damageOf(mon('Great Tusk'), mon('Blissey'), 'Headlong Rush', {}, true); }
  finally { engine.damage.calculateDamage = real; }
};
const KO_PAYLOAD = {
  minPercent: 95, maxPercent: 105, avgPercent: 101, isOHKO: false, is2HKO: false,
  koChanceExact: 62.5, koChancePct: 62.5, rolls: new Array(16).fill(101)
};
const offShape = stubbed(KO_OFF, KO_PAYLOAD);
const onShape = stubbed(KO_ON, KO_PAYLOAD);
check('OFF carries no exact-roll field at all (the shipped shape is unchanged)',
  !!offShape && !('koChanceExact' in offShape) && !('koChancePct' in offShape) && !('rollCount' in offShape),
  JSON.stringify(offShape && Object.keys(offShape)));
check('ON surfaces the exact share of rolls that reach, plus the roll count it came from',
  !!onShape && onShape.koChanceExact === 62.5 && onShape.rollCount === 16, JSON.stringify(onShape));
check('...while every pre-existing field is identical between the two arms',
  !!onShape && !!offShape && ['move', 'minPercent', 'maxPercent', 'avgPercent', 'isOHKO', 'is2HKO']
    .every(function (k) { return onShape[k] === offShape[k]; }),
  JSON.stringify([offShape, onShape]));
/* `calc_engine` returns a NULL exact chance when the roll set cannot answer. That has to stay null
 * rather than becoming 0, because 0 means "no roll reaches" and would silently disable the tier on
 * exactly the cells it cannot price. */
const nullShape = stubbed(KO_ON, Object.assign({}, KO_PAYLOAD, { koChanceExact: null, rolls: null }));
check('a roll set that cannot answer keeps a NULL exact chance, never a 0',
  !!nullShape && nullShape.koChanceExact === null && nullShape.rollCount === 0, JSON.stringify(nullShape));
same('...and the transition falls back to the scalar path for it',
  KO_ON._koTransition(100, { avgPercent: 101, koChanceExact: null }), 0);
/* A failing damage call is still null, not a partial object. */
check('a failed damage call is still null',
  stubbed(KO_ON, { failed: true }) === null);

/* ------------------------------------------------------------------ report */

console.log('');
if (failures.length) {
  console.error('FAILED: ' + failures.length + ' of ' + (passed + failures.length) + ' checks');
  failures.forEach(function (f) { console.error('  - ' + f); });
  process.exit(1);
}
console.log('ALL QUIESCENCE CHECKS PASSED (' + passed + ')');
process.exit(0);
