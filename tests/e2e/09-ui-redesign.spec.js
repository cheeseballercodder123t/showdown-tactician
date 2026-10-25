'use strict';
const { test, expect } = require('@playwright/test');
const path = require('path');
const H = require('./helpers');
let env;
test.beforeAll(async () => {
  env = await H.launchExtension({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
});
test.afterAll(async () => { if (env) await env.close(); });
async function start(client, width, height = 900) {
  const setup = H.BATTLE_SETUP.slice();
  setup.splice(setup.indexOf('|teampreview'), 0,
    '|poke|p2|Garchomp, L100, M|item', '|poke|p2|Ferrothorn, L100, M|item',
    '|poke|p2|Kingambit, L100, M|item', '|poke|p2|Slowking-Galar, L100, M|item');
  const opened = await H.openBattle(env.ctx, { client, setup: false, initLocal: { stHudLayout: 'auto' } });
  await opened.page.setViewportSize({ width, height });
  await H.pushLines(opened.page, setup.concat(H.buildRequest()));
  await expect(opened.page.locator('.movebutton > .st-lethal-bar')).toHaveCount(4);
  await opened.page.evaluate(() => {
    window.nativeChoices = 0;
    document.addEventListener('click', e => {
      if (e.target.closest('.movebutton, .switchbutton')) window.nativeChoices++;
    });
  });
  return opened;
}
for (const client of ['classic', 'beta']) {
  for (const [width, height] of [[320, 740], [412, 915], [768, 1024], [844, 390], [1280, 800], [1440, 900]]) {
    test(`${client}: responsive battle at ${width}x${height}`, async () => {
      const { page, errors } = await start(client, width, height);
      const mobile = width < 1024;
      await expect(page.locator('html')).toHaveAttribute('data-st-layout', mobile ? 'mobile' : 'desktop');
      await expect(page.locator('[data-st-bench]')).toHaveCount(6);
      if (mobile) {
        const trigger = page.locator('[data-st-sheet-trigger]');
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        await trigger.focus();
        await trigger.press('Enter');
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      }
      const panel = page.locator(mobile ? '.st-sheet' : '.st-console');
      await expect(panel.locator('.st-damage-row')).toHaveCount(4);
      await panel.locator('.st-damage-row').last().scrollIntoViewIfNeeded();
      await expect(panel.locator('.st-damage-row').last()).toBeInViewport();
      const audit = await page.evaluate(() => {
        const overlap = (a, b) => a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 && a.right > b.left + 1 && a.left < b.right - 1 && a.bottom > b.top + 1 && a.top < b.bottom - 1;
        const buttons = [...document.querySelectorAll('.movebutton')];
        const surfaces = [...document.querySelectorAll('.st-console, .st-sheet, .st-bench-strip, .tactician-tr-chip')];
        const visible = surfaces.filter(el => el.getClientRects().length);
        const styled = [...document.querySelectorAll('.st-console, .st-sheet, .st-bench-strip, .st-console *, .st-sheet *, .st-bench-strip *')];
        return {
          clipped: document.documentElement.scrollWidth > innerWidth,
          clippedControls: (() => {
            const controls = document.querySelector('.battle-controls');
            const position = getComputedStyle(controls).position;
            return ['absolute', 'fixed'].includes(position) && controls.getBoundingClientRect().bottom > innerHeight + 1;
          })(),
          coversMoves: visible.some(el => buttons.some(b => overlap(el.getBoundingClientRect(), b.getBoundingClientRect()))),
          outside: visible.some(el => { const r = el.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }),
          gradients: styled.some(el => /gradient/.test(getComputedStyle(el).backgroundImage)),
          shadows: styled.some(el => getComputedStyle(el).boxShadow !== 'none'),
          rounded: styled.some(el => getComputedStyle(el).borderRadius !== '0px'),
          motion: styled.some(el => getComputedStyle(el).transitionDuration !== '0s'),
          error: document.documentElement.dataset.stError || '',
          triggerHidden: !!document.querySelector('[data-st-sheet-trigger]')?.closest('[aria-hidden="true"]'),
          choiceCount: window.nativeChoices,
          bars: buttons.map(b => b.querySelector('.st-lethal-bar')?.textContent)
        };
      });
      expect(audit.clipped).toBe(false);
      expect(audit.clippedControls).toBe(false);
      expect(audit.coversMoves).toBe(mobile);
      expect(audit.outside).toBe(false);
      expect(audit.gradients).toBe(false);
      expect(audit.shadows).toBe(false);
      expect(audit.rounded).toBe(false);
      expect(audit.motion).toBe(false);
      expect(audit.triggerHidden).toBe(false);
      expect(audit.error).toBe('');
      expect(audit.choiceCount).toBe(0);
      audit.bars.forEach(text => expect(text).toMatch(/^\d+ [\u2013-] \d+%/));
      if ([412, 1440].includes(width)) {
        await page.screenshot({ path: path.join(H.ROOT, 'artifacts', 'ui-redesign', `${client}-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true, scale: 'css' });
      }
      expect(errors).toEqual([]);
      await page.close();
    });
  }
  test(`${client}: preview, reset, rebuilt controls, offline cleanup`, async () => {
    const { page, errors } = await start(client, 412, 915);
    await page.locator('[data-st-bench="ironvaliant"]').click();
    await expect(page.locator('.st-bench-strip')).toHaveAttribute('data-st-preview-target', 'Iron Valiant');
    for (const text of await page.locator('.movebutton .st-lethal-bar').allTextContents()) expect(text).toContain('vs Iron Valiant');
    await page.getByRole('button', { name: 'Return to active' }).click();
    await expect(page.locator('.st-bench-strip')).not.toHaveAttribute('data-st-preview-target');
    await page.evaluate(() => window.__mock.rebuildControlBar());
    await expect(page.locator('.movebutton .st-lethal-bar')).toHaveCount(4);
    await expect(page.locator('.st-sheet')).toHaveCount(1);
    await expect(page.locator('.battle-controls > .st-bench-strip')).toHaveCount(1);
    await expect(page.locator('.battle-controls > .st-sheet')).toHaveCount(1);
    await H.pushLines(page, ['|tier|[Gen 9] OU', '|turn|2', H.buildRequest({ rqid: 2 })]);
    await expect(page.locator('.st-lethal-bar')).toHaveCount(0);
    await expect(page.locator('.st-matchup')).toHaveCount(0);
    expect(await page.evaluate(() => window.nativeChoices)).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });
}
test('beta: the desktop dock reserves log space and restores it on compact layout', async () => {
  const { page } = await start('beta', 1440, 900);
  await expect(page.locator('html')).toHaveAttribute('data-st-dock', 'side');
  const overlap = await page.evaluate(() => {
    const log = document.querySelector('.battle-log').getBoundingClientRect();
    const panel = document.querySelector('.st-console').getBoundingClientRect();
    return log.right > panel.left;
  });
  expect(overlap).toBe(false);
  await page.locator('.st-mode-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-st-layout', 'mobile');
  expect(await page.locator('.battle-log').evaluate(el => el.style.right)).toBe('');
  await page.close();
});
test('beta: hidden copies of the move menu cannot consume visible damage previews', async () => {
  const { page } = await start('beta', 412, 915);
  await page.evaluate(() => {
    window.__mock.rebuildControlBar();
    const menu = document.querySelector('.movemenu');
    const hidden = menu.cloneNode(true);
    hidden.removeAttribute('id');
    hidden.style.display = 'none';
    hidden.querySelectorAll('.st-lethal-bar, .elo-helper-badge').forEach(el => el.remove());
    menu.parentNode.insertBefore(hidden, menu);
  });
  await H.pushLines(page, ['|turn|2', H.buildRequest({ rqid: 2 })]);
  await expect(page.locator('.movebutton:visible .st-lethal-bar')).toHaveCount(4);
  await expect(page.locator('.movemenu[style] .st-lethal-bar')).toHaveCount(0);
  await page.close();
});

test('beta: resizing the dock preserves chat and compact mode restores native geometry', async () => {
  const { page } = await start('beta', 1440, 900);
  await page.locator('.st-console').evaluate(el => { el.style.width = '400px'; });
  await expect(page.locator('.battle-log')).toHaveCSS('right', '416px');
  const geometry = await page.evaluate(() => ({
    log: document.querySelector('.battle-log').getBoundingClientRect().right,
    panel: document.querySelector('.st-console').getBoundingClientRect().left
  }));
  expect(geometry.log).toBeLessThanOrEqual(geometry.panel);
  await page.locator('.ps-room').evaluate(el => { el.style.width = '640px'; });
  await expect(page.locator('html')).toHaveAttribute('data-st-layout', 'mobile');
  expect(await page.locator('.battle-log').evaluate(el => el.style.right)).toBe('');
  await expect(page.locator('.st-console')).toHaveCount(0);
  await page.close();
});
