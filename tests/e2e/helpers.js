/* Showdown Tactician — tests/e2e/helpers.js
 *
 * Shared plumbing for the real-browser end-to-end suite.
 *
 * WHY THIS EXISTS. Every other suite in tests/ runs against a DOM-less vm sandbox or a stub
 * DOM. Nothing had ever proved the extension works in an actual Chromium page: that the
 * manifest loads, that the MAIN-world bridge really crosses the realm boundary, that the HUD
 * really decorates Showdown's own buttons, and that a real 248-line battle log survives the
 * trip. This module owns exactly that, and nothing else.
 *
 * The page under test is served by INTERCEPTING https://play.pokemonshowdown.com/ rather than
 * by hitting the network. The hostname is what the content script matches on, so the URL has
 * to stay real while the bytes come from a fixture — that is the whole trick.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'showdown.html'), 'utf8');
const REPLAY_LOG = fs.readFileSync(path.join(ROOT, 'test_log.txt'), 'utf8')
  .split('\n')
  .map(function (l) { return l.replace(/\r$/, ''); })
  .filter(function (l) { return l.length > 0; });

/* The paste the Node suite already uses, so the two suites describe the same team. */
const TEAM = [
  'Great Tusk @ Choice Scarf',
  'Ability: Protosynthesis',
  'Level: 100',
  'EVs: 252 Atk / 4 SpD / 252 Spe',
  'Jolly Nature',
  '- Headlong Rush',
  '- Close Combat',
  '- Ice Spinner',
  '- Rapid Spin',
  '',
  'Slowking-Galar @ Assault Vest',
  'Ability: Regenerator',
  'EVs: 252 HP / 4 SpA / 252 SpD',
  'Sassy Nature',
  'IVs: 0 Spe',
  '- Future Sight',
  '- Scald',
  '- Sludge Bomb',
  '- Flamethrower',
  '',
  'Ferrothorn @ Leftovers',
  'Ability: Iron Barbs',
  'EVs: 252 HP / 88 Def / 168 SpD',
  'Relaxed Nature',
  'IVs: 0 Spe',
  '- Stealth Rock',
  '- Leech Seed',
  '- Power Whip',
  '- Protect',
  '',
  'Iron Valiant @ Booster Energy',
  'Ability: Quark Drive',
  'EVs: 4 HP / 252 SpA / 252 Spe',
  'Timid Nature',
  '- Moonblast',
  '- Thunderbolt',
  '- Psyshock',
  '- Calm Mind',
  '',
  'Landorus-Therian @ Rocky Helmet',
  'Ability: Intimidate',
  'EVs: 252 HP / 252 Def / 4 SpD',
  'Impish Nature',
  '- Earthquake',
  '- U-turn',
  '- Stealth Rock',
  '- Taunt',
  '',
  'Porygon2 @ Eviolite',
  'Ability: Trace',
  'EVs: 252 HP / 252 SpD / 4 SpA',
  'Sassy Nature',
  'IVs: 0 Spe',
  '- Trick Room',
  '- Ice Beam',
  '- Recover',
  '- Thunder Wave'
].join('\n');

const BATTLE_SETUP = [
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
  '|poke|p2|Iron Valiant, L50, F|item',
  '|poke|p2|Landorus-Therian, L50, M|item',
  '|teampreview',
  '|start',
  '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100',
  '|switch|p2a: Landorus-Therian|Landorus-Therian, L50, M|100/100',
  '|turn|1'
];

