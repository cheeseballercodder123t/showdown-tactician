/* Showdown Tactician — tools/headless_arena/engine_bridge.js
 *
 * WHY THIS EXISTS
 *   Every arena component needs the same two things, and neither is obvious from the outside:
 *
 *     1. The extension's decision engine, loaded EXACTLY the way the suites load it. The engine
 *        is a set of classic scripts that expect a content-script world, so it only runs inside
 *        the `vm` sandbox that `tests/harness.js` builds. Loading it any other way (a bare
 *        `require`) would test a different program than the one that ships.
 *
 *     2. A translation from a Showdown protocol frame into a legal @pkmn/sim choice string. The
 *        engine ranks LINES (`{kind:'move', name:'Headlong Rush', moveId:'headlongrush'}`,
 *        `{kind:'switch', name:'Great Tusk', targetId:'greattusk'}`), while the sim wants
 *        `move headlongrush` / `switch Great Tusk`. It also wants a bare choice: see the note on
 *        `players.pX.write()` below.
 *
 * THREE FACTS THIS FILE ENCODES, ALL VERIFIED AGAINST @pkmn/sim 0.10.11
 *
 *   (a) `[Gen 9] National Dex OU` has no format id of its own in the sim. The OU-tier National
 *       Dex format is `gen9nationaldex` (its banlist is the ND OU banlist and every lower ND
 *       tier is defined as `ruleset: ['[Gen 9] National Dex']` plus bans). So `SIM_FORMAT_ID`
 *       is what the arena runs, while the engine keeps reading the client's display label
 *       `[Gen 9] National Dex OU` — the engine matches on the label, not on the id.
 *   (b) `players.p1.write(x)` already prefixes `>p1 `. Writing `>p1 move 1` yields
 *       `|error|[Invalid choice] Unrecognized choice: >p1 move 1`. Choices are written BARE.
 *   (c) Team preview is ON (the first request carries `teamPreview: true`), and the order must
 *       contain exactly one digit per team member: a three-Pokemon team takes `team 123`.
 *
 * ENGINE ENTRY POINT
 *   `new ST.TacticianBoot({doc}).handleLine(rawLine)` returns the RANKED ACTIONS when the line
 *   was a `|request|`, and otherwise the protocol event. Feed it the lines of the side you are
 *   driving (a player stream carries the public log plus that side's own request, which is
 *   exactly what a real client sees) and read the array it hands back.
 *
 * THE CLIENT FRAMES THIS FILE EMULATES (and why the arena was measuring a different engine)
 *   A real client emits three things that a raw @pkmn/sim player stream does not, and the engine
 *   reads all three. Without them three tiers in the ablation table could not be priced at all,
 *   and one of them (`clock`, which SHIPS ON) was silently inert, so the arena was scoring an
 *   engine with the clock disabled:
 *
 *     1. `|stacc|<moveid>|<accuracy>` — src/injected.js forwards the client's own dex accuracy for
 *        every move on the roster. This table is the ONLY input `laplace.volatility` acts on (see
 *        `LaplaceEngine._accuracyOf`), and `laplace.comeback` scales nothing but that charge, so
 *        with an empty table both tiers are provably 0 and their rows are flat for a harness
 *        reason, not a policy reason. `_emitAccuracy()` below forwards the same frame from the
 *        sim's dex, which is the same data the client fetches.
 *     2. `/choose <choice>` tagged `kind === 'send'` — our own outgoing click. `OpponentClock._close`
 *        returns early unless an outgoing line set `mySubmitTs`, so with no such line the clock's
 *        history stays empty, its label stays `unknown`, and `switchPrior.unknown` of 1.0 is
 *        exactly what `clock.enabled = false` does. `noteOutgoing()` says it.
 *     3. `|player|pX|Name|avatar|RATING` — carried by `>player`'s `rating` field (`battle.js` emits
 *        `options.rating || ''`). `clock.ratingBands` reads it; the sim emits an empty field unless
 *        a rating is supplied, so the band is inert by omission, not by design.
 *
 *   The three are emitted only as far as the engine can read them, and each is a NO-OP when its
 *   input is unavailable: no sim means no accuracy frame (the previous behaviour), and an
 *   unrated player means no rating. Nothing here invents a value the protocol did not carry.
 *
 * Run the self-check with:  node tools/headless_arena/engine_bridge.js
 */
