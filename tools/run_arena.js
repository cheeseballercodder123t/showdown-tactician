#!/usr/bin/env node
/* Showdown Tactician — tools/run_arena.js
 *
 * WHY THIS EXISTS
 *   The suite proves the engine is *correct*; nothing proved it is *good*. This is the master
 *   runner for the headless adversarial league: it puts the extension's decision engine (always
 *   p1 — it is the subject under test) against adversarial personas (p2) inside the official
 *   @pkmn/sim engine, measures the result, and — on request — turns each loss into a permanent
 *   regression puzzle through the blunder harvester.
 *
 * WHAT IT ORCHESTRATES (all lazily required, so a missing sibling names itself instead of
 * crashing the whole repo):
 *   headless_arena/engine_bridge.js   the engine session + choice translation (this file's owner
 *                                     wrote it; it is the only module that may not be replaced)
 *   headless_arena/sim_runner.js      the BattleStream driver
 *   headless_arena/teams.js           sample teams + legality validation
 *   headless_arena/league_agents.js   the three adversarial personas
 *   headless_arena/replay_splicer.js  crucible splicing out of real replay logs
 *   headless_arena/mutator.js         adversarial set fuzzing
 *   headless_arena/blunder_harvester.js  loss -> puzzle, appended to tests/tactical_puzzles.js
 *
 * VERIFIED FACTS THIS FILE RELIES ON (@pkmn/sim 0.10.11, measured in this repo)
 *   - The sim format id is `gen9nationaldex`, which IS [Gen 9] National Dex OU; `test_log.txt`'s
 *     `|tier|[Gen 9] National Dex` confirms the naming. `gen9nationaldexou` does not exist.
 *   - Tera is banned in this format (Terastal Clause), so nothing here asks for it.
 *   - Choices written to a player stream are BARE (`move 1`), never prefixed with `>p1 `.
 *
 * HONESTY RULES THIS FILE FOLLOWS
 *   - A battle that throws is counted, printed and skipped; it never kills the run.
 *   - The engine's own refusals are reported, not hidden: an empty ranking is recorded as
 *     `engineEmptyRankings`, and the engine's pipeline errors are surfaced in the summary.
 *   - Crucible splicing reports its fidelity; when a splice cannot be used the run falls back to
 *     a full battle and says so instead of pretending the splice happened.
 *
 * Usage: node tools/run_arena.js [options]      (see --help)
 * Self-check: node tools/run_arena.js --battles 2 --agent anchor --mode full --seed 7
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ARENA_DIR = path.join(__dirname, 'headless_arena');
const PUZZLE_FILE = path.join(ROOT, 'tests', 'tactical_puzzles.js');
const DEFAULT_REPLAY = path.join(ROOT, 'test_log.txt');
const DEFAULT_SEED = 1337;
const MUTATION_RATE = 0.10;

const PERSONAS = [
  { id: 'anchor', label: 'Anchor', klass: 'StandardMetaAnchor', teamKey: 'hazardStackBalance' },
  { id: 'exploiter', label: 'Exploiter', klass: 'AntiTrickRoomExploiter', teamKey: 'trickRoomSweep' },
  { id: 'chaos', label: 'Chaos', klass: 'LowLadderChaos', teamKey: 'ladderGimmick' },
  /* SELF-PLAY. The engine against a frozen copy of itself on the SAME team: the personas put the
   * baseline at 98.3 % with no losses, so the instrument can only show harm. A mirror sits near
   * 50 %, where a positive effect is measurable too (ATTEMPTS.md section H). `--league mirror` and
   * `--agent mirror` are the same switch. */
  { id: 'mirror', label: 'Mirror', klass: 'EngineMirrorAgent', teamKey: 'hazardStackBalance', mirror: true }
];
const AGENT_IDS = PERSONAS.map(function (p) { return p.id; });

