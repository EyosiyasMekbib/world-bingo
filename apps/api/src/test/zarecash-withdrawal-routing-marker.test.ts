/**
 * Final-review Critical 2, producer side.
 *
 * The admin double-pay guard is only as good as the moment the row is marked.
 * `gatewayRef` is written after createWithdrawal returns; `gateway` is written in
 * the same transaction that debits the wallet, so the guard is armed before the
 * job is even enqueued and there is no window for a clerk to walk through.
 *
 * Real DB, because the point is what actually lands on the committed row. Only
 * the queue is mocked — there is no Redis here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { add } = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queue')>()
  return { ...actual, getQueue: () => ({ add }) }
})
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }))
vi.mock('../lib/sentry', () => ({ reportError, reportWarning: vi.fn() }))

import { WalletService } from '../services/wallet.service'
import { clearMethodCache } from '../gateways/payment/zarecash/method-config'
import { prisma } from './setup'
import { PaymentStatus } from '@world-bingo/shared-types'

const ZC_METHOD = 'zc_telebirr'
const MANUAL_METHOD = 'manual_cbe'

describe('requestWithdrawal — the routing decision lands on the row', () => {
  let userId: string

  beforeEach(async () => {
    vi.clearAllMocks()
    await prisma.paymentMethod.deleteMany({ where: { code: { in: [ZC_METHOD, MANUAL_METHOD] } } })
    await prisma.paymentMethod.createMany({
      data: [
        { code: ZC_METHOD, name: 'TeleBirr (ZareCash)', type: 'WITHDRAWAL', gateway: 'zarecash', gatewayMethodCode: 'telebirr' },
        { code: MANUAL_METHOD, name: 'CBE (manual)', type: 'WITHDRAWAL', gateway: 'manual' },
      ],
    })
    clearMethodCache() // the resolver caches for 60s; these rows are new.

    const user = await prisma.user.create({
      data: {
        username: 'zc_marker_user',
        phone: '+251900700001',
        passwordHash: 'hashed:pass',
        wallet: { create: { realBalance: 1000 } },
      },
    })
    userId = user.id
  })

  afterEach(async () => {
    await prisma.paymentMethod.deleteMany({ where: { code: { in: [ZC_METHOD, MANUAL_METHOD] } } })
    clearMethodCache()
  })

  it('marks a ZareCash-routed payout gateway-managed in the same commit as the debit', async () => {
    const tx = await WalletService.requestWithdrawal(userId, {
      amount: 300,
      paymentMethod: ZC_METHOD,
      accountNumber: '0912345678',
    })

    const row = await prisma.transaction.findUnique({ where: { id: tx.id } })
    expect(row!.gateway).toBe('zarecash')
    // The guard is armed even though the payout has NOT been submitted yet —
    // that is the entire point. gatewayRef arrives much later, if at all.
    expect(row!.gatewayRef).toBeNull()
    expect(row!.status).toBe(PaymentStatus.PENDING_REVIEW)

    // And the debit committed alongside it.
    const wallet = await prisma.wallet.findUnique({ where: { userId } })
    expect(Number(wallet!.realBalance)).toBe(700)

    expect(add).toHaveBeenCalledWith('submit', expect.objectContaining({ transactionId: tx.id }), expect.any(Object))
  })

  it('leaves a manual payout unmarked so the admin queue keeps working exactly as before', async () => {
    const tx = await WalletService.requestWithdrawal(userId, {
      amount: 300,
      paymentMethod: MANUAL_METHOD,
      accountNumber: '1234567890',
    })

    const row = await prisma.transaction.findUnique({ where: { id: tx.id } })
    expect(row!.gateway).toBeNull()
    expect(add).not.toHaveBeenCalled()
  })

  it('releases the marker when the queue never accepted the job', async () => {
    // Nothing will ever submit this payout, so the gateway does not own the row
    // and must not hold the admin guard shut on it — otherwise a Redis blip
    // leaves the player debited behind a guard no worker will ever release.
    add.mockRejectedValueOnce(new Error('Redis connection lost'))

    const tx = await WalletService.requestWithdrawal(userId, {
      amount: 300,
      paymentMethod: ZC_METHOD,
      accountNumber: '0912345678',
    })

    const row = await prisma.transaction.findUnique({ where: { id: tx.id } })
    expect(row!.gateway).toBeNull()
    expect(row!.status).toBe(PaymentStatus.PENDING_REVIEW)
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: 'zarecash-withdrawal-enqueue' }),
    )
  })

  it('does not fail the request when the queue is down — the player is already debited', async () => {
    add.mockRejectedValueOnce(new Error('Redis connection lost'))

    await expect(
      WalletService.requestWithdrawal(userId, {
        amount: 300,
        paymentMethod: ZC_METHOD,
        accountNumber: '0912345678',
      }),
    ).resolves.toMatchObject({ status: PaymentStatus.PENDING_REVIEW })
  })
})
