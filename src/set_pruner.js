/* Showdown Tactician — src/set_pruner.js
 * Deterministic negative-deduction engine that prunes the Smogon candidate-set pool of an
 * opponent Pokémon down to the sets still consistent with everything actually observed.
 *
 * Ownership (per ARCHITECTURE.md §1.1): this module may only write the item-knowledge block
 * (originalArchetypeItem, confirmedItem, currentBattleItem, itemConsumed, itemKnockedOff,
 * itemIsIrremovable, itemless, cannotBeChoice, cannotBeBoosterEnergy, megaEvolved,
 * usedZMove, boosterConsumed, boosterActive), speedFloor/speedCeiling/speedEvidence,
 * candidateSets/prunedReasons/liveSet, plus state.formatLocks.
 *
 * Nothing here ever throws: a battle log will always contain something we did not model.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;

  // Heuristics come from src/config.js (Rule 4); the literals below are only the standalone
  // fallback used when config.js was not loaded.
  const cfg = ST.configGet || function (path, fallback) { return fallback; };
  const MAX_REASONS = cfg('pruner.maxReasons', 24);
  const MAX_EVIDENCE = cfg('pruner.maxEvidence', 12);
  const SPEED_MAX_CEILING = cfg('pruner.speedMaxCeiling', 1012); // Regieleki @ Choice Scarf, L100, +Spe, 252 EV

  const CHOICE_REASON = 'Choice lock: 2+ distinct moves in one stint => no Choice item';
  const MEGA_LOCK_REASON = 'Format lock: opponent already Mega Evolved => no Mega Stone';
  const Z_LOCK_REASON = 'Format lock: opponent already used its Z-Move => no Z-Crystal';
  const BOOSTER_REASON = 'Booster Energy already consumed / never activated => itemless';
  const KNOCKOFF_REASON = 'Knock Off dealt damage with no -enditem => item is irremovable or absent';
  const FALLBACK_REASON = 'All candidates eliminated; falling back to the raw usage pool';

  class ArchetypePruner {
    constructor(opts) {
      opts = opts || {};
      this.opts = opts;
      this.maxReasons = opts.maxReasons || MAX_REASONS;
      // mon.id -> pristine SetCandidate[] (deep-cloned once so prune() is idempotent)
      this._pristine = Object.create(null);
    }

    /* ------------------------------------------------------------ internals */

    _reasons(mon) {
      if (!Array.isArray(mon.prunedReasons)) mon.prunedReasons = [];
      return mon.prunedReasons;
    }

    _addReason(mon, text) {
      if (!mon || !text) return;
      const list = this._reasons(mon);
      if (list.indexOf(text) !== -1) return;
      list.push(text);
      while (list.length > this.maxReasons) list.shift();
    }

    _addEvidence(mon, text) {
      if (!mon || !text) return;
      if (!Array.isArray(mon.speedEvidence)) mon.speedEvidence = [];
      if (mon.speedEvidence.indexOf(text) !== -1) return;
      mon.speedEvidence.push(text);
      while (mon.speedEvidence.length > MAX_EVIDENCE) mon.speedEvidence.shift();
    }

    _isChoiceSet(set) {
      if (!set) return false;
      if (set.item && U.isChoiceItem(set.item)) return true;
      const tags = set.tags || [];
      return tags.indexOf('choice') !== -1 || tags.indexOf('band') !== -1 ||
        tags.indexOf('specs') !== -1 || tags.indexOf('scarf') !== -1;
    }

    _isMegaSet(set) {
      if (!set) return false;
      if (set.isMega) return true;
      if (set.item && U.isMegaStone(set.item)) return true;
      const tags = set.tags || [];
      return tags.indexOf('mega') !== -1;
    }

    _isZSet(set) {
      if (!set) return false;
      if (set.isZCrystal) return true;
      if (set.item && U.isZCrystal(set.item)) return true;
      const tags = set.tags || [];
      return tags.indexOf('z') !== -1 || tags.indexOf('zcrystal') !== -1;
    }

    _isItemlessSet(set) {
      if (!set) return false;
      if (set.itemlessArchetype || set.role === 'itemless') return true;
      return !set.item;
    }

    _isBoosterSet(set) {
      return !!(set && set.item && U.isBoosterEnergy(set.item));
    }

    _itemMatches(set, wanted) {
      const a = U.toID(set && set.item);
      const b = U.toID(wanted);
      return a === b;
    }

    /** The pool we filter from: caller-seeded sets win, otherwise the shared database. */
    _seedPool(mon) {
      if (!mon) return [];
      const id = mon.id || U.toID(mon.species);
      if (this._pristine[id] && this._pristine[id].length) return this._pristine[id];
      let source = null;
      if (Array.isArray(mon.candidateSets) && mon.candidateSets.length) {
        source = mon.candidateSets;
      } else if (ST.SetDatabase && typeof ST.SetDatabase.forSpecies === 'function') {
        try { source = ST.SetDatabase.forSpecies(mon.species); } catch (e) { source = null; }
        if ((!source || !source.length) && mon.revealedAbility) {
          try {
            const alt = ST.SetDatabase.forSpecies(mon.species + '-Mega');
            if (alt && alt.length) source = alt;
          } catch (e2) { /* ignore */ }
        }
      }
      if (!source || !source.length) {
        source = (ST.SetDatabase && ST.SetDatabase.DEFAULT) ? ST.SetDatabase.DEFAULT : [];
      }
      const pool = [];
      for (let i = 0; i < source.length; i++) {
        const copy = U.deepClone(source[i]);
        if (copy && copy.species && !copy.id) copy.id = U.toID(copy.species) + '-' + i;
        pool.push(copy);
      }
      this._pristine[id] = pool;
      return pool;
    }

    /** Distinct moves the opponent actually clicked during the current stint. */
    distinctStintMoves(mon) {
      const out = [];
      const seen = Object.create(null);
      const raw = Array.isArray(mon && mon.activeStintMoves) ? mon.activeStintMoves : [];
      for (let i = 0; i < raw.length; i++) {
        const id = U.toID(raw[i]);
        if (!id || seen[id]) continue;
        if (id === 'struggle') continue;
        seen[id] = true;
        out.push(id);
      }
      return out;
    }

    /** True when the mon is a known or plausible Acrobatics / Unburden archetype. */
    usesAcrobaticsOrUnburden(mon) {
      if (!mon) return false;
      const revealed = mon.revealedMoves || [];
      for (let i = 0; i < revealed.length; i++) {
        const id = U.toID(revealed[i]);
        if (id === 'acrobatics' || id === 'unburden') return true;
      }
      const abilities = (mon.possibleAbilities && mon.possibleAbilities.length)
        ? mon.possibleAbilities : U.getAbilities(mon.species);
      for (let j = 0; j < abilities.length; j++) {
        if (U.toID(abilities[j]) === 'unburden') return true;
      }
      const pool = (mon.candidateSets && mon.candidateSets.length) ? mon.candidateSets : this._seedPool(mon);
      for (let k = 0; k < pool.length; k++) {
        if (this._isItemlessSet(pool[k]) && pool[k].tags && pool[k].tags.indexOf('acrobatics') !== -1) return true;
      }
      return false;
    }

    /* ------------------------------------------------------------ rules */

    /**
     * Choice-Lock Pruning: 2+ distinct moves in the same stint without switching out and
     * not Encored permanently blacklists every Choice item.
     */
    applyChoiceLockRule(mon, state) {
      if (!mon) return { pruned: false, reason: null, distinct: 0, dropped: 0, skipped: 'no-mon' };
      const distinct = this.distinctStintMoves(mon).length;
      if (mon.isEncored) {
        return { pruned: false, reason: null, distinct: distinct, dropped: 0, skipped: 'encored' };
      }
      const stintCount = Math.max(distinct, mon.activeStintCount | 0);
      if (stintCount >= 2 || mon.cannotBeChoice) {
        mon.cannotBeChoice = true;
        this._addReason(mon, CHOICE_REASON);
        return { pruned: true, reason: CHOICE_REASON, distinct: stintCount, dropped: this._dropChoiceSets(mon) };
      }
      return { pruned: false, reason: null, distinct: stintCount, dropped: 0 };
    }

    /**
     * Drops every Choice-item set from the live pool and from the captured pristine pool, so
     * the deduction survives later re-prunes instead of being re-derived each time.
     */
    _dropChoiceSets(mon) {
      let dropped = 0;
      if (Array.isArray(mon.candidateSets)) {
        for (let i = mon.candidateSets.length - 1; i >= 0; i--) {
          if (this._isChoiceSet(mon.candidateSets[i])) { mon.candidateSets.splice(i, 1); dropped++; }
        }
      }
      const pool = this._poolFor(mon);
      for (let i = pool.length - 1; i >= 0; i--) {
        if (this._isChoiceSet(pool[i])) pool.splice(i, 1);
      }
      if (mon.liveSet && this._isChoiceSet(mon.liveSet)) mon.liveSet = this.bestSet(mon);
      return dropped;
    }

    /**
     * Itemless (Acrobatics) vs. Irremovable (Mega Stone / Z-Crystal) disambiguation, driven
     * by a Knock Off that dealt damage without producing an |-enditem| token.
     */
    classifyItemless(mon, state) {
      if (!mon) return 'unknown';
      const locks = (state && state.formatLocks) || {};

      // A consumed or removed item (Sash / Berry / Booster / Balloon / Knock Off) is simply
      // gone — the mon held something, so it is not itemless.
      if (mon.itemConsumed || mon.boosterConsumed || mon.itemRemoved) return 'itemless-consumed';

      // The "Knock Off dealt damage with no -enditem" trigger: `knockOffSurvived` is the flag
      // BattleStateManager records for it, `itemKnockedOff` is the same observation when it is
      // supplied directly (and is how the caller-level contract is phrased).
      const itemWasIrremovable = !!(mon.itemless || mon.itemKnockedOff || mon.knockOffSurvived);
      if (!itemWasIrremovable) return 'unknown';

      // Everything that could have been removed has been ruled out already.
      if (locks.oppHasMegaEvolved && locks.oppHasUsedZMove) return 'itemless-acrobatics';

      const canMega = U.canMegaEvolve(mon.species);
      if (!canMega) {
        // Mega Stone eliminated by species; strictly [Z-Crystal OR itemless Acrobatics].
        return 'z-or-itemless';
      }
      if (canMega && !locks.oppHasMegaEvolved) {
        // Only a Mega Stone survives Knock Off among the plausible items.
        return 'irremovable-mega';
      }
      return 'unknown';
    }

    /** Applies the ladder result to the pool (also records the human-readable reasons). */
    _applyItemlessClassification(mon, state) {
      const verdict = this.classifyItemless(mon, state);
      mon._itemlessVerdict = verdict;
      if (verdict === 'unknown') return { verdict: verdict, dropped: 0 };
      if (verdict === 'itemless-consumed') {
        if (!mon.itemConsumed && !mon.itemRemoved) mon.itemConsumed = true;
        this._addReason(mon, 'Item consumed / knocked off => holds nothing now');
        if (!mon.confirmedItem) mon.currentBattleItem = null;
      } else if (verdict === 'itemless-acrobatics') {
        mon.itemless = true;
        mon.cannotBeBoosterEnergy = true;
        this._addReason(mon, KNOCKOFF_REASON + ' => 100% itemless (Acrobatics / Unburden)');
      } else if (verdict === 'z-or-itemless') {
        mon.itemIsIrremovable = false;
        this._addReason(mon, KNOCKOFF_REASON + ' => [Z-Crystal or itemless Acrobatics] only');
      } else if (verdict === 'irremovable-mega') {
        mon.itemIsIrremovable = true;
        this._addReason(mon, KNOCKOFF_REASON + ' => confirmed irremovable Mega Stone');
      }
      return { verdict: verdict, dropped: 0 };
    }

    /**
     * Format Lockout Cascade: once the opponent has Mega Evolved, every Mega Stone has to
     * leave the candidate pools of the remaining Pokémon (same for the single Z-Move).
     */
    applyFormatLockCascade(state) {
      if (!state || !state.formatLocks) return { megaDropped: 0, zDropped: 0 };
      const locks = state.formatLocks;
      const teams = [state.oppTeam, state.bench && state.bench.opp];
      let megaDropped = 0;
      let zDropped = 0;
      const seen = [];

      for (let t = 0; t < teams.length; t++) {
        const team = teams[t];
        if (!team || !team.length) continue;
        for (let i = 0; i < team.length; i++) {
          const mon = team[i];
          if (!mon || seen.indexOf(mon) !== -1) continue;
          seen.push(mon);

          const megaLocked = locks.oppHasMegaEvolved && !mon.megaEvolved;
          const zLocked = locks.oppHasUsedZMove && !mon.usedZMove;
          const cannotMega = !U.canMegaEvolve(mon.species);

          if (megaLocked || cannotMega) {
            const reason = megaLocked ? MEGA_LOCK_REASON : ('Species cannot Mega Evolve (' + mon.species + ') => no Mega Stone');
            const pool = this._poolFor(mon);
            for (let k = pool.length - 1; k >= 0; k--) {
              if (this._isMegaSet(pool[k])) { pool.splice(k, 1); }
            }
            let liveDropped = 0;
            if (Array.isArray(mon.candidateSets)) {
              for (let k = mon.candidateSets.length - 1; k >= 0; k--) {
                if (this._isMegaSet(mon.candidateSets[k])) { mon.candidateSets.splice(k, 1); liveDropped++; }
              }
            }
            if (liveDropped || megaLocked) this._addReason(mon, reason);
            megaDropped += liveDropped;
          }
          if (zLocked) {
            for (let k = 0; k < 2; k++) {
              const pool = k === 0 ? this._poolFor(mon) : mon.candidateSets;
              if (!Array.isArray(pool)) continue;
              for (let j = pool.length - 1; j >= 0; j--) {
                if (this._isZSet(pool[j])) { pool.splice(j, 1); zDropped++; }
              }
            }
            this._addReason(mon, Z_LOCK_REASON);
          }
          if (mon.boosterConsumed || mon.cannotBeBoosterEnergy) {
            const pool = this._poolFor(mon);
            for (let k = pool.length - 1; k >= 0; k--) {
              if (this._isBoosterSet(pool[k])) pool.splice(k, 1);
            }
            if (Array.isArray(mon.candidateSets)) {
              for (let k = mon.candidateSets.length - 1; k >= 0; k--) {
                if (this._isBoosterSet(mon.candidateSets[k])) mon.candidateSets.splice(k, 1);
              }
            }
            this._addReason(mon, BOOSTER_REASON);
          }
        }
      }

      // Refresh aggregate format locks from whatever survived.
      let megasRemaining = 0;
      let anyMegaStone = false;
      const oppTeam = state.oppTeam || [];
      for (let i = 0; i < oppTeam.length; i++) {
        const mon = oppTeam[i];
        if (!mon || mon.fainted) continue;
        const pool = (mon.candidateSets && mon.candidateSets.length) ? mon.candidateSets : this._poolFor(mon);
        let hasMega = false;
        for (let k = 0; k < pool.length; k++) {
          if (this._isMegaSet(pool[k])) { hasMega = true; break; }
        }
        if (hasMega) { megasRemaining++; anyMegaStone = true; }
      }
      locks.oppMegasRemaining = megasRemaining;
      locks.oppHasMegaStone = anyMegaStone;
      return { megaDropped: megaDropped, zDropped: zDropped, megasRemaining: megasRemaining };
    }

    _poolFor(mon) {
      const id = mon && (mon.id || U.toID(mon.species));
      if (!id) return [];
      if (!this._pristine[id] || !this._pristine[id].length) this._seedPool(mon);
      return this._pristine[id] || [];
    }

    /**
     * Dynamic Speed Bracket Pruning: drop every set whose ceiling Speed cannot reach the
     * established floor. Also tightens mon.speedCeiling when survivors collapse.
     */
    applySpeedFloor(mon, state) {
      if (!mon) return { pruned: false, dropped: 0, floor: 0, survivors: [] };
      const floor = Math.max(mon.speedFloor | 0, 0);
      if (!floor) return { pruned: false, dropped: 0, floor: 0, survivors: this._poolFor(mon) };
      const pool = this._poolFor(mon);
      let dropped = 0;
      const survivors = [];
      for (let i = 0; i < pool.length; i++) {
        const set = pool[i];
        const maxSpe = U.maxSpeedForSet(set);
        set.maxSpeed = maxSpe;
        if (maxSpe < floor) {
          dropped++;
        } else {
          survivors.push(set);
        }
      }
      if (dropped) {
        const id = mon.id || U.toID(mon.species);
        this._pristine[id] = survivors;
        // Publish: the live pool must only keep sets that can actually reach the floor,
        // otherwise the sampler keeps drawing speeds the battle log already disproved.
        mon.candidateSets = survivors.slice();
        const best = this.bestSet(mon);
        if (best) mon.liveSet = best;
        this._addReason(mon, 'Speed floor ' + floor + ': eliminated ' + dropped +
          ' set' + (dropped === 1 ? '' : 's') + ' that cannot outspeed (max Speed < ' + floor + ')');
      }
      // If exactly one set survives, the true Speed is known precisely.
      if (survivors.length === 1) {
        const exact = U.maxSpeedForSet(survivors[0]);
        const prevCeiling = typeof mon.speedCeiling === 'number' ? mon.speedCeiling : SPEED_MAX_CEILING;
        if (exact < prevCeiling) {
          mon.speedCeiling = exact;
          this._addEvidence(mon, 'Single surviving set (' + survivors[0].id + ') => Speed ' + exact +
            (survivors[0].item ? ' incl. ' + survivors[0].item : ''));
        }
      }
      return { pruned: dropped > 0, dropped: dropped, floor: floor, survivors: survivors };
    }

    /** Speed-floor event handler used by BattleStateManager (see ARCHITECTURE §2). */
    handleSpeedFloorEvent(event, state) {
      if (!event || !state) return { pruned: false, dropped: 0, floor: 0, survivors: [] };
      const team = event.side === state.mySide ? state.myTeam : state.oppTeam;
      let mon = null;
      if (team && team.length) {
        for (let i = 0; i < team.length; i++) {
          if (team[i] && team[i].slot === event.slot) { mon = team[i]; break; }
        }
        if (!mon && event.species) {
          const id = U.toID(event.species);
          for (let i = 0; i < team.length; i++) {
            if (team[i] && team[i].id === id) { mon = team[i]; break; }
          }
        }
      }
      if (!mon) return { pruned: false, dropped: 0, floor: 0, survivors: [] };
      const value = Math.max(1, Math.round(event.value || 0));
      if (value > (mon.speedFloor | 0)) {
        mon.speedFloor = value;
        this._addEvidence(mon, 'Speed floor ' + value + '+ (' + (event.reason || 'moved first') + ')');
      }
      const res = this.applySpeedFloor(mon, state);
      res.mon = mon;
      return res;
    }

    /* ------------------------------------------------------------ main entry */

    /**
     * Runs every deduction against the pristine pool and publishes the survivors.
     * Idempotent: the pristine pool is captured once, so repeated calls converge.
     */
    prune(mon, state) {
      if (!mon) return [];
      const pristine = this._seedPool(mon);
      if (!pristine.length) {
        mon.candidateSets = [];
        mon.liveSet = null;
        return [];
      }
      state = state || { formatLocks: {}, field: {} };
      const locks = state.formatLocks || {};

      // 1. Rule evaluation first — it decides the item filters below.
      const choice = this.applyChoiceLockRule(mon, state);
      const itemless = this._applyItemlessClassification(mon, state);
      const canMega = U.canMegaEvolve(mon.species);
      const megaLocked = !!locks.oppHasMegaEvolved && !mon.megaEvolved;
      const zLocked = !!locks.oppHasUsedZMove && !mon.usedZMove;
      const heldItem = mon.confirmedItem || mon.currentBattleItem || null;
      const floor = Math.max(mon.speedFloor | 0, 0);

      const survivors = [];
      for (let i = 0; i < pristine.length; i++) {
        const set = pristine[i];
        let drop = null;

        if (choice && choice.pruned && this._isChoiceSet(set)) {
          drop = CHOICE_REASON;
        } else if ((megaLocked || !canMega) && this._isMegaSet(set)) {
          drop = megaLocked ? MEGA_LOCK_REASON : ('Species cannot Mega Evolve => no Mega Stone');
        } else if (zLocked && this._isZSet(set)) {
          drop = Z_LOCK_REASON;
        } else if ((mon.boosterConsumed || mon.cannotBeBoosterEnergy) && this._isBoosterSet(set)) {
          drop = BOOSTER_REASON;
        }

        // Itemless ladder
        if (!drop && itemless.verdict === 'itemless-acrobatics' && !this._isItemlessSet(set)) {
          drop = 'Proven itemless => Acrobatics / Unburden sets only';
        } else if (!drop && itemless.verdict === 'itemless-consumed' && this._isItemlessSet(set)) {
          drop = 'Item was consumed => the set must have held one';
        } else if (!drop && itemless.verdict === 'z-or-itemless' && !(this._isItemlessSet(set) || this._isZSet(set))) {
          drop = 'Knock Off removal => [Z-Crystal or itemless] only';
        } else if (!drop && itemless.verdict === 'irremovable-mega' && !this._isMegaSet(set)) {
          drop = 'Confirmed irremovable Mega Stone => Mega sets only';
        }

        // A proven held item wins over every archetype guess (Trick keeps this honest:
        // currentBattleItem follows the swap, so the pool follows the monster's item).
        if (!drop && mon.confirmedItem && !this._itemMatches(set, heldItem)) {
          drop = 'Confirmed item: ' + heldItem;
        }

        // An item we have objectively disproved (hazard damage rules out Boots, a Knock Off
        // that removed something rules that item out) must not survive in the pool.
        if (!drop && set.item && Array.isArray(mon.itemRuledOut) && mon.itemRuledOut.length) {
          for (let r = 0; r < mon.itemRuledOut.length; r++) {
            if (this._itemMatches(set, mon.itemRuledOut[r])) {
              drop = 'Item ruled out: ' + mon.itemRuledOut[r];
              break;
            }
          }
        }

        // Move consistency: a 4-move set that cannot contain a revealed move is wrong.
        if (!drop) {
          const revealed = mon.revealedMoves || [];
          const setMoves = (set.moves || []).map(U.toID);
          if (setMoves.length >= 4) {
            for (let r = 0; r < revealed.length; r++) {
              const rid = U.toID(revealed[r]);
              if (!rid || U.getMoveData(revealed[r]) === null) continue;
              const mv = U.getMoveData(revealed[r]);
              if (mv && mv.isZMove) continue;
              if (mv && mv.isMaxMove) continue;
              if (setMoves.indexOf(rid) === -1) {
                drop = 'Revealed move ' + revealed[r] + ' is not in this set';
                break;
              }
            }
          }
        }

        // Ability consistency.
        if (!drop && mon.revealedAbility) {
          const setAbility = U.toID(set.ability);
          const revealedAbility = U.toID(mon.revealedAbility);
          if (setAbility && revealedAbility && setAbility !== revealedAbility) {
            const possible = (mon.possibleAbilities && mon.possibleAbilities.length)
              ? mon.possibleAbilities : U.getAbilities(mon.species);
            let isPossible = false;
            for (let p = 0; p < possible.length; p++) {
              if (U.toID(possible[p]) === setAbility) { isPossible = true; break; }
            }
            if (!isPossible) {
              drop = 'Revealed ability ' + mon.revealedAbility + ' != set ability ' + set.ability;
            }
          }
        }

        // Speed bracket.
        if (!drop && floor) {
          const maxSpe = U.maxSpeedForSet(set);
          set.maxSpeed = maxSpe;
          if (maxSpe < floor) {
            drop = 'Speed floor ' + floor + ': set maxes at ' + maxSpe;
          }
        }

        if (drop) {
          this._addReason(mon, drop);
        } else {
          survivors.push(set);
        }
      }

      // Never leave the engine with an empty candidate space. The fallback is a degraded
      // pool, not a licence to resurrect a set the battle log already disproved: every hard,
      // observation-backed fact is re-applied before the raw pool is accepted.
      let published = survivors;
      if (!published.length) {
        this._addReason(mon, FALLBACK_REASON);
        const hard = pristine.filter(function (set) {
          if (mon.cannotBeChoice && this._isChoiceSet(set)) return false;
          if ((mon.boosterConsumed || mon.cannotBeBoosterEnergy) && this._isBoosterSet(set)) return false;
          return true;
        }, this);
        // "Proven itemless" is only enforced when the pool actually models an itemless set;
        // a database that has none must not turn the fallback into an empty candidate space.
        let pool = hard;
        if (mon.itemless) {
          const itemlessOnly = hard.filter(function (set) { return this._isItemlessSet(set); }, this);
          if (itemlessOnly.length) pool = itemlessOnly;
        }
        published = pool.length ? pool : pristine.slice();
      }

      mon.candidateSets = published;
      mon.liveSet = this.bestSet(mon);
      if (mon.liveSet) {
        if (!mon.originalArchetypeItem) mon.originalArchetypeItem = mon.liveSet.item || null;
        if (!mon.confirmedItem && !mon.currentBattleItem && published.length === 1) {
          mon.originalArchetypeItem = published[0].item || null;
          this._addReason(mon, 'Single surviving set: ' + published[0].id + ' (' + (published[0].role || 'set') + ')');
        }
      }
      return published;
    }

    /** Highest-weight surviving set (ties broken by id for determinism). */
    bestSet(mon) {
      if (!mon) return null;
      const pool = (mon.candidateSets && mon.candidateSets.length) ? mon.candidateSets : null;
      if (!pool) return null;
      let best = null;
      for (let i = 0; i < pool.length; i++) {
        const set = pool[i];
        if (!set) continue;
        if (!best) { best = set; continue; }
        const a = typeof set.weight === 'number' ? set.weight : 0;
        const b = typeof best.weight === 'number' ? best.weight : 0;
        if (a > b) best = set;
        else if (a === b && String(set.id) < String(best.id)) best = set;
      }
      return best;
    }

    /** Resets the captured pristine pools (used on a new battle). */
    reset() {
      this._pristine = Object.create(null);
    }

    /** Compact one-line deduction summary for the HUD drawer. */
    static describeDeductions(mon) {
      if (!mon) return 'no data';
      const bits = [];
      if (mon.cannotBeChoice) bits.push('choice locked out');
      if (mon.itemless) bits.push('itemless');
      if (mon.itemIsIrremovable) bits.push('irremovable item');
      if (mon.confirmedItem) bits.push('item: ' + mon.confirmedItem);
      if (mon.megaEvolved) bits.push('mega evolved');
      if (mon.usedZMove) bits.push('Z used');
      if (mon.boosterConsumed) bits.push('booster gone');
      if (mon.speedFloor) bits.push('speed ' + mon.speedFloor + '+');
      if (mon.speedCeiling && mon.speedCeiling < SPEED_MAX_CEILING) bits.push('speed <= ' + mon.speedCeiling);
      const pool = mon.candidateSets || [];
      bits.push(pool.length + ' set' + (pool.length === 1 ? '' : 's') + ' left');
      if (mon.liveSet) bits.push('live: ' + mon.liveSet.id);
      const reasons = mon.prunedReasons || [];
      if (reasons.length) bits.push('| ' + reasons[reasons.length - 1]);
      return bits.join(' · ');
    }

    /** Static helpers mirrored for tests / the options page. */
    static isChoiceSet(set) { return !!(set && set.item && ST.util.isChoiceItem(set.item)); }
    static isMegaSet(set) { return !!(set && (set.isMega || (set.item && ST.util.isMegaStone(set.item)))); }
    static isItemlessSet(set) { return !!(set && !set.item); }
}

ArchetypePruner.MAX_REASONS = MAX_REASONS;
ArchetypePruner.SPEED_MAX_CEILING = SPEED_MAX_CEILING;
ArchetypePruner.REASONS = {
  CHOICE: CHOICE_REASON,
  MEGA_LOCK: MEGA_LOCK_REASON,
  Z_LOCK: Z_LOCK_REASON,
  BOOSTER: BOOSTER_REASON,
  KNOCKOFF: KNOCKOFF_REASON,
  FALLBACK: FALLBACK_REASON
};

ST.ArchetypePruner = ArchetypePruner;
})();
