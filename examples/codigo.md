# Código con colores

El texto aparece primero. Los bloques se resaltan después, sin conexión, usando el lenguaje de cada bloque.

## TypeScript

```ts
interface Document {
  name: string;
  bytes: number;
}

const describe = (doc: Document): string => `${doc.name}: ${doc.bytes} B`;
console.log(describe({ name: 'Café.md', bytes: 42 }));
```

## Rust

```rust
fn main() {
    // Abrir y leer, sin modificar el archivo.
    let document = "Café 🦀";
    println!("{document}");
}
```

## Python

```python
def greet(name: str) -> str:
    return f"Hola, {name}"

print(greet("Café"))
```

## Shell y JSON

```sh
# Una ruta con espacios.
markdown-viewer "mi documento.md"
```

```json
{ "name": "Café.md", "readOnly": true, "bytes": 42 }
```

## HTML literal

Estas etiquetas son código y no se ejecutan ni cargan recursos:

```html
<script>alert("Esto es texto")</script>
<img src="missing.png" onerror="alert('También es texto')">
```

## Texto sin resaltar

El código en línea, como `const value = 42`, permanece literal. Los bloques sin lenguaje o con uno no admitido también:

```
const plain = "Sin lenguaje";
```

```unknown
const unknown = "Lenguaje no admitido";
```
