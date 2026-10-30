import { documentWork, type DocumentWork } from './work-scheduler';
import { MermaidController } from './mermaid';
import { LocalImageController } from './local-images';
import { MathController } from './math';
import { SyntaxController } from './syntax';

/* Document HTML is sanitized in Rust; generated SVG is sanitized separately. */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
function requireElement<T extends HTMLElement>(selector: string, elementType: { new(): T }): T {
  const element = document.querySelector(selector);
  if (!(element instanceof elementType)) throw new Error(`Missing or invalid element: ${selector}`);
  return element;
}

let article = requireElement('#document', HTMLElement);
const tabBar = requireElement('#tabs', HTMLElement);
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
interface DocumentTab {
  work: DocumentWork;
  key: number;
  doc: Omit<RenderedDocument, 'html'>;
  article: HTMLElement;
  item: HTMLElement;
  button: HTMLButtonElement;
  diagrams: MermaidController;
  images: LocalImageController;
  math: MathController;
  syntax: SyntaxController;
  scrollTop: number;
  afterPaint: () => void;
}

const tabs: DocumentTab[] = [];
let activeTab: DocumentTab | undefined;
let nextTabKey = 0;

function disposeTab(tab: DocumentTab): void {
  tab.work.dispose();
  tab.diagrams.dispose();
  tab.images.dispose();
  tab.math.dispose();
  tab.syntax.dispose();
}
window.addEventListener('pagehide', () => tabs.forEach(disposeTab));
let requestId = 0;
let choosing = false;

if (/Mac/.test(navigator.platform)) modifier.textContent = '⌘';

function showError(message: unknown): void {
  error.textContent = String(message);
  error.hidden = false;
}

function prepareDocument(article: HTMLElement): void {
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
}

function renderTabs(): void {
  tabBar.hidden = tabs.length < 2;
  for (const tab of tabs) {
    const selected = tab === activeTab;
    tab.button.setAttribute('aria-selected', String(selected));
    tab.button.tabIndex = selected ? 0 : -1;
    tab.button.setAttribute('aria-controls', tab.article.id);
    if (tabBar.hidden) {
      tab.article.removeAttribute('aria-labelledby');
      tab.article.setAttribute('aria-label', 'Documento Markdown');
    } else {
      tab.article.removeAttribute('aria-label');
      tab.article.setAttribute('aria-labelledby', tab.button.id);
    }
  }
  // Only scroll the strip; scrollIntoView would also move the reader.
  if (!tabBar.hidden && activeTab) {
    const item = activeTab.item;
    if (item.offsetLeft < tabBar.scrollLeft) tabBar.scrollLeft = item.offsetLeft;
    else if (item.offsetLeft + item.offsetWidth > tabBar.scrollLeft + tabBar.clientWidth) {
      tabBar.scrollLeft = item.offsetLeft + item.offsetWidth - tabBar.clientWidth;
    }
  }
}

function selectTab(tab: DocumentTab, focusTab = false): void {
  if (activeTab !== tab) {
    if (activeTab) {
      activeTab.work.setActive(false);
      activeTab.scrollTop = reader.scrollTop;
      activeTab.article.hidden = true;
      activeTab.article.id = `document-${activeTab.key}`;
    }
    activeTab = tab;
    article = tab.article;
    article.id = 'document';
    article.hidden = false;
    empty.hidden = true;
    filename.textContent = tab.doc.name;
    filename.title = tab.doc.path;
    fileDetail.textContent = tab.doc.bytes < 1024 ? `${tab.doc.bytes} B` : `${(tab.doc.bytes / 1024).toFixed(1)} KB`;
    error.hidden = true;
    statusLabel.textContent = 'Solo lectura';
    renderTabs();
    reader.scrollTop = tab.scrollTop;
    void invoke('set_document_title', { name: tab.doc.name }).catch(console.error);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (activeTab === tab) {
        tab.work.setActive(true);
        tab.afterPaint();
      }
    }));
  }
  if (focusTab && !tabBar.hidden) tab.button.focus({ preventScroll: true });
  else reader.focus({ preventScroll: true });
}

function closeTab(tab: DocumentTab): void {
  const index = tabs.indexOf(tab);
  if (index === -1) return;
  const wasActive = tab === activeTab;
  const hadFocus = tab.item.contains(document.activeElement);
  tabs.splice(index, 1);
  disposeTab(tab);
  tab.item.remove();
  void invoke('close_document', { documentId: tab.doc.id }).catch(console.error);
  if (wasActive) {
    activeTab = undefined;
    const next = tabs[Math.min(index, tabs.length - 1)];
    if (next) {
      tab.article.remove();
      selectTab(next, hadFocus);
      return;
    }
    // Reuse the empty article for the next opening.
    tab.article.replaceChildren();
    tab.article.hidden = true;
    tab.article.removeAttribute('role');
    tab.article.removeAttribute('aria-labelledby');
    tab.article.setAttribute('aria-label', 'Documento Markdown');
    empty.hidden = false;
    filename.textContent = 'Markdown Viewer';
    filename.removeAttribute('title');
    fileDetail.textContent = 'Solo lectura';
    statusLabel.textContent = 'Listo para leer';
    error.hidden = true;
    void invoke('set_document_title', { name: null }).catch(console.error);
    reader.focus({ preventScroll: true });
  } else tab.article.remove();
  renderTabs();
  if (hadFocus && activeTab) activeTab.button.focus({ preventScroll: true });
}

