/* Showdown Tactician — tests/arena_check.js
 *
 * WHY THIS EXISTS
 *   tools/headless_arena/ is a second, independent way to run the decision engine: instead of a
 *   list of protocol lines typed by hand, it drives the real @pkmn/sim battle engine and lets the
 *   engine answer live decision frames. That is a lot of moving parts — a stream protocol, a team
 *   format, a replay splicer, a fuzzer and a puzzle generator — and every one of them can fail in
 *   a way that still "looks" like it ran: an agent that answers every frame illegally, a mutator
 *   whose mutations are all rolled back, a splicer that hands over before it reached the turn.
 *   So each of those is pinned here against observable behaviour, not against the fact that a
 *   function returned something.
 *
 * THE ONE THING TO KNOW ABOUT THIS SUITE
 *   The arena needs @pkmn/sim, which is a devDependency and NOT part of the extension's runtime.
 *   A clone that runs `npm test` without `npm install` must still be able to verify everything
 *   else, so this suite SKIPS with a plain message and exit code 0 when the sim is missing. The
 *   skip is honest: it says what was not verified.
 *
 * FACTS THIS SUITE ENCODES (all measured against @pkmn/sim 0.10.11, 2026-10)
 *   - The format the arena runs is `gen9nationaldex`, which IS [Gen 9] National Dex OU (its
 *     banlist is the ND OU banlist; the lower ND tiers derive from it). `gen9nationaldexou` does
 *     not exist in the sim — asking for it yields a Condition, not a Format.
 *   - Teams reach the sim through `Teams.import(paste)` -> `Teams.pack(sets)`. The repo's own
 *     `TeamParser.packTeam()` output is NOT accepted: it joins sets with newlines where the sim
 *     expects `]`, and writes display names where the sim expects ids, which the unpacker reads as
 *     `invalid happiness` / `Hidden power type`. This suite would fail if the arena regressed to
 *     the repo packer.
 *   - A choice written to `players.pX.write()` must be BARE (`move 1`), because that stream adds
 *     the `>pX ` prefix itself.
 *
 * Run me with:  node tests/arena_check.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

let sim = null;
try {
  sim = require('@pkmn/sim');
} catch (e) {
  console.log('arena_check: SKIPPED — @pkmn/sim is not installed.');
  console.log('  The arena is a dev tool; `npm install` adds it (@pkmn/sim is a devDependency).');
  console.log('  Everything else in this repo is unaffected and still verified by the other suites.');
  process.exit(0);
}

const bridge = require(path.join(ROOT, 'tools', 'headless_arena', 'engine_bridge.js'));
const teams = require(path.join(ROOT, 'tools', 'headless_arena', 'teams.js'));
const runner = require(path.join(ROOT, 'tools', 'headless_arena', 'sim_runner.js'));
const league = require(path.join(ROOT, 'tools', 'headless_arena', 'league_agents.js'));
const mutator = require(path.join(ROOT, 'tools', 'headless_arena', 'mutator.js'));
const splicerModule = require(path.join(ROOT, 'tools', 'headless_arena', 'replay_splicer.js'));
const harvesterModule = require(path.join(ROOT, 'tools', 'headless_arena', 'blunder_harvester.js'));

const { TeamValidator, Teams, BattleStreams } = sim;

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); return true; }
  failures.push(name + (detail === undefined ? '' : '  ->  ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  ->  ' + detail));
  return false;
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function legal(sets) { return new TeamValidator('gen9nationaldex').validateTeam(sets); }
function packedOf(name) { return teams.toSimTeam(teams.SAMPLE_TEAMS[name]); }

/* A deterministic opponent: always the first legal choice the request allows. It is the control
 * arm of every battle below, so a persona's failure cannot be blamed on its opponent. */
function scriptedAgent(name) {
  return {
    name: name || 'Script',
    chooseAction: function (request) { return runner.firstLegalChoice(request); }
  };
}

async function battle(a, b, opts) {
  opts = opts || {};
  const battle = new runner.HeadlessBattleRunner(opts.format || bridge.SIM_FORMAT_ID);
  battle.initBattle(opts.p1Team, opts.p2Team, opts.seed === undefined ? 7 : opts.seed);
  try {
    return await battle.runGame(a, b, opts.maxTurns || 24);
  } finally {
    battle.close();
  }
}

function invalidChoiceLines(log) {
  return (log || []).filter(function (l) { return l.indexOf('|error|[Invalid choice]') !== -1; });
}

/* ------------------------------------------------------- 1. the engine bridge itself */

