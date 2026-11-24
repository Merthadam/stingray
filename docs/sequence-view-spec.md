# Sequence views — spec

Status: implemented.

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
    # route: "POST /auth/sign-in"       # alternative: an HTTP route node of the code graph; its handler is the entry
  trigger: "click Sign in"     # optional: first arrow from an actor (label); actor name below
  actor: User                  # optional, default "User" (only drawn when trigger is set)
  depth: 3                     # 0-6, default 3: call levels followed (CLI --depth / Views tab slider override)
  participants: auto           # auto | service | module | file | class (lifeline granularity)
  internal: collapse           # collapse | show: calls that stay inside one participant
  returns: true                # dashed return arrows (call results / HTTP responses)
  links: [http, auth, langgraph, events]   # builtin link sets (default: all, duplicates dropped); [] = calls only
  externals:                   # optional (max 50): import/call-text prefix -> external lifeline label
    stripe: Stripe
    self.client: Cognito       # an injected client, matched by call text
  include: ["services/**"]     # files whose functions may be followed (default: the view scope)
  exclude: []
rules: []                      # optional link rules (emit edge kind: link), see Links
explain: { ... }               # as for other views (keys: participant ids, symbol names)
```

## Model

- **Participants** (columns, left → right): the optional actor, then the units the reached functions belong to, then
  external systems; units and externals each in first-appearance order of the messages and notes.
  - `auto`: `service` when the code graph's layers assign the reached files to ≥ 2 services, else `module` when they
    span ≥ 2 modules, else `file` (also when the code graph has no layers). `class` = the innermost enclosing class
    of a function, else its file.
  - Label: the service label; the module label (the service label for a service's `(root)` module); the file
    basename; the class name. Subtitle: `service`, `module of <service>`, the file path, `external`. Id:
    `p:<service|module|file|class>:<key>`, `actor`, `ext:<label>`. `source`/`symbol` = the first function reached
    in it.
  - **External** participants for calls the code graph cannot resolve into the repo but that clearly leave it. The
    call's root name (receiver or callee, `self.`/`this.` stripped) is looked up in the file's imports (tree-sitter:
    Python `import`/`from`, TS/JS `import`/`require`); a relative import is repo code (never external); an imported
    module, or else the call text (`self.client.initiate_auth`), is matched against prefixes: `externals:` first,
    then the builtins (DB: `sqlalchemy`, `psycopg(2)`, `prisma`/`@prisma`, `pg`, `mongoose` → Database; `redis` →
    Redis; `boto3`, `botocore`, `@aws-sdk` → AWS; `cognito`, `amazon-cognito*` → Cognito; `jwt`, `jsonwebtoken`,
    `jose` → JWT; `passlib`, `bcrypt(js)` → Password hashing; `openai` → OpenAI; `anthropic`/`@anthropic-ai` →
    Anthropic; `langchain*`/`@langchain` → LangChain; `fetch`, `axios`, `requests`, `httpx` → External HTTP). A
    prefix matches the module and its submodules (`.` or `/`), `*` = any suffix, longest prefix first. The label is
    the table's value. Other unresolved calls (stdlib, local helpers) are not drawn.
- **Messages** (rows, top → bottom): source order of call sites in each function, depth-first (a callee's messages
  come right after the call that entered it, before the caller's next call). A return/raise/break/continue ends its
  block (later statements are unreachable).
  - `call` (solid arrow) caller participant → callee participant; label = tidied callee name (flowchart `labels.ts`).
    A function reached but not followed (depth reached, outside `include`/`exclude`, not a function, function cap) is
    still drawn.
  - External calls: one `call` message per external system and statement, labelled with the outer call (calls come
    arguments first: `conn.execute(text("…"))` → "execute"); no return arrow (the result is unknown).
  - `http` (solid, label `METHOD /path`): a call edge to a stinggraph `route` node (metadata `channel: http`), continued
    at the route's handler (route `references` handler). Drawn **certain** although stinggraph marks the synthesized
    edge heuristic: the route match itself is the link.
  - `link` (solid): a hop from a link set or link rule (auth dependency, LangGraph node, event subscriber, …); label
    from the link.
  - `return` (dashed, reversed) when `returns: true`: after a drawn, followable hop/call (not LangGraph `(loop)` hops,
    not externals), when the callee's participant differs from the caller's; label = `response` for `http`, else empty
    (never the returned code; phase 6 of flowchart-drilldown-plan.md).
  - `self` (arrow back to the same lifeline): a plain call inside one participant, only with `internal: show`. With
    `collapse` the self-call arrow is not drawn but the callee is still followed (its cross-participant messages are
    kept). `http`/`link` hops inside one participant are always drawn as such.
  - Heuristic resolution (edge `certain: false`) → `certain: false`, drawn dashed / "(uncertain)" in the text.
  - Activation: every message records the call level (`level`), so the UI draws activation bars per participant.
  - Recursion: a function already on the stack is drawn once with the label suffix `(recursive)` and not followed.
- **Fragments** from the flowchart constructs around call sites: `alt` (if/elif/else chains, match/switch; one arm per
  branch, label = tidied condition, else "else"; switch: first arm `subject: case`, then case labels), `opt` (if
  without else, or an `alt` with only one arm left; a kept lone `else` arm is labelled `not <condition>`), `loop`
  (for/while; "for each x" / "while cond" / "loop"; a loop's `else` runs after it), `try` (arms "try" incl. the
  `else` body, then `except E` (Python) / `catch` (TS/JS); `finally` after the fragment). Calls in an `elif`
  condition sit in that arm. LangGraph conditional edges become `alt` fragments too. Arms without messages or notes
  are dropped, fragments without a message are dropped; children of a dropped fragment move to its parent (`parent`).
- **Notes** (`kind: 'error'`): a `raise`/`throw` becomes `error: <Type>` (the exception name, `error: re-raise` for a
  bare `raise`) on the raising function's participant, after the last message drawn so far (`after`, -1 = before the
  first). Only raises of the entry and of functions whose entering message is drawn (handlers, functions on another
  participant, self calls with `internal: show`): a collapsed helper's guard raise is noise. A note inside a kept
  fragment carries `fragment` (innermost kept fragment id) and `arm` (0 = first arm, i = `branches[i - 1]`); an arm
  holding only notes is kept. The same note twice in a row (same participant, row, text, fragment, arm) is shown once.
- **Limits**: 400 messages, 30 participants, 150 distinct functions followed (bodies parsed), 5,000 trace events;
  LangGraph: 60 node visits per invocation. Beyond a limit the result is `truncated` with the warning "Sequence
  stopped at … — lower the depth or exclude files".

## Links

The walker follows `calls` edges of the code graph, plus these hops (each set can be turned off via `links:`). At a
call site, link hops are tried first and replace the plain call; `call: null` hops (auth, rules) run when a function
is entered, before its body.

| set | hop | source |
| --- | --- | --- |
| `http` | client call → route → handler | stinggraph: `calls` edge to a `route` node, `metadata.channel = "http"`, `method`, `href`, matched by line (a second call to the same URL in a function: by its quoted literal `href` in the statement); route `references` handler; without a handler the route node itself is the target |
| `auth` | handler → its auth dependencies before the body | FastAPI `Depends(...)`/`Security(...)` in parameters (also `Annotated[…]` and type aliases of it, in the handler's file or the file defining the alias), the route decorator's and the router's (`router = APIRouter(dependencies=[...])`) `dependencies=[...]`; Python decorators that resolve to a repo function (`@login_required`); Express middleware passed before the handler (`app.get(path, auth, handler)`) and earlier `router.use(auth)` of the same router object; top-level wrappers (`export default withAuth(handler)`). Registrations read from the handler's file; dependencies of dependencies follow (depth). Names resolve to functions only (not `Depends(SomeClass)`) |
| `langgraph` | Python `x.invoke/ainvoke/stream/astream(...)` → the compiled graph's nodes in edge order (label = node name) | the `langgraph` builtin set's queries + router analysis on the files concerned; the receiver is the target of `x = flow.compile()` (same file), a function returning `flow.compile()` (`build_graph().invoke`), a compiled graph imported from a repo module, else the only StateGraph with nodes in the followable files when the receiver reads like a graph (`graph`, `workflow`, `agent`, `app`, `flow`, …; not `chain`) (uncertain); conditional edges → `alt` (arm = path-map key(s), else the router's literal return); END stops; a node already on the path is drawn once as `name (loop)` and not followed; node classes run `__call__`, `self.method` nodes the method. Skipped when the call resolves into the repo |
| `events` | `emit/publish/send/send_task/enqueue('name')` (`send` only on a receiver named like a bus or queue: `bus`, `emitter`, `queue`, `channel`, `broker`, …; not `res.send`/`ws.send`) → handlers registered for that name; `task.delay/apply_async(...)` → the task; RQ `queue.enqueue(fn, …)` → fn | text patterns over the followable source files, literal names only: `on/once/subscribe/addListener/add_listener/add_event_handler/consume('name', handler)`, `@x.on('name')` (and `subscribe`, `listener`, `on_event`, …), `@app.task(name='name')` (also reached by `f.delay()`), `@app.task`/`@shared_task` functions (by function name; `send_task` by the name's last segment); decorator arguments may nest parentheses; all uncertain. The registry scan stops at the evaluation's time limit or abort. Calls that resolve into the repo stay calls |

**Link rules**: `rules:` in a sequence view may emit `edge: { from, to, kind: link, label?, certain? }` where
`from`/`to` are symbol names (or `name@file`). When the walker enters a function named `from` (in `file`, if given), it
continues at `to` as a `link` message before the body; a call whose callee is named `from` (no `@file`) and that does
not resolve into the repo (a library dispatcher) is drawn as the hop to `to` instead. A call-site hop is keyed by the
callee name only, so every such call hops to every `to` of that `from`. `to` resolves to the only function of that
name, else the one in the rule's matched file, else the only symbol of that name; unresolved: no hop. Label = the
edge label, else the `to` name. `SequenceMessage.link` is `rule:<id>`. Link rules apply regardless of `links:`. Their
edges never become diagram edges. Lets a repo teach the view its own dispatchers (RPC, Celery, DI containers) in a few
lines.

## Output

`ViewResult.sequence: SequenceData | null` (see `shared/contracts/views.ts`) carries participants, messages, fragments and notes
(`SequenceNote.fragment`/`arm` place a note in a fragment arm). `nodes` mirror the participants (kind
`participant`/`actor`/`external`, `order` = column, `symbol`/`source`/explanation of the first function) so explain,
exclude and diagnostics keep working; `explain:` texts reach participants through their nodes. `edges` are empty (a
sequence is not a node graph). `diagnostics.sequence: SequenceDiagnostic` reports the resolved start (`name
(file:line)` or `POST /x -> handler (file:line)`), effective depth and granularity, functions parsed, messages,
messages per link set/rule, truncation and error. View-level `exclude:` drops participants by id/label (their
messages vanish; messages of hidden participants are not re-routed).

## CLI text

`stingray-views check` prints a diagnostic line, then the diagram:

```
sequence: start submit (frontend/src/AccountApp.jsx:163)  depth 2  participants service  functions 29  messages 58  links http 9
…
sequence: 5 participants, 58 messages
participants: User (actor), frontend, auth, Cognito (external), Database (external)
User -> frontend: click Sign in
try
  alt step is 'register'
    frontend -> auth: POST /auth/register
    note auth: error: HTTPException
    auth --> frontend: response
  else step is 'verify_email'
    frontend -> auth: POST /auth/verify-email
        try
          auth -> Cognito: confirm sign up
        else except ClientError
          note auth: error: HTTPException
        end
    auth --> frontend: response
  …
