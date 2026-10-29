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
  requestCount: 0, modelPosts: 0, cleanup: {}, screenshots: [], navigations: []
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
// Playwright waitForFunction injects string evaluation in some versions; retain
// the application's CSP and poll the same predicate through the existing evaluator.
async function waitPageState(page, predicate, argument, label) {
  const until = performance.now() + 10000;
  while (true) {
    checkDeadline();
    const remaining = until - performance.now();
    assert.ok(remaining > 0, label + ' timed out');
    if (await page.evaluate(predicate, argument)) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
  }
}
async function waitImported(page) {
  await waitText(page, '#status', value => value.trim().startsWith('Notebook reopened.'), 'Successful import status');
  await absent(page);
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
      if (route.request().method() === 'POST') {
        report.modelPosts++;
        report.unexpectedRequests.push({ url, method: 'POST' });
        await route.abort(); return;
      }
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

// Independent reference worlds: formulas below do not call the new comparison API.
function notebook(rootTable = [0, 1]) {
  const noiseBits = Math.log2(rootTable.length);
  const worlds = [
    { schema: 'equivia.scm.v1', id: 'independent-A', label: 'Independent A drives B', observed: ['A', 'B'], variables: [
      { id: 'A', parents: [], noiseBits, table: rootTable }, { id: 'B', parents: ['A'], noiseBits: 0, table: [0, 1] }] },
    { schema: 'equivia.scm.v1', id: 'independent-B', label: 'Independent B drives A', observed: ['A', 'B'], variables: [
      { id: 'B', parents: [], noiseBits, table: rootTable }, { id: 'A', parents: ['B'], noiseBits: 0, table: [0, 1] }] }
  ];
  return { schema: 'equivia.session.v1', title: 'Independent observation comparison', worlds,
    activeWorldId: worlds[0].id, initialSeed: 123, seed: 123, budget: 6,
    history: [], explanation: 'Matching alone does not settle which lamp drives the other.', revealed: false };
}
async function load(page, value) {
  receiveSession(JSON.stringify(value));
  await page.locator('#notebook-file').setInputFiles({ name: 'independent.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
  await waitPageState(page, expected => localStorage.getItem('equivia.notebook.v1') !== null && JSON.stringify(JSON.parse(localStorage.getItem('equivia.notebook.v1'))) === JSON.stringify(expected), value, 'Exact imported notebook storage');
  await waitImported(page);
}
async function openComparison(page) {
  if (await page.locator('#show-observation-comparison').getAttribute('aria-expanded') !== 'true') await page.locator('#show-observation-comparison').click();
  await page.locator('#observation-comparison').waitFor({ state: 'visible' });
}
async function snapshot(page) {
  return { storage: await storage(page), budget: await text(page, '#budget'), explanation: await page.locator('#learner-explanation').inputValue(), prediction: await page.locator('#prediction-percent').inputValue(), target: await page.locator('[name=target]:checked').inputValue(), value: await page.locator('[name=value]:checked').inputValue() };
}
async function rows(page) {
  return page.locator('#observation-comparison [data-world-id]').evaluateAll(elements => elements.map(e => ({
    worldId: e.dataset.worldId,
    seeing: e.querySelector('.observation-seeing')?.textContent,
    holding: e.querySelector('.observation-holding')?.textContent,
    support: e.querySelector('.observation-support')?.textContent
  })));
}
function expectedProbability(value, n, d) {
  assert.ok(value?.includes(percentage(n, d)), `Expected ${percentage(n, d)} in ${value}`);
  assert.ok(value.includes(d === 1 ? `(${n})` : `${n}/${d}`), `Expected exact ${n}/${d} in ${value}`);
}
async function checkRows(page, target, value, rootN = 1, rootD = 2) {
  const actual = await rows(page);
  assert.equal(actual.length, 2);
  for (const row of actual) {
    const drives = row.worldId === (target === 'A' ? 'independent-A' : 'independent-B');
    expectedProbability(row.seeing, value, 1);
    expectedProbability(row.holding, drives ? value : rootN, drives ? 1 : rootD);
    expectedProbability(row.support, value ? rootN : rootD - rootN, rootD);
  }
  report.comparisons ??= [];
  report.comparisons.push({ target, value, rootN, rootD, actual });
}
async function runChecks() {
  const { page, context } = await newPage();
  try {
    await record('keyboard disclosure preserves notebook, prediction, explanation, and budget', async () => {
      await load(page, notebook());
      await setupAction(page, 37);
      const before = await snapshot(page);
      const toggle = page.locator('#show-observation-comparison');
      assert.equal(await toggle.getAttribute('aria-controls'), 'observation-comparison');
      await toggle.focus();
      await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('#observation-comparison').isVisible(), true);
      await checkRows(page, 'A', 1);
      await page.keyboard.press('Space');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#observation-comparison').isVisible(), false);
      assert.deepEqual(await snapshot(page), before);
    });
    await record('all four selected actions show independent seeing and holding values', async () => {
      const before = await snapshot(page);
      await openComparison(page);
      for (const target of ['A', 'B']) for (const value of [0, 1]) {
        await page.locator('#observation-choice').selectOption(`${target}${value}`);
        await checkRows(page, target, value);
        assert.deepEqual(await snapshot(page), before);
      }
    });
    await record('inspector choices preserve laboratory controls and draft', async () => {
      await page.locator('#prediction-percent').fill('43');
      const before = await snapshot(page);
      for (const target of ['A', 'B']) for (const value of [0, 1]) {
        await page.locator('#observation-choice').selectOption(`${target}${value}`);
        await checkRows(page, target, value);
        assert.deepEqual(await snapshot(page), before);
      }
      await page.locator('#show-observation-comparison').click();
      await openComparison(page);
      assert.equal(await page.locator('#observation-choice').inputValue(), 'B1');
      assert.deepEqual(await snapshot(page), before);
    });
    await record('inspector condition survives trial changes and reopening', async () => {
      const beforeStorage = await storage(page);
      await page.locator('#observation-choice').selectOption('B0');
      await page.locator('input[name="target"][value="A"]').check();
      await page.locator('input[name="value"][value="0"]').check();
      await page.locator('input[name="value"][value="1"]').check();
      assert.equal(await page.locator('#observation-choice').inputValue(), 'B0');
      await checkRows(page, 'B', 0);
      await page.locator('#show-observation-comparison').click();
      assert.equal(await page.locator('#show-observation-comparison').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#observation-choice').isVisible(), false);
      await openComparison(page);
      assert.equal(await page.locator('#observation-choice').inputValue(), 'B0');
      assert.deepEqual(await storage(page), beforeStorage);
    });
    await record('keyboard selection retains focus and is read-only', async () => {
      const before = await snapshot(page);
      const select = page.locator('#observation-choice');
      await select.focus();
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowDown');
      assert.equal(await select.inputValue(), 'A0');
      assert.equal(await select.evaluate(element => element === document.activeElement), true);
      await checkRows(page, 'A', 0);
      assert.deepEqual(await snapshot(page), before);
      await page.keyboard.press('Shift+Tab');
      const toggle = page.locator('#show-observation-comparison');
      assert.equal(await toggle.evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Space');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await page.keyboard.press('Enter');
      assert.equal(await select.inputValue(), 'A0');
    });
    await record('existing full distribution comparison remains independent', async () => {
      await page.locator('#show-predictions').click();
      assert.equal(await page.locator('#prediction-comparison').isVisible(), true);
      const original = await text(page, '#prediction-comparison');
      await page.locator('#show-observation-comparison').click();
      assert.equal(await text(page, '#prediction-comparison'), original);
      assert.equal(await page.locator('#prediction-comparison').isVisible(), true);
      await openComparison(page);
      assert.equal(await text(page, '#prediction-comparison'), original);
    });
    await record('held-back biased worlds update exact original event support', async () => {
      await load(page, notebook([0, 1, 1, 1]));
      await openComparison(page);
      await page.locator('#observation-choice').selectOption('A0');
      await checkRows(page, 'A', 0, 3, 4);
      const before = await snapshot(page);
      for (const width of [1440, 640, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.locator('#observation-comparison').scrollIntoViewIfNeeded();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const filename = path.join(out, `observation-comparison-${width}.png`);
        await page.screenshot({ path: filename, fullPage: true, animations: 'disabled' });
        report.screenshots.push({ path: filename, width, visualReview: 'pending' });
        const detail = path.join(out, `observation-inspector-${width}.png`);
        await page.locator('#observation-comparison').screenshot({ path: detail, animations: 'disabled' });
        report.screenshots.push({ path: detail, width, purpose: 'inspector detail', visualReview: 'pending' });
      }
      assert.deepEqual(await snapshot(page), before);
    });
    await record('held-back noisy reverse mechanism gives 2/5 conditional probability', async () => {
      // Independent eight-noise-case enumeration supplied by source_review:
      // B=0 in six cases, A=1 in three of those; B=1 in two, A=1 in both.
      // Identical mechanisms with distinct IDs are permitted notebook candidates.
      const world = { schema: 'equivia.scm.v1', id: 'noisy-reverse-one', label: 'Noisy reverse one', observed: ['A', 'B'], variables: [
        { id: 'B', parents: [], noiseBits: 2, table: [0, 0, 0, 1] },
        { id: 'A', parents: ['B'], noiseBits: 1, table: [0, 1, 1, 1] }
      ] };
      const value = notebook();
      value.worlds = [world, { ...structuredClone(world), id: 'noisy-reverse-two', label: 'Noisy reverse two' }];
      value.activeWorldId = world.id;
      await load(page, value);
      await openComparison(page);
      const before = await snapshot(page);
      for (const [choice, supportN, watchedN, watchedD] of [['A1', 5, 2, 5], ['A0', 3, 0, 1]]) {
        await page.locator('#observation-choice').selectOption(choice);
        const actual = await rows(page);
        assert.equal(actual.length, 2);
        for (const row of actual) {
          expectedProbability(row.support, supportN, 8);
          expectedProbability(row.seeing, watchedN, watchedD);
          expectedProbability(row.holding, 1, 4);
        }
        report.noisyReverse ??= [];
        report.noisyReverse.push({ choice, actual });
        assert.deepEqual(await snapshot(page), before);
      }
    });
    await record('impossible observation is distinct from possible intervention and zero percent', async () => {
      await load(page, notebook([0]));
      await page.locator('input[name="target"][value="A"]').check();
      await page.locator('input[name="value"][value="1"]').check();
      const before = await snapshot(page);
      await openComparison(page);
      const actual = await rows(page);
      assert.equal(actual.length, 2);
      for (const row of actual) {
        expectedProbability(row.support, 0, 1);
        assert.match(row.seeing, /undefined|no .*(?:case|support)|never occurs|impossible/i);
        assert.doesNotMatch(row.seeing, /(?:^|\s)0%/);
        expectedProbability(row.holding, row.worldId === 'independent-A' ? 1 : 0, 1);
      }
      assert.deepEqual(await snapshot(page), before);
      report.zeroEvidence = actual;
    });
    await record('fresh investigation and notebook reopening replace stale comparisons', async () => {
      await page.locator('#new-investigation').click();
      await openComparison(page);
      const content = await text(page, '#observation-comparison');
      assert.doesNotMatch(content, /Independent [AB] drives/);
      await load(page, notebook());
      await openComparison(page);
      await page.locator('#observation-choice').selectOption('B0');
      await checkRows(page, 'B', 0);
      const before = await storage(page);
      await page.reload({ waitUntil: 'load' });
      await openComparison(page);
      assert.deepEqual(await storage(page), before);
      assert.match(await text(page, '#observation-comparison'), /Independent A drives B/);
    });
    await record('inspection remains usable after exhausted budget and reveal', async () => {
      await load(page, notebook());
      await setupAction(page, 75);
      for (let index = 0; index < 6; index++) {
        await page.locator('#run-one').click();
        await waitPageState(page, count => JSON.parse(localStorage.getItem('equivia.notebook.v1')).history.length === count, index + 1, 'Committed trial history');
      }
      assert.equal(await page.locator('#run-one').isDisabled(), true);
      await openComparison(page);
      const exhausted = await snapshot(page);
      await page.locator('#observation-choice').selectOption('B0');
      await checkRows(page, 'B', 0);
      assert.deepEqual(await snapshot(page), exhausted);
      await page.locator('#debrief').click();
      const revealed = await snapshot(page);
      assert.equal(JSON.parse(revealed.storage['equivia.notebook.v1']).revealed, true);
      await page.locator('#observation-choice').selectOption('A0');
      await checkRows(page, 'A', 0);
      assert.deepEqual(await snapshot(page), revealed);
    });
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.unexpectedRequests, []);
    assert.equal(report.modelPosts, 0);
  } finally { await closeContext(context); }
}

try {
  const { chromium } = await import(pathToFileURL(path.resolve(args.playwright)).href);
  const session = await import(pathToFileURL(path.join(appRoot, 'src/session.js')).href);
  receiveSession = session.receiveSession;
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
