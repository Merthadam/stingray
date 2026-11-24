# Flowchart views — design spec

Status: implemented. Branch: `feature/workflow-diagram`.

## Goal

A new view kind, `flowchart`, that draws a classic flowchart — start/end pills, action boxes, decision diamonds with
Yes/No arrows, loops — for one entry function, computed statically from the worktree. No code runs and no LLM is
involved: the code graph supplies *which functions* are involved, tree-sitter supplies *the logic inside them*.

## Decisions

| # | Question | Decision |
| --- | --- | --- |
| 1 | What is a box? | A call site or control-flow construct inside a function, ordered by source position (not one box per function, not one per statement). |
| 2 | Labels | Tidied code text: condition / call text with `!`/`not` turned into a No-first branch, camelCase/snake_case split, receivers and noise dropped (`if (!project.exists)` → "project exists?"). |
| 3 | Depth | How many call levels are expanded inline. Default in the YAML (`flowchart.depth`), a slider in the Views tab overrides it for the session (not written back). Range 0–4. |
| 4 | Expanded calls | Shown as a labelled group box around the callee's steps; the group header links to the code. |
| 5 | View kind | New `kind: flowchart` (the existing `flow` kind is rule-driven: the user writes queries that emit steps). |
| 6 | Test bed | `Merthadam/travella` (Python + JS): start with `services/auth`, then `services/agent/graph/nodes` (nested expansion). |

## View file

```yaml
version: 1
name: Login flow
kind: flowchart
scope: { include: ["services/auth/**"], exclude: ["**/tests/**"] }
flowchart:
  start: { symbol: login, file: services/auth/routes.py }   # exactly one entry; file optional if unique
  depth: 1          # 0-4, default 1: calls expanded inline
  include: ["services/**"]   # functions that may be expanded (default: the view scope)
  exclude: []
```

`kind: flowchart` requires `flowchart` and forbids `use`, `rules` and `graph` (v1; mixing can come later).
`include`/`exclude` (node ids/labels) keep their existing meaning.

## Node and edge model

Nodes reuse `DiagramNode`; the shape comes from `kind`:

| `kind` | Shape | From |
| --- | --- | --- |
| `start` | pill (`role: start`) | the entry function |
| `end` | pill (`role: end`) | `return` (label: returned value or "done"), end of function |
| `error` | red pill (`role: end`) | `raise` / `throw` (label: exception type / message) |
| `action` | box | a call statement or awaited call; assignment from a call |
| `decision` | diamond | `if`/`elif`/`else`, ternary, `match`/`switch`, `try` (label "succeeds?") |
| `loop` | diamond | `for`/`while` (label "more items?" / condition) with a back-edge |
| `call` | box, chevron | a call that is not expanded (depth reached, out of scope, library) — `symbol` set |

Edges reuse `DiagramEdge`: `kind: next | yes | no | case | loop | except`, `label` = "Yes"/"No"/case value/exception
type. Calls the code graph resolved only heuristically are dashed (`certain: false`).

Every node has `source` (file:line) so clicking jumps to the code.

## Algorithm

1. **Resolve the entry** through `GraphApi.findSymbols` (as the graph step does). Missing → view error.
2. **Parse the function body** with the language's tree-sitter grammar (`grammars.ts`).
3. **Walk statements in order**, building a small control-flow graph:
   - sequential statements chain with `next`;
   - `if` → `decision`, then/else sub-graphs joined at a merge point (no visible node; edges continue);
   - loops → `loop` decision, body, back-edge, exit edge;
   - `try` → body + `except` edges per handler; `finally` on the merge path;
   - `return` / `raise` → `end` / `error` nodes, no fallthrough;
   - statements without calls or control flow are skipped (they are noise in a flowchart).
4. **Calls**: each call expression in a kept statement is matched to a code-graph `calls` edge by (caller, line).
   If the callee is in `include` and current depth < `depth`, recurse into its body (step 2) inside a group
   `call:<symbolId>`; otherwise emit a `call` node. Recursion guard: a function already on the stack becomes a `call`
   node with a "recursive" badge.
5. **Collapse**: chains of consecutive `action` nodes with no branches between them may fold into one box with a
   "steps" field list (keeps charts readable). Decisions with both branches empty are dropped.
6. **Limits**: ≤ 150 nodes; when hit, stop expanding and mark unexpanded `call` nodes "+N steps".
   Per-function parse budget reuses the 200 ms rule limit.

### Language support (v1)

Python and TypeScript/TSX/JavaScript. One small adapter per language maps grammar node types to the construct set
above (`if_statement`, `elif_clause`, `for_statement`, `try_statement`, `return_statement`, `raise_statement` /
`throw_statement`, `await`, …). Other languages: view error "flowchart does not support <lang> yet".

### Labels

- Decision: condition text, negation flips the branch order (No first), `is None`/`=== null` → "has <x>?",
  `len(x) == 0` / `x.length === 0` → "<x> empty?", identifiers split into words, truncated to ~40 chars with the full
  text in `detail`.
- Action/call: callee name split into words ("send_reset_email" → "send reset email"), receiver dropped.
- Code text is always kept in `detail` and the source link, so tidying never hides what the code says.

## UI (`src/features/views/ViewsTab.tsx`)

- Node renderers for `decision`/`loop` (diamond), `start`/`end`/`error` (pill), `call` (box with expand chevron).
- Edge labels Yes/No/case.
- Depth slider (0–4) in the view toolbar for `flowchart` views; changing it recomputes the view with
  `depth` overridden. Clicking a `call` node's chevron = depth + 1 for that subtree (later; v1 is the global slider).
- ELK layered layout top-to-bottom; back-edges routed around.

## Engine / CLI touch points

- `shared/contracts/views.ts`: add `'flowchart'` to `ViewKind`.
- `electron/core/views/rules/schema.ts` + `view-file.ts`: parse/validate `flowchart:`.
- New `electron/core/views/flowchart/` (`walk.ts` per-language adapters, `build.ts` CFG → diagram, `labels.ts`).
- `electron/core/views/compute.ts`: dispatch `flowchart` views; accept a `depth` override.
- `stingray-views check` prints the flowchart as indented text (decisions with Yes/No branches) and `--depth N`.
- Skill doc (`stingray-views` SKILL.md): document the kind.

## Testing

- Unit tests (`tests/views/*.test.ts`) on small Python and TS fixtures: if/else, elif chains, loops, try/except, early
  return, raise, nested calls at depth 0/1/2, recursion guard, node cap.
- Travella: clone `Merthadam/travella`, add `.stingray/views/auth-login.yaml`, run `stingray-views check`, compare
  with the code by hand; then the agent nodes with depth 2.
- UI: `npm run test:views-tab` extended with a flowchart fixture; visual check in the Docker test env.

## Open questions

- Where to start besides a named function (e.g. pick from a list of route handlers / IPC handlers)?
- Should `async` fan-out (`asyncio.gather`, `Promise.all`) render as parallel branches?
- Combine with a `langgraph` flow: click a LangGraph step to open its flowchart.
