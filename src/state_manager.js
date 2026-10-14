/* Showdown Tactician — src/state_manager.js
 * The single source of truth. Consumes ProtocolParser semantic events (see ARCHITECTURE.md
 * section 2) and maintains BattleState exactly as specified in shapes 1.1 / 1.3 / 1.4.
 *
 * Additive fields beyond shape 1.1 (needed by calc_engine / world_sampler / pruner and
 * documented here because the shape in ARCHITECTURE.md is a subset):
 *   evs, ivs, nature, ability, item, declaredItem, stats, setMoves, isTR,
 *   itemEvidence[], itemRuledOut[], itemlessArchetype, paradox fields
 *     (paradoxStintActive, paradoxActivatedThisStint, paradoxBlacklistReason)
 * Everything else matches the frozen contract.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;
  const {
    toID, clamp, clampStat, deepClone, round1, debug
  } = U;

  // Heuristics come from src/config.js (Rule 4); the literals below are only the standalone
  // fallback used when config.js was not loaded.
  const cfg = ST.configGet || function (path, fallback) { return fallback; };
  const MAX_ACTIVE_STINTS = cfg('state.maxActiveStints', 8);
  // Multi-forme names a base-species lookup is allowed to resolve to (`Abomasnow` ->
  // `Abomasnow-Mega`). Everything else must match exactly: `Ursaluna` must never resolve to
  // `Ursaluna-Bloodmoon` just because one name is a prefix of the other.
  const FORME_SUFFIX_RE = /(mega[xy]?|primal)$/;
  // Forced pseudo-moves: no PP, no item, never on a set. They must not count as "a second
  // distinct move in this stint" for the Choice-lock deduction.
  const FORCED_MOVE_IDS = new Set(['struggle']);

  /**
   * Which stat a `|-start|…|protosynthesis<stat>` / `quarkdrive<stat>` frame names, or null when
   * the line is not one of those. @pkmn/sim emits the suffix on the ACTIVATION only
   * (`|-start|p1a: Iron Valiant|quarkdrivespe`) and the bare, capitalised ability on the end
   * (`|-end|p1a: Iron Valiant|Quark Drive`), so the two are parsed differently and both are cheap.
   */
  const BOOSTER_STAT_RE = /^(protosynthesis|quarkdrive)(atk|def|spa|spd|spe)$/;
  function boosterStatOf(effect) {
    const m = BOOSTER_STAT_RE.exec(String(effect || '').trim().toLowerCase());
    return m ? m[2] : null;
  }

  const VOLATILE_KEYS = [
    ['Substitute', 'substitute'],
    ['Leech Seed', 'leechseed'],
    ['Encore', 'encore'],
    ['Taunt', 'taunt'],
    ['Disable', 'disable'],
    ['confusion', 'confusion'],
    ['Trapped', 'trappedvolatile'],
    ['Ingrain', 'ingrain'],
    ['Salt Cure', 'saltcure'],
    ['Curse', 'cursed'],
    ['Yawn', 'yawn'],
    ['Attract', 'attract']
  ];

  const HAZARD_EFFECTS = [
    { match: /stealth rock/i, key: 'rocks', kind: 'bool' },
    { match: /sticky web/i, key: 'stickyweb', kind: 'bool' },
    { match: /steel spikes/i, key: 'steelspikes', kind: 'count', max: 2 },
    { match: /toxic spikes/i, key: 'toxicspikes', kind: 'count', max: 2 },
    { match: /spikes/i, key: 'spikes', kind: 'count', max: 3 }
  ];

  const SCREEN_EFFECTS = [
    { match: /reflect/i, key: 'reflect', exclude: /light|aurora/i },
    { match: /light screen/i, key: 'lightscreen' },
    { match: /aurora veil/i, key: 'auroraveil' }
  ];

  const WEATHER_ALIASES = {
    sunnyday: 'sun', sun: 'sun', desolateland: 'harshsun', harshsunshine: 'harshsun',
    raindance: 'rain', rain: 'rain', primordialsea: 'heavyrain', heavyrain: 'heavyrain',
    sandstorm: 'sandstorm', snow: 'snow', hail: 'snow', snowscape: 'snow', chillyreception: 'snow'
  };
  const TERRAIN_ALIASES = {
    electricterrain: 'electric', psychicterrain: 'psychic', grassyterrain: 'grassy',
    mistyterrain: 'misty', electric: 'electric', psychic: 'psychic', grassy: 'grassy', misty: 'misty'
  };

  function slotLetter(i) { return String.fromCharCode(97 + i); }
  function sideOf(slot) { return String(slot || '').slice(0, 2) || ''; }
  function letterIndex(slot) {
    const ch = String(slot || '').slice(2, 3);
    if (!ch) return 0;
    return Math.max(0, Math.min(5, ch.charCodeAt(0) - 97));
  }
  function otherSide(side) { return side === 'p1' ? 'p2' : 'p1'; }

  /** 'p2a: Great Tusk' -> { side:'p2', slot:'p2a', name:'Great Tusk' } */
  function parseIdent(ident) {
    const s = String(ident || '');
    const colon = s.indexOf(':');
    const slotPart = (colon === -1 ? s : s.slice(0, colon)).trim();
    const name = colon === -1 ? '' : s.slice(colon + 1).trim();
    const side = slotPart.slice(0, 2);
    const slot = /^p[12][a-f]$/.test(slotPart) ? slotPart : (side.length === 2 ? side : '');
    return { slot: slot, side: side, name: name };
  }

  /**
   * Do these details describe a Mega/Primal FORME (not a species that merely contains the
   * letters)? 'Abomasnow-Mega', 'Abomasnow-Mega-Y' and 'Groudon-Primal' qualify; 'Meganium'
   * must not, or a plain switch-in would latch the format's Mega lock and wrongly rule out
   * every opponent Mega Stone.
   */
  function isMegaDetails(details) {
    const s = String(details === undefined || details === null ? '' : details);
    return /(^|[-\s])(mega|primal)($|[-\s,])/i.test(s);
  }

  /** '100/100' | '51/100 brn' | '0 fnt' -> { hp, status, fainted } */
  function parseHPString(input) {
    const out = { hp: null, status: '', fainted: false };
    if (input === null || input === undefined || input === '') return out;
    const s = String(input).trim();
    if (/fnt/i.test(s)) { out.hp = 0; out.fainted = true; return out; }
    const m = s.match(/^(\d+)\s*\/\s*(\d+)\s*(.*)$/);
    if (m) {
      const cur = parseInt(m[1], 10), max = parseInt(m[2], 10);
      out.hp = max > 0 ? clamp(Math.round((cur / max) * 100), 0, 100) : 0;
      out.status = (m[3] || '').trim().slice(0, 3);
    } else if (/^\d+$/.test(s)) {
      out.hp = clamp(parseInt(s, 10), 0, 100);
    }
    if (out.hp === 0) out.fainted = true;
    return out;
  }

  function normalizeStatus(status) {
    if (!status) return '';
    const s = String(status).toLowerCase().trim();
    if (s === 'psn' || s === 'poison') return 'psn';
    if (s === 'tox' || s === 'poisoned' || s === 'toxic' || s === 'toxin') return 'tox';
    if (s === 'brn' || s === 'burn' || s === 'burned') return 'brn';
    if (s === 'par' || s === 'paralysis' || s === 'paralyzed') return 'par';
    if (s === 'slp' || s === 'sleep' || s === 'asleep') return 'slp';
    if (s === 'frz' || s === 'freeze' || s === 'frozen') return 'frz';
    return '';
  }

  function emptyHazards() { return { rocks: false, spikes: 0, toxicspikes: 0, stickyweb: false, steelspikes: 0 }; }
  function emptyScreens() { return { reflect: false, lightscreen: false, auroraveil: false }; }

  class BattleStateManager {
    constructor(options) {
      const opts = options || {};
      this.opts = { debug: false, maxLog: cfg('state.maxLog', 200) };
      this.opts.debug = !!opts.debug;
      this.opts.maxLog = typeof opts.maxLog === 'number' ? opts.maxLog : cfg('state.maxLog', 200);
      this.pruner = opts.pruner || null;
      this.parser = null;
      this._listeners = { change: [], turn: [], request: [], speedfloor: [] };
      this._unsubscribe = null;
      /* Connection-level state that a battle reset must NOT throw away. */
      this._parsedTeam = null;   // the TeamParser output, replayed by reset()
      this._sawInit = false;     // whether a battle has already been opened on this connection
      this.state = this._createState();
    }

    /* ------------------------------------------------------------ construction */

    _createState() {
      return {
        revision: 0,
        format: U.FORMAT,
        formatSupported: true,
        terastallizationBanned: true,
        turn: 0,
        mySide: 'p1',
        oppSide: 'p2',
        // Ladder ratings, straight off the protocol's `|player|p2|Name|avatar|1480` line. This is
        // the opponent's own number, not an estimate: nothing in the engine invents it. Read by
        // the Elo-adaptive switch prior (src/opponent_clock.js), which ships off until measured.
        myRating: null,
        opponentRating: null,
        myTeam: [],
        oppTeam: [],
        field: {
          turn: 0,
          trickRoom: false,
          trickRoomTurnsLeft: 0,
          weather: '',
          weatherTurnsLeft: null,
          terrain: '',
          terrainTurnsLeft: null,
          hazards: { p1: emptyHazards(), p2: emptyHazards() },
          screens: { p1: emptyScreens(), p2: emptyScreens() },
          tailwind: { p1: false, p2: false },
          gravity: false
        },
        formatLocks: {
          oppHasMegaEvolved: false,
          oppHasUsedZMove: false,
          oppMegasRemaining: 0,
          oppHasMegaStone: false,
          myMegaAvailable: false,
          myZMoveAvailable: false
        },
        active: { my: null, opp: null },
        bench: { my: [], opp: [] },
        recoveryPP: {},
        // Move accuracy, straight from the client's own dex via the `|stacc|` snapshot
        // (ARCHITECTURE §6.5). A number, or `true` for a move that cannot miss.
        moveAccuracy: {},
        protect: {
          oppTurnsSinceLastProtect: 99, oppConsecutiveProtects: 0, oppLastProtectTurn: -99,
          myTurnsSinceLastProtect: 99, myConsecutiveProtects: 0, myLastProtectTurn: -99,
          oppProtectedLastTurn: false
        },
        request: null,
        legalActions: { moves: [], switches: [], trapped: false, forceSwitch: false, forId: null },
        history: { turns: [], events: [] },
        log: [],
        result: null,
        teamsize: { p1: 6, p2: 6 },
        // Post-match receipt (src/content.js renders it, src/ui_overlay.js draws it). Every
        // number here is counted from the log as it arrives — nothing is estimated. `damage`
        // and `kos` are keyed by mon id and cover BOTH sides, so the MVP line and the "who
        // nearly died" line come from the same tally.
        battleStats: {
          damage: {},          // monId -> total percent of the opponent's HP it removed
          kos: {},             // monId -> bodies it has taken off the board
          trActiveTurns: 0,    // |turn| headers with Trick Room up
          trAttackTurns: 0,    // ...of those, turns OUR side actually attacked in
          snowTurns: 0,        // turns with snow/hail up (Abomasnow's Def boost)
          magicBounce: 0,      // Magic Bounce activations (a reflected hazard)
          bestHit: null        // our hardest single hit: { turn, monId, moveId, percent }
        },
        // internal: the last mon to damage each slot, consumed by |faint| to credit the KO
        _lastDamager: {},
        // internal bookkeeping (not part of the frozen shape but harmless / documented)
        _trSetOnTurn: null,
        _seenTeraWarning: false
      };
    }

    _newMon(species, side, index, opts) {
      const info = U.getSpecies(species);
      const canonical = (info && info.name) || species || 'Unknown';
      const o = opts || {};
      return {
        id: toID(canonical),
        species: canonical,
        side: side,
        slot: o.slot || null,
        index: typeof index === 'number' ? index : 0,
        revealed: o.revealed !== false,
        level: o.level || 100,
        gender: o.gender || '',

        hp: o.hp === undefined || o.hp === null ? 100 : o.hp,
        maxhp: 100,
        hpPercent: o.hp === undefined || o.hp === null ? 100 : o.hp,
        fainted: !!o.fainted,
        status: o.status || '',
        statusTurns: 0,
        toxicCounter: 0,
        boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
        volatiles: {
          substitute: false, leechseed: false, encore: false, taunt: false,
          disable: false, confusion: false, trappedvolatile: false, ingrain: false,
          saltcure: false, cursed: false, yawn: false, attract: false
        },
        terastallized: false,
        turnedThisTurn: false,

        // Reverse damage deduction (src/set_pruner.js): every hit this mon landed on OUR side,
        // with the moves, the HP before/after and the field context needed to re-run it through
        // each candidate spread later. An observation is appended only when the defender is
        // ours (so its exact stats are known) and the attacker is theirs; the pruner decides
        // what it means. `critTurn` is the |-crit| latch for the turn (crits are recorded but
        // never used as evidence — a critical hit tells us nothing about investment).
        damageDealt: [],
        critTurn: null,

        originalArchetypeItem: null,
        confirmedItem: null,
        currentBattleItem: null,
        itemConsumed: false,
        // itemKnockedOff: a Knock Off connected and the item did NOT leave the target, so
        // the item is irremovable (Mega Stone / Z-Crystal) or the mon holds nothing.
        itemKnockedOff: false,
        // itemRemoved: an item was taken off this Pokémon (Knock Off that removed it, Trick).
        itemRemoved: false,
        // pending Knock Off bookkeeping (resolved at the next |turn|)
        knockOffTurn: null,
        knockOffSawDamage: false,
        itemIsIrremovable: false,
        itemless: false,
        cannotBeChoice: false,
        cannotBeBoosterEnergy: false,
        megaEvolved: false,
        usedZMove: false,
        boosterConsumed: false,
        boosterActive: false,
        // Fainted teammates, for Supreme Overlord / Last Respects. Refreshed by _stampFallen().
        alliesFainted: 0,
        itemEvidence: [],
        itemRuledOut: [],
        itemlessArchetype: false,

        revealedMoves: [],
        activeStintMoves: [],
        activeStintCount: 0,
        movePP: {},                   // rule 4: 8-PP recovery moves, counted down from OUR use
        // Observed PP, straight off the page's own battle object via the `|stpp|` snapshot
        // (ARCHITECTURE §6.4). `movePP` above is a derived counter for one family of moves;
        // this is the measured truth, kept separate so the two can never be confused.
        ppSnapshot: {},
        ppUsed: {},                   // how many times we have SEEN each move clicked
        lastMove: null,
        lastMoveTurn: 0,

        revealedAbility: null,
        possibleAbilities: info ? info.abilities.slice() : [],
        // Ability deduction (src/set_pruner.js). Every field here is something the protocol
        // PRINTED, not an inference: `switchedInTurn` is the turn the body entered (the window a
        // switch-in ability would have announced itself in), `groundAimedOnTurn` is the turn a
        // non-status Ground move was aimed at it, and `statusTurn` is when a status landed.
        // `groundDisproved` is set only once such a move actually CONNECTED (or grounded-only
        // hazard damage landed), never on the click alone — a miss must prove nothing.
        switchedInTurn: null,
        groundAimedOnTurn: null,
        groundDisproved: false,
        // Set when a status lands while an ability-suppressing body is on the field: a burn that
        // landed through Neutralizing Gas disproves nothing, and the Gas may be gone by the time
        // the pruner reads this.
        statusSuppressed: false,
        statusTurn: null,

        speedFloor: 0,
        speedCeiling: 1012,
        speedEvidence: [],
        speedOverride: null,
        // Residual-order relations, recorded raw (the pruner converts them into a bracket).
        residualOrderBefore: [],
        residualOrderAfter: [],

        candidateSets: [],
        prunedReasons: [],
        liveSet: null,

        isActive: false,

        // additive fields (see file header)
        evs: Object.assign({}, U.ZERO_EVS, o.evs || {}),
        ivs: Object.assign({}, U.DEFAULT_IVS, o.ivs || {}),
        nature: o.nature || '',
        ability: o.ability || '',
        item: o.item || null,
        declaredItem: o.item || null,
        stats: null,
        setMoves: (o.moves || []).slice(0, 4),
        isTR: !!o.isTR,

        // paradox tracking
        paradoxStintActive: false,
        paradoxActivatedThisStint: false,
        paradoxBlacklistReason: null,
        // WHICH stat the active Protosynthesis / Quark Drive boost is raising, from the protocol's
        // own `|-start|p1a: X|protosynthesis<stat>` / `quarkdrive<stat>` frame ('atk'|'def'|'spa'|
        // 'spd'|'spe'), or null when it has not been stated. `boosterActive` only says SOMETHING
        // is boosted -- the abilities raise the HIGHEST stat, so a Roaring Moon boosted in Attack
        // is not faster. Cleared on switch-in and on `|-end|`.
        boostedStat: null
      };
    }

    _computeStats(mon) {
      if (!mon || !mon.species) return null;
      const info = U.getSpecies(mon.species);
      if (!info) return null;
      // RULE 1: the six numbers come from @smogon/calc's own stat arithmetic, not from us.
      return U.statTable(mon.species, {
        ivs: mon.ivs, evs: mon.evs, level: mon.level, nature: mon.nature
      });
    }

    /* ------------------------------------------------------------ tiny event bus */

    on(evt, cb) {
      if (!this._listeners[evt]) this._listeners[evt] = [];
      this._listeners[evt].push(cb);
      return this;
    }
    off(evt, cb) {
      const list = this._listeners[evt];
      if (!list) return this;
      this._listeners[evt] = list.filter(function (f) { return f !== cb; });
      return this;
    }
    emit(evt, payload) {
      const list = this._listeners[evt];
      if (!list || !list.length) return false;
      for (let i = 0; i < list.length; i++) {
        try { list[i](payload, this.state); } catch (e) { debug('listener error', evt, e && e.message); }
      }
      return true;
    }
    _touch(type) {
      this.state.revision++;
      this.emit('change', { type: type || 'update', revision: this.state.revision });
    }

    /* ------------------------------------------------------------ lifecycle */

    reset() {
      this.state = this._createState();
      // The pasted team is CONNECTION-level truth (EVs/IVs/nature/item from TeamParser), not
      // battle state, so it survives a reset. Without this a reconnect would leave us with no
      // team at all and every "can I switch" answer would be wrong.
      if (this._parsedTeam && this._parsedTeam.length) this.registerMyTeam(this._parsedTeam);
      this._touch('reset');
      return this;
    }

    attachParser(parser) {
      if (!parser) return this;
      if (this._unsubscribe) { try { this._unsubscribe(); } catch (e) { /* noop */ } }
      this.parser = parser;
      const self = this;
      this._unsubscribe = parser.subscribe(function (event) { self.applyEvent(event); });
      this._refreshSpeedHint();
      return this;
    }

    /**
     * Is this the format the engine is built for? Named POSITIVELY, by allowlist.
     *
     * Showdown's LADDER calls it "[Gen 9] National Dex" — that is the literal `|init|` and `|tier|`
     * text in test_log.txt, and there is no "... OU" anywhere on the wire — while the sim's id for
     * the same format is "gen9nationaldex". All four of those names must be accepted. Everything
     * else that mentions National Dex is a DIFFERENT tier (Ubers, UU, Doubles, Monotype, a NatDex
     * OM) whose threats the set and usage data in this repo do not describe, so it must be gated
     * off.
     *
     * This replaces a rule that enumerated the tiers to REJECT ("not uu/ru/nu/pu/doubles/...") and
     * therefore failed OPEN on every sibling it had not thought of: `[Gen 9] National Dex Ubers`,
     * `gen9nationaldexubers` and `[Gen 9] National Dex Almost Any Ability` all reported supported,
     * so the engine would answer with confident ND-OU advice in a tier it was never meant for. An
     * allowlist cannot forget a tier — anything that is not the format we support is not supported.
     */
    _isSupportedFormat(name) {
      /* Normalize the decoration the protocol wraps a format name in: `[Gen 9] National Dex OU`
       * and the sim id `gen9nationaldexou` both reduce to `gen9nationaldexou`. */
      const norm = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!/^(gen\d*)?nationaldex(ou)?$/.test(norm)) return false;
      /* The engine, its dex, its move data and its weights are gen 9; a NatDex format from another
       * generation is a different game, so the generation marker has to agree when one is given. */
      const gen = (norm.match(/^gen(\d+)/) || [])[1];
      return gen === undefined || parseInt(gen, 10) === U.GEN;
    }

    setFormat(formatName) {
      const name = String(formatName || '');
      const st = this.state;
      st.format = name || st.format;
      st.formatSupported = this._isSupportedFormat(name);
      if (!name) st.formatSupported = true; // unknown header: assume supported and decide later
      this._touch('format');
      return st.formatSupported;
    }

    /* ------------------------------------------------------------ accessors */

    _teamFor(side) { return side === this.state.mySide ? this.state.myTeam : this.state.oppTeam; }

    _slotMapTeam(slot) {
      const side = sideOf(slot);
      return this._teamFor(side);
    }

    /**
     * Slot -> mon. Slots are battle-scoped ('p2a'), so a mon that switched out must have had
     * its slot released: this prefers whichever holder is actually standing there and only
     * falls back to a stale holder when nobody is (e.g. the slot's occupant just fainted).
     */
    _findBySlot(slot) {
      if (!slot) return null;
      const team = this._slotMapTeam(slot);
      let stale = null;
      for (let i = 0; i < team.length; i++) {
        const m = team[i];
        if (!m || m.slot !== slot) continue;
        if (m.isActive) return m;
        if (!stale) stale = m;
      }
      return stale;
    }

    /**
     * Resolve a species name to a team member. A base name may legitimately find its own Mega
     * forme (`Abomasnow` for `Abomasnow-Mega`), so the forme suffix is stripped from BOTH
     * sides before comparing. An unrelated forme must NOT match: `Ursaluna` used to prefix-
     * match `Ursaluna-Bloodmoon` (and `Zapdos` -> `Zapdos-Galar`, `Porygon` -> `Porygon2`,
     * `Raichu` -> `Raichu-Alola`, `Kyurem` -> `Kyurem-Black`), landing protocol events on the
     * wrong MonState and even making _onSwitch skip creating the real mon.
     */
    _findBySpecies(side, species) {
      const team = this._teamFor(side);
      const id = toID(species);
      if (!id) return null;
      const base = id.replace(FORME_SUFFIX_RE, '');
      let best = null;
      for (let i = 0; i < team.length; i++) {
        const m = team[i];
        if (!m) continue;
        if (m.id === id) return m;
        if (best) continue;
        const mid = toID(m.species) || m.id;
        if (mid === id) { best = m; continue; }
        if (base && mid.replace(FORME_SUFFIX_RE, '') === base) best = m;
      }
      return best;
    }

    getTeam(side) {
      if (side === 'my') side = this.state.mySide;
      if (side === 'opp') side = this.state.oppSide;
      return side === this.state.mySide ? this.state.myTeam : this.state.oppTeam;
    }

    getMon(side, slot) {
      if (side === 'my') side = this.state.mySide;
      if (side === 'opp') side = this.state.oppSide;
      const team = side === this.state.mySide ? this.state.myTeam : this.state.oppTeam;
      if (slot) {
        const bySlot = this._findBySlot(slot);
        if (bySlot) return bySlot;
        const idx = letterIndex(slot);
        if (team[idx] && (!team[idx].slot || team[idx].slot === slot)) return team[idx];
      }
      return null;
    }

    getActive(side) {
      if (side === 'my' || side === undefined) return this.state.active.my;
      if (side === 'opp') return this.state.active.opp;
      return side === this.state.mySide ? this.state.active.my : this.state.active.opp;
    }

    isOpponentSpeedAtLeast(value) {
      const opp = this.state.active.opp;
      if (!opp) return false;
      return typeof value === 'number' && opp.speedFloor >= value;
    }

    /** Deep clone of the public BattleState, used by the sampler / simulator. */
    snapshot() {
      const clone = deepClone(this.state);
      clone.myTeam = clone.myTeam.map(this._reviveMon);
      clone.oppTeam = clone.oppTeam.map(this._reviveMon);
      return clone;
    }
    _reviveMon(m) {
      if (!m) return m;
      m.boosts = m.boosts || { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
      return m;
    }

    /* ------------------------------------------------------------ team wiring */

    /**
     * registerMyTeam(parsedMons) — ParsedMon[] from TeamParser. This is the EV/IV truth:
     * 0 Speed IVs, natures and items come from here and are never guessed again.
     */
    registerMyTeam(parsedMons) {
      const list = Array.isArray(parsedMons) ? parsedMons : [];
      /* The parsed paste is CONNECTION truth, not battle state: `reset()` re-registers from
       * this copy so a reconnect (a second `|init|`) does not cost us the EV/IV/nature data
       * that the whole engine's damage and Speed maths depends on. */
      this._parsedTeam = list.slice(0, 6);
      const st = this.state;
      st.myTeam = list.slice(0, 6).map(function (p, i) {
        const mon = this._newMon(p.species || p.name, st.mySide, i, {
          slot: null,
          level: p.level || 100,
          gender: p.gender || '',
          evs: p.evs,
          ivs: p.ivs,
          nature: p.nature,
          ability: p.ability,
          item: p.item || null,
          moves: p.moves,
          isTR: !!p.isTR
        });
        mon.revealed = true;
        // Marks the EV/IV/nature/level/item truth as coming from the pasted team.
        mon.fromPaste = true;
        mon.declaredItem = p.item || null;
        mon.item = p.item || null;
        mon.stats = this._computeStats(mon);
        if (p.nickname) mon.nickname = p.nickname;
        return mon;
      }, this);
      st.formatLocks.myMegaAvailable = st.myTeam.some(function (m) { return U.isMegaStone(m.item); });
      st.formatLocks.myZMoveAvailable = st.myTeam.some(function (m) { return U.isZCrystal(m.item); });
      this._recountOppMegas();
      this._refreshBench();
      this._touch('myteam');
      return st.myTeam;
    }

    /** Team preview roster for the opponent (and for us when no paste is loaded). */
    _registerPreviewPoke(side, index, species, details, item, hp, status, gender, level) {
      const team = this._teamFor(side);
      const tok = U.tokenizeDetails(details || species);
      const existing = this._findBySpecies(side, tok.species || species);
      if (existing) {
        existing.revealed = true;
        if (hp !== undefined && hp !== null) this._setHP(existing, hp, status);
        return existing;
      }
      // NOTE: team preview order is NOT battle slot order. Slots are only ever assigned by an
      // actual |switch| line, so a preview entry stays slotless until it really enters.
      const mon = this._newMon(tok.species || species, side, index, {
        slot: null,
        level: level || tok.level || 100,
        gender: gender || tok.gender || '',
        hp: hp,
        status: status
      });
      const realItem = item && !/^item:?$/.test(String(item).trim()) ? String(item).replace(/^item:\s*/i, '') : null;
      if (realItem && U.isItemKnown(realItem)) {
        mon.currentBattleItem = realItem;
        mon.confirmedItem = realItem;
      } else if (realItem && !U.isItemKnown(realItem)) {
        // team preview sometimes leaks the item without a readable name
        mon.currentBattleItem = realItem;
      }
      while (team.length <= index) team.push(null);
      if (!team[index]) team[index] = mon; else team.push(mon);
      this._recountOppMegas();
      this._refreshBench();
      return mon;
    }

    /* ------------------------------------------------------------ core dispatch */

    applyEvent(event) {
      if (!event || typeof event !== 'object') return this.state;
      const st = this.state;
      const type = event.type || 'unknown';
      if (event.raw) this._pushLog(event.raw);
      if (type !== 'unknown') this._pushHistory(type, event);

      switch (type) {
        case 'init': this._onInit(event); break;
        case 'player': this._onPlayer(event); break;
        case 'teamsize': this._onTeamsize(event); break;
        case 'poke': this._onPoke(event); break;
        case 'switch': this._onSwitch(event); break;
        case 'replace': this._onSwitch(event); break;
        case 'move': this._onMove(event); break;
        case 'cant': this._onCant(event); break;
        case 'boost': this._onBoost(event, 1); break;
        case 'unboost': this._onBoost(event, -1); break;
        case 'setboost': this._onSetBoost(event); break;
        case 'clearallboost': this._onClearAllBoost(); break;
        case 'clearnegativeboost': this._onClearNegativeBoost(event); break;
        case 'crit': this._onCrit(event); break;
        case 'damage': this._onHPDelta(event, 'damage'); break;
        case 'heal': this._onHPDelta(event, 'heal'); break;
        case 'sethp': this._onHPDelta(event, 'sethp'); break;
        case 'status': this._onStatus(event); break;
        case 'curestatus': this._onCureStatus(event); break;
        case 'cureteam': this._onCureTeam(event); break;
        case 'faint': this._onFaint(event); break;
        case 'item': this._onItem(event); break;
        case 'enditem': this._onEndItem(event); break;
        case 'activate': this._onActivate(event); break;
        case 'start': this._onStart(event); break;
        case 'end': this._onEnd(event); break;
        case 'sideStart': this._onSideStart(event); break;
        case 'sideEnd': this._onSideEnd(event); break;
        case 'fieldStart': this._onFieldStart(event); break;
        case 'fieldEnd': this._onFieldEnd(event); break;
        case 'weather': this._onWeather(event); break;
        case 'terrain': this._onTerrain(event); break;
        case 'turn': this._onTurn(event); break;
        case 'request': this._onRequest(event); break;
        case 'pp': this._onPp(event); break;
        case 'accuracy': this._onAccuracy(event); break;
        case 'residualorder': this._onResidualOrder(event); break;
        case 'formechange': this._onFormeChange(event); break;
        case 'detailschange': this._onDetailsChange(event); break;
        case 'terastallize': this._onTerastallize(event); break;
        case 'zpower': this._onZPower(event); break;
        case 'speedfloor': this._onSpeedFloor(event); break;
        case 'win': case 'tie': this._onEndBattle(event, type); break;
        case 'upkeep': break;
        default: break;
      }
      this._resolveKnockOffs();
      this._refreshSpeedHint();
      this._stampFallen();
      this._touch(type);
      return this.state;
    }

    /**
     * Supreme Overlord / Last Respects scale with the number of FAINTED TEAMMATES, and only
     * the state knows that count. Stamp it onto every MonState so the damage engine, the 128D
     * vector and the HUD all read one shared number instead of each guessing. Twelve compares.
     */
    _stampFallen() {
      const sides = [this.state.myTeam, this.state.oppTeam];
      for (let s = 0; s < sides.length; s++) {
        const team = sides[s] || [];
        let fallen = 0;
        for (let i = 0; i < team.length; i++) if (team[i] && team[i].fainted) fallen++;
        for (let i = 0; i < team.length; i++) {
          if (!team[i]) continue;
          team[i].alliesFainted = team[i].fainted ? Math.max(0, fallen - 1) : fallen;
        }
      }
    }

    _pushLog(raw) {
      const log = this.state.log;
      log.push(raw);
      if (log.length > this.opts.maxLog) log.splice(0, log.length - this.opts.maxLog);
    }
    _pushHistory(type, event) {
      const hist = this.state.history.events;
      hist.push({ type: type, turn: this.state.turn, line: event.raw || '' });
      if (hist.length > this.opts.maxLog) hist.splice(0, hist.length - this.opts.maxLog);
    }

    /* ------------------------------------------------------------ handlers */

    _onInit(event) {
      /* A NEW BATTLE STARTS FROM A CLEAN SLATE.
       *
       * `|init|` is the protocol's "this battle begins here" marker, and it is not sent only
       * once per page: Showdown re-sends it followed by the ENTIRE log from turn 1 whenever the
       * socket reconnects mid-battle, and a rematch in the same room re-uses the connection.
       * Replaying a log on top of the previous battle is not idempotent, and it failed in two
       * separate ways (BUGS_AUDIT_REPORT.md B17):
       *
       *   1. `|clearpoke|` parses to `unknown` and was never handled, so the previous game's
       *      previewed opponent roster survived. The engine then pruned its candidate pool
       *      against a phantom Kingambit it had never seen in this battle.
       *   2. `|-boost|`, `|-sidestart|`, Leech Seed counters and the Trick Room clock are all
       *      RELATIVE or incremental, so replaying them compounded: +1 became +2, and the
       *      hazards layer count doubled.
       *
       * Only a real `|init|` clears the board. `|format|` parses to the same event type but is
       * a header line, so it must not.
       */
      if (this._sawInit && String(event.raw || '').indexOf('|init|') === 0) this.reset();
      this._sawInit = true;
      if (event.format) this.setFormat(event.format);
    }

    _onPlayer(event) {
      if (!event.side) return;
      if (!this._playerNames) this._playerNames = {};
      this._playerNames[event.side] = event.name || '';
      if (event.rating) {
        const r = parseInt(event.rating, 10);
        if (isFinite(r)) {
          if (event.side === this.state.oppSide) this.state.opponentRating = r;
          else if (event.side === this.state.mySide) this.state.myRating = r;
        }
        debug('rating', event.side, event.rating);
      }
    }

    _onTeamsize(event) {
      if (!event.side) return;
      const size = clamp(event.size | 0, 1, 6);
      this.state.teamsize[event.side] = size;
    }

    _onPoke(event) {
      const side = event.side;
      if (!side) return;
      const team = this._teamFor(side);
      const index = team.filter(Boolean).length;
      this._registerPreviewPoke(side, index, event.species, event.details, event.item,
        event.hp, event.status, event.gender, event.level);
    }

    _onSwitch(event) {
      const ident = parseIdent(event.slot ? (event.slot + ': ' + (event.species || '')) : (event.ident || ''));
      const side = event.side || ident.side || sideOf(event.slot);
      const slot = event.slot || ident.slot;
      const details = event.details || event.species || ident.name;
      const tok = U.tokenizeDetails(details);
      if (!side || !slot) return;
      const st = this.state;

      // 1) close the stint of whatever was in that slot (paradox + item inference)
      const previous = this._findBySlot(slot);
      if (previous) this._endStint(previous, 'switch-out');

      // 2) locate or create the mon
      let mon = this._findBySpecies(side, tok.species);
      if (!mon) {
        const team = this._teamFor(side);
        mon = this._newMon(tok.species, side, letterIndex(slot), { slot: slot });
        const idx = letterIndex(slot);
        if (!team[idx]) team[idx] = mon; else team.push(mon);
      }
      mon.slot = slot;
      mon.revealed = true;
      // The pasted team owns level and gender: a protocol details string must never silently
      // retune the EV/IV/nature truth that every Speed and damage number is computed from.
      if (!mon.fromPaste) {
        mon.level = event.level || tok.level || mon.level || 100;
        mon.gender = event.gender || tok.gender || mon.gender;
      } else if (!mon.gender) {
        mon.gender = event.gender || tok.gender || '';
      }
      mon.isActive = true;
      mon.fainted = false;
      // Ability deduction: stamp the turn this body entered. A switch-in ability (Intimidate, a
      // weather/terrain surge) announces itself on this same turn or not at all, so the pruner
      // only ever reads the absence within that window. The LEAD switches arrive BEFORE `|turn|1`
      // (the server prints `|switch|p1a:`, `|switch|p2a:`, then `|turn|1`), so a stamp of 0 would
      // never match the turn the decision is actually made on: attribute those to turn 1.
      mon.switchedInTurn = st.turn > 0 ? st.turn : 1;
      if (isMegaDetails(details)) this._markMega(mon, tok.species);

      // rule 2: stint + boosts reset
      mon.activeStintMoves = [];
      mon.activeStintCount = 0;
      mon.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
      mon.volatiles = {
        substitute: false, leechseed: false, encore: false, taunt: false, disable: false,
        confusion: false, trappedvolatile: false, ingrain: false, saltcure: false, cursed: false,
        yawn: false, attract: false
      };
      mon.turnedThisTurn = false;
      mon.paradoxStintActive = U.isParadox(mon.species);
      mon.paradoxActivatedThisStint = false;
      mon.boostedStat = null;                  // a fresh stint's boost is not stated until | -start |
      this._addStint(mon, slot);

      // Nobody else may keep this slot: a benched mon that still claims 'p2a' would make
      // every later `|move|p2a:` / `|-damage|p2a:` line resolve to the wrong Pokémon.
      const sideTeam = this._teamFor(side);
      for (let i = 0; i < sideTeam.length; i++) {
        const other = sideTeam[i];
        if (!other || other === mon) continue;
        if (other.slot === slot) { other.slot = null; other.isActive = false; }
      }

      // 3) HP / status
      if (event.hp !== undefined && event.hp !== null) this._setHP(mon, event.hp, event.status);

      // 4) rule 1: Heavy-Duty Boots proof
      this._checkHeavyDutyBoots(mon, side);

      this._setActive(side, mon);
      this._refreshBench();
      this._recountOppMegas();
      debug('switch', side, slot, mon.species, 'hp=' + mon.hp);
    }

    _addStint(mon, slot) {
      this._activeStints = this._activeStints || {};
      this._activeStints[slot] = {
        species: mon.species,
        startedTurn: this.state.turn,
        moves: mon.activeStintMoves
      };
    }

    /** Called when a mon leaves the field: paradox Booster Energy inference + cleanup. */
    _endStint(mon, reason) {
      if (!mon) return;
      mon.boostedStat = null;
      if (mon.paradoxStintActive && !mon.paradoxActivatedThisStint) {
        const weather = this.state.field.weather;
        const terrain = this.state.field.terrain;
        const abilityId = toID(mon.revealedAbility || mon.ability || (mon.possibleAbilities[0] || ''));
        const neutralForAbility =
          (abilityId === 'protosynthesis' && weather !== 'sun' && weather !== 'harshsun') ||
          (abilityId === 'quarkdrive' && terrain !== 'electric') ||
          (!abilityId);
        if (neutralForAbility) {
          mon.cannotBeBoosterEnergy = true;
          mon.paradoxBlacklistReason = 'switched in under neutral conditions without Protosynthesis/Quark Drive activating';
          this._addItemEvidence(mon, 'No Booster Energy: paradox boost never activated (' + reason + ')');
        }
      }
      mon.paradoxStintActive = false;
      mon.isActive = false;
      // switching out is a non-protect action by that side: break its protect chain (rule 6)
      if (mon.side === this.state.mySide) this.state.protect.myConsecutiveProtects = 0;
      else {
        this.state.protect.oppConsecutiveProtects = 0;
        this.state.protect.oppProtectedLastTurn = false;
      }
    }

    _addItemEvidence(mon, text) {
      if (!mon || !text) return;
      if (mon.itemEvidence.indexOf(text) === -1) mon.itemEvidence.push(text);
      if (mon.itemEvidence.length > 12) mon.itemEvidence.shift();
    }

    /**
     * Can this body hold Sticky Hold?
     *
     * The ability defeats Knock Off outright, so "the item survived" stops being evidence of an
     * IRREMOVABLE item the moment the species can carry it — Muk, Gastrodon, Accelgor and friends
     * would otherwise have every removable item struck out of their candidate pool on the strength
     * of an ordinary Assault Vest. `itemKnockedOff` is what src/set_pruner.js derives its ladder
     * from and what src/world_sampler.js prunes removable items with, so the inference is withheld
     * at the source rather than patched at each reader.
     *
     * A revealed ability settles it. Otherwise the pruner's surviving pool is consulted when it is
     * populated, and the dex's own list (`U.getAbilities`, the ability boundary) when it is not.
     */
    _canHoldStickyHold(mon) {
      if (!mon) return false;
      if (mon.revealedAbility && U.toID(mon.revealedAbility) === 'stickyhold') return true;
      const abilities = (mon.possibleAbilities && mon.possibleAbilities.length)
        ? mon.possibleAbilities : U.getAbilities(mon.species);
      for (let i = 0; i < abilities.length; i++) {
        if (U.toID(abilities[i]) === 'stickyhold') return true;
      }
      return false;
    }

    /**
     * Rule 1 — hazards up + a switch-in that took no damage while holding no immunity
     * item/type/ability ⇒ confirmed Heavy-Duty Boots.
     */
    _checkHeavyDutyBoots(mon, side) {
      // Our own items are known from the pasted team: Boots inference is opponent-only.
      if (!mon || side === this.state.mySide || mon.side === this.state.mySide) return;
      const st = this.state;
      const haz = st.field.hazards[side];
      if (!haz) return;
      const anyHazard = haz.rocks || haz.spikes > 0 || haz.toxicspikes > 0 || haz.steelspikes > 0;
      if (!anyHazard) return;
      const info = U.getSpecies(mon.species);
      const item = mon.currentBattleItem || mon.confirmedItem || mon.item;
      if (U.isChoiceItem(item) || U.isMegaStone(item) || U.isZCrystal(item)) return;
      const immuneByType = U.isFlyingType(mon.species);
      const abilityId = toID(mon.revealedAbility || mon.ability || (info && info.abilities[0] || ''));
      const immuneByAbility = abilityId === 'levitate';
      const immuneByItem = toID(item) === 'airballoon';
      if (immuneByType || immuneByAbility || immuneByItem) return;
      const expected = U.hazardPercent(mon.species, null, null, haz);
      if (expected <= 0) return;
      if (mon.hp === 100 && !mon.itemKnockedOff && !mon.itemConsumed && !mon.itemRemoved) {
        mon.confirmedItem = 'Heavy-Duty Boots';
        mon.currentBattleItem = 'Heavy-Duty Boots';
        mon.itemless = false;
        mon.itemConsumed = false;
        this._addItemEvidence(mon, 'Boots confirmed: entered at 100% through ' + this._hazardSummary(haz));
      }
    }

    _hazardSummary(haz) {
      const bits = [];
      if (haz.rocks) bits.push('Stealth Rock');
      if (haz.spikes) bits.push(haz.spikes + ' Spikes');
      if (haz.toxicspikes) bits.push(haz.toxicspikes + ' Toxic Spikes');
      if (haz.stickyweb) bits.push('Sticky Web');
      return bits.join(' + ') || 'hazards';
    }

    _setActive(side, mon) {
      if (side === this.state.mySide) this.state.active.my = mon;
      else this.state.active.opp = mon;
    }

    _refreshBench() {
      const st = this.state;
      st.bench.my = st.myTeam.filter(function (m) { return m && !m.isActive && !m.fainted; });
      st.bench.opp = st.oppTeam.filter(function (m) { return m && !m.isActive && !m.fainted; });
    }

    _setHP(mon, hpInput, status) {
      if (!mon) return;
      const parsed = parseHPString(hpInput);
      if (parsed.hp !== null) {
        mon.hp = parsed.hp;
        mon.hpPercent = parsed.hp;
      }
      mon.maxhp = 100;
      let statusChanged = false;
      if (status !== undefined && status !== null && status !== '') {
        const st = normalizeStatus(status);
        if (st && st !== mon.status) { mon.status = st; mon.statusTurns = 0; statusChanged = true; }
      } else if (parsed.status) {
        const st = normalizeStatus(parsed.status);
        if (st && st !== mon.status) { mon.status = st; mon.statusTurns = 0; statusChanged = true; }
      }
      // A status can also arrive on an hp field (`|switch|...|100/100|brn`), so the suppression
      // stamp belongs here too, not only in _onStatus.
      if (statusChanged && this._abilitiesSuppressed()) mon.statusSuppressed = true;
      if (parsed.fainted || mon.hp === 0) {
        mon.fainted = true;
        mon.hp = 0;
        mon.hpPercent = 0;
      } else if (parsed.hp !== null && parsed.hp > 0 && mon.fainted) {
        // A heal that lands on a fainted body is a Revival Blessing (legal in this format):
        // HP came back, so the faint latch has to clear. Without this the mon stayed
        // `fainted` at 52% HP — an illegal state that poisons the alive counts, the bench and
        // every _stampFallen bound.
        mon.fainted = false;
      }
      if (mon.status === 'tox') mon.toxicCounter = Math.max(1, mon.statusTurns + 1);
    }

    _onMove(event) {
      const side = event.side || sideOf(event.slot);
      const slot = event.slot;
      const mon = this._findBySlot(slot) || this._findBySpecies(side, event.species);
      if (!mon) return;
      const moveName = event.move || '';
      const moveId = event.moveId || toID(moveName);
      // Receipt: a turn of Trick Room OUR side actually attacked in. A hard switch under TR is
      // exactly the turn the receipt is meant to expose as wasted, so it is not counted here.
      if (this.state.field.trickRoom && side === this.state.mySide) this.state.battleStats.trAttackTurns++;
      mon.lastMove = moveName;
      mon.lastMoveTurn = this.state.turn;
      mon.turnedThisTurn = true;
      if (moveName && mon.revealedMoves.indexOf(moveName) === -1) mon.revealedMoves.push(moveName);

      // new active mon we have never seen (e.g. missed switch line)
      if (!mon.isActive) { mon.isActive = true; this._setActive(side, mon); }

      // stint tracking (rule 3). Struggle is a forced pseudo-move, so it must not enter the
      // stint: otherwise one real move plus Struggle reads as "2 distinct moves" and the
      // pruner permanently blacklists every Choice item for that mon.
      // Observed PP usage: one click of a move is one PP, whether or not the page ever handed
      // us a snapshot. This is the fallback the gauge prints as "used N times".
      if (moveId && !FORCED_MOVE_IDS.has(moveId)) {
        mon.ppUsed[moveId] = (mon.ppUsed[moveId] || 0) + 1;
      }
      if (moveName && !FORCED_MOVE_IDS.has(moveId) && mon.activeStintMoves.indexOf(moveName) === -1) {
        mon.activeStintMoves.push(moveName);
        if (mon.activeStintMoves.length > MAX_ACTIVE_STINTS) mon.activeStintMoves.shift();
      }
      mon.activeStintCount = mon.activeStintMoves.length;
      if (mon.activeStintCount === 1 && !mon.originalArchetypeItem) {
        // First move of the stint: adopt the item of the currently believed set as the
        // working hypothesis (never invented here — only read from the pruner's survivors).
        const live = mon.liveSet || mon.candidateSets[0] || null;
        if (live && live.item) mon.originalArchetypeItem = live.item;
      }
      if (mon.activeStintCount >= 2 && mon.originalArchetypeItem) {
        mon.originalArchetypeItem = null;
        this._addItemEvidence(mon, 'Used ' + mon.activeStintCount + ' different moves in one stint: item is not Choice-locked');
      }

      // recovery PP (rule 4)
      if (U.is8PPRecoveryMove(moveId)) {
        const key = slot + ':' + moveId;
        const st = this.state;
        if (typeof st.recoveryPP[key] !== 'number') st.recoveryPP[key] = 8;
        st.recoveryPP[key] = Math.max(0, st.recoveryPP[key] - 1);
        if (typeof mon.movePP[moveId] !== 'number') mon.movePP[moveId] = 8;
        mon.movePP[moveId] = Math.max(0, mon.movePP[moveId] - 1);
      }

      // Knock Off bookkeeping (rule: damage without -enditem ⇒ irremovable / itemless).
      // Only the fact that the move connected is recorded here; the verdict is reached in
      // _resolveKnockOffs once the turn has moved on without an |-enditem| for the target.
      if (moveId === 'knockoff' && event.targetSlot) {
        const target = this._findBySlot(event.targetSlot);
        if (target && target !== mon) {
          target.knockOffTurn = this.state.turn;
          target.knockOffSawDamage = false;
        }
      }

      // Ability deduction: remember that a non-status GROUND move was aimed at a target THIS
      // turn. The move line says only that it was clicked, so the turn stamp is what the damage
      // handler cross-checks before drawing any conclusion — a miss leaves a stamp the next turn
      // cannot match, so it can never disprove Levitate.
      if (moveId && event.targetSlot) {
        const aimTarget = this._findBySlot(event.targetSlot);
        const aimData = U.getMoveData(moveName);
        // ...and the ATTACKER's ability, which decides whether the observation could ever prove
        // anything: a Mold Breaker / Teravolt / Turboblaze Ground move connects straight through
        // Levitate and Earth Eater, so aiming one is not evidence against them. Only a KNOWN
        // ability is consulted (our own team's, or one already revealed); an unrevealed attacker
        // is treated as not ignoring — see the residual note on the ground rule in
        // src/set_pruner.js.
        const attackerAbility = toID(mon.revealedAbility || mon.ability || '');
        if (aimTarget && aimTarget !== mon && aimData && aimData.type === 'Ground' && !aimData.isStatus &&
            !U.ABILITY_IGNORING_ABILITIES.has(attackerAbility)) {
          aimTarget.groundAimedOnTurn = this.state.turn;
        }
      }

      // protect rhythm (rule 6)
      if (event.isZ || moveId === 'maxguard') this._markZMove(side, mon);
      this._trackProtect(side, moveId);

      // Trick Room used by anyone: latch the turn it was set
      if (moveId === 'trickroom') {
        this.state.field.trickRoom = true;
        this.state.field.trickRoomTurnsLeft = 5;
        this.state._trSetOnTurn = this.state.turn;
      }
      debug('move', side, slot, moveName, 'stint=' + mon.activeStintCount);
    }

    _onCant(event) {
      const side = event.side || sideOf(event.slot);
      const mon = this._findBySlot(event.slot);
      if (!mon) return;
      mon.turnedThisTurn = true;
      // a failed action is a non-protect action: it breaks the stall rhythm chain (rule 6)
      if (side === this.state.mySide) this.state.protect.myConsecutiveProtects = 0;
      else {
        this.state.protect.oppConsecutiveProtects = 0;
        this.state.protect.oppProtectedLastTurn = false;
      }
      const reason = String(event.reason || '');
      if (/par/i.test(reason)) this._addItemEvidence(mon, 'Fully paralysed on turn ' + this.state.turn);
      if (side === this.state.oppSide && /slp/i.test(reason)) mon.speedEvidence.push('Asleep: cannot act');
    }

    _onBoost(event, sign) {
      const mon = this._findBySlot(event.slot);
      if (!mon) return;
      const stat = String(event.stat || '').toLowerCase();
      const key = stat === 'spa' ? 'spa' : stat === 'spd' ? 'spd' : stat === 'spe' ? 'spe'
        : stat === 'atk' ? 'atk' : stat === 'def' ? 'def'
          : stat === 'accuracy' ? 'accuracy' : stat === 'evasion' ? 'evasion' : null;
      if (!key) return;
      const amount = Math.abs(event.amount || 1) * (sign < 0 ? -1 : 1);
      mon.boosts[key] = clampStat(mon.boosts[key] + amount);
    }

    _onSetBoost(event) {
      const mon = this._findBySlot(event.slot);
      if (!mon) return;
      const stat = String(event.stat || '').toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(mon.boosts, stat)) return;
      mon.boosts[stat] = clampStat(event.amount || 0);
    }

    _onClearAllBoost() {
      const all = this.state.myTeam.concat(this.state.oppTeam);
      for (let i = 0; i < all.length; i++) {
        if (!all[i]) continue;
        all[i].boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
      }
    }

    _onClearNegativeBoost(event) {
      const mon = this._findBySlot(event.slot);
      if (!mon) return;
      U.STATS.forEach(function (s) { if (mon.boosts[s] < 0) mon.boosts[s] = 0; });
      if (mon.boosts.accuracy < 0) mon.boosts.accuracy = 0;
      if (mon.boosts.evasion < 0) mon.boosts.evasion = 0;
    }

    _onHPDelta(event, kind) {
      const side = event.side || sideOf(event.slot);
      const mon = this._findBySlot(event.slot) || this._findBySpecies(side, event.species);
      if (!mon) return;
      const from = String(event.from || '');
      // Capture the pre-hit HP before _setHP overwrites it: the difference IS the damage roll we
      // are about to reason from, and it only exists for this instant.
      const hpBefore = typeof mon.hpPercent === 'number' ? mon.hpPercent : 100;
      this._setHP(mon, event.hp, event.status);
      if (kind === 'damage') {
        this._recordDamageObservation(event, mon, side, hpBefore, from);
        this._creditDamage(event, mon, side, hpBefore, from);
      }
      if (kind === 'damage') {
        // Ability deduction (src/set_pruner.js): this body took damage only a GROUNDED body can
        // take, which disproves the airborne/absorbing abilities. Two sources: a Ground move that
        // connected this turn (cross-checked against the stamp _onMove set), and hazard damage
        // that skips airborne bodies (Spikes / Sticky Web — deliberately NOT Stealth Rock, which
        // hits everything). Gravity grounds everyone, so under it the observation proves nothing
        // and the flag is left alone; the pruner re-checks that guard before it eliminates.
        // `from` is the protocol's own `[from] ...` clause, and a DIRECT hit does not carry one.
        // That distinction is the whole rule: the damage line alone does not say what caused it,
        // so a burn tick, sandstorm, Leech Seed, hazard or recoil landing in the same turn the
        // Ground move was aimed would otherwise be read as "the Ground move connected" and
        // eliminate Levitate on evidence that never touched it. Gravity grounds everyone and
        // negates Levitate, so under it NEITHER observation proves anything — gated here as well
        // as at prune time, because the flag is a permanent latch and a conclusion drawn under
        // Gravity would outlive it.
        const gravityUp = !!(this.state.field && this.state.field.gravity);
        if (!gravityUp && !from && mon.groundAimedOnTurn === this.state.turn) mon.groundDisproved = true;
        if (!gravityUp && /spikes|sticky web/i.test(from)) {
          mon.groundDisproved = true;
        }
        if (/stealth rock|spikes|sticky web/i.test(from)) {
          if (mon.itemRuledOut.indexOf('Heavy-Duty Boots') === -1) mon.itemRuledOut.push('Heavy-Duty Boots');
          mon.confirmedItem = mon.confirmedItem === 'Heavy-Duty Boots' ? null : mon.confirmedItem;
          mon.currentBattleItem = mon.currentBattleItem === 'Heavy-Duty Boots' ? null : mon.currentBattleItem;
          this._addItemEvidence(mon, 'Took ' + from.replace(/^\[from\]\s*/, '') + ' damage: no Heavy-Duty Boots');
        }
        if (/trick|swap/i.test(from)) { /* handled by item events */ }
        // A DIRECT hit only, for exactly the reason the ground rule demands one: `from` is the
        // protocol's own `[from] ...` clause and a direct hit carries none, so a residual tick (a
        // burn, sandstorm, Leech Seed, hazard or recoil) cannot stand in for the move landing.
        // Without this test a Knock Off into a Protect or a miss, plus the target's burn tick in
        // the same turn, reads as "Knock Off connected" and _resolveKnockOffs concludes the item
        // is irremovable or absent — a HARD verdict that prunes the pool to itemless / Z / Mega
        // sets for the rest of the battle.
        if (mon.knockOffTurn === this.state.turn && !from) mon.knockOffSawDamage = true;
      }
      if (kind === 'heal' && /sys|item: leftovers|item: black sludge|item: shell bell/i.test(from)) {
        mon.turnedThisTurn = false;
      }
    }

    /**
     * Receipt bookkeeping for one damaging line, independent of the pruner's evidence rule:
     * every hit is credited to the attacker (both sides), the turn's last damager is remembered
     * so |faint| can attribute the KO, and OUR hardest single hit so far is kept for the card.
     * Never throws: a battle log always contains damage this does not model.
     */
    _creditDamage(event, victim, victimSide, hpBefore, from) {
      if (!victim || !victimSide) return;
      const hpAfter = typeof victim.hpPercent === 'number' ? victim.hpPercent : 0;
      const percent = Math.round((hpBefore - hpAfter) * 10) / 10;
      if (!(percent > 0)) return;
      const raw = String(event.raw || '');
      const moveMatch = /move:\s*([^\[\]]*?)(?=\s*\[|$)/i.exec(from) ||
        /move:\s*([^\[\]]*?)(?=\s*\[|$)/i.exec(raw);
      let attacker = null;
      let ident = parseIdent(event.ofRaw || '');
      if (!ident.side) {
        const fallback = /\[of\]\s*(p[12][a-f]):\s*([^\[\]]*)/i.exec(raw);
        if (fallback) ident = { side: fallback[1].slice(0, 2), slot: fallback[1].toLowerCase(), name: (fallback[2] || '').trim() };
      }
      if (ident.side && ident.side !== victimSide) {
        attacker = this._findBySlot(ident.slot) || this._findBySpecies(ident.side, ident.name);
      }
      if (!attacker) return;
      const stats = this.state.battleStats;
      stats.damage[attacker.id] = Math.round(((stats.damage[attacker.id] || 0) + percent) * 10) / 10;
      if (victim.slot) this.state._lastDamager[victim.slot] = attacker.id;
      const moveId = moveMatch ? toID(moveMatch[1].trim()) : '';
      if (attacker.side === this.state.mySide) {
        const best = stats.bestHit;
        if (!best || percent > best.percent) {
          stats.bestHit = { turn: this.state.turn, monId: attacker.id, moveId: moveId, percent: percent };
        }
      }
    }

    /** |-crit| — a critical hit landed. Recorded so a hit can be EXCLUDED from the evidence. */
    _onCrit(event) {
      const side = event.side || sideOf(event.slot);
      const mon = this._findBySlot(event.slot) || this._findBySpecies(side, event.species);
      if (!mon) return;
      mon.critTurn = this.state.turn;
    }

    /**
     * Reverse damage deduction, the observation half (the pruner owns the verdict).
     *
     * A `|-damage|p1a: Slowking|68/100|[from] move: Make It Rain|[of] p2a: Gholdengo` line on
     * OUR body is a measurement of the ATTACKER's offence: we know our own spread exactly, so
     * their candidate spreads can be tested against the number we just took. Stored on the
     * attacker, not the victim, because that is whose candidate pool the pruner will narrow.
     *
     * Deliberately conservative: residual/recoil/hazard damage carries no `move:` clause and is
     * ignored, only our own side is ever used as the ruler, and a critical hit is flagged rather
     * than trusted. Anything this cannot model (weather, a screen, a boost) is stored alongside
     * the number so the pruner can rebuild the exact context instead of guessing at it.
     */
    _recordDamageObservation(event, defender, defenderSide, hpBefore, from) {
      if (!defender) return;
      if (defenderSide !== this.state.mySide) return;          // only our body can be the ruler
      // `from` is the parsed clause list; fall back to the raw line so a shape the clause
      // splitter has never seen still yields its move name instead of silently dropping the
      // observation. The attacker ident gets the same treatment.
      const raw = String(event.raw || '');
      const moveMatch = /move:\s*([^\[\]]*?)(?=\s*\[|$)/i.exec(from) ||
        /move:\s*([^\[\]]*?)(?=\s*\[|$)/i.exec(raw);
      if (!moveMatch) return;                                  // hazards, recoil, Life Orb, ...
      const moveName = moveMatch[1].trim();
      const moveId = toID(moveName);
      if (!moveId || moveId === 'struggle') return;
      let attackerIdent = parseIdent(event.ofRaw || '');
      if (!attackerIdent.side) {
        const fallback = /\[of\]\s*(p[12][a-f]):\s*([^\[\]]*)/i.exec(raw);
        if (fallback) attackerIdent = { side: fallback[1].slice(0, 2), slot: fallback[1].toLowerCase(), name: (fallback[2] || '').trim() };
      }
      if (!attackerIdent.side || attackerIdent.side === defenderSide) return;
      const attacker = this._findBySlot(attackerIdent.slot) || this._findBySpecies(attackerIdent.side, attackerIdent.name);
      if (!attacker) return;                                   // an attacker we never saw: nothing to prune
      const hpAfter = typeof defender.hpPercent === 'number' ? defender.hpPercent : 0;
      const damagePercent = Math.round((hpBefore - hpAfter) * 10) / 10;
      if (!(damagePercent > 0)) return;
      if (!Array.isArray(attacker.damageDealt)) attacker.damageDealt = [];
      const max = cfg('pruner.damageEvidence.maxObservations', 8);
      const obs = {
        turn: this.state.turn,
        moveName: moveName,
        moveId: moveId,
        damagePercent: damagePercent,
        hpBefore: hpBefore,
        hpAfter: hpAfter,
        // |-crit| latches on the mon that TOOK the critical hit — our defender here. Reading it
        // off the attacker (as the first draft did) left the flag permanently false.
        crit: defender.critTurn === this.state.turn,
        attackerIsP1: attacker.side === 'p1',
        defenderId: defender.id,
        defenderSlot: defender.slot,
        defenderBoosts: Object.assign({}, defender.boosts || {}),
        defenderStatus: defender.status || '',
        weather: (this.state.field && this.state.field.weather) || '',
        terrain: (this.state.field && this.state.field.terrain) || '',
        sig: this.state.turn + ':' + moveId + ':' + damagePercent + ':' + (defender.critTurn === this.state.turn ? 'crit' : '')
      };
      // An identical signature means we are re-reading the same hit (a mirrored poll line);
      // appending it twice would double-weight one measurement.
      for (let i = 0; i < attacker.damageDealt.length; i++) {
        if (attacker.damageDealt[i] && attacker.damageDealt[i].sig === obs.sig) return;
      }
      attacker.damageDealt.push(obs);
      while (attacker.damageDealt.length > max) attacker.damageDealt.shift();
      this._addItemEvidence(attacker, 'Dealt ' + damagePercent + '% to ' + defender.species + ' with ' + moveName);
    }

    /**
     * Ability deduction (src/set_pruner.js). Is an ability-suppressing body on the field RIGHT
     * NOW? Neutralizing Gas is the one the protocol lets us see (its own activation line is
     * printed), and while it is up every OTHER ability is inert — so a status it allowed proves
     * nothing about Water Veil, Thermal Exchange, Comatose or Purifying Salt. The pruner re-derives
     * the same fact for the absence rule; this copy exists so it can be stamped at the instant a
     * status lands, when the answer is still the one that mattered.
     */
    _abilitiesSuppressed() {
      const teams = [this.state.myTeam, this.state.oppTeam];
      for (let t = 0; t < teams.length; t++) {
        const team = teams[t];
        if (!Array.isArray(team)) continue;
        for (let i = 0; i < team.length; i++) {
          const m = team[i];
          if (m && m.isActive && toID(m.revealedAbility || '') === 'neutralizinggas') return true;
        }
      }
      return false;
    }

    _onStatus(event) {
      const mon = this._findBySlot(event.slot);
      if (!mon) return;
      const st = normalizeStatus(event.status);
      if (!st) return;
      mon.status = st;
      mon.statusTurns = 0;
      mon.statusTurn = this.state.turn;
      if (this._abilitiesSuppressed()) mon.statusSuppressed = true;
      if (st === 'tox') mon.toxicCounter = 1;
      if (st === 'slp') this._addItemEvidence(mon, 'Slept: offensive pressure delayed');
    }

    _onCureStatus(event) {
      const mon = this._findBySlot(event.slot);
      if (!mon) return;
      mon.status = '';
      mon.statusTurns = 0;
      mon.toxicCounter = 0;
    }

    _onCureTeam(event) {
      const side = event.side || sideOf(event.slot);
      const team = this._teamFor(side);
      for (let i = 0; i < team.length; i++) {
        if (!team[i]) continue;
        team[i].status = '';
        team[i].statusTurns = 0;
        team[i].toxicCounter = 0;
      }
    }

    _onFaint(event) {
      const side = event.side || sideOf(event.slot);
      const mon = this._findBySlot(event.slot) || this._findBySpecies(side, event.species);
      if (!mon) return;
      // Credit the KO to whoever landed the last hit on that slot. Showdown sends a lone
      // `|faint|` per body, so this is the one place a knockout is counted; the `0 fnt` damage
      // line that precedes it must NOT count it twice.
      const killerId = mon.slot ? this.state._lastDamager[mon.slot] : null;
      if (killerId) {
        const stats = this.state.battleStats;
        stats.kos[killerId] = (stats.kos[killerId] || 0) + 1;
        delete this.state._lastDamager[mon.slot];
      }
      mon.fainted = true;
      mon.hp = 0;
      mon.hpPercent = 0;
      mon.status = '';
      mon.isActive = false;
      this._endStint(mon, 'faint');
      // The fainted Pokémon is still the one standing in that slot until a replacement
      // |switch| line arrives: the banner, the evaluator and the veto guard all keep reading
      // `active.<side>` as "what I am facing right now", so it must not be nulled here.
      const isMine = side === this.state.mySide;
      const active = isMine ? this.state.active.my : this.state.active.opp;
      if (!active || active === mon) this._setActive(side, mon);
      this._refreshBench();
      this._stampFallen();
    }

    /** |-item| — reveals (and Trick swaps) items. */
    _onItem(event) {
      const side = event.side || sideOf(event.slot);
      const mon = this._findBySlot(event.slot) || this._findBySpecies(side, event.species);
      if (!mon) return;
      const item = String(event.item || '').replace(/^item:\s*/i, '').trim();
      if (!item) return;
      mon.currentBattleItem = item;
      mon.confirmedItem = item;
      mon.declaredItem = mon.declaredItem || item;
      mon.itemKnockedOff = false;
      mon.itemless = false;
      if (U.isMegaStone(item) || U.isZCrystal(item)) mon.itemIsIrremovable = true;
      if (U.isChoiceItem(item)) {
        mon.originalArchetypeItem = mon.originalArchetypeItem || item;
      }
      if (U.isBoosterEnergy(item)) {
        mon.boosterActive = true;
        mon.paradoxActivatedThisStint = true;
        mon.cannotBeBoosterEnergy = false;
      }
      const from = String(event.from || '');
      if (/trick|switcheroo|bestow/i.test(from) && event.ofSide) {
        const source = this._findBySlot(event.ofSlot) || this._findBySpecies(event.ofSide, event.ofSpecies);
        if (source && source !== mon) {
          source.currentBattleItem = null;
          source.confirmedItem = null;
          this._addItemEvidence(source, 'Item Tricked away to ' + mon.species);
        }
      }
      this._addItemEvidence(mon, 'Item revealed: ' + item + (from ? ' (' + from.replace(/^\[from\]\s*/, '') + ')' : ''));
      debug('item', mon.species, item, from);
    }

    /** |-enditem| — Knock Off, popped Air Balloon, Focus Sash, Booster Energy, Berries. */
    _onEndItem(event) {
      const side = event.side || sideOf(event.slot);
      const mon = this._findBySlot(event.slot) || this._findBySpecies(side, event.species);
      if (!mon) return;
      const item = String(event.item || '').replace(/^item:\s*/i, '').trim();
      const reason = String(event.reason || '');
      if (/knock off/i.test(reason)) {
        // The item left the target: its identity is now known and it was removable. (A Knock
        // Off that removes NOTHING is the opposite signal and lands in _resolveKnockOffs.)
        mon.itemRemoved = true;
        mon.knockOffTurn = null;
        mon.knockOffSawDamage = false;
        if (item && mon.itemRuledOut.indexOf(item) === -1) mon.itemRuledOut.push(item);
        this._addItemEvidence(mon, 'Item knocked off: ' + (item || 'unknown'));
      } else {
        mon.itemConsumed = true;
        this._addItemEvidence(mon, 'Item consumed: ' + (item || 'unknown') + (reason ? ' (' + reason.replace(/^\[from\]\s*/, '') + ')' : ''));
      }
      if (U.isBoosterEnergy(item)) {
        mon.boosterConsumed = true;
        mon.boosterActive = false;
        mon.paradoxActivatedThisStint = true;
      }
      if (U.isChoiceItem(item)) mon.itemConsumed = true;
      mon.currentBattleItem = null;
      if (mon.confirmedItem === item) mon.confirmedItem = null;
      if (mon.declaredItem === item) mon.declaredItem = null;
      if (item && mon.itemRuledOut.indexOf(item) === -1) mon.itemRuledOut.push(item);
    }

    /**
     * A Knock Off that connected, dealt damage and produced no |-enditem| by the time the
     * turn ended proves the target's item could not be removed: a Mega Stone / Z-Crystal, or
     * a genuinely itemless set (Acrobatics / Unburden). A KO or a Substitute hit teaches us
     * nothing and is skipped — Knock Off does not remove the item of a Pokémon it knocks out.
     */
    _resolveKnockOffs() {
      const st = this.state;
      const all = st.myTeam.concat(st.oppTeam);
      for (let i = 0; i < all.length; i++) {
        const mon = all[i];
        if (!mon || mon.knockOffTurn === null || mon.knockOffTurn === undefined) continue;
        if (mon.knockOffTurn >= st.turn) continue;   // same turn: an |-enditem| may still arrive
        const sawDamage = !!mon.knockOffSawDamage;
        const fainted = !!mon.fainted;
        mon.knockOffTurn = null;
        mon.knockOffSawDamage = false;
        if (fainted || !sawDamage || mon.itemKnockedOff || mon.itemRemoved) continue;
        // Sticky Hold produces this exact observation without the item being irremovable, so the
        // deduction is not sound for a body that can carry it: the sampler prices those worlds.
        if (this._canHoldStickyHold(mon)) {
          this._addItemEvidence(mon, 'Knock Off dealt damage with no -enditem, but ' + mon.species +
            ' can hold Sticky Hold: the surviving item is not evidence of an irremovable one');
          continue;
        }
        mon.itemKnockedOff = true;
        this._addItemEvidence(mon, 'Knock Off dealt damage with no -enditem: item is irremovable or absent');
      }
    }

    _onActivate(event) {
      const side = event.side || sideOf(event.slot);
      const mon = this._findBySlot(event.slot) || this._findBySpecies(side, event.species);
      // Receipt counter, taken BEFORE the mon lookup so an activation on a body we have not
      // tracked yet is still tallied. Both the |-ability| and |-activate| shapes land here.
      if (/magic bounce/i.test(String(event.effect || event.effectName || ''))) this.state.battleStats.magicBounce++;
      if (!mon) return;
      const effect = String(event.effect || '');
      const abilityMatch = effect.match(/ability:\s*(.+)$/i);
      if (abilityMatch) {
        const ability = abilityMatch[1].trim();
        mon.revealedAbility = ability;
        mon.ability = mon.ability || ability;
        if (U.PARADOX_ABILITIES.has(toID(ability))) {
          mon.boosterActive = true;
          mon.paradoxActivatedThisStint = true;
        }
      }
      // |-mega| / |-primal| carry `megaKind` ('mega' | 'primal'), so no substring guessing.
      if (event.megaKind) this._markMega(mon, event.megaForme || event.baseSpecies);
      if (/z-?power|z-move/i.test(effect)) this._markZMove(side, mon);
      if (/item:\s*booster energy/i.test(effect)) {
        mon.boosterActive = true;
        mon.paradoxActivatedThisStint = true;
        mon.confirmedItem = 'Booster Energy';
      }
      if (/item:\s*air balloon/i.test(effect)) mon.currentBattleItem = mon.currentBattleItem || 'Air Balloon';
      const args = event.args || [];
      for (let i = 0; i < args.length; i++) this._addItemEvidence(mon, 'Activated: ' + args[i]);
    }

    _onStart(event) {
      const mon = this._findBySlot(event.slot);
      if (!mon) return;
      const effect = String(event.effect || '');
      const lower = effect.toLowerCase();
      for (let i = 0; i < VOLATILE_KEYS.length; i++) {
        if (lower.indexOf(VOLATILE_KEYS[i][0].toLowerCase()) !== -1) {
          mon.volatiles[VOLATILE_KEYS[i][1]] = true;
        }
      }
      if (/protect|bunker|shield/i.test(effect) && /\bon\b/i.test(effect)) {
        /* `Start of turn N: X is protected` handled through the move event */
      }
      if (/salt cure/i.test(effect)) mon.volatiles.saltcure = true;
      // The sim STATES which stat the boost moved: `|-start|p2a: Roaring Moon|protosynthesisatk`.
      // That suffix is the only evidence of a SPEED boost; `boosterActive` alone is not, because
      // an Attack- or Special-Attack-boosted body is no faster at all. See boosterStatOf.
      const boosted = boosterStatOf(effect);
      if (boosted) mon.boostedStat = boosted;
    }

    _onEnd(event) {
      const mon = this._findBySlot(event.slot);
      if (!mon) return;
      const effect = String(event.effect || '');
      const lower = effect.toLowerCase();
      // `|-end|p1a: Great Tusk|Protosynthesis|[silent]` -- the boost ends and the stat is unknown
      // again, so a later stint cannot inherit this one's Speed reading. The end frame carries the
      // bare ability name (capitalised, no stat suffix), unlike the activation.
      if (lower.indexOf('protosynthesis') !== -1 || lower.indexOf('quarkdrive') !== -1) mon.boostedStat = null;
      for (let i = 0; i < VOLATILE_KEYS.length; i++) {
        if (lower.indexOf(VOLATILE_KEYS[i][0].toLowerCase()) !== -1) {
          mon.volatiles[VOLATILE_KEYS[i][1]] = false;
        }
      }
    }

    _onSideStart(event) {
      const side = this._sideFromEvent(event);
      if (!side) return;
      const effect = String(event.effect || '');
      const haz = this.state.field.hazards[side];
      const scr = this.state.field.screens[side];
      let matched = false;
      for (let i = 0; i < HAZARD_EFFECTS.length; i++) {
        const h = HAZARD_EFFECTS[i];
        if (!h.match.test(effect)) continue;
        if (h.kind === 'bool') haz[h.key] = true;
        else haz[h.key] = clamp((haz[h.key] | 0) + 1, 0, h.max);
        matched = true;
        break;
      }
      for (let i = 0; i < SCREEN_EFFECTS.length; i++) {
        const s = SCREEN_EFFECTS[i];
        if (s.match.test(effect) && !(s.exclude && s.exclude.test(effect))) { scr[s.key] = true; matched = true; }
      }
      if (/tailwind/i.test(effect)) { this.state.field.tailwind[side] = true; matched = true; }
      if (/gravity/i.test(effect)) { this.state.field.gravity = true; matched = true; }
      debug('sideStart', side, effect, matched ? '' : '(unmatched)');
    }

    _onSideEnd(event) {
      const side = this._sideFromEvent(event);
      if (!side) return;
      const effect = String(event.effect || '');
      const haz = this.state.field.hazards[side];
      const scr = this.state.field.screens[side];
      if (/stealth rock/i.test(effect)) haz.rocks = false;
      if (/sticky web/i.test(effect)) haz.stickyweb = false;
      if (/steel spikes/i.test(effect)) haz.steelspikes = 0;
      if (/toxic spikes/i.test(effect)) haz.toxicspikes = 0;
      else if (/spikes/i.test(effect)) { haz.spikes = 0; haz.steelspikes = 0; }
      if (/reflect/i.test(effect) && !/light|aurora/i.test(effect)) scr.reflect = false;
      if (/light screen/i.test(effect)) scr.lightscreen = false;
      if (/aurora veil/i.test(effect)) scr.auroraveil = false;
      if (/tailwind/i.test(effect)) this.state.field.tailwind[side] = false;
      if (/gravity/i.test(effect)) this.state.field.gravity = false;
      // Defog / Court Change emit a single generic sideend
      if (!/stealth|spikes|web|reflect|screen|veil|tailwind|gravity/i.test(effect)) {
        this.state.field.hazards[side] = emptyHazards();
        this.state.field.screens[side] = emptyScreens();
      }
    }

    _sideFromEvent(event) {
      const raw = event.side || event.slot || '';
      const s = String(raw).slice(0, 2);
      if (s === 'p1' || s === 'p2') return s;
      const m = String(event.effect || '').match(/^(p[12])/);
      return m ? m[1] : null;
    }

    _onFieldStart(event) {
      const effect = String(event.effect || '');
      const args = event.args || [];
      const full = effect + ' ' + args.join(' ');
      const st = this.state;
      if (/trick room/i.test(full)) {
        st.field.trickRoom = true;
        st.field.trickRoomTurnsLeft = 5;
        st._trSetOnTurn = st.turn;
      }
      const weather = this._weatherFromEffect(full);
      if (weather) {
        st.field.weather = weather;
        st.field.weatherTurnsLeft = 5; // 5 is the standard duration; rocks extend it to 8 unmodelled
      }
      const terrain = this._terrainFromEffect(full);
      if (terrain) {
        st.field.terrain = terrain;
        st.field.terrainTurnsLeft = 5;
      }
      if (/gravity/i.test(full)) st.field.gravity = true;
      if (/electric terrain/i.test(full)) st.field.terrain = 'electric';
      if (/misty terrain/i.test(full)) st.field.terrain = 'misty';
      if (/grassy terrain/i.test(full)) st.field.terrain = 'grassy';
      if (/psychic terrain/i.test(full)) st.field.terrain = 'psychic';
      debug('fieldStart', effect);
    }

    _weatherFromEffect(text) {
      const lower = String(text).toLowerCase();
      const candidates = [
        ['harsh sunshine', 'harshsun'], ['extremely harsh', 'harshsun'], ['desolate land', 'harshsun'],
        ['heavy rain', 'heavyrain'], ['primordial sea', 'heavyrain'],
        ['sandstorm', 'sandstorm'], ['snow', 'snow'], ['hail', 'snow'], ['snowscape', 'snow'],
        ['sunny day', 'sun'], ['raindance', 'rain'], ['rain dance', 'rain'], ['sun', 'sun'], ['rain', 'rain']
      ];
      for (let i = 0; i < candidates.length; i++) {
        if (lower.indexOf(candidates[i][0]) !== -1) return candidates[i][1];
      }
      return null;
    }

    _terrainFromEffect(text) {
      const lower = String(text).toLowerCase();
      if (lower.indexOf('electric terrain') !== -1) return 'electric';
      if (lower.indexOf('psychic terrain') !== -1) return 'psychic';
      if (lower.indexOf('grassy terrain') !== -1) return 'grassy';
      if (lower.indexOf('misty terrain') !== -1) return 'misty';
      return null;
    }

    _onFieldEnd(event) {
      const effect = String(event.effect || '');
      const st = this.state;
      if (/trick room/i.test(effect)) {
        st.field.trickRoom = false;
        st.field.trickRoomTurnsLeft = 0;
        st._trSetOnTurn = null;
      }
      if (/weather|sun|rain|sand|snow|hail/i.test(effect)) {
        st.field.weather = '';
        st.field.weatherTurnsLeft = null;
      }
      if (/terrain/i.test(effect)) {
        st.field.terrain = '';
        st.field.terrainTurnsLeft = null;
      }
      if (/gravity/i.test(effect)) st.field.gravity = false;
    }

    _onWeather(event) {
      const raw = String(event.weather || '');
      const st = this.state;
      if (!raw) {
        st.field.weather = '';
        st.field.weatherTurnsLeft = null;
        return;
      }
      const alias = WEATHER_ALIASES[toID(raw)] || toID(raw);
      st.field.weather = alias || '';
      st.field.weatherTurnsLeft = alias ? 5 : null;
    }

    _onTerrain(event) {
      const raw = String(event.terrain || '');
      const st = this.state;
      if (!raw) { st.field.terrain = ''; st.field.terrainTurnsLeft = null; return; }
      const alias = TERRAIN_ALIASES[toID(raw)] || toID(raw);
      st.field.terrain = alias || '';
      st.field.terrainTurnsLeft = alias ? 5 : null;
    }

    /** |turn| — the clock: TR countdown, weather, protect rhythm, status timers. */
    _onTurn(event) {
      const st = this.state;
      const n = typeof event.turn === 'number' ? event.turn : (st.turn + 1);
      st.turn = n;
      st.field.turn = n;

      if (st.field.trickRoom) {
        const setOn = st._trSetOnTurn;
        if (setOn !== null && setOn !== undefined && n > setOn) {
          st.field.trickRoomTurnsLeft = Math.max(0, st.field.trickRoomTurnsLeft - 1);
          if (st.field.trickRoomTurnsLeft === 0) st.field.trickRoom = false;
        }
      }
      if (typeof st.field.weatherTurnsLeft === 'number' && st.field.weatherTurnsLeft > 0) {
        st.field.weatherTurnsLeft = Math.max(0, st.field.weatherTurnsLeft - 1);
        if (st.field.weatherTurnsLeft === 0) st.field.weather = '';
      }
      if (typeof st.field.terrainTurnsLeft === 'number' && st.field.terrainTurnsLeft > 0) {
        st.field.terrainTurnsLeft = Math.max(0, st.field.terrainTurnsLeft - 1);
        if (st.field.terrainTurnsLeft === 0) st.field.terrain = '';
      }

      // NOTE: ConsecutiveProtects is deliberately NOT reset here. It decays through rule 6:
      // a non-protect move (or a failed action) by that side resets its own counter, which is
      // what the 0.67 / 0.89 Protect-decay model in tempo_vector.js is built on.
      st.protect.oppProtectedLastTurn = st.protect.oppTurnsSinceLastProtect === 0;
      st.protect.oppTurnsSinceLastProtect = clamp(st.protect.oppTurnsSinceLastProtect + 1, 0, 999);
      st.protect.myTurnsSinceLastProtect = clamp(st.protect.myTurnsSinceLastProtect + 1, 0, 999);

      const all = st.myTeam.concat(st.oppTeam);
      for (let i = 0; i < all.length; i++) {
        const m = all[i];
        if (!m) continue;
        m.turnedThisTurn = false;
        if (m.status) m.statusTurns++;
        if (m.status === 'tox') m.toxicCounter = Math.max(1, m.statusTurns);
      }

      // Receipt counters, read from the state the turn actually starts with.
      if (st.field.trickRoom) st.battleStats.trActiveTurns++;
      if (st.field.weather === 'snow' || st.field.weather === 'hail') st.battleStats.snowTurns++;

      st.history.turns.push({
        turn: n,
        weather: st.field.weather,
        terrain: st.field.terrain,
        trickRoom: st.field.trickRoom,
        trickRoomTurnsLeft: st.field.trickRoomTurnsLeft,
        my: this._turnSummary(st.active.my),
        opp: this._turnSummary(st.active.opp)
      });
      if (st.history.turns.length > 60) st.history.turns.shift();

      this.emit('turn', { turn: n });
      if (this.pruner && typeof this.pruner.onTurn === 'function') {
        try { this.pruner.onTurn(this.state); } catch (e) { debug('pruner.onTurn failed', e && e.message); }
      }
    }

    _turnSummary(mon) {
      if (!mon) return null;
      return { species: mon.species, hp: mon.hp, status: mon.status, boosts: deepClone(mon.boosts) };
    }

    /** |request| — the decision point: legal actions + our own team refresh. */
    _onRequest(event) {
      const json = event.json;
      if (!json || typeof json !== 'object') return;
      const st = this.state;
      st.request = json;

      if (json.side && json.side.id) {
        st.mySide = json.side.id;
        st.oppSide = otherSide(json.side.id);
      }
      if (json.teamPreview) st.teamPreview = true;
      else st.teamPreview = false;

      // refresh our own roster (hp / status / moves) from the authoritative payload
      if (json.side && Array.isArray(json.side.pokemon)) {
        this._mergeMyTeamFromRequest(json.side.pokemon);
      }

      const actions = { moves: [], switches: [], trapped: false, forceSwitch: false };
      const active = Array.isArray(json.active) ? json.active[0] : null;
      if (active) {
        actions.trapped = !!active.trapped;
        const moves = Array.isArray(active.moves) ? active.moves : [];
        for (let i = 0; i < moves.length; i++) {
          const mv = moves[i];
          if (!mv || mv.disabled && /no moves/i.test(String(mv.disabledReason || ''))) continue;
          if (mv.move === 'Struggle' && moves.length > 1) { /* keep */ }
          actions.moves.push({
            id: mv.id || toID(mv.move),
            name: mv.move || '',
            pp: typeof mv.pp === 'number' ? mv.pp : null,
            maxpp: typeof mv.maxpp === 'number' ? mv.maxpp : null,
            target: mv.target || 'normal',
            disabled: !!mv.disabled,
            disabledReason: mv.disabledReason || '',
            isZ: !!mv.zMove,
            zMoveName: mv.zMove || null,
            isMax: !!mv.maxMove
          });
        }
        if (active.canMegaEvo) st.formatLocks.myMegaAvailable = true;
        if (active.canZMove && active.canZMove.length) st.formatLocks.myZMoveAvailable = true;
        else if (Array.isArray(active.canZMove)) st.formatLocks.myZMoveAvailable = false;
      }
      if (Array.isArray(json.forceSwitch) && json.forceSwitch.some(Boolean)) {
        actions.forceSwitch = true;
      }
      if (json.wait) {
        st.legalActions = { moves: [], switches: [], trapped: false, forceSwitch: false, wait: true, forId: null };
        st.waiting = true;
        return;
      }
      st.waiting = false;

      // switches: every healthy, non-active, untrapped bench member
      const team = st.myTeam;
      for (let i = 0; i < team.length; i++) {
        const m = team[i];
        if (!m || m.fainted) continue;
        if (m.isActive) continue;
        if (m.hp === 0) continue;
        actions.switches.push({
          id: m.id,
          name: m.species,
          slot: m.slot || (st.mySide + slotLetter(m.index))
        });
      }
      // WHICH body this request is about. `st.active.my` moves on, but these numbers are a
      // snapshot of one body's move list: a switch in the log with no request after it (a real
      // pattern in a fast log) would otherwise leave them describing the body that just left,
      // and any reader that pairs them with the incoming body is describing two Pokemon at once.
      const forMon = (st.myTeam || []).filter(function (m) { return m && m.isActive; })[0] || null;
      actions.forId = forMon ? toID(forMon.id || forMon.species) : null;
      st.legalActions = actions;

      // the request is the authoritative moment to refresh the speed hint
      this._refreshSpeedHint();
      this.emit('request', { request: json, legalActions: actions });
      debug('request', 'moves=' + actions.moves.length, 'switches=' + actions.switches.length, 'forceSwitch=' + actions.forceSwitch);
    }

    _mergeMyTeamFromRequest(pokemonList) {
      const st = this.state;
      for (let i = 0; i < pokemonList.length; i++) {
        const p = pokemonList[i];
        if (!p) continue;
        const ident = parseIdent(p.ident || '');
        const tok = U.tokenizeDetails(p.details || '');
        let mon = ident.slot ? this._findBySlot(ident.slot) : null;
        if (!mon) mon = this._findBySpecies(st.mySide, tok.species);
        if (!mon) {
          mon = this._newMon(tok.species, st.mySide, st.myTeam.length, { slot: ident.slot || null });
          mon.revealed = true;
          st.myTeam.push(mon);
        }
        if (ident.slot) mon.slot = ident.slot;
        this._setHP(mon, p.condition || p.hp || '');
        mon.isActive = !!p.active;
        if (!mon.fromPaste) mon.level = tok.level || mon.level;
        if (p.item) mon.item = mon.item || p.item;
        if (p.ability) mon.ability = mon.ability || p.ability;
        if (Array.isArray(p.moves) && p.moves.length) {
          mon.setMoves = p.moves.slice(0, 4);
          for (let k = 0; k < p.moves.length; k++) {
            const mid = p.moves[k];
            if (typeof mon.movePP[mid] !== 'number' && U.is8PPRecoveryMove(mid)) mon.movePP[mid] = 8;
          }
        }
        if (p.baseAbility && !mon.ability) mon.ability = p.baseAbility;
      }
      for (let i = 0; i < st.myTeam.length; i++) {
        const m = st.myTeam[i];
        if (!m) continue;
        if (m.isActive) this._setActive(st.mySide, m);
      }
      this._refreshBench();
      this._recountOppMegas();
    }

    _onFormeChange(event) {
      this._onDetailsChange(event);
    }

    _onDetailsChange(event) {
      const side = event.side || sideOf(event.slot);
      const mon = this._findBySlot(event.slot) || this._findBySpecies(side, event.species);
      const details = event.details || event.species || '';
      if (isMegaDetails(details)) {
        if (mon) this._markMega(mon, U.tokenizeDetails(details).species);
        else this._markMegaByName(side, details);
      }
      if (!mon) return;
      const tok = U.tokenizeDetails(details);
      if (tok.species) {
        mon.species = tok.species;
        mon.id = toID(tok.species);
      }
      if (event.hp !== undefined && event.hp !== null) this._setHP(mon, event.hp, event.status);
    }

    _markMegaByName(side, details) {
      const tok = U.tokenizeDetails(details);
      const mon = this._findBySpecies(side, (tok.species || '').replace(/-Mega.*$/i, ''));
      if (mon) this._markMega(mon, tok.species);
    }

    /**
     * rule 5 — the Mega evolution latch.
     *
     * `forme` is the name the mon is standing in after the evolution ('Abomasnow-Mega'), from
     * the |-mega| line or from a switch-in details string. A Mega forme has different base
     * stats and often a different typing, so the Species has to follow it: otherwise every
     * stat, Speed and damage lookup silently keeps using the base Pokémon for the rest of the
     * battle. Showdown sends no separate |detailschange| line for a Mega, so this is the only
     * place the forme can be adopted.
     */
    _markMega(mon, forme) {
      if (!mon) return;
      mon.megaEvolved = true;
      // The turn it happened, for the format sentinel's "BURNED (X, turn N)" line.
      if (!mon.megaTurn) mon.megaTurn = this.state.turn;
      const name = String(forme === undefined || forme === null ? '' : forme).trim();
      const info = name ? U.getSpecies(name) : null;
      if (info && info.name && toID(info.name) !== toID(mon.species)) {
        const was = mon.species;
        mon.species = info.name;
        mon.id = toID(info.name);
        this._addItemEvidence(mon, 'Mega forme adopted: ' + was + ' -> ' + info.name);
      }
      const st = this.state;
      if (mon.side === st.oppSide) {
        st.formatLocks.oppHasMegaEvolved = true;
        this._addItemEvidence(mon, 'Mega Evolved on turn ' + st.turn + ': all other opponent Mega Stones are impossible');
        if (this.pruner && typeof this.pruner.applyFormatLockCascade === 'function') {
          try { this.pruner.applyFormatLockCascade(st); } catch (e) { debug('cascade failed', e && e.message); }
        }
      }
      this._recountOppMegas();
    }

    _markZMove(side, mon) {
      if (mon) {
        mon.usedZMove = true;
        if (!mon.zMoveTurn) mon.zMoveTurn = this.state.turn;
      }
      const st = this.state;
      if (side === st.oppSide) {
        st.formatLocks.oppHasUsedZMove = true;
        if (this.pruner && typeof this.pruner.applyFormatLockCascade === 'function') {
          try { this.pruner.applyFormatLockCascade(st); } catch (e) { debug('cascade failed', e && e.message); }
        }
      } else if (side === st.mySide) {
        st.formatLocks.myZMoveAvailable = false;
      }
    }

    _onZPower(event) {
      const side = event.side || sideOf(event.slot);
      const mon = this._findBySlot(event.slot) || this._findBySpecies(side, event.species);
      this._markZMove(side, mon);
    }

    _onTerastallize(event) {
      const mon = this._findBySlot(event.slot);
      if (mon) {
        mon.terastallized = true;
        mon.teraType = event.type || '';
      }
      if (!this.state._seenTeraWarning) {
        this.state._seenTeraWarning = true;
        debug('WARNING: Terastallization observed in a format where it is banned: ' +
          (event.species || '') + ' -> ' + (event.type || ''));
      }
    }

    /** rule 6 — protect rhythm tracking. */
    _trackProtect(side, moveId) {
      const st = this.state;
      const isMine = side === st.mySide;
      const isProtect = U.PROTECT_MOVES.has(moveId);
      if (isProtect) {
        if (isMine) {
          st.protect.myConsecutiveProtects++;
          st.protect.myTurnsSinceLastProtect = 0;
          st.protect.myLastProtectTurn = st.turn;
        } else {
          st.protect.oppConsecutiveProtects++;
          st.protect.oppTurnsSinceLastProtect = 0;
          st.protect.oppLastProtectTurn = st.turn;
          st.protect.oppProtectedLastTurn = true;
        }
      } else {
        if (isMine) st.protect.myConsecutiveProtects = 0;
        else {
          st.protect.oppConsecutiveProtects = 0;
          st.protect.oppProtectedLastTurn = false;
        }
      }
    }

    /** rule 7 + speed inference plumbing. */
    _onSpeedFloor(event) {
      const value = typeof event.value === 'number' ? event.value : 0;
      if (!value) return;
      const side = event.side || this.state.oppSide;
      // Prefer the mon the event names (slot, then species) and only then whatever is active:
      // writing the floor onto the wrong Pokémon silently corrupts every later speed filter.
      const mon = (event.slot ? this._findBySlot(event.slot) : null) ||
        (event.species ? this._findBySpecies(side, event.species) : null) ||
        (side === this.state.oppSide ? this.state.active.opp : this.state.active.my);
      if (!mon) return;
      // The order is only evidence about a STATIC Speed while nothing the ceiling cannot see could
      // explain it. `U.maxSpeedForSet` knows the set's item and ability but not the weather, the
      // terrain, Tailwind or a Speed stage, so a floor raised through one of those is a wrong
      // bound — and every consumer of `mon.speedFloor` (the pruner's elimination, the world
      // sampler, the endgame solver, the Trick Room queue) reads it as a real one. The predicate
      // lives on the pruner because it needs the candidate pool; with no pruner nothing eliminates
      // anything, so the floor is recorded exactly as before.
      const unsound = !!(this.pruner && typeof this.pruner.speedFloorUnsound === 'function' &&
        this.pruner.speedFloorUnsound(mon, this.state));
      if (!unsound && value > mon.speedFloor) mon.speedFloor = value;
      const reason = event.reason || 'moved first';
      if (mon.speedEvidence.indexOf(reason) === -1) mon.speedEvidence.push(reason);
      if (this.pruner && typeof this.pruner.handleSpeedFloorEvent === 'function') {
        try { this.pruner.handleSpeedFloorEvent(event, this.state); } catch (e) { debug('pruner speedfloor failed', e && e.message); }
      }
      this.emit('speedfloor', { side: side, value: value, mon: mon.species, reason: reason });
    }

    /**
     * `|stpp|` — the observed PP snapshot from the page's own battle object (ARCHITECTURE §6.4).
     *
     * One line per move slot, so this merges rather than replaces: the four lines of a body
     * arrive in the same tick and each one owns a single move. A snapshot is authoritative for
     * what it says and silent about the rest, so a move it never mentions keeps whatever we knew.
     */
    _onPp(event) {
      const side = event.side || sideOf(event.slot);
      const mon = (event.slot ? this._findBySlot(event.slot) : null) ||
        (event.species ? this._findBySpecies(side, event.species) : null);
      if (!mon) return;
      const list = Array.isArray(event.moves) ? event.moves : [];
      let stored = 0;
      for (let i = 0; i < list.length; i++) {
        const mv = list[i];
        if (!mv || !mv.id) continue;
        const pp = typeof mv.pp === 'number' && isFinite(mv.pp) ? mv.pp : null;
        const maxpp = typeof mv.maxpp === 'number' && isFinite(mv.maxpp) ? mv.maxpp : null;
        if (pp === null && maxpp === null) continue;
        mon.ppSnapshot[mv.id] = { pp: pp, maxpp: maxpp, turn: this.state.turn };
        stored++;
      }
      if (stored) this.emit('pp', { mon: mon.species, moves: stored, side: side });
    }

    /**
     * `|stacc|` — the client's own accuracy for a move (ARCHITECTURE §6.5). Battle-wide, not
     * per-mon: accuracy is a property of the move, and the same table answers for both sides.
     * `true` means the move cannot miss, and that is kept as `true` rather than coerced to 100 so
     * a caller can tell "sure-hit" from "95% accuracy".
     */
    _onAccuracy(event) {
      const list = Array.isArray(event && event.moves) ? event.moves : [];
      for (let i = 0; i < list.length; i++) {
        const mv = list[i];
        if (!mv || !mv.id) continue;
        if (typeof mv.accuracy !== 'number' && mv.accuracy !== true) continue;
        this.state.moveAccuracy[mv.id] = mv.accuracy;
      }
    }

    /**
     * Residual-order evidence (ARCHITECTURE §6.2). The parser asserts the ORDER; the raw
     * relation is recorded on both bodies here, and the conversion into a speed bracket is the
     * pruner's `handleResidualOrderEvent` — the same division of labour the synthesised
     * `speedfloor` event already uses.
     */
    _onResidualOrder(event) {
      const state = this.state;
      const faster = this._findBySlot(event.slot) || this._findBySpecies(event.side, event.species);
      const slower = this._findBySlot(event.otherSlot) || this._findBySpecies(event.otherSide, event.otherSpecies);
      if (!faster || !slower || faster === slower) return;
      const rel = { id: slower.id || toID(slower.species), species: slower.species || slower.id || '', turn: event.turn, reason: event.reason || 'residual resolved first' };
      if (faster.residualOrderBefore.indexOf(rel) === -1) faster.residualOrderBefore.push(rel);
      const back = { id: faster.id || toID(faster.species), species: faster.species || faster.id || '', turn: event.turn, reason: event.reason || 'residual resolved first' };
      if (slower.residualOrderAfter.indexOf(back) === -1) slower.residualOrderAfter.push(back);
      if (this.pruner && typeof this.pruner.handleResidualOrderEvent === 'function') {
        try { this.pruner.handleResidualOrderEvent(event, state); } catch (e) { debug('pruner residualorder failed', e && e.message); }
      }
      this.emit('residualorder', { before: faster.species, after: slower.species, turn: event.turn });
    }

    _onEndBattle(event, type) {
      this.state.result = type === 'tie' ? 'tie' : (event.side === this.state.mySide ? 'win' : 'loss');
      this.state.resultSide = event.side || null;
      this._touch('result');
    }

    /* ------------------------------------------------------------ helpers */

    _recountOppMegas() {
      const st = this.state;
      if (st.formatLocks.oppHasMegaEvolved) {
        st.formatLocks.oppMegasRemaining = 0;
        st.formatLocks.oppHasMegaStone = false;
        return;
      }
      let n = 0;
      for (let i = 0; i < st.oppTeam.length; i++) {
        const m = st.oppTeam[i];
        if (!m || m.fainted) continue;
        const mega = (m.candidateSets || []).some(function (c) { return c && (c.isMega || U.isMegaStone(c.item)); });
        if (mega) n++;
      }
      // a revealed, unmega'd Mega-capable mon is also evidence that a Mega Stone is out there
      if (n === 0) {
        for (let i = 0; i < st.oppTeam.length; i++) {
          const m = st.oppTeam[i];
          if (!m || m.fainted) continue;
          if (U.canMegaEvolve(m.species)) { n++; break; }
        }
      }
      st.formatLocks.oppMegasRemaining = Math.min(n, 1);
      st.formatLocks.oppHasMegaStone = n > 0;
    }

    /**
     * Feed the parser the player's current active Speed so it can synthesise a
     * `speedfloor` event when the opponent moves first with priority 0. Hints only.
     */
    _refreshSpeedHint() {
      if (!this.parser) return;
      const st = this.state;
      const my = st.active.my;
      if (!my) { this.parser.speedHint = { mySpeed: 0, trickRoom: st.field.trickRoom }; return; }
      const speed = U.computeSpeed({
        species: my.species, evs: my.evs, ivs: my.ivs, nature: my.nature, level: my.level,
        boosts: my.boosts, item: my.item || my.currentBattleItem, ability: my.ability || my.revealedAbility
      }, {
        item: my.item || my.currentBattleItem,
        ability: my.ability || my.revealedAbility,
        weather: st.field.weather,
        terrain: st.field.terrain,
        tailwind: st.field.tailwind[st.mySide],
        paradoxSpeedBoost: U.paradoxSpeedBoost(my)
      });
      this.parser.speedHint = {
        mySpeed: speed.effective,
        myRawSpeed: speed.raw,
        trickRoom: st.field.trickRoom,
        side: st.mySide
      };
    }
  }

  BattleStateManager.prototype.slotLetter = slotLetter;
  BattleStateManager.prototype.parseIdent = parseIdent;
  BattleStateManager.prototype.parseHPString = parseHPString;
  BattleStateManager.prototype.normalizeStatus = normalizeStatus;
  BattleStateManager.prototype.MAX_ACTIVE_STINTS = MAX_ACTIVE_STINTS;

  ST.BattleStateManager = BattleStateManager;
})();
