import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { DiagramGroup, DiagramNode, ViewResult } from '../../shared/contracts/views';
import { YamlError, parseViewYaml, applyExplain, bodyFingerprint, collectPieces, compareFingerprint, describeChanges, drawnFingerprint, explainTargets, computeView } from '../../electron/app/wiring/views';
import type { GraphSymbol } from '../../electron/core/views/rules/types';
import { formatText } from '../../shared/views/views-text';

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
  assert.match(error('explain:\n  plan: { text: x, fingerprint: 012345678901 }')!, /^explain\.plan\.fingerprint: fingerprint must be a quoted string/);
  assert.match(error('explain:\n  plan: { text: "  " }')!, /^explain\.plan\.text:/);
  assert.match(error(`explain:\n  plan: { text: ${'x'.repeat(501)} }`)!, /^explain\.plan\.text:/);
  assert.match(error('explain:\n  plan: { text: x, note: y }')!, /Unrecognized key: "note"/);
  // The map format: one hash per piece.
  const map = parseViewYaml('version: 1\nname: V\nkind: flow\nuse: [langgraph]\nexplain:\n  plan:\n    text: x\n    fingerprint:\n      a.py::f: 0123456789ab\n      drawn:t: "012345678901"\n', F);
  assert.deepEqual(map.explain[0].fingerprint, { 'a.py::f': '0123456789ab', 'drawn:t': '012345678901' });
  assert.match(error('explain:\n  plan:\n    text: x\n    fingerprint: { a.py::f: XYZ }')!, /^explain\.plan\.fingerprint\.a\.py::f: fingerprint must be 12 hex characters/);
  assert.match(error('explain:\n  plan:\n    text: x\n    fingerprint: { a.py::f: 012345678901 }')!, /^explain\.plan\.fingerprint\.a\.py::f: fingerprint must be a quoted string/);
  const many = Array.from({ length: 201 }, (_, i) => `      k${i}: 0123456789ab`).join('\n');
  assert.match(error(`explain:\n  plan:\n    text: x\n    fingerprint:\n${many}`)!, /^explain\.plan\.fingerprint: fingerprint has at most 200 pieces/);
  assert.match(error('explain:\n  plan: { text: x, fingerprint: [0123456789ab] }')!, /^explain\.plan\.fingerprint: fingerprint must be a quoted string/);
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
    { key: 'verify', text: 'Accept only genuine tokens', fingerprint: { 'app.py::verify': fp }, line: 6 },
    { key: 'users', text: 'Everyone who signed up', fingerprint: { 'drawn:t': '000000000000' }, line: 8 },
    { key: 'plan', text: 'Plans', fingerprint: null, line: 10 },
    { key: 'ghost', text: 'Nothing', fingerprint: null, line: 12 },
  ], { verify: true, readSource: async f => { reads.push(f); return SOURCE; } });
  assert.deepEqual(out.nodes.map(n => [n.id, n.explanation, n.explanationStatus, n.explanationReason]), [
    ['call@3', 'Accept only genuine tokens', 'view', undefined], ['t', 'Everyone who signed up', 'stale', 'may be outdated: "users" changed (as drawn)'],
    ['plan', 'Plans', 'unstamped', undefined]]);
  assert.deepEqual(out.warnings.map(w => [w.line, w.message]), [
    [8, 'explanation for "users" may be outdated: "users" changed (as drawn) — review it and run stingray-views check --restamp'],
    [10, 'explanation for "plan" has no fingerprint — run stingray-views check --restamp to stamp it'],
    [null, 'engine warning']]);
  assert.deepEqual(out.diagnostics!.unresolved, [{ rule: 'explain', value: 'ghost', file: F, line: 12 }]);
  const none = { changed: [], added: [], removed: [] };
  const summary = (pieces: Record<string, string>) => createHash('sha256').update(Object.entries(pieces).map(([k, v]) => `${k}=${v}`).join('\n')).digest('hex').slice(0, 12);
  const diag = (key: string, line: number, pieces: Record<string, string> | null, status: string | null, files: string[] = [], changes: { changed: string[]; added: string[]; removed: string[] } = none) =>
    ({ key, line, matches: pieces ? 1 : 0, fingerprint: pieces && summary(pieces), pieces, skipped: [], status, changes, files });
  assert.deepEqual(out.diagnostics!.explain, [
    diag('verify', 6, { 'app.py::verify': fp }, 'view', ['app.py']),
    diag('users', 8, { 'drawn:t': drawnFingerprint(table) }, 'stale', [], { changed: ['drawn:t'], added: [], removed: [] }),
    diag('plan', 10, { 'drawn:plan': drawnFingerprint(node('plan')) }, 'unstamped'), diag('ghost', 12, null, null)]);
  assert.deepEqual(reads, ['app.py']);
  assert.match(formatText(out), /\n {2}users \(table\) — Everyone who signed up \(may be outdated\)\n {2}plan \(step\) — Plans$/);
});

