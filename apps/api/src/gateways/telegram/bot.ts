/**
 * Boot sequence for the Telegram support bot. Call startTelegramBot() once
 * from index.ts, after the HTTP server is listening (so webhookUrl() points
 * at a server that can actually answer it). A no-op when the bot is
 * disabled — see config.ts — so nothing here ever blocks or slows down a
 * boot with no Telegram configuration.
 */

import { telegramClient } from './client.js'
import { isEnabled, webhookUrl, webhookSecret, setBotUsername, WEBHOOK_PATH } from './config.js'

const RETRY_INTERVAL_MS = 60_000

async function registerWebhook(): Promise<boolean> {
  const url = webhookUrl()
  if (!url) {
    console.warn('[Telegram] API_BASE_URL is not set — cannot register the webhook yet')
    return false
  }
  try {
    const client = telegramClient()
    const me = await client.getMe()
    setBotUsername(me.username)
    await client.setWebhook(url, webhookSecret())
    console.log(`[Telegram] bot @${me.username} webhook registered at ${WEBHOOK_PATH}`)
    return true
  } catch (err) {
    console.error('[Telegram] webhook registration failed, will retry:', (err as Error)?.message)
    return false
  }
}

/**
 * Fire-and-forget by design: a boot must never hang or fail because
 * Telegram's API happens to be unreachable at that instant. Keeps retrying
 * every minute until setWebhook succeeds, then stops.
 */
export function startTelegramBot(): void {
  if (!isEnabled()) {
    console.log('[Telegram] bot disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET to enable)')
    return
  }
  void (async () => {
    while (!(await registerWebhook())) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS))
    }
  })()
}
