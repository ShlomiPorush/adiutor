// A stand-in for the parts of GitHub's API that Adiutor's server reads (src/server/github/), for the integration tests
// (in process) and scripts/verify.sh (as a container on the verify network). Node 20 APIs and the standard library
// only. It holds no secret: it gets the App's public key of the run, checks every App JWT with it, issues installation
// tokens from crypto.randomBytes and checks them on every request.
//
// It refuses what Adiutor must never do: a request without the pinned API version, a token request whose permissions
// are not read permissions the installation holds, a secret scanning page without hide_secret=true, and a request of
// one installation's token for another installation's repository.
//
// As a program: node e2e/github-stand-in.mjs --public-key=<file> --app-id=<id> [--port=8080] [--host=0.0.0.0]
// serves the end-to-end scenario below; GET /__health answers ok.

import { randomBytes, verify } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"

export const API_VERSION = "2022-11-28"
const READ_PERMISSIONS = ["vulnerability_alerts", "security_events", "secret_scanning_alerts", "issues", "metadata"]
const FAMILY_PATHS = {
  dependabot: "dependabot/alerts",
  code_scanning: "code-scanning/alerts",
  secret_scanning: "secret-scanning/alerts",
}

/** The scenario verify.sh's end-to-end run reads: one usable installation with one repository. */
export function e2eScenario() {
  return {
    installations: {
      4242: {
        account: { id: 9001, login: "example-org", type: "Organization" },
        permissions: {
          vulnerability_alerts: "read",
          security_events: "read",
          secret_scanning_alerts: "read",
          issues: "read",
          metadata: "read",
        },
        repositories: ["example-org/widget"],
      },
    },
    repos: {
      "example-org/widget": {
        id: 7001,
        issues: 3,
        dependabot: { alerts: [{ security_advisory: { severity: "critical" } }] },
        code_scanning: { status: 404, message: "no analysis found" },
        secret_scanning: { alerts: [] },
      },
    },
  }
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers })
  res.end(JSON.stringify(body))
}

function decode(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
}

/** Checks an App JWT (RS256) with the run's public key: the App's id as issuer, within its ten minutes. */
function appJwtValid(header, publicKey, appId) {
  const match = /^bearer (.+)$/i.exec(header ?? "")
  if (!match) return false
  const [head, payload, signature] = match[1].split(".")
  if (!head || !payload || !signature) return false
  try {
    if (decode(head).alg !== "RS256") return false
    const ok = verify("RSA-SHA256", Buffer.from(`${head}.${payload}`), publicKey, Buffer.from(signature, "base64url"))
    if (!ok) return false
    const claims = decode(payload)
    const now = Math.floor(Date.now() / 1000)
    return (
      String(claims.iss) === String(appId) &&
      claims.exp > now &&
      claims.iat <= now + 60 &&
      claims.exp - claims.iat <= 660
    )
  } catch {
    return false
  }
}

/**
 * Starts the stand-in. `scenario` is kept by reference: a test may change it between requests. `requests` records
 * every request (method, path, query, who made it), never a token.
 */
