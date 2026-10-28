import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { createServer } from './app/server.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--no-browser', '--temporary-port'].includes(arg)) || new Set(args).size !== args.length) {
  console.error('Usage: EQUIVIA.cmd [--no-browser] [--temporary-port]');
  process.exit(2);
}
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('This portable build requires Windows x64.');
  process.exit(1);
}
const temporary = args.includes('--temporary-port');
const noBrowser = args.includes('--no-browser');
// Keep the application and its listener in this process. There is no detached
// server child to survive a closed launcher window.
const server = createServer({ env: {} });
let input;
let stopping = false;
let shutdownTimer;
const startupTimer = setTimeout(() => {
  console.error('EQUIVIA did not become ready within 15 seconds.');
  stop(1);
}, 15000);

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(startupTimer);
  input?.close();
  process.stdin.pause();
  shutdownTimer = setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(code);
  }, 3000);
  server.close(() => {
    clearTimeout(shutdownTimer);
    process.exitCode = code;
  });
  server.closeIdleConnections?.();
}

server.once('error', error => {
  clearTimeout(startupTimer);
  console.error(error.code === 'EADDRINUSE'
    ? 'The usual EQUIVIA address is already in use. Leave the other process alone; close your other EQUIVIA window, or explicitly use --temporary-port for a separate session.'
    : 'Could not start EQUIVIA: ' + error.message);
  input?.close();
  process.stdin.pause();
  process.exitCode = 1;
});
server.listen(temporary ? 0 : 4192, '127.0.0.1', () => {
  clearTimeout(startupTimer);
  if (stopping) { server.close(); return; }
  const url = 'http://127.0.0.1:' + server.address().port;
  console.log('EQUIVIA ready at ' + url);
  console.log('Keep this window open. Press Enter here to stop; Ctrl+C also stops the laboratory.');
  if (temporary) console.log('Temporary session: Save notebook before stopping, then Open notebook to resume at another address.');
  console.log('The laboratory runs locally. Model assistance is not configured in this portable build.');
  input = createInterface({ input: process.stdin });
  input.once('line', () => stop(0));
  // EOF alone is not a stop request: redirected native receiving may have no
  // interactive stdin. The listener remains available until explicit shutdown.
  if (!noBrowser) {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    if (!systemRoot) console.error('Could not locate the browser opener. Open the address above.');
    else {
      const opener = spawn(path.join(systemRoot, 'System32', 'rundll32.exe'),
        ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', detached: true, windowsHide: true });
      const failed = () => console.error('Could not open a browser. Open the address above.');
      opener.once('error', failed);
      opener.once('exit', (code, signal) => { if (code !== 0 || signal) failed(); });
      opener.unref();
    }
  }
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => stop(signal === 'SIGINT' ? 130 : 0));
}
