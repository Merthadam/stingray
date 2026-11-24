// Contract between the Views tab shell (ViewsTab.tsx, lane L3) and the ER diagram (ErDiagram.tsx, lane L2).
import type { ViewLocalState, ViewResult } from '../../../../shared/contracts/views';

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
  /** Open a cloud service's documentation (InfraService.id) in the browser; absent: no Docs link. */
  onOpenServiceDocs?(serviceId: string): void;
  /** User clicked "Save as view…" with the current hidden nodes and positions; the shell shows the dialog. Absent: the
   * button is disabled (a flowchart shown at an overridden depth). */
  onSaveAs?(state: ViewLocalState): void;
  /** Why "Save as view…" is off, as its tooltip (when onSaveAs is absent). */
  saveAsDisabled?: string;
  /** Flowchart drill-down: open (`open`) or close a call by its call path (DiagramNode/DiagramGroup.callPath); the shell
   * recomputes the view. Absent: calls cannot be opened or closed one by one. */
  onToggleCall?(path: string, open: boolean): void;
  /** "Describe…" on flowchart steps and expanded calls: write the `explain:` entry of a node or group id (empty text removes
   * it); the shell recomputes the view. Absent: the button is disabled with `saveExplanationDisabled` as its tooltip. */
  onSaveExplanation?(target: string, text: string): Promise<void>;
  saveExplanationDisabled?: string;
  /** Toolbar slot the shell fills (e.g. Diagnostics toggle, refresh); rendered at the right end of the diagram toolbar. */
  toolbarExtra?: React.ReactNode;
}
