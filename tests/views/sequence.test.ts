import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, codegraphGrammarDir, YamlError, parseViewYaml, SEQUENCE_LIMITS } from '../../electron/app/wiring/views';
import type { GraphLayers, GraphSymbol } from '../../electron/core/views/rules/types';
import { formatText } from '../../shared/views/views-text';
import { fakeGraph, run, step } from './sequence-helpers';

const grammarDir = codegraphGrammarDir();

const AUTH = {
  'services/auth/api.py': `import jwt
from sqlalchemy import text
from services.auth.store import save_session


def sign_in(email, password):
    user = find_user(email)
    if user is None:
        raise HTTPException(401)
    elif not check(user, password):
        audit(email)
        raise HTTPException(403)
    else:
        token = jwt.encode({"sub": email})
    for s in user.sessions:
        save_session(s)
    try:
        save_session(token)
    except ValueError:
        audit("retry")
    return token


def find_user(email):
    return db.execute(text("select"))


def check(user, password):
    return user.password == password


def audit(what):
    log(what)
`,
  'services/auth/store.py': `class Store:
    def save_session(self, s):
        return persist(s)
`,
};
const AUTH_CALLS = ['sign_in>find_user', 'sign_in>check', 'sign_in>audit', 'sign_in>save_session?'];

test('sequence python: call order, collapsed internal calls, externals by import, alt/loop/try fragments, error notes, returns', async () => {
  const out = await run(AUTH, fakeGraph(AUTH, AUTH_CALLS), { start: { symbol: 'sign_in' } });
  assert.equal(out.diagnostics.sequence!.error, null);
  assert.equal(out.diagnostics.sequence!.start, 'sign_in (services/auth/api.py:6)');
  assert.equal(out.diagnostics.sequence!.participants, 'file');
  assert.deepEqual(out.text, [
    'participants: api.py, store.py, Database (external), JWT (external)',
    '  api.py -> Database: execute',
    'alt user is none',
    '  note api.py: can fail: http exception',
    'else not check user password',
    '  note api.py: can fail: http exception',
    'else',
    '  api.py -> JWT: encode',
    'end',
    'loop for each user sessions',
    '  api.py -> store.py: save session  (uncertain)',
    '  store.py --> api.py',
    'end',
    'try',
    '  api.py -> store.py: save session  (uncertain)',
    '  store.py --> api.py',
    'end',
  ]);
  const { messages, fragments, notes, participants } = out.seq;
  assert.deepEqual(messages.map(m => [m.kind, m.level, m.certain]), [['call', 1, true], ['call', 0, true], ['call', 0, false], ['return', 0, true], ['call', 0, false], ['return', 0, true]]);
  assert.deepEqual(messages[1].source, { file: 'services/auth/api.py', line: 14 });
  assert.equal(messages[2].symbol!.name, 'save_session');
  assert.deepEqual(fragments.map(f => [f.id, f.kind, f.first, f.last, f.branches.map(b => b.first), f.parent]),
    [['f0', 'alt', 1, 1, [1, 1], null], ['f1', 'loop', 2, 3, [], null], ['f2', 'try', 4, 5, [], null]]); // the except arm drew nothing
  assert.deepEqual(notes.map(n => [n.after, n.fragment, n.arm]), [[0, 'f0', 0], [0, 'f0', 1]]);
  assert.deepEqual(notes.map(n => n.detail), ['HTTPException', 'HTTPException'], 'the raw type is the note detail');
  assert.deepEqual(fragments.map(f => f.detail?.slice(0, 23) ?? null), ['if user is None: raise ', 'for s in user.sessions:', null], 'alt/opt/loop carry their code (like flowchart decisions)');
  // Nodes mirror the participants; no edges.
  assert.deepEqual(out.nodes.map(n => [n.id, n.kind, n.order]), participants.map(p => [p.id, p.kind, p.column]));
  assert.deepEqual(participants.map(p => p.id), ['p:file:services/auth/api.py', 'p:file:services/auth/store.py', 'ext:Database', 'ext:JWT']);
  assert.deepEqual(participants.map(p => p.column), [0, 1, 2, 3]);
  assert.equal(out.edges.length, 0);
});

