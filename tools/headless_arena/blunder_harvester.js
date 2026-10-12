/* Showdown Tactician — tools/headless_arena/blunder_harvester.js
 *
 * WHY THIS EXISTS
 *   An arena that only reports a win rate teaches nothing: a 61 % score says the engine lost two
 *   games in five without saying what it did wrong. This module turns a LOSS into a permanent,
 *   executable artifact — a regression puzzle — by asking the engine's own evaluator where the
 *   game went wrong.
 *
 *   The blunder is the turn where the ENGINE'S OWN SCALAR READ OF THE POSITION fell the most, not
 *   the turn where the most HP was lost. Those are different turns often enough to matter: losing
 *   60 % of one body while setting Stealth Rock is frequently a good turn, and giving up 5 % to a
 *   U-turn that brings in the threat you cannot answer is frequently the losing one. Only the
 *   engine's own numbers can identify the second kind, and they are the numbers a puzzle can pin.
 *
 * WHAT A HARVESTED PUZZLE MEANS — READ THIS BEFORE REGISTERING IT IN THE SUITE
 *   A freshly harvested vaccine pins the blunder the engine just committed, and the engine is
 *   deterministic: replaying the same prefix reproduces the same ranking, so the forbidden line
 *   is once again the top line and the puzzle FAILS. That failure is the point — it is a written
 *   record of a known defect — but it also means the suite goes red the moment you harvest.
 *   `tests/tactical_puzzles.js` therefore ships with ZERO puzzles (green), and a harvested vaccine
 *   stays red until the engine is actually fixed. Callers who only want the code can use
 *   `generatePuzzleCode()` without `appendVaccineToFile()`.
 *
 * HOW THE PUZZLE IS RUN
 *   The emitted spec is protocol lines, not a board object: `logPrefix` is the raw stream up to and
 *   including the decision frame at the blunder turn, so the puzzle exercises the whole pipeline
 *   (parser -> state manager -> engine) rather than a hand-built fixture that could drift from it.
 *
 * Safe-append contract: the generated call is inserted immediately BEFORE the sentinel
 * `// ==== RUNNER (do not remove) ====` in the target file, duplicates are skipped by name, and the
 * resulting file is compiled with `vm.Script` BEFORE anything is written. If it does not parse, the
 * original bytes are restored and the call throws — a harvester that can corrupt the test suite it
 * feeds would be worse than no harvester.
 *
 * Run the self-check with:  node tools/headless_arena/blunder_harvester.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const DEFAULT_ENGINE = require('./engine_bridge.js');

/* The insertion point in the puzzle suite. Frozen: `tests/tactical_puzzles.js` owns the same
 * literal, and the two files are only consistent because neither invents its own marker. */
const SENTINEL = '// ==== RUNNER (do not remove) ====';

const DEFAULT_TARGET = path.join('tests', 'tactical_puzzles.js');

