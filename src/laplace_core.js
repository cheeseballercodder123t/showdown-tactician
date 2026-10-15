/* Showdown Tactician — src/laplace_core.js
 * The master coordinator (Part 2, Module 13). Recreates the 2231-Elo Laplace loop:
 *   sample K worlds -> enumerate legal actions -> 1-ply simultaneous payoff matrix ->
 *   128D leaf evaluation -> 0.6 avg / 0.4 min blend -> world vote pooling ->
 *   mixed-Nash solve (fictitious play) -> tempo policy mask -> deterministic blunder
 *   vetoes -> frequency-weighted line (legacy softmax T = 35 when nash is off).
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;

  /* RULE 4 — every tunable in this file comes from src/config.js, which the manifest loads
   * first. `cfgGet` returns the literal fallback only when config.js itself is missing, so a
   * stripped build behaves exactly as it did before the config existed while editing the
   * config is always sufficient to retune the solver. */
  const cfgGet = (typeof ST.configGet === 'function')
    ? ST.configGet
    : function (path, fallback) { return fallback; };

  const VETO_SCORE = -9999;   // published static contract; the live value is laplace.vetoScore
  const NASH_ITERATIONS = 2000; // literal fallback for laplace.nash.iterations (see config.js)

  /**
   * Fictitious play on a 2-player normal-form game (the simultaneous payoff matrix).
   *
   * The 0.6*avg + 0.4*min world blend is a PURE-strategy risk heuristic: the engine prints one
   * line, so a patient opponent can read it. A 4x5..5x9 matrix is small enough to solve for a
   * mixed equilibrium in microseconds, and those frequencies ARE the unexploitable advice
   * ("click this 70% of the time, the punish 30%").
   *
   * `payoffMatrix[i][j]` is OUR payoff for action i against their action j, so the opponent's
   * cumulative payoff is its negation (the matrix is treated as zero-sum: our gain is their
   * loss). Each side then best-responds to the other's empirical history — the classic
   * Brown-Robinson iteration, which converges to a Nash equilibrium in zero-sum games.
   *
   * QRE (`qre = { tau }`, see config.laplace.nash.qre): the OPPONENT's column response is a LOGIT
   * softmax at temperature `tau` over their cumulative payoffs instead of an argmax, so their mix
   * spreads the way a noisy player's replies do — and, because the responses are mixtures, the
   * empirical counts they leave behind are accumulated as mixtures too (the average response is the
   * expected count, which keeps both strategies summing to 1). OUR side then best-responds to that
   * MIXTURE (see the accumulation below), so the frequencies we publish are the best response to a
   * noisy opponent rather than to a perfectly rational one: against a softened opponent they are no
   * longer the minimax-safe mix for the true matrix, which is precisely the trade the tier exists to
   * price (ATTEMPTS.md E5, and L2/M3 for what the one-way version measured). `tau <= 0`, or no
   * `qre` at all, runs the shipped hard-argmax loop step for step.
   *
   * `opts` carries the two OPPONENT-MODEL tiers, and both are strict additions:
   *   - `opts.perceived` (laplace.surpriseMask) is a second matrix of the same shape holding what
   *     the opponent BELIEVES our rows pay. Only THEIR cumulative payoff is accumulated from it;
   *     our own step still reads the true matrix, and `rowValues` is still the true matrix against
   *     their mix. So a misperception can make them under-respect a line, and it can never relax
   *     the floor our own frequencies are computed against.
   *   - `opts.prior` + `opts.priorWeight` (laplace.nash.priorAnchored) anchor the opponent's
   *     response to a behavioral prior instead of the uniform-zero start of an unanchored solve.
   *   - `opts.exploitBlend` + `opts.exploitTemperature` (laplace.nash.exploitBlend) mix the
   *     published frequencies toward a softmax over the row VALUES — the exploitation term that
   *     takes value back from an opponent that is NOT playing the equilibrium the first term
   *     assumes. 0 is the identity and returns the equilibrium array itself.
   * None of the arguments present (or all inert) runs the shipped loop step for step.
   *
   * -> { myStrategy, oppStrategy, rowValues } with probabilities in [0, 1].
   */
  function solveNashFictitiousPlay(payoffMatrix, iterations, qre, opts) {
    const rows = Array.isArray(payoffMatrix) ? payoffMatrix.length : 0;
    const cols = rows && Array.isArray(payoffMatrix[0]) ? payoffMatrix[0].length : 0;
    if (!rows || !cols) return { myStrategy: [], equilibriumStrategy: [], oppStrategy: [], rowValues: [], exploitBlend: 0 };
    /* The opponent's belief, accepted only when it has the SHAPE of the true matrix. A mismatched
     * copy is a caller bug, and silently reading a ragged row would misprice the turn. */
    let perceived = (opts && Array.isArray(opts.perceived)) ? opts.perceived : null;
    if (perceived && (!Array.isArray(perceived[0]) || perceived.length !== rows ||
      perceived[0].length !== cols)) perceived = null;
    const iters = Math.max(1, Math.floor(iterations) || 1);
    const myCount = new Array(rows).fill(0);
    const oppCount = new Array(cols).fill(0);
    const myCum = new Array(rows).fill(0);
    const oppCum = new Array(cols).fill(0);
    const tau = (qre && typeof qre.tau === 'number' && isFinite(qre.tau) && qre.tau > 0) ? qre.tau : 0;
    /* Prior-anchored regret matching (laplace.nash.priorAnchored). `prior` is the opponent's
     * behavioral prior over their OWN actions, normalized by the caller; it enters as the c_prior
     * term of  pi(a) ~ max(Q(a) - V, 0) + c * P_prior(a).  With no prior — or a weight of 0 — the
     * positive-regret term of a pure best response against the running payoff is 0, so the mix
     * below collapses to `null` and the hard `oppAction` stands: this is the shipped loop. */
    const prior = (opts && Array.isArray(opts.prior) && opts.prior.length === cols &&
      opts.prior.every(function (p) { return typeof p === 'number' && isFinite(p) && p >= 0; }))
      ? opts.prior : null;
    const priorWeight = (opts && typeof opts.priorWeight === 'number' && isFinite(opts.priorWeight))
      ? Math.max(0, Math.min(1, opts.priorWeight)) : 0;
    const priorOn = !!(prior && priorWeight > 0);
    /* Exploit blend (laplace.nash.exploitBlend). `exploitT` is the legacy confidence temperature
     * (`laplace.temperature`), passed in by the caller so this stays a pure function. */
    const exploitBlend = (opts && typeof opts.exploitBlend === 'number' && isFinite(opts.exploitBlend))
      ? Math.max(0, Math.min(1, opts.exploitBlend)) : 0;
    const exploitT = (opts && typeof opts.exploitTemperature === 'number' &&
      isFinite(opts.exploitTemperature) && opts.exploitTemperature > 0) ? opts.exploitTemperature : 35;
    let myAction = 0;
    let oppAction = 0;
    let oppMix = null;            // the last SOFT / SMEARED column response; null on the hard path
    /* The mixture the opponent is CURRENTLY playing, which is what regret is measured against. It
     * starts as the prior itself (nothing has been observed yet) and is replaced by every response
     * the loop computes. */
    let oppCurrent = null;
    for (let t = 0; t < iters; t++) {
      myCount[myAction]++;
      if (oppMix) for (let j = 0; j < cols; j++) oppCount[j] += oppMix[j];
      else oppCount[oppAction]++;
      /* OUR OWN STEP READS THE MIX, NOT THE INDEX. This line used to be the unconditional
       * `myCum[i] += payoffMatrix[i][oppAction]` — the opponent's hard argmax INDEX — while their
       * published strategy accumulated the soft/anchored MIXTURE. Every opponent-model tier was
       * therefore one-way: a temperature or a prior could re-price `rowValues` and could not touch
       * our own frequency counts, which is the ceiling ATTEMPTS.md L2 named and M3 measured
       * (`nash-prior` came back `identical` over 60 paired battles). Against a mixture our expected
       * payoff is that mixture's expectation, so that is what accumulates now. With `oppMix` null —
       * no temperature, no prior, i.e. the whole shipped build — the else branch below is the
       * historical line, character for character. */
      if (oppMix) {
        for (let i = 0; i < rows; i++) {
          let ev = 0;
          for (let j = 0; j < cols; j++) ev += oppMix[j] * payoffMatrix[i][j];
          myCum[i] += ev;
        }
      } else {
        for (let i = 0; i < rows; i++) myCum[i] += payoffMatrix[i][oppAction];
      }
      /* THEIR payoff is accumulated from what they BELIEVE (the perceived matrix when one was
       * supplied), OUR payoff from what is true. That asymmetry is the whole mechanism: the
       * opponent solves the game it thinks it is in. */
      const oppView = perceived || payoffMatrix;
      for (let j = 0; j < cols; j++) oppCum[j] -= oppView[myAction][j];
      let bestI = 0;
      for (let i = 1; i < rows; i++) if (myCum[i] > myCum[bestI]) bestI = i;
      let bestJ = 0;
      for (let j = 1; j < cols; j++) if (oppCum[j] > oppCum[bestJ]) bestJ = j;
      myAction = bestI;
      oppAction = bestJ;
      if (priorOn) {
        /* Prior-anchored regret matching, in the two steps it is defined in.
         *
         * FIRST the regret-matching response: each action's INSTANTANEOUS REGRET is measured
         * against the value of the mixture they are currently playing (`V`, the expectation of
         * their own cumulative payoffs under `current`), and only the POSITIVE part is kept. The
         * reference point has to be the current mixture and not the best action: against
         * `max_j Q_j` no action can ever have positive regret, so that version of the formula is
         * identically the argmax and the prior would be the only thing left doing any work. At
         * round 0 nothing has been observed, every cumulant is 0, every regret is 0 — the
         * degenerate case falls back to the prior, which is the honest answer to "what do we know
         * before they have moved?".
         *
         * THEN the anchor: the regret-matching mix is blended with the behavioral prior at
         * `priorWeight`, so their response is `(1 - c) * regretMix + c * P_prior`. This is what
         * keeps an opponent blunder from collecting a full best response for the whole solve — the
         * prior is where a human's reply mass actually lives — while a sustained deviation still
         * earns its way into the mix. */
        const current = oppCurrent || prior;
        let value = 0;
        for (let j = 0; j < cols; j++) value += current[j] * oppCum[j];
        const mix = new Array(cols);
        let total = 0;
        for (let j = 0; j < cols; j++) {
          const regret = oppCum[j] - value;
          mix[j] = regret > 0 ? regret : 0;
          total += mix[j];
        }
        if (total > 0) {
          for (let j = 0; j < cols; j++) mix[j] = mix[j] / total;
        } else {
          for (let j = 0; j < cols; j++) mix[j] = prior[j];
        }
        for (let j = 0; j < cols; j++) mix[j] = (1 - priorWeight) * mix[j] + priorWeight * prior[j];
        oppMix = mix;
        oppCurrent = mix;
      } else if (tau > 0) {
        /* The SOFT response. `oppCum` is THEIR cumulative payoff (it is accumulated as the
         * negation of ours), so the logit is a straight softmax over it; the max is subtracted
         * before the exponential (the standard stabiliser) so a matrix in the thousands cannot
         * overflow it into NaN. */
        let max = -Infinity;
        for (let j = 0; j < cols; j++) if (oppCum[j] > max) max = oppCum[j];
        const mix = new Array(cols);
        let total = 0;
        for (let j = 0; j < cols; j++) {
          const w = Math.exp((oppCum[j] - max) / tau);
          mix[j] = w;
          total += w;
        }
        if (total > 0) {
          for (let j = 0; j < cols; j++) mix[j] = mix[j] / total;
          oppMix = mix;
        } else {
          oppMix = null;                   // nothing to spread: keep the hard response this round
        }
      }
    }
    const equilibrium = myCount.map(function (c) { return c / iters; });
    const oppStrategy = oppCount.map(function (c) { return c / iters; });
    // Expected payoff of each of our actions against THEIR equilibrium mix — the number that
    // says what a line is worth when the opponent also plays unexploitably.
    const rowValues = [];
    for (let i = 0; i < rows; i++) {
      let ev = 0;
      for (let j = 0; j < cols; j++) ev += oppStrategy[j] * payoffMatrix[i][j];
      rowValues.push(ev);
    }
    /* THE EXPLOIT BLEND (laplace.nash.exploitBlend). `rowValues` is what each of our rows is worth
     * against the mix we just published FOR THEM; when that mix is not an equilibrium one (a
     * softened, anchored or surprised opponent) the unexploitable frequency leaves value on the
     * table, and this weight is how much of it to take back. The second term is a softmax over
     * `rowValues` in the same stabilised form `_softmaxConfidence` uses, so both terms are
     * distributions and the mix still sums to 1. b = 0 returns the equilibrium array ITSELF rather
     * than a copy scaled by 1, which is what keeps every downstream number bit-identical. */
    let myStrategy = equilibrium;
    if (exploitBlend > 0) {
      let best = -Infinity;
      for (let i = 0; i < rows; i++) if (rowValues[i] > best) best = rowValues[i];
      const exp = new Array(rows);
      let denom = 0;
      for (let i = 0; i < rows; i++) { exp[i] = Math.exp((rowValues[i] - best) / exploitT); denom += exp[i]; }
      myStrategy = new Array(rows);
      for (let i = 0; i < rows; i++) {
        const greedy = denom > 0 ? exp[i] / denom : (1 / rows);
        myStrategy[i] = (1 - exploitBlend) * equilibrium[i] + exploitBlend * greedy;
      }
    }
    return {
      myStrategy: myStrategy, equilibriumStrategy: equilibrium, oppStrategy: oppStrategy,
      rowValues: rowValues, exploitBlend: exploitBlend
    };
  }

  class LaplaceEngine {
    constructor(options) {
      options = options || {};
      // Precedence (unchanged): explicit option > src/config.js > literal fallback.
      this.K = options.K || cfgGet('laplace.K', 6);
      this.temperature = options.temperature || cfgGet('laplace.temperature', 35);
      // Cloned so a caller mutating engine.worldBlend can never write into the shared config.
      this.worldBlend = options.worldBlend ||
        Object.assign({}, cfgGet('laplace.worldBlend', { avg: 0.6, min: 0.4 }));
      this.maxOppActions = options.maxOppActions || cfgGet('laplace.maxOppActions', 9);
      // Terminal payoff for taking (or losing) the last body on the field.
      this.lethalBonus = options.lethalBonus || cfgGet('laplace.lethalBonus', 260);
      // Bench switches synthesised when there is no |request| to read.
      this.maxSwitchFallback = options.maxSwitchFallback || cfgGet('laplace.maxSwitchFallback', 5);
      this.vetoScore = options.vetoScore || cfgGet('laplace.vetoScore', VETO_SCORE);
      // Stand-in damage when the opponent has nothing left but Struggle.
      this.struggleChipPercent = options.struggleChipPercent || cfgGet('laplace.struggleChipPercent', 5);
      // Reward for a payoff where their switch ate our move for free.
      this.switchAteHitBonus = options.switchAteHitBonus || cfgGet('laplace.switchAteHitBonus', 25);
      // The pivot tax: a flat drag on every switch row (see _switchTaxDelta). Same precedence as
      // every other tunable; `enabled: false` is the shipped build and restores the ranking exactly.
      this.switchTax = Object.assign({
        enabled: cfgGet('laplace.switchTax.enabled', false),
        points: cfgGet('laplace.switchTax.points', 120)
      }, options.switchTax || {});
      // Mixed-strategy solve (same precedence as every other tunable). `enabled: false` restores
      // the pure risk blend + softmax behaviour exactly.
      this.nash = Object.assign({
        enabled: cfgGet('laplace.nash.enabled', true),
        iterations: cfgGet('laplace.nash.iterations', NASH_ITERATIONS)
      }, options.nash || {});
      /* The prior-anchored tier is merged at BOTH levels on purpose. `Object.assign` above
       * replaces `priorAnchored` wholesale when a caller supplies one, and a caller that names
       * only `{ enabled, priorWeight }` would then leave every prior weight `undefined` — which is
       * a silent all-zero prior, not a partial one. The sub-object is therefore rebuilt from the
       * config leaves with the caller's own fields layered on top. */
      this.nash.priorAnchored = Object.assign({
        enabled: cfgGet('laplace.nash.priorAnchored.enabled', false),
        priorWeight: cfgGet('laplace.nash.priorAnchored.priorWeight', 0.25),
        attackFloor: cfgGet('laplace.nash.priorAnchored.attackFloor', 5),
        setupSafe: cfgGet('laplace.nash.priorAnchored.setupSafe', 45),
        setupUnsafe: cfgGet('laplace.nash.priorAnchored.setupUnsafe', 10),
        switchBase: cfgGet('laplace.nash.priorAnchored.switchBase', 8),
        switchEscape: cfgGet('laplace.nash.priorAnchored.switchEscape', 70)
      }, (options.nash && options.nash.priorAnchored) || {});
      /* The exploit blend. Re-read here for the same reason as `priorAnchored`: `Object.assign`
       * above replaces the whole `nash` sub-object when a caller supplies one, so a caller who
       * names only `{ enabled: false }` must still get the config's value. 0 (the shipped value)
       * makes the solver skip the blend entirely. */
      this.nash.exploitBlend = (options.nash && typeof options.nash.exploitBlend === 'number' &&
        isFinite(options.nash.exploitBlend)) ? options.nash.exploitBlend : cfgGet('laplace.nash.exploitBlend', 0);
      // Risk-adjusted volatility (ARCHITECTURE §6.5). `enabled: false` restores the raw payoff.
      this.volatility = Object.assign({
        enabled: cfgGet('laplace.volatility.enabled', true),
        accuracyWeight: cfgGet('laplace.volatility.accuracyWeight', 1),
        fragilityScale: cfgGet('laplace.volatility.fragilityScale', 2.4),
        lethalMultiplier: cfgGet('laplace.volatility.lethalMultiplier', 3),
        accuracyFloor: cfgGet('laplace.volatility.accuracyFloor', 100),
        lethalChargeMaxAccuracy: cfgGet('laplace.volatility.lethalChargeMaxAccuracy', 90)
      }, options.volatility || {});
      // Quiescence (ARCHITECTURE §6.7): price the turn the matrix itself does not see.
      this.quiescence = Object.assign({
        enabled: cfgGet('laplace.quiescence.enabled', true),
        extendSetup: cfgGet('laplace.quiescence.extendSetup', true),
        blockProtect: cfgGet('laplace.quiescence.blockProtect', true),
        respectTurn2Speed: cfgGet('laplace.quiescence.respectTurn2Speed', true),
        // How much of the setup EXTENSION's second exchange to price (see config.js). 1.0 is the
        // full-strength follow-up and `x * 1` is bit-identical to it, so this knob cannot move a
        // shipped cell unless it is deliberately changed.
        followUpWeight: cfgGet('laplace.quiescence.followUpWeight', 1)
      }, options.quiescence || {});
      // The 2-ply beam (the multi-ply horizon upgrade). `enabled: false` is the shipped build and
      // leaves the 1-ply matrix untouched; the refinement is a measure-before-adopt tier.
      this.beam2Ply = Object.assign({
        enabled: cfgGet('laplace.beam2Ply.enabled', false),
        topMy: cfgGet('laplace.beam2Ply.topMy', 3),
        topOpp: cfgGet('laplace.beam2Ply.topOpp', 3),
        blendWeight: cfgGet('laplace.beam2Ply.blendWeight', 0.35),
        threatWeight: cfgGet('laplace.beam2Ply.threatWeight', 1)
      }, options.beam2Ply || {});
      // Quantal Response Equilibrium. `enabled: false` keeps the hard best-response of fictitious
      // play exactly; the tier exists so the measured upside of a non-Nash opponent model can be
      // ablated without giving up minimax safety.
      this.qre = Object.assign({
        enabled: cfgGet('laplace.nash.qre.enabled', false),
        tau: cfgGet('laplace.nash.qre.tau', 30),
        highRating: cfgGet('laplace.nash.qre.highRating', 1850),
        lowRating: cfgGet('laplace.nash.qre.lowRating', 1100)
      }, (options.nash && options.nash.qre) || options.qre || {});
      // The three 1-ply leaf corrections, each with its own switch and each the EXACT identity when
      // off (see _payoff, _pivotPayoff, _setupFollowUp).
      // Surprise truncation (laplace.surpriseMask): the opponent's half of the solve reads a COPY
      // of the matrix in which our UNREVEALED, non-STAB rows are pulled toward our best
      // revealed/STAB row, so the equilibrium stops telepathically dodging a coverage move it has
      // not seen us click. Our own rows are still scored on the TRUE matrix against that mix, and
      // our own frequencies still best-respond to the real game. Ships OFF.
      this.surpriseMask = Object.assign({
        enabled: cfgGet('laplace.surpriseMask.enabled', false),
        unrevealedWeight: cfgGet('laplace.surpriseMask.unrevealedWeight', 0.35)
      }, options.surpriseMask || {});
      this.realOppSwitch = Object.assign({
        enabled: cfgGet('laplace.realOppSwitch.enabled', true)
      }, options.realOppSwitch || {});
      this.pricePivots = Object.assign({
        enabled: cfgGet('laplace.pricePivots.enabled', true),
        regenPct: cfgGet('laplace.pricePivots.regenPct', 33.3)
      }, options.pricePivots || {});
      this.priceRecovery = Object.assign({
        enabled: cfgGet('laplace.priceRecovery.enabled', true),
        defaultHealPct: cfgGet('laplace.priceRecovery.defaultHealPct', 50)
      }, options.priceRecovery || {});
      // Comeback mode (prospect theory on the risk dial). A 100-turn tie is a loss, and so is a
      // safe grind when you are already behind: with the board scored by the evaluator, the SAME
      // miss charge is scaled up when we are winning (minimum variance) and down when we are losing
      // (we need the swing). This is the honest place for the idea, because `laplace.temperature`
      // only governs the legacy softmax path — with nash.enabled (the default) the ranking comes
      // from the equilibrium frequency, so lowering a temperature would change nothing.
      this.comeback = Object.assign({
        enabled: cfgGet('laplace.comeback.enabled', false),
        winMargin: cfgGet('laplace.comeback.winMargin', 300),
        lossMargin: cfgGet('laplace.comeback.lossMargin', -300),
        winChargeScale: cfgGet('laplace.comeback.winChargeScale', 2),
        lossChargeScale: cfgGet('laplace.comeback.lossChargeScale', 0.4)
      }, options.comeback || {});
      // Turn urgency (patience decay). Past `startTurn` the engine progressively prefers a line
      // that COMMITS (a real attack or a setup move) and disfavours one that merely stalls, and
      // past `breakoutTurn` that preference is multiplied so a stalemate is not accepted silently.
      // Bounded and additive, exactly like the tempo mask and the volatility charge, so it can only
      // re-rank lines — it can never override a veto or a forced kill.
      this.urgency = Object.assign({
        enabled: cfgGet('laplace.urgency.enabled', false),
        startTurn: cfgGet('laplace.urgency.startTurn', 25),
        rampTurn: cfgGet('laplace.urgency.rampTurn', 60),
        breakoutTurn: cfgGet('laplace.urgency.breakoutTurn', 50),
        maxBonus: cfgGet('laplace.urgency.maxBonus', 120),
        breakoutScale: cfgGet('laplace.urgency.breakoutScale', 2),
        minBasePower: cfgGet('laplace.urgency.minBasePower', 60),
        passiveMalus: cfgGet('laplace.urgency.passiveMalus', 40)
      }, options.urgency || {});
      // PP-stall gauge + format sentinel knobs (ARCHITECTURE §6.4 / §6.6).
      this.ppStallCfg = Object.assign({
        enabled: cfgGet('ppStall.enabled', true),
        watch: cfgGet('ppStall.watch', ['suckerpunch', 'protect', 'substitute']),
        headline: cfgGet('ppStall.headline', 'suckerpunch'),
        minPpFraction: cfgGet('ppStall.minPpFraction', 0.2),
        setupThreatHp: cfgGet('ppStall.setupThreatHp', 80),
        adviceLabel: cfgGet('ppStall.adviceLabel', 'PP-stall pivot')
      }, options.ppStall || {});
      this.sentinelCfg = Object.assign({
        enabled: cfgGet('sentinel.enabled', true),
        minBodiesForFreedom: cfgGet('sentinel.minBodiesForFreedom', 1),
        freedomLabel: cfgGet('sentinel.freedomLabel', 'TACTICAL FREEDOM'),
        burnedLabel: cfgGet('sentinel.burnedLabel', 'BURNED'),
        liveLabel: cfgGet('sentinel.liveLabel', 'LIVE')
      }, options.sentinel || {});
      this.damage = options.damage || (ST.DamageEngine ? new ST.DamageEngine({ gen: 9 }) : null);
      this.evaluator = options.evaluator || (ST.DenseStateEvaluator ? new ST.DenseStateEvaluator() : null);
      this.trickRoom = options.trickRoom || (ST.TrickRoomEngine ? new ST.TrickRoomEngine(this.damage) : null);
      this.tempo = options.tempo || (ST.TempoEngine ? new ST.TempoEngine({ damage: this.damage, trickRoom: this.trickRoom }) : null);
      this.veto = options.veto || (ST.BlunderVetoGuard ? new ST.BlunderVetoGuard({ damage: this.damage, trickRoom: this.trickRoom }) : null);
      this.sampler = options.sampler || (ST.WorldSampler ? new ST.WorldSampler({ K: this.K }) : null);
      // The optional tiers. Each one ships `enabled: false` in config, so what actually runs by
      // default is these constructors and nothing else: turning a tier ON is a config edit rather
      // than a code change, and no tier is a file nobody consumes.
      this.profiler = options.profiler || (ST.OpponentProfiler ? new ST.OpponentProfiler() : null);
      this.scouting = options.scouting || (ST.InformationGain ? new ST.InformationGain({ damage: this.damage }) : null);
      this.wincon = options.wincon || (ST.WinConditionBounty ? new ST.WinConditionBounty({ damage: this.damage }) : null);
      this.endgame = options.endgameSolver || (ST.EndgameSolver
        ? new ST.EndgameSolver({ damage: this.damage, evaluator: this.evaluator })
        : null);
      this._oppSeen = null;        // the opponent snapshot the profiler's observation feed compares to
      this._reread = false;        // true while a re-read of the same window is in flight (see evaluateTurn)
      this._lastOppMix = null;     // the equilibrium mix published for the turn just resolved
      this._oppSwitchFactor = 1;   // this turn's column factor from the profiler (1 = inert)
      this._winconPlan = null;     // this turn's win-condition plan (null = no bounty)
      this.lastReadout = null;
      this.turnCache = {};
    }

    /* ------------------------------------------------------------- actions */

    /** Legal player actions: 4 moves + living bench switches. */
    getMyActions(state) {
      const out = [];
      if (!state) return out;
      const legal = state.legalActions || {};
      const moves = legal.moves || [];
      const seen = {};
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        if (!m || m.disabled) continue;
        const id = U.toID(m.id || m.name);
        if (!id || seen[id]) continue;
        seen[id] = 1;
        const data = U.getMoveData(m.name || m.id);
        out.push({
          kind: data && data.isProtect ? 'protect' : 'move',
          name: m.name || m.id,
          moveId: id,
          targetId: null,
          pp: m.pp,
          maxpp: m.maxpp
        });
      }
      if (!out.length) {
        const active = state.active && state.active.my;
        /* A FORCED REPLACEMENT IS NOT A MOVE TURN. On a `forceSwitch` frame the request carries no
         * move list precisely because the body standing there has fainted, and ARCHITECTURE.md
         * Rule 10 leaves that body in `state.active.my` until its replacement arrives. Falling
         * through to the set's own moves here built a menu for a fainted body, and `evaluateTurn`
         * then ranked `move <its move>` as a REPLACEMENT — an action the server cannot accept, on
         * the one frame whose whole purpose is picking the best bring-in. The frame ranks bench
         * switches or nothing at all. */
        const canMove = !legal.forceSwitch && !legal.wait && !(active && active.fainted);
        const fallback = canMove && active && ((active.setMoves && active.setMoves.length && active.setMoves) ||
          (active.liveSet && active.liveSet.moves) || active.revealedMoves || []);
        for (let i = 0; fallback && i < fallback.length; i++) {
          const name = fallback[i];
          if (!name) continue;
          const id = U.toID(name);
          if (seen[id]) continue;
          seen[id] = 1;
          const data = U.getMoveData(name);
          out.push({ kind: data && data.isProtect ? 'protect' : 'move', name: name, moveId: id, targetId: null });
        }
      }
      const switches = legal.switches || [];
      for (let i = 0; i < switches.length; i++) {
        const s = switches[i];
        if (!s) continue;
        out.push({ kind: 'switch', name: s.name || s.id, moveId: null, targetId: s.id || s.slot || s.name, switchSlot: s.slot });
      }
      /* The bench scan is a FALLBACK for a board with no authoritative action list (a fixture, a
       * driver-built state). It must never re-add body rows the request already ruled out: the
       * request is the only thing that knows the server will refuse them, and re-deriving them from
       * `myTeam` here put a TRAPPED body's switch back on the menu (`legal.switches` is empty
       * precisely because every bench body is illegal), which the sim answers with
       * `|error|[Invalid choice] Can't switch: The active Pokémon is trapped`. */
      if (!switches.length && !legal.trapped) {
        const bench = (state.myTeam || []).filter(function (mon) {
          return mon && !mon.fainted && !mon.isActive && mon.revealed !== false;
        });
        for (let i = 0; i < bench.length && i < this.maxSwitchFallback; i++) {
          out.push({ kind: 'switch', name: bench[i].species || bench[i].id, moveId: null, targetId: bench[i].species || bench[i].id, switchSlot: bench[i].slot });
        }
      }
      return out;
    }

    /** Plausible opponent actions inside a sampled world: their 4 moves (+ switches). */
    getOppActions(world, state) {
      const out = [];
      const active = world && world.team ? world.team.find(function (m) { return m.isActive; }) || world.team[0] : null;
      const moves = (active && active.setMoves) || [];
      for (let i = 0; i < moves.length; i++) {
        const name = moves[i];
        if (!name) continue;
        const data = U.getMoveData(name);
        out.push({
          kind: data && data.isProtect ? 'protect' : 'move',
          name: name,
          moveId: U.toID(name),
          targetId: null
        });
      }
      const bench = (world && world.team ? world.team : []).filter(function (m) { return m && !m.fainted && !m.isActive; });
      for (let i = 0; i < bench.length && i < 4; i++) {
        out.push({ kind: 'switch', name: bench[i].species, moveId: null, targetId: bench[i].species });
      }
      if (!out.length) out.push({ kind: 'move', name: 'Struggle', moveId: 'struggle' });

      // Opponent deliberation prior (src/opponent_clock.js): a body that submits its move
      // essentially the instant we do is not studying the switch screen. When the reading is
      // confident and fast, their PIVOTS are dropped from the reply space instead of being
      // kept at equal weight — every payoff, world vote and equilibrium frequency downstream
      // then reads "they are attacking", which is the whole point of the telemetry. The
      // fallback matters: a reply space with no moves left over must not become empty.
      const prior = this._oppSwitchPrior(state);
      this.lastOppPrior = prior;
      if (prior.keepSwitchReplies) return out.slice(0, this.maxOppActions);
      const attacksOnly = out.filter(function (action) { return action.kind !== 'switch'; });
      return (attacksOnly.length ? attacksOnly : out).slice(0, this.maxOppActions);
    }

    /**
     * Read the clock telemetry (state.clock, written by src/content.js from OpponentClock) and
     * decide whether this turn's opponent reply space keeps their switch lines. No clock, no
     * snapshot or a disabled clock all mean "no opinion": every reply is kept, exactly as
     * before the telemetry existed.
     */
    _oppSwitchPrior(state) {
      const none = { label: 'unknown', factor: 1, keepSwitchReplies: true };
      const clock = state && state.clock;
      if (!clock || clock.enabled === false) return none;
      const factor = (typeof clock.switchFactor === 'number' && isFinite(clock.switchFactor) && clock.switchFactor > 0)
        ? clock.switchFactor : 1;
      const label = typeof clock.label === 'string' ? clock.label : 'unknown';
      const keep = factor >= cfgGet('clock.switchKeepThreshold', 0.5);
      return { label: label, factor: factor, keepSwitchReplies: keep };
    }

    /* ------------------------------------------------------- HUD previews */

    /**
     * preview(targetMon, state) -> what OUR legal moves do to ONE named body.
     *
     * This is the data behind two HUD features at once: the bench-tap sandbox (preview what a
     * coverage move does to the body they are about to bring in) and the lethal-roll gauge (the
     * KO probability the library itself computes). It never guesses: a move the target is immune
     * to reports 0 / 'none' because that is what the calculator returns, and every line carries
     * the band the config's `hud.lethal` thresholds put it in, so the HUD colours nothing itself.
     *
     * Returns null when there is nothing to say (no active pair, no damage engine, no lines).
     */
    preview(targetMon, state) {
      const myActive = state && state.active ? state.active.my : null;
      if (!myActive || !targetMon || !this.damage) return null;
      const field = (state && state.field) || {};
      const actions = this.getMyActions(state);
      const lines = [];
      const opts = this._believedTargetOpts(targetMon);
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        if (!action || action.kind === 'switch') continue;   // switching is not a damage line
        const name = action.name || action.moveId;
        if (!name) continue;
        const data = U.getMoveData(name);
        let res = null;
        try { res = this.damage.calculateDamage(myActive, targetMon, name, field, opts); } catch (e) { res = null; }
        if (!res || res.failed) continue;
        const minPercent = typeof res.minPercent === 'number' ? res.minPercent : 0;
        const maxPercent = typeof res.maxPercent === 'number' ? res.maxPercent : 0;
        const koChancePct = (typeof res.koChancePct === 'number' && isFinite(res.koChancePct)) ? res.koChancePct : 0;
        const isStatus = !!(data && data.isStatus);
        const lethal = isStatus ? 'none' : this.lethalBand(res);
        lines.push({
          moveId: action.moveId || U.toID(name),
          name: name,
          isStatus: isStatus,
          minPercent: U.round1(minPercent),
          maxPercent: U.round1(maxPercent),
          koChancePct: U.round1(koChancePct),
          isOHKO: !!res.isOHKO,
          is2HKO: !!res.is2HKO,
          lethal: lethal,
          verdict: this.lethalVerdict(res, data),
          desc: res.desc || ''
        });
      }
      if (!lines.length) return null;
      return {
        target: {
          species: targetMon.species || targetMon.id || '',
          id: targetMon.id || U.toID(targetMon.species),
          hpPercent: typeof targetMon.hpPercent === 'number' ? targetMon.hpPercent : null,
          isActive: !!targetMon.isActive
        },
        lines: lines
      };
    }

    /**
     * _believedTargetOpts(mon) -> the `{ defender: {...} }` override that describes a target by
     * the set we BELIEVE it holds, or `{}` when we have no opinion yet.
     *
     * This exists because a body's own card is not its set. A monster seen on the field carries an
     * all-zero EV placeholder and no item, so describing it verbatim prices our moves against an
     * uninvested, item-less defender: the first bench-tap fixture read 500% for a Ground move into
     * an Air Balloon Gholdengo that the library scores at 0, and every other number was inflated in
     * the same direction. `liveSet` is the pruner's current best set — the same one the sampler
     * weights — and it carries the spread, the nature and the item (whose type immunity is a fact
     * about the matchup, not a detail: an Air Balloon is a Ground immunity and a Choice Band is a
     * 1.5x Attack). Falls back to the first surviving candidate set, then to the bare card.
     */
    _believedTargetOpts(mon) {
      const set = (mon && mon.liveSet && typeof mon.liveSet === 'object')
        ? mon.liveSet
        : ((mon && mon.candidateSets && mon.candidateSets[0]) || null);
      if (!set) return {};
      return { defender: {
        evs: set.evs,
        ivs: set.ivs,
        nature: set.nature,
        item: set.item,
        ability: set.ability,
        level: set.level
      } };
    }

    /** previewVsBench(species, state) -> the same shape for an opponent BENCH body, else null. */
    previewVsBench(species, state) {
      const wanted = U.toID(species);
      if (!wanted) return null;
      const team = (state && state.oppTeam) || [];
      for (let i = 0; i < team.length; i++) {
        const mon = team[i];
        if (!mon || mon.fainted || mon.isActive) continue;
        if (mon.id === wanted || U.toID(mon.species) === wanted) {
          const preview = this.preview(mon, state);
          if (preview) preview.target.isActive = false;
          return preview;
        }
      }
      return null;
    }

    /** The lethal band for a damage result: config thresholds, never a number written here. */
    lethalBand(res) {
      if (!res) return 'none';
      if (res.isOHKO) return 'guaranteed';
      const ko = (typeof res.koChancePct === 'number' && isFinite(res.koChancePct)) ? res.koChancePct : 0;
      if (ko >= cfgGet('hud.lethal.high', 67)) return 'high';
      if (ko >= cfgGet('hud.lethal.mid', 34)) return 'mid';
      return 'none';
    }

    /** Short human verdict for the gauge, in the same voice as the request's example card. */
    lethalVerdict(res, moveData) {
      if (!res) return '';
      if (moveData && moveData.isStatus) return 'status move';
      if (res.isOHKO) return 'Guaranteed lethal';
      const max = typeof res.maxPercent === 'number' ? res.maxPercent : 0;
      const ko = (typeof res.koChancePct === 'number' && isFinite(res.koChancePct)) ? res.koChancePct : 0;
      if (max <= 0) return '0% (Immune)';
      if (res.is2HKO) return '2HKO';
      if (ko >= 1) return Math.round(ko) + '% KO chance';
      return 'leaves them at ~' + Math.max(0, Math.round(100 - max)) + '% HP';
    }

    /* ------------------------------------------------ risk-adjusted volatility */

    /**
     * The fraction of the setup extension's second exchange to price (see config.js
     * `laplace.quiescence.followUpWeight`). Returns exactly 1 for a missing, non-finite or
     * out-of-range value, so `x * 1` -- an exact IEEE multiplication -- is what an untouched build
     * gets.
     */
    _followUpWeight() {
      const w = this.quiescence && this.quiescence.followUpWeight;
      if (typeof w !== 'number' || !isFinite(w)) return 1;
      return U.clamp(w, 0, 1);
    }

    /** The accuracy the client's own dex reported for this action, or null when unknown. */
    _accuracyOf(state, action) {
      const table = state && state.moveAccuracy ? state.moveAccuracy : null;
      if (!table || !action) return null;
      const id = U.toID(action.moveId || action.name || '');
      if (!id) return null;
      const v = table[id];
      if (v === true) return true;
      return typeof v === 'number' && isFinite(v) ? v : null;
    }

    /**
     * _volatilityDelta(action, state, field, score) -> { penalty, why }
     *
     * The "tilt penalty" (ARCHITECTURE §6.5). Standard scoring prices a 70%-accurate move at 0.7
     * of its damage, but a MISS in a Trick Room window does not merely cost 30% of a move: it
     * gives the opponent a free turn with the setter exposed. So the row loses
     *     accuracyWeight * (1 - acc) * score        -- the part of the upside a miss throws away
     *   + (1 - acc) * threat * fragilityScale * m   -- and the swinging door it leaves behind
     * where `threat` is the library's own best incoming damage into our active mon and `m` is the
     * extra `lethalMultiplier` when that threat is itself lethal (accuracy <= 
     * lethalChargeMaxAccuracy, and a MINIMUM roll already kills).
     *
     * Every input is measured — the accuracy from the client's dex (`|stacc|`), the threat from
     * the damage engine — and an action whose accuracy we do not know is charged NOTHING rather
     * than an assumed number. Returns a zero penalty for status moves, switch rows and whenever
     * `laplace.volatility.enabled` is false.
     */
    _volatilityDelta(action, state, field, score) {
      const none = { penalty: 0, why: null };
      const cfgObj = this.volatility;
      if (!cfgObj || cfgObj.enabled === false) return none;
      if (!action || action.kind !== 'move' || !this.damage) return none;
      const data = U.getMoveData(action.name || action.moveId);
      if (!data || data.isStatus || !data.basePower) return none;
      const accuracy = this._accuracyOf(state, action);
      if (accuracy === null) return none;
      if (accuracy === true || accuracy >= cfgObj.accuracyFloor) return none;
      const miss = 1 - accuracy / 100;
      if (!(miss > 0)) return none;

      const opp = state && state.active ? state.active.opp : null;
      const mine = state && state.active ? state.active.my : null;
      let threat = 0;
      let threatBy = '';
      let lethal = false;
      if (opp && mine) {
        let best = null;
        try { best = this.damage.getBestIncomingThreat(opp, mine, field); } catch (e) { best = null; }
        if (best) {
          threat = (typeof best.avgPercent === 'number' && isFinite(best.avgPercent)) ? best.avgPercent : 0;
          threatBy = best.move || '';
          const myHp = this._hp(mine);
          lethal = typeof best.minPercent === 'number' && best.minPercent >= myHp;
        }
      }
      const w = U.clamp(typeof cfgObj.accuracyWeight === 'number' ? cfgObj.accuracyWeight : 1, 0, 1);
      const upsideLost = w * miss * (typeof score === 'number' && isFinite(score) ? score : 0);
      const chargedLethal = lethal && accuracy <= cfgObj.lethalChargeMaxAccuracy;
      const charge = miss * threat * cfgObj.fragilityScale * (chargedLethal ? cfgObj.lethalMultiplier : 1);
      // Comeback mode scales the whole charge, never the accuracy itself: being behind does not
      // make a 70% move more likely to hit, it changes how much the miss costs us relative to the
      // safe line we would otherwise take. `scale === 1` is bit-identical to the raw charge.
      const comeback = this._comebackScale(state);
      const penalty = -(upsideLost + charge) * comeback;
      if (!penalty) return none;
      let why = (data.name || action.name) + ' lands ' + accuracy + '% of the time: ' +
        U.round1(upsideLost) + ' of upside given up';
      if (charge) {
        why += ' + ' + U.round1(charge) + ' fragility';
        if (chargedLethal) why += ' (a miss hands ' + U.round1(threat) + '% from ' + threatBy + ', which is lethal)';
      }
      if (comeback !== 1) why += ' — comeback mode x' + U.round1(comeback) + ' (the board is ' +
        (comeback > 1 ? 'won' : 'lost') + ')';  
      return { penalty: penalty, why: why };
    }

    /**
     * _boardScore(state) -> number
     * The evaluator's own read of the CURRENT board (+ = good for us). Defensive: a missing
     * evaluator or an evaluator that throws yields 0, which the callers treat as "no opinion".
     */
    _boardScore(state) {
      if (!this.evaluator || typeof this.evaluator.evaluate !== 'function' || !state) return 0;
      try {
        const v = this.evaluator.evaluate(state);
        return (typeof v === 'number' && isFinite(v)) ? v : 0;
      } catch (e) { return 0; }
    }

    /**
     * _comebackScale(state) -> multiplier on the volatility charge (exactly 1 unless enabled).
     * Winning: sharpen the charge (minimum variance). Losing: soften it (we need the swing). In
     * between, or with no rating of the board, the identity.
     */
    _comebackScale(state) {
      const c = this.comeback;
      if (!c || c.enabled === false) return 1;
      const board = this._boardScore(state);
      if (board >= c.winMargin) return c.winChargeScale;
      if (board <= c.lossMargin) return c.lossChargeScale;
      return 1;
    }

    /**
     * _urgencyDelta(action, state) -> { delta, why }
     * The turn-urgency re-pricing (patience decay). Past `laplace.urgency.startTurn` a COMMITTING
     * line (a real attack or a setup move) gains a bounded bonus and a PASSIVE line (Protect, or a
     * status move that does not progress the board) takes a bounded malus; both ramp to their cap
     * at `rampTurn` and are multiplied by `breakoutScale` at `breakoutTurn`. Before `startTurn` the
     * delta is exactly 0, so the default build is unaffected.
     *
     * This does NOT weaken `quiescence.blockProtect` — that a Protect blocks our move is a game
     * rule, not a preference. What changes is which ROW the engine prefers as the clock runs out.
     */
    _urgencyDelta(action, state) {
      const u = this.urgency;
      if (!u || u.enabled === false || !action) return { delta: 0, why: null };
      const turn = (state && typeof state.turn === 'number') ? state.turn : 0;
      if (turn < u.startTurn) return { delta: 0, why: null };
      const span = Math.max(1, u.rampTurn - u.startTurn);
      const weight = U.clamp((turn - u.startTurn) / span, 0, 1);
      const scale = turn >= u.breakoutTurn ? u.breakoutScale : 1;
      const role = this._commitmentOf(action);
      if (role === 'commit') {
        const delta = Math.round(u.maxBonus * weight * scale);
        if (!delta) return { delta: 0, why: null };
        return { delta: delta, why: 'turn ' + turn + ': a committing line forces a conclusion' };
      }
      if (role === 'passive') {
        const delta = -Math.round(u.passiveMalus * weight * scale);
        if (!delta) return { delta: 0, why: null };
        return { delta: delta, why: 'turn ' + turn + ': a passive line cannot end the game' };
      }
      return { delta: 0, why: null };
    }

    /**
     * _switchTaxDelta(action) -> { delta, why }
     *
     * The pivot tax: a flat drag on every SWITCH row, so a pivot has to be better than an attack by
     * `points` before it takes the top line. It is a POLICY term, not a deduction about the
     * opponent — the payoff matrix already prices the incoming hit and the hazards on entry; what it
     * does not price is the free turn a pivot hands over.
     *
     * Measured before it was written (tools/benchmark_human_match.js, 100 elite battles / 5,903
     * decisions, mean rating 1,830, re-derived from that run's --out records): the engine's top line
     * is a switch on 55.4% of contested turns where those humans switched 33.8%, and on turns the
     * human CLICKED A MOVE it still preferred a pivot 39.0% of the time even with a full 4-attack
     * menu (48.1% on 0-1 attacks). The two candidate causes tested first are both refuted — dropping
     * `quiescence.extendSetup` moves top-1 by net -21 and the pivot rate UP to 54.2%, suppressing
     * VETO4 net -22 and leaves it flat at 53.7%. The full tier then FAILED the win-rate gate
     * (-26.7 points, 95% CI [-38.3, -15.0]); the config comment records what it did to each half.
     * Ships OFF; `enabled: false` returns exactly 0 for every row.
     */
    _switchTaxDelta(action) {
      const t = this.switchTax;
      if (!t || t.enabled === false || !action || action.kind !== 'switch') return { delta: 0, why: null };
      const points = (typeof t.points === 'number' && isFinite(t.points)) ? Math.abs(t.points) : 0;
      if (!points) return { delta: 0, why: null };
      return { delta: -points, why: 'a pivot hands the turn over' };
    }

    /** 'commit' | 'passive' | 'neutral' for the turn-urgency re-pricing. */
    _commitmentOf(action) {
      if (!action) return 'neutral';
      if (action.kind === 'protect') return 'passive';
      if (action.kind !== 'move') return 'neutral';
      const id = U.toID(action.moveId || action.name || '');
      if (!id) return 'neutral';
      if (U.PROTECT_MOVES.has(id)) return 'passive';
      const data = U.getMoveData(action.name || action.moveId);
      if (!data) return 'neutral';
      if (data.isSetup) return 'commit';
      if (data.isStatus) return 'passive';
      if (typeof data.basePower === 'number' && data.basePower >= this.urgency.minBasePower) return 'commit';
      return 'neutral';
    }

    /* -------------------------------------------------- team-preview lead advisory */

    /**
     * leadAdvisory(state) -> { leads, best, risky, count } | null
     *
     * The Turn-0 read. At team preview both rosters are visible and nothing else is, so the one
     * decision worth pricing is which of OUR six to lead. Each candidate is scored against every
     * opposing body through the SAME leaf evaluator every in-battle decision uses (a two-body
     * board, both at their current HP, our side active) — never through a type chart written down
     * here, because the evaluator already folds types, Speed and bulk together.
     *
     * `favorability` maps the evaluator's own output (already squashed into +/-evaluator.scale)
     * onto 0..100, so 50 is an even board and the number is absolute rather than relative to the
     * sample. `best` is the highest-scoring lead, `risky` the lowest, so the HUD can show the pair
     * without re-deriving either. Returns null when both rosters are not yet known.
     */
    leadAdvisory(state) {
      if (!state || !this.evaluator || !cfgGet('hud.leadAdvisory.enabled', true)) return null;
      const mine = (state.myTeam || []).filter(function (m) { return m && !m.fainted; });
      const theirs = (state.oppTeam || []).filter(function (m) { return m && !m.fainted; });
      if (!mine.length || !theirs.length) return null;
      const scale = cfgGet('evaluator.scale', 1000) || 1000;

      const leads = [];
      for (let i = 0; i < mine.length; i++) {
        const my = mine[i];
        if (!my || !my.species) continue;
        let best = -Infinity;
        let bestVs = null;
        for (let j = 0; j < theirs.length; j++) {
          const their = theirs[j];
          if (!their || !their.species) continue;
          const score = this._matchupScore(state, my, their);
          if (score > best) { best = score; bestVs = their; }
        }
        if (best === -Infinity) continue;
        const fav = U.clamp(Math.round(50 + 50 * (best / scale)), 0, 100);
        leads.push({
          species: my.species,
          score: U.round1(best),
          favorability: fav,
          vs: bestVs ? bestVs.species : null,
          reason: bestVs
            ? ('best matchup vs ' + bestVs.species + ' (' + fav + '% favorability)')
            : 'no opposing body to judge'
        });
      }
      if (!leads.length) return null;

      let bestLead = leads[0];
      let risky = leads[0];
      for (let k = 1; k < leads.length; k++) {
        if (leads[k].score > bestLead.score) bestLead = leads[k];
        if (leads[k].score < risky.score) risky = leads[k];
      }
      return { leads: leads, best: bestLead, risky: risky, count: leads.length };
    }

    /** The evaluator's read of a lone two-body matchup, on a board built only from the pair. */
    _matchupScore(state, myMon, theirMon) {
      if (!this.evaluator || typeof this.evaluator.evaluate !== 'function') return 0;
      const board = {
        turn: 0,
        mySide: (state && state.mySide) || 'p1',
        oppSide: (state && state.oppSide) || 'p2',
        formatSupported: true,
        myTeam: [myMon],
        oppTeam: [theirMon],
        active: { my: myMon, opp: theirMon },
        field: (state && state.field) || {},
        protect: {
          oppTurnsSinceLastProtect: 99, oppConsecutiveProtects: 0,
          myTurnsSinceLastProtect: 99, myConsecutiveProtects: 0
        },
        recoveryPP: {}
      };
      try {
        const v = this.evaluator.evaluate(board);
        return (typeof v === 'number' && isFinite(v)) ? v : 0;
      } catch (e) { return 0; }
    }

    /* ------------------------------------------------------- the PP-stall pivot */

    /** Every move id we know a body can hold, from the paste, the log or its surviving sets. */
    _knownMoves(mon) {
      if (!mon) return [];
      const lists = [mon.setMoves, mon.revealedMoves,
        mon.liveSet && mon.liveSet.moves,
        mon.candidateSets && mon.candidateSets[0] && mon.candidateSets[0].moves];
      const out = [];
      const seen = Object.create(null);
      for (let i = 0; i < lists.length; i++) {
        const list = lists[i];
        if (!Array.isArray(list)) continue;
        for (let k = 0; k < list.length; k++) {
          const id = U.toID(list[k]);
          if (!id || seen[id]) continue;
          seen[id] = true;
          out.push(id);
        }
      }
      return out;
    }

    /** Set-legal setup / recovery moves a body can hide behind, from what we actually know. */
    _setupThreats(mon) {
      if (!mon) return [];
      const lists = [mon.revealedMoves, mon.setMoves, mon.liveSet && mon.liveSet.moves];
      const candidate = mon.candidateSets && mon.candidateSets[0];
      if (candidate && candidate.moves) lists.push(candidate.moves);
      const out = [];
      const seen = Object.create(null);
      for (let i = 0; i < lists.length; i++) {
        const list = lists[i];
        if (!Array.isArray(list)) continue;
        for (let k = 0; k < list.length; k++) {
          const id = U.toID(list[k]);
          if (!id || seen[id]) continue;
          const data = U.getMoveData(list[k]);
          if (!data) continue;
          const stalling = data.isStatus && (data.isSetup || data.isRecovery || data.isProtect);
          if (!stalling) continue;
          seen[id] = true;
          out.push(data.name || list[k]);
        }
      }
      return out;
    }

    /**
     * ppStall(state) -> the Sucker Punch PP gauge and the 3-way pivot (ARCHITECTURE §6.4).
     *
     * This is OUR move: the counter answers "how many Sucker Punches do I still have", which is
     * the question the whole feature exists for (the busted play is clicking Sucker Punch into a
     * Protect/Substitute/Dance loop until it runs out). So the PP comes off OUR body, in order of
     * authority: the `|request|` payload (the server's own numbers for our side), then the
     * `|stpp|` snapshot, then the count of times we have SEEN it clicked. With no snapshot the
     * readout flags `observesOnly` and shows that count, so nobody can mistake it for a real
     * remaining total. The THREAT, on the other hand, is theirs — their setup/recovery moves are
     * what stalls the move out.
     *
     * The matrix is built from the engine's own `_payoff` and solved with the same fictitious
     * play the main decision uses; a column whose action the opponent cannot legally click is
     * dropped rather than filled in with a stand-in.
     *
     * Null when there is nothing honest to show.
     */
    ppStall(state) {
      const cfgObj = this.ppStallCfg;
      if (!cfgObj || cfgObj.enabled === false || !state) return null;
      const opp = state.active ? state.active.opp : null;
      const mine = state.active ? state.active.my : null;
      if (!opp || !mine) return null;
      const watch = Array.isArray(cfgObj.watch) ? cfgObj.watch : [];
      const headlineId = U.toID(cfgObj.headline || watch[0] || '');
      if (!headlineId) return null;

      // 1. the server's own numbers for OUR side, when a |request| has arrived — but only if that
      // request is still about the body standing there. `legalActions.forId` is the body the
      // numbers belong to; after a switch with no request behind it they belong to the body that
      // left, and reading them here would print ONE body's PP next to ANOTHER body's moves.
      const reqForId = U.toID((state.legalActions && state.legalActions.forId) || '');
      const mineId = U.toID((mine.id || mine.species) || '');
      const staleRequest = !!(reqForId && mineId && reqForId !== mineId);
      const legal = (!staleRequest && state.legalActions && Array.isArray(state.legalActions.moves))
        ? state.legalActions.moves : [];
      let pp = null;
      let maxpp = null;
      let observesOnly = true;
      for (let i = 0; i < legal.length; i++) {
        const m = legal[i];
        if (!m || U.toID(m.id || m.name) !== headlineId) continue;
        if (typeof m.pp === 'number' && isFinite(m.pp)) { pp = m.pp; observesOnly = false; }
        if (typeof m.maxpp === 'number' && isFinite(m.maxpp)) maxpp = m.maxpp;
        break;
      }
      // 2. then the page's own snapshot of our body
      const snapshot = (mine.ppSnapshot && mine.ppSnapshot[headlineId]) || null;
      if (!observesOnly && snapshot) {
        if (pp === null && typeof snapshot.pp === 'number') pp = snapshot.pp;
        if (maxpp === null && typeof snapshot.maxpp === 'number') maxpp = snapshot.maxpp;
      } else if (snapshot && (typeof snapshot.pp === 'number' || typeof snapshot.maxpp === 'number')) {
        if (typeof snapshot.pp === 'number') { pp = snapshot.pp; observesOnly = false; }
        if (typeof snapshot.maxpp === 'number') maxpp = snapshot.maxpp;
      }
      const usedCount = (mine.ppUsed && typeof mine.ppUsed[headlineId] === 'number') ? mine.ppUsed[headlineId] : 0;
      if (pp === null && maxpp === null && !usedCount) return null;
      // A second guard on the same question, for the case the request cannot answer: the move has
      // to belong to the body we are counting it FOR. When the observed PP is trustworthy (the
      // request was stale and this came off our own body instead), a body whose known moves
      // EXCLUDE the watched move still cannot be the body that owns that PP. Only a body whose
      // moves we actually know can be contradicted; an unknown body is never disproved.
      const known = this._knownMoves(mine);
      if (known.length && known.indexOf(headlineId) === -1) return null;
      const data = U.getMoveData(headlineId);
      const move = {
        id: headlineId,
        label: (data && data.name) || headlineId,
        pp: pp,
        maxpp: maxpp,
        remaining: pp,
        used: usedCount,
        observesOnly: observesOnly
      };

      // The threat is THEIRS: their setup / recovery / Protect moves are what strands the move.
      const setupMoves = this._setupThreats(opp);
      const theirHp = this._hp(opp);
      const read = setupMoves.length
        ? (setupMoves.join(' / ') + ' can stall it out' +
          (theirHp > cfgObj.setupThreatHp ? '' : ' and they are at ' + U.round1(theirHp) + '%: expect the stall click'))
        : null;

      // The matrix is only worth solving while the watched move still has PP to lose.
      let matrix = null;
      let advice = null;
      const fraction = (typeof pp === 'number' && typeof maxpp === 'number' && maxpp > 0) ? pp / maxpp : 1;
      if (fraction >= cfgObj.minPpFraction) {
        const rows = [{ label: move.label, kind: 'move', moveId: headlineId, action: { kind: 'move', name: (data && data.name) || headlineId, moveId: headlineId } }];
        // Our best other attack, straight from the damage engine.
        const other = this.damage && typeof this.damage.getBestOutgoingMove === 'function'
          ? this.damage.getBestOutgoingMove(mine, opp, state.field || null) : null;
        if (other && other.move && U.toID(other.move) !== headlineId) {
          rows.push({ label: other.move, kind: 'move', action: { kind: 'move', name: other.move, moveId: U.toID(other.move) } });
        }
        const setupName = this._setupThreats(mine)[0] || null;
        if (setupName) {
          rows.push({ label: setupName, kind: 'move', action: { kind: 'move', name: setupName, moveId: U.toID(setupName) } });
        }
        const cols = [];
        const theirBest = this.damage && typeof this.damage.getBestOutgoingMove === 'function'
          ? this.damage.getBestOutgoingMove(opp, mine, state.field || null) : null;
        if (theirBest && theirBest.move) {
          cols.push({ label: theirBest.move, kind: 'move', action: { kind: 'move', name: theirBest.move, moveId: U.toID(theirBest.move) } });
        }
        const theirSetup = this._setupThreats(opp)[0] || null;
        if (theirSetup) {
          cols.push({ label: theirSetup, kind: 'move', action: { kind: 'move', name: theirSetup, moveId: U.toID(theirSetup) } });
        }
        if (rows.length > 1 && cols.length) {
          const payoff = [];
          for (let i = 0; i < rows.length; i++) {
            const row = [];
            for (let j = 0; j < cols.length; j++) {
              let value = 0;
              try { value = this._payoff(rows[i].action, cols[j].action, state, state.field || {}, null); }
              catch (e) { value = 0; }
              row.push(value);
            }
            payoff.push(row);
          }
          const solution = solveNashFictitiousPlay(payoff, (this.nash && this.nash.iterations) || NASH_ITERATIONS);
          matrix = { rows: rows, cols: cols, payoff: payoff, solution: solution };
          let best = 0;
          for (let i = 1; i < solution.rowValues.length; i++) {
            if (solution.rowValues[i] > solution.rowValues[best]) best = i;
          }
          advice = {
            moveId: rows[best].moveId || rows[best].action.moveId,
            label: rows[best].label,
            frequency: U.round1(solution.myStrategy[best] * 100),
            reason: cfgObj.adviceLabel + ': ' + rows[best].label + ' is worth ' +
              U.round1(solution.rowValues[best]) + ' against their equilibrium mix, so click it ' +
              U.round1(solution.myStrategy[best] * 100) + '% of the time'
          };
        }
      }

      return {
        // OUR body: the move being counted is ours, so the gauge must be labelled with ours.
        species: mine.species || mine.id || '',
        opponent: opp.species || opp.id || '',
        move: move,
        threat: { setupMoves: setupMoves, theirHp: U.round1(theirHp), read: read },
        matrix: matrix,
        advice: advice
      };
    }

    /* -------------------------------------------------------- format sentinel */

    /**
     * formatSentinel(state) -> the Z-Move / Mega Trap readout (ARCHITECTURE §6.6).
     *
     * Read entirely off `state.formatLocks` and the bodies themselves. "TACTICAL FREEDOM" is only
     * claimed when the lock is actually burned AND there are still unrevealed opposing bodies it
     * applies to; a sentence about a bench that does not exist would be noise.
     */
    formatSentinel(state) {
      const cfgObj = this.sentinelCfg;
      if (!cfgObj || cfgObj.enabled === false || !state) return null;
      const locks = state.formatLocks || {};
      const oppTeam = state.oppTeam || [];
      const findBody = function (flag) {
        for (let i = 0; i < oppTeam.length; i++) {
          const mon = oppTeam[i];
          if (mon && mon[flag]) return mon;
        }
        return null;
      };
      const megaMon = findBody('megaEvolved');
      const zMon = findBody('usedZMove');
      const mega = {
        burned: !!locks.oppHasMegaEvolved,
        species: megaMon ? (megaMon.species || megaMon.id) : null,
        turn: megaMon && megaMon.megaTurn ? megaMon.megaTurn : null,
        label: locks.oppHasMegaEvolved ? cfgObj.burnedLabel : cfgObj.liveLabel
      };
      const z = {
        burned: !!locks.oppHasUsedZMove,
        species: zMon ? (zMon.species || zMon.id) : null,
        turn: zMon && zMon.zMoveTurn ? zMon.zMoveTurn : null,
        label: locks.oppHasUsedZMove ? cfgObj.burnedLabel : cfgObj.liveLabel
      };
      const bench = {};
      let unrevealed = 0;
      for (let i = 0; i < oppTeam.length; i++) {
        const mon = oppTeam[i];
        if (!mon || mon.fainted) continue;
        if (!(mon.revealedMoves && mon.revealedMoves.length) && !mon.confirmedItem) unrevealed++;
      }
      bench.unrevealed = unrevealed;
      bench.stonesPossible = typeof locks.oppMegasRemaining === 'number' ? locks.oppMegasRemaining : 0;
      // `kind` names WHICH tactic a row is, so the glyph is the renderer's business: the bar maps
      // it through MobileHUD's own icon table (src/ui_overlay.js). The engine must not invent
      // bullet characters — the placeholders that used to live here ('X', '.', 'o') shipped as
      // visible text in the HUD.
      const tactics = [];
      if (mega.burned) {
        tactics.push({ kind: 'mega', label: 'Mega Evolution', detail: 'cannot be used again by any of their bodies' });
      }
      if (z.burned) {
        tactics.push({ kind: 'z', label: 'Z-Move', detail: 'cannot be used again by any of their bodies' });
      }
      if (mega.burned && z.burned && unrevealed >= cfgObj.minBodiesForFreedom) {
        tactics.push({
          kind: 'freedom', label: cfgObj.freedomLabel,
          detail: 'no unrevealed body can nuke you with a Z-Move, and ' +
            (bench.stonesPossible ? bench.stonesPossible + ' Mega Stone-carrying body is still possible'
              : 'no surviving candidate set can hold a Mega Stone')
        });
      }
      if (!mega.burned && !z.burned && !tactics.length) {
        tactics.push({ kind: 'live', label: 'Both mechanics live', detail: 'respect the unrevealed bench' });
      }
      return { mega: mega, z: z, tactics: tactics, bench: bench };
    }

    /**
     * overlordGauge(state) -> the Supreme Overlord readout, MEASURED rather than modelled.
     *
     * RULE 1 forbids writing the ability's "+10% Attack per fallen ally, max 5" rule down here,
     * so the multiplier is obtained by asking the library the same question twice — one probe
     * move against one probe defender, with `alliesFainted` set to the real count and then to
     * zero — and dividing its two answers. The effective Attack figure is the library's own stat
     * for this body scaled by that measured ratio. Null whenever the active body does not have
     * the ability, or when the library cannot answer.
     */
    overlordGauge(state) {
      const mon = state && state.active ? state.active.my : null;
      if (!mon || !this.damage) return null;
      if (U.toID(mon.revealedAbility || '') !== 'supremeoverlord') {
        const abilities = (mon.possibleAbilities && mon.possibleAbilities.length)
          ? mon.possibleAbilities : U.getAbilities(mon.species);
        let has = false;
        for (let i = 0; i < abilities.length; i++) {
          if (U.toID(abilities[i]) === 'supremeoverlord') { has = true; break; }
        }
        if (!has) return null;
      }
      const fallen = typeof mon.alliesFainted === 'number' ? mon.alliesFainted : 0;
      const probeMove = cfgGet('hud.overlord.probeMove', 'Kowtow Cleave');
      const probeDefender = { species: cfgGet('hud.overlord.probeDefender', 'Great Tusk'), hpPercent: 100 };
      let base = null, boosted = null;
      try {
        base = this.damage.calculateDamage(mon, probeDefender, probeMove, (state && state.field) || null, { attacker: { alliesFainted: 0 } });
        boosted = this.damage.calculateDamage(mon, probeDefender, probeMove, (state && state.field) || null, { attacker: { alliesFainted: fallen } });
      } catch (e) { return null; }
      if (!base || base.failed || !boosted || boosted.failed || !(base.avgDmg > 0)) return null;
      const ratio = boosted.avgDmg / base.avgDmg;
      const stats = U.statTable(mon.species || mon.id, {
        ivs: mon.ivs, evs: mon.evs, level: mon.level || 100, nature: mon.nature
      });
      const atk = stats && typeof stats.atk === 'number' ? stats.atk : null;
      return {
        species: mon.species || mon.id,
        fallen: fallen,
        ratio: ratio,
        percentBoost: Math.round((ratio - 1) * 100),
        effectiveAtk: atk === null ? null : Math.round(atk * ratio),
        probeMove: probeMove
      };
    }

    /* ------------------------------------------------------------- simulation */

    /**
     * simulate(action, world, battleState) -> SimResult
     * One-ply transition: both sides act, HP moves, faints latch, hazards/TR stay fixed.
     */
    simulate(action, world, battleState) {
      const state = battleState || {};
      const field = state.field || {};
      const myActive = (state.active && state.active.my) || null;
      const oppActive = this._oppActive(world, state);
      const result = {
        state: state,
        myPercentDelta: 0,
        oppPercentDelta: 0,
        events: [],
        myMove: action ? action.name : null,
        oppMon: oppActive ? oppActive.species : null
      };
      if (!myActive || !oppActive || !this.damage) return result;

      let myHp = this._hp(myActive);
      let oppHp = this._hp(oppActive);

      if (action && action.kind === 'move' || action && action.kind === 'protect') {
        const dmg = this._damageOf(myActive, oppActive, action.name, field, true);
        if (dmg) {
          oppHp = U.clamp(oppHp - dmg.avgPercent, 0, 100);
          result.oppPercentDelta = -dmg.avgPercent;
          result.events.push({ type: 'damage', side: 'p2', move: action.name, percent: U.round1(dmg.avgPercent), ohko: dmg.isOHKO });
        }
      } else if (action && action.kind === 'switch') {
        const incoming = this._switchTarget(state, action);
        if (incoming) {
          result.events.push({ type: 'switch', side: 'p1', species: incoming.species });
          const haz = field.hazards && field.hazards[state.mySide || 'p1'];
          const chip = U.hazardPercent(incoming.species || incoming.id,
            (incoming.currentBattleItem || incoming.confirmedItem || ''), incoming.revealedAbility || '', haz || {});
          if (chip > 0) {
            result.myPercentDelta = -chip;
            result.events.push({ type: 'hazards', side: 'p1', percent: chip });
          }
        }
      }

      // The opponent always gets their line.
      const oppBest = this._damageOf(oppActive, myActive, this._bestMove(oppActive, myActive, field), field, false);
      if (oppBest) {
        myHp = U.clamp(myHp - oppBest.avgPercent, 0, 100);
        result.myPercentDelta -= oppBest.avgPercent;
        result.events.push({ type: 'damage', side: 'p1', move: oppBest.move, percent: U.round1(oppBest.avgPercent), ohko: oppBest.isOHKO });
      }

      result.myHpAfter = myHp;
      result.oppHpAfter = oppHp;
      result.myFaints = myHp <= 0;
      result.oppFaints = oppHp <= 0;
      result.state = this._mutableSim(state, myActive, oppActive, myHp, oppHp, result);
      return result;
    }

    _oppActive(world, state) {
      if (world && world.team && world.team.length) {
        const active = world.team.find(function (m) { return m.isActive; });
        if (active) return active;
        const first = world.team[0];
        if (first) return first;
      }
      return (state.active && state.active.opp) || null;
    }

    _switchTarget(state, action) {
      const team = state.myTeam || [];
      const wanted = U.toID(action.targetId || action.name || '');
      for (let i = 0; i < team.length; i++) {
        const mon = team[i];
        if (!mon || mon.fainted || mon.isActive) continue;
        if (U.toID(mon.species || mon.id) === wanted) return mon;
        if (action.switchSlot && mon.slot === action.switchSlot) return mon;
      }
      for (let i = 0; i < team.length; i++) {
        if (team[i] && !team[i].fainted && !team[i].isActive && team[i].revealed !== false) return team[i];
      }
      return null;
    }

    /* ---------------------------- switch-in and turn-order pricing (the leaf corrections) */

    /**
     * _knownAbilityId(mon) -> the ability id this body's own evidence supports, or ''.
     * Authority order: what the protocol REVEALED, then the registered set (our own team is known
     * from the paste), then the pruner's current best candidate set. An unknown body returns '', and
     * every caller treats that as "no claim" — no tier here ever guesses an ability.
     */
    _knownAbilityId(mon) {
      if (!mon) return '';
      const direct = [mon.revealedAbility, mon.ability, mon.liveSet && mon.liveSet.ability];
      for (let i = 0; i < direct.length; i++) {
        const id = U.toID(direct[i]);
        if (id) return id;
      }
      const cand = mon.candidateSets && mon.candidateSets[0];
      return U.toID(cand && cand.ability);
    }

    /** _movePriority(name) -> the move's own priority bracket, from the dex (0 when unknown). */
    _movePriority(name) {
      const data = U.getMoveData(name);
      return data && typeof data.priority === 'number' ? data.priority : 0;
    }

    /**
     * _turnOrder(myMon, myMove, oppMon, oppMove, gain, field, state) -> 'me' | 'them' | null
     *
     * Who acts first on the NEXT turn. The priority bracket decides first (Protect's +4 is not a
     * Speed question), then effective Speed — with their stat stages carrying `gain`, which is the
     * entire point of pricing a setup turn, and through Trick Room, which inverts the comparison.
     *
     * Null when the order is genuinely undecidable: a Speed tie is a coin flip in this game, and a
     * coin flip is not a claim. Callers fall back to the un-ordered pricing there rather than
     * inventing a winner.
     */
    _turnOrder(myMon, myMove, oppMon, oppMove, gain, field, state) {
      if (!myMon || !oppMon || !U || typeof U.computeSpeed !== 'function') return null;
      const myPrio = this._movePriority(myMove);
      const oppPrio = this._movePriority(oppMove);
      if (myPrio !== oppPrio) return myPrio > oppPrio ? 'me' : 'them';
      const sides = state ? { my: state.mySide, opp: state.oppSide } : null;
      const speedOf = function (mon, extraSpe, sideKey) {
        const f = field || {};
        const tw = (sides && sideKey && f.tailwind) ? f.tailwind[sideKey] : false;
        try {
          return U.computeSpeed(mon, {
            // Same resolution order the veto layer and the HUD use, for the same reason: an item or
            // ability we actually hold must not vanish because the OBSERVED fields were never
            // populated (a paste-registered body only carries mon.item / mon.ability).
            item: mon.currentBattleItem || mon.confirmedItem || mon.item || (mon.liveSet && mon.liveSet.item),
            ability: mon.revealedAbility || mon.ability || (mon.liveSet && mon.liveSet.ability),
            boostStage: ((mon.boosts && mon.boosts.spe) || 0) + (extraSpe || 0),
            weather: f.weather || '',
            terrain: f.terrain || '',
            tailwind: !!tw,
            // The shared reading, not `boostedStat === 'spe'` on its own: a body only outruns us on
            // a LIVE boost, and Protosynthesis raising Attack is not a Speed multiplier at all
            // (util.paradoxSpeedBoost is the one place that rule lives — VETO4 was blind here once).
            paradoxSpeedBoost: U.paradoxSpeedBoost(mon),
            unburden: !!mon.unburden
          }).effective;
        } catch (e) { return null; }
      };
      const mySpeed = speedOf(myMon, 0, sides && sides.my);
      const oppSpeed = speedOf(oppMon, gain && gain.spe ? gain.spe : 0, sides && sides.opp);
      if (!isFinite(mySpeed) || !isFinite(oppSpeed) || mySpeed === oppSpeed) return null;
      const mineFaster = mySpeed > oppSpeed;
      const tr = !!(field && field.trickRoom);
      return (mineFaster !== tr) ? 'me' : 'them';
    }

    /**
     * _oppSwitchTarget(state, oppAction, world) -> the body THEY are switching to, or null.
     *
     * The sampled WORLD's own roster is the authority when there is one — its bodies carry the set
     * the sampler weighted (item, ability, spread), which is what the incoming body's entry hazards
     * and defensive numbers must be read from. Falls back to our own read of their team by species
     * name, and to null when even that cannot name it (the caller then keeps the old pricing).
     */
    _oppSwitchTarget(state, oppAction, world) {
      const wanted = U.toID((oppAction && (oppAction.targetId || oppAction.name)) || '');
      if (!wanted) return null;
      const pools = [world && world.team, state.oppTeam];
      for (let p = 0; p < pools.length; p++) {
        const team = pools[p];
        if (!Array.isArray(team) || !team.length) continue;
        for (let i = 0; i < team.length; i++) {
          const mon = team[i];
          if (!mon || mon.fainted || mon.isActive) continue;
          if (U.toID(mon.species || mon.id) === wanted) return mon;
        }
      }
      return null;
    }

    /**
     * _switchInHp(mon, state, field) — the HP the incoming OUR body has left after entry hazards.
     * The item/ability chain here is the ORIGINAL one, deliberately: this pricing predates the leaf
     * corrections and must stay byte-identical when their switches are off.
     */
    _switchInHp(mon, state, field) {
      const haz = field.hazards && field.hazards[state.mySide || 'p1'];
      const chip = U.hazardPercent(mon.species || mon.id,
        mon.currentBattleItem || mon.confirmedItem || '', mon.revealedAbility || '', haz || {});
      return U.clamp(this._hp(mon) - chip, 0, 100);
    }

    /**
     * _oppSwitchInHp(mon, state, field) — the incoming THEIR body's HP after OUR SIDE's hazards.
     * Same idea, with the FULL item/ability evidence: an opposing body's item is only ever known
     * from the protocol or from the sampled set, so `mon.item` / `liveSet.item` are part of the
     * chain here in a way they are not for our own pre-existing switch pricing.
     */
    _oppSwitchInHp(mon, state, field) {
      const haz = field.hazards && field.hazards[state.oppSide || 'p2'];
      const chip = U.hazardPercent(mon.species || mon.id,
        mon.currentBattleItem || mon.confirmedItem || mon.item || (mon.liveSet && mon.liveSet.item) || '',
        mon.revealedAbility || mon.ability || (mon.liveSet && mon.liveSet.ability) || '', haz || {});
      return U.clamp(this._hp(mon) - chip, 0, 100);
    }

    /**
     * _bestBenchSwitch(state, oppMon, field) -> the bench body that best TAKES this opponent's
     * attack — the smallest incoming damage from their best move, from the damage engine. This is
     * the body a FAST pivot brings in, because that body is the one that eats the reply.
     */
    _bestBenchSwitch(state, oppMon, field) {
      return this._bestBenchBody(state, oppMon, field, 'takes');
    }

    /**
     * _bestBenchAttacker(state, oppMon, field) -> the bench body that best THREATENS this opponent:
     * the largest damage it deals back. This is the body a SLOW pivot brings in, and it enters
     * CLEAN (the reply has already landed on the body that left), so what it resists is not the
     * question — what it does is.
     */
    _bestBenchAttacker(state, oppMon, field) {
      return this._bestBenchBody(state, oppMon, field, 'threatens');
    }

    /**
     * _bestBenchBody(...) -> that choice, memoised per turn.
     *
     * The memo is not an optimisation nicety: `_payoff` runs up to 432 times per turn and the pivot
     * row is priced once per opposing column, so without it the selector would run a full damage
     * search per bench body per column and the decision would blow its time budget. The key is the
     * opponent BODY (species + HP) plus the direction, so two columns that face the same opponent
     * share one answer, and the cache lives on the engine for exactly one evaluateTurn.
     *
     * ONE damage search per body, deliberately — not "the best of both directions", which would
     * double the cost of the hottest new path for a tie-break. Ties go to the earlier body in team
     * order, which is stable and explainable.
     */
    _bestBenchBody(state, oppMon, field, mode) {
      if (!oppMon) return null;
      const memo = this._pivotMemo || (this._pivotMemo = Object.create(null));
      const key = mode + '|' + U.toID(oppMon.species || oppMon.id) + '|' +
        U.round1(this._hp(oppMon)) + '|' + this._hp(state.active && state.active.my);
      if (key in memo) return memo[key];
      const bench = (state.myTeam || []).filter(function (m) {
        return m && !m.fainted && !m.isActive && m.revealed !== false;
      });
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < bench.length; i++) {
        const mon = bench[i];
        let score;
        if (mode === 'takes') {
          const theirs = this._damageOf(oppMon, mon, this._bestMove(oppMon, mon, field), field, false);
          // An unreadable threat is treated as the WORST one, so a body we cannot price is never
          // preferred for a job that means eating a hit.
          score = -(theirs ? theirs.avgPercent : 100);
        } else {
          const mine = this._damageOf(mon, oppMon, this._bestMove(mon, oppMon, field), field, true);
          score = mine ? mine.avgPercent : 0;
        }
        if (score > bestScore) { bestScore = score; best = mon; }
      }
      memo[key] = best;
      return best;
    }

    /**
     * _pivotPayoff(myAction, myActive, oppSideMon, oppAction, state, field, shielded, setup)
     *   -> { myHp, oppHp, mySideMon, oppSideMon, leafOpts, event }
     *
     * What a PIVOT actually is: one turn that does a hit, a switch and a matchup, in an order the
     * turn order decides. The 1-ply model priced it as "their damage lands on the body that is
     * LEAVING", so a pivot into a check scored exactly like a pivot into nothing and a pivot out of
     * a losing matchup was charged the loss it exists to escape.
     *
     * FAST (we act first): the hit lands, our body leaves, and the INCOMING body eats their reply.
     * SLOW (they act first): the body on the field eats the reply, and only then does the pivot
     * execute — a pivot user that faints to that hit never switches at all, which is the rule the
     * game plays by.
     *
     * Regenerator is credited to the body LEAVING (+1/3 of its max HP, in percent, on top of the HP
     * it had when it left), and Chilly Reception puts its snow up on the LEAF's field so the live
     * board is never written through. Their SETUP reply still gets its one-ply extension
     * (`quiescence.extendSetup`), now priced against the body that will actually be standing there.
     *
     * STATED APPROXIMATION: one further exchange is not modelled — the incoming body's OWN next move
     * is left to the leaf evaluator, exactly as it is for every other row.
     */
    _pivotPayoff(myAction, myActive, oppSideMon, oppAction, state, field, shielded, setup) {
      const outgoing = myActive;
      let myHp = this._hp(outgoing);
      let oppHp = this._hp(oppSideMon);
      let mySideMon = outgoing;
      const haz = field.hazards && field.hazards[state.mySide || 'p1'];
      const isSwitchReply = !!(oppAction && oppAction.kind === 'switch');

      const order = this._turnOrder(outgoing, myAction.name, oppSideMon,
        oppAction && oppAction.name, null, field, state);
      /* ONLY a decided order that goes our way is a FAST pivot. An undecidable order (a Speed
       * tie) is priced as the conservative case: the body on the field eats the reply. */
      const weActFirst = order === 'me';
      const incoming = weActFirst
        ? this._bestBenchSwitch(state, oppSideMon, field)
        : this._bestBenchAttacker(state, oppSideMon, field);

      /* Their live reply, priced against the body that will actually EAT it — the incoming body on
       * a fast pivot, the body on the field otherwise. A switch reply deals us nothing at all (it
       * has already been resolved into `oppSideMon`). Same-type bodies take very different numbers
       * here: the whole point of a pivot into a check is that the CHECK eats it. */
      const eater = (weActFirst && incoming) ? incoming : outgoing;
      const reply = (isSwitchReply || !oppAction) ? null
        : (oppAction.name === 'Struggle'
            ? { move: 'Struggle', avgPercent: this.struggleChipPercent }
            : this._damageOf(oppSideMon, eater, oppAction.name, field, false));

      if (!weActFirst) {
        if (reply && reply.avgPercent) myHp = U.clamp(myHp - reply.avgPercent, 0, 100);
        if (myHp <= 0) {
          // A fainted pivot user never pivots: no hit, no bring-in, and no Regenerator.
          return {
            myHp: myHp, oppHp: oppHp, mySideMon: outgoing, oppSideMon: oppSideMon, leafOpts: null,
            event: { move: reply ? reply.move : myAction.name, avgPercent: reply ? reply.avgPercent : 0, pivot: 'fainted' }
          };
        }
      }

      const hit = shielded ? null : this._damageOf(outgoing, oppSideMon, myAction.name, field, true);
      if (hit) oppHp = U.clamp(oppHp - hit.avgPercent, 0, 100);

      // The body leaving heals itself on the way out (Regenerator, +1/3 max HP).
      const regenPct = (this.pricePivots && typeof this.pricePivots.regenPct === 'number')
        ? this.pricePivots.regenPct : 33.3;
      const outgoingHp = this._knownAbilityId(outgoing) === 'regenerator'
        ? U.clamp(myHp + regenPct, 0, 100) : myHp;

      let leafOpts = null;
      if (incoming) {
        mySideMon = incoming;
        myHp = U.clamp(this._hp(incoming) - U.hazardPercent(incoming.species || incoming.id,
          incoming.currentBattleItem || incoming.confirmedItem || incoming.item || (incoming.liveSet && incoming.liveSet.item) || '',
          incoming.revealedAbility || incoming.ability || '', haz || {}), 0, 100);
        // Only the FAST pivot leaves the reply for the incoming body to eat.
        if (weActFirst && reply && reply.avgPercent) myHp = U.clamp(myHp - reply.avgPercent, 0, 100);
        /* The outgoing body stays on the leaf's bench, healed: it is a legal bring-in again, and
         * dropping it (the old mapping) both hid the Regenerator credit and deleted a body. */
        leafOpts = { keepOutgoing: true, outgoingHp: outgoingHp, incoming: incoming, field: field };
      }

      // Chilly Reception's snow goes on the LEAF's field, never the live one.
      const weather = U.WEATHER_BY_MOVE && U.WEATHER_BY_MOVE[U.toID(myAction.name)];
      if (weather && leafOpts) {
        leafOpts.field = Object.assign({}, field, { weather: weather });
      }

      // Their setup reply still buys its one extra exchange, now against the body standing there.
      let move = hit ? hit.move : myAction.name;
      let avgPercent = hit ? hit.avgPercent : 0;
      if (setup && setup.gain && !isSwitchReply) {
        const fu = this._setupFollowUp({ kind: 'switch', name: '' }, mySideMon, oppSideMon, mySideMon,
          setup.gain, setup.cost || 0, { oppHp: oppHp, myHp: myHp }, field, state);
        oppHp = fu.oppHp;
        myHp = fu.myHp;
        leafOpts = leafOpts || { keepOutgoing: true, outgoingHp: outgoingHp, incoming: mySideMon, field: field };
        move = fu.move;
        avgPercent = fu.avgPercent;
      }

      return {
        myHp: myHp, oppHp: oppHp, mySideMon: mySideMon, oppSideMon: oppSideMon, leafOpts: leafOpts,
        event: { move: move, avgPercent: avgPercent, pivot: weActFirst ? 'fast' : 'slow' }
      };
    }

    _mutableSim(state, myActive, oppActive, myHp, oppHp, result) {
      const sim = Object.create(state);
      sim.active = { my: myActive, opp: oppActive };
      sim._sim = {
        myHp: myHp, oppHp: oppHp,
        myFaints: result.myFaints, oppFaints: result.oppFaints
      };
      return sim;
    }

    _damageOf(attacker, defender, moveName, field, outgoing, opts) {
      if (!this.damage || !moveName) return null;
      try {
        const res = this.damage.calculateDamage(attacker, defender, moveName, field, opts);
        if (!res || res.failed) return null;
        return { move: moveName, minPercent: res.minPercent || 0, maxPercent: res.maxPercent || 0, avgPercent: res.avgPercent || 0, isOHKO: !!res.isOHKO, is2HKO: !!res.is2HKO };
      } catch (e) { return null; }
    }

    /**
     * Their best move AND the damage it does. `_bestMove` is the name-only view of this, kept so
     * the call sites that only want the label do not carry the result object around — and so the
     * quiescence follow-up does not pay for the search twice (one pass per candidate move, not
     * one to find the move and another to price the winner).
     */
    _bestMoveWithDamage(mon, target, field, opts) {
      const moves = (mon && mon.setMoves) || (mon && mon.liveSet && mon.liveSet.moves) || (mon && mon.revealedMoves) || [];
      let best = null, bestDmg = null;
      for (let i = 0; i < moves.length; i++) {
        const res = this._damageOf(mon, target, moves[i], field, false, opts);
        if (res && (!bestDmg || res.avgPercent > bestDmg.avgPercent)) { bestDmg = res; best = moves[i]; }
      }
      return { move: best || 'Struggle', damage: bestDmg };
    }

    _bestMove(mon, target, field, opts) {
      return this._bestMoveWithDamage(mon, target, field, opts).move;
    }

    _hp(mon) {
      if (!mon) return 100;
      let hp = mon.hpPercent;
      if (hp === null || hp === undefined) hp = mon.hp;
      if (hp === null || hp === undefined || hp !== hp) return 100;
      return hp;
    }

    /* ------------------------------------------------------------- evaluation */

    /**
     * Payoff of (myAction vs oppAction) in a simulated 1-ply state.
     *
     * This is STILL one turn: the leaf is the board after both sides have acted once. What
     * `laplace.quiescence` changes is the pricing of the two opponent replies the 1-ply model read
     * as no-ops — their SETUP move (no damage, and before this no state change either, so "they
     * click Dragon Dance" scored as a free hit for us) and their PROTECT (which blocks our move on
     * the real board, so a line that KOs their body scored the lethal bonus through the shield).
     */
    _payoff(myAction, oppAction, state, field, world, trace) {
      const myActive = state.active && state.active.my;
      const oppActive = state.active && state.active.opp;
      if (!myActive || !oppActive || !this.evaluator) {
        if (trace) trace.failed = true;
        return 0;
      }
      let myHp = this._hp(myActive);
      let oppHp = this._hp(oppActive);
      let mySideMon = myActive;
      /* The body that ends the turn standing on THEIR side, and the leaf options the two switch
       * tiers need. With every toggle below off these stay `oppActive` / `null`, which is the old
       * pricing exactly — every branch that reads them is gated on its own config switch. */
      let oppSideMon = oppActive;
      let leafOpts = null;
      const events = [];

      const q = this.quiescence;
      const qOn = !!(q && q.enabled !== false);
      /* A switch action's `name` is a SPECIES, not a move. Asking the move dex for one is not just
       * meaningless, it was the engine's single hottest line: 216 calls in one real turn, each one
       * a full scan of the dex (see the cache note in src/util.js). Only a move has move data, and
       * both consumers below are already kind-guarded. */
      const oppData = oppAction.kind === 'switch' ? null : U.getMoveData(oppAction.name);
      const oppUsesSetup = !!(qOn && q.extendSetup !== false && oppAction.kind === 'move' &&
        oppData && oppData.isSetup);
      // Their shield is a game rule, not a payoff term: a Protect that is up blocks our move.
      const shielded = !!(qOn && q.blockProtect !== false &&
        (oppAction.kind === 'protect' || (oppData && oppData.isProtect)));

      // The stat stages their setup leaves them with, and whether they can pay for it: Belly Drum
      // below half HP (Clangorous Soul below a third) FAILS, so a setup they cannot afford is the
      // wasted turn it is, not a free boost.
      let setupGain = null;
      let setupHpCost = 0;
      if (oppUsesSetup) {
        const spec = U.setupBoosts(oppAction.name);
        if (spec) {
          const gain = {};
          Object.keys(spec).forEach(function (k) { if (k !== 'hpCostPct') gain[k] = spec[k]; });
          const cost = spec.hpCostPct || 0;
          if (Object.keys(gain).length && oppHp > cost) { setupGain = gain; setupHpCost = cost; }
        }
      }

      /* ---- THEIR SWITCH IS RESOLVED BEFORE OUR MOVE IS PRICED. A switch reply used to be priced
       * by throwing our turn-1 hit away and resetting the outgoing body to 100%, so the incoming
       * body was never named, never paid its side's entry hazards, and never took the attack aimed
       * at it — the leaf board then had the WRONG body standing there. `oppSideMon` is that body:
       * the sampled world's own roster when a world is available, else our own read of their bench.
       * Unresolvable (a switch to a body we cannot name) keeps the old 100% reset. */
      let oppSwitchedIn = null;
      if (oppAction.kind === 'switch' && this.realOppSwitch && this.realOppSwitch.enabled !== false) {
        oppSwitchedIn = this._oppSwitchTarget(state, oppAction, world);
        if (oppSwitchedIn) {
          oppSideMon = oppSwitchedIn;
          oppHp = this._oppSwitchInHp(oppSwitchedIn, state, field);
        }
      }

      let pivot = null;
      if (myAction.kind === 'switch') {
        const incoming = this._switchTarget(state, myAction);
        if (incoming) {
          mySideMon = incoming;
          myHp = this._switchInHp(incoming, state, field);
        }
      } else if (myAction.kind === 'move' && this.pricePivots && this.pricePivots.enabled !== false &&
                 U.isPivotMove(myAction.name)) {
        /* A PIVOT is not a move plus a switch: it is one transaction whose orders matter (see
         * _pivotPayoff). It prices itself, including the reply, so it replaces everything below. */
        pivot = this._pivotPayoff(myAction, myActive, oppSideMon, oppAction, state, field, shielded,
          setupGain ? { gain: setupGain, cost: setupHpCost } : null);
      } else if (!shielded) {
        // Our move still lands on a turn they spend setting up — they are not attacking us yet.
        // It does NOT land through a Protect.
        if (this.priceRecovery && this.priceRecovery.enabled !== false && U.isRecoveryMove(myAction.name)) {
          /* A HEAL DEALS NO DAMAGE. The 1-ply model used to score Recover/Roost/Slack Off as a
           * wasted turn — the cell was priced on a board where the body stood at the HP it had
           * already lost — so a line whose entire point is "get out of range" could never outrank
           * clicking an attack. Credited BEFORE their reply (the body is alive while it chooses and
           * a healing move is not blocked by anything the reply does), clamped to 100. */
          const heal = typeof this.priceRecovery.defaultHealPct === 'number' ? this.priceRecovery.defaultHealPct : 50;
          myHp = U.clamp(myHp + heal, 0, 100);
          events.push({ move: myAction.name, healed: heal });
        } else {
          const dmg = this._damageOf(myActive, oppSideMon, myAction.name, field, true);
          if (dmg) {
            oppHp = U.clamp(oppHp - dmg.avgPercent, 0, 100);
            events.push(dmg);
          }
        }
      }

      if (pivot) {
        myHp = pivot.myHp;
        oppHp = pivot.oppHp;
        mySideMon = pivot.mySideMon;
        oppSideMon = pivot.oppSideMon;
        leafOpts = pivot.leafOpts;
        if (pivot.event) events.push(pivot.event);
      } else if (oppAction.kind === 'switch') {
        // Switched-out opponent survives; the new body is unscratched. With `realOppSwitch` off
        // (or the switch-in unresolved) that is the whole statement, exactly as before.
        oppHp = oppSwitchedIn ? oppHp : 100;
      } else if (setupGain && oppHp > 0) {
        // `oppHp > 0` is not a nicety. If our move already finished them THIS turn, there is no
        // next turn for them: a fainted body does not keep a boost and does not attack again, so
        // the extension must not invent the follow-up — which is exactly the "KO the setup user"
        // line the whole feature exists to reward. (Their DAMAGING replies keep the pre-existing
        // symmetric treatment, because who moves first is not modelled there either.)
        const followUp = this._setupFollowUp(myAction, myActive, oppActive, mySideMon, setupGain,
          setupHpCost, { oppHp: oppHp, myHp: myHp }, field, state);
        oppHp = followUp.oppHp;
        myHp = followUp.myHp;
        events.push({ move: followUp.move, avgPercent: followUp.avgPercent, boosted: true });
      } else {
        const dmg = oppAction.name === 'Struggle'
          ? { avgPercent: this.struggleChipPercent, isOHKO: false }
          : this._damageOf(oppActive, mySideMon, oppAction.name, field, false);
        if (dmg) {
          myHp = U.clamp(myHp - dmg.avgPercent, 0, 100);
        }
      }

      // The boost reaches the leaf only if it is still a LIVE fact: a body that ends this turn
      // fainted keeps no stat stages, so stamping them there would let the evaluator's boost dims
      // move a cell whose own board says the body is gone.
      const applied = (setupGain && oppHp > 0) ? setupGain : null;
      const sim = this._leafState(state, mySideMon, oppSideMon, myHp, oppHp,
        applied ? { opp: applied } : null, leafOpts);
      let score = this.evaluator.evaluate(sim);
      // Terminal bonuses keep the leaf evaluator honest about KOs.
      if (oppHp <= 0) score += this.lethalBonus;
      if (myHp <= 0) score -= this.lethalBonus;
      /* "Their switch ate our hit for free." The compensation is only owed while the hit really was
       * thrown away: with the substitution resolved, their new body is the one that ate it, and
       * paying this on top would credit the same event twice. It is unchanged whenever the tier is
       * off or the switch-in could not be named. */
      if (oppAction.kind === 'switch' && myAction.kind === 'move' && !oppSwitchedIn) score += this.switchAteHitBonus;

      // ---- the optional tiers, both inert unless their config section says otherwise ----
      // The profiler's COLUMN factor: we are not facing the perfectly rational opponent fictitious
      // play assumes, so their pivot lines carry proportionally more (or less) weight than the
      // equilibrium gave them. The factor is exactly 1 when the tier is off or the evidence is
      // thin, and `score * 1` is bit-identical to the payoff without this line.
      if (this._oppSwitchFactor !== 1 && oppAction.kind === 'switch') score *= this._oppSwitchFactor;
      // The win-condition bounty, paid when the body the MEASUREMENTS named as the one standing
      // between us and the sweep is gone from the simulated board. This is the one tier that can
      // outrank raw damage, which is exactly why it is capped in config and off by default.
      if (this._winconPlan && this.wincon) {
        const paid = this.wincon.bonus(this._winconPlan, this._faintedIds(sim));
        if (paid) score += paid;
      }
      /* The 2-ply beam's out-parameter. `_payoff` is the only thing that knows the board a cell
       * LEAVES BEHIND -- which body switched in, the HP after its entry hazards, a pivot's incoming
       * body -- so a caller refining cells hands in an empty object and gets that board back instead
       * of re-deriving it from the same prices. Every other caller passes nothing, so the hot path
       * pays one falsy check for a feature it does not use. */
      if (trace) {
        trace.myHp = myHp;
        trace.oppHp = oppHp;
        trace.mySideMon = mySideMon;
        trace.oppSideMon = oppSideMon;
        trace.score = score;
      }
      return score;
    }

    /* ------------------------------------------------------------- 2-ply beam */

    /**
     * Is the selective 2-ply beam live for this call?
     *
     * `laplace.beam2Ply.enabled` is the switch and it ships FALSE, because this tier is measured
     * before it is adopted. A blend weight of 0 counts as OFF rather than as a harmless no-op:
     * `0 * v2` is NaN whenever `v2` is not finite, and a NaN cell would poison the row it was
     * supposed to leave alone. `force` is the background ponder's own switch (src/content.js),
     * which may run the beam for its deeper readout even while the shipped default has it off —
     * that pass advises, it does not emit the choice.
     */
    _beam2PlyOn(force) {
      const b = this.beam2Ply;
      if (!b || (b.enabled === false && !force) || !this.evaluator || !this.damage) return false;
      const w = b.blendWeight;
      if (!(typeof w === 'number' && isFinite(w) && w > 0)) return false;
      return Math.floor(b.topMy) > 0 && Math.floor(b.topOpp) > 0;
    }

    /**
     * _refineBeam2Ply(rawMatrix, worldRaw, myActions, allOppActions, ranked, state, worlds) -> plan
     *
     * The 1-ply Nash-filtered beam. A full 2-ply tree is `|myActions| x |theirReplies| x K`
     * evaluations — 9 x 9 across 6 worlds is 486 cells, ~2000 ms, and blows any phone budget — so
     * the refinement is restricted to the top `topMy` non-vetoed rows and the top `topOpp` columns.
     * That is the tier's ceiling: at most topMy x topOpp x K extra cells (9 x 6 = 54 on the shipped
     * numbers), each one a leaf evaluation plus two damage searches that the engine's per-turn
     * damage cache already serves.
     *
     * SELECTION IS BY 1-PLY EXPECTED VALUE, deliberately, rather than by a preliminary Nash solve:
     * it is one pass over a matrix the caller has already built, it is deterministic under ties (low
     * index wins), and a preliminary 2000-round fictitious play would be added to EVERY turn to
     * answer a question the EV ordering answers well enough at these sizes. Rows are ranked by their
     * mean priced cell; COLUMNS are ranked worst-for-us-first, which is the conservative reading of
     * "their most plausible replies" — the tier exists to see the follow-up that hurts.
     *
     * Every refined cell is `(1 - blendWeight) * ply1 + blendWeight * ply2`, where `ply1` is the
     * cell's own world-weighted 1-ply payoff and `ply2` the world-weighted Turn T+1 value from
     * `_ply2Value`. When a world could not price its follow-up (a refused trace) the 2-ply average
     * is taken over the worlds that could, which is a stated approximation rather than a silent one.
     *
     * Returns `{ rows, cols, cells, worlds, blendWeight }` for the readout, or null when no cell was
     * refined at all.
     */
    _refineBeam2Ply(rawMatrix, worldRaw, myActions, allOppActions, ranked, state, worlds) {
      const b = this.beam2Ply;
      const colCount = allOppActions.length;
      if (!colCount || !myActions.length || !worldRaw || !worldRaw.length) return null;
      const topMy = Math.max(1, Math.min(Math.floor(b.topMy), myActions.length));
      const topOpp = Math.max(1, Math.min(Math.floor(b.topOpp), colCount));

      const rowVal = [];
      for (let i = 0; i < myActions.length; i++) {
        if (ranked[i] && ranked[i].isVetoed) continue;      // a vetoed row is not a candidate answer
        let sum = 0, n = 0;
        for (let j = 0; j < colCount; j++) if (rawMatrix[i][j] !== null) { sum += rawMatrix[i][j]; n++; }
        if (n) rowVal.push({ i: i, v: sum / n });
      }
      if (!rowVal.length) return null;
      rowVal.sort(function (a, b2) { return b2.v - a.v || a.i - b2.i; });

      const colVal = [];
      for (let j = 0; j < colCount; j++) {
        let sum = 0, n = 0;
        for (let i = 0; i < myActions.length; i++) if (rawMatrix[i][j] !== null) { sum += rawMatrix[i][j]; n++; }
        if (n) colVal.push({ j: j, v: sum / n });
      }
      colVal.sort(function (a, b2) { return a.v - b2.v || a.j - b2.j; });
      if (!colVal.length) return null;

      const rows = rowVal.slice(0, topMy).map(function (r) { return r.i; });
      const cols = colVal.slice(0, topOpp).map(function (c) { return c.j; });
      const blend = U.clamp(b.blendWeight, 0, 1);
      const field = state.field || {};
      let cells = 0;

      for (let r = 0; r < rows.length; r++) {
        const i = rows[r];
        const mine = myActions[i];
        for (let c = 0; c < cols.length; c++) {
          const j = cols[c];
          if (rawMatrix[i][j] === null) continue;
          const their = allOppActions[j];
          let ply2Sum = 0, wSum = 0;
          for (let w = 0; w < worlds.length; w++) {
            const wd = worldRaw[w];
            if (!wd) continue;
            const local = wd.localByGlobal[j];
            if (typeof local !== 'number') continue;            // this world had no such reply
            const trace = (wd.traces && wd.traces[i]) ? wd.traces[i][local] : null;
            if (!trace || trace.failed) continue;
            const v2 = this._ply2Value(trace, state, field, worlds[w]);
            if (typeof v2 !== 'number' || !isFinite(v2)) continue;
            ply2Sum += wd.wgt * v2;
            wSum += wd.wgt;
          }
          if (!(wSum > 0)) continue;
          rawMatrix[i][j] = (1 - blend) * rawMatrix[i][j] + blend * (ply2Sum / wSum);
          cells++;
        }
      }
      if (!cells) return null;
      return { rows: rows, cols: cols, cells: cells, worlds: worlds.length, blendWeight: blend };
    }

    /**
     * _ply2Value(trace, state, field, world) -> the value of the board Turn T+1 starts from.
     *
     * WHAT THIS SEES THAT ONE PLY CANNOT: "that hit faints their body, and the body replacing it
     * outruns us" is a fact about turn T+1 that a turn-T cell scores as an ordinary KO. The board is
     * the one `_payoff` just left behind (through the trace), with three things applied:
     *
     *   1. POST-KO REVENGE REPLACEMENT. A body that fainted is replaced by the best surviving
     *      responder — theirs from the sampled world's own roster, ours from our team — each paying
     *      its side's entry hazards and each priced by the damage engine. A side with nothing left
     *      is the terminal win/loss at once (and a mutual wipe is a draw, not a win).
     *   2. THE FIELD TICKS. Trick Room, weather and terrain lose a turn, and a Trick Room that
     *      expires is OFF for the leaf rather than merely sitting at 0.
     *   3. THE T+1 EXCHANGE. The evaluator's read of that board, plus the best-outgoing minus
     *      best-incoming threat differential on the new active pair (also read from the engine), plus
     *      the lethal bonus for a body that fainted this turn.
     *
     * STATED APPROXIMATIONS, both of which are why the result is BLENDED with the 1-ply cell instead
     * of replacing it: the pair's own turn-T+1 moves are priced as a differential rather than
     * resolved in Speed order, and a replacement taken from a sampled world roster is APPENDED to
     * the board rather than mapped onto our own read of that team's bench slot.
     */
    _ply2Value(trace, state, field, world) {
      if (!trace || typeof trace.myHp !== 'number' || typeof trace.oppHp !== 'number') return null;
      let myMon = trace.mySideMon;
      let oppMon = trace.oppSideMon;
      if (!myMon || !oppMon) return null;
      let myHp = trace.myHp;
      let oppHp = trace.oppHp;
      const oppFainted = oppHp <= 0;
      const myFainted = myHp <= 0;

      if (oppFainted) {
        const responder = this._bestReplacement('opp', state, field, myMon, oppMon, world);
        if (!responder) return myFainted ? 0 : this.lethalBonus;
        oppMon = responder.mon;
        oppHp = responder.hp;
      }
      if (myFainted) {
        const relief = this._bestReplacement('my', state, field, oppMon, myMon, world);
        if (!relief) return -this.lethalBonus;
        myMon = relief.mon;
        myHp = relief.hp;
      }

      const f1 = this._tickField(field);
      const board = this._ply2Board(state, myMon, myHp, oppMon, oppHp, f1);
      let value = this.evaluator.evaluate(board);
      const tw = (typeof this.beam2Ply.threatWeight === 'number' && isFinite(this.beam2Ply.threatWeight))
        ? this.beam2Ply.threatWeight : 1;
      if (tw) {
        const mine = this._bestMoveWithDamage(myMon, oppMon, f1);
        const theirs = this._bestMoveWithDamage(oppMon, myMon, f1);
        const myDamage = mine.damage ? mine.damage.avgPercent : 0;
        const theirDamage = theirs.damage ? theirs.damage.avgPercent : 0;
        value += tw * (myDamage - theirDamage);
      }
      // The KO really happened even though a replacement arrived, so the bonus is still paid.
      if (oppFainted) value += this.lethalBonus;
      if (myFainted) value -= this.lethalBonus;
      return value;
    }

    /** One turn of field timers, on a COPY — the 2-ply leaf never writes through to the live board. */
    _tickField(field) {
      const f = Object.assign({}, field || {});
      if (typeof f.trickRoomTurnsLeft === 'number') {
        f.trickRoomTurnsLeft = Math.max(0, f.trickRoomTurnsLeft - 1);
        if (f.trickRoomTurnsLeft === 0) f.trickRoom = false;
      }
      if (typeof f.weatherTurnsLeft === 'number') f.weatherTurnsLeft = Math.max(0, f.weatherTurnsLeft - 1);
      if (typeof f.terrainTurnsLeft === 'number') f.terrainTurnsLeft = Math.max(0, f.terrainTurnsLeft - 1);
      return f;
    }

    /**
     * _ply2Board(state, myMon, myHp, oppMon, oppHp, field) -> a leaf board for Turn T+1.
     *
     * Deliberately NOT `_leafState`: that builder's team mapping exists to express a PIVOT on our
     * side (an incoming body taking the active slot while the outgoing one keeps its own HP). A
     * faint-replacement is a different shape — the body that left is GONE and a survivor takes its
     * place — and teaching `_leafState` both would put a second, subtler mapping on the hot path of
     * every turn in the tree. This builder puts the two asked-for bodies on the field, leaves every
     * other body at its own HP, and is the only place the 2-ply tier writes a board.
     */
    _ply2Board(state, myMon, myHp, oppMon, oppHp, field) {
      const mkActive = function (mon, hp) {
        const copy = Object.create(mon);
        copy.hp = hp;
        copy.hpPercent = hp;
        copy.fainted = hp <= 0;
        copy.isActive = true;
        return copy;
      };
      const myActive = mkActive(myMon, myHp);
      const oppActive = mkActive(oppMon, oppHp);
      const buildTeam = function (list, activeMon, activeClone) {
        const out = [];
        const src = list || [];
        let placed = false;
        for (let i = 0; i < src.length; i++) {
          const m = src[i];
          if (!m) continue;
          /* A body that IS the active one takes the active clone (its HP for this board); every
           * other body keeps its own entry, including a fainted one that is still on the team. A
           * replacement that is not in this list at all is appended below. */
          if (m === activeMon) { out.push(activeClone); placed = true; continue; }
          out.push(m);
        }
        if (!placed) out.push(activeClone);
        return out;
      };
      return {
        myTeam: buildTeam(state.myTeam, myMon, myActive),
        oppTeam: buildTeam(state.oppTeam, oppMon, oppActive),
        active: { my: myActive, opp: oppActive },
        field: field,
        bench: state.bench,
        protect: state.protect,
        recoveryPP: state.recoveryPP,
        terastallizationBanned: state.terastallizationBanned,
        mySide: state.mySide,
        oppSide: state.oppSide,
        turn: state.turn
      };
    }

    /**
     * _bestReplacement(side, state, field, target, departing, world) -> { mon, hp } | null
     *
     * WHO COMES IN after a faint, priced by the damage engine and by nothing else:
     *   - THEIR side ('opp'): the survivor from the sampled world's own roster that threatens our
     *     new active body MOST — the revenge killer. The world roster is preferred because it
     *     carries the set the sampler weighted (item, ability, spread).
     *   - OUR side ('my'): the survivor that threatens THEIR body most, with `_matchupScore` as the
     *     tie-break.
     * Both pay their side's entry hazards, and a body that would faint on entry is not a candidate
     * at all. Returns null when no body can come in, which the caller reads as the terminal result.
     */
    _bestReplacement(side, state, field, target, departing, world) {
      const theirs = side === 'opp';
      const list = theirs
        ? ((world && world.team && world.team.length) ? world.team : (state.oppTeam || []))
        : (state.myTeam || []);
      let best = null, bestScore = -Infinity, bestHp = 0;
      for (let i = 0; i < list.length; i++) {
        const mon = list[i];
        if (!mon || mon.fainted || mon === departing) continue;
        if (this._hp(mon) <= 0) continue;
        const hp = theirs ? this._oppSwitchInHp(mon, state, field) : this._switchInHp(mon, state, field);
        if (!(hp > 0)) continue;
        const res = this._bestMoveWithDamage(mon, target, field);
        let score = res.damage ? res.damage.avgPercent : 0;
        if (!theirs) {
          /* Damage first, matchup as the tie-break: `_matchupScore` is in evaluator units
           * (+/-1000), so scaling the damage past it keeps bulk/speed from outvoting reach. */
          score = score * 1000 + this._matchupScore(state, mon, target);
        }
        if (score > bestScore) { bestScore = score; best = mon; bestHp = hp; }
      }
      return best ? { mon: best, hp: bestHp } : null;
    }


    /**
     * _tiers(state, worlds, myActions) -> { profile, scouting, wincon, endgame, feedError }
     *
     * Publishes what each optional tier says, and sets the two per-turn fields `_payoff` reads
     * (`_oppSwitchFactor`, `_winconPlan`) — left at their inert values whenever a tier is off, so
     * the default path through this method costs four constructor checks and nothing else.
     */
    _tiers(state, worlds, myActions) {
      this._oppSwitchFactor = 1;
      this._winconPlan = null;
      const out = { profile: null, scouting: null, wincon: null, endgame: null, feedError: null };
      // The observation feed runs BEFORE the profile is read: it scores what the opponent provably
      // did last turn against the mix published for it. A feed bug must not cost a turn, so the
      // failure is PUBLISHED on the readout rather than swallowed.
      /* The observation feed is per-WINDOW, not per-call: it records what the opponent provably did
       * on the turn that just resolved. A re-read of a window Pass 1 already fed would publish the
       * same observation twice, so it is skipped there. (It is idempotent — the second call sees no
       * change — but skipping is also the cheaper of the two, and the readout it feeds is the one
       * Pass 1 published.) */
      if (!this._reread) {
        try { this._observeOpponent(state); } catch (e) { out.feedError = String((e && e.message) || e); }
      }
      if (this.profiler) {
        out.profile = this.profiler.profile(state);
        const factor = out.profile && typeof out.profile.switchFactor === 'number'
          ? out.profile.switchFactor : 1;
        if (isFinite(factor) && factor > 0) this._oppSwitchFactor = factor;
      }
      if (this.scouting && myActions && myActions.length) {
        out.scouting = this.scouting.gainFor(myActions[0], state);
      }
      if (this.wincon) {
        out.wincon = this.wincon.plan(state, worlds);
        this._winconPlan = out.wincon;
      }
      if (this.endgame && this.endgame.enabled) {
        /* ONE WORLD IS NOT EVIDENCE. `solveAcrossWorlds` drops the refusing worlds, reports a mate
         * only when every surviving world proves one with the SAME root action, and carries the
         * WORST case across worlds (`worldScores` alongside it) otherwise; it falls back to the
         * single-world report when `laplace.endgame.multiWorld` is off or only one world is usable,
         * which is the same call the tier made before the entry point existed. The `typeof` guard
         * keeps an injected stub that only implements `solve` working. */
        out.endgame = (typeof this.endgame.solveAcrossWorlds === 'function')
          ? this.endgame.solveAcrossWorlds(state, worlds)
          : this.endgame.solve(state, (worlds && worlds[0]) || null);
      }
      return out;
    }

    /**
     * _qreTau(state) -> the logit temperature for THIS turn, or 0 for the shipped hard response.
     *
     * The tier is off by default; when it is on, the rating is the one thing a temperature cannot
     * know on its own, because the deviation from the rational model belongs to the LOWER ladder:
     * at `lowRating` and below the full `tau` applies, at `highRating` and above it is 0 (exactly
     * the hard best response the minimax solve assumes), and in between it ramps linearly. No
     * rating is NOT evidence of a noisy opponent, so it resolves to 0 as well — an unknown seat is
     * played against rationally, which is the safe direction.
     */
    _qreTau(state) {
      const q = this.qre;
      if (!q || q.enabled !== true) return 0;
      const base = q.tau;
      if (!(typeof base === 'number' && isFinite(base) && base > 0)) return 0;
      const rating = state ? state.opponentRating : null;
      if (!(typeof rating === 'number' && isFinite(rating))) return 0;
      const high = (typeof q.highRating === 'number' && isFinite(q.highRating)) ? q.highRating : 1850;
      const low = (typeof q.lowRating === 'number' && isFinite(q.lowRating)) ? q.lowRating : 1100;
      if (rating >= high) return 0;
      if (rating <= low) return base;
      const span = high - low;
      return span > 0 ? base * ((high - rating) / span) : base;
    }

    /* ------------------------------------------- the opponent model (two gated tiers) */

    /**
     * _isSurpriseCoverage(action, myActive) -> is this row an UNREVEALED COVERAGE move?
     * (laplace.surpriseMask.)
     *
     * Three facts have to hold at once: it is a MOVE (not a pivot, not a shield), we have never
     * clicked it this battle, and its type is not one of our active body's own types. The third is
     * what makes it a SURPRISE rather than a secret: a STAB move's typing is readable straight off
     * the species, so an opponent pricing it is not telepathy. Everything a real information source
     * on the other side of the table could know is excluded on purpose — a move already in
     * `revealedMoves` has been seen, and a STAB move is implied by the body.
     */
    _isSurpriseCoverage(action, myActive) {
      const cfgMask = this.surpriseMask;
      if (!cfgMask || cfgMask.enabled !== true) return false;
      if (!action || action.kind !== 'move' || !myActive) return false;
      const data = U.getMoveData(action.name || action.moveId);
      if (!data || !data.type) return false;
      const id = U.toID(action.name || action.moveId || '');
      const revealed = myActive.revealedMoves || [];
      for (let i = 0; i < revealed.length; i++) {
        if (U.toID(revealed[i]) === id) return false;
      }
      return !(typeof U.hasType === 'function' && U.hasType(myActive.species || myActive.id, data.type));
    }

    /**
     * The opponent-perceived copy of the live submatrix (laplace.surpriseMask).
     *
     * `sub[k][j]` is the TRUE payoff of our live row k against their column j. Every row that
     * `_isSurpriseCoverage` claims is rebuilt as `w * true + (1 - w) * anchor`, where `anchor` is
     * our best REVEALED/STAB live row (the one whose payoff they can actually read) and `w` is
     * `unrevealedWeight`. At `w = 1` the copy would be the identity, so no copy is built at all.
     *
     * Returns null when the tier is off, when no live row is a surprise, or when there is no
     * revealed/STAB row to blend toward (a body whose whole set is a surprise has no read at all,
     * and inventing one would be the telepathy this tier exists to remove).
     */
    _surprisePerceived(sub, liveIdx, myActions, state) {
      const cfgMask = this.surpriseMask;
      if (!cfgMask || cfgMask.enabled !== true) return null;
      const myActive = state && state.active ? state.active.my : null;
      if (!myActive || !sub || !sub.length) return null;
      const rows = [];
      for (let k = 0; k < sub.length; k++) {
        if (this._isSurpriseCoverage(myActions[liveIdx[k]], myActive)) rows.push(k);
      }
      if (!rows.length) return null;
      let anchor = -1, anchorMean = -Infinity;
      for (let k = 0; k < sub.length; k++) {
        if (rows.indexOf(k) !== -1) continue;
        const mean = this._rowMean(sub[k]);
        if (mean > anchorMean) { anchorMean = mean; anchor = k; }
      }
      if (anchor < 0) return null;
      const w = U.clamp(typeof cfgMask.unrevealedWeight === 'number' ? cfgMask.unrevealedWeight : 1, 0, 1);
      if (w >= 1) return null;
      const perceived = [];
      for (let k = 0; k < sub.length; k++) perceived.push(sub[k].slice());
      for (let s = 0; s < rows.length; s++) {
        const k = rows[s];
        for (let j = 0; j < sub[k].length; j++) {
          perceived[k][j] = w * sub[k][j] + (1 - w) * sub[anchor][j];
        }
      }
      return {
        perceived: perceived,
        rows: rows,
        anchor: anchor,
        weight: w,                                  // what each surprise row kept of itself
        blend: U.round1((1 - w) * 100),             // ...and how much of the anchor it wears
        names: rows.map(function (k) { return myActions[liveIdx[k]] && myActions[liveIdx[k]].name; }),
        anchorName: myActions[liveIdx[anchor]] && myActions[liveIdx[anchor]].name
      };
    }

    _rowMean(row) {
      if (!Array.isArray(row) || !row.length) return 0;
      let sum = 0, seen = 0;
      for (let i = 0; i < row.length; i++) {
        const v = row[i];
        if (typeof v === 'number' && isFinite(v)) { sum += v; seen++; }
      }
      return seen ? sum / seen : 0;
    }

    /**
     * _opponentPrior(oppActions, state, worlds) -> the behavioral prior P_prior over the
     * opponent's OWN actions (laplace.nash.priorAnchored), normalized, or null when the tier is
     * off (or nothing could be said about a single one of their actions).
     *
     * This is the information an unanchored fictitious play does not have. It gives every action
     * the same ZERO credibility at round 0, so their first "best response" is an index tie-break
     * and an opponent blunder collects a full best response for as long as the average takes to
     * wash it out; `ATTEMPTS.md` E5 priced turning the hard solve off at +8.3 % against the pure
     * softmax, which read as the equilibrium over-defending against bluffs nobody makes.
     *
     * Every number here is MEASURED — the damage engine's own average percentages and the utility
     * module's own type chart, never a species rule:
     *   - a damaging move weighs its average damage into our active, with `attackFloor` under it so
     *     a weak-but-real option is not priced as nonexistent,
     *   - a non-damaging move weighs `setupUnsafe`, or `setupSafe` when our active cannot 2HKO them
     *     (a setup move is only an obvious reply when taking it is actually safe),
     *   - a switch weighs `switchBase`, and `switchEscape` when their active is facing a GUARANTEED
     *     OHKO from a REVEALED/STAB move of ours AND the body they would bring in resists that
     *     move's type — the two facts that make a pivot the obviously correct reply.
     * It is a PRIOR over their replies, not a policy: it is blended into the solve at
     * `priorWeight` and cannot by itself move a payoff.
     */
    _opponentPrior(oppActions, state, worlds) {
      const cfgPrior = this.nash && this.nash.priorAnchored;
      const n = oppActions ? oppActions.length : 0;
      if (!n || !cfgPrior || cfgPrior.enabled !== true) return null;
      const myActive = state && state.active ? state.active.my : null;
      const firstWorld = (worlds && worlds.length) ? worlds[0] : null;
      const worldActive = (firstWorld && firstWorld.team)
        ? firstWorld.team.filter(function (m) { return m && m.isActive; })[0] : null;
      const oppActive = (state && state.active ? state.active.opp : null) || worldActive || null;
      const field = (state && state.field) || {};
      const ourHit = myActive ? this._revealedStabBest(myActive, oppActive, field) : null;
      const safeToSetUp = !(ourHit && ourHit.damage && ourHit.damage.avgPercent >= 50);
      /* A malformed leaf must not become `NaN` and take the whole prior with it: a NaN weight is
       * neither `> 0` nor a number, so it would quietly drop one of their replies out of the
       * prior. Each weight is therefore read through a numeric fallback. */
      const weight = function (value, fallback) {
        return (typeof value === 'number' && isFinite(value)) ? value : fallback;
      };
      const attackFloor = weight(cfgPrior.attackFloor, 5);
      const setupSafe = weight(cfgPrior.setupSafe, 45);
      const setupUnsafe = weight(cfgPrior.setupUnsafe, 10);
      const switchBase = weight(cfgPrior.switchBase, 8);
      const switchEscape = weight(cfgPrior.switchEscape, 70);
      const raw = [];
      let total = 0;
      for (let j = 0; j < n; j++) {
        const action = oppActions[j];
        let w = 0;
        if (action && action.kind === 'switch') {
          w = switchBase;
          if (ourHit && ourHit.damage && ourHit.damage.isOHKO) {
            const body = this._oppBenchBody(action.targetId || action.name, worlds);
            if (body && ourHit.type && this._resistsType(body, ourHit.type)) w = switchEscape;
          }
        } else if (action) {
          const data = U.getMoveData(action.name || action.moveId);
          if (data && !data.isStatus && data.basePower > 0) {
            const dmg = this._damageOf(oppActive, myActive, action.name, field, true,
              this._believedTargetOpts(myActive));
            w = Math.max((dmg && dmg.avgPercent) || 0, attackFloor);
          } else {
            w = safeToSetUp ? setupSafe : setupUnsafe;
          }
        }
        raw.push(w > 0 ? w : 0);
        total += raw[j];
      }
      if (!(total > 0)) return null;
      return raw.map(function (w) { return w / total; });
    }

    /**
     * Our best REVEALED or STAB move into `oppActive`, with the damage it does and its type.
     * "Revealed or STAB" is the same rule `_isSurpriseCoverage` applies from the other side: this
     * is the part of our set the opponent could have read off the board.
     */
    _revealedStabBest(myActive, oppActive, field) {
      if (!myActive || !oppActive || !this.damage || typeof U.getMoveData !== 'function') return null;
      const moves = (myActive.setMoves && myActive.setMoves.length && myActive.setMoves) ||
        (myActive.liveSet && myActive.liveSet.moves) || myActive.revealedMoves || [];
      const revealed = myActive.revealedMoves || [];
      const opts = this._believedTargetOpts(oppActive);
      let best = null;
      for (let i = 0; i < moves.length; i++) {
        const name = moves[i];
        if (!name) continue;
        const data = U.getMoveData(name);
        if (!data || data.isStatus || !(data.basePower > 0)) continue;
        const id = U.toID(name);
        let seen = false;
        for (let r = 0; r < revealed.length; r++) {
          if (U.toID(revealed[r]) === id) { seen = true; break; }
        }
        const stab = typeof U.hasType === 'function' && U.hasType(myActive.species || myActive.id, data.type);
        if (!seen && !stab) continue;                       // the part of the set they have not seen
        const damage = this._damageOf(myActive, oppActive, name, field, true, opts);
        if (damage && (!best || damage.avgPercent > best.damage.avgPercent)) {
          best = { move: name, type: data.type, damage: damage };
        }
      }
      return best;
    }

    /** The bench body behind an opponent switch action, found across the sampled worlds. */
    _oppBenchBody(name, worlds) {
      const wanted = U.toID(name);
      const list = worlds || [];
      for (let w = 0; w < list.length; w++) {
        const team = (list[w] && list[w].team) || [];
        for (let i = 0; i < team.length; i++) {
          const body = team[i];
          if (!body || body.fainted || body.isActive) continue;
          if (U.toID(body.species || body.id) === wanted) return body;
        }
      }
      return null;
    }

    /** Does this body resist `type`? (The library's own chart, never a table of ours.) */
    _resistsType(body, type) {
      if (!body || !type || typeof U.typeEffectiveness !== 'function') return false;
      const eff = U.typeEffectiveness(type, body.species || body.id);
      return typeof eff === 'number' && eff < 1;
    }

    /**
     * Record what the opponent PROVABLY did on the turn that just resolved, so the profiler has
     * something real to score against the mix we published. Only two things are provable from the
     * state alone, and nothing else is recorded:
     *   - their ACTIVE BODY CHANGED while the body we last priced is still on their team and not
     *     fainted — a faint also swaps the body, and a replacement is not a CHOICE, which is why
     *     the fainted check is there;
     *   - exactly ONE new move was revealed, which names the move they clicked.
     * A profiler fed guesses is worse than one fed nothing, so every other turn is silent.
     */
    _observeOpponent(state) {
      const opp = (state && state.active) ? state.active.opp : null;
      const now = {
        activeId: opp ? U.toID(opp.id || opp.species) : null,
        revealed: this._revealedIds(opp)
      };
      const seen = this._oppSeen;
      this._oppSeen = now;
      if (!seen || !this.profiler) return null;
      let kind = null;
      let move = null;
      if (now.activeId && seen.activeId && now.activeId !== seen.activeId) {
        const team = state.oppTeam || [];
        for (let i = 0; i < team.length; i++) {
          const id = U.toID(team[i].id || team[i].species);
          if (id !== seen.activeId) continue;
          if (!team[i].fainted) kind = 'switch';   // it left the field ALIVE: that is a pivot
          break;
        }
      }
      if (!kind) {
        const added = now.revealed.filter(function (id) { return seen.revealed.indexOf(id) === -1; });
        if (added.length === 1) {
          move = added[0];
          const data = U.getMoveData(move);
          kind = (data && data.isProtect) ? 'protect'
            : (data && data.isSetup) ? 'setup'
              : (data && data.isRecovery) ? 'recovery' : 'attack';
        }
      }
      if (!kind) return null;
      this.profiler.observe({ kind: kind, predictedFreq: this._predictedFreq(kind, move), turn: state.turn });
      return { kind: kind, move: move };
    }

    /** The move ids we know a body has, from the lists the state manager maintains. */
    _revealedIds(mon) {
      const out = [];
      const lists = mon ? [mon.revealedMoves, mon.activeStintMoves] : [];
      for (let i = 0; i < lists.length; i++) {
        const list = lists[i];
        if (!Array.isArray(list)) continue;
        for (let k = 0; k < list.length; k++) {
          const id = U.toID(list[k]);
          if (id && out.indexOf(id) === -1) out.push(id);
        }
      }
      return out;
    }

    /**
     * The frequency our LAST solve gave to the reply we now know they made. A switch observation is
     * the whole switch MASS of the mix (the number the profiler's switchFactor is built to compare
     * against), a named move is its own column, and null means the matrix never priced that reply —
     * which the profiler records but refuses to score.
     */
    _predictedFreq(kind, move) {
      const mix = this._lastOppMix;
      if (!mix || !mix.length) return null;
      if (kind === 'switch') {
        let mass = 0, any = false;
        for (let i = 0; i < mix.length; i++) {
          if (mix[i].kind !== 'switch') continue;
          any = true;
          if (typeof mix[i].freq === 'number') mass += mix[i].freq;
        }
        return any ? mass : null;
      }
      if (move) {
        for (let i = 0; i < mix.length; i++) {
          if (mix[i].name && U.toID(mix[i].name) === move) return mix[i].freq;
        }
      }
      return null;
    }

    /** The ids of every body fainted on a simulated board — the bounty's payout condition. */
    _faintedIds(sim) {
      const out = [];
      const scan = function (list) {
        for (let i = 0; list && i < list.length; i++) {
          const m = list[i];
          if (!m || !m.fainted) continue;
          const id = U.toID(m.id || m.species);
          if (id && out.indexOf(id) === -1) out.push(id);
        }
      };
      scan(sim && sim.oppTeam);
      scan(sim && sim.myTeam);
      return out;
    }

    /**
     * _setupFollowUp(...) -> { myHp, oppHp, move, avgPercent }
     *
     * The extra exchange a setup reply buys. They spend this turn boosting; on the next turn their
     * best attack arrives from the BOOSTED state, and our line — the very move this row prices — is
     * repeated. On a switch row there is no second hit: the body is still coming in.
     *
     * STATED APPROXIMATIONS, because a one-turn solver has no business implying more certainty:
     *   - The second exchange IS ordered by the Speed each body will have there (the boost applied,
     *     Trick Room and move priority included) whenever `respectTurn2Speed` is on, which is the
     *     shipped default: a body that faints first does not act, and a KO either way still gets its
     *     lethal bonus. A TIE, or a Speed this board cannot read, falls back to the pre-existing
     *     "both actions land" pricing rather than to an invented coin flip.
     *   - Their second action is their best move from the boosted state, priced by the damage
     *     engine; the boost is passed to `calculateDamage` as an override, so stat stages, Choice
     *     lock, weather and ability all run through the one calculator the engine already uses.
     *     `followUpWeight` scales the DAMAGE of both second actions and nothing else: the boost still
     *     reaches the leaf, the Belly Drum HP cost is still paid in full, and 1.0 is an exact
     *     identity.
     *   - One extension, not a tree: their Protect is not re-checked on the second turn.
     */
    _setupFollowUp(myAction, myActive, oppActive, mySideMon, gain, hpCostPct, hp, field, state) {
      let oppHp = hpCostPct ? U.clamp(hp.oppHp - hpCostPct, 0, 100) : hp.oppHp;
      let myHp = hp.myHp;
      const asAttacker = { attacker: { boosts: gain } };
      const best = this._bestMoveWithDamage(oppActive, mySideMon, field, asAttacker);
      // Same stand-in as the main path when the body has no modelled attack at all.
      const dmg = best.damage || (best.move === 'Struggle' ? { avgPercent: this.struggleChipPercent } : null);
      /* The follow-up weight scales the DAMAGE the second exchange deals, never the game rules
       * around it: their boost still reaches the leaf, the Belly Drum HP cost below is still paid
       * in full, and the Speed order is still resolved. At 1.0 (the shipped value) this is an exact
       * identity -- `avgPercent * 1 === avgPercent` -- so the cell is unchanged. */
      const w = this._followUpWeight();
      const theirDamage = dmg ? dmg.avgPercent * w : 0;
      let again = null;
      if (myAction.kind === 'move') {
        again = this._damageOf(myActive, oppActive, myAction.name, field, true,
          { defender: { boosts: gain } });
      }
      const ourDamage = again ? again.avgPercent * w : 0;

      const q = this.quiescence;
      if (q && q.respectTurn2Speed && (ourDamage > 0 || theirDamage > 0)) {
        /* WHOSE SECOND ACTION LANDS FIRST. Both used to land unconditionally, so "boost, then kill
         * the setup user" and "boost, then die to the boosted hit" scored identically — the one
         * distinction the whole extension exists to draw. The order is decided from the Speed each
         * body will actually have on turn 2 (their boost applied), through Trick Room and move
         * priority; a tie or an unreadable Speed falls back to the old both-actions-land pricing
         * rather than inventing a coin flip. */
        const order = this._turnOrder(myActive, myAction.name, oppActive, best.move, gain, field, state);
        if (order === 'me') {
          oppHp = U.clamp(oppHp - ourDamage, 0, 100);
          // A body that faints first does not act: their boosted reply deals nothing.
          if (oppHp > 0) myHp = U.clamp(myHp - theirDamage, 0, 100);
        } else if (order === 'them') {
          myHp = U.clamp(myHp - theirDamage, 0, 100);
          // Same rule the other way: if their boosted hit finished us, our second action never
          // happens (and with it, the damage it would have dealt).
          if (myHp > 0) oppHp = U.clamp(oppHp - ourDamage, 0, 100);
        } else {
          if (theirDamage) myHp = U.clamp(myHp - theirDamage, 0, 100);
          if (ourDamage) oppHp = U.clamp(oppHp - ourDamage, 0, 100);
        }
        return { myHp: myHp, oppHp: oppHp, move: best.move, avgPercent: theirDamage, ordered: order };
      }

      if (theirDamage) myHp = U.clamp(myHp - theirDamage, 0, 100);
      if (ourDamage) oppHp = U.clamp(oppHp - ourDamage, 0, 100);
      return { myHp: myHp, oppHp: oppHp, move: best.move, avgPercent: theirDamage };
    }

    /**
     * _leafState(state, myMon, oppMon, myHp, oppHp, extraBoosts, opts) -> the simulated board.
     *
     * `opts` is only ever passed by the pivot tier, and defaulting it to `null` leaves every line
     * below reading exactly the values it read before that tier existed:
     *   - `field`   the leaf's own field. The pivot path needs one because Chilly Reception puts
     *               snow up, and writing the live `state.field` would write THROUGH to the real
     *               board (tests/invariants_check.js pins that a leaf clone is read-only to its
     *               source).
     *   - `keepOutgoing` / `outgoingHp`  a PIVOT leaves the body behind as a legal bring-in, so the
     *               team keeps it at its own HP instead of overwriting its slot with the incoming
     *               body. Without the option the old mapping stands: the active slot's member is
     *               replaced by the leaf's active body.
     */
    _leafState(state, myMon, oppMon, myHp, oppHp, extraBoosts, opts) {
      const leaf = {
        myTeam: null,
        oppTeam: null,
        field: (opts && opts.field) || state.field,
        active: { my: null, opp: null },
        bench: state.bench,
        protect: state.protect,
        recoveryPP: state.recoveryPP,
        terastallizationBanned: state.terastallizationBanned,
        mySide: state.mySide,
        oppSide: state.oppSide
      };
      const cloneMon = function (mon, hp, extra) {
        if (!mon) return null;
        const copy = Object.create(mon);
        copy.hp = hp;
        copy.hpPercent = hp;
        copy.fainted = hp <= 0;
        // A prototype clone shares the source's `boosts` OBJECT, so a stat stage the quiescence
        // extension adds has to become an OWN property — otherwise it would be written through to
        // the live board. The merge is additive because the stage is a delta on the current table.
        if (extra) {
          const merged = {};
          const base = mon.boosts || {};
          Object.keys(base).forEach(function (k) { merged[k] = base[k]; });
          Object.keys(extra).forEach(function (k) { merged[k] = (merged[k] || 0) + extra[k]; });
          copy.boosts = merged;
        }
        return copy;
      };
      leaf.active.my = cloneMon(myMon, myHp, extraBoosts && extraBoosts.my);
      leaf.active.opp = cloneMon(oppMon, oppHp, extraBoosts && extraBoosts.opp);
      const keepOutgoing = !!(opts && opts.keepOutgoing);
      const outgoingHp = keepOutgoing
        ? (typeof opts.outgoingHp === 'number' ? opts.outgoingHp : this._hp(state.active && state.active.my))
        : 0;
      const incoming = (keepOutgoing && opts.incoming) ? opts.incoming : null;
      // The bring-in IS the active body now. Only ever set on the pivot path: without an incoming
      // body the leaf's active clone inherits the flag from the live active body, which is already
      // true, so the legacy path stays bit-identical.
      if (incoming) leaf.active.my.isActive = true;
      const liveActive = state.active && state.active.my;
      leaf.myTeam = (state.myTeam || []).map(function (m) {
        /* The body coming IN takes the active slot it now occupies; the body going OUT keeps its own
         * slot, at its own HP, and is no longer active. Both matter: the team array is where the
         * evaluator reads every non-active body's HP from (dim 114), so a pivot whose outgoing body
         * was simply overwritten, and whose incoming body stayed flagged as a bencher, would score
         * the two bodies' HP the wrong way round. */
        if (incoming && m === incoming) return leaf.active.my;
        if (m === liveActive) {
          if (!keepOutgoing) return leaf.active.my;
          const clone = cloneMon(m, outgoingHp);
          clone.isActive = false;
          return clone;
        }
        return m;
      });
      leaf.oppTeam = (state.oppTeam || []).map(function (m) {
        if (m === (state.active && state.active.opp)) return leaf.active.opp;
        return m;
      });
      if (!leaf.myTeam.length && leaf.active.my) leaf.myTeam = [leaf.active.my];
      if (!leaf.oppTeam.length && leaf.active.opp) leaf.oppTeam = [leaf.active.opp];
      return leaf;
    }

    /* ------------------------------------------------------------- the loop */

    /** evaluateTurn(battleState, opts) -> RankedAction[] */
    evaluateTurn(battleState, opts) {
      opts = opts || {};
      const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const state = battleState;
      if (!state || state.formatSupported === false) {
        this.lastReadout = { worlds: [], tempo: null, ranked: [], elapsedMs: 0, skipped: true };
        return [];
      }
      const myActions = this.getMyActions(state);
      if (!myActions.length) {
        this.lastReadout = { worlds: [], tempo: null, ranked: [], elapsedMs: 0, skipped: true };
        return [];
      }

      /* A RE-READ OF THE SAME WINDOW (`opts.reread`) is what the Cancel window's background ponder
       * asks for: Pass 1 has already answered this exact request, so the second call must not
       * repeat the two per-turn side effects this method owns. `beginTurn` CLEARS the damage cache
       * it keys by turn, so re-running it would throw away the memo the deep pass is about to want;
       * `trickRoom.tick` advances the module's own history, and while it happens to be idempotent
       * for one field state, re-ticking is a side effect nobody needs twice. The tempo vector is
       * pure and therefore recomputed. This is the ONLY behavioural difference: the deep pass sees
       * exactly the board Pass 1 saw. */
      const reread = opts.reread === true;
      if (!reread && this.damage && typeof this.damage.beginTurn === 'function') {
        this.damage.beginTurn(state.turn + ':' + (state.revision || 0));
      }
      if (!reread && this.trickRoom && typeof this.trickRoom.tick === 'function') this.trickRoom.tick(state);
      const tempoVector = this.tempo ? this.tempo.computeVector(state) : null;
      if (this.trickRoom && tempoVector) tempoVector.trAdvice = this.trickRoom.advise(state);

      const worlds = this.sampler
        ? this.sampler.sampleWorlds(state, ST.SetDatabase || null, opts.K || this.K)
        : [{ id: 'w0', team: state.oppTeam || [], sets: [], weight: 1, violations: [] }];

      // The optional tiers, once per turn and BEFORE the matrix: two of them change a payoff (the
      // profiler's column factor and the win-condition bounty) and the other two are readouts
      // published on `lastReadout` below. `_reread` lets the observation feed skip its per-turn
      // bookkeeping on a re-read of the same window (see `_tiers`).
      this._reread = reread;
      const tiers = this._tiers(state, worlds, myActions);
      /* A FRESH MEMO PER TURN, for the pivot tier's bench selection. It caches on the OPPOSING body
       * and the board, so two rows that face the same opponent share one answer; reusing it across
       * turns would price this turn's pivot with last turn's board. Cleared here rather than in the
       * constructor because `evaluateTurn` is the only thing that establishes a turn's context. */
      this._pivotMemo = Object.create(null);

      const aggregate = {};
      const cellSum = [];      // cellSum[i][j]    = world-weighted payoff of our action i against their action j
      const cellWeight = [];   // cellWeight[i][j] = total world weight behind that cell
      for (let i = 0; i < myActions.length; i++) {
        const key = this._actionKey(myActions[i]);
        aggregate[key] = { action: myActions[i], scores: [], avg: 0, min: Infinity, worldScores: [] };
        cellSum.push([]);
        cellWeight.push([]);
      }
      // Each world may expose a different opponent action set, so the matrix columns are the
      // UNION of their replies in first-seen order; a cell no world produced falls back to that
      // row's mean, which is exactly the "average over their plausible replies" the risk blend
      // used. `allOppActions[j]` is the action behind column j.
      const oppKeyIndex = Object.create(null);
      const allOppActions = [];
      /* The 2-ply beam: whether it is live for THIS call (`opts.beam2Ply` can force it on, which is
       * what the background ponder in src/content.js asks for) and, when it is, the per-world
       * bookkeeping the refinement reads. `worldRaw` stays empty when the tier is off, so the
       * shipped path allocates nothing here. */
      const beamOn = this._beam2PlyOn(opts.beam2Ply);
      const worldRaw = [];

      for (let w = 0; w < worlds.length; w++) {
        const world = worlds[w];
        const oppActions = this.getOppActions(world, state);
        const wgt = typeof world.weight === 'number' && world.weight > 0 ? world.weight : 1;
        const colIdx = [];
        for (let j = 0; j < oppActions.length; j++) {
          const okey = this._actionKey(oppActions[j]);
          if (oppKeyIndex[okey] === undefined) {
            oppKeyIndex[okey] = allOppActions.length;
            allOppActions.push(oppActions[j]);
          }
          colIdx.push(oppKeyIndex[okey]);
        }
        /* The 2-ply beam's own bookkeeping, built ONLY when the tier is live so the shipped path
         * allocates nothing new: which of THIS world's local replies sits behind each global
         * column (a refinement has to know whether the world produced the cell at all), and the
         * `_payoff` trace for every cell (the board that cell leaves behind). */
        const localByGlobal = [];
        for (let j = 0; j < oppActions.length; j++) localByGlobal[colIdx[j]] = j;
        const traces = beamOn ? [] : null;
        for (let i = 0; i < myActions.length; i++) {
          const mine = myActions[i];
          const key = this._actionKey(mine);
          if (traces) traces[i] = [];
          let sum = 0, min = Infinity;
          for (let j = 0; j < oppActions.length; j++) {
            let trace = null;
            if (traces) { trace = {}; traces[i][j] = trace; }
            const payoff = this._payoff(mine, oppActions[j], state, state.field || {}, world, trace);
            sum += payoff;
            if (payoff < min) min = payoff;
            const col = colIdx[j];
            if (typeof cellSum[i][col] !== 'number') { cellSum[i][col] = 0; cellWeight[i][col] = 0; }
            cellSum[i][col] += payoff * wgt;
            cellWeight[i][col] += wgt;
          }
          const avg = oppActions.length ? sum / oppActions.length : 0;
          if (min === Infinity) min = avg;
          const blended = this.worldBlend.avg * avg + this.worldBlend.min * min;
          const bucket = aggregate[key];
          bucket.scores.push(blended);
          bucket.avg += blended;
          if (blended < bucket.min) bucket.min = blended;
          bucket.worldScores.push(blended);
        }
        if (beamOn) worldRaw.push({ wgt: wgt, localByGlobal: localByGlobal, traces: traces });
      }

      const scored = [];
      Object.keys(aggregate).forEach(function (key) {
        const bucket = aggregate[key];
        if (!bucket.scores.length) return;
        const avgScore = bucket.avg / bucket.scores.length;
        scored.push({
          name: bucket.action.name,
          kind: bucket.action.kind,
          moveId: bucket.action.moveId,
          targetId: bucket.action.targetId,
          score: avgScore,
          minScore: bucket.min,
          isVetoed: false,
          vetoReason: null,
          isOptimal: false
        });
      });

      // Risk-adjusted volatility (ARCHITECTURE §6.5): a per-row delta on OUR rows, computed
      // before the mask so the mask's own nudge still applies on top of it.
      const volDelta = [];
      const volWhy = [];
      for (let i = 0; i < myActions.length; i++) {
        const scoredRow = scored[i];
        const v = this._volatilityDelta(myActions[i], state, state && state.field,
          scoredRow && typeof scoredRow.score === 'number' ? scoredRow.score : 0);
        volDelta.push(v.penalty);
        volWhy.push(v.why);
      }

      // Turn urgency (patience decay): a per-row additive delta, computed the same way and folded
      // into the matrix alongside the volatility charge, so the mixed solve prices it too. Exactly
      // 0 for every turn before `laplace.urgency.startTurn`, which is the default build.
      const urgDelta = [];
      const urgWhy = [];
      for (let i = 0; i < myActions.length; i++) {
        const u = this._urgencyDelta(myActions[i], state);
        urgDelta.push(u.delta);
        urgWhy.push(u.why);
      }

      // The pivot tax, computed beside them and folded in the same two places, so the mixed solve
      // prices it exactly as it prices the volatility charge. 0 for every row on the shipped build.
      const swDelta = [];
      const swWhy = [];
      for (let i = 0; i < myActions.length; i++) {
        const sw = this._switchTaxDelta(myActions[i]);
        swDelta.push(sw.delta);
        swWhy.push(sw.why);
      }

      // Tempo policy mask (Protect/Bunker rhythm) before vetoes, per the brief.
      const masked = this.tempo ? this.tempo.applyPolicyMask(scored, tempoVector, state) : scored;
      // The mask is a policy nudge (multiplicative for contact attacks, additive for the Bunker
      // bonus), not a payoff. Keep it as a per-row delta so the mixed solve can fold it into the
      // matrix instead of silently overriding it.
      const maskDelta = [];
      for (let i = 0; i < masked.length; i++) {
        const base = scored[i] && typeof scored[i].score === 'number' ? scored[i].score : 0;
        const nudged = masked[i] && typeof masked[i].score === 'number' ? masked[i].score : 0;
        maskDelta.push(nudged - base);
      }

      const ranked = masked.map(function (row, index) {
        const copy = Object.assign({}, row);
        // The volatility charge is published on the row so the HUD (and a reader) can see why a
        // 70%-accurate line is no longer top of the list.
        if (volDelta[index]) {
          copy.volatilityPenalty = U.round1(volDelta[index]);
          copy.volatilityWhy = volWhy[index] || null;
        }
        if (urgDelta[index]) {
          copy.urgencyBonus = U.round1(urgDelta[index]);
          copy.urgencyWhy = urgWhy[index] || null;
        }
        if (swDelta[index]) {
          copy.switchTax = U.round1(swDelta[index]);
          copy.switchTaxWhy = swWhy[index] || null;
        }
        // BOTH deltas are folded into the simultaneous matrix below, which is the only place they
        // reach the mixed solve — but the SOFTMAX FALLBACK reads `score` directly (see
        // _softmaxConfidence), so a delta that lived only in the matrix silently stopped existing
        // whenever the solve did not run: laplace.nash.enabled false, a single live row, no
        // opponent actions, or a solve that failed its shape check. Fold it into the row score as
        // well. There is no double count: the solve path overwrites this with its own row value,
        // which already contains the same delta exactly once.
        if (typeof copy.score === 'number' && isFinite(copy.score)) {
          copy.score += (volDelta[index] || 0) + (urgDelta[index] || 0) + (swDelta[index] || 0);
        }
        if (this.veto) {
          const verdict = this.veto.evaluateVetoes({ kind: copy.kind, name: copy.name, moveId: copy.moveId, targetId: copy.targetId }, state, tempoVector);
          if (verdict && verdict.isVetoed) {
            copy.isVetoed = true;
            copy.vetoReason = verdict.reason;
            copy.vetoCode = verdict.code;
            copy.score = this.vetoScore;
          }
        }
        return copy;
      }, this);

      // ---- the simultaneous payoff matrix, with the tempo nudge folded in ----
      // Raw cells first (null where no world produced one), because the 2-ply refinement must see a
      // raw 1-ply payoff and not one already carrying a row delta: the deltas below are per-ROW
      // policy terms and folding them in before the blend would price the same penalty twice.
      const rawMatrix = [];
      for (let i = 0; i < myActions.length; i++) {
        const row = [];
        for (let j = 0; j < allOppActions.length; j++) {
          const wgt = cellWeight[i][j];
          row.push((typeof cellSum[i][j] === 'number' && wgt > 0) ? cellSum[i][j] / wgt : null);
        }
        rawMatrix.push(row);
      }
      const beamPlan = beamOn
        ? this._refineBeam2Ply(rawMatrix, worldRaw, myActions, allOppActions, ranked, state, worlds)
        : null;

      const matrix = [];
      for (let i = 0; i < myActions.length; i++) {
        const row = rawMatrix[i].slice();
        let sum = 0, seen = 0;
        for (let j = 0; j < row.length; j++) {
          if (row[j] !== null) { sum += row[j]; seen++; }
        }
        const mean = seen ? sum / seen : 0;
        // Both deltas are per-ROW, so folding them in here (rather than overwriting a score) lets
        // the mixed solve price the risk-adjusted line without losing the tempo policy nudge.
        const delta = (maskDelta[i] || 0) + (volDelta[i] || 0) + (urgDelta[i] || 0) + (swDelta[i] || 0);
        for (let j = 0; j < row.length; j++) row[j] = (row[j] === null ? mean : row[j]) + delta;
        matrix.push(row);
      }

      const live = [];
      const liveIdx = [];
      for (let i = 0; i < ranked.length; i++) {
        if (!ranked[i].isVetoed) { live.push(ranked[i]); liveIdx.push(i); }
      }

      // ---- mixed-strategy solve over the LIVE submatrix only ----
      // A vetoed line must not absorb equilibrium frequency, so it is excluded from the solve
      // rather than being given a zero payoff.
      let nash = null;
      let oppMix = null;
      /* The two opponent-model tiers, each resolved ONCE for this turn: the perceived matrix the
       * OPPONENT solves against (surpriseMask) and the behavioral prior their responses are
       * anchored to (nash.priorAnchored). Both stay null on the shipped build, and a null on both
       * passes no `opts` at all — so the shipped solve is the same call it always was. */
      let surprise = null;
      let priorPlan = null;
      let priorWeight = 0;
      const nashOn = !this.nash || this.nash.enabled !== false;
      /* The QRE tier, resolved ONCE for this turn: 0 means "the shipped hard response", which is
       * what `nash.enabled: false` and every rating at or above `qre.highRating` resolve to. */
      const qreTau = this._qreTau(state);
      const priorCfg = this.nash && this.nash.priorAnchored;
      if (nashOn && live.length > 1 && allOppActions.length > 0) {
        const sub = [];
        for (let k = 0; k < liveIdx.length; k++) sub.push(matrix[liveIdx[k]].slice());
        surprise = this._surprisePerceived(sub, liveIdx, myActions, state);
        priorPlan = this._opponentPrior(allOppActions, state, worlds);
        priorWeight = (priorPlan && priorCfg && priorCfg.enabled === true &&
          typeof priorCfg.priorWeight === 'number' && isFinite(priorCfg.priorWeight))
          ? Math.max(0, Math.min(1, priorCfg.priorWeight)) : 0;
        if (!(priorPlan && priorWeight > 0)) priorPlan = null;
        /* The exploit blend's weight for this turn, clamped like every other config read. It is
         * passed through with `laplace.temperature`, the engine's own confidence temperature, so
         * the exploitation term is priced on the same scale as the legacy softmax path. */
        const exploitWeight = (this.nash && typeof this.nash.exploitBlend === 'number' &&
          isFinite(this.nash.exploitBlend)) ? Math.max(0, Math.min(1, this.nash.exploitBlend)) : 0;
        const solveOpts = (surprise || priorPlan || exploitWeight > 0)
          ? {
              perceived: surprise ? surprise.perceived : null,
              prior: priorPlan, priorWeight: priorWeight,
              exploitBlend: exploitWeight, exploitTemperature: this.temperature
            }
          : null;
        nash = solveNashFictitiousPlay(sub, (this.nash && this.nash.iterations) || NASH_ITERATIONS,
          qreTau > 0 ? { tau: qreTau } : null, solveOpts);
        if (!nash || nash.myStrategy.length !== live.length) {
          nash = null;
          surprise = null;
          priorPlan = null;
        }
      }

      if (nash) {
        for (let k = 0; k < live.length; k++) {
          live[k].confidence = 100 * nash.myStrategy[k];
          /* `nashFrequency` stays the EQUILIBRIUM frequency. With `exploitBlend` above 0 the two
           * differ by construction — confidence carries the exploitation term — and a caller
           * asking what the *unexploitable* mix said has to be able to read it; at the shipped 0
           * they are the same number, so the historical contract holds exactly. */
          live[k].nashFrequency = nash.equilibriumStrategy ? nash.equilibriumStrategy[k] : nash.myStrategy[k];
          if (nash.exploitBlend > 0) live[k].exploitFrequency = nash.myStrategy[k];
          live[k].score = nash.rowValues[k];
        }
        for (let i = 0; i < ranked.length; i++) {
          if (ranked[i].isVetoed) ranked[i].confidence = 0;
        }
        // Publish the solved opponent mix column by column. Nothing inside the engine reads it on
        // THIS turn; the observation feed does, next turn, to ask the question the profiler tier
        // exists to score — what did the matrix expect them to do, and what did they actually do.
        /* Mark the rows the opponent's half of the solve could not see. `live[k]` is the row
         * OBJECT for sub row k, so this survives the re-sort below; an index into `ranked` would
         * not. */
        if (surprise) {
          for (let s = 0; s < surprise.rows.length; s++) {
            const row = live[surprise.rows[s]];
            if (row) {
              row.surpriseMasked = true;
              row.surpriseAnchor = surprise.anchorName;
            }
          }
        }
        oppMix = [];
        for (let j = 0; j < allOppActions.length; j++) {
          oppMix.push({ name: allOppActions[j].name, kind: allOppActions[j].kind, freq: nash.oppStrategy[j] });
        }
      } else {
        this._softmaxConfidence(ranked, live, opts.temperature);
      }

      ranked.sort(function (a, b) {
        if (a.isVetoed !== b.isVetoed) return a.isVetoed ? 1 : -1;
        // Nash frequencies tie often (a mixed equilibrium gives every supported line the same
        // EV), so the tie is broken by payoff and then by name for determinism.
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
        return String(a.name) < String(b.name) ? -1 : 1;
      });
      /* A PROVEN MATE OUTRANKS A FREQUENCY (laplace.endgame.promoteMate). Until this existed the
       * endgame tier was a pure readout — `_tiers` published it and nothing in the ranking path
       * read it — so enabling the solver could not change the line the engine plays (ATTEMPTS.md
       * M1: `identical`, at +31 % wall clock). A report that says `solved && isMate` is a PROOF
       * (the search refuses mates through a Speed chance node, and `solveAcrossWorlds` requires
       * every surviving world to prove the same root), so its root takes the top line. */
      let matePromotion = null;
      const mateReport = tiers.endgame;
      if (mateReport && mateReport.solved === true && mateReport.isMate === true &&
        cfgGet('laplace.endgame.promoteMate', true)) {
        matePromotion = this._promoteMate(ranked, mateReport);
      }
      if (ranked.length && !ranked[0].isVetoed) {
        ranked[0].isOptimal = true;
        ranked[0].damageHint = this._damageHint(ranked[0], state);
      }

      const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
      this._lastOppMix = oppMix;
      this.lastReadout = {
        worlds: worlds,
        tempo: tempoVector,
        clock: this.lastOppPrior || { label: 'unknown', factor: 1, keepSwitchReplies: true },
        profile: tiers.profile,
        scouting: tiers.scouting,
        wincon: tiers.wincon,
        endgame: tiers.endgame,
        beam2Ply: beamPlan,
        // Published so a measurement can tell a QRE turn from a hard one without re-reading config
        // (and so the ablation row can be checked against what actually ran).
        qre: qreTau > 0 ? { tau: U.round1(qreTau) } : null,
        /* Published so a measurement can tell which opponent model actually ran, without
         * re-reading config — the ablation rows `surprise-mask` and `nash-prior` check these. */
        surpriseMask: surprise
          ? { weight: surprise.weight, blend: surprise.blend, rows: surprise.names.slice(),
              anchor: surprise.anchorName }
          : null,
        nashPrior: priorPlan
          ? { weight: priorWeight,
              mix: allOppActions.map(function (action, j) {
                return { name: action.name, kind: action.kind, prior: U.round1(priorPlan[j] * 1000) / 1000 };
              }) }
          : null,
        oppStrategy: oppMix,
        /* Both new overrides publish themselves so a measurement can tell a turn that USED them
         * from one that merely had them enabled. */
        exploitBlend: (nash && nash.exploitBlend > 0)
          ? { weight: U.round1(nash.exploitBlend * 100) / 100, temperature: this.temperature }
          : null,
        matePromotion: matePromotion,
        ranked: ranked,
        myActions: myActions,
        elapsedMs: U.round1(elapsed),
        optimal: ranked.length && !ranked[0].isVetoed ? ranked[0] : null,
        tooltip: this.describeTopLines(ranked, 2)
      };
      return ranked;
    }

    /**
     * Legacy confidence path (laplace.nash.enabled === false): a numerically stable softmax over
     * the live scores. Every live score is shifted by the best one before the exponential.
     * Scores legitimately reach ~1400 (lethal bonus 260 + the evaluator's +-1000 bound), so
     * exp(score / T) overflows to Infinity for any T below ~1.7 and the ratio Infinity / Infinity
     * came out as NaN for every line (and NaN in the sort comparator). The shift cannot change
     * the relative weights — exp((s - max) / T) / sum == exp(s / T) / sum — it only keeps the
     * numerator in a representable range.
     */
    _softmaxConfidence(ranked, live, temperature) {
      let T = typeof temperature === 'number' ? temperature : this.temperature;
      if (!(T > 0)) T = this.temperature > 0 ? this.temperature : 1;
      let maxScore = -Infinity;
      for (let i = 0; i < live.length; i++) {
        if (live[i].score > maxScore) maxScore = live[i].score;
      }
      let denom = 0;
      for (let i = 0; i < live.length; i++) {
        live[i]._exp = Math.exp((live[i].score - maxScore) / T);
        denom += live[i]._exp;
      }
      for (let i = 0; i < live.length; i++) {
        const row = live[i];
        row.confidence = denom > 0 ? 100 * (row._exp / denom) : (100 / Math.max(1, ranked.length));
        delete row._exp;
      }
      for (let i = 0; i < ranked.length; i++) {
        if (ranked[i].isVetoed) ranked[i].confidence = 0;
      }
    }

    /**
     * _promoteMate(ranked, report) -> { name, mateIn, worlds } | null
     *
     * Put the line the solver PROVED at the top of the ranking, and zero every other row.
     *
     * The gate is deliberately narrow, because this is the one place the engine lets a search
     * override the equilibrium instead of re-pricing it: the report must already say `solved &&
     * isMate` (a proof — the solver never claims a mate through a Speed chance node, and with
     * `laplace.endgame.multiWorld` on, `solveAcrossWorlds` needs EVERY surviving sampled world to
     * prove one with the SAME root), the root action must still be one of our ranked, NOT-vetoed
     * actions, and `laplace.endgame.promoteMate` must be on. A forced win is not a 62 %-of-the-time
     * suggestion: the promoted row takes confidence 100, the rest drop to 0 (so the published mix
     * still sums to 100 and no HUD or LLM reader has to know the override happened), and the row is
     * stamped `mateProven` / `mateIn` / `mateReason` so it is visible rather than silent.
     *
     * Returns null — promotion is SKIPPED, never approximated — when any condition fails, which
     * includes the ordinary case of a root the veto layer has already removed.
     */
    _promoteMate(ranked, report) {
      if (!Array.isArray(ranked) || !ranked.length) return null;
      if (!report || !report.line || !report.line.length) return null;
      const root = report.line[0] || {};
      const wanted = U.toID(root.moveId || root.name || '');
      if (!wanted) return null;
      let at = -1;
      for (let i = 0; i < ranked.length; i++) {
        const row = ranked[i];
        if (!row || row.isVetoed) continue;
        const ids = [U.toID(row.moveId || ''), U.toID(row.name || '')];
        if (row.targetId) ids.push(U.toID(row.targetId));
        if (ids.indexOf(wanted) !== -1) { at = i; break; }
      }
      if (at < 0) return null;
      const row = ranked.splice(at, 1)[0];
      for (let i = 0; i < ranked.length; i++) ranked[i].confidence = 0;
      row.confidence = 100;
      row.isOptimal = true;
      row.mateProven = true;
      row.mateIn = report.mateIn;
      row.mateReason = 'a forced win in ' + report.mateIn + ' turn' + (report.mateIn === 1 ? '' : 's') +
        (report.worlds ? ', proved in every one of the ' + report.worlds + ' sampled worlds' : '');
      ranked.unshift(row);
      return { name: row.name, mateIn: report.mateIn, worlds: report.worlds || null };
    }

    _actionKey(action) {
      return (action.kind || 'move') + ':' + U.toID(action.moveId || action.targetId || action.name || '');
    }

    _damageHint(action, state) {
      const my = state.active && state.active.my;
      const opp = state.active && state.active.opp;
      if (!action || action.kind !== 'move' || !my || !opp || !this.damage) return null;
      const res = this._damageOf(my, opp, action.name, state.field || {}, true);
      if (!res) return null;
      return U.round1(res.minPercent) + '-' + U.round1(res.maxPercent) + '% on ' + (opp.species || opp.id) +
        (res.isOHKO ? ' (OHKO)' : res.is2HKO ? ' (2HKO)' : '');
    }

    /** Compact two-line summary for the HUD banner / LLM prompt. */
    describeTopLines(ranked, count) {
      const out = [];
      for (let i = 0; i < ranked.length && out.length < (count || 2); i++) {
        const row = ranked[i];
        if (row.isVetoed) continue;
        out.push(row.name + ' (' + Math.round(row.confidence) + '%)' + (row.damageHint ? ' ' + row.damageHint : ''));
      }
      return out;
    }
  }

  LaplaceEngine.VETO_SCORE = VETO_SCORE;
  // Exported so the mixed-strategy solver can be unit-tested against matrices with a known
  // equilibrium, independently of the battle pipeline.
  LaplaceEngine.solveNashFictitiousPlay = solveNashFictitiousPlay;
  LaplaceEngine.NASH_ITERATIONS = NASH_ITERATIONS;

  ST.LaplaceEngine = LaplaceEngine;
})();
