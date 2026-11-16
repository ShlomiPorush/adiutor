import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Hono } from "hono"

/*
 * The agent skill, served by Adiutor itself with its address and version filled in, so the owner only tells an agent
 * where Adiutor is (the agent-access standard, distribution-and-versioning, "Serving the files"). Public: the files hold
 * no secret and no data. Mounted with agent access only (oauth/routes.ts), and served only while agents are on and the
 * public URL has the safe shape: an agent runs what it downloads here.
 */

/** The skill's files, in the layout of the folder an agent installs, and how each is served. */
export const SKILL_FILES: Record<string, string> = {
  "SKILL.md": "text/markdown; charset=utf-8",
  "scripts/adiutor": "text/plain; charset=utf-8",
  "scripts/adiutor.mjs": "text/javascript; charset=utf-8",
  "scripts/adiutor.ps1": "text/plain; charset=utf-8",
  "scripts/adiutor.sh": "text/plain; charset=utf-8",
}
/** Where agents install the skill from. */
export const SKILL_PATH = "/agents/skill/"
const URL_PLACEHOLDER = /__ADIUTOR_URL__/g
const VERSION_PLACEHOLDER = /__ADIUTOR_SKILL_VERSION__/g
/**
 * The sentence of SKILL.md that names Adiutor, and the same with the address: a served copy reads right for this
 * installation, while the copy in Git names no address. Exactly once in SKILL.md (skill.integration.test.ts).
 */
export const SKILL_ANCHOR = "Adiutor is the owner's board of work items and notes."
const anchored = (issuer: string) => `Adiutor at ${issuer} is the owner's board of work items and notes.`
// The address goes into JavaScript, PowerShell and sh source, and the skill prints it in commands, so only an origin of
// this shape is filled in (the shape the skill's scripts accept).
const SAFE_ORIGIN = /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:[1-9][0-9]{0,4})?$/

/**
 * Whether agents may fetch the skill from this address: https, or http to this computer, and nothing in it a shell or
 * the scripts' languages would treat as code.
 */
export function servesSkill(issuer: string): boolean {
  if (!SAFE_ORIGIN.test(issuer)) return false
  const url = new URL(issuer)
  return url.protocol === "https:" || ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
}

/** What GET /agents/skill/ answers: where each file goes, and how to go on. For agents, so in English. */
function installNote(issuer: string): string {
  const list = Object.keys(SKILL_FILES)
    .map((f) => `- ${issuer}${SKILL_PATH}${f} -> adiutor/${f}`)
    .join("\n")
  const host = new URL(issuer).host.replace(/[^a-z0-9.-]/gi, "-")
  return `# Install the adiutor skill

Download these files into a folder named \`adiutor\` in your personal skills folder (Claude Code:
\`~/.claude/skills/\`, or \`$CLAUDE_CONFIG_DIR/skills/\` when it is set; Codex: \`~/.codex/skills/\`):

${list}

On Linux and macOS, make \`scripts/adiutor\` and \`scripts/adiutor.sh\` executable (\`chmod +x\`).

Change an existing \`adiutor\` folder only when an agent installed it from this address (you know it, or the person
confirms it). If it names another Adiutor address, install into \`adiutor-${host}\` instead, under the same rule. Any
other copy (from Git, a tool, or a link) works as it is: connect with \`adiutor connect --url "${issuer}"\`.

The connection lives in the user's home folder (\`~/.adiutor\`), not in the skill's folder, so installing again needs no
new approval. Every agent of the computer user shares it: when one is connected already, \`adiutor connect\` answers
\`already_connected\`.

Then read the new \`adiutor/SKILL.md\` now, without waiting for skills to reload, and follow its Connecting steps. Show
the person the link and the code that \`adiutor connect\` prints in the reply that ends your turn.
`
}

/** The skill's files as shipped, with line ends made LF so the sh scripts work from a Windows checkout. */
function readSkill(dir: string | undefined) {
  if (!dir) return null
  const files = new Map<string, string>()
  try {
    for (const name of Object.keys(SKILL_FILES))
      files.set(name, readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n"))
  } catch {
    return null
  }
  // The served version: a short hash of every file's name and content, in a fixed order.
  const hash = createHash("sha256")
  for (const [name, text] of files) hash.update(`${name}\n${text.length}\n${text}`)
  return { files, version: hash.digest("hex").slice(0, 12) }
}

/** The version a served copy of this build's skill sends in X-Adiutor-Skill, or null when the build has none. */
export function servedSkillVersion(dir: string | undefined): string | null {
  return readSkill(dir)?.version ?? null
}

/**
 * GET /agents/skill/ (the install note) and GET /agents/skill/<file>: each file by the list's own name, never by the
 * name in the request, with the address and the version filled in. Only while `live()` (agents on) and for an issuer of
 * the safe shape; otherwise 404 with a message for the owner. Never cached.
 */
export function skillRoutes(issuer: string | null, live: () => Promise<boolean>, dir: string | undefined) {
  const app = new Hono()
  const skill = readSkill(dir)
  const headers = (type: string) => ({
    "Content-Type": type,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  })
  app.get(`${SKILL_PATH}*`, async (c) => {
    if (!issuer || !servesSkill(issuer) || !(await live()))
      return c.json(
        {
          error: "not_configured",
          message:
            "Agents install the skill once agents are on in Settings, Agent access, and the public URL is an https address with a plain host name.",
        },
        404,
        { "Cache-Control": "no-cache" },
      )
    if (!skill) return c.json({ error: "not_found", message: "This build has no agent skill." }, 404)
    const file = new URL(c.req.url).pathname.slice(SKILL_PATH.length)
    if (file === "") return c.body(installNote(issuer), 200, headers("text/markdown; charset=utf-8"))
    const name = Object.keys(SKILL_FILES).find((f) => f === file)
    const text = name ? skill.files.get(name) : undefined
    if (!name || text === undefined) return c.json({ error: "not_found", message: "No such file." }, 404)
    const filled = text.replace(URL_PLACEHOLDER, issuer).replace(VERSION_PLACEHOLDER, skill.version)
    const served = name === "SKILL.md" ? filled.replace(SKILL_ANCHOR, anchored(issuer)) : filled
    return c.body(served, 200, headers(SKILL_FILES[name] as string))
  })
  return app
}
