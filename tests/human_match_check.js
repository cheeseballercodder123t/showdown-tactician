/* Showdown Tactician — tests/human_match_check.js
 *
 * WHY THIS EXISTS
 *   `tools/benchmark_human_match.js` produces the one number this project quotes about its own
 *   playing strength, and it produces it from a replay — a source that does not contain the two
 *   frames the decision engine is designed to read. Every layer of the tool is therefore a claim
 *   about what a log MEANS, and a claim about what a log means is exactly the kind of thing that
 *   has been wrong in this repo before (see the `|init|` and Knock Off entries in the changelog).
 *
 *   The three claims that matter, and that this suite pins:
 *     1. ACTION EXTRACTION. A log records results, not clicks. Speed order, a `[from]`-tagged move
 *        the player never chose (Sleep Talk, Metronome, Dancer), a forced replacement after a
 *        faint, and a pivot move's own switch (`[from] U-turn`) must all be told apart — or the
 *        benchmark silently scores consequences as decisions.
 *     2. THE MENU REPAIR. A replay has no `|request|`, so the engine's attack menu holds only the
 *        moves a body has already revealed. When the click is not in it, the tool adds it for that
 *        one decision. The repair has to be LIVE during `evaluateTurn` (it was not, in the first
 *        version of the tool: the injected move was removed before evaluation, so every
 *        first-use move was scored against a menu that could not contain it) and it has to be
 *        REMOVED afterwards so later turns see only what the log had revealed.
 *     3. THE SIDE FLIP. `state.mySide` is written only by a `|request|` line. Without setting it,
 *        a "p2" pass builds p1's team and scores p2's clicks against p1's bodies — which is
 *        invisible in the summary (it looks like a low score, not like a bug) and made every p2
 *        switch unscoreable. Pinned by the `unavailable` count on a real battle.
 *
 * Run me with:  node tests/human_match_check.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const H = require('./harness.js');
const BM = require('../tools/benchmark_human_match.js');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); return true; }
  failures.push(name + (detail === undefined ? '' : '  ->  ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  ->  ' + detail));
  return false;
}
function eq(name, got, want) {
  return check(name, JSON.stringify(got) === JSON.stringify(want),
    'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* ----------------------------------------------------------------- 1. log shapes */

section('1. linesOf / replaysOf normalize the corpus formats the pipeline already accepts');

eq('a string log is split on newlines', BM.linesOf('a\nb').length, 2);
eq('a carriage return is stripped', BM.linesOf('a\r\nb')[0], 'a');
eq('an array log passes through', BM.linesOf(['|a|', '|b|']).length, 2);
eq('null is an empty log, not a crash', BM.linesOf(null), ['']);
eq('an array corpus is accepted', BM.replaysOf([{ log: '' }]).length, 1);
eq('a {replays:[]} corpus is accepted', BM.replaysOf({ replays: [{ log: '' }] }).length, 1);
check('garbage is refused by name',
  (function () { try { BM.replaysOf({ nope: 1 }); return false; } catch (e) { return /must be an array of replays/.test(e.message); } })(),
  'no throw');
eq('a nickname details string yields the species', BM.speciesOf('Slowking-Galar, L50, M'), 'Slowking-Galar');
eq('an ident yields its side', BM.sideOfIdent('p2a: Water of Flood'), 'p2');
eq('a non-ident yields null', BM.sideOfIdent('100/100'), null);

/* ------------------------------------------------------- 2. what a log means */

section('2. classifySide tells a submitted click from a consequence');

const M = function (side, move, extra) {
  return '|move|' + side + 'a: Nick|' + move + '|p' + (side === 'p1' ? '2' : '1') + 'a: Theirs' + (extra || '');
};

let c = BM.classifySide([M('p1', 'Scald')], 'p1');
eq('one move is a scorable decision', c.status, 'scorable');
eq('...and its identity is the move id', c.action.moveId, 'scald');
eq('...with the kind recorded', c.action.kind, 'move');

c = BM.classifySide(['|switch|p1a: Flat Earth|Gliscor, M, shiny|100/100'], 'p1');
eq('one switch is a scorable decision', c.status, 'scorable');
eq('...and its identity is the species id, not the nickname', c.action.speciesId, 'gliscor');

eq('a called move (Sleep Talk) is NOT the player\'s click',
  BM.classifySide([M('p1', 'Body Slam', '|[from]Sleep Talk')], 'p1').status, 'unobservable');
eq('Metronome\'s called move is NOT the click',
  BM.classifySide([M('p1', 'Ice Beam', '|[from]Metronome')], 'p1').status, 'unobservable');
eq('Dancer\'s reaction is NOT the click',
  BM.classifySide([M('p1', 'Revelation Dance', '|[from]Dancer')], 'p1').status, 'unobservable');
eq('a plain move with a target has no [from] clause to trip over',
  BM.classifySide([M('p1', 'Scald')], 'p1').status, 'scorable');

eq('a |cant| turn shows no choice', BM.classifySide(['|cant|p1a: Nick|par|'], 'p1').status, 'cant');
eq('a |drag| is a consequence, not a choice',
  BM.classifySide(['|drag|p1a: Nick|Gliscor, M|100/100'], 'p1').status, 'unobservable');
eq('|replace| (an Illusion breaking) is not a choice',
  BM.classifySide(['|replace|p1a: Nick|Zoroark, M|100/100'], 'p1').status, 'unobservable');

/* The two morphologies that made ~12% of the corpus look ambiguous, and that the first version of
 * the tool threw away. Both must resolve to the MOVE the human clicked. */
const faintAndReplace = [M('p1', 'Mortal Spin'), '|faint|p1a: Nick', '|switch|p1a: Pinsir|Pinsir, M|100/100'];
c = BM.classifySide(faintAndReplace, 'p1');
eq('a forced replacement after a faint does not hide the click', c.status, 'scorable');
eq('...the captured action is the MOVE, not the replacement', c.action.kind, 'move');
eq('...and it is the right move', c.action.moveId, 'mortalspin');

const pivotSwitch = [M('p1', 'U-turn'), '|switch|p1a: Urshifu|Urshifu-Rapid-Strike, F|100/100|[from] U-turn'];
c = BM.classifySide(pivotSwitch, 'p1');
eq('a pivot move\'s own switch is not a second action', c.status, 'scorable');
eq('...so the captured action is the pivoting MOVE', c.action.moveId, 'uturn');

eq('a forced replacement with no move of its own is its own category',
  BM.classifySide(['|faint|p1a: Nick', '|switch|p1a: Pinsir|Pinsir, M|100/100'], 'p1').status, 'forcedSwitch');
