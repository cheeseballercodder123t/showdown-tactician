/* Showdown Tactician — tests/hud_check.js
 *
 * Run me with:  node tests/hud_check.js
 *
 * WHAT THIS IS
 *   The regression suite for the six HUD/UX features added on top of the engine: the bench-tap
 *   damage sandbox, the lethal-roll gauges, the "Detective Unmasked" deduction badges, the Trick
 *   Room haptic alert, the post-match battle receipt and the Supreme Overlord gauge. It is split
 *   in two halves, like tests/upgrades_check.js:
 *     1. the rendering contract, asserted against the harness's stub DOM (attribute names, class
 *        names, node shapes and callback wiring);
 *     2. the numbers behind it, driven through the REAL pipeline: a registered paste, raw
 *        protocol lines, the pruner and the damage engine.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about a real browser or a real phone. The Vibration API is asserted against an
 *   injected stub, the DOM is a stub whose querySelector* always returns nothing (which is why
 *   every button-level check stubs `_findMoveButtons`), no CSS is evaluated and no layout is
 *   rendered. Clipboard writing is only proved as far as "the callback received the text".
 */
'use strict';

const H = require('./harness.js');

const S = H.loadAll();
const ST = S.ST;
const U = ST.util;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; console.log('  PASS ' + name); return true; }
  failed++;
  failures.push(name + (detail === undefined ? '' : '  ->  ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  ->  ' + detail));
  return false;
}
function eq(name, got, want) {
  return check(name, JSON.stringify(got) === JSON.stringify(want),
    'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function close(name, got, want, tol) {
  const ok = typeof got === 'number' && isFinite(got) && Math.abs(got - want) <= tol;
  return check(name, ok, 'got ' + got + ', want ' + want + ' (+-' + tol + ')');
}
function section(title) { console.log('\n=== ' + title + ' ==='); }
function noThrow(fn) {
  try { return { ok: true, value: fn(), error: null }; }
  catch (e) { return { ok: false, value: undefined, error: String((e && e.message) || e) }; }
}

/**
 * Call an entry point, recording a check when it throws, and return its value.
 * A missing or throwing entry point must be a FAILED CHECK, not a crash: this suite is written
 * against a contract, so the failure has to name the method rather than stop the run at 3/11.
 */
function call(name, fn) {
  const r = noThrow(fn);
  check(name, r.ok, r.error);
  return r.value;
}

/* --------------------------------------------------------------- stub-DOM helpers
 * The stub element keeps `className` and `classList` as two independent stores, so a class is
 * "present" if EITHER one says so. Nothing here touches the real DOM. */

function kids(el) { return (el && Array.isArray(el.children)) ? el.children : []; }
function attr(el, key) { return (el && typeof el.getAttribute === 'function') ? el.getAttribute(key) : null; }
function textOf(el) { return String((el && el.textContent) || '').trim(); }
function hasClass(el, cls) {
  if (!el) return false;
  if (el.classList && typeof el.classList.contains === 'function' && el.classList.contains(cls)) return true;
  return String(el.className || '').split(/\s+/).indexOf(cls) !== -1;
}
function findAll(root, pred, acc) {
  acc = acc || [];
  kids(root).forEach(function (child) {
    if (pred(child)) acc.push(child);
    findAll(child, pred, acc);
  });
  return acc;
}
function byClass(cls) { return findAll(S.document.body, function (el) { return hasClass(el, cls); }); }
function byAttr(key) { return findAll(S.document.body, function (el) { return attr(el, key) !== null; }); }
function barsOf(btn) { return kids(btn).filter(function (c) { return attr(c, 'data-st-lethal-bar') !== null; }); }
function el(tag) { return S.document._makeEl(tag || 'div'); }
function cfg(path, fallback) {
  return typeof ST.configGet === 'function' ? ST.configGet(path, fallback) : fallback;
}
const LETHAL_BANDS = ['guaranteed', 'high', 'mid', 'none'];

let benchTaps = [];
let receiptCopies = [];
function newHud(opts) {
  const options = Object.assign({
    doc: S.document,
    onBenchTap: function (id) { benchTaps.push(id); },
    onCopyReceipt: function (text) { receiptCopies.push(text); }
  }, opts || {});
  return new ST.MobileHUD(options);
}
function hudWithButtons(buttons, opts) {
  const hud = newHud(opts);
  hud._findMoveButtons = function () { return buttons; };
  return hud;
}

/* ===================================================== 1. lethal-roll gauges */

section('1. the move buttons preview damage against the tapped target');

const b1 = el('button');
const b2 = el('button');
const b3 = el('button');
const hud1 = hudWithButtons([b1, b2, b3]);
const PREVIEW = {
  target: { species: 'Corviknight', id: 'corviknight', isActive: false },
  lines: [
    { moveId: 'firepunch', name: 'Fire Punch', minPercent: 54, maxPercent: 64, koChancePct: 0, lethal: 'mid', verdict: '2HKO', isOHKO: false },
    { moveId: 'headlongrush', name: 'Headlong Rush', minPercent: 0, maxPercent: 0, koChancePct: 0, lethal: 'none', verdict: 'No effect', isOHKO: false }
  ]
};
const decorated = call('renderMovePreviews does not throw', function () { return hud1.renderMovePreviews(PREVIEW); });
eq('only the buttons with a line are decorated', decorated, 2);
eq('the Fire Punch button carries exactly one lethal bar', barsOf(b1).length, 1);
check('a bench-targeted bar names the body it was priced against',
  /^54\s*[\u2013-]\s*64%\s+vs Corviknight$/i.test(textOf(barsOf(b1)[0])), textOf(barsOf(b1)[0]));
/* Against the ACTIVE body the verdict is the useful suffix (there is no second name to add). */
const bActive = el('button');
const hudActive = hudWithButtons([bActive]);
const ACTIVE_PREVIEW = JSON.parse(JSON.stringify(PREVIEW));
ACTIVE_PREVIEW.target.isActive = true;
call('an active-target preview does not throw', function () { return hudActive.renderMovePreviews(ACTIVE_PREVIEW); });
check('the active bar keeps the verdict because its target is implicit',
  /^54\s*[\u2013-]\s*64%\s*\(2HKO\)$/.test(textOf(barsOf(bActive)[0])), textOf(barsOf(bActive)[0]));
eq('the band is stamped on the button', attr(b1, 'data-st-lethal'), 'mid');
check('the band class is on the button', hasClass(b1, 'st-lethal-mid'), String(b1.className));
eq('an immune line reads none', attr(b2, 'data-st-lethal'), 'none');
check('the immune button still gets its bar', barsOf(b2).length === 1, String(barsOf(b2).length));
check('a button with no line gets nothing', barsOf(b3).length === 0, String(barsOf(b3).length));

/* Idempotence: Showdown rebuilds the bar constantly, so a re-render must not stack. */
call('a re-render does not throw', function () { return hud1.renderMovePreviews(PREVIEW); });
eq('re-rendering does not stack a second bar', barsOf(b1).length, 1);
eq('...on either button', barsOf(b2).length, 1);

/* Clearing: no stale KO claim may survive into the next target. */
call('clearing the previews does not throw', function () { return hud1.renderMovePreviews(null); });
check('clearing removes every bar', barsOf(b1).length === 0 && barsOf(b2).length === 0,
  barsOf(b1).length + ' / ' + barsOf(b2).length);
check('clearing removes every band class',
  LETHAL_BANDS.every(function (band) { return !hasClass(b1, 'st-lethal-' + band) && !hasClass(b2, 'st-lethal-' + band); }),
  b1.className + ' / ' + b2.className);
check('no stale band is still claiming a KO',
  LETHAL_BANDS.slice(0, 3).every(function (band) { return attr(b1, 'data-st-lethal') !== band; }),
  String(attr(b1, 'data-st-lethal')));

/* ============================================================ 2. bench strip */

section('2. the bench strip offers the opponent bench as tap targets');

benchTaps = [];
const hud2 = newHud();
const TARGETS = [
  { species: 'Corviknight', id: 'corviknight', hpPercent: 100, fainted: false },
  { species: 'Great Tusk', id: 'greattusk', hpPercent: 62, fainted: false },
  { species: 'Gholdengo', id: 'gholdengo', hpPercent: 0, fainted: true }
];
const strip = call('renderBenchTargets does not throw', function () { return hud2.renderBenchTargets(TARGETS, 'greattusk'); }) || byClass('st-bench-strip')[0];
check('a strip is rendered', !!strip);
let pills = findAll(strip, function (n) { return hasClass(n, 'st-bench-pill'); });
eq('one pill per bench mon', pills.length, 3);
check('every pill is addressable by id',
  pills.every(function (p) { return typeof attr(p, 'data-st-bench') === 'string' && attr(p, 'data-st-bench').length > 0; }),
  JSON.stringify(pills.map(function (p) { return attr(p, 'data-st-bench'); })));
check('a pill names the mon and how healthy it is',
  !!findAll(pills[0], function (n) { return hasClass(n, 'st-bench-name'); })[0] &&
    /Corviknight/.test(textOf(findAll(pills[0], function (n) { return hasClass(n, 'st-bench-name'); })[0])) &&
    /100/.test(textOf(findAll(pills[0], function (n) { return hasClass(n, 'st-bench-health'); })[0])), textOf(pills[0]));
const sprites = pills.map(function (p) { return findAll(p, function (n) { return hasClass(n, 'st-bench-sprite'); })[0]; });
eq('every visible opponent card has a sprite image', sprites.length, 3);
eq('sprite source uses the local Showdown gen5 asset path', sprites[0].src,
  'https://play.pokemonshowdown.com/sprites/gen5/corviknight.png');
eq('sprite carries the normalized form identifier', attr(sprites[0], 'data-species-sprite'), 'corviknight');
check('the sprite is decorative for screen readers', attr(sprites[0], 'aria-hidden') === 'true' && attr(sprites[0], 'alt') === '');
const selected = pills.filter(function (p) { return hasClass(p, 'st-selected'); });
eq('exactly one pill is selected', selected.length, 1);
eq('the selected pill is the tapped one', selected[0] && attr(selected[0], 'data-st-bench'), 'greattusk');
const fainted = pills.filter(function (p) { return hasClass(p, 'st-fainted'); });
eq('a fainted bench mon is marked', fainted.length, 1);
const healthFill = findAll(pills[1], function (n) { return hasClass(n, 'st-bench-meter-fill'); })[0];
eq('the card health meter reflects the target HP', healthFill && healthFill.style.width, '62%');
eq('...and it is the right one', fainted[0] && attr(fainted[0], 'data-st-bench'), 'gholdengo');

const handled = call('benchTapped does not throw', function () { return hud2.benchTapped('corviknight'); });
check('benchTapped reports that it handled the tap', handled === true, String(handled));
eq('the tap reached the callback with the id', benchTaps, ['corviknight']);
check('a second tap is reported again', hud2.benchTapped('gholdengo') === true && benchTaps.length === 2, JSON.stringify(benchTaps));

const benchCap = cfg('hud.benchStripMax', 6);
const manyTargets = [];
for (let i = 0; i < benchCap + 3; i++) {
  manyTargets.push({ species: 'Fill' + i, id: 'fill' + i, hpPercent: 100, fainted: false });
}
const strip2 = call('re-rendering the strip does not throw', function () { return hud2.renderBenchTargets(manyTargets, null); }) || byClass('st-bench-strip')[0];
const pills2 = findAll(strip2, function (n) { return hasClass(n, 'st-bench-pill'); });
eq('the strip is capped at hud.benchStripMax', pills2.length, benchCap);
const formCard = call('a regional-form sprite card renders', function () {
  return hud2.renderBenchTargets([{ species: 'Zoroark-Hisui', id: 'zoroarkhisui', hpPercent: 48 }], null);
});
const formSprite = findAll(formCard, function (n) { return hasClass(n, 'st-bench-sprite'); })[0];
eq('regional form resolves to a hyphenated sprite filename', formSprite && formSprite.src,
  'https://play.pokemonshowdown.com/sprites/gen5/zoroark-hisui.png');
eq('a known forme falls back to the base species slug', formSprite && formSprite.getAttribute('data-species-sprite'), 'zoroark-hisui');
const punctuated = call('a punctuation-safe sprite card renders', function () {
  return hud2.renderBenchTargets([{ species: "Farfetch’d-Galar", id: 'farfetchdgalar', hpPercent: 100 }], null);
});
const punctuatedSprite = findAll(punctuated, function (n) { return hasClass(n, 'st-bench-sprite'); })[0];
eq('unicode apostrophe and accents never become URL characters', punctuatedSprite && punctuatedSprite.src,
  'https://play.pokemonshowdown.com/sprites/gen5/farfetchd-galar.png');
const activeCardStrip = call('the active opponent card renders as a non-interactive roster tile', function () {
  return hud2.renderBenchTargets([{ species: 'Landorus-Therian', id: 'landorustherian', hpPercent: 37, isActive: true }], null);
});
const activeCard = findAll(activeCardStrip, function (n) { return hasClass(n, 'st-bench-pill'); })[0];
eq('active roster card is informational, not a bench-selection button', activeCard && activeCard.tagName, 'DIV');
check('active roster card is visibly state-tagged', !!activeCard && hasClass(activeCard, 'st-active'));
eq('re-rendering replaces the pills instead of appending to them', byClass('st-bench-strip').length, 1);

call('clearing the strip does not throw', function () { return hud2.renderBenchTargets(null); });
eq('clearing removes the strip entirely', byClass('st-bench-strip').length, 0);
check('clearing is a no-op, not a throw', noThrow(function () { hud2.renderBenchTargets(null); }).ok);

/* ================================================= 3. deduction badge rendering */

section('3. the deduction badges render over the opponent card');

const hud3 = newHud();
const BADGES = [
  { id: 'boots', label: 'UNMASKED: Heavy-Duty Boots (100% confirmed)', detail: 'Entered at full HP with Stealth Rock up', cls: 'unmasked' },
  { id: 'choice', label: 'CHOICE-LOCK BROKEN: Band / Specs / Scarf eliminated', detail: 'Two different moves in one stint', cls: 'choice-broken' },
  { id: 'locks', label: 'LOCKOUT ACTIVE: the remaining bench cannot hold Stones/Crystals', detail: 'Mega Evolution and the Z-Move are burned', cls: 'lockout' }
];
call('renderDeductionBadges does not throw', function () { return hud3.renderDeductionBadges(BADGES); });
const badgeNodes = byAttr('data-st-deduction');
eq('one badge node per badge', badgeNodes.length, 3);
eq('the badge ids are carried as attributes',
  badgeNodes.map(function (n) { return attr(n, 'data-st-deduction'); }).sort().join(','),
  'boots,choice,locks');
check('all three classes are applied',
  ['unmasked', 'choice-broken', 'lockout'].every(function (cls) { return byClass('st-' + cls).length === 1; }),
  JSON.stringify(badgeNodes.map(function (n) { return n.className; })));
check('the label is the visible text', /UNMASKED/.test(textOf(badgeNodes[0])), textOf(badgeNodes[0]));
check('the detail is the tooltip',
  /full HP with Stealth Rock/.test(String(attr(badgeNodes[0], 'title') || '')), String(attr(badgeNodes[0], 'title')));
call('clearing the badges does not throw', function () { return hud3.renderDeductionBadges(null); });
eq('clearing removes every badge', byAttr('data-st-deduction').length, 0);

/* ============================================================ 4. battle receipt */

section('4. the match receipt renders and hands over its text');

receiptCopies = [];
const hud4 = newHud();
const RECEIPT = {
  title: 'MATCH RECEIPT (Turn 24 — Victory!)',
  headline: 'Ash defeated Gary',
  rows: [
    { icon: '*', label: 'Match MVP', value: 'Guts Ursaluna (3 KOs, 2140 damage)' },
    { icon: '~', label: 'Trick Room efficiency', value: '8 / 10 active turns' },
    { icon: '+', label: 'Magic Bounce', value: '1 Stealth Rock reflected' }
  ],
  copyText: 'MATCH RECEIPT\nMVP: Guts Ursaluna (3 KOs)\nTR: 8 / 10'
};
const card = call('renderReceipt does not throw', function () { return hud4.renderReceipt(RECEIPT); }) || byClass('st-receipt-card')[0];
check('the card is rendered', !!card);
const titles = findAll(card, function (n) { return hasClass(n, 'st-receipt-title'); });
eq('the card has one title node', titles.length, 1);
check('the title is shown', /MATCH RECEIPT/.test(textOf(titles[0])), textOf(titles[0]));
const headlines = findAll(card, function (n) { return hasClass(n, 'st-receipt-headline'); });
check('the headline is shown', headlines.length === 1 && /Ash defeated Gary/.test(textOf(headlines[0])),
  headlines.length ? textOf(headlines[0]) : 'no headline node');
const rows = findAll(card, function (n) { return hasClass(n, 'st-receipt-row'); });
eq('one row per line of the receipt', rows.length, 3);
const allRows = rows.map(textOf).join(' | ');
check('the MVP row carries the KOs and the damage',
  /Guts Ursaluna/.test(allRows) && /3 KOs/.test(allRows) && /2140/.test(allRows), allRows);
check('the Trick Room row carries the efficiency', /8 \/ 10/.test(allRows), allRows);
check('the Magic Bounce row carries the reflection', /1 Stealth Rock reflected/.test(allRows), allRows);
const copyButtons = findAll(card, function (n) { return hasClass(n, 'st-receipt-copy'); });
eq('the card has one copy button', copyButtons.length, 1);
eq('the copy button carries the configured label', textOf(copyButtons[0]), cfg('hud.receipt.copyLabel', 'Copy Summary'));

const copied = noThrow(function () { return hud4.copyReceipt(); });
check('copyReceipt does not throw', copied.ok, copied.error);
eq('copyReceipt returns the receipt text', copied.value, RECEIPT.copyText);
eq('...and hands the same text to the clipboard callback', receiptCopies, [RECEIPT.copyText]);
call('clearing the receipt does not throw', function () { return hud4.renderReceipt(null); });
eq('clearing removes the card', byClass('st-receipt-card').length, 0);

/* ======================================================= 5. Overlord gauge render */

section('5. the Supreme Overlord gauge renders the measured boost');

const hud5 = newHud();
call('renderOverlordGauge does not throw', function () {
  return hud5.renderOverlordGauge({ species: 'Kingambit', percentBoost: 50, effectiveAtk: 607, fallen: 5 });
});
const gauges = byAttr('data-st-overlord');
eq('one gauge node', gauges.length, 1);
const gaugeText = textOf(gauges[0]);
check('it names Supreme Overlord', /SUPREME OVERLORD/.test(gaugeText), gaugeText);
check('it shows the percent boost', /\+50/.test(gaugeText), gaugeText);
check('it shows the effective Attack', /607/.test(gaugeText), gaugeText);
check('it shows how many allies fell', /5/.test(gaugeText), gaugeText);
call('clearing the gauge does not throw', function () { return hud5.renderOverlordGauge(null); });
eq('clearing removes the gauge', byAttr('data-st-overlord').length, 0);

/* =============================================================== the pipeline */

/* The same registered paste tests/upgrades_check.js uses: a physical scarfer and a Trick Room
 * special attacker, so both an immune line (Ground into a Flying target) and a real one exist. */
const PASTE = [
  'Great Tusk @ Choice Scarf',
  'Ability: Protosynthesis',
  'EVs: 252 Atk / 4 SpD / 252 Spe',
  'Jolly Nature',
  '- Headlong Rush',
  '- Close Combat',
  '- Ice Spinner',
  '- Rapid Spin',
  '',
  'Hatterene @ Leftovers',
  'Ability: Magic Bounce',
  'EVs: 252 HP / 252 SpA / 4 SpD',
  'Quiet Nature',
  '- Trick Room',
  '- Psychic',
  '- Dazzling Gleam',
  '- Healing Wish',
  ''
].join('\n');

function pipeline(lines) {
  const state = new ST.BattleStateManager({ debug: false });
  const parser = new ST.ProtocolParser();
  state.attachParser(parser);
  state.setFormat('[Gen 9] National Dex OU');
  const parsed = ST.TeamParser.parsePokepaste(PASTE);
  state.registerMyTeam(parsed.pokemon);
  (lines || []).forEach(function (l) { parser.feed(l); });
  return { state: state, parser: parser, battle: state.state || state };
}

function monOf(battle, side, id) {
  const team = side === 'my' ? battle.myTeam : battle.oppTeam;
  for (let i = 0; i < (team || []).length; i++) {
    if (team[i] && U.toID(team[i].species || team[i].id) === id) return team[i];
  }
  return null;
}

/* ================================================================ 6. preview() */

section('6. engine.preview returns per-move damage against a chosen target');

const pvFx = pipeline([
  '|player|p1|Ash|', '|player|p2|Gary|',
  '|teamsize|p1|2', '|teamsize|p2|3', '|start',
  '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
  '|switch|p2a: Corviknight|Corviknight, L50, M|100/100',
  '|turn|1'
]);
const engine = new ST.LaplaceEngine({ K: 2 });
check('the fixture has both actives (fixture sanity)', !!(pvFx.battle.active.my && pvFx.battle.active.opp),
  JSON.stringify({ my: pvFx.battle.active.my && pvFx.battle.active.my.species, opp: pvFx.battle.active.opp && pvFx.battle.active.opp.species }));
check('the engine exposes preview()', typeof engine.preview === 'function');
const preview = engine.preview(pvFx.battle.active.opp, pvFx.battle);
check('preview produced lines', !!preview && Array.isArray(preview.lines) && preview.lines.length >= 2,
  JSON.stringify(preview && preview.lines && preview.lines.length));
if (preview && preview.lines) {
  eq('the target is named', preview.target && preview.target.species, 'Corviknight');
  check('the target is the active one', preview.target && preview.target.isActive === true, JSON.stringify(preview.target));
  check('every line has a finite ordered range',
    preview.lines.every(function (l) {
      return typeof l.minPercent === 'number' && typeof l.maxPercent === 'number' &&
        isFinite(l.minPercent) && isFinite(l.maxPercent) && l.minPercent <= l.maxPercent;
    }),
    JSON.stringify(preview.lines.map(function (l) { return [l.moveId, l.minPercent, l.maxPercent]; })));
  check('every line carries a finite KO chance',
    preview.lines.every(function (l) { return typeof l.koChancePct === 'number' && isFinite(l.koChancePct); }),
    JSON.stringify(preview.lines.map(function (l) { return l.koChancePct; })));
  check('every line carries a documented band',
    preview.lines.every(function (l) { return LETHAL_BANDS.indexOf(l.lethal) !== -1; }),
    JSON.stringify(preview.lines.map(function (l) { return l.lethal; })));
  const ground = preview.lines.filter(function (l) { return l.moveId === 'headlongrush'; })[0];
  check('a Ground move into a Flying target reads 0%', !!ground && ground.minPercent === 0 && ground.maxPercent === 0,
    JSON.stringify(ground));
  check('...and is never a guaranteed KO', !!ground && ground.lethal !== 'guaranteed', ground && String(ground.lethal));
  check('a guaranteed band implies isOHKO', 
    preview.lines.every(function (l) { return l.lethal !== 'guaranteed' || l.isOHKO === true; }),
    JSON.stringify(preview.lines.map(function (l) { return [l.moveId, l.lethal, l.isOHKO]; })));
  /* THE RANGE MUST SPAN THE SURVIVING SPREADS. A single set is a guess, and printing it as the
   * board is how a 0 HP Serperior read "guaranteed OHKO" on a hit that left the real 252 HP body
   * at 2%. Each line is the envelope: its low end may be below the favourite set's minimum and its
   * high end may exceed that set's maximum, but the favourite set's own range is always inside. */
  const mainLine = preview.lines.filter(function (l) { return l.moveId === 'closecombat'; })[0];
  if (mainLine) {
    const live = engine.damage.calculateDamage(pvFx.battle.active.my, pvFx.battle.active.opp, 'Close Combat',
      pvFx.battle.field, engine._believedTargetOpts(pvFx.battle.active.opp));
    check('the line covers the favourite spread\'s own range',
      !!live && mainLine.minPercent <= live.minPercent + 1e-6 && mainLine.maxPercent >= live.maxPercent - 1e-6,
      JSON.stringify([mainLine.minPercent, live && live.minPercent, mainLine.maxPercent, live && live.maxPercent]));
    check('...and says how many spreads it covers', typeof mainLine.spreadCount === 'number' && mainLine.spreadCount >= 1,
      String(mainLine.spreadCount));
  }
  const second = engine.preview(pvFx.battle.active.opp, pvFx.battle);
  eq('two previews of the same board are identical',
    second.lines.map(function (l) { return [l.moveId, l.minPercent, l.maxPercent, l.koChancePct, l.lethal]; }),
    preview.lines.map(function (l) { return [l.moveId, l.minPercent, l.maxPercent, l.koChancePct, l.lethal]; }));
}

/* A bench target: the whole point of the feature is previewing the mon that has NOT come in. */
pvFx.battle.oppTeam.push({
  id: 'gholdengo', species: 'Gholdengo', side: 'p2', isActive: false, fainted: false,
  hpPercent: 100, hp: 100, level: 100, boosts: {}, status: '', revealedMoves: []
});
const benchPreview = noThrow(function () { return engine.previewVsBench('Gholdengo', pvFx.battle); });
check('previewVsBench does not throw', benchPreview.ok, benchPreview.error);
check('a bench species previews', !!benchPreview.value && benchPreview.value.target && benchPreview.value.target.isActive === false,
  JSON.stringify(benchPreview.value && benchPreview.value.target));
check('...with lines of its own', !!benchPreview.value && Array.isArray(benchPreview.value.lines) && benchPreview.value.lines.length >= 1,
  JSON.stringify(benchPreview.value && benchPreview.value.lines && benchPreview.value.lines.length));
check('a species that is not on their bench previews nothing',
  engine.previewVsBench('Dragapult', pvFx.battle) === null, String(engine.previewVsBench('Dragapult', pvFx.battle)));

/* ==================================== 6b. the level a battle is actually played at */

section('6b. a normalized L50 detail cannot halve the opponent');

/* The regression from a real ladder game: Showdown prints `L50` in the details string for a
 * level-100 battle, and believing it priced a 252 HP Serperior at 150 max HP. Fire Punch from a
 * burned Guts Ursaluna then read "388 - 457%" for a hit that does 84-99% in the game. */
const lvlFx = (function () {
  const state = new ST.BattleStateManager({ debug: false });
  const parser = new ST.ProtocolParser();
  state.attachParser(parser);
  state.setFormat('[Gen 9] National Dex');
  state.registerMyTeam(ST.TeamParser.parsePokepaste([
    'Ursaluna @ Flame Orb', 'Ability: Guts', 'EVs: 252 HP / 252 Atk / 4 SpD', 'Adamant Nature',
    '- Headlong Rush', '- Fire Punch', '- Facade', '- Trick Room'
  ].join('\n')).pokemon);
  parser.feedAll([
    '|switch|p1a: Ursaluna|Ursaluna, L50, M|100/100',
    '|switch|p2a: Serperior|Serperior, L50, M|100/100',
    '|-status|p1a: Ursaluna|brn|[from] item: Flame Orb',
    '|turn|5'
  ]);
  return { battle: state.state, level: new ST.LaplaceEngine({ K: 2 }) };
})();
eq('the opponent is priced at the battle level, not the printed L50', lvlFx.battle.active.opp.level, 100);
eq('...and the printed detail is kept for display', lvlFx.battle.active.opp.reportedLevel, 50);
const lvlPreview = noThrow(function () { return lvlFx.level.preview(lvlFx.battle.active.opp, lvlFx.battle); });
check('the preview runs', lvlPreview.ok && !!lvlPreview.value, lvlPreview.error);
const firePunch = lvlPreview.value && lvlPreview.value.lines.filter(function (l) { return l.moveId === 'firepunch'; })[0];
/* An unknown spread is still unknown: the card carries no EVs, so a level-100 Serperior prices
 * a little high (about 102-120%). What must never come back is the L50 doubling, which read
 * 388-457% for this exact hit. */
check('a Guts Fire Punch into Serperior reads a plausible range, not 300%+',
  !!firePunch && firePunch.minPercent > 90 && firePunch.maxPercent < 150,
  JSON.stringify(firePunch && [firePunch.minPercent, firePunch.maxPercent]));

/* ========================================================= 7. the Overlord gauge */

section('7. the Supreme Overlord multiplier is measured, not modelled');

function overlordState(species, ability, fallen) {
  const mine = {
    id: U.toID(species), species: species, side: 'p1', slot: 'p1a', index: 0, level: 100,
    nature: 'Adamant', ability: ability, item: 'Leftovers', alliesFainted: fallen,
    evs: { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 },
    ivs: U.DEFAULT_IVS, boosts: {}, status: '', fainted: false, hp: 100, hpPercent: 100, isActive: true,
    setMoves: ['Kowtow Cleave', 'Sucker Punch', 'Swords Dance', 'Iron Head'],
    revealedMoves: ['Kowtow Cleave']
  };
  const opp = {
    id: 'greattusk', species: 'Great Tusk', side: 'p2', slot: 'p2a', index: 0, level: 100,
    nature: 'Jolly', ability: 'Protosynthesis', item: 'Heavy-Duty Boots',
    evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 0, spe: 252 }, ivs: U.DEFAULT_IVS,
    boosts: {}, status: '', fainted: false, hp: 100, hpPercent: 100, isActive: true,
    setMoves: ['Earthquake'], revealedMoves: ['Earthquake']
  };
  return {
    turn: 5, mySide: 'p1', oppSide: 'p2', field: { trickRoom: false, hazards: {}, screens: {}, tailwind: {} },
    active: { my: mine, opp: opp }, myTeam: [mine], oppTeam: [opp],
    bench: { my: [], opp: [] }, formatLocks: {}, legalActions: { moves: [], switches: [] }
  };
}

