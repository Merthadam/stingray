#!/usr/bin/env bash
# Starts Stingray inside the container with a Chrome DevTools Protocol endpoint.
# Chromium only binds CDP to loopback, so socat exposes it on 0.0.0.0:9223.
set -euo pipefail

mkdir -p "$STINGRAY_DATA_DIR" "$HOME/repos"
[ -f "$HOME/.zshrc" ] || echo "PROMPT='%~ %# '" > "$HOME/.zshrc"

# Optional repo mounted read-only by test-env.sh --repo; work on a clone, never the original.
if [ -d /seed/repo ]; then
  git config --global --add safe.directory '*'
  git clone --quiet /seed/repo "$HOME/repos/$(basename "${SEED_NAME:-repo}")"
fi
# Always provide a small fixture repo to add as a project.
if [ ! -d "$HOME/repos/sample" ]; then
  git init --quiet -b main "$HOME/repos/sample"
  echo '# Sample project' > "$HOME/repos/sample/README.md"
  git -C "$HOME/repos/sample" add . >/dev/null
  git -C "$HOME/repos/sample" -c user.name=Test -c user.email=test@invalid commit --quiet -m init
fi

# Pre-register every repo as a project (native folder dialogs can't be driven over CDP). Written in the legacy
# workspaces.json format, which Stingray imports into stingray.db on first start.
if [ ! -f "$STINGRAY_DATA_DIR/stingray.db" ] && [ ! -f "$STINGRAY_DATA_DIR/workspaces.json" ]; then
  node -e '
    const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process"), { randomUUID } = require("crypto");
    const dir = path.join(process.env.HOME, "repos"), state = { version: 1, repos: [], workspaces: [] };
    for (const name of fs.readdirSync(dir)) {
      const root = path.join(dir, name), id = randomUUID();
      const branch = execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim() || "detached HEAD";
      state.repos.push({ id, name, path: root });
      state.workspaces.push({ id: randomUUID(), repoId: id, path: root, branch, name: branch, managed: false, previewUrl: "" });
    }
    fs.writeFileSync(path.join(process.env.STINGRAY_DATA_DIR, "workspaces.json"), JSON.stringify(state, null, 2));
  '
fi

socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222 &

# Start Xvfb directly (xvfb-run hangs when running as PID 1).
export DISPLAY=:99
Xvfb :99 -screen 0 1440x940x24 -nolisten tcp &
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done

exec node_modules/.bin/electron . \
    --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --remote-debugging-port=9222 --remote-allow-origins='*' "$@"
