import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    zareCashEvent: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    zareCashCheckoutSession: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    transaction: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}))
const { approveDeposit } = vi.hoisted(() => ({ approveDeposit: vi.fn().mockResolvedValue({}) }))
vi.mock('../services/wallet.service', () => ({ WalletService: { approveDeposit } }))
vi.mock('../gateways/payment/zarecash/client', () => ({
  zarecashClient: () => ({ getCheckoutSession: vi.fn() }),
}))
vi.mock('../gateways/payment/zarecash/config', () => ({
  isZareCashEnabled: () => true,
  zarecashConfig: () => ({ enabled: true, mode: 'test' }),
}))

import prisma from '../lib/prisma'
import { ZareCashService } from '../services/zarecash.service'

function event(type: string) {
  return {
    id: 'evt_1',
    type,
    receivedAt: new Date(),
    processedAt: null,
    payload: {
      id: 'evt_1',
      type,
      data: {
        id: 'dp_1',
        playerRef: 'u1',
        status: 'APPROVED',
        statedAmount: 500,
        approvedAmount: 480,
      },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('deposit.approved'))
  ;(prisma as any).zareCashCheckoutSession.findMany.mockResolvedValue([])
  ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx1' })
})

describe('deposit.approved for a hosted-checkout deposit', () => {
  it('adopts an unclaimed session and credits approvedAmount', async () => {
    // No local row: the player paid on ZareCash's page and closed the tab.
    ;(prisma as any).transaction.findUnique
      .mockResolvedValueOnce(null) // findByGatewayRef
      .mockResolvedValueOnce(null) // materialise: existing by gatewayRef
      .mockResolvedValueOnce({ id: 'tx1', status: 'PENDING_REVIEW', amount: '500' }) // re-read
    ;(prisma as any).zareCashCheckoutSession.findUnique.mockResolvedValue({
      id: 'local1',
      userId: 'u1',
      amount: '500',
      methodCode: 'zarecash',
      depositId: 'dp_1',
      transactionId: null,
    })

    await ZareCashService.processEvent('evt_1')

    expect((prisma as any).transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ gateway: 'zarecash', gatewayRef: 'dp_1' }),
      }),
    )
    expect(approveDeposit).toHaveBeenCalledWith('tx1', 480)
  })

  it('still quarantines a ref that belongs to no session', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(null)
    ;(prisma as any).zareCashCheckoutSession.findUnique.mockResolvedValue(null)

    await expect(ZareCashService.processEvent('evt_1')).rejects.toThrow(
      /matches no local transaction/,
    )
    expect(approveDeposit).not.toHaveBeenCalled()
    expect((prisma as any).transaction.create).not.toHaveBeenCalled()
  })
})
