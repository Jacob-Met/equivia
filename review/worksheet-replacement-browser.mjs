import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=process.env.BASE_URL||process.argv[2],out=resolve(process.env.ARTIFACTS_DIR||process.argv[3]);
const u=new URL(base);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.protocol,'http:');assert.notEqual(process.getuid?.(),0);
const mod=process.env.PLAYWRIGHT_MODULE;assert.ok(mod);const {chromium}=await import(mod.startsWith('/')?pathToFileURL(mod).href:mod);
await mkdir(out,{recursive:true});
const receipt={schema:'equivia.replacement-independent.v1',base,started_at:new Date().toISOString(),checks:[],errors:[],requests:[],screenshots:[],limitations:['Linux sandboxed Chrome automation; native OS picker cancellation and physical devices not qualified.','Recovery is one in-memory slot; no reload persistence claim.']};
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.CHROME_PATH||process.env.CHROME_EXECUTABLE||'/usr/local/bin/google-chrome'});
receipt.browser=browser.version();
const context=await browser.newContext({acceptDownloads:true,viewport:{width:1280,height:980}});const page=await context.newPage();
page.on('pageerror',e=>receipt.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')receipt.errors.push(m.text());});page.on('request',r=>{if(r.method()==='POST'||(!['blob:','data:'].includes(new URL(r.url()).protocol)&&new URL(r.url()).origin!==u.origin))receipt.requests.push(r.url());});
const state=()=>page.evaluate(()=>Object.fromEntries([...document.querySelectorAll('#pair-title,.creator-world input,.creator-world select,#check-clamp')].map(x=>[x.id,x.value])));
const storage=()=>page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}}));
async function choose(button,path){const pending=page.waitForEvent('filechooser');await page.locator(button).click();const chooser=await pending;await page.evaluate(()=>window.__changes=0);await chooser.setFiles(path);}
// Poll from Node so Playwright does not install a Function-based polling task
// inside the page. Keep the application's CSP and Chromium sandbox intact.
async function waitForPredicate(target,predicate,arg,label){
 const deadline=performance.now()+30000;
 while(true){
  const remaining=deadline-performance.now();
  assert.ok(remaining>0,`${label} timed out after 30000ms`);
  let timer;
  const ready=await Promise.race([
   target.evaluate(predicate,arg),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out after 30000ms`)),remaining);})
  ]).finally(()=>clearTimeout(timer));
  if(ready)return;
  const pause=Math.min(50,deadline-performance.now());
  assert.ok(pause>0,`${label} timed out after 30000ms`);
  await new Promise(resolve=>setTimeout(resolve,pause));
 }
}
async function open(button,path){await page.evaluate(()=>window.__changes=0);await choose(button,path);await waitForPredicate(page,()=>window.__changes>0,undefined,'Worksheet status update');}
async function save(name){const pending=page.waitForEvent('download');await page.locator('#save-worksheet').click();const d=await pending,p=join(out,name);await d.saveAs(p);return JSON.parse(await readFile(p,'utf8'));}
async function barrier(){await page.evaluate(()=>{window.__original=File.prototype.text;window.__reads=[];File.prototype.text=function(){const f=this;return new Promise((res,rej)=>window.__reads.push(()=>window.__original.call(f).then(res,rej)));};});}
async function release(i){await page.evaluate(async i=>{await window.__reads[i]();await new Promise(r=>setTimeout(r,0));},i);}
async function unbarrier(){await page.evaluate(()=>{if(window.__original)File.prototype.text=window.__original;});}
async function check(name,fn){await fn();receipt.checks.push({name,passed:true});}
async function restore(expected,ids){assert.equal(await page.locator('#worksheet-restore-help').isVisible(),true);assert.equal(await page.locator('#restore-worksheet').isVisible(),true);await page.locator('#restore-worksheet').click();assert.deepEqual(await state(),expected);assert.equal(await page.locator('#save-pair').isDisabled(),true);assert.equal(await page.locator('#check-results').isHidden(),true);assert.equal(await page.locator('#restore-worksheet').isDisabled(),true);assert.equal(await page.locator('#restore-worksheet').isHidden(),true);assert.equal(await page.locator('#worksheet-restore-help').isHidden(),true);assert.equal(await page.evaluate(()=>document.activeElement.id),'pair-title');if(ids)assert.deepEqual((await save('restored-'+receipt.checks.length+'.json')).worlds.map(w=>w.id),ids);}
try{
await page.goto(new URL('/creator',base).href);await page.evaluate(()=>new MutationObserver(()=>window.__changes=(window.__changes||0)+1).observe(document.querySelector('#creator-status'),{childList:true,subtree:true,characterData:true}));const initialStorage=await storage();if(process.env.RECEIVE_MODE!=='baseline'){assert.equal(await page.locator('#restore-worksheet').isHidden(),true);assert.equal(await page.locator('#restore-worksheet').isDisabled(),true);assert.equal(await page.locator('#worksheet-restore-help').isHidden(),true);}
const original=await save('initial.json');const make=async(name,value)=>{const p=join(out,name);await writeFile(p,JSON.stringify(value));return p;};
const a=await make('a.json',{...original,title:'File A'}),b=await make('b.json',{...original,title:'File B'}),bad=await make('bad.json',{schema:'wrong'});
await page.locator('#pair-title').fill('Unsaved draft');await page.locator('#world-0-label').fill('  未完成 café 🧪  ');await page.locator('#world-1-label').fill('');await page.locator('#world-0-order').selectOption('BA');await page.locator('#world-0-root').selectOption('1');await page.locator('#world-0-off').selectOption('2');await page.locator('#world-0-on').selectOption('3');await page.locator('#world-1-order').selectOption('AB');await page.locator('#world-1-root').selectOption('5');await page.locator('#world-1-off').selectOption('6');await page.locator('#world-1-on').selectOption('7');await page.locator('#check-clamp').selectOption('B0');const baseline=await state();await open('#open-worksheet',a);assert.notDeepEqual(await state(),baseline);assert.equal(await page.locator('#pair-title').inputValue(),'File A');receipt.replacement={before:baseline,after:await state()};
if(process.env.RECEIVE_MODE==='baseline'){assert.equal(await page.locator('#restore-worksheet').count(),0);receipt.checks.push({name:'Valid open actually replaces unsaved controls; baseline has no restore control',passed:true});}
else{
await check('Valid open restores replaced unsaved controls',async()=>restore(baseline));
await page.locator('#check-pair').click(); // Obtain a known valid authored pair from a clean worksheet.
await open('#open-worksheet',join(out,'initial.json'));await page.locator('#check-pair').click();const pending=page.waitForEvent('download');await page.locator('#save-pair').click();const pairPath=join(out,'pair.json');await(await pending).saveAs(pairPath);
await check('Restoring previously accepted controls always requires a fresh check',async()=>{assert.equal(await page.locator('#save-pair').isDisabled(),false);const accepted=await state();await open('#open-worksheet',b);await restore(accepted);await page.locator('#check-pair').click();assert.equal(await page.locator('#save-pair').isDisabled(),false);});
const custom=await make('custom.json',{...original,title:'',worlds:original.worlds.map((w,i)=>({...w,id:i?'Custom_Right':'Custom-Left',label:i?'':'  未完成 café 🧪  '})),clamp:'B0'});
await check('Both file kinds preserve exact blank Unicode controls and custom IDs after later edits',async()=>{for(const button of ['#open-worksheet','#open-pair']){await open('#open-worksheet',custom);const before=await state();await open(button,button==='#open-pair'?pairPath:a);await page.locator('#pair-title').fill('Later edit');await restore(before,['Custom-Left','Custom_Right']);}});
await check('Repeated successful opens replace slot with immediately previous controls',async()=>{await open('#open-worksheet',a);const before=await state();await open('#open-worksheet',b);await restore(before);});
await check('Invalid cancelled and stale reads preserve earlier recovery slot',async()=>{await open('#open-worksheet',custom);const before=await state();await open('#open-worksheet',a);await open('#open-worksheet',bad);await choose('#open-pair',[]);await barrier();await choose('#open-worksheet',b);await waitForPredicate(page,()=>window.__reads.length===1,undefined,'Pending worksheet read');await page.locator('#pair-title').fill('Intervening');await release(0);await unbarrier();await restore(before,['Custom-Left','Custom_Right']);});
await check('Restoration retires a pending read and clears accepted results',async()=>{await open('#open-worksheet',custom);const before=await state();await open('#open-pair',pairPath);await page.locator('#check-pair').click();assert.equal(await page.locator('#save-pair').isDisabled(),false);await barrier();await choose('#open-worksheet',b);await waitForPredicate(page,()=>window.__reads.length===1,undefined,'Pending worksheet read');await restore(before);const status=await page.locator('#creator-status').textContent();await release(0);assert.deepEqual(await state(),before);assert.equal(await page.locator('#creator-status').textContent(),status);await unbarrier();});
await check('Narrow keyboard restore has visible focus and returns focus to title',async()=>{await open('#open-worksheet',a);const before=await state();await open('#open-worksheet',b);const desktopShot=join(out,'desktop-recovery-available.png');await page.screenshot({path:desktopShot});receipt.screenshots.push(desktopShot);await page.setViewportSize({width:390,height:844});await page.locator('#open-worksheet').focus();let reached=false;for(let i=0;i<80;i++){if(await page.evaluate(()=>document.activeElement.id==='restore-worksheet')){reached=true;break;}await page.keyboard.press('Tab');}assert.ok(reached);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);const shot=join(out,'narrow-restore-focus.png');await page.screenshot({path:shot});receipt.screenshots.push(shot);await page.keyboard.press('Enter');assert.deepEqual(await state(),before);assert.equal(await page.evaluate(()=>document.activeElement.id),'pair-title');assert.equal(await page.locator('#restore-worksheet').isDisabled(),true);assert.equal(await page.locator('#restore-worksheet').isHidden(),true);assert.equal(await page.locator('#worksheet-restore-help').isHidden(),true);const restoredShot=join(out,'narrow-restored.png');await page.screenshot({path:restoredShot});receipt.screenshots.push(restoredShot);});
}
assert.deepEqual(await storage(),initialStorage);assert.deepEqual(receipt.errors,[]);assert.deepEqual(receipt.requests,[]);receipt.ok=true;
}catch(e){receipt.ok=false;receipt.error=e.stack;process.exitCode=1;}finally{await unbarrier().catch(()=>{});await context.close();receipt.context_closed=true;await browser.close();receipt.browser_closed=true;receipt.finished_at=new Date().toISOString();await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));}
