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

/** The system line written when a player asks for a human. Exported so the
 *  idempotency check below and the tests both read the same string — a second
 *  copy anywhere would silently stop the "did we already say this?" comparison
 *  from matching, and every tap would append another identical line. */
export const ESCALATION_ACK_BODY =
  'Thanks — we have passed this to a support agent. Someone will reply here shortly.'

/** How long an escalation acknowledgement suppresses the next one. Only wide
 *  enough to absorb a burst of taps on an unresponsive-feeling button; a
 *  player who asks again minutes later is asking again, not double-tapping. */
const ESCALATION_ACK_COOLDOWN_MS = 60_000

export interface AddMessageInput {
  conversationId: string
  senderRole: SupportSenderRole
  senderId: string | null
  body: string
  attachmentUrl?: string | null
  attachmentMime?: string | null
}

export interface AddMessageResult {
  message: SupportMessage
  /** Whether this write brought a RESOLVED thread back to life. The gateway
   *  fans a queue update out to every connected clerk, and a reply into a
   *  thread that was already live cannot change the unassigned count — only a
   *  reopen can. */
  reopened: boolean
  /** The player who owns the thread. Returned here so the gateway can raise
   *  the reply notification without a second read: sourcing it from a
   *  post-commit `getById` put the notification behind a call that is allowed
   *  to fail, which would silently reinstate the bug that gate was removed to
   *  fix — an agent reply reaching neither the socket nor the rail. */
  ownerId: string
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
  /** Fetch the caller's live thread with its transcript, creating the thread
   *  if they have none. */
  static async openForUser(userId: string): Promise<SupportConversationWithMessages> {
    return this.withHistory(await this.ensureConversationFor(userId))
  }

  /**
   * The caller's live thread row, creating one if they have none — everything
   * `openForUser` does except reading the transcript.
   *
   * Split out because the gateway has to join `support:conv:<id>` BEFORE the
   * history read, and it cannot name that room until it has an id. A message
   * broadcast in the gap between reading the transcript and joining the room
   * is in neither the snapshot nor the room, and is simply never seen.
   *
   * New threads start OPEN while SUPPORT_AI_ENABLED is false. Phase 2 flips the
   * initial status to BOT so the AI answers first.
   */
  static async ensureConversationFor(userId: string): Promise<ConversationRow> {
    const existing = await prisma.supportConversation.findFirst({
      where: {
        userId,
        status: { in: LIVE_STATUSES as unknown as PrismaSupportConversationStatus[] },
      },
      include: { assignedTo: { select: { username: true } } },
      orderBy: { lastMessageAt: 'desc' },
    })

    if (existing) return existing as ConversationRow

    const initialStatus = process.env.SUPPORT_AI_ENABLED === 'true' ? 'BOT' : 'OPEN'

    try {
      const created = await prisma.supportConversation.create({
        data: {
          userId,
          status: initialStatus as never,
          // Deliberately NOT stamped here. The widget times its five-minute
          // "here is our phone number" reveal off escalatedAt, so stamping it
          // at creation starts that countdown for a player who has opened the
          // panel and typed nothing — they get told to call us about a
          // question they never asked. It is stamped on the player's first
          // message and on support:escalate instead, which is where a request
          // for a human actually begins.
          escalatedAt: null,
          lastMessageAt: new Date(),
        },
        include: { assignedTo: { select: { username: true } } },
      })
      return created as ConversationRow
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
      return winner as ConversationRow
    }
  }

