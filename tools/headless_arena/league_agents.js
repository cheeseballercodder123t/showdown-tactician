/* Showdown Tactician — tools/headless_arena/league_agents.js
 *
 * WHY THIS EXISTS
 *   Self-play is an echo chamber: an engine that only ever faces itself converges on beating its
 *   own habits. The arena therefore pits it against three deliberately different opponents, and
 *   the differences are the point:
 *
 *     StandardMetaAnchor      what a competent ladder player does — greedy, conventional, no
 *                             gambles. The control group: losing to this is a real weakness.
 *     AntiTrickRoomExploiter  a body that exists to waste the five-turn Trick Room clock the
 *                             engine's tempo layer prices. It punishes the *timer*, not the board:
 *                             shields, resist loops, Encore on the setter, Substitute on pivots.
 *     LowLadderChaos          epsilon-greedy noise on off-meta sets. 15% of its actions are
 *                             uniformly random, which is what unpredictable human play looks
 *                             like from the engine's side of the table.
 *
 * THE CONTRACT (frozen — the runner calls exactly this)
 *   agent.chooseAction(request, context) -> string choice | {choice} | {kind, moveId|name} | null
 *   context = { side, turn, request, log, runner }
 *   `null` means "you decide": the runner falls back to the first legal choice, so an agent that
 *   cannot read a frame it has never seen still cannot stall a battle.
 *
 * NO HANDWRITTEN GAME DATA. Base powers, types and the type chart all come from the sim's own
 * `Dex`. There is no damage arithmetic anywhere in this file — the personas rank moves by
 * `basePower x typeEffectiveness x STAB x accuracy` and let the sim resolve what actually happens.
 * Two honest simplifications, both documented where they are made: ability-based immunities
 * (Levitate, Water Absorb) are not modelled, and threat assessment uses the opponent's moves that
 * the log has already revealed rather than its full set.
 *
 * Runs deterministically: every random decision comes from one seeded mulberry32 stream, so a
 * seeded arena run replays exactly.
 *
 * Run the self-check with:  node tools/headless_arena/league_agents.js
 */
'use strict';

const bridge = require('./engine_bridge.js');
const teams = require('./teams.js');

const PROTECT_FAMILY = ['protect', 'detect', 'banefulbunker', 'spikyshield', 'kingsshield',
  'burningbulwark', 'silktrap', 'obstruct', 'endure'];
const STATUS_UTILITY = ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'swordsdance',
  'nastyplot', 'calmmind', 'dragondance', 'bulkup', 'irondefense', 'quiverdance', 'trickroom',
  'recover', 'roost', 'softboiled', 'slackoff', 'moonlight', 'synthesis', 'shadowsneak'];

/* ----------------------------------------------------------------------------- seeded random */

/** mulberry32 — tiny, fast, and reproducible across Node versions, which a benchmark needs. */
function mulberry32(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) { this.seed = (seed >>> 0) || 1; this._next = mulberry32(this.seed); }
  reset() { this._next = mulberry32(this.seed); }
  float() { return this._next(); }
  int(n) { return n <= 0 ? 0 : Math.floor(this._next() * n) % n; }
  pick(list) { return (list && list.length) ? list[this.int(list.length)] : null; }
  chance(p) { return this._next() < p; }
}

/* --------------------------------------------------------------------------------- dex reads */

function sim() { return bridge.loadSim(); }

/**
 * Type effectiveness of `moveType` against a defender's type list. The sim exposes this two ways
 * (`Dex.getEffectiveness(type, target)` and the per-type `effectiveness` chart), and the arena must
 * not fall over if only one of them is present — so both are tried, and an unknown pair scores 1
 * rather than a silent 0 or 2 that would quietly invert a matchup judgement.
 */
function effectiveness(moveType, defenderTypes) {
  const { Dex } = sim();
  let mult = 1;
  (defenderTypes || []).forEach(function (defType) {
    let v;
    if (typeof Dex.getEffectiveness === 'function') v = Dex.getEffectiveness(moveType, defType);
    if (typeof v !== 'number') {
      const entry = Dex.types.get(moveType);
      const chart = entry && entry.effectiveness;
      v = chart ? chart[defType] : undefined;
    }
    mult *= (typeof v === 'number' ? v : 1);
  });
  return mult;
}

function speciesTypes(name) {
  if (!name) return [];
  const { Dex } = sim();
  const species = Dex.species.get(name);
  return (species && species.types) || [];
}

