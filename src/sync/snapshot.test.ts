import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { mapFamily, readLatestSnapshot, securityReports } from "./snapshot.ts"

const overviewDir = fileURLToPath(new URL("./fixtures/overview", import.meta.url))
const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function copyOverview(): string {
  const dir = mkdtempSync(join(tmpdir(), "mikud-sync-"))
  temps.push(dir)
  cpSync(overviewDir, dir, { recursive: true })
  return dir
}

describe("readLatestSnapshot", () => {
  it("reads the run named in latest-run.txt", async () => {
    const snapshot = await readLatestSnapshot(overviewDir)
    expect(snapshot.runId).toBe("20261101T060000Z")
    expect(snapshot.finishedAt).toBe("2026-11-01T06:05:00.000Z")
    expect(snapshot.github.size).toBe(4)
    expect(snapshot.local).toHaveLength(3)
  })

  it("falls back to the newest readable run when latest-run.txt is missing or names a bad run", async () => {
    const dir = copyOverview()
    rmSync(join(dir, "data", "latest-run.txt"))
    expect((await readLatestSnapshot(dir)).runId).toBe("20261101T060000Z")

    writeFileSync(join(dir, "data", "latest-run.txt"), "../../outside\n")
    writeFileSync(join(dir, "data", "runs", "20261101T060000Z", "snapshot.json"), "{ broken")
    expect((await readLatestSnapshot(dir)).runId).toBe("20261031T060000Z")
  })

  it("fails when there is no snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mikud-sync-"))
    temps.push(dir)
    await expect(readLatestSnapshot(dir)).rejects.toThrow("no overview snapshot found")
  })
})

describe("securityReports", () => {
  it("maps every family honestly", async () => {
    const snapshot = await readLatestSnapshot(overviewDir)
    const { reports, missing } = securityReports(snapshot, ["acme/widget", "acme/gadget", "acme/gizmo", "acme/missing"])
    expect(missing).toEqual(["acme/missing"])
    const byRepo = Object.fromEntries(reports.map((r) => [r.repo, r]))

    // Enabled families count by severity; rule levels are counted, never dropped.
    expect(byRepo["acme/widget"]).toEqual({
      repo: "acme/widget",
      openIssues: 4,
      issuesAsOf: "2026-11-01T06:02:00.000Z",
      families: [
        {
          family: "dependabot",
          coverage: "enabled",
          counts: { critical: 1, high: 2, medium: 1, low: 1 },
          asOf: "2026-11-01T06:02:01.000Z",
        },
        {
          family: "code_scanning",
          coverage: "enabled",
          counts: { critical: 0, high: 0, medium: 2, low: 2 },
          asOf: "2026-11-01T06:02:02.000Z",
        },
        {
          family: "secret_scanning",
          coverage: "not_enabled",
          counts: { critical: 0, high: 0, medium: 0, low: 0 },
          asOf: "2026-11-01T06:02:03.000Z",
        },
      ],
    })

    // A repository carried over from an earlier run: every value keeps the time of its last success.
    const gadget = byRepo["acme/gadget"]
    expect(gadget?.openIssues).toBe(2)
    expect(gadget?.issuesAsOf).toBe("2026-10-30T06:02:00.000Z")
    expect(gadget?.families.map((f) => [f.family, f.coverage, f.asOf])).toEqual([
      ["dependabot", "enabled", "2026-10-30T06:02:00.000Z"],
      ["code_scanning", "error", null],
      ["secret_scanning", "no_access", "2026-10-30T06:02:00.000Z"],
    ])
    expect(gadget?.families[0]?.counts.high).toBe(1)

    // A stale family takes stale.since; an unknown status and a missing family are unknown, not zero.
    const gizmo = byRepo["acme/gizmo"]
    expect(gizmo?.openIssues).toBe(0)
    expect(gizmo?.families).toEqual([
      {
        family: "dependabot",
        coverage: "enabled",
        counts: { critical: 1, high: 0, medium: 0, low: 0 },
        asOf: "2026-10-29T06:00:00.000Z",
      },
      { family: "code_scanning", coverage: "unknown", counts: { critical: 0, high: 0, medium: 0, low: 0 }, asOf: null },
      {
        family: "secret_scanning",
        coverage: "unknown",
        counts: { critical: 0, high: 0, medium: 0, low: 0 },
        asOf: null,
      },
    ])
  })

  it("reports a repository without security data as unknown and without an Issues count", async () => {
    const snapshot = await readLatestSnapshot(overviewDir)
    const [archived] = securityReports(snapshot, ["ACME/archived"]).reports
    expect(archived?.repo).toBe("ACME/archived")
    expect(archived?.openIssues).toBeNull()
    expect(archived?.issuesAsOf).toBeNull()
    expect(archived?.families.every((f) => f.coverage === "unknown" && f.asOf === null)).toBe(true)
  })

  it("sends each repository once", async () => {
    const snapshot = await readLatestSnapshot(overviewDir)
    expect(securityReports(snapshot, ["acme/widget", "ACME/Widget"]).reports).toHaveLength(1)
  })
})

describe("mapFamily", () => {
  it("never reports alerts of a family that is not enabled", () => {
    const report = mapFamily("dependabot", { status: "no-access", alerts: [{ severity: "critical" }] }, null)
    expect(report.coverage).toBe("no_access")
    expect(report.counts.critical).toBe(0)
  })
})
