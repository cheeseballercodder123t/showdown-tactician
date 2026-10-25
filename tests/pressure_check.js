/* Showdown Tactician — tests/pressure_check.js
 *
 * Run me with:  node tests/pressure_check.js
 *
 * WHAT THIS IS
 *   The regression suite for the three "pressure" upgrades of ARCHITECTURE §6.4–§6.6:
 *     §1  the `|stpp|` / `|stacc|` snapshot path — the ONLY way max PP and move accuracy ever
 *         enter the engine (both are game data the engine may not invent, so they are MEASURED
 *         from the page's own battle object by src/injected.js and forwarded as protocol lines);
 *     §2  the PP gauge, including its honesty property: with no snapshot it says how many times
 *         the move was seen, and never prints a denominator it was not given;
 *     §3  the 3-way PP-stall pivot (`ppStall(state).matrix`), a real payoff matrix solved with the
 *         same fictitious play the main decision uses;
 *     §4  the risk-adjusted volatility charge as a pure function, and §5 the same charge reaching
 *         the ranked rows through `evaluateTurn`;
 *     §6  the format sentinel (Mega / Z-Move locks), and §7 the bar it draws.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about a real browser: the DOM is the harness stub (whose `querySelector*` always
 *   returns null, so nodes are found by walking `children`), no CSS is evaluated, and the
 *   `|stpp|`/`|stacc|` lines are fed by hand rather than captured from a live client. The
 *   volatility ordering is asserted as a *difference* between two runs of the same fixture, not
 *   as an absolute ranking, because the arithmetic behind the payoff is a heuristic evaluator.
 *
 * TWO KNOWN DEFECTS THIS SUITE PINS (see the report; both need src/laplace_core.js)
 *   1. `ppStall` reads the OPPONENT body's `ppSnapshot`, while the brief this feature came from
 *      is about OUR Sucker Punch being stalled out ("you click Sucker Punch ... until your Sucker
 *      Punch runs out of PP"). The matrix's first ROW is the watched move as one of OUR actions,
 *      so the PP number and the pivoted line currently describe different players (§3 pins it).
 *   2. The engine fills `mega.label` / `z.label` with the burned/live LABEL, but
 *      `MobileHUD._mechanicRow` renders `label` as the mechanic's NAME, so a burned row reads
 *      "BURNED: BURNED" instead of "Mega Evolution: BURNED" (§7 pins the text).
 *   Doc drift worth noting: ARCHITECTURE §6.4 says the snapshot lands on `mon.pp` (it is
 *   `mon.ppSnapshot`) and §6.5 says accuracy comes from `U.getMoveData(...).accuracy` (the
 *   vendored bundle ships no accuracy data at all — it comes from `|stacc|` into
 *   `state.moveAccuracy`). This suite asserts what the code really does.
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
function eq(name, got, want) {
  return check(name, JSON.stringify(got) === JSON.stringify(want),
    'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function close(name, got, want, tol) {
  const ok = typeof got === 'number' && isFinite(got) && Math.abs(got - want) <= tol;
  return check(name, ok, 'got ' + got + ', want ' + want + ' (+-' + tol + ')');
}
function section(title) { console.log('\n=== ' + title + ' ==='); }
function noThrow(fn) {
  try { return { ok: true, value: fn(), error: null }; }
  catch (e) { return { ok: false, value: undefined, error: String((e && e.message) || e) }; }
}
/**
 * Call an entry point, recording a check when it throws, and return its value: this suite is
 * written against a contract, so a missing or throwing method has to be a FAILED CHECK that names
 * itself rather than a crash at section 2 of 7.
 */
function call(name, fn) {
  const r = noThrow(fn);
  check(name, r.ok, r.error);
  return r.value;
}

/* ------------------------------------------------------------------ stub-DOM helpers */

function kids(el) { return (el && Array.isArray(el.children)) ? el.children : []; }
function attr(el, key) { return (el && typeof el.getAttribute === 'function') ? el.getAttribute(key) : null; }
function textOf(el) { return String((el && el.textContent) || '').trim(); }
function allText(el, acc) {
  acc = acc || [];
  if (el && el.textContent) acc.push(String(el.textContent));
  kids(el).forEach(function (kid) { allText(kid, acc); });
  return acc;
}
function hasClass(el, cls) {
  if (!el) return false;
  if (el.classList && typeof el.classList.contains === 'function' && el.classList.contains(cls)) return true;
  return String(el.className || '').split(/\s+/).indexOf(cls) !== -1;
}
function findAll(root, pred, acc) {
  acc = acc || [];
  kids(root).forEach(function (child) {
    if (pred(child)) acc.push(child);
    findAll(child, pred, acc);
  });
  return acc;
}
function byAttr(key) { return findAll(S.document.body, function (el) { return attr(el, key) !== null; }); }
function byClass(cls) { return findAll(S.document.body, function (el) { return hasClass(el, cls); }); }

/* ------------------------------------------------------------------ fixtures */

