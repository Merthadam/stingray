import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitStateService } from '../../electron/core/git';
import type { GitStatus, Workspace, WorkspaceGitState } from '../../shared/contracts/git';
import { manualWatcher } from '../fakes/git';

const id = '00000000-0000-4000-8000-000000000002';
const workspace = (wid: string): Workspace => ({ id: wid, repoId: wid, name: 'w', branch: 'main', path: '/repo', managed: false, previewUrl: '' });
const status = (changes: GitStatus['changes']): GitStatus => ({ branch: 'main', changes, lines: { kind: 'available', added: 0, deleted: 0, binaryFiles: 0 }, uncommitted: { kind: 'available', added: 0, deleted: 0, binaryFiles: 0 }, base: 'HEAD' });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function setup() {
  let current = status([]), statusCalls = 0;
  const events: WorkspaceGitState[] = [];
  const w = manualWatcher();
  const service = new GitStateService({ workspace: async wid => workspace(wid), status: async () => { statusCalls++; return current; } },
    { resolve: async (_cwd, branch) => ({ kind: 'none', branch, repository: 'o/a', checkedAt: 0 }) },
    s => events.push(s), () => true, { debounceMs: 20, pollMs: 60_000, prPollMs: 60_000 },
    { watcher: w.watcher, runner: async () => 'https://github.com/o/a\n' });
  return { service, events, w, calls: () => statusCalls, set: (s: GitStatus) => { current = s; } };
}

test('watcher events are debounced into one refresh', async () => {
  const s = setup();
  try {
    await s.service.get(id);
    assert.equal(s.calls(), 1);
    s.w.change('index'); s.w.change('index'); s.w.change('HEAD');
    await sleep(80);
    assert.equal(s.calls(), 2);
    s.w.change('objects/ab/cdef'); s.w.change('index.lock');
    await sleep(80);
    assert.equal(s.calls(), 2, 'objects and lock files are ignored');
  } finally { s.service.dispose(); }
});

test('the revision bumps only when status, error or PR changed', async () => {
  const s = setup();
  try {
    const first = await s.service.get(id);
    const same = await s.service.refresh(id);
    assert.equal(same.revision, first.revision);
    s.set(status([{ status: ' M', path: 'a.ts' }]));
    const changed = await s.service.refresh(id);
    assert.equal(changed.revision, first.revision + 1);
    assert.equal(s.events.length, 2);
  } finally { s.service.dispose(); }
});

test('forget closes the watcher and stops reporting', async () => {
  const s = setup();
  try {
    await s.service.get(id);
    s.service.forget(id);
    assert.ok(s.w.handles.every(h => h.closed));
    s.w.change('index'); await sleep(60);
    assert.equal(s.calls(), 1);
  } finally { s.service.dispose(); }
});

test('select(id) polls only the selected workspace every selectedPollMs while visible; select(null) and forget stop it', async () => {
  let visible = true;
  const calls = new Map<string, number>();
  const w = manualWatcher();
  const service = new GitStateService({ workspace: async wid => workspace(wid), status: async wid => { calls.set(wid, (calls.get(wid) ?? 0) + 1); return status([]); } },
    { resolve: async (_cwd, branch) => ({ kind: 'none', branch, repository: 'o/a', checkedAt: 0 }) },
    () => {}, () => visible, { debounceMs: 5, pollMs: 60_000, prPollMs: 60_000, selectedPollMs: 30 },
    { watcher: w.watcher, runner: async () => '' });
  const other = '00000000-0000-4000-8000-000000000009';
  try {
    await service.get(other);
    service.select(id);
    await sleep(140);
    const selected = calls.get(id) ?? 0;
    assert.ok(selected >= 3, `selected polled ${selected} times`);
    assert.equal(calls.get(other), 1, 'others are not polled at the selected rate');
    visible = false; const hidden = calls.get(id)!; await sleep(100);
    assert.equal(calls.get(id), hidden, 'never while hidden');
    visible = true; service.select(null); await sleep(20); const stopped = calls.get(id)!; await sleep(100);
    assert.equal(calls.get(id), stopped, 'select(null) stops it');
    service.select(id); await sleep(20); service.forget(id); const forgotten = calls.get(id)!; await sleep(100);
    assert.equal(calls.get(id), forgotten, 'forget stops it');
  } finally { service.dispose(); }
});
