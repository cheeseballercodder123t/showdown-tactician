/* Showdown Tactician — src/tempo_vector.js
 * Tier 2 of the hybrid architecture: the 10-dimensional macro-momentum vector that models
 * the Protect / Baneful Bunker stall rhythm (Part 2, Module 10).
 *
 *   v1  Trick Room urgency          trTurnsLeft / 5
 *   v2  Board initiative            1 guaranteed KO available, 0 facing one
 *   v3  Protect decay               failure probability of a repeated Protect
 *   v4  Stall rhythm likelihood     probability the opponent clicks Protect THIS turn
 *   v5  Threat delta                our max damage% - their max damage%
 *   v6  Switch pressure             1 when they have a clean resist/immunity switch in
 *   v7  Passive chip delta          net per-turn hazard + status chip, normalised
 *   v8  Setter health factor        living TR setters / total TR setters
 *   v9  Active win-con health       HP% of the designated sweeper
 *   v10 Wasted turn cost            urgency penalty ((6 - trTurnsLeft) / 5)
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;

  /**
   * Heuristic tunables. RULE 4: every one of these numbers lives in src/config.js — this is
   * the only accessor for them, and the second argument is the fallback used solely when the
   * config module is absent. They are read per call rather than cached at load, so a runtime
   * config change takes effect on the very next decision.
   */
  function T(key, fallback) {
    return typeof ST.configGet === 'function' ? ST.configGet('tempo.' + key, fallback) : fallback;
  }

  const SETUP_IDS = U.SETUP_MOVES;
  const PROTECT_IDS = U.PROTECT_MOVES;

  class TempoEngine {
    constructor(options) {
      options = options || {};
      this.damage = options.damage || null;
      this.trickRoom = options.trickRoom || null;
      this.last = null;
      this._vec = new Float32Array(10);
    }

    /* ------------------------------------------------------------- vector */

    /** computeVector(state) -> { v1..v10, dims:Float32Array(10), stallIndex } */
    computeVector(state) {
      const v = this._vec;
      const s = state || {};
      const field = s.field || {};
      const my = s.active ? s.active.my : null;
      const opp = s.active ? s.active.opp : null;
      const turnsLeft = field.trickRoom ? U.clamp(field.trickRoomTurnsLeft || 0, 0, 5) : 0;

      // The dims are computed as plain doubles and only then mirrored into the Float32
      // buffer: consumers that read a single dimension (the veto guard, the HUD, the LLM
      // payload) must see the exact value, not its 32-bit rounding.
      const dims = [
        field.trickRoom ? turnsLeft / 5 : 0,                       // v1  TR urgency
        this._initiative(s, my, opp),                              // v2  board initiative
        this.protectDecay(s.protect || {}, 'opp'),                 // v3  Protect decay
        this.predictProtect(s, 'opp'),                             // v4  stall rhythm
        this._threatDelta(s, my, opp),                             // v5  threat delta
        this._switchPressure(s, opp),                              // v6  switch pressure
        this._chipDelta(s),                                        // v7  passive chip delta
        this._setterHealth(s),                                     // v8  setter health
        this._winconHealth(s),                                     // v9  win-con health
        field.trickRoom ? U.clamp((6 - turnsLeft) / 5, 0, 1) : 0   // v10 wasted turn cost
      ];
      for (let i = 0; i < dims.length; i++) v[i] = dims[i];

      const result = {
        v1: dims[0], v2: dims[1], v3: dims[2], v4: dims[3], v5: dims[4],
        v6: dims[5], v7: dims[6], v8: dims[7], v9: dims[8], v10: dims[9],
        dims: v,
        stallIndex: U.round2(dims[3]),
        protectPredicted: dims[3] > T('bunkerThreshold', 0.7),
        trUrgent: dims[0] > 0
      };
      this.last = result;
      return result;
    }

    _initiative(state, my, opp) {
      if (!my || !opp) return 0;
      if (!this.damage) return 0.5;
      try {
        const out = this.damage.getBestOutgoingMove(my, opp, state.field);
        const incoming = this.damage.getBestIncomingThreat(opp, my, state.field);
        const myKO = out && out.isOHKO ? 1 : 0;
        const theirKO = incoming && incoming.isOHKO ? 1 : 0;
        if (myKO && !theirKO) return 1;
        if (theirKO && !myKO) return 0;
        const mine = out ? out.avgPercent : 0;
        const theirs = incoming ? incoming.avgPercent : 0;
        return U.clamp(0.5 + (mine - theirs) / T('initiativeScale', 200), 0, 1);
      } catch (e) { return 0.5; }
    }

    /** Consecutive-Protect decay: how likely the next Protect fails. */
    protectDecay(protect, side) {
      const prefix = side === 'p1' ? 'my' : 'opp';
      const consecutive = (protect && protect[prefix + 'ConsecutiveProtects']) || 0;
      if (consecutive <= 0) return T('protectFresh', 0.0);
      if (consecutive === 1) return T('protectAfterOne', 0.67);
      return T('protectAfterTwo', 0.89);
    }

    /**
     * predictProtect(state, side) — probability that `side` clicks Protect/Bunker this turn.
     * The attack -> Recover -> Bunker rhythm is the single most exploitable pattern.
     */
    predictProtect(state, side) {
      const s = state || {};
      const protect = s.protect || {};
      const prefix = side === 'p1' ? 'my' : 'opp';
      const since = typeof protect[prefix + 'TurnsSinceLastProtect'] === 'number'
        ? protect[prefix + 'TurnsSinceLastProtect'] : 99;
      const mon = side === 'p1' ? (s.active && s.active.my) : (s.active && s.active.opp);
      if (!mon) return 0;
      const hp = this._hp(mon);
      const field = s.field || {};
      let base;
      if (since === 0) base = T('rhythmNone', 0.08);
      else if (since === 1 && hp < T('hurtHpBelow', 70)) base = T('rhythmHurt', 0.85);
      else base = T('rhythmDefault', 0.35);

      // A Protect inside the last two turns is itself proof that this Pokémon has the move,
      // so the "can it even Protect?" discount below must not apply to an observed rhythm.
      const observedProtect = since >= 0 && since <= 1;

      // Modifiers: a Protect holder that must buy time is far more likely to click it.
      const healthy = hp > T('healthyHpAbove', 85);
      if (healthy && since >= 2) base -= T('healthyPenalty', 0.12);
      if (field.trickRoom && since >= 1) base += T('trickRoomBonus', 0.08);   // stalling out TR turns
      const protectPP = this._protectPP(mon);
      if (protectPP === 0) base = 0;
      if (!observedProtect && !this._canProtect(mon)) base *= T('cannotProtectPenalty', 0.25);
      if (protect[prefix + 'ProtectedLastTurn'] && since === 1) base += T('observedProtectBonus', 0.05);
      return U.clamp(base, 0, T('maxProtectProbability', 0.95));
    }

    _canProtect(mon) {
      if (!mon) return false;
      if (mon.revealedMoves && mon.revealedMoves.some(function (m) { return PROTECT_IDS.has(U.toID(m)); })) return true;
      if (mon.liveSet && mon.liveSet.moves && mon.liveSet.moves.some(function (m) { return PROTECT_IDS.has(U.toID(m)); })) return true;
      if (mon.candidateSets && mon.candidateSets.length) {
        return mon.candidateSets.some(function (set) {
          return set.moves && set.moves.some(function (m) { return PROTECT_IDS.has(U.toID(m)); });
        });
      }
      // Nothing revealed yet: assume a bulky Pokémon can Protect, a frail one probably cannot.
      const bs = U.baseStats(mon.species || mon.id);
      return (bs.hp + bs.def + bs.spd) > T('bulkThreshold', 280);
    }

    _protectPP(mon) {
      if (!mon || !mon.movePP) return null;
      const keys = Object.keys(mon.movePP);
      for (let i = 0; i < keys.length; i++) {
        if (PROTECT_IDS.has(U.toID(keys[i]))) return mon.movePP[keys[i]];
      }
      return null;
    }

    _threatDelta(state, my, opp) {
      if (!my || !opp) return 0;
      if (!this.damage) return 0;
      try {
        const out = this.damage.getBestOutgoingMove(my, opp, state.field);
        const incoming = this.damage.getBestIncomingThreat(opp, my, state.field);
        const mine = out ? out.avgPercent : 0;
        const theirs = incoming ? incoming.avgPercent : 0;
        return U.clamp((mine - theirs) / T('threatScale', 100), -1, 1);
      } catch (e) { return 0; }
    }

    /** 1 when the opponent bench has a Pokémon that resists or is immune to our best move. */
    _switchPressure(state, opp) {
      if (!opp) return 0;
      const bench = (state.bench && state.bench.opp) || (state.oppTeam || []).filter(function (m) {
        return m && !m.fainted && m !== opp;
      });
      if (!bench.length) return 0;
      const my = state.active ? state.active.my : null;
      let ourType = null;
      if (my) {
        const moves = (my.revealedMoves && my.revealedMoves.length) ? my.revealedMoves : ((my.liveSet && my.liveSet.moves) || []);
        let best = null, bestBP = 0;
        for (let i = 0; i < moves.length; i++) {
          const data = U.getMoveData(moves[i]);
          if (!data || data.isStatus) continue;
          if (data.basePower > bestBP) { bestBP = data.basePower; best = data.type; }
        }
        ourType = best || U.getTypes(my.species || my.id)[0];
      }
      if (!ourType) return 0;
      for (let i = 0; i < bench.length; i++) {
        const mon = bench[i];
        if (!mon) continue;
        const eff = U.typeEffectiveness(ourType, mon.species || mon.id);
        if (eff <= T('resistThreshold', 0.5)) return 1;
      }
      return 0;
    }

    _chipDelta(state) {
      const field = state.field || {};
      const hazards = field.hazards || {};
      const cost = function (h) {
        if (!h) return 0;
        return (h.rocks ? T('chip.rocks', 12.5) : 0) +
          ((h.spikes || 0) * T('chip.spikesPerLayer', 8.3)) +
          ((h.toxicspikes || 0) * T('chip.toxicSpikes', 12.5)) +
          (h.stickyweb ? T('chip.stickyWeb', 8) : 0);
      };
      const mine = cost(hazards[state.mySide || 'p1']);
      const theirs = cost(hazards[state.oppSide || 'p2']);
      const statusCost = function (team) {
        let total = 0;
        (team || []).forEach(function (mon) {
          if (!mon || mon.fainted) return;
          if (mon.status === 'tox') total += T('chip.toxBase', 12.5) * Math.max(1, mon.toxicCounter || 1) / T('chip.toxicTurnsDivisor', 6);
          else if (mon.status === 'brn') total += T('chip.burn', 6.25);
        });
        return total;
      };
      const myChip = statusCost(state.myTeam);
      const oppChip = statusCost(state.oppTeam);
      const delta = (theirs + oppChip) - (mine + myChip);
      return U.clamp(delta / T('chip.scale', 50), -1, 1);
    }

    _setterHealth(state) {
      if (this.trickRoom && typeof this.trickRoom.setterHealth === 'function') {
        return this.trickRoom.setterHealth(state);
      }
      const team = (state && state.myTeam) || [];
      const setters = team.filter(function (mon) {
        if (!mon) return false;
        if (mon.revealedMoves && mon.revealedMoves.some(function (m) { return U.toID(m) === 'trickroom'; })) return true;
        if (mon.liveSet && mon.liveSet.moves && mon.liveSet.moves.some(function (m) { return U.toID(m) === 'trickroom'; })) return true;
        return U.TR_SETTERS.has(U.toID(mon.species || mon.id));
      });
      if (!setters.length) return 0;
      return setters.filter(function (m) { return !m.fainted; }).length / setters.length;
    }

    _winconHealth(state) {
      const my = state.active ? state.active.my : null;
      if (my) return U.clamp(this._hp(my) / 100, 0, 1);
      const team = (state.myTeam || []).filter(function (m) { return m && !m.fainted; });
      if (!team.length) return 0;
      return U.clamp(Math.max.apply(null, team.map(this._hp)) / 100, 0, 1);
    }

    _hp(mon) {
      if (!mon) return 0;
      let hp = mon.hpPercent;
      if (hp === null || hp === undefined) hp = mon.hp;
      if (hp === null || hp === undefined || hp !== hp) return T('safeHpDefault', 60);
      return hp;
    }

    /* ------------------------------------------------------------- policy mask */

    /**
     * applyPolicyMask(scoredActions, tempoVector, state)
     * Mutates a shallow copy of each action and returns the same array.
     *   v4 above tempo.bunkerThreshold with TR active -> scale direct contact damage by
     *   (1 - v4) and add tempo.bunkerMaskBonus to Protect, setup moves and slow pivots.
     */
    applyPolicyMask(scoredActions, tempoVector, state) {
      const actions = Array.isArray(scoredActions) ? scoredActions : [];
      const tv = tempoVector || this.last || this.computeVector(state);
      const protectProb = tv && typeof tv.v4 === 'number' ? tv.v4 : 0;
      const trActive = !!(state && state.field && state.field.trickRoom);
      if (!(protectProb > T('bunkerThreshold', 0.7) && trActive)) {
        return actions.map(function (a) { return a; });
      }
      const scale = U.clamp(1 - protectProb, 0, 1);
      const out = [];
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        if (!action) continue;
        const copy = Object.assign({}, action);
        const moveId = U.toID(action.moveId || action.name || '');
        const data = U.getMoveData(action.name || action.moveId);
        const isProtect = action.kind === 'protect' || PROTECT_IDS.has(moveId);
        const isSetup = SETUP_IDS.has(moveId);
        const isSlowPivot = moveId === 'teleport' || moveId === 'chillyreception' || moveId === 'partingshot' || moveId === 'batonpass';
        const isContactAttack = !!(data && !data.isStatus && data.basePower > 0 && data.makesContact);
        if (isProtect || isSetup || isSlowPivot) {
          copy.score = (copy.score || 0) + T('bunkerMaskBonus', 80);
          copy.policyMask = 'protect-rhythm-bonus';
        } else if (isContactAttack) {
          copy.score = (copy.score || 0) * scale;
          copy.policyMask = 'bunker-contact-penalty';
        }
        out.push(copy);
      }
      return out;
    }

    /** Convenience: does the mask consider this turn a Bunker turn? */
    isBunkerTurn(tempoVector, state) {
      const tv = tempoVector || this.last || this.computeVector(state);
      return !!(tv && tv.v4 > T('bunkerThreshold', 0.7) && state && state.field && state.field.trickRoom);
    }
  }

  // Frozen static mirrors of the tunables (read from src/config.js at load).
  TempoEngine.PROTECT_FRESH = T('protectFresh', 0.0);
  TempoEngine.PROTECT_AFTER_ONE = T('protectAfterOne', 0.67);
  TempoEngine.PROTECT_AFTER_TWO = T('protectAfterTwo', 0.89);
  TempoEngine.RHYTHM_NONE = T('rhythmNone', 0.08);
  TempoEngine.RHYTHM_HURT = T('rhythmHurt', 0.85);
  TempoEngine.RHYTHM_DEFAULT = T('rhythmDefault', 0.35);

  ST.TempoEngine = TempoEngine;
})();
