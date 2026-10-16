/* Showdown Tactician — tools/benchmark_human_match.js
 *
 * WHAT THIS MEASURES
 *   Policy fidelity: on every decision an elite human actually faced in a recorded battle, did
 *   the engine's #1 recommended line match the line they clicked, and was their line in its top
 *   two? This is a DECISION metric, not an evaluation metric — win-prediction AUC (which the
 *   weight pipeline already reports) says whether the 128D vector can tell a winning board from a
 *   losing one, and says nothing about whether the engine picks the move a strong player picks.
 *
 * WHY A REPLAY CORPUS AND NOT THE LADDER
 *   Every turn of a replay is a decision a real human made, with their rating attached, and the
 *   ground truth is already in the log. No personas, no 1-ply bots to beat, no ladder account at
 *   risk, no ragequits to pollute the percentage. The corpus is the 1,300-1,992 rated NatDex OU
 *   window fetched by `tools/fetch_replays.js` (`elite.json` is the 1,799+ slice).
 *
 * THE HONESTY PROBLEM (read this before quoting any number)
 *   A replay is the PUBLIC protocol stream. It carries `|move|` and `|switch|` — the RESULT of a
 *   choice — and it does NOT carry `|choose ...` (submitted privately) or `|request|` (sent
 *   privately to one side). Three consequences, each MEASURED and reported rather than assumed:
 *
 *   1. The choice must be INFERRED from the result line. Speed order, force-switched bodies,
 *      `|drag|`, and moves a player did not click at all (a `|move|` tagged `[from]Sleep Talk`,
 *      `[from]Metronome`, `[from]Dancer`, ...) all appear in the stream, so a turn is scored only
 *      when EXACTLY ONE non-called action line for that side is present. Everything else is
 *      counted in `skipped` with its reason and never silently becomes a "miss".
 *
 *   2. The engine's candidate MOVES for our side come from `state.legalActions.moves`, which the
 *      client fills from the `|request|` frame — which a replay does not contain. `getMyActions`
 *      therefore falls back to the moves that body has REVEALED so far in the log. On the turns
 *      where the human's click was not yet revealed, the action space could not have contained
 *      it; the clicked move is added for that one decision so the comparison measures the engine's
 *      ranking rather than the log's silence. Those turns are the `blind` column.
 *
 *   3. Because of (2) the candidate set starts tiny (turn 1 offers no attacks at all until
 *      something is revealed), and a candidate set of ONE move is not a decision — any ranking
 *      agrees with it. So the headline is reported on the CONTESTED subset (the engine had at
 *      least two alternative lines OF THE SAME KIND as the click), with the uncontested and
 *      revealed-only numbers beside it so the bias is visible instead of hidden.
 *
 *   4. `state.mySide` is written ONLY by a `|request|` line, so with no request the board is built
 *      from p1's point of view whatever side is being scored — a "p2" pass would score p2's clicks
 *      against p1's team. The side is therefore set explicitly before the log is fed, which is what
 *      that side's own request would have done. This is also why the menu above is written into
 *      `legalActions.moves` rather than a mon field: that is the channel the engine actually reads.
 *
 * WHAT IT IS NOT
 *   Not a ladder rating, and not an Elo prediction. The band table printed at the end is the
 *   reviewer-proposed heuristic mapping from agreement to ladder band; it is labelled
 *   UNCALIBRATED because nothing here has measured a real ladder account at both ends.
 *
 * Run me with:
 *   node tools/benchmark_human_match.js                       (elite.json, 100 battles, both sides)
 *   node tools/benchmark_human_match.js --input replays.json --battles 0
 *   node tools/benchmark_human_match.js --min-rating 1800 --side p1 --json --out decisions.json
 *
 * Exports (for tests/human_match_check.js): linesOf, replaysOf, probeCorpus, extractChoices,
 * classifySide, actionKey, actionKeyOf, scoreDecision, summarize, wilson, eloBand, rate, parseArgs.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* The reviewer's turn buckets. The opening is noise (both sides guess leads), a 6v1 is body
 * counting, and the mid-game trench is where a decision engine earns or loses its rating — so the
 * three are reported separately instead of being averaged into one misleading number. */
const OPENING_MAX_TURN = 5;
/* The consensus pass (below) only reports buckets with at least this many decisions: a bucket of one
 * or two draws states nothing about what "elites click here", and putting it in an average of bucket
 * rates is how a 399-battle corpus reads like a 20,000-decision one. */
const MIN_CONSENSUS_N = 5;
const MID_MAX_TURN = 15;

/* Effects that put a `|move|` line in the log WITHOUT the player having chosen that move. A turn
 * whose only action line carries one of these is not a decision the engine can be compared on. */
const CALLED_MOVE_RE = /\[from\]\s*(sleep ?talk|metronome|copycat|assist|nature ?power|mirror ?move|dancer|instruct|magic ?coat|magic ?bounce|snatch)/i;

/* A `|switch|` line that carries a `[from]` clause is a CONSEQUENCE of something else — a pivoting
 * move's own switch (U-turn, Volt Switch, Flip Turn, Parting Shot, Baton Pass, Teleport, Chilly
 * Reception), an Eject Button/Pack, a Red Card. The player submitted the MOVE, so the switch is not
 * a second action; counting it made every pivot turn look ambiguous and threw it away. */
const FROM_CLAUSE_RE = /\[from\]/i;

/* ------------------------------------------------------------------ small helpers */

function toID(text) {
  return String(text === null || text === undefined ? '' : text).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function linesOf(log) {
  if (Array.isArray(log)) return log.map(function (l) { return String(l).replace(/\r$/, ''); });
  return String(log === undefined || log === null ? '' : log).split('\n').map(function (l) {
    return l.replace(/\r$/, '');
  });
}

function replaysOf(corpus) {
  if (Array.isArray(corpus)) return corpus;
  if (corpus && Array.isArray(corpus.replays)) return corpus.replays;
  throw new Error('benchmark_human_match: input must be an array of replays or {replays:[...]}');
}

/** `Toxapex, M, shiny` -> `Toxapex`; a replay's `|switch|` carries details, not a bare name. */
function speciesOf(details) {
  return String(details === null || details === undefined ? '' : details).split(',')[0].trim();
}

/** `p1a: Water of Flood` -> 'p1'; anything else -> null. A replay uses nicknames, not species. */
function sideOfIdent(ident) {
  const text = String(ident === null || ident === undefined ? '' : ident);
  if (text.indexOf('p1') === 0) return 'p1';
  if (text.indexOf('p2') === 0) return 'p2';
  return null;
}

/* ------------------------------------------------------------- choice extraction */

/**
 * classifySide(bucketLines, side) -> { status, action }
 *
 * status is one of:
 *   'scorable'     exactly one non-called action line for that side — a real, comparable decision
 *   'ambiguous'    more than one (a forced replacement landed in the same bucket, or a doubled
 *                  frame) — the submitted click cannot be told apart from the consequence
 *   'cant'         the side was prevented from acting (`|cant|`) and the log shows no choice
 *   'unobservable' the side never acted (fainted first) or was pulled in by `|drag|`/`|replace|`
 *
 * action: { kind:'move', moveName, moveId } | { kind:'switch', species, speciesId }
 */
function classifySide(bucketLines, side) {
  const acts = [];
  let cant = false;
  let fainted = false;
  let forcedSwitch = false;
  const lines = Array.isArray(bucketLines) ? bucketLines : [];
  for (let i = 0; i < lines.length; i++) {
    const f = String(lines[i]).split('|');
    const cmd = f[1];
    if (cmd !== 'move' && cmd !== 'switch' && cmd !== 'drag' && cmd !== 'replace' && cmd !== 'cant' && cmd !== 'faint') continue;
    if (sideOfIdent(f[2]) !== side) continue;
    /* A body of ours fainted on this turn: every later `|switch|` for this side is the REPLACEMENT
     * the server asked for, not the click submitted at the top of the turn. Scoring the two as one
     * answer is what made ~12% of all turns look ambiguous. The turn's real click is the action
     * BEFORE the faint, so the replacement is dropped and counted as a forced-switch decision. */
    if (cmd === 'faint') { fainted = true; continue; }
    /* A `|switch|` in the stream is a submitted action; `|drag|` (a phazing move pulling a body
     * in) and `|replace|` (an Illusion breaking) are consequences the player never chose. */
    if (cmd === 'drag' || cmd === 'replace') continue;
    if (cmd === 'cant') { cant = true; continue; }
    if (cmd === 'switch') {
      if (fainted) { forcedSwitch = true; continue; }
      if (FROM_CLAUSE_RE.test(f.slice(4).join(' '))) { forcedSwitch = true; continue; }
      const species = speciesOf(f[3]);
      acts.push({ kind: 'switch', species: species, speciesId: toID(species), raw: lines[i] });
      continue;
    }
    /* cmd === 'move'. The `[from]` fields live past index 3 (index 3 is usually the target). */
    const extra = f.slice(4).join(' ');
    if (CALLED_MOVE_RE.test(extra)) continue;
    const moveName = f[3] || '';
    if (!moveName) continue;
    acts.push({ kind: 'move', moveName: moveName, moveId: toID(moveName), raw: lines[i] });
  }
  if (acts.length === 1) return { status: 'scorable', action: acts[0] };
  if (acts.length > 1) return { status: 'ambiguous', action: null };
  if (forcedSwitch) return { status: 'forcedSwitch', action: null };
  return { status: cant ? 'cant' : 'unobservable', action: null };
}

/**
 * extractChoices(replayLines) -> { format, turns: [ { turn, lines } ] }
 *
 * Pure: the log is split into per-turn buckets on the `|turn|N` headers, with bucket 0 holding
 * everything before `|turn|1` (the team-preview lead switches — a different decision type, out of
 * scope here). `format` is the log's own `|tier|`/`|init|` name, used to gate unsupported formats.
 */
function extractChoices(replayLines) {
  const lines = Array.isArray(replayLines) ? replayLines : linesOf(replayLines);
  const turns = [];
  let current = { turn: 0, lines: [] };
  let format = null;
  turns.push(current);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (format === null) {
      const tier = /^\|(?:tier|init)\|(.+)$/.exec(line);
      if (tier) format = tier[1].trim();
    }
    const m = /^\|turn\|(\d+)/.exec(line);
    if (m) {
      current = { turn: parseInt(m[1], 10) || 0, lines: [] };
      turns.push(current);
      continue;
    }
    current.lines.push(line);
  }
  return { format: format, turns: turns };
}

