/** One focused real-browser precision regression. Prepared only; no local run.
 * EQUIVIA_APP_ROOT=/project PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs \
 *   node review/precision-review.mjs OUTPUT_DIRECTORY
 * No provider configuration, provider stubs, or cloud calls are involved.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const appRoot = path.resolve(process.env.EQUIVIA_APP_ROOT || fileURLToPath(new URL('../', import.meta.url)));
const outputDirectory = path.resolve(process.argv[2] || 'precision-review-output');
await fs.mkdir(outputDirectory, { recursive: true });
const { createServer } = await import(pathToFileURL(path.join(appRoot, 'server.mjs')).href);
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href)
  : await import('playwright');

// Three independent 1/16 events make the visible root 1/4096. Reversing the
// copy direction preserves P(00)=4095/4096, P(11)=1/4096 observationally.
// Under do(A=1), P(11) is 1 in the forward world and 1/4096 in the reverse.
function rareRootWorld(forward) {
  const rootId = forward ? 'A' : 'B', childId = forward ? 'B' : 'A';
  return { schema: 'equivia.scm.v1', id: forward ? 'precision-A-drives-B' : 'precision-B-drives-A',
    label: forward ? 'Rare-event A drives B' : 'Rare-event B drives A', observed: ['A', 'B'],
    variables: [
      ...['R1', 'R2', 'R3'].map(id => ({ id, parents: [], noiseBits: 4, table: [...Array(15).fill(0), 1] })),
      { id: rootId, parents: ['R1', 'R2', 'R3'], noiseBits: 0, table: [0, 0, 0, 0, 0, 0, 0, 1] },
      { id: childId, parents: [rootId], noiseBits: 0, table: [0, 1] },
    ] };
}
const worlds = [rareRootWorld(true), rareRootWorld(false)];
const initialSeed = 0x7c15ab39;
let seed = initialSeed;
const history = Array.from({ length: 6 }, (_, index) => {
  const beforeSeed = seed; seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  // A's equation is clamped and B copies A, so this does not need the engine to
  // manufacture the expected outcomes, irrespective of the sampled hidden bits.
  return { id: index + 1, kind: 'intervene', intervention: { A: 1 }, outcome: { A: 1, B: 1 },
    prediction: 0.999, beforeSeed, afterSeed: seed };
});
const notebook = { schema: 'equivia.session.v1', title: 'Precision is not certainty', worlds,
  activeWorldId: worlds[0].id, initialSeed, seed, budget: 6, history, explanation: '', revealed: false };
const expected = {
  derivation: 'Uniform prior. Six likelihood ratios of 4096:1 give odds 4096^6:1 = 2^72:1.',
  primary: { numerator: '4722366482869645213696', denominator: '4722366482869645213697' },
  alternative: { numerator: '1', denominator: '4722366482869645213697' },
  primaryDisplay: '>99.9%', viableCandidates: 2,
};
assert.equal((4096n ** 6n).toString(), expected.primary.numerator, 'independent hand-derived constant check');
await fs.writeFile(path.join(outputDirectory, 'precision-notebook.json'), JSON.stringify(notebook, null, 2));

const errors = [], unexpectedRequests = [];
let server, browser, page, result;
try {
  server = createServer({ env: {} });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || '/usr/local/bin/google-chrome', headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push({ type: 'pageerror', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') errors.push({ type: 'console', message: message.text() }); });
  page.on('response', response => { if (response.status() >= 400) errors.push({ type: 'http', status: response.status(), url: response.url() }); });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || /^(data:|blob:)/.test(url)) return route.continue();
    unexpectedRequests.push(url); return route.abort('blockedbyclient');
  });
  await page.goto(origin + '/', { waitUntil: 'networkidle' });
  await page.locator('#hypothesis-list .hypothesis').first().waitFor();
  await page.locator('#notebook-file').setInputFiles({ name: 'precision-notebook.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(notebook)) });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('equivia.notebook.v1'))?.title === 'Precision is not certainty');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('equivia.notebook.v1'))), notebook);
  const primary = page.locator('#hypothesis-list .hypothesis').nth(0);
  const alternative = page.locator('#hypothesis-list .hypothesis').nth(1);
  const primaryText = await primary.innerText(), alternativeText = await alternative.innerText();
  assert.equal((await primary.locator('.weight').innerText()).trim(), '>99.9%');
  assert.notEqual((await alternative.locator('.weight').innerText()).trim(), '0%');
  assert.ok(primaryText.includes(`${expected.primary.numerator}/${expected.primary.denominator}`));
  assert.ok(alternativeText.includes(`1/${expected.alternative.denominator}`));
  assert.match(alternativeText, /Still a possible explanation/i);
  assert.doesNotMatch(primaryText, /other declared candidate is excluded/i);
  assert.equal(await page.locator('#hypothesis-list .hypothesis.excluded').count(), 0);
  assert.match(await page.locator('#budget').innerText(), /0 \/ 6/);
  await page.screenshot({ path: path.join(outputDirectory, 'precision-before-reveal.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 375, height: 900 });
  const mobileGeometry = await page.evaluate(() => ({
    viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
    cards: [...document.querySelectorAll('#hypothesis-list .hypothesis')].map(card => ({
      client: card.clientWidth, scroll: card.scrollWidth,
      left: card.getBoundingClientRect().left, right: card.getBoundingClientRect().right,
    })),
  }));
  assert.ok(mobileGeometry.document <= mobileGeometry.viewport + 1 && mobileGeometry.body <= mobileGeometry.viewport + 1,
    `Long exact fractions caused page overflow: ${JSON.stringify(mobileGeometry)}`);
  assert.ok(mobileGeometry.cards.every(card => card.scroll <= card.client + 1 && card.left >= -1 && card.right <= 376),
    `Long exact fractions overflowed a hypothesis card: ${JSON.stringify(mobileGeometry)}`);
  await page.screenshot({ path: path.join(outputDirectory, 'precision-mobile-375.png'), fullPage: true, animations: 'disabled' });

  await page.locator('#debrief').click();
  const debrief = await page.locator('#debrief-content').innerText();
  assert.match(debrief, /Both candidates still had a possible path/i);
  assert.match(debrief, /did not eliminate the alternative/i);
  assert.doesNotMatch(debrief, /assigned this candidate 100%/i);
  const finalNotebook = await page.evaluate(() => JSON.parse(localStorage.getItem('equivia.notebook.v1')));
  assert.deepEqual(finalNotebook, { ...notebook, revealed: true });
  await page.screenshot({ path: path.join(outputDirectory, 'precision-debrief.png'), fullPage: true, animations: 'disabled' });
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []);
  result = { name: 'rare positive alternative remains possible through display and debrief', passed: true,
    expected, observed: { primaryText, alternativeText, debrief, mobileGeometry }, replayVerifiedByReceivingApp: true };
} catch (error) {
  if (page) await page.screenshot({ path: path.join(outputDirectory, 'precision-failure.png'), fullPage: true }).catch(() => {});
  result = { name: 'rare positive alternative remains possible through display and debrief', passed: false,
    expected, error: { name: error.name, message: error.message, stack: error.stack } };
} finally {
  await browser?.close().catch(() => {});
  if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  const report = { evaluator: 'EQUIVIA independent actual-browser precision review v1', executed: true,
    sandboxRequested: true, cloudProviderCalls: 0, result, errors, unexpectedRequests };
  await fs.writeFile(path.join(outputDirectory, 'precision-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: result?.passed ?? false, failure: result?.error?.message ?? null, outputDirectory }, null, 2));
  process.exitCode = result?.passed ? 0 : 1;
}
