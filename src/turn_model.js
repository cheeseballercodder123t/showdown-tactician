(function () {
  'use strict';
  const ST = window.ST = window.ST || {};
  const U = ST.util;
  const id = U.toID;
  const alive = function (m) { return m && !m.fainted && m.hp > 0; };
  const ability = function (m) { return id(m.activeAbility || m.revealedAbility || m.ability); };
  const item = function (m) { return m.itemRemoved || m.itemConsumed ? '' : id(m.item || m.currentBattleItem || m.confirmedItem); };
  const setting = function (key, fallback) { return ST.configGet ? ST.configGet('tactical.' + key, fallback) : fallback; };

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
      if (outgoing) { outgoing.choiceLocked = false; outgoing.choiceLockedMove = null; }
      if (outgoing) outgoing.isActive = false;
      target.isActive = true; target.boosts = {}; target.volatiles = {}; target.abilityOn = false;
      target.boosterActive = false; target.boostedStat = null; target.switchedInTurn = state.turn;
      target.activeStintMoves = []; target.hasActedSinceEntry = false;
      target.choiceLocked = false; target.choiceLockedMove = null;
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
            const moveId = id(action.name);
            if (typeof mon.movePP?.[moveId] === 'number') mon.movePP = Object.assign({}, mon.movePP, { [moveId]: Math.max(0, mon.movePP[moveId] - 1) });
            if (U.isChoiceItem(item(mon))) { mon.choiceLocked = true; mon.choiceLockedMove = moveId; }
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

  class TeamPlan {
    constructor(damage, model, state) {
      this.model = model;
      this.damage = damage;
      this.matchups = new Map();
      this.speeds = new Map();
      this.positions = new Map();
      for (const side of ['my', 'opp']) for (const mon of state[side + 'Team'].filter(alive)) {
        for (const foe of state[(side === 'my' ? 'opp' : 'my') + 'Team'].filter(alive)) {
          let best = { name: '', damage: 0, min: 0, max: 0 };
          for (const name of damage.movesFor(mon, 4)) {
            if (U.getMoveData(name)?.isStatus || ['futuresight', 'doomdesire'].includes(id(name))) continue;
            if (mon.movePP?.[id(name)] === 0 || mon.choiceLocked && id(name) !== id(mon.choiceLockedMove)) continue;
            const hit = damage.calculateDamage(mon, foe, name, state.field);
            if (hit && !hit.failed && hit.avgPercent > best.damage) best = {
              name: name, damage: hit.avgPercent, min: hit.minPercent, max: hit.maxPercent
            };
          }
          this.matchups.set(this.key(mon, foe), best);
        }
      }
    }

    key(mon, foe) { return (mon.uid || mon.side + ':' + mon.id) + '>' + (foe.uid || foe.side + ':' + foe.id); }
    hit(mon, foe) { return this.matchups.get(this.key(mon, foe)) || { name: '', damage: 0, min: 0, max: 0 }; }

    speed(state, mon) {
      const key = [mon.uid, mon.boosts?.spe || 0, mon.status, item(mon), ability(mon), mon.boosterActive, mon.boostedStat,
        mon.unburdenActive, state.field.weather, state.field.terrain, state.field.tailwind?.[mon.side]].join(':');
      if (!this.speeds.has(key)) this.speeds.set(key, this.model.speed(mon, state));
      return this.speeds.get(key);
    }

    answer(state, mon, foe) {
      if (!alive(mon) || !alive(foe)) return 0;
      const outgoing = this.hit(mon, foe), incoming = this.hit(foe, mon);
      if (!outgoing.damage) return 0;
      const hazards = state.field.hazards?.[mon.side] || {};
      const hp = mon.hp - (mon.isActive ? 0 : U.hazardPercent(mon.species, item(mon), ability(mon), hazards));
      if (hp <= 0) return 0;
      const priority = U.movePriority(outgoing.name) - U.movePriority(incoming.name || 'Splash');
      const speed = priority ? 0 : this.speed(state, mon) - this.speed(state, foe);
      const first = priority ? priority > 0 : speed ? (state.field.trickRoom ? speed < 0 : speed > 0) : null;
      const hitsNeeded = Math.ceil(foe.hp / Math.max(1, outgoing.min));
      const hitsSurvived = incoming.max > 0 ? Math.max(0, Math.ceil(hp / incoming.max) - 1) : 4;
      const attacks = hitsSurvived + (first === null ? 0.5 : first ? 1 : 0);
      return U.clamp(attacks / Math.max(1, hitsNeeded), 0, 1);
    }

    coverage(state, side) {
      const mine = state[side + 'Team'].filter(alive), foes = state[(side === 'my' ? 'opp' : 'my') + 'Team'].filter(alive);
      let score = 0;
      for (const foe of foes) {
        const answers = mine.map(mon => this.answer(state, mon, foe)).sort((a, b) => b - a);
        score += setting('coverage', 55) * ((answers[0] || 0) + setting('redundantAnswer', 0.2) * (answers[1] || 0));
      }
      return score;
    }

    roomAccess(state, side) {
      if (state.field.trickRoom) return 0;
      const mine = state[side + 'Team'].filter(alive), foes = state[(side === 'my' ? 'opp' : 'my') + 'Team'].filter(alive);
      const activeFoe = state.active[side === 'my' ? 'opp' : 'my'];
      const setters = mine.filter(mon => !['slp', 'frz'].includes(mon.status) && !mon.volatiles?.taunt &&
        mon.movePP?.trickroom !== 0 && (!mon.choiceLocked || id(mon.choiceLockedMove) === 'trickroom') &&
        this.damage.movesFor(mon, 4).some(name => id(name) === 'trickroom'));
      if (!setters.length || !alive(activeFoe)) return 0;
      const safe = setters.some(mon => mon.hp - (mon.isActive ? 0 : U.hazardPercent(mon.species, item(mon), ability(mon), state.field.hazards?.[mon.side] || {})) > this.hit(activeFoe, mon).max);
      if (!safe) return 0;
      const room = Object.assign({}, state, { field: Object.assign({}, state.field, { trickRoom: true }) });
      let benefit = 0;
      for (const foe of foes) {
        const normal = Math.max(...mine.map(mon => this.answer(state, mon, foe)));
        const reversed = Math.max(...mine.map(mon => this.answer(room, mon, foe)));
        benefit += Math.max(0, reversed - normal);
      }
      return setting('roomAccess', 45) * benefit / Math.max(1, foes.length);
    }

    position(state) {
      const mon = m => [m.uid, m.hp, m.isActive, m.status, m.boosts?.spe, item(m), ability(m), m.boostedStat,
        m.boosterActive, m.unburdenActive, m.volatiles?.taunt, m.choiceLocked, m.choiceLockedMove, m.movePP?.trickroom];
      const key = JSON.stringify([state.field.trickRoom, state.field.weather, state.field.terrain, state.field.hazards, state.field.tailwind,
        state.myTeam.map(mon), state.oppTeam.map(mon), setting('coverage', 55), setting('roomAccess', 45), setting('redundantAnswer', 0.2)]);
      if (!this.positions.has(key)) this.positions.set(key, this.coverage(state, 'my') - this.coverage(state, 'opp') +
        this.roomAccess(state, 'my') - this.roomAccess(state, 'opp'));
      return this.positions.get(key);
    }

    report(state) {
      const mine = state.myTeam.filter(alive), foes = state.oppTeam.filter(alive);
      const roles = mine.map(mon => {
        const moves = this.damage.movesFor(mon, 4);
        const labels = [];
        if (moves.some(name => id(name) === 'trickroom')) labels.push('Trick Room setter');
        if (moves.some(name => U.isPivotMove(name))) labels.push('Pivot');
        const pressure = foes.reduce((sum, foe) => sum + Math.min(100, this.hit(mon, foe).damage), 0) / Math.max(1, foes.length);
        if (pressure >= setting('breakerPressure', 45)) labels.push('Breaker');
        const targets = foes.filter(foe => this.hit(mon, foe).min >= foe.hp && this.answer(state, mon, foe) >= 1);
        if (targets.length) labels.push('Cleaner against ' + targets.map(m => m.species).join(', '));
        return { uid: mon.uid, species: mon.species, roles: labels.length ? labels : ['Support / coverage'], pressure: U.round1(pressure) };
      });
      const threats = foes.map(foe => {
        const answers = mine.filter(mon => this.answer(state, mon, foe) >= 1);
        return { species: foe.species, answers: answers.map(mon => mon.species), answerUids: answers.map(mon => mon.uid),
          warning: answers.length === 1 ? 'Preserve ' + answers[0].species + ' for ' + foe.species + '.' : answers.length ? '' : 'No safe direct answer to ' + foe.species + ' in this sampled set.' };
      });
      const setters = roles.filter(row => row.roles.includes('Trick Room setter')).map(row => row.species);
      return { roles: roles, threats: threats, setters: setters, room: this.room(state),
        basis: 'Direct matchup estimates for sampled sets; switching, setup, and double switches still require the turn search.' };
    }

    room(state) {
      if (!state.field.trickRoom) return { turns: 0, attacksNow: 0, attacksAfterEntry: 0, text: 'Trick Room inactive.' };
      const turns = Math.max(0, state.field.trickRoomTurnsLeft || 0);
      const active = state.active.my, foe = state.active.opp;
      const hit = active && foe ? this.hit(active, foe) : { damage: 0 };
      return { turns: turns, attacksNow: hit.damage > 0 ? turns : 0, attacksAfterEntry: Math.max(0, turns - 1),
        text: turns + ' room turn' + (turns === 1 ? '' : 's') + ' left; switching or pivoting leaves ' + Math.max(0, turns - 1) + ' attacking turn' + (turns === 2 ? '' : 's') + ' at most.' };
    }
  }
  ST.TeamPlan = TeamPlan;

  class TacticalSearch {
    constructor(damage) { this.model = new TurnModel(damage); this.damage = damage; }

    value(state) {
      const totals = {};
      for (const side of ['my', 'opp']) totals[side] = (state[side + 'Team'] || []).reduce(function (sum, m) {
        return sum + (alive(m) ? 180 + m.hp : 0);
      }, 0);
      if (!totals.my || !totals.opp) return !totals.my && !totals.opp ? 0 : (totals.my ? 10000 : -10000) + 0.01 * (totals.my - totals.opp);
      let score = totals.my - totals.opp;
      if (state._teamPlan) score += state._teamPlan.position(state);
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
      let bestScore = -Infinity;
      if (!alive(me) || !alive(foe)) return best;
      for (const name of this.damage.movesFor(me, 4)) {
        const data = U.getMoveData(name);
        if (!data || data.isStatus || ['futuresight', 'doomdesire'].includes(id(name))) continue;
        if (me.movePP?.[id(name)] === 0 || me.choiceLocked && id(name) !== id(me.choiceLockedMove)) continue;
        if (U.firstTurnOnly(id(name)) && (me.hasActedSinceEntry || me.activeStintMoves?.length)) continue;
        const result = this.damage.calculateDamage(me, foe, name, state.field);
        if (result && !result.failed) {
          const score = Math.min(foe.hp, result.avgPercent) + (U.movePriority(name) > 0 && result.minPercent >= foe.hp ? setting('priorityFinish', 50) : 0) + result.avgPercent * setting('damageTieBreak', 0.001);
          if (score > bestScore) { bestScore = score; best = { name: name, damage: result.avgPercent }; }
        }
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
      for (const a of moves) if (id(a.name) === 'trickroom' || U.isPivotMove(a.name) || U.isRecoveryMove(a.name) || U.getMoveData(a.name)?.isProtect) {
        if (id(a.name) === 'trickroom' && state.field.trickRoom) continue;
        if (U.isRecoveryMove(a.name) && state.active[side].hp >= 90) continue;
        if (!out.includes(a)) out.push(a);
      }
      if (!out.length && moves.length) out.push(moves[0]);
      const second = moves.filter(function (a) { return !out.includes(a) && !U.getMoveData(a.name)?.isStatus; })[0];
      if (second && side === 'opp') out.push(second);
      const target = this.entry(state, side);
      if (target) {
        const action = all.find(function (a) { return a.kind === 'switch' && a.targetId === target.id; });
        if (action && !out.some(function (a) { return U.isPivotMove(a.name); })) out.push(action);
      }
      const setup = moves.find(a => U.getMoveData(a.name)?.isSetup && !out.includes(a));
      if (setup) out.push(setup);
      return out.slice(0, side === 'my' ? setting('myCandidates', 3) : setting('oppCandidates', 2));
    }

    key(state, depth) {
      const mon = function (m) { return [m.uid, m.species, m.hp, m.status, m.boosts, m.volatiles,
        m.isActive, item(m), ability(m), m.disguiseIntact, m.hasActedSinceEntry, m.choiceLocked, m.choiceLockedMove, m.movePP, m.toxicCounter]; };
      return JSON.stringify([depth, state._worldSignature, state.turn, state.field, state.protect, state.myTeam.map(mon), state.oppTeam.map(mon)]);
    }

    search(state, depth) {
      for (const warning of state.modelWarnings || []) this.warnings.add(warning);
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
      worlds = worlds.filter(w => w.weight === undefined || w.weight > 0);
      if (!worlds.length) return { plan: 'standard', completed: null, nodes: 0, warnings: ['No weighted set combinations available'], limited: true, proven: false };
      this.memo = new Map(); this.limit = {}; this.model.nodes = 0;
      this.warnings = new Set();
      this.budget = opts.reread ? 6000 : 2200;
      this.deadline = Date.now() + (opts.reread ? 1100 : 450);
      const roots = [];
      const weights = worlds.reduce(function (sum, w) { return sum + (w.weight || 1); }, 0);
      for (const world of worlds) {
        const board = this.model.clone(Object.assign({}, state, { oppTeam: world.team,
          active: { my: state.active.my, opp: engine._oppActive(world, state) } }));
        board._teamPlan = new TeamPlan(this.damage, this.model, board);
        const replies = state.legalActions.forceSwitch ? [{ kind: 'replacement', name: 'Opponent replacement / next position' }] : engine.getOppActions(world, state);
        const attacks = replies.filter(function (a) { return a.kind === 'move' && !U.getMoveData(a.name)?.isStatus; });
        attacks.sort((a, b) => this.damage.calculateDamage(board.active.opp, board.active.my, b.name, board.field).avgPercent -
          this.damage.calculateDamage(board.active.opp, board.active.my, a.name, board.field).avgPercent);
        const selected = attacks.slice(0, 2);
        for (const action of attacks) if (U.movePriority(action.name) > 0 && !selected.includes(action)) selected.push(action);
        for (const action of replies) if (!selected.includes(action) && (id(action.name) === 'trickroom' || U.isPivotMove(action.name) || U.getMoveData(action.name)?.isProtect ||
          U.getMoveData(action.name)?.isSetup || U.isRecoveryMove(action.name) && board.active.opp.hp < 90)) selected.push(action);
        const switches = replies.filter(function (a) { return a.kind === 'switch'; });
        switches.sort((a, b) => {
          const rank = action => {
            const target = this.model.target(board, 'opp', action);
            if (!target) return -Infinity;
            return this.damage.movesFor(board.active.my, 4).reduce((sum, name) => {
              if (U.getMoveData(name)?.isStatus) return sum;
              const hit = this.damage.calculateDamage(board.active.my, target, name, board.field);
              return sum - (hit && !hit.failed ? hit.avgPercent : 0);
            }, 0);
          };
          return rank(b) - rank(a);
        });
        if (switches.length) selected.push(switches[0]);
        if (!selected.length) selected.push({ kind: 'move', name: 'Splash' });
        const signature = JSON.stringify(world.team.map(mon => [mon.species, item(mon), ability(mon), mon.nature, mon.evs, mon.ivs, this.damage.movesFor(mon, 4)]));
        board._worldSignature = signature;
        roots.push({ state: board, replies: selected.slice(0, setting('rootReplies', 6)), weight: (world.weight || 1) / weights, signature: signature });
      }
      let completed = null;
      const plan = state.battlePlan === 'trickroom' || state.battlePlan === 'auto' && state.myTeam.some(m => this.damage.movesFor(m).some(n => id(n) === 'trickroom')) ? 'trickroom' : 'standard';
      const maxDepth = plan === 'trickroom' ? 3 : 1;
      const rootCache = new Map();
      for (let depth = 0; depth <= maxDepth; depth++) {
        const scores = actions.map(function () { return { mean: 0, worst: 0, replies: [], worlds: [] }; });
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
                return total + b.p * this.search(this.model.clone(b.state), depth);
              }, 0);
              worst = Math.min(worst, value); sum += value;
              const faintChance = branches.reduce((p, branch) => {
                const original = branch.state.myTeam.find(m => m.uid === state.active.my.uid && m.id === state.active.my.id);
                return p + (original && !alive(original) ? branch.p : 0);
              }, 0);
              const ownHP = branches.reduce((sum, branch) => sum + branch.p * branch.state.myTeam.reduce((hp, m) => hp + (alive(m) ? m.hp : 0), 0), 0);
              const roomChance = branches.reduce((p, branch) => p + (branch.state.field.trickRoom ? branch.p : 0), 0);
              scores[i].replies.push({ name: root.replies[j].name, kind: root.replies[j].kind, score: U.round1(value), weight: root.weight,
                faintChance: faintChance, ownHP: U.round1(ownHP), roomChance: roomChance });
            }
            scores[i].mean += root.weight * sum / root.replies.length;
            scores[i].worst += root.weight * worst;
            scores[i].worlds.push({ worst: worst, mean: sum / root.replies.length, weight: root.weight, index: w, signature: root.signature });
          }
          this.compareWorlds(scores);
          completed = { depth: depth + 1, scores: scores };
        } catch (e) { if (e !== this.limit) throw e; break; }
      }
      const teamPlans = roots.map(root => ({ weight: root.weight, report: root.state._teamPlan.report(root.state) }));
      return { plan: plan, completed: completed, nodes: this.model.nodes, warnings: Array.from(this.warnings), teamPlans: teamPlans,
        limited: !completed || completed.depth < maxDepth + 1, proven: false,
        assumptions: 'Selective replies, grouped damage rolls, and heuristic pivot choices. Team preservation uses direct matchup estimates from the starting sets. Ordinary critical hits and random secondary effects are omitted. Unsupported status effects are flagged.' };
    }

    compareWorlds(scores) {
      if (!scores.length) return;
      const count = scores[0].worlds.length;
      const distinct = new Set(scores[0].worlds.map((world, i) => world.signature || 'world' + i)).size;
      const best = Array.from({ length: count }, (_, i) => Math.max(...scores.map(row => row.worlds[i].worst)));
      for (const row of scores) {
        row.regret = 0; row.closeWorldWeight = 0;
        for (let i = 0; i < count; i++) {
          const gap = best[i] - row.worlds[i].worst;
          row.regret += gap * row.worlds[i].weight;
          if (gap <= setting('closeGap', 15)) row.closeWorldWeight += row.worlds[i].weight;
        }
        const fraction = setting('tailFraction', 0.25);
        let remaining = fraction, tail = 0;
        for (const world of row.worlds.slice().sort((a, b) => a.worst - b.worst)) {
          const weight = Math.min(remaining, world.weight);
          tail += weight * world.worst; remaining -= weight;
          if (remaining <= 1e-9) break;
        }
        row.tailScore = tail / fraction;
        row.robustScore = setting('scoreBlend.worst', 0.5) * row.worst + setting('scoreBlend.mean', 0.25) * row.mean +
          setting('scoreBlend.tail', 0.25) * row.tailScore - setting('regretPenalty', 0.12) * row.regret;
        row.stability = distinct < 2 ? 'Only one set combination tested' : row.closeWorldWeight >= 1 - 1e-9
          ? 'Consistent across sampled sets' : row.closeWorldWeight <= 1e-9 ? 'Lower rated across sampled sets'
            : row.closeWorldWeight >= setting('consistentShare', 0.7) ? 'Usually competitive across sampled sets' : 'Depends on the opposing set';
      }
    }
  }
  ST.TacticalSearch = TacticalSearch;
})();
