/* Showdown Tactician — tests/e2e/05-hardening.spec.js
 *
 * ADVERSARIAL PASS. 01-04 prove the extension works on the happy path. This file tries to
 * break it: the phone viewport with the real 248-line log, a burst of turns with no breathing
 * room, a team that arrives LATE, a team that never arrives, a log ten times the size of a
 * real battle, and storage pulled out from under a running battle.
 *
 * The single strongest assertion available here is `internalError`. content.js mirrors every
 * caught failure onto `documentElement.dataset.stError` precisely so it can be read across the
 * realm boundary (see BUGS_AUDIT_REPORT.md, sweep 2). If that attribute is ever non-null after
 * a hostile sequence, the extension swallowed a real defect — so every test below ends on it.
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

/** The failure signal that survives the isolated-world boundary. */
async function assertNoInternalError(page, where) {
  const snap = await H.hudSnapshot(page);
  expect(snap.internalError, 'internal error after ' + where).toBe(null);
  expect(snap.injected, 'the MAIN-world bridge must stay alive').toBe(true);
}

/* ------------------------------------------------------------------ 1. the phone */

test('the real 248-line log survives at the S24 FE viewport', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  const { page, errors } = await H.openBattle(env.ctx, { setup: false });

  await H.pushLines(page, H.REPLAY_LOG);

  const snap = await H.hudSnapshot(page);
  expect(snap.lineSeq, 'every line in the log crossed the bridge').toBe(H.REPLAY_LOG.length);
  expect(snap.counters.errors, 'the bridge reported no parse failure').toBe(0);
  expect(snap.internalError).toBe(null);
  expect(errors, 'nothing reached the page console').toEqual([]);

  /* The overlay must not have grown the page: a fixed-position HUD that widened the document
   * would let the player scroll Showdown sideways on a phone. */
  const overflow = await page.evaluate(function () {
    const de = document.documentElement;
    return { scrollW: de.scrollWidth, clientW: de.clientWidth };
  });
  expect(overflow.scrollW, 'the HUD does not create horizontal scroll').toBeLessThanOrEqual(overflow.clientW + 1);

  await page.close();
});

/* ------------------------------------------------------------------ 2. churn */

test('a burst of turns with no waiting leaves exactly one badge per button', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  const { page, errors } = await H.openBattle(env.ctx);

  /* Twelve decision windows pushed back to back. Each one re-renders the same four buttons,
   * so any per-render leak (a pushed badge, an appended node, an un-cleared style) compounds
   * here in a way a single turn cannot expose. */
  const lines = [];
  for (let t = 2; t <= 13; t++) {
    lines.push('|turn|' + t);
    lines.push(H.buildRequest({ rqid: t }));
  }
  await H.pushLines(page, lines);
  await H.waitForBadges(page, 4);

  const snap = await H.hudSnapshot(page);
  expect(snap.badgeCount, 'one badge per move button').toBe(snap.buttonCount);
  expect(snap.badgeChildren, 'no button carries a second badge').toEqual(snap.badgeChildren.map(function () { return 1; }));
  expect(snap.lineSeq).toBe(H.BATTLE_SETUP.length + lines.length);
  expect(snap.internalError).toBe(null);
  expect(errors).toEqual([]);

  await page.close();
});

/* ------------------------------------------------------------------ 3. late team */

test('a team that arrives after the first decision still lands', async function () {
  await H.clearStorage(env.sw);
  const { page, errors } = await H.openBattle(env.ctx, { setup: false });

  /* Boot the battle with NO team in storage, and open a decision window before the team
   * exists. The engine has to survive being asked a question it cannot answer. */
  await H.pushLines(page, H.BATTLE_SETUP);
  await H.pushLines(page, [H.buildRequest({ rqid: 1 })]);
  await assertNoInternalError(page, 'a decision with no team');

  const statusBefore = await page.evaluate(function () {
    const n = document.querySelector('[data-st-team-status]');
    return n ? n.textContent : null;
  });

  /* Now the options page writes the team, exactly as a user pasting a Pokepaste would. */
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  await page.waitForFunction(function () {
    const n = document.querySelector('[data-st-team-status]');
    return !!n && n.textContent && n.textContent.indexOf('Loading') === -1;
  }, null, { timeout: 15000 });

  const statusAfter = await page.evaluate(function () {
    const n = document.querySelector('[data-st-team-status]');
    return n ? n.textContent : null;
  });
  expect(statusAfter, 'the team status changed once the team arrived').not.toBe(statusBefore);
  expect(statusAfter, 'and it is not the loading placeholder').not.toMatch(/Loading team/);

  await assertNoInternalError(page, 'a late team');
  expect(errors).toEqual([]);
  await page.close();
});

/* ------------------------------------------------------------------ 4. huge log */

