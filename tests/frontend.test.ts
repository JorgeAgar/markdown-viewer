import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');

interface CommandCall<K extends keyof ViewerCommands = keyof ViewerCommands> {
  command: K;
  args: ViewerCommands[K]['args'];
  resolve: (value: ViewerCommands[K]['result']) => void;
  reject: (reason: unknown) => void;
}

class TauriController {
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
  return { name, path: `/documents/${name}`, html: `<h1 id="${name}">${name}</h1><p>Contents of ${name}</p>`, bytes: 2048 };
}

async function createViewer(t: TestContext, finishStartup = true) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  const tauri = new TauriController();
  const frames: FrameRequestCallback[] = [];
  const consoleErrors: unknown[] = [];
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
  return { window, tauri, startup, element, keyboard, drop, load, assertDocument, assertButtons, paint };
}

test('startup without a pending file leaves the empty view ready', async (t) => {
  const viewer = await createViewer(t);
  assert.equal(viewer.element('document').hidden, true);
  assert.equal(viewer.element('empty').hidden, false);
  assert.equal(viewer.element('status').textContent, 'Listo para leer');
  viewer.assertButtons(false);
});

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
