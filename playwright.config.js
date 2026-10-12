/* Showdown Tactician — playwright.config.js
 *
 * The real-browser end-to-end suite. Deliberately SEPARATE from `npm test`: the Node suites are
 * zero-dependency and run in ~30 s, while this one drives a real Chromium with the extension
 * loaded and is therefore the slow gate. `npm test` must never depend on a browser download.
 *
 * workers: 1 and fullyParallel: false are not tuning knobs — each worker launches its own
 * persistent Chromium with the extension side-loaded, and running two at once makes the
 * timing-sensitive assertions (the 250 ms poll, the 2.5 s heartbeat) flaky for no gain.
 */
'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  timeout: 120000,
  expect: { timeout: 20000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: {
    trace: 'off',
    video: 'off',
    screenshot: 'off'
  }
});