eq('two genuine moves really are ambiguous',
  BM.classifySide([M('p1', 'Scald'), M('p1', 'Toxic Spikes')], 'p1').status, 'ambiguous');
eq('the other side\'s lines are ignored',
  BM.classifySide([M('p2', 'Scald')], 'p1').status, 'unobservable');

/* ----------------------------------------------------------------- 3. buckets */

section('3. extractChoices buckets the log on its own |turn| headers');

const LOG = [
  '|tier|[Gen 9] National Dex',
  '|switch|p1a: A|Great Tusk|100/100',
  '|turn|1',
  M('p1', 'Headlong Rush'),
  '|turn|2',
  M('p1', 'Rapid Spin'),
  M('p2', 'Scald')
].join('\n');
const parsed = BM.extractChoices(BM.linesOf(LOG));
eq('the format is read off the log', parsed.format, '[Gen 9] National Dex');
eq('bucket 0 holds the lead switches', parsed.turns[0].turn, 0);
eq('bucket 0 holds exactly the pre-turn lines', parsed.turns[0].lines.length, 2);
eq('turn headers become buckets', parsed.turns[1].turn, 1);
eq('turn 1 holds its own line only', parsed.turns[1].lines.length, 1);
eq('turn 2 holds both sides\' lines', parsed.turns[2].lines.length, 2);
eq('the |turn| header is not itself bucket content',
  parsed.turns[2].lines.some(function (l) { return /^\|turn\|/.test(l); }), false);

/* -------------------------------------------------------------- 4. identity */

section('4. an engine row and a human click reduce to the same key');

eq('a move click', BM.actionKey({ kind: 'move', moveName: 'Headlong Rush' }), 'move:headlongrush');
eq('a switch click', BM.actionKey({ kind: 'switch', species: 'Great Tusk' }), 'switch:greattusk');
eq('an engine move row', BM.actionKeyOf({ kind: 'move', name: 'Headlong Rush', moveId: 'headlongrush' }), 'move:headlongrush');
eq('a protect row is still a move for comparison', BM.actionKeyOf({ kind: 'protect', name: 'Baneful Bunker' }), 'move:banefulbunker');
eq('an engine switch row (targetId)',
  BM.actionKeyOf({ kind: 'switch', name: 'Great Tusk', targetId: 'Great Tusk' }), 'switch:greattusk');
eq('a switch row and a switch click meet', BM.actionKey({ kind: 'switch', species: 'great tusk' }), BM.actionKeyOf({ kind: 'switch', targetId: 'Great Tusk' }));
eq('a null action has no key', BM.actionKey(null), null);

/* ------------------------------------------------------------- 5. statistics */

section('5. the statistics are honest about small samples');

eq('an empty sample has no rate', BM.rate(0, 0), null);
eq('no decisions is a full-width interval', BM.wilson(0, 0), { lo: 0, hi: 1 });
const w = BM.wilson(50, 100);
check('a 50/100 interval brackets 0.5', w.lo < 0.5 && w.hi > 0.5, JSON.stringify(w));
check('a 50/100 interval is not degenerate', (w.hi - w.lo) > 0.15, JSON.stringify(w));
/* Wilson at p=1 never reaches exactly 1 on a finite sample, so the property to pin is "tight and
 * inside the unit interval", not "equals 1". */
check('100/100 stays inside the unit interval and tight',
  BM.wilson(100, 100).hi > 0.95 && BM.wilson(100, 100).hi <= 1, JSON.stringify(BM.wilson(100, 100)));
check('a bigger sample is a tighter interval',
  (BM.wilson(500, 1000).hi - BM.wilson(500, 1000).lo) < (w.hi - w.lo), '');

eq('a 30% rate reads as the low band', BM.eloBand(0.30).label.indexOf('<40%') === 0, true);
eq('a 45% rate reads as the mid band', BM.eloBand(0.45).label.indexOf('40-55%') === 0, true);
eq('a 60% rate reads as the high band', BM.eloBand(0.60).label.indexOf('55-65%') === 0, true);
eq('a 75% rate reads as the top band', BM.eloBand(0.75).label.indexOf('>70%') === 0, true);
eq('no rate has no band', BM.eloBand(null).label, 'n/a');
check('every band declares itself uncalibrated',
  [0.1, 0.42, 0.6, 0.8].every(function (r) { return BM.eloBand(r).calibrated === false; }), '');

eq('the turn buckets are 1-5 / 6-15 / 16+', [BM.bucketOf(1), BM.bucketOf(5), BM.bucketOf(6), BM.bucketOf(15), BM.bucketOf(16), BM.bucketOf(40)],
  ['opening', 'opening', 'mid', 'mid', 'endgame', 'endgame']);

/* ------------------------------------------- 6. summarize over hand-built records */

section('6. summarize counts what it says it counts');

const recs = [
  { status: 'scorable', turn: 3, side: 'p1', bucket: 'opening', top1: true, top2: true, vetoed: false, blind: false, offered: 2, contested: true, moveContested: true, action: { kind: 'move' }, top1Kind: 'move', key: 'move:a', bestMoveKey: 'move:a' },
  { status: 'scorable', turn: 7, side: 'p1', bucket: 'mid', top1: false, top2: true, vetoed: false, blind: true, offered: 4, contested: true, moveContested: true, action: { kind: 'move' }, top1Kind: 'switch', key: 'move:b', bestMoveKey: 'move:b' },
  { status: 'scorable', turn: 9, side: 'p2', bucket: 'mid', top1: false, top2: false, vetoed: true, vetoCode: 'SPEED_SUICIDE', blind: true, offered: 4, contested: true, moveContested: false, action: { kind: 'switch' }, top1Kind: 'switch', key: 'switch:c', bestMoveKey: 'move:c' },
  { status: 'scorable', turn: 20, side: 'p2', bucket: 'endgame', top1: true, top2: true, vetoed: false, blind: false, offered: 1, contested: false, moveContested: false, action: { kind: 'move' }, top1Kind: 'move', key: 'move:d', bestMoveKey: 'move:d' },
  { status: 'unobservable', turn: 4, side: 'p1', bucket: 'opening' },
  { status: 'forcedSwitch', turn: 4, side: 'p2', bucket: 'opening' }
];
const sum = BM.summarize(recs, { battles: 1, sides: ['p1', 'p2'] });
eq('scored decisions are counted', sum.all.n, 4);
eq('top-1 hits are counted', sum.all.top1, 2);
eq('top-2 hits are counted', sum.all.top2, 3);
eq('vetoes are counted', sum.all.vetoed, 1);
eq('blind clicks are counted', sum.all.blind, 2);
eq('the contested subset is the fair one', sum.contested.n, 3);
eq('move-vs-move is narrower still', sum.moveContested.n, 2);
eq('the revealed-only subset is the un-blinded one', sum.revealedOnly.n, 2);eq('non-scorable turns never enter a top-1 rate', sum.unobservable, undefined);
eq('...they land in skipped instead', sum.skipped.unobservable, 1);
eq('...including the new forced-switch category', sum.skipped.forcedSwitch, 1);
check('the skipped buckets account for every non-scorable record',
  Object.keys(sum.skipped).reduce(function (a, k) { return a + sum.skipped[k]; }, 0) === recs.length - sum.all.n,
  JSON.stringify(sum.skipped));