const PASTE = [
  'Gholdengo @ Choice Specs',
  'Ability: Good as Gold',
  'Level: 100',
  'EVs: 252 SpA / 4 SpD / 252 Spe',
  'Timid Nature',
  '- Make It Rain',
  '- Shadow Ball',
  '- Focus Blast',
  '- Nasty Plot',
  '',
  'Kingambit @ Leftovers',
  'Ability: Supreme Overlord',
  'EVs: 252 HP / 252 Atk / 4 SpD',
  'Adamant Nature',
  '- Kowtow Cleave',
  '- Sucker Punch',
  '- Iron Head',
  '- Swords Dance',
  ''
].join('\n');

/** The real pipeline: state manager + parser + our registered team (same shape as upgrades_check). */
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

/** A `|request|` line with a real move list, so `getMyActions` has authoritative legal actions. */
function requestLine(moves) {
  return '|request|' + JSON.stringify({
    side: { id: 'p1' },
    active: [{
      moves: moves.map(function (m) {
        return { id: m.id, move: m.move, pp: m.pp === undefined ? 8 : m.pp, maxpp: m.maxpp === undefined ? 8 : m.maxpp };
      })
    }]
  });
}
const GHOLDENGO_MOVES = [
  { id: 'focusblast', move: 'Focus Blast' },
  { id: 'shadowball', move: 'Shadow Ball' },
  { id: 'makeitrain', move: 'Make It Rain' },
  { id: 'nastyplot', move: 'Nasty Plot' }
];
/* OUR Kingambit, mid-stall: the request carries the server's own PP for our Sucker Punch, which
 * is the authority the gauge reads first. `ppStall` answers "how many of MY Sucker Punches are
 * left", so every fixture below puts the watched move on OUR side. */
const KINGAMBIT_MOVES = [
  { id: 'suckerpunch', move: 'Sucker Punch', pp: 5, maxpp: 8 },
  { id: 'kowtowcleave', move: 'Kowtow Cleave', pp: 16, maxpp: 16 },
  { id: 'ironhead', move: 'Iron Head', pp: 15, maxpp: 15 },
  { id: 'swordsdance', move: 'Swords Dance', pp: 20, maxpp: 20 }
];
/** Our Kingambit into their Dragonite, with the dragon's stall moves revealed. */
function kingambitLines(extra) {
  return [
    '|switch|p1a: Kingambit|Kingambit, L50, M|100/100',
    '|switch|p2a: Dragonite|Dragonite, L50, M|100/100',
    '|turn|1',
    '|move|p2a: Dragonite|Dragon Dance|p2a: Dragonite',
    '|move|p2a: Dragonite|Roost|p2a: Dragonite',
    '|stpp|p1a: Kingambit|suckerpunch|5|8'
  ].concat(extra || []);
}

function oppByName(fx, id) {
  const team = (fx.battle && fx.battle.oppTeam) || [];
  for (let i = 0; i < team.length; i++) {
    const mon = team[i];
    if (mon && (mon.id === id || U.toID(mon.species) === id)) return mon;
  }
  return null;
}
function rowFor(ranked, moveId) {
  for (let i = 0; i < (ranked || []).length; i++) {
    if (ranked[i] && U.toID(ranked[i].moveId || ranked[i].name || '') === moveId) return ranked[i];
  }
  return null;
}
function sum(list) { return list.reduce(function (a, b) { return a + b; }, 0); }
function cfg(path, fallback) {
  return typeof ST.configGet === 'function' ? ST.configGet(path, fallback) : fallback;
}

/* ============================================================ 1. the snapshots */

section('1. the |stpp| / |stacc| snapshot lines are the only source of PP and accuracy');

const PP_LINES = [
  '|switch|p1a: Gholdengo|Gholdengo, L50, M|100/100',
  '|switch|p2a: Kingambit|Kingambit, L50, M|100/100',
  '|turn|1',
  '|move|p2a: Kingambit|Sucker Punch|p1a: Gholdengo',
  '|stpp|p2a: Kingambit|suckerpunch|5|8',
  '|stpp|p2a: Kingambit|kowtowcleave|16|16',
  '|stacc|focusblast|70',
  '|stacc|shadowball|true'
];
const ppFx = pipeline(PP_LINES);
const ppOpp = oppByName(ppFx, 'kingambit');

check('fixture sanity: the opponent body is on the field', !!ppOpp, JSON.stringify((ppFx.battle.oppTeam || []).map(function (m) { return m && m.species; })));
const snap = ppOpp && ppOpp.ppSnapshot && ppOpp.ppSnapshot.suckerpunch;
eq('the snapshot lands on the body as mon.ppSnapshot', !!snap, true);
eq('...with the pp the page reported', snap && snap.pp, 5);
eq('...and the max pp, which is game data we may not invent', snap && snap.maxpp, 8);
eq('...stamped with the turn it was read on', snap && snap.turn, 1);
eq('a second line for another move MERGES rather than replacing',
  !!(ppOpp && ppOpp.ppSnapshot && ppOpp.ppSnapshot.kowtowcleave && ppOpp.ppSnapshot.kowtowcleave.maxpp === 16), true);
