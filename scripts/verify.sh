#!/usr/bin/env bash
# The single verification entry point, used locally and in CI.
# Usage: scripts/verify.sh [--changed [BASE]] [--guards-only] [--skip-e2e]
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

PROJECT="adiutor-verify"
# The stack's public URL and the address the end-to-end browser opens. A host name, not 127.0.0.1: browsers refuse an
# IP address as a passkey's domain. e2e/global-setup.ts forwards its port to the container.
PUBLIC_URL="http://localhost:8090"
CHANGED_BASE=""
CHECKS=1
E2E=1

usage() {
  cat <<'EOF'
Usage: scripts/verify.sh [options]

  (no options)      Full sweep: guards, lint, types, unit tests, the agent skill's contract tests (also on
                    Node 20), build, integration tests against a
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
  info "Agent skill: contract tests (node and sh versions)"
  in_toolchain "pnpm test:skill" || die "the agent skill's contract tests failed"
  info "Agent skill: the node version on Node 20 ($SKILL_NODE_IMAGE)"
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e ADIUTOR_IMPLS=node \
    -v "$REPO_ROOT:/repo" -w /repo "$SKILL_NODE_IMAGE" node --test skill/test/contract.test.mjs ||
    die "the agent skill's contract tests failed on Node 20"
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
# ADIUTOR_PUBLIC_URL reaches the verification stack. Its password and keys are new on every run
# (stack.env in its temporary data directory). The tests' Origin is PUBLIC_URL. Its PostgreSQL is
# production's major version (TEST_POSTGRES_IMAGE), not the development stack's.
stack() {
  local files=(-f "$REPO_ROOT/docker/docker-compose-dev.example.yml")
  # The server's command with the stand-in GitHub's origin (github_stand_in): an override in the run's data directory,
  # never in the tracked template, so no other stack can point the server elsewhere.
  if [ -n "${ADIUTOR_DATA_DIR:-}" ] && [ -f "$ADIUTOR_DATA_DIR/compose.github.yml" ]; then
    files+=(-f "$ADIUTOR_DATA_DIR/compose.github.yml")
  fi
  env -u COMPOSE_ENV_FILES ADIUTOR_IMAGE_TAG=verify ADIUTOR_PORT=0 ADIUTOR_LOCAL_ENV_FILE=/dev/null \
    ADIUTOR_POSTGRES_IMAGE="$TEST_POSTGRES_IMAGE" ADIUTOR_POSTGRES_DATA="$TEST_POSTGRES_DATA" \
    ADIUTOR_PUBLIC_URL="$PUBLIC_URL" ADIUTOR_STACK_ENV_FILE="${ADIUTOR_DATA_DIR:-/nonexistent}/stack.env" \
    docker compose --env-file /dev/null -p "$PROJECT" --project-directory "$REPO_ROOT" "${files[@]}" "$@"
}

# The stand-in GitHub API (e2e/github-stand-in.mjs) for the end-to-end run. The App's key pair is new on every run,
# made with node:crypto into the run's data directory (files 0600, owned by the user every container here runs as):
# the stand-in gets the public key only and the Playwright container the private key only, each mounted read-only.
# The stand-in runs on the stack's network as "github", from the pinned Node 20 image with the repository read-only,
# and is removed by its container id (in cleanup_stack, and before the stack stops).
GITHUB_CID=""
GITHUB_APP_ID=""
github_stand_in() {
  local dir="$ADIUTOR_DATA_DIR/github"
  mkdir -m 700 -p "$dir/public" "$dir/private"
  GITHUB_APP_ID="$((100000 + RANDOM * 20 + RANDOM % 20))"
  # shellcheck disable=SC2016 # JavaScript, not shell
  docker run --rm --user "$(id -u):$(id -g)" -v "$dir:/keys" "$SKILL_NODE_IMAGE" node -e '
    const { generateKeyPairSync } = require("node:crypto")
    const { writeFileSync } = require("node:fs")
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    })
    writeFileSync("/keys/public/app.pub", pair.publicKey, { mode: 0o600 })
    writeFileSync("/keys/private/app.pem", pair.privateKey, { mode: 0o600 })' ||
    die "could not make the stand-in GitHub App's key pair"
  printf 'services:\n  adiutor:\n    command: ["node", "dist/server/index.js", "--github-api-origin=http://github:8080"]\n' \
    >"$ADIUTOR_DATA_DIR/compose.github.yml"
  GITHUB_CID="$(docker run -d --rm --network "${PROJECT}_default" --network-alias github \
    --user "$(id -u):$(id -g)" -v "$REPO_ROOT:/repo:ro" -v "$dir/public:/keys:ro" -w /repo "$SKILL_NODE_IMAGE" \
    node e2e/github-stand-in.mjs --public-key=/keys/app.pub --app-id="$GITHUB_APP_ID" --port=8080)" ||
    die "the stand-in GitHub API did not start"
  local tries=0
  # shellcheck disable=SC2016 # JavaScript, not shell
  until docker exec "$GITHUB_CID" node -e \
    'fetch("http://127.0.0.1:8080/__health").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' \
    >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ $tries -lt 30 ] || die "the stand-in GitHub API did not answer"
    sleep 1
  done
  echo "    stand-in GitHub API: http://github:8080 (App $GITHUB_APP_ID)"
}

