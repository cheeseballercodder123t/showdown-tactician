/* Showdown Tactician — tools/scout_replays.js
 *
 * WHY THIS EXISTS
 *   Everything else in this project reasons about an opponent from the SET DATABASE plus what
 *   the current battle has revealed. That is the right default, but against a known opponent it
 *   leaves information on the table: their last twenty games are public, and they say which
 *   items and which moves that player actually reaches for. This tool mines exactly that and
 *   writes src/scout_prior.js, a small overlay that src/set_pruner.js uses to bend the WEIGHT of
 *   the candidate sets it already holds.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   A replay must never become a set. A log reveals a species, an item, an ability and the moves
 *   that were actually clicked — it does NOT reveal EVs, IVs or a nature, and it cannot say which
 *   four moves were on the set (a move that was never needed is invisible). So this tool records
 *   only the dimensions a log can honestly support, as shares, and never fabricates the other
 *   half of a set. src/sets_db.js stays the only source of SETS; src/scout_prior.js only says
 *   which of those sets a particular opponent is likelier to be holding (ARCHITECTURE §6.3, RULE 1).
 *
 *   Unlike tools/sync_chaos_sets.js, an EMPTY overlay here is a legitimate, truthful result: it
 *   means "the corpus revealed nothing", and the pruner reads a missing species as "leave every
 *   curated weight untouched". So this tool writes the empty file rather than refusing to write.
 *
 * WHAT IT READS
 *   A corpus: an array of replay objects, or { replays: [...] }. Each replay is the shape
 *   replay.pokemonshowdown.com/<id>.json serves —
 *     { "id": "gen9nationaldexou-12345", "format": "gen9nationaldexou",
 *       "players": ["Name1", "Name2"], "log": "<raw protocol, '\\n' separated>" }
 *   `log` may be a string or an array of lines.
 *   Only these protocol shapes are mined, on the idents of the bodies they name:
 *     |switch| / |drag| / |replace|   the body's species (details first field) and its identity
 *     |move|<ident>|<Move>            a move that was actually clicked
 *     |-item|<ident>|<Item>           an item revealed (Trick, Frisk, Symbiosis, ...)
 *     |-enditem|<ident>|<Item>        an item that WAS held and is now gone (Knock Off, eaten)
 *     |-activate|<ident>|item: <Item> an item that activated (Air Balloon, Booster Energy, ...)
 *     |-ability|<ident>|<Ability>     a revealed ability
 *     |poke|                          used ONLY to learn a species' display name during preview;
 *                                     a preview body is not an appearance and never moves a share
 *
 * HOW SHARES ARE COUNTED (the denominators matter, so they are stated out loud)
 *   An APPEARANCE is one replay in which a species was seen on the field. `seen` counts those.
 *   Each dimension is then counted over the appearances where THAT dimension was observed at
 *   all: an item share of 100% means every appearance that revealed an item revealed this one —
 *   not that 100% of appearances held it, because an unrevealed item is not evidence. Duplicated
 *   observations inside one replay (the same item seen twice, the same move clicked four times)
 *   collapse into one, so one long game cannot outvote four short ones.
 *
 * RUN
 *   node tools/scout_replays.js --input replays.json
 *   node tools/scout_replays.js --url https://replay.pokemonshowdown.com/gen9nationaldexou-12345.json
 *   node tools/scout_replays.js --input replays.json --out src/scout_prior.js --min-share 5 --side p2
 *   --side defaults to 'both' (mine every body in the corpus); pass p1 or p2 to scope the mining
 *   to one player's bodies, which is what you want when the corpus is one opponent's games.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  out: 'src/scout_prior.js',
  minShare: 5      // percent
};

/* ------------------------------------------------------------------------------- helpers */

/**
 * The same id rule as ST.util.toID (src/util.js), including its Flabébé special case, because
 * the pruner looks these keys up with U.toID. A tool that spelled ids differently from the
 * engine would produce an overlay that silently never matches a single candidate set.
 */
