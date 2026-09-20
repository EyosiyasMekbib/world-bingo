/**
 * Mirrors support messages into the staff Telegram group, one forum topic
 * per conversation, and carries ops alerts into a pinned topic. The other
 * direction — a clerk's reply IN the topic reaching the conversation — is
 * services/telegram/staff-handlers.ts, which calls SupportService directly
 * the same way the socket gateway does.
 *
 * Entirely inert when TELEGRAM_SUPPORT_GROUP_ID is not set: player linking,
 * pushes and the player-side bot bridge all keep working, clerks just stay
 * on the admin inbox. See gateways/telegram/config.ts.
 */

import prisma from '../../lib/prisma.js'
import { telegramClient } from '../../gateways/telegram/client.js'
import { isStaffBridgeEnabled, supportGroupId, opsTopicId, adminBaseUrl } from '../../gateways/telegram/config.js'
import { maskPhone } from './phone.js'
import { escapeHtml } from './notify.js'
import type { SupportMessage } from '@world-bingo/shared-types'

/** Only the fields messageLine() actually reads — satisfied by both a wire
 *  SupportMessage and a raw Prisma SupportMessage row, so the history
 *  backfill below needs no cast between the two shapes. */
interface MessageLike {
  senderRole: string
  body: string
  attachmentUrl: string | null
}

/** How many prior messages the topic header includes when a topic is first
 *  created, so staff have context without a full transcript dump. */
const HEADER_HISTORY_LIMIT = 5
const SENDER_LABEL: Record<string, string> = {
  PLAYER: '🧑 Player',
  AGENT: '🎧 Agent',
  SYSTEM: 'ℹ️ System',
  AI: '🤖 AI',
}

async function buildTopicName(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, serial: true },
  })
  const who = user?.username ?? `player #${user?.serial ?? '?'}`
  return `${who} · ${userId.slice(0, 8)}`
}

async function buildTopicHeader(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, phone: true, accountStatus: true, serial: true },
  })
  const lines = [
    `<b>${escapeHtml(user?.username ?? `Player #${user?.serial ?? '?'}`)}</b>`,
    `Phone: ${maskPhone(user?.phone)}`,
    `Status: ${user?.accountStatus ?? 'ACTIVE'}`,
  ]
  const admin = adminBaseUrl()
  if (admin) lines.push(`<a href="${admin}/support?user=${userId}">Open in admin inbox</a>`)
  return lines.join('\n')
}

function messageLine(message: MessageLike): string {
  const label = SENDER_LABEL[message.senderRole] ?? message.senderRole
  const attachment = message.attachmentUrl ? `\n📎 ${message.attachmentUrl}` : ''
  return `${label}: ${escapeHtml(message.body)}${attachment}`
}

/**
 * Ensure a forum topic exists for this conversation and post `message` into
 * it. Creates the topic (with a header + recent history) on first use and
 * persists telegramTopicId. A no-op, not an error, when the staff bridge is
 * disabled or the conversation's owner has no db row (deleted mid-flight) —
 * every caller treats this as fire-and-forget, same as every other
 * post-commit effect in this codebase.
 */
export async function mirrorToStaffTopic(conversationId: string, message: SupportMessage): Promise<void> {
  if (!isStaffBridgeEnabled()) return
  const groupId = supportGroupId()!
  const client = telegramClient()

  const conversation = await prisma.supportConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true, telegramTopicId: true },
  })
  if (!conversation) return

  let topicId = conversation.telegramTopicId
  if (!topicId) {
    const name = await buildTopicName(conversation.userId)
    const topic = await client.createForumTopic(groupId, name)
    topicId = topic.message_thread_id

    // Written before the header/history posts below: if THOSE fail partway
    // (Telegram hiccup), the topic id is already saved and the next message
    // reuses this topic instead of creating a duplicate one.
    await prisma.supportConversation
      .update({ where: { id: conversationId }, data: { telegramTopicId: topicId } })
      .catch(() => {})

    await client.sendMessagePlain(groupId, await buildTopicHeader(conversation.userId), topicId).catch(() => {})

    const history = await prisma.supportMessage.findMany({
      where: { conversationId, id: { not: message.id } },
      orderBy: { createdAt: 'desc' },
      take: HEADER_HISTORY_LIMIT,
    })
    if (history.length > 0) {
      const lines = history.reverse().map((m) => messageLine(m)).join('\n')
      await client.sendMessagePlain(groupId, lines, topicId).catch(() => {})
    }
  }

  await client.sendMessage({ chatId: groupId, text: messageLine(message), messageThreadId: topicId })
}

/** The /player command in a topic — re-posts the same header a topic gets
 *  on creation, for when staff want a reminder mid-conversation. */
export async function postPlayerHeader(conversationId: string): Promise<void> {
  if (!isStaffBridgeEnabled()) return
  const conversation = await prisma.supportConversation.findUnique({
    where: { id: conversationId },
    select: { userId: true, telegramTopicId: true },
  })
  if (!conversation?.telegramTopicId) return
  await telegramClient().sendMessagePlain(
    supportGroupId()!,
    await buildTopicHeader(conversation.userId),
    conversation.telegramTopicId,
  )
}

export async function closeStaffTopic(conversationId: string): Promise<void> {
  if (!isStaffBridgeEnabled()) return
  const conversation = await prisma.supportConversation.findUnique({
    where: { id: conversationId },
    select: { telegramTopicId: true },
  })
  if (!conversation?.telegramTopicId) return
  await telegramClient().closeForumTopic(supportGroupId()!, conversation.telegramTopicId)
}

export async function reopenStaffTopic(conversationId: string): Promise<void> {
  if (!isStaffBridgeEnabled()) return
  const conversation = await prisma.supportConversation.findUnique({
    where: { id: conversationId },
    select: { telegramTopicId: true },
  })
  if (!conversation?.telegramTopicId) return
  await telegramClient().reopenForumTopic(supportGroupId()!, conversation.telegramTopicId)
}

/**
 * One-way alerts into the pinned ops topic — manual-review queues, gateway
 * float, stuck games. A no-op when TELEGRAM_OPS_TOPIC_ID is not set, so
 * existing alert call sites can adopt this without a configuration bump
 * being required first.
 */
export async function postOpsAlert(text: string): Promise<void> {
  if (!isStaffBridgeEnabled()) return
  const topicId = opsTopicId()
  if (!topicId) return
  await telegramClient()
    .sendMessage({ chatId: supportGroupId()!, text, messageThreadId: topicId })
    .catch((err) => console.error('[TelegramOps] alert failed:', (err as Error)?.message))
}
