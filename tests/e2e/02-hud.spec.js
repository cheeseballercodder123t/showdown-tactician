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
   * decorating a detached node — the badges have to land on whatever is on screen now, and
   * they have to land there WITHOUT waiting for the next `|request|`: on the current client the
   * menu is rebuilt *after* the request arrives (our listener runs inside that frame), so a HUD
   * that only paints once per request shows no badges at all in a live battle. */
  const rebuilt = await page.evaluate(function () { return window.__mock.rebuildControlBar(); });
  expect(rebuilt).toBe(4);
  await H.waitForBadges(page, 4);
  const onRebuilt = await H.hudSnapshot(page);
  expect(onRebuilt.badgeCount, 'the rebuilt bar is decorated, not left bare').toBe(4);
  // One badge per button, on the NEW nodes (the mock's snapshot reads the live DOM).
  expect(onRebuilt.badgeChildren).toEqual([1, 1, 1, 1]);

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
  const opened = await playTurn();
  const { page } = opened;
  const first = await H.hudSnapshot(page);
  expect(first.bannerAttrs).toContain('data-turn=1');

  await H.pushLines(page, ['|turn|2', H.buildRequest({ rqid: 2 })]);
  const second = await H.hudSnapshot(page);
  expect(second.bannerAttrs).toContain('data-turn=2');
  expect(second.banner).toContain('Landorus-Therian');
  const opponentCards = await page.locator('[data-st-bench]').evaluateAll(function (cards) {
    return cards.map(function (card) {
      const image = card.querySelector('img[data-species-sprite]');
      const meter = card.querySelector('.st-bench-meter-fill');
      return {
        id: card.getAttribute('data-st-bench'),
        species: image && image.getAttribute('data-species-sprite'),
        src: image && image.getAttribute('src'),
        active: card.classList.contains('st-active'),
        hp: meter && meter.style.width
      };
    });
  });
  expect(opponentCards.map(function (card) { return card.id; })).toContain('landorustherian');
  expect(opponentCards.map(function (card) { return card.id; })).toContain('ironvaliant');
  const activeCard = opponentCards.find(function (card) { return card.id === 'landorustherian'; });
  expect(activeCard.species).toBe('landorus-therian');
  expect(activeCard.src).toBe('https://play.pokemonshowdown.com/sprites/gen5/landorus-therian.png');
  expect(activeCard.hp).toBe('100%');
  expect(activeCard.active).toBe(true);
  expect(opened.errors, opened.errors.join('\\n')).toHaveLength(0);
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
  expect(desktop.label).toMatch(/wide/i);
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
  expect(mobile.label).toMatch(/field/i);
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

