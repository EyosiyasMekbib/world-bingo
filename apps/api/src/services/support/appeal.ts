/**
 * "Appeal" — the one-tap alternative to the app and the bot both saying
 * "contact support" at a restricted or suspended player. Opens (or reopens)
 * their support thread with a SYSTEM line naming the coarse category, so a
 * clerk sees it land in the unassigned queue like any other thread rather
 * than the player having to explain from scratch why they are writing in.
 */

import redis from '../../lib/redis.js'
import { SupportService } from './support.service.js'
import { afterSupportMessage } from './fanout.js'
import { AccountStatusService } from '../account-status.service.js'
import { STATUS_CATEGORY_LABELS, SupportMessageSource } from '@world-bingo/shared-types'

const COOLDOWN_KEY_PREFIX = 'tg:appeal:'
const COOLDOWN_SECS = 600

export class AlreadyActiveError extends Error {
  constructor() {
    super('Your account is already active — nothing to appeal')
  }
}

/**
 * Opens the appeal thread. Rate-limited per user, independent of the
 * ordinary support message limit — a restricted player mashing one button
 * must not be able to flood the queue with identical lines. A repeat within
 * the cooldown is a no-op, same philosophy as SupportService.escalate's own
 * idempotency, reported back via the return value (false) so a caller like
 * the bot's /appeal command can say "already in progress" rather than
 * implying a fresh one was just filed.
 */
export async function openAppeal(userId: string, source: SupportMessageSource): Promise<boolean> {
  const info = await AccountStatusService.playerView(userId)
  if (info.status === 'ACTIVE') throw new AlreadyActiveError()

  const key = `${COOLDOWN_KEY_PREFIX}${userId}`
  const isFirst = (await redis.incr(key)) === 1
  if (isFirst) await redis.expire(key, COOLDOWN_SECS)
  else return false

  const label = info.category ? (STATUS_CATEGORY_LABELS[info.category] ?? info.category) : 'an account review'
  const conversation = await SupportService.ensureConversationFor(userId)
  const result = await SupportService.addMessage({
    conversationId: conversation.id,
    senderRole: 'SYSTEM',
    senderId: null,
    body: `Appeal: this player's account is ${info.status.toLowerCase()}, category — ${label}.`,
    source,
  })

  await afterSupportMessage({ conversationId: conversation.id, message: result.message, ownerId: result.ownerId })
  return true
}
