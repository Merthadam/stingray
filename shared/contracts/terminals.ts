import { z } from 'zod';
import { idSchema } from './common';
import { defineContract, event, returns } from './define';

export type TerminalInfo = { id: string; workspaceId: string; title: string; exited: boolean; sequence: number; cols?: number; rows?: number; piTracking?: 'available' | 'unavailable' };
/** Scrollback lines kept by terminal panes and the main-process mirror they restore from. */
export const terminalScrollback = 5000;
/** Serialized screen/scrollback/modes of a terminal at `sequence`, at the PTY's size. */
export type TerminalSnapshot = { id: string; data: string; sequence: number; cols: number; rows: number; exitCode?: number };
export type TerminalEvent = { id: string; data?: string; exitCode?: number; sequence?: number };

export const terminalsContract = defineContract('terminals', {
  invoke: {
    terminals: [z.tuple([]), returns<TerminalInfo[]>()],
    terminalSnapshot: [z.tuple([idSchema]), returns<TerminalSnapshot>()],
    createTerminal: [z.tuple([idSchema]), returns<TerminalInfo>()],
    writeTerminal: [z.tuple([idSchema, z.string().max(65536)]), returns<void>()],
    openTerminalLink: [z.tuple([idSchema, z.string().min(1).max(8192)]), returns<void>()],
    resizeTerminal: [z.tuple([idSchema, z.number().int().min(2).max(500), z.number().int().min(1).max(300)]), returns<void>()],
    closeTerminal: [z.tuple([idSchema]), returns<void>()],
  },
  events: { onTerminal: event<TerminalEvent>() },
});
