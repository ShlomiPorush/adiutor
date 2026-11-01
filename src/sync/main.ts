// Entry point of dist/sync/mikud-sync.js. The logic lives in the imported modules so tests can drive it.
import { main } from "./cli.ts"
import { runProcess } from "./exec.ts"

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  runner: runProcess,
  fetch: (input, init) => fetch(input, init),
  out: (line) => console.log(line),
  now: () => new Date(),
  nodePath: process.execPath,
})
