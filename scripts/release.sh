#!/usr/bin/env bash
# Releases a version: the release commit and tag, the image on GHCR, the GitHub Release as a draft, and
# then (--tray) the sync tray's installer and Velopack feed on that draft, which is published once every
# asset is read back. Deploys nothing. Normally run by the Release workflow (.github/workflows/release.yml),
# which verifies the commit first and packs the tray on Windows in between; run by hand it runs
# scripts/verify.sh itself.
# Usage: scripts/release.sh --target ghcr --bump <patch|minor|major> [--skip-verify --expect-sha SHA] [--output FILE] [--dry-run]
#        scripts/release.sh --tray DIR --tag vX.Y.Z --expect-sha SHA [--dry-run]
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

REGISTRY="ghcr.io/shlomiporush"
SOURCE_URL="https://github.com/ShlomiPorush/adiutor"
# Dockerfile name under docker/ and image name under REGISTRY.
DOCKERFILE="adiutor"
IMAGE="adiutor"
TARGET=""
BUMP=""
EXPECT_SHA=""
SKIP_VERIFY=0
DRY_RUN=0
RESUME=0
VERSION=""
TAG=""
OUTPUT=""
TRAY_DIR=""
# The files of the tray's build (assets.win.json), set by read_tray_build.
TRAY_FILES=()

usage() {
  cat <<'EOF'
Usage: scripts/release.sh --target ghcr --bump <patch|minor|major> [--skip-verify --expect-sha SHA] [--output FILE] [--dry-run]
       scripts/release.sh --tray DIR --tag vX.Y.Z --expect-sha SHA [--dry-run]

  --target ghcr     Publish the image to ghcr.io/shlomiporush/adiutor. Required without --tray.
  --bump KIND       Semantic version part to increase. Required without --tray.
  --expect-sha SHA  Refuse unless main is exactly this commit (the one the workflow verified). With
                    --tray: the commit the tray was built from, which the tag must name.
  --skip-verify     Do not run scripts/verify.sh. Only with --expect-sha.
  --output FILE     Write tag=, version= and sha= (the commit to build the tray from) to FILE.
  --tray DIR        Upload the tray packed in DIR (scripts/pack-tray.ps1) to the draft of --tag, read
                    every asset back and publish the release.
  --dry-run         Check everything and print the plan without changing anything.

Steps: preflight (clean main in sync with origin, release notes present, version unused, GitHub's
immutable releases on), full scripts/verify.sh, version and changelog update, release commit and tag
pushed together, the image built from the tag and pushed, then :latest, then the GitHub Release from
the CHANGELOG section as a draft. Then, with --tray, the tray's installer and Velopack feed go on the
draft through `vpk upload github`; the release is published only once every one of them is read back
from GitHub and matches the local files. When the newest tag has no published GitHub Release, an
earlier run stopped halfway: this run finishes that version instead of starting a new one, reusing
what is already published, replacing the tray assets a stopped run left on the draft and refusing
anything that was not built from the tag. Needs docker with buildx, git, jq and gh (logged in to
GitHub and GHCR), and for --tray the .NET SDK (tray/global.json).
EOF
}

git_() { git -C "$REPO_ROOT" "$@"; }

image_ref() { echo "$REGISTRY/$IMAGE:$1"; }

# Reads the version from package.json content on stdin.
version_in() {
  sed -nE 's/^  "version": "([0-9]+\.[0-9]+\.[0-9]+)",$/\1/p' | head -1
}

next_version() {
  local major minor patch
  IFS=. read -r major minor patch <<<"$1"
  case "$BUMP" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
  esac
}

unreleased_notes() {
  awk '/^## \[Unreleased\]/ { on = 1; next } /^## \[/ { on = 0 } on && NF' "$REPO_ROOT/CHANGELOG.md"
}