test('the mobile match readout is compact, accessible, flat, and expands below the controls', async function () {
  const opened = await H.openBattle(env.ctx, { initLocal: { stHudLayout: 'auto' } });
  const { page } = opened;
  await H.waitForDrain(page);
  await H.pushLines(page, [H.buildRequest()]);
  await H.waitForBadges(page, 4);

  const state = function () {
    return page.evaluate(function () {
      const rect = function (el) {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
      };
      const sheet = document.querySelector('.st-sheet');
      const trigger = document.querySelector('[data-st-sheet-trigger]');
      const banner = sheet && sheet.querySelector('.tactician-banner');
      const arena = rect(document.querySelector('.battle'));
      const controls = rect(document.querySelector('.battle-controls'));
      const rail = rect(trigger);
      const moveButtons = Array.from(document.querySelectorAll('button[data-move]')).map(rect);
      const overlap = function (a, b) {
        return !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      };
      return {
        layout: document.documentElement.getAttribute('data-st-layout'),
        open: sheet && sheet.getAttribute('data-st-sheet-open'),
        hidden: sheet && sheet.getAttribute('aria-hidden'),
        role: sheet && sheet.getAttribute('role'),
        controlsLabel: trigger && trigger.getAttribute('aria-label'),
        railHeight: rail && rail.height,
        railOverlapsArena: overlap(rail, arena),
        railOverlapsControls: overlap(rail, controls) || moveButtons.some(function (m) { return overlap(rail, m); }),
        sheetText: sheet ? sheet.innerText : '',
        colors: sheet ? {
          height: sheet.getBoundingClientRect().height,
          identity: trigger.querySelector('.st-sheet-identity').textContent,
          ink: getComputedStyle(trigger).color,
          surfaceColor: getComputedStyle(sheet).backgroundColor,
          header: getComputedStyle(trigger).backgroundColor,
          headerBorderRadius: getComputedStyle(trigger).borderRadius,
          headerShadow: getComputedStyle(trigger).boxShadow,
          headerBackgroundImage: getComputedStyle(trigger).backgroundImage,
          bannerBorderLeftWidth: getComputedStyle(banner).borderLeftWidth,
          bannerShadow: getComputedStyle(banner).boxShadow,
          bannerBackgroundImage: getComputedStyle(banner).backgroundImage,
          summaryDisplay: getComputedStyle(trigger.querySelector('.st-sheet-summary')).display,
          eyebrow: getComputedStyle(banner, '::before').content,
          recommendationColor: getComputedStyle(banner, '::before').color,
          recommendationLabel: getComputedStyle(banner, '::before').content,
          background: getComputedStyle(document.body).backgroundColor,
          fontSize: getComputedStyle(banner).fontSize,
          headerMinHeight: getComputedStyle(trigger).minHeight,
          expanded: sheet.getAttribute('data-st-sheet-open'),
          hidden: sheet.getAttribute('aria-hidden'),
          touchHeight: trigger.getBoundingClientRect().height,
          allShadows: [getComputedStyle(sheet).boxShadow, getComputedStyle(trigger).boxShadow,
            getComputedStyle(banner).boxShadow],
          allRadii: [getComputedStyle(sheet).borderRadius, getComputedStyle(trigger).borderRadius,
            getComputedStyle(banner).borderRadius],
          benchTransition: getComputedStyle(document.querySelector('.st-bench-pill')).transitionDuration,
          hasIconLibrary: !!document.querySelector('svg[class*="lucide"], [data-lucide]'),
          emojiText: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(sheet.innerText),
          fixtureEvents: Array.from(document.querySelectorAll('.fixture-event')).map(function (el) { return el.innerText; }),
          controlSurfaces: Array.from(document.querySelectorAll('button[data-move]')).map(function (el) { return getComputedStyle(el).backgroundColor; }),
          protocolVisible: Array.from(document.querySelectorAll('.fixture-event')).some(function (el) { return el.innerText.indexOf('|') !== -1; }),
          pageBackground: getComputedStyle(document.body).backgroundColor,
          horizontallyClipped: document.documentElement.scrollWidth > window.innerWidth,
          fontFamily: getComputedStyle(banner).fontFamily,
          activeFontFamily: getComputedStyle(trigger).fontFamily,
          injectedBackgroundImages: [sheet, trigger, banner, document.querySelector('.tactician-tr-chip'),
            document.querySelector('.st-bench-strip')].concat(Array.from(document.querySelectorAll('.st-bench-pill')))
            .map(function (el) { return getComputedStyle(el).backgroundImage; }),
          injectedShadows: [sheet, trigger, banner, document.querySelector('.tactician-tr-chip'),
            document.querySelector('.st-bench-strip')].concat(Array.from(document.querySelectorAll('.st-bench-pill')))
            .map(function (el) { return getComputedStyle(el).boxShadow; }),
          injectedRadii: [sheet, trigger, banner, document.querySelector('.tactician-tr-chip'),
            document.querySelector('.st-bench-strip')].concat(Array.from(document.querySelectorAll('.st-bench-pill')))
            .map(function (el) { return getComputedStyle(el).borderRadius; }),
          injectedTransitions: [trigger, document.querySelector('.tactician-tr-chip'),
            document.querySelector('.st-bench-strip')].concat(Array.from(document.querySelectorAll('.st-bench-pill')))
            .map(function (el) { return getComputedStyle(el).transitionDuration; }),
          sentinelStyles: Array.from(sheet.querySelectorAll('.st-format-sentinel, .st-sentinel-row'))
            .map(function (el) { return { color: getComputedStyle(el).color, backgroundImage: getComputedStyle(el).backgroundImage }; })
        } : null
      };
    });
  };

  const collapsed = await state();
  expect(collapsed.layout).toBe('mobile');
  expect(collapsed.open).toBe('0');
  expect(collapsed.hidden).toBe('true');
  expect(collapsed.role).toBe('region');
  expect(collapsed.railHeight).toBeGreaterThanOrEqual(44);
  expect(collapsed.railOverlapsArena).toBe(false);
  expect(collapsed.railOverlapsControls).toBe(false);
  expect(collapsed.controlsLabel).toMatch(/Showdown Tactician/i);

  await page.click('[data-st-sheet-trigger]');
  await page.waitForFunction(function () {
    const sheet = document.querySelector('.st-sheet');
    return sheet && sheet.getAttribute('data-st-sheet-open') === '1' &&
      getComputedStyle(sheet).backgroundColor === 'rgb(41, 43, 44)';
  });
  const expanded = await state();
  expect(expanded.hidden).toBe('false');
  expect(expanded.sheetText).toContain('PLAY: Close Combat');
  expect(expanded.sheetText).toContain('OPPONENT FORMAT MECHANICS');
  expect(expanded.sheetText).not.toContain('\\n|');
  expect(expanded.colors.identity).toBe('SHOWDOWN');
  expect(expanded.colors.ink).toBe('rgb(236, 235, 231)');
  expect(expanded.colors.surfaceColor).toBe('rgb(41, 43, 44)');
  expect(expanded.colors.header).toBe('rgb(48, 50, 51)');
  expect(expanded.colors.headerBorderRadius).toBe('0px');
  expect(expanded.colors.headerShadow).toBe('none');
  expect(expanded.colors.bannerBorderLeftWidth).toBe('0px');
  expect(expanded.colors.bannerShadow).toBe('none');
  expect(expanded.colors.summaryDisplay).toBe('block');
  expect(expanded.colors.recommendationLabel).toContain('PLAY');
  expect(expanded.colors.headerBackgroundImage).toBe('none');
  expect(expanded.colors.bannerBackgroundImage).toBe('none');
  expect(expanded.colors.allShadows).toEqual(['none', 'none', 'none']);
  expect(expanded.colors.allRadii).toEqual(['0px', '0px', '0px']);
  expect(expanded.colors.benchTransition).toBe('0s');
  expect(expanded.colors.hasIconLibrary).toBe(false);
  expect(expanded.colors.emojiText).toBe(false);
  expect(expanded.colors.protocolVisible).toBe(false);
  expect(expanded.colors.fixtureEvents).toContain('OPPONENT ACTIVE  Landorus-Therian');
  expect(expanded.colors.fixtureEvents).toContain('YOUR ACTIVE  Great Tusk');
  expect(expanded.colors.controlSurfaces.every(function (color) { return color !== 'rgb(255, 255, 255)'; })).toBe(true);
  expect(expanded.colors.pageBackground).toBe('rgb(236, 235, 231)');
  expect(expanded.colors.horizontallyClipped).toBe(false);
  expect(expanded.colors.fontFamily).not.toMatch(/Inter|Geist|Space Grotesk/i);
  expect(expanded.colors.activeFontFamily).not.toMatch(/Inter|Geist|Space Grotesk/i);
  expect(expanded.colors.recommendationColor).toBe('rgb(200, 198, 189)');
  expect(expanded.colors.fontSize).toBe('15px');
  expect(expanded.colors.headerMinHeight).toBe('48px');
  expect(expanded.colors.injectedBackgroundImages.every(function (image) { return image === 'none'; })).toBe(true);
  expect(expanded.colors.injectedShadows.every(function (shadow) { return shadow === 'none'; })).toBe(true);
  expect(expanded.colors.injectedRadii.every(function (radius) { return radius === '0px'; })).toBe(true);
  expect(expanded.colors.injectedTransitions.every(function (duration) { return duration === '0s'; })).toBe(true);
  expect(expanded.colors.sentinelStyles.every(function (style) { return style.backgroundImage === 'none'; })).toBe(true);
  expect(expanded.colors.expanded).toBe('1');
  expect(expanded.colors.hidden).toBe('false');
  expect(expanded.colors.height).toBeGreaterThanOrEqual(48);
  expect(expanded.colors.touchHeight).toBeGreaterThanOrEqual(44);
  if (process.env.HUD_PREVIEW_DIR) {
    await page.screenshot({ path: require('path').join(process.env.HUD_PREVIEW_DIR, 'mobile-field-atlas.png'), scale: 'css' });
  }
  expect(opened.errors, opened.errors.join('\n')).toHaveLength(0);
  await page.close();
});

