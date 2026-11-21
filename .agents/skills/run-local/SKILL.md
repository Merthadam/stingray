---
name: run-local
description: Run Stingray locally in a disposable Docker (Colima) test environment and inspect/drive it with Chrome DevTools (CDP). Use when you need to manually or automatically test UI changes, reproduce a bug, or verify a branch — instead of packaging release/*-candidate app copies.
---

# Run Stingray in a temporary test environment

Never package, copy or "promote" `Stingray.app` builds to test. Use the disposable container.

## Start

```bash
scripts/test-env.sh up --detach                 # current working tree (incl. uncommitted changes)
scripts/test-env.sh up --detach --ref origin/main   # a specific ref, e.g. to compare with main
scripts/test-env.sh up --detach --repo /path/to/repo  # also clone that repo into the env as a project
scripts/test-env.sh up --detach --with-my-data         # start from a snapshot of your own projects + settings
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

## Inspect / drive

- Human: Chrome → `chrome://inspect` → *Configure…* → add `127.0.0.1:<port>` → **inspect**
  (the DevTools window shows a live screencast you can click in).
- Agent: chrome-devtools MCP with `--browserUrl http://127.0.0.1:<port>`, or Playwright
  `chromium.connectOverCDP('http://127.0.0.1:<port>')` (run from a checkout that has `node_modules`).
  Pick the page whose URL starts with `file:///app/dist/index.html`.
- Logs: `docker logs -f <name>`; shell: `docker exec -it <name> zsh`.

Limits: Linux build (macOS-only behaviour, native dialogs and the real host `gh`/Docker are not covered).

## Stop (always clean up)

```bash
scripts/test-env.sh ls
scripts/test-env.sh down <name>    # or: down --all
scripts/test-env.sh prune          # also delete test images
```
