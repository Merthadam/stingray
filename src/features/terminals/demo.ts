import type { Events, Invoke } from '../../../shared/contracts/define';
import type { terminalsContract } from '../../../shared/contracts/terminals';
import type { DemoContext } from '../../shared/demo-context';

export function createTerminalsDemo(ctx: DemoContext): Invoke<typeof terminalsContract> & Events<typeof terminalsContract> {
  return {
    terminals: async () => ctx.terminals.map(({ buffer: _, ...t }) => structuredClone(t)),
    terminalSnapshot: async id => {
      const t = ctx.terminals.find(t => t.id === id); if (!t) throw new Error('Terminal not found.');
      return { id, data: t.buffer, sequence: t.sequence, cols: 100, rows: 30 };
    },
    createTerminal: async workspaceId => {
      if (ctx.terminals.length >= 24) throw new Error('Terminal limit reached.');
      const t = { id: crypto.randomUUID(), workspaceId, title: 'Terminal ' + (ctx.terminals.length + 1), exited: false, sequence: 0, buffer: '\x1b[38;2;224;120;80mStingray\x1b[0m · browser demo\r\n\r\nSimulated terminal. Commands are not executed.\r\nUse the Electron app for a real shell and installed agents.\r\n\r\n❯ ' };
      ctx.terminals.push(t); const { buffer: _, ...info } = t; return info;
    },
    writeTerminal: async (id, data) => {
      const output = data === '\r' ? '\r\nDemo only — no command was executed.\r\n❯ ' : data === '\x7f' ? '\b \b' : data;
      const t = ctx.terminals.find(t => t.id === id); if (t) t.buffer = (t.buffer + output).slice(-128 * 1024);
      const sequence = t ? ++t.sequence : 0;
      ctx.terminalListeners.forEach(fn => fn({ id, data: output, sequence }));
    },
    openTerminalLink: async () => { throw new Error('Opening terminal links requires the desktop app. No external app was opened.'); },
    resizeTerminal: async () => undefined,
    closeTerminal: async id => { ctx.terminals = ctx.terminals.filter(t => t.id !== id); },
    onTerminal: fn => { ctx.terminalListeners.add(fn); return () => { ctx.terminalListeners.delete(fn); }; },
  };
}
