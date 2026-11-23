// Shared browser-demo state, owned by src/demo.ts and passed to every feature's createXDemo(ctx).
import type { RepoFile } from '../../shared/contracts/repo-map';
import type { State } from '../../shared/contracts/git';
import type { TerminalEvent, TerminalInfo } from '../../shared/contracts/terminals';

export interface DemoContext {
  state: State;
  terminals: (TerminalInfo & { buffer: string })[];
  terminalListeners: Set<(event: TerminalEvent) => void>;
  snapshot(): State;
  save(): State;
  mainId: string;
  files: RepoFile[];
  content(path: string): string;
  uncommitted: { kind: 'available'; added: number; deleted: number; binaryFiles: number };
}
