import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { PullRequestStatus } from '../src/shared';

const exec = promisify(execFile);
export type PRRunner = (command: 'git' | 'gh', args: string[], cwd: string) => Promise<string>;
const run: PRRunner = async (command, args, cwd) => {
  const env = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  delete (env as NodeJS.ProcessEnv).GH_DEBUG;
  // Finder's PATH may not include Homebrew. Never install or log in automatically.
  const candidates = command === 'gh' ? ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'] : ['git'];
  for (const executable of candidates) {
    try {
      // The repository PR list includes full REST objects (up to ~2 MB for 100 PRs).
      return (await exec(executable, args, { cwd, env, timeout: 15000, maxBuffer: 8 * 1024 * 1024 })).stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || executable === candidates.at(-1)) throw error;
    }
  }
  throw new Error('Command unavailable');
};

// Pin requests to github.com. Never forward credentials embedded in a remote URL,
// SSH aliases, local paths, arbitrary hosts or Git remote-helper syntax to gh.
export function githubRepository(remote: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/([a-z0-9_.-]+?)\/?$/i.exec(remote.trim());
  if (!match) return null;
  const name = match[2].replace(/\.git$/i, '');
  if (!name || name === '.' || name === '..') return null;
  return `${match[1]}/${name}`;
}

