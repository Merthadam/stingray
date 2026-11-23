// `kind: flowchart` views: resolve the entry function through the code graph, parse it (and expanded callees) with
// tree-sitter and draw its control flow. Pure apart from reading files through the FileProvider; code is never run.
import path from 'node:path';
import type { Tree } from 'web-tree-sitter';
import type { DiagramEdge, DiagramGroup, DiagramNode, FlowchartDiagnostic, ViewWarning } from '../../../shared/contracts/views';
import type { FileProvider, FlowchartStep, GraphApi, GraphSymbol } from '../rules/types';
import { FlowchartBuilder, type Loaded } from './build';
import type { Adapter } from './cfg';
import { python } from './python';
import { typescript } from './typescript';

/** Parse `text` with a grammar from grammars.ts (null: parse cancelled after the time budget). Throws when the grammar is missing. */
export type ParseText = (language: string, text: string) => Promise<Tree | null>;

export interface FlowchartOutput {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  warnings: ViewWarning[];
  diagnostic: FlowchartDiagnostic;
  truncated: boolean;
}

/** File extension -> grammar and adapter (v1: Python and TypeScript/TSX/JavaScript). */
export const LANGUAGES: Record<string, { grammar: string; adapter: Adapter }> = {
  '.py': { grammar: 'python', adapter: python },
  '.ts': { grammar: 'typescript', adapter: typescript }, '.mts': { grammar: 'typescript', adapter: typescript }, '.cts': { grammar: 'typescript', adapter: typescript },
  '.tsx': { grammar: 'tsx', adapter: typescript },
  '.js': { grammar: 'javascript', adapter: typescript }, '.mjs': { grammar: 'javascript', adapter: typescript },
  '.cjs': { grammar: 'javascript', adapter: typescript }, '.jsx': { grammar: 'javascript', adapter: typescript },
};
export const FUNCTION_KINDS = new Set(['function', 'method']);
export const at = (s: GraphSymbol) => `${s.file}:${s.line}`;

/** Parsed files and function bodies, each read and parsed once per evaluation; dispose() frees the trees. */
export function createLoader(files: FileProvider, parse: ParseText, kind: 'flowchart' | 'sequence' = 'flowchart') {
  const trees = new Map<string, Promise<Tree | null>>(), loaded = new Map<string, Promise<Loaded>>();
  const tree = (file: string): Promise<Tree | null> => {
    const language = LANGUAGES[path.posix.extname(file).toLowerCase()];
    if (!language) return Promise.resolve(null);
    let t = trees.get(file);
    if (!t) trees.set(file, t = files.read(file).then(text => text === null ? null : parse(language.grammar, text)));
    return t;
  };
  const load = (s: GraphSymbol) => {
    let l = loaded.get(s.id);
    if (!l) loaded.set(s.id, l = (async (): Promise<Loaded> => {
      const ext = path.posix.extname(s.file).toLowerCase(), language = LANGUAGES[ext];
      if (!language) return { error: `${kind} does not support ${ext.slice(1) || path.posix.basename(s.file)} files yet` };
      const t = await tree(s.file);
      if (!t) return { error: `${s.file} could not be read or parsed in time` };
      const fn = language.adapter.findFunction(t.rootNode, s.name, s.line);
      return fn ? { constructs: language.adapter.constructs(fn) } : { error: `function ${s.name} not found in ${at(s)}` };
    })());
    return l;
  };
  const dispose = () => { for (const t of trees.values()) void t.then(x => x?.delete(), () => {}); };
  return { tree, load, dispose };
}

export async function runFlowchart(step: FlowchartStep, graph: GraphApi, files: FileProvider, parse: ParseText,
  inScope: (file: string) => boolean): Promise<FlowchartOutput> {
  const warnings: ViewWarning[] = [];
  const diagnostic: FlowchartDiagnostic = { start: null, depth: step.depth, functions: 0, nodes: 0, truncated: false, error: null };
  const fail = (error: string): FlowchartOutput => ({ nodes: [], edges: [], groups: [], warnings, diagnostic: { ...diagnostic, error }, truncated: false });

  const { symbol: name, file } = step.start;
  const found = graph.findSymbols(name, file);
  const functions = found.filter(s => FUNCTION_KINDS.has(s.kind));
  if (!found.length) return fail(`start symbol not found: ${name}${file ? ` in ${file}` : ''}`);
  if (!functions.length) return fail(`start symbol ${name} is a ${found[0].kind}, not a function or method`);
  if (functions.length > 1) return fail(`ambiguous start symbol ${name}: ${file ? 'several in that file' : 'add a file'} (${functions.map(at).join(', ')})`);
  const entry = functions[0];
  diagnostic.start = `${entry.name} (${at(entry)})`;

  const { load, dispose } = createLoader(files, parse);

  try {
    const body = await load(entry);
    if ('error' in body) {
      warnings.push({ file: entry.file, line: entry.line, message: body.error });
      return fail(body.error);
    }
    const builder = new FlowchartBuilder(step, graph, load, inScope);
    await builder.entry(entry, body.constructs);
    const used = new Set(builder.nodes.map(n => n.group));
    // A group stays when a node or a nested group is in it (a callee may draw nothing but a nested expansion).
    const groups = builder.groups.filter(g => used.has(g.id) || builder.groups.some(c => c.parent === g.id && used.has(c.id)));
    if (builder.truncated) warnings.push({ file: null, line: null, message: `Flowchart stopped at ${builder.nodes.length} nodes; some calls were not expanded — lower the depth or exclude files` });
    return {
      nodes: builder.nodes, edges: builder.sortedEdges(), groups, warnings, truncated: builder.truncated,
      diagnostic: { ...diagnostic, functions: builder.functions, nodes: builder.nodes.length, truncated: builder.truncated },
    };
  } finally { dispose(); }
}
