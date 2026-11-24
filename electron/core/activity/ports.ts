import type { ActivitySnapshot } from '../../../shared/contracts/activity';
import type { ActivityRecord } from './activity-history';

/** One accepted hook/Pi connection, as seen by core. */
export interface ActivityConnection { end(): void; destroy(): void; readonly destroyed: boolean }
/** 'renew': extend the connection lease; 'stop': stop reading this chunk (connection ended or destroyed). */
export type SessionOutcome = 'continue' | 'renew' | 'stop';
export interface ActivitySession { message(value: unknown): SessionOutcome; closed(): void }
/** Whether a process may still be running (false only when it is known to be gone). */
export interface ProcessProbe { alive(pid: number): boolean }
export interface HistoryRepository { load(now?: number): ActivityRecord[]; save(records: ActivityRecord[], now?: number): void }
/** zsh integration used when terminals start (implemented by driven/fs/activity-shell.ts). */
export interface ShellIntegration { environment(shell: string, env: Record<string, string>): { ZDOTDIR?: string; STINGRAY_USER_ZDOTDIR?: string }; startup: string }
export type ActivityPublisher = (snapshot: ActivitySnapshot) => void;
/** Terminals that exist now (implemented by the terminals service in electron/app). */
export interface TerminalDirectory { list(): { id: string }[] }
