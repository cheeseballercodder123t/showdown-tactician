/* Showdown Tactician — options/options.js
 * Classic script (no modules). Persists { provider, apiKey, teamText, elo } to
 * chrome.storage.local — the exact keys src/llm_client.js and src/content.js read — with a
 * defensive localStorage fallback so the page still works when the extension APIs are
 * unavailable (file:// preview, Chromium mobile shells with a stripped chrome.* surface).
 */
(function () {
  'use strict';

  var ST = (window.ST = window.ST || {});
  var DEFAULTS = { provider: 'gemini', apiKey: '', teamText: '', elo: 1400 };
  var PROVIDER_LABELS = {
    gemini: 'Google Gemini (gemini-3.5-flash-lite)',
    openrouter: 'OpenRouter (google/gemini-2.0-flash-lite-001)'
  };
  var KEY_NS = 'showdownTactician.';

  /* ------------------------------------------------------------------ storage */

  function hasChromeStorage() {
    try {
      return !!(window.chrome && window.chrome.storage && window.chrome.storage.local);
    } catch (e) {
      return false;
    }
  }

  function localStorageGet(keys) {
    var out = {};
    try {
      keys.forEach(function (k) {
        var raw = window.localStorage.getItem(KEY_NS + k);
        if (raw !== null) {
          try { out[k] = JSON.parse(raw); } catch (e2) { out[k] = raw; }
        }
      });
    } catch (e) { /* private mode / disabled storage */ }
    return out;
  }

  function localStorageSet(obj) {
    try {
      Object.keys(obj).forEach(function (k) {
        window.localStorage.setItem(KEY_NS + k, JSON.stringify(obj[k]));
      });
    } catch (e) { /* ignore */ }
  }

  function loadSettings() {
    return new Promise(function (resolve) {
      var keys = Object.keys(DEFAULTS);
      if (hasChromeStorage()) {
        try {
          window.chrome.storage.local.get(DEFAULTS, function (stored) {
            if (window.chrome.runtime && window.chrome.runtime.lastError) {
              resolve(merge(DEFAULTS, localStorageGet(keys)));
              return;
            }
            resolve(merge(DEFAULTS, stored));
          });
          return;
        } catch (e) {
          resolve(merge(DEFAULTS, localStorageGet(keys)));
          return;
        }
      }
      resolve(merge(DEFAULTS, localStorageGet(keys)));
    });
  }

  function saveSettings(values) {
    return new Promise(function (resolve) {
      if (hasChromeStorage()) {
        try {
          window.chrome.storage.local.set(values, function () {
            var err = window.chrome.runtime && window.chrome.runtime.lastError;
            // Mirror to localStorage as a belt-and-braces copy for the HUD drawer.
            localStorageSet(values);
            resolve(!err);
          });
          return;
        } catch (e) {
          localStorageSet(values);
          resolve(false);
          return;
        }
      }
      localStorageSet(values);
      resolve(false);
    });
  }

  function merge(base, over) {
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    if (over && typeof over === 'object') {
      Object.keys(over).forEach(function (k) {
        if (over[k] !== undefined && over[k] !== null) out[k] = over[k];
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ DOM helpers */

  function $(id) { return document.getElementById(id); }

  function setStatus(text, kind) {
    var el = $('status');
    if (!el) return;
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function clampElo(v) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return DEFAULTS.elo;
    return Math.max(1000, Math.min(2000, n));
  }

  function eloHint(elo) {
    if (elo < 1300) return 'Wide sampling pool: assumes looser set choices and a slower setup rhythm.';
    if (elo <= 1600) return 'Standard NatDex ladder priors (default 1400).';
    return 'Top-ladder priors: tighter set pool, sharper Protect/Bunker rhythm prediction.';
  }

  /* ------------------------------------------------------------------ team validation */

  function isTrickRoomSet(mon) {
    if (!mon) return false;
    if (typeof mon.isTR === 'boolean') return mon.isTR;
    var speIv = mon.ivs && typeof mon.ivs.spe === 'number' ? mon.ivs.spe : 31;
    var nature = String(mon.nature || '').toLowerCase();
    var speDropNature = /^(sassy|relaxed|brave|quiet)$/.test(nature);
    return speIv === 0 || speDropNature;
  }

  function normalizeParseResult(result) {
    if (Array.isArray(result)) return { pokemon: result, errors: [] };
    if (result && Array.isArray(result.pokemon)) {
      return { pokemon: result.pokemon, errors: Array.isArray(result.errors) ? result.errors : [] };
    }
    if (result && Array.isArray(result.mons)) {
      return { pokemon: result.mons, errors: Array.isArray(result.errors) ? result.errors : [] };
    }
    return { pokemon: [], errors: ['TeamParser returned an unexpected shape.'] };
  }

  function validateTeamText(text) {
    var out = { count: 0, tr: 0, special: 0, errors: [], warnings: [], ok: false };
    var trimmed = String(text || '').trim();
    if (!trimmed) {
      out.errors.push('Team is empty.');
      return out;
    }
    var util = ST.util;
    var parser = ST.TeamParser;
    if (!parser || typeof parser.parsePokepaste !== 'function') {
      out.errors.push('TeamParser is unavailable (script failed to load).');
      return out;
    }
    var parsed;
    try {
      parsed = normalizeParseResult(parser.parsePokepaste(trimmed));
    } catch (e) {
      out.errors.push('Parser error: ' + (e && e.message ? e.message : String(e)));
      return out;
    }
    parsed.errors.forEach(function (e) { out.errors.push(String(e)); });
    parsed.pokemon.forEach(function (mon) {
      if (!mon) return;
      var name = mon.species || mon.name || '(unnamed)';
      var speciesName = name;
      if (util && typeof util.closestSpeciesName === 'function') {
        var resolved = util.closestSpeciesName(name);
        if (!resolved) {
          out.errors.push('Unknown species: ' + name);
          return;
        }
        speciesName = resolved;
        if (util.toID(resolved) !== util.toID(name)) {
          out.warnings.push('Assumed ' + resolved + ' for "' + name + '"');
        }
      }
      out.count++;
      if (isTrickRoomSet(mon)) out.tr++;
      var item = mon.item || '';
      var isSpecial = false;
      if (util) {
        if (util.isMegaStone && util.isMegaStone(item)) isSpecial = true;
        if (util.isZCrystal && util.isZCrystal(item)) isSpecial = true;
      }
      if (isSpecial) out.special++;
      if (!item) out.warnings.push(speciesName + ' has no item (Acrobatics archetype assumed)');
      if (!mon.moves || mon.moves.length < 4) {
        out.warnings.push(speciesName + ' has ' + ((mon.moves && mon.moves.length) || 0) + ' move(s)');
      }
    });
    if (out.count > 6) out.errors.push('More than 6 Pokemon parsed (' + out.count + ').');
    out.ok = out.count === 6 && !out.errors.length;
    return out;
  }

  function renderReadout(summary) {
    var count = $('ro-count');
    var tr = $('ro-tr');
    var special = $('ro-special');
    var errBox = $('ro-errors');
    if (count) {
      count.textContent = (summary.count || 0) + ' / 6';
      count.className = (summary.count === 6 ? 'pill ok' : summary.count > 0 ? 'pill warn' : 'pill err');
    }
    if (tr) tr.textContent = String(summary.tr || 0);
    if (special) special.textContent = String(summary.special || 0);
    if (!errBox) return;
    var lines = (summary.errors || []).concat((summary.warnings || []).map(function (w) { return 'note: ' + w; }));
    errBox.innerHTML = '';
    if (!lines.length) {
      errBox.hidden = true;
      return;
    }
    errBox.hidden = false;
    lines.slice(0, 8).forEach(function (line) {
      var li = document.createElement('li');
      li.textContent = line;
      errBox.appendChild(li);
    });
  }

  /* ------------------------------------------------------------------ controller */

  function debounce(fn, wait) {
    var t = null;
    return function () {
      var args = arguments;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(null, args); }, wait);
    };
  }

  function currentFormValues() {
    var provider = 'gemini';
    var radios = document.querySelectorAll('input[name="provider"]');
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) provider = radios[i].value;
    }
    var apiKey = $('api-key') ? $('api-key').value.trim() : '';
    var teamText = $('team-text') ? $('team-text').value : '';
    var elo = clampElo($('elo') ? $('elo').value : DEFAULTS.elo);
    return { provider: provider, apiKey: apiKey, teamText: teamText, elo: elo };
  }

  function applyToForm(cfg) {
    var radios = document.querySelectorAll('input[name="provider"]');
    for (var i = 0; i < radios.length; i++) radios[i].checked = (radios[i].value === cfg.provider);
    var key = $('api-key');
    if (key) key.value = cfg.apiKey || '';
    var team = $('team-text');
    if (team) team.value = cfg.teamText || '';
    var elo = $('elo');
    if (elo) elo.value = String(clampElo(cfg.elo));
    var label = $('elo-value');
    if (label) label.textContent = String(clampElo(cfg.elo));
    var hint = $('elo-hint');
    if (hint) hint.textContent = eloHint(clampElo(cfg.elo));
    renderReadout(validateTeamText(cfg.teamText || ''));
  }

  var lastSummary = null;
  function refreshReadout() {
    lastSummary = validateTeamText($('team-text') ? $('team-text').value : '');
    renderReadout(lastSummary);
    return lastSummary;
  }

  function init() {
    var form = $('settings-form');
    var keyToggle = $('key-toggle');
    var keyInput = $('api-key');
    var teamText = $('team-text');
    var elo = $('elo');
    var eloLabel = $('elo-value');
    var eloHintEl = $('elo-hint');
    var saveBtn = $('save-btn');
    var resetBtn = $('reset-btn');
    var debouncedReadout = debounce(refreshReadout, 220);

    if (keyToggle && keyInput) {
      keyToggle.addEventListener('click', function () {
        var showing = keyInput.type === 'text';
        keyInput.type = showing ? 'password' : 'text';
        keyToggle.textContent = showing ? 'Show' : 'Hide';
        keyToggle.setAttribute('aria-label', showing ? 'Show the API key' : 'Hide the API key');
      });
    }

    if (elo) {
      var onElo = function () {
        var v = clampElo(elo.value);
        if (eloLabel) eloLabel.textContent = String(v);
        if (eloHintEl) eloHintEl.textContent = eloHint(v);
      };
      elo.addEventListener('input', onElo);
      elo.addEventListener('change', onElo);
    }

    if (teamText) {
      teamText.addEventListener('input', debouncedReadout);
      teamText.addEventListener('paste', function () { setTimeout(refreshReadout, 0); });
    }

    if (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var values = currentFormValues();
        var summary = validateTeamText(values.teamText);
        renderReadout(summary);
        if (saveBtn) saveBtn.disabled = true;
        saveSettings(values).then(function (chromeOk) {
          if (saveBtn) saveBtn.disabled = false;
          var bits = ['Saved ' + PROVIDER_LABELS[values.provider] + ' · Elo ' + values.elo];
          if (!values.apiKey) bits.push('readout disabled (no key)');
          else bits.push('readout enabled');
          bits.push(summary.count === 6 ? 'team 6/6' : 'team ' + summary.count + '/6');
          setStatus(bits.join(' · ') + (chromeOk ? '' : ' (local fallback storage)'),
            summary.count === 6 ? 'ok' : 'warn');
        });
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        var proceed = true;
        try {
          if (typeof window.confirm === 'function') {
            proceed = window.confirm('Reset the API key, team paste, provider and Elo scaler?');
          }
        } catch (e) { proceed = true; }
        if (!proceed) return;
        applyToForm(DEFAULTS);
        saveSettings({
          provider: DEFAULTS.provider,
          apiKey: '',
          teamText: '',
          elo: DEFAULTS.elo
        }).then(function () {
          setStatus('Configuration reset to defaults.', 'warn');
        });
      });
    }

    loadSettings().then(function (cfg) {
      applyToForm(cfg);
      var summary = validateTeamText(cfg.teamText || '');
      if (!cfg.apiKey && !cfg.teamText) {
        setStatus('Paste your six Pokemon, then save.', '');
      } else if (summary.count === 6) {
        setStatus('Loaded: ' + PROVIDER_LABELS[cfg.provider] + ' · Elo ' + cfg.elo + ' · team 6/6.', 'ok');
      } else {
        setStatus('Loaded: ' + PROVIDER_LABELS[cfg.provider] + ' · Elo ' + cfg.elo + ' · team ' +
          summary.count + '/6 (needs attention).', 'warn');
      }
    });
  }

  // Exported for the extension's own debug console and for tests.
  ST.Options = {
    DEFAULTS: DEFAULTS,
    validateTeamText: validateTeamText,
    isTrickRoomSet: isTrickRoomSet,
    normalizeParseResult: normalizeParseResult,
    eloHint: eloHint,
    clampElo: clampElo,
    init: init
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
