export { ActivityService, type ActivityOptions } from './activity';
export { recordSchema, MAX_ACTIVITY_PER_WORKSPACE, MAX_ACTIVITY_AGE_MS, type ActivityRecord } from './activity-history';
export { claudeHookEvents, claudeSettings, harnesses, shellQuote } from './harnesses';
export type { HarnessContext } from './harnesses';
export type { ActivityConnection, ActivityPublisher, ActivitySession, HistoryRepository, ProcessProbe, SessionOutcome, ShellIntegration, TerminalDirectory } from './ports';
export { ActivityVisibility } from './activity-visibility';