check('the engine exposes overlordGauge()', typeof engine.overlordGauge === 'function');
const gauge0 = noThrow(function () { return engine.overlordGauge(overlordState('Kingambit', 'Supreme Overlord', 0)); });
check('an unboosted Kingambit still reports a gauge', gauge0.ok && !!gauge0.value, gauge0.error || JSON.stringify(gauge0.value));
if (gauge0.value) {
  close('0 fallen measures a ratio of exactly 1', gauge0.value.ratio, 1, 0.02);
  eq('...and a +0% boost', gauge0.value.percentBoost, 0);
  eq('...and reports the fallen count', gauge0.value.fallen, 0);
}
const gauge5 = noThrow(function () { return engine.overlordGauge(overlordState('Kingambit', 'Supreme Overlord', 5)); });
check('five fallen give a gauge', gauge5.ok && !!gauge5.value, gauge5.error || JSON.stringify(gauge5.value));
if (gauge5.value) {
  check('five allies measured above +20%', gauge5.value.ratio > 1.2, JSON.stringify(gauge5.value));
  eq('the percent is derived from the measured ratio', gauge5.value.percentBoost, Math.round((gauge5.value.ratio - 1) * 100));
  eq('the fallen count is reported', gauge5.value.fallen, 5);
  check('the effective Attack is a positive stat',
    typeof gauge5.value.effectiveAtk === 'number' && gauge5.value.effectiveAtk > 0, String(gauge5.value.effectiveAtk));
  check('the effective Attack exceeds the unboosted one',
    !gauge0.value || gauge5.value.effectiveAtk > gauge0.value.effectiveAtk,
    JSON.stringify([gauge0.value && gauge0.value.effectiveAtk, gauge5.value.effectiveAtk]));
} else {
  check('the five-fallen gauge is required for the rest of this section', false, 'no gauge returned');
}
check('a mon without the ability has no gauge',
  engine.overlordGauge(overlordState('Great Tusk', 'Protosynthesis', 5)) === null,
  JSON.stringify(engine.overlordGauge(overlordState('Great Tusk', 'Protosynthesis', 5))));

