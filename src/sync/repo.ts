import { asArray, asObject, asString, type JsonObject } from "./json.ts"
import type { T3Project } from "./t3.ts"

// The GitHub repository of a T3 project: from T3's repository identity when its provider is GitHub,
// otherwise by matching the project's folder against the local repositories in the overview
// snapshot (their main checkout and their worktrees).

export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** Compares Windows and POSIX paths: forward slashes, no trailing slash, lower case. */
export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function localPaths(local: JsonObject): string[] {
  const paths = [asString(local.mainPath)]
  for (const worktree of asArray(local.worktrees)) paths.push(asString(asObject(worktree)?.path))
  return paths.filter((p): p is string => typeof p === "string" && p.trim() !== "").map(normalizePath)
}

export function resolveRepo(project: T3Project, local: JsonObject[]): string | undefined {
  const identity = project.repositoryIdentity
  if (identity?.provider?.toLowerCase() === "github" && identity.owner && identity.name) {
    const repo = `${identity.owner}/${identity.name}`
    if (REPO.test(repo)) return repo
  }
  // T3 may keep an older spelling of the folder in workspaceRoot; rootPath is where git found it.
  const wanted = [project.workspaceRoot, identity?.rootPath]
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .map(normalizePath)
  if (wanted.length === 0) return undefined
  for (const entry of local) {
    const github = asString(entry.github)
    if (!github || !REPO.test(github)) continue
    if (localPaths(entry).some((p) => wanted.includes(p))) return github
  }
  return undefined
}
