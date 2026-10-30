import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../artifacts/test-app.js', import.meta.url), 'utf8');

interface CommandCall<K extends keyof ViewerCommands = keyof ViewerCommands> {
  command: K;
  args: ViewerCommands[K]['args'];
  resolve: (value: ViewerCommands[K]['result']) => void;
  reject: (reason: unknown) => void;
}

class TauriController {
  holdActivation = false;
  readonly pending: CommandCall[] = [];
  readonly calls: { command: keyof ViewerCommands; args: unknown }[] = [];
  readonly listeners = new Map<keyof ViewerEvents, (payload: unknown) => void>();

  readonly api: Window['__TAURI__'] = {
    core: {
      invoke: <K extends keyof ViewerCommands>(
        command: K,
        ...args: ViewerCommands[K]['args'] extends undefined ? [] : [ViewerCommands[K]['args']]
      ): Promise<ViewerCommands[K]['result']> => {
        const { promise, resolve, reject } = Promise.withResolvers<ViewerCommands[K]['result']>();
        const call = { command, args: args[0], resolve, reject };
        this.calls.push(call);
        if (command === 'close_document' || command === 'set_document_title' || (command === 'activate_document_images' && !this.holdActivation)) {
          resolve(null as ViewerCommands[K]['result']);
          return promise;
        }
        // The queue erases the command parameter; take() restores it only after
        // checking the command name. Test callers retain correlated IPC types.
        this.pending.push(call as CommandCall);
        return promise;
      },
    },
    event: {
      listen: async (event, handler) => {
        assert.equal(this.listeners.has(event), false, `Duplicate listener: ${event}`);
        this.listeners.set(event, (payload) => handler({ event, id: 1, payload: payload as ViewerEvents[typeof event] }));
        return () => { this.listeners.delete(event); };
      },
    },
  };

  take<K extends keyof ViewerCommands>(command: K): CommandCall<K> {
    const index = this.pending.findIndex((call) => call.command === command);
    assert.notEqual(index, -1, `Expected an IPC call to ${command}`);
    return this.pending.splice(index, 1)[0] as unknown as CommandCall<K>;
  }

  emit<K extends keyof ViewerEvents>(event: K, payload: ViewerEvents[K]): void {
    const listener = this.listeners.get(event);
    assert.ok(listener, `Missing listener: ${event}`);
    listener(payload);
  }
}

// An event-loop turn drains promise reactions without timers or assumptions
// about how many chained microtasks the implementation needs.
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function rendered(name: string): RenderedDocument {
  return { id: name, name, path: `/documents/${name}`, html: `<h1 id="${name}">${name}</h1><p>Contents of ${name}</p>`, bytes: 2048 };
}

async function createViewer(t: TestContext, finishStartup = true) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  const tauri = new TauriController();
  const frames: FrameRequestCallback[] = [];
  const consoleErrors: unknown[] = [];
  const themeListeners = new Set<(event: MediaQueryListEvent) => void>();
  window.matchMedia = () => ({
    matches: false,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => { if (typeof listener === 'function') themeListeners.add(listener as (event: MediaQueryListEvent) => void); },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => { if (typeof listener === 'function') themeListeners.delete(listener as (event: MediaQueryListEvent) => void); },
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true,
  });
  window.__TAURI__ = tauri.api;
  window.requestAnimationFrame = (callback) => frames.push(callback);
  window.console.error = (...args: unknown[]) => { consoleErrors.push(args); };
  t.after(() => {
    dom.window.close();
    assert.deepEqual(tauri.pending.map((call) => call.command), [], 'Unexpected IPC calls');
    assert.deepEqual(consoleErrors, [], 'Unexpected console errors');
  });

  function element<T extends HTMLElement = HTMLElement>(id: string): T {
    const found = window.document.getElementById(id);
    assert.ok(found, `Missing element: ${id}`);
    return found as T;
  }
  function keyboard(key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
    const event = new window.KeyboardEvent('keydown', { key, cancelable: true, ...modifiers });
    window.document.dispatchEvent(event);
    return event;
  }
  function drop(path: string) {
    tauri.emit('tauri://drag-drop', { paths: [path], position: { x: 0, y: 0 } });
    const call = tauri.take('open_document');
    assert.equal(call.args.path, path);
    return call;
  }
  async function load(doc: RenderedDocument) {
    drop(doc.path).resolve(doc);
    await settle();
  }
  function assertDocument(doc: RenderedDocument) {
    assert.equal(element('document').innerHTML, doc.html);
    assert.equal(element('document').hidden, false);
    assert.equal(element('empty').hidden, true);
    assert.equal(element('filename').textContent, doc.name);
    assert.equal(element('filename').title, doc.path);
    assert.equal(element('file-detail').textContent, '2.0 KB');
    assert.equal(element('status').textContent, 'Solo lectura');
  }
  function assertButtons(disabled: boolean) {
    assert.equal(element<HTMLButtonElement>('open').disabled, disabled);
    assert.equal(element<HTMLButtonElement>('empty-open').disabled, disabled);
  }
  async function paint() {
    for (let frame = 0; frame < 2; frame++) {
      const callbacks = frames.splice(0);
      callbacks.forEach((callback) => callback(frame));
    }
    await settle();
  }

  window.eval(app);
  await settle();
  assert.deepEqual([...tauri.listeners.keys()], ['file-pending', 'tauri://drag-enter', 'tauri://drag-leave', 'tauri://drag-drop']);
  const startup = tauri.take('take_pending_document');
  if (finishStartup) {
    startup.resolve(null);
    await settle();
  }
  function changeTheme(dark: boolean) { themeListeners.forEach(listener => listener({ matches: dark } as MediaQueryListEvent)); }
  return { window, tauri, startup, element, keyboard, drop, load, assertDocument, assertButtons, paint, changeTheme };
}

