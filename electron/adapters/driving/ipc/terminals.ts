import type { Handlers } from '../../../../shared/contracts/define';
import type { terminalsContract } from '../../../../shared/contracts/terminals';
import type { GitService } from '../../../core/git';
import type { Terminals } from '../../../core/terminals';

/** openLink is core TerminalLinkOpener.open (dialog + one-at-a-time lock), wired in electron/app. */
export function terminalsHandlers(d: { terminals: Terminals; git: Pick<GitService, 'useWorkspace'>; openLink(id: string, uri: string): Promise<void> }): Handlers<typeof terminalsContract> {
  return {
    terminals: () => d.terminals.list(),
    terminalSnapshot: id => d.terminals.snapshot(id),
    createTerminal: id => d.git.useWorkspace(id, w => d.terminals.create(id, w.path)),
    writeTerminal: (id, data) => d.terminals.write(id, data),
    openTerminalLink: (id, uri) => d.openLink(id, uri),
    resizeTerminal: (id, cols, rows) => d.terminals.resize(id, cols, rows),
    closeTerminal: id => d.terminals.close(id),
  };
}