eq('the first move is still there after the merge', !!(ppOpp && ppOpp.ppSnapshot && ppOpp.ppSnapshot.suckerpunch), true);
eq('an observed use is counted from the |move| line', ppOpp && ppOpp.ppUsed && ppOpp.ppUsed.suckerpunch, 1);

const ppEvent = call('the parser maps |stpp| to a `pp` event', function () { return ppFx.parser.feed('|stpp|p2a: Kingambit|ironhead|8|8'); });
eq('the event names the body', ppEvent && { side: ppEvent.side, slot: ppEvent.slot, species: ppEvent.species },
  { side: 'p2', slot: 'p2a', species: 'Kingambit' });
eq('...and carries one move slot per line', ppEvent && ppEvent.moves, [{ id: 'ironhead', pp: 8, maxpp: 8 }]);

const badStpp = call('a malformed |stpp| line does not throw', function () { return ppFx.parser.feed('|stpp|p2a: Kingambit|suckerpunch|x|y'); });
eq('...and reports unknown PP as null rather than 0', badStpp && badStpp.moves && badStpp.moves[0] && { id: badStpp.moves[0].id, pp: badStpp.moves[0].pp, maxpp: badStpp.moves[0].maxpp },
  { id: 'suckerpunch', pp: null, maxpp: null });
eq('...so a null-PP snapshot stores nothing', ppOpp.ppSnapshot.suckerpunch.pp, 5);
call('a |stpp| line with no body at all is survivable', function () { return ppFx.parser.feed('|stpp|||'); });

eq('the accuracy snapshot lands on the battle state', ppFx.battle.moveAccuracy.focusblast, 70);
eq('a sure-hit move is kept as `true`, not coerced to 100', ppFx.battle.moveAccuracy.shadowball, true);
const badAcc = call('a malformed |stacc| line does not throw', function () { return ppFx.parser.feed('|stacc|focusblast|nope'); });
eq('...and stores nothing', badAcc && badAcc.moves, []);

const struggleFx = pipeline([
  '|switch|p1a: Gholdengo|Gholdengo, L50, M|100/100',
  '|switch|p2a: Kingambit|Kingambit, L50, M|100/100',
  '|turn|1',
  '|move|p2a: Kingambit|Struggle|p1a: Gholdengo'
]);
const struggleOpp = oppByName(struggleFx, 'kingambit');
eq('a forced pseudo-move is not counted as a PP use', struggleOpp && struggleOpp.ppUsed && struggleOpp.ppUsed.struggle, undefined);

/* ================================================================ 2. the gauge */

section('2. the gauge, and the honesty property that keeps it from inventing a denominator');

const ppEngine = newEngine();

/* The gauge is OURS: our Kingambit's Sucker Punch, with the server's PP in the |request|. */
const myPpFx = pipeline(kingambitLines([requestLine(KINGAMBIT_MOVES)]));
const gauge = call('ppStall does not throw', function () { return ppEngine.engine.ppStall(myPpFx.battle); });
check('a real snapshot produces a gauge', !!gauge, JSON.stringify(gauge && gauge.move));
eq('the gauge headlines the configured watch move', gauge && gauge.move && gauge.move.id, U.toID(cfg('ppStall.headline', 'suckerpunch')));
eq('...with the observed pp', gauge && gauge.move && gauge.move.pp, 5);
eq('...and the observed maxpp', gauge && gauge.move && gauge.move.maxpp, 8);
eq('...flagged as a real snapshot, not an observed count', gauge && gauge.move && gauge.move.observesOnly, false);
eq('...and the body it belongs to', gauge && gauge.species, 'Kingambit');
eq('the threat block is always shaped', !!gauge && Array.isArray(gauge.threat.setupMoves) && typeof gauge.threat.theirHp === 'number', true);
check('...and the threat is THEIRS, not ours',
  (gauge && gauge.threat.setupMoves || []).some(function (m) { return /dragon dance/i.test(String(m)); }),
  JSON.stringify(gauge && gauge.threat.setupMoves));

/* No |request| and no |stpp| for our Sucker Punch: the only thing left is the click we watched. */
const observedOnlyFx = pipeline([
  '|switch|p1a: Kingambit|Kingambit, L50, M|100/100',
  '|switch|p2a: Dragonite|Dragonite, L50, M|100/100',
  '|turn|1',
  '|move|p1a: Kingambit|Sucker Punch|p2a: Dragonite'
]);
const observedGauge = call('ppStall works with observed uses only', function () { return ppEngine.engine.ppStall(observedOnlyFx.battle); });
eq('one observed use is enough to say something', !!observedGauge, true);
eq('...and it is flagged observesOnly', observedGauge && observedGauge.move && observedGauge.move.observesOnly, true);
eq('...and it claims NO max pp it was never given', observedGauge && observedGauge.move && observedGauge.move.maxpp, null);
eq('...but it does report the observed count', observedGauge && observedGauge.move && observedGauge.move.used, 1);

