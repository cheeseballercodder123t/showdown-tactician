/* Showdown Tactician — tests/upgrades_check.js
 *
 * Run me with:  node tests/upgrades_check.js
 *
 * WHAT THIS IS
 *   The regression suite for the engine upgrades: the mixed-strategy (fictitious play) solver in
 *   laplace_core.js and the three new blunder vetoes in veto_guard.js (contact suicide, the
 *   Sucker Punch setup trap, and re-clicking Trick Room while it is up).
 *
 *   It is deliberately split in two halves:
 *     1. the solver against matrices with an ANALYTIC equilibrium, so "does it converge" is a
 *        question about mathematics rather than about a battle fixture;
 *     2. the engine + veto layer through the real pipeline, so the wiring is covered too.
 *
 *   Later sections (7-9) cover the two telemetry/inference upgrades: the opponent deliberation
 *   clock (src/opponent_clock.js, driven here with injected timestamps so it is deterministic)
 *   and the reverse damage deduction (src/set_pruner.js, driven through real protocol lines).
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about a real browser, and no claim about win rate: an AUC or an agreement rate needs
 *   a replay corpus this repository does not ship (see BUGS_AUDIT_REPORT.md / README). In
 *   particular the clock's `fastMs`/`slowMs` thresholds and its switch priors are PRIORS - this
 *   suite proves the arithmetic and the wiring, never that a human behaves that way.
 */
'use strict';

const H = require('./harness.js');

