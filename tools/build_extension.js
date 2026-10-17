/* Showdown Tactician — tools/build_extension.js
 *
 * ONE SOURCE TREE, TWO MANIFESTS. Chrome and Firefox do not agree on how an MV3 extension runs
 * code in the background:
 *
 *   Chrome    requires `background.service_worker`, and an MV3 manifest that also carries
 *             `background.scripts` is at best a warning and at worst a refusal to load — which
 *             Chrome surfaces as the generic "Manifest file is missing or unreadable".
 *   Firefox   has no background service worker. It runs `background.scripts` as an event page,
 *             and a manifest that only names a service_worker leaves the extension with no
 *             background at all.
 *
 * There is no single manifest that satisfies both, so there are two: `manifest.json` (Chrome) and
 * `manifest.firefox.json` (Firefox). This tool assembles one loadable folder per browser under
 * `dist/`, and REFUSES rather than shipping a manifest that would fail at install time:
 *
 *   - each manifest must be MV3 and declare exactly ONE background mode, the right one for it;
 *   - every file a manifest names must exist (a renamed content script is a silent no-op at
 *     runtime, because every module guards its own dependencies);
 *   - the two manifests must agree on every other key, so the Chrome and Firefox builds cannot
 *     drift apart one edit at a time.
 *
 * USAGE
 *   node tools/build_extension.js              write dist/chrome and dist/firefox
 *   node tools/build_extension.js --check      validate only, write nothing (used by the tests)
 *   node tools/build_extension.js --out <dir>  build somewhere other than dist/
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
/* Everything the extension SHIPS. The manifests list their own entry points, but the options page
 * and the overlay load siblings by relative path, so the folders are copied whole rather than
 * file-by-file: a list of files here would be a second manifest to keep in sync. */
