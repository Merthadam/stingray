# Stingray

Source repository: https://github.com/Merthadam/stingray. Dependencies, generated builds/app bundles, local app data, credentials and test artifacts are not committed. Build locally using the instructions below; local delivery paths and verification records describe the maintainer's development checkout, not files included in a fresh clone.

A macOS-first desktop workspace for coding-agent terminals, Git worktrees, and browser previews. Built with Electron, React, TypeScript, node-pty, and xterm. Uses Superset's warm dark palette and a similar workspace layout, with an independent Stingray identity. See [third-party notices](THIRD_PARTY_NOTICES.md).

Runtime screenshots and detailed test evidence are retained locally under `artifacts/testing/` and are intentionally excluded from this source repository.

**Latest source integration checkpoint:** Repo Map and guarded terminal links are integrated with Pi activity, sidebar Git/PR cards and workspace ports. The completed source run passed build, **106 unit, 66 Repo Map, 26 terminal-link, 22 Pi-native, 36 PR/sidebar, 28 ports, 31 desktop and 22 add-project checks**. See the [integration review](docs/repo-map-integration-review.md) for evidence, retained failures and limitations. This does not imply remote publication or an installed-app update; visual and live native-handler acceptance remain pending.

**Earlier Pi activity checkpoint:** Pi activity is implemented and source/candidate-verified for **Pi 1.5.0 typed in new zsh terminals**; Claude Code/Codex tracking is deferred. Whole-card selection and hiding empty/error-only port badges are included. The user requested source publication and replacement of the hosting app. Candidate verification is complete; actual installed-app promotion/reopen is recorded separately in `artifacts/testing/2026-11-07-pi-activity-delivery/verification.md` and `status.json`. Do not infer installation from this source commit. Activity evidence/limits: [capability report](docs/agent-activity-capability-gates.md); earlier card/port evidence: `artifacts/testing/clickable-workspace-cards/verification.md`. The running-terminal dot remains shell liveness, not agent state.

**Earlier delivery status:** Compact sidebar branch/PR cards, tracked-line counts and workspace ports are implemented and verified in a separate packaged candidate. Source publication and installed-app promotion are separate operations: the local delivery report at `artifacts/testing/2026-11-07-sidebar-delivery/continuation/verification.md` records the promotion outcome, backup path and final-installed-path results. The installed path is **`~/Projects/stingray/release/Stingray.app`**, outside this source checkout. Do not infer that a running app was updated merely because source was pushed.

The earlier **Add project** delivery and its preserved backup are historical: `artifacts/testing/2026-11-06-live-promotion/verification.md` in the original checkout records that promotion. Bundles and evidence are not published in this source repository.

## Pi activity (source and verified candidate)

Type `pi` in a **new zsh terminal** in the source build. Stingray adds a per-invocation extension through temporary app-owned startup/PATH files; it does not install Pi, launch an agent automatically, add launch buttons, or modify persistent shell/agent configuration. The bundled observer accepts exactly Pi **1.5.0**. Existing sessions are not retrofitted.

- **Working** means an observed active turn; **Waiting for you** means an active blocking extension-UI span, not every built-in picker or permission mechanism.
- **Needs review** means a successful settled completion not yet acknowledged. `agent_end`, failure, interruption and process exit are not successful completion.
- **Idle** requires initialized, connected tracking with no active work, blocking UI or unseen completion. Failed, Interrupted, Disconnected and Tracking unavailable remain distinct. An ordinary shell never implies agent Idle.
- A view/focus/user interaction can acknowledge the relevant visible terminal at its live buffer bottom, using an exact review revision. Merely receiving output or a completion snapshot does not clear review; hidden terminals, scrollback and other panes do not acknowledge it. Workspace aggregation prioritizes Waiting, Working, then Needs review; tooltips retain per-session connection/phase details.
- Aliases/functions, absolute executable paths, later PATH overrides, nested-shell startup choices, disabled extensions, maintenance/help and noninteractive invocations can bypass attachment. Other shells and Claude/Codex have no activity adapter. The footer distinguishes not attached from unavailable; see the [implementation plan](docs/agent-activity-plan.md) for boundaries.
- Activity transport is private/local and metadata-only: no prompts, model output, tool data or credentials are added to activity snapshots/logs. The terminal-bound transport capability stays out of renderer snapshots. This is not hostile same-user isolation. Activity is bounded (8 retained runs per terminal, 64 sockets, 64 retired runtimes per run) and does not survive app exit. Cancellable compaction/tree operations may remain unknown.

