/* Showdown Tactician — src/llm_client.js
 * Hybrid AI bridge (Part 2, Module 14). Optional narrative layer on top of the local
 * engine: if no API key is stored the class returns null immediately and costs 0 ms.
 *
 * The network call is routed through the background service worker (src/background.js),
 * because an MV3 content script is subject to the page's CORS rules and cannot use the
 * extension's host permissions. When chrome messaging is unavailable the client falls back
 * to a direct fetch, which works for both providers when their CORS headers are present.
 *
 * Model ids, endpoints, the abort budget and the system prompt all come from src/config.js
 * (`llm.*`) so the bridge can be retargeted without touching this file.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;

  /**
   * Config read with a literal fallback for a build without config.js.
   * Named cfgGet, not cfg: _directFetch() takes a parameter called `cfg` (the stored
   * provider settings), so a helper named `cfg` would be shadowed inside it.
   */
  function cfgGet(path, fallback) {
    return (typeof ST.configGet === 'function') ? ST.configGet(path, fallback) : fallback;
  }

  // The bridge default for a build without config.js. It must stay equal to config's
  // `llm.timeoutMs` (which is what actually ships); 600 ms was too short for any provider to
  // answer, which made every configured call fail. tests/config_check.js guards the agreement.
  const TIMEOUT_MS = cfgGet('llm.timeoutMs', 20000);
  const GEMINI_MODEL = cfgGet('llm.geminiModel', 'gemini-3.5-flash-lite');
  const OPENROUTER_MODEL = cfgGet('llm.openrouterModel', 'google/gemini-2.0-flash-lite-001');
  const GEMINI_ENDPOINT = cfgGet('llm.geminiEndpoint', 'https://generativelanguage.googleapis.com/v1beta/models/');
  const OPENROUTER_ENDPOINT = cfgGet('llm.openrouterEndpoint', 'https://openrouter.ai/api/v1/chat/completions');

  const SYSTEM_PROMPT = cfgGet('llm.systemPrompt',
    'You are an elite Pokemon Showdown grandmaster. Never calculate math. ' +
    'Rely strictly on the provided damage ranges. Output strictly valid JSON: ' +
    '{"action": "Move", "confidence": 85, "reason": "Max 15 words."}');

  class LLMTactician {
    constructor(options) {
      options = options || {};
      this.timeoutMs = options.timeoutMs || TIMEOUT_MS;
      this.config = options.config || null;
      this.lastError = null;
      this.lastLatency = 0;
      this.calls = 0;
      this.hits = 0;
    }

    /* ------------------------------------------------------------- config */

    _storageGet(defaults) {
      return new Promise(function (resolve) {
        try {
          if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local) {
            let settled = false;
            const done = function (value) { if (!settled) { settled = true; resolve(value || defaults); } };
            const maybe = chrome.storage.local.get(defaults, done);
            if (maybe && typeof maybe.then === 'function') maybe.then(done).catch(function () { done(defaults); });
            setTimeout(function () { done(defaults); }, 250);
            return;
          }
        } catch (e) { /* fall through */ }
        try {
          if (typeof localStorage !== 'undefined' && localStorage) {
            const raw = localStorage.getItem('showdownTactician.config');
            if (raw) { resolve(Object.assign({}, defaults, JSON.parse(raw))); return; }
          }
        } catch (e2) { /* ignore */ }
        resolve(defaults);
      });
    }

    _storageSet(obj) {
      try {
        if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set(obj);
          return true;
        }
      } catch (e) { /* fall through */ }
      try {
        if (typeof localStorage !== 'undefined' && localStorage) {
          // SECURITY: this fallback runs inside a CONTENT SCRIPT, so `localStorage` here is the
          // LADDER SITE'S origin storage (play.pokemonshowdown.com), not a sandbox of our own.
          // Writing the settings blob there put the user's API KEY one page script away from being
          // read off the ladder. The secret is stripped before anything reaches page-origin
          // storage: a non-secret setting losing its fallback round-trip is recoverable, a leaked
          // key is not. (chrome.storage.local, the real home, still gets the whole object.)
          const safe = Object.assign({}, obj || {});
          delete safe.apiKey;
          localStorage.setItem('showdownTactician.config', JSON.stringify(safe));
          return true;
        }
      } catch (e2) { /* ignore */ }
      return false;
    }

    getConfig() {
      const self = this;
      if (this.config) return Promise.resolve(this.config);
      // NOTE (config slice): the provider/API-key/paste/Elo defaults below are still literals.
      // They were not in this slice's list and have no `llm.*` home in src/config.js yet.
      return this._storageGet({ provider: 'gemini', apiKey: '', teamText: '', elo: 1400 })
        .then(function (cfg) { self.config = cfg; return cfg; });
    }

    saveConfig(cfg) {
      this.config = Object.assign({}, this.config || {}, cfg || {});
      this._storageSet(this.config);
      return this.config;
    }

    /* ------------------------------------------------------------- prompt */

    /** Ultra-dense payload: well under 150 tokens. */
    buildPrompt(battleState, laplaceResults, tempoVector) {
      const state = battleState || {};
      const field = state.field || {};
      const my = (state.active && state.active.my) || null;
      const opp = (state.active && state.active.opp) || null;
      const ranked = Array.isArray(laplaceResults) ? laplaceResults : [];
      const top = [];
      for (let i = 0; i < ranked.length && top.length < 2; i++) {
        const row = ranked[i];
        if (!row || row.isVetoed) continue;
        top.push(row.name + '=' + Math.round(row.confidence) + '%' + (row.damageHint ? '(' + row.damageHint + ')' : ''));
      }
      const tv = tempoVector || {};
      const lines = [
        'TR:' + (field.trickRoom ? (field.trickRoomTurnsLeft || 0) + '/5' : 'off'),
        'me:' + (my ? (my.species + ' ' + U.clamp(Math.round(this._hp(my)), 0, 100) + '%') : '?') +
          (my && my.status ? ' ' + my.status : ''),
        'foe:' + (opp ? (opp.species + ' ' + U.clamp(Math.round(this._hp(opp)), 0, 100) + '%') : '?') +
          (opp && opp.confirmedItem ? ' @' + opp.confirmedItem : ''),
        'haz:' + this._hazardShort(field),
        'lines:' + top.join(' '),
        'bunker:' + U.round2(typeof tv.v4 === 'number' ? tv.v4 : 0),
        'threat:' + U.round2(typeof tv.v5 === 'number' ? tv.v5 : 0)
      ];
      return lines.join(' | ');
    }

    _hazardShort(field) {
      const mine = (field.hazards && field.hazards.p1) || {};
      const theirs = (field.hazards && field.hazards.p2) || {};
      const fmt = function (h) {
        if (!h) return '-';
        const out = [];
        if (h.rocks) out.push('SR');
        if (h.spikes) out.push('Sp' + h.spikes);
        if (h.toxicspikes) out.push('TS' + h.toxicspikes);
        return out.length ? out.join('+') : '-';
      };
      return 'us' + fmt(mine) + '/foe' + fmt(theirs);
    }

    _hp(mon) {
      if (!mon) return 0;
      let hp = mon.hpPercent;
      if (hp === null || hp === undefined) hp = mon.hp;
      return (hp === null || hp === undefined || hp !== hp) ? 100 : hp;
    }

    /* ------------------------------------------------------------- request */

    /**
     * getTacticalReadout(...) -> Promise<{action,confidence,reason}|null>
     * Resolves to null (never rejects) when there is no key, on timeout, or on any error.
     */
    getTacticalReadout(battleState, laplaceResults, tempoVector) {
      const self = this;
      const started = this._now();
      return this.getConfig().then(function (cfg) {
        if (!cfg || !cfg.apiKey) { return null; }             // 100% local mode: zero delay
        const prompt = self.buildPrompt(battleState, laplaceResults, tempoVector);
        self.calls++;
        return self._dispatch(cfg, prompt).then(function (text) {
          self.lastLatency = self._now() - started;
          const parsed = self.parseResponse(text);
          if (parsed) self.hits++;
          return parsed;
        });
      }).catch(function (err) {
        self.lastError = err && err.message ? err.message : String(err);
        return null;
      });
    }

    _dispatch(cfg, prompt) {
      const self = this;
      return new Promise(function (resolve) {
        let settled = false;
        const done = function (value) { if (!settled) { settled = true; resolve(value); } };
        // The budget above belongs to the ONE provider round trip; this timer is the backstop for a
        // bridge that never answers at all, so it is deliberately longer than the budget the worker
        // aborts at. On an identical deadline the two race and the worker's honest 'timeout' loses
        // to a silent null; the grace lets the real failure be the one reported.
        const GRACE_MS = 2000;
        const timer = setTimeout(function () { done(null); }, self.timeoutMs + GRACE_MS);

        const finish = function (value) { clearTimeout(timer); done(value); };

        // Preferred path: the background worker owns the network request.
        try {
          if (typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.sendMessage) {
            let responded = false;
            try {
              chrome.runtime.sendMessage({
                type: 'st-llm',
                provider: cfg.provider || 'gemini',
                apiKey: cfg.apiKey,
                system: SYSTEM_PROMPT,
                prompt: prompt,
                // The ONE abort budget, sent with the request so src/background.js does not keep a
                // second opinion about it. Owned here (config.js) rather than in the worker.
                timeoutMs: self.timeoutMs
              }, function (response) {
                responded = true;
                if (chrome.runtime && chrome.runtime.lastError) { self._directFetch(cfg, prompt).then(finish); return; }
                if (response && response.ok && response.text) finish(response.text);
                else if (response && response.error) { self.lastError = response.error; self._directFetch(cfg, prompt).then(finish); }
                else finish(null);
              });
            } catch (e) { responded = false; }
            setTimeout(function () { if (!responded && !settled) { self._directFetch(cfg, prompt).then(finish); } }, self.timeoutMs);
            return;
          }
        } catch (e) { /* fall through to direct fetch */ }

        self._directFetch(cfg, prompt).then(finish);
      });
    }

    _directFetch(cfg, prompt) {
      const provider = cfg.provider === 'openrouter' ? 'openrouter' : 'gemini';
      const url = provider === 'openrouter'
        ? OPENROUTER_ENDPOINT
        : GEMINI_ENDPOINT + GEMINI_MODEL + ':generateContent';
      const controller = (typeof AbortController === 'function') ? new AbortController() : null;
      const headers = { 'Content-Type': 'application/json' };
      if (provider === 'openrouter') {
        headers.Authorization = 'Bearer ' + cfg.apiKey;
      } else {
        headers['x-goog-api-key'] = cfg.apiKey;
      }
      const body = provider === 'openrouter'
        ? {
          model: OPENROUTER_MODEL,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
          max_tokens: 80,
          temperature: 0.2
        }
        : {
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 80, temperature: 0.2 }
        };
      const timeout = setTimeout(function () { if (controller) { try { controller.abort(); } catch (e) { /* ignore */ } } }, this.timeoutMs);
      let attempt;
      try {
        attempt = fetch(url, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body),
          signal: controller ? controller.signal : undefined
        });
      } catch (e) {
        clearTimeout(timeout);
        return Promise.resolve(null);
      }
      return attempt.then(function (res) {
        if (!res || !res.ok) return null;
        return res.json();
      }).then(function (json) {
        clearTimeout(timeout);
        if (!json) return null;
        if (provider === 'openrouter') {
          const choice = json.choices && json.choices[0];
          return choice && choice.message ? choice.message.content : null;
        }
        const cand = json.candidates && json.candidates[0];
        const part = cand && cand.content && cand.content.parts && cand.content.parts[0];
        return part ? part.text : null;
      }).catch(function () {
        clearTimeout(timeout);
        return null;
      });
    }

    /* ------------------------------------------------------------- parsing */

    /**
     * parseResponse(text) -> { action, confidence, reason } | null
     * Forgiving: strips code fences, finds the first JSON object, clamps confidence.
     */
    parseResponse(text) {
      if (!text || typeof text !== 'string') return null;
      let body = text.trim();
      const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence) body = fence[1].trim();
      const start = body.indexOf('{');
      const end = body.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) return null;
      let parsed;
      try { parsed = JSON.parse(body.slice(start, end + 1)); } catch (e) { return null; }
      if (!parsed || typeof parsed !== 'object') return null;
      const action = typeof parsed.action === 'string' ? parsed.action.slice(0, 60) : null;
      let confidence = typeof parsed.confidence === 'number' ? parsed.confidence : parseFloat(parsed.confidence);
      if (confidence !== confidence) confidence = 0;
      const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 140) : '';
      if (!action && !reason) return null;
      return { action: action || 'Move', confidence: U.clamp(Math.round(confidence), 0, 100), reason: reason };
    }

    _now() {
      return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }
  }

  LLMTactician.SYSTEM_PROMPT = SYSTEM_PROMPT;
  LLMTactician.TIMEOUT_MS = TIMEOUT_MS;
  LLMTactician.GEMINI_MODEL = GEMINI_MODEL;
  LLMTactician.OPENROUTER_MODEL = OPENROUTER_MODEL;

  ST.LLMTactician = LLMTactician;
})();
