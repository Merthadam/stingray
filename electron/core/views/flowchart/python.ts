// Python adapter (tree-sitter-python): function bodies -> constructs.
import type { Node } from 'web-tree-sitter';
import {
  action, closestFunction, code, collectCalls, ifConstruct, loopConstruct, named, ternary, tryConstruct,
  type Adapter, type CallSyntax, type Construct, type Handler,
} from './cfg';

const syntax: CallSyntax = {
  calls: new Set(['call']),
  callee: n => n.childForFieldName('function'),
  awaits: new Set(['await']),
  nested: new Set(['function_definition', 'lambda', 'class_definition', 'decorated_definition']),
};
const calls = (n: Node | null) => collectCalls(n, syntax);
const block = (n: Node | null): Construct[] => named(n).flatMap(statement);
/** `a if c else b` */
const conditional = (n: Node | null) => {
  if (n?.type !== 'conditional_expression') return null;
  const [a, cond, b] = named(n);
  return a && cond && b ? { cond, a, b } : null;
};

/** `for … else` / `while … else`: runs when the loop ends without `break`. */
const loopElse = (n: Node) => block(n.childForFieldName('alternative')?.childForFieldName('body') ?? null);

function ifChain(at: Node, cond: Node, consequence: Node | null, alternatives: Node[]): Construct[] {
  const [alt, ...rest] = alternatives;
  const otherwise = !alt ? [] : alt.type === 'elif_clause'
    ? ifChain(alt, alt.childForFieldName('condition')!, alt.childForFieldName('consequence'), rest)
    : block(alt.childForFieldName('body'));
  return ifConstruct(at, cond, calls(cond), block(consequence), otherwise);
}

function statement(n: Node): Construct[] {
  switch (n.type) {
    case 'if_statement':
      return ifChain(n, n.childForFieldName('condition')!, n.childForFieldName('consequence'),
        n.childrenForFieldName('alternative').filter((a): a is Node => a !== null));
    case 'for_statement': {
      const over = n.childForFieldName('right');
      return loopConstruct(n, { over, cond: null }, calls(over), block(n.childForFieldName('body')), loopElse(n));
    }
    case 'while_statement': {
      const cond = n.childForFieldName('condition');
      return loopConstruct(n, { over: null, cond }, calls(cond), block(n.childForFieldName('body')), loopElse(n));
    }
    case 'try_statement': {
      const body = block(n.childForFieldName('body')), handlers: Handler[] = [], otherwise: Construct[] = [], fin: Construct[] = [];
      for (const part of named(n)) {
        if (part.type === 'except_clause' || part.type === 'except_group_clause') {
          const value = part.childForFieldName('value') ?? named(part).find(c => c.type !== 'block') ?? null;
          const type = value?.type === 'as_pattern' ? named(value)[0] : value;
          const names = type?.text.match(/[\w.]+/g)?.map(t => t.split('.').at(-1)!) ?? null;
          // shortcut: subclasses are unknown, so only `Exception`/`BaseException` (and bare except) catch any raise by name.
          const types = !names || names.some(t => t === 'Exception' || t === 'BaseException') ? null : names;
          handlers.push({ label: type?.text.replace(/\s+/g, ' ') ?? 'error', line: part.startPosition.row + 1, types, body: block(named(part).find(c => c.type === 'block') ?? null) });
        } else if (part.type === 'else_clause') otherwise.push(...block(part.childForFieldName('body')));
        else if (part.type === 'finally_clause') fin.push(...block(named(part).find(c => c.type === 'block') ?? null));
      }
      return tryConstruct(n, body, handlers, fin, otherwise);
    }
    case 'with_statement':
      return [...action(n, calls(named(n).find(c => c.type === 'with_clause') ?? null)), ...block(n.childForFieldName('body'))];
    case 'match_statement': {
      const subject = n.childForFieldName('subject')!;
      const cases = named(n.childForFieldName('body')).filter(c => c.type === 'case_clause').map(c => {
        const pattern = named(c).filter(p => p.type === 'case_pattern').map(p => p.text).join(', ');
        const guard = named(c).find(p => p.type === 'if_clause')?.text;
        return { label: pattern === '_' && !guard ? null : [pattern, guard].filter(Boolean).join(' ') || null, body: block(c.childForFieldName('consequence')) };
      });
      if (cases.every(c => !c.body.length)) return action(n, calls(subject));
      return [{ type: 'switch', code: code(n), subject: subject.text, calls: calls(subject), cases, breakable: false }];
    }
    case 'return_statement': {
      const value = named(n)[0] ?? null;
      return ternary(n, conditional(value), syntax, (v, c) => [{ type: 'return', code: code(n), value: v.text, calls: c }])
        ?? [{ type: 'return', code: code(n), value: value?.text ?? null, calls: calls(value) }];
    }
    case 'raise_statement': {
      const value = named(n)[0] ?? null; // `raise X from e`: X
      return [{ type: 'raise', code: code(n), value: value?.text ?? null, calls: calls(value) }];
    }
    case 'expression_statement': {
      const expr = named(n)[0] ?? null;
      const value = expr?.type === 'assignment' || expr?.type === 'augmented_assignment' ? expr.childForFieldName('right') : expr;
      return ternary(n, conditional(value), syntax, (_, c) => action(n, c)) ?? action(n, calls(n));
    }
    case 'break_statement': return [{ type: 'break', code: code(n) }];
    case 'continue_statement': return [{ type: 'continue', code: code(n) }];
    default:
      return syntax.nested.has(n.type) ? [] : action(n, calls(n));
  }
}

export const python: Adapter = {
  findFunction(root, name, line) {
    const candidates: { node: Node; name: string | null; lines: number[] }[] = [];
    const visit = (n: Node) => {
      if (n.type === 'function_definition') {
        const lines = [n.startPosition.row + 1];
        if (n.parent?.type === 'decorated_definition') lines.push(n.parent.startPosition.row + 1);
        candidates.push({ node: n, name: n.childForFieldName('name')?.text ?? null, lines });
      }
      named(n).forEach(visit);
    };
    visit(root);
    return closestFunction(candidates, name, line);
  },
  constructs: fn => block(fn.childForFieldName('body')),
};
