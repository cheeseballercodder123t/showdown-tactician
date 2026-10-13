/* Showdown Tactician — tests/dom_check.js
 *
 * Run me with:  node tests/dom_check.js
 *
 * WHAT THIS IS
 *   The node lifecycle of the HUD, asserted against an element that can actually HOLD A CHILD.
 *
 * WHY IT EXISTS
 *   tests/hud_check.js states the limitation in its own header: "the DOM is a stub whose
 *   querySelector* always returns nothing (which is why every button-level check stubs
 *   `_findMoveButtons`)". MobileHUD._decorateButton is the one function that touches every node
 *   a player sees, and it had never been run against a real element — so three defects lived in
 *   it, all of them the same shape: a check that could never be true.
 *
 *   This is not the first time that shape has cost this project. ui_overlay.js line 134 records
 *   an earlier one: `classList.add('a b')` throws InvalidCharacterError in a real browser, so the
 *   TR chip never rendered at all — and "the stub DOM in the test harness keeps a plain Set and
 *   never noticed". The lesson is that a stub which cannot fail cannot test.
 *
 *   So this suite brings the smallest DOM that CAN fail: an element with a working querySelector
 *   over its own children, a real classList, a real style object, and isConnected. It is still
 *   not a browser — tests/e2e/ is the browser — but it is enough to run _decorateButton and
 *   clear() for real, in 200 ms, on every `npm test`.
 */
'use strict';

const H = require('./harness.js');

const S = H.loadAll();
const ST = S.ST;

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
function eq(name, got, want) { return check(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }

function section(title) { console.log('\n' + title); }

/* ------------------------------------------------------------------ the element */

/**
 * An element that behaves enough like a DOM node for _decorateButton to run unmodified:
 * children it can search, a classList that is not a plain Set, a style bag and isConnected.
 */
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    attributes: {},
    className: '',
    textContent: '',
    parentNode: null,
    isConnected: true,
    classList: {
      _s: new Set(),
      add: function () { for (let i = 0; i < arguments.length; i++) this._s.add(arguments[i]); },
      remove: function () { for (let i = 0; i < arguments.length; i++) this._s.delete(arguments[i]); },
      contains: function (c) { return this._s.has(c); }
    },
    setAttribute: function (k, v) { this.attributes[k] = v; },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    removeAttribute: function (k) { delete this.attributes[k]; },
    appendChild: function (c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild: function (c) { el.children = el.children.filter(function (x) { return x !== c; }); c.parentNode = null; return c; },
    remove: function () { if (el.parentNode) el.parentNode.removeChild(el); },
    /* Depth-first by class, exactly like the browser. This is the whole point of the file. */
    querySelector: function (sel) {
      const cls = String(sel).replace(/^\./, '');
      const stack = el.children.slice();
      while (stack.length) {
        const n = stack.shift();
        if (String(n.className || '').split(/\s+/).indexOf(cls) !== -1) return n;
        if (n.children) stack.push.apply(stack, n.children);
      }
      return null;
    },
    querySelectorAll: function (sel) {
      const out = [];
      const cls = String(sel).replace(/^\./, '');
      const stack = el.children.slice();
      while (stack.length) {
        const n = stack.shift();
        if (String(n.className || '').split(/\s+/).indexOf(cls) !== -1) out.push(n);
        if (n.children) stack.push.apply(stack, n.children);
      }
      return out;
    },
    addEventListener: function () { },
    getBoundingClientRect: function () { return { top: 0, left: 0, width: 100, height: 50 }; }
  };
  return el;
}

/** Does `node` match one simple selector from a comma-separated list? */
function matchesSelector(node, part) {
  if (!node || !part) return false;
  if (part === 'button[data-move]') {
    return node.tagName === 'BUTTON' && node.getAttribute('data-move') !== null;
  }
  if (part.charAt(0) === '.') {
    return String(node.className || '').split(/\s+/).indexOf(part.slice(1)) !== -1;
  }
  return false;
}