test('sequence: a message carries its callee\'s docstring summary for the inspector; returns never show code', async () => {
  const graph = fakeGraph(AUTH, AUTH_CALLS);
  graph.findSymbols('save_session')[0].docstring = 'Store a session for later sign-ins.\n\nDetails.';
  const { seq } = await run(AUTH, graph, { start: { symbol: 'sign_in' } });
  const calls = seq.messages.filter(m => m.symbol?.name === 'save_session');
  assert.ok(calls.length && calls.every(m => m.explanation === 'Store a session for later sign-ins.'));
  assert.ok(seq.messages.filter(m => m.kind === 'return').every(m => m.label === ''), 'no returned value on return arrows');
});

test('sequence: internal show draws self calls, returns: false drops return arrows, depth 0 follows nothing', async () => {
  const graph = fakeGraph(AUTH, AUTH_CALLS);
  const show = await run(AUTH, graph, { start: { symbol: 'sign_in' }, internal: 'show', returns: false });
  assert.deepEqual(show.text.slice(1, 3), ['api.py -> api.py: find user', '  api.py -> Database: execute']);
  assert.ok(show.seq.messages.every(m => m.kind !== 'return'));
  assert.deepEqual(show.seq.messages.filter(m => m.kind === 'self').map(m => m.label), ['find user', 'check', 'audit', 'audit']);
  const flat = await run(AUTH, graph, { start: { symbol: 'sign_in' }, depth: 0 });
  assert.ok(!flat.seq.participants.some(p => p.id === 'ext:Database'), 'find_user is not followed at depth 0');
  assert.deepEqual(flat.seq.messages.map(m => m.label), ['encode', 'save session', '', 'save session', '']);
  assert.equal(flat.diagnostics.sequence!.depth, 0);
});

test('sequence: class participants, view exclude drops a participant and its messages', async () => {
  const graph = fakeGraph(AUTH, AUTH_CALLS);
  const classes = await run(AUTH, graph, { start: { symbol: 'sign_in' }, participants: 'class' });
  assert.ok(classes.seq.participants.some(p => p.id === 'p:class:services/auth/store.py#Store' && p.label === 'Store' && p.subtitle === null && p.source?.file === 'services/auth/store.py'));
  assert.equal(classes.diagnostics.sequence!.participants, 'class');
  const excluded = await run(AUTH, graph, { start: { symbol: 'sign_in' } }, { exclude: ['JWT', 'p:file:services/auth/store.py'] });
  assert.deepEqual(excluded.seq.participants.map(p => p.label), ['api.py', 'Database']);
  assert.deepEqual(excluded.seq.messages.map(m => m.label), ['execute']);
  assert.deepEqual(excluded.seq.fragments.map(f => f.kind), []); // nothing drawn inside them any more
});

const WEB = {
  'web/src/Login.tsx': `import { request } from './api';
import axios from 'axios';

export async function submit(event) {
  event.preventDefault();
  try {
    const result = await request('/auth/login', { email });
    if (result.ok) {
      track('login');
    }
  } catch (err) {
    showError(err);
  }
}

function track(name) {
  axios.post('/t', { name });
}

function showError(err) {
  console.error(err);
}
`,
  'web/src/api.ts': `export async function request(path: string, body: unknown) {
  return fetch(path, { method: 'POST', body: JSON.stringify(body) });
}
`,
  'services/auth/api.py': `def login(data):
    user = check(data)
    if not user:
        raise HTTPException(401)
    return {"ok": True}


def check(data):
    return data
`,
};
const ROUTE: GraphSymbol = { id: 'route:services/auth/api.py:1:POST:/auth/login', name: 'POST /auth/login', kind: 'route', file: 'services/auth/api.py', line: 1 };
const LAYERS: GraphLayers = { config: null, errors: [],
  services: [{ id: 'web', label: 'web', aliases: [], origin: 'manifest', modules: [{ id: '(root)', label: '(root)' }] },
    { id: 'auth', label: 'auth', aliases: [], origin: 'compose', modules: [{ id: '(root)', label: '(root)' }] }],
  assignments: { 'web/src/Login.tsx': { service: 'web', module: '(root)' }, 'web/src/api.ts': { service: 'web', module: '(root)' }, 'services/auth/api.py': { service: 'auth', module: '(root)' } } };
