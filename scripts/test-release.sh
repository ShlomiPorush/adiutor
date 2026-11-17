#!/usr/bin/env bash
# Tests for scripts/release.sh: real git against a local bare remote, with docker, gh and dotnet (for
# `vpk upload github`) replaced by stand-ins that keep the registry, the GitHub Releases and their assets
# in files and fail on request. Covers a release with the tray, its refusals, each way a run can stop
# halfway, and the run after it. No network. Run by scripts/lib/guards.sh (inside the toolchain
# container) or on its own.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/adiutor-release-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
# The token the workflow gives the run: a new random value for each test run, never a real one.
GH_TOKEN="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
export GH_TOKEN
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
    [ -f "$WORK/case/out" ] && sed 's/^/      | /' "$WORK/case/out"
  fi
}

# --- stand-ins -------------------------------------------------------------------------------

mkdir -p "$WORK/bin"
cat >"$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
# Registry stand-in: one file per image tag, holding the commit it was built from.
key() { printf '%s' "$1" | tr '/:' '__'; }
echo "docker $*" >>"$STATE/calls"
[ "$1" = info ] && exit 0
[ "$1" = buildx ] || { echo "unexpected docker $*" >&2; exit 2; }
shift
if [ "$1 $2" = "imagetools inspect" ]; then
  [ -n "${MOCK_REGISTRY_DOWN:-}" ] && { echo "ERROR: unauthorized: authentication required" >&2; exit 1; }
  f="$STATE/images/$(key "$3")"
  [ -f "$f" ] || { echo "ERROR: $3: not found" >&2; exit 1; }
  # Indented, as docker prints it.
  printf '{\n  "architecture": "amd64",\n  "config": {\n    "Labels": {\n      "org.opencontainers.image.revision": "%s"\n    }\n  }\n}\n' "$(cat "$f")"
  exit 0
fi
if [ "$1 $2" = "imagetools create" ]; then
  [ -n "${MOCK_FAIL_LATEST:-}" ] && { echo "push failed" >&2; exit 1; }
  [ -f "$STATE/images/$(key "$5")" ] || exit 1
  cp "$STATE/images/$(key "$5")" "$STATE/images/$(key "$4")"
  exit 0
fi
if [ "$1" = build ]; then
  rev="" ref=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --label) case "$2" in org.opencontainers.image.revision=*) rev="${2#*=}" ;; esac; shift ;;
      -t) ref="$2"; shift ;;
    esac
    shift
  done
  [ -n "${MOCK_FAIL_BUILD:-}" ] && { echo "push failed" >&2; exit 1; }
  printf '%s' "$rev" >"$STATE/images/$(key "$ref")"
  exit 0
fi
echo "unexpected docker buildx $*" >&2
exit 2
EOF

