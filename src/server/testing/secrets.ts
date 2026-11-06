import { randomBytes, randomInt } from "node:crypto"

// Credentials for tests, new on every run (node:crypto): nothing in the repository works as a password, key or
// token anywhere. A test file keeps one value for the whole file when several consumers must agree on it.

/** 32 random bytes as base64url (43 characters): an auth secret or a settings key. */
export const testSecret = () => randomBytes(32).toString("base64url")

/** 24 characters, inside the owner password's 12 to 128. */
export const testPassword = () => randomBytes(18).toString("base64url")

/** The shape Telegram gives a bot token and src/server/config.ts accepts: digits, a colon, 36 more characters. */
export const testBotToken = () => `${randomInt(1_000_000, 10_000_000)}:${randomBytes(27).toString("base64url")}`
