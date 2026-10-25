/* Showdown Tactician — src/set_pruner.js
 * Deterministic negative-deduction engine that prunes the Smogon candidate-set pool of an
 * opponent Pokémon down to the sets still consistent with everything actually observed.
 *
 * Ownership (per ARCHITECTURE.md §1.1): this module may only write the item-knowledge block
 * (originalArchetypeItem, confirmedItem, currentBattleItem, itemConsumed, itemKnockedOff,
 * itemIsIrremovable, itemless, cannotBeChoice, cannotBeBoosterEnergy, megaEvolved,
 * usedZMove, boosterConsumed, boosterActive), speedFloor/speedCeiling/speedEvidence,
 * residualOrderBefore/residualOrderAfter, candidateSets/prunedReasons/liveSet,
 * pinnedEvs/evPinned, plus state.formatLocks.
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
  const FLOOR_KEEP = cfg('pruner.speedFloorFallbackKeep', 4);    // kept when no set reaches the floor

  // Reverse damage deduction (upgrade: live EV solving). Values come from config.js, like every
  // other heuristic here; the literals are the standalone fallback.
  const DMG_EVIDENCE_ON = cfg('pruner.damageEvidence.enabled', true);
  const DMG_SLACK_PCT = cfg('pruner.damageEvidence.slackPct', 3);
  const DMG_SLACK_REL = cfg('pruner.damageEvidence.slackRel', 0.15);
  const DMG_MIN_PCT = cfg('pruner.damageEvidence.minDamagePct', 5);
  const DMG_MAX_OBS = cfg('pruner.damageEvidence.maxObservations', 8);
  const DMG_MAX_SETS = cfg('pruner.damageEvidence.maxSetsTested', 64);

  // Team-preview synergy: the |poke| names are evidence about each body's set. Load-time switches
  // like every other pruner tunable; `_applyTeamSynergyPrior` is the only reader.
  const SYNERGY_ON = cfg('pruner.synergy.enabled', true);
  /* The two weather families, as ABILITIES THAT PAY OFF IN IT rather than setters only: a Drizzle
   * Pelipper's own set is a rain set, and so is a Swift Swim body's, but a Drought Torkoal is a
   * sun set for the same reason. Weather Ball and the accuracy/charge payoffs name the rest. */
  const RAIN_ABILITIES = new Set(['drizzle', 'swiftswim', 'raindish', 'dryskin', 'hydration']);
  const SUN_ABILITIES = new Set(['drought', 'chlorophyll', 'solarpower']);
  const RAIN_MOVES = new Set(['hurricane', 'thunder', 'weatherball']);
  const SUN_MOVES = new Set(['solarbeam', 'solarblade', 'weatherball']);
  const SYNERGY_WEATHER = cfg('pruner.synergy.weatherFactor', 1.35);
  const SYNERGY_TR = cfg('pruner.synergy.trFactor', 1.25);
  const SYNERGY_SR_DUP = cfg('pruner.synergy.srDuplicateFactor', 0.25);

  // Ability deduction (rule tables in src/util.js). The master switch plus one switch per rule
  // family, read at LOAD time like the pruner's other tunables (config_check pins every one).
  const ABILITY_DEDUCTION_ON = cfg('pruner.abilityDeduction.enabled', true);
  const AB_DEDUCTION_STATUS = cfg('pruner.abilityDeduction.statusRules', true);
  const AB_DEDUCTION_GROUND = cfg('pruner.abilityDeduction.groundRules', true);
  const AB_DEDUCTION_ABSENCE = cfg('pruner.abilityDeduction.absenceRules', false);

  // The discrete half of reverse damage (ARCHITECTURE §6.1): damage is one of 16 integer rolls,
  // so a set that cannot produce the exact integer percentage the protocol printed is out even
  // when its RANGE covers it. This is a refinement only — the caller keeps the pool when every
  // candidate fails, exactly like the range check above it.
  const DISCRETE_ON = cfg('pruner.discreteRolls.enabled', true);
  const DR_SLACK_PCT = cfg('pruner.discreteRolls.slackPct', 0.05);
  const DR_REQUIRE_OBS = cfg('pruner.discreteRolls.requireObservations', 2);

  // Residual-order speed evidence (ARCHITECTURE §6.2): end-of-turn residuals resolve in Speed
  // order, which is a RELATIVE fact. `trust` decides how far the relative order may bite once it
  // is turned into a floor/ceiling against the other body's believed speed; at 0 the order is
  // recorded as telemetry and nothing is pruned.
  const RESID_ON = cfg('pruner.residualOrder.enabled', true);
  const RESID_TRUST = cfg('pruner.residualOrder.trust', 1);

  // The optional scouting prior (ARCHITECTURE §6.3). Like the ladder overlay it only ever
  // re-weights sets the curated database already holds, on a COPY, and a species it never saw
  // keeps every curated weight untouched.
  const SCOUT_ON = cfg('pruner.scout.enabled', true);
  const SCOUT_MAX_BEND = cfg('pruner.scout.maxBend', 0.5);

  /** Stable signature of an EV vector, used to decide whether a pool has collapsed to one. */
  function evSignature(evs) {
    if (!evs) return '';
    return ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(function (k) {
      return typeof evs[k] === 'number' ? evs[k] : 0;
    }).join('/');
  }

  /** "252 HP / 4 SpD" — the shortest true description of an EV vector. */
  function evText(evs) {
    if (!evs) return '';
    const labels = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
    const out = [];
    ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].forEach(function (k) {
      const v = typeof evs[k] === 'number' ? evs[k] : 0;
      if (v) out.push(v + ' ' + labels[k]);
    });
    return out.length ? out.join(' / ') : 'no investment';
  }

  // Moves whose damage the library's stat line cannot predict from the set alone. A fixed-damage
  // move (Seismic Toss = the user's level), a weight/speed/HP-ratio move or a boost-scaling move
  // computes the same base power for every candidate spread, so the observed number would
  // "prove" whichever set happened to be modelled first. They are skipped rather than trusted.
  //
  // A STATUS move that moves HP (Pain Split) belongs here too — the library cannot predict its
  // number either — but a status move that moves no HP at all does not. `shelter` used to be listed
  // and it is the second kind: it is not a damaging move, and it was ALSO in util.PROTECT_MOVES,
  // and those two readings cannot both be true. It is now in neither list; see the note on
  // PROTECT_MOVES in src/util.js.
  const UNPREDICTABLE_DAMAGE = new Set([
    'seismictoss', 'nightshade', 'sonicboom', 'dragonrage', 'superfang', 'naturesmadness',
    'ruination', 'endeavor', 'counter', 'mirrorcoat', 'metalburst', 'comeuppance', 'finalgambit',
    'painsplit', 'psywave', 'flail', 'reversal', 'magnitude', 'present', 'trumpcard', 'spitup',
    'punishment', 'wringout', 'crushgrip', 'heavyslam', 'heatcrash', 'grassknot', 'lowkick',
    'gyroball', 'electroball', 'storedpower', 'powertrip', 'ragefist', 'return', 'frustration',
    'punishment', 'fling', 'naturalgift', 'beatup', 'dreameater', 'synchronoise', 'grasspledge',
    'waterpledge', 'firepledge', 'payback', 'avalanche', 'revenge', 'assurance', 'boltbeak',
    'fishiousrend', 'echoedvoice', 'rollout', 'iceball', 'furycutter', 'brine', 'venoshock',
    'hex', 'acrobatics', 'facade', 'brutalswing', 'lastrespects', 'rage', 'bide'
  ]);

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
      // The damage engine is optional: without it the reverse-damage rule degrades to a no-op
      // and every other deduction still runs (src/content.js passes the shared engine).
      this.damage = opts.damage || null;
      // mon.id -> pristine SetCandidate[] (deep-cloned once so prune() is idempotent)
      this._pristine = Object.create(null);
    }

    /* ------------------------------------------------------------ internals */

    /**
     * Candidate pools are keyed per Pokémon INSTANCE, not per species. Our Kingambit and the
     * opponent's are two different monsters: a deduction proven about theirs (or a Speed floor)
     * must never rewrite our candidate space, and vice versa. The key uses the team side plus
     * the mon's own index (or its slot when it has no index), and falls back to the plain
     * species id for the bare fixture objects the unit tests build, where a species is only
     * ever seen once.
     */
    poolStatus(mon) {
      if (!mon) return null;
      const pool = this._pristine[this._poolKey(mon)];
      return { seeded: pool ? pool.length : null, remaining: (mon.candidateSets || []).length };
    }

    _poolKey(mon) {
      if (!mon) return '';
      const base = mon.id || U.toID(mon.species);
      if (!base) return '';
      const side = mon.side || '';
      const slot = (typeof mon.index === 'number') ? mon.index
        : (mon.slot === undefined || mon.slot === null ? '' : mon.slot);
      if (!side && slot === '') return base;
      return side + '|' + slot + '|' + base;
    }

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
      const key = this._poolKey(mon);
      if (!key) return [];
      if (this._pristine[key] && this._pristine[key].length) return this._pristine[key];
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
        /* SPECIES-SPECIFIC GENERIC TEMPLATES before the shared DEFAULT pool.
         *
         * DEFAULT is built from Great Tusk (`sets_db.js`), and it is stamped with that
         * Pokemon's ability. Cloning it for a species the curated database does not cover
         * therefore handed every such body Protosynthesis as its ability and a physical
         * 252 Atk / 252 Spe spread, whatever it actually is. In a real battle that produced
         * `Serperior … bulky @ Heavy-Duty Boots [ATK 252 / SPE 252]` in the HUD and a
         * `guaranteed OHKO` on a Fire Punch that left Serperior at 2% — the number was not a
         * roll, it was a mislabelled body. `genericFor` derives the ability from the species
         * itself and splits physical/special from its base stats, so the fallback describes
         * the monster in front of us even when the curated list does not.
         */
        if (mon.species && ST.SetDatabase && typeof ST.SetDatabase.genericFor === 'function') {
          try { source = ST.SetDatabase.genericFor(mon.species); } catch (e) { source = null; }
        }
        if (!source || !source.length) {
          source = (ST.SetDatabase && ST.SetDatabase.DEFAULT) ? ST.SetDatabase.DEFAULT : [];
        }
      }
      const pool = [];
      for (let i = 0; i < source.length; i++) {
        const copy = U.deepClone(source[i]);
        if (copy && copy.species && !copy.id) copy.id = U.toID(copy.species) + '-' + i;
        pool.push(copy);
      }
      // The scouting prior is applied HERE, to the clones and never to the database object, and
      // before the pool is captured as pristine, so every later deduction narrows an already
      // opponent-shaped pool. It re-weights; it cannot add or remove a set.
      this._applyScoutPrior(mon, pool);
      this._pristine[key] = pool;
      return pool;
    }

    /* -------------------------------------------------------- scouting prior */

    /** The generated overlay's entry for this mon (src/scout_prior.js), or null. */
    _scoutEntry(mon) {
      if (!SCOUT_ON || !mon) return null;
      let table = null;
      try {
        if (typeof window !== 'undefined' && window && window.ST_SCOUT) table = window.ST_SCOUT;
        else if (ST.SCOUT) table = ST.SCOUT;
      } catch (e) { table = null; }
      if (!table || !table.species) return null;
      const id = U.toID(mon.species || mon.id);
      return (id && table.species[id]) || null;
    }

    /**
     * Re-weight a freshly seeded pool by what the opponent's own replays revealed. Dimensions the
     * overlay never observed are skipped entirely, so a corpus that only ever showed items does
     * not silently vote against every set's moves. Returns the number of sets it moved.
     */
    _applyScoutPrior(mon, pool) {
      const entry = this._scoutEntry(mon);
      if (!entry || !pool || !pool.length) return 0;
      const observed = {
        items: entry.items && Object.keys(entry.items).length ? entry.items : null,
        abilities: entry.abilities && Object.keys(entry.abilities).length ? entry.abilities : null,
        moves: entry.moves && Object.keys(entry.moves).length ? entry.moves : null
      };
      if (!observed.items && !observed.abilities && !observed.moves) return 0;
      let moved = 0;
      for (let i = 0; i < pool.length; i++) {
        const set = pool[i];
        if (!set) continue;
        const shares = [];
        if (observed.items) {
          const itemId = U.toID(set.item);
          shares.push(itemId && observed.items[itemId] !== undefined ? observed.items[itemId] : 0);
        }
        if (observed.abilities) {
          const abilityId = U.toID(set.ability);
          shares.push(abilityId && observed.abilities[abilityId] !== undefined ? observed.abilities[abilityId] : 0);
        }
        if (observed.moves && Array.isArray(set.moves) && set.moves.length) {
          let sum = 0;
          for (let m = 0; m < set.moves.length; m++) {
            const mid = U.toID(set.moves[m]);
            sum += (mid && observed.moves[mid] !== undefined) ? observed.moves[mid] : 0;
          }
          shares.push(sum / set.moves.length);
        }
        if (!shares.length) continue;
        let total = 0;
        for (let s = 0; s < shares.length; s++) total += shares[s];
        const score = U.clamp(total / shares.length / 100, 0, 1);
        const factor = U.clamp(1 + SCOUT_MAX_BEND * (2 * score - 1),
          1 - SCOUT_MAX_BEND, 1 + SCOUT_MAX_BEND);
        const before = typeof set.weight === 'number' ? set.weight : 0;
        set.weight = before * factor;
        set.scoutFactor = factor;
        if (Math.abs(factor - 1) > 0.001) moved++;
      }
      if (moved) {
        this._addReason(mon, 'Scouting prior: re-weighted ' + moved + ' of ' + pool.length +
          ' candidate sets from ' + (entry.seen || 0) + ' observed appearance' +
          ((entry.seen || 0) === 1 ? '' : 's') + ' (up to ' + Math.round(SCOUT_MAX_BEND * 100) + '% either way)');
      }
      return moved;
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

      // The "Knock Off dealt damage with no -enditem" trigger. `itemKnockedOff` is the ONE flag
      // for it — BattleStateManager._resolveKnockOffs writes it, and callers of this method may
      // supply it directly. It is deliberately withheld for a body that can carry Sticky Hold,
      // because the ability produces the identical observation on a set whose item is ordinary.
      const itemWasIrremovable = !!(mon.itemless || mon.itemKnockedOff);
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
      const key = this._poolKey(mon);
      if (!key) return [];
      if (!this._pristine[key] || !this._pristine[key].length) this._seedPool(mon);
      return this._pristine[key] || [];
    }

    /**
     * speedFloorUnsound(mon, state) -> boolean
     *
     * Is the observed SPEED ORDER safe to convert into a floor?
     *
     * `U.maxSpeedForSet` is a SET-STATIC ceiling: it knows the set's item and ability but not the
     * weather, the terrain, Tailwind or a Speed stage — all of which the protocol PRINTS and the
     * engine already holds. A Swift Swim body in rain, a Chlorophyll body in sun, a Surge Surfer
     * body on Electric Terrain, a body behind Tailwind, or one that was simply at +1 Speed moves
     * first through a ceiling this rule computes as too low — so every one of that body's REAL sets
     * is eliminated although the order is perfectly consistent with them. And because the floor is
     * also read as a Speed bound by the world sampler, the endgame solver and the Trick Room queue,
     * an unsound floor is not a local error.
     *
     * The conversion therefore REFUSES rather than guesses. A refused floor costs one observation;
     * an unsound one corrupts the pool for the rest of the battle. On a clean board — no weather,
     * no terrain, no Tailwind and no Speed stages — nothing here fires and the rule works as before.
     *
     * NOT modelled, so it stays a documented residual: Protosynthesis / Quark Drive can raise Speed
     * by 1.5x from SUN / Electric Terrain without Booster Energy, and `maxSpeedForSet` only applies
     * that multiplier when the set holds the item.
     */
    speedFloorUnsound(mon, state) {
      if (!mon) return true;
      const boosts = mon.boosts || null;
      if (boosts && (boosts.spe | 0) > 0) return true;
      const field = (state && state.field) || {};
      const tw = field.tailwind || {};
      // Tailwind doubles every body on its side, so it makes the ORDER uninformative about Speed.
      const onMyTeam = !!(state && Array.isArray(state.myTeam) && state.myTeam.indexOf(mon) !== -1);
      const side = onMyTeam ? ((state && state.mySide) || 'p1') : ((state && state.oppSide) || 'p2');
      if (tw[side]) return true;
      const family = U.weatherFamily ? U.weatherFamily(field.weather || '') : U.toID(field.weather || '');
      const terrain = U.toID(field.terrain || '');
      if (!family && !terrain) return false;
      // The pool when it is seeded, otherwise the species' own ability list — the wider question
      // ("could this body have the ability at all") is the conservative one here.
      let pool = (mon.candidateSets && mon.candidateSets.length) ? mon.candidateSets : null;
      if (!pool && mon.possibleAbilities && mon.possibleAbilities.length) {
        pool = mon.possibleAbilities.map(function (a) { return { ability: a }; });
      }
      if (!pool) return false;
      for (let i = 0; i < pool.length; i++) {
        const id = U.toID((pool[i] && pool[i].ability) || '');
        if (!id) continue;
        if (id === 'swiftswim' && family === 'rain') return true;
        if (id === 'chlorophyll' && family === 'sun') return true;
        if (id === 'sandrush' && family === 'sandstorm') return true;
        if (id === 'slushrush' && family === 'snow') return true;
        if (id === 'surgesurfer' && terrain === 'electric') return true;
      }
      return false;
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
      // The observation is refused, not the conclusion re-weighted: see speedFloorUnsound.
      if (this.speedFloorUnsound(mon, state)) {
        return { pruned: false, dropped: 0, floor: floor, survivors: pool, unsound: true };
      }
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
        // An unsatisfiable floor (a mis-parsed observation, our own Tailwind / Scarf maths) must
        // never publish an EMPTY pool: liveSet would become null and _poolFor would hand the
        // sampler the unfiltered database, silently undoing every deduction. Keep the sets that
        // come closest to the floor instead - a bounded, documented fallback.
        let published = survivors;
        if (!published.length) {
          published = pool.slice().sort(function (a, b) {
            return (b.maxSpeed || 0) - (a.maxSpeed || 0);
          }).slice(0, Math.min(FLOOR_KEEP, pool.length));
          this._addReason(mon, 'Speed floor ' + floor + ': no candidate can reach it; keeping the ' +
            published.length + ' fastest candidate' + (published.length === 1 ? '' : 's'));
        }
        const key = this._poolKey(mon);
        if (key) this._pristine[key] = published;
        // Publish: the live pool must only keep sets that can actually reach the floor,
        // otherwise the sampler keeps drawing speeds the battle log already disproved.
        mon.candidateSets = published.slice();
        const best = this.bestSet(mon);
        if (best) mon.liveSet = best;
        if (survivors.length) {
          this._addReason(mon, 'Speed floor ' + floor + ': eliminated ' + dropped +
            ' set' + (dropped === 1 ? '' : 's') + ' that cannot outspeed (max Speed < ' + floor + ')');
        }
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

    /* ------------------------------------------------- reverse damage deduction */

    /**
     * Which candidate sets cannot have thrown an observed hit?
     *
     * We know OUR body exactly (the paste carries its EVs, IVs and nature) and we know how many
     * percent of it just disappeared, so every candidate spread of the attacker can be run
     * through the calculator and checked: a set whose maximum roll is still below what we took is
     * not the set we are facing, and neither is one whose minimum roll exceeds it.
     *
     * Three things keep this honest, because it is the most speculative deduction in the file:
     *   - a generous tolerance band (`slackPct` absolute + `slackRel` relative) absorbs Showdown's
     *     integer HP rounding, a roll we did not see the extremes of, and any small factor we did
     *     not model;
     *   - a critical hit is flagged at the source and never used, and moves whose damage is not a
     *     function of the set (fixed damage, weight/speed/HP ratio) are skipped outright;
     *   - if one observation would eliminate EVERY candidate, the observation is discarded instead
     *     of the database: an unmodelled Z-move or a mid-turn ability is far more likely than the
     *     set database being wrong. All of this is recorded on the mon, so the HUD can show why.
     *
     * Verdicts are memoised per observation signature: the pools are re-derived on every single
     * protocol event, and re-running 40 damage calculations each time is not affordable.
     */
    damageVerdicts(mon, state, pristine) {
      if (!mon) return Object.create(null);
      const obs = Array.isArray(mon.damageDealt) ? mon.damageDealt : [];
      const sig = obs.map(function (o) { return (o && o.sig) || ''; }).join(';');
      if (!obs.length || !DMG_EVIDENCE_ON || !this.damage || typeof this.damage.calculateDamage !== 'function') {
        return Object.create(null);
      }
      if (!mon.damageVerdictCache || typeof mon.damageVerdictCache !== 'object') {
        mon.damageVerdictCache = { sig: null, verdicts: Object.create(null) };
      }
      const cache = mon.damageVerdictCache;
      if (cache.sig === sig) return cache.verdicts;
      const pool = Array.isArray(pristine) && pristine.length ? pristine : this._poolFor(mon);
      const committed = Object.create(null);
      for (let o = 0; o < obs.length && o < DMG_MAX_OBS; o++) {
        const observation = obs[o];
        if (!observation || observation.crit || observation.censored || observation.multiHit) continue;
        if (observation.damagePercent < DMG_MIN_PCT) continue;          // chip, not evidence
        if (UNPREDICTABLE_DAMAGE.has(observation.moveId)) continue;
        const defender = observation.defenderSnapshot || this._myMonById(state, observation.defenderId);
        if (!defender) continue;                                        // no ruler, no measurement
        const perObservation = Object.create(null);
        let survivors = 0, tested = 0;
        for (let s = 0; s < pool.length && tested < DMG_MAX_SETS; s++) {
          const set = pool[s];
          if (!set) continue;
          tested++;
          const key = set.id || ('candidate-' + s);
          if (perObservation[key]) continue;
          const reason = this._damageVerdict(set, observation, defender, state);
          if (reason) perObservation[key] = reason;
          else survivors++;
        }
        if (!tested) continue;
        if (!survivors) {
          this._addReason(mon, 'Damage evidence ignored: ' + U.round1(observation.damagePercent) + '% from ' +
            observation.moveName + ' contradicts every candidate set');
          continue;
        }
        // Pass 2 — the discrete refinement, only over what the range test just accepted, and only
        // when it leaves something standing. It can therefore never turn one observation into an
        // all-candidates-eliminated event, which would throw the range verdict away with it.
        if (DISCRETE_ON && survivors > 0) {
          const discrete = Object.create(null);
          let left = 0;
          let walked = 0;                                // its own cap: `tested` counts pass 1 only
          for (let s = 0; s < pool.length && walked < DMG_MAX_SETS; s++) {
            walked++;
            const set = pool[s];
            if (!set) continue;
            const key = set.id || ('candidate-' + s);
            if (perObservation[key]) continue;      // already refused by the range test
            const reason = this._discreteVerdict(set, observation, defender, state);
            if (reason) discrete[key] = reason;
            else left++;
          }
          if (left > 0) {
            const dkeys = Object.keys(discrete);
            for (let k = 0; k < dkeys.length; k++) perObservation[dkeys[k]] = discrete[dkeys[k]];
            survivors = left;
          } else if (Object.keys(discrete).length) {
            this._addReason(mon, 'Exact-roll evidence ignored: no candidate can produce ' +
              U.round1(observation.damagePercent) + '% exactly, so the range verdict stands');
          }
        }
        const keys = Object.keys(perObservation);
        for (let k = 0; k < keys.length; k++) {
          if (!committed[keys[k]]) committed[keys[k]] = perObservation[keys[k]];
        }
      }
      cache.sig = sig;
      cache.verdicts = committed;
      return committed;
    }

    /** One set against one observed hit: a reason to drop it, or null. */
    _damageVerdict(set, observation, defender, state) {
      let res = null;
      try {
        res = this.damage.calculateDamage(Object.assign({}, set, observation.attackerSnapshot || {}), observation.defenderSnapshot || defender, observation.moveName, observation.fieldSnapshot || (state && state.field) || null, {
          attackerIsP1: !!observation.attackerIsP1,
          weather: observation.weather || '',
          terrain: observation.terrain || '',
          defender: {
            hpPercent: observation.hpBefore,
            boosts: observation.defenderBoosts,
            status: observation.defenderStatus
          }
        });
      } catch (e) { return null; }
      if (!res || res.failed) return null;
      const lo = res.minPercent, hi = res.maxPercent;
      if (typeof lo !== 'number' || typeof hi !== 'number' || !isFinite(lo) || !isFinite(hi)) return null;
      const slack = DMG_SLACK_PCT + DMG_SLACK_REL * Math.max(hi, observation.damagePercent);
      const seen = U.round1(observation.damagePercent);
      if (seen > hi + slack) {
        return 'Took ' + seen + '% from ' + observation.moveName + ': this set maxes at ' +
          U.round1(hi) + '% (offence too low)';
      }
      if (seen < lo - slack) {
        return 'Took ' + seen + '% from ' + observation.moveName + ': this set cannot go below ' +
          U.round1(lo) + '% (offence too high)';
      }
      return null;
    }

    /**
     * The exact half of the same deduction (ARCHITECTURE §6.1), run as its OWN pass over the sets
     * the range test already accepted.
     *
     * A damage roll is an integer, and the number Showdown printed is that integer as a percentage
     * of our max HP, so a set is only possible if ONE OF ITS OWN 16 ROLLS rounds to the printed
     * percentage. Two spreads with the same type effectiveness and base power can differ by a
     * single EV point and land on different rolls, which is how this pins a spread instead of
     * guessing one.
     *
     * It lives in its own pass rather than inside `_damageVerdict` for one reason: when the
     * discrete test would eliminate EVERY remaining candidate the honest answer is "this
     * refinement is not usable here" (the observed percentage may come from a factor we do not
     * model), NOT "discard the observation the range test just made". The caller drops this
     * pass in that case and keeps the range verdict.
     *
     * Returns null when the set survives, and also when the library gave no roll list: a
     * fixed-damage or multi-hit move genuinely has no single roll list, and silence is correct.
     */
    _discreteVerdict(set, observation, defender, state) {
      if (!DISCRETE_ON || !set || !observation) return null;
      if (UNPREDICTABLE_DAMAGE.has(observation.moveId)) return null;
      let res = null;
      try {
        res = this.damage.calculateDamage(Object.assign({}, set, observation.attackerSnapshot || {}), observation.defenderSnapshot || defender, observation.moveName, observation.fieldSnapshot || (state && state.field) || null, {
          attackerIsP1: !!observation.attackerIsP1,
          weather: observation.weather || '',
          terrain: observation.terrain || '',
          defender: {
            hpPercent: observation.hpBefore,
            boosts: observation.defenderBoosts,
            status: observation.defenderStatus
          }
        });
      } catch (e) { return null; }
      if (!res || res.failed) return null;
      if (!Array.isArray(res.rolls) || !res.rolls.length) return null;
      const maxHp = res.defenderMaxHP || 0;
      if (!(maxHp > 0)) return null;
      const seen = U.round1(observation.damagePercent);
      // The observation carries one decimal place of percentage, so the integer rolls that could
      // have produced it sit in a narrow band; half an HP of slack absorbs the percentile
      // arithmetic at both ends of it.
      const low = (seen - DR_SLACK_PCT) / 100 * maxHp - 0.5;
      const high = (seen + DR_SLACK_PCT) / 100 * maxHp + 0.5;
      for (let i = 0; i < res.rolls.length; i++) {
        const v = res.rolls[i];
        if (v >= low && v <= high) return null;
      }
      return 'Took ' + seen + '% from ' + observation.moveName + ': none of this set\'s ' +
        res.rolls.length + ' rolls (' + U.round1(res.rolls[0] / maxHp * 100) + '-' +
        U.round1(res.rolls[res.rolls.length - 1] / maxHp * 100) + '%) can round to ' + seen +
        '% (exact-roll elimination)';
    }

    /** Resolve the ruler of an observation: our own body, by id (or species as a fallback). */
    _myMonById(state, id) {
      if (!state) return null;
      const team = state.myTeam || [];
      for (let i = 0; i < team.length; i++) {
        const mon = team[i];
        if (!mon) continue;
        if (mon.id === id || (id && U.toID(mon.species) === id)) return mon;
      }
      return null;
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
      // Refuse the observation before it becomes a floor: see speedFloorUnsound. The ORDER is still
      // recorded as evidence (it did happen), it just is not converted into a Speed bound.
      if (this.speedFloorUnsound(mon, state)) {
        this._addEvidence(mon, 'Speed order seen but not converted to a floor (' +
          (event.reason || 'moved first') + '): weather / terrain / Tailwind / a Speed stage could explain it');
        return { pruned: false, dropped: 0, floor: mon.speedFloor | 0, survivors: this._poolFor(mon), unsound: true };
      }
      const value = Math.max(1, Math.round(event.value || 0));
      if (value > (mon.speedFloor | 0)) {
        mon.speedFloor = value;
        this._addEvidence(mon, 'Speed floor ' + value + '+ (' + (event.reason || 'moved first') + ')');
      }
      const res = this.applySpeedFloor(mon, state);
      res.mon = mon;
      return res;
    }

    /* --------------------------------------------- residual-order speed evidence */

    /** Resolve a body from one side's team by slot first, then by species id. */
    _monFromTeam(team, slot, species) {
      if (!Array.isArray(team) || !team.length) return null;
      if (slot) {
        for (let i = 0; i < team.length; i++) {
          if (team[i] && team[i].slot === slot) return team[i];
        }
      }
      const id = U.toID(species);
      if (id) {
        for (let i = 0; i < team.length; i++) {
          if (team[i] && (team[i].id === id || U.toID(team[i].species) === id)) return team[i];
        }
      }
      return null;
    }

    /** The speed we currently believe for a body: its surviving set's own Speed. */
    _believedSpeed(mon) {
      const set = (mon && mon.liveSet) ? mon.liveSet : (mon ? this.bestSet(mon) : null);
      if (!set) return 0;
      return U.maxSpeedForSet(set);
    }

    /**
     * Residual-order event handler, the twin of handleSpeedFloorEvent (ARCHITECTURE §6.2).
     *
     * The conversion only: `BattleStateManager._onResidualOrder` has already written the raw
     * relation onto BOTH bodies (it owns MonState, and it is the single writer of these fields),
     * so this resolves the two bodies and asks each of them to narrow its own pool. Doing the
     * recording here as well would mean two writers for one fact.
     */
    handleResidualOrderEvent(event, state) {
      const nothing = { pruned: false, dropped: 0, floor: 0, ceiling: 0, survivors: [] };
      if (!event || !state) return nothing;
      const faster = this._monFromTeam(event.side === state.mySide ? state.myTeam : state.oppTeam,
        event.slot, event.species);
      const slower = this._monFromTeam(event.otherSide === state.mySide ? state.myTeam : state.oppTeam,
        event.otherSlot, event.otherSpecies);
      if (!faster || !slower || faster === slower) return nothing;

      const a = this.applyResidualOrder(faster, state);
      const b = this.applyResidualOrder(slower, state);
      return {
        pruned: a.pruned || b.pruned,
        dropped: a.dropped + b.dropped,
        floor: a.floor, ceiling: b.ceiling,
        survivors: a.survivors && a.survivors.length ? a.survivors : b.survivors
      };
    }

    /**
     * Turn the recorded residual relations into a speed floor/ceiling and narrow the pool.
     *
     * End-of-turn residual damage and healing resolve in Speed order (fastest first) regardless of
     * Trick Room, so "my Leftovers ticked before yours" means my Speed is strictly greater. The
     * relative fact becomes a number only through the OTHER body's believed Speed, so this is the
     * most indirect deduction in the file and every step is allowed to fail soft: no candidate
     * surviving the new bracket republishes the pristine pool and says why.
     */
    applyResidualOrder(mon, state) {
      const pool0 = this._poolFor(mon);
      const idle = { pruned: false, dropped: 0, floor: 0, ceiling: 0, survivors: pool0 };
      if (!mon || !RESID_ON) return idle;
      const before = Array.isArray(mon.residualOrderBefore) ? mon.residualOrderBefore : [];
      const after = Array.isArray(mon.residualOrderAfter) ? mon.residualOrderAfter : [];
      if (!before.length && !after.length) return idle;
      // `trust` says how far the relative order may bite: below half a step the order is recorded
      // as telemetry only, because a residual that ticked first is not always a Speed comparison
      // (a switch-in, a consumed berry and a weather heal can reorder the same block).
      if (RESID_TRUST < 0.5) {
        this._addEvidence(mon, 'Residual order logged (' + before.length + ' before / ' +
          after.length + ' after); pruner.residualOrder.trust too low to convert it');
        return idle;
      }
      const margin = Math.max(1, Math.round(RESID_TRUST));
      let floor = Math.max(mon.speedFloor | 0, 0);
      let ceiling = typeof mon.speedCeiling === 'number' ? mon.speedCeiling : SPEED_MAX_CEILING;
      const notes = [];
      for (let i = 0; i < before.length; i++) {
        const other = this._bodyFromState(state, before[i]);
        const beat = other ? this._believedSpeed(other) : 0;
        if (beat > 0 && beat + margin > floor) {
          floor = beat + margin;
          notes.push('beat ' + (before[i].species || before[i].id) + ' (' + beat + ')');
        }
      }
      for (let i = 0; i < after.length; i++) {
        const other = this._bodyFromState(state, after[i]);
        const won = other ? this._believedSpeed(other) : 0;
        if (won > 0 && won - margin < ceiling) {
          ceiling = won - margin;
          notes.push('lost to ' + (after[i].species || after[i].id) + ' (' + won + ')');
        }
      }
      if (!notes.length || (floor <= (mon.speedFloor | 0) && ceiling >= (typeof mon.speedCeiling === 'number' ? mon.speedCeiling : SPEED_MAX_CEILING))) {
        return idle;
      }

      const survivors = [];
      const dropped = [];
      for (let i = 0; i < pool0.length; i++) {
        const set = pool0[i];
        const spe = U.maxSpeedForSet(set);
        set.maxSpeed = spe;
        if (floor && spe < floor) { dropped.push(set); continue; }
        if (ceiling < SPEED_MAX_CEILING && spe > ceiling) { dropped.push(set); continue; }
        survivors.push(set);
      }
      if (!survivors.length) {
        this._addReason(mon, 'Residual order (' + notes.join('; ') + ') would leave no candidate; ignored');
        return { pruned: false, dropped: 0, floor: floor, ceiling: ceiling, survivors: pool0 };
      }
      const key = this._poolKey(mon);
      if (key) this._pristine[key] = survivors;
      mon.candidateSets = survivors.slice();
      if (floor) mon.speedFloor = floor;
      if (ceiling < SPEED_MAX_CEILING) mon.speedCeiling = ceiling;
      const best = this.bestSet(mon);
      if (best) mon.liveSet = best;
      this._addEvidence(mon, 'Residual order: ' + notes.join('; ') +
        ' => Speed bracket [' + (floor || 0) + ', ' + (ceiling >= SPEED_MAX_CEILING ? '?' : ceiling) + ']');
      if (dropped.length) {
        this._addReason(mon, 'Residual order bracket [' + (floor || 0) + '-' +
          (ceiling >= SPEED_MAX_CEILING ? '?' : ceiling) + ']: eliminated ' + dropped.length +
          ' set' + (dropped.length === 1 ? '' : 's') + ' (' + notes.join('; ') + ')');
      }
      return { pruned: dropped.length > 0, dropped: dropped.length, floor: floor, ceiling: ceiling, survivors: survivors };
    }

    /** Resolve the counterpart of a residual relation against the live battle state. */
    _bodyFromState(state, rel) {
      if (!state || !rel) return null;
      const id = rel.id || U.toID(rel.species);
      if (!id) return null;
      const teams = [state.myTeam, state.oppTeam, state.bench && state.bench.opp, state.bench && state.bench.my];
      for (let t = 0; t < teams.length; t++) {
        const team = teams[t];
        if (!Array.isArray(team)) continue;
        for (let i = 0; i < team.length; i++) {
          const mon = team[i];
          if (mon && (mon.id === id || U.toID(mon.species) === id)) return mon;
        }
      }
      return null;
    }

    /* ------------------------------------------------------- ability deduction */

    /**
     * _disprovedAbilities(mon, state) -> { ids: {abilityId: reason}, size: number }
     *
     * The negative-space ability rules, in the same spirit as the item rules: each one turns
     * something the log PRINTED into an elimination, never a guess about the species. Three
     * families, each individually switchable (pruner.abilityDeduction.*):
     *
     *   statusRules   the body is carrying a status, so no candidate may hold an ability that
     *                 makes that status impossible (U.STATUS_IMMUNITY_ABILITIES is game data).
     *                 Skipped when the status was stamped as landing under an ability-suppressing
     *                 body (mon.statusSuppressed): Neutralizing Gas makes those abilities inert,
     *                 so the status it allowed disproves nothing.
     *   groundRules   the body took damage only a GROUNDED body can take, so no candidate may
     *                 hold Levitate / Earth Eater. Gravity grounds everyone and negates Levitate,
     *                 so the whole family is skipped while it is up. It takes a DIRECT hit: the
     *                 state manager refuses to set `groundDisproved` on damage that carries a
     *                 `[from]` clause (a burn tick is not a Ground move connecting) and refuses to
     *                 stamp the aim when the attacker's KNOWN ability ignores abilities. Residual
     *                 risk, stated rather than hidden: an UNREVEALED Mold Breaker attacker is
     *                 indistinguishable from an ordinary one, so its Ground move still counts.
     *   absenceRules  (ships OFF) the body switched in this turn and a switch-in trigger ability
     *                 its set carries never announced itself. This is the one ABSENCE-of-evidence
     *                 inference, which is why it is gated: Neutralizing Gas and friends silence the
     *                 announcement, so it also requires that no suppression is visible.
     *
     * Returns a plain map whose keys are the doomed ability ids; the caller turns a hit into a
     * per-set drop reason so the trail names the real ability, not its id.
     */
    _disprovedAbilities(mon, state) {
      const banned = Object.create(null);
      let size = 0;
      if (!mon || !ABILITY_DEDUCTION_ON) return { ids: banned, size: 0 };
      const field = (state && state.field) || {};
      const ban = function (id, reason) {
        if (!id || banned[id]) return;
        banned[id] = reason;
        size++;
      };

      if (AB_DEDUCTION_STATUS && !mon.statusSuppressed) {
        const blocked = U.abilitiesBlockingStatus(mon.status);
        if (blocked && blocked.size) {
          const label = String(mon.status || '').toUpperCase();
          blocked.forEach(function (id) {
            ban(id, 'the body is carrying ' + label + ', which this ability would have prevented');
          });
        }
      }

      if (AB_DEDUCTION_GROUND && mon.groundDisproved && !field.gravity) {
        U.GROUND_IMMUNE_ABILITIES.forEach(function (id) {
          ban(id, 'it took damage only a grounded body can take with no Gravity up');
        });
      }

      if (AB_DEDUCTION_ABSENCE && !this._abilitySuppressed(state)) {
        const turn = state && typeof state.turn === 'number' ? state.turn : null;
        if (turn !== null && mon.switchedInTurn === turn && !mon.revealedAbility) {
          U.SWITCH_IN_TRIGGER_ABILITIES.forEach(function (id) {
            ban(id, 'it switched in this turn without announcing itself');
          });
        }
      }

      return { ids: banned, size: size };
    }

    /**
     * Is something on the field silencing abilities right now? Neutralizing Gas is the one the
     * protocol lets us see: its own activation line is printed, so a revealed Neutralizing Gas on
     * either active body means a MISSING announcement proves nothing. Used only by the gated
     * absence rule.
     *
     * This scan IS the guard — there is no `state.field.abilitySuppressed` to read (an earlier
     * version tested that field, which nothing in src/ ever wrote, so the branch could never
     * fire). What the state manager keeps is the per-body STAMP of the moment a status landed
     * (`mon.statusSuppressed`), which is what the status rule needs and a live scan cannot
     * reconstruct.
     */
    _abilitySuppressed(state) {
      const teams = [(state && state.myTeam) || [], (state && state.oppTeam) || []];
      for (let t = 0; t < teams.length; t++) {
        const team = teams[t];
        if (!Array.isArray(team)) continue;
        for (let i = 0; i < team.length; i++) {
          const m = team[i];
          if (m && m.isActive && U.toID(m.revealedAbility || '') === 'neutralizinggas') return true;
        }
      }
      return false;
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
      // Ability deduction is computed ONCE per body (it depends only on the mon and the field),
      // then tested per candidate set in the loop below.
      const abilityBan = this._disprovedAbilities(mon, state);

      // 1. Rule evaluation first — it decides the item filters below.
      const choice = this.applyChoiceLockRule(mon, state);
      const itemless = this._applyItemlessClassification(mon, state);
      // Every hit this mon has already landed on our side, judged against the pool. Memoised
      // per observation signature, so this is a handful of comparisons on a repeat call.
      const damageVerdicts = this.damageVerdicts(mon, state, pristine);
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

        // Ability deduction: an observed status or grounded-only damage disproves the set's
        // ability outright (rule tables in src/util.js, switches in config.pruner.abilityDeduction).
        if (!drop && abilityBan.size) {
          const setAbilityId = U.toID(set.ability);
          if (setAbilityId && abilityBan.ids[setAbilityId]) {
            drop = 'Ability disproved (' + set.ability + '): ' + abilityBan.ids[setAbilityId];
          }
        }

        // Reverse damage deduction: an observed hit this set cannot have produced.
        if (!drop && damageVerdicts) {
          const setKey = set.id || ('candidate-' + i);
          if (damageVerdicts[setKey]) drop = damageVerdicts[setKey];
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

      /* TEAM-PREVIEW SYNERGY, applied to the SURVIVORS (never to the pristine pool): a factor may
       * re-rank what the log still allows, it may not resurrect what a deduction removed. Applied
       * after every elimination and before the pool is published/sorted, and idempotent because
       * each set's factor is recomputed from its stored base weight. */
      this._applyTeamSynergyPrior(mon, published, state);

      mon.candidateSets = published;
      mon.liveSet = this.bestSet(mon);
      this._publishEvPin(mon, published);
      if (mon.liveSet) {
        if (!mon.originalArchetypeItem) mon.originalArchetypeItem = mon.liveSet.item || null;
        if (!mon.confirmedItem && !mon.currentBattleItem && published.length === 1) {
          mon.originalArchetypeItem = published[0].item || null;
          this._addReason(mon, 'Single surviving set: ' + published[0].id + ' (' + (published[0].role || 'set') + ')');
        }
      }
      return published;
    }

    /**
     * EV pinning (ARCHITECTURE §6.1): when the surviving pool has collapsed to a single EV
     * vector, we know the opponent's exact investment. Two independent observations are required
     * (`pruner.discreteRolls.requireObservations`) because one lucky match can fit several
     * spreads by coincidence — a single-hit "pin" would be a guess wearing a badge.
     */
    _publishEvPin(mon, published) {
      if (!mon) return null;
      mon.evPinned = false;
      mon.pinnedEvs = null;
      if (!Array.isArray(published) || !published.length) return null;
      const obs = Array.isArray(mon.damageDealt) ? mon.damageDealt.length : 0;
      if (obs < Math.max(1, DR_REQUIRE_OBS | 0)) return null;
      const sig = evSignature(published[0].evs);
      if (!sig) return null;
      for (let i = 1; i < published.length; i++) {
        if (evSignature(published[i].evs) !== sig) return null;
      }
      mon.pinnedEvs = published[0].evs;
      mon.evPinned = true;
      this._addReason(mon, 'Exact spread pinned from ' + obs + ' observed hits: ' + evText(mon.pinnedEvs) +
        ' (all ' + published.length + ' surviving set' + (published.length === 1 ? '' : 's') + ' share it)');
      return mon.pinnedEvs;
    }

    /* -------------------------------------------------- team-preview synergy */

    /**
     * `_applyTeamSynergyPrior(mon, pool, state)` -> how many sets it moved.
     *
     * The opponent's six names are known before any set is. That is weak, but it is REAL evidence
     * about each body, and the engine ignored it entirely:
     *   - a Pelipper / Politoed on their team makes a Swift Swim / Hurricane / Thunder set far more
     *     likely than the curated average, and a Torkoal / Charizard makes the sun version so;
     *   - a Trick Room setter (`U.TR_SETTERS`) makes a 0-Spe set likely;
     *   - a SECOND Stealth Rock carrier is unlikely once one body has already revealed the move.
     *
     * Every factor multiplies the set's BASE weight (stored once as `synergyBase`), so repeated
     * calls recompute rather than compound, and no factor can add a set or beat a deduction. Off,
     * or on a body that is not on the opponent's side, this is a no-op.
     */
    _applyTeamSynergyPrior(mon, pool, state) {
      if (!SYNERGY_ON || !mon || !pool || !pool.length) return 0;
      if (!state || !state.oppSide || mon.side !== state.oppSide) return 0;
      const team = Array.isArray(state.oppTeam) ? state.oppTeam : [];
      const weather = this._teamWeather(team);
      const trTeam = this._teamHasTR(team);
      const srElsewhere = this._stealthRockElsewhere(mon, team);
      if (!weather && !trTeam && !srElsewhere) {
        for (let i = 0; i < pool.length; i++) {
          const set = pool[i];
          if (set && typeof set.synergyBase === 'number') set.weight = set.synergyBase;
        }
        return 0;
      }
      let moved = 0;
      for (let i = 0; i < pool.length; i++) {
        const set = pool[i];
        if (!set) continue;
        if (typeof set.synergyBase !== 'number') {
          set.synergyBase = (typeof set.weight === 'number') ? set.weight : 0;
        }
        let factor = 1;
        if (weather && this._isWeatherSet(set, weather)) factor *= SYNERGY_WEATHER;
        if (trTeam && this._isTRSet(set)) factor *= SYNERGY_TR;
        if (srElsewhere && this._setHasMove(set, 'stealthrock')) factor *= SYNERGY_SR_DUP;
        const next = set.synergyBase * factor;
        if (next !== set.weight) moved++;
        set.weight = next;
      }
      if (moved) {
        this._addReason(mon, 'Team preview: re-weighted ' + moved + ' of ' + pool.length +
          ' candidate sets' + (weather ? ' (' + weather + ')' : '') +
          (trTeam ? ' (Trick Room)' : '') + (srElsewhere ? ' (duplicate Stealth Rock)' : ''));
      }
      return moved;
    }

    /** 'rain' | 'sun' | '' from the six names the |poke| frame printed. */
    _teamWeather(team) {
      const has = function (id) {
        for (let i = 0; i < team.length; i++) {
          const m = team[i];
          if (m && U.toID(m.species || m.id) === id) return true;
        }
        return false;
      };
      if (has('pelipper') || has('politoed')) return 'rain';
      if (has('torkoal') || has('ninetales') || has('charizard')) return 'sun';
      return '';
    }

    /** Is a Trick Room setter on their six? (`U.TR_SETTERS` is the shared table.) */
    _teamHasTR(team) {
      for (let i = 0; i < team.length; i++) {
        const m = team[i];
        if (m && U.TR_SETTERS.has(U.toID(m.species || m.id))) return true;
      }
      return false;
    }

    /** Has a DIFFERENT body already revealed Stealth Rock? */
    _stealthRockElsewhere(mon, team) {
      const myId = mon && (mon.id || U.toID(mon.species));
      for (let i = 0; i < team.length; i++) {
        const m = team[i];
        if (!m || m === mon) continue;
        if (myId && (m.id || U.toID(m.species)) === myId) continue;
        const revealed = m.revealedMoves || [];
        for (let r = 0; r < revealed.length; r++) {
          if (U.toID(revealed[r]) === 'stealthrock') return true;
        }
      }
      return false;
    }

    /** Does this candidate set benefit from the team's weather? */
    _isWeatherSet(set, kind) {
      if (!set) return false;
      const ability = U.toID(set.ability);
      const moves = set.moves || [];
      const has = function (ids) {
        for (let i = 0; i < moves.length; i++) if (ids.has(U.toID(moves[i]))) return true;
        return false;
      };
      if (kind === 'rain') {
        return RAIN_ABILITIES.has(ability) || has(RAIN_MOVES);
      }
      return SUN_ABILITIES.has(ability) || has(SUN_MOVES);
    }

    /** Is this candidate set a Trick Room set (`isTR`, a 0-Spe IV, or the move itself)? */
    _isTRSet(set) {
      if (!set) return false;
      if (set.isTR) return true;
      const ivs = set.ivs || {};
      if (ivs.spe === 0) return true;
      return this._setHasMove(set, 'trickroom');
    }

    _setHasMove(set, moveId) {
      const moves = (set && set.moves) || [];
      for (let i = 0; i < moves.length; i++) {
        if (U.toID(moves[i]) === moveId) return true;
      }
      return false;
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
