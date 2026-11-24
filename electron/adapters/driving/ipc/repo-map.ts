import type { Handlers } from '../../../../shared/contracts/define';
import type { repoMapContract } from '../../../../shared/contracts/repo-map';
import type { RepoMapService } from '../../../core/repo-map';

export function repoMapHandlers(repoMap: RepoMapService): Handlers<typeof repoMapContract> {
  return { repoSnapshot: (id, scope) => repoMap.repoSnapshot(id, scope), inspectFile: (id, path, scope) => repoMap.inspectFile(id, path, scope), statFile: (id, path) => repoMap.statFile(id, path) };
}
