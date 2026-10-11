/* Showdown Tactician — src/veto_guard.js
 * The Laplace Deterministic Blunder Veto Layer (Part 2, Module 11).
 * Hard policy masks: a vetoed action's score is forced to -9999 and carries a
 * human-readable reason that the HUD renders as a red strike-through badge.
 *
 * Every threshold this layer uses lives in src/config.js (`veto.*` plus the forced
 * `laplace.vetoScore`); nothing here is a bare literal. The reads are inline at the point of
 * use so a runtime ST.configMerge() takes effect immediately.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;

  /** Config read with a literal fallback for a build without config.js. */
  function cfg(path, fallback) {
    return (typeof ST.configGet === 'function') ? ST.configGet(path, fallback) : fallback;
  }

  const VETO_SCORE = cfg('laplace.vetoScore', -9999);

  const VETO_CODES = cfg('veto.codes', {
    VETO1: 'PROTECT_RHYTHM',
    VETO2: 'ABILITY_IMMUNITY',
    VETO3: 'LONE_TR_SETTER',
    VETO4: 'SPEED_SUICIDE'
  });

  const PROTECT_IDS = U.PROTECT_MOVES;

  class BlunderVetoGuard {
    constructor(options) {
      options = options || {};
      this.damage = options.damage || null;
      this.trickRoom = options.trickRoom || null;
      this.lastVetoes = [];
    }

    /**
     * evaluateVetoes(action, battleState, tempoVector)
     *   action = { kind:'move'|'switch'|'protect', name, moveId?, targetId? }
     * -> { isVetoed, reason, code }
     */
    evaluateVetoes(action, battleState, tempoVector) {
      if (!action) return this._clean();
      const checks = [
        this.vetoProtectRhythm(action, battleState, tempoVector),
        this.vetoAbilityImmunity(action, battleState),
        this.vetoLoneTRSetter(action, battleState),
        this.vetoSpeedSuicide(action, battleState)
      ];
      for (let i = 0; i < checks.length; i++) {
        if (checks[i] && checks[i].isVetoed) {
          this.lastVetoes.push({ code: checks[i].code, name: action.name, reason: checks[i].reason });
          if (this.lastVetoes.length > cfg('veto.maxLog', 40)) this.lastVetoes.shift();
          return checks[i];
        }
      }
      return this._clean();
    }

    _clean() { return { isVetoed: false, reason: null, code: null, score: null }; }

    _veto(code, reason) {
      return { isVetoed: true, reason: reason, code: code, score: VETO_SCORE };
    }

    /* ------------------------------------------------------------- VETO 1 */

    /** Attacking into the predicted Bunker turn wastes a Trick Room turn. */
    vetoProtectRhythm(action, state, tempoVector) {
      if (!action || action.kind !== 'move') return null;
      const field = state && state.field;
      if (!field || !field.trickRoom) return null;
      const v4 = tempoVector && typeof tempoVector.v4 === 'number'
        ? tempoVector.v4
        : (tempoVector && typeof tempoVector.v4 === 'undefined' && typeof tempoVector.predictProtect === 'function'
          ? tempoVector.predictProtect(state, 'opp') : 0);
      if (!(v4 > cfg('veto.protectRhythmThreshold', 0.75))) return null;
      if (this._isStatusLike(action)) return null;            // setup / Protect are the reward, not the blunder
      return this._veto(VETO_CODES.VETO1,
        Math.round(v4 * 100) + '% probability opponent clicks Baneful Bunker/Protect. Wastes TR turn.');
    }

    /* ------------------------------------------------------------- VETO 2 */

    /** Attacking into a known ability immunity, or a status move into Good as Gold. */
    vetoAbilityImmunity(action, state) {
      if (!action || action.kind !== 'move') return null;
      const opp = state && state.active ? state.active.opp : null;
      if (!opp) return null;
      const moveName = action.name || action.moveId || '';
      const data = U.getMoveData(moveName);
      if (!data) return null;
      const ability = opp.revealedAbility || opp.confirmedAbility ||
        (opp.liveSet && opp.liveSet.ability) || null;
      const item = opp.currentBattleItem || opp.confirmedItem || (opp.liveSet && opp.liveSet.item) || null;
      const species = opp.species || opp.id;

      // Ability-gated status moves (Good as Gold and friends).
      if (data.isStatus) {
        if (ability && U.UNBLOCKABLE_STATUS_ABILITY.has(U.toID(ability)) && !this._bypassesAbility(moveName)) {
          return this._veto(VETO_CODES.VETO2, 'Blocked by ' + ability + '.');
        }
        return null;
      }

      const reason = U.immunityReason(data.type, {
        species: species,
        ability: ability,
        abilities: opp.possibleAbilities || (ability ? [ability] : []),
        item: item,
        itemless: !!opp.itemless
      });
      if (!reason) return null;
      if (this._bypassesImmunity(moveName, state)) return null;
      // Ground moves are only blocked by Levitate/Flying when we did not use Gravity.
      return this._veto(VETO_CODES.VETO2,
        data.type + ' move into ' + reason + ' — immune target, the turn is lost.');
    }

    _bypassesAbility(moveName) {
      const id = U.toID(moveName);
      return id === 'sunsteelstrike' || id === 'moongeistbeam' || id === 'photongeyser' ||
        id === 'menacingmoonrazemaelstrom' || id === 'searingsunrazesmash' || id === 'lightthatburnsthesky';
    }

    _bypassesImmunity(moveName, state) {
      const id = U.toID(moveName);
      if (id === 'thousandarrows') return true;                     // hits Flying types
      if (state && state.field && state.field.gravity) {
        const data = U.getMoveData(moveName);
        if (data && data.type === 'Ground') return true;            // Gravity grounds Flyers/Levitate
      }
      return false;
    }

    /* ------------------------------------------------------------- VETO 3 */

    /** Hard-switching the last living TR setter into a high-threat matchup. */
    vetoLoneTRSetter(action, state) {
      if (!action || action.kind !== 'switch') return null;
      const field = state && state.field;
      if (field && field.trickRoom) return null;                    // TR is already up
      const incoming = this._findSwitchTarget(action, state);
      if (!incoming) return null;
      const setters = (state.myTeam || []).filter(this._livingTRSetter);
      if (setters.length !== 1) return null;
      if (setters[0] !== incoming) return null;
      const threat = this._incomingThreat(state, incoming);
      if (threat === null || threat <= cfg('veto.loneTRSetterThreat', 70)) return null;
      return this._veto(VETO_CODES.VETO3,
        'Sacks your final TR setter (' + (incoming.species || incoming.id) + ') into a ' +
        Math.round(threat) + '% incoming threat.');
    }

    _livingTRSetter(mon) {
      if (!mon || mon.fainted) return false;
      const knows = function (list) {
        return Array.isArray(list) && list.some(function (m) { return U.toID(m) === 'trickroom'; });
      };
      if (knows(mon.revealedMoves) || knows(mon.setMoves)) return true;
      if (mon.liveSet && knows(mon.liveSet.moves)) return true;
      if (mon.candidateSets && mon.candidateSets.some(function (s) { return knows(s.moves); })) return true;
      const id = U.toID(mon.species || mon.id);
      return U.TR_SETTERS.has(id) && (!mon.revealedMoves || mon.revealedMoves.length < 4);
    }

    _findSwitchTarget(action, state) {
      const teams = [(state && state.bench && state.bench.my) || [], (state && state.myTeam) || []];
      const wanted = U.toID(action.targetId || action.species || action.name || '');
      for (let t = 0; t < teams.length; t++) {
        for (let i = 0; i < teams[t].length; i++) {
          const mon = teams[t][i];
          if (!mon || mon.fainted) continue;
          const id = U.toID(mon.species || mon.id);
          if (id === wanted && !mon.isActive) return mon;
        }
      }
      // The action may name a slot instead of a species.
      const slot = action.targetId || '';
      for (let t = 0; t < teams.length; t++) {
        for (let i = 0; i < teams[t].length; i++) {
          if (teams[t][i] && teams[t][i].slot === slot && !teams[t][i].isActive) return teams[t][i];
        }
      }
      return null;
    }

    _incomingThreat(state, myMon) {
      const opp = state && state.active ? state.active.opp : null;
      if (!opp || !this.damage) return null;
      try {
        const best = this.damage.getBestIncomingThreat(opp, myMon, state.field);
        if (!best) return null;
        return typeof best.maxPercent === 'number' ? best.maxPercent : (best.avgPercent || 0);
      } catch (e) { return null; }
    }

    /* ------------------------------------------------------------- VETO 4 */

    /** Slower than a guaranteed lethal hit and clicking a non-priority attack anyway. */
    vetoSpeedSuicide(action, state) {
      if (!action || action.kind !== 'move') return null;
      const moveless = action.name || action.moveId || '';
      const data = U.getMoveData(moveless);
      if (!data) return null;
      if (data.isStatus && !PROTECT_IDS.has(U.toID(moveless))) {
        // Setup behind a guaranteed KO is also suicide, but only the attack case is specified.
        return null;
      }
      const bracket = U.movePriority(moveless);
      const id = U.toID(moveless);
      const effectivePriority = (id === 'trickroom' || id === 'teleport' || id === 'chillyreception')
        ? -1 : bracket;
      if (effectivePriority > 0) return null;                  // priority gets to move regardless
      if (PROTECT_IDS.has(id)) return null;                    // Protect is the correct line
      const my = state && state.active ? state.active.my : null;
      const opp = state && state.active ? state.active.opp : null;
      if (!my || !opp || !this.damage) return null;

      const oppFirst = this._opponentMovesFirst(state, my, opp);
      if (!oppFirst) return null;
      let best = null;
      try { best = this.damage.getBestIncomingThreat(opp, my, state.field); } catch (e) { best = null; }
      if (!best) return null;
      if (!best.isOHKO) return null;
      return this._veto(VETO_CODES.VETO4,
        'Slower and facing a guaranteed ' + U.round1(best.minPercent) + '-' + U.round1(best.maxPercent) +
        '% KO from ' + (best.move || 'their attack') + ' before you act.');
    }

    _opponentMovesFirst(state, my, opp) {
      const tr = !!(state.field && state.field.trickRoom);
      const moveId = U.toID(null);
      const mySpeed = U.computeSpeed(my, {
        item: my.currentBattleItem || my.confirmedItem,
        ability: my.revealedAbility,
        boosts: my.boosts,
        paradoxSpeedBoost: !!my.boosterActive
      }).effective;
      const oppSpeed = U.computeSpeed(opp, {
        item: opp.currentBattleItem || opp.confirmedItem || (opp.liveSet && opp.liveSet.item),
        ability: opp.revealedAbility || (opp.liveSet && opp.liveSet.ability),
        boosts: opp.boosts,
        paradoxSpeedBoost: !!opp.boosterActive
      }).effective;
      if (tr) return oppSpeed < mySpeed;      // slower acts first
      return oppSpeed > mySpeed;
    }

    /* ------------------------------------------------------------- helpers */

    _isStatusLike(action) {
      const id = U.toID(action.moveId || action.name || '');
      if (PROTECT_IDS.has(id)) return true;
      if (U.SETUP_MOVES.has(id)) return true;
      const data = U.getMoveData(action.name || action.moveId);
      if (!data) return false;
      if (data.isStatus) return true;
      return false;
    }

    /** Convenience used by the engine: force a vetoed score. */
    applyVeto(score, veto) {
      if (veto && veto.isVetoed) return VETO_SCORE;
      return score;
    }
  }

  BlunderVetoGuard.VETO_CODES = VETO_CODES;
  BlunderVetoGuard.VETO_SCORE = VETO_SCORE;

  ST.BlunderVetoGuard = BlunderVetoGuard;
})();
