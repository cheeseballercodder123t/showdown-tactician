/* Showdown Tactician — src/config.js
 * RULE 4: the ONE place any tunable number in the decision engine lives.
 *
 * Every heuristic weight, threshold, probability, timeout and model id in the engine is a
 * property of `ST.CONFIG`. No scoring number is scattered through the modules: a reader who
 * wants to know "why does it value a freeze more than a burn?" or "how cautious is it about
 * Protect?" reads this file and nowhere else.
 *
 * Contract for consumers:
 *   const value = ST.configGet('tempo.rhythmHurt', 0.85);
 * `configGet` walks the dotted path and returns the supplied fallback ONLY when config.js
 * itself was never loaded (a defensive path for stripped builds and unit harnesses). When
 * config.js is present — as it always is in the manifest, which loads it first — the value in
 * this file wins, so editing here is sufficient to change behaviour. tests/config_check.js
 * proves that mutation flows through, and that the 128D weight layout this file generates is
 * bit-identical to the vector the evaluator shipped with.
 *
 * Categories that do NOT belong here:
 *   - anything the battle library owns (damage, type charts, base stats, move data),
 *   - game rules with a single correct value (Trick Room lasts 5 turns, EQ has 100 BP),
 *   - layout constants that are part of the 128D/10D interface itself (dim indices).
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  if (ST.CONFIG) return;

  const CONFIG = {
    version: '1.0.0',

    /* ---------------------------------------------------------------- laplace */
    // The master solver: how many worlds to sample, how the simultaneous matrix is solved
    // (mixed Nash by fictitious play), and how the per-world payoffs are pooled before voting.
    laplace: {
      K: 6,                                   // sampled worlds per decision
      temperature: 35,                        // softmax temperature (higher = flatter)
      worldBlend: { avg: 0.6, min: 0.4 },     // payoff pooling across worlds
      maxOppActions: 9,                       // opponent replies enumerated per world
      vetoScore: -9999,                       // score forced onto a vetoed line
      lethalBonus: 260,                       // payoff for taking the last opposing body
      maxSwitchFallback: 5,                   // bench switches synthesised without a |request|
      struggleChipPercent: 5,                 // stand-in damage when the opponent can only Struggle
      switchAteHitBonus: 25,                  // payoff when their switch ate our move for free
      // Risk-adjusted volatility (the "tilt penalty"). A 70%-accuracy move is NOT worth 0.7 of
      // its damage when missing it hands the opponent the game: the downside of a miss is
      // asymmetric with the upside of a hit. So each of OUR rows is re-priced as
      //     upside  = score * (accuracyWeight * acc + (1 - accuracyWeight))
      //     charge  = (1 - acc) * incomingThreatPercent * fragilityScale * (lethal ? lethalMultiplier : 1)
      //     final   = upside - charge
      // where `acc` is the library's own accuracy for the move (1 for a move that cannot miss)
      // and `incomingThreatPercent` is the library's best-move damage into our active mon, both
      // MEASURED, never assumed. `enabled: false` restores the raw payoff exactly, the same way
      // nash.enabled does.
      volatility: {
        enabled: true,
        // Fraction of the payoff that is scaled by the move's accuracy. 1 = fully risk-adjusted
        // (a 70% move keeps 70% of its upside); 0 = accuracy ignored (the old behaviour).
        accuracyWeight: 1.0,
        // The fragility charge: (1 - accuracy) * incomingThreatPercent * fragilityScale, added
        // as a NEGATIVE row delta. It is measured from the library, never assumed.
        fragilityScale: 2.4,
        // Extra multiple on that charge when the incoming threat is LETHAL to the active mon
        // (a miss there does not cost a turn, it ends the mon).
        lethalMultiplier: 3.0,
        // Moves at or above this accuracy are treated as risk-free (no charge at all).
        accuracyFloor: 100,
        // Only moves at or below this accuracy can be charged the lethal multiplier, so a stray
        // 95% "never miss in practice" move cannot be branded a game-ender.
        lethalChargeMaxAccuracy: 90
      },
      // Mixed-strategy solver: fictitious play over the simultaneous payoff matrix. With it on,
      // `confidence` is the equilibrium FREQUENCY of the line (how often to click it), which
      // cannot be exploited by a patient opponent the way a single always-printed line can.
      // `laplace.temperature` then only governs the legacy softmax path below.
      nash: {
        enabled: true,
        // Best-response rounds. Fictitious play's AVERAGE converges at O(1/sqrt(T)) with a
        // real oscillation, so this is not a place to be stingy: measured against analytic
        // 2x2 equilibria the worst frequency error is 0.06 at 50 rounds, 0.025 at 240 and
        // 0.006 at 2000, while a realistic 5x9 solve still costs ~0.22 ms at 2000 rounds
        // (vs ~0.035 ms at 240) — noise next to the damage engine. See tests/upgrades_check.js.
        iterations: 2000
      }
    },

    /* ---------------------------------------------------------------- sampler */
    sampler: {
      K: 6,
      maxTeam: 6,
      maxResample: 24,                        // bounded retry when a set violates an observation
      minSetWeight: 0.01                      // floor so a zero-weight set can still be drawn
    },

    /* ------------------------------------------------------------------ usage */
    // The optional ladder-usage overlay (src/sets_usage.js, regenerated by tools/sync_chaos_sets.js
    // from a monthly Smogon chaos dump). It never invents a set: it only re-weights the sets the
    // curated database already holds, by how often that species actually holds that item. The
    // file ships EMPTY, so with no overlay every weight below is exactly what it was.
    usage: {
      enabled: true,
      floor: 0.05                     // least-popular supported item still draws at 5% of its weight
    },

    /* -------------------------------------------------------------- evaluator */
    // The 128D leaf evaluator. `weights` is the human-readable spec; the exact index layout is
    // documented in evaluator_128d.js and built by DenseStateEvaluator.defaultWeights().
    evaluator: {
      dim: 128,
      team: 6,
      // Squashing and normalisers: the linear score is tanh-squashed into [-scale, scale].
      scale: 1000,
      tanhDenominator: 420,
      unknownHpDefault: 0.6,          // assumed HP fraction for a mon we have never seen
      threatEffSpan: 3,               // type effectiveness span mapped onto [0, 1]
      offenseBasePowerCap: 120,       // best-move normaliser (a strong STAB hit == 1.0)
      boostSumScale: 18,              // +/-3 in every stat == 1.0
      statusDifferentialDivisor: 4,
      speedEdgeSpan: 400,             // Speed points mapped onto [-1, 1]
      recoveryPPBudget: 8,            // Recover/Soft-Boiled/Roost PP from full
      hazardChip: {                   // mirror of tempo.chip, used only for the differential
        rocks: 12.5,
        spikesPerLayer: 8.3,
        toxicSpikes: 12.5,
        stickyWeb: 8,
        divisor: 37.5
      },
      protectRhythm: {                // macro dims 126/127
        protectedLastTurn: 0.5,
        consecutiveProtects: 0.5
      },
      weights: {
        // 0..23 — HP and fainting dominate every evaluation.
        hp: 26,
        fainted: 55,
        // 24..35 — status is chip damage; toxic scales with time, paralysis is tempo.
        //   hp/atk/def/spa/spd/spe then the same six for the opponent.
        status: [-9, -16, -11, -8, 9, 16, 11, 8, -14, -22, -18, -12],
        // 36..47 — boosts on the active mons (ours, then theirs).
        boosts: [18, 12, 18, 12, 24, 10, -18, -12, -18, -12, -24, -10],
        // 48..55 — our hazards hurt them, theirs hurt us.
        hazards: [-7, -10, -12, -9, 7, 10, 12, 9],
        // 56..63 — Trick Room is only good when we are the slower team.
        trickRoom: [14, 22, 4, 3, 4, 4, 4, 4],
        // 64..75 — item knowledge is informational, not terminal.
        items: [5, -4, -6, 2, 6, 9, -5, 4, 6, -2, -6, -9],
        // 76..111 — threat matrix against each defender, stronger for the active pair.
        threat: 6,
        threatActive: 16,
        // 112..127 — macro aggregates.
        macro: [30, -30, 18, -18, 9, -9, 12, -12, 10, -10, 6, -6, 8, -8, 7, -7]
      }
    },

    /* ------------------------------------------------------------------- tempo */
    // Tier 2: the Protect/Bunker stall rhythm and the policy mask built on it.
    tempo: {
      protectFresh: 0.0,              // consecutive-Protect decay when the chain is broken
      protectAfterOne: 0.67,
      protectAfterTwo: 0.89,
      rhythmNone: 0.08,               // protected last turn: a repeat is rare
      rhythmHurt: 0.85,               // one turn after a Protect below hurtHpBelow
      rhythmDefault: 0.35,
      hurtHpBelow: 70,                // "% HP or less" for the Bunker read
      healthyHpAbove: 85,             // above this, a stale Protect is less likely
      healthyPenalty: 0.12,
      trickRoomBonus: 0.08,           // stalling out TR turns is attractive
      observedProtectBonus: 0.05,
      cannotProtectPenalty: 0.25,     // the move may not even be on the set
      maxProtectProbability: 0.95,
      bulkThreshold: 280,             // hp+def+spd above which an unrevealed mon can Protect
      initiativeScale: 200,           // v2 normalisation
      threatScale: 100,               // v5 normalisation
      safeHpDefault: 60,              // assumed HP when the mon is unknown
      bunkerThreshold: 0.7,           // v4 above which the policy mask engages
      bunkerMaskBonus: 80,            // score added to Protect/setup/slow-pivot lines
      resistThreshold: 0.5,           // v6: a bench mon at or below this resists our best move
      chip: {
        rocks: 12.5,
        spikesPerLayer: 8.3,
        toxicSpikes: 12.5,
        stickyWeb: 8,
        toxBase: 12.5,
        toxicTurnsDivisor: 6,
        burn: 6.25,
        scale: 50                     // divisor normalising net chip into [-1, 1]
      }
    },

    /* ------------------------------------------------------------------- clock */
    // Opponent deliberation telemetry. The server only reveals a turn once BOTH players have
    // submitted, so `turnResolution - mySubmit` is an upper bound on how much longer the
    // opponent took than us; the smallest value seen in the battle is the network/animation
    // noise floor, and everything above it is deliberation. `switchPrior` is the ONLY thing the
    // clock changes about play: `switchPrior` decides whether the opponent's SWITCH replies
    // belong in the simultaneous matrix at all (a body that answers instantly is very unlikely
    // to be pivoting).
    // These factors are PRIORS, not measurements — they are unvalidated heuristics in the same
    // sense as tempo.rhythmHurt, and they are deliberately config-shaped so a replay corpus can
    // fit them later. Mechanically only the LOW end changes the solver today: a factor under
    // switchKeepThreshold removes their switch replies from the reply space entirely, which is
    // the "they are attacking" read. The agonised factor cannot add replies the engine already
    // enumerates, so above the threshold it is telemetry (HUD + clock.meanMs) with no solver
    // effect — stated here rather than pretended otherwise.
    clock: {
      enabled: true,
      fastMs: 1200,                   // <= this much deliberation above the noise floor reads as auto-pilot
      slowMs: 20000,                  // >= this much reads as a genuine 50/50 debate
      minSamples: 2,                  // samples before a label is anything other than 'unknown'
      maxHistory: 20,                 // per-battle decision-time ring buffer
      switchKeepThreshold: 0.5,       // below this prior, their switch replies leave the reply space
      switchPrior: {
        auto: 0.25,                   // they clicked near-instantly: assume the attack, not the pivot
        normal: 1.0,
        agonised: 1.6,                // they burned the timer: a safe pivot gets more likely
        unknown: 1.0
      }
    },

    /* -------------------------------------------------------------- pp stall */
    // The Sucker Punch PP-stall counter. The counter itself needs no threshold: the remaining
    // PP is READ from the page's own battle object (src/injected.js forwards a `|stpp|`
    // snapshot), never assumed, because the max PP of a move is game data the engine may not
    // invent (RULE 1). These knobs only decide when the 3x3 payoff is worth solving and when the
    // setup threat is loud enough to say out loud.
    ppStall: {
      enabled: true,
      // Moves whose PP is worth tracking. The first entry is the one the gauge headlines.
      watch: ['suckerpunch', 'protect', 'substitute'],
      headline: 'suckerpunch',
      // Solve the 3x3 only while the watched move still has at least this share of its PP left;
      // below it the pivot has already won and the matrix is noise.
      minPpFraction: 0.2,
      // Their % HP at or below which a setup-click read is worth printing.
      setupThreatHp: 80,
      // How many turns of patience the advised line assumes (the solver's horizon is 1 ply; the
      // advice string says so explicitly rather than pretending otherwise).
      adviceLabel: 'PP-stall pivot'
    },

    /* ------------------------------------------------------- format sentinel */
    // The Z-Move / Mega Trap sentinel. Every number here is read off state.formatLocks, which the
    // state manager fills from the protocol; this section only names the labels and decides how
    // loud the "both mechanics burned" line is.
    sentinel: {
      enabled: true,
      // "Their remaining bench cannot hold a Mega Stone / Z-Crystal" is only printed when at
      // least this many opposing bodies are still unrevealed-or-unmegaed AND the pool agrees.
      minBodiesForFreedom: 1,
      freedomLabel: 'TACTICAL FREEDOM',
      burnedLabel: 'BURNED',
      liveLabel: 'LIVE'
    },

    /* -------------------------------------------------------------------- veto */
    // The deterministic blunder layer. A veto is not a preference: it zeroes the line.
    veto: {
      codes: {
        VETO1: 'PROTECT_RHYTHM',
        VETO2: 'ABILITY_IMMUNITY',
        VETO3: 'LONE_TR_SETTER',
        VETO4: 'SPEED_SUICIDE',
        VETO5: 'CONTACT_SUICIDE',
        VETO6: 'SUCKER_PUNCH_SETUP',
        VETO7: 'TR_SELF_CANCEL',
        VETO8: 'WASTED_HAZARD_CLEAR',
        VETO9: 'CONSECUTIVE_PROTECT',
        VETO10: 'MAGIC_BOUNCE_REDIRECT',
        VETO11: 'SATURATED_HAZARD',
        VETO12: 'REDUNDANT_FIELD'
      },
      protectRhythmThreshold: 0.75,   // v4 above which attacking into the bunker is a blunder
      loneTRSetterThreat: 70,         // incoming % above which sacking the last setter is a blunder
      contactPunishHp: 29,            // hard ceiling: never refuse contact above this % HP
      suckerPunchSetupHp: 80,         // their % HP above which a setup/recovery click is likely
      maxLog: 40,                     // veto history kept for the HUD
      // The five board-state vetoes. Each one is off-able on its own, because they are policy
      // (what this trainer refuses to click) rather than deductions about the opponent.
      wastedHazardClear: true,        // Defog/Rapid Spin with nothing on our side to clear
      consecutiveProtect: true,       // the Protect counter cannot succeed twice in a row
      magicBounceRedirect: true,      // a hazard into Magic Bounce lands on our side instead
      saturatedHazard: true,          // a hazard past its layer cap sets nothing
      redundantField: true,           // re-setting the weather that is already up
      // Only a re-set with MORE than this many turns left is redundant: at 1 turn the refresh is
      // the correct line, which is the whole reason the threshold exists.
      redundantFieldMinTurns: 2
    },

    /* --------------------------------------------------------------- trickRoom */
    trickRoom: {
      turns: 5,
      speedRankBase: 10000,           // rank = base - speed under TR, so the slowest wins
      alertFinal: '⚠️ TR EXPIRING NEXT TURN: Attack or sack setter; DO NOT hard-switch healthy breakers!',
      alertTwoLeft: 'TR: 2 turns left — land your chip now; the last turn is for the sack.',
      maxHistory: 40
    },

    /* --------------------------------------------------------------------- hud */
    hud: {
      high: 50,                       // confidence % at or above which the badge is green
      mid: 25,                        // ... gold at or above this, slate below
      low: 0,
      confidenceLabels: { high: 'HIGH', mid: 'MID', low: 'LOW', veto: 'VETO' },
      bannerSep: '  ·  ',
      // Lethal-roll gauge bands (KO probability %, from the library's own koChance): at or
      // above `guaranteed` the bar is green, at or above `high` gold, at or above `mid` slate.
      lethal: { guaranteed: 100, high: 67, mid: 34 },
      // Haptics on Android. The pattern is the brief's own ([40, 60, 40] ms on/off/on) and is
      // fired once per battle, on the turn Trick Room drops to its last turn.
      vibrate: { enabled: true, pattern: [40, 60, 40], trLastTurn: true },
      benchStripMax: 6,               // pills rendered in the bench-tap strip
      // The PP-stall gauge and the format sentinel bar (the two "sweaty" HUD readouts).
      ppGauge: { label: 'PP' },
      sentinelBar: { maxTactics: 3 },
      // Supreme Overlord readout: the multiplier is MEASURED from the library (the same move
      // against the same probe defender, with `alliesFainted` = fallen vs 0), never modelled,
      // because RULE 1 forbids writing the ability's own rule down here.
      overlord: { probeMove: 'Kowtow Cleave', probeDefender: 'Great Tusk' },
      receipt: { maxDamageRows: 5, copyLabel: 'Copy Summary' }
    },

    /* --------------------------------------------------------------------- llm */
    llm: {
      timeoutMs: 600,                 // hard AbortController budget
      geminiModel: 'gemini-3.5-flash-lite',
      openrouterModel: 'google/gemini-2.0-flash-lite-001',
      geminiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/',
      openrouterEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
      maxPromptWords: 150,
      maxReasonWords: 15,
      systemPrompt: 'You are an elite Pokemon Showdown grandmaster. Never calculate math. ' +
        'Rely strictly on the provided damage ranges. Output strictly valid JSON: ' +
        '{"action": "Move", "confidence": 85, "reason": "Max 15 words."}'
    },

    /* ------------------------------------------------------------------ pruner */
    pruner: {
      maxReasons: 24,                 // human-readable deduction trail kept per mon
      maxEvidence: 12,
      speedMaxCeiling: 1012,          // Regieleki @ Choice Scarf, L100, +Spe, 252 EV
      speedFloorFallbackKeep: 4,      // fastest candidates kept when NO set can reach the floor
      // Reverse damage deduction: an observed hit on OUR mon is run back through every
      // candidate spread of the mon that threw it, and a set whose damage range cannot cover
      // the observed percentage is dropped. The tolerances are the whole safety story — a
      // critical hit, an unknown stat boost, a screen we failed to model or Showdown's own
      // integer HP rounding all land inside `slackPct` / `slackRel` instead of eliminating a
      // set that is really correct.
      damageEvidence: {
        enabled: true,
        slackPct: 3,                  // absolute percentage points of slack on each bound
        slackRel: 0.15,               // plus this fraction of the computed bound
        minDamagePct: 5,              // ignore chip below this: rounding noise, not evidence
        maxObservations: 8,           // bounded per-mon evidence log
        maxSetsTested: 64             // cap on sets probed per observation (keeps a turn cheap)
      },
      // The DISCRETE half of reverse damage. Pokemon damage is not a continuous interval: it is
      // one of 16 integer rolls. When the protocol prints an exact percentage, only the sets
      // whose own 16 rolls can round to that integer percentage are still possible — which is
      // how an exact EV spread gets pinned instead of guessed. The check is a REFINEMENT only:
      // it can never empty a pool (the fallback keeps the pool and logs a reason), and
      // `slackPct` widens the accepted integer window on each side.
      discreteRolls: {
        enabled: true,
        slackPct: 0.05,               // +/- this many percentage points around the observed value
        // Observations needed before a pool collapse is allowed to report an EV pin. A single
        // hit can match several spreads by coincidence; two independent ones rarely do.
        requireObservations: 2
        // No separate probe cap: the discrete test runs on the SAME cached calculation as the
        // range check above it, so it is bounded by pruner.damageEvidence.maxSetsTested.
      },
      // Residual-order speed telemetry. End-of-turn residual damage/heal resolves in Speed
      // order, so the FIRST of two bodies printed in one residual block is the faster. That is
      // a relative order, not a number, so it is applied against the other body's believed speed
      // and every application is allowed to fail soft (see pruner.applyResidualOrder).
      residualOrder: {
        enabled: true,
        // How much of the observed order to trust when it needs a believed speed to become a
        // floor. 1 = use the other body's speed exactly; 0 = record the order and do nothing.
        trust: 1.0
      },
      // The optional scouting prior (src/scout_prior.js, regenerated by tools/scout_replays.js
      // from the opponent's own recent replays). Like the ladder overlay it only ever re-weights
      // sets the curated database already holds; it can never add one. `maxBend` is how far a
      // fully-observed item/move can move a candidate's weight, as a fraction (0.5 = +50%).
      scout: {
        enabled: true,
        maxBend: 0.5
      }
    },

    /* ------------------------------------------------------------------- state */
    state: {
      maxActiveStints: 8,             // moves remembered per stint for the choice-lock rule
      maxLog: 200
    }
  };

  /** Walk a dotted path. Returns `fallback` only when the path (or the config) is missing. */
  function configGet(path, fallback) {
    if (!path) return fallback;
    const parts = String(path).split('.');
    let node = CONFIG;
    for (let i = 0; i < parts.length; i++) {
      if (node === null || node === undefined || typeof node !== 'object') return fallback;
      node = node[parts[i]];
    }
    return node === undefined ? fallback : node;
  }

  /** Deep clone of the config — used by tests and by a debug HUD. */
  function configSnapshot() { return JSON.parse(JSON.stringify(CONFIG)); }

  /** Replace tunables at runtime (tests, power users). Shallow-merged section by section. */
  function configMerge(patch) {
    if (!patch || typeof patch !== 'object') return CONFIG;
    Object.keys(patch).forEach(function (section) {
      const incoming = patch[section];
      if (incoming && typeof incoming === 'object' && !Array.isArray(incoming) &&
          CONFIG[section] && typeof CONFIG[section] === 'object' && !Array.isArray(CONFIG[section])) {
        Object.keys(incoming).forEach(function (k) { CONFIG[section][k] = incoming[k]; });
      } else {
        CONFIG[section] = incoming;
      }
    });
    return CONFIG;
  }

  ST.CONFIG = CONFIG;
  ST.configGet = configGet;
  ST.configSnapshot = configSnapshot;
  ST.configMerge = configMerge;
})();
