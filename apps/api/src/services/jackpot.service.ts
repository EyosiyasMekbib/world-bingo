/**
 * T59 — Progressive Jackpot Service
 *
 * Rules:
 *  - 2% of each completed game's prize pool is contributed to the jackpot.
 *  - A player wins the jackpot if they claim BINGO with a FULL_CARD pattern
 *    AND the game had ≤ 20 balls called at the time of the winning claim.
 *  - On win: the full jackpot amount is credited to the winner's wallet,
 *    jackpot resets to 0, and all connected clients are notified via socket.
 *
 * There is a single global jackpot row (seeded on first access — "singleton").
 */
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '../lib/prisma'
import { getIo } from '../lib/socket'
import { NotificationService } from './notification.service'
import { NotificationType } from '@world-bingo/shared-types'

/** Contribution rate: 2% of prize pool */
const CONTRIBUTION_RATE = 0.02

/** Jackpot win condition: full card claimed in ≤ 20 balls */
const MAX_BALLS_FOR_JACKPOT = 20

export class JackpotService {
    // ── Singleton helpers ────────────────────────────────────────────────────

    /** Get (or create) the single global jackpot row. */
    private static async getOrCreate() {
        const existing = await prisma.jackpot.findFirst()
        if (existing) return existing
        return prisma.jackpot.create({ data: { amount: 0 } })
    }

    /** Return the current jackpot amount (ETB). */
    static async getCurrentAmount(): Promise<number> {
        const jackpot = await JackpotService.getOrCreate()
        return Number(jackpot.amount)
    }

    // ── Contribution ─────────────────────────────────────────────────────────

    /**
     * Called when a game is COMPLETED.
     * Adds 2% of the total prize pool to the jackpot and broadcasts the
     * new amount to all connected clients.
     */
    static async contribute(prizePoolEtb: number): Promise<void> {
        const contribution = new Decimal(prizePoolEtb).mul(CONTRIBUTION_RATE)
        if (contribution.lessThanOrEqualTo(0)) return

        await prisma.$transaction(async (tx) => {
            const jackpot = await tx.jackpot.findFirst()
            if (!jackpot) {
                await tx.jackpot.create({ data: { amount: contribution } })
            } else {
                await tx.jackpot.update({
                    where: { id: jackpot.id },
                    data: { amount: { increment: contribution } },
                })
            }
        })

        // Broadcast updated amount to lobby
        const amount = await JackpotService.getCurrentAmount()
        JackpotService.broadcastAmount(amount)
    }

    // ── Win check ────────────────────────────────────────────────────────────

    /**
     * Checks whether the BINGO claim qualifies for the jackpot.
     * Returns true if the claim is for FULL_CARD pattern and ≤ 20 balls.
     */
    static isJackpotEligible(patternType: string, ballsCalled: number): boolean {
        return patternType === 'FULL_CARD' && ballsCalled <= MAX_BALLS_FOR_JACKPOT
    }

    /**
     * Awards the jackpot to `userId` for the given `gameId`.
     * Atomic: jackpot reset + wallet credit happen in one transaction.
     * Returns the amount won (0 if jackpot was already 0).
     */
    static async awardJackpot(userId: string, gameId: string, ballsCalled: number): Promise<number> {
        return await prisma.$transaction(async (tx) => {
            const jackpot = await tx.jackpot.findFirst()
            if (!jackpot || Number(jackpot.amount) <= 0) return 0

            const amount = jackpot.amount

            // Record the win
            await tx.jackpotWin.create({
                data: {
                    jackpotId: jackpot.id,
                    userId,
                    gameId,
                    amount,
                    ballCount: ballsCalled,
                },
            })

            // Reset jackpot
            await tx.jackpot.update({
                where: { id: jackpot.id },
                data: { amount: 0, lastWonAt: new Date(), lastWonBy: userId },
            })

            // Credit winner's wallet
            await tx.wallet.update({
                where: { userId },
                data: { balance: { increment: amount } },
            })

            // Record transaction
            await tx.transaction.create({
                data: {
                    userId,
                    type: 'PRIZE_WIN' as any,
                    amount,
                    status: 'APPROVED' as any,
                    note: `Progressive jackpot won! (${ballsCalled} balls called)`,
                    referenceId: gameId,
                },
            })

            return Number(amount)
        }).then(async (wonAmount) => {
            if (wonAmount > 0) {
                // Notify winner
                await NotificationService.create(
                    userId,
                    NotificationType.GAME_WON,
                    '🎰 JACKPOT! You won the progressive jackpot!',
                    `You won the progressive jackpot of ${wonAmount.toFixed(2)} ETB with a full card in just ${ballsCalled} balls! 🎉`,
                    { amount: wonAmount, gameId, ballsCalled },
                ).catch(() => {})

                // Broadcast jackpot reset to all clients
                JackpotService.broadcastAmount(0)
                JackpotService.broadcastWin(userId, wonAmount)
            }
            return wonAmount
        })
    }

    // ── Socket broadcasts ────────────────────────────────────────────────────

    private static broadcastAmount(amount: number) {
        try {
            getIo().emit('jackpot:update', { amount })
        } catch {
            // socket not available in tests
        }
    }

    private static broadcastWin(winnerId: string, amount: number) {
        try {
            getIo().emit('jackpot:won', { winnerId, amount })
        } catch {
            // socket not available in tests
        }
    }
}