/* =========================================================== 8. battleStats */

section('8. the receipt numbers come from the real protocol lines');

const statsFx = pipeline([
  '|player|p1|Ash|', '|player|p2|Gary|',
  '|teamsize|p1|2', '|teamsize|p2|3', '|start',
  '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
  '|switch|p2a: Gholdengo|Gholdengo, L50, M|100/100',
  '|turn|1',
  '|move|p1a: Great Tusk|Headlong Rush|p2a: Gholdengo',
  '|-damage|p2a: Gholdengo|76/100|[from] move: Headlong Rush [of] p1a: Great Tusk',
  '|faint|p2a: Gholdengo',
  '|switch|p2b: Corviknight|Corviknight, L50, M|100/100',
  '|-fieldstart|move: Trick Room|[of] p1a: Great Tusk',
  '|-weather|Snow',
  '|turn|2',
  '|move|p1a: Great Tusk|Close Combat|p2b: Corviknight',
  '|-ability|p1a: Great Tusk|Magic Bounce',
  '|-activate|p1a: Great Tusk|ability: Magic Bounce',
  '|turn|3'
]);
const stats = statsFx.battle.battleStats;
check('the state carries a battleStats ledger', !!stats, JSON.stringify(stats));
eq('our damage is credited to us', stats && stats.damage && stats.damage.greattusk, 24);
eq('the KO is attributed to us', stats && stats.kos && stats.kos.greattusk, 1);
check('the biggest hit is recorded with its move',
  !!stats && !!stats.bestHit && stats.bestHit.moveId === 'headlongrush', JSON.stringify(stats && stats.bestHit));
