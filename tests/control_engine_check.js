const fs=require('fs'),H=require('../tests/harness'),S=H.loadAll(),ST=S.ST;
let passed=0;const failures=[];
function check(name,value){if(value){passed++;console.log('PASS '+name);}else{failures.push(name);console.log('FAIL '+name);}}
function eq(name,a,b){check(name,JSON.stringify(a)===JSON.stringify(b));}
function pipe(){const parser=new ST.ProtocolParser(),manager=new ST.BattleStateManager();manager.attachParser(parser);return{parser,manager,feed:line=>parser.feed(line)};}
function request(side,pokemon,moves){return '|request|'+JSON.stringify({rqid:1,side:{id:side,pokemon},active:[{moves:(moves||['Tackle']).map(name=>({move:name,id:ST.util.toID(name),pp:10}))}]});}
function member(side,species,active,condition='100/100',moves=['Tackle']){return{ident:side+': '+species,details:species,active,condition,moves};}
for(const mine of ['p1','p2']){
 const foe=mine==='p1'?'p2':'p1',p=pipe();
 p.manager.registerMyTeam([{species:'Hatterene',nature:'Quiet',evs:{spa:252},ivs:{spe:0},moves:['Trick Room','Mystical Fire','Psyshock','Dazzling Gleam']}]);
 p.feed('|init|battle');p.feed('|poke|'+foe+'|Urshifu-Rapid-Strike|item');p.feed('|poke|'+mine+'|Hatterene|item');
 p.feed('|switch|'+foe+'a: Tiki tiki tiki|Urshifu-Rapid-Strike|100/100');p.feed('|switch|'+mine+'a: Hatterene|Hatterene|100/100');
 p.feed(request(mine,[member(mine,'Hatterene',true)],['Trick Room','Mystical Fire','Psyshock','Dazzling Gleam']));
 eq(mine+' owns only its request roster',p.manager.state.myTeam.map(m=>m.species),['Hatterene']);
 eq(mine+' opponent roster remains separate',p.manager.state.oppTeam.map(m=>m.species),['Urshifu-Rapid-Strike']);
 eq(mine+' correct active',p.manager.state.active.my.species,'Hatterene');
 eq(mine+' imported stats match after identity resolution',p.manager.state.myTeam[0].nature,'Quiet');
 p.feed('|-damage|'+foe+'a: Tiki tiki tiki|61.25/100');
 eq(mine+' decimal HP updates opponent',p.manager.state.active.opp.hp,61.25);
 p.feed('|-heal|'+foe+'a: Tiki tiki tiki|67.5/100');
 eq(mine+' decimal healing updates opponent',p.manager.state.active.opp.hp,67.5);
 check(mine+' protocol side canonical',p.manager.state.sides[foe].team===p.manager.state.oppTeam);
 const snap=p.manager.snapshot();check(mine+' snapshot active shares its roster identity',snap.myTeam.includes(snap.active.my));
 p.feed('|faint|'+foe+'a: Tiki tiki tiki');eq(mine+' faint clears HP',p.manager.state.oppTeam[0].hpPercent,0);
}
{
 const p=pipe();p.manager.registerMyTeam([{species:'Pikachu',evs:{atk:252},moves:['Thunderbolt']}]);
 p.feed('|poke|p1|Steelix|item');p.feed('|poke|p2|Slowking-Galar|item');
 p.feed('|switch|p1a: Jaimito|Steelix|100/100');p.feed('|switch|p2a: Tarot-Reader|Slowking-Galar|100/100');
 p.feed(request('p2',[member('p2','Slowking-Galar',true,'351/394',['Trick Room','Chilly Reception'])],['Trick Room','Chilly Reception']));
 eq('mismatched paste never appears on enemy roster',p.manager.state.oppTeam.map(m=>m.species),['Steelix']);
 check('mismatched paste is labeled',p.manager.state.teamImportMatches===false);
 check('own exact HP retained',p.manager.state.active.my.exactHP===351&&p.manager.state.active.my.exactMaxHP===394);
 p.feed('|-damage|p2a: Tarot-Reader|300/394');eq('raw HP retained on a damage event',p.manager.state.active.my.exactHP,300);
}
const damage=new ST.DamageEngine();
function mon(species,side,moves,extra={}){return Object.assign({id:ST.util.toID(species),uid:side+':'+species,species,side,level:100,hp:100,hpPercent:100,isActive:true,boosts:{},volatiles:{},setMoves:moves,evs:{},ivs:{spe:31},nature:'Serious'},extra);}
function board(me,foe,mine=[],theirs=[],field={}){return{mySide:me.side,oppSide:foe.side,turn:1,revision:1,ownershipResolved:true,battlePlan:'trickroom',active:{my:me,opp:foe},myTeam:[me,...mine],oppTeam:[foe,...theirs],field:Object.assign({trickRoom:false,weather:'',hazards:{p1:{},p2:{}}},field),legalActions:{moves:me.setMoves.map(n=>({name:n,id:ST.util.toID(n),pp:10})),switches:mine.map(m=>({name:m.species,id:m.id})),forceSwitch:false}};}
const move=name=>({kind:'move',name});
const model=new ST.TurnModel(damage);
{
 const hat=mon('Hatterene','p2',['Trick Room','Dazzling Gleam'],{ivs:{spe:0},nature:'Quiet'}),foe=mon('Mew','p1',['Tackle']);
 const state=board(hat,foe),before=JSON.stringify(state);
 const result=model.resolve(state,move('Trick Room'),move('Tackle'),()=>null);
 check('Trick Room creates a field effect',result.every(b=>b.state.field.trickRoom));
 check('setup turn consumes one of five turns',result.every(b=>b.state.field.trickRoomTurnsLeft===4));
 eq('simulation never changes live state',JSON.stringify(state),before);
 const next=result[0].state;
 eq('move order reverses next turn',model.order(next,move('Dazzling Gleam'),move('Tackle'))[0],'my');
 const canceled=model.resolve(next,move('Trick Room'),move('Tackle'),()=>null);
 check('using Trick Room again cancels it',canceled.every(b=>!b.state.field.trickRoom));
 const unsafe=board(mon('Hatterene','p2',['Trick Room'],{hp:1,hpPercent:1}),mon('Garchomp','p1',['Earthquake']));
 check('a fainted setter cannot establish Trick Room',model.resolve(unsafe,move('Trick Room'),move('Earthquake'),()=>null).every(b=>!b.state.field.trickRoom));
}
{
 const slow=mon('Slowking-Galar','p2',['Chilly Reception'],{ability:'Regenerator',hp:72,hpPercent:72}),bear=mon('Ursaluna','p2',['Facade'],{isActive:false});
 const foe=mon('Steelix-Mega','p1',['Curse']); const state=board(slow,foe,[bear],[],{trickRoom:true,trickRoomTurnsLeft:4});
 const branches=model.resolve(state,move('Chilly Reception'),move('Curse'),(st,side)=>side==='my'?st.myTeam[1]:null);
 check('Chilly Reception brings in the breaker',branches.every(b=>b.state.active.my.species==='Ursaluna'));
 check('Regenerator heals the outgoing body',branches.every(b=>b.state.myTeam[0].hp===100));
 check('Chilly Reception establishes snow',branches.every(b=>b.state.field.weather==='snow'));
 check('Curse still resolves after the pivot',branches.every(b=>b.state.active.opp.boosts.def===1));
 check('pivot consumes a Trick Room turn',branches.every(b=>b.state.field.trickRoomTurnsLeft===3));
}
{
 const hat=mon('Hatterene','p2',['Mystical Fire','Psyshock','Dazzling Gleam'],{evs:{spa:252},nature:'Quiet'}),chomp=mon('Garchomp','p1',['Earthquake']);
 const fire=damage.calculateDamage(hat,chomp,'Mystical Fire',{}),gleam=damage.calculateDamage(hat,chomp,'Dazzling Gleam',{});
 check('Dazzling Gleam outdamages Mystical Fire into Garchomp',gleam.minPercent>fire.maxPercent);
 const steel=mon('Steelix-Mega','p1',['Earthquake']);
 check('Mystical Fire is useful against Mega Steelix in the pasted log',damage.calculateDamage(hat,steel,'Mystical Fire',{}).minPercent>fire.maxPercent);
 const result=model.resolve(board(hat,chomp),move('Mystical Fire'),move('Earthquake'),()=>null);
 check('Mystical Fire applies its Special Attack drop',result.some(b=>b.state.active.opp.boosts.spa===-1));
}
{
 const a=mon('Mew','p1',['Body Slam'],{requestStats:{atk:400,def:220,spa:220,spd:220,spe:250},exactMaxHP:404,exactHP:351}),d=mon('Glaceon','p2',['Ice Beam']);
 const known=damage.calculateDamage(a,d,'Body Slam',{}),normal=damage.calculateDamage(Object.assign({},a,{requestStats:null} ),d,'Body Slam',{});
 check('request Attack changes real library damage',known.minPercent>normal.maxPercent);
 const changed=damage.calculateDamage(Object.assign({},a,{requestStats:Object.assign({},a.requestStats,{atk:200})}),d,'Body Slam',{});
 check('cache distinguishes request stats',changed.maxPercent<known.maxPercent);
 const snow=damage.calculateDamage(a,d,'Body Slam',{weather:'snow'});
 check('snow reduces damage against Ice physical defense',snow.maxPercent<known.minPercent);
 eq('request Speed is authoritative',ST.util.computeSpeed(a,{}).raw,250);
 eq('paralysis halves effective Speed',ST.util.computeSpeed(Object.assign({},a,{status:'par'}),{}).effective,125);
}
{
 const p=pipe();
 for(const line of fs.readFileSync('tests/fixtures/gersonion-efgbbd-reconstruction.log','utf8').split(/\r?\n/).filter(l=>l.startsWith('|')))p.feed(line);
 const st=p.manager.state;
 eq('pasted battle replay ends with six revealed opponents',st.oppTeam.length,6);
 eq('pasted battle final Kingambit is fainted',st.oppTeam.find(m=>m.rosterSpecies==='Kingambit').hpPercent,0);
 eq('pasted battle faint count reaches five allies before Kingambit',st.oppTeam.find(m=>m.rosterSpecies==='Kingambit').alliesFainted,5);
 eq('pasted battle Hatterene remains fainted after replacement',st.oppTeam.find(m=>m.rosterSpecies==='Hatterene').hpPercent,0);
 check('pasted battle final Trick Room is still live',st.field.trickRoom);
 eq('pasted battle final Trick Room has one turn left',st.field.trickRoomTurnsLeft,1);
}