export async function startGitHubStandIn({ publicKey, appId, host = "127.0.0.1", port = 0, scenario = e2eScenario() }) {
  const tokens = new Map()
  const requests = []
  const state = { scenario, requests, tokens }

  const server = createServer((req, res) => {
    let raw = ""
    req.setEncoding("utf8")
    req.on("data", (chunk) => {
      raw += chunk
    })
    req.on("end", () => {
      try {
        handle(req, res, raw)
      } catch (error) {
        json(res, 500, { message: `stand-in failed: ${error instanceof Error ? error.message : "unknown"}` })
      }
    })
  })

  function handle(req, res, raw) {
    const url = new URL(req.url ?? "/", "http://stand-in")
    const path = url.pathname
    if (path === "/__health") return json(res, 200, { ok: true })
    const s = state.scenario
    const entry = { method: req.method, path, query: Object.fromEntries(url.searchParams), auth: "none" }
    requests.push(entry)
    if (req.headers["x-github-api-version"] !== API_VERSION)
      return json(res, 400, { message: "missing or wrong X-GitHub-Api-Version" })

    // --- App routes: a JWT signed with the App's key ---
    const appRoute =
      path === "/app" ||
      /^\/app\/installations\/\d+(\/access_tokens)?$/.test(path) ||
      /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path)
    if (appRoute) {
      entry.auth = "app"
      if (!appJwtValid(req.headers.authorization, publicKey, appId))
        return json(res, 401, { message: "A JSON web token could not be decoded" })
      if (path === "/app" && req.method === "GET")
        return json(res, 200, { id: Number(appId), slug: "adiutor-stand-in" })
      const installationMatch = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(path)
      if (installationMatch) {
        const id = Number(installationMatch[1])
        const inst = s.installations[id]
        if (!inst || inst.uninstalled) return json(res, 404, { message: "Not Found" })
        if (!installationMatch[2] && req.method === "GET") {
          if (inst.status) return json(res, inst.status, { message: inst.message ?? "failed" })
          return json(res, 200, {
            id,
            account: inst.account,
            permissions: inst.permissions,
            suspended_at: inst.suspended ? "2026-01-01T00:00:00Z" : null,
          })
        }
        if (installationMatch[2] && req.method === "POST") {
          if (inst.suspended) return json(res, 403, { message: "This installation has been suspended" })
          const body = raw ? JSON.parse(raw) : {}
          const asked = body.permissions
          const valid =
            asked &&
            typeof asked === "object" &&
            Object.keys(asked).length > 0 &&
            Object.entries(asked).every(
              ([name, level]) =>
                READ_PERMISSIONS.includes(name) && level === "read" && inst.permissions[name] === "read",
            )
          if (!valid)
            return json(res, 422, { message: "The permissions requested are not granted to this installation." })
          entry.permissions = Object.keys(asked).sort()
          const token = `ghs_${randomBytes(18).toString("hex")}`
          tokens.set(token, id)
          return json(res, 201, {
            token,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: asked,
            repository_selection: "selected",
          })
        }
      }
      const repoInstallation = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path)
      if (repoInstallation) {
        const name = `${repoInstallation[1]}/${repoInstallation[2]}`.toLowerCase()
        // A test may say which installation GitHub names for the repository (null: none).
        const override = Object.entries(s.repos).find(([key]) => key.toLowerCase() === name)?.[1]?.appInstallation
        if (override === null) return json(res, 404, { message: "Not Found" })
        if (override !== undefined) return json(res, 200, { id: override })
        const owner = Object.entries(s.installations).find(
          ([, inst]) => !inst.uninstalled && inst.repositories.some((r) => r.toLowerCase() === name),
        )
        if (!owner) return json(res, 404, { message: "Not Found" })
        return json(res, 200, { id: Number(owner[0]) })
      }
      return json(res, 404, { message: "Not Found" })
    }

    // --- Installation routes: a token this stand-in issued ---
    const tokenMatch = /^token (ghs_[0-9a-f]+)$/i.exec(req.headers.authorization ?? "")
    const installationId = tokenMatch ? tokens.get(tokenMatch[1]) : undefined
    if (installationId === undefined) return json(res, 401, { message: "Bad credentials" })
    entry.auth = `installation:${installationId}`
    const inst = s.installations[installationId]

    if (path === "/installation/repositories" && req.method === "GET") {
      const inventory = inst.inventory ?? {}
      const perPage = inventory.pageSize ?? Number(url.searchParams.get("per_page") ?? 30)
      const page = Number(url.searchParams.get("page") ?? 1)
      if (inventory.failPage === page) return json(res, 502, { message: "Server Error" })
      const all = inst.repositories.map((fullName) => ({ id: s.repos[fullName]?.id ?? 0, full_name: fullName }))
      const slice = all.slice((page - 1) * perPage, page * perPage)
      const headers = {}
      if (page * perPage < all.length)
        headers.link = `<http://${req.headers.host}/installation/repositories?per_page=${perPage}&page=${page + 1}>; rel="next"`
      return json(res, 200, { total_count: all.length + (inventory.countDelta ?? 0), repositories: slice }, headers)
    }

    if (path === "/graphql" && req.method === "POST") {
      const body = JSON.parse(raw || "{}")
      if (s.graphql?.rateLimited)
        return json(res, 200, { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })
      // As GitHub: a connection asked for without `first` or `last` fails the whole query.
      if (/issues\((?![^)]*\b(first|last):)/.test(String(body.query)))
        return json(res, 200, {
          errors: [{ type: "MISSING_PAGINATION_BOUNDARIES", message: "You must provide a `first` or `last` value." }],
        })
      const data = {}
      const errors = []
      for (const m of String(body.query).matchAll(
        /(r\d+): repository\(owner: \$(o\d+), name: \$(n\d+), followRenames: false\)/g,
      )) {
        const [, alias, o, n] = m
        const fullName = `${body.variables?.[o]}/${body.variables?.[n]}`
        const key = inst.repositories.find((r) => r.toLowerCase() === fullName.toLowerCase())
        const repo = key ? s.repos[key] : undefined
        if (!repo) {
          data[alias] = null
          errors.push({ type: "NOT_FOUND", path: [alias], message: "Could not resolve to a Repository" })
        } else if (repo.issues === "error") {
          data[alias] = null
          errors.push({ type: "FORBIDDEN", path: [alias], message: "Resource not accessible by integration" })
        } else data[alias] = { databaseId: repo.graphqlId ?? repo.id, issues: { totalCount: repo.issues ?? 0 } }
      }
      return json(res, 200, errors.length > 0 ? { data, errors } : { data })
    }

    const familyMatch =
      /^\/repos\/([^/]+)\/([^/]+)\/(dependabot\/alerts|code-scanning\/alerts|secret-scanning\/alerts)$/.exec(path)
    if (familyMatch && req.method === "GET") {
      const fullName = `${familyMatch[1]}/${familyMatch[2]}`
      const key = inst.repositories.find((r) => r.toLowerCase() === fullName.toLowerCase())
      const repo = key ? s.repos[key] : undefined
      if (!repo) return json(res, 404, { message: "Not Found" })
      const family = Object.entries(FAMILY_PATHS).find(([, p]) => p === familyMatch[3])[0]
      entry.family = family
      if (family === "secret_scanning" && url.searchParams.get("hide_secret") !== "true")
        return json(res, 400, { message: "hide_secret=true is required by the stand-in" })
      if (url.searchParams.get("state") !== "open")
        return json(res, 400, { message: "state=open is required by the stand-in" })
      const mode = repo[family] ?? { alerts: [] }
      if (mode.status) return json(res, mode.status, mode.body ?? { message: mode.message ?? "" }, mode.headers ?? {})
      if (mode.body) return json(res, 200, mode.body, mode.headers ?? {})
      const perPage = mode.pageSize ?? Number(url.searchParams.get("per_page") ?? 30)
      // Dependabot pages by an `after` cursor, the others by page number, as GitHub does.
      const cursorName = family === "dependabot" ? "after" : "page"
      const cursor = url.searchParams.get(cursorName)
      const page =
        cursor === null
          ? 1
          : family === "dependabot"
            ? Number(Buffer.from(cursor, "base64url").toString())
            : Number(cursor)
      if (mode.failPage === page) return json(res, mode.failStatus ?? 500, { message: "failed" })
      // Alerts as GitHub lists them: each with its number and the state asked for, unless the test gives them.
      const slice = mode.alerts
        .map((alert, i) => ({ number: i + 1, state: "open", ...alert }))
        .slice((page - 1) * perPage, page * perPage)
      const headers = {}
      if (page * perPage < mode.alerts.length) {
        const next = new URL(`http://${req.headers.host}${path}`)
        next.searchParams.set("per_page", String(perPage))
        next.searchParams.set(
          cursorName,
          family === "dependabot" ? Buffer.from(String(page + 1)).toString("base64url") : String(page + 1),
        )
        if (mode.nextPath) next.pathname = mode.nextPath
        headers.link = `<${next.href}>; rel="next"`
      }
      return json(res, 200, slice, headers)
    }
    return json(res, 404, { message: "Not Found" })
  }

  await new Promise((resolve) => server.listen(port, host, resolve))
  const address = server.address()
  const origin = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`
  return {
    origin,
    state,
    get scenario() {
      return state.scenario
    },
    set scenario(next) {
      state.scenario = next
    },
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

// As a program (verify.sh): the end-to-end scenario on the given port.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...v] = a.replace(/^--/, "").split("=")
      return [k, v.join("=")]
    }),
  )
  if (!args["public-key"] || !args["app-id"]) {
    process.stderr.write(
      "usage: github-stand-in.mjs --public-key=<file> --app-id=<id> [--port=8080] [--host=0.0.0.0]\n",
    )
    process.exit(2)
  }
  const standIn = await startGitHubStandIn({
    publicKey: readFileSync(args["public-key"], "utf8"),
    appId: args["app-id"],
    host: args.host || "0.0.0.0",
    port: Number(args.port || 8080),
  })
  process.stdout.write(`github stand-in listening on ${standIn.origin}\n`)
  const stop = () => void standIn.close().then(() => process.exit(0))
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
}
