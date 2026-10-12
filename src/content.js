/* Showdown Tactician — src/content.js
 * The broker: MAIN-world protocol events -> parser -> state manager -> pruner ->
 * Laplace engine -> HUD (+ optional LLM narration). Runs in the ISOLATED world, last in
 * the manifest order, so ST.util, ST.SetDatabase and every engine class already exist.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;

  const PROTOCOL_EVENT = 'ShowdownTactician_ProtocolEvent';
  const INJECTED_SRC = 'src/injected.js';

  class TacticianBoot {
    constructor(options) {
      options = options || {};
      this.doc = options.doc || (typeof document !== 'undefined' ? document : null);
      this.parser = ST.ProtocolParser ? new ST.ProtocolParser() : null;
      this.state = ST.BattleStateManager ? new ST.BattleStateManager() : null;
      // The damage engine is built first because the pruner's reverse-damage rule needs it to
      // run an observed hit back through each candidate spread.
      this.damage = ST.DamageEngine ? new ST.DamageEngine({ gen: 9 }) : null;
      this.pruner = ST.ArchetypePruner ? new ST.ArchetypePruner({ damage: this.damage }) : null;
      this.trickRoom = ST.TrickRoomEngine ? new ST.TrickRoomEngine(this.damage) : null;
      // Opponent deliberation telemetry: fed every raw line in handleLine(), read by the solver
      // through state.clock. Never on the critical path of a decision, never throws.
      this.clock = ST.OpponentClock ? new ST.OpponentClock() : null;
      this.evaluator = ST.DenseStateEvaluator ? new ST.DenseStateEvaluator() : null;
      this.tempo = ST.TempoEngine ? new ST.TempoEngine({ damage: this.damage, trickRoom: this.trickRoom }) : null;
      this.veto = ST.BlunderVetoGuard ? new ST.BlunderVetoGuard({ damage: this.damage, trickRoom: this.trickRoom }) : null;
      this.sampler = ST.WorldSampler ? new ST.WorldSampler({ K: 6 }) : null;
      this.engine = ST.LaplaceEngine ? new ST.LaplaceEngine({
        sampler: this.sampler, damage: this.damage, evaluator: this.evaluator,
        tempo: this.tempo, veto: this.veto, trickRoom: this.trickRoom
      }) : null;
      this.llm = ST.LLMTactician ? new ST.LLMTactician() : null;
      const self = this;
      // The HUD owns the DOM; the boot owns the answers. A bench tap and a receipt copy come
      // back through these two callbacks, so ui_overlay.js never needs the engine.
      this.hud = ST.MobileHUD ? new ST.MobileHUD({
        doc: this.doc,
        state: this.state,
        onBenchTap: function (id) { return self._selectBenchTarget(id); },
        onCopyReceipt: function (text) { return self._copyReceipt(text); }
      }) : null;
      this.team = null;
      this.pendingReadout = null;
      this.lastEvaluateTurn = -1;
      this.selectedBenchId = null;   // bench-tap sandbox: null = preview the active pair
      this._trAlerted = false;       // the haptic fires ONCE per battle, on TR's last turn
      // Chromium only honours navigator.vibrate after the frame has received a real user gesture
      // and refuses it LOUDLY (a console error) before that. A player in a battle has tapped
      // something long before trick room's last turn; a spectator tab has not, and there the
      // pulse is a dropped call plus noise. So the alert asks the gate below before buzzing.
      this._userTouched = false;
      this._gestureTracked = false;  // false = we cannot know, so we still attempt the pulse
      this.started = false;
      this.stats = { lines: 0, requests: 0, evaluations: 0, llmAnswers: 0, errors: [] };
      // Wire the pipeline at construction time: the state manager subscribes to the parser,
      // so every event reaches the single source of truth even before start() runs.
      if (this.state && this.parser && typeof this.state.attachParser === 'function') {
        this.state.attachParser(this.parser);
      }
    }

    /* ------------------------------------------------------------- lifecycle */

    start() {
      if (this.started) return this;
      this.started = true;
      this._injectMainWorld();
      this._listen();
      if (this.hud && typeof this.hud.bindDrawer === 'function') this.hud.bindDrawer();
      if (this.hud && typeof this.hud.setTeamStatus === 'function') {
        this.hud.setTeamStatus('Loading team from storage...');
      }
      this.loadTeam().then(this._onTeamLoaded.bind(this));
      this._watchStorage();
      return this;
    }

    /** Inject src/injected.js into the page's MAIN world. */
    _injectMainWorld() {
      const doc = this.doc;
      if (!doc || typeof doc.createElement !== 'function') return false;
      try {
        if (doc.documentElement && doc.documentElement.getAttribute('data-st-injected') === '1') return true;
        const script = doc.createElement('script');
        script.src = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
          ? chrome.runtime.getURL(INJECTED_SRC)
          : INJECTED_SRC;
        script.async = false;
        script.onload = function () { if (script.remove) script.remove(); };
        const parent = doc.head || doc.documentElement || doc.body;
        if (parent && parent.appendChild) {
          parent.appendChild(script);
          if (doc.documentElement && doc.documentElement.setAttribute) {
            doc.documentElement.setAttribute('data-st-injected', '1');
          }
          return true;
        }
      } catch (e) { this._error('inject', e); }
      return false;
    }

    _listen() {
      const doc = this.doc;
      if (!doc || typeof doc.addEventListener !== 'function') return;
      const self = this;
      doc.addEventListener(PROTOCOL_EVENT, function (evt) {
        const payload = self._normalize(evt);
        if (!payload || !payload.rawLine) return;
        self.handleLine(payload.rawLine, payload.kind);
      });
      // The haptic gate: one passive listener per gesture type, each self-removing, purely to
      // record that this frame has been touched at all. `{once, passive}` is preferred; a
      // document that rejects options still gets a plain listener rather than no tracking.
      const touched = function () { self._userTouched = true; };
      const gestures = ['pointerdown', 'touchstart', 'keydown'];
      for (let g = 0; g < gestures.length; g++) {
        try {
          doc.addEventListener(gestures[g], touched, { once: true, passive: true });
          this._gestureTracked = true;
        } catch (e) {
          try { doc.addEventListener(gestures[g], touched, false); this._gestureTracked = true; }
          catch (e2) { /* no gesture tracking available: the gate stays open */ }
        }
      }
      // attachParser is idempotent (it releases the previous subscription first).
      if (this.state && typeof this.state.attachParser === 'function' && this.parser) {
        this.state.attachParser(this.parser);
      }
    }

    /** Normalizes a cross-world CustomEvent, including the dataset mirror fallback. */
    _normalize(evt) {
      let detail = evt && evt.detail;
      try {
        if (typeof detail === 'string') detail = JSON.parse(detail);
      } catch (e) { detail = null; }
      if (detail && !detail.rawLine && detail.json) {
        try { detail = JSON.parse(detail.json); } catch (e2) { detail = null; }
      }
      if (!detail || !detail.rawLine) {
        const doc = this.doc;
        const el = doc && doc.documentElement;
        const mirrored = el && el.dataset ? el.dataset.stLine : null;
        if (mirrored) detail = { rawLine: mirrored, kind: (el.dataset && el.dataset.stLineKind) || 'poll' };
      }
      if (!detail || !detail.rawLine) return null;
      return { rawLine: String(detail.rawLine), kind: detail.kind || 'recv' };
    }

    /* ------------------------------------------------------------- pipeline */

    /**
     * handleLine(rawLine, kind) — the single entry point used by listeners and tests.
     * `kind` is 'recv' for the battle stream, 'send' for our own outgoing /choose lines and
     * 'poll' for the window.app fallback. ProtocolParser.feed() returns ONE primary event
     * (or null) and delivers any synthesised follow-up events to subscribers, so the primary
     * event is wrapped here instead of being dropped as a non-array. Returns the ranked
     * actions when the line was a decision request, else the protocol event array.
     */
    handleLine(rawLine, kind) {
      if (!rawLine) return [];
      this.stats.lines++;
      // The clock sees EVERY line before the parser does — including our own outgoing /choose
      // (kind === 'send') and the |request| frame that opens a decision window — because the
      // timing question is about when things arrived, not about what they meant.
      if (this.clock) {
        try { this.clock.note(rawLine, kind); this._syncClock(); } catch (e) { this._error('clock', e); }
      }
      if (!this.parser) return [];
      const before = this.parser.currentTurn;
      let event = null;
      try {
        event = this.parser.feed(rawLine);
      } catch (e) {
        this._error('parse', e);
        return [];
      }
      if (!event || typeof event !== 'object') return [];
      const ranked = this._afterEvent(event, before);
      return Array.isArray(ranked) ? ranked : [event];
    }

    _afterEvent(event, previousTurn) {
      if (!event || !event.type) return undefined;
      if (event.type === 'init') {
        // A fresh battle: the deliberation floor is per-connection and per-opponent, so it must
        // not be inherited from the previous game. Same for the bench selection and the one-shot
        // Trick Room alert.
        // The deliberation floor is per-connection and per-OPPONENT, and so is the rating the
        // Elo band reads: a rating left over from the previous game is exactly as wrong as a stale
        // floor, so it is cleared with them. (It has to happen here rather than inside reset(),
        // which the constructor calls AFTER seeding opts.rating.)
        if (this.clock) { this.clock.reset(); this.clock.setRating(null); this._syncClock(); }
        this.selectedBenchId = null;
        this._trAlerted = false;
        if (this.hud && typeof this.hud.dismissReceipt === 'function') this.hud.dismissReceipt();
        // The candidate pools are seeded per side|slot|species and are only meaningful for the
        // battle they were seeded in: after a reconnect Showdown replays the whole log, and a
        // pool seeded while the previous game had already disproved a Choice item would make the
        // new battle inherit that deduction. (The state manager clears the board itself — see
        // BattleStateManager._onInit.)
        if (this.pruner && typeof this.pruner.reset === 'function') {
          try { this.pruner.reset(); } catch (e) { this._error('pruner-reset', e); }
        }
        return undefined;
      }
      if (event.type === 'unknown') {
        // `|teampreview|` is deliberately INERT to the parser and the state manager (it is room
        // chatter, and parser_fuzz pins that contract), but it is the one moment both rosters are
        // visible and nothing else is. Handle it here from the raw command rather than inventing a
        // new event type.
        if (event.cmd === 'teampreview') this._computeLeadAdvisory();
        return undefined;
      }
      if (event.type === 'player') {
        // Carry the OPPONENT's ladder rating (`|player|p2|Name|avatar|1480`) onto the clock. The
        // Elo bands ship off, so this is telemetry until they are enabled; the state manager has
        // already stored both ratings on the state itself.
        if (this.clock && event.side && this.state) {
          const pst = this.state.state || this.state;
          if (pst && event.side === pst.oppSide) { this.clock.setRating(event.rating); this._syncClock(); }
        }
        return undefined;
      }
      if (event.type === 'request') {
        return this._onRequest();
      }
      if (event.type === 'speedfloor') {
        if (this.pruner && typeof this.pruner.handleSpeedFloorEvent === 'function' && this.state) {
          try { this.pruner.handleSpeedFloorEvent(event, this.state.state || this.state); } catch (e) { this._error('speedfloor', e); }
        }
        return;
      }
      if (event.type === 'move' && this.pruner && this.state) {
        const mon = this._monFor(event);
        if (mon) {
          const twoMoves = (mon.activeStintMoves || []).length >= 2 && !mon.isEncored;
          if (twoMoves || mon.candidateSets.length > 1) {
            try { this.pruner.prune(mon, this.state.state || this.state); } catch (e) { this._error('prune', e); }
          }
        }
      }
      if (event.type === 'item' || event.type === 'enditem' || event.type === 'activate' || event.type === 'switch') {
        const mon = this._monFor(event);
        if (mon && this.pruner) {
          try { this.pruner.prune(mon, this.state.state || this.state); } catch (e) { this._error('prune2', e); }
        }
        if (this.state && this.state.state && this.state.state.formatLocks && this.state.state.formatLocks.oppHasMegaEvolved &&
            this.pruner && typeof this.pruner.applyFormatLockCascade === 'function') {
          try { this.pruner.applyFormatLockCascade(this.state.state); } catch (e) { this._error('cascade', e); }
        }
      }
      if (event.type === 'turn' && this.trickRoom) {
        try { this.trickRoom.tick(this.state ? (this.state.state || this.state) : null); } catch (e) { this._error('tr-tick', e); }
        if (this.hud && this.state) this._refreshNonDecisionUi();
      }
      // The lead advisory is a Turn-0 card: once the battle is actually under way it is stale, so
      // the first |turn| takes it down.
      if (event.type === 'turn' && this.hud && typeof this.hud.dismissLeadAdvisory === 'function') {
        try { this.hud.dismissLeadAdvisory(); } catch (e) { this._error('lead-dismiss', e); }
      }
      // The end of the match: build the receipt from the counters the state manager kept.
      if (event.type === 'win' || event.type === 'tie') {
        const st = this.state ? (this.state.state || this.state) : null;
        if (st && this.hud && typeof this.hud.renderReceipt === 'function') {
          const receipt = this._buildReceipt(st);
          if (receipt) {
            try { this.hud.renderReceipt(receipt); } catch (e) { this._error('receipt', e); }
          }
        }
      }
      if (event.type === 'faint' || event.type === 'switch' || event.type === 'fieldStart' || event.type === 'fieldEnd') {
        if (this.hud) this._refreshNonDecisionUi();
      }
    }

    _monFor(event) {
      if (!this.state || !event) return null;
      const state = this.state.state || this.state;
      const side = event.side || null;
      if (side && event.slot && typeof this.state.getMon === 'function') {
        const mon = this.state.getMon(side, event.slot);
        if (mon) return mon;
      }
      const team = side === state.mySide ? state.myTeam : state.oppTeam;
      if (!team) return null;
      const wanted = U.toID(event.species);
      for (let i = 0; i < team.length; i++) {
        if (team[i] && U.toID(team[i].species || team[i].id) === wanted) return team[i];
      }
      return null;
    }

    /** A decision turn: evaluate, render, then ask the LLM without blocking. */
    _onRequest() {
      this.stats.requests++;
      const state = this.state ? (this.state.state || this.state) : null;
      if (!state || state.formatSupported === false) {
        if (this.hud && state) {
          this.hud.render([], state, null);
          this.hud.renderTRChip('', 'info');
        }
        return [];
      }
      if (state.legalActions && state.legalActions.wait) return [];
      if (this.parser && typeof this.state.isOpponentSpeedAtLeast === 'function') {
        const my = state.active && state.active.my;
        if (my && this.parser) {
          const myField = state.field || {};
          this.parser.speedHint = {
            // Same resolution order the veto layer uses for the same reason: an item or
            // ability we actually hold must not vanish just because the *observed* fields
            // (currentBattleItem / confirmedItem / revealedAbility) were never populated —
            // a paste-registered mon only carries `mon.item` / `mon.ability`.
            mySpeed: U.computeSpeed(my, {
              item: my.currentBattleItem || my.confirmedItem || my.item || (my.liveSet && my.liveSet.item),
              ability: my.revealedAbility || my.ability || (my.liveSet && my.liveSet.ability),
              boosts: my.boosts,
              boostStage: (my.boosts && my.boosts.spe) || 0,
              weather: myField.weather || '',
              terrain: myField.terrain || '',
              tailwind: !!(myField.tailwind && myField.tailwind[state.mySide || 'p1'])
            }).effective,
            mySpecies: my.species
          };
        }
      }
      if (state.turn === this.lastEvaluateTurn) { this._refreshNonDecisionUi(); return []; }
      this.lastEvaluateTurn = state.turn;

      let ranked = [];
      try {
        ranked = this.engine ? this.engine.evaluateTurn(state) : [];
        this.stats.evaluations++;
      } catch (e) {
        this._error('evaluate', e);
        ranked = [];
      }
      this.pendingReadout = this.engine ? this.engine.lastReadout : null;

      if (this.hud) {
        try {
          this.hud.render(ranked, state, this.pendingReadout);
        } catch (e2) { this._error('render', e2); }
      }
      this._renderScreenExtras(state);
      this._maybeAlertTR(state);
      this._askLLM(state, ranked);
      return ranked;
    }

    _askLLM(state, ranked) {
      if (!this.llm || typeof this.llm.getTacticalReadout !== 'function') return;
      const self = this;
      const tempoVector = this.pendingReadout ? this.pendingReadout.tempo : null;
      try {
        const promise = this.llm.getTacticalReadout(state, ranked, tempoVector);
        if (!promise || typeof promise.then !== 'function') return;
        promise.then(function (readout) {
          if (!readout || !self.hud) return;
          self.stats.llmAnswers++;
          self.hud.updateLLMReason(readout.action, readout.reason);
          const best = ranked && ranked.length ? ranked[0] : null;
          if (best && self.hud.updateLLMReason) self.hud.updateLLMReason(best.name, readout.reason);
        }).catch(function () { /* the bridge already swallows errors */ });
      } catch (e) { this._error('llm', e); }
    }

    /**
     * Compute the Turn-0 lead advisory and publish it (state.leadAdvisory + the HUD card).
     * Defensive: a missing engine or an engine that throws leaves the previous value alone.
     */
    _computeLeadAdvisory() {
      if (!this.engine || !this.state) return null;
      const st = this.state.state || this.state;
      if (!st) return null;
      let advisory = null;
      try {
        advisory = typeof this.engine.leadAdvisory === 'function' ? this.engine.leadAdvisory(st) : null;
      } catch (e) { this._error('lead-advisory', e); return null; }
      if (!advisory) return null;
      st.leadAdvisory = advisory;
      if (this.hud && typeof this.hud.renderLeadAdvisory === 'function') {
        try { this.hud.renderLeadAdvisory(advisory); } catch (e) { this._error('lead-hud', e); }
      }
      return advisory;
    }

    /** Publish the clock snapshot onto the battle state the solver and the HUD read. */
    _syncClock() {
      if (!this.clock || !this.state) return null;
      const st = this.state.state || this.state;
      if (!st) return null;
      const snap = this.clock.snapshot();
      st.clock = snap;
      return snap;
    }

    _refreshNonDecisionUi() {
      if (!this.hud || !this.state) return;
      const state = this.state.state || this.state;
      try {
        this.hud.renderBanner(state);
        this.hud.setCandidateBreakdown(state);
        if (state.field && state.field.trickRoom) {
          // The LAST turn gets the gold banner + the haptic (once, via _maybeAlertTR); the turn
          // before it is the loud reminder to land your chip or sack the setter.
          const left = U.clamp(state.field.trickRoomTurnsLeft || 0, 0, 5);
          if (left === 2) {
            this.hud.renderTRChip('TR: LAST TURN NEXT — land your chip or sack the setter now.', 'danger');
          }
        }
      } catch (e) { this._error('ui-refresh', e); }
      this._renderScreenExtras(state);
      this._maybeAlertTR(state);
    }

    /* ---------------------------------------------------- on-screen extras */

    /**
     * Everything that is not a confidence badge: the bench-tap sandbox, the lethal gauges, the
     * deduction badges and the Supreme Overlord readout. One preview serves both the sandbox and
     * the gauges, so tapping a bench body swaps them together.
     */
    _renderScreenExtras(state) {
      if (!this.hud || !state) return;
      try {
        const preview = this._preview(state);
        if (typeof this.hud.renderMovePreviews === 'function') this.hud.renderMovePreviews(preview);
        if (typeof this.hud.renderBenchTargets === 'function') {
          this.hud.renderBenchTargets(this._benchTargets(state), this.selectedBenchId);
        }
        if (typeof this.hud.renderDeductionBadges === 'function') {
          this.hud.renderDeductionBadges(this._deductionBadges(state));
        }
        if (typeof this.hud.renderOverlordGauge === 'function') {
          const gauge = (this.engine && typeof this.engine.overlordGauge === 'function')
            ? this.engine.overlordGauge(state) : null;
          this.hud.renderOverlordGauge(gauge);
        }
        // The PP-stall gauge and the format sentinel. Both read STATE MEASUREMENTS (the `|stpp|`
        // PP snapshot, state.formatLocks), so a null answer — nothing observed, no mechanic
        // spent — correctly removes the readout rather than showing a placeholder.
        if (typeof this.hud.renderPPGauge === 'function') {
          const pp = (this.engine && typeof this.engine.ppStall === 'function')
            ? this.engine.ppStall(state) : null;
          this.hud.renderPPGauge(pp);
        }
        if (typeof this.hud.renderFormatSentinel === 'function') {
          const sentinel = (this.engine && typeof this.engine.formatSentinel === 'function')
            ? this.engine.formatSentinel(state) : null;
          this.hud.renderFormatSentinel(sentinel);
        }
      } catch (e) { this._error('screen-extras', e); }
    }

    /** The preview for the currently selected target (a bench body) or the active pair. */
    _preview(state) {
      if (!this.engine || typeof this.engine.preview !== 'function') return null;
      if (this.selectedBenchId) {
        const vsBench = typeof this.engine.previewVsBench === 'function'
          ? this.engine.previewVsBench(this.selectedBenchId, state) : null;
        if (vsBench) return vsBench;
        // Their body left the bench (switched in, fainted): drop the selection rather than
        // showing a stale card for a monster that is no longer there.
        this.selectedBenchId = null;
      }
      return this.engine.preview(state.active ? state.active.opp : null, state);
    }

    /** The tappable bench bodies: every living, non-active opponent mon. */
    _benchTargets(state) {
      const team = (state && state.oppTeam) || [];
      const out = [];
      for (let i = 0; i < team.length; i++) {
        const mon = team[i];
        if (!mon || mon.fainted || mon.isActive) continue;
        out.push({
          id: mon.id || U.toID(mon.species),
          species: mon.species || mon.id || '',
          hpPercent: typeof mon.hpPercent === 'number' ? mon.hpPercent : 100,
          fainted: !!mon.fainted
        });
      }
      return out;
    }

    /** A tap on a bench pill: select it, or tap the same one again to go back to the active pair. */
    _selectBenchTarget(id) {
      const wanted = U.toID(id);
      if (!wanted) return false;
      this.selectedBenchId = (this.selectedBenchId === wanted) ? null : wanted;
      const state = this.state ? (this.state.state || this.state) : null;
      if (state) this._renderScreenExtras(state);
      return true;
    }

    /**
     * The "Detective Unmasked" badges. Each one is a deduction the engines already proved, not a
     * new guess: Heavy-Duty Boots confirmed by a hazard-free entry, a Choice item eliminated by
     * two moves in one stint, and the format lockout once their Mega or Z-Move is spent.
     */
    _deductionBadges(state) {
      const out = [];
      if (!state) return out;
      const opp = state.oppTeam || [];
      for (let i = 0; i < opp.length; i++) {
        const mon = opp[i];
        if (!mon || mon.confirmedItem !== 'Heavy-Duty Boots') continue;
        out.push({
          id: 'boots-' + mon.id, cls: 'unmasked',
          label: '🕵️ UNMASKED: Heavy-Duty Boots (100% Confirmed)',
          detail: mon.species + ' entered with hazards up and took no damage: it is holding Heavy-Duty Boots.'
        });
      }
      for (let i = 0; i < opp.length; i++) {
        const mon = opp[i];
        if (!mon || !mon.cannotBeChoice) continue;
        out.push({
          id: 'choice-' + mon.id, cls: 'choice-broken',
          label: '❌ CHOICE-LOCK BROKEN: Band / Specs / Scarf Eliminated',
          detail: mon.species + ' used two different moves in one stint without switching: no Choice item is possible.'
        });
      }
      const locks = state.formatLocks || {};
      if (locks.oppHasMegaEvolved || locks.oppHasUsedZMove) {
        const spent = [];
        if (locks.oppHasMegaEvolved) spent.push('Mega Evolution');
        if (locks.oppHasUsedZMove) spent.push('Z-Move');
        const bench = (state.bench && state.bench.opp ? state.bench.opp.length : Math.max(0, opp.length - 1));
        out.push({
          id: 'lockout', cls: 'lockout',
          label: '🔒 LOCKOUT ACTIVE: Remaining ' + bench + ' Bench Mons Cannot Hold Stones/Crystals',
          detail: spent.join(' + ') + ' is already spent in this format: no unrevealed body can carry a Mega Stone or Z-Crystal.'
        });
      }
      return out;
    }

    /**
     * Haptic alert: fires the configured pattern ONCE per battle, on the turn Trick Room drops to
     * its last turn, and repaints the badge gold. The CHIP is unconditional; the pulse is skipped
     * when the platform has no Vibration API (iOS, desktop), when the user turned it off in the
     * config, or when this frame has never been touched (see `_canVibrate`).
     */
    _maybeAlertTR(state) {
      if (!state || !state.field || !state.field.trickRoom) return false;
      if ((state.field.trickRoomTurnsLeft | 0) !== 1) return false;
      if (this._trAlerted) return false;
      this._trAlerted = true;
      if (this.hud && typeof this.hud.renderTRChip === 'function') {
        this.hud.renderTRChip('📳 TR: 1/5 — LAST TURN: attack or sack your setter!', 'gold');
      }
      const pattern = ST.configGet ? ST.configGet('hud.vibrate.pattern', [40, 60, 40]) : [40, 60, 40];
      if (!ST.configGet || ST.configGet('hud.vibrate.trLastTurn', true) !== false) {
        if (this._canVibrate()) this._vibrate(pattern);
      }
      return true;
    }

    /**
     * _canVibrate() -> whether the platform will honour a pulse from this frame.
     * We only suppress a pulse we KNOW the browser would refuse: with no gesture tracking
     * available (`_gestureTracked` false) the answer is yes, so the alert degrades to attempting
     * the call rather than silently never buzzing.
     */
    _canVibrate() {
      return !this._gestureTracked || this._userTouched === true;
    }

    /** navigator.vibrate, guarded: never throws, returns whether the platform accepted it. */
    _vibrate(pattern) {
      try {
        if (typeof navigator === 'undefined' || !navigator || typeof navigator.vibrate !== 'function') return false;
        if (ST.configGet && ST.configGet('hud.vibrate.enabled', true) === false) return false;
        // The API answers for itself: it returns false when the platform refused the request.
        return navigator.vibrate(pattern) !== false;
      } catch (e) { return false; }
    }

    /** The post-match receipt, assembled from state.battleStats (counted, never estimated). */
    _buildReceipt(state) {
      if (!state) return null;
      const stats = state.battleStats;
      if (!stats) return null;
      const nameOf = function (id) {
        const all = (state.myTeam || []).concat(state.oppTeam || []);
        for (let i = 0; i < all.length; i++) {
          if (all[i] && all[i].id === id) return all[i].species || id;
        }
        return id;
      };
      const rows = [];
      let mvp = null, mvpKos = -1, mvpDamage = -1;
      const team = state.myTeam || [];
      for (let i = 0; i < team.length; i++) {
        const mon = team[i];
        if (!mon) continue;
        const kos = (stats.kos && stats.kos[mon.id]) || 0;
        const dmg = (stats.damage && stats.damage[mon.id]) || 0;
        if (kos > mvpKos || (kos === mvpKos && dmg > mvpDamage)) { mvp = mon; mvpKos = kos; mvpDamage = dmg; }
      }
      rows.push({
        icon: '👑', label: 'Match MVP',
        value: mvp ? (mvp.species + ' — ' + Math.max(0, mvpKos) + ' KO' + (mvpKos === 1 ? '' : 's') +
          ', ' + Math.round(Math.max(0, mvpDamage)) + '% damage dealt') : 'no damage recorded'
      });
      const active = stats.trActiveTurns || 0;
      const used = stats.trAttackTurns || 0;
      const efficiency = active ? Math.round((used / active) * 100) : 0;
      rows.push({
        icon: '⏳', label: 'Trick Room Efficiency',
        value: used + ' / ' + active + ' active turns utilised (' + efficiency + '%)'
      });
      rows.push({
        icon: '🛡️', label: 'Magic Bounce Value',
        value: (stats.magicBounce || 0) + ' activation' + ((stats.magicBounce || 0) === 1 ? '' : 's')
      });
      rows.push({
        icon: '❄️', label: 'Snow Turns Active',
        value: (stats.snowTurns || 0) + ' turn' + ((stats.snowTurns || 0) === 1 ? '' : 's') +
          ((stats.snowTurns || 0) > 0 ? ' (+50% Def on Ice bodies)' : '')
      });
      if (stats.bestHit) {
        rows.push({
          icon: '⚡', label: 'Highest Damage Hit',
          value: nameOf(stats.bestHit.monId) + ' ' + (stats.bestHit.moveId || 'hit') +
            ' (' + stats.bestHit.percent + '% on turn ' + stats.bestHit.turn + ')'
        });
      }
      const max = ST.configGet ? ST.configGet('hud.receipt.maxDamageRows', 5) : 5;
      const shown = rows.slice(0, Math.max(3, max));
      const outcome = state.result === 'win' ? 'Victory!' : (state.result === 'loss' ? 'Defeat' : 'Draw');
      return {
        title: '🏆 MATCH RECEIPT (Turn ' + (state.turn || 0) + ' — ' + outcome + ')',
        headline: mvp ? (mvp.species + ' led the team with ' + Math.max(0, mvpKos) + ' KO' +
          (mvpKos === 1 ? '' : 's') + ' and ' + Math.round(Math.max(0, mvpDamage)) + '% of the damage.') : '',
        rows: shown,
        copyText: 'SHOWDOWN TACTICIAN — MATCH RECEIPT\n' + shown.map(function (r) {
          return r.icon + ' ' + r.label + ': ' + r.value;
        }).join('\n')
      };
    }

    /** Copy the receipt text: clipboard API first, a hidden textarea second, silence third. */
    _copyReceipt(text) {
      const payload = typeof text === 'string' ? text : '';
      if (!payload) return null;
      try {
        if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          const result = navigator.clipboard.writeText(payload);
          if (result && typeof result.catch === 'function') result.catch(function () { /* denied */ });
          return payload;
        }
      } catch (e) { /* fall through */ }
      try {
        const doc = this.doc;
        if (doc && typeof doc.createElement === 'function' && typeof doc.execCommand === 'function') {
          const area = doc.createElement('textarea');
          area.value = payload;
          doc.execCommand('copy');
          return payload;
        }
      } catch (e2) { /* nothing to do */ }
      return payload;
    }

    /* ------------------------------------------------------------- team */

    loadTeam() {
      const self = this;
      return new Promise(function (resolve) {
        let settled = false;
        const finish = function (text) { if (!settled) { settled = true; resolve(self.parseTeam(text)); } };
        try {
          if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local) {
            let cb = false;
            chrome.storage.local.get({ teamText: '' }, function (cfg) {
              cb = true;
              finish(cfg && cfg.teamText ? cfg.teamText : self._localTeam());
            });
            setTimeout(function () { if (!cb) finish(self._localTeam()); }, 200);
            return;
          }
        } catch (e) { /* fall through */ }
        finish(self._localTeam());
      });
    }

    _localTeam() {
      try {
        const doc = this.doc;
        if (doc && doc.defaultView && doc.defaultView.localStorage) {
          return doc.defaultView.localStorage.getItem('teamText') || '';
        }
        if (typeof localStorage !== 'undefined' && localStorage) return localStorage.getItem('teamText') || '';
      } catch (e) { /* ignore */ }
      return '';
    }

    parseTeam(text) {
      if (!text || !ST.TeamParser) { this.team = null; return null; }
      let parsed = null;
      try { parsed = ST.TeamParser.parsePokepaste(text); } catch (e) { this._error('team-parse', e); }
      const pokemon = parsed && Array.isArray(parsed.pokemon) ? parsed.pokemon : (Array.isArray(parsed) ? parsed : []);
      if (!pokemon.length) { this.team = null; return null; }
      this.team = parsed;
      if (this.state && typeof this.state.registerMyTeam === 'function') {
        try { this.state.registerMyTeam(pokemon); } catch (e2) { this._error('register-team', e2); }
      }
      return parsed;
    }

    _onTeamLoaded(parsed) {
      if (!this.hud || !this.hud.setTeamStatus) return;
      if (!parsed) { this.hud.setTeamStatus('No team loaded — open the drawer and paste a Pokepaste.'); return; }
      const pokemon = parsed.pokemon || [];
      const trNames = pokemon.filter(function (m) { return m && m.isTR; }).map(function (m) { return m.species || m.name; });
      this.hud.setTeamStatus({
        total: pokemon.length,
        trMons: trNames,
        trNames: trNames.slice(0, 3),
        errors: parsed.errors || []
      });
    }

    /** Auto-select the stored team that matches the species we actually brought. */
    matchTeam(battlePokemonList) {
      if (!ST.TeamParser || typeof ST.TeamParser.matchActiveTeam !== 'function') return null;
      try {
        const stored = ST.TeamParser.extractFromLocalStorage
          ? ST.TeamParser.extractFromLocalStorage()
          : [];
        return ST.TeamParser.matchActiveTeam(battlePokemonList, stored || []);
      } catch (e) { this._error('match-team', e); return null; }
    }

    _watchStorage() {
      try {
        if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.onChanged) {
          const self = this;
          chrome.storage.onChanged.addListener(function (changes, area) {
            if (area !== 'local' || !changes || !changes.teamText) return;
            self.parseTeam(changes.teamText.newValue || '');
            self._onTeamLoaded(self.team);
          });
        }
      } catch (e) { /* optional */ }
    }

    _error(where, err) {
      const message = where + ': ' + (err && err.message ? err.message : String(err));
      this.stats.errors.push(message);
      if (this.stats.errors.length > 50) this.stats.errors.shift();
      this._mirrorError(message);
      U.debug(message);
    }

    /**
     * Publish the failure onto the root element.
     *
     * The boot object lives in the content script's ISOLATED world, so nothing outside it can
     * read `stats.errors` — not the page, not an end-to-end test, and not a player who opens
     * DevTools on the page rather than on the extension. U.debug() cannot cover this either:
     * util.js's DEBUG flag is a module-level `let` that is false in every shipped build, so the
     * one diagnostic hook in the codebase is inert in production and an internal failure is
     * therefore completely silent.
     *
     * `data-st-injected` already proves the DOM is the shared surface both worlds can see, so
     * the same trick carries the failure. Diagnostics only: it must never be the thing that
     * throws, and a document with no dataset (the Node harness's stub) simply skips it.
     */
    _mirrorError(message) {
      const doc = this.doc;
      const el = doc && doc.documentElement;
      if (!el || !el.dataset) return;
      try {
        el.dataset.stError = String(message).slice(0, 500);
        el.dataset.stErrorCount = String(this.stats.errors.length);
      } catch (e) { /* best effort only */ }
    }
  }

  ST.TacticianBoot = TacticianBoot;

  // Auto-start inside a real page only; the test harness imports the class directly.
  try {
    if (typeof document !== 'undefined' && document && typeof window !== 'undefined' &&
        /play\.pokemonshowdown\.com/.test(String(window.location && window.location.hostname || ''))) {
      const boot = new TacticianBoot();
      window.__ST_BOOT__ = boot;
      boot.start();
      // The battle UI (and therefore our badges) is rebuilt constantly; refresh the
      // non-decision chrome (banner, TR chip) on a slow heartbeat too.
      setInterval(function () {
        try { boot._refreshNonDecisionUi(); } catch (e) { /* keep the timer alive */ }
      }, 2500);
    }
  } catch (e) {
    // Never break the page.
  }
})();
