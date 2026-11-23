# Step 2 — Dead code (audit 17)

Status: draft · Umbrella: [modular restructure](2026-11-23-modular-restructure-design.md)

## Goal

Delete code that no caller uses before contracts and moves, so later steps do not carry it.

## Non-goals

- Keeping or deleting anything not listed here. "Looks unused" is not enough; each removal below was grepped.
- Removing the SQLAlchemy extractor (`extractDbSchema`): it is used by views and the CLI.
- Removing the demo's sample schema (`demoDbSchema`): demo views use it.

## Current behaviour (verified)

### `db-schema` IPC route

- `electron/main.ts:150-160`: `dbScans` cache + `handle('db-schema', ...)` calling `extractDbSchema`.
  Imports only for it: `extractDbSchema` (main.ts:19) and `DbSchemaResult` (main.ts:20).
- `electron/preload.ts:18`: `dbSchema: id => ipcRenderer.invoke('db-schema', id)`.
- `src/shared.ts:107`: `dbSchema(workspaceId: string): Promise<DbSchemaResult>;` and its type import at
  `src/shared.ts:4`.
- `src/demo.ts:249`: `dbSchema: async id => ...`.
- No renderer or test calls `api.dbSchema` / `window.stingray.dbSchema` (grep of `src/` and `tests/`).
- Still used, must stay: `extractDbSchema` in `electron/views/service.ts:2,103` and `electron/views-cli.ts:272-280`;
  `demoDbSchema` in `src/demo.ts:27,143,156`.

### Project-home prototype

- `src/project-home.prototype.tsx` (header: "THROWAWAY"), `src/project-home.prototype.css`,
  `src/project-home.prototype.html`. Only entry is the `prototype:home` script (`package.json:12`).
- `tests/desktop.mjs:102` asserts, among other things, `!document.querySelector('.ph-switcher')`. `.ph-switcher`
  only exists in the prototype. The rest of that check (no horizontal overflow) is real and stays.

### `identity` in `reviewPushStatus`

- `electron/worktree-removal.ts:4-17` returns `{ push, identity }`; the only caller
  (`electron/git.ts:153`) destructures `{ push }` only. No test reads `identity` (grep `tests/`).

### `PullRequestService.status()`

- `electron/pull-requests.ts:108-115`. No production caller: `GitStateService` uses `resolve`
  (`electron/git-state.ts:26,158,171`). Callers are tests only: `tests/pull-requests.test.ts` lines 74, 125,
  138-145, 152.

## Design

1. Delete `main.ts:150-160` and the two imports. Delete `preload.ts:18`, `shared.ts:107` and the now-unused type
   import at `shared.ts:4`. Delete `demo.ts:249` and its comment line 248.
2. `git rm` the three prototype files; remove the `prototype:home` script; in `tests/desktop.mjs:102` drop only the
   `&& !document.querySelector('.ph-switcher')` clause and the words "or a prototype switcher" from the label.
   The overflow assertion stays as is.
3. `reviewPushStatus` returns `RemovalReview['push']` directly; `git.ts:153-154` adapts
   (`const push = branch ? await reviewPushStatus(...) : {...}`).
4. Delete `PullRequestService.status()`. Rewrite its test calls as `resolve(cwd, branch, remote)` with the same
   branch/remote the fake runner returned:
   - line 74: `service.resolve('/repo', 'feature/ui', 'git@github.com:owner/app.git')`;
   - "missing Git, detached HEAD, absent and unsupported origins" (from line 57): detached → `resolve(cwd, '', remote)`,
     absent origin → `resolve(cwd, branch, null)`, unsupported → `resolve(cwd, branch, '<unsupported url>')`; each
     still asserts zero `gh` calls. The "missing Git" case moves out of PullRequestService entirely: it is
     `GitStateService.compute` with a failing `status` (no `resolve` call). Check `tests/git-state.test.ts` covers
     "status error → no PR lookup"; add that assertion if not.
   - "isolates remotes" and "missing gh" tests: same substitution; assertions unchanged.

## Acceptance criteria

- [ ] `grep -rn "'db-schema'\|dbSchema(" src electron` finds nothing except `views-cli` deps (`dbSchema:` dep name
      in `electron/views-cli.ts:34,145,280`, which is the CLI's own injection and stays).
- [ ] `src/project-home.prototype.*` gone; `prototype:home` gone; `grep -rn "ph-switcher\|project-home.prototype\|prototype:home" src tests package.json`
      finds nothing.
- [ ] `grep -n identity electron/worktree-removal.ts` finds nothing.
- [ ] `grep -rn "\.status(" tests/pull-requests.test.ts` finds nothing; every former case still exists as a
      `resolve` case or a git-state case.
- [ ] `npm run check` and e2e `desktop`, `pull-requests`, `worktree-removal`, `views-tab` pass.

## Verification

```
npm run check
npm run test:e2e -- desktop pull-requests worktree-removal views-tab
```

## Risks & rollback

- A hidden caller of `window.stingray.dbSchema` (e.g. an agent skill or doc) breaks. Grep of `agents/` and `docs/`
  found none. Rollback: revert the commit.

## Open questions

- `identity` (upstream ref + tip) is exactly the data the removal-consent fingerprint (step 7, finding 3) could use
  to detect an upstream that moved between review and removal. This spec deletes it as agreed; step 7 hashes the
  visible `push` (upstream, ahead, behind) instead. If the upstream tip itself should be part of consent, keep
  `identity` and feed it to the fingerprint instead of deleting it.
