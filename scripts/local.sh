#!/usr/bin/env bash
# Development stack: build the image, start, stop, inspect, and reset.
# Usage: scripts/local.sh <build|up|start|down|status|logs|nuke>
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

PROJECT="$DEV_PROJECT"
export MIKUD_DATA_DIR="${MIKUD_DATA_DIR:-$DEV_DEFAULT_DATA_DIR}"
SERVICES=(mikud postgres)

usage() {
  cat <<EOF
Usage: scripts/local.sh <command>

  build    Build the mikud:dev image.
  up       Build, then start the stack in the foreground.
  start    Build, then start the stack in the background and verify it.
  down     Stop the stack. The database in \$MIKUD_DATA_DIR is kept.
  status   Show containers, health and runtime users.
  logs     Follow the logs.
  nuke     Stop the stack and delete its data directory (asks first).

Data directory: $MIKUD_DATA_DIR
EOF
}

compose() {
  dev_compose "$@"
}

prepare_data_dir() {
  require_linux_dir "$MIKUD_DATA_DIR"
  mkdir -p "$MIKUD_DATA_DIR/postgres"
}

build() {
  build_image dev "dev-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
}

status() {
  compose ps
  check_non_root "$PROJECT" "${SERVICES[@]}"
  check_hardening "$PROJECT"
}

nuke() {
  local resolved answer
  resolved="$(realpath -m "$MIKUD_DATA_DIR")"
  case "$resolved" in
    "" | / | "$HOME" | "$REPO_ROOT") die "refusing to delete $resolved" ;;
  esac
  [[ "$(basename "$resolved")" == mikud-dev* ]] || die "refusing to delete $resolved: the name must start with mikud-dev"
  require_linux_dir "$resolved"
  read -r -p "Delete the development stack and ALL data in $resolved? Type 'nuke' to confirm: " answer || answer=""
  [ "$answer" = "nuke" ] || die "cancelled; nothing was deleted"
  compose down --remove-orphans
  remove_data_dir "$resolved"
  info "Deleted $resolved"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    build)
      build
      ;;
    up)
      prepare_data_dir
      build
      compose up --remove-orphans
      ;;
    start)
      prepare_data_dir
      build
      info "Starting $PROJECT"
      compose up -d --remove-orphans --wait --wait-timeout 120 || {
        compose ps
        die "the stack did not become healthy; see: scripts/local.sh logs"
      }
      status
      info "Ready: http://127.0.0.1:${MIKUD_PORT:-8090}"
      ;;
    down)
      compose down --remove-orphans
      ;;
    status)
      status
      ;;
    logs)
      compose logs -f
      ;;
    nuke)
      nuke
      ;;
    -h | --help | help | "")
      usage
      ;;
    *)
      usage
      die "unknown command: $cmd"
      ;;
  esac
}

require_docker
main "$@"
