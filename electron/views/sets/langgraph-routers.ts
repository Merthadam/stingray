// Static router enrichment for the LangGraph builtin. Keep only metadata: the engine owns/deletes the parsed trees.
import path from 'node:path';
import type { Node } from 'web-tree-sitter';

interface Route { value: string; condition: string }
interface Import { module: string; name: string }
interface Module { functions: Map<string, Route[] | null>; imports: Map<string, Import> }
interface BranchCall { file: string; line: number; from: string; prefix: string; router: string | Route[]; targets: Map<string, string> }
export interface RouterBranches { file: string; line: number; from: string; branches: { to: string; label: string }[] }

const field = (node: Node, name: string) => node.childForFieldName(name);
const children = (node: Node) => node.namedChildren.filter((n): n is Node => n !== null && n.type !== 'comment');
function literal(node: Node | null | undefined): string | null {
  if (node?.type !== 'string' || !/^["']/.test(node.text)) return null;
  const parts = children(node);
  return parts.every(n => ['string_start', 'string_content', 'string_end'].includes(n.type))
    && !node.text.includes('\\') ? parts.filter(n => n.type === 'string_content').map(n => n.text).join('') : null;
}
const name = (node: Node | null | undefined) => literal(node) ?? (node?.type === 'identifier' ? node.text : null);

/** Simplify AST nodes, not source regexes (a string containing `state.x` must remain a string). */
function condition(node: Node, check: () => void, depth = 0): string {
  check();
  if (depth > 64) throw new Error('Router nesting limit');
  if (node.type === 'call') {
    const fn = field(node, 'function'), args = field(node, 'arguments');
    if (fn?.type === 'attribute' && field(fn, 'object')?.text === 'state' && field(fn, 'attribute')?.text === 'get'
      && args && children(args).length === 1) {
      const key = literal(children(args)[0]);
      if (key !== null) return key;
    }
  }
  if (node.type === 'subscript' && field(node, 'value')?.text === 'state') {
    const key = literal(field(node, 'subscript'));
    if (key !== null) return key;
  }
  if (node.type === 'attribute' && field(node, 'object')?.text === 'state') return field(node, 'attribute')!.text;
  if (node.type === 'string') return node.text;
  if (node.type === 'set' || node.type === 'list') {
    const values = children(node).map(n => literal(n) ?? condition(n, check, depth + 1));
    return `${node.type === 'set' ? '{' : '['}${values.join(', ')}${node.type === 'set' ? '}' : ']'}`;
  }
  let text = '', end = node.startIndex;
  for (const child of node.children) {
    if (!child) continue;
    text += node.text.slice(end - node.startIndex, child.startIndex - node.startIndex);
    text += child.type === 'in' ? '∈' : child.type === 'not in' ? '∉'
      : child.isNamed ? condition(child, check, depth + 1) : child.text;
    end = child.endIndex;
  }
  return node.childCount ? (text + node.text.slice(end - node.startIndex)).replace(/\s+/g, ' ').trim() : node.text;
}

function routes(body: Node, check: () => void): Route[] | null {
  if (body.hasError) return null;
  const out: Route[] = [];
  const combine = (a: string, b: string) => a ? `(${a}) and (${b})` : b;
  function expression(node: Node, prefix: string, depth: number): boolean {
    check();
    if (depth > 64) return false;
    const value = literal(node);
    if (value !== null) { out.push({ value, condition: prefix }); return true; }
    if (node.type === 'parenthesized_expression') return expression(children(node)[0], prefix, depth + 1);
    if (node.type !== 'conditional_expression') return false;
    const [yes, test, no] = children(node);
    return expression(yes, combine(prefix, condition(test, check)), depth + 1) && expression(no, prefix, depth + 1);
  }
  // Only complete, side-effect-free return chains are resolved; loops, assignments, calls and dynamic returns fall back.
  function block(node: Node, prefix: string, depth: number): boolean {
    check();
    if (depth > 64) return false;
    for (const statement of children(node)) {
      check();
      if (statement.type === 'expression_statement' && literal(children(statement)[0]) !== null) continue; // docstring
      if (statement.type === 'return_statement') {
        const value = children(statement)[0];
        return !!value && expression(value, prefix, depth + 1);
      }
      if (statement.type !== 'if_statement') return false;
      if (!block(field(statement, 'consequence')!, combine(prefix, condition(field(statement, 'condition')!, check)), depth + 1)) return false;
      for (const alternative of children(statement).filter(n => n.type === 'elif_clause' || n.type === 'else_clause')) {
        if (alternative.type === 'else_clause') return block(field(alternative, 'body')!, prefix, depth + 1);
        if (!block(field(alternative, 'consequence')!, combine(prefix, condition(field(alternative, 'condition')!, check)), depth + 1)) return false;
      }
    }
    return false; // implicit None is not a literal route
  }
  return (body.type === 'block' ? block(body, '', 0) : expression(body, '', 0)) ? out : null;
}

export class LangGraphRouters {
  private modules = new Map<string, Module>();
  private calls: BranchCall[] = [];
  private records = 0;
  constructor(private readonly check: () => void, private readonly maxRecords: number) {}

  collect(file: string, root: Node): void {
    const module: Module = { functions: new Map(), imports: new Map() };
    this.modules.set(file, module);
    const record = () => { this.check(); if (++this.records > this.maxRecords) throw new Error('LangGraph router metadata limit'); };
    for (const node of children(root)) {
      record();
      if (node.type === 'function_definition') {
        module.functions.set(field(node, 'name')!.text, routes(field(node, 'body')!, this.check));
      } else if (node.type === 'import_from_statement' || node.type === 'import_statement') {
        const from = field(node, 'module_name')?.text;
        for (const imported of node.childrenForFieldName('name')) {
          if (!imported) continue;
          const original = field(imported, 'name')?.text ?? imported.text;
          const alias = field(imported, 'alias')?.text;
          module.imports.set(alias ?? original, { module: from ?? original, name: from ? original : '' });
        }
      }
    }
    const cursor = root.walk();
    try {
      for (;;) {
        this.check();
        const node = cursor.currentNode;
        if (node.type === 'call') {
          const fn = field(node, 'function'), method = fn && field(fn, 'attribute')?.text;
          if (fn?.type === 'attribute' && (method === 'add_conditional_edges' || method === 'set_conditional_entry_point')) {
            record();
            const args = children(field(node, 'arguments')!), entry = method === 'set_conditional_entry_point';
            const source = entry ? 'START' : name(args[0]);
            const router = args[entry ? 0 : 1];
            const map = args.find(n => n.type === 'keyword_argument' && field(n, 'name')?.text === 'path_map');
            const pathMap = map ? field(map, 'value') : args[entry ? 1 : 2];
            const targets = new Map<string, string>();
            if (pathMap?.type === 'dictionary') for (const pair of children(pathMap)) {
              const key = name(field(pair, 'key')), target = name(field(pair, 'value'));
              if (key !== null && target !== null) targets.set(key, target);
            }
            const resolved = router?.type === 'lambda' ? routes(field(router, 'body')!, this.check)
              : router && ['identifier', 'attribute'].includes(router.type) ? router.text : null;
            if (source !== null && resolved !== null) {
              const prefix = `${file}:${field(fn, 'object')!.text}:`;
              this.calls.push({ file, line: node.startPosition.row + 1, prefix, from: prefix + source, router: resolved, targets });
            }
          }
        }
        if (cursor.gotoFirstChild()) continue;
        while (!cursor.gotoNextSibling()) { if (!cursor.gotoParent()) return; }
      }
    } finally { cursor.delete(); }
  }

  private resolve(file: string, router: string, seen = new Set<string>()): Route[] | null {
    this.check();
    const key = `${file}:${router}`;
    if (seen.has(key) || seen.size >= 32) return null;
    seen.add(key);
    const module = this.modules.get(file);
    if (!module) return null;
    if (module.functions.has(router)) return module.functions.get(router)!;
    const imported = module.imports.get(router) ?? module.imports.get(router.split('.')[0]);
    if (!imported) return null;
    const dots = imported.module.match(/^\.+/)?.[0].length ?? 0;
    const base = dots ? path.posix.join(path.posix.dirname(file), ...Array(dots - 1).fill('..'), imported.module.slice(dots).replaceAll('.', '/'))
      : imported.module.replaceAll('.', '/');
    const target = imported.name || router.slice(router.indexOf('.') + 1);
    for (const candidate of [`${base}.py`, `${base}/__init__.py`]) {
      if (this.modules.has(candidate)) return this.resolve(candidate, target, seen);
    }
    return null;
  }

  *branches(): Generator<RouterBranches> {
    for (const call of this.calls) {
      this.check();
      const resolved = typeof call.router === 'string' ? this.resolve(call.file, call.router) : call.router;
      if (!resolved) continue;
      const targets = new Map<string, string[]>();
      let order = 0;
      for (const route of resolved) {
        this.check();
        const target = call.targets.get(route.value) ?? route.value;
        const label = route.condition ? `${++order}. ${route.condition}` : 'else';
        targets.set(target, [...targets.get(target) ?? [], label]);
      }
      yield { file: call.file, line: call.line, from: call.from, branches: [...targets].map(([target, labels]) => {
        const full = labels.join(' or ');
        return { to: call.prefix + target, label: full.length > 60 ? full.slice(0, 59) + '…' : full };
      }) };
    }
  }
}
