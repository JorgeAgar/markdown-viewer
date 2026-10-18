import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { MathRenderer } from '../src/math';

const controllerScript = readFileSync(new URL('../artifacts/test-math.js', import.meta.url), 'utf8');
const runtimeScript = readFileSync(new URL('../artifacts/test-math-runtime.js', import.meta.url), 'utf8');

async function settle() { await new Promise<void>(resolve => setImmediate(resolve)); }

function create(t: TestContext, loader?: () => Promise<MathRenderer>, pause: () => Promise<void> = () => Promise.resolve()) {
  const dom = new JSDOM('<!doctype html><head></head><body><main><article></article></main></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const { window } = dom;
  const root = window.document.querySelector('article')!;
  window.eval(`${controllerScript}\nwindow.MathTest = MathTest;`);
  window.eval(`${runtimeScript}\nwindow.MathRuntimeTest = MathRuntimeTest;`);
  const modules = window as unknown as { MathTest: typeof import('../src/math'); MathRuntimeTest: typeof import('../src/math-runtime') };
  const calls: { source: string; display: boolean }[] = [];
  let loads = 0;
  function result(source: string): HTMLElement {
    const node = window.document.createElement('span');
    node.textContent = `rendered: ${source}`;
    return node;
  }
  const controller = new modules.MathTest.MathController(root, async () => {
    loads++;
    return loader ? loader() : (source, display) => { calls.push({ source, display }); return result(source); };
  }, pause);
  function document(sources: string[]) {
    root.replaceChildren(...sources.map((source, index) => {
      const node = window.document.createElement('span');
      node.className = `math ${index % 2 ? 'math-display' : 'math-inline'}`;
      node.textContent = source;
      return node;
    }));
    return controller.prepare();
  }
  t.after(() => { controller.dispose(); window.close(); });
  return { window, root, modules, controller, document, calls, result, get loads() { return loads; } };
}

test('plain documents never load math, formulas wait for paint and share one import', async t => {
  const viewer = create(t);
  viewer.document([])();
  await settle();
  assert.equal(viewer.loads, 0);
  const paint = viewer.document(['x^2', '\\frac{1}{2}']);
  await settle();
  assert.equal(viewer.loads, 0);
  assert.match(viewer.root.textContent!, /x\^2/);
  paint();
  paint();
  await settle();
  assert.equal(viewer.loads, 1);
  assert.deepEqual(viewer.calls, [{ source: 'x^2', display: false }, { source: '\\frac{1}{2}', display: true }]);
  assert.equal(viewer.root.querySelectorAll('[data-math-state="ready"]').length, 2);
  assert.ok(viewer.root.dataset.mathReadyMs);
});

test('a formula error preserves escaped source while subsequent formulas render', async t => {
  let viewer: ReturnType<typeof create>;
  viewer = create(t, async () => source => {
    if (source.includes('bad')) throw new Error('<script>bad</script>');
    return viewer.result(source);
  });
  viewer.document(['<script>bad</script>', 'x'])();
  await settle();
  const first = viewer.root.firstElementChild as HTMLElement;
  assert.equal(first.textContent, '<script>bad</script>');
  assert.equal(first.dataset.mathState, 'error');
  assert.equal(viewer.root.querySelector('script'), null);
  assert.equal((viewer.root.lastElementChild as HTMLElement).dataset.mathState, 'ready');
});

test('replacement documents do not wait for old renders and ignore their late output', async t => {
  const old = Promise.withResolvers<HTMLElement>();
  let viewer: ReturnType<typeof create>;
  viewer = create(t, async () => source => source === 'old' ? old.promise : viewer.result(source));
  viewer.document(['old', 'skip'])();
  await settle();
  viewer.document(['new'])();
  await settle();
  assert.equal(viewer.root.textContent, 'rendered: new');
  const timing = viewer.root.dataset.mathReadyMs;
  old.resolve(viewer.result('stale'));
  await settle();
  assert.equal(viewer.root.textContent, 'rendered: new');
  assert.equal(viewer.root.dataset.mathReadyMs, timing);
});

test('stale imports, paint callbacks and disposed controllers cannot render', async t => {
  const imported = Promise.withResolvers<MathRenderer>();
  const viewer = create(t, () => imported.promise);
  const oldPaint = viewer.document(['old']);
  viewer.document([])();
  oldPaint();
  assert.equal(viewer.loads, 0);
  viewer.document(['pending'])();
  await settle();
  viewer.controller.dispose();
  let renders = 0;
  imported.resolve(() => { renders++; return viewer.result('stale'); });
  await settle();
  assert.equal(renders, 0);
  assert.equal(viewer.root.dataset.mathReadyMs, undefined);
});

test('failed imports preserve source and retry when another document opens', async t => {
  let attempts = 0;
  let viewer: ReturnType<typeof create>;
  viewer = create(t, async () => {
    if (++attempts === 1) throw new Error('Missing local chunk');
    return source => viewer.result(source);
  });
  viewer.document(['first'])();
  await settle();
  assert.equal(viewer.root.textContent, 'first');
  assert.equal((viewer.root.firstElementChild as HTMLElement).dataset.mathState, 'error');
  viewer.document(['second'])();
  await settle();
  assert.equal(viewer.loads, 2);
  assert.equal(viewer.root.textContent, 'rendered: second');
});

test('limits reject large sources before import and preserve excess formulas', async t => {
  const viewer = create(t);
  viewer.document(['x'.repeat(10_001)])();
  await settle();
  assert.equal(viewer.loads, 0);
  viewer.document(Array.from({ length: 501 }, () => 'x'))();
  await settle();
  assert.equal(viewer.calls.length, 500);
  assert.equal(viewer.root.querySelectorAll('[data-math-state="error"]').length, 1);
  assert.equal(viewer.root.lastElementChild!.textContent, 'x');
});

test('visible formulas get priority and batches yield before continuing', async t => {
  const paused = Promise.withResolvers<void>();
  const viewer = create(t, undefined, () => paused.promise);
  const paint = viewer.document(Array.from({ length: 12 }, (_, index) => `${index}`));
  const first = viewer.root.firstElementChild!;
  first.getBoundingClientRect = () => ({ top: 10000, bottom: 10030 }) as DOMRect;
  paint();
  await settle();
  assert.equal(viewer.calls[0]!.source, '1');
  assert.equal(viewer.calls.length, 8);
  viewer.document([])();
  paused.resolve();
  await settle();
  assert.equal(viewer.calls.length, 8);
  assert.equal(viewer.root.dataset.mathReadyMs, undefined);
});

test('markers inside code or Mermaid stay literal', async t => {
  const viewer = create(t);
  viewer.root.innerHTML = '<pre><code><span class="math math-inline">x</span></code></pre><figure class="mermaid-diagram"><span class="math math-display">y</span></figure>';
  viewer.controller.prepare()();
  await settle();
  assert.equal(viewer.loads, 0);
  assert.equal(viewer.root.textContent, 'xy');
});

test('real KaTeX renders fractions, matrices, aligned equations, colors and accessible source', t => {
  const { modules } = create(t);
  for (const source of ['\\frac{1}{2}', '\\sqrt{x^2+1}', '\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}', '\\begin{aligned}a&=b\\\\c&=d\\end{aligned}', '\\color{red}{x}', '\\text{Café}']) {
    const node = modules.MathRuntimeTest.render(source, true);
    assert.ok(node.querySelector('.katex-display .katex-html'));
    assert.ok(node.querySelector('math'));
    assert.equal(node.querySelector('annotation[encoding="application/x-tex"]')?.textContent, source);
    assert.equal(node.querySelector('a,img,script,style,foreignObject'), null);
  }
});

test('real renderer rejects unsupported commands and macro loops; definitions cannot leak', t => {
  const { render } = create(t).modules.MathRuntimeTest;
  for (const source of ['\\notACommand{x}', '\\def\\loop{\\loop}\\loop', '\\htmlStyle{position:fixed}{x}']) {
    assert.throws(() => render(source, false), source);
  }
  for (const source of ['\\href{javascript:alert(1)}{x}', '\\includegraphics{https://example.com/x}']) {
    const output = render(source, false);
    assert.equal(output.querySelector('a,img,[href],[src]'), null);
  }
  render('\\gdef\\secret{42}\\secret', false);
  assert.throws(() => render('\\secret', false));
});

test('KaTeX creates styles through CSSOM, including MathML color boxes and all border sides', t => {
  const viewer = create(t);
  const original = viewer.window.Element.prototype.setAttribute;
  viewer.window.Element.prototype.setAttribute = function(name, value) {
    assert.notEqual(name.toLowerCase(), 'style', 'A style attribute would violate the real CSP');
    original.call(this, name, value);
  };
  const node = viewer.modules.MathRuntimeTest.render('\\fcolorbox{red}{blue}{x}', false);
  const mathBox = node.querySelector<MathMLElement>('math mpadded')!;
  assert.ok(mathBox);
  // jsdom lacks MathMLElement.style; the native smoke checks the actual CSP.
  assert.equal(mathBox.getAttribute('style'), null);
  const htmlBox = node.querySelector<HTMLElement>('.katex-html .fcolorbox')!;
  assert.equal(htmlBox.style.borderLeftColor, 'red');
  assert.equal(htmlBox.style.borderLeftStyle, 'solid');
});

test('math sanitizer strips active content, remote resources and unsafe styles', t => {
  const viewer = create(t);
  const host = viewer.window.document.createElement('span');
  host.innerHTML = '<span id="stolen" onclick="alert(1)" style="color:red;position:fixed;background-image:url(https://example.com/x);height:2em">safe</span><a href="https://example.com">link</a><img src="https://example.com/x"><svg><image href="https://example.com/x"/><script>alert(1)</script></svg><style>body{display:none}</style><math><annotation-xml encoding="text/html"><img src="x"></annotation-xml></math>';
  viewer.modules.MathRuntimeTest.sanitizeMath(host);
  assert.equal(host.querySelector('a,img,image,script,style,annotation-xml,[onclick],[id]'), null);
  const span = host.querySelector('span')!;
  assert.equal(span.style.color, 'red');
  assert.equal(span.style.height, '2em');
  assert.equal(span.style.position, '');
  assert.equal(span.style.backgroundImage, '');
});

test('stylesheet loads once on demand, retries failures, and all WOFF2 fonts are bundled', async t => {
  const viewer = create(t);
  const { loadStyles } = viewer.modules.MathRuntimeTest;
  assert.equal(viewer.window.document.querySelector('link'), null);
  const failed = loadStyles();
  assert.equal(loadStyles(), failed);
  viewer.window.document.querySelector('link')!.dispatchEvent(new viewer.window.Event('error'));
  await assert.rejects(failed, /estilos/);
  assert.equal(viewer.window.document.querySelector('link'), null);
  const loaded = loadStyles();
  const link = viewer.window.document.querySelector('link')!;
  assert.equal(link.href, 'http://localhost/katex/katex.min.css');
  link.dispatchEvent(new viewer.window.Event('load'));
  await loaded;
  assert.equal(loadStyles(), loaded);
  const css = readFileSync(new URL('../dist/katex/katex.min.css', import.meta.url), 'utf8');
  const fonts = [...css.matchAll(/url\(([^)]+\.woff2)\)/g)];
  assert.ok(fonts.length > 10);
  for (const match of fonts) assert.ok(existsSync(new URL(`../dist/katex/${match[1]}`, import.meta.url)), match[1]);
});