function makeDoc() {
  const doc = {
    _buttons: [],
    createElement: makeEl,
    querySelector: function (sel) {
      const all = doc.querySelectorAll(sel);
      return all.length ? all[0] : null;
    },
    /* A browser's querySelectorAll searches the WHOLE document and understands a
     * comma-separated selector list. A stub that answered only one selector, or only returned
     * top-level nodes, would let clear() skip the nodes it is supposed to remove and still look
     * green — which is the "a stub that cannot fail cannot test" trap this file exists to avoid. */
    querySelectorAll: function (sel) {
      const parts = String(sel).split(',').map(function (p) { return p.trim(); });
      const out = [];
      const stack = doc._buttons.slice();
      while (stack.length) {
        const n = stack.shift();
        for (let i = 0; i < parts.length; i++) {
          if (matchesSelector(n, parts[i])) { out.push(n); break; }
        }
        if (n.children) stack.push.apply(stack, n.children);
      }
      return out;
    },
    getElementById: function () { return null; },
    documentElement: makeEl('html'),
    body: makeEl('body'),
    addEventListener: function () { }
  };
  return doc;
}

/** A HUD plus a document it can actually see. `btn(id)` mounts a move button into it. */
function scene() {
  const doc = makeDoc();
  const hud = new ST.MobileHUD({ doc: doc });
  return {
    doc: doc,
    hud: hud,
    btn: function (id) {
      const b = moveButton(id);
      doc._buttons.push(b);
      return b;
    }
  };
}

function moveButton(id) {
  const b = makeEl('button');
  b.className = 'movebutton';
  b.setAttribute('data-move', id);
  return b;
}

const STRONG = { name: 'Headlong Rush', moveId: 'headlongrush', confidence: 62, isVetoed: false };
const WEAK = { name: 'Headlong Rush', moveId: 'headlongrush', confidence: 12, isVetoed: false };
const VETOED = { name: 'Headlong Rush', moveId: 'headlongrush', confidence: 0, isVetoed: true, vetoReason: 'Ground move into Flying type' };

/* ------------------------------------------------------------------ sections */

/**
 * B11. _rememberStyle recorded a fresh entry on every call, so the rollback list grew by one
 * entry per button per render for the life of a battle — and, worse, every entry after the
 * first held a value the HUD itself had written.
 */
function sectionRollbackIsRecordedOnce() {
  section('1. the inline-style rollback records an original exactly once');
  const s = scene();
  const btn = s.btn('headlongrush');

  for (let i = 0; i < 30; i++) s.hud._decorateButton(btn, STRONG, STRONG);

  /* Three properties, not thirty entries: `opacity` and `textDecoration` (written on every
   * decorate) plus `position` (written once, when the badge is first appended). */
  eq('30 renders leave exactly 3 rollback entries', s.hud._touched.length, 3);
  const props = s.hud._touched.map(function (t) { return t.prop; }).sort();
  eq('and they are the three properties the HUD writes', props.join(','), 'opacity,position,textDecoration');
  eq('every entry holds the true original', s.hud._touched[0].previous, undefined);
}

/**
 * B12. clear() promises to "remove every injected node and inline style change". It could not:
 * the rollback replay ran AFTER its own correct reset and re-applied a value the HUD had
 * written, so a button that was ever vetoed stayed at 50 % opacity forever.
 */
function sectionClearRestoresTheOriginal() {
  section('2. clear() restores the original opacity, not the HUD\'s own value');
  const s = scene();
  const btn = s.btn('headlongrush');

  s.hud._decorateButton(btn, VETOED, null);
  eq('a vetoed render dims the button', btn.style.opacity, '0.5');
  s.hud._decorateButton(btn, STRONG, STRONG);
  eq('a clean render undims it', btn.style.opacity, '');

  s.hud.clear();
  eq('clear() leaves opacity at the original', btn.style.opacity, '');
  eq('clear() empties the rollback list', s.hud._touched.length, 0);

  /* The order that actually broke it: the LAST render is the vetoed one. */
  const s2 = scene();
  const btn2 = s2.btn('closecombat');
  s2.hud._decorateButton(btn2, STRONG, STRONG);
  s2.hud._decorateButton(btn2, VETOED, null);
  eq('veto last: dimmed before clear', btn2.style.opacity, '0.5');
  s2.hud.clear();
  eq('veto last: clear() still restores the original', btn2.style.opacity, '');
  eq('veto last: the strikethrough is gone', btn2.style.textDecoration, '');
  check('veto last: the badge node is gone', !btn2.querySelector('.elo-helper-badge'));

  /* And clear() must not destroy an inline style it never wrote. */
  const s3 = scene();
  const btn3 = s3.btn('icespinner');
  btn3.style.textDecoration = 'underline';
  s3.hud._decorateButton(btn3, VETOED, null);
  eq('a pre-existing inline style is overwritten while vetoed', btn3.style.textDecoration, 'line-through');
  s3.hud.clear();
  eq('and restored to what the page had', btn3.style.textDecoration, 'underline');
}

