import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli, worktreeRoot, type CliDeps, drawnFingerprint as drawn, parseViewYaml } from '../../electron/app/wiring/views';
import type { ExplainEntry } from '../../electron/core/views/rules/schema';
import type { EvaluateInput, EvaluateOutput, ResolvedView } from '../../electron/core/views/rules/types';
import type { DbSchemaResult } from '../../shared/contracts/db-schema';
import type { DiagramNode, RuleDiagnostic, ViewResult, ViewSummary } from '../../shared/contracts/views';

const summary: ViewSummary = { id: 'flow', name: 'Agent flow', kind: 'flow', description: '', builtin: false, file: '.stingray/views/flow.yaml', error: null };
const view: ResolvedView = { id: 'flow', kind: 'flow', scope: { include: ['**/*'], exclude: [] }, graph: null, flowchart: null,
  rules: [{ source: 'view', file: '.stingray/views/flow.yaml', line: 3, queryLine: 4, rule: { id: 'step', language: 'python', query: '(call) @c', emit: { node: { id: '@c' } } } }], builtins: [], include: [], exclude: [] };
const node = (id: string, extra: Partial<DiagramNode> = {}): DiagramNode =>
  ({ id, label: id, kind: 'step', subtitle: null, group: null, fields: [], source: null, symbol: null, role: null, order: null, detail: null, ...extra });
const rule = (extra: Partial<RuleDiagnostic> = {}): RuleDiagnostic =>
  ({ rule: 'view#step', language: 'python', filesScanned: 2, matches: 3, emitted: 3, skipped: 0, errors: [], warnings: [], ms: 1, ...extra });
const output = (extra: Partial<EvaluateOutput> = {}): EvaluateOutput => ({
  groups: [], nodes: [node('START', { role: 'start' }), node('plan')], truncated: false, warnings: [], stats: {},
  edges: [{ id: 'e', from: 'START', to: 'plan', fromField: null, toField: null, kind: 'next', style: 'solid', certain: true, label: null, source: null }],
  diagnostics: { rules: [rule()], graph: null, unresolved: [], limits: { filesScanned: 2, matches: 3, truncated: false }, ms: 1 }, ...extra,
});

async function repo() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stingray views-cli ')));
  execFileSync('git', ['init', '-q'], { cwd: root });
  await mkdir(path.join(root, '.stingray/views'), { recursive: true });
  await writeFile(path.join(root, '.stingray/views/flow.yaml'), 'version: 1\n');
  return root;
}

function harness(root: string, overrides: Partial<CliDeps> = {}) {
  const out: string[] = [], err: string[] = [], calls: { load: string[][]; evaluate: EvaluateInput[]; closed: number } = { load: [], evaluate: [], closed: 0 };
  const deps: CliDeps = {
    cwd: root, out: t => out.push(t), err: t => err.push(t),
    loadViewPath: async (r, rel) => { calls.load.push([r, rel]); return { summary, view, ruleFiles: [], errors: [] }; },
    listViews: async () => [{ summary }, { summary: { ...summary, id: 'bad', file: '.stingray/views/bad.yaml', error: 'kind: invalid' } }],
    evaluate: async input => { calls.evaluate.push(input); return output(); },
    createFileProvider: () => ({ list: async () => ({ files: [], truncated: false }), read: async () => null }),
    openGraph: async () => ({ api: null, status: { state: 'unavailable', message: 'no .codegraph index' }, close: () => { calls.closed++; } }),
    grammarDir: () => '/grammars',
    dbSchema: async () => { throw new Error('not used'); },
    sqlSchema: async () => { throw new Error('not used'); },
    skillFile: path.resolve('agents/skills/stingray-views/SKILL.md'), version: '9.9.9', ...overrides,
  };
  return { deps, out, err, calls, run: (...argv: string[]) => runCli(argv, deps) };
}

