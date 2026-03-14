import prisma from '../lib/prisma'
import { TransactionType, PaymentStatus } from '@world-bingo/shared-types'
import { Decimal } from '@prisma/client/runtime/library'
import { NotificationService } from './notification.service'

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
        // Get all entries grouped by userId
        const entries = await prisma.gameEntry.findMany({
            where: { gameId },
            include: {
                game: { select: { ticketPrice: true } },
            },
        })

        if (entries.length === 0) return []

        const ticketPrice = entries[0].game.ticketPrice

        // Group by userId to compute per-user refund amount
        const userEntryCount = new Map<string, number>()
        for (const entry of entries) {
            userEntryCount.set(entry.userId, (userEntryCount.get(entry.userId) ?? 0) + 1)
        }

        const results: RefundResult[] = []

        // Process each user's refund inside a transaction
        for (const [userId, cartelaCount] of userEntryCount) {
            const refundAmount = new Decimal(ticketPrice).times(cartelaCount)

            const result = await prisma.$transaction(async (tx) => {
                // Idempotency check: if a REFUND transaction with this referenceId already exists for this user, skip
                const existing = await tx.transaction.findFirst({
                    where: {
                        userId,
                        type: TransactionType.REFUND,
                        referenceId: gameId,
                    },
                })

                if (existing) {
                    return { userId, amount: Number(refundAmount), alreadyRefunded: true }
                }

                // Lock the wallet row before crediting
                const wallets = await tx.$queryRaw<Array<{ id: string; balance: Decimal }>>`
                    SELECT id, balance FROM wallets WHERE "userId" = ${userId} FOR UPDATE
                `
                const wallet = wallets[0]
                if (!wallet) {
                    throw new Error(`Wallet not found for user ${userId}`)
                }

                const balanceBefore = new Decimal(wallet.balance)
                const balanceAfter = balanceBefore.plus(refundAmount)

                // Credit wallet
                await tx.wallet.update({
                    where: { userId },
                    data: { balance: { increment: refundAmount } },
                })

                // Record REFUND transaction with balance snapshot
                await tx.transaction.create({
                    data: {
                        userId,
                        type: TransactionType.REFUND,
                        amount: refundAmount,
                        status: PaymentStatus.APPROVED,
                        referenceId: gameId,
                        note: `Refund for cancelled game`,
                        balanceBefore,
                        balanceAfter,
                    },
                })

                return { userId, amount: Number(refundAmount), alreadyRefunded: false, balanceAfter }
            })

            if (!result.alreadyRefunded && (result as any).balanceAfter) {
                NotificationService.pushWalletUpdate(userId, Number((result as any).balanceAfter))
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
