import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** KaTeX 0.19's MathML writer uses a style attribute for fcolorbox. */
export function katexCspPlugin() {
  return {
    name: 'katex-csp',
    setup(build) {
      const helper = fileURLToPath(new URL('../src/math-style.ts', import.meta.url));
      const entry = fileURLToPath(import.meta.resolve('katex'));
      build.onLoad({ filter: /[/\\]katex[/\\]dist[/\\]katex\.mjs$/ }, async ({ path }) => {
        // Mermaid has its own pinned KaTeX dependency; adapt only our renderer.
        if (path !== entry) return;
        const source = await readFile(path, 'utf8');
        const before = 'node.setAttribute(attr, value);';
        if (source.split(before).length !== 2) throw new Error('Cambió el punto de integración MathML de KaTeX. Revisa el adaptador CSP antes de actualizar.');
        return {
          contents: `import { setMathAttribute } from ${JSON.stringify(helper)};\n` + source.replace(before, 'setMathAttribute(node, attr, value);'),
          loader: 'js',
          resolveDir: dirname(path),
        };
      });
    },
  };
}
