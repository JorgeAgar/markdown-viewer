import mermaid from 'mermaid';

let queue = Promise.resolve();

async function render({ id, source, dark }) {
  const workspace = document.createElement('div');
  workspace.className = 'mermaid-workspace';
  document.body.append(workspace);
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      fontFamily: 'Arial, sans-serif',
      theme: dark ? 'dark' : 'default',
      secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering',
        'maxTextSize', 'maxEdges', 'htmlLabels', 'flowchart', 'fontFamily',
        'theme', 'themeVariables', 'themeCSS', 'dompurifyConfig'],
    });
    const { svg } = await mermaid.render(`md-viewer-mermaid-${id}`, source, workspace);
    parent.postMessage({ type: 'mermaid-result', id, svg }, '*');
  } catch {
    parent.postMessage({ type: 'mermaid-result', id, error: true }, '*');
  } finally {
    workspace.remove();
  }
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (event.source !== parent || data?.type !== 'mermaid-render' || !Number.isSafeInteger(data.id)
    || typeof data.source !== 'string' || data.source.length > 50_000 || typeof data.dark !== 'boolean') return;
  queue = queue.then(() => render(data)).catch(() => {});
});
parent.postMessage({ type: 'mermaid-ready' }, '*');
