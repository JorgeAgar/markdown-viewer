import mermaid from 'mermaid';
import { sanitizeDiagramSvg, takeMermaidStyles } from './diagram-svg';
import type { DiagramRenderer, DiagramTheme } from './mermaid';

let nextId = 0;

export const render: DiagramRenderer = async (source: string, theme: DiagramTheme) => {
  let id: string;
  do { id = `mermaid-diagram-${++nextId}`; } while (document.getElementById(id));
  const host = document.createElement('div');
  host.className = 'mermaid-render-host';
  host.setAttribute('aria-hidden', 'true');
  document.body.append(host);
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      htmlLabels: false,
      theme: theme === 'dark' ? 'dark' : 'default',
      fontFamily: 'Arial, sans-serif',
      maxTextSize: 50_000,
      maxEdges: 500,
      dompurifyConfig: {
        FORBID_TAGS: ['style', 'img', 'image', 'foreignObject', 'iframe'],
        FORBID_ATTR: ['style'],
      },
      // Preserve Mermaid's secure defaults and lock all display/sanitizer overrides.
      secure: [
        'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering',
        'htmlLabels', 'theme', 'themeVariables', 'themeCSS', 'dompurifyConfig', 'fontFamily',
      ],
      flowchart: { htmlLabels: false, useMaxWidth: false },
      sequence: { useMaxWidth: false },
    });
    await document.fonts?.ready;
    const { svg } = await mermaid.render(id, source, host);
    return sanitizeDiagramSvg(svg, takeMermaidStyles(id));
  } finally {
    takeMermaidStyles(id);
    host.remove();
  }
};
