// Terminals core + real adapters under the names and signatures the rest of the app and the existing tests use.
import type { TerminalEvent } from '../../../shared/contracts/terminals';
import { nodeLinkTargets } from '../../adapters/driven/fs/link-targets';
import { headlessMirrors, nodePtySpawner } from '../../adapters/driven/pty/node-pty';
import type { ActivityService, ShellIntegration } from '../../core/activity';
import { Terminals as CoreTerminals, openTerminalLink as coreOpen, resolveTerminalLink as coreResolve, type LinkActions } from '../../core/terminals';

export { prependPath } from '../../core/terminals';
export type { TerminalLinkActions } from '../../core/terminals';
export class Terminals extends CoreTerminals {
  constructor(send: (event: TerminalEvent) => void, activity?: ActivityService, shell?: ShellIntegration) {
    super({ send, pty: nodePtySpawner, mirrors: headlessMirrors, activity, shell });
  }
}
export const resolveTerminalLink = (input: string, workspace: string) => coreResolve(input, workspace, nodeLinkTargets);
export const openTerminalLink = (input: string, workspace: string, actions: LinkActions) => coreOpen(input, workspace, actions, nodeLinkTargets);
