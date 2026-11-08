# Worktree removal and card selection — source verification

## Scope

Source implementation and disposable-fixture tests only. No user worktrees removed, installed app replaced/restarted, dependency installation, production terminal/container operation, commit, push or publication. This report is evidence, not authorization for delivery.

## Behavior

- Managed workspace cards have an independent **Remove worktree…** trash action; the primary repository does not. The header action opens the same dialog. Opening removal on a background card does not select it.
- Read-only preflight verifies managed-path ownership and Git membership, reports tracked/untracked/ignored entries and open terminals, and blocks detached, switched-from-registration or locked worktrees.
- Upstream comparison uses local remote-tracking refs only. Ahead and behind counts are shown. Missing, local-only, missing-ref or failed upstream checks are explicitly unknown. The dialog discloses stale tracking data and performs no fetch/network check.
- Ahead/unknown states require acknowledgement; all removals require the exact registered branch name. The branch and its commits are preserved; no branch deletion, force removal or automatic terminal shutdown.
- The main process repeats the review and compares a content-derived review token covering workspace/path, branch/HEAD, status/blockers and upstream results/ref identity. A changed review resets confirmation and acknowledgement. Missing/invalid consent is refused at IPC and service boundaries.
- App-owned Git mutations and terminal creation are serialized. These checks are not an atomic transaction against external Git/filesystem writers; avoid concurrent external edits during removal. Git's non-force removal is an additional guard, not a claim of race-free deletion.
- Card backgrounds now use the branch button's stretched native hit area. PR/activity tooltip targets remain above it and select through card delegation. Refresh, remove, line-count and port actions remain independent. Keyboard branch selection is preserved.

## Running-build and reproduction limits

A read-only process-path check found the packaged app at `~/Projects/stingray/release/Stingray.app` (PID 23313 at inspection), alongside other Electron development processes. Its unpacked renderer `index-BypjAjI4.js`, SHA-256 `9d5f0a95ef8b9829ad1a2bb4b91d2a01705453ea90c18494918e1b1989d9b115`, already contained the previous delegated whole-card click handler. Therefore absence of that handler is not an established explanation for the reported failure. An initial ASAR-path lookup failed because this bundle is unpacked; inspection then read its existing files without extraction or modification.

The existing pre-change `dist` UI (older than current source integration; it still displayed Changes) passed 18 expanded baseline checks after correcting the test to click within the visible scrollport. The first run clicked a compact card's clipped/off-screen bottom edge and timed out; failure evidence is retained. This does not reproduce the user's exact installed-app click failure. No interaction with the user's live app or production sessions was performed. Native hit-area assertions verify the new background behavior, but installed-build acceptance remains outstanding.

## Verification

| Check | Result | Evidence under `artifacts/testing/worktree-removal/` |
| --- | --- | --- |
| TypeScript and production build | Passed; existing >500 kB renderer warning | `verification/build-reviewed.log` |
| Full unit/integration suite | 113/113 passed on final run | `verification/unit-final.log` |
| Expanded native cards/removal | 41/41 passed, no renderer errors | `native-reviewed/results.json`, `verification/native-reviewed.log` |
| Desktop regression | 31/31 passed after service review refactor | `desktop-final/`, `verification/desktop-final.log` |
| PR/sidebar regression | 36/36 passed | `sidebar/results.json` |
| Workspace ports regression | 28/28 passed | `ports/results.json` |
| Whitespace | `git diff --check` passed | Run after implementation |

Native removal tests use actual local Git histories, disposable worktrees and an isolated Electron data directory. They cover missing upstream, acknowledgement, cancel, dirty/ignored files, real terminal blockers, stale-dialog commits, IPC consent enforcement and preservation of unpushed commits. Unit tests additionally cover behind/diverged/gone/local upstreams, command failure, stale remote refs, detached/switched/locked branches and zero-ahead removal. Card tests use wide/compact raw-coordinate clicks and hit testing; Idle metadata is synthetic, not a live provider run. GitHub/Docker are fixtures in the regression suites; ports include real PTY-launched servers.

One initial full unit run hit the previously documented clone-timeout fixture failure (missing `transport.pid`): 112 passed, 1 failed. Unchanged full reruns passed 113/113; no clone code/test was modified and the intermittency is not claimed fixed. Initial and subsequent logs remain in `verification/`.

The final tooltip-preservation CSS adjustment was rebuilt and checked with all 41 native card/removal assertions; it did not change backend logic. Completed unrelated integration/Repo Map/provider suites were not rerun. No packaged candidate or installed-path verification was performed for this change.
