import type { AuthHolder } from "../auth/auth.ts"
import { getSettings, type SettingsEnv, type SettingsRow } from "../services/admin.ts"
import type { Ctx } from "../services/context.ts"
import type { ReloadableSecretScanner } from "../services/secrets.ts"
import type { TelegramService } from "../telegram/runtime.ts"
import { effectivePrivateDomains, effectiveTelegram } from "./effective.ts"

export type SettingsRuntimeDeps = {
  ctx: Ctx
  env: SettingsEnv
  auth: AuthHolder
  telegram: TelegramService
  scanner: ReloadableSecretScanner
}

/**
 * Applies the owner's settings to what runs, without a restart: the private domains of the secret check, the Better
 * Auth instance (the idle length and the OTP route), and the bot with the morning job. Each part changes only when
 * its own values changed. Called at start and after every settings save.
 */
export class SettingsRuntime {
  constructor(readonly deps: SettingsRuntimeDeps) {}

  get env(): SettingsEnv {
    return this.deps.env
  }

  async apply(row?: SettingsRow): Promise<void> {
    const { ctx, env, auth, telegram, scanner } = this.deps
    const settings = row ?? (await getSettings(ctx.db))
    const pair = effectiveTelegram(settings, env.overrides, env.cipher)
    scanner.setPrivateDomains(effectivePrivateDomains(settings, env.overrides).value)
    auth.apply({
      sessionIdleDays: settings.sessionIdleDays,
      otpViaTelegram: settings.otpViaTelegram && pair.state === "on",
    })
    await telegram.reload(
      pair.state === "on" && pair.botToken && pair.chatId ? { botToken: pair.botToken, chatId: pair.chatId } : null,
    )
  }
}
