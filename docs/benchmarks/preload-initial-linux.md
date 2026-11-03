# Precarga inicial: comparación Linux

Base `ff37cb9` frente a código de precarga `286ad1a` (las adiciones posteriores son documentación). Ambos: `pnpm build:binary`, perfil release del repositorio (opt-level 3, thin LTO, codegen-units 1), mismas dependencias y frontend. Linux 7.2.11-arch1-1 x86_64, Intel Core i5-1334U, 12 CPU lógicas, sesión gráfica Wayland/Xwayland. Medición local del 2026-11-03.

Cinco procesos nuevos por variante y fixture `small`, `large`, `rich` de `scripts/benchmark-metrics.mjs`. Se alternó base/precarga y se invirtió el orden en las repeticiones pares. Misma instrumentación opt-in y salida tras acuse; sesión D-Bus aislada de otras instancias. Sin garantía de cachés frías. Hubo compilación de otro trabajo en la máquina durante parte de la sesión: no es un escritorio ni una CPU controlados. Las medias de carga por lanzamiento están en las [muestras JSONL](preload-initial-linux.jsonl). No se infiere un porcentaje de mejora ni comportamiento en macOS/Windows.

Medianas en ms; cada celda es **base / precarga**. `—` significa campo ausente en la base. Son medianas independientes, no sumas de tramos secuenciales.

| Frontera/fase | small | large | rich |
| --- | ---: | ---: | ---: |
| `frontend.backend.main_to_load_dispatch_ms` | 359.25 / 36.61 | 369.46 / 34.97 | 430.24 / 46.36 |
| `frontend.backend.main_to_frontend_ready_ms` | 359.24 / 355.25 | 369.46 / 370.82 | 430.23 / 451.02 |
| `frontend.backend.origin_to_worker_ms` | 359.40 / 37.14 | 369.58 / 35.67 | 430.43 / 46.95 |
| `frontend.backend.read_ms` | 0.03 / 0.02 | 1.48 / 1.30 | 0.04 / 0.03 |
| `frontend.backend.markdown_ms` | 0.04 / 0.03 | 28.35 / 25.84 | 0.19 / 0.17 |
| `frontend.backend.sanitize_ms` | 0.10 / 0.09 | 112.77 / 176.93 | 1.15 / 1.08 |
| `frontend.backend.origin_to_prepared_ms` | — / 37.30 | — / 242.49 | — / 48.11 |
| `frontend.backend.origin_to_response_ms` | 359.61 / 355.26 | 519.75 / 370.86 | 431.64 / 451.04 |
| `frontend.insertion_ms` | 0.00 / 0.00 | 75.00 / 98.00 | 4.00 / 3.00 |
| `frontend.prepare_document_ms` | 1.00 / 1.00 | 22.00 / 23.00 | 3.00 / 2.00 |
| `frontend.prepare_controllers_ms` | 1.00 / 2.00 | 11.00 / 10.00 | 5.00 / 6.00 |
| `frontend.receive_to_opportunity_ms` | 44.00 / 46.00 | 941.00 / 947.00 | 139.00 / 122.00 |
| `startup_ms` | 394.62 / 409.68 | 1458.54 / 1334.93 | 572.54 / 573.33 |
| `origin_to_ack_ms` | 394.79 / 409.85 | 1458.69 / 1335.12 | 572.72 / 573.59 |
| `process_ms` | 446.89 / 476.21 | 1605.49 / 1491.35 | 628.78 / 640.96 |

La evidencia de solapamiento es que `origin_to_prepared_ms` precede a `main_to_frontend_ready_ms` en las 15 aperturas de precarga; la base despacha después de esa frontera. El trabajo de conversión/saneamiento sigue existiendo, ahora puede solaparse con la interfaz. El pintado del documento grande continúa dominado en buena parte por la preparación de interfaz y frames, fuera del alcance de esta PR. El doble rAF indica una oportunidad de pintado, no presentación real. `process_ms` incluye salida del proceso.

Validación: `pnpm test` completo (94 frontend, 26 Rust, 6 contrato IPC y auxiliares), `pnpm check` y ambos builds release pasan. En repeticiones bajo compilación simultánea fallaron pruebas existentes con esperas temporizadas de imágenes/math/Mermaid/syntax; la ejecución completa final pasó sin cambios en esos tests. Pruebas Rust con barreras verifican resultado preparado antes del consumo, sin segunda lectura, origen/identidad, saneamiento, imágenes diferidas, error inicial, sustituciones por drop/selector, ráfagas OS y descarte de éxito/error inicial lento. También se probó el release Linux en una sesión D-Bus aislada: principal sin documento, lanzamiento secundario durante el arranque, una apertura `os` entregada y secundario con salida 0 sin informe de pintado. Esto no sustituye la prueba nativa de asociaciones de archivos en los tres SO.

Para repetir con el runner existente, seleccionar cada binario con `MD_VIEWER_BINARY` y ejecutar `pnpm benchmark --suite 5`; alternar las ejecuciones por fixture si se desea conservar el orden de esta comparación. Conservar stderr para diagnosticar sesión gráfica y stdout para los registros. Las muestras guardadas incluyen todas las fases, no sólo esta tabla.
