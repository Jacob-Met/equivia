import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { smokeApplication } from '../tools/http-smoke.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { PATH: process.env.PATH, PORT: '0' };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'equivia entry alias '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function link(t, target, destination, type) {
  try { await symlink(target, destination, type); return true; }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Creating a symlink requires unavailable Windows privileges.');
      return false;
    }
    throw error;
  }
}

test('actual server CLI starts through a symlinked file with spaces', { timeout: 20000 }, async t => {
  const directory = await fixture(t);
  if (!await link(t, path.join(root, 'server.mjs'), path.join(directory, 'server.mjs'), 'file')) return;
  assert.equal((await smokeApplication(directory)).routes, 12);
});

test('actual server CLI starts through a symlinked parent directory', { timeout: 20000 }, async t => {
  const directory = await fixture(t);
  const alias = path.join(directory, 'aliased source');
  if (!await link(t, root, alias, 'dir')) return;
  assert.equal((await smokeApplication(alias)).routes, 12);
});

test('importing the server through an alias does not start a listener', { timeout: 10000 }, async t => {
  const directory = await fixture(t);
  const alias = path.join(directory, 'imported server.mjs');
  if (!await link(t, path.join(root, 'server.mjs'), alias, 'file')) return;
  const { stdout, stderr } = await exec(process.execPath, ['--input-type=module', '-e',
    'const m = await import(' + JSON.stringify(pathToFileURL(alias).href) + '); if (typeof m.createServer !== "function") throw new Error("Missing server export"); console.log("IMPORTED_WITHOUT_SERVER");'],
    { env, timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.equal(stdout.trim(), 'IMPORTED_WITHOUT_SERVER');
  assert.equal(stderr, '');
});

test('aliased HTTP smoke CLI executes checks instead of silently exiting', { timeout: 20000 }, async t => {
  const directory = await fixture(t);
  const alias = path.join(directory, 'http smoke.mjs');
  if (!await link(t, path.join(root, 'tools', 'http-smoke.mjs'), alias, 'file')) return;
  const { stdout } = await exec(process.execPath, [alias, root], { env, timeout: 15000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.ok, true);
  assert.equal(result.routes, 12);
});
