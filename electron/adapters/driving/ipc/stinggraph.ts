import type { Handlers } from '../../../../shared/contracts/define';
import type { stinggraphContract } from '../../../../shared/contracts/stinggraph';
import type { ConflictsSource, StinggraphSettings } from '../../../core/stinggraph';

export function stinggraphHandlers(d: { settings: StinggraphSettings; host: ConflictsSource }): Handlers<typeof stinggraphContract> {
  return {
    codegraphSettings: () => ({ sharedBase: d.settings.sharedBaseEnabled() }),
    setCodegraphSharedBase: enabled => d.settings.setSharedBase(enabled),
    codegraphConflicts: id => { const shared = d.settings.sharedBaseWorkspaces(id); return shared ? d.host.conflicts(shared.target, shared.workspaceIds) : null; },
  };
}
