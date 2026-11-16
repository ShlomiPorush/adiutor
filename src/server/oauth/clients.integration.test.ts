import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { syncClient } from "../../sync/oauth.ts"
import { audit, authDeviceCode, items } from "../db/schema.ts"
import { createAgentKey } from "../testing/app.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import {
  answerConsent,
  browserCall,
  confirmCode,
  type Loose,
  type OAuthHarness,
  oauthHarness,
  ownerBy,
  SKILL_DIR,
} from "../testing/oauth.ts"
import { SKILL_FILES, servedSkillVersion } from "./skill.ts"

/*
 * The two clients against the real authorization server and agent channel, over HTTP (n8n-ops' skill.test.ts shape):
 * the agent skill's command (every version this computer runs: node, and sh with curl) as served at /agents/skill/
 * and as a copy from Git, and the sync's connection. Each connects with a code the owner approves, calls, and ends.
 * Then the skill of the releases before agent access, which used an agent key: no route code runs for it (D12).
 */

let t: TestDatabase
let h: OAuthHarness
const temp = mkdtempSync(join(tmpdir(), "adiutor-clients-"))
const impls = ["node", ...(spawnSync("curl", ["--version"], { stdio: "ignore" }).status === 0 ? ["sh"] : [])]

beforeAll(async () => {
  t = await createTestDatabase("agent_clients")
  h = await oauthHarness(t)
})
afterAll(async () => {
  await h?.close()
  await t?.close()
  rmSync(temp, { recursive: true, force: true })
})

/** A copy of the skill: from Git as it is, or as Adiutor serves it (optionally with another version). */
async function install(served: false | { version?: string }) {
  const dir = mkdtempSync(join(temp, "agent-"))
  const target = join(dir, "skills", "adiutor")
  if (!served) cpSync(SKILL_DIR, target, { recursive: true })
  else
    for (const name of Object.keys(SKILL_FILES)) {
      const res = await fetch(`${h.issuer}/agents/skill/${name}`)
      expect([name, res.status]).toEqual([name, 200])
      let text = await res.text()
      if (served.version) text = text.replaceAll(servedSkillVersion(SKILL_DIR) ?? "-", served.version)
      mkdirSync(join(target, name, ".."), { recursive: true })
      writeFileSync(join(target, name), text)
      if (name.startsWith("scripts/") && !name.endsWith(".ps1")) chmodSync(join(target, name), 0o755)
    }
  return { scripts: join(target, "scripts"), home: dir, creds: join(dir, "creds") }
}
type Install = Awaited<ReturnType<typeof install>>

function run(impl: string, inst: Install, args: string[], extra: Record<string, string> = {}) {
  const [cmd, pre] =
    impl === "node"
      ? [process.execPath, [join(inst.scripts, "adiutor.mjs")]]
      : ["sh", [join(inst.scripts, "adiutor.sh")]]
  return new Promise<{ code: number | null; json: Loose; out: string }>((resolve) => {
    const child = spawn(cmd as string, [...(pre as string[]), ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: inst.home,
        ADIUTOR_CREDENTIALS: inst.creds,
        ADIUTOR_NO_NODE: impl === "node" ? "" : "1",
        ADIUTOR_TEST_POLL_SECONDS: "1",
        ADIUTOR_WAIT_SECONDS: "20",
        ...extra,
      },
    })
    let out = ""
    child.stdout.on("data", (d) => {
      out += d
    })
    child.stderr.on("data", (d) => {
      out += d
    })
    child.on("close", (code) => {
      let json: Loose = null
      try {
        json = JSON.parse(out.trim().split("\n").at(-1) ?? "")
      } catch {}
      resolve({ code, json, out })
    })
  })
}

/** The owner types the code the agent showed, compares it, and approves with `areas`. */
async function approve(code: string, areas: string[]) {
  const uid = await confirmCode(h.owner, code)
  const consent = await answerConsent(h.owner, uid, { approve: true, areas })
  expect(consent.decision.status).toBe(200)
  await browserCall(h.owner, String(consent.decision.body.redirectTo))
  return consent.details.body
}

