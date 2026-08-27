import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    transaction: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}))
vi.mock('../services/notification.service', () => ({
  NotificationService: { create: vi.fn().mockResolvedValue({}) },
}))
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }))
vi.mock('../lib/sentry', () => ({ reportError, reportWarning: vi.fn() }))
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

/**
 * Final-review Important 2. Terminal states can arrive INLINE, not only as a
 * webhook. Verified against the emitter: WithdrawalsService.create settles the
 * sandbox happy path immediately and returns state 'approved' — recording AND
 * enqueuing withdrawal.approved before the HTTP response reaches us. Handling
 * only 'rejected' left an approved payout stuck in PENDING_REVIEW.
 */
describe('submitWithdrawal — inline terminal states', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(prisma as any).transaction.updateMany.mockResolvedValue({ count: 1 })
  })

  it('settles a payout ZareCash approved inline instead of leaving it PENDING_REVIEW', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockResolvedValue({ id: 'wd_a', state: 'approved', settlementRef: 'SBX1234' })

    await ZareCashService.submitWithdrawal(JOB)

    expect((prisma as any).transaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx1', status: 'PENDING_REVIEW' },
      data: { status: 'APPROVED', note: expect.stringContaining('SBX1234') },
    })
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  it('refunds a payout ZareCash cancelled inline', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockResolvedValue({ id: 'wd_c', state: 'cancelled' })

    await ZareCashService.submitWithdrawal(JOB)

    expect(rejectWithdrawal).toHaveBeenCalledWith('tx1', expect.stringContaining('cancelled'))
  })

  it('tolerates the webhook winning the race — a duplicate inline refund is not an error', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockResolvedValue({ id: 'wd_r', state: 'rejected' })
    rejectWithdrawal.mockRejectedValueOnce(new Error('Transaction is not pending review'))

    await expect(ZareCashService.submitWithdrawal(JOB)).resolves.toBeUndefined()
  })

  it('still propagates a genuine refund failure on the inline path', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockResolvedValue({ id: 'wd_r', state: 'rejected' })
    rejectWithdrawal.mockRejectedValueOnce(new Error('Wallet not found'))

    await expect(ZareCashService.submitWithdrawal(JOB)).rejects.toThrow('Wallet not found')
  })

  it('leaves risk_hold pending — a human at ZareCash decides', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockResolvedValue({ id: 'wd_h', state: 'risk_hold' })

    await ZareCashService.submitWithdrawal(JOB)

    expect(rejectWithdrawal).not.toHaveBeenCalled()
    expect((prisma as any).transaction.updateMany).not.toHaveBeenCalled()
  })
})
