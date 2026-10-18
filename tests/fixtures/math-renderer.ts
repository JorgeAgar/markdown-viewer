declare global {
  interface Window {
    __mathLoads?: number;
    __renderMathForTests?: (source: string, display: boolean) => Promise<HTMLElement>;
  }
}

window.__mathLoads = (window.__mathLoads ?? 0) + 1;

export async function loadStyles(): Promise<void> {}

export async function render(source: string, display: boolean): Promise<HTMLElement> {
  if (!window.__renderMathForTests) throw new Error('Unexpected math render');
  return window.__renderMathForTests(source, display);
}
