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
 * Run the self-check with:  node tools/headless_arena/engine_bridge.js
 */
'use strict';

const path = require('path');

const HARNESS_PATH = path.join(__dirname, '..', '..', 'tests', 'harness.js');

/* The label the engine's state manager keys its format support off of. */
const ENGINE_FORMAT_NAME = '[Gen 9] National Dex OU';
/* The actual ladder format the sim runs — see fact (a) in the header. */
const SIM_FORMAT_ID = 'gen9nationaldex';

let cachedHarness = null;

/**
 * Load the engine sandbox once per process. `setInterval` is stubbed because content.js boots on
 * the harness's stubbed hostname and starts a 2.5 s heartbeat, which would keep a battle script
 * alive forever (the suites stub it the same way, for the same reason).
 */
function loadHarness(options) {
  if (cachedHarness && !(options && options.fresh)) return cachedHarness;
  const harness = require(HARNESS_PATH);
  const sandbox = harness.loadAll({
    setInterval: function () { return 0; },
    clearInterval: function () { }
  }, (options && options.harnessOpts) || {});
  const ST = sandbox.ST;
  if (!ST || !ST.TacticianBoot) {
    throw new Error('engine_bridge: the harness loaded but ST.TacticianBoot is missing — the ' +
      'engine manifest order in tests/harness.js no longer exposes the boot class');
  }
  cachedHarness = { harness: harness, sandbox: sandbox, ST: ST };
  return cachedHarness;
}

/** @pkmn/sim, required lazily so the bridge can be used by docs tooling without it. */
function loadSim() {
  return require('@pkmn/sim');
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
    const loaded = loadHarness(options.fresh ? { fresh: true } : null);
    this.ST = loaded.ST;
    const doc = options.doc || loaded.harness.createFakeDocument();
    this.boot = new this.ST.TacticianBoot({ doc: doc });
    if (options.paste) this.setTeam(options.paste);
    if (this.boot.state && typeof this.boot.state.setFormat === 'function') {
      try { this.boot.state.setFormat(options.formatName || ENGINE_FORMAT_NAME); }
      catch (e) { this.errors.push('setFormat: ' + (e && e.message)); }
    }
    this.ranked = null;
    this.readout = null;
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
   */
  feed(line) {
    if (!line) return undefined;
    let out;
    try {
      out = this.boot.handleLine(line);
    } catch (e) {
      this.errors.push('handleLine: ' + (e && e.message));
      return undefined;
    }
    if (/^\|request\|/.test(line)) this.requests++;
    if (Array.isArray(out) && out.length && out[0] && out[0].kind) {
      this.ranked = out;
      this.evaluations++;
      this.readout = this.boot.pendingReadout || (this.boot.engine && this.boot.engine.lastReadout) || null;
      return out;
    }
    return undefined;
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
    active: [{ moves: [{ move: 'Headlong Rush', id: 'headlongrush', pp: 16, maxpp: 16, target: 'normal' }, { move: 'Close Combat', id: 'closecombat', pp: 8, maxpp: 8, target: 'normal' }] }],
    rqid: 1
  });
  const ranked = session.feed('|request|' + req);
  console.log('ranked lines:', Array.isArray(ranked) ? ranked.length : 0, '| top:', session.topChoice(), '| bestScore:', session.bestScore());
  console.log('pipeline errors:', JSON.stringify(session.pipelineErrors()));
  console.log('sample:'); console.log(JSON.stringify(session.ranked && session.ranked.slice(0, 4), null, 1));
  const expected0 = /^Great Tusk$/;
  console.log('team preview order:', teamPreviewOrder({ side: { pokemon: [{}, {}, {}] } }, 2), '| first mon is Great Tusk:', expected0.test(session.team[0].species));
}
