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
  const opened = await H.openBattle(env.ctx, { initLocal: { stHudLayout: 'auto' } });
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
  expect(button.opacity).toBe('');
  expect(button.textDecoration).toBe('');

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
  expect(desktop.label).toMatch(/auto|wide/i);
  expect(desktop.hasConsole).toBe(true);
  /* The point of the desktop layout: the HUD is docked and must not cover a move button. */
  expect(desktop.coversMoveButton).toBe(false);

  /* The toggle button flips it. It is the in-page control the user actually touches. */
  await page.click('.st-mode-toggle');
  await page.waitForFunction(function () {
    return document.documentElement.getAttribute('data-st-layout') === 'mobile';
  });
  await page.click('[data-st-sheet-trigger]');
  const mobile = await read();
  expect(mobile.layout).toBe('mobile');
  expect(mobile.label).toMatch(/compact/i);
  expect(mobile.hasToggle).toBe(true);

  /* Clicking the toggle must not steal keyboard focus: Showdown's move shortcuts are
   * window-level keys, so a button that keeps focus would swallow space/enter. */
  const focus = await page.evaluate(function () {
    const ae = document.activeElement;
    return ae ? ae.tagName : null;
  });
  expect(await page.evaluate(() => !!document.activeElement.closest('.st-sheet'))).toBe(true);

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

test('the mobile control center is accessible and fills the viewport on demand', async function () {
  const { page, errors } = await playTurn();
  const trigger = page.locator('[data-st-sheet-trigger]');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(await trigger.evaluate(el => !!el.closest('[aria-hidden="true"]'))).toBe(false);
  await trigger.focus();
  await trigger.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.st-sheet .st-damage-row')).toHaveCount(4);
  await expect(page.locator('.st-sheet .st-play-name')).toContainText('Ice Spinner');
  await expect(page.locator('.st-sheet')).toHaveAttribute('role', 'dialog');
  const bounds = await page.locator('.st-sheet').boundingBox();
  expect(bounds.height).toBe(915);
  expect(await page.locator('.st-sheet').evaluate(el => el.parentElement.tagName)).toBe('BODY');
  await trigger.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.battle-controls > .st-sheet')).toHaveCount(1);
  expect(errors).toHaveLength(0);
  await page.close();
});

test('a live battle room (|init|battle) keeps the engine online instead of reading "battle" as a tier', async function () {
  /* The real client opens a battle room with `|init|battle` and only some transports also
   * carry `|tier|`. The old parser treated the room kind as a format, the NatDex allowlist
   * rejected it, and a ranked National Dex game showed "ENGINE OFFLINE / battle". */
  const setup = H.BATTLE_SETUP.filter(function (line) {
    return line.indexOf('|tier|') !== 0;
  }).map(function (line) {
    return line === '|init|[Gen 9] National Dex' ? '|init|battle' : line;
  });
  const opened = await H.openBattle(env.ctx, { setup: setup });
  const { page } = opened;
  await H.waitForDrain(page);
  await H.pushLines(page, [H.buildRequest()]);
  await H.waitForBadges(page, 4);
  const banner = await page.locator('[data-st-banner]').innerText();
  expect(banner).not.toContain('ENGINE OFFLINE');
  expect(banner).toContain('PLAY: Ice Spinner');
  expect(await page.locator('button[data-move] .st-lethal-bar').count()).toBe(4);
  expect(opened.errors, opened.errors.join('\n')).toHaveLength(0);
  await page.close();
});

test('the scout log records revealed moves, items and abilities, and bench previews say who they price', async function () {
  const opened = await H.openBattle(env.ctx, { initLocal: { stHudLayout: 'auto' } });
  const { page } = opened;
  await H.waitForDrain(page);
  await H.pushLines(page, [H.buildRequest()]);
  await H.waitForBadges(page, 4);

  /* Two moves in one stint without a switch is a PROVEN rule-out, and the same lines give
   * the scout ledger its first facts. */
  await H.pushLines(page, [
    '|move|p2a: Landorus-Therian|Earthquake|p1a: Great Tusk',
    '|-damage|p1a: Great Tusk|40/100',
    '|move|p2a: Landorus-Therian|U-turn|p1a: Great Tusk',
    '|-damage|p1a: Great Tusk|31/100',
    '|-item|p2a: Landorus-Therian|Leftovers',
    '|-ability|p2a: Landorus-Therian|Intimidate',
    H.buildRequest({ rqid: 2 })
  ]);
  const analysis = page.locator('[data-st-sheet-trigger]');
  if (await analysis.count() && await analysis.getAttribute('aria-expanded') === 'false') await analysis.click();
  await page.locator('[data-st-view-button="intel"]').click();
  await page.locator('.st-scout-card > summary').click();
  await page.waitForSelector('.st-scout-card');
  const scout = await page.locator('.st-scout-card').innerText();
  expect(scout).toContain('Landorus-Therian');
  expect(scout).toContain('Earthquake');
  expect(scout).toContain('U-turn');
  expect(scout).toContain('Leftovers');
  expect(scout).toContain('Intimidate');

  /* The old "confirmed reads" ticket row was removed: it printed only negative deductions
   * (CHOICE ITEMS RULED OUT) and never the opponent's moves, item or ability. The scout ledger
   * above is now the single place those facts live, so the ticket row must not come back. */
  expect(await page.locator('.st-unmask-badge').count()).toBe(0);
  expect(await page.locator('.st-console-label').allInnerTexts()).not.toContain('CONFIRMED READS');

  /* A bench tap must never be able to pass as a prediction for the active body. */
  await page.click('[data-st-bench="ironvaliant"]');
  await page.waitForFunction(function () {
    const bar = document.querySelector('button[data-move] .st-lethal-bar');
    return !!bar && / vs Iron Valiant/i.test(bar.textContent);
  });
  expect(await page.locator('.st-bench-caption').innerText()).toContain('Iron Valiant');

  /* Their active body changes: the bench pick no longer describes a live matchup and the
   * bars must go back to the active pair on their own. */
  await H.pushLines(page, [
    '|switch|p2a: Iron Valiant|Iron Valiant, L50, F|100/100',
    H.buildRequest({ rqid: 3 })
  ]);
  await page.waitForFunction(function () {
    const bars = Array.prototype.slice.call(document.querySelectorAll('button[data-move] .st-lethal-bar'));
    return bars.length > 0 && bars.every(function (bar) { return !/ vs /i.test(bar.textContent); });
  });
  expect(await page.locator('.st-bench-caption').count()).toBe(0);

  expect(opened.errors, opened.errors.join('\n')).toHaveLength(0);
  await page.close();
});

