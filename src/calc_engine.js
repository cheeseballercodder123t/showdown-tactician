/* Showdown Tactician — src/calc_engine.js
 * Wrapper around the vendored @smogon/calc UMD bundle (window.calc).
 *
 * This is the ONLY module permitted to call the library's damage calculator: every damage
 * number in the extension is produced by `calc.calculate(...)` here and nowhere else. (The dex
 * tables and the stat arithmetic are src/util.js's business — it reads `calc.SPECIES`,
 * `calc.MOVES` and `calc.Stats.calcStat`; no third file touches the bundle at all.) Everything
 * else goes through ST.util and ST.DamageEngine so the memoized ranges are shared between the
 * world sampler, the evaluator, the veto guard and the laplace solver.
 *
 * Public API (frozen — see ARCHITECTURE.md section 3):
 *   new ST.DamageEngine({ gen: 9 })
 *   engine.calculateDamage(atk, def, moveName, fieldState, opts) -> DamageResult
 *   engine.getBestIncomingThreat(oppMon, myMon, fieldState)
 *   engine.getBestOutgoingMove(myMon, oppMon, fieldState)
 *   engine.probeCombo(atk, def, moves, fieldState, opts) -> DamageResult|null
 *   engine.fieldFromState(fieldState) -> CALC.Field
 *   engine.beginTurn(turnKey) / engine.clearCache() / engine.cacheSize() / engine.stats
 *
 * Ability/forme state that changes a number is carried on the MonState and forwarded here:
 *   alliesFainted  — Supreme Overlord / Last Respects (stamped by state_manager._stampFallen)
 *   boosterActive  — Protosynthesis / Quark Drive, forwarded as `boostedStat: 'auto'` so the
 *                    library, not this project, decides which stat the paradox boost lifts
 *
 * DamageResult = { minDmg, maxDmg, avgDmg, minPercent, maxPercent, avgPercent,
 *                  isOHKO, is2HKO, koChancePct, desc, moveDesc, moveType, moveCategory,
 *                  priority, basePower, defenderMaxHP, defenderHPPercent, failed, error,
 *                  rolls, rollCount, koChanceExact, rollPercent(v), maxHpPercent }
 *
 * The 16 discrete rolls (ARCHITECTURE §6.1): Pokemon damage is not a continuous interval, it is
 * one of 16 integer rolls. The library hands them over on `result.damage`, so they are exposed
 * verbatim as `rolls` — never synthesized, and `null` when the library gave a single number (a
 * fixed-damage move) or a per-hit array (a multi-hit move). With `rolls` present, `koChancePct`
 * is the EXACT share of rolls that reach the defender's current HP and `koChanceExact` repeats it;
 * without them both fall back to the range-based estimate this file has always used, and
 * `koChanceExact` is null so a caller can tell an exact answer from an estimate.
 *
 * Performance: a memo hit is a Map lookup. The typical turn computes < 120 distinct
 * (attacker, defender, move, field) tuples for K=6 worlds, well inside the 10 ms budget.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;

  const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
  const DEFAULT_EVS = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  const DEFAULT_IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  const ZERO_BOOSTS = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };

  const WEATHER_MAP = {
    sun: 'Sun', sunny: 'Sun', rain: 'Rain', sandstorm: 'Sand', sand: 'Sand', snow: 'Snow',
    hail: 'Snow', harshsun: 'Harsh Sunshine', desolateland: 'Harsh Sunshine',
    heavyrain: 'Heavy Rain', primordialsea: 'Heavy Rain', strongwinds: ''
  };
  const TERRAIN_MAP = { electric: 'Electric', grassy: 'Grassy', psychic: 'Psychic', misty: 'Misty' };

  function zeros() { return { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }; }
  function normEVs(evs) {
    const out = zeros();
    if (!evs) return out;
    for (let i = 0; i < STAT_KEYS.length; i++) {
      const k = STAT_KEYS[i];
      const v = evs[k];
      out[k] = typeof v === 'number' ? Math.max(0, Math.min(252, v)) : 0;
    }
    return out;
  }
  function normIVs(ivs) {
    const out = {};
    for (let i = 0; i < STAT_KEYS.length; i++) {
      const k = STAT_KEYS[i];
      const v = ivs ? ivs[k] : undefined;
      out[k] = typeof v === 'number' ? Math.max(0, Math.min(31, v)) : 31;
    }
    return out;
  }
  function normBoosts(boosts) {
    const out = Object.assign({}, ZERO_BOOSTS);
    if (!boosts) return out;
    Object.keys(ZERO_BOOSTS).forEach(function (k) {
      const v = boosts[k];
      if (typeof v === 'number' && v) out[k] = Math.max(-6, Math.min(6, v));
    });
    return out;
  }
  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  class DamageEngine {
    constructor(options) {
      const opts = options || {};
      this.genNum = opts.gen || 9;
      this.CALC = window.calc || null;
      this.gen = (this.CALC && this.CALC.Generations) ? this.CALC.Generations.get(this.genNum) : null;
      this.available = !!(this.CALC && this.gen && typeof this.CALC.calculate === 'function');
      this.turnKey = null;
      this.cache = new Map();
      this.fieldCache = new Map();
      this.maxCache = opts.maxCache || 4096;
      this.maxFieldCache = opts.maxFieldCache || 32;
      this.stats = { hits: 0, misses: 0, failures: 0, evictions: 0, fieldBuilds: 0 };
      this.notes = [];
      if (!this.available) this.notes.push('window.calc unavailable — every calculation will return failed:true');
    }

    /* ------------------------------------------------------------ cache control */

    /** Start a fresh turn: wipe the memo tables. Called once per |request|. */
    beginTurn(turnKey) {
      this.turnKey = (turnKey === undefined || turnKey === null) ? null : String(turnKey);
      this.cache.clear();
      this.fieldCache.clear();
      return this;
    }

    clearCache() { return this.beginTurn(null); }

    cacheSize() { return this.cache.size; }

    /** Pool counters, exposed for the test harness and the debug HUD. */
    cacheStats() {
      return {
        size: this.cache.size, fields: this.fieldCache.size, max: this.maxCache,
        hits: this.stats.hits, misses: this.stats.misses, evictions: this.stats.evictions,
        hitRate: (this.stats.hits + this.stats.misses) ? this.stats.hits / (this.stats.hits + this.stats.misses) : 0
      };
    }

    _store(key, value) {
      if (this.cache.size >= this.maxCache) {
        const oldest = this.cache.keys().next();
        if (!oldest.done) { this.cache.delete(oldest.value); this.stats.evictions++; }
      }
      this.cache.set(key, value);
    }

    /* ------------------------------------------------------------ descriptors */

    /**
     * Turn a MonState (state_manager) or a loose object / SetCandidate into a plain
     * descriptor the calculator can consume. Never throws, never touches calc.
     */
    _describe(mon, role, opts) {
      const m = mon || {};
      const set = m.liveSet && typeof m.liveSet === 'object' ? m.liveSet : null;
      const species = m.species || m.name || (set && set.species) || '';

      let evs = m.evs || (set && set.evs);
      let ivs = m.ivs || (set && set.ivs);
      let nature = m.nature || (set && set.nature);
      let item = m.item !== undefined ? m.item : (m.currentBattleItem || m.confirmedItem || m.originalArchetypeItem || (set && set.item));
      let ability = m.ability || m.revealedAbility || (set && set.ability);

      // explicit per-call overrides win over everything
      const overrideKey = role === 'attacker' ? 'attacker' : 'defender';
      const o = opts[overrideKey];
      let level = m.level || 100;
      if (o) {
        if (o.item !== undefined) item = o.item;
        if (o.ability !== undefined) ability = o.ability;
        if (o.nature) nature = o.nature;
        if (o.evs) evs = o.evs;
        if (o.ivs) ivs = o.ivs;
        if (o.level) level = o.level;
      }

      // itemless archetypes (Acrobatics / Unburden) must not inherit a phantom item
      if (m.itemless && item && !opts[overrideKey]) item = '';

      let hpPercent = 100;
      if (typeof m.hpPercent === 'number') hpPercent = m.hpPercent;
      else if (typeof m.hp === 'number') hpPercent = m.hp;
      if (opts[overrideKey] && typeof opts[overrideKey].hpPercent === 'number') hpPercent = opts[overrideKey].hpPercent;
      if (opts[overrideKey] && typeof opts[overrideKey].hp === 'number') hpPercent = opts[overrideKey].hp;

      let status = m.status || '';
      if (typeof m.toxicCounter === 'number' && m.toxicCounter > 0 && !status) status = 'tox';
      if (opts[overrideKey] && opts[overrideKey].status !== undefined) status = opts[overrideKey].status;

      // Explicit per-call override wins, exactly as this descriptor's own contract says. The old
      // form (`m.boosts || override`) read the mon's table FIRST, and every MonState carries one
      // (state_manager seeds all seven keys to zero), so a boost override was silently ignored for
      // every real caller and only ever applied to a mon that had no boosts at all. That made it
      // impossible to price a stat stage the mon does not have YET — which is the whole question
      // `_payoff`'s setup extension asks ("what does their Attack look like after they set up?").
      let boosts = (opts[overrideKey] && opts[overrideKey].boosts !== undefined)
        ? opts[overrideKey].boosts
        : m.boosts;

      // Supreme Overlord / Last Respects: the state manager stamps `alliesFainted` onto every
      // MonState, so the count is real rather than assumed. Without it the library computes
      // Kingambit's Kowtow Cleave as if no ally had fallen — a large undercount.
      let alliesFainted = typeof m.alliesFainted === 'number' ? m.alliesFainted : 0;
      if (opts[overrideKey] && typeof opts[overrideKey].alliesFainted === 'number') {
        alliesFainted = opts[overrideKey].alliesFainted;
      }
      // Protosynthesis / Quark Drive: `boosterActive` is the state manager's proof that the
      // boost is live. WHICH stat it lifts is the library's own decision — passing the string
      // 'auto' makes @smogon/calc pick the highest stat itself, so we never model that rule.
      const paradoxBoosted = (opts[overrideKey] && opts[overrideKey].boosterActive !== undefined)
        ? !!opts[overrideKey].boosterActive : !!m.boosterActive;

      // Choice-lock / cannotBeChoice metadata normally lives on the mon; keep it on the
      // descriptor so callers can inspect what the number was produced from.
      return {
        species: species,
        name: species,
        role: role,
        level: level,
        gender: m.gender || '',
        item: item || '',
        ability: ability || '',
        nature: nature || 'Serious',
        evs: normEVs(evs),
        ivs: normIVs(ivs),
        boosts: normBoosts(boosts),
        alliesFainted: alliesFainted,
        paradoxBoosted: paradoxBoosted,
        status: status,
        hpPercent: Math.max(0, Math.min(100, hpPercent === null || hpPercent === undefined ? 100 : hpPercent)),
        revealedMoves: Array.isArray(m.revealedMoves) ? m.revealedMoves.slice() : [],
        candidateSets: Array.isArray(m.candidateSets) ? m.candidateSets : [],
        set: set
      };
    }

    /**
     * Which moves are worth simulating for this mon? 0..cap, always an array.
     * Order of truth: an explicit override, the moveset we own (setMoves/moves), what the
     * opponent has shown, the surviving set, the surviving candidate pool, and finally the
     * shared database for a mon we only know by species. Returning [] means "no model", and
     * the callers then report no threat instead of inventing one.
     */
    movesFor(mon, limit) {
      const cap = limit || 4;
      const m = mon || {};
      if (Array.isArray(m.moves) && m.moves.length) return m.moves.slice(0, cap);
      if (Array.isArray(m.setMoves) && m.setMoves.length) return m.setMoves.slice(0, cap);
      if (Array.isArray(m.revealedMoves) && m.revealedMoves.length) return m.revealedMoves.slice(0, cap);
      if (m.liveSet && Array.isArray(m.liveSet.moves) && m.liveSet.moves.length) return m.liveSet.moves.slice(0, cap);
      const sets = this.poolFor(mon);
      if (!sets.length) return [];
      sets.sort(function (a, b) { return (b.weight || 0) - (a.weight || 0); });
      const out = [];
      for (let i = 0; i < sets.length && out.length < cap; i++) {
        const moves = sets[i].moves || [];
        for (let j = 0; j < moves.length && out.length < cap; j++) {
          if (out.indexOf(moves[j]) === -1) out.push(moves[j]);
        }
      }
      return out;
    }

    /**
     * The best set pool available for a mon that may carry nothing but a species: the live
     * candidate pool, else the shared database, else the generic templates for that species.
     * Never throws and never invents a species-specific move for an unknown species.
     */
    poolFor(mon) {
      const m = mon || {};
      if (Array.isArray(m.candidateSets) && m.candidateSets.length) return m.candidateSets.slice();
      const species = m.species || m.name || '';
      const DB = ST.SetDatabase;
      if (!species || !DB) return [];
      try {
        if (typeof DB.forSpecies === 'function') {
          const known = DB.forSpecies(species);
          if (Array.isArray(known) && known.length) return known;
        }
        if (typeof DB.genericFor === 'function') {
          const generic = DB.genericFor(species);
          if (Array.isArray(generic) && generic.length) return generic;
        }
      } catch (e) { /* a dex miss must never break a calculation */ }
      return [];
    }

    /* ------------------------------------------------------------ field */

    _sideFromState(side) {
      return side || { rocks: false, spikes: 0, toxicspikes: 0, stickyweb: false, steelspikes: 0 };
    }

    /**
     * Build the CALC.Field for a battle state.
     * `attackerIsP1` selects which stored side is the attacker's, so hazard/screen state
     * lands on the correct side of the equation.
     */
    _buildField(fieldState, attackerIsP1, opts) {
      const C = this.CALC;
      const fs = fieldState || {};
      const hazards = fs.hazards || {};
      const screens = fs.screens || {};
      const tailwind = fs.tailwind || {};
      const p1 = this._sideFromState(hazards.p1);
      const p2 = this._sideFromState(hazards.p2);
      const s1 = screens.p1 || {};
      const s2 = screens.p2 || {};

      const side = function (h, sc, tw) {
        return new C.Side({
          spikes: h.spikes || 0,
          steelsurge: (h.steelspikes || 0) > 0,
          isSR: !!h.rocks,
          isReflect: !!sc.reflect,
          isLightScreen: !!sc.lightscreen,
          isAuroraVeil: !!sc.auroraveil,
          isTailwind: !!tw
        });
      };
      const p1Side = side(p1, s1, tailwind.p1);
      const p2Side = side(p2, s2, tailwind.p2);

      const weatherKey = fs.weather || (opts && opts.weather) || '';
      const terrainKey = fs.terrain || (opts && opts.terrain) || '';

      const field = new C.Field({
        gameType: 'Singles',
        weather: WEATHER_MAP[String(weatherKey).toLowerCase()] || undefined,
        terrain: TERRAIN_MAP[String(terrainKey).toLowerCase()] || undefined,
        isGravity: !!fs.gravity,
        attackerSide: attackerIsP1 ? p1Side : p2Side,
        defenderSide: attackerIsP1 ? p2Side : p1Side
      });
      // Trick Room does not change damage output, but downstream code (and the debug
      // overlay) reads it back from the field object, so it is carried as metadata.
      field.isTrickRoom = !!fs.trickRoom;
      field.trickRoomTurnsLeft = typeof fs.trickRoomTurnsLeft === 'number' ? fs.trickRoomTurnsLeft : 0;
      this.stats.fieldBuilds++;
      return field;
    }

    /** Public helper — attacker is treated as p1 (the player) unless told otherwise. */
    fieldFromState(fieldState, attackerIsP1) {
      const key = this._fieldKey(fieldState, attackerIsP1 === undefined ? true : !!attackerIsP1);
      const hit = this.fieldCache.get(key);
      if (hit) return hit;
      const field = this._buildField(fieldState, attackerIsP1 === undefined ? true : !!attackerIsP1);
      if (this.fieldCache.size >= this.maxFieldCache) {
        const oldest = this.fieldCache.keys().next();
        if (!oldest.done) this.fieldCache.delete(oldest.value);
      }
      this.fieldCache.set(key, field);
      return field;
    }

    _fieldKey(fieldState, attackerIsP1) {
      const fs = fieldState || {};
      const h = fs.hazards || {};
      const sc = fs.screens || {};
      const tw = fs.tailwind || {};
      const pack = function (s) {
        const x = s || {};
        return [x.rocks ? 1 : 0, x.spikes || 0, x.toxicspikes || 0, x.steelspikes || 0, x.stickyweb ? 1 : 0].join('.');
      };
      const packSc = function (s) {
        const x = s || {};
        return [x.reflect ? 1 : 0, x.lightscreen ? 1 : 0, x.auroraveil ? 1 : 0].join('.');
      };
      return [
        fs.weather || '', fs.terrain || '', fs.gravity ? 1 : 0, attackerIsP1 ? 1 : 0,
        pack(h.p1), pack(h.p2), packSc(sc.p1), packSc(sc.p2),
        tw.p1 ? 1 : 0, tw.p2 ? 1 : 0
      ].join('|');
    }

    /* ------------------------------------------------------------ pokemon / move */

    _buildPokemon(desc, opts) {
      const C = this.CALC;
      const options = {
        level: desc.level,
        ability: desc.ability || undefined,
        item: desc.item || undefined,
        nature: desc.nature,
        evs: desc.evs,
        ivs: desc.ivs,
        boosts: desc.boosts,
        moves: desc.revealedMoves.slice()
      };
      if (desc.status) options.status = desc.status;
      if (desc.gender) options.gender = desc.gender;
      if (desc.alliesFainted) options.alliesFainted = desc.alliesFainted;
      if (desc.paradoxBoosted) options.boostedStat = 'auto';
      const pk = new C.Pokemon(this.gen, desc.species, options);
      // curHP in @smogon/calc is an ABSOLUTE hp value (values above max HP are ignored).
      const maxHP = pk.rawStats.hp;
      if (typeof opts.attackerHP === 'number' && desc.role === 'attacker') {
        pk.originalCurHP = Math.max(1, Math.min(maxHP, Math.round(opts.attackerHP)));
      } else if (typeof opts.defenderHP === 'number' && desc.role === 'defender') {
        pk.originalCurHP = Math.max(1, Math.min(maxHP, Math.round(opts.defenderHP)));
      } else if (desc.hpPercent < 100) {
        pk.originalCurHP = Math.max(1, Math.round(maxHP * desc.hpPercent / 100));
      }
      return pk;
    }

    /**
     * Build the CALC.Move. A Z-move is requested either explicitly (opts.useZ) or by
     * naming the holding crystal (opts.zCrystal), in which case the base move name must be
     * the pre-Z move so the dex can map it (e.g. 'Stone Edge' + 'Lycanium Z').
     */
    _buildMove(attackerDesc, moveName, opts) {
      const C = this.CALC;
      const moveOpts = {};
      if (opts.isCrit) moveOpts.isCrit = true;
      if (opts.hits) moveOpts.hits = opts.hits;
      if (opts.timesUsed) moveOpts.timesUsed = opts.timesUsed;
      if (opts.ability) moveOpts.ability = opts.ability;
      if (opts.item) moveOpts.item = opts.item;
      if (opts.useZ || opts.zCrystal) moveOpts.useZ = true;
      if (opts.useMax) moveOpts.useMax = true;
      const move = new C.Move(this.gen, moveName, moveOpts);
      return { move: move, data: U.getMoveData(moveName) };
    }

    /* ------------------------------------------------------------ the calculation */

    _key(A, D, moveName, fieldSig, opts) {
      const monSig = function (d) {
        return [d.species, d.item, d.ability, d.nature, d.level, d.status, d.hpPercent,
          d.alliesFainted, d.paradoxBoosted ? 1 : 0,
          d.evs.hp, d.evs.atk, d.evs.def, d.evs.spa, d.evs.spd, d.evs.spe,
          d.ivs.hp, d.ivs.atk, d.ivs.def, d.ivs.spa, d.ivs.spd, d.ivs.spe,
          d.boosts.atk, d.boosts.def, d.boosts.spa, d.boosts.spd, d.boosts.spe].join(',');
      };
      // opts.ability / opts.item are part of the key because they switch a Max Move's typing
      // and its ability/item interactions (see _buildMove); with them missing a cached roll
      // was reused across two different assumptions.
      const extra = [opts.isCrit ? 1 : 0, opts.hits || 0, opts.timesUsed || 0,
        opts.useZ ? 1 : 0, opts.useMax ? 1 : 0,
        opts.attackerHP === undefined ? '' : opts.attackerHP,
        opts.defenderHP === undefined ? '' : opts.defenderHP,
        opts.weather || '', opts.terrain || '',
        opts.ability || '', opts.item || ''].join(',');
      return (this.turnKey === null ? '' : this.turnKey + '#') +
        monSig(A) + '>' + monSig(D) + '>' + moveName + '>' + fieldSig + '>' + extra;
    }

    /**
     * Full damage calculation between two mons.
     * @returns {object} DamageResult (see the header). `failed` marks a calculation the
     *   dex could not resolve; the damage fields are then zero and `error` explains why.
     */
    calculateDamage(attackerMon, defenderMon, moveName, fieldState, opts) {
      const options = opts || {};
      if (!this.available) return this._failure('window.calc is not loaded');
      if (!moveName) return this._failure('no move supplied');

      const A = this._describe(attackerMon, 'attacker', options);
      const D = this._describe(defenderMon, 'defender', options);
      if (!A.species) return this._failure('attacker has no species');
      if (!D.species) return this._failure('defender has no species');

      const moveData = U.getMoveData(moveName);
      if (!moveData) return this._failure('unknown move: ' + moveName);
      if (!U.getSpecies(A.species)) return this._failure('unknown attacker species: ' + A.species);
      if (!U.getSpecies(D.species)) return this._failure('unknown defender species: ' + D.species);

      const attackerIsP1 = options.attackerIsP1 === undefined ? true : !!options.attackerIsP1;
      let field = options.field;
      if (!field) {
        field = this.fieldFromState(fieldState, attackerIsP1);
        const overrideWeather = options.weather && WEATHER_MAP[String(options.weather).toLowerCase()] !== field.weather;
        const overrideTerrain = options.terrain && TERRAIN_MAP[String(options.terrain).toLowerCase()] !== field.terrain;
        if (overrideWeather || overrideTerrain) {
          field = field.clone();
          if (overrideWeather) field.weather = WEATHER_MAP[String(options.weather).toLowerCase()] || undefined;
          if (overrideTerrain) field.terrain = TERRAIN_MAP[String(options.terrain).toLowerCase()] || undefined;
        }
      }

      const fieldSig = this._fieldKey(fieldState, attackerIsP1) + '|' +
        (field.weather || '') + '|' + (field.terrain || '') + '|' + (field.isGravity ? 1 : 0);
      const key = this._key(A, D, moveName, fieldSig, options);
      const hit = this.cache.get(key);
      if (hit) { this.stats.hits++; return hit; }
      this.stats.misses++;

      let result;
      try {
        const atkPk = this._buildPokemon(A, options);
        const defPk = this._buildPokemon(D, options);
        const built = this._buildMove(A, moveName, options);
        const raw = this.CALC.calculate(this.gen, atkPk, defPk, built.move, field);
        result = this._resultFrom(raw, defPk, moveData, options);
      } catch (err) {
        this.stats.failures++;
        result = this._failure(String((err && err.message) || err));
      }
      this._store(key, result);
      return result;
    }

    _failure(error) {
      this.stats.failures++;
      const zero = {
        minDmg: 0, maxDmg: 0, avgDmg: 0,
        minPercent: 0, maxPercent: 0, avgPercent: 0,
        isOHKO: false, is2HKO: false, koChancePct: 0,
        desc: '', moveDesc: '', moveType: '', moveCategory: '', priority: 0, basePower: 0,
        defenderMaxHP: 0, defenderHPPercent: 100,
        failed: true, error: error || 'unknown'
      };
      return zero;
    }

    _resultFrom(raw, defPk, moveData, opts) {
      const range = (typeof raw.range === 'function') ? raw.range() : [0, 0];
      const minDmg = range[0] || 0;
      const maxDmg = range[1] || 0;
      const avgDmg = Math.round((minDmg + maxDmg) / 2);
      const maxHP = defPk.stats.hp || defPk.rawStats.hp || 1;
      const curHP = (typeof defPk.originalCurHP === 'number' && defPk.originalCurHP > 0)
        ? defPk.originalCurHP : maxHP;
      const minPercent = minDmg / maxHP * 100;
      const maxPercent = maxDmg / maxHP * 100;
      const avgPercent = avgDmg / maxHP * 100;
      const rolls = this._rollsFrom(raw);
      const ko = this._koProfile(minDmg, maxDmg, curHP, maxHP, rolls);
      // `rollPercent` is the inverse of an observation: the percentage the protocol would print
      // if this integer roll came up. The pruner uses it to ask whether the number Showdown
      // printed could have come from THIS set at all.
      const rollPercent = function (value) {
        if (typeof value !== 'number' || !isFinite(value)) return null;
        return U.round1(value / maxHP * 100);
      };

      let desc = '';
      try { desc = (typeof raw.desc === 'function') ? raw.desc() : ''; } catch (e) { desc = ''; }

      return {
        minDmg: minDmg,
        maxDmg: maxDmg,
        avgDmg: avgDmg,
        minPercent: U.round1(minPercent),
        maxPercent: U.round1(maxPercent),
        avgPercent: U.round1(avgPercent),
        isOHKO: ko.isOHKO,
        is2HKO: ko.is2HKO,
        koChancePct: ko.koChancePct,
        koHits: ko.hits,
        desc: desc,
        moveDesc: desc,
        moveType: moveData.type,
        moveCategory: moveData.category,
        priority: moveData.priority,
        basePower: moveData.basePower,
        isStatus: !!moveData.isStatus,
        defenderMaxHP: maxHP,
        defenderCurHP: curHP,
        defenderHPPercent: U.round1(curHP / maxHP * 100),
        rolls: rolls,
        rollCount: rolls ? rolls.length : 0,
        koChanceExact: rolls ? ko.koChancePct : null,
        rollPercent: rollPercent,
        recoil: (function () { try { return raw.recoil ? raw.recoil() : 0; } catch (e) { return 0; } })(),
        failed: false,
        error: null
      };
    }

    /**
     * The library's own 16 damage rolls, sorted ascending, or null.
     *
     * `Result.damage` is a single number for a fixed-damage move, a flat array of integers for an
     * ordinary move, and an array of per-hit arrays for a multi-hit one. Only the flat shape IS a
     * roll list — anything else returns null rather than inventing one, and the KO estimate then
     * falls back to the range arithmetic it has always used.
     */
    _rollsFrom(raw) {
      const dmg = raw ? raw.damage : null;
      if (!Array.isArray(dmg) || !dmg.length) return null;
      const out = [];
      for (let i = 0; i < dmg.length; i++) {
        const v = dmg[i];
        if (typeof v !== 'number' || !isFinite(v)) return null;
        out.push(v);
      }
      out.sort(function (a, b) { return a - b; });
      return out;
    }

    /**
     * HP-aware KO profile computed from the damage range (no reliance on version-specific
     * kochance() semantics):
     *   - KO this turn when even the minimum roll is lethal,
     *   - with `rolls`, the EXACT share of the 16 rolls that reach `curHP` — the number the
     *     "KO odds" gauge is really asking for, since a 68% KO chance is 11 of 16 rolls and a
     *     uniform span can only approximate that,
     *   - otherwise that uniform-span approximation over [min,max] (the approximation the engine
     *     shipped with, kept as the fallback for a move whose rolls the library does not expose).
     */
    _koProfile(minDmg, maxDmg, curHP, maxHP, rolls) {
      const hp = Math.max(1, curHP);
      let koChancePct = 0;
      let isOHKO = false;
      if (rolls && rolls.length) {
        let lethal = 0;
        for (let i = 0; i < rolls.length; i++) if (rolls[i] >= hp) lethal++;
        // Deliberately NOT rounded: this is a discrete count of rolls, and 7 of 16 IS 43.75%.
        // Rounding it to 43.8 would destroy the property the number exists for (see §6.1).
        koChancePct = lethal / rolls.length * 100;
        isOHKO = lethal === rolls.length;
      } else if (minDmg >= hp) { koChancePct = 100; isOHKO = true; }
      else if (maxDmg >= hp) {
        const span = Math.max(1, maxDmg - minDmg);
        koChancePct = U.round1(Math.max(0, Math.min(100, (maxDmg - hp + 1) / span * 100)));
      }
      const average = (minDmg + maxDmg) / 2;
      let hits = 0;
      if (average > 0) hits = Math.ceil(hp / average);
      const is2HKO = !isOHKO && (maxDmg * 2 >= hp);
      return { isOHKO: isOHKO, is2HKO: is2HKO, koChancePct: koChancePct, hits: hits };
    }

    /* ------------------------------------------------------------ higher level helpers */

    /** Best (highest average percentage) damaging move of `oppMon` into `myMon`. */
    getBestIncomingThreat(oppMon, myMon, fieldState, opts) {
      const options = opts || {};
      if (!oppMon || !myMon) return null;
      const moves = options.moves || this.movesFor(oppMon, options.limit || 4);
      return this._bestOf(oppMon, myMon, moves, fieldState, options);
    }

    /** Best damaging move of my active Pokémon into the opponent's. */
    getBestOutgoingMove(myMon, oppMon, fieldState, opts) {
      const options = opts || {};
      if (!myMon || !oppMon) return null;
      const moves = options.moves || this.movesFor(myMon, options.limit || 4);
      return this._bestOf(myMon, oppMon, moves, fieldState, options);
    }

    _bestOf(atk, def, moves, fieldState, options) {
      if (!moves || !moves.length) return null;
      let best = null;
      for (let i = 0; i < moves.length; i++) {
        const name = moves[i];
        const data = U.getMoveData(name);
        if (!data || data.isStatus || !data.basePower) continue;
        const res = this.calculateDamage(atk, def, name, fieldState, options);
        if (res.failed) continue;
        if (!best || res.avgPercent > best.avgPercent) {
          best = {
            move: name,
            moveId: data.id,
            minDmg: res.minDmg, maxDmg: res.maxDmg, avgDmg: res.avgDmg,
            minPercent: res.minPercent, maxPercent: res.maxPercent, avgPercent: res.avgPercent,
            isOHKO: res.isOHKO, is2HKO: res.is2HKO, koChancePct: res.koChancePct,
            type: res.moveType, category: res.moveCategory, priority: res.priority,
            desc: res.desc
          };
        }
      }
      return best;
    }

    /** Highest average damage among an explicit move list. */
    probeCombo(atk, def, moves, fieldState, opts) {
      return this._bestOf(atk, def, moves, fieldState, opts || {});
    }

    /** Both directions at once — the shape the simulator wants every turn. */
    probeBoth(myMon, oppMon, fieldState, opts) {
      const options = opts || {};
      return {
        mine: this.getBestOutgoingMove(myMon, oppMon, fieldState, options),
        theirs: this.getBestIncomingThreat(oppMon, myMon, fieldState, options)
      };
    }

    /**
     * Does `mon` OHKO `target` with any of its plausible moves? Used by the 128D threat
     * matrix and by the veto guard. Returns the lethal move or null.
     */
    findOHKOMove(atk, target, fieldState, opts) {
      const options = opts || {};
      const moves = options.moves || this.movesFor(atk, options.limit || 4);
      for (let i = 0; i < moves.length; i++) {
        const res = this.calculateDamage(atk, target, moves[i], fieldState, options);
        if (!res.failed && res.minPercent >= 100) {
          return { move: moves[i], minPercent: res.minPercent, maxPercent: res.maxPercent, desc: res.desc };
        }
      }
      return null;
    }

    /** Speed comparison helper: does `a` move before `b` under the current field? */
    outruns(a, b, fieldState, opts) {
      const options = opts || {};
      const fs = fieldState || {};
      const my = U.computeSpeed(a, Object.assign({
        item: (options.a && options.a.item) !== undefined ? options.a.item : (a && a.item),
        ability: a && (a.ability || a.revealedAbility),
        weather: fs.weather || '',
        terrain: fs.terrain || '',
        tailwind: !!(fs.tailwind && fs.tailwind[options.aSide || 'p1'])
      }, options.a && options.a.speedOpts ? options.a.speedOpts : {}));
      const opp = U.computeSpeed(b, Object.assign({
        item: (options.b && options.b.item) !== undefined ? options.b.item : (b && b.item),
        ability: b && (b.ability || b.revealedAbility),
        weather: fs.weather || '',
        terrain: fs.terrain || '',
        tailwind: !!(fs.tailwind && fs.tailwind[options.bSide || 'p2'])
      }, options.b && options.b.speedOpts ? options.b.speedOpts : {}));
      const mvA = options.aPriority || 0;
      const mvB = options.bPriority || 0;
      return this.compareInitiative(my.effective, mvA, opp.effective, mvB, !!fs.trickRoom);
    }

    /** Initiative comparison honouring priority brackets and Trick Room inversion. */
    compareInitiative(speedA, prioA, speedB, prioB, trickRoom) {
      if (prioA !== prioB) return prioA > prioB;
      if (trickRoom) return speedA <= speedB;
      return speedA >= speedB;
    }
  }

  ST.DamageEngine = DamageEngine;
})();