check('...and with its percent', !!stats && !!stats.bestHit && stats.bestHit.percent === 24,
  JSON.stringify(stats && stats.bestHit));
check('Trick Room turns are counted', !!stats && stats.trActiveTurns >= 2, String(stats && stats.trActiveTurns));
check('...including the turns we attacked under it', !!stats && stats.trAttackTurns >= 1, String(stats && stats.trAttackTurns));
check('snow turns are counted', !!stats && stats.snowTurns >= 1, String(stats && stats.snowTurns));
check('Magic Bounce activations are counted', !!stats && stats.magicBounce >= 1, String(stats && stats.magicBounce));

/* ====================================================== 9. deduction badges */

section('9. the deduction badges are derived from real deductions');

const bootAttempt = noThrow(function () { return new ST.TacticianBoot({ doc: S.document }); });
const bootHud = bootAttempt.value;
check('TacticianBoot is constructible against the stub DOM', bootAttempt.ok && !!bootHud, bootAttempt.error);
check('it exposes _deductionBadges(state)', !!bootHud && typeof bootHud._deductionBadges === 'function');
if (bootHud && typeof bootHud._deductionBadges === 'function') {
  const bare = pipeline(['|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100']);
  const noBadges = noThrow(function () { return bootHud._deductionBadges(bare.battle); });
  check('a fresh board yields no badges', noBadges.ok && Array.isArray(noBadges.value) && noBadges.value.length === 0,
    noBadges.error || JSON.stringify(noBadges.value));

  /* Boots proof: a non-Flying body entering at 100% with Stealth Rock up (rule_checks §1). */
  const bootsFx = pipeline([
    '|player|p1|Me|1|1500', '|player|p2|Foe|2|1500',
    '|switch|p1a: Ferrothorn|Ferrothorn, L50, M|100/100',
    '|switch|p2a: Landorus-Therian|Landorus-Therian, L50, M|100/100',
    '|turn|1',
    '|move|p1a: Ferrothorn|Stealth Rock|p2',
    '|-sidestart|p2: Foe|move: Stealth Rock',
    '|turn|2',
    '|switch|p2a: Slowking-Galar|Slowking-Galar, L50, M|100/100'
  ]);
  const slowking = monOf(bootsFx.battle, 'opp', 'slowkinggalar');
  check('fixture sanity: the hazard-free entry proved the Boots',
    !!slowking && slowking.confirmedItem === 'Heavy-Duty Boots', slowking && String(slowking.confirmedItem));
  const bootBadges = noThrow(function () { return bootHud._deductionBadges(bootsFx.battle); });
  const unmasked = (bootBadges.value || []).filter(function (b) { return b && b.cls === 'unmasked'; });
  check('an unmasked badge is reported', bootBadges.ok && unmasked.length >= 1, bootBadges.error || JSON.stringify(bootBadges.value));
  check('...and it names Heavy-Duty Boots',
    unmasked.length >= 1 && /heavy-duty boots/i.test(String(unmasked[0].label) + ' ' + String(unmasked[0].detail)),
    JSON.stringify(unmasked[0]));

  /* Choice lock: two different moves in one stint, pruned exactly as content.js does it. */
  const choiceFx = pipeline([
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Iron Valiant|Iron Valiant, L50, F|100/100',
    '|turn|1',
    '|move|p2a: Iron Valiant|Moonblast|p1a: Great Tusk',
    '|-damage|p1a: Great Tusk|40/100',
    '|turn|2',
    '|move|p2a: Iron Valiant|Thunderbolt|p1a: Great Tusk',
    '|-damage|p1a: Great Tusk|5/100'
  ]);
  const valiant = monOf(choiceFx.battle, 'opp', 'ironvaliant');
  const pruner = new ST.ArchetypePruner({ damage: new ST.DamageEngine({ gen: 9 }) });
  pruner.prune(valiant, choiceFx.battle);
  check('fixture sanity: two moves in one stint broke the Choice lock',
    !!valiant && valiant.cannotBeChoice === true, valiant && String(valiant.cannotBeChoice));
  const choiceBadges = (noThrow(function () { return bootHud._deductionBadges(choiceFx.battle); }).value || [])
    .filter(function (b) { return b && b.cls === 'choice-broken'; });
  check('a choice-broken badge is reported', choiceBadges.length >= 1, JSON.stringify(choiceBadges));
  check('...and it names the items that were eliminated',
    choiceBadges.length >= 1 && /band|specs|scarf|choice/i.test(String(choiceBadges[0].label) + ' ' + String(choiceBadges[0].detail)),
    JSON.stringify(choiceBadges[0]));

  /* Format lock: an opponent Mega Evolution burns the stone mechanic for the whole team. */
  const megaFx = pipeline([
    '|player|p1|Me|1|1500', '|player|p2|Foe|2|1500',
    '|switch|p1a: Ferrothorn|Ferrothorn, L50, M|100/100',
    '|poke|p2|Charizard',
    '|switch|p2a: Charizard|Charizard, L50, M|100/100',
    '|-mega|p2a: Charizard|Charizard, L50, M|Charizardite Y'
  ]);
  check('fixture sanity: the Mega latch is set',
    megaFx.battle.formatLocks && megaFx.battle.formatLocks.oppHasMegaEvolved === true,
    JSON.stringify(megaFx.battle.formatLocks));
  const lockBadges = (noThrow(function () { return bootHud._deductionBadges(megaFx.battle); }).value || [])
    .filter(function (b) { return b && b.cls === 'lockout'; });
  check('a lockout badge is reported', lockBadges.length >= 1, JSON.stringify(lockBadges));
  check('...and it names the mechanic that is spent',
    lockBadges.length >= 1 && /mega|stone|crystal|z-?move|lockout/i.test(String(lockBadges[0].label) + ' ' + String(lockBadges[0].detail)),
    JSON.stringify(lockBadges[0]));

  /* Every badge must be renderable: the HUD contract is the only consumer. */
  const allBadges = noThrow(function () { return bootHud._deductionBadges(bootsFx.battle); }).value || [];
  check('every badge has a non-empty id, label and a known class',
    allBadges.every(function (b) {
      return b && typeof b.id === 'string' && b.id.length > 0 && typeof b.label === 'string' && b.label.length > 0 &&
        ['unmasked', 'choice-broken', 'lockout'].indexOf(b.cls) !== -1;
    }), JSON.stringify(allBadges));
} else {
  check('_deductionBadges is required for section 9', false, 'method missing');
}

/* ==================================================== 9b. the opponent scout ledger */

