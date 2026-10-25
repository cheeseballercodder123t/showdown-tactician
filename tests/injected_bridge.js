/* Showdown Tactician — tests/injected_bridge.js
 * Verifies src/injected.js against a minimal MAIN-world sandbox: a fake WebSocket and a fake
 * document. This is the one file that cannot be exercised from the isolated-world harness
 * (tests/harness.js), and the whole extension depends on it being transparent — Showdown's own
 * onmessage/onerror handlers must keep working while our copies still see every line.
 *
 * Usage:  node tests/injected_bridge.js     (exit 0 = every check passed)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : '  ->  ' + detail));
}
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(name, ok, ok ? undefined : 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}

const ROOT = path.resolve(__dirname, '..');
const listeners = [];

function FakeWS(url) {
  this.url = url;
  this._listeners = [];
  this.addEventListener = function (t, l) { this._listeners.push([t, l]); };
  this.removeEventListener = function () { };
}
FakeWS.prototype.send = function (d) { this.sent = d; };
Object.defineProperty(FakeWS.prototype, 'onmessage', {
  configurable: true,
  get: function () { return this._om; },
  set: function (fn) { this._om = fn; }
});

const doc = {
  readyState: 'complete',
  documentElement: { dataset: {}, getAttribute: function () { return null; }, setAttribute: function () { } },
  addEventListener: function () { },
  dispatchEvent: function (evt) { listeners.push(evt); return true; }
};
const sandbox = {
  console: console, setInterval: setInterval, clearInterval: clearInterval,
  setTimeout: setTimeout, clearTimeout: clearTimeout, document: doc,
  CustomEvent: function (t, i) { this.type = t; this.detail = i && i.detail; }
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.WebSocket = FakeWS;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'injected.js'), 'utf8'), sandbox, { filename: 'src/injected.js' });

const WS = sandbox.WebSocket;
const sock = new WS('wss://sim.smogon.com/showdown/websocket');

check('socket is patched by injected.js', !!sock.__stPatched);
check('the page keeps its own onmessage handler', (function () {
  let got = null;
  sock.onmessage = function (e) { got = e.data; };
  sock._om({ data: '|-damage|p2a: Great Tusk|45/100' });
  return got === '|-damage|p2a: Great Tusk|45/100';
})());
check('the page keeps its addEventListener("message") handler', (function () {
  let got = null;
  sock.addEventListener('message', function (e) { got = e.data; });
  const last = sock._listeners[sock._listeners.length - 1];
  last[1]({ data: '|move|p2a: Great Tusk|Headlong Rush|p1a: Dragapult' });
  return got === '|move|p2a: Great Tusk|Headlong Rush|p1a: Dragapult';
})());
check('outgoing frames are forwarded unchanged', (function () {
  sock.send('/choose move 1');
  return sock.sent === '/choose move 1';
})());

eq('every line is mirrored as a protocol event', listeners.length, 3);
eq('incoming lines are tagged recv', listeners.filter(function (e) { return e.detail && e.detail.kind === 'recv'; }).length, 2);
eq('outgoing lines are tagged send', listeners.filter(function (e) { return e.detail && e.detail.kind === 'send'; }).length, 1);
eq('the raw line survives the bridge', listeners[0] && listeners[0].detail.rawLine, '|-damage|p2a: Great Tusk|45/100');
eq('the event name is the frozen contract name', listeners[0] && listeners[0].type, 'ShowdownTactician_ProtocolEvent');
eq('the dataset mirror carries the last line', doc.documentElement.dataset.stLine, '/choose move 1');
eq('the dataset mirror carries the last kind', doc.documentElement.dataset.stLineKind, 'send');
eq('counters agree', (function () {
  const d = sandbox.__ST_INJECTED_DEBUG || {};
  return [d.sent, d.received, d.polled, d.dispatched, d.errors];
})(), [1, 2, 0, 3, 0]);

/* ------------------------------------------------------------------ poll dedupe
 *
 * B14. The poll loop skipped a line whenever it matched the line the POLL had last delivered.
 * That is not what its comment claimed (a duplicate the SOCKET already sent) and it silently
 * swallowed a genuine repeat: three identical consecutive lines in battle.log reached the
 * parser exactly once. The log is the authority on what happened, so the skip must be keyed on
 * the socket being the last thing to deliver the line, not on the poll repeating itself.
 */

