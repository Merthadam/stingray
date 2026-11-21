// `langgraph` link set: `x.invoke/ainvoke/stream/astream(…)` on a compiled LangGraph StateGraph enters the graph: START ->
// node handlers in edge order, conditional edges as an `alt` over their targets (path-map key, else the router's condition),
// END stops, an edge back to a node already on the path is drawn once as "(loop)". Graphs come from the `langgraph`
// builtin set's queries (sets/langgraph.ts) and router analysis (sets/langgraph-routers.ts), run on the files concerned.
import path from 'node:path';
import { Query, type Language, type Node, type Tree } from 'web-tree-sitter';
import type { GraphSymbol, Rule } from '../rules/types';
import { parseRuleFileYaml } from '../rules/schema';
import { renderTemplate, templateCaptures } from '../rules/template';
import { BUILTIN_SETS } from '../sets';
import { LangGraphRouters } from '../sets/langgraph-routers';
import { named } from '../flowchart/cfg';
import { truncate } from '../flowchart/labels';
import { FUNCTION_KINDS } from '../flowchart';
import { callMethod, importBase, symbolNamed, type Hop, type HopStep, type LinkContext, type LinkProvider } from './links';

const INVOKE = new Set(['invoke', 'ainvoke', 'stream', 'astream']);
const MAX_STEPS = 60; // node visits per invocation (alt arms each walk their own path)
/** Receiver names that read like a compiled graph, for the "only graph in scope" fallback. */
const GRAPHISH = /graph|workflow|agent|app|compiled|flow|chain|pipeline/i;

interface GraphNode { fn: string | null; handler: string | null }
interface GraphEdge { from: string; to: string; kind: string; label: string | null; line: number; at: number }
interface StateGraph { file: string; nodes: Map<string, GraphNode>; edges: GraphEdge[] }
interface FileGraphs {
  graphs: StateGraph[];
  compiled: Map<string, StateGraph>;  // `self.app = flow.compile()`: target text -> graph
  builders: Map<string, StateGraph>;  // `def build(): …; return flow.compile()`: function name -> graph
}

let rules: Rule[] | null = null;
const queries = new WeakMap<Language, Query[]>(); // one compile per grammar for the process lifetime, like the languages
function compiledQueries(language: Language): Query[] {
  rules ??= parseRuleFileYaml(BUILTIN_SETS.langgraph.yaml, null, 'langgraph', 'builtin/langgraph').rules.map(r => r.rule);
  let q = queries.get(language);
  if (!q) queries.set(language, q = rules.map(r => new Query(language, r.query)));
  return q;
}