function toID(str) {
  if (str === null || str === undefined) return '';
  const s = String(str).toLowerCase();
  return s === 'flab\u00e9b\u00e9' ? 'flabebe' : s.replace(/[^a-z0-9]+/g, '');
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function linesOf(log) {
  if (Array.isArray(log)) return log.map(function (l) { return String(l).replace(/\r$/, ''); });
  return String(log === undefined || log === null ? '' : log).split('\n').map(function (l) {
    return l.replace(/\r$/, '');
  });
}

/** An array of replays, or { replays: [...] }. Anything else is refused, not guessed at. */
function replaysOf(corpus) {
  if (Array.isArray(corpus)) return corpus;
  if (corpus && Array.isArray(corpus.replays)) return corpus.replays;
  throw new Error('scout_replays: input must be an array of replays or {replays:[...]}');
}

/** 'p2a: Kingambit' -> { side:'p2', slot:'p2a', name:'Kingambit' }. Tolerates a bare name. */
function splitIdent(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  const m = /^(p[12])([a-z]):\s*(.*)$/i.exec(raw);
  if (m) return { side: m[1].toLowerCase(), slot: (m[1] + m[2]).toLowerCase(), name: m[3].trim() };
  return { side: '', slot: '', name: raw };
}

/** 'Kingambit, L50, M' -> 'Kingambit'. The species is the first comma-separated field. */
function speciesOf(details, fallback) {
  const first = String(details === undefined || details === null ? '' : details).split(',')[0].trim();
  return first || String(fallback || '').trim();
}

/** Strip a leading 'item: ' / 'ability: ' clause and any trailing [from] clause. */
function clauseName(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/^[^:]*:\s*/, '')
    .replace(/\[.*$/, '')
    .trim();
}

function sortedUnique(list) {
  const seen = Object.create(null);
  const out = [];
  (list || []).forEach(function (v) {
    if (!v) return;
    if (seen[v]) return;
    seen[v] = true;
    out.push(v);
  });
  return out.sort();
}

/* --------------------------------------------------------------- one replay -> observations */

/**
 * observationsOf(replay, options) -> one APPEARANCE per species seen on the field in this replay.
 *
 * {
 *   index, id, side: 'both'|'p1'|'p2', skipped: bool, reason: string|null, lines: int,
 *   species: { kingambit: { name:'Kingambit', items:[ids], abilities:[ids], moves:[ids] } }
 * }
 *
 * The three arrays are deduped and sorted, so a replay's contribution to a share is one
 * observation per dimension no matter how long the game ran. Malformed lines are skipped; a
 * replay that yields no bodies at all is reported as skipped rather than thrown.
 */
function observationsOf(replay, options) {
  const opts = options || {};
  const sideFilter = String(opts.side || 'both').toLowerCase();
  const lines = linesOf(replay && replay.log);
  const species = Object.create(null);          // id -> appearance record
  const names = Object.create(null);            // id -> pretty display name (from |poke|)
  let bodies = 0;

  function wanted(side) {
    if (sideFilter !== 'p1' && sideFilter !== 'p2') return true;
    return side === sideFilter;
  }

  function appearance(id, name) {
    if (!id) return null;
    let rec = species[id];
    if (!rec) {
      rec = { name: name || names[id] || id, items: [], abilities: [], moves: [] };
      species[id] = rec;
    } else if (name && (!rec.name || rec.name === id)) {
      rec.name = name;
    }
    return rec;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // A line is `|cmd|a|b|c|`; a leading '>' (a header line) carries no protocol command.
    if (line.charAt(0) === '>') continue;
    if (line.charAt(0) !== '|') continue;
    const parts = line.split('|');
    const cmd = parts[1];
    if (!cmd) continue;

    if (cmd === 'poke') {
      // Team preview: learn the display name only. A preview body never moves a share, because
      // it may never enter the game and therefore reveals nothing at all.
      const id = toID(speciesOf(parts[3], parts[2]));
      if (id) names[id] = speciesOf(parts[3], parts[2]);
      continue;
    }

    if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
      const ident = splitIdent(parts[2]);
      if (!wanted(ident.side)) continue;
      const name = speciesOf(parts[3], ident.name);
      const rec = appearance(toID(name), name);
      if (rec) bodies++;
      continue;
    }

    if (cmd === 'move') {
      const ident = splitIdent(parts[2]);
      if (!wanted(ident.side)) continue;
      const rec = species[toID(ident.name)];
      if (!rec) continue;                        // a body we never saw switch in: nothing to attach to
      const id = toID(clauseName(parts[3]));
      if (id) rec.moves.push(id);
      continue;
    }

    if (cmd === '-item' || cmd === '-enditem') {
      const ident = splitIdent(parts[2]);
      if (!wanted(ident.side)) continue;
      const rec = species[toID(ident.name)];
      if (!rec) continue;
      const id = toID(clauseName(parts[3]));
      if (id) rec.items.push(id);
      continue;
    }

    if (cmd === '-activate') {
      const ident = splitIdent(parts[2]);
      if (!wanted(ident.side)) continue;
      const rec = species[toID(ident.name)];
      if (!rec) continue;
      const effect = String(parts[3] || '');
      if (/^\s*item:/i.test(effect)) {
        const id = toID(clauseName(effect));
        if (id) rec.items.push(id);
      }
      continue;
    }

    if (cmd === '-ability') {
      const ident = splitIdent(parts[2]);
      if (!wanted(ident.side)) continue;
      const rec = species[toID(ident.name)];
      if (!rec) continue;
      const id = toID(clauseName(parts[3]));
      if (id) rec.abilities.push(id);
      continue;
    }
  }

  const out = {};
  Object.keys(species).sort().forEach(function (id) {
    out[id] = {
      name: species[id].name,
      items: sortedUnique(species[id].items),
      abilities: sortedUnique(species[id].abilities),
      moves: sortedUnique(species[id].moves)
    };
  });

  return {
    index: typeof (replay && replay.index) === 'number' ? replay.index : 0,
    id: (replay && replay.id) || '',
    side: sideFilter === 'p1' || sideFilter === 'p2' ? sideFilter : 'both',
    skipped: bodies === 0,
    reason: bodies === 0 ? (lines.length ? 'no bodies on the field' : 'no protocol lines') : null,
    lines: lines.length,
    species: out
  };
}

