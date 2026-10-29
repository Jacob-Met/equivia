import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Independent black-box receiver: node receiver.mjs APP_ROOT PLAYWRIGHT_MODULE CHROME OUT
const [rootArg, playwrightArg, chrome, outArg] = process.argv.slice(2);
if (!outArg) throw Error('Expected APP_ROOT PLAYWRIGHT_MODULE CHROME OUT');
const root = resolve(rootArg), out = resolve(outArg);
await mkdir(out, { recursive: true });
const { chromium } = await import(pathToFileURL(resolve(playwrightArg)));
const { createSession, serializeSession, receiveSession } = await import(pathToFileURL(join(root, 'src/session.js')));
const fixtures = Object.fromEntries(['A', 'B'].map((id, i) => {
  const session = createSession({ title: `Receiver notebook ${id}`, seed: 4100 + i });
  session.explanation = `Saved reasoning ${id}`;
  const text = serializeSession(session); receiveSession(text);
  return [id, text];
}));
const env = { ...process.env, PORT: '0' };
for (const key of Object.keys(env)) if (/NEBIUS|OPENAI|ANTHROPIC|API_KEY|MODEL|PROXY/i.test(key)) delete env[key];
const report = { source: root, appSha256: createHash('sha256').update(await readFile(join(root, 'public/app.js'))).digest('hex'), cases: [], pageErrors: [], unexpectedRequests: [], serverOutput: '', browserClosed: false };
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', d => report.serverOutput += d);
server.stderr.on('data', d => report.serverOutput += d);
const serverExit = new Promise(r => server.once('exit', (code, signal) => r({ code, signal })));
let browser;
const assert = (ok, message) => { if (!ok) throw Error(message); };
const STORE = 'equivia.notebook.v1';
try {
  const url = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(Error('Server startup timeout: ' + report.serverOutput)), 10000);
    const inspect = () => { const hit = report.serverOutput.match(/http:\/\/127\.0\.0\.1:\d+/); if (hit) { clearTimeout(timer); res(hit[0]); } };
    server.stdout.on('data', inspect); server.once('error', rej); server.once('exit', () => { clearTimeout(timer); rej(Error('Server exited before readiness')); }); inspect();
  });
  browser = await chromium.launch({ executablePath: chrome, headless: true, chromiumSandbox: true });
  async function course(name, body, initialRaw) {
    const context = await browser.newContext({ acceptDownloads: true });
    const entry = { name, passed: false, observations: [] }; report.cases.push(entry);
    let page;
    try {
      await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : (report.unexpectedRequests.push(route.request().url()), route.abort()));
      await context.addInitScript(({ initialRaw, STORE }) => {
        if (initialRaw !== undefined) localStorage.setItem(STORE, initialRaw);
        const original = Blob.prototype.text;
        window.receiverReads = {};
        Blob.prototype.text = function () {
          if (!this.name?.startsWith('receiver-')) return original.call(this);
          return new Promise((resolve, reject) => { window.receiverReads[this.name] = { resolve, reject }; });
        };
      }, { initialRaw, STORE });
      page = await context.newPage();
      page.on('pageerror', e => report.pageErrors.push({ name, message: e.message }));
      await page.goto(url); await page.locator('.introduction .eyebrow').waitFor();
      const state = () => page.evaluate(STORE => ({ stored: localStorage.getItem(STORE), title: document.querySelector('.introduction .eyebrow').textContent, explanation: document.querySelector('#learner-explanation').value, status: document.querySelector('#status').textContent, error: document.querySelector('#status').classList.contains('error'), saveStatus: document.querySelector('#save-status').textContent }), STORE);
      const record = async label => { const s = await state(); entry.observations.push({ label, ...s }); return s; };
      const select = async (id, contents = fixtures[id]) => { await page.locator('#notebook-file').setInputFiles({ name: `receiver-${id}.json`, mimeType: 'application/json', buffer: Buffer.from(contents) }); assert(await page.evaluate(name => !!window.receiverReads[name], `receiver-${id}.json`), 'Selected file did not synchronously start reading'); };
      const settle = async (id, text = fixtures[id], reject = false) => {
        await page.evaluate(async ({ id, text, reject }) => { const pending = window.receiverReads[`receiver-${id}.json`]; if (!pending) throw Error('Missing pending read ' + id); reject ? pending.reject(Error(text)) : pending.resolve(text); await new Promise(r => setTimeout(r, 0)); }, { id, text, reject });
      };
      const isNotebook = (s, id) => { const actual = JSON.parse(s.stored); const wanted = JSON.parse(fixtures[id]); assert(JSON.stringify(actual) === JSON.stringify(wanted), `Expected complete notebook ${id}; actual title ${actual.title}`); assert(s.title.includes(wanted.title.toUpperCase()), 'Visible title differs from saved notebook'); assert(s.explanation === wanted.explanation, 'Visible explanation differs from notebook'); };
      await body({ page, state, record, select, settle, isNotebook }); entry.passed = true;
    } catch (e) { entry.failure = e.stack; }
    finally {
      if (page && report.cases.length === 1) { try { await page.screenshot({ path: join(out, 'notebook-selection-final.png'), fullPage: true }); } catch (e) { entry.screenshotError = e.message; } }
      await context.close();
    }
  }
  for (const order of [['A','B'], ['B','A']]) await course(`latest selection B wins: ${order.join(' then ')} completion`, async ({ select, settle, record, isNotebook }) => {
    const before = await record('before'); await select('A'); await select('B');
    let accepted;
    for (const id of order) {
      await settle(id); const current = await record(`${id} resolved`);
      if (id === 'B') accepted = current;
      else if (!accepted) assert(current.stored === before.stored && current.title === before.title, 'Obsolete A opened while newest B was pending');
    }
    const final = await record('final'); isNotebook(final, 'B');
    assert(!final.error, 'Successful newest notebook has error status');
    assert(final.status === accepted.status, 'Obsolete completion replaced accepted notebook status');
  });
  for (const readFailure of [false, true]) await course(`latest ${readFailure ? 'read failure' : 'invalid notebook'} never falls back to older valid selection`, async ({ select, settle, record }) => {
    const before = await record('before'); await select('A'); await select('B', readFailure ? fixtures.B : '{'); await settle('B', readFailure ? 'synthetic newest file read failure' : '{', readFailure);
    const rejected = await record('newest invalid rejected'); assert(rejected.error, 'Latest invalid file needs an error');
    await settle('A'); const after = await record('older valid resolved');
    assert(after.stored === before.stored && after.title === before.title, 'Obsolete valid file replaced current work');
    assert(after.status === rejected.status && after.error === rejected.error, 'Obsolete success replaced newest error status');
  });
  for (const reject of [false, true]) await course(`obsolete ${reject ? 'read rejection' : 'malformed content'} is silent after newer success`, async ({ select, settle, record, isNotebook }) => {
    await select('A', reject ? fixtures.A : '{'); await select('B'); await settle('B'); const accepted = await record('B accepted'); isNotebook(accepted, 'B');
    await settle('A', reject ? 'synthetic file read failure' : '{', reject); const after = await record('A failed');
    isNotebook(after, 'B'); assert(after.status === accepted.status && after.error === accepted.error, 'Obsolete failure replaced accepted status');
  });
  for (const action of ['explanation', 'experiment', 'new investigation']) await course(`pending file preserves intervening ${action}`, async ({ page, select, settle, record }) => {
    await select('A');
    if (action === 'explanation') await page.locator('#learner-explanation').fill('My newer reasoning must survive.');
    if (action === 'experiment') { await page.locator('#prediction-percent').fill('50'); await page.locator('#run-one').click(); }
    if (action === 'new investigation') await page.locator('#new-investigation').click();
    const changed = await record('intervening change'); await settle('A'); const after = await record('file resolved');
    assert(after.stored === changed.stored && after.title === changed.title && after.explanation === changed.explanation, 'Pending file overwrote newer work');
  });
  await course('empty selection is harmless and malformed current selection preserves work', async ({ page, record, select, settle }) => {
    const before = await record('before'); await page.locator('#notebook-file').setInputFiles([]); const empty = await record('empty selection');
    assert(JSON.stringify(before) === JSON.stringify(empty), 'Empty selection changed current work/status');
    await select('A', '{'); await settle('A', '{'); const after = await record('malformed current file');
    assert(after.stored === before.stored && after.title === before.title && after.explanation === before.explanation, 'Malformed file damaged current work'); assert(after.error, 'Malformed current file did not report error');
  });
  await course('empty selection preserves pending valid file intent', async ({ page, select, settle, record, isNotebook }) => {
    await select('A'); await page.locator('#notebook-file').setInputFiles([]); await settle('A');
    isNotebook(await record('pending A resolves after empty selection'), 'A');
  });
  await course('newest oversized file invalidates older pending file without reading itself', async ({ page, select, settle, record }) => {
    const before = await record('before'); await select('A');
    await page.locator('#notebook-file').setInputFiles({ name: 'receiver-oversized.json', mimeType: 'application/json', buffer: Buffer.alloc(262145, 32) });
    assert(!(await page.evaluate(() => !!window.receiverReads['receiver-oversized.json'])), 'Oversized file was read despite size bound');
    const rejected = await record('oversized newest rejected'); assert(rejected.error, 'Oversized newest file did not show error');
    await settle('A'); const after = await record('older A resolved');
    assert(after.stored === before.stored && after.title === before.title, 'Older A opened after oversized newest intent');
    assert(after.status === rejected.status && after.error === rejected.error, 'Older completion replaced oversized error status');
  });
  await course('import preserves unreadable stored original and paused autosave', async ({ select, settle, record, page }) => {
    await select('A'); await settle('A'); const after = await record('valid file opened during recovery');
    assert(after.stored === '{unreadable original', 'Import replaced unreadable stored original');
    assert(after.title.includes('RECEIVER NOTEBOOK A') && after.explanation === 'Saved reasoning A', 'Valid file did not open in memory');
    assert(after.saveStatus.includes('paused'), 'Import resumed autosave without recovery verification');
    await page.locator('#learner-explanation').fill('Temporary revised reasoning'); const edited = await record('temporary edit'); assert(edited.stored === '{unreadable original', 'Temporary edit overwrote unreadable original');
  }, '{unreadable original');
} catch (e) { report.fatal = e.stack; }
finally {
  if (browser) { await browser.close(); report.browserClosed = true; }
  server.kill('SIGINT');
  let timeout;
  report.serverExit = await Promise.race([serverExit, new Promise(r => { timeout = setTimeout(() => r({ timeout: true }), 5000); })]);
  clearTimeout(timeout);
  if (report.serverExit.timeout) { server.kill('SIGKILL'); report.cleanupEscalated = true; }
  report.cleanupPassed = report.browserClosed && report.serverExit.code === 0;
  report.passed = !report.fatal && report.cases.length === 13 && report.cleanupPassed && report.cases.every(c => c.passed) && !report.pageErrors.length && !report.unexpectedRequests.length;
  await writeFile(join(out, 'notebook-receiver.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map(({ name, passed, failure }) => ({ name, passed, failure })), fatal: report.fatal, browserClosed: report.browserClosed, serverExit: report.serverExit }));
  process.exitCode = report.passed ? 0 : 1;
}
