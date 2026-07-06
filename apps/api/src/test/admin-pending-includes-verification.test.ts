import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    transaction: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  },
}))
import prisma from '../lib/prisma'
import { AdminService } from '../services/admin.service'

describe('getTransactions includes depositVerification', () => {
  beforeEach(() => vi.clearAllMocks())
  it('passes depositVerification in the include', async () => {
    await AdminService.getTransactions({ status: 'PENDING_REVIEW' as any, page: 1, limit: 20 })
    const arg = (prisma as any).transaction.findMany.mock.calls[0][0]
    expect(arg.include.depositVerification).toBe(true)
  })
})
