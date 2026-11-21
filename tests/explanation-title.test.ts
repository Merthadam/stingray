import test from 'node:test';
import assert from 'node:assert/strict';
import { explanationTitle } from '../src/views-ui/FlowNode';

test('explanationTitle appends the reason for stale and legacy explanations', () => {
  assert.equal(explanationTitle('Loads.', 'stale', 'may be outdated: SessionStore.get_user changed'), 'Loads.\n(may be outdated: SessionStore.get_user changed)');
  assert.equal(explanationTitle('Loads.', 'stale'), 'Loads.\n(may be outdated: the code changed since this explanation was written)');
  assert.equal(explanationTitle('Loads.', 'legacy'), 'Loads.\n(old fingerprint)');
  assert.equal(explanationTitle('Loads.', 'legacy', 'old fingerprint format (own body only)'), 'Loads.\n(old fingerprint format (own body only))');
  assert.equal(explanationTitle('Loads.', 'view', 'ignored'), 'Loads.');
  assert.equal(explanationTitle('Loads.', 'unstamped', 'no fingerprint'), 'Loads.');
});
