import prisma from '../../lib/prisma'
import type { SupportConversationStatus as PrismaSupportConversationStatus } from '@prisma/client'
import type {
  SupportConversation,
  SupportConversationWithMessages,
  SupportMessage,
  SupportQueueItem,
  SupportSenderRole,
} from '@world-bingo/shared-types'
import {
  ConversationNotFoundError,
  ConversationNotOpenError,
  NotParticipantError,
  StaleConversationError,
} from './errors'

/** How much history the widget and the inbox load on open. */
const HISTORY_LIMIT = 100

/** Statuses that count as "live" — exactly the set the partial unique index
 *  covers, so this constant and the migration must not drift apart. Exported so
 *  tests assert against it rather than against a second copy of the same list. */
export const LIVE_STATUSES = [
  'BOT',
  'OPEN',
  'ASSIGNED',
] as const satisfies readonly PrismaSupportConversationStatus[]

export interface AddMessageInput {
  conversationId: string
  senderRole: SupportSenderRole
  senderId: string | null
  body: string
  attachmentUrl?: string | null
  attachmentMime?: string | null
}

type ConversationRow = {
  id: string
  userId: string
  status: string
  assignedToId: string | null
  assignedTo?: { username: string } | null
  language: string
  escalatedAt: Date | null
  resolvedAt: Date | null
  lastMessageAt: Date
  createdAt: Date
}

type MessageRow = {
  id: string
  conversationId: string
  senderRole: string
  senderId: string | null
  body: string
  attachmentUrl: string | null
  attachmentMime: string | null
  createdAt: Date
}

function toWireConversation(row: ConversationRow): SupportConversation {
  return {
    id: row.id,
    userId: row.userId,
    status: row.status as SupportConversation['status'],
    assignedToId: row.assignedToId,
    assignedToUsername: row.assignedTo?.username ?? null,
    language: row.language,
    escalatedAt: row.escalatedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    lastMessageAt: row.lastMessageAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }
}

function toWireMessage(row: MessageRow): SupportMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderRole: row.senderRole as SupportSenderRole,
    senderId: row.senderId,
    body: row.body,
    attachmentUrl: row.attachmentUrl,
    attachmentMime: row.attachmentMime,
    createdAt: row.createdAt.toISOString(),
  }
}

export class SupportService {
  /**
   * Fetch the caller's live thread, creating one if they have none.
   *
   * New threads start OPEN while SUPPORT_AI_ENABLED is false. Phase 2 flips the
   * initial status to BOT so the AI answers first.
   */
  static async openForUser(userId: string): Promise<SupportConversationWithMessages> {
    const existing = await prisma.supportConversation.findFirst({
      where: {
        userId,
        status: { in: LIVE_STATUSES as unknown as PrismaSupportConversationStatus[] },
      },
      include: { assignedTo: { select: { username: true } } },
      orderBy: { lastMessageAt: 'desc' },
    })

    if (existing) return this.withHistory(existing as ConversationRow)

    const initialStatus = process.env.SUPPORT_AI_ENABLED === 'true' ? 'BOT' : 'OPEN'

    try {
      const created = await prisma.supportConversation.create({
        data: {
          userId,
          status: initialStatus as never,
          escalatedAt: initialStatus === 'OPEN' ? new Date() : null,
          lastMessageAt: new Date(),
        },
        include: { assignedTo: { select: { username: true } } },
      })
      return this.withHistory(created as ConversationRow)
    } catch (err) {
      // Two taps raced and this one lost the partial unique index. The other
      // insert already made a thread — read it rather than failing the click.
      if ((err as { code?: string })?.code !== 'P2002') throw err

      const winner = await prisma.supportConversation.findFirst({
        where: {
          userId,
          status: { in: LIVE_STATUSES as unknown as PrismaSupportConversationStatus[] },
        },
        include: { assignedTo: { select: { username: true } } },
        orderBy: { lastMessageAt: 'desc' },
      })
      if (!winner) throw err
      return this.withHistory(winner as ConversationRow)
    }
  }

  private static async withHistory(row: ConversationRow): Promise<SupportConversationWithMessages> {
    // Newest-first in the query, reversed for display. Ordering ascending
    // and taking 100 would return the OLDEST 100 messages — on a long or
    // repeatedly-reopened thread that silently hides everything recent,
    // which is the only part anyone needs.
    const messages = await prisma.supportMessage.findMany({
      where: { conversationId: row.id },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
    })
    return {
      conversation: toWireConversation(row),
      messages: (messages as MessageRow[]).reverse().map(toWireMessage),
    }
  }

  static async getById(conversationId: string): Promise<SupportConversation> {
    const row = await prisma.supportConversation.findUnique({
      where: { id: conversationId },
      include: { assignedTo: { select: { username: true } } },
    })
    if (!row) throw new ConversationNotFoundError()
    return toWireConversation(row as ConversationRow)
  }

