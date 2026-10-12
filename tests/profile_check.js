/* Showdown Tactician — tests/profile_check.js
 *
 * WHY THIS EXISTS
 *   `src/opponent_profile.js` turns "the opponent keeps leaving when the matrix told them to stay"
 *   into ONE bounded number the solver can price with (`switchFactor`). That number is derived
 *   from a single estimator, and the estimator's whole job is to be honest about when it knows
 *   nothing: a null frequency, a percentage passed by mistake, an under-sampled window and a
 *   disabled profiler must ALL leave the solver exactly as they found it. A profiler that quietly
 *   skewed the matrix off one lucky switch would be worse than no profiler, because it would be
 *   unexplainable from the board.
 *
 *   What is pinned here: the config-shaped defaults, the two refusals (null and out-of-range), the
 *   switch/not-switch reading in both directions, the window (`maxHistory` forgives the past), the
 *   clamp, label/factor agreement, determinism, purity, `reset()` and the disabled path.
 *
 * Run me with:  node tests/profile_check.js
 */
'use strict';

const H = require('./harness.js');
// content.js auto-boots on the harness's stubbed hostname and starts a 2.5 s heartbeat, which
// would keep this process alive forever. Stub the timer exactly as run_invariants does.
const S = H.loadAll({
  setInterval: function () { return 0; },
  clearInterval: function () { }
});
const ST = S.ST;

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); return true; }
  failures.push(name + (detail === undefined ? '' : '  ->  ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  ->  ' + detail));
  return false;
}
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  return check(name, ok, ok ? undefined : 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

function cfgNum(path, fallback) {
  const v = ST.configGet(path, null);
  return (typeof v === 'number' && isFinite(v)) ? v : fallback;
}
function cfgFlag(path, fallback) {
  const v = ST.configGet(path, null);
  return typeof v === 'boolean' ? v : fallback;
}

/* --------------------------------------------------------------- fixtures */

function rec(kind, freq, turn) {
  return { kind: kind, predictedFreq: freq, turn: turn === undefined ? null : turn };
}
function rep(n, one) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ kind: one.kind, predictedFreq: one.predictedFreq, turn: one.turn });
  return out;
}
/** A record they played exactly as the matrix told them: no excess either way. */
const FAITHFUL = rec('attack', 1.0);
/** They pivoted on a line the matrix gave 10% -> the matrix held 90% on staying -> +0.9. */
const FLIGHTY = rec('switch', 0.1);
/** They stayed on a line the matrix gave 10% -> the matrix held 90% on the pivot -> -0.9. */
const STAYER = rec('attack', 0.1);

function feed(records, opts) {
  const p = new ST.OpponentProfiler(opts);
  for (let i = 0; i < records.length; i++) p.observe(records[i]);
  return p;
}
function out(records, opts, state) {
  return feed(records, opts).profile(state === undefined ? null : state);
}

/* ================================================================== 1. wired in */

section('the module is loaded and its defaults are config-shaped');

const registered = typeof ST.OpponentProfiler === 'function';
check('ST.OpponentProfiler is registered (if this fails, add src/opponent_profile.js to '
  + 'tests/harness.js MANIFEST_ORDER, before src/laplace_core.js)',
  registered, typeof ST.OpponentProfiler);
if (!registered) {
  // Every check below needs the class, so stop here with the real reason instead of a stack trace.
  console.error('FAILED: the module did not load, so nothing below could be checked');
  process.exit(1);
}
{
  const p = new ST.OpponentProfiler();
  check('enabled follows laplace.profile.enabled (literal default: OFF)', p.enabled === cfgFlag('laplace.profile.enabled', false), String(p.enabled));
  check('minSamples reads the config, else 6', p.minSamples === cfgNum('laplace.profile.minSamples', 6), String(p.minSamples));
  check('flightThreshold reads the config, else 0.25', p.flightThreshold === cfgNum('laplace.profile.flightThreshold', 0.25), String(p.flightThreshold));
  check('aggressionThreshold reads the config, else 0.25', p.aggressionThreshold === cfgNum('laplace.profile.aggressionThreshold', 0.25), String(p.aggressionThreshold));
  check('maxFactor reads the config, else 2', p.maxFactor === cfgNum('laplace.profile.maxFactor', 2), String(p.maxFactor));
  check('maxHistory reads the config, else 24', p.maxHistory === cfgNum('laplace.profile.maxHistory', 24), String(p.maxHistory));
  check('a fresh profiler has no history and no last observation', p.history.length === 0 && p.last === null);
  const snap = p.snapshot();
  check('snapshot() is plain data over the empty window (and does not hand out the ring)',
    !!snap && !Array.isArray(snap) && snap.observed === 0 && snap.history === undefined && snap.switchFactor === 1,
    JSON.stringify(snap));
}
{
  const p = new ST.OpponentProfiler({ enabled: true, minSamples: 3, maxFactor: 1.5, maxHistory: 4 });
  check('options override the config for every tunable',
    p.enabled === true && p.minSamples === 3 && p.maxFactor === 1.5 && p.maxHistory === 4,
    [p.enabled, p.minSamples, p.maxFactor, p.maxHistory].join(','));
  const bad = new ST.OpponentProfiler({ minSamples: 0, maxHistory: 0, maxFactor: 0.5, flightThreshold: 5, aggressionThreshold: -3 });
  check('a misconfiguration cannot empty the window or unbounded the factor',
    bad.minSamples >= 1 && bad.maxHistory >= 1 && bad.maxFactor >= 1 &&
    bad.flightThreshold <= 1 && bad.flightThreshold >= 0 && bad.aggressionThreshold <= 1 && bad.aggressionThreshold >= 0,
    [bad.minSamples, bad.maxHistory, bad.maxFactor, bad.flightThreshold, bad.aggressionThreshold].join(','));
}

