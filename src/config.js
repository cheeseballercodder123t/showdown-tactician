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
    // The master solver: how many worlds to sample, how sharp the final softmax is, and how
    // the per-world payoffs are pooled before voting.
    laplace: {
      K: 6,                                   // sampled worlds per decision
      temperature: 35,                        // softmax temperature (higher = flatter)
      worldBlend: { avg: 0.6, min: 0.4 },     // payoff pooling across worlds
      maxOppActions: 9,                       // opponent replies enumerated per world
      vetoScore: -9999,                       // score forced onto a vetoed line
      lethalBonus: 260,                       // payoff for taking the last opposing body
      maxSwitchFallback: 5,                   // bench switches synthesised without a |request|
      struggleChipPercent: 5,                 // stand-in damage when the opponent can only Struggle
      switchAteHitBonus: 25                   // payoff when their switch ate our move for free
    },

    /* ---------------------------------------------------------------- sampler */
    sampler: {
      K: 6,
      maxTeam: 6,
      maxResample: 24,                        // bounded retry when a set violates an observation
      minSetWeight: 0.01                      // floor so a zero-weight set can still be drawn
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

    /* -------------------------------------------------------------------- veto */
    // The deterministic blunder layer. A veto is not a preference: it zeroes the line.
    veto: {
      codes: {
        VETO1: 'PROTECT_RHYTHM',
        VETO2: 'ABILITY_IMMUNITY',
        VETO3: 'LONE_TR_SETTER',
        VETO4: 'SPEED_SUICIDE'
      },
      protectRhythmThreshold: 0.75,   // v4 above which attacking into the bunker is a blunder
      loneTRSetterThreat: 70,         // incoming % above which sacking the last setter is a blunder
      maxLog: 40                      // veto history kept for the HUD
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
      bannerSep: '  ·  '
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
      speedFloorFallbackKeep: 4       // fastest candidates kept when NO set can reach the floor
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
