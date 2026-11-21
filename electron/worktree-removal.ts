import type { RemovalReview } from '../src/shared';

// Inject the existing bounded, noninteractive Git runner. No fetch or remote calls.
export async function reviewPushStatus(run: (args: string[]) => Promise<string>, branch: string): Promise<{
  push: RemovalReview['push']; identity: string;
}> {
  try {
    const upstream = (await run(['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`])).trim();
    if (!upstream) return { push: { kind: 'unknown', message: 'No upstream is configured. Push status is unknown.' }, identity: 'no-upstream' };
    if (!upstream.startsWith('refs/remotes/')) return { push: { kind: 'unknown', message: 'The upstream is a local branch, not a remote-tracking branch. Push status is unknown.' }, identity: upstream };
    const tip = (await run(['rev-parse', '--verify', `${upstream}^{commit}`])).trim();
    const counts = (await run(['rev-list', '--left-right', '--count', `HEAD...${tip}`, '--'])).trim().split(/\s+/);
    if (counts.length !== 2 || counts.some(value => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error('Invalid counts');
    return { push: { kind: 'known', upstream: upstream.slice('refs/remotes/'.length), ahead: Number(counts[0]), behind: Number(counts[1]) }, identity: `${upstream}:${tip}` };
  } catch {
    return { push: { kind: 'unknown', message: 'The upstream could not be checked. Push status is unknown.' }, identity: 'unavailable' };
  }
}

// The branch counts as merged when its tip is contained in the remote default branch (origin/HEAD) or the
// primary checkout's current branch. Squash/rebase merges are not detected, so such branches are simply kept.
export async function mergedInto(repo: string, branch: string, run: (cwd: string, args: string[]) => Promise<string>): Promise<string | null> {
  const targets: string[] = [];
  for (const args of [['rev-parse', '--abbrev-ref', '--verify', '--quiet', 'refs/remotes/origin/HEAD'], ['branch', '--show-current']]) {
    const name = (await run(repo, args).catch(() => '')).trim();
    if (name && name !== branch && name !== 'origin/' + branch && !targets.includes(name)) targets.push(name);
  }
  for (const target of targets) {
    try { await run(repo, ['merge-base', '--is-ancestor', 'refs/heads/' + branch, target]); return target; } catch { /* not merged into this target */ }
  }
  return null;
}
