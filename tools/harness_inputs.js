/* Showdown Tactician — tools/harness_inputs.js
 *
 * WHAT THIS CATCHES, AND WHY IT IS NOT THE SAME CHECK AS `appliedSets`
 *   Every harness already proves the PATCH landed: it reads the flag back out of the config after
 *   merging it, and refuses the run if the value differs. That proves the flag was SET. It does not
 *   prove the INPUT the flag reads was ever SUPPLIED, and those fail identically from the outside:
 *   a flag whose channel is empty returns its inert default for every turn, so the variant and the
 *   baseline come back byte-identical and the report says "this feature does nothing".
 *
 *   Measured instances of that class in this repository, each found BY HAND before this module
 *   existed:
 *     - `clock.ratingBands` could not be priced by `tools/benchmark_human_match.js` at all, because
 *       `buildEngine` never constructed the `OpponentClock` and nothing set `state.clock`, which
 *       `_oppSwitchPrior` reads. Two paired arms were byte-identical over 1,328 decisions.
 *     - `laplace.volatility` and `laplace.comeback` read `state.moveAccuracy`, which is populated
 *       only by a `|stacc|` frame. The ARENA supplies it — `engine_bridge.js` forwards the frame
 *       from the sim dex (ATTEMPTS.md D1, fixed there) — but `tools/benchmark_human_match.js` builds
 *       the engine directly and forwards nothing, so both tiers are unpriceable in THAT harness.
 *       This module now says so instead of leaving it to be rediscovered.
 *     - the same `|stacc|` gap kept `laplace.volatility` flat in the arena until D1 was fixed;
 *       `clock` itself was inert there until the runner sent its own `/choose` frame (ATTEMPTS.md
 *       D2). Both are now supplied, and this module is what keeps them that way.
 *   In every case the honest reading is "unpriceable here", and each was diagnosed by hand. This
 *   module makes the machine say it.
 *
 * HOW IT WORKS
 *   `watch(engine)` wraps the engine's `evaluateTurn`, which every harness reaches either directly
 *   (the benchmark) or through the real pipeline it boots (the arena's `TacticianBoot`). After each
 *   call it asks every channel whether the board it was handed carries that channel's input, and
 *   records the first turn it saw one. The probes are cheap and each channel stops being probed the
 *   moment it has been seen once, so the watched hot path pays at most one extra check per channel
 *   per process.
 *
 *   `assertSupplied(applied, context)` then refuses the run when an applied `--set` path maps to a
 *   channel that was never observed. The failure is a SETUP error, exactly like a short
 *   `appliedSets` echo, because a variant that never received its input is not a measurement of the
 *   flag — and printing it as one is the false null this module exists to prevent.
 *
 * WHICH CHANNELS ARE POLICE-ABLE, AND WHY THE LINE IS DRAWN THERE
 *   Only channels that something OUTSIDE the engine's own `evaluateTurn` has to supply are listed,
 *   and only channels whose absence is unambiguously the HARNESS's fault are enforced: `clockPace`
 *   is measured and reported but no row requires it, because the arena can declare the pace rather
 *   than measure it, so its absence is not evidence of a gap:
 *   a driver-published snapshot (`state.clock`), a client frame (`|stacc|`), the protocol's own
 *   `|player|` rating, or the pipeline stages the boot has to wire (their replies, the switch rows,
 *   the pruner's candidate pool). A value the ENGINE ITSELF computes — the win-condition plan, the
 *   profiler's column factor, the beam gate — is deliberately NOT listed: when those read inert it
 *   is because the tier looked and found nothing, which is its answer, not a missing input, and
 *   refusing on it would punish a legitimate result. `laplace.wincon`, `laplace.profile` and
 *   `laplace.beam2Ply` are therefore classified with no channel to police and a note saying why.
 *
 * WHAT IT DOES NOT DO
 *   It does not claim a supplied input made the flag DECISIVE. A flag whose channel is populated and
 *   still changes nothing is a real (possibly uninteresting) result. Only the never-supplied case is
 *   refused.
 *
 *   It also does not refuse a path it has no classification for. An unclassified path is REPORTED
 *   (`supplyReport().unclassified`, and a note in the arena's output) so that classifying it is a
 *   deliberate edit rather than something the runtime guesses at — and `tests/harness_inputs_check.js`
 *   fails the build if any flag in the ablation registry is unclassified, which is where the
 *   registry is actually decided. Refusing at runtime instead would take the whole feature table
 *   down over a flag that might be perfectly well supplied, and "unclassified" is not evidence of
 *   anything by itself.
 */
