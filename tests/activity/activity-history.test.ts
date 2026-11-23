import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ActivityHistory, type ActivityRecord } from '../../electron/core/activity/activity-history';
import { ActivityService } from '../../electron/core/activity/activity';
import { closeDatabase, database } from '../../electron/adapters/driven/sqlite/database';
import { Store } from '../../electron/core/git/store';
import { activityLabel } from '../../src/features/activity/activity';

const REPO = randomUUID(), WS = randomUUID(), WS2 = randomUUID();
const DAY = 24 * 60 * 60 * 1000, NOW = 100 * DAY;
const ws = (id: string) => ({ id, repoId: REPO, name: 'w', branch: 'b', path: '/tmp/' + id, managed: true, previewUrl: '' });
const record = (overrides: Partial<ActivityRecord> = {}): ActivityRecord => ({ id: randomUUID(), workspaceId: WS, terminalId: randomUUID(), harness: 'claude',
  phase: 'idle', needsReview: false, startedAt: NOW - 1000, lastEventAt: NOW - 500, completedAt: null, ...overrides });

async function dir(t: test.TestContext, workspaces = [WS, WS2]) {
  const d = await mkdtemp(path.join(tmpdir(), 'stingray-activity-history-'));
  t.after(async () => { closeDatabase(d); await rm(d, { recursive: true, force: true }); });
  await new Store(d).save({ version: 1, repos: [{ id: REPO, name: 'r', path: '/tmp/r' }], workspaces: workspaces.map(ws) });
  return d;
}

