/* Showdown Tactician — src/team_parser.js
 * Pokepaste / packed-team parser and Showdown localStorage extractor. This is where the
 * player's own EV/IV/nature/level truth enters the engine, so it resolves ids to canonical
 * display names on the way in.
 *
 * Contract (ARCHITECTURE.md §1.5 and §3):
 *   ST.TeamParser
 *     parsePokepaste(text)                      -> { pokemon: ParsedMon[], errors: string[], warnings: string[] }
 *     parsePackedTeam(packed)                   -> { pokemon: ParsedMon[], errors: string[], warnings: string[] }
 *     extractFromLocalStorage(storage?)         -> StoredTeam[]
 *     matchActiveTeam(activeList, storedTeams)  -> StoredTeam|null, augmented with
 *         matchScore = NUMBER of species that matched (0..6), matchRatio = that over the
 *         roster size, matchTotal, exactMatches, matchedSpecies[] and missedSpecies[].
 *         Returns null when no stored team scores a full match (a single stored team is
 *         rescued from half a match, since it is the only possible answer).
 *     toShowdownSet(parsedMon)                  -> string
 * Never throws. Unknown species are reported, never invented.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;
  if (!U || ST.TeamParser) return;

  const toID = U.toID;
  const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

  /* Stat token aliases, keyed by toID(token). */
  const STAT_ALIASES = (function () {
    const raw = {
      hp: 'hp', health: 'hp', hitpoints: 'hp', hpstat: 'hp',
      atk: 'atk', at: 'atk', attack: 'atk', physicalattack: 'atk',
      def: 'def', df: 'def', defense: 'def', defence: 'def', physicaldefense: 'def',
      spa: 'spa', sa: 'spa', spc: 'spa', spatk: 'spa', spattack: 'spa', special: 'spa',
      specialattack: 'spa', spat: 'spa', specialatk: 'spa',
      spd: 'spd', sd: 'spd', spdef: 'spd', spdefense: 'spd', specialdefense: 'spd',
      specialdefence: 'spd', spdefence: 'spd', spdstat: 'spd',
      spe: 'spe', speed: 'spe', spd_speed: 'spe', init: 'spe'
    };
    const out = {};
    Object.keys(raw).forEach(function (k) { out[toID(k)] = raw[k]; });
    out.spdm = 'spd';
    return out;
  })();

  const SPEED_LOWERING_NATURES = new Set(['brave', 'relaxed', 'sassy', 'quiet']);
  const SPEED_BOOSTING_NATURES = new Set(['timid', 'jolly', 'hasty', 'naive']);
  const ALL_NATURE_IDS = (function () {
    const set = new Set();
    const natures = (U.CALC && U.CALC.NATURES) || {};
    Object.keys(natures).forEach(function (n) { set.add(toID(n)); });
    // Never trust the dex alone: these are referenced by the TR heuristics.
    SPEED_LOWERING_NATURES.forEach(function (n) { set.add(n); });
    SPEED_BOOSTING_NATURES.forEach(function (n) { set.add(n); });
    return set;
  })();

  const KNOWN_KEYS = /^(ability|level|shiny|happiness|tera\s*type|evs?|ivs?|ball|nature|gigantamax|dynamax\s*level|hidden\s*power|ot|nickname|pokeball|status|friend\s*code)\s*:/i;
  const NATURE_LINE = /^([A-Za-z][A-Za-z' -]*?)\s*nature$/i;
  const NATURE_KEY_LINE = /^nature\s*:\s*([A-Za-z][A-Za-z' -]*)$/i;
  const SEPARATOR_LINE = /^[-=_*~#]{3,}$/;

  /* ------------------------------------------------------------------ shapes */

  function emptySet() {
    return {
      name: '', species: '', nickname: '',
      item: '', ability: '', nature: '',
      level: 100, gender: '', shiny: false, happiness: null, teraType: '',
      evs: Object.assign({}, U.ZERO_EVS),
      ivs: Object.assign({}, U.DEFAULT_IVS),
      moves: [], isTR: false, raw: '', unknown: [], headerSeen: false
    };
  }

  function finalizeSet(set) {
    const species = set.species || set.name || '';
    const out = {
      name: species,
      species: species,
      nickname: set.nickname || '',
      item: set.item || '',
      ability: set.ability || '',
      nature: set.nature || '',
      level: set.level || 100,
      gender: set.gender || '',
      shiny: !!set.shiny,
      happiness: set.happiness === null ? null : set.happiness,
      teraType: set.teraType || '',
      evs: Object.assign({}, U.ZERO_EVS, set.evs),
      ivs: Object.assign({}, U.DEFAULT_IVS, set.ivs),
      moves: set.moves.slice(0, 4),
      isTR: false,
      raw: set.raw || '',
      unknown: set.unknown.slice()
    };
    out.isTR = isTrickRoomSet(out);
    return out;
  }

  /** 0 Spe IVs plus (a speed-lowering nature or minimum speed investment). */
  function isTrickRoomSet(mon) {
    const ivs = (mon && mon.ivs) || {};
    const evs = (mon && mon.evs) || {};
    const natureId = toID(mon && mon.nature);
    if (ivs.spe !== 0) return false;
    if (SPEED_LOWERING_NATURES.has(natureId)) return true;
    if (SPEED_BOOSTING_NATURES.has(natureId)) return false;
    return (evs.spe || 0) <= 4;
  }

  /* ------------------------------------------------------------- stat parsing */

  /**
   * Parse a Showdown stat list such as '252+ Atk / 0 Spe / 4 SpD'.
   * Returns { stats: {hp,atk,def,spa,spd,spe}, boosted: {stat:true}, issues: string[] }.
   * `fallback` seeds stats that the line does not mention (0 for EVs, 31 for IVs).
   */
  function parseStatLine(text, fallback, opts) {
    opts = opts || {};
    const stats = Object.assign({}, fallback || U.ZERO_EVS);
    const boosted = {};
    const issues = [];
    const seen = {};
    const body = String(text || '').trim();
    if (!body) return { stats: stats, boosted: boosted, issues: issues };
    const tokens = body.split('/');
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i].trim();
      if (!token) continue;
      let value = null, statId = null, isPlus = false;
      let m = token.match(/(-?\d+)\s*(\+{0,2})\s*([A-Za-z][A-Za-z .'-]*)/);
      if (m) {
        value = parseInt(m[1], 10);
        isPlus = m[2].length > 0;
        statId = STAT_ALIASES[toID(m[3])] || null;
      } else {
        m = token.match(/([A-Za-z][A-Za-z .'-]*?)\s*[:=]?\s*(-?\d+)\s*(\+{0,2})/);
        if (m) {
          statId = STAT_ALIASES[toID(m[1])] || null;
          value = parseInt(m[2], 10);
          isPlus = m[3].length > 0;
        }
      }
      if (statId === null || value === null || value !== value) {
        issues.push('Could not read stat token: ' + token);
        continue;
      }
      const max = opts.iv ? 31 : 255;
      if (value < 0 || value > max) {
        issues.push('Out-of-range value for ' + statId + ': ' + value);
        value = U.clamp(value, 0, max);
      }
      if (opts.iv && value > 31) value = 31;
      if (seen[statId]) issues.push('Duplicate stat entry: ' + statId);
      seen[statId] = true;
      stats[statId] = value;
      if (isPlus) boosted[statId] = true;
    }
    if (!opts.iv) {
      // A "+" on a stat with no matching nature delta is a mild authoring error.
      Object.keys(stats).forEach(function (k) { if (stats[k] > 252) stats[k] = 252; });
    }
    return { stats: stats, boosted: boosted, issues: issues };
  }

  /* ---------------------------------------------------------- header parsing */

  /**
   * Parse a set header line: 'Nickname (Species) (M) @ Item', 'Species @ Item',
   * 'Type: Null @ Eviolite', 'Mr. Mime', 'Farfetch'd (F) @ Stick'.
   */
  function parseHeaderLine(line) {
    const header = { raw: line, nickname: '', species: '', item: '', gender: '' };
    let text = String(line || '').trim();
    const at = text.lastIndexOf(' @ ');
    if (at !== -1) {
      const after = text.slice(at + 3).trim();
      text = text.slice(0, at).trim();
      // '@ ' with nothing after it is an explicit itemless marker.
      header.item = after.replace(/^@\s*/, '').trim();
      if (toID(header.item) === 'none' || toID(header.item) === 'noitem') header.item = '';
    }
    let gender = '';
    const gm = text.match(/\((M|F|N)\)\s*$/i);
    if (gm && gm[1].length === 1) {
      gender = gm[1].toUpperCase();
      text = text.slice(0, gm.index).trim();
    }
    let species = '', nickname = '';
    const paren = text.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    if (paren && paren[2].trim()) {
      nickname = paren[1].trim();
      species = paren[2].trim();
    } else if (/\s\([^()]*\)$/.test(text)) {
      // Unbalanced parenthesis: keep the text verbatim.
      species = text;
    } else {
      species = text;
    }
    header.gender = gender;
    header.nickname = nickname;
    header.species = species;
    return header;
  }

  /** Resolve a possibly nicknamed/misspelled species string through the dex. */
  function resolveSpecies(input) {
    if (!input) return { species: '', known: false };
    const direct = U.getSpecies(input);
    if (direct) return { species: direct.name, known: true };
    const closest = U.closestSpeciesName(input);
    if (closest && U.getSpecies(closest)) return { species: closest, known: false };
    return { species: String(input).trim(), known: false };
  }

  /* ----------------------------------------------------------- paste parsing */

  function parsePokepaste(text) {
    const errors = [];
    const warnings = [];
    const pokemon = [];
    try {
      const source = String(text === null || text === undefined ? '' : text);
      const lines = source.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');
      let cur = null;
      let rawLines = [];

      function flush() {
        if (!cur) return;
        if (!cur.species && !cur.ability && !cur.item && !cur.moves.length && !cur.nature) {
          rawLines = [];
          cur = null;
          return;
        }
        cur.raw = rawLines.join('\n').trim();
        pokemon.push(finalizeSet(cur));
        rawLines = [];
        cur = null;
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) { flush(); continue; }
        if (SEPARATOR_LINE.test(trimmed)) { flush(); continue; }
        if (/^\/\//.test(trimmed)) { continue; } // free-floating comment
        if (/^#/.test(trimmed)) { continue; }

        const isIndented = /^\s/.test(line);

        if (!cur) {
          cur = emptySet();
          rawLines = [line];
          applyHeader(cur, trimmed, errors, warnings);
          continue;
        }

        // Known key line (Ability:, EVs:, Nature: ...) always belongs to the current set.
        if (KNOWN_KEYS.test(trimmed) || NATURE_LINE.test(trimmed) || NATURE_KEY_LINE.test(trimmed)) {
          rawLines.push(line);
          applyKeyLine(cur, trimmed, warnings);
          continue;
        }

        // 'Level: 100'-style lines can also appear without a colon-less form.
        if (/^level\s+\d+$/i.test(trimmed)) {
          rawLines.push(line);
          cur.level = U.clamp(parseInt(trimmed.match(/(\d+)/)[1], 10) || 100, 1, 100);
          continue;
        }

        const moveName = cleanMoveToken(trimmed);
        const moveData = moveName ? U.getMoveData(moveName) : null;

        if (isIndented) {
          rawLines.push(line);
          if (!moveName) continue;
          pushMove(cur, moveName, moveData, warnings);
          continue;
        }

        // Unindented: a real move name only if the dex knows it and the set is not
        // already full of moves; otherwise treat it as the next set's header.
        if (moveData && cur.moves.length < 4 && (cur.headerSeen === false || cur.moves.length > 0 || looksLikeMoveText(moveName))) {
          rawLines.push(line);
          pushMove(cur, moveName, moveData, warnings);
          continue;
        }

        const headerish = /@/.test(trimmed) || /\([^()]*\)\s*$/.test(trimmed) ||
          (cur.headerSeen && cur.moves.length === 0 && !cur.nature && !cur.ability && !cur.evsTouched);
        if (headerish || cur.moves.length > 0 || cur.nature || cur.ability || cur.item) {
          flush();
          cur = emptySet();
          rawLines = [line];
          applyHeader(cur, trimmed, errors, warnings);
          continue;
        }
        rawLines.push(line);
        applyKeyLine(cur, trimmed, warnings);
      }
      flush();

      pokemon.forEach(function (mon) {
        if (!mon.species) {
          errors.push('Set without a species: ' + (mon.raw || '').split('\n')[0]);
        } else if (!U.getSpecies(mon.species)) {
          errors.push('Unknown species: ' + mon.species);
        }
        if (mon.moves.length === 0) warnings.push(mon.species + ' has no moves listed.');
        if (!mon.nature) warnings.push(mon.species + ' has no nature; assuming neutral.');
        if (!mon.ability) warnings.push(mon.species + ' has no ability listed.');
      });
    } catch (err) {
      errors.push('Paste parse failure: ' + (err && err.message ? err.message : String(err)));
    }
    return { pokemon: pokemon.filter(function (p) { return !!p.species; }), errors: errors, warnings: warnings };
  }

  function looksLikeMoveText(name) {
    return /^[A-Z][A-Za-z0-9 '\u2019.-]{2,24}$/.test(name);
  }

  function cleanMoveToken(text) {
    let t = String(text || '').trim();
    if (!t) return '';
    t = t.replace(/^[-*\u2022]\s*/, '');            // '- Move' bullet style
    t = t.replace(/\s*\/\/.*$/, '');                // trailing comment
    t = t.replace(/\s*\[[^\]]*\]\s*$/, '');         // trailing [annotation]
    t = t.replace(/\s*\([^)]*\)\s*$/, '');          // trailing (annotation)
    return t.trim();
  }

  function pushMove(set, moveName, moveData, warnings) {
    const canonical = moveData ? moveData.name : moveName;
    if (set.moves.length >= 4) {
      warnings.push(set.species + ': more than four moves; ignoring ' + canonical);
      return;
    }
    if (set.moves.some(function (m) { return toID(m) === toID(canonical); })) return;
    if (!moveData) warnings.push('Unknown move kept as-is: ' + canonical);
    set.moves.push(canonical);
  }

  function applyHeader(set, trimmed, errors, warnings) {
    const header = parseHeaderLine(trimmed);
    const resolved = resolveSpecies(header.species);
    set.headerSeen = true;
    set.species = resolved.species;
    set.nickname = header.nickname && toID(header.nickname) !== toID(resolved.species) ? header.nickname : '';
    set.name = resolved.species || header.nickname || '';
    if (header.item) set.item = header.item;
    if (header.gender) set.gender = header.gender;
    if (!resolved.known && header.species) {
      warnings.push('Species not found in the NatDex dex: ' + header.species);
    }
    return set;
  }

  function applyKeyLine(set, trimmed, warnings) {
    let m;
    if ((m = trimmed.match(/^ability\s*:\s*(.+)$/i))) { set.ability = m[1].trim(); return; }
    if ((m = trimmed.match(/^level\s*:\s*(\d+)/i))) {
      set.level = U.clamp(parseInt(m[1], 10) || 100, 1, 100);
      return;
    }
    if ((m = trimmed.match(/^shiny\s*:\s*(yes|no|true|false)/i))) {
      set.shiny = /^(yes|true)$/i.test(m[1]);
      return;
    }
    if ((m = trimmed.match(/^happiness\s*:\s*(\d+)/i))) { set.happiness = parseInt(m[1], 10); return; }
    if ((m = trimmed.match(/^tera\s*type\s*:\s*(.+)$/i))) { set.teraType = m[1].trim(); return; }
    if ((m = trimmed.match(/^evs?\s*:\s*(.*)$/i))) {
      const parsed = parseStatLine(m[1], U.ZERO_EVS, { iv: false });
      set.evs = parsed.stats;
      set.evsTouched = true;
      parsed.issues.forEach(function (issue) { warnings.push(issue); });
      return;
    }
    if ((m = trimmed.match(/^ivs?\s*:\s*(.*)$/i))) {
      const parsed = parseStatLine(m[1], U.DEFAULT_IVS, { iv: true });
      set.ivs = parsed.stats;
      set.ivsTouched = true;
      parsed.issues.forEach(function (issue) { warnings.push(issue); });
      return;
    }
    if ((m = trimmed.match(NATURE_LINE)) || (m = trimmed.match(NATURE_KEY_LINE))) {
      const nature = m[1].trim();
      const id = toID(nature);
      if (ALL_NATURE_IDS.has(id)) {
        // Store the dex-cased nature name when we can find it.
        const natures = (U.CALC && U.CALC.NATURES) || {};
        let display = nature;
        Object.keys(natures).forEach(function (n) { if (toID(n) === id) display = n; });
        set.nature = display;
      } else {
        set.nature = nature;
        warnings.push('Unrecognised nature: ' + nature);
      }
      return;
    }
    if (/^(ball|pokeball|ot|nickname|friend\s*code|status|gigantamax|dynamax\s*level|hidden\s*power)\s*:/i.test(trimmed)) {
      if (/^hidden\s*power\s*:/i.test(trimmed) && (m = trimmed.match(/^hidden\s*power\s*:\s*([A-Za-z]+)/i))) {
        set.unknown.push('Hidden Power: ' + m[1]);
      }
      return;
    }
    set.unknown.push(trimmed);
  }

  /* ---------------------------------------------------------- packed parsing */

  /**
   * Showdown packed-team format:
   *   name|species|item|ability|moves|nature|evs|gender|ivs|shiny|level
   *   ...then optional happiness, pokeball, hiddenpower, gigantamax, dynamaxLevel, teraType.
   */
  function parsePackedTeam(packed) {
    const errors = [];
    const warnings = [];
    const pokemon = [];
    try {
      const source = String(packed === null || packed === undefined ? '' : packed).trim();
      if (!source) return { pokemon: pokemon, errors: errors, warnings: warnings };
      const chunks = source.split('\n').filter(function (c) { return c.trim().length > 0; });
      chunks.forEach(function (chunk, chunkIndex) {
        const parts = chunk.split('|');
        if (parts.length < 6) {
          errors.push('Malformed packed set #' + (chunkIndex + 1) + ' (only ' + parts.length + ' fields)');
          return;
        }
        const set = emptySet();
        const rawName = (parts[0] || '').trim();
        const rawSpecies = (parts[1] || '').trim();
        const header = parseHeaderLine(rawName || rawSpecies);
        const resolved = resolveSpecies(rawSpecies || header.species || rawName);
        set.species = resolved.species;
        set.nickname = rawName && toID(rawName) !== toID(resolved.species) ? header.nickname || header.species || rawName : '';
        set.name = resolved.species;
        set.headerSeen = true;
        if (!resolved.known) warnings.push('Species not found in the NatDex dex: ' + (rawSpecies || rawName));
        // The packed format stores ids ('choicescarf'); normalise them to display names so
        // the state manager, the pruner and the calculator all speak one vocabulary.
        const rawItem = (parts[2] || '').trim();
        const rawAbility = (parts[3] || '').trim();
        set.item = rawItem ? (U.itemName ? U.itemName(rawItem) : rawItem) : '';
        set.ability = rawAbility ? (U.abilityName ? U.abilityName(rawAbility) : rawAbility) : '';
        set.moves = (parts[4] || '').split(',').map(function (m) { return m.trim(); })
          .filter(function (m) { return m.length > 0; }).slice(0, 4)
          .map(function (m) {
            const data = U.getMoveData(m);
            if (!data) warnings.push('Unknown move kept as-is: ' + m);
            return data ? data.name : m;
          });
        set.nature = (parts[5] || '').trim();
        const evParsed = parseStatLine(splitCommaStats(parts[6]), U.ZERO_EVS, { iv: false });
        set.evs = evParsed.stats;
        set.gender = (parts[7] || '').trim().toUpperCase().slice(0, 1);
        const ivParsed = parseStatLine(splitCommaStats(parts[8]), U.DEFAULT_IVS, { iv: true });
        set.ivs = ivParsed.stats;
        const shinyField = (parts[9] || '').trim();
        set.shiny = /^s$/i.test(shinyField) || /^yes$/i.test(shinyField);
        if (parts[10]) {
          const lvl = parseInt(parts[10], 10);
          if (lvl >= 1 && lvl <= 100) set.level = lvl;
        }
        if (parts[11] !== undefined && parts[11] !== '') {
          const hap = parseInt(parts[11], 10);
          if (hap >= 0 && hap <= 255) set.happiness = hap;
        }
        if (parts[16] !== undefined && parts[16] !== '') set.teraType = String(parts[16]).trim();
        set.raw = chunk;
        set.moves.forEach(function (mv, idx) { if (!mv) set.moves.splice(idx, 1); });
        pokemon.push(finalizeSet(set));
      });
    } catch (err) {
      errors.push('Packed parse failure: ' + (err && err.message ? err.message : String(err)));
    }
    return { pokemon: pokemon, errors: errors, warnings: warnings };
  }

  /** '0,252,0,0,4,252' -> '0 HP / 252 Atk / 0 Def / 0 SpA / 4 SpD / 252 Spe' */
  function splitCommaStats(field) {
    if (!field) return '';
    const values = String(field).split(',');
    const names = ['HP', 'Atk', 'Def', 'SpA', 'SpD', 'Spe'];
    const out = [];
    for (let i = 0; i < values.length && i < 6; i++) {
      const v = values[i].trim();
      if (v === '') out.push('0 ' + names[i]);
      else out.push(v + ' ' + names[i]);
    }
    return out.join(' / ');
  }

  /* ---------------------------------------------------- localStorage extract */

  function safeGetItem(store, key) {
    try { return store.getItem(key); } catch (e) { return null; }
  }

  function localStorageRef() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    } catch (e) { /* access can throw in sandboxed frames */ }
    return null;
  }

  function keyList(store) {
    const keys = [];
    try {
      if (typeof store.length === 'number' && typeof store.key === 'function') {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (k) keys.push(k);
        }
      }
    } catch (e) { /* ignore */ }
    return keys;
  }

  /** Turn whatever Showdown stored under one key into a list of raw team strings. */
  function expandStorageValue(raw, key) {
    const out = [];
    if (!raw) return out;
    const text = String(raw).trim();
    if (!text) return out;
    if (text[0] === '[' || text[0] === '{') {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
      if (parsed) {
        const push = function (value, name) {
          if (!value) return;
          if (typeof value === 'string') out.push({ raw: value, name: name || '' });
          else if (typeof value === 'object') {
            const body = value.packed || value.team || value.paste || value.text || value.value;
            if (typeof body === 'string') out.push({ raw: body, name: value.name || value.title || name || '' });
            else if (Array.isArray(body)) out.push({ raw: JSON.stringify(body), name: value.name || name || '' });
          }
        };
        if (Array.isArray(parsed)) parsed.forEach(function (v) { push(v, key); });
        else Object.keys(parsed).forEach(function (k) { push(parsed[k], k); });
        if (out.length) return out;
      }
    }
    out.push({ raw: text, name: key });
    return out;
  }

  function buildStoredTeam(raw, name, index) {
    const looksPacked = raw.indexOf('|') !== -1 && raw.indexOf('\n') === -1;
    const parsed = looksPacked ? parsePackedTeam(raw) : parsePokepaste(raw);
    let pokemon = parsed.pokemon;
    if (pokemon.length === 0 && looksPacked === false && raw.indexOf('|') !== -1) {
      // A single-line packed team that still contains newlines is rare; try the other codec.
      const alt = parsePackedTeam(raw);
      if (alt.pokemon.length) return buildStoredTeamFrom(alt.pokemon, raw, name, index, true);
    }
    if (pokemon.length === 0) {
      return { id: 'stored-' + index, name: name || ('Team ' + (index + 1)), paste: looksPacked ? '' : raw,
        packed: looksPacked ? raw : '', pokemon: [], invalid: true,
        errors: parsed.errors.concat(parsed.warnings) };
    }
    return buildStoredTeamFrom(pokemon, raw, name, index, looksPacked);
  }

  function buildStoredTeamFrom(pokemon, raw, name, index, wasPacked) {
    const species = pokemon.map(function (p) { return p.species; });
    return {
      id: 'stored-' + index,
      name: name || species.slice(0, 2).join(' / ') || ('Team ' + (index + 1)),
      paste: wasPacked ? pokemon.map(toShowdownSet).join('\n\n') : raw,
      packed: wasPacked ? raw : '',
      pokemon: pokemon,
      species: species,
      trCount: pokemon.filter(function (p) { return p.isTR; }).length,
      invalid: false
    };
  }

  function extractFromLocalStorage(storage) {
    const out = [];
    try {
      const store = storage || localStorageRef();
      if (!store || typeof store.getItem !== 'function') return out;
      const keys = keyList(store);
      const relevant = keys.filter(function (k) {
        return /^showdown_teams?$/i.test(k) || /^showdown_teams?[_:-]/i.test(k) ||
          /^showdown_team_/i.test(k) || /^showdown_battle_teams?$/i.test(k) ||
          /^showdown_battle_templates?$/i.test(k);
      });
      if (relevant.length === 0 && safeGetItem(store, 'showdown_teams') !== null) relevant.push('showdown_teams');
      relevant.sort(function (a, b) {
        if (/^showdown_teams$/i.test(a)) return -1;
        if (/^showdown_teams$/i.test(b)) return 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      const seenSignatures = {};
      let counter = 0;
      relevant.forEach(function (key) {
        const raw = safeGetItem(store, key);
        expandStorageValue(raw, key).forEach(function (entry) {
          const stored = buildStoredTeam(entry.raw, entry.name, counter);
          counter++;
          const signature = (stored.species || []).slice().sort().join(',');
          if (!signature) return;
          if (seenSignatures[signature]) return; // Showdown mirrors teams across keys
          seenSignatures[signature] = true;
          out.push(stored);
        });
      });
    } catch (err) {
      U.debug('extractFromLocalStorage failed', err);
    }
    return out;
  }

  /* ------------------------------------------------------------ team matching */

  function baseSpeciesOf(name) {
    const sp = U.getSpecies(name);
    if (!sp) return toID(name);
    return toID(sp.baseSpecies || sp.name);
  }

  /** Accepts strings, MonState objects, ParsedMon objects or nested {pokemon:[...]}. */
  function normalizeActiveList(list) {
    const out = [];
    if (!list) return out;
    const items = Array.isArray(list) ? list : [list];
    items.forEach(function (entry) {
      if (!entry) return;
      if (typeof entry === 'string') { out.push(entry); return; }
      if (entry.species || entry.name) { out.push(entry.species || entry.name); return; }
      if (entry.id) { const sp = U.getSpecies(entry.id); out.push(sp ? sp.name : entry.id); return; }
      if (Array.isArray(entry.pokemon)) entry.pokemon.forEach(function (p) { if (p && (p.species || p.name)) out.push(p.species || p.name); });
    });
    return out.filter(function (s) { return !!s; });
  }

  function storedTeamPokemon(entry) {
    if (!entry) return [];
    if (Array.isArray(entry)) return entry;
    if (Array.isArray(entry.pokemon)) return entry.pokemon;
    if (Array.isArray(entry.species)) return entry.species.map(function (s) { return { species: s }; });
    if (typeof entry.paste === 'string' && entry.paste) return parsePokepaste(entry.paste).pokemon;
    if (typeof entry.packed === 'string' && entry.packed) return parsePackedTeam(entry.packed).pokemon;
    if (typeof entry === 'string') return parsePokepaste(entry).pokemon;
    return [];
  }

  function scoreTeam(activeSpecies, entry) {
    const mons = storedTeamPokemon(entry);
    const teamIds = {};
    const teamBases = {};
    mons.forEach(function (mon) {
      const name = mon && (mon.species || mon.name);
      if (!name) return;
      const sp = U.getSpecies(name);
      const id = sp ? sp.id : toID(name);
      teamIds[id] = true;
      teamBases[baseSpeciesOf(name)] = true;
    });
    let exact = 0, forme = 0, missed = [];
    activeSpecies.forEach(function (species) {
      const sp = U.getSpecies(species);
      const id = sp ? sp.id : toID(species);
      if (teamIds[id]) { exact++; return; }
      const base = baseSpeciesOf(species);
      if (teamBases[base]) { forme += 1; return; }
      missed.push(species);
    });
    const total = activeSpecies.length || 1;
    const matched = exact + forme;
    const score = total ? matched / total : 0;
    return { score: score, exact: exact, forme: forme, matched: matched, total: total, missed: missed, teamSize: mons.length };
  }

  /**
   * Pick the stored team matching the six Pokémon currently in the battle.
   * The returned object is the stored team itself, augmented with matchScore (the NUMBER of
   * species that matched), matchRatio (that count over the roster size), matchedSpecies,
   * missedSpecies and exactMatches (identity is preserved so callers can compare references
   * against their own array).
   */
  function matchActiveTeam(battlePokemonList, storedTeams) {
    const active = normalizeActiveList(battlePokemonList);
    const teams = Array.isArray(storedTeams) ? storedTeams : [];
    if (active.length === 0 || teams.length === 0) return null;
    const required = active.length >= 6 ? 6 : active.length;
    let best = null, bestResult = null;
    teams.forEach(function (entry) {
      const result = scoreTeam(active, entry);
      if (!bestResult || result.score > bestResult.score ||
          (result.score === bestResult.score && result.exact > bestResult.exact)) {
        best = entry; bestResult = result;
      }
    });
    if (!best) return null;
    const fullMatch = bestResult.matched >= required;
    // With a single stored team, a partial match is still the only sane answer.
    const singleRescue = teams.length === 1 && bestResult.matched >= Math.ceil(required / 2);
    if (!fullMatch && !singleRescue) return null;
    if (!fullMatch && singleRescue && bestResult.missed.length) {
      U.debug('matchActiveTeam: single-team rescue, missing', bestResult.missed);
    }
    try {
      Object.assign(best, {
        matchScore: bestResult.matched,
        matchRatio: bestResult.score,
        matchTotal: bestResult.total,
        exactMatches: bestResult.exact,
        formeMatches: bestResult.forme,
        matchedSpecies: active.filter(function (s) { return bestResult.missed.indexOf(s) === -1; }),
        missedSpecies: bestResult.missed
      });
    } catch (e) { /* frozen object: return un-augmented */ }
    return best;
  }

  /* -------------------------------------------------------------- export text */

  function toShowdownSet(mon) {
    if (!mon) return '';
    const species = mon.species || mon.name || '';
    const nickname = mon.nickname && toID(mon.nickname) !== toID(species) ? mon.nickname : '';
    const lines = [];
    let header = nickname ? nickname + ' (' + species + ')' : species;
    if (mon.gender && (mon.gender === 'M' || mon.gender === 'F')) header += ' (' + mon.gender + ')';
    if (mon.item) header += ' @ ' + mon.item;
    lines.push(header);
    if (mon.ability) lines.push('Ability: ' + mon.ability);
    if (mon.level && mon.level !== 100) lines.push('Level: ' + mon.level);
    if (mon.shiny) lines.push('Shiny: Yes');
    if (mon.happiness !== null && mon.happiness !== undefined && mon.happiness !== 255) lines.push('Happiness: ' + mon.happiness);
    if (mon.teraType) lines.push('Tera Type: ' + mon.teraType);
    const evs = mon.evs || U.ZERO_EVS;
    const evPieces = [];
    STAT_KEYS.forEach(function (k) {
      const v = evs[k];
      if (v) evPieces.push(v + ' ' + STAT_LABEL[k]);
    });
    if (evPieces.length) lines.push('EVs: ' + evPieces.join(' / '));
    if (mon.nature) lines.push(mon.nature + ' Nature');
    const ivs = mon.ivs || U.DEFAULT_IVS;
    const ivPieces = [];
    STAT_KEYS.forEach(function (k) {
      const v = ivs[k];
      if (v !== 31 && v !== undefined && v !== null) ivPieces.push(v + ' ' + STAT_LABEL[k]);
    });
    if (ivPieces.length) lines.push('IVs: ' + ivPieces.join(' / '));
    (mon.moves || []).slice(0, 4).forEach(function (mv) { if (mv) lines.push('- ' + mv); });
    return lines.join('\n');
  }

  const STAT_LABEL = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

  /** Pack a ParsedMon back into Showdown's packed format (used by options.js). */
  function toPackedSet(mon) {
    if (!mon) return '';
    const species = mon.species || mon.name || '';
    const name = mon.nickname || species;
    const evs = Object.assign({}, U.ZERO_EVS, mon.evs);
    const ivs = Object.assign({}, U.DEFAULT_IVS, mon.ivs);
    const fields = [
      name, species, mon.item || '', mon.ability || '',
      (mon.moves || []).join(','), mon.nature || '',
      STAT_KEYS.map(function (k) { return evs[k] || 0; }).join(','),
      mon.gender || '',
      STAT_KEYS.map(function (k) { return typeof ivs[k] === 'number' ? ivs[k] : 31; }).join(','),
      mon.shiny ? 'S' : '',
      mon.level || 100
    ];
    return fields.join('|');
  }

  function packTeam(pokemon) {
    return (pokemon || []).map(toPackedSet).join('\n');
  }

  function teamSummary(parsedMons) {
    const list = parsedMons || [];
    const names = list.map(function (p) { return p.species || p.name; }).filter(Boolean);
    const trMons = list.filter(function (p) { return p.isTR; }).map(function (p) { return p.species || p.name; });
    const zeroSpeIvs = list.filter(function (p) { return p.ivs && p.ivs.spe === 0; })
      .map(function (p) { return p.species || p.name; });
    return {
      count: names.length,
      species: names,
      trCount: trMons.length,
      trPokemon: trMons,
      zeroSpeIvs: zeroSpeIvs,
      complete: names.length === 6
    };
  }

  /** Validate a paste/team for the options page. */
  function validate(text) {
    const parsed = parsePokepaste(text);
    const summary = teamSummary(parsed.pokemon);
    return {
      ok: parsed.pokemon.length > 0 && parsed.errors.length === 0,
      parsed: parsed,
      summary: summary,
      messages: parsed.errors.concat(parsed.warnings)
    };
  }

  class TeamParser {
    constructor(options) {
      options = options || {};
      this.maxTeams = options.maxTeams || 32;
      this.storageKey = options.storageKey || 'showdown_teams';
      this.lastParse = null;
    }
    parsePokepaste(text) {
      const result = parsePokepaste(text);
      this.lastParse = result;
      return result;
    }
    parsePackedTeam(packed) {
      const result = parsePackedTeam(packed);
      this.lastParse = result;
      return result;
    }
    extractFromLocalStorage(storage) {
      return extractFromLocalStorage(storage || this.storageRef()).slice(0, this.maxTeams);
    }
    matchActiveTeam(battlePokemonList, storedTeams) {
      return matchActiveTeam(battlePokemonList, storedTeams);
    }
    toShowdownSet(parsedMon) { return toShowdownSet(parsedMon); }
    toPackedSet(parsedMon) { return toPackedSet(parsedMon); }
    packTeam(pokemon) { return packTeam(pokemon); }
    teamSummary(pokemon) { return teamSummary(pokemon); }
    validate(text) { return validate(text); }
    isTrickRoomSet(mon) { return isTrickRoomSet(mon); }
    storageRef() {
      try { return window.localStorage; } catch (e) { return null; }
    }
    /** Best-effort: paste text -> ParsedMon[] with the same rules the engine uses. */
    parseAny(text) {
      const body = String(text === null || text === undefined ? '' : text);
      if (body.indexOf('\n') === -1 && body.indexOf('|') !== -1) return this.parsePackedTeam(body);
      const paste = this.parsePokepaste(body);
      if (paste.pokemon.length) return paste;
      return this.parsePackedTeam(body);
    }
  }

  TeamParser.parseStatLine = parseStatLine;
  TeamParser.parseHeaderLine = parseHeaderLine;
  TeamParser.isTrickRoomSet = isTrickRoomSet;
  TeamParser.toShowdownSet = toShowdownSet;
  TeamParser.toPackedSet = toPackedSet;
  TeamParser.packTeam = packTeam;
  TeamParser.teamSummary = teamSummary;
  TeamParser.scoreTeam = scoreTeam;
  // Static delegates: content.js, options.js and the test suite drive the parser without
  // instantiating it, so the stateless entry points are mirrored onto the constructor.
  ['parsePokepaste', 'parsePackedTeam', 'extractFromLocalStorage', 'matchActiveTeam',
    'toShowdownSet', 'teamSummary', 'validate'].forEach(function (name) {
    if (typeof TeamParser.prototype[name] !== 'function') return;
    TeamParser[name] = function () {
      const instance = new TeamParser();
      return instance[name].apply(instance, arguments);
    };
  });

  TeamParser.STAT_KEYS = STAT_KEYS;
  TeamParser.STAT_LABEL = STAT_LABEL;
  TeamParser.SPEED_LOWERING_NATURES = SPEED_LOWERING_NATURES;

  ST.TeamParser = TeamParser;
})();
