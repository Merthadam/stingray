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

/** Per-walk cache of something derived from a whole file's tree. */
function perFile<T>(key: string, file: string, ctx: LinkContext, make: () => T): T {
  const k = `auth:${key}:${file}`;
  if (!ctx.memo.has(k)) ctx.memo.set(k, make());
  return ctx.memo.get(k) as T;
}

/** Value of the assignment `name = …` in `file` closest before `before` (else the first one). */
function assigned(file: string, root: Node, name: string, ctx: LinkContext, before = Infinity): Node | null {
  const all = perFile('assignments', file, ctx, () => {
    const out = new Map<string, { line: number; value: Node }[]>();
    const visit = (n: Node) => {
      const left = n.type === 'assignment' ? n.childForFieldName('left')?.text : undefined, value = left !== undefined && n.childForFieldName('right');
      if (value) out.set(left!, [...out.get(left!) ?? [], { line: line(n), value }]);
      named(n).forEach(visit);
    };
    visit(root);
    return out;
  }).get(name) ?? [];
  return (all.filter(a => a.line < before).at(-1) ?? all[0])?.value ?? null;
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
      const made = owner?.type === 'identifier' ? assigned(fn.file, root, owner.text, ctx, line(d)) : null;
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
        const value = tree && assigned(file, tree.rootNode, alias, ctx);
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

const member = (c: Node) => { const f = c.childForFieldName('function'); return f?.type === 'member_expression' ? f : null; };
const skipPath = (list: Node[]) => list[0] && /string/.test(list[0].type) ? list.slice(1) : list;

/** A TS/JS file's calls, read once per walk: route registrations (`x.get(…)`), `x.use(mw)` by object, other plain calls. */
interface ExpressCalls { routes: Node[]; uses: Map<string, { line: number; names: string[] }[]>; plain: Node[] }

function expressCalls(file: string, root: Node, ctx: LinkContext): ExpressCalls {
  return perFile('calls', file, ctx, () => {
    const out: ExpressCalls = { routes: [], uses: new Map(), plain: [] };
    const visit = (n: Node) => {
      if (n.type === 'call_expression') {
        const m = member(n), method = m?.childForFieldName('property')?.text ?? '';
        if (!m) out.plain.push(n);
        else if (ROUTE_METHODS.has(method)) out.routes.push(n);
        else if (method === 'use') {
          const owner = m.childForFieldName('object')!.text;
          out.uses.set(owner, [...out.uses.get(owner) ?? [], { line: line(n), names: skipPath(args(n)).flatMap(a => middlewareName(a) ?? []) }]);
        }
      }
      named(n).forEach(visit);
    };
    visit(root);
    return out;
  });
}

function expressMiddleware(fn: GraphSymbol, root: Node, ctx: LinkContext): string[] {
  const { routes, uses, plain } = expressCalls(fn.file, root, ctx);
  const isHandler = (a: Node | undefined) => !!a && (a.type === 'identifier' ? a.text === fn.name : FUNCTION_VALUES.has(a.type) && line(a) === fn.line);
  const route = routes.find(c => isHandler(args(c).at(-1)));
  if (route) {
    // `owner.use(mw)` registered before the route applies to it.
    const owner = member(route)!.childForFieldName('object')!.text;
    return [...(uses.get(owner) ?? []).filter(u => u.line < line(route)).flatMap(u => u.names),
      ...skipPath(args(route)).slice(0, -1).flatMap(a => middlewareName(a) ?? [])];
  }
  // Next-style wrappers at the top level: `export default withAuth(handler)`, `export const GET = withAuth(handler)`.
  if (root.type !== 'program') return [];
  return plain.filter(c => args(c).some(a => a.type === 'identifier' && a.text === fn.name)).flatMap(c => lastName(c.childForFieldName('function')) ?? []);
}

export const authLinks: LinkProvider = {
  name: 'auth',
  hops(fn, call, ctx) {
    if (call) return [];
    // A function entered again (a shared dependency, a helper called from many places) reuses its hops.
    const key = `auth:hops:${fn.id}`;
    if (!ctx.memo.has(key)) ctx.memo.set(key, (async () => {
      const def = await functionNode(fn, ctx);
      if (!def) return [];
      const names = path.posix.extname(fn.file) === '.py' ? await pythonDependencies(fn, def, ctx) : expressMiddleware(fn, def.tree.rootNode, ctx);
      const hops: Hop[] = [];
      for (const name of new Set(names)) {
        const to = await symbolNamed(name, fn.file, ctx);
        if (to && to.id !== fn.id) hops.push({ to, kind: 'link', label: name, link: 'auth', certain: true });
      }
      return hops;
    })());
    return ctx.memo.get(key) as Promise<Hop[]>;
  },
};
