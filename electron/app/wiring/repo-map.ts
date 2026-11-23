import type { GitStatus } from '../../../shared/contracts/git';
import { gitInventory } from '../../adapters/driven/git/inventory';
import { nodeWorkingFiles } from '../../adapters/driven/fs/working-files';
import { RepoMapService, repoSnapshot as coreRepoSnapshot, type RepoMapDeps } from '../../core/repo-map';
import './core-ports';

export const repoMapPorts = { inventory: gitInventory, files: nodeWorkingFiles };
export { parseNumstat } from '../../core/repo-map';
export { readWorkingFile } from '../../adapters/driven/fs/working-files';
export const repoSnapshot = (root: string, status: GitStatus, withStats = true) => coreRepoSnapshot(root, status, withStats, repoMapPorts);
export const createRepoMapService = (git: RepoMapDeps['git']) => new RepoMapService({ git, ...repoMapPorts });
