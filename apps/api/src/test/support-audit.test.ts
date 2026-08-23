import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    auditLog: { create: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}))

import prisma from '../lib/prisma'
import { writeSupportAudit } from '../services/support/support-audit'

describe('writeSupportAudit', () => {
  beforeEach(() => vi.clearAllMocks())

  it('writes the action, actor and target in the shape the CRM helper uses', async () => {
    ;(prisma.user.findUnique as any).mockResolvedValue({ username: 'clerk1' })
    ;(prisma.auditLog.create as any).mockResolvedValue({})

    await writeSupportAudit('clerk-1', 'support.claim', 'conv-1')

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'support.claim',
        actorId: 'clerk-1',
        actorName: 'clerk1',
        target: 'conversation:conv-1',
        detail: {},
      },
    })
  })

  it('still records the action when the actor name cannot be resolved', async () => {
    ;(prisma.user.findUnique as any).mockRejectedValue(new Error('db blip'))
    ;(prisma.auditLog.create as any).mockResolvedValue({})

    await writeSupportAudit('clerk-1', 'support.claim', 'conv-1')

    expect((prisma.auditLog.create as any).mock.calls[0][0].data.actorName).toBeNull()
  })

  it('never lets an audit failure reject the action it records', async () => {
    ;(prisma.user.findUnique as any).mockResolvedValue({ username: 'clerk1' })
    ;(prisma.auditLog.create as any).mockRejectedValue(new Error('db down'))

    await expect(writeSupportAudit('clerk-1', 'support.resolve', 'conv-1')).resolves.toBeUndefined()
  })
})
