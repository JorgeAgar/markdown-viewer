import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { CodeRenderer } from '../src/syntax';

const controllerScript = readFileSync(new URL('../artifacts/test-syntax.js', import.meta.url), 'utf8');
const runtimeScript = readFileSync(new URL('../artifacts/test-syntax-runtime.js', import.meta.url), 'utf8');
async function settle() { await new Promise<void>(resolve => setImmediate(resolve)); }

test('the production module graph keeps Highlight.js and grammars outside the initial load', async () => {
  const { metafile } = await build({
    absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
    entryPoints: ['src/app.ts'], outdir: 'artifacts/syntax-loading-check',
    bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2020',
    write: false, metafile: true,
    // Unrelated renderers do not affect the syntax module's loading contract.
    external: ['./mermaid-runtime', './math-runtime'],
  });
  const entry = Object.entries(metafile.outputs).find(([, output]) => output.entryPoint === 'src/app.ts');
  assert.ok(entry);
  const initial = new Set<string>();
  function visit(path: string) {
    if (initial.has(path)) return;
    initial.add(path);
    for (const dependency of metafile.outputs[path]!.imports) {
      if (!dependency.external && dependency.kind !== 'dynamic-import') visit(dependency.path);
    }
  }
  visit(entry[0]);
  const initialSources = [...initial].flatMap(path => Object.keys(metafile.outputs[path]!.inputs));
  assert.ok(initialSources.includes('src/syntax.ts'));
  assert.ok(Object.keys(metafile.inputs).some(path => path.includes('highlight.js/')));
  assert.equal(initialSources.some(path => /highlight\.js\/|syntax-runtime/.test(path)), false);
});

function create(t: TestContext, loader?: () => Promise<CodeRenderer>, pause: () => Promise<void> = () => Promise.resolve()) {
  const dom = new JSDOM('<!doctype html><main><article></article></main>', { runScripts: 'outside-only' });
  const { window } = dom;
  const root = window.document.querySelector('article')!;
  window.eval(`${controllerScript}\nwindow.SyntaxTest = SyntaxTest;`);
  window.eval(`${runtimeScript}\nwindow.SyntaxRuntimeTest = SyntaxRuntimeTest;`);
  const modules = window as unknown as { SyntaxTest: typeof import('../src/syntax'); SyntaxRuntimeTest: typeof import('../src/syntax-runtime') };
  const calls: { source: string; language: string }[] = [];
  let loads = 0;
  const controller = new modules.SyntaxTest.SyntaxController(root, async () => {
    loads++;
    return loader ? loader() : (source, language) => { calls.push({ source, language }); return `<span class="hljs-keyword">${source}</span>`; };
  }, pause);
  function document(sources: string[], language = 'js') {
    root.replaceChildren(...sources.map(source => {
      const pre = window.document.createElement('pre');
      const code = window.document.createElement('code');
      code.className = `language-${language}`;
      code.textContent = source;
      pre.append(code);
      return pre;
    }));
    return controller.prepare();
  }
  t.after(() => { controller.dispose(); window.close(); });
  return { window, root, modules, controller, document, calls, get loads() { return loads; } };
}

test('highlighting waits for paint, skips plain documents and reuses the runtime', async t => {
  const viewer = create(t);
  viewer.document([])();
  const paint = viewer.document(['const x = 1']);
  await settle();
  assert.equal(viewer.loads, 0);
  assert.equal(viewer.root.querySelector('span'), null);
  paint();
  paint();
  await settle();
  assert.equal(viewer.loads, 1);
  assert.deepEqual(viewer.calls, [{ source: 'const x = 1', language: 'javascript' }]);
  assert.equal(viewer.root.querySelector('code')!.dataset.syntaxState, 'ready');
  assert.ok(viewer.root.dataset.syntaxReadyMs);
  viewer.document(['let x = 2'], 'ts')();
  await settle();
  assert.equal(viewer.loads, 1);
  assert.equal(viewer.calls[1]!.language, 'typescript');
});

test('inline code, Mermaid, unknown languages, plaintext and prototype keys do not load the runtime', async t => {
  const viewer = create(t);
  viewer.root.innerHTML = '<code class="language-js">inline</code><pre><code>unlabelled</code></pre><pre><code class="language-mermaid">graph LR</code></pre><figure class="mermaid-diagram"><pre><code class="language-js">literal</code></pre></figure>';
  viewer.controller.prepare()();
  for (const language of ['unknown', 'text', 'plaintext', 'constructor', '__proto__']) viewer.document(['plain'], language)();
  await settle();
  assert.equal(viewer.loads, 0);
  assert.equal(viewer.root.textContent, 'plain');
});

test('stale paint, imports, output and disposal cannot update the current document', async t => {
  const imported = Promise.withResolvers<CodeRenderer>();
  const pending = Promise.withResolvers<string>();
  const viewer = create(t, () => imported.promise);
  const oldPaint = viewer.document(['old']);
  viewer.document([])();
  oldPaint();
  assert.equal(viewer.loads, 0);
  viewer.document(['waiting'])();
  await settle();
  viewer.document(['current'])();
  imported.resolve(source => source === 'current' ? '<span>current</span>' : pending.promise);
  await settle();
  assert.equal(viewer.root.innerHTML, '<pre><code class="language-js" data-syntax-state="ready"><span>current</span></code></pre>');
  viewer.document(['waiting'])();
  await settle();
  viewer.document(['replacement'])();
  await settle();
  viewer.controller.dispose();
  pending.resolve('<span>stale</span>');
  await settle();
  assert.equal(viewer.root.textContent, 'replacement');
  assert.equal(viewer.root.dataset.syntaxReadyMs, undefined);
});

