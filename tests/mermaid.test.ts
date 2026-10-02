import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { DiagramRenderer } from '../src/mermaid';

const controllerScript = readFileSync(new URL('../artifacts/test-mermaid.js', import.meta.url), 'utf8');
const svgScript = readFileSync(new URL('../artifacts/test-svg.js', import.meta.url), 'utf8');
const namespace = 'http://www.w3.org/2000/svg';

async function settle() { await new Promise<void>(resolve => setImmediate(resolve)); }

function create(t: TestContext, load?: () => Promise<DiagramRenderer>) {
  const dom = new JSDOM('<!doctype html><head><style id="mermaid-style-nonce" nonce="trusted-test"></style></head><body><article></article></body>', { runScripts: 'outside-only' });
  const { window } = dom;
  const root = window.document.querySelector('article')!;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  window.matchMedia = () => ({ matches: false, addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener), removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener) }) as unknown as MediaQueryList;
  window.eval(`${controllerScript}\nwindow.MermaidTest = MermaidTest;`);
  window.eval(`${svgScript}\nwindow.SvgTest = SvgTest;`);
  const modules = window as unknown as { MermaidTest: typeof import('../src/mermaid'); SvgTest: typeof import('../src/diagram-svg') };
  const calls: { source: string; theme: string }[] = [];
  let loads = 0;
  function svg(source: string): SVGSVGElement {
    const result = window.document.createElementNS(namespace, 'svg');
    result.setAttribute('data-source', source);
    return result;
  }
  const controller = new modules.MermaidTest.MermaidController(root, async () => {
    loads++;
    if (load) return load();
    return async (source, theme) => { calls.push({ source, theme }); return svg(source); };
  }, () => Promise.resolve());
  t.after(() => { controller.dispose(); dom.window.close(); });
  function document(sources: string[]) {
    root.replaceChildren();
    for (const source of sources) {
      const pre = window.document.createElement('pre');
      const code = window.document.createElement('code');
      code.className = 'language-mermaid';
      code.textContent = source;
      pre.append(code);
      root.append(pre);
    }
    return controller.prepare();
  }
  function theme(dark: boolean) { listeners.forEach(listener => listener({ matches: dark } as MediaQueryListEvent)); }
  return { window, root, modules, controller, document, theme, calls, svg, get loads() { return loads; } };
}

test('plain documents and preparing blocks do not import Mermaid before paint', async t => {
  const viewer = create(t);
  viewer.document([])();
  await settle();
  assert.equal(viewer.loads, 0);
  const paint = viewer.document(['flowchart LR\nA-->B']);
  await settle();
  assert.equal(viewer.loads, 0);
  assert.equal(viewer.root.querySelector('code')?.textContent, 'flowchart LR\nA-->B');
  paint();
  await settle();
  assert.equal(viewer.loads, 1);
  assert.equal(viewer.root.querySelector('figure')?.dataset.state, 'ready');
  assert.equal(viewer.root.querySelector('details')?.open, false);
});

test('several blocks share one import and retain their original source', async t => {
  const viewer = create(t);
  const sources = ['flowchart LR\nA-->B', 'sequenceDiagram\nA->>B: Café'];
  viewer.document(sources)();
  await settle();
  assert.equal(viewer.loads, 1);
  assert.deepEqual(viewer.calls.map(call => call.source), sources);
  assert.deepEqual([...viewer.root.querySelectorAll('code')].map(code => code.textContent), sources);
  assert.equal(viewer.root.querySelectorAll('svg').length, 2);
  assert.ok(viewer.root.dataset.diagramsReadyMs);
});

test('a theme change before text paint waits and uses the latest theme', async t => {
  const viewer = create(t);
  const paint = viewer.document(['flowchart LR\nA-->B']);
  viewer.theme(true);
  await settle();
  assert.equal(viewer.loads, 0);
  paint();
  await settle();
  assert.equal(viewer.calls[0]?.theme, 'dark');
  assert.equal(viewer.root.querySelector('figure')?.dataset.state, 'ready');
});

test('one parser error leaves code visible and does not stop the next diagram', async t => {
  let viewer: ReturnType<typeof create>;
  viewer = create(t, async () => async source => {
    if (source.includes('broken')) throw new Error('<script>broken</script>');
    return viewer.svg(source);
  });
  viewer.document(['flowchart LR\nbroken', 'flowchart LR\nA-->B'])();
  await settle();
  const figures = viewer.root.querySelectorAll('figure');
  assert.equal(figures[0]?.dataset.state, 'error');
  assert.equal(figures[0]?.querySelector('details')?.open, true);
  assert.equal(figures[0]?.querySelector('script'), null);
  assert.equal(figures[1]?.dataset.state, 'ready');
});

