import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeVersion = '22.23.4';
const runtimeFilename = 'node-v22.23.4-win-x64.zip';
const runtimeArchiveSha = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20';
const runtimeUrl = 'https://nodejs.org/dist/v22.23.4/' + runtimeFilename;
const checksumUrl = 'https://nodejs.org/dist/v22.23.4/SHASUMS256.txt';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build and receive this package on Windows x64.');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--runtime-archive') {
  throw new Error('Usage: node tools/package-windows.mjs --runtime-archive PATH/' + runtimeFilename);
}
const archive = path.resolve(args[1]);
if (!(await lstat(archive)).isFile()) throw new Error('Runtime archive must be a regular file.');
if (digest(await readFile(archive)) !== runtimeArchiveSha) throw new Error('Official Node runtime archive checksum mismatch.');
const systemRoot = process.env.SystemRoot || process.env.WINDIR;
if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('Windows system directory is unavailable.');
const system32 = path.join(systemRoot, 'System32');
const tar = path.join(system32, 'tar.exe');
const cleanEnv = {
  SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.join(system32, 'cmd.exe'),
  PATH: system32, TEMP: os.tmpdir(), TMP: os.tmpdir(),
};
const git = async (...argv) => (await exec('git', argv, { cwd: root })).stdout.trim();
const commit = await git('rev-parse', 'HEAD');
const tree = await git('rev-parse', 'HEAD^{tree}');
if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree)) throw new Error('A committed source identity is required.');
if (await git('status', '--porcelain=v1', '--untracked-files=normal')) throw new Error('Commit the package source before building.');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid application version.');
const work = await mkdtemp(path.join(os.tmpdir(), 'equivia-windows-'));
const dist = path.join(root, 'dist');
await mkdir(dist, { recursive: true });