'use strict';

/**
 * The input channels a flag can read, each with a probe over (state, engine, returnedRanking).
 * A probe must be PURE and cheap: it runs on the decision path until it first returns true.
 */
const CHANNELS = {
  /* The opponent clock's snapshot, published on the board by the driver (content.js's `_syncClock`). */
  clock: {
    label: 'state.clock (the opponent clock snapshot)',
    probe: function (state) { return !!(state && state.clock); }
  },
  /* A MEASURED deliberation pace: samples exist, so the label is not the 'unknown' identity.
   * REPORTED, NOT POLICED: no row requires it, because the arena can DECLARE the pace instead of
   * measuring it (ATTEMPTS.md D2) and the samples therefore come and go with the mode — refusing on
   * its absence would refuse a state the clock can legitimately read. It stays in the report because
   * that is what separates D2's two halves: the snapshot arriving at all, and the snapshot carrying
   * a measured pace rather than the 'unknown' identity. */
  clockPace: {
    label: 'clock samples (our own outgoing /choose plus the turn latency)',
    probe: function (state) {
      const c = state && state.clock;
      return !!(c && typeof c.samples === 'number' && c.samples > 0);
    }
  },
  /* The opponent's ladder rating, off their own `|player|` line. */
  rating: {
    label: "state.opponentRating (the |player| line's rating field)",
    probe: function (state) {
      return !!(state && typeof state.opponentRating === 'number' && isFinite(state.opponentRating));
    }
  },
  /* The client's own accuracy table — the `|stacc|` frame. src/injected.js emits it live;
   * engine_bridge.js forwards it for the arena; a harness that does neither has an empty table. */
  accuracy: {
    label: 'state.moveAccuracy (the |stacc| accuracy table)',
    probe: function (state) {
      return !!(state && state.moveAccuracy && Object.keys(state.moveAccuracy).length > 0);
    }
  },
  /* At least one opponent reply to price: without one there is no matrix to solve at all. */
  oppReply: {
    label: 'at least one opponent action in a sampled world',
    probe: function (state, engine) {
      if (!engine || typeof engine.getOppActions !== 'function') return false;
      const worlds = engine.lastReadout && engine.lastReadout.worlds;
      const world = worlds && worlds[0];
      if (!world) return false;
      try { return (engine.getOppActions(world, state) || []).length > 0; } catch (e) { return false; }
    }
  },
  /* A SETUP reply on their side, which is the input `laplace.quiescence.extendSetup` re-prices. */
  setupReply: {
    label: 'an opponent SETUP move among their replies',
    probe: function (state, engine, U) {
      if (!engine || typeof engine.getOppActions !== 'function' || !U) return false;
      const worlds = engine.lastReadout && engine.lastReadout.worlds;
      const world = worlds && worlds[0];
      if (!world) return false;
      let actions = [];
      try { actions = engine.getOppActions(world, state) || []; } catch (e) { return false; }
      for (let i = 0; i < actions.length; i++) {
        if (actions[i].kind !== 'move') continue;
        const data = U.getMoveData(actions[i].name);
        if (data && data.isSetup) return true;
      }
      return false;
    }
  },
  /* A switch row on OUR side: the input every switch-scoring flag re-prices. */
  switchRow: {
    label: 'a switch row in our own ranking',
    probe: function (state, engine, U, returned) {
      return !!(returned && returned.some(function (r) { return r && r.kind === 'switch'; }));
    }
  },
  /* More than one live row: `laplace.nash.enabled` is a measurement of a solve that needs a choice. */
  multiRow: {
    label: 'two or more live rows for the solve to choose between',
    probe: function (state, engine, U, returned) {
      if (!returned) return false;
      return returned.filter(function (r) { return r && !r.isVetoed; }).length >= 2;
    }
  },
  /* The surviving candidate-set pool on their active body — what the pruner's deductions leave of
   * their possible sets, which the information-gain and surprise-mask tiers price. An EMPTY pool is
   * a different input from `liveSet`: with no candidates there is no fog to measure and no
   * unrevealed set to weight. Measured: supplied by the arena from turn 2, never supplied by
   * `tools/benchmark_human_match.js` at all. */
  oppCandidatePool: {
    label: "the opponent's surviving candidate-set pool (state.active.opp.candidateSets)",
    probe: function (state) {
      const opp = state && state.active && state.active.opp;
      return !!(opp && Array.isArray(opp.candidateSets) && opp.candidateSets.length > 0);
    }
  }
};

