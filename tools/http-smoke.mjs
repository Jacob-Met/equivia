import { realpathSync } from 'node:fs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Start the actual CLI on an ephemeral loopback port and exercise HTTP offline. */
export async function smokeApplication(appRoot = projectRoot) {
  const env = { ...process.env, PORT: '0' };
  delete env.NEBIUS_API_KEY;
  delete env.NEBIUS_MODEL;
  delete env.NEBIUS_BASE_URL;
  const child = spawn(process.execPath, [path.join(appRoot, 'server.mjs')], { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  try {
    const origin = await new Promise((resolve, reject) => {
      let stdout = '';
      const timer = setTimeout(() => reject(new Error('Application startup timed out.')), 10000);
      const stop = () => clearTimeout(timer);
      child.once('error', (error) => { stop(); reject(error); });
      child.once('exit', (code) => { stop(); reject(new Error(`Application exited before startup (${code}).`)); });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout = (stdout + chunk).slice(-4096);
        const match = stdout.match(/EQUIVIA ready at (http:\/\/127\.0\.0\.1:\d+)\r?\n/);
        if (match) { stop(); resolve(match[1]); }
      });
    });
    const get = (route, options = {}) => fetch(new URL(route, origin), { ...options, signal: AbortSignal.timeout(5000) });
    const health = await get('/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, application: 'equivia' });
    for (const route of ['/', '/styles.css', '/app.js', '/src/engine.js', '/src/model.js', '/src/session.js']) {
      const response = await get(route);
      assert.equal(response.status, 200, `${route} should be served`);
      assert.ok((await response.arrayBuffer()).byteLength > 0, `${route} should contain bytes`);
    }
    const config = await (await get('/api/config')).json();
    assert.equal(config.model.configured, false);
    const body = JSON.stringify({ brief: 'A new two-lamp causal puzzle', variableIds: ['A', 'B'] });
    for (const [route, input] of [['/api/author', body], ['/api/coach', '{}']]) {
      const unavailable = await get(route, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: input });
      assert.equal(unavailable.status, 200);
      const result = await unavailable.json();
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'MODEL_UNAVAILABLE');
      assert.equal(Object.hasOwn(result, 'advice'), false);
      assert.equal(Object.hasOwn(result, 'proposal'), false);
    }
    assert.equal((await get('/api/author', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://external.invalid' }, body })).status, 403);
    assert.equal((await get('/src/provider.js')).status, 404);
    return { ok: true, verification: 'actual CLI and HTTP routes passed with provider credentials removed', routes: 12 };
  } catch (error) {
    // Startup stderr contains only this application's process output; provider
    // credentials were removed. Keep failures concise for packaging logs.
    if (stderr) error.message += ` Server stderr: ${stderr.trim()}`;
    throw error;
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(force); }
    }
  }
}

function isDirectEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntryPoint()) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : projectRoot;
  console.log(JSON.stringify(await smokeApplication(target)));
}
