import Provider, {
  type AdapterConstructor,
  type Configuration,
  errors,
  interactionPolicy,
  type JWK,
  type KoaContextWithOIDC,
} from "oidc-provider"
import { AGENT_AREAS, type AgentArea, type AgentResource } from "../../shared/enums.ts"
import { LOOPBACK_HOSTNAMES } from "./issuer.ts"
import { cleanLabel } from "./label.ts"
import type { ProviderPages } from "./pages.ts"

/*
 * The authorization server through which agents connect (oidc-provider 9.14.0, used through its documented options and
 * hooks; the exceptions are listed in docs/project-foundation.md, Security design, D1-X). MCP clients connect by the
 * authorization code flow with PKCE after registering themselves; the agent skill and the sync connect with the device
 * flow as the built-in client. The owner approves every connection on Adiutor's own page; each approval is a grant of its
 * own. Access tokens are opaque, last 15 minutes and are good for one resource only (/mcp or /api/v1). Refresh tokens
 * rotate on every use, and a spent one presented again ends the whole grant. Adiutor itself ends a connection after the
 * idle days (oauth/access.ts); the library's own lifetimes (grant and refresh token, ten years) never end one first.
 */

const DAY_S = 86_400
export const ACCESS_TOKEN_TTL_S = 900
export const AUTHORIZATION_CODE_TTL_S = 60
export const DEVICE_CODE_TTL_S = 600
/** An approval page and the library's own session (it only carries the approval back to the flow) live 10 minutes. */
export const INTERACTION_TTL_S = 600
/**
 * The grant: an absolute cap the library has no documented way to extend (D1e). Ten years, far beyond any real use;
 * Adiutor's idle rule is the real end. The refresh token lives as long (D1k, P18): no spent refresh token expires while
 * its grant lives, so its reuse is seen for the whole life of the connection.
 */
export const GRANT_TTL_S = 3650 * DAY_S
export const REFRESH_TOKEN_TTL_S = GRANT_TTL_S

/** The built-in public client of the agent skill and the sync: the device flow and refresh only (S7). */
export const CLI_CLIENT_ID = "adiutor-agent"

/** The provider's addresses. `/connect/device` stays Better Auth's until the agent access release (D1j). */
export const PROVIDER_ROUTES = {
  authorization: "/oauth/authorize",
  token: "/oauth/token",
  device_authorization: "/oauth/device",
  code_verification: "/connect/code",
  revocation: "/oauth/revoke",
  registration: "/oauth/register",
  jwks: "/oauth/jwks",
  // Off (their features are), named so nothing of the library lands outside /oauth.
  userinfo: "/oauth/userinfo",
  end_session: "/oauth/logout",
  introspection: "/oauth/introspect",
  pushed_authorization_request: "/oauth/par",
  backchannel_authentication: "/oauth/backchannel",
  challenge: "/oauth/challenge",
  credential: "/oauth/credential",
} as const

/** The consent page of an approval (the agent access pages); its API lives below it, where the cookie goes. */
export const consentPath = (uid: string) => `/connect/approve/${uid}`

/** The two resources a connection may be for. */
export function resourceUrls(issuer: string): Record<AgentResource, string> {
  return { mcp: `${issuer}/mcp`, rest: `${issuer}/api/v1` }
}

/** The areas a resource offers: `sync` belongs to the REST API alone (D3). */
export const RESOURCE_AREAS: Record<AgentResource, readonly AgentArea[]> = {
  mcp: ["read", "write"],
  rest: AGENT_AREAS,
}

/** Redirect URIs a registration may hold, at most. */
export const MAX_REDIRECT_URIS = 5

const isLoopback = (url: URL) =>
  url.protocol === "http:" && (LOOPBACK_HOSTNAMES as readonly string[]).includes(url.hostname)
/** A private-use scheme in reverse-domain form (RFC 8252 7.1), such as `com.example.app:/callback`. */
const PRIVATE_USE = /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/

/**
 * The kind of a redirect URI an agent may register (S5): https anywhere, http only back to this computer (any port,
 * RFC 8252 7.3), or a private-use scheme in reverse-domain form; never a fragment or user information. Null when refused.
 */
export function redirectKind(value: unknown): "https" | "loopback" | "private" | null {
  if (typeof value !== "string" || value.length > 500) return null
  const url = URL.parse(value)
  if (!url || url.hash || value.includes("#") || url.username || url.password) return null
  if (url.protocol === "https:") return url.hostname && !isLoopback(url) ? "https" : null
  if (url.protocol === "http:") return isLoopback(url) ? "loopback" : null
  return PRIVATE_USE.test(url.protocol) ? "private" : null
}

/** Client metadata a self-registered agent may not send: each would make the library fetch or trust something. */
const REFUSED_METADATA = [
  "jwks",
  "jwks_uri",
  "sector_identifier_uri",
  "request_uris",
  "initiate_login_uri",
  "post_logout_redirect_uris",
  "backchannel_logout_uri",
  "frontchannel_logout_uri",
]

