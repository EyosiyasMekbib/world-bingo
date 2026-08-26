import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    transaction: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  },
}))
const { createDeposit } = vi.hoisted(() => ({ createDeposit: vi.fn() }))
vi.mock('../gateways/payment/zarecash/client', () => ({
  zarecashClient: () => ({ createDeposit }),
}))
const { approveDeposit } = vi.hoisted(() => ({ approveDeposit: vi.fn().mockResolvedValue({}) }))
vi.mock('../services/wallet.service', () => ({ WalletService: { approveDeposit } }))
vi.mock('../gateways/payment/zarecash/method-config', () => ({
  resolveMethod: vi.fn().mockResolvedValue({
    code: 'telebirr', name: 'TeleBirr', gateway: 'zarecash', gatewayMethodCode: 'telebirr',
    collectionAccount: { receiverName: 'ZC', account: '0911' },
  }),
}))

import prisma from '../lib/prisma'
import { ZareCashService } from '../services/zarecash.service'
import { ZareCashError } from '../gateways/payment/zarecash/types'

const TX = {
  id: 'tx1', userId: 'u1', amount: '500', note: 'telebirr',
  paymentTransactionId: 'ABC123', senderName: 'Abebe', senderAccount: '0912345678',
}

describe('ZareCashService.submitDeposit', () => {
  beforeEach(() => vi.clearAllMocks())

  it('submits with a derived idempotency key and stores the gatewayRef', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createDeposit.mockResolvedValue({ id: 'dp_1', status: 'PENDING_REVIEW', approvedAmount: null })

    await ZareCashService.submitDeposit('tx1')

    expect(createDeposit).toHaveBeenCalledWith(
      {
        playerRef: 'u1', amount: 500, methodCode: 'telebirr', receiptRef: 'ABC123',
        payerName: 'Abebe', payerAccount: '0912345678',
      },
      'dep_tx1',
    )
    expect((prisma as any).transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx1' }, data: { gatewayRef: 'dp_1' },
    })
    expect(approveDeposit).not.toHaveBeenCalled()
  })

  it('credits immediately when ZareCash approves inline, using approvedAmount', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createDeposit.mockResolvedValue({ id: 'dp_2', status: 'APPROVED', approvedAmount: 480 })

    await ZareCashService.submitDeposit('tx1')

    expect(approveDeposit).toHaveBeenCalledWith('tx1', 480)
  })

  it('falls back to the stated amount when approvedAmount is null', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createDeposit.mockResolvedValue({ id: 'dp_3', status: 'APPROVED', approvedAmount: null })

    await ZareCashService.submitDeposit('tx1')

    expect(approveDeposit).toHaveBeenCalledWith('tx1', 500)
  })

  it('does not credit when ZareCash rejects inline', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createDeposit.mockResolvedValue({ id: 'dp_4', status: 'REJECTED', approvedAmount: null })

    await ZareCashService.submitDeposit('tx1')

    expect(approveDeposit).not.toHaveBeenCalled()
    expect((prisma as any).transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx1' }, data: { gatewayRef: 'dp_4' },
    })
  })

  it('is a no-op when the transaction has vanished', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(null)
    await ZareCashService.submitDeposit('gone')
    expect(createDeposit).not.toHaveBeenCalled()
  })

  it('rejects locally on a permanent refusal instead of retrying forever', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    ;(prisma as any).transaction.updateMany = vi.fn().mockResolvedValue({ count: 1 })
    createDeposit.mockRejectedValue(
      new ZareCashError({ code: 'duplicate_receipt', message: 'already used', status: 409, permanent: true }),
    )

    await ZareCashService.submitDeposit('tx1')

    expect((prisma as any).transaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx1', status: 'PENDING_REVIEW' },
      data: { status: 'REJECTED', note: expect.stringContaining('duplicate_receipt') },
    })
    expect(approveDeposit).not.toHaveBeenCalled()
  })

  it('rethrows a retryable error so the job retries', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createDeposit.mockRejectedValue(
      new ZareCashError({ code: 'network_error', message: 'ECONNREFUSED', status: 0, permanent: false }),
    )
    await expect(ZareCashService.submitDeposit('tx1')).rejects.toThrow('ECONNREFUSED')
  })

  it('resolves without retrying when approveDeposit rejects a redelivery (already credited)', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createDeposit.mockResolvedValue({ id: 'dp_5', status: 'APPROVED', approvedAmount: 480 })
    approveDeposit.mockRejectedValueOnce(new Error('Invalid transaction'))

    await expect(ZareCashService.submitDeposit('tx1')).resolves.toBeUndefined()

    expect((prisma as any).transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx1' }, data: { gatewayRef: 'dp_5' },
    })
  })

  it('resolves and passes a real zero through when approvedAmount is 0 and approveDeposit rejects it', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createDeposit.mockResolvedValue({ id: 'dp_6', status: 'APPROVED', approvedAmount: 0 })
    approveDeposit.mockRejectedValueOnce(new Error('Adjusted amount must be a positive number'))

    await expect(ZareCashService.submitDeposit('tx1')).resolves.toBeUndefined()

    expect(approveDeposit).toHaveBeenCalledWith('tx1', 0)
  })
})