/** A `|request|` frame shaped exactly like the server's, for OUR side only. */
function buildRequest(opts) {
  opts = opts || {};
  const moves = (opts.moves || [
    ['headlongrush', 'Headlong Rush', 16, 16],
    ['closecombat', 'Close Combat', 8, 8],
    ['icespinner', 'Ice Spinner', 32, 32],
    ['rapidspin', 'Rapid Spin', 64, 64]
  ]).map(function (m) {
    return { move: m[1], id: m[0], pp: m[2], maxpp: m[3], target: 'normal', disabled: false };
  });
  return '|request|' + JSON.stringify({
    side: {
      id: 'p1',
      name: 'Me',
      pokemon: [{
        ident: 'p1: ' + (opts.species || 'Great Tusk'),
        details: (opts.species || 'Great Tusk') + ', L50, M',
        condition: opts.condition || '100/100',
        active: true,
        moves: moves.map(function (m) { return m.id; }),
        stats: opts.stats || { atk: 300, def: 200, spa: 100, spd: 200, spe: 300 }
      }]
    },
    active: [{ moves: moves }],
    rqid: opts.rqid || 1
  });
}

/* ------------------------------------------------------------------ launch */

/**
 * Launch a persistent Chromium with this extension loaded.
 * Returns { ctx, sw, close }.
 */
async function launchExtension(opts) {
  opts = opts || {};
  const args = [
    '--disable-extensions-except=' + ROOT,
    '--load-extension=' + ROOT
  ];
  /* GitHub's Linux runners cannot use the Chromium sandbox (no usable user namespaces), and
   * `--headless=new` still refuses to start without it. Only added on CI so a local run keeps
   * the sandbox. */
  if (process.env.CI) args.push('--no-sandbox', '--disable-dev-shm-usage');

  const ctx = await chromium.launchPersistentContext('', {
    headless: opts.headless !== false,
    channel: 'chromium',
    viewport: opts.viewport || { width: 412, height: 915 },
    deviceScaleFactor: opts.deviceScaleFactor || 2.625,
    args: args
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  return {
    ctx: ctx,
    sw: sw,
    close: function () { return ctx.close(); }
  };
}

/** Write the team into chrome.storage.local the way the options page does. */
async function seedStorage(sw, values) {  await sw.evaluate(function (v) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(v, function () { resolve(true); });
    });
  }, values);
}

/** Clear everything the extension persists, so one spec cannot leak into the next. */
async function clearStorage(sw) {
  await sw.evaluate(function () {
    return new Promise(function (resolve) {
      chrome.storage.local.clear(function () { resolve(true); });
    });
  });
}

/**
 * Read `chrome.storage.local` back out of the service worker. Used to prove that a save from
 * the OPTIONS PAGE really reached the store the content script reads, rather than only the
 * page's own in-memory form state.
 */
async function readStorage(sw, keys) {
  return sw.evaluate(function (k) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(k, function (v) { resolve(v); });
    });
  }, keys);
}

/** The chrome-extension:// URL for a file shipped by the loaded extension.
 *  `chrome-extension:` is not a "special" scheme, so Node's URL parser reports `.origin` as the
 *  string "null" for it — the extension id has to be taken out of the raw URL instead. */