/* ------------------------------------------------------------------- identity */

/** The human's action as a comparable key: `move:scald` / `switch:greattusk`. */
function actionKey(action) {
  if (!action) return null;
  if (action.kind === 'switch') return 'switch:' + toID(action.speciesId || action.species);
  return 'move:' + toID(action.moveId || action.moveName);
}

/** The same key for one of the engine's ranked rows. A switch row names a species in `targetId`. */
function actionKeyOf(row) {
  if (!row) return null;
  if (row.kind === 'switch') return 'switch:' + toID(row.targetId || row.name);
  return 'move:' + toID(row.moveId || row.name);
}

/* ------------------------------------------------------------------ statistics */

/** Wilson score interval (95%). Reported because these rates have n in the hundreds, not ∞. */
function wilson(k, n, z) {
  z = typeof z === 'number' ? z : 1.96;
  if (!n) return { lo: 0, hi: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d) };
}

function rate(k, n) { return n ? k / n : null; }

/* The reviewer's proposed mapping from action agreement to ladder band. NOT measured here: no
 * real ladder account was played, so this is a hypothesis with a shape, and it is printed with
 * `calibrated:false` so nobody can mistake it for a result. */
const ELO_BANDS = [
  { min: 0.70, label: '>70%  Grandmaster fidelity', note: 'thinks like the top of the ladder' },
  { min: 0.55, label: '55-65%  High ladder (1650-1778+)', note: 'a strong human read' },
  { min: 0.40, label: '40-55%  Mid ladder (1400-1550)', note: 'competent, exploitable' },
  { min: 0.00, label: '<40%   Low ladder (~1200)', note: 'plays like a greedy bot' }
];

function eloBand(r) {
  if (typeof r !== 'number' || !isFinite(r)) return { label: 'n/a', note: 'no decisions evaluated', calibrated: false };
  for (let i = 0; i < ELO_BANDS.length; i++) {
    if (r >= ELO_BANDS[i].min) return { label: ELO_BANDS[i].label, note: ELO_BANDS[i].note, calibrated: false };
  }
  return { label: ELO_BANDS[ELO_BANDS.length - 1].label, note: 'no decisions evaluated', calibrated: false };
}

/* -------------------------------------------------------------- one decision */

function bucketOf(turn) {
  if (turn <= OPENING_MAX_TURN) return 'opening';
  if (turn <= MID_MAX_TURN) return 'mid';
  return 'endgame';
}

/**
 * scoreDecision(engine, state, cls, ctx) -> record
 *
 * `cls` is a classifySide() result; `ctx` is { U, turn, side, replay }. The engine is asked for the
 * decision exactly as the live client would ask it, with the one documented repair: if the human's
 * clicked move is not yet in the revealed set, it is added for this single decision and removed
 * again, so later turns see only what the log had actually revealed.
 */
function scoreDecision(engine, state, cls, ctx) {
  const base = { turn: ctx.turn, side: ctx.side, replay: ctx.replay, bucket: bucketOf(ctx.turn), status: cls.status };
  if (cls.status !== 'scorable') return base;
  const choice = cls.action;
  base.action = choice;
  base.key = actionKey(choice);

  /* A Z-Move or a Max Move is logged under the Z/Max move's own name, but the click was the base
   * move; the vendored dex exposes `isZMove`/`isMaxMove` and no base-move link, so these decisions
   * cannot be compared against the engine's candidate list and are excluded, counted. */
  if (choice.kind === 'move') {
    const data = ctx.U.getMoveData(choice.moveName);
    if ((data && (data.isZMove || data.isMaxMove)) || /^max\s/i.test(choice.moveName)) {
      base.status = 'special';
      return base;
    }
  }

  const active = state.active && state.active.my;
  if (!active) { base.status = 'noActive'; return base; }

  const before = engine.getMyActions(state) || [];
  const offeredBefore = before.map(actionKeyOf);
  base.blind = offeredBefore.indexOf(base.key) === -1;

  /* THE MENU, and the bug this file was first written with: the menu has to contain the human's
   * move DURING the evaluation, not before it. `getMyActions` reads `legalActions.moves` — the
   * `|request|` frame a replay does not carry — and falls back to the body's revealed moves. When
   * the click is not revealed yet that fallback cannot contain it, so the menu is rebuilt as (the
   * engine's own view of the moveset) + (the clicked move) for THIS decision, written into the
   * channel the engine actually reads, and restored afterwards so later turns see only what the
   * log had revealed by then. The engine's own view is taken as it stands, so nothing is added to
   * the menu that the fallback would not have offered. */
  const legal = state.legalActions;
  const synthesize = base.blind && choice.kind === 'move' && !!legal;
  let savedMoves = null;
  if (synthesize) {
    savedMoves = legal.moves;
    const menu = before.filter(function (a) { return a.kind !== 'switch'; }).map(function (a) {
      return { id: a.moveId, name: a.name };
    });
    if (!menu.some(function (m) { return toID(m.id) === toID(choice.moveId); })) {
      menu.push({ id: choice.moveId, name: choice.moveName });
    }
    legal.moves = menu;
  }

  let ranked = [];
  let offeredAfter = [];
  try {
    offeredAfter = engine.getMyActions(state) || [];
    const offeredKeys = offeredAfter.map(actionKeyOf);
    base.offered = offeredKeys.length;
    const wantSwitch = choice.kind === 'switch';
    const sameKind = offeredAfter.filter(function (a) { return (a.kind === 'switch') === wantSwitch; }).length;
    base.sameKind = sameKind;
    /* A candidate set of one line is not a decision: every ranking agrees with it, so the headline
     * is reported on the turns where the engine had at least two alternative lines of the kind the
     * human chose. `moveContested` narrows that to a real choice between ATTACKS. */
    base.contested = sameKind >= 2;
    base.moveContested = !wantSwitch && sameKind >= 2;
    /* The engine never offered a legal action the human took: for a switch that means the bench
     * fallback (capped at `laplace.maxSwitchFallback`) did not reach that body. Not a miss and not
     * a hit — unscoreable, counted separately. */
    if (offeredKeys.indexOf(base.key) === -1) { base.status = 'unavailable'; return base; }
    ranked = engine.evaluateTurn(state) || [];
  } catch (e) {
    ranked = [];
  } finally {
    if (synthesize) legal.moves = savedMoves;
  }
  if (!ranked.length) { base.status = 'noRanked'; return base; }

  const live = ranked.filter(function (r) { return !r.isVetoed; });
  const liveKeys = live.map(actionKeyOf);
  base.rank = liveKeys.indexOf(base.key);
  base.top1 = liveKeys.length ? liveKeys[0] === base.key : false;
  base.top2 = liveKeys.length ? liveKeys.slice(0, 2).indexOf(base.key) !== -1 : false;
  base.top1Kind = live.length ? live[0].kind : null;
  /* The best NON-pivot line. A switch-penalising change can be bounded without being implemented:
   * "if the engine had never pivoted on a turn it had an attack for, what would its top-1 have
   * been?" is the CEILING on any such change, and this records the number that answers it. */
  const firstMove = live.filter(function (r) { return r.kind !== 'switch'; })[0] || null;
  base.bestMoveKey = firstMove ? actionKeyOf(firstMove) : null;
  /* "Did the human click a line the deterministic guard refuses?" — the one number here that is a
   * statement about the ENGINE's rule set rather than about its ranking, and the code is kept so
   * the refusals can be argued with instead of just counted. */
  const vetoRow = ranked.filter(function (r) { return r.isVetoed && actionKeyOf(r) === base.key; })[0] || null;
  base.vetoed = !!vetoRow;
  base.vetoCode = vetoRow ? (vetoRow.vetoCode || 'UNKNOWN') : null;
  base.liveLines = liveKeys.length;
  base.topKeys = liveKeys.slice(0, 2);
  /* ---- THE SCORE GAP, which is the question agreement is only a proxy for ----------------------
   * `top1` says the human clicked the engine's first row. It does not say the human's line was
   * WORSE — and on a mixed equilibrium the top rows tie in value while the ranking still has to
   * order them, so agreement is blind to exactly the case where the engine is most likely to be
   * wrong. Every number below is a by-product of the ranking that was already computed (each live
   * row carries the engine's own `.score` for this turn), not a second evaluation.
   *   - `regret`      = topScore - humanScore, in the engine's own units (>= 0 means the human's
   *                     click scored below the engine's pick; a tie broken against the human reads
   *                     as 0, because ordering equal lines is not a loss).
   *   - `spread`      = topScore - the worst score the engine offered this turn.
   *   - `regretShare` = regret / spread, the bounded scale-free version (see regretShare()).
   *   - `regretRatio` = regret / |topScore|, the LITERAL "within 5 % of the engine's pick". Kept
   *                     because it is the framing people reach for, reported with its domain stated:
   *                     the evaluator's units cross zero, so it is ill-conditioned when the top line
   *                     scores near zero and it can exceed 1. The SHARE is the headline.
   * `stateKey` is the coarse bucket the consensus pass groups these decisions by. */
  const scoreOf = function (row) {
    return row && typeof row.score === 'number' && isFinite(row.score) ? row.score : null;
  };
  const topScore = scoreOf(live[0]);
  let worstScore = null;
  for (let i = 0; i < live.length; i++) {
    const v = scoreOf(live[i]);
    if (v === null) continue;
    if (worstScore === null || v < worstScore) worstScore = v;
  }
  const humanScore = base.rank >= 0 ? scoreOf(live[base.rank]) : null;
  base.topScore = topScore;
  base.humanScore = humanScore;
  base.spread = (topScore !== null && worstScore !== null) ? topScore - worstScore : null;
  base.regret = (topScore !== null && humanScore !== null) ? topScore - humanScore : null;
  base.regretShare = regretShare(base.regret, base.spread);
  base.regretRatio = (topScore !== null && humanScore !== null && Math.abs(topScore) > 0)
    ? base.regret / Math.abs(topScore) : null;
  base.stateKey = stateKeyOf(state);
  /* The COARSE key the consensus pass reports on. A few hundred battles spread over a fine key
   * leaves almost every bucket at n = 1 (measured: 80 buckets for 92 decisions on three battles), and
   * a bucket of one says nothing about what elites click here. The matchup is the coarsest grouping
   * that is still a statement about a POSITION rather than about a game, and `stateKey` is kept
   * beside it as the diagnostic that shows how thin the finer partition is. */
  base.pairKey = matchupKeyOf(state);
  return base;
}

