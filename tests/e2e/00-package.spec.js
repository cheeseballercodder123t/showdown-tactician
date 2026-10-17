/* Showdown Tactician — tests/e2e/00-package.spec.js
 *
 * THE INSTALL, TESTED AS AN INSTALL. Every other spec side-loads the repository root, which is how a
 * developer runs it. A user does something slightly different and less forgiving: they take the
 * FOLDER the project hands them, point Chrome's "Load unpacked" at it, and if the manifest is not
 * exactly what Chromium expects the extension never appears — Chrome reports it as "Manifest file is
 * missing or unreadable" and nothing else runs.
 *
 * So this spec builds the packaged Chrome folder into a temp directory and boots the extension FROM
 * IT: the service worker has to register, and the options page has to open. The Node suite pins the
 * manifest's shape; this pins the only claim a shape cannot make, that Chromium actually loads it.
 *
 * Numbers: boots one browser (about 1.5 s) and writes a throwaway copy of the tree.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const H = require('./helpers');
const B = require('../../tools/build_extension.js');

let env = null;
let outDir = null;

test.beforeAll(async function () {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-package-'));
  const built = B.build({ out: outDir });
  expect(built.problems).toEqual([]);
  env = await H.launchExtension({ dir: path.join(outDir, 'chrome') });
});

test.afterAll(async function () {
  if (env) await env.close();
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

test('the packaged Chrome folder loads, and its service worker registers', async function () {
  expect(env.sw.url()).toContain('chrome-extension://');
  expect(env.sw.url()).toContain('src/background.js');
  const alive = await env.sw.evaluate(function () {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.storage;
  });
  expect(alive).toBe(true);
});

test('the packaged folder carries everything the content scripts need', async function () {
  /* Every listed file is checked by the Node suite, but "listed in the manifest" and "present in
   * the packaged folder" are different claims: the build COPIES the tree, so this is the one check
   * that the copy happened. */
  const chromeDir = path.join(outDir, 'chrome');
  const manifest = JSON.parse(fs.readFileSync(path.join(chromeDir, 'manifest.json'), 'utf8'));
  const missing = [];
  for (const entry of manifest.content_scripts) {
    for (const rel of (entry.js || []).concat(entry.css || [])) {
      if (!fs.existsSync(path.join(chromeDir, rel))) missing.push(rel);
    }
  }
  if (manifest.background && manifest.background.service_worker) {
    if (!fs.existsSync(path.join(chromeDir, manifest.background.service_worker))) {
      missing.push(manifest.background.service_worker);
    }
  }
  if (!fs.existsSync(path.join(chromeDir, manifest.options_ui.page))) missing.push(manifest.options_ui.page);
  expect(missing).toEqual([]);
});

test('the options page opens from the packaged folder', async function () {
  const id = new URL(env.sw.url()).host;
  const page = await env.ctx.newPage();
  const response = await page.goto('chrome-extension://' + id + '/options/options.html');
  expect(response.status()).toBe(200);
  await expect(page.locator('textarea').first()).toBeVisible();
  const title = await page.title();
  expect(title).toContain('Showdown Tactician');
  await page.close();
});