Saved source verification passed build, **64 unit tests, 22 Pi-native checks, 8 real-Pi no-provider checks, 36 PR/sidebar checks, 28 ports checks, 31 desktop checks and 22 add-project checks**. The real Pi smoke covers extension loading, blocking confirmation UI, reload/new/shutdown; turn/retry/failure/completion tests use **synthetic events**, not a real provider. Evidence: `artifacts/testing/agent-activity/pi-verification/run-TKtMfS/`. These source results alone do not establish promotion or broad real-agent compatibility. Subsequent candidate checks passed **22 Pi, 36 PR/sidebar, 28 ports, 31 desktop and 22 add-project checks**, bundled-resource LaunchServices smoke and deep/strict signature verification. Candidate: `release/pi-activity-candidate-2026-11-07/Stingray.app`. The delivery report distinguishes these results from final-installed-path checks.

## Compact branch / PR cards

Each workspace card in the **left sidebar** has its actual branch name at the **bottom**, a state-changing branch/PR symbol with a small PR number beneath it when applicable, the port badge, and **+/− line counts at the top-right of the card**. There is no separate PR pill, files-changed badge, or demo dropdown. **Open PRs are green, merged PRs purple, closed-unmerged PRs red, and drafts/no PR neutral**; distinct icons, accessible status names and tooltips supplement color. Loading, unsupported repositories and failed lookups remain separate states. Long branch names truncate with full-name tooltips. The whole card background selects the workspace through a stretched native branch-button hit area; PR/activity tooltip areas also select through card delegation. The branch button supports keyboard navigation. Clicking +/− selects that workspace and opens Repo Map. Refresh, removal and port controls keep their own actions without implicitly selecting the card (opening a port still selects its target workspace).

