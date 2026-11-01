import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { Runner } from "./exec.ts"
import { listThreads, mapThreads, parseProjectsFile } from "./t3.ts"

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

describe("parseProjectsFile", () => {
  it("keeps usable projects and counts the rest", () => {
    const file = parseProjectsFile(fixture("t3-projects.json"))
    expect(file.collectedAt).toBe("2026-11-01T05:30:00.000Z")
    expect(file.projects.map((p) => p.id)).toEqual(["p-widget", "mcp:p-gadget", "p-gizmo", "p-notes", "p-missing"])
    // Deleted, an id with shell characters, and no id.
    expect(file.skipped).toBe(3)
    expect(file.projects[0]).toEqual({
      id: "p-widget",
      title: "Widget",
      workspaceRoot: "C:\\Work\\Widget",
      repositoryIdentity: { provider: "github", owner: "acme", name: "widget", rootPath: "C:/Work/Widget" },
    })
    expect(file.projects[1]?.repositoryIdentity).toBeUndefined()
  })

  it("refuses a file that is not a projects file", () => {
    expect(() => parseProjectsFile("[]")).toThrow("no projects array")
    expect(() => parseProjectsFile("{")).toThrow("not valid JSON")
  })
})

describe("mapThreads", () => {
  it("maps the CLI's fields and keeps child threads with their parent", () => {
    const { threads, invalid } = mapThreads(fixture("threads/p-widget.json"), "p-widget")
    expect(invalid).toBe(0)
    expect(threads).toEqual([
      {
        threadId: "thread-w1",
        t3ProjectId: "p-widget",
        title: "Add an export button",
        status: "running",
        settled: false,
        settledAt: null,
        parentThreadId: null,
        updatedAt: "2026-11-01T05:00:00.000Z",
      },
      {
        threadId: "thread-w2",
        t3ProjectId: "p-widget",
        title: "Review: export button",
        status: "completed",
        settled: true,
        settledAt: "2026-10-31T12:00:00.000Z",
        parentThreadId: "thread-w1",
        updatedAt: "2026-10-31T12:00:00.000Z",
      },
      {
        threadId: "thread-w3",
        t3ProjectId: "p-widget",
        title: "Fix the date format; $(echo not a command)",
        status: "completed",
        settled: false,
        settledAt: null,
        parentThreadId: null,
        updatedAt: "2026-10-30T09:30:00.000Z",
      },
    ])
  })

  it("skips records without a thread id and counts them", () => {
    const { threads, invalid } = mapThreads(fixture("threads/p-gizmo.json"), "p-gizmo")
    expect(threads.map((t) => t.threadId)).toEqual(["thread-z1"])
    expect(invalid).toBe(1)
  })

  it("refuses output that is not a JSON array", () => {
    expect(() => mapThreads("No T3 Code project matches", "p")).toThrow("not valid JSON")
    expect(() => mapThreads("{}", "p")).toThrow("not a JSON array")
  })
})

describe("listThreads", () => {
  it("calls the CLI with an argument array", async () => {
    const calls: Array<[string, string[]]> = []
    const runner: Runner = async (command, args) => {
      calls.push([command, args])
      return { code: 0, stdout: "[]", stderr: "" }
    }
    await listThreads(runner, "C:\\t3\\t3.cmd", "mcp:p-gadget", 1000)
    expect(calls).toEqual([["C:\\t3\\t3.cmd", ["thread", "list", "--project", "mcp:p-gadget", "--json"]]])
  })

  it("never puts an unusual project id on a command line", async () => {
    const runner: Runner = async () => {
      throw new Error("the runner must not be called")
    }
    await expect(listThreads(runner, "t3", "a & del x", 1000)).rejects.toThrow("unsupported project id")
  })

  it("reports a failed CLI run with its last error line", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: "",
      stderr: "warn\nNo T3 Code project matches 'x'\n",
      error: "exit code 1",
    })
    await expect(listThreads(runner, "t3", "x", 1000)).rejects.toThrow("exit code 1: No T3 Code project matches 'x'")
  })
})
