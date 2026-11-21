// Hops the sequence walker takes besides plain `calls` edges (docs/sequence-view-spec.md §Links). Each builtin link set is
// a LinkProvider; `sequence.links` picks which ones run.
import type { GraphApi, GraphRelation, GraphSymbol, LinkSet } from '../rules/types';
import type { Call } from '../flowchart/cfg';
import { FUNCTION_KINDS } from '../flowchart';

/** Where the walk continues: `to` is followed when it is a function or method, else only drawn. */
export interface Hop {
  to: GraphSymbol;
  kind: 'http' | 'link';
  label: string;
  link: string;               // link set or rule ("http", "auth", "rule:<id>"), SequenceMessage.link
  certain: boolean;
}

export interface LinkContext {
  graph: GraphApi;
  outgoing: GraphRelation[];  // the function's `calls` relations (with metadata)
  statement: string;          // code of the statement holding the call ('' for hops before a body)
  symbols: (ids: string[]) => Map<string, GraphSymbol>; // cached lookups
}

/** A link set. `call` set: hops at that call site of `fn`, drawn instead of the plain call; `call` null: hops entered before
 * `fn`'s body (e.g. auth dependencies of a handler). */
export interface LinkProvider {
  name: LinkSet;
  hops(fn: GraphSymbol, call: Call | null, ctx: LinkContext): Hop[];
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

// shortcut: only `http` is implemented; auth, langgraph and events are accepted by the schema and follow in Phase 2
// (docs/sequence-view-plan.md) — register their providers here.
const PROVIDERS: Partial<Record<LinkSet, LinkProvider>> = { http: httpLinks };

export const linkProviders = (links: LinkSet[]): LinkProvider[] => links.flatMap(l => PROVIDERS[l] ?? []);
