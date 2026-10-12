/* Showdown Tactician — tools/headless_arena/sim_runner.js
 *
 * WHY THIS EXISTS
 *   The arena has to play real games, not approximated ones. Every engine claim ("this line is
 *   optimal", "the veto guard would not take that bait", "crucible turns are where games are
 *   lost") is only worth something if it is measured against the actual cartridge-accurate
 *   simulator, driven at the protocol level. This module is that driver: the single place that
 *   knows how to start an @pkmn/sim battle, hand each side the frames it is entitled to see, and
 *   turn whatever the agents answer into legal stream input.
 *
 * THE FOUR FACTS THIS DRIVER EXISTS TO ENCODE (all measured against @pkmn/sim 0.10.11)
 *
 *   (a) THERE ARE TWO DIFFERENT WRITE CHANNELS.
 *       `stream.write('>start …')` / `stream.write('>player p1 …')` go to the RAW BattleStream.
 *       Choices go to the PLAYER stream: `players.p1.write('move 1')`. That wrapper already
 *       prefixes `>p1 `, so writing the prefix ourselves produces
 *       `|error|[Invalid choice] Unrecognized choice: >p1 move 1` and the battle never advances.
 *       Measured, twice, the hard way. `normalizeChoice` therefore strips a stray prefix rather
 *       than trusting an agent to remember this.
 *
 *   (b) TEAM PREVIEW IS ON in gen9nationaldex. The first request carries `teamPreview: true` and
 *       the order must contain EXACTLY one digit per team member — a three-Pokemon team takes
 *       `team 123`; six digits is rejected and the battle stalls on the preview forever. The team
 *       size is read from the request itself (`request.side.pokemon.length`), never from the
 *       packed string, because a packed team separates sets with `]` while a paste uses newlines.
 *
 *   (c) A BAD CHOICE NEVER THROWS. The sim answers with `|error|[Invalid choice] …` on that
 *       player's stream and re-sends the request. That is a recoverable event, so this driver
 *       keeps a bounded fallback ladder per side: the agent's first answer, then every other
 *       legal move, then every legal switch, then the first legal choice. Four retries, then it
 *       stops trying rather than spinning — an agent that cannot produce a legal choice is a
 *       fact the report should carry, not an infinite loop.
 *
 *   (d) `players.omniscient` IS READ-ONLY and carries the full public log. It is the record of
 *       truth for the report (including `swingTurn`), and nothing is ever written to it.
 *
 * SWINGTURN, DEFINED EXACTLY
 *   The report names the turn that hurt us most, computed from the log instead of guessed. p1 is
 *   always "us". For each turn we net, in HP percent, every `|-damage|`, `|-heal|` and `|-sethp|`
 *   (signed by which side owns the ident) plus every `|faint|` (a faint is the rest of that
 *   Pokemon's bar: `-hp` for us, `+hp` for them). The turn with the lowest net value is returned
 *   when that value is negative; when no turn moved against us the answer is null, because
 *   inventing a pivotal turn for a game we never lost is worse than saying nothing. The pre-turn
 *   block (team preview, `|clearpoke|`, `|poke|`) is not a turn and is excluded.
 *
 * USAGE
 *   const runner = new HeadlessBattleRunner();
 *   runner.initBattle(p1Packed, p2Packed, 1234);
 *   const report = await runner.runGame(engineAgent, personaAgent, 100);
 *
 * Self-check:  node tools/headless_arena/sim_runner.js
 */
'use strict';

const bridge = require('./engine_bridge.js');

/* The OU-tier National Dex format — see engine_bridge.js for why this id is the target. */
const DEFAULT_FORMAT = bridge.SIM_FORMAT_ID;
/* A fixed seed, because "reproducible" is the whole point of an arena. Never Date.now(). */
const DEFAULT_SEED = [12345, 54321, 4242, 1717];
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_TURNS = 100;
const MAX_FALLBACKS = 4;

function loadSim() {
  return require('@pkmn/sim');
}

/* --------------------------------------------------------------------------- choices */

