# Flowchart views: readable summaries with drill-down (plan)

Status: phases 1-4 implemented (phase 2 extends the existing `explain:` entries instead of a new `labels:` key;
phase 3's summary lives in `shared/views/flowchart-summary.ts`; phase 4's call paths are callee names without lines,
`finish>create_session` / `audit#2`, carried as `callPath` on call nodes and groups while node and group ids stay as
they were, the depth slider stays and resets the session expansions, and an expansion over the node cap stays a call
node without an "open as its own flowchart" action); phases 5-6 open. Builds on `flowchart-view-spec.md`. Flowcharts first; graph,
flow, layers and sequence views follow once this works (how sequence diagrams fit is still open).

## Problem (example: the auth sign-in flowchart)

- **Code instead of explanation:** decisions read `result get "ChallengeName" is…` and every box repeats its code line
  (`result = provider.sign_in(str(…`). Someone who didn't write the code can't read the chart.
- **Noise:** trivial steps (`clock`, `get`) get their own boxes and arrows.
- **Too deep / too connected:** `depth` is global, so everything is expanded to the same level. Guard clauses draw long
  edges to error pills across the chart, and their edge labels overlap.
- **Cut-off text:** labels are cut to 40 characters in the engine and again by one-line CSS in a fixed 220px box.
- **What works:** boxes that show their docstring (`finish`, `create`) are understandable.

## Principles

1. **A view contains no code.** Code only shows in the Inspector and through "open in editor".
2. **Summary first, drill down on demand.** The chart opens on the entry function's steps with every call closed.
3. **Text comes from the code where possible** (docstrings, so it stays up to date) and **from the view file where it
   has to** (YAML `labels:` for decisions and unclear steps).
4. **What isn't described is marked**, so the agent or the author can fill it in.

## Decisions

| # | Topic | Decision |
| --- | --- | --- |
| 1 | Opening state | `depth: 0` by default: the entry function's steps, all calls closed. |
| 2 | Call text | The callee's docstring/JSDoc first sentence; a YAML `labels:` entry overrides it. |
| 3 | Decision text | A YAML `labels:` entry, matched by a snippet of the condition's code text. |
| 4 | Fallback (no docstring, no label) | Calls: humanized name ("sign in"). Decisions: text from their outcomes ("→ create challenge / → finish"). The box is marked *unlabeled* (dimmed + dot). Never code. |
| 5 | Label upkeep | `stingray-views check` warns about labels that match nothing and lists unlabeled steps and decisions as a to-do. The skill teaches agents to work through that list. |
| 6 | Who writes labels | The agent (via the skill), the author by hand, or "edit label" in the UI, which writes straight into the view's YAML. |
| 7 | Code in boxes | None: no code subtitle line. The code snippet appears in the Inspector (highlighted). |
| 8 | Text length | Labels wrap to 2–3 lines, and boxes are sized to their text. The selected box shows its full text. No engine-side 40-character cut. |
| 9 | Noise | Trivial library/builtin calls that only produce a value (`now = clock()`, `x = d.get(…)`) are removed. `flowchart.hide: [names]` adds more. |
| 10 | Described only vs all steps | The top layer and expanded calls show **described steps only** (docstring or label). Each frame has a "show all steps" switch, and a toolbar toggle flips the whole chart to "all steps" (still fallback text, never code). |
| 11 | Error paths | A guard clause whose branch only raises or returns an error becomes a "can fail: <error>" badge on the step before it. There is no diamond and no long edge. The badge opens the error branch; the Inspector lists the errors. |
| 12 | Drill-down | Calls expand in place (chevron); frames collapse (header button). Expansion is by stable call path, not global depth. The current expansions can be saved to `flowchart.expand`. |
| 13 | Scope | Flowcharts first. The other view kinds later, reusing labels, the no-code rule and the unlabeled to-do list. |

## View file

```yaml
version: 1
name: Login flow
kind: flowchart
flowchart:
  start: { symbol: login, file: services/auth/routes.py }
  depth: 0                                   # initial expansion level (default 0)
  expand: [finish]                           # calls opened on load: callee name or call path (login>finish@58)
  labels:                                    # code snippet of a decision/step, or a call name -> text
    'result.get("ChallengeName")': "Cognito asks for a challenge (MFA, new password)?"
    '"AuthenticationResult" not in result': "Sign-in incomplete?"
    finish: "Create session and set cookie"  # overrides the docstring
  hide: [clock, get]                         # extra noise on top of the built-in rule
  include: ["services/**"]
  exclude: ["**/utils/**"]                   # never expanded into
```

