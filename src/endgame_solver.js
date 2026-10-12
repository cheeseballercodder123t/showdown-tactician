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
 *     - more than `maxBodies` living bodies on either side,
 *     - no damage engine or no leaf evaluator,
 *     - no modelled move for either ACTIVE body,
 *     - the node budget exhausted mid-search ({solved:false, reason:'budget'}, never a partial
 *       line presented as a solution),
 *     - a board whose action order cannot be decided AND whose outcome depends on it,
 *     - a move the damage engine cannot price.
 *   Those last two are the important ones. "Who moves first" is decided by move priority and then
 *   by measured Speed; when the two Speed bounds OVERLAP (the opponent's set is not pinned) the
 *   pair is searched BOTH ways and the result is used only if the two orders agree. If they
 *   disagree, the outcome is a function of a fact this engine does not have, and guessing it would
 *   be exactly the dishonesty the rest of the repository refuses. The question is asked at EVERY
 *   pair the search visits, so ONE undecided pair anywhere in the tree refuses the whole solve:
 *   a proof is only ever as strong as its weakest branch, and a mate reported through a branch
 *   that might have gone the other way is not a mate. The consequence to expect: a near-mirror
 *   endgame with unpinned Speed refuses even though the two bodies look identical, because at
 *   some depth "who is inside one hit of fainting" becomes the whole question.
 *
 * WHAT IS MODELLED, AND WHAT IS DELIBERATELY NOT
 *   - One turn = both bodies act once, ordered by (priority, Speed). Their reply is chosen
 *     adversarially (a minimax over the turn matrix), NOT as a mixed equilibrium: this is the
 *     Stackelberg-style worst case, which is conservative for us and has no parameter to tune.
 *   - Only DAMAGING moves are actions (`U.getMoveData(name)` with basePower > 0). A body whose
 *     known moves are all status/Protect/recovery does not act in this model; if the ROOT bodies
 *     are in that state the solve refuses instead.
 *   - NOT modelled, and named here so nobody reads more into a mate than it says: accuracy and
 *     critical hits (the damage engine's AVERAGE is used), PP, stat boosts, Protect, Substitute,
 *     status moves, weather/terrain changes, hazard chip on a replacement, items that trigger on a
 *     hit, and abilities that fire between hits. Every damage number that IS used comes from
 *     `ST.DamageEngine.calculateDamage` — this file contains no damage formula, no type chart and
 *     no species rule (src/blackbox_guard.js is the rule that keeps it that way).
 *   - A fainted body is replaced by the healthiest surviving one (ties by name), deterministically
 *     and without searching over the choice.
 *
 * PURITY. The node objects below are this file's own scratch structures; `state` and `world` are
 * read, never written, and the leaf handed to the evaluator is built from `Object.create` clones
 * with their OWN `hp`/`hpPercent`/`fainted` — the same contract `_leafState` in laplace_core.js
 * keeps, and the reason a clone must own any field it changes.
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
      this.maxBodies = intOr(o.maxBodies, cfg('laplace.endgame.maxBodies', 2));
      this.maxDepth = intOr(o.maxDepth, cfg('laplace.endgame.maxDepth', 10));
      this.nodeBudget = intOr(o.nodeBudget, cfg('laplace.endgame.nodeBudget', 20000));
      // An explicit null must be HONOURED (the refusal path for "no engine" is part of the
      // contract), so this is `!== undefined`, not `||`.
      this.damage = o.damage !== undefined ? o.damage : (ST.DamageEngine ? new ST.DamageEngine({ gen: 9 }) : null);
      this.evaluator = o.evaluator !== undefined ? o.evaluator : (ST.DenseStateEvaluator ? new ST.DenseStateEvaluator() : null);
      this._nodes = 0;
      this.lastReport = null;
    }

    /* ------------------------------------------------------------------ public */

    /**
     * solve(state, world) -> EndgameResult | null
     *   { solved, reason, depth, mateIn, line, score, nodes }
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
      if (node.my.bodies.length > this.maxBodies) return this._refuse('too-many-bodies-mine');
      if (node.opp.bodies.length > this.maxBodies) return this._refuse('too-many-bodies-theirs');
      const myMoves = this._movesOf(this._active(node.my) && this._active(node.my).mon);
      const oppMoves = this._movesOf(this._active(node.opp) && this._active(node.opp).mon);
      if (!myMoves.length) return this._refuse('no-modelled-move-mine');
      if (!oppMoves.length) return this._refuse('no-modelled-move-theirs');

      this._nodes = 0;
      this._source = state;
      let value = null, line = [];
      try {
        value = this._myTurn(node, this.maxDepth, 0, -Infinity, Infinity);
        line = this._principalLine(node, this.maxDepth);
      } catch (e) {
        if (e === BUDGET) return this._finish({ solved: false, reason: 'budget', depth: this.maxDepth, mateIn: null, line: [], score: null, nodes: this._nodes });
        if (e === UNDECIDED) return this._refuse('speed-undecided', this._nodes);
        if (e === UNPRICED) return this._refuse('unpriceable-move', this._nodes);
        throw e;
      }
      const mateTurns = value >= WIN - MATE_BAND ? WIN - value : null;
      const matedTurns = value <= -(WIN - MATE_BAND) ? WIN + value : null;
      return this._finish({
        solved: mateTurns !== null,
        reason: mateTurns !== null ? 'mate' : (matedTurns !== null ? 'mated' : 'no-forced-win'),
        depth: this.maxDepth,
        mateIn: mateTurns,
        line: line,
        score: value,
        nodes: this._nodes
      });
    }

    /* ----------------------------------------------------------------- results */

    _refuse(reason, nodes) {
      const report = {
        solved: false, reason: reason, depth: 0, mateIn: null,
        line: [], score: null, nodes: nodes || 0
      };
      this.lastReport = report;
      return null;
    }

    _finish(report) {
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
      return {
        my: { bodies: myBodies, active: activeIndex(myBodies, state.active && state.active.my) },
        opp: { bodies: oppBodies, active: activeIndex(oppBodies, worldActive || (state.active && state.active.opp)) },
        field: state.field || {}
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
      return { my: copySide(node.my), opp: copySide(node.opp), field: node.field };
    }

    /** A fainted active is replaced by the healthiest survivor (ties by name) — deterministic. */
    _replaceFainted(side) {
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
    }

    /* ------------------------------------------------------------------ actions */

    /** Their damaging moves (deduped, at most four — a set is four moves). */
    _movesOf(mon) {
      const U = ST.util || {};
      if (!mon || typeof U.getMoveData !== 'function') return [];
      const list = (mon.setMoves && mon.setMoves.length) ? mon.setMoves
        : (mon.liveSet && mon.liveSet.moves) ? mon.liveSet.moves
          : (mon.revealedMoves) ? mon.revealedMoves : [];
      const out = [];
      for (let i = 0; i < list.length && out.length < 4; i++) {
        const name = list[i];
        if (!name) continue;
        const data = U.getMoveData(name);
        if (!data || data.isStatus || !(data.basePower > 0)) continue;
        if (out.indexOf(name) === -1) out.push(name);
      }
      return out;
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
      if (pool.length && typeof U.maxSpeedForSet === 'function') {
        for (let i = 0; i < pool.length; i++) {
          const speed = U.maxSpeedForSet(pool[i]);
          if (!(typeof speed === 'number' && isFinite(speed) && speed > 0)) continue;
          if (speed < max) max = speed;
        }
      }
      return { min: min, max: max };
    }

    /**
     * Who acts first in this (ours, theirs) pair: move priority decides, then measured Speed.
     * 'undecided' is returned when the Speed ranges overlap — the caller then resolves it both
     * ways rather than picking one.
     */
    _orderFor(node, myName, theirName) {
      const U = ST.util || {};
      const myData = (typeof U.getMoveData === 'function') ? U.getMoveData(myName) : null;
      const oppData = (typeof U.getMoveData === 'function') ? U.getMoveData(theirName) : null;
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

    /** Price one hit and write the result into a fresh node (the source node is never touched). */
    _applyHit(node, side, moveName) {
      const next = this._cloneNode(node);
      this._tick();
      if (!moveName) return next;                       // a body with no modelled attack: it passes
      const attackerSide = next[side];
      const defenderSide = next[side === 'my' ? 'opp' : 'my'];
      const attacker = this._active(attackerSide);
      const defender = this._active(defenderSide);
      if (!attacker || !defender) return next;
      const res = this._hit(attacker.mon, defender.mon, moveName, next.field, attacker.hp, defender.hp);
      if (!res) throw UNPRICED;
      const after = clamp(defender.hp - (res.avgPercent || 0), 0, 100);
      defender.hp = after;
      if (after <= 0) this._replaceFainted(defenderSide);
      return next;
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

    /** Both sides act once, in `order`, then the resulting position is searched or evaluated. */
    _applyPair(node, myName, theirName, order) {
      let cur = node;
      const acts = order === 'my' ? [['my', myName], ['opp', theirName]] : [['opp', theirName], ['my', myName]];
      for (let i = 0; i < acts.length; i++) {
        const side = acts[i][0], name = acts[i][1];
        if (this._aliveCount(cur[side]) === 0) continue;
        cur = this._applyHit(cur, side, name);
      }
      return cur;
    }

    _afterTurn(node, depth, ply, alpha, beta) {
      this._tick();
      if (this._aliveCount(node.opp) === 0) return WIN - (ply + 1);
      if (this._aliveCount(node.my) === 0) return -(WIN - (ply + 1));
      const next = depth - 1;
      if (next <= 0) return this._evaluateLeaf(node);
      return this._myTurn(node, next, ply + 1, alpha, beta);
    }

    _resolvePair(node, myName, theirName, depth, ply, alpha, beta) {
      const order = this._orderFor(node, myName, theirName);
      if (order === 'undecided') {
        // The comparison below asks a QUESTION, so it must not be answered with a pruned bound: a
        // fail-low returns alpha and a fail-high returns beta, so two subtrees with the SAME true
        // score can come back different (one exact, one clamped) and an order-independent pair
        // would read as undecided — this rail refusing a position it can actually prove, which is
        // the opposite of what it is for. Hence the full window on both calls.
        const mine = this._afterTurn(this._applyPair(node, myName, theirName, 'my'),
          depth, ply, -Infinity, Infinity);
        const theirs = this._afterTurn(this._applyPair(node, myName, theirName, 'opp'),
          depth, ply, -Infinity, Infinity);
        if (mine === theirs) return mine;              // order-independent, so the pair IS decided
        throw UNDECIDED;                               // the outcome is a function of a fact we lack
      }
      return this._afterTurn(this._applyPair(node, myName, theirName, order), depth, ply, alpha, beta);
    }

    _actionsFor(side) {
      const active = this._active(side);
      const moves = this._movesOf(active && active.mon);
      // A body whose known moves are all status cannot be priced as an attack, so it passes its
      // turn here rather than being given an invented move. The ROOT case is a refusal instead.
      return moves.length ? moves : [null];
    }

    _myTurn(node, depth, ply, alpha, beta) {
      this._tick();
      const actions = this._actionsFor(node.my);
      let best = -Infinity;
      for (let i = 0; i < actions.length; i++) {
        const value = this._theirTurn(node, actions[i], depth, ply, alpha, beta);
        if (value > best) best = value;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      return best;
    }

    _theirTurn(node, myName, depth, ply, alpha, beta) {
      this._tick();
      const actions = this._actionsFor(node.opp);
      let best = Infinity;
      for (let i = 0; i < actions.length; i++) {
        const value = this._resolvePair(node, myName, actions[i], depth, ply, alpha, beta);
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
      const actions = this._actionsFor(node.my);
      let best = -Infinity, pick = null;
      for (let i = 0; i < actions.length; i++) {
        const value = this._theirTurn(node, actions[i], depth, ply, -Infinity, Infinity);
        if (value > best) { best = value; pick = actions[i]; }
      }
      return pick;
    }

    _worstReplyAt(node, myName, depth, ply) {
      const actions = this._actionsFor(node.opp);
      let best = Infinity, pick = null;
      for (let i = 0; i < actions.length; i++) {
        const value = this._resolvePair(node, myName, actions[i], depth, ply, -Infinity, Infinity);
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
        const theirAction = this._worstReplyAt(cur, myAction, remaining, ply);
        const order = this._orderFor(cur, myAction, theirAction);
        if (order === 'undecided') break;
        if (myAction) {
          line.push({
            kind: 'move',
            name: myAction,
            moveId: (typeof U.toID === 'function') ? U.toID(myAction) : String(myAction).toLowerCase()
          });
        }
        cur = this._applyPair(cur, myAction, theirAction, order);
        remaining -= 1;
        ply += 1;
      }
      return line;
    }
  }

  EndgameSolver.WIN = WIN;
  EndgameSolver.MATE_BAND = MATE_BAND;
  ST.EndgameSolver = EndgameSolver;
})();