const webGraph = () => fakeGraph(WEB, ['submit>request', 'submit>track', 'submit>showError', 'login>check'], {
  symbols: [ROUTE], layers: LAYERS,
  relations: [
    { from: 'web/src/Login.tsx#submit', to: ROUTE.id, kind: 'calls', line: 7, certain: false, meta: { channel: 'http', method: 'POST', href: '/auth/login', callee: 'request' } },
    { from: ROUTE.id, to: 'services/auth/api.py#login', kind: 'references', line: 1, certain: true },
  ] });

test('sequence tsx: http hop to the route handler, service participants, actor trigger, try/catch and opt fragments', async () => {
  const out = await run(WEB, webGraph(), { start: { symbol: 'submit', file: 'web/src/Login.tsx' }, trigger: 'click Sign in' });
  assert.equal(out.diagnostics.sequence!.participants, 'service');
  assert.deepEqual(out.diagnostics.sequence!.links, { http: 1 });
  assert.deepEqual(out.text, [
    'participants: User (actor), web, auth, External HTTP (external)',
    'User -> web: click Sign in',
    'try',
    '  web -> auth: POST /auth/login',
    '  note auth: can fail: http exception',
    '  auth --> web: response',
    '    opt result ok',
    '      web -> External HTTP: post',
    '    end',
    'end',
  ]);
  const hop = out.seq.messages[1];
  assert.deepEqual([hop.kind, hop.link, hop.certain, hop.symbol!.name], ['http', 'http', true, 'login']);
  assert.equal(out.seq.participants[0].id, 'actor');
  // The `request` client function on the same line is not followed: the route hop replaces the call.
  assert.ok(!out.seq.messages.some(m => m.label === 'request'));

  const noHttp = await run(WEB, webGraph(), { start: { symbol: 'submit' }, links: [] });
  // One service and module left: file lifelines; request() is followed into fetch instead.
  assert.deepEqual(noHttp.seq.participants.map(p => p.label), ['Login.tsx', 'api.ts', 'External HTTP']);
  assert.deepEqual(noHttp.seq.messages.map(m => [m.kind, m.label]), [['call', 'request'], ['call', 'fetch'], ['return', ''], ['call', 'post']]);
});

test('sequence: start.route resolves to its handler; start errors', async () => {
  const graph = webGraph();
  const route = await run(WEB, graph, { start: { route: 'post  /auth/login' } });
  assert.equal(route.diagnostics.sequence!.start, 'POST /auth/login -> login (services/auth/api.py:1)');
  assert.equal(route.diagnostics.sequence!.error, null);
  const errors = await Promise.all([
    run(WEB, graph, { start: { route: 'GET /nope' } }), run(WEB, graph, { start: { symbol: 'nope' } }),
    run(WEB, graph, { start: { symbol: 'POST /auth/login' } }),
  ]);
  assert.deepEqual(errors.map(e => e.diagnostics.sequence!.error), ['start route not found: GET /nope', 'start symbol not found: nope',
    'start symbol POST /auth/login is a route, not a function or method']);
  const twice = { 'a.py': 'def f():\n    g()\n', 'b.py': 'def f():\n    g()\n' };
  const ambiguous = await run(twice, fakeGraph(twice, []), { start: { symbol: 'f' } });
  assert.match(ambiguous.diagnostics.sequence!.error!, /^ambiguous start symbol f: add a file \(a\.py:1, b\.py:1\)$/);
  const go = { 'main.go': 'func main() {}\n' };
  const unsupported = await run(go, { ...fakeGraph({}, []), findSymbols: () => [{ id: 'm', name: 'main', kind: 'function', file: 'main.go', line: 1 }] }, { start: { symbol: 'main' } });
  assert.equal(unsupported.diagnostics.sequence!.error, 'sequence does not support go files yet');
  const noGraph = await evaluate({ view: { id: 's', kind: 'sequence', scope: { include: ['**/*'], exclude: [] }, rules: [], graph: null, flowchart: null, builtins: [], include: [], exclude: [],
    sequence: step({ start: { symbol: 'f' } }) }, graph: null, graphStatus: { state: 'indexing', message: null }, grammarDir, files: { list: async () => ({ files: [], truncated: false }), read: async () => null } });
  assert.equal(noGraph.diagnostics.sequence!.error, 'code graph not ready (indexing)');
});