const battle = { log: [], p1: { pokemon: [] }, p2: { pokemon: [] } };
sandbox.app = { curRoom: { battle: battle } };
const dbg = sandbox.__ST_INJECTED_DEBUG;
const flush = function () { sandbox.__ST_INJECTED_FLUSH(); };

let pollBefore = dbg.polled;
battle.log.push('|-unboost|p2a: Ursaluna|def|-1',
                '|-unboost|p2a: Ursaluna|def|-1',
                '|-unboost|p2a: Ursaluna|def|-1');
flush();
eq('three identical consecutive lines all reach the pipeline', dbg.polled - pollBefore, 3);

pollBefore = dbg.polled;
battle.log.push('|upkeep', '|upkeep');
flush();
eq('two identical consecutive lines both reach the pipeline', dbg.polled - pollBefore, 2);

pollBefore = dbg.polled;
flush();
eq('a poll with nothing new forwards nothing', dbg.polled - pollBefore, 0);

/* The dedupe still has to do its real job: a line the SOCKET just delivered must not be
 * delivered a second time by the poll that then reads it out of the log. */
const socketLine = '|move|p2a: Ursaluna|Close Combat|p1a: Dragapult';
battle.log.push(socketLine);
const dispatchedBefore = dbg.dispatched;
pollBefore = dbg.polled;
sock._om({ data: socketLine });
eq('the socket delivered the line', dbg.dispatched - dispatchedBefore, 1);
flush();
eq('and the poll does not deliver it again', dbg.polled - pollBefore, 0);

pollBefore = dbg.polled;
battle.log.push('|turn|4');
flush();
eq('the poll resumes on the next genuinely new line', dbg.polled - pollBefore, 1);

/* ------------------------------------------------------------------ one frame, one forward
 *
 * B15. A socket can carry our capture TWICE. Setting `socket.onmessage` and calling
 * `socket.addEventListener('message', ...)` are two independent registrations, and if a page
 * does both — Showdown plus any other script on the page, or Playwright's own WebSocket mock —
 * both wrappers see the SAME MessageEvent and both forward it. Most protocol lines are
 * absolute so the second copy is invisible, but `|-boost|p1a|atk|1` is relative: forwarded
 * twice it becomes +2, and `|turn|n` twice re-opens a decision window. The fix keys the
 * capture on the event object, which is the delivery's identity.
 */
const dual = new WS('wss://sim.smogon.com/showdown/websocket');
let dualAccessor = null;
let dualListener = null;
dual.onmessage = function (e) { dualAccessor = e.data; };
dual.addEventListener('message', function (e) { dualListener = e.data; });
const dualAddWrapper = dual._listeners[dual._listeners.length - 1][1];

const frame = { data: '|-boost|p1a: Great Tusk|atk|1' };
let dualDispatched = dbg.dispatched;
let dualReceived = dbg.received;
dual._om(frame);              // the onmessage registration
dualAddWrapper(frame);        // the addEventListener registration, SAME event
eq('a frame seen by two listeners is forwarded once', dbg.dispatched - dualDispatched, 1);
eq('and counted once', dbg.received - dualReceived, 1);
eq('the onmessage handler still ran', dualAccessor, '|-boost|p1a: Great Tusk|atk|1');
eq('the addEventListener handler still ran', dualListener, '|-boost|p1a: Great Tusk|atk|1');

/* The guard must be keyed on identity, not on content: two frames with identical text are two
 * things that happened. */
const twinA = { data: '|upkeep' };
const twinB = { data: '|upkeep' };
dualDispatched = dbg.dispatched;
dual._om(twinA);
dual._om(twinB);
eq('two identical frames on distinct events are both forwarded', dbg.dispatched - dualDispatched, 2);

/* ------------------------------------------------------------------ a multi-line frame
 *
 * The page APPENDS every line it receives to battle.log as well as delivering it on the socket, so
 * after a multi-line frame the poll finds the frame's EARLIER lines "new" — the old dedupe only
 * remembered the LAST line of the frame — and hands all of them over a second time. Re-delivery
 * is silent for absolute lines and wrong for relative ones: `|-boost|p1a|atk|1` twice is +2, a
 * `|pp|` is decremented twice, and `|turn|n` twice double-ticks the Trick Room / weather / Protect
 * clocks. The socket path now remembers the run it delivered and the poll claims it positionally
 * at the cursor, so this frame must reach the pipeline exactly once while a genuine repeat in the
 * log still gets through.
 */
