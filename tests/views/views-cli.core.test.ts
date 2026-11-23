import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCliSafely, type CliDeps } from '../../electron/adapters/driving/cli/views-cli';

test('rule 1: a failing core call ends the CLI with exit code 1 and a message, never a throw', async () => {
  const err: string[] = [];
  const deps = { cwd: '/', out: () => {}, err: (t: string) => { err.push(t); }, listViews: async () => { throw new Error('core exploded\nstack'); },
    loadViewPath: async () => { throw new Error('unused'); }, evaluate: async () => { throw new Error('unused'); }, createFileProvider: () => { throw new Error('unused'); },
    openGraph: async () => ({ api: null, status: { state: 'unavailable', message: null } }), grammarDir: () => '/g', dbSchema: async () => { throw new Error('unused'); },
    sqlSchema: async () => { throw new Error('unused'); }, skillFile: '/none', version: '0', worktreeRoot: async () => '/' } as unknown as CliDeps;
  assert.equal(await runCliSafely(['list'], deps), 1);
  assert.deepEqual(err, ['stingray-views: core exploded']);
});
