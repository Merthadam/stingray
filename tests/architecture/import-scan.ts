// Import scanner for the architecture tests: files of electron/, shared/, src/, agents/; specifiers with line and
// type-only flag; layer of every file; the layer rules of docs/specs/2026-11-23-04-hexagonal-modules-design.md.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** names: imported (pre-`as`) binding names; '*' for namespace, `export *`, dynamic and `import x = require()`. */
export type ImportRef = { file: string; line: number; specifier: string; target: string | null; typeOnly: boolean; names: string[] };
export type Layer = { kind: 'entry' | 'app' | 'core' | 'driving' | 'driven' | 'shared' | 'renderer-app' | 'renderer-feature' | 'renderer-shared' | 'agents' | 'other'; group?: string };

const ROOTS = ['electron', 'shared', 'src', 'agents'];
export function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); } else if (/\.tsx?$/.test(e.name)) out.push(rel);
    }
  };
  for (const root of ROOTS) if (existsSync(root)) walk(root);
  return out.sort();
}

const STATIC = /^[ \t]*(?:import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s*from\s*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC = /(typeof\s+)?\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
const IMPORT_REQUIRE = /^[ \t]*(?:export\s+)?import\s+(type\s+)?[\w$]+\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm;

/** Blanks comments (keeping line breaks) so commented-out code and prose are not read as code; with
 * alsoStrings also the contents of strings, templates and regex literals. Quotes and regexes end at a newline. */
export function blankComments(source: string, alsoStrings = false): string {
  const out = source.split(''), n = source.length, templates: number[] = []; // open-brace depth per enclosing `${`
  const hide = (from: number, to: number) => { for (let k = from; k < Math.min(to, n); k++) if (out[k] !== '\n') out[k] = ' '; };
  // Template text from j up to the closing backtick or the next `${`; returns where code resumes.
  const template = (j: number) => {
    let end = j;
    while (end < n && source[end] !== '`' && !(source[end] === '$' && source[end + 1] === '{')) end += source[end] === '\\' ? 2 : 1;
    if (alsoStrings) hide(j, end);
    if (source[end] === '$') { templates.push(0); return end + 2; }
    return end + 1;
  };
  let i = 0, prev = ''; // prev: last non-space code character, to tell a regex from a division
  while (i < n) {
    const c = source[i], d = source[i + 1];
    if (c === '/' && d === '/') { const end = source.indexOf('\n', i), stop = end < 0 ? n : end; hide(i, stop); i = stop; continue; }
    if (c === '/' && d === '*') { const end = source.indexOf('*/', i + 2); const stop = end < 0 ? n : end + 2; hide(i, stop); i = stop; continue; }
    if (c === "'" || c === '"' || (c === '/' && (prev === '' || '(,=:[!&|?{};'.includes(prev)))) {
      let j = i + 1, inClass = false;
      while (j < n && source[j] !== '\n' && (source[j] !== c || inClass)) {
        if (c === '/' && (source[j] === '[' || source[j] === ']')) inClass = source[j] === '[';
        j += source[j] === '\\' ? 2 : 1;
      }
      if (alsoStrings) hide(i + 1, j);
      i = j + 1; prev = c; continue;
    }
    if (c === '`') { i = template(i + 1); prev = '`'; continue; }
    if (templates.length && c === '{') templates[templates.length - 1]++;
    if (templates.length && c === '}' && templates[templates.length - 1]-- === 0) { templates.pop(); i = template(i + 1); prev = '`'; continue; }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}
const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;
const allTypeBindings = (bindings: string) => bindings.startsWith('{') &&
  bindings.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).every(s => s.startsWith('type '));
const bindingNames = (bindings: string) => {
  const [first, named = ''] = bindings.startsWith('{') ? ['', bindings] : bindings.split(/\s*,\s*(?=[{*])/);
  const names = named.startsWith('{') ? named.slice(1, -1).split(',').map(s => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean) : named ? ['*'] : [];
  return [...(first.startsWith('*') ? ['*'] : first ? ['default'] : []), ...names];
};

export function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // package or node builtin
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return base; // reported as unresolved
}

export function importsOf(file: string, source = readFileSync(file, 'utf8')): ImportRef[] {
  const text = blankComments(source), refs: ImportRef[] = [];
  const add = (index: number, specifier: string, typeOnly: boolean, names: string[]) => refs.push({ file, line: lineAt(text, index), specifier, target: resolveImport(file, specifier), typeOnly, names });
  for (const m of text.matchAll(STATIC)) add(m.index!, m[3], Boolean(m[1]) || allTypeBindings(m[2]), bindingNames(m[2]));
  for (const m of text.matchAll(SIDE_EFFECT)) add(m.index!, m[1], false, []);
  for (const m of text.matchAll(DYNAMIC)) add(m.index!, m[2], Boolean(m[1]), ['*']);
  for (const m of text.matchAll(IMPORT_REQUIRE)) add(m.index!, m[2], Boolean(m[1]), ['*']);
  return refs;
}

export function layerOf(file: string): Layer {
  let m: RegExpExecArray | null;
  if (file === 'electron/main.ts') return { kind: 'entry' };
  if (file.startsWith('electron/app/')) return { kind: 'app' };
  if ((m = /^electron\/core\/([^/]+)\//.exec(file))) return { kind: 'core', group: m[1] };
  if ((m = /^electron\/adapters\/driving\/([^/]+)\//.exec(file))) return { kind: 'driving', group: m[1] };
  if ((m = /^electron\/adapters\/driven\/([^/]+)\//.exec(file))) return { kind: 'driven', group: m[1] };
  if (file.startsWith('shared/')) return { kind: 'shared' };
  if (file.startsWith('src/app/')) return { kind: 'renderer-app' };
  if ((m = /^src\/features\/([^/]+)\//.exec(file))) return { kind: 'renderer-feature', group: m[1] };
  if (file.startsWith('src/shared/')) return { kind: 'renderer-shared' };
  if (file.startsWith('agents/')) return { kind: 'agents' };
  return { kind: 'other' };
}

const CORE_PACKAGES = new Set(['zod', 'yaml']);
const packageName = (s: string) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
const isIndex = (file: string, dir: string) => file === `${dir}/index.ts` || file === `${dir}/index.tsx`;
const renderer = (k: Layer['kind']) => k === 'renderer-app' || k === 'renderer-feature' || k === 'renderer-shared';

/** The broken rule, or null when the import is allowed. Type-only imports skip package rules, never layer rules. */
export function violation(from: string, specifier: string, target: string | null, typeOnly: boolean, exists: (file: string) => boolean = existsSync): string | null {
  const a = layerOf(from);
  if (a.kind === 'other') return 'file is in no layer';
  if (target === null) {
    if (a.kind === 'entry') return 'electron/main.ts imports only electron/app/index.ts';
    if (a.kind === 'core') return typeOnly || CORE_PACKAGES.has(packageName(specifier)) ? null : 'core imports only zod and yaml at runtime';
    if (a.kind === 'shared') return typeOnly || packageName(specifier) === 'zod' ? null : 'shared/ imports only zod at runtime';
    return null;
  }
  if (!exists(target)) return 'unresolved relative import';
  const b = layerOf(target);
  switch (a.kind) {
    case 'entry': return target === 'electron/app/index.ts' ? null : 'electron/main.ts imports only electron/app/index.ts';
    case 'app': return renderer(b.kind) || b.kind === 'agents' ? 'electron/app imports only electron/ and shared/' : null;
    case 'core':
      if (b.kind === 'shared') return null;
      if (b.kind !== 'core') return 'core imports only core and shared/';
      if (b.group === a.group || b.group === 'shared') return null;
      return isIndex(target, `electron/core/${b.group}`) ? null : 'core features import each other only via index.ts';
    case 'driving':
    case 'driven':
      if (b.kind === 'shared') return null;
      if (b.kind === 'core') {
        const ok = b.group === 'shared' || isIndex(target, `electron/core/${b.group}`) || (a.kind === 'driven' && target === `electron/core/${b.group}/ports.ts`);
        return ok ? null : 'adapters import core via index.ts (driven also ports.ts)';
      }
      if (b.kind === a.kind && b.group === a.group) return null;
      if (b.kind === 'driving' || b.kind === 'driven') return 'adapters never import another adapter folder';
      return b.kind === 'app' ? 'only electron/app imports adapters, never the reverse' : 'adapters never import src/ or agents/';
    case 'shared': return b.kind === 'shared' ? null : 'shared/ imports nothing from electron/, src/, agents/';
    case 'renderer-app':
    case 'renderer-feature':
    case 'renderer-shared':
      if (b.kind === 'shared') return null;
      if (!renderer(b.kind)) return 'src/ never imports electron/ or agents/';
      // demo.ts is loaded under node (tests/app/contracts.test.ts), where component and CSS imports fail.
      if (/^src\/features\/[^/]+\/demo\.ts$/.test(from) && /\.(tsx|css)$/.test(target)) return 'demo.ts imports no components and no CSS';
      if (a.kind === 'renderer-shared' && b.kind !== 'renderer-shared') return 'src/shared imports no feature and no app';
      if (b.kind === 'renderer-feature' && !(a.kind === 'renderer-feature' && a.group === b.group) && !isIndex(target, `src/features/${b.group}`) && target !== `src/features/${b.group}/demo.ts`) return 'other features only via src/features/<f>/index.ts (or demo.ts)';
      return null;
    case 'agents': return b.kind === 'shared' || b.kind === 'agents' ? null : 'agents/ imports only shared/ and packages';
  }
  return null;
}