test('applyExplain without verification applies texts unchecked; a changed body turns the entry stale', async () => {
  const verify = sym('verify'), fp = bodyFingerprint(SOURCE, verify)!;
  const entry = [{ key: 'verify', text: 'Accept', fingerprint: { 'app.py::verify': fp }, line: 6 }];
  const unchecked = await applyExplain(result([node('c', { symbol: verify })]), [{ ...entry[0], fingerprint: { 'app.py::verify': '000000000000' } }], { verify: false });
  assert.equal(unchecked.nodes[0].explanationStatus, 'view');
  assert.deepEqual([unchecked.diagnostics!.explain![0].fingerprint, unchecked.diagnostics!.explain![0].pieces, unchecked.diagnostics!.explain![0].files], [null, null, ['app.py']]);
  const changed = await applyExplain(result([node('c', { symbol: verify })]), entry, { verify: true, readSource: async () => SOURCE.replace('ok', 'nok') });
  assert.equal(changed.nodes[0].explanationStatus, 'stale');
  const group = await applyExplain(result([], [{ id: 'call:py:verify', label: 'verify', source: null, symbol: verify }]), entry, { verify: true, readSource: async () => SOURCE });
  assert.deepEqual([group.groups[0].explanation, group.groups[0].explanationStatus], ['Accept', 'view']);
});

test('computeView applies explain: after symbols are linked and verifies only with a ready code graph', async () => {
  const entry = {
    summary: { id: 'v', name: 'V', kind: 'flow' as const, description: '', builtin: false, file: F, error: null }, ruleFiles: [], errors: [],
    view: { id: 'v', kind: 'flow' as const, scope: { include: ['**/*'], exclude: [] }, rules: [], graph: { start: [{ symbol: 'x' }], follow: ['calls' as const], direction: 'out' as const, depth: 1, helpers: 'show' as const }, flowchart: null, builtins: [], include: [], exclude: [] },
    explain: [{ key: 'plan', text: 'Plans', fingerprint: { 'drawn:plan': '000000000000' }, line: 6 }],
  };
  const deps = (state: 'ready' | 'unavailable') => ({ graph: { state, message: null }, findSymbols: async () => [], readSource: async () => null,
    evaluate: async () => { const r = result([node('plan')]); return { ...r, diagnostics: r.diagnostics! }; } });
  assert.equal((await computeView(entry, deps('ready'))).nodes[0].explanationStatus, 'stale');
  assert.equal((await computeView(entry, deps('unavailable'))).nodes[0].explanationStatus, 'view');
  const plain = await computeView({ ...entry, explain: undefined }, deps('ready'));
  assert.equal(plain.nodes[0].explanation, undefined);
  assert.equal(plain.diagnostics!.explain, undefined);
});

test('applyExplain fingerprints every target of a key: editing either of two same-named functions turns it stale', async () => {
  const two = `${SOURCE}\ndef verify(token):\n    return True\n`;
  const first = { ...sym('verify'), qualifiedName: 'A::verify' }, second = { ...sym('verify', 5, 6), id: 'py:verify2', qualifiedName: 'B::verify' };
  const run = (source: string, fingerprint: Record<string, string> | null) => applyExplain(result([node('a', { symbol: first }), node('b', { symbol: second })]),
    [{ key: 'verify', text: 'Accept', fingerprint, line: 6 }], { verify: true, readSource: async () => source });
  const pieces = (await run(two, null)).diagnostics!.explain![0].pieces!;
  assert.deepEqual(pieces, { 'app.py::A::verify': bodyFingerprint(two, first), 'app.py::B::verify': bodyFingerprint(two, second) });
  assert.deepEqual((await run(two, pieces)).nodes.map(n => n.explanationStatus), ['view', 'view']);
  const edited = await run(two.replace('return True', 'return False'), pieces);
  assert.deepEqual(edited.nodes.map(n => [n.explanationStatus, n.explanationReason]), [['stale', 'may be outdated: B::verify changed'], ['stale', 'may be outdated: B::verify changed']]);
  const same = await applyExplain(result([node('c', { symbol: first })], [{ id: 'call:py:verify', label: 'verify', source: null, symbol: first }]),
    [{ key: 'verify', text: 'Accept', fingerprint: null, line: 6 }], { verify: true, readSource: async () => SOURCE });
  assert.deepEqual(same.diagnostics!.explain![0].pieces, { 'app.py::A::verify': bodyFingerprint(SOURCE, first) }, 'one body linked twice is one piece');
  const short = await applyExplain(result([node('a', { symbol: first }), node('b', { symbol: second })]),
    [{ key: 'verify', text: 'Accept', fingerprint: null, line: 6 }], { verify: true, readSource: async () => SOURCE });
  assert.deepEqual([short.diagnostics!.explain![0].fingerprint, short.diagnostics!.explain![0].pieces], [null, null], 'null when any target cannot be fingerprinted');
});

