import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as posix from '../../electron/core/shared/posix-path';

const inputs = ['', '.', '..', '/', '//', '///a', 'a', 'a/', 'a//b', 'a/./b', 'a/../b', '../a', '../../a/b', '/a/b/c', '/a/b/c/',
  '/a/../../b', 'a/b/../../..', '.git', 'a/.hidden', 'a/b.c', 'a/b.c.d', 'a/.b', 'a/b.', 'a/..b', 'file.tar.gz', '/x/y/z.ts', 'src/app/main.tsx'];

test('normalize, dirname, basename, extname, isAbsolute match node:path.posix', () => {
  for (const p of inputs) {
    assert.equal(posix.normalize(p), path.posix.normalize(p), `normalize ${JSON.stringify(p)}`);
    assert.equal(posix.dirname(p), path.posix.dirname(p), `dirname ${JSON.stringify(p)}`);
    assert.equal(posix.basename(p), path.posix.basename(p), `basename ${JSON.stringify(p)}`);
    for (const suffix of ['.ts', '.c', 'c', 'b.c']) assert.equal(posix.basename(p, suffix), path.posix.basename(p, suffix), `basename ${JSON.stringify(p)} ${suffix}`);
    assert.equal(posix.extname(p), path.posix.extname(p), `extname ${JSON.stringify(p)}`);
    assert.equal(posix.isAbsolute(p), path.posix.isAbsolute(p), `isAbsolute ${JSON.stringify(p)}`);
  }
});

test('join matches node:path.posix', () => {
  const parts: string[][] = [[], [''], ['a'], ['a', 'b'], ['/a', '../b'], ['a', '', 'b'], ['/', 'a'], ['a/', '/b/'], ['..', 'a'], ['/a/b', '../../..', 'c'], ['.', '.']];
  for (const p of parts) assert.equal(posix.join(...p), path.posix.join(...p), JSON.stringify(p));
});

test('relative matches node:path.posix for absolute paths and rejects relative input', () => {
  const abs = ['/', '/a', '/a/b', '/a/b/c', '/a/bc', '/x/y', '/a/b/', '/a//b/../c'];
  for (const from of abs) for (const to of abs) assert.equal(posix.relative(from, to), path.posix.relative(from, to), `${from} -> ${to}`);
  assert.throws(() => posix.relative('a', '/b'));
  assert.equal(posix.sep, '/');
});
