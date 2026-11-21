# WP1 — graph plumbing: callees and qualified names

Spec: `docs/explain-fingerprints-spec.md` (§Pieces). Overview and shared contracts: `docs/explain-fingerprints-plan.md`.
Branch: `feat/efp-graph` (from the integration branch). Runs in parallel with WP2 and WP4.

## Goal

Give the view engine two new lookups, available both in the app (CodeGraph runs in a child process) and in the CLI (the
graph runs in-process), and add the code graph's qualified name to `GraphSymbol`. This package changes no behaviour;
WP2 consumes these lookups.

## Read first

- `electron/views/rules/types.ts`: `GraphSymbol`, `GraphRelation`, `GraphApi`
- `electron/views/rules/codegraph-api.ts`: `symbol()` mapper and both adapters (CodeGraph, overlay)
- `electron/views/graph.ts`: `WorktreeGraph`, `SymbolQuery`
- `electron/codegraph.ts`: `Graph.findSymbols` (~L66, has its own node→symbol mapping) and the child message switch
  (~L346, `case 'findSymbols'`)
- `electron/codegraph-process.ts`: `Call` / `Reply` unions (~L18) and `ProxyGraph.findSymbols` (~L89)
- `electron/views/service.ts` `compute()` (~L82) and `electron/views-cli.ts` `check()` (~L130): where `ComputeDeps` is built
- `tests/view-service.test.ts` `FakeGraph`, `tests/codegraph-process.test.ts`, `tests/codegraph-api.test.ts`

## Steps

1. **`GraphSymbol.qualifiedName?: string`** (`types.ts`). Fill it from `Node.qualifiedName` everywhere a CodeGraph node
   becomes a `GraphSymbol`: `symbol()` in `codegraph-api.ts` (shared by both adapters) and the inline mapping in
   `Graph.findSymbols` (`codegraph.ts`). Leave it out when empty.
2. **Shared helper** `electron/views/rules/callees.ts`:
   ```ts
   /** Direct `calls` targets per source id (heuristic relations included), de-duplicated, in-repo symbols only. */
   export function calleesOf(graph: GraphApi, ids: string[]): Map<string, GraphSymbol[]>
   ```
   `graph.outgoing(ids, ['calls'])` → `graph.symbols(uniqueTargets)` → grouped by `from`. Every requested id gets an
   entry (`[]` when it has none). Targets with no symbol (dangling or external) are dropped. Order by file, then line.
3. **`WorktreeGraph`** (`views/graph.ts`) gains two methods that never reject:
   ```ts
   /** Direct callees per symbol id; empty lists when the graph is not ready. */
   callees(ids: string[]): Promise<Map<string, GraphSymbol[]>>;
   /** Every symbol of a file; [] when the graph is not ready. */
   fileSymbols(file: string): Promise<GraphSymbol[]>;
   ```
   - `Graph` (`codegraph.ts`): build a `GraphApi` over its `cg`/`overlay` the way the evaluator already does (search for
     `createGraphApi` / `createOverlayGraphApi` usage in this file) and use `calleesOf` / `api.fileSymbols`. It's
     ready-gated like `findSymbols`.
   - Child protocol: new `Call` variants `{ type: 'callees'; workspaceId; ids }` and `{ type: 'fileSymbols';
     workspaceId; file }`, with handlers next to `case 'findSymbols'`. A `Map` does not survive IPC, so send
     `[id, GraphSymbol[]][]` and rebuild the Map in `ProxyGraph`. Widen the `Reply.result` union.
   - `ProxyGraph` (`codegraph-process.ts`): ready-gated like `findSymbols`; on a bad reply return empty results.
   - Update every other `WorktreeGraph` implementation (`FakeGraph` in `tests/view-service.test.ts`, plus any the
     compiler finds).
4. **`ComputeDeps`** (`electron/views/compute.ts`): add the optional fields from the plan's contracts (`callees`,
   `fileSymbols`). Don't use them in `compute.ts` (WP2 does that). Wire them in:
   - `service.ts` `compute()`: `callees: ids => w.graph.callees(ids)`, `fileSymbols: f => w.graph.fileSymbols(f)`.
     Don't wire them for the database view path (it doesn't call `applyExplain`).
   - `views-cli.ts` `check()`: from the in-process `api` (`api ? calleesOf(api, ids) : new Map()`, and
     `api?.fileSymbols(f) ?? []`).

## Tests (`npm test`)

- `calleesOf` with a fake `GraphApi`: grouping by source, de-duplication, heuristic (`certain: false`) relations kept,
  dangling targets dropped, ids without calls → `[]`.
- `codegraph-api`: `qualifiedName` is mapped (extend the existing test).
- `codegraph-process`: a `callees` round-trip through the proxy (if the existing test harness spawns a child, follow
  that pattern; otherwise unit-test the Map ⇄ entries conversion).

## Acceptance

- `npm run build` and `npm test` green (the 4 known activity-shell failures on main are pre-existing; don't fix them).
- No change in view output for existing views.

## Rules

- Touch only the files above plus tests. Don't edit `electron/views/explain.ts`, `schema.ts`, `src/views.ts` or UI files
  (other packages own them).
- Commit in small steps on your branch. Don't push and don't open PRs. Report the commits, what you verified, and
  anything that deviates from this plan.
