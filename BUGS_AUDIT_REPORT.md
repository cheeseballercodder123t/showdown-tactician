# Showdown Tactician — Bug-Hunt & Hardening Report

**Scope.** Two fast-lane sweeps, run in order, each with the same protocol: find real defects, prove
each one with an automated assertion *before* fixing it, apply the smallest surgical fix, and leave
a permanent regression suite behind.

* **Sweep 1 — engine correctness.** The whole solver read against its own contracts: ten defects
  (B1–B10), all in the state manager, the sampler, the pruner and the damage cache. Everything was
  verified through a DOM-less sandbox; **nothing touched a browser.**
* **Sweep 2 — the real browser (this one).** Sweep 1's closing note listed "nothing in a real
  browser" as its biggest hole, so sweep 2 built a Playwright harness that loads the actual MV3
  extension into Chromium and drives a real page — and found **seven more defects** (B11–B17) that
  no sandbox could ever have seen, because they live in the DOM, in CSS stacking, in the cross-realm
  bridge, and in the page-lifecycle code the Node harness never runs.

**Ground rules observed.**

1. **Speed rule.** The Node suites were run once, at the end (plus the individual suite a fix
   touched, while fixing it). The **full** browser suite was run **once**, on the frozen tree, at the
   very end. No suite was re-run "just in case".
2. **Per bug:** root cause first (no band-aids), then a reproducing assertion, then the minimal fix,
   then verify green with zero regressions. Every fix was checked against the pre-fix code by
   stashing just that file, so "the test would have caught it" is measured, not asserted.
3. Every fix is pinned by an assertion, so the defect cannot come back silently.

---

# Sweep 2 — the real browser

## Artifacts

| File | What it is |
| --- | --- |
| [`playwright.config.js`](playwright.config.js) | **New.** Separate from `npm test` on purpose: the Node suites are zero-dependency and finish in ~30 s, while this one downloads Chromium and drives it with the extension side-loaded. `workers: 1`, `fullyParallel: false` — each worker launches its own persistent Chromium, and two at once makes the timing-sensitive assertions flaky for no gain. |
| [`tests/e2e/helpers.js`](tests/e2e/helpers.js) | **New.** Launch, storage seeding, protocol push, and the HUD snapshot. Contains the **observability contract** (below), which is the single most important thing sweep 2 learned. |
| [`tests/e2e/fixtures/showdown.html`](tests/e2e/fixtures/showdown.html) | **New.** A stand-in for `play.pokemonshowdown.com`, served by *intercepting the real hostname* rather than by hitting the network — the hostname is what the content script matches on, so the URL has to stay real while the bytes come from a fixture. Reproduces only the surface the extension touches: `window.app.curRoom.battle`, a readable dex, `button[data-move]` markup, and a real `WebSocket`. |
| `tests/e2e/01-boot.spec.js` … `07-options.spec.js` | **New.** 41 tests in seven specs: boot/manifest, HUD rendering, session lifecycle, robustness, hardening, the socket bridge, and the options page. |
| [`tests/dom_check.js`](tests/dom_check.js) | **New.** 35 checks: the HUD's DOM lifecycle against a *faithful* stub (one that can actually find its own buttons). Pins B12, B13, B16. |
| [`src/ui_overlay.js`](src/ui_overlay.js), [`styles/overlay.css`](styles/overlay.css), [`src/injected.js`](src/injected.js), [`src/state_manager.js`](src/state_manager.js), [`src/content.js`](src/content.js) | The five files sweep 2 changed. |
| [`tests/injected_bridge.js`](tests/injected_bridge.js) | 12 → 23 checks. Pins B14 and B15 in the fast lane (0.1 s, no browser needed). |
| [`tests/hardening_audit.js`](tests/hardening_audit.js) | 46 → 64 checks. New section 12 pins B17. |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml), [`package.json`](package.json), [`.gitignore`](.gitignore) | A new `e2e` CI job (separate from `test`, so the slow browser gate never blocks the fast one), `npm run e2e`, and the Playwright output directories. |

### The observability contract (why the specs assert what they assert)

A content script runs in an **isolated world**. `page.evaluate` sees the page's MAIN world only, so
`window.ST` and `window.__ST_BOOT__` are `undefined` from a test. Everything asserted is therefore
one of:

* **shared DOM** — the HUD nodes, the `data-st-*` attributes, `documentElement.dataset.stLine`;
* **MAIN world** — `window.__ST_INJECTED__` and its counters, set by `src/injected.js`;
* **the network/console stream** Playwright already taps.

That is not a workaround. The shared DOM is precisely what a player sees, so asserting on it is a
*stronger* end-to-end statement than reading an internal counter would be. One primitive had to be
added for it: `content.js` now mirrors every caught failure onto `documentElement.dataset.stError`
(and a count), because `stats.errors` lives in the isolated world and nothing outside it — not the
page, not a test, and not a player who opens DevTools on the page rather than on the extension —
could read it. `util.js`'s `DEBUG` flag cannot cover this either: it is a module-level `let` that is
false in every shipped build. Every hostile spec in sweep 2 ends on `internalError === null`.

## Summary

