import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PullRequestService, githubRepository, selectPullRequest, prFields, type PRRunner } from '../electron/pull-requests';

const row = (overrides = {}) => ({ number: 42, state: 'OPEN', isDraft: false, headRefName: 'feature/ui',
  headRepository: { name: 'app' }, headRepositoryOwner: { login: 'owner' }, updatedAt: '2026-11-06T20:00:00Z', ...overrides });
const output = (...rows: unknown[]) => JSON.stringify(rows);

test('GitHub remote parser only accepts pinned credential-free standard origins', () => {
  for (const remote of ['https://github.com/owner/app', 'https://github.com/owner/app.git', 'git@github.com:owner/app.git', 'ssh://git@github.com/owner/app.git', 'https://GITHUB.COM/owner/app/']) {
    assert.equal(githubRepository(remote), 'owner/app');
  }
  for (const remote of ['https://token@github.com/owner/app', 'https://github.com.evil/owner/app', 'git@work:owner/app', 'ssh://root@github.com/owner/app', 'http://github.com/owner/app', '/local/app', 'ext::anything', 'https://github.com/owner/app?q=secret', 'https://github.com/owner/../app', 'https://github.com/owner/..', 'https://github.com/owner/app#frag']) {
    assert.equal(githubRepository(remote), null, remote);
  }
});
test('PR selection distinguishes open, merged, draft and closed without inferring from Git cleanliness', () => {
  for (const [state, isDraft, expected] of [['OPEN', false, 'open'], ['OPEN', true, 'draft'], ['MERGED', false, 'merged'], ['CLOSED', false, 'closed']]) {
    assert.deepEqual(selectPullRequest(output(row({ state, isDraft })), 'owner/app', 'feature/ui'), { number: 42, state: expected });
  }
  assert.equal(selectPullRequest('[]', 'owner/app', 'feature/ui'), null);
});
test('PR selection rejects same-name fork branches and prefers open then most recently updated history', () => {
  const rows = [row({ number: 1, state: 'MERGED', updatedAt: '2026-11-06T21:00:00Z' }), row(),
    row({ number: 100, headRepositoryOwner: { login: 'someone-else' } }), row({ number: 101, headRepository: { name: 'different' } }),
    row({ number: 102, headRefName: 'main' }), row({ number: 103, headRepository: null })];
  assert.deepEqual(selectPullRequest(output(...rows), 'OWNER/APP', 'feature/ui'), { number: 42, state: 'open' });
  assert.deepEqual(selectPullRequest(output(row({ state: 'MERGED' }), row({ number: 43, state: 'CLOSED', updatedAt: '2026-11-06T21:00:00Z' })), 'owner/app', 'feature/ui'), { number: 43, state: 'closed' });
  assert.equal(selectPullRequest(output(row({ headRepositoryOwner: null })), 'owner/app', 'feature/ui'), null);
});
test('invalid, oversized and truncated PR results cannot be represented as no PR or merged', () => {
  for (const value of ['not json', '{}', output(row({ state: 'unknown' })), output(row({ number: -1 })), output(row({ updatedAt: 'invalid' })), output(...Array(100).fill(row()))]) {
    assert.throws(() => selectPullRequest(value, 'owner/app', 'feature/ui'));
  }
});
test('service is read-only, pins GitHub, selects minimal fields, caches and coalesces queries', async () => {
  let now = 1000;
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const runner: PRRunner = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === 'git') return args.includes('branch') ? 'feature/ui\n' : 'git@github.com:owner/app.git\n';
    return output(row());
  };
  const service = new PullRequestService(runner, () => now);
  const results = await Promise.all([service.status('/repo'), service.status('/repo')]);
  assert.deepEqual(results[0], results[1]); assert.equal(results[0].kind, 'pr');
  assert.deepEqual(calls.filter(c => c.command === 'gh').map(c => c.args), [
    ['pr', 'list', '--repo', 'github.com/owner/app', '--head', 'feature/ui', '--state', 'all', '--limit', '100', '--json', prFields],
  ]);
  assert.ok(!prFields.includes('body') && !prFields.includes('title') && !prFields.includes('files'));
  await service.status('/repo', true); assert.equal(calls.filter(c => c.command === 'gh').length, 1);
  now += 6000; await service.status('/repo', true); assert.equal(calls.filter(c => c.command === 'gh').length, 2);
  now += 61000; await service.status('/repo'); assert.equal(calls.filter(c => c.command === 'gh').length, 3);
});
test('missing Git, detached HEAD, absent and unsupported origins never make GitHub requests', async () => {
  for (const mode of ['git-fails', 'detached', 'no-remote', 'unsupported']) {
    const service = new PullRequestService(async (command, args) => {
      assert.equal(command, 'git');
      if (mode === 'git-fails') throw Error('private path');
      if (args.includes('branch')) return mode === 'detached' ? '' : 'main';
      if (mode === 'no-remote') throw Error('no origin');
      return 'https://gitlab.com/owner/app';
    });
    const result = await service.status('/repo');
    assert.equal(result.kind, mode === 'git-fails' ? 'unavailable' : 'unsupported');
    assert.ok(!JSON.stringify(result).includes('private path'));
  }
});
test('service isolates branches and remotes, and sanitizes failures rather than retaining stale success', async () => {
  let branch = 'feature/ui', remote = 'https://github.com/owner/app', fail = false, now = 1000, requests = 0;
  const service = new PullRequestService(async (command, args) => {
    if (command === 'git') return args.includes('branch') ? branch : remote;
    requests++;
    if (fail) throw Error('secret stderr payload');
    return output(row({ headRefName: branch }));
  }, () => now);
  assert.equal((await service.status('/repo')).kind, 'pr');
  branch = 'other'; assert.equal((await service.status('/repo')).branch, 'other');
  remote = 'https://github.com/other/app'; assert.equal((await service.status('/repo')).kind, 'none');
  assert.equal(requests, 3);
  now += 61000; fail = true;
  const failed = await service.status('/repo'); assert.equal(failed.kind, 'unavailable');
  assert.ok(!JSON.stringify(failed).includes('secret'));
  fail = false; now += 11000; assert.equal((await service.status('/repo')).kind, 'none');
});
test('missing gh gives actionable guidance without installing it or triggering authentication', async () => {
  const service = new PullRequestService(async (command, args) => {
    if (command === 'git') return args.includes('branch') ? 'main' : 'https://github.com/owner/app';
    throw Object.assign(Error('private'), { code: 'ENOENT' });
  });
  const value = await service.status('/repo');
  assert.equal(value.kind, 'unavailable');
  assert.ok('message' in value && value.message.includes('not found'));
});