eq('the veto code is attributed', sum.vetoCodes.SPEED_SUICIDE, 1);
eq('turn buckets are tallied', [sum.buckets.opening.n, sum.buckets.mid.n, sum.buckets.endgame.n], [1, 2, 1]);
check('the uniform-pick floor is the mean of 1/offered',
  Math.abs(sum.chanceFloor.all - ((1 / 2 + 1 / 4 + 1 / 4 + 1 / 1) / 4)) < 1e-12, String(sum.chanceFloor.all));
check('the floor uses only the contested decisions',
  Math.abs(sum.chanceFloor.contested - ((1 / 2 + 1 / 4 + 1 / 4) / 3)) < 1e-12, String(sum.chanceFloor.contested));
check('the floor is always below a fair-share rate', sum.chanceFloor.all < 1, String(sum.chanceFloor.all));

eq('the pivot mix is measured against the human, not assumed',
  [sum.mix.n, sum.mix.humanSwitch, sum.mix.engineSwitch], [3, 1, 2]);

/* THE PIVOT CEILING is a bound on every switch-penalising change, so it has to be counted exactly:
 * how often the engine's own best NON-pivot line WAS the human's click on a turn it chose to pivot
 * anyway, and what top-1 a never-pivot policy would reach. Record 2 is the only pivot-over-attack
 * turn and its best non-pivot line IS the click; records 1 and 4 are moves it already got right. */
eq('the ceiling counts only MOVE clicks', sum.pivotCeiling.moveN, 3);
eq('...of which one preferred a pivot over an available attack', sum.pivotCeiling.pivotedN, 1);
eq('...on which the best non-pivot line WAS the human\'s click', sum.pivotCeiling.agree, 1);
eq('a never-pivot policy on those turns', sum.pivotCeiling.neverPivot, 3);
eq('...priced over the whole scored set too', [sum.pivotCeiling.neverPivotAll, sum.pivotCeiling.allN], [3, 4]);
check('a pivot-over-attack turn whose best non-pivot line is NOT the click does not count as agreement',
  BM.summarize([Object.assign({}, recs[1], { bestMoveKey: 'move:zzz' })], {}).pivotCeiling.agree === 0, '');
check('a record with no non-pivot line at all is not counted as the ceiling',
  BM.summarize([Object.assign({}, recs[1], { bestMoveKey: null })], {}).pivotCeiling.neverPivot === 0, '');
eq('an empty run has an all-zero ceiling rather than a division by zero',
  [BM.summarize([], {}).pivotCeiling.moveN, BM.summarize([], {}).pivotCeiling.neverPivot], [0, 0]);

/* The two halves are reported apart because they are not measured equally: one menu is complete and
 * the other is starved. If the split ever silently collapsed into the combined number, the weaker
 * (fair) half would disappear into the stronger (unfair) one. */
eq('the action kinds partition the scored set', sum.byKind.move.n + sum.byKind.switch.n, sum.all.n);
eq('...with the kinds counted separately', [sum.byKind.move.n, sum.byKind.switch.n], [3, 1]);
eq('...and each kind tallies its own hits', [sum.byKind.move.top1, sum.byKind.switch.top1], [2, 0]);
check('each kind carries its own uniform-pick floor',
  Math.abs(sum.chanceFloor.move - ((1 / 2 + 1 / 4 + 1 / 1) / 3)) < 1e-12 &&
  Math.abs(sum.chanceFloor.switch - 1 / 4) < 1e-12, JSON.stringify(sum.chanceFloor));
check('a kind with no decisions has no floor rather than a zero',
  BM.summarize([], {}).chanceFloor.move === null && BM.summarize([], {}).chanceFloor.switch === null, '');

/* ------------------------------------------------- 7. the engine, for real */

section('7. scoreDecision repairs the menu, and puts the board back');

const ST = H.loadAll({
  setInterval: function () { return 0; },
  clearInterval: function () { }
}).ST;
const U = ST.util;

const REAL = BM.linesOf(fs.readFileSync(path.join(ROOT, 'test_log.txt'), 'utf8'));
const realChoices = BM.extractChoices(REAL);

/* Build the decision state exactly as the tool does: p1's team from the log, mySide set. */
function stateAt(side, turn) {
  const parser = new ST.ProtocolParser();
  parser.setMySide(side);
  const mgr = new ST.BattleStateManager({ debug: false });
  mgr.attachParser(parser);
  mgr.state.mySide = side;
  mgr.state.oppSide = side === 'p1' ? 'p2' : 'p1';
  mgr.setFormat('gen9nationaldex');
  for (let i = 0; i < REAL.length; i++) {
    const m = /^\|turn\|(\d+)/.exec(REAL[i]);
    try { parser.feed(REAL[i]); } catch (e) { /* unmodelled lines are normal */ }
    if (m && (parseInt(m[1], 10) || 0) === turn) return mgr.state;
  }
  return null;
}

const TEAMS = { p1: 'Polteageist/Toxapex/Ditto/Lopunny/Kartana/Tapu Lele', p2: 'Slowking-Galar/Abomasnow/Hatterene/Crawdaunt/Ursaluna/Kingambit' };
['p1', 'p2'].forEach(function (side) {
  const st = stateAt(side, 1);
  eq('the ' + side + ' pass builds ' + side + '\'s own team', (st.myTeam || []).map(function (m) { return m && m.species; }).join('/'), TEAMS[side]);
  eq('...and files the other side as the opponent', (st.oppTeam || []).map(function (m) { return m && m.species; }).join('/'), TEAMS[side === 'p1' ? 'p2' : 'p1']);
  eq('state.mySide is the scored side', st.mySide, side);
});

/* The tool's own framing: at turn 1 the active body has revealed nothing, so the engine's menu has
 * no attack in it at all — the click genuinely is not available, and the repair is what makes the
 * decision scorable. Both halves are asserted, because a repair that did nothing would look the
 * same in the output. */
