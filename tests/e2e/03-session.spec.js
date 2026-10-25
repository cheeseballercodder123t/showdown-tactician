/* Showdown Tactician — tests/e2e/03-session.spec.js
 *
 * A whole battle in a real browser, plus the surfaces no other suite can reach: computed CSS,
 * click handlers, and the paths that only exist once the page supplies real data.
 *
 * The Node suites cannot cover any of this. tests/hud_check.js says so itself: "no CSS is
 * evaluated and no layout is rendered", its stub elements have a no-op addEventListener and a
 * no-op click(). Every interaction below is therefore the first time it has ever been executed.
 */
'use strict';

const { test, expect } = require('@playwright/test');
const H = require('./helpers');

let env = null;

test.beforeAll(async function () {
  env = await H.launchExtension();
});

test.afterAll(async function () {
  if (env) await env.close();
});

test('the whole 248-line replay runs through a real page without a single error', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  const { page, errors } = await H.openBattle(env.ctx, { setup: false });

  await H.pushLines(page, H.REPLAY_LOG);
  const snap = await H.hudSnapshot(page);

  expect(snap.lineSeq).toBe(H.REPLAY_LOG.length);
  expect(snap.lastLine).toBe(H.REPLAY_LOG[H.REPLAY_LOG.length - 1]);
  expect(snap.lastLine).toBe('|win|ExtramePatriot');
  expect(snap.counters.errors, 'the bridge recorded an internal error').toBe(0);
  expect(snap.internalErrorCount, snap.internalError).toBe(0);
  expect(errors).toEqual([]);

  /* The opponent readout has to describe the END of the battle, not its start. */
  expect(snap.banner).toContain('Kingambit');

  /* And the receipt is built from the counters the state manager kept all game. */
  expect(snap.receipt).toBeTruthy();
  expect(snap.receipt).toContain('MATCH RECEIPT');
  await page.close();
});

test('the extension stylesheet is applied, not just shipped', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  const { page } = await H.openBattle(env.ctx);
  await H.requestTurn(page, { rqid: 2 });
  const trigger = page.locator('[data-st-sheet-trigger]');
  if (await trigger.count() && await trigger.getAttribute('aria-expanded') === 'false') await trigger.click();
  await page.locator('[data-st-view-button="field"]').click();

  /* A manifest `css` entry is injected as a user stylesheet, which Chrome does not always
   * enumerate in document.styleSheets — so the honest question is not "is the sheet listed"
   * but "did its rules land". These three declarations exist ONLY in styles/overlay.css, and
   * _decorateButton writes none of them inline, so a computed value here is proof the sheet
   * is live. The banner also has to be genuinely on screen: a rule that fails to parse leaves
   * it with the default display and zero height, which no attribute assertion would catch. */
  const css = await page.evaluate(function () {
    const badge = document.querySelector('.elo-helper-badge');
    const banner = document.querySelector('[data-st-banner]');
    const btn = document.querySelector('button[data-move]');
    const g = function (el, p) { return el ? getComputedStyle(el).getPropertyValue(p) : null; };
    return {
      badgePosition: g(badge, 'position'),
      badgePointerEvents: g(badge, 'pointer-events'),
      bannerPosition: g(banner, 'position'),
      bannerDisplay: g(banner, 'display'),
      bannerVisibility: g(banner, 'visibility'),
      bannerHeight: banner ? banner.getBoundingClientRect().height : 0,
      buttonPosition: g(btn, 'position')
    };
  });

  expect(css.badgePosition).toBe('static');
  expect(css.badgePointerEvents).toBe('none');
  // The banner's positioning is layout-conditional now: `fixed` on desktop (a free-floating
  // status strip), `static` on mobile (a flex child inside the collapsible `.st-sheet` that
  // keeps the battle scene clear). Both are proof the stylesheet landed. Combined with the
  // non-zero height and visible display below, the rule is honoured in every layout.
  expect(['fixed', 'static']).toContain(css.bannerPosition);
  expect(css.bannerDisplay).toBe('block');
  expect(css.bannerVisibility).toBe('visible');
  expect(css.bannerHeight).toBeGreaterThan(0);
  expect(css.buttonPosition).toBe('relative');
  // The layout container must exist in either form (mobile sheet or desktop console). A test
  // that fires before the HUD's first render would not see the sheet, so this is the strongest
  // evidence the layout container rules reached the document.
  const layout = await page.evaluate(function () {
    return {
      sheet: !!document.querySelector('.st-sheet'),
      console: !!document.querySelector('.st-console'),
      layout: document.documentElement.getAttribute('data-st-layout')
    };
  });
  expect(['mobile', 'desktop']).toContain(layout.layout);
  expect(layout.sheet || layout.console, 'one of the layout containers must be present').toBe(true);
  await page.close();
});

