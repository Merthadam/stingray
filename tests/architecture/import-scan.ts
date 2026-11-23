// Import scanner for the architecture tests: files of electron/, shared/, src/, agents/; specifiers with line and
// type-only flag; layer of every file; the layer rules of docs/specs/2026-11-23-04-hexagonal-modules-design.md.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type ImportRef = { file: string; line: number; specifier: string; target: string | null; typeOnly: boolean };
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
const DYNAMIC = /(typeof\s+)?\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
// Comments are blanked (keeping line numbers) so commented-out code and prose are not read as imports.
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/^[ \t]*\/\/.*$/gm, '');
const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;
const allTypeBindings = (bindings: string) => bindings.startsWith('{') &&
  bindings.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).every(s => s.startsWith('type '));

export function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // package or node builtin
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return base; // reported as unresolved
}

export function importsOf(file: string, source = readFileSync(file, 'utf8')): ImportRef[] {
  const text = stripComments(source), refs: ImportRef[] = [];
  const add = (index: number, specifier: string, typeOnly: boolean) => refs.push({ file, line: lineAt(text, index), specifier, target: resolveImport(file, specifier), typeOnly });
  for (const m of text.matchAll(STATIC)) add(m.index!, m[3], Boolean(m[1]) || allTypeBindings(m[2]));
  for (const m of text.matchAll(SIDE_EFFECT)) add(m.index!, m[1], false);
  for (const m of text.matchAll(DYNAMIC)) add(m.index!, m[2], Boolean(m[1]));
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