'use strict';

const path = require('path');
/* The input-population assertion: every session's engine is WATCHED, so a `--set` whose channel
 * never carries anything is refused by run_arena instead of being reported as a flat row. */
const HI = require('../harness_inputs.js');

const HARNESS_PATH = path.join(__dirname, '..', '..', 'tests', 'harness.js');

/* The label the engine's state manager keys its format support off of. */
const ENGINE_FORMAT_NAME = '[Gen 9] National Dex OU';
/* The one file whose evaluation must happen BEFORE any --set can reach a load-time reader. */
const CONFIG_FILE = 'src/config.js';
/* The actual ladder format the sim runs — see fact (a) in the header. */
const SIM_FORMAT_ID = 'gen9nationaldex';

let cachedHarness = null;
/* The FROZEN baseline sandbox, built only when a caller asks for it by name (`baseline: true`).
 * Kept in its own slot so a self-play mirror can hold the shipped config while the process has a
 * `--set` patch active — see the baseline branch in loadHarness. */
let cachedBaseline = null;

/**
 * Load the engine sandbox once per process. `setInterval` is stubbed because content.js boots on
 * the harness's stubbed hostname and starts a 2.5 s heartbeat, which would keep a battle script
 * alive forever (the suites stub it the same way, for the same reason).
 *
 * `options.setArgs` + `options.applyPatch` — a config patch to apply WHILE the sandbox is being
 * built, immediately after src/config.js is evaluated and before every module that captures its
 * tunables at load time (src/set_pruner.js reads `pruner.*` into module constants; the ability
 * deduction switches are among them). Applying the same patch after loadAll() returns updates the
 * config OBJECT but leaves those constants stale, which turns a real flag into a measurement of
 * nothing — the exact failure a benchmark must not have. The applied-flag echo is returned so a
 * caller can still prove the patch landed.
 *
 * The cache is process-wide and keyed on nothing: the arena applies ONE patch before any session
 * is constructed, and every later session (including the ones that call loadHarness() with no
 * options) must see that same patched sandbox.
 */
