import assert from 'node:assert/strict';
import { beforeEach, afterEach, describe, it } from 'mocha';
import { browser } from '@wdio/globals';
import { readFile, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { example, root, binary, run, start, open, execute, executeAsync, waitFor, temporary, recordCsp, screenshot } from './helpers.js';

let files: Awaited<ReturnType<typeof temporary>>;
beforeEach(async () => { files = await temporary(); });
afterEach(async () => { await files.remove(); });

describe('Linux release WebView', () => {
  it('CLI startup: Markdown, local image and no math downloads', async () => {
    await start(example('bienvenido.md'));
    assert.equal(await execute("return document.querySelector('#document h1').textContent"), 'Leer, y ya.');
    assert.equal(await execute("return document.querySelectorAll('#document table tbody tr').length"), 3);
    assert.ok(await execute('return document.querySelector(\'#document a[href="#leer-y-ya"]\') !== null'));
    assert.ok(await execute("return [...document.querySelectorAll('#document input')].every(el => el.disabled)"));
    await execute("document.querySelector('#document img').scrollIntoView()");
    await waitFor("return document.querySelector('#document img').naturalWidth === 640");
    await execute("document.querySelector('#reader').scrollTop = 0");
    await screenshot('viewer');
    assert.ok(await execute('return document.querySelector(\'link[href*="katex"]\') === null'));
    assert.ok(await execute("return !performance.getEntriesByType('resource').some(entry => /math-runtime|katex/.test(entry.name))"));
  });

  it('second instance: Unicode uppercase extension, sanitization and unchanged file', async () => {
    const fixture = await files.write('lectura con ñ.MD', "# Otro documento\n\n- [x] Solo lectura\n\n<script>window.injected = true</script>\n\n<img src='x' onerror='window.injected = true'>");
    const before = await readFile(fixture);
    await start(example('bienvenido.md'));
    await open(fixture);
    assert.equal(await execute("return document.querySelector('#document h1').textContent"), 'Otro documento');
    assert.ok(await execute("return window.injected === undefined"));
    assert.ok(await execute("return document.querySelector('#document script') === null"));
    assert.deepEqual(await readFile(fixture), before);
    await open(example('bienvenido.md'));
    assert.equal(await execute("return document.querySelector('#document h1').textContent"), 'Leer, y ya.');
  });

  it('failed open preserves the document; Escape dismisses the error; real opener rejects file URLs', async () => {
    await start(example('bienvenido.md'));
    await run(binary, [files.path('missing.md')], { timeout: 10000 });
    await waitFor("return !document.querySelector('#error').hidden");
    assert.equal(await execute("return document.querySelector('#document h1').textContent"), 'Leer, y ya.');
    await browser.keys('Escape');
    await waitFor("return document.querySelector('#error').hidden");
    assert.ok(await executeAsync(`const done = arguments[arguments.length - 1];
      window.__TAURI__.core.invoke('open_link', {href: 'file:///etc/passwd'}).then(() => done(false), () => done(true));`));
  });

  it('text paints before two controlled image reads; late Unicode image and isolated errors', async () => {
    const deferred = await files.write('imágenes diferidas.md', '# Texto primero\n\nLectura disponible.\n\n![Café](imagen%20%C3%B1.svg)\n\n![Ausente](missing.png)\n\n![Grande](large.png)');
    await writeFile(files.path('large.png'), '');
    await truncate(files.path('large.png'), 8 * 1024 * 1024 + 1);
    // Start empty so unrelated image jobs cannot enter the controlled queue.
    await start();
    await execute(`const originalCore = window.__TAURI__.core;
      window.pendingImageReads = [];
      window.__TAURI__.core = { ...originalCore, invoke: (command, args) => {
        if (command !== 'resolve_document_image') return originalCore.invoke(command, args);
        return new Promise((resolve, reject) => window.pendingImageReads.push(() =>
          originalCore.invoke(command, args).then(resolve, reject)));
      }};
      window.releaseImageReads = () => {
        window.__TAURI__.core = originalCore;
        window.pendingImageReads.splice(0).forEach(read => read());
      };`);
    try {
      await open(deferred);
      await waitFor('return window.pendingImageReads.length === 2');
      assert.equal(await execute("return document.querySelector('#document h1').textContent"), 'Texto primero');
      assert.ok(await execute("return document.querySelector('#document').dataset.imagesResolvedMs === undefined"));
      assert.equal(await execute("return document.querySelectorAll('.local-image-placeholder').length"), 3);
      assert.ok(await execute("return document.querySelector('#document').textContent.includes('Café')"));
      await files.write('imagen ñ.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="green"/></svg>');
    } finally {
      await execute('window.releaseImageReads(); delete window.releaseImageReads;');
    }
    await waitFor("return document.querySelector('#document').dataset.imagesResolvedMs");
    await waitFor("return document.querySelector('#document img')?.naturalWidth === 32");
    assert.deepEqual(await execute("return [...document.querySelectorAll('.local-image-placeholder')].map(el => el.textContent)"), ['Ausente', 'Grande']);
    assert.ok(await execute("return document.querySelector('#error').hidden"));
  });

  it("real Highlight.js: aliases, fallback, literal HTML, CSS and CSP", async () => {
    await start(example("bienvenido.md"));
    await recordCsp("syntaxCspViolations");
    await open(example("codigo.md"));
    await waitFor("return document.querySelector('#document').dataset.syntaxReadyMs", [], 30000);
    const states = await execute("return [...document.querySelectorAll('#document pre > code')].map(el => el.dataset.syntaxState || 'plain')");
    assert.deepEqual(states, [...Array(6).fill("ready"), "plain", "plain"]);
    assert.ok(await execute("return document.querySelector('#document').dataset.readyMs"));
    assert.ok(await execute("return document.querySelectorAll('#document pre .hljs-keyword').length > 0"));
    assert.ok(await execute("return document.querySelector('#document pre script, #document pre img, #document pre [style]') === null"));
    assert.ok(await execute("return document.querySelector('#document code.language-html').textContent.includes('<script>alert(')"));
    assert.deepEqual(await execute("return window.syntaxCspViolations"), []);
    assert.ok(await execute("return getComputedStyle(document.querySelector('#document .hljs-keyword')).color !== getComputedStyle(document.querySelector('#document pre')).color"));
    await execute("document.querySelector('#reader').scrollTop = 0");
    await screenshot("codigo");
  });

  it("real KaTeX: isolated errors, MathML, fonts, CSS and CSP", async () => {
    await start(example("bienvenido.md"));
    await recordCsp("mathCspViolations");
    await open(example("latex.md"));
    await waitFor("return document.querySelector('#document').dataset.mathReadyMs", [], 30000);
    const states = await execute("return [...document.querySelectorAll('.math')].map(el => el.dataset.mathState)");
    assert.deepEqual(states, [...Array(7).fill("ready"), "error", "error", "ready"]);
    assert.deepEqual(await execute("return document.querySelectorAll('.math math annotation[encoding=\"application/x-tex\"]').length"), 8);
    assert.ok(await execute("return document.querySelector('.math script, .math img, .math a, .math foreignObject') === null"));
    assert.ok(await execute("return [...document.querySelectorAll('.math .katex')].every(el => el.getBoundingClientRect().width > 0)"));
    assert.ok(await execute("return [...document.querySelectorAll('.math .frac-line')].every(el => parseFloat(getComputedStyle(el).borderBottomWidth) > 0)"));
    assert.ok(await executeAsync("\n            const done = arguments[arguments.length - 1];\n            document.fonts.ready.then(() => done(document.fonts.check('16px KaTeX_Main')));\n        "));
    assert.ok(await execute("return [...document.fonts].some(font => font.family === 'KaTeX_Main' && font.status === 'loaded')"));
    assert.deepEqual(await execute("return document.querySelectorAll('link[href*=\"katex\"]').length"), 1);
    assert.deepEqual(await execute("return window.mathCspViolations"), []);
    assert.deepEqual(await execute("return document.querySelector('#document code').textContent"), "$x^2$");
    await execute("document.querySelector('#reader').scrollTop = 0");
    await screenshot("latex");
  });

  it("real Mermaid: five types, isolated errors, sanitized SVG, nonce and CSP", async () => {
    await start(example("bienvenido.md"));
    await recordCsp("mermaidCspViolations");
    await open(example("mermaid.md"));
    await waitFor("return document.querySelector('#document').dataset.diagramsReadyMs", [], 30000);
    const states = await execute("return [...document.querySelectorAll('.mermaid-diagram')].map(el => ({state: el.dataset.state, message: el.querySelector('.mermaid-message').textContent}))");
    assert.deepEqual((states as {state: string}[]).map(state => state.state), [...Array(5).fill("ready"), "error", "error"]);
    assert.deepEqual(await execute("return document.querySelectorAll('.mermaid-svg svg').length"), 5);
    assert.ok(await execute("return document.querySelector('.mermaid-render-host') === null"));
    assert.ok(await execute("return document.querySelector('.mermaid-svg foreignObject, .mermaid-svg script, .mermaid-svg image, .mermaid-svg [style]') === null"));
    assert.ok(await execute("return [...document.querySelectorAll('.mermaid-svg svg')].every(svg => svg.getBoundingClientRect().width > 0 && svg.querySelector('title'))"));
    assert.ok(await execute("return [...document.querySelectorAll('.mermaid-svg style')].every(style => style.nonce === document.querySelector('#mermaid-style-nonce').nonce && style.sheet !== null)"));
    const violations = await execute("return window.mermaidCspViolations");
    assert.deepEqual(violations, []);
    await execute("document.querySelector('.mermaid-diagram').scrollIntoView()");
    await screenshot("mermaid");
  });

  for (const name of ['arquitectura.md', 'interfaz.md', 'coordinacion-rust.md', 'procesamiento-documento.md', 'mermaid.md']) {
    it(`project documentation diagrams: ${name}`, async () => {
      await start();
      await open(join(root, 'docs', name));
      await waitFor("return document.querySelector('#document').dataset.diagramsReadyMs", [], 30000);
      assert.ok(await execute("return [...document.querySelectorAll('.mermaid-diagram')].every(el => el.dataset.state === 'ready')"));
    });
  }

  it('starts empty and opens a file through the native picker', async () => {
    await start();
    assert.ok(await execute("return document.querySelector('#document').hidden"));
    await (await browser.$('#empty-open')).click();
    let window = '';
    await browser.waitUntil(async () => {
      try {
        const { stdout } = await run('xdotool', ['search', '--onlyvisible', '--name', '^Abrir Markdown$'], { timeout: 2000 });
        window = stdout.trim().split(/\s+/).at(-1) || '';
        return Boolean(window);
      } catch { return false; }
    }, { timeout: 12000, interval: 100, timeoutMsg: 'Native Markdown picker did not appear' });
    await run('xdotool', ['windowfocus', '--sync', window], { timeout: 3000 });
    // Input pacing belongs to xdotool; completion is observed in the real WebView.
    await run('xdotool', ['key', '--delay', '200', 'ctrl+l'], { timeout: 3000 });
    await run('xdotool', ['type', '--clearmodifiers', '--delay', '1', example('bienvenido.md')], { timeout: 5000 });
    await run('xdotool', ['key', '--delay', '300', 'Return', 'Return'], { timeout: 3000 });
    await waitFor("return document.querySelector('#filename').textContent === 'bienvenido.md'");
    assert.ok(await execute("return !document.querySelector('#open').disabled"));
  });
});
