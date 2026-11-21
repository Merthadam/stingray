// Walks an entry function depth-first through the code graph and records what a sequence diagram draws as a flat trace:
// messages in call order, fragment open/branch/close markers from the constructs around call sites, error notes. Which
// lifeline a function belongs to is decided afterwards (index.ts), when all reached files are known.
import path from 'node:path';
import type { SequenceFragmentKind, SourceRef, SymbolRef } from '../../../src/views';
import type { GraphApi, GraphRelation, GraphSymbol, SequenceStep } from '../rules/types';
import type { Call, Code, Construct } from '../flowchart/cfg';
import { resolveCall, type LoadFunction } from '../flowchart/build';
import { FUNCTION_KINDS } from '../flowchart';
import { callLabel, caseLabel, truncate, words } from '../flowchart/labels';
import { symbolRef } from '../explanation';
import { externalCall } from './externals';
import type { Hop, LinkContext, LinkProvider } from './links';

export const SEQUENCE_LIMITS = { messages: 400, participants: 30, functions: 150, events: 5000 };
const MAX_RETURN_LABEL = 24;

/** A message end: a reached function (its lifeline is computed later), an external system or the actor. */
export type End = { symbol: GraphSymbol } | { external: string } | { actor: true };

export type TraceEvent =
  | { t: 'msg'; id: number; from: End; to: End; kind: 'call' | 'http' | 'link'; label: string; detail: string | null; level: number;
      certain: boolean; link: string | null; source: SourceRef | null; symbol: SymbolRef | null }
  | { t: 'ret'; call: number; from: End; to: End; label: string; level: number; source: SourceRef | null }
  | { t: 'open'; kind: SequenceFragmentKind; label: string; source: SourceRef }
  | { t: 'branch'; label: string }
  | { t: 'close' }
  | { t: 'note'; at: End; text: string; source: SourceRef; entered: number | null }; // entered: the msg that entered its function (null: entry)

type Arm = { label: string; body: Construct[]; calls?: { calls: Call[]; code: Code } };
type How = Pick<Hop, 'label' | 'certain'> & { kind: 'call' | Hop['kind']; link: string | null };

interface Frame {
  symbol: GraphSymbol;
  level: number;              // call level of this function's own calls (0 = entry)
  stack: string[];            // symbol ids being walked (recursion guard)
  entered: number | null;     // msg id that entered this function; null for the entry
  outgoing: GraphRelation[];  // its `calls` relations
  returns: (string | null)[]; // values of the returns reached
}

/** Fragment labels: the condition / loop header as words. */
const condLabel = (cond: string) => truncate(words(cond.trim()) || cond.trim());
function loopLabel(c: Extract<Construct, { type: 'loop' }>) {
  if (c.over !== null) return truncate(`for each ${words(c.over) || c.over}`);
  return c.cond ? truncate(`while ${words(c.cond) || c.cond}`) : 'loop';
}
/** Exception type of a raise value: "HTTPException" for `raise HTTPException(401, ...)` / `throw new HTTPException(...)`. */
const errorType = (value: string | null) => value ? /^(?:new\s+)?([\w$.]+)/.exec(value.trim())?.[1].split('.').at(-1) ?? truncate(value) : 're-raise';

export class SequenceWalker {
  readonly events: TraceEvent[] = [];
  private parsed = new Set<string>(); // function bodies walked (each parsed once)
  truncated = false;
  private messages = 0;
  private cache = new Map<string, GraphSymbol>();
  private imports = new Map<string, Promise<Map<string, string>>>();

  constructor(private step: SequenceStep, private graph: GraphApi, private load: LoadFunction, private links: LinkProvider[],
    private followable: (file: string) => boolean, private importsOf: (file: string) => Promise<Map<string, string>>) {}

  private get stopped() { return this.events.length >= SEQUENCE_LIMITS.events; }

  private push(e: TraceEvent) {
    if (this.stopped) { this.truncated = true; return; }
    this.events.push(e);
  }

  get functions() { return this.parsed.size; }

