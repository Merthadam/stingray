// Type-based member resolution for TypeScript calls the code graph left unresolved (docs/sequence-view-spec.md §Model):
// `this.f.m()` with a class field / constructor parameter property `f: SomeClass`, and `p.m()` / `p.f.m()` with a parameter
// (of the function or an enclosing one) typed by a class or an object type literal. The method is looked up in the class,
// then along its `extends` edges. Explicit annotations only: no inference, no interfaces (their methods have no body).
import * as path from '../../shared/posix-path';
import type { Node } from 'web-tree-sitter';
import type { GraphSymbol } from '../rules/types';
import type { Call } from '../flowchart/cfg';
import { named } from '../flowchart/cfg';
import { FUNCTION_KINDS } from '../flowchart';
import { symbolNamed, type LinkContext } from './links';

type Env = Pick<LinkContext, 'graph' | 'tree' | 'imports'>;
const TS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const CLASSES = new Set(['class']);
const CLASS_NODES = new Set(['class_declaration', 'class', 'abstract_class_declaration']);
const FUNCTION_NODES = new Set(['function_declaration', 'method_definition', 'function_expression', 'function', 'arrow_function']);
const MAX_BASES = 5;
const WRAPPERS = new Set(['Pick', 'Omit', 'Partial', 'Readonly', 'Required', 'NonNullable']);

/** What a receiver's type annotation names: an object type literal (its node) or a repo class. */
type Resolved = { object: Node; file: string } | { cls: GraphSymbol };

/** The repo method `call` (in `file`) reaches through typed receivers, or null. */
export async function typedMember(call: Call, file: string, env: Env): Promise<GraphSymbol | null> {
  if (!TS.has(path.extname(file).toLowerCase())) return null;
  const parts = call.path.replace(/\?\./g, '.').replace(/!/g, '').split('.');
  if (parts.length < 2 || parts.length > 3 || !parts.every(p => /^[\w$]+$/.test(p))) return null;
  const tree = await env.tree(file);
  const site = tree && callAt(tree.rootNode, call.line, call.path);
  if (!site) return null;
  const [root, ...members] = parts, method = members.pop()!;
  let at: Resolved | null;
  if (root === 'this') {
    const cls = ancestor(site, n => CLASS_NODES.has(n.type));
    const name = cls?.childForFieldName('name')?.text;
    at = name ? await classNamed(name, file, env) : null;
  } else {
    at = await paramType(site, root, file, env);
  }
  for (const field of members) at = at && await memberType(at, field, env);
  return at && 'cls' in at ? methodOf(at.cls, method, env) : null;
}

/** The call node on `line` whose callee text (without whitespace) is `calleePath`. */
function callAt(root: Node, line: number, calleePath: string): Node | null {
  const row = line - 1;
  const visit = (n: Node): Node | null => {
    if (n.startPosition.row > row || n.endPosition.row < row) return null;
    if (n.type === 'call_expression' && n.startPosition.row === row && n.childForFieldName('function')?.text.replace(/\s+/g, '') === calleePath) return n;
    for (const c of named(n)) { const hit = visit(c); if (hit) return hit; }
    return null;
  };
  return visit(root);
}

function ancestor(n: Node, test: (n: Node) => boolean): Node | null {
  for (let p = n.parent; p; p = p.parent) if (test(p)) return p;
  return null;
}

/** Type of parameter `name` of the innermost enclosing function declaring it (closures see their parents' parameters). */
async function paramType(site: Node, name: string, file: string, env: Env): Promise<Resolved | null> {
  for (let fn = ancestor(site, n => FUNCTION_NODES.has(n.type)); fn; fn = ancestor(fn, n => FUNCTION_NODES.has(n.type))) {
    const param = named(fn.childForFieldName('parameters')).find(p => p.childForFieldName('pattern')?.text === name)
      ?? (fn.childForFieldName('parameter')?.text === name ? fn.childForFieldName('parameter') : null); // `x => …`
    if (param) return typeOf(param.childForFieldName('type'), file, env);
  }
  return null;
}

