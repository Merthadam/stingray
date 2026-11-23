import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { evaluate } from '../../electron/core/views/rules/engine';
import { createFileProvider } from '../../electron/adapters/driven/fs/files';
import { codegraphGrammarDir } from '../../electron/adapters/driven/tree-sitter/grammars';
import { parseRuleFileYaml } from '../../electron/core/views/rules/schema';
import { BUILTIN_SETS } from '../../electron/core/views/sets';

async function run(fixture: string, exclude: string[] = []) {
  const { rules } = parseRuleFileYaml(BUILTIN_SETS.langgraph.yaml, null, 'langgraph', 'builtin/langgraph');
  const out = await evaluate({
    view: { id: 'flow', kind: 'flow', scope: { include: ['**/*.py'], exclude }, rules, graph: null, flowchart: null, builtins: [], include: [], exclude: [] },
    files: createFileProvider(path.join(import.meta.dirname, '../fixtures/views', fixture)),
    graph: null, graphStatus: { state: 'unavailable', message: null }, grammarDir: codegraphGrammarDir(),
  });
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.diagnostics.rules.flatMap(r => r.errors), []);
  assert.deepEqual(out.diagnostics.unresolved, []);
  assert.equal(out.truncated, false);
  const label = (id: string) => out.nodes.find(n => n.id === id)!.label;
  const branches = (source: string) => out.edges.filter(e => e.kind === 'branch' && label(e.from) === source)
    .map(e => [label(e.to), e.label]);
  return { out, branches };
}

test('langgraph travela: lambda conditions follow evaluation order, not dictionary order', async () => {
  const { out, branches } = await run('langgraph-travela');
  assert.deepEqual(branches('START'), [
    ['travel_specialist', '1. topic ∈ {stays, flights}'],
    ['canvas_editing', '2. canvas_edit'],
    ['canvas_generation', '3. canvas_action'],
    ['chat', 'else'],
  ]);
  assert.equal(out.edges.filter(e => e.kind === 'next').length, 6); // 4 in the Plan graph, 2 in the specialist subflow
  assert.ok(out.edges.filter(e => e.kind === 'branch').every(e => e.style === 'dashed' && !e.certain && e.source?.line === 42));
});

test('langgraph existing fixture: missing imported module keeps path-map labels', async () => {
  const { branches } = await run('langgraph');
  assert.deepEqual(branches('START'), [['plan', '1. needs_plan'], ['chat', 'else']]);
  assert.deepEqual(branches('plan'), [['summarize', 'done'], ['plan', 'retry']]);
});

test('langgraph named routers: local if/elif/else, imported aliases and module attributes', async () => {
  const { branches } = await run('langgraph-routers');
  assert.deepEqual(branches('local'), [['a', '1. topic ∉ [stays, flights]'], ['b', '2. not canvas_edit and canvas_action'], ['c', 'else']]);
  assert.deepEqual(branches('imported'), [['a', '1. retry'], ['b', 'else']]);
  assert.deepEqual(branches('module'), branches('imported'));
  assert.deepEqual(branches('START'), [['local', '1. x or y'], ['imported', 'else']]);
});

test('langgraph named routers: direct literal returns, unmapped returns, shared targets and dynamic fallback', async () => {
  const { branches } = await run('langgraph-routers');
  assert.deepEqual(branches('direct'), [['a', '1. x or y'], ['b', 'else']]);
  assert.deepEqual(branches('unmapped'), branches('direct'));
  assert.deepEqual(branches('shared'), [['a', '1. first or 2. second'], ['b', 'else']]);
  assert.deepEqual(branches('dynamic'), [['a', 'first'], ['b', 'last']]);
  const long = branches('long')[0][1]!;
  assert.equal(long.length, 60);
  assert.match(long, /^1\. a_very_long_condition.*…$/);
});

test('langgraph imports respect view scope and keep original edges when excluded', async () => {
  const { branches } = await run('langgraph-routers', ['**/nodes.py']);
  assert.deepEqual(branches('imported'), [['a', 'retry'], ['b', 'done']]);
  assert.deepEqual(branches('module'), branches('imported'));
});