const engine = BM.buildEngine(ST);
const st1 = stateAt('p1', 1);
const turn1 = realChoices.turns.filter(function (t) { return t.turn === 1; })[0];
const cls1 = BM.classifySide(turn1.lines, 'p1');
eq('turn 1 of the real log yields a scorable decision', cls1.status, 'scorable');
eq('...and it was an attack', cls1.action.kind, 'move');

const offeredRaw = engine.getMyActions(st1).map(BM.actionKeyOf);
check('the click is NOT in the engine\'s unrepaired menu', offeredRaw.indexOf(BM.actionKey(cls1.action)) === -1,
  offeredRaw.join(','));
check('...the menu has no attack in it at all yet',
  offeredRaw.every(function (k) { return k.indexOf('move:') !== 0; }), offeredRaw.join(','));

const savedMoves = st1.legalActions.moves;
const rec1 = BM.scoreDecision(engine, st1, cls1, { U: U, turn: 1, side: 'p1', replay: 0 });
eq('the repaired decision is scorable', rec1.status, 'scorable');
check('the decision is not thrown out as "not offered"', rec1.status !== 'unavailable', String(rec1.status));
check('the blind flag is set for a first-use move', rec1.blind === true, String(rec1.blind));
check('the click was in the menu the engine actually evaluated', rec1.rank !== -1 || rec1.vetoed === true,
  'rank=' + rec1.rank + ' vetoed=' + rec1.vetoed);
check('a ranked outcome was produced', typeof rec1.top1 === 'boolean' && typeof rec1.top2 === 'boolean',
  JSON.stringify({ top1: rec1.top1, top2: rec1.top2 }));
check('the menu was restored on the way out (no leak into later turns)',
  st1.legalActions.moves === savedMoves, JSON.stringify(st1.legalActions.moves));
check('...and the restored menu is the one that was there before',
  JSON.stringify(engine.getMyActions(st1).map(BM.actionKeyOf)) === JSON.stringify(offeredRaw), '');

/* An already-revealed click is NOT rewritten: the repair only ever adds, so the menu the engine
 * sees for it is the one the log produced. */
const st3 = stateAt('p1', 3);
const savedMoves3 = st3.legalActions.moves;
const turn3 = realChoices.turns.filter(function (t) { return t.turn === 3; })[0];
const cls3 = BM.classifySide(turn3.lines, 'p1');
if (cls3.status === 'scorable' && cls3.action.kind === 'move') {
  const offered3Before = engine.getMyActions(st3).map(BM.actionKeyOf);
  const rec3 = BM.scoreDecision(engine, st3, cls3, { U: U, turn: 3, side: 'p1', replay: 0 });
  check('an already-revealed click is scored too', rec3.status === 'scorable', String(rec3.status));
  check('...without the menu being rewritten for it', st3.legalActions.moves === savedMoves3, JSON.stringify(st3.legalActions.moves));
  check('...and with the same menu it started with',
    JSON.stringify(engine.getMyActions(st3).map(BM.actionKeyOf)) === JSON.stringify(offered3Before), '');
} else {
  check('turn 3 of the fixture is an attack to test the no-repair path with', false,
    'status=' + cls3.status + ' kind=' + (cls3.action && cls3.action.kind));
}

/* evaluateTurn must not mutate the board — the whole measurement rests on it. */
const stA = stateAt('p1', 2);
const firstRun = engine.evaluateTurn(stA).map(BM.actionKeyOf).join(',');
const secondRun = engine.evaluateTurn(stA).map(BM.actionKeyOf).join(',');
eq('evaluateTurn is repeatable on an unchanged board', firstRun, secondRun);
check('...and it produced lines', firstRun.length > 0, firstRun);

/* ------------------------------------------------------------- 8. end to end */

section('8. end to end on the repo\'s real 30-turn battle');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-humanmatch-'));
const corpusPath = path.join(tmp, 'replays.json');
fs.writeFileSync(corpusPath, JSON.stringify({
  format: 'gen9nationaldex', minRating: 1800,
  replays: [{ id: 'test_log', rating: 1800, winner: 'p1', log: fs.readFileSync(path.join(ROOT, 'test_log.txt'), 'utf8') }]
}));

const runOpts = { input: corpusPath, battles: 0, minRating: null, side: 'both', format: null, json: false, out: null, quiet: true, help: false, assert: false };
const run1 = BM.run(runOpts);
const run2 = BM.run(runOpts);

check('the battle replayed without throwing', run1.summary.battlesErrored === 0, String(run1.summary.battlesErrored));
check('the format was accepted', run1.summary.battlesSkippedUnsupported === 0, String(run1.summary.battlesSkippedUnsupported));
check('decisions were evaluated', run1.summary.all.n > 20, String(run1.summary.all.n));
check('both sides were scored',
  run1.records.some(function (r) { return r.side === 'p1'; }) && run1.records.some(function (r) { return r.side === 'p2'; }), '');
check('top-1 hits never exceed the decisions', run1.summary.all.top1 <= run1.summary.all.n, '');
check('top-2 hits never fall below top-1', run1.summary.all.top2 >= run1.summary.all.top1, '');
check('the purity probe ran and passed', !!run1.summary.purity && run1.summary.purity.equal === true,
  JSON.stringify(run1.summary.purity));

/* THE SIDE-FLIP REGRESSION. With `state.mySide` left at its default the p2 pass scored p2's clicks
 * against p1's team, so every p2 switch was "not offered" — six of them on this battle. */
eq('no decision was unscoreable for a missing menu line (the side flip works)', run1.summary.skipped.unavailable, 0);
/* A switch-in may name a FORME of a team member — Abomasnow-Mega is the Abomasnow on p2's roster —
 * so both sides of the comparison are reduced to the base species before matching. */
const baseForm = function (id) { return String(id).replace(/(mega[xy]?|gmax|primal)$/, ''); };
check('each side only ever acted with its OWN bodies',
  (function () {
    const own = {
      p1: TEAMS.p1.split('/').map(function (s) { return baseForm(U.toID(s)); }),
      p2: TEAMS.p2.split('/').map(function (s) { return baseForm(U.toID(s)); })
    };
    /* EVERY record that carries an action, not just the scorable ones: a switch the engine never
     * offered is the exact symptom of the side flip, so excluding those would let the bug through. */
    return run1.records.every(function (r) {
      if (!r.action || r.action.kind !== 'switch') return true;
      return own[r.side].indexOf(baseForm(r.action.speciesId)) !== -1;
    });
  })(), 'a switch to a body that is not on that side');
