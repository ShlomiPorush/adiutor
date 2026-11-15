import type { Language } from "../../shared/enums.ts"
import en from "../../shared/locales/en.json"
import he from "../../shared/locales/he.json"

/**
 * The pages the authorization server renders itself, through its documented sources: the device flow's code entry and
 * code comparison (each carries the library's own form, with its protection against cross-site posts, exactly as the
 * library hands it over), its done page, and its error page (`renderError`). In the owner's language (the language
 * setting, as the morning message reads it: these pages have no script, so the browser's cached copy that the app's
 * own pages read is out of reach), right to left in Hebrew, light or dark as the system asks, in the product's look.
 * Every value is escaped; no script of their own.
 */
export type ProviderPages = {
  /** Enter the code. `problem` after a wrong, expired or used code, a refused request, too many tries, or a failure. */
  codeInput(language: Language, form: string, problem?: CodeProblem): string
  /** Compare the code with the one the agent shows, then continue to the approval page. */
  codeConfirm(language: Language, form: string, userCode: string, name: string): string
  /** The agent is connected. */
  success(language: Language): string
  /** Any error page of the authorization server, by its error code. */
  error(language: Language, code: string): string
}

export type CodeProblem = "wrong" | "denied" | "limited" | "other"

type Texts = typeof en.agentPages & { app: string }
const TEXTS: Record<Language, Texts> = {
  en: { ...en.agentPages, app: en.app.name },
  he: { ...he.agentPages, app: he.app.name },
}

const html = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch)

/** The product's tokens (src/web/styles/ui.css), light and dark by the system's choice; the fonts of the system. */
const STYLE = `
:root{--ui-font:"Onest Variable","Noto Sans Hebrew Variable",system-ui,sans-serif;--ui-mono:"IBM Plex Mono",ui-monospace,monospace;--ui-fs:14px;--ui-fs-sm:12.5px;--ui-fs-meta:12px;--ui-fs-ctl:13px;--ui-h1:28px;--ui-h1-phone:24px;--ui-fs-field-phone:16px;--ui-radius:12px;--ui-radius-sm:8px;--ui-radius-tag:6px;--ui-gap:14px;--ui-ctl-h:34px;--ui-touch:44px;--ui-bg:#ffffff;--ui-panel:#f4f6f5;--ui-ink:#111814;--ui-muted:#5e6863;--ui-line:#e3e7e5;--ui-accent:#111814;--ui-on-accent:#ffffff;--ui-focus:#1f5fbf;--ui-ok:#12803f;--ui-warn:#9a6200;--ui-fail:#c42b1c;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--ui-bg:#0e1110;--ui-panel:#171b19;--ui-ink:#f2f5f3;--ui-muted:#97a29c;--ui-line:#262c29;--ui-accent:#f2f5f3;--ui-on-accent:#0e1110;--ui-focus:#7db3ff;--ui-ok:#3fcf7f;--ui-warn:#f0b03f;--ui-fail:#ff6b61;color-scheme:dark}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{font-family:var(--ui-font);font-size:var(--ui-fs);line-height:1.45;color:var(--ui-ink);background:var(--ui-bg);-webkit-text-size-adjust:100%}
:focus-visible{outline:2px solid var(--ui-focus);outline-offset:2px}
main{display:grid;place-items:center;min-height:100vh;min-height:100dvh;padding:32px 16px}
.col{display:grid;gap:18px;width:100%;max-width:400px}
.brand{display:flex;align-items:center;gap:10px;font-weight:750;font-size:16px}
.mark{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:var(--ui-radius-sm);background:var(--ui-accent);color:var(--ui-on-accent)}
.mark svg{width:20px;height:20px}
h1{margin:0;font-size:var(--ui-h1);font-weight:800;letter-spacing:-0.035em;line-height:1.1}
p{margin:0;color:var(--ui-muted)}
.box{display:grid;gap:10px;padding:16px;border:1px solid var(--ui-line);border-radius:var(--ui-radius);background:var(--ui-bg)}
.box p{color:var(--ui-ink)}
.label{font-size:var(--ui-fs-sm);font-weight:600;color:var(--ui-muted)}
.code{display:grid;gap:4px;padding:12px 14px;border:1px solid var(--ui-line);border-radius:var(--ui-radius-sm);background:var(--ui-panel)}
.code b{font-family:var(--ui-mono);font-size:var(--ui-h1);font-weight:700;letter-spacing:0.12em;justify-self:start}
.name{font-size:16px;font-weight:700}
.tag{display:inline-block;padding:1px 7px;border-radius:var(--ui-radius-tag);font-size:var(--ui-fs-meta);font-weight:700;color:var(--ui-warn);background:color-mix(in srgb,var(--ui-warn) 14%,transparent);vertical-align:1px}
.banner{padding:12px 14px;border-radius:var(--ui-radius);color:var(--ui-ink);background:color-mix(in srgb,var(--ui-fail) 13%,transparent);border-inline-start:4px solid var(--ui-fail)}
.banner.ok{background:color-mix(in srgb,var(--ui-ok) 13%,transparent);border-inline-start-color:var(--ui-ok)}
.banner.plain{background:var(--ui-panel);border-inline-start-color:var(--ui-muted)}
.banner b{display:block;margin-bottom:2px;font-weight:700;color:var(--ui-fail)}
.banner.ok b{color:var(--ui-ok)}
.banner.plain b{color:var(--ui-ink)}
.banner p{color:var(--ui-ink)}
form{margin:0}
.col>form{display:contents}
form input[type=text]{display:block;width:100%;height:var(--ui-ctl-h);padding:0 10px;border:1px solid var(--ui-line);border-radius:var(--ui-radius-sm);background:var(--ui-bg);color:var(--ui-ink);font-family:var(--ui-mono);font-size:16px;letter-spacing:0.12em;text-align:center;text-transform:uppercase;direction:ltr}
form input[type=text]::placeholder{color:transparent}
form input[type=text]:focus{outline:none;border-color:var(--ui-accent)}
form input[type=text]:focus-visible{outline:2px solid var(--ui-focus);outline-offset:2px}
.actions{display:flex;justify-content:flex-end;gap:8px}
button{font:inherit;display:inline-flex;align-items:center;justify-content:center;flex:1;height:var(--ui-ctl-h);padding:0 14px;border:1px solid var(--ui-line);border-radius:var(--ui-radius-sm);background:var(--ui-bg);color:var(--ui-ink);font-size:var(--ui-fs-ctl);font-weight:600;cursor:pointer}
button.primary{border-color:var(--ui-accent);background:var(--ui-accent);color:var(--ui-on-accent)}
@media (hover:hover){button:hover{border-color:var(--ui-muted)}button.primary:hover{opacity:.9}}
@media (max-width:760px){h1{font-size:var(--ui-h1-phone)}button{height:var(--ui-touch)}form input[type=text]{height:var(--ui-touch);font-size:var(--ui-fs-field-phone)}}
`