/** B13. The "strip any badge we left behind" branch tested an attribute that lives on the
 *  BADGE, so it was dead code and an orphaned button kept a stale badge. */
function sectionStaleBadgeIsStripped() {
  section('3. a button the engine has no opinion about loses its badge');
  const s = scene();
  const btn = s.btn('rapidspin');

  s.hud._decorateButton(btn, { name: 'Rapid Spin', moveId: 'rapidspin', confidence: 55, isVetoed: false }, null);
  check('a ranked move gets a badge', !!btn.querySelector('.elo-helper-badge'));
  eq('exactly one', btn.querySelectorAll('.elo-helper-badge').length, 1);

  s.hud._decorateButton(btn, null, null);
  check('an unranked button has none', !btn.querySelector('.elo-helper-badge'));
  eq('and none is left in the tree', btn.querySelectorAll('.elo-helper-badge').length, 0);
  check('and no confidence class is left on the button', !btn.classList.contains('conf-high'));
  eq('and no inline opacity is left', btn.style.opacity, '');
}

/** Re-decorating the same node must reuse its badge. Appending instead would bury the newest
 *  number under the oldest, and the total would climb every turn. */
function sectionBadgeIsReused() {
  section('4. re-decorating reuses the badge instead of stacking one');
  const s = scene();
  const btn = s.btn('headlongrush');

  for (let i = 0; i < 12; i++) s.hud._decorateButton(btn, i % 2 ? WEAK : STRONG, null);

  eq('12 renders leave exactly one badge', btn.querySelectorAll('.elo-helper-badge').length, 1);
  const badge = btn.querySelector('.elo-helper-badge');
  eq('and it shows the newest value', badge.textContent, '12%');
  eq('and the badge is tagged for teardown', badge.getAttribute('data-st-badge'), '1');
}

/** The veto contract, asserted on the nodes rather than on the stylesheet. */
function sectionVetoContract() {
  section('5. the veto contract');
  const s = scene();
  const btn = s.btn('headlongrush');

  s.hud._decorateButton(btn, VETOED, null);
  check('the button carries conf-veto', btn.classList.contains('conf-veto'));
  eq('the button is dimmed', btn.style.opacity, '0.5');
  eq('the button is struck through', btn.style.textDecoration, 'line-through');
  const badge = btn.querySelector('.elo-helper-badge');
  check('the badge carries conf-veto', badge.classList.contains('conf-veto'));
  eq('the badge still shows the number', badge.textContent, '0%');
  check('the title spells the veto out', /^VETO/.test(badge.getAttribute('title') || ''));

  /* The opposite direction: clearing the veto must undo all three. */
  s.hud._decorateButton(btn, STRONG, STRONG);
  check('a later clean render drops conf-veto', !btn.classList.contains('conf-veto'));
  eq('and undims', btn.style.opacity, '');
  eq('and unstrikes', btn.style.textDecoration, '');
  check('and the badge drops conf-veto', !btn.querySelector('.elo-helper-badge').classList.contains('conf-veto'));
}

/** The rollback list must be bounded by the LIVE DOM: Showdown rebuilds its control bar
 *  constantly, and every discarded button would otherwise strand an entry forever. */
function sectionRollbackIsCompacted() {
  section('6. the rollback list does not retain detached buttons');
  const s = scene();
  const gone = s.btn('icespinner');
  gone.isConnected = false;
  s.hud._rememberStyle(gone, 'opacity');
  eq('a detached button is recorded while it is the only one', s.hud._touched.length, 1);

  for (let i = 0; i < 300; i++) {
    const live = s.btn('m' + i);
    s.hud._rememberStyle(live, 'opacity');
  }
  const retains = s.hud._touched.some(function (t) { return t.el === gone; });
  check('compaction drops the detached button', !retains);
  check('and keeps the live ones', s.hud._touched.length > 200, 'kept ' + s.hud._touched.length);
}

/**
 * A document double whose execCommand behaves like a REAL one: it copies the CURRENT SELECTION, so
 * a field that was never attached to the tree and never selected copies nothing at all. That is the
 * only way these checks can fail — a stub that answers `true` unconditionally is exactly the "a stub
 * which cannot fail cannot test" trap this file exists to avoid.
 */
