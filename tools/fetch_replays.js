/* Showdown Tactician — tools/fetch_replays.js
 * The NETWORK half of the empirical-weight pipeline. tools/extract_training_data.js is
 * deliberately offline ("never talks to the network", see its header); this tool is the other
 * side of that boundary, and all it does is turn a ladder search into the corpus JSON the
 * extractor eats:
 *
 *   node tools/fetch_replays.js --format gen9nationaldex --limit 200 --min-rating 1300 \
 *        --out replays.json
 *   node tools/extract_training_data.js --input replays.json --out training_data.json
 *   node tools/fit_weights.js --input training_data.json
 *
 * OUTPUT  { "format", "source", "minRating", "count", "ratingMean", "ratingLowest",
 *            "ratingHighest", "replays": [ { "id", "rating", "players": [p1, p2],
 *            "winner": "p1"|"p2", "log": "<protocol>" } ], "skipped": {...} }
 *   No timestamp is written on purpose — that is the whole key set, `tests/weights_check.js` pins
 *   it — so the same search download produces a byte-identical file: a corpus can be diffed and
 *   the fit it produces is reproducible.
 *
 * THE WINNER IS READ FROM THE LOG, NOT GUESSED
 *   A replay payload carries the outcome only as a `|win|<player>` line, and `p1`/`p2` are the
 *   SIDE ids the log itself declares in its `|player|` lines. Mapping one to the other by array
 *   order would silently mislabel every replay whose players swapped seats, and a mislabelled
 *   corpus is invisible downstream (it just fits worse), so `winnerOf` resolves the winner
 *   through the log's own player table and REFUSES a replay it cannot resolve rather than
 *   labelling it. Skipped replays are counted and reported, never quietly dropped.
 *
 * A replay with no `|win|` line is a forfeit/tie or a fresh upload: skipped (`skipped.noWinner`
 * in the report), because a row with no label would have to be invented.
 */
'use strict';

const fs = require('fs');

const SEARCH_URL = 'https://replay.pokemonshowdown.com/search.json';
const REPLAY_URL = 'https://replay.pokemonshowdown.com/';

function parseArgs(argv) {
  const out = {
    format: 'gen9nationaldex',
    limit: 200,
    minRating: 1300,
    pages: 4,           // the search endpoint pages at ~51 hits; walk this many looking for candidates
    out: 'replays.json',
    concurrency: 6,
    index: null,        // a search.json already on disk: no search request, still no replays
    input: null,        // a corpus already on disk: re-derive winners/normalise, no network at all
    quiet: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') out.format = argv[++i];
    else    if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--min-rating') out.minRating = Number(argv[++i]);
    else if (a === '--pages') out.pages = Number(argv[++i]);
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--index') out.index = argv[++i];
    else if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

function linesOf(log) {
  if (Array.isArray(log)) return log.map(function (l) { return String(l).replace(/\r$/, ''); });
  return String(log === undefined || log === null ? '' : log).split('\n').map(function (l) {
    return l.replace(/\r$/, '');
  });
}

/**
 * winnerOf(replay) -> 'p1' | 'p2' | null
 * The log's `|player|p1|<name>` lines are the side table and `|win|<name>` names the winner by
 * the same name, so the comparison is made on the log's own vocabulary (trimmed, case-folded).
 * A name that matches neither seat returns null: the caller skips the replay.
 */
function winnerOf(replay) {
  const lines = linesOf(replay && replay.log);
  const seats = {};
  let wonBy = null;
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split('|');
    if (parts[1] === 'player' && parts[2] && parts[3]) seats[parts[2]] = String(parts[3]).trim();
    else if (parts[1] === 'win' && parts[2]) wonBy = String(parts[2]).trim();
  }
  if (!wonBy) return null;
  const target = wonBy.toLowerCase();
  const sides = ['p1', 'p2'];
  for (let i = 0; i < sides.length; i++) {
    const name = seats[sides[i]];
    if (name && name.toLowerCase() === target) return sides[i];
  }
  // A log whose player table is missing or uses a different id: only a single unambiguous seat
  // can be resolved, so anything else is left unlabelled.
  return null;
}

/** Keep only the search hits at or above the rating floor, in the order the search returned them. */
function filterByRating(hits, minRating) {
  const list = Array.isArray(hits) ? hits : [];
  const floor = typeof minRating === 'number' && isFinite(minRating) ? minRating : 0;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const hit = list[i];
    if (!hit || !hit.id) continue;
    const rating = typeof hit.rating === 'number' ? hit.rating : 0;
    if (rating < floor) continue;
    out.push(hit);
  }
  return out;
}

