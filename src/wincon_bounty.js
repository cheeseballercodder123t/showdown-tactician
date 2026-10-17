/* Showdown Tactician — src/wincon_bounty.js
 * The backward-chained win-condition bounty: "which ONE of their bodies is the thing standing
 * between us and our best line, and what is it worth to remove it?"
 *
 * WHY THIS EXISTS
 *   The 128D evaluator scores the board holistically — it knows a body is healthy, never that it is
 *   the reason our sweeper cannot come in. src/tempo_vector.js keeps a "win-con health" dimension
 *   (v9), but nothing in the engine can name a TARGET, and a target is what a plan needs.
 *
 * WHY IT ONLY MEASURES
 *   The tempting version of this feature is a species rule ("remove the wall and the sweeper wins"),
 *   which this repository forbids outright — RULE 1, enforced by src/blackbox_guard.js, and the
 *   reason src/veto_guard.js refuses to advise whenever it cannot measure. So every number below
 *   comes out of ST.DamageEngine on the two rosters actually on the field: no species, ability or
 *   move name is ever read as a fact about the game, and this module computes no damage of its own.
 *
 * THE MEASUREMENT (one scoring pass per candidate body, all through the damage engine)
 *   attackPower(j)  the hardest hit their body j lands on any of our living bodies      (0..100 %)
 *   killThreat(j)   true when that hit is an OHKO on the body it lands on
 *   unbreakable(j)  true when OUR best single hit into j is not an OHKO
 *   blocker(j)      unbreakable(j) AND threatening(j)  — it survives us and it hits back
 *   score(j)        (blocker ? BAR : 0) + attackPower(j) + (killThreat ? BAR : 0)
 *
 *   BAR is 100, one full HP bar: the unit `avgPercent` is already measured in, so the scoring
 *   invents no scale of its own.
 *
 *   `targetId` is the highest-scoring body, ties going to the earlier body in a stable order, so
 *   the same board always names the same target. `bounty` is `laplace.wincon.maxBounty` scaled by
 *   how much the target dominates the runner-up — (score(target) - bestOther) / score(target) —
 *   which means two bodies that threaten us equally produce a plan worth 0: there is no single
 *   golden path, and the module says so instead of forcing a pick.
 *
 * REFUSALS (a plan is a claim, and this module makes none it cannot measure)
 *   null when the tier is off, when there is no damage engine, when either side has no living
 *   body, when fewer than TWO opposing bodies remain (a target chosen from one candidate is not a
 *   choice), or when nothing measurable about the candidates scores above zero.
 *
 * OFF BY DEFAULT
 *   `laplace.wincon.enabled` is false, so `plan()` is null and `bonus()` is 0 until the tier is
 *   wired into the decision loop and measured. The knobs live in src/config.js (RULE 4) and are
 *   read per call, so a runtime change takes effect on the next decision; the constructor's
 *   explicit options win over the config, which is what the suite uses to exercise the tier.
 */
