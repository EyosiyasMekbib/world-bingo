import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AdminService } from '../services/admin.service'
import { WalletService } from '../services/wallet.service'
import { HouseWalletService } from '../services/house-wallet.service'
import { prisma } from './setup'
import { TransactionType, PaymentStatus } from '@world-bingo/shared-types'

vi.mock('../services/notification.service', () => ({
    NotificationService: {
        create: vi.fn().mockResolvedValue({ id: 'notif-1' }),
        pushWalletUpdate: vi.fn(),
    },
}))

describe('AdminService.getStats — extended fields', () => {
  let userId: string

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: {
        username: 'stats_test_user',
        phone: '+251900300001',
        passwordHash: 'hashed:pass',
        role: 'PLAYER',
        wallet: { create: { realBalance: 500 } },
      },
    })
    userId = user.id

    await prisma.transaction.create({
      data: {
        userId, type: 'DEPOSIT', status: 'APPROVED',
        amount: 500, balanceBefore: 0, balanceAfter: 500,
        bonusBalanceBefore: 0, bonusBalanceAfter: 0,
      },
    })
    await prisma.transaction.create({
      data: {
        userId, type: 'WITHDRAWAL', status: 'APPROVED',
        amount: 100, balanceBefore: 500, balanceAfter: 400,
        bonusBalanceBefore: 0, bonusBalanceAfter: 0,
      },
    })
    await prisma.transaction.create({
      data: {
        userId, type: 'PRIZE_WIN', status: 'APPROVED',
        amount: 200, balanceBefore: 400, balanceAfter: 600,
        bonusBalanceBefore: 0, bonusBalanceAfter: 0,
      },
    })
  })

  it('returns totalPrizesSum from PRIZE_WIN transactions', async () => {
    const stats = await AdminService.getStats()
    expect(stats.totalPrizesSum).toBeGreaterThanOrEqual(200)
  })

  it('returns gamesCompleted count', async () => {
    const stats = await AdminService.getStats()
    expect(typeof stats.gamesCompleted).toBe('number')
  })

  it('returns gamesCancelled count', async () => {
    const stats = await AdminService.getStats()
    expect(typeof stats.gamesCancelled).toBe('number')
  })

  it('returns houseBalance as a number', async () => {
    const stats = await AdminService.getStats()
    expect(typeof stats.houseBalance).toBe('number')
  })

  it('returns houseCommissionEarned from houseTransaction COMMISSION sum', async () => {
    const stats = await AdminService.getStats()
    expect(typeof stats.houseCommissionEarned).toBe('number')
  })

  it('returns providerStats as an array', async () => {
    const stats = await AdminService.getStats()
    expect(Array.isArray(stats.providerStats)).toBe(true)
  })

  it('returns correct approvedDepositSum', async () => {
    const stats = await AdminService.getStats()
    expect(stats.approvedDepositSum).toBeGreaterThanOrEqual(500)
  })

  it('returns correct approvedWithdrawalSum', async () => {
    const stats = await AdminService.getStats()
    expect(stats.approvedWithdrawalSum).toBeGreaterThanOrEqual(100)
  })

  it('returns activePlayers as a non-negative number', async () => {
    const stats = await AdminService.getStats()
    expect(typeof stats.activePlayers).toBe('number')
    expect(stats.activePlayers).toBeGreaterThanOrEqual(0)
  })

  it('providerStats entries have name, gained, lost, net fields', async () => {
    const stats = await AdminService.getStats()
    for (const p of stats.providerStats) {
      expect(typeof p.name).toBe('string')
      expect(typeof p.gained).toBe('number')
      expect(typeof p.lost).toBe('number')
      expect(typeof p.net).toBe('number')
      expect(p.net).toBe(p.gained - p.lost)
    }
  })
})

