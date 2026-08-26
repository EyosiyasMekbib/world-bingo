import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: { transaction: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) } },
}))
const { createWithdrawal } = vi.hoisted(() => ({ createWithdrawal: vi.fn() }))
vi.mock('../gateways/payment/zarecash/client', () => ({ zarecashClient: () => ({ createWithdrawal }) }))
const { rejectWithdrawal } = vi.hoisted(() => ({ rejectWithdrawal: vi.fn().mockResolvedValue({}) }))
vi.mock('../services/wallet.service', () => ({
  WalletService: { rejectWithdrawal, approveDeposit: vi.fn() },
}))
vi.mock('../gateways/payment/zarecash/method-config', () => ({
  resolveMethod: vi.fn().mockResolvedValue({
    code: 'telebirr', name: 'TeleBirr', gateway: 'zarecash', gatewayMethodCode: 'telebirr',
    collectionAccount: { receiverName: 'ZC', account: '0911' },
  }),
}))

import prisma from '../lib/prisma'
import { ZareCashService } from '../services/zarecash.service'
import { ZareCashError } from '../gateways/payment/zarecash/types'

const JOB = { transactionId: 'tx1', methodCode: 'telebirr', destinationAccount: '0912345678', destinationName: 'Abebe' }
const TX = { id: 'tx1', userId: 'u1', amount: '500', status: 'PENDING_REVIEW' }

describe('ZareCashService.submitWithdrawal', () => {
  beforeEach(() => vi.clearAllMocks())

  it('submits with a derived key and stores the gatewayRef on pending', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockResolvedValue({ id: 'wd_1', state: 'pending' })

    await ZareCashService.submitWithdrawal(JOB)

    expect(createWithdrawal).toHaveBeenCalledWith(
      { playerRef: 'u1', amount: 500, methodCode: 'telebirr', destinationAccount: '0912345678', destinationName: 'Abebe' },
      'wd_tx1',
    )
    expect((prisma as any).transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx1' }, data: { gatewayRef: 'wd_1' },
    })
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  it('keeps the payout pending on queued_float', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockResolvedValue({ id: 'wd_2', state: 'queued_float' })
    await ZareCashService.submitWithdrawal(JOB)
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  it('refunds when ZareCash rejects outright', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockResolvedValue({ id: 'wd_3', state: 'rejected' })
    await ZareCashService.submitWithdrawal(JOB)
    expect(rejectWithdrawal).toHaveBeenCalledWith('tx1', expect.stringContaining('ZareCash'))
  })

  it('refunds on a permanent error so the player is not left debited', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockRejectedValue(
      new ZareCashError({ code: 'player_frozen', message: 'frozen', status: 403, permanent: true }),
    )
    await ZareCashService.submitWithdrawal(JOB)
    expect(rejectWithdrawal).toHaveBeenCalledWith('tx1', expect.stringContaining('player_frozen'))
  })

  it('rethrows a retryable error and does NOT refund', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockRejectedValue(
      new ZareCashError({ code: 'network_error', message: 'ECONNREFUSED', status: 0, permanent: false }),
    )
    await expect(ZareCashService.submitWithdrawal(JOB)).rejects.toThrow('ECONNREFUSED')
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  it('never refunds on withdrawal_pending — a payout may be in flight', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockRejectedValue(
      new ZareCashError({ code: 'withdrawal_pending', message: 'open payout', status: 409, permanent: false }),
    )
    await expect(ZareCashService.submitWithdrawal(JOB)).rejects.toThrow()
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  it('is a no-op when the withdrawal is no longer pending', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue({ ...TX, status: 'REJECTED' })
    await ZareCashService.submitWithdrawal(JOB)
    expect(createWithdrawal).not.toHaveBeenCalled()
  })
})
