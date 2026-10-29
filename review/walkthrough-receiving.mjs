/** Receive the real local CLI through one complete notebook journey.
 * node review/walkthrough-receiving.mjs /absolute/app-root /absolute/new-receipt-directory
 * Required: PLAYWRIGHT_MODULE, CHROME_EXECUTABLE. Captures screenshots.
 * Use the extracted source package as app-root to qualify that package.
 * Output is local evidence: screenshots, genuine replay notebooks and a JSON receipt.
 * This scripted journey is not a learner study or a cloud-provider qualification.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const [appRoot, out] = process.argv.slice(2);
for (const value of [appRoot, out, process.env.PLAYWRIGHT_MODULE, process.env.CHROME_EXECUTABLE])
  assert.ok(value && path.isAbsolute(value), 'Supply absolute app/output/Playwright/Chrome paths');
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.mkdir(out); // A fresh directory prevents stale or overwritten receiving evidence.
const report = { evaluator: 'independent single-trial receiving journey v1', appRoot,
  startedAt: new Date().toISOString(), passed: false, steps: [], browserErrors: [], deniedRequests: [], httpFailures: [],
  providerRequestAttempts: 0, providerRequestObservationScope: 'Browser requests to /api/coach or /api/author; not server network telemetry',
  screenshots: [], limitations: ['Scripted receiving walkthrough, not a learner study or visual-quality verdict.'] };
let child, browser, context, timer;
const STORE = 'equivia.notebook.v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function step(name, fn) { await fn(); report.steps.push(name); }
try {
  const { observe, experiment, receiveSession } =
    await import(pathToFileURL(path.join(appRoot, 'src/session.js')).href);
  // Receive the exact example shipped with the guide, including its executable replay.
  const importPath = path.join(appRoot, 'docs/first-investigation/starting-notebook.json');
  const startingBytes = await fs.readFile(importPath);
  const initial = receiveSession(startingBytes.toString('utf8'));
  assert.equal(initial.initialSeed, 2, 'The shipped guide uses seed 2');
  const expected = experiment(observe(initial), { intervention: { A: 1 }, prediction: .75 });
  assert.deepEqual(expected.history.at(-1).outcome, { A: 1, B: 1 }, 'The shipped example must produce the shared outcome');
  report.initialSeed = initial.initialSeed;
  report.startingNotebookPath = importPath;
  await fs.writeFile(path.join(out, 'starting-notebook.json'), startingBytes);
  report.startingNotebookSHA256 = sha(startingBytes);
  report.serverSHA256 = sha(await fs.readFile(path.join(appRoot, 'server.mjs')));
  const env = { ...process.env, PORT: '0' };
  for (const key of Object.keys(env)) if (key.startsWith('NEBIUS_')) delete env[key];
  report.providerEnvironment = { nebiusVariablesRemoved: true, remainingNebiusVariableCount: Object.keys(env).filter(key => key.startsWith('NEBIUS_')).length };
  child = spawn(process.execPath, [path.join(appRoot, 'server.mjs')], { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const origin = await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error('Actual CLI did not announce loopback address within 15s')), 15000);
    child.once('error', reject);
    child.once('exit', code => reject(Error(`CLI exited before ready (${code}): ${stderr}`)));
    child.stdout.on('data', bytes => {
      stdout += bytes;
      const match = stdout.match(/EQUIVIA ready at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  report.origin = origin;
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true, chromiumSandbox: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
    reducedMotion: 'reduce' });
  await context.route('**/*', route => {
    const request = route.request(), url = request.url();
    if (url.startsWith(origin + '/') && /\/api\/(coach|author)(?:[/?]|$)/.test(url)) report.providerRequestAttempts++;
    if ((url.startsWith(origin + '/') && !/\/api\/(coach|author)(?:[/?]|$)/.test(url)) || /^(blob:|data:)/.test(url)) return route.continue();
    report.deniedRequests.push({ url, method: request.method() }); return route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') report.browserErrors.push(msg.text()); });
  page.on('response', response => { if (response.status() >= 400) report.httpFailures.push({ url: response.url(), status: response.status() }); });
  const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORE);
  const waitEvents = n => page.waitForFunction(({ key, n }) => JSON.parse(localStorage.getItem(key))?.history.length === n, { key: STORE, n });
  const shot = async name => { await page.screenshot({ path: path.join(out, name), fullPage: true, animations: 'disabled' }); report.screenshots.push(name); };
  const crop = async (selector, name) => {
    const target = page.locator(selector); assert.equal(await target.isVisible(), true, selector);
    await target.screenshot({ path: path.join(out, name), animations: 'disabled' }); report.screenshots.push(name);
  };
  const weights = async () => {
    const text = await page.locator('#hypothesis-list').innerText();
    assert.match(text, /Exact conditional weight 2\/3/); assert.match(text, /Exact conditional weight 1\/3/);
    assert.match(await page.locator('#budget').innerText(), /5 \/ 6/);
  };
  await step('actual CLI and normal notebook import', async () => {
    await page.goto(origin, { waitUntil: 'networkidle' });
    const config = await page.evaluate(() => fetch('/api/config').then(r => r.json()));
    assert.equal(config.model.configured, false);
    report.providerConfigEvidence = { configured: config.model.configured };
    await page.locator('#notebook-file').setInputFiles(importPath); await waitEvents(12);
    await page.waitForFunction(({ key, seed }) => JSON.parse(localStorage.getItem(key))?.initialSeed === seed, { key: STORE, seed: initial.initialSeed });
    assert.deepEqual(await stored(), initial);
  });
  await step('passive observations retain equal weights and six trials', async () => {
    await page.locator('#observe').click(); await waitEvents(20);
    assert.deepEqual(await stored(), observe(initial));
    assert.deepEqual(await page.locator('#hypothesis-list .weight').allTextContents(), ['50%', '50%']);
    assert.match(await page.locator('#budget').innerText(), /6 \/ 6/);
    await shot('01-desktop-observations.png');
    await crop('#hypothesis-list', '01a-desktop-equal-weights.png');
    await crop('#observation-summary', '01b-desktop-observation-counts.png');
  });
  const explanation = 'Both directions fit the matching observations. I predict 75% for B with A held on; a shared outcome changes weights without proving direction.';
  await step('one real A-on trial shows prior 3/4 and next-trial 5/6', async () => {
    await page.locator('#learner-explanation').fill(explanation);
    await page.locator('[name="target"][value="A"]').check();
    await page.locator('[name="value"][value="1"]').check();
    await page.locator('#show-predictions').click();
    assert.equal(await page.locator('#prediction-comparison').isVisible(), true);
    assert.match(await page.locator('#prediction-comparison').innerText(), /This experiment predicts different distributions/);
    await crop('#prediction-comparison', '01c-desktop-clamp-predictions.png');
    await page.locator('#prediction-percent').fill('75'); await page.locator('#run-one').click(); await waitEvents(21);
    expected.explanation = explanation; assert.deepEqual(await stored(), expected);
    assert.match(await page.locator('#forecast-before').innerText(), /3\/4/);
    assert.match(await page.locator('#forecast-after').innerText(), /5\/6/);
    assert.match(await page.locator('#forecast-estimate').innerText(), /75%/);
    await weights(); assert.equal(await page.locator('.journal-entry').count(), 1);
    const possible = page.locator('#experiment-result > strong');
    assert.equal(await possible.isVisible(), true);
    assert.equal(await possible.innerText(), 'Both explanations are still possible.');
    assert.match(await page.locator('#forecast-reflection').innerText(), /It describes a hypothetical next trial with the same clamp, not the trials already recorded\./);
    await shot('02-desktop-shared-result.png');
    await crop('#experiment-result', '02a-desktop-result-detail.png');
    await crop('#hypothesis-list', '02b-desktop-updated-weights.png');
    await page.setViewportSize({ width: 375, height: 900 });
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    assert.ok(geometry.width <= geometry.viewport + 1, JSON.stringify(geometry));
    await shot('03-mobile-shared-result.png');
  });
  let downloaded;
  const savedPath = path.join(out, 'downloaded-notebook.json');
  await step('actual downloaded notebook reopens after fresh investigation', async () => {
    const event = page.waitForEvent('download'); await page.locator('#save-notebook').click();
    const download = await event; await download.saveAs(savedPath);
    const bytes = await fs.readFile(savedPath); downloaded = receiveSession(bytes.toString('utf8'));
    assert.deepEqual(downloaded, expected); report.downloadSHA256 = sha(bytes);
    await page.locator('#new-investigation').click(); await waitEvents(12);
    assert.equal(await page.locator('.journal-entry').count(), 0);
    await page.locator('#notebook-file').setInputFiles(savedPath); await waitEvents(21);
    assert.deepEqual(await stored(), downloaded); await weights();
    assert.equal(await page.locator('.journal-entry').count(), 1);
    assert.equal(await page.locator('#learner-explanation').inputValue(), explanation);
    assert.equal(await page.locator('#experiment-result').isVisible(), false);
    assert.equal(await page.locator('#forecast-reflection').isVisible(), false);
    await page.reload({ waitUntil: 'networkidle' }); await waitEvents(21);
    assert.deepEqual(await stored(), downloaded); await weights();
    assert.equal(await page.locator('#learner-explanation').inputValue(), explanation);
    await shot('04-mobile-reopened.png');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await crop('#journal-entries', '04a-desktop-reopened-journal.png');
    await crop('#learner-explanation', '04b-desktop-reopened-explanation.png');
    await crop('#hypothesis-list', '04c-desktop-reopened-weights.png');
  });
  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.httpFailures, []); assert.deepEqual(report.deniedRequests, []);
  assert.equal(report.providerRequestAttempts, 0);
  report.passed = true;
} catch (error) {
  report.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => { const killTimer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); child.once('exit', () => { clearTimeout(killTimer); resolve(); }); });
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(out, 'walkthrough-receipt.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