end
```

Reading order (shared with the SVG layout, `shared/views/sequence-events.ts`): indent = call level plus enclosing fragments
(a fragment sits at the lowest call level among its rows); `-->` = return; fragments open with `alt|opt|loop|try
<label>`, later arms with `else <label>`, close with `end`; notes print inside their arm. `[link <set>]` after link
messages, `(uncertain)` after heuristic ones. Labels shared by several participants get the id appended. Max 400
lines. `--depth 0-6` overrides `sequence.depth`; `--json` has the full result.

## UI

A dedicated SVG renderer (no ELK; geometry in `src/features/views/views-ui/sequence-layout.ts`): sticky participant headers, dashed
lifelines, activation bars, arrows with labels, fragment frames with a kind tab and branch separators, notes; zoom
(buttons, Ctrl/⌘ + scroll, fit width). Click a message or note → open its source line; click a participant →
inspector (source, explanation, its messages). "Fold into caller" in the inspector (offered when another participant
calls it) draws the participant's messages on its caller's lifeline (`collapseParticipants`: calls between the two
vanish, notes move along, emptied fragments drop); "Unfold N" in the toolbar resets. Folding and the depth slider (0-6,
like flowcharts) are session-only. Text fallback = the CLI text.

## Errors (exit 1 in `check`)

Start symbol/route not found or ambiguous; start symbol is not a function or method; route without a handler function
in the code graph; start language not supported, its file not readable/parsable in time, or the function not found
in it; `kind: sequence` without `sequence:` (or
`sequence:` with another kind); `use`/`graph`/`flowchart`/`layers` with `kind: sequence`; rules that emit anything but
`kind: link` edges; `start` with both or neither of `symbol`/`route`. Without a code graph the sequence is skipped with
an error diagnostic (like flowcharts).