/** A type annotation as an object type literal or a repo class (`X | null` -> X, `X<T>` -> X). */
async function typeOf(annotation: Node | null, file: string, env: Env): Promise<Resolved | null> {
  let t = annotation?.type === 'type_annotation' ? named(annotation)[0] : annotation;
  if (t?.type === 'union_type') {
    const kept = named(t).filter(m => m.type !== 'literal_type' && !['null', 'undefined'].includes(m.text));
    t = kept.length === 1 ? kept[0] : null;
  }
  if (!t) return null;
  if (t.type === 'object_type') return { object: t, file };
  // `Pick<GitService, 'workspace'>`, `Readonly<Store>`: the members are the wrapped type's.
  if (t.type === 'generic_type' && WRAPPERS.has(t.childForFieldName('name')?.text ?? '')) return typeOf(named(t.childForFieldName('type_arguments'))[0] ?? null, file, env);
  const name = t.type === 'generic_type' ? t.childForFieldName('name')?.text : t.type === 'type_identifier' || t.type === 'nested_type_identifier' ? t.text : null;
  return name ? classNamed(name.split('.').at(-1)!, file, env) : null;
}

async function classNamed(name: string, file: string, env: Env): Promise<Resolved | null> {
  const cls = await symbolNamed(name, file, env, CLASSES);
  return cls ? { cls } : null;
}

/** Type of `field` on an object type literal, or of a field / constructor parameter property of a class (or its bases). */
async function memberType(at: Resolved, field: string, env: Env): Promise<Resolved | null> {
  if ('object' in at) {
    const prop = named(at.object).find(p => p.type === 'property_signature' && p.childForFieldName('name')?.text === field);
    return prop ? typeOf(prop.childForFieldName('type'), at.file, env) : null;
  }
  for (const cls of bases(at.cls, env)) {
    const node = await classNode(cls, env);
    if (!node) continue;
    for (const m of named(node.childForFieldName('body'))) {
      if ((m.type === 'public_field_definition' || m.type === 'field_definition') && m.childForFieldName('name')?.text === field) return typeOf(m.childForFieldName('type'), cls.file, env);
      if (m.type === 'method_definition' && m.childForFieldName('name')?.text === 'constructor') {
        // Parameter properties (`constructor(private readonly store: Store)`) carry an accessibility or readonly modifier.
        const param = named(m.childForFieldName('parameters')).find(p => p.childForFieldName('pattern')?.text === field && /^(?:public|private|protected|readonly)\b/.test(p.text));
        if (param) return typeOf(param.childForFieldName('type'), cls.file, env);
      }
    }
  }
  return null;
}

async function classNode(cls: GraphSymbol, env: Env): Promise<Node | null> {
  const tree = await env.tree(cls.file);
  if (!tree) return null;
  const visit = (n: Node): Node | null => {
    if (CLASS_NODES.has(n.type) && n.childForFieldName('name')?.text === cls.name && Math.abs(n.startPosition.row + 1 - cls.line) <= 3) return n;
    for (const c of named(n)) { const hit = visit(c); if (hit) return hit; }
    return null;
  };
  return visit(tree.rootNode);
}

/** The class, then its bases along `extends` edges of the code graph (at most MAX_BASES). */
function bases(cls: GraphSymbol, env: Env): GraphSymbol[] {
  const out = [cls];
  for (let i = 0; i < MAX_BASES; i++) {
    const base = [...env.graph.symbols(env.graph.outgoing([out.at(-1)!.id], ['extends']).map(r => r.to)).values()].find(s => s.kind === 'class');
    if (!base || out.some(s => s.id === base.id)) break;
    out.push(base);
  }
  return out;
}

/** Method `name` of the class or the nearest base declaring it. */
function methodOf(cls: GraphSymbol, name: string, env: Env): GraphSymbol | null {
  for (const c of bases(cls, env)) {
    const hit = env.graph.fileSymbols(c.file).find(s => s.name === name && FUNCTION_KINDS.has(s.kind) && s.line > c.line && (c.endLine === undefined || s.line <= c.endLine));
    if (hit) return hit;
  }
  return null;
}
