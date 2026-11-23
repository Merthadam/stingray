import type { ActivityService } from './activity';
import type { TerminalDirectory } from './ports';

/** Which terminals the renderer shows (activity-view) and whether a completion may be acknowledged now. */
export class ActivityVisibility {
  private visible = new Set<string>();
  constructor(private d: { terminals: TerminalDirectory; activity: Pick<ActivityService, 'acknowledge'>; isWindowFocusedAndVisible(): boolean }) {}
  setVisible(ids: string[]) { const known = new Set(this.d.terminals.list().map(t => t.id)); this.visible = new Set(ids.filter(id => known.has(id))); }
  acknowledge(id: string, terminalId: string, revision: number) {
    if (this.d.isWindowFocusedAndVisible() && this.visible.has(terminalId)) this.d.activity.acknowledge(id, terminalId, revision);
  }
  /** A reloading renderer shows nothing until it reports again. */
  reset() { this.visible.clear(); }
}