const frameLines = ['|turn|5', '|move|p2a: Ursaluna|Headlong Rush|p1a: Dragapult', '|-boost|p2a: Ursaluna|atk|1'];
battle.log.push.apply(battle.log, frameLines);
let mlDispatched = dbg.dispatched;
sock._om({ data: frameLines.join('\n') });
eq('a three-line frame reaches the pipeline once', dbg.dispatched - mlDispatched, 3);

let mlPolled = dbg.polled;
flush();
eq('and the poll does not hand the same frame over again', dbg.polled - mlPolled, 0);

mlPolled = dbg.polled;
battle.log.push('|turn|6');
flush();
eq('a genuinely new line still reaches the pipeline after a claimed frame', dbg.polled - mlPolled, 1);

mlPolled = dbg.polled;
battle.log.push('|turn|6');
flush();
// A ZERO here is the bug this guards against: the claimed run must not have eaten the next
// entry, even though it is byte-identical to a line the pipeline has already seen.
eq('...and a genuine repeat of it is not eaten', dbg.polled - mlPolled, 1);

/* A frame the client does NOT mirror into battle.log must not stall the claim for later frames:
 * the batch is dropped after one attempt, never retried forever. */
mlPolled = dbg.polled;
mlDispatched = dbg.dispatched;
const unlogged = '|request|{"rqid":9}';
sock._om({ data: unlogged });
eq('a frame the log never mirrors is still forwarded', dbg.dispatched - mlDispatched, 1);
const afterUnlogged = ['|turn|7', '|-damage|p2a: Ursaluna|62/100'];
battle.log.push.apply(battle.log, afterUnlogged);
sock._om({ data: afterUnlogged.join('\n') });
flush();
eq('and it does not block the next frame from being claimed', dbg.polled - mlPolled, 0);

/* ------------------------------------------------------------------ the live client
 *
 * The client served at play.pokemonshowdown.com is NOT the one the WebSocket patch was written
 * for: it keeps the raw lines in `battle.stepQueue` and exposes `battle.log(args, kwArgs,
 * preempt)` as a METHOD, and its connection is not a page WebSocket at all. Measured live with
 * this extension side-loaded, a joined battle room left the counters at `received: 4, polled: 0`
 * — nothing reached the parser — so the HUD never saw a request, a Trick Room field or a Mega.
 * The two checks below pin the two halves of the fix.
 */

/* (1) `battle.log` is a method on the live client. The old guard asked `typeof log.length`,
 * which for a function is its ARITY — 3 — so it accepted the method and then read `undefined`
 * forever. A function must never be treated as a log, and the raw queue must be used instead. */
const liveBattle = {
  stepQueue: [],
  // Exactly the live signature, so `battle.log.length` really is 3 (the arity that fooled the
  // old guard) — the test must reproduce the shape, not a convenient stand-in.
  log: function log(args, kwArgs, preempt) { return [args, kwArgs, preempt]; },
  p1: { pokemon: [] },
  p2: { pokemon: [] }
};
eq('the live client\'s log really is a 3-arity method', liveBattle.log.length, 3);
sandbox.app.curRoom = { battle: liveBattle };
let livePolled = dbg.polled;
flush();
eq('a function battle.log is never read as a log', dbg.polled - livePolled, 0);

livePolled = dbg.polled;
liveBattle.stepQueue.push('|turn|1', '|switch|p1a: Great Tusk|Great Tusk, L50, M|100/100');
flush();
eq('the raw stepQueue delivers the new client\'s lines', dbg.polled - livePolled, 2);

/* (2) app.receive is the transport-agnostic entry point. Battle frames are forwarded verbatim,
 * non-battle rooms are left alone, and the page's own handler still runs (the extension must be
 * transparent to Showdown). */
let receivedInPage = null;
const appObj = {
  curRoom: { id: 'battle-gen9nationaldexou-1', battle: liveBattle },
  receive: function (data) { receivedInPage = data; return 'handled'; }
};
sandbox.app = appObj;
flush();                                          // installs the hook on the poll tick
check('the receive hook is installed',
  typeof appObj.receive === 'function' && appObj.receive.__stWrapped === true,
  'receive was not wrapped');

