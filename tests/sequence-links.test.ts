// Link sets of sequence views (docs/sequence-view-spec.md §Links): auth, langgraph, events and link rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SourcedRule } from '../electron/views/rules/types';
import { evaluate } from '../electron/views/rules/engine';
import { codegraphGrammarDir } from '../electron/views/rules/grammars';
import { fakeGraph, run, step } from './sequence-helpers';

const FASTAPI = {
  'services/api/routes.py': `from typing import Annotated
from fastapi import APIRouter, Depends, Security
from services.api.deps import get_db

router = APIRouter(prefix="/v1", dependencies=[Depends(verify_key)])
CurrentUser = Annotated[dict, Depends(get_current_user)]


def verify_key():
    return 1


def get_token():
    return 2


def get_current_user(token=Depends(get_token)):
    return token


def login_required(fn):
    return fn


def audit():
    return 3


@login_required
@router.get("/me", dependencies=[Depends(audit)])
def me(user: CurrentUser, db=Security(get_db, scopes=["me"])):
    return render(user)
`,
  'services/api/deps.py': `def get_db():
    return session()
`,
};

test('sequence auth: FastAPI decorators, router and route dependencies, Depends/Security params (Annotated alias), dependencies of dependencies', async () => {
  const out = await run(FASTAPI, fakeGraph(FASTAPI, []), { start: { symbol: 'me' }, participants: 'file' });
  assert.deepEqual(out.text, [
    'participants: routes.py, deps.py',
    'routes.py -> routes.py: login_required  [link auth]',
    'routes.py -> routes.py: verify_key  [link auth]',
    'routes.py -> routes.py: audit  [link auth]',
    'routes.py -> routes.py: get_current_user  [link auth]',
    '  routes.py -> routes.py: get_token  [link auth]',
    'routes.py -> deps.py: get_db  [link auth]',
    'deps.py --> routes.py: session()',
  ]);
  assert.deepEqual(out.diagnostics.sequence!.links, { auth: 6 });
  assert.ok(out.seq.messages.filter(m => m.link).every(m => m.kind === 'link' && m.certain));
  assert.deepEqual(out.seq.messages[0].source, { file: 'services/api/routes.py', line: 31 });
  // Depth bounds dependencies of dependencies; links: [] turns the set off.
  assert.ok(!(await run(FASTAPI, fakeGraph(FASTAPI, []), { start: { symbol: 'me' }, depth: 0 })).seq.messages.some(m => m.label === 'get_token'));
  assert.deepEqual((await run(FASTAPI, fakeGraph(FASTAPI, []), { start: { symbol: 'me' }, links: ['http'] })).seq.messages, []);
});

const EXPRESS = {
  'web/server.js': `const express = require('express');
const router = express.Router();

function logRequest(req, res, next) { next(); }
function requireUser(req, res, next) { next(); }
function getProfile(req, res) { res.json(loadProfile()); }

router.use(logRequest);
router.get('/profile', requireUser, getProfile);
`,
  'web/pages/api/me.ts': `import { withAuth } from '../../lib/auth';

function handler(req, res) { return res.json({}); }

export default withAuth(handler);
`,
  'web/lib/auth.ts': `export function withAuth(fn) { return fn; }
`,
};

test('sequence auth: Express middleware before the handler and earlier router.use, Next-style wrappers', async () => {
  const graph = fakeGraph(EXPRESS, []);
  const express = await run(EXPRESS, graph, { start: { symbol: 'getProfile' }, participants: 'file' });
  assert.deepEqual(express.text, [
    'participants: server.js',
    'server.js -> server.js: logRequest  [link auth]',
    'server.js -> server.js: requireUser  [link auth]',
  ]);
  const next = await run(EXPRESS, graph, { start: { symbol: 'handler' }, participants: 'file' });
  assert.deepEqual(next.text, ['participants: me.ts, auth.ts', 'me.ts -> auth.ts: withAuth  [link auth]', 'auth.ts --> me.ts: fn']);
});

