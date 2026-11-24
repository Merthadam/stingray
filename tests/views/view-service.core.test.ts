import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ViewService } from '../../electron/core/views';
import { unavailableGraph } from '../../electron/core/views/graph';
import { provideGlobMatcher, provideHasher, resetCorePorts } from '../../electron/core/shared/ports';
import { fakeHasher } from '../fakes/git';
import { memoryViewFiles, throwingHost } from '../fakes/views';

const grammarPath = path.join(import.meta.dirname, '../../electron/adapters/driven/tree-sitter/tree-sitter-python.wasm');
beforeEach(() => { provideHasher(fakeHasher); provideGlobMatcher({ matches: (file, glob) => glob === '**/*' || file === glob }); });
afterEach(() => resetCorePorts());
const empty = (workspaceId: string) => ({ workspaceId, scannedAt: 0, filesScanned: 0, filesParsed: 0, truncated: false, groups: [], warnings: [] });
const okSchemas = { dbSchema: async (id: string) => empty(id), sqlSchema: async (id: string) => empty(id) };

test('rule 2: a crashing graph host leaves the view list and the Database view working, graph unavailable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-views-core-'));
  try {
    const service = new ViewService({ host: throwingHost(), grammarPath, emit: () => {}, viewFiles: memoryViewFiles({}),
      fileProvider: () => ({ list: async () => ({ files: [], truncated: false }), read: async () => null }), log: () => {}, dbSchema: okSchemas });
    const views = await service.listViews('w1', root);
    assert.ok(views.some(v => v.id === 'database'));
    const database = await service.computeView('w1', root, 'database');
    assert.equal(database.graph.state, 'unavailable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rule 2: a rejecting schema source gives the Database view a warning; other views are unaffected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-views-core-'));
  try {
    const service = new ViewService({ host: throwingHost(), grammarPath, emit: () => {}, viewFiles: memoryViewFiles({}),
      fileProvider: () => ({ list: async () => ({ files: [], truncated: false }), read: async () => null }), log: () => {},
      dbSchema: { dbSchema: async () => { throw new Error('worker gone'); }, sqlSchema: async id => empty(id) } });
    const database = await service.computeView('w1', root, 'database');
    assert.ok(database.warnings.some(w => /Schema scan unavailable: worker gone/.test(w.message)));
    assert.ok((await service.listViews('w1', root)).length >= 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rule 2: after a failed first open, the next request retries the graph host and uses the recovered graph', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-views-core-'));
  try {
    let opens = 0;
    const host = { open: (id: string, r: string) => {
      opens++;
      if (opens === 1) throw new Error('graph host crashed');
      return { ...unavailableGraph(id, r, ''), status: () => ({ state: 'ready' as const, message: null }) };
    }, async close() {}, async closeAll() {} };
    const service = new ViewService({ host, grammarPath, emit: () => {}, viewFiles: memoryViewFiles({}),
      fileProvider: () => ({ list: async () => ({ files: [], truncated: false }), read: async () => null }), log: () => {}, dbSchema: okSchemas });
    assert.equal((await service.computeView('w1', root, 'database')).graph.state, 'unavailable');
    assert.equal((await service.computeView('w1', root, 'database')).graph.state, 'ready');
    assert.equal((await service.computeView('w1', root, 'database')).graph.state, 'ready');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rule 2: a degraded schema result (worker timeout) is not cached; the next request scans again', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-views-core-'));
  try {
    let calls = 0;
    const host = { open: (id: string, r: string) => ({ ...unavailableGraph(id, r, ''), status: () => ({ state: 'ready' as const, message: null }) }), async close() {}, async closeAll() {} };
    const dbSchema = async (id: string) => {
      calls++;
      return calls === 1 ? { ...empty(id), warnings: [{ file: '', line: null, message: 'Schema scan unavailable: timed out.' }] } : empty(id);
    };
    const service = new ViewService({ host, grammarPath, emit: () => {}, viewFiles: memoryViewFiles({}),
      fileProvider: () => ({ list: async () => ({ files: [], truncated: false }), read: async () => null }), log: () => {},
      dbSchema: { dbSchema, sqlSchema: async id => empty(id) } });
    assert.ok((await service.computeView('w1', root, 'database')).warnings.some(w => /timed out/.test(w.message)));
    assert.ok(!(await service.computeView('w1', root, 'database')).warnings.some(w => /timed out/.test(w.message)));
    assert.equal(calls, 2);
    await service.computeView('w1', root, 'database');
    assert.equal(calls, 2); // healthy result stays cached while the graph is ready
  } finally { await rm(root, { recursive: true, force: true }); }
});
