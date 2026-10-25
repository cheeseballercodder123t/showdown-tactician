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
  const SCOUT_ATTR = 'data-st-scout';
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
  // State and severity use direct labels rather than emoji or pictogram guessing.
  const SENTINEL_STATES = { burned: 'SPENT', live: 'AVAILABLE' };
  const SENTINEL_TACTIC_STATES = {
    mega: 'READY', z: 'READY', freedom: 'OPEN', live: 'CAUTION'
  };
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

  /** Resolve a Showdown species display name to its hosted battle-sprite filename. */
  function spriteSlugs(species) {
    const rawName = safeString(species).trim();
    const name = rawName.normalize ? rawName.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : rawName;
    const id = U.toID(name);
    const aliases = {
      ironvaliant: 'ironvaliant', greattusk: 'greattusk', porygon2: 'porygon2',
      charizardmegax: 'charizard-mega-x', charizardmegay: 'charizard-mega-y',
      mewtwomegax: 'mewtwo-mega-x', mewtwomegay: 'mewtwo-mega-y',
      kyuremblack: 'kyurem-black', kyuremwhite: 'kyurem-white',
      necrozmaduskmane: 'necrozma-dusk-mane', necrozmadawnwings: 'necrozma-dawn-wings',
      necrozmaultra: 'necrozma-ultra', wishiwashischool: 'wishiwashi-school',
      greninjaash: 'greninja-ash', zygardecomplete: 'zygarde-complete',
      flabebe: 'flabebe'
    };
    const slug = aliases[id] || name.toLowerCase()
      .replace(/[.'’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const knownForms = [
      'alola', 'galar', 'hisui', 'paldea', 'mega', 'mega-x', 'mega-y', 'primal',
      'therian', 'incarnate', 'origin', 'resolute', 'unbound', 'complete', 'white',
      'black', 'dusk-mane', 'dawn-wings', 'ultra', 'ash', 'school', 'blade', 'shield',
      'crowned', 'eternamax', 'rapid-strike', 'single-strike', 'bloodmoon'
    ];
    let base = slug;
    for (let i = 0; i < knownForms.length; i++) {
      const suffix = '-' + knownForms[i];
      if (slug.endsWith(suffix)) { base = slug.slice(0, -suffix.length); break; }
    }
    return { form: slug, base: base || slug };
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
        console: null, sheet: null, sheetHeader: null, modeToggle: null,
        consoleHeader: null, matchup: null, toolbar: null
      };
      this._centerView = 'battle';
      this._centerMeta = {};
      this._sheetOpen = false;     // the mobile sheet's collapse/expand state
      /* The desktop console opens EXPANDED. It used to start as a 48 px title bar, which is
       * where a player coming from the phone layout has no reason to look: the HUD appeared to
       * be missing, and the one thing the panel exists for (the readout) was behind an
       * undisclosed click. Collapsing is still one click on the title bar, and the state is
       * per-page: a player who wants the chat back gets it back for that battle. */
      this._panelOpen = true;      // the desktop console's collapse/expand state
      this._panelX = 0;            // the console's drag offset (0 = docked)
      this._panelY = 0;
      this._panelJustDragged = false;  // suppresses the click a drag ends with
      this._pageKind = null;       // 'battle' | 'idle', drives the unmount gate
      this._hotkeyBound = false;   // the Ctrl+8 listener is attached at most once
      this._touched = [];        // [{ el, prop, previous }] inline style rollbacks
      this._lastRanked = [];
      this._lastPreview = null;
      this._battleState = null;
      this._recommended = null;   // the banner's 'PLAY: …' line (see _recommendedLine)
      this._menuWatch = null;     // the move-menu MutationObserver (see bindMoveMenuWatcher)
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
      const root = this._battleRoot();
      return this._qsa('button[data-move], button.movebutton, button[name="chooseMove"], button[data-tooltip^="move|"], button[data-tooltip^="zmove|"], button[data-tooltip^="maxmove|"]', root).filter(function (button) {
        return !button.getClientRects || button.getClientRects().length > 0;
      });
    }

    _battleRoot() {
      const doc = this._document();
      const id = doc && doc.documentElement && doc.documentElement.getAttribute('data-st-room');
      if (id && doc.getElementById) {
        const room = doc.getElementById('room-' + id) || doc.getElementById(id);
        if (room) return room;
      }
      const rooms = this._qsa('.ps-room, .battle-room');
      for (let i = 0; i < rooms.length; i++) {
        if (rooms[i].getClientRects && rooms[i].getClientRects().length && this._qs('.battle', rooms[i])) return rooms[i];
      }
      return null;
    }

    _controls() {
      const bars = this._qsa('.battle-controls', this._battleRoot());
      for (let i = 0; i < bars.length; i++) {
        if (!bars[i].getClientRects || bars[i].getClientRects().length) return bars[i];
      }
      return null;
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
      this._battleState = battleState || null;
      this._readout = readout || null;
      if (readout) this._readoutTurn = battleState && battleState.turn;
      this.renderCount++;

      this.lastBadgeCount = this._decorateMoveButtons(actions);
      // The client rebuilds its move menu after the request, so the buttons this call could see
      // are not necessarily the ones the player will click. Watch for them from now on.
      this.bindMoveMenuWatcher();

      this.renderBanner(battleState, actions);
      this.renderTRChip(this._chipText(battleState, readout, actions), this._chipLevel(battleState, actions));
      if (battleState) { this.setCandidateBreakdown(battleState); this.renderControlCenter(battleState, readout); }
      return this.lastBadgeCount;
    }

    /**
     * _decorateMoveButtons(actions) -> how many Showdown buttons were given an opinion.
     *
     * Shared by render() and redecorate(): the ranking is the only input, so the two paths can
     * never drift into decorating a button differently.
     */
    _decorateMoveButtons(actions) {
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
      return decorated;
    }

    /**
     * bindMoveMenuWatcher() — re-decorate when the client builds (or rebuilds) its move menu.
     *
     * WHY THIS EXISTS. Our protocol listener runs INSIDE the frame that carries `|request|` —
     * before the page's own handler has painted anything — so the HUD's one-shot decoration sees
     * either the PREVIOUS turn's buttons or none at all, and the current client renders the menu
     * as a component that is thrown away and rebuilt between turns. Without this, a live battle
     * shows badges only by luck; with it, the last ranking is re-applied the moment Showdown puts
     * a move button on screen, which is the only moment the player can act on it.
     *
     * One observer, attached at most once, filtered to added nodes that ARE (or contain) a move
     * button — so ordinary log churn never re-decorates anything.
     */
    bindMoveMenuWatcher() {
      if (this._menuWatch) return this._menuWatch;
      if (typeof MutationObserver !== 'function') return null;
      const doc = this._document();
      const root = (doc && (doc.body || doc.documentElement)) || null;
      if (!root) return null;
      const self = this;
      try {
        this._menuWatch = new MutationObserver(function (records) {
          for (let i = 0; i < records.length; i++) {
            const added = records[i] && records[i].addedNodes;
            if (!added || !added.length) continue;
            for (let j = 0; j < added.length; j++) {
              const node = added[j];
              if (!node || node.nodeType !== 1) continue;
              const hits = self._isMoveButton(node) ||
                (node.querySelector && node.querySelector('button[data-move], .movebutton, button[name="chooseMove"], button[data-tooltip^="move|"]'));
              if (hits) { self.redecorate(); return; }
            }
          }
        });
        this._menuWatch.observe(root, { childList: true, subtree: true });
      } catch (e) { this._menuWatch = null; }
      return this._menuWatch;
    }

    /** _isMoveButton(node) — one of Showdown's own move buttons, in either client's markup. */
    _isMoveButton(node) {
      if (!node || node.nodeType !== 1) return false;
      if (node.getAttribute && node.getAttribute('data-move')) return true;
      if (node.classList && typeof node.classList.contains === 'function' &&
          node.classList.contains('movebutton')) return true;
      const name = node.getAttribute ? node.getAttribute('name') : null;
      return !!(name && U.toID(name) === 'choosemove');
    }

    /**
     * redecorate() -> how many buttons were re-decorated from the LAST ranking.
     * Safe to call at any time: with no ranking yet, or on a menu the engine has no opinion
     * about, it is a no-op (the per-button reset in _decorateButton keeps it idempotent).
     */
    redecorate() {
      this.lastBadgeCount = this._decorateMoveButtons(this._lastRanked || []);
      this.renderMovePreviews(this._lastPreview || null);
      this._syncPlacement();
      return this.lastBadgeCount;
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
        btn.style.opacity = '';
        btn.style.textDecoration = '';
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
      return parts.join(' / ');
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
        this._nodes.leadAdvisory = this._mountBand(card);
      }
      if (!card) return null;
      card.textContent = '';
      const heading = this._el('div', 'st-lead-title', 'TEAM PREVIEW ADVISORY');
      if (heading && typeof card.appendChild === 'function') card.appendChild(heading);
      const self = this;
      let rows = 0;
      [['st-lead-best', advisory.best, 'TOP LEAD'],
        ['st-lead-risky', advisory.risky, 'RISKY LEAD']].forEach(function (pair) {
        const item = pair[1];
        if (!item || !item.species) return;
        const text = pair[2] + ' / ' + item.species + ' (' + item.favorability + '% favorability). ' +
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
     * renderBanner(info, actions) — accepts a BattleState, a plain info object or a string.
     * Shows: the recommended line, the TR clock, opponent set identity, confirmed item, speed
     * floor. `actions` is the engine's ranking for the CURRENT window; when it is omitted (the
     * turn-boundary refresh in src/content.js) the last recommendation is kept, because the
     * engine's answer for the window that just resolved is still the best description of what
     * it wanted until the next request replaces it.
     */
    renderBanner(info, actions) {
      if (!this._document()) return null;
      const banner = this._ensureBanner();
      if (!banner) return null;
      if (info && typeof info === 'object') this._battleState = info;
      const text = typeof info === 'string' ? info : this._bannerText(info, actions);
      if (typeof text === 'string' && text.indexOf('PLAY: ') === 0) this._recommended = text.split(BANNER_SEP)[0];
      const offline = !!(info && info.formatSupported === false);
      if (offline) this._recommended = null;
      if (offline) banner.setAttribute && banner.setAttribute('open', '');
      else if (banner.getAttribute && banner.getAttribute('data-st-offline') === '1') banner.removeAttribute('open');
      banner.setAttribute && banner.setAttribute('data-st-offline', offline ? '1' : '0');
      banner.textContent = text;
      if (banner.insertBefore) banner.insertBefore(this._el('summary', 'st-section-title', 'Field & assumptions'), banner.firstChild);
      banner.setAttribute && banner.setAttribute('data-turn', safeString(info && info.turn ? info.turn : ''));
      // Every panel rail (the mobile sheet's collapsed bar, the desktop console's title bar)
      // mirrors this text as its summary, so refresh them both.
      this._refreshPanelHeaders();
      return banner;
    }

    _ensureBanner() {
      if (this._nodes.banner) return this._nodes.banner;
      const existing = this._qs('.tactician-banner');
      if (existing) { this._nodes.banner = existing; return existing; }
      // Measure the page chrome BEFORE mounting, so the banner's first paint lands below
      // Showdown's topbar/room-tab bar instead of jumping from 0 to 56 on the next frame.
      this._syncChipBand();
      const el = this._el('details', 'tactician-banner');
      if (!el) return null;
      if (el.setAttribute) { el.setAttribute(BANNER_ATTR, '1'); el.setAttribute('role', 'status'); }
      // Route through _mountBand so the banner lands in the mobile sheet (or desktop console)
      // like every other band element, instead of as a free-floating viewport-fixed node that
      // would paint over the battle scene on mobile portrait.
      this._nodes.banner = this._mountBand(el);
      // Once the banner is parented, refresh the panel rails (each reads the banner's text
      // as its summary) and re-anchor the sheet to the chip band.
      this._refreshPanelHeaders();
      return this._nodes.banner;
    }

    _bannerText(state, actions) {
      if (!state) return 'Showdown Tactician: waiting for a battle';
      if (state.formatSupported === false) {
        return 'ENGINE OFFLINE' + (state.format ? ' / ' + state.format : '') +
          BANNER_SEP + 'National Dex OU only';
      }
      const parts = [];
      // Keep the live move call easy to scan without dressing it up as a product headline.
      const pick = this._recommendedLine(actions);
      if (pick) parts.push(pick);
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
     * _mountBand(el, intoSheet) -> the same element, parented to the right place.
     * Band elements live in the docked console on desktop and in a collapsible `.st-sheet` at
     * the bottom of the screen on mobile. Both containers are flex columns, so children flow
     * as cards; the body is only used as the last-resort host when the resolved layout is
     * unknown (lobbies, tests).
     *
     * `intoSheet` is false for the TR chip and the bench strip: those two are the always-on,
     * thumb-targeted interactive band (tap a bench pill to retarget the sandbox; read the
     * Trick Room alert). They stay `position: fixed` children of the BODY on mobile -- a bench
     * strip that lives inside a collapsed sheet is invisible right when it matters.
     * Existing nodes are returned unchanged -- we never re-mount what is already mounted.
     */
    _mountBand(el, intoSheet) {
      if (!el) return el;
      if (el.parentNode) return el;
      const host = this.resolvedLayout === 'desktop' ? this._ensureConsole()
        : intoSheet !== false ? this._ensureSheet() : null;
      if (host && host.appendChild) host.appendChild(el);
      else this._mount(el);
      this._refreshPanelHeaders();
      this._syncPlacement();
      return el;
    }

    _ensureChip() {
      if (this._nodes.chip) return this._nodes.chip;
      const existing = this._qs('.tactician-tr-chip');
      if (existing) { this._nodes.chip = existing; return existing; }
      const el = this._el('div', 'tactician-tr-chip tr-info');
      if (!el) return null;
      if (el.setAttribute) { el.setAttribute(CHIP_ATTR, '1'); el.setAttribute('role', 'alert'); }
      // intoSheet=false: the TR chip is the always-on alert in the bottom band on mobile
      // (desktop still parks it in the console).
      this._nodes.chip = this._mountBand(el, false);
      return this._nodes.chip;
    }

    /**
     * _recommendedLine(actions) -> 'PLAY: <move> (<conf>%)' | ''.
     *
     * THE HUD NEVER NAMED ITS ANSWER. The badges on Showdown's buttons carry a percentage and the
     * optimal button a class, so a player had to know which button was the engine's pick before
     * they could read how sure it was. This is the one line that says it in words, and it lives in
     * the banner because the mobile rail mirrors that text and is always on screen. A new ranking
     * replaces the stored pick; a refresh with no ranking (`renderBanner(state)`) keeps the last
     * one, so the line does not blink out between the request and the next turn.
     */
    _recommendedLine(actions) {
      if (Array.isArray(actions)) {
        let best = null;
        for (let i = 0; i < actions.length; i++) {
          const a = actions[i];
          if (!a || a.isVetoed) continue;
          best = a;
          break;
        }
        this._recommended = best ? { name: safeString(best.name), confidence: best.confidence } : null;
      }
      const rec = this._recommended;
      if (!rec || !rec.name) return '';
      const conf = (typeof rec.confidence === 'number' && rec.confidence === rec.confidence)
        ? ' (' + Math.round(rec.confidence) + '%)' : '';
      return 'PLAY: ' + rec.name + conf;
    }

    _chipText(state, readout, actions) {
      if (!state) return '';
      const field = state.field || {};
      const alerts = [];
      // The chip is the Trick Room readout, not just its last-turn alarm: 'not saying whether TR
      // is up or not' was the complaint, and the banner that answered it lives inside the
      // collapsed sheet on a phone. Both states are named, every turn.
      if (field.trickRoom) {
        const left = U.clamp(field.trickRoomTurnsLeft || 0, 0, 5);
        if (left <= 1) alerts.push('TR ' + left + '/5. LAST TURN: attack or sack the setter');
        else if (left === 2) alerts.push('TR 2/5. LAST TURN NEXT: land your chip or sack the setter');
        else alerts.push('TR UP ' + left + '/5. Slower body moves first');
      } else {
        alerts.push('TR off. Normal speed order');
      }
      const tempo = (readout && (readout.tempo || readout.tempoVector)) || state.__tempo || null;
      const v4 = tempo && typeof tempo.v4 === 'number' ? tempo.v4 : null;
      if (v4 !== null && v4 > 0.7) {
        alerts.push('Bunker rhythm predicted (' + Math.round(v4 * 100) + '%). Consider Protect or a setup move');
      }
      const best = actions && actions.length ? actions[0] : null;
      if (best && best.isVetoed && actions.length > 1) {
        const fallback = actions.filter(function (a) { return !a.isVetoed; })[0];
        if (fallback) alerts.push('Top line vetoed. Play ' + safeString(fallback.name));
      }
      return alerts.join(' / ');
    }

    _chipLevel(state, actions) {
      if (!state) return 'info';
      const field = state.field || {};
      if (field.trickRoom && (field.trickRoomTurnsLeft || 0) <= 1) return 'danger';
      if (field.trickRoom && (field.trickRoomTurnsLeft || 0) === 2) return 'warn';
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
        this._appendChild(card, this._el('span', 'st-cancel-head', 'Cancel window: the deep pass disagrees'));
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
      // Removing a sheet child changes the rail's count, so refresh the header. No-op when
      // the mobile sheet is not mounted (desktop, lobbies, tests without a sheet).
      try { this._refreshPanelHeaders(); } catch (e) { /* detached */ }
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
      this._lastPreview = preview || null;
      this._renderMatchup(preview);
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
      // A bar priced against a BENCH body must name that body on its face. The same 10-12%
      // means "your Fire Punch barely scratches this Garchomp" or "the engine is broken",
      // depending on information the bar used to hide in a tooltip.
      const benchTarget = preview && preview.target && preview.target.isActive === false && preview.target.species;
      const suffix = benchTarget ? ' vs ' + safeString(preview.target.species)
        : (verdict ? ' (' + verdict + ')' : '');
      let node = bar;
      if (!node) {
        node = this._el('span', 'st-lethal-bar');
        if (!node) return;
        if (node.setAttribute) node.setAttribute(LETHAL_BAR_ATTR, '1');
        if (typeof btn.appendChild === 'function') btn.appendChild(node);
      }
      node.textContent = min + ' \u2013 ' + max + '%' + suffix;
      // Publish the fill percentage (max of the roll range, clamped to 0..100) as a CSS custom
      // property so the bar's ::before can draw a real progress fill behind the text. Set on
      // the element's inline style — pure visual data, no class or text change, so it cannot
      // affect any textContent or className assertion the regression suite makes.
      if (node.style && typeof node.style.setProperty === 'function') {
        const fill = U.clamp(max, 0, 100);
        node.style.setProperty('--st-lethal-fill', fill + '%');
      }
      if (node.setAttribute) {
        node.setAttribute('title', safeString(target.species) + ': ' + min + '-' + max + '% vs ' +
          safeString(line.name) + (line.koChancePct ? ' (' + U.round1(line.koChancePct) + '% KO)' : ''));
      }
    }

    /**
     * renderBenchTargets(targets, selectedId) -> the strip element (or null).
     * The opponent's full revealed roster as sprite cards. Tapping an inactive, living body
     * previews moves against it; the active or fainted cards remain visual roster context.
     * An empty list removes the strip.
     */
    renderBenchTargets(targets, selectedId, previewTarget) {
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
        // intoSheet=false: the bench strip is the always-on tappable band on mobile. Parked
        // in the console on desktop.
        strip = this._mountBand(strip, false);
      }
      this._nodes.benchStrip = strip;
      if (strip.setAttribute) {
        strip.setAttribute('role', 'group');
        strip.setAttribute('aria-label', 'Opponent revealed roster');
      }
      this.selectedBenchId = (selectedId === undefined || selectedId === null) ? '' : safeString(selectedId);
      this._clearChildren(strip);
      /* A bench pick retargets EVERY move bar, so the strip has to say what the bars are
       * pointing at. Without this caption the numbers look like they are for the active body,
       * and a defensive Garchomp's 10-12% reads as a wrong prediction for Serperior. */
      const benchTarget = (previewTarget && previewTarget.isActive === false) ? previewTarget : null;
      if (benchTarget) {
        const caption = this._el('div', 'st-bench-caption',
          'Preview against ' + safeString(benchTarget.species));
        if (caption) {
          if (typeof strip.appendChild === 'function') strip.appendChild(caption);
          if (strip.setAttribute) strip.setAttribute('data-st-preview-target', safeString(benchTarget.species));
        }
      } else if (strip.setAttribute) {
        strip.removeAttribute && strip.removeAttribute('data-st-preview-target');
      }
      if (benchTarget) {
        const reset = this._el('button', 'st-preview-reset', 'Return to active');
        if (reset) {
          reset.setAttribute && reset.setAttribute('type', 'button');
          reset.addEventListener && reset.addEventListener('click', function () { this.benchTapped(this.selectedBenchId); }.bind(this));
          strip.appendChild(reset);
        }
      }
      const rosterLabel = this._el('div', 'st-roster-label', 'Opponent');
      if (rosterLabel) strip.appendChild(rosterLabel);
      const count = Math.min(list.length, cap > 0 ? cap : list.length);
      for (let i = 0; i < count; i++) {
        const target = list[i];
        const id = U.toID(target.id || target.species || '');
        const pill = this._el(target.fainted || target.isActive ? 'div' : 'button', 'st-bench-pill');
        if (!pill) continue;
        if (pill.setAttribute) {
          if (!target.fainted && !target.isActive) pill.setAttribute('type', 'button');
          pill.setAttribute(BENCH_PILL_ATTR, id);
          pill.setAttribute('aria-label', (target.isActive ? 'Active opponent' : target.fainted ? 'Fainted opponent' : 'Preview our moves against') + ' ' + safeString(target.species));
        }
      const species = safeString(target.species || target.id || 'Unknown');
      const hp = roundPct(target.hpPercent);
      const slugs = spriteSlugs(species);
        const sprite = this._el('img', 'st-bench-sprite');
        if (sprite) {
          sprite.setAttribute && sprite.setAttribute('alt', '');
          sprite.setAttribute && sprite.setAttribute('aria-hidden', 'true');
          sprite.setAttribute && sprite.setAttribute('loading', 'lazy');
          sprite.setAttribute && sprite.setAttribute('decoding', 'async');
          sprite.setAttribute && sprite.setAttribute('data-species-sprite', slugs.form);
          sprite.src = 'https://play.pokemonshowdown.com/sprites/gen5/' + encodeURIComponent(slugs.form) + '.png';
          // Some regional and battle forms have no dedicated PNG. Try the base species once,
          // then remove the image and leave its designed placeholder rather than a broken icon.
          sprite.onerror = function () {
            if (slugs.form !== slugs.base && sprite.getAttribute('data-st-base-fallback') !== '1') {
              sprite.setAttribute('data-st-base-fallback', '1');
              sprite.src = 'https://play.pokemonshowdown.com/sprites/gen5/' + encodeURIComponent(slugs.base) + '.png';
              return;
            }
              if (sprite.parentNode && typeof sprite.parentNode.removeChild === 'function') {
              sprite.parentNode.removeChild(sprite);
            }
            this.classList && this.classList.add('st-sprite-missing');
          }.bind(pill);
          if (typeof pill.appendChild === 'function') pill.appendChild(sprite);
        }
        const details = this._el('span', 'st-bench-details');
        const name = this._el('span', 'st-bench-name', species);
        // The active body is tagged IN its own line. The old absolute "ACTIVE" chip sat on
        // top of the name (it covered the first letters of "Landorus-Therian") and the sprite
        // underneath it, which is exactly the kind of overlap that reads as a broken HUD.
        const health = this._el('span', 'st-bench-health', target.fainted ? 'Fainted' : (target.isActive ? 'Active ' : '') + hp + '%');
        const meter = this._el('span', 'st-bench-meter');
        const fill = this._el('span', 'st-bench-meter-fill');
        if (fill && fill.style) fill.style.width = U.clamp(hp, 0, 100) + '%';
        if (meter && fill && typeof meter.appendChild === 'function') meter.appendChild(fill);
        if (details && typeof details.appendChild === 'function') {
          if (name) details.appendChild(name);
          if (health) details.appendChild(health);
          if (meter) details.appendChild(meter);
          pill.appendChild(details);
        }
        if (pill.setAttribute) {
          pill.setAttribute('aria-label', (target.isActive ? 'Active opponent ' : target.fainted ? 'Fainted opponent ' : 'Preview our moves against ') + species + ', ' + hp + '% HP');
          if (!target.fainted && !target.isActive) pill.setAttribute('aria-pressed', id === this.selectedBenchId ? 'true' : 'false');
          pill.setAttribute('title', species + ' · ' + hp + '% HP');
        }
        if (target.fainted) this._addClass(pill, 'st-fainted');
        if (target.isActive) this._addClass(pill, 'st-active');
        if (id && id === this.selectedBenchId) this._addClass(pill, 'st-selected');
        if (typeof strip.appendChild === 'function') strip.appendChild(pill);
      }
      this.bindBenchTargets();
      // The strip is `flex-wrap`, so a 6-mon roster is 2 rows and the strip is ~121px tall
      // instead of ~65px. Everything that sits above it -- the TR chip's stacking offset
      // and the mobile sheet's dock -- is derived from --st-strip-h and --st-band-top,
      // both of which are MEASURED from the live rect. Without this re-measure the last
      // published value is whatever the previous roster looked like, so the chip rides up
      // over the pills and the sheet docks into the wrong place until the next resize.
      this._syncChipBand();
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
      this._inspectedId = safeString(id);
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
          // Active and fainted roster cards are informational divs. Even a synthetic click
          // or a future delegated listener must never select a non-bench body.
          if (id && (!pill.tagName || pill.tagName === 'BUTTON')) self.benchTapped(id);
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
        // Route through _mountBand so the row lands inside the mobile sheet (or desktop
        // console) instead of as a free-floating viewport-fixed node over the battle scene.
        row = this._mountBand(row);
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

    /* --------------------------------------------------------- opponent scout */

    /**
     * renderScoutLog(entries) -> the card element (or null).
     *
     * The observation ledger: one row per revealed opponent with the moves it has actually
     * used, the item it has actually shown and the ability it has actually revealed. This is
     * deliberately NOT a candidate-set summary — the player needs the facts the battle has
     * printed, not another probability. `null` or an empty list removes the card.
     *
     * entries = [{ species, hpPercent, fainted, isActive, moves: [], item, suspectedItem, ability }]
     */
    renderScoutLog(entries) {
      if (!this._document()) return null;
      const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
      if (!list.length) return this.clearScoutLog();
      let card = this._nodes.scout || this._qs('.st-scout-card');
      if (!card) {
        card = this._el('details', 'st-scout-card');
        if (!card) return null;
        if (card.setAttribute) card.setAttribute(SCOUT_ATTR, '1');
        card = this._mountBand(card);
      }
      this._nodes.scout = card;
      this._clearChildren(card);
      this._appendChild(card, this._el('summary', 'st-scout-head', 'Scouting notes'));
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const row = this._el('div', 'st-scout-row');
        if (!row) continue;
        if (e.isActive) this._addClass(row, 'st-scout-active');
        const head = this._el('div', 'st-scout-name');
        if (head) {
          head.textContent = safeString(e.species) +
            (e.fainted ? ' / FAINTED' : ' / ' + roundPct(e.hpPercent) + '%') +
            (e.isActive ? ' / ACTIVE' : '');
          this._appendChild(row, head);
        }
        const line = function (self, label, value, cls) {
          if (!value) return;
          const el = self._el('div', 'st-scout-line' + (cls ? ' ' + cls : ''));
          if (!el) return;
          el.textContent = label + ' ' + value;
          self._appendChild(row, el);
        };
        line(this, 'MOVES', (e.moves || []).join(' · '), 'st-scout-moves');
        if (e.item) line(this, 'ITEM', e.item, 'st-scout-item');
        else if (e.suspectedItem) line(this, 'ITEM?', e.suspectedItem, 'st-scout-item');
        line(this, 'ABILITY', e.ability, 'st-scout-ability');
        if (!row.children || !row.children.length) continue;
        this._appendChild(card, row);
      }
      return card;
    }

    clearScoutLog() {
      const card = this._nodes.scout || this._qs('.st-scout-card');
      this._nodes.scout = null;
      return this._dropNode(card);
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
        row.textContent = safeString(r.label) + ': ' + safeString(r.value);
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
        // Route through _mountBand so the overlord pill lands in the mobile sheet instead of
        // painting over the foe's HP bar at the top of the arena (measured: 25% coverage of
        // the right trainersprite and 93% of the left HP bar on classic before the fix).
        el = this._mountBand(el);
      }
      this._nodes.overlord = el;
      el.textContent = 'SUPREME OVERLORD / +' + roundPct(gauge.percentBoost) + '% (' +
        roundPct(gauge.fallen) + ' fallen) \u2014 ' + roundPct(gauge.effectiveAtk) + ' Atk';
      if (el.setAttribute) {
        el.setAttribute('title', safeString(gauge.species) + ' Supreme Overlord gauge');
      }
      return el;
    }

    _syncChipBand() {
      const doc = this._document();
      if (!doc || !doc.documentElement) return null;
      this._syncPageKind();
      this._syncPlacement();
      return 0;
    }

    _restoreControls() {
      const held = this._scrollControls;
      if (!held) return;
      held.node.style.maxHeight = held.maxHeight;
      held.node.style.overflowY = held.overflowY;
      this._scrollControls = null;
    }

    _restoreLog() {
      const held = this._dockLog;
      if (!held) return;
      for (const item of [held].concat(held.extra || [])) {
        for (const key of Object.keys(item.styles)) item.node.style[key] = item.styles[key];
      }
      this._dockLog = null;
    }

    _syncPlacement() {
      const doc = this._document();
      if (!doc || !doc.documentElement || !doc.documentElement.style || !doc.documentElement.style.setProperty) return;
      const view = doc.defaultView || window;
      const root = this._battleRoot();
      const arena = this._qs('.battle', root);
      const controls = this._controls();
      if (!arena || !controls || !arena.getBoundingClientRect) { this._restoreLog(); this._restoreControls(); return; }
      const viewport = view.visualViewport;
      doc.documentElement.style.setProperty('--st-viewport-top', (viewport ? viewport.offsetTop : 0) + 'px');
      doc.documentElement.style.setProperty('--st-viewport-left', (viewport ? viewport.offsetLeft : 0) + 'px');
      const controlStyle = view.getComputedStyle(controls);
      if (controlStyle.position === 'absolute' || controlStyle.position === 'fixed') {
        if (this._scrollControls && this._scrollControls.node !== controls) this._restoreControls();
        if (!this._scrollControls) this._scrollControls = { node: controls, maxHeight: controls.style.maxHeight, overflowY: controls.style.overflowY };
        const viewport = view.visualViewport;
        const height = viewport ? viewport.height : view.innerHeight;
        const top = controls.getBoundingClientRect().top;
        controls.style.maxHeight = Math.max(48, height - Math.max(0, top) - 12) + 'px';
        controls.style.overflowY = 'auto';
      } else this._restoreControls();
      const ar = arena.getBoundingClientRect();
      const rr = root && root.getBoundingClientRect ? root.getBoundingClientRect() : null;
      let right = Math.min(view.innerWidth, rr && rr.width > 0 ? rr.right : view.innerWidth);
      const other = this._qs('#showdex-root, #showdex');
      if (other && other.getBoundingClientRect) {
        const rect = other.getBoundingClientRect();
        if (rect.width >= 200 && rect.width < view.innerWidth * .7 && rect.height > 150 && rect.left > ar.right) right = Math.min(right, rect.left);
      }
      const panel = this._nodes.console;
      const panelWidth = panel && panel.style.width ? U.clamp(parseFloat(panel.style.width) || 344, 304, 480) : Math.min(424, Math.max(344, right - ar.right - 216));
      doc.documentElement.style.setProperty('--st-panel-width', panelWidth + 'px');
      const space = right - ar.right;
      const side = this.resolvedLayout === 'desktop' && space >= panelWidth + 216;
      doc.documentElement.setAttribute('data-st-dock', side ? 'side' : 'inline');
      const visible = view.visualViewport;
      doc.documentElement.style.setProperty('--st-visible-height', (visible ? visible.height : view.innerHeight) + 'px');
      doc.documentElement.style.setProperty('--st-dock-top', Math.max(8, ar.top) + 'px');
      doc.documentElement.style.setProperty('--st-dock-right', Math.max(8, view.innerWidth - right + 8) + 'px');
      if (panel) {
        if (side) {
          if (panel.parentNode !== doc.body) doc.body.appendChild(panel);
          const log = this._qs('.battle-log', root);
          if (this._dockLog && this._dockLog.node !== log) this._restoreLog();
          if (log && view.getComputedStyle(log).position === 'absolute') {
            if (!this._dockLog) this._dockLog = { node: log, styles: { right: log.style.right, width: log.style.width } };
            log.style.right = (panelWidth + 16) + 'px';
            log.style.width = 'auto';
            if (!this._dockLog.extra) this._dockLog.extra = [];
            for (const node of this._qsa('.battle-log-add, .chat-log-add, .battle-userlist, .userlist', root)) {
              if (view.getComputedStyle(node).position !== 'absolute') continue;
              if (node.getBoundingClientRect().left < ar.right - 2) continue;
              if (!this._dockLog.extra.some(function (held) { return held.node === node; })) {
                this._dockLog.extra.push({ node: node, styles: { right: node.style.right } });
              }
              node.style.right = (panelWidth + 16) + 'px';
            }
          }
        } else {
          this._restoreLog();
          if (panel.parentNode !== controls) controls.appendChild(panel);
        }
      } else this._restoreLog();
      this._syncModalState(this.resolvedLayout === 'mobile' && this._sheetOpen);
      if (this.resolvedLayout === 'mobile') {
        const strip = this._nodes.benchStrip;
        const menu = this._qs('.movemenu', controls);
        if (strip && this._sheetOpen && this._nodes.sheet) {
          if (strip.parentNode !== this._nodes.sheet) this._nodes.sheet.appendChild(strip);
        } else if (strip && menu && controls.insertBefore && menu.parentNode === controls) {
          if (strip.parentNode !== controls || strip.nextElementSibling !== menu) controls.insertBefore(strip, menu);
        } else if (strip && strip.parentNode !== controls) controls.appendChild(strip);
        const sheet = this._nodes.sheet;
        const chip = this._nodes.chip;
        const host = this._sheetOpen && sheet ? sheet : controls;
        if (chip && chip.parentNode !== host) host.appendChild(chip);
        if (sheet) {
          const parent = this._sheetOpen ? doc.body : controls;
          if (sheet.parentNode !== parent) parent.appendChild(sheet);
        }
      }
      const watched = root || arena;
      if (view.ResizeObserver && this._layoutRoot !== watched) {
        if (this._roomResize) this._roomResize.disconnect();
        this._layoutRoot = watched;
        this._roomResize = new view.ResizeObserver(function () { this._applyResolvedLayout(); this._syncPlacement(); }.bind(this));
        this._roomResize.observe(watched);
      }
      const toolbar = this._nodes.toolbar;
      const host = this._nodes.console || this._nodes.sheet;
      if (toolbar && host && toolbar.parentNode !== host) host.appendChild(toolbar);
      this._organizeCenter(host);
    }

    resetControlCenter() {
      this._centerState = null;
      this._renderedCenterKey = null;
      this._centerMeta = {};
      this._readout = null;
      this._readoutTurn = null;
      this._inspectedId = null;
      this._lastRanked = [];
    }

    renderControlCenter(state, readout, meta) {
      if (!state || !this._document()) return;
      this._centerState = state;
      this._battleState = state;
      if (readout !== undefined) this._readout = readout;
      if (meta) this._centerMeta = meta;
      const host = this._nodes.console || this._nodes.sheet;
      if (!host) return;
      this._ensureCenterNavigation(host);
      this._renderCenterView();
      this._organizeCenter(host);
    }

    _ensureCenterNavigation(host) {
      let nav = this._nodes.centerNav;
      if (!nav) {
        nav = this._el('nav', 'st-center-nav');
        if (!nav) return;
        nav.setAttribute && nav.setAttribute('aria-label', 'Control center sections');
        for (const [id, title, number] of [['battle', 'Battle', '01'], ['intel', 'Intel', '02'], ['field', 'Field', '03'], ['review', 'Review', '04']]) {
          const button = this._el('button', 'st-center-tab');
          button.setAttribute && button.setAttribute('type', 'button');
          button.setAttribute && button.setAttribute('data-st-view-button', id);
          this._appendChild(button, this._el('span', 'st-nav-number', number));
          this._appendChild(button, this._el('span', '', title));
          button.addEventListener && button.addEventListener('click', function () { this.setCenterView(id); }.bind(this));
          this._appendChild(nav, button);
        }
        this._nodes.centerNav = nav;
      }
      if (nav.parentNode !== host) this._appendChild(host, nav);
    }

    setCenterView(view) {
      if (!['battle', 'intel', 'field', 'review'].includes(view)) return false;
      this._centerView = view;
      this._renderCenterView();
      const host = this._nodes.console || this._nodes.sheet;
      this._organizeCenter(host);
      if (host) host.scrollTop = 0;
      return true;
    }

    _organizeCenter(host) {
      if (!host || !this._nodes.centerNav) return;
      const view = this._centerView || 'battle';
      host.setAttribute && host.setAttribute('data-st-view', view);
      const sections = {
        'st-matchup': 'battle', 'st-action-list': 'battle', 'st-lead-advisory': 'battle', 'st-cancel-alert-card': 'battle',
        'st-intelligence': 'intel', 'st-scout-card': 'intel',
        'st-field-board': 'field', 'tactician-banner': 'field', 'st-format-sentinel': 'field',
        'st-pp-gauge': 'field', 'st-overlord-gauge': 'field', 'st-badge-row': 'field',
        'st-engine-review': 'review', 'st-receipt-card': 'review'
      };
      for (const child of Array.from(host.children || [])) {
        const names = safeString(child.className).split(/\s+/);
        const kind = names.map(function (name) { return sections[name]; }).find(Boolean);
        if (!kind) continue;
        child.setAttribute && child.setAttribute('data-st-section', kind);
        child.hidden = kind !== view;
      }
      for (const button of this._qsa('[data-st-view-button]', this._nodes.centerNav)) {
        button.setAttribute('aria-pressed', button.getAttribute('data-st-view-button') === view ? 'true' : 'false');
      }
    }

    _centerSection(key, className, label) {
      let section = this._nodes[key];
      if (!section) {
        section = this._el('section', className);
        if (!section) return null;
        section.setAttribute && section.setAttribute('aria-label', label);
        this._nodes[key] = this._mountBand(section);
      }
      this._clearChildren(section);
      return section;
    }

    _centerHeading(section, index, title, subtitle) {
      this._appendChild(section, this._el('div', 'st-chapter-number', index));
      this._appendChild(section, this._el('h2', 'st-chapter-title', title));
      if (subtitle) this._appendChild(section, this._el('p', 'st-chapter-subtitle', subtitle));
    }

    _centerPair(parent, label, value, className) {
      const row = this._el('div', 'st-fact-row' + (className ? ' ' + className : ''));
      this._appendChild(row, this._el('span', 'st-fact-label', label));
      this._appendChild(row, this._el('span', 'st-fact-value', value));
      this._appendChild(parent, row);
    }

    _centerText(value) {
      return safeString(value).replace(/\u2014/g, ' / ').replace(/=>/g, ':').replace(/\blaplace\.[a-zA-Z.]+/g, 'engine settings');
    }

    _renderCenterView() {
      const state = this._centerState;
      if (!state) return;
      if (this.resolvedLayout === 'mobile' && !this._sheetOpen) return;
      if (this.resolvedLayout === 'desktop' && !this._panelOpen) return;
      const view = this._centerView || 'battle';
      const stats = this._centerMeta.stats || {};
      const key = [view, state.revision, state.turn, this._inspectedId, stats.evaluations, stats.ponders].join('|');
      if (key === this._renderedCenterKey && this._renderedCenterState === state && this._renderedCenterReadout === this._readout) return;
      this._renderedCenterKey = key;
      this._renderedCenterState = state;
      this._renderedCenterReadout = this._readout;
      const host = this._nodes.console || this._nodes.sheet;
      const top = host ? host.scrollTop : 0;
      const openCandidates = this._qsa('.st-candidate', host).map(function (node) { return [node.getAttribute('data-st-candidate'), node.open]; });
      const reports = new Map(this._qsa('.st-engine-report', host).map(function (node) { return [node.getAttribute('data-st-report'), node.open]; }));
      if (view === 'intel') this._renderIntelligence(state);
      else if (view === 'field') this._renderFieldBoard(state);
      else if (view === 'review') this._renderEngineReview(state);
      else this._renderActionList(state);
      for (const node of this._qsa('.st-candidate', host)) {
        const held = openCandidates.find(function (item) { return item[0] === node.getAttribute('data-st-candidate'); });
        if (held) node.open = held[1];
      }
      for (const node of this._qsa('.st-engine-report', host)) {
        const path = node.getAttribute('data-st-report');
        if (reports.has(path)) node.open = reports.get(path);
      }
      if (host) host.scrollTop = top;
    }

    _renderActionList(state) {
      const section = this._centerSection('actionList', 'st-action-list', 'Action comparisons');
      if (!section) return;
      this._appendChild(section, this._el('h3', 'st-section-title', 'Other lines to consider'));
      if (state.formatSupported === false) {
        this._appendChild(section, this._el('p', 'st-empty', 'Analysis is unavailable for this format. Observed battle information remains available in Intel and Field.'));
        return;
      }
      const actions = this._lastRanked || [];
      if (!actions.length) this._appendChild(section, this._el('p', 'st-empty', 'Action comparisons appear when your next decision arrives.'));
      for (const action of actions) {
        const row = this._el('div', 'st-action-row' + (action.isVetoed ? ' st-action-veto' : ''));
        this._centerPair(row, (action.kind === 'switch' ? 'Switch to ' : '') + safeString(action.name), action.isVetoed ? 'Avoid' : pct(action.confidence));
        const reason = action.vetoReason || this._lastReasonByMove[U.toID(action.moveId || action.name)];
        if (reason) this._appendChild(row, this._el('p', 'st-action-reason', this._centerText(reason)));
        this._appendChild(section, row);
      }
      this._appendChild(section, this._el('p', 'st-range-note', 'Percentages describe the engine\'s preference between actions.'));
    }

    _renderIntelligence(state) {
      const section = this._centerSection('intelligence', 'st-intelligence', 'Opponent intelligence and set pruning');
      if (!section) return;
      this._centerHeading(section, '02 / INTELLIGENCE', 'Opponent intelligence', 'Revealed facts, surviving sets, and the evidence behind each deduction.');
      const team = (state.oppTeam || []).filter(Boolean);
      const chosen = team.find(function (mon) { return U.toID(mon.id || mon.species) === this._inspectedId; }, this)
        || (state.active && state.active.opp) || team[0];
      const label = this._el('label', 'st-inspector-label', 'Inspect opponent');
      label && label.setAttribute && label.setAttribute('for', 'st-intel-picker');
      this._appendChild(section, label);
      const selector = this._el('select', 'st-intel-selector');
      if (selector && selector.setAttribute) {
        selector.setAttribute('id', 'st-intel-picker');
        selector.setAttribute('data-st-inspector', '1');
        selector.setAttribute('aria-label', 'Inspect opponent Pokemon');
      }
      for (const mon of team) {
        const option = this._el('option', '', (mon.species || mon.id) + (mon.fainted ? ' / Fainted' : mon.isActive ? ' / Active' : ''));
        if (option) option.value = U.toID(mon.id || mon.species);
        this._appendChild(selector, option);
      }
      if (selector && chosen) selector.value = U.toID(chosen.id || chosen.species);
      selector && selector.addEventListener && selector.addEventListener('change', function (event) {
        this._inspectedId = event.target.value;
        this._renderCenterView();
        this._organizeCenter(this._nodes.console || this._nodes.sheet);
        const selected = this._qs('[data-st-inspector]', this._nodes.intelligence);
        if (selected && selected.focus) selected.focus({ preventScroll: true });
      }.bind(this));
      this._appendChild(section, selector);
      if (!chosen) { this._appendChild(section, this._el('p', 'st-empty', 'Opponent information appears as Pokemon are revealed.')); return; }
      this._appendChild(section, this._el('h3', 'st-inspect-name', chosen.species));
      const sets = Array.isArray(chosen.candidateSets) ? chosen.candidateSets.slice().sort(function (a, b) { return (b.weight || 0) - (a.weight || 0); }) : [];
      const pool = (this._centerMeta.pools || {})[chosen.id] || {};
      const total = typeof pool.seeded === 'number' ? pool.seeded : null;
      const counter = this._el('div', 'st-pool-counter');
      const hasPool = total !== null || sets.length > 0;
      this._appendChild(counter, this._el('strong', 'st-pool-number', hasPool ? sets.length : '?'));
      this._appendChild(counter, this._el('span', 'st-pool-label', hasPool ? (sets.length === 1 ? 'set remaining' : 'sets remaining') + (total === null ? '' : ' / ' + total + ' in the seeded pool') : 'No candidate pool recorded yet'));
      this._appendChild(section, counter);
      this._appendChild(section, this._el('h3', 'st-section-title', 'Observed'));
      this._centerPair(section, 'Item', chosen.confirmedItem || (chosen.itemless ? 'No held item' : 'Unrevealed'));
      this._centerPair(section, 'Ability', chosen.revealedAbility || 'Unrevealed');
      this._centerPair(section, 'Moves', (chosen.revealedMoves || []).join(' / ') || 'None revealed');
      this._centerPair(section, 'Status', chosen.fainted ? 'Fainted' : chosen.status || 'Healthy');
      this._appendChild(section, this._el('h3', 'st-section-title', 'Recorded deductions'));
      const notes = [];
      if (chosen.speedFloor || (chosen.speedEvidence || []).length) notes.push('Speed bracket: ' + (chosen.speedFloor || '?') + ' to ' + (chosen.speedCeiling || '?'));
      if (chosen.evPinned && chosen.pinnedEvs) notes.push('EV spread consistent across surviving sets: ' + this._evText(chosen.pinnedEvs));
      for (const key of ['prunedReasons', 'speedEvidence', 'abilityEvidence']) {
        for (const note of chosen[key] || []) {
          const text = typeof note === 'string' ? note : note.reason || note.detail || '';
          if (text && !notes.includes(text)) notes.push(text);
        }
      }
      if (!notes.length) notes.push('Additional deductions appear as the battle reveals more evidence.');
      if (notes.some(function (note) { return /all candidates eliminated|falling back/i.test(note); })) {
        this._appendChild(section, this._el('p', 'st-pool-warning', 'The evidence exhausted the candidate pool. A fallback pool is in use; set estimates remain uncertain.'));
      }
      const evidence = this._el('ol', 'st-evidence-list');
      for (const note of notes) this._appendChild(evidence, this._el('li', '', this._centerText(note)));
      this._appendChild(section, evidence);
      this._appendChild(section, this._el('h3', 'st-section-title', 'Surviving candidates'));
      this._appendChild(section, this._el('p', 'st-range-note', 'Candidate details are model estimates. Observed facts are listed above.'));
      sets.forEach(function (set, i) {
        const detail = this._el('details', 'st-candidate');
        detail.setAttribute && detail.setAttribute('data-st-candidate', U.toID(chosen.id || chosen.species) + ':' + safeString(set.id || i));
        if (i === 0) detail.setAttribute && detail.setAttribute('open', '');
        const title = String(i + 1).padStart(2, '0') + ' / ' + (set.role || set.id || 'Candidate') + (set.item ? ' / ' + set.item : ' / Itemless');
        this._appendChild(detail, this._el('summary', '', title));
        this._centerPair(detail, 'Ability', set.ability || 'Unknown');
        this._centerPair(detail, 'Nature', set.nature || 'Unknown');
        this._centerPair(detail, 'EVs', this._evText(set.evs));
        if (set.ivs) this._centerPair(detail, 'IVs', this._evText(set.ivs));
        this._centerPair(detail, 'Moves', (set.moves || []).join(' / ') || 'Unknown');
        this._appendChild(section, detail);
      }, this);
      if (!sets.length) this._appendChild(section, this._el('p', 'st-empty', 'A candidate pool has not been recorded for this Pokemon.'));
    }

    _evText(evs) {
      if (!evs) return 'Unknown';
      const labels = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
      return Object.keys(labels).filter(function (key) { return typeof evs[key] === 'number'; })
        .map(function (key) { return evs[key] + ' ' + labels[key]; }).join(' / ') || 'Unknown';
    }

    _renderFieldBoard(state) {
      const section = this._centerSection('fieldBoard', 'st-field-board', 'Field conditions and battle pressure');
      if (!section) return;
      const field = state.field || {};
      this._centerHeading(section, '03 / FIELD', 'Field conditions', 'Timers and conditions come from the observed battle state.');
      const turn = this._el('div', 'st-turn-register');
      this._appendChild(turn, this._el('span', '', 'TURN'));
      this._appendChild(turn, this._el('strong', '', String(state.turn || 0).padStart(2, '0')));
      this._appendChild(section, turn);
      this._centerPair(section, 'Trick Room', field.trickRoom ? safeString(field.trickRoomTurnsLeft) + ' turns remaining' : 'Inactive');
      this._centerPair(section, 'Weather', field.weather ? field.weather + (typeof field.weatherTurnsLeft === 'number' ? ' / ' + field.weatherTurnsLeft + ' turns' : ' / duration unknown') : 'Clear');
      this._centerPair(section, 'Terrain', field.terrain ? field.terrain + (typeof field.terrainTurnsLeft === 'number' ? ' / ' + field.terrainTurnsLeft + ' turns' : ' / duration unknown') : 'None');
      this._centerPair(section, 'Gravity', field.gravity ? 'Active' : 'Inactive');
      for (const [side, name] of [[state.mySide || 'p1', 'Your side'], [state.oppSide || 'p2', 'Opponent side']]) {
        this._appendChild(section, this._el('h3', 'st-section-title', name));
        const hazards = (field.hazards || {})[side] || {};
        const screens = (field.screens || {})[side] || {};
        const labels = { rocks: 'Stealth Rock', spikes: 'Spikes', toxicspikes: 'Toxic Spikes', stickyweb: 'Sticky Web', steelspikes: 'Steel Spikes' };
        const active = Object.keys(labels).filter(function (key) { return hazards[key]; }).map(function (key) { return labels[key] + (typeof hazards[key] === 'number' ? ' (' + hazards[key] + ')' : ''); });
        this._centerPair(section, 'Hazards', active.join(' / ') || 'None');
        const screenNames = { reflect: 'Reflect', lightscreen: 'Light Screen', auroraveil: 'Aurora Veil' };
        this._centerPair(section, 'Screens', Object.keys(screenNames).filter(function (key) { return screens[key]; }).map(function (key) { return screenNames[key]; }).join(' / ') || 'None');
        this._centerPair(section, 'Tailwind', field.tailwind && field.tailwind[side] ? 'Active' : 'Inactive');
        for (const [key, label] of [['delayedMoves', 'Incoming delayed move'], ['wish', 'Pending Wish']]) {
          const pending = field[key] && field[key][side];
          if (pending) this._report(section, label, pending, 0);
        }
      }
      const tempo = this._readout && this._readout.tempo;
      if (tempo) {
        this._appendChild(section, this._el('h3', 'st-section-title', 'Engine pressure estimates'));
        const labels = { v1: 'Trick Room urgency', v2: 'Board initiative', v3: 'Consecutive Protect decay', v4: 'Protect / stall tendency', v5: 'Threat difference', v6: 'Switch pressure', v7: 'Passive chip difference', v8: 'Setter health', v9: 'Win condition health', v10: 'Trick Room turn cost' };
        for (const key of Object.keys(labels)) {
          if (typeof tempo[key] === 'number') this._centerPair(section, labels[key], U.round2(tempo[key]));
        }
      }
    }

    _report(parent, label, value, depth) {
      if (value === undefined || value === null) {
        this._centerPair(parent, label, 'No report for this turn');
        return;
      }
      if (typeof value !== 'object') {
        this._centerPair(parent, label, typeof value === 'boolean' ? (value ? 'Yes' : 'No') : this._centerText(value));
        return;
      }
      const detail = this._el('details', 'st-engine-report');
      const parentPath = parent.getAttribute ? parent.getAttribute('data-st-report') || '' : '';
      detail.setAttribute && detail.setAttribute('data-st-report', parentPath + '/' + label);
      this._appendChild(detail, this._el('summary', '', label));
      if (depth > 4) { this._appendChild(detail, this._el('p', '', 'Additional search branches are represented by the parent summary.')); this._appendChild(parent, detail); return; }
      const names = { enabled: 'Enabled', solved: 'Solved', isMate: 'Forced win proved', principalVariation: 'Principal line', pv: 'Principal line', targetSpecies: 'Target', targetId: 'Target', kind: 'Action', freq: 'Frequency', elapsedMs: 'Search time (ms)', observed: 'Replies observed', samples: 'Samples', switchFactor: 'Switch model adjustment', worlds: 'Set combinations', nodes: 'Positions searched', reason: 'Reason', label: 'Assessment', lowerBound: 'Lower bound', upperBound: 'Upper bound', gain: 'Information gain', bits: 'Uncertainty (bits)', score: 'Evaluation', tau: 'Response softness', weight: 'Model weight' };
      const entries = Object.entries(value);
      if (!entries.length) this._appendChild(detail, this._el('p', 'st-empty', 'No data recorded.'));
      for (const [key, item] of entries) {
        if (key === 'dims' || key === 'weights' || key === 'matrix' || key === 'worlds') continue;
        const title = Array.isArray(value) ? (item && (item.name || item.species || item.move)) || 'Line ' + (Number(key) + 1)
          : names[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, function (c) { return c.toUpperCase(); });
        this._report(detail, safeString(title), item, depth + 1);
      }
      this._appendChild(parent, detail);
    }

    _renderEngineReview(state) {
      const section = this._centerSection('engineReview', 'st-engine-review', 'Engine reasoning and search reports');
      if (!section) return;
      this._centerHeading(section, '04 / REVIEW', 'Decision record', 'Inspect the models, searches, and evidence used for this decision.');
      const readout = this._readout;
      if (!readout || state.formatSupported === false) { this._appendChild(section, this._el('p', 'st-empty', 'Search reports appear after a supported decision is evaluated.')); return; }
      this._centerPair(section, 'Decision recorded', typeof this._readoutTurn === 'number' ? 'Turn ' + this._readoutTurn : 'Current decision');
      this._centerPair(section, 'Evaluation passes', this._centerMeta.stats && this._centerMeta.stats.evaluations !== undefined ? this._centerMeta.stats.evaluations : 'Unknown');
      this._centerPair(section, 'Set combinations sampled', (readout.worlds || []).length);
      this._centerPair(section, 'Evaluation time', typeof readout.elapsedMs === 'number' ? readout.elapsedMs + ' ms' : 'Unknown');
      const reports = [
        ['Opponent action mix', readout.oppStrategy], ['Ranked action evaluations', readout.ranked], ['Opponent tendencies', readout.profile],
        ['Information gained by scouting', readout.scouting], ['Win condition / blocker', readout.wincon],
        ['Endgame search', readout.endgame], ['Two-turn search', readout.beam2Ply],
        ['Opponent timing', state.clock], ['Clock prior', readout.clock], ['Deeper pass', this._centerMeta.ponder],
        ['Response model', readout.qre], ['Surprise model', readout.surpriseMask], ['Opponent prior', readout.nashPrior],
        ['Exploit adjustment', readout.exploitBlend], ['Forced-win promotion', readout.matePromotion]
      ];
      for (const [label, value] of reports) this._report(section, label, value, 0);
    }

    _syncModalState(open) {
      const doc = this._document();
      if (!doc || !doc.body) return;
      const currentRoot = this._battleRoot() || this._controls();
      if (open && this._modalHeld && this._modalHeld.root !== currentRoot) this._syncModalState(false);
      if (open && !this._modalHeld) {
        const root = this._battleRoot() || this._controls();
        this._modalHeld = { root: root, inert: root ? root.inert : false, overflow: doc.body.style.overflow };
        if (root) root.inert = true;
        doc.body.style.overflow = 'hidden';
      } else if (!open && this._modalHeld) {
        const held = this._modalHeld;
        if (held.root) held.root.inert = held.inert;
        doc.body.style.overflow = held.overflow || '';
        this._modalHeld = null;
      }
      const sheet = this._nodes.sheet;
      if (sheet && sheet.setAttribute) {
        sheet.setAttribute('role', open ? 'dialog' : 'region');
        sheet.setAttribute('aria-label', open ? 'Tactician control center' : 'Open Tactician control center');
        if (open) sheet.setAttribute('aria-modal', 'true');
        else if (sheet.removeAttribute) sheet.removeAttribute('aria-modal');
      }
    }

    _trapCenterFocus(event) {
      const sheet = this._nodes.sheet;
      if (!sheet || !sheet.querySelectorAll) return;
      const items = Array.from(sheet.querySelectorAll('button, summary, textarea, input, select, [tabindex="0"]')).filter(function (node) { return !node.disabled && (!node.getClientRects || node.getClientRects().length); });
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      const active = this._document().activeElement;
      if (!items.includes(active)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    }

    _renderMatchup(preview) {
      let section = this._nodes.matchup;
      if (!preview || !preview.target) {
        this._nodes.matchup = null;
        this._dropNode(section);
        return;
      }
      if (!section) {
        section = this._el('section', 'st-matchup');
        if (!section) return;
        section.setAttribute && section.setAttribute('aria-label', 'Matchup and damage comparison');
        this._nodes.matchup = this._mountBand(section);
      }
      this._clearChildren(section);
      const state = this._battleState || {};
      const pick = (this._lastRanked || []).find(function (a) { return !a.isVetoed; });
      if (pick && state.formatSupported !== false) {
        this._appendChild(section, this._el('div', 'st-eyebrow', preview.target.isActive === false ? 'Suggested play against active opponent' : 'Suggested play'));
        this._appendChild(section, this._el('div', 'st-play-name', (pick.kind === 'switch' ? 'Switch to ' : '') + safeString(pick.name || pick.species || pick.moveId)));
        const reason = this._lastReasonByMove[U.toID(pick.moveId || pick.name)] || pick.reason || pick.vetoReason || '';
        if (reason) this._appendChild(section, this._el('p', 'st-play-reason', reason));
      }
      const mine = state.active && state.active.my;
      this._appendChild(section, this._el('div', 'st-eyebrow st-matchup-heading', preview.target.isActive === false ? 'Damage preview' : 'Current matchup'));
      this._appendChild(section, this._el('div', 'st-matchup-name', (mine ? safeString(mine.species) + ' vs ' : 'Against ') + safeString(preview.target.species)));
      const headings = this._el('div', 'st-damage-head');
      for (const label of ['Your move', 'Damage', 'KO chance']) this._appendChild(headings, this._el('span', '', label));
      this._appendChild(section, headings);
      for (const line of preview.lines || []) {
        const row = this._el('div', 'st-damage-row');
        row.setAttribute && row.setAttribute('data-st-range', U.toID(line.moveId || line.name));
        this._appendChild(row, this._el('span', 'st-damage-name', line.name || line.moveId));
        const range = typeof line.minPercent === 'number' && typeof line.maxPercent === 'number'
          ? roundPct(line.minPercent) + ' - ' + roundPct(line.maxPercent) + '%' : 'Unavailable';
        this._appendChild(row, this._el('span', 'st-damage-range', range));
        this._appendChild(row, this._el('span', 'st-damage-ko', typeof line.koChancePct === 'number' ? roundPct(line.koChancePct) + '%' : 'Unknown'));
        this._appendChild(section, row);
      }
      this._appendChild(section, this._el('p', 'st-range-note', 'Ranges use the current set estimate. Scouting notes show revealed facts.'));
      this._syncPlacement();
    }

    _syncPageKind() {
      const doc = this._document();
      if (!doc || !doc.documentElement) return this._pageKind || 'idle';
      const kind = this._hasBattle() ? 'battle' : 'idle';
      if (kind === this._pageKind) return kind;
      if (kind === 'idle' && this._sheetOpen) { this._sheetOpen = false; this._syncModalState(false); if (this._nodes.sheet) this._nodes.sheet.setAttribute('data-st-sheet-open', '0'); }
      this._pageKind = kind;
      this._applyPageKind();
      return kind;
    }

    _hasBattle() {
      const arena = this._qs('.battle', this._battleRoot());
      return !!(arena && (!arena.getClientRects || arena.getClientRects().length));
    }

    _applyPageKind() {
      const doc = this._document();
      if (!doc || !doc.documentElement) return;
      const battle = (this._pageKind || 'idle') === 'battle';
      if (doc.documentElement.setAttribute) {
        doc.documentElement.setAttribute('data-st-page', battle ? 'battle' : 'idle');
      }
      if (!battle) {
        // Leaving a battle drops any drag offset so the panel re-docks from the new room's
        // measured column instead of reappearing wherever it was parked.
        this._resetPanelOffset();
        this._restoreLog();
        this._restoreControls();
        if (this._nodes.toolbar && doc.body) doc.body.appendChild(this._nodes.toolbar);
      }
    }

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
        el = this._el('details', 'st-pp-gauge');
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

      const headline = this._el('summary', 'st-pp-headline',
        label + ' ' + prefix + ': ' + this._ppText(move));
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
      if (read) return read;
      const moves = Array.isArray(threat.setupMoves) ? threat.setupMoves.filter(Boolean) : [];
      if (!moves.length) return '';
      const hp = typeof threat.theirHp === 'number' && threat.theirHp === threat.theirHp
        ? U.clamp(Math.round(threat.theirHp), 0, 100) + '% HP' : '';
      return 'SETUP THREAT: ' + moves.join(' / ') +
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
        el = this._el('details', 'st-format-sentinel');
        if (!el) return null;
        if (el.setAttribute) el.setAttribute(SENTINEL_ATTR, '1');
        el = this._mountBand(el);
      }
      this._nodes.sentinel = el;
      this._clearChildren(el);

      const head = this._el('summary', 'st-sentinel-head', 'Opponent format mechanics');
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
          const status = SENTINEL_TACTIC_STATES[safeString(t.kind)] || 'NOTE';
          const row = this._el('div', 'st-sentinel-tactic',
            status + ' / ' + safeString(t.label) +
            (t.detail ? '. ' + safeString(t.detail) : ''));
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
      const state = SENTINEL_STATES[burned ? 'burned' : 'live'];
      const who = safeString(m.species);
      const turn = typeof m.turn === 'number' && m.turn === m.turn ? Math.round(m.turn) : null;
      const row = this._el('div', 'st-sentinel-row',
        name + ': ' + state +
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
        this._nodes.toolbar = this._qs('.st-toolbar');
        this._nodes.toggle = this._qs('.team-drawer-toggle');
        this._nodes.teamStatus = this._qs('[data-st-team-status]') || this._qs('.drawer-team-status');
        this._nodes.candidates = this._qs('[data-st-candidates]') || this._qs('.drawer-candidates');
        this._bound = true;
        // Adopted, not built — the signals still have to be bound (see _bindLayoutSignals).
        this._bindLayoutSignals();
        this._bindHotkey();
        this._mountModeToggle();
        return existing;
      }

      const toggle = this._el('button', 'team-drawer-toggle');
      if (toggle) {
        toggle.textContent = 'Team';
        if (toggle.setAttribute) {
          toggle.setAttribute('type', 'button');
          toggle.setAttribute('aria-label', 'Toggle Showdown Tactician panel');
          toggle.setAttribute(DRAWER_ATTR, 'toggle');
        }
      }

      const panel = this._el('div', 'team-drawer ' + HIDDEN_CLASS);
      if (panel && panel.setAttribute) { panel.setAttribute(DRAWER_ATTR, '1'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Team and set estimates'); }

      if (panel) {
        const header = this._el('div', 'drawer-header', 'Showdown Tactician');
        if (header) panel.appendChild(header);        const teamStatus = this._el('div', 'drawer-team-status', 'No team loaded. Paste a Pokepaste below.');
        if (teamStatus) {
          teamStatus.setAttribute && teamStatus.setAttribute('data-st-team-status', '1');
          panel.appendChild(teamStatus);
        }
        this._nodes.teamStatus = teamStatus;

        const textarea = this._el('textarea', 'drawer-team-input');
        if (textarea) {
          textarea.setAttribute && textarea.setAttribute('rows', '8');
          textarea.setAttribute && textarea.setAttribute('aria-label', 'Team in Pokemon Showdown export format');
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

      const toolbar = this._el('div', 'st-toolbar');
      if (toolbar && toggle) toolbar.appendChild(toggle);
      this._nodes.toolbar = this._mount(toolbar);
      this._nodes.toggle = toggle || null;
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
      // Ctrl+8 toggles the readout panel from any room, the way Pokémon Showdown Helper
      // summons its popup. Bound here (not in _setLayout) so a HUD that is only constructed
      // — never bound to a page — installs no listeners at all.
      this._bindHotkey();
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
          btn.setAttribute('aria-label', 'Switch HUD layout between compact and wide');
          btn.setAttribute('data-st-mode-toggle', '1');
        }
        const toolbar = this._nodes.toolbar;
        if (toolbar) toolbar.appendChild(btn); else this._mount(btn);
        this._nodes.modeToggle = btn;
      }
      // The click handler is bound once per node, and re-binding is harmless because the
      // second call replaces the prior one on the same button. Doing it here (not in
      // _bindLayoutSignals) means even a HUD that never had a drawer can still toggle.
      if (btn && btn.addEventListener) {
        const self = this;
        btn.onclick = function () { self.setLayoutMode(self.layoutMode === 'auto' ? 'mobile' : self.layoutMode === 'mobile' ? 'desktop' : 'auto'); };
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
        if (view.visualViewport) view.visualViewport.addEventListener('resize', onLayout, { passive: true });
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
      if (w < bp) return 'mobile';
      if (!viewport) {
        const root = this._battleRoot();
        const arena = this._qs('.battle', root);
        if (arena && arena.getBoundingClientRect) {
          const rect = arena.getBoundingClientRect();
          const room = root && root.getBoundingClientRect ? root.getBoundingClientRect() : null;
          const right = room && room.width > 0 ? Math.min(w, room.right) : w;
          if (rect.width > 0 && right - rect.right < 560) return 'mobile';
        }
      }
      return 'desktop';
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
     * Switches the DOM into the resolved layout. On desktop the band is parked in the
     * `.st-console` and `data-st-layout="desktop"` switches the CSS rules. On mobile the band
     * lives in a collapsible `.st-sheet` docked above the bottom band, so the battle scene is
     * left clear. Drain-then-fill ordering keeps the migration idempotent across resizes.
     */
    _setLayout(resolved) {
      if (resolved !== 'mobile' && resolved !== 'desktop') resolved = 'mobile';
      if (resolved === 'desktop' && this._sheetOpen) { this._sheetOpen = false; this._syncModalState(false); }
      this.resolvedLayout = resolved;
      const doc = this._document();
      if (!doc || !doc.documentElement) return resolved;
      doc.documentElement.setAttribute('data-st-layout', resolved);
      // The mode toggle is mounted by bindDrawer (the "HUD is live" signal), never here:
      // a HUD that is only constructed — never bound to the page — must not leave a button
      // in the document. This only re-labels a button that already exists.
      if (resolved === 'desktop') {
        // Drain the mobile sheet first (it lives in body, not the console) so the console
        // reparent below finds the band nodes in their natural body hosts.
        this._reparentOutOfSheet();
        this._reparentIntoConsole();
      } else {
        this._reparentOutOfConsole();
        this._reparentIntoSheet();
      }
      // Any layout-bound geometry has to be re-measured: the band lift depends on where
      // Showdown's control bar sits, the banner re-anchors to the battle top, and the chip
      // band re-anchors with it.
      try { this._syncChipBand(); } catch (e) { /* detached */ }
      // The page kind decides whether the panel is mounted at all, and it can change
      // without a layout flip (leaving a battle for the lobby does not resize the window).
      this._syncPageKind();
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
          if (el.setAttribute) {
            el.setAttribute('data-st-console', '1');
            el.setAttribute('data-st-console-open', this._panelOpen ? '1' : '0');
            el.setAttribute('role', 'region');
            el.setAttribute('aria-label', 'Battle analysis');
          }
          // Mount into body so it can position relative to the viewport.
          const parent = doc.body || doc.documentElement;
          if (parent && parent.appendChild) parent.appendChild(el);
          // The header is the panel's title bar: it names the panel, counts the cards,
          // collapses on click and drags the panel (see _bindConsoleDrag). One shared
          // builder with the mobile sheet so both layouts read identically.
          const header = this._buildPanelHeader('st-console', function (self) {
            if (self._panelJustDragged) { self._panelJustDragged = false; return; }
            self.togglePanel();
          });
          if (header && typeof el.appendChild === 'function') {
            el.appendChild(header);
            this._nodes.consoleHeader = header;
            this._bindPanelResize(el);
          }
        }
      } else if (!this._nodes.consoleHeader) {
        // Adopted console from an earlier instance: keep (or rebuild) its header.
        const header = (doc.querySelector ? doc.querySelector('.st-console-header') : null)
          || this._buildPanelHeader('st-console', function (self) {
            if (self._panelJustDragged) { self._panelJustDragged = false; return; }
            self.togglePanel();
          });
        if (header && typeof el.appendChild === 'function' && !header.parentNode) {
          el.appendChild(header);
          this._bindConsoleDrag(header, el);
        }
        this._nodes.consoleHeader = header;
      }
      this._nodes.console = el;
      this._bindPanelResize(el);
      this._writePanelHeader(el, this._nodes.consoleHeader);
      return el;
    }

    /**
     * _reparentIntoConsole() -> move the band into the console.
     * The console is a single scrollable column inside the 640 px arena column, docked
     * BELOW Showdown's move bar. EVERY readout travels with it — including the banner, the
     * overlord pill and the badge row, which used to stay `position: fixed` and float over
     * the top strip of the battle scene (the foe's HP bar and the trainer sprite). The chip
     * and the bench strip stay in the always-on bottom band: they are the two most-used
     * interactive bits and must stay thumb/eye accessible without opening a panel.
     */
    _reparentIntoConsole() {
      const doc = this._document();
      if (!doc) return;
      // Desktop also uses the compact-first sheet pattern: no permanent sidebar competing with
      // the Showdown log, and no large block occupying the chat column until it is requested.
      const sel = '.tactician-banner, .st-overlord-gauge, .st-badge-row, .st-deduction-badges, ' +
        '.st-center-nav, .st-intelligence, .st-field-board, .st-engine-review, .st-action-list, .st-matchup, .st-toolbar, .st-lead-advisory, .st-scout-card, .tactician-tr-chip, .st-bench-strip, .st-pp-gauge, .st-format-sentinel, ' +
        '.st-receipt-card, .st-cancel-alert-card';
      const nodes = (typeof doc.querySelectorAll === 'function')
        ? doc.querySelectorAll(sel) : [];
      // Lazy: only build the console when there are band elements to put in it. Constructing
      // the HUD in a clean document (the clipboard tests do this) used to leave the body
      // empty; the first mount of a band element creates the console through _mountBand.
      if (!nodes || !nodes.length) return;
      const console = this._ensureConsole();
      if (!console) return;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n && n.parentNode !== console && typeof console.appendChild === 'function') {
          try { console.appendChild(n); } catch (e) { /* detached */ }
        }
      }       this._writePanelHeader(console, this._nodes.consoleHeader);
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
        // Don't detach the console's own header — it is chrome, not a band element, and
        // moving it into the body would leave a floating button in the page.
        if (!n || n === this._nodes.consoleHeader) continue;
        if (n.parentNode === console && body && typeof body.appendChild === 'function') {
          try { body.appendChild(n); } catch (e) { /* detached */ }
        }
      }
      // Drop the console so a future desktop switch builds a fresh one.
      if (console.parentNode && typeof console.parentNode.removeChild === 'function') {
        try { console.parentNode.removeChild(console); } catch (e) { /* detached */ }
      }
      this._nodes.console = null;
    }

    /* ---------------------------------------------------------------- mobile sheet
     * The mobile equivalent of the desktop console. Mobile portrait has NO room at the top of
     * the screen for the chip band — the battle scene is only ~250 px tall and every pixel is
     * either a sprite, an HP bar, a party icon, or a statbar (measured coverage: 89–104%). So
     * instead of parking four cards over the arena the band is re-parented into ONE scrollable
     * column docked just above the TR chip and bench strip. The column is collapsed to a 32 px
     * header rail by default (showing the banner summary + a card count + a caret) and expands
     * on tap, so a player who just wants to play can keep the chrome out of the way.
     */
    /**
     * _buildPanelHeader(prefix, onToggle) -> the header <button>, or null.
     * ONE header builder for both containers (the mobile `.st-sheet` and the desktop
     * `.st-console`), because they should read identically: a rail that names the panel,
     * counts the cards stacked inside it, and collapses/expands the body on click. It is
     * `prefix`'-header' with `prefix`'-summary' / '-count' / '-caret' children, so the
     * console gets `.st-console-*` and the sheet keeps `.st-sheet-*`.
     *
     * A <button> is the right tag: Space and Enter activate it, it participates in tab
      * order, and the focus ring is consistent with the controls. On the desktop
     * console the header doubles as the drag handle (see _bindConsoleDrag), which is what
     * makes the panel a popup you can park anywhere rather than a window you have to
     * live with — the same affordance Pokémon Showdown Helper gives its popup.
     */
    _buildPanelHeader(prefix, onToggle) {
      const header = this._el('button', prefix + '-header');
      if (!header) return null;
      if (header.setAttribute) {
        header.setAttribute('type', 'button');
        header.setAttribute('aria-expanded', '0');
      }
      const identity = this._el('span', prefix + '-identity', 'SHOWDOWN');
      const label = this._el('span', prefix + '-label', 'TACTICIAN');
      const summary = this._el('span', prefix + '-summary');
      const count = this._el('span', prefix + '-count');
      const caret = this._el('span', prefix + '-caret');
      if (caret && caret.setAttribute) caret.setAttribute('aria-hidden', 'true');
      if (header.setAttribute) header.setAttribute('aria-label', 'Showdown Tactician readout');
      if (typeof header.appendChild === 'function') {
        if (identity) header.appendChild(identity);
        if (label) header.appendChild(label);
        if (summary) header.appendChild(summary);
        if (count) header.appendChild(count);
        if (caret) header.appendChild(caret);
      }
      const self = this;
      if (header.addEventListener) {
        header.addEventListener('click', function (e) {
          if (e) { e.preventDefault && e.preventDefault(); e.stopPropagation && e.stopPropagation(); }
          if (typeof onToggle === 'function') { try { onToggle(self); } catch (err) { /* never break */ } }
        }, true);
        // Blur on activation so a HUD button can never hold keyboard focus.
        header.addEventListener('mousedown', function (e) { if (e && e.preventDefault) e.preventDefault(); }, true);

      }
      return header;
    }

    _ensureSheet() {
      if (this._nodes.sheet) return this._nodes.sheet;
      const doc = this._document();
      if (!doc) return null;
      let el = doc.querySelector ? doc.querySelector('.st-sheet') : null;
      if (!el) {
        el = (doc.createElement ? doc.createElement('div') : null);
        if (!el) return null;
        el.className = 'st-sheet';
        if (el.setAttribute) {
          el.setAttribute('data-st-sheet', '1');
          el.setAttribute('data-st-sheet-open', this._sheetOpen ? '1' : '0');
          el.setAttribute('role', 'region');
          el.setAttribute('aria-label', 'Tactical readouts');
          el.setAttribute('aria-hidden', 'false');
        }
        const parent = doc.body || doc.documentElement;
        if (parent && parent.appendChild) parent.appendChild(el);
        const header = this._buildPanelHeader('st-sheet', function (self) { self.toggleSheet(); });
        if (header && header.setAttribute) {
          header.setAttribute('data-st-sheet-trigger', '1');
          header.setAttribute('aria-controls', 'st-readout-sheet');
          header.setAttribute('aria-haspopup', 'false');
        }
        if (el.setAttribute) el.setAttribute('id', 'st-readout-sheet');
        if (header && typeof el.appendChild === 'function') el.appendChild(header);
        this._nodes.sheetHeader = header;
      }
      this._nodes.sheet = el;
      this._refreshPanelHeaders();
      return el;
    }

    _reparentIntoSheet() {
      const doc = this._document();
      if (!doc) return;
      // The mobile band set is broader than the desktop one: on mobile the BANNER also goes
      // into the container, because a free-floating banner at top-of-arena paints over the
      // sprites (measured: banner covers 46% of the foe's HP bar). The chip and bench strip
      // stay in the bottom band — they are thumb-targeted and the most-used interactive bits.
      const sel = '.tactician-banner, .st-overlord-gauge, .st-badge-row, .st-deduction-badges, ' +
        '.st-center-nav, .st-intelligence, .st-field-board, .st-engine-review, .st-action-list, .st-matchup, .st-toolbar, .st-lead-advisory, .st-scout-card, .st-pp-gauge, .st-format-sentinel, .st-receipt-card, .st-cancel-alert-card';
      const nodes = (typeof doc.querySelectorAll === 'function')
        ? doc.querySelectorAll(sel) : [];
      // Lazy: the first band element to be mounted creates the sheet through _mountBand.
      // Constructing the HUD in a clean document must NOT add a body child, so a test that
      // asserts an empty body (the receipt copy-fallback test) keeps passing.
      if (!nodes || !nodes.length) return;
      const sheet = this._ensureSheet();
      if (!sheet) return;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!n) continue;
        if (n.parentNode === sheet) continue;
        if (n.parentNode && n.parentNode !== doc.body && n.parentNode !== doc.documentElement) {
          // The node is inside the console (from a previous desktop layout) or some other host.
          // Move it to body first so the next appendChild isn't a no-op.
          try { (doc.body || doc.documentElement).appendChild(n); } catch (e) { /* fall through */ }
        }
        if (typeof sheet.appendChild === 'function') {
          try { sheet.appendChild(n); } catch (e) { /* detached */ }
        }
      }
      // Defensive recovery: the TR chip and the bench strip are the always-on bottom band and
      // must never sit inside the sheet (an earlier build routed them there, which hid the
      // bench strip inside a collapsed rail). Anything else that leaked in goes back to body.
      const leaked = (typeof doc.querySelectorAll === 'function')
        ? doc.querySelectorAll('.st-sheet > .tactician-tr-chip, .st-sheet > .st-bench-strip') : [];
      const body = doc.body || doc.documentElement;
      for (let i = 0; i < leaked.length; i++) {
        const n = leaked[i];
        if (n && n.parentNode === sheet && body && typeof body.appendChild === 'function') {
          try { body.appendChild(n); } catch (e) { /* detached */ }
        }
      }
      this._refreshPanelHeaders();
    }

    _reparentOutOfSheet() {
      const sheet = this._nodes.sheet;
      if (!sheet) return;
      const doc = this._document();
      const body = (doc && doc.body) || (doc && doc.documentElement) || sheet.parentNode;
      const live = sheet.children || sheet.childNodes;
      const kids = Array.prototype.slice.call(live || []);
      for (let i = 0; i < kids.length; i++) {
        const n = kids[i];
        // Don't detach the sheet's own header — it's chrome, not a band element.
        if (!n || n === this._nodes.sheetHeader) continue;
        if (n.parentNode === sheet && body && typeof body.appendChild === 'function') {
          try { body.appendChild(n); } catch (e) { /* detached */ }
        }
      }
      if (sheet.parentNode && typeof sheet.parentNode.removeChild === 'function') {
        try { sheet.parentNode.removeChild(sheet); } catch (e) { /* detached */ }
      }
      this._nodes.sheet = null;
      this._nodes.sheetHeader = null;
    }

    /**
     * _refreshPanelHeaders() -> fill every panel rail from the live band.
     * The mobile sheet and the desktop console share one header builder, so both rails are
     * rewritten from the same live state (the banner's line, the number of cards actually
     * stacked in each container). Called after any mount, drop, re-parent or banner
     * re-render. Writing a rail that is not mounted is a no-op, so this is safe to call
     * from either layout's code paths.
     */
    _refreshPanelHeaders() {
      this._writePanelHeader(this._nodes.sheet, this._nodes.sheetHeader);
      this._writePanelHeader(this._nodes.console, this._nodes.consoleHeader);
      this._syncPlacement();
    }

    /**
     * _writePanelHeader(host, header) -> fill a panel header from the live band.
     * The summary mirrors the banner (the one line a player actually reads first) and the
     * count is the number of cards stacked in THIS container minus its own header. Written
     * on every re-parent so switching layouts relabels the rail for the panel you are
     * looking at rather than the one you left.
     */
    _writePanelHeader(host, header) {
      if (!host || !header) return;
      const banner = this._qs('.tactician-banner') || this._nodes.banner;
      const summary = header.querySelector
        ? (header.querySelector('.st-sheet-summary') || header.querySelector('.st-console-summary'))
        : null;
      const count = header.querySelector
        ? (header.querySelector('.st-sheet-count') || header.querySelector('.st-console-count'))
        : null;
      const summaryText = (banner && banner.textContent)
        ? String(banner.textContent).trim() : 'AWAITING FIELD DATA';
      const decision = this._recommended || summaryText;
      const shortDecision = decision.replace(/^PLAY:\s*/i, '');
      // Keep the collapsed trigger scannable with a short live summary.
      if (summary && summary.textContent !== shortDecision) summary.textContent = shortDecision;
      // Count the stacked cards (everything that lives inside the panel, minus the header).
      let n = 0;
      const live = host.children || host.childNodes;
      const kids = live ? Array.prototype.slice.call(live) : [];
      for (let i = 0; i < kids.length; i++) {
        if (kids[i] && kids[i] !== header && kids[i] !== this._nodes.toolbar) n++;
      }
      const canRead = typeof header.getAttribute === 'function';
      if (count) {
        const countText = n > 0 ? (n + (n === 1 ? ' readout' : ' readouts')) : 'idle';
        if (count.textContent !== countText) {
          count.textContent = countText;
          if (count.setAttribute) count.setAttribute('data-st-count', String(n));
        }
      }
      // The rail is the one always-visible affordance on a phone, so it has to announce what
      // tapping it does rather than leaving the caret to imply it.
      if (header.setAttribute) {
        const title = 'Showdown Tactician: ' + decision + '. ' + ((host === this._nodes.sheet ? this._sheetOpen : this._panelOpen) ? 'Close analysis' : 'Open analysis');
        const open = (host === this._nodes.sheet)
          ? this._sheetOpen : this._panelOpen;
        const expanded = open ? 'true' : 'false';
        if (!canRead || header.getAttribute('title') !== title) header.setAttribute('title', title);
        if (!canRead || header.getAttribute('aria-label') !== title) header.setAttribute('aria-label', title);
        if (!canRead || header.getAttribute('aria-expanded') !== expanded) {
          header.setAttribute('aria-expanded', expanded);
        }
      }
    }

    /** toggleSheet() -> the new open state ('open' | 'closed'). */
    toggleSheet() {
      return this.setSheetOpen(!this._sheetOpen);
    }

    /** setSheetOpen(open) -> the resulting state. */
    setSheetOpen(open) {
      // Re-measure BEFORE expanding: the dock and the clearance cap both depend on where the
      // bottom band and the arena sit right now, and both move when the log scrolls. Opening
      // the sheet is the one moment a stale value would be visible, so it is worth a layout
      // read here.
      try { this._syncChipBand(); } catch (e) { /* detached */ }
      this._sheetOpen = !!open;
      const sheet = this._ensureSheet();
      if (sheet && sheet.setAttribute) {
        sheet.setAttribute('data-st-sheet-open', this._sheetOpen ? '1' : '0');
        sheet.setAttribute('aria-hidden', 'false');
      }
      const header = this._nodes.sheetHeader;
      if (header && header.setAttribute) {
        header.setAttribute('aria-expanded', this._sheetOpen ? 'true' : 'false');
        header.setAttribute('aria-controls', 'st-readout-sheet');
      }
      if (sheet && sheet.setAttribute) sheet.setAttribute('id', 'st-readout-sheet');
      this._refreshPanelHeaders();
      this._renderCenterView();
      this._syncModalState(this._sheetOpen && this.resolvedLayout === 'mobile');
      if (header && header.focus) header.focus({ preventScroll: true });
      return this._sheetOpen;
    }

    /* ------------------------------------------------------------------ desktop panel
     * The console has three states, mirroring the sheet: open (the default, the full readout
     * stack), collapsed (the 38 px title bar only) and unmounted (no battle on the page).
     * Collapsing is the "get out of my way" gesture and Ctrl+8 is its keyboard spelling;
     * unmounting is the page-kind gate below.
     */

    /** togglePanel() -> the new open state. On mobile it toggles the sheet instead. */
    togglePanel() {
      if ((this.resolvedLayout || this._resolveLayout()) !== 'desktop') return this.toggleSheet();
      return this.setPanelOpen(!this._panelOpen);
    }

    /** setPanelOpen(open) -> the resulting state of the desktop console. */
    setPanelOpen(open) {
      try { this._syncChipBand(); } catch (e) { /* detached */ }
      this._panelOpen = !!open;
      const consoleEl = this._nodes.console;
      if (!consoleEl && !this._panelOpen) {
        const doc = this._document();
        const existing = doc && doc.querySelector ? doc.querySelector('.st-console') : null;
        if (existing && existing.setAttribute) {
          this._nodes.console = existing;
          existing.setAttribute('data-st-console-open', '0');
        }
      }
      if (consoleEl && consoleEl.setAttribute) {
        consoleEl.setAttribute('data-st-console-open', this._panelOpen ? '1' : '0');
      }
      const header = this._nodes.consoleHeader;
      if (header && header.setAttribute) {
        header.setAttribute('aria-expanded', this._panelOpen ? 'true' : 'false');
      }
      this._refreshPanelHeaders();
      this._renderCenterView();
      return this._panelOpen;
    }

    /** Drop any drag offset so the panel re-docks to its measured column. */
    _resetPanelOffset() {
      this._panelX = 0;
      this._panelY = 0;
      const consoleEl = this._nodes.console;
      if (consoleEl && consoleEl.style && typeof consoleEl.style.removeProperty === 'function') {
        consoleEl.style.removeProperty('--st-panel-x');
        consoleEl.style.removeProperty('--st-panel-y');
      }
    }

    /**
     * _bindConsoleDrag(header, consoleEl) -> make the title bar draggable.
     * The console is docked by measurement, but "docked" and "in the way" are the same word
     * on a small desktop window, so the panel can be parked anywhere (the gesture Pokémon
     * Showdown Helper gives its popup). Pointer events with explicit capture, a 5 px
     * threshold so a click is still a click, and a clamp that always keeps at least a
     * corner of the title bar on screen so the panel can always be dragged back.
     * Double-clicking the header re-docks.
     */
    _bindConsoleDrag() {}

    _bindPanelResize(panel) {
      const doc = this._document();
      const view = doc && doc.defaultView;
      if (!view || !view.ResizeObserver || !panel) return;
      if (this._panelResize) this._panelResize.disconnect();
      this._panelResize = new view.ResizeObserver(function () { this._syncPlacement(); }.bind(this));
      this._panelResize.observe(panel);
    }

    _bindHotkey() {
      const doc = this._document();
      if (!doc || this._hotkeyBound || typeof doc.addEventListener !== 'function') return;
      this._hotkeyBound = true;
      const self = this;
      doc.addEventListener('keydown', function (e) {
        if (!e) return;
        const el = (e.target || null);
        const tag = el && el.tagName ? String(el.tagName).toUpperCase() : '';
        if (self._sheetOpen && self.resolvedLayout === 'mobile' && !self._drawerOpen) {
          if (e.stopPropagation) e.stopPropagation();
          if (e.key === 'Tab') self._trapCenterFocus(e);
        }
        if ((tag === 'TEXTAREA' || tag === 'INPUT' || (el && el.isContentEditable)) && e.key !== 'Escape') return;
        if (e.key === 'Escape' && self._drawerOpen) { self.toggleDrawer(false); return; }
        if (e.key === 'Escape' && self._sheetOpen) {
          self.setSheetOpen(false);
          const trigger = self._nodes.sheetHeader;
          if (trigger && trigger.focus) trigger.focus();
          return;
        }
        if (!(e.ctrlKey || e.metaKey)) return;
        const k = String(e.key || '');
        const code = String(e.code || '');
        const digit = (k === '8' || k === '&' || code === 'Digit8' || code === 'Numpad8');
        if (!digit) return;
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        try { self.togglePanel(); } catch (err) { /* never break the page */ }
      }, true);
    }

    _updateModeToggle() {
      const btn = this._nodes.modeToggle;
      if (!btn) return;
      const resolved = this.resolvedLayout || this._resolveLayout();
      btn.textContent = this.layoutMode === 'auto' ? 'Layout: Auto' : resolved === 'desktop' ? 'Layout: Wide' : 'Layout: Compact';
      if (btn.setAttribute) {
        btn.setAttribute('title', 'Cycle layout: Auto, Compact, Wide');
        btn.setAttribute('aria-label', btn.textContent + '. Cycle layout');
        btn.setAttribute('data-st-resolved', resolved);
      }
    }

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
      const input = this._qs('.drawer-team-input');
      if (next && input && input.focus) input.focus();
      if (!next && toggle && toggle.focus) toggle.focus();
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
          ? (safeString(best.role || 'set') + (best.item ? ' @ ' + best.item : ' (itemless)') + ' (estimated)')
          : 'no surviving candidate set';
        lines.push(head + ': ' + detail + '  [' + sets.length + ' candidate' + (sets.length === 1 ? '' : 's') + ']');
        if (mon.prunedReasons && mon.prunedReasons.length) {
          lines.push('Excluded sets: ' + mon.prunedReasons.slice(0, 3).join('; '));
        }
      }
      if (battleState.formatLocks) {
        const locks = battleState.formatLocks;
        lines.push('Mega Evolution: ' + (locks.oppHasMegaEvolved ? 'spent' : 'available') + '. Z-Move: ' + (locks.oppHasUsedZMove ? 'spent' : 'available') + '. Terastallization unavailable.');
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
      this._renderMatchup(this._lastPreview);
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
      this.setTeamStatus(value.trim() ? 'Team paste saved: ' + value.split('\n').length + ' lines' : 'Team paste cleared.');
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
      this._syncModalState(false);
      const nodes = this._qsa('.elo-helper-badge, .tactician-banner, .tactician-tr-chip, .team-drawer, .team-drawer-toggle, .elo-helper-reason, .st-lethal-bar, .st-bench-strip, .st-badge-row, .st-receipt-card, .st-overlord-gauge, .st-pp-gauge, .st-format-sentinel, .st-lead-advisory, .st-cancel-alert-card, .st-cancel-badge, .st-matchup, .st-toolbar, .st-mode-toggle, .st-scout-card, .st-center-nav, .st-intelligence, .st-field-board, .st-engine-review, .st-action-list');
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
      this._restoreLog();
      this._restoreControls();
      this.dismissLeadAdvisory();
      // The cancel alert is dropped through its own handle as well, for the same reason the
      // advisory is: the sweep above is a bulk selector and this one the HUD also holds a
      // reference to. It also un-flags the Cancel button, which the sweep cannot do because that
      // button belongs to the PAGE, not to us.
      this.clearCancelAlert();
      // ...and the containers themselves. An empty `.st-console` / `.st-sheet` left behind
      // would keep painting its background and eating clicks in the column it docks into,
      // so the teardown removes the panels along with everything that was in them.
      this._reparentOutOfConsole();
      this._reparentOutOfSheet();
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
        ppGauge: null, sentinel: null, leadAdvisory: null, cancelAlert: null,
        console: null, sheet: null, sheetHeader: null, modeToggle: null,
        consoleHeader: null, matchup: null, toolbar: null
      };
      this._drawerOpen = false;
      this._bound = false;
      this._benchBound = false;
      this._receiptText = null;
      this.selectedBenchId = null;
      if (this._menuWatch && typeof this._menuWatch.disconnect === 'function') {
        try { this._menuWatch.disconnect(); } catch (e) { /* detached */ }
      }
      this._menuWatch = null;
      if (this._panelResize) this._panelResize.disconnect();
      if (this._roomResize) this._roomResize.disconnect();
      this._layoutRoot = null;
      this._lastRanked = [];
      this._lastPreview = null;
      this._battleState = null;
      this._readout = null;
      this._centerState = null;
      this._centerMeta = {};
      this._inspectedId = null;
      this._centerView = 'battle';
      this._recommended = null;   // the banner's 'PLAY: …' line is per-battle too
      this.lastBadgeCount = 0;
      this._panelX = 0;
      this._panelY = 0;
      return true;
    }
  }

  MobileHUD.BADGES = BADGES;
  MobileHUD.VETO_REASON_ATTR = REASON_ATTR;

  ST.MobileHUD = MobileHUD;
})();
