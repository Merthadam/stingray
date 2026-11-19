import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, createEvaluate, evaluate } from '../electron/views/rules/engine';
import { codegraphGrammarDir } from '../electron/views/rules/grammars';
import type { Emit, GraphApi, GraphStep, ResolvedView, Rule, RunGraphStep, SourcedRule } from '../electron/views/rules/types';
import type { GraphStatus } from '../src/views';

const grammarDir = codegraphGrammarDir();
const READY: GraphStatus = { state: 'ready', message: null };
const memoryFiles = (files: Record<string, string>) => ({
  list: async () => ({ files: Object.keys(files), truncated: false }),
  read: async (f: string) => files[f] ?? null,
});
let n = 0;
const rule = (language: string, query: string, emit: Emit, extra: Partial<Rule> = {}): SourcedRule =>
  ({ source: 'view', file: '.stingray/views/t.yaml', line: 1, queryLine: 2, rule: { id: `r${++n}`, language, query, emit, ...extra } });
const viewOf = (rules: SourcedRule[], extra: Partial<ResolvedView> = {}): ResolvedView =>
  ({ id: 't', kind: 'flow', scope: { include: ['**/*'], exclude: [] }, rules, graph: null, flowchart: null, builtins: [], include: [], exclude: [], ...extra });
const run = (view: ResolvedView, files: Record<string, string>, graph: GraphApi | null = null) =>
  evaluate({ view, files: memoryFiles(files), graph, graphStatus: graph ? READY : { state: 'indexing', message: null }, grammarDir });

const assignment = (name: string, capture: string) =>
  `(module (expression_statement (assignment left: (identifier) @k (#eq? @k "${name}") right: (string (string_content) @${capture}))))`;
const migration = (rev: string, prev: string | null, up: string, down: string) => [
  `revision = "${rev}"`, `down_revision = ${prev === null ? 'None' : `"${prev}"`}`, '', 'def upgrade():', `    op.${up}("users")`, '', 'def downgrade():', `    op.${down}("users")`, '',
].join('\n');
const alembic = {
  'versions/a.py': migration('a1', null, 'create_table', 'drop_table'),
  'versions/b.py': migration('b2', 'a1', 'add_column', 'drop_column'),
  'versions/c.py': migration('c3', 'zz', 'alter_column', 'alter_column'),
  'other/x.py': migration('x9', 'a1', 'create_table', 'drop_table'),
};

test('alembic: alias joins chain revisions, within picks upgrade, create makes placeholders', async () => {
  const files = ['versions/*.py'];
  const out = await run(viewOf([
    rule('python', assignment('revision', 'rev'), { node: { id: '@file', label: '@rev', kind: 'migration', aliases: ['@rev'], subtitle: '@stem', detail: 'rev @rev' } }, { files }),
    rule('python', assignment('down_revision', 'prev'), { edge: { from: '@prev', to: '@file', kind: 'revision' } }, { files }),
    rule('python', '(call function: (attribute object: (identifier) @op (#eq? @op "op") attribute: (identifier) @action) arguments: (argument_list . (string (string_content) @table)))',
      { field: { node: '@file', id: '@action-@table', label: '@action @table', badges: ['@function', ''] } }, { files, within: { function: 'upgrade' } }),
    rule('python', '(call function: (attribute attribute: (identifier) @action (#match? @action "^(create|add)_")) arguments: (argument_list . (string (string_content) @table)))',
      { edge: { from: '@file', to: '@table', kind: 'touches', certain: false, create: 'to' } }, { files, within: { function: 'upgrade' } }),
  ]), alembic);
  assert.deepEqual(out.nodes.map(x => [x.id, x.label, x.kind, x.subtitle, x.detail]), [
    ['versions/a.py', 'a1', 'migration', 'a', 'rev a1'], ['versions/b.py', 'b2', 'migration', 'b', 'rev b2'], ['versions/c.py', 'c3', 'migration', 'c', 'rev c3'], ['users', 'users', 'placeholder', null, null],
  ]);
  assert.deepEqual(out.nodes[0].fields.map(f => [f.id, f.label, f.badges, f.source]), [['create_table-users', 'create_table users', ['upgrade'], { file: 'versions/a.py', line: 5 }]]);
  assert.deepEqual(out.nodes[1].fields.map(f => f.id), ['add_column-users']);
  assert.deepEqual(out.edges.map(e => [e.id, e.style, e.certain]), [
    ['touches:versions/a.py->users', 'dashed', false],
    ['revision:versions/a.py->versions/b.py', 'solid', true],
    ['touches:versions/b.py->users', 'dashed', false],
  ]);
  assert.deepEqual(out.diagnostics.unresolved, [{ rule: 'view#r2', value: 'zz', file: 'versions/c.py', line: 2 }]);
  const [revs, downs, ops] = out.diagnostics.rules;
  assert.deepEqual([revs.filesScanned, revs.matches, revs.emitted, revs.skipped], [3, 3, 3, 0]);
  assert.deepEqual([downs.matches, downs.emitted], [2, 2]); // `None` is not a string
  assert.deepEqual([ops.matches, ops.emitted], [6, 3]); // downgrade matches are counted but not emitted
  assert.equal(out.diagnostics.limits.filesScanned, 3);
  assert.equal(out.truncated, false);
});

