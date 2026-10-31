/**
 * Notification -> Telegram push policy and rendering.
 *
 * NotificationService.create() calls enqueueNotificationPush() right after
 * writing the row (see notification.service.ts). Everything here is about
 * WHETHER and HOW, never about delivery — that is telegram-send.worker.ts,
 * which re-reads the user's link state at send time rather than trusting
 * whatever was true at enqueue time.
 */

import { NotificationType } from '@world-bingo/shared-types'
import { getQueue, QUEUE_NAMES } from '../../lib/queue.js'
import { isEnabled, webBaseUrl } from '../../gateways/telegram/config.js'

/**
 * Excluded from the generic push:
 *   - SUPPORT_REPLY: services/support/fanout.ts delivers that message
 *     directly, as the reply itself, the moment it is sent. A second copy
 *     through this generic path would duplicate it in the chat.
 *   - GAME_STARTING: fires once per scheduled game a player has entered.
 *     Pushing every one would get the bot muted or blocked, which loses
 *     every OTHER notification too — worse than the one push it would add.
 */
const EXCLUDED_TYPES: ReadonlySet<NotificationType> = new Set([
  NotificationType.SUPPORT_REPLY,
  NotificationType.GAME_STARTING,
])

export function isPushedType(type: NotificationType): boolean {
  return !EXCLUDED_TYPES.has(type)
}

/** Where the "Open" button sends the player. No entry (or an empty
 *  WEB_BASE_URL) means the push carries no button — the text still lands. */
const LANDING_PATH: Partial<Record<NotificationType, string>> = {
  [NotificationType.DEPOSIT_APPROVED]: '/wallet',
  [NotificationType.DEPOSIT_REJECTED]: '/wallet',
  [NotificationType.WITHDRAWAL_PROCESSED]: '/wallet',
  [NotificationType.REFUND_PROCESSED]: '/wallet',
  [NotificationType.BONUS_GRANTED]: '/wallet',
  [NotificationType.BONUS_EXPIRING]: '/wallet',
  [NotificationType.CASHBACK_AWARDED]: '/wallet',
  [NotificationType.GAME_WON]: '/transactions',
  [NotificationType.REFERRAL_BONUS]: '/refer',
  [NotificationType.TOURNAMENT_STARTING]: '/tournaments',
  [NotificationType.TOURNAMENT_WON]: '/tournaments',
  [NotificationType.TOURNAMENT_ELIMINATED]: '/tournaments',
  [NotificationType.CAMPAIGN_MESSAGE]: '/promotions',
  [NotificationType.PREDICTION_SETTLED]: '/predictions',
  [NotificationType.PREDICTION_VOIDED]: '/predictions',
  [NotificationType.ACCOUNT_STATUS_CHANGED]: '/profile',
}

/** Telegram's HTML parse mode only allows a small tag set. Exported for
 *  every other module in gateways/telegram and services/telegram that sends
 *  HTML-mode text built from data that might contain "<" or "&" — a
 *  username, a support message body, a free-text account-status reason. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface RenderedPush {
  text: string
  buttonLabel?: string
  buttonUrl?: string
}

export function renderPush(type: NotificationType, title: string, body: string): RenderedPush {
  const text = `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`
  const path = LANDING_PATH[type]
  const base = webBaseUrl()
  if (!path || !base) return { text }
  return { text, buttonLabel: 'Open', buttonUrl: `${base}${path}` }
}

export interface TelegramSendJobData {
  userId: string
  text: string
  buttonLabel?: string
  buttonUrl?: string
  /** 'notification' is gated by telegramNotifyEnabled at send time;
   *  'support-reply' (player-bridge.ts) never is — see
   *  docs/telegram-support-bot.md §5.3. Both are still dropped for a chat
   *  that blocked the bot. */
  kind: 'notification' | 'support-reply'
}

/**
 * Enqueue a push for a notification just written. Cheap and safe to call
 * unconditionally — it is itself the enabled/excluded/landing-page gate,
 * so every caller (today, just NotificationService.create) needs no
 * knowledge of Telegram at all.
 */
export async function enqueueNotificationPush(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
): Promise<void> {
  if (!isEnabled() || !isPushedType(type)) return
  const rendered = renderPush(type, title, body)
  const data: TelegramSendJobData = {
    userId,
    text: rendered.text,
    buttonLabel: rendered.buttonLabel,
    buttonUrl: rendered.buttonUrl,
    kind: 'notification',
  }
  await getQueue(QUEUE_NAMES.TELEGRAM_SEND).add('push', data)
}