test('startup without a pending file leaves the empty view ready', async (t) => {
  const viewer = await createViewer(t);
  assert.equal(viewer.element('document').hidden, true);
  assert.equal(viewer.element('empty').hidden, false);
  assert.equal(viewer.element('status').textContent, 'Listo para leer');
  viewer.assertButtons(false);
  assert.equal(viewer.window.__mathLoads, undefined);
  assert.equal(viewer.window.__syntaxLoads, undefined);
});

test('code highlighting waits for paint without delaying text readiness; late output is ignored', async t => {
  const viewer = await createViewer(t);
  const pending = Promise.withResolvers<string>();
  viewer.window.__renderCodeForTests = () => pending.promise;
  await viewer.load({ ...rendered('code.md'), html: '<pre><code class="language-ts">const x = 1;</code></pre>' });
  assert.equal(viewer.window.__syntaxLoads, undefined);
  await viewer.paint();
  viewer.tauri.take('content_painted').resolve(12);
  await settle();
  assert.equal(viewer.window.__syntaxLoads, 1);
  assert.equal(viewer.element('document').dataset.readyMs, '12.00');
  assert.equal(viewer.element('document').dataset.syntaxReadyMs, undefined);
  await viewer.load(rendered('plain.md'));
  pending.resolve('<span>late code</span>');
  await settle();
  viewer.assertDocument(rendered('plain.md'));
});

for (const outcome of ['cancel', 'error'] as const) {
  test(`code highlighting survives a picker ${outcome} before paint`, async t => {
    const viewer = await createViewer(t);
    viewer.window.__renderCodeForTests = async () => '<span>const</span> x = 1;';
    await viewer.load({ ...rendered('code.md'), html: '<pre><code class="language-js">const x = 1;</code></pre>' });
    viewer.element<HTMLButtonElement>('open').click();
    const picker = viewer.tauri.take('choose_document');
    if (outcome === 'cancel') picker.resolve(null);
    else picker.reject('Picker failed');
    await settle();
    await viewer.paint();
    assert.equal(viewer.tauri.calls.some(call => call.command === 'content_painted'), false);
    assert.equal(viewer.window.__syntaxLoads, 1);
    assert.equal(viewer.element('document').querySelector<HTMLElement>('code')?.dataset.syntaxState, 'ready');
  });
}

test('math starts after paint without delaying text readiness or ordinary documents', async t => {
  const viewer = await createViewer(t);
  const pending = Promise.withResolvers<HTMLElement>();
  viewer.window.__renderMathForTests = () => pending.promise;
  await viewer.load({ ...rendered('math.md'), html: '<p>Texto <span class="math math-inline">x^2</span></p>' });
  assert.equal(viewer.window.__mathLoads, undefined);
  await viewer.paint();
  viewer.tauri.take('content_painted').resolve(12);
  await settle();
  assert.equal(viewer.window.__mathLoads, 1);
  assert.equal(viewer.element('document').dataset.readyMs, '12.00');
  assert.equal(viewer.element('document').dataset.mathReadyMs, undefined);
  await viewer.load(rendered('plain.md'));
  const node = viewer.window.document.createElement('span');
  node.textContent = 'late math';
  pending.resolve(node);
  await settle();
  viewer.assertDocument(rendered('plain.md'));
});

for (const outcome of ['cancel', 'error'] as const) {
  test(`math rendering survives a picker ${outcome} before paint`, async t => {
    const viewer = await createViewer(t);
    viewer.window.__renderMathForTests = async source => {
      const node = viewer.window.document.createElement('span');
      node.textContent = `rendered ${source}`;
      return node;
    };
    await viewer.load({ ...rendered('math.md'), html: '<span class="math math-inline">x^2</span>' });
    viewer.element<HTMLButtonElement>('open').click();
    const picker = viewer.tauri.take('choose_document');
    if (outcome === 'cancel') picker.resolve(null);
    else picker.reject('Picker failed');
    await settle();
    await viewer.paint();
    assert.equal(viewer.tauri.calls.some(call => call.command === 'content_painted'), false);
    assert.equal(viewer.window.__mathLoads, 1);
    assert.equal(viewer.element('document').querySelector<HTMLElement>('.math')?.dataset.mathState, 'ready');
  });
}

for (const stale of ['document', 'error'] as const) {
  test(`latest opening wins over an older ${stale}`, async (t) => {
    const viewer = await createViewer(t);
    const older = viewer.drop('/documents/old.md');
    const newer = rendered('new.md');
    await viewer.load(newer);
    const reader = viewer.element('reader');
    reader.scrollTop = 123;
    if (stale === 'document') older.resolve(rendered('old.md'));
    else older.reject('Old file cannot be read');
    await settle();
    viewer.assertDocument(newer);
    assert.equal(reader.scrollTop, 123, 'An obsolete response must not reset scrolling');
    assert.equal(viewer.element('error').hidden, true);
  });
}