const langgraph = `from langgraph.graph import StateGraph, START, END

def build_graph():
    g = StateGraph(State)
    g.add_node("plan", plan_step)
    g.add_node("act", act_step)
    g.add_edge(START, "plan")
    g.add_conditional_edges("plan", route, {"go": "act", "stop": END})
    g.add_edge("act", END)
    return g.compile()
`;
const method = (name: string) => `(call function: (attribute attribute: (identifier) @m (#eq? @m "${name}"))`;
const end = '[(string (string_content) @to) (identifier) @to]';
const langgraphRules = () => [
  rule('python', `${method('add_node')} arguments: (argument_list . (string (string_content) @name) . (identifier) @handler))`,
    { node: { id: '@name', kind: 'step', symbol: '@handler', group: '@function' } }),
  rule('python', '((identifier) @id (#eq? @id "START"))', { node: { id: '@id', role: 'start', kind: 'terminal' } }),
  rule('python', '((identifier) @id (#eq? @id "END"))', { node: { id: '@id', role: 'end', kind: 'terminal' } }),
  rule('python', `${method('add_edge')} arguments: (argument_list . [(string (string_content) @from) (identifier) @from] . ${end}))`, { edge: { from: '@from', to: '@to' } }),
  rule('python', `${method('add_conditional_edges')} arguments: (argument_list . (string (string_content) @from) . (identifier) . (dictionary (pair key: (string (string_content) @label) value: ${end}))))`,
    { edge: { from: '@from', to: '@to', label: '@label', certain: false } }),
];

test('langgraph-like flow: START/END roles, conditional labeled edges, groups and symbol links', async () => {
  const symbols = { plan_step: { id: 's1', name: 'plan_step', kind: 'function', file: 'agent.py', line: 20 }, act_step: { id: 's2', name: 'act_step', kind: 'function', file: 'lib.py', line: 3 } };
  const graph: GraphApi = {
    findSymbols: (name, file) => [symbols[name as keyof typeof symbols]].filter(s => s && (!file || s.file === file)),
    symbols: () => new Map(), outgoing: () => [], incoming: () => [], fileSymbols: () => [], layers: () => null, rollup: () => [],
  };
  const out = await run(viewOf(langgraphRules()), { 'agent.py': langgraph }, graph);
  assert.deepEqual(out.nodes.map(x => [x.id, x.kind, x.role, x.group, x.symbol?.id ?? null]), [
    ['plan', 'step', null, 'build_graph', 's1'], ['act', 'step', null, 'build_graph', 's2'], ['START', 'terminal', 'start', null, null], ['END', 'terminal', 'end', null, null],
  ]);
  assert.deepEqual(out.groups, [{ id: 'build_graph', label: 'build_graph', source: null }]);
  assert.deepEqual(out.edges.map(e => [e.id, e.label, e.style]), [
    ['edge:START->plan', null, 'solid'], ['edge:act->END', null, 'solid'], ['edge:plan->act', 'go', 'dashed'], ['edge:plan->END', 'stop', 'dashed'],
  ]);
  assert.deepEqual(out.edges[0].source, { file: 'agent.py', line: 7 });
  assert.equal(out.diagnostics.graph, null);
});

