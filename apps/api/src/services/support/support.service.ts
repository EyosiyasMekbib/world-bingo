import prisma from '../../lib/prisma'
import type { SupportConversationStatus as PrismaSupportConversationStatus } from '@prisma/client'
import type {
  SupportConversation,
  SupportConversationWithMessages,
  SupportMessage,
  SupportSenderRole,
} from '@world-bingo/shared-types'
import { ConversationNotFoundError, NotParticipantError, StaleConversationError } from './errors'

/** How much history the widget and the inbox load on open. */
const HISTORY_LIMIT = 100

/** Statuses that count as "live" — exactly the set the partial unique index
 *  covers, so this constant and the migration must not drift apart. */
const LIVE_STATUSES = [
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
    const messages = await prisma.supportMessage.findMany({
      where: { conversationId: row.id },
      orderBy: { createdAt: 'asc' },
      take: HISTORY_LIMIT,
    })
    return {
      conversation: toWireConversation(row),
      messages: (messages as MessageRow[]).map(toWireMessage),
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
   * Append a message. A player writing into a RESOLVED thread reopens it to
   * OPEN — never back to BOT, because once a human has answered, routing the
   * follow-up to a bot reads as being brushed off.
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

    const reopening = conversation.status === 'RESOLVED' && input.senderRole === 'PLAYER'

    if (reopening) {
      // Reopening while a newer live thread exists would insert a second
      // live row and trip the partial unique index.
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

    await prisma.supportConversation.update({
      where: { id: input.conversationId },
      data: reopening
        ? {
            lastMessageAt: new Date(),
            status: 'OPEN' as never,
            resolvedAt: null,
            assignedToId: null,
            escalatedAt: new Date(),
          }
        : { lastMessageAt: new Date() },
    })

    return toWireMessage(message as MessageRow)
  }
}