/**
 * The one legal choice every request has, used both as an agent's safety net and as the base of
 * the retry ladder. Returns null for a frame that must not be answered (`wait`, or a battle that
 * is already over).
 */
function firstLegalChoice(request, options) {
  if (!request || typeof request !== 'object') return null;
  if (request.wait) return null;
  if (request.teamPreview) {
    const mons = (request.side && request.side.pokemon) || [];
    if (!mons.length) return null;
    const order = mons.map(function (_, i) { return i + 1; });
    const preferred = options && options.preferredLead;
    if (typeof preferred === 'number' && preferred >= 1 && preferred <= order.length) {
      const at = order.indexOf(preferred);
      if (at > 0) { order.splice(at, 1); order.unshift(preferred); }
    }
    return 'team ' + order.join('');
  }
  if (request.forceSwitch) {
    const mons = (request.side && request.side.pokemon) || [];
    for (let i = 0; i < mons.length; i++) {
      if (!request.forceSwitch[i]) continue;
      if (mons[i].active) continue;
      if (/\bfnt\b/.test(String(mons[i].condition || ''))) continue;
      return 'switch ' + (i + 1);
    }
    return pickReplacement(request, true);
  }
  if (request.active) {
    const moves = (request.active[0] && request.active[0].moves) || [];
    for (let i = 0; i < moves.length; i++) {
      if (!moves[i].disabled) return 'move ' + (i + 1);
    }
    /* Every move disabled or out of PP: the sim accepts `move 1` and substitutes Struggle. */
    if (moves.length) return 'move 1';
  }
  return null;
}

/** A legal replacement from the bench, ignoring `forceSwitch` gating when `anyHealthy` is set. */
function pickReplacement(request, anyHealthy) {
  const mons = (request.side && request.side.pokemon) || [];
  for (let i = 0; i < mons.length; i++) {
    const condition = String(mons[i].condition || '');
    if (mons[i].active) continue;
    if (/\bfnt\b/.test(condition)) continue;
    if (!anyHealthy && !(request.forceSwitch && request.forceSwitch[i])) continue;
    return 'switch ' + (i + 1);
  }
  return null;
}

/**
 * Turn whatever an agent returned into a stream command. Accepts a bare string, `{choice}`,
 * `{kind:'move', moveId|name}`, `{kind:'switch', name|slot|targetId}`, or `{kind:'team', order}`.
 * A leading `>p1 `/`>p2 ` prefix is stripped: see fact (a) in the header — this is the mistake
 * that silently stalls a battle, so it is absorbed here rather than trusted to every agent.
 */
function normalizeChoice(action, request) {
  if (action === null || action === undefined) return null;
  if (typeof action === 'string') {
    let s = action.trim();
    if (!s) return null;
    if (s.charAt(0) === '>') {
      const parts = s.split(/\s+/);
      s = parts.slice(parts[0].toLowerCase() === '>p1' || parts[0].toLowerCase() === '>p2' ? 1 : 0).join(' ');
      s = s.replace(/^>\s*/, '').trim();
    }
    if (!s) return null;
    return s;
  }
  if (typeof action !== 'object') return null;
  if (typeof action.choice === 'string' && action.choice.trim()) return normalizeChoice(action.choice, request);
  const kind = action.kind;
  if (kind === 'move') {
    const id = action.moveId || (action.name ? toId(action.name) : '');
    return id ? 'move ' + id : null;
  }
  if (kind === 'switch') {
    if (action.name) return 'switch ' + action.name;
    if (typeof action.switchSlot === 'number' && action.switchSlot > 0) return 'switch ' + action.switchSlot;
    if (typeof action.slot === 'number' && action.slot > 0) return 'switch ' + action.slot;
    if (action.targetId) return 'switch ' + action.targetId;
    return null;
  }
  if (kind === 'team') {
    if (typeof action.order === 'string' && action.order) return 'team ' + action.order;
    if (Array.isArray(action.order) && action.order.length) return 'team ' + action.order.join('');
    return null;
  }
  if (kind === 'forfeit') return 'forfeit';
  return null;
}