test('merge, quantified captures, duplicate edges, include/exclude and missing captures', async () => {
  const src = '@a\n@b\n@a\ndef f(): pass\nlink("x", "y", "one")\nlink("x", "y", "two")\nlink("x", "y", "two")\nlink("x", "y")\n';
  const out = await run(viewOf([
    rule('python', '(decorated_definition (decorator (identifier) @t)+ definition: (function_definition))', { node: { id: '@t', label: 'tag @t' } }),
    rule('python', '(decorated_definition (decorator (identifier) @t)+ definition: (function_definition))', { node: { id: '@t', label: 'ignored', kind: 'tag', group: 'g' } }),
    rule('python', '(call function: (identifier) @f (#eq? @f "link") arguments: (argument_list . (string (string_content) @a) . (string (string_content) @b) (string (string_content) @l)?))',
      { edge: { from: '@a', to: '@b', label: '@l', create: 'both' } }),
    rule('python', '(call function: (identifier) @f (#eq? @f "link") arguments: (argument_list . (string (string_content) @a) . (string) (string (string_content) @l)?))',
      { field: { node: '@a', id: '@l', type: '@@int' } }),
  ], { exclude: ['b', 'tag a'] }), { 'm.py': src });
  assert.deepEqual(out.nodes.map(x => [x.id, x.label, x.kind, x.group]), [['x', 'x', 'placeholder', null], ['y', 'y', 'placeholder', null]]);
  assert.deepEqual(out.nodes[0].fields.map(f => [f.id, f.type]), [['one', '@int'], ['two', '@int']]);
  assert.deepEqual(out.groups.map(g => g.id), ['g']);
  assert.deepEqual(out.edges.map(e => [e.id, e.label]), [['edge:x->y', 'one'], ['edge:x->y#2', 'two'], ['edge:x->y#3', null]]);
  const [tags, , , fieldRule] = out.diagnostics.rules;
  assert.deepEqual([tags.matches, tags.emitted], [1, 3]);
  assert.deepEqual([fieldRule.matches, fieldRule.emitted, fieldRule.skipped], [4, 3, 1]);
});

test('query and capture errors point into the YAML; zero matches warn; missing grammar is a rule error', async () => {
  const bad = rule('python', '(call)\n  (bogus) @x', { node: { id: '@x' } });
  bad.queryLine = 10;
  const out = await run(viewOf([
    bad,
    rule('python', '(call) @c', { node: { id: '@nope' } }),
    rule('python', '(class_definition) @c', { node: { id: '@c' } }),
    rule('klingon', '(x) @x', { node: { id: '@x' } }),
    rule('python', '(call) @c', { node: { id: 'n', order: '@c', role: 'middle' } }),
  ]), { 'a.py': 'f()\n' });
  const [q, cap, none, lang, order] = out.diagnostics.rules;
  assert.deepEqual(q.errors, [{ file: '.stingray/views/t.yaml', line: 11, message: "Query error: Bad node name 'bogus' (query line 2, column 4)" }]);
  assert.match(cap.errors[0].message, /captures the query does not define: @nope/);
  assert.deepEqual(none.warnings, [{ file: '.stingray/views/t.yaml', line: 1, message: 'Rule matched nothing' }]);
  assert.match(lang.errors[0].message, /Unknown language "klingon"/);
  assert.deepEqual(order.warnings.map(w => w.message), ['role must be "start" or "end", got "middle"', 'order must be a number, got "f()"']);
  assert.deepEqual([out.nodes[0].role, out.nodes[0].order], [null, null]);
});

test('match caps truncate and warn', async () => {
  const saved = LIMITS.matchesPerRule;
  LIMITS.matchesPerRule = 2;
  try {
    const out = await run(viewOf([rule('python', '(call function: (identifier) @f)', { node: { id: '@f' } })]), { 'a.py': 'a()\nb()\nc()\n' });
    assert.deepEqual(out.nodes.map(x => x.id), ['a', 'b']);
    assert.equal(out.truncated, true);
    assert.match(out.diagnostics.rules[0].warnings[0].message, /Match cap hit \(2\)/);
  } finally { LIMITS.matchesPerRule = saved; }
});

