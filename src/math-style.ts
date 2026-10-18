import { generate, ident, parse, walk } from 'css-tree';

const properties = new Set([
  'height', 'width', 'min-width', 'top', 'bottom', 'left', 'vertical-align',
  'margin', 'margin-left', 'margin-right', 'margin-top', 'padding-left',
  'color', 'background-color', 'position', 'text-shadow',
]);

/** Apply only passive formula geometry/colors, without parsing a style attribute. */
export function applyMathStyles(element: Element, css: string): void {
  const target = element as HTMLElement | SVGElement | MathMLElement;
  if (!target.style) return;
  const declarations = parse(css, { context: 'declarationList' });
  if (declarations.type !== 'DeclarationList') return;
  declarations.children.forEach(node => {
    if (node.type !== 'Declaration') return;
    if (!properties.has(node.property) && !/^border(?:-(?:top|right|bottom|left))?(?:-(?:width|style|color))?$/.test(node.property)) return;
    const value = generate(node.value);
    if (node.property === 'position' && value !== 'relative') return;
    let safe = true;
    walk(node.value, part => {
      if (part.type === 'Url' || part.type === 'Raw') safe = false;
      if (part.type === 'Function' && !['rgb', 'rgba', 'hsl', 'hsla'].includes(ident.decode(part.name).toLowerCase())) safe = false;
    });
    if (safe) target.style.setProperty(node.property, value);
  });
}

/** The build adapter routes KaTeX's MathML attribute writer through this helper. */
export function setMathAttribute(element: Element, name: string, value: string): void {
  if (name === 'style') applyMathStyles(element, value);
  else element.setAttribute(name, value);
}
