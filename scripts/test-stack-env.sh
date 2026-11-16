#!/usr/bin/env bash
# Tests for ensure_stack_env and add_missing_stack_key (scripts/lib/common.sh) without Docker: a new stack.env holds
# every key, generated and distinct, mode 600; an older one, also one that still holds the ADIUTOR_OAUTH_SECRETS of
# 0.2.0, is kept as it is; a key missing from a file gains one appended line and every other line stays, also when
# several runs start at once; a failing generator writes nothing; an empty or short key is not valid; a file that is
# not mode 600 or is a link is never written to. Values are never printed. Run with the guards
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

KEY_NAMES=(ADIUTOR_AUTH_SECRETS ADIUTOR_SETTINGS_KEYS)

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
check "it holds no ADIUTOR_OAUTH_SECRETS" test "$(grep -c '^ADIUTOR_OAUTH_SECRETS=' "$NEW/stack.env")" = 0
copy="$(cat "$NEW/stack.env")"
ensure "$NEW"
check "a second run changes nothing" test "$(cat "$NEW/stack.env")" = "$copy"

# --- an older stack ---

# A copy of the new stack's file for a database that exists, ending with or without a line break; with "leftover",
# it also holds the ADIUTOR_OAUTH_SECRETS line 0.2.0 wrote, which the server no longer reads.
older() {
  local dir="$1" ending="$2" leftover="${3:-}"
  mkdir -p "$dir/postgres"
  : >"$dir/postgres/PG_VERSION"
  cp "$NEW/stack.env" "$dir/stack.env"
  [ -z "$leftover" ] || echo "ADIUTOR_OAUTH_SECRETS=1:$(new_hex)" >>"$dir/stack.env"
  [ "$ending" = newline ] || truncate -s -1 "$dir/stack.env"
  chmod 600 "$dir/stack.env"
}

for ending in newline none; do
  for leftover in "" leftover; do
    OLD="$WORK/old-$ending-${leftover:-plain}"
    older "$OLD" "$ending" "$leftover"
    before="$(cat "$OLD/stack.env")"
    check "an older env file ($ending at the end, ${leftover:-no leftover}) is accepted" ensure "$OLD"
    check "and it is kept as it was" test "$(cat "$OLD/stack.env")" = "$before"
    check "it stays mode 600" test "$(stat -c %a "$OLD/stack.env")" = 600
  done
done

# --- a key missing from a file (add_missing_stack_key, used by try-pr.sh) ---

# A copy of the new stack's file without the settings key, ending with or without a line break.
lacking() {
  local file="$1" ending="$2"
  grep -v '^ADIUTOR_SETTINGS_KEYS=' "$NEW/stack.env" >"$file"
  [ "$ending" = newline ] || truncate -s -1 "$file"
  chmod 600 "$file"
}

# Succeeds when the file is the text $2 (read without its last line break) with one more line at the end.
one_line_appended() {
  local file="$1" before="$2"
  [ "$(head -n -1 "$file")" = "$before" ] && [ "$(wc -l <"$file")" = "$(($(grep -c '' <<<"$before") + 1))" ]
}

add() { (add_missing_stack_key "$1" ADIUTOR_SETTINGS_KEYS) >/dev/null 2>&1; }

for ending in newline none; do
  FILE="$WORK/lacking-$ending.env"
  lacking "$FILE" "$ending"
  before="$(cat "$FILE")"
  check "a file lacking a key ($ending at the end) gains it" add "$FILE"
  check "as its one new last line" one_line_appended "$FILE" "$before"
  check "it then holds every key family, generated and distinct" keys_generated "$FILE"
  check "it stays mode 600" test "$(stat -c %a "$FILE")" = 600
  after="$(cat "$FILE")"
  add "$FILE"
  check "a second run changes nothing" test "$(cat "$FILE")" = "$after"
done

# Four runs at once on one file, ten times: each file ends with exactly one ADIUTOR_SETTINGS_KEYS line.
concurrent_runs_add_one_line() {
  local round file
  for round in $(seq 1 10); do
    file="$WORK/race-$round.env"
    lacking "$file" newline
    add "$file" &
    add "$file" &
    add "$file" &
    add "$file" &
    wait
    [ "$(grep -c '^ADIUTOR_SETTINGS_KEYS=' "$file")" = 1 ] || return 1
    keys_generated "$file" || return 1
  done
}
check "four runs at once add exactly one line" concurrent_runs_add_one_line

# --- a generator that fails ---

# random_hex printing nothing: no stack.env is created, and a file lacking a key is not written to.
no_value_written() {
  local before
  (
    random_hex() { :; }
    ensure_stack_env "$WORK/broken-new"
  ) >/dev/null 2>&1 && return 1
  [ ! -e "$WORK/broken-new/stack.env" ] || return 1
  lacking "$WORK/broken.env" newline
  before="$(cat "$WORK/broken.env")"
  (
    # shellcheck disable=SC2317 # called by add_missing_stack_key
    random_hex() { :; }
    add_missing_stack_key "$WORK/broken.env" ADIUTOR_SETTINGS_KEYS
  ) >/dev/null 2>&1 && return 1
  [ "$(cat "$WORK/broken.env")" = "$before" ]
}
check "a failing generator writes no key, new or appended" no_value_written

# An empty or short key is not valid, so it is never kept as if it were one.
short_keys_invalid() {
  local value
  for value in "" "1:" "1:$(new_hex | cut -c 1-31)"; do
    grep -v '^ADIUTOR_SETTINGS_KEYS=' "$NEW/stack.env" >"$WORK/short.env"
    echo "ADIUTOR_SETTINGS_KEYS=$value" >>"$WORK/short.env"
    chmod 600 "$WORK/short.env"
    ! stack_env_valid "$WORK/short.env" || return 1
  done
}
check "an empty or short key is not valid" short_keys_invalid

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
