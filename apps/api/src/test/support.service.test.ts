import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => {
  const client: any = {
    supportConversation: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    supportMessage: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  }
  // addMessage runs its whole read/update/insert sequence inside an
  // interactive transaction, which hands the callback a scoped client. Handing
  // back this same mock keeps every expectation below written against
  // `prisma.supportX.y` — and is faithful where it counts: the callback's
  // writes are the transaction's writes.
  client.$transaction = vi.fn((fn: any) => fn(client))
  return { default: client }
})

import prisma from '../lib/prisma'
import { SupportService, LIVE_STATUSES } from '../services/support/support.service'
import { ConversationNotFoundError, StaleConversationError } from '../services/support/errors'

const NOW = new Date('2026-08-22T10:00:00.000Z')

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    userId: 'user-1',
    status: 'OPEN',
    assignedToId: null,
    assignedTo: null,
    language: 'en',
    aiTurnCount: 0,
    lowConfidenceStreak: 0,
    lastMessageAt: NOW,
    escalatedAt: NOW,
    resolvedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('SupportService.openForUser', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the existing live thread with its history', async () => {
    ;(prisma.supportConversation.findFirst as any).mockResolvedValue(conversationRow())
    ;(prisma.supportMessage.findMany as any).mockResolvedValue([
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        senderRole: 'PLAYER',
        senderId: 'user-1',
        body: 'hello',
        attachmentUrl: null,
        attachmentMime: null,
        createdAt: NOW,
      },
    ])

    const result = await SupportService.openForUser('user-1')

    expect(prisma.supportConversation.create).not.toHaveBeenCalled()
    expect(result.conversation.id).toBe('conv-1')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].body).toBe('hello')
  })

  it('returns history in ascending order, fetched newest-first under the hood', async () => {
    // The take(HISTORY_LIMIT) page has to be the newest 100, not the oldest
    // 100 — otherwise a long or repeatedly-reopened thread would silently
    // hide everything recent. That means querying desc and reversing for
    // display, since every caller expects chronological (ascending) order.
    ;(prisma.supportConversation.findFirst as any).mockResolvedValue(conversationRow())
    ;(prisma.supportMessage.findMany as any).mockResolvedValue([
      {
        id: 'msg-3',
        conversationId: 'conv-1',
        senderRole: 'PLAYER',
        senderId: 'user-1',
        body: 'third',
        attachmentUrl: null,
        attachmentMime: null,
        createdAt: new Date('2026-08-22T10:02:00.000Z'),
      },
      {
        id: 'msg-2',
        conversationId: 'conv-1',
        senderRole: 'PLAYER',
        senderId: 'user-1',
        body: 'second',
        attachmentUrl: null,
        attachmentMime: null,
        createdAt: new Date('2026-08-22T10:01:00.000Z'),
      },
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        senderRole: 'PLAYER',
        senderId: 'user-1',
        body: 'first',
        attachmentUrl: null,
        attachmentMime: null,
        createdAt: NOW,
      },
    ])

    const result = await SupportService.openForUser('user-1')

    expect(prisma.supportMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
    )
    expect(result.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3'])
  })

  it('creates a thread when none is live, and it starts OPEN with no escalatedAt', async () => {
    ;(prisma.supportConversation.findFirst as any).mockResolvedValue(null)
    ;(prisma.supportConversation.create as any).mockResolvedValue(
      conversationRow({ id: 'conv-new' }),
    )
    ;(prisma.supportMessage.findMany as any).mockResolvedValue([])

    const result = await SupportService.openForUser('user-1')

    expect(prisma.supportConversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-1', status: 'OPEN' }),
      }),
    )
    // escalatedAt is what the widget times its five-minute "here is our phone
    // number" reveal off. Stamping it at creation started that countdown for
    // a player who opened the panel and typed nothing.
    const createArg = (prisma.supportConversation.create as any).mock.calls[0][0]
    expect(createArg.data.escalatedAt).toBeNull()
    expect(result.conversation.id).toBe('conv-new')
    expect(result.messages).toEqual([])
  })

  it('recovers from the partial-unique race by re-reading instead of throwing', async () => {
    // Two widget taps land together: both see no live thread, both insert,
    // the loser hits the partial unique index.
    ;(prisma.supportConversation.findFirst as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(conversationRow({ id: 'conv-winner' }))
    ;(prisma.supportConversation.create as any).mockRejectedValue(
      Object.assign(new Error('unique violation'), { code: 'P2002' }),
    )
    ;(prisma.supportMessage.findMany as any).mockResolvedValue([])

    const result = await SupportService.openForUser('user-1')

    expect(result.conversation.id).toBe('conv-winner')
  })
})

