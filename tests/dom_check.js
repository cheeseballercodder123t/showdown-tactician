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

function main() {
  console.log('Showdown Tactician — HUD node lifecycle (real elements)\n');
  sectionRollbackIsRecordedOnce();
  sectionClearRestoresTheOriginal();
  sectionStaleBadgeIsStripped();
  sectionBadgeIsReused();
  sectionVetoContract();
  sectionRollbackIsCompacted();

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
