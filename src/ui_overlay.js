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
  // The Cancel-window alert card (see renderCancelAlert): its own attribute and its own class, so
  // clear() can tell it from the TR chip and from the sentinel it sits beside.
  const CANCEL_ATTR = 'data-st-cancel-alert';
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
  // The team-preview lead advisory card (Turn 0). As with the other attributes this is the
  // interface with overlay.css and the regression suite, so it is deliberately NOT configurable.
  const LEAD_ATTR = 'data-st-lead';
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
        ppGauge: null, sentinel: null, leadAdvisory: null, cancelAlert: null,
        console: null, modeToggle: null
      };
      this._touched = [];        // [{ el, prop, previous }] inline style rollbacks
      this._lastRanked = [];
      this._lastReasonByMove = {};
      this._drawerOpen = false;
      this._bound = false;
      this._benchBound = false;   // the strip's delegated listener is attached at most once
      this._layoutBound = false;  // the resize/orientation listener is attached at most once
      this._scrollBound = false;  // the scroll listener (new client's inline move bar) too
      this._layoutKey = '';       // "w x h" the chrome was last measured at (see _syncChipBand)
      this._receiptText = null;   // text behind the receipt's Copy button
      this.selectedBenchId = null; // which bench pill is currently selected ('' = the active mon)
      this.renderCount = 0;
      this.lastBadgeCount = 0;
      // Layout mode. `layoutMode` is the user's choice ('auto'|'mobile'|'desktop'). The HUD
      // resolves it to a concrete 'mobile'|'desktop' (depending on viewport width in 'auto'
      // mode) and writes the result to `data-st-layout` on documentElement, which overlay.css
      // reads to switch layouts. The toggle button flips between 'mobile' and 'desktop'; the
      // options page can reset to 'auto'.
      this.layoutMode = (typeof options.layoutMode === 'string') ? options.layoutMode : 'auto';
      this.resolvedLayout = null;  // set by _setLayout
      this.onLayoutModeChange = (typeof options.onLayoutModeChange === 'function')
        ? options.onLayoutModeChange : null;
      // Apply the layout as soon as a document is available. A construction-time call is
      // safe even without one (the helper returns null), and it means the very first render
      // (e.g. the banner in content.js) lands in the correct layout — otherwise a HUD
      // created with `layoutMode: 'auto'` on a desktop viewport would render the mobile
      // band at full viewport width until something called bindDrawer.
      try { this._applyResolvedLayout(); } catch (e) { /* no document yet */ }
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
      // Classic client (play.pokemonshowdown.com/oldclient, js/oldclient/client-battle.js) labels
      // each move button with the canonical id, so `data-move` is the one source of truth.
      const direct = button.getAttribute ? button.getAttribute('data-move') : null;
      if (direct) return U.toID(direct);
      // PS's new client (play.pokemonshowdown.com/newclient, src/panel-battle.tsx) drops BOTH
      // `data-move` and `name="chooseMove"`. The only handle left on the button is the tooltip
      // payload — "move|<id>|<pos>" for ordinary moves, "zmove|<id>|<pos>" and
      // "maxmove|<id>|<pos>" for the boosted variants — and an index in `data-cmd` ("/move 1").
      // textContent is the WRONG last resort: it concatenates name + type + pp into a string
      // whose toID no longer matches the engine's action id ("Headlong Rush<br>Ground 16/16"
      // becomes "headlongrushground1616"), and the HUD silently decorates nothing on the new
      // client — a no-op the regression suite can't catch because the fixture only exercises
      // the classic markup. Read the tooltip first; the index alone cannot be mapped back to a
      // move id without the request the engine already holds, so a `data-cmd` match is a no-op
      // and we deliberately fall through to the (lossy) textContent.
      //
      // The tooltip carries the move NAME, not its id (panel-battle.tsx builds it from
      // `moveData.name`), so the capture has to be "everything up to the next pipe" and then
      // run through toID: "Will-O-Wisp" and "Headlong Rush" both contain characters a
      // `[A-Za-z0-9]+` capture would stop at, and a truncated match silently reintroduces the
      // very bug this fallback exists to fix.
      const tip = button.getAttribute ? button.getAttribute('data-tooltip') : null;
      if (tip) {
        const m = /^(?:move|maxmove|zmove)\|([^|]+)\|/.exec(tip);
        if (m) return U.toID(m[1]);
      }
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

    /* ------------------------------------------------- team-preview advisory */

    /**
     * renderLeadAdvisory(advisory) — the Turn-0 card. `advisory` is the engine's own object
     * ({ leads, best, risky }), so the HUD never re-derives a matchup; it only formats. An empty
     * or malformed advisory dismisses the card rather than rendering an empty box.
     */
    renderLeadAdvisory(advisory) {
      if (!this._document()) return null;
      if (!advisory || !Array.isArray(advisory.leads) || !advisory.leads.length) return this.dismissLeadAdvisory();
      let card = this._nodes.leadAdvisory;
      if (!card) {
        card = this._el('div', 'st-lead-advisory');
        if (card && card.setAttribute) card.setAttribute(LEAD_ATTR, '1');
        this._nodes.leadAdvisory = this._mount(card);
      }
      if (!card) return null;
      card.textContent = '';
      const heading = this._el('div', 'st-lead-title', 'TEAM PREVIEW ADVISORY');
      if (heading && typeof card.appendChild === 'function') card.appendChild(heading);
      const self = this;
      let rows = 0;
      [['st-lead-best', advisory.best, '\uD83D\uDFE2 Top lead'],
        ['st-lead-risky', advisory.risky, '\uD83D\uDD34 Risky lead']].forEach(function (pair) {
        const item = pair[1];
        if (!item || !item.species) return;
        const text = pair[2] + ': ' + item.species + ' (' + item.favorability + '% favorability) — ' +
          (item.reason || '');
        const row = self._el('div', pair[0], text);
        if (row && typeof card.appendChild === 'function') { card.appendChild(row); rows++; }
      });
      // The guard above only asks whether `leads` is NON-EMPTY, and that is not the same question as
      // "is there anything to show": a non-empty `leads` whose `best`/`risky` entries lack a
      // `species` skips both rows and leaves the heading alone in the box — the empty card this
      // method's own contract says it will not draw. So count what was actually APPENDED (not what
      // was offered) and dismiss when nothing was.
      if (!rows) return this.dismissLeadAdvisory();
      return card;
    }

    /** Take the Turn-0 card down (battle under way, or a reconnect). */
    dismissLeadAdvisory() {
      const card = this._nodes.leadAdvisory;
      if (card && typeof card.remove === 'function') card.remove();
      this._nodes.leadAdvisory = null;
      return null;
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
      // Measure the page chrome BEFORE mounting, so the banner's first paint lands below
      // Showdown's topbar/room-tab bar instead of jumping from 0 to 56 on the next frame.
      this._syncChipBand();
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

    /**
     * _mountBand(el) -> the same element, parented to the right place.
     * Band elements (the TR chip, bench strip, PP gauge, sentinel, receipt) live in the
     * docked console on desktop and in the body on mobile. The console is a flex column on
     * desktop so children flow as cards; the body hosts `position: fixed` nodes on mobile.
     * Existing nodes (e.g. an adopted band element) are returned unchanged — we never
     * re-mount what is already mounted.
     */
    _mountBand(el) {
      if (!el) return el;
      if (el.parentNode) return el;
      if (this.resolvedLayout === 'desktop') {
        const console = this._ensureConsole();
        if (console && typeof console.appendChild === 'function') {
          try { console.appendChild(el); return el; } catch (e) { /* fall through */ }
        }
      }
      return this._mount(el);
    }

    _ensureChip() {
      if (this._nodes.chip) return this._nodes.chip;
      const existing = this._qs('.tactician-tr-chip');
      if (existing) { this._nodes.chip = existing; return existing; }
      const el = this._el('div', 'tactician-tr-chip tr-info');
      if (!el) return null;
      if (el.setAttribute) { el.setAttribute(CHIP_ATTR, '1'); el.setAttribute('role', 'alert'); }
      this._nodes.chip = this._mountBand(el);
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

    /* ------------------------------------------- the Cancel-window alert */

    /**
     * _findUndoButton() -> the Showdown Cancel control, or null.
     *
     * Two spellings, both in the wild: the client's `<button name="undoChoice">Cancel</button>` and
     * the older/aliased `.battle-controls button[value="undo"]`. Looked up through the DOCUMENT
     * rather than a cached handle, because Showdown rebuilds the battle bar constantly and a handle
     * from the previous turn is a detached node by this one.
     */
    _findUndoButton() {
      const selectors = ['button[name="undoChoice"]', '.battle-controls button[value="undo"]'];
      for (let i = 0; i < selectors.length; i++) {
        const hit = this._qs(selectors[i]);
        if (hit) return hit;
      }
      return null;
    }

    /**
     * renderCancelAlert(info) — flag the Cancel window.
     *
     * `info` is built by the deep background pass in src/content.js
     * ({ locked, better, reason, why, scoreDelta, confDelta }); the HUD only formats, so no part of
     * this file has to know what a payoff is. TWO things are painted, and both are needed: the
     * button itself is flagged (`.st-cancel-alert` plus a `.st-cancel-badge` reading
     * "UNDO → <better.name>") because that is the control the alert asks the player to press, and a
     * card names the line the deeper read prefers AND why the two passes disagree — a highlighted
     * button with no text is a puzzle, not advice.
     *
     * A MISSING BUTTON IS NOT A FAILURE. Showdown takes it away the instant the opponent locks in,
     * which is also the moment the advice stops being actionable; the card still lands, because the
     * disagreement it reports is real either way.
     */
    renderCancelAlert(info) {
      if (!this._document()) return null;
      if (!info || !info.better || !info.better.name) return this.clearCancelAlert();
      const better = safeString(info.better.name);
      const locked = info.locked && info.locked.name ? safeString(info.locked.name) : 'your locked move';
      const why = safeString(info.why || info.reason || '');

      const button = this._findUndoButton();
      if (button) {
        this._addClass(button, 'st-cancel-alert');
        let badge = this._findChild(button, 'st-cancel-badge');
        if (!badge) {
          badge = this._el('span', 'st-cancel-badge');
          this._appendChild(button, badge);
        }
        if (badge) {
          badge.textContent = 'UNDO → ' + better;
          if (badge.setAttribute) {
            badge.setAttribute('title', why);
            badge.setAttribute('aria-label', 'Cancel and play ' + better + ' instead');
          }
        }
      }

      const card = this._ensureCancelCard();
      if (card) {
        this._clearChildren(card);
        this._appendChild(card, this._el('span', 'st-cancel-head', 'Cancel window — the deep pass disagrees'));
        this._appendChild(card, this._el('span', 'st-cancel-body',
          'Undo and play ' + better + ' instead of ' + locked + '.'));
        if (why) this._appendChild(card, this._el('span', 'st-cancel-why', why));
        if (card.style) card.style.display = '';
        if (card.setAttribute) card.setAttribute('data-reason', safeString(info.reason || ''));
      }
      this.cancelAlert = { locked: info.locked || null, better: info.better, reason: info.reason || null, card: card, button: button };
      return this.cancelAlert;
    }

    /**
     * clearCancelAlert() — take the flag, the badge and the card back down.
     *
     * The button sweep is UNCONDITIONAL rather than driven by the handle we stored: the page
     * replaces its control bar between renders, so the flagged node and the node we remember may
     * not be the same one. Called on a new turn, on `/undo`, and from clear(); safe to call when
     * nothing is up.
     */
    clearCancelAlert() {
      const flagged = this._qsa('.st-cancel-alert');
      for (let i = 0; i < flagged.length; i++) this._removeClass(flagged[i], 'st-cancel-alert');
      const badges = this._qsa('.st-cancel-badge');
      for (let i = 0; i < badges.length; i++) this._dropNode(badges[i]);
      const held = this.cancelAlert;
      if (held && held.button) {
        const badge = this._findChild(held.button, 'st-cancel-badge');
        this._dropNode(badge);
        this._removeClass(held.button, 'st-cancel-alert');
      }
      this.cancelAlert = null;
      /* The card is DROPPED rather than hidden, the way dismissReceipt drops its own: the alert is
       * rebuilt from scratch on the next disagreement, so a hidden node that outlives its turn is
       * only a way for a stale card to reappear under a fresh one. */
      const card = this._nodes.cancelAlert;
      this._nodes.cancelAlert = null;
      this._dropNode(card);
      return null;
    }

    _ensureCancelCard() {
      if (this._nodes.cancelAlert) return this._nodes.cancelAlert;
      const existing = this._qs('.st-cancel-alert-card');
      if (existing) { this._nodes.cancelAlert = existing; return existing; }
      const el = this._el('div', 'st-cancel-alert-card');
      if (!el) return null;
      if (el.setAttribute) { el.setAttribute(CANCEL_ATTR, '1'); el.setAttribute('role', 'alert'); }
      if (el.style) el.style.display = 'none';
      this._nodes.cancelAlert = this._mountBand(el);
      return this._nodes.cancelAlert;
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
      // Re-measure the band before the strip is (re)drawn: the strip is the element whose
      // position depends on Showdown's own control bar, and it is mounted on every turn of a
      // real battle — so it is the one render path that must not depend on some other call
      // having synced first. Height is lift-independent, so measuring here is safe.
      this._syncChipBand();
      const cap = cfg('hud.benchStripMax', 6);
      let strip = this._nodes.benchStrip || this._qs('.st-bench-strip');
      if (!strip) {
        strip = this._el('div', 'st-bench-strip');
        if (!strip) return null;
        if (strip.setAttribute) strip.setAttribute(BENCH_ATTR, '1');
        strip = this._mountBand(strip);
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
      // The receipt is post-match, so Showdown's control bar is normally gone by now and the
      // lift is 0. Sample anyway: a receipt that arrives during the win animation must clear
      // the bar rather than cover the buttons the player was just using.
      this._syncChipBand();
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
      this._nodes.receipt = this._mountBand(card);
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
     * _touchOffset(doc) -> the HUD's own touch-target size in px.
     * Read back out of the cascade so the lift arithmetic below and overlay.css can never
     * disagree about what `--st-touch` is today. `--st-touch` is a static 48px in the
     * stylesheet and config.js never touches it, but the value is not hard-coded here on
     * purpose: a second copy of the number is a second place for it to drift.
     */
    _touchOffset(doc) {
      const view = doc && doc.defaultView ? doc.defaultView :
        (typeof window !== 'undefined' ? window : null);
      if (view && typeof view.getComputedStyle === 'function') {
        try {
          const raw = view.getComputedStyle(doc.documentElement).getPropertyValue('--st-touch');
          const n = parseFloat(raw);
          if (n === n && n > 0) return n;
        } catch (e) { /* no cascade (Node harness) */ }
      }
      return 48;
    }

    /**
     * _syncControlBar(doc) -> the lift the bottom band needs, in px (0 = none).
     *
     * Showdown's own control bar is the one piece of page furniture the HUD's bottom band
     * shares pixels with, and where it lives is client-specific:
     *
     *   classic  `.battle-controls { position: absolute; top: 370px }` — measured live at
     *            411x891 it occupies 297..402, and the screen below it is empty. The hundred
     *            or so pixels of HUD pinned to the viewport bottom are in clear air.
     *   new      `.battle-log .battle-controls { top: 0; position: static; width: auto }` —
     *            the move bar RIDES INSIDE the scrollable battle log, so its Y is a function
     *            of the log's scrollTop. Measured live with the log at rest it occupies
     *            688..792 out of 891 — exactly where the HUD pins its bottom band.
     *
     * With no correction the bench strip (774..835 by measurement) sits on the bar's bottom
     * 18px: the PP half of the move buttons goes dark and the strip, which is a live
     * tappable element, swallows the taps that were meant for those buttons. That is the
     * worst place for the two to collide, because the whole point of the strip is to be
     * used while the move buttons are on screen.
     *
     * The lift is published as `--st-band-lift`, which overlay.css adds to the three
     * bottom-anchored offsets. Absent var = 0px, so lobbies, the classic client and every
     * headless test keep today's layout byte for byte.
     *
     * The overlap probe deliberately reads the UN-LIFTED geometry (`vh - touch - pad -
     * height`), never the elements' live rects: after a lift, the live rects would report
     * "no overlap" and snap the band back down, then back up, on the next scroll tick.
     * Height is lift-independent, so measuring it is safe.
     */
    _syncControlBar(doc) {
      const reset = function () {
        doc.documentElement.style.setProperty('--st-band-lift', '0px');
        doc.documentElement.style.setProperty('--st-controls-top', '0px');
        doc.documentElement.style.setProperty('--st-controls-bottom', '0px');
        if (doc.documentElement.dataset) delete doc.documentElement.dataset.stBandLifted;
        return 0;
      };
      const view = doc.defaultView || (typeof window !== 'undefined' ? window : null);
      const vh = (view && typeof view.innerHeight === 'number') ? view.innerHeight : 0;
      const bar = this._qs('.battle-controls');
      if (!bar || !vh || typeof bar.getBoundingClientRect !== 'function') return reset();

      const rect = bar.getBoundingClientRect();
      // A lobby, a team builder, or a bar that has scrolled clean off the screen: no page
      // furniture down here, so the band belongs at the viewport bottom. `top <= 0` also
      // covers the degenerate rect the Node harness returns (top 0, height 50).
      if (!rect || rect.top !== rect.top || rect.height <= 0 || rect.top <= 0 || rect.top >= vh) return reset();
      const top = Math.round(rect.top);
      const bottom = Math.round(rect.bottom);

      // Published for auditability: `getComputedStyle(documentElement)` answers "where did
      // Showdown put its controls, and did the HUD move out of the way?" without a debugger.
      doc.documentElement.style.setProperty('--st-controls-top', top + 'px');
      doc.documentElement.style.setProperty('--st-controls-bottom', bottom + 'px');

      // The bench strip is the lowest block the HUD pins to the bottom (`--st-touch + 8`) and
      // the only one of the three that is mounted on every turn of a real battle, so it is
      // the probe. 61px is a measured fallback for "one row of 48px pills + 12px padding +
      // 1px border"; the real height is read off the node when it is mounted.
      const strip = this._qs('.st-bench-strip');
      const stripRect = (strip && typeof strip.getBoundingClientRect === 'function')
        ? strip.getBoundingClientRect() : null;
      const stripH = (stripRect && stripRect.height) ? stripRect.height : 61;
      const bottomEdge = vh - (this._touchOffset(doc) + 8);   // the strip's bottom at NO lift
      const stripTop = bottomEdge - stripH;                   // ...and therefore its top
      const overlaps = stripTop < bottom && bottomEdge > top;
      const lift = overlaps ? Math.round(bottomEdge - (top - 4)) : 0;

      doc.documentElement.style.setProperty('--st-band-lift', (lift > 0 ? lift : 0) + 'px');
      if (doc.documentElement.dataset) {
        if (lift > 0) doc.documentElement.dataset.stBandLifted = '1';
        else delete doc.documentElement.dataset.stBandLifted;
      }
      return lift > 0 ? lift : 0;
    }

    /**
     * _syncChipBand() -> the chip band's measured bottom in px (or null).
     * Every block in the chip band is an independently `position: fixed` node, so no block can
     * stack itself under its neighbours in CSS — and the badge row is content-driven: at phone
     * width three badges wrap to ~56px and reach 102px, which is below the offset a static
     * stylesheet can assume. So the two readouts below the band measure the band's real bottom
     * and publish it as `--st-chip-bottom`, which overlay.css consumes with a static fallback
     * for the case where the stylesheet loads without this file having run. Fixed elements use
     * viewport coordinates, so the rect's bottom is directly comparable to a `top` offset.
     *
     * Also publishes `--st-battle-top`: the top of Showdown's own `.battle` container, which
     * is the room tab bar's bottom on mobile (≈56 px) and a hair under the topbar on the new
     * client (≈30 px). The banner consumes it as its own `top` so the status strip sits just
     * above the arena instead of painting over the menu and the room tabs. The measurement is
     * done here (and in `_ensureBanner`) rather than on every render so a player scrolling the
     * battle log can't drag the banner with them; the values are re-read on resize via the
     * listener installed in `bindDrawer`.
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

      // The bottom band's clearance from Showdown's own control bar. NOT keyed to the
      // viewport: on the new client the move bar rides inside the scrollable battle log, so
      // its Y is a function of the log's scrollTop (see _syncControlBar).
      this._syncControlBar(doc);

      // The top of the visible battle content. The classic client renders the room tab bar
      // (and the topbar) ABOVE the battle container, so the banner should sit at `.battle.top`,
      // not at the viewport's `top: 0` (which would cover the menu and the room tabs). Lobbies
      // and the spec harness don't have a `.battle`, so the var is left unset and the CSS
      // falls back to 0 px — i.e. the original "pinned to the viewport top" behavior.
      //
      // The measurement is re-taken ONLY when the viewport changes size. The new client is one
      // long vertical scroll and `.battle` scrolls with it, so re-measuring on every render
      // would drag the banner up a few pixels every time the player scrolled the log. The
      // chrome height only changes on resize/rotate, and that is exactly what the key catches.
      const view = doc.defaultView || (typeof window !== 'undefined' ? window : null);
      const key = (view && typeof view.innerWidth === 'number')
        ? (view.innerWidth + 'x' + view.innerHeight) : '';
      if (key && key === this._layoutKey) return px;
      this._layoutKey = key;

      const battle = this._qs('.battle');
      if (battle && typeof battle.getBoundingClientRect === 'function') {
        const br = battle.getBoundingClientRect();
        if (br && br.top === br.top && br.top > 0) {
          doc.documentElement.style.setProperty('--st-battle-top', Math.round(br.top) + 'px');
          // The whole chip band is a stack of `position: fixed` nodes pinned to the banner. In
          // the original (viewport-top) layout the overlord pill and the badge row sit on top
          // of / just below the banner, which is the intended visual. Once the banner moves
          // down to `.battle.top` those offsets still point at 18/46 px and the band ends up
          // straddling the banner. Mark the document so the stylesheet re-anchors the band to
          // the new banner position; the attribute is only set when a real battle is mounted,
          // so lobbies and tests keep the original offsets. Guarded: the Node harness's stub
          // element has no `dataset`, and an unguarded write there is a TypeError.
          if (doc.documentElement.dataset) doc.documentElement.dataset.stBandAnchored = '1';
        }
      }
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
        el = this._mountBand(el);
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
        el = this._mountBand(el);
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
        // Adopted, not built — the signals still have to be bound (see _bindLayoutSignals).
        this._bindLayoutSignals();
        this._mountModeToggle();
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
      // The layout-mode toggle lives next to the TAC button, in the same bottom-left cluster.
      // A second 40x40 button is enough — it shows the current RESOLVED mode and tapping it
      // flips to the other. The options page is the place to reset to 'auto'.
      this._bound = true;
      // Re-measure the chip band on viewport resize and orientation change. The HUD is a stack
      // of `position: fixed` blocks anchored to the PS chrome, and the chrome (the room tab
      // bar in particular) changes height between portrait/landscape and across phone sizes;
      // without this, the banner would stay stuck at the height it was measured at boot.
      this._bindLayoutSignals();
      // The mode toggle is a HUD-wide control, so it is mounted as part of binding the HUD to
      // the page rather than at construction: a HUD that is constructed but never bound (the
      // clipboard fallback tests build one to exercise a pure function) must not leave a
      // button in the document. `_setLayout` only re-labels an already-mounted button.
      this._mountModeToggle();
      return this._nodes.drawer;
    }

    _mountModeToggle() {
      const doc = this._document();
      if (!doc) return null;
      let btn = this._nodes.modeToggle;
      const existing = this._qs('.st-mode-toggle');
      if (existing) {
        btn = existing;
        this._nodes.modeToggle = btn;
      } else {
        btn = this._el('button', 'st-mode-toggle');
        if (!btn) return null;
        btn.textContent = '...';
        if (btn.setAttribute) {
          btn.setAttribute('type', 'button');
          btn.setAttribute('aria-label', 'Switch HUD layout between mobile and desktop');
          btn.setAttribute('data-st-mode-toggle', '1');
        }
        this._mount(btn);
        this._nodes.modeToggle = btn;
      }
      // The click handler is bound once per node, and re-binding is harmless because the
      // second call replaces the prior one on the same button. Doing it here (not in
      // _bindLayoutSignals) means even a HUD that never had a drawer can still toggle.
      if (btn && btn.addEventListener) {
        const self = this;
        btn.onclick = function () { self.toggleLayoutMode(); };
        // Avoid stealing keyboard focus: PS uses 1-4 for moves and the rest of the document
        // is keyboard-driven, so a focused button that intercepts space/enter would block
        // those shortcuts. Blur on mousedown in CAPTURE so focus never reaches the button
        // in the first place; a listener on `click` is too late because the button is already
        // focused by then and a setTimeout(0) blur races the test's assertion.
        btn.addEventListener('mousedown', function (e) { e.preventDefault(); }, true);
      }
      this._updateModeToggle();
      return btn;
    }

    /**
     * _bindLayoutSignals() — re-measure the chip band when the layout or the log scroll moves.
     * Called from BOTH exit paths of bindDrawer, including the one that ADOPTS a drawer that
     * is already in the document: attaching these inside the drawer-building branch only
     * meant an adopted drawer kept a stale band forever, which is the exact failure the
     * listeners exist to prevent (resize → banner stuck at the old chrome height; scroll →
     * band drifts back over the new client's move bar). Idempotent per instance.
     */
    _bindLayoutSignals() {
      const doc = this._document() || (typeof document !== 'undefined' ? document : null);
      const view = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
      if (!this._layoutBound && view && typeof view.addEventListener === 'function') {
        this._layoutBound = true;
        const self = this;
        // Re-measure AND re-resolve the layout. Re-resolve matters in 'auto' mode when the
        // viewport crosses the breakpoint — the HUD has to flip layouts without a reload.
        // Re-measure matters on every resize/orientation because PS's chrome resizes too.
        const onLayout = function () {
          try { self._applyResolvedLayout(); } catch (e) { /* detached */ }
          try { self._syncChipBand(); } catch (e) { /* detached */ }
        };
        view.addEventListener('resize', onLayout, { passive: true });
        view.addEventListener('orientationchange', onLayout, { passive: true });
      }
      // …and on scroll. The new client makes `.battle-log .battle-controls` `position:
      // static`, so its move bar is a node in the scrollable log and scrolling moves it;
      // without this the bottom band's lift is sampled once at boot and the strip drifts
      // back over the buttons as soon as the player touches the log. Scroll events do not
      // bubble, so the listener goes on `document` with `capture` to catch any scrolled
      // descendant, and the work is coalesced into one rAF so a fling costs one measurement
      // per frame instead of one per scroll event.
      if (!this._scrollBound && doc && typeof doc.addEventListener === 'function') {
        this._scrollBound = true;
        const self = this;
        let queued = false;
        const onScroll = function () {
          if (queued) return;
          queued = true;
          const run = function () {
            queued = false;
            try { self._syncChipBand(); } catch (e) { /* detached */ }
          };
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
          else setTimeout(run, 16);
        };
        doc.addEventListener('scroll', onScroll, { passive: true, capture: true });
      }
      // And on resize / breakpoint-crossing, the resolved layout may need to flip when the
      // user is in 'auto' mode. The listeners above already re-measure, so this just tells
      // the layout resolver to re-evaluate and re-apply the result.
      this._applyResolvedLayout();
      return this;
    }

    /**
     * _resolveLayout(viewport) -> 'mobile' | 'desktop'.
     * The 'auto' mode picks by viewport width; explicit modes pass through. The breakpoint
     * is configurable so a tablet with a small desktop window can be told "you are mobile".
     * `viewport` defaults to the HUD's own document, falling back to the global window so
     * the Node harness can drive it.
     */
    _resolveLayout(viewport) {
      const mode = (this.layoutMode === 'mobile' || this.layoutMode === 'desktop')
        ? this.layoutMode : 'auto';
      if (mode !== 'auto') return mode;
      const doc = this._document();
      const view = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
      const w = (viewport && typeof viewport.width === 'number') ? viewport.width
        : (view && typeof view.innerWidth === 'number') ? view.innerWidth : 0;
      const bp = (typeof cfg('hud.layoutBreakpoint', 1024) === 'number')
        ? cfg('hud.layoutBreakpoint', 1024) : 1024;
      return w >= bp ? 'desktop' : 'mobile';
    }

    /**
     * _applyResolvedLayout() -> re-resolve and re-apply the layout.
     * Idempotent: if the resolved mode has not changed, this is a no-op. Called on boot
     * and on resize, so a window crossing the breakpoint (auto mode) flips the HUD without
     * a page reload.
     */
    _applyResolvedLayout() {
      const next = this._resolveLayout();
      if (next === this.resolvedLayout) return this.resolvedLayout;
      this._setLayout(next);
      return this.resolvedLayout;
    }

    /**
     * setLayoutMode(mode) -> switch to a user-chosen mode ('auto' | 'mobile' | 'desktop').
     * Fires `onLayoutModeChange` so the host can persist, then resolves and applies.
     */
    setLayoutMode(mode) {
      if (mode !== 'auto' && mode !== 'mobile' && mode !== 'desktop') return;
      if (this.layoutMode === mode) { this._applyResolvedLayout(); return; }
      this.layoutMode = mode;
      if (this.onLayoutModeChange) {
        try { this.onLayoutModeChange(mode); } catch (e) { /* persistence is best-effort */ }
      }
      this._applyResolvedLayout();
    }

    /**
     * toggleLayoutMode() -> flip between 'mobile' and 'desktop'. From 'auto' it goes to the
     * opposite of whatever the viewport currently resolves to, so the button feels like it
     * does what the user expects: tap it, the HUD changes shape.
     */
    toggleLayoutMode() {
      const next = (this.resolvedLayout === 'desktop') ? 'mobile' : 'desktop';
      this.setLayoutMode(next);
    }

    /**
     * _setLayout(resolved) -> 'mobile' | 'desktop'.
     * Switches the DOM into the resolved layout. On desktop it ensures the `.st-console`
     * exists and reparents the bottom band into it; on mobile it moves them back and
     * removes the console. The decision is published as `data-st-layout` on
     * documentElement, which overlay.css reads to switch positioning rules.
     */
    _setLayout(resolved) {
      if (resolved !== 'mobile' && resolved !== 'desktop') resolved = 'mobile';
      this.resolvedLayout = resolved;
      const doc = this._document();
      if (!doc || !doc.documentElement) return resolved;
      doc.documentElement.setAttribute('data-st-layout', resolved);
      // The mode toggle is mounted by bindDrawer (the "HUD is live" signal), never here:
      // a HUD that is only constructed — never bound to the page — must not leave a button
      // in the document. This only re-labels a button that already exists.
      if (resolved === 'desktop') this._reparentIntoConsole();
      else this._reparentOutOfConsole();
      // Any layout-bound geometry has to be re-measured: the band lift depends on where
      // Showdown's control bar sits, the banner re-anchors to the battle top, and the chip
      // band re-anchors with it.
      try { this._syncChipBand(); } catch (e) { /* detached */ }
      this._updateModeToggle();
      return resolved;
    }

    _ensureConsole() {
      if (this._nodes.console) return this._nodes.console;
      const doc = this._document();
      if (!doc) return null;
      let el = doc.querySelector ? doc.querySelector('.st-console') : null;
      if (!el) {
        el = (doc.createElement ? doc.createElement('div') : null);
        if (el) {
          el.className = 'st-console';
          if (el.setAttribute) el.setAttribute('data-st-console', '1');
          // Mount into body so it can position relative to the viewport.
          const parent = doc.body || doc.documentElement;
          if (parent && parent.appendChild) parent.appendChild(el);
        }
      }
      this._nodes.console = el;
      return el;
    }

    /**
     * _reparentIntoConsole() -> move the bottom band into the console.
     * The console is a single scrollable column; children flow as flex items. We move ONLY
     * the band elements (chip, bench strip, PP gauge, sentinel, receipt) — the top
     * elements (banner, overlord, badges) stay in their viewport-fixed positions and are
     * repositioned to the arena column by CSS, because they need to float above the
     * battlefield regardless of the panel's height.
     */
    _reparentIntoConsole() {
      const console = this._ensureConsole();
      if (!console) return;
      const doc = this._document();
      if (!doc) return;
      const sel = '.tactician-tr-chip, .st-bench-strip, .st-pp-gauge, .st-format-sentinel, .st-receipt-card';
      const nodes = (typeof doc.querySelectorAll === 'function')
        ? doc.querySelectorAll(sel) : [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n && n.parentNode !== console && typeof console.appendChild === 'function') {
          try { console.appendChild(n); } catch (e) { /* detached */ }
        }
      }
    }

    /**
     * _reparentOutOfConsole() -> move the band back into the document body.
     * On mobile, the elements are `position: fixed` children of the body, so they can use
     * viewport-relative coordinates again. The console's child collection is walked
     * defensively (it is a real NodeList in the browser and a plain array in the test
     * stub), and only children that are still parented to the console are moved — a
     * half-migrated state must not throw.
     */
    _reparentOutOfConsole() {
      const console = this._nodes.console;
      if (!console) return;
      const doc = this._document();
      const body = (doc && doc.body) || (doc && doc.documentElement) || console.parentNode;
      // Use `children` (the stub's makeEl array and the browser's HTMLCollection both have
      // one) and snapshot before moving so the live list does not mutate under us.
      const live = console.children || console.childNodes;
      const kids = Array.prototype.slice.call(live || []);
      for (let i = 0; i < kids.length; i++) {
        const n = kids[i];
        if (n && n.parentNode === console && body && typeof body.appendChild === 'function') {
          try { body.appendChild(n); } catch (e) { /* detached */ }
        }
      }
      // Drop the console so a future desktop switch builds a fresh one.
      if (console.parentNode && typeof console.parentNode.removeChild === 'function') {
        try { console.parentNode.removeChild(console); } catch (e) { /* detached */ }
      }
      this._nodes.console = null;
    }

    _updateModeToggle() {
      const btn = this._nodes.modeToggle;
      if (!btn) return;
      const resolved = this.resolvedLayout || this._resolveLayout();
      const icon = (resolved === 'desktop') ? '\uD83D\uDDA5\uFE0F' : '\uD83D\uDCF1';
      const label = (resolved === 'desktop') ? 'Desktop' : 'Mobile';
      if (btn.textContent !== undefined) btn.textContent = icon + ' ' + label;
      const title = (this.layoutMode === 'auto')
        ? 'Switch HUD layout (currently auto, resolved to ' + label.toLowerCase() + ')'
        : 'Switch HUD layout (currently ' + this.layoutMode + ')';
      if (btn.setAttribute) btn.setAttribute('title', title);
      btn.setAttribute && btn.setAttribute('data-st-resolved', resolved);
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
      const nodes = this._qsa('.elo-helper-badge, .tactician-banner, .tactician-tr-chip, .team-drawer, .team-drawer-toggle, .elo-helper-reason, .st-lethal-bar, .st-bench-strip, .st-badge-row, .st-receipt-card, .st-overlord-gauge, .st-pp-gauge, .st-format-sentinel, .st-lead-advisory, .st-cancel-alert-card, .st-cancel-badge');
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n && typeof n.remove === 'function') n.remove();
      }
      // ...and the advisory card is ALSO dropped by handle, the way dismissReceipt and
      // clearDeductionBadges do it, because the sweep above is a bulk selector and this is the one
      // node the HUD simultaneously holds a reference to. The selector used to omit
      // `.st-lead-advisory`; clear() then reset `_nodes.leadAdvisory` to null underneath a card that
      // was still mounted, so nothing could ever remove it (dismissLeadAdvisory() reads the handle)
      // while the next battle mounted a SECOND one. Two ways to drop the same node is deliberate
      // here: the handle keeps the document and the HUD agreeing even if the selector drifts again.
      this.dismissLeadAdvisory();
      // The cancel alert is dropped through its own handle as well, for the same reason the
      // advisory is: the sweep above is a bulk selector and this one the HUD also holds a
      // reference to. It also un-flags the Cancel button, which the sweep cannot do because that
      // button belongs to the PAGE, not to us.
      this.clearCancelAlert();
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
        ppGauge: null, sentinel: null, leadAdvisory: null, cancelAlert: null
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
