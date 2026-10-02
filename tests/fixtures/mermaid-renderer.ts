declare global {
  interface Window {
    __mermaidLoads?: number;
    __renderMermaidForTests?: (source: string, theme: string) => Promise<SVGSVGElement>;
  }
}

window.__mermaidLoads = (window.__mermaidLoads ?? 0) + 1;

export async function render(source: string, theme: string): Promise<SVGSVGElement> {
  if (!window.__renderMermaidForTests) throw new Error('Unexpected Mermaid render');
  return window.__renderMermaidForTests(source, theme);
}
