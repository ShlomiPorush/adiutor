import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { main } from "./cli.ts"
import { aclEntries, type ConnectDeps, connect, defaultEnvFile, withSyncUrl } from "./connect.ts"
import { parseEnvFile } from "./env.ts"
import type { Runner } from "./exec.ts"
import { type FakeAdiutor, startFakeAdiutor } from "./fake-adiutor.ts"

// `connect` against a stand-in Adiutor over real HTTP: the device grant for the sync area, the approval, and the env
// file. Every token and code is new on every run.

let fake: FakeAdiutor
const temps: string[] = []
beforeAll(async () => {
  fake = await startFakeAdiutor()
})
afterAll(() => fake.close())
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
  fake.grantScope = "sync"
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "adiutor-connect-"))
  temps.push(dir)
  return dir
}

/** The sync's dependencies for one computer user; the owner answers on the second poll (`answer`). */
function deps(answer: "approve" | "deny" | "none" = "approve", overrides: Partial<ConnectDeps> = {}) {
  const home = tempDir()
  const lines: string[] = []
  const ran: { command: string; args: string[] }[] = []
  let sleeps = 0
  const runner: Runner = async (command, args) => {
    ran.push({ command, args })
    return { code: 0, stdout: "", stderr: "" }
  }
  const value: ConnectDeps = {
    fetch: (input, init) => fetch(input, init),
    out: (line) => lines.push(line),
    runner,
    findCommand: async () => undefined,
    systemCommand: async (name) => `C:\\Windows\\System32\\${name}.exe`,
    platform: "linux",
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    sleep: async () => {
      if (++sleeps === 2 && answer === "approve") fake.approve()
      if (sleeps === 2 && answer === "deny") fake.deny()
      await new Promise((resolve) => setTimeout(resolve, 1))
    },
    now: () => Date.now(),
    ...overrides,
  }
  return { deps: value, lines, ran, home, output: () => lines.join("\n"), envFile: join(home, "adiutor", "sync.env") }
}

const options = (envFile: string, more: { replace?: boolean; open?: boolean } = {}) => ({
  url: fake.issuer,
  name: "Laptop sync",
  envFile,
  open: more.open ?? false,
  replace: more.replace ?? false,
})

describe("connect", () => {
  it("connects with a code for the sync area, keeps the connection and writes the address into the env file", async () => {
    const d = deps()
    const devices = fake.counts.device
    expect((await connect(options(d.envFile), d.deps)).exit).toBe(0)
    expect(fake.counts.device - devices).toBe(1)
    expect(fake.last).toMatchObject({ scope: "sync", label: "Laptop sync", resource: `${fake.issuer}/api/v1` })
    const text = d.output()
    expect(text).toMatch(new RegExp(`Approve the sync in Adiutor: ${fake.issuer}/connect/code\\?user_code=`))
    expect(text).toMatch(/shows the code [A-Z0-9]{4}-[A-Z0-9]{4}/)
    expect(text).toContain('Connected "Laptop sync" (sync)')
    for (const secret of fake.secrets()) expect(text).not.toContain(secret)
    expect(parseEnvFile(readFileSync(d.envFile, "utf8"))).toEqual({ ADIUTOR_URL: fake.issuer })
    expect(statSync(d.envFile).mode & 0o777).toBe(0o600)
    // Nothing in the env file is a secret now; the connection is kept in its own folder.
    expect(readFileSync(d.envFile, "utf8")).not.toMatch(/TOKEN/)
  })

  it("says it is connected already, and connects again with --replace, ending the old connection", async () => {
    const d = deps()
    expect((await connect(options(d.envFile), d.deps)).exit).toBe(0)
    const devices = fake.counts.device
    const again = deps("approve", { env: d.deps.env })
    expect((await connect(options(d.envFile), again.deps)).exit).toBe(0)
    expect(fake.counts.device).toBe(devices)
    expect(again.output()).toContain("connected to")
    expect(again.output()).toContain("add --replace")
    const alive = fake.aliveGrants()
    const replaced = deps("approve", { env: d.deps.env })
    expect((await connect(options(d.envFile, { replace: true }), replaced.deps)).exit).toBe(0)
    expect(fake.counts.device - devices).toBe(1)
    expect(fake.aliveGrants()).toBe(alive)
  })

  it("stops when the owner denies, and says when the sync area was not approved", async () => {
    const denied = deps("deny")
    expect((await connect(options(denied.envFile), denied.deps)).exit).toBe(1)
    expect(denied.output()).toContain("connect: The owner did not approve the connection.")
    fake.grantScope = "read"
    const narrow = deps()
    expect((await connect(options(narrow.envFile), narrow.deps)).exit).toBe(0)
    expect(narrow.output()).toContain("The sync area was not approved")
  })

  it("opens the approval page without a shell", async () => {
    const d = deps()
    expect((await connect(options(d.envFile, { open: true }), d.deps)).exit).toBe(0)
    expect(d.ran[0]).toEqual({ command: "xdg-open", args: [expect.stringMatching(/\/connect\/code\?user_code=/)] })
  })

  it("on Windows, refuses the env file before asking Adiutor when icacls is not in System32", async () => {
    const d = deps("approve", {
      platform: "win32",
      systemCommand: async () => undefined,
    })
    d.deps.env = { ...d.deps.env, USERNAME: "owner", USERDOMAIN: "PC" }
    const devices = fake.counts.device
    expect((await connect(options(join(d.home, "sync.env")), d.deps)).exit).toBe(1)
    expect(d.output()).toContain("icacls was not found")
    expect(fake.counts.device).toBe(devices)
  })
})

