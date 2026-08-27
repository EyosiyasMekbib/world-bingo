import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    zareCashEvent: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    transaction: { findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}))
const { approveDeposit, rejectWithdrawal } = vi.hoisted(() => ({
  approveDeposit: vi.fn().mockResolvedValue({}),
  rejectWithdrawal: vi.fn().mockResolvedValue({}),
}))
vi.mock('../services/wallet.service', () => ({
  WalletService: { approveDeposit, rejectWithdrawal },
}))
vi.mock('../services/notification.service', () => ({
  NotificationService: { create: vi.fn().mockResolvedValue({}) },
}))
const { reportError, reportWarning } = vi.hoisted(() => ({ reportError: vi.fn(), reportWarning: vi.fn() }))
vi.mock('../lib/sentry', () => ({ reportError, reportWarning }))

import prisma from '../lib/prisma'
import { ZareCashService } from '../services/zarecash.service'

function event(type: string, data: Record<string, unknown>, receivedAt = new Date()) {
  return { id: 'evt_1', type, payload: { id: 'evt_1', type, created: 1, data }, processedAt: null, receivedAt }
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

/**
 * Final-review Important 2, second half. A terminal event naming a gatewayRef we
 * do not recognise used to log "unknown gatewayRef" and STAMP processedAt —
 * permanently consuming it. The gatewayRef then landed a moment later and the
 * row was stuck PENDING_REVIEW forever, with the admin guard refusing both
 * manual actions. The race is real and we lose it by design: ZareCash records
 * and enqueues withdrawal.approved before the POST response carrying the id
 * reaches us.
 */
describe('processEvent — terminal event for an unknown gatewayRef', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(prisma as any).transaction.updateMany.mockResolvedValue({ count: 1 })
  })

  for (const type of ['withdrawal.approved', 'withdrawal.rejected', 'withdrawal.cancelled', 'deposit.approved', 'deposit.rejected']) {
    it(`does NOT stamp processedAt for ${type}, so the stranded pass can retry it`, async () => {
      ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event(type, { id: 'wd_unknown' }))
      ;(prisma as any).transaction.findUnique.mockResolvedValue(null)

      await expect(ZareCashService.processEvent('evt_1')).rejects.toThrow(/matches no local transaction/)

      expect((prisma as any).zareCashEvent.update).toHaveBeenCalledWith({
        where: { id: 'evt_1' },
        data: { error: expect.stringContaining('wd_unknown') },
      })
      expect((prisma as any).zareCashEvent.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ processedAt: expect.anything() }) }),
      )
    })
  }

  it('gives up and stamps it once the ref has been unknown past the grace window', async () => {
    // Otherwise this is an infinite retry. Past the window the ref is genuinely
    // unrecognisable, not merely early — so stop, but alarm.
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('withdrawal.approved', { id: 'wd_ancient' }, old),
    )
    ;(prisma as any).transaction.findUnique.mockResolvedValue(null)

    await expect(ZareCashService.processEvent('evt_1')).resolves.toBeUndefined()

    expect((prisma as any).zareCashEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt_1' },
      data: { error: expect.any(String), processedAt: expect.any(Date) },
    })
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: 'zarecash-unknown-gateway-ref-expired' }),
    )
    expect((prisma as any).auditLog.create).toHaveBeenCalled()
  })

  it('an unrecognised event TYPE is still consumed normally — no infinite retry', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('settlement.statement_ready', {}))
    await expect(ZareCashService.processEvent('evt_1')).resolves.toBeUndefined()
    expect((prisma as any).zareCashEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt_1' }, data: { processedAt: expect.any(Date), error: null },
    })
  })
})

/**
 * Final-review Important 3. `claim.count === 0` was treated as "redelivery"
 * unconditionally. If ZareCash accepted the payout then became unreachable, we
 * refund and it later settles — and the withdrawal.approved webhook then finds a
 * REJECTED row, gets count 0, and returns in silence. The RISK is spec-accepted;
 * the silence is not.
 */
describe('processEvent — withdrawal.approved landing on an already-resolved row', () => {
  beforeEach(() => vi.clearAllMocks())

  it('alarms loudly when the row was REJECTED — that is a real double payment', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('withdrawal.approved', { id: 'wd_1', settlementRef: 'STL9' }),
    )
    ;(prisma as any).transaction.findUnique
      .mockResolvedValueOnce({ id: 'tx1', userId: 'u1', amount: '500', status: 'PENDING_REVIEW' })
      .mockResolvedValueOnce({ id: 'tx1', userId: 'u1', amount: '500', status: 'REJECTED' })
    ;(prisma as any).transaction.updateMany.mockResolvedValue({ count: 0 })

    await ZareCashService.processEvent('evt_1')

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('double payment') }),
      expect.objectContaining({ phase: 'zarecash-double-payment', transactionId: 'tx1' }),
    )
    expect((prisma as any).auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'zarecash.double_payment', target: 'tx1' }),
      }),
    )
  })

  it('stays quiet when the row was already APPROVED — that is an ordinary redelivery', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('withdrawal.approved', { id: 'wd_1', settlementRef: 'STL9' }),
    )
    ;(prisma as any).transaction.findUnique
      .mockResolvedValueOnce({ id: 'tx1', userId: 'u1', amount: '500', status: 'PENDING_REVIEW' })
      .mockResolvedValueOnce({ id: 'tx1', userId: 'u1', amount: '500', status: 'APPROVED' })
    ;(prisma as any).transaction.updateMany.mockResolvedValue({ count: 0 })

    await ZareCashService.processEvent('evt_1')

    expect(reportError).not.toHaveBeenCalled()
    expect((prisma as any).auditLog.create).not.toHaveBeenCalled()
  })
})

/**
 * Final-review Minor 5. The spec asks for "an admin notification + Sentry
 * warning" on these; they were console.warn only.
 */
describe('processEvent — operational alerts', () => {
  beforeEach(() => vi.clearAllMocks())

  it('raises an alert on withdrawal.risk_hold instead of only logging', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('withdrawal.risk_hold', { id: 'wd_h' }))
    ;(prisma as any).transaction.findUnique.mockResolvedValue({ id: 'tx1', userId: 'u1', amount: '500' })

    await ZareCashService.processEvent('evt_1')

    expect(reportWarning).toHaveBeenCalledWith(
      expect.stringContaining('risk hold'),
      expect.objectContaining({ phase: 'zarecash-risk-hold', transactionId: 'tx1' }),
    )
    expect((prisma as any).auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'zarecash.risk_hold' }) }),
    )
  })

  it('raises an alert on float.low instead of only logging', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('float.low', { available: 120, lowFloatThreshold: 5000 }),
    )

    await ZareCashService.processEvent('evt_1')

    expect(reportWarning).toHaveBeenCalledWith(
      expect.stringContaining('float is low'),
      expect.objectContaining({ phase: 'zarecash-float-low', available: 120, threshold: 5000 }),
    )
    expect((prisma as any).auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'zarecash.float_low' }) }),
    )
  })

  it('still marks an alert event processed', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('float.low', { available: 1 }))
    await ZareCashService.processEvent('evt_1')
    expect((prisma as any).zareCashEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt_1' }, data: { processedAt: expect.any(Date), error: null },
    })
  })
})
