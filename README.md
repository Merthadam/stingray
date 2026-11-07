# Stingray

Source repository: https://github.com/Merthadam/stingray. Dependencies, generated builds/app bundles, local app data, credentials and test artifacts are not committed. Build locally using the instructions below; local delivery paths and verification records describe the maintainer's development checkout, not files included in a fresh clone.

A macOS-first desktop workspace for coding-agent terminals, Git worktrees, and browser previews. Built with Electron, React, TypeScript, node-pty, and xterm. Uses Superset's warm dark palette and a similar workspace layout, with an independent Stingray identity. See [third-party notices](THIRD_PARTY_NOTICES.md).

Runtime screenshots and detailed test evidence are retained locally under `artifacts/testing/` and are intentionally excluded from this source repository.

**Delivery status:** One **Add project** action with **Local folder / Repository URL** is now delivered at **`release/Stingray.app`** and was reopened normally after approved promotion. The original build is preserved at `release/backups/2026-11-06-before-add-project/Stingray.app`; both candidate bundles remain intact. See the live promotion report (local evidence: `artifacts/testing/2026-11-06-live-promotion/verification.md`) for fresh final-path checks and the Add project implementation report (local evidence: `artifacts/testing/2026-11-06-add-project/verification.md`) for prior implementation evidence.

## Open the desktop app

To open the **current Add project build**, double-click **`~/Projects/stingray/release/Stingray.app`** in Finder, or run:

```sh
open "$HOME/Projects/stingray/release/Stingray.app"
```

This local **Apple Silicon** build bundles Electron and the app runtime: you do not need npm, a separate Node.js installation, or a dev server to open it. Git and your shell/agent CLIs remain external tools; agents are not bundled. Bundle metadata requires macOS 13 or newer; only the current Mac was tested.

The app is **ad-hoc signed, not Apple-notarized**. Local LaunchServices launch passed; this is not a public distribution or Gatekeeper compatibility guarantee. No installation into `/Applications` was performed. Do not disable macOS security protections if a copied/downloaded build is blocked.

The Add project candidate, previous Design A navigation candidate and original-build backup are retained separately. Promotion to the standard path is complete. Do not replace or move a running app, or launch a different build against the same app data while it is running. Any future replacement or rollback still requires approval, confirmed app exit, preservation of the current bundle and final-path verification.

### Run from source

This checkout also has dependencies and a verified production build:

```sh
cd ~/Projects/stingray
npm start
```

For a fresh installation, use a compatible Node.js version (verified locally with Node 24.21.0), npm, and Git:

```sh
npm ci
npm run setup
npm run build
npm start
```

`setup` installs the project-local Electron runtime and fixes the macOS PTY helper's executable permission. It does not install agents or change global tools. Dependency installation/setup needs network access and can run package lifecycle scripts. Rebuild after source changes. If Electron starts as Node instead of opening a window, check that `ELECTRON_RUN_AS_NODE` is unset in the launching shell.

### Development and browser demo

- `npm run dev`: builds the Electron main/preload files, starts Vite on `127.0.0.1:5178`, then launches Electron. Renderer changes hot-reload; main/preload changes require restarting this command.
- `npm run dev:ui`: starts **only a simulated browser demo**, at `http://127.0.0.1:5178/`. It cannot access real repositories or execute shell commands. Its preview uses a restricted iframe, not the native browser engine's workspace sessions.
- Port 5178 is strict: stop your own existing demo/dev server before starting another. Neither command automatically finds a different port.

## Use