- **Line counts** are Git's net tracked-file diff against HEAD, combining staged and unstaged changes without double-counting. Untracked files and submodules are excluded; binary files contribute no lines and their count is disclosed in the tooltip. Pure renames add no lines. Unborn repositories (no HEAD commit), merge conflicts and failed/oversized/timed-out reads show unavailable counts—not zero. This is not a PR diff or evidence that local changes were merged. Reads use `git diff --numstat -z`, disable external diffs/textconv, and have a 10-second/2 MiB command-output bound. Repo Map includes untracked files and has separate per-file/folder counts, with explicit partial/unavailable states.
- **GitHub lookup:** read-only `gh pr list`, using your existing GitHub CLI login. Stingray never installs `gh`, signs in, changes credentials, fetches Git branches, creates PRs, or merges anything. Standard credential-free `github.com` **origin** URLs are supported (HTTPS or Git SSH). Other hosts, SSH aliases, missing origins and detached HEAD are explicit unsupported states.
- **Matching:** exact head repository and current branch, preferring an open PR; otherwise the most recently updated historical PR. A merged badge does not imply current local edits are merged. Fork-to-upstream PR discovery is not implemented. Lookups request at most 100 entries; reaching the limit fails visibly rather than guessing.
- **Refresh and privacy:** rows in the displayed project's filtered workspace list, once per minute for PRs and every 10 seconds for Git while the window is visible, plus focus/manual refresh. Background Git and PR reads share a three-request concurrency budget; queued work is skipped when its row is removed. Results cache for 60 seconds; manual retries have a five-second cooldown. GitHub gets repository/branch identifiers; the requested fields are PR number/state/draft, head identity and update time—not titles, bodies, file contents or reviews. No PR metadata is persisted to app data. Errors are sanitized; a failed read does not become “No PR.”
- **Preview:** the browser demo uses explicitly simulated PR states and line counts (main merged/#41, feature/browser open/#42). There is no state dropdown and it makes no GitHub calls.

Source implementation evidence and limitations: `artifacts/testing/sidebar-card-refinement/verification.md`. Fresh candidate and installed-path delivery results are recorded separately in `artifacts/testing/2026-11-07-sidebar-delivery/continuation/verification.md`; the earlier sidebar-placement report is historical.

## Compact workspace ports

Stingray uses **small sidebar port-count badges**, inspired by Superset's workspace rows, instead of a large container panel above the terminal. Git information sits alongside ports in each sidebar workspace card.

- **Ports:** hover/click the radio-tower badge for a small list with per-port open actions. Keyboard users can press Enter or Arrow Down to open details and Escape to dismiss. Opening a port from another workspace selects that workspace and reveals its preview.
- **Terminal discovery (macOS):** bounded `ps` PID/PPID metadata plus PID-selected `lsof` detects local TCP listeners belonging to live Stingray terminals and their descendants, including `npm run dev`. It does not read process environments or command lines, probe HTTP health, or discover unrelated external/reparented processes. No process-kill controls are added.
- **Docker:** the existing read-only local Unix-socket discovery contributes only ports associated with a workspace via Compose/bind paths. Unassociated containers, containers without published TCP ports, UDP, and LAN-only bindings are not badge entries. Remote contexts are refused. No containers are started or stopped.
- **Visibility and states:** a port badge appears only when at least one workspace port is discovered. Empty, initial-scanning, and failed-with-no-ports results show no badge; discovery continues automatically. Losing the last port closes its popover. Partial discovery errors with retry remain inside details when healthy ports exist. Opening, preview loading, a waiting message after eight seconds, and load failure with reload guidance remain explicit. A listener is not proof of HTTP readiness. Links default to HTTP; use the address bar for HTTPS or another address.
- **Refresh:** terminal ports every 2.5 seconds while the project UI is visible, Git and Docker every 10 seconds, plus focus/manual refresh. Hidden windows pause periodic reads. Scans are bounded/coalesced; Docker and terminal discovery fail independently. Git summaries also refresh for background workspace cards in the displayed list.

Fresh delivery verification: **51 unit tests**, TypeScript/production build, and packaged-candidate **31 PR/sidebar checks**, **27 workspace-status checks**, **31 desktop regressions**, **22 add-project checks**, signature and isolated LaunchServices smoke passed. Workspace-status checks use real PTY HTTP servers and macOS process scanning; GitHub and Docker use strict fixtures. No live GitHub/Docker or real-provider clone transfer was tested in this delivery. The known intermittent clone-timeout fixture failure remains unresolved, although this fresh run passed. Candidate evidence is under `artifacts/testing/2026-11-07-sidebar-delivery/continuation/`; the delivery report distinguishes candidate results from any final-installed-path results. Superset comparison remains selected shipped-code/static evidence, not a live equivalence claim.

For an interactive **simulated** browser preview, use `npm run dev:ui` on its configured port if free. Do not launch another desktop build against the same data directory while the packaged app is running.

## Open the desktop app

To open the **installed build**, double-click **`~/Projects/stingray/release/Stingray.app`** in Finder, or run:

```sh
open "$HOME/Projects/stingray/release/Stingray.app"
```

This local **Apple Silicon** build bundles Electron and the app runtime: you do not need npm, a separate Node.js installation, or a dev server to open it. Git and your shell/agent CLIs remain external tools; agents are not bundled. Bundle metadata requires macOS 13 or newer; only the current Mac was tested.

The app is **ad-hoc signed, not Apple-notarized**. Local LaunchServices launch passed; this is not a public distribution or Gatekeeper compatibility guarantee. No installation into `/Applications` was performed. Do not disable macOS security protections if a copied/downloaded build is blocked.

The Add project candidate, previous Design A navigation candidate and original-build backup are retained separately. Promotion to the standard path is complete. Do not replace or move a running app, or launch a different build against the same app data while it is running. Any future replacement or rollback still requires approval, confirmed app exit, preservation of the current bundle and final-path verification.

### Run from source

This checkout also has dependencies and a verified production build:

```sh
# From the root of your source checkout:
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
5. **Repo Map (source build)**: opens from the tab or sidebar line counts and replaces Changes with a nested treemap: folders enclose descendants, and file areas are weighted by total **text lines**, separately from Git changes. All files are shown by default; **Only changes** filters out clean entries. Yellow means modified, green added/untracked, red deleted, and purple a merge conflict; text badges accompany the colors. Click folders or aggregate tiles to focus them, use Back or Root to return, or search the full inventory to reveal a file. The map fits its pane without panning, zoom controls or canvas scrolling. Click a file to open the right-hand **Git diff / Whole file / Preview** inspector. Drag the divider (or focus it and use Left/Right arrows) to resize; expand the reader to fill the workspace content area, then restore the sidebar. **×** closes it. **Escape** first dismisses search (or active tile details when focus is in the map), then restores an expanded reader, then closes the sidebar, then navigates back in the map. Staged and unstaged diffs remain separate; deleted files remain inspectable. Tiles and the inspector show actual `+added / -removed` net counts. The map checks every five seconds while visible, with a manual refresh button. Unchanged background checks do not flash loading indicators or replace the displayed map/reader; geometry is reused for Git-only changes. Tile details appear immediately on hover or keyboard focus instead of waiting for a native tooltip. No staging, committing, pushing, merging, or source editing is performed.
6. **Remove worktree (source build)**: use the trash action on a managed sidebar card or in the workspace header. The dialog checks safety before confirmation: open terminals, modified/untracked/ignored files, detached or unexpectedly switched branches, and locked worktrees block removal. Local upstream ahead/behind counts are shown; unpushed or unknown push status requires acknowledgement. Tracking data may be stale: no automatic fetch or remote check. Type the exact branch name; safety is checked again before removal and changed results require fresh confirmation. Only Stingray-managed worktree directories are removed—**the branch and all its commits remain in Git**. No force deletion or automatic terminal shutdown. See [scope, tests and installed-app limitations](docs/worktree-removal-review.md).

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

### Repo Map: idle-refresh fix verification

Source-only verification passed build, **109/109 unit/integration, 74/74 Repo Map native, and 31/31 desktop checks**. In the 2,048-file fixture, three completed background polls over an 11-second observation produced zero visible map/reader mutations after initial sizing; hover details appeared in approximately 46 ms (local measurement, not a guarantee). Tests retain real-edit and same-line-edit review invalidation, bounded cache revalidation, status-only geometry reuse, mouse/keyboard details, delayed responses, errors and compact layouts. Initial sizing can still reflow as real weights arrive; polling/size measurement costs remain bounded rather than eliminated. No Git hooks or dependency changes were introduced in this source run. Evidence: `artifacts/testing/agent-activity/pi-verification/run-XMGKj7/`. Existing Vite >500 kB warning remains; user visual acceptance is still separate.

A subsequent separate packaged candidate passed **74 Repo Map, 26 terminal-link, 22 Pi-native, 36 PR/sidebar, 28 ports, 31 desktop and 22 clone checks**, isolated LaunchServices, deep/strict signature and bundled-resource equality checks. The attempted installed-app update timed out waiting for normal quit; **the idle-refresh candidate was not promoted or normally reopened**. Evidence is retained locally at `artifacts/testing/2026-11-08-repo-map-refresh-delivery/`. A subsequent user report of missing filename/line-count hover details remains unconfirmed in the affected running view; automated candidate coverage does not resolve that visual report.

### Repo Map: scope and limits

The nested map is implemented and tested in source and in the separate terminal-links candidate; **user visual acceptance remains pending**. The previously delivered production app described above has **not** been replaced. Build and run this checkout, or use the isolated candidate launcher described above.

- Tracked and non-ignored untracked files are included, including staged-deletion ghost entries. Submodules are inventory entries, not recursively mapped repositories. Ignored files are not exposed by the inspector.
- **Area is not a diff count.** Physical text lines include blanks/comments; a trailing newline adds no extra line. Existing files use working-tree content; missing files use HEAD for staged deletions or index content for unstaged deletions. Folder weights sum descendants. Empty and pending/unavailable files receive minimum layout weight 1, **not a fabricated one-line measurement**. No byte-size fallback is used. Pending and unavailable measurements are explicit; displayed totals exclude unknown sizes. All measured values are described as cached, not guaranteed current.
- Size measurement and untracked/unborn counting share a progressive budget: at most 64 file contents per snapshot, four concurrent working-file jobs, 512 KiB per file (at most 32 MiB payload plus bounded detection/framing overhead). Historical blobs share that budget. Focus/file hints receive up to half the jobs; a fair cursor advances through the rest. A two-second admission deadline stops new groups, not an already-running filesystem operation. Metadata revalidation is also limited to admitted jobs. The in-memory size cache holds at most 100,000 entries, not source contents. Per-batch stale flags remain service diagnostics, not flickering per-tile labels. Previously measured untracked/unborn counts stay visible between revalidation batches, with a cached-measurement notice; an admitted check replaces them when contents change or become unavailable. Inventory and Git-diff subprocess budgets are separate.
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
- No Stingray accounts, telemetry, cloud sync, or bundled agents are implemented. Optional PR status uses your existing `gh` login for read-only GitHub requests; it does not add a login flow or store credentials. Pi verification includes an isolated real-CLI no-provider smoke, not model/tool execution or general agent compatibility.

## Verification

For the Pi source checkpoint, the sequential isolated runner creates a fresh evidence directory on every invocation (requires already-installed project dependencies):

```sh
node tests/verify-activity.mjs
# Optional real-Pi smoke: use an existing absolute path, never an installation command.
PI_TEST_CLI="/absolute/path/to/pi/dist/cli.js" node tests/verify-activity.mjs
# Optional stage selection for a justified bounded rerun:
node tests/verify-activity.mjs unit pi-native
```

Without `PI_TEST_CLI`, the real-Pi smoke is explicitly skipped. The runner sanitizes HOME/config/environment and uses test-owned sessions, local Git fixtures and fake gh/docker; the real-Pi smoke additionally requires macOS `sandbox-exec` and denies network except the private activity socket. It never packages/promotes the installed app. See the [capability report](docs/agent-activity-capability-gates.md#verification-status) for the saved eight-stage results, initial npm-config failure, Vite warning and coverage limits. Completed suites were not rerun during the documentation-only review.

Individual/general regression commands (not the runner's sanitized environment):

```sh
npm run build
npm test
npm run test:desktop
npm run test:repo-map
npm run test:terminal-links
npm run test:workspace-status
npm run test:pull-requests
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

**Known limits:** no Apple notarization, installer, auto-updates, Intel/Windows/Linux testing, real-provider agent verification or broad agent compatibility coverage beyond the scoped Pi smoke, exhaustive accessibility/security audit, or exhaustive failure-injection recovery suite (clone timeout and registration-save failure have fixture coverage; clone-timeout intermittency is not proven fixed). The earlier packaging `npm audit` recorded **5 moderate findings** in packaging development dependencies (0 high/critical); the audit was not rerun for this task. Packaging tools are excluded from the runtime bundle. No forced dependency changes were made. The renderer bundle still produces Vite's >500 kB warning. The combined `npm run dev` launcher remains unverified; production `npm start` was tested for this Add project candidate (see the source-launch evidence in the report).

### Rebuild the local app

On Apple Silicon macOS with project dependencies installed:

```sh
npm run package:mac
```

The recipe builds and packages a self-contained `.app`, generates the existing Stingray icon, and applies/verifies a local ad-hoc signature. Optional `STINGRAY_ELECTRON_ZIP_DIR=/absolute/existing/archive-directory` uses an already-downloaded matching Electron ZIP and fails rather than downloading if it is missing. **It refuses to overwrite an existing target.** To retain the standard build, choose a fresh directory beneath `release`, for example `STINGRAY_PACKAGE_OUTPUT=release/new-candidate npm run package:mac`. Never move/replace a running build; confirm it has quit and preserve the original before an approved replacement. Rerun packaged checks for the chosen path afterward. There is no upload, notarization, or global installation step.

## Structure

- `electron/main.ts` / `preload.ts`: window lifecycle, restricted IPC, preview guest policy.
- `electron/git.ts`, `clone.ts`, `store.ts`, `terminals.ts`: Git registration/worktrees, bounded clone process, JSON state, PTY ownership.
- `src/App.tsx`, `ProjectHome.tsx`, `project-home.css`, `project-navigation.ts`: repository cards, scoped navigation, reload selection.
- `src/AddProjectForm.tsx`, `add-project.css`: local/URL dialog, validation and busy/error states.
- `src/TerminalPane.tsx`, `BrowserPane.tsx`: terminals and preview.
- `src/RepoMap.tsx`, `RepoMapCanvas.tsx`, `repo-map-model.ts`, `repo-map-layout.ts`, `repo-map.css`: weighted nested treemap, navigation, Git-status presentation and resizable/expandable inspector.
- `src/RepoMapCodeView.tsx`, `LineCounts.tsx`: virtualized bounded-content reader and explicit net-count/unknown presentation.
- `electron/repo-map.ts`, `repo-map-size.ts`: read-only inventory/inspection and progressive bounded text-line measurement; `tests/repo-map.test.ts` and `tests/repo-map.mjs`: service/model and native UI coverage.
- `src/WorkspaceStatus.tsx`, `usePullRequest.ts`, `workspace-git.css`, `electron/pull-requests.ts`: compact sidebar branch/PR symbols and bounded read-only GitHub PR lookup. `electron/git-lines.ts` reads bounded tracked-line statistics. `useSidebarGit.ts` and `workspace-read-queue.ts` bound background-row reads.
- `src/WorkspacePortsChip.tsx`, `useWorkspacePorts.ts`, `workspace-status.ts`, `workspace-ports.css`: discovered-port-only badges, popover, discovery and partial-error details.
- `electron/activity.ts`, `activity-shell.ts`, `agents/pi-extension.ts`, `agents/pi-observer.ts`: private metadata transport, temporary zsh attachment and version-gated Pi lifecycle observation.
- `src/activity.ts`, `useActivity.ts`, `WorkspaceActivity.tsx`, `workspace-activity.css`: activity aggregation, revisioned snapshots/acknowledgement and sidebar status; `TerminalPane.tsx` supplies terminal observation guards.
- `tests/verify-activity.mjs`, `pi-activity.mjs`, `pi-smoke.ts`: sequential isolated runner, native synthetic-lifecycle tests and opt-in real-Pi no-provider smoke.
- `electron/ports.ts`: bounded macOS terminal-descendant listener discovery; no process command lines or environments.
- `electron/containers.ts`: bounded, read-only local Docker discovery; no full inspect/environment payloads.
- `src/shared.ts`: shared types and schemas; `src/demo.ts`: explicitly simulated browser adapter.
- `tests/`: filesystem/Git regression tests and native/launch tests.
- `artifacts/testing/`: plan, screenshots, logs, and verification record.
