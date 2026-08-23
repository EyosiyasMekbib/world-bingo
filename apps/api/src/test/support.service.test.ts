import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
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
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))

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

  it('creates a thread when none is live, and it starts OPEN', async () => {
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

  it('persists the message and bumps lastMessageAt', async () => {
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

    const message = await SupportService.addMessage({
      conversationId: 'conv-1',
      senderRole: 'PLAYER',
      senderId: 'user-1',
      body: 'where is my deposit',
    })

    expect(message.id).toBe('msg-2')
    expect(prisma.supportConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conv-1' },
        data: expect.objectContaining({ lastMessageAt: expect.any(Date) }),
      }),
    )
  })

  it('reopens a RESOLVED thread to OPEN, never to BOT', async () => {
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'RESOLVED', resolvedAt: NOW, assignedToId: 'clerk-1' }),
    )
    ;(prisma.supportConversation.findFirst as any).mockResolvedValue(null)
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
    ;(prisma.supportConversation.update as any).mockResolvedValue(conversationRow())

    await SupportService.addMessage({
      conversationId: 'conv-1',
      senderRole: 'PLAYER',
      senderId: 'user-1',
      body: 'still not fixed',
    })

    const updateArg = (prisma.supportConversation.update as any).mock.calls[0][0]
    expect(updateArg.data.status).toBe('OPEN')
    expect(updateArg.data.resolvedAt).toBeNull()
    expect(updateArg.data.assignedToId).toBeNull()
  })

  it('refuses to reopen a resolved thread when a newer live thread exists', async () => {
    // Reopening here would insert a second live row and trip the partial
    // unique index. Tell the client to re-open instead.
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'RESOLVED', resolvedAt: NOW }),
    )
    ;(prisma.supportConversation.findFirst as any).mockResolvedValue(
      conversationRow({ id: 'conv-newer' }),
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
