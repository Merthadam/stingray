# Stingray

A macOS-first desktop workspace for coding-agent terminals, Git worktrees and browser previews, built with Electron,
React, TypeScript, node-pty and xterm. Each project is a Git repository, each workspace a worktree with its own
terminals, Repo Map, Views and preview. Source: https://github.com/Merthadam/stingray (builds, app data and test
evidence under `artifacts/` are not committed). How to use it and its safety boundaries: [docs/usage.md](docs/usage.md).
Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Setup

Node 24 (`.nvmrc`), npm and Git.

```sh
npm ci
npm run setup
```

`setup` installs the project-local Electron runtime and fixes the macOS PTY helper's executable permission. It does not install agents or change global tools. Dependency installation/setup needs network access and can run package lifecycle scripts. Rebuild after source changes. If Electron starts as Node instead of opening a window, check that `ELECTRON_RUN_AS_NODE` is unset in the launching shell.

## Run

- `npm run dev`: builds the agent bundles, starts Vite on `127.0.0.1:5178`, then launches Electron with its own data dir `~/Library/Application Support/Stingray-dev` (Linux: `$XDG_CONFIG_HOME/Stingray-dev` or `~/.config/Stingray-dev`; override with `STINGRAY_DATA_DIR`). It never touches the installed app's data and can run next to it. Renderer changes hot-reload; main/preload/worker/CLI changes rebuild and restart Electron (dev terminals are closed by the restart); a build error is printed and the running app stays. `npm start` runs a full `npm run build` (incl. typecheck) and then launches.
- `npm run dev:ui`: starts **only a simulated browser demo**, at `http://127.0.0.1:5178/`. It cannot access real repositories or execute shell commands. Its preview uses a restricted iframe, not the native browser engine's workspace sessions.
- Port 5178 is strict: stop your own existing demo/dev server before starting another. Neither command automatically finds a different port.
- `npm start`: full `npm run build` (typecheck, Vite, esbuild) and then the app.
- `scripts/test-env.sh up --detach`: disposable Docker/Colima environment (Linux Electron under Xvfb) with a Chrome DevTools endpoint; `scripts/test-env.sh down --all` removes it. See `.agents/skills/run-local/SKILL.md`.
- The installed build: `open "$HOME/Projects/stingray/release/Stingray.app"` (see [docs/usage.md](docs/usage.md)).

## Test

```sh
npm run check                          # typecheck, build, unit tests (node:test)
npm run test:e2e                       # every Electron e2e suite (needs a build)
npm run test:e2e -- views-tab desktop  # selected suites
node scripts/run-e2e.mjs --list        # desktop, repo-map, terminal-links, workspace-status, pull-requests, worktree-removal, add-project, views-tab, pi-activity
scripts/test-env.sh test               # unit + e2e headless in Docker, like CI's Linux job
node tests/activity/verify-activity.mjs   # sanitized Pi activity runner (PI_TEST_CLI=/abs/path/to/pi/dist/cli.js for the real-Pi smoke)
node tests/app/launch.mjs              # npm start smoke
node tests/app/single-instance.mjs     # second instance on the same data dir exits 1
```

CI runs the same checks: [docs/ci.md](docs/ci.md). `pi-activity` is non-blocking in CI.

## Build / package

```sh
npm run package:mac
```

The recipe builds and packages a self-contained `.app`, generates the existing Stingray icon, and applies/verifies a local ad-hoc signature. Optional `STINGRAY_ELECTRON_ZIP_DIR=/absolute/existing/archive-directory` uses an already-downloaded matching Electron ZIP and fails rather than downloading if it is missing. **It refuses to overwrite an existing target.** To retain the standard build, choose a fresh directory beneath `release`, for example `STINGRAY_PACKAGE_OUTPUT=release/new-candidate npm run package:mac`. Never move/replace a running build; confirm it has quit and preserve the original before an approved replacement. Rerun packaged checks for the chosen path afterward. There is no upload, notarization, or global installation step.

## Folder map

```
electron/main.ts            thin entry → electron/app (composition root: window, IPC, wiring)
electron/core/<feature>/    pure logic + ports (app, git, activity, terminals, stinggraph, repo-map, views, db-schema, runtime; shared helpers)
electron/adapters/driving/  IPC handlers + preload, stingray-views CLI, agent hook socket
electron/adapters/driven/   git, fs, pty, docker, process, cdp, sqlite, stinggraph-worker, electron-shell, tree-sitter
shared/contracts/           zod IPC contracts (window.stingray and main handlers are built from them)
shared/views/               pure view code both processes run
src/app/ src/features/ src/shared/   renderer shell, per-feature UI (+ browser demo), generic UI
agents/                     Pi extension, hook client, skills
tests/<feature>/            unit and e2e tests; tests/architecture/ layer and cycle tests; tests/fakes/ fake adapters
```

## Links

[STATUS.md](STATUS.md) (delivery history) · [docs/usage.md](docs/usage.md) · [docs/ci.md](docs/ci.md) · [docs/specs/](docs/specs/) · [docs/plans/](docs/plans/) · [run-local skill](.agents/skills/run-local/SKILL.md)