  /** Public only so the gateway can join the conversation room between
   *  `ensureConversationFor` and this read — see the note there. */
  static async withHistory(row: ConversationRow): Promise<SupportConversationWithMessages> {
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
   *   - Anyone else (AGENT today; AI and SYSTEM once Phase 2 ships them):
   *     the rule is keyed on "not a player" rather than an enumerated list
   *     of roles, because a message from a role nobody special-cased yet
   *     must still reopen the thread — RESOLVED is not in LIVE_STATUSES, so
   *     leaving the thread RESOLVED after the reply would strand it out of
   *     every queue filter (mine/unassigned/all) and out of openForUser and
   *     no clerk could find the thread again. Silently stranding a message
   *     is far worse than an unnecessary reopen. Reopening must also NOT
   *     clear assignedToId the way the player path does: that would
   *     unassign the clerk mid-conversation. It goes ASSIGNED if someone
   *     still holds it, OPEN if nobody does.
   */
  static async addMessage(input: AddMessageInput): Promise<AddMessageResult> {
    const body = input.body?.trim() ?? ''
    if (!body && !input.attachmentUrl) {
      throw new Error('Message body is empty')
    }

    // One transaction around the whole thing. Before, the message INSERT and
    // the conversation UPDATE were two independent round trips: a crash or a
    // dropped connection between them left a message stored against a thread
    // whose lastMessageAt still pointed at the previous one, so the inbox
    // sorted it into the past and no clerk saw it arrive.
    return prisma.$transaction(async (tx) => {
      const conversation = await tx.supportConversation.findUnique({
        where: { id: input.conversationId },
      })
      if (!conversation) throw new ConversationNotFoundError()

      const playerReopening = conversation.status === 'RESOLVED' && input.senderRole === 'PLAYER'
      const nonPlayerReopening = conversation.status === 'RESOLVED' && input.senderRole !== 'PLAYER'
      const reopening = playerReopening || nonPlayerReopening

      // One clock for both writes. lastMessageAt used to come from Node and
      // createdAt from the Postgres default, so API/DB clock skew could sort
      // the queue and the transcript into different orders for the same
      // message.
      const now = new Date()

      let updateData: Record<string, unknown>
      if (playerReopening) {
        updateData = {
          lastMessageAt: now,
          status: 'OPEN' as never,
          resolvedAt: null,
          assignedToId: null,
          escalatedAt: now,
        }
      } else if (nonPlayerReopening) {
        // Deliberately does NOT reuse the player branch's data object: setting
        // assignedToId: null here would unassign the clerk who just sent this
        // very message. Omitting the field entirely — rather than setting it
        // to its current value — leaves whatever is already in the DB
        // untouched, which is what "preserved" means for a partial update.
        updateData = {
          lastMessageAt: now,
          status: (conversation.assignedToId ? 'ASSIGNED' : 'OPEN') as never,
          resolvedAt: null,
        }
      } else {
        updateData = { lastMessageAt: now }
        // The player's first word is where the wait for a human actually
        // begins, so that is where the contact-reveal countdown starts.
        // ensureConversationFor deliberately leaves escalatedAt null.
        if (input.senderRole === 'PLAYER' && !conversation.escalatedAt) {
          updateData.escalatedAt = now
        }
      }

      if (reopening) {
        // Conditional write instead of the read-then-write guard this used to
        // do. Reading "does a newer live thread exist?" and then updating
        // leaves a window in which one appears between the two statements;
        // the WHERE clause closes it, exactly as claim/release/resolve do.
        // Two callers reopening the same thread at once means one of them
        // matches zero rows.
        let count: number
        try {
          ;({ count } = await tx.supportConversation.updateMany({
            where: { id: input.conversationId, status: 'RESOLVED' as never },
            data: updateData as never,
          }))
        } catch (err) {
          // The partial unique index on (userId) over the live statuses is
          // the real arbiter of "this player already has a live thread" — a
          // preceding SELECT can only ever guess. Translate its violation
          // into the same error the client already knows how to handle:
          // stop writing to this id and re-open.
          if ((err as { code?: string })?.code === 'P2002') throw new StaleConversationError()
          throw err
        }
        if (count === 0) throw new StaleConversationError()
      } else {
        await tx.supportConversation.update({
          where: { id: input.conversationId },
          data: updateData as never,
        })
      }

      // Written after the conversation update so a rejected reopen leaves no
      // orphan message behind even where the surrounding transaction cannot
      // roll one back for us.
      const message = await tx.supportMessage.create({
        data: {
          conversationId: input.conversationId,
          senderRole: input.senderRole as never,
          senderId: input.senderId,
          body,
          attachmentUrl: input.attachmentUrl ?? null,
          attachmentMime: input.attachmentMime ?? null,
          createdAt: now,
        },
      })

      return {
        message: toWireMessage(message as MessageRow),
        reopened: reopening,
        ownerId: conversation.userId,
      }
    })
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
   * Move a thread into the human queue on the player's request.
   *
   * Phase 1 creates every thread OPEN, and the old implementation only matched
   * `status: 'BOT'` — so "Talk to a person" updated zero rows, echoed the
   * unchanged conversation back, and the widget rendered exactly the same
   * label it had before. The button appeared to work only when the AI was
   * enabled, which is to say: never, so far. It now always leaves something
   * the player can see — a SYSTEM line acknowledging the request — and stamps
   * escalatedAt so the five-minute contact reveal starts counting from the
   * moment they asked.
   *
   * Idempotent, because support:escalate is NOT rate limited (only
   * support:send is) and the button stays pressable by design: without this,
   * ten taps would write ten identical system lines. `systemMessage` is null
   * whenever nothing was written, and the gateway broadcasts only what it is
   * given.
   */
  static async escalate(
    conversationId: string,
  ): Promise<{ conversation: SupportConversation; systemMessage: SupportMessage | null }> {
    const row = await prisma.supportConversation.findUnique({
      where: { id: conversationId },
      include: { assignedTo: { select: { username: true } } },
    })
    if (!row) throw new ConversationNotFoundError()

    // A RESOLVED thread must not be written to here. addMessage reopens on
    // any non-PLAYER message, so writing the SYSTEM line would silently
    // resurrect a closed thread — or throw StaleConversationError at a player
    // who only pressed a button. Hand back the conversation untouched; the
    // gateway still runs its no-agent-online contact fallback, which is the
    // part that actually helps them.
    if (row.status === 'RESOLVED') {
      return { conversation: toWireConversation(row as ConversationRow), systemMessage: null }
    }

    // Two separate guards, because they catch two different things and
    // neither covers the other. Note that the cooldown deliberately keys on
    // the acknowledgement message rather than on escalatedAt: escalatedAt now
    // also moves on the player's first message, so timing off it would
    // swallow the acknowledgement for anyone who types a sentence and then
    // presses the button — the exact case this method exists to fix.
    const last = await prisma.supportMessage.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
    })

    // Sequential taps: the line we would write is already the last thing in
    // the thread, so writing it again just stutters.
    if (last?.senderRole === 'SYSTEM' && last.body === ESCALATION_ACK_BODY) {
      return { conversation: toWireConversation(row as ConversationRow), systemMessage: null }
    }

    // Near-simultaneous taps: both reads happen before either write, so the
    // check above sees nothing. A recent acknowledgement anywhere in the tail
    // means the player has already been answered.
    const recentAck = await prisma.supportMessage.findFirst({
      where: {
        conversationId,
        senderRole: 'SYSTEM' as never,
        body: ESCALATION_ACK_BODY,
        createdAt: { gt: new Date(Date.now() - ESCALATION_ACK_COOLDOWN_MS) },
      },
      select: { id: true },
    })
    if (recentAck) {
      return { conversation: toWireConversation(row as ConversationRow), systemMessage: null }
    }

    // A BOT thread moves into the human queue; an OPEN or ASSIGNED one is
    // already there. escalatedAt marks when the wait for a human began and is
    // therefore set once and then left alone — re-stamping it on every press
    // would push the five-minute contact reveal five minutes further away
    // each time the player asked to be helped sooner.
    const escalationUpdate: Record<string, unknown> = {}
    if (row.status === 'BOT') escalationUpdate.status = 'OPEN'
    if (row.status === 'BOT' || !row.escalatedAt) escalationUpdate.escalatedAt = new Date()

    if (Object.keys(escalationUpdate).length > 0) {
      await prisma.supportConversation.updateMany({
        where: {
          id: conversationId,
          status: { in: LIVE_STATUSES as unknown as PrismaSupportConversationStatus[] },
        },
        data: escalationUpdate as never,
      })
    }

    const { message } = await this.addMessage({
      conversationId,
      senderRole: 'SYSTEM',
      senderId: null,
      body: ESCALATION_ACK_BODY,
    })

    return { conversation: await this.getById(conversationId), systemMessage: message }
  }

