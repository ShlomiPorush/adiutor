import type { T3Project } from "./t3.ts"

// The GitHub repository of a T3 project: from T3's repository identity, when its provider is GitHub. A project
// without one gets its repository from the owner, on its page in Adiutor (owner's decision, 2026-11-18): the sync no
// longer matches folders against the overview collector's snapshot.

export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function resolveRepo(project: T3Project): string | undefined {
  const identity = project.repositoryIdentity
  if (identity?.provider?.toLowerCase() !== "github" || !identity.owner || !identity.name) return undefined
  const repo = `${identity.owner}/${identity.name}`
  return REPO.test(repo) ? repo : undefined
}