function loadHarness(options) {
  const opts = options || {};
  const setArgs = Array.isArray(opts.setArgs) ? opts.setArgs : null;
  const applyPatch = typeof opts.applyPatch === 'function' ? opts.applyPatch : null;
  const wantsPatch = !!(setArgs && setArgs.length);
  if (wantsPatch && !applyPatch) {
    throw new Error('engine_bridge.loadHarness: setArgs were given without an applyPatch function — ' +
      'refusing to build a sandbox that would look patched while measuring the shipped config');
  }
  /* A FROZEN BASELINE, requested EXPLICITLY.
   *
   * Self-play needs the SHIPPED engine even while the process has a config patch active: a variant
   * is measured against the baseline, so a mirror that shared the patch would be tested against
   * itself and every variant's effect would cancel. This is therefore the ONE way to get an
   * unpatched sandbox while a patch is live, and it is a deliberate, named request rather than the
   * accidental fresh load the guard below refuses. It gets its own cache slot, built with no
   * setArgs at all, so it can never overwrite the patched one. */
  if (opts.baseline) {
    if (wantsPatch) {
      throw new Error('engine_bridge.loadHarness: `baseline` and `setArgs` are mutually exclusive — ' +
        'a baseline IS the shipped config, so patching it is a contradiction, not a request');
    }
    if (cachedBaseline) return cachedBaseline;
    const harness = require(HARNESS_PATH);
    const baseOpts = opts.harnessOpts ? Object.assign({}, opts.harnessOpts) : {};
    const sandbox = harness.loadAll({
      setInterval: function () { return 0; },
      clearInterval: function () { }
    }, baseOpts);
    const bST = sandbox.ST;
    if (!bST || !bST.TacticianBoot) {
      throw new Error('engine_bridge: the baseline harness loaded but ST.TacticianBoot is missing — ' +
        'the engine manifest order in tests/harness.js no longer exposes the boot class');
    }
    cachedBaseline = { harness: harness, sandbox: sandbox, ST: bST, appliedSets: null, signature: '' };
    return cachedBaseline;
  }

  const signature = wantsPatch ? JSON.stringify(setArgs) : '';
  /* A caller with NO patch is asking for "this process's sandbox", so it takes the cache whatever
   * that cache holds — which is how every session built after run_arena's patched load ends up
   * sharing the patched config. A caller that NAMES a patch must never be served a cache built
   * with a different one (its batch would silently be the wrong config), so a mismatch falls
   * through and rebuilds instead of returning. */
  if (cachedHarness && !opts.fresh) {
    if (!wantsPatch || cachedHarness.signature === signature) return cachedHarness;
  }
  /* The other half of the same trap: a fresh UNPATCHED build while a patch is active would replace
   * the cache and silently un-patch every later session in the process. Loud beats plausible. */
  if (opts.fresh && cachedHarness && cachedHarness.signature && !wantsPatch) {
    throw new Error('engine_bridge.loadHarness: refusing a fresh load with no setArgs while a config ' +
      'patch is active — pass the same patch back so the sandbox cannot be silently un-patched');
  }
  const harness = require(HARNESS_PATH);
  let appliedSets = null;
  const loadOpts = opts.harnessOpts ? Object.assign({}, opts.harnessOpts) : {};
  if (wantsPatch) {
    loadOpts.afterEach = function (sandbox, rel) {
      if (rel === CONFIG_FILE && sandbox && sandbox.ST && sandbox.ST.CONFIG) {
        appliedSets = applyPatch(sandbox.ST, setArgs);
      }
    };
  }
  const sandbox = harness.loadAll({
    setInterval: function () { return 0; },
    clearInterval: function () { }
  }, loadOpts);
  const ST = sandbox.ST;
  if (!ST || !ST.TacticianBoot) {
    throw new Error('engine_bridge: the harness loaded but ST.TacticianBoot is missing — the ' +
      'engine manifest order in tests/harness.js no longer exposes the boot class');
  }
  cachedHarness = { harness: harness, sandbox: sandbox, ST: ST, appliedSets: appliedSets, signature: signature };
  return cachedHarness;
}

/** @pkmn/sim, required lazily so the bridge can be used by docs tooling without it. */
function loadSim() {
  return require('@pkmn/sim');
}

/* --------------------------------------------------------------- client telemetry */

/**
 * The move table the CLIENT would read. In a browser this is the page's own dex; here it is the
 * sim's, which is the same data (@pkmn/sim vendors the Showdown dex, `accuracy` and the `true`
 * that means "cannot miss" included). Resolved lazily and cached, so the bridge keeps loading in
 * a checkout with no devDependencies — a missing sim is "no telemetry", not a throw.
 */
let cachedMoveDex = undefined;
function clientMoveDex() {
  if (cachedMoveDex !== undefined) return cachedMoveDex;
  cachedMoveDex = null;
  try {
    const sim = loadSim();
    if (sim && sim.Dex && sim.Dex.moves && typeof sim.Dex.moves.get === 'function') cachedMoveDex = sim.Dex.moves;
  } catch (e) { cachedMoveDex = null; }
  return cachedMoveDex;
}

/**
 * Every move id a `|request|` makes visible: the active body's own menu plus the whole roster.
 * This is the set src/injected.js walks (`roster[i].moveSlots`) when it decides what to forward.
 */
