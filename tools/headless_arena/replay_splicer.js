/* Showdown Tactician — tools/headless_arena/replay_splicer.js
 *
 * WHY THIS EXISTS
 *   A fresh battle from turn 1 spends its first eight turns on team-preview guesses and
 *   Stealth Rock, which is exactly the part of the game the engine already plays well. The
 *   interesting turns are the volatile ones — something faints, a hazard or screen lands, a body
 *   loses most of its HP. Those are the turns a human replay preserves and a synthetic game
 *   almost never reaches at the same tempo.
 *
 *   So the arena starts from a real replay: `findCrucibleTurn` locates the most volatile turn at
 *   or after turn 8, and `spliceAndResume` fast-forwards a headless battle to the state *before*
 *   that turn by feeding the replay's own recorded choices into @pkmn/sim, then hands both sides
 *   to live agents so the timeline branches into a new game.
 *
 * THE HONESTY REQUIREMENT (read this before trusting a splice)
 *   A Showdown replay log does NOT carry the RNG seed, and the seed decides damage rolls, crits,
 *   misses and speed ties. A spliced game therefore cannot reproduce the original log's numbers
 *   unless the caller supplies the seed that produced it. Rather than pretend otherwise, this
 *   module MEASURES fidelity: at handover it compares the sim's own state (active species and HP
 *   percentage per side) against the replay's state at the same point and reports
 *   `fidelity:{score, matched, mismatched, fields}` plus `diverged`/`divergenceReason`. Measured
 *   against the sim's own recorded log with a matching seed it is exact (score 1); against a
 *   human replay with no seed it is a probability, and it says so.
 *
 * WHY THE REPO PARSER AND THE RAW FRAME ARE BOTH USED
 *   `ST.ProtocolParser` is driven over every line so the repo's own turn tracking and frame
 *   classification are the turn source (`parser.currentTurn`), but the *fields* are read off the
 *   raw `|`-separated frame. A replay's HP percentages, idents and species details must round-trip
 *   verbatim to replay the choices and to compare state, and those exact strings are the raw
 *   frame; the parser's normalized event is metadata, never a substitute for the numbers.
 *
 * MEASURED FACTS THIS FILE DEPENDS ON (verified against @pkmn/sim 0.10.11)
 *   - The format id is `gen9nationaldex` (that IS [Gen 9] National Dex OU at the OU tier).
 *   - Choices written to `players.pX` must be BARE (`move earthquake`, `switch Toxapex`); the
 *     stream adds the `>pX ` prefix itself.
 *   - `switch <species>` is accepted and is what we replay, because a replay's `|switch|` frame
 *     carries a nickname that may differ from the species (`|switch|p2a: Slowking|Slowking-Galar,
 *     L50, M|100/100`), and the sim resolves species names.
 *   - Team preview is on; the order must carry one digit per team member.
 *
 * Run the self-check with:  node tools/headless_arena/replay_splicer.js [replayFile]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MIN_CRUCIBLE_TURN = 8;
const HP_DELTA_FRACTION = 0.5;
/* A fixed default so two runs of the same splice are comparable; callers pass their own seed
 * when they want a different roll set. */
const DEFAULT_SEED = [20261012, 7, 9, 4];

function bridge() { return require('./engine_bridge.js'); }
function runnerModule() { return require('./sim_runner.js'); }
function teamsModule() { return require('./teams.js'); }

/* ------------------------------------------------------------------ small helpers */

function toID(text) {
  return String(text === null || text === undefined ? '' : text).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** `|move|p1a: X|Earthquake|p2a: Y|[from]…` -> ['move','p1a: X','Earthquake','p2a: Y','[from]…'] */
function frame(line) {
  const raw = String(line === null || line === undefined ? '' : line);
  return raw.split('|');
}

function commandOf(line) {
  const parts = frame(line);
  return parts.length > 1 ? parts[1] : '';
}

/** `Slowking-Galar, L50, M` -> `Slowking-Galar`; `` -> ''. */
function speciesOf(details) {
  const text = String(details || '').split(',')[0].trim();
  return text;
}

/** A `scan()` result, so callers can pass the object instead of re-walking the log. */
function isScanned(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.perTurn));
}

/** `95/100 brn` -> 95; `0 fnt` -> 0; unparsable -> null. */
function hpPercentOf(condition) {
  const text = String(condition || '').trim();
  if (!text) return null;
  if (/^0\s/.test(text)) return 0;
  const slash = text.indexOf('/');
  if (slash === -1) return null;
  const before = text.slice(0, slash).replace(/[^0-9.]/g, '');
  if (!before) return null;
  const value = parseFloat(before);
  return isNaN(value) ? null : value;
}

function sideOfIdent(ident) {
  const text = String(ident || '');
  if (text.indexOf('p1') === 0) return 'p1';
  if (text.indexOf('p2') === 0) return 'p2';
  return null;
}

