#!/usr/bin/env bash
# Tests the wiring of .github/workflows/release.yml: which jobs and steps run on the two CI paths (a
# reused green CI run, or the CI run by the release) with and without dry_run, the tray's jobs after the
# Release job, what the Release step passes to scripts/release.sh and hands on, and what the tray's
# publish step passes to it. The job and step conditions are read from the file and evaluated with Node
# against each case; the steps' scripts run with stand-ins for git, docker and release.sh. Run with the
# guards (scripts/lib/guards.sh).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$REPO/.github/workflows/release.yml"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/adiutor-release-workflow-test.XXXXXX")"
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

# --- the parts of the workflow ---------------------------------------------------------------

# Writes the conditions and the steps' scripts to $WORK: verify-if, release-if, recheck-if,
# release-step-if (empty when the step has none), release-run, the tray jobs' conditions (engine-if,
# build-if, publish-if, without ${{ }}), publish-run, and each tray job's lines (job-<name>). Fails when
# a part is missing.
node - "$WORKFLOW" "$WORK" <<'EOF' || {
const fs = require("node:fs")
const [file, out] = process.argv.slice(2)
const lines = fs.readFileSync(file, "utf8").split("\n")
const fail = (what) => { console.error("release.yml: " + what); process.exit(1) }
const block = (start, isEnd) => {
  const i = lines.findIndex((l) => l === start)
  if (i < 0) fail("no line " + JSON.stringify(start))
  let j = i + 1
  while (j < lines.length && !isEnd(lines[j])) j++
  return lines.slice(i + 1, j)
}
const job = (name) => block("  " + name + ":", (l) => /^  \S/.test(l))
const step = (jobLines, name) => {
  const i = jobLines.findIndex((l) => l === "      - name: " + name)
  if (i < 0) fail("no step " + name)
  let j = i + 1
  while (j < jobLines.length && !/^      - /.test(jobLines[j])) j++
  return jobLines.slice(i + 1, j)
}
const plainIf = (part) => (part.find((l) => /^ *if: /.test(l)) || "").replace(/^ *if: /, "")
const wrappedIf = (part) => {
  const value = plainIf(part)
  const m = /^\$\{\{ (.*) \}\}$/.exec(value)
  if (!m) fail("expected an if: ${{ ... }}, got " + JSON.stringify(value))
  return m[1]
}
const runBlock = (stepLines, what) => {
  const r = stepLines.findIndex((l) => l === "        run: |")
  if (r < 0) fail(what + " has no run block")
  const run = []
  for (let j = r + 1; j < stepLines.length && (stepLines[j] === "" || /^          /.test(stepLines[j])); j++)
    run.push(stepLines[j].slice(10))
  return run.join("\n") + "\n"
}
const jobIf = (lines) => wrappedIf(lines.filter((l) => /^    \S/.test(l)))
const foldedIf = (part) => {
  const i = part.findIndex((l) => l === "    if: >-")
  if (i < 0) fail("the release job has no folded if")
  const folded = []
  for (let j = i + 1; j < part.length && /^      \S/.test(part[j]); j++) folded.push(part[j].trim())
  return folded.join(" ")
}
const release = job("release")
const verifyIf = plainIf(job("verify").filter((l) => /^    \S/.test(l)))
const recheck = step(release, "Check the reused CI run again")
const releaseStep = step(release, "Release")
const engine = job("tray-engine")
const build = job("tray-build")
const publish = job("tray-publish")
fs.writeFileSync(out + "/verify-if", verifyIf)
fs.writeFileSync(out + "/engine-if", jobIf(engine))
fs.writeFileSync(out + "/build-if", jobIf(build))
fs.writeFileSync(out + "/publish-if", jobIf(publish))
fs.writeFileSync(out + "/publish-run", runBlock(step(publish, "Upload and publish"), "the Upload and publish step"))
for (const [name, lines] of [["release", release], ["tray-engine", engine], ["tray-build", build], ["tray-publish", publish]])
  fs.writeFileSync(out + "/job-" + name, lines.join("\n") + "\n")
fs.writeFileSync(out + "/release-if", foldedIf(release))
fs.writeFileSync(out + "/recheck-if", plainIf(recheck))
fs.writeFileSync(out + "/release-step-if", plainIf(releaseStep))
fs.writeFileSync(out + "/release-run", runBlock(releaseStep, "the Release step"))
EOF
  echo "release-workflow: cannot read the parts of release.yml"
  exit 1
}