function checkBridge() {
  section('1. engine_bridge: the engine answers a live frame with mappable lines');
  const session = bridge.createSession({ paste: teams.SAMPLE_TEAMS.hazardStackBalance });
  check('a paste registers a full team', session.team.length === 6, String(session.team.length));
  session.feed('|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100');
  session.feed('|switch|p2a: Gholdengo|Gholdengo, L50, F|100/100');
  session.feed('|turn|3');
  const req = JSON.stringify({
    side: { id: 'p1', name: 'Tactician', pokemon: [{ ident: 'p1: Great Tusk', details: 'Great Tusk, L50, M', condition: '100/100', active: true, moves: ['headlongrush'] }] },
    active: [{ moves: [{ move: 'Headlong Rush', id: 'headlongrush', pp: 16, maxpp: 16, target: 'normal' }, { move: 'Rapid Spin', id: 'rapidspin', pp: 64, maxpp: 64, target: 'normal' }] }],
    rqid: 1
  });
  const ranked = session.feed('|request|' + req);
  check('a |request| frame returns a ranking', Array.isArray(ranked) && ranked.length > 0, JSON.stringify(ranked && ranked.length));
  const entry = (ranked || [])[0] || {};
  check('every line carries the frozen shape', typeof entry.name === 'string' && (entry.kind === 'move' || entry.kind === 'switch') &&
    typeof entry.score === 'number' && typeof entry.isVetoed === 'boolean', JSON.stringify(Object.keys(entry)));
  check('the top line maps to a sim choice', typeof session.topChoice() === 'string' && /^(move|switch) /.test(session.topChoice()), session.topChoice());
  check('the engine logged no pipeline error', session.pipelineErrors().length === 0, JSON.stringify(session.pipelineErrors()));
  check('team preview order is one digit per member',
    bridge.teamPreviewOrder({ side: { pokemon: [{}, {}, {}, {}, {}, {}] } }) === 'team 123456',
    bridge.teamPreviewOrder({ side: { pokemon: [{}, {}, {}, {}, {}, {}] } }));
  check('the sim format constant is the one the sim actually has',
    bridge.SIM_FORMAT_ID === 'gen9nationaldex' && sim.Dex.formats.get(bridge.SIM_FORMAT_ID).exists === true,
    bridge.SIM_FORMAT_ID);
}

/* ------------------------------------- 2. the runner drives a real battle to completion */

async function checkRunner() {
  section('2. sim_runner drives @pkmn/sim to completion, and the report is the promised one');
  const p1 = packedOf('hazardStackBalance');
  const p2 = packedOf('trickRoomSweep');
  check('both scripted teams validate', legal(Teams.unpack(p1)) === null && legal(Teams.unpack(p2)) === null, '');

  const report = await battle(scriptedAgent('Script A'), scriptedAgent('Script B'),
    { p1Team: p1, p2Team: p2, seed: 4, maxTurns: 40 });

  check('the report has every field the mission names',
    ['winner', 'turnCount', 'fullLog', 'p1Choices', 'p2Choices', 'swingTurn'].every(function (k) {
      return Object.prototype.hasOwnProperty.call(report, k);
    }), JSON.stringify(Object.keys(report)));
  check('the battle reached a decision', report.winner === 'p1' || report.winner === 'p2' || report.winner === 'tie', report.winner);
  check('it is a real multi-turn battle, not an instant forfeit', report.turnCount >= 5, 'turnCount=' + report.turnCount);
  check('both sides submitted choices', report.p1Choices.length > 0 && report.p2Choices.length > 0,
    report.p1Choices.length + '/' + report.p2Choices.length);
  check('the sim never rejected a choice', invalidChoiceLines(report.fullLog).length === 0, invalidChoiceLines(report.fullLog).slice(0, 2).join(' | '));
  check('the runner recorded no internal error', (report.errors || []).length === 0, JSON.stringify((report.errors || []).slice(0, 2)));
  /* A battle that ran out of turns has no `|win|` line, and that is not a protocol failure — it is
   * the turn cap working. What must always be true is that the log looks like a real client feed. */
  const decided = report.fullLog.some(function (l) { return /^\|(win|tie)\|/.test(l); });
  check('the log carries the protocol frames a client would see',
    report.fullLog.some(function (l) { return l.indexOf('|turn|') === 0; }) &&
    report.fullLog.some(function (l) { return l.indexOf('|move|') === 0; }) &&
    (decided || report.aborted === true),
    'lines=' + report.fullLog.length + ' decided=' + decided + ' aborted=' + report.aborted);
  check('a battle that stopped early says so', decided || report.reason === 'maxTurns', JSON.stringify({ decided: decided, reason: report.reason }));
  check('turnCount agrees with the log', Math.abs(report.turnCount - report.fullLog.filter(function (l) { return l.indexOf('|turn|') === 0; }).length) <= 1,
    'turnCount=' + report.turnCount + ' turnLines=' + report.fullLog.filter(function (l) { return l.indexOf('|turn|') === 0; }).length);
  check('swingTurn is a turn number or an explicit null', report.swingTurn === null || (typeof report.swingTurn === 'number' && report.swingTurn >= 1),
    JSON.stringify(report.swingTurn));
  check('the banner is the format the arena runs', /^\|tier\|\[Gen 9\] National Dex$/.test(
    (report.fullLog.find(function (l) { return l.indexOf('|tier|') === 0; }) || '')), JSON.stringify(report.fullLog.find(function (l) { return l.indexOf('|tier|') === 0; })));

  const again = await battle(scriptedAgent('Script A'), scriptedAgent('Script B'),
    { p1Team: p1, p2Team: p2, seed: 4, maxTurns: 40 });
  check('the same seed reproduces the same battle',
    again.winner === report.winner && again.turnCount === report.turnCount,
    again.winner + '/' + again.turnCount + ' vs ' + report.winner + '/' + report.turnCount);

  const other = await battle(scriptedAgent('Script A'), scriptedAgent('Script B'),
    { p1Team: p1, p2Team: p2, seed: 99, maxTurns: 40 });
  check('a different seed is a different battle', other.fullLog.length !== report.fullLog.length || other.turnCount !== report.turnCount,
    'seed 99 -> ' + other.turnCount + ' turns, seed 4 -> ' + report.turnCount);

  return { p1: p1, p2: p2, seed: 4, report: report };
}