for (const impl of impls) {
  describe(`the skill's command (${impl})`, () => {
    it("connects from a Git copy with --url, reads, acts as --as, and disconnects for good", async () => {
      const inst = await install(false)
      const c = await run(impl, inst, ["connect", "--url", h.issuer])
      expect(c.json?.status, c.out).toBe("pending")
      expect(c.json.link).toBe(`${h.issuer}/connect/code?user_code=${c.json.code}`)
      const details = await approve(c.json.code, ["read", "write"])
      expect(details.client.name).toMatch(/^Agents on /)
      expect(details.areas).toEqual(["read", "write"])
      const w = await run(impl, inst, ["connect", "--wait", "--url", h.issuer])
      expect(w.json, w.out).toMatchObject({ status: "connected", scope: "read write" })

      // A copy from Git at this revision: no notice.
      const access = await run(impl, inst, ["access"])
      expect(access.json?.status, access.out).toBe(200)
      expect(access.json.data.areas.map((a: Loose) => a.area)).toEqual(["read", "write"])
      expect(access.json.data.update_skill).toBeUndefined()

      const items = await run(impl, inst, ["get", "/api/v1/items?limit=5"])
      expect(items.json?.status, items.out).toBe(200)
      const captured = await run(impl, inst, [
        "post",
        "/api/v1/capture",
        "--json",
        '{"text":"An idea from the skill"}',
        "--as",
        "claude",
      ])
      expect(captured.json?.status, captured.out).toBe(201)
      // A path the endpoints list does not hold is never sent.
      const closed = await run(impl, inst, ["get", "/api/v1/audit"])
      expect(closed.json?.error, closed.out).toBe("bad_path")

      const d = await run(impl, inst, ["disconnect"])
      expect(d.json, d.out).toEqual({ status: "disconnected" })
      const after = await run(impl, inst, ["get", "/api/v1/items"])
      expect(after.json?.error, after.out).toBe("not_connected")
    }, 120_000)

    it("as served at /agents/skill/: connects without --url, and is told when a newer skill is out", async () => {
      const inst = await install({})
      const c = await run(impl, inst, ["connect"])
      expect(c.json?.status, c.out).toBe("pending")
      await approve(c.json.code, ["read"])
      expect((await run(impl, inst, ["connect", "--wait"])).json?.status).toBe("connected")
      const current = await run(impl, inst, ["access"])
      expect(current.json?.status, current.out).toBe(200)
      expect(current.json.data.update_skill).toBeUndefined()
      // An older served copy, sharing the connection: a notice, never a block.
      const older = await install({ version: "000000000000" })
      const old = await run(impl, { ...older, home: inst.home, creds: inst.creds }, ["access"])
      expect(old.json?.status, old.out).toBe(200)
      expect(old.json.data.update_skill).toContain(`A newer skill is available at ${h.issuer}/agents/skill/`)
      // Only the read area: an act is refused by Adiutor before it runs.
      const act = await run(impl, inst, ["post", "/api/v1/capture", "--json", '{"text":"x"}'])
      expect(act.json?.error, act.out).toBe("bad_path")
      expect((await run(impl, inst, ["disconnect"])).json?.status).toBe("disconnected")
    }, 120_000)
  })
}

describe("the sync's connection", () => {
  it("connects for the sync area alone, pushes with the policy headers, and ends when the owner disconnects it", async () => {
    const home = mkdtempSync(join(temp, "sync-"))
    const deps = {
      fetch: (input: string, init: RequestInit) => fetch(input, init),
      runner: async () => ({ code: 1, stdout: "", stderr: "" }),
      systemCommand: async () => undefined,
      platform: "linux" as const,
      env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      now: () => Date.now(),
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      },
    }
    const client = syncClient(h.issuer, deps)
    await client.prepare()
    const device = await client.deviceCode("Laptop sync")
    const waiting = client.waitForApproval(device, "Laptop sync")
    const details = await approve(device.userCode, ["sync"])
    expect(details).toMatchObject({ client: { name: "Laptop sync" }, resource: "rest", areas: ["sync"] })
    expect((await waiting).scope).toBe("sync")

    const payload = { collectedAt: t.ctx.clock().toISOString(), projects: [], threads: [], failedProjects: [] }
    const pushed = await client.push("/api/v1/sync/t3", payload)
    expect(pushed).toMatchObject({ kind: "answer", status: 200 })

    const listed = await browserCall(h.owner, "/api/v1/agents/connections")
    const mine = listed.body.connections.find((c: Loose) => c.name === "Laptop sync")
    expect(mine).toMatchObject({ areas: ["sync"], via: "code", resource: "rest" })
    await h.access.disconnect(ownerBy, mine.id)
    const ended = await syncClient(h.issuer, { ...deps, now: () => Date.now() + 3_600_000 }).push(
      "/api/v1/sync/t3",
      payload,
    )
    expect(ended).toMatchObject({ kind: "failed", code: "connection_ended" })
  }, 120_000)

  it("disconnect revokes the refresh token, which ends the whole connection, the access token included", async () => {
    const home = mkdtempSync(join(temp, "sync-"))
    const deps = {
      fetch: (input: string, init: RequestInit) => fetch(input, init),
      runner: async () => ({ code: 1, stdout: "", stderr: "" }),
      systemCommand: async () => undefined,
      platform: "linux" as const,
      env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      now: () => Date.now(),
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      },
    }
    const client = syncClient(h.issuer, deps)
    await client.prepare()
    const device = await client.deviceCode("Desk sync")
    const waiting = client.waitForApproval(device, "Desk sync")
    await approve(device.userCode, ["sync"])
    await waiting
    const payload = { collectedAt: t.ctx.clock().toISOString(), projects: [], threads: [], failedProjects: [] }
    expect(await client.push("/api/v1/sync/t3", payload)).toMatchObject({ kind: "answer", status: 200 })
    const folder = join(home, ".config", "adiutor", "connection")
    const file = readdirSync(folder).find((name) => name.endsWith(".json")) as string
    const access = JSON.parse(readFileSync(join(folder, file), "utf8")).accessToken as string

    expect(await client.disconnect()).toEqual({ wasConnected: true, revocationPending: false })
    expect(readdirSync(folder).filter((name) => name.endsWith(".json"))).toEqual([])
    // The library removed the grant: its tokens are refused at once.
    const after = await fetch(`${h.issuer}/api/v1/agent/endpoints`, { headers: { authorization: `Bearer ${access}` } })
    expect(after.status).toBe(401)
    // Adiutor ends the connection's record after the library's grant.revoked event (oauth/access.ts), a moment later.
    const endsSoon = async () => {
      for (let i = 0; i < 100; i++) {
        const listed = await browserCall(h.owner, "/api/v1/agents/connections")
        if (!listed.body.connections.some((c: Loose) => c.name === "Desk sync")) return true
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return false
    }
    expect(await endsSoon()).toBe(true)
  }, 120_000)
})