/* ------------------------------------------------------------------- the engine */

/**
 * loadApi(sets) -> { ST, applied }
 *
 * `sets` (from --set) must reach the CONFIG before the modules that read it at LOAD time, which is
 * what the harness's `afterEach` window exists for: the patch lands the instant src/config.js has
 * been evaluated and every later file therefore sees it. Patching after loadAll() returns cannot
 * reach a module-level constant like `laplace.quiescence.extendSetup`.
 */
function loadApi(sets) {
  const harness = require('../tests/harness.js');
  const out = { ST: null, applied: null };
  const hooks = (sets && sets.length) ? {
    afterEach: function (sandbox, rel) {
      if (rel !== 'src/config.js') return;
      const built = buildConfigPatch(sandbox.ST, sets);
      sandbox.ST.configMerge(built.patch);
      /* READ BACK. A patch that silently failed to land would make every arm a byte-copy of the
       * shipped build — so every "this flag changes nothing" result would be a lie about the flag
       * instead of a finding about the engine. (That is exactly what the first version of this did:
       * it built the patch and never merged it, and the control that caught it was
       * `--set laplace.nash.enabled=false` changing 0 of 926 records.) */
      built.applied.forEach(function (p) {
        const sentinel = {};
        const now = sandbox.ST.configGet(p.path, sentinel);
        if (JSON.stringify(now) !== JSON.stringify(p.to)) {
          throw new Error('--set ' + p.path + ' did not take: config reads ' + JSON.stringify(now) +
            ', asked for ' + JSON.stringify(p.to));
        }
      });
      out.applied = built.applied;
    }
  } : undefined;
  const sandbox = harness.loadAll({
    setInterval: function () { return 0; },
    clearInterval: function () { }
  }, hooks);
  out.ST = sandbox.ST;
  return out;
}

/** The engine stack `src/content.js` builds, minus the HUD (DOM) and the LLM (network).
 *
 * `opts.vetoOff` is a MEASUREMENT instrument, not a shipped behaviour: it wraps the real guard and
 * drops the verdict for named codes, so "what would this rule cost us?" can be answered without
 * editing src/. It preserves every other member of the guard (the wrapper is a prototype clone), so
 * only the named codes stop firing. */
function buildEngine(ST, opts) {
  const damage = ST.DamageEngine ? new ST.DamageEngine({ gen: 9 }) : null;
  const trickRoom = ST.TrickRoomEngine ? new ST.TrickRoomEngine(damage) : null;
  let veto = ST.BlunderVetoGuard ? new ST.BlunderVetoGuard({ damage: damage, trickRoom: trickRoom }) : null;
  const off = (opts && opts.vetoOff) || null;
  if (veto && off && off.length) {
    const real = veto;
    const drop = new Set(off.map(function (c) { return String(c).toUpperCase(); }));
    veto = Object.create(real);
    veto.evaluateVetoes = function (action, state, tempo) {
      const verdict = real.evaluateVetoes(action, state, tempo);
      if (verdict && verdict.isVetoed && drop.has(String(verdict.code).toUpperCase())) return null;
      return verdict;
    };
  }
  return new ST.LaplaceEngine({
    sampler: ST.WorldSampler ? new ST.WorldSampler({ K: 6 }) : null,
    damage: damage,
    evaluator: ST.DenseStateEvaluator ? new ST.DenseStateEvaluator() : null,
    tempo: ST.TempoEngine ? new ST.TempoEngine({ damage: damage, trickRoom: trickRoom }) : null,
    veto: veto,
    trickRoom: trickRoom
  });
}

/* ------------------------------------------------------------------ config ablate */

/** `true` / `false` / `null` / a number / JSON / otherwise the raw string. */
function parseConfigValue(text) {
  const t = String(text).trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t !== '' && !isNaN(Number(t))) return Number(t);
  if (/^[[{]/.test(t)) { try { return JSON.parse(t); } catch (e) { /* not JSON: a plain string */ } }
  return t;
}

/**
 * buildConfigPatch(ST, sets) -> { patch, applied }
 *
 * `sets` is ['laplace.quiescence.extendSetup=false', ...]. A path that src/config.js does not define
 * is REFUSED (the fallback-sentinel trick, because `configGet` cannot otherwise tell a missing path
 * from an undefined value) — a typo must be a loud error, never a measurement of the shipped build.
 *
 * The patch is built from a CLONE OF THE WHOLE SECTION rather than the dotted path, because
 * `configMerge` merges exactly one level deep per section: handing it `{laplace:{quiescence:{...}}}`
 * would replace `laplace.quiescence` outright and silently drop `enabled` and `blockProtect`.
 */
function buildConfigPatch(ST, sets) {
  const patch = {};
  const applied = [];
  for (let i = 0; i < sets.length; i++) {
    const raw = String(sets[i]);
    const eq = raw.indexOf('=');
    if (eq <= 0) throw new Error('--set expects path=value, got ' + JSON.stringify(raw));
    const dotted = raw.slice(0, eq).trim();
    const value = parseConfigValue(raw.slice(eq + 1));
    const parts = dotted.split('.');
    if (parts.length < 2) throw new Error('--set needs a section path (e.g. laplace.temperature), got ' + dotted);
    const sentinel = {};
    const before = ST.configGet(dotted, sentinel);
    if (before === sentinel) throw new Error('--set ' + dotted + ': src/config.js defines no such tunable');
    const top = parts[0];
    const section = patch[top] || (patch[top] = JSON.parse(JSON.stringify(ST.CONFIG[top])));
    let node = section;
    for (let k = 1; k < parts.length - 1; k++) node = node[parts[k]];
    node[parts[parts.length - 1]] = value;
    applied.push({ path: dotted, from: before, to: value });
  }
  return { patch: patch, applied: applied };
}

/**
 * evaluateBattle(ST, U, replay, sides, opts) -> { records, purity }
 *
 * Replays the log ONCE PER SCORED SIDE, with the parser's mySide set to that side, so the state
 * manager builds the scored player's six from the log's `|poke|`/`|switch|` lines (no pasted team
 * is registered — the honest information state). Every `|turn|N` header is a decision boundary:
 * the state at that moment is the board the player chose on, and the choice for that turn is read
 * out of the turn's own bucket, so nothing the engine sees is from the future.
 */
function evaluateBattle(ST, U, replay, sides, opts) {
  const lines = linesOf(replay.log);
  const parsed = extractChoices(lines);
  const byTurn = {};
  for (let i = 0; i < parsed.turns.length; i++) byTurn[parsed.turns[i].turn] = parsed.turns[i].lines;

  const records = [];
  let purity = null;
  let formatSupported = true;

  for (let s = 0; s < sides.length; s++) {
    const side = sides[s];
    const parser = new ST.ProtocolParser();
    parser.setMySide(side);
    const mgr = new ST.BattleStateManager({ debug: false });
    mgr.attachParser(parser);
    /* THE SECOND MISSING FRAME. `state.mySide` is written ONLY by a `|request|` line
     * (state_manager `_onRequest`), and a replay has none — so the board would be built from p1's
     * point of view no matter which side was being scored, and a "p2" pass would score p2's clicks
     * against p1's team (`_teamFor`, `_setActive`, the evaluator's `state.mySide` all read it).
     * Setting it here is exactly what that side's own request would have done. */
    mgr.state.mySide = side;
    mgr.state.oppSide = side === 'p1' ? 'p2' : 'p1';
    if (opts.format) mgr.setFormat(opts.format);
    const engine = opts.buildEngine(ST, opts);

    for (let i = 0; i < lines.length; i++) {
      const m = /^\|turn\|(\d+)/.exec(lines[i]);
      if (!m) {
        try { parser.feed(lines[i]); } catch (e) { /* an unmodelled line is not a reason to abort */ }
        continue;
      }
      const turn = parseInt(m[1], 10) || 0;
      try { parser.feed(lines[i]); } catch (e) { continue; }
      const state = mgr.state;
      if (!state) continue;
      if (state.formatSupported === false) { formatSupported = false; break; }

      const cls = classifySide(byTurn[turn] || [], side);
      const rec = scoreDecision(engine, state, cls, { U: U, turn: turn, side: side, replay: s });
      records.push(rec);

      /* Purity probe: `evaluateTurn` is documented as not mutating its input, and this whole
       * measurement rests on that, so it is checked on the first ranked decision rather than
       * trusted. Two calls on the same board must produce the same ordered lines. */
      if (purity === null && rec.status === 'scorable') {
        let a = null, b = null;
        try { a = engine.evaluateTurn(state).map(actionKeyOf).join(','); } catch (e) { a = 'threw'; }
        try { b = engine.evaluateTurn(state).map(actionKeyOf).join(','); } catch (e) { b = 'threw'; }
        purity = { turn: turn, side: side, equal: a === b, a: a, b: b };
      }
    }
    if (!formatSupported) break;
  }

  return { records: records, purity: purity, formatSupported: formatSupported, format: parsed.format };
}

/**
 * regretShare(regret, spread) -> [0, 1] | null
 *
 * How much of the spread between the engine's BEST and WORST offered line the human's click gave up.
 * This is the scale-free version of the score gap, and it is the one to quote: the engine's scores
 * are heuristic units (a +-1000 bound with a 260 lethal bonus) that cross zero, so a ratio against
 * the top score alone is ill-conditioned near zero, while a share of the menu's own range is bounded
 * and comparable across turns.
 *
 * Negative regret is 0, not negative: a ranking has to ORDER lines that tie in value, and on a mixed
 * equilibrium the top rows tie by construction, so clicking the engine's row 2 at equal score is not
 * a loss. A menu with no spread cannot be given up on, so `null` is returned and the decision is
 * excluded from the averages rather than counted as perfect.
 */
function regretShare(regret, spread) {
  if (regret === null || spread === null || !isFinite(regret) || !isFinite(spread)) return null;
  if (!(spread > 0)) return regret > 0 ? 1 : 0;
  if (regret <= 0) return 0;
  return regret >= spread ? 1 : regret / spread;
}

/** An HP quintile, so two boards with 64 % and 66 % landed are the same bucket. */
function quintile(pct) {
  if (typeof pct !== 'number' || !isFinite(pct)) return '?';
  return String(Math.max(0, Math.min(4, Math.floor(pct / 20))));
}

/**
 * stateKeyOf(state) -> a coarse bucket key for the consensus pass
 *
 * The active pair, an HP quintile per side, and the field facts that actually change a line (Trick
 * Room, weather, terrain, how many entry hazards are up). COARSE ON PURPOSE: a fine key produces
 * buckets of one, and the question a bucket is for — "what do elites click HERE?" — stops having an
 * answer at any sample size. Everything the engine reads that would make a bucket unique (boosts,
 * PP, the opponent's revealed set) is deliberately absent; that is the trade the bucket makes.
 */
function matchupKeyOf(state) {
  const my = (state && state.active && state.active.my) || null;
  const opp = (state && state.active && state.active.opp) || null;
  const sp = function (m) { return m ? toID(m.species || m.id || m.name || 'unknown') : 'none'; };
  return sp(my) + ' vs ' + sp(opp);
}

function stateKeyOf(state) {
  const my = (state && state.active && state.active.my) || null;
  const opp = (state && state.active && state.active.opp) || null;
  const f = (state && state.field) || {};
  const hazardCount = function (side) {
    const h = (f.hazards && f.hazards[side]) || null;
    return h ? Object.keys(h).length : 0;
  };
  const hazards = Math.min(3, hazardCount('p1') + hazardCount('p2'));
  const sp = function (m) { return m ? toID(m.species || m.id || m.name || 'unknown') : 'none'; };
  return [sp(my), sp(opp), quintile(my && my.hpPercent), quintile(opp && opp.hpPercent),
    (f.trickRoom ? 'tr' : '-'), (f.weather || '-'), (f.terrain || '-'),
    (hazards ? 'h' + hazards : '-')].join('|');
}

/**
 * regretStats(list) -> { n, measured, median, p90, mean, nearTop5, worseThan30, top1, top2 }
 *
 * The score-gap view of one slice of decisions, reported beside the agreement view rather than
 * instead of it. `nearTop5` is the share whose line was within 5 % of the available SPREAD of the
 * engine's pick — the "this disagreement is a wash" band — and `worseThan30` the share that gave up
 * 30 % or more, i.e. the decisions on which the engine is saying the human threw value away. Both
 * are counts over `measured` (the decisions where a share is defined), carried with the slice's own
 * n so a thin slice cannot masquerade as a finding.
 */
function regretStats(list) {
  const shares = [];
  const units = [];
  const ratios = [];
  let top1 = 0, top2 = 0, near = 0, bad = 0, vetoed = 0, blind = 0, nearRatio = 0, badRatio = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i].top1) top1++;
    if (list[i].top2) top2++;
    if (list[i].vetoed) vetoed++;
    if (list[i].blind) blind++;
    /* The raw gap, in the engine's own units, beside the normalised shares: the units are what a
     * reader can check against the evaluator's calibration (the lethal bonus is 260, the bound
     * +-1000), while the share is what is comparable across turns with different menus. */
    if (typeof list[i].regret === 'number' && isFinite(list[i].regret)) units.push(list[i].regret);
    /* The LITERAL "within 5 % of the engine's pick" (regret / |top score|). Only defined when the top
     * line scores away from zero, which is why it is counted separately from `measured`. */
    if (typeof list[i].regretRatio === 'number' && isFinite(list[i].regretRatio)) {
      ratios.push(list[i].regretRatio);
      /* BOTH bands in BOTH framings, because "within 5 % of the pick" and "30 % worse than the pick"
       * are one sentence read at two thresholds: a slice that reports one framing at 5 % and the other
       * at 30 % cannot be compared with itself. */
      if (list[i].regretRatio <= 0.05) nearRatio++;
      if (list[i].regretRatio >= 0.30) badRatio++;
    }
    const sh = list[i].regretShare;
    if (typeof sh === 'number' && isFinite(sh)) {
      shares.push(sh);
      if (sh <= 0.05) near++;
      if (sh >= 0.30) bad++;
    }
  }
  shares.sort(function (a, b) { return a - b; });
  units.sort(function (a, b) { return a - b; });
  const q = function (prob) {
    if (!shares.length) return null;
    const idx = Math.min(shares.length - 1, Math.max(0, Math.round((shares.length - 1) * prob)));
    return shares[idx];
  };
  return {
    n: list.length,
    measured: shares.length,
    median: q(0.5),
    p90: q(0.9),
    mean: shares.length ? shares.reduce(function (a, b) { return a + b; }, 0) / shares.length : null,
    nearTop5: near,
    worseThan30: bad,
    /* The raw units, so the normalised shares can be sanity-checked against the evaluator's own
     * scale (lethal bonus 260), and the literal ratio framing with the count it is defined over. */
    unitsMeasured: units.length,
    medianUnits: units.length ? units[Math.round((units.length - 1) * 0.5)] : null,
    meanUnits: units.length ? units.reduce(function (a, b) { return a + b; }, 0) / units.length : null,
    ratioMeasured: ratios.length,
    nearTop5Ratio: nearRatio,
    worseThan30Ratio: badRatio,
    top1: top1,
    top2: top2,
    vetoed: vetoed,
    blind: blind
  };
}