const AGENT = {
  'services/agent/graph.py': `from langgraph.graph import END, START, StateGraph
from openai import OpenAI
from services.agent.tools import run_tools


class Planner:
    def __call__(self, state):
        return plan(state)


def plan(state):
    return state


def call_model(state):
    return OpenAI().chat(state)


def build():
    flow = StateGraph(dict)
    flow.add_node("planner", Planner())
    flow.add_node("agent", call_model)
    flow.add_node("tools", run_tools)
    flow.add_edge(START, "planner")
    flow.add_edge("planner", "agent")
    flow.add_conditional_edges("agent", route, {"use tools": "tools", "done": END})
    flow.add_edge("tools", "agent")
    return flow.compile()


def run(question):
    return build().invoke({"q": question})
`,
  'services/agent/tools.py': `import httpx


def run_tools(state):
    return httpx.get("https://example.com")
`,
};

test('sequence langgraph: invoke enters the compiled graph: nodes in edge order, conditional edges as alt by path-map key, loops marked once', async () => {
  const out = await run(AGENT, fakeGraph(AGENT, ['__call__>plan']), { start: { symbol: 'run' }, participants: 'file' });
  assert.deepEqual(out.text, [
    'participants: graph.py, tools.py, OpenAI (external), External HTTP (external)',
    'graph.py -> graph.py: planner  [link langgraph]',
    'graph.py -> graph.py: agent  [link langgraph]',
    '  graph.py -> OpenAI: open ai',
    'opt use tools',
    '  graph.py -> tools.py: tools  [link langgraph]',
    '    tools.py -> External HTTP: get',
    '  tools.py --> graph.py',
    '  graph.py -> graph.py: agent (loop)  [link langgraph]',
    'end',
  ]);
  const planner = out.seq.messages[0];
  assert.deepEqual([planner.symbol!.name, planner.certain, planner.source], ['__call__', true, { file: 'services/agent/graph.py', line: 32 }]);
  assert.equal(out.seq.fragments[0].source!.line, 26);
  assert.deepEqual(out.diagnostics.sequence!.links, { langgraph: 4 });
  // links without langgraph: the library call is not drawn (no repo target, no external).
  assert.deepEqual((await run(AGENT, fakeGraph(AGENT, []), { start: { symbol: 'run' }, links: [] })).seq.messages, []);
});

const AGENT_APP = {
  'services/agent/flow.py': `from langgraph.graph import END, StateGraph


def respond(state):
    return state


def finish(state):
    return state


def route(state):
    if state["urgent"]:
        return "finish"
    return "respond"


workflow = StateGraph(dict)
workflow.add_node("respond", respond)
workflow.add_node("finish", finish)
workflow.set_conditional_entry_point(route)
workflow.add_edge("respond", "finish")
workflow.set_finish_point("finish")
app = workflow.compile()
`,
  'services/agent/api.py': `from services.agent.flow import app


class Service:
    def handle(self, q):
        return self.helper.invoke(q)

    async def stream(self, q):
        async for chunk in app.astream(q):
            yield chunk
`,
};

test('sequence langgraph: imported compiled graph, router conditions without a path map, invoke of a repo method stays a call', async () => {
  const out = await run(AGENT_APP, fakeGraph(AGENT_APP, []), { start: { symbol: 'stream' }, participants: 'file' });
  assert.deepEqual(out.text, [
    'participants: api.py, flow.py',
    // `async for` runs astream in its header; the loop body draws nothing, so no loop frame.
    'alt 1. urgent',
    '  api.py -> flow.py: finish  [link langgraph]',
    '  flow.py --> api.py: state',
    'else',
    '  api.py -> flow.py: respond  [link langgraph]',
    '  flow.py --> api.py: state',
    '  api.py -> flow.py: finish  [link langgraph]',
    '  flow.py --> api.py: state',
    'end',
  ]);
  // `self.helper.invoke` has no compiled graph behind it ("helper" does not read like one): not linked.
  assert.deepEqual((await run(AGENT_APP, fakeGraph(AGENT_APP, []), { start: { symbol: 'handle' } })).seq.messages, []);
});