describe('SupportService.addMessage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('persists the message and bumps lastMessageAt, inside one transaction', async () => {
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(conversationRow())
    ;(prisma.supportMessage.create as any).mockResolvedValue({
      id: 'msg-2',
      conversationId: 'conv-1',
      senderRole: 'PLAYER',
      senderId: 'user-1',
      body: 'where is my deposit',
      attachmentUrl: null,
      attachmentMime: null,
      createdAt: NOW,
    })
    ;(prisma.supportConversation.update as any).mockResolvedValue(conversationRow())

    const { message, reopened } = await SupportService.addMessage({
      conversationId: 'conv-1',
      senderRole: 'PLAYER',
      senderId: 'user-1',
      body: 'where is my deposit',
    })

    expect(message.id).toBe('msg-2')
    expect(reopened).toBe(false)
    expect(prisma.$transaction).toHaveBeenCalled()
    expect(prisma.supportConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conv-1' },
        data: expect.objectContaining({ lastMessageAt: expect.any(Date) }),
      }),
    )
  })

  it('writes lastMessageAt and the message createdAt from one clock', async () => {
    // They used to come from two: lastMessageAt from Node, createdAt from the
    // Postgres default. The inbox sorts on lastMessageAt and the transcript on
    // createdAt, so clock skew between API and DB could order the same message
    // differently in the two views.
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(conversationRow())
    ;(prisma.supportMessage.create as any).mockResolvedValue({
      id: 'msg-2',
      conversationId: 'conv-1',
      senderRole: 'PLAYER',
      senderId: 'user-1',
      body: 'hi',
      attachmentUrl: null,
      attachmentMime: null,
      createdAt: NOW,
    })
    ;(prisma.supportConversation.update as any).mockResolvedValue(conversationRow())

    await SupportService.addMessage({
      conversationId: 'conv-1',
      senderRole: 'PLAYER',
      senderId: 'user-1',
      body: 'hi',
    })

    const updateArg = (prisma.supportConversation.update as any).mock.calls[0][0]
    const createArg = (prisma.supportMessage.create as any).mock.calls[0][0]
    expect(createArg.data.createdAt).toBe(updateArg.data.lastMessageAt)
  })

  it("stamps escalatedAt on the player's first message, and not again on the second", async () => {
    // The contact-reveal countdown starts when the player actually asks for
    // something — not when they open the panel, and not again with every
    // sentence, which would push the reveal permanently out of reach for
    // anyone who keeps typing.
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ escalatedAt: null }),
    )
    ;(prisma.supportMessage.create as any).mockResolvedValue({
      id: 'msg-2',
      conversationId: 'conv-1',
      senderRole: 'PLAYER',
      senderId: 'user-1',
      body: 'hi',
      attachmentUrl: null,
      attachmentMime: null,
      createdAt: NOW,
    })
    ;(prisma.supportConversation.update as any).mockResolvedValue(conversationRow())

    await SupportService.addMessage({
      conversationId: 'conv-1',
      senderRole: 'PLAYER',
      senderId: 'user-1',
      body: 'hi',
    })
    expect(
      (prisma.supportConversation.update as any).mock.calls[0][0].data.escalatedAt,
    ).toBeInstanceOf(Date)
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ escalatedAt: NOW }),
    )

    await SupportService.addMessage({
      conversationId: 'conv-1',
      senderRole: 'PLAYER',
      senderId: 'user-1',
      body: 'still hi',
    })
    expect((prisma.supportConversation.update as any).mock.calls[1][0].data).not.toHaveProperty(
      'escalatedAt',
    )
  })

  it('reopens a RESOLVED thread to OPEN, never to BOT', async () => {
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'RESOLVED', resolvedAt: NOW, assignedToId: 'clerk-1' }),
    )
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
    ;(prisma.supportMessage.create as any).mockResolvedValue({
      id: 'msg-3',
      conversationId: 'conv-1',
      senderRole: 'PLAYER',
      senderId: 'user-1',
      body: 'still not fixed',
      attachmentUrl: null,
      attachmentMime: null,
      createdAt: NOW,
    })

    await SupportService.addMessage({
      conversationId: 'conv-1',
      senderRole: 'PLAYER',
      senderId: 'user-1',
      body: 'still not fixed',
    })

    const updateArg = (prisma.supportConversation.updateMany as any).mock.calls[0][0]
    // Conditional on the thread still being RESOLVED: two senders reopening
    // the same thread at once must not both apply their own reopen.
    expect(updateArg.where).toEqual({ id: 'conv-1', status: 'RESOLVED' })
    expect(updateArg.data.status).toBe('OPEN')
    expect(updateArg.data.resolvedAt).toBeNull()
    expect(updateArg.data.assignedToId).toBeNull()
  })

  it('reopens a RESOLVED thread to ASSIGNED when an AGENT replies and an assignee still holds it, preserving that assignee', async () => {
    // The merge-blocker this guards: addMessage used to reopen only for
    // senderRole === 'PLAYER'. An AGENT writing into a RESOLVED thread was
    // persisted while the conversation stayed RESOLVED — which is not in
    // LIVE_STATUSES, so the thread vanished from every queue filter and
    // from openForUser. The player never saw the reply and no clerk could
    // find the thread again.
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'RESOLVED', resolvedAt: NOW, assignedToId: 'clerk-1' }),
    )
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
    ;(prisma.supportMessage.create as any).mockResolvedValue({
      id: 'msg-4',
      conversationId: 'conv-1',
      senderRole: 'AGENT',
      senderId: 'clerk-1',
      body: 'following up on this',
      attachmentUrl: null,
      attachmentMime: null,
      createdAt: NOW,
    })

    await SupportService.addMessage({
      conversationId: 'conv-1',
      senderRole: 'AGENT',
      senderId: 'clerk-1',
      body: 'following up on this',
    })

    const updateArg = (prisma.supportConversation.updateMany as any).mock.calls[0][0]
    expect(updateArg.data.status).toBe('ASSIGNED')
    expect(updateArg.data.resolvedAt).toBeNull()
    // The assignee must be PRESERVED, not nulled — nulling it here would
    // unassign the very clerk who just replied. "Preserved" means the field
    // is left out of the update entirely, not re-set to its old value.
    expect(updateArg.data).not.toHaveProperty('assignedToId')
    // Whatever status this lands on must actually be visible again: RESOLVED
    // is excluded from every queue filter, so the fix only counts if the
    // resulting status is one listQueue's 'all'/'mine'/'unassigned' filters
    // (built from LIVE_STATUSES) still match.
    expect(LIVE_STATUSES).toContain(updateArg.data.status)
  })

  it('reopens a RESOLVED thread to OPEN (not ASSIGNED) when an AGENT replies and nobody is assigned', async () => {
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'RESOLVED', resolvedAt: NOW, assignedToId: null }),
    )
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
    ;(prisma.supportMessage.create as any).mockResolvedValue({
      id: 'msg-5',
      conversationId: 'conv-1',
      senderRole: 'AGENT',
      senderId: 'clerk-2',
      body: 'reopening this for you',
      attachmentUrl: null,
      attachmentMime: null,
      createdAt: NOW,
    })

    await SupportService.addMessage({
      conversationId: 'conv-1',
      senderRole: 'AGENT',
      senderId: 'clerk-2',
      body: 'reopening this for you',
    })

    const updateArg = (prisma.supportConversation.updateMany as any).mock.calls[0][0]
    expect(updateArg.data.status).toBe('OPEN')
    expect(updateArg.data.resolvedAt).toBeNull()
    expect(updateArg.data).not.toHaveProperty('assignedToId')
  })

  it('an AGENT reopen is visible to listQueue afterward, unlike a thread left RESOLVED', async () => {
    // Direct proof of "the thread is subsequently visible to listQueue":
    // feed listQueue a row shaped exactly like what the AGENT-reopen update
    // above produces (status ASSIGNED, assignedToId 'clerk-1') and confirm
    // the 'mine' filter — which excludes RESOLVED by construction — returns
    // it, where it would have found nothing had the thread stayed RESOLVED.
    ;(prisma.supportConversation.findMany as any).mockResolvedValue([
      {
        ...conversationRow({ status: 'ASSIGNED', assignedToId: 'clerk-1' }),
        user: { username: 'abebe' },
        assignedTo: { username: 'clerk-1' },
        messages: [
          {
            id: 'm-4',
            conversationId: 'conv-1',
            senderRole: 'AGENT',
            senderId: 'clerk-1',
            body: 'following up on this',
            attachmentUrl: null,
            attachmentMime: null,
            createdAt: NOW,
          },
        ],
        _count: { messages: 0 },
      },
    ])

    const items = await SupportService.listQueue('mine', 'clerk-1')

    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('conv-1')
    expect(items[0].status).toBe('ASSIGNED')

    const call = (prisma.supportConversation.findMany as any).mock.calls[0][0]
    expect(call.where).toEqual({ status: 'ASSIGNED', assignedToId: 'clerk-1' })
    expect(call.where.status).not.toBe('RESOLVED')
  })

  it('refuses an AGENT reopen when a newer live thread already exists for the player', async () => {
    // Same StaleConversationError guard the player path has: agent-triggered
    // reopen must still surface as a client-actionable error rather than a
    // raw P2002 when a newer live thread for this user already exists.
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'RESOLVED', resolvedAt: NOW, assignedToId: 'clerk-1' }),
    )
    // The partial unique index on (userId) over the live statuses is what
    // actually detects the newer thread — a preceding SELECT could only ever
    // guess, since one can appear between the read and the write.
    ;(prisma.supportConversation.updateMany as any).mockRejectedValue(
      Object.assign(new Error('unique violation'), { code: 'P2002' }),
    )

    await expect(
      SupportService.addMessage({
        conversationId: 'conv-1',
        senderRole: 'AGENT',
        senderId: 'clerk-1',
        body: 'hi',
      }),
    ).rejects.toBeInstanceOf(StaleConversationError)

    expect(prisma.supportMessage.create).not.toHaveBeenCalled()
  })

  it('reopens a RESOLVED thread to ASSIGNED when an AI message arrives and an assignee still holds it, preserving that assignee', async () => {
    // Same non-PLAYER reopen path as AGENT, exercised for a role Phase 2
    // will actually send: AI. The branch is keyed on "not a player", not on
    // an enumerated role list, so this must behave identically to AGENT.
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'RESOLVED', resolvedAt: NOW, assignedToId: 'clerk-1' }),
    )
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
    ;(prisma.supportMessage.create as any).mockResolvedValue({
      id: 'msg-6',
      conversationId: 'conv-1',
      senderRole: 'AI',
      senderId: null,
      body: 'here is what I found',
      attachmentUrl: null,
      attachmentMime: null,
      createdAt: NOW,
    })

    await SupportService.addMessage({
      conversationId: 'conv-1',
      senderRole: 'AI',
      senderId: null,
      body: 'here is what I found',
    })

    const updateArg = (prisma.supportConversation.updateMany as any).mock.calls[0][0]
    expect(updateArg.data.status).toBe('ASSIGNED')
    expect(updateArg.data.resolvedAt).toBeNull()
    expect(updateArg.data).not.toHaveProperty('assignedToId')
    expect(LIVE_STATUSES).toContain(updateArg.data.status)
  })

  it('reopens a RESOLVED thread to OPEN when a SYSTEM message arrives and nobody is assigned', async () => {
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'RESOLVED', resolvedAt: NOW, assignedToId: null }),
    )
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
    ;(prisma.supportMessage.create as any).mockResolvedValue({
      id: 'msg-7',
      conversationId: 'conv-1',
      senderRole: 'SYSTEM',
      senderId: null,
      body: 'conversation auto-reopened',
      attachmentUrl: null,
      attachmentMime: null,
      createdAt: NOW,
    })

    await SupportService.addMessage({
      conversationId: 'conv-1',
      senderRole: 'SYSTEM',
      senderId: null,
      body: 'conversation auto-reopened',
    })

    const updateArg = (prisma.supportConversation.updateMany as any).mock.calls[0][0]
    expect(updateArg.data.status).toBe('OPEN')
    expect(updateArg.data.resolvedAt).toBeNull()
    expect(updateArg.data).not.toHaveProperty('assignedToId')
  })

  it('refuses an AI reopen when a newer live thread already exists for the player', async () => {
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'RESOLVED', resolvedAt: NOW, assignedToId: 'clerk-1' }),
    )
    // The partial unique index on (userId) over the live statuses is what
    // actually detects the newer thread — a preceding SELECT could only ever
    // guess, since one can appear between the read and the write.
    ;(prisma.supportConversation.updateMany as any).mockRejectedValue(
      Object.assign(new Error('unique violation'), { code: 'P2002' }),
    )

    await expect(
      SupportService.addMessage({
        conversationId: 'conv-1',
        senderRole: 'AI',
        senderId: null,
        body: 'hi',
      }),
    ).rejects.toBeInstanceOf(StaleConversationError)

    expect(prisma.supportMessage.create).not.toHaveBeenCalled()
  })

  it('refuses to reopen a resolved thread when a newer live thread exists', async () => {
    // Reopening here would insert a second live row and trip the partial
    // unique index. Tell the client to re-open instead.
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'RESOLVED', resolvedAt: NOW }),
    )
    // The partial unique index on (userId) over the live statuses is what
    // actually detects the newer thread — a preceding SELECT could only ever
    // guess, since one can appear between the read and the write.
    ;(prisma.supportConversation.updateMany as any).mockRejectedValue(
      Object.assign(new Error('unique violation'), { code: 'P2002' }),
    )

    await expect(
      SupportService.addMessage({
        conversationId: 'conv-1',
        senderRole: 'PLAYER',
        senderId: 'user-1',
        body: 'hi',
      }),
    ).rejects.toBeInstanceOf(StaleConversationError)

    expect(prisma.supportMessage.create).not.toHaveBeenCalled()
  })

  it('refuses the reopen when the conditional update matches nothing, and writes no message', async () => {
    // The thread stopped being RESOLVED between the read and the write —
    // someone else reopened it, or resolved-then-reopened it — so this
    // caller's reopen data is describing a thread that no longer exists in
    // that state. Writing the message anyway would attach it to a
    // conversation whose status this call never actually set.
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'RESOLVED', resolvedAt: NOW }),
    )
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 0 })

    await expect(
      SupportService.addMessage({
        conversationId: 'conv-1',
        senderRole: 'PLAYER',
        senderId: 'user-1',
        body: 'hi',
      }),
    ).rejects.toBeInstanceOf(StaleConversationError)

    expect(prisma.supportMessage.create).not.toHaveBeenCalled()
  })

  it('throws when the conversation does not exist', async () => {
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(null)

    await expect(
      SupportService.addMessage({
        conversationId: 'nope',
        senderRole: 'PLAYER',
        senderId: 'user-1',
        body: 'hi',
      }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError)
  })

  it('rejects an empty body', async () => {
    await expect(
      SupportService.addMessage({
        conversationId: 'conv-1',
        senderRole: 'PLAYER',
        senderId: 'user-1',
        body: '   ',
      }),
    ).rejects.toThrow()
  })
})

