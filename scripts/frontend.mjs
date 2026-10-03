import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { mermaidCspPlugin } from './mermaid-build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'src');
const output = join(root, 'dist');
const compiler = join(dirname(fileURLToPath(import.meta.resolve('typescript/package.json'))), 'bin', 'tsc');
const watching = process.argv.includes('--watch');
const assets = ['index.html', 'style.css'];

function copyAssets() {
  for (const asset of assets) copyFileSync(join(source, asset), join(output, asset));
}

// A release build always starts clean so deleted sources cannot remain bundled.
// Development preserves the initial build prepared before Tauri starts.
if (!watching) rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
async function compile() {
  execFileSync(process.execPath, [compiler, '--project', join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
  await build({
    entryPoints: [join(source, 'app.ts')],
    outdir: output,
    entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: !watching,
    plugins: [mermaidCspPlugin()],
  });
}
await compile();
copyAssets();

if (watching) {
  // Node watches the sources instead of tsc --watch: the native compiler's
  // Linux watcher requires filesystem support that Sprite does not provide.
  let timer;
  let compiling = false;
  let pending = false;
  async function recompile() {
    if (compiling) { pending = true; return; }
    compiling = true;
    try {
      await compile();
      console.log('Frontend compiled. Watching for file changes.');
    } catch {
      // Keep the last valid JavaScript and retry when the sources change.
      console.error('TypeScript or bundle failed. Watching for file changes.');
    } finally {
      compiling = false;
      if (pending) { pending = false; scheduleCompile(); }
    }
  }
  function scheduleCompile() {
    clearTimeout(timer);
    timer = setTimeout(recompile, 100);
  }
  const watchers = [
    watch(source, { recursive: true }, (_event, filename) => {
      if (filename === null || filename.endsWith('.ts')) scheduleCompile();
      if (filename === null || assets.includes(filename)) copyAssets();
    }),
    watch(join(root, 'tsconfig.json'), scheduleCompile),
    watch(join(root, 'scripts/mermaid-build.mjs'), scheduleCompile),
  ];
  console.log('Watching for file changes.');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    });
  }
}
