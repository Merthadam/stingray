import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveViews } from '../../electron/core/runtime';
import { silentCdp } from '../fakes/runtime';

test('a CDP call without a reply rejects after the timeout and frees its pending entry', async () => {
  const { cdp, sent, reply } = silentCdp();
  const views = new LiveViews(() => {}, { cdp, callTimeoutMs: 50 });
  const started = Date.now();
  await assert.rejects(views.start({ port: 9222 }), /^Error: The live view did not respond\.$/);
  assert.ok(Date.now() - started < 2000);
  assert.ok(sent.some(t => t.includes('Page.startScreencast')));
  // The entry is gone: a late reply for every sent id is ignored without throwing.
  for (const t of sent) { const { id } = JSON.parse(t) as { id: number }; assert.doesNotThrow(() => reply(id)); }
});

test('closing the socket rejects pending CDP calls with "disconnected" before the timeout', async () => {
  const { cdp, disconnect, connected } = silentCdp();
  const views = new LiveViews(() => {}, { cdp, callTimeoutMs: 10_000 });
  const started = Date.now();
  const pending = views.start({ port: 9222 });
  while (!connected()) await new Promise(r => setTimeout(r, 1));
  await new Promise(r => setTimeout(r, 5));
  disconnect();
  await assert.rejects(pending, /^Error: The live view disconnected\.$/);
  assert.ok(Date.now() - started < 2000);
});
