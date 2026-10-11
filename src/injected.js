/* Showdown Tactician - src/injected.js  (MAIN world)
 *
 * The ONLY file that runs in the page's own JavaScript context. It never references ST,
 * ST.util or window.calc, and it never parses protocol lines: it only lifts raw lines out of
 * the page and hands them across the realm boundary as DOM events, where the ISOLATED-world
 * content script picks them up (see ARCHITECTURE.md section 4).
 *
 * What it captures:
 *   1. outgoing frames   - window.WebSocket.prototype.send  (/choose ...)
 *   2. incoming frames   - addEventListener('message') AND the onmessage property, on every
 *                          WebSocket instance ever constructed
 *   3. a polling fallback over window.app.curRoom.battle.log every 250 ms, kept behind a
 *      cursor so no line is ever emitted twice
 *
 * Each line is forwarded twice for robustness:
 *   document.dispatchEvent(new CustomEvent('ShowdownTactician_ProtocolEvent', {
 *     detail: { rawLine, kind, json: JSON.stringify({ rawLine, kind }) }
 *   }))
 * and mirrored into document.documentElement.dataset.stLine / .stLineKind for the case
 * where a realm boundary refuses to hand over the event detail object.
 *
 * Loaded by src/content.js through a <script src="chrome-extension://.../src/injected.js">
 * tag. Idempotent: re-injection is a no-op.
 */