Matching `labels:` keys: a key is a call name if it's a bare identifier. Otherwise it's a snippet that must occur
(whitespace-insensitive) in exactly one decision's or step's code. A key that matches several adds `@<line>` in the
warning, so the author can make it more specific. A key that matches nothing is a warning.

## Engine (`electron/core/views/flowchart/`)

- **Descriptions:** `python.ts`/`typescript.ts` read the docstring/JSDoc of a function next to `findFunction`, and the
  first sentence goes into the node's text. `labels.ts` gets an `applyLabels(step, labels)` pass, plus the fallbacks
  (humanized name; outcome text built from the branch targets' labels).
- **Node model:** `label` = plain text (never code), `detail` = the code (Inspector only), new `described: boolean`,
  and `badges` for "can fail". Collapsed calls carry `callPath`, `steps` and `expandable`.
- **Noise and summary passes** after building: remove trivial value-only library calls. In described-only mode, fold
  undescribed steps into their neighbours (the edges are kept). Turn guard clauses into badges on the previous step.
- **Drill-down:** stable call-path ids (`login>finish@58`) for groups and nodes inside them. The builder takes
  `expanded`/`collapsed` sets, and a call is expanded if `expanded.has(path) || (level < depth && !collapsed.has(path))`
  and it fits under the node cap. The cache key in `service.ts` includes the sets and the "all steps" mode.
- **Schema:** `flowchart.expand`, `labels`, `hide`; `depth` default 0.
- **CLI:** `--expand a,b>c`, `--all-steps`. The text output prints collapsed calls as
  `» name — description (+N steps, expand: <path>)` and ends with the unlabeled to-do list and stale-label warnings.

## UI (`src/features/views/views-ui/`)

- `FlowNode.tsx`: no code line. Wrapped label (2–3 line clamp) and a description line. The unlabeled marker, the
  can-fail badge, and the expand chevron on calls.
- `flow-layout.ts`: `flowSize` from measured text (shared `measureLabel`), edge labels up to ~60 characters and two
  lines.
- The selected box shows its full text. The Inspector shows the full label, description, highlighted code, errors,
  "expand/collapse", and "edit label".
- Drill-down: session sets of expanded/collapsed call paths → `api.view(ws, id, { expanded, collapsed, allSteps })`. The
  viewport keeps the clicked node in place after re-layout. "Save as view…" writes `expand:`. The depth slider becomes
  "Expand level / Collapse all" plus a "described only / all steps" toggle.
- Edit label: writes the `labels:` entry into `.stingray/views/<view>.yaml` (the file shows as changed in git) and
  recomputes.
- Node cap: an expansion that doesn't fit stays closed and offers "open as its own flowchart".

## Phases (each a PR)

1. **No code, readable text:** remove code from boxes, wrap/clamp, text-sized boxes, full text on select, the code
   snippet in the Inspector, relaxed edge labels. Tests: `flow-layout.test.ts`, views-tab fixture.
2. **Labels:** docstring/JSDoc extraction, YAML `labels:` + matching, fallbacks, the `described` flag/marker,
   `check`'s to-do list and stale-label warnings, skill update (agents label unclear decisions). Tests:
   `flowchart.test.ts`, `flowchart-labels.test.ts`.
3. **Less clutter:** the noise rule + `hide:`, described-only folding with per-frame/global "all steps", guard clauses
   → can-fail badges.
4. **Drill-down:** call-path ids, `expanded`/`collapsed`, `expand:`, chevrons/collapse, viewport anchoring, Save
   writes `expand:`, node-cap fallback, CLI `--expand`.
5. **Edit label in the UI:** Inspector action that writes `labels:` into the YAML.
6. **Other view kinds:** apply the same rules to graph/flow and layers views. Work out what sequence diagrams need.

Every phase: `npm run build`, `npm test`, the relevant `npm run test:*` suite, and a look at the auth sign-in flowchart
in the Docker test env (before/after screenshots).

## Open

- How sequence diagrams should work (later, after flowcharts).
- The exact definition of "trivial library call". Start with value-only calls (assignment or return of a library call
  with no other effect) and tune it on the auth example.