test('drawnFingerprint of a group without a symbol covers its member nodes and nested groups', async () => {
  const groups: DiagramGroup[] = [{ id: 'g', label: 'Agents', source: null }, { id: 'inner', label: 'Inner', source: null, parent: 'g' }];
  const nodes = [node('plan', { group: 'g' }), node('act', { group: 'inner' }), node('other')];
  const fp = drawnFingerprint(groups[0], nodes, groups);
  assert.notEqual(fp, drawnFingerprint(groups[0]));
  assert.equal(drawnFingerprint(groups[0], [...nodes.slice(0, 2), node('other', { label: 'changed' })], groups), fp, 'non-members do not count');
  assert.notEqual(drawnFingerprint(groups[0], [nodes[0], node('act', { group: 'inner', label: 'act!' }), nodes[2]], groups), fp, 'nested members count');
  assert.notEqual(drawnFingerprint(groups[0], [...nodes, node('new', { group: 'g' })], groups), fp);
  const out = await applyExplain(result([...nodes.slice(0, 1), node('act', { group: 'inner', detail: 'x' })], groups),
    [{ key: 'g', text: 'The agents', fingerprint: { 'drawn:g': fp }, line: 6 }], { verify: true });
  assert.equal(out.groups[0].explanationStatus, 'stale');
});

test('applyExplain says why an unstamped entry cannot be checked instead of asking for a restamp', async () => {
  const warn = async (symbol: ReturnType<typeof sym>, source: string | null) => (await applyExplain(result([node('c', { symbol })]),
    [{ key: 'verify', text: 'Accept', fingerprint: null, line: 6 }], { verify: true, readSource: async () => source })).warnings[0].message;
  assert.equal(await warn({ ...sym('verify'), endLine: undefined } as never, SOURCE), 'explanation for "verify" has no fingerprint and cannot be checked: the code graph has no end line for verify');
  assert.equal(await warn(sym('verify'), null), 'explanation for "verify" has no fingerprint and cannot be checked: app.py could not be read (missing, too large or unreadable)');
  assert.equal(await warn(sym('verify', 1, 99), SOURCE), 'explanation for "verify" has no fingerprint and cannot be checked: app.py is shorter than the code graph says (re-index)');
  assert.doesNotMatch(await warn(sym('verify', 1, 99), SOURCE), /--restamp/);
});

// Callee fixtures: identity (app.py) calls verify (lib.py), get_user (excluded.py, excluded by the view); verify calls audit.
const FILES: Record<string, string> = {
  'app.py': 'def identity(token):\n    claims = verify(token)\n    return get_user(claims)\n',
  'lib.py': 'def verify(token):\n    return jwt.decode(token)\ndef audit():\n    pass\n',
  'excluded.py': 'def get_user(claims):\n    return db.get(claims)\n',
  'models.py': 'class User:\n    def __init__(self):\n        self.id = 1\n\nclass Bare:\n    x = 1\n',
};
const gs = (file: string, name: string, line: number, endLine?: number, kind = 'function'): GraphSymbol =>
  ({ id: `${file}:${name}`, name, kind, file, line, ...(endLine ? { endLine } : {}), qualifiedName: name });