/** Everything needed to rank a move, all of it from the sim's dex. */
function moveFacts(moveIdOrName) {
  const { Dex } = sim();
  const data = Dex.moves.get(moveIdOrName);
  if (!data || !data.exists) return null;
  return {
    id: data.id || String(moveIdOrName).toLowerCase().replace(/[^a-z0-9]/g, ''),
    name: data.name,
    type: data.type,
    basePower: data.basePower || 0,
    priority: data.priority || 0,
    category: data.category,
    /* `accuracy === true` means "cannot miss" in the dex; treat it as 100%. */
    accuracy: data.accuracy === true || data.accuracy === undefined ? 1 : Math.max(0.5, data.accuracy / 100),
    isStatus: !data.basePower
  };
}

/* ------------------------------------------------------------------------- request readers */

function activeSlot(request) {
  return (request && request.active && request.active[0]) || null;
}

/** Legal moves in a move request: the sim marks anything unusable with `disabled`. */
function legalMoves(request) {
  const active = activeSlot(request);
  const list = (active && active.moves) || [];
  const out = [];
  list.forEach(function (m) {
    if (!m || m.disabled) return;
    const id = m.id || String(m.move || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!id) return;
    out.push({ id: id, name: m.move || id, pp: m.pp, maxpp: m.maxpp });
  });
  return out;
}

/** Bench slots we may switch to: not active, not fainted, and the frame is not trapped. */
function benchOptions(request) {
  const side = (request && request.side) || {};
  const mons = side.pokemon || [];
  const active = activeSlot(request);
  if (active && active.trapped) return [];
  const out = [];
  mons.forEach(function (p, i) {
    if (!p || p.active) return;
    if (/fnt/.test(p.condition || '')) return;
    out.push({ slot: i + 1, species: (p.ident || '').split(': ')[1] || p.ident || ('slot ' + (i + 1)), condition: p.condition || '' });
  });
  return out;
}

/** Our own species from the request (the client's view of who is out). */
function activeSpecies(request) {
  const active = activeSlot(request);
  if (active && active.species) return active.species;
  const side = (request && request.side) || {};
  const mine = (side.pokemon || []).filter(function (p) { return p && p.active; })[0];
  if (mine) return (mine.details || mine.ident || '').split(',')[0].replace(/^p\d: /, '');
  return '';
}

/**
 * The opponent's active species, read out of the protocol log: the last switch, drag or replace
 * on the other side. This is the only source the personas have, which is the point — they know
 * exactly what a player looking at the screen knows.
 */
function opponentActiveSpecies(log, mySide) {
  const other = mySide === 'p1' ? 'p2' : 'p1';
  for (let i = (log || []).length - 1; i >= 0; i--) {
    const line = String(log[i] || '');
    const m = /^\|(switch|drag|replace)\|(p[12])[a-z]?: ([^|]+)\|/.exec(line);
    if (m && m[2] === other) return String(m[3]).split(',')[0].trim();
  }
  return '';
}

/** Moves the opponent has actually revealed, from `|move|` lines. */
function observedMoves(log, side) {
  const out = [];
  (log || []).forEach(function (line) {
    const m = /^\|move\|(p[12])[a-z]?: [^|]+\|([^|]+)\|/.exec(String(line || ''));
    if (!m || m[1] !== side) return;
    const id = String(m[2]).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (id && out.indexOf(id) === -1) out.push(id);
  });
  return out;
}

