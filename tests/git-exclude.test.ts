import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { excludeCodeGraphCache } from '../electron/git-exclude';

test('excludeCodeGraphCache lists .codegraph/ once in the shared info/exclude, also from a linked worktree', async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'stingray-exclude-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), linked = path.join(dir, 'linked');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=T', '-c', 'user.email=t@i', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  await mkdir(repo); git(repo, 'init', '-q', '-b', 'main'); await writeFile(path.join(repo, 'a'), 'a'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'a');
  git(repo, 'worktree', 'add', '-q', linked, '-b', 'b');
  const exclude = path.join(repo, '.git/info/exclude');
  await writeFile(exclude, '*.log');
  await excludeCodeGraphCache(linked);
  await excludeCodeGraphCache(repo);
  assert.equal(await readFile(exclude, 'utf8'), '*.log\n# Stingray code graph cache\n/.codegraph/\n');
  await mkdir(path.join(linked, '.codegraph')); await writeFile(path.join(linked, '.codegraph/.gitignore'), '*\n');
  assert.equal(git(linked, 'status', '--porcelain'), '');
});
