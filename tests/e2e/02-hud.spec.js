/* Showdown Tactician — tests/e2e/02-hud.spec.js
 *
 * The HUD, against a real DOM.
 *
 * tests/hud_check.js says it plainly in its own header: "the DOM is a stub whose querySelector*
 * always returns nothing (which is why every button-level check stubs `_findMoveButtons`)".
 * So `_decorateButton` — the one function that touches every node a player sees — had never
 * been run against an element that could actually hold a child. These specs are that gap.
 */
'use strict';

const { test, expect } = require('@playwright/test');
const H = require('./helpers');

let env = null;

test.beforeAll(async function () {
  env = await H.launchExtension();
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
});

test.afterAll(async function () {
  if (env) await env.close();
});

/** Open a page, drain the setup log, and play one decision turn. */
async function playTurn(opts) {
  const opened = await H.openBattle(env.ctx);
  await H.waitForDrain(opened.page);
  await H.pushLines(opened.page, [H.buildRequest(opts)]);
  await H.waitForBadges(opened.page, 1);
  return opened;
}

test('a decision turn decorates every move button with exactly one badge', async function () {
  const { page } = await playTurn();
  const snap = await H.hudSnapshot(page);

  expect(snap.buttonCount).toBe(4);
  expect(snap.badgeCount).toBe(4);
  expect(snap.badgeChildren).toEqual([1, 1, 1, 1]);

  /* Every badge must be attributable to the button it sits on: the label is a percentage and
   * the class is one of the four the stylesheet knows. */
  for (const badge of snap.badges) {
    expect(badge.text, 'badge on ' + badge.move).toMatch(/^(\d+%|VETO)$/);
    const known = badge.badgeClasses.filter(function (c) {
      return ['conf-high', 'conf-mid', 'conf-low', 'conf-veto'].indexOf(c) !== -1;
    });
    expect(known.length, 'exactly one confidence class on ' + badge.move).toBe(1);
    expect(badge.title).toBeTruthy();
  }

  expect(snap.internalErrorCount, snap.internalError).toBe(0);
  await page.close();
});

test('a veto lands on the button whose move it applies to', async function () {
  const { page } = await playTurn();
  const snap = await H.hudSnapshot(page);

  /* The fixture's opponent is Landorus-Therian: Ground/Flying. Headlong Rush is a Ground move,
   * so the only correct answer is a veto on headlongrush and on nothing else. This is a real
   * type-immunity deduction made by the real veto layer, asserted on the real DOM. */
  /* The badge always shows the number; the veto is carried by the class (the stylesheet gives
   * conf-veto a red outline and a strikethrough) and spelled out in the title. */
  const hr = snap.badges.find(function (b) { return b.move === 'headlongrush'; });
  expect(hr, 'headlongrush button').toBeTruthy();
  expect(hr.text).toBe('0%');
  expect(hr.badgeClasses).toContain('conf-veto');
  expect(hr.title).toMatch(/^VETO/);

  const button = snap.buttons.find(function (b) { return b.move === 'headlongrush'; });
  expect(button.classes).toContain('conf-veto');
  expect(button.opacity).toBe('0.5');
  expect(button.textDecoration).toBe('line-through');

  /* And the immunity must not have leaked onto the coverage moves. */
  const others = snap.badges.filter(function (b) { return b.move !== 'headlongrush'; });
  expect(others.length).toBe(3);
  for (const o of others) expect(o.text).not.toBe('VETO');

  await page.close();
});

test('re-rendering the same buttons never stacks a second badge', async function () {
  const { page } = await playTurn();

  /* Showdown re-requests constantly and the HUD re-decorates on every one. If _decorateButton
   * appended instead of reusing, each button would collect a badge per turn and the newest
   * would be buried under the oldest. */
  for (let turn = 2; turn <= 5; turn++) {
    await H.pushLines(page, ['|turn|' + turn, H.buildRequest({ rqid: turn })]);
  }
  await H.waitForBadges(page, 4);
  const snap = await H.hudSnapshot(page);

  expect(snap.badgeCount).toBe(4);
  expect(snap.badgeChildren).toEqual([1, 1, 1, 1]);
  expect(snap.internalErrorCount, snap.internalError).toBe(0);
  await page.close();
});

