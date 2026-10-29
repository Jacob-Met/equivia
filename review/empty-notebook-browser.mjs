import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!['--app-root', '--playwright', '--browser', '--out', '--origin'].includes(key) || !value)
    throw new Error('Usage: --app-root PATH --playwright MODULE --browser PATH --out NEW_DIR [--origin LOOPBACK_URL]');
  args[key.slice(2)] = value;
}
for (const key of ['app-root', 'playwright', 'browser', 'out'])
  if (!args[key]) throw new Error('Missing --' + key);
const out = path.resolve(args.out);
fs.mkdirSync(out, { recursive: false });
const result = {
  startedAt: new Date().toISOString(), appRoot: path.resolve(args['app-root']),
  origin: null, sourceSHA256: null, checks: [], states: {}, errors: [],
  consoleErrors: [], blockedRequests: [],
  cleanup: { browserClosed: false, ownedServerClosed: null },
};
let browser, server, page, sequence = 0;
const key = 'equivia.notebook.v1';
const deadline = Date.now() + 58000;
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
const check = (name, pass, actual) => {
  result.checks.push({ name, pass: Boolean(pass), actual }); save();
};
const watchdog = setTimeout(() => {
  result.errors.push('Overall 60-second deadline exceeded'); save();
  browser?.close().catch(() => {}); server?.close(); process.exit(2);
}, 60000);