function engineFor(state){return new ST.LaplaceEngine({damage,sampler:{sampleWorlds:()=>[{team:state.oppTeam,weight:1}]}});}
{
 const slow=mon('Slowking-Galar','p2',['Trick Room','Chilly Reception','Psychic','Future Sight'],{ability:'Regenerator',evs:{hp:252},ivs:{spe:0},nature:'Quiet'});
 const bear=mon('Ursaluna','p2',['Facade','Headlong Rush'],{isActive:false,ability:'Guts',status:'brn',nature:'Brave',evs:{hp:252,atk:252},ivs:{spe:0}});
 const foe=mon('Tyranitar','p1',['Tackle'],{nature:'Jolly',evs:{spe:252,atk:252}});
 const state=board(slow,foe,[bear],[mon('Garchomp','p1',['Earthquake'],{isActive:false}),mon('Urshifu-Rapid-Strike','p1',['Surging Strikes'],{isActive:false})]);
 const engine=engineFor(state),ranked=engine.evaluateTurn(state,{reread:true});
 eq('favorable setup outranks Chilly Reception and attacks',ranked[0].name,'Trick Room');
 check('setup search completes the breaker horizon',engine.lastReadout.tactical.completed.depth>=3);
 check('selective search never claims a proof',engine.lastReadout.endgame.isMate===false);
 const unsafe=board(mon('Hatterene','p2',['Trick Room','Dazzling Gleam'],{hp:1,hpPercent:1,evs:{spa:252}}),mon('Garchomp','p1',['Earthquake']),[bear],[mon('Mew','p1',['Recover'],{isActive:false})]);
 const unsafeRank=engineFor(unsafe).evaluateTurn(unsafe,{reread:true});
 check('unsafe setup loses to a legal escape',unsafeRank.findIndex(a=>a.name==='Trick Room')>0);
}
{
 const exhausted=mon('Abomasnow','p2',['Ice Shard'],{hp:1,hpPercent:1,evs:{hp:252},ivs:{spe:0},nature:'Quiet'});
 const setter=mon('Slowking-Galar','p2',['Trick Room','Psychic'],{isActive:false,evs:{hp:252,def:252},nature:'Relaxed',ivs:{spe:0},ability:'Regenerator'});
 const bear=mon('Ursaluna','p2',['Facade','Headlong Rush'],{isActive:false,status:'brn',ability:'Guts',evs:{hp:252,atk:252},nature:'Brave',ivs:{spe:0}});
 const foe=mon('Garchomp','p1',['Earthquake'],{evs:{atk:252,spe:252},nature:'Jolly'});
 const state=board(exhausted,foe,[setter,bear],[mon('Zeraora','p1',['Close Combat'],{isActive:false,evs:{atk:252,spe:252},nature:'Jolly'})]);
 const engine=engineFor(state),ranked=engine.evaluateTurn(state,{reread:true});
 eq('chip then sacrifice beats hard-switching the setter',ranked[0].name,'Ice Shard');
 check('sacrifice comparison includes a setter replacement',ranked[0].score>ranked.find(a=>a.name==='Slowking-Galar').score);
}
{
 const hat=mon('Hatterene','p2',['Mystical Fire','Psyshock','Dazzling Gleam'],{evs:{spa:252},nature:'Quiet'});
 const chomp=mon('Garchomp','p1',['Earthquake']);
 const state=board(hat,chomp,[],[mon('Tyranitar','p1',['Crunch'],{isActive:false}),mon('Urshifu-Rapid-Strike','p1',['Surging Strikes'],{isActive:false})]);
 state.battlePlan='standard';
 const ranked=engineFor(state).evaluateTurn(state,{reread:true});
 check('Garchomp coverage outranks weak Mystical Fire',ranked.findIndex(a=>a.name==='Dazzling Gleam')<ranked.findIndex(a=>a.name==='Mystical Fire'));
 check('all actions expose score comparisons',ranked.every(a=>a.comparison&&typeof a.scoreGap==='number'));
}