/** The product's mark (BrandIcon in src/web/shell/Shell.tsx). */
const MARK = `<span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg></span>`

function page(language: Language, title: string, body: string): string {
  const t = TEXTS[language]
  return `<!doctype html>
<html lang="${language}" dir="${language === "he" ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${html(title)} - ${html(t.app)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="col">
<div class="brand">${MARK}<span>${html(t.app)}</span></div>
<h1>${html(title)}</h1>
${body}
</div>
</main>
</body>
</html>`
}

/** A notice in its status colour; without a title where the page's own title already says it. */
const banner = (title: string | null, text: string, tone: "fail" | "ok" | "plain" = "fail") =>
  `<div class="banner${tone === "fail" ? "" : ` ${tone}`}" role="${tone === "fail" ? "alert" : "status"}">${title ? `<b>${html(title)}</b>` : ""}<p>${html(text)}</p></div>`

/** The error pages' sentences, by the library's error code; any other code gets the general one. */
const ERROR_CODES = [
  "access_denied",
  "expired_token",
  "invalid_request",
  "invalid_client",
  "invalid_target",
  "invalid_redirect_uri",
] as const

export const defaultPages: ProviderPages = {
  codeInput(language, form, problem) {
    const t = TEXTS[language]
    if (problem === "denied") return page(language, t.notConnected, banner(null, t.denied, "plain"))
    const note =
      problem === "wrong"
        ? banner(t.wrongTitle, t.wrongCode)
        : problem === "limited"
          ? banner(t.limitedTitle, t.limited)
          : problem
            ? banner(t.failedTitle, t.failed)
            : ""
    // Without the library's form (too many codes tried: the limit answers before the library), only the note.
    if (!form) return page(language, t.codeTitle, note)
    return page(
      language,
      t.codeTitle,
      `<p>${html(t.codeLead)}</p>
${note}
<div class="box">
<span class="label">${html(t.code)}</span>
${form}
<div class="actions"><button type="submit" class="primary" form="op.deviceInputForm">${html(t.continue)}</button></div>
</div>`,
    )
  },
  codeConfirm(language, form, userCode, name) {
    const t = TEXTS[language]
    return page(
      language,
      t.confirmTitle,
      `<p>${html(t.confirmLead)}</p>
<div class="box">
<div class="code"><span class="label">${html(t.code)}</span><b><bdi dir="ltr">${html(userCode)}</bdi></b></div>
<p class="name"><bdi dir="auto">${html(name)}</bdi> <span class="tag">${html(t.nameTag)}</span></p>
<p>${html(t.confirmText)}</p>
</div>
${form}
<div class="actions">
<button type="submit" form="op.deviceConfirmForm" name="abort" value="yes">${html(t.cancel)}</button>
<button type="submit" class="primary" form="op.deviceConfirmForm">${html(t.confirm)}</button>
</div>`,
    )
  },
  success(language) {
    const t = TEXTS[language]
    return page(language, t.doneTitle, banner(null, t.doneText, "ok"))
  },
  error(language, code) {
    const t = TEXTS[language]
    const known = (ERROR_CODES as readonly string[]).includes(code) ? (code as (typeof ERROR_CODES)[number]) : null
    return page(language, t.notConnected, banner(null, known ? t.errors[known] : t.errors.other))
  },
}