section('9b. the scout ledger records the facts the log printed');

if (bootHud && typeof bootHud._scoutEntries === 'function') {
  const scoutFx = pipeline([
    '|player|p1|Me|1|1500', '|player|p2|Foe|2|1500',
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Serperior|Serperior, L50, M|100/100',
    '|turn|1',
    '|move|p2a: Serperior|Leaf Storm|p1a: Great Tusk',
    '|-damage|p1a: Great Tusk|40/100',
    '|-heal|p2a: Serperior|100/100|[from] item: Leftovers',
    '|-ability|p2a: Serperior|Overgrow'
  ]);
  const entries = noThrow(function () { return bootHud._scoutEntries(scoutFx.battle); });
  check('the ledger yields an entry per revealed body', entries.ok && entries.value.length >= 1, entries.error);
  const serp = (entries.value || []).filter(function (e) { return e && e.species === 'Serperior'; })[0];
  check('the body is named', !!serp, JSON.stringify(entries.value));
  check('the move it used is logged', !!serp && (serp.moves || []).indexOf('Leaf Storm') !== -1, JSON.stringify(serp && serp.moves));
  check('the item its residual printed is logged', !!serp && serp.item === 'Leftovers', serp && String(serp.item));
  check('the ability it revealed is logged', !!serp && serp.ability === 'Overgrow', serp && String(serp.ability));
  check('a body with no facts at all is not given a row',
    (entries.value || []).every(function (e) { return e && ((e.moves || []).length || e.item || e.suspectedItem || e.ability); }),
    JSON.stringify(entries.value));
} else {
  check('_scoutEntries is required for section 9b', false, 'method missing');
}

/* ================================================= 10. the Trick Room haptic alert */

section('10. the Trick Room haptic alert fires the configured pattern');

const vibrationPattern = cfg('hud.vibrate.pattern', [40, 60, 40]);
check('the pattern is configured as an array of pulses',
  Array.isArray(vibrationPattern) && vibrationPattern.length >= 1, JSON.stringify(vibrationPattern));
const vibed = [];
const vibAttempt = noThrow(function () {
  return H.loadAll({ navigator: { vibrate: function (p) { vibed.push(p); return true; } } });
});
check('the manifest loads with an injected Vibration API', vibAttempt.ok, vibAttempt.error);
const vibBoot = vibAttempt.value && vibAttempt.value.ST.TacticianBoot
  ? noThrow(function () { return new vibAttempt.value.ST.TacticianBoot({ doc: vibAttempt.value.document }); }).value
  : null;
check('_vibrate exists', !!vibBoot && typeof vibBoot._vibrate === 'function');
if (vibBoot && typeof vibBoot._vibrate === 'function') {
  const buzzed = noThrow(function () { return vibBoot._vibrate(vibrationPattern); });
  check('vibrating does not throw', buzzed.ok, buzzed.error);
  eq('the configured pattern reached navigator.vibrate', vibed, [vibrationPattern]);
  const again = noThrow(function () { return vibBoot._vibrate([10]); });
  check('a second pulse is allowed through (the CALLER owns the once-per-battle rule)',
    again.ok && vibed.length === 2, JSON.stringify(vibed));
}
/* The gesture gate. Chromium refuses navigator.vibrate until the frame has been touched, and it
 * refuses it as a console error, so the ALERT (not _vibrate, which is the raw platform call we
 * just pinned) must not ask before the player has touched the page. */
const gateAttempt = noThrow(function () {
  return H.loadAll({ navigator: { vibrate: function (p) { return true; } } });
});
check('the manifest loads for the gesture-gate checks', gateAttempt.ok, gateAttempt.error);
if (gateAttempt.value && gateAttempt.value.ST && gateAttempt.value.ST.TacticianBoot) {
  const gatedDoc = gateAttempt.value.document;
  const gatedPulses = [];
  gateAttempt.value.navigator.vibrate = function (p) { gatedPulses.push(p); return true; };
  const trLastTurn = { field: { trickRoom: true, trickRoomTurnsLeft: 1 } };
  // Both boots listen before the gesture, because the page only gets one: B is the battle whose
  // first decision comes after the player's tap, A is the tab that was never touched.
  const untutGate = new gateAttempt.value.ST.TacticianBoot({ doc: gatedDoc }).start();
  const touchedGate = new gateAttempt.value.ST.TacticianBoot({ doc: gatedDoc }).start();
  check('a fresh boot knows the frame has not been touched',
    untutGate._userTouched === false && touchedGate._userTouched === false,
    JSON.stringify([untutGate._userTouched, touchedGate._userTouched]));
  const untutAlert = noThrow(function () { return untutGate._maybeAlertTR(trLastTurn); });
  check('the TR alert still fires its banner without a gesture', untutAlert.value === true, untutAlert.error);
  check('...but it does NOT ask the platform for a pulse it would refuse',
    gatedPulses.length === 0, JSON.stringify(gatedPulses));
  gatedDoc.dispatchEvent({ type: 'pointerdown' });
  check('a pointerdown on the page opens the gate',
    untutGate._userTouched === true && touchedGate._userTouched === true,
    JSON.stringify([untutGate._userTouched, touchedGate._userTouched]));
  check('...and the next alert is armed', touchedGate._canVibrate() === true, String(touchedGate._canVibrate()));
  const touchedAlert = noThrow(function () {
    return touchedGate._maybeAlertTR({ field: { trickRoom: true, trickRoomTurnsLeft: 1 } });
  });
  check('...so a touched frame really pulses', touchedAlert.value === true && gatedPulses.length === 1,
    JSON.stringify(gatedPulses));
} else {
  check('TacticianBoot is required for the gesture-gate checks', false, gateAttempt.error || 'missing');
}

/* No Vibration API at all: the call must degrade, not throw (and the manifest must still load,
 * which is why the load itself is wrapped rather than assumed). */
const silentAttempt = noThrow(function () { return H.loadAll({ navigator: undefined }); });
check('the manifest loads with no navigator', silentAttempt.ok, silentAttempt.error);
if (silentAttempt.value && silentAttempt.value.ST && silentAttempt.value.ST.TacticianBoot) {
  const silentBoot = new silentAttempt.value.ST.TacticianBoot({ doc: silentAttempt.value.document });
  const silent = noThrow(function () { return silentBoot._vibrate(vibrationPattern); });
  check('without the Vibration API it is a silent no-op', silent.ok, silent.error);
  check('...and it reports that nothing buzzed',
    silent.value === false || silent.value === undefined || silent.value === null, String(silent.value));
} else {
  check('TacticianBoot is required for the no-navigator check', false, silentAttempt.error || 'missing');
}

/* ============================================================ 11. defensive */

section('11. every new entry point is a no-op without a DOM');

const noDomAttempt = noThrow(function () { return H.loadAll({ document: undefined }); });
check('the whole manifest still loads with no document', noDomAttempt.ok, noDomAttempt.error);
const noDom = noDomAttempt.value;
if (noDom && noDom.ST && noDom.ST.MobileHUD) {
  eq('no module is missing from the load', (noDom.__missing || []).length, 0);
  check('the sandbox really has no document', noDom.document === undefined, String(noDom.document));
  const hud = new noDom.ST.MobileHUD({ doc: null });
  const calls = [
    ['renderMovePreviews', function () { return hud.renderMovePreviews({ lines: [{ moveId: 'x', name: 'X', minPercent: 1, maxPercent: 2, koChancePct: 0, lethal: 'none', verdict: '' }] }); }],
    ['renderBenchTargets', function () { return hud.renderBenchTargets([{ species: 'X', id: 'x', hpPercent: 100 }], 'x'); }],
    ['renderDeductionBadges', function () { return hud.renderDeductionBadges([{ id: 'a', label: 'A', detail: 'B', cls: 'unmasked' }]); }],
    ['renderReceipt', function () { return hud.renderReceipt({ title: 'T', headline: 'H', rows: [{ icon: 'i', label: 'l', value: 'v' }], copyText: 'c' }); }],
    ['renderOverlordGauge', function () { return hud.renderOverlordGauge({ species: 'K', percentBoost: 50, effectiveAtk: 600, fallen: 5 }); }],
    ['benchTapped', function () { return hud.benchTapped('x'); }],
    ['copyReceipt', function () { return hud.copyReceipt(); }]
  ];
  calls.forEach(function (pair) {
    const r = noThrow(pair[1]);
    check(pair[0] + ' without a DOM neither throws nor renders', r.ok && !r.value,
      r.ok ? 'returned ' + String(r.value) : r.error);
  });
} else {
  check('MobileHUD is required for section 11', false, noDomAttempt.error || 'no ST.MobileHUD in the no-DOM sandbox');
}
const noButtons = hudWithButtons([]);
const noButtonRender = noThrow(function () { return noButtons.renderMovePreviews({ lines: [] }); });
check('a HUD with no move buttons is a no-op',
  noButtonRender.ok && !noButtonRender.value, noButtonRender.ok ? String(noButtonRender.value) : noButtonRender.error);

/* ================================ 12. the bench-tap sandbox, driven end to end */

section('12. tapping a bench body re-prices the move buttons against that body');

/* The feature as the brief states it: tap a body on the opponent's bench panel and the four move
 * buttons instantly show what THIS move does to THAT body. Sections 1 and 6 pin the two halves
 * separately (the button decorator, the bench preview) against synthetic inputs; this drives the
 * tap itself through TacticianBoot, so the wiring between them — tap -> selection -> preview ->
 * buttons — is a covered path rather than an assumption.
 *
 * The fixture is the crispest available proof. Their ACTIVE body is Corviknight, which Ground
 * cannot touch at all; their bench holds Gholdengo, whose Normal-immunity and Air Balloon each
 * kill one of our buttons. Every line answers to a different mechanic, so "the numbers changed"
 * cannot be satisfied by noise.
 *
 * Two fixture rules, both learned the hard way.
 *   - The bench is built the way a real singles log builds one: the body comes in, acts, and then
 *     leaves for the next one. A `p2b` switch is a DOUBLES slot and marks both slots active, so it
 *     never produces a bench body at all.
 *   - Both sides are level 100, as they are in a real [Gen 9] National Dex OU log. Our own body
 *     takes its level from the paste (which does not state one) while theirs takes it from the
 *     switch line, so a fixture that says `L50` for them and nothing for us prices a level-100
 *     attacker against a level-50 HP pool and inflates every number roughly fivefold. */
