/* Showdown Tactician - tools/sync_chaos_sets.js
 *
 * WHY THIS EXISTS
 *   src/sets_db.js is hand-curated on purpose: real EV spreads, real natures, real roles, every
 *   species/item/move resolved against the vendored dex. Showdown's monthly chaos dump is the
 *   exact opposite kind of source. It is authoritative on FREQUENCY — how often an item, an
 *   ability or a move appears on a species at the 1760+ cutoff — but it is a bag of MARGINALS:
 *   it never says which item was held together with which four moves, so it cannot reconstruct
 *   a legal 4-move set with an EV spread. Replacing the curated database with chaos-derived
 *   sets would trade verified spread knowledge for statistically average garbage.
 *
 *   What the dump can do is move the WEIGHTING: the world sampler draws opponent sets from
 *   `SetCandidate.weight`, and if Heavy-Duty Boots has grown to 62% of Great Tusk while the
 *   curated set still says 40%, the curated prior is simply stale. So this tool writes a small
 *   overlay file, src/sets_usage.js, and src/sets_db.js multiplies each curated set's weight by
 *   the observed item share of its species when that overlay is present
 *   (ST.SetDatabase.reweightByUsage). Curated spreads and moves survive; ladder frequency
 *   replaces the hand-guessed popularity numbers.
 *
 * WHAT IT READS
 *   The chaos dump published by Showdown, shaped:
 *     { "info": { ... }, "data": { "Great Tusk": { "usage": 0.312,
 *         "Items": { "Heavy-Duty Boots": 0.62, ... }, "Abilities": { ... },
 *         "Moves": { ... }, "Spreads": { ... } }, ... } }
 *   `usage` and every share inside `Items`/`Abilities`/`Moves` is a 0..1 FRACTION in the
 *   published dumps, but a dump that has been through a spreadsheet or a JSON wrapper often
 *   carries the percent already. normalizeUsage() accepts both: anything above 1 is already a
 *   percent, anything at or below 1 is multiplied by 100.
 *
 * WHAT IT WRITES
 *   --out (default src/sets_usage.js): a generated data file that assigns window.ST_USAGE.
 *   Nothing under 1.5% usage by default, top 12 items / 8 abilities / 16 moves per species, all
 *   keys as ids and all shares as percents rounded to 2 dp, every collection sorted so the same
 *   dump always renders byte-identical output (the workflow commits only on a real diff).
 *   If ZERO species survive the filter, buildOverlay() throws and main() reports it without
 *   writing anything: an empty overlay would silently look like "no metagame drift".
 *
 * RUN
 *   node tools/sync_chaos_sets.js --input chaos.json
 *   node tools/sync_chaos_sets.js --url https://stats.pokemonshowdown.com/chaos/gen9nationaldexou-1760.json
 *   (see .github/workflows/chaos-sync.yml for the monthly run)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  out: 'src/sets_usage.js',
  minUsage: 1.5,     // percent
  maxItems: 12,
  maxAbilities: 8,
  maxMoves: 16
};

/* ----------------------------------------------------------------------------- helpers */

/**
 * The same id rule as ST.util.toID (src/util.js), including its Flabébé special case, because
 * these keys are looked up with U.toID on the other side. A tool that spelled ids differently
 * from the engine would produce an overlay that silently never matches a single set.
 */
function toID(str) {
  if (str === null || str === undefined) return '';
  const s = String(str).toLowerCase();
  return s === 'flab\u00e9b\u00e9' ? 'flabebe' : s.replace(/[^a-z0-9]+/g, '');
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** A 0..1 fraction becomes a percent; a value already above 1 is a percent. Junk is 0. */
function normalizeUsage(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!isFinite(n) || n <= 0) return 0;
  return n > 1 ? n : n * 100;
}

/** Case-tolerant field lookup: chaos dumps are inconsistent about `Items` vs `items`. */
function pickField(entry, names) {
  for (let i = 0; i < names.length; i++) {
    const v = entry ? entry[names[i]] : undefined;
    if (v && typeof v === 'object') return v;
  }
  return null;
}

/**
 * One marginal collection (items / abilities / moves) as { id: percent }, capped and sorted so
 * the rendering is deterministic. Display names collapse onto ids; the higher share wins.
 */