const S = H.loadAll();
const ST = S.ST;
const U = ST.util;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; console.log('  PASS ' + name); return true; }
  failed++;
  failures.push(name + (detail === undefined ? '' : '  ->  ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  ->  ' + detail));
  return false;
}
function close(name, got, want, tol) {
  const ok = typeof got === 'number' && isFinite(got) && Math.abs(got - want) <= tol;
  return check(name, ok, 'got ' + got + ', want ' + want + ' (+-' + tol + ')');
}
function eq(name, got, want) {
  return check(name, JSON.stringify(got) === JSON.stringify(want),
    'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

const solve = ST.LaplaceEngine && ST.LaplaceEngine.solveNashFictitiousPlay;
const realCfg = function (path, fallback) {
  return typeof ST.configGet === 'function' ? ST.configGet(path, fallback) : fallback;
};
const ITER = (ST.LaplaceEngine && ST.LaplaceEngine.NASH_ITERATIONS) || 240;
const sum = function (arr) { return arr.reduce(function (a, b) { return a + b; }, 0); };

/* ============================================================ 1. the solver */

section('1. fictitious play finds the mixed equilibrium of a known matrix');

if (typeof solve !== 'function') {
  check('LaplaceEngine.solveNashFictitiousPlay is exported', false);
} else {
  /* Matching pennies: the only equilibrium is 50/50 and the game value is 0.
   * Tolerance is 0.02 because that is what the default budget actually delivers: the worst
   * frequency error over these two fixtures measures 0.06 at 50 rounds, 0.025 at 240 and 0.006
   * at the 2000 that src/config.js ships. A tighter bound would be a lie and a looser one would
   * stop catching a broken best-response step. */
  const pennies = solve([[1, -1], [-1, 1]], ITER);
  close('pennies: our frequencies are 50/50', pennies.myStrategy[0], 0.5, 0.02);
  check('pennies: the opponent mix sums to 1', Math.abs(sum(pennies.oppStrategy) - 1) < 1e-9,
    String(sum(pennies.oppStrategy)));
  close('pennies: the game is worth 0 (value converges faster than the mix)', (function () {
    let v = 0;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      v += pennies.myStrategy[i] * pennies.oppStrategy[j] * [[1, -1], [-1, 1]][i][j];
    }
    return v;
  })(), 0, 0.25);

  /* [[2,-1],[-1,1]]: the column player is indifferent when 3p - 1 == 1 - 2p, i.e. p = 0.4. */
  const biased = solve([[2, -1], [-1, 1]], ITER);
  close('biased 2x2: our frequencies match the analytic 0.4', biased.myStrategy[0], 0.4, 0.02);
  check('biased 2x2: frequencies are a probability distribution',
    Math.abs(sum(biased.myStrategy) - 1) < 1e-9 && biased.myStrategy.every(function (p) { return p >= 0 && p <= 1; }),
    JSON.stringify(biased.myStrategy));

  /* A strictly dominant action must be played essentially always. */
  const dominant = solve([[5, 5], [0, 0]], ITER);
  check('dominant action: frequency collapses onto the dominating row',
    dominant.myStrategy[0] > 0.95, JSON.stringify(dominant.myStrategy));

  /* Every entry must be finite and non-negative, whatever the matrix shape. */
  const rps = solve([[0, -1, 1], [1, 0, -1], [-1, 1, 0]], ITER);
  check('rock-paper-scissors: 3 frequencies, all finite and non-negative',
    rps.myStrategy.length === 3 && rps.myStrategy.every(function (p) { return isFinite(p) && p >= 0; }) &&
    Math.abs(sum(rps.myStrategy) - 1) < 1e-9, JSON.stringify(rps.myStrategy));
  check('rock-paper-scissors: every row value is finite',
    rps.rowValues.length === 3 && rps.rowValues.every(function (v) { return isFinite(v); }),
    JSON.stringify(rps.rowValues));

  /* Determinism: the engine must not jitter between two identical evaluations. */
  eq('the solver is deterministic', solve([[2, -1], [-1, 1]], ITER), biased);

  /* Degenerate shapes must not throw or produce NaN. */
  eq('a 1x1 matrix is a pure strategy', solve([[3]], ITER).myStrategy, [1]);
  eq('an empty matrix returns empty strategies', solve([], ITER).myStrategy, []);
  eq('a zero-iteration request still returns valid strategies',
    solve([[1, -1], [-1, 1]], 0).myStrategy, [1, 0]);
}

/* ===================================================== 2. engine integration */

section('2. the engine reports the equilibrium mix');

const PASTE = [
  'Hatterene @ Leftovers',
  'Ability: Magic Bounce',
  'EVs: 252 HP / 252 SpA / 4 SpD',
  'IVs: 0 Spe',
  'Quiet Nature',
  '- Trick Room',
  '- Psychic',
  '- Dazzling Gleam',
  '- Healing Wish',
  '',
  'Great Tusk @ Choice Scarf',
  'Ability: Protosynthesis',
  'EVs: 252 Atk / 4 SpD / 252 Spe',
  'Jolly Nature',
  '- Headlong Rush',
  '- Close Combat',
  '- Ice Spinner',
  '- Rapid Spin',
  ''
].join('\n');

/** The real pipeline: state manager + parser + our registered team. */
function pipeline(lines) {
  const state = new ST.BattleStateManager({ debug: false });
  const parser = new ST.ProtocolParser();
  state.attachParser(parser);
  state.setFormat('[Gen 9] National Dex OU');
  const parsed = ST.TeamParser.parsePokepaste(PASTE);
  state.registerMyTeam(parsed.pokemon);
  (lines || []).forEach(function (l) { parser.feed(l); });
  return { state: state, parser: parser, battle: state.state || state };
}

function newEngine(opts) {
  const damage = new ST.DamageEngine({ gen: 9 });
  const trickRoom = new ST.TrickRoomEngine(damage);
  const tempo = new ST.TempoEngine({ damage: damage, trickRoom: trickRoom });
  const veto = new ST.BlunderVetoGuard({ damage: damage, trickRoom: trickRoom });
  const sampler = new ST.WorldSampler({ K: 4, database: ST.SetDatabase || null });
  const engine = new ST.LaplaceEngine(Object.assign({
    sampler: sampler, damage: damage, evaluator: new ST.DenseStateEvaluator(),
    tempo: tempo, veto: veto, trickRoom: trickRoom, K: 4
  }, opts || {}));
  return { engine: engine, damage: damage, veto: veto, sampler: sampler };
}

const MATCH = [
  '|switch|p1a: Hatterene|Hatterene, L50, F|100/100',
  '|switch|p2a: Ferrothorn|Ferrothorn, L50, M|100/100',
  '|turn|1',
  '|move|p2a: Ferrothorn|Power Whip|p1a: Hatterene',
  '|-damage|p1a: Hatterene|71/100'
];

const fixture = pipeline(MATCH);
const engineFixture = newEngine();
const ranked = engineFixture.engine.evaluateTurn(fixture.battle);

check('the fixture produced ranked lines', ranked.length > 1, String(ranked.length));
const liveRows = ranked.filter(function (r) { return !r.isVetoed; });
check('every confidence is finite and within 0..100',
  ranked.every(function (r) { return isFinite(r.confidence) && r.confidence >= 0 && r.confidence <= 100; }),
  JSON.stringify(ranked.map(function (r) { return r.confidence; })));
close('the live confidences sum to 100 (it is a probability distribution)', sum(liveRows.map(function (r) { return r.confidence; })), 100, 1e-6);
check('the lines are sorted by confidence', ranked.every(function (r, i) {
  return i === 0 || r.isVetoed || ranked[i - 1].confidence >= r.confidence;
}), JSON.stringify(ranked.map(function (r) { return r.confidence; })));
check('the top line is the highest-frequency line and is marked optimal',
  ranked.length > 0 && !ranked[0].isVetoed && ranked[0].isOptimal === true &&
  ranked[0].confidence === Math.max.apply(null, liveRows.map(function (r) { return r.confidence; })));
check('live rows expose nashFrequency, which is confidence / 100',
  liveRows.every(function (r) { return isFinite(r.nashFrequency) && Math.abs(r.nashFrequency * 100 - r.confidence) < 1e-9; }),
  JSON.stringify(liveRows.map(function (r) { return r.nashFrequency; })));
check('each live line carries a finite expected payoff',
  liveRows.every(function (r) { return isFinite(r.score); }),
  JSON.stringify(liveRows.map(function (r) { return r.score; })));

const again = engineFixture.engine.evaluateTurn(fixture.battle);
eq('two evaluations of the same position return the same mix',
  again.map(function (r) { return [r.kind, r.moveId || r.targetId, r.confidence]; }),
  ranked.map(function (r) { return [r.kind, r.moveId || r.targetId, r.confidence]; }));

/* The legacy path must survive behind the flag (and stay NaN-free at a sharp temperature). */
const legacy = newEngine({ nash: { enabled: false } });
const legacyRanked = legacy.engine.evaluateTurn(fixture.battle, { temperature: 1 });
const legacyLive = legacyRanked.filter(function (r) { return !r.isVetoed; });
check('nash.enabled=false still returns finite confidences at temperature 1',
  legacyRanked.every(function (r) { return isFinite(r.confidence) && r.confidence >= 0 && r.confidence <= 100; }),
  JSON.stringify(legacyRanked.map(function (r) { return r.confidence; })));
close('nash.enabled=false still sums to 100 (the softmax path)', sum(legacyLive.map(function (r) { return r.confidence; })), 100, 1.5);
check('the legacy path does not set nashFrequency',
  legacyLive.every(function (r) { return r.nashFrequency === undefined; }),
  JSON.stringify(legacyLive.map(function (r) { return r.nashFrequency; })));

/* A config merge must reach a newly constructed engine (Rule 4). */
ST.configMerge({ laplace: { nash: { iterations: 64 } } });
const merged = newEngine();
eq('a new engine takes nash.iterations from the config', merged.engine.nash.iterations, 64);
ST.configMerge({ laplace: { nash: { iterations: ITER } } });
eq('the original iteration count is restored', newEngine().engine.nash.iterations, ITER);

/* ============================== 3. a vetoed line must not absorb Nash frequency */

section('3. a vetoed line is excluded from the equilibrium solve');

const trFixture = pipeline([
  '|switch|p1a: Hatterene|Hatterene, L50, F|100/100',
  '|switch|p2a: Ferrothorn|Ferrothorn, L50, M|100/100',
  '|turn|1',
  '|-fieldstart|move: Trick Room|[of] p1a: Hatterene'
]);
check('the fixture has Trick Room up', !!(trFixture.battle.field && trFixture.battle.field.trickRoom),
  JSON.stringify(trFixture.battle.field && trFixture.battle.field.trickRoom));
const trEngine = newEngine();
const trRanked = trEngine.engine.evaluateTurn(trFixture.battle);
const trLine = trRanked.find(function (r) { return U.toID(r.moveId || r.name || '') === 'trickroom'; });
check('re-clicking Trick Room is vetoed', !!trLine && trLine.isVetoed === true &&
  trLine.vetoCode === 'TR_SELF_CANCEL', JSON.stringify(trLine && { v: trLine.isVetoed, c: trLine.vetoCode }));
check('the vetoed Trick Room line has zero confidence', !!trLine && trLine.confidence === 0);
const trLive = trRanked.filter(function (r) { return !r.isVetoed; });
check('the remaining lines still carry the whole distribution',
  trLive.length > 0 && Math.abs(sum(trLive.map(function (r) { return r.confidence; })) - 100) < 1e-6,
  String(sum(trLive.map(function (r) { return r.confidence; }))));
check('no vetoed line has a nashFrequency',
  trRanked.filter(function (r) { return r.isVetoed; }).every(function (r) { return r.nashFrequency === undefined; }));

/* ================================================= 4. VETO5 — contact suicide */

section('4. VETO5 refuses a contact move that the recoil would finish');

const contactState = function (myHp, opts) {
  const o = opts || {};
  return {
    turn: 5,
    field: { trickRoom: false },
    active: {
      my: {
        species: 'Kingambit', id: 'kingambit', nature: 'Adamant', level: 100, item: 'Leftovers',
        ability: 'Supreme Overlord', evs: { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 },
        ivs: U.DEFAULT_IVS, boosts: {}, revealedMoves: ['Kowtow Cleave', 'Sucker Punch'],
        setMoves: ['Kowtow Cleave', 'Sucker Punch', 'Swords Dance', 'Iron Head'],
        fainted: false, hp: myHp, hpPercent: myHp
      },
      opp: {
        species: o.species || 'Ferrothorn', id: U.toID(o.species || 'Ferrothorn'), nature: 'Relaxed',
        level: 100, item: o.item || '', revealedAbility: o.ability || '', evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 },
        ivs: U.DEFAULT_IVS, boosts: {}, revealedMoves: ['Power Whip', 'Gyro Ball'],
        setMoves: ['Power Whip', 'Gyro Ball', 'Stealth Rock', 'Leech Seed'],
        fainted: false, hp: o.hp === undefined ? 100 : o.hp, hpPercent: o.hp === undefined ? 100 : o.hp
      }
    },
    myTeam: [], bench: { my: [], opp: [] }
  };
};
const contactVeto = newEngine().veto;
const v5 = contactVeto.evaluateVetoes({ kind: 'move', name: 'Kowtow Cleave', moveId: 'kowtowcleave' }, contactState(10, { ability: 'Iron Barbs' }), { v4: 0.1 });
check('a 10% body clicking contact into Iron Barbs is vetoed', v5.isVetoed === true && v5.code === 'CONTACT_SUICIDE', JSON.stringify(v5));
check('the veto reason names the punishment and our HP', /iron barbs|rough skin|rocky helmet/i.test(v5.reason || '') && /10/.test(v5.reason || ''), v5.reason);
const v5b = contactVeto.evaluateVetoes({ kind: 'move', name: 'Kowtow Cleave', moveId: 'kowtowcleave' }, contactState(10, { item: 'Rocky Helmet' }), { v4: 0.1 });
check('a Rocky Helmet alone can also finish us', v5b.isVetoed === true && v5b.code === 'CONTACT_SUICIDE', JSON.stringify(v5b));
const v5c = contactVeto.evaluateVetoes({ kind: 'move', name: 'Kowtow Cleave', moveId: 'kowtowcleave' }, contactState(10, { ability: 'Iron Barbs', item: 'Rocky Helmet' }), { v4: 0.1 });
check('both punishers stack (the ~29% case)', v5c.isVetoed === true, JSON.stringify(v5c));
const v5d = contactVeto.evaluateVetoes({ kind: 'move', name: 'Earthquake', moveId: 'earthquake' }, contactState(10, { ability: 'Iron Barbs' }), { v4: 0.1 });
check('a non-contact move is exempt', v5d.isVetoed === false, JSON.stringify(v5d));
const v5e = contactVeto.evaluateVetoes({ kind: 'move', name: 'Kowtow Cleave', moveId: 'kowtowcleave' }, contactState(80, { ability: 'Iron Barbs' }), { v4: 0.1 });
check('a healthy body is not refused contact', v5e.isVetoed === false, JSON.stringify(v5e));
const v5f = contactVeto.evaluateVetoes({ kind: 'move', name: 'Kowtow Cleave', moveId: 'kowtowcleave' }, contactState(10, {}), { v4: 0.1 });
check('an unknown ability/item is never assumed (no veto)', v5f.isVetoed === false, JSON.stringify(v5f));
const v5g = contactVeto.evaluateVetoes({ kind: 'move', name: 'Kowtow Cleave', moveId: 'kowtowcleave' }, contactState(10, { ability: 'Iron Barbs', hp: 3 }), { v4: 0.1 });
check('a move that KOs never triggers the recoil (no veto)', v5g.isVetoed === false, JSON.stringify(v5g));
check('Kowtow Cleave is actually a contact move (fixture sanity)', !!(U.getMoveData('Kowtow Cleave') || {}).makesContact);
check('Earthquake is actually a non-contact move (fixture sanity)', U.getMoveData('Earthquake').makesContact === false);

/* ============================================== 5. VETO6 — Sucker Punch trap */

section('5. VETO6 refuses a SECOND Sucker Punch into a healthy setup mon');

