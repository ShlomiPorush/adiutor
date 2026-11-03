#!/usr/bin/env bash
# The single verification entry point, used locally and in CI.
# Usage: scripts/verify.sh [--changed [BASE]] [--guards-only] [--skip-e2e]
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

PROJECT="mikud-verify"
CHANGED_BASE=""
CHECKS=1
E2E=1

usage() {
  cat <<'EOF'
Usage: scripts/verify.sh [options]

  (no options)      Full sweep: guards, lint, types, unit tests, build, integration tests against a
                    disposable PostgreSQL, then the image with health, user and hardening checks, then the
                    end-to-end tests of the web UI against that container.
  --changed [BASE]  Guards only when every change since BASE (default origin/main) is documentation;
                    otherwise the full sweep.
  --guards-only     Only the repository guards.
  --skip-e2e        Skip the end-to-end tests (Playwright against the container).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --changed)
      CHANGED_BASE="origin/main"
      if [ $# -gt 1 ] && [[ "$2" != --* ]]; then
        CHANGED_BASE="$2"
        shift
      fi
      ;;
    --guards-only) CHECKS=0 ;;
    --skip-e2e) E2E=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown option: $1"
      ;;
  esac
  shift
done

changed_files() {
  local base
  base="$(git -C "$REPO_ROOT" merge-base "$CHANGED_BASE" HEAD)" || die "cannot find a merge base with $CHANGED_BASE"
  {
    git -C "$REPO_ROOT" diff --name-only "$base"
    git -C "$REPO_ROOT" ls-files --others --exclude-standard
  } | sort -u
}

run_guards() {
  info "Guards"
  in_toolchain "bash scripts/lib/guards.sh" || die "guards failed"
}

run_checks() {
  info "Install"
  install_deps
  info "Lint and format"
  in_toolchain "pnpm lint"
  info "Types, unit tests and build"
  in_toolchain "pnpm typecheck && pnpm test && pnpm build"
  info "Web UI build: local assets only, no mock API"
  in_toolchain "bash scripts/lib/web-dist-check.sh" || die "the web UI build loads an external asset or holds the mock API"
  info "Database schema matches its migrations"
  # A schema change without its migration would otherwise only show when the next migration is generated.
  # shellcheck disable=SC2016 # expands inside the container
  in_toolchain 'out="$(pnpm exec drizzle-kit generate --config config/drizzle.config.ts --name schema-check 2>&1)";
    echo "$out" | tail -1; grep -q "No schema changes" <<<"$out"' ||
    die "src/server/db/schema.ts has changes without a migration; run: pnpm db:generate --name <change>"
}

# Fixed values only: neither a developer's .env.dev (real tokens), nor an interpolation file, nor the developer's
# MIKUD_PUBLIC_URL reaches the verification stack. Its password and keys are new on every run
# (stack.env in its temporary data directory). The tests' Origin is http://127.0.0.1:8090.
stack() {
  env -u COMPOSE_ENV_FILES MIKUD_IMAGE_TAG=verify MIKUD_PORT=0 MIKUD_LOCAL_ENV_FILE=/dev/null \
    MIKUD_PUBLIC_URL=http://127.0.0.1:8090 MIKUD_STACK_ENV_FILE="${MIKUD_DATA_DIR:-/nonexistent}/stack.env" \
    docker compose --env-file /dev/null -p "$PROJECT" --project-directory "$REPO_ROOT" \
    -f "$REPO_ROOT/docker/docker-compose-dev.example.yml" "$@"
}

# The verification database, with this run's generated password.
stack_db_url() {
  echo "postgres://mikud:$(stack_db_password "$MIKUD_DATA_DIR")@postgres:5432/mikud"
}

cleanup_stack() {
  stack down --remove-orphans >/dev/null 2>&1 || true
  if [ -n "${MIKUD_DATA_DIR:-}" ]; then
    remove_data_dir "$MIKUD_DATA_DIR"
  fi
}

fail_stack() {
  stack ps -a || true
  stack logs --tail 50 || true
  die "$1"
}

