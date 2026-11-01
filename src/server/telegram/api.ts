import type { TelegramHtml } from "./html.ts"

/**
 * Why a Bot API call failed, as a code that is safe to log and store:
 * - `answer`: Telegram's own JSON answer with `ok: false` and a 4xx code. Definite: nothing was done.
 * - `not_sent`: the request never reached the server (DNS, connection refused, unreachable). Definite.
 * - `uncertain`: the request may have reached Telegram: a timeout, a reset, a 5xx (Telegram's or a
 *   gateway's), or an answer that is not Telegram's JSON (a gateway's HTML page, for example).
 * - `aborted`: the caller stopped it (shutdown).
 */
export type TelegramFailure = "answer" | "not_sent" | "uncertain" | "aborted"

/** A failed Bot API call. Its message holds the method and a code only: never the token, the URL or text. */
export class TelegramError extends Error {
  override name = "TelegramError"
  constructor(
    readonly failure: TelegramFailure,
    /** `telegram_<error_code>` for an answer (telegram_400, telegram_429...), else the failure itself. */
    readonly code: string,
    method: string,
    /** Seconds Telegram asked us to wait (429). */
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${method} failed: ${code}`)
  }
}

/** Connection errors that mean the request never left this machine or never reached a server. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"])

function causeCode(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === "string") return code
    e = (e as { cause?: unknown }).cause
  }
  return undefined
}

export type TelegramMessage = {
  message_id: number
  date: number
  chat: { id: number; type: string }
  from?: { id: number; is_bot: boolean }
  text?: string
}

export type TelegramUpdate = { update_id: number; message?: TelegramMessage }

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** The few Bot API methods Mikud uses. Messages use HTML parse mode and never show a link preview. */
export class BotApi {
  private readonly base: string

  constructor(
    token: string,
    apiUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    // The token is part of the path; this string is never logged or put into an error.
    this.base = `${apiUrl.replace(/\/+$/, "")}/bot${token}`
  }

  private async call<T>(method: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (error) {
      if (signal?.aborted) throw new TelegramError("aborted", "aborted", method)
      if (timeout.aborted) throw new TelegramError("uncertain", "timeout", method)
      const code = causeCode(error)
      if (code && NOT_SENT_CODES.has(code)) throw new TelegramError("not_sent", "network", method)
      throw new TelegramError("uncertain", "network", method)
    }
    let json: { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } }
    try {
      json = (await response.json()) as typeof json
    } catch {
      if (signal?.aborted) throw new TelegramError("aborted", "aborted", method)
      // Not Telegram's answer (a gateway's page, a cut-off body): Telegram may still have done the work.
      const code = response.status >= 400 ? `telegram_${response.status}` : "bad_answer"
      throw new TelegramError("uncertain", code, method)
    }
    if (json?.ok !== true) {
      const errorCode = json?.error_code
      const fromTelegram = json?.ok === false && typeof errorCode === "number" && Number.isInteger(errorCode)
      const status = fromTelegram ? errorCode : response.status
      // Only Telegram's own refusal (4xx) proves nothing was done; a 5xx or a foreign answer may hide a send.
      const definite = fromTelegram && status >= 400 && status < 500
      throw new TelegramError(
        definite ? "answer" : "uncertain",
        `telegram_${status}`,
        method,
        json?.parameters?.retry_after,
      )
    }
    return json.result as T
  }

  /** Long poll: waits up to `timeoutSeconds` for updates after `offset`; only `message` updates. */
  getUpdates(offset: number | undefined, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      { ...(offset !== undefined ? { offset } : {}), timeout: timeoutSeconds, allowed_updates: ["message"] },
      (timeoutSeconds + 15) * 1000,
      signal,
    )
  }

  async sendMessage(chatId: string, text: TelegramHtml, signal?: AbortSignal): Promise<number> {
    const result = await this.call<{ message_id: number }>(
      "sendMessage",
      { chat_id: chatId, text: String(text), parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      20_000,
      signal,
    )
    return result.message_id
  }
}
