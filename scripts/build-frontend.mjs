import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Build from a stable directory even when invoked outside the repository root.
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
await rm('dist', { recursive: true, force: true });
await mkdir('dist/vendor', { recursive: true });
await Promise.all(['index.html', 'app.js', 'style.css'].map((name) => copyFile(`src/${name}`, `dist/${name}`)));
await build({
  entryPoints: { mermaid: 'src/mermaid.js' },
  outdir: 'dist/vendor',
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  legalComments: 'linked',
  logLevel: 'warning',
});
// A classic script can load inside an opaque sandbox origin without relaxing
// CORS for any of Tauri's assets. The full renderer is still loaded on demand.
await build({
  entryPoints: { 'mermaid-frame': 'src/mermaid-frame.js' },
  outdir: 'dist/vendor',
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  legalComments: 'linked',
  logLevel: 'warning',
});
await copyFile('node_modules/mermaid/LICENSE', 'dist/vendor/MERMAID-LICENSE.txt');
