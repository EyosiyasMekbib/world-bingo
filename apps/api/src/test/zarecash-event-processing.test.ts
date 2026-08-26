import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    zareCashEvent: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    transaction: { findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  },
}))
const { approveDeposit } = vi.hoisted(() => ({ approveDeposit: vi.fn().mockResolvedValue({}) }))
vi.mock('../services/wallet.service', () => ({
  WalletService: { approveDeposit, rejectWithdrawal: vi.fn() },
}))

import prisma from '../lib/prisma'
import { ZareCashService } from '../services/zarecash.service'

function event(type: string, data: Record<string, unknown>) {
  return { id: 'evt_1', type, payload: { id: 'evt_1', type, created: 1, data }, processedAt: null }
}

describe('ZareCashService.processEvent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('credits with approvedAmount on deposit.approved', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('deposit.approved', { id: 'dp_1', approvedAmount: 480, statedAmount: 500 }),
    )
    ;(prisma as any).transaction.findUnique.mockResolvedValue({ id: 'tx1', amount: '500', status: 'PENDING_REVIEW' })

    await ZareCashService.processEvent('evt_1')

    expect((prisma as any).transaction.findUnique).toHaveBeenCalledWith({ where: { gatewayRef: 'dp_1' } })
    expect(approveDeposit).toHaveBeenCalledWith('tx1', 480)
    expect((prisma as any).zareCashEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt_1' }, data: { processedAt: expect.any(Date), error: null },
    })
  })

  it('falls back to the local amount when approvedAmount is absent', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('deposit.approved', { id: 'dp_1', approvedAmount: null }),
    )
    ;(prisma as any).transaction.findUnique.mockResolvedValue({ id: 'tx1', amount: '500', status: 'PENDING_REVIEW' })
    await ZareCashService.processEvent('evt_1')
    expect(approveDeposit).toHaveBeenCalledWith('tx1', 500)
  })

  it('swallows an already-approved replay instead of failing the job', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('deposit.approved', { id: 'dp_1', approvedAmount: 500 }),
    )
    ;(prisma as any).transaction.findUnique.mockResolvedValue({ id: 'tx1', amount: '500', status: 'PENDING_REVIEW' })
    approveDeposit.mockRejectedValueOnce(new Error('Invalid transaction'))

    await expect(ZareCashService.processEvent('evt_1')).resolves.toBeUndefined()
    expect((prisma as any).zareCashEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt_1' }, data: { processedAt: expect.any(Date), error: null },
    })
  })

  it('skips a redelivery when the transaction status is already terminal', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('deposit.approved', { id: 'dp_1', approvedAmount: 500 }),
    )
    ;(prisma as any).transaction.findUnique.mockResolvedValue({ id: 'tx1', amount: '500', status: 'APPROVED' })

    await ZareCashService.processEvent('evt_1')

    expect(approveDeposit).not.toHaveBeenCalled()
    expect((prisma as any).zareCashEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt_1' }, data: { processedAt: expect.any(Date), error: null },
    })
  })

  it('rethrows a genuine approveDeposit failure and records it on the event row without stamping processedAt', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('deposit.approved', { id: 'dp_1', approvedAmount: 500 }),
    )
    ;(prisma as any).transaction.findUnique.mockResolvedValue({ id: 'tx1', amount: '500', status: 'PENDING_REVIEW' })
    approveDeposit.mockRejectedValueOnce(new Error('Wallet not found'))

    await expect(ZareCashService.processEvent('evt_1')).rejects.toThrow('Wallet not found')

    expect((prisma as any).zareCashEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt_1' }, data: { error: 'Wallet not found' },
    })
    expect((prisma as any).zareCashEvent.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ processedAt: expect.anything() }) }),
    )
  })

  it('swallows a concurrent-race Invalid transaction when the row was still PENDING_REVIEW', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('deposit.approved', { id: 'dp_1', approvedAmount: 500 }),
    )
    ;(prisma as any).transaction.findUnique.mockResolvedValue({ id: 'tx1', amount: '500', status: 'PENDING_REVIEW' })
    approveDeposit.mockRejectedValueOnce(new Error('Invalid transaction'))

    await expect(ZareCashService.processEvent('evt_1')).resolves.toBeUndefined()
    expect((prisma as any).zareCashEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt_1' }, data: { processedAt: expect.any(Date), error: null },
    })
  })

  it('marks the deposit rejected without touching the wallet', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('deposit.rejected', { id: 'dp_2' }))
    ;(prisma as any).transaction.findUnique.mockResolvedValue({ id: 'tx2', amount: '500' })

    await ZareCashService.processEvent('evt_1')

    expect(approveDeposit).not.toHaveBeenCalled()
    expect((prisma as any).transaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx2', status: 'PENDING_REVIEW' },
      data: { status: 'REJECTED', note: expect.stringContaining('ZareCash') },
    })
  })

  it('skips an event already processed', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue({
      ...event('deposit.approved', { id: 'dp_1' }), processedAt: new Date(),
    })
    await ZareCashService.processEvent('evt_1')
    expect(approveDeposit).not.toHaveBeenCalled()
  })

  it('ignores an unknown event type without failing', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('something.new', {}))
    await expect(ZareCashService.processEvent('evt_1')).resolves.toBeUndefined()
    expect((prisma as any).zareCashEvent.update).toHaveBeenCalled()
  })

  it('records the error and rethrows so BullMQ retries', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('deposit.approved', { id: 'dp_1', approvedAmount: 500 }),
    )
    ;(prisma as any).transaction.findUnique.mockRejectedValue(new Error('db down'))

    await expect(ZareCashService.processEvent('evt_1')).rejects.toThrow('db down')
    expect((prisma as any).zareCashEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt_1' }, data: { error: 'db down' },
    })
  })
})
