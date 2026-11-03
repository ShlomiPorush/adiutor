// @vitest-environment happy-dom
// Two-factor enrolment: the QR code names the account after the username, not the synthetic e-mail Better Auth puts
// in its totpURI, and the key shown as text is the one Better Auth made.

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { I18nProvider } from "../../i18n/i18n.tsx"
import { TotpStep } from "./SetupPage.tsx"

const enrol = vi.hoisted(() => ({ totpURI: "", drawn: [] as string[] }))

vi.mock("../../api/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/auth.ts")>()
  return {
    ...real,
    authClient: {
      twoFactor: {
        enable: () => Promise.resolve({ data: { totpURI: enrol.totpURI, backupCodes: [] }, error: null }),
      },
    },
  }
})

vi.mock("qrcode", () => ({
  default: {
    toDataURL: (text: string) => {
      enrol.drawn.push(text)
      return Promise.resolve("data:image/png;base64,")
    },
  },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it("draws the QR code with the username as the account name and shows Better Auth's key", async () => {
  // A new base32 secret per run: no working value in the repository.
  const secret = Array.from(
    { length: 32 },
    () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(Math.random() * 32)],
  ).join("")
  const query = `?secret=${secret}&issuer=Mikud&digits=6&period=30`
  enrol.totpURI = `otpauth://totp/Mikud:owner.name%40mikud.local${query}`
  enrol.drawn = []

  await act(async () => {
    root.render(
      <I18nProvider>
        <TotpStep known={crypto.randomUUID()} onEnrolled={() => {}} />
      </I18nProvider>,
    )
  })

  await vi.waitFor(() => expect(enrol.drawn).toEqual([`otpauth://totp/Mikud:owner.name${query}`]))
  expect(container.querySelector("[data-testid=totp-secret]")?.textContent).toContain(secret)
})
