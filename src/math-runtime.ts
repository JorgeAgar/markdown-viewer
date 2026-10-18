import katex from 'katex';
import DOMPurify from 'dompurify';
import { applyMathStyles } from './math-style';

let stylesheet: Promise<void> | undefined;

export function loadStyles(): Promise<void> {
  return stylesheet ??= new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('katex/katex.min.css', document.baseURI).href;
    link.onload = () => { resolve(); };
    link.onerror = () => {
      link.remove();
      stylesheet = undefined;
      reject(new Error('No se pudieron cargar los estilos de KaTeX.'));
    };
    document.head.append(link);
  });
}

/** Sanitize in place, then restore passive styles through CSP-compatible CSSOM. */
export function sanitizeMath(root: HTMLElement): HTMLElement {
  const styles = new Map<Element, string>();
  for (const element of [root, ...root.querySelectorAll('[style]')]) {
    const css = element.getAttribute('style');
    element.removeAttribute('style');
    if (css) styles.set(element, css);
  }
  DOMPurify.sanitize(root, {
    IN_PLACE: true,
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    ADD_TAGS: ['annotation'],
    ADD_ATTR: ['encoding'],
    FORBID_TAGS: ['a', 'img', 'image', 'style', 'foreignObject', 'annotation-xml'],
    FORBID_ATTR: ['style', 'href', 'xlink:href', 'src', 'id'],
    ALLOW_DATA_ATTR: false,
  });
  for (const [element, css] of styles) {
    if (element !== root && !root.contains(element)) continue;
    applyMathStyles(element, css);
  }
  return root;
}

export function render(source: string, display: boolean): HTMLElement {
  const host = document.createElement('span');
  // render() creates nodes and assigns node.style properties; no HTML/style parsing
  // is inserted into the live document. Never serialize/reinsert the result.
  katex.render(source, host, {
    displayMode: display,
    output: 'htmlAndMathml',
    trust: false,
    throwOnError: true,
    strict: 'error',
    maxExpand: 1000,
    maxSize: 20,
    // Definitions belong to this formula, never another document or render order.
    macros: {},
  });
  return sanitizeMath(host);
}
