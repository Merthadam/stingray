import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Change, GitLineStats } from '../../../shared/contracts/git';

const exec = promisify(execFile);
export type LineRunner = (cwd: string, args: string[]) => Promise<string>;
const run: LineRunner = async (cwd, args) => {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, timeout: 10000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
};

// -z keeps tabs/newlines in names unambiguous; renames have two extra NUL fields.
export function parseNumstat(output: string): Extract<GitLineStats, { kind: 'available' }> {
  const result = { kind: 'available' as const, added: 0, deleted: 0, binaryFiles: 0 };
  if (!output) return result;
  if (!output.endsWith('\0')) throw new Error('Incomplete line statistics');
  const fields = output.slice(0, -1).split('\0');
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]);
    if (!match) throw new Error('Invalid line statistics');
    if (!match[3]) {
      if (!fields[i + 1] || !fields[i + 2]) throw new Error('Incomplete rename');
      i += 2;
    }
    if (match[1] === '-' && match[2] === '-') result.binaryFiles++;
    else {
      if (match[1] === '-' || match[2] === '-') throw new Error('Invalid binary statistics');
      result.added += Number(match[1]); result.deleted += Number(match[2]);
      if (!Number.isSafeInteger(result.added) || !Number.isSafeInteger(result.deleted)) throw new Error('Line statistics overflow');
    }
  }
  return result;
}

// base: HEAD for uncommitted edits, or a merge-base commit for the PR-style branch diff.
export async function readGitLines(cwd: string, changes: Change[], runner: LineRunner = run, base = 'HEAD'): Promise<GitLineStats> {
  if (changes.some(change => ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(change.status))) {
    return { kind: 'unavailable', message: 'Resolve merge conflicts before reading line counts.' };
  }
  try {
    // Net tracked working-tree diff against the base, not a sum of index and worktree diffs.
    // Unborn HEAD, timeouts, oversized output and failed reads remain unavailable.
    const output = await runner(cwd, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv',
      '--find-renames', '--ignore-submodules=all', base, '--']);
    return parseNumstat(output);
  } catch {
    return { kind: 'unavailable', message: 'Line counts unavailable. A readable HEAD commit is required; retry after checking repository access.' };
  }
}

// Like a GitHub PR diff: compare from where HEAD forked from the local origin/main (never fetched here).
// null when origin/main is missing, HEAD is unborn or the histories are unrelated.
export async function originMainBase(cwd: string, runner: LineRunner = run): Promise<string | null> {
  try {
    const base = (await runner(cwd, ['merge-base', 'HEAD', 'refs/remotes/origin/main'])).trim();
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base) ? base : null;
  } catch { return null; }
}
