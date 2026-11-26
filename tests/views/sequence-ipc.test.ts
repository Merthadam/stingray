// Sequence walks across Stingray-style IPC contracts: inline callbacks, type-based member resolution, the `ipc` link set and
// `start: { ipc }` (electron/core/views/sequence/{walk,members,ipc-links,index}.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, codegraphGrammarDir } from '../../electron/app/wiring/views';
import type { GraphSymbol } from '../../electron/core/views/rules/types';
import { fakeGraph, run } from './sequence-helpers';

const FILES: Record<string, string> = {
  'shared/contract.ts': `import { defineContract } from './define';
export const gitContract = defineContract('git', {
  invoke: {
    createWorkspace: [z.tuple([]), returns<State>()],
    settings: [z.tuple([]), returns<void>(), { renderer: 'gitSettings' }],
  },
  events: {},
});
export const otherContract = defineContract('other', { invoke: { createWorkspace: [z.tuple([]), returns<void>()] }, events: {} });
export const appContract = defineContract('app', { invoke: { ping: [z.tuple([]), returns<void>()] }, events: {} });
`,
  'main/store.ts': `class Store {
  load() { return 1; }
}
`,
  'main/base.ts': `import type { Store } from './store';
class BaseService {
  constructor(protected readonly saved: Store) {}
  audit(id: string) { return this.saved.load(); }
}
`,
  'main/git.ts': `import type { Store } from './store';
import { BaseService } from './base';
class GitService extends BaseService {
  readonly store: Store;
  constructor(private readonly runner: Runner, store: Store) { super(); this.store = store; }
  private serial<T>(action: () => Promise<T>) { return action(); }
  createWorkspace(id: string) {
    return this.serial(async () => {
      const state = this.store.load();
      if (!state) throw new Error('missing');
      await this.runner(['worktree', 'add']);
      this.audit(id);
      return state;
    });
  }
}
`,
  'main/ipc.ts': `import type { Handlers } from './define';
import type { gitContract, otherContract, appContract } from '../shared/contract';
import type { GitService } from './git';
export function gitHandlers(d: { git: Pick<GitService, 'createWorkspace' | 'audit'> }): Handlers<typeof gitContract> {
  return {
    createWorkspace: id => d.git.createWorkspace(id),
    gitSettings: () => { d.git.audit('x'); return d.git.createWorkspace('y'); },
  };
}
const other: Handlers<typeof otherContract> = { createWorkspace: () => 1 };
registerContract(ctx, appContract, { ping: () => 1 });
`,
  'web/App.tsx': `export default function App() {
  return <form onSubmit={() => { void api.createWorkspace('r1'); }} />;
}
export function Settings() {
  api.gitSettings();
}
`,
};
const method = (file: string, name: string, line: number): GraphSymbol => ({ id: `${file}#${name}`, name, kind: 'method', file, line });
const graph = () => fakeGraph(FILES, [], {
  symbols: [{ id: 'web/App.tsx#App', name: 'App', kind: 'function', file: 'web/App.tsx', line: 1, endLine: 3 },method('main/store.ts', 'load', 2), method('main/base.ts', 'audit', 4), method('main/git.ts', 'serial', 6), method('main/git.ts', 'createWorkspace', 7),
    { id: 'main/git.ts#runner', name: 'runner', kind: 'property', file: 'main/git.ts', line: 5 }],
  // The code graph resolves `this.runner(…)` to the field; the view's externals entry still wins.
  relations: [{ from: 'main/git.ts#createWorkspace', to: 'main/git.ts#runner', kind: 'calls', line: 11, certain: true },
    { from: 'main/git.ts#GitService', to: 'main/base.ts#BaseService', kind: 'extends', line: 3, certain: true }],
});
const externals = { 'this.runner': 'Git CLI' };

