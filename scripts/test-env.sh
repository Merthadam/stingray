#!/usr/bin/env bash
# Disposable Stingray test environment in Docker (Colima). Replaces ad-hoc
# release/*-candidate copies: nothing is installed, promoted or kept on the host.
#
#   scripts/test-env.sh up [--ref REF] [--port N] [--repo PATH] [--with-my-data] [--detach]
#   scripts/test-env.sh down [NAME|--all]     stop/remove test containers
#   scripts/test-env.sh ls                    list running test envs
#   scripts/test-env.sh prune                 down --all + remove test images
#
# up: builds the current working tree (or REF, e.g. origin/main) into an image,
# runs Electron under Xvfb and exposes Chrome DevTools Protocol on
# 127.0.0.1:PORT (default: first free port from 9222). Without --detach the
# container is removed when you press Ctrl-C. --with-my-data seeds a snapshot of
# your Stingray projects and settings (read-only clones; no worktrees).
set -euo pipefail

LABEL=stingray.test-env
IMAGE=stingray-test-env
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)

die() { echo "test-env: $*" >&2; exit 1; }

ensure_docker() {
  command -v docker >/dev/null || die "docker CLI not found (brew install docker colima)"
  if ! docker info >/dev/null 2>&1; then
    command -v colima >/dev/null || die "docker daemon unreachable and colima not installed"
    echo "Starting colima..." >&2
    colima start >&2
  fi
}

free_port() {
  local p=$1
  while lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; do p=$((p + 1)); done
  echo "$p"
}

cmd_up() {
  local ref="" port="" repo="" detach=0 mydata=0
  while [ $# -gt 0 ]; do
    case $1 in
      --ref) ref=$2; shift 2 ;;
      --port) port=$2; shift 2 ;;
      --repo) repo=$(cd "$2" && pwd); shift 2 ;;
      --with-my-data) mydata=1; shift ;;
      --detach|-d) detach=1; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  ensure_docker

  local stage; stage=$(mktemp -d "${TMPDIR:-/tmp}/stingray-test-env.XXXXXX")
  local slug
  if [ -n "$ref" ]; then
    git -C "$ROOT" rev-parse --verify --quiet "$ref^{commit}" >/dev/null || die "unknown ref $ref"
    git -C "$ROOT" archive "$ref" | tar -x -C "$stage"
    slug=$(git -C "$ROOT" rev-parse --short "$ref")
  else
    # Working tree incl. uncommitted + untracked (non-ignored) files.
    (cd "$ROOT" && git ls-files -z -co --exclude-standard | while IFS= read -r -d '' f; do
      [ -e "$f" ] && printf '%s\0' "$f"; done | tar -c --null -T - -f -) | tar -x -C "$stage"
    slug="wt-$(git -C "$ROOT" rev-parse --short HEAD)"
  fi
  # Always use this checkout's Docker files so older refs can be tested too.
  rm -rf "$stage/.test-env"; cp -Rp "$ROOT/docker/test-env" "$stage/.test-env"
  chmod +x "$stage/.test-env/entrypoint.sh"

  echo "Building $IMAGE:$slug ..." >&2
  local ok=0; docker build -t "$IMAGE:$slug" -f "$stage/.test-env/Dockerfile" "$stage" >&2 || ok=$?
  rm -rf "$stage"; [ $ok -eq 0 ] || die "image build failed"

  port=${port:-$(free_port 9222)}
  local name="stingray-test-$slug-$(LC_ALL=C tr -dc a-z0-9 </dev/urandom | head -c 4)"
  # Stingray maps the container to this checkout's workspace and marks the DevTools port.
  local args=(--init --name "$name" --label "$LABEL=1" --label "stingray.workspace=$(cd "$ROOT" && pwd -P)"
    --label "stingray.cdp=9223" --shm-size=1g -p "127.0.0.1:$port:9223")
  [ -n "$repo" ] && args+=(-v "$repo:/seed/repo:ro" -e "SEED_NAME=$(basename "$repo")")

  local snap=""
  if [ $mydata -eq 1 ]; then
    # Snapshot only the app database (projects, settings, view state); the real data dir is never mounted.
    local data="${STINGRAY_DATA_DIR:-$HOME/Library/Application Support/Stingray}"
    [ -f "$data/stingray.db" ] || die "no Stingray database at $data"
    command -v sqlite3 >/dev/null || die "sqlite3 not found (needed for a consistent snapshot)"
    snap=$(mktemp -d "${TMPDIR:-/tmp}/stingray-test-data.XXXXXX")
    sqlite3 -readonly "$data/stingray.db" ".backup '$snap/stingray.db'" || { rm -rf "$snap"; die "could not snapshot $data/stingray.db"; }
    chmod -R a+rX "$snap"
    local i=0 path
    while IFS= read -r path; do
      # Repos are mounted read-only and cloned inside; unreadable/missing ones are dropped by the entrypoint.
      [ -d "$path" ] && args+=(-v "$path:/seed/repos/$i:ro")
      i=$((i + 1))
    done < <(sqlite3 -readonly "$snap/stingray.db" 'SELECT path FROM repos ORDER BY position')
  fi

  docker create "${args[@]}" "$IMAGE:$slug" >/dev/null
  if [ -n "$snap" ]; then
    local cp_ok=0; docker cp "$snap" "$name:/seed-data" >/dev/null || cp_ok=$?
    rm -rf "$snap"
    [ $cp_ok -eq 0 ] || { docker rm -f "$name" >/dev/null; die "could not copy the data snapshot"; }
  fi
  docker start "$name" >/dev/null
  if [ $detach -eq 0 ]; then trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT INT TERM; fi

  printf 'Waiting for DevTools endpoint' >&2
  for _ in $(seq 1 300); do
    curl -fs "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 && break
    [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ] || { echo; docker logs "$name" 2>&1 | tail -30; die "container exited"; }
    printf . >&2; sleep 1
  done
  echo >&2
  curl -fs "http://127.0.0.1:$port/json/version" >/dev/null || { docker logs "$name" 2>&1 | tail -30; die "DevTools endpoint not ready"; }

  cat <<EOF