# Prints the notes of one released version from CHANGELOG content on stdin. Fails unless the
# CHANGELOG has exactly one dated section for it, with at least one entry.
release_notes() {
  local version="$1" text count notes
  text="$(cat)"
  count="$(grep -cE "^## \[${version//./\\.}\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$" <<<"$text" || true)"
  [ "$count" = 1 ] || die "CHANGELOG.md must have exactly one dated section for $version (found $count)"
  notes="$(awk -v head="## [$version] - " '
    index($0, head) == 1 { on = 1; next }
    on && /^## / { exit }
    on { lines[++n] = $0 }
    END {
      s = 1; while (s <= n && lines[s] ~ /^[[:space:]]*$/) s++
      e = n; while (e >= s && lines[e] ~ /^[[:space:]]*$/) e--
      for (i = s; i <= e; i++) print lines[i]
    }' <<<"$text")"
  grep -qvE '^[[:space:]]*(#.*)?$' <<<"$notes" || die "the CHANGELOG.md section for $version has no entries"
  printf '%s\n' "$notes"
}

# Prints "missing", "draft <id>" or "published <id>" for the GitHub Release of a tag, from the list of
# releases (drafts included), so a draft is found by its tag and never made twice. A list that cannot be
# read never counts as missing, and two releases of one tag stop the release for the owner to sort out.
release_state() {
  local tag="$1" out count
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$tag is not a release tag"
  out="$(gh api --paginate "repos/{owner}/{repo}/releases?per_page=100" \
    --jq ".[] | select(.tag_name == \"$tag\") | (if .draft then \"draft\" else \"published\" end) + \" \" + (.id | tostring)" 2>&1)" ||
    die "cannot read the GitHub Releases: $out"
  count="$(grep -c . <<<"$out" || true)"
  case "$count" in
    0) echo missing ;;
    1)
      grep -qxE '(draft|published) [0-9]+' <<<"$out" || die "cannot read the GitHub Release $tag: $out"
      echo "$out"
      ;;
    *) die "there are $count GitHub Releases for $tag; the owner keeps one and deletes the others, then runs the release again" ;;
  esac
}

# Prints "<asset id> <name>" for each asset of a GitHub Release, by its id.
release_assets() {
  local out
  out="$(gh api "repos/{owner}/{repo}/releases/$1" --jq '.assets[] | (.id | tostring) + " " + .name' 2>&1)" ||
    die "cannot read the assets of the GitHub Release $TAG: $out"
  printf '%s\n' "$out"
}

# The tray's assets on a GitHub Release: Velopack's packages and installer (pack id AdiutorSync) and the
# feed files `vpk upload github` writes for the win channel.
is_tray_asset() {
  [[ "$1" == AdiutorSync-* || "$1" == releases.win.json || "$1" == RELEASES ]]
}

# Prints the names of the tray assets among "<asset id> <name>" lines on stdin, sorted.
tray_names() {
  local id name
  while read -r id name; do
    if [ -n "$id" ] && is_tray_asset "$name"; then echo "$name"; fi
  done | sort
}

# Prints the tray assets of a GitHub Release, one name per line, sorted.
tray_assets_of() {
  local assets
  assets="$(release_assets "$1")"
  tray_names <<<"$assets"
}

# Removes the tray assets an earlier, stopped run left on the draft $1 of TAG: a package built again never
# matches them byte for byte, and `vpk upload github` refuses a draft that already holds a feed. Only from
# that draft, checked again before each removal, and only the tray's names.
clear_tray_assets() {
  local draft="$1" assets id name
  assets="$(release_assets "$draft")"
  while read -r id name; do
    if [ -z "$id" ] || ! is_tray_asset "$name"; then continue; fi
    [ "$(release_state "$TAG")" = "draft $draft" ] || die "the GitHub Release $TAG is no longer the draft $draft; nothing more is removed"
    echo "    removing $name, left on the draft by an earlier run"
    gh api -X DELETE "repos/{owner}/{repo}/releases/assets/$id" >/dev/null ||
      die "removing $name from the draft $TAG failed. Run the release again."
  done <<<"$assets"
}

# Prints "on", "off" or "unreadable: <reason>" for GitHub's immutable releases setting of the repository.
immutable_releases() {
  local out
  if out="$(gh api "repos/{owner}/{repo}/immutable-releases" --jq '.enabled' 2>&1)"; then
    case "$out" in
      true) echo on && return ;;
      false) echo off && return ;;
    esac
  fi
  echo "unreadable: $(head -1 <<<"$out")"
}