(function () {
  'use strict';

  if (window.__ST_INJECTED__) return;
  window.__ST_INJECTED__ = true;

  var EVENT_NAME = 'ShowdownTactician_ProtocolEvent';
  var POLL_INTERVAL_MS = 250;
  var MAX_MIRROR_CHARS = 4000;

  var counters = { sent: 0, received: 0, polled: 0, dispatched: 0, errors: 0 };
  window.__ST_INJECTED_DEBUG = counters;

  /* ------------------------------------------------------------------ forwarding */

  function mirror(rawLine, kind) {
    try {
      var el = document.documentElement;
      if (!el || !el.dataset) return;
      el.dataset.stLine = rawLine.length > MAX_MIRROR_CHARS ? rawLine.slice(0, MAX_MIRROR_CHARS) : rawLine;
      el.dataset.stLineKind = kind;
      el.dataset.stLineSeq = String(counters.dispatched);
    } catch (e) { /* dataset mirroring is best effort only */ }
  }

  function forward(rawLine, kind) {
    if (typeof rawLine !== 'string' || !rawLine) return;
    try {
      counters.dispatched++;
      var payload = { rawLine: rawLine, kind: kind || 'unknown' };
      var detail = { rawLine: payload.rawLine, kind: payload.kind, json: JSON.stringify(payload) };
      var evt;
      try {
        evt = new CustomEvent(EVENT_NAME, { detail: detail, bubbles: false });
      } catch (e) {
        evt = document.createEvent('CustomEvent');
        evt.initCustomEvent(EVENT_NAME, false, false, detail);
      }
      document.dispatchEvent(evt);
    } catch (e) {
      counters.errors++;
    }
    mirror(rawLine, kind);
  }

  function forwardBatch(text, kind) {
    if (typeof text !== 'string' || !text) return;
    // A single WebSocket frame can carry several newline separated protocol lines.
    var parts = text.split('\n');
    for (var i = 0; i < parts.length; i++) {
      var line = parts[i];
      if (line && line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
      if (line) forward(line, kind);
    }
  }

  /* ------------------------------------------------------------------ websocket capture */

  var NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === 'function' && NativeWebSocket.prototype) {
    var nativeSend = NativeWebSocket.prototype.send;
    if (typeof nativeSend === 'function' && !nativeSend.__stWrapped) {
      var wrappedSend = function send(data) {
        try {
          if (typeof data === 'string') {
            counters.sent++;
            forwardBatch(data, 'send');
          }
        } catch (e) { counters.errors++; }
        return nativeSend.apply(this, arguments);
      };
      wrappedSend.__stWrapped = true;
      try { NativeWebSocket.prototype.send = wrappedSend; } catch (e) { counters.errors++; }
    }

    /* Inbound capture. Both spellings are covered, and neither may break the page:
     *
     *  a) addEventListener('message', fn) - wrapped per socket, the listener is called with
     *     the untouched event after we forward it.
     *  b) socket.onmessage = fn - the prototype accessor is wrapped ONCE so the native
     *     setter still registers a genuinely working handler; we simply call the original
     *     after forwarding. Shadowing the property instead would silently detach Showdown's
     *     own handler and freeze the battle, so this must stay an accessor delegation.
     */
    function findOnMessageDescriptor() {
      var proto = NativeWebSocket.prototype;
      while (proto) {
        var d = Object.getOwnPropertyDescriptor(proto, 'onmessage');
        if (d && d.set) return d;
        proto = Object.getPrototypeOf(proto);
      }
      return null;
    }

    var onMessageDescriptor = findOnMessageDescriptor();
    if (onMessageDescriptor && !onMessageDescriptor.set.__stWrapped) {
      var nativeSet = onMessageDescriptor.set;
      var nativeGet = onMessageDescriptor.get;
      var wrappedSet = function (handler) {
        var socket = this;
        var wrapped = handler == null ? null : function (event) {
          try {
            counters.received++;
            forwardBatch(typeof event.data === 'string' ? event.data : '', 'recv');
          } catch (e) { counters.errors++; }
          if (typeof handler === 'function') return handler.call(socket, event);
          if (handler && typeof handler.handleEvent === 'function') return handler.handleEvent(event);
          return undefined;
        };
        return nativeSet.call(this, wrapped);
      };
      wrappedSet.__stWrapped = true;
      try {
        Object.defineProperty(NativeWebSocket.prototype, 'onmessage', {
          configurable: true,
          enumerable: onMessageDescriptor.enumerable,
          get: function () { return nativeGet ? nativeGet.call(this) : null; },
          set: wrappedSet
        });
      } catch (e) { counters.errors++; }
    }

    var NativeAddEventListener = NativeWebSocket.prototype.addEventListener;
    function patchSocket(socket) {
      if (!socket || socket.__stPatched) return;
      socket.__stPatched = true;
      try {
        var nativeAdd = socket.addEventListener;
        socket.addEventListener = function (type, listener, options) {
          if (type === 'message' && typeof listener === 'function') {
            var wrapped = function (event) {
              try {
                counters.received++;
                forwardBatch(typeof event.data === 'string' ? event.data : '', 'recv');
              } catch (e) { counters.errors++; }
              return listener.apply(this, arguments);
            };
            return nativeAdd.call(this, type, wrapped, options);
          }
          return nativeAdd.apply(this, arguments);
        };
      } catch (e) { counters.errors++; }
    }

    // Wrap the constructor so every socket created after us is patched immediately, and
    // patch the native addEventListener too as a belt-and-braces inbound hook.
    try {
      var WrappedWebSocket = function WebSocket(url, protocols) {
        var socket = protocols === undefined
          ? new NativeWebSocket(url)
          : new NativeWebSocket(url, protocols);
        patchSocket(socket);
        return socket;
      };
      WrappedWebSocket.prototype = NativeWebSocket.prototype;
      WrappedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
      WrappedWebSocket.OPEN = NativeWebSocket.OPEN;
      WrappedWebSocket.CLOSING = NativeWebSocket.CLOSING;
      WrappedWebSocket.CLOSED = NativeWebSocket.CLOSED;
      WrappedWebSocket.__stWrapped = true;
      window.WebSocket = WrappedWebSocket;
    } catch (e) { counters.errors++; }

    if (NativeAddEventListener && !NativeAddEventListener.__stWrapped) {
      var wrappedAdd = function (type, listener, options) {
        if (type === 'message') patchSocket(this);
        return NativeAddEventListener.apply(this, arguments);
      };
      wrappedAdd.__stWrapped = true;
      try { NativeWebSocket.prototype.addEventListener = wrappedAdd; } catch (e) { counters.errors++; }
    }
  }

  /* ------------------------------------------------------------------ polling fallback */

  var pollCursor = 0;
  var lastPolledLine = null;

  function pollBattleLog() {
    try {
      var app = window.app;
      var room = app && app.curRoom;
      var battle = room && room.battle;
      var log = battle && battle.log;
      if (!log || typeof log.length !== 'number') return;
      if (log.length < pollCursor) pollCursor = 0; // room reset / new battle
      for (; pollCursor < log.length; pollCursor++) {
        var line = log[pollCursor];
        if (typeof line !== 'string' || !line) continue;
        // The polling path is the only one that can duplicate a line, because the socket
        // path may already have delivered it: skip an immediate repeat, otherwise emit.
        if (line === lastPolledLine) continue;
        lastPolledLine = line;
        counters.polled++;
        forward(line, 'poll');
      }
    } catch (e) {
      counters.errors++;
    }
  }

  var pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollBattleLog, POLL_INTERVAL_MS);
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function boot() {
    if (!document || !document.documentElement) return;
    startPolling();
    // Showdown exposes the global app shortly after load; kick once the room exists.
    var tries = 0;
    var wait = setInterval(function () {
      tries++;
      if ((window.app && window.app.curRoom && window.app.curRoom.battle) || tries > 120) {
        clearInterval(wait);
        pollBattleLog();
      }
    }, 250);
    if (wait && typeof wait.unref === 'function') wait.unref();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // Expose a manual trigger for diagnostics from the page console.
  window.__ST_INJECTED_FLUSH = pollBattleLog;
})();
