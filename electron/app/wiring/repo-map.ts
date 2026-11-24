import type { GitStatus } from '../../../shared/contracts/git';
import type { RepoMapScope } from '../../../shared/contracts/repo-map';
import { gitInventory } from '../../adapters/driven/git/inventory';
import { nodeWorkingFiles } from '../../adapters/driven/fs/working-files';
import { RepoMapService, repoSnapshot as coreRepoSnapshot, type RepoMapDeps } from '../../core/repo-map';
import './core-ports';

export const repoMapPorts = { inventory: gitInventory, files: nodeWorkingFiles };
export { parseNumstat } from '../../core/repo-map';
export { readWorkingFile } from '../../adapters/driven/fs/working-files';
export const repoSnapshot = (root: string, status: GitStatus, withStats = true, scope: RepoMapScope = 'branch') => coreRepoSnapshot(root, status, withStats, repoMapPorts, scope);
export const createRepoMapService = (git: RepoMapDeps['git']) => new RepoMapService({ git, ...repoMapPorts });