check('...and a switch decision from EACH side was scored (a flipped side forfeits every one)',
  run1.records.filter(function (r) { return r.status === 'scorable' && r.side === 'p1' && r.action.kind === 'switch'; }).length > 0 &&
  run1.records.filter(function (r) { return r.status === 'scorable' && r.side === 'p2' && r.action.kind === 'switch'; }).length > 0, '');
check('...and an attack decision from each side too',
  run1.records.filter(function (r) { return r.status === 'scorable' && r.side === 'p1' && r.action.kind === 'move'; }).length > 0 &&
  run1.records.filter(function (r) { return r.status === 'scorable' && r.side === 'p2' && r.action.kind === 'move'; }).length > 0, '');
check('the skipped turns are accounted for, not dropped',
  Object.keys(run1.summary.skipped).reduce(function (a, k) { return a + run1.summary.skipped[k]; }, 0) > 0, '');
/* Byte-identical apart from the clock: `elapsedMs` is the only field not derived from the log, so
 * it is the only field allowed to differ between two runs of the same corpus. */
const clockless = function (s) { const c = JSON.parse(JSON.stringify(s)); c.elapsedMs = 0; return JSON.stringify(c); };
check('the same corpus twice is identical (deterministic, clock aside)',
  clockless(run1.summary) === clockless(run2.summary), '');
check('...including the same decisions',
  JSON.stringify(run1.records) === JSON.stringify(run2.records), '');
check('the report renders', typeof BM.render(run1.summary, runOpts) === 'string' && BM.render(run1.summary, runOpts).length > 200, '');
check('the rendered report names the lower-bound caveat',
  /LOWER BOUND/.test(BM.render(run1.summary, runOpts)), '');
check('the rendered report splits the two action kinds',
  /by action kind/.test(BM.render(run1.summary, runOpts)), '');
check('the rendered report warns against averaging the halves',
  /Do not average the two halves/.test(BM.render(run1.summary, runOpts)), '');
check('the rendered report refuses to call the band a rating',
  /UNCALIBRATED/.test(BM.render(run1.summary, runOpts)), '');

/* ------------------------------ 8b. the score gap, and consensus sets */

section('8b. the score gap (regret) and the consensus buckets');

/* THE METRIC, IN ISOLATION FIRST. `regretShare` has to be total at its edges, because the edges are
 * the common cases: a tie (the mixed equilibrium gives several rows the same value, and the ranking
 * still has to order them), a menu with no spread, and a click that took the worst line on offer. */
eq('a perfect pick has no regret', BM.regretShare(0, 100), 0);
eq('a pick at the bottom of the menu gives up the whole spread', BM.regretShare(100, 100), 1);
eq('...and nothing beyond it (a score cannot be worse than the worst on offer)', BM.regretShare(250, 100), 1);
eq('a tie broken against the human is NOT a loss', BM.regretShare(-40, 100), 0);
eq('a quarter of the spread is a quarter', BM.regretShare(25, 100), 0.25);
eq('a menu with no spread has no share to report', BM.regretShare(0, 0), 0);
eq('...but a positive gap against it is still the worst case', BM.regretShare(5, 0), 1);
eq('an undefined gap is unknown, not zero', BM.regretShare(null, 100), null);
eq('an undefined spread is unknown too', BM.regretShare(10, null), null);

/* The statistics over a slice, with the two bands the brief asks for. */
const gapRecs = [
  { regretShare: 0, regret: 0, regretRatio: 0 },
  { regretShare: 0.02, regret: 4, regretRatio: 0.01 },
  { regretShare: 0.04, regret: 8, regretRatio: 0.02 },
  { regretShare: 0.5, regret: 100, regretRatio: 0.25 },
  { regretShare: 0.9, regret: 180, regretRatio: 0.45 },
  { regretShare: null, regret: null, regretRatio: null }
];
const gaps = BM.regretStats(gapRecs);
eq('every record is in the slice', gaps.n, 6);
eq('...but only the ones with a defined share are measured', gaps.measured, 5);
eq('within 5 % of the spread is the "a wash" band', gaps.nearTop5, 3);
eq('30 % or worse is the "the engine says the human blundered" band', gaps.worseThan30, 2);
check('the median share is the middle of the measured ones',
  Math.abs(gaps.median - 0.04) < 1e-12, String(gaps.median));
check('the raw units ride along, so the shares can be sanity-checked',
  gaps.unitsMeasured === 5 && gaps.medianUnits === 8 && Math.abs(gaps.meanUnits - 58.4) < 1e-9,
  JSON.stringify([gaps.unitsMeasured, gaps.medianUnits, gaps.meanUnits]));
eq('the literal "within 5 % of the pick" is counted separately', gaps.nearTop5Ratio, 3);
eq('...and the 30 % band is counted in that same framing, not only in the spread one', gaps.worseThan30Ratio, 1);
check('both framings report both bands, so a slice can be compared with itself',
  typeof gaps.worseThan30Ratio === 'number' && typeof gaps.nearTop5Ratio === 'number' &&
    gaps.worseThan30Ratio <= gaps.measured && gaps.nearTop5Ratio <= gaps.measured,
  JSON.stringify([gaps.measured, gaps.nearTop5Ratio, gaps.worseThan30Ratio]));

/* THE BUCKET KEY. Coarse on purpose, and it must move when the things it is supposed to hold apart
 * move: a different active pair is a different bucket, an HP quintile is not. */
const key1 = BM.stateKeyOf(st1);
const key2 = BM.stateKeyOf(st1);
eq('the same board keys the same', key1, key2);
check('the key names the active pair, the HP quintiles and the field',
  /^[a-z0-9]+\|[a-z0-9]+\|[0-4?]\|[0-4?]\|(tr|-)\|/.test(key1), key1);
const shifted = JSON.parse(JSON.stringify(st1));
shifted.active.opp.species = 'Garchomp';
check('a different opposing body is a different bucket', BM.stateKeyOf(shifted) !== key1, BM.stateKeyOf(shifted));
const hpShift = JSON.parse(JSON.stringify(st1));
hpShift.active.my.hpPercent = (st1.active.my.hpPercent || 0) >= 60 ? 10 : 90;
check('...and a different HP quintile is too', BM.stateKeyOf(hpShift) !== key1, BM.stateKeyOf(hpShift));