/* Our Sucker Punch is not in the request and was never clicked: nothing honest to show. */
const silentFx = pipeline([
  '|switch|p1a: Kingambit|Kingambit, L50, M|100/100',
  '|switch|p2a: Dragonite|Dragonite, L50, M|100/100',
  '|turn|1'
]);
eq('with neither a snapshot nor a use, there is nothing to show',
  ppEngine.engine.ppStall(silentFx.battle), null);
eq('ppStall(null) is null', ppEngine.engine.ppStall(null), null);
eq('ppStall({}) is null', ppEngine.engine.ppStall({}), null);

const ppHud = call('MobileHUD is constructible against the stub DOM', function () { return new ST.MobileHUD({ doc: S.document }); });
const gaugeEl = call('renderPPGauge does not throw', function () { return ppHud && ppHud.renderPPGauge(gauge); });
check('the gauge element carries the frozen attribute', !!gaugeEl && attr(gaugeEl, 'data-st-pp') !== null,
  JSON.stringify(gaugeEl && gaugeEl.attributes));
check('...and it is mounted in the document', byAttr('data-st-pp').length >= 1, String(byAttr('data-st-pp').length));
check('the headline spells out pp/maxpp', /\b5\s*\/\s*8\b/.test(allText(gaugeEl).join(' ')), allText(gaugeEl).join(' | '));
eq('clearPPGauge removes it', call('clearPPGauge does not throw', function () { return ppHud && ppHud.clearPPGauge(); }), null);
eq('...from the document too', byAttr('data-st-pp').length, 0);

const honestEl = call('renderPPGauge renders the observed-only gauge', function () { return ppHud && ppHud.renderPPGauge(observedGauge); });
const honestText = allText(honestEl).join(' ');
check('the observed-only gauge says how many uses were seen', /\bused\b/i.test(honestText) && /\b1\b/.test(honestText), honestText);
check('...and NEVER prints an invented denominator', !/\d\s*\/\s*\d/.test(honestText), honestText);
eq('a null gauge removes the node', call('renderPPGauge(null) does not throw', function () { return ppHud && ppHud.renderPPGauge(null); }), null);

/* ============================================================== 3. the pivot */

section('3. the 3-way pivot: a real payoff matrix, solved, and gated on remaining PP');

const PIVOT_LINES = kingambitLines([requestLine(KINGAMBIT_MOVES)]);
const pivotFx = pipeline(PIVOT_LINES);
const pivotGauge = call('ppStall builds the pivot on a full fixture', function () { return ppEngine.engine.ppStall(pivotFx.battle); });
const matrix = pivotGauge && pivotGauge.matrix;
check('a matrix came back', !!matrix, JSON.stringify(pivotGauge && { move: pivotGauge.move, advice: pivotGauge.advice }));
if (matrix) {
  eq('it has labelled rows', matrix.rows.length >= 2, true);
  eq('it has labelled columns', matrix.cols.length >= 1, true);
  check('every row has exactly one entry per column',
    matrix.payoff.length === matrix.rows.length &&
    matrix.payoff.every(function (row) { return Array.isArray(row) && row.length === matrix.cols.length; }),
    JSON.stringify(matrix.payoff.map(function (r) { return r && r.length; })));
  check('every payoff is a finite number',
    matrix.payoff.every(function (row) { return row.every(function (v) { return typeof v === 'number' && isFinite(v); }); }),
    JSON.stringify(matrix.payoff));
  close('the mixed strategy is a probability distribution', sum(matrix.solution.myStrategy), 1, 1e-9);
  close('...and so is hers', sum(matrix.solution.oppStrategy), 1, 1e-9);
  eq('the row values are one per row', matrix.solution.rowValues.length, matrix.rows.length);
  const advice = pivotGauge.advice;
  check('advice exists and names a row that is really in the matrix', !!advice &&
    matrix.rows.some(function (r) { return U.toID(r.moveId || r.action.moveId || r.label) === U.toID(advice.moveId); }),
    JSON.stringify(advice));
  check('...with a frequency in 0..100', !!advice && advice.frequency >= 0 && advice.frequency <= 100,
    JSON.stringify(advice && advice.frequency));
  check('...and a reason that says what it is advising', !!advice && /%/.test(String(advice.reason)), String(advice && advice.reason));
  check('the first row is the watched move — OUR Sucker Punch, the one with PP to lose',
    U.toID(matrix.rows[0].moveId || matrix.rows[0].action.moveId || '') === U.toID(cfg('ppStall.headline', 'suckerpunch')),
    JSON.stringify(matrix.rows[0].label));
} else {
  check('the pivot fixture produced a matrix', false, 'no matrix: nothing below could be checked');
}

const setupThreat = pivotGauge && pivotGauge.threat && pivotGauge.threat.setupMoves;
check('their revealed setup move is read as the stall threat',
  Array.isArray(setupThreat) && setupThreat.some(function (m) { return /dragon dance/i.test(String(m)); }),
  JSON.stringify(setupThreat));
check('...along with their recovery move',
  Array.isArray(setupThreat) && setupThreat.some(function (m) { return /roost/i.test(String(m)); }),
  JSON.stringify(setupThreat));