/** What we used last turn, so a shield is not spammed into its own failure chance. */
function lastUsedBySide(log, side) {
  for (let i = (log || []).length - 1; i >= 0; i--) {
    const m = /^\|move\|(p[12])[a-z]?: [^|]+\|([^|]+)\|/.exec(String(log[i] || ''));
    if (m && m[1] === side) return String(m[2]).toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  return '';
}

function currentTurn(context) {
  if (context && typeof context.turn === 'number' && context.turn > 0) return context.turn;
  let turn = 0;
  (context && context.log || []).forEach(function (line) {
    const m = /^\|turn\|(\d+)/.exec(String(line || ''));
    if (m) turn = parseInt(m[1], 10);
  });
  return turn;
}

/* ------------------------------------------------------------------------------ scoring core */

/**
 * Rank one legal move. Deliberately arithmetic-free game data: base power, type effectiveness,
 * STAB and accuracy all come from the dex. Status moves get a small documented utility weight so
 * an anchor can lay hazards when nothing it holds does meaningful damage.
 */
function scoreMove(moveId, request, context) {
  const facts = moveFacts(moveId);
  if (!facts) return 0;
  const opp = opponentActiveSpecies(context && context.log, (context && context.side) || 'p1');
  /* A status move does not interact with the defender's types, so it is left unscaled: scoring
   * Thunder Wave as if Ground's immunity applied to it would rank real utility last. */
  const mult = facts.isStatus ? 1 : (opp ? effectiveness(facts.type, speciesTypes(opp)) : 1);
  const myTypes = speciesTypes(activeSpecies(request));
  const stab = myTypes.indexOf(facts.type) !== -1 ? 1.5 : 1;
  const power = facts.isStatus
    ? (STATUS_UTILITY.indexOf(facts.id) !== -1 ? 35 : 8)
    : facts.basePower;
  const priority = facts.priority > 0 ? 1.05 : 1;
  return power * mult * stab * facts.accuracy * priority;
}

/* -------------------------------------------------------------------------------- base agent */

class BaseAgent {
  constructor(options) {
    options = options || {};
    this.seed = typeof options.seed === 'number' ? options.seed : 1;
    this.rng = new Rng(this.seed);
    this.name = options.name || 'agent';
    this.teamName = options.teamName || teams.SAMPLE_ORDER[0];
    this.team = options.team || teams.SAMPLE_TEAMS[this.teamName];
    if (!this.team) {
      throw new Error('league_agents: ' + this.name + ' was given no team (teamName "' +
        this.teamName + '" is not one of: ' + teams.SAMPLE_ORDER.join(', ') + ')');
    }
    this.decisions = [];
    /* The ladder band this persona MODELS. A DECLARED input, like its team — not a measurement.
     * The arena carries it to the sim's `|player|` line, where the engine's `clock.ratingBands`
     * reads it, so a persona with no rating leaves that band inert (BaseAgent.DEFAULT_RATING is
     * null on purpose: an unrated seat must behave exactly as it did before this existed). */
    const declaredRating = options.rating === undefined ? this.constructor.DEFAULT_RATING : options.rating;
    this.rating = (typeof declaredRating === 'number' && isFinite(declaredRating)) ? declaredRating : null;
    /* How fast this persona is DECLARED to think. 'normal' is the identity for the clock's switch
     * prior, and it is the default for every persona on purpose: the arena cannot measure
     * deliberation (both players share one event loop, so latency is ~0 ms), and letting the
     * estimator read that as 'auto' would prune their switch replies from the matrix in EVERY
     * baseline battle. A persona that means to model a fast or slow player declares it here; the
     * CLI can override it for a controlled run. */
    const declaredThinking = options.thinking === undefined ? this.constructor.DEFAULT_THINKING : options.thinking;
    this.thinking = (declaredThinking === 'auto' || declaredThinking === 'normal' || declaredThinking === 'agonised')
      ? declaredThinking : 'normal';
  }

  reset() { this.rng.reset(); this.decisions = []; }

  record(kind, choice, why) {
    const entry = { turn: this._turn, kind: kind, choice: choice, why: why };
    this.decisions.push(entry);
    return entry;
  }

  /** The frozen entry point. Subclasses implement the three branches. */
  chooseAction(request, context) {
    this._turn = currentTurn(context);
    if (!request) return null;
    if (request.teamPreview) return this.chooseLead(request, context);
    if (request.wait) return null;
    if (request.forceSwitch) return this.chooseReplacement(request, context);
    if (request.active) return this.chooseMove(request, context);
    return null;
  }

  chooseLead(request) {
    return bridge.teamPreviewOrder(request, this.leadIndex(request));
  }

  /** Which team-preview slot to lead with. Overridden by each persona. */
  leadIndex() { return 1; }

  chooseReplacement(request, context) {
    const bench = benchOptions(request);
    if (!bench.length) return null;
    return this.pickBestSwitch(bench, context) || ('switch ' + bench[0].slot);
  }

  /**
   * The bench slot that best resists what the opponent has actually revealed: the body whose
   * incoming pressure (sum of `effectiveness x basePower` over their known moves) is lowest.
   * With nothing revealed yet the first legal slot wins, which keeps the choice deterministic
   * instead of pretending to know a set we have not seen.
   */
  pickBestSwitch(bench, context) {
    const mySide = (context && context.side) || 'p1';
    const theirSide = mySide === 'p1' ? 'p2' : 'p1';
    const revealed = observedMoves(context && context.log, theirSide);
    let best = null;
    let bestScore = -Infinity;
    bench.forEach(function (option) {
      const types = speciesTypes(option.species);
      let pressure = 0;
      revealed.forEach(function (id) {
        const facts = moveFacts(id);
        if (!facts || facts.isStatus) return;
        pressure += effectiveness(facts.type, types) * facts.basePower;
      });
      if (-pressure > bestScore) { bestScore = -pressure; best = option; }
    });
    return best ? 'switch ' + best.slot : null;
  }

  /** Greedy move pick, shared by the anchor and by the chaos agent's safe 85%. */
  greedyMove(request, context) {
    const moves = legalMoves(request);
    if (!moves.length) return null;
    const scored = moves.map(function (m) {
      return { id: m.id, score: scoreMove(m.id, request, context) };
    });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.id < b.id ? -1 : 1;                      // deterministic tie-break
    });
    return { id: scored[0].id, score: scored[0].score, ranked: scored };
  }

  /** True when the opponent's revealed moves threaten a super-effective hit on us. */
  incomingThreat(request, context) {
    const mySide = (context && context.side) || 'p1';
    const theirSide = mySide === 'p1' ? 'p2' : 'p1';
    const myTypes = speciesTypes(activeSpecies(request));
    const revealed = observedMoves(context && context.log, theirSide);
    let worst = { multiplier: 1, moveType: null, moveId: null };
    revealed.forEach(function (id) {
      const facts = moveFacts(id);
      if (!facts || facts.isStatus) return;
      const mult = effectiveness(facts.type, myTypes);
      if (mult > worst.multiplier) worst = { multiplier: mult, moveType: facts.type, moveId: id };
    });
    return worst.multiplier > 1 ? worst : null;
  }
}

