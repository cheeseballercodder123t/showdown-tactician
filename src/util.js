/* Showdown Tactician — src/util.js
 * The project's DEX BOUNDARY: the only module that reads the vendored @smogon/calc dex
 * (species, moves, items, abilities, the type chart, natures) and the only one that asks it
 * for a stat number (`calc.Stats.calcStat`). Damage itself is not computed here —
 * src/calc_engine.js is the one place allowed to call `calc.calculate(...)`.
 * Everything else consumes ST.util. Never throws: unknown data degrades gracefully.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  if (ST.util) return;

  const CALC = window.calc || null;
  const GEN_NUM = 9;
  const gen = CALC && CALC.Generations ? CALC.Generations.get(GEN_NUM) : null;
  const RAW_SPECIES = (CALC && CALC.SPECIES && CALC.SPECIES[GEN_NUM]) || {};
  const RAW_MOVES = (CALC && CALC.MOVES && CALC.MOVES[GEN_NUM]) || {};
  const ITEM_LIST = (CALC && CALC.ITEMS && CALC.ITEMS[GEN_NUM]) || [];
  const ABILITY_LIST = (CALC && CALC.ABILITIES && CALC.ABILITIES[GEN_NUM]) || [];
  const TYPE_CHART = (CALC && CALC.TYPE_CHART && CALC.TYPE_CHART[GEN_NUM]) || {};
  const NATURES = (CALC && CALC.NATURES) || {};
  const MEGA_STONES = (CALC && CALC.MEGA_STONES) || {};

  const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
  const TYPES = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel',
    'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark', 'Fairy', 'Stellar'];
  const DEFAULT_IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  const ZERO_EVS = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

  /**
   * The moves that actually BLOCK an incoming attack: the nine protection moves plus Max Guard.
   *
   * `shelter` used to sit here and it does not belong: no generation gives Shelter any protection
   * effect, so the entry made `isProtect` true for a move that shields nothing, and _trackProtect
   * (src/state_manager.js), the tempo rhythm (src/tempo_vector.js) and `quiescence.blockProtect`
   * would all credit a blocked attack from it. It was ALSO in the pruner's UNPREDICTABLE_DAMAGE
   * list — a list of conditional-power DAMAGING moves — and those two readings cannot both be
   * right, so it is now in neither: it is neither a shield nor an HP-moving move.
   */
  const PROTECT_MOVES = new Set(['protect', 'detect', 'kingsshield', 'banefulbunker', 'spikyshield',
    'silktrap', 'burningbulwark', 'obstruct', 'maxguard']);
  const RECOVERY_MOVES = new Set(['recover', 'roost', 'slackoff', 'softboiled', 'milkdrink', 'shoreup',
    'healorder', 'synthesis', 'moonlight', 'morningsun', 'strengthsap', 'wish', 'rest']);
  const RECOVERY_8PP = new Set(['recover', 'roost', 'slackoff', 'softboiled', 'milkdrink', 'shoreup', 'healorder']);
  const PIVOT_MOVES = new Set(['uturn', 'voltswitch', 'flipturn', 'teleport', 'chillyreception',
    'partingshot', 'batonpass', 'shedtail']);
  const HAZARD_MOVES = new Set(['stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'ceaselessedge', 'stoneaxe']);
  const HAZARD_REMOVAL_MOVES = new Set(['rapidspin', 'defog', 'mortalspin', 'tidyup', 'courtchange']);

  /**
   * Each hazard-setting move -> the state key it lands on and the most it can stack.
   * `key` names `state.field.hazards[side]` as state_manager.emptyHazards() defines it, so a
   * caller can read what is already up without a second vocabulary. Clashing moves share a key
   * on purpose (Ceaseless Edge sets Spikes); the layer cap is the move's own, not the key's.
   */
  const HAZARD_LAYERS = {
    stealthrock: { key: 'rocks', max: 1 },
    stoneaxe: { key: 'rocks', max: 1 },
    spikes: { key: 'spikes', max: 3 },
    ceaselessedge: { key: 'spikes', max: 3 },
    toxicspikes: { key: 'toxicspikes', max: 2 },
    stickyweb: { key: 'stickyweb', max: 1 }
  };

  /**
   * The moves that take hazards off OUR side only. Court Change is deliberately absent: it SWAPS
   * the two sides, so it is worth a turn even when our side is already clean. Everything else
   * here (Rapid Spin, Mortal Spin, Defog, Tidy Up) removes hazards and nothing more, which is
   * what makes "there is nothing to clear" a decidable statement.
   */
  const HAZARD_CLEAR_MOVES = new Set(['rapidspin', 'mortalspin', 'defog', 'tidyup']);

  /** The weather each setting move puts up, in the protocol's own vocabulary (see the parser's
   *  WEATHER_IDS), so a comparison never has to translate between two spellings. Chilly
   *  Reception and Snowscape both bring snow, which is why this is a map and not a set. */
  const WEATHER_BY_MOVE = {
    raindance: 'rain',
    sunnyday: 'sun',
    sandstorm: 'sandstorm',
    snowscape: 'snow',
    chillyreception: 'snow'
  };

  /** The weather family a field value belongs to: heavy rain still IS rain, and hail is snow. */
  function weatherFamily(weather) {
    const id = toID(weather || '');
    if (id === 'harshsun') return 'sun';
    if (id === 'heavyrain') return 'rain';
    if (id === 'hail') return 'snow';
    return id;
  }
  const SETUP_MOVES = new Set(['swordsdance', 'nastyplot', 'dragondance', 'calmmind', 'bulkup', 'quiverdance',
    'shellsmash', 'irondefense', 'amnesia', 'agility', 'rockpolish', 'shiftgear', 'clangoroussoul',
    'tidyup', 'victorydance', 'takeheart', 'growth', 'howl', 'workup', 'tailglow', 'bellydrum',
    'filletaway', 'coil', 'honeclaws', 'cosmicpower', 'autotomize', 'noretreat', 'meditate', 'sharpen']);

  /* What a setup move does to ITS USER. These are GAME RULES with a single correct value, like
   * "Trick Room lasts 5 turns" or "Earthquake is 100 BP" — not heuristics, and not guesses about a
   * species. They live here, beside SETUP_MOVES, because the vendored dex cannot answer the
   * question: `calc.MOVES[9]` carries only what a DAMAGE calculator needs, and to a damage
   * calculator a stat boost is an INPUT, not an effect, so `getMoveData('Dragon Dance')` knows the
   * move is setup and nothing about the +1 Atk / +1 Spe it grants. Every entry below is one of the
   * 29 SETUP_MOVES, so a move can never be classified as setup and then priced as a no-op.
   *
   * `hpCostPct` is the fraction of MAX HP the user pays (Belly Drum 50, Clangorous Soul 33); the
   * move FAILS below that fraction (Showdown refuses it), and the caller treats a failed setup as
   * the wasted turn it is rather than granting a free boost.
   *
   * NOT MODELLED, deliberately: weather- and screen-dependent variants (Growth is +1/+1 in clear
   * weather and +2/+2 in sun). The no-weather value is the one below; the extension that consumes
   * this table prices those as their base value instead of inventing a weather rule.
   *
   * `accuracy` IS modelled (it is one of BOOST_KEYS), so Coil and Hone Claws are recorded exactly
   * rather than rounded down to their Attack. Also NOT MODELLED inside an entry, and stated here
   * rather than hidden: No Retreat makes its user unable to switch out and the table has no
   * switch-lock field, so only its five +1 boosts are priced; Fillet Away's HP price IS modelled,
   * through the same `hpCostPct` shape Belly Drum already uses.
   *
   * NOT IN THIS TABLE, deliberately, so that it is not "fixed" later: Curse (its effect depends on
   * the user's type), Double Team and Minimize (Evasion Clause), Acupressure (the boosted stat is
   * random) and Geomancy (it spends a turn charging). Shelter is absent for a different reason: it
   * is not a setup move this file can price without guessing. */
  const SETUP_BOOSTS = {
    swordsdance: { atk: 2 },
    nastyplot: { spa: 2 },
    dragondance: { atk: 1, spe: 1 },
    calmmind: { spa: 1, spd: 1 },
    bulkup: { atk: 1, def: 1 },
    quiverdance: { spa: 1, spd: 1, spe: 1 },
    shellsmash: { atk: 2, spa: 2, spe: 2, def: -1, spd: -1 },
    irondefense: { def: 2 },
    amnesia: { spd: 2 },
    agility: { spe: 2 },
    rockpolish: { spe: 2 },
    shiftgear: { atk: 1, spe: 2 },
    clangoroussoul: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1, hpCostPct: 33 },
    tidyup: { atk: 1, spe: 1 },
    victorydance: { atk: 1, def: 1, spe: 1 },
    takeheart: { spa: 1, spd: 1 },
    growth: { atk: 1, spa: 1 },
    howl: { atk: 1 },
    workup: { atk: 1, spa: 1 },
    tailglow: { spa: 3 },
    bellydrum: { atk: 6, hpCostPct: 50 },
    filletaway: { atk: 2, spa: 2, spe: 2, hpCostPct: 50 },
    coil: { atk: 1, def: 1, accuracy: 1 },
    honeclaws: { atk: 1, accuracy: 1 },
    cosmicpower: { def: 1, spd: 1 },
    autotomize: { spe: 2 },
    noretreat: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 },
    meditate: { atk: 1 },
    sharpen: { atk: 1 }
  };

  const BOOST_KEYS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];

  /**
   * setupBoosts(name) -> { atk?, ..., hpCostPct? } | null
   * A copy, so a caller can merge it into a stat table without writing through the table above.
   * Null for anything that is not one of the 29 SETUP_MOVES (an unknown move is not a setup).
   */
  function setupBoosts(name) {
    const id = toID(name);
    const spec = id && SETUP_BOOSTS[id];
    if (!spec) return null;
    const out = {};
    for (let i = 0; i < BOOST_KEYS.length; i++) {
      const k = BOOST_KEYS[i];
      if (typeof spec[k] === 'number' && spec[k]) out[k] = spec[k];
    }
    if (typeof spec.hpCostPct === 'number') out.hpCostPct = spec.hpCostPct;
    return out;
  }
  const CHOICE_ITEMS = ['Choice Band', 'Choice Specs', 'Choice Scarf'];
  const CHOICE_IDS = new Set(['choiceband', 'choicespecs', 'choicescarf']);
  const TYPE_Z_CRYSTALS = ['Normalium Z', 'Fightinium Z', 'Flyinium Z', 'Poisonium Z', 'Groundium Z',
    'Rockium Z', 'Buginium Z', 'Ghostium Z', 'Steelium Z', 'Firium Z', 'Waterium Z', 'Grassium Z',
    'Electrium Z', 'Psychium Z', 'Icium Z', 'Dragonium Z', 'Darkinium Z', 'Fairium Z'];
  const SIGNATURE_Z_CRYSTALS = ['Aloraichium Z', 'Decidium Z', 'Eevium Z', 'Incinium Z', 'Kommonium Z',
    'Lunalium Z', 'Lycanium Z', 'Marshadium Z', 'Mewnium Z', 'Mimikium Z', 'Pikanium Z', 'Pikashunium Z',
    'Primarium Z', 'Snorlium Z', 'Solganium Z', 'Tapunium Z', 'Ultranecrozium Z'];
  const Z_CRYSTALS = TYPE_Z_CRYSTALS.concat(SIGNATURE_Z_CRYSTALS);
  const Z_CRYSTAL_IDS = new Set(Z_CRYSTALS.map(function (z) { return z.toLowerCase().replace(/[^a-z0-9]+/g, ''); }));

  const PARADOX_ABILITIES = new Set(['protosynthesis', 'quarkdrive']);
  const LEVITATE_LIKE = new Set(['levitate', 'earthEater', 'eartheater']);
  const WATER_ABSORB = new Set(['waterabsorb', 'stormdrain', 'dryskin']);
  const ELECTRIC_ABSORB = new Set(['voltabsorb', 'lightningrod', 'motordrive']);
  const FIRE_ABSORB = new Set(['flashfire', 'wellbakedbody']);
  const GRASS_ABSORB = new Set(['sapsipper']);
  const UNBLOCKABLE_STATUS_ABILITY = new Set(['goodasgold']);

  /* Status-immunity abilities. GAME RULES with a single correct value, like the absorb sets above:
   * each names a status the ability makes impossible, so an OBSERVED status condition on a body is
   * positive evidence against every candidate set carrying one of them. Two of them are
   * unconditional immunities to EVERY status — Comatose (the holder is permanently asleep and so
   * can never be given one) and Purifying Salt — which is why they recur in all six buckets.
   *
   * NOT MODELLED, deliberately: conditional shields (Leaf Guard prevents status only in sun) and
   * cures rather than prevention (Shed Skin, Hydration). A rule that eliminates a set has to hold
   * in every board, and those do not. */
  const STATUS_IMMUNITY_ABILITIES = {
    // Magma Armor is NOT a burn immunity — it prevents FREEZE only, and it is correctly listed
    // under `frz` below. It used to sit here, which made an ordinary burn eliminate every Magma
    // Armor set: a false elimination on evidence that does not disprove it. Water Bubble, which
    // does prevent burns outright, was missing and has been added.
    brn: new Set(['waterveil', 'waterbubble', 'thermalexchange', 'comatose', 'purifyingsalt']),
    psn: new Set(['immunity', 'pastelveil', 'comatose', 'purifyingsalt']),
    tox: new Set(['immunity', 'pastelveil', 'comatose', 'purifyingsalt']),
    par: new Set(['limber', 'comatose', 'purifyingsalt']),
    slp: new Set(['insomnia', 'vitalspirit', 'sweetveil', 'comatose', 'purifyingsalt']),
    frz: new Set(['magmaarmor', 'comatose', 'purifyingsalt'])
  };
  const NO_ABILITIES = new Set();

  /* Status-INFLICTING MOVES: the condition a move is BUILT to give, keyed by status then by move
   * id. This is the leaf-transition half of the status channel (laplace.priceMyMoveStatus): the
   * 128D evaluator carries fitted weights for dims 24..35 (status counts, ours and theirs), 117
   * (the status differential) and 32..35 (our active body's condition), and until this table
   * existed nothing told `_payoff` which condition a candidate MOVE would write, so every status
   * move was priced on a leaf board where the condition it exists to give was absent.
   *
   * WHAT IS IN, AND WHAT IS DELIBERATELY OUT. Only a move whose PRIMARY effect is the status is
   * listed. A secondary chance on a move that is really an attack (Body Slam's 30 % paralysis,
   * Ice Beam's 10 % freeze, Malignant Chain's 50 % toxic) is NOT here: the leaf is a deterministic
   * board, so a coin flip has to be priced as one, and the tier refuses to do that silently.
   * Conditional inflictions are out for the same reason (Burning Jealousy needs a stat boost
   * first, Shell Side Arm depends on the target's weaker defence). `frz` has no deterministic
   * inflicter in this format, so it has no bucket. Accuracy is NOT modelled either — Thunder Wave
   * is 90 % and Hypnosis 60 %, and the leaf still writes the condition as landed, because a board
   * cannot carry "60 % of a burn"; that omission is named in the tier's own config comment.
   *
   * Zap Cannon, Inferno and Nuzzle are DAMAGING moves with a 100 % status rider. They are listed
   * because their rider is certain, and the damage channel prices their hit independently — the
   * two facts are written to the same leaf board, which is the whole point of listing them. */
  const STATUS_MOVES = {
    brn: ['willowisp', 'inferno'],
    par: ['thunderwave', 'stunspore', 'glare', 'nuzzle', 'zapcannon'],
    psn: ['poisonpowder', 'poisongas'],
    tox: ['toxic'],
    slp: ['spore', 'sleeppowder', 'hypnosis', 'sing', 'lovelykiss', 'darkvoid', 'grasswhistle']
  };
  const STATUS_BY_MOVE = (function () {
    const map = new Map();
    Object.keys(STATUS_MOVES).forEach(function (st) {
      STATUS_MOVES[st].forEach(function (id) { map.set(id, st); });
    });
    return map;
  })();

  /* TYPES THAT CANNOT BE GIVEN A STATUS. A game rule with a single correct value, like the ability
   * table above, and the one piece of the status channel the type chart does NOT express: Will-O-
   * Wisp is a Fire move into a Fire body, which the chart prices at 0.5 rather than 0, so nothing
   * in typeEffectiveness stops it. Electric-types have been paralysis-proof since Gen 6, and
   * Poison/Steel bodies cannot be poisoned (the chart's 0 does cover those two, but naming them
   * here keeps the RULE in one place instead of split between a table and a multiplier). */
  const STATUS_TYPE_IMMUNITY = {
    brn: ['Fire'],
    par: ['Electric'],
    psn: ['Poison', 'Steel'],
    tox: ['Poison', 'Steel'],
    slp: [],
    frz: ['Ice']
  };

  /* Powder moves: a Grass-type body cannot be powdered. (Safety Goggles and Overcoat are the other
   * two powder shields; neither is inferable from a revealed board, so neither is modelled — see
   * the tier's own note.) */
  const POWDER_MOVES = new Set(['spore', 'sleeppowder', 'stunspore', 'poisonpowder', 'cottonspore',
    'ragepowder', 'magicpowder']);

  /* Moves that hit THROUGH a Protect. The Gen 9 list: Feint, and the three two-turn phantoms that
   * strike on their charge turn regardless of a shield (Phantom Force, Shadow Force, Hyperspace
   * Fury / Hyperspace Hole). Max and Z moves pierce too, and neither is legal in this format. */
  const PROTECT_PIERCING_MOVES = new Set(['feint', 'phantomforce', 'shadowforce', 'hyperspacefury',
    'hyperspacehole']);

  /** The condition (a protocol status id) a move is built to give, or null. */
  function statusInflictedBy(name) {
    return STATUS_BY_MOVE.get(toID(name)) || null;
  }

  function isPowderMove(name) { return POWDER_MOVES.has(toID(name)); }

  function piercesProtect(name) { return PROTECT_PIERCING_MOVES.has(toID(name)); }

  /* ---- Conditional moves: the damage only exists if the opponent's CLICK is the right shape.
   *
   * Sucker Punch is the one "you must attack" move in the format: it connects only when the target
   * selected a Physical/Special move, and FAILS outright against a switch, a status move, a setup
   * move or a Protect. Fake Out and First Impression fail unless the user has not yet acted since
   * it entered the field (`activeMoveActions === 0` in the game's own terms) — a body that switched
   * in on turn N can use them on turn N+1 and never again. Both families were priced as
   * unconditional damage before this table existed: the matrix credited Sucker Punch into a
   * predicted switch (the exact line that deals nothing) and kept crediting Fake Out on every turn
   * after the first (the exact line the game answers with |-fail|).
   *
   * Deliberately NOT here: Upper Hand (it fails unless the target's click is a PRIORITY move, a
   * narrower condition than "an attack", so treating it as `suckerpunch` would over-price it), and
   * every accuracy roll — a 70% move is a probability, not a rule, and `laplace.volatility` is
   * where a probability belongs. */
  const REQUIRES_TARGET_ATTACK = new Set(['suckerpunch']);
  const FIRST_TURN_ONLY = new Set(['fakeout', 'firstimpression']);

  /* Moves whose flinch is a RULE, not a roll: Fake Out's secondary is 100%. (Iron Head's 30% and
   * friends are not here for the same reason the accuracy rolls above are not.) */
  const GUARANTEED_FLINCH = new Set(['fakeout']);

  function requiresTargetAttack(name) { return REQUIRES_TARGET_ATTACK.has(toID(name)); }
  function firstTurnOnly(name) { return FIRST_TURN_ONLY.has(toID(name)); }
  function guaranteedFlinch(name) { return GUARANTEED_FLINCH.has(toID(name)); }

  /**
   * Is a flinch impossible on this body? Inner Focus and Shield Dust stop it, and so does a Covert
   * Cloak. Read from what the board REVEALS: an unrevealed ability is not evidence, so an unknown
   * body is assumed flinchable rather than exempted on a guess.
   */
  function flinchBlocked(mon) {
    if (!mon) return false;
    const ability = toID(mon.ability || '');
    if (ability === 'innerfocus' || ability === 'shielddust') return true;
    return toID(mon.item || '') === 'covertcloak';
  }

  /** Is `status` impossible for a body of this species, on the type chart's own evidence? */
  function statusBlockedByType(status, speciesName) {
    const list = STATUS_TYPE_IMMUNITY[status];
    if (!list || !list.length) return false;
    for (let i = 0; i < list.length; i++) if (hasType(speciesName, list[i])) return true;
    return false;
  }

  /* Abilities that leave a body immune to Ground by keeping it airborne or absorbing the type.
   * Their absence of protection is provable: hazard damage that only grounded bodies take (Spikes)
   * or a Ground move that connects disproves them — EXCEPT under Gravity, which grounds everyone
   * and negates Levitate, so there the same observation proves nothing. The caller applies that
   * guard; this table only names the abilities. */
  const GROUND_IMMUNE_ABILITIES = new Set(['levitate', 'eartheater']);

  /* Abilities that make their holder IGNORE the target's ability for its own moves. A Ground move
   * from one of these connects straight through Levitate / Earth Eater, and their Fire move burns
   * a Water Veil holder, so neither observation is evidence against the defender's ability. The
   * caller drops the observation when the ATTACKER's ability is one of these; it can only do that
   * for an attacker whose ability is known (our own team's, or one already revealed). */
  const ABILITY_IGNORING_ABILITIES = new Set(['moldbreaker', 'teravolt', 'turboblaze']);

  /* Abilities that ALWAYS announce themselves the moment their holder switches in. Used only by the
   * gated absence inference (pruner.abilityDeduction.absenceRules), which reads a missing
   * announcement as evidence against the sets that carry them. That inference is off by default:
   * Neutralizing Gas and similar suppression can silence the announcement, so it needs suppression
   * tracking (and a measurement) before it may eliminate anything. */
  const SWITCH_IN_WEATHER_ABILITIES = {
    drizzle: 'rain',
    drought: 'sun',
    sandstream: 'sandstorm',
    snowwarning: 'snow'
  };
  const SWITCH_IN_TERRAIN_ABILITIES = {
    electricsurge: 'electric',
    grassyterrain: 'grassy',
    psychicterrain: 'psychic',
    mistyterrain: 'misty'
  };
  const SWITCH_IN_TRIGGER_ABILITIES = new Set(
    ['intimidate'].concat(
      Object.keys(SWITCH_IN_WEATHER_ABILITIES),
      Object.keys(SWITCH_IN_TERRAIN_ABILITIES)));

  /** The abilities that make `status` impossible, or an empty set for an unknown status id. */
  function abilitiesBlockingStatus(status) {
    return STATUS_IMMUNITY_ABILITIES[toID(status || '')] || NO_ABILITIES;
  }

  // TR setters that actually see play in NatDex OU (species ids)
  const TR_SETTERS = new Set(['porygon2', 'cresselia', 'slowking', 'slowkinggalar', 'hatterene', 'indeedee',
    'indeedeef', 'dusclops', 'dusknoir', 'mimikyu', 'oranguru', 'farigiraf', 'armarouge', 'bronzong',
    'reuniclus', 'jirachi', 'meloetta', 'magearna', 'uxie', 'mesprit', 'azelf', 'carbink', 'diancie',
    'gothitelle', 'cofagrigus', 'runerigus', 'spiritomb', 'sableye', 'banette', 'gardevoir', 'chandelure',
    'xatu', 'claydol', 'glastrier', 'mew', 'celebi', 'victini', 'hoopa', 'hoopaunbound', 'necrozma',
    'silvally', 'smeargle', 'starmie', 'wigglytuff', 'audino', 'audinomega', 'beheeyem', 'dusclops']);

  /* ---------------------------------------------------------------- primitives */

  /* toID is the hottest function in the engine: every move, item and species lookup starts here, a
   * single real turn reaches it thousands of times, and its cost is `toLowerCase()` plus a regex
   * replace (~0.2 us). A CPU profile of one real turn put toID at 21% of the whole decision with a
   * further 9% inside its own RegExp — which was mostly NOT the callers: it was the move-lookup
   * fallback below asking it once per dex key, per call (see getMoveData).
   *
   * The memo is a Map rather than an object on purpose: a plain `{}` answers for `constructor`,
   * `toString` and `__proto__` out of Object.prototype, and a truthiness test on such a hit is how
   * the move cache below once returned the Object constructor as if it were a move. The cap clears
   * instead of growing without bound, because a hostile log can invent names forever.
   */
  const toIDCache = new Map();

  function toID(str) {
    if (str === null || str === undefined) return '';
    const key = String(str);
    const hit = toIDCache.get(key);
    if (hit !== undefined) return hit;
    const s = key.toLowerCase();
    const out = s === 'flabébé' ? 'flabebe' : s.replace(/[^a-z0-9]+/g, '');
    if (toIDCache.size > 8192) toIDCache.clear();
    toIDCache.set(key, out);
    return out;
  }

  function clamp(v, lo, hi) {
    if (typeof v !== 'number' || v !== v) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }
  function clampStat(v) { return clamp(v, -6, 6); }
  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function round1(n) { return Math.round((n + Number.EPSILON) * 10) / 10; }
  function formatPercent(n) { return (n === null || n === undefined || n !== n) ? '-' : round1(n) + '%'; }
  function mean(arr) { if (!arr || !arr.length) return 0; let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s / arr.length; }
  function median(arr) {
    if (!arr || !arr.length) return 0;
    const a = arr.slice().sort(function (x, y) { return x - y; });
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }
  function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (typeof structuredClone === 'function') { try { return structuredClone(obj); } catch (e) { /* fall through */ } }
    return JSON.parse(JSON.stringify(obj));
  }
  function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  let DEBUG = false;
  function debug() {
    if (!DEBUG) return;
    try { console.log.apply(console, ['[ST]'].concat(Array.prototype.slice.call(arguments))); } catch (e) { /* noop */ }
  }

  /* ---------------------------------------------------------------- species */

  const speciesCache = {};
  let speciesNameList = null;
  let idIndex = null;

  function speciesNames() {
    if (speciesNameList) return speciesNameList;
    speciesNameList = Object.keys(RAW_SPECIES || {});
    return speciesNameList;
  }

  /** toID -> display name, so raw data (which keys by display name) is reachable by id. */
  function displayNameFor(id) {
    if (!idIndex) {
      idIndex = {};
      const keys = speciesNames();
      for (let i = 0; i < keys.length; i++) {
        const k = toID(keys[i]);
        if (k && !idIndex[k]) idIndex[k] = keys[i];
      }
    }
    return idIndex[id] || null;
  }

  function normalizeAbilityList(abilities) {
    if (!abilities) return [];
    if (Array.isArray(abilities)) return abilities.filter(Boolean).map(String);
    const out = [];
    Object.keys(abilities).forEach(function (k) { if (abilities[k]) out.push(String(abilities[k])); });
    return out;
  }

  // base species id -> { stone, megaSpecies, stones:[...], megaSpeciesAll:[...] }
  // Note: Charizard legally holds either Charizardite X or Y, so both are kept.
  const STONE_BY_BASE = (function () {
    const map = {};
    Object.keys(MEGA_STONES || {}).forEach(function (stone) {
      const entry = MEGA_STONES[stone];
      if (!entry) return;
      Object.keys(entry).forEach(function (base) {
        const key = toID(base);
        if (!map[key]) map[key] = { stone: stone, megaSpecies: entry[base], stones: [], megaSpeciesAll: [] };
        map[key].stones.push(stone);
        map[key].megaSpeciesAll.push(entry[base]);
      });
    });
    return map;
  })();

  /** The raw dex entry for an id (short keys: bs, types, abilities, baseSpecies). */
  function rawEntry(id) {
    const display = displayNameFor(id);
    if (display && RAW_SPECIES[display]) return { name: display, data: RAW_SPECIES[display] };
    return null;
  }

  /** Resolve through the vendored dex, then the generated alias table, then the raw table. */
  function resolveCalcSpecies(id) {
    if (!gen || !gen.species || typeof gen.species.get !== 'function') return null;
    let found = gen.species.get(id);
    if (found) return found;
    const alias = (window.ST_SPECIES_ALIASES || {})[id];
    if (alias) {
      found = gen.species.get(toID(alias));
      if (found) return found;
    }
    return null;
  }

  function rawSpecies(name) {
    if (!name) return null;
    const id = toID(name);
    if (!id) return null;
    const found = resolveCalcSpecies(id);
    if (found) {
      // NOTE: the vendored calc normalisation keeps only the FIRST ability of a species
      // and drops its hidden ability (Dragonite would lose Multiscale); the supplement
      // and raw table restore the full list in getSpecies().
      return found;
    }
    const synthesized = (window.ST_SPECIES_FALLBACK || {})[id];
    if (synthesized) return buildFallbackSpecies(synthesized.name || name, synthesized);
    const raw = rawEntry(id);
    if (raw) return buildFallbackSpecies(raw.name, raw.data);
    return null;
  }

  function buildFallbackSpecies(name, data) {
    const bs = data.bs || data.baseStats || {};
    const normalized = !data.bs && !!data.baseStats;
    return {
      kind: 'Species', id: toID(name), name: name,
      baseStats: normalized
        ? { hp: bs.hp | 0, atk: bs.atk | 0, def: bs.def | 0, spa: bs.spa | 0, spd: bs.spd | 0, spe: bs.spe | 0 }
        : { hp: bs.hp || 0, atk: bs.at || bs.atk || 0, def: bs.df || bs.def || 0, spa: bs.sa || bs.spa || 0, spd: bs.sd || bs.spd || 0, spe: bs.sp || bs.spe || 0 },
      types: data.types || ['Normal'],
      abilities: normalizeAbilityList(data.abilities),
      weightkg: data.weightkg || 0,
      gender: data.gender || '',
      baseSpecies: data.baseSpecies || name,
      nfe: !!data.nfe
    };
  }

  function getSpecies(name) {
    const id = toID(name);
    if (!id) return null;
    if (speciesCache[id]) return speciesCache[id];
    const s = rawSpecies(name);
    if (!s) return null;
    const canonicalId = toID(s.name || name);
    const types = (s.types || ['Normal']).slice();
    // The vendored bundle carries only ability slot 0, so hidden abilities come from the
    // generated supplement (lib/species-abilities.js); the raw table is the fallback.
    const raw = rawEntry(id);
    const supplement = (window.ST_ABILITY_SUPPLEMENT || {})[canonicalId];
    const abilities = (supplement && supplement.length)
      ? supplement.slice()
      : normalizeAbilityList((raw && raw.data && raw.data.abilities) || s.abilities);
    const out = {
      kind: 'Species', id: canonicalId, name: s.name,
      baseStats: {
        hp: s.baseStats.hp, atk: s.baseStats.atk, def: s.baseStats.def,
        spa: s.baseStats.spa, spd: s.baseStats.spd, spe: s.baseStats.spe
      },
      types: types,
      abilities: abilities,
      weightkg: s.weightkg || 0,
      gender: s.gender || '',
      baseSpecies: s.baseSpecies || s.name,
      nfe: !!s.nfe,
      isMega: types.length > 0 && /-Mega/.test(s.name || ''),
      isParadox: abilities.some(function (a) { return PARADOX_ABILITIES.has(toID(a)); }),
      isUltraBeast: /^(naganadel|nihilego|xurkitree|celesteela|kartana|guzzlord|poipole|stakataka|blacephalon|buzzwole|pheromosa)$/.test(canonicalId),
      isLegendary: !!s.legendary,
      isMythical: !!s.mythical
    };
    const stone = STONE_BY_BASE[toID(out.baseSpecies)] || null;
    out.megaStone = stone ? stone.stone : null;
    out.megaStones = stone ? stone.stones.slice() : [];
    out.megaSpecies = stone ? stone.megaSpecies : null;
    out.megaSpeciesAll = stone ? stone.megaSpeciesAll.slice() : [];
    out.canMegaEvolve = !!stone;
    speciesCache[id] = out;
    return out;
  }

  function baseStats(name) {
    const s = getSpecies(name);
    return s ? s.baseStats : { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  }
  function baseSpeed(name) { return baseStats(name).spe; }
  function getTypes(name) { const s = getSpecies(name); return s ? s.types : ['Normal']; }
  function getAbilities(name) { const s = getSpecies(name); return s ? s.abilities : []; }
  function canMegaEvolve(name) { const s = getSpecies(name); return !!(s && s.canMegaEvolve); }
  function isParadox(name) { const s = getSpecies(name); return !!(s && s.isParadox); }
  function megaStoneFor(name) { const s = getSpecies(name); return s ? s.megaStone : null; }
  function megaStonesFor(name) { const s = getSpecies(name); return s ? (s.megaStones || []).slice() : []; }
  function megaSpeciesFromStone(stone) {
    const entry = MEGA_STONES[stone] || null;
    if (!entry) return null;
    const keys = Object.keys(entry);
    if (!keys.length) return null;
    return { base: keys[0], mega: entry[keys[0]] };
  }
  function isMegaStone(item) { return !!item && Object.prototype.hasOwnProperty.call(MEGA_STONES, item); }
  function isZCrystal(item) { return !!item && Z_CRYSTAL_IDS.has(toID(item)); }
  function isChoiceItem(item) { return !!item && CHOICE_IDS.has(toID(item)); }
  function isBoosterEnergy(item) { return toID(item) === 'boosterenergy'; }
  function isItemKnown(item) { return !!item && (ITEM_LIST.indexOf(item) !== -1 || isMegaStone(item) || isZCrystal(item)); }
  function isAbilityKnown(ability) { return !!ability && ABILITY_LIST.indexOf(ability) !== -1; }

  /**
   * Item id -> canonical display name ('choicescarf' -> 'Choice Scarf'). Built once from the
   * dex plus the Mega Stone / Z-Crystal tables, so an id coming out of the packed team format
   * or a protocol line can always be normalised. Unknown ids come back trimmed and untouched
   * (never invented).
   */
  const ITEM_BY_ID = (function () {
    const map = Object.create(null);
    for (let i = 0; i < ITEM_LIST.length; i++) {
      if (ITEM_LIST[i]) map[toID(ITEM_LIST[i])] = ITEM_LIST[i];
    }
    const stoneKeys = Object.keys(MEGA_STONES || {});
    for (let i = 0; i < stoneKeys.length; i++) {
      if (!map[toID(stoneKeys[i])]) map[toID(stoneKeys[i])] = stoneKeys[i];
    }
    for (let i = 0; i < Z_CRYSTALS.length; i++) {
      if (!map[toID(Z_CRYSTALS[i])]) map[toID(Z_CRYSTALS[i])] = Z_CRYSTALS[i];
    }
    return map;
  })();

  function itemName(item) {
    if (!item) return null;
    const needle = toID(item);
    if (!needle) return null;
    if (ITEM_BY_ID[needle]) return ITEM_BY_ID[needle];
    const trimmed = String(item).trim();
    return trimmed || null;
  }

  /* ---------------------------------------------------------------- moves */

  /* id -> the built move object. A Map, and a MISS is a stored value: `null` is a real answer that
   * the old `if (moveCache[id])` hit test read as "not cached", so every lookup of a name the dex
   * does not have re-ran the fallback scan below — which is O(every move in the dex) with a toID
   * per key. Measured on a real board: a missing name cost ~240 us per call against 0.28 us for a
   * present one, and `_payoff` was making 216 such calls in a single turn. */
  const moveCache = new Map();
  const Z_MOVE_SUFFIX = /^(10,000,000 Volt Thunderbolt|All-Out Pummeling|Supersonic Skystrike|Acid Downpour|Tectonic Rage|Continental Crush|Savage Spin-Out|Never-Ending Nightmare|Corkscrew Crash|Inferno Overdrive|Hydro Vortex|Bloom Doom|Gigavolt Havoc|Shattered Psyche|Subzero Slammer|Devastating Drake|Black Hole Eclipse|Twinkle Tackle)$/;

  /* The dex indexed by id, built once on the first name that needs it. Same answer the linear scan
   * used to compute on every call — its `break` on the first matching key IS this first-wins `has`
   * guard — so building it cannot change a lookup, only what a miss costs. */
  let MOVE_BY_ID = null;
  function moveIdIndex() {
    if (MOVE_BY_ID) return MOVE_BY_ID;
    MOVE_BY_ID = new Map();
    const keys = Object.keys(RAW_MOVES || {});
    for (let i = 0; i < keys.length; i++) {
      const id = toID(keys[i]);
      if (id && !MOVE_BY_ID.has(id)) MOVE_BY_ID.set(id, { raw: RAW_MOVES[keys[i]], name: keys[i] });
    }
    return MOVE_BY_ID;
  }

  /**
   * One raw dex entry, own-key only. `RAW_MOVES` is the vendored library's plain object, so
   * `RAW_MOVES['constructor']` (and `toString`, `valueOf`, `hasOwnProperty`, ...) answers from
   * Object.prototype. Without this guard the lookup below built a MOVE out of that inherited value —
   * `getMoveData('toString')` returned a fabricated zero-power Status move, and `'constructor'`
   * returned the Object constructor wearing the same costume. `tests/util_smoke.js` pins all of it.
   */
  function rawMoveEntry(key) {
    return (RAW_MOVES && Object.prototype.hasOwnProperty.call(RAW_MOVES, key)) ? RAW_MOVES[key] : null;
  }

  /** Diagnostics for the suites: what the lookup has remembered, and how big its index is. */
  function moveLookupStats() {
    return { entries: moveCache.size, idIndex: MOVE_BY_ID ? MOVE_BY_ID.size : 0, toIDEntries: toIDCache.size };
  }

  function getMoveData(name) {
    if (!name) return null;
    const id = toID(name);
    const cached = moveCache.get(id);
    if (cached !== undefined) return cached;          // a remembered miss is a hit
    let base = rawMoveEntry(name) || rawMoveEntry(id);
    if (!base) {
      const hit = moveIdIndex().get(id);
      if (hit) { base = hit.raw; name = hit.name; }
    }
    if (!base) {
      if (moveCache.size > 8192) moveCache.clear();
      moveCache.set(id, null);
      return null;
    }
    const category = base.category || (base.bp ? 'Physical' : 'Status');
    const out = {
      name: name, id: id,
      basePower: base.bp || 0,
      type: base.type || 'Normal',
      category: category,
      priority: typeof base.priority === 'number' ? base.priority : 0,
      isStatus: category === 'Status',
      isPhysical: category === 'Physical',
      isSpecial: category === 'Special',
      zp: base.zp || 0,
      maxPower: base.maxPower || 0,
      makesContact: !!base.makesContact,
      isProtect: PROTECT_MOVES.has(id),
      isRecovery: RECOVERY_MOVES.has(id),
      isPivot: PIVOT_MOVES.has(id),
      isHazard: HAZARD_MOVES.has(id),
      isHazardRemoval: HAZARD_REMOVAL_MOVES.has(id),
      isSetup: SETUP_MOVES.has(id),
      isZMove: Z_MOVE_SUFFIX.test(name) || / Z$/.test(name) || id.indexOf('max') === 0,
      isMaxMove: id.indexOf('max') === 0,
      isMultihit: !!base.multiHit || !!base.hits,
      isSpread: base.target === 'allAdjacent' || base.target === 'allAdjacentFoes'
    };
    if (moveCache.size > 8192) moveCache.clear();
    moveCache.set(id, out);
    return out;
  }
  function movePriority(name) { const m = getMoveData(name); return m ? m.priority : 0; }
  function moveBasePower(name) { const m = getMoveData(name); return m ? m.basePower : 0; }
  function moveType(name) { const m = getMoveData(name); return m ? m.type : 'Normal'; }
  function isStatusMove(name) { const m = getMoveData(name); return !m || m.isStatus; }
  function isDamagingMove(name) { const m = getMoveData(name); return !!m && !m.isStatus && m.basePower > 0; }
  function isProtectMove(name) { return PROTECT_MOVES.has(toID(name)); }
  function isRecoveryMove(name) { return RECOVERY_MOVES.has(toID(name)); }
  function isSetupMove(name) {
    const d = getMoveData(name);
    return !!(d && d.isSetup);
  }
  function is8PPRecoveryMove(name) { return RECOVERY_8PP.has(toID(name)); }
  function isPivotMove(name) { return PIVOT_MOVES.has(toID(name)); }
  function isHazardMove(name) { return HAZARD_MOVES.has(toID(name)); }

  /* ---- moves that resolve on a LATER turn from a slot condition.
   * `|-start|<caster>|move: Future Sight` / `move: Doom Desire` only ANNOUNCE the click; the
   * damage lands at the residual of the NEXT turn against whatever body stands in the opposing
   * slot (`data/conditions.js: futuremove`). The dex entry is a 120 BP attack, which is exactly
   * why a payoff that prices it as an ordinary move is wrong: the click deals nothing today. */
  const DELAYED_MOVES = new Map([['futuresight', 'Future Sight'], ['doomdesire', 'Doom Desire']]);
  function isDelayedMove(name) { return DELAYED_MOVES.has(toID(name)); }
  function delayedMoveName(name) { return DELAYED_MOVES.get(toID(name)) || null; }
  function isWishMove(name) { return toID(name) === 'wish'; }

  /** hazardLayersOf(hazards) -> the total number of layers sitting on one side. */
  function hazardLayersOf(hazards) {
    if (!hazards || typeof hazards !== 'object') return null;
    let total = 0;
    for (const key in hazards) {
      const v = hazards[key];
      if (typeof v === 'number') total += v;
      else if (v === true) total += 1;
    }
    return total;
  }

  /* ---------------------------------------------------------------- type math */

  function typeMultiplier(attackType, defTypes) {
    if (!attackType) return 1;
    const row = TYPE_CHART[attackType];
    if (!row) return 1;
    let mult = 1;
    const list = Array.isArray(defTypes) ? defTypes : [defTypes];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const m = row[t];
      mult *= (typeof m === 'number' ? m : 1);
    }
    return mult;
  }
  function typeEffectiveness(attackType, speciesName) {
    return typeMultiplier(attackType, getTypes(speciesName));
  }
  function hasType(speciesName, type) { return getTypes(speciesName).indexOf(type) !== -1; }
  function isFlyingType(speciesName) { return hasType(speciesName, 'Flying'); }

  const IMMUNITY_MAP = {
    Ground: { abilities: ['levitate'], items: ['Air Balloon'], flying: true },
    Water: { abilities: ['waterabsorb', 'stormdrain', 'dryskin'], items: [] },
    Electric: { abilities: ['voltabsorb', 'lightningrod', 'motordrive'], items: [] },
    Fire: { abilities: ['flashfire', 'wellbakedbody'], items: [] },
    Grass: { abilities: ['sapsipper'], items: [] }
  };

  /** Would `moveType` be nullified by the defender's ability/item/typing? */
  function immunityReason(moveType, opts) {
    opts = opts || {};
    const abilityId = toID(opts.ability);
    const itemId = toID(opts.item);
    const abilityList = opts.abilities ? opts.abilities.map(toID) : (abilityId ? [abilityId] : []);
    const species = opts.species || '';
    const entry = IMMUNITY_MAP[moveType];
    const reasons = [];
    if (entry) {
      if (entry.flying && isFlyingType(species) && moveType === 'Ground') reasons.push('Flying type');
      for (let i = 0; i < abilityList.length; i++) {
        if (entry.abilities.indexOf(abilityList[i]) !== -1) reasons.push(abilityName(abilityList[i]));
      }
      // ONE push. An Air Balloon id is rewritten to the display name the items list contains, so
      // the first test already fires for it; a second, id-only push used to append it again and the
      // HUD string read 'Air Balloon / Air Balloon'.
      if (entry.items.indexOf(itemId === 'airballoon' ? 'Air Balloon' : opts.item) !== -1 && moveType === 'Ground') reasons.push('Air Balloon');
    }
    if (opts.itemless && toID(moveType) === '') { /* noop */ }
    return reasons.length ? reasons.join(' / ') : null;
  }

  function abilityName(id) {
    const needle = toID(id);
    for (let i = 0; i < ABILITY_LIST.length; i++) if (toID(ABILITY_LIST[i]) === needle) return ABILITY_LIST[i];
    const known = { waterabsorb: 'Water Absorb', stormdrain: 'Storm Drain', dryskin: 'Dry Skin', voltabsorb: 'Volt Absorb', lightningrod: 'Lightning Rod', motordrive: 'Motor Drive', levitate: 'Levitate', flashfire: 'Flash Fire', wellbakedbody: 'Well-Baked Body', sapsipper: 'Sap Sipper', goodasgold: 'Good as Gold', protosynthesis: 'Protosynthesis', quarkdrive: 'Quark Drive' };
    return known[needle] || String(id);
  }

  function isGrounded(speciesName, item, ability, opts) {
    opts = opts || {};
    if (opts.gravity) return true;
    if (toID(item) === 'ironball') return true;
    if (opts.ingrain) return true;
    if (isFlyingType(speciesName)) return false;
    if (toID(ability) === 'levitate') return false;
    if (toID(item) === 'airballoon') return false;
    return true;
  }

  /**
   * Stealth Rock deals (1/8 * type effectiveness) of max HP to a target with 6 full
   * HP bars: 0.25x -> 3.125%, 0.5x -> 6.25%, 1x -> 12.5%, 2x -> 25%, 4x -> 50%.
   */
  const SR_PER_MULT = 12.5;
  function emRockPercent(mult) {
    if (!mult) return 0;
    return Math.round(mult * SR_PER_MULT * 1000) / 1000;
  }

  /**
   * Damage (percent of max HP) this Pokémon takes when switching into `side`'s hazards.
   * Used to prove Heavy-Duty Boots (0% with hazards up while not immune).
   */
  function hazardPercent(speciesName, item, ability, hazards, opts) {
    opts = opts || {};
    const h = hazards || { rocks: false, spikes: 0, toxicspikes: 0, stickyweb: false };
    if (toID(item) === 'heavydutyboots') return 0;
    const grounded = isGrounded(speciesName, item, ability, opts);
    let total = 0;
    if (h.rocks) total += emRockPercent(typeEffectiveness('Rock', speciesName));
    if (grounded) {
      const spikes = clamp(h.spikes | 0, 0, 3);
      total += spikes === 1 ? 12.5 : spikes === 2 ? 16.67 : spikes === 3 ? 25 : 0;
      const tsp = clamp(h.toxicspikes | 0, 0, 2);
      if (tsp > 0 && !hasType(speciesName, 'Poison') && !hasType(speciesName, 'Steel')) total += tsp === 1 ? 12.5 : 16.67;
      if (h.steelspikes) total += (h.steelspikes | 0) === 1 ? 12.5 : 16.67;
    }
    if (toID(item) === 'heavydutyboots') total = 0;
    return round1(total);
  }

  /* ---------------------------------------------------------------- stats */

  /* RULE 1 — ZERO IN-HOUSE MATH. There is no stat formula in this project. Every number below
   * is produced by @smogon/calc's own arithmetic, `calc.Stats.calcStat(gen, stat, base, iv, ev,
   * level, nature)` — the exact routine its damage calculator uses to build a Pokemon's stats
   * (natures, IVs, EVs, level and Shedinja's 1 HP included). This module only decides WHICH
   * base stats / IVs / EVs / nature to hand it, never how to turn them into a number.
   * tests/blackbox_guard.js diffs our output against the library for every species and stat.
   */
  function libraryStat(stat, base, iv, ev, level, nature) {
    if (!CALC || !CALC.Stats || typeof CALC.Stats.calcStat !== 'function' || !gen) return 0;
    return CALC.Stats.calcStat(gen, stat, typeof base === 'number' ? base : 0,
      typeof iv === 'number' ? iv : 31, typeof ev === 'number' ? ev : 0,
      level || 100, nature || '');
  }

  /** True when the vendored @smogon/calc bundle is present (the engine's only source of math). */
  function libraryReady() { return !!(CALC && CALC.Stats && typeof CALC.Stats.calcStat === 'function' && gen); }

  function natureMultiplier(nature, stat) {
    const n = NATURES[nature];
    if (!n) return 1;
    const plus = n[0], minus = n[1];
    if (plus === stat) return 1.1;
    if (minus === stat) return 0.9;
    return 1;
  }

  /** calcStat('spe', { base, iv, ev, level, nature }) -> number. Fully library-computed. */
  function calcStat(stat, opts) {
    opts = opts || {};
    return libraryStat(stat, opts.base, opts.iv, opts.ev, opts.level, opts.nature);
  }

  /** calcHP(base, iv, ev, level) — HP is @smogon/calc's `hp` stat (so Shedinja is 1, not 112). */
  function calcHP(base, iv, ev, level) { return libraryStat('hp', base, iv, ev, level, ''); }

  /** statTable(species, { ivs, evs, level, nature }) -> all six stats, from the library. */
  function statTable(speciesName, opts) {
    opts = opts || {};
    const info = getSpecies(speciesName);
    if (!info) return null;
    const bs = info.baseStats;
    const out = {};
    for (let i = 0; i < STATS.length; i++) {
      const s = STATS[i];
      out[s] = libraryStat(s, bs[s], opts.ivs && opts.ivs[s], opts.evs && opts.evs[s],
        opts.level, opts.nature);
    }
    return out;
  }
  function boostMultiplier(stage) {
    const s = clampStat(stage || 0);
    return s >= 0 ? (2 + s) / 2 : 2 / (2 - s);
  }
  function paralysisMultiplier(spread) {
    // Gen 7+: paralysis is 50% for every generation available here.
    return spread ? 0.5 : 0.5;
  }

  /**
   * computeSpeed(species|MonState, opts) -> { raw, effective, base, boost }
   * `raw` is the plain level-100 Speed stat (items/abilities NOT applied).
   * `effective` applies item, ability, field and boost multipliers.
   */
  function computeSpeed(speciesOrMon, opts) {
    opts = opts || {};
    const mon = speciesOrMon || {};
    const speciesName = mon.species || mon.name || '';
    const sp = getSpecies(speciesName);
    const bs = sp ? sp.baseStats.spe : 0;
    const evs = Object.assign({}, DEFAULT_IVS, ZERO_EVS, opts.evs || mon.evs || {});
    const ivs = Object.assign({}, DEFAULT_IVS, opts.ivs || mon.ivs || {});
    const nature = opts.nature || mon.nature || '';
    const level = opts.level || mon.level || 100;
    const boostStage = opts.boostStage !== undefined ? opts.boostStage
      : (mon.boosts && mon.boosts.spe) || 0;
    const raw = calcStat('spe', { base: bs, iv: ivs.spe, ev: evs.spe, level: level, nature: nature });
    const item = opts.item !== undefined ? opts.item : mon.item;
    const ability = toID(opts.ability !== undefined ? opts.ability : mon.ability);
    const weather = opts.weather || '';
    const terrain = opts.terrain || '';
    let mult = boostMultiplier(boostStage);
    if (toID(item) === 'choicescarf') mult *= 1.5;
    if (toID(item) === 'ironball') mult *= 0.5;
    if (toID(item) === 'machobrace' || toID(item) === 'poweranklet' || toID(item) === 'powerweight' ||
        toID(item) === 'powerbracer' || toID(item) === 'powerbelt' || toID(item) === 'powerlens' ||
        toID(item) === 'powerband') mult *= 0.5;
    if (opts.tailwind) mult *= 2;
    // The weather is compared by FAMILY, not by its raw field value: Heavy Rain still IS rain (it
    // is what Primordial Sea reports) and NatDex Hail reports 'hail', so the raw comparisons this
    // used to make silently priced a Swift Swim body at half its Speed in Heavy Rain and a Slush
    // Rush body at half in Hail — and Speed order is a decision input. `weatherFamily` returns the
    // id unchanged for everything it does not remap, so the already-correct cases are untouched.
    if (ability === 'swiftswim' && weatherFamily(weather) === 'rain') mult *= 2;
    if (ability === 'chlorophyll' && weatherFamily(weather) === 'sun') mult *= 2;
    if (ability === 'sandrush' && weatherFamily(weather) === 'sandstorm') mult *= 2;
    if (ability === 'slushrush' && weatherFamily(weather) === 'snow') mult *= 2;
    if (ability === 'surgesurfer' && terrain === 'electric') mult *= 2;
    if (opts.paradoxSpeedBoost) mult *= 1.5;
    if (opts.unburden) mult *= 2;
    if (opts.slowStart) mult *= 0.5;
    return {
      base: bs,
      raw: raw,
      boost: boostMultiplier(boostStage),
      effective: Math.max(1, Math.floor(raw * mult + Number.EPSILON)),
      multiplier: mult
    };
  }

  /** Max possible level-100 Speed for a set: +nature, 252 EV, 31 IV, no item/field. */
  function maxSpeedForSet(set) {
    if (!set) return 0;
    const mon = {
      species: set.species, evs: set.evs, ivs: set.ivs, nature: set.nature, level: 100,
      item: set.item, ability: set.ability
    };
    const abilityId = toID(set.ability);
    return computeSpeed(mon, {
      item: set.item,
      ability: set.ability,
      paradoxSpeedBoost: PARADOX_ABILITIES.has(abilityId) && toID(set.item) === 'boosterenergy' && highestStatIsSpeed(mon)
    }).effective;
  }

  /**
   * Is Speed the HIGHEST of this body's five battle stats? Protosynthesis / Quark Drive raise the
   * holder's highest stat, so this is the fallback the speed layers use when the protocol has not
   * yet said which stat moved. Stats come from the library via `statTable` (or the set's own
   * precomputed `mon.stats`); a strict maximum is required, so a tie between Attack and Speed
   * reports Attack -- the conservative direction, since the alternative would over-apply a 1.5x
   * Speed multiplier and make the engine believe it is slower than it is.
   */
  function highestStatIsSpeed(mon) {
    if (!mon) return false;
    let stats = mon.stats;
    if (!stats || typeof stats.spe !== 'number') {
      stats = statTable(mon.species || mon.name, {
        ivs: mon.ivs, evs: mon.evs, level: mon.level, nature: mon.nature
      });
    }
    if (!stats) return false;
    const order = ['atk', 'def', 'spa', 'spd', 'spe'];
    let best = -Infinity, bestStat = null;
    for (let i = 0; i < order.length; i++) {
      const v = stats[order[i]];
      if (typeof v === 'number' && v > best) { best = v; bestStat = order[i]; }
    }
    return bestStat === 'spe';
  }

  /**
   * Is this body's ACTIVE Protosynthesis / Quark Drive boost raising SPEED?
   *
   * `boosterActive` says only that SOMETHING is boosted -- and the abilities raise the holder's
   * HIGHEST stat, which is Speed for Iron Valiant and Attack for Great Tusk. Reading `boosterActive`
   * as a flat 1.5x Speed multiplier therefore scored an Attack-boosted Great Tusk as outrunning us,
   * and VETO4 refused legitimate lines on that blindness (BUGS_AUDIT_REPORT.md, the VETO4 entry).
   * `mon.boostedStat` is the sim's own statement of which stat moved (`|-start|p1a: X|
   * protosynthesisatk`), so it decides whenever it is known; only when it is unknown does the set's
   * real highest stat decide. `opts.active` lets a caller treat a body with a PROVEN Booster Energy
   * (ability + item, the pre-sampled fallback trick_room.js already used) as boosted even before
   * `boosterActive` has been set.
   */
  function paradoxSpeedBoost(mon, opts) {
    if (!mon) return false;
    opts = opts || {};
    const active = opts.active !== undefined ? !!opts.active : !!mon.boosterActive;
    if (!active) return false;
    const stat = mon.boostedStat;
    if (stat === 'spe') return true;
    if (stat === 'atk' || stat === 'def' || stat === 'spa' || stat === 'spd') return false;
    return highestStatIsSpeed(mon);
  }

  /* ---------------------------------------------------------------- fuzzy */

  function levenshtein(a, b) {
    if (a === b) return 0;
    const al = a.length, bl = b.length;
    if (!al) return bl;
    if (!bl) return al;
    let prev = new Array(bl + 1);
    let cur = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) prev[j] = j;
    for (let i = 1; i <= al; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= bl; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[bl];
  }

  /**
   * closestSpeciesName('greattok') -> 'Great Tusk'
   * Returns null when nothing is within a safe distance, so callers never invent species.
   */
  function closestSpeciesName(input) {
    const id = toID(input);
    if (!id) return null;
    if (RAW_SPECIES[id]) return RAW_SPECIES[id];
    if (getSpecies(id)) return getSpecies(id).name;
    // strip form suffixes and retry ('roaringmoonmega' etc.)
    const stripped = id.replace(/mega[xyz]?$/, '').replace(/primal$/, '');
    if (stripped !== id && getSpecies(stripped)) return getSpecies(stripped).name;
    const names = speciesNames();
    let best = null, bestDist = Infinity, bestLen = 0;
    for (let i = 0; i < names.length; i++) {
      const nid = toID(names[i]);
      if (nid === id) return names[i];
      if (Math.abs(nid.length - id.length) > 3) continue;
      if (nid.indexOf(id) === 0 || id.indexOf(nid) === 0) {
        const d0 = Math.abs(nid.length - id.length);
        if (d0 < bestDist) { bestDist = d0; best = names[i]; bestLen = nid.length; }
        continue;
      }
      const d = levenshtein(nid, id);
      if (d < bestDist) { bestDist = d; best = names[i]; bestLen = nid.length; }
    }
    const threshold = Math.max(1, Math.floor(Math.min(id.length, bestLen) / 3));
    if (best && bestDist <= threshold) return best;
    return null;
  }

  function tokenizeDetails(details) {
    const parts = String(details || '').split(',').map(function (p) { return p.trim(); });
    const species = parts[0] || '';
    let level = 100, gender = '', shiny = false;
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      if (/^L\d+$/.test(p)) level = parseInt(p.slice(1), 10);
      else if (/^[MF]$/.test(p)) gender = p;
      else if (/^[MF]$/.test(p.replace(/^N$/, '')) && p !== 'N') gender = p;
      else if (p === 'N') gender = 'N';
      else if (/shiny/i.test(p)) shiny = true;
    }
    return { species: species, level: level, gender: gender, shiny: shiny };
  }

  /* ---------------------------------------------------------------- exports */

  ST.util = {
    VERSION: '1.0.0',
    GEN: GEN_NUM,
    FORMAT: '[Gen 9] National Dex OU',
    DEBUG: DEBUG,
    debug: debug,
    CALC: CALC,
    GEN_OBJ: gen,
    RAW_MOVES: RAW_MOVES,
    STATS: STATS,
    TYPES: TYPES,
    DEFAULT_IVS: DEFAULT_IVS,
    ZERO_EVS: ZERO_EVS,
    PROTECT_MOVES: PROTECT_MOVES,
    RECOVERY_MOVES: RECOVERY_MOVES,
    RECOVERY_8PP: RECOVERY_8PP,
    PIVOT_MOVES: PIVOT_MOVES,
    HAZARD_MOVES: HAZARD_MOVES,
    HAZARD_REMOVAL_MOVES: HAZARD_REMOVAL_MOVES,
    HAZARD_LAYERS: HAZARD_LAYERS,
    HAZARD_CLEAR_MOVES: HAZARD_CLEAR_MOVES,
    WEATHER_BY_MOVE: WEATHER_BY_MOVE,
    weatherFamily: weatherFamily,
    SETUP_MOVES: SETUP_MOVES,
    SETUP_BOOSTS: SETUP_BOOSTS,
    setupBoosts: setupBoosts,
    isSetupMove: isSetupMove,
    CHOICE_ITEMS: CHOICE_ITEMS,
    CHOICE_IDS: CHOICE_IDS,
    Z_CRYSTALS: Z_CRYSTALS,
    PARADOX_ABILITIES: PARADOX_ABILITIES,
    WATER_ABSORB_ABILITIES: WATER_ABSORB,
    ELECTRIC_ABSORB_ABILITIES: ELECTRIC_ABSORB,
    FIRE_ABSORB_ABILITIES: FIRE_ABSORB,
    GRASS_ABSORB_ABILITIES: GRASS_ABSORB,
    UNBLOCKABLE_STATUS_ABILITY: UNBLOCKABLE_STATUS_ABILITY,
    STATUS_IMMUNITY_ABILITIES: STATUS_IMMUNITY_ABILITIES,
    STATUS_MOVES: STATUS_MOVES,
    STATUS_TYPE_IMMUNITY: STATUS_TYPE_IMMUNITY,
    POWDER_MOVES: POWDER_MOVES,
    PROTECT_PIERCING_MOVES: PROTECT_PIERCING_MOVES,
    statusInflictedBy: statusInflictedBy,
    isPowderMove: isPowderMove,
    piercesProtect: piercesProtect,
    REQUIRES_TARGET_ATTACK: REQUIRES_TARGET_ATTACK,
    FIRST_TURN_ONLY: FIRST_TURN_ONLY,
    GUARANTEED_FLINCH: GUARANTEED_FLINCH,
    requiresTargetAttack: requiresTargetAttack,
    firstTurnOnly: firstTurnOnly,
    guaranteedFlinch: guaranteedFlinch,
    flinchBlocked: flinchBlocked,
    statusBlockedByType: statusBlockedByType,
    GROUND_IMMUNE_ABILITIES: GROUND_IMMUNE_ABILITIES,
    ABILITY_IGNORING_ABILITIES: ABILITY_IGNORING_ABILITIES,
    SWITCH_IN_TRIGGER_ABILITIES: SWITCH_IN_TRIGGER_ABILITIES,
    SWITCH_IN_WEATHER_ABILITIES: SWITCH_IN_WEATHER_ABILITIES,
    SWITCH_IN_TERRAIN_ABILITIES: SWITCH_IN_TERRAIN_ABILITIES,
    abilitiesBlockingStatus: abilitiesBlockingStatus,
    TR_SETTERS: TR_SETTERS,
    MEGA_STONES: MEGA_STONES,
    STONE_BY_BASE: STONE_BY_BASE,

    toID: toID,
    clamp: clamp,
    clampStat: clampStat,
    round1: round1,
    round2: round2,
    formatPercent: formatPercent,
    mean: mean,
    median: median,
    deepClone: deepClone,
    escapeHtml: escapeHtml,

    getSpecies: getSpecies,
    speciesNames: speciesNames,
    baseStats: baseStats,
    baseSpeed: baseSpeed,
    getTypes: getTypes,
    getAbilities: getAbilities,
    hasType: hasType,
    isFlyingType: isFlyingType,
    isParadox: isParadox,
    canMegaEvolve: canMegaEvolve,
    megaStoneFor: megaStoneFor,
    megaStonesFor: megaStonesFor,
    megaSpeciesFromStone: megaSpeciesFromStone,
    isMegaStone: isMegaStone,
    isZCrystal: isZCrystal,
    isChoiceItem: isChoiceItem,
    isBoosterEnergy: isBoosterEnergy,
    isItemKnown: isItemKnown,
    isAbilityKnown: isAbilityKnown,
    abilityName: abilityName,
    itemName: itemName,

    getMoveData: getMoveData,
    moveLookupStats: moveLookupStats,
    movePriority: movePriority,
    moveBasePower: moveBasePower,
    moveType: moveType,
    isStatusMove: isStatusMove,
    isDamagingMove: isDamagingMove,
    isProtectMove: isProtectMove,
    isRecoveryMove: isRecoveryMove,
    is8PPRecoveryMove: is8PPRecoveryMove,
    isPivotMove: isPivotMove,
    isHazardMove: isHazardMove,
    isDelayedMove: isDelayedMove,
    delayedMoveName: delayedMoveName,
    isWishMove: isWishMove,
    hazardLayersOf: hazardLayersOf,

    typeMultiplier: typeMultiplier,
    typeEffectiveness: typeEffectiveness,
    immunityReason: immunityReason,
    isGrounded: isGrounded,
    hazardPercent: hazardPercent,
    emRockPercent: emRockPercent,

    natureMultiplier: natureMultiplier,
    libraryStat: libraryStat,
    libraryReady: libraryReady,
    calcStat: calcStat,
    calcHP: calcHP,
    statTable: statTable,
    boostMultiplier: boostMultiplier,
    paralysisMultiplier: paralysisMultiplier,
    computeSpeed: computeSpeed,
    maxSpeedForSet: maxSpeedForSet,
    highestStatIsSpeed: highestStatIsSpeed,
    paradoxSpeedBoost: paradoxSpeedBoost,

    levenshtein: levenshtein,
    closestSpeciesName: closestSpeciesName,
    tokenizeDetails: tokenizeDetails
  };
})();