function toId(value) {
  return String(value === null || value === undefined ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function asLines(log) {
  if (Array.isArray(log)) return log.map(function (l) { return String(l); });
  return String(log === null || log === undefined ? '' : log).split('\n');
}

/**
 * The log a decision has to be read from: that side's OWN stream when the report carries one.
 *
 * This one function is the difference between a harvester that works and one that reports "no
 * decision frame" for every game it is ever handed. `fullLog` is the omniscient public log, and the
 * sim never publishes `|request|` on it — the frames are private to each player stream. A report's
 * `p1Log`/`p2Log` are strict supersets of the public log (public lines PLUS that seat's private
 * frames, in the order a client saw them), so they are where a decision frame exists at all. The
 * `fullLog` fallback is kept for a hand-built report (a fixture, a spliced log, a replay), which is
 * exactly why the wiring is pinned by a suite check against a REAL battle rather than by the
 * synthetic fixture below it.
 */
function sourceLines(matchReport, side) {
  const own = matchReport && (side === 'p2' ? matchReport.p2Log : matchReport.p1Log);
  if (Array.isArray(own) && own.length) return asLines(own);
  return asLines(matchReport && matchReport.fullLog);
}

/** The skeleton written when the target file does not exist. The real suite is richer; this only
 *  exists so a test can point the harvester at an empty directory and still get a parseable file. */
function skeleton() {
  return [
    '/* Puzzle registry — see tests/tactical_puzzles.js for the full runner. */',
    "'use strict';",
    '',
    'const PUZZLES = [];',
    '',
    'function testPuzzle(name, spec) { PUZZLES.push({ name: name, spec: spec }); }',
    '',
    SENTINEL,
    '',
    'module.exports = { PUZZLES: PUZZLES, testPuzzle: testPuzzle };',
    ''
  ].join('\n');
}

/** Why a decision frame belongs to us: the request names a side, and only ours is a decision. */
function isDecisionFrame(line, side) {
  if (!/^\|request\|/.test(line)) return false;
  let req;
  try {
    req = JSON.parse(line.slice('|request|'.length));
  } catch (e) {
    return false;
  }
  if (!req || req.wait) return false;
  if (req.teamPreview) return false;
  if (!req.side || !req.side.id) return true; // no side id: assume ours rather than drop the frame
  return String(req.side.id) === String(side);
}

/** The opponent's answer to a frame: the first thing they did before our next decision. */
function punishAfter(lines, fromIndex, oppSide) {
  for (let i = fromIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\|request\|/.test(line)) break; // our next decision closes the window
    if (line.indexOf('|move|' + oppSide) === 0) {
      const parts = line.split('|');
      return { kind: 'move', name: parts[3] || '', user: parts[2] || '', line: line };
    }
    if (line.indexOf('|switch|' + oppSide) === 0 || line.indexOf('|drag|' + oppSide) === 0) {
      const parts = line.split('|');
      return { kind: 'switch', name: (parts[3] || '').split(',')[0], user: parts[2] || '', line: line };
    }
    // A |faint| line names the body that fell, not the body that swung, so it is not the answer
    // to "what punished us" — the opponent's move or switch above already is.
  }
  return null;
}

/** A line of the report's own log that shows our side taking damage — the cost of the blunder. */
function damageTo(lines, fromIndex, mySide) {
  for (let i = fromIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\|request\|/.test(line)) break;
    if (line.indexOf('|-damage|' + mySide) === 0) return line;
    if (line.indexOf('|-heal|' + mySide) === 0) return line;
  }
  return null;
}

class BlunderHarvester {
  /**
   * @param {object} [options]
   * @param {object} [options.bridge]      engine_bridge replacement (tests inject a stub)
   * @param {number} [options.minDrop]     ignore drops smaller than this many score points
   * @param {number} [options.topAlternatives] how many alternatives to describe
   * @param {string} [options.side]        which side the engine played (default p1)
   */
  constructor(options) {
    options = options || {};
    this.bridge = options.bridge || DEFAULT_ENGINE;
    this.minDrop = typeof options.minDrop === 'number' ? options.minDrop : 1;
    this.topAlternatives = options.topAlternatives || 3;
    this.side = options.side || 'p1';
  }

  /** A team paste for the replay session: the caller's, or a sample team from teams.js. */
  resolvePaste(options) {
    if (options.paste) return options.paste;
    const teams = this.loadTeams();
    if (teams) {
      const names = ['hazardStackBalance', 'anchorBalance', 'voltTurnOffense'];
      for (let i = 0; i < names.length; i++) {
        const paste = teams.SAMPLE_TEAMS && teams.SAMPLE_TEAMS[names[i]];
        if (typeof paste === 'string' && paste) return paste;
      }
    }
    throw new Error('blunder_harvester: no team paste available — pass options.paste (the log ' +
      'prefix has to be replayed through the engine, and the engine needs a team)');
  }

  loadTeams() {
    if (this._teams !== undefined) return this._teams;
    try {
      this._teams = require('./teams.js');
    } catch (e) {
      this._teams = null;
    }
    return this._teams;
  }

