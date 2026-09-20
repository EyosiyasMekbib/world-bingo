/**
 * Telegram side effects shared by every place a support message can
 * originate: the web socket gateway, the bot's player handlers, and the
 * bot's staff-group handlers. Each of those calls SupportService.addMessage
 * (or .resolve / the reopen path inside addMessage) itself and then calls
 * here, past its own commit — same "post-commit, must never fail the
 * caller" discipline support.gateway.ts already follows for its socket
 * emits and notifications.
 *
 * One rule, uniform regardless of where the message came from: a PLAYER
 * message mirrors into the staff Telegram topic; an AGENT/SYSTEM/AI message
 * forwards to the player's Telegram DM. That direction is what actually
 * delivers a reply typed in the staff topic back to the player, and what
 * delivers a reply typed in the admin inbox to a player who is on Telegram —
 * both go through the exact same call.
 */

import type { SupportMessage } from '@world-bingo/shared-types'
import { mirrorToStaffTopic, closeStaffTopic, reopenStaffTopic } from '../telegram/staff-bridge.js'
import { forwardSupportMessageToPlayer } from '../telegram/player-bridge.js'

/**
 * PLAYER mirrors to the staff topic only — a clerk isn't the audience for
 * their own reply reaching back at them, whether they typed it in the admin
 * inbox or in the topic itself. AGENT/AI forwards to the player only, same
 * reasoning in reverse. SYSTEM (escalation acks, appeals) goes BOTH ways:
 * it is informational to whichever side did not trigger it, and to staff
 * even when the trigger WAS the player, since it is the visible marker that
 * something just happened to this thread — see SupportService.escalate and
 * services/support/appeal.ts.
 */
export async function afterSupportMessage(params: {
  conversationId: string
  message: SupportMessage
  ownerId: string
}): Promise<void> {
  const { senderRole } = params.message
  try {
    if (senderRole === 'PLAYER' || senderRole === 'SYSTEM') {
      await mirrorToStaffTopic(params.conversationId, params.message)
    }
    if (senderRole === 'AGENT' || senderRole === 'AI' || senderRole === 'SYSTEM') {
      await forwardSupportMessageToPlayer(params.ownerId, params.message)
    }
  } catch (err) {
    console.error('[support.fanout] message mirror/forward failed:', (err as Error)?.message)
  }
}

export async function afterConversationResolved(conversationId: string): Promise<void> {
  await closeStaffTopic(conversationId).catch((err) =>
    console.error('[support.fanout] close topic failed:', (err as Error)?.message),
  )
}

export async function afterConversationReopened(conversationId: string): Promise<void> {
  await reopenStaffTopic(conversationId).catch((err) =>
    console.error('[support.fanout] reopen topic failed:', (err as Error)?.message),
  )
}
