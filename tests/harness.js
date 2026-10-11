/* Showdown Tactician — tests/harness.js
 * Loads the extension's classic scripts into a sandbox that mimics the isolated world
 * of a content script (window + the vendored dex) with no DOM. Used by run_tests.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

const MANIFEST_ORDER = [
  'lib/calc-data.min.js',
  'lib/calc.min.js',
  'lib/species-abilities.js',
  'lib/species-aliases.js',
  'src/config.js',
  'src/util.js',
  'src/sets_usage.js',
  'src/scout_prior.js',
  'src/sets_db.js',
  'src/team_parser.js',
  'src/protocol_parser.js',
  'src/state_manager.js',
  'src/set_pruner.js',
  'src/calc_engine.js',
  'src/trick_room.js',
  'src/evaluator_128d.js',
  'src/tempo_vector.js',
  'src/opponent_clock.js',
  'src/veto_guard.js',
  'src/world_sampler.js',
  'src/laplace_core.js',
  'src/llm_client.js',
  'src/ui_overlay.js',
  'src/content.js'
];

function createSandbox(overrides) {
  const sandbox = {};
  sandbox.console = console;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.Date = Date;
  sandbox.Math = Math;
  sandbox.JSON = JSON;
  sandbox.Promise = Promise;
  sandbox.Error = Error;
  sandbox.TypeError = TypeError;
  sandbox.Float32Array = Float32Array;
  sandbox.Uint8Array = Uint8Array;
  sandbox.Int32Array = Int32Array;
  sandbox.Uint32Array = Uint32Array;
  sandbox.structuredClone = typeof structuredClone === 'function' ? structuredClone : undefined;
  sandbox.CustomEvent = function (type, init) {
    this.type = type; this.detail = init && init.detail;
  };
  sandbox.document = createFakeDocument();
  sandbox.location = { href: 'https://play.pokemonshowdown.com/', hostname: 'play.pokemonshowdown.com' };
  // chrome.storage.local backed by a plain object
  const store = {};
  sandbox.chrome = {
    runtime: { id: 'test-extension', getURL: function (p) { return 'chrome-extension://test/' + p; }, sendMessage: function (msg, cb) { if (cb) cb({ ok: false, error: 'no background in tests' }); }, lastError: null },
    storage: {
      local: {
        get: function (defaults, cb) {
          if (typeof defaults === 'function') { cb(defaults); return; }
          const out = {};
          Object.keys(defaults || {}).forEach(function (k) { out[k] = Object.prototype.hasOwnProperty.call(store, k) ? store[k] : defaults[k]; });
          if (cb) cb(out);
          return Promise.resolve(out);
        },
        set: function (obj, cb) {
          Object.keys(obj || {}).forEach(function (k) { store[k] = obj[k]; });
          if (cb) cb();
          return Promise.resolve();
        }
      }
    }
  };
  vm.createContext(sandbox);
  if (overrides) Object.keys(overrides).forEach(function (k) { sandbox[k] = overrides[k]; });
  return sandbox;
}

/* A tiny DOM good enough for the HUD: tracks created elements, query results. */
function createFakeDocument() {
  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      children: [],
      style: {},
      dataset: {},
      attributes: {},
      classList: {
        _set: new Set(),
        add: function () { for (let i = 0; i < arguments.length; i++) this._set.add(arguments[i]); },
        remove: function () { for (let i = 0; i < arguments.length; i++) this._set.delete(arguments[i]); },
        contains: function (c) { return this._set.has(c); },
        toggle: function (c, on) { if (on === undefined ? !this._set.has(c) : on) this._set.add(c); else this._set.delete(c); }
      },
      className: '',
      textContent: '',
      innerHTML: '',
      parentNode: null,
      setAttribute: function (k, v) { this.attributes[k] = v; },
      getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
      removeAttribute: function (k) { delete this.attributes[k]; },
      appendChild: function (c) { c.parentNode = el; el.children.push(c); return c; },
      removeChild: function (c) { el.children = el.children.filter(function (x) { return x !== c; }); c.parentNode = null; return c; },
      remove: function () { if (el.parentNode) el.parentNode.removeChild(el); },
      insertBefore: function (c) { c.parentNode = el; el.children.unshift(c); return c; },
      addEventListener: function () { },
      removeEventListener: function () { },
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
      getBoundingClientRect: function () { return { top: 0, left: 0, width: 1080, height: 2340, right: 1080, bottom: 2340 }; },
      click: function () { }
    };
    return el;
  }
  const head = makeEl('head');
  const body = makeEl('body');
  const doc = {
    documentElement: makeEl('html'),
    head: head,
    body: body,
    readyState: 'complete',
    createElement: makeEl,
    createTextNode: function (t) { const e = makeEl('#text'); e.textContent = t; return e; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getElementById: function () { return null; },
    addEventListener: function () { },
    removeEventListener: function () { },
    dispatchEvent: function (evt) { if (doc._listeners) doc._listeners.slice().forEach(function (fn) { fn(evt); }); return true; },
    _listeners: [],
    title: 'Showdown Tactician test'
  };
  doc.addEventListener = function (type, fn) { doc._listeners.push(fn); };
  doc._makeEl = makeEl;
  return doc;
}

/**
 * Load every script that exists, in manifest order. Throws on syntax errors.
 * opts.skip:    array of relative paths to skip.
 * opts.through: stop after this relative path (inclusive) - use this instead of slicing
 *               MANIFEST_ORDER by index, which silently breaks when a file is inserted.
 */
function loadAll(overrides, opts) {
  opts = opts || {};
  const sandbox = createSandbox(overrides);
  const loaded = [];
  const missing = [];
  const skip = new Set(opts.skip || []);
  for (const rel of MANIFEST_ORDER) {
    if (skip.has(rel)) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    const code = fs.readFileSync(abs, 'utf8');
    vm.runInContext(code, sandbox, { filename: rel });
    loaded.push(rel);
    if (opts.through && rel === opts.through) break;
  }
  sandbox.__loaded = loaded;
  sandbox.__missing = missing;
  return sandbox;
}

/** Load an arbitrary set of files (relative paths) into a fresh sandbox. */
function loadFiles(relPaths, overrides) {
  const sandbox = createSandbox(overrides);
  relPaths.forEach(function (rel) {
    const abs = path.join(ROOT, rel);
    vm.runInContext(fs.readFileSync(abs, 'utf8'), sandbox, { filename: rel });
  });
  return sandbox;
}

module.exports = { loadAll, loadFiles, createSandbox, createFakeDocument, MANIFEST_ORDER, ROOT };
