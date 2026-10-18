# Fórmulas sin conexión

Una fórmula en línea: $E = mc^2$. El texto se puede leer antes de cargar KaTeX.

## Fracciones y raíces

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$

## Matrices

$$
A = \begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
$$

## Ecuaciones alineadas

$$
\begin{aligned}
a^2 + b^2 &= c^2 \\
e^{i\pi} + 1 &= 0
\end{aligned}
$$

## Integrales y sumas

$$
\int_0^1 x^2\,dx = \frac{1}{3}
\qquad
\sum_{n=1}^{\infty}\frac{1}{n^2} = \frac{\pi^2}{6}
$$

También se admite texto con acentos: $\text{Café} = 2$.

## Colores y recuadros

$$
\fcolorbox{red}{white}{Resultado}
$$

## Errores aislados

Este comando no existe. Su definición permanece legible y el aviso aparece al
poner el cursor sobre ella:

$$
\comandoInexistente{x}
$$

La expansión de macros tiene un límite. Esta fórmula falla sin impedir leer el resto:

$$
\def\bucle{\bucle}\bucle
$$

Después de los errores, esta fórmula sigue funcionando: $\sqrt{16} = 4$.

## Texto literal

Los precios \$5 y \$10 conservan el dólar. Los dólares escapados no abren fórmulas.

El código en línea `$x^2$` y los bloques de código se conservan literalmente:

```latex
$$\frac{1}{2}$$
```
