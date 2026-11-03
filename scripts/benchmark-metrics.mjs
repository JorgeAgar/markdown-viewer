export function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = p => {
    const index = (sorted.length - 1) * p;
    const low = Math.floor(index);
    return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
  };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { n: values.length, min: sorted[0], median: quantile(0.5), p90: quantile(0.9), max: sorted.at(-1), mean,
    stddev: Math.sqrt(values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / values.length) };
}

export function parseMeasurement(output) {
  const legacy = output.match(/MD_VIEWER_PAINT_MS=(\d+(?:\.\d+)?)/);
  const records = [...output.matchAll(/MD_VIEWER_OPENING=(.+)/g)].map(match => JSON.parse(match[1]));
  if (!legacy || records.length !== 1) throw new Error('Expected one startup and one opening measurement');
  const record = records[0];
  if (record.opening_id !== record.frontend.backend.opening_id) throw new Error('Opening identity mismatch');
  return { startup_ms: Number(legacy[1]), ...record };
}

// Fixed inputs; no random seed, remote assets or dependency on example edits.
export const fixtures = {
  small: '# Lectura\n\nUn párrafo breve con **énfasis** y [enlace](https://example.com).\n',
  large: '# Documento grande\n\n' + '## Sección\n\nTexto reproducible con **énfasis**, listas y Unicode: ñ.\n\n- uno\n- dos\n\n'.repeat(16000),
  rich: '# Contenido enriquecido\n\n' + ('## Sección\n\n| A | B |\n|---|---|\n| uno | dos |\n\n- [x] tarea\n\n```ts\nconst value = 42;\n```\n\n$$x^2 + y^2$$\n\n```mermaid\ngraph LR\nA-->B\n```\n\n![local](missing.png)\n\n').repeat(24),
};
