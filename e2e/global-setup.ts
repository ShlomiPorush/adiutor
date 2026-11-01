import { connect, createServer } from "node:net"

/**
 * With E2E_TARGET (host:port, set by scripts/verify.sh), forwards 127.0.0.1:8090 to the Mikud
 * container, so the pages load from the server's public URL and every request carries its Origin.
 */
export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  const target = process.env.E2E_TARGET
  if (!target) return undefined
  const [host = "mikud", port = "8080"] = target.split(":")
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
