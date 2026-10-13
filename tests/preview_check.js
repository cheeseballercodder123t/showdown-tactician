/* Showdown Tactician — tests/preview_check.js
 *
 * The Turn-0 LEAD ADVISORY (src/laplace_core.js leadAdvisory + src/content.js at `|teampreview|`
 * + the HUD card in src/ui_overlay.js).
 *
 * WHY THIS EXISTS
 *   `|teampreview|` is inert to the parser on purpose — parser_fuzz pins it as room chatter — so the
 *   advisory hangs off the RAW command in the broker. That contract is easy to break silently: a
 *   parser change that starts consuming `|teampreview|` would leave the card never rendered. These
 *   checks pin the contract, the 6x6 scoring, the broker wiring and the HUD lifecycle end to end.
 *
 * Run me with:  node tests/preview_check.js
 */
'use strict';

const H = require('./harness.js');
const S = H.loadAll({
  setInterval: function () { return 0; },
  clearInterval: function () { }
});
const ST = S.ST;
const U = ST.util;

let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail === undefined ? '' : '  ->  ' + detail));
}
function eq(name, got, want) { check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got) + ' != ' + JSON.stringify(want)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

const MINE = ['Great Tusk', 'Slowking-Galar', 'Hatterene', 'Kingambit', 'Landorus-Therian', 'Iron Valiant'];
const THEIRS = ['Dragonite', 'Ting-Lu', 'Samurott-Hisui', 'Glimmora', 'Weavile', 'Roaring Moon'];
const HEADER = [
  '|init|[Gen 9] National Dex',
  '|player|p1|Me|1|1520',
  '|player|p2|Foe|2|1470',
  '|teamsize|p1|6',
  '|teamsize|p2|6'
];
function pokeLines(side, names) {
  return names.map(function (n) { return '|poke|' + side + '|' + n + ', L50, M|item'; });
}
function previewLines() {
  return HEADER.concat(pokeLines('p1', MINE), pokeLines('p2', THEIRS), ['|teampreview']);
}

function mkEngine() {
  const damage = new ST.DamageEngine({ gen: 9 });
  const trickRoom = new ST.TrickRoomEngine(damage);
  return new ST.LaplaceEngine({
    sampler: new ST.WorldSampler({ K: 6 }), damage: damage,
    evaluator: new ST.DenseStateEvaluator(),
    tempo: new ST.TempoEngine({ damage: damage, trickRoom: trickRoom }),
    veto: new ST.BlunderVetoGuard({ damage: damage, trickRoom: trickRoom }), trickRoom: trickRoom
  });
}

/* ========================================================= 1. the parser contract */

section('1. `|teampreview|` stays inert — the contract the broker hangs off');

{
  const parser = new ST.ProtocolParser();
  const ev = parser.parseLine('|teampreview|');
  eq('it parses to an unknown event', ev && ev.type, 'unknown');
  eq('...carrying its command name', ev && ev.cmd, 'teampreview');
  // `|clearpoke|` is the same family and must stay inert too.
  eq('clearpoke stays inert as well', parser.parseLine('|clearpoke|').type, 'unknown');
}

/* ========================================================= 2. the 6x6 advisory */

section('2. the engine scores every lead against every opposing body');