function marginals(map, cap) {
  const raw = map || {};
  const byId = Object.create(null);
  Object.keys(raw).forEach(function (name) {
    const id = toID(name);
    if (!id) return;
    const pct = round2(normalizeUsage(raw[name]));
    if (!(pct > 0)) return;
    if (!byId[id] || pct > byId[id].pct) byId[id] = { id: id, pct: pct };
  });
  const rows = Object.keys(byId).map(function (id) { return byId[id]; });
  rows.sort(function (a, b) {
    if (b.pct !== a.pct) return b.pct - a.pct;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const out = {};
  rows.slice(0, cap).forEach(function (r) { out[r.id] = r.pct; });
  return out;
}

/* ------------------------------------------------------------------------- the pipeline */

/** Species at or above the usage floor, most used first (ties broken by name). */
function filterChaos(payload, options) {
  const opts = options || {};
  const minUsage = typeof opts.minUsage === 'number' && isFinite(opts.minUsage) ? opts.minUsage : DEFAULTS.minUsage;
  const data = (payload && (payload.data || payload)) || {};
  const rows = [];
  Object.keys(data).forEach(function (name) {
    const entry = data[name];
    if (!entry || typeof entry !== 'object') return;
    const usage = round2(normalizeUsage(entry.usage));
    if (usage < minUsage) return;
    rows.push({ name: name, usage: usage, entry: entry });
  });
  rows.sort(function (a, b) {
    if (b.usage !== a.usage) return b.usage - a.usage;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return rows;
}

/**
 * Build the overlay object that renderFile() serialises. Throws when the dump yields no
 * species at or above the floor — an empty overlay is indistinguishable from "the metagame
 * did not move", so it must never be written.
 */
function buildOverlay(payload, options) {
  const opts = options || {};
  const minUsage = typeof opts.minUsage === 'number' && isFinite(opts.minUsage) ? opts.minUsage : DEFAULTS.minUsage;
  const rows = filterChaos(payload, { minUsage: minUsage });
  const species = {};
  rows.forEach(function (row) {
    const id = toID(row.name);
    if (!id) return;
    if (species[id] && species[id].usage >= row.usage) return;   // keep the more used duplicate
    species[id] = {
      name: row.name,
      usage: row.usage,
      items: marginals(pickField(row.entry, ['Items', 'items']), opts.maxItems || DEFAULTS.maxItems),
      abilities: marginals(pickField(row.entry, ['Abilities', 'abilities']), opts.maxAbilities || DEFAULTS.maxAbilities),
      moves: marginals(pickField(row.entry, ['Moves', 'moves']), opts.maxMoves || DEFAULTS.maxMoves)
    };
  });
  const speciesCount = Object.keys(species).length;
  if (!speciesCount) {
    throw new Error('no species at or above ' + minUsage + '% usage: refusing to write an empty overlay');
  }
  return {
    generatedAt: typeof opts.date === 'string' && opts.date ? opts.date : new Date().toISOString(),
    source: typeof opts.source === 'string' ? opts.source : '',
    minUsage: minUsage,
    speciesCount: speciesCount,
    species: species
  };
}

/** The generated file text. Deterministic for a given overlay object. */
function renderFile(overlay) {
  const header =
    '/* Showdown Tactician - src/sets_usage.js\n' +
    ' * GENERATED FILE - do not edit by hand. Regenerate with tools/sync_chaos_sets.js\n' +
    ' * (see .github/workflows/chaos-sync.yml; it runs monthly).\n' +
    ' *\n' +
    ' * Top-ladder usage for the species above the filter floor, as percents, keyed by\n' +
    ' * ST.util.toID. It is deliberately NOT a set database: chaos stats publish the marginals\n' +
    ' * (items, abilities, moves) separately, so they cannot reconstruct a legal spread + 4\n' +
    ' * moves. ST.SetDatabase.reweightByUsage() multiplies each curated set weight by the\n' +
    ' * observed item share of its species, which is the only thing this data can honestly say.\n' +
    ' */\n';
  return header + '(function () {\n  "use strict";\n  window.ST_USAGE = ' +
    JSON.stringify(overlay) + ';\n})();\n';
}

/* ------------------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') !== 0) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.indexOf('--') === 0) { out[key] = true; continue; }
    out[key] = next;
    i++;
  }
  return out;
}

function num(value, fallback) {
  const n = parseFloat(value);
  return isFinite(n) ? n : fallback;
}

/** Thin so the rest of the tool stays synchronous and testable: only this touches the network. */
function download(url) {
  return Promise.resolve().then(function () {
    if (typeof fetch !== 'function') throw new Error('this Node has no fetch; pass --input <file> instead');
    return fetch(url).then(function (res) {
      if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status) + ' from ' + url);
      return res.json();
    });
  });
}

function main(argv) {
  const args = parseArgs(argv || process.argv.slice(2));
  const opts = {
    minUsage: num(args['min-usage'], DEFAULTS.minUsage),
    maxItems: num(args['max-items'], DEFAULTS.maxItems),
    maxAbilities: num(args['max-abilities'], DEFAULTS.maxAbilities),
    maxMoves: num(args['max-moves'], DEFAULTS.maxMoves),
    source: typeof args.source === 'string' ? args.source : '',
    date: typeof args.date === 'string' ? args.date : new Date().toISOString()
  };
  const outPath = path.resolve(ROOT, typeof args.out === 'string' ? args.out : DEFAULTS.out);
  const load = typeof args.input === 'string'
    ? Promise.resolve(JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args.input), 'utf8')))
    : (typeof args.url === 'string'
      ? download(args.url)
      : Promise.reject(new Error('pass --input <chaos.json> or --url <https url>')));

  return load.then(function (payload) {
    const overlay = buildOverlay(payload, opts);
    const text = renderFile(overlay);
    fs.writeFileSync(outPath, text);
    console.log('chaos sync: ' + overlay.speciesCount + ' species at or above ' + overlay.minUsage + '% usage');
    console.log('wrote ' + path.relative(ROOT, outPath) + ' (' + text.length + ' bytes' +
      (overlay.source ? ', source ' + overlay.source : '') + ')');
    return overlay;
  }).catch(function (err) {
    console.error('chaos sync FAILED: ' + ((err && err.message) || err));
    console.error('nothing was written to ' + path.relative(ROOT, outPath));
    process.exitCode = 1;
    return null;
  });
}

if (require.main === module) main();

module.exports = { normalizeUsage: normalizeUsage, filterChaos: filterChaos, buildOverlay: buildOverlay, renderFile: renderFile };
