import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('../tests/fixtures/mermaid-renderer.ts', import.meta.url));
const options = { absWorkingDir: root, bundle: true, format: 'iife', platform: 'browser', target: 'es2020' };

// Exercise the real entry/controller with a controlled asynchronous renderer.
await build({
  ...options,
  entryPoints: ['src/app.ts'],
  outfile: 'artifacts/test-app.js',
  plugins: [{ name: 'controlled-renderer', setup(builder) {
    builder.onResolve({ filter: /^\.\/mermaid-runtime$/ }, () => ({ path: fixture }));
  } }],
});
await build({ ...options, entryPoints: ['src/mermaid.ts'], outfile: 'artifacts/test-mermaid.js', globalName: 'MermaidTest', external: ['./mermaid-runtime'] });
await build({ ...options, entryPoints: ['src/diagram-svg.ts'], outfile: 'artifacts/test-svg.js', globalName: 'SvgTest' });