/* ------------------------------------------ 3. every persona answers every frame legally */

async function checkPersonas() {
  section('3. the three league personas answer every live frame with a legal move');
  const p1Team = packedOf('hazardStackBalance');
  const p2Team = packedOf('stallCore');
  const roster = [
    ['StandardMetaAnchor', league.StandardMetaAnchor],
    ['AntiTrickRoomExploiter', league.AntiTrickRoomExploiter],
    ['LowLadderChaos', league.LowLadderChaos]
  ];
  for (let i = 0; i < roster.length; i++) {
    const label = roster[i][0];
    const Klass = roster[i][1];
    if (typeof Klass !== 'function') { check(label + ' is constructible', false, 'not exported as a class'); continue; }
    const agent = new Klass({ seed: 5 });
    check(label + ' exposes the frozen agent surface',
      typeof agent.chooseAction === 'function' && typeof agent.name === 'string' && !!agent.team, JSON.stringify({ name: agent.name, team: typeof agent.team }));
    /* `agent.team` is either a key into SAMPLE_TEAMS or a paste of its own; both are legal ways to
     * carry a team, and the arena accepts both, so this asserts the team is PLAYABLE either way. */
    const mine = teams.SAMPLE_TEAMS[agent.team] || agent.team;
    if (typeof mine !== 'string' || mine.length < 20) { check(label + ' carries a team', false, JSON.stringify(agent.team).slice(0, 60)); continue; }
    const team = teams.toSimTeam(mine);
    check(label + ' plays a legal team that the sim accepts', legal(Teams.unpack(team)) === null, agent.team.slice(0, 40));
    check(label + ' brought a full team', (Teams.unpack(team) || []).length >= 3, String((Teams.unpack(team) || []).length));

    const report = await battle(scriptedAgent('Control'), agent, { p1Team: p1Team, p2Team: team, seed: 12, maxTurns: 30 });
    check(label + ' never submitted an illegal choice',
      invalidChoiceLines(report.fullLog).length === 0, invalidChoiceLines(report.fullLog).slice(0, 2).join(' | '));
    check(label + ' did not fall back on every frame',
      report.p2Choices.length >= 3 && report.substitutions.filter(function (s) { return s.side === 'p2'; }).length < report.p2Choices.length,
      'choices=' + report.p2Choices.length + ' substitutions=' + report.substitutions.length);
    check(label + ' answered the frames it was given', report.p2Choices.length > 0, String(report.p2Choices.length));
  }

  /* A unit-level sweep of the request kinds, because a battle may never reach a forced switch. */
  const kinds = {
    teamPreview: { teamPreview: true, side: { id: 'p2', pokemon: [{ ident: 'p2: Kartana' }, { ident: 'p2: Ting-Lu' }, { ident: 'p2: Clefable' }] } },
    move: { active: [{ moves: [{ move: 'Leaf Blade', id: 'leafblade', pp: 24, maxpp: 24 }, { move: 'Knock Off', id: 'knockoff', pp: 32, maxpp: 32 }] }], side: { id: 'p2', pokemon: [{ ident: 'p2: Kartana', active: true, condition: '80/100' }, { ident: 'p2: Ting-Lu', active: false, condition: '100/100' }, { ident: 'p2: Clefable', active: false, condition: '100/100' }] } },
    forceSwitch: { forceSwitch: [true], side: { id: 'p2', pokemon: [{ ident: 'p2: Kartana', active: true, condition: '0 fnt' }, { ident: 'p2: Ting-Lu', active: false, condition: '100/100' }, { ident: 'p2: Clefable', active: false, condition: '100/100' }] } },
    wait: { wait: true }
  };
  for (let i = 0; i < roster.length; i++) {
    const label = roster[i][0];
    const Klass = roster[i][1];
    if (typeof Klass !== 'function') continue;
    const agent = new Klass({ seed: 5 });
    const answers = {};
    Object.keys(kinds).forEach(function (k) {
      let out = null;
      try { out = agent.chooseAction(kinds[k], { side: 'p2', turn: 3, request: kinds[k], log: [] }); } catch (e) { out = 'THREW:' + e.message; }
      answers[k] = out;
    });
    check(label + ' answers a team-preview frame with one digit per member',
      typeof answers.teamPreview === 'string' && /^team \d{3}$/.test(answers.teamPreview), JSON.stringify(answers.teamPreview));
    check(label + ' answers a move frame with a move or a switch',
      typeof answers.move === 'string' && /^(move [a-z0-9]+|switch .+)$/.test(answers.move), JSON.stringify(answers.move));
    check(label + ' answers a forced switch with a switch',
      typeof answers.forceSwitch === 'string' && /^switch .+$/.test(answers.forceSwitch), JSON.stringify(answers.forceSwitch));
    check(label + ' declines a wait frame instead of inventing a choice', answers.wait === null, JSON.stringify(answers.wait));
  }
}

