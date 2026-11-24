// Constructs -> flowchart diagram (docs/flowchart-view-spec.md §Algorithm). Statements chain with `next` edges; branches
// join at invisible merge points (their dangling edges continue to the next node). Calls resolved through the code graph
// are expanded inline as groups up to `depth`, else drawn as `call` nodes.
import { matchesGlob } from '../../shared/ports';
import type { DiagramEdge, DiagramGroup, DiagramNode } from '../../../../shared/contracts/views';
import type { FlowchartStep, GraphApi, GraphRelation, GraphSymbol } from '../rules/types';
import type { Call, Code, Construct, Handler } from './cfg';
import { explanationOf, symbolRef } from '../explanation';
import { callLabel, caseLabel, decisionLabel, endLabel, errorLabel, loopLabel, truncate } from './labels';

export const MAX_FLOWCHART_NODES = 150;

/** A function body to draw, or why it cannot be (unsupported language, not found in its file, ...). */
export type Loaded = { constructs: Construct[] } | { error: string };
export type LoadFunction = (symbol: GraphSymbol) => Promise<Loaded>;

/** An edge waiting for the next node: where control continues after a step or a branch. `seq` orders the edges of a
 * node by when its branches were created (then-branch first), not by when they reach their target. */
interface Pending { from: string; kind: string; label: string | null; certain: boolean; seq: number }
interface Breakable { node: string | null; breaks: Pending[]; loop: boolean } // node: the loop decision (null for switch)
/** A try body being drawn: raises it catches (also from expanded callees) continue at their handler. */
interface Catching { handlers: Handler[]; caught: Pending[][] }
interface Frame {
  symbol: GraphSymbol;
  group: string | null;
  level: number;              // call levels below the entry
  stack: string[];            // symbol ids being expanded (recursion guard)
  outgoing: GraphRelation[];  // the function's `calls` relations
  returns: Pending[] | null;  // expanded callee: returns continue in the caller; null for the entry function
  breakables: Breakable[];
  path: string;               // call path from the entry ('' for it), e.g. "finish>create_session" (callPath)
  calls: Map<string, number>; // resolved calls drawn so far per callee name: the "#n" of the next call path
}


/** Approximate number of boxes a callee body draws without expansion ("+N steps" hints and the node-cap check); a callee's
 * plain `return` draws nothing (it continues in the caller). */
export function countSteps(list: Construct[]): number {
  return list.reduce((n, c) => n + (c.type === 'break' || c.type === 'continue' ? 0
    : c.type === 'if' ? 1 + countSteps(c.then) + countSteps(c.else)
    : c.type === 'loop' ? 1 + countSteps(c.body) + countSteps(c.else)
    : c.type === 'switch' ? 1 + c.cases.reduce((m, k) => m + countSteps(k.body), 0)
    : c.type === 'try' ? 1 + countSteps(c.body) + c.handlers.reduce((m, h) => m + countSteps(h.body), 0) + countSteps(c.else) + countSteps(c.finally)
    : c.type === 'return' ? Math.min(1, c.calls.length)
    : 1), 0);
}

/** The code-graph target of a call among a function's `calls` relations: same line and name first, else the one target of
 * that name anywhere in the function (several: the graph saw a different call, e.g. a builtin `d.get` next to `store.get`).
 * `cache` keeps symbols looked up across calls. */
export function resolveCall(call: Call, outgoing: GraphRelation[], graph: GraphApi, cache: Map<string, GraphSymbol>): { symbol: GraphSymbol; certain: boolean } | null {
  const targets = (rels: GraphRelation[]) => {
    const missing = rels.map(r => r.to).filter(id => !cache.has(id));
    if (missing.length) for (const [id, s] of graph.symbols([...new Set(missing)])) cache.set(id, s);
    return rels.map(r => ({ r, s: cache.get(r.to) })).filter(x => x.s?.name === call.callee);
  };
  const anywhere = targets(outgoing);
  const hit = targets(outgoing.filter(r => r.line === call.line))[0] ?? (new Set(anywhere.map(x => x.r.to)).size === 1 ? anywhere[0] : undefined);
  return hit ? { symbol: hit.s!, certain: hit.r.certain } : null;
}

