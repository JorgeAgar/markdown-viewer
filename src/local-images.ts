const MAX_ACTIVE = 2;
let active = 0;
const waiting = new Set<LocalImageController>();
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,/;

interface ImageJob {
  image: HTMLImageElement;
  placeholder: HTMLSpanElement;
  documentId: string;
  imageId: number;
  generation: number;
}

export class LocalImageController {
  private generation = 0;
  private pending: ImageJob[] = [];
  private remaining = 0;
  private started = 0;

  constructor(private readonly article: HTMLElement, private readonly reader: HTMLElement) {}

  dispose(): void {
    this.generation++;
    this.pending = [];
    waiting.delete(this);
    this.remaining = 0;
  }

  prepare(documentId: string): () => void {
    this.dispose();
    delete this.article.dataset.imagesResolvedMs;
    const generation = this.generation;
    // Only a tab accepted by the UI may retain Rust's image references.
    const activation = window.__TAURI__.core.invoke('activate_document_images', { documentId })
      .then(() => true, () => false);
    const jobs: ImageJob[] = [];
    this.article.querySelectorAll('img').forEach(image => {
      image.loading = 'lazy';
      image.decoding = 'async';
      const source = image.getAttribute('src') || '';
      const marker = /^#local-image-(\d+)-(\d+)$/.exec(source);
      if (marker && marker[1] === documentId) {
        image.removeAttribute('src');
        const placeholder = document.createElement('span');
        placeholder.className = 'local-image-placeholder';
        placeholder.textContent = image.alt || 'Cargando imagen…';
        placeholder.title = 'Cargando imagen…';
        // Explicit HTML dimensions can reserve space without reading the file.
        if (image.width) placeholder.style.width = `${image.width}px`;
        if (image.height) placeholder.style.height = `${image.height}px`;
        image.replaceWith(placeholder);
        jobs.push({ image, placeholder, documentId, imageId: Number(marker[2]), generation });
      } else if (!source.startsWith('https://') && !DATA_IMAGE.test(source)) {
        image.removeAttribute('src');
      }
    });
    return () => {
      void activation.then(activated => {
        if (generation !== this.generation) return;
        if (!activated) {
          jobs.forEach(job => {
            job.placeholder.title = 'No se pudo cargar la imagen.';
            job.placeholder.textContent = job.image.alt || 'Imagen no disponible';
          });
          return;
        }
        this.started = performance.now();
        this.remaining = jobs.length;
        this.pending = jobs;
        this.pump();
      });
    };
  }

  private current(job: ImageJob): boolean {
    return job.generation === this.generation && this.article.contains(job.placeholder);
  }

  private pump(): void {
    // Re-evaluate visibility as the user scrolls and earlier images appear.
    const viewport = this.reader.getBoundingClientRect();
    const visible = (job: ImageJob): number => {
      const bounds = job.placeholder.getBoundingClientRect();
      return bounds.bottom >= viewport.top && bounds.top <= viewport.bottom ? 0 : 1;
    };
    this.pending.sort((a, b) => visible(a) - visible(b));
    waiting.add(this);
    while (active < MAX_ACTIVE && this.pending.length) {
      const job = this.pending.shift()!;
      if (!this.current(job)) continue;
      active++;
      void this.resolve(job);
    }
    if (!this.pending.length) waiting.delete(this);
  }

  private async resolve(job: ImageJob): Promise<void> {
    try {
      const source = await window.__TAURI__.core.invoke('resolve_document_image', {
        documentId: job.documentId, imageId: job.imageId,
      });
      if (!this.current(job)) return;
      if (!DATA_IMAGE.test(source)) throw new Error('Origen de imagen inválido.');
      const { image, placeholder } = job;
      image.loading = 'eager';
      image.addEventListener('error', () => {
        if (job.generation !== this.generation || !this.article.contains(image)) return;
        placeholder.title = 'No se pudo cargar la imagen.';
        placeholder.textContent = image.alt || 'Imagen no disponible';
        image.replaceWith(placeholder);
      }, { once: true });
      image.src = source;
      placeholder.replaceWith(image);
    } catch {
      if (this.current(job)) {
        job.placeholder.title = 'No se pudo cargar la imagen.';
        job.placeholder.textContent = job.image.alt || 'Imagen no disponible';
      }
    } finally {
      active--;
      if (job.generation === this.generation) this.remaining--;
      for (const controller of waiting) controller.pump();
      if (job.generation === this.generation && !this.remaining) {
        // Resolution means Rust completed reads/encoding, not WebView decoding.
        this.article.dataset.imagesResolvedMs = (performance.now() - this.started).toFixed(2);
      }
    }
  }
}