test('an older document cannot replace a newer opening that is still pending', async (t) => {
  const viewer = await createViewer(t);
  const previous = rendered('previous.md');
  await viewer.load(previous);
  const older = viewer.drop('/documents/old.md');
  const newest = viewer.drop('/documents/new.md');
  older.resolve(rendered('old.md'));
  await settle();
  assert.equal(viewer.element('document').innerHTML, previous.html);
  assert.equal(viewer.element('status').textContent, 'Abriendo…');
  newest.reject('New file cannot be read');
  await settle();
  viewer.assertDocument(previous);
  assert.equal(viewer.element('error').textContent, 'New file cannot be read');
  assert.equal(viewer.element('error').hidden, false);
});

for (const outcome of ['success', 'cancel', 'error'] as const) {
  test(`one native picker at a time, buttons restored after ${outcome}`, async (t) => {
    const viewer = await createViewer(t);
    const previous = rendered('previous.md');
    await viewer.load(previous);
    viewer.element<HTMLButtonElement>('open').click();
    const picker = viewer.tauri.take('choose_document');
    viewer.assertButtons(true);
    assert.equal(viewer.element('status').textContent, 'Abriendo…');
    viewer.element<HTMLButtonElement>('empty-open').click();
    assert.equal(viewer.keyboard('o', { ctrlKey: true }).defaultPrevented, true);
    assert.equal(viewer.keyboard('O', { metaKey: true }).defaultPrevented, true);
    assert.equal(viewer.tauri.calls.filter((call) => call.command === 'choose_document').length, 1);
    if (outcome === 'success') picker.resolve(rendered('chosen.md'));
    else if (outcome === 'cancel') picker.resolve(null);
    else picker.reject('Picker failed');
    await settle();
    viewer.assertDocument(outcome === 'success' ? rendered('chosen.md') : previous);
    viewer.assertButtons(false);
    assert.equal(viewer.element('error').hidden, outcome !== 'error');
    if (outcome === 'error') {
      assert.equal(viewer.element('error').textContent, 'Picker failed');
      viewer.keyboard('Escape');
      assert.equal(viewer.element('error').hidden, true);
    }
    viewer.element<HTMLButtonElement>('empty-open').click();
    viewer.assertButtons(true);
    viewer.tauri.take('choose_document').resolve(null);
    await settle();
    viewer.assertButtons(false);
  });
}

test('a canceled obsolete picker does not clear the status of a later drop', async (t) => {
  const viewer = await createViewer(t);
  viewer.keyboard('o', { ctrlKey: true });
  const picker = viewer.tauri.take('choose_document');
  const dropped = viewer.drop('/documents/dropped.md');
  picker.resolve(null);
  await settle();
  viewer.assertButtons(false);
  assert.equal(viewer.element('status').textContent, 'Abriendo…');
  dropped.resolve(rendered('dropped.md'));
  await settle();
  viewer.assertDocument(rendered('dropped.md'));
});

for (const outcome of ['cancel', 'error'] as const) {
  test(`picker ${outcome} without a document preserves the empty view`, async (t) => {
    const viewer = await createViewer(t);
    viewer.element<HTMLButtonElement>('empty-open').click();
    const picker = viewer.tauri.take('choose_document');
    if (outcome === 'cancel') picker.resolve(null);
    else picker.reject('No permission');
    await settle();
    assert.equal(viewer.element('document').hidden, true);
    assert.equal(viewer.element('empty').hidden, false);
    assert.equal(viewer.element('status').textContent, outcome === 'cancel' ? 'Listo para leer' : 'No se pudo abrir el archivo');
    assert.equal(viewer.element('error').hidden, outcome === 'cancel');
    viewer.assertButtons(false);
  });
}

function illustrated(id: string, count = 1): RenderedDocument {
  return {
    ...rendered(`images-${id}.md`), id,
    html: `<h1>Texto primero</h1><p>Lectura disponible</p>${Array.from({ length: count }, (_, index) =>
      `<img src="#local-image-${id}-${index}" alt="Imagen ${index}" width="160" height="90">`).join('')}`,
  };
}

const imageData = 'data:image/png;base64,aW1hZ2U=';

