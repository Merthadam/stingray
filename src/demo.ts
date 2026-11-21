import type { DesktopAPI, State, TerminalInfo, TerminalEvent, RepoFile } from './shared';
import type { DbColumn, DbSchemaResult } from './db-schema';
import type { DiagramEdge, DiagramNode, EditorSettings, SaveViewInput, SequenceData, SequenceMessage, SequenceParticipant, ViewDiagnostics, ViewLocalState, ViewResult, ViewSummary } from './views';
import { DATABASE_VIEW, databaseView } from './views-database';
const repoId = '00000000-0000-4000-8000-000000000001';
const mainId = '00000000-0000-4000-8000-000000000002';
const demoContent = (path: string) => path.endsWith('.tsx') ? 'export function Button() {\n  return <button className="primary">Continue</button>;\n}\n' : '// Simulated file contents for the browser demo.\n';
const demoFiles: RepoFile[] = [
  { path: 'src/App.tsx', status: ' M' }, { path: 'src/styles.css', status: ' M' },
  { path: 'src/components/Button.tsx', status: ' M' }, { path: 'src/components/Dialog.tsx', status: '??' },
  { path: 'src/components/Sidebar.tsx', status: '' }, { path: 'src/hooks/useWorkspace.ts', status: '' },
  { path: 'src/legacy.ts', status: ' D' }, { path: 'src/main.tsx', status: '' },
  { path: 'electron/main.ts', status: '' }, { path: 'electron/git.ts', status: ' M' },
  { path: 'electron/preload.ts', status: '' }, { path: 'tests/git.test.ts', status: '??' },
  { path: 'tests/navigation.test.ts', status: '' }, { path: 'public/stingray.svg', status: '' },
  { path: 'src/conflict.ts', status: 'UU' }, { path: 'assets/binary.png', status: '??' },
  ...Array.from({ length: 160 }, (_, i) => ({ path: `src/features/feature-${Math.floor(i / 12)}/module-${i}.ts`, status: i % 13 === 0 ? ' M' : '' })),
  { path: 'README.md', status: '' }, { path: 'package.json', status: '' }, { path: 'tsconfig.json', status: '' },
].map((file, i) => ({ ...file, size: file.path.endsWith('.png') ? { state: 'unavailable' as const, source: 'working tree' as const, reason: 'Synthetic binary fixture' } : { state: 'known' as const, textLines: 10 + (i * 97 % 700), source: file.status.includes('D') ? 'HEAD' as const : 'working tree' as const }, lines: {
  added: file.status && !file.status.includes('D') ? demoContent(file.path).split('\n').length - 1 : 0,
  removed: file.status && file.status !== '??' ? 1 : 0,
} }));
const column = (name: string, type: string | null, line: number, extra: Partial<DbColumn> = {}): DbColumn =>
  ({ name, attribute: name, type, primaryKey: false, nullable: true, unique: false, foreignKeys: [], inheritedFrom: null, line, ...extra });