/** Showdown's id normalisation, kept local so the driver has no dependency on the engine. */
function toId(text) {
  return String(text === null || text === undefined ? '' : text).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Every legal choice for a frame, best-effort, de-duplicated, the agent's own answer first. */
function choiceLadder(request, chosen) {
  const out = [];
  const push = function (c) { if (c && out.indexOf(c) === -1) out.push(c); };
  if (chosen) push(chosen);
  push(firstLegalChoice(request));
  if (request.teamPreview) {
    const mons = (request.side && request.side.pokemon) || [];
    for (let i = 1; i <= mons.length; i++) push('team ' + i + mons.map(function (_, k) { return k + 1; }).filter(function (d) { return d !== i; }).join(''));
  }
  if (request.active && request.active[0] && request.active[0].moves) {
    const moves = request.active[0].moves;
    for (let i = 0; i < moves.length; i++) if (!moves[i].disabled) push('move ' + (i + 1));
  }
  const mons = (request.side && request.side.pokemon) || [];
  for (let i = 0; i < mons.length; i++) {
    if (mons[i].active) continue;
    if (/\bfnt\b/.test(String(mons[i].condition || ''))) continue;
    push('switch ' + (i + 1));
  }
  return out;
}

/* ------------------------------------------------------------------------ swingTurn */

/** The percent in a protocol condition (`62/100`, `45%`, `0 fnt`). Null when there is none. */
function parseHpPercent(condition) {
  if (typeof condition !== 'string') return null;
  const text = condition.trim();
  const m = /^(\d+)\s*(?:\/|%)/.exec(text);
  if (m) return parseInt(m[1], 10);
  if (/\bfnt\b/.test(text)) return 0;
  return null;
}

function isOurIdent(ident) {
  return /^p1/.test(String(ident || ''));
}

/**
 * The turn that hurt p1 most — see the header for the exact accounting. Exported because the
 * harvester and the arena suite both want the same definition, not a second opinion.
 */
function computeSwingTurn(fullLog) {
  const hp = Object.create(null);
  const swings = Object.create(null);
  let turn = 0;
  const lines = fullLog || [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== 'string') continue;
    if (line.indexOf('|turn|') === 0) {
      const t = parseInt(line.split('|')[2], 10);
      if (t) turn = t;
      continue;
    }
    /* Team preview and the pre-turn block are not a turn. */
    if (!turn) continue;
    const parts = line.split('|');
    const type = parts[1];
    if (!type) continue;
    const ident = parts[2];
    if (type === 'switch' || type === 'drag' || type === 'replace') {
      const pct = parseHpPercent(parts[4]);
      if (ident && pct !== null) hp[ident] = pct;
      continue;
    }
    if (type === '-damage' || type === '-heal' || type === '-sethp') {
      const pct = parseHpPercent(parts[3]);
      if (!ident || pct === null) continue;
      const before = hp[ident] === undefined ? 100 : hp[ident];
      hp[ident] = pct;
      const delta = pct - before;
      swings[turn] = (swings[turn] || 0) + (isOurIdent(ident) ? delta : -delta);
      continue;
    }
    if (type === 'faint') {
      if (!ident) continue;
      const before = hp[ident] === undefined ? 100 : hp[ident];
      hp[ident] = 0;
      swings[turn] = (swings[turn] || 0) + (isOurIdent(ident) ? -before : before);
      continue;
    }
  }
  let worstTurn = null;
  let worstValue = 0;
  Object.keys(swings).forEach(function (key) {
    const value = swings[key];
    if (value < worstValue) { worstValue = value; worstTurn = parseInt(key, 10); }
  });
  return worstTurn;
}

/* ---------------------------------------------------------------------------- seed */

/**
 * Normalise a seed into the four integers the sim's PRNG takes. A number is spread
 * deterministically across the four lanes; null gets the fixed default. Determinism matters more
 * than elegance here: a seed that varied per run would make every arena number unreproducible.
 */
