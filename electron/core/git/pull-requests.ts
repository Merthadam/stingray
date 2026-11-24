import { z } from 'zod';
import type { PullRequestStatus } from '../../../shared/contracts/git';
import type { PRRunner } from './ports';

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
// Repositories with a full page also get a second one for open PRs (see resolve).
export type PullsState = 'all' | 'open';
export const pullsPath = (repository: string, state: PullsState = 'all') => `repos/${repository}/pulls?state=${state}&sort=updated&direction=desc&per_page=100`;
// Keeps only the fields below so 100 PRs with long bodies stay small. gh 2.103 still prints --include headers with --jq;
// on 304 it exits 1, prints the headers to stdout and reports "unexpected end of JSON input" on stderr.
export const pullsJq = '[.[]|{number,state,draft,merged_at,updated_at,head:{ref:.head.ref,repo:(.head.repo|if .==null then null else {full_name} end)}}]';
const pullSchema = z.object({
  number: z.number().int().positive().safe(), state: z.enum(['open', 'closed']), draft: z.boolean().nullish(),
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
type ListResult = RepoList | { message: string };
const lookupFailed = (error: unknown) => (error as { code?: string }).code === 'ENOENT' ?
  'GitHub CLI (gh) was not found. Install it and sign in outside Stingray, then retry.' :
  'PR lookup failed. Check gh authentication, repository access and network, then retry. No login or repository changes were attempted.';

export class PullRequestService {
  private cache = new Map<string, { value: PullRequestStatus; refs: string; until: number }>();
  private pending = new Map<string, Promise<PullRequestStatus>>();
  private lists = new Map<string, { list?: RepoList; result: ListResult; until: number; retryAfter: number }>();
  private listsPending = new Map<string, Promise<ListResult>>();
  /** Called when a repository list changed (new 200 response), so every branch of it can be re-matched. */
  onListChange?: () => void;
  constructor(private execute: PRRunner, private now = Date.now) {}

  /** branch '' is detached HEAD; remote null is a missing origin. Repository lists are fresh for 15s; refresh has a 5s cooldown. */
  async resolve(cwd: string, branch: string, remote: string | null, refresh = false): Promise<PullRequestStatus> {
    if (!branch) return { kind: 'unsupported', branch: 'detached HEAD', message: 'Detached HEAD has no branch PR. Check out a branch to look up its pull request.' };
    if (remote === null) return { kind: 'unsupported', branch, message: 'No readable origin remote. PR status requires a github.com origin.' };
    const repository = githubRepository(remote);
    if (!repository) return { kind: 'unsupported', branch, message: 'PR status supports standard github.com origin URLs only. Other hosts, SSH aliases and credential-bearing URLs are not queried.' };
    const list = await this.repoList(cwd, repository, 'all', refresh);
    if ('message' in list) return { kind: 'unavailable', branch, message: list.message };
    const pr = matchPull(list.pulls, repository, branch);
    if (pr) return { kind: 'pr', branch, repository, checkedAt: list.checkedAt, ...pr };
    if (list.pulls.length < 100) return { kind: 'none', branch, repository, checkedAt: list.checkedAt };
    // A full page cannot establish absence. Open PRs come from a second shared list; only older closed/merged
    // history needs a per-branch lookup, cached for 10 minutes (any change to such a PR moves it into the lists).
    const open = await this.repoList(cwd, repository, 'open', refresh);
    if ('message' in open) return { kind: 'unavailable', branch, message: open.message };
    const openPr = matchPull(open.pulls, repository, branch);
    if (openPr) return { kind: 'pr', branch, repository, checkedAt: open.checkedAt, ...openPr };
    return this.branchStatus(cwd, repository, branch);
  }

  private repoList(cwd: string, repository: string, state: PullsState, refresh: boolean) {
    const key = `${state}:${repository.toLowerCase()}`;
    const cached = this.lists.get(key);
    if (cached && this.now() < (refresh ? cached.retryAfter : cached.until)) return Promise.resolve(cached.result);
    const pending = this.listsPending.get(key);
    if (pending) return pending;
    const request = this.fetchList(cwd, repository, state, cached?.list).then(result => {
      // Failures keep the last list only for the next conditional request, never as a displayed result.
      const list = 'pulls' in result ? result : this.lists.get(key)?.list;
      this.lists.delete(key);
      this.lists.set(key, { list, result, until: this.now() + ('pulls' in result ? 15000 : 10000), retryAfter: this.now() + 5000 });
      if (this.lists.size > 100) this.lists.delete(this.lists.keys().next().value!);
      if ('pulls' in result && result.etag !== cached?.list?.etag) this.onListChange?.();
      return result;
    }).finally(() => { this.listsPending.delete(key); });
    this.listsPending.set(key, request);
    return request;
  }

  private async fetchList(cwd: string, repository: string, state: PullsState, previous?: RepoList): Promise<ListResult> {
    let output: string;
    try {
      output = await this.execute('gh', ['api', '--method', 'GET', '--include', '--jq', pullsJq, '-H', 'Accept: application/vnd.github+json',
        ...(previous?.etag ? ['-H', `If-None-Match: ${previous.etag}`] : []), pullsPath(repository, state)], cwd);
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

  /** Branch history beyond the shared lists. Cached results are dropped when the local or origin branch ref moves. */
  private async branchStatus(cwd: string, repository: string, branch: string): Promise<PullRequestStatus> {
    const key = JSON.stringify([repository.toLowerCase(), branch]);
    const refs = await this.execute('git', ['for-each-ref', '--format=%(refname) %(objectname)',
      `refs/heads/${branch}`, `refs/remotes/origin/${branch}`], cwd).catch(() => '');
    const cached = this.cache.get(key);
    if (cached && cached.refs === refs && this.now() < cached.until) return cached.value;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.lookup(cwd, repository, branch).then(value => {
      // Bounded memory; failures have a short cooldown and never reuse stale success.
      this.cache.delete(key);
      this.cache.set(key, { value, refs, until: this.now() + (value.kind === 'unavailable' ? 10000 : 600000) });
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