test('the badge sits inside the button it belongs to', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  const { page } = await H.openBattle(env.ctx);
  await H.requestTurn(page, { rqid: 2 });

  /* Anchoring is the whole reason _decorateButton sets `position: relative` on the button.
   * If it were missing, an absolutely positioned badge would escape to the nearest positioned
   * ancestor and every badge would stack in one corner of the page. */
  const geometry = await page.evaluate(function () {
    const btn = document.querySelector('button[data-move]');
    const badge = btn.querySelector('.elo-helper-badge');
    const b = btn.getBoundingClientRect();
    const d = badge.getBoundingClientRect();
    return {
      insideHorizontally: d.left >= b.left - 1 && d.right <= b.right + 1,
      insideVertically: d.top >= b.top - 1 && d.bottom <= b.bottom + 1,
      width: d.width,
      height: d.height
    };
  });

  expect(geometry.insideHorizontally).toBe(true);
  expect(geometry.insideVertically).toBe(true);
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.height).toBeGreaterThan(0);
  await page.close();
});

test('the team drawer opens AND closes on the same button', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  const { page, errors } = await H.openBattle(env.ctx);
  await H.requestTurn(page, { rqid: 2 });

  const state = function () {
    return page.evaluate(function () {
      const d = document.querySelector('.team-drawer');
      return d ? { hidden: d.classList.contains('tactician-hidden'), display: getComputedStyle(d).display } : null;
    });
  };
  /* Is the toggle the thing a finger would actually hit at the toggle's own centre? A z-index
   * or a layout change can leave the button visible, enabled and stable — Playwright's own
   * readiness checks all pass — while something else is on top of it. elementFromPoint is the
   * only question that matches what a tap does. */
  const reachable = function () {
    return page.evaluate(function () {
      const t = document.querySelector('.team-drawer-toggle');
      const b = t.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return hit === t || t.contains(hit);
    });
  };

  expect(await state(), 'the drawer starts hidden').toMatchObject({ hidden: true, display: 'none' });
  expect(await reachable(), 'the toggle is tappable while the drawer is shut').toBe(true);

  await page.click('.team-drawer-toggle');
  expect(await state(), 'the drawer opens').toMatchObject({ hidden: false, display: 'block' });
  expect(await reachable(), 'and the toggle is STILL tappable while it is open').toBe(true);

  await page.click('.team-drawer-toggle');
  const closed = await state();
  expect(closed.hidden || closed.display === 'none', 'a second tap closes it').toBe(true);

  /* Reserving the toggle's corner must not have pushed the panel's own controls out of reach. */
  await page.click('.team-drawer-toggle');
  const controls = await page.evaluate(function () {
    const out = {};
    ['.drawer-save', '.drawer-close', '.drawer-team-input'].forEach(function (sel) {
      const el = document.querySelector(sel);
      if (!el) { out[sel] = 'missing'; return; }
      const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      out[sel] = (hit === el || el.contains(hit)) ? 'hittable' : 'blocked';
    });
    return out;
  });
  expect(controls['.drawer-save']).toBe('hittable');
  expect(controls['.drawer-close']).toBe('hittable');
  expect(controls['.drawer-team-input']).toBe('hittable');

  expect(errors).toEqual([]);
  await page.close();
});

test('tapping a bench body re-previews and marks it, tapping again clears it', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  const { page, errors } = await H.openBattle(env.ctx);

  await H.pushLines(page, [
    '|poke|p2|Kingambit, L50, M|item',
    '|switch|p2b: Kingambit|Kingambit, L50, M|100/100'
  ]);
  await H.requestTurn(page, { rqid: 2 });

  const pills = function () {
    return page.evaluate(function () {
      return Array.from(document.querySelectorAll('[data-st-bench]'))
        .filter(function (p) { return p.tagName === 'BUTTON'; })
        .map(function (p) {
          return { id: p.getAttribute('data-st-bench'), selected: p.classList.contains('st-selected') };
        });
    });
  };
  const lethal = function () {
    return page.evaluate(function () {
      const bar = document.querySelector('button[data-move="icespinner"] .st-lethal-bar');
      return bar ? bar.textContent : '';
    });
  };

  const before = await pills();
  expect(before.length).toBe(1);
  expect(before[0].selected).toBe(false);
  const lethalBefore = await lethal();

  await page.click('[data-st-bench]:not(.st-active):not(.st-fainted)');
  const after = await pills();
  expect(after[0].selected, 'the tapped pill is marked').toBe(true);
  expect(await lethal(), 'the preview switched to the benched body').toMatch(/ vs Iron Valiant/i);

  await page.click('[data-st-bench]:not(.st-active):not(.st-fainted)');
  const cleared = await pills();
  expect(cleared[0].selected, 'a second tap deselects').toBe(false);
  expect(await lethal(), 'and the preview returns to the active pair').not.toMatch(/ vs /i);

  expect(errors).toEqual([]);
  await page.close();
});