{
 const me=mon('Great Tusk','p2',['Headlong Rush','Ice Spinner'],{evs:{atk:252}}),foe=mon('Landorus-Therian','p1',['Earthquake']);
 const ranked=engineFor(board(me,foe)).evaluateTurn(board(me,foe),{reread:true});
 check('known type immunity remains vetoed in the live search',ranked.find(a=>a.name==='Headlong Rush').isVetoed);
 eq('coverage beats an immune move even in a losing search',ranked[0].name,'Ice Spinner');
}
{
 const state=board(mon('Mew','p1',['Focus Blast']),mon('Blissey','p2',['Splash']));
 state.moveAccuracy={focusblast:70};
 const branches=model.resolve(state,move('Focus Blast'),move('Splash'),()=>null);
 const miss=branches.filter(b=>b.state.active.opp.hp===100).reduce((sum,b)=>sum+b.p,0);
 check('accuracy misses are explicit turn branches',Math.abs(miss-0.3)<1e-9);
 check('turn branch probabilities sum to one',Math.abs(branches.reduce((sum,b)=>sum+b.p,0)-1)<1e-9);
 const protectedState=board(mon('Mew','p1',['Protect']),mon('Garchomp','p2',['Earthquake']));
 protectedState.protect={myConsecutiveProtects:1};
 const shields=model.resolve(protectedState,move('Protect'),move('Earthquake'),()=>null);
 const protectedChance=shields.filter(b=>b.state.active.my.hp===100).reduce((sum,b)=>sum+b.p,0);
 check('consecutive Protect has a chance rather than a guaranteed block',Math.abs(protectedChance-1/3)<1e-9);
}
{
 const p=pipe();p.feed('|switch|p1a: Hatterene|Hatterene|100/100');
 p.feed('|move|p1a: Hatterene|Trick Room|p1a: Hatterene');
 check('an attempted Trick Room does not invent a field effect',p.manager.state.field.trickRoom===false);
 p.feed('|-fieldstart|move: Trick Room');
 check('only the observed effect activates Trick Room',p.manager.state.field.trickRoom===true);
}