describe('AdminService.reviewTransaction', () => {
    let userId: string
    let withdrawalTxId: string

    beforeEach(async () => {
        const user = await prisma.user.create({
            data: {
                username: 'admin_test_user',
                phone: '+251900200001',
                passwordHash: 'hashed:pass',
                wallet: { create: { realBalance: 1000 } },
            },
        })
        userId = user.id

        // Simulate a withdrawal request: balance deducted immediately
        const tx = await prisma.transaction.create({
            data: {
                userId,
                type: TransactionType.WITHDRAWAL,
                amount: 300,
                status: PaymentStatus.PENDING_REVIEW,
                note: 'Telebirr: 0912345678',
                balanceBefore: 1000,
                balanceAfter: 700,
                bonusBalanceBefore: 0,
                bonusBalanceAfter: 0,
            },
        })
        withdrawalTxId = tx.id

        // Balance was pre-deducted when withdrawal was requested
        await prisma.wallet.update({
            where: { userId },
            data: { realBalance: 700 },
        })
    })

    describe('WITHDRAWAL rejection', () => {
        it('should refund wallet when withdrawal is rejected', async () => {
            await AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED, 'Invalid account')

            const wallet = await WalletService.getBalance(userId)
            expect(Number(wallet.realBalance)).toBe(1000) // 700 + 300 refunded
        })

        it('should create a REFUND compensation transaction for audit trail', async () => {
            await AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED, 'Invalid account')

            const refundTx = await prisma.transaction.findFirst({
                where: { userId, type: TransactionType.REFUND, referenceId: withdrawalTxId },
            })
            expect(refundTx).not.toBeNull()
            expect(Number(refundTx!.amount)).toBe(300)
            expect(refundTx!.status).toBe(PaymentStatus.APPROVED)
        })

        it('should record correct balance snapshots in the REFUND transaction', async () => {
            await AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED, 'test')

            const refundTx = await prisma.transaction.findFirst({
                where: { userId, type: TransactionType.REFUND, referenceId: withdrawalTxId },
            })
            expect(Number(refundTx!.balanceBefore)).toBe(700)  // balance at time of rejection
            expect(Number(refundTx!.balanceAfter)).toBe(1000)  // balance after refund
        })

        it('should mark the original WITHDRAWAL as REJECTED', async () => {
            await AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED, 'Bad actor')

            const tx = await prisma.transaction.findUnique({ where: { id: withdrawalTxId } })
            expect(tx!.status).toBe(PaymentStatus.REJECTED)
            expect(tx!.note).toContain('Bad actor')
        })

        it('should push WebSocket balance update after rejection', async () => {
            const { NotificationService } = await import('../services/notification.service')

            await AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED)

            expect(NotificationService.pushWalletUpdate).toHaveBeenCalledWith(
                userId,
                1000, // refunded balance
                0,    // bonus balance unchanged
            )
        })

        it('should throw when rejecting an already-REJECTED withdrawal (prevent double-refund)', async () => {
            // First rejection
            await AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED)

            // Second rejection — must throw
            await expect(
                AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED),
            ).rejects.toThrow()
        })

        it('should throw when rejecting an APPROVED withdrawal', async () => {
            await prisma.transaction.update({
                where: { id: withdrawalTxId },
                data: { status: PaymentStatus.APPROVED },
            })

            await expect(
                AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED),
            ).rejects.toThrow()
        })
    })

    // Task 9 review fix (Important 3): once a withdrawal has been submitted to
    // ZareCash (gatewayRef set), it settles or refunds via webhook — not via this
    // manual admin route. Approving would double-pay a payout ZareCash is about
    // to settle; rejecting would refund a payout that may already be in flight.
    describe('WITHDRAWAL — ZareCash-managed (gatewayRef set)', () => {
        beforeEach(async () => {
            await prisma.transaction.update({
                where: { id: withdrawalTxId },
                data: { gatewayRef: 'wd_test_ref' },
            })
        })

        it('refuses to approve a payout ZareCash is managing', async () => {
            await expect(
                AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.APPROVED),
            ).rejects.toThrow('managed by ZareCash')

            const tx = await prisma.transaction.findUnique({ where: { id: withdrawalTxId } })
            expect(tx!.status).toBe(PaymentStatus.PENDING_REVIEW)
        })

        it('refuses to reject (and refund) a payout ZareCash is managing', async () => {
            await expect(
                AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED, 'operator note'),
            ).rejects.toThrow('managed by ZareCash')

            const tx = await prisma.transaction.findUnique({ where: { id: withdrawalTxId } })
            expect(tx!.status).toBe(PaymentStatus.PENDING_REVIEW)

            // No refund fired — balance stays at the pre-deducted amount from beforeEach.
            const wallet = await WalletService.getBalance(userId)
            expect(Number(wallet.realBalance)).toBe(700)
        })
    })

    // Final-review Critical 2. The guard above was armed by `gatewayRef`, which
    // is only written AFTER createWithdrawal returns. Between the local debit and
    // that write the payout POST is in flight — ZARECASH_TIMEOUT_MS per attempt,
    // several attempts — and during that whole window the row is PENDING_REVIEW
    // with gatewayRef still null. A clerk working the queue sailed straight
    // through the guard. `gateway` is written in the same transaction as the
    // debit, so there is no window at all.
    describe('WITHDRAWAL — ZareCash-routed, submit still in flight (gateway set, gatewayRef null)', () => {
        beforeEach(async () => {
            // Exactly the state requestWithdrawal commits: routed and debited, job
            // enqueued, worker's POST not yet answered.
            await prisma.transaction.update({
                where: { id: withdrawalTxId },
                data: { gateway: 'zarecash', gatewayRef: null },
            })
        })

        it('refuses to reject-and-refund a payout whose submission is still in flight', async () => {
            await expect(
                AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED, 'clerk rejected'),
            ).rejects.toThrow('managed by ZareCash')

            const tx = await prisma.transaction.findUnique({ where: { id: withdrawalTxId } })
            expect(tx!.status).toBe(PaymentStatus.PENDING_REVIEW)

            // The money assertion: no re-credit. Under the gatewayRef-keyed guard
            // this was 1000 — refunded locally while ZareCash went on to settle.
            const wallet = await WalletService.getBalance(userId)
            expect(Number(wallet.realBalance)).toBe(700)

            // And no REFUND compensation row was written.
            const refunds = await prisma.transaction.findMany({
                where: { userId, type: TransactionType.REFUND },
            })
            expect(refunds).toHaveLength(0)
        })

        it('refuses to hand-approve a payout whose submission is still in flight', async () => {
            await expect(
                AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.APPROVED, 'paid by hand'),
            ).rejects.toThrow('managed by ZareCash')

            const tx = await prisma.transaction.findUnique({ where: { id: withdrawalTxId } })
            expect(tx!.status).toBe(PaymentStatus.PENDING_REVIEW)
        })

        it('releases the row to admins once the payout has failed permanently and been refunded', async () => {
            // The worker's permanent-failure path refunds through
            // WalletService.rejectWithdrawal, leaving the row REJECTED but still
            // carrying gateway='zarecash'. That must NOT read as "still managed" —
            // it is settled business, and an admin asking about it deserves the
            // ordinary answer, not "wait for a webhook" forever.
            await WalletService.rejectWithdrawal(withdrawalTxId, 'ZareCash refused the payout')

            const tx = await prisma.transaction.findUnique({ where: { id: withdrawalTxId } })
            expect(tx!.status).toBe(PaymentStatus.REJECTED)
            expect(tx!.gateway).toBe('zarecash')

            const wallet = await WalletService.getBalance(userId)
            expect(Number(wallet.realBalance)).toBe(1000) // refunded

            await expect(
                AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.APPROVED),
            ).rejects.toThrow(/not pending review/i)
        })
    })

    // The guard above must not touch the manual path (no gateway, no gatewayRef)
    // at all — a manual withdrawal (cash sent by hand, no ZareCash involved) must
    // approve and reject-with-refund exactly as it did before this task.
    describe('WITHDRAWAL — manual (gateway and gatewayRef null)', () => {
        it('still approves normally', async () => {
            const updated = await AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.APPROVED, 'paid by hand')
            expect(updated.status).toBe(PaymentStatus.APPROVED)

            const tx = await prisma.transaction.findUnique({ where: { id: withdrawalTxId } })
            expect(tx!.status).toBe(PaymentStatus.APPROVED)
        })

        it('still rejects-with-refund normally', async () => {
            await AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED, 'bad account')

            const wallet = await WalletService.getBalance(userId)
            expect(Number(wallet.realBalance)).toBe(1000) // 700 + 300 refunded

            const tx = await prisma.transaction.findUnique({ where: { id: withdrawalTxId } })
            expect(tx!.status).toBe(PaymentStatus.REJECTED)
        })
    })

    describe('DEPOSIT rejection', () => {
        let depositTxId: string

        beforeEach(async () => {
            // Deposits are PENDING_REVIEW with no wallet change
            const tx = await prisma.transaction.create({
                data: {
                    userId,
                    type: TransactionType.DEPOSIT,
                    amount: 500,
                    status: PaymentStatus.PENDING_REVIEW,
                },
            })
            depositTxId = tx.id
        })

        it('should NOT change wallet balance when rejecting a deposit', async () => {
            const beforeWallet = await WalletService.getBalance(userId)

            await AdminService.reviewTransaction(depositTxId, PaymentStatus.REJECTED, 'Fake receipt')

            const afterWallet = await WalletService.getBalance(userId)
            expect(Number(afterWallet.realBalance)).toBe(Number(beforeWallet.realBalance))
        })

        it('should mark deposit as REJECTED', async () => {
            await AdminService.reviewTransaction(depositTxId, PaymentStatus.REJECTED, 'Fake receipt')

            const tx = await prisma.transaction.findUnique({ where: { id: depositTxId } })
            expect(tx!.status).toBe(PaymentStatus.REJECTED)
        })

        it('should NOT create a REFUND transaction for a rejected deposit', async () => {
            await AdminService.reviewTransaction(depositTxId, PaymentStatus.REJECTED)

            const refundTx = await prisma.transaction.findFirst({
                where: { userId, type: TransactionType.REFUND },
            })
            expect(refundTx).toBeNull()
        })
    })
})