1. **Projects home**: each card is one registered Git repository, with counts of Stingray-managed worktrees and running terminals. Search by repository name or path. The single **Add project** button opens two choices: **Local folder** registers an existing trusted Git repository via an absolute path or folder picker; **Repository URL** clones an HTTPS/SSH Git address into a new absolute folder you choose. A parent-folder picker suggests a destination; only **Clone project** starts the operation. Existing destinations (even empty folders) are refused. Progress is indeterminate, with a five-minute clone timeout; registration happens only after success. Both flows return to Projects. Click its card to enter; registration alone does not open a workspace or launch a shell. Linked-worktree paths resolve to their primary checkout rather than creating a new project card; existing historical duplicates are not migrated.
2. **New worktree**: inside a project, choose a new branch name. Only that repository's workspaces are shown, and creation targets that repository. The branch starts at the registered repository's current HEAD, not necessarily the selected worktree's HEAD. The separate directory still lives in Stingray's app-data folder: “inside a project” means ownership/navigation, not physical nesting in the repository. **All projects** returns home without stopping existing terminals.
3. **Open terminal**: starts your login shell in that workspace. Run an already-installed agent CLI or dev server yourself. Nothing is bundled, installed, or launched automatically. Use terminal tabs or the split button for two visible terminals.
4. **Browser preview**: enter your development server's HTTP(S) address. Back, forward, reload, and close are available in the desktop app. Workspace switching recreates the preview document; it does not preserve its in-memory page state.
5. **Repo Map (source build)**: replaces Changes with a nested treemap: folders enclose descendants, and file areas are weighted by total **text lines**, separately from Git changes. All files are shown by default; **Only changes** filters out clean entries. Yellow means modified, green added/untracked, red deleted, and purple a merge conflict; text badges accompany the colors. Click folders or aggregate tiles to focus them, use Back or Root to return, or search the full inventory to reveal a file. The map fits its pane without panning, zoom controls or canvas scrolling. Click a file to open the right-hand **Git diff / Whole file / Preview** inspector. Drag the divider (or focus it and use Left/Right arrows) to resize; expand the reader to fill the workspace content area, then restore the sidebar. **×** closes it. **Escape** first dismisses search, then restores an expanded reader, then closes the sidebar, then navigates back in the map. Staged and unstaged diffs remain separate; deleted files remain inspectable. Tiles and the inspector show actual `+added / -removed` net counts. The map refreshes every five seconds while visible, with a manual refresh button. No staging, committing, pushing, merging, or source editing is performed.
6. **Remove worktree**: close all its terminals and type the exact branch name. Only Stingray-managed worktrees can be removed. Modified, untracked, or ignored files prevent removal. The branch and commits remain in Git.

Shortcuts: **Cmd/Ctrl K** focuses project search at home or workspace search inside a project. **Cmd/Ctrl T** opens a terminal and **Cmd/Ctrl B** toggles the preview only when a workspace is open; neither launches a shell from home. At compact desktop sizes, Projects scrolls vertically and the terminal/preview stack vertically; scroll the relevant pane to reach lower content.

### Terminal links (source and separate test candidate)

The source build supports **OSC 8 terminal hyperlinks**, including Pi's Markdown links. Click a link, check its actual destination in the confirmation dialog, then choose **Open file**, **Open in browser**, or **Show in file manager**. Cancel is the default. Ordinary text that was not emitted as a terminal hyperlink is not automatically detected. Pi may need `terminal.hyperlinks: true` and `/reload` to emit these links inside an embedded terminal.

- HTTP(S) opens through the system browser; credentials, other protocols, control characters and malformed URLs are rejected in the main process. Existing renderer/preview popup blocking is unchanged.
- Local `file://` and relative links must resolve inside the terminal's registered workspace, including ignored screenshot artifacts. Relative paths use the workspace root, not a later shell `cd`. Missing files and symlink escapes are rejected. Open a trusted workspace; this is not a filesystem sandbox.
- Non-executable PNG/JPEG/GIF/WebP/BMP images and TXT/Markdown/log/JSON/CSV documents use the OS default handler. Other types, executable files and folders are **revealed**, not launched. The dialog displays the resolved destination, not just the terminal's potentially misleading label. Local targets are revalidated after confirmation, but OS opening is not atomic with filesystem changes.
- Unmodified link clicks are handled by Stingray rather than also being forwarded to a fullscreen program such as Pi. Non-link mouse input is preserved. Option-drag on macOS or Shift-drag elsewhere bypasses link activation for terminal selection.

This fix is **not installed in the running production app**. A separate local test candidate, including this worktree's treemap, is available at `release/terminal-links-treemap-candidate-v2/`. Use **`Launch isolated candidate.command`**, not the `.app` directly: the launcher sets a dedicated adjacent `candidate-data/` directory. Keep that data; it can contain managed worktrees. Separate app data does not sandbox repositories or shell commands. The original app and earlier candidate are preserved; no production replacement/restart was performed.