| # | Defect | Where | Class | Status |
| --- | --- | --- | --- | --- |
| B11 | The team drawer's toggle button is **covered by the drawer it opens** — a one-way button | `styles/overlay.css` | unreachable control | fixed |
| B12 | The inline-style rollback recorded the HUD's **own** values, so `clear()` restored the wrong thing and the list grew every render | `src/ui_overlay.js` | wrong teardown + unbounded growth | fixed |
| B13 | The "strip a stale badge" branch was **dead code** (it read an attribute set on a different node) | `src/ui_overlay.js` | stale UI | fixed |
| B14 | The poll's dedupe **ate genuine repeats** in the battle log — three identical lines reached the parser once | `src/injected.js` | lost protocol lines | fixed |
| B15 | An inbound socket frame was forwarded **once per registered listener** — a page using both `onmessage` and `addEventListener` got every frame twice | `src/injected.js` | doubled, relative-effect corruption | fixed |
| B16 | `clear()` reset `textDecoration` **without recording the original** (asymmetric with `opacity`) | `src/ui_overlay.js` | destroys page styling | fixed |
| B17 | A second `\|init\|` (reconnect / rematch) **never cleared the board** — the previous battle's roster, boosts and hazards survived | `src/state_manager.js`, `src/content.js` | state corruption | fixed |

Reproduction proof, measured by stashing only the file each fix touched:

| Suite | Pre-fix | Post-fix |
| --- | --- | --- |
| `node tests/dom_check.js` | **7 failing** | 35/35 |
| `node tests/injected_bridge.js` | **5 failing** | 23/23 |
| `node tests/hardening_audit.js` (§12) | **5 failing** | 64/64 |
| `playwright test -g "second |init|"` | **1 failing** (phantom roster) | 1 passed |

---

## B11 — The drawer's toggle is covered by the drawer it opens

**Symptom.** The `TAC` button opens the team drawer. Once open, tapping it again does nothing: the
drawer is a one-way door, and the only way back is to reload the page.

**Root cause.** Two rules that were each individually reasonable:

* `.team-drawer` is `position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483003` — it spans
  the full width at the bottom of the viewport, which is correct for a mobile bottom sheet;
* `.team-drawer-toggle` is `position: fixed; left: 10px; bottom: 10px; z-index: 2147483002`.

The toggle sits **inside** the panel's rectangle and **one step below** it in the stacking order, so
the panel swallows the tap. `toggleDrawer()` adds `.active` to the toggle and the button has an
`aria-label` promising a toggle, so two-way operation was unambiguously the design.

**Reproducing assertion.** With the drawer open, measure both rectangles and ask the browser what is
actually at the toggle's centre:

```js
document.elementFromPoint(toggleCentre.x, toggleCentre.y)
```

Pre-fix: the drawer spans `{l:0, t:473, r:412, b:915}`, `elementFromPoint` returns
`DIV.drawer-candidates`, and a real `page.click('.team-drawer-toggle')` on a real Chromium page
times out. Post-fix: `elementFromPoint` returns the toggle, and the click closes the panel.

**Fix.** Lift the toggle to the **top** of the z-index ladder (above the panel it opens), and reserve
its corner in the panel so nothing else is put underneath it — a `padding-left` on the drawer's
action row rather than a second overlap.

**Verification.** `tests/e2e/03-session.spec.js` opens and closes the drawer with real clicks and
also asserts that the panel's own controls stay hittable, so the fix cannot have traded one
unreachable control for another.

---

## B12 — The rollback list recorded the HUD's own values

**Symptom.** After `hud.clear()`, a button that had been vetoed kept `style.opacity === "0.5"` — the
HUD dimmed it and then failed to un-dim it. The rollback list also grew by one entry per render:
**31 entries after 30 renders.**

**Root cause.** `_rememberStyle(el, prop)` pushed unconditionally, and its caller guarded it with

```js
const previous = btn.getAttribute ? btn.getAttribute(BADGE_ATTR) : null;
if (previous === null) this._rememberStyle(btn, 'opacity');
```

`BADGE_ATTR` (`data-st-badge`) is set on the **badge node**, never on the button, so
`getAttribute(BADGE_ATTR)` on a button is *always* null and the guard was always true. The list
therefore ended up holding the HUD's own `"0.5"` as the "original" value, and `clear()` — which
first resets `opacity` correctly and *then* replays the rollback list — put `"0.5"` straight back.

**Reproducing assertion** (`tests/dom_check.js` §1–2): 30 renders must leave exactly **2** rollback
entries (`opacity`, set every decorate, and `position`, set once when the badge is first appended),
each holding the true original; and after `clear()` the opacity must be `''` in both orderings
(clean-then-vetoed, and vetoed-last).

**Fix.** `_rememberStyle` becomes idempotent — it records a property at most once per element — and
the always-true guard is removed, because with idempotent recording it is both redundant and
misleading.

**Verification.** `dom_check.js` 35/35. On the pre-fix code the suite reports **7 failures**, all in
§1–2.

---

## B13 — The stale-badge branch was dead code

**Symptom.** A button the engine has no opinion about (a move it did not rank) kept the badge from
the previous turn, so the player read a stale number.

**Root cause.** The branch that was supposed to strip it tested the same always-null attribute as
B12:

```js
const stale = btn.getAttribute ? btn.getAttribute(BADGE_ATTR) : null;
if (stale && btn.querySelector && btn.querySelector('.elo-helper-badge')) { … }
```

