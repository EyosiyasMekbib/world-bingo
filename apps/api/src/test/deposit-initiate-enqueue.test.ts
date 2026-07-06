import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    siteSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    transaction: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
  },
}))
const { enqueue } = vi.hoisted(() => ({ enqueue: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../services/deposit-verification.service', () => ({
  DepositVerificationService: { enqueue },
}))

import prisma from '../lib/prisma'
import { WalletService } from '../services/wallet.service'

describe('initiateDeposit enqueues verification', () => {
  beforeEach(() => vi.clearAllMocks())
  it('enqueues the created transaction id', async () => {
    ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx-new', amount: 500 })
    await WalletService.initiateDeposit('user1', {
      amount: 500,
      transactionId: 'ABC12345',
      methodCode: 'telebirr',
    } as any)
    expect(enqueue).toHaveBeenCalledWith('tx-new')
  })
})