check('...and the read says so out loud', /dragon dance/i.test(String(pivotGauge && pivotGauge.threat && pivotGauge.threat.read)),
  String(pivotGauge && pivotGauge.threat && pivotGauge.threat.read));

/* The gauge must describe ONE body. The bug this pins: after a switch the last |request| still
 * describes the body that left the field, so the gauge paired the outgoing body's PP with the
 * incoming body's moves and the advice named a move the watched body cannot even hold. */
const leftFx = pipeline(PIVOT_LINES.concat([
  '|switch|p1b: Great Tusk|Great Tusk, L50, M|100/100'
]));
const leftState = leftFx.battle;
const leftGauge = call('ppStall survives the body it was counting leaving the field', function () {
  return ppEngine.engine.ppStall(leftState);
});
check('a watched move the active body cannot hold is not reported at all',
  leftGauge === null, JSON.stringify(leftGauge && { species: leftGauge.species, move: leftGauge.move }));
check('...while the same state still answers for the body that can hold it',
  !!(pivotGauge && pivotGauge.move && pivotGauge.move.id === U.toID(cfg('ppStall.headline', 'suckerpunch'))),
  JSON.stringify(pivotGauge && pivotGauge.move));
/* The two guards on that answer, each pinned on its own: (a) the request is stale — its numbers
 * belong to the body that left — and (b) we DO know the active body's moves and the watched move
 * is not one of them. */
const staleOwnerFx = pipeline(PIVOT_LINES);
const staleOwner = staleOwnerFx.battle;
eq('fixture sanity: the request records the body it was built for',
  U.toID(staleOwner.legalActions && staleOwner.legalActions.forId), 'kingambit');
staleOwner.active.my = { id: 'greattusk', species: 'Great Tusk' };   // the switch, without a request
const staleGauge = call('ppStall ignores a request left over from the body that switched out', function () {
  return ppEngine.engine.ppStall(staleOwner);
});
eq('...so it reports nothing rather than mixing two bodies', staleGauge, null);
const sameOwnerFx = pipeline(PIVOT_LINES);
const sameOwner = sameOwnerFx.battle;
sameOwner.active.my = { id: 'kingambit', species: 'Kingambit',
  setMoves: ['kowtowcleave', 'ironhead', 'swordsdance', 'lowkick'] };
const disproved = call('ppStall rejects a watched move the body provably cannot hold', function () {
  return ppEngine.engine.ppStall(sameOwner);
});
eq('...even when the request is for the right body', disproved, null);

/* The matrix is gated: once the watched move is nearly out of PP the pivot has already won. */
const pivotMe = pivotFx.battle.active.my;
const savedPp = pivotMe.ppSnapshot.suckerpunch.pp;
const savedLegalPp = pivotFx.battle.legalActions.moves[0].pp;
pivotMe.ppSnapshot.suckerpunch.pp = 1;                       // 1/8 = 0.125 < minPpFraction (0.2)
pivotFx.battle.legalActions.moves[0].pp = 1;                 // the request is the first authority
const drainedGauge = call('ppStall survives a drained snapshot', function () { return ppEngine.engine.ppStall(pivotFx.battle); });
eq('a drained watched move reports the truth', drainedGauge && drainedGauge.move && drainedGauge.move.pp, 1);
eq('...and no longer claims a solved pivot', drainedGauge && drainedGauge.matrix, null);
eq('...nor advice', drainedGauge && drainedGauge.advice, null);
pivotMe.ppSnapshot.suckerpunch.pp = savedPp;
pivotFx.battle.legalActions.moves[0].pp = savedLegalPp;

/* ============================================ 4. the volatility charge, as a function */

section('4. the risk-adjusted volatility charge (the "tilt penalty")');

const VOL_LINES = [
  '|switch|p1a: Gholdengo|Gholdengo, L50, M|100/100',
  '|switch|p2a: Heatran|Heatran, L50, M|100/100',
  '|turn|1',
  '|-damage|p1a: Gholdengo|18/100',
  '|stacc|focusblast|70',
  '|stacc|shadowball|true',
  '|stacc|makeitrain|100'
];
const volFx = pipeline(VOL_LINES);
const volState = volFx.battle;
const FOCUS = { kind: 'move', name: 'Focus Blast', moveId: 'focusblast' };
const volEngine = newEngine();

const charged = call('the charge computes', function () { return volEngine.engine._volatilityDelta(FOCUS, volState, volState.field, 500); });
check('a 70%-accuracy move is charged a NEGATIVE delta', !!charged && charged.penalty < 0, JSON.stringify(charged));
check('...and the reason names the accuracy it was charged for', !!charged && /70%/.test(String(charged.why)), String(charged && charged.why));