const ASSET_DIRS = ['src', 'lib', 'options', 'styles'];
/* Keys that are ALLOWED to differ between the two manifests, each for a stated reason. */
const PER_BROWSER_KEYS = ['background', 'browser_specific_settings', 'minimum_chrome_version'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Every path a manifest names, in the order a reviewer would want to check them. */
function collectFiles(manifest) {
  const files = [];
  const bg = manifest.background || {};
  if (bg.service_worker) files.push(bg.service_worker);
  (bg.scripts || []).forEach(function (f) { files.push(f); });
  if (bg.page) files.push(bg.page);
  if (manifest.options_ui && manifest.options_ui.page) files.push(manifest.options_ui.page);
  if (manifest.action && manifest.action.default_popup) files.push(manifest.action.default_popup);
  (manifest.content_scripts || []).forEach(function (entry) {
    (entry.js || []).forEach(function (f) { files.push(f); });
    (entry.css || []).forEach(function (f) { files.push(f); });
  });
  (manifest.web_accessible_resources || []).forEach(function (entry) {
    (entry.resources || []).forEach(function (f) { files.push(f); });
  });
  if (manifest.icons) {
    Object.keys(manifest.icons).forEach(function (k) { files.push(manifest.icons[k]); });
  }
  // De-duplicate while keeping order: the same file is legitimately listed twice (a web-accessible
  // resource that is also a content script), and double-copying it is wasted work, not an error.
  const seen = {};
  return files.filter(function (f) {
    if (seen[f]) return false;
    seen[f] = true;
    return true;
  });
}

/**
 * validateManifest(manifest, target) -> string[] of problems (empty = loadable)
 * `target` is 'chrome' or 'firefox', and it decides which background mode is the ONLY legal one.
 */
function validateManifest(manifest, target) {
  const problems = [];
  if (!isObject(manifest)) return ['the manifest is not a JSON object'];
  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3, got ' + manifest.manifest_version);
  ['name', 'version', 'description'].forEach(function (k) {
    if (typeof manifest[k] !== 'string' || !manifest[k].trim()) problems.push(k + ' must be a non-empty string');
  });
  if (typeof manifest.version === 'string' &&
      !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
    problems.push('version must be 1-4 dot-separated integers, got ' + JSON.stringify(manifest.version));
  }

  const bg = manifest.background;
  if (!isObject(bg)) {
    problems.push('background is missing');
  } else {
    const modes = ['service_worker', 'scripts', 'page'].filter(function (k) { return bg[k] !== undefined; });
    if (modes.length !== 1) {
      problems.push('background must declare exactly one of service_worker / scripts / page, found: ' +
        (modes.length ? modes.join(', ') : 'none'));
    } else if (target === 'chrome') {
      if (modes[0] !== 'service_worker') {
        problems.push('the Chrome manifest must use background.service_worker, not background.' + modes[0]);
      }
      if (manifest.browser_specific_settings !== undefined) {
        problems.push('browser_specific_settings is a Gecko key: it belongs in manifest.firefox.json, ' +
          'not in the Chrome manifest (Chrome only warns, but a warning on load is a smell)');
      }
    } else {
      if (modes[0] !== 'scripts') {
        problems.push('the Firefox manifest must use background.scripts (an event page), not background.' + modes[0]);
      }
      const gecko = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
      if (!gecko || typeof gecko.id !== 'string' || !gecko.id) {
        problems.push('browser_specific_settings.gecko.id is required to sign an MV3 add-on');
      }
      if (gecko && typeof gecko.strict_min_version !== 'string') {
        problems.push('browser_specific_settings.gecko.strict_min_version is missing');
      }
      if (manifest.minimum_chrome_version !== undefined) {
        problems.push('minimum_chrome_version is a Chromium key and belongs in manifest.json');
      }
    }
  }

  if (!Array.isArray(manifest.permissions)) problems.push('permissions must be an array');
  if (!Array.isArray(manifest.host_permissions)) problems.push('host_permissions must be an array');
  const scripts = manifest.content_scripts;
  if (!Array.isArray(scripts) || !scripts.length) {
    problems.push('content_scripts must be a non-empty array');
  } else {
    scripts.forEach(function (entry, i) {
      if (!isObject(entry)) { problems.push('content_scripts[' + i + '] is not an object'); return; }
      if (!Array.isArray(entry.matches) || !entry.matches.length) {
        problems.push('content_scripts[' + i + '].matches is empty');
      }
      if (!Array.isArray(entry.js) || !entry.js.length) {
        problems.push('content_scripts[' + i + '].js is empty');
      }
    });
  }
  if (manifest.web_accessible_resources !== undefined) {
    (manifest.web_accessible_resources || []).forEach(function (entry, i) {
      if (!isObject(entry) || !Array.isArray(entry.resources) || !Array.isArray(entry.matches)) {
        problems.push('web_accessible_resources[' + i + '] must carry resources[] and matches[]');
      }
    });
  }

  const missing = collectFiles(manifest).filter(function (rel) {
    return !fs.existsSync(path.join(ROOT, rel));
  });
  if (missing.length) problems.push('files named by the manifest do not exist: ' + missing.join(', '));
  return problems;
}

/** Deep equality over JSON values; key order is irrelevant. */
function sameJson(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
    return true;
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(b, ka[i])) return false;
      if (!sameJson(a[ka[i]], b[ka[i]])) return false;
    }
    return true;
  }
  return false;
}

/**
 * compareManifests(chrome, firefox) -> string[] of drift problems.
 * Everything except the per-browser keys has to be identical: the content-script ORDER, the
 * web-accessible resources, the options page. Two manifests that disagree about what the extension
 * IS would mean the Firefox build is a different extension wearing the same version number.
 */
function compareManifests(chrome, firefox) {
  const problems = [];
  const strip = function (m) {
    const out = {};
    Object.keys(m || {}).forEach(function (k) {
      if (PER_BROWSER_KEYS.indexOf(k) === -1) out[k] = m[k];
    });
    return out;
  };
  const a = strip(chrome), b = strip(firefox);
  const keys = Object.keys(a).concat(Object.keys(b).filter(function (k) { return !(k in a); }));
  keys.forEach(function (k) {
    if (!sameJson(a[k], b[k])) problems.push('manifest.json and manifest.firefox.json disagree on `' + k + '`');
  });
  return problems;
}

