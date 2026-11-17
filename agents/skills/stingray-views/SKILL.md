---
name: stingray-views
description: Create and check Stingray views — diagrams (tables, flows, timelines, graphs, flowcharts) computed statically from this repository via tree-sitter rules and the code graph. Use when the user wants to see or understand how parts of the code relate, e.g. an agent/workflow flow, a migration history, DB tables, infrastructure, or call graphs, or asks to add or fix a view in .stingray/views.
---

# Stingray views

A **view** is a diagram Stingray computes from a worktree's source, without running any code. Each view is a YAML file
`.stingray/views/<slug>.yaml`, committed with the code, so every branch renders its own diagram in Stingray.
A view produces nodes (optionally in groups, with fields), and edges between them. Kinds:

- `tables` — nodes with fields (e.g. DB tables and columns), edges such as foreign keys.
- `flow` — steps with `start`/`end` roles and transitions (e.g. a LangGraph agent).
- `timeline` — ordered nodes (by `order`, else by edges), e.g. Alembic migrations.
- `graph` — any nodes and edges, grouped (e.g. Terraform resources, call graphs).
- `flowchart` — the control flow of one function (decisions, loops, calls, returns), computed from its code; see
  [Flowcharts](#flowcharts).

Create a view when the user wants to understand relations, flows, history or infrastructure that is spread over many
files. Prefer a builtin set (`use:`) when one fits; write rules for the project's own patterns.

## Workflow

1. Look at the code you want to show (which files, which calls/assignments define nodes and edges).
2. Run `stingray-views sets` and check whether a builtin set already covers it.
3. Write `.stingray/views/<slug>.yaml` (slug: `a-z`, `0-9`, `-`, 1-64 chars).
4. Run `stingray-views check .stingray/views/<slug>.yaml` (`--depth N` for flowcharts). It prints per-rule diagnostics (files, matches, emitted,
   skipped, errors with `file:line`), the graph step result, unresolved links, warnings and a text diagram.
   Exit code 1 means errors.
5. Fix until there are no errors **and** the diagram matches the code (right nodes, no missing edges, no unresolved
   links you did not expect). Rules with 0 matches get a warning: the query or the scope is probably wrong.

Other commands: `stingray-views list` (views of this worktree, with errors), `stingray-views check <file> --json`
(full result as JSON), `stingray-views help` (this guide).

## View file

```yaml
version: 1
name: Trip planner agent flow          # 1-80 chars
description: LangGraph steps of the planner   # optional, ≤500 chars
kind: flow                             # tables | flow | timeline | graph | flowchart
scope:                                 # files the rules read (default **/*)
  include: ["services/agent/**/*.py"]
  exclude: ["**/tests/**"]
use: [langgraph]                       # builtin sets and/or .stingray/rules/<name>.yaml; max 8
rules: []                              # inline rules (schema below); max 50
graph: { ... }                         # optional graph step (below)
flowchart: { ... }                     # kind: flowchart only (below)
include: [AuditLog]                    # node ids/labels always kept
exclude: [Base]                        # node ids/labels always dropped (wins over include)
layout: {}                             # reserved for the UI
```

At least one of `use`, `rules`, `graph`, `flowchart` is required. Unknown keys are errors. Globs: `*` (at most 2 per path segment),
`**` (at most 3), `?`, `[...]`; no `{}`, `()`, `!`, `+`, `@`, `\`.

`use` names a builtin set (see `stingray-views sets`; `sqlalchemy` extracts SQLAlchemy models; `sql` extracts SQL DDL from `.sql` files and literal strings in TS/JS/Python) or a
shared rule file `.stingray/rules/<name>.yaml`:

```yaml
version: 1
name: our-orm              # must equal the file name; may not shadow a builtin set
description: ...
rules: [ ... ]             # same rule schema; rule files cannot `use` others
```

## Builtin sets

Pick the view `kind` listed for the set; narrow with `scope`, add inline `rules` to extend it.

| `use` | kind | extracts |
| --- | --- | --- |
| `sqlalchemy` | tables | SQLAlchemy models: tables, columns, foreign keys (TypeScript extractor, not rules) |
| `sql` | tables | Static SQL DDL in `.sql` files and TS/JS/Python strings: tables, columns, primary and foreign keys (TypeScript extractor, not rules) |
| `alembic` | timeline | one node per `**/versions/*.py` migration (label `rev: message`, alias = revision id), `down_revision -> revision` edges (merge tuples too; `down_revision = None` is the start), `op.*` table operations inside `upgrade()` as fields |
| `langgraph` | flow | per `StateGraph(...)` variable: `add_node` steps (handler in subtitle/detail), `add_edge`, `add_conditional_edges` (dashed, labelled by path-map key; dict or list path maps), `set_entry_point`/`set_finish_point`, START/END with start/end roles |
| `terraform` (preview) | graph | resources, `data.*`, `module.*`, `output.*` by address, grouped by file; edges for references in attributes (incl. `depends_on`, interpolations, lists, objects, nested blocks up to 2 levels) |
| `cdk` (preview, TypeScript) | graph | stacks (classes extending `*Stack`), `new X(this, 'Id', ...)` constructs grouped by stack, `grant*` edges (grantee -> resource), constructs passed as props (dashed), `addDependency`; `props.x` links to a `this.x = new ...` construct by property name (dashed heuristic) |

```yaml
version: 1
name: Agent flow
kind: flow
scope: { include: ["services/agent/**"] }
use: [langgraph]
```

Preview sets were built on sample projects only; check the diagram against the code.

## Rules

```yaml
- id: add-node                         # [a-z0-9-]{1,64}, unique in its file
  language: python                     # python, typescript, tsx, javascript, terraform, go, java, rust, ruby, ...
  files: ["**/graph.py"]               # optional: narrows the view scope for this rule
  query: |                             # tree-sitter query, ≤ 8 KiB
    (call function: (attribute attribute: (identifier) @m (#eq? @m "add_node"))
          arguments: (argument_list . (string (string_content) @name)))
  within: { function: build_graph }    # optional globs on the nearest enclosing function / class name
  emit:                                # exactly one of node / edge / field / group
    node: { id: "@name", label: "@name", kind: step }
```

Emit shapes (all values are templates):

- `node: { id, label?, kind?, subtitle?, group?, role?, order?, detail?, symbol?, aliases?: [..] }` — `role` renders to
  `start` or `end`; `order` must render to a number (timelines); `symbol` is a name linked through the code graph.
- `edge: { from, to, kind?, label?, style?, certain?, create? }` — `certain: false` (or `style: dashed`) draws dashed;
  `create: none|from|to|both` creates placeholder nodes for ends that match no node.
- `field: { node, id, label?, type?, badges?: [..], detail? }` — a row inside a node (e.g. a column).
- `group: { id, label? }` — nodes join it with `group:`.

**Templates.** `@name` is the text of capture `name`. String literals keep their quotes, so capture the
`string_content` child. Implicit captures: `@file` (worktree-relative path), `@line` (1-based line of the match),
`@function`, `@class` (nearest enclosing names, empty when none), `@stem` (file name without extension). `@@` is a
literal `@`. Text without `@` is literal (`id: START`). If a template uses a capture that did not match, the match is
skipped (counted as `skipped`), except optional properties, which become empty. `badges`/`aliases` drop empty results.
Captures matching several nodes (quantifiers) emit once per node.

**Merging and joins.** Nodes with the same `id` merge (first non-empty value wins, fields append, aliases union).
Edge ends and field `node` resolve against node ids first, then aliases — that is how rules join across files (see
the Alembic example). An unresolved end drops the edge and is listed under "unresolved links" unless `create` covers it.
Every item records its source file and line.

## Graph steps

Follow the code graph (CodeGraph index of the worktree) from start symbols:

```yaml
graph:
  start: [{ symbol: build_graph, file: services/agent/graph.py }]  # 1-10; file optional if the name is unique
  follow: [calls]          # calls | imports | inherits | references
  direction: out           # out | in | both
  depth: 3                 # 1-6
  include: ["services/**"] # files a node must be in (default: the view scope)
  exclude: ["**/tests/**"]
  helpers: collapse        # show | collapse | hide
```

Nodes are symbols, edges the followed relations; heuristically resolved edges are dashed. Helpers (reached functions
with fan-in ≥ 2 and no further edges, or outside `include`) are folded into a "calls: ..." field of their callers
(`collapse`), dropped (`hide`) or shown. Max 150 nodes. Rule nodes with a `symbol` merge with the matching graph node,
so a flow can expand each step into its helpers. Without a ready code graph the step is skipped with a diagnostic.

## Flowcharts

A classic flowchart of one entry function: start/end pills, action boxes, decision diamonds with Yes/No branches,
loops with a back-edge. No rules: the code graph finds the functions, tree-sitter reads their bodies (Python and
TypeScript/TSX/JavaScript).

```yaml
version: 1
name: Login flow
kind: flowchart                         # requires flowchart:, forbids use, rules and graph
scope: { include: ["services/auth/**"] }
flowchart:
  start: { symbol: login, file: services/auth/routes.py }  # exactly one function; file optional if the name is unique
  depth: 1                 # 0-4, default 1: call levels expanded inline (the Views tab can override it)
  include: ["services/**"] # files whose functions may be expanded (default: the view scope)
  exclude: []
```

- Steps follow source order. Statements without calls or control flow are left out.
- Node kinds: `start`, `end` (a `return`; label = returned value or "done"), `error` (`raise`/`throw`), `action` (a
  call the code graph does not know, e.g. a library), `decision` (`if`/`elif`/`else`, ternary, `match`/`switch`, `try`
  as "succeeds?"), `loop` (`for`/`while`, "more items?"), `call` (a known function that is not expanded: depth reached
  — subtitle "+N steps (increase depth)" —, outside `include`, or "recursive").
- Edge kinds: `next`, `yes`/`no` (labels Yes/No), `case` (label = pattern, "other" = default/no match), `except`
  (label = exception type), `loop` (back-edges, `continue`). Heuristically resolved calls are dashed (in the text
  tree: `(uncertain)` after the call node or the expanded callee's `» name`).
- Labels are tidied code: `if not user.active` → "user active?" with the No branch first; `x is None` / `x === null`
  → "has x?"; `len(x) == 0` / `!x.length` → "x empty?"; calls by name in words ("send_reset_email" → "send reset
  email"). The code itself is in each node's detail and source link.
- Expanded calls are groups named after the callee (`call:<symbol id>`); a callee's `return` continues in the caller.
- `stingray-views check <file> --depth N` overrides `depth` for one run. The text diagram is an indented tree:
  decisions list their branches until they merge, `→ x` = the branch continues at x, `↻ x` = back to x (loops),
  `» name` = an expanded call. The effective depth is in the result's `diagnostics.flowchart.depth`.
- The view-level `exclude:` drops matching flowchart nodes and their edges, which cuts the chart apart; prefer
  `flowchart.exclude` (file globs) to keep a callee unexpanded.
- Not drawn: `finally` on paths that end in return/raise inside the try; labelled `break`/`continue` go to the innermost
  loop.
- Limits: 150 nodes (then calls stay unexpanded and the chart is marked truncated); 200 ms parse time per file.
- Errors (exit 1): start symbol not found or ambiguous, language not supported, function not found in its file.
  Without a code graph the flowchart is skipped.

## Limits

View/rule YAML ≤ 64 KiB; ≤ 5,000 files per view, files > 1 MiB skipped; ≤ 5,000 matches per rule, 20,000 per view;
≤ 2,000 nodes, 5,000 edges; 200 ms query time per file, 20 s per view. Rules never execute repository code.

## Query tips

- Node and field names come from the language's tree-sitter grammar (e.g. tree-sitter-python's `call`, `attribute`,
  `argument_list`, `assignment`, `string`/`string_content`). Unlisted fields and children are ignored, so match only
  what you need.
- `.` anchors: `(argument_list . (string) @first)` is the first argument; between two patterns it means "next sibling".
- Alternatives: `[(string (string_content) @to) (identifier) @to]`. Wildcard: `(_)`. Quantifiers: `?`, `*`, `+`.
- Predicates: `#eq?`, `#not-eq?`, `#match?`, `#not-match?` (regex), `#any-of?`.
- Narrow with `files:` and `within:` instead of complex queries; start broad, check, then tighten.
- A query error is reported with its line inside the YAML file; a 0-match warning usually means a wrong node name.

## Example: LangGraph flow

```python
builder.add_node("plan", plan)
builder.add_edge(START, "plan")
builder.add_conditional_edges("search", route, {"more": "plan", "done": END})
```

```yaml
version: 1
name: Planner flow
kind: flow
scope: { include: ["services/agent/**/*.py"] }
rules:
  - id: step
    language: python
    query: |
      (call function: (attribute attribute: (identifier) @m (#eq? @m "add_node"))
            arguments: (argument_list . (string (string_content) @name)))
    emit: { node: { id: "@name", label: "@name", kind: step } }
  - id: start
    language: python
    query: '((identifier) @s (#eq? @s "START"))'
    emit: { node: { id: START, label: START, role: start } }
  - id: end
    language: python
    query: '((identifier) @e (#eq? @e "END"))'
    emit: { node: { id: END, label: END, role: end } }
  - id: edge
    language: python
    query: |
      (call function: (attribute attribute: (identifier) @m (#eq? @m "add_edge"))
            arguments: (argument_list . [(string (string_content) @from) (identifier) @from]
                                        . [(string (string_content) @to) (identifier) @to]))
    emit: { edge: { from: "@from", to: "@to" } }
  - id: branch
    language: python
    query: |
      (call function: (attribute attribute: (identifier) @m (#eq? @m "add_conditional_edges"))
            arguments: (argument_list . (string (string_content) @from)
              (dictionary (pair key: (string (string_content) @label)
                                value: [(string (string_content) @to) (identifier) @to]))))
    emit: { edge: { from: "@from", to: "@to", label: "@label", certain: false } }
```

(`use: [langgraph]` does this for common LangGraph code; check `stingray-views sets`.)

## Example: Alembic timeline

Each migration file has `revision = "abc123"` and `down_revision = "def456"`. Nodes are keyed by file and reachable
by revision through `aliases`, so the edge from the parent revision joins across files:

```yaml
version: 1
name: Migrations
kind: timeline
scope: { include: ["**/migrations/versions/*.py"] }
rules:
  - id: revision
    language: python
    query: |
      (module (expression_statement (assignment left: (identifier) @k (#eq? @k "revision")
                                                right: (string (string_content) @rev))))
    emit: { node: { id: "@file", label: "@stem", subtitle: "@rev", aliases: ["@rev"] } }
  - id: parent
    language: python
    query: |
      (module (expression_statement (assignment left: (identifier) @k (#eq? @k "down_revision")
                                                right: (string (string_content) @prev))))
    emit: { edge: { from: "@prev", to: "@file", kind: revision } }
```

The text diagram lists the timeline in order; a merge migration (tuple `down_revision`) needs an extra rule matching
the `tuple` elements.