/** Fold a count map into { id: percent } shares, biggest first (ties by id for determinism). */
function shares(counts, denominator, minShare) {
  const rows = [];
  Object.keys(counts).forEach(function (id) {
    const pct = denominator > 0 ? round1((counts[id] / denominator) * 100) : 0;
    if (pct < minShare) return;
    rows.push({ id: id, pct: pct });
  });
  rows.sort(function (a, b) {
    if (b.pct !== a.pct) return b.pct - a.pct;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const out = {};
  rows.forEach(function (r) { out[r.id] = r.pct; });
  return out;
}

/* ------------------------------------------------------------------ corpus -> the overlay */

/**
 * buildPrior(corpus, options) -> the overlay object renderFile() serialises.
 *
 * options: { minShare: 5, side: 'both'|'p1'|'p2', source: '<file|url>', date: ISO string }
 *
 * Deterministic for a given corpus: keys are inserted in sorted order and every collection is
 * sorted, so re-running on the same replays is byte-identical. An empty corpus (or one that
 * revealed nothing) yields an EMPTY overlay, which is the honest answer and is what the pruner
 * reads as "no prior".
 */
function buildPrior(corpus, options) {
  const opts = options || {};
  const minShare = typeof opts.minShare === 'number' && isFinite(opts.minShare) ? opts.minShare : DEFAULTS.minShare;
  const replays = replaysOf(corpus);

  // species id -> { name, seen, counts per dimension, per-dimension denominators }
  const tally = Object.create(null);
  let mined = 0;
  let skipped = 0;

  replays.forEach(function (replay, index) {
    const copy = replay && typeof replay === 'object' ? replay : {};
    const observed = observationsOf({
      index: index, id: copy.id, log: copy.log
    }, { side: opts.side });
    if (observed.skipped) { skipped++; return; }
    mined++;
    Object.keys(observed.species).forEach(function (sid) {
      const rec = observed.species[sid];
      let entry = tally[sid];
      if (!entry) {
        entry = {
          name: rec.name || sid, seen: 0,
          items: Object.create(null), abilities: Object.create(null), moves: Object.create(null),
          itemApps: 0, abilityApps: 0, moveApps: 0
        };
        tally[sid] = entry;
      }
      entry.seen++;
      if (rec.name && entry.name === sid) entry.name = rec.name;
      if (rec.items.length) { entry.itemApps++; rec.items.forEach(function (id) { entry.items[id] = (entry.items[id] || 0) + 1; }); }
      if (rec.abilities.length) { entry.abilityApps++; rec.abilities.forEach(function (id) { entry.abilities[id] = (entry.abilities[id] || 0) + 1; }); }
      if (rec.moves.length) { entry.moveApps++; rec.moves.forEach(function (id) { entry.moves[id] = (entry.moves[id] || 0) + 1; }); }
    });
  });

  const species = {};
  Object.keys(tally).sort().forEach(function (sid) {
    const entry = tally[sid];
    species[sid] = {
      name: entry.name,
      seen: entry.seen,
      items: shares(entry.items, entry.itemApps, minShare),
      abilities: shares(entry.abilities, entry.abilityApps, minShare),
      moves: shares(entry.moves, entry.moveApps, minShare)
    };
  });

  return {
    generatedAt: typeof opts.date === 'string' && opts.date ? opts.date : new Date().toISOString(),
    source: typeof opts.source === 'string' ? opts.source : null,
    replays: mined,
    minShare: minShare,
    species: species
  };
}

/* ------------------------------------------------------------------------------ rendering */

/** The generated file's header. renderFile() and the shipped src/scout_prior.js share it. */
const FILE_HEADER = [
  '/* Showdown Tactician — src/scout_prior.js',
  ' * GENERATED DATA FILE - do not edit by hand.',
  ' *',
  ' * Regenerated by tools/scout_replays.js from the opponent\'s OWN recent replays (a corpus of',
  ' * Pokémon Showdown replay JSON), never from the ladder and never at runtime: the tool runs',
  ' * offline and commits the result, so a battle never depends on replay.pokemonshowdown.com',
  ' * being reachable.',
  ' *',
  ' *   node tools/scout_replays.js --input replays.json [--out src/scout_prior.js]',
  ' *   node tools/scout_replays.js --url <https://replay.pokemonshowdown.com/....json>',
  ' *',
  ' * Shape:',
  ' *   window.ST_SCOUT = {',
  ' *     generatedAt: ISO string of the run, or null,',
  ' *     source: \'<corpus file name or replay url>\',',
  ' *     replays: how many replays were mined,',
  ' *     minShare: percent floor applied when the file was generated,',
  ' *     species: {',
  ' *       kingambit: {',
  ' *         name: \'Kingambit\',',
  ' *         seen: 4,                                  // replays the species appeared on the field',
  ' *         items:     { blackglasses: 66.7 },        // percent of appearances that revealed an item',
  ' *         abilities: { supremeoverlord: 100 },',
  ' *         moves:     { suckerpunch: 100, ... }      // percent of appearances that revealed moves',
  ' *       }',
  ' *     }',
  ' *   }',
  ' *',
  ' * Why this is a WEIGHT OVERLAY and not a set list: a replay reveals an item, an ability and the',
  ' * moves that were actually clicked — it never reveals EVs, IVs or a nature, and it cannot say',
  ' * which four moves were on the set. Building "a set" out of that would invent the unobserved',
  ' * half, which is exactly what RULE 1 forbids, so the curated src/sets_db.js stays the only',
  ' * source of SETS and this file only says which of those sets this particular opponent reaches',
  ' * for. See ARCHITECTURE §6.3 for the exact re-weighting.',
  ' *',
  ' * EMPTY IS MEANINGFUL: with no corpus mined (or a corpus that revealed nothing) this file',
  ' * carries no species, and the pruner leaves every curated weight untouched. An absent',
  ' * measurement must never be read as a zero measurement.',
  ' */'
].join('\n');

/**
 * The generated file text. Deterministic for a given overlay object, and for the EMPTY overlay it
 * is byte-identical to the src/scout_prior.js this repository ships.
 */
function renderFile(prior) {
  const json = JSON.stringify(prior, null, 2);
  const indented = json.split('\n').map(function (line, i) {
    return i === 0 ? line : '  ' + line;
  }).join('\n');
  return FILE_HEADER + '\n' +
    '(function () {\n' +
    '  \'use strict\';\n' +
    '  window.ST_SCOUT = ' + indented + ';\n' +
    '})();\n';
}

/* ----------------------------------------------------------------------------------- CLI */

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
  const outPath = path.resolve(ROOT, typeof args.out === 'string' ? args.out : DEFAULTS.out);
  const opts = {
    minShare: num(args['min-share'], DEFAULTS.minShare),
    side: typeof args.side === 'string' ? args.side : 'both',
    source: typeof args.input === 'string' ? args.input : (typeof args.url === 'string' ? args.url : null),
    date: typeof args.date === 'string' ? args.date : new Date().toISOString()
  };
  const load = typeof args.input === 'string'
    ? Promise.resolve(JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args.input), 'utf8')))
    : (typeof args.url === 'string'
      ? download(args.url)
      : Promise.reject(new Error('pass --input <replays.json> or --url <https url>')));

  return load.then(function (corpus) {
    const prior = buildPrior(corpus, opts);
    const speciesIds = Object.keys(prior.species);
    const text = renderFile(prior);
    fs.writeFileSync(outPath, text);
    console.log('scout: mined ' + prior.replays + ' replays, ' + speciesIds.length + ' species');
    console.log('scout: shares below ' + prior.minShare + '% dropped, side=' + opts.side);
    console.log('wrote ' + path.relative(ROOT, outPath) + ' (' + text.length + ' bytes' +
      (prior.source ? ', source ' + prior.source : '') + ')');
    if (!speciesIds.length) {
      console.log('note: nothing was revealed, so the overlay is empty — the pruner will leave every curated weight untouched');
    }
    return prior;
  }).catch(function (err) {
    console.error('scout FAILED: ' + ((err && err.message) || err));
    console.error('nothing was written to ' + path.relative(ROOT, outPath));
    process.exitCode = 1;
    return null;
  });
}

if (require.main === module) main();

module.exports = {
  toID: toID,
  splitIdent: splitIdent,
  speciesOf: speciesOf,
  linesOf: linesOf,
  replaysOf: replaysOf,
  observationsOf: observationsOf,
  shares: shares,
  buildPrior: buildPrior,
  renderFile: renderFile,
  parseArgs: parseArgs,
  main: main
};