/* CONSENSUS SETS. Six decisions in ONE bucket, where the engine's top pick is the most-clicked line
 * on four of them and a line nobody clicked on two — so the bucket's top-3 must contain it, and the
 * decision-level top-1 rate (2/6) must NOT be what the consensus number reports. Plus a bucket with
 * three decisions, which is under MIN_CONSENSUS_N and must be excluded from the rate while still
 * being listed. */
const cons = [];
const K_A = 'greattusk|kingambit|4|4|-|-|-|h2';
const K_B = 'dragonite|gholdengo|4|4|-|-|-|h2';
/* The COARSE key the consensus pass reports on: the matchup, ignoring HP and field. */
const P_A = 'greattusk vs kingambit';
const P_B = 'dragonite vs gholdengo';
[0, 1, 2, 3, 4, 5].forEach(function (i) {
  const engineTop = i < 4 ? 'move:icespinner' : 'switch:ironvaliant';
  const human = i < 4 ? 'move:icespinner' : 'move:closecombat';
  cons.push({
    status: 'scorable', turn: 6, side: 'p1', bucket: 'mid', stateKey: K_A, pairKey: P_A,
    key: human, topKeys: [engineTop, 'move:rapidspin'], top1: engineTop === human, top2: false,
    contested: true, moveContested: true, blind: false, vetoed: false, offered: 4,
    action: { kind: 'move' }, top1Kind: 'move',
    regretShare: engineTop === human ? 0 : 0.5, regret: engineTop === human ? 0 : 60, regretRatio: 0.1
  });
});
[0, 1, 2].forEach(function () {
  cons.push({
    status: 'scorable', turn: 9, side: 'p1', bucket: 'mid', stateKey: K_B, pairKey: P_B,
    key: 'move:shadowball', topKeys: ['move:shadowball'], top1: true, top2: true,
    contested: true, moveContested: true, blind: false, vetoed: false, offered: 2,
    action: { kind: 'move' }, top1Kind: 'move', regretShare: 0, regret: 0, regretRatio: 0
  });
});
const csum = BM.summarize(cons, { battles: 1, sides: ['p1'], originalN: 9, minRating: 1700 });
eq('both PAIR buckets are listed', csum.consensus.buckets, 2);
eq('...but only the one at or above MIN_CONSENSUS_N is rated', csum.consensus.qualifying, 1);
eq('the fine partition is reported beside it, as the diagnostic', csum.consensus.qualifyingFine, 1);
eq('...with its own (far thinner) bucket count', csum.consensus.fineBuckets, 2);
eq('...and MIN_CONSENSUS_N is the documented 5', csum.consensus.minN, BM.MIN_CONSENSUS_N);
eq('the rated bucket covers its six decisions', csum.consensus.decisionsCovered, 6);
eq('the engine top pick IS in that bucket\'s three most-clicked lines', csum.consensus.engineTop1InTop3, 1);
const bigBucket = csum.consensus.top.filter(function (b) { return b.key === P_A; })[0];
check('...because Ice Spinner is what the humans clicked most',
  bigBucket.humanTop3[0].key === 'move:icespinner' && bigBucket.humanTop3[0].n === 4,
  JSON.stringify(bigBucket.humanTop3));
eq('...and the engine\'s modal pick there is Ice Spinner too', bigBucket.engineTopKey, 'move:icespinner');
const smallBucket = csum.consensus.fineTop.filter(function (b) { return b.key === K_B; })[0];
check('the decisions in a bucket are a POPULATION, not one click: 6 here, 3 in the thin one',
  bigBucket.n === 6 && smallBucket.n === 3 && csum.buckets.mid.n === 9,
  JSON.stringify([bigBucket.n, smallBucket.n, csum.buckets.mid.n]));
check('the coarse bucket reports the strength of its own consensus',
  Math.abs(bigBucket.humanTop1Share - (4 / 6)) < 1e-12 && bigBucket.humanTop1 === 'move:icespinner',
  JSON.stringify([bigBucket.humanTop1, bigBucket.humanTop1Share]));
check('a bucket with no clicks has no consensus to report (and is never counted)',
  csum.consensus.humanTop1ShareMean !== null && csum.consensus.distinctHumanMean !== null,
  JSON.stringify([csum.consensus.humanTop1ShareMean, csum.consensus.distinctHumanMean]));
check('the pair key ignores HP and field, and keeps the matchup',
  BM.matchupKeyOf(st1) === BM.matchupKeyOf(hpShift) && BM.matchupKeyOf(st1) === BM.matchupKeyOf(JSON.parse(JSON.stringify(st1))),
  BM.matchupKeyOf(st1));
check('the score-gap slices are in the summary',
  csum.regret && csum.regret.all.measured === 9 && csum.regret.contested.measured === 9 &&
    csum.regret.byBucket.mid.measured === 9, JSON.stringify(Object.keys(csum.regret || {})));
check('the render prints the score gap and the consensus block',
  /WHAT THE HUMAN GAVE UP/.test(BM.render(csum, runOpts)) &&
    /CONSENSUS SETS/.test(BM.render(csum, runOpts)) &&
    /NOT in the human top-3|IN the human top-3/.test(BM.render(csum, runOpts)), '');

/* THE FLATNESS TEST, in isolation. It has to be a claim about the EVIDENCE: three buckets with the
 * same rate are not distinguishable, a 20-point gap at n=100 each IS, and the same gap on two
 * decisions is not. And a perfect-versus-zero split has no standard error at all, which must read as
 * "not flat" rather than as the flat verdict a zero z-score would otherwise produce. */
const flat3 = BM.extremeSpread([
  { name: 'opening', k: 40, n: 100 }, { name: 'mid', k: 40, n: 100 }, { name: 'endgame', k: 40, n: 100 }
]);
check('three identical buckets are FLAT — and on a tie the extremes are the first entry, not a fiction',
  flat3.flat && flat3.z === 0 && flat3.p1 === flat3.p2 &&
    flat3.best === 'opening' && flat3.worst === 'opening',
  JSON.stringify(flat3));
const split3 = BM.extremeSpread([
  { name: 'opening', k: 60, n: 100 }, { name: 'mid', k: 40, n: 100 }, { name: 'endgame', k: 55, n: 100 }
]);
check('a 20-point gap between the extremes at n=100 is NOT flat',
  !split3.flat && split3.best === 'opening' && split3.worst === 'mid' && split3.z > 2,
  JSON.stringify([split3.best, split3.worst, split3.gap, split3.z]));
const thin3 = BM.extremeSpread([
  { name: 'opening', k: 1, n: 2 }, { name: 'mid', k: 1, n: 2 }, { name: 'endgame', k: 0, n: 2 }
]);
check('the same gap on two decisions is FLAT — the verdict is about the evidence',
  thin3.flat && thin3.gap === 0.5, JSON.stringify([thin3.gap, thin3.z]));