const worldA = {
  schema: 'equivia.scm.v1', id: 'review-A-drives-B', label: 'Review: A drives B',
  observed: ['A', 'B'], variables: [
    { id: 'A', parents: [], noiseBits: 1, table: [0, 1] },
    { id: 'B', parents: ['A'], noiseBits: 0, table: [0, 1] },
  ],
};
const worldB = {
  schema: 'equivia.scm.v1', id: 'review-B-drives-A', label: 'Review: B drives A',
  observed: ['A', 'B'], variables: [
    { id: 'B', parents: [], noiseBits: 1, table: [0, 1] },
    { id: 'A', parents: ['B'], noiseBits: 0, table: [0, 1] },
  ],
};
const fixture = {
  schema: 'equivia.session.v1', title: 'Independent direction review',
  worlds: [worldA, worldB], activeWorldId: worldA.id,
  initialSeed: 123456789, seed: 123456789, budget: 6,
  history: [], explanation: '', revealed: false,
};
fs.writeFileSync(path.join(out, 'empty-notebook.json'), JSON.stringify(fixture, null, 2) + '\n');
async function poll(name, fn) {
  const end = Math.min(deadline, Date.now() + 10000);
  do { const value = await fn(); if (value) return value; await delay(75); }
  while (Date.now() < end);
  throw new Error('Timed out: ' + name);
}
const stored = () => page.evaluate(k => {
  const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : null;
}, key);
async function snapshot(name) {
  const state = await page.evaluate(k => ({
    notebook: JSON.parse(localStorage.getItem(k) || 'null'),
    lamps: ['A', 'B'].map(id => {
      const lamp = document.querySelector('#lamp-' + id);
      return {
        id, classes: [...lamp.classList],
        state: document.querySelector('#state-' + id).textContent.trim(),
        clamp: document.querySelector('#clamp-' + id).textContent.trim(),
        svgLabel: lamp.querySelector('svg').getAttribute('aria-label'),
      };
    }),
    budget: document.querySelector('#budget').textContent.trim(),
    status: document.querySelector('#status').textContent.trim(),
  }), key);
  result.states[name] = state; save(); return state;
}
async function capture(name) {
  for (const [label, width] of [['desktop', 1440], ['narrow', 375]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('#lamps').screenshot({
      path: path.join(out, name + '-' + label + '.png'), timeout: 10000, animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
async function importNotebook(notebook) {
  const submitted = structuredClone(notebook);
  submitted.title = notebook.title.split(' / receipt ')[0] + ' / receipt ' + ++sequence;
  await page.locator('#notebook-file').setInputFiles({
    name: 'notebook-' + sequence + '.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(submitted)),
  });
  await poll('accepted notebook storage', async () => {
    const s = await stored();
    return s?.title === submitted.title &&
      JSON.stringify(s.history) === JSON.stringify(submitted.history) && s.seed === submitted.seed;
  });
  check('import-' + sequence + '-accepted',
    (await page.locator('#status').textContent()).startsWith('Notebook reopened.'),
    { title: submitted.title });
}
function assertEmpty(name, state) {
  check(name + '-zero-history', state.notebook?.history.length === 0, state.notebook?.history.length);
  check(name + '-unchanged-seed', state.notebook?.seed === fixture.seed, state.notebook?.seed);
  check(name + '-full-budget', state.budget === '6 / 6 trials left', state.budget);
  for (const lamp of state.lamps) {
    check(name + '-' + lamp.id + '-unobserved',
      !lamp.classes.includes('lit') && !lamp.classes.includes('clamped') &&
      lamp.state === 'NO RESULT' && lamp.clamp === 'NO TRIAL RECORDED', lamp);
    check(name + '-' + lamp.id + '-accessible-empty-state',
      lamp.svgLabel === 'Lamp ' + lamp.id + ': no trial recorded in this investigation', lamp.svgLabel);
  }
}
function assertRecorded(name, state) {
  const latest = state.notebook.history.at(-1);
  check(name + '-has-recorded-evidence', Boolean(latest), state.notebook.history.length);
  if (!latest) return;
  for (const lamp of state.lamps) {
    const on = latest.outcome[lamp.id] === 1;
    const clamped = Object.hasOwn(latest.intervention, lamp.id);
    check(name + '-' + lamp.id + '-matches-evidence',
      lamp.classes.includes('lit') === on && lamp.classes.includes('clamped') === clamped &&
      lamp.state === (on ? 'ON' : 'OFF') &&
      lamp.clamp === (clamped ? 'HELD ' + (on ? 'ON' : 'OFF') + ' BY YOUR CLAMP' : 'FOLLOWING ITS OWN RULE') &&
      lamp.svgLabel === 'Lamp ' + lamp.id + ': ' + (on ? 'on' : 'off') + (clamped ? ', clamped by the experiment' : ''),
      lamp);
  }
}
async function trial(target, value) {
  const before = await stored();
  await page.locator('label:has(input[name="target"][value="' + target + '"])').click();
  await page.locator('label:has(input[name="value"][value="' + value + '"])').click();
  await page.locator('#prediction-percent').fill('75');
  await page.locator('#run-one').click();
  await poll('trial stored', async () => (await stored())?.history.length === before.history.length + 1);
}
try {
  result.sourceSHA256 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(result.appRoot, 'public', 'app.js'))).digest('hex');
  let origin = args.origin;
  if (!origin) {
    const module = await import(pathToFileURL(path.join(result.appRoot, 'server.mjs')));
    server = module.createServer({ env: {} });
    result.cleanup.ownedServerClosed = false;
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    origin = 'http://127.0.0.1:' + server.address().port;
  }
  const parsed = new URL(origin);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
    throw new Error('Receiver requires a loopback origin');
  result.origin = parsed.origin;
  const { chromium } = await import(pathToFileURL(path.resolve(args.playwright)));
  browser = await chromium.launch({
    executablePath: args.browser, headless: true, chromiumSandbox: true, timeout: 10000,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block',
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === parsed.origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
    result.blockedRequests.push(url.href); return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
  page.on('pageerror', e => result.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') result.consoleErrors.push(m.text()); });
  await page.goto(parsed.origin, { waitUntil: 'domcontentloaded' });
  await poll('startup notebook saved', stored);
  const startup = await snapshot('fresh-startup');
  check('startup-twelve-observations', startup.notebook.history.length === 12 &&
    startup.notebook.history.every(e => e.kind === 'observe'), startup.notebook.history.length);
  assertRecorded('fresh-startup', startup);
  await importNotebook(fixture);
  assertEmpty('fresh-empty', await snapshot('fresh-empty'));
  await trial('A', '1');
  const on = await snapshot('clamped-A-on');
  assertRecorded('clamped-A-on', on);
  check('negative-control-established',
    on.lamps.every(l => l.state === 'ON' && l.classes.includes('lit')) &&
    on.lamps.find(l => l.id === 'A').classes.includes('clamped'), on.lamps);
  const recorded = await stored();
  await importNotebook(fixture);
  assertEmpty('empty-after-clamped', await snapshot('empty-after-clamped'));
  await capture('empty-after-clamped');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await poll('persisted notebook initialized', async () =>
    (await page.locator('#status').textContent()).startsWith('Your investigation is ready to continue.'));
  assertEmpty('empty-after-reload', await snapshot('empty-after-reload'));
  await trial('A', '1');
  const next = await snapshot('next-trial');
  assertRecorded('next-trial', next);
  check('next-trial-single-history', next.notebook.history.length === 1, next.notebook.history.length);
  check('next-trial-budget', next.budget === '5 / 6 trials left', next.budget);
  check('next-trial-matches-original-event',
    JSON.stringify(next.notebook.history) === JSON.stringify(recorded.history),
    { expected: recorded.history, actual: next.notebook.history });
  check('next-trial-matches-original-seed', next.notebook.seed === recorded.seed,
    { expected: recorded.seed, actual: next.notebook.seed });
  await importNotebook(recorded);
  const restored = await snapshot('restored-recorded');
  check('nonempty-restores-both-lamps', JSON.stringify(restored.lamps) === JSON.stringify(on.lamps), restored.lamps);
  await trial('B', '0');
  const off = await snapshot('clamped-B-off');
  assertRecorded('clamped-B-off', off);
  const lampB = off.lamps.find(l => l.id === 'B');
  check('B-off-negative-control-established', lampB.state === 'OFF' &&
    !lampB.classes.includes('lit') && lampB.classes.includes('clamped'), lampB);
  const recordedOff = await stored();
  await importNotebook(fixture);
  assertEmpty('empty-after-B-off', await snapshot('empty-after-B-off'));
  await capture('empty-after-B-off');
  await importNotebook(recordedOff);
  const restoredOff = await snapshot('restored-B-off');
  check('nonempty-restores-B-off', JSON.stringify(restoredOff.lamps) === JSON.stringify(off.lamps), restoredOff.lamps);
  await page.locator('#observe').click();
  await poll('passive observation recorded', async () => (await stored()).history.length > off.notebook.history.length);
  const observed = await snapshot('passive-observe');
  assertRecorded('passive-observe', observed);
  check('passive-observe-clears-clamps', observed.lamps.every(l => !l.classes.includes('clamped')), observed.lamps);
  const beforeInvalidStatus = await page.locator('#status').textContent();
  await page.locator('#notebook-file').setInputFiles({
    name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid JSON'),
  });
  await poll('invalid import reported', async () => {
    const current = await page.locator('#status').textContent();
    return current !== beforeInvalidStatus && current.startsWith('Could not open that notebook:');
  });
  const rejected = await snapshot('invalid-import');
  check('invalid-import-preserves-lamps', JSON.stringify(rejected.lamps) === JSON.stringify(observed.lamps), rejected.lamps);
  check('invalid-import-preserves-notebook', JSON.stringify(rejected.notebook) === JSON.stringify(observed.notebook),
    { history: rejected.notebook.history.length, seed: rejected.notebook.seed });
  await importNotebook(fixture);
  assertEmpty('final-empty', await snapshot('final-empty'));
  await capture('final-empty');
} catch (error) { result.errors.push(error.stack || String(error)); }
finally {
  if (browser) {
    try { await browser.close(); result.cleanup.browserClosed = true; }
    catch (e) { result.errors.push('Browser cleanup: ' + e.message); }
  }
  if (server) {
    try { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
      result.cleanup.ownedServerClosed = true; }
    catch (e) { result.errors.push('Server cleanup: ' + e.message); }
  }
  result.finishedAt = new Date().toISOString();
  result.pass = result.checks.length > 0 && result.checks.every(c => c.pass) &&
    result.errors.length === 0 && result.consoleErrors.length === 0 && result.blockedRequests.length === 0;
  save(); clearTimeout(watchdog);
  console.log(JSON.stringify({ pass: result.pass, checks: result.checks.length,
    failed: result.checks.filter(c => !c.pass).map(c => c.name), errors: result.errors,
    results: path.join(out, 'results.json') }));
  process.exitCode = result.pass ? 0 : 1;
}