function legalMoveIds(request) {
  const ids = [];
  const seen = Object.create(null);
  const push = function (id) {
    const key = String(id || '').toLowerCase();
    if (!key || seen[key]) return;
    seen[key] = true;
    ids.push(key);
  };
  const active = (request && request.active) || [];
  for (let i = 0; i < active.length; i++) {
    const moves = (active[i] && active[i].moves) || [];
    for (let j = 0; j < moves.length; j++) if (moves[j] && moves[j].id) push(moves[j].id);
  }
  const roster = (request && request.side && request.side.pokemon) || [];
  for (let i = 0; i < roster.length; i++) {
    const moves = (roster[i] && roster[i].moves) || [];
    for (let j = 0; j < moves.length; j++) push(moves[j]);
  }
  return ids;
}

/**
 * The `|stacc|<moveid>|<accuracy>` frames src/injected.js emits from the client's own dex, so the
 * arena's engine reads the accuracy table a browser build reads. Returns [] when the dex can't be
 * resolved or nothing is known, which is exactly the old behaviour — never a fabricated accuracy.
 * A numeric 0 is skipped for the same reason the parser skips it (there is no such roll).
 */
function accuracyLines(request) {
  const dex = clientMoveDex();
  if (!dex) return [];
  const ids = legalMoveIds(request);
  const lines = [];
  for (let i = 0; i < ids.length; i++) {
    const move = dex.get(ids[i]);
    if (!move || move.exists === false) continue;
    const acc = move.accuracy;
    if (!(acc === true || (typeof acc === 'number' && isFinite(acc) && acc > 0))) continue;
    lines.push('|stacc|' + ids[i] + '|' + acc);
  }
  return lines;
}

/* --------------------------------------------------------------------- actions */

/**
 * Translate one ranked line into a sim choice. Returns null for a line whose kind we cannot map.
 * `moveId` is preferred over `name` for moves because the sim matches on id; `name` is preferred
 * for switches because a species name is unambiguous while `switchSlot` may be unset.
 */
function choiceForRanked(entry) {
  if (!entry || !entry.kind) return null;
  if (entry.kind === 'move') {
    const id = entry.moveId || (entry.name ? String(entry.name).toLowerCase().replace(/[^a-z0-9]/g, '') : '');
    if (!id) return null;
    return 'move ' + id;
  }
  if (entry.kind === 'switch') {
    if (entry.name) return 'switch ' + entry.name;
    if (typeof entry.switchSlot === 'number' && entry.switchSlot > 0) return 'switch ' + entry.switchSlot;
    if (entry.targetId) return 'switch ' + entry.targetId;
    return null;
  }
  return null;
}

/** The team-preview order: one digit per team member, in the order we want to lead with. */
function teamPreviewOrder(request, preferredIndex) {
  const mons = (request && request.side && request.side.pokemon) || [];
  const order = mons.map(function (_, i) { return i + 1; });
  if (typeof preferredIndex === 'number' && preferredIndex > 0 && preferredIndex <= order.length) {
    const at = order.indexOf(preferredIndex);
    if (at > 0) { order.splice(at, 1); order.unshift(preferredIndex); }
  }
  return 'team ' + order.join('');
}

/**
 * A single engine-backed decision session: one boot object, one battle, one team.
 * It is deliberately thin — it feeds lines and hands back the engine's own ranking, and it does
 * not invent actions when the engine refuses to (an empty ranking is a fact worth surfacing).
 */
