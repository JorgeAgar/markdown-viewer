declare global {
  interface Window {
    __syntaxLoads?: number;
    __renderCodeForTests?: (source: string, language: string) => Promise<string>;
  }
}

window.__syntaxLoads = (window.__syntaxLoads ?? 0) + 1;

export async function render(source: string, language: string): Promise<string> {
  if (!window.__renderCodeForTests) throw new Error('Unexpected syntax render');
  return window.__renderCodeForTests(source, language);
}
