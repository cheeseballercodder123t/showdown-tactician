/* Showdown Tactician — src/protocol_parser.js
 * Pure line-by-line Pokémon Showdown battle protocol parser + event emitter.
 * Lives in the ISOLATED world (see ARCHITECTURE.md section 5.1). It owns no battle
 * knowledge beyond: the current turn, per-side slot -> species maps, Trick Room /
 * Tailwind visibility (only to decide whether a speed inference is provable) and the
 * turn-scoped move ordering used to synthesise `speedfloor` events.
 *
 * Emitted event objects always carry `type` and `raw`. The frozen table is in
 * ARCHITECTURE.md section 2; this file implements every documented row plus, where the
 * frozen table has no row, the following deliberate mappings (never `|throw|`):
 *
 *   |-prepare|      -> start  { effect: 'prepare: <Move>', move, moveId }
 *   |-singleturn|   -> start  { effect: 'singleturn: <Effect>', args }
 *   |-ability|      -> activate { effect: 'ability: <Name>', args }
 *   |-mega|         -> activate { effect: 'mega: <Stone>', stone, args }
 *   |-primal|       -> activate { effect: 'primal: <Stone>', stone, args }
 *   |-burst|        -> activate { effect: 'burst', args }
 *   |-transform|    -> activate { effect: 'transform: <Species>', args }
 *   |-illusion|     -> activate { effect: 'illusion', args }
 *   |-crit|         -> crit { side, slot, species }        (a critical hit landed)
 *   |-fail|         -> fail { effect: 'move: <Name>' }    (a move had no effect)
 *   |-miss|, -immune, -supereffective, -resisted, -hitcount, -combine, -block,
 *   -mustrecharge, -zbroken, -ohko, -nothing, -anim, -waiting, -endability,
 *   -clearpositiveboost, -swapboost, -invertboost, -copyboost, -swapsideconditions,
 *   |teampreview|, |clearpoke|, |error|  -> unknown { cmd, args }
 *
 * `poke` (team preview) intentionally carries `slot: null` because a preview entry has no
 * field slot; it carries `index` (0-based team order) instead, which is what
 * BattleStateManager uses to build `oppTeam`.
 *
 * For `formechange` / `detailschange` / `replace`, `species` is the species the engine
 * currently believes this slot holds (identical semantics to every other row, so lookups
 * stay correct); the newly revealed species is `newSpecies` and the raw protocol text is
 * `details`.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;

  const STATUS_IDS = { brn: 'brn', par: 'par', slp: 'slp', frz: 'frz', tox: 'tox', psn: 'psn' };
  const WEATHER_IDS = { sun: 'sun', rain: 'rain', sandstorm: 'sandstorm', snow: 'snow', hail: 'snow', harshsun: 'harshsun', heavyrain: 'heavyrain' };

  /* Room/UI chatter that must never enter the event stream as `unknown`. */
  const NOISE = {
    t: 1, c: 1, c_: 1, chat: 1, chatmsg: 1, uhtml: 1, uhtmlchange: 1, raw: 1, html: 1,
    bigerror: 1, message: 1, j: 1, l: 1, join: 1, leave: 1, expire: 1, deinit: 1, noinit: 1,
    controls: 1, popup: 1, warn: 1, rated: 1, temp: 1, variation: 1, formats: 1, title: 1,
    users: 1, customborder: 1, tournament: 1, debug: 1, notify: 1, inactive: 1, inactiveoff: 1,
    updateroom: 1, init: 1, 'init|': 1, queryresponse: 1, pick: 1, request: 0, lib: 1,
    'battle-msg': 1, 'unlink': 1, 'battlereq': 1, 'log': 1, 'pm': 1, 'player': 0
  };

  const SIDE_IDS = ['p1', 'p2', 'p3', 'p4'];

  /** 'p2a: Great Tusk' -> { side:'p2', slotChar:'a', slot:'p2a', name:'Great Tusk' } */
  function splitIdent(ident) {
    const raw = String(ident === undefined || ident === null ? '' : ident).trim();
    const idx = raw.indexOf(':');
    const left = (idx === -1 ? raw : raw.slice(0, idx)).trim();
    const name = idx === -1 ? '' : raw.slice(idx + 1).trim();
    const side = left.slice(0, 2);
    const slotChar = left.slice(2, 3);
    const validSide = SIDE_IDS.indexOf(side) !== -1 ? side : '';
    return {
      side: validSide,
      slotChar: validSide && 'ab'.indexOf(slotChar) !== -1 ? slotChar : '',
      slot: validSide && 'ab'.indexOf(slotChar) !== -1 ? side + slotChar : (validSide || ''),
      name: name
    };
  }

  function emptyBoosts() {
    return { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
  }

  /** '404/404' | '0 fnt' | '45/100 brn' | 'fnt' | '171/232' -> numbers + status. */
  function parseHPStatus(payload) {
    const out = { hp: null, max: null, percent: null, status: '', faint: false, raw: String(payload || '') };
    const text = String(payload === undefined || payload === null ? '' : payload).trim();
    if (!text) return out;
    if (/^fnt$/i.test(text)) { out.percent = 0; out.faint = true; return out; }
    const tokens = text.split(/\s+/);
    const hpToken = tokens[0];
    if (hpToken === 'fnt') { out.percent = 0; out.faint = true; }
    else if (hpToken.indexOf('/') !== -1) {
      const pair = hpToken.split('/');
      const cur = parseInt(pair[0], 10);
      const max = parseInt(pair[1], 10);
      out.hp = isNaN(cur) ? null : cur;
      out.max = isNaN(max) ? null : max;
      if (out.hp !== null && out.max) out.percent = U.round2((out.hp / out.max) * 100);
      else if (out.hp !== null && out.max === 0) out.percent = null;
      if (out.hp === 0) out.faint = true;
    } else {
      const n = parseInt(hpToken, 10);
      if (!isNaN(n)) { out.percent = n; out.hp = n; out.max = 100; if (n === 0) out.faint = true; }
    }
    for (let i = 1; i < tokens.length; i++) {
      const tok = tokens[i].toLowerCase();
      if (tok === 'fnt') out.faint = true;
      else if (STATUS_IDS[tok]) out.status = STATUS_IDS[tok];
    }
    return out;
  }

  /** Pull `[from] ...` / `[of] p1a: X` style clauses out of a trailing arg list. */
  function parseClauses(args, startIndex) {
    const from = [];
    let ofRaw = '';
    for (let i = startIndex; i < args.length; i++) {
      const a = args[i];
      if (!a) continue;
      if (a.indexOf('of]') !== -1 || /^\[of\]/i.test(a)) { ofRaw = a.replace(/^\[of\]\s*/i, ''); continue; }
      if (/^\[from\]/i.test(a)) { from.push(a.replace(/^\[from\]\s*/i, '')); continue; }
      if (a.charAt(0) === '[') { from.push(a.replace(/^\[|\]$/g, '')); continue; }
      from.push(a);
    }
    return { from: from.join(' ').trim(), ofRaw: ofRaw };
  }

  class ProtocolParser {
    constructor(initialFormat) {
      this.format = initialFormat || '';
      this.mySide = 'p1';
      this.mySideExplicit = false;
      this.currentTurn = 0;
      this.previewCount = { p1: 0, p2: 0 };
      this.slots = { p1: { a: null, b: null }, p2: { a: null, b: null } };
      this.active = { p1: null, p2: null };
      this.trickRoomActive = false;
      this.tailwind = { p1: false, p2: false };
      this.oppScarfProven = false;
      this.moveOrder = 0;
      this.turnMoves = { p1: [], p2: [] };
      this.pendingZ = { p1: null, p2: null };
      this.pendingMega = { p1: null, p2: null };
      this._speedFloorTurn = -1;
      this.winner = null;
      this.tied = false;
      this.speedHint = { mySpeed: null, mySpecies: null };
      this._all = [];
      this._byType = {};
    }

    /* --------------------------------------------------------- subscription */

    subscribe(handler) {
      if (typeof handler !== 'function') return function () { };
      this._all.push(handler);
      const self = this;
      return function () {
        const i = self._all.indexOf(handler);
        if (i !== -1) self._all.splice(i, 1);
      };
    }

    on(type, handler) {
      if (typeof handler !== 'function') return function () { };
      if (!this._byType[type]) this._byType[type] = [];
      this._byType[type].push(handler);
      const self = this;
      return function () {
        const list = self._byType[type] || [];
        const i = list.indexOf(handler);
        if (i !== -1) list.splice(i, 1);
      };
    }

    emit(event) {
      if (!event) return null;
      const subscribers = this._all;
      for (let i = 0; i < subscribers.length; i++) {
        try { subscribers[i](event); } catch (e) { U.debug('subscriber error', e && e.message); }
      }
      const typed = this._byType[event.type];
      if (typed) {
        const copy = typed.slice();
        for (let i = 0; i < copy.length; i++) {
          try { copy[i](event); } catch (e) { U.debug('handler error', event.type, e && e.message); }
        }
      }
      return event;
    }

    /* --------------------------------------------------------- configuration */

    setMySide(side) {
      if (SIDE_IDS.indexOf(side) === -1) return this.mySide;
      this.mySide = side;
      this.mySideExplicit = true;
      return side;
    }

    getOppSide() { return this.mySide === 'p1' ? 'p2' : 'p1'; }
    setTailwind(side, active) { if (this.tailwind[side] !== undefined) this.tailwind[side] = !!active; }
    setOppScarfProven(v) { this.oppScarfProven = !!v; }
    isTrickRoomActive() { return !!this.trickRoomActive; }

    reset() {
      const keepSide = this.mySide;
      const keepExplicit = this.mySideExplicit;
      const keepFormat = this.format;
      this.currentTurn = 0;
      this.previewCount = { p1: 0, p2: 0 };
      this.slots = { p1: { a: null, b: null }, p2: { a: null, b: null } };
      this.active = { p1: null, p2: null };
      this.trickRoomActive = false;
      this.tailwind = { p1: false, p2: false };
      this.oppScarfProven = false;
      this.moveOrder = 0;
      this.turnMoves = { p1: [], p2: [] };
      this.pendingZ = { p1: null, p2: null };
      this.pendingMega = { p1: null, p2: null };
      this._speedFloorTurn = -1;
      this.winner = null;
      this.tied = false;
      this.speedHint = { mySpeed: null, mySpecies: null };
      this.mySide = keepSide;
      this.mySideExplicit = keepExplicit;
      this.format = keepFormat;
      return this;
    }

    /* --------------------------------------------------------- species helpers */

    /** Canonical display name, or null when the text is a nickname we cannot resolve. */
    canonicalSpecies(name) {
      if (!name) return null;
      const sp = U.getSpecies(name);
      if (sp) return sp.name;
      const fuzzy = U.closestSpeciesName(name);
      return fuzzy || null;
    }

    resolveSpecies(side, slotChar, fallbackName) {
      if (side && slotChar && this.slots[side] && this.slots[side][slotChar]) return this.slots[side][slotChar];
      if (side && this.active[side]) return this.active[side];
      const canon = this.canonicalSpecies(fallbackName);
      return canon || (fallbackName ? String(fallbackName) : '');
    }

    /* --------------------------------------------------------- parsing */

    /**
     * parseLine(rawLine) -> event object or null. Pure: never mutates parser state.
     * Returns null for empty lines and for room/UI chatter.
     */
    parseLine(rawLine) {
      const raw = String(rawLine === undefined || rawLine === null ? '' : rawLine).replace(/\r$/, '');
      if (!raw.trim()) return null;
      if (raw.charAt(0) === '>') return this._parseHeader(raw);
      let body = raw;
      if (body.charAt(0) === '|') body = body.slice(1);
      const parts = body.split('|');
      const cmd = parts[0];
      const args = parts.slice(1);
      return this._parseCommand(cmd, args, raw);
    }

    _parseHeader(raw) {
      const body = raw.slice(1).trim();
      const space = body.indexOf(' ');
      const head = (space === -1 ? body : body.slice(0, space)).toLowerCase();
      const rest = space === -1 ? '' : body.slice(space + 1);
      if (head === 'start') {
        let json = null;
        try { json = JSON.parse(rest); } catch (e) { json = null; }
        const format = json ? (json.format || json.formatid || '') : rest.replace(/["{}]/g, '').trim();
        return { type: 'init', raw: raw, format: format, json: json };
      }
      if (head === 'player') {
        const bits = rest.split('|');
        return { type: 'player', raw: raw, side: bits[0] || '', name: bits[1] || '', avatar: bits[2] || '', rating: bits[3] === undefined ? null : bits[3] };
      }
      if (head === 'spectator' || head === 'chat' || head === 'c' || head === 'j' || head === 'l') return null;
      return { type: 'unknown', raw: raw, cmd: head, args: rest ? rest.split('|') : [] };
    }

    _parseCommand(cmd, args, raw) {
      switch (cmd) {
        case 'init': {
          const format = args.join('|').replace(/["{}]/g, '').trim();
          return { type: 'init', raw: raw, format: format, json: null };
        }
        case 'format': return { type: 'init', raw: raw, format: args[0] || '', json: null };
        case 'player': return { type: 'player', raw: raw, side: args[0] || '', name: args[1] || '', avatar: args[2] || '', rating: args[3] === undefined ? null : args[3] };
        case 'teamsize': return { type: 'teamsize', raw: raw, side: args[0] || '', size: parseInt(args[1], 10) || 0 };
        case 'poke': return this._parsePoke(args, raw);
        case 'clearpoke': case 'teampreview': return { type: 'unknown', raw: raw, cmd: cmd, args: args };
        case 'switch': case 'drag': case 'replace': return this._parseSwitch(cmd, args, raw);
        case 'move': return this._parseMove(args, raw);
        case 'cant': return this._parseCant(args, raw);
        case 'turn': return { type: 'turn', raw: raw, turn: parseInt(args[0], 10) || (this.currentTurn + 1) };
        case 'upkeep': return { type: 'upkeep', raw: raw };
        case 'faint': return this._parseMonEvent('faint', args, raw);
        case 'win': return { type: 'win', raw: raw, side: args[0] || '' };
        case 'tie': return { type: 'tie', raw: raw };
        case 'request': return this._parseRequest(args, raw);
        case 'weather': return this._parseWeather(args, raw, false);
        case 'terrain': return this._parseTerrain(args, raw, false);
        case 'sidestart': case '-sidestart': return this._parseSide(args, raw, 'sideStart');
        case 'sideend': case '-sideend': return this._parseSide(args, raw, 'sideEnd');
        case 'fieldstart': case '-fieldstart': return this._parseField(args, raw, 'fieldStart');
        case 'fieldend': case '-fieldend': return this._parseField(args, raw, 'fieldEnd');
        case '-weather': return this._parseWeather(args, raw, true);
        case '-terrain': return this._parseTerrain(args, raw, true);
        case '-damage': case '-heal': case '-sethp': return this._parseHPEvent(cmd, args, raw);
        case '-status': return this._parseStatus(args, raw, false);
        case '-curestatus': return this._parseStatus(args, raw, true);
        case '-cureteam': return this._parseMonEvent('cureteam', args, raw);
        case '-boost': return this._parseBoost('boost', args, raw);
        case '-unboost': return this._parseBoost('unboost', args, raw);
        case '-setboost': return this._parseBoost('setboost', args, raw);
        case '-clearallboost': return { type: 'clearallboost', raw: raw };
        case '-clearnegativeboost': return this._parseMonEvent('clearnegativeboost', args, raw);
        case '-item': return this._parseItem(args, raw, false);
        case '-enditem': return this._parseItem(args, raw, true);
        case '-activate': return this._parseEffect('activate', args, raw);
        case '-start': return this._parseEffect('start', args, raw);
        case '-end': return this._parseEffect('end', args, raw);
        case '-formechange': return this._parseForme('formechange', args, raw);
        case 'detailschange': case '-detailschange': return this._parseForme('detailschange', args, raw);
        case '-terastallize': case 'terastallize': return this._parseTera(args, raw);
        case '-zpower': return this._parseZPower(args, raw);
        case '-zmove': return this._parseZPower(args, raw);
        case '-ability': return this._parseEffect('activate', args, raw, 'ability: ');
        case '-prepare': return this._parsePrepare(args, raw);
        case '-singleturn': return this._parseEffect('start', args, raw, 'singleturn: ');
        case '-mega': return this._parseMega(args, raw, 'mega');
        case '-primal': return this._parseMega(args, raw, 'primal');
        case '-burst': return this._parseEffect('activate', args, raw, '', 'burst');
        case '-transform': return this._parseEffect('activate', args, raw, 'transform: ');
        case '-illusion': return this._parseEffect('activate', args, raw, '', 'illusion');
        // Both commands appear in every real battle, so they get a type of their own rather
        // than falling through to `unknown`: a consumer can tell a lucky roll from a roll.
        case '-crit': return this._parseMonEvent('crit', args, raw);
        case '-fail': return this._parseEffect('fail', args, raw);
        default:
          if (NOISE[cmd] === 1) return null;
          return { type: 'unknown', raw: raw, cmd: cmd, args: args };
      }
    }

    _parsePoke(args, raw) {
      const ident = splitIdent(args[0]);
      const details = args[1] || '';
      const det = U.tokenizeDetails(details);
      return {
        type: 'poke', raw: raw,
        side: ident.side, slot: null, index: this.previewCount[ident.side] || 0,
        species: this.canonicalSpecies(det.species) || det.species,
        details: details, item: '', hp: 100, status: '', gender: det.gender, level: det.level
      };
    }

    _parseSwitch(cmd, args, raw) {
      const ident = splitIdent(args[0]);
      const details = args[1] || '';
      const det = U.tokenizeDetails(details);
      const hp = parseHPStatus(args[2]);
      const species = this.canonicalSpecies(det.species) || this.resolveSpecies(ident.side, ident.slotChar, det.species);
      const fromField = args.length > 3 ? parseClauses(args, 3) : { from: '', ofRaw: '' };
      return {
        type: 'switch', raw: raw,
        side: ident.side, slot: ident.slot, slotChar: ident.slotChar,
        species: species, newSpecies: species, details: details,
        hp: hp.percent, hpRaw: hp.hp, maxHpRaw: hp.max, status: hp.status,
        level: det.level, gender: det.gender,
        from: cmd === 'drag' ? 'drag' : cmd === 'replace' ? 'replace' : 'switch',
        nickname: ident.name && U.toID(ident.name) !== U.toID(species) ? ident.name : '',
        ofRaw: fromField.ofRaw
      };
    }

    _parseMove(args, raw) {
      const ident = splitIdent(args[0]);
      const moveName = args[1] || '';
      const targetIdent = splitIdent(args[2] || '');
      const moveId = U.toID(moveName);
      const moveData = U.getMoveData(moveName);
      const extra = args.length > 3 ? args.slice(3).join(' ') : '';
      const pendingZ = ident.side ? this.pendingZ[ident.side] : null;
      const isZ = !!pendingZ || (moveData ? !!moveData.isZMove : false) || /\[zeffect\]/i.test(extra);
      const isMax = /^Max\s/i.test(moveName) || moveId.indexOf('max') === 0;
      const priority = moveData ? moveData.priority : 0;
      return {
        type: 'move', raw: raw,
        side: ident.side, slot: ident.slot, slotChar: ident.slotChar,
        species: this.resolveSpecies(ident.side, ident.slotChar, ident.name),
        move: moveName, moveId: moveId,
        isZ: isZ, isMax: isMax, priority: priority, bracket: priority,
        targetSide: targetIdent.side || '', targetSlot: targetIdent.slot || '',
        revived: moveId === 'revivalblessing',
        extra: extra
      };
    }

    _parseCant(args, raw) {
      const ident = splitIdent(args[0]);
      const reason = (args[1] || '').toLowerCase();
      const move = args[2] || '';
      return {
        type: 'cant', raw: raw,
        side: ident.side, slot: ident.slot, slotChar: ident.slotChar,
        species: this.resolveSpecies(ident.side, ident.slotChar, ident.name),
        reason: reason, move: move, moveId: U.toID(move)
      };
    }

    _parseMonEvent(type, args, raw) {
      const ident = splitIdent(args[0]);
      return {
        type: type, raw: raw,
        side: ident.side, slot: ident.slot, slotChar: ident.slotChar,
        species: this.resolveSpecies(ident.side, ident.slotChar, ident.name)
      };
    }

    _parseRequest(args, raw) {
      let json = null;
      let text = args.join('|');
      try { json = JSON.parse(text); } catch (e) { json = null; }
      const side = json && json.side && json.side.id ? json.side.id : '';
      return { type: 'request', raw: raw, json: json, side: side, text: text };
    }

    _parseWeather(args, raw) {
      const payload = (args[0] || '').trim();
      const id = U.toID(payload);
      const weather = (!payload || id === 'none' || payload === '') ? ''
        : (WEATHER_IDS[id] || payload);
      const clause = parseClauses(args, 1);
      return { type: 'weather', raw: raw, weather: weather, from: clause.from, weatherId: weather ? U.toID(weather) : '' };
    }

    _parseTerrain(args, raw) {
      const payload = (args[0] || '').trim();
      const terrain = payload.replace(/\s*Terrain$/i, '');
      return { type: 'terrain', raw: raw, terrain: payload ? terrain : '', terrainId: payload ? U.toID(terrain) : '' };
    }

    _parseSide(args, raw, type) {
      const ident = splitIdent(args[0]);
      const rawEffect = (args[1] || '').trim();
      const effect = rawEffect.replace(/^move:\s*/i, '').replace(/^condition:\s*/i, '');
      const layerArg = args.length > 2 ? args[2] : '';
      const clause = parseClauses(args, 2);
      return {
        type: type, raw: raw, side: ident.side, effect: rawEffect, effectName: effect,
        effectId: U.toID(effect), layer: layerArg, args: args.slice(2),
        from: clause.from, ofRaw: clause.ofRaw
      };
    }

    _parseField(args, raw, type) {
      const rawEffect = (args[0] || '').trim();
      const effect = rawEffect.replace(/^move:\s*/i, '');
      const clause = parseClauses(args, 1);
      const ofIdent = splitIdent(clause.ofRaw);
      return {
        type: type, raw: raw, effect: rawEffect, effectName: effect, effectId: U.toID(effect),
        ofSide: ofIdent.side, ofSlot: ofIdent.slot, ofSpecies: ofIdent.name,
        args: args.slice(1), from: clause.from, ofRaw: clause.ofRaw
      };
    }

    _parseHPEvent(cmd, args, raw) {
      const ident = splitIdent(args[0]);
      const hp = parseHPStatus(args[1]);
      const clause = parseClauses(args, 2);
      const type = cmd === '-damage' ? 'damage' : cmd === '-heal' ? 'heal' : 'sethp';
      const event = {
        type: type, raw: raw,
        side: ident.side, slot: ident.slot, slotChar: ident.slotChar,
        species: this.resolveSpecies(ident.side, ident.slotChar, ident.name),
        hp: hp.percent, hpRaw: hp.hp, maxHpRaw: hp.max, status: hp.status,
        faint: hp.faint, from: clause.from, ofRaw: clause.ofRaw
      };
      if (hp.faint) event.fainted = true;
      return event;
    }

    _parseStatus(args, raw, cure) {
      const ident = splitIdent(args[0]);
      const status = U.toID(args[1] || '');
      const clause = parseClauses(args, 2);
      return {
        type: cure ? 'curestatus' : 'status', raw: raw,
        side: ident.side, slot: ident.slot, slotChar: ident.slotChar,
        species: this.resolveSpecies(ident.side, ident.slotChar, ident.name),
        status: status, from: clause.from, ofRaw: clause.ofRaw
      };
    }

    _parseBoost(type, args, raw) {
      const ident = splitIdent(args[0]);
      const stat = U.toID(args[1] || '');
      const amount = parseInt(args[2], 10);
      const clause = parseClauses(args, 3);
      return {
        type: type, raw: raw,
        side: ident.side, slot: ident.slot, slotChar: ident.slotChar,
        species: this.resolveSpecies(ident.side, ident.slotChar, ident.name),
        stat: stat, amount: isNaN(amount) ? 0 : amount, from: clause.from
      };
    }

    _parseItem(args, raw, isEnd) {
      const ident = splitIdent(args[0]);
      const item = (args[1] || '').trim();
      const clause = parseClauses(args, 2);
      const ofIdent = splitIdent(clause.ofRaw);
      return {
        type: isEnd ? 'enditem' : 'item', raw: raw,
        side: ident.side, slot: ident.slot, slotChar: ident.slotChar,
        species: this.resolveSpecies(ident.side, ident.slotChar, ident.name),
        item: item, from: clause.from, reason: clause.from,
        ofSide: ofIdent.side, ofSlot: ofIdent.slot, ofSpecies: ofIdent.name,
        ofRaw: clause.ofRaw
      };
    }

    _parseEffect(type, args, raw, prefix, forcedEffect) {
      const ident = splitIdent(args[0]);
      const rawEffect = forcedEffect || (args[1] || '').trim();
      const effect = prefix && rawEffect.indexOf(':') === -1 ? prefix + rawEffect : rawEffect;
      const rest = args.slice(2).filter(function (a) { return a !== ''; });
      const clause = parseClauses(args, 1);
      return {
        type: type, raw: raw,
        side: ident.side, slot: ident.slot, slotChar: ident.slotChar,
        species: this.resolveSpecies(ident.side, ident.slotChar, ident.name),
        effect: effect, effectName: rawEffect.replace(/^[a-z]+:\s*/i, ''),
        effectId: U.toID(rawEffect.replace(/^[a-z]+:\s*/i, '')),
        args: rest, from: clause.from, ofRaw: clause.ofRaw
      };
    }

    _parsePrepare(args, raw) {
      const ident = splitIdent(args[0]);
      const move = args[1] || '';
      const rest = args.slice(2).filter(function (a) { return a !== ''; });
      return {
        type: 'start', raw: raw,
        side: ident.side, slot: ident.slot, slotChar: ident.slotChar,
        species: this.resolveSpecies(ident.side, ident.slotChar, ident.name),
        effect: 'prepare: ' + move, effectName: move, effectId: U.toID(move),
        move: move, moveId: U.toID(move), args: rest, from: '', ofRaw: ''
      };
    }

    _parseMega(args, raw, kind) {
      const ident = splitIdent(args[0]);
      const stone = (args[2] || args[1] || '').trim();
      const base = (args[1] || '').trim();
      return {
        type: 'activate', raw: raw,
        side: ident.side, slot: ident.slot, slotChar: ident.slotChar,
        species: this.resolveSpecies(ident.side, ident.slotChar, ident.name),
        effect: kind + (stone ? ': ' + stone : ''), effectName: stone, effectId: U.toID(stone),
        stone: stone, baseSpecies: base, megaKind: kind,
        // |-mega|p2a: Abomasnow|Abomasnow-Mega|Abomasite| — args[1] is the forme the mon is
        // standing in AFTER the evolution (Showdown sends no separate detailschange for it).
        megaForme: base,
        args: args.slice(1).filter(function (a) { return a !== ''; }), from: '', ofRaw: ''
      };
    }

    _parseForme(type, args, raw) {
      const ident = splitIdent(args[0]);
      const details = args[1] || '';
      const det = U.tokenizeDetails(details);
      const hp = parseHPStatus(args[2]);
      const newSpecies = this.canonicalSpecies(det.species) || det.species;
      const prevSpecies = this.resolveSpecies(ident.side, ident.slotChar, ident.name);
      return {
        type: type, raw: raw,
        side: ident.side, slot: ident.slot, slotChar: ident.slotChar,
        species: prevSpecies, newSpecies: newSpecies,
        details: details, hp: hp.percent, status: hp.status,
        level: det.level, gender: det.gender,
        isMega: /-Mega/i.test(newSpecies || ''),
        from: 'formechange', ofRaw: ''
      };
    }

    _parseTera(args, raw) {
      const ident = splitIdent(args[0]);
      return {
        type: 'terastallize', raw: raw,
        side: ident.side, slot: ident.slot, slotChar: ident.slotChar,
        species: this.resolveSpecies(ident.side, ident.slotChar, ident.name),
        type_: args[1] || '', teraType: args[1] || ''
      };
    }

    _parseZPower(args, raw) {
      const ident = splitIdent(args[0]);
      const move = args[1] || '';
      return {
        type: 'zpower', raw: raw,
        side: ident.side, slot: ident.slot, slotChar: ident.slotChar,
        species: this.resolveSpecies(ident.side, ident.slotChar, ident.name),
        move: move.replace(/^move:\s*/i, ''), moveId: U.toID(move.replace(/^move:\s*/i, '')),
        isZ: true
      };
    }

    /* --------------------------------------------------------- state side-effects */

    /** Applies parser-owned bookkeeping; returns any synthesised events. */
    _apply(evt) {
      const synthesised = [];
      switch (evt.type) {
        case 'init': {
          const fmt = evt.format || '';
          if (fmt) this.format = fmt;
          break;
        }
        case 'poke': {
          const side = evt.side;
          if (side && this.previewCount[side] !== undefined) this.previewCount[side] = (this.previewCount[side] || 0) + 1;
          break;
        }
        case 'switch': case 'replace': {
          if (evt.side && evt.slotChar && this.slots[evt.side]) {
            this.slots[evt.side][evt.slotChar] = evt.newSpecies || evt.species;
            this.active[evt.side] = this.slots[evt.side][evt.slotChar];
          }
          break;
        }
        case 'detailschange': case 'formechange': {
          if (evt.side && evt.slotChar && this.slots[evt.side] && evt.newSpecies) {
            this.slots[evt.side][evt.slotChar] = evt.newSpecies;
            this.active[evt.side] = evt.newSpecies;
          }
          break;
        }
        case 'zpower': {
          if (evt.side) this.pendingZ[evt.side] = evt.move;
          break;
        }
        case 'activate': {
          if (evt.megaKind && evt.side) this.pendingMega[evt.side] = evt.effect;
          break;
        }
        case 'fieldStart': {
          if (evt.effectId && evt.effectId.indexOf('trickroom') !== -1) this.trickRoomActive = true;
          break;
        }
        case 'fieldEnd': {
          if (evt.effectId && evt.effectId.indexOf('trickroom') !== -1) this.trickRoomActive = false;
          break;
        }
        case 'sideStart': {
          if (evt.side && evt.effectId && evt.effectId.indexOf('tailwind') !== -1) this.tailwind[evt.side] = true;
          break;
        }
        case 'sideEnd': {
          if (evt.side && evt.effectId && evt.effectId.indexOf('tailwind') !== -1) this.tailwind[evt.side] = false;
          break;
        }
        case 'request': {
          if (!this.mySideExplicit && evt.side && SIDE_IDS.indexOf(evt.side) !== -1) {
            this.mySide = evt.side;
          }
          break;
        }
        case 'turn': {
          this.currentTurn = evt.turn;
          this.moveOrder = 0;
          this.turnMoves = { p1: [], p2: [] };
          this.pendingZ = { p1: null, p2: null };
          this._speedFloorTurn = -1;
          break;
        }
        case 'move': {
          const side = evt.side;
          if (side && this.turnMoves[side]) {
            this.turnMoves[side].push({
              slot: evt.slot, slotChar: evt.slotChar, species: evt.species,
              move: evt.move, moveId: evt.moveId, priority: evt.priority | 0,
              order: this.moveOrder++, isZ: !!evt.isZ, isMax: !!evt.isMax, turn: this.currentTurn
            });
            const floor = this._maybeSpeedFloor(side, evt);
            if (floor) synthesised.push(floor);
            if (evt.isZ && this.pendingZ[side]) this.pendingZ[side] = null;
          }
          break;
        }
        case 'win': {
          // |win|<name> carries the WINNER'S NAME, not a side id. Resolve it through the
          // |player| lines so a consumer can compare it with its own side; if it cannot be
          // resolved the raw name is kept rather than guessed at.
          const resolved = this.sideOfPlayer(evt.side);
          if (resolved) evt.side = resolved;
          this.winner = evt.side || 'unknown';
          break;
        }
        case 'tie': this.tied = true; break;
        case 'player': {
          if (!this.players) this.players = {};
          if (evt.side) this.players[evt.side] = evt.name || '';
          break;
        }
        default: break;
      }
      return synthesised;
    }

    /**
     * 'ExtramePatriot' -> 'p2' (from the |player| lines). Returns '' when the name is not one
     * of the two players, and passes a side id straight through.
     */
    sideOfPlayer(name) {
      const needle = String(name === undefined || name === null ? '' : name).trim();
      if (!needle) return '';
      if (SIDE_IDS.indexOf(needle) !== -1) return needle;
      const table = this.players || {};
      const keys = Object.keys(table);
      for (let i = 0; i < keys.length; i++) {
        if (table[keys[i]] === needle) return keys[i];
      }
      const low = needle.toLowerCase();
      for (let i = 0; i < keys.length; i++) {
        if (String(table[keys[i]] || '').toLowerCase() === low) return keys[i];
      }
      return '';
    }

    /**
     * Speed-floor synthesis. The opponent moving first with a priority-0 move, while
     * Trick Room is down and no Tailwind is up on their side, proves
     * opponentSpeed >= myActiveSpeed. We only learn this once the player's own
     * priority-0 move of the same turn arrives afterwards.
     */
    _maybeSpeedFloor(side, evt) {
      const mySide = this.mySide;
      const oppSide = this.getOppSide();
      if (!side) return null;
      const hint = this.speedHint || {};
      const mySpeed = hint.mySpeed;
      const reason = 'moved first, priority 0, no TR';
      if (side !== mySide) return null;                 // only fire when the player's move lands
      if (this.trickRoomActive) return null;
      if (this.tailwind[oppSide]) return null;
      if (this.oppScarfProven) return null;
      if (typeof mySpeed !== 'number' || !(mySpeed > 0)) return null;
      if (this._speedFloorTurn === this.currentTurn) return null;
      if ((evt.priority | 0) !== 0) return null;
      const oppMoves = this.turnMoves[oppSide] || [];
      if (!oppMoves.length) return null;
      let oppEntry = null;
      for (let i = 0; i < oppMoves.length; i++) {
        const m = oppMoves[i];
        if (m.priority === 0 && !m.isZ) { oppEntry = m; break; }
      }
      if (!oppEntry) return null;
      const myEntry = this._findMoveEntry(mySide, evt);
      if (!myEntry) return null;
      if (myEntry.order <= oppEntry.order) return null;   // the player actually went first
      this._speedFloorTurn = this.currentTurn;
      return {
        type: 'speedfloor', raw: evt.raw,
        side: oppSide, value: mySpeed, species: oppEntry.species,
        oppMove: oppEntry.move, myMove: evt.move, turn: this.currentTurn, reason: reason
      };
    }

    _findMoveEntry(side, evt) {
      const list = this.turnMoves[side] || [];
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].moveId === evt.moveId) return list[i];
      }
      return list.length ? list[list.length - 1] : null;
    }

    /* --------------------------------------------------------- feeding */

    /**
     * Feed one protocol line. Parser-owned bookkeeping is applied first, so subscribers
     * always observe fresh slot/turn state; the primary event is emitted before any
     * synthesised event derived from it. Returns the primary event (or null).
     */
    feed(rawLine) {
      const evt = this.parseLine(rawLine);
      if (!evt) return null;
      let extra = null;
      try { extra = this._apply(evt); } catch (e) { U.debug('apply error', e && e.message); }
      this.emit(evt);
      if (extra && extra.length) {
        for (let i = 0; i < extra.length; i++) this.emit(extra[i]);
      }
      return evt;
    }

    feedLines(lines) {
      const out = [];
      if (!lines) return out;
      const list = Array.isArray(lines) ? lines : String(lines).split('\n');
      for (let i = 0; i < list.length; i++) {
        const evt = this.feed(list[i]);
        if (evt) out.push(evt);
      }
      return out;
    }

    feedAll(text) {
      if (typeof text !== 'string') return this.feedLines(text);
      return this.feedLines(text.split('\n'));
    }

    /** Species currently believed to occupy `slot` ('p2a'). */
    speciesAt(slot) {
      const ident = splitIdent(slot);
      if (!ident.side || !ident.slotChar || !this.slots[ident.side]) return null;
      return this.slots[ident.side][ident.slotChar];
    }
  }

  ProtocolParser.STATUS_IDS = STATUS_IDS;
  ProtocolParser.parseHPStatus = parseHPStatus;
  ProtocolParser.splitIdent = splitIdent;
  ProtocolParser.emptyBoosts = emptyBoosts;
  ProtocolParser.NOISE = NOISE;

  ST.ProtocolParser = ProtocolParser;
})();