/**
 * extremeSpread(entries) -> { best, worst, p1, p2, gap, se, z, flat } | null
 *
 * entries: [{ name, k, n }] — one per turn bucket. This is the two-sample test the "are the phases
 * flat?" claim needs, run on the best and worst bucket of the metric and comparing the gap between
 * them to twice the standard error of that difference. `flat: true` means the three phases are NOT
 * distinguishable at this n — it is a statement about the evidence, not a claim that the engine is
 * equally good at every phase, and the per-bucket levels are printed beside it so a flat verdict can
 * be read as "uniformly decent" or "uniformly mediocre" from those levels, which is the distinction
 * a flat top-1 rate on its own cannot make.
 */
function extremeSpread(entries) {
  const use = entries.filter(function (e) { return e && e.n > 0; });
  if (use.length < 2) return null;
  let best = use[0], worst = use[0];
  use.forEach(function (e) {
    if (e.k / e.n > best.k / best.n) best = e;
    if (e.k / e.n < worst.k / worst.n) worst = e;
  });
  const p1 = best.k / best.n, p2 = worst.k / worst.n;
  const gap = p1 - p2;
  const se = Math.sqrt(p1 * (1 - p1) / best.n + p2 * (1 - p2) / worst.n);
  const z = se > 0 ? gap / se : (gap > 0 ? Infinity : 0);
  return {
    best: best.name, bestK: best.k, bestN: best.n,
    worst: worst.name, worstK: worst.k, worstN: worst.n,
    p1: p1, p2: p2, gap: gap, se: se, z: z, flat: !(z >= 2)
  };
}

/* ------------------------------------------------------------------ aggregation */

function tally(list) {
  let n = 0, top1 = 0, top2 = 0, vetoed = 0, blind = 0;
  for (let i = 0; i < list.length; i++) {
    n++;
    if (list[i].top1) top1++;
    if (list[i].top2) top2++;
    if (list[i].vetoed) vetoed++;
    if (list[i].blind) blind++;
  }
  return { n: n, top1: top1, top2: top2, vetoed: vetoed, blind: blind };
}