test('sequence: recursion is drawn once and not followed; nested fragments keep their parent', async () => {
  const files = { 'tree.py': `def walk(node):
    for child in node.children:
        if child.leaf:
            jwt.decode(child)
        else:
            walk(child)
`.replace(/^/, 'import jwt\n\n') };
  const out = await run(files, fakeGraph(files, ['walk>walk']), { start: { symbol: 'walk' }, internal: 'show' });
  assert.deepEqual(out.seq.messages.map(m => [m.kind, m.label]), [['call', 'decode'], ['self', 'walk (recursive)']]);
  assert.deepEqual(out.seq.fragments.map(f => [f.id, f.kind, f.parent, f.branches.map(b => b.label)]), [['f0', 'loop', null, []], ['f1', 'alt', 'f0', ['else']]]);
});

test('sequence: message and participant caps set truncated with a warning', async () => {
  const many = { 'big.py': `import jwt\n\n\ndef run():\n${Array.from({ length: 450 }, (_, i) => `    jwt.encode(${i})`).join('\n')}\n` };
  const capped = await run(many, fakeGraph(many, []), { start: { symbol: 'run' } });
  assert.equal(capped.seq.messages.length, 400);
  assert.equal(capped.truncated, true);
  assert.equal(capped.diagnostics.sequence!.truncated, true);
  assert.match(capped.warnings.at(-1)!.message, /lower the depth or exclude files/);
  const wide = { 'wide.py': `def run():\n${Array.from({ length: 35 }, (_, i) => `    sys${i}.go()`).join('\n')}\n` };
  const externals = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`sys${i}`, `System ${i}`]));
  const out = await run(wide, fakeGraph(wide, []), { start: { symbol: 'run' }, externals });
  assert.equal(out.seq.participants.length, 30);
  assert.equal(out.truncated, true);
});

test('sequence: a walk stopped at the event cap inside fragments still closes them', async () => {
  const files = { 'loop.py': `import jwt\n\n\ndef run(xs):\n    for x in xs:\n        if x:\n${Array.from({ length: 30 }, (_, i) => `            jwt.encode(${i})`).join('\n')}\n` };
  const events = SEQUENCE_LIMITS.events;
  SEQUENCE_LIMITS.events = 12;
  try {
    const out = await run(files, fakeGraph(files, []), { start: { symbol: 'run' } });
    assert.equal(out.truncated, true);
    const last = out.seq.messages.length - 1;
    assert.deepEqual(out.seq.fragments.map(f => [f.kind, f.first, f.last, f.parent]), [['loop', 0, last, null], ['opt', 0, last, 'f0']]);
  } finally { SEQUENCE_LIMITS.events = events; }
});

const YAML = (body: string) => `version: 1\nname: Login\nkind: sequence\n${body}`;
const parseError = (text: string) => {
  try { parseViewYaml(text, 'v.yaml'); } catch (e) { assert.ok(e instanceof YamlError); return e.message; }
  assert.fail('expected a YamlError');
};

