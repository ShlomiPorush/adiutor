import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { SKILL_REVISION, updateSkillNotice } from "../agents/policy.ts"
import { SKILL_ANCHOR, SKILL_FILES, servedSkillVersion, servesSkill, skillRoutes } from "./skill.ts"

// Serving the agent skill (the agent-access standard, distribution-and-versioning, "Serving the files" and "The version
// notice"), in the shape of n8n-ops' oauth/skill.ts.

const skill = fileURLToPath(new URL("../../../skill/adiutor", import.meta.url))
const temp = mkdtempSync(join(tmpdir(), "adiutor-skill-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const app = (issuer: string | null, options: { on?: boolean; dir?: string } = {}) =>
  skillRoutes(issuer, async () => options.on ?? true, "dir" in options ? options.dir : skill)
const get = async (a: ReturnType<typeof app>, path: string) => {
  const res = await a.request(path)
  return { res, text: await res.text() }
}

describe("serving the skill", () => {
  it("serves each file with the address and the version filled in, never cached, as text", async () => {
    const a = app("https://adiutor.example.com")
    const version = servedSkillVersion(skill)
    expect(version).toMatch(/^[0-9a-f]{12}$/)
    for (const [name, type] of Object.entries(SKILL_FILES)) {
      const { res, text } = await get(a, `/agents/skill/${name}`)
      expect([name, res.status]).toEqual([name, 200])
      expect(res.headers.get("content-type")).toBe(type)
      expect(res.headers.get("cache-control")).toBe("no-cache")
      expect(res.headers.get("x-content-type-options")).toBe("nosniff")
      expect(text).not.toContain("__ADIUTOR_URL__")
      expect(text).not.toContain("__ADIUTOR_SKILL_VERSION__")
      expect(text).not.toContain("\r")
    }
    const mjs = (await get(a, "/agents/skill/scripts/adiutor.mjs")).text
    expect(mjs).toContain('const DEFAULT_URL = "https://adiutor.example.com"')
    expect(mjs).toContain(`const SKILL_VERSION = "${version}"`)
    expect((await get(a, "/agents/skill/scripts/adiutor.ps1")).text).toContain(
      "$DefaultUrl = 'https://adiutor.example.com'",
    )
    expect((await get(a, "/agents/skill/scripts/adiutor.sh")).text).toContain(
      'DEFAULT_URL="https://adiutor.example.com"',
    )
  })

  it("names this Adiutor in SKILL.md's one anchor sentence, which the copy in Git holds once and without an address", async () => {
    const shipped = readFileSync(join(skill, "SKILL.md"), "utf8")
    expect(shipped.split(SKILL_ANCHOR)).toHaveLength(2)
    const served = (await get(app("https://adiutor.example.com"), "/agents/skill/SKILL.md")).text
    expect(served).toContain("Adiutor at https://adiutor.example.com is the owner's board of work items and notes.")
    expect(served).not.toContain(SKILL_ANCHOR)
  })

  it("answers the install note: each file's address and place, executable bits, and the rule for an existing folder", async () => {
    const note = (await get(app("https://adiutor.example.com:8443"), "/agents/skill/")).text
    expect(note).toContain(
      "https://adiutor.example.com:8443/agents/skill/scripts/adiutor.ps1 -> adiutor/scripts/adiutor.ps1",
    )
    expect(note).toContain("chmod +x")
    expect(note).toContain("only when an agent installed it from this address")
    expect(note).toContain("install into `adiutor-adiutor.example.com-8443` instead")
    expect(note).toContain('adiutor connect --url "https://adiutor.example.com:8443"')
    expect(note).toContain("in the reply that ends your turn")
  })

  it("makes line ends LF, so a Windows checkout serves the same skill and version", async () => {
    const dir = join(temp, "crlf")
    cpSync(skill, dir, { recursive: true })
    const sh = join(dir, "scripts", "adiutor.sh")
    writeFileSync(sh, readFileSync(sh, "utf8").replace(/\n/g, "\r\n"))
    expect(servedSkillVersion(dir)).toBe(servedSkillVersion(skill))
    expect(
      (await get(app("https://adiutor.example.com", { dir }), "/agents/skill/scripts/adiutor.sh")).text,
    ).not.toContain("\r")
  })

  it("serves nothing while agents are off, for an address that is not safe, or a file not in the list", async () => {
    const off = await get(app("https://adiutor.example.com", { on: false }), "/agents/skill/SKILL.md")
    expect(off.res.status).toBe(404)
    expect(JSON.parse(off.text).error).toBe("not_configured")
    expect((await get(app(null), "/agents/skill/")).res.status).toBe(404)
    expect((await get(app("http://adiutor.example.com"), "/agents/skill/SKILL.md")).res.status).toBe(404)
    const a = app("https://adiutor.example.com")
    for (const path of [
      "/agents/skill/../package.json",
      "/agents/skill/scripts/other",
      "/agents/skill/skill.md",
      "/agents/skill/scripts/",
    ])
      expect([path, (await get(a, path)).res.status]).toEqual([path, 404])
    expect(
      (await get(app("https://adiutor.example.com", { dir: undefined }), "/agents/skill/SKILL.md")).res.status,
    ).toBe(404)
  })

  it("serves nothing for an address with characters the scripts or a shell would run", async () => {
    expect(servesSkill("http://127.0.0.1:8090")).toBe(true)
    expect(servesSkill("http://[::1]:8090")).toBe(true)
    expect(servesSkill("http://localhost:8090")).toBe(true)
    for (const issuer of [
      "https://$(id).example.com",
      "https://a';whoami;'.example.com",
      "https://a_b.example.com",
      "https://adiutor.example.com:0",
    ]) {
      expect(servesSkill(issuer), issuer).toBe(false)
      for (const file of ["", ...Object.keys(SKILL_FILES)]) {
        const { res, text } = await get(app(issuer), `/agents/skill/${file}`)
        expect([issuer, file, res.status]).toEqual([issuer, file, 404])
        expect(text).not.toContain(issuer)
      }
    }
  })
})

describe("the version notice (update_skill)", () => {
  const issuer = "https://adiutor.example.com"
  it("says nothing to a served copy of this build, or a copy from Git at this revision or newer", () => {
    expect(updateSkillNotice("a1b2c3d4e5f6", "a1b2c3d4e5f6", issuer)).toBeNull()
    expect(updateSkillNotice(`r${SKILL_REVISION}`, "a1b2c3d4e5f6", issuer)).toBeNull()
    expect(updateSkillNotice(`r${SKILL_REVISION + 1}`, null, issuer)).toBeNull()
  })

  it("tells an older Git copy to update where it came from, and any other copy where the newer skill is", () => {
    expect(updateSkillNotice(`r${SKILL_REVISION - 1}`, "a1b2c3d4e5f6", issuer)).toMatch(
      /older than this Adiutor.*Do not change its folder/,
    )
    for (const sent of ["0123456789ab", undefined, "something"])
      expect(updateSkillNotice(sent, "a1b2c3d4e5f6", issuer)).toContain(
        `A newer skill is available at ${issuer}/agents/skill/`,
      )
  })

  it("keeps SKILL_REVISION the same in the server and the skill's three scripts", () => {
    const scripts = join(skill, "scripts")
    expect(readFileSync(join(scripts, "adiutor.mjs"), "utf8")).toContain(`const SKILL_REVISION = ${SKILL_REVISION}\n`)
    expect(readFileSync(join(scripts, "adiutor.ps1"), "utf8")).toContain(`$SkillRevision = ${SKILL_REVISION}\n`)
    expect(readFileSync(join(scripts, "adiutor.sh"), "utf8")).toContain(`SKILL_REVISION=${SKILL_REVISION}\n`)
  })
})