# Runs e2e/ in the Playwright image on the stack's network, with the stack's database for e2e/session.spec.ts. e2e/global-setup.ts forwards 127.0.0.1:8090,
# the stack's MIKUD_PUBLIC_URL, to the container, so the server's Origin check sees its own address.
run_e2e() {
  local pinned
  pinned="$(sed -nE 's|.*"@playwright/test": "([^"]+)".*|\1|p' "$REPO_ROOT/package.json")"
  [ "v$pinned-noble" = "${PLAYWRIGHT_IMAGE##*:}" ] ||
    die "@playwright/test $pinned does not match $PLAYWRIGHT_IMAGE; keep both on one version"
  docker run --rm --ipc=host --network "${PROJECT}_default" \
    --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" -e E2E_TARGET=mikud:8080 \
    -e E2E_DATABASE_URL="$(stack_db_url)" \
    -v "$REPO_ROOT:/repo" -w /repo "$PLAYWRIGHT_IMAGE" \
    npx --no-install playwright test --config config/playwright.config.ts
}

run_integration() {
  MIKUD_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mikud-verify.XXXXXX")"
  export MIKUD_DATA_DIR
  trap cleanup_stack EXIT
  ensure_stack_env "$MIKUD_DATA_DIR"

  info "Integration: disposable PostgreSQL ($PROJECT)"
  stack up -d --remove-orphans --wait --wait-timeout 120 postgres || fail_stack "PostgreSQL did not become healthy"
  TOOLCHAIN_EXTRA_ARGS=(--network "${PROJECT}_default"
    -e MIKUD_TEST_DATABASE_URL="$(stack_db_url)")
  in_toolchain "pnpm test:integration" || die "integration tests failed"
  TOOLCHAIN_EXTRA_ARGS=()

  info "Container: image, health, runtime user and hardening"
  build_image verify "verify-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
  stack up -d --wait --wait-timeout 120 mikud || fail_stack "the mikud container did not become healthy"
  TOOLCHAIN_EXTRA_ARGS=(--network "${PROJECT}_default")
  # shellcheck disable=SC2016 # expands inside the container
  in_toolchain 'body="$(node -e "fetch(\"http://mikud:8080/healthz\").then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) })")" &&
    echo "    /healthz: $body" && grep -q "\"database\":\"ok\"" <<<"$body"' ||
    fail_stack "/healthz does not report the database"
  TOOLCHAIN_EXTRA_ARGS=()
  check_non_root "$PROJECT" mikud postgres
  check_hardening "$PROJECT"
  stack exec -T mikud test -f dist/server/cli.js || fail_stack "the image has no recovery command (dist/server/cli.js)"
  echo "    recovery command present: dist/server/cli.js"

  if [ $E2E -eq 1 ]; then
    info "End-to-end: the web UI against the container (Playwright)"
    run_e2e || fail_stack "end-to-end tests failed"
    # The owner exists now: the bundled recovery command must reset it. Its output (a password) is not shown.
    info "Recovery command in the container"
    stack exec -T mikud node dist/server/cli.js reset-password | grep -q '^New password: .\{20,\}$' ||
      fail_stack "node dist/server/cli.js reset-password did not reset the owner"
    echo "    reset-password set a new password"
  fi

  info "Stopping $PROJECT"
  stack down --remove-orphans || die "the verification stack did not stop"
  [ -z "$(stack ps -q)" ] || die "the verification stack still runs after stopping it"
  remove_data_dir "$MIKUD_DATA_DIR"
  unset MIKUD_DATA_DIR
  trap - EXIT
}

main() {
  require_docker
  build_toolchain

  if [ -n "$CHANGED_BASE" ] && [ $CHECKS -eq 1 ]; then
    mapfile -t files < <(changed_files)
    if [ ${#files[@]} -eq 0 ]; then
      info "No changes since $CHANGED_BASE: guards only"
      CHECKS=0
    elif ! printf '%s\n' "${files[@]}" | grep -qvE '^(docs/|README\.md$|AGENTS\.md$|CHANGELOG\.md$|LICENSE$)'; then
      info "Documentation-only change: guards only"
      CHECKS=0
    fi
  fi

  run_guards
  if [ $CHECKS -eq 1 ]; then
    run_checks
    run_integration
  fi
  info "Verify passed"
}

main