(function () {
  'use strict';
  const ST = (window.ST = window.ST || {});
  const U = ST.util;

  /** RULE 4: the only accessor for this tier's tunables; the literal is the standalone fallback. */
  function W(key, fallback) {
    return typeof ST.configGet === 'function' ? ST.configGet('laplace.wincon.' + key, fallback) : fallback;
  }

  /** One full HP bar — the unit `avgPercent` is already in. Not a heuristic weight. */
  const BAR = 100;

  class WinConditionBounty {
    constructor(options) {
      options = options || {};
      this.damage = options.damage || null;
      this.options = options;
      this.last = null;
    }

    /** Explicit constructor options first (the suite's lever), then src/config.js. */
    _tune(key, fallback) {
      if (this.options && this.options[key] !== undefined) return this.options[key];
      return W(key, fallback);
    }

    _on() { return !!this._tune('enabled', false); }

    /**
     * plan(state, worlds) -> {
     *   targetId, targetSpecies, bounty, dominance, score, reason,
     *   blockers: [{ id, species, score, ourBest, theirBest, reason }]
     * } | null
     *
     * `worlds` is the sampler's output (each world carries the opponent's team); when it is absent
     * or empty the opponent's live roster in `state.oppTeam` is used instead.
     */
    plan(state, worlds) {
      this.last = null;
      if (!this._on() || !this.damage) return null;
      const mine = this._livingTeam(state && state.myTeam);
      const theirs = this._livingOpponents(state, worlds);
      if (!mine.length) return null;
      if (theirs.length < 2) return null;
      const field = (state && state.field) || null;
      const cap = Math.max(1, Math.floor(this._tune('maxTargets', 3)));

      // Rank BEFORE the cap. Capping the roster first would examine whichever bodies the team
      // happens to list first; the rank key is itself a measurement (the hardest hit that body
      // lands on us), so `maxTargets` bounds the scoring work without bounding the search.
      const ranked = [];
      for (let i = 0; i < theirs.length; i++) {
        ranked.push({ mon: theirs[i], quick: this._quickThreat(theirs[i], mine, field) });
      }
      ranked.sort(function (a, b) { return b.quick - a.quick; });

      const examined = [];
      for (let i = 0; i < ranked.length && i < cap; i++) {
        examined.push(this._measure(ranked[i].mon, mine, field));
      }

      let target = null;
      for (let i = 0; i < examined.length; i++) {
        if (!target || examined[i].score > target.score) target = examined[i];
      }
      if (!target || !(target.score > 0)) return null;

      let bestOther = 0;
      for (let i = 0; i < examined.length; i++) {
        if (examined[i] !== target && examined[i].score > bestOther) bestOther = examined[i].score;
      }
      const dominance = U.clamp((target.score - bestOther) / target.score, 0, 1);
      const maxBounty = Math.max(0, this._tune('maxBounty', 0));
      const bounty = Math.round(U.clamp(maxBounty * dominance, 0, maxBounty));

      const blockers = [];
      for (let i = 0; i < examined.length; i++) {
        const row = examined[i];
        if (!row.blocker) continue;
        blockers.push({
          id: row.id, species: row.species, score: row.score,
          ourBest: row.ourBest, theirBest: row.theirBest, reason: row.reason
        });
      }
      blockers.sort(function (a, b) { return b.score - a.score; });

      const plan = {
        targetId: target.id,
        targetSpecies: target.species,
        bounty: bounty,
        dominance: U.round2(dominance),
        score: target.score,
        reason: target.reason,
        /* THE CHIP HALF's two numbers, both measured: the target's HP when the plan was made,
         * and the HP at which OUR best hit on it becomes an OHKO (the smallest roll of that hit).
         * `bonus` reads them against the leaf to price progress toward the break point. */
        hpAtPlan: target.hp,
        chipThreshold: target.ourBestMin,
        blockers: blockers
      };
      this.last = plan;
      return plan;
    }

    /**
     * bonus(plan, faintedIds) -> number in [0, maxBounty]
     * The bounty is paid only when the target body is GONE: before that it is 0, so the caller can
     * fold it into a leaf without a plan-is-satisfied flag of its own. `faintedIds` may hold ids,
     * species names or the mons themselves; anything else in it pays nothing.
     */
    bonus(plan, faintedIds, leaf) {
      if (!this._on() || !plan || !plan.targetId) return 0;
      const maxBounty = Math.max(0, this._tune('maxBounty', 0));
      const raw = (typeof plan.bounty === 'number' && isFinite(plan.bounty)) ? plan.bounty : 0;
      const bounty = U.clamp(raw, 0, maxBounty);
      const wanted = U.toID(plan.targetId);
      const list = Array.isArray(faintedIds) ? faintedIds : [];
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        const id = U.toID(entry && typeof entry === 'object' ? (entry.id || entry.species) : entry);
        if (id && id === wanted) return bounty > 0 ? bounty : 0;
      }
      /* THE CHIP HALF. A roadblock that is not dead yet still changed the board: the plan is worth
       * something for moving its HP toward the point where our own best hit breaks it. The share
       * is measured against where the body STARTED (the live board the plan was made on) and the
       * break point (the smallest roll of our best hit), so the same chip on a healthy wall and on
       * a nearly-broken one are not paid the same. Clipped to the bounty's own ceiling. */
      const chip = Math.max(0, this._tune('chipBounty', 0));
      if (!(chip > 0) || !leaf) return 0;
      const threshold = (typeof plan.chipThreshold === 'number') ? plan.chipThreshold : 0;
      const started = (typeof plan.hpAtPlan === 'number') ? plan.hpAtPlan : 100;
      if (!(threshold > 0) || !(started > 0)) return 0;
      const now = this._leafHp(leaf, wanted);
      if (!(now > 0) || now >= started) return 0;
      const need = Math.max(1, started - threshold);
      const progress = U.clamp((started - now) / need, 0, 1);
      return Math.round(U.clamp(chip * progress, 0, Math.max(chip, bounty)));
    }

    /** The target's HP on a leaf board: its active slot first, then their roster. */
    _leafHp(leaf, wanted) {
      const active = leaf && leaf.active && leaf.active.opp;
      const hit = function (mon) {
        if (!mon) return null;
        if (U.toID(mon.id || mon.species) !== wanted) return null;
        const hp = (typeof mon.hpPercent === 'number') ? mon.hpPercent : mon.hp;
        return (typeof hp === 'number' && isFinite(hp)) ? hp : null;
      };
      const first = hit(active);
      if (first !== null) return first;
      const team = (leaf && leaf.oppTeam) || [];
      for (let i = 0; i < team.length; i++) {
        const hp = hit(team[i]);
        if (hp !== null) return hp;
      }
      return 100;
    }

    /* -------------------------------------------------------------- rosters */

    /** The living members of one of OUR team arrays, in roster order. */
    _livingTeam(team) {
      const list = Array.isArray(team) ? team : [];
      const out = [];
      for (let i = 0; i < list.length; i++) {
        if (list[i] && !list[i].fainted) out.push(list[i]);
      }
      return out;
    }

    /**
     * The living opponent bodies, deduplicated by identity so the six sampled worlds (which differ
     * in SET, not in BODY) count as one candidate each. Falls back to the live roster when no
     * worlds have been sampled.
     */
    _livingOpponents(state, worlds) {
      const out = [];
      const seen = Object.create(null);
      const push = function (mon) {
        if (!mon || mon.fainted) return;
        const id = U.toID(mon.id || mon.species);
        if (!id || seen[id]) return;
        seen[id] = 1;
        out.push(mon);
      };
      const list = Array.isArray(worlds) ? worlds : [];
      for (let w = 0; w < list.length; w++) {
        const team = (list[w] && list[w].team) || [];
        for (let i = 0; i < team.length; i++) push(team[i]);
      }
      if (!out.length) {
        const fallback = (state && state.oppTeam) || [];
        for (let i = 0; i < fallback.length; i++) push(fallback[i]);
      }
      return out;
    }

    /* ------------------------------------------------------------ measuring */

    /** The hardest hit one opposing body lands on ANY of our living bodies. */
    _quickThreat(mon, mine, field) {
      let worst = 0;
      for (let i = 0; i < mine.length; i++) {
        const hit = this.damage.getBestIncomingThreat(mon, mine[i], field);
        if (hit && hit.avgPercent > worst) worst = hit.avgPercent;
      }
      return worst;
    }

    /** Score one candidate body against our roster, entirely out of damage-engine numbers. */
    _measure(mon, mine, field) {
      let attackPower = 0;
      let killThreat = false;
      let theirBest = null;
      let theirVictim = null;
      for (let i = 0; i < mine.length; i++) {
        const hit = this.damage.getBestIncomingThreat(mon, mine[i], field);
        if (!hit || !(hit.avgPercent > 0)) continue;
        if (!theirBest || hit.avgPercent > theirBest.avgPercent) { theirBest = hit; theirVictim = mine[i]; }
        if (hit.avgPercent > attackPower) attackPower = hit.avgPercent;
        if (hit.isOHKO) killThreat = true;
      }

      let ourBest = null;
      let ourUser = null;
      for (let i = 0; i < mine.length; i++) {
        const hit = this.damage.getBestOutgoingMove(mine[i], mon, field);
        if (!hit || hit.failed) continue;
        if (!ourBest || hit.avgPercent > ourBest.avgPercent) { ourBest = hit; ourUser = mine[i]; }
      }

      const threatens = attackPower > 0;
      const unbreakable = !(ourBest && ourBest.isOHKO);
      const blocker = unbreakable && threatens;
      const score = (blocker ? BAR : 0) + attackPower + (killThreat ? BAR : 0);

      const id = U.toID(mon.id || mon.species);
      const species = mon.species || mon.id || id;
      const row = {
        id: id,
        species: species,
        hp: (typeof mon.hpPercent === 'number') ? mon.hpPercent : ((typeof mon.hp === 'number') ? mon.hp : 100),
        ourBestMin: (ourBest && typeof ourBest.minPercent === 'number') ? ourBest.minPercent : 0,
        attackPower: attackPower,
        killThreat: killThreat,
        unbreakable: unbreakable,
        threatens: threatens,
        blocker: blocker,
        score: score,
        ourBest: this._line(ourBest, ourUser),
        theirBest: this._line(theirBest, theirVictim)
      };
      row.reason = this._reason(row);
      return row;
    }

    /** A measurement, named, so the readout can say WHY without inventing anything. */
    _line(hit, mon) {
      if (!hit) return null;
      return {
        move: hit.move,
        byId: U.toID(mon && (mon.id || mon.species)),
        avgPercent: U.round1(hit.avgPercent),
        isOHKO: !!hit.isOHKO
      };
    }

    _reason(row) {
      const our = row.ourBest
        ? (row.ourBest.move + ' for ' + row.ourBest.avgPercent + '%')
        : 'no modelled hit';
      const theirs = row.theirBest
        ? (row.theirBest.move + ' for ' + row.theirBest.avgPercent + '%' +
          (row.killThreat ? ' (an OHKO)' : ''))
        : 'nothing modelled';
      return row.species + ': our best line (' + our + ') ' +
        (row.unbreakable ? 'does not KO it' : 'KOs it') +
        '; it answers with ' + theirs;
    }
  }

  ST.WinConditionBounty = WinConditionBounty;
})();