test('text paint and its measurement complete while controlled image reads remain pending', async t => {
  const viewer = await createViewer(t);
  await viewer.load(illustrated('1', 3));
  assert.equal(viewer.element('document').querySelector('h1')?.textContent, 'Texto primero');
  assert.equal(viewer.element('document').hidden, false);
  assert.equal(viewer.tauri.calls.some(call => call.command === 'resolve_document_image'), false);
  const placeholder = viewer.element('document').querySelector<HTMLElement>('.local-image-placeholder')!;
  assert.equal(placeholder.textContent, 'Imagen 0');
  assert.equal(placeholder.style.width, '160px');
  assert.equal(placeholder.style.height, '90px');
  await viewer.paint();
  const first = viewer.tauri.take('resolve_document_image');
  const second = viewer.tauri.take('resolve_document_image');
  assert.equal(first.args.documentId, '1');
  assert.equal(first.args.imageId, 0);
  viewer.tauri.take('content_painted').resolve(18);
  await settle();
  assert.equal(viewer.element('document').dataset.readyMs, '18.00');
  assert.equal(viewer.element('document').dataset.imagesResolvedMs, undefined);
  assert.equal(viewer.element('document').querySelectorAll('img').length, 0);
  // Interaction remains available while Rust has not completed either read.
  const reader = viewer.element('reader');
  reader.scrollTop = 120;
  first.resolve(imageData);
  await settle();
  assert.equal(viewer.element('document').querySelectorAll('img').length, 1);
  assert.equal(reader.scrollTop, 120);
  const third = viewer.tauri.take('resolve_document_image');
  assert.equal(third.args.imageId, 2);
  second.reject('Missing or oversized image');
  third.resolve(imageData);
  await settle();
  assert.equal(viewer.element('document').querySelectorAll('img').length, 2);
  assert.equal(viewer.element('document').querySelector('.local-image-placeholder')?.textContent, 'Imagen 1');
  assert.ok(viewer.element('document').dataset.imagesResolvedMs);
  assert.equal(viewer.element('error').hidden, true);
});

test('visible local images are requested before images outside the reader viewport', async t => {
  const viewer = await createViewer(t);
  await viewer.load(illustrated('2', 3));
  const bounds = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
  viewer.element('reader').getBoundingClientRect = () => bounds(0, 100);
  viewer.element('document').querySelectorAll<HTMLElement>('.local-image-placeholder').forEach((element, index) => {
    element.getBoundingClientRect = () => index === 2 ? bounds(20, 40) : bounds(200, 220);
  });
  await viewer.paint();
  viewer.tauri.take('content_painted').resolve(20);
  const visible = viewer.tauri.take('resolve_document_image');
  const offscreen = viewer.tauri.take('resolve_document_image');
  assert.equal(visible.args.imageId, 2);
  visible.resolve(imageData);
  offscreen.resolve(imageData);
  await settle();
  viewer.tauri.take('resolve_document_image').resolve(imageData);
  await settle();
});

test('closing a tab discards its image responses and queued reads, with a global concurrency limit', async t => {
  const viewer = await createViewer(t);
  await viewer.load(illustrated('3', 3));
  await viewer.paint();
  viewer.tauri.take('content_painted').resolve(20);
  const oldFirst = viewer.tauri.take('resolve_document_image');
  const oldSecond = viewer.tauri.take('resolve_document_image');
  await viewer.load(illustrated('4', 2));
  viewer.element('tabs').querySelector<HTMLButtonElement>('.tab-close')!.click();
  await viewer.paint();
  viewer.tauri.take('content_painted').resolve(30);
  assert.equal(viewer.tauri.pending.length, 0, 'New reads wait for old reads to release the two slots');
  oldFirst.resolve(imageData);
  oldSecond.reject('Obsolete error');
  await settle();
  assert.equal(viewer.element('document').querySelectorAll('img').length, 0);
  assert.equal(viewer.tauri.calls.filter(call => call.command === 'resolve_document_image').length, 4);
  const newFirst = viewer.tauri.take('resolve_document_image');
  const newSecond = viewer.tauri.take('resolve_document_image');
  assert.equal(newFirst.args.documentId, '4');
  assert.equal(newSecond.args.documentId, '4');
  newFirst.resolve(imageData);
  newSecond.resolve(imageData);
  await settle();
  assert.equal(viewer.element('document').querySelectorAll('img').length, 2);
  assert.equal(viewer.element('document').dataset.readyMs, '30.00');
  assert.equal(viewer.element('error').hidden, true);
});

for (const outcome of ['cancel', 'error'] as const) {
  test(`local image loading survives a picker ${outcome} before paint`, async t => {
    const viewer = await createViewer(t);
    await viewer.load(illustrated('5'));
    viewer.element<HTMLButtonElement>('open').click();
    const picker = viewer.tauri.take('choose_document');
    if (outcome === 'cancel') picker.resolve(null);
    else picker.reject('Picker failed');
    await settle();
    await viewer.paint();
    viewer.tauri.take('resolve_document_image').resolve(imageData);
    await settle();
    assert.equal(viewer.element('document').querySelector('img')?.alt, 'Imagen 0');
    assert.equal(viewer.tauri.calls.some(call => call.command === 'content_painted'), false);
  });
}

test('invalid image data and decoding failures preserve alt text and isolate errors', async t => {
  const viewer = await createViewer(t);
  await viewer.load(illustrated('6', 2));
  await viewer.paint();
  viewer.tauri.take('content_painted').resolve(20);
  viewer.tauri.take('resolve_document_image').resolve('file:///etc/passwd');
  viewer.tauri.take('resolve_document_image').resolve(imageData);
  await settle();
  const image = viewer.element('document').querySelector('img')!;
  image.dispatchEvent(new viewer.window.Event('error'));
  assert.deepEqual([...viewer.element('document').querySelectorAll('.local-image-placeholder')].map(el => el.textContent), ['Imagen 0', 'Imagen 1']);
  assert.equal(viewer.element('error').hidden, true);
  assert.equal(viewer.element('document').querySelector('h1')?.textContent, 'Texto primero');
});

