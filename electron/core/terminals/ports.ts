import type { TerminalEvent } from '../../../shared/contracts/terminals';

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Flow control: stop / restart reading the PTY. */
  pause(): void;
  resume(): void;
}
export interface PtySpawner {
  /** The user's login shell. */
  shell(): string;
  /** The environment to start from (core removes Electron/Stingray control variables). */
  env(): Record<string, string | undefined>;
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): PtyProcess;
}
export interface TerminalMirrorPort {
  /** `done` runs once xterm has parsed the chunk (or the write failed). */
  write(data: string, sequence: number, done?: () => void): void;
  resize(cols: number, rows: number): void;
  snapshot(): Promise<{ data: string; sequence: number }>;
  dispose(): void;
}
export type MirrorFactory = (cols: number, rows: number) => TerminalMirrorPort;
export type TerminalPublisher = (event: TerminalEvent) => void;
export interface LinkTargets {
  /** `new URL(input, <workspace folder as a file: URL with a trailing slash>)`; throws on invalid input. */
  resolveUrl(input: string, workspace: string): URL;
  /** Real path of a file: URL's target and whether it is inside the real workspace folder; rejects when unavailable. */
  realTarget(url: URL, workspace: string): Promise<{ target: string; inside: boolean }>;
  /** stat (following the real path); rejects when unavailable. */
  stat(target: string): Promise<{ isFile: boolean; isDirectory: boolean; mode: number }>;
}
export interface LinkActions {
  confirm(link: { kind: 'web' | 'file' | 'reveal'; target: string }): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  openPath(file: string): Promise<string>;
  showItemInFolder(file: string): void;
}
