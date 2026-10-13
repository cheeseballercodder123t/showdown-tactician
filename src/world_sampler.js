/* Showdown Tactician — src/world_sampler.js
 * Determinized Perfect Information Monte Carlo sampling (Part 2, Module 8).
 *
 * Turns the partially-known opponent into K = 6 concrete, fully specified worlds by
 * sampling each Pokémon's surviving candidate set proportionally to its usage weight,
 * then *verifying* that no observed fact is violated. A world that contradicts the log is
 * discarded and resampled, so the search never plans against a Pokémon that cannot exist.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;

  // Heuristics come from src/config.js (Rule 4); the literals below are only the standalone
  // fallback used when config.js was not loaded.
  const cfg = ST.configGet || function (path, fallback) { return fallback; };
  const MAX_TEAM = cfg('sampler.maxTeam', 6);
  const MAX_RESAMPLE = cfg('sampler.maxResample', 24);
  const MIN_SET_WEIGHT = cfg('sampler.minSetWeight', 0.01);
  // Odd 32-bit stride (golden ratio) so K consecutive world seeds can never collide.
  const SEED_STRIDE = 0x9E3779B9;

  /** mulberry32 — small, fast, fully deterministic. */
  function mulberry32(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class WorldSampler {
    constructor(options) {
      options = options || {};
      this.K = options.K || cfg('sampler.K', 6);
      this.rng = options.rng || null;
      this.database = options.database || null;
      this.lastWorlds = [];
      this.stats = { sampled: 0, rejected: 0, resamples: 0 };
    }

    seededRandom(seed) { return mulberry32(seed); }

    _db() {
      if (this.database) return this.database;
      return ST.SetDatabase || null;
    }

    _setsFor(mon) {
      if (!mon) return [];
      if (mon.candidateSets && mon.candidateSets.length) return mon.candidateSets;
      if (mon.liveSet) return [mon.liveSet];
      const db = this._db();
      if (db && typeof db.forSpecies === 'function') {
        const sets = db.forSpecies(mon.species || mon.id);
        if (sets && sets.length) return sets;
        if (db.DEFAULT && db.DEFAULT.length) return db.DEFAULT;
      }
      return [];
    }

    /** Weighted pick with a supplied random function. */
    _pick(sets, rand) {
      if (!sets.length) return null;
      let total = 0;
      for (let i = 0; i < sets.length; i++) total += Math.max(0, sets[i].weight || MIN_SET_WEIGHT);
      if (total <= 0) return sets[Math.floor(rand() * sets.length) % sets.length];
      let roll = rand() * total;
      for (let i = 0; i < sets.length; i++) {
        roll -= Math.max(0, sets[i].weight || MIN_SET_WEIGHT);
        if (roll <= 0) return sets[i];
      }
      return sets[sets.length - 1];
    }

    /**
     * The species a candidate set actually puts on the field. A Mega set is stored under the
     * BASE species with the stone in `item` (see sets_db.js), so its field forme has to come
     * from the stone: without this a world sampled for a revealed Mega stood a base-forme body
     * (and every set then reported a 'species mismatch', halving the world's weight).
     */
    _setSpecies(set) {
      if (!set) return '';
      let species = set.species || '';
      if (set.isMega || U.isMegaStone(set.item)) {
        const info = U.megaSpeciesFromStone(set.item);
        if (info && info.mega) species = info.mega;
      }
      return species;
    }

    _monFromSet(base, set, index) {
      const species = this._setSpecies(set) || base.species || base.id;
      return {
        id: U.toID(species),
        species: species,
        side: base.side || 'p2',
        slot: base.slot || null,
        index: typeof base.index === 'number' ? base.index : index,
        revealed: !!base.revealed,
        level: base.level || 100,
        gender: base.gender || '',

        hp: base.hp === undefined ? 100 : base.hp,
        maxhp: 100,
        hpPercent: base.hp === undefined ? 100 : base.hp,
        fainted: !!base.fainted,
        status: base.status || '',
        statusTurns: base.statusTurns || 0,
        toxicCounter: base.toxicCounter || 0,
        boosts: Object.assign({ atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 }, base.boosts || {}),
        volatiles: Object.assign({}, base.volatiles || {}),
        terastallized: false,
        turnedThisTurn: false,

        originalArchetypeItem: set.item,
        confirmedItem: base.confirmedItem || null,
        currentBattleItem: base.confirmedItem || set.item,
        itemConsumed: !!base.itemConsumed,
        itemKnockedOff: !!base.itemKnockedOff,
        itemRemoved: !!base.itemRemoved,
        itemIsIrremovable: !!base.itemIsIrremovable,
        itemless: set.item === null,
        cannotBeChoice: !!base.cannotBeChoice,
        cannotBeBoosterEnergy: !!base.cannotBeBoosterEnergy,
        megaEvolved: !!base.megaEvolved,
        usedZMove: !!base.usedZMove,
        boosterConsumed: !!base.boosterConsumed,
        boosterActive: !!base.boosterActive,

        revealedMoves: (base.revealedMoves || []).slice(),
        activeStintMoves: (base.activeStintMoves || []).slice(),
        activeStintCount: base.activeStintCount || 0,
        movePP: Object.assign({}, base.movePP || {}),
        lastMove: base.lastMove || null,
        lastMoveTurn: base.lastMoveTurn || 0,

        revealedAbility: set.ability,
        possibleAbilities: U.getAbilities(species),

        speedFloor: base.speedFloor || 0,
        speedCeiling: base.speedCeiling || 1012,
        speedEvidence: (base.speedEvidence || []).slice(),
        speedOverride: base.speedOverride || null,

        candidateSets: [set],
        sampleds: 1,
        prunedReasons: [],
        liveSet: set,

        // Set truth the simulator and the damage engine need.
        evs: set.evs,
        ivs: set.ivs,
        nature: set.nature,
        ability: set.ability,
        item: set.item,
        setMoves: (set.moves || []).slice(),
        isTR: this._isTRSet(set),
        isActive: !!base.isActive
      };
    }

    _isTRSet(set) {
      if (!set) return false;
      const ivs = set.ivs || {};
      const evs = set.evs || {};
      const slowNature = set.nature === 'Sassy' || set.nature === 'Relaxed' || set.nature === 'Brave' || set.nature === 'Quiet';
      return (ivs.spe === 0 && (slowNature || (evs.spe || 0) <= 4));
    }

    _rand() {
      if (typeof this.rng === 'function') return this.rng();
      return Math.random();
    }

    /**
     * Deterministic 32-bit signature of everything the position has revealed. Two calls on the
     * same state MUST produce the same worlds — that is what "determinized" means — so the
     * seeds are derived from this signature instead of Math.random().
     */
    _observationSignature(state) {
      const st = state || {};
      const f = st.field || {};
      const parts = ['t' + (st.turn || 0),
        'w' + (f.weather || '') + '|' + (f.terrain || '') + '|' + (f.trickRoom ? 1 : 0)];
      const team = this._oppTeam(state);
      for (let i = 0; i < team.length; i++) {
        const m = team[i];
        if (!m) { parts.push('-'); continue; }
        parts.push([
          m.id || U.toID(m.species), m.species, m.hpPercent, m.status || '', m.fainted ? 'f' : '',
          m.speedFloor | 0, m.speedCeiling === undefined ? '' : m.speedCeiling,
          m.confirmedItem || '', m.revealedAbility || '',
          m.cannotBeChoice ? 'c' : '', m.itemless ? 'i' : '',
          (m.revealedMoves || []).join('+'),
          (m.candidateSets || []).map(function (s) { return (s && (s.id || s.item)) || ''; }).join('+')
        ].join('~'));
      }
      return parts.join(';');
    }

    /** FNV-1a over the observation signature — stable, fast, never Math.random. */
    _seedFromState(state) {
      const text = this._observationSignature(state);
      let h = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return (h >>> 0) || 1;
    }

    /** sampleWorld(state, db[, seed]) -> World */
    sampleWorld(state, db, seedOverride) {
      const previousDb = this.database;
      if (db) this.database = db;
      // The swap above points the sampler at the CALLER's database for the duration of this
      // sample, so it has to be undone on the way out of EVERY exit — including the throwing one.
      // Restoring on the happy path only meant an exception from `_pick` / `_monFromSet` /
      // `_violationsFor` left the sampler bound to a database it does not own for the rest of the
      // session. (The body below is not re-indented so the fix stays a three-line diff.)
      try {
      // An explicit seed wins, then an injected rng, then the state itself. Nothing falls back
      // to Math.random(), so the same position always samples the same K worlds.
      let seed;
      if (typeof seedOverride === 'number' && seedOverride) {
        seed = (seedOverride >>> 0) || 1;
      } else if (typeof this.rng === 'function') {
        seed = (Math.floor(this._rand() * 0xffffffff) >>> 0) || 1;
      } else {
        seed = this._seedFromState(state);
      }
      const random = mulberry32(seed);
      const oppTeam = this._oppTeam(state);
      const sets = [];
      const team = [];
      const violations = [];
      const impossible = [];

      for (let i = 0; i < MAX_TEAM; i++) {
        const base = oppTeam[i];
        if (!base) continue;
        const pool = this._setsFor(base);

        // Legality is checked deterministically first: a set that violates nothing is the
        // only thing sampling can accept, so there is nothing to gamble on. MAX_RESAMPLE
        // still bounds the fallback path below.
        const legal = [];
        for (let s = 0; s < pool.length; s++) {
          if (!this._violationsFor(base, pool[s]).length) legal.push(pool[s]);
        }
        let acceptable = legal.length ? this._pick(legal, random) : null;

        if (!acceptable && pool.length && !this._speedFloorSatisfiable(base, pool)) {
          // Every candidate contradicts an observed Speed floor, so this Pokémon cannot be
          // the one standing there: drop it from the world rather than plan against a body
          // that observation already ruled out.
          impossible.push((base.species || base.id) + ': no candidate set can reach the observed Speed floor ' + (base.speedFloor | 0));
          this.stats.rejected++;
          continue;
        }

        if (!acceptable) {
          const lastSet = this._pick(pool, random);
          if (lastSet) {
            acceptable = lastSet;
            this.stats.resamples++;
            const problems = this._violationsFor(base, acceptable);
            for (let p = 0; p < problems.length; p++) violations.push(base.species + ': ' + problems[p]);
          }
        }
        if (!acceptable) {
          const dbx = this._db();
          const fallback = dbx && dbx.DEFAULT && dbx.DEFAULT.length ? dbx.DEFAULT[i % dbx.DEFAULT.length] : null;
          if (!fallback) continue;
          acceptable = fallback;
          violations.push((base.species || base.id) + ': no legal candidate set, used a generic filler');
        }
        sets.push(acceptable);
        team.push(this._monFromSet(base, acceptable, i));
      }

      const world = {
        id: 'w' + seed.toString(16),
        seed: seed,
        team: team,
        sets: sets,
        weight: 1,
        violations: violations,
        impossible: impossible
      };
      world.weight = violations.length ? (1 / (1 + violations.length)) : 1;
      this.stats.sampled++;
      if (violations.length) this.stats.rejected++;
      return world;
      } finally {
        this.database = previousDb;
      }
    }

    /** sampleWorlds(oppState, candidateSetDatabase, K) -> World[] */
    sampleWorlds(oppState, candidateSetDatabase, K) {
      const count = Math.max(1, K || this.K || 6);
      const state = oppState && oppState.oppTeam ? oppState : { oppTeam: oppState || [] };
      // Determinism (see _seedFromState): the K worlds come from the position, or from an
      // explicitly injected rng — never from Math.random(). An injected rng is still honoured
      // (one draw per world) so a caller can stream a seeded sequence, but two calls on the
      // same state never disagree.
      const seeded = typeof this.rng === 'function';
      const base = seeded ? ((Math.floor(this._rand() * 0xffffffff) >>> 0) || 1) : this._seedFromState(state);
      const worlds = [];
      for (let i = 0; i < count; i++) {
        const seed = seeded ? ((Math.floor(this._rand() * 0xffffffff) >>> 0) || 1)
          : (((base + Math.imul(i, SEED_STRIDE)) >>> 0) || 1);
        worlds.push(this.sampleWorld(state, candidateSetDatabase, seed));
      }
      // Normalise weights so the engine can pool votes without rescaling.
      let total = 0;
      for (let i = 0; i < worlds.length; i++) total += worlds[i].weight;
      if (total > 0) for (let i = 0; i < worlds.length; i++) worlds[i].weight = worlds[i].weight / total;
      this.lastWorlds = worlds;
      return worlds;
    }

    _oppTeam(state) {
      if (!state) return [];
      if (Array.isArray(state.oppTeam) && state.oppTeam.length) return state.oppTeam.slice(0, MAX_TEAM);
      if (state.active && state.active.opp) return [state.active.opp];
      return [];
    }

    /** Every observed fact this candidate set must not contradict. */
    _violationsFor(mon, set) {
      const problems = [];
      if (!mon || !set) return ['missing data'];
      const setMoves = set.moves || [];

      // Compare the forme the SET would put on the field (a Mega set resolves to its Mega
      // forme, see _setSpecies) with the forme the log observed. A mismatch is only fatal when
      // the observed forme is already a Mega/Z forme.
      const setSpecies = this._setSpecies(set) || (mon && mon.species) || '';
      if (setSpecies && mon.species && U.toID(setSpecies) !== U.toID(mon.species)) {
        if (/(-Mega|-Primal|-Z$)/.test(mon.species)) problems.push('species mismatch');
      }

      const revealed = mon.revealedMoves || [];
      for (let i = 0; i < revealed.length; i++) {
        const name = revealed[i];
        const id = U.toID(name);
        if (id === 'struggle') continue;
        const known = setMoves.some(function (m) { return U.toID(m) === id; });
        if (!known) problems.push('revealed move ' + name + ' is not on the set');
      }

      if (mon.confirmedItem && set.item !== mon.confirmedItem) {
        problems.push('confirmed item ' + mon.confirmedItem + ' but the set holds ' + (set.item || 'nothing'));
      }
      if (mon.cannotBeChoice && set.item && U.isChoiceItem(set.item)) {
        problems.push('Choice item disproved by move usage');
      }
      if (mon.cannotBeBoosterEnergy && U.isBoosterEnergy(set.item)) {
        problems.push('Booster Energy disproved by a stint without activation');
      }
      if (mon.itemless && set.item !== null) {
        problems.push('proven itemless but the set holds ' + set.item);
      }
      // itemKnockedOff means a Knock Off connected and the item did NOT leave the target.
      if (mon.itemKnockedOff && set.item && !U.isMegaStone(set.item) && !U.isZCrystal(set.item)) {
        problems.push('a removable item cannot survive Knock Off (set holds ' + set.item + ')');
      }
      if (mon.itemRemoved && !set.item) {
        problems.push('an item was knocked off, so the set cannot be itemless');
      }
      if (mon.megaEvolved && !set.isMega) problems.push('Mega Evolved without a Mega Stone');
      if (mon.usedZMove && !set.isZCrystal) problems.push('used a Z-Move without a Z-Crystal');
      if (mon.speedFloor > 0) {
        const maxSpeed = this._maxSpeed(set);
        if (maxSpeed < mon.speedFloor) {
          problems.push('max Speed ' + maxSpeed + ' is below the observed floor ' + mon.speedFloor);
        }
      }
      if (mon.speedCeiling && mon.speedFloor && this._minSpeed(set) > mon.speedCeiling) {
        problems.push('min Speed above the observed ceiling');
      }
      return problems;
    }

    /** Can ANY candidate set reach this mon's observed Speed floor? */
    _speedFloorSatisfiable(mon, pool) {
      const floor = mon && mon.speedFloor ? mon.speedFloor : 0;
      if (!floor) return true;
      for (let i = 0; i < pool.length; i++) {
        if (this._maxSpeed(pool[i]) >= floor) return true;
      }
      return false;
    }

    _maxSpeed(set) {
      if (!set) return 0;
      const abilityId = U.toID(set.ability);
      const speed = U.computeSpeed(set, {
        item: set.item,
        ability: set.ability,
        paradoxSpeedBoost: U.PARADOX_ABILITIES.has(abilityId) && U.isBoosterEnergy(set.item)
      });
      return speed.effective;
    }

    _minSpeed(set) {
      if (!set) return 0;
      const ivs = Object.assign({}, U.DEFAULT_IVS, set.ivs || {});
      const bs = U.baseStats(set.species);
      return U.calcStat('spe', { base: bs.spe, iv: ivs.spe, ev: 0, level: 100, nature: set.nature });
    }

    /** verifyWorld(world, state) -> string[] (empty means the world obeys every observation). */
    verifyWorld(world, state) {
      const problems = [];
      if (!world || !world.team) return ['no world'];
      const oppTeam = this._oppTeam(state);
      for (let i = 0; i < world.team.length; i++) {
        const sampled = world.team[i];
        const base = oppTeam.find(function (m) { return m && U.toID(m.species || m.id) === U.toID(sampled.species); }) || oppTeam[i];
        if (!base) continue;
        const setProblems = this._violationsFor(base, sampled.liveSet);
        for (let p = 0; p < setProblems.length; p++) problems.push(sampled.species + ': ' + setProblems[p]);
      }
      return problems;
    }
  }

  WorldSampler.mulberry32 = mulberry32;
  WorldSampler.MAX_RESAMPLE = MAX_RESAMPLE;

  ST.WorldSampler = WorldSampler;
})();
