import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=resolve(process.argv[2] || fileURLToPath(new URL('../',import.meta.url)));
const out=resolve(process.argv[3] || 'receipts/recovery'); await mkdir(out,{recursive:true});
const STORE='equivia.notebook.v1', rawDefault='unreadable original\n雪\u0000';
const hash=b=>createHash('sha256').update(b).digest('hex');
const sourceSha=hash(await readFile(join(root,'public/app.js')));
let app=null,browser=null,origin,stdout='',stderr='';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const results=[];
function recoveredText(text) {
  try {
    const value=JSON.parse(text);
    if (value?.schema==='equivia.saved-notebook-recovery.v1') {
      assert.deepEqual(Object.keys(value).sort(),['schema','storageKey','storedText']);
      assert.equal(value.storageKey,STORE);assert.equal(typeof value.storedText,'string');
      return value.storedText;
    }
  } catch(error) { if(error?.code==='ERR_ASSERTION')throw error; }
  return text;
}
try{
app=spawn(process.execPath,[join(root,'server.mjs')],{cwd:'/tmp',env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:'0'},stdio:['ignore','pipe','pipe']});
app.stdout.on('data',b=>stdout+=b);app.stderr.on('data',b=>stderr+=b);
for(let i=0;i<100;i++){const m=stdout.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){origin=m[0];break;}if(app.exitCode!==null)throw Error('App exited '+stderr);await pause(50);}
assert.ok(origin,'actual CLI started');assert.equal((await fetch(origin+'/api/config').then(r=>r.json())).model.configured,false);
browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE,headless:true,chromiumSandbox:true,args:['--disable-background-networking','--no-first-run','--no-default-browser-check']});

