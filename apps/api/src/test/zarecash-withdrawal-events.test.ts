import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    zareCashEvent: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    transaction: { findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  },
}))
const { rejectWithdrawal } = vi.hoisted(() => ({ rejectWithdrawal: vi.fn().mockResolvedValue({}) }))
vi.mock('../services/wallet.service', () => ({
  WalletService: { rejectWithdrawal, approveDeposit: vi.fn() },
}))
const { create } = vi.hoisted(() => ({ create: vi.fn().mockResolvedValue({}) }))
vi.mock('../services/notification.service', () => ({
  NotificationService: { create, pushWalletUpdate: vi.fn() },
}))

import prisma from '../lib/prisma'
import { ZareCashService } from '../services/zarecash.service'

function event(type: string, data: Record<string, unknown>) {
  return { id: 'evt_x', type, payload: { id: 'evt_x', type, created: 1, data }, processedAt: null }
}
const TX = { id: 'tx1', userId: 'u1', amount: '500', status: 'PENDING_REVIEW' }

describe('withdrawal webhook events', () => {
  beforeEach(() => vi.clearAllMocks())

  it('settles the withdrawal and records the settlementRef', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('withdrawal.approved', { id: 'wd_1', settlementRef: 'STL-123456789' }),
    )
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)

    await ZareCashService.processEvent('evt_x')

    expect((prisma as any).transaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx1', status: 'PENDING_REVIEW' },
      data: { status: 'APPROVED', note: expect.stringContaining('STL-123456789') },
    })
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  it('refunds on withdrawal.rejected', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('withdrawal.rejected', { id: 'wd_2' }))
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    await ZareCashService.processEvent('evt_x')
    expect(rejectWithdrawal).toHaveBeenCalledWith('tx1', expect.stringContaining('ZareCash'))
  })

  it('refunds on withdrawal.cancelled', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('withdrawal.cancelled', { id: 'wd_3' }))
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    await ZareCashService.processEvent('evt_x')
    expect(rejectWithdrawal).toHaveBeenCalledWith('tx1', expect.stringContaining('cancelled'))
  })

  it('keeps queued_float pending and notifies the player', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('withdrawal.queued_float', { id: 'wd_4' }))
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    await ZareCashService.processEvent('evt_x')
    expect(rejectWithdrawal).not.toHaveBeenCalled()
    expect((prisma as any).transaction.updateMany).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalled()
  })

  it('keeps risk_hold pending without notifying the player', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('withdrawal.risk_hold', { id: 'wd_5' }))
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    await ZareCashService.processEvent('evt_x')
    expect(rejectWithdrawal).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('tolerates a refund replay for an already-rejected withdrawal', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('withdrawal.rejected', { id: 'wd_2' }))
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    rejectWithdrawal.mockRejectedValueOnce(new Error('Transaction is not pending review'))
    await expect(ZareCashService.processEvent('evt_x')).resolves.toBeUndefined()
  })

  it('logs float.low without touching any transaction', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('float.low', { available: 5000, lowFloatThreshold: 100000 }),
    )
    await ZareCashService.processEvent('evt_x')
    expect((prisma as any).transaction.findUnique).not.toHaveBeenCalled()
  })
})
