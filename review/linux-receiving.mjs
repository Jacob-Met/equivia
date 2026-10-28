import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const [archive, expectedHash, expectedCommit, output] = process.argv.slice(2);
if (!archive || !/^[a-f0-9]{64}$/.test(expectedHash || '') || !/^[a-f0-9]{40}$/.test(expectedCommit || '') || !output) {
  throw new Error('Usage: node review/linux-receiving.mjs ARCHIVE SHA256 SOURCE_COMMIT OUTPUT_DIRECTORY');
}
const out = path.resolve(output);
await mkdir(out, { recursive: true });
const work = await mkdtemp(path.join(os.tmpdir(), 'EQUIVIA receiving with spaces '));
let bundle = path.join(work, 'EQUIVIA');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = [], processes = [], browserErrors = [], unexpectedRequests = [], screenshots = [];
let browser, context, page, first, temporary, restarted, build;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function check(name, action) {
  try { const evidence = await action(); checks.push({ name, passed: true, evidence: evidence ?? null }); }
  catch (error) { checks.push({ name, passed: false, error: { message: error.message, stack: error.stack } }); throw error; }
}
async function allFiles(directory, prefix = '') {
  const result = [];
  for (const e of await readdir(directory, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) result.push(...await allFiles(path.join(directory, e.name), rel));
    else { assert.ok(e.isFile(), 'Only regular packaged files: ' + rel); result.push(rel); }
  }
  return result.sort();
}
function startRaw(directory, args = []) {
  const child = spawn('/bin/sh', [path.join(directory, 'EQUIVIA.sh'), ...args], {
    cwd: work,
    env: { PATH: '/no-system-node', LANG: 'C.UTF-8',
      NODE_OPTIONS: '--not-a-valid-node-option',
      NEBIUS_API_KEY: 'TEST_SENTINEL_NOT_A_KEY', NEBIUS_MODEL: 'TEST_SENTINEL_NOT_A_MODEL',
      NEBIUS_BASE_URL: 'https://example.invalid/unreachable',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const item = { child, args, stdout: '', stderr: '', closed: false, code: null, signal: null };
  processes.push(item);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => { item.stdout += text; });
  child.stderr.on('data', text => { item.stderr += text; });
  item.exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { item.closed = true; item.code = code; item.signal = signal; resolve({ code, signal }); });
  });
  return item;
}
async function until(predicate, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await delay(25); }
  throw new Error('Timed out: ' + label);
}
async function launch(args) {
  const p = startRaw(bundle, args);
  const url = await until(() => {
    const match = p.stdout.match(/^EQUIVIA ready at (http:\/\/127\.0\.0\.1:[0-9]+)$/m);
    if (match) return match[1];
    if (p.closed) throw new Error('Launcher exited before readiness: ' + p.code + '\n' + p.stderr);
  }, 18000, 'launcher readiness');
  p.url = url;
  const health = await (await fetch(url + '/health', { signal: AbortSignal.timeout(3000) })).json();
  assert.deepEqual(health, { ok: true, application: 'equivia' });
  return p;
}
async function stop(p, signal = 'SIGTERM') {
  if (!p || p.closed) return;
  p.child.kill(signal);
  await Promise.race([p.exit, delay(6000).then(() => { throw new Error('Launcher did not stop its child.'); })]);
}
async function offline(origin) {
  const config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.model.configured, false);
  for (const route of ['/api/coach', '/api/author']) {
    const result = await (await fetch(origin + route, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}',
    })).json();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MODEL_UNAVAILABLE');
  }
  return config;
}
async function stored(p) { return p.evaluate(() => JSON.parse(localStorage.getItem('equivia.notebook.v1'))); }
async function ready(p) {
  await p.waitForFunction(() => Boolean(JSON.parse(localStorage.getItem('equivia.notebook.v1'))?.worlds?.length));
  await p.waitForFunction(() => !document.querySelector('#model-status').textContent.includes('Checking'));
}
async function listening(p) {
  const ids = (await readFile('/proc/' + p.child.pid + '/task/' + p.child.pid + '/children', 'utf8')).trim().split(/\s+/).filter(Boolean);
  const observed = [];
  for (const pid of ids) {
    const fds = await readdir('/proc/' + pid + '/fd');
    const inodes = new Set();
    for (const fd of fds) {
      try { const target = await readlink('/proc/' + pid + '/fd/' + fd); const match = /^socket:\[(\d+)\]$/.exec(target); if (match) inodes.add(match[1]); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const table of ['tcp', 'tcp6']) {
      const rows = (await readFile('/proc/' + pid + '/net/' + table, 'utf8')).trim().split('\n').slice(1);
      for (const row of rows) {
        const fields = row.trim().split(/\s+/);
        if (fields[3] === '0A' && inodes.has(fields[9])) observed.push({ pid: Number(pid), family: table, address: fields[1].split(':')[0], port: parseInt(fields[1].split(':')[1], 16) });
      }
    }
  }
  assert.ok(observed.some(x => x.port === Number(new URL(p.url).port)), 'Owned listener must be observed.');
  assert.ok(observed.every(x => x.family === 'tcp' && x.address === '0100007F'), 'Only IPv4 loopback owned listeners.');
  p.serverPids = [...new Set(observed.map(x => x.pid))];
  return observed;
}
async function requireFreeDefaultPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(4192, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
}

let failure;
try {
  await check('final archive, complete manifest, permissions and exact source identity', async () => {
    assert.equal(sha(await readFile(archive)), expectedHash);
    const names = (await exec('/usr/bin/tar', ['-tzf', archive])).stdout.trim().split('\n');
    const types = (await exec('/usr/bin/tar', ['-tzvf', archive])).stdout.trim().split('\n');
    assert.equal(new Set(names).size, names.length, 'Archive members must be unique.');
    assert.ok(names.every(name => name.startsWith('EQUIVIA/') && !name.split('/').includes('..')), 'Safe package archive paths.');
    assert.ok(types.every(line => ['-', 'd'].includes(line[0])), 'Regular files and directories only.');
    await exec('/usr/bin/tar', ['-xzf', archive, '-C', work, '--no-same-owner']);
    const lines = (await readFile(path.join(bundle, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    const expected = [];
    for (const line of lines) {
      assert.match(line, /^[a-f0-9]{64}  [^\n]+$/);
      const rel = line.slice(66);
      assert.ok(!path.isAbsolute(rel) && !rel.split('/').includes('..'));
      expected.push(rel);
      assert.equal(sha(await readFile(path.join(bundle, rel))), line.slice(0, 64), rel);
    }
    assert.deepEqual((await allFiles(bundle)).filter(x => x !== 'SHA256SUMS'), expected.sort());
    assert.ok((await lstat(path.join(bundle, 'EQUIVIA.sh'))).mode & 0o111);
    assert.ok((await lstat(path.join(bundle, 'runtime', 'bin', 'node'))).mode & 0o111);
    build = JSON.parse(await readFile(path.join(bundle, 'BUILD.json'), 'utf8'));
    assert.equal(build.source_commit, expectedCommit);
    assert.equal(build.application, 'equivia'); assert.equal(build.platform, 'linux-x64'); assert.equal(build.launcher, 'EQUIVIA.sh');
    assert.match(build.source_tree, /^[a-f0-9]{40}$/);
    assert.equal(build.runtime.archive_sha256, 'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406');
    assert.equal(sha(await readFile(path.join(bundle, 'runtime', 'bin', 'node'))), build.runtime.executable_sha256);
    assert.ok((await readFile(path.join(bundle, 'runtime', 'LICENSE'), 'utf8')).includes('Node.js'));
    return { sha256: expectedHash, payloads: lines.length, sourceCommit: build.source_commit, sourceTree: build.source_tree, extractionPathHasSpaces: work.includes(' ') };
  });
  await check('bundled official runtime executes without a separate Node installation', async () => {
    const r = await exec(path.join(bundle, 'runtime', 'bin', 'node'), ['-p', 'JSON.stringify({version:process.version,arch:process.arch,platform:process.platform})'], { env: { PATH: '/no-system-node' } });
    const v = JSON.parse(r.stdout);
    assert.deepEqual(v, { version: 'v22.23.4', arch: 'x64', platform: 'linux' });
    return v;
  });
  await check('unknown and repeated options are refused before a server starts', async () => {
    for (const args of [['--unknown'], ['--temporary-port', '--temporary-port'], ['--port', '0']]) {
      const p = startRaw(bundle, args);
      const result = await Promise.race([p.exit, delay(3000).then(() => { throw new Error('Invalid arguments did not stop.'); })]);
      assert.equal(result.code, 2); assert.doesNotMatch(p.stdout, /^EQUIVIA ready at /m);
    }
    return { refused: ['unknown', 'duplicate', 'arbitrary port'] };
  });
  await check('default shipped launcher starts a loopback-only offline application with ambient settings removed', async () => {
    await requireFreeDefaultPort();
    first = await launch([]);
    assert.equal(first.url, 'http://127.0.0.1:4192');
    const listener = await listening(first);
    const config = await offline(first.url);
    assert.match(first.stdout, /This launcher does not open a browser automatically/);
    return { origin: first.url, listener, configuration: config, printedBrowserAddress: true, automaticBrowserOpen: false, ambientFakeNodeOptionsDidNotExecute: true };
  });
  const playwright = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  browser = await playwright.chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true, chromiumSandbox: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const origins = new Set([first.url]);
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^(blob:|data:)/.test(url) || [...origins].some(o => url.startsWith(o + '/'))) return route.continue();
    unexpectedRequests.push(url); return route.abort('blockedbyclient');
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  const watch = p => { p.on('pageerror', e => browserErrors.push(e.message)); p.on('console', e => { if (e.type() === 'error') browserErrors.push(e.text()); }); };
  watch(page); context.on('page', watch);
  let saved, notebookPath;
  await check('actual delivered browser path supports an intervention, accessible disclosure and notebook download', async () => {
    await page.goto(first.url, { waitUntil: 'networkidle' }); await ready(page);
    const before = await stored(page);
    await page.locator('#prediction-percent').fill('75');
    await page.locator('#run-one').click();
    await page.waitForFunction(length => JSON.parse(localStorage.getItem('equivia.notebook.v1')).history.length === length + 1, before.history.length);
    saved = await stored(page);
    assert.equal(saved.history.at(-1).kind, 'intervene');
    assert.equal(saved.history.at(-1).prediction, 0.75);
    assert.equal(saved.history.length, before.history.length + 1);
    assert.match(await page.locator('#budget').innerText(), /5 \/ 6/);
    const button = page.locator('#show-predictions');
    await button.focus(); await page.keyboard.press('Enter');
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#prediction-comparison').isVisible(), true);
    await page.keyboard.press('Space');
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#prediction-comparison').isVisible(), false);
    const downloaded = page.waitForEvent('download'); await page.locator('#save-notebook').click();
    notebookPath = path.join(out, 'receiving-notebook.json');
    await (await downloaded).saveAs(notebookPath);
    assert.deepEqual(JSON.parse(await readFile(notebookPath, 'utf8')), saved);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const filename = path.join(out, 'linux-delivered-' + width + '.png');
      await page.screenshot({ path: filename, fullPage: true, animations: 'disabled' }); screenshots.push(filename);
    }
    return { interventionsAdded: 1, disclosureKeyboard: ['Enter', 'Space'], downloadedNotebookMatches: true, screenshots };
  });
  await check('occupied default port refuses the second launch and preserves the first', async () => {
    const second = startRaw(bundle, []);
    await Promise.race([second.exit, delay(5000).then(() => { throw new Error('Occupied-port launch did not stop.'); })]);
    assert.equal(second.code, 1);
    assert.doesNotMatch(second.stdout, /^EQUIVIA ready at /m);
    assert.match(second.stderr, /EADDRINUSE/);
    assert.deepEqual(await (await fetch(first.url + '/health')).json(), { ok: true, application: 'equivia' });
    return { secondExit: second.code, firstPreserved: true };
  });
  await check('temporary session transfers the saved notebook and its shutdown leaves the default session alive', async () => {
    temporary = await launch(['--temporary-port']);
    assert.notEqual(temporary.url, first.url); origins.add(temporary.url);
    assert.match(temporary.stdout, /Temporary session/);
    await listening(temporary); await offline(temporary.url);
    const p = await context.newPage(); p.setDefaultTimeout(10000);
    await p.goto(temporary.url, { waitUntil: 'networkidle' }); await ready(p);
    await p.locator('#notebook-file').setInputFiles(notebookPath);
    await p.waitForFunction(length => JSON.parse(localStorage.getItem('equivia.notebook.v1')).history.length === length, saved.history.length);
    assert.deepEqual(await stored(p), saved);
    await p.close(); await stop(temporary, 'SIGHUP');
    assert.ok(temporary.serverPids.every(pid => !exists(pid)));
    assert.deepEqual(await (await fetch(first.url + '/health')).json(), { ok: true, application: 'equivia' });
    return { temporaryOrigin: temporary.url, importMatches: true, temporaryChildrenStopped: true, defaultSurvived: true };
  });
  await check('relocated normal relaunch preserves the notebook in the same browser profile and origin', async () => {
    await stop(first, 'SIGINT'); assert.equal(first.code, 130);
    assert.ok(first.serverPids.every(pid => !exists(pid)));
    const relocated = path.join(work, 'relocated EQUIVIA with spaces');
    await rename(bundle, relocated); bundle = relocated;
    restarted = await launch([]);
    assert.equal(restarted.url, first.url); await listening(restarted);
    await page.goto(restarted.url, { waitUntil: 'networkidle' }); await ready(page);
    assert.deepEqual(await stored(page), saved);
    await stop(restarted);
    assert.ok(restarted.serverPids.every(pid => !exists(pid)));
    return { sameOrigin: restarted.url, sameProfile: true, restoredHistory: saved.history.length, ownedChildrenStopped: true };
  });
  await check('startup timeout and bounded forced cleanup are exercised with an explicitly labeled fixture', async () => {
    const fixture = path.join(work, 'timeout fixture');
    await mkdir(path.join(fixture, 'runtime', 'bin'), { recursive: true }); await mkdir(path.join(fixture, 'app'));
    await copyFile(path.join(bundle, 'EQUIVIA.sh'), path.join(fixture, 'EQUIVIA.sh'));
    await copyFile(path.join(bundle, 'launcher.mjs'), path.join(fixture, 'launcher.mjs'));
    await link(path.join(bundle, 'runtime', 'bin', 'node'), path.join(fixture, 'runtime', 'bin', 'node'));
    await writeFile(path.join(fixture, 'app', 'server.mjs'), 'console.log("TIMEOUT_FIXTURE_PID=" + process.pid); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n');
    const p = startRaw(fixture, ['--temporary-port']);
    await Promise.race([p.exit, delay(22000).then(() => { throw new Error('Timeout fixture retained a live launcher.'); })]);
    assert.equal(p.code, 1); assert.match(p.stderr, /did not become ready within 15 seconds/);
    const match = p.stdout.match(/TIMEOUT_FIXTURE_PID=(\d+)/); assert.ok(match);
    assert.equal(exists(Number(match[1])), false);
    return { fixture: 'Synthetic child ignores SIGTERM and never reports readiness; no application/model claim.', timeoutObserved: true, ownedFixtureKilled: true };
  });
  await check('the delivered pages made no unexpected requests or browser errors', async () => {
    assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedRequests, []);
    return { browserErrors: 0, unexpectedRequests: 0, liveModelCalls: 0 };
  });
} catch (error) { failure = error; }
finally {
  await browser?.close().catch(() => {});
  for (const p of processes) if (!p.closed) {
    try { await stop(p); } catch { p.child.kill('SIGKILL'); await p.exit.catch(() => {}); }
  }
  const report = {
    evaluator: 'EQUIVIA Linux portable artifact receiving v1', executed: true, generatedAt: new Date().toISOString(),
    archive: path.resolve(archive), sha256: expectedHash, sourceCommit: expectedCommit, extracted: bundle,
    build, operatingSystem: { platform: process.platform, arch: process.arch, release: os.release(), distribution: await readFile('/etc/os-release', 'utf8') }, sandboxRequested: true, browserVersion: browser?.version(), checks,
    total: checks.length, passed: checks.filter(x => x.passed).length, failed: checks.filter(x => !x.passed).length,
    failure: failure?.message, browserErrors, unexpectedRequests, screenshots,
    processes: processes.map(p => ({ pid: p.child.pid, args: p.args, code: p.code, signal: p.signal, stdout: p.stdout, stderr: p.stderr })),
    limits: ['Linux browser launch is manual; actual receiving used a fresh headless Chrome context.',
      'Qualification is for the recorded Linux x64 GNU libc host, not all Linux distributions.',
      'Archive receiving does not establish a published release or recipient access.',
      'No live model invocation or participant learning evaluation.'],
  };
  await writeFile(path.join(out, 'linux-receiving.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed, failure: report.failure, output: out, screenshots }));
  process.exitCode = failure ? 1 : 0;
}