/**
 * Which channel(s) each flag family reads. Matched on the LONGEST prefix of the FULL dotted path,
 * so `clock.ratingBands.enabled` resolves to the `clock.ratingBands` row and not the `clock` row.
 * `needs` is a list: a flag reading two channels needs BOTH supplied.
 *
 * The second group carries `needs: []` — classified, with no channel the HARNESS has to supply, and
 * a note saying what it reads instead. Those rows are what keeps a legitimate flag out of the
 * unclassified bucket, so the distinction has to be argued rather than assumed: see the header.
 */
const FLAG_INPUTS = [
  /* ---- fatal: the input is supplied from outside the engine's own turn evaluation ---- */
  { match: 'laplace.volatility', needs: ['accuracy'], note: 'the tilt charge is scaled by the accuracy table' },
  { match: 'laplace.comeback', needs: ['accuracy'], note: 'comeback scales ONLY the volatility charge, so it needs that charge to exist' },
  { match: 'laplace.quiescence', needs: ['setupReply'], note: 'the tier re-prices their setup reply and their Protect' },
  { match: 'laplace.nash', needs: ['multiRow'], note: 'the mixed solve needs a choice to solve' },
  { match: 'laplace.switchTax', needs: ['switchRow'], note: 'the tax is a drag on switch rows, so a run with no switch offered cannot price it' },
  { match: 'laplace.realOppSwitch', needs: ['oppReply'], note: 'prices THEIR switch reply, so it needs one' },
  { match: 'laplace.pricePivots', needs: ['switchRow'], note: 'the pivot tier prices a pivot move that leads to a bring-in' },
  { match: 'laplace.scouting', needs: ['oppCandidatePool'], note: 'the bounty is a share of the fog on a candidate pool it never received' },
  { match: 'laplace.surpriseMask', needs: ['oppCandidatePool'], note: 'the mask re-weights UNREVEALED candidate sets, so it needs a pool to mask' },
  { match: 'clock.ratingBands', needs: ['clock', 'rating'], note: 'the band is folded into switchFactor, which the engine reads off state.clock, and needs a rating to band' },
  { match: 'clock.switchPrior', needs: ['clock'], note: 'the deliberation priors are read off the clock snapshot' },
  { match: 'clock.', needs: ['clock'], note: 'the clock family is read off the snapshot the driver publishes' },

  /* ---- classified, no harness-dependent channel ---- */
  { match: 'laplace.beam2Ply', needs: [], note: 'the gate IS the config flag: with it on the beam runs, so there is no separate input to police' },
  { match: 'laplace.wincon', needs: [], note: 'the tier builds its own plan, and a null plan is its answer ("no body to remove"), not a missing input' },
  { match: 'laplace.profile', needs: [], note: 'the engine feeds its own profiler from the turn it just resolved; a factor of 1 is its answer, not an unfed channel' },
  { match: 'laplace.endgame', needs: [], note: 'runs only inside an endgame position, which the sample may or may not reach' },
  { match: 'laplace.priceRecovery', needs: [], note: 'prices a recovery move in their reply set; supplied by the position, not the harness' },
  { match: 'laplace.priceMyMoveEffects', needs: [], note: 'writes our own setup boosts and hazard changes to the leaf sim; supplied by the position, not the harness' },
  { match: 'laplace.priceMyMoveStatus', needs: [], note: 'writes our own status move\'s condition onto their leaf body; supplied by the position, not the harness' },
  { match: 'laplace.priceMyMoveProtect', needs: [], note: 'prices our own shield against their reply; supplied by the position, not the harness' },
  { match: 'laplace.rollKoBranch', needs: [], note: 'reads the roll set the damage engine already computed for the hit it is pricing; supplied by the position, not the harness' },
  { match: 'laplace.urgency', needs: [], note: 'reads the turn number and the rows, both always supplied' },
  { match: 'evaluator.threatSpeedGate', needs: [], note: 'replaces a binary speed comparison with a ramp over the same two Speeds, which the engine computes from the board it was handed — there is no channel here for a harness to supply' },
  { match: 'pruner.damageEvidence', needs: [], note: 'reads damage observed in the log, which every battle supplies' },
  { match: 'pruner.residualOrder', needs: [], note: 'reads the residual order the parser asserts from the log' },
  { match: 'pruner.abilityDeduction', needs: [], note: 'reads revealed status/ability/grounded damage evidence from the log' },
  /* The two EMPTY-OVERLAY controls. `pruner.scout` and `usage` re-weight sets from a GENERATED DATA
   * overlay that ships empty, so in a harness without one the tier is inert BY CONSTRUCTION and a
   * flat row is the correct, expected answer — which is what the ablation runner calls them.
   * Mapping them to some other channel (the clock was the first attempt) would have been worse than
   * classifying them: the check would then pass or fail for a reason that has nothing to do with
   * the flag. */
  { match: 'pruner.scout', needs: [], note: 'documented control: the scouting overlay ships empty, so an inert row is the expected result' },
  { match: 'usage', needs: [], note: 'documented control: the ladder-usage overlay ships empty, so an inert row is the expected result' },
  { match: 'sampler', needs: [], note: 'samples the worlds the engine itself built; no external channel to police' },
  { match: 'veto.', needs: [], note: 'the board vetoes read hazards, field and counters the parser maintains' }
];

