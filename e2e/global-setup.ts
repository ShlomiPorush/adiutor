import { randomBytes } from "node:crypto"
import { connect, createServer, type Server } from "node:net"
import { BASE_URL } from "./address.ts"
import { resetState, saveState } from "./state.ts"

/**
 * Forgets the shared state of an earlier run. With E2E_TARGET (host:port, set by scripts/verify.sh for its stack,
 * which is thrown away after the run), makes a new owner password for this run unless E2E_PASSWORD is set, and
 * forwards the port of E2E_BASE_URL (e2e/address.ts) on the loopback addresses to the Adiutor container, so the pages
 * load from the server's public URL and every request carries its Origin. `localhost` may resolve to ::1 first, so the
 * forward listens on ::1 as well where the container has it. Any other stack keeps its owner, so the password must come from E2E_PASSWORD.
 */
export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  // The TOTP secret and stored sessions of an earlier run belong to another database.
  resetState()
  const target = process.env.E2E_TARGET
  if (!process.env.E2E_PASSWORD) {
    if (!target)
      throw new Error(
        "Set E2E_USERNAME and E2E_PASSWORD (and E2E_TOTP_SECRET when the owner exists) for a stack that keeps its owner",
      )
    saveState({ password: randomBytes(18).toString("base64url") })
  }
  if (!target) return undefined
  const [host = "adiutor", port = "8080"] = target.split(":")
  const server = createServer((socket) => {
    const upstream = connect(Number(port), host)
    socket.pipe(upstream).pipe(socket)
    const close = () => {
      socket.destroy()
      upstream.destroy()
    }
    socket.on("error", close)
    upstream.on("error", close)
  })
  const local = Number(new URL(BASE_URL).port || 80)
  const listen = (on: Server, address: string) =>
    new Promise<boolean>((resolve, reject) => {
      on.once("error", (error: NodeJS.ErrnoException) =>
        error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT" ? resolve(false) : reject(error),
      )
      on.listen(local, address, () => resolve(true))
    })
  await listen(server, "127.0.0.1")
  const v6 = createServer((socket) => server.emit("connection", socket))
  const onV6 = await listen(v6, "::1")
  const close = (on: Server) => new Promise<void>((resolve) => on.close(() => resolve()))
  return async () => {
    await close(server)
    if (onV6) await close(v6)
  }
}
