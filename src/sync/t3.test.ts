import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { Runner } from "./exec.ts"
import { linkEnvironment, listThreads, mapThreads, parseProjectList } from "./t3.ts"

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

describe("parseProjectList", () => {
  it("keeps usable projects of T3's answer and counts the rest", () => {
    const file = parseProjectList(JSON.parse(fixture("t3-projects.json")))
    expect(file.projects.map((p) => p.id)).toEqual(["p-widget", "mcp:p-gadget", "p-gizmo", "p-notes", "p-missing"])
    // Deleted, an id with shell characters, and no id.
    expect(file.skipped).toBe(3)
    expect(file.projects[0]).toEqual({
      id: "p-widget",
      title: "Widget",
      repositoryIdentity: { provider: "github", owner: "acme", name: "widget" },
    })
    expect(file.projects[1]?.repositoryIdentity).toBeUndefined()
  })

  it("refuses an answer that is not a project list", () => {
    expect(() => parseProjectList([])).toThrow("no projects array")
    expect(() => parseProjectList({ projects: {} })).toThrow("no projects array")
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
        snoozed: false,
        snoozedUntil: null,
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
        snoozed: false,
        snoozedUntil: null,
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
        snoozed: false,
        snoozedUntil: null,
      },
    ])
  })

  it("collects the environment ids the threads' links name, for the environment check", () => {
    expect(mapThreads(fixture("threads/p-widget.json"), "p-widget")).toMatchObject({
      environments: ["fixture-env"],
      unverified: 0,
    })
    // A thread without a link, or with a link of another shape, cannot be checked: counted.
    const noLink = JSON.stringify([
      { threadId: "a", status: "running" },
      { threadId: "b", status: "running", link: "https://app.t3.codes/elsewhere" },
      { threadId: "c", status: "running", link: "https://app.t3.codes/threads/env-1/c" },
    ])
    expect(mapThreads(noLink, "p")).toMatchObject({ environments: ["env-1"], unverified: 2 })
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

describe("linkEnvironment", () => {
  it("reads the environment id from a thread link and nothing else", () => {
    expect(linkEnvironment("https://app.t3.codes/threads/env-1/thread-2")).toBe("env-1")
    for (const other of [undefined, 3, "", "not a link", "https://app.t3.codes/threads/env-1", "http://x/env/thread"])
      expect(linkEnvironment(other)).toBeUndefined()
  })
})

describe("listThreads", () => {
  it("calls the CLI with an argument array, without T3's data folder overrides", async () => {
    const calls: Array<[string, string[], NodeJS.ProcessEnv | undefined]> = []
    const runner: Runner = async (command, args, opts) => {
      calls.push([command, args, opts.env])
      return { code: 0, stdout: "[]", stderr: "" }
    }
    const env = {
      PATH: "/bin",
      T3CODE_HOME: "/elsewhere",
      t3code_home: "/x",
      VITE_DEV_SERVER_URL: "http://dev",
      T3CODE_BOOTSTRAP_FD: "3",
      ADIUTOR_AGENT_TOKEN: randomBytes(20).toString("hex"),
    }
    await listThreads(runner, "C:\\t3\\t3.cmd", "mcp:p-gadget", 1000, env)
    expect(calls).toEqual([
      ["C:\\t3\\t3.cmd", ["thread", "list", "--project", "mcp:p-gadget", "--json"], { PATH: "/bin" }],
    ])
  })

  it("never puts an unusual project id on a command line", async () => {
    const runner: Runner = async () => {
      throw new Error("the runner must not be called")
    }
    await expect(listThreads(runner, "t3", "a & del x", 1000, {})).rejects.toThrow("unsupported project id")
  })

  it("reports a failed CLI run with its last error line", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: "",
      stderr: "warn\nNo T3 Code project matches 'x'\n",
      error: "exit code 1",
    })
    await expect(listThreads(runner, "t3", "x", 1000, {})).rejects.toThrow(
      "exit code 1: No T3 Code project matches 'x'",
    )
  })
})