The candidate also fixes same-cell hover re-entry with a guarded compatibility shim for pinned xterm 6.0.0. It invalidates private cell/line caches on screen leave so returning to the same cell resolves current links; changed/removed links cannot reuse the old destination. Keep those native regressions when upgrading xterm.

Latest verification: build, **64/64 unit/integration**, **26/26 terminal-link checks** (two final source runs and three candidate runs), **31/31 packaged desktop**, **66/66 packaged Repo Map**, **22/22 packaged clone**, isolated LaunchServices, signature/resource equality, launcher safety checks and production-bundle preservation. One initial Repo Map startup hung before feature checks; the unchanged suite passed on rerun, but that startup failure was not root-caused. The link suite uses real PTY output and CDP pointer clicks in a hidden test window; native confirmation and OS handlers are stubbed. **Live Pi/native-dialog/real-handler and treemap visual acceptance remain pending.** Local evidence: `artifacts/testing/terminal-links/reentry-fix/verification.md`; original source-pass evidence: `artifacts/testing/terminal-links/verification.md`.

### Repo Map: scope and limits

The nested map is implemented and tested in source and in the separate terminal-links candidate; **user visual acceptance remains pending**. The previously delivered production app described above has **not** been replaced. Build and run this checkout, or use the isolated candidate launcher described above.

- Tracked and non-ignored untracked files are included, including staged-deletion ghost entries. Submodules are inventory entries, not recursively mapped repositories. Ignored files are not exposed by the inspector.
- **Area is not a diff count.** Physical text lines include blanks/comments; a trailing newline adds no extra line. Existing files use working-tree content; missing files use HEAD for staged deletions or index content for unstaged deletions. Folder weights sum descendants. Empty and pending/unavailable files receive minimum layout weight 1, **not a fabricated one-line measurement**. No byte-size fallback is used. Pending, unavailable and stale measurements are explicit; displayed totals exclude unknown sizes.
- Size measurement and untracked/unborn counting share a progressive budget: at most 64 file contents per snapshot, four concurrent working-file jobs, 512 KiB per file (at most 32 MiB payload plus bounded detection/framing overhead). Historical blobs share that budget. Focus/file hints receive up to half the jobs; a fair cursor advances through the rest. A two-second admission deadline stops new groups, not an already-running filesystem operation. Metadata revalidation is also limited to admitted jobs. The in-memory size cache holds at most 100,000 entries, not source contents. Cached values awaiting revalidation are marked stale. Inventory and Git-diff subprocess budgets are separate.
- Deterministic weighted layout preserves sibling name order; Git-only changes with unchanged sizes/hierarchy do not move rectangles. Size progress, inventory, filtering and viewport changes can reflow the map. Folder headers/gutters mean visible pixel ratios are not exact line-count ratios. At most 2,000 map nodes are rendered, including folders and aggregates; explicit aggregate tiles represent branches/tails that cannot fit. Tiny files can become unlabeled slivers. Search covers the full inventory, shows up to 60 matches, and focuses the chosen file; refine the query if needed. A clean result hidden by Only changes explicitly offers to show all. Arrow-key map navigation and search avoid relying solely on tiny pointer targets. Selecting a file adds no persistent selection outline; keyboard focus remains visible.
- The inspector starts closed and defaults to approximately 40% width. Its divider clamps to retain map and reader space; width preference lasts only for the mounted workspace. Expand/restore retains file, reading mode, map focus and reader scroll; at very small content widths (below 400px), the reader uses full content width rather than stacking below the map. The 760×540 fixture remains side-by-side. Loaded file/diff text uses virtual rows (up to 200 per code view), making lines beyond the former 4,000-line display cutoff reachable by scrolling or Cmd/Ctrl+End. Only content/search panes scroll, not the map canvas.
- **Mark reviewed** is a temporary acknowledgement of the currently inspected version, not a test result. It resets when the content/diff changes, when switching files, or when leaving the map. It is not persisted.
- **Preview** currently explains the missing component integration and offers the existing workspace browser. It does not render isolated components, discover stories, install dependencies, or start a dev server.
- **Agent tracker** currently shows an explicit unconnected state and a separately labeled list of workspace terminals. There are no structured agent adapters, agent identities, parent/subagent relationships, task statuses, or agent-to-file markers yet. Terminal liveness is not treated as agent activity.
- Git `+ / −` counts compare HEAD with the working tree, including untracked additions; they do **not** sum staged and unstaged diffs. A staged edit reversed in the working tree can correctly show `+0 / -0`. Renames, deletions and unborn/orphan branches are handled. Binary files, unresolved conflicts and unavailable counts show `? lines`; partial folder/group totals are marked `*` with a tooltip and repository notice. Counts and sizes in the browser demo are explicitly simulated.
- Limits remain 100,000 inventory files, with a 16 MiB / 15-second inventory and numstat command budget (status has its own bound), and 512 KiB per inspected file or Git diff subprocess output. Repositories beyond the inventory budget report an error rather than silently truncating. Binary/non-UTF-8 files, symlinks, directories/submodules, oversized files, and unavailable Git data have explicit notices. Inspection validates workspace membership and repository-relative paths. External diff and textconv commands are disabled; normal trusted-repository Git/filter caveats still apply.
- Snapshot failures retain the last successful map with an error. A failed optional priority hint gets one retry without hints, allowing refresh to recover when a selected untracked file/folder disappears. Delayed file/snapshot responses are guarded across selection/workspace changes. This is polling, not a transactional snapshot: files can change while Git status, diffs, and contents are read. Verify again after agents stop writing. No real-agent tracking or isolated-component preview has been verified.