const TAP_LINES = [
  '|player|p1|Ash|', '|player|p2|Gary|',
  '|teamsize|p1|2', '|teamsize|p2|3', '|start',
  '|switch|p1a: Great Tusk|Great Tusk, L100, M|100/100',
  '|switch|p2a: Gholdengo|Gholdengo, L100, M|100/100',
  '|turn|1',
  '|move|p2a: Gholdengo|Shadow Ball|p1a: Great Tusk',
  '|switch|p2a: Corviknight|Corviknight, L100, M|100/100',
  '|turn|2'
];
const TAP_BOOT = call('the boot starts for the bench-tap fixture', function () {
  const boot = new ST.TacticianBoot({ doc: S.document });
  boot.parseTeam(PASTE);
  TAP_LINES.forEach(function (l) { boot.handleLine(l, 'recv'); });
  return boot;
});
if (TAP_BOOT && TAP_BOOT.hud && TAP_BOOT.state) {
  const tapState = TAP_BOOT.state.state || TAP_BOOT.state;
  const TAP_MOVES = ['headlongrush', 'closecombat', 'icespinner', 'rapidspin'];
  const tapButtons = TAP_MOVES.map(function (id) {
    const b = el('button');
    if (b.setAttribute) b.setAttribute('data-move', id);
    return b;
  });
  TAP_BOOT.hud._findMoveButtons = function () { return tapButtons; };
  const groundBtn = tapButtons[0];
  const spinBtn = tapButtons[3];
  const iceBtn = tapButtons[2];
  function barOf(btn) { const bars = barsOf(btn); return bars.length ? textOf(bars[0]) : ''; }
  function groundBar() { return barOf(groundBtn); }
  /** The previewed range as a string, so "did these numbers change?" is one comparison. */
  function rangeOf(btn) { return barOf(btn).replace(/\s+/g, ''); }
  function benchPills() {
    const strip = byClass('st-bench-strip')[0];
    return strip ? findAll(strip, function (n) {
      return hasClass(n, 'st-bench-pill') && n.tagName === 'BUTTON';
    }) : [];
  }
  function selectedPillIds() {
    return benchPills().filter(function (p) { return hasClass(p, 'st-selected'); })
      .map(function (p) { return String(attr(p, 'data-st-bench')); });
  }

  call('the initial render does not throw', function () { return TAP_BOOT._renderScreenExtras(tapState); });
  check('fixture sanity: Corviknight is the body they have out',
    !!tapState.active.opp && U.toID(tapState.active.opp.species) === 'corviknight',
    JSON.stringify(tapState.active.opp && tapState.active.opp.species));
  eq('fixture sanity: Gholdengo is only on their bench, and is the only pill offered',
    benchPills().map(function (p) { return String(attr(p, 'data-st-bench')); }), ['gholdengo']);
  eq('before any tap the buttons describe their ACTIVE body', attr(groundBtn, 'data-st-lethal'), 'none');
  check('...as the immunity the fixture is built around (Ground into a Flying body)',
    /\b0%/.test(groundBar()), groundBar());
  check('...while a move that does connect has a real range',
    /[0-9.]+\s*[\u2013-]\s*[0-9.]+%/.test(barOf(spinBtn)), barOf(spinBtn));
  const activeRanges = tapButtons.map(function (b) { return rangeOf(b); });

  const tapped = call('a tap on the bench pill does not throw', function () {
    return TAP_BOOT.hud.benchTapped('gholdengo');
  });
  check('the tap is accepted', tapped === true, String(tapped));
  eq('...and selects that body', TAP_BOOT.selectedBenchId, 'gholdengo');
  eq('the strip marks the tapped body as the one being previewed', selectedPillIds(), ['gholdengo']);
  check('every button is still priced', tapButtons.every(function (b) { return !!attr(b, 'data-st-lethal'); }),
    JSON.stringify(tapButtons.map(function (b) { return attr(b, 'data-st-lethal'); })));
  check('the buttons are no longer the active body\'s numbers',
    tapButtons.map(function (b) { return rangeOf(b); }).join('|') !== activeRanges.join('|'),
    JSON.stringify({ before: activeRanges, after: tapButtons.map(function (b) { return rangeOf(b); }) }));
  /* Two immunities, one per target, each from a different mechanic: their active body is Flying
   * (Ground does nothing), the body on the bench holds an Air Balloon (Ground does nothing) and is
   * a Ghost (Normal does nothing). */
  eq('Ground cannot KO the tapped body — its Air Balloon, not its typing',
    attr(groundBtn, 'data-st-lethal'), 'none');
  // The range is an ENVELOPE over the sets the log has not ruled out. Gholdengo's Air Balloon is
  // the pruner's favourite but not the only candidate, so the bar starts at 0 (the balloon world)
  // and reaches the no-balloon ceiling. What must never happen is a guaranteed KO, or a 0 missing
  // from the low end — the immunity has to be visible on the button.
  check('the bar starts at the immunity the top set proves', /^0\s*(?:[\u2013\u2014-]|%)/.test(groundBar()) || /\b0%/.test(groundBar()), groundBar());
  check('...and does not promise a KO the balloon set forbids',
    attr(groundBtn, 'data-st-lethal') !== 'guaranteed', String(attr(groundBtn, 'data-st-lethal')));
  eq('the Normal move is now an immunity as well (Ghost)', attr(spinBtn, 'data-st-lethal'), 'none');
  check('...while the move that does connect has a different range than it had before',
    rangeOf(iceBtn) !== activeRanges[2] && /[0-9.]+%/.test(rangeOf(iceBtn)),
    JSON.stringify({ was: activeRanges[2], now: rangeOf(iceBtn) }));

  /* The numbers must come from the target's BELIEVED SET, not from its bare log card. That card is
   * an all-zero EV placeholder with no item, and pricing against it is how this feature first
   * reported 500% for the very Ground move that an Air Balloon makes impossible. */
  const benchMon = (tapState.oppTeam || []).filter(function (m) { return U.toID(m.species) === 'gholdengo'; })[0];
  const believed = benchMon && (benchMon.liveSet || (benchMon.candidateSets || [])[0]);
  check('the tapped body has a believed set to price (fixture sanity)', !!believed,
    JSON.stringify({ liveSet: !!benchMon.liveSet, candidates: (benchMon.candidateSets || []).length }));
  if (believed) {
    const viaEngine = TAP_BOOT.engine.previewVsBench('gholdengo', tapState);
    const iceLine = viaEngine.lines.filter(function (l) { return l.moveId === 'icespinner'; })[0];
    const direct = TAP_BOOT.damage.calculateDamage(tapState.active.my, benchMon, 'Ice Spinner',
      tapState.field, TAP_BOOT.engine._believedTargetOpts(benchMon));
    close('the button prints the library number for that set', iceLine && iceLine.maxPercent,
      direct.maxPercent, 1e-6);
    const bare = TAP_BOOT.damage.calculateDamage(tapState.active.my, benchMon, 'Headlong Rush', tapState.field);
    check('the bare log card would have priced the Air Balloon hit as damage instead of an immunity',
      bare.minPercent > 0, JSON.stringify({ bare: [bare.minPercent, bare.maxPercent], previewed: groundBar() }));
  }

  const untapped = call('tapping the same body again does not throw', function () {
    return TAP_BOOT.hud.benchTapped('gholdengo');
  });
  check('...and is accepted', untapped === true, String(untapped));
  eq('a second tap on the SAME body clears the selection', TAP_BOOT.selectedBenchId, null);
  eq('...so the buttons describe their active body again',
    tapButtons.map(function (b) { return rangeOf(b); }).join('|'), activeRanges.join('|'));
  eq('...and no pill claims to be selected', selectedPillIds(), []);
  check('...with the immune reading restored', /\b0%/.test(groundBar()), groundBar());

  /* A body that leaves the bench invalidates the selection rather than the card. */
  call('switching the tapped body in does not throw', function () {
    return TAP_BOOT.hud.benchTapped('gholdengo');
  });
  eq('the selection is live again', TAP_BOOT.selectedBenchId, 'gholdengo');
  TAP_LINES.concat(['|switch|p2a: Gholdengo|Gholdengo, L100, M|100/100']).forEach(function (l) {
    TAP_BOOT.handleLine(l, 'recv');
  });
  call('the selection is re-resolved after it switches in', function () {
    return TAP_BOOT._renderScreenExtras(TAP_BOOT.state.state || TAP_BOOT.state);
  });
  eq('a body that left the bench drops the selection instead of showing a stale card',
    TAP_BOOT.selectedBenchId, null);
  eq('...and the strip now offers the body it replaced',
    benchPills().map(function (p) { return String(attr(p, 'data-st-bench')); }), ['corviknight']);
} else {
  check('TacticianBoot is required for the bench-tap fixture', false, 'missing boot, hud or state');
}

/* ================================================== 13. move-button identity
 *
 * WHY THIS EXISTS. The HUD decorates Showdown's own move buttons, and it can only do that if
 * it can read a move id off them. The two live clients label those buttons DIFFERENTLY:
 *
 *   classic (play.pokemonshowdown.com/oldclient, js/oldclient/client-battle.js)
 *     <button class="movebutton" name="chooseMove" data-move="<id>" …>
 *   new     (play.pokemonshowdown.com/newclient, src/panel-battle.tsx renderMoveButton)
 *     <button class="movebutton" data-cmd="/move N" data-tooltip="move|<NAME>|<pos>">
 *
 * The new client drops BOTH `data-move` and `name`, so `_moveIdOf` has to fall back to the
 * tooltip payload — and that payload is built from `moveData.name`, the DISPLAY NAME, not the
 * id. A capture that stops at the first non-alphanumeric (the bug this section exists to pin)
 * silently decorates NOTHING on the new client for every move whose name has a space or a
 * hyphen, which is most of them: "Headlong Rush", "Rapid Spin", "Will-O-Wisp", "U-turn".
 * The e2e fixture only renders classic markup, so nothing downstream caught it.
 */

