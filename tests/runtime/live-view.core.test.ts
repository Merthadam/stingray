import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveViews } from '../../electron/core/runtime';
import { silentCdp } from '../fakes/runtime';

test('a CDP call without a reply rejects after the timeout and frees its pending entry', async () => {
  const { cdp, sent } = silentCdp();
  const views = new LiveViews(() => {}, { cdp, callTimeoutMs: 50 });
  const started = Date.now();
  await assert.rejects(views.start({ port: 9222 }), /^Error: The live view did not respond\.$/);
  assert.ok(Date.now() - started < 2000);
  assert.ok(sent.some(t => t.includes('Page.startScreencast')));
});