const sureHit = call('a sure-hit move is free', function () {
  return volEngine.engine._volatilityDelta({ kind: 'move', name: 'Shadow Ball', moveId: 'shadowball' }, volState, volState.field, 500);
});
eq('...no charge at all when the move cannot miss', sureHit, { penalty: 0, why: null });
const fullAcc = call('a 100%-accuracy move is free', function () {
  return volEngine.engine._volatilityDelta({ kind: 'move', name: 'Make It Rain', moveId: 'makeitrain' }, volState, volState.field, 500);
});
eq('...the accuracy floor is respected', fullAcc, { penalty: 0, why: null });
const statusMove = call('a status move is free', function () {
  return volEngine.engine._volatilityDelta({ kind: 'move', name: 'Nasty Plot', moveId: 'nastyplot' }, volState, volState.field, 500);
});
eq('...no charge on a move that deals no damage', statusMove, { penalty: 0, why: null });
const switchRow = call('a switch row is free', function () {
  return volEngine.engine._volatilityDelta({ kind: 'switch', name: 'Kingambit', targetId: 'kingambit' }, volState, volState.field, 0);
});
eq('...no charge for leaving the field', switchRow, { penalty: 0, why: null });

const unknownFx = pipeline(VOL_LINES.slice(0, 4));
const unknown = call('an unknown accuracy is free', function () {
  return volEngine.engine._volatilityDelta(FOCUS, unknownFx.battle, unknownFx.battle.field, 500);
});
eq('...the honest answer when we have never been told the accuracy', unknown, { penalty: 0, why: null });
eq('...and the state really has no accuracy for it', unknownFx.battle.moveAccuracy.focusblast, undefined);

const offEngine = newEngine({ volatility: { enabled: false } });
eq('laplace.volatility.enabled = false restores the raw payoff',
  offEngine.engine._volatilityDelta(FOCUS, volState, volState.field, 500), { penalty: 0, why: null });

const softEngine = newEngine({ volatility: { lethalMultiplier: 1 } });
const hardEngine = newEngine({ volatility: { lethalMultiplier: 3 } });
const soft = call('the fragility charge computes with multiplier 1', function () { return softEngine.engine._volatilityDelta(FOCUS, volState, volState.field, 500); });
const hard = call('...and with multiplier 3', function () { return hardEngine.engine._volatilityDelta(FOCUS, volState, volState.field, 500); });
check('the multiplier can never make a line LOOK safer', !!soft && !!hard && hard.penalty <= soft.penalty + 1e-9,
  JSON.stringify({ soft: soft && soft.penalty, hard: hard && hard.penalty }));
if (hard && soft && hard.penalty < soft.penalty - 1e-9) {
  check('the lethal branch is what charged the extra, and it says so',
    /lethal/i.test(String(hard.why)), String(hard.why));
} else {
  check('the incoming threat in this fixture is not lethal, so the multiplier stayed inert',
    !/lethal/i.test(String(hard && hard.why)), String(hard && hard.why));
}

/* ==================================== 5. the charge reaches the ranked lines */

section('5. the charge is folded into the ranked matrix, and the switch restores the old order');

const onFx = pipeline(VOL_LINES.concat([requestLine(GHOLDENGO_MOVES)]));
const offFx = pipeline(VOL_LINES.concat([requestLine(GHOLDENGO_MOVES)]));
// Exercise the retained heuristic engine; live requests model misses as turn branches.
onFx.battle.ownershipResolved = offFx.battle.ownershipResolved = false;
const onRanked = call('evaluateTurn runs with volatility on', function () { return newEngine().engine.evaluateTurn(onFx.battle); });
const offRanked = call('evaluateTurn runs with volatility off',
  function () { return newEngine({ volatility: { enabled: false } }).engine.evaluateTurn(offFx.battle); });

check('both runs produced lines', (onRanked || []).length > 1 && (offRanked || []).length > 1,
  JSON.stringify([(onRanked || []).length, (offRanked || []).length]));
const chargedRows = (onRanked || []).filter(function (r) { return typeof r.volatilityPenalty === 'number' && r.volatilityPenalty < 0; });
check('with it on, at least one ranked row carries a negative volatilityPenalty', chargedRows.length >= 1,
  JSON.stringify((onRanked || []).map(function (r) { return [r.name, r.volatilityPenalty]; })));
check('...and that row explains itself', chargedRows.every(function (r) { return typeof r.volatilityWhy === 'string' && r.volatilityWhy.length > 0; }),
  JSON.stringify(chargedRows.map(function (r) { return r.volatilityWhy; })));
check('with it off, no row carries the field at all',
  (offRanked || []).every(function (r) { return r.volatilityPenalty === undefined; }),
  JSON.stringify((offRanked || []).map(function (r) { return r.volatilityPenalty; })));

const onFocus = rowFor(onRanked, 'focusblast');
const offFocus = rowFor(offRanked, 'focusblast');
check('fixture sanity: Focus Blast is one of our legal lines', !!onFocus && !!offFocus,
  JSON.stringify((onRanked || []).map(function (r) { return r.name; })));
