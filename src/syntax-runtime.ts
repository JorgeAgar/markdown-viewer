import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';
import type { CodeRenderer } from './syntax';

// Literal imports let esbuild emit local chunks, with no CDN or runtime paths.
const grammars: Record<string, () => Promise<{ default: LanguageFn }>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  python: () => import('highlight.js/lib/languages/python'),
  rust: () => import('highlight.js/lib/languages/rust'),
  bash: () => import('highlight.js/lib/languages/bash'),
  json: () => import('highlight.js/lib/languages/json'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  ini: () => import('highlight.js/lib/languages/ini'),
  css: () => import('highlight.js/lib/languages/css'),
  xml: () => import('highlight.js/lib/languages/xml'),
  sql: () => import('highlight.js/lib/languages/sql'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  diff: () => import('highlight.js/lib/languages/diff'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
};
const pending = new Map<string, Promise<void>>();

export const render: CodeRenderer = async (source, language) => {
  if (!Object.prototype.hasOwnProperty.call(grammars, language)) throw new Error('Lenguaje no admitido.');
  if (!pending.has(language)) {
    pending.set(language, grammars[language]!().then(module => {
      hljs.registerLanguage(language, module.default);
    }).catch(error => {
      pending.delete(language);
      throw error;
    }));
  }
  await pending.get(language);
  // Input is literal text. Highlight.js escapes it and emits only token spans.
  return hljs.highlight(source, { language, ignoreIllegals: true }).value;
};