/** The active slot letter (`a`) of an ident like `p1a: Toxapex`. */
function slotOfIdent(ident) {
  const text = String(ident || '');
  const colon = text.indexOf(':');
  const head = colon === -1 ? text : text.slice(0, colon);
  return head.length > 2 ? head.charAt(2) : 'a';
}

/* ------------------------------------------------------------------------ parser */

let cachedParser = null;

/**
 * The repo's protocol parser, driven over every line so the turn counter is the parser's own.
 * `parseLine` is the pure classifier; `feed` advances `currentTurn`. Both are wrapped because a
 * replay can contain frames from a future protocol version and a malformed line must not abort a
 * splice (the raw frame is still replayable).
 */
function getProtocolParser() {
  if (cachedParser) return cachedParser;
  const loaded = bridge().loadHarness();
  const ST = loaded.ST;
  if (!ST || !ST.ProtocolParser) {
    throw new Error('replay_splicer: ST.ProtocolParser is missing from the harness sandbox — ' +
      'the scanner needs the repo parser for turn tracking');
  }
  cachedParser = new ST.ProtocolParser();
  return cachedParser;
}

/* -------------------------------------------------------------------------- scan */

/**
 * One pass over a replay. Returns everything the other methods need, so scanning is not repeated
 * per question. `perTurn` holds a bucket for every `|turn|N` marker plus a bucket for turn 0
 * (team preview up to the first `|turn|1`), which is where forced switches after a faint or a
 * `|drag|` are recorded.
 */
function scan(replayLines) {
  const lines = [];
  const input = Array.isArray(replayLines) ? replayLines : String(replayLines || '').split('\n');
  for (let i = 0; i < input.length; i++) {
    const raw = String(input[i] === null || input[i] === undefined ? '' : input[i]).replace(/\r$/, '');
    if (raw) lines.push(raw);
  }

  const parser = (function () {
    try { return getProtocolParser(); } catch (e) { return null; }
  })();

  const result = {
    lines: lines,
    formatId: '',
    winner: null,
    turnCount: 0,
    requestedTurn: 0,
    parserTurns: 0,
    teams: { p1: [], p2: [] },
    leads: { p1: null, p2: null },
    perTurn: [],
    skippedFrames: 0
  };

  const bucketFor = function (turn) {
    for (let i = 0; i < result.perTurn.length; i++) {
      if (result.perTurn[i].turn === turn) return result.perTurn[i];
    }
    const fresh = {
      turn: turn, p1: { moves: [], switches: [] }, p2: { moves: [], switches: [] },
      events: [], faints: [], sidestarts: [], hpStart: {}, hpEnd: {}, hpMin: {}, hpMax: {}
    };
    result.perTurn.push(fresh);
    result.perTurn.sort(function (a, b) { return a.turn - b.turn; });
    return fresh;
  };

  let currentTurn = 0;
  /* Flags that precede the action they belong to: `|-mega|p2a: X|X-Mega|…` then `|move|p2a: X|…`.
   * The same shape is used for Z-moves and Terastallization. */
  const pendingFlag = { p1: null, p2: null };

  bucketFor(0);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.charAt(0) !== '|') {
      /* `>battle-…`, `>start …`, `>player …` — the client's own wrapper, not battle state. */
      continue;
    }
    if (parser) {
      try {
        parser.parseLine(line);
        parser.feed(line);
        if (typeof parser.currentTurn === 'number') {
          result.parserTurns = parser.currentTurn;
          if (parser.currentTurn > currentTurn) {
            currentTurn = parser.currentTurn;
            bucketFor(currentTurn);
          }
        }
      } catch (e) {
        result.skippedFrames++;
      }
    }

    const parts = frame(line);
    const cmd = parts[1];
    const args = parts.slice(2);

    if (cmd === 'turn') {
      const n = parseInt(args[0], 10);
      if (!isNaN(n)) {
        currentTurn = n;
        result.requestedTurn = Math.max(result.requestedTurn, n);
        bucketFor(n);
      }
      continue;
    }
    if (cmd === 'tier' || cmd === 'init') {
      if (!result.formatId) result.formatId = String(args[0] || '');
      continue;
    }
    if (cmd === 'win' || cmd === 'tie') {
      result.winner = cmd === 'tie' ? 'tie' : String(args[0] || '');
      continue;
    }
    if (cmd === 'poke') {
      const side = args[0] === 'p1' ? 'p1' : (args[0] === 'p2' ? 'p2' : null);
      if (side) {
        const species = speciesOf(args[1]);
        if (species && result.teams[side].indexOf(species) === -1) result.teams[side].push(species);
      }
      continue;
    }

    const bucket = bucketFor(currentTurn);
    bucket.events.push(line);

    if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
      const ident = args[0];
      const side = sideOfIdent(ident);
      const species = speciesOf(args[1]);
      const hp = hpPercentOf(args[2]);
      if (side && species) {
        if (!result.leads[side] && cmd === 'switch') result.leads[side] = species;
        bucket[side].switches.push({ species: species, ident: ident, hp: hp, frame: line, kind: cmd });
        if (hp !== null) {
          bucket.hpStart[ident] = bucket.hpStart[ident] === undefined ? hp : bucket.hpStart[ident];
          bucket.hpEnd[ident] = hp;
          bucket.hpMin[ident] = Math.min(bucket.hpMin[ident] === undefined ? hp : bucket.hpMin[ident], hp);
          bucket.hpMax[ident] = Math.max(bucket.hpMax[ident] === undefined ? hp : bucket.hpMax[ident], hp);
        }
      }
      continue;
    }
    if (cmd === 'move') {
      const ident = args[0];
      const side = sideOfIdent(ident);
      if (side) {
        const flag = pendingFlag[side];
        pendingFlag[side] = null;
        bucket[side].moves.push({ name: args[1], moveId: toID(args[1]), ident: ident, flag: flag, frame: line });
      }
      continue;
    }
    if (cmd === '-mega' || cmd === 'mega') {
      const side = sideOfIdent(args[0]);
      if (side) pendingFlag[side] = 'mega';
      continue;
    }
    if (cmd === '-zpower' || cmd === 'zpower') {
      const side = sideOfIdent(args[0]);
      if (side) pendingFlag[side] = 'zmove';
      continue;
    }
    if (cmd === '-terastallize' || cmd === 'terastallize') {
      const side = sideOfIdent(args[0]);
      if (side) pendingFlag[side] = 'terastallize';
      continue;
    }
    if (cmd === 'faint') {
      bucket.faints.push({ ident: args[0], side: sideOfIdent(args[0]) });
      continue;
    }
    if (cmd === '-sidestart' || cmd === 'sidestart') {
      bucket.sidestarts.push({ side: args[0], effect: args[1], frame: line });
      continue;
    }
    if (cmd === '-damage' || cmd === '-heal' || cmd === '-sethp') {
      const ident = args[0];
      const hp = hpPercentOf(args[1]);
      if (hp !== null) {
        bucket.hpStart[ident] = bucket.hpStart[ident] === undefined ? hp : bucket.hpStart[ident];
        bucket.hpEnd[ident] = hp;
        bucket.hpMin[ident] = Math.min(bucket.hpMin[ident] === undefined ? hp : bucket.hpMin[ident], hp);
        bucket.hpMax[ident] = Math.max(bucket.hpMax[ident] === undefined ? hp : bucket.hpMax[ident], hp);
      }
      continue;
    }
    if (cmd === '-status') {
      const ident = args[0];
      const bucketHp = hpPercentOf(args[2]);
      if (bucketHp !== null) {
        bucket.hpStart[ident] = bucket.hpStart[ident] === undefined ? bucketHp : bucket.hpStart[ident];
        bucket.hpEnd[ident] = bucketHp;
      }
      continue;
    }
  }

  result.turnCount = result.requestedTurn;
  return result;
}

