/* Showdown Tactician — src/mlp_residual.js
 * Tier 1.5 of the hybrid architecture: an OPTIONAL, BOUNDED residual correction on top of the
 * frozen 128D linear evaluator. The linear dot product stays the base score; this head can only
 * nudge it. It is off unless config.evaluator.mlp.enabled is true.
 *
 * WHY "WIDE & DEEP" AND NOT A REPLACEMENT
 *   The shipped `evaluator.weights` IS a logistic regression over 111,820 labelled turn rows: a
 *   128D linear ranking function that is monotone, interpretable and already measured. What a
 *   linear model cannot express is an interaction — "this boost only matters once that hazard is
 *   up" is a product of two dims. A small MLP can express those, but a small MLP fitted end to end
 *   on the same rows is also free to discard the linear structure and overfit the training half
 *   (the repository has already watched exactly that happen with the cross-product screen). So the
 *   two are composed the way Wide & Deep composes them: the wide (linear) half is FROZEN and
 *   provides the score, and the deep (non-linear) half is trained only on what the linear half got
 *   wrong.
 *
 * THE COMPOSITION (see DenseStateEvaluator.evaluate)
 *   raw   = sum_i x[i] * w[i]                            // frozen linear dot product, unchanged
 *   score = evaluator.scale * tanh(raw / tanhDenominator)
 *   score = score + (mlp.enabled ? head.delta(x) : 0)    // the bounded residual
 *   `delta()` is `clamp(gain * forward(x), -clamp, +clamp)`, and `forward()` is a 128 -> 16 -> 1
 *   ReLU network held entirely in Float32Array.
 *
 * THE CLAMP IS A SAFETY RAIL, NOT A FORMALITY
 *   `_payoff` adds `evaluate()` to FIXED bonuses that were tuned against a +-1000 score:
 *   `laplace.lethalBonus` is 260, `laplace.switchAteHitBonus` is 25. An unbounded residual head
 *   could outvote a lethal-blow bonus and make the engine hang a piece, and an out-of-distribution
 *   board — a state the corpus never contained — is precisely where a 2,081-coefficient network is
 *   most confident and most wrong. `config.evaluator.mlp.clamp` is 150, deliberately BELOW
 *   `lethalBonus`: the residual can sharpen a decision but can never overrule the veto layer or a
 *   forced kill.
 *
 * WHERE THE WEIGHTS COME FROM
 *   Never from this file and never from a hand edit. `tools/train_mlp_residual.js` fits them
 *   offline against the residuals of the frozen linear model on the TRAINING half of a replay
 *   corpus, applies the same battle-level holdout and paired-bootstrap gate the linear fit was
 *   adopted under, and writes BOTH `lib/mlp-residual.json` (the reviewable artifact, carrying the
 *   gate verdict) and the generated `lib/mlp-residual.js` (the plain-array data module read here).
 *   If the gate does not clear, `config.evaluator.mlp.enabled` stays false and this file is inert.
 *
 * FAIL-SAFE OFF
 *   `fromConfig()` returns null unless the config says enabled AND the generated data module is
 *   present AND its dimensions agree with the config's. A missing, half-written or mismatched
 *   artifact turns the head off; it can never half-apply. Disabled is also bit-identical to having
 *   no head at all, because `evaluate()` skips the addition rather than adding a zero.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});

  // RULE 4: every tunable comes from src/config.js. config.js is loaded before this file in both
  // the manifest and tests/harness.js; `cfg` still degrades to the literal when loaded standalone.
  const cfg = function (path, fallback) {
    return typeof ST.configGet === 'function' ? ST.configGet(path, fallback) : fallback;
  };

  /** Coerce a plain array (or a Float32Array) into a Float32Array of exactly `n` entries. */
  function toF32(source, n) {
    const out = new Float32Array(n);
    if (!source) return out;
    const len = Math.min(n, source.length);
    for (let i = 0; i < len; i++) out[i] = source[i];
    return out;
  }

  class ResidualMLP {
    /**
     * @param {object} spec  { dim, hidden, clamp, gain, standardize:{mean,sd}, w1, b1, w2, b2 }
     *   w1 is hidden x dim, row-major (row k holds the incoming weights of hidden unit k).
     *   `standardize` is applied to the input vector BEFORE the first layer; the trainer fits in
     *   that space because IRLS/GD on raw dims is badly conditioned when HP fractions and +-1
     *   macro dims share one Hessian.
     */
    constructor(spec) {
      spec = spec || {};
      this.dim = (spec.dim | 0) || 128;
      this.hidden = (spec.hidden | 0) || 16;
      this.clamp = typeof spec.clamp === 'number' && isFinite(spec.clamp) ? Math.abs(spec.clamp) : 150;
      this.gain = typeof spec.gain === 'number' && isFinite(spec.gain) ? spec.gain : 0;

      const std = spec.standardize || {};
      this.mean = toF32(std.mean, this.dim);
      this.sd = toF32(std.sd, this.dim);
      this.invSd = new Float32Array(this.dim);
      for (let j = 0; j < this.dim; j++) {
        const s = this.sd[j];
        // A dim with no variance cannot be standardised; leaving it at 0 (not 1/s) zeroes that
        // input rather than amplifying float noise into the first layer.
        this.invSd[j] = s > 1e-9 ? 1 / s : 0;
      }

      this.w1 = toF32(spec.w1, this.hidden * this.dim);
      this.b1 = toF32(spec.b1, this.hidden);
      this.w2 = toF32(spec.w2, this.hidden);
      this.b2 = typeof spec.b2 === 'number' && isFinite(spec.b2) ? spec.b2 : 0;

      // Scratch buffers: allocated once, so `forward` never allocates on the hot path. `_payoff`
      // calls `evaluate()` up to 432 times for a single turn.
      this._u = new Float32Array(this.dim);
      this._h = new Float32Array(this.hidden);
      this._pad = null;

      this.lastOutput = 0;   // the fitted residual, before gain and clamp
      this.lastDelta = 0;    // the number the evaluator actually added
      this.calls = 0;
    }

    /**
     * forward(vec) -> the fitted residual (roughly in [-1, 1], the same units as y - p).
     * ReLU between the input projection and the output unit; no activation on the output, because
     * the target is a signed residual.
     */
    forward(vec) {
      if (!vec) return 0;
      const dim = this.dim, hidden = this.hidden;
      let src = vec;
      // `evaluateVector` accepts short vectors; pad once rather than branching inside the loop.
      if (vec.length < dim) {
        if (!this._pad) this._pad = new Float32Array(dim);
        this._pad.fill(0);
        for (let j = 0; j < vec.length; j++) this._pad[j] = vec[j];
        src = this._pad;
      }

      const mean = this.mean, inv = this.invSd, u = this._u;
      for (let j = 0; j < dim; j++) u[j] = (src[j] - mean[j]) * inv[j];

      const w1 = this.w1, b1 = this.b1, h = this._h;
      for (let k = 0; k < hidden; k++) {
        let z = b1[k];
        const base = k * dim;
        for (let j = 0; j < dim; j++) z += w1[base + j] * u[j];
        h[k] = z > 0 ? z : 0;                       // ReLU
      }

      const w2 = this.w2;
      let g = this.b2;
      for (let k = 0; k < hidden; k++) g += w2[k] * h[k];
      this.lastOutput = g;
      return g;
    }

    /** delta(vec) -> `clamp(gain * forward(vec), -clamp, +clamp)`: the bounded score correction. */
    delta(vec) {
      const g = this.forward(vec);
      let d = this.gain * g;
      if (!(d === d)) d = 0;                        // NaN in, 0 out — never poison a score
      if (d > this.clamp) d = this.clamp;
      else if (d < -this.clamp) d = -this.clamp;
      this.lastDelta = d;
      this.calls++;
      return d;
    }

    /** A small serialisable description — used by tests and by a debug readout. */
    describe() {
      return {
        dim: this.dim, hidden: this.hidden, clamp: this.clamp, gain: this.gain,
        params: this.hidden * this.dim + this.hidden + this.hidden + 1,
        calls: this.calls
      };
    }

    /**
     * fromConfig() -> a ready head, or null when the head must not run.
     * Null is returned for EVERY reason that is not "the config says on and the artifact agrees":
     * a disabled toggle, an absent generated module, or a dimension mismatch between the two. That
     * is the fail-safe: a half-loaded artifact can never contribute a partial correction.
     */
    static fromConfig() {
      const spec = cfg('evaluator.mlp', null);
      if (!spec || spec.enabled !== true) return null;
      const data = ST.MLP_RESIDUAL;
      if (!data || !data.w1 || !data.w2 || !data.b1) return null;
      const dim = spec.dim || 128;
      const hidden = spec.hidden || 16;
      if (data.dim !== dim || data.hidden !== hidden) return null;
      return new ResidualMLP({
        dim: dim,
        hidden: hidden,
        clamp: typeof spec.clamp === 'number' ? spec.clamp : 150,
        gain: data.gain,
        standardize: data.standardize,
        w1: data.w1, b1: data.b1, w2: data.w2, b2: data.b2
      });
    }

    /** True when a trained artifact is present, regardless of the toggle. */
    static artifactPresent() {
      const data = ST.MLP_RESIDUAL;
      return !!(data && data.w1 && data.w2 && data.b1);
    }
  }

  ST.ResidualMLP = ResidualMLP;
})();