test('save replaces records atomically, load returns them newest first and drops unknown workspaces', async t => {
  const d = await dir(t), history = new ActivityHistory(d);
  const a = record({ needsReview: true, completedAt: NOW - 600, phase: 'idle' }), b = record({ lastEventAt: NOW - 100, harness: 'pi', phase: 'failed' });
  history.save([a, b, record({ workspaceId: randomUUID() })], NOW);
  assert.deepEqual(history.load(NOW), [b, a]);
  history.save([a], NOW);
  assert.deepEqual(history.load(NOW), [a]);
  history.save([{ ...a, harness: 'other' as 'pi' }, b], NOW);
  assert.deepEqual(history.load(NOW), [b], 'an invalid record is skipped without blocking the rest');
  assert.equal((database(d).prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1,
    'the table is created without a schema bump that would lock older builds out');
});

test('retention prunes records older than the age limit and beyond the per-workspace count', async t => {
  const d = await dir(t), history = new ActivityHistory(d, 3, 2 * DAY);
  const recent = [1, 2, 3, 4].map(n => record({ lastEventAt: NOW - n }));
  const other = record({ workspaceId: WS2, lastEventAt: NOW - 10 });
  history.save([...recent, other, record({ lastEventAt: NOW - 3 * DAY })], NOW);
  assert.deepEqual(history.load(NOW).map(r => r.id), [...recent.slice(0, 3), other].map(r => r.id));
  assert.deepEqual(history.load(NOW + 3 * DAY), [], 'load prunes by age too');
  const review = record({ needsReview: true, lastEventAt: NOW - 50 });
  history.save([...recent, review], NOW);
  assert.ok(history.load(NOW).some(r => r.id === review.id), 'unreviewed work outranks newer settled rows');
});

test('corrupt rows are skipped and an unreadable database loads empty', async t => {
  const d = await dir(t), history = new ActivityHistory(d);
  const good = record();
  history.save([good], NOW);
  const insert = database(d).prepare(`INSERT INTO agent_activity (id, workspace_id, terminal_id, harness, phase, needs_review, started_at, last_event_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('not-a-uuid', WS, randomUUID(), 'pi', 'idle', 0, 1, NOW, null);
  insert.run(randomUUID(), WS, randomUUID(), 'emacs', 'idle', 0, 1, NOW, null);
  insert.run(randomUUID(), WS, randomUUID(), 'pi', 'idle', 7, 1, NOW, null);
  assert.deepEqual(history.load(NOW), [good]);

  const broken = await mkdtemp(path.join(tmpdir(), 'stingray-activity-history-'));
  t.after(() => rm(broken, { recursive: true, force: true }));
  await writeFile(path.join(broken, 'stingray.db'), 'not a database '.repeat(100));
  assert.deepEqual(new ActivityHistory(broken).load(NOW), []);
});

test('removing a workspace removes its records', async t => {
  const d = await dir(t), history = new ActivityHistory(d);
  const kept = record({ workspaceId: WS2 });
  history.save([record(), kept], NOW);
  await new Store(d).save({ version: 1, repos: [{ id: REPO, name: 'r', path: '/tmp/r' }], workspaces: [ws(WS2)] });
  assert.deepEqual(history.load(NOW), [kept]);
});

test('restored entries keep needs review, are not acknowledged, dismiss per workspace and persist debounced', async t => {
  const d = await dir(t), history = new ActivityHistory(d);
  const now = Date.now();
  const review = record({ needsReview: true, completedAt: now - 10, lastEventAt: now - 10 }), failed = record({ phase: 'failed', lastEventAt: now - 20 });
  const working = record({ workspaceId: WS2, phase: 'working', lastEventAt: now - 30 });
  history.save([review, failed, working]);
  const service = new ActivityService(() => {}, 20000, undefined, 5);
  t.after(() => service.close());
  service.restore(history);
  const agents = service.snapshot().agents;
  const restored = (id: string) => agents.find(a => a.id === id)!;
  assert.ok(agents.every(a => a.restored && a.connection === 'disconnected'));
  assert.equal(activityLabel(restored(review.id)), 'Needs review');
  assert.equal(activityLabel(restored(failed.id)), 'Failed');
  assert.equal(activityLabel(restored(working.id)), 'Disconnected', 'a run cut off by quit has no observed outcome');
  assert.equal(restored(review.id).lastEventAt, review.lastEventAt);
  service.acknowledge(review.id, review.terminalId, restored(review.id).reviewRevision!);
  assert.notEqual(service.snapshot().agents.find(a => a.id === review.id)!.reviewRevision, null, 'restored review is dismissed, not acknowledged');

  service.dismissRestored(WS);
  assert.deepEqual(service.snapshot().agents.map(a => a.id), [working.id]);
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(history.load().map(r => r.id), [working.id], 'dismissal is persisted');
  service.forgetWorkspace(WS2);
  assert.equal(service.snapshot().agents.length, 0);
});

test('flushHistory saves live entries without tokens and stops persisting before quit closes terminals', async t => {
  const d = await dir(t), history = new ActivityHistory(d);
  const service = new ActivityService(() => {}, 20000, undefined, 60000);
  await service.start();
  t.after(() => service.close());
  service.restore(history);
  const terminal = randomUUID(), env = service.bind(terminal, WS);
  const socket = createConnection(env.STINGRAY_ACTIVITY_SOCKET); t.after(() => socket.destroy());
  await new Promise<void>(r => socket.once('connect', r));
  socket.write(JSON.stringify({ type: 'hello', v: 1, token: env.STINGRAY_ACTIVITY_TOKEN, run: randomUUID(), runtime: randomUUID(), supported: true }) + '\n');
  socket.write(JSON.stringify({ type: 'state', seq: 1, phase: 'idle', completed: 1 }) + '\n');
  for (let i = 0; i < 200 && !service.snapshot().agents[0]?.reviewRevision; i++) await new Promise(r => setTimeout(r, 10));
  const live = service.snapshot().agents[0];
  assert.equal(live.restored, false);
  service.flushHistory();
  service.unbind(terminal, true);
  const [saved] = history.load();
  assert.equal(saved.id, live.id); assert.equal(saved.terminalId, terminal); assert.equal(saved.needsReview, true); assert.ok(saved.completedAt);
  const raw = JSON.stringify(database(d).prepare('SELECT * FROM agent_activity').all());
  assert.ok(!raw.includes(env.STINGRAY_ACTIVITY_TOKEN) && !raw.includes(env.STINGRAY_ACTIVITY_SOCKET));
});

test('live changes are saved on the timer, including a hook event that only advances the last event time', async t => {
  const d = await dir(t), history = new ActivityHistory(d);
  const service = new ActivityService(() => {}, 20000, undefined, 20);
  await service.start();
  t.after(() => service.close());
  service.restore(history);
  const env = service.bind(randomUUID(), WS);
  const hook = async (phase: string) => {
    const socket = createConnection(env.STINGRAY_ACTIVITY_SOCKET);
    await new Promise<void>(r => socket.once('connect', r));
    socket.end(JSON.stringify({ type: 'event', v: 2, token: env.STINGRAY_ACTIVITY_TOKEN, harness: 'claude', session: 's1', pid: process.pid, at: Date.now(), phase, completed: false, ended: false }) + '\n');
    await new Promise(r => socket.once('close', r));
  };
  const saved = async (match: (r: ActivityRecord | undefined) => boolean) => {
    for (let i = 0; i < 200; i++) { const [r] = history.load(); if (match(r)) return r!; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('not saved');
  };
  await hook('working');
  const first = await saved(r => r?.phase === 'working');
  await new Promise(r => setTimeout(r, 5));
  await hook('working');
  await saved(r => r!.lastEventAt > first.lastEventAt);
});
