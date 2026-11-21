---
name: run-local
description: Run, test and inspect Stingray locally — natively (`npm run dev`) or in a disposable Docker (Colima) environment driven via Chrome DevTools (CDP) — and run the same checks CI runs. Use when you need to manually or automatically test UI changes, reproduce a bug, run unit/e2e suites, or verify a branch — instead of packaging release/*-candidate app copies.
---

# Run and test Stingray locally

Never package, copy or "promote" `Stingray.app` builds to test. Use the native dev run or the disposable container.

## First time in a checkout

```bash
npm ci && npm run setup     # deps + Electron binary / PTY helper
```

## Run the app

- **Native (macOS, fastest loop):** `npm run dev` — builds Electron main, serves the renderer with Vite
  hot reload and opens the app. Uses your real app data unless you set `STINGRAY_DATA_DIR=/tmp/somewhere`
  (do that when testing, so your own projects/worktrees are untouched).
- **Disposable Docker env (isolated, inspectable by agents):**

```bash
npm run env:up                                       # = scripts/test-env.sh up --detach (working tree incl. uncommitted changes)
scripts/test-env.sh up --detach --ref origin/main    # a specific ref, e.g. to compare with main
scripts/test-env.sh up --detach --repo /path/to/repo # also clone that repo into the env as a project
scripts/test-env.sh up --detach --with-my-data       # start from a snapshot of your own projects + settings
```

`--with-my-data` (opt-in) snapshots `~/Library/Application Support/Stingray/stingray.db` (or `$STINGRAY_DATA_DIR`)
with `sqlite3 .backup`, copies it into the container (never mounted; the host copy is deleted after `docker cp`), and
mounts each registered repo read-only. Inside, every repo becomes a clone of its current branch at
`/home/node/repos/<name>`, keeping its main checkout workspace, view state and settings. Worktrees, preview URLs,
uncommitted changes and repos outside Colima's mounts (by default `$HOME`) are not copied.

Containers carry `stingray.test-env=1`, `stingray.workspace=<realpath of the checkout>` and `stingray.cdp=9223`
labels, so the host Stingray's ports chip shows the env under that worktree with **Inspect** (copies
`127.0.0.1:<port>` and opens `chrome://inspect`), **Logs** and **Stop**. Discovery checks the current Docker
context, `DOCKER_HOST` and every `~/.colima/<profile>/docker.sock`.

The script starts Colima if needed, builds the image (deps layer is cached), runs Electron under Xvfb
and prints the CDP endpoint (`http://127.0.0.1:9222`, or the next free port). A `sample` fixture repo
(plus any `--repo` clone; the original is mounted read-only) is pre-registered as a project.
App data, worktrees and terminals live only inside the container.

### Inspect / drive the Docker env

- Human: Chrome → `chrome://inspect` → *Configure…* → add `127.0.0.1:<port>` → **inspect**
  (the DevTools window shows a live screencast you can click in).
- Agent: chrome-devtools MCP with `--browserUrl http://127.0.0.1:<port>`, or Playwright
  `chromium.connectOverCDP('http://127.0.0.1:<port>')` (run from a checkout that has `node_modules`).
  Pick the page whose URL starts with `file:///app/dist/index.html`.
- Logs: `docker logs -f <name>`; shell: `docker exec -it <name> zsh`.

Limits: Linux build (macOS-only behaviour, native dialogs and the real host `gh`/Docker are not covered).

## Run the checks (same as CI, see docs/ci.md)

```bash
npm run check                          # typecheck + build + unit tests
npm run test:e2e                       # all Electron e2e suites on this Mac (needs a build; opens windows)
npm run test:e2e -- views-tab          # selected suites; `node scripts/run-e2e.mjs --list`
scripts/test-env.sh test               # unit + all e2e headless in Docker (what CI's Linux e2e job runs)
scripts/test-env.sh test e2e repo-map  # selected suites; evidence lands in artifacts/testing/test-env/
```

Known: on Linux `terminal-links` and `workspace-status` currently fail; don't treat those
as regressions from your change unless they also fail on macOS.

## Stop (always clean up)

```bash
npm run env:ls                     # = scripts/test-env.sh ls
scripts/test-env.sh down <name>    # or: npm run env:down (all)
scripts/test-env.sh prune          # also delete test images
```
