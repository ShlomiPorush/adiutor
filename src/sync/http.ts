// The fetch the sync sends with: the global fetch, or a stand-in in tests. Requests and their rules (no redirects,
// sent or not sent, the policy headers) are in src/sync/oauth.ts.

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>