/* ------------------------------------------------------------------------------------- anchor */

/** The control group: competent, conventional, allergic to gambles. */
class StandardMetaAnchor extends BaseAgent {
  constructor(options) {
    options = options || {};
    options.name = options.name || 'StandardMetaAnchor';
    options.teamName = options.teamName || 'hazardStackBalance';
    super(options);
    this.gamble = false;
  }

  leadIndex() { return 1; }

  chooseMove(request, context) {
    const greedy = this.greedyMove(request, context);
    const threat = this.incomingThreat(request, context);
    if (!greedy) {
      const bench = benchOptions(request);
      return bench.length ? 'switch ' + bench[0].slot : null;
    }
    /* Switch only when the board says the current body cannot trade: a super-effective hit
     * coming in AND a bench body that resists that type. Otherwise attack. */
    if (threat && threat.multiplier >= 2) {
      const bench = benchOptions(request);
      const resist = this._resistFor(threat.moveType, bench);
      if (resist) {
        const choice = 'switch ' + resist.slot;
        this.record('switch', choice, 'resists ' + threat.moveType + ' revealed as ' + threat.moveId);
        return choice;
      }
    }
    this.record('move', 'move ' + greedy.id, 'greedy score ' + greedy.score.toFixed(1));
    return 'move ' + greedy.id;
  }

  _resistFor(moveType, bench) {
    let best = null;
    let bestMult = 1;
    bench.forEach(function (option) {
      const mult = effectiveness(moveType, speciesTypes(option.species));
      if (mult < bestMult) { bestMult = mult; best = option; }
    });
    return best;
  }
}

/* ---------------------------------------------------------------------------------- exploiter */

/**
 * The clock staller. Its whole objective is to make the five Trick Room turns the engine has
 * priced expire with as little happening as possible, then hand back a normal board.
 */
class AntiTrickRoomExploiter extends BaseAgent {
  constructor(options) {
    options = options || {};
    options.name = options.name || 'AntiTrickRoomExploiter';
    options.teamName = options.teamName || 'stallCore';
    super(options);
    this.trickRoomTurns = 0;
  }

  leadIndex() { return 1; }