section('13. every PS move-button markup resolves to the engine\'s move id');

const idHud = newHud();

/** Build a stand-in move button with exactly the attributes the given client emits. */
function moveButton(props) {
  const b = el('button');
  Object.keys(props || {}).forEach(function (k) {
    if (b.setAttribute && props[k] !== null) b.setAttribute(k, props[k]);
  });
  if (props && props.label) b.textContent = props.label;
  return b;
}

// --- classic client: `data-move` is the id, and it wins over everything else.
eq('classic: data-move is the id the engine keys on',
  idHud._moveIdOf(moveButton({ 'data-move': 'headlongrush', name: 'chooseMove' })), 'headlongrush');
eq('classic: a Struggle button (the fallback the client renders) still resolves',
  idHud._moveIdOf(moveButton({ 'data-move': 'Struggle', 'data-target': 'randomNormal' })), 'struggle');
eq('classic: data-move beats the tooltip and the text, which are free to disagree',
  idHud._moveIdOf(moveButton({
    'data-move': 'closecombat', 'data-tooltip': 'move|Close Combat|0', label: 'Close Combat'
  })), 'closecombat');

// --- new client: no data-move, no name, only the tooltip payload and an index in data-cmd.
eq('new: the tooltip resolves an ordinary two-word move',
  idHud._moveIdOf(moveButton({
    'data-cmd': '/move 1', 'data-tooltip': 'move|Headlong Rush|0', label: 'Headlong Rush'
  })), 'headlongrush');
eq('new: a hyphenated move resolves (the case a [A-Za-z0-9]+ capture stops at)',
  idHud._moveIdOf(moveButton({
    'data-cmd': '/move 3', 'data-tooltip': 'move|Will-O-Wisp|0', label: 'Will-O-Wisp'
  })), 'willowisp');
eq('new: another hyphenated move',
  idHud._moveIdOf(moveButton({ 'data-cmd': '/move 4', 'data-tooltip': 'move|U-turn|0' })), 'uturn');
eq('new: the Z-Move variant of the payload resolves',
  idHud._moveIdOf(moveButton({ 'data-cmd': '/move 1 zmove', 'data-tooltip': 'zmove|Flamethrower|0' })),
  'flamethrower');
eq('new: the Max Move variant (with its gmax suffix) resolves',
  idHud._moveIdOf(moveButton({ 'data-cmd': '/move 1 max', 'data-tooltip': 'maxmove|Max Flare|0|gmaxwildfire' })),
  'maxflare');

// --- A payload that is NOT a move must not be mistaken for one: the tooltip is a shared
//     attribute and the client puts switch/team payloads on the same buttons.
const switchBtn = moveButton({ 'data-cmd': '/switch 2', 'data-tooltip': 'switch|2|0', label: 'Iron Valiant' });
check('new: a switch payload is not read as a move (it falls through, never invents an id)',
  idHud._moveIdOf(switchBtn) === U.toID('Iron Valiant'), String(idHud._moveIdOf(switchBtn)));

// --- Nothing at all: the documented (lossy) last resort, and it must not throw.
eq('an unlabelled button with no attributes is a no-op, not a throw',
  idHud._moveIdOf(moveButton({})), '');
eq('a null button is a no-op', idHud._moveIdOf(null), '');

// --- WHY the tooltip fallback exists, stated as a check. A real move button renders its name,
//     its type and its PP in one text node ("Headlong Rush<br><small>Ground</small> 16/16"), so
//     `textContent` is a concatenation whose toID matches nothing the engine produced. Any test
//     that builds a button with ONLY the move name in it is too kind: the fallback would rescue
//     it and the bug (no tooltip match) would go undetected.
eq('a button with no tooltip degrades to the concatenated text, which matches no action',
  idHud._moveIdOf(moveButton({ label: 'Headlong RushGround 16/16 ' })), 'headlongrushground1616');

// --- End to end: the new-client markup is what decides whether a badge is drawn at all.
//     The labels are the REAL rendered text (name + type + pp), which is the whole point: with a
//     broken tooltip capture these buttons resolve to nothing and `render` decorates 0 of 4,
//     which is exactly the silent no-op the new client shipped with.
const NEW_CLIENT_BUTTONS = [
  moveButton({ 'data-cmd': '/move 1', 'data-tooltip': 'move|Headlong Rush|0', label: 'Headlong RushGround 16/16 ' }),
  moveButton({ 'data-cmd': '/move 2', 'data-tooltip': 'move|Close Combat|0', label: 'Close CombatFighting 8/8 ' }),
  moveButton({ 'data-cmd': '/move 3', 'data-tooltip': 'move|Will-O-Wisp|0', label: 'Will-O-WispFire 24/24 ' }),
  moveButton({ 'data-cmd': '/move 4', 'data-tooltip': 'move|Rapid Spin|0', label: 'Rapid SpinNormal 32/32 ' })
];
const RANKED = [
  { moveId: 'headlongrush', name: 'Headlong Rush', confidence: 78, score: 210.4, isOptimal: true },
  { moveId: 'closecombat', name: 'Close Combat', confidence: 41, score: 64.1 },
  { moveId: 'willowisp', name: 'Will-O-Wisp', confidence: 22, score: -18.2 },
  { moveId: 'rapidspin', name: 'Rapid Spin', confidence: 12, score: -95.7, isVetoed: true }
];
const newClientHud = hudWithButtons(NEW_CLIENT_BUTTONS);
const decoratedNew = call('rendering against new-client markup does not throw', function () {
  return newClientHud.render(RANKED, null, null);
});
eq('the new client decorates every button (0 here is the silent no-op this section pins)',
  decoratedNew, 4);
eq('...and the HUD agrees on how many it decorated', newClientHud.lastBadgeCount, 4);
eq('the hyphenated move carries the confidence of the action it was matched to',
  textOf(NEW_CLIENT_BUTTONS[2].querySelector('.elo-helper-badge') ||
    (NEW_CLIENT_BUTTONS[2].children || [])[0]), '22%');

/* ============================== 14. the Cancel-window background ponder */

section('14. the Cancel window: what the deeper pass may say, and when it may interrupt');

/* The two-pass boot (src/content.js): Pass 1 is the fast, synchronous read that paints the HUD;
 * Pass 2 is a deeper read scheduled on the next tick. These checks are about the DECISIONS the boot
 * makes with Pass 2's answer — the DOM lifecycle of the alert itself is tests/dom_check.js §11 — so
 * the HUD is a recorder here rather than a document. */

const PONDER_STATE = {
  turn: 7,
  formatSupported: true,
  request: {
    active: [{
      moves: [
        { id: 'closecombat', move: 'Close Combat', pp: 8, maxpp: 8 },
        { id: 'moonblast', move: 'Moonblast', pp: 8, maxpp: 8 },
        { id: 'icespinner', move: 'Ice Spinner', pp: 16, maxpp: 16 }
      ]
    }],
    side: {
      pokemon: [
        { ident: 'p1: Iron Valiant', species: 'Iron Valiant', active: true, condition: '100/100' },
        { ident: 'p1: Great Tusk', species: 'Great Tusk', condition: '100/100' },
        { ident: 'p1: Gholdengo', species: 'Gholdengo', condition: '100/100' }
      ]
    }
  },
  field: {},
  myTeam: [],
  oppTeam: []
};

function ponderEngine(ranked, calls) {
  return {
    lastReadout: null,
    preview: null,
    evaluateTurn: function (state, opts) {
      if (calls) calls.push(opts || null);
      this.lastReadout = { stub: true, ranked: ranked };
      return ranked.slice();
    }
  };
}

