# Stingray status

Updated 2026-11-07. Context, not authorization for further work.

## Sidebar delivery verification

- Fresh continuation checks passed: **51/51 unit tests**, TypeScript/production build, candidate **31/31 PR**, **27/27 ports**, **31/31 desktop**, **22/22 add-project**, deep/strict signature and isolated LaunchServices smoke. Candidate: `release/sidebar-candidate-2026-11-07/Stingray.app` in this source checkout. Native PR/ports result files now record the tested executable and distinguish packaged/source scope.
- Installed path: `~/Projects/stingray/release/Stingray.app`, outside this checkout. Source publication does not establish app promotion. The separate local report `artifacts/testing/2026-11-07-sidebar-delivery/continuation/verification.md` records the actual promotion outcome, preserved backup and final-path checks; `status.json` alongside it records the bounded updater's current state or blocker.
- User explicitly accepted ending active terminal sessions for this update. Only normal quit is permitted; its confirmation remains user-operated. No force-kill, bypass, replacement of a running bundle or automatic rollback. A detached, one-shot local updater allows verification to continue after this Stingray-hosted agent exits. It stops on failed gates and does not change credentials/global settings, publish binaries or operate on unrelated projects.
- Source/privacy preflight found only existing deliberate dummy credential URLs in tests. Dependencies, app bundles, local state, credentials and test artifacts remain excluded. Commit identity is reused from the initial source commit with per-command settings, not an inferred identity or global configuration change.
- The sections below preserve historical source/implementation checkpoints; their pre-delivery statements do not supersede the separate delivery report.

## Earlier source checkpoint: simplified sidebar cards

- Current-session user clarified branch name at the bottom, state-changing branch/PR symbol with a small PR number underneath, no bottom PR label or dropdown, and +/− at the card's top-right. Subsequently requested removal of the irrelevant files-changed badge; removed it.
- Cards now contain just that Git/PR presentation plus the existing port badge/refresh control. Ports sit beneath the top-right line counts to keep the full card visible at compact heights. Clicking line counts, including a background workspace, selects it and opens Changes. Actual branch name retains truncation/tooltips; PR states retain accessible names and non-color icons.
- Added bounded read-only net tracked-file line statistics against HEAD. Staged/unstaged combined; pure renames add no lines. Excludes untracked/submodules, discloses binary-file exclusion, and reports unavailable for unborn HEAD, conflicts or failed reads. Changes still includes untracked files. Browser data remains simulated; no state selector.
- Final checks: 51/51 unit tests, TypeScript/build, 31/31 native PR/sidebar checks, 27/27 ports checks, 31/31 desktop regressions, browser DOM/visual checks and no browser warnings/errors. Report: `artifacts/testing/sidebar-card-refinement/verification.md`.
- Two initial unit runs reproduced the existing clone-timeout missing-PID fixture issue; final full run passed with no clone changes. One native run was unexpectedly closed (cause unknown); full reruns passed. Ports hover test now moves the pointer away before testing re-entry after Escape; product port code unchanged. Preserve failure evidence.
- No packaged-app replacement/restart, user terminal/container changes, credentials, live GitHub requests, commits, pushes or publication. Earlier unrelated dirty work remains preserved.

## Earlier source work: sidebar Git and pull-request summaries (layout superseded above)

- User approved green open-PR/purple merged states, branch name and changed-file count with read-only GitHub integration and a simulated preview, then explicitly corrected placement to the left workspace cards instead of the top right.
- Git/PR details now live alongside ports in each sidebar workspace card, including background workspaces. Removed the header summary. Identical branch/workspace names are not repeated; differing checked-out branches have a separate line. File count selects its workspace and opens Changes. Badges wrap within compact cards.
- Added read-only `gh pr list` through existing CLI authentication, pinned to github.com origin. No credential changes or PR mutations. Exact head repository/branch matching, open-first then most-recently-updated history; fork-to-upstream discovery and Enterprise/other hosts are not supported.
- Bounded commands/results, coalescing/cache/cooldowns, visibility-aware one-minute PR polling and manual retry across displayed workspace rows. Background Git and PR reads share a three-request queue; unmounted/stale queued work is skipped. Loading, no PR, draft, closed, missing/unsupported origin, detached HEAD and lookup failures remain distinct. Workspace switching discards stale responses.
- Browser demo has an explicitly simulated PR-state selector; it never accesses GitHub. Packaged app remains unchanged.
- Verification: 47 unit tests, TypeScript/build, 27 native PR/sidebar checks (real Git, fixture gh), 27 real-PTY/process-scanner checks and 31 desktop regressions. Separate live read-only gh lookup on this checkout's main succeeded with no matching PR. Evidence: `artifacts/testing/sidebar-git/verification.md`.
- Initial full unit run hit an existing clone-timeout fixture failure (transport PID file absent); immediate complete rerun passed without changing clone code/tests. Do not claim this intermittent issue resolved.