const EVENTS = {
  'services/jobs/tasks.py': `from services.jobs.celery import app
from services.jobs.bus import bus


@app.task(name="emails.welcome")
def send_welcome(user_id):
    return user_id


@app.task
def resize(image):
    return image


@bus.on("user.created")
def on_user_created(event):
    return event


def register(user, name):
    bus.emit("user.created", user)
    app.send_task("emails.welcome", args=[user])
    resize.delay(user.avatar)
    bus.emit(name, user)
    sock.send("hello")
`,
  'web/orders.js': `const emitter = require('./emitter');

function handleOrderPaid(order) { return order; }
emitter.on('order.paid', handleOrderPaid);

function pay(order) { emitter.emit('order.paid', order); }
`,
};

test('sequence events: literal emit/send_task -> registered handlers, task.delay -> the task, dynamic names and unknown events not linked', async () => {
  const graph = fakeGraph(EVENTS, []);
  const out = await run(EVENTS, graph, { start: { symbol: 'register' }, participants: 'file', internal: 'show' });
  assert.deepEqual(out.text, [
    'participants: tasks.py',
    'tasks.py -> tasks.py: user.created  [link events]  (uncertain)',
    'tasks.py -> tasks.py: emails.welcome  [link events]  (uncertain)',
    'tasks.py -> tasks.py: resize  [link events]  (uncertain)',
  ]);
  assert.deepEqual(out.seq.messages.map(m => m.symbol!.name), ['on_user_created', 'send_welcome', 'resize']);
  const js = await run(EVENTS, graph, { start: { symbol: 'pay' }, participants: 'file' });
  assert.deepEqual(js.text, ['participants: orders.js', 'orders.js -> orders.js: order.paid  [link events]  (uncertain)']);
  assert.deepEqual((await run(EVENTS, graph, { start: { symbol: 'register' }, links: ['http'] })).seq.messages, []);
});

const RPC = {
  'services/billing/api.py': `def checkout(cart):
    client.dispatch("charge", cart)
    return worker(cart)


def worker(cart):
    return cart


def charge(cart):
    return cart


def handle(job):
    return job
`,
};
const rule = (id: string, query: string, edge: string): SourcedRule => ({ source: 'view', file: '.stingray/views/v.yaml', line: 1, queryLine: null,
  rule: { id, language: 'python', query, emit: { edge: JSON.parse(edge) } } });

test('sequence link rules: a call to an unresolved `from` and entering a function named `from` continue at `to`', async () => {
  const rules = [
    rule('rpc', '(call function: (attribute attribute: (identifier) @m (#eq? @m "dispatch")) arguments: (argument_list . (string (string_content) @name)))',
      '{ "from": "dispatch", "to": "@name", "kind": "link", "label": "rpc @name" }'),
    rule('jobs', '(function_definition name: (identifier) @f (#eq? @f "worker"))', '{ "from": "@f@@@file", "to": "handle", "kind": "link", "certain": false }'),
  ];
  const out = await run(RPC, fakeGraph(RPC, ['checkout>worker']), { start: { symbol: 'checkout' }, participants: 'file', internal: 'show' }, { rules });
  assert.deepEqual(out.text, [
    'participants: api.py',
    'api.py -> api.py: rpc charge  [link rule:rpc]',
    'api.py -> api.py: worker',
    '  api.py -> api.py: handle  [link rule:jobs]  (uncertain)',
  ]);
  assert.deepEqual(out.diagnostics.sequence!.links, { 'rule:rpc': 1, 'rule:jobs': 1 });
  assert.ok(!out.warnings.some(w => /not applied/.test(w.message)));
});

const SHARED = {
  'services/api/views.py': `from fastapi import Depends

CurrentUser = Annotated[dict, Depends(get_user)]


def get_user():
    return 1


def shared(user: CurrentUser):
    return user


def a():
    return shared()


def b():
    return shared()


def handler():
    a()
    b()
`,
};

test('sequence walk: a function entered again reuses its calls relations and auth hops (no new graph queries)', async () => {
  const graph = fakeGraph(SHARED, ['handler>a', 'handler>b', 'a>shared', 'b>shared']);
  const queries = { outgoing: new Map<string, number>(), alias: 0 };
  const counting = { ...graph,
    outgoing: (ids: string[], kinds: string[]) => { for (const id of ids) queries.outgoing.set(id, (queries.outgoing.get(id) ?? 0) + 1); return graph.outgoing(ids, kinds); },
    findSymbols: (name: string, file?: string) => { if (name === 'CurrentUser') queries.alias++; return graph.findSymbols(name, file); } };
  const out = await run(SHARED, counting, { start: { symbol: 'handler' }, participants: 'file', internal: 'show', returns: false });
  // Both entries still draw shared's dependency.
  assert.equal(out.seq.messages.filter(m => m.label === 'get_user' && m.link === 'auth').length, 2);
  assert.equal(queries.outgoing.get('services/api/views.py#shared'), 1);
  assert.equal(queries.alias, 1);
});