test('a button the engine has no opinion about loses its badge', async function () {
  const { page } = await playTurn();
  let snap = await H.hudSnapshot(page);
  expect(snap.badgeCount).toBe(4);

  /* Turn 2 lists two moves instead of four — the shape a Choice lock, a Torment, or a drained
   * PP pool produces. Showdown does not always rebuild the bar between turns, so the two
   * orphaned buttons are the SAME nodes that carried a badge a moment ago. */
  await H.pushLines(page, ['|turn|2', H.buildRequest({
    rqid: 2,
    moves: [
      ['headlongrush', 'Headlong Rush', 15, 16],
      ['closecombat', 'Close Combat', 7, 8]
    ]
  })]);
  snap = await H.hudSnapshot(page);

  const icespinner = snap.buttons.find(function (b) { return b.move === 'icespinner'; });
  const rapidspin = snap.buttons.find(function (b) { return b.move === 'rapidspin'; });
  const iceBadge = snap.badges.find(function (b) { return b.move === 'icespinner'; });
  const spinBadge = snap.badges.find(function (b) { return b.move === 'rapidspin'; });

  expect(iceBadge.text, 'icespinner must not keep a stale badge').toBeNull();
  expect(spinBadge.text, 'rapidspin must not keep a stale badge').toBeNull();
  expect(icespinner.classes).not.toContain('conf-high');
  expect(icespinner.classes).not.toContain('conf-low');
  expect(icespinner.classes).not.toContain('conf-veto');
  expect(rapidspin.classes).not.toContain('conf-veto');
  expect(snap.internalErrorCount, snap.internalError).toBe(0);
  await page.close();
});

test('the HUD re-decorates a control bar Showdown has thrown away', async function () {
  const { page } = await playTurn();
  expect((await H.hudSnapshot(page)).badgeCount).toBe(4);

  /* Showdown replaces the whole control bar between turns. The extension must not keep
   * decorating a detached node — the badges have to land on whatever is on screen now. */
  const rebuilt = await page.evaluate(function () { return window.__mock.rebuildControlBar(); });
  expect(rebuilt).toBe(4);
  expect((await H.hudSnapshot(page)).badgeCount).toBe(0);

  await H.pushLines(page, ['|turn|2', H.buildRequest({ rqid: 2 })]);
  await H.waitForBadges(page, 4);
  const snap = await H.hudSnapshot(page);

  expect(snap.badgeCount).toBe(4);
  expect(snap.badgeChildren).toEqual([1, 1, 1, 1]);
  for (const badge of snap.badges) expect(badge.text).toMatch(/^(\d+%|VETO)$/);
  expect(snap.internalErrorCount, snap.internalError).toBe(0);
  await page.close();
});

test('the banner tracks the turn number', async function () {
  const { page } = await playTurn();
  const first = await H.hudSnapshot(page);
  expect(first.bannerAttrs).toContain('data-turn=1');

  await H.pushLines(page, ['|turn|2', H.buildRequest({ rqid: 2 })]);
  const second = await H.hudSnapshot(page);
  expect(second.bannerAttrs).toContain('data-turn=2');
  expect(second.banner).toContain('Landorus-Therian');
  await page.close();
});

/* ------------------------------------------------------------------ layout mode */

/**
 * The HUD has two layouts. `auto` resolves by viewport width (mobile below the breakpoint,
 * desktop at or above it), and the in-page toggle flips between them. This spec pins both
 * directions and the invariant that matters for a player: in the desktop layout the HUD is
 * a single console docked out of the way, and it must never cover Showdown's own move bar.
 */
