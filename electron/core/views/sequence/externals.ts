// External systems of a sequence (DB, cloud, auth, LLM, HTTP): calls the code graph cannot resolve into the repo, matched
// by the module their receiver/callee is imported from (tree-sitter imports of the file), else by the call text prefix.
import type { Node } from 'web-tree-sitter';
import type { Call } from '../flowchart/cfg';
import { named } from '../flowchart/cfg';

/** Module prefix -> lifeline label. A prefix matches the module itself and its submodules (`.` or `/`); `*` = any suffix. */
export const BUILTIN_EXTERNALS: Record<string, string> = {
  sqlalchemy: 'Database', psycopg: 'Database', psycopg2: 'Database', prisma: 'Database', '@prisma': 'Database', pg: 'Database', mongoose: 'Database',
  redis: 'Redis',
  boto3: 'AWS', botocore: 'AWS', '@aws-sdk': 'AWS',
  cognito: 'Cognito', 'amazon-cognito*': 'Cognito',
  jwt: 'JWT', jsonwebtoken: 'JWT', jose: 'JWT', passlib: 'Password hashing', bcrypt: 'Password hashing', bcryptjs: 'Password hashing',
  openai: 'OpenAI', anthropic: 'Anthropic', '@anthropic-ai': 'Anthropic', 'langchain*': 'LangChain', '@langchain': 'LangChain',
  fetch: 'External HTTP', axios: 'External HTTP', requests: 'External HTTP', httpx: 'External HTTP',
};

const matches = (module: string, prefix: string) => prefix.endsWith('*') ? module.startsWith(prefix.slice(0, -1))
  : module === prefix || module.startsWith(prefix + '.') || module.startsWith(prefix + '/');

/** Label of the external system `module` belongs to; the view's `externals:` win over the builtin prefixes. */
export function externalOf(module: string, extra: Record<string, string>): string | null {
  for (const table of [extra, BUILTIN_EXTERNALS]) {
    // Longest prefix first, so `@aws-sdk/client-cognito` can be told apart from `@aws-sdk` by a view.
    const hit = Object.keys(table).sort((a, b) => b.length - a.length).find(p => matches(module, p));
    if (hit) return table[hit];
  }
  return null;
}

/** External system a call leaves to, or null. Relative imports are repo code, never external. */
export function externalCall(call: Call, imports: Map<string, string>, extra: Record<string, string>): string | null {
  const root = /^[\w$@]+/.exec(call.path.replace(/^(?:self|this)\??\./, ''))?.[0] ?? call.callee;
  const module = imports.get(root) ?? imports.get(call.callee);
  if (module !== undefined) return module.startsWith('.') ? null : externalOf(module, extra);
  return externalOf(call.path, extra);
}

const unquote = (s: string) => s.replace(/^['"`]|['"`]$/g, '');

/** Top-level imports of a file: local name -> module ("jwt" -> "jose.jwt", "axios" -> "axios", "S3Client" -> "@aws-sdk/client-s3"). */
export function fileImports(root: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of named(root)) {
    // Python
    if (n.type === 'import_statement' && !n.childForFieldName('source')) {
      for (const c of n.childrenForFieldName('name')) {
        if (c?.type === 'aliased_import') out.set(c.childForFieldName('alias')!.text, c.childForFieldName('name')!.text);
        else if (c) out.set(c.text.split('.')[0], c.text);
      }
    } else if (n.type === 'import_from_statement') {
      const module = n.childForFieldName('module_name')?.text ?? '';
      for (const c of n.childrenForFieldName('name')) {
        if (c?.type === 'aliased_import') out.set(c.childForFieldName('alias')!.text, `${module}.${c.childForFieldName('name')!.text}`);
        else if (c) out.set(c.text, `${module}.${c.text}`);
      }
    // TypeScript / JavaScript
    } else if (n.type === 'import_statement') {
      const module = unquote(n.childForFieldName('source')!.text);
      const clause = named(n).find(c => c.type === 'import_clause');
      for (const c of named(clause)) {
        if (c.type === 'identifier') out.set(c.text, module);
        else if (c.type === 'namespace_import') { const id = named(c).find(x => x.type === 'identifier'); if (id) out.set(id.text, module); }
        else if (c.type === 'named_imports') for (const s of named(c).filter(x => x.type === 'import_specifier')) {
          out.set((s.childForFieldName('alias') ?? s.childForFieldName('name'))!.text, module);
        }
      }
    } else if (n.type === 'lexical_declaration' || n.type === 'variable_declaration') {
      for (const d of named(n).filter(x => x.type === 'variable_declarator')) {
        const value = d.childForFieldName('value');
        if (value?.type !== 'call_expression' || value.childForFieldName('function')?.text !== 'require') continue;
        const arg = named(value.childForFieldName('arguments'))[0];
        if (arg?.type !== 'string') continue;
        const target = d.childForFieldName('name')!;
        const locals = target.type === 'identifier' ? [target.text] : target.text.match(/[\w$]+(?=\s*[,}])/g) ?? [];
        for (const l of locals) out.set(l, unquote(arg.text));
      }
    }
  }
  return out;
}
