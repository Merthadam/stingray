// `ipc` link set: renderer -> main-process calls of typed IPC contracts (`defineContract('git', { invoke: { createWorkspace:
// [args, returns], other: [args, returns, { renderer: 'flatName' }] }, events })`, channel `${feature}.${member}`). A call whose
// callee is a contract's renderer name (member or `renderer` override) and that does not resolve into the repo hops to the
// main-side handler: the property of a handler object typed `Handlers<typeof X>` (a function's return type or a variable's
// type) or passed to `registerContract(…, X, handlers)`. Handler arrows are not code-graph symbols, so each becomes a
// synthetic function symbol (id `ipc:<file>:<line>:<name>`) the walker loads by name and line like any other function.
import * as path from '../../shared/posix-path';
import type { Node } from 'web-tree-sitter';
import type { GraphSymbol } from '../rules/types';
import { named, type Call } from '../flowchart/cfg';
import { FUNCTION_KINDS } from '../flowchart';
import { typedMember } from './members';
import { functionNode, symbolNamed, type LinkContext, type LinkProvider } from './links';

/** `handler`: what the walk enters: the function a forwarding handler calls, else the handler itself (synthetic symbol). */
export interface IpcRoute { channel: string; renderer: string; handler: GraphSymbol; file: string }
type Env = Pick<LinkContext, 'graph' | 'tree' | 'imports' | 'files' | 'followable' | 'memo' | 'halted'>;