### Repository URL access and recovery

Use `https://host/owner/project.git`, `ssh://git@host/owner/project.git`, or `git@host:owner/project.git`. Passwords/HTTPS usernames, query strings, fragments, percent escapes, unsafe protocols and shell syntax are rejected. Use the final canonical repository URL: HTTP redirects are disabled. Do not put secrets anywhere in a URL, including its path.

Private repositories use existing trusted Git credential helpers or SSH access; Stingray does not provide a login flow. Default SSH is non-interactive with strict host-key checking; configure known hosts/agent access outside the app first. A preconfigured `GIT_SSH_COMMAND` is honored. No dependencies, setup, hooks, templates, recursive submodules or agents are automatically run. Trusted local credential helpers, SSH configuration and checkout filters can still execute local configuration.

Keep the window open during cloning. Cancel/Escape/window-close are blocked while it runs; there is no user cancellation/resume UI. Failures display sanitized guidance rather than raw Git stderr. Remaining destination files are not deleted by Stingray. Inspect them before retrying into a **new** folder; if cloning completed but saving failed, use **Local folder** to register that checkout. A forced app exit or renderer reload during cloning is not resumable UI: revisit/reload after completion and reconcile the destination if needed. Git/JSON are not one transaction.

## State and safety boundaries

- Repositories, worktree registrations, and preview addresses are stored in `workspaces.json` inside Electron's per-user `userData` directory. `STINGRAY_DATA_DIR=/absolute/path` selects a separate data directory for testing. Managed worktrees live below that directory; **do not delete it as a casual reset**, because it can contain project files.
- Workspace JSON uses schema validation and a temporary-file rename. Corrupt files fail closed rather than being silently replaced. It is not a transactional database covering both Git and JSON; interrupted/failed operations may need manual reconciliation with `git worktree list`. Preserve files and branches before recovery.
- Terminal sessions and bounded output replay survive returning to Projects, project/workspace switching, and renderer reload, **not application exit**. Up to 24 terminals, 100 repositories, and 200 workspaces are allowed.
- Full application launch starts at Projects with no automatically launched terminals. Renderer reload restores the selected project/worktree using IDs in `sessionStorage`; no repository paths are stored there. A removed worktree falls back only within its own repository. Missing repositories return home. Loading failures show a retry state, not a fabricated empty library.
- Closing a terminal requests a PTY hangup and removes it from Stingray's registry. **Detached processes or processes ignoring hangup may survive.** This is not a process-tree supervisor; independently stop/check such jobs before removing worktrees or quitting.
- Shell startup files and repository-configured Git filters can execute local code. Only open trusted repositories. Stingray's Git service disables Git hooks, but commands you type in its terminals use your normal tools and configuration.
- Native preview guests have no Node integration or Stingray bridge, use sandbox/context isolation, and deny popups, permissions, and downloads. Each workspace has a separate persistent browser session. This is not a VM, network firewall, or isolation boundary for terminal commands. Preview pages and terminal commands can make network requests.
- Preview URLs accept HTTP(S), reject embedded username/password credentials, and are saved locally. Do not paste secret-bearing query strings; arbitrary URL query values are not automatically redacted. Preview cookies/cache can persist in the app-data directory.
- No accounts, telemetry, cloud sync, or bundled agents are implemented. No real agent run was part of verification.

