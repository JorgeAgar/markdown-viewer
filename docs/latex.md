# Fórmulas LaTeX

El visor renderiza notación matemática con [KaTeX](https://katex.org/), incluido
en la app junto con su CSS y sus fuentes WOFF2. Funciona sin conexión. El texto
del documento se muestra antes de cargar el renderizador.

## Uso

Usa `$…$` para una fórmula en línea y `$$…$$` para una fórmula separada:

```markdown
La equivalencia es $E = mc^2$.

$$
\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$
```

Se admiten fracciones, raíces, integrales, sumatorios, matrices y entornos como
`aligned`. Consulta las [funciones de KaTeX](https://katex.org/docs/supported).
Es un renderizador de notación matemática; no compila documentos `.tex`, paquetes
arbitrarios, bibliografías ni preámbulos LaTeX. Esta primera implementación usa los
delimitadores del parser: `$…$` y `$$…$$`; no añade `\(…\)` ni `\[…\]`.

Los bloques y fragmentos de código, incluido Mermaid, permanecen literales. Escribe
`\$` para un dólar literal, especialmente en frases con varios precios. Los casos
de delimitadores ambiguos siguen las reglas de `pulldown-cmark`, no un buscador de
expresiones regulares sobre el HTML.

Puedes abrir [el ejemplo](../examples/latex.md) para ver fórmulas válidas,
código literal y errores. Si una fórmula falla, su TeX permanece visible, con un
subrayado punteado y el detalle del error en el texto emergente. Las demás fórmulas
continúan. Los bloques anchos tienen desplazamiento horizontal y las fórmulas
heredan el color del tema del sistema, salvo colores explícitos de la expresión.

## Recorrido y carga diferida

1. [`document.rs`](../src-tauri/src/document.rs) activa `Options::ENABLE_MATH`.
   El parser emite `InlineMath` y `DisplayMath`; su generador HTML escapa la
   definición y la coloca en `span.math.math-inline` o `span.math.math-display`.
   Ammonia conserva únicamente esas clases en `span`. No se renderiza TeX en Rust
   ni cambia el contrato IPC.
2. [`math.ts`](../src/math.ts) recoge las definiciones del documento visible.
   La preparación no importa KaTeX ni carga sus estilos o fuentes.
3. [`app.ts`](../src/app.ts) activa el trabajo después de dos fotogramas, junto
   con imágenes y Mermaid. La medición `content_painted` no espera las fórmulas.
4. El primer documento con fórmulas válidas importa
   [`math-runtime.ts`](../src/math-runtime.ts). Se carga una única hoja local
   `katex/katex.min.css`. El navegador solicita las fuentes que necesita. Los
   documentos sin fórmulas no solicitan esos recursos.
5. El controlador prioriza las fórmulas visibles y cede el hilo entre lotes de
   ocho. Cada espera comprueba la generación visible. Un documento nuevo descarta
   resultados y trabajo pendientes del anterior; cancelar un selector conserva
   el trabajo del documento que sigue en pantalla. Los errores de carga permiten
   reintentar con el siguiente documento.

[`frontend.mjs`](../scripts/frontend.mjs) genera el módulo diferido y copia el CSS,
las fuentes WOFF2 y la licencia de KaTeX a `dist/katex/`. No usa CDN. Solo se
empaquetan fuentes WOFF2, admitidas por los WebViews objetivo; los formatos de
respaldo WOFF y TTF del CSS distribuido por KaTeX no se incluyen.

## Seguridad y CSP

KaTeX usa `trust: false`, `throwOnError: true`, `strict: 'error'`, `maxExpand: 1000`
y `maxSize: 20`. Los comandos capaces de crear enlaces, HTML o cargar imágenes
no reciben confianza. Según el comando, KaTeX los representa como texto de error
o rechaza la expresión. Un comando no admitido no se ejecuta ni carga recursos.

Cada fórmula recibe un objeto de macros nuevo: las definiciones no se comparten
entre expresiones ni documentos. Esto también evita que la prioridad visual cambie
el significado de otra fórmula. No hay numeración ni referencias cruzadas entre
expresiones en esta versión.

`katex.render` crea nodos separados del documento y asigna sus estilos mediante
CSSOM. El resultado se limpia con DOMPurify **en el mismo árbol**, conservando HTML,
SVG y MathML. Se eliminan enlaces, imágenes, contenido activo y atributos de URL.
Antes de limpiar se retiran los atributos `style`; después se restauran únicamente
las propiedades permitidas, mediante `element.style.setProperty`. Los valores no
admiten URL, variables ni funciones arbitrarias, y `position` solo admite `relative`.
No se serializa el resultado para reinsertarlo mediante `innerHTML`.

[`katex-build.mjs`](../scripts/katex-build.mjs) adapta el escritor de atributos
MathML de KaTeX 0.19 para que los estilos de `\fcolorbox` también pasen por CSSOM
y el filtro de [`math-style.ts`](../src/math-style.ts). El build falla si cambia
ese punto de integración. Solo adapta nuestra dependencia; Mermaid conserva su
propia versión de KaTeX. Las pruebas usan el mismo adaptador que producción.

La CSP de Tauri permanece igual: no se añade `unsafe-inline` ni acceso a CDN.
El CSS se sirve desde la app y las fuentes heredan `default-src 'self'`.
La salida incluye HTML visual y MathML, con el TeX original en una anotación para
tecnologías de asistencia. Los errores se muestran mediante `textContent` y `title`.

## Límites y mediciones

- Se renderizan las primeras 500 fórmulas de cada documento.
- Cada definición admite hasta 10.000 unidades UTF-16 en JavaScript.
- La expansión de macros se limita a 1.000 operaciones y los tamaños especificados
  por TeX a 20 em mediante las opciones de KaTeX.
- Las fórmulas que superan los límites conservan su definición y el aviso.

`data-math-ready-ms` registra el tiempo desde que se activa el trabajo hasta acabar
el lote, incluidos importación, CSS y pausas. Se limpia al cambiar el documento y
solo se escribe si había fórmulas elegibles. No incluye necesariamente la carga y
el pintado de las fuentes, ni sustituye a `data-ready-ms`, que sigue midiendo la
oportunidad de primer pintado del texto. Un fallo de carga también termina el lote
y registra el tiempo; el estado de cada fórmula distingue los errores.

## Validación y mantenimiento

Ejecuta `pnpm test` y `pnpm check`. Las pruebas Rust comprueban los marcadores,
el escapado de TeX, el código literal, los precios y la lista de clases permitidas.
Las pruebas TypeScript cubren carga diferida, primer pintado, cancelaciones,
resultados tardíos, prioridad visible, lotes, límites, reintentos, KaTeX real,
aislamiento de macros, saneamiento y recursos locales.

[`smoke.py`](../scripts/smoke.py) añade una comprobación del ejemplo en el WebView
Linux: fórmulas válidas, errores aislados, MathML, fuentes locales y ausencia de
infracciones CSP. La CI compila además Windows y macOS; el smoke nativo solo se
ejecuta en Linux. Para comparar apertura, usa el benchmark del
[README](../README.md#medición-de-apertura) con un documento sin fórmulas antes y
después del cambio. El tiempo de fórmulas se mide aparte.

En una medición local de Linux, compilación release y `examples/bienvenido.md`,
la mediana fue 640,83 ms en `7c18626` y 651,24 ms con KaTeX. Se alternaron siete
aperturas por versión, después de una apertura de calentamiento por versión.
La variación entre ejecuciones fue amplia (580–825 ms antes y 601–746 ms después),
por lo que esa diferencia de 10,41 ms no permite concluir una regresión o mejora.
No son cachés frías ni resultados representativos de otros equipos.

Al actualizar KaTeX, revisa el adaptador de build, sus cambios de DOM/CSS, las propiedades permitidas por
el saneador, las rutas de fuentes y las pruebas en WebView con la CSP real. No
basta con que jsdom produzca nodos: no mide distribución, fuentes ni CSP.
