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

console.log('checks passed: ' + passed + '  failed: ' + failures.length);
failures.forEach(function (f) { console.log('  x ' + f); });
process.exit(failures.length ? 1 : 0);