/** summarize(records, meta) -> the whole report, plain data, JSON-serializable. */
function summarize(records, meta) {
  const scored = records.filter(function (r) { return r.status === 'scorable'; });
  const skipped = {};
  const reasons = ['unobservable', 'ambiguous', 'forcedSwitch', 'cant', 'special', 'unavailable', 'noActive', 'noRanked'];
  reasons.forEach(function (reason) {
    skipped[reason] = records.filter(function (r) { return r.status === reason; }).length;
  });

  /* Which of the twelve hard vetoes refused a line an 1830-rated human chose. A veto that fires on
   * elite play is either the guard being right and the human being wrong, or a rule set to refuse
   * too much — and the code is what lets that be argued rather than guessed. */
  const vetoCodes = {};
  for (let i = 0; i < scored.length; i++) {
    if (!scored[i].vetoed) continue;
    const code = scored[i].vetoCode || 'UNKNOWN';
    vetoCodes[code] = (vetoCodes[code] || 0) + 1;
  }

  const contested = scored.filter(function (r) { return r.contested; });
  const moveContested = scored.filter(function (r) { return r.moveContested; });
  const revealedOnly = scored.filter(function (r) { return !r.blind; });
  const buckets = {};
  const regretByBucket = {};
  ['opening', 'mid', 'endgame'].forEach(function (b) {
    const slice = scored.filter(function (r) { return r.bucket === b; });
    buckets[b] = tally(slice);
    /* The turn-bucket reading of the GAP, which the top-1 rate cannot give: a flat top-1 rate across
     * the three buckets says the engine is uniformly right (or uniformly wrong) and the aggregate
     * cannot tell which, while the regret share says how much value the flat rate is hiding. */
    regretByBucket[b] = regretStats(slice);
  });

  /* CONSENSUS SETS, NOT INDIVIDUAL CLICKS. One human's click is a single draw from a noisy
   * distribution — they were playing a different plan, or bluffing, or simply wrong — so matching
   * that one click is a proxy for the question that matters. A BUCKET of similar states has a
   * distribution, and the question the environment makes meaningful is whether the engine's top pick
   * is among the lines elites actually click HERE. This is the only view in the report that can be
   * right about a decision the particular human got wrong. Buckets below MIN_CONSENSUS_N decisions
   * are kept in the listing (so a thin corpus says so) and excluded from the rate. */
  const byState = {};
  const byPair = {};
  scored.forEach(function (r) {
    if (typeof r.regretShare !== 'number') return;
    const top = r.topKeys && r.topKeys.length ? r.topKeys[0] : null;
    const add = function (bag, key) {
      if (!key) return;
      const b = bag[key] || (bag[key] = { key: key, n: 0, clicks: {}, engineTop: {}, wash: {}, menuFloorSum: 0 });
      b.n++;
      b.clicks[r.key] = (b.clicks[r.key] || 0) + 1;
      /* The floor a RANDOM ENGINE would score here: a uniform draw from that decision's own menu lands
       * on a given line 1/offered of the time, so landing on ANY of three named lines is at most
       * 3/offered — at most, because a line the human never revealed need not be in the engine's
       * starved menu at all. This is the faithful baseline; the other floor below is not. */
      b.menuFloorSum += Math.min(1, 3 / (r.offered > 0 ? r.offered : 1));
      /* The gap follows the click into the bucket, keyed by the line: the question a consensus set
       * makes answerable is not only "is the engine's pick among the popular lines" (agreement) but
       * "does the line elites actually click here score near the engine's pick" (gap). */
      if (r.regretShare <= 0.05) b.wash[r.key] = (b.wash[r.key] || 0) + 1;
      if (top) b.engineTop[top] = (b.engineTop[top] || 0) + 1;
    };
    add(byState, r.stateKey);
    add(byPair, r.pairKey);
  });
  const foldBuckets = function (bag) {
    return Object.keys(bag).map(function (k) {
    const b = bag[k];
    const order = function (obj) {
      return Object.keys(obj).sort(function (x, y) { return obj[y] - obj[x] || (x < y ? -1 : 1); });
    };
    const clickOrder = order(b.clicks);
    const engineOrder = order(b.engineTop);
    const top3 = clickOrder.slice(0, 3);
    const washN = Object.keys(b.wash).reduce(function (a, c) { return a + b.wash[c]; }, 0);
    /* The rate the bucket exists to compute: on how many of its decisions was the ENGINE's top pick
     * one of the three lines elites click most here? A bucket where the engine's first choice is not
     * even in the human top-3 is a place the ranking disagrees with the population, not with a
     * person. */
    const engineTop = engineOrder.length ? engineOrder[0] : null;
    return {
      key: k,
      n: b.n,
      distinctHuman: clickOrder.length,
      humanTop3: top3.map(function (c) { return { key: c, n: b.clicks[c] }; }),
      /* The human consensus line and the share of the bucket that clicked it — the number that says
       * how strong the consensus in this bucket actually is. A bucket whose clicks are spread
       * 2/1/1/1 has no consensus, and a rate over such buckets should be read as chance. */
      humanTop1: clickOrder.length ? clickOrder[0] : null,
      humanTop1Share: clickOrder.length ? b.clicks[clickOrder[0]] / b.n : null,
      engineTopKey: engineTop,
      engineTopKeyCount: engineTop ? b.engineTop[engineTop] : 0,
      engineTop1InTop3: engineTop ? top3.indexOf(engineTop) !== -1 : false,
      engineTop1Count: engineTop ? b.engineTop[engineTop] : 0,
      /* The GAP of the modal human line, and of every click in the bucket. A bucket can agree with
       * the engine on its popular line and still be a bucket where the whole consensus is 40 % worse
       * than the engine's pick — those are different findings and only the second one is about the
       * engine being RIGHT. */
      humanTop1WashShare: clickOrder.length ? ((b.wash[clickOrder[0]] || 0) / b.clicks[clickOrder[0]]) : null,
      menuChanceFloor: b.n ? b.menuFloorSum / b.n : null,
      /* A bucket where elites clicked only three distinct lines has its top-3 equal to EVERY line
       * clicked, so "the engine's pick was in the top-3" is true by construction and says nothing.
       * Those buckets are kept in the listing and excluded from the rate, which is what `informative`
       * marks and what the report counts out loud. */
      informative: clickOrder.length > 3,
      clickWashN: washN,
      clickWashShare: b.n ? washN / b.n : null
    };
    }).sort(function (a, b) { return b.n - a.n || (a.key < b.key ? -1 : 1); });
  };
  const pairBuckets = foldBuckets(byPair);
  const consensusBuckets = foldBuckets(byState);
  const qualify = function (list) {
    const q = list.filter(function (b) { return b.n >= MIN_CONSENSUS_N; });
    return {
      buckets: list.length,
      qualifying: q.length,
      decisionsCovered: q.reduce(function (a, b) { return a + b.n; }, 0),
      /* The two ways to read the same buckets, and they answer different questions: what the ENGINE
       * picks most often in the bucket (its modal line), and whether that modal line is in the human
       * top-3. */
      engineTop1InTop3: q.filter(function (b) { return b.engineTop1InTop3; }).length,
      /* THE RATE WORTH READING, and the two floors it has to be read against. Both are macro averages
       * over the INFORMATIVE buckets (more than three distinct clicks):
       *   - `chanceFloorInformative` is 3/distinctHuman, i.e. a random draw among the lines elites
       *     themselves clicked here. It is a floor on being in THEIR set, not a model of a random
       *     engine, and it is high for exactly the buckets where the humans converged.
       *   - `menuChanceFloorInformative` is the faithful one: a legal but unranked engine drawing
       *     uniformly from its own menu. It is an UPPER bound on that baseline, because only the
       *     top-3 lines that made it into the menu can be hit. */
      informative: q.filter(function (b) { return b.informative; }).length,
      informativeDecisions: q.reduce(function (a, b) { return a + (b.informative ? b.n : 0); }, 0),
      degenerate: q.filter(function (b) { return !b.informative; }).length,
      engineTop1InTop3Informative: q.filter(function (b) { return b.informative && b.engineTop1InTop3; }).length,
      chanceFloor: q.length
        ? q.reduce(function (a, b) { return a + (b.distinctHuman ? 3 / b.distinctHuman : 0); }, 0) / q.length
        : null,
      chanceFloorInformative: (function () {
        const info = q.filter(function (b) { return b.informative; });
        return info.length
          ? info.reduce(function (a, b) { return a + 3 / b.distinctHuman; }, 0) / info.length : null;
      })(),
      menuChanceFloorInformative: (function () {
        const info = q.filter(function (b) { return b.informative; });
        return info.length
          ? info.reduce(function (a, b) { return a + b.menuChanceFloor; }, 0) / info.length : null;
      })(),
      distinctHumanInformative: (function () {
        const info = q.filter(function (b) { return b.informative; });
        return info.length
          ? info.reduce(function (a, b) { return a + b.distinctHuman; }, 0) / info.length : null;
      })(),
      distinctHumanMean: q.length
        ? q.reduce(function (a, b) { return a + b.distinctHuman; }, 0) / q.length : null,
      humanTop1ShareMean: q.length
        ? q.reduce(function (a, b) { return a + (b.humanTop1Share || 0); }, 0) / q.length : null,
      /* Point 1 applied to point 2: among the buckets where elites have a consensus at all, was that
       * consensus line NEAR the engine's pick (within 5 % of the menu's spread)? Macro-averaged over
       * buckets, plus the pooled share over every click in them, because the two differ when the
       * thick buckets behave differently from the thin ones. */
      humanTop1WashShareMean: q.length
        ? q.reduce(function (a, b) { return a + (b.humanTop1WashShare || 0); }, 0) / q.length : null,
      pooledClickWashShare: (function () {
        const tot = q.reduce(function (a, b) { return a + b.n; }, 0);
        return tot ? q.reduce(function (a, b) { return a + b.clickWashN; }, 0) / tot : null;
      })(),
      top: q.slice(0, 8)
    };
  };
  const consensus = Object.assign({ minN: MIN_CONSENSUS_N }, qualify(pairBuckets), {
    /* The FINE partition, reported beside it as the diagnostic that says the coarse one was
     * necessary: `qualifyingFine` is how many pair+HP+field buckets reach MIN_CONSENSUS_N here. */
    fineBuckets: consensusBuckets.length,
    qualifyingFine: consensusBuckets.filter(function (b) { return b.n >= MIN_CONSENSUS_N; }).length,
    fineTop: consensusBuckets.slice(0, 4)
  });

  /* The pivot diagnostic. `getMyActions` can only offer the moves a body has revealed, so an
   * un-revealed attacker's menu is mostly SWITCHES — and a switch is what a pivot-happy engine
   * recommends. When the engine's top-1 is a switch far more often than the human's click was, that
   * is the starved menu showing through, not a read on the engine's aggression. */
  const mix = { n: contested.length, humanSwitch: 0, engineSwitch: 0 };
  for (let i = 0; i < contested.length; i++) {
    if (contested[i].action && contested[i].action.kind === 'switch') mix.humanSwitch++;
    if (contested[i].top1Kind === 'switch') mix.engineSwitch++;
  }

  const offered = scored.map(function (r) { return r.offered || 0; });

  /* THE FLOOR. Every scored decision's action was in the engine's own menu (that is enforced
   * above), so a policy that picked uniformly at random from that menu would agree with the human
   * 1/offered of the time. Without this number a top-1 rate in the twenties cannot be read: it is
   * the difference between "the engine is ranking" and "the engine is guessing". */
  function uniformFloor(list) {
    if (!list.length) return null;
    let sum = 0;
    for (let i = 0; i < list.length; i++) sum += list[i].offered ? 1 / list[i].offered : 0;
    return sum / list.length;
  }

  /* The two halves of this measurement are not equally hard, and not equally measured: the switch
   * menu is COMPLETE (every legal bench body) and the attack menu is STARVED (only the moves the
   * log had revealed). Split them, because the combined number hides which one is which — and when
   * the split was first measured it inverted the expectation: the fair half was the weak one. */
  const isMove = function (r) { return r.action && r.action.kind === 'move'; };
  const isSwitch = function (r) { return r.action && r.action.kind === 'switch'; };
  const byKind = {
    move: tally(scored.filter(isMove)),
    switch: tally(scored.filter(isSwitch))
  };

  /* THE PIVOT CEILING, and the reason it is reported rather than left in prose. `bestMoveKey` is
   * the engine's own best NON-pivot line, recorded from the ranking BEFORE any policy term touches
   * it. On the turns where its top-1 was a SWITCH while the human clicked a MOVE, this counts how
   * often that best non-pivot line WAS the human's click — i.e. how often the right answer was
   * already sitting one row down — and it prices the ceiling: a policy that never pivoted while it
   * held an attack would score `neverPivot` on those turns. That bounds EVERY switch-penalising
   * change before one is written, which is what makes it a metric to track. */
  const moveClicks = scored.filter(isMove);
  const pivotCeiling = {
    moveN: moveClicks.length,
    pivotedN: moveClicks.filter(function (r) { return r.top1Kind === 'switch'; }).length,
    agree: moveClicks.filter(function (r) {
      return r.top1Kind === 'switch' && r.bestMoveKey !== null && r.bestMoveKey === r.key;
    }).length,
    neverPivot: moveClicks.filter(function (r) { return r.bestMoveKey === r.key; }).length,
    allN: scored.length,
    neverPivotAll: scored.filter(function (r) { return r.bestMoveKey === r.key; }).length
  };

  const meta2 = meta || {};
  return {
    corpus: meta2.corpus || null,
    battles: meta2.battles || 0,
    battlesSkippedUnsupported: meta2.battlesSkippedUnsupported || 0,
    battlesErrored: meta2.battlesErrored || 0,
    sides: meta2.sides || null,
    minRating: meta2.minRating === undefined ? null : meta2.minRating,
    ratingBand: meta2.ratingBand || null,
    configPatches: meta2.configPatches || null,
    vetoOff: meta2.vetoOff || null,
    all: tally(scored),
    contested: tally(contested),
    moveContested: tally(moveContested),
    revealedOnly: tally(revealedOnly),
    buckets: buckets,
    regret: {
      all: regretStats(scored),
      contested: regretStats(contested),
      moveContested: regretStats(moveContested),
      revealedOnly: regretStats(revealedOnly),
      byKind: { move: regretStats(scored.filter(isMove)), switch: regretStats(scored.filter(isSwitch)) },
      byBucket: regretByBucket
    },
    consensus: consensus,
    /* POINT 4. The turn buckets, with the two-sample test on the best-vs-worst pair attached, so
     * "flat" is a finding the report can state instead of a shape the reader has to eyeball. */
    flatness: {
      minBucketN: Math.min(buckets.opening.n, buckets.mid.n, buckets.endgame.n),
      agreement: extremeSpread(['opening', 'mid', 'endgame'].map(function (b) {
        return { name: b, k: buckets[b].top1, n: buckets[b].n };
      })),
      wash: extremeSpread(['opening', 'mid', 'endgame'].map(function (b) {
        return { name: b, k: regretByBucket[b].nearTop5, n: regretByBucket[b].measured };
      })),
      levels: ['opening', 'mid', 'endgame'].map(function (b) {
        return {
          name: b, n: buckets[b].n, top1: buckets[b].top1,
          measured: regretByBucket[b].measured, wash: regretByBucket[b].nearTop5,
          median: regretByBucket[b].median, mean: regretByBucket[b].mean,
          units: regretByBucket[b].medianUnits
        };
      })
    },
    mix: mix,
    vetoCodes: vetoCodes,
    byKind: byKind,
    pivotCeiling: pivotCeiling,
    chanceFloor: {
      all: uniformFloor(scored),
      contested: uniformFloor(contested),
      move: uniformFloor(scored.filter(isMove)),
      switch: uniformFloor(scored.filter(isSwitch))
    },
    skipped: skipped,
    unscoreableBattles: meta2.unscoreableBattles || 0,
    meanOffered: offered.length ? offered.reduce(function (a, b) { return a + b; }, 0) / offered.length : 0,
    purity: meta2.purity || null,
    elapsedMs: meta2.elapsedMs || 0
  };
}

