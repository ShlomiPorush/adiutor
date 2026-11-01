import { readFile, stat } from "node:fs/promises"
import { extname, join, normalize, resolve, sep } from "node:path"
import type { Hono } from "hono"

// Serves the built web UI (dist/web): files as they are, and index.html for any other page address,
// so a reload or a shared link of /projects/... opens the app. /api, /mcp and /healthz are never
// answered here. Nothing is written; the container's root file system stays read-only.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
}

/** Only this origin's scripts, styles, fonts and requests; no inline script, no framing. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

const RESERVED = /^\/(?:api|mcp|healthz)(?:\/|$)/

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export function webRoutes(app: Hono, root: string): void {
  const base = resolve(root)
  app.on(["GET", "HEAD"], "*", async (c, next) => {
    const path = c.req.path
    if (RESERVED.test(path)) return next()
    let decoded: string
    try {
      decoded = decodeURIComponent(path)
    } catch {
      return next()
    }
    const wanted = resolve(base, `.${normalize(decoded)}`)
    let file: string | null = wanted.startsWith(`${base}${sep}`) && (await isFile(wanted)) ? wanted : null
    if (!file) {
      // A missing file (it has an extension) is a 404, not the app.
      if (extname(decoded)) return next()
      file = join(base, "index.html")
    }
    let body: Buffer
    try {
      body = await readFile(file)
    } catch {
      return next()
    }
    const type = TYPES[extname(file)] ?? "application/octet-stream"
    const headers: Record<string, string> = {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      // Hashed build files never change; the page and boot.js are checked on every load.
      "Cache-Control": file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    }
    if (type.startsWith("text/html")) {
      headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
      headers["Referrer-Policy"] = "no-referrer"
      headers["X-Frame-Options"] = "DENY"
    }
    if (c.req.method === "HEAD") return c.body(null, 200, headers)
    return c.body(new Uint8Array(body), 200, headers)
  })
}
