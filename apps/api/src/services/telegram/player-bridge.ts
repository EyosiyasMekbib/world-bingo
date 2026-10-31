/**
 * Forwards a staff or system support message to the player's linked
 * Telegram chat. The counterpart to staff-bridge.ts's mirrorToStaffTopic —
 * together they are the two directions services/support/fanout.ts drives.
 *
 * Goes through the same telegram-send queue as notify.ts's generic pushes
 * (retries, rate-limiting, blocked-user handling all come for free) but
 * bypasses its type/landing-page policy entirely: a support reply is not a
 * notification, it is the conversation itself, and it is never gated by
 * telegramNotifyEnabled — see docs/telegram-support-bot.md §5.3.
 */

import { getQueue, QUEUE_NAMES } from '../../lib/queue.js'
import { isEnabled } from '../../gateways/telegram/config.js'
import { escapeHtml } from './notify.js'
import type { TelegramSendJobData } from './notify.js'
import type { SupportMessage } from '@world-bingo/shared-types'

const SENDER_LABEL: Record<string, string> = {
  AGENT: 'Support',
  SYSTEM: 'World Bingo',
  AI: 'Support',
}

export async function forwardSupportMessageToPlayer(userId: string, message: SupportMessage): Promise<void> {
  if (!isEnabled()) return
  const label = SENDER_LABEL[message.senderRole] ?? 'Support'
  const attachment = message.attachmentUrl ? `\n📎 ${escapeHtml(message.attachmentUrl)}` : ''
  const text = `<b>${label}</b>\n${escapeHtml(message.body)}${attachment}`
  const data: TelegramSendJobData = { userId, text, kind: 'support-reply' }
  await getQueue(QUEUE_NAMES.TELEGRAM_SEND).add('support-reply', data)
}
