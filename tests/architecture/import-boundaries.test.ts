import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blankComments, importsOf, layerOf, sourceFiles, violation, type ImportRef } from './import-scan';

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

test('import extraction self-check', () => {
  const source = [
    'import {',
    '  a,',
    '  b,',
    "} from './multi';",
    "export * from './star';",
    "import { type A } from './typed';",
    "type T = typeof import('./typeof');",
    "// import { gone } from './line-comment';",
    "/* import('./block-comment') */",
    "const glob = '**/*';",
    "const lazy = import('node:fs');",
    'const tpl = import(`node:os`);',
    "import cp = require('node:child_process');",
    "const re = /'/g; const path = import('node:path');",
    "import { provideHasher as ph } from './ports';",
    "const s = `${'*/'}`; import('node:url');",
  ].join('\n');
  const refs = importsOf('electron/core/x/y.ts', source).sort((p, q) => p.line - q.line).map(r => [r.line, r.specifier, r.typeOnly, r.names]);
  assert.deepEqual(refs, [
    [1, './multi', false, ['a', 'b']],
    [5, './star', false, ['*']],
    [6, './typed', true, ['A']],
    [7, './typeof', true, ['*']],
    [11, 'node:fs', false, ['*']],
    [12, 'node:os', false, ['*']],
    [13, 'node:child_process', false, ['*']],
    [14, 'node:path', false, ['*']],
    [15, './ports', false, ['provideHasher']],
    [16, 'node:url', false, ['*']],
  ]);
});

// Core runs under any host: no CommonJS require and no Node globals (the bundle is CJS, so these would type-check and run).
const NODE_GLOBAL = /\brequire\s*\(|(?<![.\w$])process\.|\bBuffer\b|\b__dirname\b|\b__filename\b/;
const usesNodeGlobal = (source: string) => NODE_GLOBAL.exec(blankComments(source, true))?.[0] ?? null;

test('node global self-check', () => {
  for (const bad of ["const fs = require('node:fs');", 'const env = process.env.HOME;', "Buffer.from('x')", 'const d = __dirname;', 'f(__filename)', "import fs = require('node:fs');"]) assert.notEqual(usesNodeGlobal(bad), null, bad);
  for (const ok of ['t.process.pid', "const s = 'process.env';", '// require(x)', '/* Buffer */', 'const s = `__dirname`;', '{ maxBuffer: 1 }']) assert.equal(usesNodeGlobal(ok), null, ok);
});

test('core uses no require() and no Node globals', () => {
  const offenders = sourceFiles().filter(file => layerOf(file).kind === 'core')
    .map(file => [file, usesNodeGlobal(readFileSync(file, 'utf8'))]).filter(([, hit]) => hit).map(([file, hit]) => `${file}: ${hit}`);
  assert.deepEqual(offenders, []);
});

const PORT_SLOTS = new Set(['electron/core/shared/ports.ts', 'electron/core/shared/index.ts']);
/** Binds a provide or reset function of electron/core/shared (or the whole module, which exposes them). */
const fillsPortSlot = (ref: ImportRef) => !ref.typeOnly && ref.target !== null && PORT_SLOTS.has(ref.target) &&
  ref.names.some(name => name === '*' || /^(provide|reset)/.test(name));

test('port slot import self-check', () => {
  const ref = (names: string[], typeOnly = false, target = 'electron/core/shared/ports.ts'): ImportRef => ({ file: 'electron/core/git/git.ts', line: 1, specifier: '../shared/ports', target, typeOnly, names });
  assert.equal(fillsPortSlot(ref(['provideHasher'])), true);
  assert.equal(fillsPortSlot(ref(['resetCorePorts'])), true);
  assert.equal(fillsPortSlot(ref(['*'])), true);
  assert.equal(fillsPortSlot(ref(['sha256'])), false);
  assert.equal(fillsPortSlot(ref(['*'], true)), false);
  assert.equal(fillsPortSlot(ref(['provideHasher'], false, 'electron/core/git/ports.ts')), false);
  assert.deepEqual(importsOf('electron/core/git/git.ts', "import { provideHasher as ph } from '../shared/ports';").map(fillsPortSlot), [true]);
});

test('core port slots are filled only by electron/app and tests', () => {
  const offenders = sourceFiles().filter(file => !file.startsWith('electron/app/'))
    .flatMap(file => importsOf(file).filter(fillsPortSlot)).map(ref => `${ref.file}:${ref.line}`);
  assert.deepEqual(offenders, []);
});