/* ================================================================== 2. no evidence */

section('with no evidence the profiler has no opinion (factor exactly 1)');
{
  const p = new ST.OpponentProfiler({ enabled: true });
  const o = p.profile(null);
  eq('the label is unknown', o.label, 'unknown');
  check('the factor is exactly 1', o.switchFactor === 1, String(o.switchFactor));
  eq('the sample count is 0', o.samples, 0);
  eq('the deviation is 0', o.deviation, 0);
  check('there is a reason string', typeof o.reason === 'string' && o.reason.length > 0, o.reason);
}
{
  const o = out(rep(5, FLIGHTY), { enabled: true });
  eq('five flighty replies are below the six-sample floor', o.label, 'unknown');
  check('...and still leave the factor at exactly 1', o.switchFactor === 1, String(o.switchFactor));
  eq('...while the samples they did provide are reported', o.samples, 5);
  const six = out(rep(6, FLIGHTY), { enabled: true });
  eq('the sixth crosses the floor', six.label, 'flighty');
  check('...and only then does the factor move', six.switchFactor > 1, String(six.switchFactor));
}
{
  const o = out(rep(6, rec('switch', null)), { enabled: true });
  eq('null frequencies are recorded but never scored', o.samples, 0);
  eq('...so the label stays unknown', o.label, 'unknown');
  eq('...and so does the snapshot count of observations', feed(rep(6, rec('switch', null)), { enabled: true }).snapshot().observed, 6);
  const withNulls = out(rep(6, FLIGHTY).concat(rep(6, rec('switch', null))), { enabled: true });
  const without = out(rep(6, FLIGHTY), { enabled: true });
  eq('nulls do not move the reading at all', [withNulls.label, withNulls.deviation], [without.label, without.deviation]);
  eq('...but they are visible as observations', feed(rep(6, FLIGHTY).concat(rep(6, rec('switch', null))), { enabled: true }).snapshot().observed, 12);
}
{
  const refused = [42, -0.5, 1.5, NaN, Infinity, '0.4', undefined];
  for (let i = 0; i < refused.length; i++) {
    const o = out(rep(6, rec('switch', refused[i])), { enabled: true });
    check('a non-frequency (' + String(refused[i]) + ') is refused, not guessed at', o.samples === 0 && o.switchFactor === 1,
      'samples ' + o.samples + ', factor ' + o.switchFactor);
  }
  const zero = out([rec('switch', 0)], { enabled: true, minSamples: 1 });
  check('a real 0 IS a frequency (the matrix said never, they switched)', zero.samples === 1 && zero.label === 'flighty',
    JSON.stringify({ samples: zero.samples, label: zero.label }));
}

/* ================================================================== 3. the two directions */