/** The largest one-turn HP swing any single body suffered or enjoyed, in percentage points. */
function maxHpSwing(bucket) {
  let best = 0;
  const idents = {};
  Object.keys(bucket.hpMin).forEach(function (k) { idents[k] = true; });
  Object.keys(bucket.hpMax).forEach(function (k) { idents[k] = true; });
  Object.keys(idents).forEach(function (ident) {
    const start = bucket.hpStart[ident];
    const min = bucket.hpMin[ident];
    const max = bucket.hpMax[ident];
    if (start === undefined) return;
    best = Math.max(best, Math.abs(start - min), Math.abs(max - start));
  });
  return best;
}

/* ------------------------------------------------------------------- crucible turn */

/**
 * Rank every turn at or after `minTurn` and return the most volatile one.
 *   score = 4 * faints + 2 * hazards/screens + (hpSwing > 50% ? 1 : 0) + hpSwing / 100
 * A faint is the strongest signal (a body left the field), a hazard or screen is next (it warps
 * every later turn), a large single-turn HP swing is the weakest. Ties go to the LATER turn,
 * because the later the splice, the closer the arena is to the endgame it is meant to stress.
 */
function findCrucibleTurn(replayLines, options) {
  options = options || {};
  const minTurn = typeof options.minTurn === 'number' ? options.minTurn : MIN_CRUCIBLE_TURN;
  const data = isScanned(replayLines) ? replayLines : scan(replayLines);
  const candidates = [];
  for (let i = 0; i < data.perTurn.length; i++) {
    const bucket = data.perTurn[i];
    if (bucket.turn < minTurn) continue;
    const swing = maxHpSwing(bucket);
    const bigSwing = swing > HP_DELTA_FRACTION * 100;
    if (!bucket.faints.length && !bucket.sidestarts.length && !bigSwing) continue;
    const score = 4 * bucket.faints.length + 2 * bucket.sidestarts.length + (bigSwing ? 1 : 0) + swing / 100;
    const reasons = [];
    if (bucket.faints.length) {
      reasons.push(bucket.faints.map(function (f) { return String(f.ident); }).join(' and ') + ' fainted');
    }
    if (bucket.sidestarts.length) {
      reasons.push(bucket.sidestarts.map(function (s) { return String(s.effect || '').replace(/^move: /, '') + ' was set on ' + String(s.side || ''); }).join('; '));
    }
    if (bigSwing) reasons.push('a single body swung ' + Math.round(swing) + '% in one turn');
    candidates.push({
      turnNumber: bucket.turn,
      reason: 'turn ' + bucket.turn + ': ' + reasons.join('; '),
      evidence: {
        faints: bucket.faints.slice(), sidestarts: bucket.sidestarts.slice(),
        hpSwing: Math.round(swing * 10) / 10, score: Math.round(score * 100) / 100
      },
      score: score
    });
  }
  if (!candidates.length) {
    return {
      turnNumber: null,
      reason: 'no turn at or after ' + minTurn + ' met the volatility bar (faint, hazard/screen, or >50% HP swing)',
      evidence: { faints: [], sidestarts: [], hpSwing: 0, score: 0, turnsScanned: data.turnCount }
    };
  }
  candidates.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return b.turnNumber - a.turnNumber;
  });
  const best = candidates[0];
  best.evidence.considered = candidates.length;
  return best;
}