test('opponent roster shows sprite art, active state, and HP rails on desktop', async function () {
  const opened = await H.openBattle(env.ctx, { initLocal: { stHudLayout: 'desktop' } });
  const { page } = opened;
  await H.waitForDrain(page);
  await H.pushLines(page, [H.buildRequest()]);
  await H.waitForBadges(page, 4);
  const roster = page.locator('.st-console .st-bench-pill');
  await expect(roster).toHaveCount(2);
  await expect(roster.filter({ has: page.locator('[data-species-sprite="landorus-therian"]') })).toHaveCount(1);
  const active = page.locator('.st-bench-pill.st-active');
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute('data-st-bench', 'landorustherian');
  const cards = await roster.evaluateAll(function (els) {
    return els.map(function (el) {
      const img = el.querySelector('img[data-species-sprite]');
      return { spriteLoaded: !!img && img.complete && img.naturalWidth > 0,
        name: el.querySelector('.st-bench-name').textContent,
        meter: el.querySelector('.st-bench-meter-fill').style.width };
    });
  });
  expect(cards.every(function (card) { return card.spriteLoaded; })).toBe(true);
  expect(cards.some(function (card) { return card.name === 'Landorus-Therian'; })).toBe(true);
  expect(cards.every(function (card) { return card.meter === '100%'; })).toBe(true);
  expect(opened.errors, opened.errors.join('\\n')).toHaveLength(0);
  if (process.env.HUD_PREVIEW_DIR) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(250);
    await page.evaluate(function () {
      const consolePanel = document.querySelector('.st-console');
      if (consolePanel) consolePanel.setAttribute('data-st-console-open', '1');
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: require('path').join(process.env.HUD_PREVIEW_DIR, 'desktop-field-atlas.png'), scale: 'css' });
  }
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
