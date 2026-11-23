import { watch } from 'node:fs';
import path from 'node:path';
import type { GitDirWatcher } from '../../../core/git';
import { git } from './runner';

export const nodeGitDirWatcher: GitDirWatcher = {
  async gitDirs(workspacePath) {
    const [gitDir, common] = (await git(workspacePath, ['rev-parse', '--git-dir', '--git-common-dir'])).trim().split('\n').map(dir => path.resolve(workspacePath, dir));
    return { gitDir, common };
  },
  watch: (common, onChange) => watch(common, { recursive: true }, (_event, filename) => onChange((filename?.toString() ?? '').split(path.sep).join('/'))),
};