# The owner turns on GitHub's immutable releases before a release carries the tray (owner's decision
# D-T7), so a published installer and feed, which installed trays update from, can never be replaced. A
# real release stops while they are off or cannot be read; a dry run says so and goes on.
require_immutable() {
  local state message
  state="$(immutable_releases)"
  case "$state" in
    on)
      echo "    GitHub's immutable releases: on"
      return
      ;;
    off) message="GitHub's immutable releases are off for this repository" ;;
    *) message="cannot read whether GitHub's immutable releases are on (${state#unreadable: })" ;;
  esac
  message="$message. A release carries the tray app, which installs its updates from the published release, so the owner turns them on first: the repository's Settings, Releases, Enable release immutability."
  if [ $DRY_RUN -eq 1 ]; then
    echo "    $message A real release stops here."
  else
    die "$message Nothing was published."
  fi
}

# Prints "missing", "match" (built from the given commit) or "other" for an image tag. A registry
# that cannot be read stops the release: it must never count as a free version.
image_state() {
  local ref="$1" revision="$2" out
  if ! out="$(docker buildx imagetools inspect "$ref" --format '{{json .Image}}' 2>&1)"; then
    if grep -qiE "not found|manifest unknown" <<<"$out"; then
      echo missing
      return
    fi
    die "cannot read $ref from the registry: $out"
  fi
  # The JSON comes indented; compare without white space.
  if grep -qF "\"org.opencontainers.image.revision\":\"$revision\"" <<<"$(tr -d '[:space:]' <<<"$out")"; then
    echo match
  else
    echo other
  fi
}

newest_tag() {
  git_ tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1
}

