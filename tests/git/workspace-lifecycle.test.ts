import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceLifecycle } from '../../electron/core/git';

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