section('the reading points the way the header says it does');
{
  const f = out(rep(6, FLIGHTY), { enabled: true });
  eq('they left more than the matrix expected -> flighty', f.label, 'flighty');
  check('...with a factor above 1', f.switchFactor > 1, String(f.switchFactor));
  check('...and a positive deviation', f.deviation > 0, String(f.deviation));
  check('...and the reason says "left"', /left more than/.test(f.reason), f.reason);

  const s = out(rep(6, STAYER), { enabled: true });
  eq('they stayed more than the matrix expected -> over-predictor', s.label, 'over-predictor');
  check('...with a factor below 1', s.switchFactor < 1 && s.switchFactor > 0, String(s.switchFactor));
  check('...and a negative deviation', s.deviation < 0, String(s.deviation));
  check('...and the reason says "stayed"', /stayed more than/.test(s.reason), s.reason);

  const faithful = out(rep(6, FAITHFUL), { enabled: true });
  eq('a player who does exactly what the matrix says reads neutral', faithful.label, 'neutral');
  check('...at like-for-like weights playing the matrix is exactly neutral',
    faithful.switchFactor === 1 && faithful.deviation === 0,
    String(faithful.switchFactor) + '/' + String(faithful.deviation));
  const bothWays = out(rep(3, rec('switch', 1.0)).concat(rep(3, FAITHFUL)), { enabled: true });
  eq('switching when the matrix expected it is not a personality either', bothWays.label, 'neutral');
}
{
  const o = out(rep(6, rec('mystery', 0.1)), { enabled: true });
  eq('an unknown kind is read as "stayed" (the reading is binary)', o.label, 'over-predictor');
  const protect = out(rep(6, rec('protect', 0.1)), { enabled: true });
  eq('...and so is a Protect', protect.label, 'over-predictor');
  const setup = out(rep(6, rec('setup', 0.1)), { enabled: true });
  eq('...and a setup move', setup.label, 'over-predictor');
}
{
  // Exactly three flighty and three faithful: the mean excess is exactly the 0.25 threshold.
  const atThreshold = out(rep(3, rec('switch', 0.5)).concat(rep(3, FAITHFUL)), { enabled: true, flightThreshold: 0.25 });
  eq('a reading exactly AT the threshold is not yet a profile', atThreshold.label, 'neutral');
  check('...and its factor is exactly 1', atThreshold.switchFactor === 1, String(atThreshold.switchFactor));
  eq('...though the deviation is still reported', atThreshold.deviation, 0.25);
  const past = out(rep(4, rec('switch', 0.5)).concat(rep(2, FAITHFUL)), { enabled: true, flightThreshold: 0.25 });
  eq('one step past the threshold is', past.label, 'flighty');
  check('...with a factor just above 1 (the factor tracks the distance past the threshold)',
    past.switchFactor > 1 && past.switchFactor < 1.25, String(past.switchFactor));
}

/* ================================================================== 4. bounds */

section('the factor is bounded and never disagrees with its label');
{
  const strong = out(rep(12, rec('switch', 0)), { enabled: true, maxFactor: 2 });
  check('a maximal reading is capped at maxFactor', strong.switchFactor === 2, String(strong.switchFactor));
  const tight = out(rep(12, rec('switch', 0)), { enabled: true, maxFactor: 1.5 });
  check('...and a tighter maxFactor caps it tighter', tight.switchFactor === 1.5, String(tight.switchFactor));
  const low = out(rep(12, rec('attack', 0)), { enabled: true, maxFactor: 2 });
  check('a maximal reading the other way bottoms out at 1/maxFactor', low.switchFactor === 0.5, String(low.switchFactor));

  const histories = [
    rep(6, FLIGHTY), rep(12, rec('switch', 0)), rep(6, STAYER), rep(12, rec('attack', 0)),
    rep(6, FAITHFUL), rep(4, FLIGHTY), [rec('switch', null)].concat(rep(6, FLIGHTY)),
    rep(3, FLIGHTY).concat(rep(3, STAYER)), []
  ];
  let agreement = true, bounded = true, detail = '';
  const lo = 1 / 2, hi = 2;   // the default maxFactor is 2
  for (let i = 0; i < histories.length; i++) {
    const o = out(histories[i], { enabled: true });
    const f = o.switchFactor;
    if (!(isFinite(f) && f > 0 && f >= lo && f <= hi)) { bounded = false; detail = JSON.stringify(o); break; }
    const flighty = o.label === 'flighty';
    const over = o.label === 'over-predictor';
    if ((flighty && !(f > 1)) || (over && !(f < 1)) || ((!flighty && !over) && f !== 1)) {
      agreement = false; detail = JSON.stringify(o); break;
    }
  }
  check('every factor is finite, positive and inside [1/maxFactor, maxFactor]', bounded, detail);
  check('the label and the factor can never disagree (flighty>1, over-predictor<1, else exactly 1)', agreement, detail);
}

/* ================================================================== 5. the window */

