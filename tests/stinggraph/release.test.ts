import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRAPH_RELEASE_REFUSED, releaseWorkspace } from '../../electron/core/stinggraph';
import { fakeReleaseHost } from '../fakes/stinggraph';

const quiet = () => {};
test('a successful close needs no kill', async () => {
  const host = fakeReleaseHost();
  await releaseWorkspace(host, 'w1', quiet);
  assert.deepEqual([host.closed, host.kills], [['w1'], 0]);
});
test('close fails → kill is called once and the release succeeds', async () => {
  const host = fakeReleaseHost({ closeFails: true });
  await releaseWorkspace(host, 'w1', quiet);
  assert.equal(host.kills, 1);
});
test('close and kill fail → rejects with the removal-refused message', async () => {
  const host = fakeReleaseHost({ closeFails: true, killFails: true });
  await assert.rejects(releaseWorkspace(host, 'w1', quiet), new RegExp(`^Error: ${GRAPH_RELEASE_REFUSED.replace(/\./g, '\\.')}$`));
});
