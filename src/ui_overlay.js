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
  // Bench-tap sandbox, lethal-roll gauges, deduction badges, the match receipt and the
  // Supreme Overlord gauge. These attributes and classes are the interface with overlay.css and
  // with tests/hud_check.js — they are deliberately NOT configurable.
  const LETHAL_ATTR = 'data-st-lethal';
  const LETHAL_BAR_ATTR = 'data-st-lethal-bar';
  const BENCH_ATTR = 'data-st-bench-strip';
  const BENCH_PILL_ATTR = 'data-st-bench';
  const BADGE_ROW_ATTR = 'data-st-badge-row';
  const DEDUCTION_ATTR = 'data-st-deduction';
  const RECEIPT_ATTR = 'data-st-receipt';
  const OVERLORD_ATTR = 'data-st-overlord';
  // The two "sweaty" readouts: the PP-stall gauge and the Z-Move / Mega Trap sentinel bar. As
  // above, these attribute and class names are the interface with overlay.css and with the
  // regression suite, so they are deliberately NOT configurable.
  const PP_ATTR = 'data-st-pp';
  const SENTINEL_ATTR = 'data-st-sentinel';
  const SENTINEL_ICONS = { burned: '\u274C', live: '\uD83D\uDFE2' };
  // The glyph on each "TACTICAL FREEDOM" bullet, keyed by the engine's `kind`. The engine names
  // the tactic and the renderer chooses how it looks, so the two never disagree about a character
  // the engine had to guess at. An unknown kind falls back to a plain bullet.
  const SENTINEL_TACTIC_ICONS = {
    mega: '\u2705', z: '\u2705', freedom: '\uD83D\uDFE2', live: '\u26A0'
  };
  const TACTIC_BULLET = '\u2022';
  const PP_ICON = '\u23F1';
  const THREAT_ICON = '\u26A0';
  // hud.lethal bands -> the class each one paints (see the lethal block in overlay.css).
  const LETHAL_BANDS = ['guaranteed', 'high', 'mid', 'none'];

  /** 'guaranteed' | 'high' | 'mid' | 'none' — anything unknown degrades to 'none'. */
  function bandOf(lethal) {
    const b = safeString(lethal).toLowerCase();
    return LETHAL_BANDS.indexOf(b) === -1 ? 'none' : b;
  }

  function roundPct(v) {
    return typeof v === 'number' && v === v ? Math.round(v) : 0;
  }

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
        teamStatus: null, candidates: null,
        benchStrip: null, badgeRow: null, receipt: null, overlord: null,
        ppGauge: null, sentinel: null
      };
      this._touched = [];        // [{ el, prop, previous }] inline style rollbacks
      this._lastRanked = [];
      this._lastReasonByMove = {};
      this._drawerOpen = false;
      this._bound = false;
      this._benchBound = false;   // the strip's delegated listener is attached at most once
      this._receiptText = null;   // text behind the receipt's Copy button
      this.selectedBenchId = null; // which bench pill is currently selected ('' = the active mon)
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
        // DOMTokenList.add throws InvalidCharacterError on a MULTI-token string, and this helper
        // is called with compound classes ('tactician-tr-chip tr-info', 'team-drawer
        // tactician-hidden'). In a real browser that exception escaped renderTRChip on its very
        // first call, so the TR chip never appeared at all — the stub DOM in the test harness
        // keeps a plain Set and never noticed. One token at a time, and a guard for the
        // classList-less stub.
        if (el.classList && typeof el.classList.add === 'function') {
          const tokens = String(className).split(/\s+/);
          for (let i = 0; i < tokens.length; i++) {
            if (tokens[i]) { try { el.classList.add(tokens[i]); } catch (e) { /* invalid token */ } }
          }
        }
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

    /**
     * Remember an inline property's ORIGINAL value so clear() can put it back.
     *
     * Recorded exactly once per (element, property). Recording on every call looked harmless
     * and was not: clear() replays this list in order, so an entry captured on a later call
     * holds a value WE wrote (a veto's `opacity: 0.5`), and that replay overwrote the true
     * original — a cleared button stayed struck through. The list also grew by one entry per
     * button per render, for the life of the battle.
     *
     * Compaction keeps the list bounded by the LIVE DOM. Showdown throws its control bar away
     * and rebuilds it constantly, so without this every turn would strand four detached button
     * nodes here forever. A node that has left the document has nothing left to restore, so
     * dropping its entry loses nothing.
     */
    _rememberStyle(el, prop) {
      if (!el || !el.style) return;
      for (let i = 0; i < this._touched.length; i++) {
        const t = this._touched[i];
        if (t.el === el && t.prop === prop) return;
      }
      if (this._touched.length > 256) {
        this._touched = this._touched.filter(function (t) {
          // `isConnected` is undefined in the Node harness's stub elements, where nothing is
          // ever detached — so an absent flag must count as "still live", not as "gone".
          return !t.el || t.el.isConnected === undefined || t.el.isConnected;
        });
      }
      this._touched.push({ el: el, prop: prop, previous: el.style[prop] });
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

      // Always reset our own classes so a stale turn cannot leak into the next one.
      const allCls = [BADGES.high.cls, BADGES.mid.cls, BADGES.low.cls, BADGES.veto.cls, 'st-optimal'];
      if (btn.classList && btn.classList.remove) {
        for (let i = 0; i < allCls.length; i++) btn.classList.remove(allCls[i]);
      }
      if (btn.removeAttribute) {
        btn.removeAttribute('title');
      }
      if (btn.style) {
        this._rememberStyle(btn, 'opacity');
        this._rememberStyle(btn, 'textDecoration');
        btn.style.opacity = vetoed ? '0.5' : '';
        if (vetoed && btn.style) btn.style.textDecoration = 'line-through';
        else if (btn.style) btn.style.textDecoration = '';
      }
      if (vetoed) btn.classList && btn.classList.add(BADGES.veto.cls);
      else if (cls) btn.classList && btn.classList.add(cls);
      if (action && optimal === action) { if (btn.classList && btn.classList.add) btn.classList.add('st-optimal'); }

      if (!action) {
        // No engine opinion for this button: strip any badge we left behind.
        //
        // The guard used to read data-st-badge off the BUTTON, but that attribute is set on the
        // BADGE (see below), so the test was never true and the branch never ran. A button the
        // engine has no opinion about — a move the request no longer lists, a label that does
        // not resolve to an action — kept whatever badge an earlier turn had put on it.
        const stale = btn.querySelector ? btn.querySelector('.elo-helper-badge') : null;
        if (stale && stale.remove) stale.remove();
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

    /** renderTRChip(text, level) — level is 'info' | 'warn' | 'danger' | 'gold' (the last
     *  Trick Room turn, the one that also fires the haptic pulse in src/content.js). */
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
        chip.classList.remove(HIDDEN_CLASS, 'tr-info', 'tr-warn', 'tr-danger', 'tr-gold');
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

    /* ------------------------------------- bench-tap sandbox & lethal gauges */

    /** Guarded classList helpers: the stub DOM the tests drive has no classList at all. */
    _addClass(el, cls) {
      if (!el || !cls || !el.classList || typeof el.classList.add !== 'function') return;
      try { el.classList.add(cls); } catch (e) { /* invalid token / stub */ }
    }

    _removeClass(el, cls) {
      if (!el || !cls || !el.classList || typeof el.classList.remove !== 'function') return;
      try { el.classList.remove(cls); } catch (e) { /* stub */ }
    }

    /**
     * A child by class name, found through querySelector AND through `children`.
     * The fallback matters: the Node test harness's fake element answers every querySelector
     * with null, so a node created by a previous call would look absent and be appended twice.
     */
    _findChild(el, className) {
      if (!el || !className) return null;
      if (typeof el.querySelector === 'function') {
        try {
          const hit = el.querySelector('.' + className);
          if (hit) return hit;
        } catch (e) { /* stub */ }
      }
      const kids = el.children || [];
      for (let i = 0; i < kids.length; i++) {
        const kid = kids[i];
        if (!kid) continue;
        const tokens = safeString(kid.className).split(/\s+/);
        if (tokens.indexOf(className) !== -1) return kid;
      }
      return null;
    }

    _clearChildren(el) {
      if (!el || !el.children || typeof el.removeChild !== 'function') return el;
      while (el.children.length) el.removeChild(el.children[0]);
      return el;
    }

    _dropNode(el) {
      if (el && typeof el.remove === 'function') el.remove();
      return null;
    }

    /** appendChild, guarded for the classList-less stub elements the tests drive. */
    _appendChild(parent, child) {
      if (!parent || !child) return false;
      if (typeof parent.appendChild !== 'function') return false;
      try { parent.appendChild(child); return true; } catch (e) { return false; }
    }

    /**
     * renderMovePreviews(preview) -> number of buttons decorated.
     *
     * The bench-tap sandbox's output: every move button gains a colour-coded lethal bar for the
     * target currently being previewed — the opponent's active mon by default, one of their
     * benched mons after a tap. `null` strips every bar, so a button can never advertise numbers
     * from a previous turn or from a target that is no longer selected.
     *
     * preview = { target: { species, id, isActive },
     *             lines: [ { moveId, name, minPercent, maxPercent, koChancePct,
     *                        lethal: 'guaranteed'|'high'|'mid'|'none', verdict } ] }
     */
    renderMovePreviews(preview) {
      if (!this._document()) return 0;
      const buttons = this._findMoveButtons();
      const lines = (preview && Array.isArray(preview.lines)) ? preview.lines : [];
      const claimed = [];
      for (let i = 0; i < lines.length; i++) claimed.push(false);
      const match = [];

      // Pass 1 — the button's own move id (Showdown always sets `data-move`, and that is what
      // `_moveIdOf` reads). It must win over everything below.
      for (let b = 0; b < buttons.length; b++) {
        const btn = buttons[b];
        const moveId = btn ? this._moveIdOf(btn) : '';
        let found = -1;
        if (preview && moveId) {
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (claimed[i] || !line) continue;
            const id = U.toID(line.moveId || line.name || '');
            const nm = U.toID(line.name || '');
            if (id === moveId || nm === moveId) { found = i; break; }
          }
        }
        if (found !== -1) claimed[found] = true;
        match.push(found);
      }

      // Pass 2 — a button carrying NO id at all (a control-bar control we cannot identify, and
      // the shape a bare stub-DOM button has) is paired with the next unclaimed line in order.
      // The safe reading: the request's move order IS the order `LaplaceEngine.getMyActions`
      // produced the lines in, and this pass never touches a button that named itself.
      if (preview) {
        let cursor = 0;
        for (let b = 0; b < buttons.length; b++) {
          const btn = buttons[b];
          if (!btn || match[b] !== -1 || this._moveIdOf(btn)) continue;
          while (cursor < lines.length && claimed[cursor]) cursor++;
          if (cursor < lines.length) {
            match[b] = cursor;
            claimed[cursor] = true;
            cursor++;
          }
        }
      }

      let decorated = 0;
      for (let b = 0; b < buttons.length; b++) {
        const btn = buttons[b];
        if (!btn) continue;
        const line = match[b] === -1 || match[b] === undefined ? null : lines[match[b]];
        if (line) decorated++;
        this._decoratePreviewButton(btn, line || null, preview);
      }
      return decorated;
    }

    _decoratePreviewButton(btn, line, preview) {
      for (let i = 0; i < LETHAL_BANDS.length; i++) this._removeClass(btn, 'st-lethal-' + LETHAL_BANDS[i]);
      const bar = this._findChild(btn, 'st-lethal-bar');
      if (!line) {
        // No preview for this button: keep its confidence/veto classes, drop ours.
        if (btn.removeAttribute) btn.removeAttribute(LETHAL_ATTR);
        this._dropNode(bar);
        return;
      }
      const band = bandOf(line.lethal);
      this._addClass(btn, 'st-lethal-' + band);
      if (btn.setAttribute) btn.setAttribute(LETHAL_ATTR, band);

      const min = roundPct(line.minPercent);
      const max = roundPct(line.maxPercent);
      const verdict = safeString(line.verdict).trim();
      const target = (preview && preview.target) || {};
      let node = bar;
      if (!node) {
        node = this._el('span', 'st-lethal-bar');
        if (!node) return;
        if (node.setAttribute) node.setAttribute(LETHAL_BAR_ATTR, '1');
        if (typeof btn.appendChild === 'function') btn.appendChild(node);
      }
      node.textContent = min + '\u2013' + max + '%' + (verdict ? ' (' + verdict + ')' : '');
      if (node.setAttribute) {
        node.setAttribute('title', safeString(target.species) + ': ' + min + '-' + max + '% vs ' +
          safeString(line.name) + (line.koChancePct ? ' (' + U.round1(line.koChancePct) + '% KO)' : ''));
      }
    }

    /**
     * renderBenchTargets(targets, selectedId) -> the strip element (or null).
     * The opponent's bench as tappable pills: tap one and the move buttons re-preview against
     * THAT mon, which is the whole point of the sandbox ("what does my Fire Punch do to the
     * Corviknight that is about to come in?"). An empty list removes the strip.
     */
    renderBenchTargets(targets, selectedId) {
      if (!this._document()) return null;
      const list = Array.isArray(targets) ? targets.filter(Boolean) : [];
      if (!list.length) return this.clearBenchTargets();
      const cap = cfg('hud.benchStripMax', 6);
      let strip = this._nodes.benchStrip || this._qs('.st-bench-strip');
      if (!strip) {
        strip = this._el('div', 'st-bench-strip');
        if (!strip) return null;
        if (strip.setAttribute) strip.setAttribute(BENCH_ATTR, '1');
        strip = this._mount(strip);
      }
      this._nodes.benchStrip = strip;
      this.selectedBenchId = (selectedId === undefined || selectedId === null) ? '' : safeString(selectedId);
      this._clearChildren(strip);
      const count = Math.min(list.length, cap > 0 ? cap : list.length);
      for (let i = 0; i < count; i++) {
        const target = list[i];
        const id = U.toID(target.id || target.species || '');
        const pill = this._el('button', 'st-bench-pill');
        if (!pill) continue;
        if (pill.setAttribute) {
          pill.setAttribute('type', 'button');
          pill.setAttribute(BENCH_PILL_ATTR, id);
          pill.setAttribute('aria-label', 'Preview our moves against ' + safeString(target.species));
        }
        pill.textContent = safeString(target.species) + ' ' + roundPct(target.hpPercent) + '%';
        if (target.fainted) this._addClass(pill, 'st-fainted');
        if (id && id === this.selectedBenchId) this._addClass(pill, 'st-selected');
        if (typeof strip.appendChild === 'function') strip.appendChild(pill);
      }
      this.bindBenchTargets();
      return strip;
    }

    clearBenchTargets() {
      const strip = this._nodes.benchStrip || this._qs('.st-bench-strip');
      this._nodes.benchStrip = null;
      this.selectedBenchId = null;
      this._benchBound = false;
      return this._dropNode(strip);
    }

    /**
     * benchTapped(id) -> true when a handler consumed the tap.
     * Called by the delegated listener below AND directly by callers/tests that have no event
     * system (the harness's fake element has no dispatch).
     */
    benchTapped(id) {
      this.selectedBenchId = safeString(id);
      if (typeof this.options.onBenchTap === 'function') {
        try { this.options.onBenchTap(this.selectedBenchId); return true; }
        catch (e) { return false; }
      }
      return false;
    }

    /** One delegated click listener on the strip. A no-op when events are unavailable. */
    bindBenchTargets() {
      const strip = this._nodes.benchStrip;
      if (!strip) return false;
      if (this._benchBound) return true;
      if (typeof strip.addEventListener !== 'function') return false;
      const self = this;
      try {
        strip.addEventListener('click', function (evt) {
          const target = (evt && evt.target) || null;
          let pill = target;
          if (target && typeof target.closest === 'function') {
            pill = target.closest('[' + BENCH_PILL_ATTR + ']') || target;
          }
          const id = pill && pill.getAttribute ? pill.getAttribute(BENCH_PILL_ATTR) : null;
          if (id) self.benchTapped(id);
        });
      } catch (e) { return false; }
      this._benchBound = true;
      return true;
    }

    /* ------------------------------------------------ the "detective" badges */

    /**
     * renderDeductionBadges(badges) -> the row element (or null).
     * The deductions we have actually PROVEN, shown over the opponent's card: a confirmed item,
     * a broken Choice lock, a spent format mechanic. `cls` is 'unmasked' | 'choice-broken' |
     * 'lockout' (each has its own accent in overlay.css). An empty list removes the row.
     * The badge TEXT is the engine's (src/content.js) — this only renders it.
     */
    renderDeductionBadges(badges) {
      if (!this._document()) return null;
      const list = Array.isArray(badges) ? badges.filter(Boolean) : [];
      if (!list.length) return this.clearDeductionBadges();
      let row = this._nodes.badgeRow || this._qs('.st-badge-row');
      if (!row) {
        row = this._el('div', 'st-badge-row');
        if (!row) return null;
        if (row.setAttribute) row.setAttribute(BADGE_ROW_ATTR, '1');
        row = this._mount(row);
      }
      this._nodes.badgeRow = row;
      this._clearChildren(row);
      for (let i = 0; i < list.length; i++) {
        const badge = list[i];
        const span = this._el('span', 'st-unmask-badge');
        if (!span) continue;
        this._addClass(span, 'st-' + (safeString(badge.cls) || 'unmasked'));
        if (span.setAttribute) {
          span.setAttribute(DEDUCTION_ATTR, safeString(badge.id));
          span.setAttribute('title', safeString(badge.detail));
        }
        span.textContent = safeString(badge.label);
        if (typeof row.appendChild === 'function') row.appendChild(span);
      }
      return row;
    }

    clearDeductionBadges() {
      const row = this._nodes.badgeRow || this._qs('.st-badge-row');
      this._nodes.badgeRow = null;
      return this._dropNode(row);
    }

    /* ------------------------------------------------------ the match receipt */

    /**
     * renderReceipt(receipt) -> the card element (or null).
     * The post-match summary card (`|win|`/`|tie|`). `null` removes it. The card remembers the
     * text behind its Copy button so copyReceipt() does not have to re-derive anything.
     */
    renderReceipt(receipt) {
      if (!this._document()) return null;
      if (!receipt || typeof receipt !== 'object') return this.dismissReceipt();
      const card = this._el('div', 'st-receipt-card');
      if (!card) return null;
      if (card.setAttribute) card.setAttribute(RECEIPT_ATTR, '1');
      const title = this._el('h3', 'st-receipt-title', receipt.title);
      if (title) card.appendChild(title);
      const headline = this._el('div', 'st-receipt-headline', receipt.headline);
      if (headline) card.appendChild(headline);
      const rows = Array.isArray(receipt.rows) ? receipt.rows : [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r) continue;
        const row = this._el('div', 'st-receipt-row');
        if (!row) continue;
        row.textContent = safeString(r.icon) + ' ' + safeString(r.label) + ': ' + safeString(r.value);
        card.appendChild(row);
      }
      const copy = this._el('button', 'st-receipt-copy', cfg('hud.receipt.copyLabel', 'Copy Summary'));
      if (copy) {
        if (copy.setAttribute) copy.setAttribute('type', 'button');
        const self = this;
        if (typeof copy.addEventListener === 'function') {
          copy.addEventListener('click', function () { self.copyReceipt(); });
        }
        card.appendChild(copy);
      }
      this.dismissReceipt();
      this._receiptText = safeString(receipt.copyText);
      this._nodes.receipt = this._mount(card);
      return this._nodes.receipt;
    }

    dismissReceipt() {
      const card = this._nodes.receipt || this._qs('.st-receipt-card');
      this._nodes.receipt = null;
      this._receiptText = null;
      return this._dropNode(card);
    }

    /** copyReceipt() -> the text handed to the caller's onCopyReceipt (or null). */
    copyReceipt() {
      const text = this._receiptText;
      if (!text) return null;
      if (typeof this.options.onCopyReceipt === 'function') {
        try { this.options.onCopyReceipt(text); } catch (e) { /* a failed copy must not throw */ }
      }
      return text;
    }

    /* ------------------------------------------------ Supreme Overlord gauge */

    /**
     * renderOverlordGauge(gauge) -> the gauge element (or null).
     * Kingambit's Supreme Overlord readout, for the mon the opponent has active. Both numbers are
     * MEASURED by the engine from the library's own damage calc (LaplaceEngine.overlordGauge) —
     * RULE 1 keeps the ability's +10%-per-ally rule out of this file, and out of the engine.
     * `null` removes the gauge.
     */
    renderOverlordGauge(gauge) {
      if (!this._document()) return null;
      let el = this._nodes.overlord || this._qs('.st-overlord-gauge');
      if (!gauge || typeof gauge !== 'object') {
        this._nodes.overlord = null;
        return this._dropNode(el);
      }
      if (!el) {
        el = this._el('div', 'st-overlord-gauge');
        if (!el) return null;
        if (el.setAttribute) el.setAttribute(OVERLORD_ATTR, '1');
        el = this._mount(el);
      }
      this._nodes.overlord = el;
      el.textContent = '\uD83D\uDC51 Supreme Overlord: +' + roundPct(gauge.percentBoost) + '% (' +
        roundPct(gauge.fallen) + ' fallen) \u2014 ' + roundPct(gauge.effectiveAtk) + ' Atk';
      if (el.setAttribute) {
        el.setAttribute('title', safeString(gauge.species) + ' Supreme Overlord gauge');
      }
      return el;
    }

    /* -------------------------------------- PP-stall gauge & format sentinel */

    /**
     * _syncChipBand() -> the chip band's measured bottom in px (or null).
     * Every block in the chip band is an independently `position: fixed` node, so no block can
     * stack itself under its neighbours in CSS — and the badge row is content-driven: at phone
     * width three badges wrap to ~56px and reach 102px, which is below the offset a static
     * stylesheet can assume. So the two readouts below the band measure the band's real bottom
     * and publish it as `--st-chip-bottom`, which overlay.css consumes with a static fallback
     * for the case where the stylesheet loads without this file having run. Fixed elements use
     * viewport coordinates, so the rect's bottom is directly comparable to a `top` offset.
     */
    _syncChipBand() {
      const doc = this._document();
      if (!doc || !doc.documentElement || !doc.documentElement.style ||
          typeof doc.documentElement.style.setProperty !== 'function') return null;
      const sels = ['.tactician-banner', '.st-overlord-gauge', '.st-badge-row',
        '.st-deduction-badges', '.st-lethal-bar'];
      let bottom = 0;
      for (let i = 0; i < sels.length; i++) {
        const el = this._qs(sels[i]);
        if (!el || typeof el.getBoundingClientRect !== 'function') continue;
        const rect = el.getBoundingClientRect();
        if (!rect || !(rect.bottom === rect.bottom)) continue;
        if (rect.bottom > bottom) bottom = rect.bottom;
      }
      const px = Math.round(bottom);
      doc.documentElement.style.setProperty('--st-chip-bottom', px + 'px');
      return px;
    }

    /**
     * renderPPGauge(gauge) -> the gauge element (or null).
     * The Sucker Punch PP-stall readout (LaplaceEngine.ppStall). The remaining PP is READ by the
     * engine from the page's own battle object, so this file must never print a denominator it
     * was not given: with `observesOnly` (no `|stpp|` snapshot yet) the honest line is how many
     * times the move has been seen, never "N/8". `null` removes the gauge.
     */
    renderPPGauge(gauge) {
      if (!this._document()) return null;
      // Measure the band BEFORE this node is mounted, so the gauge never measures itself.
      this._syncChipBand();
      let el = this._nodes.ppGauge || this._qs('.st-pp-gauge');
      if (!gauge || typeof gauge !== 'object') {
        this._nodes.ppGauge = null;
        return this._dropNode(el);
      }
      if (!el) {
        el = this._el('div', 'st-pp-gauge');
        if (!el) return null;
        if (el.setAttribute) el.setAttribute(PP_ATTR, '1');
        el = this._mount(el);
      }
      this._nodes.ppGauge = el;
      this._clearChildren(el);

      const species = safeString(gauge.species);
      const move = gauge.move || {};
      const prefix = safeString(cfg('hud.ppGauge.label', 'PP')) || 'PP';
      const label = safeString(move.label || move.id) ||
        safeString(cfg('ppStall.headline', 'suckerpunch'));

      const headline = this._el('div', 'st-pp-headline',
        PP_ICON + ' ' + label + ' ' + prefix + ': ' + this._ppText(move));
      this._appendChild(el, headline);

      const threat = gauge.threat || {};
      const threatText = this._ppThreatText(threat, species);
      if (threatText) {
        const line = this._el('div', 'st-pp-threat', threatText);
        this._appendChild(el, line);
      }

      const advice = gauge.advice;
      if (advice && typeof advice === 'object') {
        const line = this._el('div', 'st-pp-advice', this._ppAdviceText(advice, gauge));
        this._appendChild(el, line);
      }

      if (el.setAttribute) {
        el.setAttribute('title', (species || 'their active') + ' PP pressure' +
          (move.observesOnly ? ' (PP not observed yet)' : ''));
      }
      // Publish the gauge's REAL height: the sentinel below derives its offset from it, so the two
      // never overlap and neither has to hard-clamp the advice line mid-glyph to fit a guess.
      this._publishGaugeHeight(el);
      return el;
    }

    /** _publishGaugeHeight(el) -> the measured height in px (or null without layout). */
    _publishGaugeHeight(el) {
      const doc = this._document();
      if (!doc || !el || typeof el.getBoundingClientRect !== 'function') return null;
      const rect = el.getBoundingClientRect();
      if (!rect || !(rect.height === rect.height) || !rect.height) return null;
      if (!doc.documentElement || !doc.documentElement.style ||
          typeof doc.documentElement.style.setProperty !== 'function') return null;
      const px = Math.round(rect.height);
      doc.documentElement.style.setProperty('--st-pp-gauge-h', px + 'px');
      return px;
    }

    clearPPGauge() {
      const el = this._nodes.ppGauge || this._qs('.st-pp-gauge');
      this._nodes.ppGauge = null;
      return this._dropNode(el);
    }

    /** The headline: a real snapshot prints pp/maxpp, anything else prints observed uses only. */
    _ppText(move) {
      const pp = typeof move.pp === 'number' ? move.pp : null;
      const maxpp = typeof move.maxpp === 'number' ? move.maxpp : null;
      if (!move.observesOnly && pp !== null && maxpp !== null) return pp + '/' + maxpp + ' left';
      const used = this._count(move.used, pp, move.remaining);
      return used === null ? 'remaining PP not observed yet' : 'used ' + used + ' time(s) \u2014 no PP snapshot';
    }

    _count() {
      for (let i = 0; i < arguments.length; i++) {
        const v = arguments[i];
        if (typeof v === 'number' && v === v && isFinite(v)) return Math.round(v);
      }
      return null;
    }

    _ppThreatText(threat, species) {
      const read = safeString(threat.read).trim();
      if (read) return THREAT_ICON + ' ' + read;
      const moves = Array.isArray(threat.setupMoves) ? threat.setupMoves.filter(Boolean) : [];
      if (!moves.length) return '';
      const hp = typeof threat.theirHp === 'number' && threat.theirHp === threat.theirHp
        ? U.clamp(Math.round(threat.theirHp), 0, 100) + '% HP' : '';
      return THREAT_ICON + ' setup threat: ' + moves.join(' / ') +
        (species ? ' on ' + species : '') + (hp ? ' at ' + hp : '');
    }

    _ppAdviceText(advice, gauge) {
      const label = this._rowLabelFor(gauge, advice.moveId) || safeString(advice.moveId);
      const freq = typeof advice.frequency === 'number' && advice.frequency === advice.frequency
        ? (advice.frequency <= 1 ? advice.frequency * 100 : advice.frequency) : null;
      const reason = safeString(advice.reason).trim();
      const head = safeString(cfg('ppStall.adviceLabel', 'PP-stall pivot'));
      return head + ': click ' + (label || 'the punish') +
        (freq === null ? '' : ' ' + U.clamp(Math.round(freq), 0, 100) + '% of the time') +
        (reason ? ' \u2014 ' + reason : '');
    }

    /** Look a row label up by move id, so the advice names the move the matrix was solved for. */
    _rowLabelFor(gauge, moveId) {
      const id = U.toID(moveId || '');
      if (!id) return '';
      const rows = (gauge && gauge.matrix && Array.isArray(gauge.matrix.rows)) ? gauge.matrix.rows : [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;
        if (U.toID(row.moveId || row.label || '') === id) return safeString(row.label || moveId);
        const action = row.action || {};
        if (U.toID(action.moveId || action.name || action.id || '') === id) {
          return safeString(row.label || action.name || moveId);
        }
      }
      return '';
    }

    /**
     * renderFormatSentinel(sentinel) -> the bar element (or null).
     * The Z-Move / Mega Trap sentinel: which of the opponent's format mechanics are spent, and
     * what their remaining bench therefore cannot hold. Every word that is a LABEL comes from
     * src/config.js; every fact comes from the engine's read of state.formatLocks. `null`
     * removes the bar.
     */
    renderFormatSentinel(sentinel) {
      if (!this._document()) return null;
      const drawn = this._nodes.ppGauge || this._qs('.st-pp-gauge');
      if (!drawn) this._syncChipBand();   // the gauge normally measures first; stand alone if not
      let el = this._nodes.sentinel || this._qs('.st-format-sentinel');
      if (!sentinel || typeof sentinel !== 'object') {
        this._nodes.sentinel = null;
        return this._dropNode(el);
      }
      if (!el) {
        el = this._el('div', 'st-format-sentinel');
        if (!el) return null;
        if (el.setAttribute) el.setAttribute(SENTINEL_ATTR, '1');
        el = this._mount(el);
      }
      this._nodes.sentinel = el;
      this._clearChildren(el);

      const head = this._el('div', 'st-sentinel-head', 'OPPONENT FORMAT MECHANICS');
      this._appendChild(el, head);
      this._appendChild(el, this._mechanicRow('Mega Evolution', sentinel.mega));
      this._appendChild(el, this._mechanicRow('Z-Move', sentinel.z));

      const tactics = Array.isArray(sentinel.tactics) ? sentinel.tactics.filter(Boolean) : [];
      if (tactics.length) {
        const freedom = this._el('div', 'st-sentinel-head',
          safeString(cfg('sentinel.freedomLabel', 'TACTICAL FREEDOM')));
        this._appendChild(el, freedom);
        const cap = cfg('hud.sentinelBar.maxTactics', 3);
        const limit = Math.max(0, Math.min(tactics.length, typeof cap === 'number' ? cap : 3));
        for (let i = 0; i < limit; i++) {
          const t = tactics[i];
          const glyph = safeString(t.icon) || SENTINEL_TACTIC_ICONS[safeString(t.kind)] || TACTIC_BULLET;
          const row = this._el('div', 'st-sentinel-tactic',
            glyph + ' ' + safeString(t.label) +
            (t.detail ? ' \u2014 ' + safeString(t.detail) : ''));
          if (row && row.setAttribute) {
            row.setAttribute('data-st-tactic', safeString(t.kind) || 'other');
          }
          this._appendChild(el, row);
        }
      }

      const bench = sentinel.bench || {};
      if (typeof bench.unrevealed === 'number' || typeof bench.stonesPossible === 'number') {
        const row = this._el('div', 'st-sentinel-bench', 'unrevealed: ' +
          safeString(this._count(bench.unrevealed)) + ' \u00b7 stones/crystals possible: ' +
          safeString(this._count(bench.stonesPossible)));
        this._appendChild(el, row);
      }
      return el;
    }

    clearFormatSentinel() {
      const el = this._nodes.sentinel || this._qs('.st-format-sentinel');
      this._nodes.sentinel = null;
      return this._dropNode(el);
    }

    /** One mechanic line: burned (with its culprit and turn) or still live. */
    _mechanicRow(fallbackName, info) {
      const m = (info && typeof info === 'object') ? info : {};
      // The NAME of the mechanic, never its state: the engine's `label` is the burned/live word
      // (`sentinel.burnedLabel`), so preferring it here printed "BURNED: BURNED" and buried the
      // one thing the row exists to say. The passed-in name wins; `m.label` is only a fallback
      // for a caller that supplies no name at all.
      const name = safeString(fallbackName || m.label);
      const burned = !!m.burned;
      const state = burned
        ? safeString(cfg('sentinel.burnedLabel', 'BURNED'))
        : safeString(cfg('sentinel.liveLabel', 'LIVE'));
      const who = safeString(m.species);
      const turn = typeof m.turn === 'number' && m.turn === m.turn ? Math.round(m.turn) : null;
      const row = this._el('div', 'st-sentinel-row',
        SENTINEL_ICONS[burned ? 'burned' : 'live'] + ' ' + name + ': ' + state +
        (burned && who ? ' (' + who + (turn === null ? '' : ', turn ' + turn) + ')' : ''));
      this._addClass(row, burned ? 'st-burned' : 'st-live');
      if (row && row.setAttribute) row.setAttribute('data-st-mechanic', safeString(m.id || fallbackName));
      return row;
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
      const nodes = this._qsa('.elo-helper-badge, .tactician-banner, .tactician-tr-chip, .team-drawer, .team-drawer-toggle, .elo-helper-reason, .st-lethal-bar, .st-bench-strip, .st-badge-row, .st-receipt-card, .st-overlord-gauge, .st-pp-gauge, .st-format-sentinel');
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n && typeof n.remove === 'function') n.remove();
      }
      const buttons = this._findMoveButtons();
      const cls = [BADGES.high.cls, BADGES.mid.cls, BADGES.low.cls, BADGES.veto.cls, 'st-optimal',
        'st-lethal-guaranteed', 'st-lethal-high', 'st-lethal-mid', 'st-lethal-none'];
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        if (btn && btn.classList && btn.classList.remove) {
          for (let j = 0; j < cls.length; j++) btn.classList.remove(cls[j]);
        }
        if (btn && btn.removeAttribute) {
          btn.removeAttribute('title');
          btn.removeAttribute(BADGE_ATTR);
          btn.removeAttribute(LETHAL_ATTR);
        }
        const bar = this._findChild(btn, 'st-lethal-bar');
        this._dropNode(bar);
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
        teamStatus: null, candidates: null,
        benchStrip: null, badgeRow: null, receipt: null, overlord: null,
        ppGauge: null, sentinel: null
      };
      this._drawerOpen = false;
      this._bound = false;
      this._benchBound = false;
      this._receiptText = null;
      this.selectedBenchId = null;
      this.lastBadgeCount = 0;
      return true;
    }
  }

  MobileHUD.BADGES = BADGES;
  MobileHUD.VETO_REASON_ATTR = REASON_ATTR;

  ST.MobileHUD = MobileHUD;
})();