/* ------------------------------------------------------------------ choice replay */

/**
 * The actions both sides actually took, in log order, each already in the sim's choice syntax.
 * Voluntarily switched and forced-switched bodies are the same frame at this level, which is
 * exactly right: the sim asks for a replacement with a `forceSwitch` request and the next queued
 * action for that side is the replacement the replay recorded.
 */
function extractTurnChoices(replayLines) {
  const data = scan(replayLines);
  const out = [];
  for (let i = 0; i < data.perTurn.length; i++) {
    const bucket = data.perTurn[i];
    events2choices(bucket, i === 0 ? 0 : bucket.turn, out);
  }
  out.sort(function (a, b) {
    if (a.turn !== b.turn) return a.turn - b.turn;
    if (a.side !== b.side) return a.side < b.side ? -1 : 1;
    return a.order - b.order;
  });
  return out;
}

/** Walk a bucket's events in their original order so the per-side sequence is exact. */
function events2choices(bucket, turn, out) {
  const pending = { p1: null, p2: null };
  for (let i = 0; i < bucket.events.length; i++) {
    const line = bucket.events[i];
    const parts = frame(line);
    const cmd = parts[1];
    const args = parts.slice(2);
    const side = sideOfIdent(args[0]);
    /* Only a voluntary `|switch|` is a submitted action. `|drag|` (a phazing move pulling a body
     * in) and `|replace|` (an Illusion breaking) are consequences, and the sim never asks for
     * them — replaying them as choices would shift every later action by one and desync the
     * splice, so they are tracked as state and skipped as actions. */
    if (cmd === 'switch') {
      if (!side) continue;
      const choice = 'switch ' + speciesOf(args[1]);
      out.push({ turn: turn, side: side, choice: choice, source: cmd, order: i, frame: line });
      pending[side] = null;
      continue;
    }
    if (cmd === 'drag' || cmd === 'replace') { if (side) pending[side] = null; continue; }
    if (cmd === '-mega' || cmd === 'mega') { if (side) pending[side] = 'mega'; continue; }
    if (cmd === '-zpower' || cmd === 'zpower') { if (side) pending[side] = 'zmove'; continue; }
    if (cmd === '-terastallize' || cmd === 'terastallize') { if (side) pending[side] = 'terastallize'; continue; }
    if (cmd === 'move') {
      if (!side) continue;
      const moveId = toID(args[1]);
      const flag = pending[side];
      pending[side] = null;
      out.push({
        turn: turn, side: side,
        choice: 'move ' + moveId + (flag ? ' ' + flag : ''),
        source: 'move', order: i, frame: line, flag: flag
      });
    }
  }
}

/**
 * The teams the replay implies, as sim-packed strings.
 * Only species survive a replay (item, ability and EV spread are hidden), so the packed team is
 * reconstructed from the repo's own set database by `teams.teamFromSpecies`, which falls back to
 * a curated sample team when the database cannot produce a legal six. `source` records which.
 */
