import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importsOf, layerOf, sourceFiles, violation } from './import-scan';

test('classifier self-check', () => {
  const ok = null;
  const cases: [string, string, string | null, boolean, string | null][] = [
    ['electron/core/git/git.ts', 'node:path', null, false, 'core imports only zod and yaml at runtime'],
    ['electron/core/git/git.ts', 'zod', null, false, ok],
    ['electron/core/views/rules/engine.ts', 'web-tree-sitter', null, true, ok],
    ['electron/core/views/rules/engine.ts', 'web-tree-sitter', null, false, 'core imports only zod and yaml at runtime'],
    ['electron/core/repo-map/repo-map-service.ts', '../git', 'electron/core/git/index.ts', true, ok],
    ['electron/core/repo-map/repo-map-service.ts', '../git/git', 'electron/core/git/git.ts', true, 'core features import each other only via index.ts'],
    ['electron/core/git/git.ts', '../shared/posix-path', 'electron/core/shared/posix-path.ts', false, ok],
    ['electron/core/git/git.ts', '../../adapters/driven/git/runner', 'electron/adapters/driven/git/runner.ts', true, 'core imports only core and shared/'],
    ['electron/adapters/driven/git/gh.ts', './runner', 'electron/adapters/driven/git/runner.ts', false, ok],
    ['electron/adapters/driven/stinggraph-worker/stinggraph-overlay.ts', '../git/runner', 'electron/adapters/driven/git/runner.ts', false, 'adapters never import another adapter folder'],
    ['electron/adapters/driving/ipc/git.ts', '../../driven/git/runner', 'electron/adapters/driven/git/runner.ts', true, 'adapters never import another adapter folder'],
    ['electron/adapters/driving/ipc/git.ts', '../../../app/ipc', 'electron/app/ipc.ts', false, 'only electron/app imports adapters, never the reverse'],
    ['electron/main.ts', './app', 'electron/app/index.ts', false, ok],
    ['electron/main.ts', './app/ipc', 'electron/app/ipc.ts', false, 'electron/main.ts imports only electron/app/index.ts'],
    ['shared/contracts/git.ts', '../../src/app/api', 'src/app/api.ts', true, 'shared/ imports nothing from electron/, src/, agents/'],
    ['shared/contracts/stinggraph.ts', '@colbymchenry/codegraph', null, true, ok],
    ['src/app/App.tsx', '../features/git', 'src/features/git/index.ts', false, ok],
    ['src/app/App.tsx', '../features/git/useGitState', 'src/features/git/useGitState.ts', false, 'other features only via src/features/<f>/index.ts (or demo.ts)'],
    ['src/app/demo.ts', '../features/git/demo', 'src/features/git/demo.ts', false, ok],
    ['src/features/views/demo.ts', '../db-schema', 'src/features/db-schema/index.ts', false, ok],
    ['src/features/git/demo.ts', './WorkspaceStatus', 'src/features/git/WorkspaceStatus.tsx', false, 'demo.ts imports no components and no CSS'],
    ['src/features/git/demo.ts', './git.css', 'src/features/git/git.css', false, 'demo.ts imports no components and no CSS'],
    ['src/shared/Modal.tsx', '../app/api', 'src/app/api.ts', false, 'src/shared imports no feature and no app'],
    ['src/features/runtime/LiveView.tsx', '../../../electron/core/runtime', 'electron/core/runtime/index.ts', true, 'src/ never imports electron/ or agents/'],
    ['agents/hook-client.ts', '../shared/contracts/activity', 'shared/contracts/activity.ts', true, ok],
    ['agents/hook-client.ts', '../src/features/activity/activity', 'src/features/activity/activity.ts', true, 'agents/ imports only shared/ and packages'],
  ];
  // Table paths need not exist on disk: judge them as if they did.
  for (const [from, spec, target, typeOnly, expected] of cases) assert.equal(violation(from, spec, target, typeOnly, () => true), expected, `${from} → ${spec}`);
  assert.equal(layerOf('electron/adapters/driven/fs/walk.ts').group, 'fs');
});

test('every import follows the layer rules (no allow-list)', () => {
  const failures: string[] = [];
  for (const file of sourceFiles()) {
    if (layerOf(file).kind === 'other') { failures.push(`${file}:1 → (file is in no layer)`); continue; }
    for (const ref of importsOf(file)) {
      const rule = violation(ref.file, ref.specifier, ref.target, ref.typeOnly);
      if (rule) failures.push(`${ref.file}:${ref.line} → ${ref.target ?? ref.specifier} (${rule})`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('core port slots are filled only by electron/app and tests', () => {
  const offenders = sourceFiles()
    .filter(file => !file.startsWith('electron/app/') && file !== 'electron/core/shared/ports.ts')
    .filter(file => /\b(provideGlobMatcher|provideHasher|provideSyntaxParser|resetCorePorts)\s*\(/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});
