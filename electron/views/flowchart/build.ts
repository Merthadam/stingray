// Constructs -> flowchart diagram (docs/flowchart-view-spec.md §Algorithm). Statements chain with `next` edges; branches
// join at invisible merge points (their dangling edges continue to the next node). Calls resolved through the code graph
// are expanded inline as groups up to `depth`, else drawn as `call` nodes.
import path from 'node:path';
import type { DiagramEdge, DiagramGroup, DiagramNode } from '../../../src/views';
import type { FlowchartStep, GraphApi, GraphRelation, GraphSymbol } from '../rules/types';
import type { Call, Code, Construct } from './cfg';
import { callLabel, caseLabel, decisionLabel, endLabel, errorLabel, loopLabel, truncate } from './labels';

export const MAX_FLOWCHART_NODES = 150;

/** A function body to draw, or why it cannot be (unsupported language, not found in its file, ...). */
export type Loaded = { constructs: Construct[] } | { error: string };
export type LoadFunction = (symbol: GraphSymbol) => Promise<Loaded>;

/** An edge waiting for the next node: where control continues after a step or a branch. `seq` orders the edges of a
 * node by when its branches were created (then-branch first), not by when they reach their target. */
interface Pending { from: string; kind: string; label: string | null; certain: boolean; seq: number }
interface Breakable { node: string | null; breaks: Pending[]; loop: boolean } // node: the loop decision (null for switch)
interface Frame {
  symbol: GraphSymbol;
  group: string | null;
  level: number;              // call levels below the entry
  stack: string[];            // symbol ids being expanded (recursion guard)
  outgoing: GraphRelation[];  // the function's `calls` relations
  returns: Pending[] | null;  // expanded callee: returns continue in the caller; null for the entry function
  breakables: Breakable[];
}


/** Approximate number of boxes a callee body draws without expansion ("+N steps" hints and the node-cap check); a callee's
 * plain `return` draws nothing (it continues in the caller). */
export function countSteps(list: Construct[]): number {
  return list.reduce((n, c) => n + (c.type === 'break' || c.type === 'continue' ? 0
    : c.type === 'if' ? 1 + countSteps(c.then) + countSteps(c.else)
    : c.type === 'loop' ? 1 + countSteps(c.body)
    : c.type === 'switch' ? 1 + c.cases.reduce((m, k) => m + countSteps(k.body), 0)
    : c.type === 'try' ? 1 + countSteps(c.body) + c.handlers.reduce((m, h) => m + countSteps(h.body), 0) + countSteps(c.finally)
    : c.type === 'return' ? Math.min(1, c.calls.length)
    : 1), 0);
}

export class FlowchartBuilder {
  readonly nodes: DiagramNode[] = [];
  readonly edges: DiagramEdge[] = [];
  readonly groups: DiagramGroup[] = [];
  truncated = false;
  functions = 0;
  private ids = new Set<string>();
  private seq = 0;
  private edgeSeq = new Map<DiagramEdge, number>();
  private symbolsById = new Map<string, GraphSymbol>();

  constructor(private step: FlowchartStep, private graph: GraphApi, private load: LoadFunction, private inScope: (file: string) => boolean) {}

  /** Draw the entry function: start pill, its body, an end pill where it falls off the end. */
  async entry(symbol: GraphSymbol, constructs: Construct[]) {
    this.functions++;
    const start = this.add({ kind: 'start', label: symbol.name, role: 'start', line: symbol.line, detail: null, symbol }, [], symbol, null)!;
    const frame = this.frame(symbol, null, 0, [symbol.id], null);
    const out = await this.steps(constructs, this.pend(start, 'next'), frame);
    if (out.length) this.add({ kind: 'end', label: 'done', role: 'end', line: null, detail: null }, out, symbol, null);
  }

  private pend(from: string, kind: string, label: string | null = null): Pending[] {
    return [{ from, kind, label, certain: true, seq: this.seq++ }];
  }
  private branch(from: string, yes: boolean): Pending[] { return this.pend(from, yes ? 'yes' : 'no', yes ? 'Yes' : 'No'); }

  /** Edges grouped by source node in creation order, each node's edges in branch order. */
  sortedEdges(): DiagramEdge[] {
    const rank = new Map(this.nodes.map((n, i) => [n.id, i]));
    return [...this.edges].sort((a, b) => rank.get(a.from)! - rank.get(b.from)! || this.edgeSeq.get(a)! - this.edgeSeq.get(b)!);
  }

  private frame(symbol: GraphSymbol, group: string | null, level: number, stack: string[], returns: Pending[] | null): Frame {
    return { symbol, group, level, stack, outgoing: this.graph.outgoing([symbol.id], ['calls']), returns, breakables: [] };
  }

