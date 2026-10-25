/* Showdown Tactician — tests/e2e/08-bugfix-regressions.spec.js
 *
 * One spec per defect reported from a real ladder game, written against the DOM a player
 * actually sees. These are deliberately kept together (rather than folded into 02-hud) so the
 * report in BUGFIXES.md can name a single file that fails if any of them comes back.
 *
 * Every test here is a REGRESSION: it was observed failing against the reported build (or
 * against a one-line reversal of the fix) before it was observed passing. The mutation table
 * lives in BUGFIXES.md.
 */
'use strict';

const { test, expect } = require('@playwright/test');
const H = require('./helpers');

let env = null;

test.beforeAll(async function () {
  env = await H.launchExtension({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
});

test.afterAll(async function () {
  if (env) await env.close();
});

/** A bar's text, e.g. "71 – 143% (2HKO)", parsed into numbers. */
function parseRange(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[\u2013\u2014-]\s*(\d+(?:\.\d+)?)%/.exec(String(text || ''));
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
}

test('a live room opening with |init|battle stays online instead of reading "battle" as a tier', async function () {
  /* The reported failure: a ranked National Dex game showed "ENGINE OFFLINE / battle" and every
   * move button was left without a number. `|init|battle` names the ROOM KIND; only `|tier|`
   * carries the format. */
  const setup = H.BATTLE_SETUP
    .filter(function (line) { return line.indexOf('|tier|') !== 0; })
    .map(function (line) { return line === '|init|[Gen 9] National Dex' ? '|init|battle' : line; })
    .map(function (line) { return line === '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100'
      ? '|switch|p1a: Great Tusk|Great Tusk, L100, M|100/100' : line; });

  const opened = await H.openBattle(env.ctx, { setup: setup });
  await H.waitForDrain(opened.page);
  await H.pushLines(opened.page, [H.buildRequest()]);
  await H.waitForBadges(opened.page, 4);

  const banner = await opened.page.locator('[data-st-banner]').textContent();
  expect(banner).not.toContain('ENGINE OFFLINE');
  expect(banner).toContain('PLAY:');

  /* The engine priced the turn, not just decorated the buttons: every bar carries a range. */
  const bars = await opened.page.locator('button[data-move] .st-lethal-bar').allInnerTexts();
  expect(bars).toHaveLength(4);
  bars.forEach(function (text) {
    expect(parseRange(text), text).toBeTruthy();
  });

  expect(opened.errors, opened.errors.join('\n')).toHaveLength(0);
  await opened.page.close();
});

for (const client of ['classic', 'beta']) {
  test(client + ': a missed tier is recovered from live metadata and resumes the pending decision', async function () {
    const opened = await H.openBattle(env.ctx, { client: client });
    const page = opened.page;
    await H.pushLines(page, ['|tier|[Gen 9] OU', H.buildRequest()]);
    await expect(page.locator('[data-st-banner]')).toContainText('ENGINE OFFLINE');
    await page.evaluate(function () {
      window.__mock.battle.tier = '[Gen 9] National Dex';
      window.__ST_INJECTED_FLUSH();
    });
    await expect(page.locator('button.movebutton .elo-helper-badge')).toHaveCount(4);
    await expect(page.locator('[data-st-banner]')).not.toContainText('ENGINE OFFLINE');
    await expect(page.locator('.st-lethal-bar')).toHaveCount(4);
    await page.evaluate(function () {
      window.__mock.battle.tier = '[Gen 9] National Dex Ubers';
      window.__ST_INJECTED_FLUSH();
    });
    await expect(page.locator('[data-st-banner]')).toContainText('ENGINE OFFLINE');
    await expect(page.locator('.st-lethal-bar')).toHaveCount(0);
    expect(opened.errors).toEqual([]);
    await page.close();
  });
}

test('a normalized L50 detail in a level-100 battle cannot double the opponent into 300%+', async function () {
  /* The reported failure: Showdown prints `L50` in |poke|/|switch| details even though the
   * format is played at level 100. Believing it halved the opponent's HP and defenses, so Ice
   * Spinner into Landorus-Therian (4x, a body with 0 Def investment) read roughly 284-572%.
   * The fixture's own BATTLE_SETUP carries L50 details on both sides, which is exactly the
   * real log's shape. */
  const opened = await H.openBattle(env.ctx);
  await H.waitForDrain(opened.page);
  await H.pushLines(opened.page, [H.buildRequest()]);
  await H.waitForBadges(opened.page, 4);

  const text = await opened.page.locator('button[data-move="icespinner"] .st-lethal-bar').innerText();
  const range = parseRange(text);
  expect(range, text).toBeTruthy();
  expect(range.min).toBeGreaterThan(20);
  expect(range.max).toBeLessThan(250);

  /* ...and the verdict describes the range it is attached to. A max above 100% is an OHKO on
   * the fastest spread and a 2HKO on the bulkiest; it is never "leaves them at ~0% HP". */
  expect(text).not.toMatch(/leaves them at ~0%/i);
  expect(text).toMatch(/2HKO|Guaranteed lethal|leaves them at/i);

  expect(opened.errors, opened.errors.join('\n')).toHaveLength(0);
  await opened.page.close();
});

test('a fractional HP landing updates the roster instead of freezing it at 100%', async function () {
  /* The reported failure was not one wrong number: parseHPString only accepted whole percents,
   * so the FIRST 15.2% hit on Tarot-Reader was discarded and every later readout used the
   * stale 100%. Reproduce the user's own line shape and watch the card follow it. */
  const opened = await H.openBattle(env.ctx);
  await H.waitForDrain(opened.page);
  await H.pushLines(opened.page, [
    '|switch|p2a: Landorus-Therian|Landorus-Therian, L50, M|100/100',
    '|-damage|p2a: Landorus-Therian|72.06/100',
    H.buildRequest()
  ]);
  await H.waitForBadges(opened.page, 4);

  await opened.page.waitForFunction(function () {
    const card = document.querySelector('[data-st-bench="landorustherian"]');
    return !!card && /72%/.test(card.textContent || '');
  }, null, { timeout: 5000 });
  const card = await opened.page.locator('[data-st-bench="landorustherian"]').innerText();
  expect(card).toContain('72%');
  expect(card).not.toContain('100%');

  /* A whole-percent fallback string still works, so the fix cannot regress the simple case. */
  await H.pushLines(opened.page, [
    '|-damage|p2a: Landorus-Therian|31/100',
    H.buildRequest({ rqid: 2 })
  ]);
  await opened.page.waitForFunction(function () {
    const el = document.querySelector('[data-st-bench="landorustherian"]');
    return !!el && /31%/.test(el.textContent || '');
  }, null, { timeout: 5000 });

  expect(opened.errors, opened.errors.join('\n')).toHaveLength(0);
  await opened.page.close();
});

test('a bench-target preview never survives a change of their active body', async function () {
  /* THE "12%" REPORT. Tapping a bench card retargets every damage bar; the selection used to
   * survive the opponent's next switch, so a Fire Punch into the newly-active Serperior kept
   * showing the number for a benched Garchomp. Reproduce the exact shape: tap Iron Valiant,
   * then bring Cresselia in as the active body while Iron Valiant stays on the bench. */
  const opened = await H.openBattle(env.ctx);
  await H.waitForDrain(opened.page);
  await H.pushLines(opened.page, [H.buildRequest()]);
  await H.waitForBadges(opened.page, 4);

  await opened.page.click('[data-st-bench="ironvaliant"]');
  await opened.page.waitForFunction(function () {
    const bar = document.querySelector('button[data-move] .st-lethal-bar');
    return !!bar && / vs Iron Valiant/i.test(bar.textContent || '');
  }, null, { timeout: 5000 });
  expect(await opened.page.locator('.st-bench-caption').innerText()).toContain('Iron Valiant');

  /* Their active changes to a THIRD body; the benched Iron Valiant is still a legal target, so
   * nothing about the tap itself is stale except the board it described. */
  await H.pushLines(opened.page, [
    '|switch|p2a: Cresselia|Cresselia, L50, F|100/100',
    H.buildRequest({ rqid: 2 })
  ]);
  await opened.page.waitForFunction(function () {
    const bars = Array.prototype.slice.call(document.querySelectorAll('button[data-move] .st-lethal-bar'));
    return bars.length > 0 && bars.every(function (bar) { return !/ vs /i.test(bar.textContent || ''); });
  }, null, { timeout: 5000 });

  const texts = await opened.page.locator('button[data-move] .st-lethal-bar').allInnerTexts();
  texts.forEach(function (text) { expect(text).not.toMatch(/ vs /i); });
  expect(await opened.page.locator('.st-bench-caption').count()).toBe(0);
  expect(await opened.page.locator('[data-st-banner]').textContent()).toContain('Cresselia');

  expect(opened.errors, opened.errors.join('\n')).toHaveLength(0);
  await opened.page.close();
});

test('the scout ledger records moves, residual items and an immunity ability, with no CONFIRMED READS row', async function () {
  /* The reported failure: the only "confirmed read" was CHOICE LOCK BROKEN, repeated once per
   * body, and the enemy's moves, item and ability were nowhere. This walks the three reveal
   * shapes the protocol actually uses: a move, a Leftovers heal (`[from] item:` with no
   * |-item| line), and Levitate on an immunity line. */
  const opened = await H.openBattle(env.ctx);
  await H.waitForDrain(opened.page);
  await H.pushLines(opened.page, [
    '|switch|p2a: Cresselia|Cresselia, L50, F|100/100',
    '|move|p2a: Cresselia|Moonblast|p1a: Great Tusk',
    '|-damage|p1a: Great Tusk|71.4/100',
    '|-heal|p2a: Cresselia|100/100|[from] item: Leftovers',
    '|-immune|p2a: Cresselia|[from] ability: Levitate',
    H.buildRequest()
  ]);
  await opened.page.locator('[data-st-view-button="intel"]').click();
  await opened.page.waitForSelector('.st-scout-card');
  await opened.page.locator('.st-scout-card > summary').click();
  const scout = await opened.page.locator('.st-scout-card').innerText();
  expect(scout).toContain('Cresselia');
  expect(scout).toContain('Moonblast');
  expect(scout).toContain('Leftovers');
  expect(scout).toContain('Levitate');

  /* The old ticket row is gone for good; keeping both would duplicate every fact. */
  expect(await opened.page.locator('.st-unmask-badge').count()).toBe(0);
  const labels = await opened.page.locator('.st-console-label').allInnerTexts();
  expect(labels).not.toContain('CONFIRMED READS');

  expect(opened.errors, opened.errors.join('\n')).toHaveLength(0);
  await opened.page.close();
});

test('WIDE docks a content-sized panel clear of the move buttons and stays inside the viewport', async function () {
  /* The reported failure: WIDE was a full-height rail over the chat, with 9px type. This is the
   * same geometry contract as 02-hud's desktop test, kept here so the fix report has one file. */
  const opened = await H.openBattle(env.ctx, { initLocal: { stHudLayout: 'desktop' } });
  const { page } = opened;
  await page.setViewportSize({ width: 1440, height: 900 });
  await H.waitForDrain(page);
  await H.pushLines(page, [H.buildRequest()]);
  await H.waitForBadges(page, 4);

  const rail = await page.evaluate(function () {
    const panel = document.querySelector('.st-console');
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    const moves = document.querySelector('button[data-move]');
    const m = moves ? moves.getBoundingClientRect() : null;
    const cs = getComputedStyle(panel);
    /* The smallest type that actually paints inside the panel. The report was "the text is
     * practically unreadable", which is what 9px uppercase labels are; every text node must now
     * clear 10px even after the mobile/desktop overrides have all cascaded. */
    let minFont = Infinity;
    const nodes = panel.querySelectorAll('*');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      let painted = false;
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3 && String(n.nodeValue || '').trim()) { painted = true; break; }
      }
      if (!painted) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size > 0 && size < minFont) minFont = size;
    }
    return {
      minFontSize: minFont === Infinity ? null : minFont,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      coversMove: !!(m && r.left < m.right && r.right > m.left && r.top < m.bottom && r.bottom > m.top),
      overflowX: panel.scrollWidth > panel.clientWidth + 1,
      fontSize: cs.fontSize,
      shadow: cs.boxShadow,
      radius: cs.borderRadius
    };
  });
  expect(rail).toBeTruthy();
  expect(rail.rect.right).toBeLessThanOrEqual(1440);
  expect(rail.rect.bottom).toBeLessThanOrEqual(900);
  expect(rail.rect.width).toBeLessThanOrEqual(440);
  expect(rail.rect.height).toBeLessThanOrEqual(888);
  expect(rail.coversMove).toBe(false);
  expect(rail.overflowX).toBe(false);
  expect(rail.shadow).toBe('none');
  expect(rail.radius).toBe('0px');
  expect(parseFloat(rail.fontSize)).toBeGreaterThanOrEqual(13.5);
  expect(typeof rail.minFontSize, 'the panel must paint some text').toBe('number');
  expect(rail.minFontSize, 'the smallest painted label in the console').toBeGreaterThanOrEqual(10);

  /* The house copy rules the HUD was rewritten to: no em dash, no emoji. Scoped to the
   * extension's own nodes so Showdown's fixture text cannot make this pass or fail. */
  const copy = await page.evaluate(function () {
    const sel = '.tactician-banner, .st-console, .st-scout-card, .st-bench-strip, ' +
      '.st-lethal-bar, .elo-helper-badge, .tactician-tr-chip';
    return Array.prototype.slice.call(document.querySelectorAll(sel))
      .map(function (n) { return n.textContent || ''; }).join(' ');
  });
  expect(copy).not.toContain('\u2014');
  expect(copy).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);

  expect(opened.errors, opened.errors.join('\n')).toHaveLength(0);
  await page.close();
});
