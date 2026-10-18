import { codeLanguage } from './syntax-languages';

export type CodeRenderer = (source: string, language: string) => string | Promise<string>;
interface CodeBlock { element: HTMLElement; source: string; language: string }

const maxBlocks = 200;
const maxSourceLength = 50_000;
const maxTotalLength = 500_000;

/** Tokenization and grammar imports never run on the path to the first paint. */
export class SyntaxController {
  private generation = 0;
  private renderer: Promise<CodeRenderer> | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly loadRenderer: () => Promise<CodeRenderer> = async () => (await import('./syntax-runtime')).render,
    private readonly pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0)),
  ) {}

  prepare(): () => void {
    const generation = ++this.generation;
    delete this.root.dataset.syntaxReadyMs;
    let started = false;
    return () => {
      if (started || !this.current(generation)) return;
      started = true;
      // Even discovery runs after paint. Mermaid code and inline code stay literal.
      const blocks: CodeBlock[] = [];
      let total = 0;
      for (const element of this.root.querySelectorAll<HTMLElement>('pre > code')) {
        if (element.closest('.mermaid-diagram') || element.classList.contains('language-mermaid')) continue;
        const language = codeLanguage(element);
        if (!language) continue;
        const source = element.textContent ?? '';
        if (blocks.length >= maxBlocks || source.length > maxSourceLength || total + source.length > maxTotalLength) {
          element.dataset.syntaxState = 'skipped';
          continue;
        }
        total += source.length;
        blocks.push({ element, source, language });
      }
      if (blocks.length) void this.run(generation, blocks);
    };
  }

  private current(generation: number): boolean {
    return generation === this.generation && this.root.isConnected;
  }

  private async run(generation: number, blocks: CodeBlock[]): Promise<void> {
    const started = performance.now();
    try {
      this.renderer ??= this.loadRenderer().catch(error => {
        this.renderer = undefined;
        throw error;
      });
      const render = await this.renderer;
      if (!this.current(generation)) return;
      const viewport = this.root.parentElement?.getBoundingClientRect();
      const top = viewport?.top ?? 0;
      const bottom = viewport?.bottom ?? window.innerHeight;
      // Read all positions before changing the DOM, then keep document order per group.
      const ordered = blocks.map(block => {
        const rect = block.element.getBoundingClientRect();
        return { block, visible: rect.bottom >= top && rect.top <= bottom };
      }).sort((a, b) => Number(b.visible) - Number(a.visible));
      let batchStart = performance.now();
      for (let index = 0; index < ordered.length; index++) {
        if (!this.current(generation)) return;
        const { block } = ordered[index]!;
        if (!this.root.contains(block.element)) continue;
        try {
          const html = await render(block.source, block.language);
          if (!this.current(generation)) return;
          if (this.root.contains(block.element)) {
            block.element.innerHTML = html;
            block.element.dataset.syntaxState = 'ready';
          }
        } catch {
          if (!this.current(generation)) return;
          block.element.textContent = block.source;
          block.element.dataset.syntaxState = 'error';
        }
        if (index + 1 < ordered.length && ((index + 1) % 4 === 0 || performance.now() - batchStart >= 8)) {
          await this.pause();
          batchStart = performance.now();
        }
      }
    } catch {
      if (!this.current(generation)) return;
      for (const block of blocks) block.element.dataset.syntaxState = 'error';
    }
    if (this.current(generation)) this.root.dataset.syntaxReadyMs = (performance.now() - started).toFixed(2);
  }

  dispose(): void { this.generation++; }
}
