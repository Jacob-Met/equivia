import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeVersion = '22.23.4';
const runtimeFilename = 'node-v22.23.4-darwin-arm64.tar.gz';
const runtimeArchiveSha = 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428';
const runtimeUrl = 'https://nodejs.org/dist/v22.23.4/' + runtimeFilename;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const cleanEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
const args = process.argv.slice(2);
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build and receive this package on a Mac with Apple silicon.');
if (args.length !== 2 || args[0] !== '--runtime-archive') {
  throw new Error('Usage: node tools/package-macos.mjs --runtime-archive /absolute/path/' + runtimeFilename);
}
const archive = path.resolve(args[1]);
if (!(await lstat(archive)).isFile()) throw new Error('Runtime archive must be a regular file.');
if (digest(await readFile(archive)) !== runtimeArchiveSha) throw new Error('Official Node runtime archive checksum mismatch.');
const git = async (...argv) => (await exec('git', argv, { cwd: root })).stdout.trim();
const commit = await git('rev-parse', 'HEAD');
const tree = await git('rev-parse', 'HEAD^{tree}');
if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree)) throw new Error('A committed source identity is required.');
if (await git('status', '--porcelain=v1', '--untracked-files=normal')) throw new Error('Commit the package source before building.');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const work = await mkdtemp(path.join(os.tmpdir(), 'equivia-macos-'));
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

try {
  const runtimeRoot = 'node-v22.23.4-darwin-arm64';
  await exec('/usr/bin/tar', ['-xzf', archive, '-C', work,
    runtimeRoot + '/bin/node', runtimeRoot + '/LICENSE', runtimeRoot + '/README.md']);
  const node = path.join(work, runtimeRoot, 'bin', 'node');
  const actual = JSON.parse((await exec(node, ['-p', 'JSON.stringify({version:process.version,arch:process.arch,platform:process.platform})'], { env: cleanEnv })).stdout);
  if (actual.version !== 'v' + runtimeVersion || actual.arch !== 'arm64' || actual.platform !== 'darwin') throw new Error('Runtime platform or version mismatch.');
  const linkage = (await exec('/usr/bin/otool', ['-L', node])).stdout;
  const dependencies = linkage.split('\n').slice(1).filter(Boolean).map(line => line.trim().split(' (')[0]);
  if (dependencies.some(name => !name.startsWith('/usr/lib/') && !name.startsWith('/System/Library/'))) {
    throw new Error('Runtime has an unbundled non-system dynamic dependency.');
  }

  // Reuse the maintained source allowlist and its fresh-extraction checks.
  // The verified bundled runtime executes the original package procedure.
  const baseOutput = (await exec(node, [path.join(root, 'tools', 'package.mjs')], {
    cwd: root, env: cleanEnv, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  })).stdout;
  const base = JSON.parse(baseOutput.trim().split('\n').at(-1));
  if (!base.unitVerification?.ok || !base.verification?.ok) throw new Error('Maintained portable package verification did not pass.');
  if (digest(await readFile(base.archive)) !== base.sha256) throw new Error('Maintained package changed before receiving.');

  const extracted = path.join(work, 'base');
  await mkdir(extracted);
  await exec('/usr/bin/tar', ['-xzf', base.archive, '-C', extracted]);
  const bundle = path.join(work, 'EQUIVIA');
  await mkdir(path.join(bundle, 'runtime', 'bin'), { recursive: true });
  await cp(path.join(extracted, 'equivia'), path.join(bundle, 'app'), { recursive: true });
  const sourceManifest = (await readFile(path.join(bundle, 'app', 'SHA256SUMS'), 'utf8')).trim().split('\n');
  for (const line of sourceManifest) {
    const relative = line.slice(66);
    const expected = line.slice(0, 64);
    const bytes = await readFile(path.join(bundle, 'app', relative));
    const committed = (await exec('git', ['show', commit + ':' + relative], { cwd: root, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout;
    if (digest(bytes) !== expected || digest(committed) !== expected || digest(await readFile(path.join(root, relative))) !== expected) {
      throw new Error('Application source changed during packaging: ' + relative);
    }
  }
  await copyFile(node, path.join(bundle, 'runtime', 'bin', 'node'));
  await copyFile(path.join(work, runtimeRoot, 'LICENSE'), path.join(bundle, 'runtime', 'LICENSE'));
  await copyFile(path.join(work, runtimeRoot, 'README.md'), path.join(bundle, 'runtime', 'README.md'));
  await copyFile(path.join(root, 'tools', 'macos-launcher.mjs'), path.join(bundle, 'launcher.mjs'));
  await copyFile(path.join(root, 'tools', 'EQUIVIA.command'), path.join(bundle, 'EQUIVIA.command'));
  await copyFile(path.join(root, 'docs', 'MACOS.md'), path.join(bundle, 'START-HERE.md'));
  await chmod(path.join(bundle, 'EQUIVIA.command'), 0o755);
  await chmod(path.join(bundle, 'runtime', 'bin', 'node'), 0o755);
  if (await git('status', '--porcelain=v1', '--untracked-files=normal') || await git('rev-parse', 'HEAD') !== commit || await git('rev-parse', 'HEAD^{tree}') !== tree) throw new Error('Source changed during packaging.');

  const build = {
    application: 'equivia', version, platform: 'darwin-arm64',
    source_commit: commit, source_tree: tree,
    runtime: { ...actual, url: runtimeUrl, archive_sha256: runtimeArchiveSha,
      executable_sha256: digest(await readFile(node)), system_dependencies: dependencies },
    application_source_archive_sha256: base.sha256,
    application_files: sourceManifest.length,
    qualified_source_package: { unit: base.unitVerification, http: base.verification },
    launcher: 'EQUIVIA.command', model_configuration: 'absent: launcher uses an explicit clean environment',
    limits: ['Private experimental portable folder; no app signing or notarization claim.',
      'Model fixtures do not qualify live model performance.', 'Browser and normal macOS launch controls are required.'],
  };
  await writeFile(path.join(bundle, 'BUILD.json'), JSON.stringify(build, null, 2) + '\n');
  const payloads = await filesUnder(bundle);
  const manifest = [];
  for (const name of payloads) manifest.push(digest(await readFile(path.join(bundle, name))) + '  ' + name);
  await writeFile(path.join(bundle, 'SHA256SUMS'), manifest.join('\n') + '\n');
  const filename = 'equivia-' + version + '-macos-arm64.tar.gz';
  const result = path.join(dist, filename);
  await exec('/usr/bin/tar', ['-czf', result, '-C', work, 'EQUIVIA'], { env: { ...cleanEnv, COPYFILE_DISABLE: '1' } });
  const resultBytes = await readFile(result);
  const receipt = { archive: result, bytes: resultBytes.length, sha256: digest(resultBytes),
    payloads: payloads.length, build };
  await writeFile(result + '.sha256', receipt.sha256 + '  ' + filename + '\n');
  await writeFile(path.join(dist, 'macos-build.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally {
  await rm(work, { recursive: true, force: true });
}
