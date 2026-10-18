import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkVersion } from './check-version.mjs';

function fixture(t, versions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'markdown-viewer-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src-tauri'));
  const version = (key) => versions[key] ?? '0.1.0';
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: version('node') }));
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: version('tauri') }));
  writeFileSync(join(root, 'src-tauri/Cargo.toml'), `[package]\nname = "markdown-viewer"\nversion = "${version('cargo')}"\n\n[dependencies]\nunrelated = { version = "2" }\n`);
  writeFileSync(join(root, 'src-tauri/Cargo.lock'), `version = 4\n\n[[package]]\nname = "another-crate"\nversion = "9.0.0"\n\n[[package]]\nname = "markdown-viewer"\nversion = "${version('lock')}"\n`);
  return root;
}

test('accepts synchronized versions with and without a matching tag', (t) => {
  const root = fixture(t);
  assert.equal(checkVersion(root), '0.1.0');
  assert.equal(checkVersion(root, 'v0.1.0'), '0.1.0');
});

for (const key of ['tauri', 'cargo', 'lock']) {
  test(`rejects a mismatched ${key} version`, (t) => {
    assert.throws(() => checkVersion(fixture(t, { [key]: '0.2.0' })), /se esperaba 0\.1\.0/);
  });
}

for (const tag of ['v0.2.0', '0.1.0', 'v0.1.0-beta.1', 'v01.1.0']) {
  test(`rejects tag ${tag}`, (t) => {
    assert.throws(() => checkVersion(fixture(t), tag), /se esperaba v0\.1\.0/);
  });
}

test('rejects invalid version formats', (t) => {
  for (const node of ['v0.1.0', '0.1.0-beta.1', '01.1.0', '0.1']) {
    assert.throws(() => checkVersion(fixture(t, { node })), /formato X.Y.Z/);
  }
});

test('does not read a dependency version as the package version', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "markdown-viewer"\n[dependencies]\nversion = "0.1.0"\n');
  assert.throws(() => checkVersion(root), /versión ausente/);
});