  /**
   * Walk the match log one line at a time and record the engine's own read at every one of OUR
   * decision frames. The session is fed incrementally and in order, so each frame sees exactly the
   * history a live client would have had.
   */
  scoreTimeline(matchReport, options) {
    const side = options.side || this.side;
    const lines = sourceLines(matchReport, side);
    const session = options.session || this.bridge.createSession({
      paste: this.resolvePaste(options),
      name: 'Harvester',
      formatName: options.formatName
    });
    const ownSession = !options.session;
    const frames = [];
    let turn = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.indexOf('|turn|') === 0) {
        const parsed = parseInt(line.split('|')[2], 10);
        if (isFinite(parsed)) turn = parsed;
      }
      const ranked = session.feed(line);
      if (!ranked || !isDecisionFrame(line, side)) continue;
      const live = ranked.filter(function (e) { return e && !e.isVetoed; });
      const top = live[0] || null;
      frames.push({
        turn: turn,
        lineIndex: i,
        score: session.bestScore(),
        chosen: top ? { kind: top.kind, name: top.name, moveId: top.moveId || null } : null,
        alternatives: live.slice(1, 1 + this.topAlternatives).map(function (e) {
          return { kind: e.kind, name: e.name, score: e.score };
        }),
        rankedCount: ranked.length,
        logPrefix: lines.slice(0, i + 1)
      });
    }
    return {
      session: session,
      frames: frames,
      lines: lines,
      side: side,
      engineErrors: ownSession ? session.pipelineErrors() : []
    };
  }

  /**
   * analyzeLoss(matchReport, sessionOrOptions) -> the critical blunder turn.
   * `sessionOrOptions` is either an existing engine session (reused, not created) or an options
   * object: { paste, session, side, formatName }.
   */
  analyzeLoss(matchReport, sessionOrOptions) {
    let options = sessionOrOptions || {};
    if (options && typeof options.feed === 'function') options = { session: options };
    const timeline = this.scoreTimeline(matchReport, options);
    const frames = timeline.frames;
    if (!frames.length) {
      const playerLog = matchReport && (timeline.side === 'p2' ? matchReport.p2Log : matchReport.p1Log);
      return {
        found: false,
        reason: 'the log contains no decision frame for ' + timeline.side +
          ' (a puzzle can only be pinned to a turn the engine actually chose in)' +
          (Array.isArray(playerLog) && playerLog.length ? ''
            : ' — and this report carries no ' + timeline.side +
              'Log, which is the only log that holds |request| frames: a bare { fullLog } report can '
              + 'never be harvested, because the sim does not publish requests on the public stream'),
        frames: [],
        engineErrors: timeline.engineErrors
      };
    }

    let worst = null;
    for (let i = 1; i < frames.length; i++) {
      const before = frames[i - 1].score;
      const after = frames[i].score;
      if (typeof before !== 'number' || typeof after !== 'number') continue;
      const drop = after - before;
      if (drop > -this.minDrop) continue;
      if (!worst || drop < worst.drop) worst = { index: i, before: before, after: after, drop: drop };
    }
    if (!worst) {
      return {
        found: false,
        reason: 'no decision frame lost more than ' + this.minDrop +
          ' points of the engine\'s own evaluation (a loss is not automatically a blunder: ' +
          'sometimes the engine played the best available line and lost anyway)',
        frames: frames.map(function (f) { return { turn: f.turn, score: f.score }; }),
        engineErrors: timeline.engineErrors
      };
    }

    const frame = frames[worst.index];
    const previous = frames[worst.index - 1];
    if (!frame.chosen) {
      return { found: false, reason: 'the blunder frame has no non-vetoed line to name', frames: frames, engineErrors: timeline.engineErrors };
    }
    // The puzzle's alternatives must be DIFFERENT lines from the one that blundered, or the
    // assertion "an alternative appears in the ranking" would be satisfied by the blunder itself.
    const alternatives = frame.alternatives.filter(function (a) {
      return a && a.name && toId(a.name) !== toId(frame.chosen.name);
    });
    if (!alternatives.length) {
      return {
        found: false,
        reason: 'the engine ranked only one live line at turn ' + frame.turn +
          ' (there is no alternative to demand, so there is nothing to pin)',
        frames: frames,
        engineErrors: timeline.engineErrors
      };
    }

    const winner = String((matchReport && matchReport.winner) || 'unknown');
    const losingSide = winner === timeline.side ? null : (winner === 'tie' ? null : winner);
    return {
      found: true,
      side: timeline.side,
      winner: winner,
      losingSide: losingSide,
      blunderTurn: frame.turn,
      before: worst.before,
      after: worst.after,
      drop: worst.drop,
      chosen: frame.chosen,
      forbiddenMove: frame.chosen.name,
      punish: punishAfter(timeline.lines, frame.lineIndex, timeline.side === 'p1' ? 'p2' : 'p1'),
      cost: damageTo(timeline.lines, frame.lineIndex, timeline.side),
      alternatives: alternatives,
      logPrefix: frame.logPrefix,
      rankedCount: frame.rankedCount,
      timeline: frames.map(function (f) { return { turn: f.turn, score: f.score, chosen: f.chosen && f.chosen.name }; }),
      engineErrors: timeline.engineErrors
    };
  }

  /**
   * The puzzle source for an analysis — or, terse form, for a turn number plus `{ report }` in
   * `options` (see `analysisFromTurn`). Returns null (never throws) when the analysis found no
   * blunder — a caller looping over losses must be able to say "nothing to harvest here".
   */
  generatePuzzleCode(analysis, options) {
    return generatePuzzleCode(analysis, options);
  }

  /** Insert a generated puzzle into the registry. See the safe-append notes in the header. */
  appendVaccineToFile(code, targetFile) {
    return appendVaccineToFile(code, targetFile);
  }
}

