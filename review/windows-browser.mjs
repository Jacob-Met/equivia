/** Receives an already-running extracted Windows package; does not start a surrogate server. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const flags = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]; assert(key?.startsWith('--') && process.argv[i + 1]); assert(!Object.hasOwn(flags, key.slice(2)));
  flags[key.slice(2)] = process.argv[i + 1];
}
for (const key of ['origin', 'out', 'baseline', 'fixture']) assert(flags[key], 'Missing --' + key);
assert(Object.keys(flags).every(k => ['origin', 'out', 'baseline', 'fixture'].includes(k)));
assert(process.env.PLAYWRIGHT_MODULE && process.env.CHROME_EXECUTABLE);
const originURL = new URL(flags.origin);
assert.equal(originURL.protocol, 'http:'); assert.equal(originURL.hostname, '127.0.0.1');
assert.equal(originURL.pathname, '/'); assert(!originURL.search && !originURL.hash && !originURL.username && !originURL.password);
const origin = originURL.origin, out = path.resolve(flags.out);
const baseline = JSON.parse(await readFile(flags.baseline, 'utf8'));
const fixtureBytes = await readFile(flags.fixture), fixture = JSON.parse(fixtureBytes);
const required = ['/', '/app.js', '/styles.css', '/src/engine.js', '/src/model.js', '/src/session.js'];
for (const route of required) assert.match(baseline[route] ?? '', /^[a-f0-9]{64}$/i);
await mkdir(out); await mkdir(path.join(out, 'responses'));
const hash = b => createHash('sha256').update(b).digest('hex'), storageKey = 'equivia.notebook.v1';
const report = { startedAt: new Date().toISOString(), sourceOrigin: origin, platform: process.platform, architecture: process.arch,
  sandboxRequested: true, executablePath: process.env.CHROME_EXECUTABLE, fixtureSHA256: hash(fixtureBytes), baseline,
  checks: [], responses: [], screenshots: [], requests: [], unexpectedRequests: [], pageErrors: [], consoleErrors: [], failedRequests: [],
  limitations: ['Headless native Windows browser in an isolated ephemeral context.',
    'Interactive Explorer/default-browser launch and persistent profile reopening are untested.',
    'Malformed notebooks, import races, and live providers are outside this receiving scope.'] };
let browser, context, page, failure, responseSequence = 0;
const pending = new Set(), captureErrors = [];
function track(promise) {
  pending.add(promise);
  promise.then(() => pending.delete(promise), error => { captureErrors.push(String(error)); pending.delete(promise); });
}
async function drain() { while (pending.size) await Promise.allSettled([...pending]); }
async function check(name, fn) {
  try { report.checks.push({ name, passed: true, evidence: await fn() }); }
  catch (e) { report.checks.push({ name, passed: false, error: String(e) }); throw e; }
}
async function notebook() { return page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey); }
async function importBytes(bytes, name) { await page.locator('#notebook-file').setInputFiles({ name, mimeType: 'application/json', buffer: bytes }); }
async function waitStoredEqual(expected) {
  await page.waitForFunction(({ key, expected }) => {
    function canonical(x) {
      if (Array.isArray(x)) return x.map(canonical);
      if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
      return x;
    }
    const raw = localStorage.getItem(key);
    return raw !== null && JSON.stringify(canonical(JSON.parse(raw))) === JSON.stringify(canonical(expected));
  }, { key: storageKey, expected });
}
async function screenshot(name) {
  const file = name + '.png'; await page.screenshot({ path: path.join(out, file), fullPage: true, animations: 'disabled' }); report.screenshots.push(file);
}
async function geometry() {
  const g = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  assert(g.content <= g.viewport + 1, 'Horizontal overflow: ' + JSON.stringify(g)); return g;
}
function verifyResponses() {
  for (const route of required) {
    const matches = report.responses.filter(r => new URL(r.url).pathname === route); assert(matches.length, 'Required response missing: ' + route);
    for (const r of matches) { assert.equal(r.status, 200); assert.equal(r.sha256, baseline[route].toLowerCase(), 'Committed response mismatch: ' + route); }
  }
  assert.deepEqual(captureErrors, []);
}
try {
  const module = await import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href);
  const chromium = module.chromium ?? module.default?.chromium; assert(chromium);
  browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true, chromiumSandbox: true });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) await route.continue();
    else { report.unexpectedRequests.push(url.href); await route.abort('blockedbyclient'); }
  });
  page = await context.newPage(); page.setDefaultTimeout(12000); page.setDefaultNavigationTimeout(20000);
  page.on('request', r => report.requests.push({ url: r.url(), method: r.method(), resourceType: r.resourceType() }));
  page.on('requestfailed', r => report.failedRequests.push({ url: r.url(), error: r.failure()?.errorText }));
  page.on('pageerror', e => report.pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  page.on('response', response => {
    const url = new URL(response.url()); if (url.origin !== origin || !required.includes(url.pathname)) return;
    const index = responseSequence++;
    track((async () => {
      try {
        const body = await response.body(), file = 'responses/' + index + '-' + (url.pathname === '/' ? 'index.html' : url.pathname.slice(1).replaceAll('/', '_'));
        await writeFile(path.join(out, file), body);
        report.responses.push({ url: url.href, status: response.status(), sha256: hash(body), bytes: body.length, file });
      } catch (e) { report.responses.push({ url: url.href, error: String(e) }); }
    })());
  });
  await check('actual packaged entry point and committed response bytes', async () => {
    const response = await page.goto(origin, { waitUntil: 'networkidle' }); assert(response?.ok()); await drain(); verifyResponses(); return { required };
  });
  await check('fresh desktop entry and offline controls', async () => {
    await page.waitForFunction(() => !/checking/i.test(document.querySelector('#model-status')?.textContent ?? 'checking'));
    const stored = await notebook(); assert.equal(stored.history.length, 12);
    assert.equal(await page.locator('#run-one').isDisabled(), true); assert.equal(await page.locator('#ask-guide').isDisabled(), true);
    assert.deepEqual(await page.locator('#hypothesis-list .weight').allTextContents(), ['50%', '50%']);
    const g = await geometry(); await screenshot('01-desktop-entry'); return g;
  });
  await check('controlled valid notebook import', async () => {
    await importBytes(fixtureBytes, 'controlled-notebook.json'); await waitStoredEqual(fixture); assert.deepEqual(await notebook(), fixture);
    return { exactFixture: true };
  });
  await check('one controlled intervention and exact posterior', async () => {
    await page.locator('[name=target][value=A]').check(); await page.locator('[name=value][value="1"]').check();
    await page.locator('#prediction-percent').fill('75'); await page.locator('#run-one').click();
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key))?.history?.length === 1, storageKey);
    const state = await notebook(), last = state.history[0];
    assert.deepEqual(last.outcome, { A: 1, B: 1 }); assert.equal(last.prediction, 0.75); assert.deepEqual(last.intervention, { A: 1 });
    assert.match(await page.locator('#budget').innerText(), /5\s*\/\s*6/);
    assert.match(await page.locator('#hypothesis-list').innerText(), /Exact conditional weight 2\/3/);
    assert.match(await page.locator('#hypothesis-list').innerText(), /Exact conditional weight 1\/3/);
    const result = await page.locator('#experiment-result').innerText(); assert.match(result, /Both explanations are still possible/);
    await screenshot('02-desktop-intervention'); return { last, result, weights: await page.locator('#hypothesis-list .weight').allTextContents() };
  });
  let saved, downloaded;
  await check('saved notebook equals stored session', async () => {
    saved = await notebook(); const pendingDownload = page.waitForEvent('download'); await page.locator('#save-notebook').click();
    const download = await pendingDownload, file = 'saved-notebook.json'; await download.saveAs(path.join(out, file)); downloaded = await readFile(path.join(out, file));
    assert.deepEqual(JSON.parse(downloaded), saved); return { file, sha256: hash(downloaded) };
  });
  await check('same-origin reload preserves exact session', async () => {
    await page.reload({ waitUntil: 'networkidle' }); assert.equal(new URL(page.url()).origin, origin);
    await waitStoredEqual(saved); assert.deepEqual(await notebook(), saved); await screenshot('03-desktop-reopened');
  });
  await check('saved download reimports unchanged', async () => { await importBytes(downloaded, 'saved-notebook.json'); await waitStoredEqual(saved); assert.deepEqual(await notebook(), saved); });
  await check('keyboard disclosures reflect controlled panels', async () => {
    const parent = page.locator('details.method');
    if (!(await parent.getAttribute('open') !== null)) { await parent.locator('summary').focus(); await page.keyboard.press('Enter'); }
    for (const [buttonId, panelId] of [['show-predictions', 'prediction-comparison'], ['inspect-worlds', 'world-source']]) {
      const button = page.locator('#' + buttonId), panel = page.locator('#' + panelId);
      assert.equal(await button.getAttribute('aria-controls'), panelId); assert.equal(await button.getAttribute('aria-expanded'), 'false'); assert.equal(await panel.isHidden(), true);
      await button.focus(); await page.keyboard.press('Enter'); assert.equal(await button.getAttribute('aria-expanded'), 'true'); assert.equal(await panel.isVisible(), true);
      await page.keyboard.press('Space'); assert.equal(await button.getAttribute('aria-expanded'), 'false'); assert.equal(await panel.isHidden(), true);
    }
  });
  await check('narrow viewport has no horizontal overflow', async () => {
    await page.setViewportSize({ width: 375, height: 844 }); const g = await geometry(); await screenshot('04-narrow-reopened'); return g;
  });
  await check('all delivered responses remain committed and browser stays local', async () => {
    await drain(); verifyResponses(); assert.deepEqual(report.unexpectedRequests, []); assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.failedRequests, []); return { receivedResponses: report.responses.length };
  });
} catch (e) { failure = e; report.error = e?.stack ?? String(e); if (page) try { await screenshot('failure'); } catch {} }
finally {
  await drain(); if (context) await context.close().catch(() => {}); if (browser) await browser.close().catch(() => {});
  await drain(); report.finishedAt = new Date().toISOString(); report.passed = !failure;
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ report: path.join(out, 'report.json'), passed: report.passed }));
if (failure) { console.error(failure); process.exitCode = 1; }
