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
      this.pruner = ST.ArchetypePruner ? new ST.ArchetypePruner() : null;
      this.damage = ST.DamageEngine ? new ST.DamageEngine({ gen: 9 }) : null;
      this.trickRoom = ST.TrickRoomEngine ? new ST.TrickRoomEngine(this.damage) : null;
      this.evaluator = ST.DenseStateEvaluator ? new ST.DenseStateEvaluator() : null;
      this.tempo = ST.TempoEngine ? new ST.TempoEngine({ damage: this.damage, trickRoom: this.trickRoom }) : null;
      this.veto = ST.BlunderVetoGuard ? new ST.BlunderVetoGuard({ damage: this.damage, trickRoom: this.trickRoom }) : null;
      this.sampler = ST.WorldSampler ? new ST.WorldSampler({ K: 6 }) : null;
      this.engine = ST.LaplaceEngine ? new ST.LaplaceEngine({
        sampler: this.sampler, damage: this.damage, evaluator: this.evaluator,
        tempo: this.tempo, veto: this.veto, trickRoom: this.trickRoom
      }) : null;
      this.llm = ST.LLMTactician ? new ST.LLMTactician() : null;
      this.hud = ST.MobileHUD ? new ST.MobileHUD({ doc: this.doc, state: this.state }) : null;
      this.team = null;
      this.pendingReadout = null;
      this.lastEvaluateTurn = -1;
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
      if (event.type === 'unknown' || event.type === 'init') return undefined;
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
          this.parser.speedHint = {
            mySpeed: U.computeSpeed(my, {
              item: my.currentBattleItem || my.confirmedItem || (my.liveSet && my.liveSet.item),
              ability: my.revealedAbility || (my.liveSet && my.liveSet.ability),
              boosts: my.boosts
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

    _refreshNonDecisionUi() {
      if (!this.hud || !this.state) return;
      const state = this.state.state || this.state;
      try {
        this.hud.renderBanner(state);
        this.hud.setCandidateBreakdown(state);
        if (state.field && state.field.trickRoom) {
          const left = U.clamp(state.field.trickRoomTurnsLeft || 0, 0, 5);
          if (left <= 1) {
            this.hud.renderTRChip('TR EXPIRING NEXT TURN: attack or sack your setter before it ends.', 'danger');
          }
        }
      } catch (e) { this._error('ui-refresh', e); }
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
      U.debug(message);
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