test('views-cli: unknown commands and bad arguments print usage and exit 2', async () => {
  const root = await repo();
  try {
    for (const argv of [[], ['nope'], ['check'], ['check', 'a', 'b'], ['check', '--strict'], ['list', 'x'], ['sets', 'x'], ['help', 'x']]) {
      const h = harness(root);
      assert.equal(await h.run(...argv), 2, argv.join(' '));
      assert.match(h.err.join('\n'), /^Usage:\n {2}stingray-views check <file.yaml> \[--json\]/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli: --version, help prints SKILL.md, sets lists the TypeScript extractors', async () => {
  const h = harness(process.cwd());
  assert.equal(await h.run('--version'), 0);
  assert.equal(await h.run('help'), 0);
  assert.equal(await h.run('sets'), 0);
  assert.equal(h.out[0], 'stingray-views 9.9.9');
  assert.equal(h.out[1], await readFile('agents/skills/stingray-views/SKILL.md', 'utf8'));
  assert.match(h.out[1], /^---\nname: stingray-views\ndescription: /);
  assert.match(h.out[2], /^sqlalchemy {2}/);
  assert.match(h.out[3], /^sql {2}SQL DDL/);
});

test('views-cli check: evaluates with the worktree root, prints diagnostics and the diagram, exits 0', async () => {
  const root = await repo();
  try {
    await mkdir(path.join(root, 'sub'));
    const h = harness(path.join(root, 'sub'));
    assert.equal(await h.run('check', '../.stingray/views/flow.yaml'), 0);
    assert.deepEqual(h.calls.load, [[root, '.stingray/views/flow.yaml']]);
    assert.equal(h.calls.evaluate[0].grammarDir, '/grammars');
    assert.equal(h.calls.evaluate[0].graph, null);
    assert.deepEqual(h.calls.evaluate[0].graphStatus, { state: 'unavailable', message: 'no .codegraph index' });
    assert.equal(h.calls.closed, 1);
    const text = h.out.join('\n');
    assert.match(text, /^Agent flow \(flow\) — \.stingray\/views\/flow\.yaml\ncode graph: unavailable — no \.codegraph index\nrules:\n {2}view#step \[python\] {2}files 2 {2}matches 3 {2}emitted 3 {2}skipped 0/);
    assert.match(text, /flow: 2 nodes, 1 edges\n {2}\[start\] START \(step\)\n {2}plan \(step\)\nedges:\n {2}START -> plan/);
    assert.match(text, /OK: no errors/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check: view errors print file:line and exit 1 without evaluating', async () => {
  const root = await repo();
  try {
    const h = harness(root, { loadViewPath: async () => ({ summary: { ...summary, error: 'bad' }, view: null, ruleFiles: [],
      errors: [{ file: '.stingray/views/flow.yaml', line: 3, message: 'kind: Invalid option' }, { file: null, line: null, message: 'use: unknown set x' }] }) });
    assert.equal(await h.run('check', '.stingray/views/flow.yaml'), 1);
    assert.deepEqual(h.out, ['.stingray/views/flow.yaml:3: kind: Invalid option', 'use: unknown set x']);
    assert.equal(h.calls.evaluate.length, 0);
    const j = harness(root, { loadViewPath: async () => ({ summary: { ...summary, error: 'kind: Invalid option' }, view: null, ruleFiles: [], errors: [] }) });
    assert.equal(await j.run('check', '.stingray/views/flow.yaml', '--json'), 1);
    assert.deepEqual(JSON.parse(j.out[0]).errors, [{ file: '.stingray/views/flow.yaml', line: null, message: 'kind: Invalid option' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check: rule errors and graph-step errors with a graph fail, unresolved links are listed; --json prints {summary, result}', async () => {
  const root = await repo();
  try {
    const failing = output({ diagnostics: { rules: [rule({ errors: [{ file: '.stingray/views/flow.yaml', line: 7, message: 'Invalid node type foo' }],
      warnings: [{ file: null, line: null, message: '0 matches' }] })], graph: null,
      unresolved: [{ rule: 'view#edge', value: 'missing', file: 'a.py', line: 4 }], limits: { filesScanned: 2, matches: 3, truncated: false }, ms: 1 } });
    const h = harness(root, { evaluate: async () => failing });
    assert.equal(await h.run('check', '.stingray/views/flow.yaml'), 1);
    const text = h.out.join('\n');
    assert.match(text, /\n {4}error: \.stingray\/views\/flow\.yaml:7: Invalid node type foo\n {4}warning: 0 matches\n/);
    assert.match(text, /unresolved links.*\n {2}view#edge: "missing" at a\.py:4/);
    assert.match(text, /FAILED/);

    const graphError = output({ diagnostics: { ...output().diagnostics, graph: { depth: 3, started: 0, reached: 0, helpers: 0, truncated: false, error: 'start symbol not found: x' } } });
    const fakeGraph = { findSymbols: () => [], symbols: () => new Map(), outgoing: () => [], incoming: () => [], fileSymbols: () => [], layers: () => null, rollup: () => [] };
    const g = harness(root, { evaluate: async () => graphError, openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }) });
    assert.equal(await g.run('check', '.stingray/views/flow.yaml'), 1);
    assert.match(g.out.join('\n'), /graph step: started 0 {2}reached 0 {2}helpers 0\n {2}error: start symbol not found: x/);
    // Without a graph the skipped step is the environment, not the view.
    const n = harness(root, { evaluate: async () => graphError });
    assert.equal(await n.run('check', '.stingray/views/flow.yaml'), 0);
    assert.match(n.out.join('\n'), /\n {2}skipped: start symbol not found: x/);

    const j = harness(root, { evaluate: async () => failing });
    assert.equal(await j.run('check', '--json', '.stingray/views/flow.yaml'), 1);
    const parsed = JSON.parse(j.out.join('\n')) as { summary: ViewSummary; result: ViewResult };
    assert.equal(j.out.length, 1);
    assert.deepEqual(parsed.summary, summary);
    assert.equal(parsed.result.nodes.length, 2);
    assert.equal(parsed.result.diagnostics!.rules[0].errors[0].line, 7);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check --restamp: writes fingerprint maps of resolved explain: entries, replacing old strings, keeping comments and formatting', async () => {
  const root = await repo();
  try {
    const file = path.join(root, '.stingray/views/flow.yaml');
    const yaml = [
      '# Agent flow', 'version: 1', 'name: Agent flow', 'kind: flow', '',
      'explain:', '  # the planning step', '  plan:', '    text: "Plans the trip, step by step" # keep me',
      '    fingerprint: "000000000000"', '  START: { text: Entry }', '  ghost:', '    text: Nothing', '',
    ].join('\n');
    await writeFile(file, yaml);
    const explain = [{ key: 'plan', text: 'Plans the trip, step by step', fingerprint: '000000000000', line: 8 },
      { key: 'START', text: 'Entry', fingerprint: null, line: 11 }, { key: 'ghost', text: 'Nothing', fingerprint: null, line: 12 }];
    const fakeGraph = { findSymbols: () => [], symbols: () => new Map(), outgoing: () => [], incoming: () => [], fileSymbols: () => [], layers: () => null, rollup: () => [] };
    const deps: Partial<CliDeps> = { loadViewPath: async () => ({ summary, view, ruleFiles: [], errors: [], explain }),
      openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }) };

    const check = harness(root, deps);
    assert.equal(await check.run('check', '.stingray/views/flow.yaml'), 0);
    const text = check.out.join('\n');
    assert.match(text, /warnings:\n {2}\.stingray\/views\/flow\.yaml:8: explanation for "plan" uses the old fingerprint format \(own body only\) — review it and run stingray-views check --restamp\n {2}\.stingray\/views\/flow\.yaml:11: explanation for "START" has no fingerprint/);
    assert.match(text, /unresolved links.*\n {2}explain: "ghost" at \.stingray\/views\/flow\.yaml:12/);
    assert.match(text, /\[start\] START \(step\) — Entry\n {2}plan \(step\) — Plans the trip, step by step \(old fingerprint\)/);
    assert.equal(await readFile(file, 'utf8'), yaml, 'check alone never writes');

    const h = harness(root, deps);
    assert.equal(await h.run('check', '.stingray/views/flow.yaml', '--restamp'), 0);
    const plan = drawn(node('plan')), start = drawn(node('START', { role: 'start' }));
    assert.deepEqual(h.out.slice(h.out.lastIndexOf('') + 1), [
      'restamp: skipped "ghost" (matches nothing in the view)',
      'restamp: stamped "plan" (1 piece) (.stingray/views/flow.yaml:8)',
      'restamp: stamped "START" (1 piece) (.stingray/views/flow.yaml:11)',
      'restamp: wrote 2 fingerprints to .stingray/views/flow.yaml']);
    assert.equal(await readFile(file, 'utf8'), yaml.replace('fingerprint: "000000000000"', `fingerprint:\n      drawn:plan: ${plan}`)
      .replace('{ text: Entry }', `{ text: Entry, fingerprint: { drawn:START: ${start} } }`));

    const again = harness(root, { ...deps, loadViewPath: async () => ({ summary, view, ruleFiles: [], errors: [],
      explain: [{ ...explain[0], fingerprint: { 'drawn:plan': plan } }, { ...explain[1], fingerprint: { 'drawn:START': start } }] as ExplainEntry[] }) });
    assert.equal(await again.run('check', '.stingray/views/flow.yaml', '--restamp'), 0);
    assert.equal(again.out.at(-1), 'restamp: all fingerprints are current.');
    assert.doesNotMatch(again.out.join('\n'), /warnings:/);

    const noGraph = harness(root, { loadViewPath: deps.loadViewPath });
    assert.equal(await noGraph.run('check', '.stingray/views/flow.yaml', '--restamp'), 1);
    assert.match(noGraph.err[0], /^restamp: needs the code graph/);
    assert.equal(await noGraph.run('check', '.stingray/views/flow.yaml', '--restamp', '--json'), 2);
    assert.match(noGraph.err[1], /--restamp cannot be combined with --json/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check --restamp: piece keys of callees and tables round-trip, a skipped callee is mentioned; a callee edit turns it stale', async () => {
  const root = await repo();
  try {
    const file = path.join(root, '.stingray/views/flow.yaml');
    await writeFile(file, ['version: 1', 'name: Agent flow', 'kind: flow', 'use: [langgraph]', 'explain:', '  get: { text: Reads }', '  users: { text: Rows }', ''].join('\n'));
    await mkdir(path.join(root, 'services'));
    await writeFile(path.join(root, 'services/x.py'), 'def get():\n    return helper()\n');
    await writeFile(path.join(root, 'lib.py'), 'def helper():\n    return 1\n');
    const sym = (name: string, file: string, qualifiedName = name) => ({ id: `py:${name}`, name, kind: 'function', file, line: 1, endLine: 2, qualifiedName });
    const callees = [sym('helper', 'lib.py'), sym('lost', 'gone.py')];
    const fakeGraph = { findSymbols: () => [], incoming: () => [], fileSymbols: () => [], layers: () => null, rollup: () => [],
      outgoing: () => callees.map(c => ({ from: 'py:get', to: c.id, kind: 'calls', line: 1, certain: false })),
      symbols: (ids: string[]) => new Map(callees.filter(c => ids.includes(c.id)).map(c => [c.id, c])) };
    const run = async (explain: ExplainEntry[], ...flags: string[]) => {
      const h = harness(root, {
        loadViewPath: async () => ({ summary, view, ruleFiles: [], errors: [], explain }),
        evaluate: async () => output({ nodes: [node('START', { role: 'start' }), node('call@1', { symbol: sym('get', 'services/x.py', 'Store::get') }),
          node('sql:db.sql#users', { kind: 'table', label: 'users' })] }),
        createFileProvider: () => ({ list: async () => ({ files: [], truncated: false }), read: async f => readFile(path.join(root, f), 'utf8').catch(() => null) }),
        openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }),
      });
      return { code: await h.run('check', '.stingray/views/flow.yaml', ...flags), out: h.out, err: h.err };
    };
    const load = async () => parseViewYaml(await readFile(file, 'utf8'), '.stingray/views/flow.yaml').explain;

    const stamp = await run(await load(), '--restamp');
    assert.equal(stamp.code, 0);
    assert.deepEqual(stamp.out.slice(stamp.out.lastIndexOf('') + 1), [
      'restamp: stamped "get" (2 pieces) (.stingray/views/flow.yaml:6)',
      'restamp: "get": could not fingerprint callee gone.py::lost (left out)',
      'restamp: stamped "users" (1 piece) (.stingray/views/flow.yaml:7)',
      'restamp: wrote 2 fingerprints to .stingray/views/flow.yaml']);
    const stamped = await load();
    assert.deepEqual(stamped.map(e => Object.keys(e.fingerprint as object)), [['lib.py::helper', 'services/x.py::Store::get'], ['drawn:sql:db.sql#users']]);

    const clean = await run(stamped, '--strict');
    assert.deepEqual([clean.code, clean.err], [0, []]);
    assert.doesNotMatch(clean.out.join('\n'), /warnings:/);
    await writeFile(path.join(root, 'lib.py'), 'def helper():\n    return 2\n');
    const stale = await run(stamped, '--strict');
    assert.equal(stale.code, 1);
    assert.match(stale.out.join('\n'), /explanation for "get" may be outdated: helper changed — review it/);
    assert.deepEqual(stale.err, ['strict: 1 explanation needs review']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check --strict: exit 1 on stale, unstamped and legacy explanations, 0 when current; stderr keeps --json valid; not with --restamp', async () => {
  const root = await repo();
  try {
    const current = { 'drawn:plan': drawn(node('plan')) };
    const fakeGraph = { findSymbols: () => [], symbols: () => new Map(), outgoing: () => [], incoming: () => [], fileSymbols: () => [], layers: () => null, rollup: () => [] };
    const run = async (fingerprint: ExplainEntry['fingerprint'], ...flags: string[]) => {
      const h = harness(root, { loadViewPath: async () => ({ summary, view, ruleFiles: [], errors: [], explain: [{ key: 'plan', text: 'Plans', fingerprint, line: 5 }] }),
        openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }) });
      return { code: await h.run('check', '.stingray/views/flow.yaml', ...flags), out: h.out, err: h.err };
    };
    for (const [name, fingerprint, code] of [['current', current, 0], ['stale', { 'drawn:plan': '000000000000' }, 1], ['unstamped', null, 1], ['legacy', '000000000000', 1]] as const) {
      const text = await run(fingerprint, '--strict');
      assert.deepEqual([text.code, text.err], [code, code ? ['strict: 1 explanation needs review'] : []], name);
      assert.equal((await run(fingerprint)).code, 0, `${name} without --strict`);
      const json = await run(fingerprint, '--strict', '--json');
      assert.equal(json.code, code, `${name} --json`);
      assert.equal(JSON.parse(json.out.join('\n')).result.diagnostics.explain[0].status, name === 'current' ? 'view' : name);
      assert.deepEqual(json.err, text.err);
    }
    const both = await run(null, '--strict', '--restamp');
    assert.deepEqual([both.code, both.err], [2, ['--restamp cannot be combined with --strict']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check --restamp: writes nothing when check fails; skips aliased entries and files the index has not caught up with', async () => {
  const root = await repo();
  try {
    const file = path.join(root, '.stingray/views/flow.yaml');
    const yaml = ['version: 1', 'name: Agent flow', 'kind: flow', 'explain:', '  plan: &p { text: Plans }', '  START: *p',
      '  verify: { text: Accept }', '  check: { text: Check }', ''].join('\n');
    await writeFile(file, yaml);
    await writeFile(path.join(root, 'app.py'), 'def verify():\n    pass\n');
    await writeFile(path.join(root, 'lib.py'), 'def check():\n    pass\n');
    const appMtime = (await stat(path.join(root, 'app.py'))).mtimeMs;
    const explain = [{ key: 'plan', text: 'Plans', fingerprint: null, line: 5 }, { key: 'START', text: 'Plans', fingerprint: null, line: 6 },
      { key: 'verify', text: 'Accept', fingerprint: null, line: 7 }, { key: 'check', text: 'Check', fingerprint: null, line: 8 }];
    const symbolNode = (name: string, f: string) => node(name, { symbol: { id: `py:${name}`, name, kind: 'function', file: f, line: 1, endLine: 2 } });
    const fakeGraph = { findSymbols: () => [], symbols: () => new Map(), outgoing: () => [], incoming: () => [], fileSymbols: () => [], layers: () => null, rollup: () => [] };
    const deps = (errors: boolean): Partial<CliDeps> => ({
      loadViewPath: async () => ({ summary, view, ruleFiles: [], errors: [], explain }),
      evaluate: async () => output({ nodes: [node('START', { role: 'start' }), node('plan'), symbolNode('verify', 'app.py'), symbolNode('check', 'lib.py')],
        diagnostics: { rules: [rule(errors ? { errors: [{ file: 'x.yaml', line: 1, message: 'bad query' }] } : {})], graph: null, unresolved: [], limits: { filesScanned: 2, matches: 3, truncated: false }, ms: 1 } }),
      createFileProvider: () => ({ list: async () => ({ files: [], truncated: false }), read: async f => readFile(path.join(root, f), 'utf8') }),
      openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null }, indexedMtime: f => (f === 'app.py' ? appMtime : 1) }),
    });

    const failed = harness(root, deps(true));
    assert.equal(await failed.run('check', '.stingray/views/flow.yaml', '--restamp'), 1);
    assert.deepEqual(failed.err, ['restamp: fix the errors first; nothing was written.']);
    assert.equal(await readFile(file, 'utf8'), yaml);

    const h = harness(root, deps(false));
    assert.equal(await h.run('check', '.stingray/views/flow.yaml', '--restamp'), 0);
    const tail = h.out.slice(h.out.lastIndexOf('') + 1);
    assert.equal(tail[0], 'restamp: skipped "START" (entry is not a plain mapping; stamp it by hand)');
    assert.equal(tail[1], 'restamp: skipped "check" (lib.py changed since the code graph indexed it; restamp after Stingray re-indexes)');
    assert.equal(tail[2], 'restamp: stamped "plan" (1 piece) (.stingray/views/flow.yaml:5)');
    assert.equal(tail[3], 'restamp: stamped "verify" (1 piece) (.stingray/views/flow.yaml:7)');
    assert.equal(tail[4], 'restamp: wrote 2 fingerprints to .stingray/views/flow.yaml');
    const written = await readFile(file, 'utf8');
    assert.match(written, /  START: \*p\n/);
    assert.doesNotMatch(written, /check: \{ text: Check, fingerprint/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check --restamp: skips an entry when only a callee\'s file changed since indexing (callee past the end of its file)', async () => {
  const root = await repo();
  try {
    const file = path.join(root, '.stingray/views/flow.yaml'), yaml = ['version: 1', 'name: Agent flow', 'kind: flow', 'explain:', '  verify: { text: Accept }', ''].join('\n');
    await writeFile(file, yaml);
    await writeFile(path.join(root, 'app.py'), 'def verify():\n    return helper()\n');
    await writeFile(path.join(root, 'lib.py'), 'x = 1\n'); // the index still has helper at lines 1-3
    const appMtime = (await stat(path.join(root, 'app.py'))).mtimeMs;
    const helper = { id: 'py:helper', name: 'helper', kind: 'function', file: 'lib.py', line: 1, endLine: 3 };
    const fakeGraph = { findSymbols: () => [], incoming: () => [], fileSymbols: () => [], layers: () => null, rollup: () => [],
      outgoing: () => [{ from: 'py:verify', to: helper.id, kind: 'calls', line: 2, certain: true }], symbols: () => new Map([[helper.id, helper]]) };
    const h = harness(root, {
      loadViewPath: async () => ({ summary, view, ruleFiles: [], errors: [], explain: [{ key: 'verify', text: 'Accept', fingerprint: null, line: 5 }] }),
      evaluate: async () => output({ nodes: [node('START', { role: 'start' }), node('verify', { symbol: { id: 'py:verify', name: 'verify', kind: 'function', file: 'app.py', line: 1, endLine: 2 } })] }),
      createFileProvider: () => ({ list: async () => ({ files: [], truncated: false }), read: async f => readFile(path.join(root, f), 'utf8') }),
      openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null }, indexedMtime: f => (f === 'app.py' ? appMtime : 1) }),
    });
    assert.equal(await h.run('check', '.stingray/views/flow.yaml', '--restamp'), 0);
    assert.deepEqual(h.out.slice(h.out.lastIndexOf('') + 1), [
      'restamp: skipped "verify" (lib.py changed since the code graph indexed it; restamp after Stingray re-indexes)', 'restamp: all fingerprints are current.']);
    assert.equal(await readFile(file, 'utf8'), yaml);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check: the sqlalchemy builtin is merged like ViewService (scope, table keys)', async () => {
  const root = await repo();
  try {
    const table = (name: string, model: string, file: string) => ({ name, schema: null, fullName: name, model, file, line: 1, columns: [], relationships: [] });
    const db: DbSchemaResult = { workspaceId: 'cli', scannedAt: 1, filesScanned: 2, filesParsed: 2, truncated: true, warnings: [],
      groups: [{ id: 'models', name: 'Base', file: null, line: null, tables: [table('users', 'User', 'app/user.py'), table('logs', 'Log', 'other/log.py')] }] };
    const engine = output({ nodes: [node('START', { role: 'start' }), node('User', { detail: 'from a rule' })],
      edges: [{ id: 'e', from: 'START', to: 'User', fromField: null, toField: null, kind: 'next', style: 'solid', certain: true, label: null, source: null }] });
    const h = harness(root, { loadViewPath: async () => ({ summary, view: { ...view, scope: { include: ['app/**'], exclude: [] }, builtins: ['sqlalchemy'] }, ruleFiles: [], errors: [] }),
      evaluate: async () => engine, dbSchema: async () => db });
    assert.equal(await h.run('check', '.stingray/views/flow.yaml', '--json'), 0);
    const { result } = JSON.parse(h.out[0]) as { result: ViewResult };
    assert.deepEqual(result.nodes.map(n => [n.id, n.detail]), [['models#users', 'from a rule'], ['START', null]]);
    assert.deepEqual(result.edges.map(e => [e.from, e.to]), [['START', 'models#users']]);
    assert.deepEqual(result.groups.map(g => g.id), ['models']);
    assert.equal(result.truncated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check: missing files and files outside the worktree exit 1', async () => {
  const root = await repo(), outside = await mkdtemp(path.join(os.tmpdir(), 'stingray-outside-'));
  try {
    const h = harness(root);
    assert.equal(await h.run('check', 'nope.yaml'), 1);
    assert.match(h.err[0], /^File not found: /);
    await writeFile(path.join(outside, 'v.yaml'), '');
    assert.equal(await h.run('check', path.join(outside, 'v.yaml')), 1);
    assert.match(h.err[1], /is not inside a git worktree/);
    assert.equal(h.calls.load.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('views-cli list prints views with errors and exits 1 when one is invalid', async () => {
  const root = await repo();
  try {
    const h = harness(root);
    assert.equal(await h.run('list'), 1);
    assert.deepEqual(h.out, ['flow  flow  Agent flow  .stingray/views/flow.yaml', 'bad  flow  Agent flow  .stingray/views/bad.yaml', '  error: kind: invalid']);
    const empty = harness(root, { listViews: async () => [] });
    assert.equal(await empty.run('list'), 0);
    assert.match(empty.out[0], /^No views yet/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worktreeRoot: git toplevel, else the nearest ancestor with .stingray, else null', async () => {
  const root = await repo(), plain = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stingray-plain-')));
  try {
    await mkdir(path.join(root, 'a/b'), { recursive: true });
    assert.equal(await worktreeRoot(path.join(root, 'a/b')), root);
    await mkdir(path.join(plain, '.stingray'));
    await mkdir(path.join(plain, 'x'));
    assert.equal(await worktreeRoot(path.join(plain, 'x')), plain);
    await rm(path.join(plain, '.stingray'), { recursive: true });
    assert.equal(await worktreeRoot(path.join(plain, 'x')), null);
  } finally { await rm(root, { recursive: true, force: true }); await rm(plain, { recursive: true, force: true }); }
});

test('build-electron bundles views-cli.cjs and copies the skills dir; the bundle runs as plain Node', async () => {
  execFileSync('node', ['scripts/build-electron.mjs'], { stdio: 'pipe' });
  assert.ok((await stat('dist-electron/views-cli.cjs')).isFile());
  assert.equal(await readFile('dist-electron/skills/stingray-views/SKILL.md', 'utf8'), await readFile('agents/skills/stingray-views/SKILL.md', 'utf8'));
  const run = (...args: string[]) => execFileSync('node', ['dist-electron/views-cli.cjs', ...args], { encoding: 'utf8' });
  assert.equal(run('--version'), 'stingray-views 0.1.0\n');
  assert.match(run('help'), /^---\nname: stingray-views\n/);
  // The bundle has one web-tree-sitter: the engine and the sqlalchemy extractor must share its init.
  const root = await repo();
  try {
    await writeFile(path.join(root, 'models.py'), 'from sqlalchemy.orm import DeclarativeBase\nclass Base(DeclarativeBase):\n    pass\nclass User(Base):\n    __tablename__ = "users"\n');
    await writeFile(path.join(root, 'schema.sql'), 'CREATE TABLE sql_users (id INT PRIMARY KEY);');
    await writeFile(path.join(root, '.stingray/views/flow.yaml'), 'version: 1\nname: Mixed\nkind: tables\nuse: [sqlalchemy, sql]\nrules:\n' +
      '  - { id: cls, language: python, query: "(class_definition name: (identifier) @n)", emit: { node: { id: "@n", detail: "class @n" } } }\n');
    const text = execFileSync('node', ['dist-electron/views-cli.cjs', 'check', path.join(root, '.stingray/views/flow.yaml')], { encoding: 'utf8' });
    assert.match(text, /^ {2}users — User · class User$/m);
    assert.match(text, /sql_users/);
    assert.match(text, /id: INT \[PK\]/);
    assert.match(text, /^ {2}Base · class Base$/m);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check --depth: overrides flowchart.depth, prints the flowchart diagnostic and tree; bad uses exit 2', async () => {
  const root = await repo();
  try {
    const flowchart: ResolvedView = { ...view, kind: 'flowchart', rules: [], flowchart: { start: { symbol: 'login' }, depth: 1 } };
    const loadViewPath: CliDeps['loadViewPath'] = async () => ({ summary: { ...summary, kind: 'flowchart' }, view: flowchart, ruleFiles: [], errors: [] });
    const fakeGraph = { findSymbols: () => [], symbols: () => new Map(), outgoing: () => [], incoming: () => [], fileSymbols: () => [], layers: () => null, rollup: () => [] };
    const result = (error: string | null) => output({
      nodes: [node('start', { kind: 'start', role: 'start', label: 'login', explanation: 'Sign a user in.' }), node('end', { kind: 'end', role: 'end', label: 'done' })],
      edges: [{ id: 'e', from: 'start', to: 'end', fromField: null, toField: null, kind: 'next', style: 'solid', certain: true, label: null, source: null }],
      diagnostics: { rules: [], graph: null, flowchart: { start: 'login (a.py:1)', depth: 2, functions: 1, nodes: 2, truncated: false, error }, unresolved: [], limits: { filesScanned: 0, matches: 0, truncated: false }, ms: 1 },
    });
    const h = harness(root, { loadViewPath, evaluate: async input => { h.calls.evaluate.push(input); return result(null); },
      openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }) });
    assert.equal(await h.run('check', '.stingray/views/flow.yaml', '--depth', '2'), 0);
    assert.equal(h.calls.evaluate[0].view.flowchart!.depth, 2);
    assert.equal(flowchart.flowchart!.depth, 1); // the loaded definition is not mutated
    const text = h.out.join('\n');
    assert.match(text, /flowchart: start login \(a\.py:1\) {2}depth 2 {2}functions 1 {2}nodes 2/);
    assert.match(text, /flowchart: 2 nodes, 1 edges\n {2}\(start\) login — Sign a user in\.\n {2}\(end\) done/);
    const json = harness(root, { loadViewPath, evaluate: async () => result(null), openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }) });
    assert.equal(await json.run('check', '.stingray/views/flow.yaml', '--json'), 0);
    assert.equal(JSON.parse(json.out.join('\n')).result.nodes[0].explanation, 'Sign a user in.');

    const failing = harness(root, { loadViewPath, evaluate: async () => result('start symbol not found: login'),
      openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }) });
    assert.equal(await failing.run('check', '.stingray/views/flow.yaml'), 1);
    assert.match(failing.out.join('\n'), /\n {2}error: start symbol not found: login/);

    for (const argv of [['--depth', '7'], ['--depth'], ['--depth', 'x']]) {
      const bad = harness(root, { loadViewPath });
      assert.equal(await bad.run('check', '.stingray/views/flow.yaml', ...argv), 2, argv.join(' '));
      assert.match(bad.err.join('\n'), /--depth needs a number from 0 to 6/);
    }
    const deep = harness(root, { loadViewPath });
    assert.equal(await deep.run('check', '.stingray/views/flow.yaml', '--depth', '5'), 2);
    assert.match(deep.err.join('\n'), /--depth of a flowchart view is 0 to 4/);
    const notFlowchart = harness(root);
    assert.equal(await notFlowchart.run('check', '.stingray/views/flow.yaml', '--depth', '1'), 2);
    assert.match(notFlowchart.err.join('\n'), /--depth only applies to kind: flowchart and kind: sequence views/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check --expand/--collapse: call paths reach the flowchart step; closed calls print the path to expand; bad uses exit 2', async () => {
  const root = await repo();
  try {
    const flowchart: ResolvedView = { ...view, kind: 'flowchart', rules: [], flowchart: { start: { symbol: 'login' }, depth: 0, expand: ['audit'] } };
    const loadViewPath: CliDeps['loadViewPath'] = async () => ({ summary: { ...summary, kind: 'flowchart' }, view: flowchart, ruleFiles: [], errors: [] });
    const fakeGraph = { findSymbols: () => [], symbols: () => new Map(), outgoing: () => [], incoming: () => [], fileSymbols: () => [], layers: () => null, rollup: () => [] };
    const result = output({
      nodes: [node('start', { kind: 'start', role: 'start', label: 'login' }),
        node('c', { kind: 'call', label: 'finish', explanation: 'Create the session.', callPath: 'finish', expandable: true }),
        node('q', { kind: 'call', label: 'query', explanation: 'Read a row.', callPath: 'finish>query' })],
      edges: [{ id: 'e1', from: 'start', to: 'c', fromField: null, toField: null, kind: 'next', style: 'solid', certain: true, label: null, source: null },
        { id: 'e2', from: 'c', to: 'q', fromField: null, toField: null, kind: 'next', style: 'solid', certain: true, label: null, source: null }],
      diagnostics: { rules: [], graph: null, flowchart: { start: 'login (a.py:1)', depth: 0, functions: 1, nodes: 3, truncated: false, error: null }, unresolved: [], limits: { filesScanned: 0, matches: 0, truncated: false }, ms: 1 },
    });
    const h = harness(root, { loadViewPath, evaluate: async input => { h.calls.evaluate.push(input); return result; },
      openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }) });
    assert.equal(await h.run('check', '.stingray/views/flow.yaml', '--expand', 'finish, login>audit#2', '--collapse', 'audit'), 0);
    const step = h.calls.evaluate[0].view.flowchart!;
    assert.deepEqual([step.expand, step.collapse], [['audit', 'finish', 'login>audit#2'], ['audit']]);
    const text = h.out.join('\n');
    assert.match(text, /\[call\] finish — Create the session\. \(expand: finish\)\n/);
    assert.match(text, /\[call\] query — Read a row\.\n/); // not expandable: no path to pass

    for (const argv of [['--expand'], ['--expand', ','], ['--collapse', '--json']]) {
      const bad = harness(root, { loadViewPath });
      assert.equal(await bad.run('check', '.stingray/views/flow.yaml', ...argv), 2, argv.join(' '));
      assert.match(bad.err.join('\n'), /needs comma-separated call paths/);
    }
    const notFlowchart = harness(root);
    assert.equal(await notFlowchart.run('check', '.stingray/views/flow.yaml', '--collapse', 'a'), 2);
    assert.match(notFlowchart.err.join('\n'), /--expand and --collapse only apply to kind: flowchart views/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check lists undescribed flowchart steps with the explain: key that names each', async () => {
  const root = await repo();
  try {
    const flowchart: ResolvedView = { ...view, kind: 'flowchart', rules: [], flowchart: { start: { symbol: 'login' }, depth: 0 } };
    const loadViewPath: CliDeps['loadViewPath'] = async () => ({ summary: { ...summary, kind: 'flowchart' }, view: flowchart, ruleFiles: [], errors: [] });
    const fakeGraph = { findSymbols: () => [], symbols: () => new Map(), outgoing: () => [], incoming: () => [], fileSymbols: () => [], layers: () => null, rollup: () => [] };
    const verify = { id: 'py:verify', name: 'verify', kind: 'function', file: 'a.py', line: 9 };
    const result = output({
      nodes: [node('start', { kind: 'start', role: 'start', label: 'login' }),
        node('d', { kind: 'decision', label: "result get 'ChallengeName' is…", detail: "result.get('ChallengeName')  ==  'MFA'", source: { file: 'a.py', line: 3 } }),
        node('c', { kind: 'call', label: 'verify', symbol: verify, detail: 'verify(user)', source: { file: 'a.py', line: 4 } }),
        node('ok', { kind: 'call', label: 'finish', detail: 'finish()', explanation: 'Create the session.' })],
      edges: [],
      diagnostics: { rules: [], graph: null, flowchart: { start: 'login (a.py:1)', depth: 0, functions: 1, nodes: 4, truncated: false, error: null }, unresolved: [], limits: { filesScanned: 0, matches: 0, truncated: false }, ms: 1 },
    });
    const h = harness(root, { loadViewPath, evaluate: async () => result, openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }) });
    assert.equal(await h.run('check', '.stingray/views/flow.yaml'), 0);
    const text = h.out.join('\n');
    assert.match(text, /undescribed steps \(2; describe unclear ones with explain: <key>: \{ text: \.\.\. \}\):/);
    assert.match(text, /\n {2}decision "result get 'ChallengeName' is…" L3 {2}key: 'result\.get\(''ChallengeName''\) == ''MFA'''/);
    assert.match(text, /\n {2}call "verify" L4 {2}key: verify\n/);
    assert.doesNotMatch(text, /key: finish/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check lists undescribed flow steps too, keyed by symbol name or node id', async () => {
  const root = await repo();
  try {
    const result = output({
      nodes: [node('START', { kind: 'terminal', role: 'start', label: 'START' }), node('g:chat', { kind: 'step', label: 'chat', source: { file: 'g.py', line: 5 } }),
        node('g:plan', { kind: 'step', label: 'plan', symbol: { id: 'py:plan_node', name: 'plan_node', kind: 'function', file: 'g.py', line: 9 } }),
        node('g:done', { kind: 'step', label: 'done', explanation: 'Wrap up.' })],
      edges: [],
    });
    const h = harness(root, { evaluate: async () => result });
    assert.equal(await h.run('check', '.stingray/views/flow.yaml'), 0);
    const text = h.out.join('\n');
    assert.match(text, /undescribed steps \(2; /);
    assert.match(text, /\n {2}step "chat" L5 {2}key: 'g:chat'\n {2}step "plan" {2}key: plan_node\n/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check prints a flowchart summarized (hidden steps, can-fail guards); --all-steps prints every step', async () => {
  const root = await repo();
  try {
    const flowchart: ResolvedView = { ...view, kind: 'flowchart', rules: [], flowchart: { start: { symbol: 'login' }, depth: 0 } };
    const loadViewPath: CliDeps['loadViewPath'] = async () => ({ summary: { ...summary, kind: 'flowchart' }, view: flowchart, ruleFiles: [], errors: [] });
    const fakeGraph = { findSymbols: () => [], symbols: () => new Map(), outgoing: () => [], incoming: () => [], fileSymbols: () => [], layers: () => null, rollup: () => [] };
    const edge = (from: string, to: string, label: string | null = null) => ({ id: `${from}->${to}`, from, to, fromField: null, toField: null, kind: label ? label.toLowerCase() : 'next', style: 'solid' as const, certain: true, label, source: null });
    const result = output({
      nodes: [node('start', { kind: 'start', role: 'start', label: 'login' }), node('load', { kind: 'call', label: 'load user' }),
        node('d', { kind: 'decision', label: 'no user?' }), node('err', { kind: 'error', label: 'NotFound' }),
        node('log', { kind: 'action', label: 'log' }), node('done', { kind: 'end', role: 'end', label: 'done' })],
      edges: [edge('start', 'load'), edge('load', 'd'), edge('d', 'err', 'Yes'), edge('d', 'log', 'No'), edge('log', 'done')],
      diagnostics: { rules: [], graph: null, flowchart: { start: 'login (a.py:1)', depth: 0, functions: 1, nodes: 6, truncated: false, error: null }, unresolved: [], limits: { filesScanned: 0, matches: 0, truncated: false }, ms: 1 },
    });
    const h = harness(root, { loadViewPath, evaluate: async () => result, openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }) });
    assert.equal(await h.run('check', '.stingray/views/flow.yaml'), 0);
    const text = h.out.join('\n');
    assert.match(text, /summary: 1 step hidden, 1 guard folded into "can fail"/);
    assert.match(text, /\[call\] load user.*\(can fail: NotFound\)/);
    assert.doesNotMatch(text, /\[ \] log/);
    const all = harness(root, { loadViewPath, evaluate: async () => result, openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }) });
    assert.equal(await all.run('check', '.stingray/views/flow.yaml', '--all-steps'), 0);
    assert.match(all.out.join('\n'), /\[ \] log/);
    assert.doesNotMatch(all.out.join('\n'), /summary:|can fail/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check --depth overrides layers.depth (1-4) and prints the layers diagnostic', async () => {
  const root = await repo();
  try {
    const layered: ResolvedView = { ...view, kind: 'graph', rules: [], layers: { depth: 1 } };
    const loadViewPath: CliDeps['loadViewPath'] = async () => ({ summary: { ...summary, kind: 'graph' }, view: layered, ruleFiles: [], errors: [] });
    const fakeGraph = { findSymbols: () => [], symbols: () => new Map(), outgoing: () => [], incoming: () => [], fileSymbols: () => [], layers: () => null, rollup: () => [] };
    const h = harness(root, { loadViewPath, openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }),
      evaluate: async input => { h.calls.evaluate.push(input); return output({ diagnostics: { rules: [], graph: null, unresolved: [], limits: { filesScanned: 0, matches: 0, truncated: false }, ms: 1,
        layers: { config: '.stinggraph/layers.yaml', depth: input.view.layers!.depth, services: 2, files: 5, nodes: 9, error: null } } }); } });
    assert.equal(await h.run('check', '.stingray/views/flow.yaml', '--depth', '3'), 0);
    assert.equal(h.calls.evaluate[0].view.layers!.depth, 3);
    assert.match(h.out.join('\n'), /layers: \.stinggraph\/layers\.yaml {2}depth 3 {2}services 2 {2}files 5 {2}nodes 9/);
    const zero = harness(root, { loadViewPath });
    assert.equal(await zero.run('check', '.stingray/views/flow.yaml', '--depth', '0'), 2);
    assert.match(zero.err.join('\n'), /--depth of a layers view is 1 to 4/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check --depth overrides sequence.depth (0-6), prints the sequence diagnostic and text; its error fails', async () => {
  const root = await repo();
  try {
    const seq: ResolvedView = { ...view, kind: 'sequence', rules: [], sequence: { start: { symbol: 'submit' }, actor: 'User', depth: 3, participants: 'auto',
      internal: 'collapse', returns: true, links: ['http'], externals: {} } };
    const loadViewPath: CliDeps['loadViewPath'] = async () => ({ summary: { ...summary, kind: 'sequence' }, view: seq, ruleFiles: [], errors: [] });
    const fakeGraph = { findSymbols: () => [], symbols: () => new Map(), outgoing: () => [], incoming: () => [], fileSymbols: () => [], layers: () => null, rollup: () => [] };
    const result = (depth: number, error: string | null) => output({ nodes: [], edges: [],
      sequence: { participants: [{ id: 'p:file:a.tsx', label: 'a.tsx', kind: 'participant', subtitle: 'a.tsx', column: 0, source: null, symbol: null },
        { id: 'p:file:b.py', label: 'b.py', kind: 'participant', subtitle: 'b.py', column: 1, source: null, symbol: null }],
      messages: [{ id: 'm0', from: 'p:file:a.tsx', to: 'p:file:b.py', kind: 'http', label: 'POST /login', detail: null, level: 0, certain: true, link: 'http', source: null, symbol: null }],
      fragments: [], notes: [] },
      diagnostics: { rules: [], graph: null, unresolved: [], limits: { filesScanned: 0, matches: 0, truncated: false }, ms: 1,
        sequence: { start: 'submit (a.tsx:1)', depth, participants: 'file', functions: 2, messages: 1, links: { http: 1 }, truncated: false, error } } });
    const h = harness(root, { loadViewPath, openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }),
      evaluate: async input => { h.calls.evaluate.push(input); return result(input.view.sequence!.depth, null); } });
    assert.equal(await h.run('check', '.stingray/views/flow.yaml', '--depth', '6'), 0);
    assert.equal(h.calls.evaluate[0].view.sequence!.depth, 6);
    const text = h.out.join('\n');
    assert.match(text, /sequence: start submit \(a\.tsx:1\) {2}depth 6 {2}participants file {2}functions 2 {2}messages 1 {2}links http 1/);
    assert.match(text, /\na\.tsx -> b\.py: POST \/login\n/);
    const failing = harness(root, { loadViewPath, evaluate: async () => result(3, 'start symbol not found: submit'),
      openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }) });
    assert.equal(await failing.run('check', '.stingray/views/flow.yaml'), 1);
    assert.match(failing.out.join('\n'), /\n {2}error: start symbol not found: submit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
