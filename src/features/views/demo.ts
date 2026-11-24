import type { Events, Invoke } from '../../../shared/contracts/define';
import type { DiagramEdge, DiagramNode, SaveViewInput, SequenceData, SequenceMessage, SequenceParticipant, ViewDiagnostics, ViewLocalState, ViewResult, ViewSummary, viewsContract } from '../../../shared/contracts/views';
import { DATABASE_VIEW, databaseView } from '../../../shared/views/views-database';
import { demoDbSchema } from '../db-schema';
import type { DemoContext } from '../../shared/demo-context';

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

export function createViewsDemo(ctx: DemoContext): Invoke<typeof viewsContract> & Events<typeof viewsContract> {
  return {
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
    openServiceDocs: async serviceId => { console.info('Demo: would open the docs of', serviceId); },
    onViewsChanged: () => () => {},
  };
}
