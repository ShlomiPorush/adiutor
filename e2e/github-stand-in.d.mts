// Types of the stand-in GitHub API (github-stand-in.mjs) for the TypeScript tests that start it.

export const API_VERSION: string

export type FamilyMode = {
  alerts?: Record<string, unknown>[]
  pageSize?: number
  failPage?: number
  failStatus?: number
  status?: number
  message?: string
  headers?: Record<string, string>
  body?: unknown
  /** Another path for the next page's link (a list that tries to leave its own address). */
  nextPath?: string
}

export type StandInInstallation = {
  account: { id: number; login: string; type: string }
  permissions: Record<string, string>
  repositories: string[]
  suspended?: boolean
  uninstalled?: boolean
  status?: number
  message?: string
  inventory?: { failPage?: number; countDelta?: number; pageSize?: number }
}

export type StandInRepo = {
  id: number
  /** The open Issues count, or "error" for a GraphQL error on this repository. */
  issues?: number | "error"
  /** The database id GraphQL answers, when it differs from the inventory's. */
  graphqlId?: number
  /** The id GET /repos/{owner}/{repo} answers, when the name now leads to another repository. */
  restId?: number
  /** The installation GitHub names for the repository (null: none). */
  appInstallation?: number | null
  dependabot?: FamilyMode
  code_scanning?: FamilyMode
  secret_scanning?: FamilyMode
}

export type Scenario = {
  installations: Record<number, StandInInstallation>
  repos: Record<string, StandInRepo>
  graphql?: { rateLimited?: boolean }
}

export type StandInRequest = {
  method: string
  path: string
  query: Record<string, string>
  auth: string
  family?: string
  permissions?: string[]
}

export type StandIn = {
  origin: string
  scenario: Scenario
  requests: StandInRequest[]
  close(): Promise<void>
}

export function e2eScenario(): Scenario
export function startGitHubStandIn(options: {
  publicKey: string
  appId: string
  host?: string
  port?: number
  scenario?: Scenario
}): Promise<StandIn>