let hookDispatched = dbg.dispatched;
const battleFrame = '>battle-gen9nationaldexou-1\n|turn|2\n|-fieldstart|move: Trick Room|[of] p2a: Slowking';
const returned = appObj.receive(battleFrame);
eq('a battle frame is forwarded line by line', dbg.dispatched - hookDispatched, 2);
eq('the room header is not a protocol line', dbg.frames, 1);
eq('the page still receives its own frame verbatim', receivedInPage, battleFrame);
eq('the wrapped receive returns what the page returned', returned, 'handled');

hookDispatched = dbg.dispatched;
appObj.receive('>lobby\n|message|hello lobby');
eq('non-battle room traffic is not forwarded', dbg.dispatched - hookDispatched, 0);

/* ONE FRAME, ONE FORWARDER. Once app.receive has delivered a line it owns the inbound path: the
 * WebSocket capture must stand down and the buffer poll must stop, or the same `|turn|` would be
 * applied twice (which double-ticks the Trick Room / weather / Protect clocks). */
hookDispatched = dbg.dispatched;
sock._om({ data: '|-boost|p1a: Great Tusk|atk|1' });
eq('the socket capture stands down once receive is hooked', dbg.dispatched - hookDispatched, 0);

liveBattle.stepQueue.push('|turn|3');
livePolled = dbg.polled;
flush();
eq('and the buffer poll stops behind app.receive', dbg.polled - livePolled, 0);

/* A payload with no `>` header belongs to the current room, which is a battle here. */
hookDispatched = dbg.dispatched;
appObj.receive('|-damage|p1a: Great Tusk|55/100');
eq('a roomless payload for a battle room is forwarded', dbg.dispatched - hookDispatched, 1);

const betaEvents = [];
const betaDoc = {
  readyState: 'complete',
  documentElement: { dataset: {}, setAttribute: function (key, value) { this[key] = value; } },
  addEventListener: function () {},
  dispatchEvent: function (event) { betaEvents.push(event.detail.rawLine); }
};
const betaBattle = { stepQueue: ['|init|battle', '|turn|7'] };
const betaRoom = { id: 'battle-beta-1', battle: betaBattle };
const betaClient = { room: betaRoom, baseRoom: betaRoom, receive: function (data) { return data; } };
const betaSandbox = {
  document: betaDoc, PS: betaClient,
  setInterval: function () { return { unref: function () {} }; }, clearInterval: function () {},
  CustomEvent: function (name, options) { this.detail = options.detail; }
};
betaSandbox.window = betaSandbox;
vm.createContext(betaSandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'injected.js'), 'utf8'), betaSandbox);
betaSandbox.__ST_INJECTED_FLUSH();
eq('beta PS.room exposes the current battle without window.app', betaEvents.slice(0, 2), ['|init|battle', '|turn|7']);
eq('the room id crosses the isolated-world boundary', betaDoc.documentElement['data-st-room'], betaRoom.id);
let betaBefore = betaEvents.length;
betaClient.receive('>battle-other-1\n|turn|99');
eq('an inactive room cannot contaminate the current battle', betaEvents.length, betaBefore);
eq('the beta client still receives its original frame', betaClient.receive('>battle-beta-1\n|turn|8'), '>battle-beta-1\n|turn|8');
eq('the focused beta room receives a frame once', betaEvents.length, betaBefore + 1);
const secondRoom = { id: 'battle-beta-2', battle: { stepQueue: ['|tier|[Gen 9] National Dex OU', '|turn|3'] }, request: { active: [], side: { id: 'p1', pokemon: [] } } };
betaClient.room = betaClient.baseRoom = secondRoom;
betaBefore = betaEvents.length;
betaSandbox.__ST_INJECTED_FLUSH();
eq('changing rooms resets state before replaying the new board', betaEvents.slice(betaBefore, betaBefore + 3), ['|init|battle', '|tier|[Gen 9] National Dex OU', '|turn|3']);
check('changing rooms restores the live decision request', betaEvents[betaEvents.length - 1].startsWith('|request|'));
betaClient.room = { id: 'options' };
betaSandbox.__ST_INJECTED_FLUSH();
eq('a beta popup retains its underlying battle', betaDoc.documentElement['data-st-room'], secondRoom.id);

console.log('checks passed: ' + passed + '  failed: ' + failures.length);
failures.forEach(function (f) { console.log('  x ' + f); });
process.exit(failures.length ? 1 : 0);
