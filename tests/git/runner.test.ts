import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GIT_SAFE_CONFIG, git, runGit } from '../../electron/adapters/driven/git/runner';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
async function repo() {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-runner-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root], { env });
  return root;
}

test('runGit ignores a repository core.fsmonitor program', async () => {
  const root = await repo();
  try {
    const marker = path.join(root, '..', path.basename(root) + '-fsmonitor-ran');
    const script = path.join(root, '..', path.basename(root) + '-fsmonitor.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.fsmonitor', script], { cwd: root, env });
    await runGit(root, ['status', '--porcelain']);
    assert.equal(existsSync(marker), false, 'fsmonitor must not run');
    execFileSync('git', ['status', '--porcelain'], { cwd: root, env, stdio: 'ignore' });
    assert.equal(existsSync(marker), true, 'control: plain git runs it');
    await rm(marker, { force: true }); await rm(script, { force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runGit ignores repository hooks', async () => {
  const root = await repo();
  try {
    const hooks = path.join(root, '.git', 'custom-hooks'); await mkdir(hooks);
    const marker = path.join(root, '.git', 'hook-ran');
    await writeFile(path.join(hooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.hooksPath', hooks], { cwd: root, env });
    await runGit(root, ['-c', 'user.name=T', '-c', 'user.email=t@invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'x']);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(GIT_SAFE_CONFIG, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('git() failures carry the first stderr line, without control characters or URL credentials', async () => {
  const root = await repo();
  try {
    await assert.rejects(git(root, ['worktree', 'add', '-b', 'x', path.join(root, 'wt'), 'HEAD']),
      (e: Error) => /^Git operation failed: .*HEAD.*\. Check the repository, branch, and worktree on disk\. No force operation was attempted\.$/.test(e.message));
    await assert.rejects(git(root, ['fetch', 'https://user:secret@127.0.0.1:1/x.git']),
      (e: Error) => e.message.startsWith('Git operation failed') && !e.message.includes('secret') && e.message.length < 400);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('no git process is spawned outside electron/adapters/driven/git/', async () => {
  const offenders: string[] = [];
  for (const file of await readdir('electron', { recursive: true })) {
    if (!file.endsWith('.ts') || file.startsWith(path.join('adapters', 'driven', 'git'))) continue;
    const text = await readFile(path.join('electron', file), 'utf8');
    if (text.includes("'node:child_process'") && /['"]git['"]/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
