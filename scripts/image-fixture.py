"""Generate a repeatable Markdown benchmark with 32 MiB of local images."""

from pathlib import Path
import sys

directory = Path(sys.argv[1] if len(sys.argv) > 1 else "artifacts/local-image-benchmark")
directory.mkdir(parents=True, exist_ok=True)
size = 8 * 1024 * 1024
svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#52715a"/>'
for index in range(4):
    # Whitespace keeps the SVG valid while exercising the full read budget.
    (directory / f"imagen {index}.svg").write_bytes(svg + b" " * (size - len(svg) - 6) + b"</svg>")
paragraph = "Texto de lectura con imágenes locales. " * 12
markdown = "# Texto antes de las imágenes\n\n"
for index in range(4):
    markdown += f"![Imagen {index}](imagen%20{index}.svg)\n\n"
    markdown += (paragraph + "\n\n") * 20
path = directory / "lectura con imágenes.md"
path.write_text(markdown, encoding="utf-8")
print(path)