const suckerState = function (opts) {
  const o = opts || {};
  const st = contactState(90, {});
  st.active.my.lastMove = o.lastMove === undefined ? 'Sucker Punch' : o.lastMove;
  st.active.my.lastMoveTurn = o.lastMoveTurn === undefined ? 4 : o.lastMoveTurn;
  st.active.my.setMoves = ['Kowtow Cleave', 'Sucker Punch', 'Swords Dance', 'Iron Head'];
  st.active.opp.hp = o.hp === undefined ? 90 : o.hp;
  st.active.opp.hpPercent = st.active.opp.hp;
  st.active.opp.revealedMoves = o.revealedMoves || ['Swords Dance', 'Power Whip'];
  st.active.opp.setMoves = o.setMoves || st.active.opp.revealedMoves;
  return st;
};
const v6 = contactVeto.evaluateVetoes({ kind: 'move', name: 'Sucker Punch', moveId: 'suckerpunch' }, suckerState({}), { v4: 0.1 });
check('a consecutive Sucker Punch into a healthy setup mon is vetoed', v6.isVetoed === true && v6.code === 'SUCKER_PUNCH_SETUP', JSON.stringify(v6));
const v6b = contactVeto.evaluateVetoes({ kind: 'move', name: 'Sucker Punch', moveId: 'suckerpunch' },
  suckerState({ lastMove: 'Kowtow Cleave' }), { v4: 0.1 });
check('the FIRST Sucker Punch is a legitimate read (no veto)', v6b.isVetoed === false, JSON.stringify(v6b));
const v6c = contactVeto.evaluateVetoes({ kind: 'move', name: 'Sucker Punch', moveId: 'suckerpunch' },
  suckerState({ hp: 45 }), { v4: 0.1 });
check('a chipped target attacks back (no veto)', v6c.isVetoed === false, JSON.stringify(v6c));
const v6d = contactVeto.evaluateVetoes({ kind: 'move', name: 'Sucker Punch', moveId: 'suckerpunch' },
  suckerState({ revealedMoves: ['Power Whip', 'Gyro Ball'], setMoves: ['Power Whip', 'Gyro Ball'] }), { v4: 0.1 });
check('a proven all-attack set (no status move anywhere) is not vetoed', v6d.isVetoed === false, JSON.stringify(v6d));
const v6e = contactVeto.evaluateVetoes({ kind: 'move', name: 'Sucker Punch', moveId: 'suckerpunch' },
  suckerState({ lastMoveTurn: 0 }), { v4: 0.1 });
check('a stale lastMove from an earlier stint is not "consecutive"', v6e.isVetoed === false, JSON.stringify(v6e));
const v6f = contactVeto.evaluateVetoes({ kind: 'move', name: 'Kowtow Cleave', moveId: 'kowtowcleave' },
  suckerState({}), { v4: 0.1 });
check('a different move is not Sucker Punch', v6f.isVetoed === false, JSON.stringify(v6f));
const v6g = contactVeto.evaluateVetoes({ kind: 'move', name: 'Sucker Punch', moveId: 'suckerpunch' },
  suckerState({ revealedMoves: ['Recover'], setMoves: ['Recover'] }), { v4: 0.1 });
check('a proven recovery move also defeats Sucker Punch', v6g.isVetoed === true, JSON.stringify(v6g));

/* ================================================ 6. VETO7 — self-cancel TR */

section('6. VETO7 refuses Trick Room while Trick Room is up');

const trOn = contactState(90, {});
trOn.field = { trickRoom: true, trickRoomTurnsLeft: 4 };
const v7 = contactVeto.evaluateVetoes({ kind: 'move', name: 'Trick Room', moveId: 'trickroom' }, trOn, { v4: 0.1 });
check('Trick Room while it is active is vetoed', v7.isVetoed === true && v7.code === 'TR_SELF_CANCEL', JSON.stringify(v7));
check('the reason says it fails rather than cancels', /fails/i.test(v7.reason || ''), v7.reason);
const v7b = contactVeto.evaluateVetoes({ kind: 'move', name: 'Trick Room', moveId: 'trickroom' }, contactState(90, {}), { v4: 0.1 });
check('Trick Room with the room down is allowed', v7b.isVetoed === false, JSON.stringify(v7b));
const v7c = contactVeto.evaluateVetoes({ kind: 'move', name: 'Psychic', moveId: 'psychic' }, trOn, { v4: 0.1 });
check('another move while TR is up is untouched by this veto', v7c.isVetoed === false, JSON.stringify(v7c));
const v7d = contactVeto.evaluateVetoes({ kind: 'switch', name: 'Great Tusk', targetId: 'Great Tusk' }, trOn, { v4: 0.1 });
check('a switch while TR is up is untouched by this veto', v7d.isVetoed === false, JSON.stringify(v7d));

/* ======================================= 7. the opponent deliberation clock */

section('7. the clock measures deliberation and learns its own noise floor');

const REQUEST = '|request|{"active":[]}';
const CHOOSE = '/choose move 1';

/** A window: the server opens it, we submit, and the turn resolves at `resolveTs`. */
function window(clock, opts) {
  clock.note(REQUEST, 'recv', opts.requestTs);
  clock.note(CHOOSE, 'send', opts.submitTs);
  if (opts.chooseTwice) clock.note(CHOOSE, 'send', opts.submitTs + 50);
  if (opts.resolveLine) clock.note(opts.resolveLine, 'recv', opts.resolveTs);
  else clock.note('|turn|' + opts.turn, 'recv', opts.resolveTs);
  return clock;
}

const clk = new ST.OpponentClock({ now: function () { return 0; } });
check('the clock starts with no opinion', clk.label() === 'unknown' && clk.switchFactor() === 1 && clk.snapshot().samples === 0, JSON.stringify(clk.snapshot()));

window(clk, { requestTs: 1000, submitTs: 5000, turn: 2, resolveTs: 5100 });
close('the first window learns the floor (100 ms of network + resolution)', clk.floorMs, 100, 1e-9);
close('the raw wait after our submit is the lead', clk.last.leadMs, 100, 1e-9);
close('nothing above the floor, so extra deliberation is 0', clk.last.extraMs, 0, 1e-9);
close('our own deliberation is measured from the request', clk.last.mySubmitMs, 4000, 1e-9);
check('one sample is not enough to label anything', clk.last.label === 'unknown' && clk.label() === 'unknown', clk.last.label);
check('an unlabelled clock does not tilt the solver (unknown prior = 1)', clk.switchFactor() === 1, String(clk.switchFactor()));

window(clk, { requestTs: 6000, submitTs: 20000, turn: 3, resolveTs: 20200 });
close('the floor only ever ratchets DOWN to the smallest lead', clk.floorMs, 100, 1e-9);
close('a lead barely above the floor is 100 ms of deliberation', clk.last.extraMs, 100, 1e-9);
check('a near-instant answer reads as auto-pilot', clk.last.label === 'auto', clk.last.label);
check('auto-pilot applies the configured switch prior (0.25 from config)', clk.switchFactor() === realCfg('clock.switchPrior.auto', 0.25), String(clk.switchFactor()));

window(clk, { requestTs: 21000, submitTs: 22000, turn: 4, resolveTs: 50000 });
close('a turn that resolved 27.9 s after our submit is 27.9 s of deliberation', clk.last.extraMs, 27900, 1e-9);
check('burning the timer reads as agonising', clk.last.label === 'agonised', clk.last.label);
check('the agonised prior comes from config too', clk.switchFactor() === realCfg('clock.switchPrior.agonised', 1.6), String(clk.switchFactor()));
const snap = clk.snapshot();
eq('the snapshot counts every completed window', snap.samples, 3);
close('the snapshot keeps the learned floor', snap.floorMs, 100, 1e-9);
close('the snapshot reports the mean extra deliberation', snap.meanMs, Math.round((0 + 100 + 27900) / 3), 1e-9);
check('the snapshot is a plain copy, not a live view', clk.snapshot() !== clk.snapshot(), 'same object twice');
check('describe() names the label and the floor', /agonised/.test(clk.describe()) && /floor/.test(clk.describe()), clk.describe());

/* A |move| line resolves the window just as the next |turn| header does. */
const clk2 = new ST.OpponentClock({ now: function () { return 0; } });
window(clk2, { requestTs: 0, submitTs: 100, turn: 2, resolveTs: 900, resolveLine: '|move|p2a: Ferrothorn|Power Whip|p1a: Hatterene' });
eq('an action line closes the window', clk2.snapshot().samples, 1);
close('the lead is measured from the action line', clk2.last.leadMs, 800, 1e-9);

/* A repeated /choose (a mirrored poll line) must not move the submit timestamp. */
const clk3 = new ST.OpponentClock({ now: function () { return 0; } });
window(clk3, { requestTs: 0, submitTs: 100, turn: 2, resolveTs: 5000, chooseTwice: true });
close('the FIRST /choose wins over a duplicate', clk3.last.mySubmitMs, 100, 1e-9);
close('a duplicate submit does not shorten the lead', clk3.last.leadMs, 4900, 1e-9);

