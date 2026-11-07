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
      return (await exec(executable, args, { cwd, env, timeout: 15000, maxBuffer: 512 * 1024 })).stdout;
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
export function selectPullRequest(output: string, repository: string, branch: string) {
  const rows = z.array(rowSchema).max(100).parse(JSON.parse(output));
  // A truncated list cannot establish absence or the latest PR reliably.
  if (rows.length === 100) throw new Error('PR lookup limit reached');
  const matching = rows.filter(row => row.headRefName === branch &&
    `${row.headRepositoryOwner?.login}/${row.headRepository?.name}`.toLowerCase() === repository.toLowerCase());
  // Prefer an open PR; otherwise show the most recently updated historical PR
  // for this exact head repository/branch, not an unrelated fork with that name.
  matching.sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') ||
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number);
  const row = matching[0];
  return row ? { number: row.number, state: row.state === 'OPEN' && row.isDraft ? 'draft' as const :
    row.state === 'OPEN' ? 'open' as const : row.state === 'MERGED' ? 'merged' as const : 'closed' as const } : null;
}

export class PullRequestService {
  private cache = new Map<string, { value: PullRequestStatus; until: number; retryAfter: number }>();
  private pending = new Map<string, Promise<PullRequestStatus>>();
  constructor(private execute: PRRunner = run, private now = Date.now) {}

  async status(cwd: string, refresh = false): Promise<PullRequestStatus> {
    let branch: string;
    try { branch = (await this.execute('git', ['-c', 'core.hooksPath=/dev/null', 'branch', '--show-current'], cwd)).trim(); }
    catch { return { kind: 'unavailable', branch: '', message: 'Git is unavailable. Restore access to this workspace and retry.' }; }
    if (!branch) return { kind: 'unsupported', branch: 'detached HEAD', message: 'Detached HEAD has no branch PR. Check out a branch to look up its pull request.' };
    let remote: string;
    try { remote = await this.execute('git', ['-c', 'core.hooksPath=/dev/null', 'config', '--get', 'remote.origin.url'], cwd); }
    catch { return { kind: 'unsupported', branch, message: 'No readable origin remote. PR status requires a github.com origin.' }; }
    const repository = githubRepository(remote);
    if (!repository) return { kind: 'unsupported', branch, message: 'PR status supports standard github.com origin URLs only. Other hosts, SSH aliases and credential-bearing URLs are not queried.' };
    const key = JSON.stringify([repository.toLowerCase(), branch]);
    const cached = this.cache.get(key);
    if (cached && this.now() < (refresh ? cached.retryAfter : cached.until)) return cached.value;
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
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      return { kind: 'unavailable', branch, message: missing ?
        'GitHub CLI (gh) was not found. Install it and sign in outside Stingray, then retry.' :
        'PR lookup failed. Check gh authentication, repository access and network, then retry. No login or repository changes were attempted.' };
    }
  }
}
