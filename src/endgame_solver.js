/* Showdown Tactician — src/endgame_solver.js
 *
 * The endgame tier: when both sides are down to a couple of living bodies, the 1-ply simultaneous
 * matrix stops being the best question to ask. The matrix prices ONE turn and hands the result to a
 * leaf evaluator, so "Sucker Punch, then Kowtow, then Sucker Punch" — a line that is only visible
 * three turns deep — is invisible to it by construction. Here the same turn is unrolled instead:
 * both sides act, faints replace, and the resulting position is searched again until the depth or
 * the node budget runs out, with an alpha-beta window and a terminal band that makes "this line
 * forces their last body to faint on turn N" a PROVABLE claim rather than a higher score.
 *
 * WHY THIS FILE IS MOSTLY REFUSALS
 *   A deep search is only worth its cost when every number in it is trustworthy. So the solver
 *   declares the small box it is competent in, and outside that box it returns null instead of a
 *   number:
 *     - `laplace.endgame.enabled` false (the default — the coordinator wires this in),
 *     - more than `maxAlive` living bodies on either side (3, so a 3v3/3v2/2v3 board is inside the
 *       box; it was 2 until the wider activation bound was asked for and measured),
 *     - no damage engine or no leaf evaluator,
 *     - no modelled move for either ACTIVE body,
 *     - the node budget exhausted mid-search ({solved:false, reason:'budget'}, never a partial
 *       line presented as a solution),
 *     - a board whose action order cannot be decided AND whose outcome depends on it, when
 *       `laplace.endgame.chanceNodes` is off or the probability cannot be read,
 *     - a move the damage engine cannot price.
 *   Those last two are the important ones. "Who moves first" is decided by move priority and then
 *   by measured Speed; when the two Speed bounds OVERLAP (the opponent's set is not pinned) the
 *   pair is searched BOTH ways. If the two orders agree the pair IS decided. If they disagree, the
 *   outcome is a function of a fact this engine does not have, and the old rail refused the whole
 *   solve rather than picking one: a proof is only ever as strong as its weakest branch, and a mate
 *   reported through a branch that might have gone the other way is not a mate. The question is
 *   asked at EVERY pair the search visits, so ONE undecided pair anywhere in the tree used to
 *   refuse everything — including a near-mirror endgame with unpinned Speed, because at some depth
 *   "who is inside one hit of fainting" becomes the whole question.
 *
 *   CHANCE NODES (laplace.endgame.chanceNodes, on by default) keep the honesty and drop the
 *   refusal where it is merely uninformative. When OUR exact Speed is known and the opponent's band
 *   straddles it, `_oppFasterProbability` reads the share of THEIR surviving candidate sets (weighted
 *   by each set's own posterior weight, an exact tie counted as a coin flip, Trick Room inverted)
 *   that act before us, and the pair is priced as the expected value over the two orders. The one
 *   thing a chance node may NEVER do is manufacture a mate: a blended value is clamped strictly
 *   inside the non-mate band, so `solved` can only be true for a line the tree PROVED in both
 *   orders. `report.chancePairs` says how many such pairs the value rests on.
 *
 * THE 2026-10-15 HARDENING PASS — FIVE STRUCTURAL FLAWS, EACH BEHIND ITS OWN LEAF
 *   The five below are the reasons `endgame-3v3` could not be trusted. Each one changes what the
 *   tree believes, so each has its own `laplace.endgame.*` switch and is pinned in
 *   tests/endgame_check.js §7. With every leaf at its config default the module is what it was
 *   before the pass EXCEPT that the fixes themselves default ON — the tier they sharpen still ships
 *   `enabled: false`, so the shipped RANKING is untouched either way (the boot's background ponder
 *   is the only caller that runs the solver, and only for a Cancel-window hint).
 *
 *   1. `simultaneousPly` — THE OPPONENT MAY NOT SEE OUR SECRET. The old `_myTurn -> _theirTurn`
 *      shape was `max_i min_j` of the turn matrix, which is the pure-strategy maximin. That is a
 *      valid floor, but it prices a Stackelberg game (we commit, they read it, they answer). A turn
 *      of Pokemon is SIMULTANEOUS: they cannot switch out of a coverage move they have not seen us
 *      click. So when neither side owns a strictly dominant pure action the turn is solved as a
 *      small zero-sum matrix game (regret matching) and the value is the game value — never lower
 *      than the maximin floor, and never the "they clairvoyantly dodged" number. A dominant pure
 *      action still short-circuits: a real proof does not need to average anything.
 *   2. `includeRecoveryAndProtect` — A RECOVER IS AN ACTION. `_movesOf` used to return damaging
 *      moves only, so `Recover`/`Roost`/`Slack Off`/`Soft-Boiled` were invisible (they read as
 *      "does nothing", which is the single most dangerous way to be wrong about an endgame) and a
 *      `Protect` read as a free turn. Both are now modelled: a heal restores 50 % (clamped to 100)
 *      only when the body is still standing when its action resolves, and a shield blocks the
 *      incoming hit for the turn — and is only OFFERED while that side's protect chain is broken
 *      (`consecutiveProtects === 0`), because the second one in a row fails in the real game.
 *   3. `modelPhysics` — THE FIELD KEEPS MOVING. A replacement pays its side's entry hazards
 *      (`U.hazardPercent`), Trick Room's timer ticks down and expires mid-tree (so a line that
 *      relies on acting first "because Trick Room" does not get it forever), and end-of-turn
 *      burn/poison chip and Leftovers recovery land on both actives.
 *   4. `transposition` — THE SAME BOARD IS THE SAME BOARD. A per-`solve()` cache keyed on the
 *      board with HP bucketed into `ceil(hp / 5)` (0 stays 0) plus the active slots, boosts, the
 *      Trick Room timer and the (depth, ply) pair, so a position reached by two move orders — or
 *      across a chance-node pair — is read once. Only values computed with a FULL window are
 *      cached, because a fail-high/fail-low result is a bound, not a value, and caching a bound
 *      under an exact key would corrupt a sibling branch.
 *   5. `solveAcrossWorlds` — ONE WORLD IS NOT EVIDENCE. `solve(state, world)` prices a single
 *      sampled opponent set, so a mate "proven" against one world can be refuted by another set the
 *      sampler still believes in. The multi-world entry point runs the search per world and only
 *      reports a forced win when EVERY non-refusing world proves one AND the recommended root
 *      action is the same; otherwise it reports the root action with the best WORST-CASE score
 *      across worlds. `LaplaceEngine` calls it in place of the single-world call.
 *
 * WHAT IS MODELLED, AND WHAT IS DELIBERATELY NOT
 *   - One turn = both bodies act once, ordered by (priority, Speed), and the pair is resolved with
 *     `simultaneousPly` above (a small matrix game) or, with that leaf off, the legacy
 *     Stackelberg worst case.
 *   - Damaging moves, recovery moves and Protect are actions (see 2). Stat boosts and every other
 *     status move are still NOT actions: a body whose known moves are all of that kind passes.
 *   - NOT modelled, and named here so nobody reads more into a mate than it says: accuracy and
 *     critical hits (the damage engine's AVERAGE is used), PP DEPLETION (a move with 0 PP recorded
 *     is not offered, but the tree does not decrement PP as it searches), Substitute, stat boosts,
 *     weather/terrain changes, items that trigger on a hit, and abilities that fire between hits.
 *     Every damage number that IS used comes from `ST.DamageEngine.calculateDamage` — this file
 *     contains no damage formula, no type chart and no species rule (tests/blackbox_guard.js is the
 *     rule that keeps it that way).
 *   - A fainted body is replaced by the healthiest surviving one (ties by name), deterministically
 *     and without searching over the choice.
 *
 * PURITY. The node objects below are this file's own scratch structures; `state` and `world` are
 * read, never written, and the leaf handed to the evaluator is built from `Object.create` clones
 * with their OWN `hp`/`hpPercent`/`fainted` — the same contract `_leafState` in laplace_core.js
 * keeps, and the reason a clone must own any field it changes. `_cloneNode` also copies `field` and
 * the protect streaks, because `modelPhysics` writes to both.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  // Rule 4: the tunables live in src/config.js; these literals are the standalone fallback.
  const cfg = ST.configGet || function (path, fallback) { return fallback; };

  /** A forced win scores in this band as `WIN - turns`, so a faster mate outranks a slower one. */
  const WIN = 1e6;
  /** How close to +/-WIN a value must be to count as a proven terminal line. */
  const MATE_BAND = 1000;

  /* Sentinels, thrown out of the recursion. Objects, so `===` cannot collide with a score. */
  const BUDGET = { kind: 'budget' };
  const UNDECIDED = { kind: 'speed-undecided' };
  const UNPRICED = { kind: 'unpriceable' };

  /* A body with no priced action passes its turn. A shared frozen object, so `===` identifies it. */
  const PASS = Object.freeze({ kind: 'pass', name: null });

  function intOr(value, fallback) {
    return typeof value === 'number' && isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }
  function hpOf(mon) {
    if (!mon) return 100;
    let hp = mon.hpPercent;
    if (hp === null || hp === undefined) hp = mon.hp;
    if (hp === null || hp === undefined || hp !== hp) return 100;
    return hp;
  }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  class EndgameSolver {
    constructor(options) {
      const o = options || {};
      this.enabled = o.enabled !== undefined ? !!o.enabled : cfg('laplace.endgame.enabled', false) === true;
      /* How many living bodies a side may have before this solver declares the box too big. Read
       * from `maxAlive`, falling back to the historical `maxBodies` (both as an option and as a
       * config key) and then to 3. `this.maxBodies` is kept in step because that is the name the
       * existing callers and the regression suite use. */
      this.maxAlive = intOr(o.maxAlive !== undefined ? o.maxAlive : o.maxBodies,
        cfg('laplace.endgame.maxAlive', cfg('laplace.endgame.maxBodies', 3)));
      this.maxBodies = this.maxAlive;
      this.maxDepth = intOr(o.maxDepth, cfg('laplace.endgame.maxDepth', 10));
      this.nodeBudget = intOr(o.nodeBudget, cfg('laplace.endgame.nodeBudget', 20000));
      // A bound on how many moves one side may branch on. Inert for a legal four-move set; it is
      // here so a driver-built body carrying more known moves cannot widen a search the node budget
      // was sized for.
      this.maxBranchingMoves = intOr(o.maxBranchingMoves, cfg('laplace.endgame.maxBranchingMoves', 12));
      // Ambiguous Speed as a chance node (see the class comment). `!== false` so a config that never
      // mentions the key gets the documented default, and an explicit false restores the refusal.
      this.chanceNodes = o.chanceNodes !== undefined ? !!o.chanceNodes
        : cfg('laplace.endgame.chanceNodes', true) !== false;
      /* ---- the five hardening leaves (see the header) ---- */
      this.simultaneousPly = o.simultaneousPly !== undefined ? !!o.simultaneousPly
        : cfg('laplace.endgame.simultaneousPly', true) !== false;
      this.includeRecoveryAndProtect = o.includeRecoveryAndProtect !== undefined ? !!o.includeRecoveryAndProtect
        : cfg('laplace.endgame.includeRecoveryAndProtect', true) !== false;
      this.modelPhysics = o.modelPhysics !== undefined ? !!o.modelPhysics
        : cfg('laplace.endgame.modelPhysics', true) !== false;
      this.transposition = o.transposition !== undefined ? !!o.transposition
        : cfg('laplace.endgame.transposition', true) !== false;
      this.multiWorld = o.multiWorld !== undefined ? !!o.multiWorld
        : cfg('laplace.endgame.multiWorld', true) !== false;
      // Regret-matching rounds for a turn matrix with no dominant pure action. Small on purpose:
      // the matrix is at most `maxBranchingMoves` squared and this runs at EVERY ply.
      this.regretIters = intOr(o.regretIters, cfg('laplace.endgame.regretIters', 200));
      this._chancePairs = 0;
      // An explicit null must be HONOURED (the refusal path for "no engine" is part of the
      // contract), so this is `!== undefined`, not `||`.
      this.damage = o.damage !== undefined ? o.damage : (ST.DamageEngine ? new ST.DamageEngine({ gen: 9 }) : null);
      this.evaluator = o.evaluator !== undefined ? o.evaluator : (ST.DenseStateEvaluator ? new ST.DenseStateEvaluator() : null);
      this._nodes = 0;
      this._tt = null;
      this._ttHits = 0;
      this.lastReport = null;
    }

    /* ------------------------------------------------------------------ public */

    /**
     * solve(state, world) -> EndgameResult | null
     *   { solved, reason, depth, mateIn, line, score, nodes, chancePairs, transpositions }
     * `solved` is TRUE only when a forced win is PROVEN inside `maxDepth`; `mateIn` is then the
     * number of turns until their last living body faints and `line` is our side's actions, first
     * action first. `null` means "this solver is not competent here" and `lastReport.reason` says
     * which refusal fired. A completed search that finds no mate returns the same shape with
     * `solved:false` — the difference between "refused" and "answered, no mate" is deliberate.
     */
    solve(state, world) {
      this.lastReport = null;
      if (!this.enabled) return this._refuse('disabled');
      if (!state) return this._refuse('no-state');
      if (!this.damage || !this.evaluator) return this._refuse('no-engine');
      const U = ST.util || {};
      if (typeof U.getMoveData !== 'function') return this._refuse('no-dex');

      const node = this._nodeFrom(state, world);
      if (!node) return this._refuse('no-bodies');
      if (node.my.bodies.length > this.maxAlive) return this._refuse('too-many-bodies-mine');
      if (node.opp.bodies.length > this.maxAlive) return this._refuse('too-many-bodies-theirs');
      const myActions = this._actionsFor(node, 'my');
      const oppActions = this._actionsFor(node, 'opp');
      if (myActions.length === 1 && myActions[0] === PASS) return this._refuse('no-modelled-move-mine');
      if (oppActions.length === 1 && oppActions[0] === PASS) return this._refuse('no-modelled-move-theirs');

      this._nodes = 0;
      this._chancePairs = 0;
      this._tt = this.transposition ? new Map() : null;
      this._ttHits = 0;
      this._source = state;
      try {
        const value = this._turnValue(node, this.maxDepth, 0, -Infinity, Infinity);
        const line = this._principalLine(node, this.maxDepth);
        const mateTurns = value >= WIN - MATE_BAND ? WIN - value : null;
        const matedTurns = value <= -(WIN - MATE_BAND) ? WIN + value : null;
        return this._finish({
          solved: mateTurns !== null,
          isMate: mateTurns !== null,
          reason: mateTurns !== null ? 'mate' : (matedTurns !== null ? 'mated' : 'no-forced-win'),
          depth: this.maxDepth,
          mateIn: mateTurns,
          line: line,
          score: value,
          nodes: this._nodes
        });
      } catch (e) {
        if (e === BUDGET) return this._finish({ solved: false, isMate: false, reason: 'budget', depth: this.maxDepth, mateIn: null, line: [], score: null, nodes: this._nodes });
        if (e === UNDECIDED) return this._refuse('speed-undecided', this._nodes);
        if (e === UNPRICED) return this._refuse('unpriceable-move', this._nodes);
        throw e;
      }
    }

    /**
     * solveAcrossWorlds(state, worlds) -> EndgameResult | null
     *
     * The multi-world entry point. `solve` prices ONE sampled opponent set; this prices them all and
     * refuses to call anything a forced win unless EVERY non-refusing world proves it. Returns:
     *   - the single-world result unchanged when `multiWorld` is off, when there is one usable
     *     world, or when every other world refused (there is nothing to contradict it),
     *   - a forced win (solved/isMate true, `mateIn` the slowest across worlds) only when every
     *     world both proved a mate AND named the SAME root action; a disagreement is reported as
     *     `no-forced-win` with `worldSplit: true`,
     *   - otherwise `no-forced-win` with `score` = the WORST case over worlds (the min) and `line`
     *     taken from the world that owns that worst case, so a caller reading `score` is reading a
     *     floor rather than a hope. `worldScores` carries every world's number.
     *
     * Refusing worlds are dropped before any of this (they carry no opinion), and if nothing is
     * left the first world's report — refusal included — is returned.
     */
    solveAcrossWorlds(state, worlds) {
      const list = (worlds || []).filter(function (w) { return w && w.team && w.team.length; });
      if (!this.multiWorld || list.length <= 1) return this.solve(state, list[0] || null);

      const results = [];
      for (let i = 0; i < list.length; i++) results.push(this.solve(state, list[i]));
      const usable = [];
      for (let i = 0; i < results.length; i++) if (results[i]) usable.push({ result: results[i], world: list[i] });
      if (!usable.length) return results[0] || null;
      if (usable.length === 1) {
        const only = usable[0].result;
        // A lone survivor is the shipped single-world contract, no aggregation attached.
        return only;
      }

      const allMate = usable.every(function (u) { return u.result.solved === true; });
      const rootOf = function (u) { return (u.result.line && u.result.line[0] && u.result.line[0].name) || null; };
      const firstRoot = rootOf(usable[0]);
      const sameRoot = usable.every(function (u) { return rootOf(u) === firstRoot; });
      const scores = usable.map(function (u) {
        return (typeof u.result.score === 'number' && isFinite(u.result.score)) ? u.result.score : 0;
      });
      let worstIdx = 0;
      for (let i = 1; i < scores.length; i++) if (scores[i] < scores[worstIdx]) worstIdx = i;
      const worst = scores[worstIdx];
      let nodes = 0, chancePairs = 0, transpositions = 0;
      for (let i = 0; i < usable.length; i++) {
        nodes += usable[i].result.nodes || 0;
        if ((usable[i].result.chancePairs || 0) > chancePairs) chancePairs = usable[i].result.chancePairs || 0;
        transpositions += usable[i].result.transpositions || 0;
      }

      if (allMate && sameRoot) {
        let mateIn = 0;
        for (let i = 0; i < usable.length; i++) {
          const m = usable[i].result.mateIn;
          if (typeof m === 'number' && m > mateIn) mateIn = m;
        }
        return this._finish({
          solved: true, isMate: true, reason: 'mate', depth: this.maxDepth, mateIn: mateIn,
          line: usable[0].result.line, score: worst, nodes: nodes,
          worlds: usable.length, worldScores: scores, chancePairs: chancePairs,
          transpositions: transpositions
        });
      }
      return this._finish({
        solved: false, isMate: false,
        reason: allMate && !sameRoot ? 'world-disagreement' : 'no-forced-win',
        depth: this.maxDepth, mateIn: null, line: usable[worstIdx].result.line, score: worst,
        nodes: nodes, worlds: usable.length, worldScores: scores,
        worldSplit: allMate && !sameRoot, chancePairs: chancePairs, transpositions: transpositions
      });
    }

    /* ----------------------------------------------------------------- results */

    _refuse(reason, nodes) {
      const report = {
        solved: false, isMate: false, reason: reason, depth: 0, mateIn: null,
        line: [], score: null, nodes: nodes || 0,
        chancePairs: this._chancePairs || 0, transpositions: this._ttHits || 0
      };
      this.lastReport = report;
      return null;
    }

    _finish(report) {
      // How many pairs along the way were resolved as CHANCE nodes (see _resolvePair). A caller can
      // tell a value the tree PROVED from one that rests on a Speed coin flip by reading this.
      // An AGGREGATE report (solveAcrossWorlds) sets its own totals across worlds, so those are
      // only filled from the instance when the caller left them undefined.
      if (report.chancePairs === undefined) report.chancePairs = this._chancePairs || 0;
      if (report.transpositions === undefined) report.transpositions = this._ttHits || 0;
      this.lastReport = report;
      return report;
    }

    /* ------------------------------------------------------------- board -> node */

    /**
     * The solver's own board: the living bodies of each side with their current HP percent, plus
     * which one is active. `world` (a sampled opponent set) wins over `state.oppTeam` when given,
     * because that is the fully-specified body the rest of the engine prices.
     */
    _nodeFrom(state, world) {
      const mk = function (mon) { return { mon: mon, hp: hpOf(mon) }; };
      const alive = function (team) {
        const out = [];
        const list = team || [];
        for (let i = 0; i < list.length; i++) {
          const mon = list[i];
          if (!mon || mon.fainted || hpOf(mon) <= 0) continue;
          out.push(mk(mon));
        }
        return out;
      };
      const myBodies = alive(state.myTeam);
      const oppTeam = (world && world.team && world.team.length) ? world.team : state.oppTeam;
      const oppBodies = alive(oppTeam);
      if (!myBodies.length || !oppBodies.length) return null;

      const activeIndex = function (bodies, preferred) {
        for (let i = 0; i < bodies.length; i++) {
          if (preferred && bodies[i].mon === preferred) return i;
          if (bodies[i].mon && bodies[i].mon.isActive) return i;
        }
        return 0;
      };
      const worldActive = (world && world.team)
        ? world.team.filter(function (m) { return m && m.isActive; })[0]
        : null;
      const prot = state.protect || {};
      return {
        my: { bodies: myBodies, active: activeIndex(myBodies, state.active && state.active.my) },
        opp: { bodies: oppBodies, active: activeIndex(oppBodies, worldActive || (state.active && state.active.opp)) },
        field: state.field || {},
        // The protect streaks, carried on the node because a shield this turn is what makes the
        // NEXT one illegal (see _actionsFor). Root values come from the live state.
        protect: {
          my: (typeof prot.myConsecutiveProtects === 'number' ? prot.myConsecutiveProtects : 0),
          opp: (typeof prot.oppConsecutiveProtects === 'number' ? prot.oppConsecutiveProtects : 0)
        }
      };
    }

    _aliveCount(side) {
      let n = 0;
      for (let i = 0; i < side.bodies.length; i++) if (side.bodies[i].hp > 0) n++;
      return n;
    }

    _active(side) {
      const at = side.bodies[side.active];
      if (at && at.hp > 0) return at;
      for (let i = 0; i < side.bodies.length; i++) if (side.bodies[i].hp > 0) return side.bodies[i];
      return null;
    }

    _cloneNode(node) {
      const copySide = function (side) {
        const bodies = [];
        for (let i = 0; i < side.bodies.length; i++) bodies.push({ mon: side.bodies[i].mon, hp: side.bodies[i].hp });
        return { active: side.active, bodies: bodies };
      };
      // `field` is a SHALLOW copy: `modelPhysics` writes the Trick Room timer through it, and the
      // old shared reference would have written the caller's board.
      return {
        my: copySide(node.my), opp: copySide(node.opp),
        field: Object.assign({}, node.field),
        protect: { my: node.protect ? node.protect.my : 0, opp: node.protect ? node.protect.opp : 0 }
      };
    }

    /** A fainted active is replaced by the healthiest survivor (ties by name) — deterministic. */
    _replaceFainted(node, sideKey) {
      const side = node[sideKey];
      const at = side.bodies[side.active];
      if (at && at.hp > 0) return;
      let pick = -1, bestHp = -1, bestName = '';
      for (let i = 0; i < side.bodies.length; i++) {
        const body = side.bodies[i];
        if (body.hp <= 0) continue;
        const name = String((body.mon && (body.mon.species || body.mon.id)) || '');
        if (body.hp > bestHp || (body.hp === bestHp && name < bestName)) { bestHp = body.hp; pick = i; bestName = name; }
      }
      side.active = pick;
      /* The replacement PAYS ITS ENTRY HAZARDS. The old code switched it in at the HP it already
       * had, which is how a search invents a body that never touched the rocks. */
      if (this.modelPhysics && pick >= 0) {
        const U = ST.util || {};
        if (typeof U.hazardPercent === 'function') {
          const body = side.bodies[pick];
          const mon = body.mon || {};
          const field = node.field || {};
          const hazards = (field.hazards && field.hazards[sideKey === 'my' ? 'p1' : 'p2']) || {};
          const pct = U.hazardPercent(mon.species || mon.id, mon.item || '', mon.ability || '', hazards);
          if (typeof pct === 'number' && isFinite(pct) && pct > 0) {
            body.hp = clamp(body.hp - pct, 0, 100);
            // A replacement that faints to hazards picks the next one; bounded by the body count.
            if (body.hp <= 0) this._replaceFainted(node, sideKey);
          }
        }
      }
    }

    /* ------------------------------------------------------------------ actions */

    /**
     * What a known move name IS to this search: 'attack' (a priced damaging move), 'recover' or
     * 'protect' (modelled only when `includeRecoveryAndProtect`), or null (every other status move,
     * which stays out of the tree rather than being priced as a free turn).
     */
    _classifyMove(name) {
      const U = ST.util || {};
      if (!name || typeof U.getMoveData !== 'function') return null;
      const data = U.getMoveData(name);
      if (!data) return null;
      if (!data.isStatus && data.basePower > 0) return 'attack';
      if (this.includeRecoveryAndProtect) {
        if (typeof U.isRecoveryMove === 'function' && U.isRecoveryMove(name)) return 'recover';
        if (typeof U.isProtectMove === 'function' && U.isProtectMove(name)) return 'protect';
      }
      return null;
    }

    /**
     * The modelled moves of a body, as NAMES: damaging moves always, plus recovery and Protect when
     * `includeRecoveryAndProtect` is on. A LEGAL set is four moves, so `maxBranchingMoves` never
     * binds on a real board — which is the point of a bound: it exists for the driver-built body
     * that carries more known moves than a set can hold, and it is the number the node budget was
     * sized against rather than a second hardcoded four.
     */
    _movesOf(mon) {
      const U = ST.util || {};
      if (!mon || typeof U.getMoveData !== 'function') return [];
      const list = (mon.setMoves && mon.setMoves.length) ? mon.setMoves
        : (mon.liveSet && mon.liveSet.moves) ? mon.liveSet.moves
          : (mon.revealedMoves) ? mon.revealedMoves : [];
      const out = [];
      for (let i = 0; i < list.length && out.length < this.maxBranchingMoves; i++) {
        const name = list[i];
        if (!name) continue;
        if (!this._classifyMove(name)) continue;
        if (out.indexOf(name) === -1) out.push(name);
      }
      return out;
    }

    /** A move with 0 recorded PP is not offered. Unknown PP is assumed available (most boards). */
    _ppOk(mon, name) {
      const pp = mon && mon.movePP;
      if (!pp) return true;
      const v = pp[name];
      if (typeof v !== 'number') return true;
      return v > 0;
    }

    /**
     * The actions a side may take this turn, as `{kind, name}` objects, or `[PASS]` when it has
     * none. Protect is offered only while that side's protect chain is broken (`consecutiveProtects`
     * 0) — the second one in a row fails in the game, and pricing a failing shield as a real one is
     * exactly the kind of free turn this pass exists to remove.
     */
    _actionsFor(node, sideKey) {
      const side = node[sideKey];
      const active = this._active(side);
      const mon = active && active.mon;
      const names = this._movesOf(mon);
      const streak = (node.protect && node.protect[sideKey]) || 0;
      const out = [];
      for (let i = 0; i < names.length; i++) {
        const kind = this._classifyMove(names[i]);
        if (!kind) continue;
        if (kind === 'protect' && streak > 0) continue;
        if (kind !== 'attack' && !this._ppOk(mon, names[i])) continue;
        out.push({ kind: kind, name: names[i] });
      }
      return out.length ? out : [PASS];
    }

    /**
     * OUR exact Speed when we own the set — and only then. `maxSpeedForSet` is a set's MAXIMUM
     * possible Speed, so it is our real Speed only for the set we actually registered, complete
     * with its EVs and nature; a set missing either is not something to hang "we move first" on.
     */
    _exactSpeed(mon) {
      const U = ST.util || {};
      if (!mon || typeof U.maxSpeedForSet !== 'function') return null;
      const set = mon.liveSet || (mon.candidateSets && mon.candidateSets.length === 1 ? mon.candidateSets[0] : null);
      if (!set || !set.evs || !set.nature) return null;
      const speed = U.maxSpeedForSet(set);
      return (typeof speed === 'number' && isFinite(speed) && speed > 0) ? speed : null;
    }

    /**
     * THEIR Speed as a range. The candidate pool can only ever tighten the CEILING: every entry of
     * it is that set's MAXIMUM possible Speed, so the fastest candidate bounds how fast the body
     * can be, while nothing in the pool proves a FLOOR (the true set may run fewer EVs than its own
     * maximum). A floor therefore comes only from the state manager's observed evidence
     * (`speedFloor`), and a 0 floor means "unknown", not "slower than anything" — the whole point
     * of a range is that an overlap must stay an overlap.
     */
    _speedBounds(mon) {
      const U = ST.util || {};
      let min = 0, max = Infinity;
      if (mon && typeof mon.speedFloor === 'number' && mon.speedFloor > 0) min = mon.speedFloor;
      if (mon && typeof mon.speedCeiling === 'number' && mon.speedCeiling > 0) max = mon.speedCeiling;
      const pool = (mon && mon.candidateSets && mon.candidateSets.length) ? mon.candidateSets
        : (mon && mon.liveSet ? [mon.liveSet] : []);
      /* THE CEILING IS THE FASTEST CANDIDATE, not the slowest. Every entry here is one set's
       * MAXIMUM possible Speed, and the body's true set is ONE of them, so the body cannot be
       * faster than the fastest candidate — the LARGEST of those maxima, not the smallest. The
       * original code took the minimum, which understated the ceiling in the UNSAFE direction (it
       * let the solver conclude "we are faster" about an opponent whose own surviving pool held a
       * set that outran us) and stopped the chance node below from ever firing on a straddle built
       * from a multi-set pool. Found by the chance-node tests, pinned in tests/endgame_check.js.
       * `speedCeiling` (the state manager's observed bound) is still honoured — both are upper
       * bounds, so the tighter one wins. */
      let poolMax = 0;
      if (pool.length && typeof U.maxSpeedForSet === 'function') {
        for (let i = 0; i < pool.length; i++) {
          const speed = U.maxSpeedForSet(pool[i]);
          if (!(typeof speed === 'number' && isFinite(speed) && speed > 0)) continue;
          if (speed > poolMax) poolMax = speed;
        }
      }
      if (poolMax > 0 && poolMax < max) max = poolMax;
      return { min: min, max: max };
    }

    /**
     * Who acts first in this (ours, theirs) pair: move priority decides, then measured Speed.
     * 'undecided' is returned when the Speed ranges overlap — the caller then resolves it both
     * ways rather than picking one. Takes action objects (or a bare move name, for the pinned
     * unit calls in the suite) so a Protect's own +4 priority is honoured.
     */
    _orderFor(node, myAct, theirAct) {
      const U = ST.util || {};
      const myName = (myAct && myAct.name) || myAct;
      const theirName = (theirAct && theirAct.name) || theirAct;
      const myData = (myName && typeof U.getMoveData === 'function') ? U.getMoveData(myName) : null;
      const oppData = (theirName && typeof U.getMoveData === 'function') ? U.getMoveData(theirName) : null;
      const myPriority = (myData && typeof myData.priority === 'number') ? myData.priority : 0;
      const oppPriority = (oppData && typeof oppData.priority === 'number') ? oppData.priority : 0;
      if (myPriority !== oppPriority) return myPriority > oppPriority ? 'my' : 'opp';
      const myActive = this._active(node.my);
      const oppActive = this._active(node.opp);
      const mySpeed = this._exactSpeed(myActive && myActive.mon);
      const bounds = this._speedBounds(oppActive && oppActive.mon);
      if (mySpeed !== null && mySpeed > bounds.max) return 'my';
      if (mySpeed !== null && mySpeed < bounds.min) return 'opp';
      return 'undecided';
    }

    /* ------------------------------------------------------------------- search */

    _tick() {
      this._nodes += 1;
      if (this._nodes > this.nodeBudget) throw BUDGET;
    }

    /**
     * Price one ACTION and write the result into a fresh node (the source node is never touched).
     * `prot` carries which sides are shielding THIS turn (see `_applyPair`).
     */
    _applyAction(node, sideKey, action, prot) {
      const next = this._cloneNode(node);
      this._tick();
      if (!action || action.kind === 'pass') return next;
      const foeKey = sideKey === 'my' ? 'opp' : 'my';
      const attacker = this._active(next[sideKey]);
      const defender = this._active(next[foeKey]);
      if (!attacker) return next;
      if (action.kind === 'attack') {
        if (!defender) return next;
        // A shield that is UP blocks the hit. It does not make the attack free for us: the turn is
        // spent either way, which is the whole reason a Protect is worth pricing at all.
        if (this.includeRecoveryAndProtect && prot && prot[foeKey] === true) return next;
        const res = this._hit(attacker.mon, defender.mon, action.name, next.field, attacker.hp, defender.hp);
        if (!res) throw UNPRICED;
        const after = clamp(defender.hp - (res.avgPercent || 0), 0, 100);
        defender.hp = after;
        if (after <= 0) this._replaceFainted(next, foeKey);
        return next;
      }
      if (action.kind === 'recover') {
        // A heal lands only while the body is still standing when its action resolves: the caller
        // applies pairs in Speed order, so a body that fainted first never heals (its action is
        // skipped entirely — `_applyPair` checks the alive count before each act).
        const heal = (this.damage && typeof this.damage.defaultHealPct === 'number') ? this.damage.defaultHealPct
          : cfg('laplace.priceRecovery.defaultHealPct', 50);
        attacker.hp = clamp(attacker.hp + heal, 0, 100);
        return next;
      }
      return next;                                   // protect: the flag was set by _applyPair
    }

    _hit(attackerMon, defenderMon, moveName, field, attackerHp, defenderHp) {
      try {
        const res = this.damage.calculateDamage(attackerMon, defenderMon, moveName, field, {
          attacker: { hpPercent: attackerHp },
          defender: { hpPercent: defenderHp }
        });
        if (!res || res.failed) return null;
        return res;
      } catch (e) { return null; }
    }

    /**
     * Both sides act once, in `order`, then the resulting position is searched or evaluated. The
     * shield flags are decided BEFORE either action resolves (a Protect is +4 priority, so the
     * shield is up before any attack in the turn) and the protect STREAKS are advanced on the
     * result, which is what makes the next turn's shield illegal.
     */
    _applyPair(node, myAct, theirAct, order) {
      const prot = {
        my: !!(this.includeRecoveryAndProtect && myAct && myAct.kind === 'protect'),
        opp: !!(this.includeRecoveryAndProtect && theirAct && theirAct.kind === 'protect')
      };
      let cur = node;
      const acts = order === 'my' ? [['my', myAct], ['opp', theirAct]] : [['opp', theirAct], ['my', myAct]];
      for (let i = 0; i < acts.length; i++) {
        const side = acts[i][0], action = acts[i][1];
        if (this._aliveCount(cur[side]) === 0) continue;
        cur = this._applyAction(cur, side, action, prot);
      }
      if (this.includeRecoveryAndProtect && cur === node) cur = this._cloneNode(node);
      cur.protect = {
        my: prot.my ? ((node.protect ? node.protect.my : 0) + 1) : 0,
        opp: prot.opp ? ((node.protect ? node.protect.opp : 0) + 1) : 0
      };
      return cur;
    }

    /**
     * End-of-turn physics (see `modelPhysics`): burn/poison chip and Leftovers recovery on both
     * actives, then the Trick Room timer ticks down and expires. Returns the SAME node when there is
     * nothing to do (the common case), and a clone only when it has something to write — the
     * `field` copy in `_cloneNode` is what keeps the tick off the caller's board.
     */
    _endOfTurn(node) {
      if (!this.modelPhysics) return node;
      /* Takes a side KEY ('my'/'opp'), not the side object: the delta is applied to the CLONE
       * (`next`), so the chip has to name the side it belongs to rather than hold a live
       * reference to the caller's side. (The first draft passed `node.my` — the object — and
       * returned it as the `side` field, so `next[c.side]` was undefined: every chip read as a
       * no-op until one actually fired and the end-of-turn step threw. Caught by §7c.) */
      const chip = function (sideKey) {
        const at = this._active(node[sideKey]);
        if (!at || !at.mon) return null;
        const mon = at.mon;
        let delta = 0;
        const st = mon.status;
        if (st === 'brn') delta -= 6.25;                 // 1/16
        else if (st === 'psn') delta -= 12.5;            // 1/8
        else if (st === 'tox') delta -= 12.5;            // escalating in game; the 1/8 step here
        if (String(mon.item || '').toLowerCase().replace(/[^a-z]/g, '') === 'leftovers') delta += 6.25;
        return delta ? { side: sideKey, delta: delta } : null;
      }.bind(this);
      const myChip = chip('my');
      const oppChip = chip('opp');
      const field = node.field || {};
      const trTimed = typeof field.trickRoomTurnsLeft === 'number';
      if (!myChip && !oppChip && !trTimed) return node;

      const next = this._cloneNode(node);
      const applyChip = function (c) {
        if (!c) return;
        const at = this._active(next[c.side]);
        if (!at) return;
        at.hp = clamp(at.hp + c.delta, 0, 100);
        if (at.hp <= 0) this._replaceFainted(next, c.side);
      }.bind(this);
      applyChip(myChip);
      applyChip(oppChip);
      if (trTimed) {
        next.field.trickRoomTurnsLeft = field.trickRoomTurnsLeft - 1;
        if (next.field.trickRoomTurnsLeft <= 0) {
          next.field.trickRoomTurnsLeft = 0;
          next.field.trickRoom = false;
        }
      }
      return next;
    }

    /* ---- the transposition cache (see `transposition`) ---- */

    /**
     * A key for the board at this (depth, ply). HP is BUCKETED into `ceil(hp / 5)` — a 12 % body and
     * a 14 % body are the same position to within a fifth of a bar — with 0 preserved exactly (a
     * fainted body is a different position, not a bucket). Species, boosts, active slots, the
     * protect streaks, the Trick Room timer and the search depth AND ply all enter the key, because
     * the value of a position depends on how much depth is left and how far it is from the root
     * (a mate three plies out is not a mate one ply out).
     */
    _ttKey(node, depth, ply) {
      const sideKey = function (side) {
        let s = '';
        for (let i = 0; i < side.bodies.length; i++) {
          const b = side.bodies[i];
          const bucket = b.hp <= 0 ? 0 : Math.ceil(b.hp / 5);
          const m = b.mon || {};
          const bo = m.boosts;
          s += String(m.id || m.species || '?') + ':' + bucket + ':';
          s += bo ? (bo.atk + ',' + bo.def + ',' + bo.spa + ',' + bo.spd + ',' + bo.spe) : 'x';
          s += ';';
        }
        return s + '#' + side.active;
      };
      const f = node.field || {};
      const tr = (typeof f.trickRoomTurnsLeft === 'number') ? f.trickRoomTurnsLeft : (f.trickRoom ? 'on' : 'off');
      const p = node.protect || { my: 0, opp: 0 };
      return sideKey(node.my) + '|' + sideKey(node.opp) + '|tr' + tr + '|pt' + p.my + ',' + p.opp +
        '|d' + depth + '|p' + ply;
    }

    _afterTurn(node, depth, ply, alpha, beta) {
      this._tick();
      const cur = this.modelPhysics ? this._endOfTurn(node) : node;
      if (this._aliveCount(cur.opp) === 0) return WIN - (ply + 1);
      if (this._aliveCount(cur.my) === 0) return -(WIN - (ply + 1));
      const next = depth - 1;
      if (next <= 0) return this._evaluateLeaf(cur);
      /* ONLY EXACT VALUES ARE CACHED. A fail-high returns beta and a fail-low returns alpha, so a
       * pruned result is a BOUND; storing it under a board key and serving it to a sibling branch
       * that needed the value (not the bound) would corrupt that sibling. The simultaneous solver
       * below always calls with a full window, which is where the hits come from. */
      const exact = (alpha === -Infinity && beta === Infinity);
      let key = null;
      if (this.transposition && exact) {
        key = this._ttKey(cur, next, ply + 1);
        const hit = this._tt.get(key);
        if (hit !== undefined) { this._ttHits += 1; return hit; }
      }
      let value;
      try {
        value = this._turnValue(cur, next, ply + 1, alpha, beta);
      } catch (e) {
        if (this.transposition && key !== null && e === BUDGET) {
          // A budget abort is not a value; make sure nothing half-computed is cached under this key.
          this._tt.delete(key);
        }
        throw e;
      }
      if (key !== null && typeof value === 'number' && isFinite(value)) this._tt.set(key, value);
      return value;
    }

    _resolvePair(node, myAct, theirAct, depth, ply, alpha, beta) {
      const order = this._orderFor(node, myAct, theirAct);
      if (order === 'undecided') {
        // The comparison below asks a QUESTION, so it must not be answered with a pruned bound: a
        // fail-low returns alpha and a fail-high returns beta, so two subtrees with the SAME true
        // score can come back different (one exact, one clamped) and an order-independent pair
        // would read as undecided — this rail refusing a position it can actually prove, which is
        // the opposite of what it is for. Hence the full window on both calls.
        const mine = this._afterTurn(this._applyPair(node, myAct, theirAct, 'my'),
          depth, ply, -Infinity, Infinity);
        const theirs = this._afterTurn(this._applyPair(node, myAct, theirAct, 'opp'),
          depth, ply, -Infinity, Infinity);
        if (mine === theirs) return mine;              // order-independent, so the pair IS decided
        /* THE CHANCE NODE. The two orders DISAGREE, and that is only an unanswerable question when
         * nobody can say how likely each order is. When our own Speed is known and their band is an
         * overlap, `_oppFasterProbability` reads the share of their surviving candidate sets (each
         * weighted by its own posterior) that act before us, and the pair is priced as the expected
         * value over the two orders — the same conservative tree, one honest number instead of a
         * refusal. `chanceNodes: false`, or a probability that cannot be read, restores the rail. */
        if (this.chanceNodes) {
          const p = this._oppFasterProbability(node, myAct, theirAct);
          if (p !== null) {
            this._chancePairs++;
            /* A CERTAIN order is not a coin flip: p of exactly 1 means every candidate set this
             * engine still believes in outspeeds us, so the `theirs` subtree is the proven one and
             * is returned as it stands — a mate found that way IS a mate. Only a genuine mix is
             * blended, and only a blend is clamped. */
            if (p === 1) return theirs;
            if (p === 0) return mine;
            const blended = p * theirs + (1 - p) * mine;
            /* A MATE MAY NEVER BE MANUFACTURED BY A COIN FLIP. `solved` is claimed from the ROOT
             * value against the mate band, so a blend that lands inside that band would report a
             * "mate" the tree never proved. The clamp below keeps every chance-node value strictly
             * inside the non-mate region, which makes that structurally impossible rather than a
             * thing to remember. It cannot hide a real mate either: an order-independent one already
             * returned above, and a mate in only ONE of the two orders is not a mate. */
            const ceiling = WIN - MATE_BAND - 1;
            if (blended > ceiling) return ceiling;
            if (blended < -ceiling) return -ceiling;
            return blended;
          }
        }
        throw UNDECIDED;                               // the outcome is a function of a fact we lack
      }
      return this._afterTurn(this._applyPair(node, myAct, theirAct, order), depth, ply, alpha, beta);
    }

    /**
     * _oppFasterProbability(node, myAct, theirAct) -> P(they act first), or null.
     *
     * Move priority decides outright when the two moves differ (a priority move acts first whatever
     * the Speed is), and that answer is 0 or 1 with no uncertainty. Otherwise the probability is the
     * WEIGHTED share of their surviving candidate sets whose own maximum Speed beats ours: each set
     * carries the posterior weight the pruner gave it, an exact tie counts as a coin flip (0.5, which
     * is the rule Showdown plays by), and Trick Room INVERTS it because the slower body moves first
     * under it. Null means the question cannot be answered from what this engine has — our exact
     * Speed is unknown (no registered set), or they have no candidate pool — and the caller then
     * falls back to the refusal rather than inventing a number.
     */
    _oppFasterProbability(node, myAct, theirAct) {
      const U = ST.util || {};
      const myName = (myAct && myAct.name) || myAct;
      const theirName = (theirAct && theirAct.name) || theirAct;
      const myData = (myName && typeof U.getMoveData === 'function') ? U.getMoveData(myName) : null;
      const oppData = (theirName && typeof U.getMoveData === 'function') ? U.getMoveData(theirName) : null;
      const myPriority = (myData && typeof myData.priority === 'number') ? myData.priority : 0;
      const oppPriority = (oppData && typeof oppData.priority === 'number') ? oppData.priority : 0;
      if (myPriority !== oppPriority) return oppPriority > myPriority ? 1 : 0;
      const mySpeed = this._exactSpeed(this._active(node.my) && this._active(node.my).mon);
      const oppActive = this._active(node.opp);
      const mon = oppActive && oppActive.mon;
      if (mySpeed === null || !mon) return null;
      const pool = (mon.candidateSets && mon.candidateSets.length) ? mon.candidateSets
        : (mon.liveSet ? [mon.liveSet] : []);
      if (!pool.length || typeof U.maxSpeedForSet !== 'function') return null;
      let ahead = 0, total = 0;
      for (let i = 0; i < pool.length; i++) {
        const speed = U.maxSpeedForSet(pool[i]);
        if (!(typeof speed === 'number' && isFinite(speed) && speed > 0)) continue;
        const w = (typeof pool[i].weight === 'number' && pool[i].weight > 0) ? pool[i].weight : 1;
        total += w;
        if (speed > mySpeed) ahead += w;
        else if (speed === mySpeed) ahead += w * 0.5;
      }
      if (!(total > 0)) return null;
      const p = ahead / total;
      const tr = !!(node.field && node.field.trickRoom);
      return tr ? 1 - p : p;
    }

    /* ------------------------------------------------- the simultaneous turn solve */

    /**
     * `_turnValue` — the value of the position with `depth` plies left, our turn to move in a
     * SIMULTANEOUS turn. This is the `simultaneousPly` fix, and the shape of the fix matters:
     *
     *   - The full |ours| x |theirs| matrix is priced with FULL windows (so every cell is an exact
     *     value and the transposition cache is sound).
     *   - A strictly dominant pure row for us short-circuits (we play it; the value is its worst
     *     cell) and a strictly dominant pure column for them short-circuits likewise. A proof does
     *     not need to average anything, and this keeps the common single-action board exactly as
     *     cheap as it was.
     *   - Otherwise the turn is a small zero-sum matrix game and the value is its game value via
     *     regret matching, which is never below the maximin floor and never the "they read our
     *     mind" Stackelberg number. That is the whole point: a switch or a Protect chosen by the
     *     opponent here is chosen against our MIX, not against the card we are about to play.
     *
     * With `simultaneousPly` off this falls back to the historical `_myTurn` (pure maximin with
     * alpha-beta), so the leaf is a rebaseline of one number, not of the module's contract.
     */
    _turnValue(node, depth, ply, alpha, beta) {
      if (!this.simultaneousPly) return this._myTurn(node, depth, ply, alpha, beta);
      this._tick();
      const myActs = this._actionsFor(node, 'my');
      const oppActs = this._actionsFor(node, 'opp');
      const rows = myActs.length, cols = oppActs.length;
      const matrix = [];
      for (let i = 0; i < rows; i++) {
        const row = [];
        for (let j = 0; j < cols; j++) {
          row.push(this._resolvePair(node, myActs[i], oppActs[j], depth, ply, -Infinity, Infinity));
        }
        matrix.push(row);
      }
      const rowMin = function (i) {
        let m = Infinity;
        for (let j = 0; j < cols; j++) if (matrix[i][j] < m) m = matrix[i][j];
        return m;
      };
      let maximin = -Infinity;
      for (let i = 0; i < rows; i++) maximin = Math.max(maximin, rowMin(i));
      if (rows === 1 || cols === 1) return maximin;

      // A strictly dominant pure row for us: every cell strictly better than the same column in
      // every other row. Play it; the value is its worst cell.
      for (let i = 0; i < rows; i++) {
        let dom = true;
        for (let k = 0; k < rows && dom; k++) {
          if (k === i) continue;
          for (let j = 0; j < cols; j++) if (!(matrix[i][j] > matrix[k][j])) { dom = false; break; }
        }
        if (dom) return rowMin(i);
      }
      // A strictly dominant pure column for THEM (they minimise): our value is the best cell in it.
      for (let j = 0; j < cols; j++) {
        let dom = true;
        for (let k = 0; k < cols && dom; k++) {
          if (k === j) continue;
          for (let i = 0; i < rows; i++) if (!(matrix[i][j] < matrix[i][k])) { dom = false; break; }
        }
        if (dom) {
          let best = -Infinity;
          for (let i = 0; i < rows; i++) if (matrix[i][j] > best) best = matrix[i][j];
          return best;
        }
      }
      return Math.max(maximin, this._matrixGameValue(matrix, rows, cols));
    }

    /**
     * `_matrixGameValue` -> the maximin value of a zero-sum matrix game, by regret matching
     * (Hart & Mas-Colell). We maximise a mixed strategy, they minimise theirs, and no side may
     * condition on the other's realised action — which is the difference between this and the
     * Stackelberg number the old `_myTurn/_theirTurn` produced. Deterministic (uniform start, no
     * RNG), bounded by `regretIters`, and exact enough for a value whose scale is 1e6 with a mate
     * band of 1e3: the running average stabilises well inside a band that never crosses a terminal
     * region. A row/column that is never a good reply loses all its regret, which is what keeps a
     * pathological matrix from oscillating.
     */
    _matrixGameValue(matrix, rows, cols) {
      const iters = this.regretIters;
      const myRegret = new Array(rows).fill(0);
      const oppRegret = new Array(cols).fill(0);
      const mySum = new Array(rows).fill(0);
      const oppSum = new Array(cols).fill(0);
      let value = 0;
      for (let t = 0; t < iters; t++) {
        // current strategies from positive regret (uniform while all regrets are <= 0)
        let myTotal = 0, oppTotal = 0;
        for (let i = 0; i < rows; i++) { if (myRegret[i] > 0) myTotal += myRegret[i]; }
        for (let j = 0; j < cols; j++) { if (oppRegret[j] > 0) oppTotal += oppRegret[j]; }
        const myP = new Array(rows);
        const oppP = new Array(cols);
        for (let i = 0; i < rows; i++) myP[i] = myTotal > 0 ? (myRegret[i] > 0 ? myRegret[i] / myTotal : 0) : 1 / rows;
        for (let j = 0; j < cols; j++) oppP[j] = oppTotal > 0 ? (oppRegret[j] > 0 ? oppRegret[j] / oppTotal : 0) : 1 / cols;
        for (let i = 0; i < rows; i++) mySum[i] += myP[i];
        for (let j = 0; j < cols; j++) oppSum[j] += oppP[j];
        // payoffs against the other's current mix
        let ev = 0;
        for (let i = 0; i < rows; i++) {
          if (myP[i] === 0) continue;
          for (let j = 0; j < cols; j++) { if (oppP[j] !== 0) ev += myP[i] * oppP[j] * matrix[i][j]; }
        }
        value += ev;
        const myRowEv = new Array(rows).fill(0);
        const oppColEv = new Array(cols).fill(0);
        for (let i = 0; i < rows; i++) { let s = 0; for (let j = 0; j < cols; j++) s += oppP[j] * matrix[i][j]; myRowEv[i] = s; }
        for (let j = 0; j < cols; j++) { let s = 0; for (let i = 0; i < rows; i++) s += myP[i] * matrix[i][j]; oppColEv[j] = s; }
        for (let i = 0; i < rows; i++) myRegret[i] = Math.max(0, myRegret[i] + (myRowEv[i] - ev));
        for (let j = 0; j < cols; j++) oppRegret[j] = Math.max(0, oppRegret[j] + (ev - oppColEv[j]));
      }
      return value / iters;
    }

    /* ------------------------------------------------------------- legacy maximin */

    _myTurn(node, depth, ply, alpha, beta) {
      this._tick();
      const actions = this._actionsFor(node, 'my');
      let best = -Infinity;
      for (let i = 0; i < actions.length; i++) {
        const value = this._theirTurn(node, actions[i], depth, ply, alpha, beta);
        if (value > best) best = value;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      return best;
    }

    _theirTurn(node, myAct, depth, ply, alpha, beta) {
      this._tick();
      const actions = this._actionsFor(node, 'opp');
      let best = Infinity;
      for (let i = 0; i < actions.length; i++) {
        const value = this._resolvePair(node, myAct, actions[i], depth, ply, alpha, beta);
        if (value < best) best = value;
        if (best < beta) beta = best;
        if (alpha >= beta) break;
      }
      return best;
    }

    /* -------------------------------------------------------------------- leaf */

    _evaluateLeaf(node) {
      return this.evaluator.evaluate(this._leaf(node));
    }

    _leaf(node) {
      const state = this._source || {};
      const cloneBody = function (body) {
        if (!body || !body.mon) return null;
        const copy = Object.create(body.mon);
        copy.hp = body.hp;
        copy.hpPercent = body.hp;
        copy.fainted = body.hp <= 0;
        return copy;
      };
      const myBodies = node.my.bodies.map(cloneBody);
      const oppBodies = node.opp.bodies.map(cloneBody);
      const myActive = myBodies[node.my.active] || myBodies.filter(Boolean)[0] || null;
      const oppActive = oppBodies[node.opp.active] || oppBodies.filter(Boolean)[0] || null;
      return {
        myTeam: myBodies,
        oppTeam: oppBodies,
        active: { my: myActive, opp: oppActive },
        field: node.field,
        bench: state.bench,
        protect: state.protect,
        recoveryPP: state.recoveryPP,
        terastallizationBanned: state.terastallizationBanned,
        mySide: state.mySide,
        oppSide: state.oppSide
      };
    }

    /* --------------------------------------------------------- principal line */

    _bestActionAt(node, depth, ply) {
      const actions = this._actionsFor(node, 'my');
      let best = -Infinity, pick = null;
      for (let i = 0; i < actions.length; i++) {
        const value = this._theirTurn(node, actions[i], depth, ply, -Infinity, Infinity);
        if (value > best) { best = value; pick = actions[i]; }
      }
      return (pick && pick.kind === 'pass') ? null : pick;
    }

    _worstReplyAt(node, myAct, depth, ply) {
      const actions = this._actionsFor(node, 'opp');
      let best = Infinity, pick = null;
      for (let i = 0; i < actions.length; i++) {
        const value = this._resolvePair(node, myAct, actions[i], depth, ply, -Infinity, Infinity);
        if (value < best) { best = value; pick = actions[i]; }
      }
      return pick;
    }

    /**
     * Our actions along the searched best line, first action first. A pair whose order is
     * undecided ends the walk: the rest of the line would be a claim about a fact we do not have.
     */
    _principalLine(node, depth) {
      const U = ST.util || {};
      const line = [];
      let cur = node, remaining = depth, ply = 0, guard = 0;
      while (remaining > 0 && guard++ < 64) {
        if (this._aliveCount(cur.opp) === 0 || this._aliveCount(cur.my) === 0) break;
        const myAction = this._bestActionAt(cur, remaining, ply);
        if (!myAction) break;
        const theirAction = this._worstReplyAt(cur, myAction, remaining, ply);
        const order = this._orderFor(cur, myAction, theirAction);
        if (order === 'undecided') break;
        line.push({
          kind: 'move',
          name: myAction.name,
          moveId: (typeof U.toID === 'function') ? U.toID(myAction.name) : String(myAction.name).toLowerCase()
        });
        cur = this._applyPair(cur, myAction, theirAction, order);
        remaining -= 1;
        ply += 1;
      }
      return line;
    }
  }

  EndgameSolver.WIN = WIN;
  EndgameSolver.MATE_BAND = MATE_BAND;
  EndgameSolver.PASS = PASS;
  ST.EndgameSolver = EndgameSolver;
})();