  private uniqueId(base: string) {
    let id = base;
    for (let i = 2; this.ids.has(id); i++) id = `${base}#${i}`;
    this.ids.add(id);
    return id;
  }

  /** Add a node and connect the pending edges to it; null (nothing added) once the node cap is hit. */
  private add(n: { kind: string; label: string; line: number | null; detail: string | null; role?: 'start' | 'end'; symbol?: GraphSymbol; subtitle?: string | null },
    preds: Pending[], at: GraphSymbol, group: string | null): string | null {
    if (this.nodes.length >= MAX_FLOWCHART_NODES) { this.truncated = true; return null; }
    const line = n.line ?? at.line;
    const id = this.uniqueId(`${group ? group + '/' : ''}${n.kind}@${line}`);
    const s = n.symbol;
    this.nodes.push({
      id, label: n.label, kind: n.kind, subtitle: n.subtitle ?? null, group, fields: [], source: { file: at.file, line },
      symbol: s ? { id: s.id, name: s.name, kind: s.kind, file: s.file, line: s.line } : null, role: n.role ?? null, order: null, detail: n.detail,
    });
    this.connect(preds, id);
    return id;
  }

  private node(f: Frame, kind: string, label: string, code: Code, preds: Pending[], extra: { symbol?: GraphSymbol; subtitle?: string | null; role?: 'end' } = {}) {
    return this.add({ kind, label, line: code.line, detail: code.text, ...extra }, preds, f.symbol, f.group);
  }

  private async steps(list: Construct[], preds: Pending[], f: Frame): Promise<Pending[]> {
    for (const c of list) {
      if (!preds.length) break; // unreachable after return/raise/break
      preds = await this.construct(c, preds, f);
    }
    return preds;
  }

  private async construct(c: Construct, preds: Pending[], f: Frame): Promise<Pending[]> {
    const next = (from: string | null): Pending[] => from === null ? preds : this.pend(from, 'next');
    switch (c.type) {
      case 'action': return this.calls(c.calls, preds, f, c.code, 'statement');
      case 'if': {
        preds = await this.calls(c.calls, preds, f, c.code, 'condition');
        const { label, negated } = decisionLabel(c.cond);
        const d = this.node(f, 'decision', label, { text: c.cond.replace(/\s+/g, ' ').slice(0, 200), line: c.code.line }, preds);
        if (d === null) return preds;
        const then = await this.steps(c.then, this.branch(d, !negated), f);
        const otherwise = c.else.length ? await this.steps(c.else, this.branch(d, negated), f) : this.branch(d, negated);
        return [...then, ...otherwise];
      }
      case 'loop': {
        preds = await this.calls(c.calls, preds, f, c.code, 'condition');
        const { label, negated } = loopLabel(c);
        const d = this.node(f, 'loop', label, c.code, preds);
        if (d === null) return preds;
        const ctx: Breakable = { node: d, breaks: [], loop: true };
        f.breakables.push(ctx);
        const body = await this.steps(c.body, this.branch(d, !negated), f);
        f.breakables.pop();
        this.connect(body, d, 'loop');
        return [...this.branch(d, negated), ...ctx.breaks];
      }
      case 'switch': {
        preds = await this.calls(c.calls, preds, f, c.code, 'condition');
        const d = this.node(f, 'decision', truncate(`${decisionLabel(c.subject).label}`), c.code, preds);
        if (d === null) return preds;
        const ctx: Breakable = { node: null, breaks: [], loop: false };
        if (c.breakable) f.breakables.push(ctx);
        const out: Pending[] = [];
        for (const k of c.cases) out.push(...await this.steps(k.body, this.pend(d, 'case', caseLabel(k.label)), f));
        if (c.breakable) f.breakables.pop();
        if (!c.cases.some(k => k.label === null)) out.push(...this.pend(d, 'case', 'other'));
        return [...out, ...ctx.breaks];
      }
      case 'try': {
        const d = this.node(f, 'decision', 'succeeds?', c.code, preds);
        if (d === null) return preds;
        const out = await this.steps(c.body, this.branch(d, true), f);
        for (const h of c.handlers) out.push(...await this.steps(h.body, this.pend(d, 'except', truncate(h.label)), f));
        return this.steps(c.finally, out, f);
      }
      case 'return': {
        preds = await this.calls(c.calls, preds, f, c.code, 'value');
        // An expanded callee returns to its caller: its returns continue after the call instead of ending the chart.
        if (f.returns) { f.returns.push(...preds); return []; }
        this.node(f, 'end', endLabel(c.value), c.code, preds, { role: 'end' });
        return [];
      }
      case 'raise':
        preds = await this.calls(c.calls, preds, f, c.code, 'value');
        this.node(f, 'error', errorLabel(c.value), c.code, preds, { role: 'end' });
        return [];
      case 'break': {
        const ctx = f.breakables.at(-1);
        if (ctx) ctx.breaks.push(...preds); else return next(null);
        return [];
      }
      case 'continue': {
        const loop = [...f.breakables].reverse().find(b => b.loop);
        if (!loop) return next(null);
        this.connect(preds, loop.node!, 'loop');
        return [];
      }
    }
  }

