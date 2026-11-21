// Shared fixtures of the sequence tests: a fake code graph over in-memory files and a runner through the engine.
import assert from 'node:assert/strict';
import { evaluate } from '../electron/views/rules/engine';
import { codegraphGrammarDir } from '../electron/views/rules/grammars';
import { LINK_SETS, type GraphApi, type GraphLayers, type GraphRelation, type GraphSymbol, type ResolvedView, type SequenceStep } from '../electron/views/rules/types';
import { formatText } from '../src/views-text';

const grammarDir = codegraphGrammarDir();

/** Fake code graph over in-memory files: a function per `def`/`function`/`const f = (…) =>`, a class per `class X` (to the
 * next unindented line); relations "from>to" (trailing ? = heuristic) at the first line of `from` that calls `to(`. */
export function fakeGraph(files: Record<string, string>, relations: string[], extra: { symbols?: GraphSymbol[]; relations?: GraphRelation[]; layers?: GraphLayers } = {}): GraphApi {
  const symbols: GraphSymbol[] = [...extra.symbols ?? []];
  for (const [file, text] of Object.entries(files)) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const cls = /^class\s+(\w+)/.exec(line);
      if (cls) {
        const end = lines.findIndex((l, j) => j > i && /^\S/.test(l));
        symbols.push({ id: `${file}#${cls[1]}`, name: cls[1], kind: 'class', file, line: i + 1, endLine: end < 0 ? lines.length : end });
        return;
      }
      const m = /^\s*(?:export\s+)?(?:async\s+)?(?:def|function)\s+(\w+)/.exec(line) ?? /^\s*(?:export\s+)?const\s+(\w+)\s*=.*=>/.exec(line);
      if (m) symbols.push({ id: `${file}#${m[1]}`, name: m[1], kind: /^\s+def/.test(line) ? 'method' : 'function', file, line: i + 1 });
    });
  }
  const byName = (name: string) => symbols.find(s => s.name === name)!;
  const rels = [...relations.map((r): GraphRelation => {
    const [, from, to, heuristic] = /^(\w+)>(\w+)(\?)?$/.exec(r)!;
    const caller = byName(from), lines = files[caller.file].split('\n');
    const line = lines.findIndex((l, i) => i >= caller.line - 1 && new RegExp(`\\b${to}\\(`).test(l)) + 1;
    assert.ok(line > 0, `no call ${r}`);
    return { from: caller.id, to: byName(to).id, kind: 'calls', line, certain: !heuristic };
  }), ...extra.relations ?? []];
  return {
    findSymbols: (name, file) => symbols.filter(s => s.name === name && (!file || s.file === file)),
    symbols: ids => new Map(symbols.filter(s => ids.includes(s.id)).map(s => [s.id, s])),
    outgoing: (ids, kinds) => rels.filter(r => ids.includes(r.from) && kinds.includes(r.kind)),
    incoming: (ids, kinds) => rels.filter(r => ids.includes(r.to) && kinds.includes(r.kind)),
    fileSymbols: file => symbols.filter(s => s.file === file),
    layers: () => extra.layers ?? null, rollup: () => [],
  };
}

export const step = (s: Partial<SequenceStep> & { start: SequenceStep['start'] }): SequenceStep =>
  ({ actor: 'User', depth: 3, participants: 'auto', internal: 'collapse', returns: true, links: [...LINK_SETS], externals: {}, ...s });
export async function run(files: Record<string, string>, graph: GraphApi, sequence: Parameters<typeof step>[0], extra: Partial<ResolvedView> = {}) {
  const view: ResolvedView = { id: 'seq', kind: 'sequence', scope: { include: ['**/*'], exclude: [] }, rules: [], graph: null, flowchart: null, builtins: [],
    include: [], exclude: [], sequence: step(sequence), ...extra };
  const out = await evaluate({ view, graph, graphStatus: { state: 'ready', message: null }, grammarDir,
    files: { list: async () => ({ files: Object.keys(files), truncated: false }), read: async f => files[f] ?? null } });
  return { ...out, seq: out.sequence!, text: formatText({ kind: 'sequence', ...out }).split('\n').slice(1) };
}
