/* Showdown Tactician — src/opponent_clock.js
 *
 * Opponent deliberation telemetry — the screen-reader's answer to "did they actually think?"
 *
 * WHAT IS MEASURABLE, AND WHY IT IS THIS AND NOT SOMETHING SIMPLER
 *   Both players submit through the same server, and the battle stream only reveals a turn once
 *   BOTH choices are in. So for the frame we care about:
 *
 *     |request|        the server opens OUR decision window (it is a frame of its own, so
 *                      injected.js forwards it like any protocol line)
 *     /choose          our own click leaves the client (kind === 'send')
 *     |turn|N+1 or the first |move|/|switch| line after it
 *                      the turn RESOLVED, i.e. the opponent had submitted by now
 *
 *   `turnResolution - mySubmit` is therefore an upper bound on how much longer the opponent took
 *   than we did, and the smallest value the battle ever produces is the noise floor (network
 *   round-trip plus the server's own resolution). Everything above that floor is the opponent
 *   still sitting on their decision. This is why the estimator is a MINIMUM and not an average:
 *   the floor has to be learned from the battle, because it is machine- and connection-specific.
 *
 *   The honest limits: a player who has already clicked and is watching an animation looks
 *   identical to a fast player, and a long floor sample (a lag spike) makes everything after it
 *   look slow. Both are why the label needs `clock.minSamples` samples before it says anything
 *   other than 'unknown', and why the whole readout is exposed on the HUD instead of being
 *   hidden inside a score.
 *
 * WHAT IT IS ALLOWED TO CHANGE
 *   One number, and only one: `switchFactor()` scales the payoff weight of the opponent's SWITCH
 *   replies in the simultaneous matrix (src/laplace_core.js). The factors in `clock.switchPrior`
 *   are priors, not measurements — the same standing as tempo.rhythmHurt — and they are in
 *   config.js precisely so a replay corpus can fit them later.
 *
 * Nothing here throws: a battle log always contains frames this module has never seen.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});

  // Rule 4: heuristics live in src/config.js. The literals are the standalone fallback.
  const cfg = ST.configGet || function (path, fallback) { return fallback; };
  // Only describe() needs a formatter, so util stays optional and this module can load alone.
  const U = ST.util || { round1: function (x) { return Math.round(x * 10) / 10; } };

  const CHOOSE_RE = /^\/choose\b/;
  const REQUEST_RE = /^\|request\|/;
  const TURN_RE = /^\|turn\|(\d+)/;
  // Any of these surfacing after our /choose means the server had both submissions.
  const RESOLUTION_RE = /^\|(move|switch|drag|swap|cant|faint|upkeep|turn)\|/;

  function defaultNow() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  class OpponentClock {
    constructor(options) {
      const opts = options || {};
      this.enabled = opts.enabled === undefined ? cfg('clock.enabled', true) !== false : !!opts.enabled;
      this.now = typeof opts.now === 'function' ? opts.now : defaultNow;
      this.fastMs = typeof opts.fastMs === 'number' ? opts.fastMs : cfg('clock.fastMs', 1200);
      this.slowMs = typeof opts.slowMs === 'number' ? opts.slowMs : cfg('clock.slowMs', 20000);
      this.minSamples = typeof opts.minSamples === 'number' ? opts.minSamples : cfg('clock.minSamples', 2);
      this.maxHistory = typeof opts.maxHistory === 'number' ? opts.maxHistory : cfg('clock.maxHistory', 20);
      this.reset();
    }

    reset() {
      this.turn = 0;
      this.requestTs = null;    // when the server opened the window we are in
      this.mySubmitTs = null;   // when our own /choose left the client
      this.floorMs = null;      // smallest `lead` seen == network + resolution overhead
      this.history = [];        // { turn, mySubmitMs, leadMs, extraMs, label }
      this.last = null;
      return this;
    }

    /* ----------------------------------------------------------------- ingest */

    /**
     * note(rawLine, kind, ts) — feed EVERY protocol line, before the parser sees it.
     * `kind` is the injector's own tag: 'send' for our outgoing /choose, 'recv'/'poll' for the
     * battle stream. `ts` defaults to a monotonic `performance.now()` in ms. Returns this.
     */
    note(rawLine, kind, ts) {
      if (!this.enabled || typeof rawLine !== 'string' || !rawLine) return this;
      const t = typeof ts === 'number' && isFinite(ts) ? ts : this.now();
      try {
        if (REQUEST_RE.test(rawLine)) {
          // A new window only opens while we are not already waiting to see what they did.
          if (this.mySubmitTs === null) this.requestTs = t;
          return this;
        }
        if (CHOOSE_RE.test(rawLine) && kind !== 'recv') {
          if (this.mySubmitTs === null) this.mySubmitTs = t;
          return this;
        }
        const turn = TURN_RE.exec(rawLine);
        if (turn) {
          // Close whatever window was open FIRST (the |turn| header is the resolution marker of
          // the previous turn), then adopt the new turn number.
          this._close(t);
          const n = parseInt(turn[1], 10);
          if (isFinite(n) && n > this.turn) this.turn = n;
          this.requestTs = null;
          this.mySubmitTs = null;
          return this;
        }
        if (this.mySubmitTs !== null && RESOLUTION_RE.test(rawLine)) this._close(t);
      } catch (e) { /* telemetry must never break the pipeline */ }
      return this;
    }

    /** Fold one completed window into the history. Idempotent per window. */
    _close(resolvedAt) {
      if (this.mySubmitTs === null) return null;
      const submitTs = this.mySubmitTs;
      const leadMs = resolvedAt - submitTs;
      this.mySubmitTs = null;
      const mySubmitMs = this.requestTs === null ? null : Math.max(0, submitTs - this.requestTs);
      this.requestTs = null;
      if (!(leadMs >= 0)) return null;                     // clock skew: drop the sample
      if (this.floorMs === null || leadMs < this.floorMs) this.floorMs = leadMs;
      const sample = {
        turn: this.turn,
        mySubmitMs: mySubmitMs,
        leadMs: leadMs,                                    // raw wait after our submit
        extraMs: Math.max(0, leadMs - this.floorMs),        // ...minus the learned floor
        label: 'unknown'
      };
      this.history.push(sample);
      while (this.history.length > this.maxHistory) this.history.shift();
      sample.label = this.labelFor(sample.extraMs);
      this.last = sample;
      return sample;
    }

    /* -------------------------------------------------------------- readout */

    /** 'auto' | 'normal' | 'agonised' | 'unknown' for one extra-latency reading. */
    labelFor(extraMs) {
      if (this.history.length < this.minSamples) return 'unknown';
      if (!(extraMs > this.fastMs)) return 'auto';
      if (extraMs >= this.slowMs) return 'agonised';
      return 'normal';
    }

    label() { return this.last ? this.last.label : 'unknown'; }

    /** The ONE thing the engine consumes: a multiplier on opponent switch replies. */
    switchFactor() {
      const label = this.label();
      const factor = cfg('clock.switchPrior.' + label,
        cfg('clock.switchPrior.unknown', 1));
      return typeof factor === 'number' && isFinite(factor) && factor > 0 ? factor : 1;
    }

    /** Plain snapshot for the HUD and for state.clock (never a live object reference). */
    snapshot() {
      let sum = 0;
      for (let i = 0; i < this.history.length; i++) sum += this.history[i].extraMs;
      return {
        enabled: this.enabled,
        turn: this.turn,
        samples: this.history.length,
        floorMs: this.floorMs,
        lastMs: this.last ? this.last.extraMs : null,
        lastLeadMs: this.last ? this.last.leadMs : null,
        myLastMs: this.last ? this.last.mySubmitMs : null,
        meanMs: this.history.length ? Math.round(sum / this.history.length) : null,
        label: this.label(),
        switchFactor: this.switchFactor()
      };
    }

    /** One-line HUD string: 'Clock: auto (-0.6s vs you, floor 180ms, n=4)'. */
    describe() {
      const snap = this.snapshot();
      if (!snap.samples || snap.lastMs === null) return 'Clock: no completed turn yet';
      const secs = (snap.lastMs / 1000);
      return 'Clock: ' + snap.label + ' (' + (secs >= 0 ? '+' : '') + U.round1(secs) + 's vs you, floor ' +
        Math.round(snap.floorMs || 0) + 'ms, n=' + snap.samples + ')';
    }
  }

  OpponentClock.defaultNow = defaultNow;
  ST.OpponentClock = OpponentClock;
})();
