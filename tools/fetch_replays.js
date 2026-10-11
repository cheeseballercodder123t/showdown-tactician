/* Showdown Tactician — tools/fetch_replays.js
 * The NETWORK half of the empirical-weight pipeline. tools/extract_training_data.js is
 * deliberately offline ("never talks to the network", see its header); this tool is the other
 * side of that boundary, and all it does is turn a ladder search into the corpus JSON the
 * extractor eats:
 *
 *   node tools/fetch_replays.js --format gen9nationaldex --limit 200 --min-rating 1300 \
 *        --out replays.json
 *   # the highest-rated battles the ladder has ever recorded, and only those that clicked
 *   # Trick Room. --pool has to exceed --limit: the walk collects CANDIDATES up to --pool, and a
 *   # rare move needs far more candidates than the corpus it fills.
 *   # --min-rating/--max-rating pick the band; --max-rating alone is a band with only a ceiling.
 *   node tools/fetch_replays.js --sort rating --min-rating 1700 --require-move trickroom \
 *        --pool 5100 --limit 300 --pages 100 --harvest --harvest-players 120 \
 *        --out replays-tr.json
 *   # the other half of a balanced corpus: the same window, minus every battle that clicked it
 *   node tools/fetch_replays.js --sort rating --min-rating 1700 --exclude-move trickroom \
 *        --pool 900 --limit 300 --out replays-plain.json
 *   # the extractor eats one file, so the halves meet here (de-duplicated, best-rated first)
 *   node tools/fetch_replays.js --input replays-tr.json,replays-plain.json --min-rating 1700 \
 *        --sort rating --out replays.json
 *   node tools/extract_training_data.js --input replays.json --out training_data.json
 *   node tools/fit_weights.js --input training_data.json --lambda 0.5 --max-iter 200
 *
 * OUTPUT  { "format", "source", "minRating", "sort", "requireMove", "count", "ratingMean",
 *            "ratingLowest", "ratingHighest", "replays": [ { "id", "rating",
 *            "players": [p1, p2], "winner": "p1"|"p2", "log": "<protocol>" } ],
 *            "skipped": {...}, "attempted": n }
 *   No timestamp is written on purpose — `tests/weights_check.js` pins the key set — so the same
 *   search download produces a byte-identical file: a corpus can be diffed and the fit it
 *   produces is reproducible. `--input a.json,b.json` (a merge) writes the same two extra keys:
 *   `attempted` is 0 there because no request is made, and `skipped.filtered` counts what the
 *   merge dropped (duplicate ids, unlabelled rows, rows under the floor). `attempted` otherwise
 *   counts every request the run made, including the harvest's discovery pass.
 *
 * WHICH BATTLES YOU GET
 *   `--sort rating` is a SERVER-SIDE query, not a local re-sort: the endpoint returns the
 *   highest-rated battles it holds for the format, 51 per page, and that window ends at page 100
 *   (5,001 candidates spanning ~1778-1992 for gen9nationaldex when this was measured). The
 *   default newest-first window is a different and much weaker sample — the first corpus was
 *   built from it, which is why it sat at 1300. The endpoint cannot search by move, so a
 *   `--require-move` corpus costs one download per candidate examined (5,001 of them for the
 *   Trick Room half), and `--harvest` then spends the follow-up budget on the players whose own
 *   logs show them using the move.
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
    maxRating: 0,       // optional ceiling, so a diversity band (say 1600-1749) can be drawn from
                        // the newest window, which is the only one that reaches below the
                        // rating-sorted window's floor. 0 = no ceiling.
    pages: 4,           // the search endpoint pages at ~51 hits; walk this many looking for candidates
    pool: 0,            // how many candidates the search walk may collect (0 = --limit). A rare
                        // --require-move needs a much bigger pool than the corpus it fills, so
                        // the walk must not stop the moment it has --limit candidates.
    requireMove: null,  // keep only replays whose log actually contains this move (e.g. trickroom)
    excludeMove: null,  // drop replays whose log uses this move — the "everything but X" half
    sort: 'newest',     // 'rating' asks the ENDPOINT to sort by rating and walks each page
                        // best-first, which reaches the highest-rated battles ever recorded
                        // rather than only the recent window; the local order follows it
    maxDownloads: 0,    // stop after this many replay requests (0 = as many as --limit needs)
    harvest: false,     // follow the players who used --require-move into their own games
    harvestPlayers: 60, // how many of those players to ask the endpoint for
    harvestPages: 3,    // pages of a player's recent games to read (~51 per page)
    harvestSeed: 0,     // window candidates downloaded to find those players (0 = all of them)
    searchConcurrency: 4,
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
    else if (a === '--max-rating') out.maxRating = Number(argv[++i]);
    else if (a === '--pages') out.pages = Number(argv[++i]);
    else if (a === '--pool') out.pool = Number(argv[++i]);
    else if (a === '--sort') out.sort = String(argv[++i]);
    else if (a === '--require-move') out.requireMove = String(argv[++i]);
    else if (a === '--exclude-move') out.excludeMove = String(argv[++i]);
    else if (a === '--max-downloads') out.maxDownloads = Number(argv[++i]);
    else if (a === '--harvest') out.harvest = true;
    else if (a === '--harvest-players') out.harvestPlayers = Number(argv[++i]);
    else if (a === '--harvest-pages') out.harvestPages = Number(argv[++i]);
    else if (a === '--harvest-seed') out.harvestSeed = Number(argv[++i]);
    else if (a === '--search-concurrency') out.searchConcurrency = Number(argv[++i]);
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

/**
 * hasMoveInLog(replay, moveId) -> whether the log really shows that move being used.
 * The move id is compared against the id of every move name the protocol prints — `|move|`,
 * `|-singlemove|`, and the `move: <Name>` payloads that `|-activate|` / `|-fieldstart|` /
 * `|-fieldend|` carry — so a Trick Room that only ever appears as a field effect (because the
 * `|move|` line was cut from the log) is still found. A log that never mentions it returns
 * false, which is the point: this is the filter that keeps a corpus on-topic.
 */