for(const mode of ['ordinary','read-once','utf16','postwrite-read','changed-during-backup','backup-readback-mismatch','read-import','full-slots','full-slots-match','backup-readback-throws']){
 const raw=mode==='utf16'?'broken\ud800X\udc00\n\u0000雪':rawDefault;
 const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}});
 const errors=[],blocked=[];
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked.push(route.request().url());return route.abort();});
 await context.addInitScript(({mode,raw,origin,STORE})=>{
  if(location.origin!==origin)return;
  const nativeGet=Storage.prototype.getItem,nativeSet=Storage.prototype.setItem;
  if(nativeGet.call(sessionStorage,'equivia.receiving.seeded')!=='1'){
    nativeSet.call(localStorage,STORE,raw);
    if(mode==='full-slots'||mode==='full-slots-match')for(let i=1;i<=8;i++)nativeSet.call(localStorage,STORE+'.recovery.'+i,mode==='full-slots-match'&&i===3?raw:'earlier original '+i);
    nativeSet.call(sessionStorage,'equivia.receiving.seeded','1');
  }
  let denied=false,afterMainWrite=false,afterBackupWrite=false;
  const writes=[],injections=[];
  Storage.prototype.getItem=function(k){
   if(this===localStorage&&k===STORE){
    if((mode==='read-once'||mode==='read-import')&&!denied){denied=true;injections.push('initial read denied');throw new DOMException('controlled initial read denial','SecurityError');}
    if(mode==='postwrite-read'&&afterMainWrite){afterMainWrite=false;injections.push('postwrite read denied');throw new DOMException('controlled replacement read denial','SecurityError');}
   }
   if(this===localStorage&&mode==='backup-readback-throws'&&afterBackupWrite&&k.startsWith(STORE+'.recovery.')){afterBackupWrite=false;injections.push('backup read denied');throw new DOMException('controlled backup read denial','SecurityError');}
   return nativeGet.call(this,k);
  };
  Storage.prototype.setItem=function(k,v){
   if(this===localStorage)writes.push({key:k,value:String(v)});
   if(this===localStorage&&k.startsWith(STORE+'.recovery.')&&mode==='backup-readback-mismatch'){
    nativeSet.call(this,k,String(v)+' changed');injections.push('backup changed');return;
   }
   nativeSet.call(this,k,v);
   if(this===localStorage&&k.startsWith(STORE+'.recovery.')&&mode==='changed-during-backup'){
    nativeSet.call(this,STORE,'newer other-window notebook');injections.push('concurrent main change');
   }
   if(this===localStorage&&k===STORE&&mode==='postwrite-read')afterMainWrite=true;
   if(this===localStorage&&k.startsWith(STORE+'.recovery.')&&mode==='backup-readback-throws')afterBackupWrite=true;
  };
  window.__receiveTruth=()=>({main:nativeGet.call(localStorage,STORE),backups:Array.from({length:8},(_,i)=>nativeGet.call(localStorage,STORE+'.recovery.'+(i+1))),writes:JSON.parse(JSON.stringify(writes)),injections:[...injections],status:document.querySelector('#status')?.textContent,saveStatus:document.querySelector('#save-status')?.textContent,recoveryVisible:!document.querySelector('#notebook-recovery')?.hidden,replaceVisible:!document.querySelector('#replace-unreadable')?.hidden,replaceDisabled:document.querySelector('#replace-unreadable')?.disabled,originalCodeUnits:Array.from({length:raw.length},(_,i)=>raw.charCodeAt(i))});
 },{mode,raw,origin,STORE});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const appResponse=page.waitForResponse(r=>r.url()===origin+'/app.js');
 await page.goto(origin+'/',{waitUntil:'networkidle'});
 const servedSha=hash(await(await appResponse).body());assert.equal(servedSha,sourceSha);
 const before=await page.evaluate(()=>window.__receiveTruth());
 let additional={};
 if(mode==='ordinary'){
  const entries=await page.locator('#journal-entries .journal-entry').count();
  await page.locator('#prediction-percent').fill('50');await page.locator('#run-one').click();
  await page.waitForFunction(n=>document.querySelectorAll('#journal-entries .journal-entry').length>n,entries);
  const temp=await page.evaluate(()=>window.__receiveTruth());
  additional.ordinaryPreserved=temp.main===raw&&temp.writes.filter(w=>w.key===STORE).length===0;
  const downloadPromise=page.waitForEvent('download');await page.locator('#download-unreadable').focus();await page.locator('#download-unreadable').press('Enter');
  const download=await downloadPromise;const file=join(out,'ordinary-original.txt');await download.saveAs(file);
  additional.downloadExact=recoveredText(await readFile(file,'utf8'))===raw;
  await page.locator('#replace-unreadable').focus();await page.locator('#replace-unreadable').press('Space');
  additional.focusAfterReplacement=await page.evaluate(()=>({tag:document.activeElement?.tagName,id:document.activeElement?.id}));
  additional.beforeReload=await page.evaluate(()=>window.__receiveTruth());
  const saved=additional.beforeReload.main;
  await page.reload({waitUntil:'networkidle'});
  additional.reopenedMainExact=(await page.evaluate(()=>window.__receiveTruth())).main===saved;
  const backupPromise=page.waitForEvent('download');await page.locator('#recovery-archive button').first().focus();await page.locator('#recovery-archive button').first().press('Enter');
  const backup=await backupPromise;const backupFile=join(out,'reopened-browser-recovery.json');await backup.saveAs(backupFile);
  additional.backupDownloadExact=recoveredText(await readFile(backupFile,'utf8'))===raw;
  await page.setViewportSize({width:375,height:844});
  additional.narrowGeometry=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(additional.narrowGeometry.scroll<=additional.narrowGeometry.viewport+1,'recovery panel overflows narrow viewport');
  await page.locator('#notebook-recovery').screenshot({path:join(out,'recovery-copies-375.png')});
 } else if(mode==='read-once'||mode==='read-import'){
  if(mode==='read-import'){
    const content=await page.evaluate(async()=>{const m=await import('/src/session.js');const s=m.createSession({seed:12345});s.explanation='Imported valid investigation';return m.serializeSession(s);});
    await page.locator('#notebook-file').setInputFiles({name:'valid-notebook.json',mimeType:'application/json',buffer:Buffer.from(content)});
    await page.waitForFunction(()=>document.querySelector('#learner-explanation').value==='Imported valid investigation');
    additional.validImportUsable=true;
  }
  await page.locator('#learner-explanation').fill('Useful temporary investigation');
  await page.locator('#observe').click();
  const downloadPromise=page.waitForEvent('download');await page.locator('#save-notebook').click();
  const download=await downloadPromise;const file=join(out,'read-failure-current-notebook.json');await download.saveAs(file);
  additional.temporaryExport=JSON.parse(await readFile(file,'utf8')).explanation==='Useful temporary investigation';
  await page.screenshot({path:join(out,'read-failure-1440.png'),fullPage:true});
  await page.setViewportSize({width:375,height:844});
  if(await page.locator('#notebook-recovery').isVisible())await page.locator('#notebook-recovery').screenshot({path:join(out,mode+'-375.png')});
 } else if(mode==='utf16'){
  const downloadPromise=page.waitForEvent('download');await page.locator('#download-unreadable').click();
  const download=await downloadPromise;const file=join(out,'utf16-original.txt');await download.saveAs(file);
  const text=await readFile(file,'utf8');
  const recovered=recoveredText(text);
  additional.downloadExact=recovered===raw;additional.downloadedCodeUnits=Array.from({length:recovered.length},(_,i)=>recovered.charCodeAt(i));
  additional.downloadSha256=hash(await readFile(file));
  await page.locator('#replace-unreadable').click();
 } else {
  await page.locator('#replace-unreadable').click();
  if(mode==='postwrite-read'){
    additional.unverifiedFocus=await page.evaluate(()=>document.activeElement?.id);
    const written=(await page.evaluate(()=>window.__receiveTruth())).main;
    await page.locator('#learner-explanation').fill('Continue after unverified replacement');
    additional.unverifiedMainPreserved=(await page.evaluate(()=>window.__receiveTruth())).main===written;
    await page.screenshot({path:join(out,'postwrite-read-failure-1440.png'),fullPage:true});
    await page.setViewportSize({width:375,height:844});await page.locator('#notebook-recovery').screenshot({path:join(out,'replacement-unverified-375.png')});
  }
 }
 const after=await page.evaluate(()=>window.__receiveTruth());
 const mainWrites=after.writes.filter(w=>w.key===STORE);
 const result={mode,sourceSha,servedSha,before,after,mainWrites:mainWrites.length,originalPreserved:after.main===raw,backupExact:after.backups.includes(raw),...additional,errors,blocked};
 if(mode==='ordinary')result.accepted=additional.ordinaryPreserved&&additional.downloadExact&&additional.reopenedMainExact&&additional.backupDownloadExact&&additional.focusAfterReplacement.id==='recovery-title'&&result.backupExact&&after.main!==raw&&mainWrites.length===1;
 if(mode==='read-once'||mode==='read-import')result.accepted=result.originalPreserved&&mainWrites.length===0&&additional.temporaryExport;
 if(mode==='utf16')result.accepted=additional.downloadExact&&result.backupExact;
 if(mode==='postwrite-read')result.accepted=result.backupExact&&!/^Saved notebook not replaced:/.test(after.status)&&after.replaceVisible&&after.replaceDisabled&&mainWrites.length===1&&additional.unverifiedMainPreserved&&additional.unverifiedFocus==='recovery-title';
 if(mode==='changed-during-backup')result.accepted=after.main==='newer other-window notebook'&&mainWrites.length===0&&result.backupExact&&/changed/.test(after.status);
 if(mode==='backup-readback-mismatch')result.accepted=result.originalPreserved&&mainWrites.length===0&&/could not be independently read back/.test(after.status);
 if(mode==='full-slots')result.accepted=result.originalPreserved&&mainWrites.length===0&&JSON.stringify(after.backups)===JSON.stringify(before.backups)&&/eight/.test(after.status);
 if(mode==='full-slots-match')result.accepted=result.backupExact&&mainWrites.length===1&&JSON.stringify(after.backups)===JSON.stringify(before.backups);
 if(mode==='backup-readback-throws')result.accepted=result.originalPreserved&&mainWrites.length===0&&result.backupExact&&/controlled backup read denial/.test(after.status);
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);results.push(result);await context.close();
}
const report={kind:'notebook-recovery-receiving',source:root,sourceSha,chrome:browser.version(),checks:results,candidate_qualified:results.every(x=>x.accepted),failures:results.filter(x=>!x.accepted).map(x=>x.mode),server:{origin,stdout,stderr}};
await writeFile(join(out,'recovery-receiving.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({sourceSha,checks:results.map(x=>({mode:x.mode,accepted:x.accepted,mainWrites:x.mainWrites,originalPreserved:x.originalPreserved,backupExact:x.backupExact,downloadExact:x.downloadExact,status:x.after.status,saveStatus:x.after.saveStatus,temporaryExport:x.temporaryExport})),candidate_qualified:report.candidate_qualified,report:join(out,'recovery-receiving.json')}));
if(!report.candidate_qualified)process.exitCode=1;
}catch(error){
 await writeFile(join(out,'incomplete-receiving.json'),JSON.stringify({source:root,sourceSha,completedChecks:results,error:String(error),stdout,stderr},null,2)+'\n');
 throw error;
}finally{
 if(browser)await browser.close();
 if(app&&app.exitCode===null){app.kill('SIGTERM');await Promise.race([once(app,'exit'),pause(3000)]);if(app.exitCode===null){app.kill('SIGKILL');await once(app,'exit');}}
}