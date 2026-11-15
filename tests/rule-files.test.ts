import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_FILES, MAX_SOURCE_BYTES, createFileProvider } from '../electron/views/rules/files';

async function tree(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-rule-files-'));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

test('lists regular files in a stable order, skipping generated dirs at any depth and symlinks', async t => {
  const outside = await tree({ 'secret.txt': 'secret' });
  const root = await tree({
    'b.py': 'b', 'a/z.py': 'z', 'a/b.ts': 'b', '.stingray/views/v.yaml': 'v',
    '.git/config': 'x', '.codegraph/db': 'x', 'node_modules/p/i.js': 'x', 'pkg/node_modules/q.js': 'x', 'svc/dist/out.js': 'x',
    'svc/build/x': 'x', '.venv/a.py': 'x', 'venv/a.py': 'x', 'app/__pycache__/m.pyc': 'x', 'web/.next/x.js': 'x', 'rs/target/x': 'x',
  });
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  await symlink(outside, path.join(root, 'linkdir'));
  execFileSync('mkfifo', [path.join(root, 'pipe')]);
  const files = createFileProvider(root);
  assert.deepEqual(await files.list(), { files: ['.stingray/views/v.yaml', 'a/b.ts', 'a/z.py', 'b.py'], truncated: false });
  assert.equal(await files.read('a/z.py'), 'z');
  assert.equal(await files.read('./a/z.py'), 'z');
  // Symlinks (as the file or a parent directory), FIFOs and missing files read as null.
  for (const file of ['link.txt', 'linkdir/secret.txt', 'pipe', 'missing.py', 'a']) assert.equal(await files.read(file), null, file);
});

test('rejects paths that could leave the worktree', async t => {
  const root = await tree({ 'inner/a.py': 'a' });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(path.dirname(root), 'stingray-rule-files-outside.txt'), 'x');
  t.after(() => rm(path.join(path.dirname(root), 'stingray-rule-files-outside.txt'), { force: true }));
  const files = createFileProvider(root);
  for (const file of ['../stingray-rule-files-outside.txt', 'inner/../../stingray-rule-files-outside.txt', path.join(root, 'inner/a.py'), 'inner\\a.py', '', 'inner/a.py\0'])
    assert.equal(await files.read(file), null, JSON.stringify(file));
  assert.equal(await files.read('inner/a.py'), 'a');
});

test('caps file size and file count', async t => {
  const root = await tree({ 'big.txt': 'x'.repeat(MAX_SOURCE_BYTES + 1), 'max.txt': 'y'.repeat(MAX_SOURCE_BYTES) });
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = createFileProvider(root);
  assert.equal(await files.read('big.txt'), null);
  assert.equal((await files.read('max.txt'))?.length, MAX_SOURCE_BYTES);

  await mkdir(path.join(root, 'many'));
  await Promise.all(Array.from({ length: MAX_FILES }, (_, i) => writeFile(path.join(root, 'many', `${String(i).padStart(4, '0')}.py`), '')));
  const listed = await files.list();
  assert.equal(listed.truncated, true);
  assert.equal(listed.files.length, MAX_FILES);
  assert.deepEqual(listed.files.slice(0, 2), ['big.txt', 'many/0000.py']);
  // A scope filter applies before the cap: in-scope files after many out-of-scope ones are still listed.
  await writeFile(path.join(root, 'zz.txt'), '');
  assert.deepEqual(await files.list(f => f.endsWith('.txt')), { files: ['big.txt', 'max.txt', 'zz.txt'], truncated: false });
});