/* Junk, a disabled clock and reset() are all inert. */
const before = clk.snapshot().samples;
clk.note('hello there', 'recv', 999999);
clk.note('|foo|bar', 'recv', 999999);
clk.note('', 'recv', 999999);
clk.note(null, 'recv', 999999);
eq('junk lines change nothing', clk.snapshot().samples, before);
const off = new ST.OpponentClock({ enabled: false, now: function () { return 0; } });
window(off, { requestTs: 0, submitTs: 100, turn: 2, resolveTs: 900 });
eq('a disabled clock records nothing', off.snapshot().samples, 0);
check('a disabled clock has no effect on the solver', off.switchFactor() === 1, String(off.switchFactor()));
clk.reset();
eq('reset() empties the history', clk.snapshot().samples, 0);
check('reset() forgets the label and the floor', clk.label() === 'unknown' && clk.floorMs === null, JSON.stringify(clk.snapshot()));
check('every factor in clock.switchPrior is a positive number (config sanity)',
  ['auto', 'normal', 'agonised', 'unknown'].every(function (k) {
    const v = realCfg('clock.switchPrior.' + k);
    return typeof v === 'number' && isFinite(v) && v > 0;
  }));

/* ==================== 8. the clock is allowed to change exactly one thing */

section('8. a fast opponent loses its pivot replies, and nothing else moves');

const oppWorld = {
  id: 'w0', weight: 1,
  team: [
    { species: 'Ferrothorn', isActive: true, setMoves: ['Power Whip', 'Gyro Ball', 'Stealth Rock', 'Leech Seed'] },
    { species: 'Great Tusk', isActive: false },
    { species: 'Gholdengo', isActive: false }
  ]
};
const priorEngine = newEngine().engine;
const baseState = { field: { trickRoom: false }, turn: 3 };
const baseActions = priorEngine.getOppActions(oppWorld, baseState);
check('a world with a bench offers switch replies (the baseline)', baseActions.some(function (a) { return a.kind === 'switch'; }),
  JSON.stringify(baseActions.map(function (a) { return a.kind; })));
check('the baseline keeps the switches', priorEngine.lastOppPrior.keepSwitchReplies === true, JSON.stringify(priorEngine.lastOppPrior));

const fastState = { field: { trickRoom: false }, turn: 3, clock: { enabled: true, label: 'auto', switchFactor: realCfg('clock.switchPrior.auto', 0.25), samples: 4 } };
const fastActions = priorEngine.getOppActions(oppWorld, fastState);
check('an auto-piloting opponent loses every switch reply',
  fastActions.length > 0 && fastActions.every(function (a) { return a.kind !== 'switch'; }),
  JSON.stringify(fastActions.map(function (a) { return a.kind + ':' + a.name; })));
check('...and its attacks are untouched',
  fastActions.filter(function (a) { return a.kind !== 'switch'; }).length ===
  baseActions.filter(function (a) { return a.kind !== 'switch'; }).length,
  String(fastActions.length));
check('the prior is published on the engine for the HUD',
  priorEngine.lastOppPrior.keepSwitchReplies === false && priorEngine.lastOppPrior.label === 'auto', JSON.stringify(priorEngine.lastOppPrior));

const normalState = { field: { trickRoom: false }, turn: 3, clock: { enabled: true, label: 'normal', switchFactor: 1, samples: 4 } };
check('a normal reading keeps the pivots',
  priorEngine.getOppActions(oppWorld, normalState).some(function (a) { return a.kind === 'switch'; }));
const agonisedState = { field: { trickRoom: false }, turn: 3, clock: { enabled: true, label: 'agonised', switchFactor: realCfg('clock.switchPrior.agonised', 1.6), samples: 4 } };
check('an agonising opponent keeps the pivots too (the engine already enumerates them)',
  priorEngine.getOppActions(oppWorld, agonisedState).some(function (a) { return a.kind === 'switch'; }));
const disabledState = { field: { trickRoom: false }, turn: 3, clock: { enabled: false, label: 'auto', switchFactor: 0.25 } };
check('a disabled snapshot changes nothing',
  priorEngine.getOppActions(oppWorld, disabledState).some(function (a) { return a.kind === 'switch'; }));
check('the keep-threshold lives in the config',
  typeof realCfg('clock.switchKeepThreshold') === 'number' && realCfg('clock.switchKeepThreshold') > 0,
  String(realCfg('clock.switchKeepThreshold')));

/* The same reading through the real loop: the readout must carry it. */
const clockReadoutEngine = newEngine().engine;
const clockFixture = pipeline(MATCH);
clockFixture.battle.clock = { enabled: true, label: 'auto', switchFactor: 0.25, samples: 4, floorMs: 120 };
clockReadoutEngine.evaluateTurn(clockFixture.battle);
check('evaluateTurn publishes the clock prior in its readout',
  !!clockReadoutEngine.lastReadout.clock && clockReadoutEngine.lastReadout.clock.keepSwitchReplies === false &&
  clockReadoutEngine.lastReadout.clock.label === 'auto',
  JSON.stringify(clockReadoutEngine.lastReadout.clock));
const quietFixture = pipeline(MATCH);
const quietEngine = newEngine().engine;
quietEngine.evaluateTurn(quietFixture.battle);
check('a battle with no telemetry keeps every reply (no silent regression)',
  quietEngine.lastReadout.clock.keepSwitchReplies === true && quietEngine.lastReadout.clock.label === 'unknown',
  JSON.stringify(quietEngine.lastReadout.clock));

/* ==================== 8b. choice-lock physics, both directions */

section('8b. a Choice-locked body has ONE move, and locking ourselves in has a price');

{
  const LOCKED = {
    id: 'wlock', weight: 1,
    team: [
      { species: 'Great Tusk', isActive: true, item: 'Choice Scarf',
        activeStintMoves: ['Headlong Rush'], activeStintCount: 1,
        setMoves: ['Headlong Rush', 'Close Combat', 'Rapid Spin', 'Knock Off'] },
      { species: 'Gholdengo', isActive: false, item: 'Air Balloon', setMoves: [] }
    ]
  };
  const eng = newEngine().engine;
  const lockedActs = eng.getOppActions(LOCKED, { field: { trickRoom: false }, turn: 5 });
  eq('a locked body offers ONLY the move it is locked into',
    lockedActs.filter(function (a) { return a.kind !== 'switch'; }).map(function (a) { return a.name; }),
    ['Headlong Rush']);
  check('...and its switches are still on the menu (a lock is not a trap)',
    lockedActs.some(function (a) { return a.kind === 'switch'; }),
    JSON.stringify(lockedActs.map(function (a) { return a.kind; })));

  const noLock = newEngine({ choiceLock: { enabled: false } }).engine;
  eq('with the tier off the full four-move menu comes back',
    noLock.getOppActions(LOCKED, { field: {} }).filter(function (a) { return a.kind !== 'switch'; }).length, 4);
  eq('...and oppLock:false does the same on its own',
    newEngine({ choiceLock: { oppLock: false } }).engine
      .getOppActions(LOCKED, { field: {} }).filter(function (a) { return a.kind !== 'switch'; }).length, 4);

  const twoMoves = JSON.parse(JSON.stringify(LOCKED));
  twoMoves.team[0].activeStintMoves = ['Headlong Rush', 'Close Combat'];
  eq('a SECOND distinct move disproves the lock (the item is not Choice after all)',
    eng.getOppActions(twoMoves, { field: {} }).filter(function (a) { return a.kind !== 'switch'; }).length, 4);

  const free = JSON.parse(JSON.stringify(LOCKED));
  free.team[0].item = 'Leftovers';
  eq('a non-Choice item is not locked',
    eng.getOppActions(free, { field: {} }).filter(function (a) { return a.kind !== 'switch'; }).length, 4);

  const disproven = JSON.parse(JSON.stringify(LOCKED));
  disproven.team[0].cannotBeChoice = true;
  eq('evidence against Choice (cannotBeChoice) keeps the menu',
    eng.getOppActions(disproven, { field: {} }).filter(function (a) { return a.kind !== 'switch'; }).length, 4);

  const stale = JSON.parse(JSON.stringify(LOCKED));
  stale.team[0].setMoves = ['Close Combat', 'Rapid Spin'];
  eq('a stint move the sampled world does not believe it owns cannot become the only column',
    eng.getOppActions(stale, { field: {} }).filter(function (a) { return a.kind !== 'switch'; }).length, 2);
}

