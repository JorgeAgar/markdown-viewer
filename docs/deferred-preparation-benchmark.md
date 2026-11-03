# Comparación release: preparación diferida

Base exacta `ff37cb9` frente a esta rama, ambas con `pnpm build:binary` (release optimizado, sin cambios de perfil). Linux 7.2.11-arch1-1 x86_64, Intel Core i5-1334U, sesión gráfica existente, 2026-11-03. Cinco procesos nuevos secuenciales por muestra, suite small/large/rich de #22; base primero y candidata después. Modo de métricas idéntico, sin garantía de cachés frías ni aislamiento de carga del escritorio/equipo (otro trabajo compilaba concurrentemente). No se modificó main.rs.

Medianas en ms; cada celda muestra **base → candidata**.

| Fase | small | large | rich |
| --- | ---: | ---: | ---: |
| startup_ms | 402.15 → 370.59 | 1503.40 → 1383.39 | 459.38 → 426.95 |
| frontend.backend.main_to_frontend_ready_ms | 352.61 → 332.39 | 377.12 → 331.99 | 362.55 → 340.44 |
| frontend.backend.read_ms | 0.03 → 0.03 | 1.52 → 1.51 | 0.04 → 0.03 |
| frontend.backend.markdown_ms | 0.03 → 0.04 | 28.69 → 23.71 | 0.15 → 0.15 |
| frontend.backend.sanitize_ms | 0.09 → 0.11 | 112.43 → 131.60 | 0.91 → 0.92 |
| frontend.insertion_ms | 1.00 → 0.00 | 78.00 → 73.00 | 2.00 → 2.00 |
| frontend.prepare_document_ms | 0.00 → 1.00 | 24.00 → 22.00 | 1.00 → 1.00 |
| frontend.prepare_controllers_ms | 1.00 → 1.00 | 11.00 → 4.00 | 3.00 → 3.00 |
| frontend.interface_and_frames_ms | 31.00 → 35.00 | 836.00 → 794.00 | 87.00 → 76.00 |
| frontend.receive_to_opportunity_ms | 33.00 → 36.00 | 954.00 → 895.00 | 94.00 → 84.00 |
| origin_to_ack_ms | 402.50 → 370.77 | 1503.54 → 1383.55 | 459.76 → 427.12 |

La fase de controladores excluye ahora descubrimiento/transformación de Mermaid y matemáticas. La reducción de esa fase no equivale a una reducción demostrada del arranque completo: el arranque del WebView, layout y frames dominan y varían entre procesos; cinco muestras y el orden de cohortes no permiten atribuir diferencias globales al cambio. La resolución del reloj JS observada es de 1 ms. En large se mantienen los IDs síncronos por navegación inmediata y el coste de layout; no se pretende resolverlos aquí.

El benchmark termina tras la oportunidad inicial y los acuses, sin esperar mejoras. No mide la finalización diferida ni presentación física del texto. Su tiempo diferido de CPU puede inspeccionarse interactivamente con `MD_VIEWER_METRICS=1` y `data-deferred-preparation-ms`; véase [semántica](opening-metrics.md). Las pruebas controladas cubren orden, suspensión, reanudación y cancelación, no constituyen un benchmark de píxeles. No se midieron Windows/macOS ni un escritorio aislado.

Los registros completos por ejecución y sus estadísticas (n, min, mediana, p90, max, media, desviación) quedaron en `artifacts/deferred-preparation/{base,candidate}-benchmark.log` en el entorno de trabajo.
