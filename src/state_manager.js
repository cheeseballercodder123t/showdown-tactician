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
  /*
   * BATTLE-FORME ALIASES — the bodies whose on-field species differs from the one the roster
   * knows them by. These share a National Dex number with their base, so Species Clause means a
   * team can never carry both, which is what makes matching them safe. Nothing outside this list
   * is ever matched by name prefix: `Ursaluna` must not resolve to `Ursaluna-Bloodmoon` (a
   * genuinely different Pokemon that IS legal next to it), and that rule is pinned by
   * tests/hardening_audit.js.
   */
  const BATTLE_FORMES = {
    aegislash: ['aegislashshield', 'aegislashblade'],
    mimikyu: ['mimikyubusted'],
    darmanitan: ['darmanitanzen'],
    darmanitangalar: ['darmanitangalarzen'],
    meloetta: ['meloettapirouette'],
    zygarde: ['zygardecomplete'],
    eiscue: ['eiscuenoice'],
    wishiwashi: ['wishiwashischool'],
    minior: ['miniormeteor', 'miniorcore', 'miniororange', 'minioryellow', 'miniorgreen', 'miniorblue', 'miniorindigo', 'miniorviolet'],
    morpeko: ['morpekohangry'],
    cramorant: ['cramorantgulping', 'cramorantgorging'],
    palafin: ['palafinhero'],
    zacian: ['zaciancrowned'],
    zamazenta: ['zamazentacrowned'],
    terapagos: ['terapagosterastal', 'terapagostellar'],
    ogerpon: ['ogerponwellspring', 'ogerponhearthflame', 'ogerponcornerstone']
  };
  /** The base id this battle forme belongs to, or the id itself when it is a base. */
  function battleFormeBase(id) {
    if (!id) return '';
    if (BATTLE_FORMES[id]) return id;
    const keys = Object.keys(BATTLE_FORMES);
    for (let i = 0; i < keys.length; i++) {
      if (BATTLE_FORMES[keys[i]].indexOf(id) !== -1) return keys[i];
    }
    return null;
  }

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

  /**
   * 'p2a: Great Tusk' -> { side:'p2', slot:'p2a', name:'Great Tusk' }.
   *
   * A `|request|` roster entry is `p1: Great Tusk` — the SIDE, with no slot letter, because the
   * server's roster is the team, not the battlefield, and a body on the bench has no slot yet. A
   * slot must therefore be REPORTED ONLY WHEN THE TEXT CARRIES ONE: this used to fall back to the
   * bare side prefix, so `p1: Great Tusk` parsed as `slot:'p1'`, and `_mergeMyTeamFromRequest`
   * matched a body by that invented slot and then STAMPED it onto the body it found. Measured
   * consequences (both seats, headless arena): the roster entry for the body that was already
   * holding the fake `p1` slot was overwritten by every later entry in the list (holes in HP and
   * status), the fake slot displaced the real battle slot, and — through the merge's
   * last-entry-wins `isActive` assignment — the ACTIVE body was left flagged inactive, so it came
   * back into `legalActions.switches` and the sim rejected the switch the engine chose with
   * `|error|[Invalid choice] Can't switch: You can't switch to an active Pokémon`.
   */
  function parseIdent(ident) {
    const s = String(ident || '');
    const colon = s.indexOf(':');
    const slotPart = (colon === -1 ? s : s.slice(0, colon)).trim();
    const name = colon === -1 ? '' : s.slice(colon + 1).trim();
    const side = slotPart.slice(0, 2);
    const slot = /^p[12][a-f]$/.test(slotPart) ? slotPart : '';
    return { slot: slot, side: side, name: name };
  }

  /**
   * Is this ident's slot a REAL battle slot ('p1a'..'p2f')? The one place that answers it, so the
   * merge, the request's switch list and every protocol handler agree on what "has a slot" means.
   * A bare side prefix is NOT a slot — see parseIdent.
   */
  function isBattleSlot(slot) { return /^p[12][a-f]$/.test(String(slot || '')); }

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

  /**
   * '100/100' | '51/100 brn' | '0 fnt' -> { hp, status, fainted }
   *
   * `hp` is a PERCENT, and it is frequently fractional: the protocol parser has already divided
   * the raw counter (`58/319` -> `18.18`) before this sees it, and the HP Percentage Mod prints
   * `72.06/100`. The old reader only accepted whole numbers, so every fractional landing was
   * rejected (`hp: null`) and the MonState kept whatever HP it had before — after the first
   * non-round hit a body read 100% for the rest of the battle, which poisons the KO chance, the
   * bench cards and every `hpPercent` arithmetic the engine does. Numbers are accepted directly
   * (that is what events carry) and decimals are parsed rather than matched with \d+.
   */
  function parseHPString(input) {
    const out = { hp: null, status: '', fainted: false };
    if (input === null || input === undefined || input === '') return out;
    if (typeof input === 'number') {
      if (!isFinite(input)) return out;
      out.hp = clamp(Math.round(input * 100) / 100, 0, 100);
      if (out.hp === 0) out.fainted = true;
      return out;
    }
    const s = String(input).trim();
    if (/fnt/i.test(s)) { out.hp = 0; out.fainted = true; return out; }
    const m = s.match(/^(\d+)\s*\/\s*(\d+)\s*(.*)$/);
    if (m) {
      const cur = parseInt(m[1], 10), max = parseInt(m[2], 10);
      out.hp = max > 0 ? clamp(Math.round((cur / max) * 10000) / 100, 0, 100) : 0;
      out.status = (m[3] || '').trim().slice(0, 3);
    } else if (/^\d+(?:\.\d+)?$/.test(s)) {
      out.hp = clamp(parseFloat(s), 0, 100);
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
          gravity: false,
          // Slot conditions that land on a LATER turn, keyed by the side that will be HIT / HEALED.
          // Future Sight / Doom Desire and Wish are the only two, and both are read by
          // laplace_core's delayed-move tier; null means "nothing pending on that side".
          delayedMoves: { p1: null, p2: null },
          wish: { p1: null, p2: null }
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
        legalActions: { moves: [], switches: [], trapped: false, maybeTrapped: false, forceSwitch: false, forId: null },
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
        /* The name this body is REGISTERED as: it never follows a battle-forme change, so an
         * Aegislash that became Aegislash-Blade is still found when it switches back in. */
        rosterSpecies: canonical,
        /* Every species name this body has stood in, INCLUDING its battle-only formes. Aegislash
         * enters as Aegislash-Shield, changes to Aegislash-Blade and returns as
         * Aegislash-Shield; lookup has to recognise all of them as the same Pokemon. */
        formsSeen: [canonical],
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
        /* A battle-only TYPE override (Protean, Color Change, Soak, Burn Up…). The species on
         * the wire never changes for these, so without it every later damage number used the
         * original typing: a Protean Meowscarada that had become pure Grass kept taking 2x
         * Fighting damage in the preview. Cleared on switch-in, exactly like the cartridge. */
        typeOverride: null,
        /* Mimikyu's Disguise is intact until the protocol says otherwise. The first damaging hit
         * is absorbed completely, so pricing it as full damage was a guaranteed wrong answer
         * (and "guaranteed OHKO" on a full-health Mimikyu was the worst version of it). */
        disguiseIntact: /^mimikyu/i.test(canonical),
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
      const name = String(formatName || '').trim();
      const st = this.state;
      /* Room kinds are not formats. `|init|battle` is what a battle room opens with, and a
       * stray one must never replace a real tier (see ProtocolParser's `init` handler). */
      if (/^(battle|chat|room|lobby|teampreview|multi)$/i.test(name)) return st.formatSupported;
      st.format = name || st.format;
      st.formatSupported = name ? this._isSupportedFormat(name) : true;
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
      let roster = null;
      for (let i = 0; i < team.length; i++) {
        const m = team[i];
        if (!m) continue;
        if (m.id === id) return m;
        if (m.formsSeen && m.formsSeen.length) {
          for (let f = 0; f < m.formsSeen.length; f++) {
            if (toID(m.formsSeen[f]) === id) return m;
          }
        }
        /* STABLE ROSTER IDENTITY. `species` follows the body's BATTLE forme: Aegislash-Shield
         * becomes `Aegislash-Blade` on |detailschange|, Mimikyu becomes `Mimikyu-Busted`, and
         * so on. Those forme names are not the name the next |switch| line will use, so looking
         * a body up by its CURRENT species missed it and _onSwitch minted a SECOND MonState for
         * the same Pokemon — a seven-body team, a phantom bench card, a wrong alive count and a
         * wrong Supreme Overlord tally. `rosterSpecies` is what the body was registered as and
         * never follows a forme change. */
        if (m.rosterSpecies && toID(m.rosterSpecies) === id) { if (!roster) roster = m; continue; }
        if (best) continue;
        const mid = toID(m.species) || m.id;
        if (mid === id) { best = m; continue; }
        if (base && mid.replace(FORME_SUFFIX_RE, '') === base) best = m;
      }
      if (best) return best;
      if (roster) return roster;
      return this._findBattleForme(side, id);
    }

    /**
     * _findBattleForme(side, id) -> a body whose roster name is the PREFIX of this battle forme.
     *
     * The team preview (`|poke|`) names the BASE species (`Aegislash`), while the first
     * `|switch|` names the forme the client actually puts on the field (`Aegislash-Shield`).
     * Without this the first switch-in of an Aegislash could never claim its preview entry and
     * grew the roster instead of filling it. Only an entry that has NEVER held a slot may be
     * matched this way: a preview placeholder is the one thing this can legitimately be, so the
     * rule can never merge two real bodies on the same team. (Species Clause also rules out
     * bringing two kindreds of the same dex number, which is what made prefix matching unsafe
     * against `Ursaluna` / `Ursaluna-Bloodmoon` in the old full-team lookup.)
     */
    _findBattleForme(side, id) {
      if (!id) return null;
      const team = this._teamFor(side);
      for (let i = 0; i < team.length; i++) {
        const m = team[i];
        if (!m || m.slot || m.isActive) continue;
        const roster = toID(m.rosterSpecies || m.species);
        if (!roster || roster.length < 4) continue;
        // Both directions: the preview may name the base body while the switch names its battle
        // forme (`Aegislash` -> `Aegislash-Shield`), or the paste may carry the forme while the
        // protocol's switch-in uses the base name (`Aegislash` for an `Aegislash-Shield` entry,
        // which is what @pkmn/sim prints). Only a NEVER-FIELDED placeholder is eligible, and the
        // names must belong to the same battle-forme family from BATTLE_FORMES, so two real
        // bodies can never be merged by this rule.
        const incomingBase = battleFormeBase(id);
        const rosterBase = battleFormeBase(roster);
        if (!incomingBase || !rosterBase || incomingBase !== rosterBase) continue;
        return m;
      }
      return null;
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

    /**
     * _battleLevel() -> the level the BATTLE is played at.
     *
     * A battle is played at one level for both sides, and the pasted team is where that number
     * is actually known (100 unless the paste says otherwise). The `L50` in a `|poke|` or
     * `|switch|` details string is NOT that number: Showdown prints a normalised level in the
     * team-preview and replay text, and believing it priced a 252 HP Serperior at 150 max HP.
     * Against a burned, Guts-boosted Ursaluna that read "388 - 457%" for a Fire Punch that does
     * about 84-99% in the real battle, and the same half-stats error inflated every preview.
     * Level is a property of the format, so the opponent is priced at OUR level.
     */
    _battleLevel() {
      const mine = (this.state && this.state.myTeam) || [];
      for (let i = 0; i < mine.length; i++) {
        const m = mine[i];
        if (m && m.fromPaste && typeof m.level === 'number' && m.level > 0) return m.level;
      }
      return 100;
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
      const reported = level || tok.level || 100;
      const mon = this._newMon(tok.species || species, side, index, {
        slot: null,
        level: this._battleLevel(),
        gender: gender || tok.gender || '',
        hp: hp,
        status: status
      });
      mon.reportedLevel = reported;
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
      // Synthesised events (`speedfloor`, `residualorder`) reuse the raw line they were derived
      // from, so pushing their `raw` again put the same move line in the transcript twice.
      if (event.raw && !event.synthetic) this._pushLog(event.raw);
      if (type !== 'unknown') this._pushHistory(type, event);

      if (['init', 'turn', 'switch', 'replace', 'upkeep', 'faint', 'cant', 'miss', 'fail'].includes(type)) this._damageMove = null;
      switch (type) {
        case 'init': this._onInit(event); break;
        case 'format': this.setFormat(event.format); break;
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
        case 'clearpositiveboost': this._onClearPositiveBoost(event); break;
        case 'invertboost': this._onInvertBoost(event); break;
        case 'swapboost': this._onSwapBoost(event); break;
        case 'copyboost': this._onCopyBoost(event); break;
        case 'crit': this._onCrit(event); break;
        /* A `|-immune|` line changes no HP, but it is the only place a passive immunity
         * ability (Levitate, Flash Fire, Sap Sipper, Water Absorb) is printed. */
        case 'immune': this._onImmune(event); break;
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
        case 'typechange': this._onTypeChange(event); break;
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
      /* `|replace|` is Illusion breaking, NOT a switch: the body never left the field, so its
       * stat stages, volatile, stint and switch-in-ability window all still belong to it. Treating
       * it as a fresh switch erased boosts the battlefield still shows and re-stamped
       * `switchedInTurn`, which tells the pruner a switch-in ability could have fired again. */
      const replacing = event.from === 'replace';

      // 1) close the stint of whatever was in that slot (paradox + item inference)
      const previous = this._findBySlot(slot);
      if (previous && !replacing) this._endStint(previous, 'switch-out');

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
      if (tok.species && (!mon.formsSeen || mon.formsSeen.indexOf(tok.species) === -1)) {
        mon.formsSeen = (mon.formsSeen || []).concat([tok.species]);
      }
      // The pasted team owns level and gender: a protocol details string must never silently
      // retune the EV/IV/nature truth that every Speed and damage number is computed from.
      if (!mon.fromPaste) {
        // The details level is recorded, never adopted: see _battleLevel().
        mon.reportedLevel = event.level || tok.level || mon.reportedLevel || null;
        mon.level = this._battleLevel();
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
      if (!replacing) mon.switchedInTurn = st.turn > 0 ? st.turn : 1;
      if (isMegaDetails(details)) this._markMega(mon, tok.species);

      // rule 2: stint + boosts reset (only on a real switch-in)
      if (!replacing) {
        mon.activeStintMoves = [];
        mon.activeStintCount = 0;
        mon.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
        // Typing resets on entry; a broken Disguise stays broken.
        mon.typeOverride = null;
        mon.disguiseIntact = /^mimikyu/i.test(mon.species) && !/busted/i.test(mon.species) && mon.disguiseIntact !== false;
        // A copied ability (Trace, Role Play) ends when the body leaves; it re-copies on entry.
        mon.activeAbility = null;
        mon.abilityOn = false;
        mon.volatiles = {
          substitute: false, leechseed: false, encore: false, taunt: false, disable: false,
          confusion: false, trappedvolatile: false, ingrain: false, saltcure: false, cursed: false,
          yawn: false, attract: false
        };
        mon.turnedThisTurn = false;
        mon.paradoxStintActive = U.isParadox(mon.species);
        mon.paradoxActivatedThisStint = false;
        mon.boostedStat = null;                // a fresh stint's boost is not stated until | -start |
        this._addStint(mon, slot);
      }

      // Nobody else may keep this slot: a benched mon that still claims 'p2a' would make
      // every later `|move|p2a:` / `|-damage|p2a:` line resolve to the wrong Pokémon.
      const sideTeam = this._teamFor(side);
      for (let i = 0; i < sideTeam.length; i++) {
        const other = sideTeam[i];
        if (!other || other === mon) continue;
        if (other.slot === slot) { other.slot = null; other.isActive = false; }
      }

      /* The KO tally is kept per SLOT, and the body that just left is not the body that owns the
       * slot now. Without this clear, the last attacker to hit the previous occupant was credited
       * with the next one's faint: a body that came in and died to Stealth Rock (no `[of]` clause,
       * no attacker) inherited whatever hit landed on its predecessor. */
      if (this.state._lastDamager && this.state._lastDamager[slot]) delete this.state._lastDamager[slot];

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
      this._damageMove = { attacker: mon, moveName: moveName, moveId: moveId, targetSlot: event.targetSlot, turn: this.state.turn };
      const victim = event.targetSlot && this._findBySlot(event.targetSlot);
      if (victim) victim.critTurn = null;
      /* A CALLED move (`[from] Sleep Talk` / `Metronome` / `Dancer` / `Instruct`) is not a click.
       * Its own `|move|` line names the caller, which already did the accounting. Counting the
       * called move made two or three distinct moves in one stint, which the pruner reads as
       * proof that no Choice item can be held ("choice lock broken" on bodies that never broke
       * one), and it credited the body with moves it does not own (a Metronome Moonblast in the
       * scout ledger). Everything BELOW that reads the board (a called Trick Room really does
       * twist it, a called Knock Off really does connect) still runs; only the click accounting
       * is skipped. */
      const called = !!event.from;
      // Receipt: a turn of Trick Room OUR side actually attacked in. A hard switch under TR is
      // exactly the turn the receipt is meant to expose as wasted, so it is not counted here.
      if (this.state.field.trickRoom && side === this.state.mySide) this.state.battleStats.trAttackTurns++;
      if (!called) {
        mon.lastMove = moveName;
        mon.lastMoveTurn = this.state.turn;
      }
      mon.turnedThisTurn = true;
      if (!called && moveName && mon.revealedMoves.indexOf(moveName) === -1) mon.revealedMoves.push(moveName);

      // new active mon we have never seen (e.g. missed switch line)
      if (!mon.isActive) { mon.isActive = true; this._setActive(side, mon); }

      // stint tracking (rule 3). Struggle is a forced pseudo-move, so it must not enter the
      // stint: otherwise one real move plus Struggle reads as "2 distinct moves" and the
      // pruner permanently blacklists every Choice item for that mon.
      // Observed PP usage: one click of a move is one PP, whether or not the page ever handed
      // us a snapshot. This is the fallback the gauge prints as "used N times".
      if (!called) {
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
      }

      // recovery PP (rule 4)
      if (!called && U.is8PPRecoveryMove(moveId)) {
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
      /* ---- WISH (`|move|<slot>|Wish|`). The sim's Wish slot condition heals at the residual of
       * the NEXT turn (`startingTurn` + a strict `>`), and the amount is HALF THE CASTER's max HP
       * — healed onto whoever stands in the slot at that moment, which may be a different body.
       * Stored by the side it will heal. */
      if (U.isWishMove(moveId)) {
        const wishSide = side;
        if (wishSide) {
          this.state.field.wish[wishSide] = {
            casterId: mon.id,
            casterSpecies: mon.species,
            casterSlot: slot || null,
            startTurn: this.state.turn,
            landingTurn: this.state.turn + 1,
            turnsLeft: 1,
            healPct: 50
          };
          debug('wish', wishSide, 'lands turn', this.state.turn + 1);
        }
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
      /* A boost line is how several abilities announce themselves — `Speed Boost`, `Download`,
       * `Moody`, `Weak Armor` all print `|-boost|…|[from] ability: <Name>`. The ledger and the
       * pruner read `revealedAbility`, so the clause has to land here as well as on damage and
       * weather lines. */
      this._revealAbilityFromClause(event);
      this._noteResidualItem(event, mon, String(event.from || ''));
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

    /** `|-clearpositiveboost|<target>|<source>|move: Defog` — the target's positive stages go. */
    _onClearPositiveBoost(event) {
      const mon = this._findBySlot(event.slot);
      if (!mon) return;
      this._revealAbilityFromClause(event);
      U.STATS.forEach(function (s) { if (mon.boosts[s] > 0) mon.boosts[s] = 0; });
      if (mon.boosts.accuracy > 0) mon.boosts.accuracy = 0;
      if (mon.boosts.evasion > 0) mon.boosts.evasion = 0;
    }

    /** `|-invertboost|<target>` — Topsy-Turvy flips every stage. */
    _onInvertBoost(event) {
      const mon = this._findBySlot(event.slot);
      if (!mon) return;
      this._revealAbilityFromClause(event);
      const keys = Object.keys(mon.boosts);
      for (let i = 0; i < keys.length; i++) mon.boosts[keys[i]] = -mon.boosts[keys[i]];
    }

    /** The stage list the protocol names, or every stage when it names none. */
    _boostKeys(stats) {
      const all = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
      if (!Array.isArray(stats) || !stats.length) return all;
      const out = [];
      for (let i = 0; i < stats.length; i++) {
        const key = String(stats[i] || '').toLowerCase();
        if (all.indexOf(key) !== -1) out.push(key);
      }
      return out.length ? out : all;
    }

    _transferBoosts(event) {
      const target = this._findBySlot(event.slot);
      const source = this._findBySlot(event.otherSlot) ||
        this._findBySpecies(event.otherSide, event.otherSpecies);
      if (!target || !source) return null;
      this._revealAbilityFromClause(event);
      return { target: target, source: source, keys: this._boostKeys(event.stats) };
    }

    /** `|-swapboost|<target>|<source>|atk,def` — Heart Swap. */
    _onSwapBoost(event) {
      const pair = this._transferBoosts(event);
      if (!pair) return;
      for (let i = 0; i < pair.keys.length; i++) {
        const key = pair.keys[i];
        const tmp = pair.target.boosts[key];
        pair.target.boosts[key] = pair.source.boosts[key];
        pair.source.boosts[key] = tmp;
      }
    }

    /** `|-copyboost|<target>|<source>|atk,def` — Psych Up. */
    _onCopyBoost(event) {
      const pair = this._transferBoosts(event);
      if (!pair) return;
      for (let i = 0; i < pair.keys.length; i++) {
        const key = pair.keys[i];
        pair.target.boosts[key] = pair.source.boosts[key];
      }
    }

    _onHPDelta(event, kind) {
      const side = event.side || sideOf(event.slot);
      const mon = this._findBySlot(event.slot) || this._findBySpecies(side, event.species);
      if (!mon) return;
      const from = String(event.from || '');
      // Capture the pre-hit HP before _setHP overwrites it: the difference IS the damage roll we
      // are about to reason from, and it only exists for this instant.
      const hpBefore = typeof mon.hpPercent === 'number' ? mon.hpPercent : 100;
      const defenderBefore = kind === 'damage' ? this._damageSnapshot(mon, true) : null;
      this._setHP(mon, event.hp, event.status);
      // The residual lines are the commonest item reveal on the ladder: a Leftovers heal, a Life
      // Orb recoil, a Sitrus Berry bite, Rocky Helmet damage with its `[of]` holder. The scout
      // panel is supposed to log the item the battle PRINTED, and before this only |-item| (Knock
      // Off, Trick) ever reached it, so half the revealed items were invisible.
      this._noteResidualItem(event, mon, from);
      this._revealAbilityFromClause(event);
      if (kind === 'damage') {
        this._recordDamageObservation(event, mon, side, hpBefore, from, defenderBefore);
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
      /* The landing frames are the ground truth that a pending slot condition resolved, so they
       * clear it even when the countdown was rebuilt from a partial log. A Wish heal names the
       * WISHER, not the body healed, so it clears by side; the Future Sight damage line is already
       * preceded by its `|-end|`, and is only a backstop here. */
      if (/move:\s*wish/i.test(from)) {
        const healSide = side || sideOf(event.slot);
        if (healSide && this.state.field.wish) this.state.field.wish[healSide] = null;
      }
      if (kind === 'damage' && /move:\s*(future sight|doom desire)/i.test(from)) {
        const hitSide = side || sideOf(event.slot);
        if (hitSide && this.state.field.delayedMoves) this.state.field.delayedMoves[hitSide] = null;
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
     * Direct hits use the preceding move frame; attributed residuals require their own source.
     * Snapshots preserve the field, boosts and known items at impact for later pruning.
     */
    _damageSnapshot(mon, includeSpread) {
      const snapshot = {};
      const keys = ['species', 'side', 'level', 'gender', 'hpPercent', 'status', 'toxicCounter', 'itemConsumed', 'itemRemoved', 'itemless', 'alliesFainted', 'boosterActive', 'boostedStat', 'abilityOn', 'typeOverride', 'disguiseIntact'];
      for (const key of keys) if (mon[key] !== undefined) snapshot[key] = Array.isArray(mon[key]) ? mon[key].slice() : mon[key];
      snapshot.boosts = Object.assign({}, mon.boosts || {});
      const item = mon.currentBattleItem || mon.confirmedItem || (includeSpread ? mon.item : null);
      if (item !== undefined && item !== null) snapshot.item = item;
      const ability = mon.activeAbility || mon.revealedAbility || (includeSpread ? mon.ability : null);
      if (ability) snapshot.ability = ability;
      if (includeSpread) for (const key of ['evs', 'ivs', 'nature']) {
        if (mon[key]) snapshot[key] = typeof mon[key] === 'object' ? Object.assign({}, mon[key]) : mon[key];
      }
      return snapshot;
    }

    _recordDamageObservation(event, defender, defenderSide, hpBefore, from, defenderBefore) {
      if (!defender) return;
      if (defenderSide !== this.state.mySide) return;          // only our body can be the ruler
      // `from` is the parsed clause list; fall back to the raw line so a shape the clause
      // splitter has never seen still yields its move name instead of silently dropping the
      // observation. The attacker ident gets the same treatment.
      const raw = String(event.raw || '');
      const moveMatch = /move:\s*([^\[\]]*?)(?=\s*\[|$)/i.exec(from) ||
        /move:\s*([^\[\]]*?)(?=\s*\[|$)/i.exec(raw);
      const context = !from && this._damageMove && this._damageMove.turn === this.state.turn &&
        this._damageMove.targetSlot === defender.slot ? this._damageMove : null;
      if (!moveMatch && !context) return;
      const moveName = moveMatch ? moveMatch[1].trim() : context.moveName;
      const moveId = toID(moveName);
      if (!moveId || moveId === 'struggle') return;
      let attackerIdent = context ? { side: context.attacker.side, slot: context.attacker.slot, name: context.attacker.species } : parseIdent(event.ofRaw || '');
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
        fieldSnapshot: JSON.parse(JSON.stringify(this.state.field || {})),
        attackerSnapshot: this._damageSnapshot(attacker, false),
        defenderSnapshot: defenderBefore || this._damageSnapshot(defender, true),
        censored: hpAfter <= 0,
        multiHit: !!(U.getMoveData(moveName) || {}).isMultihit,
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
      /* The commonest single-line item reveal on the ladder lives here: a Flame Orb printing
       * `|-status|…|brn|[from] item: Flame Orb`. Status can also be an ability's doing
       * (`Static`, `Flame Body`, `Poison Point`, `Effect Spore`, `Synchronize`), so both clauses
       * are read before the status itself is stored. */
      const from = String(event.from || '');
      this._noteResidualItem(event, mon, from);
      this._revealAbilityFromClause(event);
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
      /* `|-curestatus|…|[from] ability: Immunity` / `Shed Skin` / `Hydration` / `Natural Cure`, and
       * `[from] item: Lum Berry`. Both were dropped, so those abilities never reached the
       * ledger. */
      this._noteResidualItem(event, mon, String(event.from || ''));
      this._revealAbilityFromClause(event);
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
      // A faint erases stat stages exactly like a switch-out does. Keeping them left the fainted
      // body (still `active` until its replacement arrives) advertising boosts it no longer has.
      mon.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
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

    /**
     * _noteResidualItem(event, mon, from) -> record an item whose EFFECT the log just printed.
     *
     * Only the `[from] item: X` clause is read, and the HOLDER is resolved from `[of]` when the
     * clause names one: Rocky Helmet damage lands on the attacker while the helmet belongs to the
     * `[of]` body, and crediting the victim would put the item on the wrong Pokémon. Without an
     * `[of]` the damaged/healed body is the holder (Leftovers, Black Sludge, Life Orb, a berry).
     * Never throws: an unknown `[from]` string simply records nothing.
     */
    _noteResidualItem(event, mon, from) {
      if (!from || !/item:/i.test(from)) return null;
      const match = /item:\s*([^|\]]+)/i.exec(from);
      if (!match) return null;
      const item = U.itemName(match[1].trim());
      if (!item) return null;
      let holder = mon;
      if (event && event.ofRaw) {
        const of = parseIdent(event.ofRaw);
        if (of && (of.slot || of.side || of.name)) {
          holder = this._findBySlot(of.slot) || this._findBySpecies(of.side, of.name) || mon;
        }
      }
      if (!holder) return null;
      if (U.isItemKnown(item)) {
        holder.currentBattleItem = item;
        holder.confirmedItem = item;
        holder.itemless = false;
        this._addItemEvidence(holder, 'Item revealed by its effect: ' + item);
      } else if (!holder.currentBattleItem) {
        holder.currentBattleItem = item;
      }
      return item;
    }

    /**
     * _revealItem(mon, item, source) -> the canonical item name (or null).
     * One place for "the log printed this item": a confirmed item is state, not a message, and
     * every reveal path (|-item|, |-activate|, a Mega stone, an ability clause) has to land in
     * the same fields or the scout ledger and the pruner disagree about what we know.
     */
    _revealItem(mon, item, source) {
      if (!mon || !item) return null;
      const name = U.itemName(String(item).replace(/^item:\s*/i, '').trim()) ||
        String(item).replace(/^item:\s*/i, '').trim();
      if (!name) return null;
      // Do not spray duplicate evidence lines when the same fact arrives twice.
      if (mon.confirmedItem !== name) mon.confirmedItem = name;
      mon.currentBattleItem = name;
      mon.itemless = false;
      mon.itemKnockedOff = false;
      if (U.isMegaStone(name) || U.isZCrystal(name)) {
        mon.itemIsIrremovable = true;
        mon.megaStone = U.isMegaStone(name) ? name : mon.megaStone;
      }
      if (U.isBoosterEnergy(name)) {
        mon.boosterActive = true;
        mon.paradoxActivatedThisStint = true;
        mon.cannotBeBoosterEnergy = false;
      }
      this._addItemEvidence(mon, 'Item revealed: ' + name + (source ? ' (' + source + ')' : ''));
      return name;
    }

    /**
     * _revealAbilityFromClause(event) -> the ability name (or null).
     *
     * The protocol prints an ability in the `[from]` clause of the effect it caused far more
     * often than it prints a dedicated `|-ability|` line: `|-weather|Snow|[from] ability: Snow
     * Warning|[of] p1a: Abomasnow`, an Intimidate drop, a Rough Skin recoil, a Water Absorb heal.
     * The holder is the `[of]` body when the clause names one, otherwise the event's own mon.
     */
    _revealAbilityFromClause(event) {
      if (!event) return null;
      /* AN ABILITY LINE'S `[of]` IS THE SOURCE, NOT THE HOLDER. Trace prints
       * `|-ability|p2a: Porygon2|Intimidate|Trace|[from] ability: Trace|[of] p1a: Landorus`:
       * Porygon2 copied Landorus's Intimidate, and reading the clause generically credited
       * LANDORUS with Trace. `_onActivate` owns this reveal (it knows which field is the body's
       * own ability and which is the copied effect). */
      if (event.type === 'activate' && /^ability:/i.test(String(event.effect || ''))) return null;
      const from = String(event.from || '');
      if (!/ability:/i.test(from)) return null;
      const match = /ability:\s*([^|\]]+)/i.exec(from);
      if (!match) return null;
      const ability = match[1].trim();
      if (!ability) return null;
      let holder = null;
      if (event.ofRaw) {
        const of = parseIdent(event.ofRaw);
        if (of && (of.slot || of.side || of.name)) {
          holder = this._findBySlot(of.slot) || this._findBySpecies(of.side, of.name) || null;
        }
      }
      if (!holder) {
        const side = event.side || sideOf(event.slot);
        holder = this._findBySlot(event.slot) || this._findBySpecies(side, event.species) || null;
      }
      if (!holder) return null;
      if (holder.revealedAbility && toID(holder.revealedAbility) === toID(ability)) return ability;
      holder.revealedAbility = ability;
      return ability;
    }

    /** |-item| — reveals (and Trick swaps) items. */
    _onItem(event) {
      const side = event.side || sideOf(event.slot);
      const mon = this._findBySlot(event.slot) || this._findBySpecies(side, event.species);
      if (!mon) return;
      const item = String(event.item || '').replace(/^item:\s*/i, '').trim();
      if (!item) return;
      mon.declaredItem = mon.declaredItem || item;
      this._revealItem(mon, item, '|-item|');
      if (U.isChoiceItem(item)) {
        mon.originalArchetypeItem = mon.originalArchetypeItem || item;
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
      this._revealAbilityFromClause(event);
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
      /* `|-activate|<mon>|ability: Disguise` is printed at the moment the disguise absorbs a
       * hit, so it is the exact frame the disguise stops being intact. */
      if (mon && /disguise/i.test(String(event.effect || event.effectName || ''))) mon.disguiseIntact = false;
      // Receipt counter, taken BEFORE the mon lookup so an activation on a body we have not
      // tracked yet is still tallied. Both the |-ability| and |-activate| shapes land here.
      if (/magic bounce/i.test(String(event.effect || event.effectName || ''))) this.state.battleStats.magicBounce++;
      if (!mon) return;
      const effect = String(event.effect || '');
      const abilityMatch = effect.match(/ability:\s*(.+)$/i);
      if (abilityMatch) {
        const activeAbility = abilityMatch[1].trim();
        if (toID(activeAbility) === 'flashfire') mon.abilityOn = true;
        /* `|-ability|<mon>|Intimidate|Trace|...` prints the COPIED effect first and the body's
         * OWN ability as the third field. Recording the copied name as `revealedAbility` made a
         * Trace Porygon2 look like an Intimidate body, and setting `mon.ability` from it made
         * that permanent. The own name is only accepted when the species can actually have it,
         * so a move/item token can never be read as an ability. */
        const ownToken = (event.args && event.args[0]) ? String(event.args[0]).trim() : '';
        const possible = U.getAbilities(mon.species) || [];
        const ownKnown = ownToken && possible.some(function (a) { return toID(a) === toID(ownToken); });
        mon.activeAbility = activeAbility;
        mon.revealedAbility = ownKnown ? ownToken : activeAbility;
        if (possible.some(function (a) { return toID(a) === toID(mon.revealedAbility); })) {
          mon.ability = mon.ability || mon.revealedAbility;
        }
        if (U.PARADOX_ABILITIES.has(toID(activeAbility))) {
          mon.boosterActive = true;
          mon.paradoxActivatedThisStint = true;
        }
      }
      // |-mega| / |-primal| carry `megaKind` ('mega' | 'primal'), so no substring guessing.
      // The stone rides along: a Mega Stone is the single strongest item read in the battle, and
      // the ledger used to drop it because only Booster Energy / Air Balloon were read here.
      if (event.megaKind) this._markMega(mon, event.megaForme || event.baseSpecies, event.stone);
      if (/z-?power|z-move/i.test(effect)) this._markZMove(side, mon);
      /* `|-activate|<mon>|item: <Item>` is how the protocol announces a Mega Stone reacting to
       * its keystone, a Z-Crystal, a Focus Sash bracing, a berry being eaten. EVERY such line is
       * a printed item fact, so the ledger takes the item itself rather than two hardcoded names:
       * the scout panel's whole job is to show what the battle actually said. */
      const activatedItem = /item:\s*(.+)$/i.exec(effect);
      if (activatedItem) this._revealItem(mon, activatedItem[1], '|-activate|');
      if (/item:\s*air balloon/i.test(effect)) mon.currentBattleItem = mon.currentBattleItem || 'Air Balloon';
      // `|-activate|<mon>|ability: <Ability>` (and |-ability|, same shape) — already handled above.
      this._revealAbilityFromClause(event);
      const args = event.args || [];
      for (let i = 0; i < args.length; i++) this._addItemEvidence(mon, 'Activated: ' + args[i]);
    }

    _onStart(event) {
      const mon = this._findBySlot(event.slot);
      if (!mon) return;
      const effect = String(event.effect || '');
      const lower = effect.toLowerCase();
      if (/flash\s*fire/i.test(effect)) mon.abilityOn = true;
      /* `|-start|<mon>|typechange|<Type>|[from] ability: Protean` is how Showdown reports a
       * battle-only typing. `typeadd` (Trick-or-Treat, Forest's Curse) adds one instead of
       * replacing. Both resolve the ability clause too — this line was the ONLY reveal Protean
       * ever printed, so the ledger stayed silent about it. */
      const effectId = String(event.effectId || '').toLowerCase();
      if (effectId === 'typechange' || effectId === 'typeadd') {
        const next = String((event.args && event.args[0]) || '').trim();
        const types = next && next !== '???' ? next.split('/').map(function (t) { return t.trim(); }).filter(Boolean) : [];
        if (effectId === 'typeadd') {
          const base = (mon.typeOverride && mon.typeOverride.length) ? mon.typeOverride.slice() : (U.getSpecies(mon.species) || {}).types || [];
          for (let i = 0; i < types.length; i++) if (base.indexOf(types[i]) === -1) base.push(types[i]);
          mon.typeOverride = base.slice(0, 2);
        } else {
          mon.typeOverride = types.length ? types.slice(0, 2) : null;
        }
        this._revealAbilityFromClause(event);
      }
      for (let i = 0; i < VOLATILE_KEYS.length; i++) {
        if (lower.indexOf(VOLATILE_KEYS[i][0].toLowerCase()) !== -1) {
          mon.volatiles[VOLATILE_KEYS[i][1]] = true;
        }
      }
      if (/protect|bunker|shield/i.test(effect) && /\bon\b/i.test(effect)) {
        /* `Start of turn N: X is protected` handled through the move event */
      }
      if (/salt cure/i.test(effect)) mon.volatiles.saltcure = true;
      /* ---- FUTURE SIGHT / DOOM DESIRE (`|-start|<caster>|move: Future Sight`).
       *
       * The sim puts the slot condition on the SIDE it was aimed at but names the CASTER here
       * (`data/moves.js`: `this.add('-start', source, 'move: Future Sight')`), so the side that
       * will be hit is the OTHER side. The countdown is the sim's own: `endingTurn` is
       * `(turn - 1) + 2`, i.e. the residual of the NEXT turn, so a cast on turn N lands at the END
       * of turn N+1 — against whatever body is standing in the slot by then, which is why the
       * caster's identity is stored rather than the target's. */
      if (U.isDelayedMove(event.effectId || event.effectName || '')) {
        const casterSide = event.side || sideOf(event.slot);
        const targetSide = otherSide(casterSide);
        if (casterSide && targetSide) {
          this.state.field.delayedMoves[targetSide] = {
            moveName: U.delayedMoveName(event.effectId || event.effectName || ''),
            moveId: U.toID(event.effectId || event.effectName || ''),
            attackerSide: casterSide,
            attackerId: mon.id,
            attackerSpecies: mon.species,
            casterSlot: event.slot || null,
            startTurn: this.state.turn,
            landingTurn: this.state.turn + 1,
            turnsLeft: 1
          };
          debug('delayed move', targetSide, this.state.field.delayedMoves[targetSide].moveName,
            'lands turn', this.state.turn + 1);
          return;
        }
      }
      // The sim STATES which stat the boost moved: `|-start|p2a: Roaring Moon|protosynthesisatk`.
      // That suffix is the only evidence of a SPEED boost; `boosterActive` alone is not, because
      // an Attack- or Special-Attack-boosted body is no faster at all. See boosterStatOf.
      const boosted = boosterStatOf(effect);
      if (boosted) { mon.boostedStat = boosted; mon.boosterActive = true; }
    }

    _onEnd(event) {
      /* `|-end|<target>|move: Future Sight` is the sim's "time's up" frame, emitted immediately
       * before the damage lands. It names the slot being HIT, so it clears that side's pending
       * entry — the countdown cannot be trusted to be the only clear, because a log replayed from
       * the middle can open after the landing turn's header. */
      if (U.isDelayedMove(event.effectId || event.effectName || '')) {
        const hitSide = event.side || sideOf(event.slot);
        if (hitSide && this.state.field.delayedMoves) this.state.field.delayedMoves[hitSide] = null;
        return;
      }
      const mon = this._findBySlot(event.slot);
      if (!mon) return;
      const effect = String(event.effect || '');
      const lower = effect.toLowerCase();
      // `|-end|p1a: Great Tusk|Protosynthesis|[silent]` -- the boost ends and the stat is unknown
      // again, so a later stint cannot inherit this one's Speed reading. The end frame carries the
      // bare ability name (capitalised, no stat suffix), unlike the activation.
      if (lower.indexOf('protosynthesis') !== -1 || lower.indexOf('quarkdrive') !== -1) { mon.boostedStat = null; mon.boosterActive = false; }
      if (/flash\s*fire/i.test(effect)) mon.abilityOn = false;
      for (let i = 0; i < VOLATILE_KEYS.length; i++) {
        if (lower.indexOf(VOLATILE_KEYS[i][0].toLowerCase()) !== -1) {
          mon.volatiles[VOLATILE_KEYS[i][1]] = false;
        }
      }
    }

    _onSideStart(event) {
      const side = this._sideFromEvent(event);
      if (!side) return;
      this._revealAbilityFromClause(event);
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
        st.field.weatherTurnsLeft = this._fieldDuration(event, weather, false);
      }
      const terrain = this._terrainFromEffect(full);
      if (terrain) {
        st.field.terrain = terrain;
        st.field.terrainTurnsLeft = this._fieldDuration(event, terrain, true);
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

    _fieldDuration(event, effect, terrain) {
      if (['harshsun', 'heavyrain', 'strongwinds', 'deltastream'].includes(effect)) return null;
      const ident = parseIdent(event.ofRaw || '');
      const context = this._damageMove;
      const holder = this._findBySlot(ident.slot) || (context && context.turn === this.state.turn ? context.attacker : null);
      if (!holder) return null;
      const known = holder.side === this.state.mySide || holder.confirmedItem || holder.itemless || holder.itemConsumed || holder.itemRemoved;
      if (!known) return null;
      const item = holder.itemConsumed || holder.itemRemoved ? '' : toID(holder.currentBattleItem || holder.confirmedItem || holder.item || '');
      const extender = terrain ? 'terrainextender' : ({ rain: 'damprock', sun: 'heatrock', sandstorm: 'smoothrock', snow: 'icyrock', hail: 'icyrock' })[effect];
      return item === extender ? 8 : 5;
    }

    _onWeather(event) {
      const raw = String(event.weather || '');
      const st = this.state;
      this._revealAbilityFromClause(event);
      if (!raw) {
        st.field.weather = '';
        st.field.weatherTurnsLeft = null;
        return;
      }
      const alias = WEATHER_ALIASES[toID(raw)] || toID(raw);
      if (event.upkeep || /\[upkeep\]/.test(event.raw || '')) {
        st.field.weather = alias || '';
        return;
      }
      st.field.weather = alias || '';
      st.field.weatherTurnsLeft = alias ? this._fieldDuration(event, alias, false) : null;
    }

    _onTerrain(event) {
      const raw = String(event.terrain || '');
      const st = this.state;
      this._revealAbilityFromClause(event);
      if (!raw) { st.field.terrain = ''; st.field.terrainTurnsLeft = null; return; }
      const alias = TERRAIN_ALIASES[toID(raw)] || toID(raw);
      st.field.terrain = alias || '';
      st.field.terrainTurnsLeft = alias ? this._fieldDuration(event, alias, true) : null;
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
        if (st.field.weatherTurnsLeft === 0) st.field.weatherTurnsLeft = null;
      }
      if (typeof st.field.terrainTurnsLeft === 'number' && st.field.terrainTurnsLeft > 0) {
        st.field.terrainTurnsLeft = Math.max(0, st.field.terrainTurnsLeft - 1);
        if (st.field.terrainTurnsLeft === 0) st.field.terrainTurnsLeft = null;
      }
      this._tickDelayedMoves(n);

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

    /**
     * The delayed-slot-condition clock: `turnsLeft` is the number of turn HEADERS still to come
     * before the condition resolves, and it reaches 0 on the LANDING turn (the residual of the
     * next turn), not before it. An entry whose landing turn has already passed is dropped rather
     * than left to fire again — that is the only way a replayed log can double-count it.
     */
    _tickDelayedMoves(n) {
      const f = this.state.field;
      const sides = ['p1', 'p2'];
      for (let i = 0; i < sides.length; i++) {
        const side = sides[i];
        const delayed = f.delayedMoves && f.delayedMoves[side];
        if (delayed) {
          if (n > delayed.landingTurn) f.delayedMoves[side] = null;
          else delayed.turnsLeft = Math.max(0, delayed.landingTurn - n);
        }
        const wish = f.wish && f.wish[side];
        if (wish) {
          if (n > wish.landingTurn) f.wish[side] = null;
          else wish.turnsLeft = Math.max(0, wish.landingTurn - n);
        }
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

      const actions = { moves: [], switches: [], trapped: false, maybeTrapped: false, forceSwitch: false };
      const active = Array.isArray(json.active) ? json.active[0] : null;
      if (active) {
        actions.trapped = !!active.trapped;
        /* `maybeTrapped` is the server's weaker read and it is NOT the same fact as `trapped`: the
         * sim sets `trapped` only when it has PROVEN the body cannot leave, and `maybeTrapped` when
         * it merely cannot rule it out — and in that second case it ACCEPTS the switch
         * (`Side.chooseSwitch`: `pokemon.trapped` rejects, `pokemon.maybeTrapped` only sets
         * `cantUndo`). So this flag is published, never used to delete a legal switch: deleting
         * them would cost a real escape option to hide an uncertainty the engine is allowed to act
         * on. */
        actions.maybeTrapped = !!active.maybeTrapped;
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
        st.legalActions = { moves: [], switches: [], trapped: false, maybeTrapped: false, forceSwitch: false, wait: true, forId: null };
        st.waiting = true;
        return;
      }
      st.waiting = false;

      /* Switches: built from the `|request|`'s OWN roster, which is the authority on three things
       * nothing else here can be — which body is standing there NOW, which have fainted, and which
       * slots the server will accept. Reading our own `myTeam` flags instead is what let the ACTIVE
       * body back into this list (a stale or invented slot; see parseIdent), and the sim rejected
       * the engine's switch to it. A body the roster does not list is never offered.
       *
       * A body the server says is TRAPPED cannot leave on a normal move turn: the sim answers with
       * `Can't switch: The active Pokémon is trapped`, so the rows are dropped rather than ranked.
       * On a `forceSwitch` frame the body is already gone and trapping does not apply — the sim's
       * own `chooseSwitch` only consults `trapped` in its move state. */
      const roster = (json.side && Array.isArray(json.side.pokemon)) ? json.side.pokemon : null;
      if (roster && !(actions.trapped && !actions.forceSwitch)) {
        const added = Object.create(null);
        for (let i = 0; i < roster.length; i++) {
          const p = roster[i];
          if (!p) continue;
          if (p.active) continue;
          if (/fnt/i.test(String(p.condition || p.hp || ''))) continue;
          const ident = parseIdent(p.ident || '');
          const slotOk = isBattleSlot(ident.slot);
          let mon = slotOk ? this._findBySlot(ident.slot) : null;
          if (!mon && ident.name) mon = this._findBySpecies(st.mySide, ident.name);
          if (!mon) continue;                            // never invent a body the roster named
          const key = toID(mon.id || mon.species);
          if (!key || added[key]) continue;
          added[key] = true;
          actions.switches.push({
            id: mon.id || toID(mon.species),
            name: mon.species || ident.name || '',
            /* A roster entry for a benched body carries NO slot (`p1: Gholdengo`), and the slot a
             * body last occupied is now somebody else's — publishing it would let two rows claim
             * the same battlefield slot. Its team-order letter is stable, unique, and honest about
             * being an index rather than a position. */
            slot: slotOk ? ident.slot : (st.mySide + slotLetter(mon.index))
          });
        }
      } else if (!roster) {
        // No roster on the frame (a hand-built request, a driver fixture): the old bench scan, and
        // only then — a request that HAD a roster has already said which bodies are switchable.
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
        /* Match on a REAL battle slot only, and only stamp one back when the frame carried one.
         * A roster entry is `p1: Great Tusk` — no slot — and the slot it must not be matched by is
         * the invented one parseIdent used to return. See parseIdent for what that cost. */
        const slotOk = isBattleSlot(ident.slot);
        let mon = slotOk ? this._findBySlot(ident.slot) : null;
        if (!mon) mon = this._findBySpecies(st.mySide, tok.species);
        if (!mon) {
          mon = this._newMon(tok.species, st.mySide, st.myTeam.length, { slot: slotOk ? ident.slot : null });
          mon.revealed = true;
          st.myTeam.push(mon);
        }
        if (slotOk) mon.slot = ident.slot;
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

    /**
     * `|-immune|<mon>|[from] ability: Levitate` — the target took nothing, and the line names
     * the reason. Neither the ability nor an immunity item (an Air Balloon popping) reached the
     * ledger before, so the scout panel could not show the single most important fact about a
     * Cresselia: Ground does not touch it.
     */
    _onImmune(event) {
      const side = event.side || sideOf(event.slot);
      const mon = this._findBySlot(event.slot) || this._findBySpecies(side, event.species);
      if (!mon) return;
      this._revealAbilityFromClause(event);
      this._noteResidualItem(event, mon, String(event.from || ''));
    }

    /** `|-formechange|<mon>|<species>` — Stance Change / Disguise announce themselves here. */
    _onFormeChange(event) {
      this._revealAbilityFromClause(event);
      this._onDetailsChange(event);
    }

    /** `|-typechange|<mon>|<Type>[|<Type>]` — Soak, Magic Powder, Burn Up, Revelation Dance… */
    _onTypeChange(event) {
      const side = event.side || sideOf(event.slot);
      const mon = this._findBySlot(event.slot) || this._findBySpecies(side, event.species);
      if (!mon) return;
      const types = Array.isArray(event.types) ? event.types.filter(Boolean) : [];
      mon.typeOverride = types.length ? types.slice(0, 2) : null;
      this._revealAbilityFromClause(event);
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
        // A Disguise breaking is reported as a forme change to Mimikyu-Busted.
        if (/^mimikyu/i.test(tok.species)) mon.disguiseIntact = !/busted/i.test(tok.species);
        // Keep the alias so a later |switch| back to the base forme finds this same body
        // instead of minting a duplicate (Aegislash-Shield <-> Aegislash-Blade).
        if (!mon.formsSeen) mon.formsSeen = [];
        if (mon.formsSeen.indexOf(tok.species) === -1) mon.formsSeen.push(tok.species);
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
    _markMega(mon, forme, stone) {
      if (!mon) return;
      mon.megaEvolved = true;
      // The stone is a confirmed item, not a guess: record it so the scout ledger and the item
      // candidate pool both see it. (A Mega Stone can never be knocked off, so this also rules
      // the whole Choice/Boots/Life Orb space out for that body.)
      if (stone) this._revealItem(mon, stone, 'Mega Evolution');
      // The turn it happened, for the format sentinel's "BURNED (X, turn N)" line.
      if (!mon.megaTurn) mon.megaTurn = this.state.turn;
      const name = String(forme === undefined || forme === null ? '' : forme).trim();
      const info = name ? U.getSpecies(name) : null;
      if (info && info.name && toID(info.name) !== toID(mon.species)) {
        const was = mon.species;
        mon.species = info.name;
        mon.id = toID(info.name);
        if (!mon.formsSeen) mon.formsSeen = [was];
        if (mon.formsSeen.indexOf(info.name) === -1) mon.formsSeen.push(info.name);
        this._addItemEvidence(mon, 'Mega forme adopted: ' + was + ' -> ' + info.name);
        /* THE MEGA'S ABILITY IS A FIXED FACT, AND THE PROTOCOL DOES NOT PRINT IT.
         * Mega Evolution changes the ability (Limber -> Scrappy, Intimidate -> Mold Breaker,
         * Levitate -> Sand Force) and Showdown sends no `|-ability|` line for it. The engine kept
         * the base ability for the rest of the battle: the scout ledger named the wrong ability,
         * Scrappy was missing (Normal/Fighting into a Ghost priced as immune) and Mold Breaker
         * was missing from their threat model. Every Mega forme has exactly one ability, so a
         * single-entry answer is safe to adopt; anything else is left alone. */
        const megaAbilities = U.getAbilities(mon.species) || [];
        if (megaAbilities.length === 1) {
          mon.revealedAbility = megaAbilities[0];
          mon.ability = megaAbilities[0];
          mon.activeAbility = megaAbilities[0];
        }
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
