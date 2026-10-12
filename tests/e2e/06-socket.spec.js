/* Showdown Tactician — tests/e2e/06-socket.spec.js
 *
 * The socket capture in src/injected.js had only ever been tested against a hand-written fake
 * WebSocket (tests/injected_bridge.js). That proves the logic, but not that Chromium lets us
 * replace `WebSocket.prototype.onmessage` with an accessor, nor that a real socket still opens,
 * sends and receives once we have. This spec closes that gap with Playwright's WebSocket
 * routing: a genuine browser socket, a mocked server, and the extension sitting in the middle.
 *
 * The stakes are high: if the onmessage accessor delegation were wrong, Showdown's own handler
 * would be detached and the battle would freeze for the player while our copy kept working.
 * So the assertion is not "did we see the frame" — it is "did WE see it AND did the PAGE still
 * see it".
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

test('the page keeps working while the extension taps its socket', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });

  const FRAME = '|turn|1\n|-damage|p1a: Great Tusk|50/100\n|move|p2a: Landorus-Therian|Earthquake|p1a: Great Tusk';

  const { page, errors } = await H.openBattle(env.ctx, {
    onPage: async function (p) {
      await p.routeWebSocket('**/showdown/websocket', function (ws) {
        ws.onMessage(function () { /* nothing the client sends interests us here */ });
        ws.send(FRAME);
      });
    }
  });

  /* Baseline before the socket exists, so the delta below is attributable to the frame and
   * nothing else — the setup replay has already pushed 17 lines through the bridge. */
  const before = await H.hudSnapshot(page);

  /* Open a REAL socket from the page. The extension wrapped the constructor at load time, so
   * this instance is patched on construction. */
  await page.evaluate(function () {
    window.__mock.openSocket('wss://sim.smogon.com/showdown/websocket');
  });

  /* Wait for the mocked server's frame to reach the page's own handler. */
  await page.waitForFunction(function () {
    return (window.__mock.socketReceived || []).length > 0;
  }, null, { timeout: 15000 });

  const state = await page.evaluate(function () {
    return window.__mock.socketState();
  });

  /* 1. The page is unharmed. */
  expect(state.present, 'the page has a socket').toBe(true);
  expect(state.nativeProto, 'and it is still a genuine WebSocket').toBe(true);
  expect(state.patched, 'which the extension patched on construction').toBe(true);
  expect(state.constructorWrapped, 'the constructor is wrapped').toBe(true);
  expect(state.received[0], 'Showdown still receives its own frame verbatim').toBe(FRAME);

  /* 2. The extension saw the same frame, split into protocol lines. */
  const snap = await H.hudSnapshot(page);
  expect(snap.lastLineKind, 'the last forwarded line came from the socket').toBe('recv');
  expect(snap.lineSeq - before.lineSeq, 'all three protocol lines in the frame were forwarded').toBe(3);
  expect(snap.counters.received - before.counters.received, 'the capture counted the frame once').toBe(1);
  expect(snap.counters.errors, 'the capture raised nothing').toBe(0);
  expect(snap.internalError).toBe(null);

  /* 3. Outgoing frames still leave the page, and the extension still sees them. */
  await page.evaluate(function () {
    window.__mock.socketSend('/choose move 1');
  });
  await page.waitForFunction(function () {
    return document.documentElement.dataset.stLineKind === 'send';
  }, null, { timeout: 10000 });
  const afterSend = await H.hudSnapshot(page);
  expect(afterSend.lastLine, 'the outgoing frame was mirrored').toBe('/choose move 1');
  expect(afterSend.counters.sent - before.counters.sent, 'and counted once').toBe(1);

  expect(errors, 'nothing reached the page console').toEqual([]);
  await page.close();
});

test('a socket frame that Showdown then writes to the log is delivered once', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });

  const LINE = '|move|p2a: Landorus-Therian|Earthquake|p1a: Great Tusk';
  const { page, errors } = await H.openBattle(env.ctx, {
    onPage: async function (p) {
      await p.routeWebSocket('**/showdown/websocket', function (ws) {
        ws.onMessage(function () { });
        ws.send(LINE);
      });
    }
  });

  await page.evaluate(function () {
    window.__mock.openSocket('wss://sim.smogon.com/showdown/websocket');
  });

  /* Order matters and is the whole test. Showdown appends the line to battle.log at the same
   * moment it arrives over the socket, so:
   *   1. the socket delivers it      -> forwarded, lastForwarded = { LINE, 'recv' }
   *   2. the log gains the same line -> the poll must recognise it as already delivered
   * Doing it the other way round (log first) would let the poll win the race and the check
   * would pass without ever exercising the dedupe. */
  await page.waitForFunction(function () {
    return (window.__mock.socketReceived || []).length > 0;
  }, null, { timeout: 15000 });
  const delivered = await H.hudSnapshot(page);
  expect(delivered.lastLine, 'the socket delivered the line').toBe(LINE);

  await page.evaluate(function (line) {
    window.__mock.logLine(line);
  }, LINE);

  /* Several poll cycles by hand. A broken dedupe re-delivers the line every time. */
  for (let i = 0; i < 4; i++) await H.waitForDrain(page);
  const after = await H.hudSnapshot(page);

  expect(after.lineSeq, 'the poll did not re-deliver it').toBe(delivered.lineSeq);
  expect(after.counters.polled, 'and the poll forwarded nothing at all').toBe(delivered.counters.polled);

  /* ...but the poll is still alive: a genuinely new line must get through. */
  await page.evaluate(function () {
    window.__mock.logLine('|turn|4');
  });
  await H.waitForDrain(page);
  const resumed = await H.hudSnapshot(page);
  expect(resumed.lineSeq, 'the poll resumed on the next new line').toBe(delivered.lineSeq + 1);
  expect(resumed.counters.polled - after.counters.polled, 'and counted exactly one').toBe(1);

  expect(resumed.internalError).toBe(null);
  expect(errors).toEqual([]);
  await page.close();
});
