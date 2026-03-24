import prisma from '../lib/prisma'
import { TransactionType, PaymentStatus, NotificationType } from '@world-bingo/shared-types'
import { Decimal } from '@prisma/client/runtime/library'
import { NotificationService } from './notification.service'

export class CashbackService {
    /**
     * Create a new cashback promotion.
     */
    static async createPromotion(data: {
        name: string
        percentage: number
        startsAt: string
        endsAt: string
    }) {
        return prisma.cashbackPromotion.create({
            data: {
                name: data.name,
                percentage: data.percentage,
                startsAt: new Date(data.startsAt),
                endsAt: new Date(data.endsAt),
            },
        })
    }

    /**
     * List all promotions, newest first.
     */
    static async listPromotions() {
        return prisma.cashbackPromotion.findMany({
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { disbursements: true } } },
        })
    }

    /**
     * Toggle a promotion's isActive flag.
     */
    static async togglePromotion(id: string, isActive: boolean) {
        return prisma.cashbackPromotion.update({
            where: { id },
            data: { isActive },
        })
    }

    /**
     * Calculate and disburse cashback for a promotion.
     *
     * For each player who had a net loss during [startsAt, endsAt]:
     *   netLoss = sum(GAME_ENTRY amounts) - sum(PRIZE_WIN amounts)
     *   cashback = netLoss * (percentage / 100)
     *
     * Credited to bonusBalance. Idempotent per (promotionId, userId).
     */
    static async disburse(promotionId: string): Promise<{ disbursed: number; skipped: number; total: Decimal }> {
        const promotion = await prisma.cashbackPromotion.findUnique({ where: { id: promotionId } })
        if (!promotion) throw new Error('Promotion not found')
        if (!promotion.isActive) throw new Error('Promotion is not active')

        const periodStart = promotion.startsAt
        const periodEnd = promotion.endsAt

        // Get all GAME_ENTRY and PRIZE_WIN transactions in the period
        const entries = await prisma.transaction.groupBy({
            by: ['userId'],
            where: {
                type: TransactionType.GAME_ENTRY,
                status: PaymentStatus.APPROVED,
                createdAt: { gte: periodStart, lte: periodEnd },
            },
            _sum: { amount: true },
        })

        const wins = await prisma.transaction.groupBy({
            by: ['userId'],
            where: {
                type: TransactionType.PRIZE_WIN,
                status: PaymentStatus.APPROVED,
                createdAt: { gte: periodStart, lte: periodEnd },
            },
            _sum: { amount: true },
        })

        const winMap = new Map(wins.map((w) => [w.userId, new Decimal(w._sum.amount ?? 0)]))
        const pct = new Decimal(promotion.percentage).div(100)

        let disbursed = 0
        let skipped = 0
        let total = new Decimal(0)

        // Filter out bots
        const botUserIds = new Set<string>()
        const userIds = entries.map((e) => e.userId)
        if (userIds.length > 0) {
            const botUsers = await prisma.user.findMany({
                where: { id: { in: userIds }, username: { startsWith: 'bot_t' } },
                select: { id: true },
            })
            for (const b of botUsers) botUserIds.add(b.id)
        }

        for (const entry of entries) {
            if (botUserIds.has(entry.userId)) continue

            const totalWagered = new Decimal(entry._sum.amount ?? 0)
            const totalWon = winMap.get(entry.userId) ?? new Decimal(0)
            const netLoss = totalWagered.minus(totalWon)

            if (netLoss.lte(0)) continue

            const cashbackAmount = netLoss.times(pct)
            if (cashbackAmount.lte(0)) continue

            const result = await prisma.$transaction(async (tx) => {
                // Idempotency: unique constraint on (promotionId, userId)
                const existing = await tx.cashbackDisbursement.findUnique({
                    where: { promotionId_userId: { promotionId, userId: entry.userId } },
                })
                if (existing) return 'skipped'

                // Lock wallet
                const wallets = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal }>>`
                    SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${entry.userId} FOR UPDATE
                `
                const wallet = wallets[0]
                if (!wallet) return 'skipped'

                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const bonusAfter = bonusBefore.plus(cashbackAmount)

                // Credit bonusBalance
                await tx.wallet.update({
                    where: { userId: entry.userId },
                    data: { bonusBalance: { increment: cashbackAmount } },
                })

                // Record transaction
                await tx.transaction.create({
                    data: {
                        userId: entry.userId,
                        type: TransactionType.CASHBACK_BONUS,
                        amount: cashbackAmount,
                        status: PaymentStatus.APPROVED,
                        referenceId: promotionId,
                        note: `Cashback: ${promotion.name}`,
                        balanceBefore: realBefore,
                        balanceAfter: realBefore,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: bonusAfter,
                    },
                })

                // Record disbursement
                await tx.cashbackDisbursement.create({
                    data: {
                        promotionId,
                        userId: entry.userId,
                        amount: cashbackAmount,
                        periodStart,
                        periodEnd,
                    },
                })

                return cashbackAmount
            })

            if (result === 'skipped') {
                skipped++
            } else {
                disbursed++
                total = total.plus(result as Decimal)

                // Push notification (fire-and-forget)
                NotificationService.create(
                    entry.userId,
                    NotificationType.CASHBACK_AWARDED,
                    'Cashback Bonus!',
                    `You received ${Number(result).toFixed(2)} ETB cashback from "${promotion.name}".`,
                    { promotionId, amount: Number(result) },
                ).catch(() => {})
            }
        }

        return { disbursed, skipped, total }
    }
}
