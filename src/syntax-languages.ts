// Keep the code-class allowlist in document.rs in sync with these names/aliases.
const aliases: Readonly<Record<string, string>> = {
  javascript: 'javascript', js: 'javascript', jsx: 'javascript',
  typescript: 'typescript', ts: 'typescript', tsx: 'typescript',
  python: 'python', py: 'python', rust: 'rust', rs: 'rust',
  bash: 'bash', sh: 'bash', shell: 'bash', json: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  css: 'css', html: 'xml', xml: 'xml', svg: 'xml',
  sql: 'sql', c: 'c', cpp: 'cpp', 'c++': 'cpp',
  go: 'go', java: 'java', csharp: 'csharp', cs: 'csharp',
  diff: 'diff', markdown: 'markdown', md: 'markdown', dockerfile: 'dockerfile',
};

export function codeLanguage(element: HTMLElement): string | undefined {
  for (const name of element.classList) {
    if (!name.startsWith('language-')) continue;
    const language = name.slice('language-'.length);
    if (Object.prototype.hasOwnProperty.call(aliases, language)) return aliases[language];
  }
}