test('sequence schema: defaults, kind <-> section, exclusive sections, start, depth, links, link rules', () => {
  const v = parseViewYaml(YAML('sequence:\n  start: { symbol: submit, file: web/a.tsx }\n  externals: { stripe: Stripe }\n'), 'v.yaml');
  assert.deepEqual(v.sequence, { start: { symbol: 'submit', file: 'web/a.tsx' }, actor: 'User', depth: 3, participants: 'auto', internal: 'collapse', returns: true,
    links: ['http', 'auth', 'langgraph', 'events', 'ipc'], externals: { stripe: 'Stripe' } });
  assert.deepEqual(parseViewYaml(YAML('sequence:\n  start: { route: "POST /x" }\n  links: [http, http]\n'), 'v.yaml').sequence!.links, ['http']);
  const rule = 'rules:\n  - id: rpc\n    language: python\n    query: "(call) @c"\n    emit: { edge: { from: "@c", to: handler, kind: link } }\n';
  assert.equal(parseViewYaml(YAML(`sequence:\n  start: { symbol: f }\n${rule}`), 'v.yaml').rules.length, 1);
  assert.match(parseError(YAML('')), /kind: sequence needs a sequence: section/);
  assert.match(parseError('version: 1\nname: x\nkind: graph\nsequence:\n  start: { symbol: f }\n'), /sequence: needs kind: sequence/);
  for (const key of ['use: [x]', 'graph:\n  start: [{ symbol: f }]\n  follow: [calls]', 'flowchart:\n  start: { symbol: f }', 'layers: {}']) {
    assert.match(parseError(YAML(`sequence:\n  start: { symbol: f }\n${key}\n`)), /cannot be combined with kind: sequence|needs kind: (flowchart|graph)/, key);
  }
  assert.match(parseError(YAML('sequence:\n  start: { symbol: f, route: "GET /" }\n')), /start needs exactly one of symbol, route or ipc/);
  assert.match(parseError(YAML('sequence:\n  start: { route: "GET /", ipc: git.x }\n')), /start needs exactly one of symbol, route or ipc/);
  assert.match(parseError(YAML('sequence:\n  start: { file: a.py }\n')), /start needs exactly one of symbol, route or ipc/);
  assert.equal(parseViewYaml(YAML('sequence:\n  start: { ipc: git.createWorkspace }\n'), 'v.yaml').sequence!.start.ipc, 'git.createWorkspace');
  assert.match(parseError(YAML('sequence:\n  start: { symbol: f }\n  depth: 7\n')), /depth/);
  assert.match(parseError(YAML('sequence:\n  start: { symbol: f }\n  links: [grpc]\n')), /links/);
  assert.match(parseError(YAML('sequence:\n  start: { symbol: f }\n  participants: team\n')), /participants/);
  assert.match(parseError(YAML('sequence:\n  start: { symbol: f }\n  extra: 1\n')), /extra/);
  assert.match(parseError(YAML(`sequence:\n  start: { symbol: f }\n${rule.replace('kind: link', 'kind: calls')}`)), /must emit edge: \{ from, to, kind: link \}/);
  assert.match(parseError(YAML(`sequence:\n  start: { symbol: f }\n${rule.replace('edge: { from: "@c", to: handler, kind: link }', 'node: { id: "@c" }')}`)), /must emit edge/);
});

test('formatText sequence: spec format with links, uncertain marks, notes-only arms, returns and nested indent', () => {
  const p = (id: string, label: string, kind: 'actor' | 'participant' | 'external' = 'participant', column = 0) =>
    ({ id, label, kind, subtitle: null, column, source: null, symbol: null });
  const m = (from: string, to: string, label: string, level: number, extra: object = {}) =>
    ({ from, to, kind: 'call' as const, label, detail: null, level, certain: true, link: null, source: null, symbol: null, ...extra });
  const messages = [
    m('actor', 'web', 'click Sign in', 0), m('web', 'auth', 'POST /auth/login', 0, { kind: 'http', link: 'http' }),
    m('auth', 'auth', 'get current user', 1, { kind: 'link', link: 'auth', certain: false }), m('auth', 'cognito', 'initiate auth', 1),
    m('cognito', 'auth', 'tokens', 1, { kind: 'return' }), m('auth', 'web', 'response', 0, { kind: 'return' }),
  ].map((x, i) => ({ ...x, id: `m${i}` }));
  const text = formatText({ kind: 'sequence', groups: [], nodes: [], edges: [], truncated: false, sequence: {
    participants: [p('actor', 'User', 'actor'), p('web', 'web'), p('auth', 'auth'), p('cognito', 'Cognito', 'external')], messages,
    fragments: [{ id: 'f0', kind: 'alt', label: 'user active?', first: 3, last: 4, branches: [{ label: 'else', first: 5 }], parent: null, source: null }],
    notes: [{ id: 'n0', participant: 'auth', after: 4, text: 'error: HTTPException', kind: 'error', source: null, fragment: 'f0', arm: 1 }],
  } });
  assert.equal(text, [
    'sequence: 4 participants, 6 messages',
    'participants: User (actor), web, auth, Cognito (external)',
    'User -> web: click Sign in',
    'web -> auth: POST /auth/login',
    '  auth -> auth: get current user  [link auth]  (uncertain)',
    '  alt user active?',
    '    auth -> Cognito: initiate auth',
    '    Cognito --> auth: tokens',
    '  else',
    '    note auth: error: HTTPException',
    '  end',
    'auth --> web: response',
  ].join('\n'));
  assert.equal(formatText({ kind: 'sequence', groups: [], nodes: [], edges: [], truncated: false }), 'sequence: not computed');
});

