import type { Handlers } from '../../../../shared/contracts/define';
import type { gitContract, State } from '../../../../shared/contracts/git';
import type { GitService, GitStateService } from '../../../core/git';

export function gitHandlers(d: {
  git: GitService; gitState: GitStateService;
  pickFolder(title: string): Promise<string | null>;
  cloneRepository(url: string, destination: string): Promise<State>;
}): Handlers<typeof gitContract> {
  return {
    pickRepository: async () => { const folder = await d.pickFolder('Open a trusted Git repository'); return folder === null ? null : d.git.openRepository(folder); },
    openRepository: p => d.git.openRepository(p),
    pickCloneParent: () => d.pickFolder('Choose a parent folder for the new clone'),
    // Validate values in the service with fixed errors (no Zod payload echo).
    cloneRepository: (url, destination) => d.cloneRepository(url, destination),
    createWorkspace: (id, branch) => d.git.createWorkspace(id, branch),
    reviewRemoval: id => d.git.reviewRemoval(id),
    removeWorkspace: (id, consent) => d.git.removeWorkspace(id, consent),
    gitState: id => d.gitState.get(id),
    refreshGitState: id => d.gitState.refresh(id, true),
    selectWorkspace: id => d.gitState.select(id),
  };
}