const ANSI = {
  reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', cyan: '\u001b[36m'
};

class SetupError extends Error {
  constructor(message) { super(message); this.name = 'SetupError'; this.isSetup = true; }
}

/* ------------------------------------------------------------------------- args */

function printUsage(out) {
  const lines = [
    'Showdown Tactician — headless adversarial league arena',
    '',
    'Usage: node tools/run_arena.js [options]',
    '',
    '  --battles <n>        Total battles to simulate (default: 100)',
    '  --mode <m>           full  = every battle from turn 1',
    '                       crucible = splice real replays from turn 8+ (default)',
    '  --agent <a>          all | anchor | exploiter | chaos | mirror (default: all)',
    '  --league <a>         alias for --agent. `mirror` pits the engine against a FROZEN copy of',
    '                       itself on the same team (a ~50% baseline, where a positive effect is',
    '                       measurable; the three personas sit at 98.3% with no headroom left)',
    '  --rating1 <n>        Declared ladder rating for the ENGINE seat, published on the sim\'s',
    '                       `|player|` line (default: none, so the rating field stays empty)',
    '  --rating2 <n>        Declared rating for the PERSONA seat, overriding the band the persona',
    '                       itself declares (default: that persona\'s own)',
    '  --deliberation <d>   auto | normal | agonised — how fast the opponent is DECLARED to think.',
    '                       The arena cannot measure this (both players share one event loop, so',
    '                       latency is ~0 ms), so it must be stated; `normal` is the identity and the',
    '                       default. Setting `auto` prices the clock tier against a fast opponent.',
    '  --mutate             Fuzz the persona team (item/EV/coverage mutation)',
    '  --harvest            Synthesize a regression puzzle for every loss',
    '  --seed <n>           Base RNG seed (default: ' + DEFAULT_SEED + ')',
    '  --set <path=value>   Patch a config.js tunable for this run (repeatable). The path must',
    '                       ALREADY exist in config.js, so a typo fails loudly instead of',
    '                       measuring nothing. Scalars only: true/false/null/number/string.',
    '                       e.g. --set laplace.nash.enabled=false --set veto.redundantField=false',
    '  --max-turns <n>      Turn cap per battle (default: 100)',
    '  --replay <file>      Replay log for crucible mode (default: test_log.txt)',
    '  --mutate-rate <r>    Mutation probability per Pokemon (default: ' + MUTATION_RATE + ')',
    '  --json <file>        Write the full structured report as JSON',
    '  --quiet              Only print the summary',
    '  --help               This text',
    ''
  ];
  (out || console.log)(lines.join('\n'));
}

function parseArgs(argv) {
  const opts = {
    battles: 100, mode: 'crucible', agent: 'all', mutate: false, harvest: false,
    seed: DEFAULT_SEED, maxTurns: 100, replay: null, mutateRate: MUTATION_RATE,
    json: null, quiet: false, help: false, sets: [], rating1: null, rating2: null, deliberation: null
  };
  const need = function (flag, value) {
    if (value === undefined) throw new SetupError(flag + ' needs a value');
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--battles': opts.battles = Number(need(a, argv[++i])); break;
      case '--mode': opts.mode = String(need(a, argv[++i])).toLowerCase(); break;
      case '--agent': opts.agent = String(need(a, argv[++i])).toLowerCase(); break;
      case '--league': opts.agent = String(need(a, argv[++i])).toLowerCase(); break;
      case '--seed': opts.seed = Number(need(a, argv[++i])); break;
      case '--max-turns': opts.maxTurns = Number(need(a, argv[++i])); break;
      case '--replay': opts.replay = String(need(a, argv[++i])); break;
      case '--mutate-rate': opts.mutateRate = Number(need(a, argv[++i])); break;
      case '--rating1': opts.rating1 = Number(need(a, argv[++i])); break;
      case '--rating2': opts.rating2 = Number(need(a, argv[++i])); break;
      case '--deliberation': opts.deliberation = String(need(a, argv[++i])).toLowerCase(); break;
      case '--set': opts.sets.push(String(need(a, argv[++i]))); break;
      case '--json': opts.json = String(need(a, argv[++i])); break;
      case '--mutate': opts.mutate = true; break;
      case '--harvest': opts.harvest = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        throw new SetupError('unknown option ' + a + ' (try --help)');
    }
  }
  if (!Number.isFinite(opts.battles) || opts.battles < 0 || Math.floor(opts.battles) !== opts.battles) {
    throw new SetupError('--battles must be a non-negative integer');
  }
  /* A rating is a declared input, so a non-number is a setup error rather than a silently empty
   * field that would leave clock.ratingBands inert while the run looked fine. */
  ['rating1', 'rating2'].forEach(function (key) {
    if (opts[key] === null) return;
    if (!Number.isFinite(opts[key])) throw new SetupError('--' + key + ' must be a number');
  });
  /* A deliberation is a declared input too: an unknown value would be silently ignored by the clock
   * and the run would look neutral while the caller believed it was pricing a fast opponent. */
  if (opts.deliberation !== null && ['auto', 'normal', 'agonised'].indexOf(opts.deliberation) === -1) {
    throw new SetupError('--deliberation must be auto, normal or agonised');
  }
  if (opts.mode !== 'full' && opts.mode !== 'crucible') {
    throw new SetupError('--mode must be full or crucible');
  }
  if (AGENT_IDS.concat(['all']).indexOf(opts.agent) === -1) {
    throw new SetupError('--agent must be all, ' + AGENT_IDS.join(', ') +
      ' (--league is the same switch)');
  }
  if (!Number.isFinite(opts.seed)) throw new SetupError('--seed must be a number');
  if (!Number.isFinite(opts.maxTurns) || opts.maxTurns < 1) throw new SetupError('--max-turns must be >= 1');
  if (!Number.isFinite(opts.mutateRate) || opts.mutateRate < 0 || opts.mutateRate > 1) {
    throw new SetupError('--mutate-rate must be between 0 and 1');
  }
  return opts;
}

/* --------------------------------------------------------------- module loading */

function loadArenaModule(file, needFor) {
  const abs = path.join(ARENA_DIR, file);
  const rel = path.relative(ROOT, abs);
  if (!fs.existsSync(abs)) {
    throw new SetupError('missing arena module ' + rel + ' — needed for ' + needFor + '.');
  }
  try {
    return require(abs);
  } catch (e) {
    const hint = /MODULE_NOT_FOUND/.test(String(e && e.message)) && /@pkmn\/sim|@smogon\/calc/.test(String(e && e.message))
      ? ' (run `npm install` — @pkmn/sim is a devDependency)'
      : '';
    throw new SetupError('cannot load ' + rel + ' (' + needFor + '): ' + (e && e.message) + hint);
  }
}

/* ------------------------------------------------------------------ small utils */

