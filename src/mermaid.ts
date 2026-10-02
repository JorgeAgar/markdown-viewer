export type DiagramTheme = 'light' | 'dark';
export type DiagramRenderer = (source: string, theme: DiagramTheme) => Promise<SVGSVGElement>;
type RendererLoader = () => Promise<DiagramRenderer>;

interface DiagramBlock {
  source: string;
  figure: HTMLElement;
  display: HTMLElement;
  message: HTMLElement;
  details: HTMLDetailsElement;
}

const maxBlocks = 50;
const maxTextSize = 50_000;

export function validateMermaidSource(source: string): void {
  if (source.length > maxTextSize) throw new Error('El bloque supera el límite de 50.000 caracteres.');
  if (/^\s*---/.test(source) || /%%\s*\{/.test(source)) {
    throw new Error('La configuración Mermaid por bloque no está admitida.');
  }
  // Keep the first release to text-only diagrams. These statements may inject
  // CSS/resources into Mermaid's temporary DOM before the final SVG is sanitized.
  if (/(?:^|[;\s])(?:style|classDef|linkStyle)\s/.test(source) || /@\s*\{/.test(source)) {
    throw new Error('Los estilos personalizados y las formas con recursos no están admitidos.');
  }
  const code = source.replace(/^\s*%%[^\n]*$/gm, '').trim();
  if (!/^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram)\b/.test(code)) {
    throw new Error('Tipo no admitido. Usa flujos, secuencias, estados, clases o relaciones entre entidades.');
  }
}

/** Coordinates only the visible document. Opening requests have a separate id. */
export class MermaidController {
  private generation = 0;
  private blocks: DiagramBlock[] = [];
  private queue: Promise<void> = Promise.resolve();
  private renderer: Promise<DiagramRenderer> | undefined;
  private painted = false;
  private theme: DiagramTheme;
  private readonly media: MediaQueryList;

  constructor(
    private readonly root: HTMLElement,
    private readonly loadRenderer: RendererLoader = async () => (await import('./mermaid-runtime')).render,
    private readonly pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0)),
  ) {
    this.media = window.matchMedia('(prefers-color-scheme: dark)');
    this.theme = this.media.matches ? 'dark' : 'light';
    if (this.media.addEventListener) this.media.addEventListener('change', this.changeTheme);
    else this.media.addListener(this.changeTheme);
  }

  private changeTheme = (event: MediaQueryListEvent): void => {
    this.theme = event.matches ? 'dark' : 'light';
    if (!this.painted) return;
    const generation = ++this.generation;
    this.schedule(generation);
  };

  /** Prepare synchronously, then invoke the returned callback after text paint. */
  prepare(): () => void {
    const generation = ++this.generation;
    this.painted = false;
    delete this.root.dataset.diagramsReadyMs;
    this.blocks = [];
    const codeBlocks = this.root.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
    codeBlocks.forEach((code, index) => {
      const pre = code.parentElement!;
      const figure = document.createElement('figure');
      figure.className = 'mermaid-diagram';
      const display = document.createElement('div');
      display.className = 'mermaid-svg';
      const message = document.createElement('p');
      message.className = 'mermaid-message';
      message.setAttribute('role', 'status');
      const details = document.createElement('details');
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = 'Ver código';
      pre.replaceWith(figure);
      details.append(summary, pre);
      figure.append(display, message, details);
      const block = { source: code.textContent ?? '', figure, display, message, details };
      this.blocks.push(block);
      if (index >= maxBlocks) this.fail(block, 'Solo se renderizan los primeros 50 diagramas del documento.');
      else {
        figure.dataset.state = 'pending';
        message.textContent = 'Preparando diagrama…';
      }
    });
    return () => {
      if (!this.current(generation)) return;
      this.painted = true;
      this.schedule(generation);
    };
  }

  private current(generation: number, block?: DiagramBlock): boolean {
    return generation === this.generation && this.root.isConnected && (!block || block.figure.isConnected);
  }

  private schedule(generation: number): void {
    if (!this.current(generation) || this.blocks.length === 0) return;
    const blocks = this.blocks.slice(0, maxBlocks);
    const theme = this.theme;
    this.queue = this.queue.then(async () => {
      const started = performance.now();
      for (const block of blocks) {
        if (!this.current(generation, block)) return;
        try {
          validateMermaidSource(block.source);
          block.figure.dataset.state = 'loading';
          block.message.hidden = false;
          block.message.textContent = 'Preparando diagrama…';
          this.renderer ??= this.loadRenderer().catch(error => {
            this.renderer = undefined;
            throw error;
          });
          const render = await this.renderer;
          if (!this.current(generation, block)) return;
          const svg = await render(block.source, theme);
          if (!this.current(generation, block)) return;
          const firstRender = block.display.childElementCount === 0;
          block.display.replaceChildren(svg);
          block.figure.dataset.state = 'ready';
          block.message.hidden = true;
          // Theme changes keep the code disclosure and keyboard focus intact.
          if (firstRender && !block.details.contains(document.activeElement)) block.details.open = false;
        } catch (error) {
          if (!this.current(generation, block)) return;
          const message = error instanceof Error ? error.message : String(error);
          this.fail(block, `No se pudo dibujar el diagrama. ${message.slice(0, 300)}`);
        }
        await this.pause();
      }
      if (this.current(generation)) this.root.dataset.diagramsReadyMs = (performance.now() - started).toFixed(2);
    });
  }

  private fail(block: DiagramBlock, message: string): void {
    block.figure.dataset.state = 'error';
    block.display.replaceChildren();
    block.message.hidden = false;
    block.message.textContent = message;
    block.details.open = true;
  }

  dispose(): void {
    this.generation++;
    if (this.media.removeEventListener) this.media.removeEventListener('change', this.changeTheme);
    else this.media.removeListener(this.changeTheme);
  }
}