function extractTeams(replayLines, options) {
  options = options || {};
  const data = isScanned(replayLines) ? replayLines : scan(replayLines);
  const out = {};
  ['p1', 'p2'].forEach(function (side) {
    const species = data.teams[side].slice();
    const entry = { species: species, lead: data.leads[side] || species[0] || null, packed: null, source: null, error: null };
    if (species.length) {
      try {
        const built = teamsModule().teamFromSpecies(species, options);
        entry.packed = built.packed;
        entry.source = built.source;
      } catch (e) {
        entry.error = e && e.message ? e.message : String(e);
      }
    }
    if (!entry.packed) {
      const samples = teamsModule().SAMPLE_TEAMS || {};
      const fallbackKey = side === 'p1' ? 'hazardStackBalance' : 'voltTurnOffense';
      const fallback = samples[fallbackKey] || samples[Object.keys(samples)[0]];
      if (fallback) {
        entry.packed = teamsModule().toSimTeam(fallback);
        entry.source = 'sample:' + fallbackKey + (entry.error ? ' (sets db failed: ' + entry.error + ')' : '');
      } else {
        throw new Error('replay_splicer: no team for ' + side + ' — the replay named no Pokemon and ' +
          'teams.SAMPLE_TEAMS is empty');
      }
    }
    out[side] = entry;
  });
  out.formatId = data.formatId;
  return out;
}

/** The team-preview order that fields the replay's lead first, then everyone else. */
function teamOrderFor(teamPacked, leadSpecies, request) {
  const size = request && request.side && request.side.pokemon ? request.side.pokemon.length
    : String(teamPacked || '').split(']').filter(Boolean).length;
  const order = [];
  for (let i = 1; i <= size; i++) order.push(i);
  if (!leadSpecies) return 'team ' + order.join('');
  const names = String(teamPacked || '').split(']').map(function (set) { return speciesOf(set.split('|')[0] || ''); });
  const wanted = toID(leadSpecies);
  let at = -1;
  for (let i = 0; i < names.length; i++) {
    if (toID(names[i]) === wanted) { at = i; break; }
  }
  if (at > 0) {
    const moved = order.splice(at, 1)[0];
    order.unshift(moved);
  }
  return 'team ' + order.join('');
}

/* ------------------------------------------------------------------- state compare */

/**
 * Per-side active species and HP percentage immediately BEFORE `turn` starts, from any log.
 * Symmetric on purpose: the same walker reads the human replay and the sim's own log, so the
 * comparison cannot be biased by reading one side with different rules.
 */
function stateBeforeTurn(replayLines, turn) {
  const lines = Array.isArray(replayLines) ? replayLines : String(replayLines || '').split('\n');
  const state = {
    turn: turn,
    p1: { species: null, hp: null, ident: null, fainted: [] },
    p2: { species: null, hp: null, ident: null, fainted: [] },
    reached: false
  };
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '');
    if (line.charAt(0) !== '|') continue;
    const parts = frame(line);
    const cmd = parts[1];
    const args = parts.slice(2);
    if (cmd === 'turn') {
      const n = parseInt(args[0], 10);
      if (n === turn) { state.reached = true; return state; }
      continue;
    }
    if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
      const side = sideOfIdent(args[0]);
      if (side) {
        state[side].species = speciesOf(args[1]);
        state[side].hp = hpPercentOf(args[2]);
        state[side].ident = args[0];
      }
      continue;
    }
    if (cmd === '-damage' || cmd === '-heal' || cmd === '-sethp') {
      const side = sideOfIdent(args[0]);
      const hp = hpPercentOf(args[1]);
      if (side && hp !== null && args[0] === state[side].ident) state[side].hp = hp;
      continue;
    }
    if (cmd === 'faint') {
      const side = sideOfIdent(args[0]);
      if (side) state[side].fainted.push(args[0]);
      continue;
    }
  }
  return state;
}

/** A four-field comparison: each side's active species and HP percentage. */
function compareState(expected, actual) {
  const fields = [];
  ['p1', 'p2'].forEach(function (side) {
    fields.push({ name: side + '.species', expected: expected[side].species, actual: actual[side].species });
    fields.push({ name: side + '.hp', expected: expected[side].hp, actual: actual[side].hp });
  });
  let matched = 0;
  const mismatched = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const same = String(f.expected) === String(f.actual);
    if (same) matched++; else mismatched.push(f);
  }
  const score = fields.length ? matched / fields.length : 0;
  let reason = null;
  if (mismatched.length) {
    reason = mismatched.slice(0, 2).map(function (f) {
      return f.name + ' was ' + JSON.stringify(f.expected) + ' in the replay but ' +
        JSON.stringify(f.actual) + ' in the sim';
    }).join('; ');
  }
  return { score: score, matched: matched, mismatched: mismatched, fields: fields, reason: reason };
}

/* ------------------------------------------------------------------------ agents */

