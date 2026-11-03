# Markdown Viewer para Linux

Build Linux x86_64 compilada en Ubuntu 22.04 y validada en Ubuntu y Arch Linux. Usa GTK y WebKitGTK del sistema; el tar no incluye esas bibliotecas. No necesitas Rust, Node.js ni pnpm para ejecutar la aplicación.

## Dependencias

Necesita glibc 2.35 o posterior, GTK 3 y WebKitGTK 4.1 (API con libsoup 3). No es un paquete estático ni sirve para distribuciones con musl, como Alpine.

En Ubuntu 22.04 o posterior y Debian 12 o posterior:

```sh
sudo apt-get install libwebkit2gtk-4.1-0
```

En Arch Linux actualizado:

```sh
sudo pacman -Syu --needed webkit2gtk-4.1
```

## Ejecutar sin instalar

Extrae el archivo `.tar.gz` y, desde la carpeta extraída, ejecuta:

```sh
./markdown-viewer /ruta/completa/documento.md
```

Sin argumento, el visor muestra el botón para elegir un archivo. También puedes usar `Ctrl+O` o arrastrar un archivo a la ventana.

## Instalar e integrar con el escritorio

Desde la carpeta extraída:

```sh
sudo install -Dm755 markdown-viewer /usr/local/bin/markdown-viewer
sudo install -Dm644 icon.png /usr/local/share/icons/hicolor/128x128/apps/markdown-viewer.png
sudo install -Dm644 markdown-viewer.desktop /usr/local/share/applications/markdown-viewer.desktop
sudo update-desktop-database /usr/local/share/applications
```

`update-desktop-database` pertenece al paquete `desktop-file-utils`. Instálalo con `sudo apt-get install desktop-file-utils` o `sudo pacman -S --needed desktop-file-utils` si el comando no está disponible.

El visor aparecerá en el menú de aplicaciones y en «Abrir con» para Markdown. El sistema decide la aplicación predeterminada; estos comandos no la cambian.

Para actualizar, repite los comandos de instalación con la nueva build. Para desinstalar:

```sh
sudo rm /usr/local/bin/markdown-viewer
sudo rm /usr/local/share/icons/hicolor/128x128/apps/markdown-viewer.png
sudo rm /usr/local/share/applications/markdown-viewer.desktop
sudo update-desktop-database /usr/local/share/applications
```
