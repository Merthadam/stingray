// TypeScript / TSX / JavaScript adapter (tree-sitter-typescript, -tsx, -javascript share these statement types).
import type { Node } from 'web-tree-sitter';
import {
  action, closestFunction, code, collectCalls, ifConstruct, loopConstruct, named, ternary, tryConstruct,
  type Adapter, type CallSyntax, type Construct,
} from './cfg';

const FUNCTIONS = new Set(['function_declaration', 'generator_function_declaration', 'method_definition', 'function_expression',
  'function', 'arrow_function', 'generator_function']);
const syntax: CallSyntax = {
  calls: new Set(['call_expression', 'new_expression']),
  callee: n => n.childForFieldName('function') ?? n.childForFieldName('constructor'),
  awaits: new Set(['await_expression']),
  nested: new Set([...FUNCTIONS, 'class_declaration', 'class', 'abstract_class_declaration']),
  callback: fn => fn.type === 'arrow_function' || fn.type === 'function_expression' || fn.type === 'function' ? typescript.constructs(fn) : null,
};
const calls = (n: Node | null) => collectCalls(n, syntax);
const statements = (nodes: (Node | null)[]): Construct[] => nodes.filter((n): n is Node => n !== null).flatMap(statement);
const conditional = (n: Node | null) => {
  if (n?.type !== 'ternary_expression') return null;
  const cond = n.childForFieldName('condition'), a = n.childForFieldName('consequence'), b = n.childForFieldName('alternative');
  return cond && a && b ? { cond, a, b } : null;
};
/** `for (;;)` has `;` nodes where clauses are missing. */
const clause = (n: Node | null) => n && n.type !== 'empty_statement' && n.text !== ';' ? n : null;

function switchCases(body: Node | null): { label: string | null; body: Construct[] }[] {
  const cases: { label: string | null; body: Construct[] }[] = [];
  let pending: string[] = []; // `case 1: case 2:` share the next body
  for (const c of named(body)) {
    if (c.type !== 'switch_case' && c.type !== 'switch_default') continue;
    const label = c.type === 'switch_default' ? null : c.childForFieldName('value')?.text ?? null;
    const stmts = c.childrenForFieldName('body');
    if (!stmts.length && c.type === 'switch_case') { pending.push(label ?? ''); continue; }
    cases.push({ label: label === null ? null : [...pending, label].join(' / '), body: statements(stmts) });
    pending = [];
  }
  if (pending.length) cases.push({ label: pending.join(' / '), body: [] });
  return cases;
}

function statement(n: Node): Construct[] {
  switch (n.type) {
    case 'statement_block': return statements(named(n));
    case 'labeled_statement': return statements([n.childForFieldName('body')]);
    case 'if_statement': {
      const cond = n.childForFieldName('condition')!, alt = n.childForFieldName('alternative');
      return ifConstruct(n, cond, calls(cond), statements([n.childForFieldName('consequence')]), statements(named(alt)));
    }
    case 'for_in_statement': {
      const over = n.childForFieldName('right');
      return loopConstruct(n, { over, cond: null }, calls(over), statements([n.childForFieldName('body')]));
    }
    case 'for_statement': {
      const cond = clause(n.childForFieldName('condition'));
      return [...action(n, calls(clause(n.childForFieldName('initializer')))),
        ...loopConstruct(n, { over: null, cond }, calls(cond), [...statements([n.childForFieldName('body')]), ...action(n, calls(n.childForFieldName('increment')))])];
    }
    case 'while_statement': case 'do_statement': {
      // shortcut: do-while is drawn like while (condition first); fine for reading, not for counting iterations.
      const cond = n.childForFieldName('condition');
      return loopConstruct(n, { over: null, cond }, calls(cond), statements([n.childForFieldName('body')]));
    }
    case 'try_statement': {
      const handler = n.childForFieldName('handler'), finalizer = n.childForFieldName('finalizer');
      const handlers = handler ? [{ label: 'error', line: handler.startPosition.row + 1, types: null, body: statements([handler.childForFieldName('body')]) }] : [];
      return tryConstruct(n, statements([n.childForFieldName('body')]), handlers, statements([finalizer?.childForFieldName('body') ?? null]));
    }
    case 'switch_statement': {
      const subject = n.childForFieldName('value')!, cases = switchCases(n.childForFieldName('body'));
      if (cases.every(c => !c.body.length)) return action(n, calls(subject));
      return [{ type: 'switch', code: code(n), subject: subject.text, calls: calls(subject), cases, breakable: true }];
    }
    case 'return_statement': {
      const value = named(n)[0] ?? null;
      return ternary(n, conditional(value), syntax, (v, c) => [{ type: 'return', code: code(n), value: v.text, calls: c }])
        ?? [{ type: 'return', code: code(n), value: value?.text ?? null, calls: calls(value) }];
    }
    case 'throw_statement': {
      const value = named(n)[0] ?? null;
      return [{ type: 'raise', code: code(n), value: value?.text ?? null, calls: calls(value) }];
    }
    case 'expression_statement': {
      const expr = named(n)[0] ?? null;
      const value = expr?.type === 'assignment_expression' || expr?.type === 'augmented_assignment_expression' ? expr.childForFieldName('right') : expr;
      return ternary(n, conditional(value), syntax, (_, c) => action(n, c)) ?? action(n, calls(n));
    }
    case 'lexical_declaration': case 'variable_declaration':
      return named(n).filter(d => d.type === 'variable_declarator').flatMap(d =>
        ternary(n, conditional(d.childForFieldName('value')), syntax, (_, c) => action(n, c)) ?? action(n, calls(d)));
    case 'break_statement': return [{ type: 'break', code: code(n) }];
    case 'continue_statement': return [{ type: 'continue', code: code(n) }];
    default:
      return syntax.nested.has(n.type) ? [] : action(n, calls(n));
  }
}

/** Name a function node is known by: its own name, or what it is assigned to (`const f = () => ...`, `{ f() {} }`). */
function functionName(n: Node): string | null {
  const own = n.childForFieldName('name');
  if (own) return own.text;
  const p = n.parent;
  if (!p) return null;
  const target = p.type === 'variable_declarator' || p.type === 'public_field_definition' || p.type === 'field_definition' ? p.childForFieldName('name')
    : p.type === 'pair' ? p.childForFieldName('key') : p.type === 'assignment_expression' ? p.childForFieldName('left') : null;
  return target ? target.text.split('.').at(-1)!.replace(/^['"]|['"]$/g, '') : null;
}

export const typescript: Adapter = {
  findFunction(root, name, line) {
    const candidates: { node: Node; name: string | null; lines: number[] }[] = [];
    const visit = (n: Node) => {
      if (FUNCTIONS.has(n.type)) {
        const lines = [n.startPosition.row + 1];
        for (let p = n.parent, i = 0; p && i < 3; p = p.parent, i++) lines.push(p.startPosition.row + 1); // declaration / export line
        candidates.push({ node: n, name: functionName(n), lines });
      }
      named(n).forEach(visit);
    };
    visit(root);
    return closestFunction(candidates, name, line);
  },
  constructs(fn) {
    const body = fn.childForFieldName('body');
    if (!body) return [];
    if (body.type === 'statement_block') return statements(named(body));
    // Expression-bodied arrow function: its value is returned.
    return ternary(body, conditional(body), syntax, (v, c) => [{ type: 'return', code: code(v), value: v.text, calls: c }])
      ?? [{ type: 'return', code: code(body), value: body.text, calls: calls(body) }];
  },
};
