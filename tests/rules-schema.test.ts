import test from 'node:test';
import assert from 'node:assert/strict';
import { YamlError, parseRuleFileYaml, parseViewYaml } from '../electron/views/rules/schema';
import { renderTemplate, templateCaptures } from '../electron/views/rules/template';

const F = '.stingray/views/v.yaml';
const errorOf = (text: string) => {
  try { parseViewYaml(text, F); } catch (e) { assert.ok(e instanceof YamlError); return { line: e.line, message: e.message }; }
  return null;
};
const view = (extra = '') => `version: 1\nname: V\nkind: flow\nuse: [langgraph]\n${extra}`;

test('parseViewYaml applies defaults and records rule and query lines', () => {
  const v = parseViewYaml([
    'version: 1', 'name: Flow', 'kind: flow', 'rules:', '  - id: a', '    language: python', '    query: |',
    '      (call) @c', '    emit: { node: { id: "@c" } }', '  - id: b', '    language: tsx', '    query: "(x) @x"',
    '    emit: { group: { id: "@x" } }', 'graph:', '  start: [{ symbol: main }]', '  follow: [calls]', 'use: [x, x, y]',
  ].join('\n'), F);
  assert.deepEqual(v.scope, { include: ['**/*'], exclude: [] });
  assert.deepEqual(v.graph, { start: [{ symbol: 'main' }], follow: ['calls'], direction: 'out', depth: 3, helpers: 'collapse' });
  assert.deepEqual(v.use, [{ name: 'x', line: 17 }, { name: 'y', line: 17 }]);
  assert.deepEqual(v.rules.map(r => [r.source, r.file, r.line, r.queryLine, r.rule.id]), [['view', F, 5, 8, 'a'], ['view', F, 10, 12, 'b']]);
  assert.equal(v.rules[0].rule.query, '(call) @c\n');
});

test('view YAML errors carry line numbers', () => {
  assert.deepEqual(errorOf(view('extra: 1')), { line: 5, message: 'Unrecognized key: "extra"' });
  assert.match(errorOf('version: 1\nname: V\nkind: nope\nuse: [a]')!.message, /^kind:/);
  assert.equal(errorOf('version: 1\nname: V\nkind: nope\nuse: [a]')!.line, 3);
  assert.match(errorOf('version: 1\nname: V\nkind: flow')!.message, /at least one of use, rules, graph or flowchart/);
  assert.deepEqual(errorOf('version: 1\nname: V\nname: W\nkind: flow\nuse: [a]')?.line, 3); // duplicate key
  assert.match(errorOf('a: [\n')!.message, /^Invalid YAML/);
  assert.match(errorOf(view('scope:\n  include: ["{a,b}/**"]'))!.message, /scope\.include\.0: Unsupported glob/);
  assert.equal(errorOf(view('scope:\n  include: ["{a,b}/**"]'))!.line, 6);
  assert.match(errorOf(view(`use: [${Array(9).fill('a').join(', ')}]`).replace('use: [langgraph]\n', ''))!.message, /^use:/);
  const rule = (body: string) => view(`rules:\n  - id: r\n    language: python\n    query: "(x) @x"\n${body}`);
  assert.deepEqual(errorOf(rule('    emit: { node: { id: "@x" }, edge: { from: a, to: b } }')), { line: 9, message: 'rules.0.emit: emit needs exactly one of node, edge, field or group' });
  assert.deepEqual(errorOf(rule('    emit: { node: { id: "@x", colour: red } }')), { line: 9, message: 'rules.0.emit.node: Unrecognized key: "colour"' });
  assert.match(errorOf(rule('    emit: { node: { id: "@x" } }').replace('python', 'cobolt'))!.message, /rules\.0\.language: Unknown language "cobolt"/);
  assert.match(errorOf(rule('    emit: { node: { id: "@x" } }').replace('(x) @x', 'x'.repeat(9000)))!.message, /larger than 8 KiB/);
  assert.match(errorOf(view(`rules:\n${'  - { id: r, language: python, query: x, emit: { group: { id: a } } }\n'.repeat(2)}`))!.message, /Duplicate rule id "r"/);
  assert.match(errorOf(view('graph: { start: [{ symbol: a }], follow: [calls], depth: 7 }'))!.message, /^graph\.depth/);
  // Alias bombs are refused.
  const bomb = ['a: &a [x, x, x, x, x, x, x, x, x, x]', ...Array.from({ length: 8 }, (_, i) => `${'bcdefghi'[i]}: &${'bcdefghi'[i]} [${Array(10).fill(i ? '*' + 'bcdefghi'[i - 1] : '*a').join(', ')}]`)].join('\n');
  assert.match(errorOf(bomb)!.message, /^Invalid YAML/);
});

