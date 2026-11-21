import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiagramGroup, DiagramNode, ViewResult } from '../src/views';
import { YamlError, parseViewYaml } from '../electron/views/rules/schema';
import { applyExplain, bodyFingerprint, drawnFingerprint, explainTargets } from '../electron/views/explain';
import { computeView } from '../electron/views/compute';
import { formatText } from '../src/views-text';

const F = '.stingray/views/v.yaml';
const node = (id: string, extra: Partial<DiagramNode> = {}): DiagramNode =>
  ({ id, label: id, kind: 'step', subtitle: null, group: null, fields: [], source: null, symbol: null, role: null, order: null, detail: null, ...extra });
const sym = (name: string, line = 1, endLine = 3) => ({ id: `py:${name}`, name, kind: 'function', file: 'app.py', line, endLine });
const result = (nodes: DiagramNode[], groups: DiagramGroup[] = []): ViewResult => ({
  id: 'v', name: 'V', kind: 'flow', description: '', builtin: false, file: F, error: null, workspaceId: '', computedAt: 0, truncated: false,
  groups, nodes, edges: [], warnings: [{ file: null, line: null, message: 'engine warning' }], stats: {}, graph: { state: 'ready', message: null }, layout: null,
  diagnostics: { rules: [], graph: null, unresolved: [], limits: { filesScanned: 0, matches: 0, truncated: false }, ms: 0 },
});
const SOURCE = 'def verify(token):\n    """Check the token."""\n    return ok(token)\n';

test('parseViewYaml reads explain: entries with key lines; bad fingerprints and empty texts are errors', () => {
  const v = parseViewYaml('version: 1\nname: V\nkind: flow\nuse: [langgraph]\nexplain:\n  plan:\n    text: "  Plans the trip  "\n  123: { text: Numeric key, fingerprint: 0123456789ab }\n', F);
  assert.deepEqual(v.explain, [ // JS orders integer-like keys first
    { key: '123', text: 'Numeric key', fingerprint: '0123456789ab', line: 8 },
    { key: 'plan', text: 'Plans the trip', fingerprint: null, line: 6 },
  ]);
  assert.deepEqual(parseViewYaml('version: 1\nname: V\nkind: flow\nuse: [langgraph]\n', F).explain, []);
  const error = (extra: string) => { try { parseViewYaml(`version: 1\nname: V\nkind: flow\nuse: [langgraph]\n${extra}`, F); } catch (e) { assert.ok(e instanceof YamlError); return e.message; } return null; };
  assert.match(error('explain:\n  plan: { text: x, fingerprint: XYZ }')!, /fingerprint must be 12 hex characters/);
  assert.match(error('explain:\n  plan: { text: "  " }')!, /^explain\.plan\.text:/);
  assert.match(error(`explain:\n  plan: { text: ${'x'.repeat(501)} }`)!, /^explain\.plan\.text:/);
  assert.match(error('explain:\n  plan: { text: x, note: y }')!, /Unrecognized key: "note"/);
});

test('bodyFingerprint hashes only the symbol body and ignores trailing whitespace and line endings', () => {
  const fp = bodyFingerprint(SOURCE, sym('verify'))!;
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.equal(bodyFingerprint(SOURCE.replaceAll('\n', '  \r\n'), sym('verify')), fp);
  assert.equal(bodyFingerprint(`${SOURCE}\ndef other():\n    pass\n`, sym('verify')), fp, 'code after the body is not part of it');
  assert.notEqual(bodyFingerprint(SOURCE.replace('ok(token)', 'ok(token, strict=True)'), sym('verify')), fp);
  assert.equal(bodyFingerprint(SOURCE, { ...sym('verify'), endLine: undefined }), null);
  assert.equal(bodyFingerprint(SOURCE, sym('verify', 1, 99)), null);
});

test('drawnFingerprint changes with what a node shows (e.g. a table\'s columns), not with its position or explanation', () => {
  const column = (label: string, type: string) => ({ id: label, label, type, badges: ['PK'], detail: null, source: null });
  const users = node('t', { kind: 'table', fields: [column('id', 'Integer')] });
  const fp = drawnFingerprint(users);
  assert.equal(drawnFingerprint({ ...users, explanation: 'x', source: { file: 'a.py', line: 9 }, label: ' t  ' }), fp);
  assert.notEqual(drawnFingerprint({ ...users, fields: [column('id', 'BigInteger')] }), fp);
  assert.notEqual(drawnFingerprint({ ...users, fields: [...users.fields, column('email', 'String')] }), fp);
  assert.notEqual(drawnFingerprint({ ...users, detail: 'other' }), fp);
});

test('explainTargets: node id, then group id, then alias or table name/model, then every node and group of a symbol', () => {
  const verify = sym('verify');
  const nodes = [node('plan', { aliases: ['planner'] }), node('t', { kind: 'table', label: 'users', subtitle: 'User' }),
    node('call@3', { symbol: verify }), node('call@9', { symbol: verify }), node('g')];
  const groups: DiagramGroup[] = [{ id: 'g', label: 'G', source: null }, { id: 'call:py:verify', label: 'verify', source: null, symbol: verify }];
  const ids = (key: string) => explainTargets(key, nodes, groups).map(t => t.id);
  assert.deepEqual(ids('plan'), ['plan']);
  assert.deepEqual(ids('planner'), ['plan']);
  assert.deepEqual(ids('users'), ['t']);
  assert.deepEqual(ids('User'), ['t']);
  assert.deepEqual(ids('g'), ['g'], 'a node id wins over a group id');
  assert.deepEqual(ids('call:py:verify'), ['call:py:verify']);
  assert.deepEqual(ids('verify'), ['call@3', 'call@9', 'call:py:verify']);
  assert.deepEqual(ids('nope'), []);
});

