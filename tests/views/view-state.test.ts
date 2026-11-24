import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MAX_VIEW_STATES, ViewStateStore } from '../../electron/app/wiring/views';
import { Store } from '../../electron/app/wiring/git';

const WS = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const state = (n = 0) => ({ hidden: [`t${n}`], positions: { a: { x: n, y: -1.5 } }, expanded: [] });

async function dir(t: test.TestContext) {
  const d = await mkdtemp(path.join(tmpdir(), 'stingray-view-state-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  const repo = '33333333-3333-4333-8333-333333333333';
  const ws = (id: string) => ({ id, repoId: repo, name: id, branch: 'main', path: '/tmp/' + id, managed: true, previewUrl: '' });
  await new Store(d).save({ version: 1, repos: [{ id: repo, name: 'r', path: '/tmp/r' }], workspaces: [ws(WS), ws(OTHER)] });
  return d;
}
const rows = (d: string) => {
  const db = new DatabaseSync(path.join(d, 'stingray.db'), { readOnly: true });
  try { return db.prepare('SELECT workspace_id, view_id, length(hidden) + length(positions) + length(expanded) AS bytes FROM view_state').all() as { bytes: number }[]; }
  finally { db.close(); }
};

test('ViewStateStore persists per workspace and view in a 0600 database', async t => {
  const d = await dir(t);
  const store = new ViewStateStore(d);
  assert.equal(await store.get(WS, 'database'), null);
  await store.set(WS, 'database', state(1));
  await store.set(OTHER, 'database', state(2));
  const reloaded = new ViewStateStore(d);
  assert.deepEqual(await reloaded.get(WS, 'database'), state(1));
  assert.deepEqual(await reloaded.get(OTHER, 'database'), state(2));
  assert.equal(await reloaded.get(WS, 'core'), null);
  assert.equal((await stat(path.join(d, 'stingray.db'))).mode & 0o777, 0o600);
});

test('ViewStateStore rejects states over the caps', async t => {
  const store = new ViewStateStore(await dir(t));
  const many = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);
  await store.set(WS, 'v', { hidden: many(2000), positions: {}, expanded: many(500) });
  for (const bad of [
    { hidden: many(2001), positions: {}, expanded: [] },
    { hidden: [], positions: {}, expanded: many(501) },
    { hidden: ['x'.repeat(301)], positions: {}, expanded: [] },
    { hidden: [], positions: Object.fromEntries(many(1001).map(id => [id, { x: 0, y: 0 }])), expanded: [] },
    { hidden: [], positions: { a: { x: Infinity, y: 0 } }, expanded: [] },
    { hidden: [], positions: {}, expanded: [], extra: 1 },
  ]) await assert.rejects(store.set(WS, 'v', bad as never));
});

test('ViewStateStore rejects views of unknown workspaces and drops views with their workspace', async t => {
  const d = await dir(t);
  const store = new ViewStateStore(d);
  await assert.rejects(store.set('44444444-4444-4444-8444-444444444444', 'v', state()), /Workspace not found/);
  await store.set(OTHER, 'v', state(1));
  const s = new Store(d); const current = await s.load();
  await s.save({ ...current, workspaces: current.workspaces.filter(w => w.id !== OTHER) });
  assert.equal(await store.get(OTHER, 'v'), null);
});

test('ViewStateStore serializes concurrent sets without lost updates', async t => {
  const d = await dir(t);
  const store = new ViewStateStore(d);
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.set(WS, `v${i}`, state(i))));
  const reloaded = new ViewStateStore(d);
  for (let i = 0; i < 30; i++) assert.deepEqual(await reloaded.get(WS, `v${i}`), state(i));
});

test('ViewStateStore keeps the most recently updated views', async t => {
  const d = await dir(t);
  const store = new ViewStateStore(d);
  for (let i = 0; i <= MAX_VIEW_STATES; i++) await store.set(WS, `v${i}`, state(i));
  const reloaded = new ViewStateStore(d);
  assert.equal(await reloaded.get(WS, 'v0'), null);
  assert.deepEqual(await reloaded.get(WS, `v${MAX_VIEW_STATES}`), state(MAX_VIEW_STATES));
  assert.equal(rows(d).length, MAX_VIEW_STATES);
});

test('ViewStateStore drops old views to stay under 5 MB', async t => {
  const d = await dir(t);
  const store = new ViewStateStore(d);
  const big = (n: number) => ({ hidden: Array.from({ length: 2000 }, (_, i) => `${n}-${i}-`.padEnd(300, 'x')), positions: {}, expanded: [] });
  for (let i = 0; i < 10; i++) await store.set(WS, `v${i}`, big(i));
  assert.ok(rows(d).reduce((sum, r) => sum + Number(r.bytes), 0) <= 5 * 1024 * 1024);
  const reloaded = new ViewStateStore(d);
  assert.equal(await reloaded.get(WS, 'v0'), null);
  assert.deepEqual(await reloaded.get(WS, 'v9'), big(9));
});

test('ViewStateStore.forget drops only that workspace', async t => {
  const d = await dir(t);
  const store = new ViewStateStore(d);
  await store.set(WS, 'a', state(1)); await store.set(WS, 'b', state(2)); await store.set(OTHER, 'a', state(3));
  await store.forget(WS);
  const reloaded = new ViewStateStore(d);
  assert.equal(await reloaded.get(WS, 'a'), null);
  assert.equal(await reloaded.get(WS, 'b'), null);
  assert.deepEqual(await reloaded.get(OTHER, 'a'), state(3));
});

test('ViewStateStore.get sees a set that is still being written', async t => {
  const store = new ViewStateStore(await dir(t));
  const state = { hidden: ['a'], positions: {}, expanded: [] };
  void store.set(WS, 'v', state);
  assert.deepEqual(await store.get(WS, 'v'), state);
});