/** The longest FLAG_INPUTS match for a config path, or null when the path is unclassified. */
function inputFor(path) {
  const dotted = String(path || '');
  let best = null;
  for (let i = 0; i < FLAG_INPUTS.length; i++) {
    const row = FLAG_INPUTS[i];
    if (dotted === row.match || dotted.indexOf(row.match) === 0) {
      if (!best || row.match.length > best.match.length) best = row;
    }
  }
  return best;
}

/* Every collector created in this PROCESS. A harness measures ONE config per process — the arena
 * applies a single patch before its first session, the benchmark before the modules load, and the
 * ablation spawns one child per variant — so a process-wide registry is the right scope and needs
 * no plumbing through session factories. */
const LIVE = [];

/**
 * watch(engine) -> collector
 *
 * Wraps `evaluateTurn` and records the first turn each channel was seen on. Returns the collector
 * so a caller can inspect it directly; it is also registered process-wide, which is what
 * `assertSupplied` reads.
 */
function watch(engine, U) {
  const collector = { turns: 0, seen: Object.create(null), engine: engine };
  LIVE.push(collector);
  if (!engine || typeof engine.evaluateTurn !== 'function') return collector;
  const original = engine.evaluateTurn;
  engine.evaluateTurn = function (state, opts) {
    const returned = original.call(this, state, opts);
    collector.turns++;
    const ids = Object.keys(CHANNELS);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      // Probed only until it is first seen: the watched path pays at most one probe per channel.
      if (collector.seen[id] !== undefined) continue;
      let hit = false;
      try { hit = !!CHANNELS[id].probe(state, this, U, returned); } catch (e) { hit = false; }
      if (hit) collector.seen[id] = collector.turns;
    }
    return returned;
  };
  return collector;
}

/** Merge every collector this process created into one { channelId: firstTurnSeen }. */
function observed() {
  const out = Object.create(null);
  for (let i = 0; i < LIVE.length; i++) {
    const seen = LIVE[i].seen;
    Object.keys(seen).forEach(function (id) {
      if (out[id] === undefined || seen[id] < out[id]) out[id] = seen[id];
    });
  }
  return out;
}