test('opponent roster shows sprite art, active state, and HP rails on desktop', async function () {
  const opened = await H.openBattle(env.ctx, { initLocal: { stHudLayout: 'auto' } });
  const { page } = opened;
  await page.setViewportSize({ width: 1440, height: 900 });
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

  /* WIDE is a bottom-docked console that sizes to its content and caps at 72vh, not a
   * full-height rail over the battle log. It now opens expanded by default; make sure of that
   * (rather than clicking, which would collapse it) and measure the panel the player gets. */
  await page.waitForFunction(function () {
    const el = document.querySelector('.st-console');
    if (!el) return false;
    if (el.getAttribute('data-st-console-open') !== '1') {
      const header = document.querySelector('.st-console-header');
      if (header) header.click();
    }
    return el.getAttribute('data-st-console-open') === '1';
  });
  const rail = await page.evaluate(function () {
    const consoleEl = document.querySelector('.st-console');
    const r = consoleEl.getBoundingClientRect();
    const moveButtons = Array.prototype.slice.call(document.querySelectorAll('button[data-move]'));
    const coversMove = moveButtons.some(function (b) {
      const m = b.getBoundingClientRect();
      return r.right > m.left && r.left < m.right && r.bottom > m.top && r.top < m.bottom;
    });
    const rgb = function (value) {
      const m = String(value).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const lum = function (c) {
      const v = c.map(function (n) { n /= 255; return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); });
      return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    };
    const bgOf = function (el) {
      let node = el;
      while (node) {
        if (getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)') return rgb(getComputedStyle(node).backgroundColor);
        node = node.parentElement;
      }
      return [27, 28, 28];
    };
    const ratio = function (el) {
      if (!el) return null;
      const a = lum(rgb(getComputedStyle(el).color));
      const b = lum(bgOf(el));
      return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
    };
    const cs = getComputedStyle(consoleEl);
    return {
      rect: { top: r.top, right: r.right, width: r.width, height: r.height },
      coversMove: coversMove,
      overflowX: consoleEl.scrollWidth > consoleEl.clientWidth + 1,
      shadow: cs.boxShadow,
      radius: cs.borderRadius,
      backgroundImage: cs.backgroundImage,
      header: (function () { const h = document.querySelector('.st-console-header'); return h ? { bg: getComputedStyle(h).backgroundColor, color: getComputedStyle(h).color } : null; })(),
      contrast: {
        banner: ratio(document.querySelector('.tactician-banner')),
        summary: ratio(document.querySelector('.st-console-summary')),
        sentinel: ratio(document.querySelector('.st-sentinel-row')),
        tactic: ratio(document.querySelector('.st-sentinel-tactic')),
        bench: ratio(document.querySelector('.st-bench-name'))
      }
    };
  });
  expect(rail.rect.top, 'the side panel stays below page chrome').toBeGreaterThanOrEqual(8);
  expect(rail.rect.right).toBeGreaterThanOrEqual(1423);
  expect(rail.rect.right).toBeLessThanOrEqual(1440);
  expect(rail.rect.height, 'the side panel stays inside the viewport').toBeLessThanOrEqual(880);
  expect(rail.rect.height).toBeGreaterThan(200);
  expect(rail.rect.width).toBeLessThanOrEqual(480);
  expect(rail.coversMove).toBe(false);
  expect(rail.overflowX).toBe(false);
  expect(rail.shadow).toBe('none');
  expect(rail.radius).toBe('0px');
  expect(rail.backgroundImage).toBe('none');
  Object.keys(rail.contrast).forEach(function (key) {
    if (typeof rail.contrast[key] !== 'number') return;
    expect(rail.contrast[key], key + ' contrast').toBeGreaterThanOrEqual(4.5);
  });

  expect(opened.errors, opened.errors.join('\\n')).toHaveLength(0);
  if (process.env.HUD_PREVIEW_DIR) {
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
