import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelection, resolveSelection } from '../src/project-navigation';
import type { State } from '../src/shared';

const state: State = { version: 1,
  repos: [{ id: 'a', name: 'Alpha', path: '/fixtures/alpha' }, { id: 'b', name: 'Beta', path: '/fixtures/beta' }],
  workspaces: [
    { id: 'a-main', repoId: 'a', name: 'main', branch: 'main', path: '/fixtures/alpha', managed: false, previewUrl: '' },
    { id: 'a-feature', repoId: 'a', name: 'feature/a', branch: 'feature/a', path: '/fixtures/alpha-feature', managed: true, previewUrl: '' },
    { id: 'b-main', repoId: 'b', name: 'main', branch: 'main', path: '/fixtures/beta', managed: false, previewUrl: '' },
  ],
};
test('new windows start at home and invalid stored selection is harmless', () => {
  for (const raw of [null, '', '{', 'null', 'false', '[]', '{"repoId":3}', '{"workspaceId":"a-main"}']) {
    assert.equal(parseSelection(raw), null);
  }
  assert.equal(resolveSelection(state, null), null);
});
test('renderer selection round-trips without storing repository paths', () => {
  const selection = { repoId: 'a', workspaceId: 'a-feature' };
  assert.deepEqual(resolveSelection(state, parseSelection(JSON.stringify(selection))), selection);
  assert.deepEqual(parseSelection(JSON.stringify({ ...selection, path: '/ignored' })), selection);
});
test('deleted or foreign workspace falls back only to its project main', () => {
  for (const workspaceId of ['gone', 'b-main', '']) {
    assert.deepEqual(resolveSelection(state, { repoId: 'a', workspaceId }), { repoId: 'a', workspaceId: 'a-main' });
  }
});
test('missing repository or empty project returns home, never another project', () => {
  assert.equal(resolveSelection(state, { repoId: 'deleted', workspaceId: 'a-main' }), null);
  assert.equal(resolveSelection({ ...state, workspaces: state.workspaces.filter(w => w.repoId !== 'a') }, { repoId: 'a', workspaceId: 'a-feature' }), null);
});
