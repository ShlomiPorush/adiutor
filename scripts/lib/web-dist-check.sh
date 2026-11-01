#!/usr/bin/env bash
# Checks the built web UI in dist/web: every script, stylesheet, font and image is served by Mikud
# itself (no external URL), and the development mock API is not in the build. scripts/verify.sh runs
# this inside the toolchain container after the build. Usage: web-dist-check.sh [DIR]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
dir="${1:-dist/web}"

[ -f "$dir/index.html" ] || {
  echo "$dir/index.html is missing: build the UI first (pnpm build:web)."
  exit 1
}

fail=0

# Prints the matches of an extended regex in the given files; a grep error stops the check.
find_in() {
  local pattern="$1" rc=0
  shift
  grep -HnoE "$pattern" "$@" || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "error: grep failed (exit $rc)" >&2
    exit 2
  fi
}

mapfile -t html < <(find "$dir" -type f -name '*.html')
mapfile -t css < <(find "$dir" -type f -name '*.css')
mapfile -t js < <(find "$dir" -type f \( -name '*.js' -o -name '*.mjs' \))

echo "--- No external script, stylesheet, font or image in $dir"
hits="$(
  find_in '(src|href|srcset|poster|data)[[:space:]]*=[[:space:]]*["'"'"']?(https?:)?//' "${html[@]}"
  [ ${#css[@]} -eq 0 ] || find_in '(url\([[:space:]]*["'"'"']?|@import[[:space:]]+["'"'"']?)(https?:)?//' "${css[@]}"
  [ ${#js[@]} -eq 0 ] || find_in '(import\(|importScripts\()[[:space:]]*["'"'"'`](https?:)?//' "${js[@]}"
  [ ${#js[@]} -eq 0 ] || find_in 'https?://[^"'"'"'`[:space:])]+\.(m?js|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico)([?#"'"'"'`]|$)' "${js[@]}"
  find_in '(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)' "${html[@]}" "${css[@]}" "${js[@]}"
)"
if [ -n "$hits" ]; then
  echo "External assets are not allowed; serve them from the image:"
  while IFS= read -r line; do echo "  $line"; done <<<"$hits"
  fail=1
fi

echo "--- No development mock API in $dir"
mock="$(find_in 'mikud\.mock\.' "${js[@]}")"
if [ -n "$mock" ]; then
  echo "The mock API (src/web/api/mock) is in the build; it must only load with VITE_MIKUD_MOCK=1:"
  while IFS= read -r line; do echo "  ${line%%:*}"; done <<<"$mock"
  fail=1
fi

exit "$fail"