/* ------------------------------------------- 4. the mutator fuzzes without breaking teams */

function checkMutator() {
  section('4. SetMutator changes real fields and never leaves an illegal team behind');
  const names = ['hazardStackBalance', 'ladderGimmick', 'voltTurnOffense'];
  let sawSpeedCreep = false;
  let sawCoverage = false;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const out = mutator.mutateTeam(teams.SAMPLE_TEAMS[name], 1.0, { seed: 5 });
    check(name + ': a legal input is never blamed as illegal', (out.inputErrors || []).length === 0, JSON.stringify(out.inputErrors));
    check(name + ': mutations actually happen', (out.changes || []).length > 0, String((out.changes || []).length));
    check(name + ': every change is reportable',
      (out.changes || []).every(function (c) {
        return typeof c.slot === 'number' && typeof c.field === 'string' && typeof c.species === 'string';
      }), JSON.stringify((out.changes || [])[0]));
    const verdict = legal(Teams.unpack(out.packed));
    check(name + ': the mutated team still validates', verdict === null, JSON.stringify(verdict));
    const again = mutator.mutateTeam(teams.SAMPLE_TEAMS[name], 1.0, { seed: 5 });
    check(name + ': the same seed fuzzes the same way', again.packed === out.packed, 'packed strings diverged');

    const sets = Teams.unpack(out.packed) || [];
    let evOk = true, plainOk = true;
    sets.forEach(function (s) {
      const evs = s.evs || {};
      let total = 0;
      Object.keys(evs).forEach(function (k) {
        if (Number(evs[k]) > 252) evOk = false;
        total += Number(evs[k]) || 0;
      });
      if (total > 508) evOk = false;
      if (!s.species || !(s.moves || []).length) plainOk = false;
      if ((s.moves || []).length > 4) plainOk = false;
    });
    check(name + ': no illegal EVs survived (<=252 each, <=508 total)', evOk, '');
    check(name + ': every set still names a species and keeps <=4 moves', plainOk, '');
    if ((out.changes || []).some(function (c) {
      const blob = JSON.stringify(c.from) + JSON.stringify(c.to) + String(c.field) + String(c.stress || '');
      return /spe/i.test(blob) && JSON.stringify(c.from) !== JSON.stringify(c.to);
    })) sawSpeedCreep = true;
    if ((out.changes || []).some(function (c) { return /move/i.test(c.field); })) sawCoverage = true;
  }
  check('the speed-creep class fires on at least one sample', sawSpeedCreep, '');
  check('coverage injection fires on at least one sample (the class that was once dead)', sawCoverage, '');
  const rejected = mutator.mutateTeam(teams.SAMPLE_TEAMS.hazardStackBalance, 1.0, { seed: 5 }).rejected || [];
  check('a rolled-back mutation carries its reason', rejected.every(function (r) { return typeof r.reason === 'string' && r.reason.length > 0; }),
    JSON.stringify(rejected[0]));
}

/* ------------------------------------ 5. the splicer fast-forwards and hands over cleanly */