function seedFor(base, index) {
  const b = (Number(base) || 0) >>> 0;
  const i = (index + 1) >>> 0;
  return [
    (b ^ Math.imul(i, 0x9e3779b1)) >>> 0,
    (Math.imul(b, 0x85ebca6b) ^ i) >>> 0,
    (i * 2654435761) >>> 0,
    (b + 0x5bf03635) >>> 0
  ];
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function pad(s, n, right) {
  s = String(s === undefined || s === null ? '' : s);
  while (s.length < n) s = right ? ' ' + s : s + ' ';
  return s;
}

function mean(values) {
  if (!values.length) return 0;
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  return total / values.length;
}

function distribute(total, buckets) {
  const out = [];
  const base = Math.floor(total / buckets);
  const rem = total % buckets;
  for (let i = 0; i < buckets; i++) out.push(base + (i < rem ? 1 : 0));
  return out;
}

/* -------------------------------------------------------------- config patching */

/**
 * Parse a `--set` value. Only the scalars config.js actually stores are inferred and anything
 * else stays a string, so `--set x=maybe` cannot silently become NaN or `0`.
 */
function parseConfigValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function formatConfigValue(v) {
  return v === null ? 'null' : (typeof v === 'string' ? JSON.stringify(v) : String(v));
}

/**
 * applyConfigPatch(ST, sets) -> [{ path, from, to }]
 *
 * WHY THE LEAF MUST ALREADY EXIST: a benchmark that toggles a MISSPELT flag measures nothing and
 * then reports it as "neutral", which is the worst possible failure for an ablation runner. So an
 * unknown path is a SetupError rather than a new key — config.js is the one place tunables live,
 * and a path that is not in it is a typo. The same goes for every intermediate section.
 */
function applyConfigPatch(ST, sets) {
  const config = ST && ST.CONFIG;
  if (!config) throw new SetupError('config.js is not loaded in the engine sandbox — cannot apply --set');
  const applied = [];
  (sets || []).forEach(function (entry) {
    const at = String(entry).indexOf('=');
    if (at <= 0) throw new SetupError('--set needs <path>=<value>, got "' + entry + '"');
    const path = String(entry).slice(0, at).trim();
    const value = parseConfigValue(String(entry).slice(at + 1).trim());
    const parts = path.split('.');
    let node = config;
    for (let i = 0; i < parts.length - 1; i++) {
      const prefix = parts.slice(0, i + 1).join('.');
      if (node[parts[i]] === undefined) throw new SetupError('--set ' + path + ': "' + prefix + '" is not in config.js');
      if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) {
        throw new SetupError('--set ' + path + ': "' + prefix + '" is a value, not a config section');
      }
      node = node[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    if (node[leaf] === undefined) throw new SetupError('--set ' + path + ': not in config.js (nothing to patch)');
    const from = node[leaf];
    node[leaf] = value;
    applied.push({ path: path, from: from, to: value });
  });
  return applied;
}

function latencyMs(t0) {
  if (typeof process.hrtime === 'function') {
    const d = process.hrtime(t0);
    return d[0] * 1000 + d[1] / 1e6;
  }
  return 0;
}

/* ------------------------------------------------------------- the engine agent */

/**
 * p1. Every line of p1's stream goes into one engine session (`feed`), and each `|request|`
 * frame is answered with the engine's own top line. Nothing here second-guesses the engine:
 * when it ranks nothing, this agent reports it and returns null so the driver can fall back to
 * a legal choice, and the empty ranking is counted for the report.
 */
function createEngineAgent(bridge, paste, options) {
  options = options || {};
  const session = bridge.createSession({ paste: paste, name: options.name || 'Tactician' });
  const stats = { fed: 0, observations: 0, requests: 0, emptyRankings: 0, fallbacks: 0, skippedForeignRequests: 0, resyncMisses: 0, errors: 0 };
  let watermark = 0;
  let lastFed = null;

  function feedLine(line) {
    if (!line) return;
    if (line.lastIndexOf('|request|', 0) === 0) {
      const req = parseJson(line.slice('|request|'.length));
      // The omniscient log carries both sides' requests; feeding the opponent's would make the
      // engine believe it is deciding for them. Only p1's own request window is ours.
      if (req && req.side && req.side.id && req.side.id !== 'p1') { stats.skippedForeignRequests++; return; }
    }
    try { session.feed(line); } catch (e) { stats.errors++; return; }
    stats.fed++;
    lastFed = line;
  }

  function feedNewLines(log) {
    if (!Array.isArray(log) || !log.length) return;
    if (watermark > 0 && log[watermark - 1] !== lastFed) {
      // The caller handed us a differently-shaped array (a side stream instead of the shared
      // log). Re-anchor on the last line we actually fed rather than replaying history: replaying
      // would double-count every event and corrupt the board.
      let at = -1;
      for (let i = log.length - 1; i >= 0; i--) { if (log[i] === lastFed) { at = i; break; } }
      if (at < 0) { stats.resyncMisses++; return; }
      watermark = at + 1;
    }
    while (watermark < log.length) feedLine(log[watermark++]);
  }

  function pick(prefix) {
    let top = null;
    try { top = session.topChoice(); } catch (e) { stats.errors++; return null; }
    if (top && top.lastIndexOf(prefix, 0) === 0) return top;
    let ladder = [];
    try { ladder = session.choiceLadder(8); } catch (e) { ladder = []; }
    for (let i = 0; i < ladder.length; i++) {
      if (ladder[i].lastIndexOf(prefix, 0) === 0) { if (top) stats.fallbacks++; return ladder[i]; }
    }
    return null;
  }

  /**
   * The one decision path: it returns the engine's own line and NEVER records the outgoing frame,
   * so `chooseAction` below stays the single place that says "we clicked this".
   */
  function decide(request, context) {
    try {
      const ctx = context || {};
      // If the driver calls observe(), it is already feeding us and the shared log would double
      // every event: trust the driver and stay out of its way.
      if (stats.observations === 0) feedNewLines(ctx.log);
      if (!request) return null;
      stats.requests++;
      if (request.teamPreview) return bridge.teamPreviewOrder(request);
      if (request.wait) return null;
      if (request.forceSwitch) {
        const choice = pick('switch ');
        if (choice) return choice;
        stats.emptyRankings++;
        return null;
      }
      if (request.active) {
        let top = null;
        try { top = session.topChoice(); } catch (e) { stats.errors++; }
        if (top) return top;
        stats.emptyRankings++;
        return null;
      }
      return null;
    } catch (e) {
      stats.errors++;
      return null;
    }
  }

  return {
    name: options.name || 'Tactician',
    engine: true,
    session: session,
    stats: stats,
    /** Some drivers push lines at the agent instead of passing a shared log. */
    observe: function (line) {
      stats.observations++;
      feedLine(line);
    },
    reset: function () { },
    /** The arena STATES the opponent's deliberation; see OpponentClock.declare. */
    declareOpponentDeliberation: function (label) {
      try { return session.declareOpponentDeliberation(label); } catch (e) { stats.errors++; return false; }
    },
    /**
     * The engine's own line, AND the outgoing `/choose` frame the client's injector would send.
     * That frame is the only thing that moves the opponent clock (OpponentClock._close returns early
     * unless an outgoing line set mySubmitTs), so without it the clock's history stays empty and
     * neither `clock.enabled` nor `clock.ratingBands` can be priced in the arena. It is recorded
     * here, at the moment we decide, which is when the client sends it.
     */
    chooseAction: function (request, context) {
      const choice = decide(request, context);
      if (choice) {
        try { session.noteOutgoing(choice); } catch (e) { stats.errors++; }
      }
      return choice;
    }
  };
}

/**
 * A view of the engine session that the blunder harvester can replay from scratch: it delegates
 * the session API and adds createFresh(), so the harvester can re-evaluate turn by turn without
 * fighting the live session's board.
 */
function harvestHandle(session, bridge, paste) {
  const handle = {
    session: session,
    createFresh: function () { return bridge.createSession({ paste: paste }); }
  };
  ['feed', 'feedAll', 'bestScore', 'choiceLadder', 'topChoice', 'pipelineErrors'].forEach(function (k) {
    if (typeof session[k] === 'function') handle[k] = session[k].bind(session);
  });
  ['ranked', 'readout', 'boot', 'team'].forEach(function (k) {
    Object.defineProperty(handle, k, { get: function () { return session[k]; }, enumerable: true });
  });
  return handle;
}

/* ------------------------------------------------------------------ team plumbing */

/**
 * Resolve a team for one slot and report the KEY actually used, so the summary names the team
 * that really played rather than the one we hoped for.
 */
function resolveTeam(teamsMod, key, fallbackText) {
  const samples = (teamsMod && teamsMod.SAMPLE_TEAMS) || {};
  if (fallbackText && typeof fallbackText === 'string' && fallbackText.trim()) {
    return { text: fallbackText, key: key + ' (from the agent)' };
  }
  if (samples[key]) return { text: samples[key], key: key };
  const keys = Object.keys(samples);
  if (!keys.length) return { text: null, key: 'none' };
  return { text: samples[keys[0]], key: keys[0] + ' (fallback)' };
}

function assertLegal(teamsMod, label, text, notes) {
  if (!text) throw new SetupError('no team available for ' + label + ' (teams.js SAMPLE_TEAMS is empty)');
  let messages = null;
  try { messages = teamsMod.validateTeam(text); }
  catch (e) { throw new SetupError('teams.js could not validate the ' + label + ' team: ' + (e && e.message)); }
  if (messages && messages.length) {
    throw new SetupError('the ' + label + ' team is illegal in National Dex OU: ' + messages.join('; '));
  }
  notes.push(label + ' team legal');
}

/* ------------------------------------------------------------------ the battle */

async function runOneBattle(ctx, personaId, index) {
  const t0 = process.hrtime();
  const seed = seedFor(ctx.baseSeed, index);
  const personaSpec = ctx.specs[personaId];
  const record = {
    index: index, persona: personaId, mode: ctx.mode, seed: seed,
    winner: 'tie', turnCount: 0, latencyMs: 0, fallback: false, error: null,
    swingTurn: null, engineEmptyRankings: 0, engineFallbacks: 0, enginePipelineErrors: 0,
    splicedTurn: null, fidelity: null, handoverReached: null, diverged: false, divergenceReason: null,
    // Why the crucible was skipped, when it was: this is a NOTE, not a failure — the battle below
    // falls back to a full game and may well be won, and counting that as an errored battle would
    // make the run look broken when it merely declined to splice.
    spliceNote: null,
    mutated: !!(ctx.personaTeams[personaId] && ctx.personaTeams[personaId].mutated)
  };

  /* The engine gets the PASTE, the sim gets the packed team. This is not cosmetic: the engine's
   * `parseTeam` reads a Pokepaste (that is what src/content.js hands it from storage), and given a
   * sim-packed string it parses ONE body whose species is the whole packed line. Measured before
   * this fix: `session.team.length === 1` and 48 turns of "Can't make choices: You sent choices for
   * 54 Pokemon" retries per battle against the anchor persona, each silently substituted by the
   * driver's fallback. The suite never caught it because tests/arena_check.js builds its session
   * from the paste — the same path a browser takes — while the arena passed the packed one. */
  const engineAgent = createEngineAgent(ctx.bridge, ctx.engineTeamText);
  let personaAgent = null;
  const personaTeam = ctx.personaTeams[personaId] || {};
  try {
    // Tell the persona which team is really playing (a mutated or fallback sample), so its own
    // bookkeeping — lead order, its notion of `team` — agrees with the sim instead of with the
    // default sample it would have assumed.
    personaAgent = new personaSpec.Klass({
      seed: seed[0], persona: personaId, teamName: personaSpec.teamKey, team: personaTeam.text
    });
  } catch (e) {
    record.error = 'persona construction failed: ' + (e && e.message);
    record.latencyMs = latencyMs(t0);
    return record;
  }
  if (personaAgent && typeof personaAgent.reset === 'function') {
    try { personaAgent.reset(); } catch (e) { /* a reset that throws must not kill the battle */ }
  }

  /* The opponent's DECLARED ladder rating. The sim publishes it as `|player|p2|Name|avatar|RATING`
   * and the engine turns that into state.opponentRating, which `clock.ratingBands` reads — so a
   * persona that declares a band makes that tier priceable, and one that does not leaves the band
   * inert exactly as before (ratingFactor() returns 1 by design when the rating is null). */
  /* `--rating2` pins one value for every persona; otherwise the persona's own declared band. */
  const personaDeclaredRating = (personaAgent && typeof personaAgent.rating === 'number') ? personaAgent.rating : null;
  const rating2 = (ctx.options.rating2 !== null && ctx.options.rating2 !== undefined)
    ? ctx.options.rating2
    /* A mirror has no ladder band of its own, so it borrows the ENGINE's declared rating: a
     * self-play matchup where one seat is rated and the other is not would put the two seats in
     * different `clock.ratingBands` worlds for no reason. */
    : (personaSpec.mirror ? ctx.options.rating1 : personaDeclaredRating);

  /* State the opponent's deliberation before the battle runs. The arena has no network, so the
   * clock's estimator would read every turn as 'auto' (0.25) and DELETE their switch replies from
   * the matrix for the whole game; the declaration replaces that artifact with a stated input, and
   * 'normal' is the identity. See OpponentClock.declare and tests/ablation_check.js section 7. */
  const deliberation = ctx.options.deliberation || (personaAgent && personaAgent.thinking) || 'normal';
  if (typeof engineAgent.declareOpponentDeliberation === 'function') {
    engineAgent.declareOpponentDeliberation(deliberation);
  }

  let report = null;
  if (ctx.mode === 'crucible' && ctx.crucible) {
    try {
      const result = await ctx.splicer.spliceAndResume(
        ctx.crucible.lines, ctx.crucible.turn, engineAgent, personaAgent,
        { teams: { p1: ctx.enginePacked, p2: ctx.personaPacked(personaId) }, seed: seed,
          maxTurns: ctx.options.maxTurns, rating1: ctx.options.rating1, rating2: rating2 }
      );
      // The splicer hands back the battle's MatchReport with its own fidelity report attached as
      // `.spliced`; accept a flat report too so either shape keeps working.
      const flat = result && result.winner ? result : (result && result.report) || null;
      const meta = (result && result.spliced) || (flat && flat.spliced) || null;
      record.handoverReached = meta ? meta.handoverReached !== false : null;
      // A splice whose playback never reached the handover turn is not a battle between our
      // agents at all: its winner would be the recorded human line. That is not a result, so it
      // falls back to a full battle instead of being counted as one.
      if (flat && flat.winner && record.handoverReached !== false) {
        report = flat;
        record.splicedTurn = (meta && meta.turn) || ctx.crucible.turn;
        record.fidelity = (meta && meta.fidelity) || null;
        record.diverged = !!(meta && meta.diverged);
        record.divergenceReason = (meta && meta.divergenceReason) || null;
      } else {
        record.spliceNote = 'splice produced no usable result' +
          (record.handoverReached === false ? ': the playback never reached the handover turn' : '') +
          (meta && meta.divergenceReason ? ': ' + meta.divergenceReason : '');
      }
    } catch (e) {
      record.spliceNote = 'splice failed: ' + (e && e.message);
    }
    if (!report) { record.fallback = true; ctx.fallbacks++; }
  }

  if (!report) {
    try {
      const runner = new ctx.Runner(ctx.formatId);
      runner.initBattle(ctx.enginePacked, ctx.personaPacked(personaId), seed,
        { rating1: ctx.options.rating1, rating2: rating2 });
      report = await runner.runGame(engineAgent, personaAgent, ctx.options.maxTurns);
    } catch (e) {
      record.error = 'battle failed: ' + (e && e.message);
      report = null;
    }
  }

  record.latencyMs = latencyMs(t0);
  if (report) {
    record.winner = report.winner || 'tie';
    record.turnCount = report.turnCount || 0;
    record.swingTurn = report.swingTurn === undefined ? null : report.swingTurn;
    record.timedOut = !!report.timedOut;
    record.aborted = !!report.aborted;
    record.logLines = (report.fullLog || []).length;
    record.battleErrors = (report.errors || []).length;
    /* How much attrition a battle actually had, counted from the omniscient log rather than
     * inferred. A game that runs to the turn cap with 4 of 12 bodies down is a STANDOFF — neither
     * side could break through — while one that caps with 10 down is something else entirely. The
     * ablation needs the distinction to say anything useful about a 100-turn tie, and counting
     * `|faint|` lines is the only way to get it without touching the sim's internals. */
    record.faints = (report.fullLog || []).filter(function (l) {
      return String(l).indexOf('|faint|') === 0;
    }).length;
  }
  record.engineEmptyRankings = engineAgent.stats.emptyRankings;
  record.engineFallbacks = engineAgent.stats.fallbacks;
  record.engineSkippedForeignRequests = engineAgent.stats.skippedForeignRequests;
  try { record.enginePipelineErrors = engineAgent.session.pipelineErrors().length; }
  catch (e) { record.enginePipelineErrors = 0; }
  /* The mirror's OWN refusals, on the persona seat, reported the same way the engine's are: an
   * empty ranking there is a fact about the mirror, not a battle the driver quietly won by
   * substitution. Absent for the three heuristic personas. */
  if (personaAgent && personaAgent.mirrorRequests !== undefined) {
    record.mirrorRequests = personaAgent.mirrorRequests;
    record.mirrorEmpty = personaAgent.mirrorEmpty;
    record.mirrorErrors = personaAgent.mirrorErrors;
  }

  // Loss -> permanent puzzle. The harvester decides whether the log contains a blunder it can
  // pin; a loss with no measurable drop is not a failure of this runner.
  if (ctx.options.harvest && ctx.harvester && report && record.winner === 'p2') {
    try {
      const analysis = ctx.harvester.analyzeLoss(report, harvestHandle(engineAgent.session, ctx.bridge, ctx.engineTeamText));
      if (analysis && analysis.blunderTurn) {
        const code = ctx.harvester.generatePuzzleCode(analysis);
        ctx.harvester.appendVaccineToFile(code, PUZZLE_FILE);
        record.harvestedPuzzle = 'AutoVaccine_Loss_turn' + analysis.blunderTurn;
        ctx.harvested++;
      } else {
        record.harvestedPuzzle = null;
      }
    } catch (e) {
      record.harvestError = (e && e.message) || String(e);
      ctx.harvestFailures++;
    }
  }
  return record;
}

/* ------------------------------------------------------------------- the report */

function emptyBucket() {
  return { battles: 0, wins: 0, losses: 0, ties: 0, turns: [], latency: [], errors: 0, harvested: 0, fallbacks: 0 };
}

function summarize(records, specs) {
  const perPersona = {};
  Object.keys(specs).forEach(function (id) { perPersona[id] = emptyBucket(); });
  const totals = { battles: 0, wins: 0, losses: 0, ties: 0, errors: 0, harvested: 0, fallbacks: 0, engineEmptyRankings: 0, enginePipelineErrors: 0, turns: [], latency: [] };
  records.forEach(function (r) {
    // A persona that never made it into `specs` must not be silently folded into another one's
    // record: create its bucket instead of borrowing someone else's.
    if (!perPersona[r.persona]) perPersona[r.persona] = emptyBucket();
    const bucket = perPersona[r.persona];
    bucket.battles++;
    if (r.error) { bucket.errors++; totals.errors++; }
    if (r.winner === 'p1') { bucket.wins++; totals.wins++; }
    else if (r.winner === 'p2') { bucket.losses++; totals.losses++; }
    else { bucket.ties++; totals.ties++; }
    bucket.turns.push(r.turnCount || 0);
    totals.turns.push(r.turnCount || 0);
    bucket.latency.push(r.latencyMs || 0);
    totals.latency.push(r.latencyMs || 0);
    if (r.harvestedPuzzle) { bucket.harvested++; totals.harvested++; }
    if (r.fallback) { bucket.fallbacks++; totals.fallbacks++; }
    totals.engineEmptyRankings += r.engineEmptyRankings || 0;
    totals.enginePipelineErrors += r.enginePipelineErrors || 0;
    totals.battles++;
  });
  Object.keys(perPersona).forEach(function (id) {
    const b = perPersona[id];
    b.winRate = b.battles ? b.wins / b.battles : 0;
    b.avgTurns = mean(b.turns);
    b.meanLatencyMs = mean(b.latency);
  });
  totals.winRate = totals.battles ? totals.wins / totals.battles : 0;
  totals.avgTurns = mean(totals.turns);
  totals.meanLatencyMs = mean(totals.latency);
  return { personas: perPersona, totals: totals };
}

function renderSummary(summary, ctx, options) {
  const color = ctx.useColor;
  const c = function (name, text) { return color ? ANSI[name] + text + ANSI.reset : text; };
  const rows = [];
  rows.push('  ' + pad('persona', 12) + pad('W', 5, true) + pad('L', 5, true) + pad('T', 5, true) +
    pad('win%', 8, true) + pad('avgTurns', 10, true) + pad('mean ms', 10, true) + pad('err', 5, true));
  Object.keys(summary.personas).forEach(function (id) {
    const b = summary.personas[id];
    if (!b.battles && !b.errors) return;
    rows.push('  ' + pad(id, 12) + pad(b.wins, 5, true) + pad(b.losses, 5, true) + pad(b.ties, 5, true) +
      pad((b.winRate * 100).toFixed(1) + '%', 8, true) + pad(b.avgTurns.toFixed(1), 10, true) +
      pad(b.meanLatencyMs.toFixed(1), 10, true) + pad(b.errors, 5, true));
  });
  const t = summary.totals;
  rows.push('  ' + c('bold', pad('TOTAL', 12) + pad(t.wins, 5, true) + pad(t.losses, 5, true) + pad(t.ties, 5, true) +
    pad((t.winRate * 100).toFixed(1) + '%', 8, true) + pad(t.avgTurns.toFixed(1), 10, true) +
    pad(t.meanLatencyMs.toFixed(1), 10, true) + pad(t.errors, 5, true)));

  console.log('');
  console.log(c('bold', '  === executive summary ==='));
  console.log(rows.join('\n'));
  console.log('');
  console.log('  mode: ' + options.mode + (ctx.mode !== options.mode ? c('yellow', ' (fell back to full)') : '') +
    ' | battles: ' + t.battles + ' | seed: ' + options.seed + ' | max turns: ' + options.maxTurns);
  console.log('  teams: engine=' + ctx.engineTeamKey + (options.mutate ? ', persona mutated at rate ' + options.mutateRate : ''));
  if (ctx.appliedSets && ctx.appliedSets.length) {
    console.log('  config patch: ' + ctx.appliedSets.map(function (s) {
      return s.path + '=' + formatConfigValue(s.to);
    }).join(', '));
  }
  if (ctx.crucible) {
    console.log('  crucible: ' + ctx.crucible.source + ' turn ' + ctx.crucible.turn + ' (' + ctx.crucible.reason + ')' +
      (t.fallbacks ? c('yellow', ' | ' + t.fallbacks + ' battle(s) fell back to full') : ''));
  } else if (options.mode === 'crucible') {
    console.log(c('yellow', '  crucible: unavailable — every battle ran from turn 1'));
  }
  console.log('  engine: empty rankings ' + t.engineEmptyRankings + ' | pipeline errors ' + t.enginePipelineErrors);
  console.log('  blunders harvested: ' + t.harvested + (options.harvest ? ' -> ' + path.relative(ROOT, PUZZLE_FILE) : ' (--harvest off)'));
  if (ctx.harvestFailures) console.log(c('yellow', '  harvest failures: ' + ctx.harvestFailures));
  if (t.errors) console.log(c('yellow', '  battles that errored: ' + t.errors + ' (counted, not fatal)'));
  console.log('');
}

/* ------------------------------------------------------------------------- main */

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { printUsage(); return 0; }

  const useColor = !options.quiet && !!process.stdout.isTTY;
  const notes = [];

  const bridge = loadArenaModule('engine_bridge.js', 'the engine session');
  // The config patch goes in BEFORE the first session is constructed, and for the modules that
  // capture their tunables while the sandbox is LOADED (src/set_pruner.js and its ability-deduction
  // switches) it must go in before those files are evaluated at all — so it is handed to
  // loadHarness, which applies it the moment src/config.js has run. Patching after the harness
  // returns would leave those constants stale and turn the flag into a measurement of nothing.
  const appliedSets = (options.sets && options.sets.length)
    ? (bridge.loadHarness({ setArgs: options.sets, applyPatch: applyConfigPatch }).appliedSets || [])
    : [];
  // A --set that did not reach the sandbox must be a SETUP ERROR. The echo is produced by the
  // mid-load hook, which is keyed on `src/config.js` still being the file its manifest entry names;
  // if that ever stopped matching, the run would otherwise ship a plausible report of the SHIPPED
  // config wearing a variant's label. The ablation runner checks the echo it reads back, and this is
  // the same check for a standalone `node tools/run_arena.js --set ...`.
  if (options.sets && options.sets.length && appliedSets.length !== options.sets.length) {
    throw new SetupError('applied ' + appliedSets.length + ' of ' + options.sets.length +
      ' config flags — refusing a run that would not measure what it claims');
  }
  appliedSets.forEach(function (s) {
    notes.push('config: ' + s.path + ' ' + formatConfigValue(s.from) + ' -> ' + formatConfigValue(s.to));
  });
  const teamsMod = loadArenaModule('teams.js', 'sample teams and legality validation');
  const simRunner = loadArenaModule('sim_runner.js', 'driving @pkmn/sim');
  const league = loadArenaModule('league_agents.js', 'the three adversarial personas');

  const Runner = simRunner.HeadlessBattleRunner || simRunner.HeadlessRunner;
  if (typeof Runner !== 'function') {
    throw new SetupError('sim_runner.js does not export a HeadlessBattleRunner class');
  }
  const formatId = teamsMod.SIM_FORMAT_ID || bridge.SIM_FORMAT_ID || 'gen9nationaldex';

  const selected = options.agent === 'all' ? PERSONAS.map(function (p) { return p.id; }) : [options.agent];
  const specs = {};
  selected.forEach(function (id) {
    const spec = PERSONAS.filter(function (p) { return p.id === id; })[0];
    const Klass = league[spec.klass];
    if (typeof Klass !== 'function') {
      throw new SetupError('league_agents.js does not export ' + spec.klass + ' (needed for --agent ' + id + ')');
    }
    specs[id] = { id: spec.id, label: spec.label, Klass: Klass, teamKey: spec.teamKey };
  });

  // ---- teams (validated before a single battle runs) --------------------------------
  const engineTeam = resolveTeam(teamsMod, 'hazardStackBalance', null);
  let enginePacked = null;
  try { enginePacked = teamsMod.toSimTeam(engineTeam.text); }
  catch (e) { throw new SetupError('teams.js could not pack the engine team: ' + (e && e.message)); }
  assertLegal(teamsMod, 'engine', engineTeam.text, notes);

  const mutator = options.mutate
    ? (function () {
      const mod = loadArenaModule('mutator.js', 'adversarial set mutation');
      const Klass = mod.SetMutator;
      if (typeof Klass !== 'function') throw new SetupError('mutator.js does not export SetMutator');
      return new Klass({ seed: options.seed });
    })()
    : null;

  const personaTeams = {};
  const personaPacked = {};
  Object.keys(specs).forEach(function (id) {
    const spec = specs[id];
    let probe = null;
    try { probe = new spec.Klass({ seed: options.seed }); } catch (e) { probe = null; }
    const resolved = resolveTeam(teamsMod, spec.teamKey, probe && probe.team);
    const baseText = resolved.text;
    if (!baseText) throw new SetupError('no team for persona ' + id);
    let text = baseText;
    let mutated = false;
    if (mutator) {
      try {
        const out = mutator.mutateTeam(baseText, options.mutateRate, { seed: options.seed });
        const packed = (out && typeof out === 'object') ? out.packed : out;
        const changes = (out && out.changes) || [];
        const rejected = (out && out.rejected) || [];
        if (out && out.inputErrors) {
          notes.push(id + ': the mutator refused to fuzz an illegal input (' + out.inputErrors.join('; ') + ')');
        }
        // "the fuzz did nothing" and "the fuzz tried and every mutation was rolled back" are
        // different findings, so only a real change counts as a mutated team.
        if (packed && changes.length) {
          text = packed;
          mutated = true;
          notes.push('mutated ' + id + ': ' + changes.length + ' change(s), ' + rejected.length + ' rejected for legality');
        } else if (packed) {
          notes.push('mutation produced no change for ' + id + ' (' + rejected.length + ' rolled back)');
        }
      } catch (e) {
        notes.push('mutation failed for ' + id + ': ' + (e && e.message) + ' (using the base team)');
      }
    }
    // A mutated team is already sim-packed; an unmutated sample is a paste and must be converted.
    let packed = null;
    try { packed = teamsMod.toSimTeam(text); }
    catch (e) { throw new SetupError('teams.js could not pack the ' + id + ' team: ' + (e && e.message)); }
    personaTeams[id] = { text: text, mutated: mutated, base: baseText, key: resolved.key };
    personaPacked[id] = packed;
    if (!mutated) {
      assertLegal(teamsMod, id, text, notes);
    } else {
      // The mutator validates and rolls back its own illegal output; we re-check and only warn,
      // because an illegal mutation is a finding about the mutator, not a reason to abort a run.
      try {
        const msgs = teamsMod.validateTeam(text);
        if (msgs && msgs.length) notes.push(id + ' mutated team flagged illegal: ' + msgs.join('; '));
      } catch (e) {
        notes.push(id + ' mutated team could not be re-validated: ' + (e && e.message));
      }
    }
  });

  // ---- crucible replay -------------------------------------------------------------
  let crucible = null;
  let splicer = null;
  let mode = options.mode;
  if (options.mode === 'crucible') {
    const replayPath = options.replay ? path.resolve(process.cwd(), options.replay) : DEFAULT_REPLAY;
    if (!fs.existsSync(replayPath)) {
      console.log('\u26a0  replay not found at ' + replayPath + ' — running full battles instead');
      notes.push('replay missing: ' + replayPath);
      mode = 'full';
    } else {
      const replMod = loadArenaModule('replay_splicer.js', 'crucible splicing');
      const Klass = replMod.ReplaySplicer;
      if (typeof Klass !== 'function') throw new SetupError('replay_splicer.js does not export ReplaySplicer');
      splicer = new Klass();
      const lines = fs.readFileSync(replayPath, 'utf8').split('\n').filter(Boolean);
      let found = null;
      try { found = splicer.findCrucibleTurn(lines); } catch (e) { found = null; }
      if (!found || !found.turnNumber) {
        console.log('\u26a0  no crucible turn in ' + path.relative(ROOT, replayPath) + ' — running full battles instead');
        notes.push('no crucible turn found');
        mode = 'full';
      } else {
        crucible = { lines: lines, turn: found.turnNumber, reason: found.reason || 'unspecified', source: path.relative(ROOT, replayPath) };
      }
    }
  }

  const harvester = options.harvest
    ? (function () {
      const mod = loadArenaModule('blunder_harvester.js', 'turning losses into puzzles');
      const Klass = mod.BlunderHarvester;
      if (typeof Klass !== 'function') throw new SetupError('blunder_harvester.js does not export BlunderHarvester');
      return new Klass({ seed: options.seed });
    })()
    : null;

  notes.push('opponent deliberation: declared ' +
    (options.deliberation || 'normal (per persona)') +
    ' — the arena cannot measure latency, so this is stated, not read');

  const ctx = {
    options: options, specs: specs, mode: mode, crucible: crucible, splicer: splicer,
    harvester: harvester, bridge: bridge, Runner: Runner, formatId: formatId,
    enginePacked: enginePacked, engineTeamText: engineTeam.text, engineTeamKey: engineTeam.key,
    personaTeams: personaTeams,
    personaPacked: function (id) { return personaPacked[id]; },
    baseSeed: options.seed, useColor: useColor, harvested: 0, harvestFailures: 0, fallbacks: 0,
    appliedSets: appliedSets, notes: notes
  };

  if (!options.quiet && useColor) {
    console.log(ANSI.cyan + 'Showdown Tactician arena' + ANSI.reset + ' — ' + mode + ' mode, ' +
      options.battles + ' battle(s), seed ' + options.seed);
    notes.forEach(function (n) { console.log('  ' + ANSI.dim + n + ANSI.reset); });
  }

  // ---- battles ---------------------------------------------------------------------
  const counts = distribute(options.battles, selected.length);
  const records = [];
  let done = 0;
  const started = Date.now();
  for (let s = 0; s < selected.length; s++) {
    const id = selected[s];
    for (let b = 0; b < counts[s]; b++) {
      const record = await runOneBattle(ctx, id, done);
      records.push(record);
      done++;
      if (!options.quiet && useColor) {
        const tag = record.error ? ANSI.yellow + 'ERROR' + ANSI.reset
          : record.winner === 'p1' ? ANSI.green + 'WIN ' + ANSI.reset
            : record.winner === 'p2' ? ANSI.red + 'LOSS' + ANSI.reset : ANSI.dim + 'TIE ' + ANSI.reset;
        console.log('  [' + pad(done, String(options.battles).length, true) + '/' + options.battles + '] ' +
          pad(id, 10) + tag + ' turns ' + pad(record.turnCount, 4, true) +
          ' ' + pad(record.latencyMs.toFixed(1), 8, true) + 'ms' +
          (record.harvestedPuzzle ? ' ' + ANSI.dim + '-> ' + record.harvestedPuzzle + ANSI.reset : '') +
          (record.error ? ' ' + ANSI.yellow + record.error + ANSI.reset : ''));
      }
    }
  }

  const summary = summarize(records, specs);
  renderSummary(summary, ctx, options);

  const elapsedSec = (Date.now() - started) / 1000;
  if (!options.quiet) {
    console.log('  wall clock: ' + elapsedSec.toFixed(1) + 's for ' + records.length + ' battle(s)');
    if (ctx.notes.length) ctx.notes.forEach(function (n) { console.log('  note: ' + n); });
  }

  if (options.json) {
    const outPath = path.resolve(process.cwd(), options.json);
    const payload = {
      generatedBy: 'tools/run_arena.js', generatedAt: new Date().toISOString(),
      options: options, mode: mode, formatId: formatId, engineTeamKey: ctx.engineTeamKey,
      appliedSets: ctx.appliedSets,
      crucible: crucible ? { source: crucible.source, turn: crucible.turn, reason: crucible.reason } : null,
      summary: summary, records: records, notes: ctx.notes,
      harvest: { harvested: ctx.harvested, failures: ctx.harvestFailures, target: path.relative(ROOT, PUZZLE_FILE) },
      elapsedSeconds: elapsedSec
    };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log('  wrote ' + path.relative(process.cwd(), outPath));
  }

  const everyBattleErrored = records.length > 0 && summary.totals.errors === records.length;
  if (everyBattleErrored) {
    console.error('every battle errored — see the records above');
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(function (code) {
    process.exitCode = code;
  }).catch(function (err) {
    if (err && err.isSetup) {
      console.error('setup failed: ' + err.message);
      process.exitCode = 2;
      return;
    }
    console.error('arena crashed:');
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 2;
  });
}

module.exports = {
  main: main,
  parseArgs: parseArgs,
  createEngineAgent: createEngineAgent,
  seedFor: seedFor,
  distribute: distribute,
  renderSummary: renderSummary,
  parseConfigValue: parseConfigValue,
  formatConfigValue: formatConfigValue,
  applyConfigPatch: applyConfigPatch,
  SetupError: SetupError
};
