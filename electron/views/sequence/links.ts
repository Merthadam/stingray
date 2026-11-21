// Hops the sequence walker takes besides plain `calls` edges (docs/sequence-view-spec.md §Links). Each builtin link set is
// a LinkProvider (the other sets in *-links.ts, registered in index.ts); link rules of the view become `rule:<id>` providers.
import path from 'node:path';
import type { Node, Tree } from 'web-tree-sitter';
import type { SourceRef } from '../../../src/views';
import type { FileProvider, GraphApi, GraphRelation, GraphSymbol } from '../rules/types';
import type { Call } from '../flowchart/cfg';
import { FUNCTION_KINDS, LANGUAGES } from '../flowchart';

/** Where the walk continues: `to` is followed when it is a function or method (and `follow` is not false), else only drawn. */
export interface Hop {
  to: GraphSymbol;
  kind: 'http' | 'link';
  label: string;
  link: string;               // link set or rule ("http", "auth", "rule:<id>"), SequenceMessage.link
  certain: boolean;
  follow?: false;             // drawn only (a LangGraph edge back to a node already on the path)
}
/** Hops in alternative arms (LangGraph conditional edges): an `alt` fragment with one arm per entry. */
export interface HopAlt { alt: { label: string; steps: HopStep[] }[]; source: SourceRef }
export type HopStep = Hop | HopAlt;

export interface LinkContext {
  graph: GraphApi;
  outgoing: GraphRelation[];  // the function's `calls` relations (with metadata)
  statement: string;          // code of the statement holding the call ('' for hops before a body)
  symbols: (ids: string[]) => Map<string, GraphSymbol>; // cached lookups
  resolve: (call: Call) => GraphSymbol | null;          // the repo function a call of this function resolves to
  tree: (file: string) => Promise<Tree | null>;         // parsed file (owned by the loader: do not delete)
  imports: (file: string) => Promise<Map<string, string>>; // fileImports of a file
  files: FileProvider;
  followable: (file: string) => boolean;
  memo: Map<string, unknown>; // per-walk cache of the providers, keys prefixed with the set name
}

/** A link set. `call` set: hops at that call site of `fn`, drawn instead of the plain call; `call` null: hops entered before
 * `fn`'s body (e.g. auth dependencies of a handler). */
export interface LinkProvider {
  name: string;
  hops(fn: GraphSymbol, call: Call | null, ctx: LinkContext): HopStep[] | Promise<HopStep[]>;
}

/** Tree-sitter node of a function symbol; null when its language is not supported or it is not found. */
export async function functionNode(fn: GraphSymbol, ctx: LinkContext): Promise<Node | null> {
  const language = LANGUAGES[path.posix.extname(fn.file).toLowerCase()];
  const tree = language ? await ctx.tree(fn.file) : null;
  return tree ? language.adapter.findFunction(tree.rootNode, fn.name, fn.line) : null;
}

/** Path without extension an import points to ("services/auth/deps" for `services.auth.deps` or `.deps` from
 * services/auth/api.py, "web/lib/auth" for "./lib/auth" from web/a.ts); null for packages. */
export function importBase(module: string, from: string): string | null {
  const dir = path.posix.dirname(from);
  if (module.includes('/')) return module.startsWith('.') ? path.posix.join(dir, module) : null;
  const dots = /^\.*/.exec(module)![0].length, rest = module.slice(dots).replaceAll('.', '/');
  return dots ? path.posix.join(dir, ...Array<string>(dots - 1).fill('..'), rest) : rest;
}

/** The repo symbol `name` means in `from`: defined in that file, else imported from a repo file, else the only one in the
 * repo. Null when it is ambiguous or imported from a library. */
export async function symbolNamed(name: string, from: string, ctx: LinkContext, kinds: Set<string> = FUNCTION_KINDS): Promise<GraphSymbol | null> {
  const all = ctx.graph.findSymbols(name).filter(s => kinds.has(s.kind));
  if (!all.length) return null;
  const local = all.find(s => s.file === from);
  if (local) return local;
  const imported = (await ctx.imports(from)).get(name);
  if (imported !== undefined) {
    // Python imports map to "<module>.<name>"; TS/JS imports to the module.
    const module = imported.includes('/') || !imported.includes('.') ? imported : imported.slice(0, imported.lastIndexOf('.'));
    const base = importBase(module, from);
    const strip = (f: string) => f.replace(/\.[^./]+$/, '');
    const hit = base === null ? undefined : all.find(s => [base, `${base}/index`, `${base}/__init__`].includes(strip(s.file)));
    if (hit) return hit;
    // From a library (neither relative nor a top-level directory of the repo): not ours.
    if (!imported.startsWith('.') && !all.some(s => s.file.startsWith(imported.split(/[./]/)[0] + '/'))) return null;
  }
  return all.length === 1 ? all[0] : null;
}