  /** Trick Room state and its remaining turns, read from the sim's own log. */
  trickRoom(log) {
    const lines = log || [];
    let startIdx = -1;
    let endIdx = -1;
    let startTurn = 0;
    let turn = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = String(lines[i] || '');
      const t = /^\|turn\|(\d+)/.exec(line);
      if (t) turn = parseInt(t[1], 10);
      if (/\|fieldstart\|.*trick ?room/i.test(line)) { startIdx = i; startTurn = turn; }
      if (/\|fieldend\|.*trick ?room/i.test(line)) { endIdx = i; }
    }
    if (startIdx === -1 || startIdx < endIdx) return { active: false, remaining: 0, startTurn: 0, currentTurn: turn };
    const elapsed = Math.max(0, turn - startTurn);
    return { active: true, remaining: Math.max(0, 5 - elapsed), startTurn: startTurn, currentTurn: turn };
  }

  chooseMove(request, context) {
    const log = (context && context.log) || [];
    const mySide = (context && context.side) || 'p1';
    const them = mySide === 'p1' ? 'p2' : 'p1';
    const tr = this.trickRoom(log);
    this.trickRoomTurns = tr.remaining;
    const moves = legalMoves(request);
    const ids = moves.map(function (m) { return m.id; });
    const lastMine = lastUsedBySide(log, mySide);
    const shields = ids.filter(function (id) { return PROTECT_FAMILY.indexOf(id) !== -1; });

    /* A shield only helps while the clock is running, and never twice in a row: the sim halves
     * Protect's success chance on consecutive turns, so repeating it wastes the turn it is meant
     * to bank. */
    if (tr.active && tr.remaining >= 2 && shields.length && PROTECT_FAMILY.indexOf(lastMine) === -1) {
      return 'move ' + shields[0];
    }

    /* Encore the setter: the moment they refresh Trick Room, lock them onto it. */
    const lastTheirs = lastUsedBySide(log, them);
    if (ids.indexOf('encore') !== -1 && /trickroom/.test(lastTheirs)) {
      return 'move encore';
    }

    /* Substitute on a predicted pivot: it turns their switch into a free scout. */
    if (ids.indexOf('substitute') !== -1 && !tr.active) {
      const bench = benchOptions(request);
      const threat = this.incomingThreat(request, context);
      if ((!bench.length || (threat && threat.multiplier >= 2)) && this.rng.chance(0.5)) {
        return 'move substitute';
      }
    }

    /* Boiled down: a body about to be obliterated loops to its best resist. */
    const threat = this.incomingThreat(request, context);
    if (threat && threat.multiplier >= 2) {
      const bench = benchOptions(request);
      const resist = this.pickBestSwitch(bench, context);
      if (resist) return resist;
    }

    const greedy = this.greedyMove(request, context);
    if (!greedy) {
      const bench = benchOptions(request);
      return bench.length ? 'switch ' + bench[0].slot : null;
    }
    return 'move ' + greedy.id;
  }

  chooseReplacement(request, context) {
    const bench = benchOptions(request);
    if (!bench.length) return null;
    return this.pickBestSwitch(bench, context) || ('switch ' + bench[0].slot);
  }
}

/* -------------------------------------------------------------------------------------- chaos */

/** Epsilon-greedy noise: 85% safe, 15% uniformly random legal action. */
class LowLadderChaos extends BaseAgent {
  constructor(options) {
    options = options || {};
    options.name = options.name || 'LowLadderChaos';
    options.teamName = options.teamName || 'ladderGimmick';
    super(options);
    this.epsilon = typeof options.epsilon === 'number' ? options.epsilon : 0.15;
  }

  leadIndex(request) {
    const count = ((request && request.side && request.side.pokemon) || []).length;
    return count ? this.rng.int(count) + 1 : 1;
  }

  chooseMove(request, context) {
    if (this.rng.chance(this.epsilon)) {
      const options = [];
      legalMoves(request).forEach(function (m) { options.push('move ' + m.id); });
      benchOptions(request).forEach(function (b) { options.push('switch ' + b.slot); });
      const pick = this.rng.pick(options);
      if (pick) return pick;
    }
    const greedy = this.greedyMove(request, context);
    if (greedy) return 'move ' + greedy.id;
    const bench = benchOptions(request);
    return bench.length ? 'switch ' + bench[0].slot : null;
  }

  chooseReplacement(request) {
    const bench = benchOptions(request);
    if (!bench.length) return null;
    return 'switch ' + this.rng.pick(bench).slot;
  }
}

/* ----------------------------------------------------------------------------------- the mirror */

