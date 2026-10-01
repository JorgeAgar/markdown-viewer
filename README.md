# Markdown Viewer

Prototipo de un visor de Markdown para Windows, Linux y macOS. Abre un archivo y muestra su contenido en una sola ventana de solo lectura.

La interfaz usa HTML, CSS y JavaScript sin frameworks ni dependencias de ejecución en JavaScript. Rust lee el archivo, convierte Markdown a HTML con `pulldown-cmark` y lo limpia con `ammonia`. Tauri 2 integra la ventana, los archivos y el navegador del sistema.

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

Necesitas Node.js 24, npm y Rust estable, además de los [requisitos de Tauri](https://v2.tauri.app/start/prerequisites/) para tu sistema. Windows necesita las herramientas de C++ y WebView2; macOS, las herramientas de Xcode; Linux, GTK y WebKitGTK.

En Ubuntu o Debian:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev libgtk-3-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

En la raíz del repositorio:

```sh
npm ci
npm run dev
```

Para abrir directamente un documento durante el desarrollo, pasa su ruta absoluta:

```sh
npm run dev -- -- /ruta/completa/archivo.md
```

## Compilación

```sh
npm run build:binary
npm run build
```

El primer comando genera el ejecutable optimizado en `src-tauri/target/release/`. El segundo también genera los paquetes de instalación admitidos por el sistema de compilación en `src-tauri/target/release/bundle/`.

Compila cada versión en su sistema correspondiente. El workflow de GitHub Actions compila Linux, Windows y macOS y guarda paquetes `.deb`, `.exe` y `.dmg` como artefactos. Los paquetes del prototipo no tienen firma de distribución ni notarización.

## Validación

```sh
npm test
npm run check
```

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
npm run build:binary
npm run benchmark -- examples/bienvenido.md 5
```

La medición comienza al entrar en `main` y termina tras dos llamadas a `requestAnimationFrame` después de insertar el documento. Es una aproximación al primer pintado del texto; no es una medición del compositor ni incluye la carga de todas las imágenes. El script también informa el tiempo desde la creación del proceso hasta su salida.

No se muestra una ventana de carga ni se espera por recursos de red para mostrar el texto. Las imágenes se cargan con `loading="lazy"`. Las imágenes locales se leen al convertir el documento, por lo que su tamaño sí afecta a la apertura.

La primera ejecución del script no garantiza cachés frías. Para comparar equipos, mide también después de reiniciar, usa el mismo archivo y registra sistema, CPU y tamaño del documento. En Linux sin pantalla puedes usar `xvfb-run -a dbus-run-session -- npm run benchmark`, pero esos resultados no representan una sesión de escritorio real.

## Límites del prototipo

- Archivos UTF-8 de hasta 16 MiB. Las imágenes locales tienen un límite de 8 MiB cada una y 32 MiB en total por documento.
- Las imágenes Markdown relativas deben estar dentro de la carpeta del documento o sus subcarpetas. Se rechazan rutas que escapen de ella y enlaces simbólicos hacia fuera.
- Las imágenes remotas requieren HTTPS y una conexión de red. El texto y las imágenes locales funcionan sin internet.
- Se elimina HTML activo. Los enlaces web y de correo se abren con la aplicación del sistema; los enlaces a otros archivos locales aún no se abren.
- Los bloques de código tienen formato monoespaciado, sin resaltado de sintaxis. No hay editor, pestañas, búsqueda, sincronización ni proceso residente.
- El prototipo requiere pruebas en equipos reales para comparar el tiempo de apertura entre los tres sistemas.