{
  /* OUR HALF. A locked body's cost is concrete when their bench takes 0 from the click. */
  const POINTS = realCfg('laplace.choiceLock.riskPenalty', 60);
  const myBody = function (extra) {
    return Object.assign({
      species: 'Great Tusk', isActive: true, item: 'Choice Band', cannotBeChoice: false,
      activeStintMoves: [], liveSet: null,
      setMoves: ['Earthquake', 'Close Combat', 'Rapid Spin', 'Stealth Rock'], evs: {}, ivs: {}
    }, extra || {});
  };
  const EQ = { kind: 'move', name: 'Earthquake', moveId: 'earthquake' };
  const TOXIC = { kind: 'move', name: 'Toxic', moveId: 'toxic' };
  const U_TURN = { kind: 'move', name: 'U-turn', moveId: 'uturn' };
  const levitate = { species: 'Rotom-Wash', isActive: false, fainted: false, revealedAbility: 'Levitate', setMoves: [] };
  const ground = { species: 'Gholdengo', isActive: false, fainted: false, setMoves: [] };
  const wing = { species: 'Skarmory', isActive: false, fainted: false, setMoves: [] };
  const worldWith = function (body) { return { team: [{ species: 'Hatterene', isActive: true, setMoves: [] }, body] }; };
  const eng = newEngine().engine;
  check('the shipped penalty is a positive number', typeof POINTS === 'number' && POINTS > 0, String(POINTS));
  eq('a Levitate body on their bench charges the click',
    eng._choiceLockRisk(EQ, myBody(), null, worldWith(levitate)), POINTS);
  eq('...as does a type-chart immunity (a Flying body vs Ground)',
    eng._choiceLockRisk(EQ, myBody(), null, worldWith(wing)), POINTS);
  eq('a bench that merely resists it charges nothing',
    eng._choiceLockRisk(EQ, myBody(), null, worldWith(ground)), 0);
  eq('an unrevealed body is never assumed immune',
    eng._choiceLockRisk(EQ, myBody(), null, worldWith({ species: 'Rotom-Wash', isActive: false, fainted: false })), 0);
  eq('a status move carries no type-immunity risk',
    eng._choiceLockRisk(TOXIC, myBody(), null, worldWith(wing)), 0);
  eq('a pivot is not locked into the fight it is leaving',
    eng._choiceLockRisk(U_TURN, myBody(), null, worldWith(wing)), 0);
  eq('a body already locked in has already paid it',
    eng._choiceLockRisk(EQ, myBody({ activeStintMoves: ['Earthquake'] }), null, worldWith(levitate)), 0);
  eq('a non-Choice holder pays nothing',
    eng._choiceLockRisk(EQ, myBody({ item: 'Leftovers' }), null, worldWith(levitate)), 0);
  eq('a disproven Choice item pays nothing',
    eng._choiceLockRisk(EQ, myBody({ cannotBeChoice: true }), null, worldWith(levitate)), 0);
  eq('the whole tier off pays nothing',
    newEngine({ choiceLock: { enabled: false } }).engine
      ._choiceLockRisk(EQ, myBody(), null, worldWith(levitate)), 0);

  /* The hook itself: the same cell, priced twice, differs by EXACTLY the penalty. */
  const fixture = pipeline(MATCH);
  const battle = fixture.battle;
  battle.active.my.item = 'Choice Band';
  battle.active.my.activeStintMoves = [];
  const oppAct = { kind: 'move', name: 'Power Whip', moveId: 'powerwhip' };
  const risky = newEngine({ choiceLock: { riskPenalty: POINTS } }).engine;
  const safe = newEngine({ choiceLock: { riskPenalty: 0 } }).engine;
  const offEngine = newEngine({ choiceLock: { enabled: false } }).engine;
  const a = risky._payoff(EQ, oppAct, battle, battle.field, worldWith(levitate));
  const b = safe._payoff(EQ, oppAct, battle, battle.field, worldWith(levitate));
  const c = offEngine._payoff(EQ, oppAct, battle, battle.field, worldWith(levitate));
  close('the payoff hook charges exactly the configured penalty', b - a, POINTS, 1e-9);
  close('...and the tier off is the unpenalised cell exactly', c, b, 1e-9);
}

/* ===================== 9. reverse damage deduction (live EV solving) */

section('9. the state manager records what their hit did to our body');

const atkSet = function (id, evs, nature) {
  return {
    id: id, species: 'Ferrothorn', role: id, item: 'Leftovers', ability: 'Iron Barbs',
    nature: nature, evs: evs, ivs: U.DEFAULT_IVS,
    moves: ['Power Whip', 'Gyro Ball', 'Stealth Rock', 'Leech Seed'],
    weight: 0.5, tags: ['phys'], isMega: false, isZCrystal: false, itemlessArchetype: false
  };
};
const STRONG = atkSet('phys-252', { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 }, 'Adamant');
const WEAK = atkSet('phys-0', { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 }, 'Bold');

/* The two spreads are measured FIRST, against the same Hatterene the fixture will register, so
 * the protocol line below is derived from the real calculation instead of a magic number. */
const OPENING = [
  '|switch|p1a: Hatterene|Hatterene, L50, F|100/100',
  '|switch|p2a: Ferrothorn|Ferrothorn, L50, M|100/100',
  '|turn|1'
];
const bootFixture = pipeline(OPENING);
const myMon = bootFixture.battle.myTeam.find(function (m) { return m && U.toID(m.species) === 'hatterene'; });
const probe = new ST.DamageEngine({ gen: 9 });
const rollStrong = probe.calculateDamage(STRONG, myMon, 'Power Whip', bootFixture.battle.field, { attackerIsP1: false });
const rollWeak = probe.calculateDamage(WEAK, myMon, 'Power Whip', bootFixture.battle.field, { attackerIsP1: false });
check('the two spreads really do produce different ranges (fixture sanity)',
  !rollStrong.failed && !rollWeak.failed && rollStrong.maxPercent > rollWeak.maxPercent + 10,
  JSON.stringify({ strong: [rollStrong.minPercent, rollStrong.maxPercent], weak: [rollWeak.minPercent, rollWeak.maxPercent] }));

const HIT = Math.round(rollStrong.maxPercent);              // a hit at the top of the 252 range
const SOFT = Math.round(rollWeak.minPercent);               // a hit at the bottom of the 0 range
const CRIT = Math.min(HIT, 42);                              // a critical hit on top of it
const dmgLine = function (hpAfter, label) {
  return '|-damage|p1a: Hatterene|' + hpAfter + '/100|[from] move: ' + label + ' [of] p2a: Ferrothorn';
};
const dmgLines = OPENING.concat([
  '|move|p2a: Ferrothorn|Power Whip|p1a: Hatterene',
  dmgLine(100 - HIT, 'Power Whip')
]);
const bare = new ST.ProtocolParser();
const bareEvent = bare.feed(dmgLine(100 - HIT, 'Power Whip'));
check('the clause splitter keeps the move AND the source',
  /move:\s*Power Whip/i.test(String(bareEvent.from || '')) && U.toID(bareEvent.ofRaw || '') === 'p2aferrothorn',
  JSON.stringify({ from: bareEvent.from, ofRaw: bareEvent.ofRaw }));

const dmgFixture = pipeline(dmgLines);
const ferro = dmgFixture.battle.oppTeam.find(function (m) { return m && U.toID(m.species) === 'ferrothorn'; });
check('the attacker was found and the observation recorded',
  !!ferro && Array.isArray(ferro.damageDealt) && ferro.damageDealt.length === 1,
  JSON.stringify(ferro && ferro.damageDealt));
const obs = ferro && ferro.damageDealt[0];
check('the observed damage is the HP that actually left our mon', !!obs && obs.damagePercent === HIT, JSON.stringify({ seen: obs && obs.damagePercent, want: HIT }));
check('the observation names the move and the ruler', !!obs && obs.moveId === 'powerwhip' && obs.defenderId === 'hatterene', JSON.stringify(obs && { m: obs.moveId, d: obs.defenderId }));
check('the attacker side is read off the ident, not assumed', !!obs && obs.attackerIsP1 === false, String(obs && obs.attackerIsP1));
check('a non-critical hit is not flagged as one', !!obs && obs.crit === false, String(obs && obs.crit));
const dmgVictim = dmgFixture.battle.myTeam.find(function (m) { return m && U.toID(m.species) === 'hatterene'; });
check('the victim does NOT carry the observation (the attacker does)',
  !!dmgVictim && !(dmgVictim.damageDealt && dmgVictim.damageDealt.length), JSON.stringify(dmgVictim && dmgVictim.damageDealt));

/* A critical hit is recorded but marked, and a repeated line is not double counted. */
const critHp = Math.max(1, 100 - HIT - CRIT);
dmgFixture.parser.feed('|-crit|p1a: Hatterene');
dmgFixture.parser.feed(dmgLine(critHp, 'Power Whip'));
const critObs = ferro.damageDealt[ferro.damageDealt.length - 1];
check('a critical hit is flagged as such',
  !!critObs && critObs.crit === true && critObs.damagePercent === (100 - HIT) - critHp,
  JSON.stringify(critObs && { crit: critObs.crit, dmg: critObs.damagePercent, want: (100 - HIT) - critHp }));
