import { documentWork, type DocumentWork } from './work-scheduler';

export type MathRenderer = (source: string, display: boolean) => HTMLElement | Promise<HTMLElement>;
type RendererLoader = () => Promise<MathRenderer>;

interface Formula {
  element: HTMLElement;
  source: string;
  display: boolean;
}

const maxFormulas = 500;
const maxSourceLength = 10_000;

/** The controller stays small; KaTeX, sanitation and fonts load only after paint. */
export class MathController {
  private generation = 0;
  private renderer: Promise<MathRenderer> | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly loadRenderer: RendererLoader = async () => {
      const runtime = await import('./math-runtime');
      await runtime.loadStyles();
      return runtime.render;
    },
    private readonly pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0)),
    private readonly work: DocumentWork = documentWork.document(root),
  ) {}

  prepare(): () => void {
    const generation = ++this.generation;
    this.work.invalidate();
    delete this.root.dataset.mathReadyMs;
    // Code and Mermaid definitions must remain literal, including raw HTML markers.
    const elements = [...this.root.querySelectorAll<HTMLElement>('span.math.math-inline, span.math.math-display')]
      .filter(element => !element.closest('pre, code, .mermaid-diagram'));
    const formulas: Formula[] = [];
    elements.forEach((element, index) => {
      const formula = { element, source: element.textContent ?? '', display: element.classList.contains('math-display') };
      if (index >= maxFormulas) this.fail(formula, 'Solo se renderizan las primeras 500 fórmulas del documento.');
      else if (formula.source.length > maxSourceLength) this.fail(formula, 'La fórmula supera el límite de 10.000 caracteres.');
      else {
        element.dataset.mathState = 'pending';
        formulas.push(formula);
      }
    });
    let started = false;
    return () => {
      if (started || !this.current(generation) || formulas.length === 0) return;
      started = true;
      void this.run(generation, formulas);
    };
  }

  private current(generation: number): boolean {
    return generation === this.generation && this.root.isConnected;
  }

  private async run(generation: number, formulas: Formula[]): Promise<void> {
    const started = performance.now();
    try {
      this.renderer ??= this.loadRenderer().catch(error => {
        this.renderer = undefined;
        throw error;
      });
      const render = await this.renderer;
      if (!this.current(generation)) return;
      // Read positions once, after paint, before performing any layout writes.
      const viewport = this.root.parentElement?.getBoundingClientRect();
      const top = viewport?.top ?? 0;
      const bottom = viewport?.bottom ?? window.innerHeight;
      const ordered = formulas.map(formula => {
        const rect = formula.element.getBoundingClientRect();
        return { formula, visible: rect.bottom >= top && rect.top <= bottom };
      }).sort((a, b) => Number(b.visible) - Number(a.visible));
      for (let index = 0; index < ordered.length; index++) {
        if (!this.current(generation)) return;
        const formula = ordered[index]!.formula;
        try {
          const result = await this.work.run('render', formula.element, () => this.current(generation),
            () => render(formula.source, formula.display));
          if (!this.current(generation)) return;
          if (result && this.root.contains(formula.element)) {
            formula.element.replaceChildren(result);
            formula.element.dataset.mathState = 'ready';
          }
        } catch (error) {
          if (!this.current(generation)) return;
          this.fail(formula, `No se pudo representar la fórmula. ${String(error).slice(0, 300)}`);
        }
        // Yield between small batches so long documents keep scrolling/responding.
        if ((index + 1) % 8 === 0) await this.pause();
      }
    } catch (error) {
      if (!this.current(generation)) return;
      for (const formula of formulas) this.fail(formula, `No se pudo cargar el renderizador matemático. ${String(error).slice(0, 300)}`);
    }
    if (this.current(generation)) this.root.dataset.mathReadyMs = (performance.now() - started).toFixed(2);
  }

  private fail(formula: Formula, message: string): void {
    formula.element.textContent = formula.source;
    formula.element.dataset.mathState = 'error';
    formula.element.title = message;
  }

  dispose(): void {
    this.generation++;
    this.work.invalidate();
  }
}