/** How many turns were watched at all — a run with none cannot say anything about any channel. */
function watchedTurns() {
  let n = 0;
  for (let i = 0; i < LIVE.length; i++) n += LIVE[i].turns;
  return n;
}

/** The path of an `appliedSets` entry, which the harnesses spell either way. */
function pathOf(entry) {
  return entry && entry.path ? entry.path : String(entry || '');
}

/**
 * findings(applied, only) -> [{ path, needs, missing, note, labels }]
 *
 * `applied` is the harness's own `appliedSets` echo (an array of { path, ... }). `only` optionally
 * restricts the report to a set of channel ids (the ablation uses it to ask about one variant).
 * Only CLASSIFIED paths with a channel that was never observed are returned — an unclassified path
 * is not evidence of anything and is reported by `unclassified` instead.
 */
function findings(applied, only) {
  const seen = observed();
  const out = [];
  (applied || []).forEach(function (entry) {
    const path = pathOf(entry);
    const row = inputFor(path);
    if (!row) return;
    const missing = row.needs.filter(function (id) {
      if (only && only.indexOf(id) === -1) return false;
      return seen[id] === undefined;
    });
    if (missing.length) {
      out.push({
        path: path, needs: row.needs.slice(), missing: missing, note: row.note,
        labels: missing.map(function (id) { return CHANNELS[id].label; })
      });
    }
  });
  return out;
}

/** The applied paths this module has no classification for, in the order they were applied. */
function unclassified(applied) {
  return (applied || []).map(pathOf).filter(function (path) { return !inputFor(path); });
}

/**
 * assertSupplied(applied, context) -> void, or throws.
 *
 * The refusal is deliberate and loud: a variant that never received its input is not a measurement
 * of the flag, and reporting its flat result as "this feature does nothing" is the false null this
 * check exists to stop. Passing an empty `applied` is always fine — the shipped build claims nothing.
 */
function assertSupplied(applied, context) {
  if (!applied || !applied.length) return;
  /* A run that watched no decisions cannot speak about any channel — but it also measured nothing,
   * and a caller with no battles to run is a different defect than a flag whose input was missing.
   * Only the case this module exists for is refused. */
  if (watchedTurns() === 0) return;
  const bad = findings(applied);
  if (!bad.length) return;
  const lines = bad.map(function (f) {
    return '  ' + f.path + ' reads ' + f.missing.map(function (id) { return CHANNELS[id].label; }).join(' + ') +
      '\n      never supplied during ' + watchedTurns() + ' watched turns' +
      (f.needs.length > f.missing.length
        ? ' (supplied: ' + f.needs.filter(function (id) { return f.missing.indexOf(id) === -1; })
            .map(function (id) { return CHANNELS[id].label; }).join(', ') + ')'
        : '') +
      '\n      why it matters: ' + f.note;
  });
  const err = new Error((context || 'harness') + ': refusing to report a flag whose INPUT was never ' +
    'supplied. A flat row here would be a false null — the flag was never given anything to act on.\n' +
    lines.join('\n'));
  err.code = 'UNSUPPLIED_INPUT';
  err.findings = bad;
  throw err;
}

/** A plain, JSON-able summary of what this process supplied, for a harness report. */
function supplyReport(applied) {
  return {
    watchedTurns: watchedTurns(),
    seen: observed(),
    unsupplied: findings(applied).map(function (f) {
      return { path: f.path, missing: f.missing };
    }),
    unclassified: unclassified(applied)
  };
}

module.exports = {
  supplyReport: supplyReport,
  CHANNELS: CHANNELS,
  FLAG_INPUTS: FLAG_INPUTS,
  inputFor: inputFor,
  watch: watch,
  observed: observed,
  watchedTurns: watchedTurns,
  findings: findings,
  unclassified: unclassified,
  assertSupplied: assertSupplied,
  /* Test hook: the process-wide registry, so a suite can run a case in isolation. */
  _live: LIVE
};
