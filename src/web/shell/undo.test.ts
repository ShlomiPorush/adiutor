import { describe, expect, it } from "vitest"
import { type UndoState, undoPatch } from "./undo.ts"

const security: UndoState = { status: "todo", type: "security", severity: "high", projectId: "p1", goalId: "g1" }

describe("undoPatch", () => {
  it("brings the severity back after a type change away from security", () => {
    const after: UndoState = { ...security, type: "task", severity: null }
    expect(undoPatch(security, after)).toEqual({ type: "security", severity: "high" })
  })

  it("brings the goal back after a move to another project", () => {
    const after: UndoState = { ...security, projectId: "p2", goalId: null }
    expect(undoPatch(security, after)).toEqual({ projectId: "p1", goalId: "g1" })
  })

  it("sends only the status for a status change", () => {
    expect(undoPatch(security, { ...security, status: "done" })).toEqual({ status: "todo" })
  })
})