  async entry(symbol: GraphSymbol, constructs: Construct[]) {
    this.parsed.add(symbol.id);
    if (this.step.trigger) this.push({ t: 'msg', id: this.messages++, from: { actor: true }, to: { symbol }, kind: 'call', label: this.step.trigger,
      detail: null, level: 0, certain: true, link: null, source: null, symbol: symbolRef(symbol) });
    await this.body(constructs, this.frame(symbol, 0, [symbol.id], null));
  }

  private frame(symbol: GraphSymbol, level: number, stack: string[], entered: number | null): Frame {
    return { symbol, level, stack, entered, outgoing: this.graph.outgoing([symbol.id], ['calls']), returns: [] };
  }

  private symbols = (ids: string[]) => {
    const missing = [...new Set(ids)].filter(id => !this.cache.has(id));
    if (missing.length) for (const [id, s] of this.graph.symbols(missing)) this.cache.set(id, s);
    return new Map(ids.flatMap(id => { const s = this.cache.get(id); return s ? [[id, s] as const] : []; }));
  };
  private context(f: Frame, statement = ''): LinkContext { return { graph: this.graph, outgoing: f.outgoing, statement, symbols: this.symbols }; }

  /** Constructs in source order; a return/raise/break/continue ends its block (the rest is unreachable). */
  private async body(list: Construct[], f: Frame) {
    for (const c of list) {
      if (this.stopped) { this.truncated = true; return; }
      if (await this.construct(c, f)) return;
    }
  }

  /** One construct; true when it ends the block. */
  private async construct(c: Construct, f: Frame): Promise<boolean> {
    const at = (code: Code): SourceRef => ({ file: f.symbol.file, line: code.line });
    switch (c.type) {
      case 'action': await this.calls(c.calls, f, c.code); return false;
      case 'if': {
        await this.calls(c.calls, f, c.code);
        // `elif` / `else if` chains read as one alt with a branch per arm; an arm's condition calls run first in it.
        const arms: Arm[] = [{ label: condLabel(c.cond), body: c.then }];
        let rest = c.else;
        while (rest.length === 1 && rest[0].type === 'if') {
          const elif = rest[0];
          arms.push({ label: condLabel(elif.cond), body: elif.then, calls: { calls: elif.calls, code: elif.code } });
          rest = elif.else;
        }
        if (rest.length) arms.push({ label: 'else', body: rest });
        await this.arms(arms, f, { kind: arms.length > 1 ? 'alt' : 'opt', source: at(c.code) });
        return false;
      }
      case 'loop': {
        await this.calls(c.calls, f, c.code);
        await this.arms([{ label: loopLabel(c), body: c.body }], f, { kind: 'loop', source: at(c.code) });
        await this.body(c.else, f);
        return false;
      }
      case 'switch': {
        await this.calls(c.calls, f, c.code);
        const subject = condLabel(c.subject);
        const arms = c.cases.map((k, i) => ({ label: i ? caseLabel(k.label) : truncate(`${subject}: ${caseLabel(k.label)}`), body: k.body }));
        await this.arms(arms, f, { kind: 'alt', source: at(c.code) });
        return false;
      }
      case 'try': {
        const python = path.posix.extname(f.symbol.file) === '.py';
        await this.arms([{ label: 'try', body: [...c.body, ...c.else] },
          ...c.handlers.map(h => ({ label: python ? truncate(`except ${h.label}`) : 'catch', body: h.body }))], f, { kind: 'try', source: at(c.code) });
        await this.body(c.finally, f);
        return false;
      }
      case 'return':
        await this.calls(c.calls, f, c.code);
        f.returns.push(c.value);
        return true;
      case 'raise':
        await this.calls(c.calls, f, c.code);
        this.push({ t: 'note', at: { symbol: f.symbol }, text: `error: ${errorType(c.value)}`, source: at(c.code), entered: f.entered });
        return true;
      case 'break': case 'continue': return true;
    }
  }

