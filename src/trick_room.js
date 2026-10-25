/* Showdown Tactician — src/trick_room.js
 * Part 2, Module 12: Trick Room lifecycle manager, dynamic inverted-Speed priority queue
 * and the "do I still have a setter" advisor.
 *
 * READ-ONLY GUARANTEE: this module never mutates state.field, state.turn, or any MonState
 * field owned by the BattleStateManager — with one documented exception:
 * applySpeedOverrides(state) writes mon.speedOverride, the field reserved for this module
 * by ARCHITECTURE.md shape 1.1.
 *
 * Speed semantics (frozen):
 *   getEffectiveSpeed(mon, isTRActive, field) -> the absolute level-100 Speed the Pokémon
 *     resolves with: nature + IVs + EVs + item (Choice Scarf/Iron Ball/Power items) +
 *     ability (Swift Swim, Chlorophyll, Sand Rush, Slush Rush, Surge Surfer, Protosynthesis
 *     / Quark Drive when Booster-boosted) + stat boosts + Tailwind + paralysis.
 *     Trick Room does NOT invert this number; it only decides which end of the sort wins.
 *   rankSpeed(mon, isTRActive, field) -> 10000 - speed under Trick Room, so a plain
 *     ASCENDING sort of `rank` is always the correct resolution order in both modes.
 *   believedSpeed(...) -> getEffectiveSpeed raised to the proven speed floor / override and
 *     capped by the proven ceiling. Only ordering uses it.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;
  const { toID, clamp, mean, round1 } = U;

  // RULE 4: every tunable lives in src/config.js. The literal fallbacks below only apply when
  // config.js was never loaded at all (stripped build / isolated unit harness).
  const cfg = (typeof ST.configGet === 'function')
    ? ST.configGet
    : function (path, fallback) { return fallback; };

  const TR_TURNS = cfg('trickRoom.turns', 5);
  const SPEED_RANK_BASE = cfg('trickRoom.speedRankBase', 10000);
  const TR_ALERT_FINAL = cfg('trickRoom.alertFinal',
    'TR 1/5 / LAST TURN: attack or sack your setter');
  const TR_ALERT_TWO_LEFT = cfg('trickRoom.alertTwoLeft',
    'TR: 2 turns left — land your chip now; the last turn is for the sack.');
  const TR_MAX_HISTORY = cfg('trickRoom.maxHistory', 40);

  /* ---------------------------------------------------------------- brackets */

  const PRIORITY_2 = ['extremespeed'];
  const PRIORITY_1 = [
    'suckerpunch', 'iceshard', 'aquajet', 'shadowsneak', 'bulletpunch', 'machpunch',
    'vacuumwave', 'quickattack', 'watershuriken', 'accelerock',
    'thunderclap', 'jetpunch', 'upperhand', 'grasseyglare'
  ];
  const PRIORITY_MINUS_6 = ['teleport', 'chillyreception', 'circlethrow', 'dragontail', 'whirlwind', 'roar'];
  const PRIORITY_MINUS_7 = ['trickroom'];
  const PRIORITY_MINUS_5 = ['counter', 'mirrorcoat'];
  const PRIORITY_MINUS_4 = ['avalanche', 'revenge'];
  const PRIORITY_MINUS_3 = ['focuspunch', 'beakblast', 'shelltrap'];

  /** Explicit bracket table from the brief, then the dex priority as the general fallback. */
  const BRACKET_OVERRIDES = (function () {
    const map = {};
    PRIORITY_2.forEach((id) => { map[id] = 2; });
    PRIORITY_1.forEach((id) => { map[id] = 1; });
    PRIORITY_MINUS_3.forEach((id) => { map[id] = -3; });
    PRIORITY_MINUS_4.forEach((id) => { map[id] = -4; });
    PRIORITY_MINUS_5.forEach((id) => { map[id] = -5; });
    PRIORITY_MINUS_6.forEach((id) => { map[id] = -6; });
    PRIORITY_MINUS_7.forEach((id) => { map[id] = -7; });
    // Gen 9 dex stores these without a priority field; the slow pivots are bracket 0.
    map.partingshot = 0; map.batonpass = 0; map.uturn = 0; map.voltswitch = 0; map.flipturn = 0;
    return map;
  })();

  function bracketLabel(p) {
    return p > 0 ? '+' + p : String(p);
  }

  class TrickRoomEngine {
    /**
     * @param {object} [damageEngine] ST.DamageEngine (optional; refines the setter choice by
     *        scoring the switch cost of each candidate setter).
     * @param {object} [options] { aggressive:boolean }
     */
    constructor(damageEngine, options) {
      this.damage = damageEngine || null;
      this.opts = Object.assign({ aggressive: true }, options || {});
      this._state = null;
      this.lastState = null;
      this.lastField = null;
      this.lastQueue = [];
      this.lastAdvice = null;
      this.alert = null;
      this.history = [];        // [{ turn, active, turnsLeft }]
      this.decisions = 0;
    }

    /* ------------------------------------------------------------ field helpers */

    /** Accepts a BattleState, a raw FieldState or nothing (falls back to the last tick). */
    fieldOf(state) {
      if (state && state.field) return state.field;
      if (state && state.trickRoom !== undefined) return state;
      if (this._state && this._state.field) return this._state.field;
      return { trickRoom: false, trickRoomTurnsLeft: 0, turn: 0, weather: '', terrain: '', tailwind: { p1: false, p2: false } };
    }

    isTrickRoomActive(state) {
      return !!this.fieldOf(state).trickRoom;
    }

    turnsLeft(state) {
      const f = this.fieldOf(state);
      if (!f.trickRoom) return 0;
      const n = typeof f.trickRoomTurnsLeft === 'number' ? f.trickRoomTurnsLeft : TR_TURNS;
      return clamp(n, 0, TR_TURNS);
    }

    getLifecycleAlert(turnsLeft) {
      const n = (turnsLeft === null || turnsLeft === undefined) ? this.turnsLeft(this._state) : turnsLeft;
      if (typeof n !== 'number' || n <= 0) return null;
      if (n === 1) return TR_ALERT_FINAL;
      if (n === 2) return TR_ALERT_TWO_LEFT;
      return null;
    }

    /* ------------------------------------------------------------ mon helpers */

    _sideOf(mon) {
      if (!mon) return '';
      if (mon.side) return mon.side;
      return String(mon.slot || '').slice(0, 2);
    }

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

    /** Moves we believe this Pokémon can click right now (my side prefers |request|). */
    _movesFor(mon, state) {
      const out = [];
      const seen = {};
      const push = (m) => {
        if (!m) return;
        const name = typeof m === 'string' ? m : (m.name || m.move || '');
        if (!name) return;
        const id = toID(name);
        if (!id || seen[id]) return;
        seen[id] = true;
        out.push({
          id: id,
          name: name,
          pp: (typeof m === 'object' && typeof m.pp === 'number') ? m.pp : null,
          disabled: !!(typeof m === 'object' && m.disabled),
          disabledReason: (typeof m === 'object' && m.disabledReason) || ''
        });
      };
      const mySide = (state && state.mySide) || 'p1';
      if (this._sideOf(mon) === mySide && state && state.legalActions && state.legalActions.moves && state.legalActions.moves.length) {
        state.legalActions.moves.forEach(push);
        return out;
      }
      (mon.liveSet && mon.liveSet.moves || []).forEach(push);
      if (out.length < 4) (mon.setMoves || []).forEach(push);
      if (out.length < 4) (mon.revealedMoves || []).forEach(push);
      if (out.length < 4) (mon.activeStintMoves || []).forEach(push);
      if (out.length < 4 && mon.candidateSets && mon.candidateSets.length && mon.candidateSets[0].moves) {
        mon.candidateSets[0].moves.forEach(push);
      }
      return out.slice(0, 4);
    }

    /* ------------------------------------------------------------ speed maths */

    /** PURE absolute Speed. `field` may be a FieldState or a BattleState. */
    getEffectiveSpeed(mon, isTRActive, field) {
      if (!mon) return 0;
      const f = this.fieldOf(field || this._state);
      const side = this._sideOf(mon) || (this._state && this._state.mySide) || 'p1';
      const ability = this._abilityOf(mon);
      const abilityId = toID(ability);
      const item = this._itemOf(mon);
      // A proven Booster Energy holder (ability + item) counts as boosted even before the protocol
      // has set `boosterActive`; U.paradoxSpeedBoost then only applies the 1.5x when the boost is
      // really a SPEED boost. Reading `boosterActive` flatly made an Attack-boosted Great Tusk look
      // like it outsped us. See the helper's own notes.
      const holdsBoosterEnergy = U.PARADOX_ABILITIES.has(abilityId) && toID(item) === 'boosterenergy';
      const res = U.computeSpeed(mon, {
        evs: mon.evs,
        ivs: mon.ivs,
        nature: mon.nature,
        level: mon.level || 100,
        item: item,
        ability: ability,
        boostStage: (mon.boosts && mon.boosts.spe) || 0,
        weather: f.weather || '',
        terrain: f.terrain || '',
        tailwind: !!(f.tailwind && f.tailwind[side]),
        paradoxSpeedBoost: U.paradoxSpeedBoost(mon, { active: !!mon.boosterActive || holdsBoosterEnergy }),
        unburden: !!mon.unburden
      });
      let speed = res.effective;
      // paralysis: 50% Speed in Gen 7+ (Trick Room archetypes are still debuffed)
      if (mon.status === 'par') speed = Math.floor(speed * U.paralysisMultiplier());
      return speed;
    }

    /** Evidence-aware ordering speed (floor/override raise it, ceiling caps it). */
    believedSpeed(mon, isTRActive, field) {
      let speed = this.getEffectiveSpeed(mon, isTRActive, field);
      if (!mon) return speed;
      if (typeof mon.speedOverride === 'number' && mon.speedOverride > speed) speed = mon.speedOverride;
      if (!isTRActive && typeof mon.speedFloor === 'number' && mon.speedFloor > speed) speed = mon.speedFloor;
      if (typeof mon.speedCeiling === 'number' && mon.speedCeiling > 0 && mon.speedCeiling < speed) speed = mon.speedCeiling;
      return speed;
    }

    /** Resolution rank: under Trick Room the slowest Pokémon acts first. */
    rankSpeed(mon, isTRActive, field) {
      const speed = this.believedSpeed(mon, isTRActive, field);
      return isTRActive ? SPEED_RANK_BASE - speed : speed;
    }

    /** rankSpeed without the speed-floor evidence (pure dex/set maths). */
    rawRankSpeed(mon, isTRActive, field) {
      const speed = this.getEffectiveSpeed(mon, isTRActive, field);
      return isTRActive ? SPEED_RANK_BASE - speed : speed;
    }

    /* ------------------------------------------------------------ priority */

    /**
     * Priority bracket of `moveName` for `mon`: explicit table first (+2 Extreme Speed,
     * +1 priority moves, 0 standard, -6 Teleport/Chilly Reception, -7 Trick Room), then
     * ability adjustments (Prankster, Gale Wings at full HP, Triage), then dex priority.
     */
    moveBracket(moveName, mon) {
      const id = toID(moveName);
      if (!id) return 0;
      const data = U.getMoveData(moveName);
      let bracket;
      if (Object.prototype.hasOwnProperty.call(BRACKET_OVERRIDES, id)) bracket = BRACKET_OVERRIDES[id];
      else bracket = data ? data.priority : 0;
      if (typeof bracket !== 'number' || bracket !== bracket) bracket = 0;
      if (mon) {
        const ability = toID(this._abilityOf(mon));
        const isStatus = !data || data.isStatus;
        if (ability === 'prankster' && isStatus) bracket += 1;
        if (ability === 'galewings' && data && data.type === 'Flying' &&
            (mon.hp === null || mon.hp === undefined || mon.hp >= 100)) bracket += 1;
        if (ability === 'triage' && data && data.isRecovery) bracket += 3;
      }
      return clamp(bracket, -7, 5);
    }

    /* ------------------------------------------------------------ queue */

    /**
     * buildSpeedQueue(myMon, oppMon, isTRActive, state)
     * Every candidate action on both sides in the exact order Showdown resolves them:
     * priority bracket first (highest first), then resolution Speed within the bracket
     * (ascending under Trick Room, descending outside it).
     *
     * Entry: { name, moveId, side, species, priority, bracket, bracketLabel, effectiveSpeed,
     *          believedSpeed, rank, movesFirst, beatsOpponentActive, isProtect, isRecovery,
     *          isPivot, isStatus, isTrickRoom, disabled, movesText, order }
     *   movesFirst: true for every entry of the side that wins the turn's initiative.
     *   beatsOpponentActive: true when this specific action resolves before the opposing
     *     active's fastest action under the current field rules.
     */
    buildSpeedQueue(myMon, oppMon, isTRActive, state) {
      const st = state || this._state;
      const tr = typeof isTRActive === 'boolean' ? isTRActive : this.isTrickRoomActive(st);
      const f = this.fieldOf(st);
      const mySide = (st && st.mySide) || this._sideOf(myMon) || 'p1';
      const oppSide = mySide === 'p1' ? 'p2' : 'p1';
      const queue = [];
      const self = this;

      const collect = (mon, side) => {
        if (!mon || mon.fainted) return;
        const moves = self._movesFor(mon, st);
        if (!moves.length) {
          queue.push(self._row(mon, side, { id: '', name: '(unknown move)' }, 0, tr, f));
          return;
        }
        moves.forEach((move) => {
          queue.push(self._row(mon, side, move, self.moveBracket(move.name, mon), tr, f));
        });
      };
      collect(myMon, mySide);
      collect(oppMon, oppSide);

      // Deterministic: highest priority bracket first, then the HIGHEST rank. `rank` is
      // already Trick-Room-aware (SPEED_RANK_BASE - speed under TR), so the maximum rank is
      // always the action that resolves first: the fastest Pokémon normally, the slowest
      // under Trick Room.
      queue.sort((a, b) => {
        if (a.bracket !== b.bracket) return b.bracket - a.bracket;
        if (a.rank !== b.rank) return b.rank - a.rank;
        if (a.side !== b.side) return a.side < b.side ? -1 : 1;
        return a.moveId < b.moveId ? -1 : a.moveId > b.moveId ? 1 : 0;
      });
      queue.forEach((row, i) => { row.order = i; row.movesFirst = false; row.beatsOpponentActive = false; });

      const bestBySide = {};
      queue.forEach((row) => { if (bestBySide[row.side] === undefined) bestBySide[row.side] = row.order; });
      const myBest = bestBySide[mySide];
      const oppBest = bestBySide[oppSide];
      const winnerSide = queue.length ? queue[0].side : null;
      queue.forEach((row) => {
        row.movesFirst = winnerSide !== null && row.side === winnerSide;
        const rival = row.side === mySide ? oppBest : myBest;
        row.beatsOpponentActive = rival === undefined ? true : row.order < rival;
      });

      this.lastQueue = queue;
      return queue;
    }

    _row(mon, side, move, bracket, tr, field) {
      const speed = this.getEffectiveSpeed(mon, tr, field);
      const believed = this.believedSpeed(mon, tr, field);
      return {
        name: move.name,
        moveId: move.id,
        side: side,
        species: mon.species || mon.id,
        slot: mon.slot || null,
        priority: bracket,
        bracket: bracket,
        bracketLabel: bracketLabel(bracket),
        effectiveSpeed: speed,
        believedSpeed: believed,
        rank: tr ? SPEED_RANK_BASE - believed : believed,
        isProtect: U.isProtectMove(move.name),
        isRecovery: U.isRecoveryMove(move.name),
        isPivot: U.isPivotMove(move.name),
        isStatus: U.isStatusMove(move.name),
        isTrickRoom: toID(move.name) === 'trickroom',
        disabled: !!move.disabled,
        disabledReason: move.disabledReason || '',
        movesText: (mon.species || '?') + ' ' + (bracket > 0 ? '+' + bracket + ' ' : bracket < 0 ? bracket + ' ' : '') + move.name,
        order: -1
      };
    }

    /* ------------------------------------------------------------ setters */

    /** Does this set / MonState list Trick Room? */
    isTrickRoomSet(set) {
      if (!set) return false;
      const moves = set.moves || set.setMoves || set.revealedMoves || [];
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        if (toID(typeof m === 'string' ? m : (m && (m.name || m.move))) === 'trickroom') return true;
      }
      return false;
    }

    /** Pure species/evidence guess that this Pokémon can set Trick Room. */
    isTRSetter(mon) {
      if (!mon) return false;
      if (mon.setMoves && this.isTrickRoomSet({ moves: mon.setMoves })) return true;
      if (mon.revealedMoves && this.isTrickRoomSet({ moves: mon.revealedMoves })) return true;
      if (this.isTrickRoomSet(mon.liveSet)) return true;
      if (mon.candidateSets && mon.candidateSets.length) {
        for (let i = 0; i < mon.candidateSets.length; i++) {
          if (this.isTrickRoomSet(mon.candidateSets[i])) return true;
        }
      }
      const id = mon.id || toID(mon.species);
      if (!U.TR_SETTERS.has(id)) return false;
      // a pure species guess is weaker evidence: only trust it before the moves are known
      return !mon.revealedMoves || mon.revealedMoves.length < 3;
    }

    setterIsAlive(mon) {
      return !!mon && !mon.fainted && (mon.hp === null || mon.hp === undefined || mon.hp > 0) && this.isTRSetter(mon);
    }

    /** Living Trick Room setters on the player's side (active first, then bench order). */
    listSetters(state) {
      const st = state || this._state;
      if (!st) return [];
      const mySide = st.mySide || 'p1';
      const team = (st.getTeam && typeof st.getTeam === 'function') ? (st.getTeam(mySide) || []) : (st.myTeam || []);
      return team.filter((mon) => this.setterIsAlive(mon));
    }

    livingSetters(state) { return this.listSetters(state).length; }

    totalSetters(state) {
      const st = state || this._state;
      if (!st) return 0;
      const mySide = st.mySide || 'p1';
      const team = (st.getTeam && typeof st.getTeam === 'function') ? (st.getTeam(mySide) || []) : (st.myTeam || []);
      return team.filter((mon) => this.isTRSetter(mon)).length;
    }

    /** Living setters / setters the team started with (tempo v8: Setter Health Factor). */
    setterHealthFactor(state) {
      const total = this.totalSetters(state);
      if (!total) return 0;
      return clamp(this.livingSetters(state) / total, 0, 1);
    }

    /** Alias kept for tempo_vector.js, which reads setterHealth(state). */
    setterHealth(state) { return this.setterHealthFactor(state); }

    opponentHasSetter(state) {
      const st = state || this._state;
      if (!st) return false;
      const opp = st.oppTeam || [];
      for (let i = 0; i < opp.length; i++) {
        if (this.setterIsAlive(opp[i])) return true;
      }
      return false;
    }

    /* ------------------------------------------------------------ lifecycle */

    /** Called on every |turn| event. Read-only; returns the lifecycle transition. */
    tick(state) {
      const st = state || this._state;
      if (!st) return { active: false, turnsLeft: 0, alert: null, started: false, ended: false };
      const prev = this.lastField;
      const wasActive = !!(prev && prev.trickRoom);
      this._state = st;
      this.lastField = this.fieldOf(st);
      const active = !!this.lastField.trickRoom;
      const turnsLeft = this.turnsLeft(st);
      const last = this.history.length ? this.history[this.history.length - 1] : null;
      if (!last || last.turnsLeft !== turnsLeft || last.active !== active) {
        this.history.push({ turn: this.lastField.turn || st.turn || 0, active: active, turnsLeft: turnsLeft });
        if (this.history.length > TR_MAX_HISTORY) this.history.shift();
      }
      this.alert = this.getLifecycleAlert(turnsLeft);
      return { active: active, turnsLeft: turnsLeft, alert: this.alert, started: active && !wasActive, ended: !active && wasActive };
    }

    /**
     * Writes mon.speedOverride for both actives from the believed Speed (the single field
     * this module is allowed to write). Returns the map it wrote.
     */
    applySpeedOverrides(state) {
      const st = state || this._state;
      if (!st || !st.active) return {};
      const tr = this.isTrickRoomActive(st);
      const out = {};
      ['my', 'opp'].forEach((key) => {
        const mon = st.active[key];
        if (!mon) return;
        const speed = this.getEffectiveSpeed(mon, tr, st);
        mon.speedOverride = speed;
        out[mon.id || key] = speed;
      });
      return out;
    }

    /* ------------------------------------------------------------ advice */

    /** -> { shouldSet, reason, turnsLeft, alert, invertedQueue, slowestFirst, ... } */
    advise(state) {
      if (!state) {
        return { shouldSet: false, reason: 'no battle state', turnsLeft: 0, invertedQueue: [], alert: null, slowestFirst: null };
      }
      this.decisions++;
      this._state = state;
      this.lastField = this.fieldOf(state);
      const active = !!this.lastField.trickRoom;
      const turnsLeft = this.turnsLeft(state);
      const live = state.active || {};
      const me = live.my || null;
      const opp = live.opp || null;
      const invertedQueue = this.buildSpeedQueue(me, opp, active, state);
      const setters = this.listSetters(state);
      const mySpeed = me ? this.believedSpeed(me, active, state) : 0;
      const oppSpeed = opp ? this.believedSpeed(opp, active, state) : 0;
      let shouldSet = false;
      let reason = '';

      if (active) {
        if (turnsLeft <= 1) {
          reason = 'Trick Room expires next turn: refresh it or attack; do not hard-switch healthy breakers.';
          shouldSet = !!(me && this.isTRSetter(me)) && setters.length > 0;
        } else {
          reason = 'Trick Room is live for ' + turnsLeft + ' more turn(s); spend them attacking.';
        }
      } else if (!setters.length) {
        reason = 'No living Trick Room setter left on your side.';
      } else {
        const myTeam = (state.getTeam && typeof state.getTeam === 'function') ? (state.getTeam(state.mySide || 'p1') || []) : (state.myTeam || []);
        const oppTeam = (state.getTeam && typeof state.getTeam === 'function') ? (state.getTeam(state.oppSide || 'p2') || []) : (state.oppTeam || []);
        const myAvg = mean(myTeam.filter((m) => !m.fainted).map((m) => this.getEffectiveSpeed(m, false, state)));
        const oppAvg = mean(oppTeam.filter((m) => !m.fainted).map((m) => this.getEffectiveSpeed(m, false, state)));
        const iAmSlower = oppSpeed > mySpeed;
        const myActiveCanSet = !!(me && this.isTRSetter(me));
        if (myActiveCanSet && mySpeed >= oppSpeed * 1.25 && myAvg >= oppAvg) {
          reason = 'You already outrun the opponent (' + mySpeed + ' vs ' + oppSpeed + ') — Trick Room would hand them the initiative.';
        } else if (myActiveCanSet && iAmSlower) {
          shouldSet = true;
          reason = 'Slower than ' + (opp ? opp.species : 'the opponent') + ' (' + oppSpeed + ' vs ' + mySpeed + ') and a healthy setter is on the field: TR inverts the whole matchup.';
        } else if (myActiveCanSet) {
          reason = 'Even on raw speed, but your team is slower on average (' + round1(myAvg) + ' vs ' + round1(oppAvg) + ') — Trick Room flips the initiative.';
          shouldSet = myAvg < oppAvg;
        } else {
          const setter = this._bestSetter(setters, state);
          reason = 'Hold ' + (setter ? setter.species : 'the setter') + ' until a slow breaker can enter behind Trick Room.';
        }
      }

      const advice = {
        shouldSet: shouldSet,
        reason: reason,
        turnsLeft: turnsLeft,
        alert: this.getLifecycleAlert(turnsLeft),
        invertedQueue: invertedQueue,
        slowestFirst: invertedQueue.length ? invertedQueue[0] : null,
        mySpeed: mySpeed,
        oppSpeed: oppSpeed,
        setters: setters.map((m) => m.species),
        livingSetters: setters.length
      };
      this.lastAdvice = advice;
      return advice;
    }

    _bestSetter(setters, state) {
      let best = null;
      let bestScore = -Infinity;
      const me = (state && state.active && state.active.my) || null;
      const opp = (state && state.active && state.active.opp) || null;
      for (let i = 0; i < setters.length; i++) {
        const mon = setters[i];
        let score = mon === me ? 40 : 0;
        score += (mon.hp === null || mon.hp === undefined ? 60 : mon.hp) * 0.4;
        score -= this.getEffectiveSpeed(mon, false, state) * 0.05;
        if (this.damage && opp && mon !== me) {
          const threat = this.damage.getBestIncomingThreat(opp, mon, this.fieldOf(state));
          if (threat && threat.avgPercent) score -= threat.avgPercent * 0.5;
        }
        if (score > bestScore) { bestScore = score; best = mon; }
      }
      return best;
    }

    /** Compact block for the HUD drawer / LLM prompt. */
    describe(state) {
      const st = state || this._state;
      const active = this.isTrickRoomActive(st);
      const turnsLeft = active ? this.turnsLeft(st) : 0;
      const queue = this.buildSpeedQueue(st && st.active ? st.active.my : null, st && st.active ? st.active.opp : null, active, st);
      const lines = queue.slice(0, 6).map((row) => (row.order + 1) + '. ' + row.movesText + ' [' + row.bracketLabel + '|' + row.effectiveSpeed + ']');
      return {
        active: active,
        turnsLeft: turnsLeft,
        alert: this.getLifecycleAlert(turnsLeft),
        setters: this.listSetters(st).map((m) => m.species),
        queue: queue,
        text: (active ? 'TR ' + turnsLeft + '/5' : 'TR off') + ' · ' + lines.join(' · ')
      };
    }

    reset() {
      this._state = null;
      this.lastState = null;
      this.lastField = null;
      this.lastQueue = [];
      this.lastAdvice = null;
      this.alert = null;
      this.history = [];
      this.decisions = 0;
    }
  }

  TrickRoomEngine.TURN_COUNT = TR_TURNS;
  TrickRoomEngine.EXPIRY_ALERT = TR_ALERT_FINAL;
  TrickRoomEngine.SPEED_RANK_BASE = SPEED_RANK_BASE;
  TrickRoomEngine.BRACKET_OVERRIDES = BRACKET_OVERRIDES;
  TrickRoomEngine.PRIORITY_TABLE = {
    '2': PRIORITY_2,
    '1': PRIORITY_1,
    '-3': PRIORITY_MINUS_3,
    '-4': PRIORITY_MINUS_4,
    '-5': PRIORITY_MINUS_5,
    '-6': PRIORITY_MINUS_6,
    '-7': PRIORITY_MINUS_7
  };
  TrickRoomEngine.bracketLabel = bracketLabel;

  ST.TrickRoomEngine = TrickRoomEngine;
})();