/**
 * SELF-PLAY: the extension's own decision engine, FROZEN, piloting the opposing team.
 *
 * WHY THE LEAGUE NEEDED IT. The three personas are heuristics, and the engine beats them 98.3 % with
 * ZERO losses in 60 games, so the instrument sits at its ceiling: it can show HARM and essentially
 * nothing else, and fourteen of the ablation table's rows read 0.0 for want of headroom rather than
 * because the feature does nothing (ATTEMPTS.md section H). A mirror drops the baseline to ~50 %,
 * where a change that helps is as visible as one that hurts — which is the only way to price the
 * upper half of that table.
 *
 * FROZEN means the SHIPPED config even when the whole run carries a `--set` patch, so a paired
 * ablation measures the patched p1 against the baseline p2. If both seats shared the patch the
 * variant would be playing itself and every effect would cancel. See
 * engine_bridge.loadHarness({ baseline: true }).
 *
 * It speaks the arena's frozen agent contract (`chooseAction(request, context)`), NOT the persona
 * heuristic interface: it feeds its own side's protocol log into one EngineSession and answers each
 * `|request|` with the engine's own top line, exactly as run_arena's p1 agent does. When the engine
 * refuses to rank anything it returns null so the DRIVER's fallback ladder answers, and the refusal
 * is counted (`mirrorEmpty`) rather than hidden.
 */
class EngineMirrorAgent extends BaseAgent {
  constructor(options) {
    options = options || {};
    options.name = options.name || 'EngineMirror';
    /* The mirror pilots the SAME team the engine under test does, so the matchup is symmetric. */
    options.teamName = options.teamName || 'hazardStackBalance';
    super(options);
    /* The mirror is the shipped config by default; `baseline: false` makes it share the process's
     * (possibly patched) sandbox, which is only useful for a same-config self-play run. */
    this.baseline = options.baseline !== false;
    this.mirrorRequests = 0;
    this.mirrorEmpty = 0;
    this.mirrorErrors = 0;
    this._session = null;
    this._watermark = 0;
    this._lastFed = null;
    this._side = null;
  }

  reset() {
    super.reset();
    this._session = null;
    this._watermark = 0;
    this._lastFed = null;
    this._side = null;
    this.mirrorRequests = 0;
    this.mirrorEmpty = 0;
    this.mirrorErrors = 0;
  }

  /** The one EngineSession, built lazily so a process that never seats the mirror pays nothing. */
  session() {
    if (this._session) return this._session;
    const opts = { paste: this.team, name: this.name };
    if (this.baseline) opts.baseline = true;
    const session = bridge.createSession(opts);
    /* Its opponent is the OTHER engine seat on this single event loop — the same ~0 ms lead the
     * clock mis-reads on p1 (OpponentClock.declare) — so the mirror declares it too. */
    if (typeof session.declareOpponentDeliberation === 'function') session.declareOpponentDeliberation('normal');
    this._session = session;
    return session;
  }

  /** One protocol line, skipping any `|request|` that is not this seat's own. */
  _feed(session, line) {
    if (!line) return;
    if (typeof line === 'string' && line.lastIndexOf('|request|', 0) === 0 && this._side) {
      let req = null;
      try { req = JSON.parse(line.slice('|request|'.length)); } catch (e) { return; }
      if (req && req.side && req.side.id && req.side.id !== this._side) return;
    }
    try { session.feed(line); this._lastFed = line; } catch (e) { this.mirrorErrors++; }
  }

  /** Feed everything the driver's log has added since the last call (the p1 agent's watermark). */
  _feedTo(session, log) {
    if (!Array.isArray(log) || !log.length) return;
    if (this._watermark > 0 && log[this._watermark - 1] !== this._lastFed) {
      let at = -1;
      for (let i = log.length - 1; i >= 0; i--) { if (log[i] === this._lastFed) { at = i; break; } }
      if (at < 0) return;
      this._watermark = at + 1;
    }
    while (this._watermark < log.length) this._feed(session, log[this._watermark++]);
  }

  /** The engine's own line for one decision window, or null (the driver then falls back). */
  _decide(session, request) {
    try {
      if (request.teamPreview) return bridge.teamPreviewOrder(request);
      if (request.wait) return null;
      if (request.forceSwitch) {
        const ladder = session.choiceLadder(8);
        for (let i = 0; i < ladder.length; i++) {
          if (ladder[i].lastIndexOf('switch ', 0) === 0) return ladder[i];
        }
        this.mirrorEmpty++;
        return null;
      }
      if (request.active) {
        const top = session.topChoice();
        if (top) return top;
        this.mirrorEmpty++;
        return null;
      }
      return null;
    } catch (e) { this.mirrorErrors++; return null; }
  }

