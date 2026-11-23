// The one git runner: no repository hooks or fsmonitor programs, no prompts, no optional locks.
// Callers keep their own timeouts, buffer limits and error wrapping.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const GIT_SAFE_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
export const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
export type RunGitOptions = { timeout?: number; maxBuffer?: number; env?: Record<string, string> };

export async function runGit(cwd: string, args: string[], options?: RunGitOptions): Promise<string>;
export async function runGit(cwd: string, args: string[], options: RunGitOptions & { encoding: 'buffer' }): Promise<Buffer>;
export async function runGit(cwd: string, args: string[], options: RunGitOptions & { encoding?: 'buffer' } = {}): Promise<string | Buffer> {
  const { stdout } = await exec('git', [...GIT_SAFE_CONFIG, ...args], {
    cwd, timeout: options.timeout ?? 30000, maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    encoding: options.encoding ?? 'utf8', env: { ...process.env, ...GIT_ENV, ...options.env },
  });
  return stdout;
}

/** First `fatal:`/`error:` stderr line (git prints progress such as "Preparing worktree" first), else the first
 *  non-empty line: control characters stripped, URL credentials redacted, at most 200 characters. */
export function gitFailureDetail(error: unknown): string {
  const stderr = String((error as { stderr?: unknown })?.stderr ?? '');
  const lines = stderr.split('\n').map(l => l.replace(/[\x00-\x1f\x7f]/g, '').trim()).filter(Boolean);
  const line = lines.find(l => /^(fatal|error):/.test(l)) ?? lines[0] ?? '';
  return line.replace(/:\/\/[^/@\s]*@/g, '://<redacted>@').slice(0, 200);
}

/** Bounded git for workspace operations, with a fixed, user-facing failure message. Implements the core GitRunner port. */
export async function git(cwd: string, args: string[], options: { timeout?: number; maxBuffer?: number } = {}): Promise<string> {
  try { return await runGit(cwd, args, { timeout: options.timeout ?? 30000, maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024 }); } catch (error) {
    const detail = gitFailureDetail(error);
    throw new Error(`Git operation failed${detail ? `: ${detail.replace(/\.$/, '')}` : ''}. Check the repository, branch, and worktree on disk. No force operation was attempted.`);
  }
}
