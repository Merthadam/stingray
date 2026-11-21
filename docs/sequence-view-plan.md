# Sequence views — implementation plan

Spec: `docs/sequence-view-spec.md`. Contract: `SequenceData`, `SequenceDiagnostic` in `src/views.ts` (fixed; change
only with a note in the PR). Branch: `feature/sequencediagram`.

## Facts from probing stinggraph (v1.6.2-sting.2) on travella

- `route` nodes exist (e.g. `GET /auth/account`, id `route:services/auth/account.py:645:GET:/auth/account`).
- Frontend → backend: `calls` edge from a client function to the `route` node, `provenance: heuristic`,
  `metadata: { synthesizedBy: "http-client", channel: "http", method, href, registeredAt, tier: "client→server" }`.
- Route → handler: `references` edge from the route to the handler function (`metadata.refName`).
- `GraphRelation` (electron/views/rules/types.ts) drops `metadata`; add `meta?: Record<string, unknown>` and fill it in
  both adapters of `codegraph-api.ts`.
- A ready index of travella for probing: `/tmp/seq-probe` (`CodeGraph.open('/tmp/seq-probe', { readOnly: true })`).

## Status

Phases 1-3 are done; phase 4 is done up to the review/PR. The spec (`docs/sequence-view-spec.md`) describes the
implementation as built. Remaining gaps:

- Link sets: no class dependencies (`Depends(SomeClass)`), library decorators, `include_router(…, dependencies=)` or
  middleware registered in other files (Next.js `middleware.ts`, app-wide ASGI) for `auth`; no LangGraph JS, `Send` /
  `Command(goto=)` routing or subgraphs for `langgraph`; `events` only with literal names. HTTP hops only where
  stinggraph synthesized a client → route edge.
- A link rule's call-site hop is keyed by the callee name only (every call to `from` hops to every `to`).
- Notes are errors only (`kind: 'info'` is unused); externals have no return arrows.
- Fold state and the depth override are session-only (not saved to the view file).
- Validation views on travella live only in `/tmp/seq-probe/.stingray/views` (login, sign-in-route, auth-route,
  agent-run); none are committed to a repo.

## Phase 1 — engine + CLI (`electron/views/sequence/`) — done

1. Types/schema: `SequenceStep` in `rules/types.ts` (`ResolvedView.sequence`), schema in `rules/schema.ts`
   (`KINDS` += sequence; strict keys; depth 0-6 default 3; participants enum; links subset; externals map; start =
   exactly one of symbol|route; kind ⇔ section; rules allowed but only `edge` emits with `kind: link`), `view-file.ts`.
2. Walker: reuse `flowchart/{python,typescript,cfg,labels}.ts` (construct model gives calls in source order inside
   If/Switch/Loop/Try). Resolve each call like `FlowchartBuilder` (outgoing `calls` matched by line, name fallback).
   Build messages depth-first, fragments from enclosing constructs, returns, notes for raise/throw.
3. Participants: `graph.layers()` assignments for service/module; file; class (enclosing class symbol via
   `fileSymbols`). `auto` rule from the spec. Externals via import prefixes (tree-sitter imports of the file).
4. `http` link (from graph metadata) in phase 1; other link sets in phase 2 (keep a `LinkProvider` interface:
   `(fn: GraphSymbol, call?) => Hop[]`).
5. Engine: `evaluate()` runs it when `view.sequence` (like flowchart); `ViewService.computeView` depth override
   (cache key) generalised to sequence; nodes mirror participants; `diagnostics.sequence`.
6. CLI: `--depth` for sequence; text printer in `src/views-text.ts` per the spec.
7. Tests `tests/sequence*.test.ts` with fake `GraphApi` + fixture sources (Python + TSX): ordering, depth, collapse vs
   show, returns, alt/opt/loop/try fragments, http hop, externals, recursion, caps, schema errors, text output.

## Phase 2 — link sets — done

`auth` (FastAPI Depends/Security + decorators + Express/Next middleware), `langgraph` (invoke → nodes in edge order;
reuse `sets/langgraph*.ts` extraction), `events` (emit/publish/send_task/delay ↔ handlers by literal name), custom
`link` rules. Tests per set with fixtures.

## Phase 3 — UI — done (plus "Fold into caller" per participant, zoom)

`src/views-ui/SequenceDiagram.tsx` (+ pure `sequence-layout.ts`, unit-tested): SVG, sticky headers, lifelines,
activation bars from `level`, arrows/labels, fragments, notes, click → `onOpenSource`, participant → Inspector,
depth slider (reuse the flowchart's in `views-tab-model.ts`), text fallback. Route `kind: sequence` in `ViewsTab.tsx`.
`npm run test:views-tab` fixture.

## Phase 4 — validation + review — validation and skill section done; review/PR pending

Views on travella (`/Users/adammerth/Documents/trav3/travella`, copy at `/tmp/seq-probe`): frontend login/register
submit → auth service; an authenticated route with Depends; an agent run (`/v1/agent/...` → LangGraph). Compare with
the code by hand, fix engine bugs. Skill doc section (`rg -l "Builtin sets"` for the in-repo SKILL.md source).
Independent review; `npm run build`, `npm test`, `npm run test:views-tab`; PR.