test('an old document replaced before paint never requests local images', async t => {
  const viewer = await createViewer(t);
  await viewer.load(illustrated('7'));
  await viewer.load(rendered('text.md'));
  await viewer.paint();
  viewer.tauri.take('content_painted').resolve(20);
  assert.equal(viewer.tauri.calls.some(call => call.command === 'resolve_document_image'), false);
  await settle();
});

for (const outcome of ['success', 'error'] as const) {
  test(`text paint does not wait for image activation ${outcome}`, async t => {
    const viewer = await createViewer(t);
    viewer.tauri.holdActivation = true;
    await viewer.load(illustrated('8'));
    const activation = viewer.tauri.take('activate_document_images');
    assert.equal(activation.args.documentId, '8');
    await viewer.paint();
    viewer.tauri.take('content_painted').resolve(15);
    await settle();
    assert.equal(viewer.element('document').dataset.readyMs, '15.00');
    assert.equal(viewer.tauri.calls.some(call => call.command === 'resolve_document_image'), false);
    if (outcome === 'success') {
      activation.resolve(null);
      await settle();
      viewer.tauri.take('resolve_document_image').resolve(imageData);
      await settle();
      assert.equal(viewer.element('document').querySelector('img')?.alt, 'Imagen 0');
    } else {
      activation.reject('Obsolete opening');
      await settle();
      assert.equal(viewer.element('document').querySelector('.local-image-placeholder')?.textContent, 'Imagen 0');
      assert.equal(viewer.element('error').hidden, true);
    }
  });
}

test('startup displays a pending file when no other opening has started', async (t) => {
  const viewer = await createViewer(t, false);
  viewer.startup.resolve(rendered('startup.md'));
  await settle();
  viewer.assertDocument(rendered('startup.md'));
  assert.equal(viewer.element('reader').scrollTop, 0);
  assert.equal(viewer.window.document.activeElement, viewer.element('reader'));
});

for (const outcome of ['document', 'error'] as const) {
  test(`startup ${outcome} cannot overwrite a newer opening`, async (t) => {
    const viewer = await createViewer(t, false);
    const newer = rendered('newer.md');
    await viewer.load(newer);
    if (outcome === 'document') viewer.startup.resolve(rendered('startup.md'));
    else viewer.startup.reject('Obsolete startup error');
    await settle();
    viewer.assertDocument(newer);
    assert.equal(viewer.element('error').hidden, true);
  });
}

test('a current startup error is still shown', async (t) => {
  const viewer = await createViewer(t, false);
  viewer.startup.reject('Startup failed');
  await settle();
  assert.equal(viewer.element('error').hidden, false);
  assert.equal(viewer.element('error').textContent, 'Startup failed');
});

test('file-pending events are handled while the initial pending read is unfinished', async (t) => {
  const viewer = await createViewer(t, false);
  viewer.tauri.emit('file-pending', null);
  viewer.tauri.take('take_pending_document').resolve(rendered('event.md'));
  await settle();
  viewer.startup.resolve(rendered('startup.md'));
  await settle();
  viewer.assertDocument(rendered('event.md'));
});

test('an obsolete file-pending error cannot replace a later drop', async (t) => {
  const viewer = await createViewer(t);
  viewer.tauri.emit('file-pending', null);
  const pending = viewer.tauri.take('take_pending_document');
  await viewer.load(rendered('dropped.md'));
  pending.reject('Old pending file failed');
  await settle();
  viewer.assertDocument(rendered('dropped.md'));
  assert.equal(viewer.element('error').hidden, true);
});

test('paint callbacks for superseded documents do not report content_painted', async (t) => {
  const viewer = await createViewer(t);
  await viewer.load(rendered('old.md'));
  await viewer.load(rendered('new.md'));
  await viewer.paint();
  const paint = viewer.tauri.take('content_painted');
  assert.equal(paint.args.hasDocument, true);
  assert.equal(viewer.tauri.calls.filter((call) => call.command === 'content_painted').length, 1);
  paint.resolve(25);
  await settle();
  assert.equal(viewer.element('document').dataset.readyMs, '25.00');
});

test('an obsolete content_painted response cannot update the current document measurement', async (t) => {
  const viewer = await createViewer(t);
  await viewer.load(rendered('old.md'));
  await viewer.paint();
  const oldPaint = viewer.tauri.take('content_painted');
  await viewer.load(rendered('new.md'));
  await viewer.paint();
  viewer.tauri.take('content_painted').resolve(20);
  await settle();
  oldPaint.resolve(99);
  await settle();
  viewer.assertDocument(rendered('new.md'));
  assert.equal(viewer.element('document').dataset.readyMs, '20.00');
});

