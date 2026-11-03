# Métricas por apertura

Compila con `pnpm build:binary` y cierra otras instancias. `pnpm benchmark --suite 5` usa muestras reproducibles pequeñas, grandes y enriquecidas; `pnpm benchmark ruta.md 10` conserva el modo de archivo propio. `MD_VIEWER_BINARY` selecciona el ejecutable. Guarda stdout para conservar muestras y estadísticas JSON. Registra commit, compilación, SO, CPU y condiciones del escritorio al comparar resultados. No se garantizan cachés frías ni siquiera en la primera ejecución. El tiempo `process_ms` incluye lanzamiento y salida, no sólo apertura.

Para instrumentar aperturas interactivas, ejecuta el binario con `MD_VIEWER_METRICS=1`. El benchmark activa el mismo detalle automáticamente. Cada apertura completada escribe en stderr `MD_VIEWER_OPENING=<JSON>`, sin rutas ni contenido. En Windows una aplicación GUI puede requerir captura explícita de stderr. No es telemetría persistente. Sin estas variables no se construyen registros JSON, no se cronometran las fases de Rust ni de DOM y no hay un IPC adicional por apertura. Se conserva el coste pequeño de los identificadores y algunas lecturas de reloj de la interfaz.

## Identidad, origen y vigencia

El `opening_id` es el ID de documento, único dentro del proceso y nuevo incluso si se vuelve a abrir la misma ruta. No compares IDs entre procesos. El origen monotónico de Rust depende de `source`:

| source | Origen real |
| --- | --- |
| `initial` | Entrada en `main`, antes de construir el WebView |
| `os` | Recepción de la ruta en el callback de instancia única o `Opened` de macOS; incluye espera hasta que la interfaz la consume |
| `drop` | Entrada al comando Rust `open_document`; no incluye el trayecto anterior desde el evento de arrastre |
| `picker` | Archivo seleccionado y convertido en ruta tras volver del diálogo; excluye todo el tiempo humano y la espera del selector |

La apertura inicial se despacha desde un plugin Rust después de single-instance y antes de construir las ventanas. Lectura, conversión y saneamiento pueden terminar antes de que exista la interfaz. Las rutas OS también se despachan al recibirlas; `take_pending_document` consume una única tarea/resultado y espera de forma asíncrona si aún trabaja. Drop y selector se despachan desde sus comandos. En la interfaz, el descubrimiento y la transformación de Mermaid y matemáticas esperan la oportunidad de pintado; los IDs de encabezados, los inputs y la política/placeholders de imágenes se preparan antes de mostrar el artículo.

Sólo se registran aperturas exitosas que alcanzan su primera oportunidad de pintado mientras siguen vigentes y visibles. Respuestas obsoletas, cancelaciones, errores y pestañas cerradas u ocultadas antes de esa oportunidad no producen registro. Volver a una pestaña no vuelve a medir ni incorpora su tiempo de espera. La interfaz comprueba su generación de petición y pestaña; Rust conserva un único acuse pendiente, lo invalida al iniciar otra apertura, comprueba el ID y lo consume una vez. La cola de rutas OS mantiene su comportamiento de conservar sólo la última ruta pendiente. No es una traza de todos los intentos ni un contador de errores.

## Fronteras

Los números son milisegundos. `frontend.backend` contiene el detalle medido en Rust; el resto de `frontend` usa `performance.now()`. No se restan timestamps absolutos entre relojes.

| Campo | Frontera y trabajo incluido |
| --- | --- |
| `main_to_frontend_ready_ms` | Se incorpora al entregar, no al despachar: `main` → entrada en el primer `take_pending_document`, solicitado por la interfaz. Mezcla arranque Tauri/WebView, carga/evaluación JS, interfaz inicial e ida del comando; no es tiempo puro de WebView |
| `main_to_load_dispatch_ms` | `main` → despacho de esta carga; referencia de arranque, no latencia por apertura |
| `origin_to_dispatch_ms` | Origen propio → antes de enviar el trabajo al pool bloqueante |
| `origin_to_worker_ms` | Origen → entrada al worker; la diferencia anterior aproxima espera del pool y despacho |
| `read_ms` | Worker: validación de extensión, canonicalización, apertura, metadata, lectura limitada y validación UTF-8 |
| `markdown_ms` | Construcción/consumo del parser, transformaciones de eventos, referencias de imagen y conversión a HTML |
| `sanitize_ms` | Construcción del saneador, saneamiento y copia de HTML saneado |
| `origin_to_prepared_ms` | Origen → resultado listo en el worker, tras lectura/conversión/saneamiento y detalle de sus fases; puede preceder a `frontend_ready`. Campo añadido sin cambiar `version: 1` |
| `origin_to_response_ms` | Origen → preparación de la respuesta Rust tras consumir el resultado y publicar las referencias de imágenes; incluye la espera hasta que la interfaz lo solicita, además de procesamiento. Aún faltan serialización externa, entrega y recepción |
| `request_roundtrip_ms` | Sólo drop: antes de invocar desde JS → continuación del `await` con documento. Incluye ida, cola, procesamiento, serialización, transporte y planificación JS. `null` para los demás flujos para excluir selector humano y orígenes ambiguos |
| `ui_setup_ms` | Evaluación del cuerpo de `app.ts` hasta antes de `start()`. Excluye descarga, parsing y evaluación de imports; no mide todo el arranque JS |
| `receive_to_dom_ms` | Continuación JS con resultado vigente → entrada de creación de pestaña, incluido parseo del detalle de métricas |
| `insertion_ms` | Creación/configuración de article y asignación de `innerHTML`, inicialmente oculto; incluye parseo HTML, no sólo inserción en árbol conectado |
| `prepare_document_ms` | IDs de encabezados y preparación de checkboxes |
| `prepare_controllers_ms` | Preparación inicial: adjuntar article, crear controladores, política y placeholders de imágenes e invalidar generaciones; excluye descubrimiento/transformación de Mermaid, matemáticas y código |
| `interface_and_frames_ms` | Crear/seleccionar pestaña, actualizar interfaz, foco y esperar doble rAF hasta entrar en su callback válido |
| `receive_to_opportunity_ms` | Recepción JS → callback válido de doble rAF, antes de lanzar mejoras diferidas |
| `origin_to_ack_ms` | Origen Rust → recepción del acuse `opening_painted`; incluye el retorno JS→Rust y posible trabajo entre el callback y su procesamiento |
| `response_and_ack_overhead_ms` | Residuo: `origin_to_ack_ms - origin_to_response_ms - receive_to_opportunity_ms`. Mezcla serialización/entrega de respuesta, planificación/recepción JS, generación/envío del informe y retorno/procesamiento del acuse. No es IPC puro ni sólo transporte de ida; usa duraciones de dos relojes, puede sufrir resolución/deriva |