remove_github_stand_in() {
  if [ -n "$GITHUB_CID" ]; then
    docker rm -f "$GITHUB_CID" >/dev/null 2>&1 || true
    GITHUB_CID=""
  fi
}

# The verification database, with this run's generated password.
stack_db_url() {
  echo "postgres://adiutor:$(stack_db_password "$ADIUTOR_DATA_DIR")@postgres:5432/adiutor"
}

cleanup_stack() {
  remove_github_stand_in
  stack down --remove-orphans >/dev/null 2>&1 || true
  if [ -n "${ADIUTOR_DATA_DIR:-}" ]; then
    remove_data_dir "$ADIUTOR_DATA_DIR"
  fi
}

fail_stack() {
  stack ps -a || true
  stack logs --tail 50 || true
  die "$1"
}

# Runs e2e/ in the Playwright image on the stack's network, with the stack's database for e2e/session.spec.ts. e2e/global-setup.ts forwards
# PUBLIC_URL's port to the container, so the server's Origin check sees its own address.
run_e2e() {
  local pinned
  pinned="$(sed -nE 's|.*"@playwright/test": "([^"]+)".*|\1|p' "$REPO_ROOT/package.json")"
  [ "v$pinned-noble" = "${PLAYWRIGHT_IMAGE##*:}" ] ||
    die "@playwright/test $pinned does not match $PLAYWRIGHT_IMAGE; keep both on one version"
  docker run --rm --ipc=host --network "${PROJECT}_default" \
    --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" -e E2E_TARGET=adiutor:8080 -e E2E_BASE_URL="$PUBLIC_URL" \
    -e E2E_DATABASE_URL="$(stack_db_url)" \
    -e E2E_GITHUB_APP_ID="$GITHUB_APP_ID" -e E2E_GITHUB_KEY_FILE=/github-key/app.pem \
    -v "$ADIUTOR_DATA_DIR/github/private:/github-key:ro" \
    -v "$REPO_ROOT:/repo" -w /repo "$PLAYWRIGHT_IMAGE" \
    npx --no-install playwright test --config config/playwright.config.ts
}

# The integration tests and the end-to-end stack share this server: it must be production's major version.
check_postgres_major() {
  local version
  # shellcheck disable=SC2016 # expands inside the container
  version="$(stack exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "show server_version"')" ||
    fail_stack "cannot read the PostgreSQL version"
  echo "    PostgreSQL $version"
  [ "${version%%.*}" = "$TEST_POSTGRES_MAJOR" ] ||
    fail_stack "the verification database runs PostgreSQL $version, not $TEST_POSTGRES_MAJOR"
}

run_integration() {
  ADIUTOR_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/adiutor-verify.XXXXXX")"
  export ADIUTOR_DATA_DIR
  trap cleanup_stack EXIT
  ensure_stack_env "$ADIUTOR_DATA_DIR"

  info "Integration: disposable PostgreSQL ($PROJECT)"
  stack up -d --remove-orphans --wait --wait-timeout 120 postgres || fail_stack "PostgreSQL did not become healthy"
  check_postgres_major
  TOOLCHAIN_EXTRA_ARGS=(--network "${PROJECT}_default"
    -e ADIUTOR_TEST_DATABASE_URL="$(stack_db_url)")
  in_toolchain "pnpm test:integration" || die "integration tests failed"
  TOOLCHAIN_EXTRA_ARGS=()

  info "Container: image, health, runtime user and hardening"
  build_image verify "verify-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
  github_stand_in
  stack up -d --wait --wait-timeout 120 adiutor || fail_stack "the adiutor container did not become healthy"
  TOOLCHAIN_EXTRA_ARGS=(--network "${PROJECT}_default")
  # shellcheck disable=SC2016 # expands inside the container
  in_toolchain 'body="$(node -e "fetch(\"http://adiutor:8080/healthz\").then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) })")" &&
    echo "    /healthz: $body" && grep -q "\"database\":\"ok\"" <<<"$body"' ||
    fail_stack "/healthz does not report the database"
  TOOLCHAIN_EXTRA_ARGS=()
  check_non_root "$PROJECT" adiutor postgres
  check_hardening "$PROJECT"
  stack exec -T adiutor test -f dist/server/cli.js || fail_stack "the image has no recovery command (dist/server/cli.js)"
  echo "    recovery command present: dist/server/cli.js"

  if [ $E2E -eq 1 ]; then
    info "End-to-end: the web UI against the container (Playwright)"
    run_e2e || fail_stack "end-to-end tests failed"
    # The owner exists now: the bundled recovery command must reset it. Its output (a password) is not shown.
    info "Recovery command in the container"
    stack exec -T adiutor node dist/server/cli.js reset-password | grep -q '^New password: .\{20,\}$' ||
      fail_stack "node dist/server/cli.js reset-password did not reset the owner"
    echo "    reset-password set a new password"
  fi

  info "Stopping $PROJECT"
  remove_github_stand_in
  stack down --remove-orphans || die "the verification stack did not stop"
  [ -z "$(stack ps -q)" ] || die "the verification stack still runs after stopping it"
  remove_data_dir "$ADIUTOR_DATA_DIR"
  unset ADIUTOR_DATA_DIR
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
