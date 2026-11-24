import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SKIPPED_DIRS, walkFiles } from '../../electron/adapters/driven/fs/walk';

async function tree(files: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-walk-'));
  for (const f of files) { await mkdir(path.join(root, path.dirname(f)), { recursive: true }); await writeFile(path.join(root, f), 'x'); }
  return root;
}

test('symlinks are skipped; every skip-set name is skipped at any depth; output is sorted', async () => {
  const skipped = [...SKIPPED_DIRS].flatMap(d => [`${d}/a.ts`, `deep/${d}/b.ts`]);
  const root = await tree(['z.ts', 'a/b.ts', 'a-c.ts', ...skipped]);
  try {
    await symlink(path.join(root, 'z.ts'), path.join(root, 'link.ts'));
    await symlink(path.join(root, 'a'), path.join(root, 'linkdir'));
    const { files, truncated } = await walkFiles(root, { keep: () => true });
    assert.deepEqual(files, ['a-c.ts', 'a/b.ts', 'z.ts']);
    assert.equal(truncated, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dot-dirs outside the skip set are walked by default and skipped with skipDotDirs', async () => {
  const root = await tree(['.stingray/views/v.yaml', 'src/a.py', '.hidden/x.py']);
  try {
    assert.deepEqual((await walkFiles(root, { keep: () => true })).files, ['.hidden/x.py', '.stingray/views/v.yaml', 'src/a.py']);
    assert.deepEqual((await walkFiles(root, { keep: () => true, skipDotDirs: true })).files, ['src/a.py']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('entry cap, caller entry cap and the 5000 kept-file cap each set truncated', async () => {
  const root = await tree(Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`));
  try {
    assert.equal((await walkFiles(root, { keep: () => true, maxEntries: 20 })).truncated, true);
    assert.equal((await walkFiles(root, { keep: () => true, maxFiles: 10 })).files.length, 10);
    assert.equal((await walkFiles(root, { keep: () => true, maxFiles: 10 })).truncated, true);
    assert.equal((await walkFiles(root, { keep: () => true })).truncated, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unreadable subdirectory is reported through onDirError; an unreadable root throws', async () => {
  const root = await tree(['ok/a.ts', 'locked/b.ts']);
  try {
    await chmod(path.join(root, 'locked'), 0o000);
    const errors: string[] = [];
    const { files } = await walkFiles(root, { keep: () => true, onDirError: dir => errors.push(dir) });
    assert.deepEqual(files, ['ok/a.ts']);
    assert.deepEqual(errors, ['locked']);
    await assert.rejects(walkFiles(path.join(root, 'missing'), { keep: () => true }));
  } finally { await chmod(path.join(root, 'locked'), 0o755); await rm(root, { recursive: true, force: true }); }
});
