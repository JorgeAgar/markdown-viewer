# Markdown Viewer

Prototipo de un visor de Markdown para Windows, Linux y macOS. Abre un archivo y muestra su contenido en una sola ventana de solo lectura.

La interfaz usa HTML, CSS y TypeScript sin frameworks ni dependencias de ejecución en JavaScript. Rust lee el archivo, convierte Markdown a HTML con `pulldown-cmark` y lo limpia con `ammonia`. Tauri 2 integra la ventana, los archivos y el navegador del sistema.

## Documentación

En [`docs/arquitectura.md`](docs/arquitectura.md) se explica cómo funciona la app, con diagramas de sus componentes y del recorrido de un archivo. La carpeta `docs/` reúne la documentación del proyecto.

Los documentos de [la interfaz](docs/interfaz.md), [la coordinación en Rust](docs/coordinacion-rust.md) y [el procesamiento del documento](docs/procesamiento-documento.md) explican cada pieza con más detalle.

## Uso

- Abre un archivo con el botón, `Ctrl+O` o `⌘O` en macOS.
- Arrastra un archivo a la ventana.
- Pasa una ruta como argumento al ejecutable.
- Tras instalar, elige Markdown Viewer en "Abrir con" para archivos `.md`, `.markdown`, `.mdown` y `.mkd`. El sistema decide la aplicación predeterminada.

El visor admite tablas, listas de tareas, citas, bloques de código, notas al pie e imágenes. Usa el tema claro u oscuro del sistema. Una segunda apertura envía el archivo a la ventana existente; al cerrar la ventana, la aplicación termina.

## Desarrollo