test('applyExplain overrides docstrings, flags stale and unstamped entries, lists unknown keys as unresolved', async () => {
  const verify = sym('verify');
  const fp = bodyFingerprint(SOURCE, verify)!;
  const table = node('t', { kind: 'table', label: 'users' });
  const reads: string[] = [];
  const out = await applyExplain(result([node('call@3', { symbol: verify, explanation: 'Docstring.' }), table, node('plan')]), [
    { key: 'verify', text: 'Accept only genuine tokens', fingerprint: fp, line: 6 },
    { key: 'users', text: 'Everyone who signed up', fingerprint: '000000000000', line: 8 },
    { key: 'plan', text: 'Plans', fingerprint: null, line: 10 },
    { key: 'ghost', text: 'Nothing', fingerprint: null, line: 12 },
  ], { verify: true, readSource: async f => { reads.push(f); return SOURCE; } });
  assert.deepEqual(out.nodes.map(n => [n.id, n.explanation, n.explanationStatus]), [
    ['call@3', 'Accept only genuine tokens', 'view'], ['t', 'Everyone who signed up', 'stale'], ['plan', 'Plans', 'unstamped']]);
  assert.deepEqual(out.warnings.map(w => [w.line, w.message]), [
    [8, 'explanation for "users" may be outdated (code changed since it was written) — review it and run stingray-views check --restamp'],
    [10, 'explanation for "plan" has no fingerprint — run stingray-views check --restamp to stamp it'],
    [null, 'engine warning']]);
  assert.deepEqual(out.diagnostics!.unresolved, [{ rule: 'explain', value: 'ghost', file: F, line: 12 }]);
  assert.deepEqual(out.diagnostics!.explain, [
    { key: 'verify', line: 6, matches: 1, fingerprint: fp }, { key: 'users', line: 8, matches: 1, fingerprint: drawnFingerprint(table) },
    { key: 'plan', line: 10, matches: 1, fingerprint: drawnFingerprint(node('plan')) }, { key: 'ghost', line: 12, matches: 0, fingerprint: null }]);
  assert.deepEqual(reads, ['app.py']);
  assert.match(formatText(out), /\n {2}users \(table\) — Everyone who signed up \(may be outdated\)\n {2}plan \(step\) — Plans$/);
});

test('applyExplain without verification applies texts unchecked; a changed body turns the entry stale', async () => {
  const verify = sym('verify'), fp = bodyFingerprint(SOURCE, verify)!;
  const entry = [{ key: 'verify', text: 'Accept', fingerprint: fp, line: 6 }];
  const unchecked = await applyExplain(result([node('c', { symbol: verify })]), [{ ...entry[0], fingerprint: '000000000000' }], { verify: false });
  assert.equal(unchecked.nodes[0].explanationStatus, 'view');
  assert.equal(unchecked.diagnostics!.explain![0].fingerprint, null);
  const changed = await applyExplain(result([node('c', { symbol: verify })]), entry, { verify: true, readSource: async () => SOURCE.replace('ok', 'nok') });
  assert.equal(changed.nodes[0].explanationStatus, 'stale');
  const group = await applyExplain(result([], [{ id: 'call:py:verify', label: 'verify', source: null, symbol: verify }]), entry, { verify: true, readSource: async () => SOURCE });
  assert.deepEqual([group.groups[0].explanation, group.groups[0].explanationStatus], ['Accept', 'view']);
});

test('computeView applies explain: after symbols are linked and verifies only with a ready code graph', async () => {
  const entry = {
    summary: { id: 'v', name: 'V', kind: 'flow' as const, description: '', builtin: false, file: F, error: null }, ruleFiles: [], errors: [],
    view: { id: 'v', kind: 'flow' as const, scope: { include: ['**/*'], exclude: [] }, rules: [], graph: { start: [{ symbol: 'x' }], follow: ['calls' as const], direction: 'out' as const, depth: 1, helpers: 'show' as const }, flowchart: null, builtins: [], include: [], exclude: [] },
    explain: [{ key: 'plan', text: 'Plans', fingerprint: '000000000000', line: 6 }],
  };
  const deps = (state: 'ready' | 'unavailable') => ({ graph: { state, message: null }, findSymbols: async () => [], readSource: async () => null,
    evaluate: async () => { const r = result([node('plan')]); return { ...r, diagnostics: r.diagnostics! }; } });
  assert.equal((await computeView(entry, deps('ready'))).nodes[0].explanationStatus, 'stale');
  assert.equal((await computeView(entry, deps('unavailable'))).nodes[0].explanationStatus, 'view');
  const plain = await computeView({ ...entry, explain: undefined }, deps('ready'));
  assert.equal(plain.nodes[0].explanation, undefined);
  assert.equal(plain.diagnostics!.explain, undefined);
});