  /** A fragment with one arm per entry (the first arm's label is the fragment's). */
  private async arms(arms: Arm[], f: Frame, open: { kind: SequenceFragmentKind; source: SourceRef }) {
    this.push({ t: 'open', kind: open.kind, label: arms[0].label, source: open.source });
    for (const [i, arm] of arms.entries()) {
      if (i) this.push({ t: 'branch', label: arm.label });
      if (arm.calls) await this.calls(arm.calls.calls, f, arm.calls.code);
      await this.body(arm.body, f);
    }
    this.push({ t: 'close' });
  }

  private async calls(calls: Call[], f: Frame, code: Code) {
    const externals = new Set<string>(); // one message per external system and statement
    for (const [i, call] of calls.entries()) {
      if (this.stopped) { this.truncated = true; return; }
      const source = { file: f.symbol.file, line: call.line };
      const hops = this.links.flatMap(p => p.hops(f.symbol, call, this.context(f, code.text)));
      if (hops.length) { for (const hop of hops) await this.enter(hop.to, hop, f, code.text, source); continue; }
      const target = resolveCall(call, f.outgoing, this.graph, this.cache);
      if (target) {
        await this.enter(target.symbol, { kind: 'call', label: callLabel(call.callee), link: null, certain: target.certain }, f, code.text, source);
        continue;
      }
      const external = externalCall(call, await this.importsOfFile(f.symbol.file), this.step.externals);
      if (!external || externals.has(external)) continue; // stdlib, local helpers, unresolved: not drawn
      externals.add(external);
      // `conn.execute(text("…"))`: the call taking the library value names the step (calls come arguments first).
      const named = call.outer ? call : calls.slice(i + 1).find(c => c.outer) ?? call;
      // An external's result is unknown: no return arrow.
      this.push({ t: 'msg', id: this.messages++, from: { symbol: f.symbol }, to: { external }, kind: 'call', label: callLabel(named.callee), detail: code.text,
        level: f.level, certain: true, link: null, source, symbol: null });
    }
  }

  private importsOfFile(file: string) {
    let i = this.imports.get(file);
    if (!i) this.imports.set(file, i = this.importsOf(file).catch(() => new Map<string, string>()));
    return i;
  }

  /** A message to `symbol`, its messages when it is followed (depth, scope, recursion, caps), then the return arrow. */
  private async enter(symbol: GraphSymbol, how: How, f: Frame, detail: string, source: SourceRef) {
    const recursive = f.stack.includes(symbol.id), id = this.messages++;
    this.push({ t: 'msg', id, from: { symbol: f.symbol }, to: { symbol }, kind: how.kind,
      label: recursive ? `${how.label} (recursive)` : how.label, detail, level: f.level, certain: how.certain, link: how.link, source, symbol: symbolRef(symbol) });
    let returns: (string | null)[] = [];
    if (!recursive && f.level < this.step.depth && FUNCTION_KINDS.has(symbol.kind) && this.followable(symbol.file)) {
      if (!this.parsed.has(symbol.id) && this.parsed.size >= SEQUENCE_LIMITS.functions) this.truncated = true;
      else {
        const loaded = await this.load(symbol);
        if ('constructs' in loaded) {
          this.parsed.add(symbol.id);
          const callee = this.frame(symbol, f.level + 1, [...f.stack, symbol.id], id);
          for (const hop of this.links.flatMap(p => p.hops(symbol, null, this.context(callee)))) await this.enter(hop.to, hop, callee, hop.label, { file: symbol.file, line: symbol.line });
          await this.body(loaded.constructs, callee);
          returns = callee.returns;
        }
      }
    }
    if (!this.step.returns) return;
    const values = [...new Set(returns.map(v => v?.trim() ?? ''))];
    const label = how.kind === 'http' ? 'response' : values.length === 1 && values[0].length <= MAX_RETURN_LABEL ? values[0] : '';
    this.push({ t: 'ret', call: id, from: { symbol }, to: { symbol: f.symbol }, label, level: f.level, source: null });
  }
}
