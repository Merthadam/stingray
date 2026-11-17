// Language-neutral construct model of one function body, built by a per-language adapter (python.ts, typescript.ts)
// from tree-sitter nodes; build.ts turns it into diagram nodes and edges. Only statements with calls or control flow
// survive: everything else is noise in a flowchart.
import type { Node } from 'web-tree-sitter';

export interface Code { text: string; line: number }   // source snippet (one line, capped) and its 1-based line
export interface Call {
  callee: string;             // called name without receiver ("send_reset_email" for `self.mail.send_reset_email(u)`)
  line: number;               // 1-based line of the call (matched against code-graph `calls` relations)
  awaited: boolean;
  outer: boolean;             // not an argument of another call of the same statement
  chained: boolean;           // called on another call's result (`(await run()).trim()`): that call names the step
}
/** A try handler; `types` are the caught exception names, null when it catches everything. */
export interface Handler { label: string; line: number; types: string[] | null; body: Construct[] }

export type Construct =
  | { type: 'action'; code: Code; calls: Call[] }
  | { type: 'if'; code: Code; cond: string; calls: Call[]; then: Construct[]; else: Construct[] }
  | { type: 'loop'; code: Code; over: string | null; cond: string | null; calls: Call[]; body: Construct[]; else: Construct[] } // else: Python `for/while … else`
  | { type: 'switch'; code: Code; subject: string; calls: Call[]; cases: { label: string | null; body: Construct[] }[]; breakable: boolean }
  | { type: 'try'; code: Code; body: Construct[]; handlers: Handler[]; else: Construct[]; finally: Construct[] } // else: Python `try … else`
  | { type: 'return' | 'raise'; code: Code; value: string | null; calls: Call[] }
  | { type: 'break' | 'continue'; code: Code };

/** A language adapter: locates a function by name and line, and maps its body to constructs. */
export interface Adapter {
  findFunction(root: Node, name: string, line: number): Node | null;
  constructs(fn: Node): Construct[];
}

const MAX_CODE = 200;
export const code = (node: Node): Code =>
  ({ text: node.text.replace(/\s+/g, ' ').trim().slice(0, MAX_CODE), line: node.startPosition.row + 1 });

export const named = (node: Node | null | undefined): Node[] => (node?.namedChildren ?? []).filter((n): n is Node => n !== null);

export interface CallSyntax {
  calls: Set<string>;         // call node types, e.g. "call", "call_expression", "new_expression"
  callee: (call: Node) => Node | null;
  awaits: Set<string>;
  nested: Set<string>;        // function/class definitions whose calls do not run here
}

/** Name of the called function: identifier / property / attribute name, else the last identifier of the callee text. */
function calleeName(fn: Node): string {
  const named = fn.childForFieldName('property') ?? fn.childForFieldName('attribute') ?? fn;
  return /([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*$/.exec(named.text)?.[1] ?? named.text.slice(0, 80);
}

/** Calls inside `node` in evaluation order (arguments before the call), skipping nested definitions. Calls in a callee's
 * receiver keep the call's `outer`; calls in its arguments are not outer. */
export function collectCalls(node: Node | null, syntax: CallSyntax): Call[] {
  const out: Call[] = [];
  const visit = (n: Node, inCall: boolean) => {
    if (n !== node && syntax.nested.has(n.type)) return;
    const isCall = syntax.calls.has(n.type), fn = isCall ? syntax.callee(n) : null;
    let chained = false;
    for (const child of named(n)) {
      const before = out.length;
      visit(child, inCall || (isCall && child.id !== fn?.id));
      if (fn && child.id === fn.id) chained = out.length > before;
    }
    if (fn) out.push({ callee: calleeName(fn), line: n.startPosition.row + 1, awaited: !!n.parent && syntax.awaits.has(n.parent.type), outer: !inCall, chained });
  };
  if (node) visit(node, false);
  return out;
}

/** An `if` whose branches kept nothing is dropped (its condition's calls stay as an action). */
export function ifConstruct(at: Node, cond: Node, calls: Call[], then: Construct[], otherwise: Construct[]): Construct[] {
  if (!then.length && !otherwise.length) return calls.length ? [{ type: 'action', code: code(at), calls }] : [];
  return [{ type: 'if', code: code(at), cond: cond.text, calls, then, else: otherwise }];
}

/** A loop whose body kept nothing is dropped like an empty `if` (its `else` then runs inline). */
export function loopConstruct(at: Node, loop: { over: Node | null; cond: Node | null }, calls: Call[], body: Construct[], otherwise: Construct[] = []): Construct[] {
  if (!body.length) return [...calls.length ? [{ type: 'action' as const, code: code(at), calls }] : [], ...otherwise];
  return [{ type: 'loop', code: code(at), over: loop.over?.text ?? null, cond: loop.cond?.text ?? null, calls, body, else: otherwise }];
}

/** `try` with nothing kept in body or handlers is dropped: its `else` and `finally` run inline. */
export function tryConstruct(at: Node, body: Construct[], handlers: Handler[], fin: Construct[], otherwise: Construct[] = []): Construct[] {
  if (!body.length && handlers.every(h => !h.body.length)) return [...otherwise, ...fin];
  return [{ type: 'try', code: code(at), body, handlers, else: otherwise, finally: fin }];
}

/** Statement whose value is a ternary with calls in a branch: a decision with one statement per branch. */
export function ternary(at: Node, parts: { cond: Node; a: Node; b: Node } | null, syntax: CallSyntax,
  branch: (value: Node, calls: Call[]) => Construct[]): Construct[] | null {
  if (!parts) return null;
  const a = collectCalls(parts.a, syntax), b = collectCalls(parts.b, syntax);
  if (!a.length && !b.length) return null;
  return ifConstruct(at, parts.cond, collectCalls(parts.cond, syntax), branch(parts.a, a), branch(parts.b, b));
}

/** Plain statement: an action when it calls something, else nothing. */
export const action = (at: Node, calls: Call[]): Construct[] => calls.length ? [{ type: 'action', code: code(at), calls }] : [];

/** Function node named `name` closest to `line` (the symbol's line may be the declaration or a decorator above it). */
export function closestFunction(candidates: { node: Node; name: string | null; lines: number[] }[], name: string, line: number): Node | null {
  let best: Node | null = null, distance = Infinity;
  for (const c of candidates) {
    if (c.name !== name) continue;
    const d = Math.min(...c.lines.map(l => Math.abs(l - line)));
    if (d < distance) { best = c.node; distance = d; }
  }
  return best;
}