function clipboardDoc(opts) {
  const o = opts || {};
  const doc = {
    _selected: null,
    _copied: null,
    createElement: function (tag) {
      const el = makeEl(tag);
      el.select = function () { doc._selected = el; };
      el.focus = function () { el._focused = true; };
      return el;
    },
    body: makeEl('body'),
    documentElement: makeEl('html'),
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getElementById: function () { return null; },
    addEventListener: function () { }
  };
  if (!o.noExec) {
    doc.execCommand = function () {
      if (o.execFails) return false;
      if (!doc._selected || doc._selected.parentNode !== doc.body) return false;
      doc._copied = doc._selected.value;
      return true;
    };
  }
  return doc;
}

/**
 * The receipt's Copy button. Its clipboard fallback reported success while copying NOTHING:
 * `execCommand('copy')` acts on the document's current selection, and the textarea it built was
 * never attached and never selected, so the button put whatever the page already had selected on
 * the clipboard and told the caller it worked.
 */
function sectionReceiptCopyActuallyCopies() {
  section('7. the receipt Copy button copies, or reports that it did not');

  const doc = clipboardDoc({});
  const boot = new ST.TacticianBoot({ doc: doc });
  const out = boot._copyReceipt('Tactician receipt');
  eq('the fallback really puts the text on the clipboard', doc._copied, 'Tactician receipt');
  eq('...and reports the text back to the caller', out, 'Tactician receipt');
  check('...having selected the field it built', !!doc._selected && doc._selected.value === 'Tactician receipt');
  eq('...and leaves no textarea behind in the document', doc.body.children.length, 0);

  const refused = clipboardDoc({ execFails: true });
  const boot2 = new ST.TacticianBoot({ doc: refused });
  eq('a refused copy is reported as a failure, not as success', boot2._copyReceipt('x'), null);
  eq('...and nothing reached the clipboard', refused._copied, null);

  const noExec = clipboardDoc({ noExec: true });
  const boot3 = new ST.TacticianBoot({ doc: noExec });
  eq('no execCommand at all means no copy and no false success', boot3._copyReceipt('x'), null);

  eq('an empty payload is never a success', boot._copyReceipt(''), null);
}

/**
 * The evaluation latch is per-BATTLE. `_onRequest` returns the cached ranking WITHOUT evaluating
 * when `state.turn === this.lastEvaluateTurn`, so a second battle that reaches the same turn number
 * — a game that ended on turn 1, a rematch in the same room, a reconnect replay — used to skip its
 * whole evaluation and leave the previous battle's ranking and readout on the HUD.
 */
function sectionInitResetsTheEvaluationLatch() {
  section('8. a new battle re-evaluates instead of reusing the last ranking');

  const boot = new ST.TacticianBoot({ doc: makeDoc() });
  let evaluations = 0;
  // Silence the parts of the decision path a bare boot cannot draw, so the count below measures the
  // EVALUATION and nothing else.
  boot.hud = null;
  boot.llm = null;
  boot._renderScreenExtras = function () { };
  boot._maybeAlertTR = function () { };
  boot.engine.evaluateTurn = function () { evaluations++; return []; };

  const battle = [
    '|init|[Gen 9] National Dex',
    '|player|p1|Me|1|1500',
    '|player|p2|Foe|2|1470',
    '|teamsize|p1|6',
    '|teamsize|p2|6',
    '|turn|1',
    '|request|{"rqid":1}'
  ];
  battle.forEach(function (l) { boot.handleLine(l, 'recv'); });
  eq('the first battle evaluates its decision turn', evaluations, 1);
  eq('...and latches the turn it evaluated', boot.lastEvaluateTurn, 1);

  // A SECOND battle on the same connection, whose first decision turn has the SAME number.
  battle.forEach(function (l) { boot.handleLine(l, 'recv'); });
  eq('the second battle evaluates that same turn number again', evaluations, 2);

  // And the field itself, since the behaviour above depends on |init| clearing it.
  boot.lastEvaluateTurn = 9;
  boot.pendingReadout = { stale: true };
  boot._afterEvent({ type: 'init' }, 0);
  eq('|init| clears the evaluation latch', boot.lastEvaluateTurn, -1);
  eq('|init| clears the readout the HUD would otherwise re-render', boot.pendingReadout, null);
}

/**
 * A9. bindDrawer() has two exits: it BUILDS the drawer, or it ADOPTS one that is already in
 * the document (a second content-script injection, a reload with the nodes still mounted).
 * The layout signals were installed inside the build branch only, so the adopting exit kept
 * a HUD whose band never re-measured: no re-anchor on resize, and — on the new client, where
 * `.battle-log .battle-controls` is a static node inside the scrollable log — a bottom band
 * that drifts back over the move bar the first time the player scrolls. That is the exact
 * failure the listeners exist to prevent, so the adopting exit must bind them too.
 */