/** The corpus entry for one downloaded replay, or null when the log cannot label itself. */
function corpusOf(id, rating, payload) {
  const replay = payload || {};
  const winner = winnerOf(replay);
  if (!winner) return null;
  return {
    id: id || replay.id || '',
    rating: typeof rating === 'number' ? rating : (typeof replay.rating === 'number' ? replay.rating : 0),
    players: Array.isArray(replay.players) ? replay.players.slice(0, 2) : [],
    winner: winner,
    log: linesOf(replay.log).join('\n')
  };
}

function httpJson(url) {
  if (typeof fetch !== 'function') {
    return Promise.reject(new Error('this Node has no fetch; download a search.json and pass --index, or a corpus with --input'));
  }
  return fetch(url).then(function (res) {
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?') + ' for ' + url);
    return res.json();
  });
}

/** Download `hits` with a bounded number of requests in flight; returns the corpus + skip counts. */
function download(hits, options) {
  const opts = options || {};
  const concurrency = Math.max(1, Math.min(16, opts.concurrency || 6));
  const replays = [];
  const skipped = { noWinner: 0, httpError: 0 };
  let cursor = 0;

  function worker() {
    if (cursor >= hits.length) return Promise.resolve();
    const hit = hits[cursor++];
    const url = REPLAY_URL + hit.id + '.json';
    return httpJson(url).then(function (payload) {
      const entry = corpusOf(hit.id, hit.rating, payload);
      if (entry) replays.push(entry); else skipped.noWinner++;
      return worker();
    }).catch(function () {
      skipped.httpError++;
      return worker();
    });
  }

  const lanes = [];
  for (let i = 0; i < concurrency; i++) lanes.push(worker());
  return Promise.all(lanes).then(function () {
    // The search order is the corpus order: a re-download must not reshuffle the rows.
    const order = {};
    for (let i = 0; i < hits.length; i++) order[hits[i].id] = i;
    replays.sort(function (a, b) { return (order[a.id] || 0) - (order[b.id] || 0); });
    return { replays: replays, skipped: skipped };
  });
}

function main(argv) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node tools/fetch_replays.js [--format gen9nationaldex] [--limit 200] ' +
      '[--min-rating 1300] [--pages 4] [--out replays.json] [--concurrency 6] ' +
      '[--index search.json] [--input corpus.json]');
    return 0;
  }

  const log = function (msg) { if (!opts.quiet) console.log(msg); };
  const offline = {};
  const start = opts.input
    ? Promise.resolve(JSON.parse(fs.readFileSync(opts.input, 'utf8')))
    : (opts.index
      ? Promise.resolve(JSON.parse(fs.readFileSync(opts.index, 'utf8')))
      : search(opts));

  return start.then(function (result) {
    // --input: an existing corpus is re-normalised (winners re-derived, ratings re-filtered) and
    // written back, which is how a hand-collected corpus gets a consistent shape.
    if (opts.input) {
      const corpus = (result && result.replays) || result || [];
      const kept = [];
      for (let i = 0; i < corpus.length; i++) {
        const entry = corpus[i];
        if (!entry || !entry.log) continue;
        if (typeof entry.rating === 'number' && entry.rating < opts.minRating) continue;
        const winner = winnerOf(entry);
        if (!winner) { offline.noWinner = (offline.noWinner || 0) + 1; continue; }
        kept.push(Object.assign(corpusOf(entry.id, entry.rating, entry), { winner: winner }));
      }
      const payload = corpusPayload(opts, kept);
      fs.writeFileSync(opts.out, JSON.stringify(payload, null, 2) + '\n');
      log('wrote ' + opts.out + ': ' + kept.length + ' replays' +
        (offline.noWinner ? ', skipped ' + offline.noWinner + ' unlabelled' : ''));
      return 0;
    }

    const hits = filterByRating(result, opts.minRating);
    if (!hits.length) {
      throw new Error('no replays at rating >= ' + opts.minRating + ' for format ' + opts.format +
        ' (a search that returns [] usually means the format id is not the ladder one: try ' +
        '"gen9nationaldex", not "gen9nationaldexou")');
    }
    log('search: ' + hits.length + ' replays at rating >= ' + opts.minRating + ' for ' + opts.format);
    return download(hits.slice(0, Math.max(0, opts.limit)), opts).then(function (fetched) {
      const payload = corpusPayload(opts, fetched.replays);
      payload.skipped = fetched.skipped;
      fs.writeFileSync(opts.out, JSON.stringify(payload, null, 2) + '\n');
      log('wrote ' + opts.out + ': ' + fetched.replays.length + ' labelled replays' +
        (fetched.skipped.noWinner ? ', ' + fetched.skipped.noWinner + ' skipped (no |win| in the log)' : '') +
        (fetched.skipped.httpError ? ', ' + fetched.skipped.httpError + ' skipped (HTTP error)' : ''));
      return 0;
    });
  });
}