## Verification

```sh
npm run build
npm test
npm run test:desktop
npm run test:repo-map
npm run test:terminal-links
npm run test:add-project
STINGRAY_TEST_EVIDENCE="$PWD/artifacts/testing/<run>/source-launch" node tests/launch.mjs
```

Native tests use temporary app data, repositories, fixture-only Git commits, PTYs, and a loopback preview server, then clean up their own fixtures. They do not operate on your repositories. The launch smoke test opens `npm start` with an ephemeral local debugging endpoint for inspection, then closes it.

For Repo Map, set `STINGRAY_TEST_EVIDENCE` to a **new** directory per run to preserve prior results. Its isolated Electron window ignores OS mouse input while accepting Playwright/CDP input; this does not change an existing app or preview.

Nested-treemap verification (2026-11-07): recorded TypeScript/Vite/Electron build, **56/56 unit/integration tests** and **31/31 desktop checks** passed in the implementation continuation. This verification/documentation pass reran the native map suite: **66/66 checks passed twice** after a test-only delayed-refresh synchronization correction; the earlier failed run is retained. Native tests cover a 2,048-file scope (1,024 rendered nodes), loaded file/diff lines beyond 4,000, delayed responses, recovery and compact/wide inspector layouts. Final-run initial map time was approximately 332ms and final-file search 48ms; these are local fixture observations, not performance guarantees. **100,000-file coverage is model-only**, not native UI validation. The existing >500 kB renderer warning remains. Local report: `artifacts/testing/repo-map-treemap/continuation/verification.md`; latest screenshots/results: `continuation/review-final/` under that treemap evidence directory. Original visual-reference comparison and user visual acceptance remain open; screenshots are evidence, not delivery approval.

Delivered packaged-app verification (use a new evidence directory for each rerun):

```sh
STINGRAY_TEST_APP="$PWD/release/Stingray.app/Contents/MacOS/Stingray" \
  STINGRAY_TEST_EVIDENCE="$PWD/artifacts/testing/<run>/regression" npm run test:desktop
STINGRAY_TEST_APP="$PWD/release/Stingray.app/Contents/MacOS/Stingray" \
  STINGRAY_TEST_EVIDENCE="$PWD/artifacts/testing/<run>/clone" npm run test:add-project
STINGRAY_TEST_BUNDLE="$PWD/release/Stingray.app" \
  STINGRAY_TEST_EVIDENCE="$PWD/artifacts/testing/<run>/launch" node tests/package-launch.mjs
codesign --verify --deep --strict release/Stingray.app
```

Fresh final-path promotion checks: **22/22 clone-flow checks**, **31/31 desktop regressions**, isolated LaunchServices smoke and deep/strict signature passed at `release/Stingray.app`. Hash/symlink/mode comparisons confirmed the promoted bundle matches the candidate and the backup matches the original. A subsequent normal launch was confirmed without test/debug flags. No application-source changes or rebuild were needed. See the promotion report (local evidence: `artifacts/testing/2026-11-06-live-promotion/verification.md`).

Latest Add project verification: **23/23 unit/integration tests**, **22/22 clone-flow native checks** and **31/31 desktop regressions** on both source build and packaged candidate, TypeScript/build, source launch and packaged LaunchServices, signature and build-output equality checks passed. Chrome DevTools exercised demo validation, honest desktop-required errors, mode switching, cancel, single-entry/empty states and wide/compact layouts; no console warnings/errors or failed requests in the inspected runs. Real clone tests use an isolated transport shim invoking local Git upload-pack; they verify actual pack transfer/checkout/persistence, **not live HTTPS/SSH authentication or provider access**. Native folder chooser responses are stubbed in automation. See report and screenshots (local evidence: `artifacts/testing/2026-11-06-add-project/verification.md`).

