import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeDatabase, database } from '../electron/database';
import { Store } from '../electron/store';
import { ViewStateStore } from '../electron/view-state';
import { EditorService } from '../electron/editors';

const REPO = '11111111-1111-4111-8111-111111111111', ORPHAN_REPO = '99999999-9999-4999-8999-999999999999';
const WS = '22222222-2222-4222-8222-222222222222', WS2 = '33333333-3333-4333-8333-333333333333', ORPHAN = '44444444-4444-4444-8444-444444444444';
const ws = (id: string, repoId = REPO, previewUrl = '') => ({ id, repoId, name: id.slice(0, 4), branch: 'b', path: '/tmp/' + id, managed: id !== WS, previewUrl });
const view = (n: number) => ({ hidden: [`h${n}`], positions: { a: { x: n, y: 1 } }, expanded: [] });

async function dir(t: test.TestContext) {
  const d = await mkdtemp(path.join(tmpdir(), 'stingray-db-'));
  t.after(async () => { closeDatabase(d); await rm(d, { recursive: true, force: true }); });
  return d;
}
const exists = (file: string) => access(file).then(() => true, () => false);

test('first start imports the JSON stores, keeps them as *.migrated and drops orphans', async t => {
  const d = await dir(t);
  const state = { version: 1, repos: [{ id: REPO, name: 'r', path: '/tmp/r' }],
    workspaces: [ws(WS2, REPO, 'http://localhost:3000'), ws(WS), ws(ORPHAN, ORPHAN_REPO)] };
  await writeFile(path.join(d, 'workspaces.json'), JSON.stringify(state));
  await writeFile(path.join(d, 'view-state.json'), JSON.stringify({ version: 1, views: {
    [`${WS}:database`]: { updatedAt: 5, state: view(1) },
    [`${ORPHAN}:database`]: { updatedAt: 6, state: view(2) },
    ['55555555-5555-4555-8555-555555555555:gone']: { updatedAt: 7, state: view(3) },
  } }));
  await writeFile(path.join(d, 'editor.json'), JSON.stringify({ selected: 'zed' }));

  const loaded = await new Store(d).load();
  assert.deepEqual(loaded, { ...state, workspaces: state.workspaces.slice(0, 2) }); // order kept, orphan dropped
  assert.deepEqual(await new ViewStateStore(d).get(WS, 'database'), view(1));
  assert.equal(await new ViewStateStore(d).get(ORPHAN, 'database'), null);
  const editors = new EditorService(d, { showItemInFolder: () => {}, isExecutable: async f => f === '/usr/local/bin/zed', env: { PATH: '/usr/local/bin', HOME: d } });
  assert.equal((await editors.settings()).selected, 'zed');

  for (const name of ['workspaces.json', 'view-state.json', 'editor.json']) {
    assert.equal(await exists(path.join(d, name)), false);
    assert.ok(await exists(path.join(d, name + '.migrated')));
  }
  assert.equal((await stat(path.join(d, 'stingray.db'))).mode & 0o777, 0o600);

  // Reopening does not import again.
  closeDatabase(d);
  await writeFile(path.join(d, 'workspaces.json'), JSON.stringify({ version: 1, repos: [], workspaces: [] }));
  assert.equal((await new Store(d).load()).workspaces.length, 2);
});

test('a corrupt workspaces.json rolls the migration back and stays untouched', async t => {
  const d = await dir(t);
  await writeFile(path.join(d, 'workspaces.json'), '{broken');
  await writeFile(path.join(d, 'editor.json'), JSON.stringify({ selected: 'zed' }));
  await assert.rejects(new Store(d).load(), /not overwritten/);
  assert.equal(await readFile(path.join(d, 'workspaces.json'), 'utf8'), '{broken');
  assert.ok(await exists(path.join(d, 'editor.json')));
  const db = new DatabaseSync(path.join(d, 'stingray.db'), { readOnly: true });
  try {
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 0);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().length, 0);
  } finally { db.close(); }

  await writeFile(path.join(d, 'workspaces.json'), JSON.stringify({ version: 1, repos: [], workspaces: [] }));
  assert.deepEqual(await new Store(d).load(), { version: 1, repos: [], workspaces: [] });
});

test('removing a repository cascades to its workspaces and their view state', async t => {
  const d = await dir(t);
  const store = new Store(d);
  await store.save({ version: 1, repos: [{ id: REPO, name: 'r', path: '/tmp/r' }], workspaces: [ws(WS), ws(WS2)] });
  await new ViewStateStore(d).set(WS2, 'v', view(1));
  const db = database(d);
  db.prepare('DELETE FROM repos WHERE id = ?').run(REPO);
  assert.deepEqual(await store.load(), { version: 1, repos: [], workspaces: [] });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM view_state').get() as { n: number }).n, 0);
  await assert.rejects(store.save({ version: 1, repos: [], workspaces: [ws(WS)] }), /FOREIGN KEY/);
});

test('a database from a newer Stingray is refused', async t => {
  const d = await dir(t);
  const db = new DatabaseSync(path.join(d, 'stingray.db'));
  db.exec('PRAGMA user_version = 99'); db.close();
  await assert.rejects(new Store(d).load(), /newer Stingray/);
});
