/**
 * Handles a Telegram `message` update from the staff support GROUP. The
 * counterpart to player-handlers.ts; routes/telegram/webhook.ts tells them
 * apart by chat type. Every action here mirrors what a clerk could do from
 * the admin inbox — this is a second front-end onto SupportService, never a
 * second set of rules.
 */

import prisma from '../../lib/prisma.js'
import { telegramClient } from '../../gateways/telegram/client.js'
import type { TelegramUpdate } from '../../gateways/telegram/client.js'
import { supportGroupId } from '../../gateways/telegram/config.js'
import { goOnShift, goOffShift, touchShift } from './shift.service.js'
import { postPlayerHeader } from './staff-bridge.js'
import { SupportService } from '../support/support.service.js'
import { afterSupportMessage, afterConversationResolved, afterConversationReopened } from '../support/fanout.js'
import { writeSupportAudit } from '../support/support-audit.js'
import { SupportMessageSource } from '@world-bingo/shared-types'

type GroupMessage = NonNullable<TelegramUpdate['message']>

const STAFF_ROLES = new Set(['CLERK', 'ADMIN', 'SUPER_ADMIN'])
const ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN'])
const QUEUE_PREVIEW_LIMIT = 5

function client() {
  return telegramClient()
}

async function reply(chatId: string, text: string, topicId?: number): Promise<void> {
  await client().sendMessagePlain(chatId, text, topicId)
}

async function notifyUnlinked(chatId: string, topicId?: number): Promise<void> {
  await reply(chatId, 'Link your account from the admin app first (Profile → Link my Telegram), then try again.', topicId)
}

export async function handleStaffGroupMessage(message: GroupMessage): Promise<void> {
  const chatId = String(message.chat.id)
  // Only the ONE configured group is ever bridged — see
  // gateways/telegram/config.ts. Anything else (the bot added to a random
  // group) is ignored outright, not even an error reply.
  if (chatId !== supportGroupId()) return

  const text = (message.text ?? '').trim()
  const topicId = message.message_thread_id
  const fromId = message.from?.id ? String(message.from.id) : null
  if (!fromId || message.from?.is_bot) return

  const staffUser = await prisma.user.findUnique({
    where: { telegramChatId: fromId },
    select: { id: true, role: true, username: true },
  })
  const isStaff = !!staffUser && STAFF_ROLES.has(staffUser.role)
  if (isStaff) await touchShift(staffUser.id)

  // ── Commands that work anywhere in the group, no topic needed ─────────
  // Gated on `isStaff` (role-checked), not merely `staffUser` (linked at
  // all) — a linked PLAYER account must not be able to take shift or read
  // the queue just because its chat id happens to be in this group.
  if (text === '/onshift' || text === '/offshift') {
    if (!isStaff) return notifyUnlinked(chatId, topicId)
    if (text === '/onshift') await goOnShift(staffUser!.id)
    else await goOffShift(staffUser!.id)
    return reply(chatId, text === '/onshift' ? "You're on shift." : "You're off shift.", topicId)
  }

  if (text === '/queue') {
    if (!isStaff) return notifyUnlinked(chatId, topicId)
    return sendQueueSummary(chatId, topicId)
  }

  // Everything below acts on ONE conversation, identified by the topic this
  // message was posted in. A message in the group's General thread (no
  // topic) that isn't one of the commands above has nothing to attach to.
  if (!topicId) return

  const conversation = await prisma.supportConversation.findFirst({
    where: { telegramTopicId: topicId },
    select: { id: true, userId: true },
  })
  if (!conversation) return

  if (!isStaff) return notifyUnlinked(chatId, topicId)
  // isStaff === true guarantees staffUser is non-null (see its definition
  // above) — TypeScript cannot see through that, so this is the one place
  // that says so. Every use below reads `staff`, never `staffUser`.
  const staff = staffUser!

  const isAdmin = ADMIN_ROLES.has(staff.role)

  if (text === '/assign') {
    try {
      await SupportService.claim(conversation.id, staff.id)
      await writeSupportAudit(staff.id, 'support.claim', conversation.id, { channel: 'telegram' }).catch(() => {})
      return reply(chatId, `Assigned to ${staff.username ?? 'you'}.`, topicId)
    } catch {
      return reply(chatId, 'Could not assign — it may already be assigned or resolved.', topicId)
    }
  }

  if (text === '/release') {
    try {
      await SupportService.release(conversation.id, staff.id, isAdmin)
      await writeSupportAudit(staff.id, 'support.release', conversation.id, {
        channel: 'telegram',
        forced: isAdmin,
      }).catch(() => {})
      return reply(chatId, 'Released back to the queue.', topicId)
    } catch {
      return reply(chatId, 'Could not release — it may not be assigned.', topicId)
    }
  }

  if (text === '/resolve') {
    try {
      await SupportService.resolve(conversation.id, staff.id, isAdmin)
      await writeSupportAudit(staff.id, 'support.resolve', conversation.id, { channel: 'telegram' }).catch(() => {})
      await afterConversationResolved(conversation.id)
      return reply(chatId, 'Resolved.', topicId)
    } catch {
      return reply(chatId, 'Could not resolve.', topicId)
    }
  }

  if (text === '/player') {
    return postPlayerHeader(conversation.id)
  }

  if (text.startsWith('/note')) {
    const note = text.slice('/note'.length).trim()
    if (!note) return reply(chatId, 'Usage: /note <text> — staff-only, never sent to the player.', topicId)
    await writeSupportAudit(staff.id, 'support.note', conversation.id, { channel: 'telegram', note }).catch(() => {})
    return reply(chatId, 'Noted (staff-only).', topicId)
  }

  // Anything else typed in a topic is a reply to the player.
  if (!text) return

  const result = await SupportService.addMessage({
    conversationId: conversation.id,
    senderRole: 'AGENT',
    senderId: staff.id,
    body: text,
    source: SupportMessageSource.TELEGRAM,
  })

  // First reply claims the thread — mirrors the admin inbox, where opening
  // a thread to answer it is what "claim" means in practice. Best-effort:
  // ConversationNotOpenError just means someone/something already holds it
  // (an explicit /assign moments earlier, another clerk), which is a normal
  // outcome here, not a failure worth reporting.
  await SupportService.claim(conversation.id, staff.id).catch(() => {})

  await afterSupportMessage({ conversationId: conversation.id, message: result.message, ownerId: result.ownerId })
  if (result.reopened) await afterConversationReopened(conversation.id)
}

async function sendQueueSummary(chatId: string, topicId?: number): Promise<void> {
  const [items, unassignedCount] = await Promise.all([
    SupportService.listQueue('unassigned', ''),
    SupportService.unassignedCount(),
  ])
  if (unassignedCount === 0) {
    await reply(chatId, 'Queue is empty.', topicId)
    return
  }
  const lines = items
    .slice(0, QUEUE_PREVIEW_LIMIT)
    .map((item) => `• ${item.username} — ${item.lastMessagePreview.slice(0, 60)}`)
  await reply(chatId, `${unassignedCount} unassigned.\n${lines.join('\n')}`, topicId)
}
