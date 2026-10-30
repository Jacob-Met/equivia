import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const appRoot=process.env.EQUIVIA_APP_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.resolve(process.argv[2]||'evidence-report-browser-receipts');
await fs.mkdir(out,{recursive:true});
const receipts={cases:[],errors:[],requests:[],status:'running',sandboxRequested:true};
let server,browser;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function poll(fn,label){const end=performance.now()+10000;while(performance.now()<end){const v=await fn();if(v)return v;await pause(100);}throw Error('Timed out: '+label);}
const hostile='</td><script>window.__reportInjected=1</script> & 雪';
function fixture(){return {schema:'equivia.session.v1',title:'Independent direction review',worlds:[{schema:'equivia.scm.v1',id:'review-A-drives-B',label:'Review A drives B '+hostile,observed:['A','B'],variables:[{id:'A',parents:[],noiseBits:1,table:[0,1]},{id:'B',parents:['A'],noiseBits:0,table:[0,1]}]},{schema:'equivia.scm.v1',id:'review-B-drives-A',label:'Review B drives A',observed:['A','B'],variables:[{id:'B',parents:[],noiseBits:1,table:[0,1]},{id:'A',parents:['B'],noiseBits:0,table:[0,1]}]}],activeWorldId:'review-A-drives-B',initialSeed:123456789,seed:123456789,budget:6,history:[],explanation:'',revealed:false};}
async function stored(page){return page.evaluate(()=>JSON.parse(localStorage.getItem('equivia.notebook.v1')||'null'));}
try{
 let base=process.env.EQUIVIA_BASE_URL;
 if(!base){const {createServer}=await import(pathToFileURL(path.join(appRoot,'server.mjs')).href);server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});base='http://127.0.0.1:'+server.address().port;}
 const moduleURL=process.env.PLAYWRIGHT_MODULE.startsWith('file:')?process.env.PLAYWRIGHT_MODULE:pathToFileURL(process.env.PLAYWRIGHT_MODULE).href;
 const {chromium}=await import(moduleURL);
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_EXECUTABLE,chromiumSandbox:true});
 const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
 page.setDefaultTimeout(10000);
 page.on('pageerror',e=>receipts.errors.push(String(e)));
 page.on('request',r=>{const u=new URL(r.url());if(/^https?:$/.test(u.protocol)&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))receipts.requests.push(r.url());});
 await page.goto(base);
 await poll(()=>page.locator('#save-evidence-report').count(),'export control');
 const moduleResponse=await page.request.get(new URL('/src/evidence-report.js',base).href);assert.equal(moduleResponse.status(),200);
 await page.locator('#notebook-file').setInputFiles({name:'review.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture()))});
 await poll(async()=>{const s=await stored(page);return s?.title==='Independent direction review'&&s.history.length===0;},'import');
 async function capture(name,check){
  const before=await stored(page);await fs.writeFile(path.join(out,name+'-session.json'),JSON.stringify(before,null,2));
  const storageBefore=await page.evaluate(()=>JSON.stringify(Object.entries(localStorage).sort()));
  const downloadPromise=page.waitForEvent('download');await page.locator('#save-evidence-report').click();const download=await downloadPromise;
  assert.equal(await download.failure(),null);assert.equal(download.suggestedFilename(),'equivia-evidence-report.html');
  const file=path.join(out,name+'.html');await download.saveAs(file);const html=await fs.readFile(file,'utf8');
  assert.equal(await page.evaluate(()=>JSON.stringify(Object.entries(localStorage).sort())),storageBefore,'export changed local storage');
  assert.deepEqual(await stored(page),before,'export changed persisted session');
  assert.doesNotMatch(html,/\b(?:activeWorldId|initialSeed|beforeSeed|afterSeed|revealed)\b/);
  for(const value of [before.initialSeed,before.seed,...before.history.flatMap(e=>[e.beforeSeed,e.afterSeed])])if(value!==undefined && String(value).length>6)assert.ok(!html.includes(String(value)),'seed leaked: '+value);
  assert.ok(!html.includes('<script>window.__reportInjected=1</script>'),'unsafe script markup');
  const offline=await browser.newContext({offline:true});const viewer=await offline.newPage();const errors=[],network=[];
  viewer.on('pageerror',e=>errors.push(String(e)));viewer.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
  await viewer.goto(pathToFileURL(file).href);const text=await viewer.locator('body').innerText();assert.ok(text.length>100);assert.equal(await viewer.evaluate(()=>window.__reportInjected),undefined);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  assert.equal(await viewer.locator('[data-trial-id]').count(),before.history.length);
  await check({html,text,viewer,before});
  const geometry=[];
  for(const width of [1280,375]){
   await viewer.setViewportSize({width,height:850});
   const measured=await viewer.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
   assert.ok(measured.scroll<=measured.width,'report overflow at '+width);geometry.push(measured);
   await viewer.screenshot({path:path.join(out,name+'-report-'+width+'.png')});
  }
  if(name==='changed-controls'){
   await viewer.setViewportSize({width:1280,height:850});
   await viewer.emulateMedia({media:'print'});
   await viewer.screenshot({path:path.join(out,'report-print-layout.png')});
   await viewer.emulateMedia({media:'screen'});
  }
  receipts.cases.push({name,file,history:before.history.length,offline:true,geometry});await offline.close();
 }
 await capture('empty',async({text})=>{assert.match(text,/No recorded trials/);assert.match(text,/Starting candidate weights/);assert.ok(text.includes('雪'));});
 await page.locator('input[name=target][value=A]').check();await page.locator('input[name=value][value="1"]').check();await page.locator('#prediction-percent').fill('25');await page.locator('#run-one').click();
 await poll(async()=>((await stored(page))?.history.length===1),'record observation');
 await poll(()=>page.locator('#save-evidence-report').isEnabled(),'trial animation completes');
 const recorded=(await stored(page)).history[0];assert.equal(recorded.intervention.A,1);assert.equal(recorded.prediction,0.25);
 await page.locator('input[name=target][value=B]').check();await page.locator('input[name=value][value="0"]').check();await page.locator('#prediction-percent').fill('80');
 await page.locator('#learner-explanation').fill('Current reflection '+hostile);await page.locator('#learner-explanation').blur();
 await poll(async()=>((await stored(page))?.explanation.includes(hostile)),'reflection persisted');
 await capture('changed-controls',async({text,before,viewer})=>{
  assert.deepEqual(before.history[0],recorded);assert.ok(text.includes('Current reflection'));assert.ok(text.includes(hostile),'escaped reflection should remain readable');
  const row=await viewer.locator('[data-trial-id="1"]').innerText();
  assert.ok(row.includes('Clamp A = ON (1).'));assert.ok(row.includes('25% chance that the other lamp, B'));
  assert.ok(!row.includes('80%'));assert.ok(text.includes('Exact: 2/3'));assert.ok(text.includes('Exact: 1/3'));
 });
 await page.locator('#debrief').click();await poll(async()=>((await stored(page))?.revealed===true),'debrief');
 await capture('finished',async({text,before})=>{assert.equal(before.revealed,true);assert.ok(text.includes('Current reflection'));});
 async function importReviewSession(value,name){
  await page.locator('#notebook-file').setInputFiles({name:name+'.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
  await poll(async()=>{const got=await stored(page);return got?.title===value.title&&got.history.length===value.history.length;},'import '+name);
 }
 const noisy=fixture();noisy.title='Noisy lamps, one deliberate intervention';
 noisy.worlds[0].label='A drives B, with a three-quarter root';
 noisy.worlds[1].label='B drives A, with a three-quarter root';
 for(const world of noisy.worlds){const root=world.variables.find(v=>v.parents.length===0);root.noiseBits=2;root.table=[0,1,1,1];}
 await importReviewSession(noisy,'noisy-root');
 await page.locator('input[name=target][value=A]').check();
 await page.locator('input[name=value][value="1"]').check();
 await page.locator('#prediction-percent').fill('50');await page.locator('#run-one').click();
 await poll(async()=>((await stored(page))?.history.length===1),'noisy trial');
 await poll(()=>page.locator('#save-evidence-report').isEnabled(),'noisy trial completes');
 assert.deepEqual((await stored(page)).history[0].outcome,{A:1,B:1});
 await capture('noisy-mechanism',async({text,viewer,before})=>{
  assert.equal(before.history.length,1);
  assert.ok((await viewer.locator('[data-trial-id="1"]').innerText()).includes('Clamp A = ON (1).'));
  assert.ok(text.includes('Exact: 4/7'));assert.ok(text.includes('Exact: 3/7'));
 });
 const {createSession,observe,experiment,receiveSession}=await import(pathToFileURL(path.join(appRoot,'src/session.js')).href);
 let boundary=createSession({seed:123456789,title:'Maximum valid notebook: 58 watches and six interventions',activeWorldId:'A-causes-B'});
 while(boundary.history.length<58)boundary=observe(boundary,Math.min(12,58-boundary.history.length));
 for(let i=0;i<2;i++)boundary=experiment(boundary,{intervention:{A:1},prediction:.5,count:3});
 boundary.explanation='Evidence retained across the complete notebook. '.repeat(30).slice(0,1600);
 boundary=receiveSession(boundary);
 assert.equal(boundary.history.length,64);
 assert.equal(boundary.history.filter(e=>e.kind==='observe').length,58);
 assert.equal(boundary.history.filter(e=>e.kind==='intervene').length,6);
 await importReviewSession(boundary,'maximum-history');
 await capture('maximum-history',async({viewer,before,text})=>{
  assert.equal(before.history.length,64);assert.equal(await viewer.locator('[data-trial-id]').count(),64);
  assert.ok((await viewer.locator('[data-trial-id="64"]').innerText()).includes('Clamp A = ON (1)'));
  assert.ok(text.includes('Exact: 64/65'));assert.ok(text.includes('Exact: 1/65'));
 });
 for(const width of [1280,375]){
  await page.setViewportSize({width,height:850});await page.locator('.evidence-report-export').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('#save-evidence-report').isVisible());
  await page.screenshot({path:path.join(out,'app-journal-'+width+'.png')});
 }
 assert.deepEqual(receipts.errors,[]);assert.deepEqual(receipts.requests,[]);receipts.status='passed';
}catch(error){receipts.status='failed';receipts.failure=error.stack||String(error);process.exitCode=1;}
finally{await fs.writeFile(path.join(out,'receipts.json'),JSON.stringify(receipts,null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
console.log(JSON.stringify(receipts,null,2));
