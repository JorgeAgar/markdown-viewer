import { execFileSync } from 'node:child_process';
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('Este paquete requiere una build Linux x86_64 compilada en Arch.');
}
if (!/^ID="?arch"?$/m.test(readFileSync('/etc/os-release', 'utf8'))) {
  throw new Error('Genera el paquete en Arch Linux para usar las bibliotecas de esa distribución.');
}

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const binary = join(root, 'src-tauri/target/release/markdown-viewer');
accessSync(binary, constants.X_OK);

const name = `markdown-viewer-${config.version}-arch-x86_64`;
const output = join(root, 'artifacts/packages');
const archive = join(output, `${name}.tar.gz`);
const temporary = mkdtempSync(join(tmpdir(), 'markdown-viewer-package-'));

try {
  const directory = join(temporary, name);
  mkdirSync(directory);
  copyFileSync(binary, join(directory, 'markdown-viewer'));
  chmodSync(join(directory, 'markdown-viewer'), 0o755);
  copyFileSync(join(root, 'src-tauri/icons/128x128.png'), join(directory, 'icon.png'));
  copyFileSync(join(root, 'packaging/arch/README.md'), join(directory, 'README.md'));

  const fields = {
    name: config.productName,
    comment: config.bundle.shortDescription,
    exec: 'markdown-viewer',
    icon: 'markdown-viewer',
    categories: `${config.bundle.category};`,
  };
  const desktop = readFileSync(join(root, 'assets/markdown-viewer.desktop'), 'utf8')
    .replace(/\{\{(\w+)\}\}/g, (_, field) => {
      if (!(field in fields)) throw new Error(`Campo .desktop desconocido: ${field}`);
      return fields[field];
    });
  writeFileSync(join(directory, 'markdown-viewer.desktop'), desktop);

  mkdirSync(output, { recursive: true });
  execFileSync('tar', ['-czf', archive, '-C', temporary, name], { stdio: 'inherit' });
  console.log(archive);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
