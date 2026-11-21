# `explain:` fingerprints with callees — implementation plan

Spec: `docs/explain-fingerprints-spec.md`. Base: `origin/main`. One branch per work package, merged into an integration
branch `feat/explain-callee-fingerprints`, one PR.

Detailed, subagent-ready briefs per package: `docs/explain-fingerprints/wp1-graph-plumbing.md`,
`wp2-fingerprint-engine.md`, `wp3-cli.md`, `wp4-ui.md`. The sections below are the summary.

## Shared contracts (fix these first; every package codes against them)

```ts
// electron/views/rules/types.ts
export interface GraphSymbol { /* existing */ qualifiedName?: string }   // CodeGraph Node.qualifiedName

// electron/views/compute.ts
export interface ComputeDeps {
  /* existing */
  /** Direct `calls` targets per symbol id (heuristic relations included), in-repo symbols only; [] when unknown. */
  callees?: (ids: string[]) => Promise<Map<string, GraphSymbol[]>>;
  /** Every symbol of a file (for class → constructor); [] when unknown. */
  fileSymbols?: (file: string) => Promise<GraphSymbol[]>;
}

// src/views.ts
export type ExplanationStatus = 'view' | 'stale' | 'unstamped' | 'legacy';
// DiagramNode and DiagramGroup gain: explanationReason?: string
export interface ExplainChanges { changed: string[]; added: string[]; removed: string[] }
export interface ExplainDiagnostic {
  key: string; line: number | null; matches: number;
  fingerprint: string | null;              // summary hash of `pieces` (display only)
  pieces: Record<string, string> | null;   // what --restamp writes; null when not computable
  skipped: string[];                        // callees left out (unhashable)
  status: ExplanationStatus | null;         // null when unresolved
  changes: ExplainChanges;                  // empty unless stale
  files: string[];                          // files of all pieces (targets + callees)
}

// electron/views/rules/schema.ts — ExplainEntry
fingerprint: string | Record<string, string> | null
```

## WP1 — graph plumbing (callees + qualified names)

Files: `electron/views/rules/codegraph-api.ts`, `electron/views/rules/types.ts`, `electron/views/graph.ts`,
`electron/codegraph.ts`, `electron/codegraph-process.ts`, `electron/views/service.ts`, `electron/views-cli.ts`
(deps wiring only), tests.

1. `symbol()` mappers in `codegraph-api.ts` (both the CodeGraph and the overlay adapters) add `qualifiedName`.
2. A `callees(ids)` helper over `GraphApi`: `outgoing(ids, ['calls'])` → `symbols(targets)`, grouped by source id,
   de-duplicated. Put it next to the adapters (e.g. `electron/views/rules/callees.ts`) so the CLI and the child share
   it. Library calls are naturally absent because they are not graph nodes. Overlay dangling edges are already dropped.
3. App path: mirror `findSymbols` end-to-end, i.e. a new IPC message `callees` / `fileSymbols` in `codegraph.ts` (child
   handler around line 346, parent method around line 66), `codegraph-process.ts` (Call union around line 18, method
   around line 89), and the interface in `views/graph.ts`. Return empty results when the graph isn't ready. Wire them
   into `ComputeDeps` in `service.ts` (around line 95).
4. CLI path: wire `callees` / `fileSymbols` from the in-process `GraphApi` in `views-cli.ts` (next to `findSymbols`,
   around line 136).
5. Tests: the helper with a fake `GraphApi` (grouping, dedupe, unknown ids → []); `qualifiedName` mapping.

Acceptance: `npm run build`, `npm test` green. No behaviour change yet.

## WP2 — fingerprint engine (`electron/views/explain.ts`, schema, types)

Files: `electron/views/explain.ts`, `electron/views/rules/schema.ts`, `src/views.ts`, `electron/views/compute.ts`
(pass the new deps through), `tests/explain.test.ts`.

1. Schema: `fingerprint` = 12-hex string **or** map (keys 1–500 chars, values 12 hex, ≤ 200 keys); keep the quoting
   error message for all-digit values. `ExplainEntry.fingerprint` type as in the contracts.
2. `collectPieces(targets, deps)` → `{ pieces, skipped, why? }` per the spec §Pieces: own body keyed by `qualifiedName`
   (fall back to `${file}::${name}` when absent), direct callees via `deps.callees`, class → constructor via
   `deps.fileSymbols` (method named `__init__`/`constructor` within the class's line range), skip recursion and
   duplicates, keep excluded-file callees, unhashable callee → `skipped`, unhashable target → `why`, > 200 → `why`.
   Non-symbol targets → `drawn:<id>`.
3. `compareFingerprint(stored, current)` → status + `ExplainChanges` (pure). String stored → `legacy`. Missing →
   `unstamped`.
4. `describeChanges(key, changes)` → the warning text (spec §Status and messages: ≤ 3 per category, `(+N more)`, short
   names when unique, `drawn:` wording). Set `explanationStatus` and `explanationReason` on the targets; diagnostics as
   in the contracts; `fingerprint` = hash of the sorted `key=value` lines.
5. Without `verify` (graph not ready): unchanged behaviour, except string-stamped entries still report `legacy`.
6. `compute.ts`: pass `callees` / `fileSymbols` into `applyExplain`. When they're missing (old callers), treat callees
   as empty.
7. Tests: everything listed in spec acceptance #7 that isn't CLI-related, with a fake source reader and fake deps.

Acceptance: build + `npm test` green, and the existing explain tests updated to the map format.

## WP3 — CLI (`electron/views-cli.ts`, text output, docs)

Depends on WP2 (diagnostics shape). Files: `electron/views-cli.ts`, `src/views-text.ts`,
`agents/skills/stingray-views/SKILL.md`, CLI tests.

1. `--restamp` writes `pieces` as a YAML map (replace string/old map; keep comments). Use `files` from the diagnostic
   for the lagging guard. Change the output wording to `stamped "K" (N pieces)`.
2. `--strict`: after the normal output, count entries whose `status` is `stale | unstamped | legacy`. Print
   `strict: N explanation(s) need review` and exit 1 when N > 0. `--strict --restamp` → error, exit 2. Update the help
   text.
3. `views-text.ts`: the `legacy` suffix is `(old fingerprint)`.
4. SKILL.md: document the map format, what's covered (body + direct in-repo callees), the warnings, `--strict`.
5. Tests: restamp of a map (comments kept, string → map), strict exit codes, flag conflict.

## WP4 — UI (reason in tooltip / Inspector, `legacy` status)

Files: `src/views-ui/` (`StaleMark`, `explanationTitle`, `Inspector.tsx`, `FlowDiagram.tsx`, `FlowNode.tsx`,
`TableNode.tsx`), CSS, UI tests if present. It only depends on the contract types.

1. `StaleMark`: `legacy` renders like stale but muted, labelled "old fingerprint".
2. `explanationTitle(text, status, reason)`: append the reason ("may be outdated: SessionStore.get_user changed").
3. Inspector (node and group): show the reason under the explanation when it's stale or legacy.
4. Verify in the disposable env (`scripts/test-env.sh up --detach`, CDP screenshot) with a view that has one stale
   entry.

## Order

- **Phase 1 (parallel, separate worktrees):** WP1, WP2, WP4, all coding against the contracts. WP2 uses fakes for
  `callees` / `fileSymbols`.
- **Phase 2:** merge WP1 + WP2 + WP4 into `feat/explain-callee-fingerprints`, then WP3 on top.
- **Phase 3:** independent review of the whole diff. Verify acceptance on a Travella clone in `/tmp` (no Travella
  commits), fix findings, build + test, then open the PR.
