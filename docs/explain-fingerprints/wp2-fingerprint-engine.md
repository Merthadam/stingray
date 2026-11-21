# WP2 — fingerprint engine: pieces, comparison, messages

Spec: `docs/explain-fingerprints-spec.md`, all of it but especially §Pieces and §Status and messages. Overview and
shared contracts: `docs/explain-fingerprints-plan.md`. Branch: `feat/efp-engine`. Runs in parallel with WP1 (graph
lookups) and WP4 (UI). Code against the contracts and test with fakes; WP1's real implementations get merged later.

## Goal

An `explain:` entry's fingerprint becomes a map with one hash per piece of code: the target's own body plus each
direct in-repo callee, or `drawn:<id>` for targets without a symbol. Comparing it against the current code yields
status `view | stale | unstamped | legacy`, the changed/added/removed pieces, and a warning text that names them.

## Read first

- `electron/views/explain.ts` (the whole file; you're extending it)
- `electron/views/rules/schema.ts` ~L90–230: `explainSchema`, `FINGERPRINT`, `ExplainEntry`, `explainPair`
- `electron/views/compute.ts` ~L20–65: `ComputeDeps`, the `applyExplain` call
- `src/views.ts` ~L20–75 and ~L184–200: `SymbolRef`, `ExplanationStatus`, `DiagramNode`/`DiagramGroup` explanation
  fields, `ExplainDiagnostic`
- `electron/views/explanation.ts` `symbolRef()`: how `GraphSymbol` becomes `SymbolRef`
- `tests/explain.test.ts` (existing tests; update them to the new format)

## Contract additions you own

- `src/views.ts`: `ExplanationStatus` += `'legacy'`; `explanationReason?: string` on `DiagramNode` and `DiagramGroup`;
  `ExplainChanges`; the new `ExplainDiagnostic` fields (`pieces`, `skipped`, `status`, `changes`). Use the exact shapes
  in the plan's contracts.
- `SymbolRef.qualifiedName?: string`, filled in `symbolRef()` from `GraphSymbol.qualifiedName`. Add that optional field
  to `GraphSymbol` in `electron/views/rules/types.ts` yourself (one line; WP1 adds the same line, and git will reconcile
  identical edits).
- `ComputeDeps.callees?` / `ComputeDeps.fileSymbols?`, exactly as in the contracts (WP1 adds the same, so keep it
  identical).

## Steps

1. **Schema** (`schema.ts`): `fingerprint` = the existing 12-hex string **or** `z.record(key 1–500 chars, 12-hex
   string)` with ≤ 200 keys. Keep the existing error messages, including the all-digit quoting hint, for both shapes.
   `ExplainEntry.fingerprint: string | Record<string, string> | null`.
2. **`collectPieces`** (`explain.ts`):
   ```ts
   interface PieceDeps { read: ReadSource; callees?: ComputeDeps['callees']; fileSymbols?: ComputeDeps['fileSymbols'] }
   async function collectPieces(targets: Target[], nodes, groups, deps): Promise<{ pieces: Record<string,string> | null; skipped: string[]; files: string[]; why?: string }>
   ```
   - Symbol target: key = `symbol.qualifiedName ?? \`${file}::${name}\``, value = `bodyFingerprint`. If it isn't
     hashable, return `pieces: null` with the existing reasons.
   - Callees: one batched `deps.callees(ids of all symbol targets)` call. For each callee:
     - class kind → look for a method named `__init__` or `constructor` in `fileSymbols(callee.file)` within
       `[line, endLine]`. If there's none, skip it silently (not listed in `skipped`).
     - skip it if it's one of the targets (recursion) or its key is already present.
     - otherwise hash it with `bodyFingerprint`. If that fails, add its key to `skipped`.
     - files excluded by the view are **not** filtered out.
   - Non-symbol target: `drawn:<id>` → `drawnFingerprint`.
   - More than 200 pieces → `pieces: null`, `why: 'it calls too many functions to fingerprint'`.
   - Read each file once (keep the existing `sources` cache). `files` = the sorted files of all pieces.
3. **`compareFingerprint(stored, current)`** (pure, exported): `null` → `unstamped`; string → `legacy`; map →
   `{ changed, added, removed }` sorted; all empty → `view`, else `stale`.
4. **`describeChanges(key, changes)`** (pure, exported) → the reason, e.g. `may be outdated: SessionStore.get_user
   changed; new call audit.log; no longer calls cache.get`:
   - Display name: the part after `::`, or the full key when that short form appears twice in the message. A `drawn:<id>`
     key shows as `"<label or id>" changed (as drawn)`.
   - At most 3 names per category, then `(+N more)`.
5. **`applyExplain`** now takes `options: { verify; readSource?; callees?; fileSymbols? }`:
   - When verifying: collect pieces, compare them, and set `explanation`, `explanationStatus` and `explanationReason`
     (`reason` for stale; `old fingerprint format (own body only)` for legacy; the `why` text for an uncomputable
     unstamped entry) on every target.
   - Without verification: unchanged, except that a stored string → `legacy`.
   - Warnings use the spec wording, i.e. the reason plus ` — review it and run stingray-views check --restamp`.
   - Diagnostics: `fingerprint` = 12-hex hash of the sorted `key=value` lines of `pieces` (null when `pieces` is null),
     plus `pieces`, `skipped`, `status` (null when unresolved), `changes` (empty arrays unless stale), and `files`.
6. **`compute.ts`**: pass `deps.callees` and `deps.fileSymbols` through to `applyExplain`.

## Tests (`tests/explain.test.ts`, `npm test`)

Use a fake `readSource` (an in-memory file map) and fake `callees` / `fileSymbols`:
- pieces: own body plus callees; a callee in a file the view excludes is kept; a library call is absent (the fake
  returns nothing); recursion skipped; class → `__init__`; class without a constructor skipped; an unreadable callee
  lands in `skipped`; an unreadable target → unstamped with its reason; > 200 → unstamped; same-named targets → union.
- status: a map stamp that's equal → view; a callee body edit → stale `X changed`; a callee's callee edit → **not**
  stale (the fake returns only one level); an added call → `new call`; a removed call → `no longer calls`; a string stamp
  → legacy (both with and without verify); no stamp → unstamped.
- messages: the 3-name cap with `(+N more)`, short vs full names on collision, `drawn:` wording.
- schema: a map is accepted; bad values, too many keys, and all-digit unquoted values are errors.
- Update the existing tests that assert the string format.

## Acceptance

- `npm run build` and `npm test` green (the 4 known activity-shell failures are pre-existing).
- `stingray-views check` on a view with an old string fingerprint prints the legacy warning (smoke test with
  `npm run build` and the CLI on a fixture under `/tmp` if practical).

## Rules

- Touch only `electron/views/explain.ts`, `electron/views/explanation.ts`, `electron/views/rules/schema.ts`,
  `electron/views/rules/types.ts` (the one field), `electron/views/compute.ts`, `src/views.ts`, and tests. The CLI
  (`views-cli.ts`, `views-text.ts`) belongs to WP3, the UI to WP4, the graph adapters to WP1.
- Commit in small steps. Don't push and don't open PRs. Report the commits, verification, and deviations.