function hasMoveInLog(replay, moveId) {
  // Normalised through `namesIdOf`, so a caller may pass the move NAME ("Trick Room") as well as
  // its id: a bare `toLowerCase()` would compare "trick room" against "trickroom" and match
  // nothing, which reads as "the log never used it" and quietly keeps zero replays.
  const wanted = namesIdOf(moveId);
  if (!wanted) return true;
  const lines = linesOf(replay && replay.log);
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split('|');
    if (parts.length < 4) continue;
    const kind = parts[1];
    if (kind === 'move' || kind === '-singlemove') {
      if (namesIdOf(parts[3]) === wanted) return true;
      continue;
    }
    if (kind === '-activate' || kind === '-fieldstart' || kind === '-fieldend' || kind === '-immune') {
      for (let p = 2; p < parts.length; p++) {
        const payload = parts[p];
        if (payload.indexOf('move:') !== 0) continue;
        if (namesIdOf(payload.slice(5)) === wanted) return true;
      }
    }
  }
  return false;
}

/**
 * seatsOf(replay) -> { p1: '<name>', p2: '<name>' }
 * The log's own `|player|p1|<name>` table: the only place that says which side id a player held.
 */
function seatsOf(replay) {
  const lines = linesOf(replay && replay.log);
  const seats = {};
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split('|');
    if (parts[1] === 'player' && parts[2] && parts[3]) seats[parts[2]] = String(parts[3]).trim();
  }
  return seats;
}

/**
 * sidesUsingMove(replay, moveId) -> ['p1'], ['p2'], ['p1', 'p2'] or []
 * `hasMoveInLog` answers yes or no; this answers WHO, which is what makes a targeted harvest
 * possible: the player to follow is the one on the side that clicked the move, not the opponent
 * who merely lost to it. A move that only surfaces as a field effect has no side, so it is not
 * attributed to anybody.
 */
