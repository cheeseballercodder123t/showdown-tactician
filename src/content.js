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
      // back through these two callbacks, so ui_overlay.js never needs the engine. The layout
      // mode (auto / mobile / desktop) is read from page localStorage synchronously (the
      // chrome.storage read is async and the HUD is constructed inline here), and written
      // back on toggle via the `onLayoutModeChange` callback below.
      const STORAGE_HUD_LAYOUT_KEY = 'stHudLayout';
      let initialLayout = 'auto';
      try {
        const raw = window.localStorage.getItem(STORAGE_HUD_LAYOUT_KEY);
        if (typeof raw === 'string' && /^(auto|mobile|desktop)$/.test(raw)) initialLayout = raw;
      } catch (e) { /* private mode / unavailable storage */ }
      this.hud = ST.MobileHUD ? new ST.MobileHUD({
        doc: this.doc,
        state: this.state,
        layoutMode: initialLayout,
        onLayoutModeChange: function (mode) {
          // Mirror to both stores. localStorage is the synchronous read source the HUD
          // constructed itself from; chrome.storage.local is the cross-page source the
          // options page reads (it lives on the extension origin and has no access to
          // the page's localStorage).
          try { window.localStorage.setItem(STORAGE_HUD_LAYOUT_KEY, mode); } catch (e) { /* private mode */ }
          try {
            if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local) {
              chrome.storage.local.set({ [STORAGE_HUD_LAYOUT_KEY]: mode });
            }
          } catch (e) { /* no storage API (Node harness) */ }
        },
        onBenchTap: function (id) { return self._selectBenchTarget(id); },
        onCopyReceipt: function (text) { return self._copyReceipt(text); }
      }) : null;
      this.team = null;
      this.pendingReadout = null;
      this.lastEvaluateTurn = -1;
      // The identity of the DECISION WINDOW last evaluated. See _decisionFrameKey: the turn number
      // alone is not an identity — a turn routinely holds more than one decision (the move request
      // that opens it, then a `forceSwitch` request after a faint or a pivot move).
      this.lastEvaluateFrame = null;
      this.selectedBenchId = null;   // bench-tap sandbox: null = preview the active pair
      this._trAlerted = false;       // the haptic fires ONCE per battle, on TR's last turn
      // The Cancel window's background ponder (laplace.deepPonder). `_ponderId` is monotonic and
      // bumped by every new window — a request, a |turn|, an |init| — so a pass that finishes after
      // the window it was scheduled for has closed publishes nothing. `_lockedChoice` is the
      // outgoing /choose this client has already clicked (see _noteOutgoingChoice).
      this._ponderId = 0;
      this._lockedChoice = null;
      this.lastPonder = null;        // the last pass's outcome, for the debug HUD and the tests
      // Chromium only honours navigator.vibrate after the frame has received a real user gesture
      // and refuses it LOUDLY (a console error) before that. A player in a battle has tapped
      // something long before trick room's last turn; a spectator tab has not, and there the
      // pulse is a dropped call plus noise. So the alert asks the gate below before buzzing.
      this._userTouched = false;
      this._gestureTracked = false;  // false = we cannot know, so we still attempt the pulse
      this.started = false;
      this.stats = { lines: 0, requests: 0, evaluations: 0, llmAnswers: 0, ponders: 0, errors: [] };
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
      // The Cancel window turns on the client's OWN /choose, so it is read off the outgoing frame
      // (kind 'send') rather than inferred from anything the server sends back.
      if (kind === 'send') {
        try { this._noteOutgoingChoice(rawLine); } catch (e) { this._error('locked-choice', e); }
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
        // The evaluation latch is per-BATTLE as well. `_onRequest` returns the cached ranking
        // WITHOUT evaluating when `state.turn === this.lastEvaluateTurn`, so a new battle whose
        // turn number collides with the previous battle's last evaluated turn — a game that ended
        // on turn 1 is the easy case — would skip its evaluation entirely and leave the previous
        // battle's ranking and readout on the HUD.
        this.lastEvaluateTurn = -1;
        this.lastEvaluateFrame = null;
        this.pendingReadout = null;
        this._closePonderWindow();
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
      if (event.type === 'turn') {
        // A new turn is a new decision: any pass still queued for the previous window is stale, the
        // locked choice belonged to that window, and the Cancel button (if any) is gone.
        this._closePonderWindow();
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

    /**
     * _decisionFrameKey(state) -> a short string identifying ONE decision window, or null when the
     * board carries no request to identify.
     *
     * WHY THE TURN NUMBER IS NOT ENOUGH. `_onRequest` used to latch on `state.turn` alone, and a
     * turn routinely contains MORE THAN ONE decision: the move request that opens it, then a
     * `forceSwitch` request when a body faints (or a pivot move hands the turn's tail to a
     * replacement). Both carry the SAME turn number, so the second one used to hit the latch,
     * return `[]` without evaluating, and leave the previous window's ranking — a description of a
     * board that no longer exists — as the engine's answer.
     *
     * That is not a cosmetic staleness. The stale ranking is the PREVIOUS window's: it offers the
     * bench as it was, so it can name the very body that has since come in and fainted, and a
     * driver that clicks the engine's top line then writes `switch <that body>`. Measured in the
     * headless arena (5 battles, both seats): `|error|[Invalid choice] Can't switch: You can't
     * switch to an active Pokémon` on the faint frames, plus every replacement bring-in chosen
     * from a ranking that no longer applied.
     *
     * The identity is STRUCTURAL, not `rqid`: a request payload is not guaranteed to carry one
     * (`@pkmn/sim` 0.10.11 sends `{teamPreview, side}` and nothing else, and a browser client's
     * rqid is not stable across a reconnect replay). `rqid` is still preferred when it IS present,
     * since it is the server's own frame identity. Two IDENTICAL re-deliveries — the same frame
     * after `|error|[Invalid choice]`, a duplicated poll — collapse to the same key and still
     * evaluate once, which is what the latch exists for.
     */
    _decisionFrameKey(state) {
      const req = state && state.request;
      if (!req || typeof req !== 'object') return null;
      if (typeof req.rqid === 'number' || (typeof req.rqid === 'string' && req.rqid)) return 'rq:' + req.rqid;
      if (req.teamPreview) return 'preview';
      if (req.wait) return 'wait';
      const parts = ['t' + state.turn];
      parts.push('fs' + (Array.isArray(req.forceSwitch)
        ? req.forceSwitch.map(function (v) { return v ? 1 : 0; }).join('')
        : ''));
      const active = (req.active && req.active[0]) || null;
      if (active) {
        parts.push('tr' + (active.trapped ? 1 : 0) + (active.maybeTrapped ? 1 : 0));
        // The move list is part of the window: a disabled move, a spent PP or a Struggle-only
        // menu is a different decision even when the bodies are the same.
        parts.push('mv' + (active.moves || []).map(function (m) {
          return U.toID(m.id || m.move) + ':' + (m.pp === undefined || m.pp === null ? '' : m.pp) +
            (m.disabled ? 'd' : '');
        }).join(','));
      } else {
        // No move list at all IS the forceSwitch window's signature, and it is the distinction the
        // old turn-only latch could not see.
        parts.push('noactive');
      }
      const mons = (req.side && req.side.pokemon) || [];
      parts.push('side' + mons.map(function (m) {
        return (m.ident || '') + (m.active ? 'A' : '') + '@' + (m.condition || '');
      }).join('|'));
      return parts.join(':');
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
      const frameKey = this._decisionFrameKey(state);
      // `null` means the board carries no request to identify, so the turn number is the only thing
      // there is to latch on — exactly the old behaviour, and the same fallback a driver-built
      // board gets. Otherwise the WINDOW is the identity, and a second window in the same turn is
      // evaluated instead of being answered with the first window's ranking.
      const fresh = frameKey === null
        ? (state.turn !== this.lastEvaluateTurn)
        : (frameKey !== this.lastEvaluateFrame);
      if (!fresh) { this._refreshNonDecisionUi(); return []; }
      this.lastEvaluateFrame = frameKey;
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
      // PASS 2. Everything above is the fast path and has already painted the HUD; the deeper read
      // runs on a later tick and either updates the HUD in place (nothing locked in yet) or flags
      // the Cancel button (a move is already clicked).
      this._scheduleDeepPonder(state);
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

    /* --------------------------------------------------- the Cancel ponder */

    /**
     * _deepPonderPlan() -> the config plan for the background pass, or null when it is off.
     *
     * Read per scheduling rather than cached in the constructor: the knob is a policy switch, and a
     * test (or a user) that flips it between turns should not have to rebuild the boot.
     */
    _deepPonderPlan() {
      const cfg = (typeof ST.configGet === 'function') ? ST.configGet : function (path, fallback) { return fallback; };
      const dp = cfg('laplace.deepPonder', null);
      if (!dp || dp.enabled !== true) return null;
      const worlds = Math.floor(dp.deepWorlds);
      if (!(worlds > 0)) return null;
      return {
        deepWorlds: worlds,
        useBeam2Ply: dp.useBeam2Ply !== false,
        useEndgame3v3: dp.useEndgame3v3 !== false,
        cancelAlertScoreDelta: typeof dp.cancelAlertScoreDelta === 'number' ? dp.cancelAlertScoreDelta : 45,
        cancelAlertConfDelta: typeof dp.cancelAlertConfDelta === 'number' ? dp.cancelAlertConfDelta : 15
      };
    }

    /**
     * _noteOutgoingChoice(rawLine) — what the PLAYER did, read off their own outgoing frame.
     *
     * This is the only evidence that a move has been locked in: Showdown shows its Cancel button on
     * the strength of the client's own `/choose`, not on anything the server sends back. Payloads
     * arrive in both spellings the client uses — a bare `/choose move 1` and the split
     * `battle-…|/choose move 1|12` — so the line is read token by token and any `/`-prefixed token is
     * examined rather than assuming the command starts the string.
     *
     * A `/undo` (the Cancel button's own command) clears the lock AND the alert, because the alert
     * names a choice that no longer exists. `team` choices are ignored: a team-preview pick is not a
     * locked move and nothing in the ponder compares against it.
     */
    _noteOutgoingChoice(rawLine) {
      if (typeof rawLine !== 'string' || !rawLine) return null;
      const parts = rawLine.split('|');
      for (let i = 0; i < parts.length; i++) {
        const token = parts[i].trim();
        if (!token || token.charAt(0) !== '/') continue;
        if (/^\/undo\b/i.test(token)) {
          this._lockedChoice = null;
          this._clearCancelAlert();
          return null;
        }
        const choose = /^\/choose\s+([^,]+)/i.exec(token);
        if (!choose) continue;
        const named = /^(move|switch|team)\s+([^\s]+)/i.exec(choose[1].trim());
        if (!named) continue;
        const kindWord = named[1].toLowerCase();
        if (kindWord === 'team') { this._lockedChoice = null; return null; }
        this._lockedChoice = { kind: kindWord, arg: named[2], raw: token };
        return this._lockedChoice;
      }
      return null;
    }

    /**
     * _lockedAction(state) -> the action the player locked in, resolved against the REQUEST, or null.
     *
     * The wire says `move 2`; the ranking is keyed by move id. The request's own list is the only
     * honest mapping between them (the client's slot order IS the argument order), and when it
     * cannot be resolved — no request, an out-of-range slot, a switch to a body the request does not
     * list — the answer is null, which suppresses the alert entirely. A guess here would name the
     * wrong line to undo.
     */
    _lockedAction(state) {
      const locked = this._lockedChoice;
      if (!locked || !state) return null;
      const req = state.request;
      if (!req || typeof req !== 'object') return null;
      if (locked.kind === 'move') {
        const index = parseInt(locked.arg, 10);
        const active = req.active && req.active[0];
        const moves = (active && active.moves) || [];
        if (!(index >= 1) || index > moves.length) return null;
        const slot = moves[index - 1] || {};
        const id = U.toID(slot.id || slot.move || '');
        if (!id) return null;
        return { kind: 'move', id: id, name: slot.move || slot.id || id, slot: index };
      }
      if (locked.kind === 'switch') {
        const index = parseInt(locked.arg, 10);
        const list = (req.side && req.side.pokemon) || [];
        if (!(index >= 1) || index > list.length) return null;
        const slot = list[index - 1] || {};
        /* The request's ident is `p1: Gholdengo`, and the ranking keys a switch by the SPECIES id
         * (`gholdengo`) — so the side prefix comes off. `U.toID('p1: Gholdengo')` is 'p1gholdengo',
         * which matches nothing the engine ever produced (found by section 14 of hud_check). */
        const species = slot.species || String(slot.ident || '').split(':').pop();
        const id = U.toID(species);
        if (!id) return null;
        return { kind: 'switch', id: id, name: species.trim() || id, slot: index };
      }
      return null;
    }

    /** _clearCancelAlert() — take the HUD's Cancel alert down (never throws). */
    _clearCancelAlert() {
      if (!this.hud || typeof this.hud.clearCancelAlert !== 'function') return null;
      try { return this.hud.clearCancelAlert(); } catch (e) { this._error('cancel-clear', e); return null; }
    }

    /**
     * _closePonderWindow() — a new decision window is a new question.
     *
     * Every window (a request, a `|turn|`, a new battle) bumps the monotonic id, which is what makes
     * a background pass that finished late harmless: it compares its own id against the live one and
     * publishes nothing. The lock and the alert belong to the window that is over, so they go with
     * it.
     */
    _closePonderWindow() {
      this._ponderId += 1;
      this._lockedChoice = null;
      this._clearCancelAlert();
      return this._ponderId;
    }

    /**
     * _scheduleDeepPonder(state) -> the pass id, or null.
     *
     * PASS 2 IS A SECOND READ, AND PASS 1 MUST NOT WAIT FOR IT. The HUD is already rendered from the
     * fast evaluation by the time this runs; the deeper pass is scheduled for the next tick (never
     * synchronously) so the frame that is on screen keeps its timing. Passes do NOT queue: an id is
     * taken now, and a later window (or a later request in the same turn) invalidates it.
     */
    _scheduleDeepPonder(state) {
      const plan = this._deepPonderPlan();
      if (!plan || !this.engine || !state) return null;
      if (typeof setTimeout !== 'function') return null;      // no timer: never block Pass 1 instead
      const id = ++this._ponderId;
      const self = this;
      try {
        setTimeout(function () { self._runDeepPonder(state, plan, id); }, 0);
      } catch (e) { this._error('ponder-schedule', e); return null; }
      return id;
    }

    /**
     * _runDeepPonder(state, plan, id) — the deeper read, and what to do with it.
     *
     * TWO OUTCOMES, and they are different questions:
     *   CASE A (nothing locked in, the move menu is still open): the deeper ranking simply replaces
     *     what Pass 1 rendered — same HUD, better answer.
     *   CASE B (the player already clicked: `_lockedChoice` is set and Showdown's Cancel button is on
     *     screen): the reader is committed, so the pass does not silently disagree in the HUD. It
     *     compares the locked line against the deeper top line and, when the deeper pass would have
     *     vetoed it or beats it by a margin the config names, flags the Cancel button and says why.
     *     A locked choice that the deep pass still prefers, or that it cannot resolve at all, raises
     *     nothing.
     * The pass re-reads the SAME window with `reread: true`, which is what keeps it from repeating
     * the engine's per-turn side effects (see LaplaceEngine.evaluateTurn).
     */
    _runDeepPonder(state, plan, id) {
      if (id !== this._ponderId) return null;                 // the window closed before we ran
      if (!this.engine || !state) return null;
      let ranked = [];
      try {
        ranked = this.engine.evaluateTurn(state, {
          K: plan.deepWorlds,
          reread: true,
          beam2Ply: plan.useBeam2Ply ? true : undefined
        });
      } catch (e) { this._error('ponder', e); return null; }
      if (id !== this._ponderId) return null;                 // ...or while we were running
      const readout = this.engine.lastReadout || null;
      this.stats.ponders += 1;
      const actions = Array.isArray(ranked) ? ranked.filter(Boolean) : [];
      const locked = this._lockedAction(state);
      if (!locked) {
        this.pendingReadout = readout;
        if (this.hud) {
          try { this.hud.render(actions, state, readout); } catch (e2) { this._error('ponder-render', e2); }
        }
        this.lastPonder = { window: id, updated: true, mode: 'menu-open', top: actions.length ? actions[0].name : null };
        return actions;
      }
      const info = this._compareLockedToDeep(locked, actions, plan);
      if (!info) {
        this._clearCancelAlert();
        this.lastPonder = { window: id, updated: false, mode: 'cancel-window', agreed: true, locked: locked.name };
        return actions;
      }
      this.lastPonder = { window: id, updated: false, mode: 'cancel-window', agreed: false, alert: info };
      if (this.hud && typeof this.hud.renderCancelAlert === 'function') {
        try { this.hud.renderCancelAlert(info); } catch (e) { this._error('cancel-alert', e); }
      }
      // The Cancel window is the one place the alert is worth a pulse: the advice is actionable for
      // the few seconds the button is on screen, and the player may be looking anywhere else.
      if (this._canVibrate()) this._vibrate([80, 40, 120]);
      return actions;
    }

    /**
     * _compareLockedToDeep(locked, actions, plan) -> the alert payload, or null for silence.
     *
     * Only three things can raise one, and each is a fact about the deep ranking rather than a
     * difference of opinion: the locked line is VETOED (the deep pass found a reason not to click it
     * at all), the locked line is GONE from the deeper ranking, or the deeper top line beats it by
     * the configured margin in score or confidence. A locked line that the deep pass still ranks
     * first raises nothing — the fast pass and the deep pass agree, which is the common case.
     */
    _compareLockedToDeep(locked, actions, plan) {
      const idOf = function (a) {
        if (!a || a.isVetoed) return null;
        return U.toID(a.moveId || a.name || a.targetId || '');
      };
      const best = actions.length ? actions[0] : null;
      if (!best) return null;
      const lockedId = U.toID(locked.id);
      let mine = null;
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        if (!a) continue;
        const aId = U.toID(a.moveId || a.name || a.targetId || '');
        if (aId && aId === lockedId) { mine = a; break; }
      }
      const bestId = idOf(best);
      if (bestId && bestId === lockedId) return null;          // the deeper read still wants it
      const delta = typeof best.score === 'number' && mine && typeof mine.score === 'number'
        ? best.score - mine.score : null;
      const confDelta = typeof best.confidence === 'number' && mine && typeof mine.confidence === 'number'
        ? best.confidence - mine.confidence : null;
      let reason = null;
      if (mine && mine.isVetoed) reason = 'vetoed';
      else if (!mine) reason = 'unlisted';
      else if (delta !== null && delta >= plan.cancelAlertScoreDelta) reason = 'score';
      else if (confDelta !== null && confDelta >= plan.cancelAlertConfDelta) reason = 'confidence';
      if (!reason) return null;
      const why = reason === 'vetoed'
        ? (mine.vetoReason ? 'the deeper read vetoes it: ' + mine.vetoReason : 'the deeper read vetoes it')
        : reason === 'unlisted'
          ? 'the deeper read does not offer it at all this window'
          : reason === 'score'
            ? 'a deeper search is worth ' + U.round1(delta) + ' more payoff'
            : 'the deeper search is ' + U.round1(confDelta) + ' confidence points clearer';
      return {
        locked: { id: locked.id, name: locked.name, kind: locked.kind },
        better: { id: bestId, name: best.name, kind: best.kind || 'move' },
        reason: reason,
        why: why,
        scoreDelta: delta,
        confDelta: confDelta
      };
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

    /**
     * Copy the receipt text: clipboard API first, a hidden textarea second, and an honest null when
     * neither can actually copy.
     *
     * The fallback used to copy NOTHING while reporting success: `execCommand('copy')` acts on the
     * document's CURRENT SELECTION, and a textarea that was never attached to the document and
     * never selected can never become that selection — so the button put whatever the page already
     * had selected (or nothing at all) on the clipboard, and the caller was told it worked. It now
     * attaches the field to the document, focuses and selects it, and returns the payload only when
     * execCommand reports the copy happened.
     */
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
          const host = doc.body || doc.documentElement || null;
          // Without somewhere to attach the field there is no selection to copy, so this is a
          // FAILURE rather than a silent success.
          if (!host || typeof host.appendChild !== 'function') return null;
          const area = doc.createElement('textarea');
          area.value = payload;
          host.appendChild(area);
          try {
            if (typeof area.focus === 'function') area.focus();
            if (typeof area.select === 'function') area.select();
            return doc.execCommand('copy') ? payload : null;
          } finally {
            if (typeof area.remove === 'function') area.remove();
            else if (typeof host.removeChild === 'function') host.removeChild(area);
          }
        }
      } catch (e2) { /* nothing to do */ }
      return null;
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
            if (area !== 'local' || !changes) return;
            // Team paste changed: re-parse and re-render the drawer status.
            if (changes.teamText) {
              self.parseTeam(changes.teamText.newValue || '');
              self._onTeamLoaded(self.team);
            }
            // Layout mode changed (options page saved it, or another tab flipped it). Apply
            // the new mode to the live HUD and keep the page-local mirror in sync so a reload
            // sees the same value without a second storage round trip.
            if (changes.stHudLayout && self.hud && typeof self.hud.setLayoutMode === 'function') {
              const mode = changes.stHudLayout.newValue;
              if (mode === 'auto' || mode === 'mobile' || mode === 'desktop') {
                try { window.localStorage.setItem('stHudLayout', mode); } catch (e) { /* private mode */ }
                self.hud.setLayoutMode(mode);
              }
            }
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
