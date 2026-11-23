import { z } from 'zod';
import { idSchema, urlSchema } from './common';
import { defineContract, returns } from './define';
import { repoPathSchema, type State } from './git';

export type EditorId = 'repo-map' | 'vscode' | 'cursor' | 'zed' | 'system';
export interface EditorSettings {
  selected: EditorId;          // 'system' = the OS default app (no line number)
  available: EditorId[];       // detected on this machine; always includes 'repo-map' and 'system'
}
export const EDITOR_IDS = ['repo-map', 'vscode', 'cursor', 'zed', 'system'] as const satisfies readonly EditorId[];

export const appContract = defineContract('app', {
  invoke: {
    state: [z.tuple([]), returns<State>()],
    preview: [z.tuple([idSchema, z.union([z.literal(''), urlSchema])]), returns<State>()],
    editorSettings: [z.tuple([]), returns<EditorSettings>()],
    setEditor: [z.tuple([z.enum(EDITOR_IDS)]), returns<EditorSettings>()],
    /** Open a worktree file (at a 1-based line when the editor supports it) in the selected editor. */
    openSource: [z.tuple([idSchema, repoPathSchema, z.number().int().positive().max(10_000_000).nullable()]), returns<void>()],
  },
  events: {},
});