test('a log ten times the size of a real battle still drains', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  const { page, errors } = await H.openBattle(env.ctx, { setup: false });

  const big = [];
  for (let t = 1; t <= 400; t++) {
    big.push('|turn|' + t);
    big.push('|-damage|p2a: Landorus-Therian|' + Math.max(1, 100 - t) + '/100');
    big.push('|move|p1a: Great Tusk|Headlong Rush|p2a: Landorus-Therian');
    big.push('|-heal|p2a: Landorus-Therian|' + Math.min(100, t) + '/100|[from] item: Leftovers');
    if (t % 5 === 0) big.push('|switch|p2a: Iron Valiant|Iron Valiant, L50, F|100/100');
  }
  /* 2,001 lines. Long enough to blow past the poll cursor several times over. */
  await H.pushLines(page, big);

  const snap = await H.hudSnapshot(page);
  expect(snap.lineSeq, 'all 2,001 lines drained').toBe(big.length);
  expect(snap.counters.errors).toBe(0);
  expect(snap.internalError).toBe(null);
  expect(errors).toEqual([]);

  await page.close();
});

/* ------------------------------------------------------------------ 5. storage yanked */

test('clearing storage mid-battle does not break the HUD', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  const { page, errors } = await H.openBattle(env.ctx);
  await H.requestTurn(page, { rqid: 2 });

  const before = await H.hudSnapshot(page);
  expect(before.badgeCount, 'badges before the clear').toBeGreaterThan(0);

  await H.clearStorage(env.sw);
  await page.waitForTimeout(200);

  /* Ask again with the team gone. The HUD must still render a decision, not blank out. */
  await H.pushLines(page, ['|turn|3', H.buildRequest({ rqid: 3 })]);
  const after = await H.hudSnapshot(page);

  expect(after.badgeCount, 'a decision still renders with no stored team').toBeGreaterThan(0);
  expect(after.badgeChildren).toEqual(after.badgeChildren.map(function () { return 1; }));
  expect(after.internalError).toBe(null);
  expect(errors).toEqual([]);

  await page.close();
});

/* ------------------------------------------------------------------ 7. reconnect */

test('a second |init| in the same page starts a clean battle', async function () {
  await H.clearStorage(env.sw);
  await H.seedStorage(env.sw, { teamText: H.TEAM });
  const { page, errors } = await H.openBattle(env.ctx, { setup: false });

  await H.pushLines(page, H.BATTLE_SETUP);
  await H.requestTurn(page, { rqid: 2 });
  /* Open the drawer: [data-st-candidates] is the only surface that shows the WHOLE opponent
   * roster, and a leftover mon from the previous battle is exactly what it would reveal. */
  await page.click('.team-drawer-toggle');
  const first = await H.hudSnapshot(page);
  expect(first.banner, 'battle 1 reads the first opponent').toContain('Landorus-Therian');
  expect(first.candidates, 'and the drawer lists the whole roster').toContain('Landorus-Therian');
  expect(first.candidates, 'and only the roster').toContain('Iron Valiant');

  /* The reconnect: Showdown re-sends `|init|` and then the whole log from turn 1. */
  await H.pushLines(page, [
    '|init|[Gen 9] National Dex',
    '|player|p1|Me|1|1550',
    '|player|p2|Foe|2|1480',
    '|teamsize|p1|6',
    '|teamsize|p2|6',
    '|gametype|singles',
    '|gen|9',
    '|tier|[Gen 9] National Dex OU',
    '|clearpoke',
    '|poke|p1|Great Tusk, L50, M|item',
    '|poke|p2|Kingambit, L50, M|item',
    '|start',
    '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
    '|switch|p2a: Kingambit|Kingambit, L50, M|100/100',
    '|turn|1'
  ]);
  await H.requestTurn(page, { rqid: 3 });
  const second = await H.hudSnapshot(page);

  expect(second.banner, 'battle 2 reads the new opponent').toContain('Kingambit');
  expect(second.candidates, 'and the drawer lists only the new roster').toContain('Kingambit');
  expect(second.candidates, 'the previous game\'s opponents are gone')
    .not.toMatch(/Landorus-Therian|Iron Valiant/);
  expect(second.banner, 'and the previous game\'s opponent is gone').not.toContain('Landorus-Therian');
  expect(second.badgeCount, 'the HUD still decorates the new turn').toBe(second.buttonCount);
  expect(second.internalError).toBe(null);
  expect(errors).toEqual([]);
  await page.close();
});


/* ------------------------------------------------------------------ 6. no team, ever */

test('with no team at all the extension degrades quietly', async function () {
  await H.clearStorage(env.sw);
  const { page, errors } = await H.openBattle(env.ctx);
  await H.pushLines(page, [H.buildRequest({ rqid: 2 })]);
  await page.waitForTimeout(300);

  const snap = await H.hudSnapshot(page);
  /* Either it answers or it declines, but it must not throw and must not leave a half-drawn
   * badge (a node with no text) on a button. */
  for (let i = 0; i < snap.badges.length; i++) {
    if (snap.badges[i].text !== null) {
      expect(String(snap.badges[i].text).length, 'a rendered badge has text').toBeGreaterThan(0);
    }
  }
  expect(snap.internalError).toBe(null);
  expect(errors).toEqual([]);
  await page.close();
});
