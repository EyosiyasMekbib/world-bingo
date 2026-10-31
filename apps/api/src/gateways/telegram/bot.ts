/**
 * Boot sequence for the Telegram support bot. Call startTelegramBot() once
 * from index.ts, after the HTTP server is listening (so webhookUrl() points
 * at a server that can actually answer it). A no-op when the bot is
 * disabled — see config.ts — so nothing here ever blocks or slows down a
 * boot with no Telegram configuration.
 */

import { telegramClient } from './client.js'
import {
  isEnabled,
  isStaffBridgeEnabled,
  supportGroupId,
  webhookUrl,
  webhookSecret,
  setBotUsername,
  WEBHOOK_PATH,
} from './config.js'

const RETRY_INTERVAL_MS = 60_000
const STAFF_GROUP_CHECK_INTERVAL_MS = 3_600_000

/** Returns the bot's own user id once the webhook is registered, null on
 *  failure. The id is what the staff-group check asks getChatMember about. */
async function registerWebhook(): Promise<number | null> {
  const url = webhookUrl()
  if (!url) {
    console.warn('[Telegram] API_BASE_URL is not set — cannot register the webhook yet')
    return null
  }
  try {
    const client = telegramClient()
    const me = await client.getMe()
    setBotUsername(me.username)
    await client.setWebhook(url, webhookSecret())
    console.log(`[Telegram] bot @${me.username} webhook registered at ${WEBHOOK_PATH}`)
    return me.id
  } catch (err) {
    console.error('[Telegram] webhook registration failed, will retry:', (err as Error)?.message)
    return null
  }
}

/**
 * §9: a wrong TELEGRAM_SUPPORT_GROUP_ID, a group without Topics, or a bot
 * that was removed or never made admin otherwise only shows up as a
 * createForumTopic failure on the next player message. This names the
 * problem, at boot and hourly after. It never throws and never disables
 * anything: the admin inbox works either way. Returns whether the group is
 * ready.
 */
export async function checkStaffGroup(botId: number): Promise<boolean> {
  const groupId = supportGroupId()
  if (!isStaffBridgeEnabled() || !groupId) return true
  try {
    const client = telegramClient()
    const chat = await client.getChat(groupId)
    const member = await client.getChatMember(groupId, botId)
    const problems: string[] = []
    if (chat.type !== 'supergroup') problems.push(`is a ${chat.type}, not a supergroup`)
    if (!chat.is_forum) problems.push('has Topics turned off')
    if (member.status !== 'administrator' && member.status !== 'creator') {
      problems.push(`has the bot as ${member.status}, not an admin`)
    } else if (member.status === 'administrator' && !member.can_manage_topics) {
      problems.push('does not give the bot the Manage Topics right')
    }
    if (problems.length > 0) {
      console.error(
        `[Telegram] staff group "${chat.title ?? groupId}" ${problems.join('; ')}. ` +
          'Support topics cannot be created; clerks must answer from the admin inbox.',
      )
      return false
    }
    console.log(`[Telegram] staff group "${chat.title ?? groupId}" ready`)
    return true
  } catch (err) {
    console.error(
      `[Telegram] staff group ${groupId} unreachable (${(err as Error)?.message}). ` +
        'Check TELEGRAM_SUPPORT_GROUP_ID and that the bot is still in the group; clerks must answer from the admin inbox.',
    )
    return false
  }
}

/**
 * Fire-and-forget by design: a boot must never hang or fail because
 * Telegram's API happens to be unreachable at that instant. Keeps retrying
 * every minute until setWebhook succeeds, then checks the staff group once
 * and hourly after.
 */
export function startTelegramBot(): void {
  if (!isEnabled()) {
    console.log('[Telegram] bot disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET to enable)')
    return
  }
  void (async () => {
    let botId: number | null
    while ((botId = await registerWebhook()) === null) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS))
    }
    const id = botId
    await checkStaffGroup(id)
    setInterval(() => void checkStaffGroup(id), STAFF_GROUP_CHECK_INTERVAL_MS).unref()
  })()
}