test('sequence ipc: start ipc enters the forwarded service method; trigger reaches the renderer call site first; callbacks and typed members are walked', async () => {
  const out = await run(FILES, graph(), { start: { ipc: 'git.createWorkspace' }, trigger: 'click Create', participants: 'file', externals });
  assert.equal(out.diagnostics.sequence!.error, null);
  assert.equal(out.diagnostics.sequence!.start, 'git.createWorkspace -> createWorkspace (main/git.ts:7) from App (web/App.tsx:2)');
  assert.equal(out.text[0], 'participants: User (actor), App.tsx, git.ts, store.ts, base.ts, Git CLI (external)');
  assert.deepEqual(out.text.slice(1), [
    'User -> App.tsx: click Create',
    'App.tsx -> git.ts: git.createWorkspace  [link ipc]',
    // `this.serial(async () => …)`: the callback's calls; `this.store.load` through the field type, `this.audit` through `extends`.
    'git.ts -> store.ts: load',
    'store.ts --> git.ts',
    'note git.ts: can fail: error',
    'git.ts -> Git CLI: runner',
    'git.ts -> base.ts: audit',
    // A constructor parameter property of the base class.
    '  base.ts -> store.ts: load',
    '  store.ts --> base.ts',
    'base.ts --> git.ts',
    'git.ts --> App.tsx',
  ]);
  // Without a trigger the handler is the entry, like start: { route }.
  const plain = await run(FILES, graph(), { start: { ipc: 'git.createWorkspace' }, participants: 'file', externals });
  assert.equal(plain.seq.messages[0].label, 'load');
});

test('sequence ipc: a renderer call hops to a non-forwarding handler (synthetic symbol), renderer override names, parameter-typed members', async () => {
  const out = await run(FILES, graph(), { start: { symbol: 'Settings' }, participants: 'file', externals });
  assert.deepEqual(out.seq.messages.map(m => [m.kind, m.label, m.link]).slice(0, 3), [['link', 'git.settings', 'ipc'], ['call', 'audit', null], ['call', 'load', null]]);
  assert.deepEqual(out.seq.participants.map(p => p.label), ['App.tsx', 'ipc.ts', 'base.ts', 'store.ts', 'git.ts', 'Git CLI']);
  const noIpc = await run(FILES, graph(), { start: { symbol: 'Settings' }, participants: 'file', externals, links: [] });
  assert.deepEqual(noIpc.seq.messages, []);
});

test('sequence ipc: start ipc by renderer name, Handlers-typed variables and registerContract objects, errors', async () => {
  const g = graph();
  const errors = await Promise.all(['nope', 'createWorkspace'].map(ipc => run(FILES, g, { start: { ipc } })));
  assert.equal(errors[0].diagnostics.sequence!.error, 'start ipc not found: nope');
  assert.match(errors[1].diagnostics.sequence!.error!, /^ambiguous start ipc createWorkspace: add a file or use the channel \(git\.createWorkspace main\/git\.ts:7, other\.createWorkspace main\/ipc\.ts:10\)$/);
  const settings = await run(FILES, g, { start: { ipc: 'gitSettings' } });
  assert.equal(settings.diagnostics.sequence!.start, 'git.settings -> gitSettings (main/ipc.ts:7)');
  const ping = await run(FILES, g, { start: { ipc: 'app.ping' } });
  assert.equal(ping.diagnostics.sequence!.start, 'app.ping -> ping (main/ipc.ts:11)');
});

test('flowchart: function expressions passed as arguments stay unexpanded (callbacks are a sequence-walk feature)', async () => {
  const out = await evaluate({ view: { id: 'f', kind: 'flowchart', scope: { include: ['**/*'], exclude: [] }, rules: [], graph: null, flowchart: { start: { symbol: 'createWorkspace', file: 'main/git.ts' }, depth: 1 },
    builtins: [], include: [], exclude: [] }, graph: graph(), graphStatus: { state: 'ready', message: null }, grammarDir: codegraphGrammarDir(),
  files: { list: async () => ({ files: Object.keys(FILES), truncated: false }), read: async f => FILES[f] ?? null } });
  assert.deepEqual(out.nodes.map(n => n.kind), ['start', 'end']);
});
