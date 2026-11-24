import type { TerminalInfo } from '../../../shared/contracts/terminals';
import type { LinkActions, LinkTargets } from './ports';
import { openTerminalLink, type TerminalLink } from './terminal-links';

/** One terminal-link confirmation at a time; the link is resolved inside the terminal's workspace. */
export class TerminalLinkOpener {
  private opening = false;
  constructor(private d: { terminals: { list(): TerminalInfo[] }; workspacePath(workspaceId: string): Promise<string>;
    confirm(link: TerminalLink): Promise<boolean>; actions: Omit<LinkActions, 'confirm'>; targets: LinkTargets }) {}
  async open(id: string, uri: string): Promise<void> {
    if (this.opening) throw new Error('Finish the current link confirmation first.');
    const terminal = this.d.terminals.list().find(t => t.id === id);
    if (!terminal) throw new Error('Terminal not found.');
    this.opening = true;
    try { await openTerminalLink(uri, await this.d.workspacePath(terminal.workspaceId), { confirm: this.d.confirm, ...this.d.actions }, this.d.targets); }
    finally { this.opening = false; }
  }
}
