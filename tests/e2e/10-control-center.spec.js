'use strict';
const { test, expect } = require('@playwright/test');
const H = require('./helpers');
const path = require('path');
let env;
test.beforeAll(async () => {
  env = await H.launchExtension({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM, stHudLayout: 'auto' });
});
test.afterAll(async () => { if (env) await env.close(); });
async function start(client, width, height) {
  const opened = await H.openBattle(env.ctx, { client, setup: false, initLocal: { stHudLayout: 'auto' } });
  await opened.page.setViewportSize({ width, height });
  await H.pushLines(opened.page, H.BATTLE_SETUP.concat(H.buildRequest()));
  await expect(opened.page.locator('.movebutton .st-lethal-bar')).toHaveCount(4);
  await expect(opened.page.locator('[data-st-view-button]')).toHaveCount(4);
  return opened;
}
for (const client of ['classic', 'beta']) {
  for (const [width, height] of [[320, 568], [412, 915], [844, 390]]) {
    test(`${client}: full mobile workspace at ${width}x${height}`, async () => {
      const { page, errors } = await start(client, width, height);
      await page.locator('[data-st-sheet-trigger]').click();
      const center = page.getByRole('dialog', { name: 'Tactician control center' });
      await expect(center).toBeVisible();
      const rect = await center.boundingBox();
      expect(rect.x).toBeCloseTo(0, 0);
      expect(rect.y).toBeCloseTo(0, 0);
      expect(rect.width).toBeCloseTo(width, 0);
      expect(rect.height).toBeCloseTo(height, 0);
      expect(await page.locator('.ps-room').evaluate(el => el.inert)).toBe(true);
      for (const view of ['intel', 'field', 'review', 'battle']) {
        const button = center.locator(`[data-st-view-button="${view}"]`);
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await expect(button).toBeInViewport({ ratio: 1 });
        expect(await center.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
      await center.locator('[data-st-view-button="intel"]').click();
      await expect(center.locator('.st-intelligence')).toBeVisible();
      const candidates = center.locator('.st-candidate');
      expect(await candidates.count()).toBeGreaterThan(0);
      await candidates.last().scrollIntoViewIfNeeded();
      const finalCandidate = await candidates.last().boundingBox();
      const nav = await center.locator('.st-center-nav').boundingBox();
      expect(finalCandidate.y).toBeLessThan(nav.y);
      await page.keyboard.press('Escape');
      await expect(page.locator('.st-sheet')).toHaveAttribute('data-st-sheet-open', '0');
      expect(await page.locator('.ps-room').evaluate(el => el.inert)).toBe(false);
      expect(await page.locator('body').evaluate(el => el.style.overflow)).toBe('');
      await expect(page.locator('.movebutton').first()).not.toHaveAttribute('inert');
      expect(errors).toEqual([]);
      await page.close();
    });
  }
  test(`${client}: set pruning and revealed facts update without another request`, async () => {
    const { page, errors } = await start(client, 1440, 900);
    await page.locator('[data-st-view-button="intel"]').click();
    await expect(page.locator('.st-intelligence')).toBeVisible();
    const before = Number(await page.locator('.st-pool-number').innerText());
    await H.pushLines(page, [
      '|-item|p2a: Landorus-Therian|Leftovers',
      '|move|p2a: Landorus-Therian|Earthquake|p1a: Great Tusk',
      '|move|p2a: Landorus-Therian|U-turn|p1a: Great Tusk'
    ]);
    await expect(page.locator('.st-intelligence')).toContainText('Leftovers');
    await expect(page.locator('.st-intelligence')).toContainText('Earthquake');
    await expect(page.locator('.st-evidence-list')).toContainText(/Choice|Confirmed item|Revealed move/);
    const remaining = Number(await page.locator('.st-pool-number').innerText());
    expect(remaining).toBeLessThanOrEqual(before);
    await expect(page.locator('.st-candidate')).toHaveCount(remaining);
    await page.locator('[data-st-inspector]').selectOption('ironvaliant');
    await expect(page.locator('.st-inspect-name')).toHaveText('Iron Valiant');
    await expect(page.locator('.st-pool-number')).toHaveText('?');
    await page.locator('[data-st-inspector]').selectOption('landorustherian');
    const candidate = page.locator('.st-candidate').first();
    await candidate.evaluate(el => { el.open = false; });
    const candidateNode = await candidate.elementHandle();
    await page.waitForTimeout(2800);
    expect(await candidateNode.evaluate(el => el.isConnected && !el.open)).toBe(true);
    await page.locator('[data-st-view-button="review"]').click();
    await expect(page.locator('.st-engine-review')).toContainText('Endgame search');
    await expect(page.locator('.st-engine-review')).toContainText('Information gained by scouting');
    await expect(page.locator('.st-engine-review')).toContainText('Opponent tendencies');
    await page.locator('.st-engine-report').first().evaluate(el => { el.open = true; });
    await H.pushLines(page, ['|-status|p2a: Landorus-Therian|par']);
    expect(await page.locator('.st-engine-report').first().evaluate(el => el.open)).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  });
}
test('mobile: focus stays in the workspace and room changes release background controls', async () => {
  const { page } = await start('beta', 412, 915);
  await page.locator('[data-st-sheet-trigger]').click();
  await page.locator('[data-st-view-button="review"]').focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement.closest('.st-sheet'))).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('html')).toHaveAttribute('data-st-layout', 'desktop');
  expect(await page.locator('.ps-room').evaluate(el => el.inert)).toBe(false);
  expect(await page.locator('body').evaluate(el => el.style.overflow)).toBe('');
  await page.close();
});
