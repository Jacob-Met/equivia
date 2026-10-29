import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!['--app-root', '--playwright', '--browser', '--out'].includes(key) || !value) {
    throw new Error('Usage: --app-root PATH --playwright ESM_FILE --browser PATH --out NEW_DIR');
  }
  args[key.slice(2)] = value;
}
for (const key of ['app-root', 'playwright', 'browser', 'out']) assert.ok(args[key], `Missing --${key}`);
const appRoot = path.resolve(args['app-root']);
const out = path.resolve(args.out);
// First filesystem mutation: refuse an existing evidence directory.
await fs.mkdir(out);
const report = {
  startedAt: new Date().toISOString(), appRoot,
  browserExecutable: path.resolve(args.browser), chromiumSandbox: true,
  checks: [], pageErrors: [], consoleErrors: [], unexpectedRequests: [],
  requestCount: 0, cleanup: {}, screenshots: [], navigations: []
};
let server;
let browser;
let browserServer;
let browserProcess;
let browserExit = null;
let ownedClose;
let baseURL;
let serverLog = '';
let serverExit = null;
let deadline;
let timedOut = false;
let deadlineClose;
let fixture;
let receiveSession;
let activePage;
function bounded(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })
  ]).finally(() => clearTimeout(timer));
}
function checkDeadline() {
  if (timedOut) throw new Error('Browser receiving exceeded its 60-second execution budget');
}

async function checkpoint(stage) {
  await fs.writeFile(path.join(out, 'lifecycle.json'), JSON.stringify({
    stage, at: new Date().toISOString(), serverPid: server?.pid,
    browserPid: browserProcess?.pid, browserExit,
    baseURL, checks: report.checks, cleanup: report.cleanup
  }, null, 2));
}
async function closeOwnedBrowser() {
  if (ownedClose) return ownedClose;
  ownedClose = (async () => {
    if (browser) {
      try { await bounded(browser.close(), 5000, 'Browser connection close'); }
      catch (error) { report.cleanup.browserConnectionError = String(error); }
    }
    if (!browserServer) return;
    try {
      await bounded(browserServer.close(), 15000, 'Owned browser server close');
      report.cleanup.browserServerGraceful = true;
    } catch (error) {
      report.cleanup.browserServerGraceful = false;
      report.cleanup.browserServerError = String(error);
      report.passed = false;
      try {
        await bounded(browserServer.kill(), 5000, 'Owned browser server kill');
        report.cleanup.browserForced = true;
      } catch (killError) { report.cleanup.browserKillError = String(killError); }
    }
    try {
      if (browserExit === null) await bounded(new Promise(resolve => {
        browserProcess.once('exit', (code, signal) => { browserExit = { code, signal }; resolve(); });
      }), 3000, 'Owned browser process exit');
      report.cleanup.browserClosed = browserExit !== null;
      report.cleanup.browserExit = browserExit;
      if (!report.cleanup.browserClosed) report.passed = false;
    } catch (error) { report.cleanup.browserExitError = String(error); report.passed = false; }
  })();
  return ownedClose;
}