/* --------------------------------------------------------------------- output */

function pct(k, n) {
  const r = rate(k, n);
  return r === null ? '  n/a ' : (100 * r).toFixed(1) + '%';
}

function ciText(k, n) {
  const w = wilson(k, n);
  return '±' + (100 * Math.max(w.hi - (n ? k / n : 0), (n ? k / n : 0) - w.lo)).toFixed(1);
}

function pcText(x) { return x === null || x === undefined ? 'n/a' : (100 * x).toFixed(1) + '%'; }
function padEnd(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function padStart(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }

function render(summary, opts) {
  const L = [];
  const band = summary.ratingBand;
  L.push('');
  L.push('================================================================================');
  L.push('  HUMAN-MOVE-MATCH  (policy fidelity vs elite human play)');
  L.push('================================================================================');
  L.push('  corpus        : ' + (summary.corpus || '(none)'));
  L.push('  battles       : ' + summary.battles +
    (summary.battlesSkippedUnsupported ? '  (' + summary.battlesSkippedUnsupported + ' skipped: unsupported format)' : '') +
    (summary.battlesErrored ? '  (' + summary.battlesErrored + ' failed to replay)' : ''));
  L.push('  sides scored  : ' + (summary.sides || []).join(', '));
  if (band) L.push('  rating band   : ' + band.min + '-' + band.max + '  (mean ' + band.mean + ')');
  L.push('  decisions     : ' + summary.all.n + ' scored');
  /* A run that patched the config or dropped a veto is NOT the shipped engine, and the report has
   * to say so at the top: a number from an ablated build that reads like the shipped one is the
   * exact failure this whole line of work exists to prevent. */
  const patched = (summary.configPatches && summary.configPatches.length) || (summary.vetoOff && summary.vetoOff.length);
  if (patched) {
    L.push('  *** NOT THE SHIPPED BUILD ***');
    (summary.configPatches || []).forEach(function (p) {
      L.push('      --set ' + p.path + ': ' + JSON.stringify(p.from) + ' -> ' + JSON.stringify(p.to));
    });
    if (summary.vetoOff && summary.vetoOff.length) {
      L.push('      vetoes suppressed: ' + summary.vetoOff.join(', '));
    }
  }
  const sk = summary.skipped;
  L.push('  skipped       : ' + Object.keys(sk).filter(function (k) { return sk[k]; })
    .map(function (k) { return k + ' ' + sk[k]; }).join(', ') || '  (none)');
  L.push('');

  /* THE HEADLINE IS THE GAP, NOT THE AGREEMENT, and the order it is printed in is the claim.
   * Agreement counts a tie-broken row as a miss, so an agreement rate in the twenties is not by
   * itself a reading of anything; the gap says what each disagreement COST. Both are printed — the
   * agreement table stays because it is comparable with every earlier run. */
  const hg = summary.regret.all;
  if (hg && hg.measured) {
    L.push('  HEADLINE — the gap, not the agreement: a spread existed on ' + hg.measured + ' of ' +
      summary.all.n + ' decisions, and the');
    L.push('  human\'s own click scored within 5 % of the engine\'s pick on ' +
      pct(hg.nearTop5, hg.measured).trim() + ' of those (' + hg.nearTop5 + '/' + hg.measured +
      ': on those turns the disagreement is a');
    L.push('  wash). It gave up 30 % or more of the menu\'s spread on ' +
      pct(hg.worseThan30, hg.measured).trim() + ' (' + hg.worseThan30 + '/' + hg.measured +
      ': there the engine is saying the human');
    L.push('  threw value away). Top-1 agreement on the same decisions is ' +
      pct(summary.all.top1, summary.all.n).trim() + ', counted beside it, not instead of it.');
    L.push('');
  }

  const head = '  ' + padEnd('metric', 30) + padStart('decisions', 10) + padStart('rate', 9) + padStart('95% CI', 8);
  L.push(head);
  L.push('  ' + '-'.repeat(57));
  const rows = [
    ['top-1 agreement  (all)', summary.all.top1, summary.all.n],
    ['top-2 agreement  (all)', summary.all.top2, summary.all.n],
    ['top-1  contested subset', summary.contested.top1, summary.contested.n],
    ['top-2  contested subset', summary.contested.top2, summary.contested.n],
    ['top-1  move-vs-move', summary.moveContested.top1, summary.moveContested.n],
    ['top-1  revealed moveset', summary.revealedOnly.top1, summary.revealedOnly.n],
    ['top-2  revealed moveset', summary.revealedOnly.top2, summary.revealedOnly.n],
    ['chosen line was VETOED', summary.all.vetoed, summary.all.n]
  ];
  rows.forEach(function (r) {
    L.push('  ' + padEnd(r[0], 30) + padStart(r[2], 10) + padStart(pct(r[1], r[2]), 9) + padStart(ciText(r[1], r[2]), 8));
  });
  L.push('');
  L.push('  by turn bucket                  decisions     top-1     top-2  wash<=5%   median');
  L.push('  ' + '-'.repeat(75));
  [['opening  (1-' + OPENING_MAX_TURN + ')', 'opening'],
    ['mid  (' + (OPENING_MAX_TURN + 1) + '-' + MID_MAX_TURN + ')', 'mid'],
    ['endgame  (' + (MID_MAX_TURN + 1) + '+)', 'endgame']].forEach(function (b) {
    const t = summary.buckets[b[1]];
    const g = summary.regret.byBucket[b[1]];
    L.push('  ' + padEnd(b[0], 30) + padStart(t.n, 10) + padStart(pct(t.top1, t.n), 10) +
      padStart(pct(t.top2, t.n), 10) + padStart(pct(g.nearTop5, g.measured), 11) +
      padStart(g.median === null ? 'n/a' : g.median.toFixed(2), 9));
  });
  const fl = summary.flatness;
  if (fl && fl.agreement && fl.wash) {
    const say = function (x, what) {
      return what + ' best-vs-worst ' + x.best + '->' + x.worst + ' ' +
        (100 * x.p1).toFixed(1) + '% vs ' + (100 * x.p2).toFixed(1) + '% (z ' +
        (isFinite(x.z) ? x.z.toFixed(1) : 'inf') + ') -> ' + (x.flat ? 'FLAT at this n' : 'NOT flat');
    };
    L.push('');
    L.push('  IS THE AGGREGATE HIDING A PHASE? ' + say(fl.agreement, 'agreement:'));
    L.push('  ' + say(fl.wash, 'the gap:   '));
    /* The verdict is deliberately two-sided: FLAT is the evidence failing to separate the phases,
     * which is not the same as the phases being equal — the levels in the table above are what
     * distinguishes "uniformly decent" from "uniformly mediocre". */
    L.push('  "FLAT" means the three buckets are not distinguishable at this n, NOT that they were');
    L.push('  shown to match: read it together with the levels above (thinnest bucket n=' + fl.minBucketN + ').');
  }
  L.push('');
  L.push('  action space: ' + summary.meanOffered.toFixed(2) + ' lines offered on average; ' +
    summary.all.blind + ' of ' + summary.all.n + ' clicks (' + pct(summary.all.blind, summary.all.n).trim() +
    ') were moves the log had not revealed yet');
  const vc = Object.keys(summary.vetoCodes).sort(function (a, b) { return summary.vetoCodes[b] - summary.vetoCodes[a]; });
  if (vc.length) L.push('  veto codes  : ' + vc.map(function (k) { return k + ' ' + summary.vetoCodes[k]; }).join(', '));
  L.push('  action mix  : on the contested turns the human SWITCHED ' +
    pct(summary.mix.humanSwitch, summary.mix.n).trim() + ' of the time and the engine\'s top-1 was a switch ' +
    pct(summary.mix.engineSwitch, summary.mix.n).trim() + ' of the time');
  const pc = summary.pivotCeiling;
  if (pc && pc.moveN) {
    L.push('  pivot ceiling: of ' + pc.moveN + ' move-clicks its top-1 was a SWITCH ' + pc.pivotedN +
      ' times (' + pct(pc.pivotedN, pc.moveN).trim() + '), and on those its best NON-pivot line WAS the');
    L.push('                human\'s click ' + pct(pc.agree, pc.pivotedN).trim() + ' of the time. Never pivoting while holding an' +
      ' attack -> top-1 ' + pct(pc.neverPivot, pc.moveN).trim() + ' there and ' +
      pct(pc.neverPivotAll, pc.allN).trim() + ' overall.');
  }
  L.push('');  const main = rate(summary.contested.top1, summary.contested.n);
  const floor = summary.chanceFloor.contested;
  const b = eloBand(main);
  L.push('  vs chance     : top-1 on the contested subset ' + pct(summary.contested.top1, summary.contested.n).trim() +
    ' vs a uniform-pick floor of ' + (floor === null ? 'n/a' : (100 * floor).toFixed(1) + '%') +
    (floor && main !== null ? '  ->  ' + (main / floor).toFixed(2) + 'x chance' : ''));
  L.push('  band table    : ' + b.label + '   [' + b.note + ']  -- UNCALIBRATED heuristic mapping, not a measured rating.');
  L.push('');
  L.push('  by action kind             decisions     top-1     top-2    floor');
  L.push('  ' + '-'.repeat(57));
  [['move    (menu is starved)', 'move'], ['switch  (menu is complete)', 'switch']].forEach(function (k) {
    const t = summary.byKind[k[1]];
    const fl = summary.chanceFloor[k[1]];
    L.push('  ' + padEnd(k[0], 28) + padStart(t.n, 9) + padStart(pct(t.top1, t.n), 10) +
      padStart(pct(t.top2, t.n), 10) + padStart(fl === null ? 'n/a' : (100 * fl).toFixed(1) + '%', 9));
  });
  L.push('');
  L.push('  THE TWO HALVES ARE NOT MEASURED EQUALLY, and this is where they part. The SWITCH menu is');
  L.push('  complete — every legal bench body — so the switch half is a FAIR reading of this engine. The');
  L.push('  ATTACK menu can only hold the moves the log had already revealed (' + summary.all.blind + ' of ' +
    summary.all.n + ' clicks');
  L.push('  were not yet revealed), so the MOVE half is a LOWER BOUND: the engine was choosing between');
  L.push('  fewer attacks than the human could see. That is also why its top-1 is a switch far more often');
  L.push('  than the human\'s click was. Do not average the two halves into one number and call it a');
  L.push('  rating — the fair half is the weaker one, and the unfair half is the stronger one.');
  /* ---- the score gap, which is what the top-1 rate cannot say ------------------------------- */
  const rg = summary.regret;
  if (rg) {
    L.push('');
    L.push('  WHAT THE HUMAN GAVE UP, in the engine\'s own scores');
    L.push('    regret = (engine top pick score) - (the human\'s line score). spread = the range the');
    L.push('    engine put on this turn\'s menu. The rate is over the decisions where a spread existed.');
    L.push('  ' + padEnd('slice', 26) + padStart('decisions', 10) + padStart('median', 8) + padStart('p90', 7) +
      padStart('within 5%', 11) + padStart('worse 30%+', 12) + padStart('mean', 8) +
      padStart('medUnits', 10) + padStart('meanUnits', 10) + padStart('within 5%', 11) + padStart('worse 30%+', 12));
    L.push('  ' + padEnd('', 26) + padStart('(of spread)', 10) + padStart('', 15) + padStart('', 23) +
      padStart('(of spread)', 10) + padStart('', 10) + padStart('(of pick)', 11) + padStart('(of pick)', 12));
    L.push('  ' + '-'.repeat(125));
    const fmt = function (v) { return v === null || v === undefined ? 'n/a' : v.toFixed(3); };
    [['all scored', rg.all], ['contested', rg.contested], ['move-vs-move', rg.moveContested],
      ['revealed moveset', rg.revealedOnly], ['move clicks', rg.byKind.move],
      ['switch clicks', rg.byKind.switch]].forEach(function (r) {
        const t = r[1];
        L.push('  ' + padEnd(r[0], 26) + padStart(t.measured, 10) + padStart(fmt(t.median), 8) +
          padStart(fmt(t.p90), 7) + padStart(pct(t.nearTop5, t.measured), 11) +
          padStart(pct(t.worseThan30, t.measured), 12) + padStart(fmt(t.mean), 8) +
          padStart(t.medianUnits === null ? 'n/a' : t.medianUnits.toFixed(1), 10) +
          padStart(t.meanUnits === null ? 'n/a' : t.meanUnits.toFixed(1), 10) +
          padStart(pct(t.nearTop5Ratio, t.ratioMeasured), 11) +
        padStart(pct(t.worseThan30Ratio, t.ratioMeasured), 12));
      });
    [['opening  (1-' + OPENING_MAX_TURN + ')', 'opening'], ['mid  (' + (OPENING_MAX_TURN + 1) + '-' + MID_MAX_TURN + ')', 'mid'],
      ['endgame  (' + (MID_MAX_TURN + 1) + '+)', 'endgame']].forEach(function (b) {
      const t = rg.byBucket[b[1]];
      L.push('  ' + padEnd('  ' + b[0], 26) + padStart(t.measured, 10) + padStart(fmt(t.median), 8) +
        padStart(fmt(t.p90), 7) + padStart(pct(t.nearTop5, t.measured), 11) +
        padStart(pct(t.worseThan30, t.measured), 12) + padStart(fmt(t.mean), 8) +
        padStart(t.medianUnits === null ? 'n/a' : t.medianUnits.toFixed(1), 10) +
        padStart(t.meanUnits === null ? 'n/a' : t.meanUnits.toFixed(1), 10) +
        padStart(pct(t.nearTop5Ratio, t.ratioMeasured), 11) +
        padStart(pct(t.worseThan30Ratio, t.ratioMeasured), 12));
    });
    L.push('');
    L.push('  A share of 0 means the human\'s line was worth what the engine\'s pick was worth (a tie');
    L.push('  the ranking still had to order); 0.05 is "a wash", 0.30+ is the engine saying the human');
    L.push('  threw value away. Read it beside the top-1 rate: agreement counts a tie-broken row as a');
    L.push('  miss, and this column says how much that miss was worth.');
    L.push('  The TWO "within 5%" columns normalise differently and are NOT interchangeable: the first');
    L.push('  is 5 % of the menu\'s own spread (bounded, comparable across turns, the headline), the');
    L.push('  second is the literal 5 % of the top line\'s SCORE, which is undefined when that score is');
    L.push('  near zero — the evaluator\'s units cross zero — so it is counted over fewer decisions. The');
    L.push('  30 % columns are the same pair read at the other threshold, so each framing reports both.');
  }
  const cs = summary.consensus;
  if (cs && cs.buckets) {
    L.push('');
    L.push('  CONSENSUS SETS (one bucket per ACTIVE PAIR; >= ' + cs.minN + ' decisions per bucket)');
    L.push('    ' + cs.qualifying + ' of ' + cs.buckets + ' buckets qualify, covering ' + cs.decisionsCovered +
      ' of ' + summary.all.n + ' scored decisions.');
    L.push('    ' + cs.degenerate + ' of those buckets are DEGENERATE for the top-3 test below: elites');
    L.push('    clicked three distinct lines or fewer there, so the human top-3 is every line clicked and');
    L.push('    the test is true by construction. The ' + cs.informative + ' informative buckets (' +
      cs.informativeDecisions + ' decisions, ' +
      (cs.distinctHumanInformative === null ? 'n/a' : cs.distinctHumanInformative.toFixed(1)) + ' distinct lines on average) are the ones it can');
    L.push('    say anything about:');
    L.push('      engine top pick in the human top-3   ' +
      pct(cs.engineTop1InTop3Informative, cs.informative).trim() + '   (' + cs.engineTop1InTop3Informative + '/' + cs.informative + ')');
    L.push('      ...a random line from the engine\'s own menu, at MOST   ' +
      pcText(cs.menuChanceFloorInformative) + '   (the bound is loose: only top-3 lines');
    L.push('                                                             already in a starved menu can be hit)');
    L.push('      ...a random draw among the lines ELITES clicked   ' +
      pcText(cs.chanceFloorInformative) + '   (by construction, 3 of their distinct count)');
    L.push('    over ALL qualifying buckets, degenerate included, the rate is ' +
      pct(cs.engineTop1InTop3, cs.qualifying).trim() + ' against ' + pcText(cs.chanceFloor) + ' — which is why that number is not');
    L.push('    the one quoted.');
    L.push('    in those buckets the single most-clicked line holds ' +
      pct(cs.humanTop1ShareMean === null ? 0 : cs.humanTop1ShareMean, 1).trim() +
      ' of the clicks on average, over ' + (cs.distinctHumanMean === null ? 'n/a' : cs.distinctHumanMean.toFixed(1)) +
      ' distinct lines');
    /* The consensus set read through the GAP rather than through agreement: a bucket where the
     * engine's pick was in the human top-3 is a bucket the engine ranks plausibly, and this asks
     * whether the line the humans converged on was also a line the engine rates. */
    L.push('    scored by the gap instead: the line elites clicked MOST in a bucket was within 5 % of');
    L.push('    the engine\'s pick ' + pcText(cs.humanTop1WashShareMean) + ' of the time on average, and pooling every');
    L.push('    click in the qualifying buckets ' + pcText(cs.pooledClickWashShare) + ' of them were within 5 %.');
    L.push('    the FINE partition (pair + HP quintile + field) needs far more corpus: ' + cs.qualifyingFine +
      ' of its ' + cs.fineBuckets + ' buckets reach ' + cs.minN + ' decisions here.');
    cs.top.slice(0, 4).forEach(function (b) {
      L.push('      n=' + padStart(b.n, 3) + '  ' + b.key);
      L.push('            humans clicked : ' + b.humanTop3.map(function (c) { return c.key + ' x' + c.n; }).join(', ') +
        (b.distinctHuman > 3 ? '  (' + b.distinctHuman + ' distinct)' : ''));
      L.push('            engine top pick: ' + (b.engineTopKey || 'n/a') +
        (b.engineTop1InTop3 ? '  <- IN the human top-3' : '  <- NOT in the human top-3'));
    });
  }
  L.push('');
  if (summary.purity) {
    L.push('  purity probe  : evaluateTurn twice on turn ' + summary.purity.turn + ' / ' + summary.purity.side +
      ' -> ' + (summary.purity.equal ? 'identical (input not mutated)' : 'DIFFERENT — the measurement is unsound'));
    L.push('');
  }
  L.push('  elapsed       : ' + (summary.elapsedMs / 1000).toFixed(1) + 's');
  L.push('');
  return L.join('\n');
}

/* ----------------------------------------------------------------------- corpus */

/** Where the corpus usually lives; `--input` always wins. */
function probeCorpus() {
  const candidates = [];
  if (process.env.ST_CORPUS) candidates.push(process.env.ST_CORPUS);
  candidates.push(path.join(os.tmpdir(), 'st-corpus', 'elite.json'));
  candidates.push(path.join(os.tmpdir(), 'st-corpus', 'replays.json'));
  candidates.push(path.join(ROOT, 'replays.json'));
  candidates.push(path.join(ROOT, 'corpus', 'elite.json'));
  candidates.push(path.join(ROOT, 'corpus', 'replays.json'));
  for (let i = 0; i < candidates.length; i++) {
    try { if (fs.statSync(candidates[i]).isFile()) return { path: candidates[i], probed: candidates }; } catch (e) { /* keep probing */ }
  }
  return { path: null, probed: candidates };
}

/**
 * strideSample(list, n) -> n items spread evenly across the whole list.
 *
 * A corpus file is in FETCH order, not random order, so scoring the first N replays scores whatever
 * window happened to be downloaded first (one afternoon's ladder, possibly one player's games). A
 * fixed stride across the file is still deterministic — the run is reproducible — while spreading
 * the sample over the whole corpus.
 */
function strideSample(list, n) {
  if (n >= list.length) return list.slice();
  const out = [];
  const step = list.length / n;
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

function loadCorpus(input) {
  const found = input ? { path: path.resolve(ROOT, input), probed: [String(input)] } : probeCorpus();
  if (!found.path || !fs.existsSync(found.path)) {
    throw new Error('no corpus at ' + (found.path || '(nothing found)') +
      '\n    pass --input <replays.json>. Probed:\n    ' + found.probed.join('\n    '));
  }
  const raw = JSON.parse(fs.readFileSync(found.path, 'utf8'));
  const replays = replaysOf(raw);
  return {
    path: found.path,
    format: (raw && !Array.isArray(raw) && raw.format) || null,
    declared: (raw && !Array.isArray(raw) && raw.minRating) || null,
    replays: replays
  };
}

/* -------------------------------------------------------------------------- main */

function parseArgs(argv) {
  const out = {
    input: null, battles: 100, minRating: null, side: 'both', format: null,
    json: false, out: null, quiet: false, help: false, assert: false,
    set: null, vetoOff: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = function () {
      const v = argv[++i];
      if (v === undefined) throw new Error(a + ' needs a value');
      return v;
    };
    if (a === '--input' || a === '-i') out.input = need();
    else if (a === '--battles' || a === '-n') out.battles = parseInt(need(), 10) || 0;
    else if (a === '--min-rating') out.minRating = parseFloat(need());
    else if (a === '--side') out.side = String(need()).toLowerCase();
    else if (a === '--format') out.format = need();
    else if (a === '--set') (out.set = out.set || []).push(need());
    else if (a === '--veto-off') (out.vetoOff = out.vetoOff || []).push(need());
    else if (a === '--out' || a === '-o') out.out = need();
    else if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--assert') out.assert = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  if (['both', 'p1', 'p2'].indexOf(out.side) === -1) throw new Error('--side must be both, p1 or p2');
  return out;
}

function run(opts) {
  const started = Date.now();
  const api = loadApi(opts.set);
  const ST = api.ST;
  const U = ST.util;
  const corpus = loadCorpus(opts.input);
  const format = opts.format || corpus.format || '[Gen 9] National Dex OU';

  const pool = corpus.replays.filter(function (r) {
    return !opts.minRating || (typeof r.rating === 'number' && r.rating >= opts.minRating);
  });
  const chosen = opts.battles > 0 ? strideSample(pool, opts.battles) : pool;
  const sides = opts.side === 'both' ? ['p1', 'p2'] : [opts.side];

  const records = [];
  let skippedUnsupported = 0, errored = 0, purity = null;
  const ratings = [];
  for (let i = 0; i < chosen.length; i++) {
    let out = null;
    try {
      out = evaluateBattle(ST, U, chosen[i], sides, {
        format: format, buildEngine: buildEngine, vetoOff: opts.vetoOff
      });
    } catch (e) {
      /* One malformed replay in a 3,000-battle corpus must not lose the other 2,999. It is counted
       * and named, never silently dropped. */
      errored++;
      if (!opts.quiet && !opts.json) process.stderr.write('  ! battle ' + i + ' failed: ' + ((e && e.message) || e) + '\n');
      continue;
    }
    if (!out.formatSupported) { skippedUnsupported++; continue; }
    for (let r = 0; r < out.records.length; r++) records.push(out.records[r]);
    if (purity === null && out.purity) purity = out.purity;
    if (typeof chosen[i].rating === 'number') ratings.push(chosen[i].rating);
    if (!opts.quiet && !opts.json && (i + 1) % 10 === 0) {
      process.stderr.write('  ... ' + (i + 1) + '/' + chosen.length + ' battles, ' + records.length + ' decisions\r');
    }
  }
  if (!opts.quiet && !opts.json) process.stderr.write(' '.repeat(60) + '\r');

  const band = ratings.length ? {
    min: Math.min.apply(null, ratings), max: Math.max.apply(null, ratings),
    mean: Math.round(ratings.reduce(function (a, b) { return a + b; }, 0) / ratings.length)
  } : null;

  const summary = summarize(records, {
    corpus: path.relative(ROOT, corpus.path) || corpus.path,
    battles: chosen.length - skippedUnsupported,
    battlesSkippedUnsupported: skippedUnsupported,
    battlesErrored: errored,
    sides: sides,
    minRating: opts.minRating,
    ratingBand: band,
    purity: purity,
    configPatches: api.applied,
    vetoOff: opts.vetoOff,
    elapsedMs: Date.now() - started
  });
  return { summary: summary, records: records };
}

function main(argv) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    console.log([
      'usage: node tools/benchmark_human_match.js [options]',
      '',
      '  -i, --input <file>     replay corpus ({replays:[{rating,winner,log}]} or an array)',
      '                         default: $ST_CORPUS, then %TEMP%/st-corpus/elite.json, then replays.json',
      '  -n, --battles <N>      battles to score (0 = every battle in the corpus; default 100)',
      '      --min-rating <R>   only replays rated >= R',
      '      --side <s>         p1, p2 or both (default both)',
      '      --format <name>    override the corpus format (default: the corpus metadata)',
      '      --set <path>=<v>   patch a src/config.js tunable before the modules load (repeatable).',
      '                         A path config.js does not define is refused. e.g.',
      '                         --set laplace.quiescence.extendSetup=false',
      '      --veto-off <CODE>  suppress one veto code (VETO4 / SPEED_SUICIDE), to measure what the',
      '                         rule costs. Both options make the run NOT the shipped build, and the',
      '                         report says so.',
      '  -o, --out <file>       write every per-decision record as JSON',
      '      --json             print the summary as JSON instead of the table',
      '      --assert           exit non-zero if the purity probe fails',
      '      --quiet            no progress output (the report still prints)',
      '',
      'The corpus is replayed once per scored side at ~2.5s/battle, so 100 battles is ~4 minutes.'
    ].join('\n'));
    return 0;
  }
  const out = run(opts);
  if (opts.out) {
    const target = path.resolve(ROOT, opts.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ summary: out.summary, records: out.records }, null, 1) + '\n');
    if (!opts.json) console.log('wrote ' + path.relative(ROOT, target) + ' (' + out.records.length + ' records)');
  }
  /* `--quiet` silences the progress chatter, never the report: the table IS the tool's output. */
  if (opts.json) console.log(JSON.stringify(out.summary, null, 2));
  else console.log(render(out.summary, opts));

  if (opts.assert) {
    if (!out.summary.purity || !out.summary.purity.equal) {
      console.error('benchmark_human_match: purity probe FAILED — evaluateTurn changed its result on an unchanged board.');
      return 1;
    }
    if (!out.summary.all.n) {
      console.error('benchmark_human_match: no decisions were evaluated.');
      return 1;
    }
  }
  return 0;
}

