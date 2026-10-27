/** Actual receiving-browser evaluation. Drafted locally; execute only on the brokered owner.
 * EQUIVIA_APP_ROOT=/absolute/project PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs \
 *   node review/browser-review.mjs browser-review-output
 * Both servers bind ephemeral loopback ports. Provider replies are injected TEST
 * STUBS; no cloud model call or NVIDIA/Nebius qualification is performed here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const appRoot = path.resolve(process.env.EQUIVIA_APP_ROOT || fileURLToPath(new URL('../', import.meta.url)));
const outputDirectory = path.resolve(process.argv[2] || 'browser-review-output');
await fs.mkdir(outputDirectory, { recursive: true });
const { createServer } = await import(pathToFileURL(path.join(appRoot, 'server.mjs')).href);
const playwright = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href)
  : await import('playwright');
const { chromium } = playwright;
const STORE = 'equivia.notebook.v1';
const results = [], traffic = [], browserErrors = [], forbiddenRequests = [], stubCalls = [];
let browser, localServer, stubServer, releasePending, pendingNotice;
let stubMode = 'immediate';
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
const coachFixture = { schema: 'equivia.coach.v1', interpretation: 'correlation_direction',
  learnerQuote: 'they always match', question: 'compare_world_predictions',
  experimentId: 'hold-A-on', factIds: ['observational', 'experiment:hold-A-on'] };

async function injectedModel(request) {
  const call = { kind: 'TEST_STUB', purpose: request.purpose, index: stubCalls.length + 1 };
  stubCalls.push(call);
  if (stubMode === 'delayed') {
    await new Promise(resolve => { releasePending = resolve; pendingNotice?.(); });
    releasePending = undefined;
  }
  return { ok: true, content: JSON.stringify(request.purpose === 'coach' ? coachFixture : authorFixture),
    metadata: { provider: 'TEST_STUB_NO_CLOUD', model: 'REVIEW-STUB-NOT-A-MODEL', qualification: false } };
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function check(name, operation) {
  try { const evidence = await operation(); results.push({ name, passed: true, evidence: evidence ?? null }); }
  catch (error) { results.push({ name, passed: false, error: { name: error.name, message: error.message, stack: error.stack } }); }
}
async function stored(page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORE); }
async function ready(page) {
  await page.waitForFunction(key => {
    try { return Boolean(JSON.parse(localStorage.getItem(key))?.worlds?.length) && document.querySelectorAll('#hypothesis-list .hypothesis').length === 2; }
    catch { return false; }
  }, STORE);
  await page.waitForFunction(() => !document.querySelector('#model-status').textContent.includes('Checking'));
}
async function loadNotebook(page, value, name = 'review-notebook.json') {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  await page.locator('#notebook-file').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
}
async function waitStored(page, criteria) {
  await page.waitForFunction(({ key, criteria }) => {
    const value = JSON.parse(localStorage.getItem(key));
    return (criteria.events === undefined || value.history.length === criteria.events)
      && (criteria.interventions === undefined || value.history.filter(e => e.kind === 'intervene').length === criteria.interventions)
      && (criteria.title === undefined || value.title === criteria.title);
  }, { key: STORE, criteria });
}
async function openControlled(page) {
  await loadNotebook(page, controlledSession);
  await page.waitForFunction(({ key, id }) => JSON.parse(localStorage.getItem(key))?.activeWorldId === id,
    { key: STORE, id: worldA.id });
  assert.deepEqual(await stored(page), controlledSession);
}
async function predict(page, percent) { await page.locator('#prediction-percent').fill(String(percent)); }
async function screenshot(page, filename) {
  const target = path.join(outputDirectory, filename);
  await page.screenshot({ path: target, fullPage: true, animations: 'disabled' });
  return filename;
}
function nextSeed(seed) { return (Math.imul(seed, 1664525) + 1013904223) >>> 0; }
function verifyControlledReplay(session) {
  let seed = controlledSession.initialSeed;
  for (const [index, event] of session.history.entries()) {
    assert.equal(event.id, index + 1); assert.equal(event.beforeSeed, seed);
    seed = nextSeed(seed); assert.equal(event.afterSeed, seed);
    const noise = seed >>> 31;
    const a = Object.hasOwn(event.intervention, 'A') ? event.intervention.A : noise;
    const b = Object.hasOwn(event.intervention, 'B') ? event.intervention.B : a;
    assert.deepEqual(event.outcome, { A: a, B: b });
  }
  assert.equal(session.seed, seed);
}
async function newPage(origin, label) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.setDefaultNavigationTimeout(20000);
  page.on('pageerror', error => browserErrors.push({ page: label, type: 'pageerror', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push({ page: label, type: 'console', message: message.text() }); });
  page.on('response', response => traffic.push({ page: label, url: response.url(), status: response.status() }));
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || /^(blob:|data:)/.test(url)) return route.continue();
    forbiddenRequests.push({ page: label, url }); return route.abort('blockedbyclient');
  });
  await page.goto(origin + '/', { waitUntil: 'networkidle' }); await ready(page);
  return { page, context };
}

try {
  localServer = createServer({ env: {} });
  stubServer = createServer({ env: { NEBIUS_MODEL: 'REVIEW-STUB-NOT-A-MODEL', NEBIUS_API_KEY: 'review-stub-sentinel-not-a-real-key' }, invokeModel: injectedModel });
  const localOrigin = await listen(localServer), stubOrigin = await listen(stubServer);
  browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || '/usr/local/bin/google-chrome',
    headless: true, chromiumSandbox: true });
  const { page, context } = await newPage(localOrigin, 'local-real-entrypoint');

  await check('served entrypoint shows initial observational ambiguity without cloud', async () => {
    const notebook = await stored(page);
    assert.equal(notebook.history.length, 12); assert.equal(notebook.history.filter(e => e.kind === 'intervene').length, 0);
    assert.ok(notebook.history.every(e => e.outcome.A === e.outcome.B));
    assert.equal(await page.locator('#run-one').isDisabled(), true);
    assert.equal(await page.locator('#ask-guide').isDisabled(), true);
    assert.deepEqual(await page.locator('#hypothesis-list .weight').allTextContents(), ['50%', '50%']);
    return { historyLength: notebook.history.length, screenshot: await screenshot(page, 'desktop-1440-initial.png') };
  });

  await check('prediction is required and permits the correct 75% forecast', async () => {
    await openControlled(page);
    assert.equal(await page.locator('#prediction-percent').inputValue(), '');
    assert.equal(await page.locator('#run-one').isDisabled(), true);
    await predict(page, 75); assert.equal(await page.locator('#run-one').isEnabled(), true);
    const before = await stored(page); assert.equal(before.history.length, 0);
    await page.locator('#run-one').click();
    await waitStored(page, { events: 1 });
    const after = await stored(page); verifyControlledReplay(after);
    assert.equal(after.history[0].prediction, 0.75); assert.deepEqual(after.history[0].outcome, { A: 1, B: 1 });
    assert.equal(after.history.filter(e => e.kind === 'intervene').length, 1);
    assert.match(await page.locator('#budget').innerText(), /5 \/ 6/);
    assert.match(await page.locator('#hypothesis-list').innerText(), /Exact conditional weight 2\/3/);
    assert.match(await page.locator('#hypothesis-list').innerText(), /Exact conditional weight 1\/3/);
    assert.match(await page.locator('#experiment-result').innerText(), /Both explanations are still possible/);
    return { observed: after.history[0], expectedPosterior: ['2/3', '1/3'] };
  });

  let savedNotebook, savedPath;
  await check('save produces a portable exact replay, not a screen-only state', async () => {
    const downloadPromise = page.waitForEvent('download'); await page.locator('#save-notebook').click();
    const download = await downloadPromise; savedPath = path.join(outputDirectory, 'downloaded-notebook.json');
    await download.saveAs(savedPath); savedNotebook = JSON.parse(await fs.readFile(savedPath, 'utf8'));
    assert.deepEqual(savedNotebook, await stored(page)); verifyControlledReplay(savedNotebook);
    return { file: 'downloaded-notebook.json', events: savedNotebook.history.length };
  });

  await check('passive watching does not spend tokens or change direction weights', async () => {
    await page.locator('#observe').click(); await waitStored(page, { events: 9 });
    const notebook = await stored(page); verifyControlledReplay(notebook);
    assert.equal(notebook.history.filter(e => e.kind === 'intervene').length, 1);
    assert.match(await page.locator('#budget').innerText(), /5 \/ 6/);
    assert.match(await page.locator('#hypothesis-list').innerText(), /Exact conditional weight 2\/3/);
  });

  await check('finite budget accounts for every batch trial and blocks overspending', async () => {
    await predict(page, 75); await page.locator('#run-three').click();
    await waitStored(page, { interventions: 4 });
    assert.match(await page.locator('#budget').innerText(), /2 \/ 6/);
    assert.equal(await page.locator('#run-three').isDisabled(), true);
    await page.locator('#run-one').click(); await page.locator('#run-one').click();
    await waitStored(page, { interventions: 6 });
    const finished = await stored(page); verifyControlledReplay(finished);
    assert.match(await page.locator('#budget').innerText(), /0 \/ 6/);
    assert.equal(await page.locator('#run-one').isDisabled(), true); assert.equal(await page.locator('#run-three').isDisabled(), true);
    assert.match(await page.locator('#hypothesis-list').innerText(), /Exact conditional weight 64\/65/);
    await page.locator('#run-one').evaluate(button => button.click());
    assert.deepEqual(await stored(page), finished);
    return { interventions: 6, remaining: 0, expectedPosterior: ['64/65', '1/65'] };
  });

  await check('open and browser reload preserve verified notebook and exact weights', async () => {
    assert.ok(savedPath && savedNotebook, 'save case must have produced a notebook');
    await page.locator('#notebook-file').setInputFiles(savedPath);
    await waitStored(page, { events: 1 }); assert.deepEqual(await stored(page), savedNotebook);
    await page.reload({ waitUntil: 'networkidle' }); await ready(page);
    assert.deepEqual(await stored(page), savedNotebook); verifyControlledReplay(await stored(page));
    assert.match(await page.locator('#hypothesis-list').innerText(), /Exact conditional weight 2\/3/);
    assert.equal(await page.locator('#prediction-percent').inputValue(), '');
  });

  await check('malformed or tampered notebooks preserve the current investigation', async () => {
    const before = await stored(page);
    await loadNotebook(page, '{ this is invalid json', 'malformed.json');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Could not open'));
    assert.deepEqual(await stored(page), before);
    const tampered = clone(before); tampered.history[0].outcome.B = 0;
    await loadNotebook(page, tampered, 'tampered-outcome.json');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('executable world'));
    assert.deepEqual(await stored(page), before);
    return { invalidJsonPreserved: true, forgedOutcomePreserved: true };
  });

  await check('changing intervention requires a fresh prediction', async () => {
    await predict(page, 75); await page.locator('[name="target"][value="B"]').check();
    assert.equal(await page.locator('#prediction-percent').inputValue(), '');
    assert.equal(await page.locator('#run-one').isDisabled(), true);
    assert.match(await page.locator('#prediction-question').innerText(), /A/);
    await page.locator('[name="target"][value="A"]').check();
  });

  await check('author file import requires exact proof and explicit adoption', async () => {
    const before = await stored(page);
    const invalid = clone(authorFixture); invalid.worlds[1].variables[0].table = [0, 0, 0, 0];
    await page.locator('#world-file').setInputFiles({ name: 'invalid-worlds.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('different observational'));
    assert.deepEqual(await stored(page), before);
    await page.locator('#world-file').setInputFiles({ name: 'authored-worlds.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(authorFixture)) });
    await page.locator('#author-result').waitFor({ state: 'visible' });
    assert.match(await page.locator('#author-result').innerText(), /Exact check passed/);
    assert.deepEqual(await stored(page), before, 'proof display must not silently replace the investigation');
    await page.locator('#author-result').getByRole('button', { name: 'Open as a new investigation' }).click();
    await waitStored(page, { title: 'Three-quarter lamps' });
    const adopted = await stored(page); assert.deepEqual(adopted.worlds, authorFixture.worlds);
    assert.equal(adopted.history.filter(e => e.kind === 'intervene').length, 0);
    assert.match(await page.locator('.observation-note').innerText(), /3\/4/);
    assert.match(await page.locator('#budget').innerText(), /6 \/ 6/);
    return { title: adopted.title, observationalProbability11: '3/4', explicitAdoption: true };
  });

  await check('custom authored rules remain correctly described after reopening', async () => {
    const before = await stored(page); await page.reload({ waitUntil: 'networkidle' }); await ready(page);
    assert.deepEqual(await stored(page), before);
    assert.match(await page.locator('.observation-note').innerText(), /3\/4/);
    assert.doesNotMatch(await page.locator('.method').innerText(), /root lamp is a fair random bit/i,
      'a custom 3/4 root cannot be described as the original fair-root lesson after reload');
  });

  await check('desktop and narrow mobile render without horizontal overflow', async () => {
    const screenshots = [];
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: width === 375 ? 900 : 1000 });
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      assert.ok(geometry.document <= geometry.viewport + 1 && geometry.body <= geometry.viewport + 1, JSON.stringify(geometry));
      screenshots.push(await screenshot(page, `real-ui-${width}.png`));
      assert.equal(await page.locator('#prediction-percent').isVisible(), true);
    }
    return { screenshots };
  });
  await context.close();

  const second = await newPage(stubOrigin, 'injected-model-TEST-STUB');
  const guidePage = second.page;
  await check('reviewable guide interpretation can be rejected without spending a trial', async () => {
    await guidePage.locator('#learner-explanation').fill('I think A controls B because they always match.');
    const before = await stored(guidePage); await guidePage.locator('#ask-guide').click();
    await guidePage.locator('#guide-advice').waitFor({ state: 'visible' });
    assert.match(await guidePage.locator('#guide-advice').innerText(), /possible reading/i);
    assert.deepEqual(await stored(guidePage), before);
    await guidePage.locator('#guide-advice').getByRole('button', { name: 'That is not what I meant' }).click();
    assert.equal(await guidePage.locator('#guide-advice').isHidden(), true);
    assert.deepEqual(await stored(guidePage), before);
    assert.equal(await guidePage.locator('#learner-explanation').evaluate(input => document.activeElement === input), true);
    return { fixture: 'TEST_STUB_NO_CLOUD', mutations: 0 };
  });

  await check('guide suggestion selects an experiment but still requires prediction', async () => {
    await predict(guidePage, 75); const before = await stored(guidePage);
    await guidePage.locator('#ask-guide').click(); await guidePage.locator('#guide-advice').waitFor({ state: 'visible' });
    await guidePage.locator('#guide-advice').getByRole('button', { name: /^Consider:/ }).click();
    assert.equal(await guidePage.locator('#prediction-percent').inputValue(), '');
    assert.equal(await guidePage.locator('#run-one').isDisabled(), true);
    assert.deepEqual(await stored(guidePage), before);
    return { fixture: 'TEST_STUB_NO_CLOUD', executionRequiresLearnerAction: true };
  });

  await check('delayed guide response is discarded after the learner changes state', async () => {
    stubMode = 'delayed';
    const requestReached = new Promise(resolve => { pendingNotice = resolve; });
    let requestTimer;
    try {
      await guidePage.locator('#ask-guide').click();
      await Promise.race([requestReached, new Promise((_, reject) => { requestTimer = setTimeout(() => reject(new Error('Injected request never reached the server')), 10000); })]);
      clearTimeout(requestTimer);
      await guidePage.locator('#learner-explanation').fill('They always match, but I am reconsidering the direction.');
      const changed = await stored(guidePage); releasePending();
      await guidePage.waitForFunction(() => document.querySelector('#status').textContent.includes('changed while the guide'));
      assert.equal(await guidePage.locator('#guide-advice').isHidden(), true);
      assert.deepEqual(await stored(guidePage), changed);
      return { fixture: 'TEST_STUB_NO_CLOUD', staleResponseDiscarded: true };
    } finally {
      clearTimeout(requestTimer); releasePending?.(); stubMode = 'immediate'; pendingNotice = undefined;
    }
  });

  await check('injected author response passes engine proof before adoption', async () => {
    const before = await stored(guidePage);
    await guidePage.locator('#world-brief').fill('TEST STUB: two three-quarter root mechanisms with equal observations.');
    await guidePage.locator('#propose-worlds').click(); await guidePage.locator('#author-result').waitFor({ state: 'visible' });
    assert.match(await guidePage.locator('#author-result').innerText(), /Exact check passed/);
    assert.deepEqual(await stored(guidePage), before);
    return { fixture: 'TEST_STUB_NO_CLOUD', proofVisible: true,
      screenshot: await screenshot(guidePage, 'stub-provider-proof-NO-CLOUD.png') };
  });
  await second.context.close();

  await check('actual pages have no browser errors or unexpected requests', async () => {
    assert.deepEqual(browserErrors, []); assert.deepEqual(forbiddenRequests, []);
    const failingResponses = traffic.filter(r => r.status >= 400);
    assert.deepEqual(failingResponses, []);
    assert.ok(stubCalls.some(c => c.purpose === 'coach') && stubCalls.some(c => c.purpose === 'author'));
    return { pageErrors: 0, unexpectedRequests: 0, failedHttpResponses: 0,
      stubCalls: stubCalls.length, cloudProviderCalls: 0 };
  });
} catch (error) {
  results.push({ name: 'browser harness completed', passed: false, error: { name: error.name, message: error.message, stack: error.stack } });
} finally {
  releasePending?.();
  await browser?.close().catch(() => {});
  for (const server of [localServer, stubServer]) if (server) {
    server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
  }
  const report = { evaluator: 'EQUIVIA actual receiving-browser review v1', executed: true,
    generatedAt: new Date().toISOString(), sandboxRequested: true,
    providerEvidence: 'TEST STUBS ONLY. No cloud model invocation, no NVIDIA/Nebius qualification.',
    total: results.length, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length,
    results, browserErrors, forbiddenRequests, traffic, stubCalls };
  await fs.writeFile(path.join(outputDirectory, 'browser-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed,
    failures: results.filter(r => !r.passed).map(r => ({ name: r.name, message: r.error.message })), outputDirectory }, null, 2));
  process.exitCode = report.failed ? 1 : 0;
}
