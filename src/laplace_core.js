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
   * -> { myStrategy, oppStrategy, rowValues } with probabilities in [0, 1].
   */
  function solveNashFictitiousPlay(payoffMatrix, iterations) {
    const rows = Array.isArray(payoffMatrix) ? payoffMatrix.length : 0;
    const cols = rows && Array.isArray(payoffMatrix[0]) ? payoffMatrix[0].length : 0;
    if (!rows || !cols) return { myStrategy: [], oppStrategy: [], rowValues: [] };
    const iters = Math.max(1, Math.floor(iterations) || 1);
    const myCount = new Array(rows).fill(0);
    const oppCount = new Array(cols).fill(0);
    const myCum = new Array(rows).fill(0);
    const oppCum = new Array(cols).fill(0);
    let myAction = 0;
    let oppAction = 0;
    for (let t = 0; t < iters; t++) {
      myCount[myAction]++;
      oppCount[oppAction]++;
      for (let i = 0; i < rows; i++) myCum[i] += payoffMatrix[i][oppAction];
      for (let j = 0; j < cols; j++) oppCum[j] -= payoffMatrix[myAction][j];
      let bestI = 0;
      for (let i = 1; i < rows; i++) if (myCum[i] > myCum[bestI]) bestI = i;
      let bestJ = 0;
      for (let j = 1; j < cols; j++) if (oppCum[j] > oppCum[bestJ]) bestJ = j;
      myAction = bestI;
      oppAction = bestJ;
    }
    const myStrategy = myCount.map(function (c) { return c / iters; });
    const oppStrategy = oppCount.map(function (c) { return c / iters; });
    // Expected payoff of each of our actions against THEIR equilibrium mix — the number that
    // says what a line is worth when the opponent also plays unexploitably.
    const rowValues = [];
    for (let i = 0; i < rows; i++) {
      let ev = 0;
      for (let j = 0; j < cols; j++) ev += oppStrategy[j] * payoffMatrix[i][j];
      rowValues.push(ev);
    }
    return { myStrategy: myStrategy, oppStrategy: oppStrategy, rowValues: rowValues };
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
      // Mixed-strategy solve (same precedence as every other tunable). `enabled: false` restores
      // the pure risk blend + softmax behaviour exactly.
      this.nash = Object.assign({
        enabled: cfgGet('laplace.nash.enabled', true),
        iterations: cfgGet('laplace.nash.iterations', NASH_ITERATIONS)
      }, options.nash || {});
      // Risk-adjusted volatility (ARCHITECTURE §6.5). `enabled: false` restores the raw payoff.
      this.volatility = Object.assign({
        enabled: cfgGet('laplace.volatility.enabled', true),
        accuracyWeight: cfgGet('laplace.volatility.accuracyWeight', 1),
        fragilityScale: cfgGet('laplace.volatility.fragilityScale', 2.4),
        lethalMultiplier: cfgGet('laplace.volatility.lethalMultiplier', 3),
        accuracyFloor: cfgGet('laplace.volatility.accuracyFloor', 100),
        lethalChargeMaxAccuracy: cfgGet('laplace.volatility.lethalChargeMaxAccuracy', 90)
      }, options.volatility || {});
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
        const fallback = active && ((active.setMoves && active.setMoves.length && active.setMoves) ||
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
      if (!switches.length) {
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
      const penalty = -(upsideLost + charge);
      if (!penalty) return none;
      let why = (data.name || action.name) + ' lands ' + accuracy + '% of the time: ' +
        U.round1(upsideLost) + ' of upside given up';
      if (charge) {
        why += ' + ' + U.round1(charge) + ' fragility';
        if (chargedLethal) why += ' (a miss hands ' + U.round1(threat) + '% from ' + threatBy + ', which is lethal)';
      }
      return { penalty: penalty, why: why };
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
              try { value = this._payoff(rows[i].action, cols[j].action, state, state.field || {}); }
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

    _mutableSim(state, myActive, oppActive, myHp, oppHp, result) {
      const sim = Object.create(state);
      sim.active = { my: myActive, opp: oppActive };
      sim._sim = {
        myHp: myHp, oppHp: oppHp,
        myFaints: result.myFaints, oppFaints: result.oppFaints
      };
      return sim;
    }

    _damageOf(attacker, defender, moveName, field, outgoing) {
      if (!this.damage || !moveName) return null;
      try {
        const res = this.damage.calculateDamage(attacker, defender, moveName, field);
        if (!res || res.failed) return null;
        return { move: moveName, minPercent: res.minPercent || 0, maxPercent: res.maxPercent || 0, avgPercent: res.avgPercent || 0, isOHKO: !!res.isOHKO, is2HKO: !!res.is2HKO };
      } catch (e) { return null; }
    }

    _bestMove(mon, target, field) {
      const moves = (mon && mon.setMoves) || (mon && mon.liveSet && mon.liveSet.moves) || (mon && mon.revealedMoves) || [];
      let best = null, bestDmg = -1;
      for (let i = 0; i < moves.length; i++) {
        const res = this._damageOf(mon, target, moves[i], field, false);
        if (res && res.avgPercent > bestDmg) { bestDmg = res.avgPercent; best = moves[i]; }
      }
      return best || 'Struggle';
    }

    _hp(mon) {
      if (!mon) return 100;
      let hp = mon.hpPercent;
      if (hp === null || hp === undefined) hp = mon.hp;
      if (hp === null || hp === undefined || hp !== hp) return 100;
      return hp;
    }

    /* ------------------------------------------------------------- evaluation */

    /** Payoff of (myAction vs oppAction) in a simulated 1-ply state. */
    _payoff(myAction, oppAction, state, field) {
      const myActive = state.active && state.active.my;
      const oppActive = state.active && state.active.opp;
      if (!myActive || !oppActive || !this.evaluator) return 0;
      let myHp = this._hp(myActive);
      let oppHp = this._hp(oppActive);
      let mySideMon = myActive;
      const events = [];

      if (myAction.kind === 'switch') {
        const incoming = this._switchTarget(state, myAction);
        if (incoming) {
          mySideMon = incoming;
          const haz = field.hazards && field.hazards[state.mySide || 'p1'];
          const chip = U.hazardPercent(incoming.species || incoming.id,
            incoming.currentBattleItem || incoming.confirmedItem || '', incoming.revealedAbility || '', haz || {});
          myHp = U.clamp(this._hp(incoming) - chip, 0, 100);
        }
      } else {
        const dmg = this._damageOf(myActive, oppActive, myAction.name, field, true);
        if (dmg) {
          oppHp = U.clamp(oppHp - dmg.avgPercent, 0, 100);
          events.push(dmg);
        }
      }

      if (oppAction.kind === 'switch') {
        // Switched-out opponent survives; the new body is unscratched.
        oppHp = 100;
      } else {
        const dmg = oppAction.name === 'Struggle'
          ? { avgPercent: this.struggleChipPercent, isOHKO: false }
          : this._damageOf(oppActive, mySideMon, oppAction.name, field, false);
        if (dmg) {
          myHp = U.clamp(myHp - dmg.avgPercent, 0, 100);
        }
      }

      const sim = this._leafState(state, mySideMon, oppActive, myHp, oppHp);
      let score = this.evaluator.evaluate(sim);
      // Terminal bonuses keep the leaf evaluator honest about KOs.
      if (oppHp <= 0) score += this.lethalBonus;
      if (myHp <= 0) score -= this.lethalBonus;
      if (oppAction.kind === 'switch' && myAction.kind === 'move') score += this.switchAteHitBonus;   // their switch ate our hit for free
      return score;
    }

    _leafState(state, myMon, oppMon, myHp, oppHp) {
      const leaf = {
        myTeam: null,
        oppTeam: null,
        field: state.field,
        active: { my: null, opp: null },
        bench: state.bench,
        protect: state.protect,
        recoveryPP: state.recoveryPP,
        terastallizationBanned: state.terastallizationBanned,
        mySide: state.mySide,
        oppSide: state.oppSide
      };
      const cloneMon = function (mon, hp) {
        if (!mon) return null;
        const copy = Object.create(mon);
        copy.hp = hp;
        copy.hpPercent = hp;
        copy.fainted = hp <= 0;
        return copy;
      };
      leaf.active.my = cloneMon(myMon, myHp);
      leaf.active.opp = cloneMon(oppMon, oppHp);
      leaf.myTeam = (state.myTeam || []).map(function (m) {
        if (m === (state.active && state.active.my)) return leaf.active.my;
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

      if (this.damage && typeof this.damage.beginTurn === 'function') {
        this.damage.beginTurn(state.turn + ':' + (state.revision || 0));
      }
      if (this.trickRoom && typeof this.trickRoom.tick === 'function') this.trickRoom.tick(state);
      const tempoVector = this.tempo ? this.tempo.computeVector(state) : null;
      if (this.trickRoom && tempoVector) tempoVector.trAdvice = this.trickRoom.advise(state);

      const worlds = this.sampler
        ? this.sampler.sampleWorlds(state, ST.SetDatabase || null, opts.K || this.K)
        : [{ id: 'w0', team: state.oppTeam || [], sets: [], weight: 1, violations: [] }];

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
        for (let i = 0; i < myActions.length; i++) {
          const mine = myActions[i];
          const key = this._actionKey(mine);
          let sum = 0, min = Infinity;
          for (let j = 0; j < oppActions.length; j++) {
            const payoff = this._payoff(mine, oppActions[j], state, state.field || {});
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
      const matrix = [];
      for (let i = 0; i < myActions.length; i++) {
        const row = [];
        let sum = 0, seen = 0;
        for (let j = 0; j < allOppActions.length; j++) {
          const wgt = cellWeight[i][j];
          const value = (typeof cellSum[i][j] === 'number' && wgt > 0) ? cellSum[i][j] / wgt : null;
          row.push(value);
          if (value !== null) { sum += value; seen++; }
        }
        const mean = seen ? sum / seen : 0;
        // Both deltas are per-ROW, so folding them in here (rather than overwriting a score) lets
        // the mixed solve price the risk-adjusted line without losing the tempo policy nudge.
        const delta = (maskDelta[i] || 0) + (volDelta[i] || 0);
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
      const nashOn = !this.nash || this.nash.enabled !== false;
      if (nashOn && live.length > 1 && allOppActions.length > 0) {
        const sub = [];
        for (let k = 0; k < liveIdx.length; k++) sub.push(matrix[liveIdx[k]].slice());
        nash = solveNashFictitiousPlay(sub, (this.nash && this.nash.iterations) || NASH_ITERATIONS);
        if (!nash || nash.myStrategy.length !== live.length) nash = null;
      }

      if (nash) {
        for (let k = 0; k < live.length; k++) {
          live[k].confidence = 100 * nash.myStrategy[k];
          live[k].nashFrequency = nash.myStrategy[k];
          live[k].score = nash.rowValues[k];
        }
        for (let i = 0; i < ranked.length; i++) {
          if (ranked[i].isVetoed) ranked[i].confidence = 0;
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
      if (ranked.length && !ranked[0].isVetoed) {
        ranked[0].isOptimal = true;
        ranked[0].damageHint = this._damageHint(ranked[0], state);
      }

      const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
      this.lastReadout = {
        worlds: worlds,
        tempo: tempoVector,
        clock: this.lastOppPrior || { label: 'unknown', factor: 1, keepSwitchReplies: true },
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
