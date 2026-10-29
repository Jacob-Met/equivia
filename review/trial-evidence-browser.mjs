import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
async function storage(page) {
  return page.evaluate(() => Object.fromEntries(
    Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)])
  ));
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
        allowed = ['GET', 'HEAD'].includes(route.request().method()) && (parsed.origin === new URL(baseURL).origin || ['data:', 'blob:', 'about:'].includes(parsed.protocol));
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

const panel = (page, id) => page.locator(`.trial-evidence[data-event-id="${id}"]`);
async function openEvidence(page, id) {
  const details = panel(page, id);
  if (!await details.evaluate(node => node.open)) await details.locator('summary').click();
  await details.locator('.trial-evidence-model').first().waitFor();
  return details;
}
async function exactRow(page, id, world, field, fraction) {
  const dd = panel(page, id).locator(`.trial-evidence-model[data-world-id="${world}"] dd[data-field="${field}"]`);
  await dd.waitFor();
  assert.ok((await dd.innerText()).endsWith(`(${fraction})`), `${id}/${world}/${field}: expected ${fraction}, got ${await dd.innerText()}`);
}
async function trial(page, id, beforeA, beforeB, afterA, afterB) {
  await openEvidence(page, id);
  for (const [world, before, after, chance] of [
    ['A-causes-B', beforeA, afterA, '1'], ['B-causes-A', beforeB, afterB, '1/2']
  ]) for (const [field, value] of [['before', before], ['likelihood', chance], ['after', after]]) {
    await exactRow(page, id, world, field, value);
  }
}
async function evidenceScreenshot(page, name, width) {
  await page.setViewportSize({ width, height: 1000 });
  await panel(page, 13).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `Horizontal overflow at ${width}px`);
  const filename = path.join(out, name);
  await page.screenshot({ path: filename, fullPage: true });
  report.screenshots.push({ path: filename, width, visualReview: 'pending' });
}
async function runChecks() {
  let { page, context } = await newPage();
  let downloaded;
  try {
    await record('import actual replay-valid notebook and run first trial', async () => {
      await importFixture(page);
      await setupAction(page);
      await page.locator('#run-one').click();
      await panel(page, 13).waitFor();
      await trial(page, 13, '1/2', '1/2', '2/3', '1/3');
    });
    await record('keyboard disclosure preserves all stored notebook bytes', async () => {
      const before = await storage(page);
      const summary = panel(page, 13).locator('summary');
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.equal(await panel(page, 13).evaluate(node => node.open), false);
      await page.keyboard.press('Space');
      await panel(page, 13).locator('.trial-evidence-model').first().waitFor();
      assert.equal(await panel(page, 13).evaluate(node => node.open), true);
      assert.equal(await summary.evaluate(node => document.activeElement === node), true);
      assert.deepEqual(await storage(page), before);
    });
    await record('second trial updates its own weights and leaves first evidence unchanged', async () => {
      await page.locator('#prediction-percent').fill('75');
      await page.locator('#run-one').click();
      await panel(page, 14).waitFor();
      await trial(page, 14, '2/3', '1/3', '4/5', '1/5');
      await trial(page, 13, '1/2', '1/2', '2/3', '1/3');
      await evidenceScreenshot(page, 'trial-evidence-desktop.png', 1440);
      await evidenceScreenshot(page, 'trial-evidence-narrow.png', 390);
    });
    await record('actual download keeps canonical notebook unchanged by inspection', async () => {
      const before = await storage(page);
      const promise = page.waitForEvent('download');
      await page.locator('#save-notebook').click();
      const download = await promise;
      const file = path.join(out, 'downloaded-notebook.json');
      await download.saveAs(file);
      downloaded = await fs.readFile(file, 'utf8');
      assert.equal(downloaded, before['equivia.notebook.v1']);
      receiveSession(downloaded);
      assert.deepEqual(await storage(page), before);
    });
    await record('invalid import preserves historical evidence and stored notebook', async () => {
      const before = await storage(page);
      const explanation = await panel(page, 13).innerText();
      await page.locator('#notebook-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
      await waitText(page, '#status', value => value.includes('Could not open that notebook:'), 'Rejected import');
      assert.deepEqual(await storage(page), before);
      assert.equal(await panel(page, 13).innerText(), explanation);
    });
  } finally { await closeContext(context); }
  ({ page, context } = await newPage());
  try {
    await record('fresh browser context reopens actual download and historical evidence', async () => {
      assert.equal(await page.locator('.trial-evidence').count(), 0);
      await page.locator('#notebook-file').setInputFiles({ name: 'downloaded-notebook.json', mimeType: 'application/json', buffer: Buffer.from(downloaded) });
      await waitImported(page);
      await trial(page, 13, '1/2', '1/2', '2/3', '1/3');
      await trial(page, 14, '2/3', '1/3', '4/5', '1/5');
    });
    await record('passive observations preserve weights and journal uses full history indices', async () => {
      await page.locator('#observe').click();
      await waitText(page, '#status', value => value.startsWith('Eight more'), 'Passive observations');
      await setupAction(page);
      await page.locator('#run-one').click();
      await panel(page, 23).waitFor();
      await trial(page, 23, '4/5', '1/5', '8/9', '1/9');
      await trial(page, 13, '1/2', '1/2', '2/3', '1/3');
    });
    await record('finish keeps historical evidence inspectable without changing replay', async () => {
      await page.locator('#debrief').click();
      await page.locator('#debrief-content').waitFor({ state: 'visible' });
      const before = await storage(page);
      await trial(page, 13, '1/2', '1/2', '2/3', '1/3');
      assert.deepEqual(await storage(page), before);
      assert.equal(await page.locator('#run-one').isDisabled(), true);
    });
    await record('new investigation clears every old disclosure', async () => {
      await page.locator('#new-investigation').click();
      assert.equal(await page.locator('.trial-evidence').count(), 0);
      assert.equal(await page.locator('#debrief-content').isVisible(), false);
    });
  } finally { await closeContext(context); }
  assert.deepEqual(report.pageErrors, [], 'Unexpected page errors');
  assert.deepEqual(report.consoleErrors, [], 'Unexpected console errors');
  assert.deepEqual(report.unexpectedRequests, [], 'External or mutating browser request');
  assert.ok(report.navigations.every(url => url === baseURL + '/'), 'Unexpected top-level navigation');
}

try {
  const { chromium } = await import(pathToFileURL(path.resolve(args.playwright)).href);
  const session = await import(pathToFileURL(path.join(appRoot, 'src/session.js')).href);
  receiveSession = session.receiveSession;
  fixture = session.serializeSession(session.createSession({ seed: 123, activeWorldId: 'A-causes-B' }));
  receiveSession(fixture);
  report.sourceHashes = {};
  for (const relative of ['server.mjs', 'src/engine.js', 'src/session.js', 'src/trial-evidence.js', 'public/app.js']) {
    report.sourceHashes[relative] = createHash('sha256').update(await fs.readFile(path.join(appRoot, relative))).digest('hex');
  }
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
