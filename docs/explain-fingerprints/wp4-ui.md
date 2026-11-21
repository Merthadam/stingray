# WP4 — UI: show why an explanation is outdated; `legacy` status

Spec: `docs/explain-fingerprints-spec.md` §Status and messages (the `explanationReason` bullet). Overview:
`docs/explain-fingerprints-plan.md`. Branch: `feat/efp-ui`. Runs in parallel with WP1 and WP2.

## Goal

When an explanation is stale, the app says *what* changed (e.g. "may be outdated: SessionStore.get_user changed") in
the tooltip and the Inspector. Old-format stamps (`legacy`) get a muted mark labelled "old fingerprint".

## Contract (WP2 implements it; you code against it)

In `src/views.ts`, add these yourself. WP2 adds identical lines, and the merge reconciles them.
- `export type ExplanationStatus = 'view' | 'stale' | 'unstamped' | 'legacy';`
- `explanationReason?: string;` on `DiagramNode` and `DiagramGroup` (right after `explanationStatus`). It's set for
  `stale` (e.g. `may be outdated: SessionStore.get_user changed; new call audit.log`) and for `legacy` (`old fingerprint
  format (own body only)`), and sometimes for `unstamped`.

## Read first

- `src/views-ui/FlowNode.tsx`: `StaleMark`, `explanationTitle`, `STALE` (~L10–30), `FlowGroup`, the node explanation
- `src/views-ui/FlowDiagram.tsx` ~L60–70 (group data) and ~L145–155 (group Inspector)
- `src/views-ui/Inspector.tsx` ~L30–40
- `src/views-ui/TableNode.tsx` ~L33
- The CSS for `.flow-explanation`, `.er-card-explanation`, `.flow-inspector-explanation` and the stale mark (find it
  with `rg -n "stale" src/*.css src/views-ui`)
- `tests/views-tab.mjs` and `.agents/skills/run-local/SKILL.md` (disposable env + CDP)

## Steps

1. **`StaleMark({ status })`**: `stale` as today; `legacy` → a muted variant (same glyph, lower contrast) with the
   accessible label "old fingerprint"; anything else → nothing.
2. **`explanationTitle(text, status, reason?)`**: for stale and legacy, append `\n(<reason ?? default>)`. The default
   is the existing `STALE` text, or "old fingerprint" for legacy. Update all callers to pass the reason (group data in
   `FlowDiagram.tsx` needs `explanationReason` added to the data object and to the `FlowGroup` props type).
3. **The group's `aria-label`** in `FlowGroup` includes the reason when there is one.
4. **Inspector** (node, `Inspector.tsx`; group, `FlowDiagram.tsx`): when the status is stale or legacy and there's a
   reason, render it under the explanation as a small muted line (`flow-inspector-explanation-reason`).
5. **CSS**: the muted legacy mark and the reason line. Follow the existing tokens and variables, with no new colours
   unless they're needed.

## Tests / verification

- Unit tests: if there are tests for `explanationTitle` / `StaleMark` (search `tests/`), extend them. Otherwise add
  small ones for `explanationTitle` (stale with and without a reason, legacy, view).
- `npm run test:views-tab` green.
- Visual: `scripts/test-env.sh up --detach`, then open a view whose `explain:` entry is stale and one with a string
  (legacy) fingerprint. Until WP2 is merged, you can fake the statuses in a fixture view result if the env allows it;
  otherwise verify with the unit tests and state that in your report. Screenshot via CDP, then `scripts/test-env.sh
  down --all`.

## Acceptance

- `npm run build`, `npm test` and `npm run test:views-tab` green (the 4 known activity-shell failures are pre-existing).
- A stale node's or group's tooltip and Inspector name what changed; a legacy one shows "old fingerprint".

## Rules

- Touch only `src/views-ui/*`, the related CSS, the two `src/views.ts` lines above, and tests. Don't touch the engine,
  CLI, or graph code.
- Don't build or replace the installed app. Commit in small steps; don't push or open PRs. Report the commits,
  verification (with the screenshot path), and deviations.
