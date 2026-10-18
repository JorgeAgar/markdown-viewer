# Resaltado de código

Los bloques cercados con un lenguaje admitido se resaltan con Highlight.js después de la oportunidad de primer pintado del texto. El código en línea, Mermaid y los bloques sin lenguaje o con uno desconocido permanecen literales. No se intenta detectar el lenguaje automáticamente.

Abre [`examples/codigo.md`](../examples/codigo.md) para probar colores, alias, Unicode y HTML literal. Los colores siguen el tema claro u oscuro del sistema mediante CSS, sin volver a tokenizar ni cambiar fuente, tamaño o espaciado.

## Lenguajes

Se admiten JavaScript (`javascript`, `js`, `jsx`), TypeScript (`typescript`, `ts`, `tsx`), Python (`python`, `py`), Rust (`rust`, `rs`), shell (`bash`, `sh`, `shell`), JSON, YAML (`yaml`, `yml`), TOML e INI, CSS, HTML/XML (`html`, `xml`, `svg`), SQL, C, C++ (`cpp`, `c++`), Go, Java, C# (`csharp`, `cs`), diff, Markdown (`markdown`, `md`) y Dockerfile. Usa los nombres en minúscula. TOML utiliza la gramática INI/TOML de Highlight.js.

## Carga y límites

`src/syntax.ts` coordina el documento actual. `prepare()` solo invalida trabajos anteriores; su callback descubre los bloques después del primer pintado. Si hay bloques compatibles dentro de los límites, importa `syntax-runtime.ts`, que carga el núcleo de Highlight.js. Cada gramática tiene una importación dinámica literal y se registra una vez. Todos los módulos se incluyen localmente en el ejecutable: no se usan CDN ni peticiones externas.

Se priorizan los bloques visibles y se cede el hilo entre tandas de hasta cuatro bloques o al acumular ocho milisegundos. Cada bloque se tokeniza de forma síncrona una vez cargada su gramática; ese tiempo puede superar el presupuesto de una tanda. Por documento se procesan hasta 200 bloques, hasta 50.000 unidades UTF-16 por bloque y 500.000 en total. Los bloques que exceden los límites conservan el texto sin resaltar (`data-syntax-state="skipped"`).

Una generación identifica el documento visible, independientemente de solicitudes de apertura que puedan cancelarse o fallar. Los resultados tardíos no modifican un documento nuevo. Un error conserva el código original; un fallo de importación se puede reintentar al abrir otro documento. `pagehide` invalida el controlador.

## Saneamiento

Rust sigue renderizando con pulldown-cmark y limpiando con ammonia. Solo se conservan las clases `language-*` de la lista explícita de lenguajes admitidos, además de `language-mermaid`. Las otras clases, atributos activos y estilos permanecen filtrados.

El resaltador recibe `textContent`, no HTML. Highlight.js escapa el contenido y genera spans con clases de token; no se instalan plugins que alteren esa salida. El CSS local colorea esos spans sin estilos inline ni cambios en la CSP. Las pruebas ejecutan las gramáticas reales, verifican que las etiquetas activas sigan siendo texto y comparan los alias del frontend con la lista permitida de Rust.

## Medición

`data-syntax-ready-ms` registra el tiempo desde el inicio del trabajo diferido hasta terminar los bloques, incluyendo la carga del motor, las gramáticas y las pausas. No mide el pintado final de los colores. `data-ready-ms` y `pnpm benchmark` siguen midiendo por separado la disponibilidad del texto; no esperan al resaltado.