dmgFixture.parser.feed(dmgLine(critHp, 'Power Whip'));
eq('an identical re-read is not stored twice', ferro.damageDealt.length, 2);

/* Residual damage is never evidence: no `move:` clause, no attacker. */
const residualFixture = pipeline(OPENING.concat([
  '|-damage|p1a: Hatterene|87/100|[from] Stealth Rock',
  '|-damage|p2a: Ferrothorn|88/100|[from] item: Rocky Helmet|[of] p1a: Hatterene'
]));
const residualFerro = residualFixture.battle.oppTeam.find(function (m) { return m && U.toID(m.species) === 'ferrothorn'; });
eq('hazard and recoil damage yield no observation', (residualFerro.damageDealt || []).length, 0);

section('10. the pruner drops sets the observed hit rules out');

const pruner = new ST.ArchetypePruner({ damage: new ST.DamageEngine({ gen: 9 }) });

/** A fresh attacker whose pool is exactly [STRONG, WEAK] and whose hit we observed. */
function attackerWith(observation) {
  const fx = pipeline(dmgLines);
  const mon = fx.battle.oppTeam.find(function (m) { return m && U.toID(m.species) === 'ferrothorn'; });
  mon.candidateSets = [U.deepClone(STRONG), U.deepClone(WEAK)];
  mon.damageDealt = observation ? [Object.assign({}, observation)] : [];
  mon.prunedReasons = [];
  mon.damageVerdictCache = null;
  return mon;
}
const baseObs = {
  turn: 1, moveName: 'Power Whip', moveId: 'powerwhip', damagePercent: HIT,
  hpBefore: 100, hpAfter: 100 - HIT, crit: false, attackerIsP1: false,
  defenderId: 'hatterene', defenderBoosts: {}, defenderStatus: '', weather: '', terrain: '', sig: 'test-strong'
};
const observedPool = pruner.prune(attackerWith(baseObs), dmgFixture.battle);
check('only the spread that can produce the hit survives',
  observedPool.length === 1 && observedPool[0].id === 'phys-252',
  JSON.stringify(observedPool.map(function (s) { return s.id; })));
const explainMon = attackerWith(baseObs);
pruner.prune(explainMon, dmgFixture.battle);
check('the elimination reason is recorded on the mon',
  pruner._reasons(explainMon).some(function (r) { return /offence too low/i.test(r); }),
  JSON.stringify(pruner._reasons(explainMon).slice(-3)));
check('the surviving set becomes the live set (the sampler follows)',
  !!explainMon.liveSet && explainMon.liveSet.id === 'phys-252',
  JSON.stringify(explainMon.liveSet && explainMon.liveSet.id));

/* The other direction: a hit as soft as the uninvested spread's floor eliminates the invested one. */
const softMon = attackerWith(Object.assign({}, baseObs, { damagePercent: SOFT, hpAfter: 100 - SOFT, sig: 'test-soft' }));
const softPool = pruner.prune(softMon, dmgFixture.battle).map(function (s) { return s.id; });
check('a hit that only the uninvested spread can throw drops the invested one',
  softPool.indexOf('phys-0') !== -1 && softPool.indexOf('phys-252') === -1, JSON.stringify(softPool));
check('and that is explained as an offence that is too high',
  pruner._reasons(softMon).some(function (r) { return /offence too high/i.test(r); }),
  JSON.stringify(pruner._reasons(softMon).slice(-3)));

/* The safety valves: a crit, chip damage, an unmodellable move, and an impossible number. */
const critPool = pruner.prune(attackerWith(Object.assign({}, baseObs, { crit: true, sig: 'test-crit' })), dmgFixture.battle);
eq('a critical hit is never used as evidence', critPool.length, 2);
const chipPool = pruner.prune(attackerWith(Object.assign({}, baseObs, { damagePercent: 3, sig: 'test-chip' })), dmgFixture.battle);
eq('chip below the minimum is not evidence', chipPool.length, 2);
const fixedPool = pruner.prune(attackerWith(Object.assign({}, baseObs, { moveName: 'Seismic Toss', moveId: 'seismictoss', sig: 'test-fixed' })), dmgFixture.battle);
eq('a fixed-damage move is skipped', fixedPool.length, 2);
const impossibleMon = attackerWith(Object.assign({}, baseObs, { damagePercent: 999, sig: 'test-impossible' }));
const impossiblePool = pruner.prune(impossibleMon, dmgFixture.battle);
eq('an impossible number discards the observation, not the database', impossiblePool.length, 2);
check('and it says so',
  pruner._reasons(impossibleMon).some(function (r) { return /evidence ignored/i.test(r); }),
  JSON.stringify(pruner._reasons(impossibleMon).slice(-3)));
const noEngine = new ST.ArchetypePruner();
eq('without a damage engine the rule is a no-op, not a crash', noEngine.prune(attackerWith(baseObs), dmgFixture.battle).length, 2);
const twiceMon = attackerWith(baseObs);
const firstPass = pruner.prune(twiceMon, dmgFixture.battle).map(function (s) { return s.id; });
const secondPass = pruner.prune(twiceMon, dmgFixture.battle).map(function (s) { return s.id; });
eq('the rule is idempotent', secondPass, firstPass);

/* The whole way through the real pipeline: the board was never wired by hand. */
const e2e = pipeline(dmgLines);
const e2eFerro = e2e.battle.oppTeam.find(function (m) { return m && U.toID(m.species) === 'ferrothorn'; });
e2eFerro.candidateSets = [U.deepClone(STRONG), U.deepClone(WEAK)];
const e2ePruner = new ST.ArchetypePruner({ damage: new ST.DamageEngine({ gen: 9 }) });
const e2ePool = e2ePruner.prune(e2eFerro, e2e.battle).map(function (s) { return s.id; });
check('the hit the log actually reported eliminates the uninvested spread on its own',
  e2ePool.indexOf('phys-252') !== -1 && e2ePool.indexOf('phys-0') === -1, JSON.stringify(e2ePool));
check('the surviving set is published as the live set',
  !!e2eFerro.liveSet && e2eFerro.liveSet.id === 'phys-252', JSON.stringify(e2eFerro.liveSet && e2eFerro.liveSet.id));
check('the observation the pruner used is the one the parser produced (not a fixture field)',
  Array.isArray(e2eFerro.damageDealt) && e2eFerro.damageDealt.length === 1 && e2eFerro.damageDealt[0].damagePercent === HIT,
  JSON.stringify(e2eFerro.damageDealt));

/* ============================ 11. VETO2 needs a PROOF, and the paradox boost needs to be Speed */

section('11. an ability immunity is vetoed only on a PROOF, and a paradox boost only when it is Speed');

/* A guard with NO damage engine: VETO4/VETO5 then cannot preempt the rule under test, so a green
 * line below can only be the ability rule's own answer. */
const proofVeto = new ST.BlunderVetoGuard({});

/** An opponent whose ability is only ever SUSPECTED, with each proof source opt-in. */
function immuneOpp(opts) {
  const o = opts || {};
  return {
    species: o.species || 'Great Tusk', id: U.toID(o.species || 'Great Tusk'),
    revealedAbility: o.revealedAbility === undefined ? null : o.revealedAbility,
    possibleAbilities: o.possibleAbilities || [],
    candidateSets: o.candidateSets || [],
    boosts: {}, hpPercent: 100, fainted: false
  };
}
function vetoOf(moveName, opp) {
  const st = contactState(90, {});
  st.active.opp = opp;
  return proofVeto.evaluateVetoes({ kind: 'move', name: moveName, moveId: U.toID(moveName) }, st, { v4: 0.1 });
}

/* THE DEFECT THIS PINS: feeding the species' whole `possibleAbilities` pool into immunityReason
 * hard-vetoed a line at -9999 on a 1-in-3 guess, deleting the hedge the world sampler exists to
 * price. Three proofs are accepted and a mere possibility is not. */
