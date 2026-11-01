import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { normalizePath, resolveRepo } from "./repo.ts"
import { readLatestSnapshot } from "./snapshot.ts"
import type { T3Project } from "./t3.ts"

const overviewDir = fileURLToPath(new URL("./fixtures/overview", import.meta.url))
const local = async () => (await readLatestSnapshot(overviewDir)).local

describe("normalizePath", () => {
  it("ignores separators, a trailing slash and case", () => {
    expect(normalizePath("C:\\Work\\Gadget\\")).toBe("c:/work/gadget")
    expect(normalizePath("c:/work/gadget")).toBe("c:/work/gadget")
  })
})

describe("resolveRepo", () => {
  it("uses T3's repository identity when its provider is GitHub", async () => {
    const project: T3Project = {
      id: "p",
      title: "",
      workspaceRoot: "C:\\Elsewhere",
      repositoryIdentity: { provider: "GitHub", owner: "acme", name: "widget.js" },
    }
    expect(resolveRepo(project, await local())).toBe("acme/widget.js")
  })

  it("matches the folder against the snapshot's main checkouts", async () => {
    expect(resolveRepo({ id: "p", title: "", workspaceRoot: "c:/work/gadget/" }, await local())).toBe("acme/gadget")
  })

  it("matches T3's rootPath against a worktree when another host or an old folder name is given", async () => {
    const project: T3Project = {
      id: "p",
      title: "",
      workspaceRoot: "C:\\Users\\Old Name\\Work\\gizmo",
      repositoryIdentity: {
        provider: "unknown",
        owner: "dev",
        name: "gizmo",
        rootPath: "C:/Users/Dev/.t3/worktrees/gizmo/t3-0001",
      },
    }
    expect(resolveRepo(project, await local())).toBe("acme/gizmo")
  })

  it("returns nothing for a folder without a GitHub repository or without a match", async () => {
    expect(resolveRepo({ id: "p", title: "", workspaceRoot: "/home/dev/notes" }, await local())).toBeUndefined()
    expect(resolveRepo({ id: "p", title: "", workspaceRoot: "C:\\Unknown" }, await local())).toBeUndefined()
    expect(resolveRepo({ id: "p", title: "" }, await local())).toBeUndefined()
  })

  it("refuses a malformed repository name", () => {
    const project: T3Project = {
      id: "p",
      title: "",
      repositoryIdentity: { provider: "github", owner: "a b", name: "c" },
    }
    expect(resolveRepo(project, [{ mainPath: "/x", github: "not a repo" }])).toBeUndefined()
  })
})
