import type { RepoInventory } from '../../../core/repo-map';
import { git, runGit } from './runner';

export const gitInventory: RepoInventory = {
  async run(root, args) {
    try { return await runGit(root, args, { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }); } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      if (args[0] === 'grep' && failure.code === 1 && failure.stdout === '') return '';
      throw new Error('Repository inventory exceeds the 16 MiB / 15 second limit, or Git is unavailable.');
    }
  },
  bytes: (root, args) => runGit(root, args, { timeout: 10000, maxBuffer: 512 * 1024, encoding: 'buffer' }),
  async head(root) {
    try { await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']); return 'born'; } catch {
      const branch = (await git(root, ['symbolic-ref', '-q', 'HEAD'])).trim();
      if (!branch.startsWith('refs/heads/')) throw new Error('HEAD unavailable');
      // Check this exact branch, not all refs: an orphan branch may coexist
      // with other branches/tags. Only exit 1 means absent; corrupt refs and
      // timeouts must remain errors, not turn tracked files into additions.
      try { await runGit(root, ['show-ref', '--verify', '--quiet', branch], { timeout: 10000, maxBuffer: 4096 }); } catch (error) {
        if ((error as { code?: number }).code === 1) return 'unborn';
        throw error;
      }
      throw new Error('HEAD unavailable');
    }
  },
};