  chooseAction(request, context) {
    const ctx = context || {};
    if (ctx.side) this._side = ctx.side;
    const session = this.session();
    this._feedTo(session, ctx.log);
    if (!request) return null;
    this.mirrorRequests++;
    const choice = this._decide(session, request);
    // Our own outgoing frame, so this seat's clock is live too and the two seats stay symmetric.
    if (choice) { try { session.noteOutgoing(choice); } catch (e) { this.mirrorErrors++; } }
    return choice;
  }
}

/* ---------------------------------------------------------------------------------- the league */

/** One agent per persona, in the arena's stable order, ready to play the named team. */
function createLeague(options) {
  options = options || {};
  const seed = typeof options.seed === 'number' ? options.seed : 1;
  const anchorTeam = options.anchorTeam || 'hazardStackBalance';
  const exploiterTeam = options.exploiterTeam || 'stallCore';
  const chaosTeam = options.chaosTeam || 'ladderGimmick';
  return [
    new StandardMetaAnchor({ seed: seed, teamName: anchorTeam }),
    new AntiTrickRoomExploiter({ seed: seed + 1, teamName: exploiterTeam }),
    new LowLadderChaos({ seed: seed + 2, teamName: chaosTeam, epsilon: options.epsilon })
  ];
}

const ALL_AGENTS = ['anchor', 'exploiter', 'chaos'];
/* The league the CLI can seat, which is the three personas PLUS the self-play mirror. `ALL_AGENTS`
 * stays the roster `createLeague` returns; `LEAGUE_IDS` is what `--agent`/`--league` validate against. */
const LEAGUE_IDS = ALL_AGENTS.concat(['mirror']);

function byId(id, options) {
  const league = createLeague(options);
  const map = { anchor: league[0], exploiter: league[1], chaos: league[2] };
  if (!map[id] && id !== 'mirror') {
    throw new Error('league_agents: unknown agent "' + id + '" (have: ' + LEAGUE_IDS.join(', ') + ')');
  }
  if (id === 'mirror') {
    const m = options || {};
    return new EngineMirrorAgent({ seed: typeof m.seed === 'number' ? m.seed : 1, teamName: m.teamName });
  }
  return map[id];
}

/* Each persona's declared ladder band. The NAME is the claim — an "anchor" opponent plays the
 * standard meta and a "chaos" one is low ladder — and the three land in the three bands
 * `clock.ratingBands` distinguishes (low <= 1350, mid, high >= 1650), so one sweep exercises all
 * three rather than pinning every opponent to one value. */
BaseAgent.DEFAULT_RATING = null;              // a persona that declares nothing carries no rating
/* Neutral by default: see the thinking note in the BaseAgent constructor. NO persona overrides this
 * today — pricing the clock requires declaring a fast or slow opponent on purpose (`--deliberation`). */
BaseAgent.DEFAULT_THINKING = 'normal';
StandardMetaAnchor.DEFAULT_THINKING = 'normal';
AntiTrickRoomExploiter.DEFAULT_THINKING = 'normal';
LowLadderChaos.DEFAULT_THINKING = 'normal';
StandardMetaAnchor.DEFAULT_RATING = 1700;
AntiTrickRoomExploiter.DEFAULT_RATING = 1500;
LowLadderChaos.DEFAULT_RATING = 1100;

module.exports = {
  mulberry32: mulberry32,
  Rng: Rng,
  BaseAgent: BaseAgent,
  StandardMetaAnchor: StandardMetaAnchor,
  AntiTrickRoomExploiter: AntiTrickRoomExploiter,
  LowLadderChaos: LowLadderChaos,
  EngineMirrorAgent: EngineMirrorAgent,
  createLeague: createLeague,
  byId: byId,
  ALL_AGENTS: ALL_AGENTS,
  LEAGUE_IDS: LEAGUE_IDS,
  PROTECT_FAMILY: PROTECT_FAMILY,
  legalMoves: legalMoves,
  benchOptions: benchOptions,
  effectiveness: effectiveness,
  speciesTypes: speciesTypes,
  moveFacts: moveFacts,
  scoreMove: scoreMove,
  opponentActiveSpecies: opponentActiveSpecies,
  observedMoves: observedMoves,
  activeSpecies: activeSpecies
};

/* --------------------------------------------------------------------------------- self-check */

