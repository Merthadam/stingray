import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PullRequestService, githubRepository, selectPullRequest, prFields, parsePullsResponse, matchPull, pullsPath } from '../electron/pull-requests';

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
const pull = (overrides = {}) => ({ number: 42, state: 'open', draft: false, merged_at: null, updated_at: '2026-11-06T20:00:00Z',
  head: { ref: 'feature/ui', repo: { full_name: 'owner/app' } }, title: 'ignored', body: 'ignored', ...overrides });
const response = (pulls: unknown[], etag = '"v1"') => `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nEtag: ${etag}\r\n\r\n${JSON.stringify(pulls)}`;
// gh api exits non-zero on 304 but still prints the headers.
const notModified = () => Object.assign(Error('gh: HTTP 304'), { stdout: 'HTTP/2.0 304 Not Modified\r\nEtag: "v1"\r\n\r\n' });
const apiArgs = (etag?: string) => ['api', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json',
  ...(etag ? ['-H', `If-None-Match: ${etag}`] : []), pullsPath('owner/app')];

test('repository PR list parses REST states, keeps only safe ETags and rejects invalid responses', () => {
  const parsed = parsePullsResponse(response([pull(), pull({ number: 2, draft: true }), pull({ number: 3, state: 'closed', merged_at: '2026-11-06T20:00:00Z' }),
    pull({ number: 4, state: 'closed' }), pull({ number: 5, head: { ref: 'x', repo: null } })], 'W/"abc"'));
  assert.equal(parsed.etag, 'W/"abc"');
  assert.deepEqual(parsed.pulls!.map(p => [p.number, p.state, p.head]), [[42, 'open', 'owner/app:feature/ui'], [2, 'draft', 'owner/app:feature/ui'],
    [3, 'merged', 'owner/app:feature/ui'], [4, 'closed', 'owner/app:feature/ui'], [5, 'open', ':x']]);
  assert.equal(parsePullsResponse(response([], 'unquoted')).etag, '');
  assert.deepEqual(parsePullsResponse(notModified().stdout), { status: 304, etag: '"v1"', pulls: null });
  for (const value of ['', 'not http', response([pull({ state: 'unknown' })]), 'HTTP/2.0 200 OK\r\n\r\n{}', response(Array(101).fill(pull()))]) {
    assert.throws(() => parsePullsResponse(value), value.slice(0, 40));
  }
});
test('repository PR matching requires the exact head repository and branch and prefers open PRs', () => {
  const { pulls } = parsePullsResponse(response([pull({ number: 1, state: 'closed', merged_at: '2026-11-06T21:00:00Z', updated_at: '2026-11-06T21:00:00Z' }), pull(),
    pull({ number: 100, head: { ref: 'feature/ui', repo: { full_name: 'someone-else/app' } } }), pull({ number: 101, head: { ref: 'feature/ui', repo: null } }),
    pull({ number: 102, head: { ref: 'Feature/UI', repo: { full_name: 'owner/app' } } })]));
  assert.deepEqual(matchPull(pulls!, 'OWNER/APP', 'feature/ui'), { number: 42, state: 'open' });
  assert.equal(matchPull(pulls!, 'owner/app', 'main'), null);
});
test('service makes one conditional request per repository for all branches, then reuses 304 responses', async () => {
  let now = 1000;
  const calls: { command: string; args: string[] }[] = [];
  let reply: () => string = () => response([pull(), pull({ number: 43, head: { ref: 'other', repo: { full_name: 'owner/app' } } })]);
  const service = new PullRequestService(async (command, args) => {
    calls.push({ command, args });
    if (command === 'git') return args.includes('branch') ? 'feature/ui\n' : 'git@github.com:owner/app.git\n';
    return reply();
  }, () => now);
  let changes = 0; service.onListChange = () => { changes++; };
  const results = await Promise.all([service.status('/repo'), service.resolve('/worktree', 'other', 'https://github.com/owner/app'),
    service.resolve('/worktree2', 'unmatched', 'https://github.com/owner/app.git')]);
  assert.deepEqual(results.map(r => r.kind === 'pr' ? r.number : r.kind), [42, 43, 'none']);
  const gh = () => calls.filter(c => c.command === 'gh').map(c => c.args);
  assert.deepEqual(gh(), [apiArgs()]);
  await service.resolve('/repo', 'feature/ui', 'https://github.com/owner/app', true); assert.equal(gh().length, 1);
  now += 6000; reply = () => { throw notModified(); };
  const forced = await service.resolve('/repo', 'feature/ui', 'https://github.com/owner/app', true);
  assert.deepEqual(gh()[1], apiArgs('"v1"'));
  assert.ok(forced.kind === 'pr' && forced.checkedAt === now);
  assert.equal(changes, 1, 'a 304 is not a list change');
  now += 10000; await service.resolve('/repo', 'other', 'https://github.com/owner/app'); assert.equal(gh().length, 2);
  now += 6000; await service.resolve('/repo', 'other', 'https://github.com/owner/app'); assert.equal(gh().length, 3);
});
test('a full repository page falls back to a per-branch lookup instead of claiming no PR', async () => {
  const calls: string[][] = [];
  const service = new PullRequestService(async (command, args) => {
    calls.push(args);
    if (args[0] === 'api') return response(Array.from({ length: 100 }, (_, i) => pull({ number: i + 1, head: { ref: 'b' + i, repo: { full_name: 'owner/app' } } })));
    return output(row({ number: 7, state: 'MERGED' }));
  });
  const listed = await service.resolve('/repo', 'b5', 'https://github.com/owner/app');
  assert.ok(listed.kind === 'pr' && listed.number === 6 && listed.state === 'open');
  const old = await service.resolve('/repo', 'feature/ui', 'https://github.com/owner/app');
  assert.ok(old.kind === 'pr' && old.number === 7 && old.state === 'merged');
  assert.deepEqual(calls.map(args => args[0]), ['api', 'pr']);
  assert.deepEqual(calls[1], ['pr', 'list', '--repo', 'github.com/owner/app', '--head', 'feature/ui', '--state', 'all', '--limit', '100', '--json', prFields]);
  assert.ok(!prFields.includes('body') && !prFields.includes('title') && !prFields.includes('files'));
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
test('service isolates remotes, and sanitizes failures rather than retaining stale success', async () => {
  let branch = 'feature/ui', remote = 'https://github.com/owner/app', fail = false, now = 1000, requests = 0;
  const service = new PullRequestService(async (command, args) => {
    if (command === 'git') return args.includes('branch') ? branch : remote;
    requests++;
    if (fail) throw Object.assign(Error('secret stderr payload'), { stdout: 'HTTP/2.0 401 Unauthorized\r\n\r\nsecret body' });
    return response([pull({ head: { ref: branch, repo: { full_name: 'owner/app' } } })]);
  }, () => now);
  assert.equal((await service.status('/repo')).kind, 'pr');
  branch = 'other'; assert.equal((await service.status('/repo')).branch, 'other');
  remote = 'https://github.com/other/app'; assert.equal((await service.status('/repo')).kind, 'none');
  assert.equal(requests, 2);
  now += 16000; fail = true;
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