const unproven = vetoOf('Earthquake', immuneOpp({ species: 'Hydreigon', possibleAbilities: ['Levitate', 'Hustle', 'Mold Breaker'] }));
check('an UNCONFIRMED immunity ability is not hard-vetoed', unproven.isVetoed === false, JSON.stringify(unproven));
const noPool = vetoOf('Earthquake', immuneOpp({ species: 'Hydreigon', possibleAbilities: [] }));
check('an empty possibility pool definitely does not veto', noPool.isVetoed === false, JSON.stringify(noPool));
const revealed = vetoOf('Earthquake', immuneOpp({ species: 'Hydreigon', revealedAbility: 'Levitate', possibleAbilities: ['Levitate', 'Hustle'] }));
check('proof 1: a REVEALED immunity ability vetoes', revealed.isVetoed === true && revealed.code === 'ABILITY_IMMUNITY', JSON.stringify(revealed));
const sole = vetoOf('Earthquake', immuneOpp({ species: 'Hydreigon', possibleAbilities: ['Levitate'] }));
check('proof 2: the species having ONLY that ability vetoes', sole.isVetoed === true, JSON.stringify(sole));
const agreed = vetoOf('Earthquake', immuneOpp({
  species: 'Hydreigon', possibleAbilities: ['Levitate', 'Hustle'],
  candidateSets: [{ ability: 'Levitate', moves: ['Earth Power'] }, { ability: 'Levitate', moves: ['Dark Pulse'] }]
}));
check('proof 3: every surviving candidate set carrying it vetoes', agreed.isVetoed === true, JSON.stringify(agreed));
const split = vetoOf('Earthquake', immuneOpp({
  species: 'Hydreigon', possibleAbilities: ['Levitate', 'Hustle'],
  candidateSets: [{ ability: 'Levitate' }, { ability: 'Hustle' }]
}));
check('candidate sets that DISAGREE leave the line alone', split.isVetoed === false, JSON.stringify(split));
const flying = vetoOf('Earthquake', immuneOpp({ species: 'Corviknight', possibleAbilities: ['Pressure', 'Mirror Armor', 'Big Pecks'] }));
check('the Flying TYPE still vetoes on its own (no ability proof needed)', flying.isVetoed === true, JSON.stringify(flying));

/* The same proof requirement governs the status half (Good as Gold). */
const gag = vetoOf('Thunder Wave', immuneOpp({ species: 'Gholdengo', possibleAbilities: ['Good as Gold', 'Stall'] }));
check('a status move into an UNCONFIRMED Good as Gold is not vetoed', gag.isVetoed === false, JSON.stringify(gag));
const gagRevealed = vetoOf('Thunder Wave', immuneOpp({ species: 'Gholdengo', revealedAbility: 'Good as Gold' }));
check('...but a REVEALED Good as Gold blocks it', gagRevealed.isVetoed === true && gagRevealed.code === 'ABILITY_IMMUNITY', JSON.stringify(gagRevealed));

/* THE PARADOX STAT. The sim states which stat the boost moved, and that statement must reach the
 * state, or an Attack-boosted Great Tusk is priced at 1.5x Speed (see the audit report). */
const pb = new ST.BattleStateManager();
const pp = new ST.ProtocolParser();
pb.attachParser(pp);
pb.setFormat('[Gen 9] National Dex OU');
pp.feedAll([
  '|player|p1|Me|1|1500', '|player|p2|Foe|2|1480', '|start',
  '|switch|p1a: Corviknight|Corviknight, L50, M|100/100',
  '|switch|p2a: Great Tusk|Great Tusk, L50, M|100/100',
  '|turn|1',
  '|-activate|p2a: Great Tusk|ability: Protosynthesis|[fromitem]',
  '|-start|p2a: Great Tusk|protosynthesisatk'
].join('\n'));
const tusk = (pb.state.oppTeam || []).filter(function (m) { return m && U.toID(m.species) === 'greattusk'; })[0];
check('the fixture actually has the opponent active', !!tusk, JSON.stringify((pb.state.oppTeam || []).map(function (m) { return m.species; })));
check('the ability activation marks the boost active', !!tusk && tusk.boosterActive === true, String(tusk && tusk.boosterActive));
eq('the |start| frame records WHICH stat moved', tusk && tusk.boostedStat, 'atk');
pp.feedAll('|-end|p2a: Great Tusk|Protosynthesis|[silent]');
eq('the |end| frame clears it', tusk.boostedStat, null);
pp.feedAll('|-start|p2a: Great Tusk|protosynthesisspe');
eq('a later activation overwrites it', tusk.boostedStat, 'spe');
pp.feedAll('|switch|p2a: Corviknight|Corviknight, L50, M|100/100');
eq('switching out clears it', tusk.boostedStat, null);
pp.feedAll('|switch|p2a: Great Tusk|Great Tusk, L50, M|100/100');
eq('...and a re-entry starts with no stated stat', tusk.boostedStat, null);

/* The helper itself, then the ordering it feeds. Talonflame's highest stat IS Speed; Great Tusk's is Attack. */
eq('a stated Speed boost counts', U.paradoxSpeedBoost({ species: 'Talonflame', boosterActive: true, boostedStat: 'spe' }, {}), true);
eq('a stated Attack boost does NOT', U.paradoxSpeedBoost({ species: 'Great Tusk', boosterActive: true, boostedStat: 'atk' }, {}), false);
eq('an unstated boost falls back to the highest stat (Talonflame: Speed)', U.paradoxSpeedBoost({ species: 'Talonflame', boosterActive: true }, {}), true);
eq('...and Great Tusk\'s highest stat is Attack, so no speed boost', U.paradoxSpeedBoost({ species: 'Great Tusk', boosterActive: true }, {}), false);
eq('a body with no active boost never counts', U.paradoxSpeedBoost({ species: 'Talonflame', boosterActive: false, boostedStat: 'spe' }, {}), false);
eq('opts.active can assert the boost before boosterActive is set', U.paradoxSpeedBoost({ species: 'Talonflame', boostedStat: 'spe' }, { active: true }), true);

/* The ordering test is a MIRROR, so the only thing that can flip `_opponentMovesFirst` is the 1.5x. */
function paradoxOrdering(boosterActive, boostedStat) {
  const mirrored = function (extra) {
    return Object.assign({ species: 'Great Tusk', evs: {}, ivs: U.DEFAULT_IVS, nature: '', boosts: {}, hpPercent: 100 }, extra);
  };
  return new ST.BlunderVetoGuard({})._opponentMovesFirst(
    { mySide: 'p1', field: { trickRoom: false } },
    mirrored({}), mirrored({ boosterActive: boosterActive, boostedStat: boostedStat }));
}
eq('a mirror with no boost does not move first', paradoxOrdering(false, null), false);
eq('...the same mirror WITH a Speed boost does move first', paradoxOrdering(true, 'spe'), true);
eq('...but an ATTACK boost does not pretend to be Speed', paradoxOrdering(true, 'atk'), false);

/* ==================================== 11. delayed slot conditions (Future Sight / Wish) */

