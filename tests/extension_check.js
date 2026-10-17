/* Showdown Tactician — tests/extension_check.js
 *
 * THE INSTALL IS A DELIVERABLE. The extension is not a library: the artifact a user runs is a
 * FOLDER they point a browser at, and the only thing a browser reads before it runs any of this
 * code is the manifest. Two browsers disagree about the one key that matters most:
 *
 *   Chrome   runs `background.service_worker` and treats `background.scripts` in an MV3 manifest
 *            as at best a warning (older Chromes refused the load outright).
 *   Firefox  has no background service worker; it runs `background.scripts` as an event page.
 *
 * So there are two manifests, `manifest.json` (Chrome) and `manifest.firefox.json` (Firefox), and
 * `tools/build_extension.js` assembles one loadable folder per browser. This suite pins the
 * properties that make each of them loadable, and the refusals that stop a broken one from being
 * shipped:
 *
 *   1. each manifest is MV3 and declares exactly ONE background mode, the right one for its target;
 *   2. every file either manifest names exists (a rename is otherwise a silent no-op at runtime);
 *   3. the two manifests agree on everything except the per-browser keys, so the builds cannot
 *      drift into being different extensions with the same version number;
 *   4. the Chrome manifest carries no Gecko keys, so Chrome does not load it "with warnings";
 *   5. the builder refuses each of those failures BY NAME, and `--check` writes nothing.
 *
 * Usage:  node tests/extension_check.js     (exit 0 = every check passed)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const B = require('../tools/build_extension.js');

const ROOT = path.resolve(__dirname, '..');
const CHROME = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const FIREFOX = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.firefox.json'), 'utf8'));

let fails = 0;
function check(name, condition, detail) {
  const ok = !!condition;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '  ->  ' + detail));
  if (!ok) fails++;
  return ok;
}
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  got=' + JSON.stringify(got) + (ok ? '' : ' want=' + JSON.stringify(want)));
  if (!ok) fails++;
  return ok;
}
const clone = function (v) { return JSON.parse(JSON.stringify(v)); };
const problemsOf = function (list) { return list.join(' | '); };

/* ---------------------------------------------------------------- 1. the shipped manifests */

console.log('\n=== 1. each manifest is loadable by its own browser ===');

eq('the Chrome manifest is MV3', CHROME.manifest_version, 3);
eq('...runs a service worker', Object.keys(CHROME.background), ['service_worker']);
eq('...and names the file that exists', fs.existsSync(path.join(ROOT, CHROME.background.service_worker)), true);
eq('...carries no Gecko settings (Chrome would only warn)', CHROME.browser_specific_settings, undefined);
eq('...and no Chromium version floor that could refuse an older install', CHROME.minimum_chrome_version, undefined);
eq('the Chrome manifest validates with no problems', B.validateManifest(CHROME, 'chrome'), []);

eq('the Firefox manifest is MV3', FIREFOX.manifest_version, 3);
eq('...runs an event page, not a service worker', Object.keys(FIREFOX.background), ['scripts']);
eq('...naming the same background file', FIREFOX.background.scripts, ['src/background.js']);
eq('...declares a Gecko id (Mozilla refuses to sign MV3 without one)',
  typeof (FIREFOX.browser_specific_settings.gecko || {}).id, 'string');
eq('...and a Gecko floor', typeof (FIREFOX.browser_specific_settings.gecko || {}).strict_min_version, 'string');
eq('the Firefox manifest validates with no problems', B.validateManifest(FIREFOX, 'firefox'), []);
check('...and its Gecko floor is MV3-capable (>= 109)',
  parseFloat(FIREFOX.browser_specific_settings.gecko.strict_min_version) >= 109,
  FIREFOX.browser_specific_settings.gecko.strict_min_version);

check('every file BOTH manifests name exists',
  B.collectFiles(CHROME).every(function (rel) { return fs.existsSync(path.join(ROOT, rel)); }) &&
  B.collectFiles(FIREFOX).every(function (rel) { return fs.existsSync(path.join(ROOT, rel)); }),
  B.collectFiles(CHROME).filter(function (rel) { return !fs.existsSync(path.join(ROOT, rel)); }).join(' '));

/* The content-script ORDER is load-bearing: the modules are IIFEs in dependency order, so a
 * manifest that lists them differently is a different extension, not a formatting choice. */
eq('the content-script chain is identical in both manifests, in order',
  B.collectFiles(CHROME), B.collectFiles(FIREFOX));
eq('the two manifests agree on everything but the per-browser keys',
  B.compareManifests(CHROME, FIREFOX), []);
eq('...including the options page and the web-accessible resources',
  [CHROME.options_ui.page, CHROME.web_accessible_resources], [FIREFOX.options_ui.page, FIREFOX.web_accessible_resources]);