Stingray test env ready: $name ($IMAGE:$slug)
  CDP endpoint : http://127.0.0.1:$port   (targets: /json)
  Chrome       : chrome://inspect -> Configure... -> add 127.0.0.1:$port -> inspect
  DevTools MCP : npx chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:$port
  Repos inside : /home/node/repos/* (sample${repo:+, $(basename "$repo") (clone)}$([ $mydata -eq 1 ] && echo ', your projects (clones)'))
  Stop         : scripts/test-env.sh down $name
EOF
  if [ $detach -eq 0 ]; then
    echo "Streaming logs; Ctrl-C stops and removes the container." >&2
    docker logs -f "$name" || true
  fi
}

cmd_down() {
  ensure_docker
  if [ "${1:-}" = "--all" ] || [ -z "${1:-}" ]; then
    local ids; ids=$(docker ps -aq --filter "label=$LABEL")
    local n=0; [ -n "$ids" ] && { docker rm -f $ids >/dev/null; n=$(echo "$ids" | wc -l | tr -d ' '); }
    echo "Removed $n test env(s)."
  else
    docker rm -f "$1" >/dev/null && echo "Removed $1."
  fi
}

cmd_ls() {
  ensure_docker
  docker ps -a --filter "label=$LABEL" --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
}

cmd_prune() {
  cmd_down --all
  local imgs; imgs=$(docker images -q "$IMAGE" | sort -u)
  [ -n "$imgs" ] && docker rmi -f $imgs >/dev/null
  echo "Removed test images."
}

case ${1:-} in
  up) shift; cmd_up "$@" ;;
  down) shift; cmd_down "$@" ;;
  ls) cmd_ls ;;
  prune) cmd_prune ;;
  *) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
