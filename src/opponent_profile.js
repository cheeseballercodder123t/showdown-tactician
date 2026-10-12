/* Showdown Tactician — src/opponent_profile.js
 *
 * Exploitative opponent profiling — the read a Nash solve cannot make.
 *
 * THE PROBLEM
 *   `src/laplace_core.js` solves the simultaneous matrix with fictitious play, which finds an
 *   equilibrium against an opponent who is ALSO solving it. Ladder humans are not: they leave when
 *   the matrix told them to stay, and stay when it told them to leave, in patterns that persist
 *   across a battle. The mixed equilibrium is unexploitable but it is not optimal against a
 *   predictable player, and the deviation is measurable from something the engine already
 *   computes — the equilibrium frequency of the reply the opponent actually clicked.
 *
 * WHAT IS MEASURED, AND THE ONE ESTIMATOR IT RESTS ON
 *   Every turn the engine solves a matrix and then watches the opponent make one reply. That reply
 *   carries the frequency the matrix gave it (`predictedFreq`). The only question asked here is
 *   whether the opponent LEFT (a switch reply) more or less often than the matrix expected, so the
 *   reading is binary by construction and rests on ONE stated estimator:
 *
 *     matrixSwitchMass = (they switched) ? predictedFreq : 1 - predictedFreq
 *     excess           = (they switched ? 1 : 0) - matrixSwitchMass
 *
 *   Read plainly: if they pivoted when the matrix gave that pivot 10 %, the matrix was holding
 *   90 % on staying and the excess is +0.9. If they attacked a line the matrix gave 10 %, the
 *   matrix was holding 90 % on the pivot and the excess is -0.9. The excess is averaged over every
 *   SCORED observation, and `deviation` is that mean.
 *
 *   Two inputs are refused rather than guessed at:
 *     - `predictedFreq: null` is recorded and never scored. A reply the engine EXCLUDED from its
 *       solve carries confidence 0, and a vetoed line is not a frequency the engine endorsed; the
 *       caller must pass null for those, not 0.
 *     - a number outside [0, 1] is refused the same way. A percentage (42) is not a frequency, and
 *       guessing which of the two was passed would silently INVERT the profile.
 *
 * THE PROFILE IS A WINDOW, NOT A TALLY
 *   `profile()` reads the last `maxHistory` observations, not the whole battle: a player who
 *   over-predicts on turns 1-5 and settles down is not the same opponent on turn 20. Nothing is
 *   said before `minSamples` observations have carried a matrix frequency, because one lucky
 *   switch is not a personality.
 *
 * WHAT IT IS ALLOWED TO CHANGE
 *   One number: `switchFactor`, a multiplier on the payoff weight of the opponent's SWITCH replies
 *   in the simultaneous matrix — the same lever `src/opponent_clock.js` pulls, in the same
 *   direction. A player who leaves more than the reading's threshold gets their pivots priced MORE
 *   heavily (factor > 1, up to `maxFactor`); a player who stays gets them priced less (factor
 *   < 1, down to `1 / maxFactor`); a reading inside the threshold band, an under-sampled reading,
 *   and a disabled profiler all give exactly 1, so the factor is a no-op on the solver unless
 *   there is evidence for it. The factor scales with how far past the threshold the reading is, so
 *   a marginal profile barely moves the matrix.
 *
 *   `enabled: false` reports the label 'neutral' and the factor exactly 1 — but it still returns
 *   the deviation it measured, because a disabled profiler must be able to answer "what would this
 *   have said?" for an offline gate. Disabled is inert, not blind.
 *
 * HONEST LIMITS
 *   - The estimator is binary: it can tell "left" from "stayed", never "attacked" from "set up".
 *     Anything finer would need a model of their move choice that this engine does not have.
 *   - `state` is used for the turn in `reason` and nothing else: the profile is derived from
 *     observations alone, so a caller that passes no state still gets the same factor.
 *   - This is EXPLOITATION, so it is exploitable itself: a factor fitted off a few switches is a
 *     prior, not a law. It is config-shaped so a replay corpus can fit the thresholds later.
 *   - The switch side only. Nothing here re-prices their attacks; that is the matrix's own job.
 *
 * Nothing here throws: a battle produces observations this module has never seen.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});

  // Rule 4: heuristics live in src/config.js; the literals below are the standalone fallback —
  // and the real defaults, because the profiler is OFF until a measurement turns it on.
  const cfg = ST.configGet || function (path, fallback) { return fallback; };

  function num(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? v : fallback;
  }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function round4(x) { return Math.round(x * 10000) / 10000; }

  class OpponentProfiler {
    /**
     * @param {object} [options] overrides for every tunable (used by tests and by a caller that
     *   wants a different window); anything omitted comes from `laplace.profile.*`.
     */
    constructor(options) {
      const opts = options || {};
      this.enabled = opts.enabled === undefined
        ? cfg('laplace.profile.enabled', false) !== false
        : !!opts.enabled;
      // A misconfiguration must not be able to empty the window or unbounded the factor, so the
      // sanitising below is load-bearing rather than defensive noise.
      this.minSamples = Math.max(1, Math.floor(num(opts.minSamples, num(cfg('laplace.profile.minSamples', 6), 6))));
      this.flightThreshold = clamp01(num(opts.flightThreshold, num(cfg('laplace.profile.flightThreshold', 0.25), 0.25)));
      this.aggressionThreshold = clamp01(num(opts.aggressionThreshold, num(cfg('laplace.profile.aggressionThreshold', 0.25), 0.25)));
      this.maxFactor = Math.max(1, num(opts.maxFactor, num(cfg('laplace.profile.maxFactor', 2), 2)));
      this.maxHistory = Math.max(1, Math.floor(num(opts.maxHistory, num(cfg('laplace.profile.maxHistory', 24), 24))));
      this.reset();
    }

    reset() {
      this.history = [];   // ring of the last `maxHistory` observations, scored or not
      this.last = null;
      return this;
    }

    /* ----------------------------------------------------------------- ingest */

    /**
     * observe({ kind, predictedFreq, turn }) -> this
     * `kind` is the reply they made: 'switch' | 'attack' | 'setup' | 'protect' | 'recovery' (any
     * other value is read as "not a switch", because the excess is a switch/not-switch split).
     * `predictedFreq` is the equilibrium frequency the engine's own matrix gave THAT reply, or
     * null when there was no matrix to compare against (see the header).
     */
    observe(record) {
      const r = record || {};
      const kind = typeof r.kind === 'string' ? r.kind : '';
      const actualSwitch = kind === 'switch' ? 1 : 0;
      const raw = r.predictedFreq;
      const scored = typeof raw === 'number' && isFinite(raw) && raw >= 0 && raw <= 1;
      const pSwitch = scored ? (actualSwitch ? raw : 1 - raw) : null;
      const entry = {
        turn: num(r.turn, null),
        kind: kind || 'unknown',
        predictedFreq: scored ? raw : null,
        actualSwitch: actualSwitch,
        pSwitch: pSwitch,
        excess: pSwitch === null ? 0 : actualSwitch - pSwitch,
        scored: pSwitch !== null
      };
      this.history.push(entry);
      while (this.history.length > this.maxHistory) this.history.shift();
      this.last = entry;
      return this;
    }

    /* -------------------------------------------------------------- readout */

    /** Walk the window: the profile is a pure function of the ring and nothing else. */
    _read() {
      let scored = 0, excess = 0;
      for (let i = 0; i < this.history.length; i++) {
        const h = this.history[i];
        if (!h.scored) continue;
        scored++;
        excess += h.excess;
      }
      return {
        observed: this.history.length,
        scored: scored,
        deviation: scored ? excess / scored : 0
      };
    }

    /**
     * profile(state) -> { label, switchFactor, samples, deviation, reason }
     * `state` supplies the turn for `reason` only; pass null when there is none.
     */
    profile(state) {
      const read = this._read();
      const turn = state && num(state.turn, null);
      const where = turn === null ? '' : ' (turn ' + turn + ')';
      const base = {
        switchFactor: 1,
        samples: read.scored,
        deviation: round4(read.deviation)
      };

      if (!this.enabled) {
        return Object.assign(base, {
          label: 'neutral',
          reason: 'profiling is off (laplace.profile.enabled)' + where
        });
      }
      if (!read.scored) {
        return Object.assign(base, {
          label: 'unknown',
          reason: (read.observed
            ? 'no reply carried a matrix frequency to compare against'
            : 'no replies observed yet') + where
        });
      }
      if (read.scored < this.minSamples) {
        return Object.assign(base, {
          label: 'unknown',
          reason: read.scored + ' scored of ' + this.minSamples + ' needed' + where
        });
      }

      // The label and the factor are built from ONE scale, so they can never disagree: the profile
      // has to be strictly past the threshold to be labelled at all, and the factor grows with how
      // far past it the reading is. The spans guard against a threshold of 1.
      const excess = read.deviation;
      const upSpan = Math.max(1e-9, 1 - this.flightThreshold);
      const downSpan = Math.max(1e-9, 1 - this.aggressionThreshold);
      const up = clamp01((excess - this.flightThreshold) / upSpan);
      const down = clamp01((-excess - this.aggressionThreshold) / downSpan);

      let label = 'neutral';
      let factor = 1;
      if (up > 0) {
        label = 'flighty';
        factor = 1 + up * (this.maxFactor - 1);
      } else if (down > 0) {
        label = 'over-predictor';
        factor = 1 / (1 + down * (this.maxFactor - 1));
      }
      factor = Math.min(this.maxFactor, Math.max(1 / this.maxFactor, factor));

      const d = read.deviation;
      const sampleNote = ' over ' + read.scored + ' scored replies' + where;
      const reason = label === 'flighty'
        ? 'left more than the matrix expected: mean switch excess +' + round4(d) + sampleNote
        : (label === 'over-predictor'
          ? 'stayed more than the matrix expected: mean switch excess ' + round4(d) + sampleNote
          : 'inside the threshold band: mean switch excess ' + round4(d) + sampleNote);

      return { label: label, switchFactor: factor, samples: read.scored, deviation: round4(d), reason: reason };
    }

    /** Plain snapshot for the HUD and for `state` (never a live object reference). */
    snapshot() {
      const p = this.profile(null);
      return {
        enabled: this.enabled,
        observed: this.history.length,
        samples: p.samples,
        deviation: p.deviation,
        label: p.label,
        switchFactor: p.switchFactor,
        reason: p.reason
      };
    }
  }

  ST.OpponentProfiler = OpponentProfiler;
})();