Necesitas Node.js 24, pnpm y Rust estable, además de los [requisitos de Tauri](https://v2.tauri.app/start/prerequisites/) para tu sistema. Windows necesita las herramientas de C++ y WebView2; macOS, las herramientas de Xcode; Linux, GTK y WebKitGTK.

En Ubuntu o Debian:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev libgtk-3-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

En la raíz del repositorio:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Para abrir directamente un documento durante el desarrollo, pasa su ruta absoluta:

```sh
pnpm run dev -- /ruta/completa/archivo.md
```

`pnpm dev` prepara primero la interfaz y después inicia Tauri con recompilación de TypeScript y copia de HTML y CSS al editar. Tauri recarga la vista al cambiar los archivos generados.

Las fuentes viven en `src/`. TypeScript genera `dist/app.js` y el script `scripts/frontend.mjs` copia allí `index.html` y `style.css`. `dist/` se genera automáticamente y no se sube al repositorio.

## Compilación

```sh
pnpm build:binary
pnpm build
```

Ambos comandos preparan la interfaz mediante el hook `beforeBuildCommand` de Tauri. También puedes generar solo los archivos del frontend con `pnpm build:frontend`, sin compilar Rust.

El primer comando genera el ejecutable optimizado en `src-tauri/target/release/`. El segundo también genera los paquetes de instalación admitidos por el sistema de compilación en `src-tauri/target/release/bundle/`.

Compila cada versión en su sistema correspondiente. El workflow de GitHub Actions compila Linux, Windows y macOS y guarda paquetes `.deb`, `.exe` y `.dmg` como artefactos. Los paquetes del prototipo no tienen firma de distribución ni notarización.

## Validación

```sh
pnpm test
pnpm check
```

`pnpm check` prepara el frontend con comprobación de tipos y comprueba el formato y los avisos de Rust. `pnpm test` prepara el frontend, ejecuta sus pruebas de comportamiento y después las pruebas Rust, porque Tauri necesita los archivos para compilar. Para comprobar solo TypeScript, usa `pnpm check:frontend`.

`pnpm test:frontend` comprueba tipos y comportamiento de la interfaz sin compilar Rust ni arrancar Tauri. Las pruebas ejecutan el JavaScript de producción en jsdom con el HTML de la app y respuestas controladas de Tauri. Cubren aperturas simultáneas, cancelación y errores del selector, recuperación de los botones, archivos pendientes durante el arranque y respuestas tardías de la medición de pintado. Los documentos y el sustituto de Tauri usan los tipos de `src/tauri.d.ts`. jsdom y sus tipos son dependencias de desarrollo; no se incluyen en la aplicación.

`src/tauri.d.ts` se genera a partir de los comandos registrados en `src-tauri/src/main.rs`, sus argumentos y resultados, los campos de `Document` con `Serialize` y las emisiones de eventos propios. `pnpm check:ipc` compara la declaración guardada con Rust y ejecuta pruebas que introducen cambios incompatibles. También forma parte de `pnpm check` y `pnpm test`. Esta herramienta compila un crate pequeño con `syn`; no compila Tauri ni necesita GTK o WebKit.

Al cambiar el contrato, ejecuta `pnpm generate:ipc` y añade la declaración generada a la misma PR. Los argumentos inyectados por Tauri, como `AppHandle` y `State`, no aparecen en JavaScript. Los nombres de los argumentos siguen el `camelCase` predeterminado de Tauri. `Result<T, String>` produce una promesa de `T`; el error rechaza la promesa.

El generador analiza la sintaxis Rust de los dos archivos actuales. Admite los tipos usados por el proyecto y eventos emitidos con un nombre literal y payload `()`, que se serializa como `null`. Falla ante tipos desconocidos, atributos de serialización o condicionales sobre `Document`, sus campos o los comandos, y opciones de `tauri::command`. También rechaza las otras variantes directas de `Emitter` y las llamadas asociadas a esos métodos. Antes de introducirlos hay que ampliar el generador y sus pruebas. No expande macros ni resuelve tipos como el compilador, y no comprueba datos en ejecución.

Los eventos `tauri://drag-*` proceden de Tauri 2. Sus declaraciones y la API global están en `scripts/ipc-contract/tauri-globals.d.ts`; el generador las conserva, pero no las deriva de Rust del proyecto. Al actualizar Tauri se deben contrastar con su [API de arrastre](https://docs.rs/tauri/latest/tauri/webview/enum.DragDropEvent.html). La interfaz comprueba que los elementos esperados existen y tienen el tipo adecuado antes de usarlos.

Las pruebas cubren el renderizado, la limpieza de HTML activo, rutas con espacios y Unicode, archivos inválidos, límites de tamaño e imágenes locales fuera de la carpeta del documento.

En Linux, `scripts/smoke.py` prueba la aplicación compilada dentro de su WebView, incluyendo una segunda apertura, imágenes, el selector nativo y manejo de errores. Requiere `tauri-driver`, `WebKitWebDriver`, Xvfb y xdotool:

```sh
cargo install tauri-driver --locked
sudo apt-get install -y webkit2gtk-driver xvfb xdotool
xvfb-run -a dbus-run-session -- python3 scripts/smoke.py
```

El paquete del driver se llama `webkitgtk-webdriver` en versiones recientes de Ubuntu. Las capturas y los registros de la prueba quedan en `artifacts/`, que no se sube al repositorio.

## Medición de apertura

Cierra cualquier instancia abierta y compila en modo release:

```sh
pnpm build:binary
pnpm benchmark examples/bienvenido.md 5
```

La medición comienza al entrar en `main` y termina tras dos llamadas a `requestAnimationFrame` después de insertar el documento. Es una aproximación al primer pintado del texto; no es una medición del compositor ni incluye la carga de todas las imágenes. El script también informa el tiempo desde la creación del proceso hasta su salida.

No se muestra una ventana de carga ni se espera por recursos de red para mostrar el texto. Las imágenes se cargan con `loading="lazy"`. Las imágenes locales se leen al convertir el documento, por lo que su tamaño sí afecta a la apertura.

La primera ejecución del script no garantiza cachés frías. Para comparar equipos, mide también después de reiniciar, usa el mismo archivo y registra sistema, CPU y tamaño del documento. En Linux sin pantalla puedes usar `xvfb-run -a dbus-run-session -- pnpm run benchmark`, pero esos resultados no representan una sesión de escritorio real.

## Límites del prototipo

- Archivos UTF-8 de hasta 16 MiB. Las imágenes locales tienen un límite de 8 MiB cada una y 32 MiB en total por documento.
- Las imágenes Markdown relativas deben estar dentro de la carpeta del documento o sus subcarpetas. Se rechazan rutas que escapen de ella y enlaces simbólicos hacia fuera.
- Las imágenes remotas requieren HTTPS y una conexión de red. El texto y las imágenes locales funcionan sin internet.
- Se elimina HTML activo. Los enlaces web y de correo se abren con la aplicación del sistema; los enlaces a otros archivos locales aún no se abren.
- Los bloques de código tienen formato monoespaciado, sin resaltado de sintaxis. No hay editor, pestañas, búsqueda, sincronización ni proceso residente.
- El prototipo requiere pruebas en equipos reales para comparar el tiempo de apertura entre los tres sistemas.