section('the profile is a window over the recent past, not a whole-battle tally');
{
  const p = feed(rep(10, FLIGHTY), { enabled: true, maxHistory: 4 });
  eq('maxHistory trims the ring', p.snapshot().observed, 4);
  eq('...and the profile is read from the trimmed window', p.profile(null).samples, 4);

  const settled = rep(6, FLIGHTY).concat(rep(6, FAITHFUL));
  eq('a player who settles down reads neutral once the window has moved on',
    out(settled, { enabled: true, maxHistory: 6 }).label, 'neutral');
  eq('...while the same battle still reads flighty if the window is long enough to remember',
    out(settled, { enabled: true, maxHistory: 24 }).label, 'flighty');
  const short = out(settled, { enabled: true, maxHistory: 6 });
  eq('...and the settled window reports only the observations it kept', short.samples, 6);
}

/* ================================================================== 6. determinism, purity, reset, disable */

section('determinism, purity, reset and the disabled path');
{
  const records = rep(3, FLIGHTY).concat(rep(3, STAYER)).concat([rec('switch', null)]);
  const a = feed(records, { enabled: true }).profile({ turn: 14 });
  const b = feed(records, { enabled: true }).profile({ turn: 14 });
  check('two identical histories produce identical profiles', JSON.stringify(a) === JSON.stringify(b),
    JSON.stringify(a) + ' vs ' + JSON.stringify(b));
  const c = feed(records, { enabled: true }).profile({ turn: 15 });
  check('...and only the turn in the reason follows the state',
    a.label === c.label && a.switchFactor === c.switchFactor && a.samples === c.samples &&
    a.deviation === c.deviation && a.reason !== c.reason,
    JSON.stringify(a) + ' vs ' + JSON.stringify(c));
  check('the reason names the turn it was asked about', c.reason.indexOf('turn 15') !== -1, c.reason);
}
{
  const records = [rec('switch', 0.1, 3), rec('attack', null, 4), rec('switch', 42, 5)];
  const before = JSON.stringify(records);
  const p = new ST.OpponentProfiler({ enabled: true });
  for (let i = 0; i < records.length; i++) check('observe returns this (' + i + ')', p.observe(records[i]) === p);
  check('observe never mutates the record it is given', JSON.stringify(records) === before, JSON.stringify(records));
  const state = { turn: 14, myTeam: [{ species: 'Great Tusk', boosts: { atk: 1 } }] };
  const stateBefore = JSON.stringify(state);
  p.profile(state);
  check('profile never mutates the state it is given', JSON.stringify(state) === stateBefore, JSON.stringify(state));
}
{
  const p = feed(rep(8, FLIGHTY), { enabled: true });
  eq('reset() clears the history back to no opinion', [p.reset().profile(null).label, p.profile(null).samples], ['unknown', 0]);
  check('...and drops the remembered last observation', p.last === null && p.history.length === 0);
  p.observe(FLIGHTY);
  eq('...so the next observation starts a fresh window', p.profile(null).samples, 1);
}
{
  const off = out(rep(12, FLIGHTY), { enabled: false });
  eq('disabled reads neutral', off.label, 'neutral');
  check('...and leaves the factor at exactly 1', off.switchFactor === 1, String(off.switchFactor));
  check('...while still reporting what it measured, for an offline gate to look at',
    off.samples === 12 && off.deviation > 0, JSON.stringify({ samples: off.samples, deviation: off.deviation }));
  check('...and saying so in the reason', /profiling is off/.test(off.reason), off.reason);
  // The default profiler follows `laplace.profile.enabled`; either way an empty profiler factors to 1.
  const dflt = new ST.OpponentProfiler();
  const dfltOut = dflt.profile(null);
  eq('a default profiler with no history labels unknown when it is on, neutral when it is off',
    dfltOut.label, dflt.enabled ? 'unknown' : 'neutral');
  check('...and leaves the factor at exactly 1 either way', dfltOut.switchFactor === 1, String(dfltOut.switchFactor));
}

/* ==================================================================== report */

const finalOut = out(rep(6, FLIGHTY), { enabled: true });
console.log('\n=== readout ===');
console.log('  all-switch @0.1 -> ' + finalOut.label + ' factor ' + finalOut.switchFactor.toFixed(4) +
  ' deviation ' + finalOut.deviation);
console.log('  ' + finalOut.reason);

console.log('');
if (failures.length) {
  console.error('FAILED: ' + failures.length + ' of ' + (passed + failures.length) + ' checks');
  failures.forEach(function (f) { console.error('  - ' + f); });
  process.exit(1);
}
console.log('ALL PROFILE CHECKS PASSED (' + passed + ')');
process.exit(0);
