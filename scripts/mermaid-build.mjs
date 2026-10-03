import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** Audited CSP insertion/serialization points in the pinned Mermaid and D3. */
export function mermaidCspPlugin() {
  return {
    name: 'mermaid-csp',
    setup(build) {
      const helper = fileURLToPath(new URL('../src/diagram-svg.ts', import.meta.url));
      let adaptedCore = false;
      let adaptedD3 = false;
      let adaptedLabels = false;
      function replaceOnce(source, before, after) {
        if (source.split(before).length !== 2) throw new Error('Cambió un punto de integración Mermaid/D3. Revisa el adaptador CSP antes de actualizar.');
        return source.replace(before, after);
      }
      build.onLoad({ filter: /[/\\]mermaid\.core\.mjs$/ }, async ({ path }) => {
        let source = await readFile(path, 'utf8');
        source = replaceOnce(source, 'style1.innerHTML = rules;', 'protectMermaidStyle(style1, rules, svg);');
        source = replaceOnce(source, 'let code = root.select(enclosingDivID_selector).node().innerHTML;', 'let code = serializeMermaidSvg(root.select(enclosingDivID_selector).node());');
        adaptedCore = true;
        return {
          contents: `import { protectMermaidStyle, serializeMermaidSvg } from ${JSON.stringify(helper)};\n` + source,
          loader: 'js',
          resolveDir: dirname(path),
        };
      });
      build.onLoad({ filter: /[/\\]d3-selection[/\\]src[/\\]selection[/\\]attr\.js$/ }, async ({ path }) => {
        let source = await readFile(path, 'utf8');
        source = replaceOnce(source, 'this.setAttribute(name, value);', 'setMermaidAttribute(this, name, value);');
        source = replaceOnce(source, 'this.setAttribute(name, v);', 'setMermaidAttribute(this, name, v);');
        adaptedD3 = true;
        return { contents: `import { setMermaidAttribute } from ${JSON.stringify(helper)};\n${source}`, loader: 'js', resolveDir: dirname(path) };
      });
      build.onLoad({ filter: /[/\\]mermaid[/\\]dist[/\\]chunks[/\\]mermaid\.core[/\\].*\.mjs$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const insertion = 'child.setAttribute("style", style);';
        if (!source.includes(insertion)) return;
        adaptedLabels = true;
        return { contents: `import { setMermaidAttribute } from ${JSON.stringify(helper)};\n` + replaceOnce(source, insertion, 'setMermaidAttribute(child, "style", style);'), loader: 'js', resolveDir: dirname(path) };
      });
      build.onEnd(() => {
        if (adaptedCore && (!adaptedD3 || !adaptedLabels)) return {
          errors: [{ text: 'Falta un punto de integración Mermaid/D3. Revisa el adaptador CSP antes de actualizar.' }],
        };
      });
    },
  };
}
