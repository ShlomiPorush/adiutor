# Shared helpers for the workflow scripts. Source it; do not execute it.
# shellcheck shell=bash

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT

TOOLCHAIN_IMAGE="mikud-toolchain:local"
# Browsers for the end-to-end tests; the tag must match @playwright/test in package.json.
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.64.1-noble"
export PLAYWRIGHT_IMAGE
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/mikud"

die() {
  echo "error: $*" >&2
  exit 1
}

info() {
  echo "==> $*"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not available. Run this inside WSL with Docker running."
  docker info >/dev/null 2>&1 || die "docker is installed but not reachable. Start Docker and try again."
}

# Builds the toolchain image (cached by Docker when nothing changed).
build_toolchain() {
  require_docker
  docker build --quiet -f "$REPO_ROOT/docker/toolchain.Dockerfile" -t "$TOOLCHAIN_IMAGE" "$REPO_ROOT/docker" >/dev/null ||
    die "building the toolchain image failed"
}

# Runs a command inside the toolchain container with the repository mounted at /repo.
in_toolchain() {
  mkdir -p "$CACHE_DIR/pnpm-store"
  local tty=()
  [ -t 1 ] && tty=(-t)
  docker run --rm "${tty[@]}" \
    --user "$(id -u):$(id -g)" \
    -v "$REPO_ROOT:/repo" \
    -v "$CACHE_DIR/pnpm-store:/pnpm-store" \
    -e npm_config_store_dir=/pnpm-store \
    -e CI="${CI:-}" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "${TOOLCHAIN_EXTRA_ARGS[@]}" \
    "$TOOLCHAIN_IMAGE" bash -c "$*"
}
TOOLCHAIN_EXTRA_ARGS=()

# Installs dependencies from the lockfile.
install_deps() {
  in_toolchain "pnpm install --frozen-lockfile --reporter=append-only"
}

# Builds the Mikud image with the given tag.
build_image() {
  local tag="$1" version="${2:-$1}"
  require_docker
  info "Building mikud:$tag"
  docker build -f "$REPO_ROOT/docker/mikud.Dockerfile" --build-arg "VERSION=$version" -t "mikud:$tag" "$REPO_ROOT" ||
    die "building mikud:$tag failed"
}

# Fails when any process of a running Compose service runs as UID 0.
check_non_root() {
  local project="$1" service cid uids
  shift
  for service in "$@"; do
    cid="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")"
    [ -n "$cid" ] || die "service $service is not running"
    uids="$(docker top "$cid" -o pid,uid | awk 'NR > 1 { print $2 }' | sort -u | tr '\n' ' ')"
    [ -n "$uids" ] || die "service $service has no process"
    if grep -qw 0 <<<"$uids"; then
      die "service $service runs a process as root (UIDs: $uids)"
    fi
    echo "    $service runs as UID ${uids% }"
  done
}

# Fails unless the Mikud container holds no capability, cannot gain privileges and has a read-only root.
check_hardening() {
  local project="$1" cid
  cid="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=mikud")"
  [ -n "$cid" ] || die "service mikud is not running"
  [ "$(docker inspect -f '{{json .HostConfig.CapDrop}} {{json .HostConfig.CapAdd}}' "$cid")" = '["ALL"] null' ] ||
    die "mikud holds capabilities"
  [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid")" = true ] || die "mikud has a writable root file system"
  docker inspect -f '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' "$cid" | grep -qxE 'no-new-privileges(:true)?' ||
    die "mikud may gain new privileges"
  echo "    mikud holds no capabilities, read-only root, no new privileges"
}

# Refuses a data directory on the Windows file system: development and test data live on Linux.
require_linux_dir() {
  local resolved
  resolved="$(realpath -m "$1")"
  case "$resolved" in
    /mnt/*) die "$resolved is on the Windows file system; set MIKUD_DATA_DIR to a Linux path" ;;
  esac
}

# Removes a project-owned data directory. PostgreSQL's files belong to its own UID, so the contents
# are deleted from a throwaway container.
remove_data_dir() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  build_toolchain
  docker run --rm --user 0 -v "$dir:/target" "$TOOLCHAIN_IMAGE" bash -c 'shopt -s dotglob; rm -rf /target/*' ||
    die "could not empty $dir"
  rmdir "$dir"
}

# --- Development stack ---
DEV_PROJECT="mikud-dev"
DEV_COMPOSE_FILE="$REPO_ROOT/docker-compose-dev.yml"
DEV_DEFAULT_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/mikud-dev"

dev_compose() {
  [ -f "$DEV_COMPOSE_FILE" ] || die "docker-compose-dev.yml is missing. Create it with:
  cp docker/docker-compose-dev.example.yml docker-compose-dev.yml"
  MIKUD_DATA_DIR="${MIKUD_DATA_DIR:-$DEV_DEFAULT_DATA_DIR}" MIKUD_IMAGE_TAG=dev \
    docker compose -p "$DEV_PROJECT" --project-directory "$REPO_ROOT" -f "$DEV_COMPOSE_FILE" "$@"
}
