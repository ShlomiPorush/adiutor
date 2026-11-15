// The one address of the Adiutor under test, as the browser opens it: E2E_BASE_URL, which scripts/verify.sh sets to
// its stack's ADIUTOR_PUBLIC_URL, else the development stack's documented address. The server refuses a browser
// change whose Origin differs from its public URL, so every page, expected text and command uses this value.
// Passkeys need a host name: browsers refuse an IP address such as 127.0.0.1 as a passkey's domain.

export const BASE_URL = new URL(process.env.E2E_BASE_URL ?? "http://127.0.0.1:8090").origin

/** Whether passkeys can be tested here: the address names a host, not an IP address. */
export const passkeysTestable = () => !/^[\d.]+$|^\[/.test(new URL(BASE_URL).hostname)

/** BASE_URL with its regular-expression characters escaped, for toHaveURL. */
export const BASE_URL_PATTERN = BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