/** The StateGraphs built in one file (nodes, edges in source order) and how they are compiled. */
function extract(file: string, tree: Tree): FileGraphs {
  const byVar = new Map<string, StateGraph>();
  const graph = (v: string) => { let g = byVar.get(v); if (!g) byVar.set(v, g = { file, nodes: new Map(), edges: [] }); return g; };
  compiledQueries(tree.language).forEach((query, i) => {
    const { emit } = rules![i];
    const templates = 'node' in emit ? [emit.node.id, emit.node.subtitle ?? '', emit.node.detail ?? ''] : 'edge' in emit ? [emit.edge.from, emit.edge.to, emit.edge.label ?? ''] : [];
    for (const match of query.matches(tree.rootNode)) {
      const byName = new Map<string, Node[]>();
      for (const c of match.captures) byName.set(c.name, [...byName.get(c.name) ?? [], c.node]);
      const graphVar = byName.get('graph')?.[0].text;
      if (!graphVar) continue;
      const g = graph(graphVar), prefix = `${file}:${graphVar}:`;
      if ('group' in emit) continue; // the StateGraph(...) assignment: registered above
      // Quantified captures (`add_edge([a, b], c)`) emit once per node, like the engine.
      let combos = [new Map([['file', file]])];
      for (const name of new Set(templates.flatMap(templateCaptures))) {
        const nodes = byName.get(name);
        if (nodes) combos = combos.flatMap(values => nodes.map(n => new Map(values).set(name, n.text)));
      }
      const first = Math.min(...match.captures.map(c => c.node.startIndex));
      const line = Math.min(...match.captures.map(c => c.node.startPosition.row)) + 1;
      for (const values of combos) {
        const r = (t: string | undefined) => t === undefined ? null : renderTemplate(t, values) || null;
        const strip = (id: string | null) => id?.startsWith(prefix) ? id.slice(prefix.length) : null;
        if ('node' in emit) {
          const name = strip(r(emit.node.id));
          if (!name) continue;
          const n = g.nodes.get(name) ?? { fn: null, handler: null };
          n.fn ??= r(emit.node.subtitle); n.handler ??= r(emit.node.detail);
          g.nodes.set(name, n);
        } else if ('edge' in emit) {
          const from = strip(r(emit.edge.from)), to = strip(r(emit.edge.to));
          if (from && to) g.edges.push({ from, to, kind: r(emit.edge.kind) ?? 'next', label: r(emit.edge.label), line, at: byName.get('to')?.[0].startIndex ?? first });
        }
      }
    }
  });
  // Conditional edges without a path map: the router's literal returns (same file).
  const routers = new LangGraphRouters(() => {}, 5000);
  routers.collect(file, tree.rootNode);
  for (const call of routers.branches()) {
    const graphVar = call.from.slice(file.length + 1).split(':')[0], g = byVar.get(graphVar), prefix = `${file}:${graphVar}:`;
    const from = call.from.slice(prefix.length);
    if (!g || g.edges.some(e => e.kind === 'branch' && e.from === from && e.line === call.line)) continue;
    call.branches.forEach((b, i) => g.edges.push({ from, to: b.to.slice(prefix.length), kind: 'branch', label: b.label, line: call.line, at: Number.MAX_SAFE_INTEGER - 1000 + i }));
  }
  for (const g of byVar.values()) g.edges.sort((a, b) => a.at - b.at);

  const out: FileGraphs = { graphs: [...byVar.values()], compiled: new Map(), builders: new Map() };
  const compileOf = (value: Node | null) => {
    const fn = value?.type === 'call' ? value.childForFieldName('function') : null;
    return fn?.type === 'attribute' && fn.childForFieldName('attribute')?.text === 'compile' ? byVar.get(fn.childForFieldName('object')!.text) : undefined;
  };
  const visit = (n: Node, fn: string | null) => {
    if (n.type === 'assignment') { const g = compileOf(n.childForFieldName('right')); if (g) out.compiled.set(n.childForFieldName('left')!.text, g); }
    if (n.type === 'return_statement' && fn) { const g = compileOf(named(n)[0] ?? null); if (g) out.builders.set(fn, g); }
    const inner = n.type === 'function_definition' ? n.childForFieldName('name')?.text ?? fn : fn;
    named(n).forEach(c => visit(c, inner));
  };
  visit(tree.rootNode, null);
  return out;
}

async function graphsOf(file: string, ctx: LinkContext): Promise<FileGraphs | null> {
  const key = `langgraph:${file}`;
  if (!ctx.memo.has(key)) ctx.memo.set(key, (async () => {
    const tree = path.posix.extname(file) === '.py' ? await ctx.tree(file) : null;
    return tree && tree.rootNode.text.includes('StateGraph') ? extract(file, tree) : null;
  })());
  return ctx.memo.get(key) as Promise<FileGraphs | null>;
}