  /** Longest preview the inbox list renders before truncating. */
  private static readonly PREVIEW_CHARS = 80

  /** Everything a queue row needs, shared by listQueue and queueItem so the
   *  row a clerk patches in place cannot drift from the row they would get
   *  from a refetch. */
  private static readonly QUEUE_INCLUDE = {
    user: { select: { username: true } },
    assignedTo: { select: { username: true } },
    messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    _count: {
      select: {
        messages: { where: { senderRole: 'PLAYER', readByAgentAt: null } },
      },
    },
  }

  private static toQueueItem(
    row: ConversationRow & {
      user: { username: string }
      messages: MessageRow[]
      _count: { messages: number }
    },
  ): SupportQueueItem {
    const last = row.messages[0]
    return {
      id: row.id,
      userId: row.userId,
      username: row.user.username,
      status: row.status as SupportQueueItem['status'],
      assignedToId: row.assignedToId,
      assignedToUsername: row.assignedTo?.username ?? null,
      lastMessageAt: row.lastMessageAt.toISOString(),
      lastMessagePreview: last ? last.body.slice(0, this.PREVIEW_CHARS) : '',
      unreadForAgent: row._count.messages,
    }
  }

  /**
   * One queue row, for the clerk inbox to patch in place.
   *
   * Every queue-affecting mutation used to make each connected clerk refetch
   * the whole 100-row queue over HTTP; six clerks behind one office NAT share
   * a single 100-request-per-minute IP budget, so a busy shift spent it on
   * re-reading rows that had not changed. Shipping the changed row on the
   * broadcast removes the refetch entirely.
   *
   * Null when the row is gone — a conversation can be deleted with its player
   * (onDelete: Cascade) between the mutation and this read.
   */
  static async queueItem(conversationId: string): Promise<SupportQueueItem | null> {
    const row = await prisma.supportConversation.findUnique({
      where: { id: conversationId },
      include: this.QUEUE_INCLUDE as never,
    })
    return row ? this.toQueueItem(row as never) : null
  }

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
      include: this.QUEUE_INCLUDE as never,
    })

    return (rows as never[]).map((row: never) => this.toQueueItem(row as never))
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
