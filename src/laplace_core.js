/* Showdown Tactician — src/laplace_core.js
 * The master coordinator (Part 2, Module 13). Recreates the 2231-Elo Laplace loop:
 *   sample K worlds -> enumerate legal actions -> 1-ply simultaneous payoff matrix ->
 *   128D leaf evaluation -> 0.6 avg / 0.4 min blend -> world vote pooling ->
 *   tempo policy mask -> deterministic blunder vetoes -> softmax (T = 35).
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;

  /* RULE 4 — every tunable in this file comes from src/config.js, which the manifest loads
   * first. `cfgGet` returns the literal fallback only when config.js itself is missing, so a
   * stripped build behaves exactly as it did before the config existed while editing the
   * config is always sufficient to retune the solver. */
  const cfgGet = (typeof ST.configGet === 'function')
    ? ST.configGet
    : function (path, fallback) { return fallback; };

  const VETO_SCORE = -9999;   // published static contract; the live value is laplace.vetoScore

  class LaplaceEngine {
    constructor(options) {
      options = options || {};
      // Precedence (unchanged): explicit option > src/config.js > literal fallback.
      this.K = options.K || cfgGet('laplace.K', 6);
      this.temperature = options.temperature || cfgGet('laplace.temperature', 35);
      // Cloned so a caller mutating engine.worldBlend can never write into the shared config.
      this.worldBlend = options.worldBlend ||
        Object.assign({}, cfgGet('laplace.worldBlend', { avg: 0.6, min: 0.4 }));
      this.maxOppActions = options.maxOppActions || cfgGet('laplace.maxOppActions', 9);
      // Terminal payoff for taking (or losing) the last body on the field.
      this.lethalBonus = options.lethalBonus || cfgGet('laplace.lethalBonus', 260);
      // Bench switches synthesised when there is no |request| to read.
      this.maxSwitchFallback = options.maxSwitchFallback || cfgGet('laplace.maxSwitchFallback', 5);
      this.vetoScore = options.vetoScore || cfgGet('laplace.vetoScore', VETO_SCORE);
      // Stand-in damage when the opponent has nothing left but Struggle.
      this.struggleChipPercent = options.struggleChipPercent || cfgGet('laplace.struggleChipPercent', 5);
      // Reward for a payoff where their switch ate our move for free.
      this.switchAteHitBonus = options.switchAteHitBonus || cfgGet('laplace.switchAteHitBonus', 25);
      this.damage = options.damage || (ST.DamageEngine ? new ST.DamageEngine({ gen: 9 }) : null);
      this.evaluator = options.evaluator || (ST.DenseStateEvaluator ? new ST.DenseStateEvaluator() : null);
      this.trickRoom = options.trickRoom || (ST.TrickRoomEngine ? new ST.TrickRoomEngine(this.damage) : null);
      this.tempo = options.tempo || (ST.TempoEngine ? new ST.TempoEngine({ damage: this.damage, trickRoom: this.trickRoom }) : null);
      this.veto = options.veto || (ST.BlunderVetoGuard ? new ST.BlunderVetoGuard({ damage: this.damage, trickRoom: this.trickRoom }) : null);
      this.sampler = options.sampler || (ST.WorldSampler ? new ST.WorldSampler({ K: this.K }) : null);
      this.lastReadout = null;
      this.turnCache = {};
    }

    /* ------------------------------------------------------------- actions */

    /** Legal player actions: 4 moves + living bench switches. */
    getMyActions(state) {
      const out = [];
      if (!state) return out;
      const legal = state.legalActions || {};
      const moves = legal.moves || [];
      const seen = {};
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        if (!m || m.disabled) continue;
        const id = U.toID(m.id || m.name);
        if (!id || seen[id]) continue;
        seen[id] = 1;
        const data = U.getMoveData(m.name || m.id);
        out.push({
          kind: data && data.isProtect ? 'protect' : 'move',
          name: m.name || m.id,
          moveId: id,
          targetId: null,
          pp: m.pp,
          maxpp: m.maxpp
        });
      }
      if (!out.length) {
        const active = state.active && state.active.my;
        const fallback = active && ((active.setMoves && active.setMoves.length && active.setMoves) ||
          (active.liveSet && active.liveSet.moves) || active.revealedMoves || []);
        for (let i = 0; fallback && i < fallback.length; i++) {
          const name = fallback[i];
          if (!name) continue;
          const id = U.toID(name);
          if (seen[id]) continue;
          seen[id] = 1;
          const data = U.getMoveData(name);
          out.push({ kind: data && data.isProtect ? 'protect' : 'move', name: name, moveId: id, targetId: null });
        }
      }
      const switches = legal.switches || [];
      for (let i = 0; i < switches.length; i++) {
        const s = switches[i];
        if (!s) continue;
        out.push({ kind: 'switch', name: s.name || s.id, moveId: null, targetId: s.id || s.slot || s.name, switchSlot: s.slot });
      }
      if (!switches.length) {
        const bench = (state.myTeam || []).filter(function (mon) {
          return mon && !mon.fainted && !mon.isActive && mon.revealed !== false;
        });
        for (let i = 0; i < bench.length && i < this.maxSwitchFallback; i++) {
          out.push({ kind: 'switch', name: bench[i].species || bench[i].id, moveId: null, targetId: bench[i].species || bench[i].id, switchSlot: bench[i].slot });
        }
      }
      return out;
    }

    /** Plausible opponent actions inside a sampled world: their 4 moves (+ switches). */
    getOppActions(world, state) {
      const out = [];
      const active = world && world.team ? world.team.find(function (m) { return m.isActive; }) || world.team[0] : null;
      const moves = (active && active.setMoves) || [];
      for (let i = 0; i < moves.length; i++) {
        const name = moves[i];
        if (!name) continue;
        const data = U.getMoveData(name);
        out.push({
          kind: data && data.isProtect ? 'protect' : 'move',
          name: name,
          moveId: U.toID(name),
          targetId: null
        });
      }
      const bench = (world && world.team ? world.team : []).filter(function (m) { return m && !m.fainted && !m.isActive; });
      for (let i = 0; i < bench.length && i < 4; i++) {
        out.push({ kind: 'switch', name: bench[i].species, moveId: null, targetId: bench[i].species });
      }
      if (!out.length) out.push({ kind: 'move', name: 'Struggle', moveId: 'struggle' });
      return out.slice(0, this.maxOppActions);
    }

    /* ------------------------------------------------------------- simulation */

    /**
     * simulate(action, world, battleState) -> SimResult
     * One-ply transition: both sides act, HP moves, faints latch, hazards/TR stay fixed.
     */
    simulate(action, world, battleState) {
      const state = battleState || {};
      const field = state.field || {};
      const myActive = (state.active && state.active.my) || null;
      const oppActive = this._oppActive(world, state);
      const result = {
        state: state,
        myPercentDelta: 0,
        oppPercentDelta: 0,
        events: [],
        myMove: action ? action.name : null,
        oppMon: oppActive ? oppActive.species : null
      };
      if (!myActive || !oppActive || !this.damage) return result;

      let myHp = this._hp(myActive);
      let oppHp = this._hp(oppActive);

      if (action && action.kind === 'move' || action && action.kind === 'protect') {
        const dmg = this._damageOf(myActive, oppActive, action.name, field, true);
        if (dmg) {
          oppHp = U.clamp(oppHp - dmg.avgPercent, 0, 100);
          result.oppPercentDelta = -dmg.avgPercent;
          result.events.push({ type: 'damage', side: 'p2', move: action.name, percent: U.round1(dmg.avgPercent), ohko: dmg.isOHKO });
        }
      } else if (action && action.kind === 'switch') {
        const incoming = this._switchTarget(state, action);
        if (incoming) {
          result.events.push({ type: 'switch', side: 'p1', species: incoming.species });
          const haz = field.hazards && field.hazards[state.mySide || 'p1'];
          const chip = U.hazardPercent(incoming.species || incoming.id,
            (incoming.currentBattleItem || incoming.confirmedItem || ''), incoming.revealedAbility || '', haz || {});
          if (chip > 0) {
            result.myPercentDelta = -chip;
            result.events.push({ type: 'hazards', side: 'p1', percent: chip });
          }
        }
      }

      // The opponent always gets their line.
      const oppBest = this._damageOf(oppActive, myActive, this._bestMove(oppActive, myActive, field), field, false);
      if (oppBest) {
        myHp = U.clamp(myHp - oppBest.avgPercent, 0, 100);
        result.myPercentDelta -= oppBest.avgPercent;
        result.events.push({ type: 'damage', side: 'p1', move: oppBest.move, percent: U.round1(oppBest.avgPercent), ohko: oppBest.isOHKO });
      }

      result.myHpAfter = myHp;
      result.oppHpAfter = oppHp;
      result.myFaints = myHp <= 0;
      result.oppFaints = oppHp <= 0;
      result.state = this._mutableSim(state, myActive, oppActive, myHp, oppHp, result);
      return result;
    }

    _oppActive(world, state) {
      if (world && world.team && world.team.length) {
        const active = world.team.find(function (m) { return m.isActive; });
        if (active) return active;
        const first = world.team[0];
        if (first) return first;
      }
      return (state.active && state.active.opp) || null;
    }

    _switchTarget(state, action) {
      const team = state.myTeam || [];
      const wanted = U.toID(action.targetId || action.name || '');
      for (let i = 0; i < team.length; i++) {
        const mon = team[i];
        if (!mon || mon.fainted || mon.isActive) continue;
        if (U.toID(mon.species || mon.id) === wanted) return mon;
        if (action.switchSlot && mon.slot === action.switchSlot) return mon;
      }
      for (let i = 0; i < team.length; i++) {
        if (team[i] && !team[i].fainted && !team[i].isActive && team[i].revealed !== false) return team[i];
      }
      return null;
    }

    _mutableSim(state, myActive, oppActive, myHp, oppHp, result) {
      const sim = Object.create(state);
      sim.active = { my: myActive, opp: oppActive };
      sim._sim = {
        myHp: myHp, oppHp: oppHp,
        myFaints: result.myFaints, oppFaints: result.oppFaints
      };
      return sim;
    }

    _damageOf(attacker, defender, moveName, field, outgoing) {
      if (!this.damage || !moveName) return null;
      try {
        const res = this.damage.calculateDamage(attacker, defender, moveName, field);
        if (!res || res.failed) return null;
        return { move: moveName, minPercent: res.minPercent || 0, maxPercent: res.maxPercent || 0, avgPercent: res.avgPercent || 0, isOHKO: !!res.isOHKO, is2HKO: !!res.is2HKO };
      } catch (e) { return null; }
    }

    _bestMove(mon, target, field) {
      const moves = (mon && mon.setMoves) || (mon && mon.liveSet && mon.liveSet.moves) || (mon && mon.revealedMoves) || [];
      let best = null, bestDmg = -1;
      for (let i = 0; i < moves.length; i++) {
        const res = this._damageOf(mon, target, moves[i], field, false);
        if (res && res.avgPercent > bestDmg) { bestDmg = res.avgPercent; best = moves[i]; }
      }
      return best || 'Struggle';
    }

    _hp(mon) {
      if (!mon) return 100;
      let hp = mon.hpPercent;
      if (hp === null || hp === undefined) hp = mon.hp;
      if (hp === null || hp === undefined || hp !== hp) return 100;
      return hp;
    }

    /* ------------------------------------------------------------- evaluation */

    /** Payoff of (myAction vs oppAction) in a simulated 1-ply state. */
    _payoff(myAction, oppAction, state, field) {
      const myActive = state.active && state.active.my;
      const oppActive = state.active && state.active.opp;
      if (!myActive || !oppActive || !this.evaluator) return 0;
      let myHp = this._hp(myActive);
      let oppHp = this._hp(oppActive);
      let mySideMon = myActive;
      const events = [];

      if (myAction.kind === 'switch') {
        const incoming = this._switchTarget(state, myAction);
        if (incoming) {
          mySideMon = incoming;
          const haz = field.hazards && field.hazards[state.mySide || 'p1'];
          const chip = U.hazardPercent(incoming.species || incoming.id,
            incoming.currentBattleItem || incoming.confirmedItem || '', incoming.revealedAbility || '', haz || {});
          myHp = U.clamp(this._hp(incoming) - chip, 0, 100);
        }
      } else {
        const dmg = this._damageOf(myActive, oppActive, myAction.name, field, true);
        if (dmg) {
          oppHp = U.clamp(oppHp - dmg.avgPercent, 0, 100);
          events.push(dmg);
        }
      }

      if (oppAction.kind === 'switch') {
        // Switched-out opponent survives; the new body is unscratched.
        oppHp = 100;
      } else {
        const dmg = oppAction.name === 'Struggle'
          ? { avgPercent: this.struggleChipPercent, isOHKO: false }
          : this._damageOf(oppActive, mySideMon, oppAction.name, field, false);
        if (dmg) {
          myHp = U.clamp(myHp - dmg.avgPercent, 0, 100);
        }
      }

      const sim = this._leafState(state, mySideMon, oppActive, myHp, oppHp);
      let score = this.evaluator.evaluate(sim);
      // Terminal bonuses keep the leaf evaluator honest about KOs.
      if (oppHp <= 0) score += this.lethalBonus;
      if (myHp <= 0) score -= this.lethalBonus;
      if (oppAction.kind === 'switch' && myAction.kind === 'move') score += this.switchAteHitBonus;   // their switch ate our hit for free
      return score;
    }

    _leafState(state, myMon, oppMon, myHp, oppHp) {
      const leaf = {
        myTeam: null,
        oppTeam: null,
        field: state.field,
        active: { my: null, opp: null },
        bench: state.bench,
        protect: state.protect,
        recoveryPP: state.recoveryPP,
        terastallizationBanned: state.terastallizationBanned,
        mySide: state.mySide,
        oppSide: state.oppSide
      };
      const cloneMon = function (mon, hp) {
        if (!mon) return null;
        const copy = Object.create(mon);
        copy.hp = hp;
        copy.hpPercent = hp;
        copy.fainted = hp <= 0;
        return copy;
      };
      leaf.active.my = cloneMon(myMon, myHp);
      leaf.active.opp = cloneMon(oppMon, oppHp);
      leaf.myTeam = (state.myTeam || []).map(function (m) {
        if (m === (state.active && state.active.my)) return leaf.active.my;
        return m;
      });
      leaf.oppTeam = (state.oppTeam || []).map(function (m) {
        if (m === (state.active && state.active.opp)) return leaf.active.opp;
        return m;
      });
      if (!leaf.myTeam.length && leaf.active.my) leaf.myTeam = [leaf.active.my];
      if (!leaf.oppTeam.length && leaf.active.opp) leaf.oppTeam = [leaf.active.opp];
      return leaf;
    }

    /* ------------------------------------------------------------- the loop */

    /** evaluateTurn(battleState, opts) -> RankedAction[] */
    evaluateTurn(battleState, opts) {
      opts = opts || {};
      const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const state = battleState;
      if (!state || state.formatSupported === false) {
        this.lastReadout = { worlds: [], tempo: null, ranked: [], elapsedMs: 0, skipped: true };
        return [];
      }
      const myActions = this.getMyActions(state);
      if (!myActions.length) {
        this.lastReadout = { worlds: [], tempo: null, ranked: [], elapsedMs: 0, skipped: true };
        return [];
      }

      if (this.damage && typeof this.damage.beginTurn === 'function') {
        this.damage.beginTurn(state.turn + ':' + (state.revision || 0));
      }
      if (this.trickRoom && typeof this.trickRoom.tick === 'function') this.trickRoom.tick(state);
      const tempoVector = this.tempo ? this.tempo.computeVector(state) : null;
      if (this.trickRoom && tempoVector) tempoVector.trAdvice = this.trickRoom.advise(state);

      const worlds = this.sampler
        ? this.sampler.sampleWorlds(state, ST.SetDatabase || null, opts.K || this.K)
        : [{ id: 'w0', team: state.oppTeam || [], sets: [], weight: 1, violations: [] }];

      const aggregate = {};
      for (let i = 0; i < myActions.length; i++) {
        const key = this._actionKey(myActions[i]);
        aggregate[key] = { action: myActions[i], scores: [], avg: 0, min: Infinity, worldScores: [] };
      }

      for (let w = 0; w < worlds.length; w++) {
        const world = worlds[w];
        const oppActions = this.getOppActions(world, state);
        for (let i = 0; i < myActions.length; i++) {
          const mine = myActions[i];
          const key = this._actionKey(mine);
          let sum = 0, min = Infinity;
          for (let j = 0; j < oppActions.length; j++) {
            const payoff = this._payoff(mine, oppActions[j], state, state.field || {});
            sum += payoff;
            if (payoff < min) min = payoff;
          }
          const avg = oppActions.length ? sum / oppActions.length : 0;
          if (min === Infinity) min = avg;
          const blended = this.worldBlend.avg * avg + this.worldBlend.min * min;
          const bucket = aggregate[key];
          bucket.scores.push(blended);
          bucket.avg += blended;
          if (blended < bucket.min) bucket.min = blended;
          bucket.worldScores.push(blended);
        }
      }

      const scored = [];
      Object.keys(aggregate).forEach(function (key) {
        const bucket = aggregate[key];
        if (!bucket.scores.length) return;
        const avgScore = bucket.avg / bucket.scores.length;
        scored.push({
          name: bucket.action.name,
          kind: bucket.action.kind,
          moveId: bucket.action.moveId,
          targetId: bucket.action.targetId,
          score: avgScore,
          minScore: bucket.min,
          isVetoed: false,
          vetoReason: null,
          isOptimal: false
        });
      });

      // Tempo policy mask (Protect/Bunker rhythm) before vetoes, per the brief.
      const masked = this.tempo ? this.tempo.applyPolicyMask(scored, tempoVector, state) : scored;

      const ranked = masked.map(function (row) {
        const copy = Object.assign({}, row);
        if (this.veto) {
          const verdict = this.veto.evaluateVetoes({ kind: copy.kind, name: copy.name, moveId: copy.moveId, targetId: copy.targetId }, state, tempoVector);
          if (verdict && verdict.isVetoed) {
            copy.isVetoed = true;
            copy.vetoReason = verdict.reason;
            copy.vetoCode = verdict.code;
            copy.score = this.vetoScore;
          }
        }
        return copy;
      }, this);

      const live = ranked.filter(function (r) { return !r.isVetoed; });
      const T = typeof opts.temperature === 'number' ? opts.temperature : this.temperature;
      let denom = 0;
      for (let i = 0; i < live.length; i++) {
        live[i]._exp = Math.exp(live[i].score / T);
        denom += live[i]._exp;
      }
      for (let i = 0; i < ranked.length; i++) {
        const row = ranked[i];
        if (row.isVetoed) { row.confidence = 0; continue; }
        row.confidence = denom > 0 ? 100 * (row._exp / denom) : (100 / Math.max(1, ranked.length));
        delete row._exp;
      }

      ranked.sort(function (a, b) {
        if (a.isVetoed !== b.isVetoed) return a.isVetoed ? 1 : -1;
        return b.confidence - a.confidence;
      });
      if (ranked.length && !ranked[0].isVetoed) {
        ranked[0].isOptimal = true;
        ranked[0].damageHint = this._damageHint(ranked[0], state);
      }

      const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
      this.lastReadout = {
        worlds: worlds,
        tempo: tempoVector,
        ranked: ranked,
        myActions: myActions,
        elapsedMs: U.round1(elapsed),
        optimal: ranked.length && !ranked[0].isVetoed ? ranked[0] : null,
        tooltip: this.describeTopLines(ranked, 2)
      };
      return ranked;
    }

    _actionKey(action) {
      return (action.kind || 'move') + ':' + U.toID(action.moveId || action.targetId || action.name || '');
    }

    _damageHint(action, state) {
      const my = state.active && state.active.my;
      const opp = state.active && state.active.opp;
      if (!action || action.kind !== 'move' || !my || !opp || !this.damage) return null;
      const res = this._damageOf(my, opp, action.name, state.field || {}, true);
      if (!res) return null;
      return U.round1(res.minPercent) + '-' + U.round1(res.maxPercent) + '% on ' + (opp.species || opp.id) +
        (res.isOHKO ? ' (OHKO)' : res.is2HKO ? ' (2HKO)' : '');
    }

    /** Compact two-line summary for the HUD banner / LLM prompt. */
    describeTopLines(ranked, count) {
      const out = [];
      for (let i = 0; i < ranked.length && out.length < (count || 2); i++) {
        const row = ranked[i];
        if (row.isVetoed) continue;
        out.push(row.name + ' (' + Math.round(row.confidence) + '%)' + (row.damageHint ? ' ' + row.damageHint : ''));
      }
      return out;
    }
  }

  LaplaceEngine.VETO_SCORE = VETO_SCORE;

  ST.LaplaceEngine = LaplaceEngine;
})();
