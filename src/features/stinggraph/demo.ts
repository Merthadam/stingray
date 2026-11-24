import type { Events, Invoke } from '../../../shared/contracts/define';
import type { stinggraphContract } from '../../../shared/contracts/stinggraph';
import type { DemoContext } from '../../shared/demo-context';

export function createStinggraphDemo(ctx: DemoContext): Invoke<typeof stinggraphContract> & Events<typeof stinggraphContract> {
  return {
    codegraphSettings: async () => ({ sharedBase: false }),
    setCodegraphSharedBase: async () => ({ sharedBase: false }),
    codegraphConflicts: async () => null,
  };
}
