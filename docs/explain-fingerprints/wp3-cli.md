# WP3 — CLI: restamp maps, `--strict`, text output, docs

Spec: `docs/explain-fingerprints-spec.md` §CLI. Overview: `docs/explain-fingerprints-plan.md`. Branch:
`feat/efp-cli`, started **after** WP1 + WP2 + WP4 are merged into the integration branch `feat/explain-callee-fingerprints`.

## Goal

`stingray-views check --restamp` writes the new fingerprint maps, and `check --strict` gives CI a failing exit code
for explanations that need review. Text output and the skill doc are updated to match.

## Read first

- `electron/views-cli.ts`: usage text (~L40), argument parsing (~L70–85), `check()` (~L110–195), `restampFile()`
  (~L198), `laggingFiles()`
- `src/views-text.ts` `explained()` (~L62)
- `src/views.ts` `ExplainDiagnostic` (now with `pieces`, `skipped`, `status`, `changes`), `ExplanationStatus` incl.
  `legacy`
- `electron/views/explain.ts` (as merged from WP2)
- `tests/views-cli.test.ts`
- `agents/skills/stingray-views/SKILL.md`: the `explain:` section (`dist-electron/skills/...` is a build output, don't edit it)

## Steps

1. **`--restamp`** (`restampFile`):
   - Write `e.pieces` as a YAML map under `fingerprint`, replacing a string or an older map. Keys like
     `services/x.py::A.b` and `drawn:sql:db.sql#users` must round-trip, so quote them if the `yaml` library wouldn't.
     Keep comments and formatting elsewhere (the existing `parseDocument` / `doc.toString({ lineWidth: 0 })` approach).
   - Skip when the stored map deep-equals `pieces`.
   - Skip reasons stay the same. `e.fingerprint === null` becomes `e.pieces === null`. The lagging guard already uses
     `e.files`, which now covers callee files too.
   - Output: `restamp: stamped "K" (N pieces) (file:line)`. Mention skipped callees: `restamp: "K": could not
     fingerprint callee X (left out)`.
2. **`--strict`**:
   - Parse it next to `--json` / `--restamp`. `--strict --restamp` → `deps.err(...)` and exit 2.
   - After normal output (text or JSON), count `diagnostics.explain` entries whose `status` is `stale`, `unstamped` or
     `legacy`. If N > 0, print `strict: N explanation(s) need review` (to stderr, so `--json` stdout stays valid JSON)
     and exit 1. Other failures keep their existing exit codes, and the higher one wins.
   - Update the usage/help text.
3. **Text output** (`views-text.ts`): status `legacy` → suffix ` (old fingerprint)`. Stale stays ` (may be outdated)`.
4. **Skill doc** (`agents/skills/stingray-views/SKILL.md`), `explain:` section:
   - the map format, and that `--restamp` writes it;
   - what a fingerprint covers: the body plus direct in-repo callees, including excluded files, one level deep, no
     libraries;
   - the four statuses and their warnings, and that old string stamps show as legacy until restamped;
   - `--strict` for CI.

## Tests (`tests/views-cli.test.ts`, `npm test`)

- restamp writes a map, replaces an old string, keeps comments, and is a no-op when it's current. The output lines name
  the piece count. A skipped callee is mentioned.
- strict: exit 0 when everything is current; exit 1 on stale, on unstamped and on legacy (one test each or a table);
  with `--json` the stdout parses as JSON and the strict line goes to stderr; `--strict --restamp` → exit 2.
- text output shows `(old fingerprint)`.

## Acceptance

- `npm run build` and `npm test` green (the 4 known activity-shell failures are pre-existing).
- Manual: on a `/tmp` clone of Travella with an `explain:` entry on `identity`, run `--restamp` and then `check` (clean),
  then edit a callee and run `check --strict` (warning naming the callee, exit 1). This also covers the spec's
  acceptance 1–4.

## Rules

- Touch only `electron/views-cli.ts`, `src/views-text.ts`, `agents/skills/stingray-views/SKILL.md`, and tests. If the
  engine (WP2) needs a fix, describe it in your report rather than changing `explain.ts`, unless it's a one-line bug fix
  that you call out explicitly.
- Never commit into the Travella repo. Commit in small steps; don't push or open PRs. Report the commits, verification
  and deviations.
