import type { Options, Capabilities } from '@wdio/types';
import { browser } from '@wdio/globals';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { binary, root } from './e2e/helpers.js';

export const config: Options.Testrunner & Capabilities.WithRequestedTestrunnerCapabilities = {
  runner: 'local',
  hostname: '127.0.0.1', port: 4844, path: '/',
  specs: ['./e2e/**/*.e2e.ts'],
  maxInstances: 1,
  capabilities: [{ browserName: 'wry', 'wdio:enforceWebDriverClassic': true, 'tauri:options': { application: binary } }],
  services: [],
  framework: 'mocha', reporters: ['spec'],
  injectGlobals: false,
  logLevel: 'info', outputDir: './artifacts/e2e',
  connectionRetryCount: 0, connectionRetryTimeout: 30000,
  specFileRetries: 0,
  mochaOpts: { timeout: 90000, retries: 0 },
  afterCommand: async function (command, args, _result, error) {
    await appendFile(join(root, 'artifacts/e2e/commands.jsonl'), JSON.stringify({
      time: new Date().toISOString(), session: browser.sessionId, command, args,
      error: error ? String(error) : undefined,
    }) + '\n');
  },
  afterTest: async function (test, _context, { passed, error }) {
    if (passed) return;
    const directory = join(root, 'artifacts/e2e');
    await mkdir(directory, { recursive: true });
    const name = test.title.replace(/[^a-z0-9]+/gi, '-');
    await writeFile(join(directory, `${name}-failure.txt`), String(error?.stack || error));
    // Each diagnostic is independent: a crashed WebView should not hide the failure.
    await Promise.allSettled([
      browser.saveScreenshot(join(directory, `${name}.png`)),
      browser.getPageSource().then(source => writeFile(join(directory, `${name}.html`), source)),
      browser.execute(() => ({
        title: document.title,
        csp: Object.fromEntries(['syntaxCspViolations', 'mathCspViolations', 'mermaidCspViolations'].map(name =>
          [name, (window as unknown as Record<string, unknown>)[name]])),
        pendingImageReads: ((window as unknown as Record<string, unknown[]>).pendingImageReads || []).length,
        filename: document.querySelector('#filename')?.textContent,
        error: document.querySelector('#error')?.textContent,
        timings: (document.querySelector('#document') as HTMLElement | null)?.dataset,
        resources: performance.getEntriesByType('resource').map(entry => entry.name),
        renderers: [...document.querySelectorAll('.math, .mermaid-diagram, pre > code')].map(el => ({
          text: el.textContent, state: (el as HTMLElement).dataset,
        })),
      })).then(state => writeFile(join(directory, `${name}.json`), JSON.stringify(state, null, 2))),
    ]);
  },
};
