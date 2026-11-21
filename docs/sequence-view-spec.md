# Sequence views — spec

A `kind: sequence` view draws **what happens behind the scenes** when something starts: a button click, an HTTP
request, a login, an agent run, a queue message. It shows participants (lifelines) as columns and the calls between
them as ordered arrows, with `alt`/`loop`/`opt`/`try` fragments from the code's control flow. It is computed statically
(code graph + tree-sitter), never by running code, and works for any repo: frontends, backends, auth, agents.

## View file

```yaml
version: 1
name: Login
kind: sequence                 # requires sequence:, forbids use / graph / flowchart / layers; rules: allowed (link rules only)
scope: { include: ["frontend/**", "services/**"], exclude: ["**/tests/**"] }
sequence:
  start:                       # exactly one of symbol | route
    symbol: submit             # a function/method (any language the flowchart adapters read: Python, TS/TSX/JS)
    file: frontend/src/AccountApp.jsx   # optional if the name is unique
    # route: "POST /auth/login"         # alternative: an HTTP route; its handler is the entry
  trigger: "click Sign in"     # optional: first arrow from an actor (label); actor name below
  actor: User                  # optional, default "User" (only drawn when trigger is set)
  depth: 3                     # 0-6, default 3: call levels followed (CLI --depth / Views tab slider override)
  participants: auto           # auto | service | module | file | class (lifeline granularity)
  internal: collapse           # collapse | show: calls that stay inside one participant
  returns: true                # dashed return arrows (call results / HTTP responses)
  links: [http, auth, langgraph, events]   # builtin link sets (default: all); [] = calls only
  externals:                   # optional extra external systems: import/module prefix -> lifeline label
    stripe: Stripe
  include: ["services/**"]     # files whose functions may be followed (default: the view scope)
  exclude: []
rules: []                      # optional link rules (emit edge kind: link), see Links
explain: { ... }               # as for other views (keys: participant ids/labels, symbol names)
```

## Model

- **Participants** (columns, left → right in first-appearance order): the optional actor, then one per unit the
  reached functions belong to, then external systems.
  - `auto`: `service` when the code graph's layers have ≥ 2 services among reached files, else `module`, falling back
    to `file`. `class` = the enclosing class of a method, else the file.
  - Label: the service/module label, file basename, or class name. Id: `p:<kind>:<key>`.
  - **External** participants for calls the code graph cannot resolve into the repo but that clearly leave it:
    builtin prefixes (DB: `sqlalchemy`, `psycopg`, `prisma`, `pg`, `mongoose`, `redis`; cloud: `boto3`, `@aws-sdk`;
    auth: `cognito`, `jwt`, `jose`, `passlib`, `bcrypt`; LLM: `openai`, `anthropic`, `langchain*`; HTTP:
    `fetch`/`axios`/`requests`/`httpx` to an unknown URL → "External HTTP") plus `externals:`. Matched by the import
    the receiver/callee name comes from (file imports via tree-sitter), else by call text prefix. Other unresolved
    calls (stdlib, local helpers) are not drawn.