/** The compiled graph a receiver ("self.app", "graph", "build_graph()") stands for; certain unless only guessed. */
async function graphFor(receiver: string, fn: GraphSymbol, ctx: LinkContext): Promise<{ graph: StateGraph; certain: boolean } | null> {
  const here = await graphsOf(fn.file, ctx);
  const compiled = here?.compiled.get(receiver);
  if (compiled) return { graph: compiled, certain: true };
  // `build_graph().invoke(…)`: a function returning `flow.compile()`.
  const builder = /^(?:[\w.]+\.)?(\w+)\(.*\)$/.exec(receiver)?.[1];
  if (builder) {
    const s = await symbolNamed(builder, fn.file, ctx);
    const g = s && (await graphsOf(s.file, ctx))?.builders.get(builder);
    if (g) return { graph: g, certain: true };
  }
  // An imported compiled graph: `from .graph import app` … `app.invoke(…)`.
  const root = /^\w+/.exec(receiver)?.[0];
  const imported = root ? (await ctx.imports(fn.file)).get(root) : undefined;
  const base = imported && !imported.includes('/') ? importBase(imported.slice(0, imported.lastIndexOf('.')), fn.file) : null;
  for (const file of base ? [`${base}.py`, `${base}/__init__.py`] : []) {
    const g = (await graphsOf(file, ctx))?.compiled.get(root!);
    if (g) return { graph: g, certain: true };
  }
  // Else the one StateGraph with nodes in scope, when the receiver reads like a graph.
  if (!GRAPHISH.test(receiver.split('.').at(-1) ?? '')) return null;
  const key = 'langgraph:all';
  if (!ctx.memo.has(key)) ctx.memo.set(key, (async () => {
    const { files } = await ctx.files.list(f => f.endsWith('.py') && ctx.followable(f));
    const all: StateGraph[] = [];
    for (const file of files) {
      if (!(await ctx.files.read(file))?.includes('StateGraph')) continue;
      all.push(...(await graphsOf(file, ctx))?.graphs.filter(g => g.nodes.size) ?? []);
    }
    return all;
  })());
  const all = await (ctx.memo.get(key) as Promise<StateGraph[]>);
  return all.length === 1 ? { graph: all[0], certain: false } : null;
}

/** The function a node runs: `fn` (same file / imported / unique), `self.method`, or the `__call__` of a node class. */
async function handlerOf(node: GraphNode, file: string, ctx: LinkContext): Promise<GraphSymbol | null> {
  if (!node.fn) return null;
  if (node.handler?.startsWith('self.')) return ctx.graph.findSymbols(node.fn, file).find(s => FUNCTION_KINDS.has(s.kind)) ?? null;
  const s = await symbolNamed(node.fn, file, ctx, new Set([...FUNCTION_KINDS, 'class']));
  return s?.kind === 'class' ? callMethod(s, ctx.graph) : s;
}

async function graphSteps(g: StateGraph, ctx: LinkContext, certain: boolean): Promise<HopStep[]> {
  const handlers = new Map<string, GraphSymbol | null>();
  for (const [name, n] of g.nodes) handlers.set(name, await handlerOf(n, g.file, ctx));
  let budget = MAX_STEPS;
  const hop = (to: GraphSymbol, label: string, follow = true): Hop => ({ to, kind: 'link', label, link: 'langgraph', certain, ...(follow ? {} : { follow: false as const }) });
  const after = (from: string, onPath: string[]): HopStep[] => {
    const outs = g.edges.filter(e => e.from === from), out: HopStep[] = [];
    for (const e of outs) if (e.kind !== 'branch') out.push(...visit(e.to, onPath));
    const branches = outs.filter(e => e.kind === 'branch');
    if (branches.length) {
      const arms = new Map<string, string[]>(); // target -> path-map keys / conditions
      for (const e of branches) arms.set(e.to, [...arms.get(e.to) ?? [], e.label ?? e.to]);
      out.push({ alt: [...arms].map(([to, labels]) => ({ label: truncate(labels.join(' / ')), steps: visit(to, onPath) })), source: { file: g.file, line: branches[0].line } });
    }
    return out;
  };
  const visit = (name: string, onPath: string[]): HopStep[] => {
    if (name === 'END' || name === '__end__' || budget-- <= 0) return [];
    const to = handlers.get(name);
    if (onPath.includes(name)) return to ? [hop(to, `${name} (loop)`, false)] : [];
    return [...to ? [hop(to, name)] : [], ...after(name, [...onPath, name])];
  };
  return after('START', []);
}

export const langgraphLinks: LinkProvider = {
  name: 'langgraph',
  async hops(fn, call, ctx) {
    if (!call || !INVOKE.has(call.callee) || path.posix.extname(fn.file) !== '.py' || ctx.resolve(call)) return [];
    const receiver = call.path.slice(0, -(call.callee.length + 1));
    const found = receiver ? await graphFor(receiver, fn, ctx) : null;
    return found ? graphSteps(found.graph, ctx, found.certain) : [];
  },
};