test('the page-measured PP and accuracy snapshots reach the parser', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  const { page, errors } = await H.openBattle(env.ctx);

  /* Max PP and move accuracy exist nowhere in the vendored damage bundle: the protocol never
   * reveals the opponent's PP, and the bundle carries no accuracy at all. Both are measured
   * off the page's own battle object instead, which is the only reason these two features can
   * exist. If the shape injected.js expects ever drifts, these counters stay at zero and the
   * features die silently — so they are asserted. */
  await page.evaluate(function () {
    window.__mock.setMoveSlots('p1', [
      { name: 'Great Tusk', moves: [['headlongrush', 'Headlong Rush', 16, 16], ['rapidspin', 'Rapid Spin', 40, 64]] }
    ]);
    window.__mock.setMoveSlots('p2', [
      { name: 'Landorus-Therian', moves: [['earthquake', 'Earthquake', 10, 10]] }
    ]);
  });
  await H.pushLines(page, ['|turn|2']);
  const snap = await H.hudSnapshot(page);

  expect(snap.counters.ppSnapshots, 'no |stpp| line was forwarded').toBeGreaterThan(0);
  expect(snap.counters.accuracy, 'no |stacc| line was forwarded').toBeGreaterThan(0);
  expect(snap.counters.errors).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
});

test('a decision window that arrives before the team is loaded still renders', async function () {
  await H.clearStorage(env.sw);
  const { page, errors } = await H.openBattle(env.ctx);
  await H.waitForDrain(page);

  /* The team arrives from chrome.storage asynchronously; the battle does not wait for it.
   * A request that lands first must still produce a readout — the `|request|` carries our own
   * side, which is the authority — and must not record an internal failure. */
  await H.requestTurn(page, { rqid: 2 });
  let snap = await H.hudSnapshot(page);
  expect(snap.badgeCount).toBe(4);
  expect(snap.internalErrorCount, snap.internalError).toBe(0);

  /* Then the team lands, and the next turn must pick it up. */
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  await H.pushLines(page, ['|turn|3', H.buildRequest({ rqid: 3 })]);
  snap = await H.hudSnapshot(page);
  expect(snap.badgeCount).toBe(4);
  expect(snap.internalErrorCount, snap.internalError).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
});

test('25 back-to-back turns stay stable', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  const { page, errors } = await H.openBattle(env.ctx);

  /* Real games are long, and every turn re-decorates the same buttons. Anything that appends
   * instead of reusing, or that leaks a node per render, shows up here and nowhere else. */
  for (let turn = 2; turn <= 26; turn++) {
    await H.pushLines(page, ['|turn|' + turn, H.buildRequest({ rqid: turn })]);
  }
  await H.waitForBadges(page, 4);
  const snap = await H.hudSnapshot(page);

  expect(snap.badgeCount).toBe(4);
  expect(snap.badgeChildren).toEqual([1, 1, 1, 1]);
  expect(snap.internalErrorCount, snap.internalError).toBe(0);
  expect(snap.counters.errors).toBe(0);
  expect(errors).toEqual([]);

  /* One banner, one chip, one sheet — never one per turn. data-st-drawer carries the panel's
   * '1' and the toggle's 'toggle', so the panel is counted by its own value. */
  const counts = await page.evaluate(function () {
    return {
      banners: document.querySelectorAll('[data-st-banner]').length,
      chips: document.querySelectorAll('[data-st-tr-chip]').length,
      panels: document.querySelectorAll('[data-st-drawer="1"]').length,
      toggles: document.querySelectorAll('[data-st-drawer="toggle"]').length
    };
  });
  expect(counts.banners).toBe(1);
  expect(counts.chips).toBe(1);
  expect(counts.panels).toBe(1);
  expect(counts.toggles).toBe(1);
  await page.close();
});