check('...and one usable bucket is no test at all, so it reports null rather than a verdict',
  BM.extremeSpread([{ name: 'opening', k: 1, n: 2 }, { name: 'mid', k: 0, n: 0 }]) === null, 'reported something');
check('a perfect-vs-zero split has no standard error and must NOT read as FLAT',
  BM.extremeSpread([{ name: 'opening', k: 10, n: 10 }, { name: 'mid', k: 0, n: 10 }]).flat === false,
  'read as flat');

/* THE CONSENSUS SET THROUGH THE GAP. Bucket A's four Ice Spinner clicks are washes and its two Close
 * Combat clicks are not, so the modal line is 4/4 while the bucket as a whole is 4/6 — and the pooled
 * figure over the qualifying buckets must be that same 4/6, because only A qualifies. The thin
 * bucket's three shadow-ball clicks are washes too, so a pooled rate that ignored MIN_CONSENSUS_N
 * would read 7/9 and hide the difference. */
check('the bucket carries the gap of its modal line, not only its click share',
  bigBucket.humanTop1WashShare === 1 && bigBucket.clickWashN === 4 &&
    Math.abs(bigBucket.clickWashShare - 4 / 6) < 1e-12,
  JSON.stringify([bigBucket.humanTop1WashShare, bigBucket.clickWashN, bigBucket.clickWashShare]));
check('...and the consensus rate is the macro average over the QUALIFYING buckets',
  Math.abs(csum.consensus.humanTop1WashShareMean - 1) < 1e-12 &&
    Math.abs(csum.consensus.pooledClickWashShare - 4 / 6) < 1e-12,
  JSON.stringify([csum.consensus.humanTop1WashShareMean, csum.consensus.pooledClickWashShare]));
check('...so a thin bucket cannot move the pooled rate (7/9 would be the unguarded answer)',
  Math.abs(csum.consensus.pooledClickWashShare - 7 / 9) > 1e-9,
  String(csum.consensus.pooledClickWashShare));
check('the render reads the consensus set through the gap as well as through agreement',
  /scored by the gap instead/.test(BM.render(csum, runOpts)), '');

/* THE DEGENERATE BUCKET, which is the failure this rate had BEFORE it was written this way. A bucket
 * where elites clicked three distinct lines or fewer has its top-3 equal to every line clicked, so
 * "the engine's pick was in the top-3" is true there no matter what the engine picked — a guaranteed
 * HIT. Pooling one of those with one honest miss gives 50 %, which reads as a respectable rate and is
 * nothing of the kind; over the qualifying buckets that are informative it is 0 %. Both numbers are
 * pinned here, along with the two floors and the menu floor's arithmetic. */
const degen = [];
const K_C = 'ironvaliant|garchomp|4|4|-|-|-|-';
const K_D = 'slowkinggalar|tinglu|4|4|-|-|-|-';
[['move:a', 'move:b', 'move:c', 'move:d'], ['move:a', 'move:b', 'move:c', 'move:d']].forEach(function (v, rep2) {
  [0, 1, 2, 3].forEach(function (i) {
    degen.push({
      status: 'scorable', turn: 4, side: 'p1', bucket: 'mid', stateKey: K_C, pairKey: 'ironvaliant vs garchomp',
      key: i === 1 && rep2 === 0 ? 'move:b' : v[i], topKeys: ['move:neverclicked', 'move:a'], top1: false, top2: false,
      contested: true, moveContested: true, blind: false, vetoed: false, offered: 6,
      action: { kind: 'move', moveId: v[i].slice(5) }, top1Kind: 'move',
      regretShare: 0.6, regret: 60, regretRatio: 0.3
    });
  });
});
[0, 1, 2, 3, 4, 5].forEach(function (i) {
  degen.push({
    status: 'scorable', turn: 4, side: 'p1', bucket: 'mid', stateKey: K_D, pairKey: 'slowkinggalar vs tinglu',
    key: i < 3 ? 'move:sludgebomb' : 'move:earthpower', topKeys: ['move:sludgebomb', 'move:earthpower'],
    top1: true, top2: true, contested: true, moveContested: true, blind: false, vetoed: false, offered: 6,
    action: { kind: 'move' }, top1Kind: 'move', regretShare: 0, regret: 0, regretRatio: 0
  });
});
const dsum = BM.summarize(degen, { battles: 1, sides: ['p1'] });
eq('both buckets qualify, so the pooled rate has both to count', dsum.consensus.qualifying, 2);
eq('...but only the four-distinct-line bucket can say anything', dsum.consensus.informative, 1);
eq('...and the three-line bucket is counted out loud as degenerate', dsum.consensus.degenerate, 1);
eq('the informative bucket covers its own eight decisions only', dsum.consensus.informativeDecisions, 8);
eq('in the informative bucket the engine\'s pick is NOT in the human top-3', dsum.consensus.engineTop1InTop3Informative, 0);
eq('...while the pooled rate over both buckets reads as a hit — half of it guaranteed by construction',
  dsum.consensus.engineTop1InTop3, 1);
eq('the two floors are computed over the informative buckets only', dsum.consensus.chanceFloorInformative, 3 / 4);
check('...and the menu floor is the faithful one: a random line from a 6-line menu, at most 3/6',
  dsum.consensus.menuChanceFloorInformative === 0.5, String(dsum.consensus.menuChanceFloorInformative));
check('the render quotes the informative rate and names the degenerate ones it left out',
  /DEGENERATE for the top-3 test/.test(BM.render(dsum, runOpts)) &&
    /engine top pick in the human top-3   0\.0%/.test(BM.render(dsum, runOpts)), '');
check('...and it says which floor is the faithful baseline and which is not',
  /random line from the engine\'s own menu, at MOST/.test(BM.render(dsum, runOpts)) &&
    /random draw among the lines ELITES clicked/.test(BM.render(dsum, runOpts)), '');

/* THE TURN BUCKETS. `flatness` is built from the same two tallies the bucket table prints. The
 * fixture has decisions in one bucket only, so it must decline to give a verdict — a tool that
 * printed "FLAT" from a single populated phase would be claiming a test it did not run. */
check('one populated turn bucket is no phase test: no verdict, and minBucketN says why',
  csum.flatness.agreement === null && csum.flatness.wash === null && csum.flatness.minBucketN === 0,
  JSON.stringify([csum.flatness.agreement, csum.flatness.wash, csum.flatness.minBucketN]));
