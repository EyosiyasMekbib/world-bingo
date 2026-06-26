/**
 * Admin deposit-amount adjustment on approval.
 *
 * Covers WalletService.approveDeposit(transactionId, adjustedAmount?):
 *  - plain approve credits the player-stated amount (originalAmount stays null)
 *  - a lower/higher adjustment credits the corrected value and preserves the
 *    stated figure in originalAmount for the audit trail
 *  - an adjustment equal to the stated amount is NOT treated as an adjustment
 *  - a non-positive amount is rejected, leaving the deposit pending and the
 *    wallet untouched (money safety)
 *
 * Notification/referral/metrics side effects are mocked so the test exercises
 * only the locked DB transaction (credit + snapshot + originalAmount).
 */
import { describe, it, expect, vi } from 'vitest'
import { prisma } from './setup'
import { WalletService } from '../services/wallet.service'
import { TransactionType, PaymentStatus } from '@world-bingo/shared-types'

vi.mock('../services/notification.service', () => ({
    NotificationService: {
        pushWalletUpdate: vi.fn(),
        create: vi.fn().mockResolvedValue(undefined),
    },
}))
vi.mock('../services/referral.service', () => ({
    ReferralService: { processFirstDepositBonus: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('../lib/metrics', () => ({
    wbDepositsTotal: { labels: () => ({ inc: () => {} }) },
}))

async function seedPendingDeposit(amount: number) {
    const user = await prisma.user.create({
        data: {
            username: `adjust_${Math.random().toString(36).slice(2, 10)}`,
            phone: `09${Math.floor(10000000 + Math.random() * 89999999)}`,
            passwordHash: 'hashed:x',
            wallet: { create: { realBalance: 0, bonusBalance: 0 } },
        },
    })
    const tx = await prisma.transaction.create({
        data: {
            userId: user.id,
            type: TransactionType.DEPOSIT,
            amount,
            status: PaymentStatus.PENDING_REVIEW,
            note: 'telebirr',
        },
    })
    return { user, tx }
}

const realBalance = async (userId: string) =>
    Number((await prisma.wallet.findUniqueOrThrow({ where: { userId } })).realBalance)

describe('WalletService.approveDeposit — admin amount adjustment', () => {
    it('plain approve credits the stated amount and leaves originalAmount null', async () => {
        const { user, tx } = await seedPendingDeposit(100)
        await WalletService.approveDeposit(tx.id)

        const updated = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })
        expect(updated.status).toBe(PaymentStatus.APPROVED)
        expect(Number(updated.amount)).toBe(100)
        expect(updated.originalAmount).toBeNull()
        expect(await realBalance(user.id)).toBe(100)
    })

    it('lower adjustment credits the corrected amount and preserves the stated one', async () => {
        const { user, tx } = await seedPendingDeposit(100)
        await WalletService.approveDeposit(tx.id, 90)

        const updated = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })
        expect(Number(updated.amount)).toBe(90)
        expect(Number(updated.originalAmount)).toBe(100)
        expect(await realBalance(user.id)).toBe(90)
    })

    it('higher adjustment (over-credit) credits more and preserves the stated one', async () => {
        const { user, tx } = await seedPendingDeposit(100)
        await WalletService.approveDeposit(tx.id, 120)

        const updated = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })
        expect(Number(updated.amount)).toBe(120)
        expect(Number(updated.originalAmount)).toBe(100)
        expect(await realBalance(user.id)).toBe(120)
    })

    it('an adjustment equal to the stated amount is not flagged as adjusted', async () => {
        const { tx } = await seedPendingDeposit(100)
        await WalletService.approveDeposit(tx.id, 100)

        const updated = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })
        expect(Number(updated.amount)).toBe(100)
        expect(updated.originalAmount).toBeNull()
    })

    it('rejects a non-positive amount, leaving the deposit pending and the wallet untouched', async () => {
        const { user, tx } = await seedPendingDeposit(100)
        await expect(WalletService.approveDeposit(tx.id, 0)).rejects.toThrow()

        const updated = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })
        expect(updated.status).toBe(PaymentStatus.PENDING_REVIEW)
        expect(await realBalance(user.id)).toBe(0)
    })
})