module.exports = {
  OPENING_MAX_TURN: OPENING_MAX_TURN,
  MID_MAX_TURN: MID_MAX_TURN,
  ELO_BANDS: ELO_BANDS,
  linesOf: linesOf,
  replaysOf: replaysOf,
  speciesOf: speciesOf,
  sideOfIdent: sideOfIdent,
  classifySide: classifySide,
  extractChoices: extractChoices,
  actionKey: actionKey,
  actionKeyOf: actionKeyOf,
  bucketOf: bucketOf,
  scoreDecision: scoreDecision,
  tally: tally,
  regretShare: regretShare,
  extremeSpread: extremeSpread,
  matchupKeyOf: matchupKeyOf,
  regretStats: regretStats,
  stateKeyOf: stateKeyOf,
  MIN_CONSENSUS_N: MIN_CONSENSUS_N,
  summarize: summarize,
  wilson: wilson,
  rate: rate,
  eloBand: eloBand,
  render: render,
  probeCorpus: probeCorpus,
  strideSample: strideSample,
  loadCorpus: loadCorpus,
  loadApi: loadApi,
  buildConfigPatch: buildConfigPatch,
  parseConfigValue: parseConfigValue,
  buildEngine: buildEngine,
  evaluateBattle: evaluateBattle,
  parseArgs: parseArgs,
  run: run,
  main: main
};

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error('benchmark_human_match: ' + ((err && err.message) || err));
    process.exit(1);
  }
}