preflight() {
  info "Preflight"
  require_docker
  command -v gh >/dev/null 2>&1 || die "gh (the GitHub CLI) is required"
  [ "$(git_ rev-parse --abbrev-ref HEAD)" = main ] || die "releases are made from main"
  [ -z "$(git_ status --porcelain)" ] || die "the working tree is not clean"
  git_ fetch --quiet --tags origin main
  local head
  head="$(git_ rev-parse HEAD)"
  [ "$head" = "$(git_ rev-parse origin/main)" ] || die "main is not in sync with origin/main"
  if [ -n "$EXPECT_SHA" ] && [ "$head" != "$EXPECT_SHA" ]; then
    die "main is at $head, not at the verified $EXPECT_SHA: something was pushed meanwhile. Start a new release run."
  fi
  require_immutable

  # A version is finished once its GitHub Release is published, which happens only after the tray's
  # assets are all on it and read back. Releases from before the tray carry none and are finished too.
  local newest state
  newest="$(newest_tag)"
  if [ -n "$newest" ]; then
    state="$(release_state "$newest")"
    if [ "${state%% *}" != published ]; then
      RESUME=1 TAG="$newest" VERSION="${newest#v}"
      git_ merge-base --is-ancestor "$TAG" HEAD || die "$TAG is not on main"
      [ "$(git_ show "$TAG:package.json" | version_in)" = "$VERSION" ] || die "package.json at $TAG is not $VERSION"
      echo "    $TAG was not finished: this run finishes it and ignores --bump $BUMP. Run again for the next version."
      if [ "${state%% *}" = draft ]; then
        echo "    its draft GitHub Release holds $(tray_assets_of "${state#* }" | grep -c . || true) tray asset(s); the tray is uploaded again"
      fi
      return
    fi
  fi

  [ -n "$(unreleased_notes)" ] || die "CHANGELOG.md has no entries under [Unreleased]"
  local current
  current="$(version_in <"$REPO_ROOT/package.json")"
  [ -n "$current" ] || die "cannot read the version from package.json"
  VERSION="$(next_version "$current")"
  TAG="v$VERSION"
  # Tags are immutable: an existing tag (origin's were fetched above) is never moved or reused.
  git_ rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists"
  state="$(image_state "$(image_ref "$VERSION")" none)"
  [ "$state" = missing ] || die "$(image_ref "$VERSION") is already published"
  echo "    $current -> $VERSION ($TAG)"
}

create_tag() {
  if [ $SKIP_VERIFY -eq 0 ]; then
    info "Full verification"
    "$REPO_ROOT/scripts/verify.sh"
  fi
  info "Updating version and changelog"
  sed -i -E "0,/^  \"version\": \"[0-9.]+\",$/s//  \"version\": \"$VERSION\",/" "$REPO_ROOT/package.json"
  sed -i "s/^## \[Unreleased\]$/## [Unreleased]\n\n## [$VERSION] - $(date -u +%Y-%m-%d)/" "$REPO_ROOT/CHANGELOG.md"
  release_notes "$VERSION" <"$REPO_ROOT/CHANGELOG.md" >/dev/null
  git_ add package.json CHANGELOG.md
  git_ commit --quiet -m "Release $TAG"
  git_ tag -a "$TAG" -m "$TAG"
  info "Pushing the release commit and $TAG"
  # Both or neither: a tag on origin is what a later run finishes. Never forced.
  git_ push --quiet --atomic origin HEAD:refs/heads/main "refs/tags/$TAG" ||
    die "pushing the release commit and $TAG failed, so nothing was published. Run the release again."
}

publish_image() {
  local revision src ref state
  revision="$(git_ rev-parse "$TAG^{commit}")"
  ref="$(image_ref "$VERSION")"
  src="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand now: the path is fixed
  trap "rm -rf '$src'" EXIT
  git_ archive "$TAG" | tar -x -C "$src"
  state="$(image_state "$ref" "$revision")"
  case "$state" in
    match) echo "    $ref is already published from $TAG" ;;
    other) die "$ref exists but was not built from $TAG; it is left as it is" ;;
    missing)
      info "Building and pushing $ref"
      docker buildx build --push --provenance=mode=max --sbom=true \
        -f "$src/docker/$DOCKERFILE.Dockerfile" --build-arg "VERSION=$VERSION" \
        --label "org.opencontainers.image.revision=$revision" \
        --label "org.opencontainers.image.source=$SOURCE_URL" \
        --label "org.opencontainers.image.version=$VERSION" \
        -t "$ref" "$src" || die "building or pushing $ref failed. Run the release again to finish $TAG."
      ;;
  esac
  state="$(image_state "$ref" "$revision")"
  [ "$state" = match ] || die "$ref is not the image built from $TAG"
  # :latest moves only once the version's image is there.
  info "Pointing $(image_ref latest) at $VERSION"
  docker buildx imagetools create --tag "$(image_ref latest)" "$ref" ||
    die "moving $(image_ref latest) failed. Run the release again to finish $TAG."
}

# The GitHub Release of TAG as a draft, from the CHANGELOG section: published by the --tray step once the
# tray is on it. A draft left by a stopped run is kept, without the tray assets it may hold.
create_draft() {
  local notes state
  state="$(release_state "$TAG")"
  case "$state" in
    draft*)
      echo "    the draft GitHub Release $TAG exists"
      clear_tray_assets "${state#* }"
      return
      ;;
    published*) die "the GitHub Release $TAG is published already" ;;
  esac
  notes="$(mktemp)"
  git_ show "$TAG:CHANGELOG.md" | release_notes "$VERSION" >"$notes"
  info "Creating the GitHub Release $TAG as a draft"
  if ! gh release create "$TAG" --verify-tag --draft --title "Adiutor $VERSION" --notes-file "$notes"; then
    # The request may have succeeded with its answer lost.
    state="$(release_state "$TAG")"
    [ "${state%% *}" = draft ] || die "creating the GitHub Release $TAG failed. Run the release again to finish it."
    echo "    the draft GitHub Release $TAG exists"
  fi
  rm -f "$notes"
}

