import DOMPurify from 'dompurify';
import { generate, ident, parse, walk, type CssNode, type Declaration } from 'css-tree';

// Read from the trusted head, never from the document being displayed.
const styleNonce = document.head.querySelector<HTMLStyleElement>('#mermaid-style-nonce')?.nonce ?? '';
const svgNamespace = 'http://www.w3.org/2000/svg';
const renderedStyles = new Map<string, string>();
const properties = new Set([
  'color', 'background-color', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'text-decoration', 'dominant-baseline', 'alignment-baseline', 'letter-spacing',
  'word-spacing', 'white-space', 'display', 'visibility', 'overflow', 'paint-order',
  'marker-start', 'marker-mid', 'marker-end', 'rx', 'ry', '--mermaid-font-family',
]);
const presentationProperties = new Set([...properties].filter(name => ![
  'background-color', 'display', 'overflow', '--mermaid-font-family',
].includes(name)));

function safeValue(value: CssNode): boolean {
  let safe = true;
  walk(value, node => {
    if (node.type === 'Raw' || node.type === 'Atrule') safe = false;
    if (node.type === 'Url' && !/^#[\w-]+$/.test(node.value)) safe = false;
    if (node.type === 'Function' && !['rgb', 'rgba', 'hsl', 'hsla', 'calc', 'var'].includes(ident.decode(node.name).toLowerCase())) safe = false;
  });
  return safe;
}

function safeDeclaration(node: CssNode): node is Declaration {
  return node.type === 'Declaration' && properties.has(node.property) && safeValue(node.value);
}

/** Only descendant rules rooted in this SVG and passive drawing properties survive. */
export function sanitizeDiagramCss(css: string, rootId: string, ids?: Map<string, string>): string {
  const ast = parse(css, { context: 'stylesheet', parseCustomProperty: true });
  if (ast.type !== 'StyleSheet') throw new Error('Estilos de diagrama inválidos.');
  ast.children.forEach((rule, item, list) => {
    if (rule.type !== 'Rule' || rule.prelude.type !== 'SelectorList') {
      list.remove(item);
      return;
    }
    let scoped = true;
    rule.prelude.children.forEach(selector => {
      if (selector.type !== 'Selector' || selector.children.first?.type !== 'IdSelector' || selector.children.first.name !== rootId) scoped = false;
    });
    walk(rule.prelude, node => {
      if (node.type === 'Raw' || (node.type === 'Combinator' && node.name !== ' ' && node.name !== '>')) scoped = false;
      if (node.type === 'IdSelector' && ids?.has(node.name)) node.name = ids.get(node.name)!;
    });
    if (!scoped) {
      list.remove(item);
      return;
    }
    rule.block.children.forEach((node, declarationItem, declarations) => {
      if (!safeDeclaration(node)) declarations.remove(declarationItem);
      else if (ids) rewriteCssReferences(node.value, ids);
    });
  });
  return generate(ast);
}

function rewriteCssReferences(value: CssNode, ids: Map<string, string>): void {
  walk(value, node => {
    if (node.type === 'Url') {
      const replacement = ids.get(node.value.slice(1));
      // Unknown local references cannot target elements in another diagram.
      node.value = replacement ? `#${replacement}` : '#mermaid-missing-reference';
    }
  });
}

/** Called by the build adapter before Mermaid connects its temporary style element. */
export function protectMermaidStyle(style: HTMLStyleElement, css: string, svg: SVGElement): void {
  const filtered = sanitizeDiagramCss(css, svg.id);
  style.nonce = styleNonce;
  style.textContent = filtered;
}

/** D3 writes drawing styles through CSSOM, which does not require unsafe-inline. */
export function setMermaidAttribute(element: Element, name: string, value: unknown): void {
  if (name !== 'style') {
    element.setAttribute(name, String(value));
    return;
  }
  const target = element as HTMLElement | SVGElement;
  target.removeAttribute('style');
  const declarations = parse(String(value ?? ''), { context: 'declarationList' });
  if (declarations.type === 'DeclarationList') declarations.children.forEach(node => {
    if (safeDeclaration(node)) target.style.setProperty(node.property, generate(node.value));
  });
}

function removeInlineStyle(element: Element): void {
  const css = element.getAttribute('style');
  element.removeAttribute('style');
  if (!css) return;
  const declarations = parse(css, { context: 'declarationList' });
  if (declarations.type === 'DeclarationList') declarations.children.forEach(node => {
    if (safeDeclaration(node) && presentationProperties.has(node.property)) {
      element.setAttribute(node.property, generate(node.value));
    }
  });
}

/** Keep CSS outside serialization: DOMPurify's clones would lose Tauri's nonce. */
export function serializeMermaidSvg(container: Element): string {
  const svg = container.querySelector('svg')!;
  const styles = [...svg.querySelectorAll('style')];
  renderedStyles.set(svg.id, styles.map(style => style.textContent ?? '').join('\n'));
  styles.forEach(style => style.remove());
  for (const element of [svg, ...svg.querySelectorAll('[style]')]) removeInlineStyle(element);
  return container.innerHTML;
}

export function takeMermaidStyles(id: string): string {
  const css = renderedStyles.get(id) ?? '';
  renderedStyles.delete(id);
  return css;
}

export function sanitizeDiagramSvg(source: string, stylesheet = ''): SVGSVGElement {
  // XML parsing is inert. Remove styles before any HTML sanitizer clone can
  // connect a stylesheet without its nonce or copy a forbidden style attribute.
  if (/<!DOCTYPE/i.test(source)) throw new Error('El SVG no admite declaraciones DOCTYPE.');
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) throw new Error('El resultado SVG no es válido.');
  const styles = [...parsed.querySelectorAll('style')];
  stylesheet += '\n' + styles.map(style => style.textContent ?? '').join('\n');
  styles.forEach(style => style.remove());
  for (const element of parsed.querySelectorAll('[style]')) removeInlineStyle(element);
  const fragment = DOMPurify.sanitize(new XMLSerializer().serializeToString(parsed.documentElement), {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'script', 'image', 'feImage', 'animate', 'animateMotion', 'animateTransform', 'set'],
    FORBID_ATTR: ['tabindex'],
    RETURN_DOM_FRAGMENT: true,
  });
  const svg = fragment.firstElementChild;
  if (!(svg instanceof SVGSVGElement) || fragment.childElementCount !== 1 || svg.namespaceURI !== svgNamespace) {
    throw new Error('El resultado no es un diagrama SVG válido.');
  }
  const rootId = svg.id;
  if (!/^mermaid-diagram-\d+$/.test(rootId)) throw new Error('Identificador SVG inválido.');
  const ids = new Map<string, string>([[rootId, rootId]]);
  for (const element of svg.querySelectorAll('[id]')) {
    const oldId = element.id;
    const newId = `${rootId}-node-${ids.size}`;
    if (ids.has(oldId)) throw new Error('Identificadores duplicados en el diagrama.');
    ids.set(oldId, newId);
    element.id = newId;
  }
  for (const link of svg.querySelectorAll('a')) link.replaceWith(...link.childNodes);
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name === 'href' || attribute.name === 'xlink:href') {
        const replacement = ids.get(attribute.value.slice(1));
        if (attribute.value.startsWith('#') && replacement) element.setAttribute(attribute.name, `#${replacement}`);
        else element.removeAttribute(attribute.name);
      } else if (['aria-labelledby', 'aria-describedby'].includes(attribute.name)) {
        const references = attribute.value.split(/\s+/).map(id => ids.get(id)).filter(Boolean);
        if (references.length) element.setAttribute(attribute.name, references.join(' '));
        else element.removeAttribute(attribute.name);
      } else if (properties.has(attribute.name) || ['filter', 'clip-path', 'mask'].includes(attribute.name) || /url\s*\(/i.test(attribute.value)) {
        const value = parse(attribute.value, { context: 'value' });
        if (!safeValue(value)) element.removeAttribute(attribute.name);
        else {
          rewriteCssReferences(value, ids);
          element.setAttribute(attribute.name, generate(value));
        }
      }
    }
  }
  if (stylesheet.trim()) {
    const style = document.createElementNS(svgNamespace, 'style');
    style.nonce = styleNonce;
    style.textContent = sanitizeDiagramCss(stylesheet, rootId, ids);
    svg.prepend(style);
  }
  // Natural width keeps a large diagram readable inside the scroll container.
  const dimensions = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!dimensions || dimensions.length !== 4 || dimensions.some(value => !Number.isFinite(value)) || dimensions[2]! <= 0 || dimensions[3]! <= 0) {
    throw new Error('El diagrama no tiene dimensiones válidas.');
  }
  svg.setAttribute('width', String(dimensions[2]));
  svg.setAttribute('height', String(dimensions[3]));
  svg.setAttribute('role', 'img');
  if (!svg.querySelector('title')) {
    const title = document.createElementNS(svgNamespace, 'title');
    title.id = `${rootId}-title`;
    title.textContent = 'Diagrama Mermaid';
    svg.prepend(title);
    svg.setAttribute('aria-labelledby', title.id);
  }
  return svg;
}
