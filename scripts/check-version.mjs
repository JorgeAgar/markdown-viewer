import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkVersion(root, tag) {
  const read = (path) => readFileSync(resolve(root, path), 'utf8');
  const packageVersion = JSON.parse(read('package.json')).version;
  const tauriVersion = JSON.parse(read('src-tauri/tauri.conf.json')).version;
  const cargoPackage = read('src-tauri/Cargo.toml').split(/(?=^\[)/m)
    .find((section) => section.startsWith('[package]'));
  const cargoVersion = cargoPackage?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const lockPackage = read('src-tauri/Cargo.lock').split('[[package]]')
    .find((entry) => /^name = "markdown-viewer"$/m.test(entry));
  const lockVersion = lockPackage?.match(/^version = "([^"]+)"$/m)?.[1];
  const versions = {
    'package.json': packageVersion,
    'src-tauri/tauri.conf.json': tauriVersion,
    'src-tauri/Cargo.toml': cargoVersion,
    'src-tauri/Cargo.lock': lockVersion,
  };
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageVersion ?? '')) {
    throw new Error('La versión debe tener el formato X.Y.Z, sin prefijo v ni prerelease.');
  }
  for (const [path, version] of Object.entries(versions)) {
    if (version !== packageVersion) {
      throw new Error(`${path}: versión ${version ?? 'ausente'}; se esperaba ${packageVersion}.`);
    }
  }
  if (tag !== undefined && tag !== `v${packageVersion}`) {
    throw new Error(`Tag ${tag}: se esperaba v${packageVersion}.`);
  }
  return packageVersion;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  console.log(checkVersion(root, process.argv[2]));
}