const fk = (target: string, targetTable: string | null, ondelete: string | null = null) => [{ target, targetTable, ondelete }];
const timestamps = [column('created_at', 'DateTime', 9, { nullable: false, inheritedFrom: 'TimestampMixin' }), column('updated_at', 'DateTime', 10, { nullable: null, inheritedFrom: 'TimestampMixin' })];
const demoDbSchema = (workspaceId: string): DbSchemaResult => ({
  workspaceId, scannedAt: Date.now(), filesScanned: 48, filesParsed: 6, truncated: false,
  groups: [{
    id: 'app/db/base.py:Base', name: 'Base', file: 'app/db/base.py', line: 7, tables: [
      { name: 'memberships', schema: null, fullName: 'memberships', model: 'Membership', file: 'app/models/organization.py', line: 31, columns: [
        column('user_id', 'Uuid', 33, { primaryKey: true, nullable: false, foreignKeys: fk('users.id', 'users', 'CASCADE') }),
        column('organization_id', 'Uuid', 34, { primaryKey: true, nullable: false, foreignKeys: fk('organizations.id', 'organizations', 'CASCADE') }),
        column('role', 'String(32)', 35, { nullable: false }), ...timestamps,
      ], relationships: [] },
      { name: 'organizations', schema: null, fullName: 'organizations', model: 'Organization', file: 'app/models/organization.py', line: 12, columns: [
        column('id', 'Uuid', 14, { primaryKey: true, nullable: false }), column('slug', 'String(64)', 15, { nullable: false, unique: true }),
        column('display_name', 'String(255)', 16, { nullable: false }), ...timestamps,
      ], relationships: [{ name: 'members', targetModel: 'User', targetTable: 'users', collection: true, backPopulates: 'organizations', secondary: 'memberships', line: 18 }] },
      { name: 'posts', schema: null, fullName: 'posts', model: 'Post', file: 'app/models/post.py', line: 9, columns: [
        column('id', 'Integer', 11, { primaryKey: true, nullable: false }),
        column('author_id', 'Uuid', 12, { nullable: false, foreignKeys: fk('users.id', 'users', 'SET NULL') }),
        column('legacy_category_id', 'Integer', 13, { foreignKeys: fk('categories.id', null) }),
        { ...column('body', 'Text', 14), attribute: 'content' }, ...timestamps,
      ], relationships: [{ name: 'author', targetModel: 'User', targetTable: 'users', collection: false, backPopulates: 'posts', secondary: null, line: 16 }] },
      { name: 'users', schema: null, fullName: 'users', model: 'User', file: 'app/models/user.py', line: 10, columns: [
        column('id', 'Uuid', 12, { primaryKey: true, nullable: false }), column('email', 'String(320)', 13, { nullable: false, unique: true }),
        column('name', 'String(120)', 14), column('is_active', null, 15, { nullable: null, unique: null }), ...timestamps,
      ], relationships: [
        { name: 'posts', targetModel: 'Post', targetTable: 'posts', collection: true, backPopulates: 'author', secondary: null, line: 17 },
        { name: 'organizations', targetModel: 'Organization', targetTable: 'organizations', collection: true, backPopulates: 'members', secondary: 'memberships', line: 18 },
        { name: 'sessions', targetModel: null, targetTable: null, collection: null, backPopulates: null, secondary: null, line: 19 },
      ] },
    ],
  }, {
    id: 'analytics/models.py:AnalyticsBase', name: 'AnalyticsBase', file: 'analytics/models.py', line: 5, tables: [
      { name: 'events', schema: 'analytics', fullName: 'analytics.events', model: 'Event', file: 'analytics/models.py', line: 9, columns: [
        column('id', 'BigInteger', 11, { primaryKey: true, nullable: false }), column('name', 'String(80)', 12, { nullable: false }),
        column('session_id', 'Uuid', 13, { foreignKeys: fk('analytics.sessions.id', 'analytics.sessions') }), column('payload', 'JSON', 14),
      ], relationships: [{ name: 'session', targetModel: 'Session', targetTable: 'analytics.sessions', collection: false, backPopulates: null, secondary: null, line: 16 }] },
      { name: 'sessions', schema: 'analytics', fullName: 'analytics.sessions', model: 'Session', file: 'analytics/models.py', line: 19, columns: [
        column('id', 'Uuid', 21, { primaryKey: true, nullable: false }), column('started_at', 'DateTime', 22, { nullable: false }),
      ], relationships: [] },
    ],
  }],
  warnings: [{ file: 'app/models/user.py', line: 15, message: 'Column type is computed at runtime; shown as unknown.' }],
});
// Sample views for the browser demo: a repo tables view, a flow with diagnostics and an invalid view file. Deterministic.
const repoViews = (): ViewSummary[] => [
  { id: 'core', name: 'Core tables', kind: 'tables', description: 'Users, organizations and memberships', builtin: false, file: '.stingray/views/core.yaml', error: null },
  { id: 'agent-flow', name: 'Agent flow', kind: 'flow', description: 'LangGraph steps of the agent', builtin: false, file: '.stingray/views/agent-flow.yaml', error: null },
  { id: 'login', name: 'Login', kind: 'sequence', description: 'What happens when a user signs in', builtin: false, file: '.stingray/views/login.yaml', error: null },
  { id: 'broken', name: 'broken.yaml', kind: 'tables', description: '', builtin: false, file: '.stingray/views/broken.yaml',
    error: 'line 3: kind: must be one of tables, flow, timeline, graph' },
];
const savedViews = new Map<string, { summary: ViewSummary; input: SaveViewInput }>();
const viewStates = new Map<string, ViewLocalState>();
let editor: EditorSettings = { selected: 'vscode', available: ['repo-map', 'vscode', 'cursor', 'system'] };
const CORE_TABLES = new Set(['users', 'organizations', 'memberships']);
const demoDiagnostics = (extra: Partial<ViewDiagnostics> = {}): ViewDiagnostics =>
  ({ rules: [], graph: null, unresolved: [], limits: { filesScanned: 48, matches: 0, truncated: false }, ms: 42, ...extra });