Despacho, entrada al worker y preparación pueden preceder a `main_to_frontend_ready_ms`; no deben sumarse como tramos secuenciales del arranque. La diferencia entre respuesta y preparación incluye espera del consumidor, planificación y publicación, no es sólo IPC. Las duraciones de fases no pretenden sumar exactamente el total: hay publicación, metadata, copias, serialización y trabajo entre marcas. El propio detalle tiene coste (JSON, lecturas de reloj, acuse y logging); compara con el mismo modo habilitado. `MD_VIEWER_PAINT_MS` mantiene la frontera `main` → recepción de `content_painted`, que se solicita en el mismo callback, antes del informe detallado y antes de lanzar mejoras. Se emite sólo una vez por proceso con documento. El benchmark espera ambos registros antes de salir; su `process_ms` incluye ese coste de instrumentación.

El doble rAF sólo ofrece una oportunidad de pintado. No garantiza presentación real, fuentes listas, decodificación de imágenes, red completada, Mermaid, KaTeX o resaltado terminados; ventanas ocultas y carga del escritorio pueden alterar los frames. Para resultados de usuario hacen falta mediciones en los tres SO y equipos reales.

## Preparación diferida

Con métricas habilitadas, `data-deferred-preparation-ms` en cada article acumula tiempo de ejecución de los lotes de descubrimiento/transformación de Mermaid y matemáticas. Incluye selectores, lectura de fuentes, validación de límites y creación de contenedores; excluye esperas entre lotes, tiempo oculta, imports y renderizado asíncrono. Se actualiza progresivamente y se reinicia al abrir; no se envía otro IPC ni se modifica el registro de primera oportunidad. Sin opt-in no se cronometra ni se escribe este atributo. El benchmark sale tras los acuses iniciales y **no mide esta fase diferida**. Los atributos `data-diagrams-ready-ms` y `data-math-ready-ms` mantienen su frontera desde el inicio del renderizado, después del descubrimiento, hasta completarlo (con imports y pausas); no son tiempos desde recepción.

Los lotes procesan hasta 32 elementos y ceden el turno entre ellos. Usan el ámbito del documento del scheduler existente: una pestaña oculta espera, al volver reutiliza el progreso y al cerrar/iniciar otra generación se cancela. La consulta DOM nativa inicial sigue siendo una operación indivisible, ahora posterior a la oportunidad de texto. Los IDs de encabezados siguen síncronos para permitir navegación inmediata, incluso antes de los frames; los inputs quedan deshabilitados y la política de imágenes y sus placeholders se aplican antes de mostrar. Esto evita recursos no permitidos y cambios posteriores de espacio reservado. No cambia el saneamiento Rust ni el viewport lazy loading.

## Validación

`pnpm test` cubre fases opt-in sin cambiar HTML, correlación/single-use en Rust, aperturas repetidas y obsoletas, pestañas ocultadas, selector sin tiempo humano en JS y compatibilidad del comando de arranque. También valida el parser de registros, estadísticas y muestras del benchmark. `pnpm check` comprueba el contrato IPC generado, tipos, build y clippy. El benchmark real requiere una sesión gráfica; no convierte los tests DOM en una medición de renderizado.

## Propiedad de la precarga

El plugin inicial sólo agenda trabajo en el pool bloqueante; no lee archivos en el hilo UI. Single-instance se registra primero y termina el proceso secundario antes de este plugin. Un mutex corto serializa asignación de identidad, sustitución de la tarea pendiente y publicación de referencias de imagen. Ningún mutex permanece adquirido al esperar el worker. La tarea posee ruta, origen y resultado, y la interfaz consume su handle una sola vez.

Una ruta OS recibida antes de los listeners conserva el resultado pendiente; después de los listeners, el evento existente solicita su consumo. Cada nueva apertura reserva identidad antes de despacharse. Al finalizar se comprueba esa identidad antes de publicar imágenes o propagar errores: una respuesta OS/inicial obsoleta se convierte en `null`; los comandos explícitos conservan su contrato y la generación de petición JS descarta su error obsoleto. Las pestañas ya abiertas conservan sus imágenes. Un worker ya iniciado no se cancela al sustituirlo: puede terminar y liberar su resultado, pero nunca recuperar la vigencia ni bloquear la entrega del nuevo. Sólo se retiene un handle pendiente, sin caché adicional ni segunda carga.
