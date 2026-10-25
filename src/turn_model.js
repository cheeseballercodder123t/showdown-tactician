(function () {
  'use strict';
  const ST = window.ST = window.ST || {};
  const U = ST.util;
  const id = U.toID;
  const alive = function (m) { return m && !m.fainted && m.hp > 0; };
  const ability = function (m) { return id(m.activeAbility || m.revealedAbility || m.ability); };
  const item = function (m) { return m.itemRemoved || m.itemConsumed ? '' : id(m.item || m.currentBattleItem || m.confirmedItem); };

  class TurnModel {
    constructor(damage) { this.damage = damage; this.nodes = 0; }

    clone(state) {
      const out = Object.assign({}, state, { sides: undefined, field: U.deepClone(state.field || {}), active: {}, bench: {},
        protect: Object.assign({}, state.protect), _modelProtect: Object.assign({}, state._modelProtect) });
      for (const side of ['my', 'opp']) {
        const active = state.active && state.active[side];
        out[side + 'Team'] = (state[side + 'Team'] || []).map(function (m) {
          const copy = Object.assign({}, m, { boosts: Object.assign({}, m.boosts), volatiles: Object.assign({}, m.volatiles) });
          copy.hp = typeof m.hpPercent === 'number' ? m.hpPercent : m.hp;
          copy.hpPercent = copy.hp;
          if (m === active || m.isActive) out.active[side] = copy;
          return copy;
        });
        if (!out.active[side] && active) {
          const copy = Object.assign({}, active, { boosts: Object.assign({}, active.boosts), volatiles: Object.assign({}, active.volatiles) });
          out[side + 'Team'].push(copy); out.active[side] = copy;
        }
        out.bench[side] = out[side + 'Team'].filter(function (m) { return alive(m) && m !== out.active[side]; });
      }
      out.modelWarnings = (state.modelWarnings || []).slice();
      return out;
    }

    hp(mon, value) {
      mon.hp = mon.hpPercent = U.clamp(value, 0, 100);
      mon.fainted = mon.hp <= 0;
      mon.exactHP = null;
    }

    warn(state, reason) { if (!state.modelWarnings.includes(reason)) state.modelWarnings.push(reason); }

    speed(mon, state) {
      const result = U.computeSpeed(mon, { boosts: mon.boosts, boostStage: mon.boosts && mon.boosts.spe || 0,
        item: item(mon), ability: ability(mon), weather: state.field.weather, terrain: state.field.terrain,
        paradoxSpeedBoost: U.paradoxSpeedBoost(mon), unburden: !!mon.unburdenActive,
        tailwind: !!(state.field.tailwind && state.field.tailwind[mon.side]) });
      return result.effective;
    }

    order(state, mine, theirs) {
      const priority = function (a) { return a.kind === 'switch' ? 6 : U.movePriority(a.name); };
      const diff = priority(mine) - priority(theirs);
      if (diff) return diff > 0 ? ['my', 'opp'] : ['opp', 'my'];
      const speed = this.speed(state.active.my, state) - this.speed(state.active.opp, state);
      if (!speed) return null;
      return (state.field.trickRoom ? speed < 0 : speed > 0) ? ['my', 'opp'] : ['opp', 'my'];
    }

    enter(state, side, target) {
      const outgoing = state.active[side];
      if (outgoing && alive(outgoing)) {
        if (ability(outgoing) === 'regenerator') this.hp(outgoing, outgoing.hp + 100 / 3);
        if (ability(outgoing) === 'naturalcure') outgoing.status = '';
      }
      if (outgoing) outgoing.isActive = false;
      target.isActive = true; target.boosts = {}; target.volatiles = {}; target.abilityOn = false;
      target.boosterActive = false; target.boostedStat = null; target.switchedInTurn = state.turn;
      target.activeStintMoves = []; target.hasActedSinceEntry = false;
      state.active[side] = target;
      const hazards = state.field.hazards && state.field.hazards[target.side] || {};
      this.hp(target, target.hp - U.hazardPercent(target.species, item(target), ability(target), hazards));
      if (alive(target)) {
        const weather = { snowwarning: 'snow', sandstream: 'sandstorm', drought: 'sun', drizzle: 'rain' }[ability(target)];
        if (weather) { state.field.weather = weather; state.field.weatherTurnsLeft = 5; }
        if (ability(target) === 'intimidate') {
          const foe = state.active[side === 'my' ? 'opp' : 'my'];
          if (foe && !['clearbody', 'whitesmoke', 'fullmetalbody', 'innerfocus', 'oblivious', 'owntempo', 'scrappy'].includes(ability(foe)))
            foe.boosts.atk = U.clamp((foe.boosts.atk || 0) - 1, -6, 6);
        }
      }
      return target;
    }

    target(state, side, action) {
      return (state[side + 'Team'] || []).find(function (m) {
        return id(m.uid) === id(action.targetUid) || id(m.id || m.species) === id(action.targetId || action.name);
      });
    }

    actions(state, side, root) {
      const mon = state.active[side];
      if (!mon) return [];
      if (root && side === 'my') return root;
      const moves = this.damage.movesFor(mon, 4);
      const out = [];
      for (const name of moves) {
        const mid = id(name);
        if ((mon.movePP && mon.movePP[mid] === 0) || mon.choiceLocked && mid !== id(mon.choiceLockedMove)) continue;
        out.push({ kind: 'move', name: name, moveId: mid });
      }
      for (const m of state[side + 'Team'] || []) if (alive(m) && m !== mon)
        out.push({ kind: 'switch', name: m.species, targetId: m.id, targetUid: m.uid });
      return out;
    }

    hit(state, side, action, foeAction, protectedSides) {
      const mon = state.active[side];
      const foeSide = side === 'my' ? 'opp' : 'my';
      const foe = state.active[foeSide];
      const mid = id(action.name);
      const data = U.getMoveData(action.name);
      if (!data) { this.warn(state, 'Unmodeled move: ' + action.name); return [{ state: state, p: 1 }]; }
      if (protectedSides[foeSide] && !data.isStatus && !(ability(mon) === 'unseenfist' && data.makesContact)) return [{ state: state, p: 1 }];
      if (data.isStatus && mon.volatiles.taunt) return [{ state: state, p: 1 }];
      if (U.requiresTargetAttack(mid) && (foeAction.kind !== 'move' || U.getMoveData(foeAction.name)?.isStatus)) return [{ state: state, p: 1 }];
      if (U.firstTurnOnly(mid) && (mon.hasActedSinceEntry || (mon.activeStintMoves || []).length)) return [{ state: state, p: 1 }];
      if (data.isStatus || mid === 'futuresight' || mid === 'doomdesire') {
        if (mid === 'trickroom') {
          if (mon.volatiles.taunt) return [{ state: state, p: 1 }];
          state.field.trickRoom = !state.field.trickRoom;
          state.field.trickRoomTurnsLeft = state.field.trickRoom ? 5 : 0;
        } else if (data.isRecovery) this.hp(mon, mon.hp + 50);
        else if (data.isSetup || mid === 'curse' && !U.getSpecies(mon.species)?.types.includes('Ghost')) {
          const boosts = mid === 'curse' ? { atk: 1, def: 1, spe: -1 } : U.setupBoosts(action.name) || {};
          const cost = boosts.hpCostPct || 0;
          if (mon.hp > cost) {
            this.hp(mon, mon.hp - cost);
            for (const key of Object.keys(boosts)) if (key !== 'hpCostPct') mon.boosts[key] = U.clamp((mon.boosts[key] || 0) + boosts[key], -6, 6);
          }
        } else if (mid === 'futuresight' || mid === 'doomdesire') {
          state.field.delayedMoves = Object.assign({}, state.field.delayedMoves);
          if (!state.field.delayedMoves[foe.side]) state.field.delayedMoves[foe.side] = {
            move: action.name, moveId: mid, attacker: Object.assign({}, mon), landingTurn: state.turn + 2
          };
        } else if (mid === 'wish') {
          state.field.wish = Object.assign({}, state.field.wish);
          state.field.wish[mon.side] = { landingTurn: state.turn + 1, healPct: 50 };
        } else if (U.HAZARD_LAYERS && U.HAZARD_LAYERS[mid]) {
          const entry = U.HAZARD_LAYERS[mid];
          state.field.hazards = U.deepClone(state.field.hazards || {});
          const target = state.field.hazards[foe.side] = state.field.hazards[foe.side] || {};
          if (ability(foe) === 'magicbounce') this.warn(state, 'Magic Bounce hazard reflection requires a fuller model');
          else target[entry.key] = entry.max === 1 ? true : Math.min(entry.max, (target[entry.key] || 0) + 1);
        } else if (U.HAZARD_REMOVAL_MOVES && U.HAZARD_REMOVAL_MOVES.has(mid)) {
          state.field.hazards = U.deepClone(state.field.hazards || {});
          state.field.hazards[mon.side] = {};
          if (mid === 'defog') state.field.hazards[foe.side] = {};
          this.warn(state, 'Removal secondary effects use a limited model');
        } else if (!data.isPivot && !data.isProtect) this.warn(state, 'Unmodeled status effect: ' + action.name);
        if (mid === 'chillyreception') { state.field.weather = 'snow'; state.field.weatherTurnsLeft = 5; }
        return [{ state: state, p: 1, pivot: data.isPivot }];
      }
      if (!alive(foe)) return [{ state: state, p: 1 }];
      const result = this.damage.calculateDamage(mon, foe, action.name, state.field);
      if (!result || result.failed) { this.warn(state, 'Damage unavailable: ' + action.name); return [{ state: state, p: 1 }]; }
      let accuracy = state.moveAccuracy && state.moveAccuracy[mid];
      accuracy = accuracy === true || accuracy === undefined ? 1 : U.clamp(accuracy / 100, 0, 1);
      if (mid === 'blizzard' && ['snow', 'hail'].includes(state.field.weather) || ['thunder', 'hurricane'].includes(mid) && ['rain', 'heavyrain'].includes(state.field.weather)) accuracy = 1;
      if (accuracy === 1 && state.moveAccuracy && state.moveAccuracy[mid] === undefined) this.warn(state, 'Missing accuracy: ' + action.name);
      const groups = [];
      if (accuracy < 1) groups.push({ p: 1 - accuracy, damage: 0, missed: true });
      if (result.rolls && result.rolls.length) {
        const nonKo = result.rolls.filter(function (r) { return result.rollPercent(r) < foe.hp; });
        const ko = result.rolls.length - nonKo.length;
        if (nonKo.length) groups.push({ p: accuracy * nonKo.length / result.rolls.length,
          damage: nonKo.reduce(function (sum, r) { return sum + result.rollPercent(r); }, 0) / nonKo.length });
        if (ko) groups.push({ p: accuracy * ko / result.rolls.length, damage: foe.hp });
      } else {
        groups.push({ p: accuracy, damage: result.avgPercent });
        if (data.isMultihit) this.warn(state, 'Multihit damage uses its mean');
      }
      const out = [];
      for (const group of groups) {
        const next = this.clone(state), a = next.active[side], d = next.active[foeSide];
        this.hp(d, d.hp - group.damage);
        if (!group.missed) {
          if (mid === 'mysticalfire' && alive(d)) d.boosts.spa = U.clamp((d.boosts.spa || 0) - 1, -6, 6);
          const drops = { closecombat: { def: -1, spd: -1 }, superpower: { atk: -1, def: -1 }, headlongrush: { def: -1, spd: -1 } }[mid];
          for (const key of Object.keys(drops || {})) a.boosts[key] = U.clamp((a.boosts[key] || 0) + drops[key], -6, 6);
          if (item(a) === 'lifeorb' && group.damage > 0 && ability(a) !== 'magicguard' && ability(a) !== 'sheerforce') this.hp(a, a.hp - 10);
          if (mid === 'makeitrain') a.boosts.spa = U.clamp((a.boosts.spa || 0) - 1, -6, 6);
          if (mid === 'knockoff' && group.damage > 0 && !U.isMegaStone(d.item) && !U.isZCrystal(d.item) && ability(d) !== 'stickyhold') {
            d.item = ''; d.itemRemoved = true; d.itemless = true;
          }
          if (d.disguiseIntact && ability(a) !== 'moldbreaker') d.disguiseIntact = false;
        }
        out.push({ state: next, p: group.p, pivot: data.isPivot && !group.missed && group.damage > 0 });
      }
      return out;
    }

    residual(state) {
      for (const side of ['my', 'opp']) {
        const mon = state.active[side];
        if (!alive(mon)) continue;
        const key = mon.side;
        const pending = state.field.delayedMoves && state.field.delayedMoves[key];
        if (pending && pending.landingTurn <= state.turn) {
          const damage = this.damage.calculateDamage(pending.attacker, mon, pending.move || pending.moveId, state.field);
          if (damage && !damage.failed) this.hp(mon, mon.hp - damage.avgPercent);
          state.field.delayedMoves[key] = null;
        }
        if (!alive(mon)) continue;
        const wish = state.field.wish && state.field.wish[key];
        if (wish && wish.landingTurn <= state.turn) { this.hp(mon, mon.hp + wish.healPct); state.field.wish[key] = null; }
        if (ability(mon) !== 'magicguard') {
          if (mon.status === 'brn') this.hp(mon, mon.hp - 100 / 16);
          if (mon.status === 'psn') this.hp(mon, mon.hp - 100 / 8);
          if (mon.status === 'tox') { mon.toxicCounter = (mon.toxicCounter || 0) + 1; this.hp(mon, mon.hp - mon.toxicCounter * 100 / 16); }
          if (state.field.weather === 'sandstorm' && !U.getSpecies(mon.species)?.types.some(function (t) { return ['Rock', 'Ground', 'Steel'].includes(t); }) &&
            !['sandveil', 'sandrush', 'sandforce', 'overcoat'].includes(ability(mon)) && item(mon) !== 'safetygoggles') this.hp(mon, mon.hp - 100 / 16);
        }
        if (alive(mon) && item(mon) === 'leftovers') this.hp(mon, mon.hp + 100 / 16);
        if (alive(mon) && item(mon) === 'flameorb' && !mon.status) mon.status = 'brn';
      }
      for (const [effect, timer] of [['trickRoom', 'trickRoomTurnsLeft'], ['weather', 'weatherTurnsLeft'], ['terrain', 'terrainTurnsLeft']]) {
        if (state.field[effect] && typeof state.field[timer] === 'number') {
          state.field[timer] = Math.max(0, state.field[timer] - 1);
          if (state.field[timer] === 0) state.field[effect] = effect === 'trickRoom' ? false : '';
        }
      }
      state.turn = (state.turn || 0) + 1;
      return state;
    }

    resolve(state, mine, theirs, choose) {
      this.nodes++;
      const start = this.clone(state);
      start._modelProtect = {};
      const order = this.order(start, mine, theirs);
      const orders = order ? [{ order: order, p: 1 }] : [{ order: ['my', 'opp'], p: 0.5 }, { order: ['opp', 'my'], p: 0.5 }];
      const output = [];
      for (const path of orders) {
        let branches = [{ state: this.clone(start), p: path.p }];
        const actors = { my: start.active.my && (start.active.my.uid || start.active.my.id), opp: start.active.opp && (start.active.opp.uid || start.active.opp.id) };
        const actions = { my: mine, opp: theirs };
        for (const side of path.order) {
          const next = [];
          for (const branch of branches) {
            const st = branch.state, mon = st.active[side], action = actions[side], foe = actions[side === 'my' ? 'opp' : 'my'];
            if (!alive(mon) || (mon.uid || mon.id) !== actors[side]) { next.push(branch); continue; }
            if (action.kind === 'switch') {
              const target = this.target(st, side, action);
              if (alive(target) && target !== mon) this.enter(st, side, target);
              next.push(branch); continue;
            }
            if (mon._modelFlinched) { next.push(branch); continue; }
            if (['slp', 'frz'].includes(mon.status)) { this.warn(st, 'Sleep or freeze duration is uncertain'); next.push(branch); continue; }
            for (const part of ['my', 'opp']) {
              const count = st[part + 'Team'].filter(function (m) { return m.fainted; }).length;
              for (const member of st[part + 'Team']) member.alliesFainted = count;
            }
            const streakKey = side === 'my' ? 'myConsecutiveProtects' : 'oppConsecutiveProtects';
            if (U.getMoveData(action.name)?.isProtect) {
              const chance = Math.pow(1 / 3, st.protect[streakKey] || 0);
              const success = this.clone(st);
              success._modelProtect[side] = true; success.protect[streakKey] = (st.protect[streakKey] || 0) + 1;
              success.active[side].hasActedSinceEntry = true;
              next.push({ state: success, p: branch.p * chance });
              if (chance < 1) { st.protect[streakKey] = 0; next.push({ state: st, p: branch.p * (1 - chance) }); }
              continue;
            }
            st.protect[streakKey] = 0;
            for (const result of this.hit(st, side, action, foe, st._modelProtect)) {
              result.state.active[side].hasActedSinceEntry = true;
              if (U.guaranteedFlinch(action.name) && !U.flinchBlocked(result.state.active[side === 'my' ? 'opp' : 'my'])) result.state.active[side === 'my' ? 'opp' : 'my']._modelFlinched = true;
              if (result.pivot && alive(result.state.active[side]) && choose) {
                const target = choose(result.state, side);
                if (target) this.enter(result.state, side, target);
              }
              next.push({ state: result.state, p: branch.p * result.p });
            }
          }
          branches = next;
        }
        for (const branch of branches) {
          this.residual(branch.state);
          for (const side of ['my', 'opp']) if (branch.state.active[side]) branch.state.active[side]._modelFlinched = false;
          output.push(branch);
        }
      }
      return output;
    }
  }
  ST.TurnModel = TurnModel;

  class TacticalSearch {
    constructor(damage) { this.model = new TurnModel(damage); this.damage = damage; }

    value(state) {
      const totals = {};
      for (const side of ['my', 'opp']) totals[side] = (state[side + 'Team'] || []).reduce(function (sum, m) {
        return sum + (alive(m) ? 180 + m.hp : 0);
      }, 0);
      if (!totals.my || !totals.opp) return !totals.my && !totals.opp ? 0 : (totals.my ? 10000 : -10000) + 0.01 * (totals.my - totals.opp);
      let score = totals.my - totals.opp;
      const me = state.active.my, foe = state.active.opp;
      if (alive(me) && alive(foe)) {
        const mine = this.bestHit(state, 'my'), theirs = this.bestHit(state, 'opp');
        const order = this.model.order(state, { kind: 'move', name: mine.name }, { kind: 'move', name: theirs.name });
        const myHit = Math.min(foe.hp, mine.damage), theirHit = Math.min(me.hp, theirs.damage);
        score += 0.35 * (myHit - theirHit);
        if (order && order[0] === 'my' && mine.damage >= foe.hp) score += 90;
        if (order && order[0] === 'opp' && theirs.damage >= me.hp) score -= 90;
      }
      return score;
    }

    bestHit(state, side) {
      const me = state.active[side], foe = state.active[side === 'my' ? 'opp' : 'my'];
      let best = { name: 'Struggle', damage: 0 };
      if (!alive(me) || !alive(foe)) return best;
      for (const name of this.damage.movesFor(me, 4)) {
        const data = U.getMoveData(name);
        if (!data || data.isStatus || id(name) === 'futuresight') continue;
        const result = this.damage.calculateDamage(me, foe, name, state.field);
        if (result && !result.failed && result.avgPercent > best.damage) best = { name: name, damage: result.avgPercent };
      }
      return best;
    }

    entry(state, side) {
      let best = null, score = -Infinity;
      for (const mon of state[side + 'Team'] || []) {
        if (!alive(mon) || mon === state.active[side]) continue;
        const next = this.model.clone(state);
        const incoming = next[side + 'Team'].find(function (m) { return m.uid === mon.uid && m.id === mon.id; });
        this.model.enter(next, side, incoming);
        let value = this.value(next) * (side === 'my' ? 1 : -1);
        if (this.damage.movesFor(incoming).some(function (m) { return id(m) === 'trickroom'; }) && !next.field.trickRoom) {
          const foe = next.active[side === 'my' ? 'opp' : 'my'];
          const threat = this.bestHit(next, side === 'my' ? 'opp' : 'my').damage;
          if (alive(foe) && incoming.hp > threat) {
            const without = this.value(next) * (side === 'my' ? 1 : -1);
            next.field.trickRoom = true; next.field.trickRoomTurnsLeft = 4;
            for (const breaker of next[side + 'Team']) if (alive(breaker) && breaker !== incoming) {
              const position = this.model.clone(next);
              const target = position[side + 'Team'].find(function (m) { return m.uid === breaker.uid && m.id === breaker.id; });
              this.model.enter(position, side, target);
              const after = this.value(position) * (side === 'my' ? 1 : -1);
              value = Math.max(value, without + Math.max(0, after - without) * 0.5);
            }
          }
        }
        if (value > score) { score = value; best = mon; }
      }
      return best;
    }

    replacements(state) {
      for (const side of ['my', 'opp']) if (!alive(state.active[side])) {
        const target = this.entry(state, side);
        if (target) this.model.enter(state, side, target);
      }
      return state;
    }

    candidates(state, side) {
      const all = this.model.actions(state, side);
      const best = this.bestHit(state, side);
      const moves = all.filter(function (a) { return a.kind === 'move'; });
      const out = moves.filter(function (a) { return id(a.name) === id(best.name); });
      for (const a of moves) if (id(a.name) === 'trickroom' || U.isPivotMove(a.name) || U.isRecoveryMove(a.name)) {
        if (id(a.name) === 'trickroom' && state.field.trickRoom) continue;
        if (!out.includes(a)) out.push(a);
      }
      if (!out.length && moves.length) out.push(moves[0]);
      const second = moves.filter(function (a) { return !out.includes(a) && !U.getMoveData(a.name)?.isStatus; })[0];
      if (second && side === 'opp') out.push(second);
      const target = this.entry(state, side);
      if (target && !state.field.trickRoom) {
        const action = all.find(function (a) { return a.kind === 'switch' && a.targetId === target.id; });
        if (action && !out.some(function (a) { return U.isPivotMove(a.name); })) out.push(action);
      }
      return out.slice(0, side === 'my' ? 3 : 2);
    }

    key(state, depth) {
      const mon = function (m) { return [m.uid, m.species, Math.round(m.hp * 10), m.status, m.boosts, m.isActive, item(m), ability(m), m.disguiseIntact]; };
      return JSON.stringify([depth, state.turn, state.field, state.myTeam.map(mon), state.oppTeam.map(mon)]);
    }

    search(state, depth) {
      if (depth > 0) {
        for (const side of ['my', 'opp']) if (!alive(state.active[side])) {
          const replacements = state[side + 'Team'].filter(alive);
          if (!replacements.length) return this.value(state);
          const values = [];
          for (const mon of replacements) {
            const next = this.model.clone(state);
            const target = next[side + 'Team'].find(function (m) { return m.uid === mon.uid && m.id === mon.id; });
            this.model.enter(next, side, target);
            values.push(this.search(next, depth));
          }
          return side === 'my' ? Math.max(...values) : Math.min(...values);
        }
      } else state = this.replacements(state);
      if (depth <= 0 || !alive(state.active.my) || !alive(state.active.opp)) return this.value(state);
      if (this.model.nodes >= this.budget || Date.now() > this.deadline) throw this.limit;
      const key = this.key(state, depth);
      if (this.memo.has(key)) return this.memo.get(key);
      const mine = this.candidates(state, 'my'), theirs = this.candidates(state, 'opp');
      if (!mine.length || !theirs.length) return this.value(state);
      let best = -Infinity;
      for (const my of mine) {
        let worst = Infinity;
        for (const opp of theirs) {
          const branches = this.model.resolve(state, my, opp, this.entry.bind(this));
          const score = branches.reduce((sum, b) => sum + b.p * this.search(b.state, depth - 1), 0);
          worst = Math.min(worst, score);
        }
        best = Math.max(best, worst);
      }
      this.memo.set(key, best);
      return best;
    }

    evaluate(state, actions, worlds, engine, opts) {
      opts = opts || {};
      this.memo = new Map(); this.limit = {}; this.model.nodes = 0;
      this.budget = opts.reread ? 6000 : 2200;
      this.deadline = Date.now() + (opts.reread ? 1100 : 450);
      const roots = [];
      const weights = worlds.reduce(function (sum, w) { return sum + (w.weight || 1); }, 0);
      for (const world of worlds) {
        const board = this.model.clone(Object.assign({}, state, { oppTeam: world.team,
          active: { my: state.active.my, opp: engine._oppActive(world, state) } }));
        const replies = engine.getOppActions(world, state);
        const attacks = replies.filter(function (a) { return a.kind === 'move' && !U.getMoveData(a.name)?.isStatus; });
        attacks.sort((a, b) => this.damage.calculateDamage(board.active.opp, board.active.my, b.name, board.field).avgPercent -
          this.damage.calculateDamage(board.active.opp, board.active.my, a.name, board.field).avgPercent);
        const selected = attacks.slice(0, 2);
        for (const action of replies) if (id(action.name) === 'trickroom' || U.isPivotMove(action.name) || U.getMoveData(action.name)?.isProtect) selected.push(action);
        const switching = replies.find(function (a) { return a.kind === 'switch'; });
        if (switching) selected.push(switching);
        if (!selected.length) selected.push({ kind: 'move', name: 'Splash' });
        roots.push({ state: board, replies: selected.slice(0, 5), weight: (world.weight || 1) / weights });
      }
      let completed = null;
      const warnings = new Set();
      const plan = state.battlePlan === 'trickroom' || state.battlePlan === 'auto' && state.myTeam.some(m => this.damage.movesFor(m).some(n => id(n) === 'trickroom')) ? 'trickroom' : 'standard';
      const maxDepth = plan === 'trickroom' ? 3 : 1;
      const rootCache = new Map();
      for (let depth = 0; depth <= maxDepth; depth++) {
        const scores = actions.map(function () { return { mean: 0, worst: 0, replies: [] }; });
        try {
          for (let i = 0; i < actions.length; i++) for (let w = 0; w < roots.length; w++) {
            const root = roots[w];
            let worst = Infinity, sum = 0;
            for (let j = 0; j < root.replies.length; j++) {
              const cacheKey = i + ':' + w + ':' + j;
              let branches = rootCache.get(cacheKey);
              if (!branches) {
                if (state.legalActions.forceSwitch) {
                  const board = this.model.clone(root.state), target = this.model.target(board, 'my', actions[i]);
                  if (target) this.model.enter(board, 'my', target);
                  branches = [{ state: board, p: 1 }];
                } else branches = this.model.resolve(root.state, actions[i], root.replies[j], this.entry.bind(this));
                rootCache.set(cacheKey, branches);
              }
              const value = branches.reduce((total, b) => {
                for (const warning of b.state.modelWarnings) warnings.add(warning);
                return total + b.p * this.search(this.model.clone(b.state), depth);
              }, 0);
              worst = Math.min(worst, value); sum += value;
              scores[i].replies.push({ name: root.replies[j].name, score: U.round1(value), weight: root.weight });
            }
            scores[i].mean += root.weight * sum / root.replies.length;
            scores[i].worst += root.weight * worst;
          }
          completed = { depth: depth + 1, scores: scores };
        } catch (e) { if (e !== this.limit) throw e; break; }
      }
      return { plan: plan, completed: completed, nodes: this.model.nodes, warnings: Array.from(warnings),
        limited: !completed || completed.depth < maxDepth + 1, proven: false,
        assumptions: 'Selective replies, grouped damage rolls, and heuristic pivot choices. Ordinary critical hits and random secondary effects are omitted. Unsupported status effects are flagged.' };
    }
  }
  ST.TacticalSearch = TacticalSearch;
})();
