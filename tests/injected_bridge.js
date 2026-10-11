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

console.log('checks passed: ' + passed + '  failed: ' + failures.length);
failures.forEach(function (f) { console.log('  x ' + f); });
process.exit(failures.length ? 1 : 0);
