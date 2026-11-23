import type { activityContract } from '../../../../shared/contracts/activity';
import type { Handlers } from '../../../../shared/contracts/define';
import type { ActivityService } from '../../../core/activity';

/** setVisible/acknowledge are core ActivityVisibility (window focus check), wired in electron/app. */
export function activityHandlers(d: { activity: ActivityService; setVisible(ids: string[]): void; acknowledge(id: string, terminalId: string, revision: number): void }): Handlers<typeof activityContract> {
  return {
    activity: () => d.activity.snapshot(),
    activityView: ids => d.setVisible(ids),
    acknowledgeActivity: (id, terminalId, revision) => d.acknowledge(id, terminalId, revision),
    dismissActivity: workspaceId => d.activity.dismissRestored(workspaceId),
  };
}