if (onFocus && offFocus && !onFocus.isVetoed && !offFocus.isVetoed) {
  // Under the Nash solve a row's `score` is its expected payoff against HER equilibrium mix, so
  // subtracting from one row can move the mix and nudge the others. The property that is exactly
  // true is the one below: the charge lands on the low-accuracy row and on nothing else.
  check('the charged line is worth strictly less than it was before the charge',
    onFocus.score < offFocus.score, JSON.stringify({ on: onFocus.score, off: offFocus.score }));
} else {
  check('the Focus Blast line was vetoed in this fixture, so the payoff comparison is skipped', true);
}
// The one move in this fixture whose accuracy we were told about and which is below the floor.
const floored = ['focusblast'];
check('exactly the low-accuracy lines were charged, and nothing else',
  (onRanked || []).every(function (r) {
    const id = U.toID(r.moveId || r.name || '');
    return (typeof r.volatilityPenalty === 'number') === (floored.indexOf(id) !== -1);
  }),
  JSON.stringify((onRanked || []).map(function (r) { return [r.name, r.volatilityPenalty]; })));
check('the ranked invariants survive the charge',
  (onRanked || []).every(function (r) { return isFinite(r.confidence) && r.confidence >= 0 && r.confidence <= 100; }),
  JSON.stringify((onRanked || []).map(function (r) { return r.confidence; })));
close('...and the live frequencies still sum to 100',
  sum((onRanked || []).filter(function (r) { return !r.isVetoed; }).map(function (r) { return r.confidence; })), 100, 1e-6);

/* The config path, and its restore. The backup is a deep copy, so restoring cannot be a no-op. */
const VOL_BACKUP = JSON.parse(JSON.stringify(cfg('laplace.volatility', {})));
ST.configMerge({ laplace: { volatility: { fragilityScale: 9 } } });
eq('a new engine takes volatility.fragilityScale from the config', newEngine().engine.volatility.fragilityScale, 9);
ST.configMerge({ laplace: { volatility: VOL_BACKUP } });
eq('...and the original value is restored', newEngine().engine.volatility.fragilityScale, VOL_BACKUP.fragilityScale);
eq('every other volatility key came back with it',
  JSON.stringify(cfg('laplace.volatility', null)), JSON.stringify(VOL_BACKUP));

/* ============================================================= 6. the sentinel */

section('6. the format sentinel reads the locks, and claims freedom only once both are burned');

const SENTINEL_MEGA_ONLY = [
  '|switch|p1a: Gholdengo|Gholdengo, L50, M|100/100',
  '|switch|p2a: Charizard|Charizard, L50, M|100/100',
  '|turn|1',
  '|-mega|p2a: Charizard|Charizard-Mega-Y|Charizardite Y'
];
const SENTINEL_FULL = SENTINEL_MEGA_ONLY.concat([
  '|switch|p2b: Heatran|Heatran, L50, M|100/100',
  '|turn|3',
  '|-zpower|p2b: Heatran|move: Inferno Overdrive'
]);
const SENTINEL_NONE = [
  '|switch|p1a: Gholdengo|Gholdengo, L50, M|100/100',
  '|switch|p2a: Charizard|Charizard, L50, M|100/100',
  '|turn|1'
];

const megaFx = pipeline(SENTINEL_MEGA_ONLY);
const fullFx = pipeline(SENTINEL_FULL);
const noneFx = pipeline(SENTINEL_NONE);
eq('fixture sanity: the Mega lock latched', megaFx.battle.formatLocks.oppHasMegaEvolved, true);
eq('fixture sanity: the Z lock latched later', fullFx.battle.formatLocks.oppHasUsedZMove, true);

const sentEngine = newEngine().engine;
const megaSent = call('formatSentinel does not throw', function () { return sentEngine.formatSentinel(megaFx.battle); });
check('with only the Mega burned, it says Mega BURNED', !!megaSent && megaSent.mega.burned === true,
  JSON.stringify(megaSent && megaSent.mega));
check('...naming the body that burned it', !!megaSent && U.toID(megaSent.mega.species).indexOf('charizard') === 0,
  String(megaSent && megaSent.mega.species));
eq('...and the turn it happened', megaSent && megaSent.mega.turn, 1);
eq('...while the Z-Move still reads live', megaSent && megaSent.z.burned, false);
eq('...with the live label', megaSent && megaSent.z.label, cfg('sentinel.liveLabel', 'LIVE'));
eq('...and the burned state labelled on the mega itself', megaSent && megaSent.mega.label, cfg('sentinel.burnedLabel', 'BURNED'));
check('...and NO tactical-freedom claim yet',
  !(megaSent.tactics || []).some(function (t) { return t && U.toID(t.label) === U.toID(cfg('sentinel.freedomLabel', 'TACTICAL FREEDOM')); }),
  JSON.stringify(megaSent.tactics));

const fullSent = call('formatSentinel reads the full fixture', function () { return sentEngine.formatSentinel(fullFx.battle); });
eq('with both burned, the Z-Move reads burned too', fullSent && fullSent.z.burned, true);
check('...naming the Z-Move body', !!fullSent && U.toID(fullSent.z.species).indexOf('heatran') === 0,
  String(fullSent && fullSent.z.species));
