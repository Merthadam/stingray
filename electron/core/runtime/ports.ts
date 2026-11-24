import type { LiveViewEvent } from '../../../shared/contracts/runtime';

/** Runs ps/lsof with bounded output (lsof exit 1 with no output is ''); rejects with the scan error. */
export type PortScanner = (file: string, args: string[]) => Promise<string>;
export type DockerRunner = (args: string[], options?: { timeout?: number; stderr?: boolean }) => Promise<string>;
export interface DockerSocketFiles {
  /** Existing, non-directory Colima docker.sock paths under `home` (~/.colima/docker.sock and each profile's). */
  colimaSockets(home: string): Promise<string[]>;
  /** realpath, or the input when it cannot be resolved. */
  realpath(path: string): Promise<string>;
}
export interface CdpSocket { readonly open: boolean; send(text: string): void; close(): void; onMessage(listener: (data: string) => void): void; onClose(listener: () => void): void }
export interface CdpConnection {
  /** GET http://127.0.0.1:<port>/json/list (3 s); rejects on any failure. */
  list(port: number): Promise<unknown>;
  /** WebSocket to the page target; rejects with "Timed out connecting to the test instance." / "Could not connect to the test instance.". */
  connect(port: number, targetId: string): Promise<CdpSocket>;
}
export interface Clipboard { writeText(text: string): void }
/** Opens a URL in a named macOS app (`open -a`); false when that failed. */
export type AppOpener = (app: string, url: string) => Promise<boolean>;
export type LiveViewPublisher = (event: LiveViewEvent) => void;