## Source work: compact workspace ports

- Replaced the large container panel with small sidebar radio-tower/count badges and a hover/click/keyboard popover. Git/PR metadata now lives in these same sidebar cards.
- Added bounded read-only macOS discovery of TCP listeners from Stingray terminal PIDs and descendants (including npm-launched servers). Reads PID/PPID metadata, not command lines/environments. Associated local Docker ports merge into the same badge; unassociated or unpublished containers do not count.
- Added scanning/waiting/opening states, independent discovery errors/retry, preview loading and slow-server waiting. TCP listeners are not HTTP health checks. No kill controls, detached-process environment scanning, remote forwarding, or application replacement.
- Fresh verification and limitations are in `artifacts/testing/sidebar-git/verification.md`; earlier port screenshots/results remain under `artifacts/testing/compact-workspace-ports/`. Docker integration uses a fixture.
- Selected Superset packaged/source-map component hashes were rechecked against the installed app; REA evidence is static and partial, not live runtime parity. Local investigation: `artifacts/re-superset/compact-sidebar-findings.md`.
- No bundle was packaged, replaced, promoted, or installed. Existing terminals/containers and the user's packaged app are unchanged.

## Source repository

The user approved creating **`Merthadam/stingray` as a public GitHub repository**, initializing Git here, committing source and pushing `main`. This initial source snapshot targets `main` at https://github.com/Merthadam/stingray. Dependencies, generated builds/app bundles, local app data, secrets and `artifacts/` are excluded. No global Git configuration or application changes are part of publishing. GitHub publication does not resolve the reported clone failure below.

Publication preflight freshly passed **23/23 unit/integration tests**, TypeScript checking and staged whitespace checks. The source-only scan's credential-shaped matches were reviewed as deliberate dummy test fixtures; this is not an exhaustive security audit. Existing third-party notices are retained; no new project-wide license was selected.

## Implemented and locally delivered

- Projects home has one **Add project** action with **Local folder / Repository URL**. Local-folder registration and explicit HTTPS/SSH cloning to a new destination are implemented.
- Existing destinations are refused. Registration follows checkout and durable save. Progress is indeterminate, clone execution has a five-minute timeout, and failures preserve remaining files. No setup, dependency installs, hooks, recursive submodules or agents automatically run; trusted Git/SSH configuration remains relevant.
- In the maintainer's local checkout, the tested candidate was promoted to `release/Stingray.app` and reopened normally. The original is retained at `release/backups/2026-11-06-before-add-project/Stingray.app`; both candidates remain intact. Bundles are not distributed in this repository.
- Recorded implementation checks: **23/23 unit/integration tests**, TypeScript/build, source/candidate native checks and Chrome DevTools demo/visual checks. Fresh final-path promotion checks passed **22/22 clone-flow checks**, **31/31 desktop regressions**, isolated LaunchServices smoke, signature and bundle/source integrity comparisons.
- Full reports, screenshots and logs remain local under `artifacts/testing/2026-11-06-add-project/` and `artifacts/testing/2026-11-06-live-promotion/`. They are point-in-time evidence, not CI results or proof of a fresh clone's runtime state.

## Open issue: reported live clone failure

The user reported “Clone failed” in the delivered app. The screenshot showed a GitHub `/projects` page URL rather than a repository clone URL, and that attempt left an empty destination folder. Later read-only GitHub API and Git HTTPS reference checks succeeded for the canonical repository URL. The current failing inputs/download/checkout path have not been reproduced; do not claim the issue is resolved. Clone execution discards raw Git output and exposes only a generic failure, limiting diagnosis. No credential changes, retry clone or cleanup was performed during investigation.

## Remaining limits

Native clone tests use an isolated local SSH transport shim, not live encrypted SSH or HTTPS pack transfer. Native folder-chooser responses are stubbed. The GitHub access check proves metadata/reference access only, not successful clone/checkout. No notarization, Applications install, binary distribution, other-platform/real-agent testing, exhaustive accessibility/security audit, full process-tree supervision or transactional Git/JSON recovery. No cancellation/resume UI or job journal. Existing chunk-size/icon warnings and earlier packaging-development dependency audit findings remain.

No Travella/global changes, Pi/REA integration or prototype cleanup. Further feature changes, credential setup, real-provider clone tests and any future app replacement/rollback require scoped approval; confirm the app has quit before moving/replacing its bundle.
