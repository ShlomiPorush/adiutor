import { describe, expect, it } from "vitest"
import { resolveRepo } from "./repo.ts"
import type { T3Project } from "./t3.ts"

describe("resolveRepo", () => {
  it("uses T3's repository identity when its provider is GitHub", () => {
    const project: T3Project = {
      id: "p",
      title: "",
      workspaceRoot: "C:\\Elsewhere",
      repositoryIdentity: { provider: "GitHub", owner: "acme", name: "widget.js" },
    }
    expect(resolveRepo(project)).toBe("acme/widget.js")
  })

  it("gives nothing without a GitHub identity: the owner sets the repository in Adiutor", () => {
    const local: T3Project = {
      id: "p",
      title: "",
      workspaceRoot: "c:/work/gadget/",
      repositoryIdentity: { provider: "unknown", owner: "dev", name: "gadget", rootPath: "c:/work/gadget" },
    }
    expect(resolveRepo(local)).toBeUndefined()
    expect(resolveRepo({ id: "p", title: "" })).toBeUndefined()
  })

  it("refuses a malformed repository name", () => {
    const project: T3Project = {
      id: "p",
      title: "",
      repositoryIdentity: { provider: "github", owner: "a b", name: "c" },
    }
    expect(resolveRepo(project)).toBeUndefined()
  })
})