/** A `hide` pattern against a name: exact, or with `*` matching any run of characters. */
export function nameMatches(name: string, pattern: string): boolean {
  if (!pattern.includes('*')) return name === pattern;
  const escaped = pattern.split('*').map(p => p.replace(/[.+?^$()|[\]{}\\]/g, '\\$&'));
  return new RegExp('^' + escaped.join('.*') + '$').test(name);
}

/** The statement only stores the call's result: `x = f(...)`, `const { a } = await f(...)`, `x: T = f(...)` (the call is
 * the whole right-hand side, not `x = f() if c else g()`). */
export function valueOnly(statement: string, call: Call): boolean {
  const m = /^\s*(?:(?:const|let|var)\s+)?([\w$.\[\]{}, :*<>|]+?)\s*=\s*(?:await\s+)?(?:new\s+)?([\w$.]+)\s*(?:<[^>]*>)?\s*\(/.exec(statement);
  if (!m || m[2] !== call.path) return false;
  let depth = 1, i = m.index + m[0].length;
  for (; i < statement.length && depth > 0; i++) {
    const ch = statement[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '"' || ch === "'" || ch === '`') { const end = statement.indexOf(ch, i + 1); if (end < 0) return false; i = end; }
  }
  return depth === 0 && /^\s*;?\s*$/.test(statement.slice(i));
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
  private catching: Catching[] = [];
  private handling: (string[] | null)[] = []; // types caught by the handlers being drawn: what a bare `raise` re-raises

  constructor(private step: FlowchartStep, private graph: GraphApi, private load: LoadFunction, private inScope: (file: string) => boolean) {}

  /** Draw the entry function: start pill, its body, an end pill where it falls off the end. */
  async entry(symbol: GraphSymbol, constructs: Construct[]) {
    this.functions++;
    const start = this.add({ kind: 'start', label: symbol.name, role: 'start', line: symbol.line, detail: null, symbol }, [], symbol, null)!;
    const frame = this.frame(symbol, null, 0, [symbol.id], null, '');
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

  private frame(symbol: GraphSymbol, group: string | null, level: number, stack: string[], returns: Pending[] | null, path: string): Frame {
    return { symbol, group, level, stack, outgoing: this.graph.outgoing([symbol.id], ['calls']), returns, breakables: [], path, calls: new Map() };
  }

  /** Stable path of a resolved call (`DiagramNode.callPath`): the frame's path, '>' and the callee name; the n-th (n >= 2)
   * call of the same name in one function body gets "#n", e.g. "finish>create_session", "audit#2". */
  private callPath(f: Frame, name: string) {
    const n = (f.calls.get(name) ?? 0) + 1;
    f.calls.set(name, n);
    return `${f.path ? f.path + '>' : ''}${name}${n > 1 ? `#${n}` : ''}`;
  }

  /** Whether a call is drawn expanded: `flowchart.collapse` (exact paths) wins; then `flowchart.expand` (an exact path when
   * it has '>' or '#', else any call of that callee name) or the depth. */
  private wanted(f: Frame, path: string, name: string) {
    if (this.step.collapse?.includes(path)) return false;
    return f.level < this.step.depth || (this.step.expand ?? []).some(e => /[>#]/.test(e) ? e === path : e === name);
  }

  private uniqueId(base: string) {
    let id = base;
    for (let i = 2; this.ids.has(id); i++) id = `${base}#${i}`;
    this.ids.add(id);
    return id;
  }

  /** Add a node and connect the pending edges to it; null (nothing added) once the node cap is hit. */
  private add(n: { kind: string; label: string; line: number | null; detail: string | null; role?: 'start' | 'end'; symbol?: GraphSymbol; subtitle?: string | null;
    callPath?: string; expandable?: boolean },
    preds: Pending[], at: GraphSymbol, group: string | null): string | null {
    if (this.nodes.length >= MAX_FLOWCHART_NODES) { this.truncated = true; return null; }
    const line = n.line ?? at.line;
    const id = this.uniqueId(`${group ? group + '/' : ''}${n.kind}@${line}`);
    const s = n.symbol;
    this.nodes.push({
      id, label: n.label, kind: n.kind, subtitle: n.subtitle ?? null, group, fields: [], source: { file: at.file, line },
      symbol: s ? symbolRef(s) : null, role: n.role ?? null, order: null, detail: n.detail, ...explanationOf(s),
      ...n.callPath !== undefined && { callPath: n.callPath }, ...n.expandable && { expandable: true },
    });
    this.connect(preds, id);
    return id;
  }

  private node(f: Frame, kind: string, label: string, code: Code, preds: Pending[], extra: { symbol?: GraphSymbol; subtitle?: string | null; role?: 'end'; callPath?: string; expandable?: boolean } = {}) {
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
        // `while True` / `for (;;)` only end through break/return/raise: no exit branch.
        const endless = c.over === null && (c.cond === null || /^\(?\s*(True|true|1)\s*\)?$/.test(c.cond.trim()));
        return [...endless ? [] : await this.steps(c.else, this.branch(d, negated), f), ...ctx.breaks];
      }
      case 'switch': {
        preds = await this.calls(c.calls, preds, f, c.code, 'condition');
        const d = this.node(f, 'decision', truncate(`${decisionLabel(c.subject).label}`), c.code, preds);
        if (d === null) return preds;
        const ctx: Breakable = { node: null, breaks: [], loop: false };
        if (c.breakable) f.breakables.push(ctx);
        // A breakable (C-style) case that does not end in break/return falls through into the next case.
        let carry: Pending[] = [];
        const out: Pending[] = [];
        for (const k of c.cases) {
          const end = await this.steps(k.body, [...this.pend(d, 'case', caseLabel(k.label)), ...carry], f);
          if (c.breakable) carry = end; else out.push(...end);
        }
        out.push(...carry);
        if (c.breakable) f.breakables.pop();
        if (!c.cases.some(k => k.label === null)) out.push(...this.pend(d, 'case', 'other'));
        return [...out, ...ctx.breaks];
      }
      case 'try': {
        const d = this.node(f, 'decision', 'succeeds?', c.code, preds);
        if (d === null) return preds;
        const ctx: Catching = { handlers: c.handlers, caught: c.handlers.map(() => []) };
        this.catching.push(ctx);
        const body = await this.steps(c.body, this.branch(d, true), f);
        this.catching.pop();
        const out = await this.steps(c.else, body, f); // `try … else`: raises there are not caught by this try's handlers
        for (const [i, h] of c.handlers.entries()) {
          this.handling.push(h.types);
          out.push(...await this.steps(h.body, [...this.pend(d, 'except', truncate(h.label)), ...ctx.caught[i]], f));
          this.handling.pop();
        }
        // shortcut: `finally` is drawn only on paths that continue past the try (not before a return/raise), fine for
        // reading the main flow; draw it on every exit if cleanup steps matter.
        return this.steps(c.finally, out, f);
      }
      case 'return': {
        preds = await this.calls(c.calls, preds, f, c.code, 'value');
        // An expanded callee returns to its caller: its returns continue after the call instead of ending the chart.
        if (f.returns) { f.returns.push(...preds); return []; }
        this.node(f, 'end', endLabel(c.value), c.code, preds, { role: 'end' });
        return [];
      }
      case 'raise': {
        preds = await this.calls(c.calls, preds, f, c.code, 'value');
        // Caught by an enclosing try (innermost first): continue at its handler; a branch edge keeps its Yes/No label.
        const name = /^(?:new\s+)?([\w$.]+)\s*(?:\(|$)/.exec(c.value?.trim() ?? '')?.[1].split('.').at(-1);
        const types = c.value ? (name ? [name] : null) : this.handling.at(-1) ?? null; // null: unknown, only a catch-all catches it
        for (const t of [...this.catching].reverse()) {
          const i = t.handlers.findIndex(h => h.types === null || (types !== null && types.some(x => h.types!.includes(x))));
          if (i < 0) continue;
          t.caught[i].push(...preds.map(p => p.label ? p : { ...p, kind: 'except', label: errorLabel(c.value) }));
          return [];
        }
        this.node(f, 'error', errorLabel(c.value), c.code, preds, { role: 'end' });
        return [];
      }
      case 'break': {
        // shortcut: `break label` / `continue label` target the innermost loop; labelled jumps are rare in app code.
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

  private resolve(call: Call, f: Frame) { return resolveCall(call, f.outgoing, this.graph, this.symbolsById); }

  /** `flowchart.hide`: calls drawn as nothing, matched on the callee name or the dotted callee path. */
  private hidden(call: Call) {
    return (this.step.hide ?? []).some(h => nameMatches(call.callee, h) || nameMatches(call.path, h));
  }

  private expandable(s: GraphSymbol) {
    const matches = (globs: string[]) => globs.some(g => matchesGlob(s.file, g));
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
      if (this.hidden(call)) continue;
      const target = this.resolve(call, f);
      const at = { text: code.text, line: call.line };
      const into = (certain: boolean) => certain ? preds : preds.map(p => ({ ...p, certain: false }));
      if (!target) {
        // A library call whose result is only stored (`now = clock()`, `row = d.get(k)`) is no step of its own: the
        // statements using the value show what happens.
        if (mode === 'statement' && call.outer && !call.chained && !valueOnly(code.text, call)) preds = next(this.node(f, 'action', callLabel(call.callee), at, preds));
        continue;
      }
      const { symbol, certain } = target;
      const callPath = this.callPath(f, symbol.name);
      let subtitle: string | null = null, expandable = false;
      if (f.stack.includes(symbol.id)) subtitle = 'recursive';
      else if (this.expandable(symbol)) {
        const loaded = await this.load(symbol);
        const steps = 'constructs' in loaded ? countSteps(loaded.constructs) : 0;
        if ('constructs' in loaded && steps > 0) {
          expandable = true;
          const fits = this.nodes.length + steps + 1 <= MAX_FLOWCHART_NODES, wanted = this.wanted(f, callPath, symbol.name);
          if (wanted && fits) {
            const nodes = this.nodes.length, groups = this.groups.length, caught = this.catching.map(t => t.caught.map(x => x.length));
            const out = await this.expand(symbol, loaded.constructs, into(certain), f, callPath);
            if (this.nodes.length > nodes) { preds = out; continue; }
            // The callee drew nothing (e.g. only library calls in a return, or only a raise the caller catches): show the
            // call instead, and drop what its raises sent to the caller's handlers.
            this.groups.length = groups; this.functions--; expandable = false;
            this.catching.forEach((t, i) => t.caught.forEach((x, j) => { x.length = caught[i][j]; }));
          } else {
            if (!fits) this.truncated = true;
            subtitle = `+${steps} steps (increase depth)`;
          }
        }
      }
      if (mode !== 'condition') preds = next(this.node(f, 'call', callLabel(call.callee), at, into(certain), { symbol, subtitle, callPath, expandable }));
    }
    return preds;
  }

  private async expand(symbol: GraphSymbol, constructs: Construct[], preds: Pending[], f: Frame, callPath: string): Promise<Pending[]> {
    this.functions++;
    const base = `call:${symbol.id}`;
    let group = base;
    for (let i = 2; this.groups.some(g => g.id === group); i++) group = `${base}#${i}`;
    this.groups.push({ id: group, label: symbol.name, source: { file: symbol.file, line: symbol.line }, parent: f.group, symbol: symbolRef(symbol), callPath, ...explanationOf(symbol) });
    const callee = this.frame(symbol, group, f.level + 1, [...f.stack, symbol.id], [], callPath);
    const out = await this.steps(constructs, preds, callee);
    return [...out, ...callee.returns!];
  }
}