describe('AdminService.getStats', () => {
    it('should return non-zero commission when house wallet has COMMISSION transactions', async () => {
        await HouseWalletService.credit(500, 'COMMISSION', 'game commission')

        const stats = await AdminService.getStats()

        expect(stats.commission).toBe(500)
    })

    it('should return 0 commission when no house transactions exist', async () => {
        const stats = await AdminService.getStats()
        expect(stats.commission).toBe(0)
    })
})

describe('AdminService.getTransactions — filter params', () => {
  let userId: string

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: {
        username: 'filter_test_user',
        phone: '+251900400001',
        passwordHash: 'hashed:pass',
        serial: 99901,
        wallet: { create: { realBalance: 1000 } },
      },
    })
    userId = user.id

    await prisma.transaction.createMany({
      data: [
        {
          userId, type: 'DEPOSIT', status: 'APPROVED',
          amount: 100, balanceBefore: 0, balanceAfter: 100,
          bonusBalanceBefore: 0, bonusBalanceAfter: 0,
          createdAt: new Date('2026-01-15T10:00:00Z'),
        },
        {
          userId, type: 'DEPOSIT', status: 'APPROVED',
          amount: 500, balanceBefore: 100, balanceAfter: 600,
          bonusBalanceBefore: 0, bonusBalanceAfter: 0,
          createdAt: new Date('2026-02-20T10:00:00Z'),
        },
        {
          userId, type: 'DEPOSIT', status: 'PENDING_REVIEW',
          amount: 250, balanceBefore: 600, balanceAfter: 850,
          bonusBalanceBefore: 0, bonusBalanceAfter: 0,
          createdAt: new Date('2026-03-01T10:00:00Z'),
        },
      ],
    })
  })

  it('filters by from/to date range', async () => {
    const result = await AdminService.getTransactions({
      type: 'DEPOSIT' as any,
      from: new Date('2026-02-01'),
      to: new Date('2026-02-28'),
    })
    expect(result.data).toHaveLength(1)
    expect(Number(result.data[0].amount)).toBe(500)
  })

  it('filters by minAmount', async () => {
    const result = await AdminService.getTransactions({
      type: 'DEPOSIT' as any,
      minAmount: 200,
    })
    expect(result.data.length).toBeGreaterThanOrEqual(2)
    result.data.forEach(tx => expect(Number(tx.amount)).toBeGreaterThanOrEqual(200))
  })

  it('filters by maxAmount', async () => {
    const result = await AdminService.getTransactions({
      type: 'DEPOSIT' as any,
      maxAmount: 200,
    })
    result.data.forEach(tx => expect(Number(tx.amount)).toBeLessThanOrEqual(200))
  })

  it('filters by userSerial', async () => {
    const result = await AdminService.getTransactions({
      type: 'DEPOSIT' as any,
      userSerial: 99901,
    })
    expect(result.data.length).toBeGreaterThanOrEqual(1)
    result.data.forEach(tx => expect((tx as any).user.serial).toBe(99901))
  })
})

