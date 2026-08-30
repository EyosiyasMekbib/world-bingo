import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => {
  const client: any = {
    supportConversation: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    supportMessage: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  }
  // escalate writes its acknowledgement through addMessage, which runs inside
  // an interactive transaction.
  client.$transaction = vi.fn((fn: any) => fn(client))
  return { default: client }
})

import prisma from '../lib/prisma'
import { SupportService, ESCALATION_ACK_BODY } from '../services/support/support.service'
import { ConversationNotOpenError } from '../services/support/errors'

const NOW = new Date('2026-08-22T10:00:00.000Z')

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    userId: 'user-1',
    status: 'ASSIGNED',
    assignedToId: 'clerk-1',
    assignedTo: { username: 'clerk1' },
    language: 'en',
    escalatedAt: NOW,
    resolvedAt: null,
    lastMessageAt: NOW,
    createdAt: NOW,
    ...overrides,
  }
}

describe('SupportService.claim', () => {
  beforeEach(() => vi.clearAllMocks())

  it('claims an OPEN conversation with a status-guarded update', async () => {
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(conversationRow())

    const result = await SupportService.claim('conv-1', 'clerk-1')

    expect(prisma.supportConversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'conv-1', status: 'OPEN' },
      data: { status: 'ASSIGNED', assignedToId: 'clerk-1' },
    })
    expect(result.assignedToId).toBe('clerk-1')
    expect(result.status).toBe('ASSIGNED')
  })

  it('throws when the conditional update matches nothing', async () => {
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 0 })

    await expect(SupportService.claim('conv-1', 'clerk-2')).rejects.toBeInstanceOf(
      ConversationNotOpenError,
    )
  })

  it('lets exactly one of two concurrent claims win', async () => {
    // The DB serialises the two UPDATEs: the first matches status='OPEN',
    // the second finds the row already ASSIGNED and matches zero rows.
    let firstCall = true
    ;(prisma.supportConversation.updateMany as any).mockImplementation(async () => {
      if (firstCall) {
        firstCall = false
        return { count: 1 }
      }
      return { count: 0 }
    })
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(conversationRow())

    const results = await Promise.allSettled([
      SupportService.claim('conv-1', 'clerk-1'),
      SupportService.claim('conv-1', 'clerk-2'),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
  })
})

describe('SupportService.release', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns an owned thread to OPEN', async () => {
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'OPEN', assignedToId: null, assignedTo: null }),
    )

    const result = await SupportService.release('conv-1', 'clerk-1', false)

    expect(prisma.supportConversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'conv-1', status: 'ASSIGNED', assignedToId: 'clerk-1' },
      data: { status: 'OPEN', assignedToId: null },
    })
    expect(result.assignedToId).toBeNull()
  })

  it('lets an admin release a thread assigned to someone else', async () => {
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'OPEN', assignedToId: null, assignedTo: null }),
    )

    await SupportService.release('conv-1', 'admin-9', true)

    expect(prisma.supportConversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'conv-1', status: 'ASSIGNED' },
      data: { status: 'OPEN', assignedToId: null },
    })
  })

  it('rejects a clerk releasing a thread they do not hold', async () => {
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 0 })

    await expect(SupportService.release('conv-1', 'clerk-2', false)).rejects.toBeInstanceOf(
      ConversationNotOpenError,
    )
  })
})

describe('SupportService.resolve', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resolves an assigned thread held by the caller', async () => {
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'RESOLVED', resolvedAt: NOW }),
    )

    const result = await SupportService.resolve('conv-1', 'clerk-1', false)

    const call = (prisma.supportConversation.updateMany as any).mock.calls[0][0]
    expect(call.where.status).toEqual({ in: ['OPEN', 'ASSIGNED'] })
    expect(call.where.assignedToId).toEqual({ in: ['clerk-1', null] })
    expect(result.status).toBe('RESOLVED')
  })

  it('lets an admin resolve regardless of assignee', async () => {
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'RESOLVED', resolvedAt: NOW }),
    )

    await SupportService.resolve('conv-1', 'admin-9', true)

    const call = (prisma.supportConversation.updateMany as any).mock.calls[0][0]
    expect(call.where.assignedToId).toBeUndefined()
  })
})