const flowNode = (id: string, label: string, line: number, extra: Partial<DiagramNode> = {}): DiagramNode => ({
  id: `agent/graph/builder.py:builder:${id}`, label, kind: 'step', subtitle: null, group: 'agent/graph/builder.py:builder', fields: [],
  source: { file: 'agent/graph/builder.py', line }, symbol: null, role: null, order: null, detail: null, ...extra,
});
const flowEdge = (from: string, to: string, line: number, extra: Partial<DiagramEdge> = {}): DiagramEdge => ({
  id: `${from}->${to}`, from: `agent/graph/builder.py:builder:${from}`, to: `agent/graph/builder.py:builder:${to}`, fromField: null, toField: null,
  kind: 'next', style: 'solid', certain: true, label: null, source: { file: 'agent/graph/builder.py', line }, ...extra,
});
const branch = { kind: 'branch', style: 'dashed', certain: false } as const;
// Login flow as a sequence: the browser form -> auth service -> Postgres / Cognito, with alt, loop, opt and an error note.
const participant = (id: string, label: string, kind: SequenceParticipant['kind'], column: number, subtitle: string | null, file?: string, line = 1, explanation?: string): SequenceParticipant =>
  ({ id, label, kind, subtitle, column, source: file ? { file, line } : null, symbol: null, explanation });
