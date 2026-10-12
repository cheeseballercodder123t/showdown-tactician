/* Showdown Tactician — src/information_gain.js
 *
 * Information gain, measured instead of asserted: how many BITS of the opponent's fog a turn
 * would burn, and what that is worth as a payoff bounty.
 *
 * WHAT IS ACTUALLY MEASURABLE HERE
 *   The engine does not model a policy — it samples K worlds and enumerates replies — so there is
 *   no honest way to say "clicking Protect makes them reveal their set". What IS in the repository,
 *   already, is the fog itself: `mon.candidateSets` is the pool of sets that survived every
 *   deduction (src/set_pruner.js), each with a WEIGHT and the MOVES that set would have. The
 *   uncertainty of that pool is a real number, and Shannon entropy is the right one:
 *
 *       H = -sum_s  p_s * log2(p_s)        p_s = weight_s / sum(weight)
 *
 *   A pool of four equally likely sets is 2 bits of ignorance; a pool that has collapsed to one
 *   set is 0 bits. So the quantity this module produces is a property of the POOL, not a
 *   personality model: `before` is the fog now, `after` is the fog left once we have seen the
 *   opponent answer this turn, and `bits = before - after` is what the turn taught us.
 *
 * THE ONE ASSUMPTION, STATED PLAINLY
 *   To know how much an observation prunes, something has to say WHAT we would observe. This
 *   module assumes the observation is their BEST DAMAGING MOVE — the move the damage engine
 *   itself already ranks highest into our active body (never a hand-computed number, never a
 *   move-name rule). A candidate set is then eliminated exactly the way src/set_pruner.js
 *   eliminates one on a real reveal: if the set's known moves exclude the move we watched them
 *   use, that set could not have been the one. A set whose moves we do NOT know is never
 *   eliminated — an unknown set is not a disproved set. If a real answer differs from the assumed
 *   one, the bounty is simply paid on the wrong branch, which is why the whole tier is OFF by
 *   default (`laplace.scouting.enabled` is false) and capped by `laplace.scouting.maxBounty`.
 *
 * THREE REASONS A TURN REVEALS NOTHING (each named in `reason`)
 *   - 'move-set-already-known': every surviving candidate lists the same moves, so no answer can
 *     distinguish them (also true of a one-set pool). Scouting a body you have fully read is not
 *     a play, and must never pay a bounty.
 *   - 'body-faints-this-turn': our own best damaging move into the body is a GUARANTEED KO by the
 *     damage engine's own `isOHKO`, so the body does not get to answer at all.
 *   - 'observation-changes-nothing': the assumed answer is consistent with every candidate, so the
 *     pool does not shrink even though the pool is not fully known.
 *
 * WHAT IT IS ALLOWED TO CHANGE
 *   `bounty(action, state)` returns a payoff bounty in [0, laplace.scouting.maxBounty], scaled by
 *   the SHARE of the fog burned (bits / before). It is 0 while disabled, when the pool is already
 *   below `laplace.scouting.minEntropy`, when nothing would be learned, and when no damage engine
 *   was supplied. Nothing in here mutates its arguments and nothing here is random.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});

  // Rule 4: the tunables live in src/config.js; these literals are the standalone fallback.
  const cfg = typeof ST.configGet === 'function' ? ST.configGet : function (path, fallback) { return fallback; };
  const U = ST.util || null;

  const log2 = Math.log2 || function (x) { return Math.log(x) / Math.LN2; };

  function idOf(value) {
    if (U && typeof U.toID === 'function') return U.toID(value);
    return String(value === undefined || value === null ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  /** The weight of every candidate set as a plain array (0 for a missing/negative weight). */
  function weightsOf(sets) {
    const out = [];
    if (!Array.isArray(sets)) return out;
    for (let i = 0; i < sets.length; i++) {
      const w = sets[i] ? num(sets[i].weight) : null;
      out.push(w !== null && w > 0 ? w : 0);
    }
    return out;
  }

  /** The moves a candidate set is known to have, as ids. Empty means "not known", not "none". */
  function movesOf(set) {
    const list = set && set.moves;
    if (!Array.isArray(list)) return [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const id = idOf(list[i]);
      if (id && out.indexOf(id) === -1) out.push(id);
    }
    return out;
  }

  class InformationGain {
    constructor(options) {
      const opts = options || {};
      this.enabled = opts.enabled === undefined
        ? cfg('laplace.scouting.enabled', false) === true
        : opts.enabled === true;
      const maxBounty = opts.maxBounty === undefined ? num(cfg('laplace.scouting.maxBounty', 0)) : num(opts.maxBounty);
      const minEntropy = opts.minEntropy === undefined ? num(cfg('laplace.scouting.minEntropy', 0.05)) : num(opts.minEntropy);
      this.maxBounty = maxBounty === null || maxBounty < 0 ? 0 : maxBounty;
      this.minEntropy = minEntropy === null || minEntropy < 0 ? 0.05 : minEntropy;
      // The damage engine is REQUIRED for the answer model, and never built here: a module that
      // quietly constructed its own calculator would hide a missing wiring behind plausible
      // numbers. With none supplied every answer is refused, not guessed.
      this.damage = opts.damage || null;
    }

    /* ----------------------------------------------------------------- bits */

    /** Shannon entropy in bits of a weight vector. 0 for an empty or degenerate vector. */
    entropy(weights) {
      if (!Array.isArray(weights) || !weights.length) return 0;
      let total = 0;
      for (let i = 0; i < weights.length; i++) {
        const w = num(weights[i]);
        if (w !== null && w > 0) total += w;
      }
      if (!(total > 0)) return 0;
      let h = 0;
      for (let i = 0; i < weights.length; i++) {
        const w = num(weights[i]);
        if (w === null || w <= 0) continue;
        // A zero-weight entry carries no probability, so it contributes nothing rather than
        // dragging a log(0) into the sum.
        h -= (w / total) * log2(w / total);
      }
      return h;
    }

    /** The fog on one body: entropy of its surviving candidate pool, plus the pool itself. */
    candidateEntropy(mon) {
      const sets = mon && Array.isArray(mon.candidateSets) ? mon.candidateSets : [];
      const weights = weightsOf(sets);
      return { bits: this.entropy(weights), sets: sets.length, weights: weights };
    }

    /* ------------------------------------------------------------- the answer */

    /** Their moves, in the engine's own order of authority (same ladder laplace_core uses). */
    _movesFor(mon) {
      const m = mon || {};
      if (Array.isArray(m.setMoves) && m.setMoves.length) return m.setMoves.slice();
      if (m.liveSet && Array.isArray(m.liveSet.moves) && m.liveSet.moves.length) return m.liveSet.moves.slice();
      if (Array.isArray(m.revealedMoves) && m.revealedMoves.length) return m.revealedMoves.slice();
      return [];
    }

    /** The damage-maximising KNOWN move of `attacker` into `defender`, or null. */
    _bestDamage(attacker, defender, state) {
      if (!this.damage || !attacker || !defender) return null;
      const moves = this._movesFor(attacker);
      const field = (state && state.field) || null;
      let best = null;
      for (let i = 0; i < moves.length; i++) {
        let res = null;
        try { res = this.damage.calculateDamage(attacker, defender, moves[i], field); } catch (e) { res = null; }
        if (!res || res.failed || !(res.avgPercent > 0)) continue;
        if (!best || res.avgPercent > best.res.avgPercent) best = { move: moves[i], id: idOf(moves[i]), res: res };
      }
      return best;
    }

    /** The answer we assume we would observe: their best damaging move, as an id. */
    _assumedResponse(opp, mine, state) {
      const best = this._bestDamage(opp, mine, state);
      return best ? best.id : null;
    }

    /** Does every surviving candidate list the SAME known moves? Then no answer can separate them. */
    _poolFullyKnown(sets) {
      if (!Array.isArray(sets) || sets.length <= 1) return true;
      let signature = null;
      for (let i = 0; i < sets.length; i++) {
        const known = movesOf(sets[i]);
        if (!known.length) return false;                       // an unknown set can always be narrowed
        const sorted = known.slice().sort().join('|');
        if (signature === null) signature = sorted;
        else if (signature !== sorted) return false;
      }
      return true;
    }

    /** Would the body be gone before it answers? Our own best line, the engine's own isOHKO. */
    _doomed(opp, mine, state) {
      const best = this._bestDamage(mine, opp, state);
      return !!(best && best.res && best.res.isOHKO === true);
    }

    /* ------------------------------------------------------------ the readout */

    /**
     * gainFor(action, state) -> { bits, before, after, reveals, response, kept, sets, reason }
     *   bits     = before - after, never negative
     *   before   = bits of fog on the opponent's active body right now
     *   after    = bits of fog left once the assumed answer has ruled sets out
     *   reveals  = this turn would TEACH us something (false for the three reasons in the header)
     *   response = the move the answer is assumed to be (an id), or null
     *   kept     = candidate sets the observation leaves standing
     * `action` is our own line (getMyActions shape); it is not itself scored here — the pool is
     * what carries the uncertainty — but it must be passed for a coercible readout and it is
     * reported back for the caller's HUD row.
     */
    gainFor(action, state) {
      const out = {
        bits: 0, before: 0, after: 0, reveals: false,
        response: null, kept: 0, sets: 0, reason: null
      };
      const s = state || {};
      const opp = s.active && s.active.opp;
      const mine = s.active && s.active.my;
      if (!opp) { out.reason = 'no-opponent-active'; return out; }
      const sets = Array.isArray(opp.candidateSets) ? opp.candidateSets : [];
      out.sets = sets.length;
      out.kept = sets.length;
      out.before = this.entropy(weightsOf(sets));
      out.after = out.before;

      const response = this._assumedResponse(opp, mine, s);
      out.response = response;
      if (!response) { out.reason = 'no-response-model'; return out; }

      const kept = [];
      for (let i = 0; i < sets.length; i++) {
        const known = movesOf(sets[i]);
        if (known.length && known.indexOf(response) === -1) continue;   // disproved by the answer
        kept.push(sets[i]);
      }
      out.kept = kept.length;
      out.after = this.entropy(weightsOf(kept));
      out.bits = Math.max(0, out.before - out.after);

      if (this._poolFullyKnown(sets)) { out.reason = 'move-set-already-known'; return out; }
      if (this._doomed(opp, mine, s)) { out.reason = 'body-faints-this-turn'; return out; }
      if (!(out.bits > 0)) { out.reason = 'observation-changes-nothing'; return out; }
      out.reveals = true;
      return out;
    }

    /**
     * bounty(action, state) -> [0, laplace.scouting.maxBounty]
     * The SHARE of the remaining fog a turn would burn, times the ceiling. 0 while disabled, when
     * the pool is already below `minEntropy`, when nothing would be learned, or with no damage
     * engine to build the answer from.
     */
    bounty(action, state) {
      if (!this.enabled) return 0;
      if (!this.damage) return 0;
      if (!(this.maxBounty > 0)) return 0;
      const g = this.gainFor(action, state);
      if (!g.reveals || !(g.bits > 0) || !(g.before >= this.minEntropy)) return 0;
      const share = g.bits / g.before;
      if (!isFinite(share) || share <= 0) return 0;
      return Math.min(this.maxBounty, this.maxBounty * Math.min(1, share));
    }
  }

  InformationGain.log2 = log2;
  ST.InformationGain = InformationGain;
})();
