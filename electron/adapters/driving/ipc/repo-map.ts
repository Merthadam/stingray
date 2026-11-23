import type { Handlers } from '../../../../shared/contracts/define';
import type { repoMapContract } from '../../../../shared/contracts/repo-map';
import type { RepoMapService } from '../../../core/repo-map';

export function repoMapHandlers(repoMap: RepoMapService): Handlers<typeof repoMapContract> {
  return { repoSnapshot: id => repoMap.repoSnapshot(id), inspectFile: (id, path) => repoMap.inspectFile(id, path) };
}
