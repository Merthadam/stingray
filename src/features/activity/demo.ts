import type { Events, Invoke } from '../../../shared/contracts/define';
import type { activityContract } from '../../../shared/contracts/activity';
import type { DemoContext } from '../../shared/demo-context';

export function createActivityDemo(ctx: DemoContext): Invoke<typeof activityContract> & Events<typeof activityContract> {
  return {
    // No real Pi runs in the browser demo; never fabricate live activity.
    activity: async () => ({ revision: 0, agents: [] }),
    activityView: async () => undefined,
    acknowledgeActivity: async () => undefined,
    dismissActivity: async () => undefined,
    onActivity: () => () => {},
  };
}