check('...and the render of that summary does not print a verdict it cannot support',
  !/IS THE AGGREGATE HIDING A PHASE/.test(BM.render(csum, runOpts)), 'printed a verdict anyway');

/* THE REAL BATTLE, end to end: the gap the tool reports for a human click has to be the gap between
 * the two rows it just printed, or the metric is decorative. */
const scoredReal = [
  BM.scoreDecision(engine, stateAt('p1', 1), BM.classifySide(realChoices.turns.filter(function (t) { return t.turn === 1; })[0].lines, 'p1'), { U: U, turn: 1, side: 'p1', replay: 0 }),
  BM.scoreDecision(engine, stateAt('p1', 3), BM.classifySide(realChoices.turns.filter(function (t) { return t.turn === 3; })[0].lines, 'p1'), { U: U, turn: 3, side: 'p1', replay: 0 }),
  BM.scoreDecision(engine, stateAt('p1', 6), BM.classifySide(realChoices.turns.filter(function (t) { return t.turn === 6; })[0].lines, 'p1'), { U: U, turn: 6, side: 'p1', replay: 0 })
];
check('every scorable decision on the real battle carries a score gap',
  scoredReal.every(function (r) { return r.status !== 'scorable' || typeof r.regretShare === 'number'; }),
  JSON.stringify(scoredReal.map(function (r) { return [r.status, r.regretShare]; })));
check('...as the difference of the two scores the ranking published',
  scoredReal.every(function (r) {
    if (r.status !== 'scorable') return true;
    if (r.top1) return r.regretShare === 0;
    return r.humanScore <= r.topScore && r.regret === r.topScore - r.humanScore;
  }), JSON.stringify(scoredReal.map(function (r) { return [r.topScore, r.humanScore, r.regret, r.regretShare]; })));
check('...and the spread is the range the engine put on that turn\'s menu',
  scoredReal.every(function (r) { return r.status !== 'scorable' || (r.spread === null || r.spread >= 0); }),
  JSON.stringify(scoredReal.map(function (r) { return r.spread; })));
check('...with the bucket key attached to each one',
  scoredReal.every(function (r) { return r.status !== 'scorable' || typeof r.stateKey === 'string'; }),
  JSON.stringify(scoredReal.map(function (r) { return r.stateKey; })));

const realSum = BM.summarize(scoredReal.concat(run1.records), { battles: 1, sides: ['p1', 'p2'] });
check('the real corpus reports a measured share on most decisions',
  realSum.regret.all.measured >= 20 && realSum.regret.all.measured <= realSum.regret.all.n,
  JSON.stringify([realSum.regret.all.measured, realSum.regret.all.n]));
check('...and the 5 % and 30 % bands are counted over that same denominator',
  realSum.regret.all.nearTop5 + realSum.regret.all.worseThan30 <= realSum.regret.all.measured,
  JSON.stringify(realSum.regret.all));

/* THE PHASE TEST ON REAL DECISIONS, which is the only place it can be exercised: a real 30-turn
 * battle covers all three buckets, so a verdict exists, and the levels it compares must add up to
 * the same decisions the rest of the report counts. */
check('a real battle spans more than one turn bucket, so the phase test can run',
  realSum.flatness.agreement !== null && realSum.flatness.wash !== null,
  JSON.stringify([realSum.flatness.agreement && realSum.flatness.agreement.flat, realSum.flatness.wash && realSum.flatness.wash.flat]));
check('the flatness levels are the same decisions the summary counts',
  realSum.flatness.levels.reduce(function (a, l) { return a + l.n; }, 0) === realSum.all.n &&
    realSum.flatness.minBucketN > 0,
  JSON.stringify([realSum.flatness.levels, realSum.all.n, realSum.flatness.minBucketN]));
check('...and the gap verdict is built over the decisions where a share was defined, not over n',
  realSum.flatness.levels.every(function (l) { return l.measured <= l.n; }) &&
    realSum.flatness.wash.bestN === realSum.flatness.levels.filter(function (l) { return l.name === realSum.flatness.wash.best; })[0].measured,
  JSON.stringify(realSum.flatness.wash));
check('the render states the verdict with the numbers it compared',
  /IS THE AGGREGATE HIDING A PHASE/.test(BM.render(realSum, runOpts)) &&
    /FLAT at this n|NOT flat/.test(BM.render(realSum, runOpts)) &&
    /best-vs-worst/.test(BM.render(realSum, runOpts)), '');
check('the render leads with the gap and labels agreement as the proxy',
  /HEADLINE — the gap, not the agreement/.test(BM.render(realSum, runOpts)) &&
    /counted beside it, not instead of it/.test(BM.render(realSum, runOpts)), '');

/* ------------------------------------------------------------------ 9. CLI */

section('9. the command line refuses what it cannot do');

const d = BM.parseArgs([]);
eq('the default side set is both', d.side, 'both');
eq('the default battle count is a finite sample', d.battles, 100);
eq('--battles 0 means every battle', BM.parseArgs(['--battles', '0']).battles, 0);
eq('--side p2 is accepted', BM.parseArgs(['--side', 'p2']).side, 'p2');
check('a bogus side is refused',
  (function () { try { BM.parseArgs(['--side', 'p3']); return false; } catch (e) { return /must be both, p1 or p2/.test(e.message); } })(), '');
check('an unknown flag is refused',
  (function () { try { BM.parseArgs(['--turbo']); return false; } catch (e) { return /unknown argument/.test(e.message); } })(), '');
check('a missing value is refused',
  (function () { try { BM.parseArgs(['--input']); return false; } catch (e) { return /needs a value/.test(e.message); } })(), '');
check('a missing corpus names the path it looked for',
  (function () {
    try { BM.loadCorpus('does/not/exist.json'); return false; }
    catch (e) { return /no corpus at/.test(e.message) && /does\/not\/exist\.json/.test(e.message) || /exist\.json/.test(e.message); }
  })(), '');
eq('a stride sample is the requested size', BM.strideSample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3).length, 3);
eq('a stride sample of everything is everything', BM.strideSample([1, 2, 3], 5).length, 3);
check('a stride sample spreads across the list, not the front',
  BM.strideSample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)[2] > 5, JSON.stringify(BM.strideSample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)));

/* ------------------------------------------------------------------ report */

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }

console.log('');
if (failures.length) {
  console.error('FAILED: ' + failures.length + ' of ' + (passed + failures.length) + ' checks');
  failures.forEach(function (f) { console.error('  - ' + f); });
  process.exit(1);
}
console.log('ALL HUMAN-MATCH CHECKS PASSED (' + passed + ')');
process.exit(0);
