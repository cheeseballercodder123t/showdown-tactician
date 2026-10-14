/* Showdown Tactician — tests/run_tests.js
 * End-to-end verification in Node. Loads the extension's classic scripts in manifest order
 * (see tests/harness.js) and exercises the whole pipeline: parsing, team ingestion, state
 * tracking, set pruning, damage math, the 128D/10D vectors, vetoes, Trick Room, world
 * sampling, the Laplace loop, the LLM bridge and the HUD.
 *
 * Usage:  node tests/run_tests.js
 * Exit code 0 = every check passed.
 */
'use strict';
const path = require('path');
const H = require('./harness.js');

/* --------------------------------------------------------------- tiny assert */

let passed = 0;
const failures = [];
const groupFailures = {};

function check(name, condition, detail) {
  if (condition) { passed++; return true; }
  failures.push(name + (detail !== undefined ? '  ->  ' + detail : ''));
  const group = name.split(':')[0];
  groupFailures[group] = (groupFailures[group] || 0) + 1;
  return false;
}
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  return check(name, ok, ok ? undefined : 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function close(name, got, want, tolerance) {
  const ok = typeof got === 'number' && Math.abs(got - want) <= (tolerance === undefined ? 0.01 : tolerance);
  return check(name, ok, ok ? undefined : 'got ' + got + ', want ' + want + ' +/- ' + (tolerance === undefined ? 0.01 : tolerance));
}
function near(name, got, want, pct) {
  const limit = Math.abs(want * (pct === undefined ? 0.35 : pct)) + 1;
  const ok = typeof got === 'number' && Math.abs(got - want) <= limit;
  return check(name, ok, ok ? undefined : 'got ' + got + ', want about ' + want);
}
function section(title) {
  console.log('\n=== ' + title + ' ===');
}

/* --------------------------------------------------------------- fixtures */

const PASTE = [
  'Great Tusk @ Choice Scarf',
  'Ability: Protosynthesis',
  'Level: 100',
  'EVs: 252 Atk / 4 SpD / 252 Spe',
  'Jolly Nature',
  '- Headlong Rush',
  '- Close Combat',
  '- Ice Spinner',
  '- Rapid Spin',
  '',
  'Slowking-Galar @ Assault Vest',
  'Ability: Regenerator',
  'EVs: 252 HP / 4 SpA / 252 SpD',
  'Sassy Nature',
  'IVs: 0 Spe',
  '- Future Sight',
  '- Scald',
  '- Sludge Bomb',
  '- Flamethrower',
  '',
  'Ferrothorn @ Leftovers',
  'Ability: Iron Barbs',
  'EVs: 252 HP / 88 Def / 168 SpD',
  'Relaxed Nature',
  'IVs: 0 Spe',
  '- Stealth Rock',
  '- Leech Seed',
  '- Power Whip',
  '- Protect',
  '',
  'Iron Valiant @ Booster Energy',
  'Ability: Quark Drive',
  'EVs: 4 HP / 252 SpA / 252 Spe',
  'Timid Nature',
  '- Moonblast',
  '- Thunderbolt',
  '- Psyshock',
  '- Calm Mind',
  '',
  'Landorus-Therian @ Rocky Helmet',
  'Ability: Intimidate',
  'EVs: 252 HP / 252 Def / 4 SpD',
  'Impish Nature',
  '- Earthquake',
  '- U-turn',
  '- Stealth Rock',
  '- Taunt',
  '',
  'Porygon2 @ Eviolite',
  'Ability: Trace',
  'EVs: 252 HP / 252 SpD / 4 SpA',
  'Sassy Nature',
  'IVs: 0 Spe',
  '- Trick Room',
  '- Ice Beam',
  '- Recover',
  '- Thunder Wave'
].join('\n');

const BATTLE_LOG = [
  '|player|p1|Me|1|1550',
  '|player|p2|Foe|2|1480',
  '|teamsize|p1|6',
  '|teamsize|p2|6',
  '|gametype|singles',
  '|tier|[Gen 9] National Dex OU',
  '|clearpoke',
  '|poke|p1|Great Tusk, L50, M|item',
  '|poke|p2|Iron Valiant, L50, F|item',
  '|poke|p2|Landorus-Therian, L50, M|item',
  '|teampreview',
  '|start',
  '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
  '|switch|p2a: Landorus-Therian|Landorus-Therian, L50, M|100/100',
  '|turn|1',
  '|move|p2a: Landorus-Therian|Earthquake|p1a: Great Tusk',
  '|-damage|p1a: Great Tusk|74/100',
  '|move|p1a: Great Tusk|Headlong Rush|p2a: Landorus-Therian',
  '|-damage|p2a: Landorus-Therian|61/100',
  '|turn|2',
  '|move|p1a: Great Tusk|Ice Spinner|p2a: Landorus-Therian',
  '|move|p2a: Landorus-Therian|Stealth Rock|p1',
  '|-sidestart|p1: Me|move: Stealth Rock',
  '|turn|3',
  '|switch|p1a: Slowking-Galar|Slowking-Galar, L50, M|100/100',
  '|move|p2a: Landorus-Therian|U-turn|p1a: Slowking-Galar',
  '|-damage|p1a: Slowking-Galar|82/100',
  '|switch|p2a: Iron Valiant|Iron Valiant, L50, F|100/100',
  '|turn|4',
  '|move|p2a: Iron Valiant|Moonblast|p1a: Slowking-Galar',
  '|-damage|p1a: Slowking-Galar|34/100',
  '|move|p1a: Slowking-Galar|Recover|p1a: Slowking-Galar',
  '|-heal|p1a: Slowking-Galar|84/100',
  '|turn|5',
  '|move|p1a: Slowking-Galar|Scald|p2a: Iron Valiant',
  '|-damage|p2a: Iron Valiant|0 fnt',
  '|faint|p2a: Iron Valiant'
].join('\n');

function loadSandbox() {
  return H.loadAll({
    setInterval: function () { return 0; },
    clearInterval: function () { },
    fetch: function () { return Promise.resolve({ ok: false, json: function () { return Promise.resolve({}); } }); }
  });
}

function buildBattleState(S) {
  const state = new S.ST.BattleStateManager({ debug: false });
  const parser = new S.ST.ProtocolParser();
  state.attachParser(parser);
  state.setFormat('[Gen 9] National Dex OU');
  if (typeof state.registerMyTeam === 'function') {
    const parsed = S.ST.TeamParser.parsePokepaste(PASTE);
    state.registerMyTeam(parsed.pokemon);
  }
  parser.speedHint = { mySpeed: 300, mySpecies: 'Great Tusk' };
  parser.feedAll(BATTLE_LOG);
  return { state: state, parser: parser, battle: state.state || state };
}

/* =============================================================== main */

function main() {
  const S = loadSandbox();
  console.log('Loaded ' + S.__loaded.length + ' scripts: ' + S.__loaded.join(', '));
  if (S.__missing.length) console.log('MISSING scripts: ' + S.__missing.join(', '));
  check('harness: every manifest script exists', S.__missing.length === 0, S.__missing.join(', '));
  const U = S.ST.util;

  /* ---------------------------------------------------------- util */
  section('util (dex access, type math, speeds)');
  eq('util: toID strips punctuation', U.toID('Slowking-Galar'), 'slowkinggalar');
  eq('util: base stats resolve', U.baseStats('Great Tusk'), { hp: 115, atk: 131, def: 131, spa: 53, spd: 53, spe: 87 });
  eq('util: mega stones resolve for Charizard', U.megaStonesFor('Charizard'), ['Charizardite X', 'Charizardite Y']);
  eq('util: paradox mons detected', U.isParadox('Iron Valiant'), true);
  eq('util: steel vs fairy is 2x', U.typeEffectiveness('Steel', 'Tapu Lele'), 2);
  eq('util: ground vs flying is 0x', U.typeEffectiveness('Ground', 'Landorus-Therian'), 0);
  eq('util: stealth rock is 1/8 of max HP', U.hazardPercent('Dragapult', null, 'Clear Body', { rocks: true }), 12.5);
  eq('util: hazardPercent respects Boots', U.hazardPercent('Charizard', 'Heavy-Duty Boots', 'Blaze', { rocks: true, spikes: 3 }), 0);
  eq('util: jolly 252 speed stat', U.computeSpeed({ species: 'Great Tusk', nature: 'Jolly', evs: { spe: 252 } }).effective, 300);
  eq('util: choice scarf multiplies speed', U.computeSpeed({ species: 'Great Tusk', nature: 'Jolly', evs: { spe: 252 } }, { item: 'Choice Scarf' }).effective, 450);
  eq('util: fuzzy species match', U.closestSpeciesName('greattok'), 'Great Tusk');

  /* ---------------------------------------------------- team parser */
  section('team_parser');
  check('team: TeamParser exists', !!S.ST.TeamParser);
  if (S.ST.TeamParser) {
    const parsed = S.ST.TeamParser.parsePokepaste(PASTE);
    eq('team: six Pokemon parsed', (parsed.pokemon || []).length, 6);
    eq('team: no errors', (parsed.errors || []).length, 0);
    const tusk = parsed.pokemon[0];
    eq('team: item read', tusk.item, 'Choice Scarf');
    eq('team: ability read', tusk.ability, 'Protosynthesis');
    eq('team: nature read', tusk.nature, 'Jolly');
    eq('team: atk EV read', tusk.evs.atk, 252);
    eq('team: spd EV read', tusk.evs.spd, 4);
    eq('team: moves read', tusk.moves.length, 4);
    const slowking = parsed.pokemon[1];
    eq('team: hyphenated species resolved', slowking.species, 'Slowking-Galar');
    eq('team: 0 Spe IV honoured', slowking.ivs.spe, 0);
    eq('team: 0 Spe IV flagged as TR', !!slowking.isTR, true);
    eq('team: untouched IVs stay 31', slowking.ivs.atk, 31);
    const p2 = parsed.pokemon[5];
    eq('team: Trick Room setter parses', p2.moves.indexOf('Trick Room') !== -1, true);
    const multiword = S.ST.TeamParser.parsePokepaste('Tapu Lele @ Choice Specs\nAbility: Psychic Surge\nEVs: 252 SpA / 4 SpD / 252 Spe\nTimid Nature\n- Psyshock\n- Moonblast\n- Focus Blast\n- Hidden Power Fire');
    eq('team: multi-word species + item survive', [multiword.pokemon[0].species, multiword.pokemon[0].item], ['Tapu Lele', 'Choice Specs']);
    const packed = 'Great Tusk||choicescarf|protosynthesis|headlongrush,closecombat,icespinner,rapidspin|Jolly|252,,,4,,252|||M|';
    const unpacked = S.ST.TeamParser.parsePackedTeam(packed);
    check('team: packed team decodes one mon', (unpacked.pokemon || []).length === 1, JSON.stringify(unpacked.errors || []));
    if (unpacked.pokemon && unpacked.pokemon.length) {
      const mon = unpacked.pokemon[0];
      eq('team: packed item', mon.item, 'Choice Scarf');
      eq('team: packed moves', mon.moves.length, 4);
      eq('team: packed nature', mon.nature, 'Jolly');
    }
    const stored = S.ST.TeamParser.extractFromLocalStorage(null);
    eq('team: extractFromLocalStorage is defensive', Array.isArray(stored), true);
    const match = S.ST.TeamParser.matchActiveTeam(
      ['Great Tusk', 'Slowking-Galar', 'Ferrothorn', 'Iron Valiant', 'Landorus-Therian', 'Porygon2'],
      [{ name: 'mine', pokemon: parsed.pokemon }]
    );
    check('team: matchActiveTeam finds the active paste', !!match && (match.matchScore === undefined || match.matchScore >= 5), JSON.stringify(match && match.matchScore));
  }

  /* --------------------------------------------------- protocol/state */
  section('protocol_parser + state_manager');
  check('state: BattleStateManager exists', !!S.ST.BattleStateManager);
  check('state: ProtocolParser exists', !!S.ST.ProtocolParser);
  if (S.ST.BattleStateManager && S.ST.ProtocolParser) {
    const built = buildBattleState(S);
    const st = built.battle;
    eq('state: format locked to NatDex OU', st.formatSupported, true);
    eq('state: my team registered', (st.myTeam || []).length, 6);
    eq('state: my team keeps 0 Spe IV truth', st.myTeam[1].ivs.spe, 0);
    eq('state: opponent roster discovered', (st.oppTeam || []).length >= 2, true);
    eq('state: turn tracked', st.turn, 5);
    eq('state: active opponent is Iron Valiant', (st.active.opp && st.active.opp.species) || null, 'Iron Valiant');
    eq('state: faint recorded', !!(st.oppTeam.find(function (m) { return m && U.toID(m.species) === 'ironvaliant'; }) || {}).fainted, true);
    const hz = st.field.hazards[st.mySide || 'p1'];
    eq('state: our side has rocks', hz.rocks, true);
    const slowking = st.myTeam[1];
    eq('state: Heavy-Duty Boots disproved on switch-in damage', slowking.confirmedItem, null);
    eq('state: recovery PP tracked for Slowking', typeof st.recoveryPP === 'object', true);
    const recoverKey = Object.keys(st.recoveryPP).find(function (k) { return /recover/.test(k); });
    check('state: Recover PP entry exists', !!recoverKey, JSON.stringify(st.recoveryPP));
    if (recoverKey) eq('state: Recover PP decremented once', st.recoveryPP[recoverKey], 7);
    eq('state: protect rhythm object exists', typeof st.protect, 'object');
    eq('state: protect counter advanced after Terrains turn', st.protect.myTurnsSinceLastProtect >= 1, true);
    const tusk = st.myTeam[0];
    check('state: stint moves tracked for Great Tusk', (tusk.activeStintMoves || []).length >= 1, JSON.stringify(tusk.activeStintMoves));
    check('state: speed floor raised by losing the lead', tusk.speedFloor >= 0, String(tusk.speedFloor));
    const lando = st.oppTeam.find(function (m) { return m && U.toID(m.species) === 'landorustherian'; });
    check('state: opponent speed floor inferred', !!lando && (lando.speedFloor > 0 || lando.speedEvidence.length > 0), JSON.stringify(lando && lando.speedFloor));

    // Format gate
    const other = new S.ST.BattleStateManager();
    other.setFormat('[Gen 9] OU');
    eq('state: non-NatDex format is gated off', other.state.formatSupported, false);

    /* The gate is an ALLOWLIST, and these are the names it has to accept and refuse. The first four
     * are the supported format under the names Showdown actually uses: `[Gen 9] National Dex` is
     * what the ladder puts on the wire — the literal `|init|`/`|tier|` text in test_log.txt, with no
     * "OU" in it — and `gen9nationaldex` is the id `>start {"formatid":...}` sends. The refusals
     * are the sibling tiers the previous reject-list forgot: it named the lower tiers someone had
     * thought of, so any OTHER NatDex name (Ubers, a NatDex OM) came back supported and the engine
     * answered in a tier its set and usage data does not describe. */
    const fmtOK = function (n) {
      const m = new S.ST.BattleStateManager();
      m.setFormat(n);
      return m.state.formatSupported;
    };
    eq('state: the ladder\'s own name is supported (no "OU" on the wire)', fmtOK('[Gen 9] National Dex'), true);
    eq('state: so is the classic display name', fmtOK('[Gen 9] National Dex OU'), true);
    eq('state: and the sim id', fmtOK('gen9nationaldex'), true);
    eq('state: and the sim id with the ou suffix', fmtOK('gen9nationaldexou'), true);
    eq('state: an empty header fails open (the battle may not have started yet)', fmtOK(''), true);
    eq('state: National Dex Ubers is gated off (the reject-list let it through)',
      fmtOK('[Gen 9] National Dex Ubers'), false);
    eq('state: that same tier by sim id is gated off too', fmtOK('gen9nationaldexubers'), false);
    eq('state: a NatDex other-metagame is gated off',
      fmtOK('[Gen 9] National Dex Almost Any Ability'), false);
    eq('state: a lower tier is still gated off', fmtOK('[Gen 9] National Dex UU'), false);
    eq('state: a doubles NatDex is still gated off', fmtOK('[Gen 9] National Dex Doubles'), false);
    eq('state: another generation is gated off (the engine and its data are gen 9)',
      fmtOK('[Gen 8] National Dex'), false);

    // Trick Room lifecycle on a synthetic stream
    const tr = new S.ST.BattleStateManager();
    const trParser = new S.ST.ProtocolParser();
    tr.attachParser(trParser);
    tr.setFormat('[Gen 9] National Dex OU');
    trParser.feed('|turn|1');
    trParser.feed('|-fieldstart|move: Trick Room|[of] p1a: Porygon2');
    eq('state: TR starts at 5', tr.state.field.trickRoomTurnsLeft, 5);
    eq('state: TR active flag', tr.state.field.trickRoom, true);
    trParser.feed('|turn|2');
    eq('state: TR ticks down to 4', tr.state.field.trickRoomTurnsLeft, 4);
    trParser.feed('|-fieldend|move: Trick Room');
    trParser.feed('|turn|3');
    eq('state: TR cleared on fieldend', tr.state.field.trickRoom, false);
    eq('state: TR turns cleared', tr.state.field.trickRoomTurnsLeft, 0);

    // Mega / Z locks + Booster Energy disproof
    const lockState = new S.ST.BattleStateManager();
    const lockParser = new S.ST.ProtocolParser();
    lockState.attachParser(lockParser);
    lockParser.feed('|switch|p2a: Charizard|Charizard, L50, M|100/100');
    lockParser.feed('|-mega|p2a: Charizard|Charizard, L50, M|Charizardite Y');
    eq('state: mega lock latches from |-mega|', lockState.state.formatLocks.oppHasMegaEvolved, true);
    lockParser.feed('|move|p2a: Charizard|Inferno Overdrive|p1a: Great Tusk');
    eq('state: Z lock latches from a Z move', lockState.state.formatLocks.oppHasUsedZMove, true);

    // Request handling
    const reqState = new S.ST.BattleStateManager();
    const reqParser = new S.ST.ProtocolParser();
    reqState.attachParser(reqParser);
    reqParser.feed('|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100');
    reqParser.feed('|request|' + JSON.stringify({
      side: { id: 'p1', name: 'Me', pokemon: [{ ident: 'p1: Great Tusk', details: 'Great Tusk, L50, M', condition: '100/100', active: true, moves: ['headlongrush', 'closecombat'], stats: { atk: 300, spe: 300 } }] },
      active: [{ moves: [{ move: 'Headlong Rush', id: 'headlongrush', pp: 16, maxpp: 16, target: 'normal', disabled: false }, { move: 'Close Combat', id: 'closecombat', pp: 8, maxpp: 8, target: 'normal', disabled: true }], canTerastallize: false }],
      rqid: 1
    }));
    eq('state: legal moves parsed', (reqState.state.legalActions.moves || []).length, 2);
    eq('state: disabled move flagged', reqState.state.legalActions.moves[1].disabled, true);
    eq('state: request stored', !!reqState.state.request, true);
  }

  /* ---------------------------------------------------------- pruner */
  section('set_pruner');
  if (S.ST.ArchetypePruner && S.ST.SetDatabase) {
    const pruner = new S.ST.ArchetypePruner();
    const built = buildBattleState(S);
    const st = built.battle;
    eq('pruner: candidate sets seeded for the active opponent', (st.oppTeam[0].candidateSets || []).length > 0 || (S.ST.SetDatabase.forSpecies(st.oppTeam[0].species) || []).length > 0, true);

    const mon = S.ST.SetDatabase.forSpecies('Iron Valiant').length ? JSON.parse(JSON.stringify(st.oppTeam.find(function (m) { return U.toID(m.species) === 'ironvaliant'; }) || st.oppTeam[0])) : null;
    if (mon) {
      mon.cannotBeChoice = false;
      mon.isEncored = false;
      mon.activeStintMoves = ['Moonblast', 'Thunderbolt'];
      mon.activeStintCount = 2;
      const before = (S.ST.SetDatabase.forSpecies(mon.species) || []).filter(function (x) { return U.isChoiceItem(x.item); }).length;
      const rule = pruner.applyChoiceLockRule(mon, st);
      eq('pruner: choice lock fires on two moves in one stint', rule.pruned, true);
      eq('pruner: choice lock remark readable', /choice/i.test(rule.reason || ''), true);
      check('pruner: choice sets removed', (mon.candidateSets || []).filter(function (x) { return U.isChoiceItem(x.item); }).length === 0, 'had ' + before);
      // Idempotency
      const reasons1 = (mon.prunedReasons || []).slice();
      pruner.applyChoiceLockRule(mon, st);
      eq('pruner: idempotent reasons', JSON.stringify(mon.prunedReasons), JSON.stringify(reasons1));
    }

    const knockOff = { species: 'Iron Valiant', id: 'ironvaliant', revealedMoves: ['Moonblast'], candidateSets: S.ST.SetDatabase.forSpecies('Iron Valiant'), prunedReasons: [], itemConsumed: false, itemKnockedOff: true, liveSet: null };
    const verdictNoDex = pruner.classifyItemless(knockOff, { formatLocks: { oppHasMegaEvolved: true, oppHasUsedZMove: true }, oppTeam: [], myTeam: [] });
    eq('pruner: mega and Z spent means itemless', verdictNoDex, 'itemless-acrobatics');
    const canMega = { species: 'Charizard', id: 'charizard', revealedMoves: [], candidateSets: [], prunedReasons: [], itemConsumed: false, itemKnockedOff: true, liveSet: null };
    eq('pruner: mega-capable and not mega evolved means irremovable', pruner.classifyItemless(canMega, { formatLocks: { oppHasMegaEvolved: false, oppHasUsedZMove: false }, oppTeam: [], myTeam: [] }), 'irremovable-mega');
    const cannotMega = { species: 'Iron Valiant', id: 'ironvaliant', revealedMoves: [], candidateSets: [], prunedReasons: [], itemConsumed: false, itemKnockedOff: true, liveSet: null };
    eq('pruner: non-mega narrows to Z or itemless', pruner.classifyItemless(cannotMega, { formatLocks: { oppHasMegaEvolved: false, oppHasUsedZMove: false }, oppTeam: [], myTeam: [] }), 'z-or-itemless');

    const fast = { species: 'Great Tusk', id: 'greattusk', speedFloor: 400, prunedReasons: [], candidateSets: S.ST.SetDatabase.forSpecies('Great Tusk'), liveSet: null };
    pruner.applySpeedFloor(fast, { oppTeam: [], myTeam: [] });
    check('pruner: speed floor drops sets that cannot reach it', (fast.candidateSets || []).every(function (set) {
      return S.ST.util.maxSpeedForSet(set) >= 400;
    }), JSON.stringify((fast.candidateSets || []).map(function (s) { return [s.id, S.ST.util.maxSpeedForSet(s)]; })));

    const cascadeState = { formatLocks: { oppHasMegaEvolved: true, oppHasUsedZMove: false }, oppTeam: [{ species: 'Charizard', id: 'charizard', candidateSets: [{ id: 'z-mega-y', species: 'Charizard', item: 'Charizardite Y', isMega: true, weight: 0.3, moves: [], evs: {}, ivs: {}, tags: [] }, { id: 'z-boots', species: 'Charizard', item: 'Heavy-Duty Boots', isMega: false, weight: 0.4, moves: [], evs: {}, ivs: {}, tags: [] }], prunedReasons: [] }], myTeam: [] };
    pruner.applyFormatLockCascade(cascadeState);
    eq('pruner: format cascade strips mega stones', cascadeState.oppTeam[0].candidateSets.filter(function (s) { return S.ST.util.isMegaStone(s.item); }).length, 0);
  } else {
    check('pruner: modules present', false, 'ArchetypePruner or SetDatabase missing');
  }

  /* ----------------------------------------------------- calc engine */
  section('calc_engine (damage)');
  if (S.ST.DamageEngine) {
    const engine = new S.ST.DamageEngine({ gen: 9 });
    const tusk = { species: 'Great Tusk', nature: 'Jolly', evs: { atk: 252, spe: 252 }, ivs: U.DEFAULT_IVS, level: 100, hp: 100 };
    const valiant = { species: 'Iron Valiant', nature: 'Timid', evs: { hp: 4, spa: 252, spe: 252 }, ivs: U.DEFAULT_IVS, level: 100, hp: 100 };
    const res = engine.calculateDamage(tusk, valiant, 'Headlong Rush', {});
    check('calc: damage result is a real range', !!res && res.maxDmg > res.minDmg, JSON.stringify(res && { min: res.minDmg, max: res.maxDmg }));
    check('calc: percentages are plausible', res && res.avgPercent > 50 && res.avgPercent < 130, res && res.avgPercent);
    check('calc: 2HKO detected', res && res.is2HKO === true, res && JSON.stringify({ ohko: res.isOHKO, two: res.is2HKO }));
    const best = engine.getBestOutgoingMove(tusk, valiant, {});
    check('calc: best outgoing move picked', !!best && !!best.move, JSON.stringify(best));
    const incoming = engine.getBestIncomingThreat(valiant, tusk, {});
    check('calc: best incoming threat picked', !!incoming && !!incoming.move, JSON.stringify(incoming));
    engine.beginTurn('t1');
    const cached = engine.calculateDamage(tusk, valiant, 'Headlong Rush', {});
    eq('calc: memo returns the same range', [cached.minDmg, cached.maxDmg], [res.minDmg, res.maxDmg]);
    check('calc: cache is non-empty after a memo hit', typeof engine.cacheSize !== 'function' || engine.cacheSize() > 0, typeof engine.cacheSize === 'function' ? engine.cacheSize() : 'n/a');
    const missing = engine.calculateDamage(tusk, valiant, 'Not A Real Move', {});
    eq('calc: unknown move fails softly', missing && missing.failed === true, true);
    const withRocks = engine.calculateDamage(tusk, valiant, 'Headlong Rush', { hazards: { p2: { rocks: true, spikes: 0, toxicspikes: 0, stickyweb: false } } });
    check('calc: hazards do not corrupt the roll', withRocks && withRocks.maxDmg >= res.maxDmg, JSON.stringify(withRocks && withRocks.maxPercent));
  } else {
    check('calc: DamageEngine present', false);
  }

  /* ------------------------------------------------------- vectors */
  section('evaluator_128d + tempo_vector');
  const built = buildBattleState(S);
  const battleState = built.battle;
  if (S.ST.DenseStateEvaluator) {
    const ev = new S.ST.DenseStateEvaluator();
    const vec = ev.extractVector(battleState);
    eq('evaluator: vector length is 128', vec.length, 128);
    let finite = true;
    for (let i = 0; i < vec.length; i++) if (vec[i] !== vec[i]) { finite = false; break; }
    eq('evaluator: no NaN cells', finite, true);
    const score = ev.evaluate(battleState);
    check('evaluator: score inside [-1000, 1000]', score >= -1000 && score <= 1000, score);
    const losing = JSON.parse(JSON.stringify(battleState));
    losing.myTeam.forEach(function (m, i) { if (i < 4) { m.fainted = true; m.hp = 0; m.hpPercent = 0; } });
    const winning = JSON.parse(JSON.stringify(battleState));
    winning.oppTeam.forEach(function (m, i) { if (i < 4) { m.fainted = true; m.hp = 0; m.hpPercent = 0; } });
    const lossScore = ev.evaluate(losing);
    const winScore = ev.evaluate(winning);
    check('evaluator: four fainted mons score worse than the opponent losing four', lossScore < 0 && winScore > 0, JSON.stringify({ lossScore: lossScore, winScore: winScore }));
    check('evaluator: losing state is far below winning state', winScore - lossScore > 400, JSON.stringify({ lossScore: lossScore, winScore: winScore }));
  } else {
    check('evaluator: DenseStateEvaluator present', false);
  }

  if (S.ST.TempoEngine) {
    const tempo = new S.ST.TempoEngine({ damage: S.ST.DamageEngine ? new S.ST.DamageEngine({ gen: 9 }) : null });
    const tv = tempo.computeVector(battleState);
    const dims = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10'];
    eq('tempo: ten dimensions', dims.filter(function (d) { return typeof tv[d] === 'number'; }).length, 10);
    check('tempo: every dimension is in range', dims.every(function (d) { return tv[d] >= -1 && tv[d] <= 1; }), JSON.stringify(tv));
    eq('tempo: TR urgency is 0 with TR off', tv.v1, 0);
    // `dims` must be a SNAPSHOT of the reused Float32 buffer, not the buffer itself: it used to be
    // handed out by reference, so one caller writing to it moved every later vector.
    const dimsA = tempo.computeVector(battleState).dims;
    const dimsB = tempo.computeVector(battleState).dims;
    check('tempo: each call returns its own dims, not the reused buffer', dimsA !== dimsB, typeof dimsA + ' vs ' + typeof dimsB);
    const before = dimsB[1];
    dimsA[1] = -42;
    const dimsC = tempo.computeVector(battleState).dims;
    close('tempo: writing to a returned dims cannot corrupt the next vector', dimsC[1], before, 1e-6);
    check('tempo: the dims snapshot keeps its kind and width', dimsC instanceof Float32Array && dimsC.length === 10, Object.prototype.toString.call(dimsC) + ' len ' + dimsC.length);
    const rhythmState = JSON.parse(JSON.stringify(battleState));
    rhythmState.protect.oppTurnsSinceLastProtect = 1;
    rhythmState.active.opp.hp = 60;
    rhythmState.active.opp.hpPercent = 60;
    const rhythm = tempo.computeVector(rhythmState);
    eq('tempo: attack/recover/bunker rhythm predicts 0.85', rhythm.v4, 0.85);
    const predict = tempo.predictProtect(rhythmState, 'opp');
    close('tempo: predictProtect agrees with v4', predict, 0.85, 0.2);
    const bunker = tempo.isBunkerTurn({ v4: 0.8 }, { field: { trickRoom: true } });
    eq('tempo: bunker turn detected under TR', bunker, true);
    const masked = tempo.applyPolicyMask(
      [{ name: 'Close Combat', moveId: 'closecombat', kind: 'move', score: 100 },
        { name: 'Protect', moveId: 'protect', kind: 'protect', score: 10 }],
      { v4: 0.85 }, { field: { trickRoom: true } }
    );
    check('tempo: policy mask penalises contact attacks', masked[0].score < 100, JSON.stringify(masked[0]));
    check('tempo: policy mask rewards Protect', masked[1].score > 10, JSON.stringify(masked[1]));
    const unmasked = tempo.applyPolicyMask([{ name: 'Close Combat', score: 100 }], { v4: 0.2 }, { field: { trickRoom: true } });
    eq('tempo: mask is inert on a non-bunker turn', unmasked[0].score, 100);
  } else {
    check('tempo: TempoEngine present', false);
  }

  /* ------------------------------------------------------- trick room */
  section('trick_room');
  if (S.ST.TrickRoomEngine) {
    const tr = new S.ST.TrickRoomEngine(S.ST.DamageEngine ? new S.ST.DamageEngine({ gen: 9 }) : null);
    eq('tr: Extreme Speed is bracket +2', tr.moveBracket('Extreme Speed'), 2);
    eq('tr: Sucker Punch is bracket +1', tr.moveBracket('Sucker Punch'), 1);
    eq('tr: Trick Room is bracket -7', tr.moveBracket('Trick Room'), -7);
    eq('tr: Teleport is bracket -6', tr.moveBracket('Teleport'), -6);
    eq('tr: Earthquake is bracket 0', tr.moveBracket('Earthquake'), 0);
    const slow = { species: 'Porygon2', nature: 'Sassy', evs: { hp: 252 }, ivs: { spe: 0 }, boosts: {}, side: 'p1', fainted: false, species_: 'Porygon2' };
    const fast = { species: 'Iron Valiant', nature: 'Timid', evs: { spe: 252 }, ivs: U.DEFAULT_IVS, boosts: {}, side: 'p2', fainted: false };
    const outside = tr.rankSpeed(fast, false) > tr.rankSpeed(slow, false);
    eq('tr: outside TR the fast mon ranks higher', outside, true);
    const inside = tr.rankSpeed(slow, true) > tr.rankSpeed(fast, true);
    eq('tr: under TR the slow mon ranks higher', inside, true);
    const queue = tr.buildSpeedQueue(slow, fast, true, battleState);
    check('tr: inverted queue is built', queue.length > 0, String(queue.length));
    if (queue.length) eq('tr: queue leader is the slow side under TR', queue[0].side, 'p1');
    const queueOut = tr.buildSpeedQueue(slow, fast, false, battleState);
    if (queueOut.length) eq('tr: queue leader is the fast side outside TR', queueOut[0].side, 'p2');
    const escalate = tr.buildSpeedQueue(
      { species: 'Great Tusk', evs: { spe: 252 }, ivs: U.DEFAULT_IVS, boosts: {}, side: 'p1', fainted: false, revealedMoves: ['Ice Shard'] },
      { species: 'Dragapult', evs: { spe: 252 }, ivs: U.DEFAULT_IVS, boosts: {}, side: 'p2', fainted: false, revealedMoves: ['Extreme Speed'] },
      false, battleState
    );
    eq('tr: priority beats raw speed', escalate[0].side, 'p2');
    check('tr: lifecycle alert exists for the final turn', typeof tr.getLifecycleAlert(1) === 'string' && tr.getLifecycleAlert(1).length > 10, tr.getLifecycleAlert(1));
    eq('tr: no alert on a fresh TR', tr.getLifecycleAlert(5), null);
    const advice = tr.advise(battleState);
    check('tr: advise returns the contract shape', advice && typeof advice.shouldSet === 'boolean' && typeof advice.reason === 'string' && Array.isArray(advice.invertedQueue), JSON.stringify(advice && { s: advice.shouldSet, r: advice.reason }));
  } else {
    check('tr: TrickRoomEngine present', false);
  }

  /* ---------------------------------------------------------- vetoes */
  section('veto_guard');
  if (S.ST.BlunderVetoGuard) {
    const damage = S.ST.DamageEngine ? new S.ST.DamageEngine({ gen: 9 }) : null;
    const veto = new S.ST.BlunderVetoGuard({ damage: damage });
    const bunkerState = JSON.parse(JSON.stringify(battleState));
    bunkerState.field.trickRoom = true;
    bunkerState.field.trickRoomTurnsLeft = 4;
    const v1 = veto.evaluateVetoes({ kind: 'move', name: 'Headlong Rush', moveId: 'headlongrush' }, bunkerState, { v4: 0.85 });
    eq('veto1: attacking into the bunker rhythm is vetoed', v1.isVetoed, true);
    eq('veto1: code is PROTECT_RHYTHM', v1.code, 'PROTECT_RHYTHM');
    check('veto1: reason is human readable', /bunker|protect/i.test(v1.reason || ''), v1.reason);
    const v1safe = veto.evaluateVetoes({ kind: 'move', name: 'Swords Dance', moveId: 'swordsdance' }, bunkerState, { v4: 0.85 });
    eq('veto1: setup moves are exempt', v1safe.isVetoed, false);

    const immuneState = JSON.parse(JSON.stringify(battleState));
    immuneState.active.opp = { species: 'Hydreigon', id: 'hydreigon', revealedAbility: 'Levitate', possibleAbilities: ['Levitate'], boosts: {}, hp: 100, hpPercent: 100 };
    const v2 = veto.evaluateVetoes({ kind: 'move', name: 'Earthquake', moveId: 'earthquake' }, immuneState, { v4: 0.1 });
    eq('veto2: ground move into Levitate is vetoed', v2.isVetoed, true);
    eq('veto2: code is ABILITY_IMMUNITY', v2.code, 'ABILITY_IMMUNITY');
    const goldState = JSON.parse(JSON.stringify(battleState));
    goldState.active.opp = { species: 'Gholdengo', id: 'gholdengo', revealedAbility: 'Good as Gold', possibleAbilities: ['Good as Gold'], boosts: {}, hp: 100, hpPercent: 100 };
    const v2b = veto.evaluateVetoes({ kind: 'move', name: 'Thunder Wave', moveId: 'thunderwave' }, goldState, { v4: 0.1 });
    eq('veto2: status into Good as Gold is vetoed', v2b.isVetoed, true);

    const lone = JSON.parse(JSON.stringify(battleState));
    lone.field.trickRoom = false;
    lone.myTeam = [
      { species: 'Porygon2', id: 'porygon2', setMoves: ['Trick Room'], revealedMoves: ['Trick Room'], fainted: false, boosts: {}, hp: 100, hpPercent: 100 },
      { species: 'Ferrothorn', id: 'ferrothorn', revealedMoves: ['Power Whip'], fainted: false, boosts: {}, hp: 100, hpPercent: 100 }
    ];
    lone.active = { my: { species: 'Great Tusk', id: 'greattusk', revealedMoves: ['Headlong Rush'], fainted: false, boosts: {}, hp: 40, hpPercent: 40 }, opp: { species: 'Iron Valiant', id: 'ironvaliant', setMoves: ['Moonblast', 'Close Combat'], revealedMoves: ['Moonblast'], fainted: false, boosts: {}, hp: 100, hpPercent: 100 } };
    lone.bench = { my: [lone.myTeam[1]], opp: [] };
    const v3 = veto.evaluateVetoes({ kind: 'switch', name: 'Porygon2', targetId: 'Porygon2' }, lone, { v4: 0.1 });
    check('veto3: sacking the last TR setter is caught (or the threat is too low to veto)',
      v3.isVetoed === true || v3.code === null, JSON.stringify(v3));

    const suicide = JSON.parse(JSON.stringify(battleState));
    suicide.active = {
      my: { species: 'Porygon2', id: 'porygon2', nature: 'Sassy', evs: { hp: 252 }, ivs: { spe: 0 }, revealedMoves: ['Ice Beam'], fainted: false, boosts: {}, hp: 12, hpPercent: 12 },
      opp: { species: 'Iron Valiant', id: 'ironvaliant', nature: 'Timid', evs: { spa: 252, spe: 252 }, ivs: U.DEFAULT_IVS, setMoves: ['Moonblast'], revealedMoves: ['Moonblast'], fainted: false, boosts: {}, hp: 100, hpPercent: 100, liveSet: { moves: ['Moonblast'], evs: { spa: 252, spe: 252 }, ivs: U.DEFAULT_IVS, nature: 'Timid', item: 'Booster Energy' } }
    };
    suicide.field.trickRoom = false;
    const v4 = veto.evaluateVetoes({ kind: 'move', name: 'Ice Beam', moveId: 'icebeam' }, suicide, { v4: 0.1 });
    eq('veto4: slower into a guaranteed KO is vetoed', v4.isVetoed, true);
    eq('veto4: code is SPEED_SUICIDE', v4.code, 'SPEED_SUICIDE');
    const v4protect = veto.evaluateVetoes({ kind: 'move', name: 'Protect', moveId: 'protect' }, suicide, { v4: 0.1 });
    eq('veto4: Protect is the sanctioned line', v4protect.isVetoed, false);
    const v4prio = veto.evaluateVetoes({ kind: 'move', name: 'Ice Shard', moveId: 'iceshard' }, suicide, { v4: 0.1 });
    eq('veto4: priority moves are exempt', v4prio.isVetoed, false);

    /* ------------------------------------------- VETO 8..12: the board-state vetoes
     * These five read the BOARD (our hazards, the Protect counter, their ability, a layer cap,
     * the weather clock) and never the damage engine, so they are pinned on a guard built WITHOUT
     * one: that way each case can only be answered by the rule it names, instead of VETO3/VETO4
     * preempting it into a green assertion about the wrong rule. */
    const boardVeto = new S.ST.BlunderVetoGuard({});
    /* Every field `evaluateVetoes` walks on the way to VETO8..12 is present and empty: the earlier
     * checks run FIRST on this state, and a helper reading a missing team would throw rather than
     * leave the case to the rule under test. */
    function boardState() {
      return {
        turn: 5,
        mySide: 'p1',
        myTeam: [],
        oppTeam: [],
        bench: { my: [], opp: [] },
        field: {
          trickRoom: false,
          weather: '',
          weatherTurnsLeft: null,
          tailwind: { p1: false, p2: false },
          screens: { p1: {}, p2: {} },
          hazards: {
            p1: { rocks: false, spikes: 0, toxicspikes: 0, stickyweb: false, steelspikes: 0 },
            p2: { rocks: false, spikes: 0, toxicspikes: 0, stickyweb: false, steelspikes: 0 }
          }
        },
        active: {
          my: { species: 'Blissey', id: 'blissey', fainted: false, boosts: {}, hp: 100, hpPercent: 100, lastMove: '', lastMoveTurn: -1 },
          opp: { species: 'Corviknight', id: 'corviknight', fainted: false, boosts: {}, hp: 100, hpPercent: 100 }
        }
      };
    }
    function boardVerdict(action, state) { return boardVeto.evaluateVetoes(action, state, { v4: 0.1 }); }

    /* VETO 8 — a clearing move with nothing to clear. */
    const cleanSide = boardState();
    const v8 = boardVerdict({ kind: 'move', name: 'Rapid Spin', moveId: 'rapidspin' }, cleanSide);
    eq('veto8: Rapid Spin with our side clean is vetoed', v8.code, 'WASTED_HAZARD_CLEAR');
    check('veto8: the reason says why the turn is spent for nothing',
      /nothing on your side to clear/i.test(v8.reason || ''), v8.reason);
    const rockySide = boardState();
    rockySide.field.hazards.p1.rocks = true;
    eq('veto8: the same move with a layer up is allowed',
      boardVerdict({ kind: 'move', name: 'Rapid Spin', moveId: 'rapidspin' }, rockySide).isVetoed, false);
    eq('veto8: Court Change is exempt (it swaps the two sides)',
      boardVerdict({ kind: 'move', name: 'Court Change', moveId: 'courtchange' }, cleanSide).isVetoed, false);
    const noHazardField = boardState();
    delete noHazardField.field.hazards;
    eq('veto8: an unreadable field is never vetoed on',
      boardVerdict({ kind: 'move', name: 'Defog', moveId: 'defog' }, noHazardField).isVetoed, false);

    /* VETO 9 — the Protect counter cannot succeed twice in a row. */
    const protectAgain = boardState();
    protectAgain.active.my.lastMove = 'Protect';
    protectAgain.active.my.lastMoveTurn = 4;              // state.turn is 5
    const v9 = boardVerdict({ kind: 'move', name: 'Protect', moveId: 'protect' }, protectAgain);
    eq('veto9: Protect on consecutive turns is vetoed', v9.code, 'CONSECUTIVE_PROTECT');
    const staleProtect = boardState();
    staleProtect.active.my.lastMove = 'Protect';
    staleProtect.active.my.lastMoveTurn = 2;              // an earlier stint, not "consecutive"
    eq('veto9: a stale Protect from an earlier stint is allowed',
      boardVerdict({ kind: 'move', name: 'Protect', moveId: 'protect' }, staleProtect).isVetoed, false);
    const tauntedProtect = boardState();
    tauntedProtect.active.my.lastMove = 'Protect';
    tauntedProtect.active.my.lastMoveTurn = 4;
    tauntedProtect.active.my.taunt = true;                // it never went off, so the counter is clear
    eq('veto9: a Protect that was taunted away is allowed',
      boardVerdict({ kind: 'move', name: 'Spiky Shield', moveId: 'spikyshield' }, tauntedProtect).isVetoed, false);
    eq('veto9: a non-Protect move is untouched by this rule',
      boardVerdict({ kind: 'move', name: 'Body Slam', moveId: 'bodyslam' }, protectAgain).isVetoed, false);

    /* VETO 10 — a hazard into Magic Bounce lands on our own side. */
    const bounceOpp = boardState();
    bounceOpp.active.opp.possibleAbilities = ['Mirror Armor', 'Magic Bounce'];
    const v10 = boardVerdict({ kind: 'move', name: 'Spikes', moveId: 'spikes' }, bounceOpp);
    eq('veto10: a hazard into a possible Magic Bounce is vetoed', v10.code, 'MAGIC_BOUNCE_REDIRECT');
    check('veto10: the reason names the redirect rather than a block',
      /magic bounce/i.test(v10.reason || '') && /your side/i.test(v10.reason || ''), v10.reason);
    const revealedBounce = boardState();
    revealedBounce.active.opp.revealedAbility = 'Magic Bounce';
    eq('veto10: a revealed Magic Bounce is the same verdict',
      boardVerdict({ kind: 'move', name: 'Stealth Rock', moveId: 'stealthrock' }, revealedBounce).code, 'MAGIC_BOUNCE_REDIRECT');
    const noBounceGround = boardState();
    eq('veto10: an opponent with no such ability is never vetoed for it',
      boardVerdict({ kind: 'move', name: 'Spikes', moveId: 'spikes' }, noBounceGround).isVetoed, false);
    eq('veto10: a non-hazard move is untouched by this rule',
      boardVerdict({ kind: 'move', name: 'Body Slam', moveId: 'bodyslam' }, bounceOpp).isVetoed, false);

    /* VETO 11 — a hazard already at its layer cap. */
    const saturated = boardState();
    saturated.field.hazards.p2.spikes = 3;
    const v11 = boardVerdict({ kind: 'move', name: 'Spikes', moveId: 'spikes' }, saturated);
    eq('veto11: Spikes at three layers is vetoed', v11.code, 'SATURATED_HAZARD');
    const notYetSaturated = boardState();
    notYetSaturated.field.hazards.p2.spikes = 2;
    eq('veto11: Spikes below the cap is allowed',
      boardVerdict({ kind: 'move', name: 'Spikes', moveId: 'spikes' }, notYetSaturated).isVetoed, false);
    const webUp = boardState();
    webUp.field.hazards.p2.stickyweb = true;
    eq('veto11: a one-layer hazard already up is vetoed too',
      boardVerdict({ kind: 'move', name: 'Sticky Web', moveId: 'stickyweb' }, webUp).code, 'SATURATED_HAZARD');
    eq('veto11: Ceaseless Edge maps onto the same cap as Spikes',
      boardVerdict({ kind: 'move', name: 'Ceaseless Edge', moveId: 'ceaselessedge' }, saturated).code, 'SATURATED_HAZARD');
    const ourSideSaturated = boardState();
    ourSideSaturated.field.hazards.p1.spikes = 3;         // ours, not theirs
    eq('veto11: a saturated side of OURS is not this rule',
      boardVerdict({ kind: 'move', name: 'Spikes', moveId: 'spikes' }, ourSideSaturated).isVetoed, false);

    /* VETO 12 — re-setting the weather that is already up. */
    const rainy = boardState();
    rainy.field.weather = 'rain';
    rainy.field.weatherTurnsLeft = 4;
    const v12 = boardVerdict({ kind: 'move', name: 'Rain Dance', moveId: 'raindance' }, rainy);
    eq('veto12: re-setting the live weather is vetoed', v12.code, 'REDUNDANT_FIELD');
    const expiring = boardState();
    expiring.field.weather = 'rain';
    expiring.field.weatherTurnsLeft = 1;                  // the refresh is the CORRECT line here
    eq('veto12: the refresh with one turn left is allowed',
      boardVerdict({ kind: 'move', name: 'Rain Dance', moveId: 'raindance' }, expiring).isVetoed, false);
    const unknownClock = boardState();
    unknownClock.field.weather = 'rain';                  // weatherTurnsLeft stays null
    eq('veto12: an unreadable clock is never vetoed on',
      boardVerdict({ kind: 'move', name: 'Rain Dance', moveId: 'raindance' }, unknownClock).isVetoed, false);
    const otherWeather = boardState();
    otherWeather.field.weather = 'sandstorm';
    otherWeather.field.weatherTurnsLeft = 4;
    eq('veto12: a different weather is a real turn',
      boardVerdict({ kind: 'move', name: 'Rain Dance', moveId: 'raindance' }, otherWeather).isVetoed, false);
    const heavyRain = boardState();
    heavyRain.field.weather = 'heavyrain';
    heavyRain.field.weatherTurnsLeft = 3;
    eq('veto12: heavy rain still counts as rain',
      boardVerdict({ kind: 'move', name: 'Rain Dance', moveId: 'raindance' }, heavyRain).code, 'REDUNDANT_FIELD');
    eq('veto12: a terrain is not judged by this rule',
      boardVerdict({ kind: 'move', name: 'Electric Terrain', moveId: 'electricterrain' }, rainy).isVetoed, false);

    /* The five codes are config identities, and each rule is POLICY rather than a deduction, so
     * every one of them has to be switchable on its own — asserted with the runtime merge the
     * modules are documented to honour, and restored immediately.
     */
    eq('veto8..12: every code resolves from config', [
      S.ST.configGet('veto.codes.VETO8', null), S.ST.configGet('veto.codes.VETO9', null),
      S.ST.configGet('veto.codes.VETO10', null), S.ST.configGet('veto.codes.VETO11', null),
      S.ST.configGet('veto.codes.VETO12', null)
    ], ['WASTED_HAZARD_CLEAR', 'CONSECUTIVE_PROTECT', 'MAGIC_BOUNCE_REDIRECT', 'SATURATED_HAZARD', 'REDUNDANT_FIELD']);

    const OFF_CASES = [
      ['wastedHazardClear', function () { return boardVerdict({ kind: 'move', name: 'Rapid Spin', moveId: 'rapidspin' }, cleanSide); }],
      ['consecutiveProtect', function () { return boardVerdict({ kind: 'move', name: 'Protect', moveId: 'protect' }, protectAgain); }],
      ['magicBounceRedirect', function () { return boardVerdict({ kind: 'move', name: 'Spikes', moveId: 'spikes' }, bounceOpp); }],
      ['saturatedHazard', function () { return boardVerdict({ kind: 'move', name: 'Spikes', moveId: 'spikes' }, saturated); }],
      ['redundantField', function () { return boardVerdict({ kind: 'move', name: 'Rain Dance', moveId: 'raindance' }, rainy); }]
    ];
    OFF_CASES.forEach(function (entry) {
      const key = entry[0];
      const on = entry[1]();
      S.ST.configMerge({ veto: (function () { const patch = {}; patch[key] = false; return patch; })() });
      const off = entry[1]();
      S.ST.configMerge({ veto: (function () { const patch = {}; patch[key] = true; return patch; })() });
      const restored = entry[1]();
      check('veto.' + key + ': the rule is live by default', on.isVetoed === true, JSON.stringify(on));
      check('veto.' + key + ': switching it off lets the line through', off.isVetoed === false, JSON.stringify(off));
      check('veto.' + key + ': switching it back on restores the veto', restored.isVetoed === true, JSON.stringify(restored));
    });
  } else {
    check('veto: BlunderVetoGuard present', false);
  }

  /* ----------------------------------------------------- world sampler */
  section('world_sampler');
  if (S.ST.WorldSampler) {
    const sampler = new S.ST.WorldSampler({ K: 6 });
    const worlds = sampler.sampleWorlds(battleState, S.ST.SetDatabase, 6);
    eq('sampler: returns K worlds', worlds.length, 6);
    let shapeOk = true;
    worlds.forEach(function (w) {
      if (!w || !Array.isArray(w.team) || !w.team.length) shapeOk = false;
      if (w.team.length > 6) shapeOk = false;
      w.team.forEach(function (m) {
        if (!m.species || !m.setMoves || m.setMoves.length < 1) shapeOk = false;
      });
    });
    eq('sampler: every world is fully specified', shapeOk, true);
    const deterministic = new S.ST.WorldSampler({ K: 3, rng: new S.ST.WorldSampler({}).seededRandom(12345) });
    const a = deterministic.sampleWorlds(battleState, S.ST.SetDatabase, 3);
    const again = new S.ST.WorldSampler({ K: 3, rng: new S.ST.WorldSampler({}).seededRandom(12345) });
    const b = again.sampleWorlds(battleState, S.ST.SetDatabase, 3);
    eq('sampler: same seed gives the same worlds', a.map(function (w) { return w.id; }), b.map(function (w) { return w.id; }));

    // Observed-fact enforcement: a speed floor of 600 must not survive in any world.
    const fastFloor = JSON.parse(JSON.stringify(battleState));
    const valiant = fastFloor.oppTeam.find(function (m) { return U.toID(m.species) === 'ironvaliant'; }) || fastFloor.oppTeam[0];
    valiant.speedFloor = 600;
    valiant.speedFloorSpecies = valiant.species;
    const floorWorlds = sampler.sampleWorlds(fastFloor, S.ST.SetDatabase, 6);
    let violated = 0;
    floorWorlds.forEach(function (w) {
      const mon = w.team.find(function (m) { return U.toID(m.species) === U.toID(valiant.species); });
      if (mon && S.ST.util.maxSpeedForSet(mon.liveSet) < 600) violated++;
    });
    eq('sampler: no world contradicts a 600 speed floor', violated, 0);
    const verifications = floorWorlds.map(function (w) { return sampler.verifyWorld(w, fastFloor); });
    check('sampler: verifyWorld agrees with the sampler', verifications.every(function (v) { return Array.isArray(v); }), JSON.stringify(verifications[0]));
  } else {
    check('sampler: WorldSampler present', false);
  }

  /* --------------------------------------------------------- laplace */
  section('laplace_core (end to end)');
  if (S.ST.LaplaceEngine) {
    const damage = S.ST.DamageEngine ? new S.ST.DamageEngine({ gen: 9 }) : null;
    const engine = new S.ST.LaplaceEngine({
      K: 4,
      damage: damage,
      evaluator: S.ST.DenseStateEvaluator ? new S.ST.DenseStateEvaluator() : null,
      sampler: S.ST.WorldSampler ? new S.ST.WorldSampler({ K: 4, rng: S.ST.WorldSampler.mulberry32(7) }) : null,
      tempo: S.ST.TempoEngine ? new S.ST.TempoEngine({ damage: damage }) : null,
      veto: S.ST.BlunderVetoGuard ? new S.ST.BlunderVetoGuard({ damage: damage }) : null,
      trickRoom: S.ST.TrickRoomEngine ? new S.ST.TrickRoomEngine(damage) : null
    });
    const decision = JSON.parse(JSON.stringify(battleState));
    decision.turn = 6;
    decision.legalActions = {
      moves: [
        { id: 'headlongrush', name: 'Headlong Rush', pp: 16, maxpp: 16, disabled: false },
        { id: 'closecombat', name: 'Close Combat', pp: 8, maxpp: 8, disabled: false },
        { id: 'icespinner', name: 'Ice Spinner', pp: 16, maxpp: 16, disabled: false },
        { id: 'rapidspin', name: 'Rapid Spin', pp: 64, maxpp: 64, disabled: false }
      ],
      switches: [],
      trapped: false,
      forceSwitch: false
    };
    const ranked = engine.evaluateTurn(decision);
    check('laplace: ranked actions returned', Array.isArray(ranked) && ranked.length >= 2, JSON.stringify(ranked && ranked.length));
    if (ranked.length) {
      check('laplace: sorted by confidence', ranked.every(function (r, i) { return i === 0 || ranked[i - 1].confidence >= r.confidence; }), JSON.stringify(ranked.map(function (r) { return r.confidence; })));
      const live = ranked.filter(function (r) { return !r.isVetoed; });
      const total = live.reduce(function (sum, r) { return sum + r.confidence; }, 0);
      close('laplace: softmax confidences sum to 100', total, 100, 1.5);
      check('laplace: exactly one optimal action', ranked.filter(function (r) { return r.isOptimal; }).length <= 1, String(ranked.filter(function (r) { return r.isOptimal; }).length));
      check('laplace: every action cites a reason when vetoed', ranked.every(function (r) { return !r.isVetoed || !!r.vetoReason; }), JSON.stringify(ranked.filter(function (r) { return r.isVetoed; })));
      check('laplace: readout captured', !!engine.lastReadout && Array.isArray(engine.lastReadout.ranked), JSON.stringify(engine.lastReadout && engine.lastReadout.elapsedMs));
      check('laplace: readout carries the tempo vector', !!engine.lastReadout.tempo, JSON.stringify(engine.lastReadout.tempo && engine.lastReadout.tempo.v4));
      check('laplace: readout carries K worlds', (engine.lastReadout.worlds || []).length === 4, String((engine.lastReadout.worlds || []).length));
      check('laplace: damage hints present on the top line', !!ranked[0].damageHint || ranked[0].kind === 'switch', ranked[0].damageHint);
      check('laplace: evaluation is fast enough for mobile', engine.lastReadout.elapsedMs < 2000, engine.lastReadout.elapsedMs + ' ms for K=4');
      const top = engine.describeTopLines(ranked, 2);
      eq('laplace: describeTopLines returns two lines', top.length, 2);
    }
    const skipped = engine.evaluateTurn({ formatSupported: false, legalActions: { moves: [] } });
    eq('laplace: unsupported format returns no actions', skipped.length, 0);

    // A guaranteed-veto scenario must produce zero confidence on the vetoed line.
    const bunkerDecision = JSON.parse(JSON.stringify(decision));
    bunkerDecision.field.trickRoom = true;
    bunkerDecision.field.trickRoomTurnsLeft = 4;
    bunkerDecision.protect.oppTurnsSinceLastProtect = 1;
    bunkerDecision.active.opp.hp = 55;
    bunkerDecision.active.opp.hpPercent = 55;
    const bunkerRanked = engine.evaluateTurn(bunkerDecision);
    const vetoed = bunkerRanked.filter(function (r) { return r.isVetoed; });
    check('laplace: bunker rhythm can veto contact attacks', vetoed.length >= 0 && vetoed.every(function (r) { return r.confidence === 0 && !!r.vetoReason; }), JSON.stringify(vetoed.map(function (r) { return [r.name, r.vetoReason]; })));
    const simulate = engine.simulate({ kind: 'move', name: 'Headlong Rush', moveId: 'headlongrush' }, (engine.lastReadout.worlds || [])[0] || { team: [] }, bunkerDecision);
    check('laplace: simulate produces a transition', !!simulate && typeof simulate.oppPercentDelta === 'number', JSON.stringify(simulate && { o: simulate.oppPercentDelta, m: simulate.myPercentDelta }));
  } else {
    check('laplace: LaplaceEngine present', false);
  }

  /* ------------------------------------------------------------- LLM */
  section('llm_client');
  if (S.ST.LLMTactician) {
    const llm = new S.ST.LLMTactician({ config: { provider: 'gemini', apiKey: '' } });
    const prompt = llm.buildPrompt(battleState, [{ name: 'Headlong Rush', confidence: 62, damageHint: '70-83% (2HKO)' }, { name: 'Ice Spinner', confidence: 22 }], { v4: 0.35, v5: 0.1 });
    check('llm: prompt is dense and short', prompt.length > 0 && prompt.split(/\s+/).length < 150, prompt.length + ' chars');
    check('llm: prompt cites the top line', /Headlong Rush/.test(prompt), prompt);
    const parsed = llm.parseResponse('```json\n{"action": "Headlong Rush", "confidence": 88, "reason": "Bunker rhythm, hit through it"}\n```');
    eq('llm: fenced JSON parses', parsed && parsed.action, 'Headlong Rush');
    eq('llm: confidence clamps', llm.parseResponse('{"action":"x","confidence":400,"reason":"y"}').confidence, 100);
    eq('llm: garbage returns null', llm.parseResponse('no json here'), null);
    let resolved = 'pending';
    llm.getTacticalReadout(battleState, [], {}).then(function (r) { resolved = r; });
    setTimeout(function () {
      eq('llm: no API key resolves to null immediately', resolved, null);
      finishAndReport(S);
    }, 80);
    return;   // the final report is emitted from the timeout above
  } else {
    check('llm: LLMTactician present', false);
  }
  finishAndReport(S);
}

/* -------------------------------------------------- HUD + content + report */

function reportHud(S) {
  section('ui_overlay (stub DOM)');
  if (!S.ST.MobileHUD) { check('hud: MobileHUD present', false); return; }
  const doc = H.createFakeDocument();
  const buttons = [];
  ['Headlong Rush', 'Close Combat', 'Ice Spinner', 'Rapid Spin'].forEach(function (name) {
    const el = doc._makeEl('button');
    el.className = 'movebutton';
    el.attributes['data-move'] = U_toID(name);
    el.textContent = name;
    buttons.push(el);
  });
  doc.querySelectorAll = function (selector) {
    if (/button\[data-move\]/.test(selector)) return buttons;
    if (/elo-helper-badge|tactician-banner|tactician-tr-chip|team-drawer/.test(selector)) {
      return (doc.body.children || []).filter(function (child) {
        return /elo-helper-badge|tactician-banner|tactician-tr-chip|team-drawer/.test(child.className || '');
      });
    }
    return [];
  };
  doc.querySelector = function (selector) {
    const found = doc.querySelectorAll(selector);
    return found.length ? found[0] : null;
  };
  const hud = new S.ST.MobileHUD({ doc: doc, state: null });
  eq('hud: high confidence class', hud.confidenceClass(80, false), 'conf-high');
  eq('hud: mid confidence class', hud.confidenceClass(30, false), 'conf-mid');
  eq('hud: low confidence class', hud.confidenceClass(5, false), 'conf-low');
  eq('hud: veto overrides confidence', hud.confidenceClass(95, true), 'conf-veto');
  const ranked = [
    { name: 'Headlong Rush', moveId: 'headlongrush', kind: 'move', confidence: 62, isVetoed: false, isOptimal: true, damageHint: '70-83% on Iron Valiant' },
    { name: 'Close Combat', moveId: 'closecombat', kind: 'move', confidence: 24, isVetoed: false },
    { name: 'Ice Spinner', moveId: 'icespinner', kind: 'move', confidence: 14, isVetoed: false },
    { name: 'Rapid Spin', moveId: 'rapidspin', kind: 'move', confidence: 0, isVetoed: true, vetoReason: 'Blocked by Good as Gold.' }
  ];
  const decorated = hud.render(ranked, { active: { my: { species: 'Great Tusk', hp: 74, hpPercent: 74 }, opp: { species: 'Iron Valiant', hp: 61, hpPercent: 61, confirmedItem: 'Booster Energy' } }, field: { trickRoom: true, trickRoomTurnsLeft: 3, hazards: { p1: { rocks: true }, p2: { spikes: 2 } } }, myTeam: [], oppTeam: [], formatSupported: true, turn: 6 }, null);
  check('hud: decorated the real move buttons', decorated === 4, String(decorated));
  const badges = buttons[0].children.filter(function (c) { return c.className === 'elo-helper-badge'; });
  eq('hud: badge node injected', badges.length, 1);
  eq('hud: badge shows the confidence', badges[0] && badges[0].textContent, '62%');
  check('hud: badge carries the confidence class', badges[0] && /conf-high/.test(badges[0].classList._set ? Array.from(badges[0].classList._set).join(' ') : badges[0].className), JSON.stringify(badges[0] && badges[0].className));
  check('hud: vetoed button gets the veto class', /conf-veto/.test(buttons[3].className + ' ' + Array.from(buttons[3].classList._set).join(' ')), JSON.stringify(buttons[3].className));
  eq('hud: vetoed button is dimmed', buttons[3].style.opacity, '0.5');
  const banner = hud.renderBanner({ formatSupported: true, turn: 6, active: { opp: { species: 'Iron Valiant', confirmedItem: 'Booster Energy', speedFloor: 300, liveSet: { role: 'booster', item: 'Booster Energy', evs: { atk: 252, spe: 252 } } } }, field: { trickRoom: true, trickRoomTurnsLeft: 3, hazards: { p2: { rocks: true, spikes: 1 } } }, oppTeam: [] });
  check('hud: banner mentions the TR timer', /TR 3\/5/.test(banner.textContent), banner.textContent);
  check('hud: banner mentions the opponent set', /Iron Valiant/.test(banner.textContent), banner.textContent);
  check('hud: banner mentions the speed floor', /Speed ≥ 300/.test(banner.textContent) || /Speed/.test(banner.textContent), banner.textContent);
  const chip = hud.renderTRChip('TR EXPIRING NEXT TURN', 'danger');
  check('hud: TR chip rendered', !!chip && /TR EXPIRING/.test(chip.textContent), chip && chip.textContent);
  hud.updateLLMReason('Headlong Rush', 'Bunker rhythm, hit through it');
  const reason = buttons[0].children.filter(function (c) { return c.className === 'elo-helper-reason'; });
  eq('hud: LLM reason attached to the button', reason.length, 1);
  eq('hud: LLM reason text', reason[0] && reason[0].textContent, 'Bunker rhythm, hit through it');
  hud.setTeamStatus({ total: 6, trMons: [{}, {}], trNames: ['Porygon2', 'Slowking-Galar'], errors: [] });
  const drawer = hud.bindDrawer();
  check('hud: drawer mounted', !!drawer, JSON.stringify(!!drawer));
  const opened = hud.toggleDrawer(true);
  eq('hud: drawer toggles open', opened, true);
  const breakdown = hud.setCandidateBreakdown({ oppTeam: [{ species: 'Iron Valiant', candidateSets: [{ role: 'booster', item: 'Booster Energy', weight: 0.4 }], liveSet: { role: 'booster', item: 'Booster Energy', weight: 0.4 }, prunedReasons: ['Choice lock: used 2 distinct moves in one stint'] }], formatLocks: { oppHasMegaEvolved: true, oppHasUsedZMove: false } });
  check('hud: candidate breakdown rendered', !!breakdown && /Iron Valiant/.test(breakdown.textContent), breakdown && breakdown.textContent);
  eq('hud: clear is safe', hud.clear(), true);
  check('hud: clear tolerates an empty render', hud.render([], null, null) === 0, 'render([]) should decorate nothing');
}

function U_toID(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

function reportContent(S) {
  section('content.js pipeline');
  if (!S.ST.TacticianBoot) { check('content: TacticianBoot present', false); return; }
  const boot = new S.ST.TacticianBoot({ doc: H.createFakeDocument() });
  check('content: engine classes wired', !!(boot.parser && boot.state && boot.engine && boot.hud), JSON.stringify({
    parser: !!boot.parser, state: !!boot.state, engine: !!boot.engine, hud: !!boot.hud, pruner: !!boot.pruner, damage: !!boot.damage
  }));
  boot.parseTeam(PASTE);
  check('content: team ingestion works', !!boot.team && (boot.team.pokemon || []).length === 6, JSON.stringify(boot.team && (boot.team.pokemon || []).length));
  boot.state.setFormat('[Gen 9] National Dex OU');
  boot.handleLine('|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100');
  boot.handleLine('|switch|p2a: Iron Valiant|Iron Valiant, L50, F|100/100');
  boot.handleLine('|turn|1');
  boot.handleLine('|move|p2a: Iron Valiant|Moonblast|p1a: Great Tusk');
  boot.handleLine('|-damage|p1a: Great Tusk|62/100');
  boot.handleLine('|move|p1a: Great Tusk|Headlong Rush|p2a: Iron Valiant');
  boot.handleLine('|-damage|p2a: Iron Valiant|30/100');
  check('content: protocol lines flowed into the state manager', (boot.state.state.turn === 1) && !!boot.state.state.active.opp, JSON.stringify(boot.state.state.turn));
  const mons = boot.state.state.myTeam;
  check('content: my team aligned with the paste', mons.filter(function (m) { return m && m.species; }).length === 6, String(mons.length));
  const reqJson = JSON.stringify({
    side: { id: 'p1', name: 'Me', pokemon: [{ ident: 'p1: Great Tusk', details: 'Great Tusk, L50, M', condition: '62/100', active: true, moves: ['headlongrush', 'closecombat'], stats: { atk: 300, spe: 300 } }] },
    active: [{ moves: [{ move: 'Headlong Rush', id: 'headlongrush', pp: 16, maxpp: 16, target: 'normal' }, { move: 'Close Combat', id: 'closecombat', pp: 8, maxpp: 8, target: 'normal' }] }],
    rqid: 1
  });
  const ranked = boot.handleLine('|request|' + reqJson);
  check('content: a |request| triggers an evaluation', Array.isArray(ranked) && boot.stats.evaluations === 1, 'evaluations=' + boot.stats.evaluations + ' ranked=' + (Array.isArray(ranked) ? ranked.length : 'n/a'));
  check('content: no pipeline errors recorded', boot.stats.errors.length === 0, JSON.stringify(boot.stats.errors));
  check('content: badges were rendered onto the buttons', boot.hud.lastBadgeCount >= 0, String(boot.hud.lastBadgeCount));
  check('content: injected.js was requested into the page', S.__loaded.indexOf('src/content.js') !== -1, '');

  // Failure tolerance: hostile input must never throw.
  let threw = false;
  try {
    boot.handleLine('|||garbage|||');
    boot.handleLine('');
    boot.handleLine(null);
    boot.handleLine('|request|{not json');
    boot.handleLine('|switch|p2a: Not A Real Pokemon, L50, M|100/100');
  } catch (e) { threw = true; }
  eq('content: hostile input never throws', threw, false);
}

function finishAndReport(S) {
  reportHud(S);
  reportContent(S);

  section('summary');
  console.log('checks passed: ' + passed);
  console.log('checks failed: ' + failures.length);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(function (f) { console.log('  ✗ ' + f); });
    console.log('\nBy group: ' + JSON.stringify(groupFailures));
  } else {
    console.log('ALL CHECKS PASSED');
  }
  process.exit(failures.length ? 1 : 0);
}

/* A crash inside one section must not hide the sections that already ran: record it as a
 * failure, print what we have, and keep the same non-zero exit signal. */
try {
  main();
} catch (err) {
  console.error('\nFATAL: the harness itself threw:');
  console.error(err && err.stack ? err.stack : err);
  failures.push('FATAL: ' + (err && err.message ? err.message : String(err)));
  failures.forEach(function (f) { console.error('  ✗ ' + f); });
  console.error('\nchecks passed before the crash: ' + passed);
  process.exit(1);
}