const IDENTITY = gs('app.py', 'identity', 1, 3), VERIFY = gs('lib.py', 'verify', 1, 2), AUDIT = gs('lib.py', 'audit', 3, 4);
const GET_USER = gs('excluded.py', 'get_user', 1, 2), USER = gs('models.py', 'User', 1, 3, 'class'), INIT = { ...gs('models.py', '__init__', 2, 3, 'method'), qualifiedName: 'User::__init__' };
const BARE = gs('models.py', 'Bare', 5, 6, 'class');
const fakeDeps = (calls: GraphSymbol[], files: Record<string, string> = FILES) => ({
  read: async (f: string) => files[f] ?? null,
  callees: async (ids: string[]) => new Map(ids.map(id => [id, id === IDENTITY.id ? calls : id === VERIFY.id ? [AUDIT] : []])),
  fileSymbols: async (f: string) => [USER, INIT, BARE].filter(s => s.file === f),
});
const target = (s: GraphSymbol, id = 'call@1') => node(id, { symbol: { id: s.id, name: s.name, kind: s.kind, file: s.file, line: s.line, endLine: s.endLine, qualifiedName: s.qualifiedName } });
const body = (s: GraphSymbol, files = FILES) => bodyFingerprint(files[s.file], s)!;

test('collectPieces: own body plus direct in-repo callees, excluded files kept, recursion skipped, class → constructor', async () => {
  // A library call is absent because the graph has no node for it; the fake callees() returns only repo symbols.
  const got = await collectPieces([target(IDENTITY)], [], [], fakeDeps([VERIFY, GET_USER, IDENTITY, USER, BARE, VERIFY]));
  assert.deepEqual(got, {
    pieces: { 'app.py::identity': body(IDENTITY), 'excluded.py::get_user': body(GET_USER), 'lib.py::verify': body(VERIFY), 'models.py::User::__init__': body(INIT) },
    skipped: [], files: ['app.py', 'excluded.py', 'lib.py', 'models.py'] });
  assert.deepEqual(Object.keys(got.pieces!), Object.keys(got.pieces!).sort());
  const noQualified = await collectPieces([node('c', { symbol: { ...target(IDENTITY).symbol!, qualifiedName: undefined } })], [], [], fakeDeps([]));
  assert.deepEqual(noQualified.pieces, { 'app.py::identity': body(IDENTITY) }, 'falls back to file::name');
  const noDeps = await collectPieces([target(IDENTITY)], [], [], { read: async f => FILES[f] ?? null });
  assert.deepEqual(noDeps.pieces, { 'app.py::identity': body(IDENTITY) }, 'no callees without the graph lookups');
});

test('collectPieces: unhashable callees are skipped, an unhashable target or too many pieces make the entry uncomputable', async () => {
  const gone = gs('gone.py', 'lost', 1, 2), noEnd = gs('lib.py', 'open_ended', 1);
  const got = await collectPieces([target(IDENTITY)], [], [], fakeDeps([VERIFY, gone, noEnd, gone]));
  assert.deepEqual([Object.keys(got.pieces!), got.skipped], [['app.py::identity', 'lib.py::verify'], ['gone.py::lost', 'lib.py::open_ended']]);
  assert.deepEqual(got.files, ['app.py', 'gone.py', 'lib.py'], 'a skipped callee\'s file is listed, so restamp sees it lag');
  const long = { ...VERIFY, id: 'long', qualifiedName: 'x'.repeat(500) };
  assert.deepEqual((await collectPieces([target(IDENTITY)], [], [], fakeDeps([long]))).skipped, [`lib.py::${'x'.repeat(500)}`], 'a key over 500 characters is skipped');
  assert.deepEqual(await collectPieces([target(long)], [], [], fakeDeps([])),
    { pieces: null, skipped: [], files: [], why: 'the name of verify is too long to fingerprint' });
  assert.deepEqual(await collectPieces([target(IDENTITY)], [], [], fakeDeps([VERIFY], {})),
    { pieces: null, skipped: [], files: [], why: 'app.py could not be read (missing, too large or unreadable)' });
  const many = Array.from({ length: 200 }, (_, i) => gs('lib.py', `f${i}`, 1, 2));
  assert.equal(Object.keys((await collectPieces([target(IDENTITY)], [], [], fakeDeps(many.slice(0, 199)))).pieces!).length, 200);
  assert.deepEqual(await collectPieces([target(IDENTITY)], [], [], fakeDeps(many)),
    { pieces: null, skipped: [], files: [], why: 'it calls too many functions to fingerprint' });
  const table = node('t', { kind: 'table', label: 'users' });
  assert.deepEqual((await collectPieces([table, target(IDENTITY)], [], [], fakeDeps([]))).pieces,
    { 'app.py::identity': body(IDENTITY), 'drawn:t': drawnFingerprint(table) }, 'targets with and without a symbol: the union');
});

