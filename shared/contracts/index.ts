import { activityContract } from './activity';
import { appContract } from './app';
import type { Events, Invoke } from './define';
import { gitContract } from './git';
import { repoMapContract } from './repo-map';
import { runtimeContract } from './runtime';
import { stinggraphContract } from './stinggraph';
import { terminalsContract } from './terminals';
import { viewsContract } from './views';

/** Every contract with routes or events (db-schema is types only). */
export const contracts = [appContract, gitContract, repoMapContract, terminalsContract, activityContract, stinggraphContract, viewsContract, runtimeContract] as const;

export type DesktopAPI = { mode: 'desktop' | 'demo' }
  & Invoke<typeof appContract> & Events<typeof appContract>
  & Invoke<typeof gitContract> & Events<typeof gitContract>
  & Invoke<typeof repoMapContract> & Events<typeof repoMapContract>
  & Invoke<typeof terminalsContract> & Events<typeof terminalsContract>
  & Invoke<typeof activityContract> & Events<typeof activityContract>
  & Invoke<typeof stinggraphContract> & Events<typeof stinggraphContract>
  & Invoke<typeof viewsContract> & Events<typeof viewsContract>
  & Invoke<typeof runtimeContract> & Events<typeof runtimeContract>;