test('view layout: positions per node id, bounded and finite', () => {
  assert.equal(parseViewYaml(view(), F).layout, null);
  assert.deepEqual(parseViewYaml(view('layout: {}'), F).layout, { positions: {} });
  assert.deepEqual(parseViewYaml(view('layout:\n  positions:\n    users: { x: 1.5, y: -2 }\n    "a.b": { x: 0, y: 0 }'), F).layout,
    { positions: { users: { x: 1.5, y: -2 }, 'a.b': { x: 0, y: 0 } } });
  assert.deepEqual(errorOf(view('layout:\n  zoom: 2')), { line: 6, message: 'layout: Unrecognized key: "zoom"' });
  assert.match(errorOf(view('layout: { positions: { a: { x: 1, y: 2, z: 3 } } }'))!.message, /^layout\.positions\.a: Unrecognized key: "z"/);
  assert.match(errorOf(view('layout: { positions: { a: { x: .inf, y: 0 } } }'))!.message, /^layout\.positions\.a\.x/);
  assert.match(errorOf(view('layout: { positions: { a: { x: "1", y: 0 } } }'))!.message, /^layout\.positions\.a\.x/);
  assert.match(errorOf(view(`layout: { positions: { ${'k'.repeat(301)}: { x: 0, y: 0 } } }`))!.message, /^layout\.positions/);
  const many = Array.from({ length: 1001 }, (_, i) => `n${i}: { x: 0, y: 0 }`).join(', ');
  assert.match(errorOf(view(`layout: { positions: { ${many} } }`))!.message, /At most 1000 positions/);
});

test('rule files must be named after their file and cannot use other sets', () => {
  const text = 'version: 1\nname: orm\nrules:\n  - { id: r, language: python, query: "(x) @x", emit: { group: { id: "@x" } } }\n';
  const r = parseRuleFileYaml(text, '.stingray/rules/orm.yaml', 'orm', 'rules/orm');
  assert.deepEqual(r.rules.map(x => [x.source, x.file, x.line, x.queryLine]), [['rules/orm', '.stingray/rules/orm.yaml', 4, 4]]);
  assert.throws(() => parseRuleFileYaml(text, 'f.yaml', 'other', 'rules/other'), (e: YamlError) => e.line === 2 && /must equal the file name "other"/.test(e.message));
  assert.throws(() => parseRuleFileYaml(text + 'use: [x]\n', 'f.yaml', 'orm', 'rules/orm'), (e: YamlError) => e.line === 5 && /use/.test(e.message));
});

test('templates render captures, @@ and skip on missing captures', () => {
  assert.deepEqual(templateCaptures('@a-@b_1 @@c'), ['a', 'b_1']);
  const values = new Map([['a', 'x'], ['b_1', 'y']]);
  assert.equal(renderTemplate('@a-@b_1 @@c', values), 'x-y @c');
  assert.equal(renderTemplate('plain', values), 'plain');
  assert.equal(renderTemplate('@a @missing', values), null);
});

test('flowchart views: parsed with depth default 1; kind and section go together; no use/rules/graph', () => {
  const fc = (extra = '', kind = 'flowchart') => `version: 1\nname: V\nkind: ${kind}\nflowchart:\n  start: { symbol: login, file: app/auth.py }\n${extra}`;
  const v = parseViewYaml(fc('  include: ["app/**"]'), F);
  assert.equal(v.kind, 'flowchart');
  assert.deepEqual(v.flowchart, { start: { symbol: 'login', file: 'app/auth.py' }, depth: 1, include: ['app/**'] });
  assert.equal(parseViewYaml(fc('  depth: 4'), F).flowchart!.depth, 4);
  assert.equal(parseViewYaml(view(), F).flowchart, null);
  assert.deepEqual(errorOf(fc('  depth: 5')), { line: 6, message: 'flowchart.depth: Too big: expected number to be <=4' });
  assert.match(errorOf(fc('  depth: 1.5'))!.message, /^flowchart\.depth:/);
  assert.deepEqual(errorOf(fc('  colour: red')), { line: 6, message: 'flowchart: Unrecognized key: "colour"' });
  assert.match(errorOf(fc('  include: ["{a,b}"]'))!.message, /flowchart\.include\.0: Unsupported glob/);
  assert.match(errorOf('version: 1\nname: V\nkind: flowchart\nflowchart:\n  start: {}\n')!.message, /^flowchart\.start\.symbol:/);
  assert.deepEqual(errorOf('version: 1\nname: V\nkind: flowchart\nuse: [x]'), { line: 3, message: 'kind: kind: flowchart needs a flowchart: section' });
  assert.deepEqual(errorOf(fc('', 'flow')), { line: 5, message: 'flowchart: flowchart: needs kind: flowchart' });
  assert.deepEqual(errorOf(fc('use: [langgraph]')), { line: 6, message: 'use: use: cannot be combined with flowchart:' });
  assert.match(errorOf(fc('graph: { start: [{ symbol: a }], follow: [calls] }'))!.message, /^graph: graph: cannot be combined/);
  assert.match(errorOf(fc('rules: []'))!.message, /^rules: rules: cannot be combined/);
});