describe('SupportService.escalate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
    ;(prisma.supportConversation.update as any).mockResolvedValue(undefined)
    ;(prisma.supportMessage.findFirst as any).mockResolvedValue(null)
    ;(prisma.supportMessage.create as any).mockImplementation(async ({ data }: any) => ({
      id: 'sys-1',
      conversationId: data.conversationId,
      senderRole: data.senderRole,
      senderId: data.senderId,
      body: data.body,
      attachmentUrl: null,
      attachmentMime: null,
      createdAt: data.createdAt ?? NOW,
    }))
  })

  it('moves a BOT thread to OPEN and stamps escalatedAt', async () => {
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'BOT', assignedToId: null, assignedTo: null, escalatedAt: null }),
    )

    const { conversation } = await SupportService.escalate('conv-1')

    const call = (prisma.supportConversation.updateMany as any).mock.calls[0][0]
    expect(call.where.id).toBe('conv-1')
    expect(call.data.status).toBe('OPEN')
    expect(call.data.escalatedAt).toBeInstanceOf(Date)
    expect(conversation.id).toBe('conv-1')
  })

  it('acknowledges the request on an already-OPEN thread instead of doing nothing', async () => {
    // Phase 1 creates every thread OPEN, and escalate used to match only
    // `status: 'BOT'` — so "Talk to a person" updated zero rows and echoed
    // back a conversation the widget rendered exactly as before. The button
    // has to leave something the player can actually see.
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'OPEN', assignedToId: null, assignedTo: null, escalatedAt: null }),
    )

    const { conversation, systemMessage } = await SupportService.escalate('conv-1')

    expect(systemMessage?.senderRole).toBe('SYSTEM')
    expect(systemMessage?.body).toBe(ESCALATION_ACK_BODY)
    expect(conversation.status).toBe('OPEN')

    // An OPEN thread is already in the human queue, so only the timestamp the
    // contact reveal counts from is set.
    const call = (prisma.supportConversation.updateMany as any).mock.calls[0][0]
    expect(call.data.escalatedAt).toBeInstanceOf(Date)
    expect(call.data).not.toHaveProperty('status')
  })

  it('leaves an existing escalatedAt alone rather than restarting the contact reveal', async () => {
    // escalatedAt marks when the wait for a human began — the player's first
    // message stamps it. Re-stamping it here would push the five-minute
    // "here is our phone number" reveal five minutes further away every time
    // the player asked to be helped sooner.
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'OPEN', assignedToId: null, assignedTo: null, escalatedAt: NOW }),
    )

    const { systemMessage } = await SupportService.escalate('conv-1')

    expect(systemMessage?.body).toBe(ESCALATION_ACK_BODY)
    expect(prisma.supportConversation.updateMany).not.toHaveBeenCalled()
  })

  it('writes nothing when the acknowledgement is already the last message', async () => {
    // support:escalate is not rate limited and the button stays pressable by
    // design, so ten taps must not leave ten identical lines.
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'OPEN', assignedToId: null, assignedTo: null }),
    )
    ;(prisma.supportMessage.findFirst as any).mockResolvedValue({
      id: 'sys-0',
      conversationId: 'conv-1',
      senderRole: 'SYSTEM',
      senderId: null,
      body: ESCALATION_ACK_BODY,
      attachmentUrl: null,
      attachmentMime: null,
      createdAt: NOW,
    })

    const { systemMessage } = await SupportService.escalate('conv-1')

    expect(systemMessage).toBeNull()
    expect(prisma.supportMessage.create).not.toHaveBeenCalled()
    expect(prisma.supportConversation.updateMany).not.toHaveBeenCalled()
  })

  it('writes nothing when an acknowledgement was written moments ago, even if the player has spoken since', async () => {
    // Two taps landing together: both read before either writes, so the
    // last-message check above cannot see the other one's row yet.
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'OPEN', assignedToId: null, assignedTo: null }),
    )
    ;(prisma.supportMessage.findFirst as any)
      .mockResolvedValueOnce({
        id: 'msg-9',
        conversationId: 'conv-1',
        senderRole: 'PLAYER',
        senderId: 'user-1',
        body: 'anyone there?',
        attachmentUrl: null,
        attachmentMime: null,
        createdAt: NOW,
      })
      .mockResolvedValueOnce({ id: 'sys-0' })

    const { systemMessage } = await SupportService.escalate('conv-1')

    expect(systemMessage).toBeNull()
    expect(prisma.supportMessage.create).not.toHaveBeenCalled()

    // The recency probe keys on the acknowledgement message, not on
    // escalatedAt — escalatedAt also moves on the player's first message, so
    // timing off it would swallow the acknowledgement for anyone who types a
    // sentence and then presses the button.
    const probe = (prisma.supportMessage.findFirst as any).mock.calls[1][0]
    expect(probe.where.body).toBe(ESCALATION_ACK_BODY)
    expect(probe.where.createdAt.gt).toBeInstanceOf(Date)
  })

  it('writes nothing into a RESOLVED thread', async () => {
    // A SYSTEM message is a non-PLAYER message, and addMessage reopens on
    // those — so writing here would resurrect a closed thread, or throw
    // StaleConversationError at a player who only pressed a button.
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'RESOLVED', resolvedAt: NOW }),
    )

    const { conversation, systemMessage } = await SupportService.escalate('conv-1')

    expect(systemMessage).toBeNull()
    expect(conversation.status).toBe('RESOLVED')
    expect(prisma.supportMessage.create).not.toHaveBeenCalled()
    expect(prisma.supportConversation.updateMany).not.toHaveBeenCalled()
  })
})