test('collectPieces: only callable callees, a class\'s own constructor, colliding keys fold, unknown lookups make it unchecked', async () => {
  const imp = gs('lib.py', 'jwt', 1, 1, 'import'), file = gs('lib.py', 'lib.py', 1, 4, 'file');
  assert.deepEqual(Object.keys((await collectPieces([target(IDENTITY)], [], [], fakeDeps([imp, file, VERIFY]))).pieces!), ['app.py::identity', 'lib.py::verify']);
  // A nested class's constructor that comes first is not the class's own.
  const nested = { ...gs('models.py', '__init__', 2, 3, 'method'), id: 'nested', qualifiedName: 'User::Inner::__init__' };
  const own = { ...gs('models.py', '__init__', 2, 3, 'method'), id: 'own', qualifiedName: 'User::__init__' };
  const ctor = (symbols: GraphSymbol[]) => collectPieces([target(IDENTITY)], [], [], { ...fakeDeps([USER]), fileSymbols: async () => symbols });
  assert.deepEqual(Object.keys((await ctor([nested, own])).pieces!), ['app.py::identity', 'models.py::User::__init__']);
  assert.deepEqual(Object.keys((await ctor([nested, { ...own, kind: 'function' }])).pieces!), ['app.py::identity'], 'a constructor is a method');
  // Same key, different symbols (e.g. a property getter and setter): both bodies count, folded in order.
  const getter = gs('lib.py', 'verify', 1, 2), setter = { ...gs('lib.py', 'verify', 3, 4), id: 'setter' };
  const folded = (await collectPieces([target(IDENTITY)], [], [], fakeDeps([getter, setter]))).pieces!['lib.py::verify'];
  assert.notEqual(folded, body(getter));
  const edited = { ...FILES, 'lib.py': FILES['lib.py'].replace('pass', 'return 2') };
  assert.notEqual((await collectPieces([target(IDENTITY)], [], [], fakeDeps([getter, setter], edited))).pieces!['lib.py::verify'], folded, 'the second body counts');
  const targets = await collectPieces([target(getter, 'a'), target(setter, 'b'), target(getter, 'c')], [], [], fakeDeps([]));
  assert.equal(targets.pieces!['lib.py::verify'], folded, 'targets fold the same way; one symbol twice counts once');
  // A lookup without an answer is unknown, never "calls nothing".
  assert.deepEqual(await collectPieces([target(IDENTITY)], [], [], { ...fakeDeps([]), callees: async () => null }), { pieces: null, skipped: [], files: [] });
  assert.deepEqual(await collectPieces([target(IDENTITY)], [], [], { ...fakeDeps([USER]), fileSymbols: async () => null }), { pieces: null, skipped: [], files: [] });
});

test('compareFingerprint: none → unstamped, string → legacy, map → view or stale with sorted changes', () => {
  const now = { a: '1', b: '2', c: '3' };
  assert.deepEqual(compareFingerprint(null, now), { status: 'unstamped', changes: { changed: [], added: [], removed: [] } });
  assert.deepEqual(compareFingerprint('0123456789ab', now), { status: 'legacy', changes: { changed: [], added: [], removed: [] } });
  assert.deepEqual(compareFingerprint({ c: '3', b: '2', a: '1' }, now), { status: 'view', changes: { changed: [], added: [], removed: [] } });
  assert.deepEqual(compareFingerprint({ a: '1', b: 'x', z: '9', d: '4' }, now), { status: 'stale', changes: { changed: ['b'], added: ['c'], removed: ['d', 'z'] } });
});

test('describeChanges: short names unless two read the same, at most 3 per category, drawn pieces by label', () => {
  assert.equal(describeChanges({ changed: ['a.py::SessionStore::get_user'], added: ['b.py::audit::log'], removed: ['c.py::cache::get'] }),
    'may be outdated: SessionStore::get_user changed; new call audit::log; no longer calls cache::get');
  assert.equal(describeChanges({ changed: ['a.py::f', 'b.py::f', 'c.py::g'], added: [], removed: [] }), 'may be outdated: a.py::f, b.py::f, g changed');
  assert.equal(describeChanges({ changed: [], added: ['a.py::f', 'a.py::g', 'a.py::h', 'a.py::i', 'a.py::j'], removed: [] }),
    'may be outdated: new calls f, g, h (+2 more)');
  assert.equal(describeChanges({ changed: ['drawn:t', 'x.py::f'], added: [], removed: [] }, id => (id === 't' ? 'users' : id)),
    'may be outdated: f changed; "users" changed (as drawn)');
  assert.equal(describeChanges({ changed: ['drawn:a', 'drawn:b', 'drawn:c', 'x.py::f'], added: [], removed: [] }), 'may be outdated: f changed; "a", "b", "c" changed (as drawn)',
    'names are unique among those shown');
});

