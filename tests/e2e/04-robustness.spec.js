/* Showdown Tactician — tests/e2e/04-robustness.spec.js
 *
 * The extension's own contract, from ui_overlay.js's header: "Every entry point is defensive:
 * a missing document, a missing Showdown control bar, an empty ranked array or a null
 * battleState is a no-op, never a throw." And from content.js: the boot must "never break the
 * page".
 *
 * The Node suites assert that against stub objects they control. A real page is the only place
 * the claim meets things it did not choose: Showdown's own rebuilds, a room that has not loaded,
 * a log that is not an array. A throw here does not merely fail a feature — it lands in the
 * player's console and, for the MAIN-world bridge, can take Showdown's own socket handling down
 * with it.
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

async function fresh() {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  return H.openBattle(env.ctx);
}

test('a page with no move buttons at all is a no-op', async function () {
  const { page, errors } = await fresh();

  await page.evaluate(function () {
    const menu = document.getElementById('movemenu');
    while (menu.firstChild) menu.removeChild(menu.firstChild);
  });
  /* pushLines, not requestTurn: requestTurn waits for a badge to appear, and the whole point
   * here is that there is nothing to decorate. */
  await H.pushLines(page, [H.buildRequest({ rqid: 2 })]);
  const snap = await H.hudSnapshot(page);

  expect(snap.buttonCount).toBe(0);
  expect(snap.badgeCount).toBe(0);
  expect(snap.internalErrorCount, snap.internalError).toBe(0);
  expect(errors).toEqual([]);

  /* And when the bar comes back, the next turn decorates it. */
  await page.evaluate(function () { window.__mock.renderMenu(window.__mock.defaultMoves); });
  await H.pushLines(page, ['|turn|3', H.buildRequest({ rqid: 3 })]);
  await H.waitForBadges(page, 4);
  expect((await H.hudSnapshot(page)).badgeCount).toBe(4);
  await page.close();
});

test('a room that has not loaded is a no-op', async function () {
  const { page, errors } = await fresh();

  /* A spectator tab, or the moment between navigation and the battle object existing. */
  await page.evaluate(function () { window.__app = window.app; window.app = null; });
  await H.waitForDrain(page);
  await page.evaluate(function () { window.__mock.logLines(['|turn|9', '|move|p1a: Great Tusk|Rapid Spin|p2a: Landorus-Therian']); });
  await page.waitForTimeout(600);

  const snap = await H.hudSnapshot(page);
  expect(snap.counters.errors).toBe(0);
  expect(errors).toEqual([]);

  /* Restoring the room must resume the pipeline without a reload. */
  await page.evaluate(function () { window.app = window.__app; });
  await H.pushLines(page, ['|turn|10', H.buildRequest({ rqid: 10 })]);
  await H.waitForBadges(page, 4);
  expect((await H.hudSnapshot(page)).internalErrorCount).toBe(0);
  await page.close();
});

test('a malformed battle object is a no-op', async function () {
  const { page, errors } = await fresh();

  const shapes = [
    { log: 'not an array' },
    { log: null },
    { log: [] },
    {}
  ];
  for (const shape of shapes) {
    await page.evaluate(function (s) { window.app = { curRoom: { battle: s } }; }, shape);
    await page.evaluate(function () { window.__ST_INJECTED_FLUSH(); });
  }

  const snap = await H.hudSnapshot(page);
  expect(snap.counters.errors).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
});

test('hostile protocol lines never throw and never reach the page console', async function () {
  const { page, errors } = await fresh();
  await H.waitForDrain(page);

  /* Every shape a stream can actually produce when something upstream is broken, plus the
   * classic injection probes: the parser is fed attacker-controlled text from a third-party
   * server, so a throw here is a denial of service on the player's HUD. */
  await H.pushLines(page, [
    '|||garbage|||',
    '|request|{not json',
    '|request|',
    '|request|[]',
    '|request|{"active":"not an array"}',
    '|switch|p2a: Not A Real Pokemon, L50, M|100/100',
    '|switch|p2a: <img src=x onerror=alert(1)>|100/100',
    '|-damage|p1a: Great Tusk|not-a-number',
    '|-damage|p1a: Great Tusk|-5/100',
    '|-boost|p1a: Great Tusk|atk|999',
    '|-setboost|p1a: Great Tusk|atk|abc',
    '|move|p1a: Great Tusk|',
    '|move|||',
    '|poke|p2|' + 'A'.repeat(4000) + ', L50, M|item',
    '|c|' + '<script>alert(1)</script>',
    '|t:|not a timestamp',
    '|turn|NaN',
    '|turn|-1',
    '|win|',
    '|win|' + 'x'.repeat(3000)
  ]);

  const snap = await H.hudSnapshot(page);
  expect(snap.internalErrorCount, 'internal: ' + snap.internalError).toBe(0);
  expect(snap.counters.errors, 'bridge').toBe(0);
  expect(errors).toEqual([]);

  /* The HUD must not have been turned into a script host either. */
  const injectedHtml = await page.evaluate(function () {
    return document.querySelectorAll('script').length;
  });
  expect(injectedHtml).toBe(1);   // the fixture's own inline script, and nothing else
  await page.close();
});

test('re-injecting the MAIN-world bridge is a no-op', async function () {
  const { page, errors } = await fresh();
  await H.requestTurn(page, { rqid: 2 });
  const before = await H.hudSnapshot(page);

  /* content.js guards this with data-st-injected, but a second script tag is exactly what a
   * page reload or a double-injecting extension host would produce. injected.js guards itself
   * too; this asserts the guard rather than trusting it. */
  const bridgeUrl = await env.sw.evaluate(function () {
    return chrome.runtime.getURL('src/injected.js');
  });
  await page.evaluate(function (url) {
    const s = document.createElement('script');
    s.src = url;
    document.head.appendChild(s);
  }, bridgeUrl);
  await page.waitForTimeout(500);
  await H.pushLines(page, ['|turn|3', H.buildRequest({ rqid: 3 })]);
  const after = await H.hudSnapshot(page);

  expect(after.badgeCount).toBe(4);
  expect(after.badgeChildren).toEqual([1, 1, 1, 1]);
  expect(after.internalErrorCount, after.internalError).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
});

test('the HUD survives a control-bar rebuild mid-turn', async function () {
  const { page, errors } = await fresh();
  await H.requestTurn(page, { rqid: 2 });

  /* Showdown rebuilds its control bar while the engine is thinking. The 2.5 s heartbeat
   * re-runs the non-decision chrome; the next request must land on the NEW nodes. */
  await page.evaluate(function () { window.__mock.rebuildControlBar(); });
  await page.waitForTimeout(2800);
  const mid = await H.hudSnapshot(page);
  expect(mid.banner, 'the banner survives a rebuild').toBeTruthy();
  expect(mid.internalErrorCount, mid.internalError).toBe(0);

  await H.pushLines(page, ['|turn|3', H.buildRequest({ rqid: 3 })]);
  await H.waitForBadges(page, 4);
  const after = await H.hudSnapshot(page);
  expect(after.badgeCount).toBe(4);
  expect(after.badgeChildren).toEqual([1, 1, 1, 1]);
  expect(errors).toEqual([]);
  await page.close();
});
