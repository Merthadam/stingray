import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitService, Store, WorkspaceLifecycle } from '../../electron/core/git';
import { provideHasher, resetCorePorts } from '../../electron/core/shared/ports';
import { releaseWorkspace, GRAPH_RELEASE_REFUSED } from '../../electron/core/stinggraph';
import type { State } from '../../shared/contracts/git';
import { fakeHasher, memoryState, pathOnlyFiles, scriptedGit } from '../fakes/git';
import { fakeReleaseHost } from '../fakes/stinggraph';

const quiet = () => { const logged: string[] = []; return { logged, log: (m: string) => { logged.push(m); } }; };

test('listeners of one phase run independently; non-blocking failures are logged only', async () => {
  const { logged, log } = quiet();
  const lifecycle = new WorkspaceLifecycle(log);
  const ran: string[] = [];
  lifecycle.onAfterRemove('view state', async () => { ran.push('view state'); throw new Error('db locked'); });
  lifecycle.onAfterRemove('activity', () => { ran.push('activity'); });
  lifecycle.onAfterRemove('git-state', () => { ran.push('git-state'); });
  await lifecycle.runAfterRemove('w1');
  assert.deepEqual(ran, ['view state', 'activity', 'git-state']);
  assert.ok(logged.some(m => m.includes('view state')));
});

test('a blocking beforeRemove failure rejects after every listener ran; a non-blocking one does not', async () => {
  const { log } = quiet();
  const lifecycle = new WorkspaceLifecycle(log);
  const ran: string[] = [];
  lifecycle.onBeforeRemove('views', async () => { ran.push('views'); throw new Error('views release failed'); });
  lifecycle.onBeforeRemove('terminals', () => { ran.push('terminals'); }, { blocking: true });
  await lifecycle.runBeforeRemove('w1');
  lifecycle.onBeforeRemove('graph', async () => { ran.push('graph'); throw new Error('Could not stop the code graph'); }, { blocking: true });
  await assert.rejects(lifecycle.runBeforeRemove('w1'), /Could not stop the code graph/);
  assert.deepEqual(ran, ['views', 'terminals', 'views', 'terminals', 'graph']);
});

const repoId = '00000000-0000-4000-8000-000000000001', wid = '00000000-0000-4000-8000-000000000002';
const wpath = `/data/worktrees/${repoId}/${wid}`;
const state: State = { version: 1, repos: [{ id: repoId, name: 'repo', path: '/repo' }], workspaces: [
  { id: '00000000-0000-4000-8000-000000000003', repoId, name: 'main', branch: 'main', path: '/repo', managed: false, previewUrl: '' },
  { id: wid, repoId, name: 'feature', branch: 'feature', path: wpath, managed: true, previewUrl: '' }] };
/** Listeners as electron/main.ts (plan 06: compose.ts) registers them, with a fake graph host and overlay remover. */
function removal(host: ReturnType<typeof fakeReleaseHost>, opts: { viewsFail?: boolean; terminalsFail?: boolean; viewStateFails?: boolean } = {}) {
  const runner = scriptedGit((cwd, args) => {
    const a = args.join(' ');
    if (a === 'worktree list --porcelain -z') return `worktree /repo\0branch refs/heads/main\0\0worktree ${wpath}\0branch refs/heads/feature\0\0`;
    if (a === 'branch --show-current') return cwd === wpath ? 'feature\n' : 'main\n';
    if (a.startsWith('status --porcelain=v1')) return '';
    if (a.startsWith('for-each-ref')) return '\n';
    if (a.startsWith('worktree remove')) return '';
    return undefined;
  });
  const lifecycle = new WorkspaceLifecycle(() => {});
  const ran: string[] = [];
  const store = new Store('/data', memoryState(state));
  const overlayRepos = new Map<string, string>();
  lifecycle.onBeforeRemove('terminals', () => { if (opts.terminalsFail) throw new Error('Terminals could not be closed.'); }, { blocking: true });
  lifecycle.onBeforeRemove('views', async () => { if (opts.viewsFail) throw new Error('views release failed'); });
  lifecycle.onBeforeRemove('stinggraph', id => releaseWorkspace(host, id, () => {}), { blocking: true });
  lifecycle.onBeforeRemove('stinggraph overlay', async id => { const w = (await store.load()).workspaces.find(x => x.id === id); if (w) overlayRepos.set(id, w.repoId); });
  lifecycle.onRemoveFailed('views', () => { ran.push('removeFailed'); });
  lifecycle.onRemoveFailed('stinggraph overlay', id => { overlayRepos.delete(id); });
  lifecycle.onAfterRemove('git-state', () => { ran.push('git-state'); });
  lifecycle.onAfterRemove('view state', async () => { if (opts.viewStateFails) throw new Error('db locked'); ran.push('view state'); });
  lifecycle.onAfterRemove('activity', () => { ran.push('activity'); });
  lifecycle.onAfterRemove('stinggraph overlay', async id => { const r = overlayRepos.get(id); overlayRepos.delete(id); if (r) ran.push(`overlay ${r}/${id}`); });
  const git = new GitService({ store, runner, files: pathOnlyFiles, cloner: async () => {}, lifecycle });
  const remove = async () => git.removeWorkspace(wid, { discard: false, deleteBranch: false, fingerprint: (await git.reviewRemoval(wid)).fingerprint });
  const removedFolder = () => runner.calls.some(c => c.args[0] === 'worktree' && c.args[1] === 'remove');
  return { remove, ran, removedFolder };
}

test('rule 3: view-state afterRemove rejects → activity and git-state still run, removal succeeds, overlay removed', async () => {
  provideHasher(fakeHasher);
  try {
    const r = removal(fakeReleaseHost(), { viewStateFails: true });
    const result = await r.remove();
    assert.ok('state' in result);
    assert.ok(r.ran.includes('git-state') && r.ran.includes('activity'));
    assert.ok(r.ran.includes(`overlay ${repoId}/${wid}`), 'overlay removed with the repoId captured before removal');
  } finally { resetCorePorts(); }
});

test('rule 3: a views release failure never blocks; a stinggraph close failure falls back to kill', async () => {
  provideHasher(fakeHasher);
  try {
    assert.ok('state' in await removal(fakeReleaseHost(), { viewsFail: true }).remove());
    const host = fakeReleaseHost({ closeFails: true });
    const r = removal(host);
    assert.ok('state' in await r.remove());
    assert.equal(host.kills, 1);
    assert.equal(r.removedFolder(), true);
  } finally { resetCorePorts(); }
});

test('rule 3: stinggraph close and kill fail → removal refused, nothing deleted, removeFailed runs', async () => {
  provideHasher(fakeHasher);
  try {
    const r = removal(fakeReleaseHost({ closeFails: true, killFails: true }));
    await assert.rejects(r.remove(), new RegExp(GRAPH_RELEASE_REFUSED.replace(/\./g, '\\.')));
    assert.equal(r.removedFolder(), false);
    assert.deepEqual(r.ran, ['removeFailed']);
  } finally { resetCorePorts(); }
});

test('rule 3: terminals beforeRemove rejects → removal aborted, nothing deleted, removeFailed runs', async () => {
  provideHasher(fakeHasher);
  try {
    const r = removal(fakeReleaseHost(), { terminalsFail: true });
    await assert.rejects(r.remove(), /Terminals could not be closed/);
    assert.equal(r.removedFolder(), false);
    assert.deepEqual(r.ran, ['removeFailed']);
  } finally { resetCorePorts(); }
});
