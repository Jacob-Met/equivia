import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { verifyAuthoredProposal } from '../src/model.js';
import { distribution } from '../src/engine.js';

const require = createRequire(import.meta.url);
if (!process.env.PUPPETEER_MODULE || !process.env.CHROME_EXECUTABLE) {
  throw new Error('Set PUPPETEER_MODULE to an existing puppeteer-core installation and CHROME_EXECUTABLE to an existing sandbox-capable Chrome.');
}
const puppeteer = require(process.env.PUPPETEER_MODULE);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? path.join(root, 'receipts', 'creator-browser'));
const baselineRoot = process.argv[3] ? path.resolve(process.argv[3]) : null;
await mkdir(output, { recursive: true });
const receipt = { started_at: new Date().toISOString(), root, baselineRoot, node: process.version,
  checks: [], viewports: [], page_errors: [], console_errors: [], failed_requests: [], model_posts: [], screenshots: [], downloads: [] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stage(name, details = {}) {
  const entry = { name, at: new Date().toISOString(), ...details };
  (receipt.stages ??= []).push(entry);
  await writeFile(path.join(output, 'progress.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ stage: entry }));
}
function watch(page, label) {
  page.on('pageerror', error => receipt.page_errors.push({ label, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') receipt.console_errors.push({ label, message: message.text() }); });
  page.on('requestfailed', request => receipt.failed_requests.push({ label, url: request.url(), failure: request.failure() }));
  page.on('request', request => { if (request.method() === 'POST') receipt.model_posts.push({ label, url: request.url() }); });
}
async function launchApp(directory) {
  const env = { ...process.env, PORT: '0' };
  for (const key of ['NEBIUS_API_KEY', 'NEBIUS_MODEL', 'NEBIUS_BASE_URL']) delete env[key];
  const child = spawn(process.execPath, ['server.mjs'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Application did not print its loopback address: ' + log)); }, 15000);
    child.stdout.on('data', data => {
      log += data.toString(); const match = log.match(/EQUIVIA ready at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.stderr.on('data', data => { log += data.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { if (!/EQUIVIA ready/.test(log)) { clearTimeout(timer); reject(new Error('Application exited ' + code + ': ' + log)); } });
  });
  return { child, url, async close() {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  } };
}
async function click(page, selector) {
  await page.bringToFront();
  await page.waitForSelector(selector, { visible: true });
  await page.$eval(selector, node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  const point = await page.$eval(selector, node => {
    const rect = node.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const target = document.elementFromPoint(x, y);
    return { x, y, hit: target === node || node.contains(target), disabled: Boolean(node.disabled) };
  });
  assert.equal(point.hit, true, selector + ' must be unobscured');
  assert.equal(point.disabled, false, selector + ' must be enabled');
  await page.mouse.click(point.x, point.y);
}
async function chooseFile(page, selector, filename) {
  await page.bringToFront();
  const [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 10000 }), click(page, selector),
  ]);
  await chooser.accept([filename]);
}
async function typeValue(page, selector, text) {
  await click(page, selector);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.type(text);
}
async function shot(page, name, selector) {
  await page.bringToFront();
  if (selector) await page.$eval(selector, node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  const filename = path.join(output, name);
  await page.screenshot({ path: filename });
  const bytes = await readFile(filename);
  receipt.screenshots.push({ name, path: filename, bytes: bytes.length, sha256: hash(bytes) });
}
async function form(page) {
  return page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('#pair-title,.creator-world input,.creator-world select,#check-clamp')].map(node => [node.id, node.value])));
}
async function notebook(page) { return page.evaluate(() => localStorage.getItem('equivia.notebook.v1')); }
async function check(page, expected = true) {
  await click(page, '#check-pair');
  await page.waitForFunction(() => !document.getElementById('check-results').hidden);
  assert.equal(await page.$eval('#save-pair', node => !node.disabled), expected);
  if (expected) assert.match(await page.$eval('#check-results', node => node.textContent), /Ready to export/);
}
async function download(page, directory, selector) {
  // Chrome may reuse a suggested filename; a fresh directory retains each actual export.
  const current = path.join(directory, 'download-' + String(receipt.downloads.length + 1).padStart(2, '0'));
  await mkdir(current);
  const cdp = await page.createCDPSession();
  try {
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: current });
    await click(page, selector);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const names = (await readdir(current)).filter(name => name.endsWith('.json'));
      if (names.length === 1) {
        const filename = path.join(current, names[0]), bytes = await readFile(filename);
        const parsed = JSON.parse(bytes.toString('utf8'));
        receipt.downloads.push({ path: filename, bytes: bytes.length, sha256: hash(bytes) });
        return { path: filename, bytes, parsed };
      }
      await tick(50);
    }
    throw new Error('No completed JSON download for ' + selector);
  } finally { await cdp.detach(); }
}

function exactTable(world, intervention, expected) {
  const actual = distribution(world, { observed: ['A', 'B'], intervention });
  for (const row of actual.outcomes) {
    const [numerator, denominator = '1'] = (expected[row.key] ?? '0').split('/');
    assert.deepEqual(row.probability, { numerator, denominator });
  }
}
async function installReadBarrier(page) {
  await page.evaluate(() => {
    window.__originalFileText = File.prototype.text;
    window.__creatorReads = [];
    File.prototype.text = function () {
      const file = this;
      return new Promise((resolve, reject) => {
        window.__creatorReads.push(() => window.__originalFileText.call(file).then(resolve, reject));
      });
    };
  });
}
async function releaseRead(page, index, restore = false) {
  await page.evaluate(async ({ index, restore }) => {
    if (restore) File.prototype.text = window.__originalFileText;
    await window.__creatorReads[index]();
    await Promise.resolve();
  }, { index, restore });
}

let browser, app;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true, protocolTimeout: 15000 });
  receipt.chrome = await browser.version();
  const sandboxPage = await browser.newPage();
  try {
    await sandboxPage.goto('chrome://sandbox');
    const status = await sandboxPage.$eval('body', node => node.innerText);
    const pid = browser.process().pid;
    const argumentsObserved = process.platform === 'linux'
      ? (await readFile('/proc/' + pid + '/cmdline', 'utf8')).split('\0').filter(Boolean)
      : browser.process().spawnargs;
    assert.equal(argumentsObserved.some(value => value === '--no-sandbox' || value === '--disable-setuid-sandbox'), false);
    assert.match(status, /You are adequately sandboxed/);
    receipt.sandbox = { pid, argumentsObserved, status };
    receipt.sandbox_disabled = false;
  } finally { await sandboxPage.close(); }
  await stage('browser-started');
  if (baselineRoot) {
    await stage('baseline-started');
    const baseline = await launchApp(baselineRoot);
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage(); await page.setViewport({ width: 1440, height: 1000 }); watch(page, 'baseline');
      await page.goto(baseline.url, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.getElementById('model-status').textContent.includes('not configured'));
      assert.equal(await page.$eval('#propose-worlds', node => node.disabled), true);
      assert.equal(await page.$('a[href="/creator"]'), null);
      assert.equal((await fetch(baseline.url + '/creator')).status, 404);
      await shot(page, 'baseline-creator.png', '#import-worlds');
      receipt.checks.push('baseline-ordinary-creator-requires-model-or-external-file');
    } finally { await context.close(); await baseline.close(); }
  }
  await stage('candidate-started');
  app = await launchApp(root);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 800, height: 1000 }, { width: 375, height: 844 }]) {
    await stage('viewport-started', viewport);
    const context = await browser.createBrowserContext();
    try {
      const laboratory = await context.newPage(); await laboratory.setViewport(viewport); watch(laboratory, viewport.width + '-laboratory');
      await laboratory.goto(app.url, { waitUntil: 'networkidle0' });
      await laboratory.waitForFunction(() => document.getElementById('model-status').textContent.includes('not configured'));
      const originalNotebook = await notebook(laboratory);
      const discovery = await laboratory.$eval('a[href="/creator"]', node => {
        const rect = node.getBoundingClientRect();
        return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, fragments: node.getClientRects().length };
      });
      assert.ok(discovery.height >= 44 && discovery.width > 0, 'Creator discovery target dimensions');
      assert.ok(discovery.left >= 0 && discovery.right <= viewport.width + 1, 'Creator discovery target fits viewport');
      assert.equal(discovery.fragments, 1, 'Creator discovery is one continuous target');
      (receipt.discovery ??= []).push({ viewport, ...discovery });
      const popup = new Promise(resolve => laboratory.once('popup', resolve));
      await click(laboratory, 'a[href="/creator"]');
      const page = await popup; await page.setViewport(viewport); watch(page, viewport.width + '-creator');
      await page.waitForSelector('#world-0-root option[value="4"]');
      await stage('worksheet-opened', viewport);
      if (viewport.width === 1440) {
        // Diagnose the old receiver's background-tab animation wait, without changing application behavior.
        await page.bringToFront();
        const hidden = await laboratory.evaluate(() => document.visibilityState);
        const pendingFrame = laboratory.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(document.visibilityState))));
        const beforeActivation = await Promise.race([pendingFrame.then(value => ({ settled: true, value })), tick(500).then(() => ({ settled: false }))]);
        await laboratory.bringToFront();
        const afterActivation = await pendingFrame;
        receipt.background_frame_probe = { beforeVisibility: hidden, beforeActivation, afterActivation };
        await stage('background-frame-probe-complete', receipt.background_frame_probe);
        await page.bringToFront();
      }
      assert.equal(new URL(page.url()).pathname, '/creator');
      assert.equal(await page.$eval('#save-pair', node => node.disabled), true);
      await typeValue(page, '#pair-title', 'Noisy pair ' + viewport.width);
      for (const index of [0, 1]) {
        await page.select('#world-' + index + '-off', '2');
        await page.select('#world-' + index + '-on', '6');
      }
      await check(page);
      const geometry = await page.evaluate(() => ({
        viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
        controls: [...document.querySelectorAll('button,input:not([type=file]),select')].map(node => {
          const rect = node.getBoundingClientRect(); return { id: node.id, width: rect.width, height: rect.height };
        }),
      }));
      assert.ok(geometry.pageWidth <= viewport.width + 1, 'Creator has page overflow');
      assert.ok(geometry.controls.every(item => item.height >= 44 && item.width > 0), 'Creator control dimensions');
      receipt.viewports.push({ ...viewport, geometry });
      await shot(page, viewport.width + '-editor.png', '#pair-heading');
      await shot(page, viewport.width + '-check.png', '#check-results');
      await shot(page, viewport.width + '-export.png', '#export-heading');

      const downloads = path.join(output, 'downloads-' + viewport.width);
      await mkdir(downloads, { recursive: true });
      await stage('export-started', viewport);
      const exported = await download(page, downloads, '#save-pair');
      await stage('export-completed', { ...viewport, path: exported.path, sha256: hash(exported.bytes) });
      assert.equal(verifyAuthoredProposal(exported.parsed, { variableIds: ['A', 'B'] }).accepted, true);
      for (const world of exported.parsed.worlds) exactTable(world, {}, { '00': '3/8', '01': '1/8', '10': '1/8', '11': '3/8' });
      exactTable(exported.parsed.worlds[0], { A: 1 }, { '10': '1/4', '11': '3/4' });
      exactTable(exported.parsed.worlds[1], { A: 1 }, { '10': '1/2', '11': '1/2' });
      assert.equal(await notebook(laboratory), originalNotebook, 'Worksheet must not alter the laboratory notebook');

      await stage('worksheet-reopen-started', viewport);
      await chooseFile(page, '#open-pair', exported.path);
      await page.waitForFunction(() => document.getElementById('creator-status').textContent.includes('World pair reopened'));
      assert.equal(await page.$eval('#save-pair', node => node.disabled), true);
      assert.equal((await form(page))['world-0-off'], '2');
      assert.equal((await form(page))['world-1-on'], '6');
      await check(page);

      await stage('laboratory-preview-started', viewport);
      await chooseFile(laboratory, '#import-worlds', exported.path);
      await laboratory.waitForSelector('#author-result .primary', { visible: true });
      assert.equal(await notebook(laboratory), originalNotebook, 'A file preview is not adoption');
      await stage('laboratory-adoption-started', viewport);
      await click(laboratory, '#author-result .primary');
      const adopted = JSON.parse(await notebook(laboratory));
      assert.equal(adopted.title, exported.parsed.title);
      assert.deepEqual(adopted.worlds, exported.parsed.worlds);
      await stage('laboratory-play-started', viewport);
      await typeValue(laboratory, '#prediction-percent', '62.5');
      await click(laboratory, '#run-one');
      await laboratory.waitForFunction(() => document.getElementById('budget').textContent.includes('5 / 6'));
      const played = JSON.parse(await notebook(laboratory));
      assert.equal(played.history.filter(event => event.kind === 'intervene').length, 1);
      assert.match(await laboratory.$eval('#experiment-result', node => node.textContent), /Both explanations are still possible/);
      await shot(laboratory, viewport.width + '-played.png', '#experiment-result');
      receipt.checks.push(viewport.width + '-create-check-export-reopen-adopt-play');
      await stage('viewport-course-completed', viewport);

      if (viewport.width === 1440) {
        await page.bringToFront();
        await stage('refusal-and-preservation-course-started');
        // Changing the inspected clamp also invalidates the previous export decision.
        await page.select('#check-clamp', 'B0');
        assert.equal(await page.$eval('#save-pair', node => node.disabled), true);
        await check(page);
        assert.match(await page.$eval('#check-results', node => node.textContent), /Hold B off gives different outcome probabilities/);
        await page.select('#check-clamp', 'A1');
        assert.equal(await page.$eval('#save-pair', node => node.disabled), true);
        await check(page);
        receipt.checks.push('changed-clamp-requires-fresh-check');
        // Actual form edits must invalidate old evidence and exports.
        await page.select('#world-0-root', '2');
        assert.equal(await page.$eval('#save-pair', node => node.disabled), true);
        await check(page, false);
        assert.match(await page.$eval('#check-results', node => node.textContent), /observational distributions differ/);
        await page.select('#world-0-root', '4');
        await page.select('#world-1-order', 'AB');
        await check(page, false);
        assert.match(await page.$eval('#check-results', node => node.textContent), /None of these four/);
        await page.select('#world-1-order', 'BA');
        await typeValue(page, '#pair-title', 'Keyboard checked pair');
        await page.focus('#check-pair'); await page.keyboard.press('Space');
        await page.waitForFunction(() => !document.getElementById('save-pair').disabled);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'check-pair');
        receipt.checks.push('refusals-stale-edit-and-native-keyboard-check');

        const intact = await form(page);
        const invalid = path.join(output, 'invalid-pair.json'); await writeFile(invalid, '{"broken":true}');
        await chooseFile(page, '#open-pair', invalid);
        await page.waitForFunction(() => document.getElementById('creator-status').textContent.includes('Could not open'));
        assert.deepEqual(await form(page), intact);
        assert.equal(await page.$eval('#save-pair', node => node.disabled), false);

        const unsupported = {
          schema: 'equivia.author.v1', title: 'Unsupported fixed-noise relationship',
          worlds: [
            { schema: 'equivia.scm.v1', id: 'xor', label: 'XOR', observed: ['A', 'B'], variables: [
              { id: 'A', parents: [], noiseBits: 0, table: [0] },
              { id: 'B', parents: ['A'], noiseBits: 1, table: [0, 1, 1, 0] },
            ] },
            { schema: 'equivia.scm.v1', id: 'nested', label: 'Nested', observed: ['A', 'B'], variables: [
              { id: 'A', parents: [], noiseBits: 0, table: [0] },
              { id: 'B', parents: ['A'], noiseBits: 1, table: [0, 1, 1, 1] },
            ] },
          ], experiment: { intervention: { A: 1 } },
        };
        assert.equal(verifyAuthoredProposal(unsupported, { variableIds: ['A', 'B'] }).accepted, true);
        const unsupportedPath = path.join(output, 'unsupported-pair.json');
        await writeFile(unsupportedPath, JSON.stringify(unsupported));
        await chooseFile(page, '#open-pair', unsupportedPath);
        await page.waitForFunction(() => document.getElementById('creator-status').textContent.includes('random-input relationships'));
        assert.deepEqual(await form(page), intact);
        assert.equal(await page.$eval('#save-pair', node => node.disabled), false);
        receipt.checks.push('invalid-and-valid-but-unrepresentable-files-preserve-draft');

        // Controlled read barrier: an actual chosen file completes after newer edits.
        await stage('delayed-read-course-started');
        await installReadBarrier(page);
        await chooseFile(page, '#open-pair', exported.path);
        await page.waitForFunction(() => window.__creatorReads.length === 1);
        await typeValue(page, '#pair-title', 'Edits survive late file');
        for (const index of [0, 1]) {
          await page.select('#world-' + index + '-off', '1');
          await page.select('#world-' + index + '-on', '7');
        }
        const newer = await form(page);
        await releaseRead(page, 0, true);
        await page.waitForFunction(() => document.getElementById('creator-status').textContent.includes('draft changed while'));
        assert.deepEqual(await form(page), newer);
        assert.equal(await page.$eval('#save-pair', node => node.disabled), true);
        await check(page);
        const surviving = await download(page, downloads, '#save-pair');
        assert.equal(surviving.parsed.title, 'Edits survive late file');
        for (const world of surviving.parsed.worlds) exactTable(world, {}, { '00': '7/16', '01': '1/16', '10': '1/16', '11': '7/16' });
        receipt.checks.push('controlled-late-read-preserves-edits-and-exported-bytes');

        // A more recent file selection wins even without intervening form edits.
        await stage('out-of-order-file-course-started');
        const latest = { ...exported.parsed, title: 'Newest file wins' };
        const latestPath = path.join(output, 'newest-pair.json'); await writeFile(latestPath, JSON.stringify(latest));
        await installReadBarrier(page);
        await chooseFile(page, '#open-pair', exported.path);
        await chooseFile(page, '#open-pair', latestPath);
        await page.waitForFunction(() => window.__creatorReads.length === 2);
        await releaseRead(page, 1);
        await page.waitForFunction(() => document.getElementById('pair-title').value === 'Newest file wins');
        await releaseRead(page, 0, true);
        assert.equal((await form(page))['pair-title'], 'Newest file wins');
        assert.equal(await page.$eval('#save-pair', node => node.disabled), true);
        receipt.checks.push('controlled-out-of-order-file-completion-preserves-newest-intent');
      }
    } finally { await context.close(); }
  }
  await stage('all-viewport-courses-completed');
  assert.deepEqual(receipt.page_errors, []);
  assert.deepEqual(receipt.console_errors, []);
  assert.deepEqual(receipt.failed_requests, []);
  assert.deepEqual(receipt.model_posts, []);
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  receipt.finished_at = new Date().toISOString();
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ receipt: path.join(output, 'receipt.json'), passed: receipt.passed, checks: receipt.checks, error: receipt.error?.message }));
}