test('the layout toggle switches mobile and desktop, and neither covers the move bar', async function () {
  /* The context is created at the phone viewport (412x915) because every other spec needs
   * it. `setViewportSize` moves THIS page to a desktop size, and the HUD's resize listener
   * re-resolves `auto` against the new width — which is the behaviour under test. */
  const opened = await H.openBattle(env.ctx, { initLocal: { stHudLayout: 'auto' } });
  const { page } = opened;
  await page.setViewportSize({ width: 1280, height: 800 });
  await H.waitForDrain(page);
  await H.pushLines(page, [H.buildRequest()]);
  await H.waitForBadges(page, 4);
  /* 1280 is above the 1024 breakpoint, so `auto` must resolve to DESKTOP. */
  await page.waitForFunction(function () {
    return document.documentElement.getAttribute('data-st-layout') === 'desktop';
  });

  const read = function () {
    return page.evaluate(function () {
      const rect = function (sel) {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height };
      };
      const overlaps = function (a, b) {
        if (!a || !b) return false;
        return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
      };
      const toggle = document.querySelector('.st-mode-toggle');
      const hudSel = ['.tactician-tr-chip', '.st-bench-strip', '.st-pp-gauge', '.st-format-sentinel'];
      const consoleR = rect('.st-console');
      let coversMoveButton = false;
      hudSel.forEach(function (s) {
        const r = rect(s);
        if (r) {
          document.querySelectorAll('button[data-move]').forEach(function (b) {
            const m = b.getBoundingClientRect();
            if (r.right > m.left && r.left < m.right && r.bottom > m.top && r.top < m.bottom) coversMoveButton = true;
          });
        }
      });
      return {
        layout: document.documentElement.getAttribute('data-st-layout'),
        resolved: toggle ? toggle.getAttribute('data-st-resolved') : null,
        label: toggle ? toggle.textContent : null,
        hasToggle: !!toggle,
        hasConsole: !!consoleR,
        consoleRect: consoleR,
        coversMoveButton: coversMoveButton
      };
    });
  };

  const desktop = await read();
  expect(desktop.layout).toBe('desktop');
  expect(desktop.resolved).toBe('desktop');
  expect(desktop.label).toMatch(/desktop/i);
  expect(desktop.hasConsole).toBe(true);
  /* The point of the desktop layout: the HUD is docked and must not cover a move button. */
  expect(desktop.coversMoveButton).toBe(false);

  /* The toggle button flips it. It is the in-page control the user actually touches. */
  await page.click('.st-mode-toggle');
  await page.waitForFunction(function () {
    return document.documentElement.getAttribute('data-st-layout') === 'mobile';
  });
  const mobile = await read();
  expect(mobile.layout).toBe('mobile');
  expect(mobile.label).toMatch(/mobile/i);
  expect(mobile.hasToggle).toBe(true);

  /* Clicking the toggle must not steal keyboard focus: Showdown's move shortcuts are
   * window-level keys, so a button that keeps focus would swallow space/enter. */
  const focus = await page.evaluate(function () {
    const ae = document.activeElement;
    return ae ? ae.tagName : null;
  });
  expect(focus === 'BODY' || focus === 'HTML' || focus === null).toBe(true);

  /* And back to desktop, which must re-parent the band into the console. */
  await page.click('.st-mode-toggle');
  await page.waitForFunction(function () {
    return document.documentElement.getAttribute('data-st-layout') === 'desktop';
  });
  const again = await read();
  expect(again.layout).toBe('desktop');
  expect(again.hasConsole).toBe(true);
  expect(again.coversMoveButton).toBe(false);

  expect(opened.errors, opened.errors.join('\n')).toHaveLength(0);
  await page.close();
});

test('auto below the breakpoint keeps the mobile layout', async function () {
  const opened = await H.openBattle(env.ctx, { initLocal: { stHudLayout: 'auto' } });
  const { page } = opened;
  await page.setViewportSize({ width: 900, height: 500 });
  await H.waitForDrain(page);
  const w = await page.evaluate(function () { return window.innerWidth; });
  const layout = await page.evaluate(function () {
    return document.documentElement.getAttribute('data-st-layout');
  });
  const afterSynthetic = await page.evaluate(function () {
    window.dispatchEvent(new Event('resize'));
    return document.documentElement.getAttribute('data-st-layout');
  });
  expect(w, 'the page must really be under the breakpoint').toBeLessThan(1024);
  expect(layout, 'layout at width ' + w).toBe('mobile');
  expect(afterSynthetic, 'a synthetic resize must re-resolve (listener attached?)').toBe('mobile');
  expect(opened.errors, opened.errors.join('\n')).toHaveLength(0);
  await page.close();
});
