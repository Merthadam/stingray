import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PRRunner } from '../../../core/git';
import { GIT_ENV, runGit } from './runner';

const exec = promisify(execFile);
export const ghRunner: PRRunner = async (command, args, cwd) => {
  if (command === 'git') return runGit(cwd, args, { timeout: 15000, maxBuffer: 1024 * 1024 });
  const env = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', ...GIT_ENV };
  delete (env as NodeJS.ProcessEnv).GH_DEBUG;
  // Finder's PATH may not include Homebrew. Never install or log in automatically.
  const candidates = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
  for (const executable of candidates) {
    try {
      // PR lists are trimmed with --jq (~20 KB for 100 PRs plus headers).
      return (await exec(executable, args, { cwd, env, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || executable === candidates.at(-1)) throw error;
    }
  }
  throw new Error('Command unavailable');
};