async function record(name, fn) {
  checkDeadline();
  try { await fn(); }
  catch (error) {
    try {
      report.failureDOM = await bounded(activePage.evaluate(() => {
        let saved;
        try { saved = JSON.parse(localStorage.getItem('equivia.notebook.v1')); } catch {}
        return { status: document.querySelector('#status')?.textContent, budget: document.querySelector('#budget')?.textContent,
          result: document.querySelector('#experiment-result')?.textContent?.slice(0, 12000),
          historyLength: saved?.history?.length, interventions: saved?.history?.filter(event => event.kind === 'intervene').length };
      }), 3000, 'Failure state capture');
    } catch (captureError) { report.failureCaptureError = String(captureError); }
    await checkpoint('failed: ' + name);
    throw error;
  }
  checkDeadline();
  report.checks.push({ name, passed: true });
  await checkpoint(name);
}
const percentage = (n, d) => `${(100 * n / d).toFixed(1).replace(/\.0$/, '')}%`;
async function text(page, selector) {
  return (await page.locator(selector).innerText()).trim();
}
async function probability(page, selector, n, d) {
  assert.equal(await text(page, `${selector} strong`), percentage(n, d));
  assert.ok((await text(page, selector)).includes(`(${n}/${d})`), `${selector}: missing exact fraction ${n}/${d}`);
}
async function absent(page) {
  await page.locator('#experiment-result').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#forecast-reflection').isVisible(), false);
}
async function waitText(page, selector, predicate, label) {
  const until = performance.now() + 10000;
  while (true) {
    checkDeadline();
    let remaining = until - performance.now();
    assert.ok(remaining > 0, label + ' timed out');
    const value = await page.locator(selector).textContent({ timeout: Math.max(1, Math.ceil(remaining)) });
    checkDeadline();
    remaining = until - performance.now();
    assert.ok(remaining > 0, label + ' timed out');
    if (value !== null && predicate(value)) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
  }
}
async function waitImported(page) {
  await waitText(page, '#status', value => value.trim().startsWith('Notebook reopened.'), 'Successful import status');
  await absent(page);
}
async function importFixture(page) {
  await page.locator('#notebook-file').setInputFiles({
    name: 'reflection-fixture.json', mimeType: 'application/json', buffer: Buffer.from(fixture)
  });
  await waitImported(page);
}
async function setupAction(page, estimate = 37) {
  await page.locator('input[name="target"][value="A"]').check();
  await page.locator('input[name="value"][value="1"]').check();
  await page.locator('#prediction-percent').fill(String(estimate));
}
async function waitAfter(page, expected) {
  await page.locator('#forecast-reflection').waitFor({ state: 'visible' });
  await waitText(page, '#forecast-after strong', value => value.trim() === expected, 'Updated prediction');
}
async function reflection(page) {
  return page.locator('#forecast-reflection').innerText();
}
async function storage(page) {
  return page.evaluate(() => Object.fromEntries(
    Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)])
  ));
}
async function screenshot(page, name, width) {
  await page.setViewportSize({ width, height: 1000 });
  await page.locator('#forecast-reflection').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth), true,
  `Horizontal overflow at ${width}px`);
  const filename = path.join(out, name);
  await page.screenshot({ path: filename, fullPage: true });
  report.screenshots.push({ path: filename, width, visualReview: 'pending' });
}
async function newPage() {
  checkDeadline();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  try {
    checkDeadline();
    await context.route('**/*', async route => {
      const url = route.request().url();
      report.requestCount++;
      let allowed = false;
      try {
        const parsed = new URL(url);
        allowed = parsed.origin === new URL(baseURL).origin || ['data:', 'blob:', 'about:'].includes(parsed.protocol);
      } catch {}
      if (!allowed) {
        report.unexpectedRequests.push({ url, method: route.request().method() });
        await route.abort();
      } else {
        await route.continue();
      }
    });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(10000);
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) report.navigations.push(frame.url()); });
    page.on('pageerror', error => report.pageErrors.push(String(error)));
    page.on('console', message => {
      if (message.type() === 'error') report.consoleErrors.push(message.text());
    });
    await page.goto(baseURL, { waitUntil: 'load', timeout: 10000 });
    checkDeadline();
    return { page, context };
  } catch (error) {
    await bounded(context.close(), 5000, 'Failed setup context close').catch(closeError => {
      report.cleanup.contextError = String(closeError);
    });
    throw error;
  }
}
async function closeContext(context) {
  await bounded(context.close(), 5000, 'Context close');
}

const clone = value => JSON.parse(JSON.stringify(value));
const worldA = { schema: 'equivia.scm.v1', id: 'review-A-drives-B', label: 'Review: A drives B', observed: ['A', 'B'], variables: [
  { id: 'A', parents: [], noiseBits: 1, table: [0, 1] },
  { id: 'B', parents: ['A'], noiseBits: 0, table: [0, 1] },
] };
const worldB = { schema: 'equivia.scm.v1', id: 'review-B-drives-A', label: 'Review: B drives A', observed: ['A', 'B'], variables: [
  { id: 'B', parents: [], noiseBits: 1, table: [0, 1] },
  { id: 'A', parents: ['B'], noiseBits: 0, table: [0, 1] },
] };
// Authored here, not created by the application or its posterior implementation.
const controlledSession = { schema: 'equivia.session.v1', title: 'Independent direction review',
  worlds: [worldA, worldB], activeWorldId: worldA.id, initialSeed: 123456789,
  seed: 123456789, budget: 6, history: [], explanation: '', revealed: false };