/* --------------------------------------------------------------- code emission */

/**
 * The terse form of the call: `generatePuzzleCode(turnNumber, { report })`. The rich path needs an
 * analysis because only a live session can score a timeline — but a PUZZLE does not need scores. It
 * needs the protocol prefix up to the decision frame, the line the engine played, and the lines it
 * could have played instead, and a MatchReport carries all three: the `|request|` frame names every
 * move that was available, and the action line right after it names what was clicked. So a caller
 * that already knows which turn to pin (a report from a `--harvest` run, a parent process, a human
 * reading the log) can emit a valid vaccine without a session. The score-based prose in the header
 * comment degrades to `?` rather than being invented, and `analyzeLoss()` remains the way to find
 * the turn in the first place.
 */
function analysisFromTurn(turnNumber, options) {
  options = options || {};
  const report = options.report || options.matchReport;
  const hasLog = report && (Array.isArray(report.fullLog) || Array.isArray(report.p1Log) || Array.isArray(report.p2Log));
  if (!hasLog) {
    throw new Error('generatePuzzleCode(turn, options): options.report with a log array (fullLog, or the' +
      ' side\'s own p1Log/p2Log) is required for the terse form — pass the MatchReport the turn came from' +
      (typeof turnNumber === 'number' ? '' : ' (or pass an analysis object from analyzeLoss())'));
  }
  if (typeof turnNumber !== 'number' || turnNumber < 1) {
    throw new Error('generatePuzzleCode: a turn number >= 1 is required (got ' + JSON.stringify(turnNumber) + ')');
  }
  const side = options.side || 'p1';
  const lines = sourceLines(report, side);

  /* The frame: the first decision window of ours at that turn. Turn tracking is the sim's own
   * `|turn|` marker, not a counter, so a `|t:|` or a missed line cannot shift the numbering. */
  let frameIndex = -1;
  let frameRequest = null;
  let turn = 0;
  const seenTurns = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf('|turn|') === 0) {
      const parsed = parseInt(line.split('|')[2], 10);
      if (isFinite(parsed)) turn = parsed;
      continue;
    }
    if (frameIndex !== -1) continue;
    if (turn === turnNumber && isDecisionFrame(line, side)) {
      try {
        frameRequest = JSON.parse(line.slice('|request|'.length));
      } catch (e) {
        frameRequest = null;
      }
      if (seenTurns.indexOf(turn) === -1) seenTurns.push(turn);
      frameIndex = i;
    } else if (isDecisionFrame(line, side) && seenTurns.indexOf(turn) === -1) {
      seenTurns.push(turn);
    }
  }
  if (frameIndex === -1) {
    throw new Error('generatePuzzleCode: the report holds no decision frame for ' + side + ' at turn ' +
      turnNumber + ' (frames found at turns: ' + (seenTurns.length ? seenTurns.join(', ') : 'none') +
      ') — a puzzle can only be pinned to a turn the engine actually chose in');
  }

  /* What it played: the first action line of ours before the next frame. A `|cant|` still names the
   * move that was chosen (a full-para turn is not a turn with no choice), and a switch names the
   * SPECIES, which is what the engine's own ranking prints for a switch line. */
  let forbidden = null;
  let punishedBy = null;
  for (let i = frameIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\|request\|/.test(line)) break;
    if (line.indexOf('|move|' + side) === 0) {
      forbidden = line.split('|')[3] || '';
      break;
    }
    if (line.indexOf('|switch|' + side) === 0) {
      forbidden = (line.split('|')[3] || '').split(',')[0];
      break;
    }
    if (line.indexOf('|cant|' + side) === 0) {
      const parts = line.split('|');
      if (parts[4]) { forbidden = parts[4]; break; }
    }
  }
  if (!forbidden) {
    throw new Error('generatePuzzleCode: the report records no action for ' + side + ' at turn ' +
      turnNumber + ' — the battle ended inside that decision frame, so there is nothing to forbid');
  }

  /* The alternatives: every move the request itself offered, minus the one that was clicked. They
   * are legal by construction (the sim built the list) and different from the blunder by fiat, which
   * is exactly what the puzzle's assertion needs. An explicit list always wins. */
  const offered = [];
  const active = (frameRequest && frameRequest.active) || [];
  const moves = (active[0] && active[0].moves) || [];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (!m || m.disabled || !m.move) continue;
    if (toId(m.move) === toId(forbidden)) continue;
    offered.push({ name: String(m.move) });
  }
  const explicit = options.validTopMoves || options.alternatives;
  const alternatives = (Array.isArray(explicit) && explicit.length ? explicit : offered)
    .map(function (a) { return (a && typeof a === 'object') ? a : { name: a }; })
    .filter(function (a) { return a && a.name && toId(a.name) !== toId(forbidden); });

  const oppSide = side === 'p1' ? 'p2' : 'p1';
  return {
    found: true,
    source: 'report',
    side: side,
    winner: report.winner || 'unknown',
    losingSide: report.winner && report.winner !== side && report.winner !== 'tie' ? report.winner : null,
    blunderTurn: turnNumber,
    chosen: { name: forbidden },
    forbiddenMove: forbidden,
    punish: punishAfter(lines, frameIndex, oppSide),
    cost: damageTo(lines, frameIndex, side),
    alternatives: alternatives,
    logPrefix: lines.slice(0, frameIndex + 1),
    /* Deliberately absent, not zero: no session scored this turn, so there is no drop, no before,
     * no after, and no ranked count. The emitter prints '?' for them instead of a fake number. */
    rankedCount: null,
    engineErrors: []
  };
}