async function filesUnder(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(absolute, rel));
    else if (entry.isFile()) found.push(rel);
    else throw new Error('Package contains a nonregular entry: ' + rel);
  }
  return found.sort();
}
async function verifyManifest(directory) {
  const lines = (await readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/);
  const names = [];
  for (const line of lines) {
    if (!/^[a-f0-9]{64}  [^\r\n]+$/.test(line)) throw new Error('Invalid payload manifest.');
    const name = line.slice(66);
    if (name.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe manifest path.');
    if (names.includes(name)) throw new Error('Duplicate manifest path.');
    names.push(name);
    if (digest(await readFile(path.join(directory, name))) !== line.slice(0, 64)) throw new Error('Payload checksum mismatch: ' + name);
  }
  const actual = await filesUnder(directory);
  if (JSON.stringify(actual) !== JSON.stringify([...names, 'SHA256SUMS'].sort())) throw new Error('Manifest must cover the complete package.');
  return lines;
}

try {
  const runtimeRoot = 'node-v22.23.4-win-x64';
  await exec(tar, ['-xf', archive, '-C', work,
    runtimeRoot + '/node.exe', runtimeRoot + '/LICENSE', runtimeRoot + '/README.md']);
  const node = path.join(work, runtimeRoot, 'node.exe');
  const actual = JSON.parse((await exec(node, ['-p', 'JSON.stringify({version:process.version,arch:process.arch,platform:process.platform})'], { env: cleanEnv })).stdout);
  if (actual.version !== 'v' + runtimeVersion || actual.arch !== 'x64' || actual.platform !== 'win32') throw new Error('Runtime platform or version mismatch.');

  // Reuse the maintained explicit source allowlist and fresh-extraction checks.
  const baseOutput = (await exec(node, [path.join(root, 'tools', 'package.mjs')], {
    cwd: root, env: cleanEnv, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  })).stdout;
  const base = JSON.parse(baseOutput.trim().split('\n').at(-1));
  if (!base.unitVerification?.ok || !base.verification?.ok) throw new Error('Maintained source package verification failed.');
  if (digest(await readFile(base.archive)) !== base.sha256) throw new Error('Maintained package changed before receiving.');
  const extracted = path.join(work, 'base');
  await mkdir(extracted);
  await exec(tar, ['-xzf', base.archive, '-C', extracted]);
  const bundle = path.join(work, 'EQUIVIA');
  await mkdir(path.join(bundle, 'runtime'), { recursive: true });
  await cp(path.join(extracted, 'equivia'), path.join(bundle, 'app'), { recursive: true });
  const sourceManifest = await verifyManifest(path.join(bundle, 'app'));
  for (const line of sourceManifest) {
    const relative = line.slice(66), expected = line.slice(0, 64);
    const committed = (await exec('git', ['show', commit + ':' + relative], {
      cwd: root, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024,
    })).stdout;
    if (digest(committed) !== expected || digest(await readFile(path.join(root, relative))) !== expected) {
      throw new Error('Application source changed during packaging: ' + relative);
    }
  }
  await copyFile(node, path.join(bundle, 'runtime', 'node.exe'));
  await copyFile(path.join(work, runtimeRoot, 'LICENSE'), path.join(bundle, 'runtime', 'LICENSE'));
  await copyFile(path.join(work, runtimeRoot, 'README.md'), path.join(bundle, 'runtime', 'README.md'));
  await copyFile(path.join(root, 'tools', 'windows-launcher.mjs'), path.join(bundle, 'launcher.mjs'));
  await copyFile(path.join(root, 'tools', 'EQUIVIA.cmd'), path.join(bundle, 'EQUIVIA.cmd'));
  await copyFile(path.join(root, 'docs', 'WINDOWS.md'), path.join(bundle, 'START-HERE.md'));
  if (await git('status', '--porcelain=v1', '--untracked-files=normal') || await git('rev-parse', 'HEAD') !== commit || await git('rev-parse', 'HEAD^{tree}') !== tree) throw new Error('Source changed during packaging.');
  const build = {
    application: 'equivia', version, platform: 'win32-x64',
    source_commit: commit, source_tree: tree,
    runtime: { ...actual, url: runtimeUrl, checksum_url: checksumUrl,
      archive_sha256: runtimeArchiveSha, executable_sha256: digest(await readFile(node)) },
    application_source_archive_sha256: base.sha256, application_files: sourceManifest.length,
    qualified_source_package: { unit: base.unitVerification, http: base.verification },
    launcher: 'EQUIVIA.cmd', model_configuration: 'absent: explicit empty application environment',
    limits: ['Private experimental portable folder; unsigned launcher.',
      'Native build qualification does not establish every Windows installation.',
      'No live model or educational efficacy qualification.'],
  };
  await writeFile(path.join(bundle, 'BUILD.json'), JSON.stringify(build, null, 2) + '\n');
  const payloads = await filesUnder(bundle);
  const manifest = [];
  for (const name of payloads) manifest.push(digest(await readFile(path.join(bundle, name))) + '  ' + name);
  await writeFile(path.join(bundle, 'SHA256SUMS'), manifest.join('\n') + '\n');
  const filename = 'equivia-' + version + '-windows-x64.zip';
  const result = path.join(dist, filename);
  await exec(tar, ['-a', '-cf', result, '-C', work, 'EQUIVIA']);
  const received = path.join(work, 'received with spaces');
  await mkdir(received);
  const entries = (await exec(tar, ['-tf', result])).stdout.trim().split(/\r?\n/);
  if (entries.some(name => !name.startsWith('EQUIVIA/') || name.includes('\\') || name.includes(':') || name.split('/').some(p => p === '..' || p === '.'))) throw new Error('Unexpected ZIP entry.');
  await exec(tar, ['-xf', result, '-C', received]);
  await verifyManifest(path.join(received, 'EQUIVIA'));
  const resultBytes = await readFile(result);
  const receipt = { archive: result, bytes: resultBytes.length, sha256: digest(resultBytes), payloads: payloads.length, build };
  await writeFile(result + '.sha256', receipt.sha256 + '  ' + filename + '\n');
  await writeFile(path.join(dist, 'windows-build.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally {
  await rm(work, { recursive: true, force: true });
}
