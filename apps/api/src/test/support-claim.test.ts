import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    supportConversation: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    supportMessage: { findMany: vi.fn() },
  },
}))

import prisma from '../lib/prisma'
import { SupportService } from '../services/support/support.service'
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
  beforeEach(() => vi.clearAllMocks())

  it('moves a BOT thread to OPEN and stamps escalatedAt', async () => {
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'OPEN', assignedToId: null, assignedTo: null }),
    )

    const result = await SupportService.escalate('conv-1')

    const call = (prisma.supportConversation.updateMany as any).mock.calls[0][0]
    expect(call.where).toEqual({ id: 'conv-1', status: 'BOT' })
    expect(call.data.status).toBe('OPEN')
    expect(call.data.escalatedAt).toBeInstanceOf(Date)
    expect(result.status).toBe('OPEN')
  })

  it('is idempotent on a thread that is already OPEN', async () => {
    // Phase 1 threads start OPEN, so "Talk to a person" is a no-op here.
    // It must return the thread, not throw.
    ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 0 })
    ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
      conversationRow({ status: 'OPEN', assignedToId: null, assignedTo: null }),
    )

    const result = await SupportService.escalate('conv-1')

    expect(result.status).toBe('OPEN')
  })
})