function sidesUsingMove(replay, moveId) {
  const wanted = namesIdOf(moveId);
  const sides = [];
  if (!wanted) return sides;
  const lines = linesOf(replay && replay.log);
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split('|');
    if (parts.length < 4) continue;
    if (parts[1] !== 'move' && parts[1] !== '-singlemove') continue;
    if (namesIdOf(parts[3]) !== wanted) continue;
    const who = String(parts[2] || '');
    let side = null;
    if (who.indexOf('p1') === 0) side = 'p1';
    else if (who.indexOf('p2') === 0) side = 'p2';
    if (side && sides.indexOf(side) < 0) sides.push(side);
  }
  return sides;
}

/**
 * playersUsingMove(replays, moveId) -> the unique player names on the sides that used the move.
 * Case-folded for de-duplication, keeping the first spelling seen, so a player is asked for once.
 */
function playersUsingMove(replays, moveId) {
  const list = Array.isArray(replays) ? replays : [];
  const names = [];
  const seen = Object.create(null);
  for (let i = 0; i < list.length; i++) {
    const seats = seatsOf(list[i]);
    const sides = sidesUsingMove(list[i], moveId);
    for (let s = 0; s < sides.length; s++) {
      const name = seats[sides[s]];
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      names.push(name);
    }
  }
  return names;
}

/**
 * keepByMoves(requireMove, excludeMove) -> a `download()` predicate, or null when neither is set.
 * The trickroom corpus is built in two halves — battles that clicked the move, and battles that
 * did not — so "keep this move" and "keep anything but this move" have to be the same kind of
 * test, applied to the same logs. Both halves therefore go through here.
 */
function keepByMoves(requireMove, excludeMove) {
  const wanted = namesIdOf(requireMove);
  const banned = namesIdOf(excludeMove);
  if (!wanted && !banned) return null;
  return function (entry) {
    if (wanted && !hasMoveInLog(entry, wanted)) return false;
    if (banned && hasMoveInLog(entry, banned)) return false;
    return true;
  };
}