{
  const sm = new ST.BattleStateManager();
  const parser = new ST.ProtocolParser();
  sm.attachParser(parser);
  previewLines().forEach(function (l) { parser.feed(l); });
  const st = sm.state;
  eq('our preview roster is six bodies', (st.myTeam || []).length, 6);
  eq('and so is theirs', (st.oppTeam || []).length, 6);

  const eng = mkEngine();
  const adv = eng.leadAdvisory(st);
  check('the advisory is produced', !!adv, JSON.stringify(adv && Object.keys(adv)));
  if (adv) {
    eq('one candidate lead per living body', adv.leads.length, MINE.length);
    eq('the count matches', adv.count, MINE.length);
    check('every favorability is a percentage in 0..100',
      adv.leads.every(function (l) { return l.favorability >= 0 && l.favorability <= 100; }),
      JSON.stringify(adv.leads.map(function (l) { return l.favorability; })));
    check('every lead names the opponent it is judged against',
      adv.leads.every(function (l) { return !!l.vs && THEIRS.indexOf(l.vs) !== -1; }),
      JSON.stringify(adv.leads.map(function (l) { return l.vs; })));
    check('the best lead scores at least as high as the risky one',
      adv.best.score >= adv.risky.score, adv.best.score + ' / ' + adv.risky.score);
    check('favorability tracks the score (the mapping is monotone)', adv.leads.every(function (l) {
      const lo = Math.min(adv.best.score, adv.risky.score);
      const hi = Math.max(adv.best.score, adv.risky.score);
      if (hi === lo && adv.best.favorability === adv.risky.favorability) return true;
      return (l.score === hi ? l.favorability >= adv.risky.favorability : l.favorability <= adv.best.favorability);
    }), JSON.stringify(adv.leads.map(function (l) { return [l.score, l.favorability]; })));
    check('the scoring actually differentiates the leads (not all identical)',
      adv.leads.some(function (l) { return l.score !== adv.leads[0].score; }),
      JSON.stringify(adv.leads.map(function (l) { return l.score; })));

    // Determinism: the same board twice gives the same advisory.
    const again = eng.leadAdvisory(st);
    eq('the advisory is deterministic', JSON.stringify(again), JSON.stringify(adv));
  }
}

{
  // Nothing to say with an empty roster.
  const eng = mkEngine();
  eq('an empty opposing roster yields no advisory',
    eng.leadAdvisory({ myTeam: [{ species: 'Great Tusk', hpPercent: 100 }], oppTeam: [], field: {} }), null);
  eq('an empty own roster yields no advisory',
    eng.leadAdvisory({ myTeam: [], oppTeam: [{ species: 'Dragonite', hpPercent: 100 }], field: {} }), null);
}

{
  // The card is switchable at call time, so a power user can silence it without a rebuild.
  const sm = new ST.BattleStateManager();
  const parser = new ST.ProtocolParser();
  sm.attachParser(parser);
  previewLines().forEach(function (l) { parser.feed(l); });
  const eng = mkEngine();
  ST.configMerge({ hud: { leadAdvisory: { enabled: false } } });
  eq('with the card disabled the engine refuses to produce one', eng.leadAdvisory(sm.state), null);
  ST.configMerge({ hud: { leadAdvisory: { enabled: true } } });
  check('and produces one again once re-enabled', !!eng.leadAdvisory(sm.state));
}

/* ========================================================= 3. the HUD card */

section('3. the HUD card renders the pair and comes down when the battle starts');

/* The stub DOM keeps per-node textContent without aggregating children, so a card's text lives on
 * its rows. Walk the tree the way a reader would. */
function textOf(node) {
  if (!node) return '';
  let out = node.textContent || '';
  if (Array.isArray(node.children)) node.children.forEach(function (c) { out += ' ' + textOf(c); });
  return out;
}

const ADVISORY = {
  leads: [
    { species: 'Hatterene', score: 210.4, favorability: 61, vs: 'Ting-Lu', reason: 'best matchup vs Ting-Lu (61% favorability)' },
    { species: 'Slowking-Galar', score: -180.2, favorability: 41, vs: 'Weavile', reason: 'best matchup vs Weavile (41% favorability)' }
  ],
  best: { species: 'Hatterene', score: 210.4, favorability: 61, vs: 'Ting-Lu', reason: 'best matchup vs Ting-Lu (61% favorability)' },
  risky: { species: 'Slowking-Galar', score: -180.2, favorability: 41, vs: 'Weavile', reason: 'best matchup vs Weavile (41% favorability)' },
  count: 2
};

{
  const doc = H.createFakeDocument();
  const hud = new ST.MobileHUD({ doc: doc, state: null });
  const card = hud.renderLeadAdvisory(ADVISORY);
  check('the card node is returned', !!card);
  check('...and carries the data-st-lead attribute', !!card && card.getAttribute('data-st-lead') === '1',
    card && String(card.getAttribute('data-st-lead')));
  check('...and names the top lead', !!card && /Hatterene/.test(textOf(card)), textOf(card));
  check('...and names the risky lead', !!card && /Slowking-Galar/.test(textOf(card)), textOf(card));
  check('...and shows the favorability percentage', !!card && /61%/.test(textOf(card)), textOf(card));
  check('...and mounts itself on the document body', doc.body.children.indexOf(card) !== -1);
  check('re-rendering reuses the same node', hud.renderLeadAdvisory(ADVISORY) === card);
  eq('an empty advisory dismisses instead of drawing a box', hud.renderLeadAdvisory({ leads: [] }), null);
  eq('and the node is cleared', hud._nodes.leadAdvisory, null);
}

