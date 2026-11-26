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
  start:                       # exactly one of symbol | route | ipc
    symbol: submit             # a function/method (any language the flowchart adapters read: Python, TS/TSX/JS)
    file: frontend/src/AccountApp.jsx   # optional if the name is unique
    # route: "POST /auth/sign-in"       # alternative: an HTTP route node of the code graph; its handler is the entry
    # ipc: git.createWorkspace          # alternative: an IPC contract route (channel, or member/renderer name); see Links
  trigger: "click Sign in"     # optional: first arrow from an actor (label); actor name below
  actor: User                  # optional, default "User" (only drawn when trigger is set)
  depth: 3                     # 0-6, default 3: call levels followed (CLI --depth / Views tab slider override)
  participants: auto           # auto | service | module | file | class (lifeline granularity)
  internal: collapse           # collapse | show: calls that stay inside one participant
  returns: true                # dashed return arrows (call results / HTTP responses)
  links: [http, auth, langgraph, events, ipc]   # builtin link sets (default: all, duplicates dropped); [] = calls only
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
    the table's value. Other unresolved calls (stdlib, local helpers) are not drawn. A call whose text matches a prefix
    of the view's own `externals:` (not the builtins) goes to that external **before** code-graph resolution and link
    hops (`this.runner: Git CLI` for an injected port the graph resolves to a field or interface method), labelled with
    that call itself.
- **Messages** (rows, top → bottom): source order of call sites in each function, depth-first (a callee's messages
  come right after the call that entered it, before the caller's next call). A return/raise/break/continue ends its
  block (later statements are unreachable).
  - **Inline callbacks** (TS/JS): arrow / function expressions passed directly as call arguments
    (`this.serial(async () => {…})`) are walked at the call site, as calls of the enclosing function (same frame,
    level and `calls` relations), right after the call receiving them is handled (its message, body and return). A
    return/raise in a callback ends the callback only; its raises are notes of the enclosing function. Flowcharts do
    not expand them (`Call.callbacks` is ignored there). Python lambdas are not walked.
  - **Typed members** (TypeScript, `sequence/members.ts`): a call the code graph does not resolve is resolved through
    explicit annotations: `this.f.m()` — `f` a field (`readonly store: Store`) or constructor parameter property
    (`constructor(private readonly store: Store)`) of the enclosing class or its bases; `p.m()` / `p.f.m()` — `p` a
    parameter of the enclosing function or of a function around it (closures), typed by a class or an object type
    literal (`d: { git: GitService }`); `X | null`, `Pick<X, …>`/`Omit`/`Partial`/`Readonly`/`Required`/`NonNullable`
    unwrap to `X`. The class is the repo class the name means in that file (defined there, imported — a unique class
    below an imported directory covers barrel `index` re-exports —, else the only one); the method is looked up in the
    class, then along `extends` edges (5 levels). At most two member hops; no inference (untyped locals, return
    types), interfaces and function types give nothing. Drawn certain (explicit types). Link providers see these
    resolutions as resolved calls.
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
  are dropped, fragments without a message are dropped (so a guard holding only a raise, `if (exists) throw …`, shows
  its note but not its condition); children of a dropped fragment move to its parent (`parent`).
- **Notes** (`kind: 'error'`): a `raise`/`throw` becomes `can fail: <type in words>` (`can fail: http exception`,
  `can fail: re-raise` for a bare `raise`; the raw type in `detail`) on the raising function's participant, after the last message drawn so far (`after`, -1 = before the
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
| `ipc` | renderer call `x.<name>(…)` → main-side handler of a typed IPC contract (label = channel `feature.member`) | tree-sitter over the followable TS/JS files containing `defineContract(`, `Handlers<typeof`, or `registerContract(`: `const c = defineContract('<feature>', { invoke: { <member>: [args, returns, { renderer?: '<flat>' }] } })` (renderer name = `renderer` override, else member); handler objects = object literals returned by a function whose return type is `Handlers<typeof c>`, the value of a variable typed so, or the third argument of `registerContract(…, c, …)` (an object literal, or a call of a repo function: its returned objects); per property whose value is an arrow/function expression or method, keyed by renderer name. Handler arrows are not code-graph symbols: each is a synthetic function symbol (`ipc:<file>:<line>:<name>`, found again by name and line). A handler that only forwards (expression body / single `return` of one call, `await` allowed) is skipped: the route enters the call's target (typed members, else the code graph's `calls` edge of the function around the handler object at that line). A call hops when its callee is a renderer name, it has a receiver other than `this`/`self`, and it does not resolve into the repo (graph or typed members); certain. All routes of that name are hops |
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

**`start: { ipc }`**: `"git.createWorkspace"` (channel), `"createWorkspace"` (member or renderer name), optionally with
`file:` (the handler object's file or the entered function's file). Entry = the route's handler (forwarding handlers:
the method they call), like `route`; diagnostic `start` = `<channel> -> <name> (<file:line>)`. With `trigger:` the
renderer call sites are searched (tree-sitter, followable TS/JS files without handler objects): call expressions
`x.<renderer name>(…)` not on `this`/`self` that neither the code graph (a `calls` edge of the enclosing function at
that line to that name) nor the typed members resolve. The first (file order) is the caller: the trigger arrow goes
actor → caller (the innermost function symbol around the call, else a synthetic `file:<path>` symbol named by the
file), then a `link` message (link `ipc`, label = channel, source = call site) caller → entry, the entry's body, and a
return arrow entry → caller. The diagnostic appends `from <caller> (<file:line>)` and `(+N more)` for other sites.
Errors: `start ipc not found: X`, `ambiguous start ipc X: add a file or use the channel (<channel> <file:line>, …)`.

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
    note auth: can fail: http exception
    auth --> frontend: response
  else step is 'verify_email'
    frontend -> auth: POST /auth/verify-email
        try
          auth -> Cognito: confirm sign up
        else except ClientError
          note auth: can fail: http exception
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

Start symbol/route/ipc not found or ambiguous; start symbol is not a function or method; route without a handler function
in the code graph; start language not supported, its file not readable/parsable in time, or the function not found
in it; `kind: sequence` without `sequence:` (or
`sequence:` with another kind); `use`/`graph`/`flowchart`/`layers` with `kind: sequence`; rules that emit anything but
`kind: link` edges; `start` without exactly one of `symbol`/`route`/`ipc`. Without a code graph the sequence is skipped with
an error diagnostic (like flowcharts).
