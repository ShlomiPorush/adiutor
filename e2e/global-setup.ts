import { randomBytes } from "node:crypto"
import { connect, createServer } from "node:net"
import { resetState, saveState } from "./state.ts"

/**
 * Forgets the shared state of an earlier run. With E2E_TARGET (host:port, set by scripts/verify.sh for its stack,
 * which is thrown away after the run), makes a new owner password for this run unless E2E_PASSWORD is set, and
 * forwards 127.0.0.1:8090 to the Adiutor container, so the pages load from the server's public URL and every request
 * carries its Origin. Any other stack keeps its owner, so the password must come from E2E_PASSWORD.
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
  await new Promise<void>((resolve) => server.listen(8090, "127.0.0.1", resolve))
  return () => new Promise<void>((resolve) => server.close(() => resolve()))
}