/**
 * Replays the recorded actions for one side, in order, until its queue is exhausted.
 * Re-request safety: if the sim asks the same side twice for the same decision (which is what it
 * does after `|error|[Invalid choice]`), the recorded action was rejected — so the agent returns
 * a legal fallback instead of the same rejected string, and records the desync. That keeps a
 * splice from spinning without hiding the fact that it drifted.
 */
class PlaybackAgent {
  constructor(options) {
    options = options || {};
    this.side = options.side || 'p1';
    this.name = options.name || ('Playback-' + this.side);
    this.queue = (options.choices || []).slice();
    this.index = 0;
    this.teamOrder = options.teamOrder || null;
    this.used = [];
    this.desyncs = [];
    this.lastSignature = null;
    this.lastTurn = 0;
    if (options.verbose) this.verbose = true;
  }

  get remaining() { return Math.max(0, this.queue.length - this.index); }

  signature(request, turn) {
    const rqid = request && request.rqid !== undefined ? request.rqid : '?';
    return this.side + '|' + turn + '|' + rqid + '|' + (request && request.teamPreview ? 'preview' : (request && request.forceSwitch ? 'switch' : 'move'));
  }

  chooseAction(request, context) {
    const ctx = context || {};
    const turn = typeof ctx.turn === 'number' ? ctx.turn : this.lastTurn;
    if (request && request.teamPreview) {
      this.lastTurn = turn;
      this.lastSignature = this.signature(request, turn);
      if (!this.teamOrder) this.teamOrder = bridge().teamPreviewOrder(request);
      return this.teamOrder;
    }
    if (request && request.wait) return null;
    const sig = this.signature(request, turn);
    if (sig === this.lastSignature) {
      const rejected = this.queue[this.index - 1];
      const fallback = safeFallback(request, ctx);
      this.desyncs.push({
        turn: turn, rejected: rejected ? rejected.choice : null, fallback: fallback,
        why: 'the sim re-requested the same decision, so the recorded action was rejected'
      });
      return fallback;
    }
    this.lastSignature = sig;
    this.lastTurn = turn;
    const next = this.queue[this.index];
    if (!next) {
      const fallback = safeFallback(request, ctx);
      this.desyncs.push({ turn: turn, rejected: null, fallback: fallback, why: 'the recorded actions ran out' });
      return fallback;
    }
    this.index++;
    this.used.push(next);
    return next.choice;
  }
}

function safeFallback(request, context) {
  try {
    const R = runnerModule();
    if (typeof R.firstLegalChoice === 'function') {
      const c = R.firstLegalChoice(request, context);
      if (c) return c;
    }
  } catch (e) { /* fall through to the local rule */ }
  if (request && request.teamPreview) return bridge().teamPreviewOrder(request);
  if (request && request.forceSwitch) {
    const mons = (request.side && request.side.pokemon) || [];
    for (let i = 0; i < mons.length; i++) {
      if (request.forceSwitch[i] && !mons[i].active && !/fnt/.test(String(mons[i].condition || ''))) {
        return 'switch ' + (i + 1);
      }
    }
    return null;
  }
  if (request && request.active) {
    const moves = (request.active[0] && request.active[0].moves) || [];
    for (let i = 0; i < moves.length; i++) if (!moves[i].disabled) return 'move ' + (i + 1);
    return 'move 1';
  }
  return null;
}

/** Plays recorded actions until `handoverTurn`, then defers to the live agent for good. */
class HandoverAgent {
  constructor(options) {
    options = options || {};
    this.name = options.name || ('Handover-' + (options.side || 'p1'));
    this.side = options.side || 'p1';
    this.playback = options.playback;
    this.agent = options.agent;
    this.handoverTurn = typeof options.handoverTurn === 'number' ? options.handoverTurn : 0;
    this.handed = false;
    this.handoverTurnSeen = null;
  }

  chooseAction(request, context) {
    const ctx = context || {};
    const turn = typeof ctx.turn === 'number' ? ctx.turn : this.playback.lastTurn;
    if (!this.handed && turn >= this.handoverTurn && !(request && request.teamPreview)) {
      this.handed = true;
      this.handoverTurnSeen = turn;
    }
    if (!this.handed) return this.playback.chooseAction(request, ctx);
    if (!this.agent || typeof this.agent.chooseAction !== 'function') {
      throw new Error('replay_splicer: the battle reached turn ' + turn + ' but the live agent for ' +
        this.side + ' has no chooseAction(request, context)');
    }
    return this.agent.chooseAction(request, ctx);
  }
}

/* ------------------------------------------------------------------------ splicer */

class ReplaySplicer {
  constructor(options) {
    options = options || {};
    this.options = options;
    this.maxTurns = typeof options.maxTurns === 'number' ? options.maxTurns : 100;
    this.minTurn = typeof options.minTurn === 'number' ? options.minTurn : MIN_CRUCIBLE_TURN;
    this.seed = options.seed || DEFAULT_SEED;
    this.verbose = !!options.verbose;
  }

