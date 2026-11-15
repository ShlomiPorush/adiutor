/**
 * The pages the authorization server renders itself: the device flow's code entry and code comparison (they carry the
 * library's form with its protection against cross-site posts), its done page, and its error page. Plain and English
 * for now: the agent access pages make them localized in both themes. Every value is escaped; no script.
 */
export type ProviderPages = {
  /** Enter the code. `problem` after a wrong, expired or used code, or a cancelled request. */
  codeInput(form: string, problem?: "wrong" | "denied" | "other"): string
  /** Compare the code with the one the agent shows, then continue to the approval page. */
  codeConfirm(form: string, userCode: string, name: string): string
  /** The agent is connected. */
  success(): string
  /** Any error page of the authorization server, by its error code. */
  error(code: string): string
}

const html = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch)

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${html(title)} - Adiutor</title>
</head>
<body>
<main>
<h1>${html(title)}</h1>
${body}
</main>
</body>
</html>`

const ERRORS: Record<string, string> = {
  access_denied: "The connection was not approved. You can close this page.",
  expired_token: "This code has expired. Start the connection again in your agent.",
  invalid_request: "This link is not valid any more. Start the connection again in your agent.",
  invalid_client: "This agent is not known here. Start the connection again in your agent.",
  invalid_target: "This agent asked for something Adiutor does not offer.",
  invalid_redirect_uri: "This agent asked to be sent back to an address it did not register.",
}

export const defaultPages: ProviderPages = {
  codeInput: (form, problem) =>
    problem === "denied"
      ? page("Not connected", "<p>The connection was not approved. You can close this page.</p>")
      : page(
          "Connect an agent",
          `${
            problem === "wrong"
              ? '<p role="alert">That code is not valid. Check it in your agent and try again.</p>'
              : problem
                ? '<p role="alert">That did not work. Start the connection again in your agent.</p>'
                : "<p>Enter the code your agent shows.</p>"
          }
${form}
<button type="submit" form="op.deviceInputForm">Continue</button>`,
        ),
  codeConfirm: (form, userCode, name) =>
    page(
      "Does your agent show this code?",
      `<p><strong>${html(userCode)}</strong></p>
<p>${html(name)} (the name the agent gives itself) asks to connect to Adiutor. Continue only if you started this yourself and your agent shows the same code.</p>
${form}
<button type="submit" form="op.deviceConfirmForm">Yes, continue</button>
<button type="submit" form="op.deviceConfirmForm" name="abort" value="yes">Cancel</button>`,
    ),
  success: () => page("Agent connected", "<p>You can close this page and return to your agent.</p>"),
  error: (code) =>
    page(
      "Not connected",
      `<p>${html(ERRORS[code] ?? "Something went wrong with this connection. Start it again in your agent.")}</p>`,
    ),
}