`stale` is never truthy, so the whole branch never ran. The comment above it ("strip any badge we
left behind") described behaviour that did not exist.

**Reproducing assertion** (`dom_check.js` §3): decorate a button, then decorate it with `null` and
require the badge to be gone from the tree, the confidence class to be gone from the button, and the
inline opacity to be gone.

**Fix.** Drop the attribute test and key the strip on the node that actually exists: look for
`.elo-helper-badge` and remove it.

**Verification.** `dom_check.js` §3 green; `tests/hud_check.js` and the E2E
`a button the engine has no opinion about loses its badge` both stay green.

---

## B14 — The poll dedupe ate genuine repeats

**Symptom.** Three identical consecutive lines in `battle.log` reached the parser **once**. So did
two. Any protocol line that legitimately repeats its predecessor was silently dropped.

**Root cause.** `pollBattleLog` skipped a line whenever it matched the line the **poll itself** had
last delivered. That is not what its comment claimed — the stated purpose was to skip something the
**socket** had already delivered, because the socket path and the poll path both read the same
events. Comparing poll against poll cannot tell a socket duplicate from a genuine repeat, and the
log is the authority on what happened: two identical lines in `battle.log` are two things that
happened.

**Reproducing assertion** (`tests/injected_bridge.js`): push three identical `|-unboost|` lines and
require `polled` to advance by 3; push two identical `|upkeep` lines and require 2; require a poll
with nothing new to forward nothing; and — the other direction — require a line the **socket** just
delivered **not** to be re-delivered by the poll that then reads it out of the log.

**Fix.** Track the last delivery as `{ line, kind }` and skip only when the **socket** was the last
thing to deliver that exact text. The poll resumes on the next genuinely new line.

**Verification.** `injected_bridge.js` 23/23. Pre-fix it fails **three** ways — including "the poll
does not deliver it again", which proves the old guard did not even do its own job: it was wrong in
both directions.

---

## B15 — An inbound socket frame was forwarded once per listener

**Symptom.** In a real Chromium page, a single inbound WebSocket frame was processed **twice**. A
three-line frame produced six forwarded protocol events and `counters.received` advanced by 2 for one
delivery. Most Showdown lines are absolute (a `|-damage|` applied twice is idempotent), but the
relative ones are not: `|-boost|p1a|atk|1` applied twice is **+2**, and `|turn|n` twice re-opens a
decision window.

**Root cause.** `injected.js` captures inbound frames through **two** independent wrappers — the
`WebSocket.prototype.onmessage` accessor (for `socket.onmessage = fn`) and a per-socket
`addEventListener('message', …)` wrapper. They are two separate registrations, and a page that uses
both gets both wrappers on the same socket, so both see the **same** `MessageEvent` and both forward
it. This was caught because Playwright's WebSocket mock installs its own `'message'` listener; the
same shape appears in the wild whenever two scripts share a socket, which is exactly the situation
on `play.pokemonshowdown.com`.

**Reproducing assertion** (`tests/injected_bridge.js`): register both styles on one socket, hand both
wrappers the **same** event object, and require `dispatched` to advance by exactly 1 while *both*
page handlers still run; then hand the same wrapper two **distinct** events carrying identical text
and require both to be forwarded, so the guard is keyed on identity and not on content. In the
browser, `tests/e2e/06-socket.spec.js` asserts the same thing against a real WebSocket.

**Fix.** A single `captureInbound(event)` used by both wrappers, guarded by a one-slot reference to
the last event object. The event *is* the delivery's identity, and both wrappers run synchronously
inside the same dispatch, so one slot is sufficient and no allocation is needed. The page's own
handlers are still delegated unconditionally — the guard suppresses the *forwarding*, never the
page's callback.

**Verification.** `injected_bridge.js` 23/23 (pre-fix: 2 failures), `06-socket.spec.js` 2/2, and the
E2E's frame-delivery count drops from 6 to the correct 3.

---

## B16 — `clear()` destroyed an inline style it had not recorded

**Symptom.** `clear()` reset `btn.style.textDecoration` directly, but only `opacity` and `position`
were ever recorded in the rollback list. A page (or another extension) that had set an inline
`text-decoration` on a move button lost it permanently the first time the HUD tore down.

**Root cause.** An asymmetry inside `_decorateButton`/`clear()`: the veto path sets **two** inline
properties but remembered only one. This is the same root-cause family as B12 — the rollback
bookkeeping and the styling it is supposed to undo had drifted apart — which is why the two are
fixed together rather than one at a time.

**Reproducing assertion** (`dom_check.js` §2, veto-last ordering): a vetoed render must strike the
button through, and `clear()` must return `textDecoration` to its original (`''`) rather than to the
HUD's own value.

**Fix.** Record `textDecoration` through the same idempotent `_rememberStyle` path as `opacity`, so
the rollback list is a complete description of what the HUD changed.

**Verification.** `dom_check.js` 35/35; `clear()`'s existing caller-facing contract in
`tests/run_tests.js` ("hud: clear is safe") is unaffected.

---

## B17 — A second `|init|` never cleared the board

**Symptom.** After a mid-battle reconnect, the engine reasoned about a **phantom opponent**. Three
battles replayed on one connection left the opponent roster as
`["Iron Valiant", "Landorus-Therian", "Kingambit", "Dragapult"]` — every opponent from every game,
accumulated. Sp. Atk boosts read `+2` instead of `+1`, and Stealth Rock was on the opponent's side
when the replay had not put it there.

**Root cause.** Two independent gaps on the same path:

1. **`|init|` did not reset the state manager.** `BattleStateManager.reset()` existed and was
   correct, but **nothing in `src/` ever called it** — the `|init|` handler in `content.js` reset the
   clock, the bench selection, the Trick Room alert and the receipt, and stopped there.
2. **`|clearpoke|` was never handled at all.** It parses to `{ type: 'unknown' }` and no handler
   existed, so the previewed opponent roster was never cleared.

Both matter because `|init|` is not sent once per page: Showdown **re-sends it followed by the
entire log from turn 1** whenever the socket reconnects mid-battle, and a rematch in the same room
re-uses the connection. Replaying a log on top of the previous battle is not idempotent — `|-boost|`,
`|-sidestart|` and Leech Seed counters are relative or incremental, so they compound.

**Reproducing assertion.** Two places, because the two halves fail differently:

* `tests/hardening_audit.js` §12 feeds two (then three) full battles through one state manager and
  requires: the phantom roster to be gone, the new opponent to be active, **our pasted team to
  survive** (6 mons, item, EV/IV truth, `fromPaste`), the previous battle's damage/boosts/hazards to
  be gone, the format to still be recognised, and a bare `|format|` line **not** to clear the board.
* `tests/e2e/05-hardening.spec.js` does the same on a real page and reads the drawer's opponent
  readout, which is the only HUD surface that shows the *whole* roster rather than the active body.
  The first version of this spec asserted only on the banner and **passed on the pre-fix code** —
  the banner shows the active mon, which the replay sets correctly. Asserting on the roster is what
  makes it a real test.

**Fix.**

* `BattleStateManager._onInit` resets on a **repeat** `|init|`. The reset is keyed on the raw line
  starting with `|init|`, because `|format|` parses to the same event type but is a room header and
  must not wipe a battle in progress.
* `reset()` re-registers the pasted team. The paste is **connection-level** truth (EVs/IVs/nature/
  item from TeamParser), not battle state — without this the reset would leave the engine with no
  team and every "can I still switch" answer would be wrong. `registerMyTeam` keeps a copy in
  `_parsedTeam` precisely so `reset()` can replay it.
* `content.js`'s `|init|` handler also clears the pruner's candidate pools, which are seeded per
  `side|slot|species` and are only meaningful for the battle they were seeded in.

**Verification.** `hardening_audit.js` 64/64 (pre-fix §12: **5 failures**),
`05-hardening.spec.js` 7/7 (pre-fix reconnect test: **1 failure**), and the whole Node suite green.

---

## Test corrections (sweep 2)

Six of sweep 2's own first-draft assertions were wrong. They were rewritten rather than "made to
pass", and each rewrite is what the sections above now pin:

1. **`dom_check.js`'s stub document could not find its own buttons.** Its `querySelectorAll` answered
   one selector and returned `[]` for everything else, so `clear()` skipped its entire button loop
   and the suite quietly "passed" a teardown it never performed. That is the stub-that-cannot-fail
   problem in reverse, and it is the same class of blind spot that let B12/B13/B16 survive: the
   header of `hud_check.js` had already admitted that its stub returns nothing from `querySelector*`,
   which is why every button-level check there stubs `_findMoveButtons` and why `_decorateButton`
   had never once been run against a document.
2. **"30 renders leave exactly 1 rollback entry"** — my expectation, not the code. **2** is correct:
   `opacity` (every decorate) and `position` (once, when the badge is appended).
3. **"the veto badge's text is `VETO`"** — it is the percentage. The veto is carried by the
   `conf-veto` class and the `title`, and the stylesheet makes it visually distinct (transparent
   fill, red border, line-through). The assertion was rewritten to check the class and the title.
4. **The options Reset test failed for the wrong reason.** Playwright dismisses dialogs by default,
   so `window.confirm` returned `false` and the reset correctly did nothing. The test now registers a
   dialog handler and asserts **both** paths: a dismissed confirm must change nothing at all
   (form *and* storage), and an accepted one must reset everything. That is a stronger test than the
   original.
5. **`extensionUrl` produced `null/options/options.html`.** `chrome-extension:` is not a "special"
   scheme, so Node's WHATWG URL parser reports `.origin` as the **string** `"null"`. The extension id
   has to be read out of the raw URL instead.
6. **The E2E reconnect test passed on pre-fix code.** See B17 — it asserted on the banner, which the
   replay sets correctly regardless.

## Verification evidence

The single browser run, on the frozen tree, at the end:

```
npm run e2e  ->  exit 0   41 passed (46.3s)
```

The Node gate, same tree:

```
npm test     ->  exit 0   ALL 20 SUITES PASSED (31.8s)
                          tests/injected_bridge.js   23/23
                          tests/dom_check.js         35/35
                          tests/hardening_audit.js   64/64  (40-battle fuzz clean)
                          tests/mlp_check.js         48/48
                          tests/blackbox_guard.js    50,616 stat values
```

Pre-fix reproduction, one file stashed at a time:

```
git stash push -- src/ui_overlay.js    && node tests/dom_check.js        -> 7 failures
git stash push -- src/injected.js      && node tests/injected_bridge.js  -> 5 failures
git stash push -- src/state_manager.js && node tests/hardening_audit.js  -> 5 failures (§12)
git stash push -- src/state_manager.js && playwright test -g "second |init|" -> 1 failure
```

**Zero regressions.** No pre-existing expectation had to change for any sweep-2 fix; the only test
edits were to assertions that were themselves wrong, all listed above.

## What sweep 2 did **not** prove

* **Only Chromium.** The manifest ships `browser_specific_settings` with a Gecko id and
  `strict_min_version`, but every browser test runs Playwright's bundled Chromium. The `chrome.*` /
  `browser.*` surface, and Firefox's MV3 extension loading, are untested.
* **The page is a fixture, not the real site.** It is served by intercepting the real hostname, but
  it reproduces only the surface the extension touches. An upstream layout or protocol change would
  not be caught here — it would show up as a live regression on the real site.
* **The action popup.** `options/options.html` is registered as *both* `options_ui` (open in tab) and
  `action.default_popup`. Only the tab form is tested. In particular, `Reset` uses a blocking
  `window.confirm`, which a popup that loses focus may not survive — plausible, but **not
  reproduced**, so it is logged rather than patched.
* **The LLM path.** No API key is ever set, so `src/llm_client.js` is never exercised end to end;
  only its "skipped while blank" behaviour is implied.
* **`bench/bench.html`** has no automated coverage at all.
* **Device performance.** The "S24 FE" viewport is emulated — size and device pixel ratio only, not
  the CPU. `tests/perf_bench.js` remains the only timing evidence.
* **Deliberately logged, not fixed:**
  * `MobileHUD.clear()` has **no caller in `src/`**. It is correct (and now pinned by
    `dom_check.js`), but nothing invokes it. It was considered as the hook for B17 and rejected:
    `clear()` also removes the drawer and its toggle and sets `_bound = false`, so calling it on
    `|init|` would need `bindDrawer()` straight after and would blank the team-status readout. The
    stale HUD text self-heals on the `|request|` that always follows a replay, so the state manager
    — where the corruption actually was — is the right place to fix it.
  * A room switch that swaps `window.app.curRoom.battle` **without** an `|init|` leaves stale HUD
    text. Unreachable in practice: a real room switch is a page navigation, and the poll's cursor
    reset already handles the shrunk log. Logged, not patched.
  * The `dataset.stLine` mirror is a **fallback**, not a second delivery path: `content.js` only
    reads it when the CustomEvent carries no usable detail. Verified — there is no double-application
    from the two-channel design.

---

# Sweep 1 — engine correctness

## Artifacts

| File | What it is |
| --- | --- |
| [`tests/hardening_audit.js`](tests/hardening_audit.js) | **New.** 46 checks in 11 sections: one section per defect (each fails on the pre-fix code) plus a 40-battle seeded invariant fuzz. Run with `node tests/hardening_audit.js`. |
| `src/laplace_core.js`, `src/world_sampler.js`, `src/veto_guard.js`, `src/content.js`, `src/state_manager.js`, `src/calc_engine.js`, `src/set_pruner.js`, `src/config.js` | The eight modules touched by the fixes. |
| [`tests/rule_checks.js`](tests/rule_checks.js) | One expectation had to be corrected: it was passing *because* of defect **B9** (see "Test corrections"). |
| [`README.md`](README.md), [`ARCHITECTURE.md`](ARCHITECTURE.md) | Document the new suite (and "eight suites" → "nine"). |

## Summary (sweep 1)

| # | Defect | Where | Class | Status |
| --- | --- | --- | --- | --- |
| B1 | Softmax returns **NaN** confidence for any `temperature ≤ ~1.7` | `src/laplace_core.js` | correctness / crash-grade | fixed |
| B2 | World sampling is **not deterministic** — worlds come from `Math.random()` | `src/world_sampler.js` | correctness (PIMC contract) | fixed |
| B3 | VETO4 speed race ignores **our own item/ability** and the **field** | `src/veto_guard.js`, `src/content.js` | wrong veto + wrong HUD hint | fixed |
| B4 | A revealed **Mega opponent is sampled as its base forme** and loses world weight | `src/world_sampler.js` | wrong damage/type maths | fixed |
| B5 | Species lookup **prefix-matches unrelated formes** (`Ursaluna` → `Ursaluna-Bloodmoon`) | `src/state_manager.js` | wrong MonState / missing mon | fixed |
| B6 | Damage memo key **omits four IVs** (and the ability/item options) | `src/calc_engine.js` | stale damage roll (~6 %) | fixed |
| B7 | **Struggle counts as a second distinct move** → permanent Choice lock-out | `src/state_manager.js` | deduction corruption | fixed |
| B8 | Candidate pools are keyed **per species**, shared across sides | `src/set_pruner.js` | deduction corruption | fixed |
| B9 | An **unsatisfiable Speed floor empties the pool** (sampler falls back to the raw DB) | `src/set_pruner.js`, `src/config.js` | deduction silently undone | fixed |
| B10 | A `\|-heal\|` on a **fainted** body leaves it fainted *and* at 52 % HP | `src/state_manager.js` | illegal state (Revival Blessing) | fixed |

Reproduction proof: on the pre-fix code the audit reported **18 failing assertions across all ten
sections** (plus the fuzz). After the fixes: **46/46 green**, and the eight pre-existing suites are
green with a single corrected expectation (B9, below).

---

## B1 — Softmax produces `NaN` confidence

**Symptom.** With the advertised tunable turned down
(`ST.configMerge({ laplace: { temperature: 1 } })`, or `evaluateTurn(state, { temperature: 1 })`)
**every** line came back with `confidence: NaN`. The HUD renders `NaN%`, the sort comparator
returns `NaN`, and the LLM prompt carries `NaN`.

**Root cause.** `src/laplace_core.js` computed `Math.exp(score / T)` with no shift. Live scores
legitimately reach ~1400 (`lethalBonus` 260 + the evaluator's ±1000 bound + `switchAteHitBonus` 25
+ the Bunker mask 80), so for any `T` below ~1.7 `exp(score / T)` overflows to `Infinity`, making
`denom = Infinity` and every confidence `100 * (Infinity / Infinity) = NaN`. The default
`T = 35` (`src/config.js`) hides it, which is exactly why it survived: the config is *advertised*
as retunable.

**Reproducing assertion** (`tests/hardening_audit.js` §1): evaluate the Mega fixture at
`temperature: 1` and require every confidence to be finite in 0..100, the live lines to sum to
100 ± 1.5, and the top line to stay the highest.

**Fix.** Subtract the best live score before exponentiating (mathematically identical, only the
numerator's range changes), and fall back to the configured temperature if a caller passes a
non-positive one.

**Verification.** Before: `[null, 0, 0]` and `NaN`. After: 4/4 checks pass; `run_tests.js`'s
"softmax confidences sum to 100" (tolerance 1.5) is unaffected, so no consumer had baked in a
particular float.

---

## B2 — World sampling is not deterministic

**Symptom.** Two `evaluateTurn` calls on the *same* unchanged battle state returned different
confidence vectors (e.g. `gigadrain 0.0055152…` vs `0.0055155…`), and two fuzz seeds failed the
"deterministic across two runs" invariant.

**Root cause.** `src/world_sampler.js` derived each world's seed from `this._rand()`, which returns
`Math.random()` whenever no rng was injected, then `mulberry32(seed)`. The module's whole premise —
"determinized perfect-information Monte Carlo" — was therefore false by default: the K worlds, and
thus every score, changed on every call.

**Reproducing assertion** (§2): the same state must sample the same world seeds and rank the same
lines; the worlds must stay distinct; no seed may come from `Math.random`; a *different* state must
sample different seeds; and an **explicitly injected** rng must still drive the sampling.

**Fix.** New `_observationSignature(state)` (turn, field, and each opponent body's revealed
facts) hashed with FNV-1a into a 32-bit `_seedFromState`. `sampleWorlds` now derives the K seeds as
`base + i * 0x9E3779B9`, or — when `options.rng` is present — one draw per world from that rng, so
the injected-rng contract is preserved. `sampleWorld` accepts an explicit seed and never falls back
to `Math.random()`.

**Verification.** §2 6/6 pass, including the injected-rng case; the fuzz's "not deterministic
across two runs" failures disappear (see §11).

---

## B3 — VETO4's speed race cannot see our item, our ability, or the field

**Symptom.** Two wrong verdicts, both reachable every game:

* our **Choice Scarf Toxapex** was treated as unscarfed, so VETO4 fired "slower and facing a
  guaranteed KO" on a turn we actually outspeed and KO first;
* a **Swift Swim / Chlorophyll / Sand Rush / Slush Rush / Surge Surfer** mon in its weather, or any
  body behind **Tailwind**, was scored at its naked Speed on both sides.

**Root cause.** `src/veto_guard.js` `_opponentMovesFirst` passed
`item: my.currentBattleItem || my.confirmedItem` and `ability: my.revealedAbility`. For our own
team those fields are **never** populated — `registerMyTeam` writes `mon.item` / `mon.ability`
(`src/state_manager.js`) — and `U.computeSpeed` treats a *defined* option as authoritative
(`opts.item !== undefined ? opts.item : mon.item`), so `toID(null)` → `''` erased a Choice Scarf.
`weather` / `terrain` / `tailwind` were not passed at all although `state.field` carries them, and
`paradoxSpeedBoost: !!mon.boosterActive` never covers a *fresh* Booster Energy holder outside a
sampled world (`trick_room.js` adds the ability+item fallback). It also carried a dead
`const moveId = U.toID(null);`.

**Reproducing assertion** (§3), with fixtures chosen to sit between the relevant speeds
(plain Toxapex 185 < Gholdengo 267 < Scarf Toxapex 277; plain Kabutops 259 < 267 < rain Kabutops
518): the Scarf must flip `_opponentMovesFirst` to `false`, an unscarfed/rainless body must stay
`true`, and Swift Swim in rain must flip it.

**Fix.** Local `_itemOf` / `_abilityOf` helpers mirroring `trick_room.js`'s (observed →
confirmed → not-removed `mon.item` → `liveSet`), plus `weather` / `terrain` / `tailwind` (per side
from `state.mySide`) / `boostStage` / `unburden`, and the dead binding removed. `src/content.js`'s
`speedHint` had the identical omission and now uses the same resolution order plus the field.

**Verification.** §3 6/6 pass. Note §3's original second assertion was itself wrong (it used an
opponent slower than unboosted Kabutops) — see "Test corrections".