describe("an old skill copy, which used an agent key (D12, the plan's rollout)", () => {
  // The Node version of the skill at b50f463, the last commit before the new clients, byte for byte.
  const OLD_SKILL = fileURLToPath(new URL("./testdata/adiutor-b50f463.mjs", import.meta.url))
  const OLD_SKILL_SHA256 = "0e632fe09a301aa49898125de2e6d52afb7543649451e30def162c682d925cea"

  /** Runs the old command with its connection folder (ADIUTOR_SKILL_HOME). */
  function old(home: string, args: string[]) {
    return new Promise<{ code: number | null; json: Loose; out: string }>((resolve) => {
      const child = spawn(process.execPath, [OLD_SKILL, ...args], {
        env: { PATH: process.env.PATH ?? "", HOME: home, ADIUTOR_SKILL_HOME: join(home, ".adiutor") },
      })
      let out = ""
      child.stdout.on("data", (d) => {
        out += d
      })
      child.stderr.on("data", (d) => {
        out += d
      })
      child.on("close", (code) => {
        let json: Loose = null
        try {
          json = JSON.parse(out.trim().split("\n").at(-1) ?? "")
        } catch {}
        resolve({ code, json, out })
      })
    })
  }

  /** What a route that ran would have left: items and every audit row but the agent channel's own. */
  const traces = async () => ({
    items: (await t.ctx.db.select({ id: items.id }).from(items)).length,
    rows: (await t.ctx.db.select({ action: audit.action }).from(audit)).filter((r) => !r.action.startsWith("agent.")),
  })

  it("is the copy of b50f463", () => {
    const text = readFileSync(OLD_SKILL, "utf8").replace(/\r\n/g, "\n")
    expect(createHash("sha256").update(text).digest("hex")).toBe(OLD_SKILL_SHA256)
  })

  for (const enabled of [true, false])
    it(`with agents ${enabled ? "on" : "off"}: its key runs no route code, it forgets the key, and cannot connect again`, async () => {
      await h.access.saveSettings(ownerBy, { enabled })
      try {
        // The connection the old command kept: a key Adiutor itself made, still valid for the api-key plugin.
        const key = await createAgentKey(h.core, "old skill")
        const home = mkdtempSync(join(temp, "old-"))
        mkdirSync(join(home, ".adiutor"), { mode: 0o700 })
        const record = { v: 1, origin: h.issuer, key, keyName: "skill:old:0a1b2c3d", expiresAt: "2099-01-01T00:00:00Z" }
        writeFileSync(join(home, ".adiutor", "connection"), JSON.stringify(record), { mode: 0o600 })
        const before = await traces()

        const posted = await old(home, ["post", "capture", "--json", '{"text":"An idea from an old skill"}'])
        expect(posted.json?.error, posted.out).toBe("connection_ended")
        expect(existsSync(join(home, ".adiutor", "connection"))).toBe(false)
        // MCP with the same key, as an old Claude Code or Codex setup sent it.
        const mcp = await fetch(`${h.issuer}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "adiutor_capture", arguments: { text: "An idea over MCP" } },
          }),
        })
        expect(mcp.status).toBe(401)
        expect(await traces()).toEqual(before)

        // Its connect asks Better Auth's closed device routes, and stops.
        const again = await old(home, ["connect", "--url", h.issuer])
        expect(again.json?.error, again.out).toBe("http_404")
        expect(await t.ctx.db.select().from(authDeviceCode)).toHaveLength(0)
        expect(await traces()).toEqual(before)
      } finally {
        await h.access.saveSettings(ownerBy, { enabled: true })
      }
    }, 60_000)
})
