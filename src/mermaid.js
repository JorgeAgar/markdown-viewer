const MAX_SOURCE_LENGTH = 50_000;
const figures = new WeakMap();
let sequence = 0;
let queue = Promise.resolve();
let rendererFrame;

function loadFrame() {
  if (rendererFrame) return rendererFrame;
  rendererFrame = new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.className = 'mermaid-frame';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    const script = new URL('./mermaid-frame.js', import.meta.url).href;
    const styles = new URL('../style.css', import.meta.url).href;
    // srcdoc gets an opaque origin through sandbox, with no same-origin access.
    // All script/style URLs are controlled local assets, never diagram content.
    frame.srcdoc = `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src tauri: http://tauri.localhost https://tauri.localhost; style-src tauri: http://tauri.localhost https://tauri.localhost; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
      <link rel="stylesheet" href="${styles}">
      <script src="${script}"></script></head><body></body></html>`;
    const timer = setTimeout(() => {
      window.removeEventListener('message', ready);
      frame.remove();
      rendererFrame = undefined;
      reject(new Error('No se pudo iniciar Mermaid'));
    }, 15_000);
    function ready(event) {
      if (event.source !== frame.contentWindow || event.data?.type !== 'mermaid-ready') return;
      clearTimeout(timer);
      window.removeEventListener('message', ready);
      resolve(frame);
    }
    window.addEventListener('message', ready);
    document.body.append(frame);
  });
  return rendererFrame;
}

async function renderSvg(source, dark) {
  const frame = await loadFrame();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Mermaid no respondió')), 30_000);
    function finish(error, svg) {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      if (error) reject(error); else resolve(svg);
    }
    function receive(event) {
      if (event.source !== frame.contentWindow || event.data?.type !== 'mermaid-result' || event.data.id !== id) return;
      if (typeof event.data.svg === 'string') finish(null, event.data.svg);
      else finish(new Error('No se pudo generar el diagrama'));
    }
    window.addEventListener('message', receive);
    frame.contentWindow.postMessage({ type: 'mermaid-render', id, source, dark }, '*');
  });
}

function svgImage(svg, index) {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') {
    throw new Error('SVG inválido');
  }
  const image = new Image();
  image.alt = parsed.querySelector('title')?.textContent || `Diagrama Mermaid ${index + 1}`;
  image.decoding = 'async';
  // SVG is displayed as an image, not inserted into the document's active DOM.
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  image.src = `data:image/svg+xml;base64,${btoa(binary)}`;
  const viewBox = parsed.documentElement.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    image.width = Math.ceil(viewBox[2]);
    image.height = Math.ceil(viewBox[3]);
  }
  return image;
}

function diagramError(block, message) {
  const previous = figures.get(block);
  previous?.remove();
  const notice = document.createElement('p');
  notice.className = 'mermaid-error';
  notice.setAttribute('role', 'status');
  notice.textContent = message;
  block.before(notice);
  block.hidden = false;
  figures.set(block, notice);
}

async function renderBatch(article, isCurrent, dark) {
  if (!isCurrent()) return;
  const blocks = [...article.querySelectorAll('pre > code.language-mermaid')];
  for (const [index, code] of blocks.entries()) {
    if (!isCurrent() || !code.isConnected) return;
    const block = code.parentElement;
    try {
      const source = code.textContent;
      if (source.length > MAX_SOURCE_LENGTH) throw new Error('Diagrama demasiado grande');
      const svg = await renderSvg(source, dark);
      if (!isCurrent() || !code.isConnected) return;
      const image = svgImage(svg, index);
      await image.decode();
      if (!isCurrent() || !code.isConnected) return;
      const figure = document.createElement('figure');
      figure.className = 'mermaid-diagram';
      figure.append(image);
      figures.get(block)?.remove();
      block.before(figure);
      block.hidden = true;
      figures.set(block, figure);
    } catch (error) {
      if (!isCurrent() || !code.isConnected) return;
      diagramError(block, code.textContent.length > MAX_SOURCE_LENGTH
        ? 'El diagrama Mermaid supera el límite de 50 000 caracteres. Se muestra el código.'
        : 'No se pudo mostrar este diagrama Mermaid. Se muestra el código.');
      console.error('Mermaid:', error);
    }
  }
}

export function renderDiagrams(article, isCurrent, dark) {
  // Mermaid uses shared configuration. Serialize batches, including theme changes.
  const operation = queue.then(() => renderBatch(article, isCurrent, dark));
  queue = operation.catch(() => {});
  return operation;
}