/** `__call__` of a class (a callable instance like a LangGraph node object), null when it has none. */
export function callMethod(cls: GraphSymbol, graph: GraphApi): GraphSymbol | null {
  return graph.fileSymbols(cls.file).filter(s => s.name === '__call__' && FUNCTION_KINDS.has(s.kind) && s.line > cls.line
    && (cls.endLine === undefined || s.line <= cls.endLine)).sort((a, b) => a.line - b.line)[0] ?? null;
}

/** Client call -> route -> handler: stinggraph's `calls` edge to a `route` node (metadata channel http, method, href) and
 * the route's `references` edge to its handler. */
export const httpLinks: LinkProvider = {
  name: 'http',
  hops(_fn, call, ctx) {
    if (!call) return [];
    const http = ctx.outgoing.filter(r => r.meta?.channel === 'http' && (r.meta.callee === undefined || r.meta.callee === call.callee));
    let rels = http.filter(r => r.line === call.line);
    // stinggraph keeps one edge per function and route: a second call to the same URL is found by its literal path.
    if (!rels.length) rels = http.filter(r => typeof r.meta!.href === 'string' && ['"', "'", '`'].some(q => ctx.statement.includes(`${q}${r.meta!.href}${q}`)));
    const routes = [...new Map(rels.map(r => [r.to, r])).values()];
    const found = ctx.symbols(routes.map(r => r.to));
    return routes.flatMap(r => {
      const route = found.get(r.to);
      if (!route) return [];
      const handlers = ctx.symbols(ctx.graph.outgoing([route.id], ['references']).map(x => x.to));
      const handler = [...handlers.values()].find(s => FUNCTION_KINDS.has(s.kind));
      const { method, href } = r.meta as { method?: unknown; href?: unknown };
      const label = typeof href === 'string' ? `${typeof method === 'string' ? method + ' ' : ''}${href}` : route.name;
      // The route match itself is the link: drawn certain even though stinggraph marks the synthesized edge heuristic.
      return [{ to: handler ?? route, kind: 'http' as const, label, link: 'http', certain: true }];
    });
  },
};

/** A `kind: link` edge of a view rule: `from`/`to` are symbol names or `name@file`. */
export interface RuleLink { rule: string; from: string; to: string; label: string | null; certain: boolean; source: SourceRef }

const nameOf = (ref: string) => ref.split('@')[0];
const fileOf = (ref: string): string | undefined => ref.includes('@') ? ref.slice(ref.indexOf('@') + 1) : undefined;

/** Link rules: when the walk enters a function named `from` it continues at `to` before the body; a call to `from` that
 * does not resolve into the repo (a library dispatcher) is drawn as the hop to `to` instead. */
export function ruleLinks(links: RuleLink[]): LinkProvider[] {
  const ids = [...new Set(links.map(l => l.rule))];
  return ids.map(rule => {
    const mine = links.filter(l => l.rule === rule);
    const hopsTo = (l: RuleLink, ctx: LinkContext): Hop[] => {
      const file = fileOf(l.to);
      const found = ctx.graph.findSymbols(nameOf(l.to), file);
      const fns = found.filter(s => FUNCTION_KINDS.has(s.kind));
      const to = fns.length === 1 ? fns[0] : fns.find(s => s.file === l.source.file) ?? (found.length === 1 ? found[0] : undefined);
      return to ? [{ to, kind: 'link', label: l.label ?? nameOf(l.to), link: `rule:${rule}`, certain: l.certain }] : [];
    };
    const seen = (l: RuleLink, i: number, all: RuleLink[]) => all.findIndex(x => x.from === l.from && x.to === l.to) === i;
    return {
      name: `rule:${rule}`,
      hops(fn, call, ctx) {
        if (call) {
          if (ctx.resolve(call)) return [];
          return mine.filter(l => nameOf(l.from) === call.callee && fileOf(l.from) === undefined).filter(seen).flatMap(l => hopsTo(l, ctx));
        }
        return mine.filter(l => nameOf(l.from) === fn.name && (fileOf(l.from) ?? fn.file) === fn.file).filter(seen).flatMap(l => hopsTo(l, ctx));
      },
    };
  });
}