let messageRow = 0;
const message = (from: string, to: string, kind: SequenceMessage['kind'], label: string, level: number, line: number | null, extra: Partial<SequenceMessage> = {}): SequenceMessage => ({
  id: `m${messageRow++}`, from, to, kind, label, detail: null, level, certain: true, link: null,
  source: line === null ? null : { file: from === 'p:service:web' ? 'frontend/src/LoginForm.tsx' : 'services/auth/login.py', line }, symbol: null, ...extra,
});
function demoLoginSequence(): SequenceData {
  messageRow = 0;
  const web = 'p:service:web', auth = 'p:service:auth', db = 'ext:postgres', cognito = 'ext:cognito', segment = 'ext:segment';
  return {
    participants: [
      participant('actor', 'User', 'actor', 0, null),
      participant(web, 'web', 'participant', 1, 'service', 'frontend/src/LoginForm.tsx', 42, 'The sign-in form: validates input, calls the auth service and stores the session.'),
      participant(auth, 'auth', 'participant', 2, 'service', 'services/auth/login.py', 18, 'Authenticates users against Cognito and issues sessions.'),
      participant(db, 'Postgres', 'external', 3, 'external'),
      participant(cognito, 'Cognito', 'external', 4, 'external'),
      participant(segment, 'Segment', 'external', 5, 'external'),
    ],
    messages: [
      message('actor', web, 'call', 'click Sign in', 0, 42),
      message(web, web, 'self', 'validateForm', 0, 44, { detail: 'if (!validateForm(values)) return' }),
      message(web, auth, 'http', 'POST /auth/login', 0, 47, { link: 'http', detail: 'await api.post("/auth/login", values)' }),
      message(auth, auth, 'link', 'rate_limit', 1, 18, { link: 'auth', detail: 'Depends(rate_limit)' }),
      message(auth, db, 'call', 'find_user_by_email', 1, 24, { detail: 'user = await users.find_by_email(body.email)' }),
      message(db, auth, 'return', 'User | None', 1, 24),
      message(auth, cognito, 'call', 'initiate_auth', 1, 27, { detail: 'cognito.initiate_auth(AuthFlow="USER_PASSWORD_AUTH", ...)' }),
      message(cognito, auth, 'return', 'tokens', 1, 27),
      message(auth, db, 'call', 'load_permissions', 1, 30),
      message(db, auth, 'return', 'permissions', 1, 30),
      message(auth, auth, 'self', 'issue_session', 1, 33),
      message(auth, web, 'return', 'response', 0, 47),
      message(web, segment, 'call', "track('login')", 0, 50, { certain: false, detail: 'analytics.track("login")' }),
      message(web, web, 'self', "navigate('/dashboard')", 0, 51),
    ],
    fragments: [
      { id: 'f0', kind: 'alt', label: 'user and user.is_active', first: 6, last: 10, branches: [{ label: 'else', first: 11 }], parent: null, source: { file: 'services/auth/login.py', line: 26 } },
      { id: 'f1', kind: 'loop', label: 'for each role in user.roles', first: 8, last: 9, branches: [], parent: 'f0', source: { file: 'services/auth/login.py', line: 29 } },
      { id: 'f2', kind: 'opt', label: 'response.ok', first: 12, last: 13, branches: [], parent: null, source: { file: 'frontend/src/LoginForm.tsx', line: 49 } },
    ],
    notes: [{ id: 'n0', participant: auth, after: 10, text: 'error: HTTPException 401', kind: 'error', source: { file: 'services/auth/login.py', line: 36 }, fragment: 'f0', arm: 1 }],
  };
}
function demoView(workspaceId: string, viewId: string, depth?: number): ViewResult {
  const saved = savedViews.get(viewId);
  if (saved) {
    const base = demoView(workspaceId, saved.input.basedOn), excluded = new Set(saved.input.exclude);
    const nodes = base.nodes.filter(n => !excluded.has(n.label)), ids = new Set(nodes.map(n => n.id));
    return { ...base, ...saved.summary, nodes, edges: base.edges.filter(e => ids.has(e.from) && ids.has(e.to)), layout: saved.input.layout ?? base.layout };
  }
  if (viewId === DATABASE_VIEW.id) return databaseView(demoDbSchema(workspaceId));
  const summary = repoViews().find(v => v.id === viewId);
  if (!summary || summary.error) throw new Error(summary ? summary.error! : `Unknown view: ${viewId}`);
  if (viewId === 'login') {
    const sequence = demoLoginSequence();
    const nodes = sequence.participants.map((p): DiagramNode => ({ id: p.id, label: p.label, kind: p.kind, subtitle: p.subtitle, group: null, fields: [],
      source: p.source, symbol: p.symbol, role: null, order: p.column, detail: null, explanation: p.explanation }));
    return { ...summary, workspaceId, computedAt: Date.now(), truncated: false, layout: null, groups: [], nodes, edges: [], warnings: [],
      stats: { messages: sequence.messages.length }, graph: { state: 'ready', message: null }, sequence,
      diagnostics: demoDiagnostics({ sequence: { start: 'submit (frontend/src/LoginForm.tsx:42)', depth: depth ?? 3, participants: 'service', functions: 9,
        messages: sequence.messages.length, links: { http: 1, auth: 1 }, truncated: false, error: null } }) };
  }
  if (viewId === 'core') {
    const db = databaseView(demoDbSchema(workspaceId));
    const nodes = db.nodes.filter(n => CORE_TABLES.has(n.label)), ids = new Set(nodes.map(n => n.id));
    return { ...db, ...summary, nodes, groups: db.groups.filter(g => nodes.some(n => n.group === g.id)), edges: db.edges.filter(e => ids.has(e.from) && ids.has(e.to)),
      diagnostics: demoDiagnostics({ limits: { filesScanned: 12, matches: 0, truncated: false } }) };
  }
  const nodes = [
    flowNode('START', 'START', 12, { kind: 'terminal', role: 'start' }), flowNode('chat', 'chat', 9, { detail: 'ConversationNode(adapter)' }),
    flowNode('plan', 'plan', 10, { detail: 'plan_node' }), flowNode('summarize', 'summarize', 11, { detail: 'summarize' }),
    flowNode('END', 'END', 18, { kind: 'terminal', role: 'end' }),
  ];
  const edges = [
    flowEdge('START', 'chat', 12, { ...branch, label: 'else' }), flowEdge('START', 'plan', 12, { ...branch, label: '1. needs_plan' }),
    flowEdge('plan', 'summarize', 17, { ...branch, label: 'done' }), flowEdge('plan', 'plan', 17, { ...branch, label: 'retry' }),
    flowEdge('chat', 'END', 18), flowEdge('summarize', 'END', 19),
  ];
  const rule = (id: string, matches: number, emitted: number, ms: number) =>
    ({ rule: `builtin/langgraph#${id}`, language: 'python', filesScanned: 31, matches, emitted, skipped: 0, errors: [], warnings: [], ms });
  return {
    ...summary, workspaceId, computedAt: Date.now(), truncated: false, layout: null,
    groups: [{ id: 'agent/graph/builder.py:builder', label: 'builder', source: { file: 'agent/graph/builder.py', line: 8 } }], nodes, edges,
    warnings: [], stats: { filesScanned: 31, nodes: nodes.length, edges: edges.length }, graph: { state: 'ready', message: null },
    diagnostics: demoDiagnostics({
      rules: [rule('nodes', 3, 3, 14), rule('edges', 2, 2, 9), rule('conditional-edges', 4, 4, 11),
        { ...rule('send', 0, 0, 3), warnings: [{ file: '.stingray/views/agent-flow.yaml', line: 6, message: 'Rule matched nothing in 31 files' }] }],
      unresolved: [{ rule: 'builtin/langgraph#edges', value: 'route_after_plan', file: 'agent/graph/builder.py', line: 17 }],
      limits: { filesScanned: 31, matches: 9, truncated: false }, ms: 37,
    }),
  };
}
const initial: State = {
  version: 1, repos: [{ id: repoId, name: 'stingray', path: '/demo/stingray' }],
  workspaces: [
    { id: mainId, repoId, name: 'main', branch: 'main', path: '/demo/stingray', managed: false, previewUrl: '' },
    { id: '00000000-0000-4000-8000-000000000003', repoId, name: 'feature/browser', branch: 'feature/browser', path: '/demo/browser', managed: true, previewUrl: '' },
  ],
};
let state = structuredClone(initial);
try { const saved = localStorage.getItem('stingray-demo-v1'); if (saved) { const { stateSchema } = await import('./shared'); state = stateSchema.parse(JSON.parse(saved)); } } catch { /* Invalid demo data is disposable; desktop data never uses this adapter. */ }
let terminalList: TerminalInfo[] = [];
const listeners = new Set<(event: TerminalEvent) => void>();
const snapshot = () => structuredClone(state);
const save = () => { localStorage.setItem('stingray-demo-v1', JSON.stringify(state)); return snapshot(); };
export const demoAPI: DesktopAPI = {
  mode: 'demo',
  state: async () => snapshot(),
  pickRepository: async () => { throw new Error('Native folder selection is available in the desktop app. This is a simulated browser demo.'); },
  openRepository: async () => { throw new Error('Real repositories require the desktop app. Demo workspaces are simulated.'); },
  pickCloneParent: async () => { throw new Error('Folder selection requires the desktop app. No files were changed.'); },
  cloneRepository: async () => { throw new Error('Cloning requires the desktop app. No repository was downloaded or added in this browser demo.'); },
  createWorkspace: async (id, branch) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/.test(branch) || branch.includes('..') || branch.endsWith('/')) throw new Error('Enter a valid branch name.');
    if (state.workspaces.some(w => w.branch === branch)) throw new Error('This branch already exists.');
    if (state.workspaces.length >= 20) throw new Error('Demo workspace limit reached.');
    state.workspaces.push({ id: crypto.randomUUID(), repoId: id, name: branch, branch, path: '/demo/' + branch, managed: true, previewUrl: '' }); return save();
  },
  reviewRemoval: async id => {
    const w = state.workspaces.find(w => w.id === id);
    if (!w?.managed) throw new Error('Only managed worktrees can be removed.');
    return { branch: w.branch, blockers: [], terminals: terminalList.filter(t => t.workspaceId === id).length, changes: { tracked: 0, untracked: 0, paths: [] }, merged: null, push: { kind: 'unknown', message: 'Simulated demo: push status is unknown. No real Git check was performed.' } };
  },
  removeWorkspace: async id => {
    const w = state.workspaces.find(w => w.id === id);
    if (!w?.managed) throw new Error('Only managed worktrees can be removed.');
    terminalList = terminalList.filter(t => t.workspaceId !== id);
    state.workspaces = state.workspaces.filter(w => w.id !== id); return { state: save() };
  },
  gitStatus: async id => ({ lines: { kind: 'available' as const, added: id === mainId ? 8 : 124, deleted: id === mainId ? 2 : 36, binaryFiles: 0 }, branch: state.workspaces.find(w => w.id === id)?.branch || 'unknown', changes: demoFiles.filter(file => file.status) }),
  repoSnapshot: async id => ({
    lines: { kind: 'available' as const, added: id === mainId ? 8 : 124, deleted: id === mainId ? 2 : 36, binaryFiles: 0 },
    branch: state.workspaces.find(w => w.id === id)?.branch || 'unknown',
    changes: demoFiles.filter(file => file.status),
    files: demoFiles,
    statsNotice: 'Simulated demo counts, not a real repository. Desktop counts use Git.',
  }),
  inspectFile: async (_id, path) => {
    const file = demoFiles.find(file => file.path === path);
    if (!file) throw new Error('Demo file not found.');
    const content = file.status.includes('D') ? '// Previous version\n' : demoContent(path);
    const { added, removed } = file.lines!;
    return { path, content, source: file.status.includes('D') ? 'HEAD' : 'working tree', staged: '',
      unstaged: file.status ? `--- ${removed ? 'a/' + path : '/dev/null'}\n+++ ${added ? 'b/' + path : '/dev/null'}\n@@ -${removed ? 1 : 0},${removed} +${added ? 1 : 0},${added} @@\n` + (removed ? '-// Previous version\n' : '') + (added ? content.trimEnd().split('\n').map(line => '+' + line).join('\n') + '\n' : '') : '',
      notice: file.status.includes('D') ? 'Deleted file · showing simulated HEAD contents.' : '',
      revision: 'demo-' + path,
    };
  },
  // Fixed sample schema: the browser demo never reads or parses repository files.
  dbSchema: async id => { await new Promise(resolve => setTimeout(resolve, 400)); return demoDbSchema(id); },
  views: async () => [DATABASE_VIEW, ...repoViews(), ...[...savedViews.values()].map(v => v.summary)],
  view: async (id, viewId, options) => { await new Promise(resolve => setTimeout(resolve, 400)); return demoView(id, viewId, options?.depth); },
  viewState: async (id, viewId) => structuredClone(viewStates.get(`${id}:${viewId}`) ?? null),
  saveViewState: async (id, viewId, local) => { viewStates.set(`${id}:${viewId}`, structuredClone(local)); },
  saveViewAs: async (_id, input) => {
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!slug) throw new Error('Use letters or digits in the view name.');
    const file = `.stingray/views/${slug}.yaml`;
    if (slug === DATABASE_VIEW.id || repoViews().some(v => v.id === slug) || savedViews.has(slug)) throw new Error(`${file} already exists. Choose another name.`);
    const base = [DATABASE_VIEW, ...repoViews()].find(v => v.id === input.basedOn) ?? savedViews.get(input.basedOn)?.summary;
    if (!base || base.error) throw new Error(`Unknown view: ${input.basedOn}`);
    savedViews.set(slug, { summary: { ...base, id: slug, name: input.name, builtin: false, file, description: `Based on ${base.name}` }, input: structuredClone(input) });
    return { id: slug, file };
  },
  editorSettings: async () => structuredClone(editor),
  setEditor: async selected => { editor = { ...editor, selected }; return structuredClone(editor); },
  codegraphSettings: async () => ({ sharedBase: false }),
  setCodegraphSharedBase: async () => ({ sharedBase: false }),
  codegraphConflicts: async () => null,
  openSource: async (id, file, line) => { console.info('Demo: would open', file, line, 'in', editor.selected, 'for workspace', id); },
  pullRequest: async id => {
    await new Promise(resolve => setTimeout(resolve, 700));
    const branch = state.workspaces.find(w => w.id === id)?.branch || 'unknown';
    return { kind: 'pr', branch, repository: 'demo/stingray', checkedAt: Date.now(), number: id === mainId ? 41 : 42, state: id === mainId ? 'merged' : 'open' };
  },
  ports: async () => { await new Promise(resolve => setTimeout(resolve, 650)); return []; },
  containers: async () => { await new Promise(resolve => setTimeout(resolve, 650)); return [{ id: 'demo-web', name: 'demo-web', image: 'node:24', state: 'running', health: 'healthy', paths: state.workspaces.slice(0, 1).map(w => w.path), ports: [{ port: 3000, target: '3000/tcp', url: 'http://127.0.0.1:3000' }] }, { id: 'demo-db', name: 'demo-db', image: 'postgres:17', state: 'running', health: '', paths: [], ports: [] }]; },
  preview: async (id, url) => { const w = state.workspaces.find(w => w.id === id); if (w) w.previewUrl = url; return save(); },
  // No real Pi runs in the browser demo; never fabricate live activity.
  activity: async () => ({ revision: 0, agents: [] }),
  activityView: async () => undefined,
  acknowledgeActivity: async () => undefined,
  onActivity: () => () => {},
  onViewsChanged: () => () => {},
  terminals: async () => structuredClone(terminalList),
  createTerminal: async workspaceId => {
    if (terminalList.length >= 24) throw new Error('Terminal limit reached.');
    const t = { id: crypto.randomUUID(), workspaceId, title: 'Terminal ' + (terminalList.length + 1), exited: false, sequence: 0, buffer: '\x1b[38;2;224;120;80mStingray\x1b[0m · browser demo\r\n\r\nSimulated terminal. Commands are not executed.\r\nUse the Electron app for a real shell and installed agents.\r\n\r\n❯ ' };
    terminalList.push(t); return { ...t };
  },
  writeTerminal: async (id, data) => {
    const output = data === '\r' ? '\r\nDemo only — no command was executed.\r\n❯ ' : data === '\x7f' ? '\b \b' : data;
    const t = terminalList.find(t => t.id === id); if (t) t.buffer = (t.buffer + output).slice(-128 * 1024);
    const sequence = t ? ++t.sequence : 0;
    listeners.forEach(fn => fn({ id, data: output, sequence }));
  },
  openTerminalLink: async () => { throw new Error('Opening terminal links requires the desktop app. No external app was opened.'); },
  resizeTerminal: async () => undefined,
  closeTerminal: async id => { terminalList = terminalList.filter(t => t.id !== id); },
  onTerminal: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
};
