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
        protect: {
          oppTurnsSinceLastProtect: 99, oppConsecutiveProtects: 0, oppLastProtectTurn: -99,
          myTurnsSinceLastProtect: 99, myConsecutiveProtects: 0, myLastProtectTurn: -99,
          oppProtectedLastTurn: false
        },
        request: null,
        legalActions: { moves: [], switches: [], trapped: false, forceSwitch: false },
        history: { turns: [], events: [] },
        log: [],
        result: null,
        teamsize: { p1: 6, p2: 6 },
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
        movePP: {},
        lastMove: null,
        lastMoveTurn: 0,

        revealedAbility: null,
        possibleAbilities: info ? info.abilities.slice() : [],

        speedFloor: 0,
        speedCeiling: 1012,
        speedEvidence: [],
        speedOverride: null,

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
        paradoxBlacklistReason: null
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

    setFormat(formatName) {
      const name = String(formatName || '');
      const st = this.state;
      st.format = name || st.format;
      const isNatDex = /national\s*dex/i.test(name);
      const isTierBanned = /(uu|ru|nu|pu|zu|monotype|doubles|1v1|anything goes|hackmons|balanced hackmons|custom game|randombattle|challenge cup)/i.test(name);
      st.formatSupported = !!isNatDex && !/national\s*dex\s*(doubles|uu|ru|nu|pu)/i.test(name) &&
        (!isTierBanned || /\bou\b/i.test(name));
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

    _findBySpecies(side, species) {
      const team = this._teamFor(side);
      const id = toID(species);
      let best = null;
      for (let i = 0; i < team.length; i++) {
        const m = team[i];
        if (!m) continue;
        if (m.id === id) return m;
        if (!best && toID(m.species).indexOf(id.replace(/mega[xy]?$/, '')) === 0 && id) best = m;
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
      if (event.format) this.setFormat(event.format);
    }

    _onPlayer(event) {
      if (!event.side) return;
      if (!this._playerNames) this._playerNames = {};
      this._playerNames[event.side] = event.name || '';
      if (event.rating) debug('rating', event.side, event.rating);
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
      if (status !== undefined && status !== null && status !== '') {
        const st = normalizeStatus(status);
        if (st && st !== mon.status) { mon.status = st; mon.statusTurns = 0; }
      } else if (parsed.status) {
        const st = normalizeStatus(parsed.status);
        if (st && st !== mon.status) { mon.status = st; mon.statusTurns = 0; }
      }
      if (parsed.fainted || mon.hp === 0) {
        mon.fainted = true;
        mon.hp = 0;
        mon.hpPercent = 0;
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
      mon.lastMove = moveName;
      mon.lastMoveTurn = this.state.turn;
      mon.turnedThisTurn = true;
      if (moveName && mon.revealedMoves.indexOf(moveName) === -1) mon.revealedMoves.push(moveName);

      // new active mon we have never seen (e.g. missed switch line)
      if (!mon.isActive) { mon.isActive = true; this._setActive(side, mon); }

      // stint tracking (rule 3)
      if (mon.activeStintMoves.indexOf(moveName) === -1 && moveName) {
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
      this._setHP(mon, event.hp, event.status);
      if (kind === 'damage') {
        if (/stealth rock|spikes|sticky web/i.test(from)) {
          if (mon.itemRuledOut.indexOf('Heavy-Duty Boots') === -1) mon.itemRuledOut.push('Heavy-Duty Boots');
          mon.confirmedItem = mon.confirmedItem === 'Heavy-Duty Boots' ? null : mon.confirmedItem;
          mon.currentBattleItem = mon.currentBattleItem === 'Heavy-Duty Boots' ? null : mon.currentBattleItem;
          this._addItemEvidence(mon, 'Took ' + from.replace(/^\[from\]\s*/, '') + ' damage: no Heavy-Duty Boots');
        }
        if (/trick|swap/i.test(from)) { /* handled by item events */ }
        if (mon.knockOffTurn === this.state.turn) mon.knockOffSawDamage = true;
      }
      if (kind === 'heal' && /sys|item: leftovers|item: black sludge|item: shell bell/i.test(from)) {
        mon.turnedThisTurn = false;
      }
    }

    _onStatus(event) {
      const mon = this._findBySlot(event.slot);
      if (!mon) return;
      const st = normalizeStatus(event.status);
      if (!st) return;
      mon.status = st;
      mon.statusTurns = 0;
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
        mon.itemKnockedOff = true;
        this._addItemEvidence(mon, 'Knock Off dealt damage with no -enditem: item is irremovable or absent');
      }
    }

    _onActivate(event) {
      const side = event.side || sideOf(event.slot);
      const mon = this._findBySlot(event.slot) || this._findBySpecies(side, event.species);
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
    }

    _onEnd(event) {
      const mon = this._findBySlot(event.slot);
      if (!mon) return;
      const lower = String(event.effect || '').toLowerCase();
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
        st.legalActions = { moves: [], switches: [], trapped: false, forceSwitch: false, wait: true };
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
      if (mon) mon.usedZMove = true;
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
      if (value > mon.speedFloor) mon.speedFloor = value;
      const reason = event.reason || 'moved first';
      if (mon.speedEvidence.indexOf(reason) === -1) mon.speedEvidence.push(reason);
      if (this.pruner && typeof this.pruner.handleSpeedFloorEvent === 'function') {
        try { this.pruner.handleSpeedFloorEvent(event, this.state); } catch (e) { debug('pruner speedfloor failed', e && e.message); }
      }
      this.emit('speedfloor', { side: side, value: value, mon: mon.species, reason: reason });
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
        paradoxSpeedBoost: my.boosterActive || false
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
