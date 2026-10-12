/* Showdown Tactician — tests/e2e/07-options.spec.js
 *
 * The options page is a real, user-facing surface that had NO automated coverage of any kind:
 * not in the Node suite (it is a chrome-extension page, so the vm harness never sees it) and
 * not in the E2E suite until now. It is also the only place a user can get their team into the
 * engine, so a silent failure there makes the whole extension look broken.
 *
 * These specs drive it the way a person would — type, click Save, click Reset — and then check
 * the two things that actually matter: that `chrome.storage.local` changed, and that a battle
 * page already open in another tab picks the change up live.
 */
'use strict';

const { test, expect } = require('@playwright/test');
const H = require('./helpers');

let env;

test.beforeAll(async function () {
  env = await H.launchExtension();
});

test.afterAll(async function () {
  if (env) await env.close();
});

/** Open the options page and wait until it has finished loading its saved settings. */
async function openOptions() {
  const page = await env.ctx.newPage();
  const errors = [];
  page.on('pageerror', function (e) { errors.push(String(e && e.message ? e.message : e)); });
  page.on('console', function (m) { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(H.extensionUrl(env, 'options/options.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(function () {
    const s = document.getElementById('status');
    return !!s && s.textContent && s.textContent.indexOf('Loading') === -1;
  }, null, { timeout: 15000 });
  return { page: page, errors: errors };
}

test('the options page loads with the documented defaults', async function () {
  await H.clearStorage(env.sw);
  const { page, errors } = await openOptions();

  const state = await page.evaluate(function () {
    return {
      provider: document.querySelector('input[name="provider"]:checked').value,
      elo: document.getElementById('elo').value,
      eloLabel: document.getElementById('elo-value').textContent,
      key: document.getElementById('api-key').value,
      team: document.getElementById('team-text').value,
      count: document.getElementById('ro-count').textContent,
      status: document.getElementById('status').textContent,
      tr: document.getElementById('ro-tr').textContent
    };
  });

  expect(state.provider).toBe('gemini');
  expect(state.elo).toBe('1400');
  expect(state.eloLabel).toBe('1400');
  expect(state.key).toBe('');
  expect(state.team).toBe('');
  expect(state.count, 'an empty team parses to zero').toBe('0 / 6');
  expect(errors).toEqual([]);
  await page.close();
});

test('typing a team fills the readout, and Save writes it to storage', async function () {
  await H.clearStorage(env.sw);
  const { page, errors } = await openOptions();

  await page.fill('#team-text', H.TEAM);
  await page.waitForFunction(function () {
    return document.getElementById('ro-count').textContent === '6 / 6';
  }, null, { timeout: 10000 });

  const readout = await page.evaluate(function () {
    return {
      count: document.getElementById('ro-count').textContent,
      tr: document.getElementById('ro-tr').textContent,
      special: document.getElementById('ro-special').textContent,
      errorsHidden: document.getElementById('ro-errors').hidden,
      errors: Array.prototype.slice.call(document.getElementById('ro-errors').children).map(function (li) { return li.textContent; })
    };
  });
  expect(readout.count).toBe('6 / 6');
  /* Slowking-Galar, Ferrothorn and Porygon2 all carry `IVs: 0 Spe` in the fixture team. */
  expect(readout.tr, 'three 0-Spe sets are detected').toBe('3');
  expect(readout.special, 'no Mega or Z-holder in this team').toBe('0');

  /* Choose a non-default provider and Elo so the save is provably not a no-op. */
  await page.check('input[name="provider"][value="openrouter"]');
  await page.fill('#elo', '1800');
  await page.click('#save-btn');
  await page.waitForFunction(function () {
    return /saved/i.test(document.getElementById('status').textContent || '');
  }, null, { timeout: 10000 });

  const stored = await H.readStorage(env.sw, ['provider', 'elo', 'teamText']);
  expect(stored.provider).toBe('openrouter');
  expect(stored.elo).toBe(1800);
  expect(stored.teamText, 'the exact paste round-trips').toBe(H.TEAM);

  expect(errors).toEqual([]);
  await page.close();
});

test('saving from the options page reaches a battle page already open', async function () {
  await H.clearStorage(env.sw);
  const { page: battle, errors: battleErrors } = await H.openBattle(env.ctx, { setup: false });
  await H.pushLines(battle, H.BATTLE_SETUP);

  const statusOf = function () {
    return battle.evaluate(function () {
      const n = document.querySelector('[data-st-team-status]');
      return n ? n.textContent : null;
    });
  };
  const before = await statusOf();
  expect(before, 'the battle starts with no team').toMatch(/No team loaded/);

  /* Now a SECOND tab: the options page, as a user would open it from the toolbar. */
  const { page: options, errors: optionsErrors } = await openOptions();
  await options.fill('#team-text', H.TEAM);
  await options.click('#save-btn');
  await options.waitForFunction(function () {
    return /saved/i.test(document.getElementById('status').textContent || '');
  }, null, { timeout: 10000 });

  /* content.js subscribes to chrome.storage.onChanged, so the open battle must react without
   * a reload. This is the one assertion that proves the two surfaces are actually wired. */
  await battle.waitForFunction(function () {
    const n = document.querySelector('[data-st-team-status]');
    return !!n && n.textContent && n.textContent.indexOf('No team loaded') === -1;
  }, null, { timeout: 15000 });

  const after = await statusOf();
  expect(after, 'the battle page adopted the saved team').toMatch(/6\/6 confirmed/);
  expect(battleErrors).toEqual([]);
  expect(optionsErrors).toEqual([]);

  await options.close();
  await battle.close();
});

test('Reset asks first, and only then returns everything to the defaults', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { provider: 'openrouter', elo: 1900, teamText: H.TEAM });
  const { page, errors } = await openOptions();

  expect(await page.inputValue('#elo')).toBe('1900');
  expect(await page.isChecked('input[name="provider"][value="openrouter"]')).toBe(true);

  /* Reset is destructive, so it goes through window.confirm. Playwright dismisses dialogs by
   * default, which is exactly the "user changed their mind" path — and it must be a true no-op. */
  const dialogs = [];
  let answer = 'dismiss';
  page.on('dialog', function (d) {
    dialogs.push(d.message());
    return answer === 'accept' ? d.accept() : d.dismiss();
  });

  await page.click('#reset-btn');
  await page.waitForTimeout(300);
  expect(dialogs.length, 'the confirmation was shown').toBe(1);
  expect(await page.inputValue('#elo'), 'a dismissed confirm changes nothing').toBe('1900');
  expect(await page.inputValue('#team-text')).toBe(H.TEAM);
  const untouched = await H.readStorage(env.sw, ['elo', 'teamText']);
  expect(untouched.elo, 'and writes nothing to storage').toBe(1900);

  /* Now the same click, accepted. */
  answer = 'accept';
  await page.click('#reset-btn');
  await page.waitForFunction(function () {
    return document.getElementById('elo').value === '1400';
  }, null, { timeout: 10000 });

  const after = await page.evaluate(function () {
    return {
      provider: document.querySelector('input[name="provider"]:checked').value,
      team: document.getElementById('team-text').value,
      count: document.getElementById('ro-count').textContent,
      eloLabel: document.getElementById('elo-value').textContent,
      status: document.getElementById('status').textContent
    };
  });
  expect(after.provider).toBe('gemini');
  expect(after.team).toBe('');
  expect(after.count).toBe('0 / 6');
  expect(after.eloLabel).toBe('1400');
  expect(after.status).toMatch(/reset/i);

  const cleared = await H.readStorage(env.sw, ['provider', 'elo', 'teamText']);
  expect(cleared.provider).toBe('gemini');
  expect(cleared.elo).toBe(1400);
  expect(cleared.teamText).toBe('');

  expect(errors).toEqual([]);
  await page.close();
});