test('typescript, tsx and terraform grammars load; within finds methods, arrow functions and classes', async () => {
  const ts = "export class AppStack extends Stack {\n  constructor() { new Bucket(this, 'Logs'); }\n}\nconst build = () => { new Queue(this, 'Jobs'); };\nfunction other() { new Bucket(this, 'Other'); }\n";
  const newExpr = '(new_expression constructor: (identifier) @type arguments: (arguments (this) (string (string_fragment) @name)))';
  const out = await run(viewOf([
    rule('typescript', newExpr, { node: { id: '@name', kind: '@type', subtitle: '@class.@function' } }),
    rule('typescript', newExpr, { group: { id: '@name' } }, { within: { class: '*Stack' } }),
    rule('tsx', '(jsx_self_closing_element name: (identifier) @c)', { node: { id: '@c', subtitle: '@function' } }),
    rule('terraform', '(block (identifier) @t (#eq? @t "resource") (string_lit (template_literal) @type) (string_lit (template_literal) @name))', { node: { id: '@type.@name', kind: 'resource' } }),
  ]), { 'stack.ts': ts, 'app.tsx': 'const App = () => <Button label="x" />;\n', 'main.tf': 'resource "aws_s3_bucket" "logs" {\n  bucket = "x"\n}\n' });
  assert.deepEqual(out.nodes.map(x => [x.id, x.kind, x.subtitle]), [
    ['Logs', 'Bucket', 'AppStack.constructor'], ['Jobs', 'Queue', '.build'], ['Other', 'Bucket', '.other'], ['Button', 'node', 'App'], ['aws_s3_bucket.logs', 'resource', null],
  ]);
  assert.deepEqual(out.groups.map(g => g.id), ['Logs']);
  assert.ok(out.diagnostics.rules.every(r => r.errors.length === 0));
});

const step: GraphStep = { start: [{ symbol: 'plan_step' }], follow: ['calls'], direction: 'out', depth: 3, helpers: 'collapse' };

test('graph steps merge with rule nodes by symbol; without a graph the step reports why', async () => {
  const sym = (id: string, name: string) => ({ id, name, kind: 'function', file: 'agent.py', line: 1 });
  const graph: GraphApi = { findSymbols: name => name === 'plan_step' ? [sym('s1', 'plan_step')] : [], symbols: () => new Map(), outgoing: () => [], incoming: () => [], fileSymbols: () => [], layers: () => null, rollup: () => [] };
  let scoped: ((f: string) => boolean) | null = null;
  const fake: RunGraphStep = (s, g, inScope) => {
    assert.equal(s, step); assert.equal(g, graph); scoped = inScope;
    const node = (id: string, label: string) => ({ id, label, kind: 'function', subtitle: null, group: null, source: { file: 'agent.py', line: 1 }, symbol: sym(id, label), role: null, order: null, detail: null,
      fields: id === 's1' ? [{ id: 'calls', label: 'calls: slugify', type: null, badges: [], detail: null, source: null }] : [] });
    return {
      nodes: [node('s1', 'plan_step'), node('s3', 'fetch')],
      edges: [{ id: 'calls:s1->s3', from: 's1', to: 's3', fromField: null, toField: null, kind: 'calls', style: 'dashed', certain: false, label: null, source: null }],
      diagnostic: { started: 1, reached: 2, helpers: 1, truncated: false, error: null }, truncated: false,
    };
  };
  const view = viewOf(langgraphRules().slice(0, 1), { graph: step, scope: { include: ['**/*.py'], exclude: [] } });
  const files = memoryFiles({ 'agent.py': langgraph });
  const out = await createEvaluate({ runGraphStep: fake })({ view, files, graph, graphStatus: READY, grammarDir });
  assert.deepEqual(out.nodes.map(x => [x.id, x.label, x.kind, x.symbol?.id ?? null, x.fields.map(f => f.id)]), [
    ['plan', 'plan', 'step', 's1', ['calls']], ['act', 'act', 'step', null, []], ['s3', 'fetch', 'function', 's3', []],
  ]);
  assert.deepEqual(out.edges.map(e => [e.id, e.from, e.to, e.style]), [['calls:plan->s3', 'plan', 's3', 'dashed']]);
  assert.deepEqual(out.diagnostics.graph, { started: 1, reached: 2, helpers: 1, truncated: false, error: null });
  assert.equal(scoped!('a/b.py'), true);
  assert.equal(scoped!('a/b.ts'), false);

  const none = await createEvaluate({ runGraphStep: () => assert.fail('no graph') })({ view, files, graph: null, graphStatus: { state: 'indexing', message: null }, grammarDir });
  assert.equal(none.diagnostics.graph?.error, 'code graph not ready (indexing)');
  assert.deepEqual(none.nodes.map(x => x.id), ['plan', 'act']);
});

test('abort stops the evaluation with a partial result', async () => {
  const controller = new AbortController();
  controller.abort();
  const out = await evaluate({ view: viewOf([rule('python', '(call) @c', { node: { id: '@c' } })]), files: memoryFiles({ 'a.py': 'f()\n' }),
    graph: null, graphStatus: READY, grammarDir, signal: controller.signal });
  assert.equal(out.truncated, true);
  assert.deepEqual(out.warnings.map(w => w.message), ['Evaluation aborted']);
});
