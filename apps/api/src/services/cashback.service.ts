import prisma from '../lib/prisma'
import { TransactionType, PaymentStatus, NotificationType, CashbackRefundType, CashbackFrequency } from '@world-bingo/shared-types'
import { Decimal } from '@prisma/client/runtime/library'
import { NotificationService } from './notification.service'

/**
 * Compute the start and end of the current frequency window (UTC).
 */
export function getCurrentPeriod(frequency: CashbackFrequency, now = new Date()): { periodStart: Date; periodEnd: Date } {
    const y = now.getUTCFullYear()
    const m = now.getUTCMonth()
    const d = now.getUTCDate()
    const day = now.getUTCDay() // 0 = Sunday

    if (frequency === CashbackFrequency.DAILY) {
        const periodStart = new Date(Date.UTC(y, m, d, 0, 0, 0, 0))
        const periodEnd = new Date(Date.UTC(y, m, d, 23, 59, 59, 999))
        return { periodStart, periodEnd }
    }

    if (frequency === CashbackFrequency.WEEKLY) {
        // ISO week: Monday = start
        const daysFromMonday = (day === 0 ? 6 : day - 1)
        const mondayDate = d - daysFromMonday
        const periodStart = new Date(Date.UTC(y, m, mondayDate, 0, 0, 0, 0))
        // Add 6 days to periodStart for Sunday end — handles month boundary correctly
        const periodEnd = new Date(periodStart.getTime() + 6 * 24 * 60 * 60 * 1000)
        periodEnd.setUTCHours(23, 59, 59, 999)
        return { periodStart, periodEnd }
    }

    // MONTHLY
    const periodStart = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0))
    const periodEnd = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999)) // last day of month
    return { periodStart, periodEnd }
}

export class CashbackService {
    /**
     * Create a new cashback promotion.
     */
    static async createPromotion(data: {
        name: string
        lossThreshold: number
        refundType: CashbackRefundType
        refundValue: number
        frequency: CashbackFrequency
        startsAt: string
        endsAt: string
    }) {
        return prisma.cashbackPromotion.create({
            data: {
                name: data.name,
                lossThreshold: data.lossThreshold,
                refundType: data.refundType,
                refundValue: data.refundValue,
                frequency: data.frequency,
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
     * Check all active promotions and disburse cashback to qualifying players.
     * Called hourly by the cashback-checker worker.
     */
    static async runChecks(): Promise<{ promotionsChecked: number; totalDisbursed: number; totalAmount: Decimal }> {
        const now = new Date()

        const activePromotions = await prisma.cashbackPromotion.findMany({
            where: {
                isActive: true,
                startsAt: { lte: now },
                endsAt: { gte: now },
            },
        })

        let totalDisbursed = 0
        let totalAmount = new Decimal(0)

        for (const promotion of activePromotions) {
            const { periodStart, periodEnd } = getCurrentPeriod(promotion.frequency as CashbackFrequency, now)
            const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)
            totalDisbursed += result.disbursed
            totalAmount = totalAmount.plus(result.total)
        }

        return { promotionsChecked: activePromotions.length, totalDisbursed, totalAmount }
    }

    /**
     * Check and disburse cashback for one promotion within one period window.
     * Idempotent: safe to call multiple times for the same (promotionId, periodStart).
     */
    static async checkAndDisburse(
        promotionId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<{ disbursed: number; skipped: number; total: Decimal }> {
        const promotion = await prisma.cashbackPromotion.findUnique({ where: { id: promotionId } })
        if (!promotion || !promotion.isActive) return { disbursed: 0, skipped: 0, total: new Decimal(0) }

        // Sum GAME_ENTRY amounts per user in the window (real balance losses)
        const entries = await prisma.transaction.groupBy({
            by: ['userId'],
            where: {
                type: TransactionType.GAME_ENTRY,
                status: PaymentStatus.APPROVED,
                createdAt: { gte: periodStart, lte: periodEnd },
            },
            _sum: { amount: true },
        })

        // Sum PRIZE_WIN amounts per user in the window
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
        const lossThreshold = new Decimal(promotion.lossThreshold)
        const refundValue = new Decimal(promotion.refundValue)

        // Filter out bots
        const userIds = entries.map((e) => e.userId)
        const botUserIds = new Set<string>()
        if (userIds.length > 0) {
            const botUsers = await prisma.user.findMany({
                where: { id: { in: userIds }, username: { startsWith: 'bot_t' } },
                select: { id: true },
            })
            for (const b of botUsers) botUserIds.add(b.id)
        }

        let disbursed = 0
        let skipped = 0
        let total = new Decimal(0)

        for (const entry of entries) {
            if (botUserIds.has(entry.userId)) continue

            const totalWagered = new Decimal(entry._sum.amount ?? 0)
            const totalWon = winMap.get(entry.userId) ?? new Decimal(0)
            const netLoss = totalWagered.minus(totalWon)

            // Qualifies when netLoss >= lossThreshold (inclusive boundary)
            if (netLoss.lt(lossThreshold)) continue

            // Calculate cashback amount
            const cashbackAmount =
                promotion.refundType === CashbackRefundType.PERCENTAGE
                    ? netLoss.times(refundValue.div(100))
                    : refundValue

            if (cashbackAmount.lte(0)) continue

            const result = await prisma.$transaction(async (tx) => {
                // Idempotency: unique constraint on (promotionId, userId, periodStart)
                const existing = await tx.cashbackDisbursement.findUnique({
                    where: {
                        promotionId_userId_periodStart: { promotionId, userId: entry.userId, periodStart },
                    },
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
                    `You received ${Number(result as Decimal).toFixed(2)} ETB cashback from "${promotion.name}".`,
                    { promotionId, amount: (result as Decimal).toFixed(2) },
                ).catch(() => {})
            }
        }

        return { disbursed, skipped, total }
    }
}