class EngineSession {
  constructor(options) {
    options = options || {};
    this.name = options.name || 'Tactician';
    this.errors = [];
    this.requests = 0;
    this.evaluations = 0;
    /* `baseline: true` asks for the FROZEN shipped-config sandbox (see loadHarness), which is what
     * a self-play mirror needs so a patched run prices the variant against the real baseline. */
    const loaded = loadHarness(options.baseline ? { baseline: true } : (options.fresh ? { fresh: true } : null));
    this.ST = loaded.ST;
    const doc = options.doc || loaded.harness.createFakeDocument();
    this.boot = new this.ST.TacticianBoot({ doc: doc });
    /* The real pipeline owns the engine, so the watch goes on the engine it built rather than on a
     * decision call this bridge makes — the bridge only feeds lines. */
    this.inputs = HI.watch(this.boot.engine, this.ST.util);
    if (options.paste) this.setTeam(options.paste);
    if (this.boot.state && typeof this.boot.state.setFormat === 'function') {
      try { this.boot.state.setFormat(options.formatName || ENGINE_FORMAT_NAME); }
      catch (e) { this.errors.push('setFormat: ' + (e && e.message)); }
    }
    this.ranked = null;
    this.readout = null;
    /* The last accuracy frame forwarded, mirroring injected.js's `lastAccuracySignature`. */
    this._accuracySignature = null;
    /* The raw `|request|` line this session's ranking is the answer to (see feed). */
    this._rankedRequestLine = null;
  }

  /** Ingest the extension's own paste format. Throws with the parser's messages when it fails. */
  setTeam(paste) {
    const parsed = this.boot.parseTeam ? this.boot.parseTeam(paste) : null;
    const mons = (parsed && parsed.pokemon) || (this.boot.team && this.boot.team.pokemon) || [];
    if (!mons.length) {
      const messages = (parsed && (parsed.errors || []).concat(parsed.warnings || [])) || [];
      throw new Error('engine_bridge: the paste produced no Pokemon' +
        (messages.length ? ' (' + messages.join('; ') + ')' : ''));
    }
    this.team = mons;
    return mons;
  }

  /**
   * Feed one protocol line. Returns the ranked action array when the line opened a decision
   * window, otherwise undefined. Never throws: a hostile line becomes an entry in `errors`.
   *
   * `kind` is the live injector's own tag ('send' for our outgoing /choose, 'recv'/'poll' for the
   * stream) and is passed through untouched, because the opponent clock's whole estimator keys off
   * it — that is the only difference between a line the engine acted on and one it merely saw.
   */
  feed(line, kind) {
    if (!line) return undefined;
    const isRequest = typeof line === 'string' && line.lastIndexOf('|request|', 0) === 0;
    if (isRequest) this._emitAccuracy(line);
    let out;
    try {
      out = this.boot.handleLine(line, kind);
    } catch (e) {
      this.errors.push('handleLine: ' + (e && e.message));
      return undefined;
    }
    if (/^\|request\|/.test(line)) this.requests++;
    if (Array.isArray(out) && out.length && out[0] && out[0].kind) {
      this.ranked = out;
      this.evaluations++;
      this.readout = this.boot.pendingReadout || (this.boot.engine && this.boot.engine.lastReadout) || null;
      if (isRequest) this._rankedRequestLine = String(line);
      return out;
    }
    /* A DECISION FRAME THE ENGINE DID NOT ANSWER, WHICH IS NOT THE FRAME THE RANKING ANSWERS,
     * CLEARS THE RANKING instead of leaving it in place. `topChoice()` is this session's answer to
     * the request it was just handed, and a ranking computed for an EARLIER window is not an
     * answer to this one: it describes a board that has moved on, so it can offer the body that
     * has since become the active (or fainted) one, and a driver that trusts it writes a choice
     * the sim rejects. Surface the refusal instead — `topChoice() === null` already means "the
     * engine ranked nothing" everywhere else in this file, and the caller's fallback ladder
     * produces a LEGAL choice, while a stale line does not.
     *
     * The exception is a re-delivery of the SAME frame: the sim re-sends a byte-identical request
     * after `|error|[Invalid choice]`, and a reconnect replays one. The engine's own latch answers
     * that with an empty array on purpose, and the ranking already held IS the answer to that exact
     * window — so it is kept. The comparison is on the raw line, which is protocol data, not engine
     * state: no second implementation of the engine's window identity lives here. */
    if (isRequest && String(line) !== this._rankedRequestLine) {
      this.ranked = null;
      this.readout = null;
    }
    return undefined;
  }