  scan(replayLines) {
    if (this._scan && this._scan.lines === replayLines) return this._scan;
    const data = scan(replayLines);
    data.__scanned = true;
    this._scan = data;
    return data;
  }

  findCrucibleTurn(replayLines) {
    return findCrucibleTurn(replayLines, { minTurn: this.minTurn });
  }

  extractTurnChoices(replayLines) {
    return extractTurnChoices(replayLines);
  }

  extractTeams(replayLines, options) {
    return extractTeams(replayLines, options || this.options);
  }

  /**
   * Fast-forward to the state before `targetTurn`, then hand both sides to the live agents.
   * `opts.teams` ({p1, p2} of packed strings) overrides the derived teams; `opts.seed` overrides
   * the fixed default seed, and passing the seed that produced the log makes the splice exact.
   */
  async spliceAndResume(replayLines, targetTurn, p1Agent, p2Agent, opts) {
    const options = opts || {};
    const data = this.scan(replayLines);
    const maxKnown = Math.max(data.turnCount, data.requestedTurn);
    if (!maxKnown) {
      throw new Error('replay_splicer: the replay carries no |turn| marker, so there is no state to splice');
    }
    if (typeof targetTurn !== 'number' || targetTurn < 1) {
      throw new Error('replay_splicer: spliceAndResume needs a turn number to splice at');
    }
    if (targetTurn > maxKnown) {
      throw new Error('replay_splicer: cannot splice at turn ' + targetTurn + ' — the replay only reaches turn ' + maxKnown);
    }

    const derived = options.teams || this.extractTeams(replayLines, options);
    const p1Packed = derived.p1 && derived.p1.packed ? derived.p1.packed : derived.p1;
    const p2Packed = derived.p2 && derived.p2.packed ? derived.p2.packed : derived.p2;
    if (!p1Packed || !p2Packed) {
      throw new Error('replay_splicer: both sides need a packed team to launch the spliced battle');
    }

    const choices = options.choices || this.extractTurnChoices(replayLines);
    const playbackChoices = choices.filter(function (c) { return c.turn < targetTurn; });
    const bySide = { p1: [], p2: [] };
    for (let i = 0; i < playbackChoices.length; i++) {
      const c = playbackChoices[i];
      if (bySide[c.side]) bySide[c.side].push(c);
    }

    const reason = options.reason
      || (this.findCrucibleTurn(replayLines) || {}).reason
      || ('turn ' + targetTurn + ' requested by the caller');

    const playback = {
      p1: new PlaybackAgent({
        side: 'p1', choices: bySide.p1, verbose: this.verbose,
        teamOrder: teamOrderFor(p1Packed, data.leads.p1)
      }),
      p2: new PlaybackAgent({
        side: 'p2', choices: bySide.p2, verbose: this.verbose,
        teamOrder: teamOrderFor(p2Packed, data.leads.p2)
      })
    };

    const seed = options.seed || this.seed;
    /* The live agent takes over from the first decision of `targetTurn` onward; everything the
     * replay recorded before that point — including forced switches resolved after the previous
     * turn's moves — is played back, which is what makes the handover state identical. */
    const handover = {
      p1: new HandoverAgent({ side: 'p1', playback: playback.p1, agent: p1Agent, handoverTurn: targetTurn, name: (p1Agent && p1Agent.name) || 'Tactician' }),
      p2: new HandoverAgent({ side: 'p2', playback: playback.p2, agent: p2Agent, handoverTurn: targetTurn, name: (p2Agent && p2Agent.name) || 'Adversary' })
    };

    const R = runnerModule();
    if (typeof R.HeadlessBattleRunner !== 'function') {
      throw new Error('replay_splicer: sim_runner.js does not export HeadlessBattleRunner');
    }
    const battle = new R.HeadlessBattleRunner(bridge().SIM_FORMAT_ID);
    if (typeof battle.initBattle !== 'function') {
      throw new Error('replay_splicer: HeadlessBattleRunner has no initBattle(p1TeamPacked, p2TeamPacked, seed)');
    }
    battle.initBattle(p1Packed, p2Packed, seed);

    const report = await battle.runGame(handover.p1, handover.p2, options.maxTurns || this.maxTurns);

    const simLog = (report && report.fullLog) || [];
    const expected = stateBeforeTurn(data.lines, targetTurn);
    const actual = stateBeforeTurn(simLog, targetTurn);
    const fidelity = compareState(expected, actual);
    const playbackDesyncs = playback.p1.desyncs.concat(playback.p2.desyncs);
    const diverged = fidelity.score < 1 || playbackDesyncs.length > 0;
    let divergenceReason = null;
    if (fidelity.reason) divergenceReason = fidelity.reason;
    if (playbackDesyncs.length) {
      const d = playbackDesyncs[0];
      divergenceReason = (divergenceReason ? divergenceReason + '; ' : '') +
        'a recorded action was rejected at turn ' + d.turn + ' (' + d.rejected + ' -> ' + d.fallback + ')';
    }
    if (!diverged) divergenceReason = null;

    const spliced = {
      turn: targetTurn,
      reason: reason,
      seed: seed,
      playedBack: playback.p1.used.length + playback.p2.used.length,
      handoverReached: !!(handover.p1.handed && handover.p2.handed),
      fidelity: {
        score: Math.round(fidelity.score * 1000) / 1000,
        matched: fidelity.matched,
        mismatched: fidelity.mismatched.map(function (f) { return f.name; }),
        fields: fidelity.fields
      },
      diverged: diverged,
      divergenceReason: divergenceReason,
      desyncs: playbackDesyncs,
      teamsSource: { p1: derived.p1 && (derived.p1.source || 'caller'), p2: derived.p2 && (derived.p2.source || 'caller') }
    };

    if (this.verbose) {
      console.log('[splice] turn ' + targetTurn + ' — ' + reason);
      console.log('[splice] played back ' + spliced.playedBack + ' recorded actions; fidelity ' +
        spliced.fidelity.score + (spliced.diverged ? ' (diverged)' : ' (exact)'));
    }

    const out = Object.assign({}, report || {});
    out.spliced = spliced;
    return out;
  }
}