test('applyExplain looks up callees once per compute and symbols once per file', async () => {
  const deps = { ...fakeDeps([]), callees: async (ids: string[]) => new Map(ids.map(id => [id, [USER]])) }, asked: string[][] = [], files: string[] = [];
  await applyExplain(result([target(IDENTITY), target(VERIFY, 'v'), target(USER, 'u')]),
    ['identity', 'verify', 'u'].map(key => ({ key, text: 'x', fingerprint: null, line: 1 })),
    { verify: true, readSource: deps.read, callees: ids => { asked.push(ids); return deps.callees(ids); }, fileSymbols: f => { files.push(f); return deps.fileSymbols(f); } });
  assert.deepEqual([asked, files], [[[IDENTITY.id, VERIFY.id, USER.id]], ['models.py']]);
});

test('applyExplain with callees: callee edits, added and removed calls turn it stale; a callee\'s callee or a legacy stamp do not', async () => {
  const run = async (fingerprint: Record<string, string> | string | null, calls: GraphSymbol[], files = FILES, verify = true) => {
    const deps = fakeDeps(calls, files);
    const out = await applyExplain(result([target(IDENTITY)]), [{ key: 'identity', text: 'Who', fingerprint, line: 6 }],
      { verify, readSource: deps.read, callees: deps.callees, fileSymbols: deps.fileSymbols });
    return { status: out.nodes[0].explanationStatus, reason: out.nodes[0].explanationReason, warning: out.warnings[0].message, diag: out.diagnostics!.explain![0] };
  };
  const stamp = (await run(null, [VERIFY, GET_USER])).diag.pieces!;
  assert.equal((await run(stamp, [VERIFY, GET_USER])).status, 'view');
  const edited = await run(stamp, [VERIFY, GET_USER], { ...FILES, 'excluded.py': FILES['excluded.py'].replace('db.get', 'db.fetch') });
  assert.deepEqual([edited.status, edited.warning], ['stale',
    'explanation for "identity" may be outdated: get_user changed — review it and run stingray-views check --restamp']);
  assert.deepEqual(edited.diag.changes, { changed: ['excluded.py::get_user'], added: [], removed: [] });
  // audit is verify's callee: one level only, so editing it leaves identity's explanation current.
  assert.equal((await run(stamp, [VERIFY, GET_USER], { ...FILES, 'lib.py': FILES['lib.py'].replace('pass', 'return 2') })).status, 'view');
  assert.equal((await run(stamp, [VERIFY, GET_USER, AUDIT])).reason, 'may be outdated: new call audit');
  assert.equal((await run(stamp, [VERIFY])).reason, 'may be outdated: no longer calls get_user');
  for (const verify of [true, false]) {
    const legacy = await run('0123456789ab', [VERIFY], FILES, verify);
    assert.deepEqual([legacy.status, legacy.reason, legacy.warning], ['legacy', 'old fingerprint format (own body only)',
      'explanation for "identity" uses the old fingerprint format (own body only) — review it and run stingray-views check --restamp']);
  }
  const unstamped = await run(null, [VERIFY]);
  assert.deepEqual([unstamped.status, unstamped.reason], ['unstamped', undefined]);
  // The code graph did not answer (timeout, child down): unchecked, no warning; restamp has nothing to write.
  const unknown = await applyExplain(result([target(IDENTITY)]), [{ key: 'identity', text: 'Who', fingerprint: stamp, line: 6 }],
    { verify: true, readSource: fakeDeps([]).read, callees: async () => null });
  assert.deepEqual([unknown.nodes[0].explanationStatus, unknown.warnings.map(w => w.message), unknown.diagnostics!.explain![0].pieces], ['view', ['engine warning'], null]);
  const unreadable = await run(stamp, [VERIFY], {});
  assert.deepEqual([unreadable.status, unreadable.reason, unreadable.warning], ['unstamped', 'app.py could not be read (missing, too large or unreadable)',
    'explanation for "identity" cannot be checked: app.py could not be read (missing, too large or unreadable)']);
});