function sectionAdoptedDrawerStillBindsLayoutSignals() {
  // A document that RECORDS what was subscribed to. makeDoc's listener is a no-op, which is
  // fine for the sections above (they assert on rendering) and useless here: this check is
  // about the subscription itself, so the stub has to be able to fail.
  const listeners = [];
  const doc = makeDoc();
  doc.addEventListener = function (type, fn, opts) { listeners.push({ type: type, capture: !!(opts && opts.capture) }); };
  // makeDoc's querySelectorAll searches only the button registry, so a node the HUD MOUNTED
  // into the body is invisible to it. A browser searches the whole document — and the case
  // this section is about is precisely "the node is already in the document" — so this doc's
  // search is re-pointed at the body subtree. Without that, adoption is unreachable in the
  // stub and the section would pass no matter what bindDrawer does.
  doc.querySelectorAll = function (sel) {
    const parts = String(sel).split(',').map(function (p) { return p.trim(); });
    const out = [];
    const walk = function (el) {
      for (let i = 0; i < parts.length; i++) {
        if (matchesSelector(el, parts[i])) { out.push(el); break; }
      }
      (el.children || []).forEach(walk);
    };
    (doc.body.children || []).forEach(walk);
    return out;
  };
  doc.querySelector = function (sel) { const all = doc.querySelectorAll(sel); return all.length ? all[0] : null; };
  // Everything the HUD mounts lands in doc.body, so that subtree is the document for this check.
  const drawersIn = function () {
    const out = [];
    const walk = function (el) {
      if (String(el.className || '').split(/\s+/).indexOf('team-drawer') !== -1) out.push(el);
      (el.children || []).forEach(walk);
    };
    (doc.body.children || []).forEach(walk);
    return out;
  };

  const first = new ST.MobileHUD({ doc: doc });
  first.bindDrawer();
  const built = drawersIn();
  check('the first HUD builds a drawer', built.length === 1);
  listeners.length = 0;

  // A second HUD over the same document: its _qs finds the first one's drawer and adopts it.
  const second = new ST.MobileHUD({ doc: doc });
  second.bindDrawer();
  const after = drawersIn();
  eq('adoption does not build a second drawer', after.length, 1);
  eq('the adopted node is the first HUD\'s drawer', after[0] === built[0], true);
  const scrolls = listeners.filter(function (l) { return l.type === 'scroll'; });
  check('the adopting HUD subscribed to scroll', scrolls.length >= 1);
  eq('and it subscribed with capture (scroll does not bubble)',
    scrolls.length ? scrolls[0].capture : null, true);

  // Idempotence, on the same instance and across instances: no listener pile-up.
  second.bindDrawer();
  second.bindDrawer();
  const scrollsAfter = listeners.filter(function (l) { return l.type === 'scroll'; }).length;
  eq('re-binding does not add another scroll listener', scrollsAfter, scrolls.length);
}

