import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fixtures, parseMeasurement, statistics } from './benchmark-metrics.mjs';

const binary = resolve(process.env.MD_VIEWER_BINARY || `src-tauri/target/release/markdown-viewer${process.platform === 'win32' ? '.exe' : ''}`);
const runs = Number(process.argv[3] || 5);
if (!existsSync(binary)) throw new Error('Compila primero con pnpm build:binary.');
if (!Number.isInteger(runs) || runs < 1 || runs > 100) throw new Error('Usa entre 1 y 100 aperturas.');
const directory = mkdtempSync(join(tmpdir(), 'md-viewer-benchmark-'));
const documents = process.argv[2] && process.argv[2] !== '--suite'
  ? { custom: resolve(process.argv[2]) }
  : Object.fromEntries(Object.entries(fixtures).map(([name, text]) => {
    const path = join(directory, `${name}.md`);
    writeFileSync(path, text);
    return [name, path];
  }));

async function measure(document) {
  const start = performance.now();
  const child = spawn(binary, [document], {
    env: { ...process.env, MD_VIEWER_BENCHMARK: '1', MD_VIEWER_BENCHMARK_EXIT: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let output = '';
  const timeout = setTimeout(() => child.kill(), 30000);
  child.stderr.on('data', chunk => { output += chunk; });
  return new Promise((resolveResult, reject) => {
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      try {
        if (code !== 0) throw new Error(`Exit ${code}`);
        resolveResult({ ...parseMeasurement(output), process_ms: performance.now() - start });
      } catch (error) {
        reject(new Error(`No se recibió la medición. Cierra cualquier instancia abierta del visor. ${error}\n${output}`));
      }
    });
  });
}
function numericFields(value, prefix = '') {
  return Object.entries(value).flatMap(([key, item]) => {
    const name = prefix + key;
    if (key.endsWith('_ms') && typeof item === 'number') return [[name, item]];
    if (item && typeof item === 'object') return numericFields(item, `${name}.`);
    return [];
  });
}
try {
  console.log('Procesos nuevos, secuenciales; sin garantía de cachés frías. Doble rAF = oportunidad de pintado, no pintado real.');
  console.log(`Plataforma: ${process.platform}/${process.arch}; binario: ${binary}; repeticiones por muestra: ${runs}`);
  for (const [name, document] of Object.entries(documents)) {
    if (!existsSync(document)) throw new Error(`No existe ${document}`);
    const results = [];
    for (let i = 0; i < runs; i++) {
      const result = await measure(document);
      results.push(result);
      console.log(JSON.stringify({ sample: name, run: i + 1, ...result }));
    }
    const fields = new Map();
    for (const result of results) for (const [key, value] of numericFields(result)) {
      if (!fields.has(key)) fields.set(key, []);
      fields.get(key).push(value);
    }
    console.log(JSON.stringify({ sample: name, statistics_ms: Object.fromEntries([...fields].map(([key, values]) => [key, statistics(values)])) }));
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
