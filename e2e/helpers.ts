import { browser } from '@wdio/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const binary = resolve(process.env.MD_VIEWER_BINARY || join(root, 'src-tauri/target/release/markdown-viewer'));
export const run = promisify(execFile);
export const example = (name: string) => join(root, 'examples', name);

// Script bodies intentionally execute in the real WebView, with its own globals.
// Keeping this boundary explicit prevents test-runner globals leaking into app types.
export async function execute<T = unknown>(script: string, args: unknown[] = []): Promise<T> {
  return await browser.execute(script, ...args) as T;
}
export async function executeAsync<T = unknown>(script: string): Promise<T> {
  return await browser.executeAsync(script) as T;
}
export async function waitFor(script: string, args: unknown[] = [], timeout = 12000) {
  await browser.waitUntil(async () => Boolean(await execute(script, args)), {
    timeout, interval: 100, timeoutMsg: `WebView condition not met: ${script}`,
  });
}
export async function start(file?: string) {
  // Omit browserName on reload so WDIO keeps the externally owned driver alive.
  await browser.reloadSession({ 'wdio:enforceWebDriverClassic': true, 'tauri:options': {
    application: binary, args: file ? [file] : [],
  }});
  await waitFor(file ? "return document.querySelector('#document').dataset.readyMs" :
    "return document.querySelector('#status').textContent === 'Listo para leer'");
}
export async function open(file: string) {
  await run(binary, [file], { timeout: 10000 });
  await waitFor("return document.querySelector('#filename').textContent === arguments[0]", [basename(file)]);
  await waitFor("return document.querySelector('#document').dataset.readyMs");
}
export async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'markdown-viewer-e2e-'));
  return {
    path: (name: string) => join(directory, name),
    write: async (name: string, content: string) => {
      const file = join(directory, name);
      await writeFile(file, content);
      return file;
    },
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}
export async function recordCsp(name: string) {
  await execute(`window[arguments[0]] = [];
    document.addEventListener('securitypolicyviolation', event => {
      window[arguments[0]].push({directive: event.violatedDirective, blocked: event.blockedURI});
    });`, [name]);
}
export async function screenshot(name: string) {
  await browser.saveScreenshot(join(root, 'artifacts/e2e', `${name}.png`));
}
