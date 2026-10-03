import { MermaidController } from './mermaid';

/* Document HTML is sanitized in Rust; generated SVG is sanitized separately. */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
function requireElement<T extends HTMLElement>(selector: string, elementType: { new(): T }): T {
  const element = document.querySelector(selector);
  if (!(element instanceof elementType)) throw new Error(`Missing or invalid element: ${selector}`);
  return element;
}

const article = requireElement('#document', HTMLElement);
const empty = requireElement('#empty', HTMLElement);
const error = requireElement('#error', HTMLElement);
const reader = requireElement('#reader', HTMLElement);
const statusLabel = requireElement('#status', HTMLElement);
const dropZone = requireElement('#drop-zone', HTMLElement);
const openButton = requireElement('#open', HTMLButtonElement);
const emptyButton = requireElement('#empty-open', HTMLButtonElement);
const filename = requireElement('#filename', HTMLElement);
const fileDetail = requireElement('#file-detail', HTMLElement);
const modifier = requireElement('#modifier', HTMLElement);
const diagrams = new MermaidController(article);
window.addEventListener('pagehide', () => diagrams.dispose());
let requestId = 0;
let choosing = false;

if (/Mac/.test(navigator.platform)) modifier.textContent = '⌘';

function showError(message: unknown): void {
  error.textContent = String(message);
  error.hidden = false;
}

function prepareDocument(): void {
  const slugs = new Map<string, number>();
  article.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach((heading) => {
    if (heading.id) return;
    const base = (heading.textContent ?? '').toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
    const count = slugs.get(base) || 0;
    slugs.set(base, count + 1);
    heading.id = count ? `${base}-${count}` : base;
  });
  article.querySelectorAll('input').forEach((input) => {
    input.type = 'checkbox';
    input.disabled = true;
  });
  article.querySelectorAll('img').forEach((image) => {
    image.loading = 'lazy';
    image.decoding = 'async';
    const source = image.getAttribute('src') || '';
    if (!source.startsWith('https://') && !/^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,/.test(source)) {
      image.removeAttribute('src');
    }
  });
}

async function openDocument(operation: () => Promise<RenderedDocument | null>): Promise<void> {
  const id = ++requestId;
  error.hidden = true;
  statusLabel.textContent = 'Abriendo…';
  try {
    const doc = await operation();
    if (id !== requestId) return;
    if (!doc) {
      statusLabel.textContent = article.hidden ? 'Listo para leer' : 'Solo lectura';
      return;
    }
    article.innerHTML = doc.html;
    prepareDocument();
    const renderDiagrams = diagrams.prepare();
    article.hidden = false;
    empty.hidden = true;
    reader.scrollTop = 0;
    reader.focus({ preventScroll: true });
    filename.textContent = doc.name;
    filename.title = doc.path;
    fileDetail.textContent = doc.bytes < 1024 ? `${doc.bytes} B` : `${(doc.bytes / 1024).toFixed(1)} KB`;
    statusLabel.textContent = 'Solo lectura';
    // The second animation frame runs after the browser had an opportunity to
    // paint the new document. Images do not delay the text-ready measurement.
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      // A canceled/failed opening keeps this visible document's diagrams alive.
      renderDiagrams();
      if (id !== requestId) return;
      try {
        const elapsed = await invoke('content_painted', { hasDocument: true });
        if (id !== requestId) return;
        article.dataset.readyMs = elapsed.toFixed(2);
      } catch (message) {
        console.error(message);
      }
    }));
  } catch (message) {
    if (id !== requestId) return;
    showError(message);
    statusLabel.textContent = article.hidden ? 'No se pudo abrir el archivo' : 'Solo lectura';
  }
}

async function chooseDocument(): Promise<void> {
  if (choosing) return;
  choosing = true;
  openButton.disabled = true;
  emptyButton.disabled = true;
  try {
    await openDocument(() => invoke('choose_document'));
  } finally {
    choosing = false;
    openButton.disabled = false;
    emptyButton.disabled = false;
  }
}

openButton.addEventListener('click', chooseDocument);
emptyButton.addEventListener('click', chooseDocument);
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    chooseDocument();
  }
  if (event.key === 'Escape') error.hidden = true;
});

// Keep every navigation inside the reader under our control, including middle
// clicks. Only web/mail links can reach the OS opener.
async function handleLink(event: MouseEvent): Promise<void> {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest('a');
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute('href') || '';
  if (href.startsWith('#')) {
    try { document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: 'instant' }); } catch { /* Invalid fragment. */ }
    return;
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    try { await invoke('open_link', { href }); } catch (message) { showError(message); }
  }
}
article.addEventListener('click', handleLink);
article.addEventListener('auxclick', handleLink);
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());

async function start(): Promise<void> {
  const initialRequest = requestId;
  // Listen before consuming the pending path so OS open events cannot be lost
  // while the WebView is starting.
  await Promise.all([
    listen('file-pending', () => openDocument(() => invoke('take_pending_document'))),
    listen('tauri://drag-enter', () => { dropZone.hidden = false; }),
    listen('tauri://drag-leave', () => { dropZone.hidden = true; }),
    listen('tauri://drag-drop', ({ payload }) => {
      dropZone.hidden = true;
      const path = payload.paths[0];
      if (path) openDocument(() => invoke('open_document', { path }));
    }),
  ]);
  const initialDocument = await invoke('take_pending_document');
  if (initialDocument && requestId === initialRequest) {
    await openDocument(() => Promise.resolve(initialDocument));
  }
}
start().catch((message) => {
  // Any user or OS opening supersedes the initial pending-file read.
  if (requestId === 0) showError(message);
});