Historical navigation review: **15/15 unit/integration tests**, TypeScript checking, candidate signature verification, packaged/local build-output comparison, icon inspection, and a supplemental Chrome DevTools simulated-browser check passed freshly. The prior implementation session recorded **31/31 development and 31/31 candidate packaged native checks**, plus an isolated LaunchServices smoke test with restricted PATH and bundled-only resources. Those native suites were reviewed, not rerun during the documentation pass. They cover real PTYs, two-repository worktree isolation, navigation/reload/restart behavior, and preview interaction/persistence. An initial compact-layout failure and its successful rerun remain preserved. See the navigation verification report (local evidence: `artifacts/testing/2026-11-06-project-navigation/verification.md`).

The earlier standard-bundle packaging report (local evidence: `artifacts/testing/2026-11-06-stingray-app/verification.md`) records 9/9 unit tests and 20/20 native checks for the older build now retained in the backup; current standard-path delivery is established by the promotion report above.

Earlier development-build/browser results are preserved separately in the development verification report (local evidence: `artifacts/testing/2026-11-06-stingray/verification.md`); they are not substituted for packaged-app tests.

**Known limits:** no Apple notarization, installer, auto-updates, Intel/Windows/Linux testing, real-agent compatibility run, exhaustive accessibility/security audit, or exhaustive failure-injection recovery suite (clone timeout and registration-save failure are now covered). The earlier packaging `npm audit` recorded **5 moderate findings** in packaging development dependencies (0 high/critical); the audit was not rerun for this task. Packaging tools are excluded from the runtime bundle. No forced dependency changes were made. The renderer bundle still produces Vite's >500 kB warning. The combined `npm run dev` launcher remains unverified; production `npm start` was tested for this Add project candidate (see the source-launch evidence in the report).

### Rebuild the local app

On Apple Silicon macOS with project dependencies installed:

```sh
npm run package:mac
```

The recipe builds and packages a self-contained `.app`, generates the existing Stingray icon, and applies/verifies a local ad-hoc signature. **It refuses to overwrite an existing target.** To retain the standard build, choose a fresh directory beneath `release`, for example `STINGRAY_PACKAGE_OUTPUT=release/new-candidate npm run package:mac`. Never move/replace a running build; confirm it has quit and preserve the original before an approved replacement. Rerun packaged checks for the chosen path afterward. There is no upload, notarization, or global installation step.

## Structure

- `electron/main.ts` / `preload.ts`: window lifecycle, restricted IPC, preview guest policy.
- `electron/git.ts`, `clone.ts`, `store.ts`, `terminals.ts`: Git registration/worktrees, bounded clone process, JSON state, PTY ownership.
- `src/App.tsx`, `ProjectHome.tsx`, `project-home.css`, `project-navigation.ts`: repository cards, scoped navigation, reload selection.
- `src/AddProjectForm.tsx`, `add-project.css`: local/URL dialog, validation and busy/error states.
- `src/TerminalPane.tsx`, `BrowserPane.tsx`: terminals and preview.
- `src/RepoMap.tsx`, `RepoMapCanvas.tsx`, `repo-map-model.ts`, `repo-map-layout.ts`, `repo-map.css`: weighted nested treemap, navigation, Git-status presentation and resizable/expandable inspector.
- `src/RepoMapCodeView.tsx`, `LineCounts.tsx`: virtualized bounded-content reader and explicit net-count/unknown presentation.
- `electron/repo-map.ts`, `repo-map-size.ts`: read-only inventory/inspection and progressive bounded text-line measurement; `tests/repo-map.test.ts` and `tests/repo-map.mjs`: service/model and native UI coverage.
- `src/shared.ts`: shared types and schemas; `src/demo.ts`: explicitly simulated browser adapter.
- `tests/`: filesystem/Git regression tests and native/launch tests.
- `artifacts/testing/`: plan, screenshots, logs, and verification record.
