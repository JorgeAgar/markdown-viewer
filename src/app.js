/* All document HTML is parsed and sanitized in Rust before reaching this view. */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const article = document.querySelector('#document');
const empty = document.querySelector('#empty');
const error = document.querySelector('#error');
const reader = document.querySelector('#reader');
const status = document.querySelector('#status');
const dropZone = document.querySelector('#drop-zone');
const openButton = document.querySelector('#open');
const emptyButton = document.querySelector('#empty-open');
let requestId = 0;
let choosing = false;

if (/Mac/.test(navigator.platform)) document.querySelector('#modifier').textContent = '⌘';

function showError(message) {
  error.textContent = String(message);
  error.hidden = false;
}

function prepareDocument() {
  const slugs = new Map();
  article.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading) => {
    if (heading.id) return;
    const base = heading.textContent.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
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

async function openDocument(operation) {
  const id = ++requestId;
  error.hidden = true;
  status.textContent = 'Abriendo…';
  try {
    const doc = await operation();
    if (id !== requestId) return;
    if (!doc) {
      status.textContent = article.hidden ? 'Listo para leer' : 'Solo lectura';
      return;
    }
    article.innerHTML = doc.html;
    prepareDocument();
    article.hidden = false;
    empty.hidden = true;
    reader.scrollTop = 0;
    reader.focus({ preventScroll: true });
    document.querySelector('#filename').textContent = doc.name;
    document.querySelector('#filename').title = doc.path;
    document.querySelector('#file-detail').textContent = doc.bytes < 1024 ? `${doc.bytes} B` : `${(doc.bytes / 1024).toFixed(1)} KB`;
    status.textContent = 'Solo lectura';
    // The second animation frame runs after the browser had an opportunity to
    // paint the new document. Images do not delay the text-ready measurement.
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      if (id !== requestId) return;
      try {
        const elapsed = await invoke('content_painted', { hasDocument: true });
        article.dataset.readyMs = elapsed.toFixed(2);
      } catch (message) {
        console.error(message);
      }
    }));
  } catch (message) {
    if (id !== requestId) return;
    showError(message);
    status.textContent = article.hidden ? 'No se pudo abrir el archivo' : 'Solo lectura';
  }
}

async function chooseDocument() {
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
async function handleLink(event) {
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

async function start() {
  // Listen before consuming the pending path so OS open events cannot be lost
  // while the WebView is starting.
  await listen('file-pending', () => openDocument(() => invoke('take_pending_document')));
  await listen('tauri://drag-enter', () => { dropZone.hidden = false; });
  await listen('tauri://drag-leave', () => { dropZone.hidden = true; });
  await listen('tauri://drag-drop', ({ payload }) => {
    dropZone.hidden = true;
    if (payload.paths?.[0]) openDocument(() => invoke('open_document', { path: payload.paths[0] }));
  });
  await openDocument(() => invoke('take_pending_document'));
}
start().catch(showError);