for (const outcome of ['cancel', 'error'] as const) {
  test(`Mermaid rendering survives a newer picker ${outcome} on the same visible document`, async t => {
    const viewer = await createViewer(t);
    const source = 'flowchart LR\nA-->B';
    viewer.window.__renderMermaidForTests = async () => {
      return viewer.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    };
    const doc = { ...rendered('mermaid.md'), html: `<pre><code class="language-mermaid">${source}</code></pre>` };
    await viewer.load(doc);
    assert.equal(viewer.window.__mermaidLoads, undefined, 'Renderer must wait for text paint');
    viewer.element<HTMLButtonElement>('open').click();
    const picker = viewer.tauri.take('choose_document');
    if (outcome === 'cancel') picker.resolve(null);
    else picker.reject('Picker failed');
    await settle();
    await viewer.paint();
    assert.equal(viewer.tauri.calls.some(call => call.command === 'content_painted'), false);
    assert.equal(viewer.window.__mermaidLoads, 1);
    assert.equal(viewer.element('document').querySelector('figure')?.dataset.state, 'ready');
    assert.equal(viewer.element('document').querySelector('code')?.textContent, source);
  });
}


test('each picker selection adds a tab; the strip only appears with multiple files', async t => {
  const viewer = await createViewer(t);
  assert.equal(viewer.element('tabs').hidden, true);
  for (const name of ['one.md', 'two.md']) {
    viewer.element<HTMLButtonElement>('open').click();
    viewer.tauri.take('choose_document').resolve(rendered(name));
    await settle();
    viewer.assertDocument(rendered(name));
    assert.equal(viewer.element('tabs').hidden, name === 'one.md');
  }
  const buttons = [...viewer.element('tabs').querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  assert.deepEqual(buttons.map(button => button.textContent), ['one.md', 'two.md']);
  assert.deepEqual(buttons.map(button => button.getAttribute('aria-selected')), ['false', 'true']);
  assert.deepEqual(buttons.map(button => button.tabIndex), [-1, 0]);
  buttons.forEach(button => {
    const panel = viewer.element(button.getAttribute('aria-controls')!);
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), button.id);
  });
});