function readReplayFile(file, options) {
  const opts = options || {};
  const candidates = [];
  if (file) candidates.push(file);
  const root = path.join(__dirname, '..', '..');
  candidates.push(path.join(root, 'test_log.txt'));
  if (opts.corpus) candidates.push(opts.corpus);
  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const text = fs.readFileSync(candidate, 'utf8');
      return { path: candidate, lines: text.split('\n') };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error('replay_splicer: no replay readable' + (lastError ? ' (' + lastError.message + ')' : ''));
}

module.exports = {
  ReplaySplicer: ReplaySplicer,
  PlaybackAgent: PlaybackAgent,
  HandoverAgent: HandoverAgent,
  scan: scan,
  findCrucibleTurn: findCrucibleTurn,
  extractTurnChoices: extractTurnChoices,
  extractTeams: extractTeams,
  stateBeforeTurn: stateBeforeTurn,
  compareState: compareState,
  maxHpSwing: maxHpSwing,
  speciesOf: speciesOf,
  hpPercentOf: hpPercentOf,
  teamOrderFor: teamOrderFor,
  readReplayFile: readReplayFile,
  MIN_CRUCIBLE_TURN: MIN_CRUCIBLE_TURN,
  HP_DELTA_FRACTION: HP_DELTA_FRACTION,
  DEFAULT_SEED: DEFAULT_SEED
};

/* -------------------------------------------------------------------- self-check */

if (require.main === module) {
  (function () {
    const args = process.argv.slice(2);
    const file = args.filter(function (a) { return a.charAt(0) !== '-'; })[0];
    const splicer = new ReplaySplicer({ verbose: true });
    const replay = readReplayFile(file);
    console.log('replay:', replay.path, '|', replay.lines.filter(Boolean).length, 'lines');
    const data = splicer.scan(replay.lines);
    console.log('format:', data.formatId || '(unnamed)', '| turns:', data.turnCount, '| winner:', data.winner || '(none)');
    console.log('teams from |poke|: p1 ' + data.teams.p1.join(', '));
    console.log('                  p2 ' + data.teams.p2.join(', '));
    console.log('leads: p1 ' + data.leads.p1 + ' vs p2 ' + data.leads.p2);
    const crucible = splicer.findCrucibleTurn(replay.lines);
    console.log('crucible:', JSON.stringify(crucible, null, 1));
    const choices = splicer.extractTurnChoices(replay.lines);
    console.log('recorded actions:', choices.length);
    const around = choices.filter(function (c) { return crucible.turnNumber && c.turn >= crucible.turnNumber - 1 && c.turn <= crucible.turnNumber; });
    console.log('actions around the crucible turn:');
    around.forEach(function (c) { console.log('  t' + c.turn + ' ' + c.side + ' -> ' + c.choice); });
    if (crucible.turnNumber) {
      console.log('state before turn ' + crucible.turnNumber + ':',
        JSON.stringify(stateBeforeTurn(replay.lines, crucible.turnNumber)));
    }
    try {
      const derived = splicer.extractTeams(replay.lines);
      console.log('derived teams — p1 source:', derived.p1.source, '| p2 source:', derived.p2.source);
    } catch (e) {
      console.log('derived teams unavailable:', e.message);
    }
    console.log('playback order check — p1 first action:',
      (choices.filter(function (c) { return c.side === 'p1'; })[0] || {}).choice || '(none)');
  })();
}
