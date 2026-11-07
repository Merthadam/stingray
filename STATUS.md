# Stingray status

Updated 2026-11-07. Context, not authorization for further work.

## Pi activity delivery preparation

- User requested committing/pushing the reviewed source to `origin/main` and replacing/reopening the app hosting this session. Read-only process ancestry confirmed the target: `~/Projects/stingray/release/Stingray.app`, PID 85902 at preparation. Other running Stingray builds are excluded. Normal quit and its user-operated confirmation are required; ending target-app terminals, including this agent, was disclosed and accepted. No force quit or automatic rollback.
- Fresh source build, **64/64 unit, 22/22 Pi-native and 8/8 real-Pi no-provider** passed under `artifacts/testing/agent-activity/pi-verification/run-uo813O/`. Pi-native tests now accept an explicit packaged executable and record it. Packaging supports an explicit existing Electron archive directory; no dependency/agent installation or provider call is needed.
- Candidate `release/pi-activity-candidate-2026-11-07/Stingray.app` passed **22/22 Pi-native, 36/36 PR/sidebar, 28/28 ports, 31/31 desktop and 22/22 add-project**, isolated LaunchServices and deep/strict signature checks. Bundled renderer/main/extension resources match the source build. Initial packaging under an extra outer OS sandbox failed because Electron could not initialize its own sandbox; the retained retry used the existing archive and normal Electron sandboxing, not `--no-sandbox`.
- Delivery evidence: `artifacts/testing/2026-11-07-pi-activity-delivery/`. The one-shot updater preserves the original bundle, verifies the final path and reopens normally only after all gates pass. **Actual publication/promotion/reopen outcomes live in `verification.md`, `status.json` and `source-publication.json`; this preparation note does not assert they completed.**

## Earlier source-only checkpoint: Pi activity

- **Implemented and locally source-verified; not packaged, installed or promoted.** Pi 1.5.0 only, attached to typed `pi` commands in new zsh terminals through temporary app-owned startup/PATH files and a per-invocation extension. No launch buttons, automatic agent launches or global configuration changes. Claude Code/Codex tracking is deferred, not approximated.
- Sidebar Working / Waiting for you / Needs review / Idle are separate from shell liveness. Failure, interruption, disconnection and unavailable tracking remain explicit. Waiting covers blocking extension UI, not all built-in pickers. Successful `agent_settled` creates review; `agent_end`, error/abort and shutdown do not.
- Exact-revision acknowledgement uses the relevant visible, focused, rendered-bottom terminal, not activity/output arrival alone. Tests cover hidden/scrollback/split panes, background workspaces, late completions and renderer reload. Private metadata-only transport excludes prompt/output/tool payloads and renderer-visible capabilities; no hostile same-user isolation is claimed.
- Saved sequential verification: **build passed; 64/64 unit; 22/22 Pi-native; 8/8 real-Pi no-provider; 36/36 PR/sidebar; 28/28 ports; 31/31 desktop; 22/22 add-project**. All eight stages exited 0 without timeouts. Evidence: `artifacts/testing/agent-activity/pi-verification/run-TKtMfS/`. Real Pi smoke verifies extension loading, confirmation UI, reload/new/shutdown; turn/retry/final-outcome coverage is synthetic. PR/Docker are fixtures; clone transfer is local, not provider authentication.
- Retained first runner failure: `run-3ZYHEr/build.log` records npm rejecting duplicate `/dev/null` user/global config before build startup. Separate empty config files fixed the runner setup; the full rerun passed. Vite's >500 kB chunk warning remains. Historical clone-timeout intermittency passed this run but is not proven fixed; no dependency audit was rerun.
- Limits: exact Pi version; zsh/new terminals only; aliases/functions, explicit executable paths, PATH/nested-shell overrides, disabled extensions and maintenance/noninteractive modes may bypass. Cancellable compaction/tree may remain unknown. At most 8 retained runs per terminal, 64 sockets and 64 retired runtimes per run; activity is not persisted across app exit. No real-provider verification, general resume/fork coverage or exhaustive timing/security audit.
- Final continuation reviewed code, saved results and the compact fixture screenshot, then updated only `docs/agent-activity-plan.md`, `docs/agent-activity-capability-gates.md`, `README.md` and `STATUS.md`. No established production defect required a fix; no production code or tests changed, and completed suites were not rerun. Final whitespace/privacy checks cover tracked and untracked source. No installed-app/session intervention, provider call, installation, global configuration change, commit, push or publication.
- Details: [activity plan](docs/agent-activity-plan.md), [capability/evidence report](docs/agent-activity-capability-gates.md). Future production fixes, wider adapter support, provider verification or promotion need separately verified scope; this status file grants no authority.

## Earlier source-only refinement: clickable cards and port visibility

- Card background and PR-symbol clicks now select the workspace. Branch-button keyboard navigation and independent line-count, refresh and port actions are preserved; portal clicks do not bubble into selection.
- Port badges appear only for discovered workspace ports. No scanning/waiting/unavailable badge on empty discovery; polling continues. Last-port disappearance closes the popover. Healthy ports retain partial-error details and retry.
- Fresh checks: **51/51 unit**, TypeScript/build, **36/36 native PR/sidebar**, **28/28 native ports**, **31/31 desktop**. Initial new card test incorrectly read the branch text during Git loading; corrected it to assert the stable workspace identity, retaining failure evidence. No production fix was needed for that test failure.
- PR tests cover open, merged, draft, closed, absent, failure, background workspaces and branch changes using strict gh fixtures, not the user's live PR. Need the affected repository/branch for that diagnosis.
- Selected Superset source-map inspection with REA established an event-driven agent state design: Start→working, PermissionRequest→permission, Failed→failed, Stop→unseen review or seen idle. Static/partial coverage only. At this earlier checkpoint Stingray knew only terminal liveness; the Pi-only integration above now supersedes that limitation without copying those approximate hook semantics. The user's ambiguous “older” indication remains unresolved; no age UI was added.
- Source-only evidence: `artifacts/testing/clickable-workspace-cards/verification.md`; REA provenance: `artifacts/re-superset/activity-review/`. No running bundle replacement, restart, user terminal/container changes, live GitHub call, global configuration change, commit or push in this refinement.

## Earlier sidebar delivery verification

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

Native clone tests use an isolated local SSH transport shim, not live encrypted SSH or HTTPS pack transfer. Native folder-chooser responses are stubbed. The GitHub access check proves metadata/reference access only, not successful clone/checkout. No notarization, Applications install, binary distribution, other-platform testing, real-provider agent verification or broad agent compatibility coverage beyond the scoped Pi smoke, exhaustive accessibility/security audit, full process-tree supervision or transactional Git/JSON recovery. No cancellation/resume UI or job journal. Existing chunk-size/icon warnings and earlier packaging-development dependency audit findings remain.

No Travella/global changes, REA runtime integration or prototype cleanup. Pi-only implementation and candidate verification are described above; actual installed-app delivery requires the separate outcome report. Further feature changes, credential setup, real-provider agent/clone tests and any future app replacement/rollback require scoped approval; confirm the app has quit before moving/replacing its bundle.
