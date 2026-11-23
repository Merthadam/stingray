import { z } from 'zod';
import type { OverlayConflicts } from '@colbymchenry/codegraph';
import { idSchema } from './common';
import { defineContract, returns } from './define';

export const stinggraphContract = defineContract('stinggraph', {
  invoke: {
    /** codegraph.sharedBase: managed worktrees use one shared origin/main index plus an overlay of their commits. Applies when a graph is next opened. */
    settings: [z.tuple([]), returns<{ sharedBase: boolean }>(), { renderer: 'codegraphSettings' }],
    setSharedBase: [z.tuple([z.boolean()]), returns<{ sharedBase: boolean }>(), { renderer: 'setCodegraphSharedBase' }],
    /** File/symbol conflicts and main-moved files between the managed worktrees of this worktree's repo; null when shared base is off or not built. */
    conflicts: [z.tuple([idSchema]), returns<OverlayConflicts | null>(), { renderer: 'codegraphConflicts' }],
  },
  events: {},
});
