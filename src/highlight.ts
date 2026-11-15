import Prism from 'prismjs/components/prism-core.js';
import 'prismjs/components/prism-markup.js';
import 'prismjs/components/prism-css.js';
import 'prismjs/components/prism-clike.js';
import 'prismjs/components/prism-javascript.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-jsx.js';
import 'prismjs/components/prism-tsx.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-yaml.js';
import 'prismjs/components/prism-markdown.js';
import 'prismjs/components/prism-go.js';
import 'prismjs/components/prism-rust.js';
import 'prismjs/components/prism-sql.js';
import 'prismjs/components/prism-toml.js';

export type HighlightToken = { text: string; type: string };
const languages: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', css: 'css', html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', py: 'python', sh: 'bash', bash: 'bash',
  yaml: 'yaml', yml: 'yaml', md: 'markdown', markdown: 'markdown', go: 'go', rs: 'rust', sql: 'sql', toml: 'toml',
};

// Flatten nested tokens into text-only rows, retaining styles across newlines.
export function splitTokenLines(tokens: (string | Prism.Token)[]): HighlightToken[][] {
  const lines: HighlightToken[][] = [[]];
  function append(token: string | Prism.Token, type = '') {
    if (typeof token !== 'string') {
      const types = [type, token.type, ...[token.alias || []].flat()].filter(Boolean).join(' ');
      for (const child of Array.isArray(token.content) ? token.content : [token.content]) append(child, types);
      return;
    }
    token.split('\n').forEach((text, index) => {
      if (index) lines.push([]);
      if (text) lines.at(-1)!.push({ text, type });
    });
  }
  tokens.forEach(token => append(token));
  return lines;
}

export function highlightLines(content: string, path: string, diff = false): HighlightToken[][] {
  const grammar = Prism.languages[languages[path.split('.').at(-1)!.toLowerCase()]];
  // shortcut: large files stay plain text; revisit if highlighting moves off the UI thread.
  if (!grammar || new TextEncoder().encode(content).length > 200 * 1024) return splitTokenLines([content]);
  if (!diff) return splitTokenLines(Prism.tokenize(content, grammar));
  return content.split('\n').map(line => {
    if (!/^[+\- ]/.test(line) || line.startsWith('+++') || line.startsWith('---')) return [{ text: line, type: '' }];
    return [{ text: line[0], type: '' }, ...splitTokenLines(Prism.tokenize(line.slice(1), grammar))[0]];
  });
}