{
 const dragon=mon('Dragonite','p2',['Dragon Claw'],{ability:'Multiscale',requestStats:{atk:304,def:226,spa:236,spd:236,spe:196},exactMaxHP:386,exactHP:386});
 const desc=damage._describe(dragon,'defender',{}),pk=damage._buildPokemon(desc,{});
 eq('calculator clones preserve exact current HP above the assumed spread',pk.clone().originalCurHP,386);
 const attacker=mon('Mew','p1',['Ice Beam']);
 const full=damage.calculateDamage(attacker,dragon,'Ice Beam',{});
 const chipped=damage.calculateDamage(attacker,Object.assign({},dragon,{exactHP:385,hpPercent:385/386*100}),'Ice Beam',{});
 check('full-health Multiscale survives request-stat cloning',full.maxDmg*1.9<chipped.maxDmg);
 eq('explicit absolute HP overrides the current request HP',damage._buildPokemon(desc,{defenderHP:250}).originalCurHP,250);
}

{
 const p=pipe();p.manager.registerMyTeam([{species:'Mew',nature:'Adamant',evs:{atk:252},moves:['Earthquake']}]);
 p.feed('|switch|p1a: Mew|Mew|100/100');
 const roster=member('p1','Mew',true,'404/404',['psychic']);
 roster.stats={atk:212,def:236,spa:328,spd:236,spe:236};
 p.feed(request('p1',[roster],['Psychic']));
 eq('request moves override a matching species import',p.manager.state.active.my.setMoves,['psychic']);
 eq('request stats survive applying imported EVs',p.manager.state.active.my.stats.atk,212);
 p.manager.registerMyTeam([{species:'Pikachu',moves:['Thunderbolt']}]);
 check('changing to a mismatched import clears stale spread assumptions',!p.manager.state.active.my.fromPaste&&p.manager.state.active.my.evs===null);
}
{
 const fixtures=JSON.parse(fs.readFileSync('tests/fixtures/team-plan-positions.json','utf8'));
 const make=(spec,side,extra={})=>mon(spec.species,side,spec.moves,Object.assign({},spec,{hpPercent:spec.hp===undefined?100:spec.hp},extra));
 const puzzle=fixtures.lastAnswer;
 const answer=make(puzzle.answer,'p2',{isActive:false}),reserve=make(puzzle.reserve,'p2',{isActive:false}),threat=make(puzzle.threat,'p1',{isActive:false});
 const state=board(mon('Mew','p2',['Psychic']),mon('Mew','p1',['Psychic']),[answer,reserve],[threat]);
 const plan=new ST.TeamPlan(damage,model,state),search=new ST.TacticalSearch(damage);
 state._teamPlan=plan;
 const report=plan.report(state),dragon=report.threats.find(t=>t.species==='Dragonite');
 eq('last-answer puzzle identifies Weavile from actual damage and priority',dragon.answers,['Weavile']);
 const loseAnswer=model.clone(state),loseReserve=model.clone(state);
 model.hp(loseAnswer.myTeam[1],0);model.hp(loseReserve.myTeam[2],0);
 check('equal material is worth more when the last Dragonite answer survives',search.value(loseReserve)>search.value(loseAnswer)+20);
 delete loseAnswer._teamPlan;delete loseReserve._teamPlan;
 eq('preservation ablation otherwise scores the equal-material positions equally',search.value(loseReserve),search.value(loseAnswer));
 const hazardous=model.clone(state);hazardous.myTeam[1].hp=hazardous.myTeam[1].hpPercent=20;hazardous.field.hazards.p2={rocks:true};
 eq('an answer that faints to entry hazards is not counted',plan.answer(hazardous,hazardous.myTeam[1],hazardous.oppTeam[1]),0);
 const finish=board(make(fixtures.priorityFinish.attacker,'p2'),make(fixtures.priorityFinish.defender,'p1'));
 eq('successor search keeps the priority KO over a stronger move that loses move order',search.bestHit(finish,'my').name,fixtures.priorityFinish.expected);
 const result=model.resolve(finish,move('Ice Shard'),move('Outrage'),()=>null);
 check('priority puzzle wins all modeled rolls before taking Outrage',result.every(b=>b.state.active.opp.fainted&&b.state.active.my.hp===100));
 finish.active.my.movePP={iceshard:0};
 eq('spent priority PP removes that continuation',search.bestHit(finish,'my').name,'Icicle Crash');
 const room=Object.assign({},state,{field:Object.assign({},state.field,{trickRoom:true,trickRoomTurnsLeft:1})});
 eq('final room turn has no attack available after a switch',plan.room(room).attacksAfterEntry,0);
 room.field.trickRoomTurnsLeft=3;eq('three room turns permit at most two attacks after entry',plan.room(room).attacksAfterEntry,2);
 const shield=board(mon('Mew','p2',['Thunderbolt','Protect']),mon('Ursaluna','p1',['Facade']),[],[],{trickRoom:true,trickRoomTurnsLeft:1});
 check('opponent continuations include Protect to stall Trick Room',search.candidates(Object.assign({},shield,{active:{my:shield.active.opp,opp:shield.active.my},myTeam:shield.oppTeam,oppTeam:shield.myTeam}),'opp').some(a=>a.name==='Protect'));
}
{
 const search=new ST.TacticalSearch(damage);
 const rows=[
  {mean:80,worst:80,worlds:[{worst:100,weight:0.8},{worst:0,weight:0.2}]},
  {mean:70,worst:70,worlds:[{worst:70,weight:0.8},{worst:70,weight:0.2}]}
 ];
 search.compareWorlds(rows);
 check('set-risk benchmark baseline prefers the brittle move',0.65*rows[0].worst+0.35*rows[0].mean>0.65*rows[1].worst+0.35*rows[1].mean);
 check('set-risk scoring prefers the reliable move when a plausible set punishes the brittle move',rows[1].robustScore>rows[0].robustScore);
 check('set comparisons expose the brittle move\'s loss against the counter set',rows[0].regret>0&&rows[0].tailScore<rows[1].tailScore);
 const single=[{mean:100,worst:100,worlds:[{worst:100,weight:1}]}];search.compareWorlds(single);
 eq('one sampled set does not imply robustness',single[0].stability,'Only one set combination tested');
 const repeated=[{mean:100,worst:100,worlds:[{worst:100,weight:0.5,signature:'same'},{worst:100,weight:0.5,signature:'same'}]}];search.compareWorlds(repeated);
 eq('drawing the same set twice does not inflate set diversity',repeated[0].stability,'Only one set combination tested');
 const keyed=board(mon('Mew','p2',['Psychic']),mon('Mew','p1',['Tackle']));
 keyed._worldSignature='defensive';const a=search.key(keyed,1);keyed._worldSignature='offensive';
 check('search memo separates hidden spreads with identical HP and items',a!==search.key(keyed,1));
 const b=search.key(keyed,1);keyed.active.my.hp-=0.01;
 check('search memo preserves small HP differences near KO thresholds',b!==search.key(keyed,1));
 const exhausted=board(mon('Mew','p2',['Psychic','Thunderbolt'],{movePP:{psychic:1,thunderbolt:10}}),mon('Blissey','p1',['Splash']));
 const after=model.resolve(exhausted,move('Psychic'),move('Splash'),()=>null)[0].state;
 check('a move with one PP cannot be reused in the next simulated turn',!model.actions(after,'my').some(action=>action.name==='Psychic'));
 eq('simulated PP spending never changes live PP',exhausted.active.my.movePP.psychic,1);
 exhausted.active.my.item='Choice Scarf';
 const locked=model.resolve(exhausted,move('Thunderbolt'),move('Splash'),()=>null)[0].state;
 eq('a simulated Choice move locks subsequent attacks',model.actions(locked,'my').filter(action=>action.kind==='move').map(action=>action.name),['Thunderbolt']);
 const reserve=mon('Pikachu','p2',['Thunderbolt'],{isActive:false});locked.myTeam.push(reserve);
 model.enter(locked,'my',reserve);model.enter(locked,'my',locked.myTeam[0]);
 check('switching resets the simulated Choice lock',!locked.active.my.choiceLocked);
}
{
 const state=board(mon('Mew','p2',['Psychic','Thunderbolt']),mon('Mew','p1',['Tackle']));state.battleId='history-test';
 const engine=engineFor(state);engine.evaluateTurn(state);
 state.active.my.hp=state.active.my.hpPercent=50;state.revision++;state.turn++;engine.evaluateTurn(state);
 eq('decision history retains the previous turn',engine.lastReadout.history.length,2);
 eq('past decision HP remains immutable after live updates',engine.lastReadout.history[0].decisionSnapshot.myTeam[0].hp,100);
 engine.evaluateTurn(state,{reread:true});eq('a deeper pass replaces the same decision rather than duplicating it',engine.lastReadout.history.length,2);
 state.battleId='another-battle';engine.evaluateTurn(state);eq('decision history resets between battles',engine.lastReadout.history.length,1);
 const sampled=new ST.WorldSampler(),boot=new ST.TacticianBoot();
 const foe=state.active.opp;
 foe.candidateSets=[{id:'defensive',species:'Mew',nature:'Calm',evs:{hp:252,spd:252},moves:['Tackle'],item:'Leftovers',ability:'Synchronize'},{id:'offensive',species:'Mew',nature:'Modest',evs:{spa:252},moves:['Tackle'],item:'Life Orb',ability:'Synchronize'}];
 boot.state.state=state;boot.sampler=sampled;
 const before=JSON.stringify(state),calc=boot.compareCandidate(foe.id,'defensive');
 check('candidate comparison produces concrete move ranges',calc.lines.some(line=>line.name==='Psychic'&&line.max>0));
 eq('candidate comparisons leave the live state untouched',JSON.stringify(state),before);
 eq('candidate comparison rejects a removed set',boot.compareCandidate(foe.id,'removed'),null);
 const hud=new ST.MobileHUD();hud._recordIntelChanges(state);const count=hud._intelChanges.length;
 hud._recordIntelChanges(state);eq('Intel observations do not repeat on redraw',hud._intelChanges.length,count);
 foe.revealedMoves=['Tackle'];foe.candidateSets.pop();hud._recordIntelChanges(state);
 check('Intel highlights the newly revealed move',hud._intelChanges.some(note=>note.includes('Tackle revealed')));
 check('Intel highlights actual pool reduction',hud._intelChanges.some(note=>note.includes('2 to 1 candidate')));
}
{
 const p=pipe();p.feed('|init|battle');p.feed('|tier|[Gen 9] National Dex');
 p.feed('|poke|p1|Mew|item');p.feed('|poke|p1|Pikachu|item');p.feed('|poke|p2|Blissey|item');p.feed('|poke|p2|Garchomp|item');
 p.feed('|switch|p1a: Mew|Mew|100/100');p.feed('|switch|p2a: Blissey|Blissey|100/100');
 const roster=[member('p1','Mew',true,'404/404',['U-turn']),member('p1','Pikachu',false,'211/211',['Thunderbolt'])];
 p.feed(request('p1',roster,['U-turn']));p.feed('|faint|p2a: Blissey');
 p.feed('|request|'+JSON.stringify({rqid:2,side:{id:'p1',pokemon:roster},forceSwitch:[true]}));
 const state=p.manager.state,snapshot=p.manager.snapshot();
 check('pivot-KO requests retain the fainted opposing slot until replacement',state.active.opp&&state.active.opp.species==='Blissey'&&state.active.opp.fainted);
 check('snapshot retains the fainted opponent as its roster body',snapshot.active.opp&&snapshot.oppTeam.includes(snapshot.active.opp));
 const engine=engineFor(snapshot),ranked=engine.evaluateTurn(snapshot);
 check('pivot-KO forced replacements still receive a recommendation',ranked.length>0&&ranked[0].kind==='switch');
 const world={team:snapshot.oppTeam.slice().reverse()};
 eq('a reordered sampled roster preserves the actual fainted opposing slot',engine._oppActive(world,snapshot).species,'Blissey');
}
console.log('CONTROL ENGINE: '+passed+' passed, '+failures.length+' failed');
process.exit(failures.length?1:0);