function corpusPayload(opts, replays) {
  let ratings = 0, n = 0, lowest = Infinity, highest = -Infinity;
  for (let i = 0; i < replays.length; i++) {
    const r = replays[i].rating;
    if (typeof r !== 'number' || !r) continue;
    ratings += r; n++;
    if (r < lowest) lowest = r;
    if (r > highest) highest = r;
  }
  return {
    format: opts.format,
    source: REPLAY_URL,
    minRating: opts.minRating,
    count: replays.length,
    ratingMean: n ? Math.round(ratings / n) : null,
    ratingLowest: n ? lowest : null,
    ratingHighest: n ? highest : null,
    replays: replays
  };
}

/**
 * search(opts) -> the candidate hits, paged.
 * The endpoint returns a page of ~51 hits and a `page` parameter, so one request rarely fills a
 * corpus: this walks up to `opts.pages` pages, de-duplicating by id, and stops as soon as it has
 * `opts.limit` candidates at the rating floor. A page that comes back empty ends the walk — the
 * search is a fixed-length recent window, so paging past its end is not an error.
 */
function search(opts) {
  const pages = Math.max(1, Math.min(20, opts.pages || 4));
  const limit = Math.max(1, opts.limit || 200);
  const seen = Object.create(null);
  const collected = [];

  function step(page) {
    if (page > pages) return Promise.resolve(collected);
    const url = SEARCH_URL + '?format=' + encodeURIComponent(opts.format) +
      '&limit=250&page=' + page;
    return httpJson(url).then(function (page_) {
      const candidates = filterByRating(page_, opts.minRating);
      let added = 0;
      for (let i = 0; i < candidates.length; i++) {
        const hit = candidates[i];
        if (seen[hit.id]) continue;
        seen[hit.id] = true;
        collected.push(hit);
        added++;
      }
      if (!added) return collected;
      if (collected.length >= limit) return collected.slice(0, limit);
      return step(page + 1);
    });
  }

  return step(1);
}

module.exports = {
  parseArgs: parseArgs,
  search: search,
  winnerOf: winnerOf,
  filterByRating: filterByRating,
  corpusOf: corpusOf,
  corpusPayload: corpusPayload,
  download: download,
  linesOf: linesOf,
  main: main
};

/* `process.exitCode`, never `process.exit`: an explicit exit while the HTTP pool is tearing down
 * its sockets aborts the process on Windows (a libuv handle assertion) after the file was already
 * written, which reports a failure for work that succeeded. This is the same exit path
 * tools/scout_replays.js uses. */
if (require.main === module) {
  try {
    const rc = main();
    if (rc && typeof rc.then === 'function') {
      rc.then(function (code) { process.exitCode = code || 0; }, function (err) {
        console.error('fetch_replays: ' + ((err && err.message) || err));
        process.exitCode = 1;
      });
    } else {
      process.exitCode = rc || 0;
    }
  } catch (err) {
    console.error('fetch_replays: ' + ((err && err.message) || err));
    process.exitCode = 1;
  }
}