if (require.main === module) {
  const LOG = [
    '|player|p1|Tactician||', '|player|p2|Adversary||', '|gen|9', '|tier|[Gen 9] National Dex',
    '|poke|p1|Great Tusk|', '|poke|p2|Garchomp|', '|teampreview|',
    '|start', '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100', '|switch|p2a: Garchomp|Garchomp, L50, M|100/100',
    '|turn|1', '|move|p2a: Garchomp|Earthquake|p1a: Great Tusk', '|-damage|p1a: Great Tusk|62/100',
    '|turn|2', '|fieldstart|move: Trick Room|[of] p1a: Great Tusk',
    '|move|p2a: Garchomp|Stone Edge|p1a: Great Tusk'
  ];

  const moveRequest = {
    side: {
      id: 'p1', name: 'Tactician',
      pokemon: [
        { ident: 'p1: Great Tusk', details: 'Great Tusk, L50, M', condition: '62/100', active: true },
        { ident: 'p1: Gholdengo', details: 'Gholdengo, L50, M', condition: '100/100', active: false },
        { ident: 'p1: Corviknight', details: 'Corviknight, L50, F', condition: '0 fnt', active: false }
      ]
    },
    active: [{
      moves: [
        { move: 'Headlong Rush', id: 'headlongrush', pp: 16, maxpp: 16, disabled: false, target: 'normal' },
        { move: 'Stealth Rock', id: 'stealthrock', pp: 32, maxpp: 32, disabled: false, target: 'foeSide' },
        { move: 'Protect', id: 'protect', pp: 16, maxpp: 16, disabled: false, target: 'self' },
        { move: 'Close Combat', id: 'closecombat', pp: 8, maxpp: 8, disabled: true, target: 'normal' }
      ]
    }],
    rqid: 1
  };

  const previewRequest = {
    teamPreview: true,
    side: {
      id: 'p1', pokemon: [
        { ident: 'p1: Great Tusk', condition: '100/100', active: false },
        { ident: 'p1: Gholdengo', condition: '100/100', active: false },
        { ident: 'p1: Corviknight', condition: '100/100', active: false },
        { ident: 'p1: Ferrothorn', condition: '100/100', active: false },
        { ident: 'p1: Gliscor', condition: '100/100', active: false },
        { ident: 'p1: Skarmory', condition: '100/100', active: false }
      ]
    }
  };

  const switchRequest = {
    forceSwitch: [true],
    side: {
      id: 'p1', pokemon: [
        { ident: 'p1: Great Tusk', condition: '0 fnt', active: true },
        { ident: 'p1: Gholdengo', condition: '100/100', active: false },
        { ident: 'p1: Corviknight', condition: '100/100', active: false }
      ]
    }
  };

  console.log('agents:', ALL_AGENTS.join(', '), '| format:', teams.SIM_FORMAT_ID);
  const league = createLeague({ seed: 11 });
  league.forEach(function (agent) {
    const verdict = teams.validateTeam(agent.team);
    console.log('\n' + agent.name + ' | team: ' + agent.teamName + ' | legal: ' + (!verdict || !verdict.length ? 'yes' : 'NO — ' + verdict.join('; ')));
    const ctx = { side: 'p1', turn: 2, log: LOG, request: null };
    console.log('  team preview -> ' + agent.chooseAction(previewRequest, ctx));
    console.log('  move  turn2  -> ' + agent.chooseAction(moveRequest, ctx));
    console.log('  force switch -> ' + agent.chooseAction(switchRequest, ctx));
    console.log('  wait frame   -> ' + JSON.stringify(agent.chooseAction({ wait: true }, ctx)));
  });

  /* Determinism: the same seed must replay the same chaos decisions. */
  const a = new LowLadderChaos({ seed: 7 });
  const b = new LowLadderChaos({ seed: 7 });
  const seqA = [], seqB = [];
  for (let i = 0; i < 8; i++) {
    seqA.push(a.chooseAction(moveRequest, { side: 'p1', turn: i + 1, log: LOG }));
    seqB.push(b.chooseAction(moveRequest, { side: 'p1', turn: i + 1, log: LOG }));
  }
  console.log('\nseeded chaos replay identical:', JSON.stringify(seqA) === JSON.stringify(seqB));
  console.log('chaos sequence:', seqA.join(' / '));

  /* Trick Room clock reading, the exploiter's whole input. */
  const exploiter = new AntiTrickRoomExploiter({ seed: 3 });
  console.log('trick room read:', JSON.stringify(exploiter.trickRoom(LOG)));
  console.log('greedy anchor pick:', JSON.stringify(new StandardMetaAnchor({ seed: 1 }).greedyMove(moveRequest, { side: 'p1', turn: 2, log: LOG })));
}
