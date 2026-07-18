import prisma from '../lib/prisma'
import { TransactionType, PaymentStatus } from '@world-bingo/shared-types'
import { Decimal } from '@prisma/client/runtime/library'
import { NotificationService } from './notification.service'
import { wbRefundsTotal } from '../lib/metrics'

/**
 * T19 — Refund Service
 *
 * Handles refunding all players of a game.
 * - Idempotent: if a REFUND transaction already exists for a user + gameId, it is skipped.
 * - Uses SELECT FOR UPDATE on wallet rows to prevent concurrent issues.
 */
export class RefundService {
    /**
     * Refund all players who joined a given game.
     * Creates one REFUND transaction per user (not per entry) for the total cost.
     *
     * @returns Array of { userId, amount, alreadyRefunded } for each player
     */
    static async refundGame(gameId: string): Promise<RefundResult[]> {
        // Distinct users who joined this game
        const entries = await prisma.gameEntry.findMany({
            where: { gameId },
            select: { userId: true },
        })
        if (entries.length === 0) return []
        const userIds = [...new Set(entries.map((e) => e.userId))]

        const results: RefundResult[] = []

        // Process each user's refund inside a transaction
        for (const userId of userIds) {
            const result = await prisma.$transaction(async (tx) => {
                // Lock the wallet row FIRST so the idempotency check and the credit are
                // serialized per-user. Two concurrent refundGame calls now block here;
                // the loser sees the committed REFUND below and skips (no double refund).
                const wallets = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal }>>`
                    SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
                `
                const wallet = wallets[0]
                if (!wallet) {
                    throw new Error(`Wallet not found for user ${userId}`)
                }

                // Idempotency check AFTER the lock.
                const existing = await tx.transaction.findFirst({
                    where: { userId, type: TransactionType.REFUND, referenceId: gameId },
                })
                if (existing) {
                    return { userId, amount: Number(existing.amount), alreadyRefunded: true }
                }

                // Refund exactly what was collected, back to the buckets it came from.
                // The GAME_ENTRY transaction snapshots both balances, so real/bonus split
                // and the true collected amount are derived from it (not from the current
                // ticketPrice, which may have changed since the join).
                const entryTxns = await tx.transaction.findMany({
                    where: { userId, type: TransactionType.GAME_ENTRY, referenceId: gameId },
                })
                let realRefund = new Decimal(0)
                let bonusRefund = new Decimal(0)
                for (const t of entryTxns) {
                    realRefund = realRefund.plus(
                        new Decimal(t.balanceBefore ?? 0).minus(new Decimal(t.balanceAfter ?? 0)),
                    )
                    bonusRefund = bonusRefund.plus(
                        new Decimal(t.bonusBalanceBefore ?? 0).minus(new Decimal(t.bonusBalanceAfter ?? 0)),
                    )
                }

                // Legacy fallback: no snapshot rows (pre-fix data) → refund ticketPrice ×
                // entry count to realBalance, preserving prior behaviour.
                let refundAmount = realRefund.plus(bonusRefund)
                if (refundAmount.lessThanOrEqualTo(0)) {
                    const cnt = await tx.gameEntry.count({ where: { gameId, userId } })
                    const game = await tx.game.findUnique({ where: { id: gameId }, select: { ticketPrice: true } })
                    realRefund = new Decimal(game?.ticketPrice ?? 0).times(cnt)
                    bonusRefund = new Decimal(0)
                    refundAmount = realRefund
                }

                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const realAfter = realBefore.plus(realRefund)
                const bonusAfter = bonusBefore.plus(bonusRefund)

                await tx.wallet.update({
                    where: { userId },
                    data: { realBalance: realAfter, bonusBalance: bonusAfter },
                })

                await tx.transaction.create({
                    data: {
                        userId,
                        type: TransactionType.REFUND,
                        amount: refundAmount,
                        status: PaymentStatus.APPROVED,
                        referenceId: gameId,
                        note: `Refund for cancelled game`,
                        balanceBefore: realBefore,
                        balanceAfter: realAfter,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: bonusAfter,
                    },
                })

                // NOTE: no house-wallet debit here. Stakes are never booked as house
                // revenue at join time (house edge is credited only at claimBingo), so a
                // cancelled game nets the house zero. The previous debit removed money the
                // house never received, driving the house balance phantom-negative.

                return {
                    userId,
                    amount: Number(refundAmount),
                    alreadyRefunded: false,
                    realAfter: Number(realAfter),
                    bonusAfter: Number(bonusAfter),
                }
            })

            if (!result.alreadyRefunded) {
                NotificationService.pushWalletUpdate(userId, (result as any).realAfter, (result as any).bonusAfter)
                // Metrics: actual refund issued (post-commit). The cancel reason is not
                // threaded into refundGame, so we record 'cancel' per the contract.
                wbRefundsTotal.labels('cancel').inc()
            }

            results.push(result)
        }

        return results
    }
}

export interface RefundResult {
    userId: string
    amount: number
    alreadyRefunded: boolean
}