const authorFixture = { schema: 'equivia.author.v1', title: 'Three-quarter lamps',
  worlds: [
    { ...clone(worldA), id: 'authored-A-drives-B', label: 'Three-quarter root A', variables: [
      { id: 'A', parents: [], noiseBits: 2, table: [0, 1, 1, 1] },
      { id: 'B', parents: ['A'], noiseBits: 0, table: [0, 1] },
    ] },
    { ...clone(worldB), id: 'authored-B-drives-A', label: 'Three-quarter root B', variables: [
      { id: 'B', parents: [], noiseBits: 2, table: [0, 1, 1, 1] },
      { id: 'A', parents: ['B'], noiseBits: 0, table: [0, 1] },
    ] },
  ], experiment: { intervention: { A: 1 } } };
async function waitPredicate(page, predicate, argument) {
  const until=performance.now()+10000;
  while (!(await page.evaluate(predicate,argument))) {
    checkDeadline();assert.ok(performance.now()<until,'Predicate wait timed out');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}
async function runChecks() {
  report.intentCases=[];
  const scenarios=['stale valid','stale invalid','stale model rejection','save visible pair','reverse completion','latest invalid','cancel picker','adoption while pending','same filename twice','model then file','file then model'];
  for(const scenario of scenarios) {
    const {page,context}=await newPage();
    try {
      const proposal=title=>({...structuredClone(authorFixture),title});
      await page.evaluate(()=>{
        const original=File.prototype.text;window.pendingReads=[];window.finishedReads=[];
        File.prototype.text=async function(){const contents=await original.call(this);
          const id=window.pendingReads.length;
          await new Promise(resolve=>window.pendingReads.push(resolve));
          setTimeout(()=>window.finishedReads.push(id),0);return contents;};
      });
      const upload=async(title,name='pair.json',invalid=false)=>{
        const id=await page.evaluate(()=>window.pendingReads.length);
        await page.locator('#world-file').setInputFiles({name,mimeType:'application/json',buffer:Buffer.from(invalid?'{invalid':JSON.stringify(proposal(title)))});
        await waitPredicate(page,id=>window.pendingReads.length>id,id);return id;};
      const finish=async id=>{await page.evaluate(id=>window.pendingReads[id](),id);await waitPredicate(page,id=>window.finishedReads.includes(id),id);};
      const title=()=>text(page,'#author-result h3');
      const seed=await upload('Previously validated');await finish(seed);
      assert.equal(await title(),'Previously validated');
      if(scenario==='model then file'||scenario==='file then model'||scenario==='stale model rejection') {
        // Local transport fixture only. No cloud credentials or model requests.
        await page.route('**/api/config',route=>route.fulfill({json:{model:{configured:true,model:'LOCAL-INTENT-STUB'}}}));
        // Reload resets the import hooks; re-install by retaining this scenario in a fresh page below is unnecessary:
        // config is refreshed only at initial load, so inject a new context via navigation before scheduling any reads.
        await page.reload();
        let releaseModel;
        const pendingModel=new Promise(resolve=>releaseModel=resolve);
        let seenModel;
        const modelStarted=new Promise(resolve=>seenModel=resolve);
        await page.route('**/api/author',async route=>{seenModel();await pendingModel;await route.fulfill({json:scenario==='stale model rejection'?{ok:false,error:{message:'TEST_STUB obsolete rejection'}}:{ok:true,proposal:proposal('Newest model'),metadata:{model:'TEST_STUB_NO_CLOUD'}}});});
        await page.locator('#world-brief').fill('Two matching lamps');
        if(scenario==='model then file'||scenario==='stale model rejection') {
          await page.locator('#propose-worlds').click();await modelStarted;
          await page.locator('#world-file').setInputFiles({name:'newest.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(proposal('Newest file')))});
          await waitPredicate(page,()=>document.querySelector('#author-result h3')?.textContent==='Newest file');
          const savedStatus=await text(page,'#status');
          releaseModel();
          await waitPredicate(page,()=>!document.querySelector('#propose-worlds').disabled);
          assert.equal(await title(),'Newest file');assert.equal(await text(page,'#status'),savedStatus);
        } else {
          await page.evaluate(()=>{const original=File.prototype.text;File.prototype.text=async function(){const text=await original.call(this);await new Promise(resolve=>window.releaseImport=resolve);return text;};});
          await page.locator('#world-file').setInputFiles({name:'old.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(proposal('Older file')))});
          await waitPredicate(page,()=>typeof window.releaseImport==='function');
          await page.locator('#propose-worlds').click();await modelStarted;const savedStatus=await text(page,'#status');
          releaseModel();
          await waitPredicate(page,()=>document.querySelector('#author-result h3')?.textContent==='Newest model');
          await page.evaluate(()=>{window.releaseImport();setTimeout(()=>window.importSettled=true,0);});
          await waitPredicate(page,()=>window.importSettled);
          assert.equal(await title(),'Newest model');
        }
      } else if(scenario==='save visible pair') {
        const before=await storage(page);const pending=await upload('Pending unpublished pair');
        const downloading=page.waitForEvent('download');
        await page.locator('#author-result').getByRole('button',{name:'Save this world pair'}).click();
        const download=await downloading;const filename=path.join(out,'visible-pair.json');await download.saveAs(filename);
        const bytes=await fs.readFile(filename,'utf8');
        assert.deepEqual(JSON.parse(bytes),proposal('Previously validated'));
        assert.ok(bytes.endsWith('\n'));assert.deepEqual(await storage(page),before);
        await finish(pending);assert.equal(await title(),'Pending unpublished pair');
        for(const width of [1440,390]) {
          await page.setViewportSize({width,height:1000});await page.locator('#author-result').scrollIntoViewIfNeeded();
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
          const filename=path.join(out,`authored-intent-${width}.png`);await page.screenshot({path:filename,fullPage:true});
          report.screenshots.push({path:filename,width,visualReview:'pending'});
        }
        assert.deepEqual(await storage(page),before);
      } else {
        const first=await upload('Older A','pair.json',scenario==='stale invalid');
        if(scenario==='cancel picker') {
          await page.locator('#world-file').setInputFiles([]);await finish(first);
          assert.equal(await title(),'Older A');
        } else if(scenario==='adoption while pending') {
          await page.locator('#author-result').getByRole('button',{name:'Open as a new investigation'}).click();
          const before=await storage(page);await finish(first);
          assert.deepEqual(await storage(page),before);
          assert.equal(await title(),'Previously validated');
        } else {
          const second=await upload('Newest B',scenario==='same filename twice'?'pair.json':'newer.json',scenario==='latest invalid');
          if(scenario==='stale valid'||scenario==='stale invalid') {
            await finish(second);const savedStatus=await text(page,'#status');await finish(first);
            assert.equal(await title(),'Newest B');assert.equal(await text(page,'#status'),savedStatus);
            await page.locator('#author-result').getByRole('button',{name:'Open as a new investigation'}).click();
            assert.equal(JSON.parse(await page.evaluate(()=>localStorage.getItem('equivia.notebook.v1'))).title,'Newest B');
          } else if(scenario==='reverse completion') {
            await finish(first);assert.equal(await title(),'Previously validated');
            await finish(second);assert.equal(await title(),'Newest B');
          } else {
            await finish(second);const beforeTitle=await title(),beforeStatus=await text(page,'#status');
            assert.equal(beforeTitle,scenario==='latest invalid'?'Previously validated':'Newest B');
            await finish(first);assert.equal(await title(),beforeTitle);assert.equal(await text(page,'#status'),beforeStatus);
          }
        }
      }
      report.intentCases.push({scenario,passed:true});await checkpoint(scenario);
    } catch(error) {report.intentCases.push({scenario,passed:false,error:String(error)});}
    finally {await closeContext(context);}
  }
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.unexpectedRequests,[]);
  assert.ok(report.intentCases.every(item=>item.passed),JSON.stringify(report.intentCases));
}

try {
  const { chromium } = await import(pathToFileURL(path.resolve(args.playwright)).href);
  const session = await import(pathToFileURL(path.join(appRoot, 'src/session.js')).href);
  receiveSession = session.receiveSession;
  fixture = session.serializeSession(session.createSession({ seed: 123, activeWorldId: 'A-causes-B' }));
  receiveSession(fixture);
  const env = { ...process.env, PORT: '0' };
  for (const key of ['NEBIUS_API_KEY', 'NEBIUS_MODEL', 'NEBIUS_BASE_URL']) delete env[key];
  server = spawn(process.execPath, [path.join(appRoot, 'server.mjs')], {
    cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe']
  });
  report.serverPid = server.pid;
  const serverCheckpoint = checkpoint('server-created');
  server.on('exit', (code, signal) => { serverExit = { code, signal }; });
  baseURL = await bounded(new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('exit', (code, signal) => reject(new Error(`Server exited before readiness: ${code}/${signal}`)));
    const consume = data => {
      serverLog = (serverLog + data.toString()).slice(-65536);
      const match = serverLog.match(/EQUIVIA ready at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) resolve(match[1]);
    };
    server.stdout.on('data', consume);
    server.stderr.on('data', consume);
  }), 10000, 'Server readiness');
  await serverCheckpoint;
  report.baseURL = baseURL;
  browserServer = await chromium.launchServer({
    executablePath: path.resolve(args.browser), headless: true,
    chromiumSandbox: true, timeout: 15000
  });
  browserProcess = browserServer.process();
  if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) browserExit = { code: browserProcess.exitCode, signal: browserProcess.signalCode };
  browserProcess.on('exit', (code, signal) => { browserExit = { code, signal }; });
  report.browserPid = browserProcess.pid;
  await checkpoint('browser-server-created');
  browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 15000 });
  report.browserVersion = browser.version();
  // Only this browser is launched. The deadline closes it to abort active
  // Playwright operations; runChecks itself is awaited through cleanup.
  deadline = setTimeout(() => {
    timedOut = true;
    report.deadlineExpired = true;
    deadlineClose = closeOwnedBrowser()
      .then(() => { report.cleanup.deadlineBrowserClosed = true; })
      .catch(error => { report.cleanup.deadlineBrowserError = String(error); });
  }, 60000);
  await runChecks();
  checkDeadline();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack || String(error);
} finally {
  clearTimeout(deadline);
  if (deadlineClose) await deadlineClose;
  await closeOwnedBrowser();
  if (server && server.pid) {
    const waitExit = () => serverExit ? Promise.resolve(serverExit) : new Promise(resolve => {
      server.once('exit', (code, signal) => resolve({ code, signal }));
    });
    try {
      if (!serverExit) {
        report.cleanup.serverSigintRequested = true;
        server.kill('SIGINT');
      }
      await bounded(waitExit(), 5000, 'Owned server SIGINT');
      assert.deepEqual(serverExit, { code: 0, signal: null }, 'Unexpected server exit');
      assert.equal(report.cleanup.serverSigintRequested, true, 'Server exited before requested cleanup');
      report.cleanup.serverGraceful = true;
    } catch (error) {
      report.cleanup.serverGraceful = false;
      report.cleanup.serverError = String(error);
      report.passed = false;
      if (!serverExit) {
        try {
          server.kill('SIGTERM');
          await bounded(waitExit(), 4000, 'Owned server SIGTERM');
          report.cleanup.serverForced = true;
        } catch (forcedError) {
          report.cleanup.serverForcedError = String(forcedError);
        }
      }
    }
    report.cleanup.serverExit = serverExit;
  }
  if (timedOut || report.cleanup.browserForced || report.cleanup.browserServerGraceful === false || (browserServer && !report.cleanup.browserClosed)) report.passed = false;
  await checkpoint('complete');
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(out, 'server.log'), serverLog);
  await fs.writeFile(path.join(out, 'receiving.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = report.passed ? 0 : 1;
}

