import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeApplication } from './http-smoke.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = [
  'package.json', 'server.mjs', 'public/index.html', 'public/styles.css', 'public/app.js',
  'src/engine.js', 'src/model.js', 'src/provider.js', 'src/session.js', 'src/forecast.js', 'src/observation-comparison.js', 'src/trial-evidence.js',
  'public/creator.html', 'public/creator.css', 'public/creator.js', 'src/creator.js',
];
const optionalFiles = ['README.md', 'LICENSE', 'LICENSE.md', '.env.example'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function collectVerificationFiles(directory) {
  let entries;
  try { entries = await readdir(path.join(root, directory), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await collectVerificationFiles(name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Verification tree must contain regular files only: ${name}`);
  }
  return files;
}

const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(metadata.version)) throw new Error('Package requires a valid version.');
const version = metadata.version;
const work = await mkdtemp(path.join(os.tmpdir(), 'equivia-package-'));
try {
  const files = [...requiredFiles];
  for (const name of optionalFiles) {
    try { if ((await lstat(path.join(root, name))).isFile()) files.push(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Retain the normal verification entrypoints in the portable source package.
  for (const directory of ['test', 'tools', 'review', 'docs']) files.push(...await collectVerificationFiles(directory));
  files.sort();
  const staging = path.join(work, 'stage', 'equivia');
  await mkdir(staging, { recursive: true });
  const manifest = [];
  for (const name of files) {
    const source = path.join(root, name);
    if (!(await lstat(source)).isFile()) throw new Error(`Runtime file must be a regular file: ${name}`);
    const destination = path.join(staging, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    manifest.push(`${sha256(await readFile(destination))}  ${name}`);
  }
  await writeFile(path.join(staging, 'SHA256SUMS'), `${manifest.join('\n')}\n`);
  const dist = path.join(root, 'dist');
  await mkdir(dist, { recursive: true });
  const filename = `equivia-${version}.tar.gz`;
  const archive = path.join(dist, filename);
  // Only the explicit allowlist above is archived; env files, credentials,
  // repository internals and saved investigations cannot enter by recursion.
  await exec('tar', ['-czf', archive, '-C', path.dirname(staging), 'equivia']);
  const archiveBytes = await readFile(archive);
  const archiveHash = sha256(archiveBytes);
  await writeFile(path.join(dist, `${filename}.sha256`), `${archiveHash}  ${filename}\n`);
  await writeFile(path.join(dist, `equivia-${version}.files.sha256`), `${manifest.join('\n')}\n`);

  const extracted = path.join(work, 'extracted');
  await mkdir(extracted);
  await exec('tar', ['-xzf', archive, '-C', extracted]);
  const extractedRoot = path.join(extracted, 'equivia');
  for (const entry of manifest) {
    const expected = entry.slice(0, 64), name = entry.slice(66);
    const actual = sha256(await readFile(path.join(extractedRoot, name)));
    if (actual !== expected) throw new Error(`Extracted checksum mismatch: ${name}`);
  }
  const testFiles = files.filter((name) => /^test\/.*\.test\.(?:mjs|js)$/.test(name));
  if (!testFiles.length) throw new Error('Portable package must contain its Node unit tests.');
  const testEnv = { ...process.env };
  delete testEnv.NEBIUS_API_KEY;
  delete testEnv.NEBIUS_MODEL;
  delete testEnv.NEBIUS_BASE_URL;
  const { stdout: testOutput } = await exec(process.execPath, ['--test', ...testFiles], {
    cwd: extractedRoot, env: testEnv, timeout: 120000, maxBuffer: 1048576,
  });
  const total = testOutput.match(/^# tests (\d+)$/m);
  const passed = testOutput.match(/^# pass (\d+)$/m);
  const unitVerification = {
    ok: true,
    testFiles: testFiles.length,
    ...(total ? { tests: Number(total[1]) } : {}),
    ...(passed ? { passed: Number(passed[1]) } : {}),
  };
  const verification = await smokeApplication(extractedRoot);
  console.log(JSON.stringify({ archive, sha256: archiveHash, bytes: archiveBytes.length, files: files.length, unitVerification, verification }));
} finally {
  await rm(work, { recursive: true, force: true });
}