test('document B wins when the SVG of A finishes late', async t => {
  const old = Promise.withResolvers<SVGSVGElement>();
  let viewer: ReturnType<typeof create>;
  const started: string[] = [];
  viewer = create(t, async () => async source => {
    started.push(source);
    return source.includes('Old') ? old.promise : viewer.svg(source);
  });
  viewer.document(['flowchart LR\nOld-->A', 'flowchart LR\nSkipped-->A'])();
  await settle();
  const newSource = 'flowchart LR\nNew-->B';
  viewer.document([newSource])();
  old.resolve(viewer.svg('Old'));
  await settle();
  assert.equal(viewer.root.querySelector('svg')?.getAttribute('data-source'), newSource);
  assert.deepEqual(started, ['flowchart LR\nOld-->A', newSource]);
});

test('a stale import cannot render or update a replacement document', async t => {
  const imported = Promise.withResolvers<DiagramRenderer>();
  const viewer = create(t, () => imported.promise);
  viewer.document(['flowchart LR\nA-->B'])();
  await settle();
  viewer.document([])();
  const calls: string[] = [];
  imported.resolve(async source => { calls.push(source); return viewer.svg(source); });
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(viewer.root.dataset.diagramsReadyMs, undefined);
});

test('theme changes serialize with the old render and preserve open code/focus', async t => {
  const first = Promise.withResolvers<SVGSVGElement>();
  let viewer: ReturnType<typeof create>;
  const themes: string[] = [];
  viewer = create(t, async () => async (source, theme) => {
    themes.push(theme);
    return theme === 'light' ? first.promise : viewer.svg(source);
  });
  viewer.document(['flowchart LR\nA-->B'])();
  await settle();
  const details = viewer.root.querySelector('details')!;
  const summary = details.querySelector('summary')!;
  summary.focus();
  viewer.theme(true);
  first.resolve(viewer.svg('stale light'));
  await settle();
  assert.deepEqual(themes, ['light', 'dark']);
  assert.equal(details.open, true);
  assert.equal(viewer.window.document.activeElement, summary);
  assert.equal(viewer.root.querySelector('figure')?.dataset.state, 'ready');
});

test('a failed import can be retried for a later document', async t => {
  let attempt = 0;
  let viewer: ReturnType<typeof create>;
  viewer = create(t, async () => {
    if (++attempt === 1) throw new Error('Cannot load local chunk');
    return async source => viewer.svg(source);
  });
  viewer.document(['flowchart LR\nA-->B'])();
  await settle();
  assert.equal(viewer.root.querySelector('figure')?.dataset.state, 'error');
  viewer.document(['flowchart LR\nC-->D'])();
  await settle();
  assert.equal(viewer.loads, 2);
  assert.equal(viewer.root.querySelector('figure')?.dataset.state, 'ready');
});

test('oversized/configured/unsupported blocks fail before loading the renderer', async t => {
  const viewer = create(t);
  viewer.document([
    `flowchart LR\n${'x'.repeat(50_000)}`,
    '---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\nA-->B',
    '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B',
    'gantt\n title Unsupported',
    'flowchart LR\nclassDef unsafe fill:url(https://example.com/x)',
    'flowchart LR\nA@{img: "https://example.com/x"}',
  ])();
  await settle();
  assert.equal(viewer.loads, 0);
  assert.equal(viewer.root.querySelectorAll('figure[data-state="error"]').length, 6);
});

test('the 51st block keeps its code while the first 50 render', async t => {
  const viewer = create(t);
  viewer.document(Array.from({ length: 51 }, (_, index) => `flowchart LR\nA${index}-->B`))();
  await settle();
  assert.equal(viewer.calls.length, 50);
  const last = viewer.root.querySelectorAll('figure')[50]!;
  assert.equal(last.dataset.state, 'error');
  assert.equal(last.querySelector('details')?.open, true);
  assert.match(last.textContent!, /primeros 50/);
});

test('disposed controllers ignore late results and stop observing the theme', async t => {
  const pending = Promise.withResolvers<SVGSVGElement>();
  const viewer = create(t, async () => () => pending.promise);
  viewer.document(['flowchart LR\nA-->B'])();
  await settle();
  viewer.controller.dispose();
  pending.resolve(viewer.svg('stale'));
  viewer.theme(true);
  await settle();
  assert.equal(viewer.root.querySelector('svg'), null);
});