test('nonsense in the team box is reported, not swallowed', async function () {
  await H.clearStorage(env.sw);
  const { page, errors } = await openOptions();

  await page.fill('#team-text', 'NotAPokemon @ NotAnItem\nAbility: NotAnAbility\n- NotAMove');
  await page.waitForFunction(function () {
    const el = document.getElementById('ro-errors');
    return el && !el.hidden && el.children.length > 0;
  }, null, { timeout: 10000 });

  const state = await page.evaluate(function () {
    return {
      count: document.getElementById('ro-count').textContent,
      listed: Array.prototype.slice.call(document.getElementById('ro-errors').children).length
    };
  });
  expect(state.count, 'nothing parsed').toBe('0 / 6');
  expect(state.listed, 'and the reason is shown').toBeGreaterThan(0);
  expect(errors, 'reported through the UI, not the console').toEqual([]);
  await page.close();
});

test('the API key field can be revealed and re-hidden', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { apiKey: 'sk-test-1234' });
  const { page, errors } = await openOptions();

  expect(await page.inputValue('#api-key')).toBe('sk-test-1234');
  expect(await page.getAttribute('#api-key', 'type')).toBe('password');

  await page.click('#key-toggle');
  expect(await page.getAttribute('#api-key', 'type')).toBe('text');
  await page.click('#key-toggle');
  expect(await page.getAttribute('#api-key', 'type')).toBe('password');

  expect(errors).toEqual([]);
  await page.close();
});