test('a new document does not wait for an old pending render', async t => {
  const pending = Promise.withResolvers<string>();
  const viewer = create(t, async () => source => source === 'old' ? pending.promise : '<span>new</span>');
  viewer.document(['old'])();
  await settle();
  viewer.document(['new'])();
  await settle();
  const timing = viewer.root.dataset.syntaxReadyMs;
  assert.equal(viewer.root.textContent, 'new');
  assert.ok(timing);
  pending.resolve('stale');
  await settle();
  assert.equal(viewer.root.textContent, 'new');
  assert.equal(viewer.root.dataset.syntaxReadyMs, timing);
});

test('import failures keep literal code and retry with the next document', async t => {
  let attempts = 0;
  const viewer = create(t, async () => {
    if (++attempts === 1) throw new Error('Missing local chunk');
    return () => '<span>retry</span>';
  });
  viewer.document(['<script>literal</script>'])();
  await settle();
  assert.equal(viewer.root.textContent, '<script>literal</script>');
  assert.equal(viewer.root.querySelector('script'), null);
  assert.equal(viewer.root.querySelector('code')!.dataset.syntaxState, 'error');
  viewer.document(['retry'])();
  await settle();
  assert.equal(viewer.loads, 2);
  assert.equal(viewer.root.querySelector('code')!.dataset.syntaxState, 'ready');
});

test('one failed block keeps its source and does not stop later blocks', async t => {
  const viewer = create(t, async () => source => {
    if (source.startsWith('<')) throw new Error('Bad grammar');
    return '<span>good</span>';
  });
  viewer.document(['<img src=x onerror=alert(1)>', 'good'])();
  await settle();
  assert.equal(viewer.root.querySelector('code')!.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(viewer.root.querySelector('img'), null);
  assert.equal(viewer.root.querySelectorAll('[data-syntax-state="ready"]').length, 1);
});

test('limits preserve oversized and excess code without importing for rejected documents', async t => {
  const viewer = create(t);
  viewer.document(['x'.repeat(50_001)])();
  await settle();
  assert.equal(viewer.loads, 0);
  assert.equal(viewer.root.textContent!.length, 50_001);
  viewer.document(Array.from({ length: 201 }, () => 'x'))();
  await settle();
  assert.equal(viewer.calls.length, 200);
  assert.equal(viewer.root.querySelectorAll('[data-syntax-state="skipped"]').length, 1);
  viewer.document(Array.from({ length: 11 }, () => 'x'.repeat(50_000)))();
  await settle();
  assert.equal(viewer.root.querySelectorAll('[data-syntax-state="ready"]').length, 10);
  assert.equal(viewer.root.querySelectorAll('[data-syntax-state="skipped"]').length, 1);
});

test('visible blocks have priority and batches yield and cancel', async t => {
  const paused = Promise.withResolvers<void>();
  const viewer = create(t, undefined, () => paused.promise);
  const paint = viewer.document(Array.from({ length: 8 }, (_, index) => `${index}`));
  viewer.root.querySelector('code')!.getBoundingClientRect = () => ({ top: 10000, bottom: 10030 }) as DOMRect;
  paint();
  await settle();
  assert.equal(viewer.calls[0]!.source, '1');
  assert.equal(viewer.calls.length, 4);
  viewer.document([])();
  paused.resolve();
  await settle();
  assert.equal(viewer.calls.length, 4);
  assert.equal(viewer.root.dataset.syntaxReadyMs, undefined);
});

test('every allowed alias reaches a real grammar and its code class survives Rust sanitation', async t => {
  const viewer = create(t, async () => viewer.modules.SyntaxRuntimeTest.render);
  const source = readFileSync(new URL('../src/syntax-languages.ts', import.meta.url), 'utf8');
  const aliases = [...source.matchAll(/(\w+|'c\+\+'):\s*'([^']+)'/g)].map(match => [match[1]!.replaceAll("'", ''), match[2]!] as const);
  assert.ok(aliases.length > 30);
  const rust = readFileSync(new URL('../src-tauri/src/document.rs', import.meta.url), 'utf8').split('pub fn load')[0]!;
  const allowed = [...rust.matchAll(/"language-([^"\s]+)"/g)].map(match => match[1]!);
  assert.deepEqual(allowed.sort(), [...aliases.map(([alias]) => alias), 'mermaid'].sort());
  for (const [alias, language] of aliases) {
    viewer.document(['const value = 42; # comment'], alias)();
    await settle();
    assert.equal(viewer.root.querySelector('code')!.dataset.syntaxState, 'ready', `${alias} → ${language}`);
    assert.equal(viewer.root.textContent, 'const value = 42; # comment');
  }
});

test('real highlighting preserves Unicode and active HTML as text, emitting only classed spans', async t => {
  const { modules, window } = create(t);
  for (const language of ['javascript', 'xml', 'python', 'rust', 'json']) {
    const source = '<img src="x" onerror="alert(1)">\n<script>alert("Café 🦀 & < >")</script>\nconst value = 42;\n';
    const code = window.document.createElement('code');
    code.innerHTML = await modules.SyntaxRuntimeTest.render(source, language);
    assert.equal(code.textContent, source);
    assert.ok(code.querySelector('span'));
    for (const node of code.querySelectorAll('*')) {
      assert.equal(node.tagName, 'SPAN');
      assert.deepEqual([...node.attributes].map(attr => attr.name), ['class']);
    }
  }
  await assert.rejects(async () => modules.SyntaxRuntimeTest.render('x', 'constructor'), /no admitido/);
});