test('SVG sanitation removes active content/resources and namespaces local references', t => {
  const viewer = create(t);
  const svg = viewer.modules.SvgTest.sanitizeDiagramSvg(`<svg id="mermaid-diagram-1" xmlns="${namespace}" viewBox="0 0 300 120" onload="alert(1)">
    <style>#mermaid-diagram-1 .node {fill:red;stroke:url(#arrow)} body {display:none} @import url(https://example.com/a.css);</style>
    <defs><marker id="arrow"><path d="M0 0L5 5" /></marker></defs>
    <a href="javascript:alert(1)"><text id="label" style="fill:blue;position:fixed" x="10">Café</text></a>
    <path marker-end="url(#arrow)"/><image href="https://example.com/x"/>
    <foreignObject><div>untrusted HTML</div></foreignObject><script>alert(1)</script>
  </svg>`);
  assert.equal(svg.querySelector('script,foreignObject,image,a'), null);
  assert.equal(svg.hasAttribute('onload'), false);
  assert.equal(svg.querySelector('[style]'), null);
  assert.equal(svg.querySelector('text')?.getAttribute('fill'), 'blue');
  const marker = svg.querySelector('marker')!;
  assert.match(marker.id, /^mermaid-diagram-1-node-/);
  assert.equal(svg.querySelector('path[marker-end]')?.getAttribute('marker-end'), `url(#${marker.id})`);
  const style = svg.querySelector('style')!;
  assert.equal(style.nonce, 'trusted-test');
  assert.doesNotMatch(style.textContent!, /body|@import|https:/);
  assert.equal(svg.getAttribute('role'), 'img');
  assert.equal(svg.getAttribute('width'), '300');
  assert.ok(svg.querySelector('title'));
});

test('CSS protection rejects escaped resource URLs, sibling selectors and at-rules', t => {
  const viewer = create(t);
  const css = viewer.modules.SvgTest.sanitizeDiagramCss(`
    #mermaid-diagram-2 .node {fill: red;stroke: u\\72l(https://example.com/x);position:fixed}
    #mermaid-diagram-2 + article {display:none}
    #mermaid-diagram-2 .node, body {opacity:0}
    @font-face {font-family: stolen;src:url(https://example.com/font)}
    #mermaid-diagram-2 text {font-size:16px}
  `, 'mermaid-diagram-2');
  assert.match(css, /fill:red/);
  assert.match(css, /font-size:16px/);
  assert.doesNotMatch(css, /https|position|article|body|font-face|opacity/);
  const style = viewer.window.document.createElement('style');
  const svg = viewer.svg('');
  svg.id = 'mermaid-diagram-2';
  viewer.modules.SvgTest.protectMermaidStyle(style, '#mermaid-diagram-2 text {fill:blue}', svg);
  assert.equal(style.nonce, 'trusted-test');
});

test('CSP serialization keeps presentation styles and restores scoped CSS once', t => {
  const viewer = create(t);
  const { setMermaidAttribute, serializeMermaidSvg, takeMermaidStyles, sanitizeDiagramSvg } = viewer.modules.SvgTest;
  const container = viewer.window.document.createElement('div');
  container.innerHTML = `<svg id="mermaid-diagram-3" xmlns="${namespace}" viewBox="0 0 50 50"><style>#mermaid-diagram-3 path{marker-end:url(#arrow)}</style><defs><marker id="arrow"/></defs><path/></svg>`;
  const path = container.querySelector('path')!;
  setMermaidAttribute(path, 'style', 'fill:blue;stroke:url(https://example.com/x);position:fixed');
  assert.equal(path.style.fill, 'blue');
  assert.equal(path.style.stroke, '');
  const serialized = serializeMermaidSvg(container);
  assert.doesNotMatch(serialized, /<style|style=/);
  const css = takeMermaidStyles('mermaid-diagram-3');
  assert.ok(css);
  assert.equal(takeMermaidStyles('mermaid-diagram-3'), '');
  const svg = sanitizeDiagramSvg(serialized, css);
  assert.equal(svg.querySelector('path')?.getAttribute('fill'), 'blue');
  assert.ok(svg.querySelector('style')?.textContent?.includes(`url(#${svg.querySelector('marker')!.id})`));
  assert.equal(svg.querySelector('style')?.nonce, 'trusted-test');
  assert.equal(svg.querySelectorAll('style').length, 1);
});

test('SVG parsing rejects entity declarations and invalid XML', t => {
  const viewer = create(t);
  assert.throws(() => viewer.modules.SvgTest.sanitizeDiagramSvg('<!DOCTYPE svg><svg/>'), /DOCTYPE/);
  assert.throws(() => viewer.modules.SvgTest.sanitizeDiagramSvg('<svg><path></svg>'), /SVG/);
});