- **Messages** (rows, top → bottom): source order of call sites in each function, depth-first (a callee's messages
  come right after the call that entered it, before the caller's next call).
  - `call` (solid arrow) caller participant → callee participant; label = tidied callee name (flowchart `labels.ts`).
  - `http` (solid, label `METHOD /path`): a call edge to a stinggraph `route` node (metadata `channel: http`), continued
    at the route's handler (route `references` handler).
  - `link` (solid): a hop from a link set or link rule (auth dependency, LangGraph node, event subscriber, …); label
    from the link.
  - `return` (dashed, reversed) when `returns: true`: after the callee's messages, if the callee's participant differs
    from the caller's; label = returned value text when short (≤ 24 chars), else empty; HTTP returns label "response".
  - `self` (arrow back to the same lifeline): a call inside one participant; only with `internal: show`, or when it is
    the call that leads to further cross-participant messages it is folded away (`collapse`: its messages are kept,
    the self-hop is not drawn).
  - Heuristic resolution (edge `certain: false`) → `certain: false`, drawn dashed-outline / marked "(uncertain)".
  - Activation: every message records the call level (`depth`), so the UI draws activation bars per participant.
- **Fragments** from the flowchart constructs around call sites: `alt` (if/elif/else, match/switch; one branch per
  arm, label = tidied condition / pattern, "else"), `opt` (if without else), `loop` (for/while; label "for each x" /
  "while cond"), `try` (branches: "try", "except E" …). Only fragments that contain ≥ 1 drawn message are kept;
  nested fragments keep their nesting (`parent`).
- **Notes** (optional, v1: errors): a `raise`/`throw` reached inside a fragment becomes a message-less note
  `error: <type>` on its participant (row), so "invalid password → 401" is visible.
- **Limits**: 400 messages, 30 participants, 150 functions followed; beyond that `truncated` + a warning ("lower the
  depth or exclude files"). Recursion: a function already on the stack is drawn as a single call labelled
  "(recursive)" and not followed.

## Links

The walker follows `calls` edges of the code graph, plus these hops (each can be turned off via `links:`):

| set | hop | source |
| --- | --- | --- |
| `http` | client call → route → handler | stinggraph: `calls` edge to a `route` node, `metadata.channel = "http"`, `method`, `href`; route `references` handler |
| `auth` | handler → its auth dependencies before the body | FastAPI `Depends(...)`/`Security(...)` in parameters (also `Annotated[…]` and type aliases of it), the route decorator's and the router's (`APIRouter(dependencies=[...])`) `dependencies=[...]`; Python decorators (`@login_required`, `@requires_auth`, …: any decorator resolving to a repo function); Express middleware passed before the handler (`app.get(path, auth, handler)`) and earlier `router.use(auth)` of the same router; top-level wrappers (`export default withAuth(handler)`). Same file as the handler; dependencies of dependencies follow (depth) |
| `langgraph` | `graph.invoke/ainvoke/stream/astream(...)` → the compiled graph's nodes in edge order (label = node name) | the `langgraph` builtin set's steps/edges; the receiver is the target of `x = flow.compile()` (same file or imported), a function returning `flow.compile()`, else the only StateGraph in scope (uncertain); conditional edges → `alt` (arm = path-map key, else the router's condition); END stops; a node already on the path is drawn once as `name (loop)`; node objects run their `__call__` |
| `events` | `emit/publish/send/send_task/enqueue('name')` → handlers registered for that name; `task.delay/apply_async(...)` / `queue.enqueue(fn)` → the task | text patterns over the followable files, literal names only: `on/once/subscribe('name', handler)`, `@x.on('name')`, `@app.task(name='name')`, `@app.task`/`@shared_task` functions (by function name); uncertain. Calls that resolve into the repo stay calls |

**Link rules**: `rules:` in a sequence view may emit `edge: { from, to, kind: link, label? }` where `from`/`to` are
symbol names (or `name@file`). When the walker enters a function named `from`, it continues at `to` as a `link` message
before the body; a call to `from` that does not resolve into the repo (a library dispatcher) is drawn as the hop to `to`.
`SequenceMessage.link` is `rule:<id>`. Link rules apply regardless of `links:`. Lets a repo teach the view its own dispatchers (RPC, Celery, DI containers) in a few lines.

## Output

`ViewResult.sequence: SequenceData | null` (see `src/views.ts`) carries participants, messages, fragments and notes.
`nodes` mirror the participants (kind `participant`/`actor`/`external`, `order` = column, `symbol`/`source` of the
first function) so explain, include/exclude and diagnostics keep working; `edges` are empty (a sequence is not a node
graph). `diagnostics.sequence: SequenceDiagnostic` reports the resolved start, effective depth, counts, truncation and
error. View-level `exclude:` drops participants by id/label (their messages vanish; messages of hidden participants
are not re-routed).

## CLI text

```
Login  (sequence, depth 3)
User -> web: click Sign in
web -> web: submit                         (folded when internal: collapse)
web -> auth: POST /auth/login
  auth -> auth: get_current_user            [link auth]
  alt user active?
    auth -> Cognito: initiate auth
    Cognito --> auth: tokens
  else
    note auth: error HTTPException
  end
auth --> web: response
```

Indent = call level; `-->` = return; fragments open with `alt|opt|loop|try <label>`, branches with `else <label>`,
close with `end`. `(uncertain)` after heuristic messages.

## UI

A dedicated SVG renderer (no ELK): sticky participant headers, dashed lifelines, activation bars, arrows with labels,
fragment frames with a kind tab and branch separators, notes. Click a message → open its source line; click a
participant → inspector (explanation, files); collapse a participant (its messages fold into the caller's lifeline)
from the inspector. Depth slider 0-6 (like flowcharts), session-only. Text fallback = the CLI text.

## Errors (exit 1 in `check`)

Start symbol/route not found or ambiguous; start language not supported; `kind: sequence` without `sequence:`;
`use`/`graph`/`flowchart`/`layers` with `kind: sequence`; rules that emit anything but `link` edges. Without a code
graph the sequence is skipped with an error diagnostic (like flowcharts).
