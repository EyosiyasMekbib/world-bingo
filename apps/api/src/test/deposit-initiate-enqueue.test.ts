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
  ZARECASH_WITHDRAWAL_ATTEMPTS: 8,
}))
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }))
vi.mock('../lib/sentry', () => ({ reportError, reportWarning: vi.fn() }))

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

  // Final-review Important 1. Both sibling paths already refuse to let a queue
  // hiccup surface as a request error; this one threw.
  describe('a failed ZareCash enqueue must not fail the request', () => {
    it('returns the transaction instead of throwing when the queue is down', async () => {
      isZareCashMethod.mockResolvedValue(true)
      ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx-zc', amount: 500 })
      add.mockRejectedValueOnce(new Error('Redis connection lost'))

      // Throwing here 500s the route. The row is already committed and
      // `paymentTransactionId` is unique, so the player's retry with the same
      // receipt hits the duplicate check and 409s "Transaction ID already used" —
      // permanently locked out of that receipt, with an orphaned PENDING_REVIEW
      // row and no job that will ever submit it.
      const tx = await WalletService.initiateDeposit('user1', {
        amount: 500, transactionId: 'ABC12345', methodCode: 'telebirr',
      } as any)

      expect(tx).toEqual({ id: 'tx-zc', amount: 500 })
    })

    it('reports the failure rather than swallowing it silently', async () => {
      isZareCashMethod.mockResolvedValue(true)
      ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx-zc', amount: 500 })
      add.mockRejectedValueOnce(new Error('Redis connection lost'))

      await WalletService.initiateDeposit('user1', {
        amount: 500, transactionId: 'ABC12345', methodCode: 'telebirr',
      } as any)

      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ phase: 'zarecash-deposit-enqueue', transactionId: 'tx-zc' }),
      )
    })
  })

  // Final-review Critical 2, deposit half: the routing decision is recorded on
  // the row rather than being inferred later from an id we do not have yet.
  it('records the routing decision on the row for an opted-in method', async () => {
    isZareCashMethod.mockResolvedValue(true)
    ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx-zc', amount: 500 })

    await WalletService.initiateDeposit('user1', {
      amount: 500, transactionId: 'ABC12345', methodCode: 'telebirr',
    } as any)

    expect((prisma as any).transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ gateway: 'zarecash' }) }),
    )
  })

  it('leaves gateway unset for a manual method', async () => {
    isZareCashMethod.mockResolvedValue(false)
    ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx-manual', amount: 500 })

    await WalletService.initiateDeposit('user1', {
      amount: 500, transactionId: 'XYZ98765', methodCode: 'cbe',
    } as any)

    const data = (prisma as any).transaction.create.mock.calls[0][0].data
    expect(data.gateway).toBeUndefined()
  })
})
