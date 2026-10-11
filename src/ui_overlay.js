/* Showdown Tactician — src/ui_overlay.js
 * Mobile portrait HUD for Lemur Browser on a 1080x2340 (Galaxy S24 FE) viewport.
 *
 * Owns every DOM node the extension injects into play.pokemonshowdown.com:
 *   - .elo-helper-badge  : confidence tag absolutely positioned inside button[data-move]
 *   - .conf-high/.conf-mid/.conf-low/.conf-veto : confidence classes on the button itself
 *   - .tactician-banner  : pinned status bar above the battlefield
 *   - .tactician-tr-chip : fixed alert pill above the move bar
 *   - .team-drawer       : collapsible bottom-left sheet (team paste + live readouts)
 *
 * Every entry point is defensive: a missing document, a missing Showdown control bar, an
 * empty ranked array or a null battleState is a no-op, never a throw. Showdown rebuilds
 * its control bar on every turn, so injection is idempotent and keyed off data attributes.
 *
 * Styling lives in styles/overlay.css; this file only assigns the classes it defines and
 * the two inline properties Showdown's own CSS otherwise fights (absolute badge anchoring
 * and the vetoed-button treatment).
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;

  // RULE 4: the confidence thresholds, their labels and the banner separator are config, not
  // code. The DOM class names and data attributes below are the interface with overlay.css and
  // are deliberately NOT configurable. Fallbacks apply only when config.js never loaded.
  const cfg = (typeof ST.configGet === 'function')
    ? ST.configGet
    : function (path, fallback) { return fallback; };

  const BADGE_ATTR = 'data-st-badge';
  const BANNER_ATTR = 'data-st-banner';
  const CHIP_ATTR = 'data-st-tr-chip';
  const DRAWER_ATTR = 'data-st-drawer';
  const REASON_ATTR = 'data-st-reason';
  const HIDDEN_CLASS = 'tactician-hidden';

  const BADGES = {
    high: { min: cfg('hud.high', 50), cls: 'conf-high', label: cfg('hud.confidenceLabels.high', 'HIGH') },
    mid: { min: cfg('hud.mid', 25), cls: 'conf-mid', label: cfg('hud.confidenceLabels.mid', 'MID') },
    low: { min: cfg('hud.low', 0), cls: 'conf-low', label: cfg('hud.confidenceLabels.low', 'LOW') },
    veto: { min: -1, cls: 'conf-veto', label: cfg('hud.confidenceLabels.veto', 'VETO') }
  };

  const BANNER_SEP = cfg('hud.bannerSep', '  ·  ');

  function safeString(v) {
    return (v === null || v === undefined) ? '' : String(v);
  }

  function pct(conf) {
    const n = typeof conf === 'number' && conf === conf ? conf : 0;
    return U.clamp(Math.round(n), 0, 100) + '%';
  }

  class MobileHUD {
    constructor(options) {
      options = options || {};
      this.doc = options.doc || null;
      this.state = options.state || null;
      this.options = options;
      this.autoBind = options.autoBind !== false;
      this._nodes = {
        banner: null, chip: null, drawer: null, toggle: null,
        teamStatus: null, candidates: null
      };
      this._touched = [];        // [{ el, prop, previous }] inline style rollbacks
      this._lastRanked = [];
      this._lastReasonByMove = {};
      this._drawerOpen = false;
      this._bound = false;
      this.renderCount = 0;
      this.lastBadgeCount = 0;
    }

    /* ------------------------------------------------------------- dom helpers */

    _document() {
      if (this.doc) return this.doc;
      try {
        if (typeof document !== 'undefined' && document) { this.doc = document; return this.doc; }
      } catch (e) { /* no DOM (tests) */ }
      return null;
    }

    _el(tag, className, text) {
      const doc = this._document();
      if (!doc || typeof doc.createElement !== 'function') return null;
      const el = doc.createElement(tag);
      if (className) {
        el.className = className;
        if (el.classList && typeof el.classList.add === 'function') el.classList.add(className);
      }
      if (text !== undefined && text !== null) el.textContent = safeString(text);
      return el;
    }

    _qs(selector, root) {
      const doc = this._document();
      if (!doc || typeof doc.querySelector !== 'function') return null;
      try { return (root || doc).querySelector(selector); } catch (e) { return null; }
    }

    _qsa(selector, root) {
      const doc = this._document();
      if (!doc || typeof doc.querySelectorAll !== 'function') return [];
      try {
        const list = (root || doc).querySelectorAll(selector);
        if (!list) return [];
        if (Array.isArray(list)) return list;
        return Array.prototype.slice.call(list);
      } catch (e) { return []; }
    }

    _mount(node) {
      const doc = this._document();
      if (!node || !doc) return node;
      const parent = doc.body || doc.documentElement;
      if (!parent || typeof parent.appendChild !== 'function') return node;
      try { parent.appendChild(node); } catch (e) { /* detached */ }
      return node;
    }

    _rememberStyle(el, prop) {
      if (!el || !el.style) return;
      const prev = el.style[prop];
      this._touched.push({ el: el, prop: prop, previous: prev });
    }

    _findMoveButtons() {
      const list = this._qsa('button[data-move]');
      if (list.length) return list;
      // Some builds only expose name="chooseMove" with the id in the value.
      return this._qsa('.movebutton, button[name="chooseMove"]');
    }

    _moveIdOf(button) {
      if (!button) return '';
      const direct = button.getAttribute ? button.getAttribute('data-move') : null;
      if (direct) return U.toID(direct);
      const name = button.getAttribute ? button.getAttribute('name') : null;
      if (name && U.toID(name) !== 'choosemove') return U.toID(name);
      const label = button.textContent || '';
      return U.toID(label);
    }

    /* ------------------------------------------------------------- pure helpers */

    /** 'conf-high' | 'conf-mid' | 'conf-low' | 'conf-veto' — pure, no DOM. */
    confidenceClass(conf, isVetoed) {
      if (isVetoed) return BADGES.veto.cls;
      const n = typeof conf === 'number' && conf === conf ? conf : 0;
      if (n >= BADGES.high.min) return BADGES.high.cls;
      if (n >= BADGES.mid.min) return BADGES.mid.cls;
      return BADGES.low.cls;
    }

    /** Human-readable badge summary for a ranked action. */
    describeBadge(conf, isVetoed) {
      if (isVetoed) return BADGES.veto.label;
      const n = typeof conf === 'number' && conf === conf ? conf : 0;
      if (n >= BADGES.high.min) return pct(n) + ' strong';
      if (n >= BADGES.mid.min) return pct(n) + ' playable';
      return pct(n) + ' weak';
    }

    /* ------------------------------------------------------------- rendering */

    /**
     * render(ranked, battleState, readout) -> number of decorated buttons.
     * decks out Showdown's own move buttons, the pinned banner and the TR chip.
     */
    render(ranked, battleState, readout) {
      if (!this._document()) return 0;
      const actions = Array.isArray(ranked) ? ranked.filter(Boolean) : [];
      this._lastRanked = actions;
      this.renderCount++;

      const byMove = {};
      const byName = {};
      let optimal = null;
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        if (!a) continue;
        const id = U.toID(a.moveId || a.name || '');
        if (id && !byMove[id]) byMove[id] = a;
        const nm = U.toID(a.name);
        if (nm && !byName[nm]) byName[nm] = a;
        if (!optimal && !a.isVetoed && a.kind !== 'switch') optimal = a;
      }
      if (!optimal) {
        for (let i = 0; i < actions.length; i++) { if (!actions[i].isVetoed) { optimal = actions[i]; break; } }
      }

      let decorated = 0;
      const buttons = this._findMoveButtons();
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        const moveId = this._moveIdOf(btn);
        const action = byMove[moveId] || byName[moveId] || null;
        this._decorateButton(btn, action, optimal);
        if (action) decorated++;
      }
      this.lastBadgeCount = decorated;

      this.renderBanner(battleState);
      this.renderTRChip(this._chipText(battleState, readout, actions), this._chipLevel(battleState, actions));
      if (battleState) this.setCandidateBreakdown(battleState);
      return decorated;
    }

    _decorateButton(btn, action, optimal) {
      if (!btn) return;
      const vetoed = !!(action && action.isVetoed);
      const conf = action && typeof action.confidence === 'number' ? action.confidence : 0;
      const cls = action ? this.confidenceClass(conf, vetoed) : '';
      const previous = btn.getAttribute ? btn.getAttribute(BADGE_ATTR) : null;

      // Always reset our own classes so a stale turn cannot leak into the next one.
      const allCls = [BADGES.high.cls, BADGES.mid.cls, BADGES.low.cls, BADGES.veto.cls, 'st-optimal'];
      if (btn.classList && btn.classList.remove) {
        for (let i = 0; i < allCls.length; i++) btn.classList.remove(allCls[i]);
      }
      if (btn.removeAttribute) {
        btn.removeAttribute('title');
      }
      if (btn.style) {
        if (previous === null) this._rememberStyle(btn, 'opacity');
        btn.style.opacity = vetoed ? '0.5' : '';
        if (vetoed && btn.style) btn.style.textDecoration = 'line-through';
        else if (btn.style) btn.style.textDecoration = '';
      }
      if (vetoed) btn.classList && btn.classList.add(BADGES.veto.cls);
      else if (cls) btn.classList && btn.classList.add(cls);
      if (action && optimal === action) { if (btn.classList && btn.classList.add) btn.classList.add('st-optimal'); }

      if (!action) {
        // No engine opinion for this button: strip any badge we left behind.
        const stale = btn.getAttribute ? btn.getAttribute(BADGE_ATTR) : null;
        if (stale && btn.querySelector && btn.querySelector('.elo-helper-badge')) {
          const node = btn.querySelector('.elo-helper-badge');
          if (node && node.remove) node.remove();
        }
        return;
      }

      let badge = btn.querySelector ? btn.querySelector('.elo-helper-badge') : null;
      if (!badge) {
        badge = this._el('span', 'elo-helper-badge');
        if (!badge) return;
        if (badge.setAttribute) badge.setAttribute(BADGE_ATTR, '1');
        if (btn.style && (!btn.style.position || btn.style.position === '')) {
          this._rememberStyle(btn, 'position');
          btn.style.position = 'relative';
        }
        if (typeof btn.appendChild === 'function') btn.appendChild(badge);
      }
      if (badge.classList && badge.classList.remove) {
        for (let i = 0; i < allCls.length; i++) badge.classList.remove(allCls[i]);
      }
      badge.textContent = pct(conf);
      if (badge.classList && badge.classList.add) {
        badge.classList.add(this.confidenceClass(conf, vetoed));
        if (action.isOptimal) badge.classList.add('st-optimal');
      }
      if (badge.setAttribute) {
        badge.setAttribute('title', this._badgeTitle(action));
        badge.setAttribute('aria-label', this._badgeTitle(action));
      }
      const known = this._lastReasonByMove[U.toID(action.moveId || action.name)];
      if (known) this._applyReason(btn, known);
    }

    _badgeTitle(action) {
      if (!action) return '';
      const parts = [this.describeBadge(action.confidence, action.isVetoed)];
      if (action.vetoReason) parts.push('Veto: ' + action.vetoReason);
      if (action.damageHint) parts.push(action.damageHint);
      if (action.score !== undefined && action.score !== null && !action.isVetoed) {
        parts.push('score ' + U.round1(action.score));
      }
      return parts.join(' — ');
    }

    /* ------------------------------------------------------------- banner */

    /**
     * renderBanner(info) — accepts a BattleState, a plain info object or a string.
     * Shows: TR timer, opponent set identity, confirmed item, speed floor.
     */
    renderBanner(info) {
      if (!this._document()) return null;
      const banner = this._ensureBanner();
      if (!banner) return null;
      const text = typeof info === 'string' ? info : this._bannerText(info);
      banner.textContent = text;
      banner.setAttribute && banner.setAttribute('data-turn', safeString(info && info.turn ? info.turn : ''));
      return banner;
    }

    _ensureBanner() {
      if (this._nodes.banner) return this._nodes.banner;
      const existing = this._qs('.tactician-banner');
      if (existing) { this._nodes.banner = existing; return existing; }
      const el = this._el('div', 'tactician-banner');
      if (!el) return null;
      if (el.setAttribute) { el.setAttribute(BANNER_ATTR, '1'); el.setAttribute('role', 'status'); }
      this._nodes.banner = this._mount(el);
      return this._nodes.banner;
    }

    _bannerText(state) {
      if (!state) return 'Showdown Tactician — waiting for a battle';
      if (state.formatSupported === false) {
        return 'Unsupported format' + (state.format ? ': ' + state.format : '') +
          BANNER_SEP + 'engine idle (National Dex OU only)';
      }
      const parts = [];
      const field = state.field || {};
      if (field.trickRoom) parts.push('TR ' + U.clamp(field.trickRoomTurnsLeft || 0, 0, 5) + '/5');
      else parts.push('TR off');

      const opp = (state.active && state.active.opp) ||
        (state.oppTeam && state.oppTeam.length ? state.oppTeam[0] : null);
      if (opp) {
        let ident = opp.species || opp.id || 'unknown';
        if (U.isMegaStone(opp.confirmedItem || opp.currentBattleItem)) ident += ' (Mega)';
        parts.push('Opp: ' + ident);
        const set = opp.liveSet || (opp.candidateSets && opp.candidateSets.length ? opp.candidateSets[0] : null);
        if (set) {
          const ev = set.evs || {};
          const spreadHint = 'ATK ' + safeString(ev.atk || 0) + ' / SPE ' + safeString(ev.spe || 0);
          parts.push(safeString(set.role || 'set') + (set.item ? ' @ ' + set.item : ' (itemless)') + ' [' + spreadHint + ']');
        }
        const item = opp.confirmedItem ? ('Item: ' + opp.confirmedItem) :
          (opp.currentBattleItem ? ('Item?: ' + opp.currentBattleItem) : 'Item: unknown');
        parts.push(item);
        if (opp.speedFloor) parts.push('Speed ≥ ' + safeString(opp.speedFloor));
        if (opp.cannotBeChoice) parts.push('no Choice');
        if (opp.boosterActive) parts.push('Booster active');
        if (opp.itemless) parts.push('itemless');
      }
      const haz = field.hazards || {};
      if (haz.p2 && (haz.p2.rocks || haz.p2.spikes)) {
        parts.push('Their hazards: ' + this._hazardText(haz.p2));
      }
      return parts.filter(Boolean).join(BANNER_SEP);
    }

    _hazardText(h) {
      const out = [];
      if (!h) return 'none';
      if (h.rocks) out.push('SR');
      if (h.spikes) out.push('Spikes x' + h.spikes);
      if (h.toxicspikes) out.push('TSP x' + h.toxicspikes);
      if (h.stickyweb) out.push('Web');
      return out.length ? out.join('+') : 'none';
    }

    /* ------------------------------------------------------------- TR chip */

    /** renderTRChip(text, level) — level is 'info' | 'warn' | 'danger'. */
    renderTRChip(text, level) {
      if (!this._document()) return null;
      const chip = this._ensureChip();
      if (!chip) return null;
      if (!text) {
        chip.classList && chip.classList.add(HIDDEN_CLASS);
        if (chip.style) chip.style.display = 'none';
        return chip;
      }
      chip.textContent = safeString(text);
      const lv = level || 'info';
      if (chip.classList) {
        chip.classList.remove(HIDDEN_CLASS, 'tr-info', 'tr-warn', 'tr-danger');
        chip.classList.add('tr-' + lv);
      }
      if (chip.style) chip.style.display = '';
      if (chip.setAttribute) chip.setAttribute('data-level', lv);
      return chip;
    }

    _ensureChip() {
      if (this._nodes.chip) return this._nodes.chip;
      const existing = this._qs('.tactician-tr-chip');
      if (existing) { this._nodes.chip = existing; return existing; }
      const el = this._el('div', 'tactician-tr-chip tr-info');
      if (!el) return null;
      if (el.setAttribute) { el.setAttribute(CHIP_ATTR, '1'); el.setAttribute('role', 'alert'); }
      this._nodes.chip = this._mount(el);
      return this._nodes.chip;
    }

    _chipText(state, readout, actions) {
      if (!state) return '';
      const field = state.field || {};
      const alerts = [];
      if (field.trickRoom) {
        const left = U.clamp(field.trickRoomTurnsLeft || 0, 0, 5);
        if (left <= 1) alerts.push('TR EXPIRING NEXT TURN: attack or sack setter, do not hard-switch healthy breakers');
      }
      const tempo = (readout && (readout.tempo || readout.tempoVector)) || state.__tempo || null;
      const v4 = tempo && typeof tempo.v4 === 'number' ? tempo.v4 : null;
      if (v4 !== null && v4 > 0.7) {
        alerts.push('Bunker rhythm predicted (' + Math.round(v4 * 100) + '%) — consider Protect or a setup move');
      }
      const best = actions && actions.length ? actions[0] : null;
      if (best && best.isVetoed && actions.length > 1) {
        const fallback = actions.filter(function (a) { return !a.isVetoed; })[0];
        if (fallback) alerts.push('Top line vetoed — play ' + safeString(fallback.name));
      }
      return alerts.join(' — ');
    }

    _chipLevel(state, actions) {
      if (!state) return 'info';
      const field = state.field || {};
      if (field.trickRoom && (field.trickRoomTurnsLeft || 0) <= 1) return 'danger';
      if (actions && actions.length && actions[0] && actions[0].isVetoed) return 'warn';
      return 'info';
    }

    /* ------------------------------------------------------------- drawer */

    /** bindDrawer() — inject the 48x48 toggle plus the slide-up sheet. Idempotent. */
    bindDrawer() {
      if (!this._document()) return null;
      if (this._bound && this._nodes.drawer) return this._nodes.drawer;
      const existing = this._qs('.team-drawer');
      if (existing && this._isDrawerNode(existing)) {
        this._nodes.drawer = existing;
        this._nodes.toggle = this._qs('.team-drawer-toggle');
        this._nodes.teamStatus = this._qs('[data-st-team-status]') || this._qs('.drawer-team-status');
        this._nodes.candidates = this._qs('[data-st-candidates]') || this._qs('.drawer-candidates');
        this._bound = true;
        return existing;
      }

      const toggle = this._el('button', 'team-drawer-toggle');
      if (toggle) {
        toggle.textContent = 'TAC';
        if (toggle.setAttribute) {
          toggle.setAttribute('type', 'button');
          toggle.setAttribute('aria-label', 'Toggle Showdown Tactician panel');
          toggle.setAttribute(DRAWER_ATTR, 'toggle');
        }
      }

      const panel = this._el('div', 'team-drawer ' + HIDDEN_CLASS);
      if (panel && panel.setAttribute) panel.setAttribute(DRAWER_ATTR, '1');

      if (panel) {
        const header = this._el('div', 'drawer-header', 'Showdown Tactician');
        if (header) panel.appendChild(header);        const teamStatus = this._el('div', 'drawer-team-status', 'No team loaded — paste a Pokepaste below.');
        if (teamStatus) {
          teamStatus.setAttribute && teamStatus.setAttribute('data-st-team-status', '1');
          panel.appendChild(teamStatus);
        }
        this._nodes.teamStatus = teamStatus;

        const textarea = this._el('textarea', 'drawer-team-input');
        if (textarea) {
          textarea.setAttribute && textarea.setAttribute('rows', '8');
          textarea.setAttribute && textarea.setAttribute('placeholder', 'Great Tusk @ Choice Scarf\nAbility: Protosynthesis\nEVs: 252 Atk / 4 SpD / 252 Spe\nJolly Nature\n- Headlong Rush\n- Close Combat\n- Ice Spinner\n- Rapid Spin');
          textarea.value = this._loadTeam();
          panel.appendChild(textarea);
        }

        const saveRow = this._el('div', 'drawer-actions');
        if (saveRow) {
          const save = this._el('button', 'drawer-save', 'Save Team');
          if (save) {
            save.setAttribute && save.setAttribute('type', 'button');
            save.addEventListener && save.addEventListener('click', function () {
              const input = this._qs('.drawer-team-input');
              const value = input && typeof input.value === 'string' ? input.value : '';
              this.saveTeam(value);
            }.bind(this));
            saveRow.appendChild(save);
          }
          const close = this._el('button', 'drawer-close', 'Close');
          if (close) {
            close.setAttribute && close.setAttribute('type', 'button');
            close.addEventListener && close.addEventListener('click', this.toggleDrawer.bind(this, false));
            saveRow.appendChild(close);
          }
          panel.appendChild(saveRow);
        }

        const candidates = this._el('div', 'drawer-candidates');
        if (candidates) {
          candidates.setAttribute && candidates.setAttribute('data-st-candidates', '1');
          panel.appendChild(candidates);
        }
        this._nodes.candidates = candidates;
      }

      this._nodes.toggle = this._mount(toggle);
      this._nodes.drawer = this._mount(panel);
      if (toggle && toggle.addEventListener) {
        toggle.addEventListener('click', this.toggleDrawer.bind(this));
      }
      this._bound = true;
      return this._nodes.drawer;
    }

    /**
     * Is this node really the drawer panel? '.team-drawer' is a prefix of
     * '.team-drawer-toggle', so adoption is keyed off the data attribute first and only
     * falls back to an exact class-token check.
     */
    _isDrawerNode(el) {
      if (!el || typeof el.getAttribute !== 'function') return false;
      if (el.getAttribute(DRAWER_ATTR) === '1') return true;
      return !!(el.classList && typeof el.classList.contains === 'function' &&
        el.classList.contains('team-drawer'));
    }

    toggleDrawer(force) {
      const panel = this._nodes.drawer || this._qs('.team-drawer');
      if (!panel) return false;
      this._nodes.drawer = panel;
      const next = typeof force === 'boolean' ? force : !this._drawerOpen;
      this._drawerOpen = next;
      if (panel.classList) {
        if (next) panel.classList.remove(HIDDEN_CLASS);
        else panel.classList.add(HIDDEN_CLASS);
        if (next) panel.classList.add('open');
        else panel.classList.remove('open');
      }
      if (panel.setAttribute) panel.setAttribute('data-open', next ? 'true' : 'false');
      const toggle = this._nodes.toggle || this._qs('.team-drawer-toggle');
      if (toggle && toggle.classList) {
        if (next) toggle.classList.add('active');
        else toggle.classList.remove('active');
      }
      return next;
    }

    /** setTeamStatus(summary) — accepts a string or a summary object. */
    setTeamStatus(summary) {
      const row = this._nodes.teamStatus ||
        this._qs('[data-st-team-status]') || this._qs('.drawer-team-status');
      if (!row) return null;
      this._nodes.teamStatus = row;
      let text;
      if (typeof summary === 'string') text = summary;
      else if (summary && typeof summary === 'object') {
        const total = typeof summary.total === 'number' ? summary.total : (Array.isArray(summary.pokemon) ? summary.pokemon.length : 0);
        const tr = Array.isArray(summary.trMons) ? summary.trMons.length : (typeof summary.tr === 'number' ? summary.tr : 0);
        const bits = [total + '/6 confirmed'];
        bits.push(tr ? (tr + ' Trick Room set' + (tr === 1 ? '' : 's') + (summary.trNames && summary.trNames.length ? ': ' + summary.trNames.join(', ') : '')) : 'no 0 Spe-IV sets');
        if (summary.name) bits.unshift(summary.name);
        if (summary.errors && summary.errors.length) bits.push(summary.errors.length + ' parse warning(s)');
        text = bits.join(' · ');
      } else {
        text = '';
      }
      row.textContent = text;
      return row;
    }

    /** Live opponent candidate-set breakdown in the drawer. */
    setCandidateBreakdown(battleState) {
      const row = this._nodes.candidates ||
        this._qs('[data-st-candidates]') || this._qs('.drawer-candidates');
      if (!row || !battleState) return null;
      this._nodes.candidates = row;
      const lines = [];
      const opp = battleState.oppTeam || [];
      for (let i = 0; i < opp.length; i++) {
        const mon = opp[i];
        if (!mon) continue;
        const sets = mon.candidateSets || [];
        const best = mon.liveSet || sets[0] || null;
        const head = (mon.species || mon.id) + (mon.fainted ? ' (fainted)' : '');
        const detail = best
          ? (safeString(best.role || 'set') + (best.item ? ' @ ' + best.item : ' (itemless)') + '  w=' + U.round2(best.weight || 0))
          : 'no surviving candidate set';
        lines.push(head + ' — ' + detail + '  [' + sets.length + ' candidate' + (sets.length === 1 ? '' : 's') + ']');
        if (mon.prunedReasons && mon.prunedReasons.length) {
          lines.push('   pruned: ' + mon.prunedReasons.slice(0, 3).join('; '));
        }
      }
      if (battleState.formatLocks) {
        const locks = battleState.formatLocks;
        lines.push('locks: mega=' + (locks.oppHasMegaEvolved ? 'spent' : 'live') + ', z=' + (locks.oppHasUsedZMove ? 'spent' : 'live') + ', tera=banned');
      }
      row.textContent = lines.length ? lines.join('\n') : 'No opponent information yet.';
      return row;
    }

    /* ------------------------------------------------------------- llm bridge */

    /** updateLLMReason(moveName, reason) — patches the badge/tooltip after the fact. */
    updateLLMReason(moveName, reason) {
      const text = safeString(reason).trim();
      const key = U.toID(moveName || '');
      this._lastReasonByMove[key] = text;
      if (!this._document()) return 0;
      const buttons = this._findMoveButtons();
      let patched = 0;
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        if (this._moveIdOf(btn) !== key) continue;
        this._applyReason(btn, text);
        patched++;
      }
      return patched;
    }

    _applyReason(btn, reason) {
      if (!btn) return;
      const badge = (btn.querySelector && btn.querySelector('.elo-helper-badge')) || null;
      if (badge && badge.setAttribute && reason) badge.setAttribute('title', reason);
      if (btn.setAttribute && reason) btn.setAttribute('title', reason);
      let node = btn.querySelector ? btn.querySelector('.elo-helper-reason') : null;
      if (!reason) {
        if (node && node.remove) node.remove();
        return;
      }
      if (!node) {
        node = this._el('span', 'elo-helper-reason');
        if (!node) return;
        if (node.setAttribute) node.setAttribute(REASON_ATTR, '1');
        if (typeof btn.appendChild === 'function') btn.appendChild(node);
      }
      node.textContent = reason;
    }

    /* ------------------------------------------------------------- persistence */

    /** Writes the team paste to chrome.storage.local (or localStorage) under teamText. */
    saveTeam(text) {
      const value = safeString(text);
      this.setTeamStatus(value.trim() ? 'Team paste saved — ' + value.split('\n').length + ' lines' : 'Team paste cleared.');
      const done = { ok: true, value: value };
      try {
        if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ teamText: value });
          return done;
        }
      } catch (e) { /* fall through to localStorage */ }
      try {
        if (typeof localStorage !== 'undefined' && localStorage) localStorage.setItem('teamText', value);
        else if (this._docHasStorage()) this._document().defaultView.localStorage.setItem('teamText', value);
      } catch (e2) { /* storage unavailable — non-fatal */ }
      return done;
    }

    _docHasStorage() {
      const doc = this._document();
      return !!(doc && doc.defaultView && doc.defaultView.localStorage);
    }

    _loadTeam() {
      try {
        const doc = this._document();
        if (doc && doc.defaultView && doc.defaultView.localStorage) {
          const v = doc.defaultView.localStorage.getItem('teamText');
          if (typeof v === 'string') return v;
        }
      } catch (e) { /* ignore */ }
      try {
        if (typeof localStorage !== 'undefined' && localStorage) {
          const v = localStorage.getItem('teamText');
          if (typeof v === 'string') return v;
        }
      } catch (e2) { /* ignore */ }
      return '';
    }

    /* ------------------------------------------------------------- teardown */

    /** clear() — remove every injected node and inline style change. */
    clear() {
      const nodes = this._qsa('.elo-helper-badge, .tactician-banner, .tactician-tr-chip, .team-drawer, .team-drawer-toggle, .elo-helper-reason');
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n && typeof n.remove === 'function') n.remove();
      }
      const buttons = this._findMoveButtons();
      const cls = [BADGES.high.cls, BADGES.mid.cls, BADGES.low.cls, BADGES.veto.cls, 'st-optimal'];
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        if (btn && btn.classList && btn.classList.remove) {
          for (let j = 0; j < cls.length; j++) btn.classList.remove(cls[j]);
        }
        if (btn && btn.removeAttribute) {
          btn.removeAttribute('title');
          btn.removeAttribute(BADGE_ATTR);
        }
        if (btn && btn.style) { btn.style.opacity = ''; btn.style.textDecoration = ''; }
      }
      for (let i = 0; i < this._touched.length; i++) {
        const t = this._touched[i];
        if (t && t.el && t.el.style) {
          try { t.el.style[t.prop] = t.previous === undefined ? '' : t.previous; } catch (e) { /* ignore */ }
        }
      }
      this._touched = [];
      this._nodes = {
        banner: null, chip: null, drawer: null, toggle: null,
        teamStatus: null, candidates: null
      };
      this._drawerOpen = false;
      this._bound = false;
      this.lastBadgeCount = 0;
      return true;
    }
  }

  MobileHUD.BADGES = BADGES;
  MobileHUD.VETO_REASON_ATTR = REASON_ATTR;

  ST.MobileHUD = MobileHUD;
})();
