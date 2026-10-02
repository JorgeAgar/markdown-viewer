# Diagramas en el lector

Los bloques con lenguaje `mermaid` se convierten en diagramas después de mostrar
el texto. Cada diagrama conserva su definición en **Ver código**.

## Flujo

```mermaid
flowchart LR
    A["Abrir un Markdown"] --> B{"¿Contiene Mermaid?"}
    B -->|Sí| C["Dibujar el diagrama"]
    B -->|No| D["Leer el texto"]
    C --> D
```

## Secuencia

```mermaid
sequenceDiagram
    actor Persona
    participant UI as Interfaz
    participant Rust
    Persona->>UI: Abrir archivo
    UI->>Rust: Pedir documento
    Rust-->>UI: HTML limpio
    UI->>UI: Mostrar texto
    UI->>UI: Renderizar Mermaid
```

## Estados

```mermaid
stateDiagram-v2
    [*] --> Pendiente
    Pendiente --> Dibujando
    Dibujando --> Listo
    Dibujando --> Error
    Listo --> [*]
    Error --> [*]
```

## Clases

```mermaid
classDiagram
    class Documento {
        +String html
        +String name
    }
    class Lector {
        +mostrar(Documento)
    }
    Lector --> Documento : muestra
```

## Relaciones entre entidades

```mermaid
erDiagram
    DOCUMENTO ||--o{ DIAGRAMA : contiene
    DOCUMENTO {
        string nombre
    }
    DIAGRAMA {
        string fuente
        string estado
    }
```

## Error de sintaxis

Este bloque conserva el código y muestra un aviso. Los diagramas anteriores
siguen disponibles.

```mermaid
flowchart LR
    A[Un nodo sin cierre
```

## Configuración no admitida

La aplicación controla el tema y las reglas de seguridad. Las directivas por
bloque no pueden cambiarlas.

```mermaid
%%{init: {"securityLevel": "loose"}}%%
flowchart LR
    A --> B
```

## Texto después de los diagramas

Un error de Mermaid no impide seguir leyendo ni abrir otro archivo.