  /** Edges from the pending ends to `to`; `kind` overrides theirs (back-edges of loop bodies and `continue` are `loop`,
   * keeping a branch label such as "Yes" when the branch itself loops back). */
  private connect(preds: Pending[], to: string, kind?: string) {
    for (const p of preds) {
      const k = kind ?? p.kind, base = `${k}:${p.from}->${to}`;
      const edge: DiagramEdge = { id: this.uniqueId(base), from: p.from, to, fromField: null, toField: null, kind: k, style: p.certain ? 'solid' : 'dashed',
        certain: p.certain, label: p.label, source: null };
      this.edges.push(edge);
      this.edgeSeq.set(edge, p.seq);
    }
  }

  /** The code-graph target of a call: same line and name first, else the same name anywhere in the function. */
  private resolve(call: Call, f: Frame): { symbol: GraphSymbol; certain: boolean } | null {
    const targets = (rels: GraphRelation[]) => {
      const missing = rels.map(r => r.to).filter(id => !this.symbolsById.has(id));
      if (missing.length) for (const [id, s] of this.graph.symbols([...new Set(missing)])) this.symbolsById.set(id, s);
      return rels.map(r => ({ r, s: this.symbolsById.get(r.to) })).filter(x => x.s?.name === call.callee);
    };
    const hit = targets(f.outgoing.filter(r => r.line === call.line))[0] ?? targets(f.outgoing)[0];
    return hit ? { symbol: hit.s!, certain: hit.r.certain } : null;
  }

  private expandable(s: GraphSymbol) {
    const matches = (globs: string[]) => globs.some(g => path.posix.matchesGlob(s.file, g));
    return (this.step.include ? matches(this.step.include) : this.inScope(s.file)) && !matches(this.step.exclude ?? []);
  }

  /**
   * Steps for the calls of one statement, in evaluation order. Resolved calls expand (or become `call` nodes); unresolved
   * ones (library, builtins) become one `action` per outermost call for statements, and are left to the label otherwise.
   * `condition`: only expansions — the decision label already names the call.
   */
  private async calls(calls: Call[], preds: Pending[], f: Frame, code: Code, mode: 'statement' | 'value' | 'condition'): Promise<Pending[]> {
    const next = (from: string | null): Pending[] => from === null ? preds : this.pend(from, 'next');
    for (const call of calls) {
      const target = this.resolve(call, f);
      const at = { text: code.text, line: call.line };
      const into = (certain: boolean) => certain ? preds : preds.map(p => ({ ...p, certain: false }));
      if (!target) {
        if (mode === 'statement' && call.outer) preds = next(this.node(f, 'action', callLabel(call.callee), at, preds));
        continue;
      }
      const { symbol, certain } = target;
      let subtitle: string | null = null;
      if (f.stack.includes(symbol.id)) subtitle = 'recursive';
      else if (this.expandable(symbol)) {
        const loaded = await this.load(symbol);
        const steps = 'constructs' in loaded ? countSteps(loaded.constructs) : 0;
        if ('constructs' in loaded && steps > 0) {
          const fits = this.nodes.length + steps + 1 <= MAX_FLOWCHART_NODES;
          if (f.level < this.step.depth && fits) {
            const nodes = this.nodes.length, groups = this.groups.length;
            const out = await this.expand(symbol, loaded.constructs, into(certain), f);
            if (this.nodes.length > nodes) { preds = out; continue; }
            this.groups.length = groups; // the callee drew nothing (e.g. only library calls in a return): show the call instead
          } else {
            if (!fits) this.truncated = true;
            subtitle = `+${steps} steps (increase depth)`;
          }
        }
      }
      if (mode !== 'condition') preds = next(this.node(f, 'call', callLabel(call.callee), at, into(certain), { symbol, subtitle }));
    }
    return preds;
  }

  private async expand(symbol: GraphSymbol, constructs: Construct[], preds: Pending[], f: Frame): Promise<Pending[]> {
    this.functions++;
    const base = `call:${symbol.id}`;
    let group = base;
    for (let i = 2; this.groups.some(g => g.id === group); i++) group = `${base}#${i}`;
    this.groups.push({ id: group, label: symbol.name, source: { file: symbol.file, line: symbol.line }, parent: f.group });
    const callee = this.frame(symbol, group, f.level + 1, [...f.stack, symbol.id], []);
    const out = await this.steps(constructs, preds, callee);
    return [...out, ...callee.returns!];
  }
}
