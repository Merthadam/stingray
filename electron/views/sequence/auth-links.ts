// `auth` link set: what runs before a handler's body. Python: FastAPI `Depends(f)` / `Security(f)` in parameters (also inside
// `Annotated[…]` and type aliases of it), the route decorator's `dependencies=[…]`, the router's `APIRouter(dependencies=[…])`
// and decorators that resolve to repo functions (`@login_required`). TS/JS: Express middleware passed before the handler
// (`app.get(path, auth, handler)`), earlier `app.use(auth)` on the same router, and top-level wrappers (`withAuth(handler)`).
// All of the same file as the handler; dependencies of dependencies follow when the walker enters them.
import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { GraphSymbol } from '../rules/types';
import { named } from '../flowchart/cfg';
import { FUNCTION_KINDS } from '../flowchart';
import { functionNode, symbolNamed, type Hop, type LinkContext, type LinkProvider } from './links';

const DEPENDS = new Set(['Depends', 'Security']);
const lastName = (n: Node | null | undefined) => n ? /([\w$]+)\s*$/.exec(n.text)?.[1] ?? null : null;
const line = (n: Node) => n.startPosition.row + 1;
const args = (call: Node) => named(call.childForFieldName('arguments')).filter(a => a.type !== 'comment');
const keyword = (call: Node, name: string) =>
  args(call).find(a => a.type === 'keyword_argument' && a.childForFieldName('name')?.text === name)?.childForFieldName('value') ?? null;

/** Functions named in `Depends(f)` / `Security(f)` / `Depends(dependency=f)` inside `node`, in source order. */
function dependsNames(node: Node | null): string[] {
  const out: string[] = [];
  const visit = (n: Node) => {
    const fn = n.type === 'call' ? n.childForFieldName('function') : null;
    if (fn && DEPENDS.has(lastName(fn) ?? '')) {
      const arg = keyword(n, 'dependency') ?? args(n).find(a => a.type !== 'keyword_argument');
      if (arg?.type === 'identifier' || arg?.type === 'attribute') out.push(lastName(arg)!);
      return;
    }
    named(n).forEach(visit);
  };
  if (node) visit(node);
  return out;
}

/** Value of the assignment `name = …` in `root` closest before `before` (else the first one). */
function assigned(root: Node, name: string, before = Infinity): Node | null {
  let best: Node | null = null;
  const visit = (n: Node) => {
    if (n.type === 'assignment' && n.childForFieldName('left')?.text === name) {
      const value = n.childForFieldName('right');
      if (value && (!best || line(n) < before)) best = value;
    }
    named(n).forEach(visit);
  };
  visit(root);
  return best;
}

async function pythonDependencies(fn: GraphSymbol, def: Node, ctx: LinkContext): Promise<string[]> {
  const root = def.tree.rootNode, names: string[] = [], decorators: string[] = [];
  const decorated = def.parent?.type === 'decorated_definition' ? def.parent : null;
  for (const d of named(decorated).filter(n => n.type === 'decorator')) {
    const expr = named(d)[0], call = expr?.type === 'call' ? expr : null, target = call ? call.childForFieldName('function') : expr;
    if (target?.type === 'identifier') decorators.push(target.text);
    else if (call && target?.type === 'attribute') {
      // A route decorator: the router's dependencies (`router = APIRouter(dependencies=[…])`), then the route's own.
      const owner = target.childForFieldName('object');
      const made = owner?.type === 'identifier' ? assigned(root, owner.text, line(d)) : null;
      if (made?.type === 'call') names.push(...dependsNames(keyword(made, 'dependencies')));
      names.push(...dependsNames(keyword(call, 'dependencies')));
    }
  }
  for (const p of named(def.childForFieldName('parameters'))) {
    const found = dependsNames(p);
    // `user: CurrentUser` where `CurrentUser = Annotated[User, Depends(get_user)]` (this file or where the alias is defined).
    const alias = p.childForFieldName('type')?.text;
    if (!found.length && alias && /^[A-Za-z_]\w*$/.test(alias)) {
      const elsewhere = ctx.graph.findSymbols(alias).filter(s => !FUNCTION_KINDS.has(s.kind) && s.kind !== 'class' && s.file !== fn.file && path.posix.extname(s.file) === '.py');
      for (const file of [fn.file, ...new Set(elsewhere.map(s => s.file))]) {
        const tree = file === fn.file ? def.tree : await ctx.tree(file);
        const value = tree && assigned(tree.rootNode, alias);
        if (value?.type === 'subscript' && /^(?:typing\.)?Annotated$/.test(value.childForFieldName('value')?.text ?? '')) { found.push(...dependsNames(value)); break; }
      }
    }
    names.push(...found);
  }
  return [...decorators, ...names];
}

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'all', 'options', 'head']);
const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function']);
const middlewareName = (n: Node) => n.type === 'call_expression' ? lastName(n.childForFieldName('function'))
  : n.type === 'identifier' || n.type === 'member_expression' ? lastName(n) : null;

function expressMiddleware(fn: GraphSymbol, root: Node): string[] {
  const calls: Node[] = [];
  const visit = (n: Node) => { if (n.type === 'call_expression') calls.push(n); named(n).forEach(visit); };
  visit(root);
  const member = (c: Node) => { const f = c.childForFieldName('function'); return f?.type === 'member_expression' ? f : null; };
  const isHandler = (a: Node | undefined) => !!a && (a.type === 'identifier' ? a.text === fn.name : FUNCTION_VALUES.has(a.type) && line(a) === fn.line);
  const skipPath = (list: Node[]) => list[0] && /string/.test(list[0].type) ? list.slice(1) : list;
  const out: string[] = [];
  for (const c of calls) {
    const m = member(c), list = args(c);
    if (!m || !ROUTE_METHODS.has(m.childForFieldName('property')?.text ?? '') || !isHandler(list.at(-1))) continue;
    const owner = m.childForFieldName('object')!.text;
    // `owner.use(mw)` registered before the route applies to it.
    for (const u of calls) {
      const um = member(u);
      if (um?.childForFieldName('property')?.text === 'use' && um.childForFieldName('object')!.text === owner && line(u) < line(c)) {
        out.push(...skipPath(args(u)).flatMap(a => middlewareName(a) ?? []));
      }
    }
    out.push(...skipPath(list).slice(0, -1).flatMap(a => middlewareName(a) ?? []));
    return out;
  }
  // Next-style wrappers at the top level: `export default withAuth(handler)`, `export const GET = withAuth(handler)`.
  for (const c of calls) {
    let top = c.parent;
    while (top && top.parent && top.parent.type !== 'program') top = top.parent;
    if (top?.parent?.type !== 'program' || member(c) || !args(c).some(a => a.type === 'identifier' && a.text === fn.name)) continue;
    const name = lastName(c.childForFieldName('function'));
    if (name) out.push(name);
  }
  return out;
}

export const authLinks: LinkProvider = {
  name: 'auth',
  async hops(fn, call, ctx) {
    if (call) return [];
    const def = await functionNode(fn, ctx);
    if (!def) return [];
    const names = path.posix.extname(fn.file) === '.py' ? await pythonDependencies(fn, def, ctx) : expressMiddleware(fn, def.tree.rootNode);
    const hops: Hop[] = [];
    for (const name of new Set(names)) {
      const to = await symbolNamed(name, fn.file, ctx);
      if (to && to.id !== fn.id) hops.push({ to, kind: 'link', label: name, link: 'auth', certain: true });
    }
    return hops;
  },
};
