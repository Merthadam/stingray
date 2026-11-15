// Contract between the Views tab shell (ViewsTab.tsx, lane L3) and the ER diagram (ErDiagram.tsx, lane L2).
import type { ViewLocalState, ViewResult } from '../views';

export const EMPTY_LOCAL_STATE: ViewLocalState = { hidden: [], positions: {}, expanded: [] };

export interface ErDiagramProps {
  /** Latest computed tables view. A new object arrives on every live update; diff against the previous one. */
  result: ViewResult;
  /** Local state loaded by the shell (EMPTY_LOCAL_STATE when none). The diagram owns it while mounted. */
  initialState: ViewLocalState;
  /** Called (debounced by the shell) whenever filters, positions or expansions change. */
  onStateChange(state: ViewLocalState): void;
  /** Open a worktree file at a line (the shell routes it to api.openSource). */
  onOpenSource(file: string, line: number | null): void;
  /** User clicked "Save as view…" with the current hidden nodes and positions; the shell shows the dialog. */
  onSaveAs(state: ViewLocalState): void;
  /** Toolbar slot the shell fills (e.g. Diagnostics toggle, refresh); rendered at the right end of the diagram toolbar. */
  toolbarExtra?: React.ReactNode;
}