function extensionUrl(env, file) {
  const id = String(env.sw.url()).replace(/^chrome-extension:\/\//, '').split('/')[0];
  if (!id) throw new Error('could not read the extension id from ' + env.sw.url());
  return 'chrome-extension://' + id + '/' + String(file).replace(/^\//, '');
}

/**
 * Open the fixture page at the real Showdown origin and wait for the content script to boot.
 * Returns { page, errors, warnings } — errors collects uncaught page errors and console.error.
 *
 * OBSERVABILITY CONTRACT (learned the hard way — see BUGS_AUDIT_REPORT.md, sweep 2).
 * A content script runs in an ISOLATED world: `page.evaluate` sees the page's MAIN world only,
 * so `window.ST` and `window.__ST_BOOT__` are `undefined` from a test. Everything asserted here
 * therefore has to be either
 *   (a) shared DOM   — the HUD nodes, `data-st-*` attributes, `documentElement.dataset.stLine`
 *   (b) MAIN world   — `window.__ST_INJECTED__` and its counters, set by src/injected.js, or
 *   (c) the network/console stream Playwright already taps.
 * That is not a workaround: the shared DOM is precisely what a player sees, so asserting on it
 * is a stronger end-to-end statement than reading an internal counter would be.
 */
async function openBattle(ctx, opts) {
  opts = opts || {};
  const page = await ctx.newPage();
  const errors = [];
  const warnings = [];

  page.on('pageerror', function (err) {
    errors.push('pageerror: ' + (err && err.message ? err.message : String(err)));
  });
  page.on('console', function (msg) {
    const text = msg.text();
    if (msg.type() === 'error') errors.push('console.error: ' + text);
    else if (msg.type() === 'warning') warnings.push(text);
  });

  await page.route('https://play.pokemonshowdown.com/**', function (route) {
    const req = route.request();
    if (req.resourceType() === 'document' || /\.html?($|\?)/.test(req.url())) {
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FIXTURE_HTML });
    } else {
      route.fulfill({ status: 404, contentType: 'text/plain', body: 'not in the fixture' });
    }
  });

  /* A hook for specs that need to install their own routing (e.g. page.routeWebSocket) BEFORE
   * the page navigates. It runs after the page exists and before goto, and nowhere else. */
  if (typeof opts.onPage === 'function') await opts.onPage(page);

  /* Seed the PAGE's localStorage before the content script reads it. The HUD persists its
   * layout mode there as well as in chrome.storage, so a spec that assumes the default has
   * to be able to say so before navigation — otherwise a spec that ran earlier and toggled
   * the mode would leak its choice into the next one through localStorage (which lives on
   * the page origin, not in chrome.storage, so clearStorage does not reach it). */
  if (opts.initLocal && typeof page.addInitScript === 'function') {
    await page.addInitScript(function (seed) {
      try {
        Object.keys(seed).forEach(function (k) { window.localStorage.setItem(k, seed[k]); });
      } catch (e) { /* storage may be unavailable */ }
    }, opts.initLocal);
  }

  await page.goto('https://play.pokemonshowdown.com/battle-gen9nationaldexou-1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(function () {
    return document.documentElement.getAttribute('data-st-injected') === '1' &&
           window.__ST_INJECTED__ === true;
  }, null, { timeout: 20000 });
  if (opts.setup !== false) {
    await page.evaluate(function (lines) {
      window.__mock.logLines(lines);
      window.__ST_INJECTED_FLUSH();
    }, opts.setup || BATTLE_SETUP);
  }
  return { page: page, errors: errors, warnings: warnings };
}

/* ------------------------------------------------------------------ polling */

/**
 * Hand the page some protocol lines and wait until the extension has PROCESSED all of them.
 *
 * This is exact rather than timed, and the reason is worth writing down: src/injected.js
 * forwards with `document.dispatchEvent`, which is SYNCHRONOUS — the content script's listener
 * runs to completion inside that call. So calling the bridge's own flush hook and returning
 * from evaluate() is a guarantee that every line has been through the parser, the state manager
 * and the engine. Waiting on the 250 ms poll instead would make every assertion a race.
 */
async function pushLines(page, lines) {
  await page.evaluate(function (l) {
    window.__mock.logLines(l);
    window.__ST_INJECTED_FLUSH();
  }, lines);
}

/** Force one poll cycle and return once the extension has caught up with the log. */
async function waitForDrain(page) {
  await page.evaluate(function () {
    window.__ST_INJECTED_FLUSH();
  });
}

/** Wait until at least `n` move buttons carry a confidence badge. */
async function waitForBadges(page, n, timeout) {
  await page.waitForFunction(function (want) {
    return document.querySelectorAll('button[data-move] .elo-helper-badge').length >= want;
  }, n || 1, { timeout: timeout || 20000 });
}

/**
 * Push a `|request|` frame and wait for the HUD to decorate the move buttons.
 * `|request|` is the ONLY protocol line that opens a decision window, so it is the only thing
 * that makes the engine run — a replay log has none, which is why the fixture synthesises them.
 */
async function requestTurn(page, opts) {
  await pushLines(page, [buildRequest(opts)]);
  await waitForBadges(page, 1);
  return hudSnapshot(page);
}

