#!/usr/bin/env bash
# Tests for ensure_stack_env (scripts/lib/common.sh) without Docker: a new stack.env holds every key, generated and
# distinct, mode 600; an older one gains a key added later as one appended line and keeps every other line; a file
# that is not mode 600 or is a link is never written to. Values are never printed. Run with the guards
# (scripts/lib/guards.sh).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/adiutor-stack-env-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
PASSED=0

check() {
  local what="$1"
  shift
  if "$@"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "FAIL: $what"
  fi
}

# shellcheck source=scripts/lib/common.sh
source "$REPO/scripts/lib/common.sh"
set +e

KEY_NAMES=(ADIUTOR_AUTH_SECRETS ADIUTOR_SETTINGS_KEYS ADIUTOR_OAUTH_SECRETS)

# Succeeds when the file holds exactly one 1:<64 hex> line per key, each value different.
keys_generated() {
  local file="$1" name values=()
  for name in "${KEY_NAMES[@]}"; do
    [ "$(grep -cE "^$name=1:[0-9a-f]{64}$" "$file")" = 1 ] || return 1
    values+=("$(sed -n "s/^$name=//p" "$file")")
  done
  [ "$(printf '%s\n' "${values[@]}" | sort -u | wc -l)" = "${#KEY_NAMES[@]}" ]
}

# Runs ensure_stack_env in a subshell (it exits on a refusal), its output dropped: it never prints a value.
ensure() { (ensure_stack_env "$1") >/dev/null 2>&1; }

# --- a new stack ---

NEW="$WORK/new"
check "a new stack's env file is created" ensure "$NEW"
check "it holds every key family, generated and distinct" keys_generated "$NEW/stack.env"
check "it is mode 600" test "$(stat -c %a "$NEW/stack.env")" = 600
check "every name it needs is set" stack_env_valid "$NEW/stack.env"
copy="$(cat "$NEW/stack.env")"
ensure "$NEW"
check "a second run changes nothing" test "$(cat "$NEW/stack.env")" = "$copy"

# --- an older stack, written before ADIUTOR_OAUTH_SECRETS ---

# A copy of the new stack's file without the OAuth line, ending with or without a line break.
older() {
  local dir="$1" ending="$2"
  mkdir -p "$dir/postgres"
  : >"$dir/postgres/PG_VERSION"
  grep -v '^ADIUTOR_OAUTH_SECRETS=' "$NEW/stack.env" >"$dir/stack.env"
  [ "$ending" = newline ] || truncate -s -1 "$dir/stack.env"
  chmod 600 "$dir/stack.env"
}

# Succeeds when the file is the text $2 (read without its last line break) with one more line at the end.
one_line_appended() {
  local file="$1" before="$2"
  [ "$(head -n -1 "$file")" = "$before" ] && [ "$(wc -l <"$file")" = "$(($(grep -c '' <<<"$before") + 1))" ]
}

for ending in newline none; do
  OLD="$WORK/old-$ending"
  older "$OLD" "$ending"
  before="$(cat "$OLD/stack.env")"
  check "an older env file ($ending at the end) is accepted" ensure "$OLD"
  check "it gains ADIUTOR_OAUTH_SECRETS as its one new last line" one_line_appended "$OLD/stack.env" "$before"
  check "it then holds every key family, generated and distinct" keys_generated "$OLD/stack.env"
  check "it stays mode 600" test "$(stat -c %a "$OLD/stack.env")" = 600
  after="$(cat "$OLD/stack.env")"
  ensure "$OLD"
  check "a second run changes nothing" test "$(cat "$OLD/stack.env")" = "$after"
done

# --- files that are never written to ---

refused() { ! ensure "$1"; }

OPEN="$WORK/open"
older "$OPEN" newline
chmod 644 "$OPEN/stack.env"
before="$(cat "$OPEN/stack.env")"
check "an older env file that others can read is refused" refused "$OPEN"
check "and nothing is written to it" test "$(cat "$OPEN/stack.env")" = "$before"

LINKED="$WORK/linked"
older "$LINKED" newline
mv "$LINKED/stack.env" "$WORK/target.env"
ln -s "$WORK/target.env" "$LINKED/stack.env"
before="$(cat "$WORK/target.env")"
check "an env file that is a link is refused" refused "$LINKED"
check "and nothing is written through it" test "$(cat "$WORK/target.env")" = "$before"

echo "stack.env tests: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
