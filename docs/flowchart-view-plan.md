# Flowchart views — implementation plan

Status: implemented.

Spec: `docs/flowchart-view-spec.md`. Branch: `feature/workflow-diagram`.

## Architecture fit

- A flowchart is computed inside the existing rule engine `evaluate()` (`electron/core/views/rules/engine.ts`), which already
  runs in the CodeGraph child process with a `FileProvider`, the `GraphApi` and tree-sitter grammars
  (`grammars.ts`). The CLI calls the same `evaluate()` in-process, so `stingray-views check` gets it for free.
- `ResolvedView` gains `flowchart: FlowchartStep | null`; `computeView` treats it like `graph` (`evaluated = true`).
- Depth override travels: UI slider → `api.view(id, viewId, { depth })` → IPC `view` (optional 3rd arg, zod-validated)
  → `ViewService.computeView(..., { depth })` (cache key includes depth) → `view.flowchart.depth` overridden before
  `evaluate`.
- UI renders `kind: flowchart` with the existing flow diagram (`src/features/views/views-ui/FlowDiagram.tsx`, `FlowNode.tsx`,
  `FlowEdge.tsx`, `flow-layout.ts`, ELK) plus node shapes per node `kind`, group boxes, edge labels and a depth slider.

## Phase 1 — engine (electron + CLI), no UI

1. Types: `shared/contracts/views.ts` `ViewKind` += `'flowchart'`; `electron/core/views/rules/types.ts` add
   `FlowchartStep { start: { symbol: string; file?: string }; depth: number; include?: string[]; exclude?: string[] }`,
   `ResolvedView.flowchart`, diagnostic `FlowchartDiagnostic { start: string|null; functions: number; nodes: number;
   truncated: boolean; error: string|null }` on `ViewDiagnostics` (optional field, keep old consumers working).
2. Schema: `electron/core/views/rules/schema.ts` parse `flowchart:` (strict keys, depth int 0–4 default 1, safe globs);
   `kind: flowchart` ⇔ `flowchart` present; with `flowchart` the keys `use`/`rules`/`graph` are errors.
   `view-file.ts` passes it into `ResolvedView` (and `graph: null`, `rules: []` for other kinds' defaults stay).
3. New `electron/core/views/flowchart/`:
   - `cfg.ts` — language-neutral construct model (`Seq`, `If{cond, then, else}`, `Switch`, `Loop`, `Try`, `Return`,
     `Raise`, `Call{text, callee, line, awaited}`), built from a tree-sitter function node via an adapter.
   - `python.ts`, `typescript.ts` (ts/tsx/js) — adapters mapping grammar node types to constructs; locate the
     function body by symbol line/name (function, method, arrow function assigned to const).
   - `labels.ts` — tidy condition / call text (spec §Labels); pure, unit-tested.
   - `build.ts` — constructs → `DiagramNode`/`DiagramEdge`/`DiagramGroup`: kinds `start|end|error|action|decision|
     loop|call`, edge kinds `next|yes|no|case|loop|except` with labels; merge points without visible nodes; recursion
     into callees resolved via `GraphApi.outgoing([fnId], ['calls'])` matched by line (fallback: by callee name among
     outgoing targets), honouring depth/include/exclude/scope; groups `call:<symbolId>`; recursion guard; 150-node cap
     with "+N steps" badge; `source` on every node, `symbol` on call/start nodes; dashed when relation not certain.
   - `index.ts` — `runFlowchart(step, graph, files, parse, inScope) → { nodes, edges, groups, diagnostic, truncated }`.
4. Engine: in `evaluate()` run `runFlowchart` when `view.flowchart` (needs graph; no graph → diagnostic error like the
   graph step). Unsupported language → view warning + error diagnostic.
5. CLI (`electron/adapters/driving/cli/views-cli.ts`): `--depth N` override for `check`; text output prints the flowchart as an indented
   tree (decision → Yes:/No: branches) via `shared/views/views-text.ts` or a flowchart-specific printer; JSON unchanged shape.
6. Skill doc: add `flowchart` to the stingray-views SKILL.md source in the repo (find it with `rg -l "Builtin sets"`).
7. Tests (`tests/views/flowchart*.test.ts`, `npm test`): labels; Python + TS fixtures for if/elif/else, nested if, for/while
   with back-edge, try/except/finally, early return, raise/throw, match/switch, await; depth 0/1/2 with a fake
   `GraphApi`; include/exclude; recursion guard; node cap; schema errors.

Acceptance: `npm run build`, `npm test` green; `stingray-views check` on a fixture view prints a correct chart.

## Phase 2 — IPC + UI

1. IPC: `view` handler accepts optional `{ depth: 0..4 }`; preload/`src/app/api.ts` typed; `ViewService.computeView`
   override + cache key; view-changed refresh keeps the current override.
2. UI: `ViewsTab.tsx` routes `flowchart` to the flow diagram; `FlowNode.tsx` shapes (diamond for decision/loop, pill
   for start/end, red pill for error, box for action, box+chevron for call); `FlowEdge.tsx` labels; groups rendered
   as labelled frames (ELK compound nodes in `flow-layout.ts`; nesting via `DiagramGroup.parent`), header click → open
   source; depth slider (0–4, default = `ViewResult.diagnostics.flowchart.depth`, the effective depth set in Phase 1) in the view toolbar,
   session-only; call node "+N steps" hint.
3. Text fallback (`TextViewFallback`/`views-text.ts`) handles flowchart.
4. Tests: `tests/views/views-tab-model.test.ts` / `npm run test:views-tab` with a flowchart fixture.

Acceptance: build + tests green; visual check of a fixture flowchart (Docker test env or `npm run test:views-tab`).

## Phase 3 — validation on travella + review

1. Clone `Merthadam/travella` into a temp dir; add `.stingray/views/auth-login.yaml` (and one agent-node view with
   depth 2); run `stingray-views check` (the in-repo CLI build) and compare against the code by hand; fix engine bugs.
2. Independent review of the diff against spec + plan; fix findings.
3. `npm run build`, `npm test`, relevant `npm run test:*`; push and open PR.
