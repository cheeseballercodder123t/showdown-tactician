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
 *      cursor so no line is ever emitted twice — the cursor is also advanced over the runs the
 *      socket path already delivered, since the page mirrors those same lines into the log
 *   4. the PP snapshot (ARCHITECTURE §6.4): the page's own battle object holds every body's
 *      move slots with their REAL pp/maxpp, which the protocol stream never reveals for the
 *      opponent. Once per poll — and only when a number actually changed — each slot is
 *      forwarded as the synthetic protocol line `|stpp|<ident>|<moveid>|<pp>|<maxpp>`, which
 *      the ISOLATED-world parser reads like any other line. Max PP is game data the engine may
 *      not invent, so it is measured here instead.
 *   5. the accuracy snapshot (ARCHITECTURE §6.5): the vendored damage bundle carries no accuracy
 *      data at all, and the risk-adjusted scoring needs it, so every move either side holds is
 *      looked up in the CLIENT's own dex and forwarded once as `|stacc|<moveid>|<accuracy>`
 *      (`true` = cannot miss). Again: measured from the page, never hardcoded.
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

  var counters = { sent: 0, received: 0, polled: 0, dispatched: 0, errors: 0, ppSnapshots: 0, accuracy: 0, frames: 0 };
  window.__ST_INJECTED_DEBUG = counters;

  /* The last line handed to the pipeline, and WHICH path handed it over.
   *
   * The poll path is the only one that can re-deliver something the socket path already
   * delivered, so the skip in pollBattleLog has to know who went last. Comparing poll against
   * poll cannot tell a socket duplicate from a genuine repeat in the log, and the version that
   * did exactly that silently ate the genuine repeat: three identical consecutive lines in
   * battle.log reached the parser once. The log is the authority on what happened, so a line
   * is only ever skipped when the SOCKET was the last thing to deliver it.
   */
  var lastForwarded = { line: null, kind: null };

  /* The socket path and the poll path see the same battle from two directions.
   *
   * The page APPENDS every protocol line it receives to `battle.log` as well as delivering it on
   * the socket, so a line the socket already forwarded is still sitting in the log for the next
   * poll to hand over a second time. `lastForwarded` can only remember ONE line, and a single
   * WebSocket frame routinely carries several (`|turn|3` then `|move|...` then `|-damage|...`), so
   * after a three-line frame that slot holds the frame's LAST line and the poll finds the earlier
   * two "new" — re-delivering all three. It is worth being precise about the damage, because most
   * protocol lines are absolute and hide it: `|-boost|p1a|atk|1` twice is +2, a `|pp|` is
   * decremented twice, `_recordDamageObservation` records the hit twice, and `|turn|n` twice
   * double-ticks Trick Room, the weather and terrain timers and both Protect-rhythm counters,
   * because the state manager's turn hook is not idempotent. The existing tests only ever pushed
   * ONE line per frame, which is why this stayed invisible.
   *
   * So the socket path now remembers WHAT IT DELIVERED, batch by batch, and the poll tries to
   * claim that run positionally before it reads anything. The test is deliberately narrow: the run
   * is claimed only when it sits EXACTLY at the cursor, so a line the socket delivered is never
   * credited to a log entry the poll still has to read, and a genuine repeat appended later in the
   * log is outside the batch's own run and therefore still delivered (the B14 rule). The queue is
   * drained on every poll — a batch gets one chance to be claimed and is then forgotten — because
   * the log, not this bookkeeping, is the authority on what happened: a batch that does not align
   * (a line the client never logs, a frame the page reorders) simply falls back to the old
   * last-line comparison, and it can never block a later batch or grow without bound.
   */
  var pendingSocketBatches = [];

  /* The last inbound event object we forwarded.
   *
   * ONE FRAME MUST BE FORWARDED ONCE, NO MATTER HOW MANY LISTENERS THE PAGE INSTALLS. A page
   * that sets `socket.onmessage` AND calls `socket.addEventListener('message', ...)` ends up
   * with two of our wrappers on the same socket, and both of them see the SAME MessageEvent.
   * Forwarding it twice is not harmless: most Showdown lines are absolute (a damage line is
   * idempotent), but the relative ones are not — `|-boost|p1a|atk|1` applied twice is +2, and
   * `|turn|n` twice re-opens a decision window. Playwright's WebSocket mock installs its own
   * 'message' listener, which is how this was caught in a real browser (BUGS_AUDIT_REPORT.md,
   * B15); the same shape appears in the wild whenever two scripts share a socket.
   *
   * The event object IS the delivery's identity, so a single-slot reference is enough: both
   * wrappers run synchronously inside the same dispatch, and no two frames reuse an event.
   */
  var lastInboundEvent = null;

  function captureInbound(event) {
    if (event && event === lastInboundEvent) return;
    lastInboundEvent = event || null;
    // One frame, one forwarder. Once app.receive is hooked it sees the same bytes (and sees
    // them on every transport), so this path must stand down rather than deliver twice.
    if (appReceiveHooked) return;
    try {
      counters.received++;
      forwardBatch(typeof event.data === 'string' ? event.data : '', 'recv');
    } catch (e) { counters.errors++; }
  }

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
    lastForwarded.line = rawLine;
    lastForwarded.kind = kind || 'unknown';
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

  function forwardBatch(text, kind, claimable) {
    if (typeof text !== 'string' || !text) return;
    // A single frame can carry several newline separated protocol lines.
    var parts = text.split('\n');
    var delivered = [];
    for (var i = 0; i < parts.length; i++) {
      var line = parts[i];
      if (line && line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
      if (line) {
        forward(line, kind);
        delivered.push(line);
      }
    }
    // Only INBOUND battle traffic is mirrored into the client's line buffer, so only that needs
    // claiming; see pendingSocketBatches for why the whole run has to be remembered and not just
    // its last line. A caller that owns the ONLY inbound path (`claimable === false`) has nothing
    // for the poll to claim.
    if (kind === 'recv' && delivered.length && claimable !== false) pendingSocketBatches.push(delivered);
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
          captureInbound(event);
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
              captureInbound(event);
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

  /* -------------------------------------------------------- app.receive capture
   *
   * WHY THIS EXISTS. The WebSocket patch above is the OLD client's path. The client served at
   * play.pokemonshowdown.com today does not expose the connection as a page WebSocket at all:
   * `window.app.socket` is a SockJS object (`_transports` / `_transport`, no `.socket`), and the
   * runtime check `WebSocket.prototype.send.__stWrapped` is FALSE on the live page. Measured
   * with this extension side-loaded: after joining a real battle room the counters were still
   * `{sent:2, received:4, polled:0}` — not one battle line ever reached the parser, so the HUD
   * never got a `|request|`, a `|fieldstart|` or a `|-mega|` and sat on its Turn-0 text forever.
   *
   * `app.receive(data)` is the transport-agnostic entry point: the client hands the RAW server
   * text to it (worker, SockJS or plain socket — all of them end here, client-core receive()).
   * `data` is `>roomid\n|line\n|line...` for room traffic; a payload with no `>` header belongs
   * to `app.curRoom`. Only battle rooms are forwarded, so chat / PM / lobby traffic stays out of
   * the parser's hot path.
   *
   * Once this hook is live it becomes the ONLY inbound path — the WebSocket forwarder stands
   * down (see captureInbound) so one frame can never be delivered twice, and the poll stops
   * reading the buffer once a line has actually come through here. The hook is installed from
   * the 250 ms tick, so it is in place well before the player's first battle join.
   */
  var appReceiveHooked = false;
  var appReceiveLines = 0;

  function forwardFrame(data) {
    if (typeof data !== 'string' || !data) return 0;
    var body = data;
    if (body.charAt(0) === '>') {
      var nl = body.indexOf('\n');
      if (nl < 0) return 0;
      var roomid = body.slice(1, nl).trim();
      body = body.slice(nl + 1);
      if (!/^battle-/.test(roomid)) return 0;
    } else {
      var room = window.app && window.app.curRoom;
      if (!room || !/^battle-/.test(String(room.id || ''))) return 0;
    }
    if (!body) return 0;
    counters.frames++;
    // `claimable: false` — the poll never reads this delivery back (it is the authority once a
    // line has arrived here), so the batch bookkeeping would only grow without bound.
    forwardBatch(body, 'recv', false);
    appReceiveLines += body.split('\n').length;
    return true;
  }

  /** Wrap window.app.receive once. Idempotent; returns true when the hook is live. */
  function hookAppReceive() {
    if (appReceiveHooked) return true;
    try {
      var app = window.app;
      if (!app || typeof app.receive !== 'function') return false;
      var nativeReceive = app.receive;
      var wrapped = function receive(data) {
        try { forwardFrame(data); } catch (e) { counters.errors++; }
        return nativeReceive.apply(this, arguments);
      };
      wrapped.__stWrapped = true;
      app.receive = wrapped;
      appReceiveHooked = true;
      return true;
    } catch (e) { counters.errors++; return false; }
  }

  /* ------------------------------------------------------------------ PP snapshot */

  // The last PP table we forwarded, so an unchanged battle costs nothing. PP only moves when a
  // move is clicked, so this fires a handful of times per battle.
  var lastPpSignature = '';

  function sideIdent(sideKey, index, name) {
    // Showdown's own convention: p1a/p1b are the first two entries of the side's roster.
    return sideKey + String.fromCharCode(97 + index) + ': ' + name;
  }

  function collectMoveSlots(battle) {
    var out = [];
    var sides = ['p1', 'p2'];
    for (var s = 0; s < sides.length; s++) {
      var key = sides[s];
      var side = battle[key];
      var roster = side && side.pokemon;
      if (!roster || typeof roster.length !== 'number') continue;
      for (var i = 0; i < roster.length; i++) {
        var mon = roster[i];
        if (!mon) continue;
        var slots = mon.moveSlots;
        if (!slots || typeof slots.length !== 'number') continue;
        var name = mon.name || mon.speciesForme || mon.species || 'unknown';
        for (var k = 0; k < slots.length; k++) {
          var mv = slots[k];
          if (!mv) continue;
          var id = mv.id || (mv.move ? String(mv.move).toLowerCase().replace(/[^a-z0-9]/g, '') : '');
          if (!id) continue;
          if (typeof mv.pp !== 'number' && typeof mv.maxpp !== 'number') continue;
          out.push([sideIdent(key, i, name), id, mv.pp, mv.maxpp]);
        }
      }
    }
    return out;
  }

  function pollPpSnapshot() {
    try {
      var app = window.app;
      var room = app && app.curRoom;
      var battle = room && room.battle;
      if (!battle) return;
      var rows = collectMoveSlots(battle);
      if (!rows.length) return;
      var signature = '';
      for (var i = 0; i < rows.length; i++) {
        signature += rows[i][0] + '|' + rows[i][1] + '|' + rows[i][2] + '|' + rows[i][3] + ';';
      }
      if (signature === lastPpSignature) return;
      lastPpSignature = signature;
      for (var j = 0; j < rows.length; j++) {
        var row = rows[j];
        counters.ppSnapshots++;
        forward('|stpp|' + row[0] + '|' + row[1] + '|' + row[2] + '|' + row[3], 'pp');
      }
    } catch (e) { counters.errors++; }
  }

  /* ---------------------------------------------------------------- accuracy snapshot */

  var lastAccuracySignature = '';

  /** The client's own move dex entry for a move id, or null. Never invents a default. */
  function clientMoveData(battle, id) {
    try {
      if (battle && battle.dex && battle.dex.moves && typeof battle.dex.moves.get === 'function') {
        const mv = battle.dex.moves.get(id);
        if (mv) return mv;
      }
      if (window.BattleMovedex && window.BattleMovedex[id]) return window.BattleMovedex[id];
      if (window.BattleMovedex && window.BattleMovedex[id.replace(/[^a-z0-9]/g, '')]) {
        return window.BattleMovedex[id.replace(/[^a-z0-9]/g, '')];
      }
    } catch (e) { /* a client build without a readable dex simply yields nothing */ }
    return null;
  }

  function pollAccuracySnapshot(battle) {
    try {
      if (!battle) return;
      var ids = [];
      var seen = {};
      var sides = ['p1', 'p2'];
      for (var s = 0; s < sides.length; s++) {
        var roster = battle[sides[s]] && battle[sides[s]].pokemon;
        if (!roster || typeof roster.length !== 'number') continue;
        for (var i = 0; i < roster.length; i++) {
          var slots = roster[i] && roster[i].moveSlots;
          if (!slots || typeof slots.length !== 'number') continue;
          for (var k = 0; k < slots.length; k++) {
            var id = slots[k] && (slots[k].id || (slots[k].move ? String(slots[k].move).toLowerCase().replace(/[^a-z0-9]/g, '') : ''));
            if (!id || seen[id]) continue;
            seen[id] = true;
            ids.push(id);
          }
        }
      }
      if (!ids.length) return;
      var signature = ids.join(',');
      if (signature === lastAccuracySignature) return;
      var rows = [];
      for (var n = 0; n < ids.length; n++) {
        var data = clientMoveData(battle, ids[n]);
        if (!data || data.accuracy === undefined || data.accuracy === null) continue;
        rows.push(ids[n] + '|' + data.accuracy);
      }
      if (!rows.length) return;
      // Only remember the signature once something was actually forwarded, otherwise a client
      // whose dex is not readable yet would never be retried.
      lastAccuracySignature = signature;
      for (var r = 0; r < rows.length; r++) {
        counters.accuracy++;
        forward('|stacc|' + rows[r], 'accuracy');
      }
    } catch (e) { counters.errors++; }
  }

  /* ------------------------------------------------------------------ polling fallback */

  var pollCursor = 0;

  /**
   * Claim the log entries a socket batch already delivered, then forget the batch.
   *
   * A batch is only claimed when its whole run sits exactly at the cursor: the cursor is where the
   * poll's own delivery resumes, so anything before it has already been handed over and anything
   * after it is genuinely unread. A batch that does not line up is dropped rather than retried
   * forever, which keeps an unloggable line (one the client never mirrors into battle.log) from
   * stalling every later batch; the poll's own last-line comparison still covers the common case.
   */
  function claimPendingSocketBatches(log) {
    while (pendingSocketBatches.length) {
      var batch = pendingSocketBatches.shift();
      if (!batch || !batch.length) continue;
      var n = 0;
      while (n < batch.length && pollCursor + n < log.length && log[pollCursor + n] === batch[n]) n++;
      if (n === batch.length) {
        pollCursor += n;
        // The positional claim owns this delivery now, so the single-line fallback must step
        // aside: a GENUINE repeat of the last socket line is still in the log and must be
        // delivered, and the value comparison could not tell it from the copy we just consumed.
        lastForwarded.line = null;
        lastForwarded.kind = null;
      }
    }
  }

  /**
   * battleLogOf(battle) -> the raw protocol-line array, or null.
   *
   * THE NEW CLIENT DOES NOT KEEP THE LOG IN `battle.log`. There, `log(args, kwArgs, preempt)` is
   * a METHOD that paints a step into the scene, and the raw text lives in `battle.stepQueue`.
   * The old guard here asked `typeof log.length !== 'number'` and returned early — but a
   * function's `.length` is its ARITY, which is 3, so the guard PASSED and the loop then read
   * `log[0]`, `log[1]`, `log[2]` — all `undefined` — forever. That is why the fallback delivered
   * exactly nothing on the live client (observed: `polled: 0` while `battle.log.length` read 3 and
   * `battle.stepQueue` grew normally). Accept either shape, but never a function.
   */
  function battleLogOf(battle) {
    if (!battle) return null;
    var queue = battle.stepQueue;
    if (queue && typeof queue.length === 'number' && (queue.length === 0 || typeof queue[0] === 'string')) return queue;
    var log = battle.log;
    if (log && typeof log !== 'function' && typeof log.length === 'number' &&
        (log.length === 0 || typeof log[0] === 'string')) return log;
    return null;
  }

  /** The buffer fallback: read the client's own line queue behind a cursor. */
  function pollBattleBuffer(battle) {
    var log = battleLogOf(battle);
    if (!log) return;
    if (log.length < pollCursor) { // room reset / new battle
      pollCursor = 0;
      pendingSocketBatches.length = 0;
    }
    claimPendingSocketBatches(log);
    for (; pollCursor < log.length; pollCursor++) {
      var line = log[pollCursor];
      if (typeof line !== 'string' || !line) continue;
      // The polling path is the only one that can duplicate a line, because another path may
      // already have delivered it. Only the OTHER path counts as "already delivered":
      // two identical lines in the buffer are two things that happened, and dropping the
      // second one corrupts the state for the rest of the battle.
      if (line === lastForwarded.line && lastForwarded.kind !== 'poll') continue;
      counters.polled++;
      forward(line, 'poll');
    }
  }

  function pollBattleLog() {
    try {
      var app = window.app;
      var room = app && app.curRoom;
      var battle = room && room.battle;
      // Install the robust hook as soon as the page exposes its app — this tick is the retry
      // loop, so no separate timer is needed.
      hookAppReceive();
      // The buffer is a FALLBACK: it only speaks while app.receive has not delivered a line, so
      // the two paths never hand the same frame to the parser twice.
      if (!appReceiveHooked || !appReceiveLines) pollBattleBuffer(battle);
      pollPpSnapshot();
      pollAccuracySnapshot(battle);
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
  window.__ST_INJECTED_PP_FLUSH = pollPpSnapshot;
  window.__ST_INJECTED_ACC_FLUSH = function () {
    var battle = window.app && window.app.curRoom && window.app.curRoom.battle;
    return pollAccuracySnapshot(battle);
  };
})();
