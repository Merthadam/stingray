import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloneLock } from '../../electron/core/git';

test('a second clone while one runs is refused; busy resets after success and after an error', async () => {
  const lock = new CloneLock();
  let release!: () => void;
  const first = lock.run(() => new Promise<void>(r => { release = r; }));
  assert.equal(lock.busy, true);
  await assert.rejects(lock.run(async () => {}), /^Error: A clone is already in progress\. Wait for it to finish\.$/);
  release(); await first;
  assert.equal(lock.busy, false);
  await assert.rejects(lock.run(async () => { throw new Error('clone failed'); }), /clone failed/);
  assert.equal(lock.busy, false);
});