# Shared by the gh and dotnet stand-ins. A release is a folder rel/<id> holding its tag, title and notes, a
# draft or immutable mark, and its assets (assets/<asset id> with the bytes, <asset id>.name with the name).
cat >"$WORK/bin/github-state.sh" <<'EOF'
next_id() {
  local n
  n=$(($(cat "$STATE/next-id" 2>/dev/null || echo 100) + 1))
  echo "$n" >"$STATE/next-id"
  echo "$n"
}
# One release as GitHub's API gives it.
release_json() {
  local r="$1" assets="" a
  for a in "$r"/assets/*.name; do
    [ -e "$a" ] || continue
    assets="$assets${assets:+,}{\"id\":$(basename "$a" .name),\"name\":\"$(cat "$a")\"}"
  done
  printf '{"id":%s,"tag_name":"%s","draft":%s,"prerelease":%s,"immutable":%s,"assets":[%s]}\n' "${r##*/}" "$(cat "$r/tag")" \
    "$([ -e "$r/draft" ] && echo true || echo false)" "$([ -e "$r/prerelease" ] && echo true || echo false)" \
    "$([ -e "$r/immutable" ] && echo true || echo false)" "$assets"
}
# The folder of the first release of a tag, if any.
release_dir() {
  local r
  for r in "$STATE"/rel/*; do
    [ -f "$r/tag" ] && [ "$(cat "$r/tag")" = "$1" ] && { echo "$r"; return 0; }
  done
  return 1
}
# Adds an asset to a release, refused as GitHub refuses a name that is there already.
add_asset() {
  local r="$1" name="$2" id a
  for a in "$r"/assets/*.name; do
    [ -e "$a" ] && [ "$(cat "$a")" = "$name" ] && { echo "HTTP 422: already_exists ($name)" >&2; return 1; }
  done
  id="$(next_id)"
  cat >"$r/assets/$id"
  echo "$name" >"$r/assets/$id.name"
}
EOF

cat >"$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
# GitHub stand-in for the calls release.sh makes: release create, and the API (through the real jq for
# --jq): the releases with drafts, one release, its assets, deleting and reading an asset, publishing. It
# does not answer the repository's immutable releases setting, which the workflow's token cannot read.
# Fails on request.
# shellcheck source=/dev/null
source "$(dirname "$0")/github-state.sh"
echo "gh $*" >>"$STATE/calls"
if [ "$1 $2" = "release create" ]; then
  tag="$3" title="" notes="" draft=""
  shift 3
  while [ $# -gt 0 ]; do
    case "$1" in
      --title) title="$2"; shift ;;
      --notes-file) notes="$2"; shift ;;
      --draft) draft=1 ;;
    esac
    shift
  done
  [ "${MOCK_CREATE:-}" = fail ] && { echo "HTTP 500" >&2; exit 1; }
  r="$STATE/rel/$(next_id)"
  mkdir -p "$r/assets"
  echo "$tag" >"$r/tag"
  echo "$title" >"$r/title"
  cp "$notes" "$r/notes"
  [ -n "$draft" ] && : >"$r/draft"
  [ "${MOCK_CREATE:-}" = lost ] && { echo "connection reset" >&2; exit 1; }
  exit 0
fi
[ "$1" = api ] || { echo "unexpected gh $*" >&2; exit 2; }
shift
method=GET accept="" jq_expr="" path="" fields=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift ;;
    -H) accept="$2"; shift ;;
    -F) fields="$fields$2"; shift ;;
    --jq) jq_expr="$2"; shift ;;
    --paginate) ;;
    *) path="$1" ;;
  esac
  shift
done
[ -n "${MOCK_GH_DOWN:-}" ] && { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
answer() { if [ -n "$jq_expr" ]; then jq -r "$jq_expr"; else cat; fi; }
asset_release() { local a; a="$(ls "$STATE"/rel/*/assets/"$1".name 2>/dev/null | head -1)"; [ -n "$a" ] && dirname "$(dirname "$a")"; }
path="${path#repos/\{owner\}/\{repo\}}"
id="${path##*/}"
case "$method $path" in
  "GET ") echo '{"full_name":"owner/repo"}' | answer ;;
  "GET /releases?per_page=100")
    {
      echo "["
      sep=""
      for r in "$STATE"/rel/*; do
        [ -f "$r/tag" ] || continue
        printf '%s' "$sep"
        release_json "$r"
        sep=","
      done
      echo "]"
    } | answer
    ;;
  "GET /releases/assets/"*)
    [ "$accept" = "Accept: application/octet-stream" ] || { echo "the asset is read as JSON" >&2; exit 2; }
    r="$(asset_release "$id")" || { echo "HTTP 404" >&2; exit 1; }
    cat "$r/assets/$id"
    ;;
  "DELETE /releases/assets/"*)
    [ "${MOCK_DELETE:-}" = fail ] && { echo "HTTP 500" >&2; exit 1; }
    r="$(asset_release "$id")" || { echo "HTTP 404" >&2; exit 1; }
    [ -e "$r/immutable" ] && { echo "HTTP 422: the release is immutable" >&2; exit 1; }
    rm -f "$r/assets/$id" "$r/assets/$id.name"
    ;;
  "GET /releases/"*)
    [ -f "$STATE/rel/$id/tag" ] || { echo "HTTP 404" >&2; exit 1; }
    # MOCK_ASSETS_DOWN fails only the reads of a release's assets, after the list of releases was read.
    [[ -n "${MOCK_ASSETS_DOWN:-}" && "$jq_expr" == *assets* ]] && { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
    release_json "$STATE/rel/$id" | answer
    ;;
  "PATCH /releases/"*)
    r="$STATE/rel/$id"
    { [[ "$fields" == draft=false* ]] && [ -f "$r/tag" ]; } || { echo "unexpected publish: $fields" >&2; exit 2; }
    [ "${MOCK_PUBLISH:-}" = fail ] && { echo "HTTP 500" >&2; exit 1; }
    rm -f "$r/draft"
    [[ "$fields" == *prerelease=false* ]] && rm -f "$r/prerelease"
    # The repository's immutable releases are on: a published release is immutable unless MOCK_NOT_IMMUTABLE.
    [ -z "${MOCK_NOT_IMMUTABLE:-}" ] && : >"$r/immutable"
    [ "${MOCK_PUBLISH:-}" = lost ] && { echo "connection reset" >&2; exit 1; }
    release_json "$r"
    ;;
  *) echo "unexpected gh api $method $path" >&2; exit 2 ;;
esac
EOF

cat >"$WORK/bin/dotnet" <<'EOF'
#!/usr/bin/env bash
# .NET stand-in for `dotnet tool restore` and `dotnet vpk [win] upload github`, which it does as Velopack
# 1.2.161 does against the GitHub stand-in: the release found by its tag (a new draft otherwise), a feed
# already there refused, the build's files (assets.win.json) uploaded one by one, then releases.win.json
# with the build's packages and RELEASES. Fails, or changes what it uploads, on request.
# shellcheck source=/dev/null
source "$(dirname "$0")/github-state.sh"
echo "dotnet $*" >>"$STATE/calls"
[ "$1 $2" = "tool restore" ] && exit 0
[ "$1 $2 $3 $4" = "vpk [win] upload github" ] || { echo "unexpected dotnet $*" >&2; exit 2; }
case " $* " in *" $GH_TOKEN "*) echo "the token is in the arguments" >>"$STATE/calls" ;; esac
[ "${VPK_TOKEN:-}" = "$GH_TOKEN" ] && echo "vpk got the token from its environment" >>"$STATE/calls"
shift 4
dir="" tag="" merge="" channel="" repo=""
while [ $# -gt 0 ]; do
  case "$1" in
    --outputDir) dir="$2"; shift ;;
    --tag) tag="$2"; shift ;;
    --channel) channel="$2"; shift ;;
    --repoUrl) repo="$2"; shift ;;
    --merge) merge=1 ;;
    *) echo "unexpected vpk option $1" >&2; exit 2 ;;
  esac
  shift
done
{ [ "$channel" = win ] && [ -n "$merge" ] && [ "$repo" = https://github.com/owner/repo ]; } || { echo "unexpected vpk options" >&2; exit 2; }
r="$(release_dir "$tag")" || {
  r="$STATE/rel/$(next_id)"
  mkdir -p "$r/assets"
  echo "$tag" >"$r/tag"
  : >"$r/draft"
}
grep -qx releases.win.json "$r"/assets/*.name 2>/dev/null && { echo "There is already a remote asset named 'releases.win.json'" >&2; exit 1; }
# Uploads stdin as one asset (never in a pipeline, which would lose the count); with MOCK_UPLOAD_FAIL_AFTER=N
# the run stops before the (N+1)th, feeds included.
count=0
upload() {
  if [ "${MOCK_UPLOAD_FAIL_AFTER:-}" = "$count" ]; then echo "upload failed" >&2; exit 1; fi
  add_asset "$r" "$1" || exit 1
  count=$((count + 1))
}
feed="" legacy=""
while IFS= read -r name; do
  if [ "${MOCK_UPLOAD_CORRUPT:-}" = "$name" ]; then
    upload "$name" < <(cat "$dir/$name" && echo changed)
  else
    upload "$name" <"$dir/$name"
  fi
  case "$name" in
    *-full.nupkg | *-delta.nupkg)
      kind=Full
      [[ "$name" == *-delta.nupkg ]] && kind=Delta
      version="${name#AdiutorSync-}"
      version="${version%-*}"
      sha1="$(sha1sum "$dir/$name" | cut -d' ' -f1 | tr a-f A-F)"
      sha256="$(sha256sum "$dir/$name" | cut -d' ' -f1 | tr a-f A-F)"
      [ "${MOCK_FEED:-}" = wrong ] && sha256="$(printf '0%.0s' {1..64})"
      size="$(wc -c <"$dir/$name" | tr -d ' ')"
      listed="$kind"
      [ "${MOCK_FEED:-}" = wrong-type ] && listed=Delta
      feed="$feed${feed:+,}{\"PackageId\":\"AdiutorSync\",\"Version\":\"$version\",\"Type\":\"$listed\",\"FileName\":\"$name\",\"SHA1\":\"$sha1\",\"SHA256\":\"$sha256\",\"Size\":$size}"
      # RELEASES holds the newest full package only, the one of this build.
      [ $kind = Full ] && legacy="$sha1 $name $size"
      ;;
  esac
done < <(jq -r '.[].RelativeFileName' "$dir/assets.win.json")
[ "${MOCK_FEED:-}" = legacy-extra ] && legacy="$legacy"$'\n'"0000000000000000000000000000000000000000 AdiutorSync-9.9.9-full.nupkg 1"
upload releases.win.json < <(printf '{"Assets":[%s]}' "$feed")
# As vpk 1.2.161 writes it: UTF-8 with a byte order mark, no line break at the end.
upload RELEASES < <(printf '\xef\xbb\xbf%s' "$legacy")
EOF
chmod +x "$WORK/bin/docker" "$WORK/bin/gh" "$WORK/bin/dotnet"

# --- sandbox ---------------------------------------------------------------------------------

# A fresh origin with one commit on main and a fresh registry and Releases; prints nothing.
sandbox() {
  rm -rf "$WORK/case"
  mkdir -p "$WORK/case/images" "$WORK/case/rel"
  export STATE="$WORK/case"
  : >"$STATE/calls"
  git init --quiet --bare --initial-branch=main "$WORK/case/origin.git"
  local seed="$WORK/case/seed"
  git init --quiet --initial-branch=main "$seed"
  mkdir -p "$seed/scripts/lib" "$seed/docker" "$seed/tray"
  cp "$REPO/scripts/release.sh" "$seed/scripts/"
  cp "$REPO/scripts/lib/common.sh" "$seed/scripts/lib/"
  : >"$seed/docker/adiutor.Dockerfile"
  : >"$seed/tray/dotnet-tools.json"
  : >"$seed/scripts/pack-tray.ps1"
  printf '{\n  "name": "adiutor",\n  "version": "0.0.0",\n  "private": true\n}\n' >"$seed/package.json"
  printf '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- The first feature.\n' >"$seed/CHANGELOG.md"
  git -C "$seed" add -A
  git -C "$seed" commit --quiet -m "Initial"
  git -C "$seed" remote add origin "$WORK/case/origin.git"
  git -C "$seed" push --quiet origin main
}

# A new checkout of origin's main, as each workflow run makes; prints its path.
checkout() {
  local dir
  dir="$(mktemp -d "$WORK/case/run.XXXX")"
  git clone --quiet "$WORK/case/origin.git" "$dir/repo"
  echo "$dir/repo"
}

origin_head() { git -C "$WORK/case/origin.git" rev-parse main; }

# Runs release.sh with the given arguments in the checkout DIR (a new one unless DIR is set). The output
# goes to case/out, after what is there when APPEND is set.
run_in() {
  local dir="${DIR:-$(checkout)}"
  if [ -n "${APPEND:-}" ]; then
    (cd "$dir" && PATH="$WORK/bin:$PATH" bash scripts/release.sh "$@") >>"$WORK/case/out" 2>&1
  else
    (cd "$dir" && PATH="$WORK/bin:$PATH" bash scripts/release.sh "$@") >"$WORK/case/out" 2>&1
  fi
}

# A tray build of VERSION as scripts/pack-tray.ps1 leaves it (random bytes for each file), with a delta
# package when DELTA is set; prints its folder and keeps it as the version's newest build.
make_pack() {
  local version="$1" dir names name kind
  dir="$(mktemp -d "$WORK/case/pack.XXXX")"
  names=("AdiutorSync-win-Portable.zip" "AdiutorSync-win-Setup.exe" "AdiutorSync-$version-full.nupkg")
  [ -z "${DELTA:-}" ] || names+=("AdiutorSync-$version-delta.nupkg")
  {
    printf '['
    for name in "${names[@]}"; do
      head -c 64 /dev/urandom >"$dir/$name"
      case "$name" in *-full.nupkg) kind=Full ;; *-delta.nupkg) kind=Delta ;; *.exe) kind=Installer ;; *) kind=Portable ;; esac
      [ "$name" = "${names[0]}" ] || printf ','
      printf '{"RelativeFileName":"%s","Type":"%s"}' "$name" "$kind"
    done
    printf ']'
  } >"$dir/assets.win.json"
  echo "$dir" >"$WORK/case/pack-$version"
  echo "$dir"
}

# Runs release.sh --tray for the version the last release step wrote, in DIR, with a new build of it.
tray() {
  local out="$WORK/case/output" tag sha pack
  tag="$(sed -n 's/^tag=//p' "$out")"
  sha="$(sed -n 's/^sha=//p' "$out")"
  pack="$(make_pack "${tag#v}")"
  local args=(--tray "$pack" --tag "$tag" --expect-sha "${TRAY_SHA:-$sha}")
  [ -z "${TRAY_DRY:-}" ] || args+=(--dry-run)
  APPEND=1 run_in "${args[@]}"
}

# Runs a release as the workflow does, in a new checkout verified at origin's current main unless EXPECT
# is set: release.sh, then, unless NO_TRAY is set or release.sh says tray=false, the tray built from the
# commit it names.
release() {
  local dir
  dir="${DIR:-$(checkout)}"
  rm -f "$WORK/case/output"
  DIR="$dir" run_in --target ghcr --bump "${BUMP:-minor}" --skip-verify --expect-sha "${EXPECT:-$(origin_head)}" \
    --output "$WORK/case/output" || return 1
  if [ -n "${NO_TRAY:-}" ] || grep -qx "tray=false" "$WORK/case/output"; then return 0; fi
  DIR="$dir" tray
}

has_tag() { git -C "$WORK/case/origin.git" rev-parse -q --verify "refs/tags/$1" >/dev/null; }
image_rev() { cat "$STATE/images/ghcr.io_shlomiporush_adiutor_$1" 2>/dev/null; }
tag_rev() { git -C "$WORK/case/origin.git" rev-parse "$1^{commit}"; }
rel() {
  # shellcheck source=/dev/null
  (source "$WORK/bin/github-state.sh" && release_dir "$1")
}
has_release() { rel "$1" >/dev/null; }
is_draft() { [ -e "$(rel "$1")/draft" ]; }
is_published() { has_release "$1" && ! is_draft "$1"; }
release_text() { cat "$(rel "$1")/title" "$(rel "$1")/notes"; }
asset_names() { cat "$(rel "$1")"/assets/*.name 2>/dev/null | sort; }
lacks_tag() { ! has_tag "$1"; }
lacks_release() { ! has_release "$1"; }
nothing_built() { ! grep -q "buildx build" "$STATE/calls"; }
nothing_published() { ! grep -qE "buildx (build|imagetools create)|release create|vpk|-X (PATCH|DELETE)" "$STATE/calls"; }
nothing_uploaded() { ! grep -qE "vpk|-X (PATCH|DELETE)" "$STATE/calls"; }
said() { grep -q "$1" "$WORK/case/out"; }
calls() { grep -c -e "$1" "$STATE/calls"; }
# The tray's assets of the version's newest build are on its release, byte for byte, with the feed files.
tray_on() {
  local r pack name id
  r="$(rel "v$1")" || return 1
  pack="$(cat "$WORK/case/pack-$1")"
  [ "$(asset_names "v$1")" = "$( (jq -r '.[].RelativeFileName' "$pack/assets.win.json" && printf 'releases.win.json\nRELEASES\n') | sort)" ] ||
    return 1
  for id in "$r"/assets/*.name; do
    name="$(cat "$id")"
    [ ! -e "$pack/$name" ] || cmp -s "$pack/$name" "${id%.name}" || return 1
  done
}
complete() {
  local rev
  rev="$(tag_rev "v$1")"
  [ "$(image_rev "$1")" = "$rev" ] && [ "$(image_rev latest)" = "$rev" ] && is_published "v$1" &&
    [ -e "$(rel "v$1")/immutable" ] && tray_on "$1"
}
# The token reached vpk through its environment, once, and never through its arguments.
token_from_env() { [ "$(calls "vpk got the token from its environment")" = 1 ] && [ "$(calls "the token is in the arguments")" = 0 ]; }
# Every tray asset was read back, all of them before the one publish.
read_back_first() {
  [ "$(calls "Accept: application/octet-stream")" = "$1" ] &&
    [ "$(grep -n "octet-stream" "$STATE/calls" | tail -1 | cut -d: -f1)" -lt "$(grep -n -e "-X PATCH" "$STATE/calls" | cut -d: -f1)" ]
}
released_before() { [ "$(image_rev "$1")" = "$(tag_rev "v$1")" ] && tray_on "$1"; }
not_said() { ! said "$1"; }
untouched() { lacks_tag "$1" && nothing_published; }
draft_holding() { is_draft "$1" && [ "$(asset_names "$1" | wc -l)" = "$2" ]; }
draft_with_tray() { is_draft "v$1" && tray_on "$1"; }
# One version came of a run that stopped in its tray upload and the next run.
upload_stop_once() {
  lacks_tag v0.2.0 && [ "$(calls "buildx build") $(calls "release create")" = "1 1" ] && [ "$(calls "-X PATCH")" = 1 ]
}
# The version's image and :latest are from the commit $2.
image_from() { [ "$(image_rev "$1") $(image_rev latest)" = "$2 $2" ]; }
# A published GitHub Release with no assets.
published_bare() { is_published "$1" && [ -z "$(asset_names "$1")" ]; }
not_called() { ! grep -qF -e "$1" "$STATE/calls"; }
# The calls of the upload, the removals and the publish.
upload_calls() { [ "$(calls "vpk \[win\] upload") $(calls "-X DELETE") $(calls "-X PATCH")" = "$1" ]; }

# A published GitHub Release of TAG with no assets, as releases from before the tray are.
published_release() {
  mkdir -p "$STATE/rel/$2/assets"
  echo "$1" >"$STATE/rel/$2/tag"
  echo "Adiutor ${1#v}" >"$STATE/rel/$2/title"
  : >"$STATE/rel/$2/notes"
}

# --- a release and the next one --------------------------------------------------------------

sandbox
release
check "a release succeeds" [ $? -eq 0 ]
check "it releases 0.1.0 from 0.0.0 with --bump minor, with the tray" complete 0.1.0
check "origin main is the release commit" [ "$(git -C "$WORK/case/origin.git" log -1 --format=%s main)" = "Release v0.1.0" ]
check "the tag is on the release commit" [ "$(tag_rev v0.1.0)" = "$(origin_head)" ]
check "the tag is annotated" [ "$(git -C "$WORK/case/origin.git" cat-file -t v0.1.0)" = tag ]
check "package.json says 0.1.0" grep -q '"version": "0.1.0"' <(git -C "$WORK/case/origin.git" show main:package.json)
check "the CHANGELOG keeps an empty Unreleased above the dated section" \
  grep -qzP '## \[Unreleased\]\n\n## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}\n' <(git -C "$WORK/case/origin.git" show main:CHANGELOG.md)
check "the GitHub Release has the title and the section's notes" \
  [ "$(release_text v0.1.0)" = "$(printf 'Adiutor 0.1.0\n### Added\n\n- The first feature.')" ]
check "the image is built with provenance and an SBOM" grep -q "buildx build --push --provenance=mode=max --sbom=true" "$STATE/calls"
check "the release step names the tag, the version and the tag's commit for the tray" \
  [ "$(cat "$WORK/case/output")" = "$(printf 'tag=v0.1.0\nversion=0.1.0\nsha=%s\ntray=true' "$(tag_rev v0.1.0)")" ]
check "the GitHub Release is created as a draft" grep -q "gh release create v0.1.0 --verify-tag --draft" "$STATE/calls"
check "the tray goes to the draft through vpk upload github, never published by vpk" \
  grep -qE "^dotnet vpk \[win\] upload github .*--channel win .*--tag v0.1.0 --merge$" "$STATE/calls"
check "vpk gets the token from its environment, not its arguments" token_from_env
check "every tray asset is read back before the release is published" read_back_first 5
check "  and it is published once" [ "$(calls "-X PATCH")" = 1 ]
check "  and says so" said "5 tray assets on the draft match the local files"
dir="$(checkout)"
sed -i 's/^## \[Unreleased\]$/## [Unreleased]\n\n### Fixed\n\n- A fix./' "$dir/CHANGELOG.md"
git -C "$dir" commit --quiet -am "Fix" && git -C "$dir" push --quiet origin main
BUMP="patch" DELTA=1 release
check "the next run releases 0.1.1 with --bump patch, with a delta package" complete 0.1.1
check "  whose feed lists the full and the delta package" grep -qx "AdiutorSync-0.1.1-delta.nupkg" <(asset_names v0.1.1)
check "0.1.1's notes hold only its own entries" [ "$(release_text v0.1.1 | sed -n '2,$p')" = "$(printf '### Fixed\n\n- A fix.')" ]
check "0.1.0 is left as it was" released_before 0.1.0
check ":latest is 0.1.1" [ "$(image_rev latest)" = "$(tag_rev v0.1.1)" ]

# --- releases from before the tray -----------------------------------------------------------

sandbox
dir="$(checkout)"
sed -i 's/"version": "0.0.0"/"version": "0.1.0"/' "$dir/package.json"
git -C "$dir" commit --quiet -am "Release v0.1.0" && git -C "$dir" tag -a v0.1.0 -m v0.1.0
git -C "$dir" push --quiet origin main v0.1.0
published_release v0.1.0 50
release
check "a published release without tray assets (from before the tray) is finished: the next version is released" complete 0.2.0
check "  and the older release is not touched" [ -z "$(asset_names v0.1.0)" ]
check "  nor called unfinished" not_said "v0.1.0 was not finished"

# A release that stopped before releases carried the tray: its tag has no scripts/pack-tray.ps1. The next
# run finishes it as runs did then, the image and a published GitHub Release, and skips the tray.
sandbox
dir="$(checkout)"
git -C "$dir" rm --quiet scripts/pack-tray.ps1
sed -i 's/"version": "0.0.0"/"version": "0.1.0"/' "$dir/package.json"
sed -i 's/^## \[Unreleased\]$/## [Unreleased]\n\n## [0.1.0] - 2026-01-01/' "$dir/CHANGELOG.md"
git -C "$dir" commit --quiet -am "Release v0.1.0" && git -C "$dir" tag -a v0.1.0 -m v0.1.0
: >"$dir/scripts/pack-tray.ps1"
sed -i 's/^## \[Unreleased\]$/## [Unreleased]\n\n### Added\n\n- The tray./' "$dir/CHANGELOG.md"
git -C "$dir" add -A && git -C "$dir" commit --quiet -m "The tray's release"
git -C "$dir" push --quiet origin main v0.1.0
tagged="$(tag_rev v0.1.0)"
release
check "a stopped release from before the tray: the next run finishes it" [ $? -eq 0 ]
check "  and says it has no tray" said "v0.1.0 has no tray packaging"
check "  with the image and :latest from its tag" image_from 0.1.0 "$tagged"
check "  and a published GitHub Release without tray assets" published_bare v0.1.0
check "  created published, not as a draft" not_called "release create v0.1.0 --verify-tag --draft"
check "  and it names no tray for the workflow" grep -qx "tray=false" "$WORK/case/output"
check "  nor uploads one" nothing_uploaded
check "  nor reads the immutable releases setting" not_called "immutable-releases"
check "  and does not move the tag" [ "$(tag_rev v0.1.0)" = "$tagged" ]
release
check "  the run after it releases 0.2.0 with the tray" complete 0.2.0

# --- refusals before anything changes --------------------------------------------------------

sandbox
run_in --bump minor
check "no --target: refused" said "an explicit target is required"
run_in --target ghcr --bump huge
check "a bad --bump: refused" said "must be patch, minor or major"
run_in --target ghcr --bump minor --skip-verify
check "--skip-verify without --expect-sha: refused" said "needs --expect-sha"
run_in --target ghcr --bump minor --expect-sha abc
check "a short --expect-sha: refused" said "must be a full commit SHA"
run_in --tray "$WORK" --tag v0.1.0
check "--tray without --expect-sha: refused" said "needs --expect-sha"
run_in --tray "$WORK" --tag v0.1.0 --expect-sha "$(origin_head)" --target ghcr
check "--tray with the release's options: refused" said "takes only --tag, --expect-sha and --dry-run"
run_in --target ghcr --bump minor --tag v0.1.0
check "--tag without --tray: refused" said "goes only with --tray"
check "  and nothing was published" nothing_published

sandbox
dir="$(checkout)"
git -C "$dir" switch --quiet -c feature
DIR="$dir" release
check "a branch other than main: refused" said "releases are made from main"
dir="$(checkout)"
echo dirty >"$dir/file"
DIR="$dir" release
check "a working tree that is not clean: refused" said "the working tree is not clean"
dir="$(checkout)"
echo local >"$dir/file" && git -C "$dir" add file && git -C "$dir" commit --quiet -m "Local only"
DIR="$dir" EXPECT="$(git -C "$dir" rev-parse HEAD)" release
check "main ahead of origin/main: refused" said "not in sync with origin/main"
check "  and nothing was pushed or published" [ "$(git -C "$WORK/case/origin.git" log -1 --format=%s main)" = Initial ]
check "  nor published" nothing_published

sandbox
stale="$(origin_head)"
dir="$(checkout)"
echo change >"$dir/file" && git -C "$dir" add file && git -C "$dir" commit --quiet -m "Merged meanwhile" && git -C "$dir" push --quiet origin main
EXPECT="$stale" release
check "main moved after verification: the run stops" [ $? -ne 0 ]
check "  and says why" said "something was pushed meanwhile"
check "  and publishes nothing" nothing_published
check "  and pushes no tag" lacks_tag v0.1.0

sandbox
dir="$(checkout)"
git -C "$dir" tag -a v0.1.0 -m "made by hand" && git -C "$dir" push --quiet origin v0.1.0
published_release v0.1.0 50
release
check "the next version's tag exists already: refused" said "tag v0.1.0 already exists"
check "  and the tag is not moved" [ "$(tag_rev v0.1.0)" = "$(git -C "$dir" rev-parse HEAD)" ]
check "  and nothing was published" nothing_published

sandbox
dir="$(checkout)"
git -C "$dir" tag -a v0.1.0 -m "made by hand" && git -C "$dir" push --quiet origin v0.1.0
release
check "a tag without a Release that is not a release commit: refused" said "package.json at v0.1.0 is not 0.1.0"
check "  and nothing was published" nothing_published

sandbox
printf other >"$STATE/images/ghcr.io_shlomiporush_adiutor_0.1.0"
release
check "the next version is already in the registry: the run stops" [ $? -ne 0 ]
check "  before tagging" lacks_tag v0.1.0

sandbox
MOCK_REGISTRY_DOWN=1 release
check "a registry that cannot be read stops the run" [ $? -ne 0 ]
check "  and is not taken for a free version" lacks_tag v0.1.0

sandbox
dir="$(checkout)"
printf '# Changelog\n\n## [Unreleased]\n' >"$dir/CHANGELOG.md"
git -C "$dir" commit --quiet -am "Empty" && git -C "$dir" push --quiet origin main
release
check "an empty Unreleased section stops the run" [ $? -ne 0 ]
check "  with a clear reason" said "no entries under \[Unreleased\]"

# --- GitHub's immutable releases -------------------------------------------------------------

sandbox
release
check "a release never reads the repository's immutable releases setting" not_called "immutable-releases"
check "  which the workflow's token cannot read" complete 0.1.0

sandbox
MOCK_NOT_IMMUTABLE=1 release
check "a release GitHub did not make immutable when published: the run fails" [ $? -ne 0 ]
check "  and says so" said "GitHub did not make it immutable"
check "  and how to recover: back to a draft and run again" said "gh release edit v0.1.0 --draft=true"
check "  with the release published" is_published v0.1.0
DIR="$(checkout)" tray
check "  the tray step run again does not count it as finished" [ $? -ne 0 ]
check "  and says why" said "v0.1.0 is published with the tray, but GitHub did not make it immutable"
dir="$(checkout)"
sed -i 's/^## \[Unreleased\]$/## [Unreleased]\n\n### Fixed\n\n- A fix./' "$dir/CHANGELOG.md"
git -C "$dir" commit --quiet -am "Fix" && git -C "$dir" push --quiet origin main
release
check "  a new run does not count it as finished either" [ $? -ne 0 ]
check "  and says why" said "v0.1.0 is published with the tray, but GitHub did not make it immutable"
check "  and starts no new version" lacks_tag v0.2.0
MOCK_ASSETS_DOWN=1 release
check "  nor when the read of its assets fails: the run fails" [ $? -ne 0 ]
check "  and says why" said "cannot read the assets of the GitHub Release"
check "  and still starts no new version" lacks_tag v0.2.0
# The recovery: immutable releases on, the release moved back to a draft (gh release edit --draft=true).
rm -f "$WORK/case/output"
: >"$(rel v0.1.0)/draft"
release
check "  moved back to a draft with every tray asset, the next run finishes it" complete 0.1.0
check "  republished immutable, as the same version" lacks_tag v0.2.0
check "  without building the image again" [ "$(calls "buildx build")" = 1 ]

# A published release with the tray marked as a pre-release, which the tray's updater skips.
sandbox
release
check "the publish request clears the pre-release mark" grep -qE -e "-X PATCH .*-F draft=false -F prerelease=false" "$STATE/calls"
: >"$(rel v0.1.0)/prerelease"
DIR="$(checkout)" tray
check "a published tray release marked as a pre-release: the tray step run again fails" [ $? -ne 0 ]
check "  and says why" said "v0.1.0 is marked as a pre-release, which the tray's updater skips"
dir="$(checkout)"
sed -i 's/^## \[Unreleased\]$/## [Unreleased]\n\n### Fixed\n\n- A fix./' "$dir/CHANGELOG.md"
git -C "$dir" commit --quiet -am "Fix" && git -C "$dir" push --quiet origin main
release
check "  and so does a new run" said "v0.1.0 is marked as a pre-release, which the tray's updater skips"
check "  which starts no new version" lacks_tag v0.2.0

# --- dry run ---------------------------------------------------------------------------------

sandbox
dir="$(checkout)"
before="$(git -C "$dir" rev-parse HEAD) $(git -C "$dir" status --porcelain | wc -l)"
DIR="$dir" run_in --target ghcr --bump minor --dry-run --output "$WORK/case/output"
check "a dry run succeeds" [ $? -eq 0 ]
check "  and names the version and the image" said "ghcr.io/shlomiporush/adiutor:0.1.0 and :latest"
check "  and prints the release notes" said "The first feature."
check "  and names the version and the verified commit for the tray" \
  [ "$(cat "$WORK/case/output")" = "$(printf 'tag=v0.1.0\nversion=0.1.0\nsha=%s\ntray=true' "$(origin_head)")" ]
check "  and changes nothing in the checkout" [ "$(git -C "$dir" rev-parse HEAD) $(git -C "$dir" status --porcelain | wc -l)" = "$before" ]
check "  nor on origin" lacks_tag v0.1.0
check "  nor in the registry or Releases" nothing_published
DIR="$dir" TRAY_DRY=1 tray
check "the tray's dry run of a new version succeeds" [ $? -eq 0 ]
check "  and lists what it would upload" said "AdiutorSync-win-Setup.exe"
check "  with the feed files" said "releases.win.json"
check "  and uploads nothing" nothing_published
check "  and neither dry run reads the immutable releases setting" not_called "immutable-releases"

sandbox
MOCK_FAIL_BUILD=1 release
DIR="$(checkout)" run_in --target ghcr --bump major --dry-run
check "a dry run after a stopped run says it would finish that version" said "Would finish v0.1.0"
check "  and publishes nothing" [ ! -e "$STATE/images/ghcr.io_shlomiporush_adiutor_0.1.0" ]

sandbox
MOCK_UPLOAD_FAIL_AFTER=2 release
DIR="$(checkout)" run_in --target ghcr --bump minor --dry-run --output "$WORK/case/output"
check "a dry run after a stopped tray upload counts the tray assets on the draft" said "holds 2 tray asset(s)"
check "  and removes none" [ "$(asset_names v0.1.0 | wc -l)" = 2 ]
check "  nor publishes the release" is_draft v0.1.0

# --- a run that stopped halfway, and the next run --------------------------------------------

sandbox
printf '#!/bin/sh\nexit 1\n' >"$WORK/case/origin.git/hooks/pre-receive" && chmod +x "$WORK/case/origin.git/hooks/pre-receive"
release
check "origin refuses the push: the run stops" [ $? -ne 0 ]
check "  before the image is built" nothing_built
rm "$WORK/case/origin.git/hooks/pre-receive"
release
check "  and the next run releases 0.1.0 in full" complete 0.1.0

sandbox
MOCK_FAIL_BUILD=1 release
check "the image build fails: the run stops" [ $? -ne 0 ]
check "  with the tag on origin" has_tag v0.1.0
check "  no image" [ ! -e "$STATE/images/ghcr.io_shlomiporush_adiutor_0.1.0" ]
check "  :latest not moved" [ ! -e "$STATE/images/ghcr.io_shlomiporush_adiutor_latest" ]
check "  and no GitHub Release" lacks_release v0.1.0
BUMP="major" release
check "the next run finishes 0.1.0 and ignores the bump" complete 0.1.0
check "  and says so" said "v0.1.0 was not finished"
check "  and starts no other version" lacks_tag v1.0.0

sandbox
MOCK_FAIL_LATEST=1 release
check "moving :latest fails: the run stops" [ $? -ne 0 ]
check "  with the version's image published" [ "$(image_rev 0.1.0)" = "$(tag_rev v0.1.0)" ]
release
check "  and the next run finishes 0.1.0" complete 0.1.0
check "  without building the image again" [ "$(calls "buildx build")" = 1 ]

sandbox
MOCK_FAIL_BUILD=1 release
printf other >"$STATE/images/ghcr.io_shlomiporush_adiutor_0.1.0"
release
check "an image of this version from another commit stops the run" [ $? -ne 0 ]
check "  with a clear reason" said "exists but was not built from v0.1.0"
check "  and is left as it is" [ "$(image_rev 0.1.0)" = other ]
check "  and :latest is not moved" [ ! -e "$STATE/images/ghcr.io_shlomiporush_adiutor_latest" ]

sandbox
MOCK_CREATE=fail release
check "the GitHub Release fails: the run stops" [ $? -ne 0 ]
check "  after the image and :latest" [ "$(image_rev latest)" = "$(tag_rev v0.1.0)" ]
check "  with no GitHub Release" lacks_release v0.1.0
release
check "  and the next run creates the Release" complete 0.1.0
check "  without pushing the image again" [ "$(calls "buildx build")" = 1 ]

sandbox
MOCK_CREATE=lost release
check "a Release created with its answer lost counts as created" [ $? -eq 0 ]
check "  and the version is complete" complete 0.1.0
check "  with one GitHub Release" [ "$(calls "release create")" = 1 ]

sandbox
NO_TRAY=1 release
check "the tray is not built (the Windows job failed): the release is a draft" is_draft v0.1.0
check "  with the image and :latest" [ "$(image_rev latest)" = "$(tag_rev v0.1.0)" ]
BUMP=major release
check "  and the next run finishes 0.1.0 with the tray" complete 0.1.0
check "  and starts no other version" lacks_tag v1.0.0
check "  with one GitHub Release" [ "$(calls "release create")" = 1 ]

sandbox
MOCK_UPLOAD_FAIL_AFTER=2 release
check "the tray upload stops after two files: the run stops" [ $? -ne 0 ]
check "  with the release a draft holding those two" draft_holding v0.1.0 2
release
check "  and the next run says what the draft holds" said "holds 2 tray asset(s)"
check "  removes them" said "removing AdiutorSync-win-Portable.zip, left on the draft by an earlier run"
check "  and finishes 0.1.0 with the new build" complete 0.1.0
check "  without building the image again" [ "$(calls "buildx build")" = 1 ]

# A stop after each upload: none, each of the three files, and releases.win.json before RELEASES.
for n in 0 1 2 3 4; do
  sandbox
  MOCK_UPLOAD_FAIL_AFTER=$n release
  check "the upload stops after $n asset(s): the run stops" [ $? -ne 0 ]
  check "  with a draft holding $n asset(s)" draft_holding v0.1.0 "$n"
  release
  check "  and the next run finishes 0.1.0" complete 0.1.0
  check "  with one tag, one image build and one GitHub Release" upload_stop_once
done

sandbox
MOCK_UPLOAD_CORRUPT=AdiutorSync-win-Setup.exe release
check "an installer that reads back different: the run stops" [ $? -ne 0 ]
check "  with a clear reason" said "AdiutorSync-win-Setup.exe on the draft v0.1.0 does not match the local file"
check "  and does not publish" is_draft v0.1.0
release
check "  and the next run finishes 0.1.0" complete 0.1.0

sandbox
MOCK_FEED=wrong release
check "a feed that does not list the packages' checksums: the run stops" [ $? -ne 0 ]
check "  with a clear reason" said "releases.win.json on the draft v0.1.0 does not list the local packages"
check "  and does not publish" is_draft v0.1.0
release
check "  and the next run finishes 0.1.0" complete 0.1.0

sandbox
MOCK_FEED=wrong-type release
check "a feed that lists the full package as a delta: the run stops" [ $? -ne 0 ]
check "  with a clear reason" said "releases.win.json on the draft v0.1.0 does not list the local packages"
check "  and does not publish" is_draft v0.1.0

sandbox
MOCK_FEED=legacy-extra release
check "a RELEASES that lists another package: the run stops" [ $? -ne 0 ]
check "  with a clear reason" said "RELEASES on the draft v0.1.0 lists .* which is not a local package"
check "  and does not publish" is_draft v0.1.0

sandbox
MOCK_PUBLISH=fail release
check "publishing fails: the run stops" [ $? -ne 0 ]
check "  with every tray asset on the draft" draft_with_tray 0.1.0
release
check "  and the next run uploads the tray again and publishes" complete 0.1.0

sandbox
MOCK_PUBLISH=lost release
check "a publish with its answer lost counts as published" [ $? -eq 0 ]
check "  and the version is complete" complete 0.1.0

sandbox
MOCK_DELETE=fail MOCK_UPLOAD_FAIL_AFTER=1 release
MOCK_DELETE=fail release
check "removing a stopped run's asset fails: the run stops" [ $? -ne 0 ]
check "  before uploading" [ "$(calls "vpk \[win\] upload")" = 1 ]
release
check "  and the next run finishes 0.1.0" complete 0.1.0

sandbox
release
DIR="$(checkout)" tray
check "the tray step again after the release is published: nothing to do" [ $? -eq 0 ]
check "  and says so" said "published with the tray"
check "  and uploads, removes and publishes nothing more" upload_calls "1 0 1"

sandbox
NO_TRAY=1 release
TRAY_SHA="$(git -C "$WORK/case/origin.git" rev-parse main~1)" DIR="$(checkout)" tray
check "a tray built from another commit than the tag's: refused" said "which the tray was built from"
check "  before uploading" nothing_uploaded

sandbox
NO_TRAY=1 release
pack="$(make_pack 0.0.9)"
APPEND=1 DIR="$(checkout)" run_in --tray "$pack" --tag v0.1.0 --expect-sha "$(tag_rev v0.1.0)"
check "a tray build of another version: refused" said "a package of another version than 0.1.0"
check "  before uploading" nothing_uploaded

sandbox
NO_TRAY=1 release
rm -rf "$(rel v0.1.0)"
DIR="$(checkout)" tray
check "the draft is gone before the tray step: it stops" said "v0.1.0 has no GitHub Release"
check "  and vpk makes no release of its own" nothing_uploaded

sandbox
NO_TRAY=1 release
cp -r "$(rel v0.1.0)" "$STATE/rel/999"
DIR="$(checkout)" tray
check "two GitHub Releases for the tag: the tray step stops" said "there are 2 GitHub Releases for v0.1.0"
check "  before uploading" nothing_uploaded

sandbox
NO_TRAY=1 release
: >"$(rel v0.1.0)/prerelease"
DIR="$(checkout)" tray
check "a draft marked as a pre-release: the tray step stops" [ $? -ne 0 ]
check "  and says why" said "is marked as a pre-release"
check "  before uploading" nothing_uploaded
check "  and the release stays a draft" is_draft v0.1.0
release
check "  and so does the next run" said "is marked as a pre-release"
check "  which uploads nothing either" nothing_uploaded

sandbox
MOCK_FAIL_BUILD=1 release
MOCK_GH_DOWN=1 release
check "GitHub that cannot be read stops the run" [ $? -ne 0 ]
check "  and starts no new version" lacks_tag v0.2.0

# --- release_notes on its own ----------------------------------------------------------------

# shellcheck source=scripts/release.sh
source "$REPO/scripts/release.sh"
set +e
notes() { (release_notes "$1" <<<"$2") 2>&1; }
check "notes: the one section, without its heading" \
  [ "$(notes 1.0.0 "$(printf '## [Unreleased]\n\n## [1.0.0] - 2026-01-02\n\n### Added\n\n- A.\n\n## [0.9.0] - 2026-01-01\n\n- B.\n')")" = "$(printf '### Added\n\n- A.')" ]
check "notes: a missing section fails" grep -q "found 0" <(notes 1.0.0 "## [0.9.0] - 2026-01-01")
check "notes: a section twice fails" grep -q "found 2" <(notes 1.0.0 "$(printf '## [1.0.0] - 2026-01-02\n- A.\n## [1.0.0] - 2026-01-03\n- B.\n')")
check "notes: a section of headings only fails" grep -q "has no entries" <(notes 1.0.0 "$(printf '## [1.0.0] - 2026-01-02\n\n### Added\n\n')")
check "notes: 1.0.0 does not match 1.0.01" grep -q "found 0" <(notes 1.0.0 "## [1.0.01] - 2026-01-02")

echo "release.sh: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
