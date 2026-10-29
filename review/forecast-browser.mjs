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
async function waitImported(page) {
  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent.trim().startsWith('Notebook reopened.')
  );
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
  await page.waitForFunction(value =>
    document.querySelector('#forecast-after strong')?.textContent.trim() === value, expected);
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

async function runChecks() {
  let { page, context } = await newPage();
  try {
    await record('keyboard estimate entry and focus metadata', async () => {
      await importFixture(page);
      await setupAction(page);
      await page.locator('#prediction-percent').focus();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.insertText('37');
      assert.equal(await page.locator('#prediction-percent').inputValue(), '37');
      report.keyboardFocus = await page.locator('#prediction-percent').evaluate(element => {
        const style = getComputedStyle(element);
        return {
          active: document.activeElement === element,
          focusVisible: element.matches(':focus-visible'),
          outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth,
          outlineColor: style.outlineColor, boxShadow: style.boxShadow,
          visualReview: 'pending'
        };
      });
      assert.equal(report.keyboardFocus.active, true);
      const filename = path.join(out, 'keyboard-focus.png');
      await page.screenshot({ path: filename, fullPage: true });
      report.screenshots.push({ path: filename, width: 1440, visualReview: 'pending', purpose: 'keyboard focus' });
    });
    await record('one-trial reflection uses entered estimate and before/after probabilities', async () => {
      await page.locator('#run-one').click({ noWaitAfter: true, timeout: 10000 });
      await waitAfter(page, '83.3%');
      assert.equal(await text(page, '#forecast-estimate strong'), '37%');
      await probability(page, '#forecast-before', 3, 4);
      await probability(page, '#forecast-after', 5, 6);
      assert.equal(await page.locator('#forecast-counts li[data-count]').count(), 0);
      assert.match(await text(page, '.forecast-context'), /held A on/);
      assert.match((await page.locator('.forecast-note').allTextContents()).join(' '),
        /hypothetical next trial with the same clamp/i);
    });
    await record('control edits cannot rewrite completed reflection', async () => {
      const before = await reflection(page);
      await page.locator('#prediction-percent').fill('81');
      await page.locator('input[name="target"][value="B"]').check();
      await page.locator('input[name="value"][value="0"]').check();
      assert.equal(await reflection(page), before);
    });
    await record('reload retains notebook without inventing historical reflection', async () => {
      const before = await storage(page);
      await page.reload({ waitUntil: 'load' });
      await absent(page);
      assert.deepEqual(await storage(page), before);
    });
    await record('valid import clears reflection and subsequent click uses imported history', async () => {
      await importFixture(page);
      await setupAction(page);
      await page.locator('#run-one').click({ noWaitAfter: true, timeout: 10000 });
      await waitAfter(page, '83.3%');
      const persisted = await storage(page);
      const candidates = Object.values(persisted).filter(value => {
        try { return receiveSession(value).history.some(row => row.kind === 'intervene'); }
        catch { return false; }
      });
      assert.equal(candidates.length, 1, 'Expected exactly one replay-valid stored session with intervention history');
      await page.locator('#notebook-file').setInputFiles({
        name: 'prior-intervention.json', mimeType: 'application/json', buffer: Buffer.from(candidates[0])
      });
      await waitImported(page);
      await setupAction(page);
      await page.locator('#run-one').click({ noWaitAfter: true, timeout: 10000 });
      await waitAfter(page, '90%');
      await probability(page, '#forecast-before', 5, 6);
      await probability(page, '#forecast-after', 9, 10);
    });
    await record('invalid import retains notebook and completed reflection', async () => {
      const beforeReflection = await reflection(page);
      const beforeStorage = await storage(page);
      await page.locator('#notebook-file').setInputFiles({
        name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{not valid JSON')
      });
      await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Could not open that notebook:'));
      assert.equal(await page.locator('#forecast-reflection').isVisible(), true);
      assert.equal(await reflection(page), beforeReflection);
      assert.deepEqual(await storage(page), beforeStorage);
    });
    await record('new investigation clears current-run reflection', async () => {
      await page.locator('#new-investigation').click();
      await absent(page);
    });
  } finally {
    await closeContext(context);
  }

  ({ page, context } = await newPage());
  try {
    await record('three-trial shared-world distribution and responsive screenshots', async () => {
      await importFixture(page);
      await setupAction(page, 37);
      await page.locator('#run-three').click({ noWaitAfter: true, timeout: 10000 });
      await waitAfter(page, '94.4%');
      assert.equal(await text(page, '#forecast-estimate strong'), '37%');
      await probability(page, '#forecast-before', 3, 4);
      await probability(page, '#forecast-after', 17, 18);
      assert.equal(await text(page, '.forecast-context'), '3 trials · held A on · B was on in 3 of 3.');
      assert.equal(await page.locator('#forecast-counts li[data-count]').count(), 4);
      for (const [k, n] of [1, 3, 3, 9].entries()) {
        const selector = `#forecast-counts li[data-count="${k}"]`;
        await probability(page, selector, n, 16);
        assert.ok((await text(page, selector)).includes(`${k} of 3 on`));
      }
      await screenshot(page, 'reflection-desktop.png', 1440);
      await screenshot(page, 'reflection-narrow.png', 375);
    });
    await record('second batch records updated posterior and its own estimate', async () => {
      await page.locator('#prediction-percent').fill('61');
      await page.locator('#run-three').click({ noWaitAfter: true, timeout: 10000 });
      await waitAfter(page, '99.2%');
      assert.equal(await text(page, '#forecast-estimate strong'), '61%');
      await probability(page, '#forecast-before', 17, 18);
      await probability(page, '#forecast-after', 129, 130);
      // Prior for this click is (8/9,1/9). Conditional fixed-world mixture:
      // K=0:1/72, K=1:1/24, K=2:1/24, K=3:65/72.
      for (const [k, n, d] of [[0, 1, 72], [1, 1, 24], [2, 1, 24], [3, 65, 72]]) {
        await probability(page, `#forecast-counts li[data-count="${k}"]`, n, d);
      }
      assert.equal(await text(page, '.forecast-context'), '3 trials · held A on · B was on in 3 of 3.');
    });
    await record('programmatic exhausted-budget rejection preserves completed reflection', async () => {
      assert.equal(await page.locator('#run-one').isDisabled(), true);
      assert.equal(await page.locator('#run-three').isDisabled(), true);
      const beforeReflection = await reflection(page);
      const beforeStorage = await storage(page);
      await page.locator('#run-one').dispatchEvent('click');
      await page.waitForFunction(() => /not enough experimental trials remaining/i.test(
        document.querySelector('#status')?.textContent || ''
      ));
      assert.equal(await page.locator('#status').evaluate(element => element.classList.contains('error')), true);
      assert.equal(await reflection(page), beforeReflection);
      assert.deepEqual(await storage(page), beforeStorage);
      assert.equal(await page.locator('#run-one').isDisabled(), true);
      report.capacityControlObservation = 'Programmatic click reached exhausted-budget rejection; error status appeared and storage and reflection remained unchanged.';
    });
  } finally {
    await closeContext(context);
  }
  assert.deepEqual(report.pageErrors, [], 'Unexpected page errors');
  assert.deepEqual(report.consoleErrors, [], 'Unexpected console errors');
  assert.deepEqual(report.unexpectedRequests, [], 'Unexpected browser requests');
  assert.ok(report.navigations.every(url => url === baseURL + '/'), 'Unexpected top-level navigation');
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