const rowSchema = z.object({
  number: z.number().int().positive().safe(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']), isDraft: z.boolean(),
  headRefName: z.string().max(1024),
  headRepository: z.object({ name: z.string().max(200) }).nullable(),
  headRepositoryOwner: z.object({ login: z.string().max(200) }).nullable(),
  updatedAt: z.string().datetime(),
});
export const prFields = 'number,state,isDraft,headRefName,headRepository,headRepositoryOwner,updatedAt';
type Candidate = { number: number; state: 'open' | 'draft' | 'merged' | 'closed'; updatedAt: string };
// Prefer an open PR; otherwise show the most recently updated historical PR
// for this exact head repository/branch, not an unrelated fork with that name.
function choose(matching: Candidate[]) {
  matching.sort((a, b) => Number(b.state === 'open' || b.state === 'draft') - Number(a.state === 'open' || a.state === 'draft') ||
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number);
  return matching[0] ? { number: matching[0].number, state: matching[0].state } : null;
}
export function selectPullRequest(output: string, repository: string, branch: string) {
  const rows = z.array(rowSchema).max(100).parse(JSON.parse(output));
  // A truncated list cannot establish absence or the latest PR reliably.
  if (rows.length === 100) throw new Error('PR lookup limit reached');
  return choose(rows.filter(row => row.headRefName === branch &&
    `${row.headRepositoryOwner?.login}/${row.headRepository?.name}`.toLowerCase() === repository.toLowerCase())
    .map(row => ({ number: row.number, updatedAt: row.updatedAt, state: row.state === 'OPEN' && row.isDraft ? 'draft' :
      row.state === 'OPEN' ? 'open' : row.state === 'MERGED' ? 'merged' : 'closed' })));
}

// One conditional REST request per repository: the newest 100 PRs of any state, matched to branches locally.
export const pullsPath = (repository: string) => `repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
const pullSchema = z.object({
  number: z.number().int().positive().safe(), state: z.enum(['open', 'closed']), draft: z.boolean().optional(),
  merged_at: z.string().nullable(), updated_at: z.string().datetime(),
  head: z.object({ ref: z.string().max(1024), repo: z.object({ full_name: z.string().max(400) }).nullable() }),
});
export type RepoPull = Candidate & { head: string };
// `gh api --include` output: status line, headers, blank line, body. The ETag is only kept when it is a plain quoted token.
export function parsePullsResponse(output: string): { status: number; etag: string; pulls: RepoPull[] | null } {
  const split = /\r?\n\r?\n/.exec(output);
  const head = split ? output.slice(0, split.index) : output;
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(head)?.[1]);
  if (!status) throw new Error('Invalid PR response');
  const etag = head.split(/\r?\n/).map(line => /^etag:\s*(.*)$/i.exec(line)?.[1].trim()).find(Boolean) ?? '';
  const safeEtag = /^(W\/)?"[\x21\x23-\x7e]{1,200}"$/.test(etag) ? etag : '';
  if (status !== 200) return { status, etag: safeEtag, pulls: null };
  if (!split) throw new Error('Invalid PR response');
  const pulls = z.array(pullSchema).max(100).parse(JSON.parse(output.slice(split.index + split[0].length))).map(row => ({
    number: row.number, updatedAt: row.updated_at, head: (row.head.repo?.full_name ?? '').toLowerCase() + ':' + row.head.ref,
    state: row.merged_at ? 'merged' as const : row.state === 'closed' ? 'closed' as const : row.draft ? 'draft' as const : 'open' as const,
  }));
  return { status, etag: safeEtag, pulls };
}
export const matchPull = (pulls: RepoPull[], repository: string, branch: string) =>
  choose(pulls.filter(pull => pull.head === `${repository.toLowerCase()}:${branch}`));

type RepoList = { pulls: RepoPull[]; etag: string; checkedAt: number };
const lookupFailed = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT' ?
  'GitHub CLI (gh) was not found. Install it and sign in outside Stingray, then retry.' :
  'PR lookup failed. Check gh authentication, repository access and network, then retry. No login or repository changes were attempted.';

export class PullRequestService {
  private cache = new Map<string, { value: PullRequestStatus; until: number; retryAfter: number }>();
  private pending = new Map<string, Promise<PullRequestStatus>>();
  private lists = new Map<string, { list?: RepoList; result: RepoList | { message: string }; until: number; retryAfter: number }>();
  private listsPending = new Map<string, Promise<RepoList | { message: string }>>();
  constructor(private execute: PRRunner = run, private now = Date.now) {}

  async status(cwd: string, refresh = false): Promise<PullRequestStatus> {
    let branch: string;
    try { branch = (await this.execute('git', ['-c', 'core.hooksPath=/dev/null', 'branch', '--show-current'], cwd)).trim(); }
    catch { return { kind: 'unavailable', branch: '', message: 'Git is unavailable. Restore access to this workspace and retry.' }; }
    let remote: string | null = null;
    if (branch) try { remote = await this.execute('git', ['-c', 'core.hooksPath=/dev/null', 'config', '--get', 'remote.origin.url'], cwd); } catch { /* no origin */ }
    return this.resolve(cwd, branch, remote, refresh);
  }

  /** branch '' is detached HEAD; remote null is a missing origin. Repository lists are fresh for 15s; refresh has a 5s cooldown. */
  async resolve(cwd: string, branch: string, remote: string | null, refresh = false): Promise<PullRequestStatus> {
    if (!branch) return { kind: 'unsupported', branch: 'detached HEAD', message: 'Detached HEAD has no branch PR. Check out a branch to look up its pull request.' };
    if (remote === null) return { kind: 'unsupported', branch, message: 'No readable origin remote. PR status requires a github.com origin.' };
    const repository = githubRepository(remote);
    if (!repository) return { kind: 'unsupported', branch, message: 'PR status supports standard github.com origin URLs only. Other hosts, SSH aliases and credential-bearing URLs are not queried.' };
    const list = await this.repoList(cwd, repository, refresh);
    if ('message' in list) return { kind: 'unavailable', branch, message: list.message };
    const pr = matchPull(list.pulls, repository, branch);
    if (pr) return { kind: 'pr', branch, repository, checkedAt: list.checkedAt, ...pr };
    // A full page cannot establish absence: older PRs for this branch need their own lookup.
    if (list.pulls.length === 100) return this.branchStatus(cwd, repository, branch, refresh);
    return { kind: 'none', branch, repository, checkedAt: list.checkedAt };
  }

  private repoList(cwd: string, repository: string, refresh: boolean) {
    const key = repository.toLowerCase();
    const cached = this.lists.get(key);
    if (cached && this.now() < (refresh ? cached.retryAfter : cached.until)) return Promise.resolve(cached.result);
    const pending = this.listsPending.get(key);
    if (pending) return pending;
    const request = this.fetchList(cwd, repository, cached?.list).then(result => {
      // Failures keep the last list only for the next conditional request, never as a displayed result.
      const list = 'pulls' in result ? result : this.lists.get(key)?.list;
      this.lists.delete(key);
      this.lists.set(key, { list, result, until: this.now() + ('pulls' in result ? 15000 : 10000), retryAfter: this.now() + 5000 });
      if (this.lists.size > 100) this.lists.delete(this.lists.keys().next().value!);
      return result;
    }).finally(() => { this.listsPending.delete(key); });
    this.listsPending.set(key, request);
    return request;
  }

  private async fetchList(cwd: string, repository: string, previous?: RepoList): Promise<RepoList | { message: string }> {
    let output: string;
    try {
      output = await this.execute('gh', ['api', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json',
        ...(previous?.etag ? ['-H', `If-None-Match: ${previous.etag}`] : []), pullsPath(repository)], cwd);
    } catch (error) {
      // gh exits non-zero for 304 Not Modified but still prints the response headers.
      const stdout = (error as { stdout?: unknown }).stdout;
      if (previous && typeof stdout === 'string') try {
        if (parsePullsResponse(stdout).status === 304) return { ...previous, checkedAt: this.now() };
      } catch { /* not a response */ }
      return { message: lookupFailed(error) };
    }
    try {
      const response = parsePullsResponse(output);
      if (response.status === 304 && previous) return { ...previous, checkedAt: this.now() };
      if (!response.pulls) throw new Error('Unexpected PR response');
      return { pulls: response.pulls, etag: response.etag, checkedAt: this.now() };
    } catch (error) { return { message: lookupFailed(error) }; }
  }

  private branchStatus(cwd: string, repository: string, branch: string, refresh: boolean): Promise<PullRequestStatus> {
    const key = JSON.stringify([repository.toLowerCase(), branch]);
    const cached = this.cache.get(key);
    if (cached && this.now() < (refresh ? cached.retryAfter : cached.until)) return Promise.resolve(cached.value);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.lookup(cwd, repository, branch).then(value => {
      // Bounded memory; failures have a short cooldown and never reuse stale success.
      this.cache.delete(key);
      this.cache.set(key, { value, until: this.now() + (value.kind === 'unavailable' ? 10000 : 60000), retryAfter: this.now() + 5000 });
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
      return value;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, request);
    return request;
  }

  private async lookup(cwd: string, repository: string, branch: string): Promise<PullRequestStatus> {
    try {
      const output = await this.execute('gh', ['pr', 'list', '--repo', `github.com/${repository}`, '--head', branch,
        '--state', 'all', '--limit', '100', '--json', prFields], cwd);
      const pr = selectPullRequest(output, repository, branch);
      return pr ? { kind: 'pr', branch, repository, checkedAt: this.now(), ...pr } :
        { kind: 'none', branch, repository, checkedAt: this.now() };
    } catch (error) {
      return { kind: 'unavailable', branch, message: lookupFailed(error) };
    }
  }
}
