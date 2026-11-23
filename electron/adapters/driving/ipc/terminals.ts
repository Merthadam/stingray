import type { Handlers } from '../../../../shared/contracts/define';
import type { terminalsContract } from '../../../../shared/contracts/terminals';
import type { GitService } from '../../../core/git';
import type { Terminals } from '../../../core/terminals';

/** openLink stays a main-process callback (dialog + one-at-a-time lock) until plan 06 moves it into core TerminalLinkOpener. */
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
