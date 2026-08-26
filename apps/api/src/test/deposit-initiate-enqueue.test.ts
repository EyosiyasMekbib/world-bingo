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
const { isZareCashMethod } = vi.hoisted(() => ({ isZareCashMethod: vi.fn().mockResolvedValue(false) }))
vi.mock('../gateways/payment/zarecash/method-config', () => ({ isZareCashMethod }))
const { add } = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/queue', () => ({
  getQueue: () => ({ add }),
  QUEUE_NAMES: { ZARECASH_DEPOSIT: 'zarecash-deposit', ZARECASH_WITHDRAWAL: 'zarecash-withdrawal' },
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

  it('submits to ZareCash and skips local verification for an opted-in method', async () => {
    isZareCashMethod.mockResolvedValue(true)
    ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx-zc', amount: 500 })

    await WalletService.initiateDeposit('user1', {
      amount: 500, transactionId: 'ABC12345', methodCode: 'telebirr',
    } as any)

    expect(add).toHaveBeenCalledWith('submit', { transactionId: 'tx-zc' })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('still enqueues local verification for a manual method', async () => {
    isZareCashMethod.mockResolvedValue(false)
    ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx-manual', amount: 500 })

    await WalletService.initiateDeposit('user1', {
      amount: 500, transactionId: 'XYZ98765', methodCode: 'cbe',
    } as any)

    expect(enqueue).toHaveBeenCalledWith('tx-manual')
    expect(add).not.toHaveBeenCalled()
  })
})
