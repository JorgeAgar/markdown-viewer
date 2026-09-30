import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const binary = resolve(process.env.MD_VIEWER_BINARY || `src-tauri/target/release/markdown-viewer${process.platform === 'win32' ? '.exe' : ''}`);
const document = resolve(process.argv[2] || 'examples/bienvenido.md');
const runs = Number(process.argv[3] || 5);
if (!existsSync(binary)) throw new Error('Compila primero con npm run build:binary.');
if (!existsSync(document)) throw new Error('No existe el documento.');
if (!Number.isInteger(runs) || runs < 1 || runs > 100) throw new Error('Usa entre 1 y 100 aperturas.');

async function measure() {
  const start = performance.now();
  const child = spawn(binary, [document], {
    env: { ...process.env, MD_VIEWER_BENCHMARK: '1', MD_VIEWER_BENCHMARK_EXIT: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let output = '';
  const timeout = setTimeout(() => child.kill(), 30000);
  child.stderr.on('data', (chunk) => { output += chunk; });
  return new Promise((resolveResult, reject) => {
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const match = output.match(/MD_VIEWER_PAINT_MS=(\d+(?:\.\d+)?)/);
      if (code !== 0 || !match) return reject(new Error(`No se recibió la medición. Cierra cualquier instancia abierta del visor.\n${output}`));
      resolveResult({ textReadyMs: Number(match[1]), processMs: Number((performance.now() - start).toFixed(2)) });
    });
  });
}

const results = [];
for (let i = 0; i < runs; i++) {
  const result = await measure();
  results.push(result);
  console.log(`Apertura ${i + 1}: texto listo ${result.textReadyMs} ms; proceso completo ${result.processMs} ms`);
}
const sorted = results.map((result) => result.textReadyMs).sort((a, b) => a - b);
const middle = Math.floor(sorted.length / 2);
const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
console.log(`Mediana hasta texto listo: ${median.toFixed(2)} ms`);
console.log('La primera apertura no garantiza cachés frías del sistema. Mide también después de reiniciar en cada equipo objetivo.');