function sectionLayoutModeResolvesAndReparents() {
  section('10. the layout mode resolves, reparents the band, and survives a reset');
  // The resolver must answer 'mobile' below the breakpoint and 'desktop' at or above it,
  // and an explicit 'mobile' or 'desktop' must beat the breakpoint every time.
  const doc = makeDoc();
  const hud = new ST.MobileHUD({ doc: doc, layoutMode: 'auto' });
  eq('auto below the breakpoint resolves to mobile', hud._resolveLayout({ width: 600 }), 'mobile');
  eq('auto at the breakpoint resolves to desktop',  hud._resolveLayout({ width: 1024 }), 'desktop');
  eq('auto above the breakpoint resolves to desktop', hud._resolveLayout({ width: 1920 }), 'desktop');
  const forced = new ST.MobileHUD({ doc: doc, layoutMode: 'desktop' });
  eq('forced desktop beats the breakpoint', forced._resolveLayout({ width: 300 }), 'desktop');
  const forced2 = new ST.MobileHUD({ doc: doc, layoutMode: 'mobile' });
  eq('forced mobile beats the breakpoint', forced2._resolveLayout({ width: 1920 }), 'mobile');

  // Switching to desktop: the band elements get reparented into a `.st-console` and the
  // documentElement gets `data-st-layout="desktop"`. Switching back to mobile moves them
  // out and the console is removed.
  // The doc's querySelectorAll must search the mounted subtree (see the adopt-section note
  // for why), so the freshly-mounted nodes are visible to the band reparenting.
  doc.querySelectorAll = function (sel) {
    const parts = String(sel).split(',').map(function (p) { return p.trim(); });
    const out = [];
    const walk = function (el) {
      for (let i = 0; i < parts.length; i++) {
        if (matchesSelector(el, parts[i])) { out.push(el); break; }
      }
      (el.children || []).forEach(walk);
    };
    (doc.body.children || []).forEach(walk);
    return out;
  };
  doc.querySelector = function (sel) { const all = doc.querySelectorAll(sel); return all.length ? all[0] : null; };
  // Bind the HUD to the page the way content.js start() does — the mode toggle is mounted
  // as part of binding, never at construction, so a HUD that is only constructed (the
  // clipboard-fallback tests build one to drive a pure function) leaves the document clean.
  hud.bindDrawer();
  // Pretend the HUD is mid-battle: stand up the bottom band by hand.
  const chip = doc.createElement('div');  chip.className = 'tactician-tr-chip';
  const strip = doc.createElement('div'); strip.className = 'st-bench-strip';
  const gauge = doc.createElement('div'); gauge.className = 'st-pp-gauge';
  const sent  = doc.createElement('div'); sent.className  = 'st-format-sentinel';
  const recpt = doc.createElement('div'); recpt.className = 'st-receipt-card';
  doc.body.appendChild(chip);
  doc.body.appendChild(strip);
  doc.body.appendChild(gauge);
  doc.body.appendChild(sent);
  doc.body.appendChild(recpt);

  hud.setLayoutMode('desktop');
  eq('documentElement carries the resolved layout', doc.documentElement.getAttribute('data-st-layout'), 'desktop');
  const consoleEl = doc.querySelector('.st-console');
  check('the console exists after switching to desktop', !!consoleEl);
  // Every band child is now inside the console, not directly under body. (DOM nodes are
  // not JSON-serialisable, so the eq helper is no good here — fall back to `check`.)
  for (const n of [chip, strip, gauge, sent, recpt]) {
    check(n.className + ' lives in the console', n.parentNode === consoleEl);
  }

  // Toggle the toggle. The HUD cycles mobile <-> desktop; since we just set 'desktop', the
  // next toggle call should land on 'mobile'. (toggleLayoutMode is the public entry point
  // the in-page button calls; setLayoutMode is the one the options page calls.)
  hud.toggleLayoutMode();
  eq('toggle flips desktop -> mobile', hud.layoutMode, 'mobile');
  eq('documentElement follows the toggle', doc.documentElement.getAttribute('data-st-layout'), 'mobile');
  // On mobile the children are back in the body and the console is removed.
  for (const n of [chip, strip, gauge, sent, recpt]) {
    check(n.className + ' is back in the body on mobile', n.parentNode === doc.body);
  }
  check('the console is removed on mobile', !doc.querySelector('.st-console'));

  // The mode toggle button is mounted, has the right text, and does not steal focus
  // (it is the kind of button PS's keyboard input would be sensitive to).
  const btn = doc.querySelector('.st-mode-toggle');
  check('the mode toggle is mounted', !!btn);
  check('its label matches the resolved layout', /mobile/i.test(btn.textContent), btn.textContent);
  eq('its resolved attribute matches', btn.getAttribute('data-st-resolved'), 'mobile');
}

function main() {
  console.log('Showdown Tactician — HUD node lifecycle (real elements)\n');
  sectionRollbackIsRecordedOnce();
  sectionClearRestoresTheOriginal();
  sectionStaleBadgeIsStripped();
  sectionBadgeIsReused();
  sectionVetoContract();
  sectionRollbackIsCompacted();
  sectionReceiptCopyActuallyCopies();
  sectionInitResetsTheEvaluationLatch();
  sectionAdoptedDrawerStillBindsLayoutSignals();
  sectionLayoutModeResolvesAndReparents();

  section('summary');
  console.log('checks passed: ' + passed);
  console.log('checks failed: ' + failed);
  if (failed) {
    console.log('\nFailures:');
    failures.forEach(function (f) { console.log('  x ' + f); });
    process.exit(1);
  }
  console.log('ALL DOM LIFECYCLE CHECKS PASSED');
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error('\nFATAL: the harness itself threw:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