/* The card is the one injected node the HUD holds BOTH a bulk-selector sweep and a handle for, so
 * the two ways it can leak are pinned here — and both are asserted against the DOM the card really
 * lives in, because the stub document's querySelectorAll returns nothing and would hide the
 * selector half of the first defect. */
function advisoryCards(doc) {
  return (doc.body.children || []).filter(function (c) {
    return c && String(c.className || '').indexOf('st-lead-advisory') !== -1;
  });
}

{
  // THE ORPHAN. `clear()` is documented as "remove every injected node", but its bulk selector
  // named every injected class EXCEPT the advisory card's, and it then rebuilt `_nodes` with
  // `leadAdvisory: null` — so the card stayed mounted with no handle left to remove it (nothing
  // reads the DOM for it), while the next battle mounted a SECOND one.
  const doc = H.createFakeDocument();
  const hud = new ST.MobileHUD({ doc: doc, state: null });
  hud.renderLeadAdvisory(ADVISORY);
  eq('the card is mounted once', advisoryCards(doc).length, 1);
  hud.clear();
  eq('clear() removes the advisory card', advisoryCards(doc).length, 0);
  eq('...and drops its handle with it', hud._nodes.leadAdvisory, null);
  hud.renderLeadAdvisory(ADVISORY);
  eq('re-rendering after clear() mounts exactly ONE card, never a second',
    advisoryCards(doc).length, 1);
  hud.dismissLeadAdvisory();
  eq('...and the re-mounted card can still be taken down', advisoryCards(doc).length, 0);
}

{
  // THE EMPTY BOX. `leads` being non-empty is not the same question as "is there anything to
  // show": both rows are skipped when the entries carry no `species`, which used to leave the
  // heading alone in the box — the one thing the method's contract says it will not draw.
  const UNUSABLE = { leads: [{ favorability: 50 }, { score: 1 }], best: { favorability: 50 }, risky: {} };
  const doc = H.createFakeDocument();
  const hud = new ST.MobileHUD({ doc: doc, state: null });
  eq('an advisory with no usable row dismisses instead of drawing an empty box',
    hud.renderLeadAdvisory(UNUSABLE), null);
  eq('...and mounts nothing at all', advisoryCards(doc).length, 0);
  hud.renderLeadAdvisory(ADVISORY);
  eq('a valid card still mounts',
    hud._nodes.leadAdvisory && String(hud._nodes.leadAdvisory.className), 'st-lead-advisory');
  eq('...and an unusable one takes it down rather than leaving the old pair up',
    hud.renderLeadAdvisory(UNUSABLE), null);
  eq('...leaving no card behind', advisoryCards(doc).length, 0);
}

{
  // The broker: a teampreview line computes and publishes; the first |turn| takes the card down.
  const doc = H.createFakeDocument();
  const boot = new ST.TacticianBoot({ doc: doc });
  previewLines().forEach(function (l) { boot.handleLine(l, 'recv'); });
  const st = boot.state.state;
  check('the broker published the advisory onto the state', !!st.leadAdvisory,
    JSON.stringify(st.leadAdvisory && st.leadAdvisory.count));
  check('the HUD drew the card', !!boot.hud && !!boot.hud._nodes.leadAdvisory);
  boot.handleLine('|start', 'recv');
  boot.handleLine('|turn|1', 'recv');
  eq('the first turn dismisses the card', boot.hud._nodes.leadAdvisory, null);
  check('...but the published advisory survives on the state for a reader',
    !!st.leadAdvisory);
}

/* ------------------------------------------------------------------- summary */

console.log('');
if (fails.length) {
  console.error('FAILED: ' + fails.length + ' of ' + (pass + fails.length) + ' checks');
  fails.forEach(function (f) { console.error('  - ' + f); });
  process.exit(1);
}
console.log('ALL PREVIEW CHECKS PASSED (' + pass + ')');
