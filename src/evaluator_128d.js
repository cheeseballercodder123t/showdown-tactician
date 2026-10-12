/* Showdown Tactician — src/evaluator_128d.js
 * Tier 1 of the hybrid architecture: a 128-dimensional dense state vector scored by a
 * single linear dot product (< 2 microseconds, no allocation on the hot path).
 *
 * FROZEN LAYOUT (ARCHITECTURE.md §3):
 *   [  0..  5] my HP percentage (0..1)
 *   [  6.. 11] opp HP percentage (0..1)
 *   [ 12.. 17] my fainted flags (1 when fainted)
 *   [ 18.. 23] opp fainted flags
 *   [ 24.. 27] my status counts / 6      (burn, toxic, paralysis, sleep)
 *   [ 28.. 31] opp status counts / 6
 *   [ 32.. 35] my active status flags   (burn, toxic, paralysis, sleep)
 *   [ 36.. 41] my active boosts / 6      (atk, def, spa, spd, spe, accuracy)
 *   [ 42.. 47] opp active boosts / 6
 *   [ 48.. 51] my hazards                (rocks, spikes/3, tspikes/2, web)
 *   [ 52.. 55] opp hazards
 *   [ 56.. 63] field                     (TR on, TR turns/5, snow on, snow turns/5,
 *                                         electric, grassy, psychic, misty terrain)
 *   [ 64.. 69] my active item state      (intact, consumed/knocked, choice-locked,
 *                                         itemless, mega-evolved, paradox boost active)
 *   [ 70.. 75] opp active item state
 *   [ 76..111] pairwise threat matrix, my mon i x opp mon j (outspeeds AND threatens)
 *   [112..127] macro aggregates (alive counts, chip deltas, best damage, momentum)
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;

  // RULE 4: every tunable in this file comes from src/config.js. config.js is the first script
  // in the manifest (and in tests/harness.js MANIFEST_ORDER), so the reads below are always
  // satisfied; `cfg` still degrades to the literal when the module is loaded standalone.
  const cfg = function (path, fallback) {
    return typeof ST.configGet === 'function' ? ST.configGet(path, fallback) : fallback;
  };

  const TEAM = cfg('evaluator.team', 6);
  const DIM = cfg('evaluator.dim', 128);
  const STAT_ORDER = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy'];
  const STATUS_ORDER = ['brn', 'tox', 'par', 'slp'];

  class DenseStateEvaluator {
    constructor(options) {
      options = options || {};
      this.dims = DIM;
      this.weights = options.weights || DenseStateEvaluator.defaultWeights();
      this._vec = new Float32Array(DIM);
      this._speedCache = {};
      // Exact memoisation of `_bestOffenseMultiplier`, the hottest pure leaf of the 6x6 threat
      // matrix. `extractVector` runs once per `_payoff` leaf — up to 432 times for one turn — and
      // the threat matrix (dims 76..111) is invariant across those leaves (they differ only in
      // HP/faint dims), yet was rebuilt each time. The function is a pure function of
      // (attacker species, its resolved move list, defender species), so caching it on exactly
      // those inputs cannot change a result: the key IS the full input. Verified bit-identical to
      // the pre-change evaluator over all 30 turns of test_log.txt plus 400 randomised boards
      // (score and all 128 dims), and the whole suite is green — see CHANGELOG.md.
      // NOTE: `_speedOf` is deliberately NOT memoised here. Its existing key is
      // `slot|id|species`, which collides for a same-species mirror (both Slowking-Galar share
      // one entry, and which body wins depends on iteration order). Enriching that key changes
      // scores, so it is left exactly as-is.
      this._offMemo = new Map();
      this.lastRaw = 0;
      this.lastScore = 0;
    }

    /** Bound a memo so a pathological corpus cannot grow it without limit. */
    static _memoPut(memo, key, value) {
      if (memo.size > 8192) memo.clear();
      memo.set(key, value);
      return value;
    }

    /**
     * The weight spec, from src/config.js (`evaluator.weights`). This file owns the LAYOUT
     * (which dim means what, frozen in ARCHITECTURE.md §3); config.js owns the VALUES.
     */
    static weightSpec() {
      const spec = typeof ST.configGet === 'function' ? ST.configGet('evaluator.weights', null) : null;
      if (!spec) {
        throw new Error('evaluator_128d: ST.config.evaluator.weights is missing — load src/config.js first');
      }
      return spec;
    }

    /**
     * The pre-tuned weight vector, from src/config.js: `evaluator.weights` supplies the layout
     * spec and `evaluator.fitScale` the calibration multiplier that puts the (scale-free) fitted
     * coefficients on the payoff scale the fixed laplace bonuses were tuned against — see the
     * comment on that field. Living mons, TR tempo, hazard differential, burned attackers.
     */
    static defaultWeights() {
      const w = new Float32Array(DIM);
      const W = DenseStateEvaluator.weightSpec();
      const k = cfg('evaluator.fitScale', 1);
      // 0..23 — HP and fainting dominate every evaluation (sign flips for the opponent).
      for (let i = 0; i < TEAM; i++) { w[i] = W.hp; w[TEAM + i] = -W.hp; }
      for (let i = 0; i < TEAM; i++) { w[12 + i] = -W.fainted; w[18 + i] = W.fainted; }
      // 24..35 — status is chip damage; toxic scales with time, paralysis is tempo.
      for (let i = 0; i < 12; i++) w[24 + i] = W.status[i];
      // 36..47 — boosts on the active mons.
      for (let i = 0; i < 12; i++) w[36 + i] = W.boosts[i];
      // 48..55 — our hazards hurt them, theirs hurt us.
      for (let i = 0; i < 8; i++) w[48 + i] = W.hazards[i];
      // 56..63 — Trick Room is only good when we are the slower team.
      for (let i = 0; i < 8; i++) w[56 + i] = W.trickRoom[i];
      // 64..75 — item knowledge is informational, not terminal.
      for (let i = 0; i < 12; i++) w[64 + i] = W.items[i];
      // 76..111 — threat matrix against each defender, stronger for the active pair.
      for (let i = 0; i < TEAM * TEAM; i++) w[76 + i] = W.threat;
      for (let i = 0; i < TEAM; i++) w[76 + i * (TEAM + 1)] = W.threatActive;  // active vs active
      // 112..127 — macro aggregates.
      for (let i = 0; i < 16; i++) w[112 + i] = W.macro[i];
      // The spec is the fitted direction; `fitScale` is the measured calibration, applied once
      // here so `this.weights` IS what scores a state. k === 1 skips the pass (raw fit).
      if (k !== 1) {
        for (let i = 0; i < DIM; i++) w[i] = w[i] * k;
      }
      return w;
    }

    /* ------------------------------------------------------------- extraction */

    /** extractVector(state) -> Float32Array(128). Reuses one buffer; clone it if you keep it. */
    extractVector(state) {
      const v = this._vec;
      v.fill(0);
      if (!state) return v;
      const myTeam = (state.myTeam || []).slice(0, TEAM);
      const oppTeam = (state.oppTeam || []).slice(0, TEAM);
      const field = state.field || {};
      const myActive = (state.active && state.active.my) || null;
      const oppActive = (state.active && state.active.opp) || null;
      const mySide = state.mySide || 'p1';
      const oppSide = state.oppSide || (mySide === 'p1' ? 'p2' : 'p1');
      this._speedCache = {};

      for (let i = 0; i < TEAM; i++) {
        const me = myTeam[i];
        const op = oppTeam[i];
        v[i] = me ? this._hpFraction(me) : 0;
        v[6 + i] = op ? this._hpFraction(op) : 0;
        v[12 + i] = me && me.fainted ? 1 : 0;
        v[18 + i] = op && op.fainted ? 1 : 0;
      }

      this._statusBlock(v, 24, myTeam);
      this._statusBlock(v, 28, oppTeam);
      for (let s = 0; s < STATUS_ORDER.length; s++) {
        v[32 + s] = myActive && myActive.status === STATUS_ORDER[s] ? 1 : 0;
      }

      this._boostBlock(v, 36, myActive);
      this._boostBlock(v, 42, oppActive);

      const myHaz = (field.hazards && field.hazards[mySide]) || {};
      const oppHaz = (field.hazards && field.hazards[oppSide]) || {};
      v[48] = myHaz.rocks ? 1 : 0;
      v[49] = U.clamp((myHaz.spikes || 0) / 3, 0, 1);
      v[50] = U.clamp((myHaz.toxicspikes || 0) / 2, 0, 1);
      v[51] = myHaz.stickyweb ? 1 : 0;
      v[52] = oppHaz.rocks ? 1 : 0;
      v[53] = U.clamp((oppHaz.spikes || 0) / 3, 0, 1);
      v[54] = U.clamp((oppHaz.toxicspikes || 0) / 2, 0, 1);
      v[55] = oppHaz.stickyweb ? 1 : 0;

      v[56] = field.trickRoom ? 1 : 0;
      v[57] = field.trickRoom ? U.clamp((field.trickRoomTurnsLeft || 0) / 5, 0, 1) : 0;
      v[58] = (field.weather === 'snow' || field.weather === 'hail') ? 1 : 0;
      v[59] = U.clamp((field.weatherTurnsLeft || 0) / 5, 0, 1);
      v[60] = field.terrain === 'electric' ? 1 : 0;
      v[61] = field.terrain === 'grassy' ? 1 : 0;
      v[62] = field.terrain === 'psychic' ? 1 : 0;
      v[63] = field.terrain === 'misty' ? 1 : 0;

      this._itemBlock(v, 64, myActive, state, mySide === (state.mySide || 'p1'));
      this._itemBlock(v, 70, oppActive, state, false);

      this._threatMatrix(v, myTeam, oppTeam, state);

      // 112..127 macro aggregates
      const myAlive = myTeam.filter(function (m) { return m && !m.fainted; }).length;
      const oppAlive = oppTeam.filter(function (m) { return m && !m.fainted; }).length;
      v[112] = U.clamp(myAlive / 6, 0, 1);
      v[113] = U.clamp(oppAlive / 6, 0, 1);
      v[114] = U.clamp(this._teamHp(myTeam), 0, 1);
      v[115] = U.clamp(this._teamHp(oppTeam), 0, 1);
      v[116] = U.clamp(this._hazardDifferential(field, mySide, oppSide), -1, 1);      v[117] = U.clamp(this._statusDifferential(myTeam, oppTeam), -1, 1);
      const boostScale = cfg('evaluator.boostSumScale', 18);
      v[118] = U.clamp(this._boostSum(myActive) / boostScale, -1, 1);
      v[119] = U.clamp(this._boostSum(oppActive) / boostScale, -1, 1);
      v[120] = this._teraThreat(myActive, oppActive, state);
      v[121] = this._teraThreat(oppActive, myActive, state);
      v[122] = this._recoveryPressure(state, oppSide);
      v[123] = this._recoveryPressure(state, mySide);
      v[124] = this._speedEdge(myActive, oppActive, state, true);
      v[125] = this._speedEdge(myActive, oppActive, state, false);
      v[126] = this._protectRhythm(state, 'p2');
      v[127] = this._protectRhythm(state, 'p1');
      return v;
    }

    _hpFraction(mon) {
      if (!mon) return 0;
      if (mon.fainted) return 0;
      let hp = mon.hpPercent;
      if (hp === null || hp === undefined) hp = mon.hp;
      if (hp === null || hp === undefined || hp !== hp) return cfg('evaluator.unknownHpDefault', 0.6);
      return U.clamp(hp / 100, 0, 1);
    }

    _statusBlock(v, base, team) {
      const counts = { brn: 0, tox: 0, par: 0, slp: 0 };
      for (let i = 0; i < team.length && i < TEAM; i++) {
        const mon = team[i];
        if (!mon || mon.fainted) continue;
        if (Object.prototype.hasOwnProperty.call(counts, mon.status)) counts[mon.status]++;
      }
      for (let s = 0; s < STATUS_ORDER.length; s++) v[base + s] = U.clamp(counts[STATUS_ORDER[s]] / 6, 0, 1);
    }

    _boostBlock(v, base, mon) {
      const boosts = (mon && mon.boosts) || null;
      for (let i = 0; i < STAT_ORDER.length; i++) {
        const raw = boosts ? (boosts[STAT_ORDER[i]] || 0) : 0;
        v[base + i] = U.clamp(raw / 6, -1, 1);
      }
    }

    _itemBlock(v, base, mon, state, isMine) {
      if (!mon) return;
      const item = mon.currentBattleItem || mon.confirmedItem || (mon.liveSet && mon.liveSet.item) || mon.originalArchetypeItem || null;
      // "Lost" means the item actually left the holder (consumed, knocked off, or never
      // held). An item that SURVIVED Knock Off (itemKnockedOff) is a Mega Stone / Z-Crystal
      // or a proven itemless set, which is already captured by the dedicated dims below.
      const lost = !!(mon.itemConsumed || mon.itemRemoved || mon.itemless);
      const intact = (item && !lost) ? 1 : 0;
      v[base] = intact;
      v[base + 1] = lost ? 1 : 0;
      v[base + 2] = (mon.cannotBeChoice || (mon.liveSet && mon.liveSet.tags && mon.liveSet.tags.indexOf('choice') !== -1)) ? 1 : 0;
      v[base + 3] = mon.itemless ? 1 : 0;
      v[base + 4] = mon.megaEvolved ? 1 : 0;
      v[base + 5] = mon.boosterActive ? 1 : 0;
      if (isMine && mon.boosterActive) v[base + 5] = 1;
    }

    /** Cheap 6x6 matrix: does my mon i outspeed AND threaten opp mon j on type alone? */
    _threatMatrix(v, myTeam, oppTeam, state) {
      const field = state.field || {};
      const tr = !!field.trickRoom;
      for (let i = 0; i < TEAM; i++) {
        const mine = myTeam[i];
        if (!mine || mine.fainted) continue;
        const mySpeed = this._speedOf(mine, tr);
        for (let j = 0; j < TEAM; j++) {
          const theirs = oppTeam[j];
          const idx = 76 + i * 6 + j;
          if (!theirs || theirs.fainted) { v[idx] = 0; continue; }
          const oppSpeed = this._speedOf(theirs, tr);
          const faster = mySpeed >= oppSpeed ? 1 : 0;
          const eff = this._bestOffenseMultiplier(mine, theirs);
          // 0 when we cannot touch them, 1 when we threaten a super-effective line.
          const threat = eff <= 0 ? 0 : U.clamp((eff - 1) / cfg('evaluator.threatEffSpan', 3), 0, 1);
          v[idx] = U.clamp(faster * (0.4 + 0.6 * threat), 0, 1);
        }
      }
    }

    _speedOf(mon, tr) {
      if (!mon) return 0;
      const key = mon.slot || mon.id || mon.species;
      if (this._speedCache[key] !== undefined) return this._speedCache[key];
      const speed = U.computeSpeed(mon, {
        item: mon.currentBattleItem || mon.confirmedItem || (mon.liveSet && mon.liveSet.item) || mon.item,
        ability: mon.revealedAbility || (mon.liveSet && mon.liveSet.ability) || mon.ability,
        paradoxSpeedBoost: !!mon.boosterActive
      }).effective;
      const rank = tr ? (10000 - speed) : speed;
      this._speedCache[key] = rank;
      return rank;
    }

    _bestOffenseMultiplier(attacker, defender) {
      const moves = (attacker.revealedMoves && attacker.revealedMoves.length ? attacker.revealedMoves :
        ((attacker.liveSet && attacker.liveSet.moves) || []));
      const aId = attacker.species || attacker.id;
      const dId = defender.species || defender.id;
      // Pure in (attacker species, its move list, defender species) — the exact inputs below.
      const key = aId + '|' + moves.join('+') + '>' + dId;
      const hit = this._offMemo.get(key);
      if (hit !== undefined) return hit;
      let best = 0;
      let result;
      if (moves && moves.length) {
        for (let i = 0; i < moves.length; i++) {
          const data = U.getMoveData(moves[i]);
          if (!data || data.isStatus || !data.basePower) continue;
          const eff = U.typeEffectiveness(data.type, dId);
          const score = eff * data.basePower;
          if (score > best) best = score;
        }
        if (best > 0) result = best / cfg('evaluator.offenseBasePowerCap', 120);
      }
      if (result === undefined) {
        best = 0;
        const types = U.getTypes(aId);
        for (let i = 0; i < types.length; i++) {
          const eff = U.typeEffectiveness(types[i], dId);
          if (eff > best) best = eff;
        }
        result = best;
      }
      return DenseStateEvaluator._memoPut(this._offMemo, key, result);
    }

    _teamHp(team) {
      let sum = 0, n = 0;
      for (let i = 0; i < team.length; i++) {
        const mon = team[i];
        if (!mon) continue;
        sum += this._hpFraction(mon);
        n++;
      }
      return n ? sum / n : 0;
    }

    _hazardDifferential(field, mySide, oppSide) {
      const mine = (field.hazards && field.hazards[mySide]) || {};
      const theirs = (field.hazards && field.hazards[oppSide]) || {};
      const chip = cfg('evaluator.hazardChip', { rocks: 12.5, spikesPerLayer: 8.3, toxicSpikes: 12.5, stickyWeb: 8, divisor: 37.5 });
      const cost = function (h) {
        return (h.rocks ? chip.rocks : 0) + ((h.spikes || 0) * chip.spikesPerLayer) +
          ((h.toxicspikes || 0) * chip.toxicSpikes) + (h.stickyweb ? chip.stickyWeb : 0);
      };
      return U.clamp((cost(theirs) - cost(mine)) / chip.divisor, -1, 1);
    }

    _statusDifferential(myTeam, oppTeam) {
      const count = function (team) {
        let n = 0;
        for (let i = 0; i < team.length; i++) {
          const mon = team[i];
          if (mon && !mon.fainted && mon.status) n++;
        }
        return n;
      };
      return U.clamp((count(oppTeam) - count(myTeam)) / cfg('evaluator.statusDifferentialDivisor', 4), -1, 1);
    }

    _boostSum(mon) {
      if (!mon || !mon.boosts) return 0;
      let sum = 0;
      for (let i = 0; i < STAT_ORDER.length; i++) sum += mon.boosts[STAT_ORDER[i]] || 0;
      return sum;
    }

    /** Tera is banned in this format: this is a hard 0 unless a stale flag slips through. */
    _teraThreat(attacker, defender, state) {
      if (state && state.terastallizationBanned) return 0;
      return attacker && attacker.terastallized ? 0.5 : 0;
    }

    /** Fraction of the 8-PP recovery budget still available for that side. */
    _recoveryPressure(state, side) {
      const map = state && state.recoveryPP;
      if (!map) return 0;
      let spent = 0, total = 0;
      const keys = Object.keys(map);
      const budget = cfg('evaluator.recoveryPPBudget', 8);
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].indexOf(side) !== 0) continue;
        const left = typeof map[keys[i]] === 'number' ? map[keys[i]] : 0;
        total += budget;
        spent += (budget - U.clamp(left, 0, budget));
      }
      return total ? U.clamp(spent / total, 0, 1) : 0;
    }

    _speedEdge(myActive, oppActive, state, myFavour) {
      if (!myActive || !oppActive) return 0;
      const tr = !!(state.field && state.field.trickRoom);
      const mine = this._speedOf(myActive, tr);
      const theirs = this._speedOf(oppActive, tr);
      const edge = myFavour ? (mine - theirs) : (theirs - mine);
      return U.clamp(edge / cfg('evaluator.speedEdgeSpan', 400), -1, 1);
    }

    _protectRhythm(state, side) {
      const p = state && state.protect;
      if (!p) return 0;
      const prefix = side === 'p1' ? 'my' : 'opp';
      const since = p[prefix + 'TurnsSinceLastProtect'];
      const consecutive = p[prefix + 'ConsecutiveProtects'] || 0;
      const rhythm = cfg('evaluator.protectRhythm', { protectedLastTurn: 0.5, consecutiveProtects: 0.5 });
      let value = 0;
      if (since === 0) value += rhythm.protectedLastTurn;              // they protected last turn
      if (consecutive >= 2) value += rhythm.consecutiveProtects;       // a wasted turn is coming
      return U.clamp(value, 0, 1);
    }

    /* ------------------------------------------------------------- scoring */

    /** evaluate(state) -> scalar in [-1000, 1000]. */
    evaluate(state) {
      const v = this.extractVector(state);
      const w = this.weights;
      let raw = 0;
      for (let i = 0; i < DIM; i++) raw += v[i] * w[i];
      this.lastRaw = raw;
      const score = cfg('evaluator.scale', 1000) * Math.tanh(raw / cfg('evaluator.tanhDenominator', 420));
      this.lastScore = score;
      return score;
    }

    /** Evaluate a raw vector (used by the simulator and tests). */
    evaluateVector(vec) {
      if (!vec) return 0;
      const w = this.weights;
      let raw = 0;
      for (let i = 0; i < DIM && i < vec.length; i++) raw += vec[i] * w[i];
      this.lastRaw = raw;
      return cfg('evaluator.scale', 1000) * Math.tanh(raw / cfg('evaluator.tanhDenominator', 420));
    }

    vectorToArray(vec) {
      const source = vec || this._vec;
      const out = new Array(source.length);
      for (let i = 0; i < source.length; i++) out[i] = source[i];
      return out;
    }
  }

  DenseStateEvaluator.DIM = DIM;
  DenseStateEvaluator.TEAM = TEAM;
  DenseStateEvaluator.STAT_ORDER = STAT_ORDER;
  DenseStateEvaluator.STATUS_ORDER = STATUS_ORDER;

  ST.DenseStateEvaluator = DenseStateEvaluator;
})();