function normalizeSeed(seed) {
  if (seed === null || seed === undefined) return DEFAULT_SEED.slice();
  let values = Array.isArray(seed) ? seed.slice() : [seed];
  if (!values.length) return DEFAULT_SEED.slice();
  let state = 0;
  for (let i = 0; i < values.length; i++) state = (state * 31 + (Math.abs(Math.floor(Number(values[i])) || 0))) % 2147483647;
  if (!state) state = 1;
  const out = [];
  for (let i = 0; i < 4; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out.push(state % 65536);
  }
  return out;
}

/* ---------------------------------------------------------------------------- runner */

class HeadlessBattleRunner {
  constructor(format, options) {
    if (format && typeof format === 'object') { options = format; format = null; }
    options = options || {};
    this.format = format || DEFAULT_FORMAT;
    this.options = options;
    this.timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.name1 = options.name1 || 'Tactician';
    this.name2 = options.name2 || 'Adversary';
    this.packed = { p1: null, p2: null };
    this.players = null;
    this.stream = null;
    this.fullLog = [];
    this.sideLog = { p1: [], p2: [] };
    this.choices = { p1: [], p2: [] };
    this.substitutions = [];
    this.errors = [];
    this.pending = { p1: null, p2: null };
    this.turn = 0;
    this.winner = null;
    this.ended = false;
    this.timedOut = false;
    this.aborted = false;
    this.reason = null;
    this.seed = normalizeSeed(null);
    this._omniscient = null;
    this.maxTurns = DEFAULT_MAX_TURNS;
  }