test('sequence externals: file imports (python, ts, require), relative imports stay in the repo, view externals win', async () => {
  const { Parser, Language } = await import('web-tree-sitter');
  const { initTreeSitter, GRAMMAR_FILES } = await import('../../electron/app/wiring/views');
  const { fileImports, externalCall } = await import('../../electron/app/wiring/views');
  const path = await import('node:path');
  await initTreeSitter();
  const parse = async (language: string, text: string) => {
    const parser = new Parser();
    parser.setLanguage(await Language.load(path.join(grammarDir, GRAMMAR_FILES[language])));
    const tree = parser.parse(text)!;
    return fileImports(tree.rootNode);
  };
  const py = await parse('python', 'import boto3\nimport os.path as p\nfrom jose import jwt as j\nfrom . import store\nfrom sqlalchemy.orm import Session\n');
  assert.deepEqual([...py], [['boto3', 'boto3'], ['p', 'os.path'], ['j', 'jose.jwt'], ['store', '..store'], ['Session', 'sqlalchemy.orm.Session']]);
  const ts = await parse('typescript', "import axios from 'axios';\nimport * as S from '@aws-sdk/client-s3';\nimport { a, b as c } from './local';\nconst { sign } = require('jsonwebtoken');\nconst pg = require('pg');\n");
  assert.deepEqual([...ts], [['axios', 'axios'], ['S', '@aws-sdk/client-s3'], ['a', './local'], ['c', './local'], ['sign', 'jsonwebtoken'], ['pg', 'pg']]);
  const call = (path: string) => ({ callee: path.split('.').at(-1)!, line: 1, awaited: false, outer: true, chained: false, path });
  assert.deepEqual([call('boto3.client'), call('j.encode'), call('store.save'), call('S.send'), call('sign'), call('requests.get'), call('self.client.initiate_auth'), call('local')]
    .map(c => externalCall(c, new Map([...py, ...ts]), { 'self.client': 'Cognito' })), ['AWS', 'JWT', null, 'AWS', 'JWT', 'External HTTP', 'Cognito', null]);
});

test('sequence notes: raises of the entry (also outside fragments) and of functions whose call is drawn; not of collapsed helpers', async () => {
  const files = { 'e.py': 'def run():\n    helper()\n    raise ValueError("x")\n\n\ndef helper():\n    raise KeyError()\n' };
  const out = await run(files, fakeGraph(files, ['run>helper']), { start: { symbol: 'run' } });
  assert.deepEqual(out.seq.notes.map(n => [n.text, n.after, n.fragment ?? null]), [['can fail: value error', -1, null]]);
  assert.deepEqual(out.text, ['participants: e.py', 'note e.py: can fail: value error']);
  const shown = await run(files, fakeGraph(files, ['run>helper']), { start: { symbol: 'run' }, internal: 'show' });
  assert.deepEqual(shown.seq.notes.map(n => n.text), ['can fail: key error', 'can fail: value error']);
});