/** Snapshot the HUD a player would see. Everything here lives in the shared DOM. */
async function hudSnapshot(page) {
  return page.evaluate(function () {
    const buttons = Array.prototype.slice.call(document.querySelectorAll('button[data-move]'));
    const el = document.documentElement;
    return {
      badgeCount: document.querySelectorAll('button[data-move] .elo-helper-badge').length,
      /* Badges per button, so a duplicated badge (a re-render that appended instead of
       * reusing) shows up as a 2 rather than being averaged away by the total. */
      badgeChildren: buttons.map(function (b) {
        return b.querySelectorAll('.elo-helper-badge').length;
      }),
      buttonCount: buttons.length,
      buttons: buttons.map(function (b) {
        return {
          move: b.getAttribute('data-move'),
          label: (b.textContent || '').trim(),
          opacity: b.style.opacity,
          textDecoration: b.style.textDecoration,
          position: b.style.position,
          classes: Array.prototype.slice.call(b.classList)
        };
      }),
      badges: buttons.map(function (b) {
        const badge = b.querySelector('.elo-helper-badge');
        return {
          move: b.getAttribute('data-move'),
          text: badge ? badge.textContent : null,
          title: badge ? badge.getAttribute('title') : null,
          buttonClasses: Array.prototype.slice.call(b.classList),
          badgeClasses: badge ? Array.prototype.slice.call(badge.classList) : []
        };
      }),
      banner: (function () {
        const n = document.querySelector('[data-st-banner]');
        return n ? n.textContent : null;
      })(),
      bannerAttrs: (function () {
        const n = document.querySelector('[data-st-banner]');
        return n ? Array.prototype.slice.call(n.attributes).map(function (a) { return a.name + '=' + a.value; }) : null;
      })(),
      trChip: (function () {
        const n = document.querySelector('[data-st-tr-chip]');
        return n ? n.textContent : null;
      })(),
      reasonNodes: document.querySelectorAll('.elo-helper-reason').length,
      /* The drawer's opponent readout. It is the only surface that shows the WHOLE opponent
       * roster rather than just the active body, so it is what a phantom mon from a previous
       * battle shows up in. */
      candidates: (function () {
        const n = document.querySelector('[data-st-candidates]');
        return n ? n.textContent : null;
      })(),
      benchPills: document.querySelectorAll('[data-st-bench]').length,
      lethalBars: document.querySelectorAll('[data-st-lethal]').length,
      deductionBadges: document.querySelectorAll('[data-st-deduction]').length,
      receipt: (function () {
        const n = document.querySelector('[data-st-receipt]');
        return n ? n.textContent : null;
      })(),
      drawer: !!document.querySelector('[data-st-drawer]'),
      injected: window.__ST_INJECTED__ === true,
      injectedAttr: el.getAttribute('data-st-injected'),
      counters: window.__ST_INJECTED_DEBUG ? JSON.parse(JSON.stringify(window.__ST_INJECTED_DEBUG)) : null,
      lastLine: el.dataset.stLine || null,
      lastLineKind: el.dataset.stLineKind || null,
      lineSeq: parseInt(el.dataset.stLineSeq || '0', 10),
      /* The content script mirrors its own internal failures onto the root element, because
       * nothing else can read them across the realm boundary. See content.js _error(). */
      internalError: el.dataset.stError || null,
      internalErrorCount: parseInt(el.dataset.stErrorCount || '0', 10)
    };
  });
}

module.exports = {
  ROOT: ROOT,
  TEAM: TEAM,
  REPLAY_LOG: REPLAY_LOG,
  BATTLE_SETUP: BATTLE_SETUP,
  FIXTURE_HTML: FIXTURE_HTML,
  buildRequest: buildRequest,
  launchExtension: launchExtension,
  seedStorage: seedStorage,
  clearStorage: clearStorage,
  readStorage: readStorage,
  extensionUrl: extensionUrl,
  openBattle: openBattle,
  waitForBadges: waitForBadges,
  waitForDrain: waitForDrain,
  pushLines: pushLines,
  requestTurn: requestTurn,
  hudSnapshot: hudSnapshot
};