# Evaluates a condition for one case: evaluate KIND EXPR FIND_RESULT REUSE VERIFY_RESULT DRY_RUN
# [CANCELLED] [REF], with KIND job or step. The tray jobs' needs come from RELEASE, ENGINE and BUILD
# (each success unless set). Exits 0 when it holds, 1 when it does not and 2 on an expression with
# names or operators these conditions do not use. A job condition without a status function gets
# GitHub's implicit success() of the jobs it needs; for a step, the earlier steps of its job are taken
# to have succeeded.
evaluate() {
  node - "$@" <<'EOF'
const [kind, rawExpr, find, reuse, verify, dryRun, cancelled = "false", ref = "refs/heads/main"] = process.argv.slice(2)
if (!/^[A-Za-z0-9_.'()!&|=/ -]*$/.test(rawExpr) || rawExpr.trim() === "") {
  console.error("unexpected expression: " + rawExpr)
  process.exit(2)
}
// A job id with a hyphen (needs.tray-engine) is a property name in GitHub's expressions, not a subtraction.
const expr = rawExpr.replace(/needs\.([a-z][a-z-]*)/g, (_, id) => 'needs["' + id + '"]')
const env = process.env
const needs = {
  find: { result: find, outputs: { reuse, "run-id": "100" } },
  verify: { result: verify },
  release: { result: env.RELEASE || "success" },
  "tray-engine": { result: env.ENGINE || "success" },
  "tray-build": { result: env.BUILD || "success" },
}
const github = { ref }
const inputs = { dry_run: dryRun === "true", bump: "patch" }
const isCancelled = () => cancelled === "true"
const success = () => !isCancelled() && (kind === "step" || Object.values(needs).every((n) => n.result === "success"))
const statusFn = /\b(success|failure|always|cancelled)\(/.test(expr)
const value = new Function("needs", "github", "inputs", "cancelled", "success", "return " + expr)(
  needs, github, inputs, isCancelled, success)
process.exit((statusFn ? value : success() && value) ? 0 : 1)
EOF
}
runs() { evaluate "$@"; }
skips() {
  evaluate "$@"
  [ $? -eq 1 ]
}

VERIFY_IF="$(cat "$WORK/verify-if")"
RELEASE_IF="$(cat "$WORK/release-if")"
RECHECK_IF="$(cat "$WORK/recheck-if")"
ENGINE_IF="$(cat "$WORK/engine-if")"
BUILD_IF="$(cat "$WORK/build-if")"
PUBLISH_IF="$(cat "$WORK/publish-if")"

# --- the two paths, with and without a dry run -----------------------------------------------

# The verify job needs only find, so its own result is given as success.
for dry in false true; do
  check "reused CI (dry_run=$dry): verify is skipped" skips job "$VERIFY_IF" success true success "$dry"
  check "reused CI (dry_run=$dry): the release job runs" runs job "$RELEASE_IF" success true skipped "$dry"
  check "reused CI (dry_run=$dry): the reused run is checked again" runs step "$RECHECK_IF" success true skipped "$dry"
  check "fresh CI (dry_run=$dry): verify runs" runs job "$VERIFY_IF" success false success "$dry"
  check "fresh CI (dry_run=$dry): the release job runs after it" runs job "$RELEASE_IF" success false success "$dry"
  check "fresh CI (dry_run=$dry): no check of a reused run" skips step "$RECHECK_IF" success false success "$dry"
done
check "the Release step runs whenever its job runs" [ -z "$(cat "$WORK/release-step-if")" ]

# --- what stops the release job --------------------------------------------------------------

for verify in failure cancelled skipped; do
  check "fresh CI, verify $verify: no release" skips job "$RELEASE_IF" success false "$verify" false
done
check "reused CI, verify ran anyway: no release" skips job "$RELEASE_IF" success true success false
for find in failure cancelled skipped; do
  check "find $find: no release" skips job "$RELEASE_IF" "$find" false skipped false
  check "find $find: no verify" skips job "$VERIFY_IF" "$find" false success false
done
check "find gave no result: no release" skips job "$RELEASE_IF" success "" skipped false
check "find gave no result: no verify" skips job "$VERIFY_IF" success "" success false
check "the run was cancelled: no release" skips job "$RELEASE_IF" success true skipped false true
check "not on main: no release" skips job "$RELEASE_IF" success true skipped false false refs/heads/other
check "not on main: no verify" skips job "$VERIFY_IF" success false success false false refs/heads/other

# --- the tray's jobs after the Release job ---------------------------------------------------

# The tray's jobs need only the Release job and each other: find and verify are given as they were on
# the path to a release that ran.
for dry in false true; do
  for path in "true skipped" "false success"; do
    read -r reuse verify <<<"$path"
    check "reuse=$reuse (dry_run=$dry): the engine bundle is built after the release" runs job "$ENGINE_IF" success "$reuse" "$verify" "$dry"
    check "reuse=$reuse (dry_run=$dry): the tray is packed after the bundle" runs job "$BUILD_IF" success "$reuse" "$verify" "$dry"
    check "reuse=$reuse (dry_run=$dry): the tray is uploaded and published after it" runs job "$PUBLISH_IF" success "$reuse" "$verify" "$dry"
  done
done
# skips_after NEED RESULT IF: the job of IF is skipped when its need NEED (RELEASE, ENGINE or BUILD) ended so.
skips_after() {
  local need="$1" result="$2" expr="$3"
  (export "$need=$result" && skips job "$expr" success true skipped false)
}
for result in failure cancelled skipped; do
  check "release $result: no engine bundle" skips_after RELEASE "$result" "$ENGINE_IF"
  check "release $result: no tray package" skips_after RELEASE "$result" "$BUILD_IF"
  check "release $result: nothing published" skips_after RELEASE "$result" "$PUBLISH_IF"
  check "engine bundle $result: no tray package" skips_after ENGINE "$result" "$BUILD_IF"
  check "tray package $result: nothing published" skips_after BUILD "$result" "$PUBLISH_IF"
done
for job in engine build publish; do
  check "the run was cancelled: no tray $job job" skips job "$(cat "$WORK/$job-if")" success true skipped false true
done

# Each tray job builds from, and publishes, the commit and version the Release job names, never derived
# again; its checkout keeps no token; and it has only the permissions it needs.
job_has() { grep -qxF "$2" "$WORK/job-$1"; }
job_lacks() { ! grep -qE "$2" "$WORK/job-$1"; }
job_permissions() {
  awk '/^    permissions:$/ { on = 1; next } on && /^      / { print; next } { on = 0 }' "$WORK/job-$1" | tr -d ' ' | tr '\n' ' '
}
# Every action is pinned to a full commit SHA, with its version beside it.
all_pinned() { ! grep -E '^ *(- )?uses: ' "$WORKFLOW" | grep -vE 'uses: (\./|[^@ ]+@[0-9a-f]{40} # v[0-9.]+$)'; }
# The workflow's own ${{ }} expressions, compared as text.
# shellcheck disable=SC2016
{
  for name in tray-engine tray-build tray-publish; do
    check "$name checks out the Release job's commit" job_has "$name" '          ref: ${{ needs.release.outputs.sha }}'
    check "$name keeps no token in its checkout" job_has "$name" '          persist-credentials: false'
  done
  check "tray-build packs the Release job's version" job_has tray-build '          VERSION: ${{ needs.release.outputs.version }}'
  check "tray-publish uploads to the Release job's tag" job_has tray-publish '          TAG: ${{ needs.release.outputs.tag }}'
  check "the Release job hands on the tag" job_has release '      tag: ${{ steps.release.outputs.tag }}'
  check "  the version" job_has release '      version: ${{ steps.release.outputs.version }}'
  check "  and the commit" job_has release '      sha: ${{ steps.release.outputs.sha }}'
}
check "tray-engine may only read" [ "$(job_permissions tray-engine)" = "contents:read " ]
check "tray-build may only read" [ "$(job_permissions tray-build)" = "contents:read " ]
check "tray-publish may only write contents" [ "$(job_permissions tray-publish)" = "contents:write " ]
check "tray-engine gives no token to its steps" job_lacks tray-engine 'github\.token|secrets\.'
check "tray-build gives no token to its steps" job_lacks tray-build 'github\.token|secrets\.'
check "every action is pinned to a full commit SHA" all_pinned

# --- what the Release step passes to release.sh ----------------------------------------------

mkdir -p "$WORK/bin" "$WORK/repo/scripts"
cat >"$WORK/bin/git" <<'EOF'
#!/usr/bin/env bash
echo "git $*" >>"$CALLS"
EOF
cat >"$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
echo "docker $*" >>"$CALLS"
EOF
cat >"$WORK/repo/scripts/release.sh" <<'EOF'
#!/usr/bin/env bash
# Writes the version and the commit to --output as release.sh does, unless NO_RESULT is set.
echo "release.sh $*" >>"$CALLS"
while [ $# -gt 0 ]; do
  if [ "$1" = --output ] && [ -z "${NO_RESULT:-}" ]; then
    printf 'tag=v1.2.3\nversion=1.2.3\nsha=%s\n' 2222222222222222222222222222222222222222 >"$2"
  fi
  shift
done
EOF
chmod +x "$WORK/bin/git" "$WORK/bin/docker" "$WORK/repo/scripts/release.sh"
SHA="1111111111111111111111111111111111111111"
export SHA

TOKEN="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"

# Runs a step's script (release or publish) as GitHub runs a bash step; sets RC.
run_step() {
  export CALLS="$WORK/calls"
  : >"$CALLS"
  rm -rf "$WORK/runner" && mkdir -p "$WORK/runner"
  : >"$WORK/runner/output"
  (cd "$WORK/repo" && PATH="$WORK/bin:$PATH" BUMP=minor DRY_RUN="$2" VERIFIED_SHA="$SHA" GH_TOKEN="$TOKEN" \
    GITHUB_ACTOR=actor GH_REPO=owner/repo RUNNER_TEMP="$WORK/runner" GITHUB_OUTPUT="$WORK/runner/output" \
    TAG=v1.2.3 bash --noprofile --norc -eo pipefail "$WORK/$1-run") >/dev/null 2>&1
  RC=$?
}
release_step() { run_step release "$1"; }
called() { grep -qxF "$1" "$CALLS"; }

release_step true
check "dry_run=true: the step succeeds" [ $RC -eq 0 ]
check "  and passes --dry-run" called "release.sh --target ghcr --bump minor --skip-verify --expect-sha $SHA --output $WORK/runner/release-result --dry-run"
check "  and hands on the tag, the version and the commit" \
  [ "$(cat "$WORK/runner/output")" = "$(printf 'tag=v1.2.3\nversion=1.2.3\nsha=2222222222222222222222222222222222222222')" ]

release_step false
check "dry_run=false: the step succeeds" [ $RC -eq 0 ]
check "  and releases without --dry-run" called "release.sh --target ghcr --bump minor --skip-verify --expect-sha $SHA --output $WORK/runner/release-result"
check "  after logging in to GHCR" called "docker login ghcr.io --username actor --password-stdin"
check "  and hands on the tag, the version and the commit" grep -qxF "sha=2222222222222222222222222222222222222222" "$WORK/runner/output"

NO_RESULT=1 release_step false
check "release.sh names no version: the step fails" [ $RC -ne 0 ]
check "  and hands on nothing" [ ! -s "$WORK/runner/output" ]

# --- what the tray's publish step passes to release.sh ---------------------------------------

run_step publish true
check "publish, dry_run=true: the step succeeds" [ $RC -eq 0 ]
check "  and passes the tray, the tag, the commit and --dry-run" called "release.sh --tray $WORK/runner/tray-release --tag v1.2.3 --expect-sha $SHA --dry-run"

run_step publish false
check "publish, dry_run=false: the step succeeds" [ $RC -eq 0 ]
check "  and publishes without --dry-run" called "release.sh --tray $WORK/runner/tray-release --tag v1.2.3 --expect-sha $SHA"

echo "release-workflow: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