  static async assertPlayerOwns(conversationId: string, userId: string): Promise<void> {
    const row = await prisma.supportConversation.findUnique({
      where: { id: conversationId },
      select: { userId: true },
    })
    if (!row) throw new ConversationNotFoundError()
    if (row.userId !== userId) throw new NotParticipantError()
  }

  /**
   * Append a message. Writing into a RESOLVED thread reopens it — never back
   * to BOT, because once a human has answered, routing the follow-up to a
   * bot reads as being brushed off. The two senders reopen differently:
   *
   *   - PLAYER: there is no clerk on this yet, so it goes OPEN with
   *     assignedToId cleared, landing back in the unassigned queue.
   *   - AGENT: an agent replying into a RESOLVED thread is continuing a
   *     conversation they (or another clerk) already own. RESOLVED is not
   *     in LIVE_STATUSES, so leaving the thread RESOLVED after the reply
   *     would strand it out of every queue filter (mine/unassigned/all)
   *     and out of openForUser — the player would never see the reply and
   *     no clerk could find the thread again. Reopening must also NOT clear
   *     assignedToId the way the player path does: that would unassign the
   *     very clerk who just replied. It goes ASSIGNED if someone still
   *     holds it, OPEN if nobody does.
   */
  static async addMessage(input: AddMessageInput): Promise<SupportMessage> {
    const body = input.body?.trim() ?? ''
    if (!body && !input.attachmentUrl) {
      throw new Error('Message body is empty')
    }

    const conversation = await prisma.supportConversation.findUnique({
      where: { id: input.conversationId },
    })
    if (!conversation) throw new ConversationNotFoundError()

    const playerReopening = conversation.status === 'RESOLVED' && input.senderRole === 'PLAYER'
    const agentReopening = conversation.status === 'RESOLVED' && input.senderRole === 'AGENT'
    const reopening = playerReopening || agentReopening

    if (reopening) {
      // Reopening while a newer live thread exists would insert a second
      // live row and trip the partial unique index. Applies to both paths:
      // if the player already opened a fresh thread since this one
      // resolved, flipping this old one back to live — whether the player
      // followed up or an agent replied into it — would collide with that
      // newer thread on the userId partial unique index.
      const newer = await prisma.supportConversation.findFirst({
        where: {
          userId: conversation.userId,
          status: { in: LIVE_STATUSES as unknown as PrismaSupportConversationStatus[] },
        },
        select: { id: true },
      })
      if (newer) throw new StaleConversationError()
    }

    const message = await prisma.supportMessage.create({
      data: {
        conversationId: input.conversationId,
        senderRole: input.senderRole as never,
        senderId: input.senderId,
        body,
        attachmentUrl: input.attachmentUrl ?? null,
        attachmentMime: input.attachmentMime ?? null,
      },
    })

    let updateData: Record<string, unknown>
    if (playerReopening) {
      updateData = {
        lastMessageAt: new Date(),
        status: 'OPEN' as never,
        resolvedAt: null,
        assignedToId: null,
        escalatedAt: new Date(),
      }
    } else if (agentReopening) {
      // Deliberately does NOT reuse the player branch's data object: setting
      // assignedToId: null here would unassign the clerk who just sent this
      // very message. Omitting the field entirely — rather than setting it
      // to its current value — leaves whatever is already in the DB
      // untouched, which is what "preserved" means for a partial update.
      updateData = {
        lastMessageAt: new Date(),
        status: (conversation.assignedToId ? 'ASSIGNED' : 'OPEN') as never,
        resolvedAt: null,
      }
    } else {
      updateData = { lastMessageAt: new Date() }
    }

    await prisma.supportConversation.update({
      where: { id: input.conversationId },
      data: updateData as never,
    })

    return toWireMessage(message as MessageRow)
  }

  /**
   * Claim an unassigned thread.
   *
   * The guard lives in the WHERE clause, not in a read-then-write: Postgres
   * serialises the two UPDATEs, so of two clerks pressing Claim at the same
   * instant, exactly one matches a row and the other matches none. Same
   * discipline as the cartela HSETNX reservation and the wallet
   * SELECT FOR UPDATE — no new locking primitive.
   */
  static async claim(conversationId: string, agentId: string): Promise<SupportConversation> {
    const { count } = await prisma.supportConversation.updateMany({
      where: { id: conversationId, status: 'OPEN' as never },
      data: { status: 'ASSIGNED' as never, assignedToId: agentId },
    })
    if (count === 0) throw new ConversationNotOpenError()
    return this.getById(conversationId)
  }

