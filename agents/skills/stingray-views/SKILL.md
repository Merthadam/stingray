---
name: stingray-views
description: Create and check Stingray views — diagrams (tables, flows, timelines, graphs, flowcharts, sequence diagrams) computed statically from this repository via tree-sitter rules and the code graph. Use when the user wants to see or understand how parts of the code relate, e.g. an agent/workflow flow, what happens behind a button click, HTTP route or login, a migration history, DB tables, infrastructure, or call graphs, or asks to add or fix a view in .stingray/views.
---

# Stingray views

A **view** is a diagram Stingray computes from a worktree's source, without running any code. Each view is a YAML file
`.stingray/views/<slug>.yaml`, committed with the code, so every branch renders its own diagram in Stingray.
A view produces nodes (optionally in groups, with fields), and edges between them. Kinds:

- `tables` — nodes with fields (e.g. DB tables and columns), edges such as foreign keys.
- `flow` — steps with `start`/`end` roles and transitions (e.g. a LangGraph agent).
- `timeline` — ordered nodes (by `order`, else by edges), e.g. Alembic migrations.
- `graph` — any nodes and edges, grouped (e.g. Terraform resources, call graphs); with `layers:`, the repo's services,
  modules, files and symbols as a drill-down (see [Layers](#layers)).
- `flowchart` — the control flow of one function (decisions, loops, calls, returns), computed from its code; see
  [Flowcharts](#flowcharts).
- `sequence` — what happens behind the scenes when something starts (a button click, an HTTP route, a login, an agent
  run): participants as lifelines, calls between them in order; see [Sequence diagrams](#sequence-diagrams).

Create a view when the user wants to understand relations, flows, history or infrastructure that is spread over many
files. Prefer a builtin set (`use:`) when one fits; write rules for the project's own patterns.

## Workflow

1. Look at the code you want to show (which files, which calls/assignments define nodes and edges).
2. Run `stingray-views sets` and check whether a builtin set already covers it.
3. Write `.stingray/views/<slug>.yaml` (slug: `a-z`, `0-9`, `-`, 1-64 chars).
4. Run `stingray-views check .stingray/views/<slug>.yaml` (`--depth N` for flowcharts, layers and sequences). It prints per-rule diagnostics (files, matches, emitted,
   skipped, errors with `file:line`), the graph step result, unresolved links, warnings and a text diagram.
   Exit code 1 means errors.
5. Fix until there are no errors **and** the diagram matches the code (right nodes, no missing edges, no unresolved
   links you did not expect). Rules with 0 matches get a warning: the query or the scope is probably wrong.

Other commands: `stingray-views list` (views of this worktree, with errors), `stingray-views check <file> --json`
(full result as JSON), `stingray-views check <file> --restamp` (stamp `explain:` fingerprints, below),
`stingray-views check <file> --strict` (exit 1 when an `explain:` entry needs review, for CI), `stingray-views help`
(this guide).

## View file

```yaml
version: 1
name: Trip planner agent flow          # 1-80 chars
description: LangGraph steps of the planner   # optional, ≤500 chars
kind: flow                             # tables | flow | timeline | graph | flowchart | sequence
scope:                                 # files the rules read (default **/*)
  include: ["services/agent/**/*.py"]
  exclude: ["**/tests/**"]
use: [langgraph]                       # builtin sets and/or .stingray/rules/<name>.yaml; max 8
rules: []                              # inline rules (schema below); max 50
graph: { ... }                         # optional graph step (below)
flowchart: { ... }                     # kind: flowchart only (below)
sequence: { ... }                      # kind: sequence only (below)
layers: { ... }                        # kind: graph only (below)
include: [AuditLog]                    # node ids/labels always kept
exclude: [Base]                        # node ids/labels always dropped (wins over include)
layout: {}                             # reserved for the UI
explain: { ... }                       # optional prose per node/group (below)
```

At least one of `use`, `rules`, `graph`, `flowchart`, `layers`, `sequence` is required. Unknown keys are errors. Globs: `*` (at most 2 per path segment),
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
- Explanations: groups, `call` nodes and the start node (and `graph` step nodes and rule nodes linked with `symbol:`)
  carry `explanation` = the first paragraph of the function's docstring/JSDoc, when it has one. The text diagram
  appends it as ` — <explanation>` (e.g. `» identity — Accept a Cognito access token …`); `--json` has the field on
  nodes and groups. Writing a one-line intent docstring is how to explain a step. Tables linked to their model class
  get the class docstring summary the same way (shown under the table card header).
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

## Sequence diagrams

What happens behind the scenes when something starts — a button click, an HTTP request, a login, an agent run: one
lifeline per participant (actor, services/modules/files/classes of the repo, external systems), the calls between them
as ordered arrows, `alt`/`opt`/`loop`/`try` frames from the code's control flow and error notes. Use it to show a flow
that crosses functions, files or services; use a flowchart for the branches inside one function. Like flowcharts: code
graph + tree-sitter bodies (Python, TypeScript/TSX/JavaScript), no `use`/`graph`/`flowchart`/`layers`.

```yaml
version: 1
name: Login
kind: sequence                          # requires sequence:
scope: { include: ["frontend/**", "services/**"], exclude: ["**/tests/**"] }
sequence:
  start: { symbol: submit, file: frontend/src/AccountApp.jsx }  # exactly one of symbol | route; file optional if unique
  # start: { route: "POST /auth/sign-in" }   # an HTTP route of the code graph ("METHOD /path"); its handler is the entry
  trigger: click Sign in   # optional: a first arrow actor -> entry with this label
  actor: User              # default User; drawn only with trigger
  depth: 2                 # 0-6, default 3: call levels followed (CLI --depth / Views tab slider override)
  participants: auto       # auto (default) | service | module | file | class
  internal: collapse       # collapse (default) | show: calls that stay inside one participant
  returns: true            # default true: dashed return arrows
  links: [http, auth, langgraph, events]   # link sets, default all; [] = plain calls only
  externals: { self.client: Cognito }      # extra external systems: import/call prefix -> lifeline label (max 50)
  include: ["services/**"] # files whose functions are followed (default: the view scope)
  exclude: []
```

- **Participants**, left to right: the actor, then one lifeline per unit of the reached functions, then external
  systems; units and externals each in order of first appearance. `auto` = `service` when the reached files span ≥ 2
  services of the code graph's layers, else `module` when they span ≥ 2 modules, else `file`. `file` lifelines are
  labelled with the file name, `class` with the enclosing class (functions outside a class: their file). Ids:
  `actor`, `p:<service|module|file|class>:<key>`, `ext:<label>`. Files outside every service land in `(unassigned)`.
- **Externals**: a call that does not resolve into the repo is drawn to an external lifeline when the module its
  receiver/callee is imported from (or else the call text, e.g. `self.client.get_user`) starts with a known prefix:
  `sqlalchemy`/`psycopg`/`prisma`/`pg`/`mongoose` → Database, `redis` → Redis, `boto3`/`@aws-sdk` → AWS, `cognito` →
  Cognito, `jwt`/`jose`/`jsonwebtoken` → JWT, `passlib`/`bcrypt` → Password hashing, `openai`, `anthropic`,
  `langchain*`, `fetch`/`axios`/`requests`/`httpx` → External HTTP. A prefix matches the module and its submodules
  (`.` or `/`); `*` = any suffix; `externals:` win over the builtins, longest prefix first. One arrow per system and
  statement, labelled with the outer call (`conn.execute(text(…))` → "execute"); no return arrows from externals.
  Other unresolved calls (stdlib, untracked helpers) are not drawn. Relative imports are never external.
- **Messages**, top to bottom: each function's call sites in source order, depth-first (a callee's messages come right
  after the call that entered it). In the text: `A -> B: label` = call, `B --> A: label` = return, indent = call level.
  - call: label = callee in words ("get_user" → "get user"); `(recursive)` = already on the stack, not followed.
  - http (`POST /auth/sign-in`): a client call the code graph matched to a route; continues in the route's handler.
  - link (`[link auth]`, `[link langgraph]`, `[link events]`, `[link rule:<id>]`): a hop from a link set or rule.
  - return: after a followed call whose callee is on another lifeline; label = the returned value when all returns
    agree and it is ≤ 24 chars, `response` for http, else empty.
  - self: a call inside one participant, only with `internal: show`; with `collapse` the arrow is left out but the
    callee's own calls are still drawn. Link hops inside one lifeline are always drawn.
  - `(uncertain)`: heuristically resolved (dashed in the Views tab). A called repo function outside `include` is drawn
    but not followed.
- **Fragments** around call sites: `alt` (if/elif/else, match/switch: one arm per branch, "else" arms; the first case
  is labelled `subject: case`), `opt` (an if, or an alt with one arm left), `loop` ("for each x", "while cond"), `try`
  (arms "try", `except E` in Python, `catch` in TS/JS). Conditions are tidied like flowchart labels. Fragments
  without a message and arms without a message or note are dropped; nesting is kept.
- **Notes**: `raise`/`throw` in the entry or in a function whose call is drawn becomes `note <participant>: error:
  <Type>` (`error: re-raise` for a bare `raise`) after the message before it, inside its fragment arm. Raises of
  collapsed same-lifeline helpers are left out; the same note twice in a row is shown once.
- Explanations: a participant carries the docstring summary of its first function; `explain:` keys are participant ids
  (`p:file:services/auth/api.py`) or symbol names. View-level `exclude:` drops participants by id or label, with their
  messages.

**Link sets** (`links:`) — hops the code graph's `calls` edges do not have:

| set | covers | does not cover |
| --- | --- | --- |
| `http` | client calls the code graph matched to a repo route (`fetch`/`axios`/… with a literal path): drawn as `METHOD /path` (certain), then the route's handler; a second call to the same URL in one function by its literal path | URLs the code graph did not match (built at runtime, other repos); unmatched clients go to External HTTP |
| `auth` | before a handler's body, in the handler's file: FastAPI `Depends`/`Security` in parameters (also `Annotated[…]` aliases, even imported ones), the route decorator's and the router's `dependencies=[…]`, decorators resolving to repo functions (`@login_required`); Express middleware before the handler and earlier `router.use(mw)` of the same router; top-level wrappers (`export default withAuth(handler)`). Dependencies of dependencies follow | class dependencies (`Depends(SomeClass)`), library decorators, `include_router(…, dependencies=)`, middleware registered in other files (Next.js `middleware.ts`, app-wide ASGI middleware) |
| `langgraph` | Python `x.invoke/ainvoke/stream/astream(…)` on a compiled StateGraph (`x = flow.compile()` in the file or imported, `build_graph().invoke`, else the only StateGraph in the followable files when the receiver reads like a graph — not `chain` —, uncertain): START → nodes in edge order, conditional edges as `alt` (path-map key or router return), END stops, a node already on the path once as `name (loop)` (not followed); node classes run `__call__`. Max 60 node visits | LangGraph JS, `Send`/`Command(goto=)` routing, graphs built in loops or from data, subgraphs as nodes |
| `events` | literal names: `emit/publish/send/send_task/enqueue("name", …)` (`send` only on bus/queue-like receivers, not `res.send`) → handlers of `on/once/subscribe("name", h)`, `@x.on("name")`, `@app.task(name="name")`; `task.delay/apply_async(…)` → the `@app.task`/`@shared_task` function (named or not); RQ `queue.enqueue(fn, …)` → fn. Always uncertain; registrations are text-matched in the followable files | names from variables/constants, handlers outside the followable files, calls that resolve into the repo (an own `publish` method stays a call) |

**Link rules** teach the view its own dispatchers (RPC, job queues, DI). `rules:` of a sequence view may only emit
`edge: { from, to, kind: link, label?, certain? }`; `from`/`to` are symbol names or `name@file`. A call to `from` that
does not resolve into the repo is drawn as a hop to `to`; entering a function named `from` (`name@file`: that one)
continues at `to` before its body. Rules apply whatever `links:` says; the result shows them as `[link rule:<id>]`.

```yaml
# api.py: dispatch("charge", cart) -> charge() in the repo
rules:
  - id: rpc
    language: python
    query: |
      (call function: (attribute attribute: (identifier) @m (#eq? @m "dispatch"))
            arguments: (argument_list . (string (string_content) @name)))
    emit: { edge: { from: dispatch, to: "@name", kind: link, label: "rpc @name" } }
```

A call-site hop is keyed by the callee name only: every `dispatch(…)` hops to every `to` the rule found. When each
function dispatches to one target, key it by the enclosing function instead: `from: "@function@@@file"` (`@@` = a
literal `@`); the hop is then drawn when that function is entered, before its body.

- `stingray-views check <file> --depth N` (0-6) overrides `depth`. The CLI prints a
  `sequence: start … depth … participants … functions … messages … links …` line, then the diagram:
  `sequence: N participants, M messages`, `participants: …` (kinds in parentheses), the arrows, frames as
  `alt|opt|loop|try <label>` … `else <label>` … `end`, and `note <participant>: <text>`. `--json` has
  `sequence` (participants, messages, fragments, notes) and `diagnostics.sequence` (resolved start, effective
  depth and granularity, counts, messages per link set).
- Views tab: click an arrow or note to open its source, a participant for its inspector ("Fold into caller" draws its
  calls on the caller's lifeline; "Unfold" in the toolbar), depth slider; both session-only.
- Limits: 400 messages, 30 participants, 150 distinct functions followed, then the sequence is marked truncated
  ("lower the depth or exclude files").
- Errors (exit 1): start symbol/route not found or ambiguous (add `file:`), start is not a function, route without a
  handler, language not supported or function not found in its file, `kind: sequence` without `sequence:` (or the reverse), `use`/`graph`/`flowchart`/
  `layers` in a sequence view, a rule emitting anything but a `kind: link` edge, `start` with both or neither of
  `symbol`/`route`. Without a code graph the sequence is skipped with an error diagnostic.
- Tips:
  - Start with `depth: 2`-`3`; deeper levels mostly add helpers and DB calls. Raise it with `--depth` only for a
    branch you need.
  - A frontend handler (`start: { symbol: submit, file: … }` + `trigger: click …`) shows the requests it makes and,
    through `http`, what each route does. For one backend flow, start at the route
    (`start: { route: "POST /auth/sign-in" }`) with `participants: file`: one service would otherwise be one lifeline.
  - Clients injected into objects are not imports: name them, e.g. `externals: { self.client: Cognito }`; SDKs with
    unusual names likewise (`externals: { claude_agent_sdk: Claude }`).
  - Many `(unassigned)` or helper lifelines: narrow `sequence.include` (they stay drawn but are not followed) or drop
    them with view-level `exclude:`. Too much noise inside one lifeline: keep `internal: collapse`.
  - Check notes against the code: an `error:` note marks a raise on that path, not that the step always fails.

## Explanations (`explain:`)

Docstrings explain symbol-backed nodes for free (see Flowcharts). For intent that is not one function's docstring, or
for nodes without a symbol (tables, LangGraph steps, infra), write it in the view file:

```yaml
explain:
  identity:                        # node id, group id, alias (rule `aliases`, a table's name or model class) or symbol name
    text: Accept only genuine, unrevoked tokens of verified travelers   # 1-500 chars; replaces the docstring explanation
    fingerprint:                   # written by --restamp; do not edit by hand
      services/auth/api.py::create_app::identity: 3f9a0c1d2b4e              # <file>::<qualified name>: hash
      services/auth/session_store.py::SessionStore::get_user: 0d44b9e1a2c7  # a function identity calls
  users:
    text: Everyone who signed up, including invited but unconfirmed users
    fingerprint:
      drawn:sql:db/schema.sql#users: 5be0c4a19d02     # no symbol: the node as drawn
```

- A key is matched in that order: node id, group id, alias, then every node and group linked to that symbol (e.g. a
  flowchart's `call` node and the expanded `» identity` group). The first kind that matches wins. A key matching nothing
  is listed under "unresolved links" as `explain: "<key>"` (a warning, not an error).
- The fingerprint is a map with one hash per piece of code the text was written for. For a symbol: its own body plus
  every function it calls directly that the code graph resolves to this repo — including functions in files the view
  excludes, one level deep (callees of callees do not count), no library or stdlib calls. A class call counts as its
  constructor. Bodies are hashed by their lines, trailing whitespace and line endings ignored. For a node without a
  symbol: one `drawn:<id>` piece, the node as drawn (label, kind, subtitle, detail, fields with types and badges — a
  table's changes when its columns do; a group's also covers its member nodes and nested groups). A key matching
  several nodes or groups (e.g. same-named functions) covers all of them. A callee that cannot be hashed is left out
  (listed under `skipped` in `--json`); more than 200 pieces cannot be checked.
- Statuses and warnings:
  - current: no warning;
  - stale: `explanation for "<key>" may be outdated: X changed; new call Y; no longer calls Z …`; the text diagram
    appends `(may be outdated)` and the Views tab marks the explanation with the reason;
  - unstamped: `… has no fingerprint …` (or the reason it cannot be fingerprinted);
  - legacy: a plain-string fingerprint from older versions (own body only) warns `… uses the old fingerprint format …`
    and the text diagram appends `(old fingerprint)`, until you review it and restamp.
- Workflow: write or update the texts, run `check`, read each flagged explanation against the code and fix it, then
  run `stingray-views check <file> --restamp`. It writes the current fingerprint maps of entries that resolve into the
  file, replacing old string fingerprints (comments kept), and prints what it stamped (`stamped "<key>" (N pieces)`,
  and any callee it left out); plain `check` never writes. Restamping needs the code graph; without it
  fingerprints are not checked at all. It writes nothing while `check` fails, and skips entries whose source file
  changed since the code graph indexed it (line ranges come from the index): restamp once Stingray has re-indexed.
  An entry whose code cannot be fingerprinted (unreadable or too large file, no end line) warns with the reason.
  `diagnostics.explain` in `--json` has each entry's matches, `status`, current `pieces`, `skipped` callees, `changes`
  (changed, added, removed piece keys) and source files.
- CI: `stingray-views check <file> --strict` exits 1 (after printing `strict: N explanation(s) need review` to stderr)
  when any entry is stale, unstamped or legacy; it combines with `--json` but not with `--restamp`. Without a code
  graph only legacy and unstamped entries can be detected.

## Layers

The repo's architecture as a drill-down: services (L1), modules (L2), files (L3) and top-level symbols (L4), from the
code graph's service layers. Services and modules are inferred from manifests (`package.json`, `pyproject.toml`, …) and
compose `command`s; a committed `.stinggraph/layers.yaml` names them (labels, aliases, includes/excludes, modules). Every
file outside a service is in `(unassigned)`. The builtin **Services** view (id `layers`) shows this for every worktree.

```yaml
version: 1
name: Connector service
kind: graph                       # required
scope: { exclude: ["**/tests/**"] } # files left out, with their edges
layers:
  depth: 3                        # 1 services, 2 modules, 3 files, 4 symbols (default 1; the Views tab slider overrides it)
  expand: [connector]             # services drawn down to `depth` (id or label); the others stay one node (default: all)
exclude: ["(unassigned)"]         # drop a service by label, like any node
```

- Levels above the drawn one are nested groups (service › module › file). Edges between files roll up to the drawn
  nodes; the label is the count, then per kind (`141 · imports 44, calls 40, …`). Dashed: every edge of the pair was
  inferred (cross-service HTTP calls the engine synthesized, or heuristic resolution).
- Symbol level: members (methods) count as their class; module-level code and imports have no symbol and are left out.
- `stingray-views check <file> --depth N` (1-4) overrides `depth`; the result's `diagnostics.layers` has the config used,
  the depth and the counts. `layers.yaml` problems are warnings. Without a code graph the step is skipped.
- Keep depth 3-4 to a few `expand`ed services: views stop at 2,000 nodes.

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