const ponderBoot = call('the boot constructs for the ponder fixture', function () {
  return new ST.TacticianBoot({ doc: S.document });
});
if (!ponderBoot) {
  check('TacticianBoot is required for section 14', false, 'no boot');
} else {
  const cleared = [];
  const alerts = [];
  ponderBoot.hud.clearCancelAlert = function () { cleared.push(1); return null; };
  ponderBoot.hud.renderCancelAlert = function (info) { alerts.push(info); return info; };

  /* --- reading the player's own commands off the wire */
  ponderBoot._noteOutgoingChoice('/choose move 2');
  check('a bare /choose move is read as a locked move',
    !!ponderBoot._lockedChoice && ponderBoot._lockedChoice.kind === 'move' && ponderBoot._lockedChoice.arg === '2',
    JSON.stringify(ponderBoot._lockedChoice));
  const splitWire = noThrow(function () { return ponderBoot._noteOutgoingChoice('battle-gen9ou-1|/choose move 3|12'); });
  check('the split wire form (room|command|rqid) is read too',
    splitWire.ok && !!ponderBoot._lockedChoice && ponderBoot._lockedChoice.arg === '3',
    splitWire.error || JSON.stringify(ponderBoot._lockedChoice));
  ponderBoot._noteOutgoingChoice('/choose switch 2');
  check('a locked switch is read as a switch',
    !!ponderBoot._lockedChoice && ponderBoot._lockedChoice.kind === 'switch' && ponderBoot._lockedChoice.arg === '2');
  ponderBoot._noteOutgoingChoice('/choose team 123456');
  check('a team-preview choice is not a locked move', ponderBoot._lockedChoice === null);
  ponderBoot._noteOutgoingChoice('/choose move 1');
  ponderBoot._noteOutgoingChoice('/undo');
  check('/undo releases the lock', ponderBoot._lockedChoice === null);
  ponderBoot._noteOutgoingChoice('|move|p1a: Iron Valiant|Close Combat|p2a: Kingambit');
  check('an inbound battle line is not mistaken for our own command', ponderBoot._lockedChoice === null);

  /* --- the wire's slot number resolved against the REQUEST, which is the only honest mapping */
  ponderBoot._noteOutgoingChoice('/choose move 2');
  const lockedMove = ponderBoot._lockedAction(PONDER_STATE);
  check('the locked slot resolves to the move the request lists there',
    !!lockedMove && lockedMove.id === 'moonblast' && lockedMove.name === 'Moonblast', JSON.stringify(lockedMove));
  ponderBoot._noteOutgoingChoice('/choose move 9');
  check('an out-of-range slot resolves to NOTHING rather than a guess',
    ponderBoot._lockedAction(PONDER_STATE) === null);
  ponderBoot._noteOutgoingChoice('/choose switch 3');
  const lockedSwitch = ponderBoot._lockedAction(PONDER_STATE);
  check('a locked switch resolves to the bench body the request lists',
    !!lockedSwitch && lockedSwitch.id === 'gholdengo', JSON.stringify(lockedSwitch));
  ponderBoot._noteOutgoingChoice('/undo');
  check('no lock means no locked action', ponderBoot._lockedAction(PONDER_STATE) === null);

  /* --- a new window invalidates everything from the old one */
  const clearedBefore = cleared.length;
  const idBefore = ponderBoot._ponderId;
  ponderBoot._noteOutgoingChoice('/choose move 1');
  ponderBoot._closePonderWindow();
  check('closing a window bumps the monotonic pass id', ponderBoot._ponderId === idBefore + 1);
  check('...and drops the locked choice', ponderBoot._lockedChoice === null);
  check('...and takes the Cancel alert down', cleared.length === clearedBefore + 1);

  /* --- the plan, and the deep call's own contract */
  const plan = ponderBoot._deepPonderPlan();
  check('the plan comes from laplace.deepPonder',
    !!plan && plan.deepWorlds === 14 && plan.useBeam2Ply === true && plan.cancelAlertScoreDelta === 45,
    JSON.stringify(plan));
  const deepCalls = [];
  ponderBoot.engine = ponderEngine([{ name: 'Moonblast', moveId: 'moonblast', confidence: 55, score: 100 }], deepCalls);
  ponderBoot._runDeepPonder(PONDER_STATE, plan, ponderBoot._ponderId - 1);
  check('a pass from a CLOSED window never reaches the engine', deepCalls.length === 0);

  const caseA = call('the deep pass runs for the live window', function () {
    return ponderBoot._runDeepPonder(PONDER_STATE, plan, ponderBoot._ponderId);
  });
  eq('the engine is asked once', deepCalls.length, 1);
  const deepOpts = deepCalls[0] || {};
  eq('...with the deeper world count', deepOpts.K, 14);
  eq('...as a RE-READ (so the per-turn side effects do not run twice)', deepOpts.reread, true);
  eq('...and with the 2-ply beam forced on', deepOpts.beam2Ply, true);
  check('the deeper ranking is returned and published', Array.isArray(caseA) && caseA[0].name === 'Moonblast');
  check('...as the readout the HUD is showing', !!ponderBoot.pendingReadout && ponderBoot.pendingReadout.stub === true);
  check('...and the menu-open case is recorded',
    !!ponderBoot.lastPonder && ponderBoot.lastPonder.mode === 'menu-open' && ponderBoot.lastPonder.updated === true,
    JSON.stringify(ponderBoot.lastPonder));
  eq('the ponder is counted as work done', ponderBoot.stats.ponders, 1);
  check('an open menu draws no alert', alerts.length === 0);

  /* --- CASE B: a locked move, and a deeper ranking that agrees */
  ponderBoot._noteOutgoingChoice('/choose move 2');
  ponderBoot.engine = ponderEngine([
    { name: 'Moonblast', moveId: 'moonblast', confidence: 55, score: 100 },
    { name: 'Close Combat', moveId: 'closecombat', confidence: 20, score: 10 }
  ], []);
  ponderBoot._runDeepPonder(PONDER_STATE, plan, ponderBoot._ponderId);
  check('a locked line the deeper pass still ranks first draws NO alert',
    alerts.length === 0 && !!ponderBoot.lastPonder && ponderBoot.lastPonder.agreed === true,
    JSON.stringify(ponderBoot.lastPonder));

  const scoreAlert = function (topScore, lockedScore, topConf, lockedConf) {
    ponderBoot._noteOutgoingChoice('/choose move 2');
    ponderBoot.engine = ponderEngine([
      { name: 'Close Combat', moveId: 'closecombat', confidence: topConf, score: topScore },
      { name: 'Moonblast', moveId: 'moonblast', confidence: lockedConf, score: lockedScore }
    ], []);
    ponderBoot._runDeepPonder(PONDER_STATE, plan, ponderBoot._ponderId);
    return alerts.length ? alerts[alerts.length - 1] : null;
  };

  const quiet = scoreAlert(200, 170, 20, 20);
  check('a deeper edge BELOW both margins draws no alert', quiet === null, JSON.stringify(quiet));

  const byScore = scoreAlert(200, 40, 20, 20);
  check('...above the score margin it does', !!byScore && byScore.reason === 'score', JSON.stringify(byScore));
  check('...naming the line to play and the line to drop',
    !!byScore && byScore.better.name === 'Close Combat' && byScore.locked.name === 'Moonblast',
    JSON.stringify(byScore));
  close('...and the payoff gap it is based on', byScore && byScore.scoreDelta, 160, 0.001);
  check('...with a reason a player can read', !!byScore && /payoff/.test(byScore.why), byScore && byScore.why);

  const byConf = scoreAlert(200, 200, 60, 30);
  check('an equal-payoff line the deeper pass is much clearer about raises the CONFIDENCE reason',
    !!byConf && byConf.reason === 'confidence', JSON.stringify(byConf));

  ponderBoot._noteOutgoingChoice('/choose move 2');
  ponderBoot.engine = ponderEngine([
    { name: 'Close Combat', moveId: 'closecombat', confidence: 60, score: 300 },
    { name: 'Moonblast', moveId: 'moonblast', confidence: 0, score: -9999, isVetoed: true, vetoReason: 'Ground move into Flying type' }
  ], []);
  ponderBoot._runDeepPonder(PONDER_STATE, plan, ponderBoot._ponderId);
  const vetoAlert = alerts.length ? alerts[alerts.length - 1] : null;
  check('a locked line the deeper pass VETOES raises the alert',
    !!vetoAlert && vetoAlert.reason === 'vetoed', JSON.stringify(vetoAlert));
  check('...and the veto reason reaches the player',
    !!vetoAlert && /Flying/.test(vetoAlert.why), vetoAlert && vetoAlert.why);

  ponderBoot._noteOutgoingChoice('/choose move 2');
  ponderBoot.engine = ponderEngine([
    { name: 'Close Combat', moveId: 'closecombat', confidence: 60, score: 300 },
    { name: 'Ice Spinner', moveId: 'icespinner', confidence: 30, score: 100 }
  ], []);
  ponderBoot._runDeepPonder(PONDER_STATE, plan, ponderBoot._ponderId);
  const goneAlert = alerts.length ? alerts[alerts.length - 1] : null;
  check('a locked line the deeper read no longer offers at all raises the alert',
    !!goneAlert && goneAlert.reason === 'unlisted', JSON.stringify(goneAlert));

  /* --- the scheduling contract: never inline, and one pass per window */
  const timers = [];
  const schedSandbox = noThrow(function () {
    return H.loadAll({
      setTimeout: function (fn) { timers.push(fn); return timers.length; },
      setInterval: function () { return 0; },
      clearInterval: function () { }
    });
  });
  check('the manifest loads with an injected timer', schedSandbox.ok, schedSandbox.error);
  if (schedSandbox.ok && schedSandbox.value.ST.TacticianBoot) {
    const boot = new schedSandbox.value.ST.TacticianBoot({ doc: schedSandbox.value.document });
    const schedCalls = [];
    boot.engine = ponderEngine([{ name: 'Moonblast', moveId: 'moonblast', confidence: 55, score: 100 }], schedCalls);
    const hudCalls = [];
    boot.hud = {
      render: function (ranked, state, readout) { hudCalls.push(readout); return ranked ? ranked.length : 0; },
      renderTRChip: function () { return null; },
      clearCancelAlert: function () { return null; }
    };
    boot.state = { state: PONDER_STATE };
    // The LLM bridge schedules its own timeout, and it is not the subject here: with it out of the
    // way the only NEW timer is the ponder. (`loadAll` also leaves a loadTeam watchdog behind on
    // the sandbox's auto-started boot, which is why this counts from here rather than from zero.)
    boot.llm = null;
    const timersBefore = timers.length;
    const rankedPass1 = noThrow(function () { return boot._onRequest(); });
    check('a decision request answers SYNCHRONOUSLY from the fast pass', rankedPass1.ok && schedCalls.length === 1,
      rankedPass1.error || String(schedCalls.length));
    eq('...after rendering the HUD (so the frame never waits on the deep pass)', hudCalls.length, 1);
    eq('...and the deep pass is queued, not run', timers.length, timersBefore + 1);
    eq('...which counts as no work yet', boot.stats.ponders, 0);
    const reRequest = noThrow(function () { return boot._onRequest(); });
    check('a re-delivered request in the same window schedules nothing new',
      reRequest.ok && timers.length === timersBefore + 1, reRequest.error || String(timers.length));
    const fired = noThrow(function () { timers[timersBefore](); });
    check('firing the queued pass runs the deeper read', fired.ok && boot.stats.ponders === 1, fired.error);
    eq('...through the engine once more', schedCalls.length, 2);
    eq('...with the deeper world count', schedCalls[1] && schedCalls[1].K, 14);
    check('...and the HUD is repainted from the deeper ranking',
      hudCalls.length === 2 && !!boot.lastPonder && boot.lastPonder.updated === true,
      JSON.stringify(boot.lastPonder));
    // A stale closure (scheduled for a window that has since closed) must stay silent.
    boot._closePonderWindow();
    const before = boot.stats.ponders;
    check('a stale pass after the window closed does nothing', (function () {
      const ran = noThrow(function () { return boot._runDeepPonder(PONDER_STATE, boot._deepPonderPlan(), 0); });
      return ran.ok && ran.value === null && boot.stats.ponders === before;
    })(), String(boot.stats.ponders));
  }
}

/* ================================================================== summary */

console.log('\n=== summary ===');
console.log('checks passed: ' + passed);
console.log('checks failed: ' + failed);
if (failed) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('ALL HUD CHECKS PASSED');
process.exit(0);
