import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => !['--no-browser', '--temporary-port'].includes(arg)) || new Set(args).size !== args.length) {
  console.error('Usage: EQUIVIA.command [--no-browser] [--temporary-port]');
  process.exit(2);
}
const noBrowser = args.includes('--no-browser');
const temporaryPort = args.includes('--temporary-port');
const cleanEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', PORT: temporaryPort ? '0' : '4192' };
let ready = false;
let stopping = false;
let requestedExitCode = 0;
let startupTimer;
let killTimer;
const child = spawn(process.execPath, [path.join(root, 'app', 'server.mjs')], {
  cwd: path.join(root, 'app'), env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
const stdout = createInterface({ input: child.stdout });
const stderr = createInterface({ input: child.stderr });

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  requestedExitCode = code;
  clearTimeout(startupTimer);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 3000);
  killTimer.unref();
}

stdout.on('line', line => {
  console.log(line);
  if (ready || stopping) return;
  const match = /^EQUIVIA ready at (http:\/\/127\.0\.0\.1:[0-9]+)$/.exec(line);
  if (!match) return;
  let url;
  try { url = new URL(match[1]); } catch { return; }
  const port = Number(url.port);
  if (port < 1 || port > 65535 || url.pathname !== '/') return;
  ready = true;
  clearTimeout(startupTimer);
  console.log('Keep this window open. Press Ctrl+C to stop.');
  if (temporaryPort) console.log('Temporary session: use Save notebook before stopping, then Open notebook to resume later.');
  console.log('The laboratory runs locally. Model assistance is not configured in this portable build.');
  if (!noBrowser) {
    const opener = spawn('/usr/bin/open', [url.href], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: 'ignore',
    });
    const failed = () => console.error('Could not open a browser. Open the address above.');
    opener.once('error', failed);
    opener.once('exit', (code, signal) => { if (code !== 0 || signal) failed(); });
  }
});
stderr.on('line', line => {
  console.error(line);
  if (line.includes('EADDRINUSE')) console.error('The usual EQUIVIA address is already in use. Close the other instance, or use --temporary-port for a separate session.');
});
child.once('error', error => {
  console.error('Could not start EQUIVIA: ' + error.message);
  stop(1);
});
child.once('close', (code, signal) => {
  clearTimeout(startupTimer);
  clearTimeout(killTimer);
  stdout.close();
  stderr.close();
  if (!stopping) {
    if (!ready) console.error('EQUIVIA stopped before it became ready.');
    else if (code !== 0 || signal) console.error('EQUIVIA stopped unexpectedly.');
    process.exitCode = code === 0 && ready ? 0 : 1;
  } else process.exitCode = requestedExitCode;
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => stop(signal === 'SIGINT' ? 130 : 0));
}
process.once('exit', () => {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
});
startupTimer = setTimeout(() => {
  console.error('EQUIVIA did not become ready within 15 seconds.');
  stop(1);
}, 15000);