/** Copy the shared asset folders into a target directory. */
function copyAssets(target) {
  fs.mkdirSync(target, { recursive: true });
  ASSET_DIRS.forEach(function (dir) {
    const from = path.join(ROOT, dir);
    if (!fs.existsSync(from)) throw new Error('missing asset folder: ' + dir);
    fs.cpSync(from, path.join(target, dir), { recursive: true });
  });
}

/**
 * build(opts) -> { chrome, firefox, files, problems }
 * With `check` set, nothing is written and `chrome` / `firefox` are the target paths it WOULD write.
 */
function build(options) {
  const opts = options || {};
  const outRoot = path.resolve(ROOT, opts.out || 'dist');
  const chromePath = path.join(outRoot, 'chrome');
  const firefoxPath = path.join(outRoot, 'firefox');
  const chrome = readJson(path.join(ROOT, 'manifest.json'));
  const firefox = readJson(path.join(ROOT, 'manifest.firefox.json'));

  const problems = validateManifest(chrome, 'chrome')
    .map(function (p) { return 'manifest.json: ' + p; })
    .concat(validateManifest(firefox, 'firefox').map(function (p) { return 'manifest.firefox.json: ' + p; }))
    .concat(compareManifests(chrome, firefox));
  const files = collectFiles(chrome);

  if (problems.length) return { chrome: chromePath, firefox: firefoxPath, files: files, problems: problems, written: false };
  if (opts.check) return { chrome: chromePath, firefox: firefoxPath, files: files, problems: [], written: false };

  // A rebuild REPLACES the folder: a file deleted from src/ must not linger in dist/ and keep being
  // loaded, which is the one way a stale build can behave differently from the tree it claims to be.
  fs.rmSync(chromePath, { recursive: true, force: true });
  fs.rmSync(firefoxPath, { recursive: true, force: true });
  copyAssets(chromePath);
  copyAssets(firefoxPath);
  fs.writeFileSync(path.join(chromePath, 'manifest.json'), JSON.stringify(chrome, null, 2) + '\n');
  fs.writeFileSync(path.join(firefoxPath, 'manifest.json'), JSON.stringify(firefox, null, 2) + '\n');
  return { chrome: chromePath, firefox: firefoxPath, files: files, problems: [], written: true };
}

function parseArgs(argv) {
  const out = { check: false, out: 'dist', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

function main(argv) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node tools/build_extension.js [--check] [--out dist]');
    console.log('  writes dist/chrome (MV3 service worker) and dist/firefox (MV3 event page)');
    return 0;
  }
  const result = build(opts);
  if (result.problems.length) {
    console.error('build_extension: the manifests cannot be shipped:');
    result.problems.forEach(function (p) { console.error('  - ' + p); });
    return 1;
  }
  if (!opts.quiet) {
    console.log(result.written
      ? 'built ' + result.files.length + ' referenced files into two loadable folders:'
      : 'checked ' + result.files.length + ' referenced files; manifests are loadable (nothing written)');
    console.log('  Chrome   ' + path.relative(ROOT, result.chrome) +
      '\n           chrome://extensions -> Developer mode -> Load unpacked -> this folder');
    console.log('  Firefox  ' + path.relative(ROOT, result.firefox) +
      '\n           about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> manifest.json in this folder');
  }
  return 0;
}

module.exports = {
  ASSET_DIRS: ASSET_DIRS, PER_BROWSER_KEYS: PER_BROWSER_KEYS,
  collectFiles: collectFiles, validateManifest: validateManifest, sameJson: sameJson,
  compareManifests: compareManifests, build: build, parseArgs: parseArgs, main: main
};

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error('build_extension: ' + ((err && err.message) || err));
    process.exit(1);
  }
}