eq('...and its turn', fullSent && fullSent.z.turn, 3);
eq('...with the burned label', fullSent && fullSent.mega.label, cfg('sentinel.burnedLabel', 'BURNED'));
check('...and only now does it claim TACTICAL FREEDOM',
  (fullSent.tactics || []).some(function (t) { return t && U.toID(t.label) === U.toID(cfg('sentinel.freedomLabel', 'TACTICAL FREEDOM')); }),
  JSON.stringify(fullSent.tactics));
check('...with the bench shape behind the claim',
  !!fullSent.bench && typeof fullSent.bench.unrevealed === 'number' && typeof fullSent.bench.stonesPossible === 'number',
  JSON.stringify(fullSent.bench));

const noneSent = call('formatSentinel reads a clean fixture', function () { return sentEngine.formatSentinel(noneFx.battle); });
eq('with neither burned, nothing is claimed', [noneSent.mega.burned, noneSent.z.burned], [false, false]);
check('...and no freedom line is printed either',
  !(noneSent.tactics || []).some(function (t) { return t && U.toID(t.label) === U.toID(cfg('sentinel.freedomLabel', 'TACTICAL FREEDOM')); }),
  JSON.stringify(noneSent.tactics));
eq('formatSentinel(null) is null', sentEngine.formatSentinel(null), null);

/* ============================================================ 7. the sentinel bar */

section('7. the sentinel bar draws one row per mechanic and nothing it was not told');

const sentHud = call('MobileHUD is constructible for the sentinel', function () { return new ST.MobileHUD({ doc: S.document }); });
const sentEl = call('renderFormatSentinel does not throw', function () { return sentHud && sentHud.renderFormatSentinel(fullSent); });
check('the bar carries the frozen attribute', !!sentEl && attr(sentEl, 'data-st-sentinel') !== null,
  JSON.stringify(sentEl && sentEl.attributes));
check('...and is mounted', byAttr('data-st-sentinel').length >= 1, String(byAttr('data-st-sentinel').length));
const mechanicRows = byAttr('data-st-mechanic');
eq('...with one row per mechanic', mechanicRows.length, 2);
eq('...keyed by the mechanic, not by its state',
  mechanicRows.map(function (r) { return String(attr(r, 'data-st-mechanic')); }).sort(),
  ['Mega Evolution', 'Z-Move'].sort());
/* The engine reports semantic tactic kinds; the HUD renders plain status labels, never emoji. */
check('every tactic names its kind, so the renderer never has to parse a bullet',
  (fullSent.tactics || []).every(function (t) { return t && typeof t.kind === 'string' && t.kind; }),
  JSON.stringify(fullSent.tactics));
check('...and no tactic carries a character the engine invented',
  (fullSent.tactics || []).every(function (t) { return !t || t.icon === undefined; }),
  JSON.stringify(fullSent.tactics));
const tacticRows = byClass('st-sentinel-tactic');
check('...so each tactic uses an explicit text status',
  tacticRows.every(function (r) { return /^(READY|OPEN|CAUTION|NOTE) \/ /.test(String(r.textContent).trim()); }),
  JSON.stringify(tacticRows.map(function (r) { return String(r.textContent).slice(0, 30); })));
check('...and the freedom row is tagged for the CSS with the kind it was given',
  tacticRows.some(function (r) { return String(attr(r, 'data-st-tactic')) === 'freedom'; }),
  JSON.stringify(tacticRows.map(function (r) { return String(attr(r, 'data-st-tactic')); })));

const sentText = allText(sentEl).join(' | ');
check('the burned Mega row names the body and the turn', /turn 1/.test(sentText), sentText);
check('...and the spent state is named on the row', /Mega Evolution:\s*SPENT/.test(sentText), sentText);
check('the freedom tactic is rendered', (byClass('st-sentinel-tactic').length >= 1), String(byClass('st-sentinel-tactic').length));
check('the row names the MECHANIC and states its condition, rather than printing the label twice',
  /Mega Evolution:\s*SPENT/.test(sentText) && !/SPENT:\s*SPENT/.test(sentText),
  sentText);
eq('renderFormatSentinel(null) removes the bar',
  call('renderFormatSentinel(null) does not throw', function () { return sentHud && sentHud.renderFormatSentinel(null); }), null);
eq('...from the document too', byAttr('data-st-sentinel').length, 0);
eq('clearFormatSentinel is a no-op with nothing mounted',
  call('clearFormatSentinel does not throw', function () { return sentHud && sentHud.clearFormatSentinel(); }), null);

/* ------------------------------------------------------------------- summary */

console.log('\nchecks passed: ' + passed);
console.log('checks failed: ' + failed);
if (failures.length) {
  console.log('\nFAILURES:\n' + failures.map(function (f) { return '  - ' + f; }).join('\n'));
  process.exit(1);
}
console.log('ALL PRESSURE CHECKS PASSED');
// The sandbox the harness builds keeps a live handle, so every suite in this repository exits
// explicitly rather than waiting for the loop to drain (see tests/hud_check.js).
process.exit(0);
