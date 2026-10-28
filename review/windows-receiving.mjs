/**
 * Receive the actual Windows ZIP, with an independently generated Git manifest.
 * node review/windows-receiving.mjs ARCHIVE SHA256 FRESH_OUTPUT APP_SHA256SUMS
 * No unrelated process is stopped. Ctrl+C/Explorer interaction are not claimed.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, lstat, cp, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import path from 'node:path';
const exec = promisify(execFile);
const [archiveArg, expected, outputArg, baselineArg] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert(archiveArg && outputArg && baselineArg && /^[a-f0-9]{64}$/i.test(expected ?? ''), 'Usage: ARCHIVE SHA256 FRESH_OUTPUT APP_SHA256SUMS');
const archive = path.resolve(archiveArg), output = path.resolve(outputArg);
const systemRoot = process.env.SystemRoot || process.env.WINDIR;
assert(systemRoot && path.isAbsolute(systemRoot));
const system32 = path.join(systemRoot, 'System32');
const tar = path.join(system32, 'tar.exe'), cmd = path.join(system32, 'cmd.exe');
const ps = path.join(system32, 'WindowsPowerShell/v1.0/powershell.exe');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { startedAt: new Date().toISOString(), archive, expectedHash: expected.toLowerCase(), output,
  checks: [], limitations: ['Interactive Explorer/default browser opening and Ctrl+C are untested.',
    'EOF-only behavior is untested.', 'No process is forcibly killed by this harness.'] };
await mkdir(output);
const unpack = path.join(output, 'fresh extraction with spaces'), root = path.join(unpack, 'EQUIVIA');
await mkdir(unpack);
function record(name, status, evidence) { report.checks.push({ name, status, evidence }); }
function safeRelative(value, directory = false) {
  assert(value && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/') && !value.includes(':'), 'Unsafe archive path: ' + value);
  const clean = directory ? value.replace(/\/$/, '') : value;
  assert(clean.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) &&
    !/[<>"|?*\x00-\x1f]/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), 'Unsafe Windows name: ' + value);
  return clean;
}
async function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    safeRelative(name);
    const full = path.join(directory, entry.name), stat = await lstat(full);
    assert(!stat.isSymbolicLink(), 'Link forbidden: ' + name);
    if (stat.isDirectory()) files.push(...await filesUnder(full, name));
    else { assert(stat.isFile(), 'Nonregular file: ' + name); files.push(name); }
  }
  return files.sort();
}
function parseSums(text) {
  const sums = new Map(), folded = new Set();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const m = /^([a-f0-9]{64}) [ *](.+)$/i.exec(line);
    assert(m, 'Invalid checksum line');
    const name = safeRelative(m[2]); assert(!folded.has(name.toLowerCase()), 'Duplicate checksum path');
    folded.add(name.toLowerCase()); sums.set(name, m[1].toLowerCase());
  }
  return sums;
}
async function verifySums(directory, manifestText) {
  const sums = parseSums(manifestText);
  assert.deepEqual([...sums.keys()].sort(), (await filesUnder(directory)).filter(n => n !== 'SHA256SUMS'), 'Manifest file set');
  for (const [name, digest] of sums) assert.equal(hash(await readFile(path.join(directory, name))), digest, 'Checksum: ' + name);
  return Object.fromEntries(sums);
}
const env = { SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: cmd, PATH: system32,
  TEMP: process.env.TEMP, TMP: process.env.TMP, NEBIUS_API_KEY: 'receiving-sentinel-not-a-real-key', NEBIUS_MODEL: 'RECEIVING-SENTINEL' };
async function listeners(port) {
  const script = "$ErrorActionPreference='Stop'; $r=@(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -eq " + Number(port) +
    "} | ForEach-Object {$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_.OwningProcess); " +
    "[pscustomobject]@{address=$_.LocalAddress;pid=$_.OwningProcess;parentPid=$p.ParentProcessId;executable=$p.ExecutablePath}}); ConvertTo-Json -InputObject $r -Compress";
  const { stdout } = await exec(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000 });
  const rows = JSON.parse(stdout.trim()); return Array.isArray(rows) ? rows : [rows];
}
function launch(directory, flags) {
  const allowed = new Set(['--no-browser', '--temporary-port', '--receiving-invalid-flag']);
  assert(flags.every(f => allowed.has(f)));
  const batch = path.join(directory, 'EQUIVIA.cmd'); assert(!batch.includes('"'));
  const child = spawn(cmd, ['/d', '/v:off', '/s', '/c', '""' + batch + '" ' + flags.join(' ') + '"'],
    { cwd: directory, env, windowsHide: true, windowsVerbatimArguments: true, stdio: 'pipe' });
  const run = { child, closed: false, stdout: '', stderr: '', exit: null };
  child.stdout.on('data', b => { run.stdout += b; }); child.stderr.on('data', b => { run.stderr += b; });
  child.stdin.on('error', () => {}); child.on('error', e => { run.spawnError = String(e); });
  child.on('close', (code, signal) => { run.closed = true; run.exit = { code, signal }; }); return run;
}
async function wait(check, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Timeout after ' + milliseconds + 'ms');
}
const logs = run => ({ cmdPid: run.child.pid, exit: run.exit, stdout: run.stdout, stderr: run.stderr, spawnError: run.spawnError });
async function stop(run) { if (!run.closed) run.child.stdin.end('\n'); await wait(() => run.closed); }
async function refusal(directory, flags) {
  const run = launch(directory, flags); let primary, cleanup;
  try { await wait(() => run.closed); assert.notEqual(run.exit.code, 0); assert(!/^EQUIVIA ready at /m.test(run.stdout)); }
  catch (e) { primary = e; }
  try { if (!run.closed) await stop(run); } catch (e) { cleanup = e; }
  record('refusal process evidence', cleanup ? 'cleanup-blocked' : 'recorded', { ...logs(run), primary: String(primary ?? ''), cleanup: String(cleanup ?? '') });
  if (primary || cleanup) throw new AggregateError([primary, cleanup].filter(Boolean), 'Refusal or cleanup failed');
  return logs(run);
}
async function receive(flags) {
  const run = launch(root, flags); let port, evidence, primary, cleanup, released = null;
  try {
    const match = await wait(() => {
      const m = /^EQUIVIA ready at http:\/\/127\.0\.0\.1:(\d+)\r?$/m.exec(run.stdout);
      if (m) return m; assert(!run.closed, 'Exited before readiness: ' + JSON.stringify(logs(run))); return false;
    });
    port = Number(match[1]); assert(port > 0 && port <= 65535);
    if (!flags.includes('--temporary-port')) assert.equal(port, 4192);
    const rows = await listeners(port); assert.equal(rows.length, 1); assert.equal(rows[0].address, '127.0.0.1');
    assert.equal(Number(rows[0].parentPid), run.child.pid);
    assert.equal(path.resolve(rows[0].executable).toLowerCase(), path.join(root, 'runtime/node.exe').toLowerCase());
    const get = async route => {
      const response = await fetch('http://127.0.0.1:' + port + route, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); return response.json();
    };
    const health = await get('/health'), config = await get('/api/config');
    assert.equal(health.ok, true); assert.equal(health.application, 'equivia'); assert.equal(config.model.configured, false);
    evidence = { port, listener: rows[0], health, config };
  } catch (e) { primary = e; }
  try { await stop(run); assert.equal(run.exit.code, 0); if (port) { released = (await listeners(port)).length === 0; assert(released); } }
  catch (e) { cleanup = e; }
  record('launch process evidence', cleanup ? 'cleanup-blocked' : 'recorded', { ...logs(run), port: port ?? null, listenerReleased: released,
    primary: primary?.stack ?? null, cleanup: cleanup?.stack ?? null });
  if (primary || cleanup) throw new AggregateError([primary, cleanup].filter(Boolean), 'Receiving or cleanup failed');
  return evidence;
}
async function check(name, fn) {
  try { record(name, 'pass', await fn()); } catch (e) { record(name, 'fail', String(e.stack ?? e)); process.exitCode = 1; }
}
try {
  const actualHash = hash(await readFile(archive)); assert.equal(actualHash, expected.toLowerCase(), 'Archive identity');
  record('downloaded archive identity', 'pass', { actualHash });
  const options = { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 };
  const entries = (await exec(tar, ['-tf', archive], options)).stdout.split(/\r?\n/).filter(Boolean);
  assert(entries.length); const seen = new Set();
  for (const entry of entries) {
    const name = safeRelative(entry, true); assert(name === 'EQUIVIA' || name.startsWith('EQUIVIA/'));
    assert(!seen.has(name.toLowerCase()), 'Case-colliding archive entry'); seen.add(name.toLowerCase());
  }
  const details = (await exec(tar, ['-tvf', archive], options)).stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(details.length, entries.length); assert(details.every(l => l[0] === '-' || l[0] === 'd'), 'Nonregular ZIP entry or unsupported listing');
  await exec(tar, ['-xf', archive, '-C', unpack], { ...options, timeout: 60000 });
  assert.deepEqual(await readdir(unpack), ['EQUIVIA']);
  const files = await filesUnder(root);
  assert.deepEqual(files, entries.filter((_, i) => details[i][0] === '-').map(n => n.slice(8)).sort());
  const packageSums = await verifySums(root, await readFile(path.join(root, 'SHA256SUMS'), 'utf8'));
  const appSums = await verifySums(path.join(root, 'app'), await readFile(path.join(root, 'app/SHA256SUMS'), 'utf8'));
  const build = JSON.parse(await readFile(path.join(root, 'BUILD.json'), 'utf8'));
  assert.equal(build.runtime.executable_sha256, packageSums['runtime/node.exe']);
  const baseline = await readFile(path.resolve(baselineArg), 'utf8');
  await verifySums(path.join(root, 'app'), baseline);
  record('complete manifests and independent Git baseline', 'pass', { files: files.length, build, baselineSHA256: hash(Buffer.from(baseline)) });
  await check('no installed Node on scoped PATH', async () => {
    try { await exec(path.join(system32, 'where.exe'), ['node'], { env, windowsHide: true, timeout: 10000 }); throw Error('Node resolved from scoped PATH'); }
    catch (e) { assert.equal(e.code, 1); }
    return JSON.parse((await exec(path.join(root, 'runtime/node.exe'), ['-p', 'JSON.stringify({execPath:process.execPath,version:process.version})'], { env, windowsHide: true })).stdout);
  });
  await check('invalid flag rejected', () => refusal(root, ['--no-browser', '--receiving-invalid-flag']));
  await check('missing runtime rejected', async () => {
    const broken = path.join(output, 'missing runtime fixture', 'EQUIVIA'); await mkdir(path.dirname(broken));
    await cp(root, broken, { recursive: true }); await rename(path.join(broken, 'runtime/node.exe'), path.join(broken, 'runtime/node.exe.disabled'));
    return refusal(broken, ['--no-browser']);
  });
  const occupied = await listeners(4192);
  if (occupied.length) { record('fixed-port receiving', 'blocked', { reason: 'Preexisting listener preserved', listeners: occupied }); process.exitCode = 1; }
  else {
    await check('occupied-port refusal preserves fixture listener', async () => {
      const fixture = createServer(socket => socket.end());
      await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(4192, '127.0.0.1', resolve); });
      try {
        const before = await listeners(4192); assert(before.some(row => Number(row.pid) === process.pid));
        const actualLauncher = await refusal(root, ['--no-browser']); const after = await listeners(4192); assert.deepEqual(after, before);
        return { before, after, actualLauncher };
      } finally { await new Promise((resolve, reject) => fixture.close(e => e ? reject(e) : resolve())); }
    });
    await check('actual fixed-port launch and Enter stop', () => receive(['--no-browser']));
  }
  await check('actual temporary-port launch and Enter stop', () => receive(['--no-browser', '--temporary-port']));
  await check('application bytes unchanged after receiving', async () => {
    assert.deepEqual(await verifySums(path.join(root, 'app'), await readFile(path.join(root, 'app/SHA256SUMS'), 'utf8')), appSums);
    return { files: Object.keys(appSums).length };
  });
  report.extractedRoot = root;
} catch (e) { report.prerequisiteFailure = String(e.stack ?? e); process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString(); report.passed = !process.exitCode;
  const reportPath = path.join(output, 'windows-receiving-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: reportPath, passed: report.passed }));
}
