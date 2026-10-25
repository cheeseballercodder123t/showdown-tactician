'use strict';
const {test,expect}=require('@playwright/test');
const H=require('./helpers');
let env;
test.beforeAll(async()=>{env=await H.launchExtension({viewport:{width:1440,height:900},deviceScaleFactor:1});await H.clearStorage(env.sw);await H.seedStorage(env.sw,{teamText:H.TEAM});});
test.afterAll(async()=>{if(env)await env.close();});
async function seatTwo(client,width){
 const opened=await H.openBattle(env.ctx,{client,setup:false,initLocal:{stHudLayout:'auto'}});
 await opened.page.setViewportSize({width,height:900});
 const req=JSON.parse(H.buildRequest().slice(9));req.side.id='p2';req.side.pokemon[0].ident='p2: Great Tusk';
 await H.pushLines(opened.page,['|init|battle','|tier|[Gen 9] National Dex','|poke|p1|Landorus-Therian|item','|poke|p2|Great Tusk|item','|switch|p1a: Foe|Landorus-Therian|100/100','|switch|p2a: Mine|Great Tusk|100/100','|turn|1','|request|'+JSON.stringify(req)]);
 await expect(opened.page.locator('.movebutton .elo-helper-badge')).toHaveCount(4);
 return opened;
}
for(const client of ['classic','beta']){
 test(client+': player two owns its roster and HP updates without a request',async()=>{
  const {page,errors}=await seatTwo(client,1440);
  await expect(page.locator('[data-st-bench="landorustherian"]')).toHaveCount(1);
  await expect(page.locator('[data-st-bench="greattusk"]')).toHaveCount(0);
  await expect(page.locator('.st-matchup-name')).toContainText('Great Tusk vs Landorus-Therian');
  await H.pushLines(page,['|-damage|p1a: Foe|61.25/100']);
  await expect(page.locator('[data-st-bench="landorustherian"] .st-bench-health')).toContainText('61%');
  await expect(page.locator('.st-play-name')).toHaveCount(0);
  await H.pushLines(page,['|-heal|p1a: Foe|67.5/100']);
  await expect(page.locator('[data-st-bench="landorustherian"] .st-bench-health')).toContainText('68%');
  await H.pushLines(page,['|faint|p1a: Foe']);
  await expect(page.locator('[data-st-bench="landorustherian"] .st-bench-health')).toContainText('Fainted');
  expect(errors).toEqual([]);await page.close();
 });
 test(client+': summary and battle-plan selector remain accessible across views on mobile',async()=>{
  const {page,errors}=await seatTwo(client,390);
  await page.locator('[data-st-sheet-trigger]').click();
  const center=page.getByRole('dialog',{name:'Tactician control center'});
  await center.locator('[data-st-plan]').selectOption('trickroom');
  await expect(center.locator('[data-st-plan]')).toHaveValue('trickroom');
  await expect(center.locator('.st-play-name')).toBeInViewport();
  const values=await center.locator('.st-action-row > .st-fact-row .st-fact-value').allTextContents();
  expect(values.length).toBeGreaterThan(1);expect(values.every(v=>!v.includes('%'))).toBe(true);
  for(const view of ['intel','field','review','battle']){
   await center.locator('[data-st-view-button="'+view+'"]').click();
   await expect(center.locator('.st-quick-summary')).toBeVisible();
   await expect(center.locator('[data-st-plan]')).toHaveValue('trickroom');
   expect(await center.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  }
  await center.locator('[data-st-view-button="intel"]').click();
  await expect(center.locator('.st-intel-overview')).toContainText('Landorus-Therian');
  await page.keyboard.press('Escape');
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('stBattlePlans')||'{}'));
  expect(saved.greattusk).toBe('trickroom');expect(errors).toEqual([]);await page.close();
 });
 test(client+': native range details identify exact request stats',async()=>{
  const {page,errors}=await seatTwo(client,1440);
  const pick=await page.locator('.st-play-name').innerText();
  const row=page.locator('.st-damage-row').filter({has:page.locator('.st-damage-name',{hasText:pick})});
  const range=(await row.locator('.st-damage-range').innerText()).replace(/\s/g,'');
  expect((await page.locator('.st-play-reason').innerText()).replace(/\s/g,'')).toContain(range);
  const detail=page.locator('.st-calc-detail').first();
  await detail.locator('summary').click();
  await expect(detail).toContainText('Battle request');
  await expect(detail).toContainText('300 / 200 / 100 / 200 / 300');
  await expect(page.locator('.st-action-list')).toContainText('Recommended');
  await page.locator('[data-st-view-button="review"]').click();
  await expect(page.locator('.st-engine-review')).toContainText('Selective search does not establish a forced win');
  await expect(page.locator('.st-copy-decision')).toBeVisible();
  expect(errors).toEqual([]);await page.close();
 });
}