  /** Start a battle. Returns `this` so a caller can chain `initBattle(...).runGame(...)`. */
  initBattle(p1TeamPacked, p2TeamPacked, seed) {
    if (typeof p1TeamPacked !== 'string' || !p1TeamPacked) {
      throw new Error('initBattle: p1TeamPacked must be a sim-packed team string');
    }
    if (typeof p2TeamPacked !== 'string' || !p2TeamPacked) {
      throw new Error('initBattle: p2TeamPacked must be a sim-packed team string');
    }
    const sim = loadSim();
    this.sim = sim;
    this.packed.p1 = p1TeamPacked;
    this.packed.p2 = p2TeamPacked;
    this.seed = normalizeSeed(seed === undefined ? null : seed);
    this.stream = new sim.BattleStreams.BattleStream();
    this.players = sim.BattleStreams.getPlayerStreams(this.stream);
    const self = this;
    this._omniscient = (async function () {
      try {
        for await (const chunk of self.players.omniscient) {
          const lines = String(chunk).split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            self.fullLog.push(line);
            self._notePublic(line, null);
          }
        }
      } catch (e) {
        self.errors.push('omniscient: ' + (e && e.message ? e.message : String(e)));
      }
    })();
    const start = { formatid: this.format, seed: this.seed };
    this._writeStream('>start ' + JSON.stringify(start));
    this._writeStream('>player p1 ' + JSON.stringify({ name: this.name1, team: p1TeamPacked }));
    this._writeStream('>player p2 ' + JSON.stringify({ name: this.name2, team: p2TeamPacked }));
    return this;
  }

  _writeStream(command) {
    try {
      const result = this.stream.write(command);
      if (result && typeof result.catch === 'function') result.catch(function () { });
      return true;
    } catch (e) {
      this.errors.push('stream.write: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
  }

  _writeChoice(side, choice) {
    const player = this.players && this.players[side];
    if (!player) return false;
    try {
      const result = player.write(choice);
      if (result && typeof result.catch === 'function') result.catch(function () { });
      return true;
    } catch (e) {
      this.errors.push('player.write[' + side + ']: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
  }

  /**
   * Public bookkeeping shared by both the omniscient reader and each side's drive loop. `side`
   * is set only when the line arrived on a player's own stream, which is the only place an
   * `|error|` can be retried against that side's pending request.
   */
  _notePublic(line, side) {
    if (side && line.indexOf('|error|') === 0) this._retryAfterError(side, line);
    if (line.indexOf('|turn|') === 0) {
      const t = parseInt(line.split('|')[2], 10);
      if (t) this.turn = t;
      return;
    }
    if (line.indexOf('|win|') === 0) {
      const who = line.split('|')[2];
      this.ended = true;
      this.winner = who === this.name1 ? 'p1' : (who === this.name2 ? 'p2' : 'tie');
      this.reason = 'win';
      return;
    }
    if (line.indexOf('|tie|') === 0) {
      this.ended = true;
      this.winner = 'tie';
      this.reason = 'tie';
      return;
    }
    if (line.indexOf('|error|') === 0) this.errors.push(line);
  }

  /**
   * Play the battle. Resolves with the MatchReport; it never rejects and never hangs — a battle
   * that stops responding is reported as `timedOut`, one that runs past `maxTurns` as `aborted`.
   */
  async runGame(p1Agent, p2Agent, maxTurns) {
    if (!this.players) throw new Error('runGame: call initBattle() first');
    this.maxTurns = typeof maxTurns === 'number' && maxTurns > 0 ? maxTurns : DEFAULT_MAX_TURNS;
    const agents = { p1: p1Agent, p2: p2Agent };
    const self = this;
    const drives = [
      this._driveSide('p1', agents),
      this._driveSide('p2', agents)
    ];
    let timer = null;
    const guard = new Promise(function (resolve) {
      timer = setTimeout(function () {
        self.timedOut = true;
        self.reason = 'timeout';
        self._abort();
        resolve();
      }, self.timeoutMs);
    });
    try {
      await Promise.race([Promise.all(drives).catch(function (e) {
        self.errors.push('drive: ' + (e && e.message ? e.message : String(e)));
      }), guard]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    /* Give the omniscient reader a beat to flush the tail of the log (the winner line and the
     * final `|upkeep|`) so the report is not a race against a microtask. */
    await this._settle();
    return this.report();
  }

  async _settle() {
    /* The winner line is published on every stream, so `ended` can be set by a player stream
     * before the omniscient reader has drained the tail of the public log. Give the reader one
     * beat unconditionally, then stop as soon as it has caught up. */
    await new Promise(function (r) { setTimeout(r, 15); });
    for (let i = 0; i < 8; i++) {
      if (this.ended && this.fullLog.length) break;
      await new Promise(function (r) { setTimeout(r, 5); });
    }
  }

  /** The per-side drive loop: iterate that player's frames, answer every decision window. */
  async _driveSide(side, agents) {
    const player = this.players[side];
    const agent = agents[side];
    const self = this;
    try {
      for await (const chunk of player) {
        const lines = String(chunk).split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          this.sideLog[side].push(line);
          this._notePublic(line, side);
          if (line.indexOf('|request|') === 0) await this._answer(side, agent, line);
        }
        if (this.ended) { this._abort(); break; }
        if (this.turn > this.maxTurns) {
          this.aborted = true;
          this.reason = 'maxTurns';
          this._abort();
          break;
        }
      }
    } catch (e) {
      this.errors.push('drive[' + side + ']: ' + (e && e.message ? e.message : String(e)));
    }
  }

  /** Dispatch one decision window to an agent and write the answer. */
  async _answer(side, agent, line) {
    let request = null;
    try {
      request = JSON.parse(line.slice('|request|'.length));
    } catch (e) {
      this.errors.push('request-json[' + side + ']: ' + (e && e.message ? e.message : String(e)));
      return;
    }
    if (request.wait) return;
    let raw = null;
    if (agent && typeof agent.chooseAction === 'function') {
      try {
        raw = await agent.chooseAction(request, {
          side: side, turn: this.turn, request: request, log: this.sideLog[side], runner: this
        });
      } catch (e) {
        this.errors.push('agent[' + side + ']: ' + (e && e.message ? e.message : String(e)));
        raw = null;
      }
    }
    let choice = normalizeChoice(raw, request);
    if (!choice) {
      const fallback = firstLegalChoice(request);
      if (fallback) this.substitutions.push({ side: side, turn: this.turn, used: fallback, returned: raw === null || raw === undefined ? null : raw });
      choice = fallback;
    }
    if (!choice) return;
    const ladder = choiceLadder(request, choice);
    ladder.shift();
    this.pending[side] = { attempts: 0, ladder: ladder, request: request };
    this.choices[side].push(choice);
    this._writeChoice(side, choice);
  }

  /**
   * A rejected choice does not throw — the sim re-sends the request after `|error|`. Walk the
   * ladder a bounded number of times, then give up so a broken agent cannot spin the arena.
   */
  _retryAfterError(side, line) {
    if (line.indexOf('[Invalid choice]') === -1) return;
    const pending = this.pending[side];
    if (!pending) return;
    pending.attempts++;
    if (pending.attempts > MAX_FALLBACKS) return;
    const next = pending.ladder.shift();
    if (!next) return;
    this.substitutions.push({ side: side, turn: this.turn, used: next, returned: 'retry' });
    this.choices[side].push(next);
    this._writeChoice(side, next);
  }

  /** Stop the battle and end every stream so a hung game cannot keep the process alive. */
  _abort() {
    /* A completed game is not an aborted one: `close()` runs after every battle, including the
     * ones that ended with a winner, and must not relabel them. */
    this.aborted = this.aborted || (!this.ended && !this.timedOut);
    /* Ending the streams is only ours to do when WE are cutting a live battle short. Once a
     * battle has ended the sim has already closed its own streams, and calling `writeEnd()` on a
     * stream whose Battle is gone does not fail politely: it reaches `Battle.destroy()` through a
     * promise, so the throw arrives as an UNHANDLED REJECTION that the try/catch below can never
     * see, and it takes the whole process down. That was measured, not theorised: a battle that
     * finished normally with `|win|` crashed this module's own self-check at `writeEnd()`. Hence
     * two guards — never end after an end, and never end the same stream twice. */
    if (this._streamsEnded || this.ended) return;
    this._streamsEnded = true;
    const players = this.players || {};
    const swallow = function (p) { if (p && typeof p.catch === 'function') p.catch(function () { }); };
    ['p1', 'p2'].forEach(function (side) {
      const player = players[side];
      if (player && typeof player.writeEnd === 'function') {
        try { swallow(player.writeEnd()); } catch (e) { /* already ended */ }
      }
    });
    if (this.stream && typeof this.stream.writeEnd === 'function') {
      try { swallow(this.stream.writeEnd()); } catch (e) { /* already ended */ }
    }
  }

  /** Close the runner explicitly; safe to call twice and safe to call mid-battle. */
  close() {
    this._abort();
  }

  report() {
    return {
      winner: this.winner || 'tie',
      turnCount: this.turn,
      fullLog: this.fullLog.slice(),
      /* The player streams, which are a strict SUPERSET of the public log: each one carries the
       * public battle PLUS that seat's private frames (`|request|`, `|error|`), in the order a
       * client saw them. `fullLog` cannot stand in for them — the sim never publishes `|request|`
       * on the omniscient stream, so a log built from `fullLog` alone contains no decision frame at
       * all. That is not a cosmetic difference: anything that replays the engine's own decisions
       * (the blunder harvester, and the puzzle `logPrefix` it emits, which must end ON a decision
       * frame) is inert without these. The suite pins the split. */
      p1Log: this.sideLog.p1.slice(),
      p2Log: this.sideLog.p2.slice(),
      p1Choices: this.choices.p1.slice(),
      p2Choices: this.choices.p2.slice(),
      swingTurn: computeSwingTurn(this.fullLog),
      timedOut: this.timedOut,
      aborted: this.aborted,
      reason: this.reason || (this.ended ? 'ended' : 'streamEnd'),
      errors: this.errors.slice(),
      substitutions: this.substitutions.slice(),
      seed: this.seed.slice(),
      format: this.format,
      maxTurns: this.maxTurns
    };
  }
}

/**
 * One-call convenience for the orchestrator and the suite: validate nothing, drive everything,
 * always hand back a report. A construction failure (illegal packed string, missing sim) is the
 * caller's to see, so it throws rather than being flattened into a tie.
 */
async function playBattle(options) {
  options = options || {};
  const runner = new HeadlessBattleRunner(options.format || DEFAULT_FORMAT, options);
  runner.initBattle(options.p1Team, options.p2Team, options.seed === undefined ? null : options.seed);
  try {
    return await runner.runGame(options.p1Agent, options.p2Agent, options.maxTurns);
  } finally {
    runner.close();
  }
}

module.exports = {
  HeadlessBattleRunner: HeadlessBattleRunner,
  DEFAULT_FORMAT: DEFAULT_FORMAT,
  DEFAULT_SEED: DEFAULT_SEED,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_TURNS: DEFAULT_MAX_TURNS,
  MAX_FALLBACKS: MAX_FALLBACKS,
  firstLegalChoice: firstLegalChoice,
  normalizeChoice: normalizeChoice,
  choiceLadder: choiceLadder,
  computeSwingTurn: computeSwingTurn,
  parseHpPercent: parseHpPercent,
  normalizeSeed: normalizeSeed,
  loadSim: loadSim,
  playBattle: playBattle
};
HeadlessBattleRunner.firstLegalChoice = firstLegalChoice;
HeadlessBattleRunner.normalizeChoice = normalizeChoice;
HeadlessBattleRunner.computeSwingTurn = computeSwingTurn;

/* ------------------------------------------------------------------- self-check */

if (require.main === module) {
  const PASTE = [
    'Great Tusk @ Choice Scarf', 'Ability: Protosynthesis', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- Headlong Rush', '- Close Combat', '- Ice Spinner', '- Rapid Spin', '',
    'Slowking-Galar @ Assault Vest', 'Ability: Regenerator', 'EVs: 252 HP / 4 SpA / 252 SpD', 'Sassy Nature', 'IVs: 0 Spe',
    '- Future Sight', '- Scald', '- Sludge Bomb', '- Flamethrower'
  ].join('\n');
  const sim = loadSim();
  const sets = sim.Teams.import(PASTE);
  const legality = new sim.TeamValidator(DEFAULT_FORMAT).validateTeam(sets);
  const packed = sim.Teams.pack(sets);
  console.log('legality:', legality === null ? 'legal' : JSON.stringify(legality));
  console.log('packed sets:', packed.split(']').length, '| format:', DEFAULT_FORMAT);
  const greedy = {
    name: 'greedy',
    chooseAction: function (request) { return firstLegalChoice(request); }
  };
  const runner = new HeadlessBattleRunner(DEFAULT_FORMAT, { timeoutMs: 20000, name1: 'Tactician', name2: 'Adversary' });
  runner.initBattle(packed, packed, 2024);
  runner.runGame(greedy, greedy, 40).then(function (report) {
    console.log('winner:', report.winner, '| turns:', report.turnCount, '| swingTurn:', report.swingTurn);
    console.log('p1 choices:', report.p1Choices.length, '| p2 choices:', report.p2Choices.length, '| log lines:', report.fullLog.length);
    console.log('seed:', JSON.stringify(report.seed), '| reason:', report.reason, '| timedOut:', report.timedOut, '| aborted:', report.aborted);
    const invalid = report.errors.filter(function (l) { return l.indexOf('[Invalid choice]') !== -1; });
    console.log('invalid-choice errors:', invalid.length, '| substitutions:', report.substitutions.length);
    console.log('first log line:', report.fullLog[0] || '(none)', '| winner line:', report.fullLog.filter(function (l) { return l.indexOf('|win|') === 0 || l.indexOf('|tie|') === 0; })[0] || '(none)');
    const ok = report.fullLog.length > 0 && report.p1Choices.length > 0 && report.seed.length === 4 &&
      typeof report.winner === 'string' && (report.reason === 'win' || report.reason === 'tie' || report.aborted || report.timedOut);
    console.log(ok ? 'SELF-CHECK OK' : 'SELF-CHECK FAILED');
    process.exit(ok ? 0 : 1);
  }).catch(function (e) {
    console.error('SELF-CHECK THREW:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