describe("the env file", () => {
  it("keeps every other line and exactly one ADIUTOR_URL", () => {
    const before = "# sync\nADIUTOR_URL=https://old.example.com\nT3CODE_CLI_PATH=C:\\t3.cmd\nexport ADIUTOR_URL=x\n"
    expect(withSyncUrl(before, "https://adiutor.example.com")).toBe(
      "# sync\nADIUTOR_URL=https://adiutor.example.com\nT3CODE_CLI_PATH=C:\\t3.cmd\n",
    )
    expect(withSyncUrl("", "https://adiutor.example.com")).toBe("ADIUTOR_URL=https://adiutor.example.com\n")
  })

  it("keeps an old ADIUTOR_AGENT_TOKEN line as it is: the run reports it", async () => {
    const d = deps()
    const dir = join(d.home, "adiutor")
    const file = join(dir, "sync.env")
    mkdirSync(dir, { recursive: true })
    const old = `ADIUTOR_AGENT_TOKEN=adt_${randomBytes(32).toString("hex")}`
    writeFileSync(file, `${old}\n`, { mode: 0o600 })
    expect((await connect(options(file), d.deps)).exit).toBe(0)
    expect(readFileSync(file, "utf8")).toBe(`${old}\nADIUTOR_URL=${fake.issuer}\n`)
  })

  it("reads icacls entries", () => {
    const path = "C:\\Users\\owner\\AppData\\Local\\adiutor\\sync.env"
    expect(aclEntries(`${path} PC\\owner:(F)\r\n\r\nSuccessfully processed 1 files`, path)).toEqual(["PC\\owner:(F)"])
  })

  it("keeps the env file outside every repository by default", () => {
    expect(defaultEnvFile("win32", { LOCALAPPDATA: "C:\\Users\\o\\AppData\\Local" })).toBe(
      "C:\\Users\\o\\AppData\\Local\\adiutor\\sync.env",
    )
    expect(defaultEnvFile("linux", { XDG_CONFIG_HOME: "/home/o/.config" })).toBe("/home/o/.config/adiutor/sync.env")
  })
})

describe("connect: the command line", () => {
  const run = async (argv: string[]) => {
    const lines: string[] = []
    const code = await main(argv, {
      env: {},
      runner: async () => ({ code: 0, stdout: "", stderr: "" }),
      fetch: async () => new Response("{}"),
      out: (line) => lines.push(line),
      now: () => new Date(),
      nodePath: "/fake/node",
    })
    return { code, text: lines.join("\n") }
  }

  it("refuses a missing name, and an address that is not https or this computer, or not a plain origin", async () => {
    expect((await run(["connect", "--url", "https://adiutor.example.com"])).code).toBe(2)
    for (const url of ["http://adiutor.example.com", "https://adiutor.example.com/app", "https://a$(id).example.com"]) {
      const r = await run(["connect", "--name", "x", "--url", url])
      expect([url, r.code]).toEqual([url, 2])
      expect(r.text).toContain("--url")
    }
    const old = await run(["connect", "--name", "x", "--for", "sync", "--url", "https://adiutor.example.com"])
    expect(old.code).toBe(2)
  })
})