/**
 * Adiutor's rules for agents that register themselves (RFC 7591, S5), run by the library's documented
 * `extraClientMetadata.validator` on every registration and every client it loads: public clients with one to five
 * redirect URIs of the allowed kinds, the authorization code grant with refresh and nothing more. A registration with a
 * loopback or private-use redirect is a native client, so a loopback redirect may use any port. Scopes a client asks
 * for are dropped: the owner decides what it may do. The built-in client is left to the library's own checks.
 */
const RULES_PROPERTY = "adiutor_rules"
function registrationRules(_ctx: unknown, key: string, _value: unknown, metadata: Record<string, unknown>) {
  if (key !== RULES_PROPERTY) return
  delete metadata[RULES_PROPERTY]
  if (metadata.client_id === CLI_CLIENT_ID) return
  const fail = (message: string): never => {
    throw new errors.InvalidClientMetadata(message)
  }
  for (const name of REFUSED_METADATA) if (metadata[name] !== undefined) fail(`${name} is not accepted.`)
  if (metadata.token_endpoint_auth_method !== "none") fail("Only public clients (token_endpoint_auth_method none).")
  const uris = metadata.redirect_uris
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS)
    fail(`One to ${MAX_REDIRECT_URIS} redirect URIs.`)
  const kinds = (uris as unknown[]).map(redirectKind)
  if (kinds.some((k) => k === null))
    fail("Redirect URIs must be https, http on localhost, 127.0.0.1 or [::1], or a reverse-domain private scheme.")
  metadata.application_type = kinds.every((k) => k === "https") ? "web" : "native"
  const name = metadata.client_name
  if (name !== undefined && (typeof name !== "string" || name.length < 1 || name.length > 100))
    fail("client_name must be 1 to 100 characters.")
  const grants = metadata.grant_types
  if (!Array.isArray(grants) || !grants.every((g) => g === "authorization_code" || g === "refresh_token"))
    fail("Only the authorization_code and refresh_token grants.")
  const responses = metadata.response_types
  if (!Array.isArray(responses) || !responses.every((r) => r === "code")) fail("Only the code response type.")
  delete metadata.scope
}

/** The name an agent gives itself, cleaned: the built-in client's label (S7), or a registration's client_name. */
export function agentName(clientId: string, clientName: string | undefined, label: unknown): string {
  if (clientId === CLI_CLIENT_ID) return cleanLabel(label) ?? "Script"
  return cleanLabel(clientName) ?? "Agent"
}

/** The label a device code was asked with, read from the code's documented `params` (D1-X 3). */
function deviceLabel(ctx: KoaContextWithOIDC): unknown {
  return ctx.oidc.deviceCode?.params?.client_label
}

export type AgentProviderOptions = {
  issuer: string
  adapter: AdapterConstructor
  /** ADIUTOR_OAUTH_SECRETS, newest first: the first signs the library's cookies, the others only verify. */
  cookieKeys: string[]
  pages: ProviderPages
  /** Whether the owner's account still exists (the library refuses tokens for an account it cannot load). */
  accountExists: (accountId: string) => Promise<boolean>
  /** The installation's Ed25519 private JWK (oauth/signing-key.ts). */
  signingKey: JWK
}

