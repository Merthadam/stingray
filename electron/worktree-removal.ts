import { createHash } from 'node:crypto';
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

export function removalToken(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