function addTab(doc: RenderedDocument, openingId: number): void {
  const root = tabs.length ? document.createElement('article') : article;
  const key = ++nextTabKey;
  root.id = `document-${key}`;
  root.className = 'markdown';
  root.hidden = true;
  root.setAttribute('role', 'tabpanel');
  const { html, ...metadata } = doc;
  root.innerHTML = html;
  delete root.dataset.readyMs;
  prepareDocument(root);
  if (!root.isConnected) reader.append(root);
  const work = documentWork.document(root, false);
  const diagrams = new MermaidController(root, undefined, undefined, work);
  const images = new LocalImageController(root, work);
  const math = new MathController(root, undefined, undefined, work);
  const syntax = new SyntaxController(root, undefined, undefined, work);
  const loadImages = images.prepare(doc.id);
  const renderDiagrams = diagrams.prepare();
  const renderMath = math.prepare();
  const highlightCode = syntax.prepare();
  const item = document.createElement('div');
  item.className = 'tab-item';
  item.setAttribute('role', 'presentation');
  const button = document.createElement('button');
  button.id = `tab-${key}`;
  button.className = 'tab-button';
  button.setAttribute('role', 'tab');
  button.textContent = doc.name;
  button.title = doc.path;
  const close = document.createElement('button');
  close.className = 'tab-close';
  close.setAttribute('aria-label', `Cerrar ${doc.name}`);
  close.title = `Cerrar ${doc.name}`;
  close.tabIndex = -1;
  close.textContent = '×';
  item.append(button, close);
  let enhanced = false;
  let measured = false;
  const tab: DocumentTab = {
    work, key, doc: metadata, article: root, item, button, diagrams, images, math, syntax, scrollTop: 0,
    afterPaint: () => {
      if (!enhanced) {
        enhanced = true;
        loadImages();
        renderDiagrams();
        renderMath();
        highlightCode();
      }
      if (measured || openingId !== requestId) return;
      measured = true;
      void invoke('content_painted', { hasDocument: true }).then(elapsed => {
        if (activeTab === tab && openingId === requestId) root.dataset.readyMs = elapsed.toFixed(2);
      }).catch(console.error);
    },
  };
  button.addEventListener('click', () => selectTab(tab, true));
  close.addEventListener('click', () => closeTab(tab));
  item.addEventListener('auxclick', event => {
    if (event.button === 1) { event.preventDefault(); closeTab(tab); }
  });
  button.addEventListener('keydown', event => {
    const index = tabs.indexOf(tab);
    let next: DocumentTab | undefined;
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
    if (event.key === 'Home') next = tabs[0];
    if (event.key === 'End') next = tabs[tabs.length - 1];
    if (next) { event.preventDefault(); selectTab(next, true); }
    if (event.key === 'Delete') { event.preventDefault(); closeTab(tab); }
  });
  tabs.push(tab);
  tabBar.append(item);
  selectTab(tab);
}

async function openDocument(operation: () => Promise<RenderedDocument | null>): Promise<void> {
  const id = ++requestId;
  error.hidden = true;
  statusLabel.textContent = 'Abriendo…';
  try {
    const doc = await operation();
    if (id !== requestId) return;
    if (!doc) {
      statusLabel.textContent = activeTab ? 'Solo lectura' : 'Listo para leer';
      return;
    }
    addTab(doc, id);
  } catch (message) {
    if (id !== requestId) return;
    showError(message);
    statusLabel.textContent = activeTab ? 'Solo lectura' : 'No se pudo abrir el archivo';
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
  if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && activeTab && tabs.length > 1
    && (event.key === 'PageDown' || event.key === 'PageUp')) {
    event.preventDefault();
    const direction = event.key === 'PageDown' ? 1 : -1;
    const next = tabs[(tabs.indexOf(activeTab) + direction + tabs.length) % tabs.length]!;
    selectTab(next, tabBar.contains(document.activeElement));
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    chooseDocument();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w' && activeTab) {
    event.preventDefault();
    closeTab(activeTab);
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
    try { [...article.querySelectorAll<HTMLElement>('[id]')].find(element => element.id === decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: 'instant' }); } catch { /* Invalid fragment. */ }
    return;
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    try { await invoke('open_link', { href }); } catch (message) { showError(message); }
  }
}
reader.addEventListener('click', handleLink);
reader.addEventListener('auxclick', handleLink);
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