  /**
   * Forward the accuracy frame the client would forward, immediately BEFORE the request is parsed
   * — the order a real client's log carries it in. Deduped on the forwarded lines, exactly as
   * injected.js dedupes on the visible ids, so a 100-turn battle sends the table once per real
   * change rather than once per turn.
   */
  _emitAccuracy(requestLine) {
    let request = null;
    try { request = JSON.parse(requestLine.slice('|request|'.length)); } catch (e) { return; }
    const lines = accuracyLines(request);
    if (!lines.length) return;
    const signature = lines.join(';');
    if (signature === this._accuracySignature) return;
    this._accuracySignature = signature;
    for (let i = 0; i < lines.length; i++) this.feed(lines[i]);
  }

  /**
   * Our own outgoing choice, in the form the client's injector forwards it: `kind === 'send'`.
   * A driver that answers the sim directly — as the arena does — must say so here, or the clock
   * can never leave `unknown` and neither `clock.enabled` nor `clock.ratingBands` can be priced.
   * A leading `>p1 `/`>p2 ` is stripped, because choices on a player stream are bare (fact (b)).
   */
  noteOutgoing(choice) {
    if (!choice || typeof choice !== 'string') return false;
    const bare = choice.replace(/^>[^\s]+\s+/, '').trim();
    if (!bare) return false;
    this.feed('/choose ' + bare, 'send');
    return true;
  }

  /**
   * Declare the opponent's deliberation for this session (see OpponentClock.declare). The arena's
   * two players share one event loop, so the measured lead is ~0 ms on every turn and the clock
   * would label all of them 'auto' — 0.25, below switchKeepThreshold, which DELETES the opponent's
   * switch replies from the matrix for the whole battle. Declaring 'normal' is the identity, so the
   * baseline measures the engine rather than the absence of a network.
   */
  declareOpponentDeliberation(label) {
    const clock = this.boot && this.boot.clock;
    if (!clock || typeof clock.declare !== 'function') return false;
    clock.declare(label);
    return true;
  }

  /** Feed many lines; the last decision window seen wins. */
  feedAll(lines) {
    let ranked;
    for (let i = 0; i < (lines || []).length; i++) {
      const got = this.feed(lines[i]);
      if (got) ranked = got;
    }
    return ranked;
  }

  /** The engine's own scalar read of the position: its best line's payoff, or null. */
  bestScore() {
    const readout = this.readout;
    if (readout && readout.optimal && typeof readout.optimal.score === 'number') return readout.optimal.score;
    const ranked = this.ranked;
    if (ranked) {
      for (let i = 0; i < ranked.length; i++) {
        if (!ranked[i].isVetoed && typeof ranked[i].score === 'number') return ranked[i].score;
      }
    }
    return null;
  }

