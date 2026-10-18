// Own the external driver and runner process groups, including WebKit/app children.
// This command never builds: CI and local runs use the same existing release binary.
import { spawn } from 'node:child_process';
import { open, mkdir, access } from 'node:fs/promises';
import { constants, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'linux') throw new Error('test:e2e requires Linux, WebKitWebDriver, Xvfb and xdotool.');
const binary = resolve(process.env.MD_VIEWER_BINARY || 'src-tauri/target/release/markdown-viewer');
await mkdir('artifacts/e2e', { recursive: true });
const log = await open('artifacts/e2e/driver.log', 'w');
const runnerLog = await open('artifacts/e2e/runner.log', 'w');
const children = [];
const closed = [];
let stopping = false;
let fail;
const failure = new Promise((_, reject) => { fail = reject; });
// Attach immediately, including during readiness checks.
failure.catch(() => {});
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const signalHandlers = new Map(signals.map(signal => [signal, () => fail(new Error(`E2E interrupted: ${signal}`))]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
const deadline = setTimeout(() => fail(new Error('E2E exceeded 5 minutes')), 300000);
function launch(command, args, output) {
  const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  closed.push(new Promise(ok => child.once('close', ok)));
  child.stdout.on('data', chunk => { process.stdout.write(chunk); writeSync(output.fd, chunk); });
  child.stderr.on('data', chunk => { process.stderr.write(chunk); writeSync(output.fd, chunk); });
  child.on('error', fail);
  return child;
}
function killGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
async function portsAvailable() {
  for (const port of [4844, 4845]) {
    const server = createServer();
    await new Promise((ok, reject) => server.once('error', reject).listen(port, '127.0.0.1', ok));
    await new Promise((ok, reject) => server.close(error => error ? reject(error) : ok()));
  }
}
try {
  await access(binary, constants.X_OK);
  await portsAvailable(); // Never attach to, or kill, someone else's driver.
  const driver = launch(process.env.TAURI_DRIVER_BINARY || 'tauri-driver',
    ['--port', '4844', '--native-port', '4845'], log);
  driver.on('exit', (code, signal) => {
    if (!stopping) fail(new Error(`tauri-driver exited: ${code ?? signal}`));
  });
  await Promise.race([failure, (async () => {
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      try {
        const response = await fetch('http://127.0.0.1:4844/status', { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).value.ready) return;
      } catch { /* bounded startup polling */ }
      await delay(100);
    }
    throw new Error('tauri-driver did not become ready within 12 seconds');
  })()]);
  const runner = launch('pnpm', ['exec', 'wdio', 'run', 'wdio.conf.ts'], runnerLog);
  const code = await Promise.race([failure, new Promise(ok => runner.once('exit', code => ok(code ?? 1)))]);
  process.exitCode = code;
} catch (error) {
  console.error(error);
  await runnerLog.write(`${error.stack || error}\n`);
  process.exitCode = 1;
} finally {
  stopping = true;
  clearTimeout(deadline);
  // Session deletion normally closes the app. Group teardown also handles crashes,
  // failed session creation and signals without broad process-name killing.
  for (const child of children.toReversed()) killGroup(child, 'SIGTERM');
  await delay(500);
  for (const child of children.toReversed()) killGroup(child, 'SIGKILL');
  await Promise.race([Promise.all(closed), delay(2000)]);
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  await log.close();
  await runnerLog.close();
}