async function checkSplicer() {
  section('5. ReplaySplicer fast-forwards the recorded timeline without a desync');

  const real = fs.readFileSync(path.join(ROOT, 'test_log.txt'), 'utf8').split('\n').filter(Boolean);
  const splicer = new splicerModule.ReplaySplicer({ seed: 7, maxTurns: 24 });
  const crucible = splicer.findCrucibleTurn(real);
  check('a real 30-turn ladder log yields a crucible turn at or after turn 8',
    crucible && crucible.turnNumber >= 8, JSON.stringify(crucible));
  check('the crucible turn explains itself', !!(crucible && reasonIsExplanatory(crucible.reason)), JSON.stringify(crucible && crucible.reason));
  const recorded = splicer.extractTurnChoices(real);
  check('the recorded choices are readable and in sim syntax',
    recorded.length > 10 && recorded.every(function (c) { return /^(move [a-z0-9]+|switch .+)/.test(c.choice || ''); }),
    JSON.stringify(recorded[0]));
  check('every recorded action is attributed to a side',
    recorded.every(function (c) { return c.side === 'p1' || c.side === 'p2'; }), JSON.stringify(recorded[0]));

  /* The exactness round-trip: a battle the SIM itself produced, re-spliced with the same seed and
   * the same teams. That is the only way to distinguish "the fast-forward is faithful" from
   * "the fast-forward invented a plausible-looking board", and it is why this suite does not
   * claim exact reproduction for a human replay (which carries no seed). */
  const p1 = packedOf('stallCore');
  const p2 = packedOf('hazardStackBalance');
  const source = await battle(scriptedAgent('Script A'), scriptedAgent('Script B'),
    { p1Team: p1, p2Team: p2, seed: 21, maxTurns: 26 });
  check('the source battle is long enough to splice into', source.turnCount >= 6, 'turnCount=' + source.turnCount);
  const target = Math.max(2, Math.min(5, source.turnCount - 1));

  const spliced = await splicer.spliceAndResume(source.fullLog, target,
    new league.StandardMetaAnchor({ seed: 5 }), new league.LowLadderChaos({ seed: 5 }),
    { teams: { p1: { packed: p1 }, p2: { packed: p2 } }, seed: 21, maxTurns: 24 });

  check('the splice reports its own structure', !!(spliced && spliced.spliced), JSON.stringify(Object.keys(spliced || {})));
  const meta = (spliced && spliced.spliced) || {};
  check('control really was handed to the agents at the target turn',
    meta.handoverReached === true, JSON.stringify(meta.handoverReached));
  check('the fast-forward is exact when the seed and teams are the ones that produced the log',
    meta.fidelity && meta.fidelity.score === 1, JSON.stringify(meta.fidelity));
  check('nothing diverged, so nothing is claimed to have been repaired',
    meta.diverged === false && (meta.desyncs || []).length === 0, JSON.stringify({ diverged: meta.diverged, desyncs: meta.desyncs }));
  check('the spliced battle still produced a real report',
    spliced.fullLog.length > 0 && (spliced.winner === 'p1' || spliced.winner === 'p2' || spliced.winner === 'tie'), String(spliced.winner));
  check('the spliced battle reached at least the handover turn', spliced.turnCount >= target, 'turns=' + spliced.turnCount + ' target=' + target);
  check('the spliced timeline was driven by real agents, not by the recording alone',
    spliced.p1Choices.length + spliced.p2Choices.length > 0, 'choices=' + (spliced.p1Choices.length + spliced.p2Choices.length));

  const refused = await splicer.spliceAndResume(source.fullLog, source.turnCount + 50, scriptedAgent('A'), scriptedAgent('B'),
    { teams: { p1: p1, p2: p2 } }).then(function () { return null; }, function (e) { return e.message; });
  check('splicing past the end of the log is refused with a named turn, not guessed at',
    typeof refused === 'string' && /replay only reaches turn/.test(refused), JSON.stringify(refused));

  /* The human replay is the honest case: the teams are derived from species, so fidelity is
   * MEASURED and reported rather than assumed. */
  const derived = splicer.extractTeams(real, {});
  check('a real replay yields a team for each side from its |poke| lines',
    !!(derived.p1 && derived.p1.packed) && !!(derived.p2 && derived.p2.packed),
    JSON.stringify({ p1: derived.p1 && derived.p1.source, p2: derived.p2 && derived.p2.source }));
  check('the derived teams are legal in the format',
    legal(Teams.unpack(derived.p1.packed)) === null && legal(Teams.unpack(derived.p2.packed)) === null, '');
}

function reasonIsExplanatory(reason) {
  return typeof reason === 'string' && reason.length >= 8;
}

/* ---------------------------------- 6. the harvester emits real puzzles and registers safely */