  /** Hand an assigned thread back to the queue. Admins may release any thread. */
  static async release(
    conversationId: string,
    agentId: string,
    isAdmin: boolean,
  ): Promise<SupportConversation> {
    const where = isAdmin
      ? { id: conversationId, status: 'ASSIGNED' as never }
      : { id: conversationId, status: 'ASSIGNED' as never, assignedToId: agentId }

    const { count } = await prisma.supportConversation.updateMany({
      where,
      data: { status: 'OPEN' as never, assignedToId: null },
    })
    if (count === 0) throw new ConversationNotOpenError()
    return this.getById(conversationId)
  }

  /**
   * Close a thread. A clerk may resolve one they hold or one nobody holds;
   * an admin may resolve any.
   */
  static async resolve(
    conversationId: string,
    agentId: string,
    isAdmin: boolean,
  ): Promise<SupportConversation> {
    const where: Record<string, unknown> = {
      id: conversationId,
      status: { in: ['OPEN', 'ASSIGNED'] },
    }
    if (!isAdmin) where.assignedToId = { in: [agentId, null] }

    const { count } = await prisma.supportConversation.updateMany({
      where: where as never,
      data: { status: 'RESOLVED' as never, resolvedAt: new Date() },
    })
    if (count === 0) throw new ConversationNotOpenError()
    return this.getById(conversationId)
  }

  /**
   * Move a BOT thread into the human queue. Idempotent: a thread already in
   * OPEN or ASSIGNED is returned unchanged rather than erroring, because in
   * Phase 1 every thread starts OPEN and the player's "Talk to a person"
   * button is still visible.
   */
  static async escalate(conversationId: string): Promise<SupportConversation> {
    await prisma.supportConversation.updateMany({
      where: { id: conversationId, status: 'BOT' as never },
      data: { status: 'OPEN' as never, escalatedAt: new Date() },
    })
    return this.getById(conversationId)
  }

  /** Longest preview the inbox list renders before truncating. */
  private static readonly PREVIEW_CHARS = 80

  static async listQueue(
    filter: 'unassigned' | 'mine' | 'all' | 'resolved',
    agentId: string,
  ): Promise<SupportQueueItem[]> {
    const where =
      filter === 'unassigned'
        ? { status: 'OPEN', assignedToId: null }
        : filter === 'mine'
          ? { status: 'ASSIGNED', assignedToId: agentId }
          : filter === 'resolved'
            ? { status: 'RESOLVED' }
            : { status: { in: LIVE_STATUSES as unknown as PrismaSupportConversationStatus[] } }

    const rows = await prisma.supportConversation.findMany({
      where: where as never,
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
      include: {
        user: { select: { username: true } },
        assignedTo: { select: { username: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: {
          select: {
            messages: { where: { senderRole: 'PLAYER', readByAgentAt: null } },
          },
        },
      },
    })

    return (rows as never[]).map((row: never) => {
      const r = row as unknown as ConversationRow & {
        user: { username: string }
        messages: MessageRow[]
        _count: { messages: number }
      }
      const last = r.messages[0]
      const preview = last ? last.body.slice(0, this.PREVIEW_CHARS) : ''
      return {
        id: r.id,
        userId: r.userId,
        username: r.user.username,
        status: r.status as SupportQueueItem['status'],
        assignedToId: r.assignedToId,
        assignedToUsername: r.assignedTo?.username ?? null,
        lastMessageAt: r.lastMessageAt.toISOString(),
        lastMessagePreview: preview,
        unreadForAgent: r._count.messages,
      }
    })
  }

  static async getForAgent(conversationId: string): Promise<SupportConversationWithMessages> {
    const row = await prisma.supportConversation.findUnique({
      where: { id: conversationId },
      include: { assignedTo: { select: { username: true } } },
    })
    if (!row) throw new ConversationNotFoundError()
    return this.withHistory(row as ConversationRow)
  }

  /** Called when an agent opens a thread. Only player messages can be unread
   *  for an agent, so the filter keeps the write narrow. */
  static async markReadByAgent(conversationId: string): Promise<void> {
    await prisma.supportMessage.updateMany({
      where: { conversationId, senderRole: 'PLAYER' as never, readByAgentAt: null },
      data: { readByAgentAt: new Date() },
    })
  }

  static async markReadByPlayer(conversationId: string): Promise<void> {
    await prisma.supportMessage.updateMany({
      where: {
        conversationId,
        senderRole: { in: ['AGENT', 'AI', 'SYSTEM'] as never },
        readByPlayerAt: null,
      },
      data: { readByPlayerAt: new Date() },
    })
  }

  /** Badge count for the agent inbox. */
  static async unassignedCount(): Promise<number> {
    return prisma.supportConversation.count({
      where: { status: 'OPEN' as never, assignedToId: null },
    })
  }
}
