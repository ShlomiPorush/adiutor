import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

// The web UI. Paths resolve from this file, so run Vite from the repository root with
// --config config/vite.config.ts. The production build goes to dist/web, which the server serves.
const repo = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))

// The typed mock API (src/web/api/mock) is compiled in only when VITE_MIKUD_MOCK=1 is set for a
// development run or a screenshot build. The production build defines __MIKUD_MOCK__ as false, so
// the bundler drops the mock entirely; scripts/lib/web-dist-check.sh fails if it ever ships.
const mock = process.env.VITE_MIKUD_MOCK === "1"

const FONT_LICENCES: Record<string, string> = {
  onest: "node_modules/@fontsource-variable/onest/LICENSE",
  "noto-sans-hebrew": "node_modules/@fontsource-variable/noto-sans-hebrew/LICENSE",
  "ibm-plex-mono": "node_modules/@fontsource/ibm-plex-mono/LICENSE",
}

/** Ships the SIL Open Font License of each bundled font next to the font files. */
function fontLicences(): Plugin {
  return {
    name: "mikud-font-licences",
    apply: "build",
    generateBundle() {
      for (const [name, path] of Object.entries(FONT_LICENCES)) {
        this.emitFile({
          type: "asset",
          fileName: `assets/${name}-LICENSE.txt`,
          source: readFileSync(repo(path), "utf8"),
        })
      }
    },
  }
}

export default defineConfig({
  root: repo("src/web"),
  publicDir: repo("src/web/public"),
  envDir: false,
  plugins: [react(), fontLicences()],
  define: { __MIKUD_MOCK__: JSON.stringify(mock) },
  build: {
    outDir: repo("dist/web"),
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
    // Fonts are always files: an inlined data URL would hide them from the asset check.
    assetsInlineLimit: 0,
    // One bundle for a single-user app on a private network: React, the router, TanStack Query and
    // zod (through the shared codes) are most of it, and splitting buys nothing here.
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // Without the mock, development talks to the local stack (scripts/local.sh, port 8090).
    proxy: mock ? undefined : { "/api": "http://127.0.0.1:8090" },
  },
  preview: { host: "127.0.0.1", port: 4173 },
})
