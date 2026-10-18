# E2E Linux del release

`pnpm test:e2e` usa `wdio.conf.ts`, Mocha y conexión WebDriver directa a un
`tauri-driver` externo. `scripts/e2e.mjs` gestiona el driver y los grupos de
procesos; no ejecuta builds. La CI Ubuntu lo llama bajo Xvfb y D-Bus después
del build y antes del benchmark existente. Windows, macOS y Arch conservan
sus pasos de validación.

## Paridad con scripts/smoke.py

Cada caso de `e2e/viewer.e2e.ts` crea una sesión limpia. Las aperturas posteriores
usan el ejecutable real como segunda instancia, salvo la apertura inicial por
CLI y la selección mediante el diálogo nativo. Las comprobaciones migradas son:

- **CLI startup**: título, tres filas de tabla, ancla, tareas deshabilitadas,
  imagen local de 640 px y captura. Ausencia de enlace CSS y recursos de
  KaTeX/math-runtime en un documento sencillo.
- **second instance**: reutilización de la ventana, nombre Unicode con `.MD`,
  encabezado, eliminación de HTML activo, ausencia de ejecución de scripts,
  bytes originales intactos y reapertura por evento del sistema.
- **failed open**: archivo inexistente conserva el documento anterior; Escape
  oculta el error. El comando real `open_link` rechaza `file:///etc/passwd`.
- **controlled image reads**: exactamente dos solicitudes pendientes, texto
  pintado sin resolución terminada, tres placeholders y alt visible. Se crea
  `imagen ñ.svg` después del pintado; Rust la lee al liberar la cola. Ancho
  real de 32 px, archivo ausente y archivo de más de 8 MiB conservan sus alt,
  sin error global. La única intervención copia temporalmente `core.invoke`
  para aplazar lecturas, igual que el smoke; la validación y lectura son reales.
- **Highlight.js**: seis bloques listos y dos sin resaltar, pintado registrado,
  tokens reales, HTML literal, ausencia de nodos/estilos activos, colores CSS
  distintos y cero violaciones CSP; captura del ejemplo.
- **KaTeX**: siete expresiones listas, dos errores y otra lista; ocho anotaciones
  MathML, ausencia de HTML activo, anchura real, líneas de fracciones visibles,
  fuentes KaTeX cargadas, un único CSS, código literal y cero violaciones CSP;
  captura del ejemplo.
- **Mermaid**: cinco tipos listos y dos errores aislados, cinco SVG con tamaño
  y título, host temporal eliminado, SVG sin HTML activo ni estilos inline,
  hojas CSS con nonce autorizado y cero violaciones CSP; captura del ejemplo.
- **project documentation diagrams**: cinco casos independientes para
  `arquitectura.md`, `interfaz.md`, `coordinacion-rust.md`,
  `procesamiento-documento.md` y `mermaid.md`; todos sus diagramas listos.
- **starts empty**: estado inicial «Listo para leer», documento oculto, clic real
  en el botón, selección en el diálogo nativo mediante xdotool, nombre cargado
  y botón de apertura habilitado.

Las esperas observan DOM, métricas de renderizado o la ventana nativa, con
límites explícitos. xdotool espacia la entrega de teclas; la apertura se verifica
en el WebView. No hay reintentos de tests ni de conexiones WebDriver.

## Diagnóstico y limpieza

Al fallar se guardan el error, captura, HTML, métricas, estado de renderizadores
y recursos en `artifacts/e2e/`, además de los logs de WebdriverIO, runner,
aplicación y driver. La captura de cada diagnóstico es independiente para que
un WebView caído no impida intentar los demás. Los logs del driver/runner
cubren también fallos anteriores a la creación de sesión. No borres los
artefactos antes de recogerlos si repites una ejecución fallida.

La salida de WebdriverIO determina el código de salida del comando. El runner
tiene un límite global de cinco minutos; en éxito, error o SIGINT/SIGTERM/SIGHUP
termina solo los grupos de procesos que creó, con SIGKILL como respaldo.
La eliminación normal de sesión cierra la app entre preparaciones. El benchmark
posterior sirve también para detectar una instancia residual del viewer.