/** The id of a protocol move name ("Trick Room" -> "trickroom"), without pulling in U. */
function namesIdOf(name) {
  return String(name === undefined || name === null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Keep only the search hits inside the rating band, in the order the search returned them.
 * The ceiling is optional (0/absent = none) and exists so a corpus can hold a deliberate RANGE of
 * the ladder rather than only its top: measured on the shipped corpus, a lower-rated minority
 * improves even elite prediction, so the band has to be selectable.
 */
function filterByRating(hits, minRating, maxRating) {
  const list = Array.isArray(hits) ? hits : [];
  const floor = typeof minRating === 'number' && isFinite(minRating) ? minRating : 0;
  const ceiling = typeof maxRating === 'number' && isFinite(maxRating) && maxRating > 0 ? maxRating : Infinity;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const hit = list[i];
    if (!hit || !hit.id) continue;
    const rating = typeof hit.rating === 'number' ? hit.rating : 0;
    if (rating < floor || rating > ceiling) continue;
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

/**
 * download(hits, options) -> { replays, skipped, attempted }
 * Bounded requests in flight, and it stops as soon as it has `options.limit` KEPT replays or has
 * attempted `options.maxDownloads`, so a filter (a move, a rating) makes the run do the work it
 * needs and no more: with `--require-move trickroom` at 15% of battles, a 500-replay corpus means
 * ~3,300 downloads, and the tool should not keep going once it has them.
 * `options.keep(entry)` decides what counts (default: everything labelled).
 */
function download(hits, options) {
  const opts = options || {};
  const list = Array.isArray(hits) ? hits : [];
  const concurrency = Math.max(1, Math.min(16, opts.concurrency || 6));
  const limit = opts.limit > 0 ? opts.limit : Infinity;
  const maxDownloads = opts.maxDownloads > 0 ? opts.maxDownloads : Infinity;
  const keep = typeof opts.keep === 'function' ? opts.keep : function () { return true; };
  // `preloaded` is a { id: corpus entry } map of replays this run has ALREADY downloaded (the
  // harvest's discovery pass reads every candidate's log to find the players). Re-using them keeps
  // a second pass from re-fetching the same battles, and they are not counted as attempts because
  // no request is made for them.
  const preloaded = opts.preloaded || null;
  const replays = [];
  const skipped = { noWinner: 0, httpError: 0, filtered: 0, preloaded: 0 };
  let cursor = 0;
  let attempted = 0;

  function done() { return replays.length >= limit || attempted >= maxDownloads; }

  function worker() {
    if (cursor >= list.length || done()) return Promise.resolve();
    const hit = list[cursor++];
    const cached = preloaded && preloaded[hit.id];
    if (cached) {
      skipped.preloaded++;
      if (keep(cached)) replays.push(cached);
      else skipped.filtered++;
      return worker();
    }
    attempted++;
    const url = REPLAY_URL + hit.id + '.json';
    return httpJson(url).then(function (payload) {
      const entry = corpusOf(hit.id, hit.rating, payload);
      if (!entry) skipped.noWinner++;
      else if (!keep(entry)) skipped.filtered++;
      else replays.push(entry);
      return worker();
    }).catch(function () {
      skipped.httpError++;
      return worker();
    });
  }

  const lanes = [];
  for (let i = 0; i < concurrency; i++) lanes.push(worker());
  return Promise.all(lanes).then(function () {
    // The candidate order is the corpus order: a re-download must not reshuffle the rows.
    const order = {};
    for (let i = 0; i < list.length; i++) order[list[i].id] = i;
    replays.sort(function (a, b) { return (order[a.id] || 0) - (order[b.id] || 0); });
    return { replays: replays, skipped: skipped, attempted: attempted };
  });
}

/**
 * orderOf(hits, sort) -> the hits in the order the download should spend them.
 * `rating` puts the best ladder games first, breaking ties by the search's own order (so the
 * result is still deterministic); `newest` keeps the search order, which is what the endpoint
 * returns and therefore what a plain re-download reproduces.
 */
function orderOf(hits, sort) {
  const list = Array.isArray(hits) ? hits.slice() : [];
  if (sort !== 'rating') return list;
  const index = {};
  for (let i = 0; i < list.length; i++) index[list[i].id] = i;
  list.sort(function (a, b) {
    const ra = typeof a.rating === 'number' ? a.rating : 0;
    const rb = typeof b.rating === 'number' ? b.rating : 0;
    if (ra !== rb) return rb - ra;
    return (index[a.id] || 0) - (index[b.id] || 0);
  });
  return list;
}

function main(argv) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node tools/fetch_replays.js [--format gen9nationaldex] [--limit 200] ' +
      '[--min-rating 1300] [--max-rating 0] [--pages 4] [--pool 0] [--quiet] ' +
      '[--sort newest|rating] ' +
      '[--require-move trickroom] ' +
      '[--exclude-move trickroom] ' +
      '[--max-downloads 0] [--out replays.json] [--concurrency 6] ' +
      '[--harvest] [--harvest-players 60] [--harvest-pages 3] [--harvest-seed 0] ' +
      '[--search-concurrency 4] [--index search.json] [--input corpus.json]');
    return 0;
  }

  const log = function (msg) { if (!opts.quiet) console.log(msg); };
  const offline = {};
  if (opts.harvest && !namesIdOf(opts.requireMove)) {
    return Promise.reject(new Error('--harvest needs --require-move: the players to follow are the ones the logs show using that move'));
  }
  // --input takes one corpus path, or several comma-separated ones: a balanced corpus is built in
  // halves (the battles that used a move, the battles that did not) and the extractor eats one file.
  const inputPaths = opts.input
    ? String(opts.input).split(',').map(function (p) { return p.trim(); }).filter(Boolean)
    : null;
  const start = inputPaths
    ? Promise.resolve(inputPaths.map(function (p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }))
    : (opts.index
      ? Promise.resolve(JSON.parse(fs.readFileSync(opts.index, 'utf8')))
      : search(opts));

  return start.then(function (result) {
    // --input: existing corpora are re-normalised (winners re-derived from their own logs, ratings
    // re-filtered) and written back, which is how a hand-collected corpus gets a consistent shape
    // — and how the two halves of a balanced corpus become one file.
    if (inputPaths) {
      const rows = inputPaths.reduce(function (n, payload) {
        return n + (((payload && payload.replays) || []).length);
      }, 0);
      const kept = mergeCorpora(result, opts);
      const payload = corpusPayload(opts, kept);
      // The same two keys as the network path, so a merged corpus has one shape: no request was
      // made here, and `filtered` is everything the merge dropped (duplicate ids, unlabelled rows
      // and rows below the floor).
      payload.skipped = { noWinner: 0, httpError: 0, filtered: Math.max(0, rows - kept.length), preloaded: 0 };
      payload.attempted = 0;
      fs.writeFileSync(opts.out, JSON.stringify(payload, null, 2) + '\n');
      log('wrote ' + opts.out + ': ' + kept.length + ' replays from ' + inputPaths.length +
        ' corpora (' + inputPaths.join(', ') + '), best-rated first' +
        (rows > kept.length ? ', ' + (rows - kept.length) + ' dropped (duplicate id or unlabelled)' : ''));
      return 0;
    }

    const windowHits = orderOf(filterByRating(result, opts.minRating, opts.maxRating), opts.sort);
    if (!windowHits.length) {
      throw new Error('no replays at rating >= ' + opts.minRating + ' for format ' + opts.format +
        ' (a search that returns [] usually means the format id is not the ladder one: try ' +
        '"gen9nationaldex", not "gen9nationaldexou")');
    }
    const wanted = namesIdOf(opts.requireMove);
    const banned = namesIdOf(opts.excludeMove);
    const keep = keepByMoves(opts.requireMove, opts.excludeMove);
    log('search: ' + windowHits.length + ' candidates at rating ' + opts.minRating +
      (opts.maxRating > 0 ? '-' + opts.maxRating : '+') + ' for ' + opts.format + ' (' + opts.sort +
      ' order' + (wanted ? ', requiring ' + wanted : '') + (banned ? ', excluding ' + banned : '') + ')');
    // Harvesting reorders the pool by rating on purpose: the point of following players is to
    // spend the download budget on their strongest battles, not their newest.
    const gather = opts.harvest
      ? harvestAround(windowHits, opts, wanted, log)
      : Promise.resolve({ hits: windowHits, players: 0, seeds: windowHits.length, seedAttempts: 0, preloaded: null });
    return gather.then(function (gathered) {
      return download(gathered.hits, {
        concurrency: opts.concurrency,
        limit: opts.limit,
        maxDownloads: opts.maxDownloads,
        preloaded: gathered.preloaded,
        keep: keep
      }).then(function (fetched) {
        const payload = corpusPayload(opts, fetched.replays);
        payload.skipped = fetched.skipped;
        // every request the run made, the harvest's discovery pass included: the file should record
        // the work, not just the last pass of it
        payload.attempted = fetched.attempted + (gathered.seedAttempts || 0);
        fs.writeFileSync(opts.out, JSON.stringify(payload, null, 2) + '\n');
        log('wrote ' + opts.out + ': ' + fetched.replays.length + ' replays from ' +
          fetched.attempted + ' downloads' +
          (fetched.skipped.filtered ? ', ' + fetched.skipped.filtered + ' filtered out' : '') +
          (fetched.skipped.noWinner ? ', ' + fetched.skipped.noWinner + ' skipped (no |win| in the log)' : '') +
          (fetched.skipped.httpError ? ', ' + fetched.skipped.httpError + ' skipped (HTTP error)' : '') +
          (fetched.skipped.preloaded ? ', ' + fetched.skipped.preloaded + ' re-used from the harvest pass' : ''));
        if (fetched.replays.length < opts.limit) {
          log('note: asked for ' + opts.limit + ' and the pool ran out at ' + fetched.replays.length +
            ' — raise --pages, lower --min-rating, raise --max-downloads, or drop --require-move');
        }
        return 0;
      });
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
    sort: opts.sort || 'newest',
    requireMove: namesIdOf(opts.requireMove) || null,
    count: replays.length,
    ratingMean: n ? Math.round(ratings / n) : null,
    ratingLowest: n ? lowest : null,
    ratingHighest: n ? highest : null,
    replays: replays
  };
}

/**
 * mergeCorpora(payloads, opts) -> the rows of several corpora as one list, best-rated first.
 * A corpus is built in halves (the battles that used a move, the battles that did not) and the
 * extractor eats one file, so the halves meet here: rows are re-labelled through `corpusOf` (the
 * winner comes from each log, never from the other file), de-duplicated by id — a battle can be
 * in both halves only if the halves disagree, and the first row wins — and returned ordered by
 * rating, so the merged corpus is the same kind of object the fetcher writes itself.
 */
function mergeCorpora(payloads, opts) {
  const options = opts || {};
  const list = Array.isArray(payloads) ? payloads : [payloads];
  const floor = typeof options.minRating === 'number' && isFinite(options.minRating) ? options.minRating : 0;
  const seen = Object.create(null);
  const merged = [];
  for (let i = 0; i < list.length; i++) {
    const rows = (list[i] && list[i].replays) || [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !row.id || seen[row.id]) continue;
      const rowRating = typeof row.rating === 'number' && isFinite(row.rating) ? row.rating : 0;
      if (rowRating < floor) continue;
      const entry = corpusOf(row.id, row.rating, row);
      if (!entry) continue;
      seen[row.id] = true;
      merged.push(entry);
    }
  }
  return orderOf(merged, 'rating');
}

/**
 * search(opts) -> the candidate hits, paged.
 * The endpoint returns a page of ~51 hits and a `page` parameter, so one request rarely fills a
 * corpus: this walks up to `opts.pages` pages, de-duplicating by id, and collects until the POOL is
 * full (`opts.pool`, falling back to `opts.limit`) or the endpoint runs out of hits. The walk ends
 * on an empty page — the search is a fixed-length window and paging past its end is not an error —
 * NOT on a page that happened to contribute no candidate, which is what a rating band or a move
 * filter routinely causes.
 */
function search(opts) {
  const pages = Math.max(1, Math.min(400, opts.pages || 4));
  const limit = Math.max(1, opts.pool > 0 ? opts.pool : (opts.limit || 200));
  const seen = Object.create(null);
  const collected = [];

  function step(page) {
    if (page > pages) return Promise.resolve(collected);
    const url = SEARCH_URL + '?format=' + encodeURIComponent(opts.format) +
      '&limit=250&page=' + page + (opts.sort === 'rating' ? '&sort=rating' : '');
    return httpJson(url).then(function (page_) {
      if (!Array.isArray(page_)) {
        throw new Error('search: the endpoint returned a non-array body for ' + opts.format +
          ' (an error page, not an empty window — refusing to report it as the end of the data)');
      }
      const hits = page_;
      // The walk ends when the ENDPOINT has no more hits, not when a page adds no candidate:
      // with a rating band (or a move filter applied later) a page can legitimately contribute
      // nothing while the window still has thousands of battles behind it — stopping there is how
      // a narrow band reports a handful of replays that were never its ceiling.
      if (!hits.length) return collected;
      const candidates = filterByRating(hits, opts.minRating, opts.maxRating);
      for (let i = 0; i < candidates.length; i++) {
        const hit = candidates[i];
        if (seen[hit.id]) continue;
        seen[hit.id] = true;
        collected.push(hit);
      }
      if (collected.length >= limit) return collected.slice(0, limit);
      return step(page + 1);
    });
  }

  return step(1);
}

/**
 * formatIdOf(hits) -> the format id the hits belong to, read off the replay ids themselves
 * ("gen9nationaldex-2612345678" -> "gen9nationaldex"), or '' when no id parses.
 * This is the ONLY reliable format test: the human label is a display string, so a substring test
 * on it also accepts "[Gen 9] National Dex UU", "... AG", "... Doubles" and "... Monotype".
 */
function formatIdOf(hits) {
  const list = Array.isArray(hits) ? hits : [];
  for (let i = 0; i < list.length; i++) {
    const match = list[i] && String(list[i].id || '').match(/^(.*)-\d+$/);
    if (match && match[1]) return match[1];
  }
  return '';
}

/**
 * searchUser(name, opts) -> one player's recent hits, paged.
 * `?user=` returns every format that player has played, so hits are filtered to the same FORMAT as
 * the window (`opts.formatId`, matched against the replay id's own prefix; `opts.label` is only a
 * fallback and is compared for equality, never as a substring) and to the rating band. A player
 * with nothing recent ends the walk early. A page that comes back as a non-array — an error page,
 * not an empty history — THROWS rather than reading as "no more battles", so a call site that wants
 * to tolerate it can count it (`harvestAround` does, as `failed`), and one that does not gets a
 * loud failure instead of a silently short corpus.
 */
function searchUser(name, opts) {
  const options = opts || {};
  const pages = Math.max(1, Math.min(50, options.userPages || 1));
  const formatId = options.formatId ? String(options.formatId) : '';
  const label = options.label ? String(options.label) : '';
  const floor = typeof options.minRating === 'number' && isFinite(options.minRating) ? options.minRating : 0;
  const ceiling = typeof options.maxRating === 'number' && isFinite(options.maxRating) && options.maxRating > 0 ? options.maxRating : Infinity;
  const seen = Object.create(null);
  const collected = [];

  function step(page) {
    if (page > pages) return Promise.resolve(collected);
    // No `sort=rating` here on purpose: the endpoint honours it for a format query and ignores it
    // for a user query (measured — a player's page comes back in replay order), so a player's
    // games are their RECENT ones at their own rating, and the floor plus the final rating sort
    // are what make the corpus best-first.
    const url = SEARCH_URL + '?user=' + encodeURIComponent(name) + '&limit=250&page=' + page;
    return httpJson(url).then(function (page_) {
      if (!Array.isArray(page_)) {
        throw new Error('search user ' + name + ': the endpoint returned a non-array body (an error page rather than a history)');
      }
      if (!page_.length) return collected;
      for (let i = 0; i < page_.length; i++) {
        const hit = page_[i];
        if (!hit || !hit.id || seen[hit.id]) continue;
        if (formatId) { if (String(hit.id).indexOf(formatId + '-') !== 0) continue; }
        else if (label && String(hit.format || '') !== label) continue;
        // A hit with no rating is treated as 0, exactly as `filterByRating` treats it, so a
        // rating-less row can never enter a rated corpus.
        const rating = typeof hit.rating === 'number' && isFinite(hit.rating) ? hit.rating : 0;
        if (rating < floor || rating > ceiling) continue;
        seen[hit.id] = true;
        collected.push(hit);
      }
      return step(page + 1);
    });
  }

  return step(1);
}

/** The format label the search itself returned ("[Gen 9] National Dex"), '' when absent. */
function labelOf(hits) {
  const list = Array.isArray(hits) ? hits : [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].format) return String(list[i].format);
  }
  return '';
}