describe('SupportService.assertPlayerOwns', () => {
  beforeEach(() => vi.clearAllMocks())

  it('throws for a conversation belonging to someone else', async () => {
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ userId: 'someone-else' }),
    )
    await expect(SupportService.assertPlayerOwns('conv-1', 'user-1')).rejects.toThrow()
  })

  it('passes for the owner', async () => {
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(conversationRow())
    await expect(SupportService.assertPlayerOwns('conv-1', 'user-1')).resolves.toBeUndefined()
  })
})

describe('SupportService.listQueue', () => {
  beforeEach(() => vi.clearAllMocks())

  it('unassigned filter asks only for OPEN threads with no assignee', async () => {
    ;(prisma.supportConversation.findMany as any).mockResolvedValue([])
    await SupportService.listQueue('unassigned', 'clerk-1')

    const call = (prisma.supportConversation.findMany as any).mock.calls[0][0]
    expect(call.where).toEqual({ status: 'OPEN', assignedToId: null })
    expect(call.orderBy).toEqual({ lastMessageAt: 'desc' })
  })

  it('mine filter scopes to the calling agent', async () => {
    ;(prisma.supportConversation.findMany as any).mockResolvedValue([])
    await SupportService.listQueue('mine', 'clerk-1')

    const call = (prisma.supportConversation.findMany as any).mock.calls[0][0]
    expect(call.where).toEqual({ status: 'ASSIGNED', assignedToId: 'clerk-1' })
  })

  it('all filter covers exactly the live statuses, sourced from LIVE_STATUSES', async () => {
    ;(prisma.supportConversation.findMany as any).mockResolvedValue([])
    await SupportService.listQueue('all', 'clerk-1')

    const call = (prisma.supportConversation.findMany as any).mock.calls[0][0]
    // Asserted against the constant, not a copy of it. The DB's partial unique
    // index is `WHERE status <> 'RESOLVED'`; if this filter kept its own literal
    // list, adding a status would silently drop it from the "all" queue.
    expect(call.where).toEqual({ status: { in: LIVE_STATUSES } })
    expect(LIVE_STATUSES).not.toContain('RESOLVED')
  })

  it('maps a row into a queue item with a preview and unread count', async () => {
    ;(prisma.supportConversation.findMany as any).mockResolvedValue([
      {
        ...conversationRow(),
        user: { username: 'abebe' },
        assignedTo: null,
        messages: [
          {
            id: 'm1',
            conversationId: 'conv-1',
            senderRole: 'PLAYER',
            senderId: 'user-1',
            body: 'my deposit is missing and I want it back today please',
            attachmentUrl: null,
            attachmentMime: null,
            createdAt: NOW,
          },
        ],
        _count: { messages: 3 },
      },
    ])

    const [item] = await SupportService.listQueue('unassigned', 'clerk-1')

    expect(item.username).toBe('abebe')
    expect(item.lastMessagePreview.length).toBeLessThanOrEqual(80)
    expect(item.unreadForAgent).toBe(3)
  })
})