---

## B4 — A revealed Mega is sampled as its base forme

**Symptom.** Against a revealed Mega Venusaur every sampled world reported
`species mismatch`, lost weight (`1/(1+k)` → each world's normalised share), and stood a **base
Venusaur (82 Atk)** on the field while the veto/tempo layers used the real Mega (100 Atk).

**Root cause.** `src/world_sampler.js` `_monFromSet` took the species from `set.species`, and a
Mega set is stored in `sets_db.js` under the **base** species with the stone in `item`
(`P('Venusaur', [{ r: 'mega', i: 'Venusaurite', … }])`, `isMega` derived from the item), so the
sampled world mon inherited the base name while `_violationsFor` compared it against the observed
`Venusaur-Mega` and rejected **every** candidate — the very set that was correct.

**Reproducing assertion** (§4): for a revealed `Venusaur-Mega`, the state and the world mon must
both be `venusaurmega`, no world may report a species mismatch or any other violation, the Mega
Stone must survive in the sampled set, and `U.baseStats(species).atk` must be 100 (not 82).

**Fix.** New `_setSpecies(set)` resolves a Mega/Primal set to its field forme via
`U.megaSpeciesFromStone(set.item)`; used both by `_monFromSet` (what the world actually fields) and
by `_violationsFor` (what the set is compared against).

**Verification.** §4 6/6 pass. The original fixture used Abomasnow, which is **not in the bundled
set database**, so it exercised the generic-filler path instead of the defect — corrected (see
"Test corrections").

---

## B5 — Species lookup prefix-matches unrelated formes

**Symptom.** With both `Ursaluna-Bloodmoon` (from team preview) and a plain `Ursaluna` (switched
in) in play, the game state held **one** monster: the Bloodmoon, marked active. The real Ursaluna
was never created, so its HP, item deductions, Speed floor and typings all landed on the wrong body.

**Root cause.** `src/state_manager.js` `_findBySpecies` had
`if (!best && toID(m.species).indexOf(id.replace(/mega[xy]?$/, '')) === 0 && id) best = m;` — a raw
prefix test, so `Ursaluna` matched `Ursaluna-Bloodmoon`, `Zapdos` matched `Zapdos-Galar`,
`Porygon` matched `Porygon2`, `Raichu` matched `Raichu-Alola`, `Kyurem` matched `Kyurem-Black`, and
`_onSwitch` (which resolves by species, not by slot) skipped creating the real mon.

**Reproducing assertion** (§5): `poke`-preview the Bloodmoon, switch a plain `Ursaluna` into
`p2a`, and require the plain Ursaluna to exist, the Bloodmoon not to be active, and
`_findBySpecies('p2','Ursaluna')` not to return the Bloodmoon. Plus the **reverse** direction:
`_findBySpecies('p2','Abomasnow')` must still find `Abomasnow-Mega` (this is how the `|-mega|`
handler locates its body).

**Fix.** Strip a recognised forme suffix (`mega`, `mega-x/-y`, `primal`) from **both** sides before
comparing, and otherwise require an exact id match.

**Verification.** §5 5/5 pass; `run_tests.js` (protocol/state sections) and `parser_fuzz.js` stay
green, so no legitimate base→forme resolution regressed.

---

## B6 — The damage memo key omits four IVs

**Symptom.** Two mirror Great Tusk rolls with 31 Atk and 0 Atk IVs returned the identical number
(`234` / `234`, `cache: 1`) — a stale roll reused across different spreads (~6 % error).

**Root cause.** `src/calc_engine.js` `_key`'s `monSig` included only `d.ivs.hp` and `d.ivs.spe`
although `normIVs` preserves all six, so a mon differing in Atk/Def/SpA/SpD IVs hashed to the same
key. `opts.ability` / `opts.item`, which change a Max Move's typing in `_buildMove`, were missing
from the `extra` segment for the same reason.

**Reproducing assertion** (§6): a 0-Atk-IV attacker must deal measurably less than a 31-IV one, and
the memo must not serve the first roll for the second mon.

**Fix.** Add all six IVs to `monSig` and `opts.ability` / `opts.item` to `extra`.

**Verification.** §6 2/2 pass; `test_engine.js` (the frozen ground-truth rolls) and
`blackbox_guard.js` (50,616 stat values) stay green — the cache is still a pure function of its key.

---

## B7 — Struggle disproves a Choice item

**Symptom.** After one real move plus a Struggle, the opponent's candidate pool lost **every**
Choice set permanently (`cannotBeChoice = true`, `_dropChoiceSets` splices both the live pool and
the pristine pool) and the deduction trail read "2+ distinct moves in one stint ⇒ no Choice item".

**Root cause.** `distinctStintMoves()` *does* filter Struggle, but the rule used
`stintCount = Math.max(distinct, mon.activeStintCount | 0)` and `src/state_manager.js` `_onMove`
pushed the raw move name and set `mon.activeStintCount = mon.activeStintMoves.length`, so a forced
pseudo-move inflated the counter. The same counter also cleared `originalArchetypeItem`
unconditionally at `>= 2`.

**Reproducing assertion** (§7): a stint of `Kowtow Cleave` + `Struggle` must not trip the rule and
must leave the Choice item possible, while `Kowtow Cleave` + `Iron Head` still must.

**Fix.** A module-level `FORCED_MOVE_IDS` set; `_onMove` no longer records Struggle in the stint
(so the counter, the archetype-item clearing and the pruner all agree).

**Verification.** §7 5/5 pass. `run_tests.js`'s choice-lock test sets `activeStintCount` directly
and is unaffected.

---

## B8 — Candidate pools are shared across sides

**Symptom.** A deduction proven about the **opponent's** Kingambit rewrote **our** Kingambit's
candidate space: after their Choice lock, re-pruning ours returned
`[Leftovers, Assault Vest, Air Balloon, Black Glasses]` with no Choice Band option left — breaking
`set_pruner.js`'s own idempotency claim.

**Root cause.** `_seedPool`, `_poolFor`, `_dropChoiceSets` and `applySpeedFloor` all keyed the
pristine pool by `mon.id || U.toID(mon.species)`, and `_newMon` sets `id: toID(canonical)`, so two
Kingambits shared one pool object and one `_dropChoiceSets` call mutated both.

**Reproducing assertion** (§8): seed our pool (it must contain a Choice Band set), prune *their*
mon until their Choice sets are disproved, then re-prune ours and require the Choice Band option to
survive.

**Fix.** New `_poolKey(mon)` = `side|index|speciesId` (falling back to the bare species id for the
side/index-less fixture objects the unit tests build, where a species appears only once). Every
`_pristine[...]` access now goes through it.

**Verification.** §8 4/4 pass; `rule_checks.js` (speed floor, format-lock cascade) and
`run_tests.js` (pruner sections) stay green.

---

## B9 — An unsatisfiable Speed floor empties the pool

**Symptom.** With a floor no set can reach (e.g. `speedFloor = 900` on Slowking-Galar, reachable
because `_maybeSpeedFloor` only inspects the *opponent's* Tailwind), `candidateSets` became `[]` with
no guard: `liveSet` went `null` and the sampler's `_poolFor` then fell back to the **unfiltered
database**, silently undoing every other deduction. `sampler.sampleWorld` had a
`_speedFloorSatisfiable` guard; the pruner did not.

**Root cause.** `src/set_pruner.js` `applySpeedFloor` published `survivors` unconditionally, unlike
`prune()`, which documents a bounded fallback.

**Reproducing assertion** (§9): an impossible floor must leave a non-empty pool with a published
`liveSet`, keep at most the documented number of sets, and prefer the closest ones.

**Fix.** When no set reaches the floor, keep the `pruner.speedFloorFallbackKeep` (default 4) fastest
candidates, record a reason, and never write an empty pool (also through the new per-instance key).

**Verification.** §9 4/4 pass. **One pre-existing expectation had to be corrected**: see below.

### Test correction — `tests/rule_checks.js`

The old assertion was

```js
ok('speed: no Choice Scarf can survive a 700 floor for Landorus', … &&
   lando.candidateSets.every(function (s) { return U.maxSpeedForSet(s) >= 700; }));
```

`[].every(...)` is **vacuously true**, so it passed precisely while the floor was wiping the pool
out — the test asserted the defect. It now asserts the fixed contract: a non-empty pool (≤ 4 sets)
holding the closest candidates, all below the unreachable floor, with a published `liveSet`.

---

## B10 — A heal on a fainted body leaves it fainted

**Symptom.** The fuzz caught `illegal state … fainted at 52`: a monster flagged `fainted` while
holding 52 % HP. That poisons the alive counts, the bench, `_stampFallen` bounds and every
"can I still switch" decision.

**Root cause.** `src/state_manager.js` `_setHP` set the faint latch when HP hit 0 but never
cleared it when HP came back, so `|-heal|` after `|faint|` — i.e. **Revival Blessing**, which is
legal in this format — produced a zombie. The fuzz generated exactly that sequence and the
invariant caught it.

**Reproducing assertion** (§10): `|-damage|…|0 fnt` + `|faint|` must mark the mon fainted at 0 %,
and a following `|-heal|…|50/100` must clear the latch.

**Fix.** In `_setHP`, when HP parses above 0 and the mon was fainted, clear `fainted`.

**Verification.** §10 2/2 pass, and the fuzz's illegal-state failures disappear.

---

## Test corrections (sweep 1 — assertions that were wrong, not the code)

Four of the audit's own first-draft assertions failed for the wrong reason. They were rewritten
rather than "made to pass", and each rewrite is what the section above now pins:

1. **§3's "Swift Swim without rain"** compared rainless Kabutops (259 Speed) against an opponent
   slower than it, so no weather term could ever be observed. The opponent is now Gholdengo
   (267) — between rainless and rain-boosted Kabutops, and between plain and Scarf Toxapex.
2. **§4's fixture was Abomasnow**, absent from the bundled set database, so the section tested the
   generic-filler path; it also required `world.weight === 1`, which `sampleWorlds` can never
   return because it normalises the weights. Now Venusaur (a real Mega set in the DB) and
   "no violations" instead of "weight === 1".
3. **§5's original line** (`|-damage|p2a: Ursaluna|…`) resolves by **slot** by design, so it could
   not exercise the species lookup at all; the Bloodmoon check therefore failed on *correct*
   behaviour. Rewritten to the real path (preview + `|switch|`) plus a direct
   `_findBySpecies` assertion in both directions.
4. **§8's original form** read `myKing.candidateSets` before it had ever been seeded (always `[]`),
   so it could not detect the shared pool; and checking the live array *after* their prune passes
   even with the bug, because `_dropChoiceSets` only splices their array and the shared pristine
   pool. Rewritten to seed our pool first and re-prune ours afterwards — which is the path the bug
   actually corrupts.

---

## Verification evidence (sweep 1)

Reproduced **before** any fix (`node tests/hardening_audit.js`, pre-fix code):

```
checks passed: 24
checks failed: 18
fuzz: 40 random battles, 280 ranked actions
FAILURES: … NaN confidence ×3, sampler determinism ×2, Swift Swim ×1, Mega sampling ×2,
          species mismatch ×1, memo key ×2, Struggle/Choice ×2, shared pool ×2,
          empty speed floor ×2, fuzz illegal state + non-determinism ×2 …
```

After the fixes (`node tests/hardening_audit.js`):

```
=== summary ===
checks passed: 46
checks failed: 0
fuzz: 40 random battles, 282 ranked actions
ALL HARDENING CHECKS PASSED
```

Full sweep on the final tree — every command run as a plain command with its exit status read:

```
node test_engine.js            -> exit 0   ALL ENGINE GROUND-TRUTH CHECKS PASSED
node tests/run_tests.js        -> exit 0   ALL CHECKS PASSED
node tests/rule_checks.js      -> exit 0   passed: 23  failed: 0
node tests/util_smoke.js       -> exit 0   ALL UTIL CHECKS PASSED
node tests/injected_bridge.js  -> exit 0   checks passed: 12  failed: 0
node tests/config_check.js     -> exit 0   ALL CONFIG CHECKS PASSED
node tests/blackbox_guard.js   -> exit 0   checks passed: 28  50,616 stat values, 324 type cells
node tests/parser_fuzz.js      -> exit 0   ALL PARSER FUZZ CHECKS PASSED
node tests/hardening_audit.js  -> exit 0   46/46, 40-battle fuzz clean
```

**Zero regressions:** only one pre-existing expectation moved, and it is the `rule_checks.js`
assertion that encoded B9 (documented above).

## What sweep 1 did **not** prove

* **Nothing in a real browser.** There was still no Playwright/device run when sweep 1 closed: every
  check used the DOM-less sandbox, stub DOMs or replays, and the UI/HUD rendering path was unverified
  live. **Sweep 2 closed exactly this gap** — and found seven defects in it, three of them in the
  HUD's DOM handling alone. The lesson is recorded at the top of this document.
* **Reachable but unvalidated leads** were deliberately left alone rather than "fixed blind":
  `laplace_core._oppActive` prefers `world.team[0]` before the state's own active body during a
  faint→replacement window; `simulate()` / `_mutableSim` are unreachable dead code; the
  `oppAction.kind === 'switch' → oppHp = 100` leaf shortcut does not substitute an incoming body;
  feeding the whole `possibleAbilities` list into `U.immunityReason` can hard-veto every action;
  `tempo_vector.dims` aliases the reused `this._vec`; and `protocol_parser._parseEffect` leaks the
  effect into `from` for `-activate`-style lines. Each needs a failing assertion before a fix, so
  they are logged, not patched.
* **The fuzz is a bounded sample, not a proof.** 40 seeded streams per run; a failure is
  reproducible, but the absence of one is not a theorem.