describe('AdminService.getMoneyFlow', () => {
  let userId: string

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: {
        username: 'flow_test_user',
        phone: '+251900500001',
        passwordHash: 'hashed:pass',
        wallet: { create: { realBalance: 1000 } },
      },
    })
    userId = user.id

    await prisma.transaction.createMany({
      data: [
        {
          userId, type: 'DEPOSIT', status: 'APPROVED',
          amount: 300, balanceBefore: 0, balanceAfter: 300,
          bonusBalanceBefore: 0, bonusBalanceAfter: 0,
        },
        {
          userId, type: 'PRIZE_WIN', status: 'APPROVED',
          amount: 150, balanceBefore: 300, balanceAfter: 450,
          bonusBalanceBefore: 0, bonusBalanceAfter: 0,
        },
      ],
    })
  })

  it('returns rows, total, summary', async () => {
    const result = await AdminService.getMoneyFlow({ page: 1, limit: 20 })
    expect(Array.isArray(result.rows)).toBe(true)
    expect(typeof result.total).toBe('number')
    expect(result.summary).toHaveProperty('totalDeposited')
    expect(result.summary).toHaveProperty('totalWagered')
    expect(result.summary).toHaveProperty('totalPrizesOut')
    expect(result.summary).toHaveProperty('houseKept')
    expect(result.summary).toHaveProperty('refundsIssued')
  })

  it('each row has required shape', async () => {
    const result = await AdminService.getMoneyFlow({ page: 1, limit: 20 })
    if (result.rows.length > 0) {
      const row = result.rows[0]
      expect(row).toHaveProperty('id')
      expect(row).toHaveProperty('createdAt')
      expect(row).toHaveProperty('type')
      expect(row).toHaveProperty('direction')
      expect(row).toHaveProperty('amount')
      expect(row).toHaveProperty('source')
      expect(['IN', 'OUT']).toContain(row.direction)
    }
  })

  it('filters by direction IN', async () => {
    const result = await AdminService.getMoneyFlow({ page: 1, limit: 20, direction: 'IN' })
    result.rows.forEach(r => expect(r.direction).toBe('IN'))
  })

  it('DEPOSIT rows have direction IN', async () => {
    const result = await AdminService.getMoneyFlow({ page: 1, limit: 20 })
    const depositRows = result.rows.filter(r => r.type === 'DEPOSIT')
    depositRows.forEach(r => expect(r.direction).toBe('IN'))
  })

  it('PRIZE_WIN rows have direction IN', async () => {
    const result = await AdminService.getMoneyFlow({ page: 1, limit: 20 })
    const prizeRows = result.rows.filter(r => r.type === 'PRIZE_WIN')
    prizeRows.forEach(r => expect(r.direction).toBe('IN'))
  })
})
