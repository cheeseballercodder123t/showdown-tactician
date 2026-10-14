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
  ['opening', 'mid', 'endgame'].forEach(function (b) {
    buckets[b] = tally(scored.filter(function (r) { return r.bucket === b; }));
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
  L.push('  by turn bucket                  decisions     top-1     top-2');
  L.push('  ' + '-'.repeat(57));
  [['opening  (1-' + OPENING_MAX_TURN + ')', 'opening'],
    ['mid  (' + (OPENING_MAX_TURN + 1) + '-' + MID_MAX_TURN + ')', 'mid'],
    ['endgame  (' + (MID_MAX_TURN + 1) + '+)', 'endgame']].forEach(function (b) {
    const t = summary.buckets[b[1]];
    L.push('  ' + padEnd(b[0], 30) + padStart(t.n, 10) + padStart(pct(t.top1, t.n), 10) + padStart(pct(t.top2, t.n), 10));
  });
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
