import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { katexCspPlugin } from './katex-build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('../tests/fixtures/mermaid-renderer.ts', import.meta.url));
const mathFixture = fileURLToPath(new URL('../tests/fixtures/math-renderer.ts', import.meta.url));
const syntaxFixture = fileURLToPath(new URL('../tests/fixtures/syntax-renderer.ts', import.meta.url));
const options = { absWorkingDir: root, bundle: true, format: 'iife', platform: 'browser', target: 'es2020' };

// Exercise the real entry/controller with a controlled asynchronous renderer.
await build({
  ...options,
  entryPoints: ['src/app.ts'],
  outfile: 'artifacts/test-app.js',
  plugins: [{ name: 'controlled-renderer', setup(builder) {
    builder.onResolve({ filter: /^\.\/mermaid-runtime$/ }, () => ({ path: fixture }));
    builder.onResolve({ filter: /^\.\/math-runtime$/ }, () => ({ path: mathFixture }));
    builder.onResolve({ filter: /^\.\/syntax-runtime$/ }, () => ({ path: syntaxFixture }));
  } }],
});
await build({ ...options, entryPoints: ['src/mermaid.ts'], outfile: 'artifacts/test-mermaid.js', globalName: 'MermaidTest', external: ['./mermaid-runtime'] });
await build({ ...options, entryPoints: ['src/diagram-svg.ts'], outfile: 'artifacts/test-svg.js', globalName: 'SvgTest' });
await build({ ...options, entryPoints: ['src/math.ts'], outfile: 'artifacts/test-math.js', globalName: 'MathTest', external: ['./math-runtime'] });
await build({ ...options, entryPoints: ['src/math-runtime.ts'], outfile: 'artifacts/test-math-runtime.js', globalName: 'MathRuntimeTest', plugins: [katexCspPlugin()] });
await build({ ...options, entryPoints: ['src/syntax.ts'], outfile: 'artifacts/test-syntax.js', globalName: 'SyntaxTest', external: ['./syntax-runtime'] });
await build({ ...options, entryPoints: ['src/syntax-runtime.ts'], outfile: 'artifacts/test-syntax-runtime.js', globalName: 'SyntaxRuntimeTest' });