# Writes the version and the commit to build the tray from: the tag's commit, or in a dry run of a new
# version the verified commit the release commit would follow.
write_output() {
  local sha
  [ -n "$OUTPUT" ] || return 0
  if git_ rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    sha="$(git_ rev-parse "$TAG^{commit}")"
  else
    sha="$(git_ rev-parse HEAD)"
  fi
  printf 'tag=%s\nversion=%s\nsha=%s\n' "$TAG" "$VERSION" "$sha" >"$OUTPUT"
}

# --- the tray (--tray) ----------------------------------------------------------------------------

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
sha1_of() { sha1sum "$1" | cut -d' ' -f1; }
size_of() { wc -c <"$1" | tr -d ' '; }

# The package type Velopack gives a package file: Full or Delta.
package_type() {
  case "$1" in
    *-full.nupkg) echo Full ;;
    *-delta.nupkg) echo Delta ;;
  esac
}

# Reads the tray's build from TRAY_DIR (scripts/pack-tray.ps1 for VERSION) into TRAY_FILES and checks it
# is whole: the installer and the full package of VERSION, every file present and named as the tray's,
# and each package listed with the type its name gives.
read_tray_build() {
  local list file type
  [ -f "$TRAY_DIR/assets.win.json" ] || die "$TRAY_DIR has no assets.win.json: pack the tray first (scripts/pack-tray.ps1)"
  list="$(jq -r '.[] | .RelativeFileName + " " + .Type' "$TRAY_DIR/assets.win.json")" || die "cannot read $TRAY_DIR/assets.win.json"
  TRAY_FILES=()
  while read -r file type; do
    TRAY_FILES+=("$file")
    [[ "$file" =~ ^AdiutorSync-[A-Za-z0-9.-]+$ ]] || die "the tray build names an unexpected file: $file"
    [[ "$file" != *.nupkg || "$file" =~ ^AdiutorSync-${VERSION//./\\.}-(full|delta)\.nupkg$ ]] ||
      die "the tray build holds $file, a package of another version than $VERSION"
    [[ "$file" != *.nupkg || "$type" = "$(package_type "$file")" ]] || die "the tray build lists $file as $type"
    [ -f "$TRAY_DIR/$file" ] || die "the tray build lists $file, which is not in $TRAY_DIR"
  done <<<"$list"
  for file in "AdiutorSync-$VERSION-full.nupkg" AdiutorSync-win-Setup.exe; do
    [[ " ${TRAY_FILES[*]} " == *" $file "* ]] || die "the tray build has no $file"
  done
}

# The tray assets the draft must hold: the build's files and the two feed files vpk writes.
expected_tray_assets() {
  printf '%s\n' "${TRAY_FILES[@]}" releases.win.json RELEASES | sort
}

# Reads every tray asset of the draft back from GitHub. The build's files must match the local ones by
# SHA-256. vpk writes the feed files at upload, so there is no local copy: releases.win.json must list
# exactly the build's packages of VERSION with their types, real SHA-256 and size, and RELEASES (Velopack's
# older feed, which vpk 1.2.161 writes as UTF-8 with a byte order mark and only the full package) only
# those packages, with their real SHA-1 and size, the full one included.
verify_tray_assets() {
  local draft="$1" assets got dir id name file want have line
  assets="$(release_assets "$draft")"
  got="$(tray_names <<<"$assets")"
  [ "$got" = "$(expected_tray_assets)" ] ||
    die "the draft $TAG holds the tray assets [$(tr '\n' ' ' <<<"$got")], not [$(expected_tray_assets | tr '\n' ' ')]. Run the release again."
  dir="$(mktemp -d)"
  while read -r id name; do
    if [ -z "$id" ] || ! is_tray_asset "$name"; then continue; fi
    gh api -H "Accept: application/octet-stream" "repos/{owner}/{repo}/releases/assets/$id" >"$dir/$name" ||
      die "reading $name back from the draft $TAG failed. Run the release again."
  done <<<"$assets"
  for file in "${TRAY_FILES[@]}"; do
    [ "$(sha256_of "$dir/$file")" = "$(sha256_of "$TRAY_DIR/$file")" ] ||
      die "$file on the draft $TAG does not match the local file. Run the release again."
  done
  want="$(for file in "${TRAY_FILES[@]}"; do
    if [[ "$file" == *.nupkg ]]; then
      echo "AdiutorSync $VERSION $(package_type "$file") $file $(sha256_of "$TRAY_DIR/$file" | tr a-f A-F) $(size_of "$TRAY_DIR/$file")"
    fi
  done | sort)"
  have="$(jq -r '.Assets[] | "\(.PackageId) \(.Version) \(.Type) \(.FileName) \(.SHA256 | ascii_upcase) \(.Size)"' "$dir/releases.win.json" | sort)" ||
    die "releases.win.json on the draft $TAG cannot be read"
  [ "$have" = "$want" ] || die "releases.win.json on the draft $TAG does not list the local packages. Run the release again."
  want="$(for file in "${TRAY_FILES[@]}"; do
    if [[ "$file" == *.nupkg ]]; then
      echo "$(sha1_of "$TRAY_DIR/$file" | tr a-f A-F) $file $(size_of "$TRAY_DIR/$file")"
    fi
  done)"
  have="$(LC_ALL=C sed $'1s/^\xef\xbb\xbf//' "$dir/RELEASES" | tr -d '\r' | awk 'NF { print toupper($1), $2, $3 }')"
  file="AdiutorSync-$VERSION-full.nupkg"
  grep -qxF "$(sha1_of "$TRAY_DIR/$file" | tr a-f A-F) $file $(size_of "$TRAY_DIR/$file")" <<<"$have" ||
    die "RELEASES on the draft $TAG does not list the full package. Run the release again."
  while IFS= read -r line; do
    grep -qxF "$line" <<<"$want" ||
      die "RELEASES on the draft $TAG lists $line, which is not a local package. Run the release again."
  done <<<"$have"
  rm -rf "$dir"
  echo "    $(expected_tray_assets | grep -c .) tray assets on the draft match the local files"
}

tray_release() {
  local state draft repo
  [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--tag must be a release tag such as v1.2.3"
  [ -n "$EXPECT_SHA" ] || die "--tray needs --expect-sha of the commit the tray was built from"
  VERSION="${TAG#v}"
  for tool in gh jq sha256sum sha1sum; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
  done
  info "The tray of $TAG"
  read_tray_build
  require_immutable
  git_ fetch --quiet --tags origin
  if git_ rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    [ "$(git_ rev-parse "$TAG^{commit}")" = "$EXPECT_SHA" ] ||
      die "$TAG is at $(git_ rev-parse "$TAG^{commit}"), not at $EXPECT_SHA, which the tray was built from"
  elif [ $DRY_RUN -eq 0 ]; then
    die "$TAG does not exist. Run the release again."
  fi

  if [ $DRY_RUN -eq 1 ]; then
    info "Dry run. Would upload to the draft GitHub Release $TAG and publish it once each is read back:"
    expected_tray_assets | sed 's/^/    /'
    return 0
  fi

  state="$(release_state "$TAG")"
  case "$state" in
    missing) die "$TAG has no GitHub Release. Run the release again." ;;
    published*)
      [ "$(tray_assets_of "${state#* }")" = "$(expected_tray_assets)" ] ||
        die "the GitHub Release $TAG is published without the tray's assets of this build, and a published release is not changed"
      echo "    the GitHub Release $TAG is published with the tray"
      return 0
      ;;
  esac
  draft="${state#* }"
  clear_tray_assets "$draft"

  repo="$(gh api "repos/{owner}/{repo}" --jq .full_name)" || die "cannot read the repository's name"
  info "Uploading the tray to the draft $TAG"
  # vpk's documented GitHub upload into the existing draft (--merge, never --publish): the build's files,
  # then the feed files it writes. The token reaches vpk through its environment, not its arguments.
  (cd "$REPO_ROOT/tray" && dotnet tool restore >/dev/null &&
    VPK_TOKEN="${GH_TOKEN:-$(gh auth token)}" dotnet vpk "[win]" upload github --outputDir "$TRAY_DIR" --channel win \
      --repoUrl "https://github.com/$repo" --tag "$TAG" --merge) ||
    die "uploading the tray to the draft $TAG failed. Run the release again: it replaces what was uploaded."
  [ "$(release_state "$TAG")" = "draft $draft" ] || die "after the upload, $TAG is not the one draft $draft. Nothing was published."

  verify_tray_assets "$draft"

  info "Publishing the GitHub Release $TAG"
  if ! gh api -X PATCH "repos/{owner}/{repo}/releases/$draft" -F draft=false >/dev/null; then
    # The request may have succeeded with its answer lost.
    [ "$(release_state "$TAG")" = "published $draft" ] || die "publishing the GitHub Release $TAG failed. Run the release again to finish it."
  fi
  [ "$(release_state "$TAG")" = "published $draft" ] || die "the GitHub Release $TAG is not published"
  # The one sign of the setting this job's token can read: the published release itself. Read a few times,
  # in case GitHub marks it a moment after the publish.
  local tries=0
  until [ "$(gh api "repos/{owner}/{repo}/releases/$draft" --jq .immutable)" = true ]; do
    tries=$((tries + 1))
    [ $tries -lt 3 ] ||
      die "the GitHub Release $TAG is published, but GitHub did not make it immutable: turn on immutable releases (the repository's Settings, Releases, Enable release immutability)"
    sleep 5
  done
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --target)
        TARGET="${2:-}"
        shift
        ;;
      --bump)
        BUMP="${2:-}"
        shift
        ;;
      --expect-sha)
        EXPECT_SHA="${2:-}"
        shift
        ;;
      --skip-verify) SKIP_VERIFY=1 ;;
      --output)
        OUTPUT="${2:-}"
        shift
        ;;
      --tray)
        TRAY_DIR="${2:-}"
        shift
        ;;
      --tag)
        TAG="${2:-}"
        shift
        ;;
      --dry-run) DRY_RUN=1 ;;
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

  [ -z "$EXPECT_SHA" ] || [[ "$EXPECT_SHA" =~ ^[0-9a-f]{40}$ ]] || die "--expect-sha must be a full commit SHA"
  if [ -n "$TRAY_DIR" ]; then
    # Absolute, since vpk runs from tray/: it must read the folder read_tray_build checked.
    TRAY_DIR="$(cd "$TRAY_DIR" && pwd)" || die "--tray needs the folder of a packed tray"
    if [ -n "$TARGET$BUMP$OUTPUT" ] || [ $SKIP_VERIFY -eq 1 ]; then
      die "--tray takes only --tag, --expect-sha and --dry-run"
    fi
    tray_release
    [ $DRY_RUN -eq 1 ] || info "Released $TAG with the tray. Deploying is a separate step: see docs/deployment.md."
    return 0
  fi
  [ -z "$TAG" ] || die "--tag goes only with --tray"
  [ "$TARGET" = ghcr ] || die "an explicit target is required: --target ghcr"
  [[ "$BUMP" =~ ^(patch|minor|major)$ ]] || die "--bump must be patch, minor or major"
  [ $SKIP_VERIFY -eq 0 ] || [ -n "$EXPECT_SHA" ] || die "--skip-verify needs --expect-sha of the verified commit"

  preflight
  if [ $DRY_RUN -eq 1 ]; then
    if [ $RESUME -eq 1 ]; then
      info "Dry run. Would finish $TAG: the image if missing, :latest, the draft GitHub Release and the tray."
    else
      info "Dry run. Release notes for $TAG:"
      unreleased_notes | sed 's/^/    /'
      info "Would commit package.json and CHANGELOG.md, push them with $TAG, then publish:"
    fi
    echo "    $(image_ref "$VERSION") and :latest"
    write_output
    return 0
  fi

  [ $RESUME -eq 1 ] || create_tag
  publish_image
  create_draft
  write_output
  info "The image is published and the GitHub Release $TAG is a draft. Next: the tray, packed from $TAG on Windows (scripts/pack-tray.ps1), with scripts/release.sh --tray <dir> --tag $TAG --expect-sha <its commit>, which publishes the release."
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
