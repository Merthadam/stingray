# `explain:` fingerprints with callees — design spec

Status: draft (design agreed, not implemented). Builds on PR #13 (`explain:` entries, fingerprints, `check --restamp`,
`electron/views/explain.ts`).

## Goal

An `explain:` entry should be flagged "may be outdated" when the code it describes changes, including the functions that
code calls. When it is flagged, the warning should say **what** changed. Today the fingerprint covers only the
function's own body and is a single opaque hash.

## Decisions

| # | Question | Decision |
| --- | --- | --- |
| A1 | What does a symbol entry's fingerprint cover? | The symbol's own body **plus every function it calls directly**, always (no opt-in list). |
| A2 | Which calls count? | Calls the code graph resolves to a symbol **in this repo**, including symbols in files the view excludes (`scope.exclude`, flowchart `exclude`). Library / stdlib / unresolved calls are not counted. **One level** deep: callees of callees are not included. |
| A3 | Shape of the stamp | **One hash per piece of code** (a map), so a warning names the piece that changed, the call that was added and the call that was removed. |
| A4 | Fingerprints written before this change | A plain-string fingerprint is the **old format**. It gets a "old fingerprint format — run --restamp" warning, not "may be outdated". The map shape itself identifies the new format; no `v2:` prefix. |
| B | Staleness for docstrings | **None.** Docstring explanations stay unchecked (they live next to the code and are reviewed with it). |
| C | Strictness | Warnings by default. New **`stingray-views check --strict`** exits non-zero when any `explain:` entry is stale, unstamped or in the old format. |
| D | Plans (`expect:`, `status: planned`) | **Out of scope.** `explain:` only describes code that exists. |

## View file

```yaml
explain:
  identity:
    text: "Accept only genuine, unrevoked tokens of verified travelers"
    fingerprint:                                     # written by stingray-views check --restamp
      services/auth/api.py::create_app::identity: 3f9a1c0d22be
      services/auth/jwt_verifier.py::JwtVerifier::verify: 81c2e0a7f310
      services/auth/session_store.py::SessionStore::get_user: 0d44b9e1a2c7
  users:                                             # a table: no symbol, hashed as drawn
    text: "One row per traveler; email is the Cognito username"
    fingerprint:
      drawn:sql:db/schema.sql#users: 5be0c4a19d02
```

- `fingerprint` is either a **map** (new) of piece key → 12 lowercase hex characters, or a **string** of 12 hex
  characters (old format, still accepted by the schema). At most 200 keys. Map values that are all digits must be
  quoted; the existing error message for that case still applies.
- Authors never write the map by hand; `--restamp` writes it. Hand-edits are validated like any other key.

## Pieces

For each node or group an entry resolves to (`explainTargets`, unchanged):

