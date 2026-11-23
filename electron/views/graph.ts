// Contract between the view engine and the code-graph host (CodeGraph in a child process, see codegraph-process.ts).
// The engine only depends on these interfaces, so it can be tested with a fake graph.
import type { GraphStatus } from '../../shared/contracts/views';
import type { EvaluateOutput, GraphSymbol, ResolvedView } from './rules/types';

export interface GraphChange {
  /** Worktree-relative POSIX paths whose content changed (added, modified or deleted) since the last event. */
  files: string[];
}

export interface SymbolQuery { file: string; name: string; kinds?: string[] }

export interface WorktreeGraph {
  readonly workspaceId: string;
  readonly root: string;
  status(): GraphStatus;
  /** Fires after changed files were re-synced into the graph (or, without a usable graph, after the fallback watcher saw them). */
  onChange(listener: (change: GraphChange) => void): () => void;
  /** Fires whenever status() changes, e.g. indexing -> ready. */
  onStatus(listener: (status: GraphStatus) => void): () => void;
  /** Look up symbols by exact name, one per query, in its file; null when not found or the graph is not ready. Never rejects. */
  findSymbols(queries: SymbolQuery[]): Promise<(GraphSymbol | null)[]>;
  /** Direct callees per symbol id; null (unknown, not "calls nothing") when the graph is not ready or did not answer. Never rejects. */
  callees(ids: string[]): Promise<Map<string, GraphSymbol[]> | null>;
  /** Every symbol of a file; null when the graph is not ready or did not answer. Never rejects. */
  fileSymbols(file: string): Promise<GraphSymbol[] | null>;
  /** Run the rule engine on the worktree, with the code graph when it is ready (else without). Rejects on engine errors. */
  evaluateView(view: ResolvedView): Promise<EvaluateOutput>;
}

export interface GraphHost {
  /** Get or start the graph for a worktree. Starting is asynchronous: status() reports progress. Never throws. */
  open(workspaceId: string, root: string): WorktreeGraph;
  /** Stop watching and close the graph of one worktree (e.g. worktree removed). */
  close(workspaceId: string): Promise<void>;
  /** Close everything (app quit). */
  closeAll(): Promise<void>;
}