export function createAgentProvider(options: AgentProviderOptions): Provider {
  const { issuer, pages } = options
  if (options.cookieKeys.length === 0) throw new Error("the authorization server needs ADIUTOR_OAUTH_SECRETS")
  const resources = resourceUrls(issuer)
  const resourceOf = (indicator: string): AgentResource | null =>
    indicator === resources.mcp ? "mcp" : indicator === resources.rest ? "rest" : null

  // Every approval goes through Adiutor's page: a request that the library would otherwise answer from its own session
  // with nothing "missing" (no scope asked, a web client) still needs the owner's consent result (interactions.policy).
  const policy = interactionPolicy.base()
  policy
    .get("consent")
    ?.checks.add(
      new interactionPolicy.Check(
        "adiutor_consent",
        "every connection is approved on Adiutor's page",
        "consent_required",
        (ctx) => !ctx.oidc.result?.consent?.grantId,
      ),
    )

  const configuration: Configuration = {
    adapter: options.adapter,
    // Nothing signs (opaque tokens, the code response type only, openid never granted). `{ keys: [] }` starts, but the
    // library then refuses every client ("id_token_signed_response_alg must not be provided (no values are allowed)"),
    // so the installation's own Ed25519 key is given (D1i); without `jwks` the library would load its published
    // development keys.
    jwks: { keys: [options.signingKey] },
    clients: [
      {
        client_id: CLI_CLIENT_ID,
        client_name: "Script",
        token_endpoint_auth_method: "none",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        response_types: [],
        redirect_uris: [],
      },
    ],
    clientAuthMethods: ["none"],
    responseTypes: ["code"],
    clientDefaults: {
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // The only algorithm the installation's key offers (an ID token is never issued: openid is never granted).
      id_token_signed_response_alg: "EdDSA",
    },
    extraClientMetadata: { properties: [RULES_PROPERTY], validator: registrationRules },
    // A redirect URI is always named, so an error is never sent to an address the request did not name (S8, D1b).
    allowOmittingSingleRegisteredRedirectUri: false,
    // A browser-based client may call the token endpoint only from the origin of one of its redirect URIs.
    clientBasedCORS: (_ctx, origin, client) =>
      origin !== "null" && client.redirectUris?.some((uri) => URL.parse(uri)?.origin === origin) === true,
    cookies: { keys: options.cookieKeys },
    routes: PROVIDER_ROUTES,
    // openid cannot be removed from the library's scopes; it is rejected on every grant and never granted (D1i).
    scopes: ["openid"],
    extraParams: ["client_label"],
    features: {
      devInteractions: { enabled: false },
      // /mcp and /api/v1 do not check sender-constrained tokens, so none are issued (DPoP is on by default).
      dPoP: { enabled: false },
      registration: { enabled: true, issueRegistrationAccessToken: false },
      // Every request goes through /oauth/authorize, where the checks are.
      pushedAuthorizationRequests: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: false },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      jwtIntrospection: { enabled: false },
      jwtResponseModes: { enabled: false },
      clientIdMetadataDocument: { enabled: false },
      deviceFlow: {
        enabled: true,
        charset: "base-20",
        mask: "****-****",
        userCodeInputSource: (ctx, form, _out, err) => {
          ctx.type = "html"
          ctx.body = pages.codeInput(
            form,
            !err
              ? undefined
              : err.name === "AbortedError"
                ? "denied"
                : err.name === "NoCodeError" || "userCode" in err
                  ? "wrong"
                  : "other",
          )
        },
        userCodeConfirmSource: (ctx, form, client, _deviceInfo, userCode) => {
          ctx.type = "html"
          ctx.body = pages.codeConfirm(form, userCode, agentName(client.clientId, client.clientName, deviceLabel(ctx)))
        },
        successSource: (ctx) => {
          ctx.type = "html"
          ctx.body = pages.success()
        },
      },
      resourceIndicators: {
        enabled: true,
        // No resource named: an MCP client means /mcp, the built-in client the REST API.
        defaultResource: (_ctx, client, oneOf) => {
          if (oneOf) {
            if (oneOf.length === 1 && oneOf[0]) return oneOf[0]
            throw new errors.InvalidTarget("only one resource may be requested")
          }
          return client?.clientId === CLI_CLIENT_ID ? resources.rest : resources.mcp
        },
        // A refresh keeps the resource the grant was made for.
        useGrantedResource: () => true,
        getResourceServerInfo: (ctx, indicator) => {
          // A request that names both resources is refused: a token is good for one of them (S10, D1-X 3).
          const asked = ctx.oidc.params?.resource
          if (Array.isArray(asked) && asked.length > 1)
            throw new errors.InvalidTarget("only one resource may be requested")
          const resource = resourceOf(indicator)
          if (!resource) throw new errors.InvalidTarget()
          return {
            scope: RESOURCE_AREAS[resource].join(" "),
            audience: indicator,
            accessTokenFormat: "opaque",
            accessTokenTTL: ACCESS_TOKEN_TTL_S,
          }
        },
      },
    },
    pkce: { required: () => true },
    // Revoking any token of a connection, also an access token, ends all of it (S15).
    revokeGrantPolicy: () => true,
    // Every approval is a grant of its own: two agents, even of the same program, never share one (S11).
    loadExistingGrant: async (ctx) => {
      const id = ctx.oidc.result?.consent?.grantId
      return id ? ctx.oidc.provider.Grant.find(id) : undefined
    },
    // Every client allowed to refresh gets a refresh token; nobody has to ask for offline_access.
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    rotateRefreshToken: () => true,
    // A connection never depends on the browser session that approved it.
    expiresWithSession: async () => false,
    ttl: {
      AccessToken: ACCESS_TOKEN_TTL_S,
      AuthorizationCode: AUTHORIZATION_CODE_TTL_S,
      BackchannelAuthenticationRequest: 60,
      ClientCredentials: 60,
      DeviceCode: DEVICE_CODE_TTL_S,
      Grant: GRANT_TTL_S,
      IdToken: 60,
      Interaction: INTERACTION_TTL_S,
      RefreshToken: REFRESH_TOKEN_TTL_S,
      Session: INTERACTION_TTL_S,
    },
    interactions: { policy, url: (_ctx, interaction) => consentPath(interaction.uid) },
    findAccount: async (_ctx, id) =>
      (await options.accountExists(id)) ? { accountId: id, claims: async () => ({ sub: id }) } : undefined,
    renderError: async (ctx, out) => {
      ctx.type = "html"
      ctx.body = pages.error(String(out.error ?? "server_error"))
    },
  }
  const provider = new Provider(issuer, configuration)
  // Behind Traefik the provider must see https (Secure cookies, its own URLs); X-Forwarded-For counts one hop only.
  provider.proxy = issuer.startsWith("https://")
  provider.maxIpsCount = 1
  return provider
}

export type AgentProvider = Provider