/**
 * harvestAround(windowHits, opts, wanted, log) -> { hits, players, seeds }
 * The search endpoint only exposes a short recent window (a few thousand battles), and a rare move
 * is rare inside it — Trick Room is roughly 5% of the top of the ladder — so the window alone
 * cannot fill a large corpus at a high rating floor. The players who DO win with the move are the
 * lead: this downloads the window's own candidates (or the best `--harvest-seed` of them), reads
 * out the sides that actually clicked it, and asks the endpoint for those players' recent games
 * (`?user=`, the same format label, the same floor). Window hits and harvested hits are merged,
 * de-duplicated by id and returned best-rated first, so what follows is the strongest available
 * set of battles rather than simply the most recent ones.
 */
function harvestAround(windowHits, opts, wanted, log) {
  const seedCount = opts.harvestSeed > 0 ? Math.min(opts.harvestSeed, windowHits.length) : windowHits.length;
  const seed = windowHits.slice(0, seedCount);
  return download(seed, {
    concurrency: opts.concurrency,
    limit: seed.length,
    // the discovery pass is still network work, so it obeys the same request budget
    maxDownloads: opts.maxDownloads,
    keep: keepByMoves(wanted, null)
  }).then(function (found) {
    const all = playersUsingMove(found.replays, wanted);
    const players = all.slice(0, Math.max(0, opts.harvestPlayers || 0));
    log('harvest: ' + found.replays.length + ' matched replays from ' + found.attempted +
      ' downloads named ' + all.length + ' players' +
      (players.length < all.length ? ' (following ' + players.length + ')' : ''));
    const preloaded = Object.create(null);
    for (let i = 0; i < found.replays.length; i++) preloaded[found.replays[i].id] = found.replays[i];
    const base = { players: 0, seeds: found.replays.length, seedAttempts: found.attempted, preloaded: preloaded };
    if (!players.length) return Object.assign({ hits: windowHits }, base);

    const label = labelOf(windowHits);
    const formatId = formatIdOf(windowHits);
    const seen = Object.create(null);
    const merged = [];
    for (let i = 0; i < windowHits.length; i++) {
      const hit = windowHits[i];
      if (!hit || !hit.id || seen[hit.id]) continue;
      seen[hit.id] = true;
      merged.push(hit);
    }
    const windowCount = merged.length;
    let cursor = 0;
    let searched = 0;
    let failed = 0;

    function lane() {
      if (cursor >= players.length) return Promise.resolve();
      const name = players[cursor++];
      return searchUser(name, {
        userPages: opts.harvestPages,
        formatId: formatId,
        label: label,
        minRating: opts.minRating,
        maxRating: opts.maxRating
      }).then(function (hits) {
        searched++;
        for (let i = 0; i < hits.length; i++) {
          const hit = hits[i];
          if (seen[hit.id]) continue;
          seen[hit.id] = true;
          merged.push(hit);
        }
        return lane();
      }).catch(function () { failed++; return lane(); });
    }

    const lanes = [];
    const width = Math.max(1, Math.min(8, opts.searchConcurrency || 4));
    for (let i = 0; i < width; i++) lanes.push(lane());
    return Promise.all(lanes).then(function () {
      const sorted = orderOf(merged, 'rating');
      log('harvest: ' + searched + ' player searches added ' + (merged.length - windowCount) +
        ' new candidates in the ' + opts.minRating + (opts.maxRating > 0 ? '-' + opts.maxRating : '+') +
        ' band' + (formatId ? ' of ' + formatId : '') + ' (' + sorted.length +
        ' total, best first' + (failed ? ', ' + failed + ' searches errored' : '') + ')');
      return Object.assign({ hits: sorted, players: players.length }, base, { players: players.length });
    });
  });
}

module.exports = {
  parseArgs: parseArgs,
  search: search,
  searchUser: searchUser,
  harvestAround: harvestAround,
  formatIdOf: formatIdOf,
  keepByMoves: keepByMoves,
  mergeCorpora: mergeCorpora,
  seatsOf: seatsOf,
  sidesUsingMove: sidesUsingMove,
  playersUsingMove: playersUsingMove,
  labelOf: labelOf,
  hasMoveInLog: hasMoveInLog,
  namesIdOf: namesIdOf,
  orderOf: orderOf,
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