  /** The engine's ranking as a de-duplicated choice ladder, best first. */
  choiceLadder(limit) {
    const ranked = this.ranked || [];
    const out = [];
    for (let i = 0; i < ranked.length; i++) {
      if (ranked[i].isVetoed) continue;
      const c = choiceForRanked(ranked[i]);
      if (c && out.indexOf(c) === -1) out.push(c);
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  /** The engine's top line as a sim choice, or null when it refused to rank anything. */
  topChoice() {
    const ladder = this.choiceLadder(1);
    return ladder.length ? ladder[0] : null;
  }

  /** Every line the pipeline recorded as an error, for the arena's report. */
  pipelineErrors() {
    const stats = this.boot.stats || {};
    return (this.errors || []).concat((stats.errors || []).map(function (e) {
      return typeof e === 'string' ? e : (e && e.message) || JSON.stringify(e);
    }));
  }
}

function createSession(options) {
  return new EngineSession(options);
}

module.exports = {
  ENGINE_FORMAT_NAME: ENGINE_FORMAT_NAME,
  SIM_FORMAT_ID: SIM_FORMAT_ID,
  loadHarness: loadHarness,
  loadSim: loadSim,
  createSession: createSession,
  EngineSession: EngineSession,
  choiceForRanked: choiceForRanked,
  teamPreviewOrder: teamPreviewOrder
};

/* ------------------------------------------------------------------- self-check */

if (require.main === module) {
  const paste = [
    'Great Tusk @ Choice Scarf', 'Ability: Protosynthesis', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- Headlong Rush', '- Close Combat', '- Ice Spinner', '- Rapid Spin', '',
    'Slowking-Galar @ Assault Vest', 'Ability: Regenerator', 'EVs: 252 HP / 4 SpA / 252 SpD', 'Sassy Nature',
    '- Future Sight', '- Scald', '- Sludge Bomb', '- Flamethrower'
  ].join('\n');
  const session = createSession({ paste: paste });
  console.log('engine format:', ENGINE_FORMAT_NAME, '| sim format:', SIM_FORMAT_ID);
  console.log('team size:', session.team.length, '| boot wired:', !!(session.boot.parser && session.boot.state && session.boot.engine));
  session.feed('|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100');
  session.feed('|switch|p2a: Iron Valiant|Iron Valiant, L50, F|100/100');
  session.feed('|turn|1');
  const req = JSON.stringify({
    side: { id: 'p1', name: 'Tactician', pokemon: [{ ident: 'p1: Great Tusk', details: 'Great Tusk, L50, M', condition: '100/100', active: true, moves: ['headlongrush'] }] },
    active: [{ moves: [{ move: 'Headlong Rush', id: 'headlongrush', pp: 16, maxpp: 16, target: 'normal' }, { move: 'Close Combat', id: 'closecombat', pp: 8, maxpp: 8, target: 'normal' },
      { move: 'Focus Blast', id: 'focusblast', pp: 8, maxpp: 8, target: 'normal' }, { move: 'Rapid Spin', id: 'rapidspin', pp: 64, maxpp: 64, target: 'normal' }] }],
    rqid: 1
  });
  const ranked = session.feed('|request|' + req);
  console.log('ranked lines:', Array.isArray(ranked) ? ranked.length : 0, '| top:', session.topChoice(), '| bestScore:', session.bestScore());
  console.log('pipeline errors:', JSON.stringify(session.pipelineErrors()));
  console.log('sample:'); console.log(JSON.stringify(session.ranked && session.ranked.slice(0, 4), null, 1));
  /* The three client frames, read back off the engine: the accuracy table the volatility charge
   * needs, the clock that only our own outgoing /choose can move, and the rating the band reads. */
  const board = session.boot.state && session.boot.state.state;
  const acc = (board && board.moveAccuracy) || {};
  const accIds = Object.keys(acc);
  console.log('|stacc| forwarded for', accIds.length, 'move(s):', JSON.stringify(accIds.slice(0, 8)));
  console.log('  Focus Blast accuracy the engine now holds:', acc.focusblast, '(70 = chargeable; undefined = the old blind arena)');
  const engine = session.boot.engine;
  const charge = engine && typeof engine._volatilityDelta === 'function'
    ? engine._volatilityDelta({ kind: 'move', name: 'Focus Blast', moveId: 'focusblast' }, board, null, 100)
    : null;
  console.log('  volatility charge on Focus Blast:', charge && charge.penalty, '|', charge && charge.why);
  session.noteOutgoing('move headlongrush'); session.feed('|turn|2');
  session.noteOutgoing('move headlongrush'); session.feed('|turn|3');
  const clockSnap = session.boot.clock ? session.boot.clock.snapshot() : null;
  console.log('clock after our own /choose lines:', JSON.stringify(clockSnap && {
    samples: clockSnap.samples, floorMs: clockSnap.floorMs, label: clockSnap.label, switchFactor: clockSnap.switchFactor
  }));
  const expected0 = /^Great Tusk$/;
  console.log('team preview order:', teamPreviewOrder({ side: { pokemon: [{}, {}, {}] } }, 2), '| first mon is Great Tusk:', expected0.test(session.team[0].species));
}
