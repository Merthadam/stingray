#!/usr/bin/env bash
# Starts Stingray inside the container with a Chrome DevTools Protocol endpoint.
# Chromium only binds CDP to loopback, so socat exposes it on 0.0.0.0:9223.
set -euo pipefail

mkdir -p "$STINGRAY_DATA_DIR" "$HOME/repos"
[ -f "$HOME/.zshrc" ] || echo "PROMPT='%~ %# '" > "$HOME/.zshrc"

# Seed repos are mounted read-only from the host (different owner); work on clones, never the originals.
git config --global --add safe.directory '*'
# Optional repo mounted read-only by test-env.sh --repo.
if [ -d /seed/repo ]; then
  git clone --quiet /seed/repo "$HOME/repos/$(basename "${SEED_NAME:-repo}")"
fi
# Always provide a small fixture repo to add as a project.
if [ ! -d "$HOME/repos/sample" ]; then
  git init --quiet -b main "$HOME/repos/sample"
  echo '# Sample project' > "$HOME/repos/sample/README.md"
  git -C "$HOME/repos/sample" add . >/dev/null
  git -C "$HOME/repos/sample" -c user.name=Test -c user.email=test@invalid commit --quiet -m init
fi

# --with-my-data: a snapshot of the user's stingray.db (copied in, not mounted) plus each registered repo at
# /seed/repos/<position>. Repos become clones in ~/repos with their main checkout; worktrees and preview URLs are dropped.
# Remaining ~/repos dirs (sample, --repo) are appended as projects.
if [ -f /seed-data/stingray.db ] && [ ! -f "$STINGRAY_DATA_DIR/stingray.db" ]; then
  cp /seed-data/stingray.db "$STINGRAY_DATA_DIR/stingray.db"
  node -e '
    const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process"), { randomUUID } = require("crypto");
    const { DatabaseSync } = require("node:sqlite");
    const dir = path.join(process.env.HOME, "repos"), db = new DatabaseSync(path.join(process.env.STINGRAY_DATA_DIR, "stingray.db"));
    db.exec("PRAGMA foreign_keys = ON");
    const branchOf = root => execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim() || "detached HEAD";
    const seeded = new Set(fs.readdirSync(dir));
    db.prepare("SELECT id, name, path FROM repos ORDER BY position").all().forEach((repo, i) => {
      const source = "/seed/repos/" + i, base = repo.name.replace(/[^\w.-]/g, "-") || "repo";
      const root = path.join(dir, fs.existsSync(path.join(dir, base)) ? base + "-" + i : base);
      try { execFileSync("git", ["clone", "--quiet", source, root], { stdio: ["ignore", "ignore", "pipe"] }); }
      catch { console.error("test-env: skipped project " + repo.name + " (not mountable/cloneable)"); db.prepare("DELETE FROM repos WHERE id = ?").run(repo.id); return; }
      const branch = branchOf(root);
      db.prepare("DELETE FROM workspaces WHERE repo_id = ? AND (managed = 1 OR path != ?)").run(repo.id, repo.path);
      db.prepare("UPDATE repos SET path = ? WHERE id = ?").run(root, repo.id);
      const kept = db.prepare("UPDATE workspaces SET path = ?, branch = ?, name = ?, preview_url = \x27\x27 WHERE repo_id = ?").run(root, branch, branch, repo.id);
      if (!kept.changes) db.prepare("INSERT INTO workspaces (id, repo_id, name, branch, path, managed, preview_url, position) VALUES (?, ?, ?, ?, ?, 0, \x27\x27, 0)").run(randomUUID(), repo.id, branch, branch, root);
    });
    let position = db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM repos").get().p;
    for (const name of seeded) {
      const root = path.join(dir, name), id = randomUUID(), branch = branchOf(root);
      db.prepare("INSERT INTO repos (id, name, path, position) VALUES (?, ?, ?, ?)").run(id, name, root, ++position);
      db.prepare("INSERT INTO workspaces (id, repo_id, name, branch, path, managed, preview_url, position) VALUES (?, ?, ?, ?, ?, 0, \x27\x27, 0)").run(randomUUID(), id, branch, branch, root);
    }
    db.close();
  '
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
