// A stand-in for adiutor-sync.js in the runner tests: it writes the engine's JSON lines for a few made-up commands,
// and can start a child of its own to show that the Job Object ends the whole tree.
import { spawn } from "node:child_process"

const [command] = process.argv.slice(2)
const line = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const result = (fields) => line({ type: "result", v: 1, ok: true, ...fields })

if (command === "status") {
  process.stderr.write("a line on stderr that the tray drops\n")
  line({ type: "event", event: "message", text: "hello" })
  result({
    command: "status",
    adiutor: { state: "connected", url: null, revocationPending: false },
    t3: { state: "not_connected", revocationPending: false },
    lastRun: null,
    lastGoodSyncAt: null,
    running: null,
    paused: null,
    claim: null,
    settings: { problems: [] },
  })
} else if (command === "echo") {
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => (input += chunk))
  process.stdin.on("end", () => {
    line({ type: "event", event: "message", text: input })
    line({ type: "event", event: "message", text: JSON.stringify(process.argv.slice(3)) })
    result({ command: "checkin", claim: null })
  })
} else if (command === "spawn") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  line({ type: "event", event: "message", text: String(child.pid) })
  setInterval(() => {}, 1000)
} else if (command === "leak") {
  // A child that keeps the engine's output open after the engine has ended.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: ["ignore", "inherit", "ignore"],
  })
  line({ type: "event", event: "message", text: String(child.pid) })
  result({ command: "checkin", claim: null })
  child.unref()
  process.exit(0)
} else if (command === "hang") {
  setInterval(() => {}, 1000)
} else {
  line({ type: "event", event: "message", text: "no result follows" })
  process.exitCode = 1
}
