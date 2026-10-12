/* Showdown Tactician — tests/e2e/01-boot.spec.js
 *
 * Does the extension actually work in a browser? Nothing before this suite ever checked.
 * The Node suites import the classes straight out of a vm sandbox, which proves the LOGIC but
 * not the SHIP: manifest integrity, the realm crossing into the MAIN world,
 * web_accessible_resources, host matching, and the auto-start guard only exist in real Chromium.
 */
'use strict';

const fs = require('fs');
const path = require('path');
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

test('the MV3 service worker registers', async function () {
  expect(env.sw.url()).toContain('chrome-extension://');
  expect(env.sw.url()).toContain('src/background.js');
  const alive = await env.sw.evaluate(function () {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.storage;
  });
  expect(alive).toBe(true);
});

test('every file the manifest ships actually exists', async function () {
  /* A manifest is a list of paths with no compile step behind it: rename a file, or add one to
   * MANIFEST_ORDER and forget the manifest, and the extension still LOADS — it just silently
   * runs without that module, because every script is an IIFE that guards its own dependencies.
   * That is the exact failure this asserts against. */
  const manifest = JSON.parse(fs.readFileSync(path.join(H.ROOT, 'manifest.json'), 'utf8'));
  const missing = [];

  for (const entry of manifest.content_scripts) {
    for (const rel of (entry.js || []).concat(entry.css || [])) {
      if (!fs.existsSync(path.join(H.ROOT, rel))) missing.push(rel);
    }
  }
  for (const entry of manifest.web_accessible_resources || []) {
    for (const rel of entry.resources || []) {
      if (!fs.existsSync(path.join(H.ROOT, rel))) missing.push(rel);
    }
  }
  if (manifest.background && manifest.background.service_worker) {
    if (!fs.existsSync(path.join(H.ROOT, manifest.background.service_worker))) {
      missing.push(manifest.background.service_worker);
    }
  }
  if (manifest.options_ui && manifest.options_ui.page) {
    if (!fs.existsSync(path.join(H.ROOT, manifest.options_ui.page))) missing.push(manifest.options_ui.page);
  }

  expect(missing, 'manifest references files that do not exist').toEqual([]);

  /* And the load order has to agree with the Node harness, or the two suites describe
   * different programs. */
  const harness = fs.readFileSync(path.join(H.ROOT, 'tests', 'harness.js'), 'utf8');
  const orderBlock = harness.slice(harness.indexOf('MANIFEST_ORDER = ['), harness.indexOf('];', harness.indexOf('MANIFEST_ORDER = [')));
  const harnessOrder = orderBlock.match(/'([^']+)'/g).map(function (s) { return s.slice(1, -1); });
  expect(harnessOrder).toEqual(manifest.content_scripts[0].js);
});

test('the content script boots on the real origin and the bridge crosses into the MAIN world', async function () {
  const { page } = await H.openBattle(env.ctx);
  const snap = await H.hudSnapshot(page);

  expect(snap.injectedAttr).toBe('1');
  expect(snap.injected).toBe(true);
  expect(snap.counters).not.toBeNull();

  const realm = await page.evaluate(function () {
    return {
      wsWrapped: !!(window.WebSocket && window.WebSocket.__stWrapped),
      /* The content script's world must stay invisible to the page. If window.ST were reachable
       * here the extension would be running in the MAIN world, which is both a security bug and
       * a correctness one (the page could clobber it). */
      stVisible: typeof window.ST !== 'undefined',
      bootVisible: typeof window.__ST_BOOT__ !== 'undefined'
    };
  });
  expect(realm.wsWrapped, 'injected.js must wrap WebSocket to capture outgoing frames').toBe(true);
  expect(realm.stVisible).toBe(false);
  expect(realm.bootVisible).toBe(false);

  await page.close();
});

test('the bridge forwards a real protocol line across the realm boundary', async function () {
  const { page, errors } = await H.openBattle(env.ctx);
  await H.waitForDrain(page);
  const snap = await H.hudSnapshot(page);

  expect(snap.lineSeq).toBeGreaterThanOrEqual(H.BATTLE_SETUP.length);
  expect(snap.lastLine).toBe(H.BATTLE_SETUP[H.BATTLE_SETUP.length - 1]);
  expect(snap.internalErrorCount, 'the pipeline must record no internal error: ' + snap.internalError).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
});

test('the HUD renders the opponent readout from the real log', async function () {
  const { page } = await H.openBattle(env.ctx);
  await H.waitForDrain(page);
  const snap = await H.hudSnapshot(page);

  /* The banner only exists if ui_overlay.js loaded, the parser understood the log, the state
   * manager built the opponent, and the pruner produced a candidate set. One assertion, five
   * modules. */
  expect(snap.banner).toBeTruthy();
  expect(snap.banner).toContain('Landorus-Therian');
  await page.close();
});

test('the content script does NOT run on a non-matching origin', async function () {
  const page = await env.ctx.newPage();
  await page.route('https://example.com/**', function (route) {
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>elsewhere</body></html>' });
  });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const present = await page.evaluate(function () {
    return {
      injected: window.__ST_INJECTED__ === true,
      attr: document.documentElement.getAttribute('data-st-injected'),
      badges: document.querySelectorAll('.elo-helper-badge').length
    };
  });
  expect(present.injected).toBe(false);
  expect(present.attr).toBeNull();
  expect(present.badges).toBe(0);
  await page.close();
});