test('switching tabs preserves their DOM, scroll and window title without reopening files', async t => {
  const viewer = await createViewer(t);
  await viewer.load(rendered('one.md'));
  const first = viewer.element('document');
  viewer.element('reader').scrollTop = 123;
  await viewer.load(rendered('two.md'));
  const second = viewer.element('document');
  viewer.element('reader').scrollTop = 456;
  const buttons = [...viewer.element('tabs').querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  buttons[0]!.click();
  viewer.assertDocument(rendered('one.md'));
  assert.equal(viewer.element('document'), first);
  assert.equal(viewer.element('reader').scrollTop, 123);
  assert.equal(second.hidden, true);
  buttons[1]!.click();
  viewer.assertDocument(rendered('two.md'));
  assert.equal(viewer.element('document'), second);
  assert.equal(viewer.element('reader').scrollTop, 456);
  assert.equal(viewer.tauri.calls.filter(call => call.command === 'open_document').length, 2);
  assert.deepEqual(viewer.tauri.calls.filter(call => call.command === 'set_document_title').map(call => (call.args as { name: string }).name),
    ['one.md', 'two.md', 'one.md', 'two.md']);
});

test('closing active and inactive tabs selects a neighbor and returns to an empty view', async t => {
  const viewer = await createViewer(t);
  for (const name of ['one.md', 'two.md', 'three.md']) await viewer.load(rendered(name));
  const first = viewer.element('tabs').querySelector<HTMLButtonElement>('.tab-close')!;
  first.click();
  viewer.assertDocument(rendered('three.md'));
  assert.equal(viewer.element('tabs').querySelectorAll('[role="tab"]').length, 2);
  assert.equal(viewer.keyboard('w', { ctrlKey: true }).defaultPrevented, true);
  viewer.assertDocument(rendered('two.md'));
  assert.equal(viewer.element('tabs').hidden, true);
  assert.equal(viewer.element('document').getAttribute('aria-labelledby'), null);
  assert.equal(viewer.keyboard('w', { metaKey: true }).defaultPrevented, true);
  assert.equal(viewer.element('document').hidden, true);
  assert.equal(viewer.element('empty').hidden, false);
  assert.equal(viewer.element('filename').textContent, 'Markdown Viewer');
  assert.equal(viewer.element('status').textContent, 'Listo para leer');
  assert.equal(viewer.element('tabs').children.length, 0);
  assert.equal(viewer.window.document.querySelectorAll('article').length, 1);
  assert.deepEqual(viewer.tauri.calls.filter(call => call.command === 'close_document').map(call => (call.args as { documentId: string }).documentId),
    ['one.md', 'three.md', 'two.md']);
  await viewer.load(rendered('again.md'));
  viewer.assertDocument(rendered('again.md'));
  assert.equal(viewer.element('tabs').hidden, true);
});

test('tab keyboard navigation wraps, supports Home/End and keeps focus after Delete', async t => {
  const viewer = await createViewer(t);
  for (const name of ['one.md', 'two.md', 'three.md']) await viewer.load(rendered(name));
  const buttons = [...viewer.element('tabs').querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  function key(key: string) {
    const event = new viewer.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    viewer.window.document.activeElement!.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  }
  buttons[2]!.click();
  key('ArrowRight');
  viewer.assertDocument(rendered('one.md'));
  assert.equal(viewer.window.document.activeElement, buttons[0]);
  key('ArrowLeft');
  viewer.assertDocument(rendered('three.md'));
  key('Home');
  viewer.assertDocument(rendered('one.md'));
  key('End');
  viewer.assertDocument(rendered('three.md'));
  key('Delete');
  viewer.assertDocument(rendered('two.md'));
  assert.equal(viewer.window.document.activeElement, buttons[1]);
  key('Delete');
  viewer.assertDocument(rendered('one.md'));
  assert.equal(viewer.window.document.activeElement, viewer.element('reader'));
});

test('Ctrl+PageDown and Ctrl+PageUp cycle tabs from the reader or tab strip', async t => {
  const viewer = await createViewer(t);
  assert.equal(viewer.keyboard('PageDown', { ctrlKey: true }).defaultPrevented, false);
  await viewer.load(rendered('one.md'));
  assert.equal(viewer.keyboard('PageUp', { ctrlKey: true }).defaultPrevented, false);
  viewer.element('reader').scrollTop = 123;
  await viewer.load(rendered('two.md'));
  await viewer.load(rendered('three.md'));
  assert.equal(viewer.keyboard('PageDown').defaultPrevented, false);
  viewer.assertDocument(rendered('three.md'));
  assert.equal(viewer.keyboard('PageDown', { ctrlKey: true }).defaultPrevented, true);
  viewer.assertDocument(rendered('one.md'));
  assert.equal(viewer.element('reader').scrollTop, 123);
  assert.equal(viewer.window.document.activeElement, viewer.element('reader'));
  assert.equal(viewer.keyboard('PageDown', { ctrlKey: true }).defaultPrevented, true);
  viewer.assertDocument(rendered('two.md'));
  assert.equal(viewer.keyboard('PageUp', { ctrlKey: true }).defaultPrevented, true);
  viewer.assertDocument(rendered('one.md'));
  viewer.element('tabs').querySelector<HTMLButtonElement>('[role="tab"]')!.focus();
  assert.equal(viewer.keyboard('PageUp', { ctrlKey: true }).defaultPrevented, true);
  viewer.assertDocument(rendered('three.md'));
  assert.equal(viewer.window.document.activeElement,
    viewer.element('tabs').querySelector('[aria-selected="true"]'));
});

test('switching tabs prioritizes active images, pauses hidden reads and reuses completed images', async t => {
  const viewer = await createViewer(t);
  await viewer.load(illustrated('11', 3));
  await viewer.paint();
  viewer.tauri.take('content_painted').resolve(20);
  const oldFirst = viewer.tauri.take('resolve_document_image');
  const oldSecond = viewer.tauri.take('resolve_document_image');
  await viewer.load(illustrated('12'));
  await viewer.paint();
  viewer.tauri.take('content_painted').resolve(30);
  assert.equal(viewer.tauri.pending.length, 0);
  oldFirst.resolve(imageData);
  oldSecond.resolve(imageData);
  await settle();
  const next = viewer.tauri.take('resolve_document_image');
  assert.equal(next.args.documentId, '12');
  assert.equal(viewer.tauri.pending.length, 0, 'The hidden tab must not refill free slots');
  next.resolve(imageData);
  await settle();
  viewer.element('tabs').querySelector<HTMLButtonElement>('[role="tab"]')!.click();
  assert.equal(viewer.element('document').querySelectorAll('img').length, 2);
  await viewer.paint();
  const third = viewer.tauri.take('resolve_document_image');
  assert.equal(third.args.documentId, '11');
  third.resolve(imageData);
  await settle();
  assert.equal(viewer.element('document').querySelectorAll('img').length, 3);
  assert.equal(viewer.tauri.calls.filter(call => call.command === 'activate_document_images').length, 2);
});

test('a tab hidden before paint defers heavy work until it is selected again', async t => {
  const viewer = await createViewer(t);
  await viewer.load(illustrated('13'));
  await viewer.load(rendered('text.md'));
  await viewer.paint();
  viewer.tauri.take('content_painted').resolve(20);
  assert.equal(viewer.tauri.calls.some(call => call.command === 'resolve_document_image'), false);
  viewer.element('tabs').querySelector<HTMLButtonElement>('[role="tab"]')!.click();
  await viewer.paint();
  viewer.tauri.take('resolve_document_image').resolve(imageData);
  await settle();
  assert.equal(viewer.element('document').querySelectorAll('img').length, 1);
});

test('fragment links stay inside the active tab when documents share heading IDs', async t => {
  const viewer = await createViewer(t);
  const doc = { ...rendered('one.md'), html: '<h1 id="same">Heading</h1><a href="#same">Go</a>' };
  await viewer.load(doc);
  const firstHeading = viewer.element('document').querySelector<HTMLElement>('h1')!;
  firstHeading.scrollIntoView = () => assert.fail('Scrolled to an inactive tab');
  await viewer.load({ ...doc, id: 'two', name: 'two.md', path: '/documents/two.md' });
  let scrolled = false;
  viewer.element('document').querySelector<HTMLElement>('h1')!.scrollIntoView = () => { scrolled = true; };
  viewer.element('document').querySelector<HTMLAnchorElement>('a')!.click();
  assert.equal(scrolled, true);
});


test('rendered code remains in its original tab and is reused on return', async t => {
  const viewer = await createViewer(t);
  const pending = Promise.withResolvers<string>();
  viewer.window.__renderCodeForTests = () => pending.promise;
  await viewer.load({ ...rendered('code.md'), html: '<pre><code class="language-ts">const x = 1;</code></pre>' });
  await viewer.paint();
  viewer.tauri.take('content_painted').resolve(12);
  await viewer.load(rendered('plain.md'));
  pending.resolve('<span class="hljs-keyword">const</span> x = 1;');
  await settle();
  viewer.assertDocument(rendered('plain.md'));
  viewer.element('tabs').querySelector<HTMLButtonElement>('[role="tab"]')!.click();
  const code = viewer.element('document').querySelector<HTMLElement>('code')!;
  assert.equal(code.dataset.syntaxState, 'ready');
  assert.equal(code.querySelector('.hljs-keyword')?.textContent, 'const');
  await viewer.paint();
  assert.equal(viewer.window.__syntaxLoads, 1);
  assert.equal(viewer.element('document').querySelector('code'), code);
});


for (const kind of ['math', 'syntax', 'mermaid'] as const) {
  test(`${kind} pauses between blocks in hidden tabs and resumes without repeating completed work`, async t => {
    const viewer = await createViewer(t);
    const first = Promise.withResolvers<void>();
    const calls: string[] = [];
    const html = kind === 'math'
      ? '<span class="math math-inline">one</span><span class="math math-inline">two</span>'
      : `<pre><code class="language-${kind === 'syntax' ? 'js' : 'mermaid'}">${kind === 'mermaid' ? 'graph TD; one-->A' : 'one'}</code></pre>`
        + `<pre><code class="language-${kind === 'syntax' ? 'js' : 'mermaid'}">${kind === 'mermaid' ? 'graph TD; two-->A' : 'two'}</code></pre>`;
    const record = async (source: string) => {
      calls.push(source);
      if (calls.length === 1) await first.promise;
    };
    viewer.window.__renderMathForTests = async source => { await record(source); return viewer.window.document.createElement('b'); };
    viewer.window.__renderCodeForTests = async source => { await record(source); return `<b>${source}</b>`; };
    viewer.window.__renderMermaidForTests = async source => { await record(source); return viewer.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg'); };
    await viewer.load({ ...rendered('complex.md'), html });
    await viewer.paint();
    viewer.tauri.take('content_painted').resolve(1);
    assert.equal(calls.length, 1);
    await viewer.load(rendered('plain.md'));
    await viewer.paint();
    viewer.tauri.take('content_painted').resolve(1);
    first.resolve();
    // Mermaid yields between blocks; wait for that boundary as well.
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.length, 1, 'Hidden tabs must not start the second block');
    viewer.element('tabs').querySelector<HTMLButtonElement>('[role="tab"]')!.click();
    await settle();
    assert.equal(calls.length, 1, 'Resume must wait for text paint');
    await viewer.paint();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.length, 2);
    assert.equal(new Set(calls).size, 2, 'The first block must not render again');
  });
}

test('hidden Mermaid tabs defer theme work and use only the latest theme on return', async t => {
  const viewer = await createViewer(t);
  const themes: string[] = [];
  viewer.window.__renderMermaidForTests = async (_source, theme) => {
    themes.push(theme);
    return viewer.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  };
  await viewer.load({ ...rendered('diagram.md'), html: '<pre><code class="language-mermaid">graph TD; A-->B</code></pre>' });
  await viewer.paint(); viewer.tauri.take('content_painted').resolve(1);
  await new Promise(resolve => setTimeout(resolve, 20));
  await viewer.load(rendered('plain.md'));
  await viewer.paint(); viewer.tauri.take('content_painted').resolve(1);
  viewer.changeTheme(true);
  await settle();
  viewer.changeTheme(false);
  await settle();
  viewer.changeTheme(true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(themes, ['light']);
  viewer.element('tabs').querySelector<HTMLButtonElement>('[role="tab"]')!.click();
  await viewer.paint();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(themes, ['light', 'dark']);
});

test('with 100 tabs, queued Mermaid work belongs to the active tab while another diagram finishes', async t => {
  const viewer = await createViewer(t);
  const first = Promise.withResolvers<SVGSVGElement>();
  const sources: string[] = [];
  viewer.window.__renderMermaidForTests = async source => {
    sources.push(source);
    return sources.length === 1 ? first.promise : viewer.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  };
  for (const name of Array.from({ length: 100 }, (_, index) => `Doc${index}`)) {
    await viewer.load({ ...rendered(name), html: `<pre><code class="language-mermaid">graph TD; ${name}-->X</code></pre>` });
    await viewer.paint(); viewer.tauri.take('content_painted').resolve(1);
  }
  assert.deepEqual(sources, ['graph TD; Doc0-->X']);
  first.resolve(viewer.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
  await settle();
  assert.deepEqual(sources, ['graph TD; Doc0-->X', 'graph TD; Doc99-->X']);
  // Closing a paused tab cancels its queued block rather than leaving a future render.
  viewer.element('tabs').querySelectorAll<HTMLButtonElement>('.tab-close')[1]!.click();
  await settle();
  assert.deepEqual(sources, ['graph TD; Doc0-->X', 'graph TD; Doc99-->X']);
});
