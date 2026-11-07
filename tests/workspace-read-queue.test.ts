import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadQueue } from '../src/workspace-read-queue';

test('sidebar reads share a bounded FIFO concurrency budget', async () => {
  const queue = createReadQueue(3);
  let running = 0, peak = 0;
  const started: number[] = [];
  const results = await Promise.all(Array.from({ length: 20 }, (_, id) => queue(async () => {
    started.push(id); peak = Math.max(peak, ++running);
    await new Promise(resolve => setTimeout(resolve, 2));
    running--; return id;
  })));
  assert.equal(peak, 3);
  assert.deepEqual(started, Array.from({ length: 20 }, (_, id) => id));
  assert.deepEqual(results, started);
});
test('failed and canceled reads release their slot', async () => {
  const queue = createReadQueue(1);
  const first = queue(async () => { throw Error('no longer visible'); });
  const next = queue(async () => 'next workspace');
  await assert.rejects(first, /no longer visible/);
  assert.equal(await next, 'next workspace');
  assert.throws(() => createReadQueue(0));
});