section('11. Future Sight / Doom Desire / Wish: the parser, the clock, and the price');
{
  /* THE PIPELINE FIRST. The sim announces the cast with `|-start|<CASTER>|move: Future Sight`
   * (`data/moves.js`: `this.add('-start', source, 'move: Future Sight')`), parks the condition on the
   * OPPOSING side, and resolves it at the residual of the NEXT turn (`endingTurn = turn + 1`). Wish
   * is the same one-turn delay for a heal. Every one of those facts is what the state manager has
   * to carry, or the engine can only guess. */
  const dm = pipeline([
    '|switch|p1a: Slowking|Slowking, L50, M|100/100',
    '|switch|p2a: Great Tusk|Great Tusk, L50, M|100/100',
    '|turn|1',
    '|move|p1a: Slowking|Future Sight|p2a: Great Tusk',
    '|-start|p1a: Slowking|move: Future Sight'
  ]);
  const fs = dm.battle.field.delayedMoves;
  check('the cast is recorded on the side that will be HIT, not the caster\u2019s', fs.p2 && !fs.p1,
    JSON.stringify(fs));
  eq('...with the caster\u2019s own identity (its stats price the hit)', fs.p2 && fs.p2.attackerId, 'slowking');
  eq('...and the move it will land as', fs.p2 && fs.p2.moveName, 'Future Sight');
  eq('...scheduled for the residual of the NEXT turn', fs.p2 && fs.p2.landingTurn, 2);
  dm.parser.feedAll('|turn|2');
  eq('the landing turn ticks the countdown to 0 (it lands at ITS end)', dm.battle.field.delayedMoves.p2.turnsLeft, 0);
  dm.parser.feedAll('|-end|p2a: Great Tusk|move: Future Sight');
  eq('the sim\u2019s own |-end| clears the pending hit', dm.battle.field.delayedMoves.p2, null);

  const wishRun = pipeline([
    '|switch|p1a: Slowking|Slowking, L50, M|100/100',
    '|switch|p2a: Great Tusk|Great Tusk, L50, M|100/100',
    '|turn|1', '|move|p1a: Slowking|Wish|p1a: Slowking'
  ]);
  eq('Wish is recorded on the caster\u2019s own side', wishRun.battle.field.wish.p1 && wishRun.battle.field.wish.p1.casterId, 'slowking');
  eq('...for the residual of the next turn', wishRun.battle.field.wish.p1.landingTurn, 2);
  wishRun.parser.feedAll('|-heal|p1a: Slowking|100/100|[from] move: Wish|[wisher] Slowking');
  eq('...and the heal frame clears it', wishRun.battle.field.wish.p1, null);

  /* THE PRICE. A hand-built board, so the identity below is computed from the damage engine\u2019s
   * own numbers rather than a constant that a dex change could silently invalidate. */
  function dmMon(species, side, extra) {
    return Object.assign({
      id: U.toID(species), species: species, side: side, hpPercent: 100, maxhp: 100,
      fainted: false, status: '', level: 100, ability: '', item: '',
      evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 }, ivs: U.DEFAULT_IVS,
      nature: 'Timid', boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
      setMoves: [], revealedMoves: [], isActive: true
    }, extra || {});
  }
  function dmBoard(turn) {
    const me = dmMon('Slowking', 'p1', { ability: 'Regenerator', setMoves: ['Future Sight', 'Psychic', 'Wish', 'Slack Off'], revealedMoves: ['Future Sight', 'Psychic'] });
    const them = dmMon('Great Tusk', 'p2', { ability: 'Protosynthesis', nature: 'Jolly', evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, setMoves: ['Headlong Rush', 'Ice Spinner'], revealedMoves: ['Headlong Rush'] });
    return {
      turn: turn, mySide: 'p1', oppSide: 'p2', formatSupported: true,
      myTeam: [me], oppTeam: [them], active: { my: me, opp: them }, bench: { my: [], opp: [] },
      protect: { oppTurnsSinceLastProtect: 2, oppConsecutiveProtects: 0, myTurnsSinceLastProtect: 4, myConsecutiveProtects: 0 },
      recoveryPP: {},
      field: {
        turn: turn, trickRoom: false, weather: '', terrain: '',
        hazards: { p1: {}, p2: {} }, screens: {}, tailwind: {}, gravity: false,
        delayedMoves: { p1: null, p2: null }, wish: { p1: null, p2: null }
      }
    };
  }
  const FUTURE = { kind: 'move', name: 'Future Sight', moveId: 'futuresight' };
  const PASS = { kind: 'status', name: '' };
  const THEIR_NOTHING = { kind: 'move', name: 'Stealth Rock', moveId: 'stealthrock' };
  const eng = newEngine().engine;
  const off = newEngine({ delayedMoves: { enabled: false } }).engine;

  const t1 = dmBoard(1);
  const me1 = t1.active.my, them1 = t1.active.opp;
  const willHit = eng._damageOf(me1, them1, 'Future Sight', t1.field, true);
  check('the fixture Future Sight really resolves (a failed calc would make this vacuous)',
    !!willHit && willHit.avgPercent > 0, willHit && (willHit.avgPercent + '%'));
  const discounted = U.clamp(100 - willHit.avgPercent * eng.delayedMoves.setupDiscount, 0, 100);
  const passCell = eng._payoff(PASS, THEIR_NOTHING, t1, t1.field);
  close('clicking Future Sight credits the DISCOUNTED hit, not an immediate 120 BP one',
    eng._payoff(FUTURE, THEIR_NOTHING, t1, t1.field),
    eng.evaluator.evaluate(eng._leafState(t1, me1, them1, 100, discounted)), 1e-6);
  check('...so it beats passing, and by less than the full hit would be worth',
    eng._payoff(FUTURE, THEIR_NOTHING, t1, t1.field) > passCell &&
    eng._payoff(FUTURE, THEIR_NOTHING, t1, t1.field) <
      eng.evaluator.evaluate(eng._leafState(t1, me1, them1, 100, U.clamp(100 - willHit.avgPercent, 0, 100))),
    'click ' + eng._payoff(FUTURE, THEIR_NOTHING, t1, t1.field) + ' pass ' + passCell);
  /* ...and OFF is the OLD price: the full hit, scored on the turn it is clicked. This fixture is a
   * real OHKO (Slowking's Future Sight on Great Tusk), so the cell also earns the lethal bonus the
   * payoff pays for a fainted target — the expected leaf carries it too, or the comparison would
   * be off by exactly that term. */
  const fullHp = U.clamp(100 - willHit.avgPercent, 0, 100);
  close('with the tier OFF the click is the immediate full hit (the old price)',
    off._payoff(FUTURE, THEIR_NOTHING, t1, t1.field),
    off.evaluator.evaluate(off._leafState(t1, me1, them1, 100, fullHp)) +
      (fullHp <= 0 ? off.lethalBonus : 0), 1e-6);

  /* A second Future Sight cannot be parked on a side that already has one, so the click FAILS. The
   * reference is a kind the payoff models as nothing at all (`PASS`), which is exactly what a
   * failed click is worth; the pending entry is far in the future so it cannot land in this cell. */
  const blocked = dmBoard(1);
  blocked.field.delayedMoves.p2 = { moveName: 'Future Sight', moveId: 'futuresight', attackerSide: 'p1', attackerId: 'slowking', attackerSpecies: 'Slowking', startTurn: 0, landingTurn: 9, turnsLeft: 9 };
  close('a second Future Sight into a pending one is priced as the failed click it is',
    eng._payoff(FUTURE, THEIR_NOTHING, blocked, blocked.field),
    eng._payoff(PASS, THEIR_NOTHING, blocked, blocked.field), 1e-6);
  close('...and the tier OFF does not read the pending entry at all',
    off._payoff(PASS, THEIR_NOTHING, blocked, blocked.field),
    off._payoff(PASS, THEIR_NOTHING, dmBoard(1), dmBoard(1).field), 1e-6);

  /* THE LANDING. Their Future Sight parked on US lands at the end of this turn, against the body
   * standing here now, priced from THEIR caster. */
  const t2 = dmBoard(2);
  const them2 = t2.active.opp, me2 = t2.active.my;
  t2.field.delayedMoves.p1 = { moveName: 'Future Sight', moveId: 'futuresight', attackerSide: 'p2', attackerId: 'greattusk', attackerSpecies: 'Great Tusk', startTurn: 1, landingTurn: 2, turnsLeft: 0 };
  const incoming = eng._damageOf(them2, me2, 'Future Sight', t2.field, false);
  check('the landing hit resolves too', !!incoming && incoming.avgPercent > 0, incoming && (incoming.avgPercent + '%'));
  close('an in-flight Future Sight is charged to us at the end of its landing turn',
    eng._payoff(PASS, THEIR_NOTHING, t2, t2.field),
    eng.evaluator.evaluate(eng._leafState(t2, me2, them2, U.clamp(100 - incoming.avgPercent, 0, 100), 100)), 1e-6);
  const notYet = dmBoard(2);
  notYet.field.delayedMoves.p1 = Object.assign({}, t2.field.delayedMoves.p1, { landingTurn: 3, turnsLeft: 1 });
  close('...but NOT a turn early (the countdown is the sim\u2019s, not a guess)',
    eng._payoff(PASS, THEIR_NOTHING, notYet, notYet.field),
    eng._payoff(PASS, THEIR_NOTHING, dmBoard(2), dmBoard(2).field), 1e-6);

  /* The landed hit follows the SLOT, so a switch-in eats it — and it is the caster\u2019s stats that
   * matter, not the body standing there. A switch-in is priced on the incoming body\u2019s own bulk. */
  const switching = dmBoard(2);
  switching.field.delayedMoves.p1 = Object.assign({}, t2.field.delayedMoves.p1);
  const incomingMon = dmMon('Dragonite', 'p1', { ability: 'Inner Focus', nature: 'Adamant', evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 } });
  switching.myTeam.push(incomingMon);
  switching.bench.my.push(incomingMon);
  switching.active = { my: switching.myTeam[0], opp: them2 };
  const switchHit = eng._damageOf(them2, incomingMon, 'Future Sight', switching.field, false);
  const switchCell = eng._payoff({ kind: 'switch', name: 'Dragonite', switchTo: 'dragonite' }, THEIR_NOTHING, switching, switching.field);
  check('a body switching into the slot takes the delayed hit (the damage engine says so)',
    !!switchHit && switchHit.avgPercent > 0 && switchCell !== undefined, switchHit && (switchHit.avgPercent + '%'));

  /* WISH. The heal lands on whoever stands in the slot, for half the CASTER\u2019s max HP. */
  const t3 = dmBoard(2);
  t3.active.my.hpPercent = 40;
  t3.field.wish.p1 = { casterId: 'slowking', casterSpecies: 'Slowking', startTurn: 1, landingTurn: 2, turnsLeft: 0, healPct: 50 };
  const me3 = t3.active.my, them3 = t3.active.opp;
  close('a landed Wish heals the standing body before the leaf is scored',
    eng._payoff(PASS, THEIR_NOTHING, t3, t3.field),
    eng.evaluator.evaluate(eng._leafState(t3, me3, them3, 90, 100)), 1e-6);
  const fullWish = dmBoard(2);
  fullWish.field.wish.p1 = Object.assign({}, t3.field.wish.p1);
  close('...and a Wish on a full-HP body is a no-op, not an overheal',
    eng._payoff(PASS, THEIR_NOTHING, fullWish, fullWish.field),
    eng._payoff(PASS, THEIR_NOTHING, dmBoard(2), dmBoard(2).field), 1e-6);
}

/* ================================================================== summary */

console.log('\n=== summary ===');
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failed);
console.log('solver iterations: ' + ITER);
if (failed) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('ALL UPGRADE CHECKS PASSED');
process.exit(0);