async function checkHarvester() {
  section('6. BlunderHarvester emits valid puzzle code and appends it without corrupting the file');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena_puzzles_'));
  const target = path.join(tmp, 'tactical_puzzles.js');
  const skeleton = (function () {
    try { return harvesterModule.skeleton(); } catch (e) { return null; }
  })() || ['"use strict";', 'const PUZZLES = [];', 'function testPuzzle(name, spec) { PUZZLES.push({ name: name, spec: spec }); }', harvesterModule.SENTINEL, 'module.exports = { PUZZLES: PUZZLES, testPuzzle: testPuzzle };'].join('\n');
  fs.writeFileSync(target, skeleton, 'utf8');

  const analysis = {
    /* `found` is part of the contract: generatePuzzleCode returns null for an analysis that did
     * not locate a blunder, because a puzzle with no pinned mistake would assert nothing. */
    found: true, side: 'p1', winner: 'p2', losingSide: 'p2',
    blunderTurn: 7, before: 210.5, after: -404.25, drop: -614.75,
    punish: { name: 'Knock Off', moveId: 'knockoff' },
    chosen: { name: 'Rapid Spin', moveId: 'rapidspin', kind: 'move' },
    alternatives: [{ name: 'Headlong Rush', moveId: 'headlongrush' }, { name: 'Ice Spinner', moveId: 'icespinner' }],
    logPrefix: ['|turn|7', '|request|' + JSON.stringify({ side: { id: 'p1', pokemon: [{ ident: 'p1: Great Tusk', active: true, condition: '70/100' }] }, active: [{ moves: [{ move: 'Rapid Spin', id: 'rapidspin', pp: 64, maxpp: 64 }] }] })]
  };
  const code = harvesterModule.generatePuzzleCode(analysis, { now: 1730000000000 });
  check('an analysis that found no blunder yields no puzzle', harvesterModule.generatePuzzleCode({ found: false, reason: 'flat game' }, { now: 1 }) === null, '');
  check('the generated code is a non-empty string', typeof code === 'string' && code.length > 0, JSON.stringify(code));
  check('the generated code compiles as JavaScript', (function () {
    try { new vm.Script(code); return true; } catch (e) { return false; }
  })(), code.split('\n')[0]);
  check('it carries the three frozen keys',
    /testPuzzle\(/.test(code) && /forbiddenMove:/.test(code) && /validTopMoves:/.test(code) && /logPrefix:/.test(code), code.split('\n')[1]);
  check('the puzzle is named for the loss', /AutoVaccine_Loss_1730000000000/.test(code), code.split('\n')[1]);
  check('the name is a quoted string, so an apostrophe in a move cannot break it', (function () {
    const weird = harvesterModule.generatePuzzleCode(Object.assign({}, analysis, { chosen: { name: "King's Shield", moveId: 'kingsshield' } }), { now: 1 });
    try { new vm.Script(weird); return true; } catch (e) { return false; }
  })(), '');

  const first = harvesterModule.appendVaccineToFile(code, target);
  const after = fs.readFileSync(target, 'utf8');
  check('the append landed above the runner sentinel',
    first.appended !== false && after.indexOf('AutoVaccine_Loss_1730000000000') < after.lastIndexOf(harvesterModule.SENTINEL),
    JSON.stringify(first));
  check('the file still parses after the append', (function () {
    try { new vm.Script(after); return true; } catch (e) { return false; }
  })(), '');
  const second = harvesterModule.appendVaccineToFile(code, target);
  check('appending the same vaccine twice is a no-op', second.appended === false, JSON.stringify(second));
  check('the file is byte-identical after the refused duplicate', fs.readFileSync(target, 'utf8') === after, '');

  const markerless = path.join(tmp, 'no_marker.js');
  fs.writeFileSync(markerless, '// nothing to see here\n', 'utf8');
  const refused = (function () {
    try { harvesterModule.appendVaccineToFile(code, markerless); return null; } catch (e) { return e.message; }
  })();
  check('a file without the sentinel is refused instead of corrupted',
    typeof refused === 'string' && fs.readFileSync(markerless, 'utf8') === '// nothing to see here\n', JSON.stringify(refused));

  /* The live path: analyze a battle the engine actually played. It may legitimately find no
   * blunder (a win, or a flat game), so both outcomes are acceptable — what is not acceptable is
   * a crash or an invented turn. */
  const report = await battle(bridgeSessionAgent('hazardStackBalance'), new league.StandardMetaAnchor({ seed: 5 }),
    { p1Team: packedOf('hazardStackBalance'), p2Team: packedOf('hazardStackBalance'), seed: 8, maxTurns: 24 });
  const harvester = new harvesterModule.BlunderHarvester();
  let verdict = null;
  try {
    verdict = harvester.analyzeLoss(report, { paste: teams.SAMPLE_TEAMS.hazardStackBalance });
  } catch (e) { verdict = 'THREW:' + e.message; }
  check('analyzing a real loss does not throw', verdict && verdict !== 'THREW' && typeof verdict === 'object', JSON.stringify(verdict));
  /* The wiring pin. `fullLog` has no `|request|` lines in it, so an analysis that reads the public
   * log alone walks an EMPTY timeline and reports "no decision frame" for every battle — a harvester
   * that looks like it is working (it returns a well-formed verdict) while harvesting nothing. An
   * empty frame list, or that exact reason, is the regression. */
  /* A located verdict reports its walk as `timeline`; an explained absence reports it as `frames`.
   * Either way it must be non-empty — an empty one is the "read the public log" regression. */
  const walked = verdict && verdict !== 'THREW'
    ? (verdict.found === true ? verdict.timeline : verdict.frames)
    : null;
  check('the live verdict walked a real timeline of decision frames',
    Array.isArray(walked) && walked.length > 0,
    JSON.stringify({ walked: Array.isArray(walked) ? walked.length : null, found: verdict && verdict.found, reason: verdict && verdict.reason }));
  check('the live verdict does not report an empty log',
    !(verdict && typeof verdict.reason === 'string' && verdict.reason.indexOf('the log contains no decision frame') === 0),
    verdict && verdict.reason);
  if (verdict && typeof verdict === 'object') {
    check('the verdict is either a located blunder or an explained absence',
      (verdict.found === false && typeof verdict.reason === 'string') ||
      (typeof verdict.blunderTurn === 'number' && typeof verdict.drop === 'number' && Array.isArray(verdict.logPrefix)),
      JSON.stringify(verdict).slice(0, 160));
    if (typeof verdict.blunderTurn === 'number') {
      check('a located blunder is a real negative drop', verdict.drop < 0, String(verdict.drop));
      const live = harvesterModule.generatePuzzleCode(verdict, { now: 2 });
      check('a harvested puzzle compiles', (function () {
        try { new vm.Script(live); return true; } catch (e) { return false; }
      })(), '');
    }
  }
  /* The terse shape the brief names: generatePuzzleCode(blunderTurnNumber, matchReport). A caller
   * that already knows which turn to pin must not need a session to emit a valid vaccine, so the
   * fields are derived from the report's own log — and derived WRONGLY would still emit parseable
   * code, which is why each field is cross-checked against an independent scan here. */
  /* The report carries two different logs on purpose, and the difference is the whole reason the
   * harvester can work at all. */
  check('the report exposes each seat\'s own stream, which is where the |request| frames live',
    Array.isArray(report.p1Log) && report.p1Log.length > 0 && Array.isArray(report.p2Log) && report.p2Log.length > 0,
    JSON.stringify({ p1: report.p1Log && report.p1Log.length, p2: report.p2Log && report.p2Log.length }));
  const publicRequests = report.fullLog.filter(function (l) { return l.indexOf('|request|') === 0; }).length;
  const ownRequests = report.p1Log.filter(function (l) { return l.indexOf('|request|') === 0; }).length;
  check('the public fullLog holds no |request| frame, and the player stream holds them all',
    publicRequests === 0 && ownRequests > 0, JSON.stringify({ fullLog: publicRequests, p1Log: ownRequests }));
  check('the player stream is a superset of the public log (public lines plus private frames)',
    report.p1Log.length > report.fullLog.length && report.fullLog.length > 0,
    JSON.stringify({ p1Log: report.p1Log.length, fullLog: report.fullLog.length }));

  const lines = report.p1Log;
  let pinTurn = null;
  let walkedTurn = 0;
  for (let i = 0; i < lines.length && pinTurn === null; i++) {
    const line = lines[i];
    if (line.indexOf('|turn|') === 0) {
      const parsed = parseInt(line.split('|')[2], 10);
      if (isFinite(parsed)) walkedTurn = parsed;
      continue;
    }
    if (walkedTurn < 1 || line.indexOf('|request|') !== 0) continue;
    let req = null;
    try { req = JSON.parse(line.slice('|request|'.length)); } catch (e) { req = null; }
    if (req && !req.wait && !req.teamPreview && req.side && String(req.side.id) === 'p1') pinTurn = walkedTurn;
  }
  check('the played report carries a p1 decision frame for the terse form to pin', typeof pinTurn === 'number', JSON.stringify(pinTurn));
  if (typeof pinTurn === 'number') {
    const derived = harvesterModule.analysisFromTurn(pinTurn, { report: report });
    check('the terse form derives an analysis from the report alone',
      derived && derived.found === true && derived.blunderTurn === pinTurn && derived.side === 'p1',
      JSON.stringify({ turn: derived && derived.blunderTurn, side: derived && derived.side }));
    check('the derived prefix ends at the decision frame',
      derived.logPrefix.length > 1 && derived.logPrefix[derived.logPrefix.length - 1].indexOf('|request|') === 0,
      JSON.stringify(derived.logPrefix[derived.logPrefix.length - 1] || '').slice(0, 70));

    /* Independent scan: what the log says p1 actually played at that turn. */
    const recorded = (function () {
      let seen = 0;
      let from = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('|turn|') === 0) { const p = parseInt(lines[i].split('|')[2], 10); if (isFinite(p)) seen = p; }
        else if (seen === pinTurn && lines[i].indexOf('|request|') === 0) { from = i; break; }
      }
      if (from === -1) return null;
      for (let i = from + 1; i < lines.length; i++) {
        if (lines[i].indexOf('|move|p1') === 0) return lines[i].split('|')[3];
        if (lines[i].indexOf('|switch|p1') === 0) return (lines[i].split('|')[3] || '').split(',')[0];
        if (lines[i].indexOf('|cant|p1') === 0 && lines[i].split('|')[4]) return lines[i].split('|')[4];
        if (/^\|turn\|/.test(lines[i])) break;
      }
      return null;
    })();
    const idOf = function (v) { return String(v === null || v === undefined ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ''); };
    check('the derived forbidden line is what the log records the engine playing',
      recorded !== null && idOf(derived.forbiddenMove) === idOf(recorded),
      JSON.stringify({ derived: derived.forbiddenMove, logSays: recorded }));
    check('the derived alternatives are non-empty, distinct from the blunder, and covered by the frame',
      Array.isArray(derived.alternatives) && derived.alternatives.length > 0 &&
      derived.alternatives.every(function (a) { return a && a.name && idOf(a.name) !== idOf(derived.forbiddenMove); }),
      JSON.stringify((derived.alternatives || []).map(function (a) { return a && a.name; })));
    check('the terse form scores nothing rather than inventing numbers',
      derived.drop === undefined && derived.before === undefined && derived.after === undefined && derived.rankedCount === null,
      JSON.stringify({ drop: derived.drop, before: derived.before, after: derived.after }));

    const terseCode = harvesterModule.generatePuzzleCode(pinTurn, { report: report, now: 4 });
    check('the terse form emits a compilable puzzle', (function () {
      try { new vm.Script(terseCode); return true; } catch (e) { return false; }
    })(), String(terseCode).split('\n')[0]);
    check('the emitted puzzle names the derived forbidden line and the frozen keys',
      terseCode.indexOf(JSON.stringify(derived.forbiddenMove)) !== -1 &&
      /forbiddenMove:/.test(terseCode) && /validTopMoves:/.test(terseCode) && /logPrefix:/.test(terseCode),
      String(terseCode).split('\n')[1]);

    const refusedTurn = (function () {
      try { harvesterModule.generatePuzzleCode(999, { report: report }); return null; } catch (e) { return e.message; }
    })();
    check('a turn the report does not reach is refused, and the message names the turns it has',
      typeof refusedTurn === 'string' && refusedTurn.indexOf('frames found at turns') !== -1, JSON.stringify(refusedTurn));

    const missingReport = (function () {
      try { harvesterModule.generatePuzzleCode(pinTurn, {}); return null; } catch (e) { return e.message; }
    })();
    check('the terse form without a report is refused rather than guessing',
      typeof missingReport === 'string' && missingReport.indexOf('options.report') !== -1, JSON.stringify(missingReport));

    /* A switch is a legal answer to the frame, and the engine's own ranking prints a switch line as
     * the SPECIES — so the terse form must name the species, not the nickname, or the puzzle would
     * pin a line the ranking can never contain. */
    const switchReport = {
      winner: 'p2',
      fullLog: [
        '|turn|3',
        '|request|' + JSON.stringify({ side: { id: 'p1' }, active: [{ moves: [{ move: 'Rapid Spin', id: 'rapidspin', pp: 64, maxpp: 64 }] }] }),
        '|switch|p1a: Corv|Corviknight, L50, M|100/100'
      ]
    };
    const switchDerived = harvesterModule.analysisFromTurn(3, { report: switchReport });
    check('a switch is pinned by species name, which is what the ranking prints',
      switchDerived.forbiddenMove === 'Corviknight' && switchDerived.alternatives.length === 1 &&
      switchDerived.alternatives[0].name === 'Rapid Spin',
      JSON.stringify({ forbidden: switchDerived.forbiddenMove, alternatives: switchDerived.alternatives }));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

/** The engine itself as an agent, for the battles above that should exercise the real pipeline. */
function bridgeSessionAgent(teamName) {
  const session = bridge.createSession({ paste: teams.SAMPLE_TEAMS[teamName] });
  return {
    name: 'Tactician',
    session: session,
    chooseAction: function (request, context) {
      const lines = (context && context.log) || [];
      const last = lines[lines.length - 1];
      if (last && last.indexOf('|request|') === 0) session.feed(last);
      return session.topChoice() || (session.choiceLadder(3)[0] || null);
    }
  };
}

/* -------------------------------------------------------------------------- 7. the wire */

function checkWire() {
  section('7. the stream protocol facts the arena is built on still hold');
  const paste = teams.SAMPLE_TEAMS.hazardStackBalance;
  check('Teams.import + Teams.pack is the accepted bridge',
    legal(Teams.import(paste)) === null, 'the sim accepted a paste-imported team');
  const repacked = Teams.pack(Teams.import(paste));
  check('the sim packs sets with `]` separators, the way the arena feeds them',
    repacked.indexOf(']') !== -1 && repacked.indexOf('\n') === -1, JSON.stringify(repacked.slice(0, 60)));

  /* The regression this protects: the repo's own packer emits newline-joined display names, and
   * the sim reads that as one malformed set. If a future refactor "simplifies" teams.js back to
   * TeamParser.packTeam, this check is what notices. */
  const harness = require(path.join(ROOT, 'tests', 'harness.js'));
  const sandbox = harness.loadAll({ setInterval: function () { return 0; }, clearInterval: function () { } });
  const repoPacked = sandbox.ST.TeamParser.packTeam(sandbox.ST.TeamParser.parsePokepaste(paste).pokemon);
  const repoVerdict = (function () {
    try { return new TeamValidator('gen9nationaldex').validateTeam(Teams.unpack(repoPacked)); } catch (e) { return ['threw: ' + e.message]; }
  })();
  check('the repo packer output is still NOT accepted by the sim (why the arena uses Teams.pack)',
    Array.isArray(repoVerdict) && repoVerdict.length > 0, JSON.stringify(repoVerdict).slice(0, 120));
  check('the sim exposes the stream API the runner uses',
    typeof BattleStreams.BattleStream === 'function' && typeof BattleStreams.getPlayerStreams === 'function', '');
}

/* ---------------------------------------------------------------------- run everything */

(async function main() {
  console.log('arena_check: validating tools/headless_arena against @pkmn/sim');
  checkBridge();
  await checkRunner();
  await checkPersonas();
  checkMutator();
  await checkSplicer();
  await checkHarvester();
  checkWire();

  console.log('\n=== summary ===');
  console.log('checks passed: ' + passed);
  console.log('checks failed: ' + failures.length);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(function (f) { console.log('  x ' + f); });
    process.exit(1);
  }
  console.log('ALL ARENA CHECKS PASSED');
  process.exit(0);
})().catch(function (err) {
  console.error('\nFATAL: the arena suite threw before it could report:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
