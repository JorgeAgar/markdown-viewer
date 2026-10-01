import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
function compile() {
  execFileSync(process.execPath, [compiler, '--project', join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
}
compile();
copyAssets();

if (watching) {
  // Node watches the sources instead of tsc --watch: the native compiler's
  // Linux watcher requires filesystem support that Sprite does not provide.
  let timer;
  function scheduleCompile() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        compile();
        console.log('Frontend compiled. Watching for file changes.');
      } catch {
        // Keep the last valid JavaScript and retry when the sources change.
        console.error('TypeScript compilation failed. Watching for file changes.');
      }
    }, 100);
  }
  const watchers = [
    watch(source, { recursive: true }, (_event, filename) => {
      if (filename === null || filename.endsWith('.ts')) scheduleCompile();
      if (filename === null || assets.includes(filename)) copyAssets();
    }),
    watch(join(root, 'tsconfig.json'), scheduleCompile),
  ];
  console.log('Watching for file changes.');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    });
  }
}
