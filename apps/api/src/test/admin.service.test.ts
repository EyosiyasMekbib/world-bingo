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