/**
 * Emit exactly the format `tests/tactical_puzzles.js` runs. Every literal goes through
 * `JSON.stringify`, so a move name with an apostrophe, a backslash or a newline cannot produce
 * code that fails to parse.
 *
 * Two accepted call shapes: `generatePuzzleCode(analysis, options)` with what `analyzeLoss()`
 * returned, or the terse `generatePuzzleCode(turnNumber, { report })`, which derives the same fields
 * from the report's own log (see `analysisFromTurn`). Both return null when the analysis found no
 * blunder, and both throw with a named reason rather than emitting a puzzle that cannot be replayed.
 */
function generatePuzzleCode(analysis, options) {
  options = options || {};
  if (typeof analysis === 'number') analysis = analysisFromTurn(analysis, options);
  if (!analysis || typeof analysis !== 'object') {
    throw new Error('generatePuzzleCode: an analysis object from analyzeLoss() — or a turn number ' +
      'plus { report } — is required');
  }
  if (!analysis.found) return null;
  if (!Array.isArray(analysis.logPrefix) || !analysis.logPrefix.length) {
    throw new Error('generatePuzzleCode: the analysis carries no logPrefix to replay');
  }
  const forbidden = analysis.forbiddenMove || (analysis.chosen && analysis.chosen.name);
  if (!forbidden) {
    throw new Error('generatePuzzleCode: the analysis names no forbidden line');
  }
  const stamp = options.now || Date.now();
  const name = String(options.namePrefix || 'AutoVaccine_Loss_') + stamp;
  const valid = (analysis.alternatives || [])
    .map(function (a) { return a && a.name; })
    .filter(Boolean)
    .slice(0, options.maxAlternatives || 3);
  const lines = [];
  lines.push('// AUTO-GENERATED BY BLUNDER HARVESTER [Turn ' + analysis.blunderTurn + ']');
  lines.push('// the line the engine chose (drop ' + (typeof analysis.drop === 'number' ? analysis.drop.toFixed(1) : '?') +
    ' points of its own evaluation, ' +
    (typeof analysis.before === 'number' ? analysis.before.toFixed(1) : '?') + ' -> ' +
    (typeof analysis.after === 'number' ? analysis.after.toFixed(1) : '?') + ')' +
    (analysis.punish && analysis.punish.name ? '; punished by ' + analysis.punish.name : ''));
  lines.push('testPuzzle(' + JSON.stringify(name) + ', {');
  lines.push('  logPrefix: ' + JSON.stringify(analysis.logPrefix) + ',');
  lines.push('  forbiddenMove: ' + JSON.stringify(forbidden) + ',');
  lines.push('  validTopMoves: ' + JSON.stringify(valid));
  lines.push('});');
  return lines.join('\n') + '\n';
}