const SOURCES = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const MARKERS = /\bdefineContract\s*\(|\bHandlers\s*<\s*typeof\b|\bregisterContract\s*\(/;
const HANDLERS = /\bHandlers\s*<\s*typeof\s+([\w$]+)\s*>/;
const FUNCTIONS = new Set(['function_declaration', 'function_expression', 'function', 'arrow_function', 'method_definition']);

const unquote = (s: string) => s.replace(/^['"`]|['"`]$/g, '');
const keyOf = (pair: Node) => { const k = pair.childForFieldName('key') ?? pair.childForFieldName('name'); return k ? unquote(k.text) : null; };
const unwrap = (n: Node | null): Node | null =>
  n && ['parenthesized_expression', 'as_expression', 'satisfies_expression'].includes(n.type) ? unwrap(named(n)[0] ?? null) : n;

/** `defineContract('git', { invoke: { … } })` -> feature and renderer name -> member. */
function contractOf(call: Node): { feature: string; members: Map<string, string> } | null {
  const [feature, spec] = named(call.childForFieldName('arguments'));
  if (feature?.type !== 'string' || spec?.type !== 'object') return null;
  const invoke = named(spec).find(p => p.type === 'pair' && keyOf(p) === 'invoke')?.childForFieldName('value');
  const members = new Map<string, string>();
  for (const p of named(invoke ?? null).filter(p => p.type === 'pair')) {
    const member = keyOf(p), entry = p.childForFieldName('value');
    if (!member || entry?.type !== 'array') continue;
    const options = named(entry)[2];
    const renderer = options?.type === 'object' ? named(options).find(o => o.type === 'pair' && keyOf(o) === 'renderer')?.childForFieldName('value') : null;
    members.set(renderer?.type === 'string' ? unquote(renderer.text) : member, member);
  }
  return { feature: unquote(feature.text), members };
}

/** Object literals a function returns (`return { … }`, `() => ({ … })`), not those of nested functions. */
function returnedObjects(fn: Node): Node[] {
  const body = fn.childForFieldName('body');
  if (body && body.type !== 'statement_block') { const o = unwrap(body); return o?.type === 'object' ? [o] : []; }
  const out: Node[] = [];
  const visit = (n: Node) => {
    if (n !== body && FUNCTIONS.has(n.type)) return;
    if (n.type === 'return_statement') { const o = unwrap(named(n)[0] ?? null); if (o?.type === 'object') out.push(o); return; }
    named(n).forEach(visit);
  };
  if (body) visit(body);
  return out;
}

/** A handler function of an object literal (`name: (…) => …`, `name: function …`, `name(…) { … }`) as a synthetic symbol, and
 * the call it only forwards to (`(id, b) => d.git.createWorkspace(id, b)`, `{ return await x.y(…); }`), if any. */
interface Handler { fn: GraphSymbol; forward: Call | null }

function handlersOf(object: Node, file: string): Handler[] {
  return named(object).flatMap(p => {
    const name = keyOf(p), fn = p.type === 'method_definition' ? p : p.type === 'pair' ? unwrap(p.childForFieldName('value')) : null;
    if (!name || !fn || !FUNCTIONS.has(fn.type)) return [];
    const line = fn.startPosition.row + 1;
    return [{ fn: { id: `ipc:${file}:${line}:${name}`, name, kind: 'function', file, line, endLine: fn.endPosition.row + 1 }, forward: forwarded(fn) }];
  });
}

function forwarded(fn: Node): Call | null {
  let value = fn.childForFieldName('body');
  if (value?.type === 'statement_block') {
    const only = named(value);
    value = only.length === 1 && only[0].type === 'return_statement' ? named(only[0])[0] ?? null : null;
  }
  value = unwrap(value);
  if (value?.type === 'await_expression') value = unwrap(named(value)[0] ?? null);
  const callee = value?.type === 'call_expression' ? value.childForFieldName('function') : null;
  if (!callee) return null;
  const path = callee.text.replace(/\s+/g, '');
  return { callee: path.split('.').at(-1)!, line: value!.startPosition.row + 1, awaited: false, outer: true, chained: false, path };
}

/** The repo function a forwarding handler calls: through type annotations, else the code graph's `calls` edge of the
 * function around the handler object at that line. */
async function forwardTarget(h: Handler, env: Env): Promise<GraphSymbol | null> {
  if (!h.forward) return null;
  const typed = await typedMember(h.forward, h.fn.file, env);
  if (typed) return typed;
  const around = env.graph.fileSymbols(h.fn.file).filter(s => FUNCTION_KINDS.has(s.kind) && s.line <= h.fn.line && h.fn.line <= (s.endLine ?? s.line))
    .sort((a, b) => b.line - a.line)[0];
  if (!around) return null;
  const rels = env.graph.outgoing([around.id], ['calls']).filter(r => r.line === h.forward!.line);
  return [...env.graph.symbols(rels.map(r => r.to)).values()].find(s => s.name === h.forward!.callee && FUNCTION_KINDS.has(s.kind)) ?? null;
}

/** Every contract route with a handler in the followable files (cached per walk). */
export function ipcRoutes(env: Env): Promise<IpcRoute[]> {
  const key = 'ipc:routes';
  if (!env.memo.has(key)) env.memo.set(key, scan(env));
  return env.memo.get(key) as Promise<IpcRoute[]>;
}

async function scan(env: Env): Promise<IpcRoute[]> {
  const contracts = new Map<string, { feature: string; members: Map<string, string> }>(); // by variable name
  const handlers: { contract: string; fns: Handler[] }[] = [];
  const { files } = await env.files.list(f => SOURCES.has(path.extname(f)) && env.followable(f));
  for (const file of files) {
    if (env.halted()) break;
    const text = await env.files.read(file);
    if (!text || !MARKERS.test(text)) continue;
    const tree = await env.tree(file);
    if (!tree) continue;
    const pending: Promise<void>[] = [];
    const visit = (n: Node) => {
      if (n.type === 'call_expression') {
        const callee = n.childForFieldName('function')?.text.split('.').at(-1);
        if (callee === 'defineContract') {
          const c = contractOf(n), variable = n.parent?.type === 'variable_declarator' ? n.parent.childForFieldName('name')?.text : undefined;
          if (c && variable) contracts.set(variable, c);
        } else if (callee === 'registerContract') {
          // registerContract(ctx, gitContract, { … } | gitHandlers(…))
          const [, contract, value] = named(n.childForFieldName('arguments')).map(unwrap);
          if (contract?.type === 'identifier' && value?.type === 'object') handlers.push({ contract: contract.text, fns: handlersOf(value, file) });
          const factory = value?.type === 'call_expression' ? value.childForFieldName('function') : null;
          if (contract?.type === 'identifier' && factory?.type === 'identifier') pending.push((async () => {
            const fn = await symbolNamed(factory.text, file, env);
            const node = fn && await functionNode(fn, env);
            if (node) handlers.push({ contract: contract.text, fns: returnedObjects(node).flatMap(o => handlersOf(o, fn!.file)) });
          })());
        }
      }
      // function gitHandlers(d): Handlers<typeof gitContract> { return { … } } / const h: Handlers<typeof gitContract> = { … }
      const typed = FUNCTIONS.has(n.type) ? n.childForFieldName('return_type') : n.type === 'variable_declarator' ? n.childForFieldName('type') : null;
      const contract = typed && HANDLERS.exec(typed.text)?.[1];
      if (contract) {
        const objects = n.type === 'variable_declarator' ? [unwrap(n.childForFieldName('value'))].filter(o => o?.type === 'object') as Node[] : returnedObjects(n);
        handlers.push({ contract, fns: objects.flatMap(o => handlersOf(o, file)) });
      }
      named(n).forEach(visit);
    };
    visit(tree.rootNode);
    await Promise.all(pending);
  }
  const routes = new Map<string, IpcRoute>();
  for (const h of handlers) {
    const c = contracts.get(h.contract);
    if (!c) continue;
    for (const fn of h.fns) {
      const member = c.members.get(fn.fn.name);
      if (member === undefined || routes.has(fn.fn.id)) continue;
      routes.set(fn.fn.id, { channel: `${c.feature}.${member}`, renderer: fn.fn.name, handler: await forwardTarget(fn, env) ?? fn.fn, file: fn.fn.file });
    }
  }
  return [...routes.values()];
}

export const ipcLinks: LinkProvider = {
  name: 'ipc',
  async hops(_fn, call, ctx) {
    // `api.createWorkspace(…)`: a receiver, not `this`/`self`, and not a repo function.
    if (!call || !call.path.includes('.') || /^(?:this|self)\b/.test(call.path) || ctx.resolve(call)) return [];
    const routes = (await ipcRoutes(ctx)).filter(r => r.renderer === call.callee);
    return routes.map(r => ({ to: r.handler, kind: 'link' as const, label: r.channel, link: 'ipc', certain: true }));
  },
};
