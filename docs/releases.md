# Publicar una versión

Las releases se preparan mediante una PR a `main` y se publican al subir un tag de Git con formato `vX.Y.Z`. No se necesita una rama permanente de releases. Una etiqueta de PR o escribir `v0.2.0` en un commit no dispara la publicación.

## Preparar la PR

1. Crea una rama desde `main` actualizado, por ejemplo `release/0.2.0`.
2. Actualiza la versión, sin el prefijo `v`, en `package.json`, `src-tauri/tauri.conf.json` y la sección `[package]` de `src-tauri/Cargo.toml`.
3. Ejecuta `cargo check --manifest-path src-tauri/Cargo.toml` para actualizar y comprobar el lockfile. Incluye el cambio de versión del paquete propio en `src-tauri/Cargo.lock`; no hace falta actualizar las dependencias con `cargo update`.
4. Añade `docs/releases/X.Y.Z.md` con funciones, cambios, formatos de descarga y límites conocidos. Ese archivo será el cuerpo de la release.
5. Ejecuta `pnpm check:version`, `pnpm check` y `pnpm test`. Abre la PR y espera a que pase el CI antes de fusionar.

El comprobador compara también la versión del lockfile de Cargo. Las releases actuales admiten versiones estables `X.Y.Z`; no admiten sufijos de prerelease como `-beta.1`. Mientras la app esté en `0.x`, acuerda y explica los cambios incompatibles en las notas de cada versión.

No uses `[skip ci]` al preparar una release: es importante validar la versión que se distribuirá.

## Crear el tag

Después de fusionar la PR y comprobar que los checks del commit elegido han pasado, actualiza tu referencia remota y revisa ese commit:

```sh
git fetch origin main --tags
git show --stat origin/main
git status --short
```

Con el árbol de trabajo limpio, revisa la versión y las notas del commit que vas a etiquetar. Para publicar el último commit de `main`:

```sh
git switch --detach origin/main
pnpm check:version
node scripts/check-version.mjs v0.2.0
git tag -a v0.2.0 -m "Markdown Viewer v0.2.0" HEAD
git push origin refs/tags/v0.2.0
```

Sustituye `v0.2.0` por la versión elegida. Esto sube únicamente el tag; los cambios de código ya llegaron a `main` mediante la PR. También puedes etiquetar el SHA concreto del merge si `main` avanzó después, siempre que contenga los workflows de release y la versión preparada. No muevas ni reutilices tags publicados: una corrección se distribuye como una nueva versión.

## Qué hace GitHub Actions

El workflow `Release desktop` de `.github/workflows/release.yml`:

1. Comprueba que las cuatro versiones coinciden con el tag, que las notas existen y que el commit pertenece al historial de `main`.
2. Llama al mismo workflow `Build desktop` usado por el CI, desde el commit etiquetado. Ejecuta checks, pruebas, empaquetado y validaciones de Linux, incluidos los benchmarks de arranque.
3. Descarga los cuatro paquetes: `.deb`, `.exe`, `.dmg` y `.tar.gz` de Arch. No adjunta los registros de validación como instaladores.
4. Genera `SHA256SUMS`, crea una release en borrador, sube los archivos y la publica como la más reciente solo si todo lo anterior tuvo éxito.

Los builds tienen permisos de lectura. Solo el job de publicación recibe `contents: write`, mediante el `GITHUB_TOKEN` del repositorio. No requiere un token personal ni nuevos secretos. El repositorio debe permitir GitHub Actions y estos permisos de escritura para el job de publicación.

Las arquitecturas actuales son Windows x86_64, Linux x86_64 y macOS Apple Silicon (arm64); no se genera un paquete para Mac Intel. Publicar los instaladores no configura actualizaciones automáticas dentro de la app ni añade firmas de distribución o notarización.

## Comprobar y recuperar una publicación

En GitHub, abre **Actions → Release desktop** y comprueba el run del tag. Con GitHub CLI:

```sh
gh run list --workflow release.yml
gh release view v0.2.0
gh release download v0.2.0 --dir /tmp/markdown-viewer-0.2.0
cd /tmp/markdown-viewer-0.2.0
sha256sum --check SHA256SUMS
```

Usa un directorio de descarga nuevo. En macOS puedes comprobar las sumas con `shasum -a 256 -c SHA256SUMS`.

Si falla un build, no se publica la release. Corrige problemas transitorios y usa **Re-run failed jobs** en Actions, o `gh run rerun RUN_ID --failed`. Si falló la subida, el reintento reutiliza el borrador y reemplaza sus archivos antes de publicarlo. Si los artefactos han caducado, vuelve a ejecutar todos los jobs con `gh run rerun RUN_ID`.

Un reintento no modifica una release que ya está publicada. Si el fallo requiere cambios en el código o los workflows del tag, prepara otra versión mediante PR y un tag nuevo. No publiques manualmente un borrador incompleto.

Los tags subidos por una persona mediante Git o GitHub CLI disparan este workflow. Si en el futuro los crea otro workflow con `GITHUB_TOKEN`, ese push no dispara automáticamente un segundo workflow: habrá que conectar explícitamente los jobs de publicación o configurar otra autenticación.