describe('SupportService.getForAgent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns history in ascending order, fetched newest-first under the hood', async () => {
    // Same discipline as openForUser's equivalent test: getForAgent delegates to
    // the private withHistory, which once shipped a bug returning the OLDEST 100
    // messages instead of the newest. Assert both the query direction and the
    // returned order — asserting only the orderBy argument would still pass if
    // the .reverse() were removed.
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(conversationRow())
    ;(prisma.supportMessage.findMany as any).mockResolvedValue([
      {
        id: 'msg-3',
        conversationId: 'conv-1',
        senderRole: 'PLAYER',
        senderId: 'user-1',
        body: 'third',
        attachmentUrl: null,
        attachmentMime: null,
        createdAt: new Date('2026-08-22T10:02:00.000Z'),
      },
      {
        id: 'msg-2',
        conversationId: 'conv-1',
        senderRole: 'PLAYER',
        senderId: 'user-1',
        body: 'second',
        attachmentUrl: null,
        attachmentMime: null,
        createdAt: new Date('2026-08-22T10:01:00.000Z'),
      },
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        senderRole: 'PLAYER',
        senderId: 'user-1',
        body: 'first',
        attachmentUrl: null,
        attachmentMime: null,
        createdAt: NOW,
      },
    ])

    const result = await SupportService.getForAgent('conv-1')

    expect(prisma.supportMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
    )
    expect(result.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3'])
  })
})

describe('SupportService.markReadByAgent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stamps only unread PLAYER messages', async () => {
    ;(prisma.supportMessage.updateMany as any).mockResolvedValue({ count: 2 })

    await SupportService.markReadByAgent('conv-1')

    expect(prisma.supportMessage.updateMany).toHaveBeenCalledWith({
      where: { conversationId: 'conv-1', senderRole: 'PLAYER', readByAgentAt: null },
      data: { readByAgentAt: expect.any(Date) },
    })
  })
})
