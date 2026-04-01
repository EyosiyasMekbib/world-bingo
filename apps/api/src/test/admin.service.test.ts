import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AdminService } from '../services/admin.service'
import { WalletService } from '../services/wallet.service'
import { prisma } from './setup'
import { TransactionType, PaymentStatus } from '@world-bingo/shared-types'

vi.mock('../services/notification.service', () => ({
    NotificationService: {
        create: vi.fn().mockResolvedValue({ id: 'notif-1' }),
        pushWalletUpdate: vi.fn(),
    },
}))

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
