# Imágenes locales después del texto

La apertura devuelve el HTML saneado antes de consultar, leer o codificar las imágenes Markdown locales. El campo `id` identifica cada apertura. Rust conserva sus orígenes en una lista privada y devuelve marcadores `#local-image-ID-ÍNDICE`; el comando de imágenes recibe solo el identificador y el índice, nunca una ruta elegida por JavaScript.

La interfaz activa las referencias de la respuesta que acepta. Una respuesta descartada no invalida las imágenes del documento que sigue visible. Rust conserva como máximo la apertura activa y una candidata. Cuando la interfaz activa otra apertura, las referencias anteriores dejan de admitir solicitudes nuevas. Una lectura que ya empezó puede terminar, pero su respuesta no se inserta en el documento nuevo.

`LocalImageController` sustituye los marcadores por texto alternativo antes de mostrar el artículo. Después de dos llamadas a `requestAnimationFrame`, inicia una cola con hasta dos solicitudes pendientes en toda la ventana, incluidas las de aperturas anteriores. Cada vez que libera un hueco, da prioridad a los marcadores visibles en el lector. Solicita también las imágenes fuera de pantalla; no espera a que el usuario las alcance.

Rust ejecuta la resolución en `spawn_blocking`. Un bloqueo por apertura serializa sus lecturas y mantiene exacto el presupuesto compartido de 32 MiB. Cada aparición puede leer hasta 8 MiB y consume presupuesto por sus bytes originales. Una referencia se solicita una sola vez; las apariciones repetidas del mismo archivo tienen índices distintos y consumen presupuesto por separado.

La ruta se resuelve respecto a la carpeta canónica del Markdown, guardada al abrirlo. Rust vuelve a comprobar la ubicación real de cada imagen antes de leerla. Rechaza escapes hacia fuera con `..` o enlaces simbólicos, rutas absolutas, `file://` y extensiones no admitidas. También rechaza un cambio de la carpeta original por un enlace simbólico hacia otra ubicación. Las imágenes HTTPS conservan su política de carga en el WebView y no consumen el presupuesto local.

Los fallos de lectura, tamaño o decodificación afectan solo a su imagen y conservan el texto alternativo. El marcador reserva una línea y conserva dimensiones explícitas si existen en el elemento. Markdown no aporta las dimensiones naturales de sus imágenes; conocerlas requeriría consultar el archivo. Al aparecer esas imágenes todavía puede cambiar la altura del contenido.

`data-ready-ms` conserva la medición del texto desde la entrada en `main`. La interfaz envía ese aviso antes de iniciar las solicitudes de imágenes. `data-images-resolved-ms` mide por separado la cola local, desde su inicio hasta completar las respuestas de Rust. Esta segunda medida incluye esperas, lectura y Base64; no incluye la decodificación ni el pintado de las imágenes.

## Pruebas y medición

Las pruebas Rust comprueban rutas con espacios y Unicode, escapes, enlaces simbólicos, límites individuales y presupuesto acumulado con solicitudes concurrentes. Una prueba crea la imagen después de que `load` haya devuelto el HTML. Otras comprueban identificadores inválidos, respuestas de aperturas obsoletas y activación por la interfaz.

Las pruebas de interfaz retienen las respuestas de imágenes mientras completan el pintado controlado y `content_painted`. Comprueban carga progresiva, prioridad visible, interacción con el lector, cambio de documento, cancelación del selector y fallos aislados. La prueba nativa en `pnpm test:e2e` retiene las solicitudes antes de llamar a Rust, comprueba el texto visible y crea después una imagen SVG con espacios y Unicode en su nombre. Al liberar la cola, la imagen aparece y las imágenes ausentes o demasiado grandes conservan su texto alternativo.

Para generar una muestra reproducible con 80 párrafos y cuatro SVG de 8 MiB cada uno:

```sh
python3 scripts/image-fixture.py
pnpm build:binary
xvfb-run -a dbus-run-session -- pnpm benchmark 'artifacts/local-image-benchmark/lectura con imágenes.md' 5
```

La muestra se guarda en `artifacts/`, fuera del control de versiones. Los SVG usan relleno de espacios para alcanzar el límite sin añadir complejidad gráfica. Esta muestra mide el coste de lectura y transporte de archivos grandes; no representa la decodificación de fotografías comprimidas.


## Resultado en Linux

Medición del 13 de octubre de 2026 en la VM de desarrollo, Ubuntu 26.04.1, CPU AMD EPYC con ocho CPU virtuales, Rust 1.99.0 y WebKitGTK 2.52.6. El ejecutable usa el perfil release del proyecto. Xvfb proporciona la pantalla y `WEBKIT_DISABLE_DMABUF_RENDERER=1` configura el renderizado para ese entorno. El Markdown ocupa 38.708 bytes y sus cuatro SVG suman 32 MiB.

| Apertura | Texto listo | Proceso completo |
| --- | --- | --- |
| 1 | 892.95 ms | 964.47 ms |
| 2 | 812.76 ms | 872.34 ms |
| 3 | 807.64 ms | 868.52 ms |
| 4 | 822.02 ms | 884.95 ms |
| 5 | 815.56 ms | 885.72 ms |

La mediana hasta el texto listo fue **815.56 ms**. Las mediciones se hicieron después de las pruebas del WebView; no son aperturas con cachés frías ni una comparación con la versión anterior. La medida aproxima la primera oportunidad de pintado mediante dos fotogramas; no mide el compositor de una sesión de escritorio real.

La prueba nativa confirmó el pintado con solicitudes de imágenes retenidas, la lectura posterior del archivo con espacios y Unicode y los fallos aislados por ausencia o tamaño. También pasaron las aperturas del sistema, la limpieza de HTML, los diagramas y la comprobación de CSP. El paso final del selector nativo falló en esta VM cuando Glycin intentó cargar iconos mediante `bwrap`. La CI mantiene esa comprobación en Ubuntu 22.04.
