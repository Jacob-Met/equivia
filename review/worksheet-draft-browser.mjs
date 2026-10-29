import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=process.env.BASE_URL||process.argv[2],output=resolve(process.env.ARTIFACTS_DIR||process.argv[3]||'');
assert.ok(base&&(process.env.ARTIFACTS_DIR||process.argv[3]),'Supply BASE_URL/ARTIFACTS_DIR or base URL and artifact directory arguments');
const u=new URL(base);assert.equal(u.protocol,'http:');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.username+u.password,'');assert.notEqual(process.getuid?.(),0,'Sandbox required');
assert.ok(process.env.PLAYWRIGHT_MODULE,'Use an existing Playwright installation');
const modulePath=process.env.PLAYWRIGHT_MODULE;const {chromium}=await import(modulePath.startsWith('/')?pathToFileURL(modulePath).href:modulePath);
await mkdir(dirname(output),{recursive:true});await mkdir(output);
const receipt={schema:'equivia.worksheet-browser.v1',base,started_at:new Date().toISOString(),checks:[],downloads:[],screenshots:[],page_errors:[],console_errors:[],external_requests:[],post_requests:[],sandbox:true,limitations:['Linux Chrome automation; no physical-device or screen-reader claim.','File selection uses the browser chooser through automation; no native OS picker claim.','File.text barriers control only the receiving timing of real selected files; no product state hooks.']};
const hash=b=>createHash('sha256').update(b).digest('hex');
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.CHROME_PATH||'/usr/local/bin/google-chrome'});receipt.browser=browser.version();
const context=await browser.newContext({viewport:{width:1280,height:980},acceptDownloads:true});
function watch(p){p.on('pageerror',e=>receipt.page_errors.push(e.message));p.on('console',m=>{if(m.type()==='error')receipt.console_errors.push(m.text());});p.on('request',r=>{const target=new URL(r.url());if(!['blob:','data:'].includes(target.protocol)&&target.origin!==u.origin)receipt.external_requests.push(r.url());if(r.method()==='POST')receipt.post_requests.push(r.url());});}
const page=await context.newPage();watch(page);const lab=await context.newPage();watch(lab);
const form=()=>page.evaluate(()=>Object.fromEntries([...document.querySelectorAll('#pair-title,.creator-world input,.creator-world select,#check-clamp')].map(e=>[e.id,e.value])));
const state=async()=>({form:await form(),disabled:await page.locator('#save-pair').isDisabled(),results:await page.locator('#check-results').innerHTML(),hidden:await page.locator('#check-results').isHidden()});
const storage=()=>page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)])));
async function check(name,fn){try{const evidence=await fn();receipt.checks.push({name,passed:true,evidence});console.log(JSON.stringify({check:name,passed:true}));}catch(e){receipt.checks.push({name,passed:false,error:e.stack||String(e)});throw e;}}
async function selectFile(button,path,target=page){
 const pending=target.waitForEvent('filechooser');await target.locator(button).click();const chooser=await pending;
 // Button focus/blur can commit an ordinary control change. Its status mutation
 // must settle before observing completion of the newly selected file itself.
 const count=target===page?await target.evaluate(()=>window.__worksheetStatusChanges):undefined;
 await chooser.setFiles(path);return count;
}
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
async function open(button,path){const count=await selectFile(button,path);await waitForPredicate(page,count=>window.__worksheetStatusChanges>count,count,'Worksheet status update');assert.equal(await page.locator('#worksheet-feedback').isVisible(),true);assert.equal(await page.locator('#worksheet-feedback').getAttribute('aria-live'),null);assert.notEqual(await page.locator('#worksheet-feedback').getAttribute('role'),'status');}
async function download(button,name){const pending=page.waitForEvent('download');await page.locator(button).click();const file=await pending;const path=join(output,name);await file.saveAs(path);const bytes=await readFile(path);receipt.downloads.push({path,bytes:bytes.length,sha256:hash(bytes),suggested:file.suggestedFilename()});return{path,bytes,data:JSON.parse(bytes)};}
async function fixture(name,data){const path=join(output,name);await writeFile(path,typeof data==='string'?data:JSON.stringify(data));return path;}
async function shot(name){const path=join(output,name);await page.screenshot({path});const b=await readFile(path);receipt.screenshots.push({path,bytes:b.length,sha256:hash(b)});}
async function barrier(){await page.evaluate(()=>{window.__worksheetOriginalText=File.prototype.text;window.__worksheetReads=[];File.prototype.text=function(){const file=this;return new Promise((resolve,reject)=>window.__worksheetReads.push(()=>window.__worksheetOriginalText.call(file).then(resolve,reject)));};});}
async function release(index){await page.evaluate(async index=>{await window.__worksheetReads[index]();await new Promise(r=>setTimeout(r,0));},index);}
async function restore(){await page.evaluate(()=>{if(window.__worksheetOriginalText)File.prototype.text=window.__worksheetOriginalText;});}
async function queued(n){await waitForPredicate(page,n=>window.__worksheetReads?.length===n,n,'Queued worksheet reads');}
async function acceptedPair(path){await open('#open-pair',path);await page.locator('#check-pair').click();assert.equal(await page.locator('#save-pair').isDisabled(),false);assert.equal(await page.locator('#worksheet-feedback').isHidden(),true);}
let worksheet,pair,blank,initialStorage;
try{
 await lab.goto(base,{waitUntil:'networkidle'});await lab.locator('#observe').click();await waitForPredicate(lab,()=>localStorage.getItem('equivia.notebook.v1')!==null,undefined,'Initial notebook persistence');await page.goto(new URL('/creator',base).href,{waitUntil:'networkidle'});initialStorage=await storage();
 await page.evaluate(()=>{window.__worksheetStatusChanges=0;new MutationObserver(()=>window.__worksheetStatusChanges++).observe(document.getElementById('creator-status'),{childList:true,subtree:true,characterData:true});});
 if(process.env.RECEIVE_MODE==='baseline'){
  await check('Pinned baseline lacks worksheet persistence and loses unfinished controls on reload',async()=>{
   assert.equal(await page.locator('#save-worksheet,#open-worksheet').count(),0);
   await page.locator('#pair-title').fill('Unfinished baseline worksheet');await page.locator('#world-1-root').selectOption('8');await page.locator('#check-pair').click();assert.equal(await page.locator('#save-pair').isDisabled(),true);const before=await form();await shot('baseline-unsaveable-worksheet.png');await page.reload({waitUntil:'networkidle'});const after=await form();assert.notDeepEqual(after,before);assert.equal(after['pair-title'],'Matching lamps');return{before,after,featureGap:true};
  });receipt.ok=true;
 }else{
 await check('Saving current accepted controls leaves pair checks intact and produces distinct actual downloads',async()=>{
  await page.locator('#check-pair').click();assert.equal(await page.locator('#save-pair').isDisabled(),false);const before=await state();worksheet=await download('#save-worksheet','accepted-worksheet.json');assert.equal(worksheet.data.schema,'equivia.worksheet.v1');assert.deepEqual(await state(),before);pair=await download('#save-pair','accepted-pair.json');assert.equal(pair.data.schema,'equivia.author.v1');
  const custom={...pair.data,worlds:pair.data.worlds.map((w,i)=>({...w,id:i?'Custom_Right':'Custom-Left'}))};const customPath=await fixture('custom-id-authored-input.json',custom);await acceptedPair(customPath);
  worksheet=await download('#save-worksheet','custom-id-worksheet.json');pair=await download('#save-pair','custom-id-pair.json');assert.deepEqual(worksheet.data.worlds.map(w=>w.id),['Custom-Left','Custom_Right']);assert.deepEqual(pair.data.worlds.map(w=>w.id),['Custom-Left','Custom_Right']);return{worksheet:worksheet.path,pair:pair.path};
 });
 await check('Blank unfinished text and current un-checked controls round trip through actual saved file',async()=>{
  await page.locator('#pair-title').fill('');assert.equal(await page.locator('#worksheet-feedback').isHidden(),true);await page.locator('#world-0-label').fill('  ');await page.locator('#world-1-label').fill('');await page.locator('#world-0-root').selectOption('1');await page.locator('#check-clamp').selectOption('B0');
  await page.locator('#check-pair').click();assert.equal(await page.locator('#worksheet-feedback').isHidden(),true);assert.equal(await page.locator('#save-pair').isDisabled(),true);const expected=await form();blank=await download('#save-worksheet','blank-worksheet.json');assert.equal(blank.data.title,'');assert.equal(blank.data.worlds[0].label,'  ');
  await page.locator('#pair-title').fill('Discard this edit');await open('#open-worksheet',blank.path);assert.deepEqual(await form(),expected);assert.equal(await page.locator('#save-pair').isDisabled(),true);assert.equal(await page.locator('#check-results').isHidden(),true);await shot('unfinished-reopened.png');
 });
 await check('Scientifically rejected pair can be saved and reopened without becoming checked',async()=>{
  await open('#open-worksheet',worksheet.path);await page.locator('#world-1-root').selectOption('8');await page.locator('#check-pair').click();assert.equal(await page.locator('.creator-check-summary').getAttribute('data-accepted'),'false');const expected=await form();const rejected=await download('#save-worksheet','rejected-pair-worksheet.json');await open('#open-worksheet',worksheet.path);await open('#open-worksheet',rejected.path);assert.deepEqual(await form(),expected);assert.equal(await page.locator('#save-pair').isDisabled(),true);
 });
 await check('Malformed oversized unknown-field and cross-kind files preserve accepted controls and results atomically',async()=>{
  await acceptedPair(pair.path);const before=await state();
  const bad=[await fixture('malformed.json','{'),await fixture('oversize.json',' '.repeat(65537)),await fixture('unknown-field.json',{...worksheet.data,checked:true}),await fixture('unknown-world-field.json',{...worksheet.data,worlds:worksheet.data.worlds.map((w,i)=>i?w:{...w,extra:1})}),pair.path];
  for(const path of bad){await open('#open-worksheet',path);assert.deepEqual(await state(),before);}
  await open('#open-pair',worksheet.path);assert.deepEqual(await state(),before);
 });
 await check('Reopening identical accepted worksheet requires a fresh scientific check',async()=>{
  await acceptedPair(pair.path);const expected=await form();await open('#open-worksheet',worksheet.path);assert.deepEqual(await form(),expected);assert.equal(await page.locator('#save-pair').isDisabled(),true);assert.equal(await page.locator('#check-results').isHidden(),true);await page.locator('#check-pair').click();assert.equal(await page.locator('#save-pair').isDisabled(),false);
 });
 await check('A pending read cannot replace newer edits even when edited text returns to its original value',async()=>{
  await barrier();const before=await form();await selectFile('#open-worksheet',blank.path);await queued(1);await page.locator('#pair-title').fill('Intervening edit');await page.locator('#pair-title').fill(before['pair-title']);const dirty=await state();await release(0);assert.deepEqual(await state(),dirty);await restore();
 });
 await check('Latest file intent wins in both cross-kind selection orders',async()=>{
  const latestWorksheet=await fixture('latest-worksheet.json',{...worksheet.data,title:'Latest worksheet'});const latestPair=await fixture('latest-pair.json',{...pair.data,title:'Latest pair'});
  for(const [olderButton,older,newerButton,newer,title] of [['#open-worksheet',blank.path,'#open-pair',latestPair,'Latest pair'],['#open-pair',pair.path,'#open-worksheet',latestWorksheet,'Latest worksheet']]){
   await barrier();await selectFile(olderButton,older);await queued(1);await selectFile(newerButton,newer);await queued(2);await release(1);assert.equal(await page.locator('#pair-title').inputValue(),title);const newerState=await state(),status=await page.locator('#creator-status').textContent();await release(0);assert.deepEqual(await state(),newerState);assert.equal(await page.locator('#creator-status').textContent(),status);await restore();
  }
 });
 await check('A newer invalid selection retires an older valid read and stale errors cannot replace newer success',async()=>{
  const bad=join(output,'malformed.json');await barrier();const before=await state();await selectFile('#open-pair',pair.path);await queued(1);await selectFile('#open-worksheet',bad);await queued(2);await release(1);const status=await page.locator('#creator-status').textContent();await release(0);assert.deepEqual(await state(),before);assert.equal(await page.locator('#creator-status').textContent(),status);await restore();
  await barrier();await selectFile('#open-worksheet',bad);await queued(1);await selectFile('#open-pair',pair.path);await queued(2);await release(1);const after=await state(),goodStatus=await page.locator('#creator-status').textContent();await release(0);assert.deepEqual(await state(),after);assert.equal(await page.locator('#creator-status').textContent(),goodStatus);await restore();
 });
 await check('Laboratory rejects worksheet format without adopting an investigation or changing saved notebook',async()=>{
  const notebook=await lab.evaluate(()=>localStorage.getItem('equivia.notebook.v1'));const before=await lab.locator('#author-result').innerHTML();await selectFile('#import-worlds',worksheet.path,lab);await lab.locator('#status.error').waitFor();assert.equal(await lab.locator('#author-result .primary').count(),0);assert.equal(await lab.locator('#author-result').innerHTML(),before);assert.equal(await lab.evaluate(()=>localStorage.getItem('equivia.notebook.v1')),notebook);
 });
 await check('Narrow keyboard save remains usable and all journeys preserve notebook storage without provider calls',async()=>{
  await page.setViewportSize({width:390,height:844});await page.locator('#pair-title').click();await page.keyboard.press('Control+A');await page.keyboard.type('Keyboard worksheet');
  let reached=false;for(let i=0;i<80;i++){if(await page.evaluate(()=>document.activeElement?.id==='save-worksheet')){reached=true;break;}await page.keyboard.press('Tab');}assert.ok(reached,'Save worksheet reachable with Tab');
  const pending=page.waitForEvent('download');await page.keyboard.press('Enter');const file=await pending;const path=join(output,'keyboard-worksheet.json');await file.saveAs(path);assert.equal(JSON.parse(await readFile(path,'utf8')).title,'Keyboard worksheet');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await shot('worksheet-narrow-keyboard.png');assert.deepEqual(await storage(),initialStorage);assert.deepEqual(receipt.page_errors,[]);assert.deepEqual(receipt.console_errors,[]);assert.deepEqual(receipt.external_requests,[]);assert.deepEqual(receipt.post_requests,[]);
 });
 await check('Opening and cancelling another picker retires an older pending read silently',async()=>{
  await barrier();const before=await state();await selectFile('#open-worksheet',blank.path);await queued(1);
  const pending=page.waitForEvent('filechooser');await page.locator('#open-pair').click();await(await pending).setFiles([]);
  const status=await page.locator('#creator-status').textContent();await release(0);assert.deepEqual(await state(),before);assert.equal(await page.locator('#creator-status').textContent(),status);await restore();assert.deepEqual(await storage(),initialStorage);
 });
 await check('Checked pair retains actual laboratory preview explicit adoption and clamp play contract',async()=>{
  const previous=await lab.evaluate(()=>localStorage.getItem('equivia.notebook.v1'));assert.equal(previous,initialStorage['equivia.notebook.v1']);
  await selectFile('#import-worlds',pair.path,lab);await lab.locator('#author-result .primary').waitFor({state:'visible'});assert.equal(await lab.evaluate(()=>localStorage.getItem('equivia.notebook.v1')),previous,'Preview alone must not adopt');
  await lab.locator('#author-result .primary').click();const adopted=await lab.evaluate(()=>JSON.parse(localStorage.getItem('equivia.notebook.v1')));assert.equal(adopted.title,pair.data.title);assert.deepEqual(adopted.worlds,pair.data.worlds);
  await lab.locator('input[name="target"][value="A"]').check();await lab.locator('input[name="value"][value="1"]').check();await lab.locator('#prediction-percent').fill('50');await lab.locator('#run-one').click();await waitForPredicate(lab,()=>document.getElementById('budget').textContent.includes('5 / 6'),undefined,'Played trial budget');
  const played=await lab.evaluate(()=>JSON.parse(localStorage.getItem('equivia.notebook.v1')));assert.equal(played.history.filter(e=>e.kind==='intervene').length,1);assert.deepEqual(played.worlds,pair.data.worlds);assert.equal(await lab.locator('#experiment-result').isVisible(),true);
  const path=join(output,'checked-pair-adopted-and-played.png');await lab.screenshot({path});const bytes=await readFile(path);receipt.screenshots.push({path,bytes:bytes.length,sha256:hash(bytes)});assert.deepEqual(receipt.page_errors,[]);assert.deepEqual(receipt.console_errors,[]);assert.deepEqual(receipt.external_requests,[]);assert.deepEqual(receipt.post_requests,[]);return{adoptedWorldIds:played.worlds.map(w=>w.id),interventionTrials:1};
 });
 assert.equal(receipt.checks.length,12);receipt.ok=true;
 }
}catch(error){receipt.ok=false;receipt.error=error.stack||String(error);process.exitCode=1;try{await shot('worksheet-failure.png');}catch{}}
finally{await restore().catch(()=>{});await context.close();await browser.close();receipt.browser_closed=true;receipt.finished_at=new Date().toISOString();await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));}