const CELERY = {
  'services/jobs/tasks.py': `from celery import shared_task
from services.jobs.celery import app


@app.task(name="reports.build")
def build_report(rid):
    return rid


@shared_task(autoretry_for=(ConnectionError,), retry_kwargs={"max_retries": max(3, 5)}, name="mail.send")
def send_mail(to):
    return to


def kick(rid, to):
    build_report.delay(rid)
    app.send_task("mail.send", args=[to])
    send_mail.apply_async((to,))
`,
};

test('sequence events: Celery tasks with an explicit name still link from .delay; decorator args with nested parens', async () => {
  const out = await run(CELERY, fakeGraph(CELERY, []), { start: { symbol: 'kick' }, participants: 'file', internal: 'show' });
  assert.deepEqual(out.seq.messages.map(m => [m.label, m.symbol!.name, m.link]), [
    ['build_report', 'build_report', 'events'], ['mail.send', 'send_mail', 'events'], ['send_mail', 'send_mail', 'events']]);
});

const SENDS = {
  'web/server.js': `const queue = require('./queue');

function onOk(msg) { return msg; }
queue.on('ok', onOk);

function reply(req, res) {
  res.send('ok');
  ws.send('ok');
}

function forward(msg) { queue.send('ok', msg); }
`,
};

test('sequence events: `send` links only on a bus/queue-like receiver (Express res.send, ws.send stay unlinked)', async () => {
  const graph = fakeGraph(SENDS, []);
  assert.deepEqual((await run(SENDS, graph, { start: { symbol: 'reply' }, participants: 'file', internal: 'show' })).seq.messages, []);
  const forward = await run(SENDS, graph, { start: { symbol: 'forward' }, participants: 'file', internal: 'show' });
  assert.deepEqual(forward.seq.messages.map(m => [m.label, m.symbol!.name]), [['ok', 'onOk']]);
});

test('sequence events: the registry scan stops when the evaluation is aborted', async () => {
  const files: Record<string, string> = { ...EVENTS };
  for (let i = 0; i < 50; i++) files[`services/more/m${i}.py`] = `def h${i}(e):\n    return e\n`;
  const controller = new AbortController();
  let scanned = 0;
  const out = await evaluate({ view: { id: 'seq', kind: 'sequence', scope: { include: ['**/*'], exclude: [] }, rules: [], graph: null, flowchart: null, builtins: [],
    include: [], exclude: [], sequence: step({ start: { symbol: 'register' }, participants: 'file' }) }, graph: fakeGraph(EVENTS, []),
  graphStatus: { state: 'ready', message: null }, grammarDir: codegraphGrammarDir(), signal: controller.signal,
  files: { list: async () => ({ files: Object.keys(files), truncated: false }),
    read: async f => { if (f.startsWith('services/more/')) { scanned++; controller.abort(); } return files[f] ?? null; } } });
  assert.equal(scanned, 1);
  assert.equal(out.diagnostics.sequence!.truncated, true);
});

const CHAINS = {
  ...AGENT_APP,
  'services/agent/rag.py': `def ask(q):
    return chain.invoke(q)


def plan(q):
    return agent.invoke(q)
`,
};

test('sequence langgraph: `chain.invoke` is not routed into the only StateGraph; `agent.invoke` is, uncertain', async () => {
  const graph = fakeGraph(CHAINS, []);
  assert.deepEqual((await run(CHAINS, graph, { start: { symbol: 'ask' } })).seq.messages, []);
  const agent = await run(CHAINS, graph, { start: { symbol: 'plan' }, participants: 'file' });
  assert.ok(agent.seq.messages.some(m => m.link === 'langgraph'));
  assert.ok(agent.seq.messages.filter(m => m.link === 'langgraph').every(m => !m.certain));
});