/** The puzzle name a chunk of generated code registers, or null when it registers none. */
function puzzleNameOf(code) {
  const m = /testPuzzle\(\s*("(?:[^"\\]|\\.)*")/.exec(String(code || ''));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    return null;
  }
}

function writeAtomically(target, content, previous) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, '.' + path.basename(target) + '.tmp-' + process.pid + '-' + Date.now());
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, target);
    return;
  } catch (e) {
    // Windows refuses rename onto an existing file; copying over it is the same guarantee here
    // because the content is already fully written to the temp file.
    try {
      fs.copyFileSync(tmp, target);
      fs.unlinkSync(tmp);
      return;
    } catch (e2) {
      try { fs.unlinkSync(tmp); } catch (e3) { /* already gone */ }
      fs.writeFileSync(target, previous, 'utf8');
      throw new Error('appendVaccineToFile: could not write ' + target + ' (' + e2.message + ')');
    }
  }
}

/**
 * appendVaccineToFile(code, targetFile) -> { appended, file, name, willFailUntilFixed, reason }
 * The generated call goes ABOVE the sentinel so it is registered before the runner executes.
 */
function appendVaccineToFile(code, targetFile) {
  const target = path.resolve(targetFile || DEFAULT_TARGET);
  const name = puzzleNameOf(code);
  if (!name) throw new Error('appendVaccineToFile: the code registers no testPuzzle(...) call');

  const existed = fs.existsSync(target);
  const previous = existed ? fs.readFileSync(target, 'utf8') : skeleton();
  if (!existed) {
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  if (previous.indexOf(name) !== -1) {
    return { appended: false, file: target, name: name, reason: 'duplicate' };
  }
  const at = previous.indexOf(SENTINEL);
  if (at === -1) {
    throw new Error('appendVaccineToFile: ' + target + ' has no "' + SENTINEL + '" marker to ' +
      'insert above — refusing to append somewhere the puzzle would never be registered');
  }
  const next = previous.slice(0, at) + code + (code.slice(-1) === '\n' ? '' : '\n') + previous.slice(at);
  try {
    new vm.Script(next, { filename: target });
  } catch (e) {
    throw new Error('appendVaccineToFile: refusing to write ' + target + ' — the result would not ' +
      'parse (' + e.message + ')');
  }
  writeAtomically(target, next, previous);
  return {
    appended: true,
    file: target,
    name: name,
    /* A brand-new vaccine pins a defect the engine still has, so it fails until that defect is
     * fixed. Stated in the return value so the CLI can report it honestly instead of implying a
     * green suite. */
    willFailUntilFixed: true
  };
}

module.exports = {
  BlunderHarvester: BlunderHarvester,
  generatePuzzleCode: generatePuzzleCode,
  analysisFromTurn: analysisFromTurn,
  appendVaccineToFile: appendVaccineToFile,
  puzzleNameOf: puzzleNameOf,
  isDecisionFrame: isDecisionFrame,
  SENTINEL: SENTINEL,
  DEFAULT_TARGET: DEFAULT_TARGET,
  skeleton: skeleton
};

/* ------------------------------------------------------------------- self-check */

if (require.main === module) {
  const results = [];
  function ok(name, cond, detail) {
    results.push({ name: name, ok: !!cond });
    console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond || detail === undefined ? '' : '  ->  ' + detail));
  }
  function section(t) { console.log('\n=== ' + t + ' ==='); }

  section('emission is syntactically valid and carries the frozen shape');
  const analysis = {
    found: true,
    blunderTurn: 7,
    before: 214.5,
    after: -398.25,
    drop: -612.75,
    chosen: { kind: 'move', name: "King's Shield", moveId: 'kingsshield' },
    forbiddenMove: "King's Shield",
    punish: { kind: 'move', name: 'Knock Off' },
    alternatives: [
      { name: 'Headlong Rush', score: -12.5 },
      { name: 'Rapid Spin', score: -40 },
      { name: 'Great Tusk', score: -88 },
      { name: 'Close Combat', score: -120 }
    ],
    logPrefix: ['|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100', '|turn|7', '|request|{"side":{"id":"p1"}}']
  };
  const code = generatePuzzleCode(analysis, { now: 1700000000000 });
  new vm.Script(code, { filename: 'emitted-puzzle.js' });
  ok('the generated code parses', true);
  ok('the puzzle name is pinned by opts.now', puzzleNameOf(code) === 'AutoVaccine_Loss_1700000000000', puzzleNameOf(code));
  ok('the apostrophe in the move name survives', code.indexOf('"King\'s Shield"') !== -1);
  // Four alternatives were offered; the emission keeps the best three, so the fourth must not
  // appear. (The logPrefix mentions nothing from that list, so these matches are the emission's.)
  ok('alternatives are capped at three, the fourth is dropped',
    (code.match(/Headlong Rush|Rapid Spin|Close Combat/g) || []).length === 2 && code.indexOf('Close Combat') === -1,
    JSON.stringify(analysis.alternatives.map(function (a) { return a.name; })));
  ok('no blunder means no code', generatePuzzleCode({ found: false, reason: 'x' }) === null);
  let threw = false;
  try { generatePuzzleCode({ found: true, logPrefix: [], forbiddenMove: 'x' }); } catch (e) { threw = true; }
  ok('a prefix-less analysis is refused', threw);

  section('append is idempotent, marker-bound and rollback-safe');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-'));
  const target = path.join(dir, 'puzzles.js');
  const first = appendVaccineToFile(code, target);
  ok('the first append creates the file from the skeleton', first.appended && fs.existsSync(target));
  const written = fs.readFileSync(target, 'utf8');
  ok('the call landed above the sentinel', written.indexOf(code.trim()) < written.indexOf(SENTINEL));
  ok('the resulting file parses', (function () {
    try { new vm.Script(written); return true; } catch (e) { return false; }
  })());
  const second = appendVaccineToFile(code, target);
  ok('the same vaccine is not appended twice', second.appended === false && second.reason === 'duplicate');
  const other = appendVaccineToFile(generatePuzzleCode(analysis, { now: 1700000000001 }), target);
  ok('a different vaccine does append', other.appended === true);
  const withoutMarker = path.join(dir, 'nomarker.js');
  fs.writeFileSync(withoutMarker, "'use strict';\nfunction testPuzzle(){}\n");
  let markerThrew = false;
  try { appendVaccineToFile(code, withoutMarker); } catch (e) { markerThrew = true; }
  ok('a file without the marker is refused, not corrupted',
    markerThrew && fs.readFileSync(withoutMarker, 'utf8').indexOf('AutoVaccine') === -1);

  section('the engine-driven path runs end to end');
  let engineNote = '';
  try {
    const paste = [
      'Great Tusk @ Choice Scarf', 'Ability: Protosynthesis', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
      '- Headlong Rush', '- Close Combat', '- Ice Spinner', '- Rapid Spin'
    ].join('\n');
    const log = [
      '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
      '|switch|p2a: Iron Valiant|Iron Valiant, L50, F|100/100',
      '|turn|6',
      '|request|' + JSON.stringify({
        side: { id: 'p1', pokemon: [{ ident: 'p1: Great Tusk', condition: '100/100', active: true, moves: ['headlongrush'] }] },
        active: [{ moves: [{ move: 'Headlong Rush', id: 'headlongrush', pp: 16, maxpp: 16 }, { move: 'Close Combat', id: 'closecombat', pp: 8, maxpp: 8 }, { move: 'Rapid Spin', id: 'rapidspin', pp: 32, maxpp: 32 }] }]
      }),
      '|move|p2a: Iron Valiant|Moonblast|p1a: Great Tusk',
      '|-damage|p1a: Great Tusk|12/100',
      '|turn|7',
      '|request|' + JSON.stringify({
        side: { id: 'p1', pokemon: [{ ident: 'p1: Great Tusk', condition: '12/100', active: true, moves: ['headlongrush'] }] },
        active: [{ moves: [{ move: 'Headlong Rush', id: 'headlongrush', pp: 15, maxpp: 16 }, { move: 'Close Combat', id: 'closecombat', pp: 8, maxpp: 8 }, { move: 'Rapid Spin', id: 'rapidspin', pp: 32, maxpp: 32 }] }]
      })
    ];
    const harvest = new BlunderHarvester();
    const found = harvest.analyzeLoss({ winner: 'p2', fullLog: log }, { paste: paste });
    const emitted = found.found ? generatePuzzleCode(found, { now: 1700000000002 }) : null;
    if (emitted) new vm.Script(emitted, { filename: 'engine-puzzle.js' });
    engineNote = found.found
      ? 'pinned turn ' + found.blunderTurn + ' (' + found.before.toFixed(1) + ' -> ' + found.after.toFixed(1) +
        ', punished by ' + (found.punish && found.punish.name) + ')'
      : 'no blunder in this synthetic log: ' + found.reason;
    ok('analyzeLoss returns a well-formed verdict on a real engine session', !!found && typeof found.found === 'boolean', JSON.stringify(found && found.reason));
    ok('a found blunder emits code that parses', !found.found || !!emitted);
  } catch (e) {
    ok('the engine-driven path runs', false, e && e.message);
  }
  console.log('  note: ' + engineNote);

  const failed = results.filter(function (r) { return !r.ok; }).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' self-checks passed');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
  process.exit(failed ? 1 : 0);
}
