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

  // The codes come from config (`veto.codes`); this literal is the fallback for a build without
  // config.js and is kept complete so a missing config cannot silently drop a veto's identity.
  const VETO_CODES = cfg('veto.codes', {
    VETO1: 'PROTECT_RHYTHM',
    VETO2: 'ABILITY_IMMUNITY',
    VETO3: 'LONE_TR_SETTER',
    VETO4: 'SPEED_SUICIDE',
    VETO5: 'CONTACT_SUICIDE',
    VETO6: 'SUCKER_PUNCH_SETUP',
    VETO7: 'TR_SELF_CANCEL',
    VETO8: 'WASTED_HAZARD_CLEAR',
    VETO9: 'CONSECUTIVE_PROTECT',
    VETO10: 'MAGIC_BOUNCE_REDIRECT',
    VETO11: 'SATURATED_HAZARD',
    VETO12: 'REDUNDANT_FIELD'
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
        this.vetoSpeedSuicide(action, battleState),
        this.vetoContactSuicide(action, battleState),
        this.vetoSuckerPunchSetup(action, battleState),
        this.vetoSelfCancellingTrickRoom(action, battleState),
        this.vetoWastedHazardClear(action, battleState),
        this.vetoConsecutiveProtect(action, battleState),
        this.vetoMagicBounceRedirect(action, battleState),
        this.vetoSaturatedHazard(action, battleState),
        this.vetoRedundantField(action, battleState)
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

    /**
     * Attacking into a confirmed ability immunity, or a status move into a confirmed Good as Gold.
     *
     * THE HARD VETO NEEDS A PROOF, NOT A SUSPICION. This rule used to feed the SPECIES' whole
     * `possibleAbilities` list into `U.immunityReason`, so a Ground move into any body whose species
     * can hold Levitate was hard-masked at -9999 even when Levitate was one of three unconfirmed
     * possibilities -- and the world sampler already prices those worlds at 0 damage, so vetoing
     * them is both redundant and wrong (it deletes the lines that hedge). BUGS_AUDIT_REPORT.md lists
     * it: "feeding the whole possibleAbilities list into U.immunityReason can hard-veto every
     * action." An ability is now PROVEN only by a reveal, by being the species' only possibility, or
     * by every surviving candidate set carrying it (see _confirmedOppAbilities).
     */
    vetoAbilityImmunity(action, state) {
      if (!action || action.kind !== 'move') return null;
      const opp = state && state.active ? state.active.opp : null;
      if (!opp) return null;
      const moveName = action.name || action.moveId || '';
      const data = U.getMoveData(moveName);
      if (!data) return null;
      const proven = this._confirmedOppAbilities(opp);
      const item = opp.currentBattleItem || opp.confirmedItem || (opp.liveSet && opp.liveSet.item) || null;
      const species = opp.species || opp.id;

      // Ability-gated status moves (Good as Gold and friends).
      if (data.isStatus) {
        for (let i = 0; i < proven.length; i++) {
          if (U.UNBLOCKABLE_STATUS_ABILITY.has(U.toID(proven[i])) && !this._bypassesAbility(moveName)) {
            return this._veto(VETO_CODES.VETO2, 'Blocked by ' + proven[i] + '.');
          }
        }
        return null;
      }

      // Only the ABILITY half is filtered. The Flying type and an Air Balloon are facts the board
      // states outright, so they still veto on their own.
      const reason = U.immunityReason(data.type, {
        species: species,
        abilities: proven,
        item: item,
        itemless: !!opp.itemless
      });
      if (!reason) return null;
      if (this._bypassesImmunity(moveName, state)) return null;
      // Ground moves are only blocked by Levitate/Flying when we did not use Gravity.
      return this._veto(VETO_CODES.VETO2,
        data.type + ' move into ' + reason + ' — immune target, the turn is lost.');
    }

    /**
     * The abilities this opponent can be PROVEN to have, or [] when it can only be suspected.
     *
     * Three proofs, in the order they become available: a `revealedAbility` / `confirmedAbility`
     * printed by the battle, a species whose whole ability list is a single entry, or an unbroken
     * agreement across every set the pruner has left standing (`candidateSets` -- the pruner splices
     * eliminated sets out, so membership IS the surviving pool). An empty result is the common case
     * early in a game and is deliberately the CONSERVATIVE one: the caller then leaves the move
     * alone instead of masking it.
     */
    _confirmedOppAbilities(opp) {
      if (!opp) return [];
      const revealed = opp.revealedAbility || opp.confirmedAbility || null;
      if (revealed) return [revealed];
      const pool = Array.isArray(opp.possibleAbilities) ? opp.possibleAbilities : [];
      if (pool.length === 1) return pool.slice();
      const sets = Array.isArray(opp.candidateSets) ? opp.candidateSets : [];
      let agreed = null;
      for (let i = 0; i < sets.length; i++) {
        const s = sets[i];
        if (!s) return [];
        const id = U.toID(s.ability);
        if (!id) return [];
        if (agreed === null) agreed = { id: id, name: s.ability };
        else if (agreed.id !== id) return [];
      }
      return agreed ? [agreed.name] : [];
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

    /* ------------------------------------------------------------- VETO 5 */

    /**
     * Contact suicide: the target punishes contact (Iron Barbs / Rough Skin / Rocky Helmet) and
     * our own HP is low enough that the recoil finishes the body. Clicking a contact move there
     * throws the mon away for nothing — unless the hit KOs, because the punishment only fires
     * when the target SURVIVES the attack.
     *
     * The chips are game rules, not opinions: Iron Barbs / Rough Skin are 1/8 of max HP (12.5%)
     * and Rocky Helmet is 1/6 (16.7%), and they stack to ~29% — which is where the 29% ceiling in
     * `veto.contactPunishHp` comes from. Unknown items/abilities are never assumed.
     */
    vetoContactSuicide(action, state) {
      if (!action || action.kind !== 'move') return null;
      const moveName = action.name || action.moveId || '';
      const data = U.getMoveData(moveName);
      if (!data || data.isStatus || !data.makesContact) return null;
      const my = state && state.active ? state.active.my : null;
      const opp = state && state.active ? state.active.opp : null;
      if (!my || !opp) return null;
      const chip = this._contactChipPercent(opp);
      if (!chip) return null;
      const hp = typeof my.hpPercent === 'number' ? my.hpPercent : 100;
      if (hp > cfg('veto.contactPunishHp', 29) || hp > chip) return null;
      // A guaranteed KO means the target never gets to punish us.
      if (this._guaranteedKO(my, opp, moveName)) return null;
      return this._veto(VETO_CODES.VETO5,
        'Contact move into ' + (opp.species || opp.id) + ': up to ' + U.round1(chip) +
        '% recoil (Iron Barbs / Rough Skin / Rocky Helmet) finishes you at ' + U.round1(hp) + '%.');
    }

    /** Known contact punishment, as a % of the target's max HP. 0 when nothing is known. */
    _contactChipPercent(opp) {
      const ability = U.toID(this._abilityOf(opp));
      const item = U.toID(this._itemOf(opp));
      const barbs = (ability === 'ironbarbs' || ability === 'roughskin') ? 12.5 : 0;
      const helmet = item === 'rockyhelmet' ? 16.7 : 0;
      return barbs + helmet;
    }

    /** Does our move knock the target out from the HP we can see? Never guesses. */
    _guaranteedKO(my, opp, moveName) {
      if (!this.damage || typeof this.damage.calculateDamage !== 'function') return false;
      try {
        const hit = this.damage.calculateDamage(my, opp, moveName, {});
        if (!hit || typeof hit.minPercent !== 'number') return false;
        return hit.minPercent >= (opp.hpPercent === undefined ? 100 : opp.hpPercent);
      } catch (e) { return false; }
    }

    /* ------------------------------------------------------------- VETO 6 */

    /**
     * The Sucker Punch setup trap. Sucker Punch only connects if the target picks an ATTACK, so
     * a healthy opponent holding a setup/recovery/status move simply clicks that and the turn is
     * lost. Only a SECOND consecutive Sucker Punch is vetoed: the first one is a legitimate
     * prediction, and this layer removes blunders rather than reads.
     */
    vetoSuckerPunchSetup(action, state) {
      if (!action || action.kind !== 'move') return null;
      if (U.toID(action.moveId || action.name || '') !== 'suckerpunch') return null;
      const my = state && state.active ? state.active.my : null;
      const opp = state && state.active ? state.active.opp : null;
      if (!my || !opp) return null;
      if (U.toID(my.lastMove || '') !== 'suckerpunch') return null;
      // A stale lastMove from an earlier stint is not "consecutive".
      const lastTurn = typeof my.lastMoveTurn === 'number' ? my.lastMoveTurn : -1;
      const turn = typeof state.turn === 'number' ? state.turn : 0;
      if (lastTurn < turn - 1) return null;
      const hp = typeof opp.hpPercent === 'number' ? opp.hpPercent : 100;
      if (hp < cfg('veto.suckerPunchSetupHp', 80)) return null;   // a chipped target attacks back
      if (!this._hasNonAttackMove(opp)) return null;
      return this._veto(VETO_CODES.VETO6,
        'Consecutive Sucker Punch into a ' + U.round1(hp) + '% ' + (opp.species || opp.id) +
        ' that can click a status/setup move — Sucker Punch fails and the turn is lost.');
    }

    /**
     * Does the opponent plausibly hold something that makes Sucker Punch fail? Only proven
     * sources count (revealed moves, the active set, or a candidate set): an entirely unknown
     * body is left alone rather than vetoed on a guess.
     */
    _hasNonAttackMove(opp) {
      const moveLists = [opp.revealedMoves, opp.setMoves, opp.liveSet && opp.liveSet.moves];
      for (let l = 0; l < moveLists.length; l++) {
        const list = moveLists[l];
        if (!Array.isArray(list)) continue;
        for (let i = 0; i < list.length; i++) {
          const id = U.toID(list[i]);
          if (!id) continue;
          if (U.SETUP_MOVES.has(id) || PROTECT_IDS.has(id)) return true;
          const data = U.getMoveData(list[i]);
          if (data && (data.isStatus || data.isRecovery)) return true;
        }
      }
      const sets = opp.candidateSets;
      if (Array.isArray(sets)) {
        for (let s = 0; s < Math.min(sets.length, 8); s++) {
          const moves = sets[s] && sets[s].moves;
          if (!Array.isArray(moves)) continue;
          for (let i = 0; i < moves.length; i++) {
            const id = U.toID(moves[i]);
            if (!id) continue;
            const data = U.getMoveData(moves[i]);
            if (data && (data.isStatus || data.isRecovery)) return true;
          }
        }
      }
      return false;
    }

    /* ------------------------------------------------------------- VETO 7 */

    /**
     * Trick Room is already up: clicking it again can only waste the turn. (In Gen 5+ the move
     * simply FAILS while the room is active — it does not cancel or refresh it — so there is no
     * universe where re-clicking it is the right line, and for a TR team it burns a TR turn.)
     */
    vetoSelfCancellingTrickRoom(action, state) {
      if (!action || action.kind !== 'move') return null;
      if (U.toID(action.moveId || action.name || '') !== 'trickroom') return null;
      if (!(state && state.field && state.field.trickRoom)) return null;
      return this._veto(VETO_CODES.VETO7,
        'Trick Room is already active: the move fails and the turn is lost.');
    }

    /* ------------------------------------------------------------- VETO 8 */

    /**
     * A clearing move with nothing to clear. Rapid Spin / Mortal Spin / Defog / Tidy Up only
     * take hazards off OUR side, so with our side already clean the turn buys nothing at all —
     * not even a chip, since the move's own damage does not make up for a lost turn on a hazard
     * team's clock.
     *
     * Court Change is exempt on purpose (see U.HAZARD_CLEAR_MOVES): it SWAPS the two sides, so
     * it is live even when our side is spotless.
     */
    vetoWastedHazardClear(action, state) {
      if (!action || action.kind !== 'move') return null;
      if (!cfg('veto.wastedHazardClear', true)) return null;
      const id = U.toID(action.moveId || action.name || '');
      if (!U.HAZARD_CLEAR_MOVES.has(id)) return null;
      const my = state && state.active ? state.active.my : null;
      const side = (state && state.mySide) || 'p1';
      const hazards = state && state.field && state.field.hazards ? state.field.hazards[side] : null;
      if (!my || !hazards) return null;                     // unknown field: never veto on a guess
      const layers = U.hazardLayersOf(hazards);
      if (layers === null || layers > 0) return null;
      return this._veto(VETO_CODES.VETO8,
        'Nothing on your side to clear: ' + (action.name || id) + ' spends the turn for nothing.');
    }

    /* ------------------------------------------------------------- VETO 9 */

    /**
     * Consecutive Protect. The Protect family cannot succeed twice in a row — the game counts
     * successful uses and fails the move while the counter is up — so clicking it again is a
     * guaranteed lost turn rather than a read.
     *
     * Two exemptions keep it from firing on a technicality: a stale lastMove from an earlier
     * stint is not consecutive (the same rule VETO6 uses), and a Protect that could not even be
     * used last turn (we were Taunted) left the counter at zero, so the next one is legitimate.
     */
    vetoConsecutiveProtect(action, state) {
      if (!action || action.kind !== 'move') return null;
      if (!cfg('veto.consecutiveProtect', true)) return null;
      const id = U.toID(action.moveId || action.name || '');
      if (!PROTECT_IDS.has(id)) return null;
      const my = state && state.active ? state.active.my : null;
      if (!my) return null;
      const lastId = U.toID(my.lastMove || '');
      if (!PROTECT_IDS.has(lastId)) return null;
      const lastTurn = typeof my.lastMoveTurn === 'number' ? my.lastMoveTurn : -1;
      const turn = typeof state.turn === 'number' ? state.turn : 0;
      if (lastTurn < turn - 1) return null;
      if (my.taunt || my.encore) return null;               // it never went off, so the counter is clear
      return this._veto(VETO_CODES.VETO9,
        'Protect already succeeded last turn: it fails now and the turn is lost.');
    }

    /* ------------------------------------------------------------ VETO 10 */

    /**
     * A hazard thrown into Magic Bounce. The hazard does not fail — it lands on OUR side for
     * free, which is strictly worse than not clicking it, so this is the classic way a hazard
     * turn is thrown away against a Magic Bounce body.
     *
     * Only grounds we can point at count: a revealed or battle-confirmed ability, the believed
     * set, or the species' possible abilities. A body we know nothing about is left alone.
     */
    vetoMagicBounceRedirect(action, state) {
      if (!action || action.kind !== 'move') return null;
      if (!cfg('veto.magicBounceRedirect', true)) return null;
      const moveName = action.name || action.moveId || '';
      const data = U.getMoveData(moveName);
      const id = U.toID(moveName);
      const isHazard = (data && data.isHazard) || U.HAZARD_MOVES.has(id);
      if (!isHazard) return null;
      const opp = state && state.active ? state.active.opp : null;
      if (!opp) return null;
      const bounce = this._magicBounceBasis(opp);
      if (!bounce) return null;
      return this._veto(VETO_CODES.VETO10,
        (opp.species || opp.id || 'Their active') + ' ' + bounce + ' Magic Bounce: the hazard lands on YOUR side.');
    }

    /** Where the Magic Bounce belief comes from: an observation, the set, or the species' pool. */
    _magicBounceBasis(opp) {
      const observed = U.toID(opp.revealedAbility || opp.confirmedAbility || '');
      if (observed === 'magicbounce') return 'has revealed';
      const set = U.toID((opp.liveSet && opp.liveSet.ability) || opp.ability || '');
      if (set === 'magicbounce') return 'is read as holding';
      const pool = opp.possibleAbilities;
      if (Array.isArray(pool)) {
        for (let i = 0; i < pool.length; i++) {
          if (U.toID(pool[i]) === 'magicbounce') return 'can hold';
        }
      }
      return null;
    }

    /* ------------------------------------------------------------ VETO 11 */

    /**
     * A hazard at its layer cap. Spikes stop at three, Toxic Spikes at two, and the one-layer
     * hazards stop immediately; pushing past the cap sets nothing, so the turn is spent. The cap
     * and the state key both come from U.HAZARD_LAYERS, never from a literal here.
     *
     * Only the OPPONENT's side is judged: a hazard of ours that is already up on our own side
     * (a Court Change, in practice) is a different board and not this rule's business.
     */
    vetoSaturatedHazard(action, state) {
      if (!action || action.kind !== 'move') return null;
      if (!cfg('veto.saturatedHazard', true)) return null;
      const moveName = action.name || action.moveId || '';
      const id = U.toID(moveName);
      const entry = U.HAZARD_LAYERS[id];
      if (!entry) return null;
      const field = state && state.field;
      if (!field || !field.hazards) return null;
      const oppSide = (state.mySide === 'p2') ? 'p1' : 'p2';
      const hazards = field.hazards[oppSide];
      if (!hazards) return null;
      const current = hazards[entry.key];
      if (typeof current !== 'number' && current !== true) return null;
      const layers = current === true ? 1 : current;
      if (layers < entry.max) return null;
      return this._veto(VETO_CODES.VETO11,
        (action.name || id) + ' is already at its maximum (' + entry.max + '/\\u2009' + entry.max +
        '): the move sets nothing this turn.');
    }

    /* ------------------------------------------------------------ VETO 12 */

    /**
     * Re-setting the weather that is already up. A weather move while its own weather has more
     * than `veto.redundantFieldMinTurns` turns left changes nothing the turn it is clicked; at
     * one turn left it is a legitimate refresh, which is exactly where the threshold sits.
     *
     * Terrains are not judged: their remaining turns are not tracked as reliably as the weather's,
     * and this layer does not veto on a number it cannot read.
     */
    vetoRedundantField(action, state) {
      if (!action || action.kind !== 'move') return null;
      if (!cfg('veto.redundantField', true)) return null;
      const moveName = action.name || action.moveId || '';
      const sets = U.WEATHER_BY_MOVE[U.toID(moveName)];
      if (!sets) return null;
      const field = state && state.field;
      if (!field || !field.weather) return null;
      if (U.weatherFamily(field.weather) !== U.weatherFamily(sets)) return null;
      const left = field.weatherTurnsLeft;
      if (typeof left !== 'number' || !isFinite(left)) return null;   // unknown duration: no opinion
      if (left < cfg('veto.redundantFieldMinTurns', 2)) return null;
      return this._veto(VETO_CODES.VETO12,
        U.weatherFamily(sets) + ' is already up with ' + Math.round(left) + ' turn(s) left: ' +
        (action.name || moveName) + ' changes nothing.');
    }

    /**
     * The item a body is really holding right now: an observation first, then the set
     * hypothesis, and null once the log has taken the item away. Returning `undefined` is not
     * a neutral default — U.computeSpeed treats a *defined* option as authoritative — so the
     * old `item: mon.currentBattleItem || mon.confirmedItem` silently erased our own Choice
     * Scarf: neither field is ever set on a paste-registered mon, which carries `mon.item`.
     */
    _itemOf(mon) {
      if (!mon) return null;
      if (mon.currentBattleItem) return mon.currentBattleItem;
      if (mon.confirmedItem) return mon.confirmedItem;
      if (mon.itemRemoved || mon.itemless || mon.itemConsumed) return null;
      if (mon.item) return mon.item;
      if (mon.liveSet && mon.liveSet.item) return mon.liveSet.item;
      return null;
    }

    _abilityOf(mon) {
      if (!mon) return '';
      if (mon.revealedAbility) return mon.revealedAbility;
      if (mon.ability) return mon.ability;
      if (mon.liveSet && mon.liveSet.ability) return mon.liveSet.ability;
      if (mon.possibleAbilities && mon.possibleAbilities.length) return mon.possibleAbilities[0];
      return '';
    }

    /**
     * Absolute Speed of both bodies INCLUDING the field context. The comparison used to see
     * neither our item/ability (see _itemOf) nor the weather/terrain/Tailwind that the state
     * carries, so Swift Swim / Chlorophyll / Sand Rush / Slush Rush / Surge Surfer and
     * Tailwind were invisible to VETO4. The paradox boost is now read through
     * U.paradoxSpeedBoost, which only counts it when the boosted stat is SPEED: Protosynthesis /
     * Quark Drive raise the holder's highest stat, so an Attack-boosted Great Tusk was being
     * scored at 1.5x Speed and made to look faster than it is.
     */
    _opponentMovesFirst(state, my, opp) {
      const field = (state && state.field) || {};
      const tr = !!field.trickRoom;
      const side = (state && state.mySide) || 'p1';
      const oppSide = side === 'p1' ? 'p2' : 'p1';
      const mySpeed = U.computeSpeed(my, {
        item: this._itemOf(my),
        ability: this._abilityOf(my),
        boosts: my.boosts,
        boostStage: (my.boosts && my.boosts.spe) || 0,
        weather: field.weather || '',
        terrain: field.terrain || '',
        tailwind: !!(field.tailwind && field.tailwind[side]),
        paradoxSpeedBoost: U.paradoxSpeedBoost(my),
        unburden: !!my.unburden
      }).effective;
      const oppSpeed = U.computeSpeed(opp, {
        item: this._itemOf(opp),
        ability: this._abilityOf(opp),
        boosts: opp.boosts,
        boostStage: (opp.boosts && opp.boosts.spe) || 0,
        weather: field.weather || '',
        terrain: field.terrain || '',
        tailwind: !!(field.tailwind && field.tailwind[oppSide]),
        paradoxSpeedBoost: U.paradoxSpeedBoost(opp),
        unburden: !!opp.unburden
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