/* ---------------------------------------------------------------- 2. the refusals, by name */

console.log('\n=== 2. the builder refuses each way a manifest can fail to load ===');

(function () {
  const bad = clone(CHROME);
  bad.background = { scripts: ['src/background.js'] };
  const p = problemsOf(B.validateManifest(bad, 'chrome'));
  check('Chrome: an event page instead of a service worker is refused', /service_worker/.test(p), p);
})();

(function () {
  const bad = clone(CHROME);
  bad.background = { service_worker: 'src/background.js', scripts: ['src/background.js'] };
  const p = problemsOf(B.validateManifest(bad, 'chrome'));
  check('Chrome: two background modes at once is refused', /exactly one/.test(p), p);
})();

(function () {
  const bad = clone(FIREFOX);
  bad.background = { service_worker: 'src/background.js' };
  const p = problemsOf(B.validateManifest(bad, 'firefox'));
  check('Firefox: a service worker with no event page is refused', /background\.scripts/.test(p), p);
})();

(function () {
  const bad = clone(FIREFOX);
  delete bad.browser_specific_settings;
  const p = problemsOf(B.validateManifest(bad, 'firefox'));
  check('Firefox: a missing Gecko id is refused', /gecko\.id/.test(p), p);
})();

(function () {
  const bad = clone(CHROME);
  bad.manifest_version = 2;
  const p = problemsOf(B.validateManifest(bad, 'chrome'));
  check('an MV2 manifest is refused', /manifest_version/.test(p), p);
})();

(function () {
  const bad = clone(CHROME);
  bad.content_scripts[0].js.push('src/does_not_exist.js');
  const p = problemsOf(B.validateManifest(bad, 'chrome'));
  check('a manifest naming a file that is not there is refused, and the file is named',
    /does_not_exist\.js/.test(p), p);
})();

(function () {
  const bad = clone(CHROME);
  bad.content_scripts = [];
  const p = problemsOf(B.validateManifest(bad, 'chrome'));
  check('a manifest with no content scripts is refused', /content_scripts/.test(p), p);
})();

(function () {
  const bad = clone(FIREFOX);
  bad.content_scripts[0].js.reverse();
  const p = problemsOf(B.compareManifests(CHROME, bad));
  check('a content-script ORDER that drifts between the two builds is refused', /content_scripts/.test(p), p);
})();

(function () {
  const bad = clone(FIREFOX);
  bad.name = 'Something Else';
  const p = problemsOf(B.compareManifests(CHROME, bad));
  check('...and so is a different name', /`name`/.test(p), p);
})();

/* ---------------------------------------------------------------- 3. the build itself */

console.log('\n=== 3. the build assembles two loadable folders, and --check writes nothing ===');

(function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ext-'));
  const checkOut = path.join(tmp, 'check-outs');
  const checked = B.build({ out: checkOut, check: true });
  eq('--check reports no problems', checked.problems, []);
  eq('...and writes nothing', fs.existsSync(checkOut), false);
  eq('...while still naming where it WOULD build',
    [path.basename(checked.chrome), path.basename(checked.firefox)], ['chrome', 'firefox']);

  const built = B.build({ out: checkOut });
  eq('the build reports the same number of referenced files it validated', built.files.length, B.collectFiles(CHROME).length);
  check('the Chrome target exists and carries the Chrome manifest',
    fs.existsSync(path.join(checkOut, 'chrome', 'manifest.json')) &&
    !JSON.parse(fs.readFileSync(path.join(checkOut, 'chrome', 'manifest.json'), 'utf8')).background.scripts,
    '');
  check('the Firefox target carries the Firefox manifest',
    !!JSON.parse(fs.readFileSync(path.join(checkOut, 'firefox', 'manifest.json'), 'utf8')).background.scripts, '');
  check('both targets ship the module chain and the options page',
    ['src/content.js', 'lib/calc.min.js', 'options/options.html', 'styles/overlay.css'].every(function (rel) {
      return fs.existsSync(path.join(checkOut, 'chrome', rel)) &&
        fs.existsSync(path.join(checkOut, 'firefox', rel));
    }), '');
  check('a rebuild replaces the folder rather than merging into it',
    (function () {
      fs.writeFileSync(path.join(checkOut, 'chrome', 'stale.js'), '// gone next build\n');
      B.build({ out: checkOut });
      return !fs.existsSync(path.join(checkOut, 'chrome', 'stale.js'));
    })(), '');
  fs.rmSync(tmp, { recursive: true, force: true });
})();

console.log('\n' + (fails ? fails + ' FAILURES' : 'ALL EXTENSION-PACKAGING CHECKS PASSED'));
process.exit(fails ? 1 : 0);