1. **Target with a symbol** (`t.symbol`):
   - The target itself: key = its file and code-graph **qualified name**, which is file-relative
     (`<file>::<qualified name>`, e.g. `services/auth/api.py::create_app::identity` for a function nested in `create_app`),
     value = `bodyFingerprint` of its lines (unchanged algorithm: lines `line..endLine`, trailing whitespace ignored).
   - Each **direct callee**: outgoing `calls` relations of the target's symbol id in the code graph (heuristic ones
     included, since dynamic-language method calls are often only heuristically resolved), mapped to symbols:
     - kept when the callee is a callable symbol (function, method, and similar kinds) with a known `endLine` whose file
       is readable. Its key is `<file>::<qualified name>` and its value is its `bodyFingerprint`;
     - a **class** callee (a constructor call) is replaced by its constructor (`__init__` / `constructor` method inside
       the class's line range) when the graph has one, otherwise skipped;
     - the target itself (recursion) and symbols already in the map are skipped. Callees in excluded files are **not**
       skipped (A2).
2. **Target without a symbol** (tables, LangGraph steps, infra): one piece, key `drawn:<node or group id>`, value =
   `drawnFingerprint` (unchanged algorithm, groups include their members as drawn).

An entry's map is the union over all its targets (same-named functions → all of them and all their callees).

**Unhashable pieces:**
- If a *target's own* body cannot be hashed (unreadable file, no end line, file shorter than the graph says), the whole
  entry cannot be checked: status `unstamped`, with the reason, as today.
- If a *callee* cannot be hashed, it is left out of the map. The diagnostic lists it under `skipped`, so callees that
  can never be checked are visible in `--json`.
- More than 200 pieces: the entry cannot be checked (`unstamped`, reason "calls too many functions to fingerprint").

## Status and messages

Compare the stored fingerprint with the current map (only when the code graph is ready, as today):

| Stored | Result | `explanationStatus` | Warning |
| --- | --- | --- | --- |
| none | — | `unstamped` | `explanation for "K" has no fingerprint — run stingray-views check --restamp to stamp it` (or the reason it cannot be computed) |
| string | — | `legacy` | `explanation for "K" uses the old fingerprint format (own body only) — review it and run stingray-views check --restamp` |
| map, equal | — | `view` | — |
| map, differs | changed / added / removed keys | `stale` | `explanation for "K" may be outdated: X changed; new call Y; no longer calls Z — review it and run stingray-views check --restamp` |

- Lists show at most 3 names per category, then `(+N more)`. Names are shown without the file path when unique within
  the message (`SessionStore::get_user`), otherwise in full.
- A `drawn:` key that changed reads as `"users" changed (as drawn)`.
- Code graph not ready: entries are applied unchecked (status `view`), as today. Old-format entries still show
  `legacy`, because that check needs no graph.
- Nodes and groups carry the reason next to the status: new optional `explanationReason?: string` (the warning text
  without the trailing advice). The UI shows it in the tooltip and Inspector.

## CLI

- `check` text output: `(may be outdated)` stays as the stale suffix; `legacy` prints `(old fingerprint)`.
- `check --restamp`: writes the full map for each resolved, computable entry, replacing a string or an older map, and
  keeps comments and formatting (yaml `Document`). The lagging-index guard covers the files of **all** pieces (targets
  and callees). It stays an all-or-nothing refusal when `check` failed. Output per entry:
  `restamp: stamped "identity" (3 pieces) (view.yaml:12)`.
- `check --strict`: same output, exit code 1 if any `explain:` entry is `stale`, `unstamped` or `legacy`, after
  printing a summary line `strict: N explanation(s) need review`. Combines with `--json` and `--depth`. It does not
  combine with `--restamp`, which is an error (exit 2).
- `--json`: `diagnostics.explain[i]` gains `pieces: Record<string, string> | null` (current map; `fingerprint` keeps
  being a single summary hash of the map for display), `skipped: string[]`, `status`, `changes: { changed, added,
  removed }` (keys; empty arrays when not stale).

## Non-goals

- Callees of callees, opt-in `covers:` lists, staleness for docstrings, `expect:` / planning, a strict mode in the app.
- Hashing library code or any code outside the worktree.

## Acceptance criteria

1. Travella `auth-sign-in.yaml` with an `explain:` entry on `identity`: after `--restamp`, `check` is clean. Editing the
   body of a function `identity` calls (in a file excluded from the view) makes `check` warn
   `… may be outdated: <callee> changed`. Adding a call to another repo function warns `new call …`, and removing one
   warns `no longer calls …`. Changing only a library call's arguments inside a callee counts as that callee changing.
2. Editing a callee's callee does **not** make it stale.
3. A view whose entries still carry string fingerprints shows `legacy` warnings, not stale, until restamped.
4. `--strict` exits 1 on stale, unstamped and legacy entries and 0 when everything is current; `--strict --restamp` exits 2.
5. Table/LangGraph (no symbol) entries keep working and restamp to a `drawn:` map.
6. App: a stale node's tooltip/Inspector shows which piece changed.
7. `npm run build`, `npm test` green; tests cover piece collection (callees, class→constructor, recursion, excluded files
   kept, library calls absent, unhashable callee skipped, cap), status/diff/messages, schema (string | map), restamp of
   maps (comments kept), `--strict` exit codes.
